/**
 * T25b 验收自测：WS/T 500（电子病历共享文档）XML 映射导入。
 *
 *   node src/import/wst500-self-test.ts
 *
 * 覆盖五层：
 *   A 识别层：格式嗅探（ZIP vs ClinicalDocument vs 无关文件）、文档头、患者、编码声明
 *   B 映射层（头号用例）：章节树 / 叙述文本 / entry→数据元 / 标签体系归类 / 无值条目
 *   C 纪律层：来源可追溯、不继承签名、全部标未确认、机读新鲜、与签章门控联动
 *   D 反例层：非 ClinicalDocument、空输入、缺结构化正文（不假装有内容）
 *   E 黄金样例：样例落盘 → 读回 → 与人工核对的期望逐项相等；两次导入幂等
 *
 * 为什么用黄金样例：映射规则一旦被改动（哪怕"看起来更合理"），期望值立刻对不上。
 * 它挡住的是**静默的语义漂移**，而不是"测试太严"。
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WriteSession, type Actor } from '../core/session.ts';
import { errorsOf, validateDocument } from '../model/index.ts';
import type { DocNode, NodeId } from '../model/types.ts';
import { TestSuite, assert, assertEqual, codeOfAsync } from '../testing/harness.ts';
import { ImportError, sha256Hex } from './import-types.ts';
import { importAnyDocument, sniffImportFormat, describeAnyImport } from './import-any.ts';
import { importWst500, buildWst500Draft, type Wst500Field } from './wst500-import.ts';
import { WST500_SAMPLE_XML, WST500_HEADER_ONLY_XML, WST500_GBK_DECLARED_XML, WST500_SAMPLE_EXPECT as EXPECT } from './wst500-fixture.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const ARTIFACTS = join(ROOT, 'artifacts');
const SAMPLE_FILE = 'wst500-sample.xml';
const HUMAN: Actor = { id: 'DR_T', kind: 'human' };

const suite = new TestSuite('T25b WS/T 500 导入自测', [
  '说明：黄金样例（wst500-fixture）是人工逐项核对的期望，映射结果必须与之完全相等。',
  '纪律与 OFD 导入一致：来源可追溯、不继承签名、全部标未确认、必须人工核对后才能签章。',
]);

const test = (name: string, fn: () => void | Promise<void>): Promise<void> => suite.test(name, fn);

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);

function codeOf(fn: () => unknown): string {
  try {
    fn();
    return 'OK';
  } catch (err) {
    return (err as { code?: string }).code ?? 'UNKNOWN';
  }
}

function ensureArtifacts(): void {
  if (!existsSync(ARTIFACTS)) mkdirSync(ARTIFACTS, { recursive: true });
}

function readSample(): Uint8Array {
  ensureArtifacts();
  const file = join(ARTIFACTS, SAMPLE_FILE);
  if (!existsSync(file)) writeFileSync(file, WST500_SAMPLE_XML, 'utf8');
  return readFileSync(file);
}

function fieldsOf(imported: ReturnType<typeof importWst500>): Wst500Field[] {
  const out: Wst500Field[] = [];
  const walk = (sections: ReturnType<typeof importWst500>['sections']): void => {
    for (const section of sections) {
      out.push(...section.fields);
      walk(section.children);
    }
  };
  walk(imported.sections);
  return out;
}

async function main(): Promise<void> {
  /* ========================= A 识别层 ========================= */

  await test('A1 格式嗅探：ZIP→OFD、ClinicalDocument→WS/T 500、无关文件→明确拒绝（不硬试）', async () => {
    assertEqual(sniffImportFormat(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00])), 'ofd', 'ZIP 魔数应识别为 OFD');
    assertEqual(sniffImportFormat(enc(WST500_SAMPLE_XML)), 'wst500', 'ClinicalDocument 应识别为 WS/T 500');
    assertEqual(sniffImportFormat(enc('患者姓名,年龄\n张三,30\n')), 'unknown', 'CSV 不算可识别的病历容器');

    /* 认不出来时必须明确报错：硬猜格式会把排查方向带偏（"不是 ZIP 容器" vs 真实问题"XML 不规范"） */
    let code = 'OK';
    let message = '';
    try {
      importAnyDocument(enc('患者姓名,年龄\n'), 'unknown.csv');
    } catch (err) {
      code = (err as { code?: string }).code ?? 'UNKNOWN';
      message = (err as Error).message;
    }
    assertEqual(code, 'E_IMPORT_FAILED', '无法识别时应抛 E_IMPORT_FAILED');
    assert(message.includes('unknown.csv'), `错误信息应带上文件名便于定位，实际：${message}`);
    assert(message.includes('ClinicalDocument') && message.includes('ZIP'), '错误信息应说明两种可识别格式');
  });

  await test('A2 文档头：id / code / displayName / effectiveTime / 作者与机构', async () => {
    const imported = importWst500(readSample());
    assertEqual(imported.document.id, EXPECT.documentId, '文档 id 应取 id/@extension');
    assertEqual(imported.document.code, EXPECT.docTypeCode, '文档类型 code 应识别');
    assertEqual(imported.document.display, EXPECT.docTypeDisplay, '文档类型显示名应识别');
    assertEqual(imported.document.effectiveTime, EXPECT.effectiveTime, 'CDA 时间应转为 ISO');
    assertEqual(imported.document.authorName, EXPECT.authorName, '作者姓名应识别');
    assertEqual(imported.document.authorOrg, EXPECT.authorOrg, '机构名应识别');
  });

  await test('A3 患者：病历号 / 性别 / 出生日期识别，且**姓名必须已脱敏**（不得落明文）', async () => {
    const imported = importWst500(readSample());
    assertEqual(imported.patient?.patientId, EXPECT.patientId, '病历号应取 patientRole/id@extension');
    assertEqual(imported.patient?.gender, EXPECT.gender, '性别应由 displayName/code 判定');
    assertEqual(imported.patient?.birthDate, EXPECT.birthDate, '出生日期应转为 ISO');
    assertEqual(imported.patient?.nameMasked, EXPECT.nameMasked, '姓名应脱敏为「姓 + 星号」');
    assert(!JSON.stringify(imported).includes(EXPECT.rawName), `导入结果中不得出现明文姓名 ${EXPECT.rawName}`);
    assert(imported.warnings.some((line) => line.includes('脱敏')), '脱敏必须给出明确警告');
  });

  await test('A4 编码声明：声明非 UTF-8 时不崩、且给出编码警告（不静默乱码）', async () => {
    const imported = importWst500(enc(WST500_GBK_DECLARED_XML));
    assert(
      imported.warnings.some((line) => line.toLowerCase().includes('gbk') && (line.includes('已按声明解码') || line.includes('不支持'))),
      `声明 GBK 时必须明确告知编码处理方式，实际警告：${JSON.stringify(imported.warnings)}`,
    );
  });

  await test('A5 文件指纹：与独立计算的 SHA-256 一致（来源证据不能自证）', async () => {
    const bytes = readSample();
    const expected = createHash('sha256').update(bytes).digest('hex');
    const imported = importWst500(bytes);
    assertEqual(imported.fileSha256, expected, 'fileSha256 应等于独立计算的 SHA-256');
    assertEqual(imported.fileSha256, sha256Hex(bytes), '两条计算路径必须同一口径');
  });

  /* ========================= B 映射层 ========================= */

  await test('B1 章节树：顶层章节顺序、数量与**嵌套子章节的父子归属**', async () => {
    const imported = importWst500(readSample());
    assertEqual(imported.sections.length, 5, '顶层应有 5 个章节');
    assertEqual(imported.sections.map((section) => section.title), EXPECT.topLevelTitles, '顶层章节标题与顺序应保持源文件顺序');
    assertEqual(imported.stats.sections, EXPECT.sectionCount, '章节总数应含嵌套子章节（6）');

    const diagnosis = imported.sections[4]!;
    assertEqual(diagnosis.children.length, 1, '「初步诊断」应有 1 个嵌套子章节');
    assertEqual(diagnosis.children[0]!.title, EXPECT.nestedChildTitle, '子章节标题应识别');
    assertEqual(diagnosis.children[0]!.code, 'WST500.2.031', '子章节 code 应保留');
  });

  await test('B2 叙述文本：按块切分成段落，内容与源文件一致（段落语义不丢）', async () => {
    const imported = importWst500(readSample());
    assertEqual(imported.stats.paragraphs, EXPECT.paragraphCount, '段落总数应为 5');
    assertEqual(imported.sections[0]!.paragraphs, ['发热3天，伴咳嗽、咳痰。', '无药物及食物过敏史。'], '「主诉」两段应分别成段');
    const textChars = imported.sections
      .flatMap(function walk(section): string[] {
        return [...section.paragraphs, ...section.children.flatMap(walk)];
      })
      .reduce((sum, line) => sum + line.length, 0);
    assertEqual(imported.stats.textChars, textChars, '字符数统计应与段落文本一致');
  });

  await test('B3 数据元：entry/observation → 字段（标签、取值、单位、类型）', async () => {
    const imported = importWst500(readSample());
    assertEqual(imported.stats.fields, EXPECT.fieldCount, '应映射出 4 条结构化数据元');
    const temp = fieldsOf(imported).find((field) => field.tag.code === EXPECT.temperature.code);
    assert(!!temp, '应找到体温数据元');
    assertEqual(temp?.tag.display, EXPECT.temperature.display, '标签显示名应保留');
    assertEqual(temp?.tag.system, EXPECT.temperature.system, 'WS/T 500 根 OID 的数据元归类为 WST500');
    assertEqual(temp?.valueText, EXPECT.temperature.valueText, '取值应取 value/@value');
    assertEqual(temp?.unit, EXPECT.temperature.unit, '单位应取 value/@unit');
    assertEqual(temp?.dataType, 'number', '纯数字取值应判为 number 类型');
    assertEqual(temp?.sourceElement, 'observation', '应记录承载元素名，便于回溯');
  });

  await test('B4 标签体系：非 WS/T 500 的 codeSystem 归为 local，且**保留源 OID**（不假装等价）', async () => {
    const imported = importWst500(readSample());
    const wbc = fieldsOf(imported).find((field) => field.tag.code === EXPECT.wbc.code);
    assert(!!wbc, '应找到白细胞计数数据元');
    assertEqual(wbc?.tag.system, EXPECT.wbc.system, '非 WS/T 500 根 OID 不得被声称为 WST500');
    assertEqual(wbc?.sourceCodeSystem, EXPECT.wbc.sourceCodeSystem, '源 codeSystem(OID) 必须保留供人工核对');
    assertEqual(imported.codeSystems.slice().sort(), EXPECT.codeSystems.slice().sort(), '源文件出现过的 codeSystem 清单应完整');
  });

  await test('B5 缺编码 / 缺取值的 entry：跳过并计数，**不生成空值字段**', async () => {
    const imported = importWst500(readSample());
    assertEqual(imported.stats.skippedEntries, EXPECT.skippedEntries, '无编码与无取值的 entry 各 1 条，应计入跳过');
    assert(
      imported.warnings.some((line) => line.includes('缺少编码或取值')),
      '跳过必须给出原因说明',
    );
    for (const field of fieldsOf(imported)) {
      assert(field.valueText.trim() !== '', `不得生成空值字段：${field.tag.code}（空值会被误读为"阴性/正常"）`);
    }
  });

  await test('B6 命名空间前缀混用（cd:structuredBody）仍能识别', async () => {
    const imported = importWst500(readSample());
    assertEqual(imported.hasStructuredBody, true, '带前缀的 structuredBody 应被识别');
    /* 再验一次"无前缀"版本：把前缀全部去掉，结果必须一致（按本地名匹配） */
    const plain = importWst500(enc(WST500_SAMPLE_XML.replace(/cd:/g, '')));
    assertEqual(plain.stats.sections, imported.stats.sections, '去前缀后章节数应一致');
    assertEqual(plain.stats.fields, imported.stats.fields, '去前缀后数据元数应一致');
  });

  /* ========================= C 纪律层 ========================= */

  await test('C1 纪律：内容节点全部 origin=imported、humanConfirmed=false，且证据含文件名与 SHA-256', async () => {
    const bytes = readSample();
    const imported = importWst500(bytes);
    const { doc } = buildWst500Draft(imported, { docId: 'doc_ws_discipline', actorId: 'DR_T', fileName: SAMPLE_FILE, importedAt: '2026-10-08T10:35:00Z' });
    const contentNodes = Object.values(doc.nodes as Record<NodeId, DocNode>).filter((node) => node.type === 'text' || node.type === 'field');
    assert(contentNodes.length > 0, '应有内容节点');
    for (const node of contentNodes) {
      assertEqual(node.provenance?.origin, 'imported', `节点 ${node.id} 来源应为 imported`);
      assertEqual(node.humanConfirmed, false, `节点 ${node.id} 必须标为未确认`);
      const evidence = node.provenance?.evidence?.[0];
      assertEqual(evidence?.kind, 'external-doc', `节点 ${node.id} 应带外部文档证据`);
      assertEqual(evidence?.ref, `${SAMPLE_FILE}#sha256:${imported.fileSha256}`, `节点 ${node.id} 证据应含文件名与指纹`);
    }
    /* 结构节点不参与"待确认"，但同样必须带来源（否则没法回答"这个章节从哪来"） */
    const section = Object.values(doc.nodes as Record<NodeId, DocNode>).find((node) => node.type === 'section');
    assertEqual(section?.provenance?.origin, 'imported', '章节节点也应带来源');
  });

  await test('C2 导入件是新草稿：不继承任何签章状态，且给出人工核对提示与来源档案', async () => {
    const imported = importWst500(readSample());
    const { doc, reviewNotes } = buildWst500Draft(imported, { docId: 'doc_ws_draft', actorId: 'DR_T', fileName: SAMPLE_FILE, importedAt: '2026-10-08T10:35:00Z' });
    assertEqual(doc.status, 'draft', '导入件必须是草稿');
    assertEqual(doc.signatureRefs, undefined, '导入件不得带任何签章引用');
    assertEqual(doc.docType.system, 'WST500', '文档类型体系应为 WST500');
    assert(reviewNotes.length >= 3, `应给出多条人工核对提示，实际 ${reviewNotes.length} 条`);
    assert(reviewNotes.some((line) => line.includes('人工逐项核对')), '应明确要求人工核对');

    const source = doc.extensions?.['import.source'] as Record<string, unknown>;
    assertEqual(source.format, 'wst500', '来源档案应记录格式');
    assertEqual(source.signed, false, '来源档案应声明 XML 不承载签章');
    assertEqual(source.fields, EXPECT.fieldCount, '来源档案应记录数据元数');
    assertEqual(source.skippedEntries, EXPECT.skippedEntries, '来源档案应记录跳过条目数');
    assertEqual(doc.machineReadable !== undefined, true, '导入后应生成机读信息');
  });

  await test('C3 与签章门控联动：未逐项确认不得签章，确认后放行', async () => {
    const imported = importWst500(readSample());
    const { doc } = buildWst500Draft(imported, { docId: 'doc_ws_gate', actorId: 'DR_T', fileName: SAMPLE_FILE, importedAt: '2026-10-08T10:35:00Z' });
    const session = WriteSession.open(doc);

    assertEqual(session.machineReadableStatus().stale, false, '刚导入的机读信息应为新鲜');
    assertEqual(await codeOfAsync(() => session.sign({}, HUMAN)), 'E_IMPORTED_UNCONFIRMED', '未确认的导入内容必须拦住签章');

    for (const node of Object.values(session.document.nodes as Record<NodeId, DocNode>)) {
      if (node.type === 'text' || node.type === 'field') session.confirmNode({ nodeId: node.id }, HUMAN);
    }
    assertEqual(await codeOfAsync(() => session.sign({}, HUMAN)), 'OK', '逐项确认后应可签章');
    assertEqual(session.document.status, 'signed', '状态应为已签章');
  });

  await test('C4 导入后机读信息与正文一致：数据元可反查，且签章时会重算', async () => {
    const imported = importWst500(readSample());
    const { doc } = buildWst500Draft(imported, { docId: 'doc_ws_machine', actorId: 'DR_T', fileName: SAMPLE_FILE, importedAt: '2026-10-08T10:35:00Z' });
    const session = WriteSession.open(doc);
    const elements = session.document.machineReadable?.dataElements ?? [];
    assertEqual(elements.length, EXPECT.fieldCount, '机读数据元数应与导入的字段数一致');
    const temp = elements.find((element) => element.tag.code === EXPECT.temperature.code);
    assertEqual(temp?.valueText, EXPECT.temperature.valueText, '机读值应与导入的体温一致');
    assertEqual(temp?.origin, 'imported', '机读数据元应保留来源');
  });

  /* ========================= D 反例层 ========================= */

  await test('D1 非 ClinicalDocument 的 XML：明确报错，不返回半成品', async () => {
    assertEqual(codeOf(() => importWst500(enc('<?xml version="1.0"?><Note><text>x</text></Note>'))), 'E_IMPORT_FAILED', '非临床文档必须报错');
    let message = '';
    try {
      importWst500(enc('<Note/>'));
    } catch (err) {
      message = (err as Error).message;
    }
    assert(message.includes('ClinicalDocument'), `错误信息应点明缺什么，实际：${message}`);
    assert(new ImportError('x') instanceof ImportError, 'ImportError 应可实例化');
  });

  await test('D2 空输入与纯文本：报错而不是崩溃', async () => {
    assertEqual(codeOf(() => importWst500(enc(''))), 'E_IMPORT_FAILED', '空输入应报错');
    assertEqual(codeOf(() => importWst500(enc('患者姓名,年龄'))), 'E_IMPORT_FAILED', '纯文本应报错');
  });

  await test('D3 只有文档头、没有结构化正文：可导入，但明确声明"没有正文"（不假装有内容）', async () => {
    const imported = importWst500(enc(WST500_HEADER_ONLY_XML));
    assertEqual(imported.hasStructuredBody, false, '应识别出没有结构化正文');
    assertEqual(imported.stats.sections, 0, '不应凭空生成章节');
    assertEqual(imported.stats.fields, 0, '不应凭空生成数据元');
    assert(imported.warnings.some((line) => line.includes('没有结构化正文')), '必须明确警告缺少正文');

    const { doc, reviewNotes } = buildWst500Draft(imported, { docId: 'doc_ws_header_only', actorId: 'DR_T', fileName: 'header-only.xml', importedAt: '2026-10-08T10:35:00Z' });
    assert(reviewNotes.some((line) => line.includes('正文需人工录入')), '核对提示应说明正文需人工录入');
    const sectionCount = Object.values(doc.nodes as Record<NodeId, DocNode>).filter((node) => node.type === 'section').length;
    assertEqual(sectionCount, 0, '导入件里不应出现空章节');
  });

  await test('D4 导入草稿必须通过模型校验（自己产出的文档不能是非法文档）', async () => {
    const imported = importWst500(readSample());
    const { doc } = buildWst500Draft(imported, { docId: 'doc_ws_valid', actorId: 'DR_T', fileName: SAMPLE_FILE, importedAt: '2026-10-08T10:35:00Z' });
    assertEqual(errorsOf(validateDocument(doc)), [], '导入草稿应无校验错误');
  });

  /* ========================= E 黄金样例 ========================= */

  await test('E1 样例落盘 → 读回导入 → 与人工核对的期望逐项一致（自产自验）', async () => {
    ensureArtifacts();
    const file = join(ARTIFACTS, SAMPLE_FILE);
    writeFileSync(file, WST500_SAMPLE_XML, 'utf8');
    assert(existsSync(file), `应写出 ${SAMPLE_FILE}`);

    const imported = importWst500(readFileSync(file));
    assertEqual(imported.format, 'wst500', '格式应为 wst500');
    assertEqual(
      imported.stats,
      {
        sections: EXPECT.sectionCount,
        paragraphs: EXPECT.paragraphCount,
        fields: EXPECT.fieldCount,
        textChars: imported.stats.textChars,
        skippedEntries: EXPECT.skippedEntries,
        /* 新增统计项也必须进黄金期望：否则"深层嵌套/编码型取值"的回归会被漏掉 */
        nestedFields: EXPECT.nestedFields,
        codedValues: EXPECT.codedValues,
        depthTruncated: EXPECT.depthTruncated,
      },
      '统计结果应与黄金期望一致',
    );
    assertEqual(imported.sections.map((section) => section.title), EXPECT.topLevelTitles, '章节标题应与黄金期望一致');

    const any = importAnyDocument(readFileSync(file), SAMPLE_FILE);
    assertEqual(any.kind, 'wst500', '统一入口应识别为 WS/T 500');
    assertEqual(describeAnyImport(any), `WS/T 500 导入（5 个章节，${EXPECT.paragraphCount} 段正文，${EXPECT.fieldCount} 条结构化数据元）`, '摘要口径应稳定（界面/日志依赖它）');
  });

  await test('E2 幂等：同一文件两次导入，结构与指纹完全一致', async () => {
    const bytes = readSample();
    const first = importWst500(bytes);
    const second = importWst500(bytes);
    assertEqual(JSON.stringify(second), JSON.stringify(first), '两次解析结果应完全一致');

    const meta = { docId: 'doc_ws_idem', actorId: 'DR_T', fileName: SAMPLE_FILE, importedAt: '2026-10-08T10:35:00Z' };
    const a = buildWst500Draft(first, meta).doc;
    const b = buildWst500Draft(second, meta).doc;
    assertEqual(Object.keys(b.nodes as Record<NodeId, DocNode>).sort(), Object.keys(a.nodes as Record<NodeId, DocNode>).sort(), '节点 id 集合应一致');
    assertEqual(b.machineReadable?.sourceHash, a.machineReadable?.sourceHash, '机读指纹应一致');
  });

  process.exit(suite.report());
}

await main();
