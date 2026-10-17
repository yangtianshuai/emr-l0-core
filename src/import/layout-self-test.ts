/**
 * T26 验收自测：版式段落重建（几何启发式）。
 *
 *   node src/import/layout-self-test.ts
 *
 * 覆盖四层：
 *   A 视觉行聚类与拼接（同行多片段、英文折行补空格、中文不补）
 *   B 分段线索（段前间距 / 首行缩进 / 字号）与确定性，含两个实测缺陷的回归用例
 *   C 降级与边界（无坐标、单行、空输入、跨页不合并、缺坐标行不丢文本）
 *   D **导出 → 导入闭环**：源文档的每个段落必须恰好落在重建后的一个段落里
 *
 * 核心断言是 D：段落重建如果没有闭环验证，就只是"看起来切得挺像"。
 */

import { TestSuite, assert, assertEqual } from '../testing/harness.ts';
import { WriteSession } from '../core/session.ts';
import { buildSyntheticDoc } from '../testing/synthetic.ts';
import type { DocNode, DocumentModel } from '../model/types.ts';
import { DEFAULT_LAYOUT } from '../export/ofd.ts';
import { buildImportedDraft, importOfd } from './ofd-import.ts';
import { joinLines, rebuildParagraphs, type LayoutLine } from './layout.ts';

const suite = new TestSuite('T26 版式段落重建自测', [
  '说明：D 组是"导出 → 导入"闭环，要求源文档的每个段落恰好落在重建后的一个段落里。',
  '重建是启发式的：每段都带判定依据与置信度，找不到线索时必须标 low 而不是"猜"。',
]);

const test = (name: string, fn: () => void | Promise<void>): Promise<void> => suite.test(name, fn);

const SIZE = 10.5;
const LINE = DEFAULT_LAYOUT.lineHeightPt;
const GAP = DEFAULT_LAYOUT.paragraphGapPt;
const MARGIN = DEFAULT_LAYOUT.marginPt;
const INDENT = DEFAULT_LAYOUT.firstLineIndentPt;
const PLAN = { layout: { textAsPath: false }, machineReadable: { signed: true, carrier: 'separate-xml' as const } };

function line(text: string, x: number, y: number, size = SIZE, page = 0): LayoutLine {
  return { page, text, x, y, size };
}

/** 构造"一段 N 行"的几何数据（首行缩进，续行回左边界） */
function paragraphLines(texts: string[], startY: number, options: { indent?: number } = {}): { lines: LayoutLine[]; endY: number } {
  const indent = options.indent ?? INDENT;
  const lines: LayoutLine[] = [];
  let y = startY;
  texts.forEach((text, index) => {
    lines.push(line(text, MARGIN + (index === 0 ? indent : 0), y));
    y += LINE;
  });
  return { lines, endY: y };
}

