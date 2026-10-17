/**
 * T27 验收自测：WS/T 500（电子病历共享文档）XML 导出。
 *
 *   node src/export/wst500-export-self-test.ts
 *
 * 覆盖五层：
 *   A 头部结构（根元素/命名空间/文书类型/时间/患者，含性别与日期的编码映射）
 *   B 章节与内容（嵌套章节、叙述文本、entry/observation、**不编造缺失的编码**）
 *   C 纪律（姓名只写掩码、AI 参与度随文档走、标签体系 OID 可注入、XML 转义）
 *   D **闭环**：导出 → 导入 → 逐项一致；再导出 → 结构幂等
 *   E 确定性与边界
 *
 * 本模块的验收标准不是"生成了 XML"，而是**对方系统读回来之后内容一致**：
 * 只测"XML 长得像"是自欺 —— 标签、单位、层级、来源，任何一个对不上都意味着交换失败。
 */

import { TestSuite, assert, assertEqual } from '../testing/harness.ts';
import { buildSyntheticDoc } from '../testing/synthetic.ts';
import type { DocNode, DocumentModel, FieldNode, SectionNode } from '../model/types.ts';
import { buildWst500Xml } from './wst500.ts';
import { buildWst500Draft, importWst500, type Wst500Section } from '../import/wst500-import.ts';

const suite = new TestSuite('T27 WS/T 500 导出自测', [
  '说明：D 组是"导出 → 导入 → 再导出"闭环，要求结构与内容逐项一致（幂等）。',
  '映射是"最小可用"的：不编造标准编码，标签体系 OID 必须可注入覆盖。',
]);

const test = (name: string, fn: () => void | Promise<void>): Promise<void> => suite.test(name, fn);

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);

/** 夹具：两节（一节带 sectionCode、一节不带）、段落文本各不相同、一个 AI 来源字段 */
function fixture(): DocumentModel {
  const { doc } = buildSyntheticDoc({ sections: 2, paragraphsPerSection: 2, fieldsPerParagraph: 2 });
  doc.patient = { patientId: 'P_WS_001', nameMasked: '王**', gender: 'M', birthDate: '1990-03-12' };
  doc.docType = { system: 'WST500', code: 'WST500.01.001', display: '门（急）诊病历' };

  const sections = (Object.values(doc.nodes) as DocNode[]).filter((node): node is SectionNode => node.type === 'section');
  if (sections[0]) sections[0].sectionCode = 'WST500.2.001';
  if (sections[0]) sections[0].title = '主诉';
  if (sections[1]) {
    sections[1].title = '现病史';
    /* 合成文档会自动给 section 一个 sectionCode（sec2）：这里显式删掉，
       用于验证"没有编码时不写 code 元素"这条纪律 */
    delete sections[1].sectionCode;
  }

  let index = 0;
  for (const node of Object.values(doc.nodes) as DocNode[]) {
    if (node.type !== 'text') continue;
    index += 1;
    node.runs = [{ text: `第${index}段正文：${'内容描述'.repeat(6)}` }];
  }

  const fields = (Object.values(doc.nodes) as DocNode[]).filter((node): node is FieldNode => node.type === 'field');
  const aiField = fields[0];
  if (aiField) {
    aiField.tags = [{ system: 'WST500', code: 'DE04.01.068', display: '体温' }];
    aiField.dataType = 'number';
    aiField.value = 38.5;
    aiField.valueText = '38.5';
    aiField.unit = '℃';
    aiField.provenance = {
      origin: 'ai',
      modelId: 'local/qwen-med:7b@2026-09',
      confidence: 0.93,
      acceptedBy: 'DR_ACCEPT',
      acceptedAt: doc.updatedAt,
      at: doc.updatedAt,
    };
  }
  const secondField = fields[1];
  if (secondField) {
    secondField.tags = [{ system: 'LOINC', code: 'WBC', display: '白细胞计数' }];
    secondField.dataType = 'text';
    secondField.value = '12.6';
    secondField.valueText = '12.6';
    secondField.unit = '10^9/L';
    secondField.provenance = { origin: 'human', actorId: 'DR_X', at: doc.updatedAt };
  }
  return doc;
}

