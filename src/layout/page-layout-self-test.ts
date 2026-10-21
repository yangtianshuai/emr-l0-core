import { WriteSession } from '../core/session.ts';
import { buildOfdPackage, renderLines, type OfdExportPlan } from '../export/ofd.ts';
import { breakBeforeOf } from '../model/presentation.ts';
import { buildSyntheticDoc } from '../testing/synthetic.ts';
import { TestSuite, assert, assertEqual } from '../testing/harness.ts';
import { contentArea, layoutDocument } from './page-layout.ts';
import type { DocumentModel, NodeId } from '../model/types.ts';

const suite = new TestSuite('T27 分页排版自测', [
  '说明：预览、打印、导出消费的是同一份排版结果；这里比对"页数"与"行坐标"，不是比对源码里有没有某个函数。',
  '不得据此声称与 OFD 阅读器逐像素一致：宽度按全角/半角估算，字体度量未接字体文件（见能力矩阵 P1）。',
]);

const test = (name: string, fn: () => void | Promise<void>): Promise<void> => suite.test(name, fn);

const PLAN: OfdExportPlan = {
  layout: { textAsPath: false },
  machineReadable: { signed: true, carrier: 'separate-xml' },
};

function bigDoc(options: { sections?: number; paragraphsPerSection?: number } = {}): DocumentModel {
  return buildSyntheticDoc({
    sections: options.sections ?? 12,
    paragraphsPerSection: options.paragraphsPerSection ?? 9,
  }).doc;
}

async function exportable(doc: DocumentModel): Promise<DocumentModel> {
  const session = WriteSession.open(doc);
  session.exportMachineReadable();
  return session.document;
}

