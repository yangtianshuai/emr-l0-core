/**
 * 外部真实样例回归：HL7 C-CDA 官方 IG 的入院诊断章节。
 *
 *   node src/import/external-sample-self-test.ts
 *
 * 为什么单独一个套件：
 *   其余用例的样例都是**我们自己写的**（自产自验）—— 自产自验只能证明"内部一致"，
 *   证明不了"能读懂别人的文件"。这个套件用一份**外部权威样例**（HL7 C-CDA IG 仓库
 *   的 input/examples/admission-diagnosis-section-example.xml）把解析器钉在真实结构上。
 *
 * 这份样例一进来就暴露了两个真缺陷（已修，见下方用例）：
 *   ① 数据元藏在 `entry → act → entryRelationship → observation` 里 —— 只扫直接子层级会整批丢；
 *   ② 取值是编码型 `<value xsi:type="CD" code="233604007" displayName="Pneumonia"/>` ——
 *      只读 `@value`/元素文本会把它判成"没有取值"而**静默跳过**（丢的是诊断！）。
 *
 * 样例来源与许可：HL7 CDACCDA 规范仓库（github.com/HL7/CDA-ccda），
 * 经 GitHub Contents API 取回（本机对 raw.githubusercontent.com 不可达）。
 * 它是 **section 片段**（不是完整文档），这就是为什么 A2 用例要求"片段必须被明确拒绝"。
 * 该样例为规范自带示例（虚构患者数据），仅用于本地解析器回归。
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TestSuite, assert, assertEqual } from '../testing/harness.ts';
import { importAnyDocument } from './import-any.ts';
import { buildWst500Draft, importWst500 } from './wst500-import.ts';

const SAMPLE = fileURLToPath(new URL('../../artifacts/external/hl7-ccda-admission-diagnosis-section.xml', import.meta.url));

/** 逐字节锁死样例：文件被替换/改动时立刻可见（否则"回归通过"可能是在验另一份文件） */
const EXPECT_SHA256 = 'ae1e219b42f47286bc8280952a274539c76df262d991b7c8333f6bfbb9c4ac38';
const EXPECT_SIZE = 1746;

const suite = new TestSuite('外部样例回归：HL7 C-CDA 入院诊断章节', [
  '说明：这份样例来自外部规范仓库，用来验证"能读懂别人的文件"，而不是自产自验。',
  '它是 section 片段：因此必须被明确拒绝（A2），包装成文档后各结构必须逐项还原（A3~A9）。',
]);

const test = (name: string, fn: () => void | Promise<void>): Promise<void> => suite.test(name, fn);

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);

/** 把外部片段包进最小文档骨架（保留片段原文，不改写任何标签） */
function wrap(sectionXml: string): Uint8Array {
  return enc(
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<ClinicalDocument xmlns="urn:hl7-org:v3" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
      '  <id root="urn:l0:external" extension="EXT-1"/>',
      '  <code code="11488-4" codeSystem="2.16.840.1.113883.6.1" displayName="会诊记录"/>',
      '  <title>外部样例包装</title>',
      '  <effectiveTime value="20260808120000"/>',
      '  <recordTarget><patientRole><id extension="P_EXT"/><patient>',
      '    <name>张三</name><administrativeGenderCode code="1" displayName="男"/>',
      '    <birthTime value="19800506"/></patient></patientRole></recordTarget>',
      '  <component><structuredBody><component>',
      ...sectionXml.split('\n').map((line) => `  ${line}`),
      '  </component></structuredBody></component>',
      '</ClinicalDocument>',
      '',
    ].join('\n'),
  );
}

function sampleBytes(): Uint8Array {
  try {
    return readFileSync(SAMPLE);
  } catch (err) {
    throw new Error(
      `外部样例缺失（${SAMPLE}）：请从 github.com/HL7/CDA-ccda 的 input/examples/admission-diagnosis-section-example.xml 重新取回 —— ` +
        `缺失时不允许"跳过"，否则"外部样例回归"会变成空跑。原始错误：${(err as Error).message}`,
    );
  }
}