function flatten(sections: Wst500Section[]): Wst500Section[] {
  return sections.flatMap((section) => [section, ...flatten(section.children)]);
}

async function main(): Promise<void> {
  /* ============================ A 头部结构 ============================ */

  await test('A1 头部：根元素与命名空间、文书 id/code/title、effectiveTime 为 CDA 格式', () => {
    const { xml } = buildWst500Xml(fixture());
    assert(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'), 'XML 声明必须以 UTF-8 开头');
    assert(xml.includes('<ClinicalDocument xmlns="urn:hl7-org:v3"'), '根元素与命名空间必须是 CDA 风格');
    assert(xml.includes('xmlns:l0="urn:l0:emr"'), '必须声明扩展命名空间（l0: 前缀用于来源与置信度）');
    assert(/<id root="urn:l0:doc" extension="doc_/.test(xml), '文书 id 应带扩展名（本方 docId）');
    assert(xml.includes('codeSystem="urn:l0:docType"'), '文书类型默认用本方命名空间（不冒充标准编码）');
    assert(/<effectiveTime value="\d{14}"\/>/.test(xml), 'effectiveTime 必须是 yyyymmddhhmmss');
  });

  await test('A2 患者：id / 性别编码映射 / 出生日期格式（M→1 男、F→2 女、U→9）', () => {
    const male = buildWst500Xml(fixture()).xml;
    assert(male.includes('<id extension="P_WS_001"/>'), '患者 id 应写入 patientRole');
    assert(male.includes('<administrativeGenderCode code="1" displayName="男"/>'), 'M 应映射为 code=1/男');
    assert(male.includes('<birthTime value="19900312"/>'), '出生日期应转为 yyyymmdd');

    const { doc } = buildSyntheticDoc({ sections: 1, paragraphsPerSection: 1, fieldsPerParagraph: 1 });
    doc.patient = { patientId: 'P_F', nameMasked: '李**', gender: 'F' };
    doc.docType = { system: 'WST500', code: 'X', display: 'X' };
    assert(buildWst500Xml(doc).xml.includes('code="2" displayName="女"'), 'F 应映射为 code=2/女');
    doc.patient = { patientId: 'P_U', gender: 'U' };
    assert(buildWst500Xml(doc).xml.includes('code="9" displayName="未说明"'), 'U 应映射为 code=9/未说明');
    assert(!buildWst500Xml(doc).xml.includes('<birthTime'), '没有出生日期时不得凭空写 birthTime');
  });

  /* ============================ B 章节与内容 ============================ */

  await test('B1 章节树：顶层 section 写在 structuredBody 下，嵌套章节用 component/section', () => {
    const { doc } = buildSyntheticDoc({ sections: 2, paragraphsPerSection: 2, fieldsPerParagraph: 1 });
    doc.docType = { system: 'WST500', code: 'X', display: 'X' };
    const sections = (Object.values(doc.nodes) as DocNode[]).filter((node): node is SectionNode => node.type === 'section');
    /* 造一个嵌套子章节：把第 2 个 section 挂到第 1 个下面 */
    if (sections[0] && sections[1]) sections[1].parentId = sections[0].id;

    const { xml, stats } = buildWst500Xml(doc);
    assert(xml.includes('<structuredBody>'), '必须写 structuredBody');
    /* 嵌套层级：section → component → section */
    assert(/<section>[\s\S]*<component>\s*<section>/.test(xml), '嵌套子章节必须用 component 包裹');
    assertEqual(stats.sections, 2, '两个 section 都应导出');
  });

  await test('B2 叙述文本：段落写成 section/text/paragraph（可被方系统直接渲染）', () => {
    const { xml, stats } = buildWst500Xml(fixture());
    assert(xml.includes('<text>'), '应有叙述文本块');
    assert(/<paragraph>[^<]+<\/paragraph>/.test(xml), '段落必须写成 paragraph 元素');
    assertEqual(stats.paragraphs, 4, '夹具应有 4 个正文段落');
    assert(stats.textChars > 100, '文本字符数应被统计');
  });

  await test('B3 结构化数据：entry/observation 带 code/codeSystem/displayName 与值/单位', () => {
    const { xml, stats } = buildWst500Xml(fixture());
    assert(xml.includes('<observation classCode="OBS" moodCode="EVN">'), '数据元应写成 observation');
    assert(xml.includes('<code code="DE04.01.068" codeSystem="2.16.156.10011.2.1.1.4" displayName="体温"/>'), '标签应带 code/codeSystem/displayName');
    assert(xml.includes('<value xsi:type="PQ" value="38.5" unit="℃"/>'), '数值型应写成 PQ（带单位）');
    assert(xml.includes('<code code="WBC" codeSystem="2.16.840.1.113883.6.1" displayName="白细胞计数"/>'), 'LOINC 应映射到 HL7 注册的 OID');
    /* 夹具：2 节 × 2 段 × 2 字段 = 8 个结构化数据元 */
    assertEqual(stats.fields, 8, '夹具应有 8 个结构化数据元');
  });

  await test('B4 不编造编码：没有 sectionCode 的章节**不写 code 元素**', () => {
    const { xml } = buildWst500Xml(fixture());
    const sectionBlocks = xml.split('<section>').slice(1);
    assertEqual(sectionBlocks.length, 2, '应有两个章节');
    assert(sectionBlocks[0]!.includes('<code code="WST500.2.001"'), '带 sectionCode 的章节应写 code');
    /* 断言"章节的第一个子元素不是 code"（不能用整块 includes —— 章节里的 observation 也有 code） */
    assert(
      sectionBlocks[1]!.trimStart().startsWith('<title>'),
      `没有 sectionCode 的章节不得写 section 级 code（宁可缺元素，不糊假编码），实际开头：${sectionBlocks[1]!.trimStart().slice(0, 40)}`,
    );
  });

  await test('B5 段落下的字段也要进 entry（不许只在叙述文本里留一句话）', () => {
    const { doc } = buildSyntheticDoc({ sections: 1, paragraphsPerSection: 1, fieldsPerParagraph: 1 });
    doc.docType = { system: 'WST500', code: 'X', display: 'X' };
    const paragraph = (Object.values(doc.nodes) as DocNode[]).find((node) => node.type === 'paragraph');
    const field = (Object.values(doc.nodes) as DocNode[]).find((node): node is FieldNode => node.type === 'field');
    assert(!!paragraph && !!field, '前置：夹具应有段落与字段');
    field.parentId = paragraph!.id; // 把字段挂到段落下面
    field.tags = [{ system: 'WST500', code: 'DE_TEST', display: '测试项' }];

    const { stats, xml } = buildWst500Xml(doc);
    assertEqual(stats.fields, 1, '挂在段落下的字段也必须被收集');
    assert(xml.includes('DE_TEST'), '字段编码必须出现在 entry 中');
  });

  await test('B6 AI 参与度随文档走：observation 带 author 与置信度（跨系统不断链）', () => {
    const { xml, stats } = buildWst500Xml(fixture());
    assertEqual(stats.aiFields, 1, '应有一个 AI 字段被统计');
    assert(xml.includes('<id extension="ai:local/qwen-med:7b@2026-09"/>'), 'AI 模型标识必须写进 author');
    assert(xml.includes('<l0:confidence value="0.93"/>'), 'AI 置信度必须写进文档');
    assert(xml.includes('<l0:acceptedBy extension="DR_ACCEPT"/>'), '采纳人应随文档保留');
  });

  /* ============================== C 纪律 ============================== */

  await test('C1 姓名只写掩码：导出不得包含明文姓名（模型里没有明文，也不许从别处补）', () => {
    const { xml } = buildWst500Xml(fixture());
    assert(xml.includes('<name>王**</name>'), '姓名应写掩码');
    assert(!/[^\u4e00-\u9fa5\*<]王[\u4e00-\u9fa5]{1,2}<\/(?:name)?/.test(xml), '不得出现完整中文姓名');
  });

  await test('C2 标签体系 OID 可注入覆盖；未映射体系必须显式落到 urn:l0:tag:unmapped', () => {
    const { doc } = buildSyntheticDoc({ sections: 1, paragraphsPerSection: 1, fieldsPerParagraph: 1 });
    doc.docType = { system: 'WST500', code: 'X', display: 'X' };
    const field = (Object.values(doc.nodes) as DocNode[]).find((node): node is FieldNode => node.type === 'field');
    field!.tags = [{ system: 'custom', code: 'C1', display: '自定义项' }];

    assert(buildWst500Xml(doc).xml.includes('codeSystem="urn:l0:tag:custom"'), '默认表应覆盖 custom');
    const overridden = buildWst500Xml(doc, { tagSystemOids: { custom: '1.2.3.4.5' } }).xml;
    assert(overridden.includes('codeSystem="1.2.3.4.5"'), '注入的映射必须生效（院方字典可覆盖）');

    /* 未映射的体系：显式落 unmapped，而不是悄悄用别的 OID */
    const unknown = { ...doc, nodes: { ...doc.nodes } } as DocumentModel;
    const unknownField = (Object.values(unknown.nodes) as DocNode[]).find((node): node is FieldNode => node.type === 'field');
    unknownField!.tags = [{ system: 'WS445', code: 'X', display: 'X' }];
    const result = buildWst500Xml(unknown, { tagSystemOids: {} });
    assertEqual(result.warnings.some((text) => text.includes('需按院方字典核对')), true, '必须警告 OID 映射需院方核对');
  });

  await test('C3 XML 转义与非法字符剔除（否则第三方解析器会直接失败）', () => {
    const { doc } = buildSyntheticDoc({ sections: 1, paragraphsPerSection: 1, fieldsPerParagraph: 1 });
    doc.docType = { system: 'WST500', code: 'X', display: 'X' };
    const text = (Object.values(doc.nodes) as DocNode[]).find((node) => node.type === 'text');
    text!.runs = [{ text: 'A&B <标签> "引号" 控制字符\u0001结束' }];

    const { xml } = buildWst500Xml(doc);
    assert(xml.includes('A&amp;B &lt;标签&gt; &quot;引号&quot;'), '特殊字符必须转义');
    assert(!xml.includes('\u0001'), 'XML 1.0 非法控制字符必须剔除');
    assert(importWst500(enc(xml)).stats.paragraphs === 1, '转义后的 XML 必须能被正常解析回来');
  });

  await test('C4 非草稿状态必须提示"共享文档不承载签章"（避免误以为签章随文档走）', () => {
    const doc = fixture();
    doc.status = 'signed';
    const { warnings } = buildWst500Xml(doc);
    assert(warnings.some((text) => text.includes('不承载签章')), '已签章文档必须提示签章效力不在共享文档上');
    assert(warnings.some((text) => text.includes('符合性声明')), '必须声明"不构成符合性声明"');
  });

  /* ============================== D 闭环 ============================== */

  await test('D1 闭环：导出 → 导入，章节数/标题/层级/段落数/字段数逐项一致', () => {
    const doc = fixture();
    const before = buildWst500Xml(doc).stats;
    const back = importWst500(enc(buildWst500Xml(doc).xml));

    assertEqual(back.stats.sections, before.sections, '章节数应一致');
    assertEqual(back.stats.paragraphs, before.paragraphs, '段落数应一致');
    assertEqual(back.stats.fields, before.fields, '字段数应一致');
    const titles = flatten(back.sections).map((section) => section.title);
    assertEqual(titles, ['主诉', '现病史'], '章节标题与顺序应一致');
    assertEqual(back.sections[0]!.code, 'WST500.2.001', '章节编码应保留');
    assertEqual(back.sections[1]!.code, undefined, '没有编码的章节，回导后仍不应有编码（不许凭空补）');
  });

  await test('D2 闭环：值/单位/标签/患者/文书类型逐项一致', () => {
    const doc = fixture();
    const back = importWst500(enc(buildWst500Xml(doc).xml));
    const fields = flatten(back.sections).flatMap((section) => section.fields);
    const temp = fields.find((field) => field.tag.code === 'DE04.01.068');
    assert(!!temp, '体温数据元应能回导');
    assertEqual(temp!.valueText, '38.5', '取值应一致');
    assertEqual(temp!.unit, '℃', '单位应一致');
    assertEqual(temp!.dataType, 'number', '类型应一致');
    assertEqual(temp!.tag.system, 'WST500', '标签体系应一致');
    assertEqual(temp!.sourceCodeSystem, '2.16.156.10011.2.1.1.4', 'codeSystem(OID) 应一致');
    assertEqual(temp!.modelId, 'local/qwen-med:7b@2026-09', 'AI 模型标识应回导（AI 参与度不断链）');
    assertEqual(temp!.confidence, 0.93, 'AI 置信度应回导');
    assertEqual(temp!.acceptedBy, 'DR_ACCEPT', '采纳人应回导');

    assertEqual(back.patient?.patientId, 'P_WS_001', '患者 id 应一致');
    assertEqual(back.patient?.nameMasked, '王**', '姓名掩码应一致');
    assertEqual(back.patient?.gender, 'M', '性别应经 code/displayName 映射回 M');
    assertEqual(back.patient?.birthDate, '1990-03-12', '出生日期应映射回 ISO');
    assertEqual(back.document.code, 'WST500.01.001', '文书类型编码应一致');
    assertEqual(back.document.display, '门（急）诊病历', '文书类型显示名应一致');
  });

  await test('D3 闭环幂等：导出 → 导入 → 再导出，两次解析出的结构完全一致', () => {
    const doc = fixture();
    const first = buildWst500Xml(doc).xml;
    const imported = importWst500(enc(first));
    const rebuilt = buildWst500Draft(imported, {
      docId: 'doc_roundtrip',
      actorId: 'DR_RT',
      fileName: 'roundtrip.xml',
      importedAt: '2026-10-08T10:00:00Z',
    }).doc;
    const second = buildWst500Xml(rebuilt).xml;

    assertEqual(
      JSON.stringify(importWst500(enc(second)).sections),
      JSON.stringify(imported.sections),
      '第二轮导出后解析出的章节结构必须与第一轮一致（幂等）',
    );
    assertEqual(
      buildWst500Xml(rebuilt).stats.fields,
      buildWst500Xml(doc).stats.fields,
      '字段数应保持不变（交换不会丢数据元）',
    );
  });

  await test('D4 闭环纪律：回导内容一律"未确认 + imported 来源"（不继承源系统的确认与签章）', () => {
    const doc = fixture();
    doc.status = 'signed';
    const imported = importWst500(enc(buildWst500Xml(doc).xml));
    const { doc: draft } = buildWst500Draft(imported, {
      docId: 'doc_draft',
      actorId: 'DR_RT',
      fileName: 'roundtrip.xml',
      importedAt: '2026-10-08T10:00:00Z',
    });
    assertEqual(draft.status, 'draft', '回导件必须是草稿');
    assertEqual(draft.signatureRefs, undefined, '不得继承任何签章引用');
    const contents = (Object.values(draft.nodes) as DocNode[]).filter((node) => node.type === 'text' || node.type === 'field');
    assertEqual(
      contents.every((node) => node.humanConfirmed === false && node.provenance?.origin === 'imported'),
      true,
      '回导内容必须全部标为"未确认 + imported"',
    );
    const aiField = contents.find((node) => (node.provenance?.derivedFrom?.modelId ?? '') !== '');
    assert(!!aiField, 'AI 生成信息应以 derivedFrom 形式保留（参与度保留、责任不被继承）');
    assertEqual(aiField!.provenance?.derivedFrom?.confidence, 0.93, 'derivedFrom 应保留置信度');
  });

  /* ========================= 确定性与边界 ========================= */

  await test('E1 确定性：同一文档两次导出字节完全一致', () => {
    const doc = fixture();
    assertEqual(buildWst500Xml(doc).xml, buildWst500Xml(doc).xml, '两次导出应完全一致');
  });

  await test('E2 无章节文档：仍产出合法结构并明确警告（不假装有正文）', () => {
    const { doc } = buildSyntheticDoc({ sections: 1, paragraphsPerSection: 1, fieldsPerParagraph: 1 });
    doc.docType = { system: 'WST500', code: 'X', display: 'X' };
    for (const node of Object.values(doc.nodes) as DocNode[]) if (node.type === 'section') delete (doc.nodes as Record<string, DocNode>)[node.id];

    const { xml, stats, warnings } = buildWst500Xml(doc);
    assert(xml.includes('</ClinicalDocument>'), '仍应是完整的临床文档');
    assertEqual(stats.sections, 0, '不应凭空产生章节');
    assert(warnings.some((text) => text.includes('没有章节')), '必须警告"无正文"');
    assertEqual(importWst500(enc(xml)).stats.sections, 0, '空文档回导后仍应为 0 章节');
  });

  await test('E3 值类型与空值：数字写 PQ、文本写 ST、空值不写 value 元素', () => {
    const { doc } = buildSyntheticDoc({ sections: 1, paragraphsPerSection: 1, fieldsPerParagraph: 3 });
    doc.docType = { system: 'WST500', code: 'X', display: 'X' };
    const fields = (Object.values(doc.nodes) as DocNode[]).filter((node): node is FieldNode => node.type === 'field');
    fields[0]!.tags = [{ system: 'WST500', code: 'N', display: '数值' }];
    fields[0]!.dataType = 'number';
    fields[0]!.valueText = '12.5';
    fields[0]!.value = 12.5;
    fields[1]!.tags = [{ system: 'WST500', code: 'T', display: '文本' }];
    fields[1]!.dataType = 'text';
    fields[1]!.valueText = '阳性';
    fields[1]!.value = '阳性';
    fields[2]!.tags = [{ system: 'WST500', code: 'E', display: '空值' }];
    fields[2]!.dataType = 'text';
    fields[2]!.valueText = '';
    fields[2]!.value = '';

    const { xml } = buildWst500Xml(doc);
    /* 注意断言要带 unit：原字段本身带单位，PQ 会一并写出（写死无 unit 的形态会误判） */
    assert(xml.includes('<value xsi:type="PQ" value="12.5" unit="℃"/>'), '数值应写 PQ（带单位）');
    assert(xml.includes('<value xsi:type="ST">阳性</value>'), '文本应写 ST');
    /* 空值不写 value：写 `<value xsi:type="ST"></value>` 会被对方读成"结果为空/阴性"。
       断言必须**切到该 observation 内部** —— 只看"其后 200 字符"会撞上后面数据元的 value。 */
    const emptyObservation = xml.slice(xml.indexOf('<code code="E"')).split('</observation>')[0] ?? '';
    assert(!emptyObservation.includes('<value'), '空值不得写出 value 元素（会被误读为"阴性/正常"）');
  });

  process.exit(suite.report());
}

await main();
