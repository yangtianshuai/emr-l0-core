import { TestSuite, assert, assertEqual } from '../testing/harness.ts';
import { DEMO_SIGNING_SEED, WriteSession, type Actor } from './session.ts';
import { buildSyntheticDoc } from '../testing/synthetic.ts';
import { cloneDoc } from '../model/serialize.ts';
import { errorsOf, validateDocument } from '../model/index.ts';
import { hashNodes } from '../model/hash.ts';
import type { DocNode, DocumentModel, SignatureRef } from '../model/types.ts';
import { SIGNATURE_ALGORITHM, demoKeyPair, softwareSigner, type Signer } from '../crypto/provider.ts';
import {
  canonicalSignedInfo,
  documentSignatureTargets,
  fromBase64,
  signTargets,
  toBase64,
  verifyTargets,
  type SignatureBlock,
  type SignatureTarget,
} from '../crypto/signature.ts';
import { parseSignaturesXml, signaturesXml } from '../crypto/ofd-signature-xml.ts';
import { buildOfdPackage, verifyOfdEntries } from '../export/ofd.ts';
import type { ZipEntry } from '../export/zip.ts';

const HUMAN: Actor = { id: 'DR_SIG', kind: 'human' };
const PLAN = { layout: { textAsPath: false }, machineReadable: { signed: true, carrier: 'separate-xml' as const } };

const suite = new TestSuite('T18 国密签章与验签自测', [
  '说明：A 组锁死 SignedInfo 的字节规范；B/C 组要求"篡改必须被检出，且指明改了哪个文件"。',
  '签名算法为 SM2-SM3；演示密钥由种子确定性派生（生产必须换成密码设备）。',
]);

const test = (name: string, fn: () => void | Promise<void>): Promise<void> => suite.test(name, fn);

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);
const signer = softwareSigner(demoKeyPair('signature-self-test-key').privateKey);

/** 待签名文件（容器层测试用） */
function targets(): SignatureTarget[] {
  return [
    { path: 'Document.xml', bytes: enc('document-content-v1\n') },
    { path: 'Pages/Page_0/Content.xml', bytes: enc('page-content-v1\n') },
    { path: 'MachineReadable.xml', bytes: enc('machine-v1\n') },
  ];
}

function meta(): { signatureRef: string; documentId: string; signerRole: string; signerId: string; signedAt: string } {
  return { signatureRef: 'sig_test_1', documentId: 'doc_sig', signerRole: 'author', signerId: 'DR_SIG', signedAt: '2026-10-08T12:00:00.000Z' };
}

async function signedSession(): Promise<WriteSession> {
  const { doc } = buildSyntheticDoc({ sections: 2, paragraphsPerSection: 2, fieldsPerParagraph: 1 });
  const session = WriteSession.open(doc);
  await session.sign({}, HUMAN);
  return session;
}

/** 从文档还原签名块（与 session.verifySignature 内部同一口径，用于对"被改文档"验签） */
function blockOf(doc: DocumentModel): SignatureBlock {
  const ref = doc.signatureRefs?.[0];
  assert(!!ref, '文档应带签名引用');
  const r = ref as SignatureRef;
  return {
    meta: {
      signatureRef: r.signatureRef,
      documentId: doc.docId,
      signerRole: r.signerRole ?? 'author',
      signerId: r.signerId ?? '',
      signedAt: r.signedAt ?? doc.updatedAt,
      algorithm: r.algorithm ?? '',
      provider: r.provider ?? '',
    },
    publicKeyBase64: r.publicKeyBase64 ?? '',
    publicKeyFingerprint: r.publicKeyFingerprint ?? '',
    references: (r.references ?? []).map((reference) => ({ path: reference.path, digest: reference.digest })),
    signedInfoDigest: r.signedInfoDigest ?? '',
    signatureValue: r.signatureValue ?? '',
  };
}

function docTargets(doc: DocumentModel): SignatureTarget[] {
  return documentSignatureTargets(doc, hashNodes(doc.nodes));
}

