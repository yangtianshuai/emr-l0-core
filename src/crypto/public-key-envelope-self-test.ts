import { createHash } from 'node:crypto';
import { TestSuite, assert, assertEqual } from '../testing/harness.ts';
import { sm3Hex, utf8 } from './sm3.ts';
import { demoKeyPair } from './provider.ts';
import { publicKeyFromSpki, publicKeyFingerprint, publicKeyToSpki } from './sm2.ts';
import { SM2_CIPHERTEXT_ORDER, inspectSm2Ciphertext, sm2Decrypt, sm2Encrypt } from './sm2-encrypt.ts';
import { decryptEnvelope, decryptEnvelopeWith, encryptEnvelope, encryptEnvelopeFor, type DecryptResult, type Envelope } from './envelope.ts';
import { WriteSession } from '../core/session.ts';
import { buildSyntheticDoc } from '../testing/synthetic.ts';
import { issueReadingGrant, documentFingerprint, demoReadingIssuer, type ReadingContext, type ReadingGrant } from '../core/controlled-reading.ts';
import { openSealedForReading, sealDocumentJson } from '../core/encrypted-reading.ts';

const suite = new TestSuite('T18c 受控加密阅读（SM2 信封 + 授权即密钥交付）自测', [
  '说明：SM2 加密与签名共用曲线与点运算，但是两件事（签名证明"我发的"，加密保证"只有他能看"）。',
  '本套件的重点：把"授权不可转让"从自报的环境标识，变成密码学事实。',
]);

const test = (name: string, fn: () => void | Promise<void>): Promise<void> => suite.test(name, fn);

interface CodedResult {
  ok: boolean;
  code?: string;
  reason?: string;
}
const codeOf = (result: CodedResult): string => (result.ok ? 'OK' : (result.code ?? 'UNKNOWN'));
const reasonOf = (result: CodedResult): string => (result.ok ? '' : (result.reason ?? ''));

const recipientA = demoKeyPair('l0-recipient-a');
const recipientB = demoKeyPair('l0-recipient-b');
const keyA = { publicKey: recipientA.publicKey, fingerprint: publicKeyFingerprint(recipientA.publicKey) };
const keyB = { publicKey: recipientB.publicKey, fingerprint: publicKeyFingerprint(recipientB.publicKey) };
const privateA = { privateKey: recipientA.privateKey, fingerprint: keyA.fingerprint };
const privateB = { privateKey: recipientB.privateKey, fingerprint: keyB.fingerprint };
const ISSUER = demoReadingIssuer();

function flipByte(bytes: Uint8Array, index: number, mask = 0x01): Uint8Array {
  const copy = new Uint8Array(bytes);
  copy.set([((copy[index] ?? 0) ^ mask) & 0xff], index);
  return copy;
}