async function main(): Promise<void> {
  await test('L1 一份长文书能分出多页，行不越出版心，页高固定', async () => {
    const doc = bigDoc();
    const layout = layoutDocument(doc);
    assert(layout.pages.length >= 2, `12 节文书应至少 2 页，实际 ${layout.pages.length}`);
    const area = layout.content;
    assertEqual(layout.content, contentArea(), '下发的版心必须与排版用的版心是同一份');

    for (const page of layout.pages) {
      assert(page.lines.length > 0, `第 ${page.number} 页没有行：分页算出了空页`);
      let previousY = -1;
      for (const line of page.lines) {
        assert(line.y >= area.top - 0.01, `第 ${page.number} 页有行压到页眉区（y=${line.y} < ${area.top}）`);
        assert(line.y <= area.bottom + 0.01, `第 ${page.number} 页有行越过版心底（y=${line.y} > ${area.bottom}）`);
        assert(line.x >= area.left - 0.01, `第 ${page.number} 页有行压到装订边（x=${line.x} < ${area.left}）`);
        assert(line.y > previousY, `第 ${page.number} 页行序必须自上而下（${previousY} → ${line.y}）`);
        previousY = line.y;
      }
    }
  });

  await test('L2 不丢字：分页后的正文与渲染行逐字一致', async () => {
    const doc = bigDoc({ sections: 6, paragraphsPerSection: 5 });
    const layout = layoutDocument(doc);
    const placed = layout.pages.flatMap((page) => page.lines.map((line) => line.text)).join('');
    const rendered = renderLines(doc).map((line) => line.text).join('');
    assertEqual(placed.replace(/\s+/g, ''), rendered.replace(/\s+/g, ''), '分页会切行，但不得丢字或多字');
    assertEqual(layout.stats.chars, placed.length, 'stats.chars 必须等于实际落纸字数');
  });

  await test('L3 页眉页脚：每页带真实页码与总页数，模板变量不漏', async () => {
    const doc = bigDoc({ sections: 8, paragraphsPerSection: 6 });
    const layout = layoutDocument(doc);
    const total = layout.pages.length;
    for (const page of layout.pages) {
      assert(page.header.includes(`共 ${total} 页`), `页眉要写总页数（第 ${page.number} 页：${page.header}）`);
      assert(page.footer.includes(`第 ${page.number} 页`), `页脚要写本页页码（${page.footer}）`);
      assert(page.footer.includes(doc.docId), '页脚要带文书号，散页才能归位');
      assert(!/\{\w+\}/.test(page.header + page.footer), '不得残留未替换的占位符');
    }
  });

  await test('L4 断页意图：章节标了"另起一页"就必须另起，且页面写明原因', async () => {
    const doc = bigDoc();
    const layoutBefore = layoutDocument(doc);
    const sectionIds = Object.values(doc.nodes)
      .filter((node) => node.type === 'section')
      .sort((a, b) => a.order - b.order)
      .map((node) => node.id);
    const target = sectionIds[2] as NodeId;
    doc.nodes[target] = { ...doc.nodes[target]!, presentation: { pageBreakBefore: true } };

    assert(breakBeforeOf(doc).has(target), '断页意图必须能被判定出来（标在章节上）');
    const layout = layoutDocument(doc);
    assert(layout.pages.length >= layoutBefore.pages.length, '加断页不应减少页数');

    const hit = layout.pages.find((page) => page.lines.some((line) => line.nodeId === target));
    assert(!!hit, '断页章节应当落在某一页上');
    const first = hit!.lines[0];
    assertEqual(first?.nodeId, target, '断页章节必须是该页第一行（否则"另起一页"没生效）');
    assertEqual(hit!.forcedBreak, true, '该页要标明是由断页意图产生的');
    assertEqual(first?.y, Number(layout.content.top.toFixed(2)), '断页后的首行必须贴在版心顶');
  });

  await test('L5 与导出同源：预览页数 == 归档件页数（同一份断页意图）', async () => {
    const doc = await exportable(bigDoc({ sections: 10, paragraphsPerSection: 7 }));
    const layout = layoutDocument(doc);
    const pkg = await buildOfdPackage(doc, PLAN);
    assertEqual(layout.pages.length, pkg.pages, '预览与归档件页数必须相等（两边各分一套就成了两套版式）');

    const sectionIds = Object.values(doc.nodes)
      .filter((node) => node.type === 'section')
      .sort((a, b) => a.order - b.order)
      .map((node) => node.id);
    doc.nodes[sectionIds[3] as NodeId] = { ...doc.nodes[sectionIds[3] as NodeId]!, presentation: { pageBreakBefore: true } };
    const layoutAfter = layoutDocument(doc);
    const pkgAfter = await buildOfdPackage(doc, PLAN);
    assertEqual(layoutAfter.pages.length, pkgAfter.pages, '带断页意图时也必须同源（导出端要消费同一份意图）');
  });

  await test('L6 确定性：同一份文书两次排版结果逐字段相同，且能 JSON 下发', async () => {
    const doc = bigDoc({ sections: 5, paragraphsPerSection: 4 });
    const first = layoutDocument(doc);
    const second = layoutDocument(doc);
    assertEqual(first, second, '排版必须是纯函数：同一输入两次结果一致');
    const wire = JSON.parse(JSON.stringify(first)) as typeof first;
    assertEqual(wire.pages.length, first.pages.length, '排版结果必须可直接 JSON 序列化（界面只消费这个）');
  });

  await test('L7 空文书：一页、零行，不生成空页也不报错', async () => {
    const doc = bigDoc({ sections: 0, paragraphsPerSection: 0 });
    const layout = layoutDocument(doc);
    assertEqual(layout.pages.length, 1, '空文书也应有 1 页（纸面不能凭空消失）');
    assertEqual(layout.pages[0]?.lines.length, 0, '空文书第一页不应有正文行');
    assert(layout.pages[0]!.footer.includes('第 1 页'), '空文书也要有页脚');
  });

  await test('L8 取不到图片：纸面留占位，不静默吞掉', async () => {
    const doc = buildSyntheticDoc({ sections: 1, paragraphsPerSection: 1 }).doc;
    const paragraph = Object.values(doc.nodes).find((node) => node.type === 'paragraph');
    assert(!!paragraph, '前置：应有段落节点');
    doc.nodes.n_img = {
      id: 'n_img',
      type: 'image',
      parentId: paragraph!.id,
      order: 99,
      rev: 1,
      provenance: { origin: 'human', actorId: 'DR_T', at: doc.createdAt },
      resRef: '/res/missing.png',
      altText: '术前定位',
    } as DocumentModel['nodes'][string];
    const layout = layoutDocument(doc);
    const texts = layout.pages.flatMap((page) => page.lines.map((line) => line.text)).join('\n');
    assert(texts.includes('图片缺失'), `取不到图时必须留可见占位，实际：${texts.slice(0, 80)}`);
  });

  process.exit(suite.report());
}

await main();
