// T17 验收自测：OFD / OFD-H 导出。

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WriteSession, type Actor } from '../core/session.ts';
import { machineToExpectation } from '../model/machine.ts';
import { buildSyntheticDoc } from '../testing/synthetic.ts';
import { TestSuite, assert, assertEqual } from '../testing/harness.ts';
import { DEFAULT_LAYOUT, estimateWidth, renderLines, verifyOfdEntries, type OfdExportPlan, type OfdPackage } from './ofd.ts';
import { buildZip } from './zip.ts';
import { probeImage } from '../media/image-probe.ts';
import type { DocNode, NodeId } from '../model/types.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const ARTIFACTS = join(ROOT, 'artifacts');
const PROBE = join(ROOT, 'tools', 'ofd-check', 'ofd-roundtrip-check.mjs');
const HUMAN: Actor = { id: 'DR_T', kind: 'human' };

const PLAN: OfdExportPlan = {
  layout: { textAsPath: false },
  machineReadable: { signed: true, carrier: 'separate-xml' },
};

const suite = new TestSuite('T17 OFD / OFD-H 导出自测', [
  '说明：产物用工具链探针独立验收——"自己说导出了 OFD"不算数，第三方能解包、能抽回数据才算。',
  '签名是真实的国密签名（SM2-SM3，见 T18）：容器签名值与内嵌公钥由 C1 逐项断言，可用独立探针复算验签。',
  '仍不得用于合规声明：自研密码学未经第三方审计，生产必须换经认证的密码模块。',
]);

const test = (name: string, fn: () => void | Promise<void>): Promise<void> => suite.test(name, fn);

interface ProbeCheck {
  id: string;
  name: string;
  pass: boolean;
  critical: boolean;
  detail: string;
}

interface ProbeReport {
  verdict: string;
  stats: { textChars: number; textCodeCount: number; pathObjectCount: number; pageCount: number };
  machineReadable: { customPrefixes: Array<{ prefix: string; count: number }>; keywordHits: Array<{ keyword: string }> };
  signatures: { files: string[]; signedRefs: string[] };
  roundTrip: { total: number; found: number; completeness: number } | null;
  checks: ProbeCheck[];
}

/** 图片夹具：仓库里那张真 PNG（1615×928）。用真图而不是手搓字节——
 *  能顺带证明"探测头读得懂、归档件里的字节不需要重编码"。
 *  位置在 `docs/images/`：截图统一归档在那里，不要再搬回仓库根。  */
const IMAGE_FIXTURE = join(ROOT, 'docs', 'images', 'flow-mode.png');
const IMAGE_RES_REF = '/res/flow-mode.png';

/**
 * 构造一份"已定稿"的门诊病历：含字段、关键内容、AI 采纳内容、签章。
 *
 * `withImage` 会在签章之前往第一段里贴一张图：图必须在签章前进来，
 * 因为签章之后文档就不可改了 —— 而"图片进不进签名覆盖"正是要验的东西。
  */