async function main(): Promise<void> {

  await test('A1 往返：1 / 16 / 100 / 1000 字节都能原样还原；顺序声明为 C1C3C2', async () => {
    assertEqual(SM2_CIPHERTEXT_ORDER, 'C1C3C2', '密文顺序必须显式声明（两种顺序混用极难排查）');
    for (const length of [1, 16, 100, 1000]) {
      const plaintext = new Uint8Array(length).map((_, i) => (i * 37 + 11) % 256);
      const ciphertext = sm2Encrypt(plaintext, keyA.publicKey);
      const result = sm2Decrypt(ciphertext, recipientA.privateKey);
      assertEqual(result.ok, true, `${length} 字节应解密成功：${result.ok ? '' : result.reason}`);
      assertEqual(sm3Hex(result.ok ? result.plaintext : new Uint8Array(0)), sm3Hex(plaintext), `${length} 字节应一致`);
    }
  });

  await test('A1b 空明文必须被**明确拒绝**（SM2 的 KDF 要求长度 > 0），不是抛内部错误', async () => {
    let sm2Message = '';
    try {
      sm2Encrypt(new Uint8Array(0), keyA.publicKey);
    } catch (err) {
      sm2Message = (err as Error).message;
    }
    assert(sm2Message.includes('KDF'), `SM2 层应报 KDF 相关原因，实际：${sm2Message}`);

    let envelopeMessage = '';
    try {
      encryptEnvelopeFor(new Uint8Array(0), keyA);
    } catch (err) {
      envelopeMessage = (err as Error).message;
    }
    assert(envelopeMessage.includes('不支持空明文'), `信封层应给出面向调用方的明确错误，实际：${envelopeMessage}`);
    assert(envelopeMessage.includes('口令模式'), '错误信息应指出替代做法（空内容走口令模式）');
  });

  await test('A2 密文结构：长度为 65 + 32 + len，C1 首字节为 04（未压缩点）', async () => {
    const plaintext = utf8('结构检查');
    const ciphertext = sm2Encrypt(plaintext, keyA.publicKey);
    assertEqual(ciphertext.length, 65 + 32 + plaintext.length, '长度应为 C1(65) + C3(32) + C2(len)');
    assertEqual(ciphertext[0], 0x04, 'C1 应为未压缩点（首字节 04）');
    assertEqual(inspectSm2Ciphertext(ciphertext).ok, true, '结构预检应通过');
  });

  await test('A3 结构预检：过短或 C1 非法时给出明确错误码（不是"解密失败"一句糊过去）', async () => {
    assertEqual(inspectSm2Ciphertext(new Uint8Array(50)).code, 'E_SM2_MALFORMED', '过短应报结构错误');
    const badPoint = new Uint8Array(65 + 32);
    badPoint.set([0x02], 0);
    assertEqual(inspectSm2Ciphertext(badPoint).code, 'E_SM2_MALFORMED', 'C1 非 04 开头应报结构错误');
    const offCurve = new Uint8Array(65 + 32);
    offCurve.set([0x04, ...new Uint8Array(64).fill(9)], 0);
    assertEqual(inspectSm2Ciphertext(offCurve).code, 'E_SM2_POINT_NOT_ON_CURVE', 'C1 不在曲线上应单独报码');
    assertEqual(codeOf(sm2Decrypt(offCurve, recipientA.privateKey)), 'E_SM2_POINT_NOT_ON_CURVE', '解密入口也应拦住');
  });

  await test('A4 篡改 C2 1 字节 → C3 校验失败（拒绝，且不返回明文）', async () => {
    const ciphertext = sm2Encrypt(utf8('这段内容会被篡改'), keyA.publicKey);
    const tampered = flipByte(ciphertext, 65 + 32); // 落在 C2 的第一个字节
    const result = sm2Decrypt(tampered, recipientA.privateKey);
    assertEqual(result.ok, false, '篡改必须拒绝');
    if (!result.ok) assertEqual(result.code, 'E_SM2_C3_MISMATCH', '应报 C3 校验失败');
  });

  await test('A5 用错私钥 → 同一码 C3 不符；提示需如实说明两者不可区分', async () => {
    const ciphertext = sm2Encrypt(utf8('只给 A 的内容'), keyA.publicKey);
    const result = sm2Decrypt(ciphertext, recipientB.privateKey);
    assertEqual(result.ok, false, '别人的私钥必须解不开');
    if (!result.ok) assert(reasonOf(result).includes('不可区分'), '应说明"篡改"与"用错私钥"在密码学上不可区分');
  });

  await test('A6 注入固定 k 时结果可复现（测试/复现用；k 泄露等于私钥泄露，生产禁传）', async () => {
    const plaintext = utf8('可复现');
    const first = sm2Encrypt(plaintext, keyA.publicKey, { k: 0x1234567890abcdefn });
    const second = sm2Encrypt(plaintext, keyA.publicKey, { k: 0x1234567890abcdefn });
    assertEqual(sm3Hex(first), sm3Hex(second), '固定 k 应得到同一密文');
    const random = sm2Encrypt(plaintext, keyA.publicKey);
    assert(sm3Hex(random) !== sm3Hex(first), '不注入 k 时应随机（k 复用会泄露明文异或值）');
  });

  await test('A7 公钥不在曲线上时加密必须报错（而不是加密出一份没人能解的东西）', async () => {
    let message = '';
    try {
      sm2Encrypt(utf8('x'), { x: 1n, y: 1n });
    } catch (err) {
      message = (err as Error).message;
    }
    assert(message.includes('不在曲线上'), `应报"公钥不在曲线上"，实际：${message}`);
  });

  await test('A8 公钥往返：SPKI 编码 → 解析 → 指纹稳定（"这把钥匙是不是同一把"）', async () => {
    const spki = publicKeyToSpki(keyA.publicKey);
    assertEqual(publicKeyFingerprint(publicKeyFromSpki(spki)), keyA.fingerprint, 'SPKI 往返后指纹应不变');
  });

  await test('B1 公钥信封往返：只有接收方私钥能解开', async () => {
    const plaintext = utf8('受控归档件内容');
    const envelope = encryptEnvelopeFor(plaintext, keyA);
    assertEqual(envelope.header.kdf.algorithm, 'SM2-ENVELOPE', '头部应标明公钥封装模式');
    const result = decryptEnvelopeWith(envelope, privateA);
    assertEqual(result.ok, true, `接收方应能解开：${reasonOf(result)}`);
    assertEqual(sm3Hex(result.ok ? result.plaintext : new Uint8Array(0)), sm3Hex(plaintext), '明文应一致');
  });

  await test('B2 换接收方私钥 → E_ENVELOPE_WRONG_RECIPIENT（**动用私钥之前**就判定）', async () => {
    const envelope = encryptEnvelopeFor(utf8('给 A 的'), keyA);
    const result = decryptEnvelopeWith(envelope, privateB);
    assertEqual(codeOf(result), 'E_ENVELOPE_WRONG_RECIPIENT', '不是给我的信封应报"接收方不符"');
    assert(reasonOf(result).includes('不是给当前密钥'), '原因要说清"不是给你的"');
  });

  await test('B3 用错接口解 → 明确提示该用哪个（口令接口解公钥信封、反之亦然）', async () => {
    const sealed = encryptEnvelopeFor(utf8('给 A 的'), keyA);
    assertEqual(codeOf(decryptEnvelope(sealed, '口令')), 'E_ENVELOPE_UNSUPPORTED', '口令接口不应处理公钥信封');
    assert(reasonOf(decryptEnvelope(sealed, '口令')).includes('decryptEnvelopeWith'), '应指明正确的接口');
    const keyed = encryptEnvelope(utf8('口令保护的'), { passphrase: '口令', iterations: 1000 });
    const result = decryptEnvelopeWith(keyed, privateA);
    assertEqual(codeOf(result), 'E_ENVELOPE_UNSUPPORTED', '公钥接口不应处理口令信封');
    assert(reasonOf(result).includes('decryptEnvelope'), '应指明正确的接口');
  });

  await test('B4 篡改密文 → MAC 失败（密钥已正确解出，故原因与"密钥错"不同）', async () => {
    const envelope = encryptEnvelopeFor(utf8('内容'), keyA);
    const tampered: Envelope = JSON.parse(JSON.stringify(envelope)) as Envelope;
    const bytes = new Uint8Array(Buffer.from(tampered.ciphertext, 'base64'));
    tampered.ciphertext = Buffer.from(flipByte(bytes, 0)).toString('base64');
    const result = decryptEnvelopeWith(tampered, privateA);
    assertEqual(codeOf(result), 'E_ENVELOPE_MAC_MISMATCH', '应报完整性校验失败');
    assert(reasonOf(result).includes('不是密钥问题'), '应说明"密钥已解出"，避免往密钥方向排查');
  });

  await test('B5 篡改被封装的密钥 → E_ENVELOPE_KEY_UNWRAP_FAILED（与 MAC 不符要能区分）', async () => {
    const envelope = encryptEnvelopeFor(utf8('内容'), keyA);
    const tampered: Envelope = JSON.parse(JSON.stringify(envelope)) as Envelope;
    const kdf = tampered.header.kdf;
    if (kdf.algorithm !== 'SM2-ENVELOPE') throw new Error('前置：应为公钥信封');
    const wrapped = new Uint8Array(Buffer.from(kdf.wrappedKey, 'base64'));
    kdf.wrappedKey = Buffer.from(flipByte(wrapped, 65 + 31)).toString('base64');
    assertEqual(codeOf(decryptEnvelopeWith(tampered, privateA)), 'E_ENVELOPE_KEY_UNWRAP_FAILED', '封装被改应报解封失败');
  });

  await test('B6 注入固定 dek/iv 时**密文**可复现；被封装的密钥每次不同（SM2 加密本身随机）', async () => {
    const plaintext = utf8('可复现性');
    const options = { dek: new Uint8Array(16).fill(3), iv: new Uint8Array(16).fill(4) };
    const first = encryptEnvelopeFor(plaintext, keyA, options);
    const second = encryptEnvelopeFor(plaintext, keyA, options);
    assertEqual(first.ciphertext, second.ciphertext, '同 dek/iv 时密文应完全一致');
    assert(first.header.plaintextDigest === second.header.plaintextDigest, '明文摘要应一致');
    const kdfA = first.header.kdf;
    const kdfB = second.header.kdf;
    if (kdfA.algorithm !== 'SM2-ENVELOPE' || kdfB.algorithm !== 'SM2-ENVELOPE') throw new Error('前置：应为公钥信封');
    assert(kdfA.wrappedKey !== kdfB.wrappedKey, 'SM2 加密随机，封装结果每次应不同（这**不是** bug）');
    assertEqual(codeOf(decryptEnvelopeWith(second, privateA)), 'OK', '两次信封都应能解开');

    const a = encryptEnvelopeFor(plaintext, keyA);
    const b = encryptEnvelopeFor(plaintext, keyA);
    assert(a.ciphertext !== b.ciphertext, '不注入 dek/iv 时密文应随机（内容密钥必须每次新取）');
  });

  function fixture(): { doc: ReturnType<typeof buildSyntheticDoc>['doc']; json: string; context: ReadingContext } {
    const { doc } = buildSyntheticDoc({ sections: 2, paragraphsPerSection: 2, fieldsPerParagraph: 1 });
    doc.patient = { patientId: 'P_SEAL', nameMasked: '周**', gender: 'M', birthDate: '1980-01-01' };
    const session = WriteSession.open(doc);
    session.exportMachineReadable();
    return {
      doc: session.document,
      json: session.exportJson({ canonical: true }),
      context: { environmentId: 'WS-01', actorId: 'DR_READER', at: '2026-10-08T10:00:00Z', readCount: 0 },
    };
  }

  function grantFor(docFingerprint: string, docId: string, keyDelivery: ReadingGrant['keyDelivery'], overrides: Partial<ReadingGrant> = {}): ReadingGrant {
    return {
      grantId: `grant_sealed_${docId}`,
      docId,
      documentFingerprint: docFingerprint,
      notBefore: '2026-10-08T00:00:00Z',
      notAfter: '2026-10-09T00:00:00Z',
      maxReads: 2,
      allowedEnvironments: ['WS-01'],
      allowedSections: ['*'],
      concealPatientIdentity: false,
      issuedBy: 'DR_ISSUER',
      issuedAt: '2026-10-08T08:00:00Z',
      purpose: '院内会诊',
      ...(keyDelivery ? { keyDelivery } : {}),
      ...overrides,
    };
  }

  await test('C1 全链路：加密交付 → 签发授权 → 受控阅读（视图与明文都要对）', async () => {
    const { doc, json, context } = fixture();
    const sealed = sealDocumentJson(json, keyA);
    const credential = await issueReadingGrant(grantFor(documentFingerprint(doc), doc.docId, sealed.keyDelivery), ISSUER);

    const result = openSealedForReading({ envelope: sealed.envelope, credential, recipient: privateA, context });
    assertEqual(result.ok, true, `应能受控阅读：${result.reasons.join('；')}`);
    assertEqual(result.view?.docId, doc.docId, '视图应指向该文档');
    assert((result.view?.sections.length ?? 0) > 0, '视图应含授权章节');
    assert((result.plaintext?.length ?? 0) > 0, '应返回明文供后续处理');
    assert((result.view?.notices.join('') ?? '').includes('受控阅读'), '视图必须带受控阅读告知');
  });

  await test('C2 章节白名单在解密后同样生效：未授权章节不进视图', async () => {
    const { doc, json, context } = fixture();
    const sections = Object.values(doc.nodes).filter((node) => node.type === 'section');
    const first = sections[0]!;
    const sealed = sealDocumentJson(json, keyA);
    const credential = await issueReadingGrant(
      grantFor(documentFingerprint(doc), doc.docId, sealed.keyDelivery, { allowedSections: [first.id] }),
      ISSUER,
    );
    const result = openSealedForReading({ envelope: sealed.envelope, credential, recipient: privateA, context });
    assertEqual(result.ok, true, `应放行：${result.reasons.join('；')}`);
    assertEqual(result.view?.sections.length, 1, '只应出现被授权的章节');
    assertEqual(result.view?.concealedSectionCount, sections.length - 1, '被隐藏章节数应如实给出');
  });

  await test('C3 **凭证不可转让是密码学事实**：换成第三人的私钥连密钥都解不开', async () => {
    const { doc, json, context } = fixture();
    const sealed = sealDocumentJson(json, keyA);
    const credential = await issueReadingGrant(grantFor(documentFingerprint(doc), doc.docId, sealed.keyDelivery), ISSUER);
    const result = openSealedForReading({ envelope: sealed.envelope, credential, recipient: privateB, context });
    assertEqual(result.ok, false, '第三人不能阅读');
    assertEqual(result.code, 'E_RECIPIENT_MISMATCH', '应在接收方指纹处直接拒绝');
  });

  await test('C4 改动交付片段（换成别人的封装）→ 授权书签名立刻失效', async () => {
    const { doc, json, context } = fixture();
    const sealed = sealDocumentJson(json, keyA);
    const forB = sealDocumentJson(json, keyB);
    const credential = await issueReadingGrant(grantFor(documentFingerprint(doc), doc.docId, sealed.keyDelivery), ISSUER);
    /* 把"交给 A 的密钥"换成"交给 B 的密钥"：因为 keyDelivery 在签名覆盖范围内，凭证必然验不过 */
    const forged = {
      ...credential,
      grant: { ...credential.grant, keyDelivery: { ...forB.keyDelivery, recipientFingerprint: keyA.fingerprint } },
    };
    const result = openSealedForReading({ envelope: sealed.envelope, credential: forged, recipient: privateA, context });
    assertEqual(result.code, 'E_CREDENTIAL_INVALID', '被改的授权书必须验签失败');
  });

  await test('C5 拿 A 文档的授权去读 B 文档 → 两处封装解出的密钥不一致，直接拒绝', async () => {
    const a = fixture();
    const b = fixture();
    const sealedA = sealDocumentJson(a.json, keyA);
    const sealedB = sealDocumentJson(b.json, keyA);
    const credential = await issueReadingGrant(grantFor(documentFingerprint(a.doc), a.doc.docId, sealedA.keyDelivery), ISSUER);
    /* 信封换成 B 的，但授权书（含 A 的交付片段）不变：指纹一致，密钥却对不上 */
    const result = openSealedForReading({ envelope: sealedB.envelope, credential, recipient: privateA, context: a.context });
    assertEqual(result.code, 'E_KEY_DELIVERY_MISMATCH', '授权书与密文不是同一份时应拒绝');
    assert(result.reasons.join('').includes('不是为这份密文签发'), '原因要说清"授权与密文不匹配"');
  });

  await test('C6 没有交付片段的授权 → 明确报"没给钥匙"，而不是一句解密失败', async () => {
    const { doc, json, context } = fixture();
    const sealed = sealDocumentJson(json, keyA);
    const credential = await issueReadingGrant(grantFor(documentFingerprint(doc), doc.docId, undefined), ISSUER);
    const result = openSealedForReading({ envelope: sealed.envelope, credential, recipient: privateA, context });
    assertEqual(result.code, 'E_KEY_DELIVERY_MISSING', '缺交付片段应单独报码');
  });

  await test('C7 授权过期 → 解密之后仍被拦，且**不返回明文**', async () => {
    const { doc, json, context } = fixture();
    const sealed = sealDocumentJson(json, keyA);
    const credential = await issueReadingGrant(
      grantFor(documentFingerprint(doc), doc.docId, sealed.keyDelivery, { notAfter: '2026-10-08T06:00:00Z' }),
      ISSUER,
    );
    const result = openSealedForReading({ envelope: sealed.envelope, credential, recipient: privateA, context });
    assertEqual(result.code, 'E_GRANT_EXPIRED', '过期授权必须被拦');
    assertEqual(result.plaintext, undefined, '被拒时不得返回明文（否则"拒绝了却还能拿到内容"）');
  });

  await test('C8 授权指纹与文档不符 → E_DOCUMENT_CHANGED（文档绑定校验在工作）', async () => {
    const { doc, json, context } = fixture();
    const sealed = sealDocumentJson(json, keyA);
    const credential = await issueReadingGrant(
      grantFor('0'.repeat(64), doc.docId, sealed.keyDelivery),
      ISSUER,
    );
    const result = openSealedForReading({ envelope: sealed.envelope, credential, recipient: privateA, context });
    assertEqual(result.code, 'E_DOCUMENT_CHANGED', '文档指纹不符必须被拦');
    assertEqual(result.plaintext, undefined, '被拒时不得返回明文');
  });

  await test('C9 次数用尽 / 终端不符 → 各自独立错误码（运维要能区分原因）', async () => {
    const { doc, json, context } = fixture();
    const sealed = sealDocumentJson(json, keyA);
    const credential = await issueReadingGrant(grantFor(documentFingerprint(doc), doc.docId, sealed.keyDelivery), ISSUER);
    assertEqual(
      openSealedForReading({ envelope: sealed.envelope, credential, recipient: privateA, context: { ...context, readCount: 2 } }).code,
      'E_GRANT_EXHAUSTED',
      '次数用尽应拦住',
    );
    assertEqual(
      openSealedForReading({ envelope: sealed.envelope, credential, recipient: privateA, context: { ...context, environmentId: 'WS-99' } }).code,
      'E_ENVIRONMENT_MISMATCH',
      '终端不符应拦住',
    );
    assertEqual(
      openSealedForReading({ envelope: sealed.envelope, credential, recipient: privateA, context, revokedGrantIds: [credential.grant.grantId] }).code,
      'E_GRANT_REVOKED',
      '已撤销应拦住',
    );
  });

  await test('C10 加密的不是文档 JSON 时 → 明确报"还原失败"，不假装读到了内容', async () => {
    const { doc, context } = fixture();
    const sealed = sealDocumentJson('这显然不是文档 JSON', keyA);
    const credential = await issueReadingGrant(grantFor(documentFingerprint(doc), doc.docId, sealed.keyDelivery), ISSUER);
    const result = openSealedForReading({ envelope: sealed.envelope, credential, recipient: privateA, context });
    assertEqual(result.code, 'E_DOCUMENT_PARSE_FAILED', '应报还原失败并说明原因');
    assert(result.reasons.join('').includes('加密的可能不是文档 JSON'), '提示要说清"可能加密的不是文档"');
  });

  await test('C11 摘要口径一致：digestOf 与信封内记录相同（避免两处算出不同摘要）', async () => {
    const plaintext = utf8('口径检查');
    const envelope = encryptEnvelopeFor(plaintext, keyA);
    assertEqual(sm3Hex(plaintext), envelope.header.plaintextDigest, '信封记录的摘要应与 SM3(明文) 相同');
    /* 顺带确认 createHash 这一路也算得一致：它是外部实现，能交叉印证摘要没写错 */
    assertEqual(createHash('sm3').update(plaintext).digest('hex'), envelope.header.plaintextDigest, '与 OpenSSL 一致');
  });

  process.exit(suite.report());
}

await main();