async function main(): Promise<void> {
  /* ========================= A 视觉行聚类与拼接 ========================= */

  await test('A1 同一视觉行：y 接近的片段按 x 排序合并（左标签 + 右数值）', async () => {
    const result = rebuildParagraphs([line('体温', MARGIN, 100), line('38.5 ℃', MARGIN + 60, 100)]);
    assertEqual(result.paragraphs.length, 1, '同一视觉行应合成一段');
    assertEqual(result.paragraphs[0]!.text, '体温 38.5 ℃', '应按 x 顺序拼接');
    assertEqual(result.paragraphs[0]!.lineCount, 1, '合成后仍计为 1 行');
  });

  await test('A2 行拼接：英文折行补空格、中文折行不补（避免插入脏空白）', async () => {
    assertEqual(joinLines('patient has', 'fever'), 'patient has fever', '英文折行应补空格');
    assertEqual(joinLines('患者3天前', '出现咳嗽'), '患者3天前出现咳嗽', '中文折行不得插入空格');
    assertEqual(joinLines('体温38.5', '℃'), '体温38.5℃', '数字与符号之间不补空格');
    assertEqual(joinLines('', '内容'), '内容', '空串拼接应返回原串');
  });

  await test('A3 等距同缩进的连续行：合并为一段并标 low（未发现线索 ≠ 确认这里是一段）', async () => {
    const result = rebuildParagraphs([
      line('第一行没有段落线索的文字', MARGIN, 100),
      line('第二行与上一行完全等距', MARGIN, 100 + LINE),
      line('第三行仍然等距且同缩进', MARGIN, 100 + LINE * 2),
    ]);
    assertEqual(result.paragraphs.length, 1, '无线索时应合并为一段');
    assertEqual(result.paragraphs[0]!.confidence, 'low', '无线索必须标 low（如实报告"这是兜底合并"）');
    assertEqual(result.paragraphs[0]!.lineCount, 3, '应记录合并行数');
    assert(
      result.paragraphs[0]!.evidence.some((item) => item.includes('未发现段落线索')),
      `证据应说明"未发现线索"，实际：${result.paragraphs[0]!.evidence.join('；')}`,
    );
  });

  /* ========================= B 分段线索 ========================= */

  await test('B1 段前间距：明显大于基准行距 → 切段，并给出间距依据', async () => {
    const first = paragraphLines(['第一段第一行', '第一段第二行'], 100);
    const second = paragraphLines(['第二段第一行', '第二段第二行'], first.endY + GAP);
    const result = rebuildParagraphs([...first.lines, ...second.lines]);
    assertEqual(result.paragraphs.length, 2, '应切成两段');
    assertEqual(result.paragraphs.map((paragraph) => paragraph.lineCount), [2, 2], '每段应各含 2 行');
    assert(
      result.paragraphs[1]!.evidence.some((item) => item.includes('段前间距')),
      `应给出间距依据，实际：${result.paragraphs[1]!.evidence.join('；')}`,
    );
  });

  await test('B2 首行缩进：超出段左边界 → 切段（独立线索，与间距无关）', async () => {
    const result = rebuildParagraphs([
      line('上一段收尾的一行', MARGIN, 100),
      line('这一段首行缩进明显', MARGIN + INDENT, 100 + LINE),
      line('该段续行回到左边界', MARGIN, 100 + LINE * 2),
    ]);
    assertEqual(result.paragraphs.length, 2, '缩进应触发切段');
    assert(
      result.paragraphs[1]!.evidence.some((item) => item.includes('首行缩进')),
      `应给出缩进依据，实际：${result.paragraphs[1]!.evidence.join('；')}`,
    );
    assertEqual(result.paragraphs[1]!.left, MARGIN, '段左边界应取段内最左位置（续行的 x）');
  });

  await test('B3 字号放大 → 标题（kind=title），且标题单独成段', async () => {
    const result = rebuildParagraphs([
      line('一、主诉', MARGIN, 100, SIZE + 2),
      line('发热3天，伴咳嗽。', MARGIN + INDENT, 100 + LINE * 1.5),
    ]);
    assertEqual(result.paragraphs.length, 2, '标题与正文应分开');
    assertEqual(result.paragraphs[0]!.kind, 'title', '字号更大且独占一行的应为标题');
    assertEqual(result.paragraphs[1]!.kind, 'body', '正文段 kind 应为 body');
  });

  await test('B4 两条独立线索一致 → 置信度 high（间距 + 缩进同时满足）', async () => {
    /* 每段两行才有"段左边界"（续行回左边界）；单行段没有左边界，缩进线索本就无从谈起 */
    const first = paragraphLines(['第一段首行', '第一段续行'], 100);
    const second = paragraphLines(['第二段首行', '第二段续行'], first.endY + GAP);
    const result = rebuildParagraphs([...first.lines, ...second.lines]);
    assertEqual(result.paragraphs.length, 2, '应切成两段');
    assertEqual(result.paragraphs[1]!.confidence, 'high', '两条线索一致应给 high');
    const kinds = result.paragraphs[1]!.evidence;
    assert(
      kinds.some((item) => item.includes('段前间距')) && kinds.some((item) => item.includes('首行缩进')),
      `证据应同时包含间距与缩进两类线索，实际：${kinds.join('；')}`,
    );
  });

  await test('B5 回归：行距与段间距次数相同时，不得因"中位数取到段间距"而漏切', async () => {
    /* 实测缺陷：gaps = [22,16,22,16,22,16] 的中位数是 22，阈值被抬到 22×1.35≈29.7，
       真正的段间距 22 反而不触发 → 整页被合并成一段。
       正确做法：按 0.5pt 分桶统计频次、并列取较小值来估计基准行距。 */
    const lines: LayoutLine[] = [];
    let y = 100;
    for (let index = 0; index < 3; index += 1) {
      lines.push(line(`第${index + 1}段第一行`, MARGIN + INDENT, y));
      lines.push(line(`第${index + 1}段第二行`, MARGIN, y + LINE));
      y += LINE * 2 + GAP;
    }
    const result = rebuildParagraphs(lines);
    assertEqual(result.paragraphs.length, 3, `应切成 3 段，实际 ${result.paragraphs.length} 段（基准行距估计错误会变成 1 段）`);
    assertEqual(result.paragraphs.map((paragraph) => paragraph.lineCount), [2, 2, 2], '每段应合并 2 行');
  });

  await test('B6 回归：段左边界取段内最左位置（首行缩进不能破坏后续缩进线索）', async () => {
    /* 实测缺陷：若以"段首行（缩进的 x）"为界，续行变成负缩进，
       下一段的首行相对它反而没有缩进，缩进线索彻底失效。 */
    const first = paragraphLines(['第一段首行', '第一段续行'], 100);
    const second = paragraphLines(['第二段首行', '第二段续行'], first.endY); // 不给段前间距，只靠缩进
    const result = rebuildParagraphs([...first.lines, ...second.lines]);
    assertEqual(result.paragraphs.length, 2, '仅靠缩进也必须能切段');
    assertEqual(result.paragraphs[0]!.left, MARGIN, '第一段左边界应为续行的 x');
    assertEqual(result.paragraphs[1]!.left, MARGIN, '第二段左边界同理');
  });

  await test('B7 确定性：同一输入两次重建结果完全一致（可复现）', async () => {
    const first = paragraphLines(['甲段第一行', '甲段第二行'], 100);
    const second = paragraphLines(['乙段第一行', '乙段第二行'], first.endY + GAP);
    const input = [...first.lines, ...second.lines];
    assertEqual(JSON.stringify(rebuildParagraphs(input)), JSON.stringify(rebuildParagraphs(input)), '两次重建应完全一致');
  });

  /* ========================= C 降级与边界 ========================= */

  await test('C1 无坐标信息：降级为"每页一段"，标 low 并明确警告（不假装切对了）', async () => {
    const result = rebuildParagraphs([
      { page: 0, text: '第一行' },
      { page: 0, text: '第二行' },
      { page: 1, text: '第二页第一行' },
    ]);
    assertEqual(result.strategy, 'fallback-per-page', '应使用按页降级策略');
    assertEqual(result.paragraphs.length, 2, '应按页分成 2 段');
    assertEqual(result.paragraphs[0]!.text, '第一行第二行', '同页文本应合并');
    assertEqual(result.paragraphs.every((paragraph) => paragraph.confidence === 'low'), true, '降级结果必须全标 low');
    assert(result.warnings.some((text) => text.includes('缺少坐标信息')), '必须明确警告缺坐标');
  });

  await test('C2 无坐标 + fallback=per-line：按行成段（仍标 low）', async () => {
    const result = rebuildParagraphs(
      [
        { page: 0, text: '第一行' },
        { page: 0, text: '第二行' },
      ],
      { fallback: 'per-line' },
    );
    assertEqual(result.strategy, 'fallback-per-line', '应使用按行降级策略');
    assertEqual(result.paragraphs.length, 2, '每行一段');
    assertEqual(result.paragraphs[0]!.text, '第一行', '文本不应被拼接');
  });

  await test('C3 空输入与单行输入：不崩溃、不产生假段落', async () => {
    const empty = rebuildParagraphs([]);
    assertEqual(empty.paragraphs.length, 0, '空输入应产出 0 段');
    assertEqual(empty.stats.inputLines, 0, '统计应为 0');

    const single = rebuildParagraphs([line('只有一行', MARGIN, 100)]);
    assertEqual(single.paragraphs.length, 1, '单行应成一段');
    assertEqual(single.paragraphs[0]!.text, '只有一行', '文本应保持');
    assertEqual(single.paragraphs[0]!.lineCount, 1, '合并行数应为 1');

    const blank = rebuildParagraphs([line('   ', MARGIN, 100), line('', MARGIN, 100 + LINE)]);
    assertEqual(blank.paragraphs.length, 0, '空白行应被忽略');
  });

  await test('C4 跨页不合并：不同页的行各自成段，且带正确页码', async () => {
    const result = rebuildParagraphs([
      line('第一页的一段', MARGIN, 700),
      line('第一页的下一行', MARGIN, 700 + LINE),
      line('第二页的一段', MARGIN, 100, SIZE, 1),
      line('第二页的下一行', MARGIN, 100 + LINE, SIZE, 1),
    ]);
    assertEqual(result.paragraphs.length, 2, '跨页不应合并成一段');
    assertEqual(result.paragraphs.map((paragraph) => paragraph.page), [0, 1], '段应带正确页码');
  });

  await test('C5 缺坐标的行不丢文本', async () => {
    const result = rebuildParagraphs([
      line('有坐标的一行', MARGIN, 100),
      line('有坐标的第二行', MARGIN, 100 + LINE),
      { page: 0, text: '缺坐标的一行' },
    ]);
    const joined = result.paragraphs.map((paragraph) => paragraph.text).join('');
    assert(joined.includes('缺坐标的一行'), '缺坐标行的文本不得丢失');
    assert(joined.includes('有坐标的一行'), '有坐标行的文本不得丢失');
  });

  /* ========================= D 导出 → 导入闭环 ========================= */

  await test('D1 闭环：源文档的每个段落恰好落在一个重建段落里（既不丢也不跨段）', async () => {
    const fixture = distinctFixture();
    const imported = await exportedImport(fixture.doc);
    assertEqual(imported.layout.strategy, 'geometry', '自家导出的文件应带完整几何线索');
    const rebuilt = imported.layout.paragraphs.map((paragraph) => paragraph.text.replace(/\s+/g, ''));
    const hits = fixture.texts.map((text) => rebuilt.filter((item) => item.includes(text.replace(/\s+/g, ''))).length);
    assertEqual(hits, fixture.texts.map(() => 1), `每个源段落必须恰好命中 1 个重建段落，实际：${JSON.stringify(hits)}`);
  });

  await test('D2 闭环：标题识别为 title，正文段置信度均不为 low，段落总数与源结构一致', async () => {
    const fixture = distinctFixture();
    const imported = await exportedImport(fixture.doc);
    const titles = imported.layout.paragraphs.filter((paragraph) => paragraph.kind === 'title');
    assertEqual(titles.length, fixture.sectionCount, `识别出的标题数应等于章节数（${fixture.sectionCount}）`);
    assert(
      imported.layout.paragraphs.filter((paragraph) => paragraph.kind === 'body').every((paragraph) => paragraph.confidence !== 'low'),
      '正文段应至少有一条几何线索（置信度不为 low）',
    );
    /* 字段文本是**内联在所属段落**里导出的（见 ofd.ts 的 renderLines），
       所以段落总数 = 标题数 + 正文段数，而不是再加字段行数。 */
    assertEqual(imported.layout.stats.paragraphs, titles.length + fixture.texts.length, '段落总数应等于 标题数 + 正文段数');
    /* 但要确认内联的字段文本没有在重建中丢失 */
    const joined = imported.layout.paragraphs.map((paragraph) => paragraph.text.replace(/\s+/g, '')).join('');
    const fieldTexts = Object.values(fixture.doc.nodes as Record<string, DocNode>)
      .filter((node) => node.type === 'field')
      .map((node) => `${node.valueText ?? ''}`.replace(/\s+/g, ''));
    assert(fieldTexts.length > 0, '前置：夹具应有字段');
    assert(
      fieldTexts.every((text) => text === '' || joined.includes(text)),
      '内联在段落里的字段取值不得在重建中丢失',
    );
  });

  await test('D3 闭环：重建段落落成 paragraph/text 节点，且每段带"判定依据"来源链', async () => {
    const fixture = distinctFixture();
    const { doc } = buildImportedDraft(await exportedImport(fixture.doc), {
      docId: 'doc_layout',
      actorId: 'DR_LAYOUT',
      fileName: 'layout.ofd',
      importedAt: '2026-10-08T10:00:00Z',
    });
    const paragraphs = Object.values(doc.nodes as Record<string, DocNode>).filter((node) => node.type === 'paragraph');
    const texts = Object.values(doc.nodes as Record<string, DocNode>).filter((node) => node.type === 'text');
    assert(paragraphs.length > 0, '应落成段落节点');
    assertEqual(texts.length, paragraphs.length, '每个段落应配一个 text 节点');
    const withEvidence = paragraphs.filter((node) => (node.provenance?.evidence ?? []).some((item) => (item.field ?? '').includes('段落重建')));
    assertEqual(withEvidence.length, paragraphs.length, '每个段落节点都应带"段落重建依据"来源链（事后可审计）');
    /* "未确认"标在**内容节点**上（paragraph 是结构节点，本身不带确认标记） */
    assertEqual(
      texts.every((node) => node.humanConfirmed === false && node.provenance?.origin === 'imported'),
      true,
      '导入正文内容一律标为“未确认 + imported 来源”',
    );
  });

  process.exit(suite.report());
}