async function signedSession(options: { withImage?: boolean } = {}): Promise<{
  session: WriteSession;
  textId: NodeId;
  fieldId: NodeId;
  resRef: string;
}> {
  const { doc, ids } = buildSyntheticDoc({ sections: 3, paragraphsPerSection: 3, fieldsPerParagraph: 1 });
  const session = WriteSession.open(doc);
  const textId = ids.textIds[0] as NodeId;
  const fieldId = ids.fieldIds[0] as NodeId;

  let resRef = '';
  if (options.withImage === true) {
    /* 图挂在段落下（与医生端贴图的挂法一致）：段落那一支走的是内联拼接，
       不特殊处理就会被压成一行 `[图像：地址]` 文本，图本身一个字都进不了归档件。  */
    const paragraphId = doc.nodes[textId]?.parentId;
    if (!paragraphId) throw new Error('前置：文本节点应挂在段落上');
    resRef = IMAGE_RES_REF;
    session.createNode(
      {
        parentId: paragraphId,
        type: 'image',
        props: { resRef: IMAGE_RES_REF, altText: '术前定位图', caption: '图1 术前定位' } as unknown as Partial<DocNode>,
      },
      HUMAN,
    );
  }

  // 关键内容：主诉段落
  session.updateNodeProps({ nodeId: textId, patch: { keyContent: true } }, HUMAN);
  /* 先打标签、再让 AI 写：标签来自模板（人工），内容来自 AI。
     顺序反了的话，人工续改会把 origin 变成 human（+derivedFrom），
     机读块里就只剩"人写的"，AI 参与度在数据元层面丢失。 */
  session.updateNodeProps({ nodeId: textId, patch: { tags: [{ system: 'WST500', code: 'WST500.2.001', display: '主诉' }] } }, HUMAN);
  // AI 起草 + 人改 + 确认（走完整门控）
  const { suggestionId } = session.suggestText(
    {
      nodeId: textId,
      text: '患者3天前出现咳嗽、咳痰，伴发热。',
      confidence: 0.95,
      modelId: 'local/qwen-med:7b@2026-09',
      promptId: 'tpl-chief-complaint-v2',
      evidence: [{ kind: 'lis', ref: 'LIS:20261008-0100:WBC', valueText: '9.8' }],
    },
    { id: 'ai-pipeline', kind: 'ai' },
  );
  session.acceptSuggestion({ suggestionId, editedText: '患者3天前无诱因出现咳嗽、咳痰，痰为白色黏痰，伴发热，最高体温38.5℃。' }, HUMAN);
  session.setFieldValue({ nodeId: fieldId, value: 38.5, valueText: '38.5' }, HUMAN);
  session.confirmNode({ nodeId: textId }, HUMAN);
  session.confirmNode({ nodeId: fieldId }, HUMAN);
  await session.sign({}, HUMAN);
  return { session, textId, fieldId, resRef };
}

function runProbe(file: string, expectFile?: string): { report: ProbeReport; exitCode: number } {
  const args = [PROBE, file, '--json', `${file}.report.json`];
  if (expectFile) args.push('--expect', expectFile);
  const result = spawnSync(process.execPath, args, { encoding: 'utf8' });
  if (result.error) throw new Error(`探针执行失败：${result.error.message}`);
  const report = JSON.parse(readFileSync(`${file}.report.json`, 'utf8').replace(/^\uFEFF/, '')) as ProbeReport;
  return { report, exitCode: result.status ?? 2 };
}