async function main(): Promise<void> {

  await test('A1 SignedInfo 规范化：字段顺序固定、reference 排序无关（协议字节不能随实现漂移）', async () => {
    const full = { ...meta(), algorithm: SIGNATURE_ALGORITHM, provider: 'software' };
    const a = canonicalSignedInfo(full, [
      { path: 'B.xml', digest: 'bb' },
      { path: 'A.xml', digest: 'aa' },
    ], 'ff');
    const b = canonicalSignedInfo(full, [
      { path: 'A.xml', digest: 'aa' },
      { path: 'B.xml', digest: 'bb' },
    ], 'ff');
    assertEqual(new TextDecoder().decode(a), new TextDecoder().decode(b), 'reference 顺序不同不应改变签名字节');
    const text = new TextDecoder().decode(a);
    assert(text.startsWith('ofd-signature/v1\n'), '必须以版本行开头（第三方据此识别规范）');
    assert(text.endsWith('\n'), '必须以换行结尾（避免"末尾有无换行"造成两套字节）');
    assert(text.indexOf('algorithm=') < text.indexOf('signatureRef='), '字段顺序必须固定（algorithm 在 signatureRef 之前）');
  });

  await test('A2 签名 → 验签往返：正例必须通过，且给出算法与覆盖清单', async () => {
    const block = await signTargets(targets(), meta(), signer);
    const result = verifyTargets(block, targets());
    assertEqual(result.ok, true, `验签应通过，实际：${result.reasons.join('；')}`);
    assertEqual(result.details.algorithm, 'SM2-SM3', '算法标识应为 SM2-SM3');
    assertEqual(result.details.referenceCount, 3, '应覆盖 3 个文件');
    assertEqual(
      block.references.map((reference) => reference.path),
      ['Document.xml', 'MachineReadable.xml', 'Pages/Page_0/Content.xml'],
      '摘要清单应按路径排序',
    );
  });

  await test('A3 篡改被签文件：必须检出并**指明是哪个文件**', async () => {
    const block = await signTargets(targets(), meta(), signer);
    const tampered = targets().map((target) =>
      target.path === 'MachineReadable.xml' ? { path: target.path, bytes: enc('machine-v1-tampered\n') } : target,
    );
    const result = verifyTargets(block, tampered);
    assertEqual(result.ok, false, '被改文件必须导致验签失败');
    assert(result.reasons.some((reason) => reason.includes('MachineReadable.xml')), `失败原因必须指明文件，实际：${result.reasons.join('；')}`);
  });

  await test('A4 篡改 SignedInfo 元数据（改 signedAt）：必须检出"元数据被改动"', async () => {
    const block = await signTargets(targets(), meta(), signer);
    const forged: SignatureBlock = { ...block, meta: { ...block.meta, signedAt: '2030-01-01T00:00:00.000Z' } };
    const result = verifyTargets(forged, targets());
    assertEqual(result.ok, false, '元数据被改必须导致验签失败');
    assert(result.reasons.some((reason) => reason.includes('SignedInfo')), `应指出 SignedInfo 被改动，实际：${result.reasons.join('；')}`);
  });

  await test('A5 换签名值 / 换公钥：都必须失败（不能"换了钥匙还认账"）', async () => {
    const block = await signTargets(targets(), meta(), signer);
    const otherBlock = await signTargets(targets(), meta(), softwareSigner(demoKeyPair('another-key').privateKey));

    assertEqual(verifyTargets({ ...block, signatureValue: otherBlock.signatureValue }, targets()).ok, false, '换成别人密钥的签名值必须失败');
    assertEqual(
      verifyTargets({ ...block, publicKeyBase64: otherBlock.publicKeyBase64, publicKeyFingerprint: otherBlock.publicKeyFingerprint }, targets()).ok,
      false,
      '换公钥却保留原签名必须失败',
    );
    const mismatched = verifyTargets({ ...block, publicKeyBase64: otherBlock.publicKeyBase64 }, targets());
    assertEqual(mismatched.ok, false, '公钥与指纹不一致必须失败');
    assert(mismatched.reasons.some((reason) => reason.includes('公钥')), `应指出公钥问题，实际：${mismatched.reasons.join('；')}`);
  });

  await test('A6 不支持的算法与未覆盖文件：都必须显式报出，不能静默通过', async () => {
    const block = await signTargets(targets(), meta(), signer);
    const unknownAlgorithm = verifyTargets({ ...block, meta: { ...block.meta, algorithm: 'RSA-SHA256-UNSUPPORTED' } }, targets());
    assertEqual(unknownAlgorithm.ok, false, '不支持的算法必须失败');
    assert(unknownAlgorithm.reasons.some((reason) => reason.includes('不支持的签名算法')), '应明确指出算法不支持');

    const withExtra = verifyTargets(block, [...targets(), { path: 'Extra.xml', bytes: enc('extra\n') }]);
    assertEqual(withExtra.ok, false, '存在未被签名覆盖的文件必须报出（否则"多出来的东西"无人负责）');
    assert(withExtra.reasons.some((reason) => reason.includes('Extra.xml')), '应指出哪个文件没被覆盖');
  });

  await test('A7 base64 与 DER：签名值可原样还原（不允许"能签不能还原"）', async () => {
    const block = await signTargets(targets(), meta(), signer);
    const bytes = fromBase64(block.signatureValue);
    assertEqual(toBase64(bytes), block.signatureValue, 'base64 往返应一致');
    assertEqual(bytes[0], 0x30, 'DER 签名应以 SEQUENCE(0x30) 开头');
    assert(bytes.length > 60, 'DER 签名长度应合理（r/s 各约 32 字节 + 头）');
  });

  await test('B1 签章产出完整签名材料：算法 / 后端 / 指纹 / 摘要 / 签名值 / 覆盖清单', async () => {
    const session = await signedSession();
    const ref = session.document.signatureRefs?.[0] as SignatureRef;
    assert(!!ref, '应产生签名引用');
    assertEqual(ref.algorithm, 'SM2-SM3', '算法应为 SM2-SM3');
    assertEqual(ref.provider, 'software', '后端应如实标注');
    assertEqual((ref.publicKeyFingerprint ?? '').length, 64, '公钥指纹应为 64 位十六进制');
    assertEqual((ref.signedInfoDigest ?? '').length, 64, 'SignedInfo 摘要应为 64 位十六进制');
    assert((ref.signatureValue ?? '').length > 60, '签名值不应为空');
    assertEqual(ref.references?.length, 3, '应覆盖 3 个逻辑文件');
    assertEqual(ref.covers, ['Document.xml', 'Pages/Page_0/Content.xml', 'MachineReadable.xml'], '覆盖清单应与契约一致');
  });

  await test('B2 独立验签：签章后立即验签通过，签名信息可供展示', async () => {
    const session = await signedSession();
    const result = session.verifySignature();
    assertEqual(result.ok, true, `文档级验签应通过，实际：${result.reasons.join('；')}`);
    const info = session.signatureInfo();
    assertEqual(info?.algorithm, 'SM2-SM3', '签名信息应给出算法');
    assertEqual(info?.provider, 'software', '签名信息应给出后端');
    assertEqual((info?.covers ?? []).some((item) => item.includes('MachineReadable')), true, '签名必须覆盖机读文件');
  });

  await test('B3 节点内容被改 → 验签失败并指明 Pages/Page_0/Content.xml', async () => {
    const session = await signedSession();
    const block = blockOf(session.document);
    assertEqual(verifyTargets(block, docTargets(session.document)).ok, true, '前置：原文档应验签通过');

    const forged = cloneDoc(session.document);
    const textNode = Object.values(forged.nodes).find((node) => node.type === 'text') as Extract<DocNode, { type: 'text' }>;
    textNode.runs = [{ text: '被外部篡改的正文' }];

    const result = verifyTargets(block, docTargets(forged));
    assertEqual(result.ok, false, '节点内容被改必须导致验签失败');
    assert(
      result.reasons.some((reason) => reason.includes('Content.xml')),
      `应指出页面内容被改动，实际：${result.reasons.join('；')}`,
    );
  });

  await test('B4 元数据被改（患者姓名）→ 验签失败并指明 Document.xml', async () => {
    const session = await signedSession();
    const forged = cloneDoc(session.document);
    forged.patient = { ...forged.patient, nameMasked: '李**' };

    const result = verifyTargets(blockOf(session.document), docTargets(forged));
    assertEqual(result.ok, false, '患者信息被改必须导致验签失败');
    assert(result.reasons.some((reason) => reason.includes('Document.xml')), `应指出 Document.xml 被改动，实际：${result.reasons.join('；')}`);
  });

  await test('B5 机读数据被改（sourceHash）→ 验签失败并指明 MachineReadable.xml', async () => {
    const session = await signedSession();
    const forged = cloneDoc(session.document);
    forged.machineReadable = { ...forged.machineReadable!, sourceHash: 'deadbeefdeadbeefdeadbeefdeadbeef' };

    const result = verifyTargets(blockOf(session.document), docTargets(forged));
    assertEqual(result.ok, false, '机读数据被改必须导致验签失败');
    assert(result.reasons.some((reason) => reason.includes('MachineReadable.xml')), `应指出机读文件被改动，实际：${result.reasons.join('；')}`);
  });

  await test('B6 签名材料被删掉一半 → 校验必须报 E_SIGNATURE_INCOMPLETE（不可验证的"签章"）', async () => {
    const session = await signedSession();
    const forged = cloneDoc(session.document);
    delete (forged.signatureRefs?.[0] as { signatureValue?: string }).signatureValue;

    const codes = errorsOf(validateDocument(forged)).map((issue) => issue.code);
    assert(codes.includes('E_SIGNATURE_INCOMPLETE'), `应报签名材料不完整，实际：${JSON.stringify(codes)}`);
    assertEqual(session.verifySignature().ok, true, '对照：完整材料应能验签');
  });

  await test('B7 密钥可注入：不同种子不同指纹；注入外部后端时 provider 如实记录', async () => {
    const { doc } = buildSyntheticDoc({ sections: 1, paragraphsPerSection: 1, fieldsPerParagraph: 1 });
    const a = WriteSession.open(cloneDoc(doc), { signingKeySeed: 'key-a' });
    const b = WriteSession.open(cloneDoc(doc), { signingKeySeed: 'key-b' });
    await a.sign({}, HUMAN);
    await b.sign({}, HUMAN);
    const fa = a.document.signatureRefs?.[0]?.publicKeyFingerprint;
    const fb = b.document.signatureRefs?.[0]?.publicKeyFingerprint;
    assert(!!fa && !!fb && fa !== fb, '不同密钥应产生不同指纹');
    assertEqual(a.verifySignature().ok, true, '注入种子的会话仍应自洽可验');

    const device: Signer = { ...softwareSigner(demoKeyPair('hsm-simulated').privateKey), provider: 'hsm-simulated' };
    const c = WriteSession.open(cloneDoc(doc), { signer: device });
    await c.sign({}, HUMAN);
    assertEqual(c.document.signatureRefs?.[0]?.provider, 'hsm-simulated', '注入后端应如实写入 provider');
    assertEqual(c.verifySignature().ok, true, '注入后端的签名也应可验（算法标识一致）');
    assert(DEMO_SIGNING_SEED.length > 0, '演示密钥种子常量应存在（文档已声明其为演示用）');
  });

  await test('C1 Signatures.xml 往返：写进去的能读回来，读回的 block 仍可验签', async () => {
    const block = await signTargets(targets(), meta(), signer);
    const xml = signaturesXml(block);
    const parsed = parseSignaturesXml(xml);
    assert(!!parsed, '应能解析出签名块');
    assertEqual(parsed!.meta, block.meta, '元数据应逐字段一致');
    assertEqual(parsed!.references, block.references, '摘要清单应一致');
    assertEqual(parsed!.publicKeyBase64, block.publicKeyBase64, '公钥应一致');
    assertEqual(parsed!.signatureValue, block.signatureValue, '签名值应一致');
    assertEqual(verifyTargets(parsed!, targets()).ok, true, '读回的 block 必须能验签通过');
    assert(xml.includes('ofd-signature/v1'), 'XML 注释里应写明 SignedInfo 的规范化规则（第三方据此复算）');
    assertEqual(parseSignaturesXml('<ofd:Signatures xmlns:ofd="x"/>'), null, '不含 Signature 的 XML 应返回 null（区分"未签名"与"签名坏了"）');
  });

  await test('C2 导出的 OFD：独立验签通过；篡改任一被覆盖文件都必须失败并定位', async () => {
    const session = await signedSession();
    const pkg = await session.exportOfd(PLAN);
    assert(!!pkg.signature, '已签章文档导出后应带容器级签名');
    const result = verifyOfdEntries(pkg.entries);
    assertEqual(result?.ok, true, `容器级验签应通过，实际：${result?.reasons.join('；')}`);
    assertEqual(
      pkg.signature!.references.map((reference) => reference.path),
      ['Doc_0/Document.xml', 'Doc_0/MachineReadable.xml', 'Doc_0/Pages/Page_0/Content.xml', 'Doc_0/Res/DocumentRes.xml'],
      '容器签名应覆盖真实文件路径（含导出时才生成的资源文件）',
    );

    const tamper = (path: string, mutate: (data: string) => string): ZipEntry[] =>
      pkg.entries.map((entry) => (entry.path === path ? { path: entry.path, data: mutate(String(entry.data)) } : entry));

    const machineResult = verifyOfdEntries(tamper('Doc_0/MachineReadable.xml', (data) => `${data}<!-- x -->`));
    assertEqual(machineResult?.ok, false, '篡改机读文件必须失败');
    assert((machineResult?.reasons ?? []).some((reason) => reason.includes('MachineReadable.xml')), '应指出机读文件被改动');

    const pageResult = verifyOfdEntries(tamper('Doc_0/Pages/Page_0/Content.xml', (data) => data.replace('</ofd:Content>', '<!-- t --></ofd:Content>')));
    assertEqual(pageResult?.ok, false, '篡改页面内容必须失败');
    assert((pageResult?.reasons ?? []).some((reason) => reason.includes('Content.xml')), '应指出页面文件被改动');
  });

  await test('C3 已签章文档未提供签名后端时，导出必须明确拒绝（不许产出"无签名的已签章文件"）', async () => {
    const session = await signedSession();
    let message = '';
    try {
      await buildOfdPackage(session.document, PLAN);
    } catch (err) {
      message = (err as Error).message;
    }
    assert(message.includes('未提供签名后端'), `应明确说明缺少签名后端，实际：${message}`);

    const ok = await buildOfdPackage(session.document, PLAN, { signer });
    assertEqual(verifyOfdEntries(ok.entries)?.ok, true, '提供 signer 后导出应可验签');
  });

  process.exit(suite.report());
}

await main();