/* ---------------------------- 测试内部工具 ---------------------------- */

/** 构造段落文本各不相同的文档（文本相同会让"每段落在一段里"的断言失去意义） */
function distinctFixture(): { doc: DocumentModel; texts: string[]; sectionCount: number; fieldCount: number } {
  const { doc } = buildSyntheticDoc({ sections: 2, paragraphsPerSection: 3, fieldsPerParagraph: 1 });
  const texts: string[] = [];
  let index = 0;
  for (const node of Object.values(doc.nodes) as DocNode[]) {
    if (node.type !== 'text') continue;
    index += 1;
    const text = `第${index}段：${'内容描述'.repeat(8)}`;
    node.runs = [{ text }];
    texts.push(text);
  }
  const nodes = Object.values(doc.nodes) as DocNode[];
  return {
    doc,
    texts,
    sectionCount: nodes.filter((node) => node.type === 'section').length,
    fieldCount: nodes.filter((node) => node.type === 'field').length,
  };
}

/** 导出 → 导入（走真实容器与真实解析） */
async function exportedImport(doc: DocumentModel): Promise<ReturnType<typeof importOfd>> {
  const session = WriteSession.open(doc);
  session.exportMachineReadable();
  return importOfd((await session.exportOfd(PLAN)).bytes);
}

await main();