function ensureArtifacts(): void {
  if (!existsSync(ARTIFACTS)) mkdirSync(ARTIFACTS, { recursive: true });
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

async function main(): Promise<void> {
  ensureArtifacts();

  await test('A1 禁止文本路径化：textAsPath !== false 直接拒绝', async () => {
    const { session } = await signedSession();
    session.exportMachineReadable();
    let code = 'OK';
    try {
      await session.exportOfd({ layout: { textAsPath: true }, machineReadable: { signed: true } });
    } catch (err) {
      code = (err as { code?: string }).code ?? 'UNKNOWN';
    }
    assertEqual(code, 'E_EXPORT_INVALID_PLAN', '路径化计划必须被拒（否则产出"可视化陷阱"文件）');
  });

  await test('A2 机读信息必须纳入签名覆盖：signed !== true 直接拒绝', async () => {
    const { session } = await signedSession();
    session.exportMachineReadable();
    let code = 'OK';
    try {
      await session.exportOfd({ layout: { textAsPath: false }, machineReadable: { signed: false } });
    } catch (err) {
      code = (err as { code?: string }).code ?? 'UNKNOWN';
    }
    assertEqual(code, 'E_EXPORT_INVALID_PLAN', '机读未纳入签名的导出必须被拒');
  });

  await test('B1 内容变更后未重算机读信息 → 导出被拒（陈旧门）', async () => {
    const { doc, ids } = buildSyntheticDoc({ sections: 2, paragraphsPerSection: 2, fieldsPerParagraph: 1 });
    const session = WriteSession.open(doc);
    session.exportMachineReadable();
    assertEqual(session.machineReadableStatus().stale, false, '派生后应新鲜');

    session.setFieldValue({ nodeId: ids.fieldIds[0] as NodeId, value: 1, valueText: '1' }, HUMAN);
    assertEqual(session.machineReadableStatus().stale, true, '字段变更后应陈旧');

    let code = 'OK';
    try {
      await session.exportOfd(PLAN);
    } catch (err) {
      code = (err as { code?: string }).code ?? 'UNKNOWN';
    }
    assertEqual(code, 'E_MACHINE_READABLE_STALE', '陈旧时导出必须被拒');

    // 重算后同一份文档即可导出（证明这不是"卡死"，而是"必须先重算"）
    session.exportMachineReadable();
    assert((await session.exportOfd(PLAN)).bytes.length > 1000, '重算后应能正常导出');
  });

  await test('B2 重算机读信息后导出成功（正路径）', async () => {
    const { session } = await signedSession();
    const pkg = await session.exportOfd(PLAN);
    assert(pkg.bytes.length > 1000, `产物过小：${pkg.bytes.length} 字节`);
    assert(pkg.pages >= 1, '至少一页');
    assert(pkg.stats.dataElements > 0, '应含机读数据元');
    assertEqual(pkg.stats.textChars > 0, true, '正文应有真实文本');
  });

  await test('C1 产物结构：入口/文档/页面/机读/签名文件齐备，签名覆盖机读文件', async () => {
    const { session } = await signedSession();
    const pkg = await session.exportOfd(PLAN);
    const paths = pkg.entries.map((entry) => entry.path);
    for (const required of ['OFD.xml', 'Doc_0/Document.xml', 'Doc_0/MachineReadable.xml', 'Doc_0/Pages/Page_0/Content.xml', 'Doc_0/Signatures/Signatures.xml']) {
      assert(paths.includes(required), `缺少必需文件：${required}`);
    }
    const signatures = pkg.entries.find((entry) => entry.path.endsWith('Signatures.xml'))?.data as string;
    assert(signatures.includes('FileRef="Doc_0/MachineReadable.xml"'), '签名必须覆盖 MachineReadable.xml');
    /* T18 起签名是真实的国密签名（SM2-SM3），占位符必须彻底消失 */
    assert(signatures.includes('<ofd:SignatureMethod>SM2-SM3</ofd:SignatureMethod>'), '签名算法应为 SM2-SM3');
    assert(!signatures.includes('PLACEHOLDER'), '不得再出现占位符签名（那是最危险的产物：看起来已签、实际不可验证）');
    assert(signatures.includes('ofd-signature/v1'), '必须写明 SignedInfo 的规范化规则（第三方据此复算）');
    assert(/<ofd:PublicKey [^>]*>[\w+/=]{80,}<\/ofd:PublicKey>/.test(signatures), '必须内嵌公钥（第三方验签只需文件本身）');
    assert(!!pkg.signature && (pkg.signature.signatureValue.length ?? 0) > 60, '容器签名值不应为空');
  });

  await test('C2 真实文本对象：Content.xml 含 TextCode，且不把文字画成路径', async () => {
    const { session } = await signedSession();
    const pkg = await session.exportOfd(PLAN);
    const content = pkg.entries.filter((entry) => entry.path.includes('Content.xml')).map((entry) => String(entry.data)).join('\n');
    const textCodes = content.match(/<ofd:TextCode\b/g)?.length ?? 0;
    assert(textCodes > 5, `TextCode 过少：${textCodes}`);
    assertEqual(/<ofd:PathObject\b/.test(content), false, '正文不应出现 PathObject（那是"可视化陷阱"）');
    assert(content.includes('患者3天前'), '正文文本应真实落在文件里');
  });

  await test('C3 机读文件承载结构化数据（值 + 标签 + 来源 + 置信度）', async () => {
    const { session, fieldId } = await signedSession();
    const pkg = await session.exportOfd(PLAN);
    const machine = String(pkg.entries.find((entry) => entry.path === 'Doc_0/MachineReadable.xml')?.data ?? '');
    assert(machine.includes(fieldId), '机读文件应包含字段 nodeId');
    assert(machine.includes('system="WS445"'), '机读文件应包含标准标签体系');
    assert(machine.includes('origin="ai"'), '机读文件应保留 AI 来源');
    assert(machine.includes('confidence='), '机读文件应保留置信度（审计依据）');
    assert(machine.includes('sourceHash='), '机读文件应带内容指纹（陈旧检测依据）');
  });

  await test('C4 布局：中文按全角、ASCII 按半角估算宽度（换行与分页的基础）', async () => {
    assertEqual(estimateWidth('中文', 10), 20, '两个 CJK 字符 = 2 em');
    assertEqual(estimateWidth('abcd', 10), 20, '四个 ASCII 字符 = 2 em');
  });

  await test('C5 渲染顺序：按文档顺序输出，章节标题加粗且字号更大', async () => {
    const { session } = await signedSession();
    const lines = renderLines(session.document);
    assert(lines.length > 5, `渲染行过少：${lines.length}`);
    const firstSection = lines.find((line) => line.bold);
    assert(!!firstSection, '应存在加粗的章节标题行');
    assert(firstSection.fontSize > DEFAULT_LAYOUT.fontSizePt, '标题字号应大于正文');
    const ids = lines.map((line) => line.nodeId);
    assertEqual(new Set(ids).size > 1, true, '应覆盖多个节点');
  });

  await test('C6 图片真进归档件：字节在 Res/MultiMedia、资源清单有 MultiMedia、Content 有 ImageObject', async () => {
    const { session, resRef } = await signedSession({ withImage: true });
    const png = new Uint8Array(readFileSync(IMAGE_FIXTURE));
    const probed = probeImage(png);
    assert(!!probed && probed.mime === 'image/png', `前置：夹具应是 PNG（实际 ${probed?.mime ?? '认不出来'}）`);

    const pkg = await session.exportOfd(PLAN, { resolveImage: (ref) => (ref === resRef ? png : null) });
    assertEqual(pkg.warnings, [], '正路径不该有告警（图取得到、格式认得出）');

    const media = pkg.entries.find((entry) => entry.path === 'Doc_0/Res/MultiMedia/1.png');
    assert(!!media, `容器里必须有图片字节。实际条目：${pkg.entries.map((entry) => entry.path).join(' / ')}`);
    const mediaBytes = media?.data;
    assert(mediaBytes instanceof Uint8Array, '图片条目必须是二进制（不是字符串）');
    assertEqual(sameBytes(mediaBytes as Uint8Array, png), true, '容器里的图片必须与源文件**逐字节一致**（不得重编码）');
    assertEqual((mediaBytes as Uint8Array).length, png.length, '图片长度不应变化');

    const res = String(pkg.entries.find((entry) => entry.path === 'Doc_0/Res/DocumentRes.xml')?.data ?? '');
    assert(res.includes('<ofd:MultiMedia ID="MM_1" Type="Image" Format="PNG">'), '资源清单要声明这张图');
    assert(res.includes('<ofd:MediaFile>MultiMedia/1.png</ofd:MediaFile>'), '资源清单要指向真实文件');

    const contents = pkg.entries.filter((entry) => /Content\.xml$/.test(entry.path)).map((entry) => String(entry.data));
    const content = contents.join('\n');
    assert(content.includes('ResourceID="MM_1"'), 'Content.xml 要有指向该资源的 ImageObject');
    assert(
      /<ofd:ImageObject\b[^>]*\bBoundary="[^"]+"[^>]*\bCTM="/.test(content),
      'ImageObject 必须同时有 Boundary 与 CTM（缺 CTM 图会按原图像素尺寸铺开）',
    );
    assert(content.includes('图1 术前定位'), '图注要画在图下方（它是这张图的说明）');
    assert(!content.includes('[图像：'), '不得再出现「[图像：地址]」文本占位 —— 图已经真进归档件了');

    const plain = await (await signedSession()).session.exportOfd(PLAN);
    assertEqual(pkg.stats.textObjects, plain.stats.textObjects + 1, '图行不得计入 textObjects（只多出图注一行）');
  });

  await test('C7 图片版式：超宽按版心等比缩、缺图留占位并告警（不静默跳过）', async () => {
    const { session, resRef } = await signedSession({ withImage: true });
    const png = new Uint8Array(readFileSync(IMAGE_FIXTURE));

    /* 图行不带文字：带文字就会与图重叠，而"谁压着谁"取决于阅读器 */
    const imageLine = renderLines(session.document, {
      imageBoxOf: (ref) => (ref === resRef ? { widthPt: 100, heightPt: 50, resourceId: 'MM_1' } : null),
    }).find((line) => line.image !== undefined);
    assert(!!imageLine, 'renderLines 应把图排成一块图行，而不是一行文字');
    assertEqual(imageLine?.text, '', '图行不带文字');

    const pkg = await session.exportOfd(PLAN, { resolveImage: () => png });
    const content = pkg.entries.filter((entry) => /Content\.xml$/.test(entry.path)).map((entry) => String(entry.data)).join('\n');
    const boundary = /<ofd:ImageObject\b[^>]*\bBoundary="([\d.]+) ([\d.]+) ([\d.]+) ([\d.]+)"/.exec(content);
    assert(!!boundary, '应能找到 ImageObject 的 Boundary');
    const width = Number(boundary?.[3] ?? '0');
    const height = Number(boundary?.[4] ?? '0');
    /* 远超 A4 正文宽（595 − 56×2 = 483）→ 必须被压进版心 */
    assert(width > 0 && width <= 483.5, `图宽应被压进版心（实际 ${width}pt）`);
    /* 期望比例从样例本身读，不要写死尺寸：截图一旦重截（现在这张是 1615×928），
       写死的那个数就会红成"比例走样"，而真走样的那次反而分不清是哪一次。  */
    const probedFixture = probeImage(png);
    assert(!!probedFixture, '前置：夹具应能探出尺寸');
    assertEqual(
      Math.round((width / height) * 100),
      Math.round(((probedFixture?.width ?? 0) / (probedFixture?.height ?? 1)) * 100),
      '缩放必须等比（宽高比不许走样）',
    );

    /* 缺图：纸面留占位 + warnings 说清。静默少一块，审计时才发现，是最难查的一类缺页 */
    const missing = await session.exportOfd(PLAN, { resolveImage: () => null });
    assertEqual(missing.warnings.length, 1, `缺图必须回一条告警（实际 ${JSON.stringify(missing.warnings)}）`);
    assert(missing.warnings[0].includes('取不到'), `告警要说清是"取不到"（实际：${missing.warnings[0]}）`);
    const missingContent = missing.entries.filter((entry) => /Content\.xml$/.test(entry.path)).map((entry) => String(entry.data)).join('\n');
    assert(missingContent.includes('[图片缺失'), '纸面要留「[图片缺失」占位');
  });

  await test('C8 图片必须进签名覆盖：换掉归档件里的图，验签必须失败', async () => {
    const { session } = await signedSession({ withImage: true });
    const png = new Uint8Array(readFileSync(IMAGE_FIXTURE));
    const pkg = await session.exportOfd(PLAN, { resolveImage: () => png });
    assert(!!pkg.signature, '前置：这份病历应已签章');

    const signatures = String(pkg.entries.find((entry) => entry.path.endsWith('Signatures.xml'))?.data ?? '');
    assert(signatures.includes('Doc_0/Res/MultiMedia/1.png'), '图片字节必须在签名覆盖清单里（否则图可换而签名不破）');
    assert(signatures.includes('Doc_0/Res/DocumentRes.xml'), '资源清单同样要覆盖（否则可把 ResourceID 改指向别的文件）');

    /* 真换一次图：验签必须失败。只断言"清单里有"是不够的 ——
       清单里写了但没真去算摘要，照样验得过。 */
    const tampered = pkg.entries.map((entry) => (
      entry.path === 'Doc_0/Res/MultiMedia/1.png' ? { ...entry, data: new Uint8Array([1, 2, 3, 4]) } : entry
    ));
    const verdict = verifyOfdEntries(tampered);
    assert(!!verdict, '应能读出签名块');
    assertEqual(verdict?.ok, false, '换掉图片后验签必须失败');
    assert(
      (verdict?.reasons ?? []).some((reason) => reason.includes('MultiMedia')),
      `验签失败要说清是哪个文件被换了（实际：${JSON.stringify(verdict?.reasons ?? [])}）`,
    );
  });

  await test('D1 独立探针验收：已定稿 OFD-H 全部关键检查通过，round-trip ≥95%', async () => {
    const { session } = await signedSession();
    const file = join(ARTIFACTS, 'demo-signed.ofd');
    const info = await session.writeOfdFile(file, PLAN);
    assert(existsSync(file), `产物未落盘：${file}`);
    assert(info.pages >= 1, '应写出页数');

    // 用文档自带的机读块生成"期望清单"，再让探针反向抽取比对
    const expect = machineToExpectation(session.document.machineReadable!);
    const expectFile = join(ARTIFACTS, 'demo-signed.machine.json');
    writeFileSync(expectFile, `${JSON.stringify(expect, null, 2)}\n`, 'utf8');

    const { report, exitCode } = runProbe(file, expectFile);
    const failed = report.checks.filter((check) => check.critical && !check.pass);
    assertEqual(failed.map((check) => `${check.id}:${check.detail}`), [], '探针关键检查不应失败');
    assertEqual(exitCode, 0, `探针退出码应为 0，实际 ${exitCode}`);
    assertEqual(report.verdict, 'PASS', '探针结论应为 PASS');
    assert(report.stats.textChars > 50, `真实文本字符过少：${report.stats.textChars}`);
    assert((report.roundTrip?.completeness ?? 0) >= 0.95, `round-trip 完整率应 ≥95%，实际 ${report.roundTrip?.completeness}`);
    assertEqual(report.roundTrip?.found, report.roundTrip?.total, '期望元素应全部命中');
    assertEqual(report.signatures.signedRefs.some((ref) => ref.includes('MachineReadable.xml')), true, '被签文件清单应含机读文件');
  });

  await test('D2 未签章产物：结构/文本/机读仍达标，签名检查为"草稿可接受"', async () => {
    const { doc, ids } = buildSyntheticDoc({ sections: 2, paragraphsPerSection: 2, fieldsPerParagraph: 1 });
    const session = WriteSession.open(doc);
    session.insertText({ nodeId: ids.textIds[0] as NodeId, text: '（草稿，尚未定稿）' }, HUMAN);
    session.exportMachineReadable();
    const file = join(ARTIFACTS, 'demo-draft.ofd');
    await session.writeOfdFile(file, PLAN);

    // 期望清单必须来自本产物自身（不能借用已定稿文档的清单，否则比的是两份不同文档）
    const expectFile = join(ARTIFACTS, 'demo-draft.machine.json');
    writeFileSync(expectFile, `${JSON.stringify(machineToExpectation(session.document.machineReadable!), null, 2)}\n`, 'utf8');
    const { report, exitCode } = runProbe(file, expectFile);
    assertEqual(exitCode, 0, '草稿产物在非 --require-signature 下也应通过关键检查');
    assertEqual(report.checks.find((check) => check.id === 'C4')?.critical, false, 'C4 在未要求签名时为非关键');
    assert((report.machineReadable.customPrefixes.length > 0) || report.machineReadable.keywordHits.length > 0, '机读块应可被探针探测到');
  });

  await test('D3 对照：路径化"换壳"产物会被探针判为失败（证明探针有鉴别力）', async () => {
    // 手工构造一个只有路径对象、没有真实文本的 OFD，验证探针能识破
    const bytes = buildZip([
      { path: 'OFD.xml', data: '<?xml version="1.0"?><ofd:OFD xmlns:ofd="http://www.ofd.org/OFD"><ofd:DocBody><ofd:DocRoot>Doc_0/Document.xml</ofd:DocRoot></ofd:DocBody></ofd:OFD>' },
      { path: 'Doc_0/Document.xml', data: '<?xml version="1.0"?><ofd:Document xmlns:ofd="http://www.ofd.org/OFD"><ofd:Pages><ofd:Page ID="Page_0" BaseLoc="Pages/Page_0/Content.xml"/></ofd:Pages></ofd:Document>' },
      { path: 'Doc_0/Pages/Page_0/Content.xml', data: '<?xml version="1.0"?><ofd:Content xmlns:ofd="http://www.ofd.org/OFD"><ofd:Page><ofd:Content><ofd:Layer><ofd:PathObject ID="p1"><ofd:AbbreviatedData>M 10 10 L 300 10 L 300 30 Z</ofd:AbbreviatedData></ofd:PathObject></ofd:Layer></ofd:Content></ofd:Page></ofd:Content>' },
    ]);
    const file = join(ARTIFACTS, 'path-only.ofd');
    writeFileSync(file, bytes);
    const { report, exitCode } = runProbe(file);
    assertEqual(exitCode, 1, '路径化产物必须判为失败');
    assertEqual(report.checks.find((check) => check.id === 'C2')?.pass, false, 'C2 文本真实性应失败');
  });

  /* ==================== C9 列表项：编号是位置函数 ==================== */

  await test('C9 列表项：无序打点、有序按兄弟位置编号（编号不由节点自带，改一项之后要跟着变）', () => {
    const { doc } = buildSyntheticDoc({ sections: 1, paragraphsPerSection: 1, fieldsPerParagraph: 0 });
    const session = WriteSession.open(doc);
    const sectionId = Object.values(doc.nodes).find((node) => node.type === 'section')?.id;
    assert(!!sectionId, '前置：合成文档应有一个章节');
    const ordered = session.createNode(
      { parentId: sectionId as NodeId, type: 'listGroup', props: { ordered: true } as unknown as Partial<DocNode> },
      HUMAN,
    );
    const bullets = session.createNode({ parentId: sectionId as NodeId, type: 'listGroup' }, HUMAN);
    const addItem = (groupId: NodeId, text: string): void => {
      const item = session.createNode({ parentId: groupId, type: 'listItem' }, HUMAN);
      session.createNode(
        {
          parentId: item.targetId as NodeId,
          type: 'text',
          props: { runs: [{ text }] } as unknown as Partial<DocNode>,
        },
        HUMAN,
      );
    };
    addItem(ordered.targetId as NodeId, '第一条');
    addItem(ordered.targetId as NodeId, '第二条');
    addItem(bullets.targetId as NodeId, '注意事项');

    const lines = renderLines(session.document).map((line) => line.text);
    assert(lines.includes('1. 第一条'), `有序列表第一项要编号（实际：${lines.join(' ⏎ ')}）`);
    assert(lines.includes('2. 第二条'), '有序列表第二项要跟着变号（编号来自位置，不是节点自带的字段）');
    assert(lines.includes('· 注意事项'), '无序列表打点（`ordered` 缺省 = 无序）');
    assert(
      !lines.some((text) => text.startsWith('3. ')),
      '第二个组是无序的：编号不能跨组累加（否则纸面上的"第 3 条"根本不存在于那份列表里）',
    );
  });

  await test('E1 导出确定性：同一文档两次导出字节完全一致（内容寻址与比对的前提）', async () => {
    const { session } = await signedSession();
    const a: OfdPackage = await session.exportOfd(PLAN);
    const b: OfdPackage = await session.exportOfd(PLAN);
    assertEqual(a.bytes.length, b.bytes.length, '两次导出字节长度应一致');
    assertEqual(sameBytes(a.bytes, b.bytes), true, '两次导出字节应完全一致');
    assertEqual(
      a.entries.map((entry) => entry.path),
      b.entries.map((entry) => entry.path),
      '文件清单与顺序应一致',
    );
  });

  await test('E2 多页分页：内容足够长时页数增加，且每页文件都存在', async () => {
    const { doc } = buildSyntheticDoc({ sections: 6, paragraphsPerSection: 6, fieldsPerParagraph: 1 });
    const session = WriteSession.open(doc);
    session.exportMachineReadable();
    const pkg = await session.exportOfd(PLAN);
    assert(pkg.pages >= 2, `长文档应分多页，实际 ${pkg.pages}`);
    for (let index = 0; index < pkg.pages; index += 1) {
      assert(
        pkg.entries.some((entry) => entry.path === `Doc_0/Pages/Page_${index}/Content.xml`),
        `缺少第 ${index} 页内容文件`,
      );
    }
  });

  await test('E4 打印加固：页眉/页脚在独立装饰层、页码成对可归位、不泄露身份', async () => {
    const { doc } = buildSyntheticDoc({ sections: 6, paragraphsPerSection: 6, fieldsPerParagraph: 1 });
    const session = WriteSession.open(doc);
    session.exportMachineReadable();
    const pkg = await session.exportOfd(PLAN);
    assert(pkg.pages >= 2, `应有分页，实际 ${pkg.pages}`);

    const contentOf = (index: number): string =>
      String(pkg.entries.find((entry) => entry.path === `Doc_0/Pages/Page_${index}/Content.xml`)?.data ?? '');
    const first = contentOf(0);

    assert(first.includes('Layer ID="layer-furniture-header"'), '页眉应在独立装饰层');
    assert(first.includes('Layer ID="layer-furniture-footer"'), '页脚应在独立装饰层');
    assert(first.includes('Layer ID="layer0"'), '正文层必须保持 layer0（导入端按此契约取正文）');

    for (let index = 0; index < pkg.pages; index += 1) {
      const content = contentOf(index);
      assert(
        content.includes(`第 ${index + 1} 页 共 ${pkg.pages} 页`),
        `第 ${index + 1} 页页码应为"第 ${index + 1} 页 共 ${pkg.pages} 页"，实际内容缺失`,
      );
      assert(
        content.includes('layer-furniture-header') && content.includes('layer-furniture-footer'),
        `第 ${index + 1} 页应同时有页眉与页脚`,
      );
    }

    assert(!first.includes(doc.patient.patientId), '页眉不得印患者 ID');
  });

  await test('E5 打印加固：标题不落在页底（孤行控制）；装订边与页眉页脚压缩正文区', async () => {
    /* 每段恰好一行 → 标题密集出现，孤行控制最容易露馅 */
    const { doc } = buildSyntheticDoc({ sections: 12, paragraphsPerSection: 1, fieldsPerParagraph: 0 });
    const session = WriteSession.open(doc);
    session.exportMachineReadable();

    const plain = await session.exportOfd(PLAN);
    const boxed = await session.exportOfd({ ...PLAN, layout: { ...PLAN.layout, bindingMarginPt: 24 } });
    assert(boxed.pages >= 1, '加装订边后仍应正常分页');

    const bodyOf = (pkg: OfdPackage, index: number): string => {
      const content = String(pkg.entries.find((entry) => entry.path === `Doc_0/Pages/Page_${index}/Content.xml`)?.data ?? '');
      return /<ofd:Layer ID="layer0">([\s\S]*?)<\/ofd:Layer>/.exec(content)?.[1] ?? '';
    };

    /* 孤行控制：任何一页的最后一个文本对象都不能是标题（黑体 F2 = 标题/加粗） */
    for (let index = 0; index < boxed.pages; index += 1) {
      const objects = bodyOf(boxed, index).match(/<ofd:TextObject[^>]*>/g) ?? [];
      const last = objects[objects.length - 1] ?? '';
      assert(!last.includes('Font="F2"'), `第 ${index + 1} 页的最后一行是标题（孤行），标题应连同正文移到下一页`);
    }

    /* 装订边必须真的生效：正文左边界外移（否则"装了订就把字压住了"） */
    const indent = (pkg: OfdPackage): number => {
      const m = /<ofd:TextCode X="([\d.]+)"/.exec(bodyOf(pkg, 0));
      return m ? Number(m[1]) : -1;
    };
    assert(indent(boxed) > indent(plain), `装订边应让正文左边界右移（无装订边 ${indent(plain)} / 有装订边 ${indent(boxed)}）`);
  });

  await test('E3 校验回归：导出前后的文档仍通过模型校验（导出不改数据）', async () => {
    const { session } = await signedSession();
    const before = session.exportJson({ canonical: true });
    await session.exportOfd(PLAN);
    const after = session.exportJson({ canonical: true });
    assertEqual(after, before, '导出不应改动文档内容');
    assertEqual(session.verifyInvariants(), [], '导出后不变量应成立');
  });

  process.exit(suite.report());
}

void main();
