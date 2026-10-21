import { TestSuite, assert, assertEqual } from '../testing/harness.ts';
import { WriteSession } from './session.ts';
import { buildSyntheticDoc } from '../testing/synthetic.ts';
import { cloneDoc } from '../model/serialize.ts';
import type { DocNode, DocumentModel } from '../model/types.ts';
import {
  canonicalGrant,
  demoReadingIssuer,
  documentFingerprint,
  issueReadingGrant,
  openForReading,
  verifyCredential,
  type ReadingContext,
  type ReadingCredential,
  type ReadingGrant,
} from './controlled-reading.ts';

const suite = new TestSuite('T18 受控阅读自测', [
  '说明：授权的失败模式是"放行"而不是"报错"，因此每条控制都必须有拒绝用例。',
  '凭证用 SM2-SM3 签名（与文件签名同一套原语），环境与次数由调用方集中记账。',
]);

const test = (name: string, fn: () => void | Promise<void>): Promise<void> => suite.test(name, fn);

const ISSUER = demoReadingIssuer();

function fixture(): DocumentModel {
  const { doc } = buildSyntheticDoc({ sections: 2, paragraphsPerSection: 2, fieldsPerParagraph: 1 });
  doc.patient = { patientId: 'P_READ', nameMasked: '李**', gender: 'F', birthDate: '1970-01-01' };
  const session = WriteSession.open(doc);
  session.exportMachineReadable();
  return session.document;
}

function sectionsOf(doc: DocumentModel): Array<Extract<DocNode, { type: 'section' }>> {
  return (Object.values(doc.nodes) as DocNode[]).filter((node): node is Extract<DocNode, { type: 'section' }> => node.type === 'section');
}

function grantFor(doc: DocumentModel, overrides: Partial<ReadingGrant> = {}): ReadingGrant {
  return {
    grantId: 'grant_1',
    docId: doc.docId,
    documentFingerprint: documentFingerprint(doc),
    notBefore: '2026-10-08T00:00:00Z',
    notAfter: '2026-10-09T00:00:00Z',
    maxReads: 2,
    allowedEnvironments: ['WS-01'],
    allowedSections: ['*'],
    concealPatientIdentity: false,
    issuedBy: 'DR_ISSUER',
    issuedAt: '2026-10-08T08:00:00Z',
    purpose: '院内会诊',
    ...overrides,
  };
}

const CONTEXT: ReadingContext = { environmentId: 'WS-01', actorId: 'DR_READER', at: '2026-10-08T10:00:00Z', readCount: 0 };

async function credentialFor(doc: DocumentModel, overrides: Partial<ReadingGrant> = {}): Promise<ReadingCredential> {
  return await issueReadingGrant(grantFor(doc, overrides), ISSUER);
}