async function main(): Promise<void> {
  await test('A1 样例文件本身：大小与 SHA-256 与记录一致（防替换、防误改）', () => {
    const bytes = sampleBytes();
    assertEqual(bytes.length, EXPECT_SIZE, '样例大小应与记录一致');
    assertEqual(createHash('sha256').update(bytes).digest('hex'), EXPECT_SHA256, '样例 SHA-256 应与记录一致');
    assertEqual(new TextDecoder().decode(bytes.subarray(0, 30)).startsWith('<section'), true, '样例应是 section 片段');
  });

  await test('A2 片段输入必须被**明确拒绝**，且错误信息说清"缺什么"（不是崩溃、不是静默空文档）', () => {
    let code = 'OK';
    let message = '';
    try {
      importAnyDocument(sampleBytes(), 'admission-diagnosis-section-example.xml');
    } catch (err) {
      code = (err as { code?: string }).code ?? 'UNKNOWN';
      message = (err as Error).message;
    }
    assertEqual(code, 'E_IMPORT_FAILED', '片段不是完整文档，必须报导入失败');
    assert(message.includes('ClinicalDocument'), `错误信息应指出缺少 ClinicalDocument 根，实际：${message}`);
    assert(message.includes('admission-diagnosis-section-example.xml'), '错误信息应带上文件名（现场排查需要）');
  });

  await test('A3 包装成文档后：按内容识别为 WS/T 500，章节标题与叙述文本正确', () => {
    const parsed = importAnyDocument(wrap(new TextDecoder().decode(sampleBytes())), 'hl7-ccda-wrapped.xml') as unknown as { kind: string };
    assertEqual(parsed.kind, 'wst500', '根元素是 ClinicalDocument，应按 wst500 识别');

    const result = importWst500(wrap(new TextDecoder().decode(sampleBytes())));
    assertEqual(result.stats.sections, 1, '样例只有一个章节');
    assertEqual(result.sections[0]!.title, 'HOSPITAL ADMISSION DIAGNOSIS', '章节标题应取自 <title>');
    assertEqual(result.sections[0]!.paragraphs, ['Appendicitis'], '叙述文本应取自 <text>');
    assertEqual(result.sections[0]!.code, '46241-6', '章节编码应保留（LOINC）');
  });

  await test('A4 深层嵌套必须还原：数据元在 entry→act→entryRelationship→observation（第 2 层）', () => {
    const result = importWst500(wrap(new TextDecoder().decode(sampleBytes())));
    assertEqual(result.stats.fields, 1, '这一条诊断必须被提取出来（早期实现只扫直接子层级 → 0 条）');
    assertEqual(result.stats.nestedFields, 1, '它应被登记为"来自深层嵌套"');
    assertEqual(result.stats.skippedEntries, 0, '容器 act 没有取值是正常的，不得计入"跳过"（那会掩盖真正的丢数据）');
    assertEqual(result.stats.depthTruncated, 0, '两层嵌套不应触发深度上限');
    const field = result.sections[0]!.fields[0]!;
    assertEqual(field.nestingDepth, 2, '层级应如实记录为第 2 层');
    assertEqual(field.sourceElement, 'observation', '承载元素应记录为 observation');
    assert(
      result.warnings.some((text) => text.includes('深层嵌套') && text.includes('已按容器关系下钻还原')),
      '必须在报告里说明"深层嵌套已还原多少条"',
    );
  });

  await test('A5 编码型取值必须读出人类可读文本**与**机器编码（早期实现整条判为"无取值"）', () => {
    const result = importWst500(wrap(new TextDecoder().decode(sampleBytes())));
    const field = result.sections[0]!.fields[0]!;
    assertEqual(field.valueText, 'Pneumonia', '取值文本应取 @displayName（给人看的）');
    assertEqual(field.valueCode?.code, '233604007', '机器编码应取 @code（当时是 CD 类型）');
    assertEqual(field.valueCode?.codeSystem, '2.16.840.1.113883.6.96', '取值编码体系（SNOMED CT）应保留');
    assertEqual(result.stats.codedValues, 1, '应统计编码型取值条数');
    assert(
      result.warnings.some((text) => text.includes('编码型')),
      '编码型取值必须提示"人读文本与机器编码都保留、编码体系须核对"',
    );
  });

  await test('A6 标签体系不假装等价：SNOMED 归为 local，但源 OID 必须保留', () => {
    const result = importWst500(wrap(new TextDecoder().decode(sampleBytes())));
    const field = result.sections[0]!.fields[0]!;
    assertEqual(field.tag.code, '64572001', '标签编码应保留（SNOMED Disease）');
    assertEqual(field.tag.display, 'Disease', '标签显示名应保留');
    assertEqual(field.tag.system, 'local', '非 WS/T 500 根 OID 一律归为 local（不猜）');
    assertEqual(field.sourceCodeSystem, '2.16.840.1.113883.6.96', '源 codeSystem(OID) 必须保留供人工核对');
  });

  await test('A7 患者信息：姓名脱敏、性别映射、出生日期格式（外部文件同样不得落明文姓名）', () => {
    const result = importWst500(wrap(new TextDecoder().decode(sampleBytes())));
    assertEqual(result.patient?.nameMasked, '张*', '姓名必须脱敏（源文件是"张三"）');
    assertEqual(result.patient?.gender, 'M', 'administrativeGenderCode=1 应映射为 M');
    assertEqual(result.patient?.birthDate, '1980-05-06', 'birthTime 19800506 应转成 ISO 日期');
    assertEqual(result.patient?.patientId, 'P_EXT', '患者 id 应取自 patientRole/id@extension');
  });

  await test('A8 落地草稿：数据元成节点、证据链含取值编码与嵌套层级、全部标未确认', () => {
    const result = importWst500(wrap(new TextDecoder().decode(sampleBytes())));
    const { doc } = buildWst500Draft(result, {
      docId: 'doc_external',
      actorId: 'DR_EXT',
      fileName: 'hl7-ccda-wrapped.xml',
      importedAt: '2026-10-08T12:00:00Z',
    });
    const fields = Object.values(doc.nodes).filter((node) => node.type === 'field');
    assertEqual(fields.length, 1, '应落成一个数据元节点');
    assertEqual(fields[0]!.humanConfirmed, false, '外部内容一律未确认');
    assertEqual(fields[0]!.provenance?.origin, 'imported', '来源必须是 imported');

    const evidence = (fields[0]!.provenance?.evidence ?? []).map((item) => item.field ?? '');
    assert(
      evidence.some((text) => text.includes('valueCode:233604007') || text.includes('源取值编码=233604007')),
      `证据链应记录取值编码，实际：${JSON.stringify(evidence)}`,
    );
    assert(
      evidence.some((text) => text.includes('第 2 层嵌套')),
      `证据链应记录嵌套层级（可回答"这条是从文档哪层挖出来的"），实际：${JSON.stringify(evidence)}`,
    );
    assertEqual(doc.status, 'draft', '导入件必须是草稿');
    assertEqual(doc.signatureRefs, undefined, '不得继承任何签章');
  });

  await test('A9 幂等：同一份外部样例两次解析结果完全一致（可复现）', () => {
    const bytes = wrap(new TextDecoder().decode(sampleBytes()));
    assertEqual(JSON.stringify(importWst500(bytes)), JSON.stringify(importWst500(bytes)), '两次解析应完全一致');
  });

  process.exit(suite.report());
}

await main();