async function main(): Promise<void> {

  await test('A1 授权书规范化：字段顺序固定、清单排序无关（协议字节不能随实现漂移）', async () => {
    const doc = fixture();
    const base = grantFor(doc);
    const a = new TextDecoder().decode(canonicalGrant({ ...base, allowedSections: ['b', 'a'], allowedEnvironments: ['WS-02', 'WS-01'] }));
    const b = new TextDecoder().decode(canonicalGrant({ ...base, allowedSections: ['a', 'b'], allowedEnvironments: ['WS-01', 'WS-02'] }));
    assertEqual(a, b, '清单顺序不同不应改变签名字节');
    assert(a.startsWith('ofd-reading-grant/v1\n'), '必须以版本行开头');
    assert(a.endsWith('\n'), '必须以换行结尾');
    assert(a.includes('maxReads=2'), '次数必须进规范化文本（否则改次数不需要重新签发）');
    assert(a.indexOf('maxReads=') < a.indexOf('issuedBy='), '字段顺序必须固定');
  });

  await test('A2 签发 → 校验：正例通过，并给出可核对的公钥指纹', async () => {
    const doc = fixture();
    const credential = await credentialFor(doc);
    const check = verifyCredential(credential);
    assertEqual(check.ok, true, `凭证应校验通过，实际：${check.reasons.join('；')}`);
    assertEqual(credential.publicKeyFingerprint.length, 64, '应带签发者公钥指纹（第三方可核）');
    assert((credential.signatureValue ?? '').length > 60, '应带真实签名值');
  });

  await test('A3 篡改授权书内容（改次数/有效期/范围）必须被检出——否则授权形同虚设', async () => {
    const doc = fixture();
    const credential = await credentialFor(doc, { maxReads: 1 });
    for (const patch of [{ maxReads: 99 }, { notAfter: '2030-01-01T00:00:00Z' }, { allowedEnvironments: [] }, { purpose: '随便看看' }]) {
      const forged: ReadingCredential = { ...credential, grant: { ...credential.grant, ...patch } };
      const check = verifyCredential(forged);
      assertEqual(check.ok, false, `篡改 ${Object.keys(patch)[0]} 后凭证必须校验失败`);
      const decision = openForReading(forged, doc, CONTEXT);
      assertEqual(decision.code, 'E_CREDENTIAL_INVALID', '被篡改的凭证必须拒绝阅读');
    }
  });

  await test('A4 换签名值 / 换公钥：都必须失败（不能"换了签发者还认"）', async () => {
    const doc = fixture();
    const mine = await credentialFor(doc);
    const other = await issueReadingGrant(grantFor(doc, { grantId: 'grant_other', issuedBy: 'DR_OTHER' }), demoReadingIssuer('another-issuer'));

    assertEqual(verifyCredential({ ...mine, signatureValue: other.signatureValue }).ok, false, '换签名值必须失败');
    assertEqual(verifyCredential({ ...mine, publicKeyBase64: other.publicKeyBase64 }).ok, false, '换公钥必须失败');
    assertEqual(
      openForReading({ ...mine, publicKeyFingerprint: other.publicKeyFingerprint }, doc, CONTEXT).code,
      'E_CREDENTIAL_INVALID',
      '被改指纹的凭证必须拒绝阅读',
    );
  });

  await test('B1 正常阅读：放行并产出受控视图（章节/段落/数据元都在，字段值正确）', async () => {
    const doc = fixture();
    const decision = openForReading(await credentialFor(doc), doc, CONTEXT);
    assertEqual(decision.allowed, true, `应放行，实际：${decision.reasons.join('；')}`);
    const view = decision.view!;
    assertEqual(view.docId, doc.docId, '视图应标明文档');
    assertEqual(view.sections.length, 2, '应包含两个授权章节');
    assert(view.sections.every((section) => section.paragraphs.length > 0), '章节应有正文段落');
    assert(view.sections.flatMap((section) => section.fields).length > 0, '应包含数据元');
    assertEqual(view.remainingReads, 1, '首次阅读后剩余 1 次（maxReads=2）');
    assertEqual(view.purpose, '院内会诊', '视图应带用途说明（审计需要）');
  });

  await test('B2 有效期：未生效与已过期都必须拒绝，且原因可区分', async () => {
    const doc = fixture();
    const credential = await credentialFor(doc);

    const early = openForReading(credential, doc, { ...CONTEXT, at: '2026-10-07T23:00:00Z' });
    assertEqual(early.code, 'E_GRANT_NOT_YET_VALID', '未生效必须拒绝');
    assert(early.reasons.join('').includes('2026-10-08T00:00:00Z'), '原因应给出生效时间');

    const late = openForReading(credential, doc, { ...CONTEXT, at: '2026-10-10T00:00:00Z' });
    assertEqual(late.code, 'E_GRANT_EXPIRED', '过期必须拒绝');
    assert(late.reasons.join('').includes('过期'), '原因应说明已过期');

    assertEqual(openForReading(credential, doc, { ...CONTEXT, at: '2026-10-08T00:00:00Z' }).allowed, true, '生效时刻应可读');
    assertEqual(openForReading(credential, doc, { ...CONTEXT, at: '2026-10-09T00:00:00Z' }).allowed, true, '失效时刻应可读');
  });

  await test('B3 次数：用尽必须拒绝；剩余次数随记账递减；不限次时返回 null', async () => {
    const doc = fixture();
    const credential = await credentialFor(doc, { maxReads: 2 });

    assertEqual(openForReading(credential, doc, { ...CONTEXT, readCount: 0 }).view?.remainingReads, 1, '首读后剩 1 次');
    assertEqual(openForReading(credential, doc, { ...CONTEXT, readCount: 1 }).view?.remainingReads, 0, '第二次阅读后剩 0 次');
    const exhausted = openForReading(credential, doc, { ...CONTEXT, readCount: 2 });
    assertEqual(exhausted.code, 'E_GRANT_EXHAUSTED', '用完必须拒绝');
    assert(exhausted.reasons.join('').includes('已读 2 次'), '原因应说明已读次数');

    const unlimited = await credentialFor(doc, { grantId: 'grant_unlimited', maxReads: null });
    assertEqual(openForReading(unlimited, doc, { ...CONTEXT, readCount: 999 }).allowed, true, '不限次授权不应因次数被拦');
    assertEqual(openForReading(unlimited, doc, { ...CONTEXT, readCount: 999 }).view?.remainingReads, null, '不限次时剩余次数为 null');
  });

  await test('B4 环境绑定：凭证不可转让（换终端必须拒绝）；空清单表示不限环境', async () => {
    const doc = fixture();
    const bound = await credentialFor(doc, { allowedEnvironments: ['WS-01', 'WS-02'] });
    assertEqual(openForReading(bound, doc, { ...CONTEXT, environmentId: 'WS-02' }).allowed, true, '白名单内终端应可读');
    const mismatch = openForReading(bound, doc, { ...CONTEXT, environmentId: 'WS-99' });
    assertEqual(mismatch.code, 'E_ENVIRONMENT_MISMATCH', '白名单外终端必须拒绝');
    assert(mismatch.reasons.join('').includes('不可转让'), '原因应说明"凭证不可转让"（现场最需要知道这句）');

    const anyEnvironment = await credentialFor(doc, { grantId: 'grant_any_env', allowedEnvironments: [] });
    assertEqual(openForReading(anyEnvironment, doc, { ...CONTEXT, environmentId: 'ANY-WS' }).allowed, true, '空清单表示不限环境');
  });

  await test('B5 文档被改动：旧凭证立即失效（改节点、改机读数据、换文档都要拦住）', async () => {
    const doc = fixture();
    const credential = await credentialFor(doc);

    const tamperedNodes = cloneDoc(doc);
    const text = (Object.values(tamperedNodes.nodes) as DocNode[]).find((node) => node.type === 'text');
    if (text && text.type === 'text') text.runs = [{ text: '被改动的正文' }];
    assertEqual(openForReading(credential, tamperedNodes, CONTEXT).code, 'E_DOCUMENT_CHANGED', '改节点内容必须拒绝');

    const tamperedMachine = cloneDoc(doc);
    tamperedMachine.machineReadable = { ...tamperedMachine.machineReadable!, sourceHash: 'deadbeef' };
    assertEqual(openForReading(credential, tamperedMachine, CONTEXT).code, 'E_DOCUMENT_CHANGED', '改机读数据必须拒绝');

    const otherDoc = fixture();
    otherDoc.docId = 'doc_other';
    const decision = openForReading(credential, otherDoc, CONTEXT);
    assertEqual(decision.code, 'E_DOCUMENT_CHANGED', '换一份文档必须拒绝（凭证绑定的是具体内容）');
    assert(decision.reasons.join('').includes('doc_other'), '原因应指出当前文档 id');
  });

  await test('B6 撤销：撤销列表中的凭证必须拒绝（撤销优先于其它判定）', async () => {
    const doc = fixture();
    const credential = await credentialFor(doc);
    assertEqual(openForReading(credential, doc, CONTEXT).allowed, true, '未撤销时应放行');
    const revoked = openForReading(credential, doc, CONTEXT, { revokedGrantIds: ['grant_1'] });
    assertEqual(revoked.code, 'E_GRANT_REVOKED', '撤销后必须拒绝');
    assertEqual(verifyCredential(credential).ok, true, '撤销是状态而非签名问题：凭证本身仍然有效');
  });

  await test('C1 章节白名单：只出现授权章节，未授权章节**根本不进视图**并如实计数', async () => {
    const doc = fixture();
    const first = sectionsOf(doc)[0]!;
    const credential = await credentialFor(doc, { allowedSections: [first.id] });
    const view = openForReading(credential, doc, CONTEXT).view!;

    assertEqual(view.sections.length, 1, '只应出现被授权的章节');
    assertEqual(view.sections[0]!.id, first.id, '出现的应正是被授权那一节');
    assertEqual(view.concealedSectionCount, 1, '被隐藏的章节数必须如实告知');
    assert(!JSON.stringify(view).includes('sec2'), '未授权章节的痕迹不得出现在视图里');
  });

  await test('C2 可按章节编码授权（临床说的是"给他看检验，不给看精神科记录"）', async () => {
    const doc = fixture();
    const sections = sectionsOf(doc);
    const code = sections[1]!.sectionCode!;
    assert(!!code, '前置：合成文档的章节应有 sectionCode');
    const credential = await credentialFor(doc, { allowedSections: [code] });
    const view = openForReading(credential, doc, CONTEXT).view!;
    assertEqual(view.sections.length, 1, '按编码授权应命中对应章节');
    assertEqual(view.sections[0]!.title, sections[1]!.title, '命中的应是编码对应的章节');
  });

  await test('C3 fail-closed：空白名单 = 什么都不放行（不是"默认全给"）', async () => {
    const doc = fixture();
    const credential = await credentialFor(doc, { allowedSections: [] });
    const decision = openForReading(credential, doc, CONTEXT);
    assertEqual(decision.allowed, true, '授权有效，故不报错');
    assertEqual(decision.view!.sections.length, 0, '空白名单不得放行任何章节');
    assertEqual(decision.view!.concealedSectionCount, 2, '所有章节都应计为隐藏');
  });

  await test('C4 通配符 * 表示全部章节；身份隐藏时视图不出现姓名', async () => {
    const doc = fixture();
    const wildcard = openForReading(await credentialFor(doc, { allowedSections: ['*'] }), doc, CONTEXT).view!;
    assertEqual(wildcard.sections.length, 2, '通配符应放行全部章节');
    assertEqual(wildcard.concealedSectionCount, 0, '通配符下没有隐藏章节');

    const concealed = openForReading(await credentialFor(doc, { grantId: 'g2', concealPatientIdentity: true }), doc, CONTEXT).view!;
    assertEqual(concealed.patientLabel, '（患者身份已隐藏）', '身份隐藏时不得显示姓名');
    assert(!JSON.stringify(concealed).includes('李**'), '姓名痕迹不得出现在视图里');
  });

  await test('C5 视图必须带受控阅读告知（用途/有效期/剩余次数）——水印是控制的一部分', async () => {
    const doc = fixture();
    const view = openForReading(await credentialFor(doc), doc, CONTEXT).view!;
    const notices = view.notices.join('\n');
    assert(notices.includes('受控阅读'), '必须标注"受控阅读"');
    assert(notices.includes('grant_1'), '必须标明授权编号（可追溯）');
    assert(notices.includes('院内会诊'), '必须写明用途');
    assert(notices.includes('2026-10-09T00:00:00Z'), '必须写明有效期');
    assert(notices.includes('剩余阅读次数 1'), '必须写明剩余次数');
  });

  await test('D1 文档指纹：同文档稳定、改一个字段即变（凭证绑定的就是它）', async () => {
    const doc = fixture();
    assertEqual(documentFingerprint(doc), documentFingerprint(cloneDoc(doc)), '同内容应得到同一指纹');
    assertEqual(documentFingerprint(doc).length, 64, '指纹应为 64 位十六进制（SM3）');

    const changed = cloneDoc(doc);
    changed.patient = { ...changed.patient, nameMasked: '赵**' };
    assert(documentFingerprint(changed) !== documentFingerprint(doc), '姓名变化必须改变指纹');

    const changedGender = cloneDoc(doc);
    changedGender.patient = { ...changedGender.patient, gender: 'M' };
    assert(documentFingerprint(changedGender) !== documentFingerprint(doc), '性别变化必须改变指纹');

    const changedBirth = cloneDoc(doc);
    changedBirth.patient = { ...changedBirth.patient, birthDate: '1971-02-02' };
    assert(documentFingerprint(changedBirth) !== documentFingerprint(doc), '出生日期变化必须改变指纹');

    const changedMachine = cloneDoc(doc);
    changedMachine.machineReadable = { ...changedMachine.machineReadable!, sourceHash: 'ffff' };
    assert(documentFingerprint(changedMachine) !== documentFingerprint(doc), '机读数据变化必须改变指纹');
  });

  await test('D2 确定性：同一凭证同一上下文的判定与视图完全一致（可复现）', async () => {
    const doc = fixture();
    const credential = await credentialFor(doc);
    assertEqual(
      JSON.stringify(openForReading(credential, doc, CONTEXT)),
      JSON.stringify(openForReading(credential, doc, CONTEXT)),
      '两次判定应完全一致',
    );
  });

  await test('D3 非法阅读时间必须报错而不是"当成 0 放行"', async () => {
    const doc = fixture();
    const decision = openForReading(await credentialFor(doc), doc, { ...CONTEXT, at: '不是时间' });
    assertEqual(decision.allowed, false, '非法时间必须拒绝');
    assertEqual(decision.code, 'E_CREDENTIAL_INVALID', '应归为凭证/上下文非法');
  });

  process.exit(suite.report());
}

await main();
