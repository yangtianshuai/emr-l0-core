import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TestSuite, assert, assertEqual } from '../testing/harness.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

const globalAny = globalThis as unknown as Record<string, unknown>;
if (!globalAny.window) globalAny.window = globalThis;
if (!globalAny.document) globalAny.document = { documentElement: { dataset: {} } };

await import(new URL('./patch-plan.js', import.meta.url).href);
await import(new URL('./doc-view.js', import.meta.url).href);
await import(new URL('./flow-view.js', import.meta.url).href);

interface Plan {
  mode: 'full' | 'patch' | 'none';
  reason: string;
  replace: string[];
  textOnly: string[];
}

interface PatchPlanApi {
  planDoc: (previous: unknown, next: unknown) => Plan;
  sameNode: (a: unknown, b: unknown, annA: unknown, annB: unknown) => boolean;
  annotationSummary: (annotations: unknown[], nodeId: string) => { total: number; pending: number; lost: number };
  viewKeyOf: (snapshot: unknown) => string;
  IGNORE_FIELDS: Set<string>;
}

interface DocViewApi {
  nodeHtml: (item: unknown, options?: unknown) => string;
  nodesHtml: (items: unknown[], options?: unknown) => string;
}

interface FlowViewApi {
  render: (items: unknown[], options?: unknown) => string;
  renderUnits: (items: unknown[], options?: unknown) => Array<{ key: string; kind: string; nodeIds: string[]; html: string }>;
}

const P = globalAny.L0PatchPlan as PatchPlanApi;
const DV = globalAny.L0DocView as DocViewApi;
const FV = globalAny.L0FlowView as FlowViewApi;

const suite = new TestSuite('正文重画判定 · patch-plan', [
  '说明：本文件只测"哪几块要重画"这个判定本身（纯函数），',
  '      DOM 层的等价性由 ui-self-test 的锚点扫描 + 浏览器验收共同守。',
]);
const test = (name: string, fn: () => void | Promise<void>): Promise<void> => suite.test(name, fn);

function textNode(id: string, text: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, kind: 'text', text, rev: 1, origin: 'human', humanConfirmed: false, paragraphId: `p-${id}`, ...extra };
}

function sampleItems(): Record<string, unknown>[] {
  return [
    { id: 'sec-1', kind: 'section', title: '现病史', rev: 1 },
    textNode('t-1', '咽痛三天，伴发热。'),
    { id: 'f-1', kind: 'field', label: '体温', value: '38.6', unit: '℃', rev: 1, paragraphId: 'p-t-1' },
    textNode('t-2', '无咳嗽咳痰。'),
    { id: 'tb-1', kind: 'table', columns: ['时间', '值'], rows: [[{ text: '10-16' }, { text: '38.6', nodeId: 'c-1' }]], rev: 1 },
  ];
}

function snapshotOf(items: Record<string, unknown>[], overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    docId: 'doc-1',
    mode: 'card',
    readonly: false,
    readonlyHint: '已签章',
    clinical: false,
    annotations: [],
    items,
    ...overrides,
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

async function main(): Promise<void> {
  await test('U1 首次渲染（没有上一份快照）→ 整片', () => {
    const plan = P.planDoc(null, snapshotOf(sampleItems()));
    assertEqual(plan.mode, 'full', '首次必须整片');
    assertEqual(plan.reason, 'first', '原因应为 first');
  });

  await test('U2 视图选项变了 → 整片（编辑方式 / 只读 / 显示密度 / 只读原因）', () => {
    const base = snapshotOf(sampleItems());
    for (const override of [{ mode: 'flow' }, { readonly: true }, { clinical: true }, { readonlyHint: '已归档：归档是终态，不可修改' }]) {
      const plan = P.planDoc(base, snapshotOf(sampleItems(), override));
      assertEqual(plan.mode, 'full', `视图选项变化必须整片：${JSON.stringify(override)}`);
      assertEqual(plan.reason, 'view-options', '原因应为 view-options');
    }
  });

  await test('U3 换了一份文书（节点个数与顺序恰好相同）→ 整片', () => {
    const plan = P.planDoc(
      snapshotOf(sampleItems()),
      snapshotOf(sampleItems(), { docId: 'doc-2' }),
    );
    assertEqual(plan.mode, 'full', '换文书必须整片：滚过的位置与章节目录都是上一份的');
    assertEqual(plan.reason, 'view-options', '文书身份属于视图指纹');
  });

  await test('U4 增段 / 删段 → 整片', () => {
    const more = sampleItems().concat([textNode('t-9', '新增一段')]);
    assertEqual(P.planDoc(snapshotOf(sampleItems()), snapshotOf(more)).reason, 'structure', '增段');
    assertEqual(P.planDoc(snapshotOf(more), snapshotOf(sampleItems())).reason, 'structure', '删段');
  });

  await test('U5 顺序变了（上下移）→ 整片', () => {
    const items = sampleItems();
    const swapped = clone(items);
    const first = swapped[1];
    const second = swapped[3];
    swapped[1] = second!;
    swapped[3] = first!;
    assertEqual(P.planDoc(snapshotOf(items), snapshotOf(swapped)).reason, 'structure', '顺序变化必须整片');
  });

  await test('U6 章节标题变了 → 整片（它是流式视图的分组边界）', () => {
    const next = sampleItems();
    next[0] = { ...next[0]!, title: '主诉' };
    const plan = P.planDoc(snapshotOf(sampleItems()), snapshotOf(next));
    assertEqual(plan.mode, 'full', '章节变化必须整片');
    assertEqual(plan.reason, 'section', '原因应为 section');
  });

  await test('U7 空正文 → 整片（空态占位不是节点，不能走局部）', () => {
    assertEqual(P.planDoc(snapshotOf([]), snapshotOf([])).reason, 'empty', '空正文');
  });

  await test('U8 一个节点都没变 → 什么都不做', () => {
    const plan = P.planDoc(snapshotOf(sampleItems()), snapshotOf(clone(sampleItems())));
    assertEqual(plan.mode, 'none', '没变就不该动 DOM');
    assertEqual(plan.replace.length, 0, 'replace 应为空');
  });

  await test('U9 「不参与比较」的字段变化 → 不动（order / parentId / provenance）', () => {
    const next = sampleItems();
    next[1] = { ...next[1]!, order: 99, parentId: 'p-other', provenance: { origin: 'ai' } };
    const plan = P.planDoc(snapshotOf(sampleItems()), snapshotOf(next));
    assertEqual(plan.mode, 'none', '这几项没有渲染方消费，改它们不该引起重画');
    assert(!P.IGNORE_FIELDS.has('presentation'),
      'presentation 不能回到忽略名单：纸张视图与打印现在都消费它的 pageBreakBefore');
  });

  await test('U9′ 分页意图变了 → 必须重画那一段（否则「改了分页、纸面没变」）', () => {
    const next = sampleItems();
    next[1] = { ...next[1]!, pageBreakBefore: true };
    const plan = P.planDoc(snapshotOf(sampleItems()), snapshotOf(next));
    assertEqual(plan.mode, 'patch', '分页线由 doc-view / flow-view 画出，改了就必须重画');
    assertEqual(plan.replace, ['t-1'], '只重画那一段');
  });

  await test('U10 未知字段变化 → 重画（安全方向：宁可多画一次）', () => {
    const next = sampleItems();
    next[1] = { ...next[1]!, futureField: 'x' };
    const plan = P.planDoc(snapshotOf(sampleItems()), snapshotOf(next));
    assertEqual(plan.mode, 'patch', '白名单外的新字段必须触发重画');
    assertEqual(plan.replace, ['t-1'], '只重画那一个节点');
  });

  await test('U11 单段文本变了 → 只换那一段，且能提示 textOnly', () => {
    const next = sampleItems();
    next[1] = { ...next[1]!, text: '咽痛三天，伴发热，最高 38.6℃。', rev: 2 };
    const plan = P.planDoc(snapshotOf(sampleItems()), snapshotOf(next));
    assertEqual(plan.mode, 'patch', '应走局部');
    assertEqual(plan.replace, ['t-1'], '只换 t-1');
    assertEqual(plan.textOnly, ['t-1'], '只有文本变化要标出来（ui.js 据此比对 DOM 后决定是否真跳过）');
    assertEqual(plan.reason, 'nodes', '原因应为 nodes');
  });

  await test('U12 多个节点同时变 → replace 精确覆盖，不牵连无关节点', () => {
    const next = sampleItems();
    next[1] = { ...next[1]!, text: '甲', rev: 2 };
    next[3] = { ...next[3]!, humanConfirmed: true, rev: 2 };
    const plan = P.planDoc(snapshotOf(sampleItems()), snapshotOf(next));
    assertEqual(plan.mode, 'patch', '应走局部');
    assertEqual(plan.replace.slice().sort(), ['t-1', 't-2'], '只换这两段');
    assert(!plan.replace.includes('tb-1'), '表格没变，不该被牵连');
  });

  await test('U13 状态位变化（待确认 → 已确认 / 关键内容 / 来源）→ 必须重画', () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['已确认', { humanConfirmed: true }],
      ['关键内容', { keyContent: true }],
      ['来源改成 AI', { origin: 'ai' }],
      ['数据元标签', { tags: [{ system: 'WS445', code: 'DE05.01.001' }] }],
      ['来源模型', { modelId: 'qwen-med-7b' }],
    ];
    for (const [label, patch] of cases) {
      const next = sampleItems();
      next[1] = { ...next[1]!, ...patch, rev: 2 };
      const plan = P.planDoc(snapshotOf(sampleItems()), snapshotOf(next));
      assertEqual(plan.mode, 'patch', `${label} 变化必须重画`);
      assert(plan.replace.includes('t-1'), `${label} 变化应命中 t-1`);
    }
  });

  await test('U14 非文本节点变化不进 textOnly（字段 / 表格 / 控件）', () => {
    const nextField = sampleItems();
    nextField[2] = { ...nextField[2]!, value: '39.1', rev: 2 };
    const planA = P.planDoc(snapshotOf(sampleItems()), snapshotOf(nextField));
    assertEqual(planA.replace, ['f-1'], '字段变化要重画');
    assertEqual(planA.textOnly, [], '字段不是纯文本节点，不能进 textOnly');

    const nextTable = sampleItems();
    nextTable[4] = { ...nextTable[4]!, rows: [[{ text: '10-16' }, { text: '39.1', nodeId: 'c-1' }]], rev: 2 };
    const planB = P.planDoc(snapshotOf(sampleItems()), snapshotOf(nextTable));
    assertEqual(planB.replace, ['tb-1'], '表格内容变化要重画');
    assertEqual(planB.textOnly, [], '表格不进 textOnly');
  });

  await test('U15 文本 + 别的字段一起变 → 不进 textOnly（跳过替换会漏掉装饰）', () => {
    const next = sampleItems();
    next[1] = { ...next[1]!, text: '改了字', keyContent: true, rev: 2 };
    const plan = P.planDoc(snapshotOf(sampleItems()), snapshotOf(next));
    assertEqual(plan.replace, ['t-1'], '要重画');
    assertEqual(plan.textOnly, [], '不能标成"只有文本变了"');
  });

  await test('U16 注解新增到某节点 → 只重画该节点（徽标跟着变）', () => {
    const annotations = [{ nodeId: 't-2', status: 'open', anchorState: 'ok' }];
    const plan = P.planDoc(
      snapshotOf(sampleItems()),
      snapshotOf(sampleItems(), { annotations }),
    );
    assertEqual(plan.mode, 'patch', '注解变化必须让对应节点重画');
    assertEqual(plan.replace, ['t-2'], '只重画挂提示的那一段');
  });

  await test('U17 注解的处置状态 / 锚点丢失 → 徽标文案变，必须重画', () => {
    const open = [{ nodeId: 't-2', status: 'open', anchorState: 'ok' }];
    const handled = [{ nodeId: 't-2', status: 'handled', anchorState: 'ok' }];
    const lost = [{ nodeId: 't-2', status: 'open', anchorState: 'lost' }];
    assertEqual(P.planDoc(snapshotOf(sampleItems(), { annotations: open }), snapshotOf(sampleItems(), { annotations: handled })).mode, 'patch', '待处理数变了');
    assertEqual(P.planDoc(snapshotOf(sampleItems(), { annotations: open }), snapshotOf(sampleItems(), { annotations: lost })).mode, 'patch', '锚点丢失数变了');
  });

  await test('U18 注解挂在并不存在的节点上 → 不影响判定', () => {
    const annotations = [{ nodeId: 'ghost', status: 'open', anchorState: 'ok' }];
    const plan = P.planDoc(snapshotOf(sampleItems()), snapshotOf(sampleItems(), { annotations }));
    assertEqual(plan.mode, 'none', '不落在任何节点上的注解不该引起重画');
  });

  await test('U19 annotationSummary 的口径与 anchorBadge 一致（总条数 / 待处理 / 丢失）', () => {
    const annotations = [
      { nodeId: 't-1', status: 'open', anchorState: 'ok' },
      { nodeId: 't-1', status: 'acknowledged', anchorState: 'lost' },
      { nodeId: 't-1', status: 'handled', anchorState: 'ok' },
      { nodeId: 't-2', status: 'open', anchorState: 'ok' },
    ];
    assertEqual(P.annotationSummary(annotations, 't-1'), { total: 3, pending: 2, lost: 1 }, 't-1 的摘要');
    assertEqual(P.annotationSummary(annotations, 't-2'), { total: 1, pending: 1, lost: 0 }, 't-2 的摘要');
    assertEqual(P.annotationSummary(annotations, 'none'), { total: 0, pending: 0, lost: 0 }, '未挂提示');
  });

  await test('U20 随机对拍（200 轮）：不漏画、不多画', () => {
    let seed = 20261020;
    const rnd = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const pick = <T>(list: T[]): T => list[Math.floor(rnd() * list.length)]!;

    const mutations: Array<(items: Record<string, unknown>[]) => void> = [
      (items) => { const at = Math.floor(rnd() * items.length); items[at] = { ...items[at]!, rev: Number(items[at]!.rev) + 1 }; },
      (items) => { const at = Math.floor(rnd() * items.length); items[at] = { ...items[at]!, text: `${items[at]!.text ?? ''}改`, rev: 2 }; },
      (items) => { const at = Math.floor(rnd() * items.length); items[at] = { ...items[at]!, humanConfirmed: true, rev: 2 }; },
      (items) => { const at = Math.floor(rnd() * items.length); items[at] = { ...items[at]!, keyContent: true, rev: 2 }; },
      (items) => { const at = Math.floor(rnd() * items.length); items[at] = { ...items[at]!, tags: [{ system: 'WS445', code: 'X' }], rev: 2 }; },
      (items) => { const at = Math.floor(rnd() * items.length); items[at] = { ...items[at]!, order: Number(items[at]!.order ?? 0) + 5 }; },
    ];

    for (let round = 0; round < 200; round += 1) {
      const items = sampleItems();
      const before = snapshotOf(clone(items));
      const after = snapshotOf(clone(items));
      const times = 1 + Math.floor(rnd() * 2);
      for (let step = 0; step < times; step += 1) pick(mutations)(after.items as Record<string, unknown>[]);
      const addAnnotation = rnd() < 0.3;
      if (addAnnotation) after.annotations = [{ nodeId: pick(items).id, status: 'open', anchorState: 'ok' }];

      const plan = P.planDoc(before, after);
      if (plan.mode !== 'patch') continue;

      const replaced = new Set(plan.replace);
      const beforeItems = before.items as Record<string, unknown>[];
      const afterItems = after.items as Record<string, unknown>[];
      for (let index = 0; index < afterItems.length; index += 1) {
        const annA = P.annotationSummary(before.annotations as unknown[], String(afterItems[index]!.id));
        const annB = P.annotationSummary(after.annotations as unknown[], String(afterItems[index]!.id));
        const same = P.sameNode(beforeItems[index], afterItems[index], annA, annB);
        const id = String(afterItems[index]!.id);
        if (!same) assert(replaced.has(id), `第 ${round} 轮：${id} 变了却没在 replace 里（漏画）`);
        else assert(!replaced.has(id), `第 ${round} 轮：${id} 没变却在 replace 里（多画）`);
      }
    }
  });

  await test('U21 每个非章节节点的根都带 data-node-id（否则找不到锚点）', () => {
    const samples: Array<[string, Record<string, unknown>]> = [
      ['text', textNode('n-text', '正文')],
      ['field', { id: 'n-field', kind: 'field', label: '体温', value: '36.5', rev: 1 }],
      ['table', { id: 'n-table', kind: 'table', columns: ['a'], rows: [[{ text: '1' }]], rev: 1 }],
      ['listItem', { id: 'n-li', kind: 'listItem', text: '一项', marker: '1. ', rev: 1 }],
      ['image', { id: 'n-img', kind: 'image', resRef: '', rev: 1 }],
      ['control', { id: 'n-ctl', kind: 'control', shape: 'scale', label: '评分', cells: [{ key: 'k1', label: '格一', value: '' }], rev: 1 }],
    ];
    for (const [kind, item] of samples) {
      const html = DV.nodeHtml(item, { clinical: true });
      assert(html.includes(`data-node-id="${item.id}"`), `${kind} 节点的根必须带 data-node-id`);
    }
  });

  await test('U22 章节标题不带 data-node-id（保持现状：卡片模式靠"换成下一段"定位）', () => {
    const html = DV.nodeHtml({ id: 'sec-x', kind: 'section', title: '主诉', rev: 1 }, { clinical: true });
    assert(!html.includes('data-node-id'), '章节标题一旦带锚点，anchorOfNode 会命中它，而 .sec 的高亮样式不存在');
  });

  await test('U23 renderUnits 拼起来必须与 render 逐字节相同', () => {
    const items = sampleItems().concat([textNode('t-3', '第三段')]);
    for (const options of [{}, { readonly: true, readonlyHint: '已签章' }, { clinical: true }]) {
      const units = FV.renderUnits(items, options);
      assertEqual(FV.render(items, options), units.map((unit) => unit.html).join(''), '两个粒度必须是同一份实现');
      const keys = units.map((unit) => unit.key);
      assertEqual(new Set(keys).size, keys.length, '单元 key 必须唯一（重画靠它查 DOM）');
    }
  });

  await test('U24 可编辑区的 nodeIds 覆盖段内所有节点（含段内填写项）', () => {
    const items = [
      { id: 'sec-1', kind: 'section', title: '现病史', rev: 1 },
      textNode('t-1', '咽痛三天'),
      { id: 'f-1', kind: 'field', label: '体温', value: '38.6', rev: 1, paragraphId: 'p-t-1' },
    ];
    const units = FV.renderUnits(items, {});
    const segment = units.find((unit) => unit.kind === 'segment');
    assert(!!segment, '应形成一个可编辑区');
    assertEqual(segment!.nodeIds.slice().sort(), ['f-1', 't-1'], '段内填写项也要在清单里，否则它变了会被漏掉');
  });

  await test('U25 渲染器与判定层都只用了一份视图项（没有 DOM 依赖泄漏）', () => {
    assert(typeof DV.nodeHtml === 'function', 'doc-view 应可独立渲染');
    assert(typeof FV.renderUnits === 'function', 'flow-view 应可独立出单元');
    assertEqual(typeof (globalAny.document as Record<string, unknown>).querySelector, 'undefined', '渲染器不该依赖 DOM 查询');
  });

  await test('U26 前端已把 patch-plan.js 引入、服务端已托管（否则页面会静默退回整片）', () => {
    const html = readFileSync(`${ROOT}src/demo/ui.html`, 'utf8');
    const server = readFileSync(`${ROOT}src/demo/demo-server.ts`, 'utf8');
    const ui = readFileSync(`${ROOT}src/demo/ui.js`, 'utf8');
    assert(html.includes('src="/patch-plan.js"'), 'ui.html 必须引入 patch-plan.js');
    assert(server.includes("path === '/patch-plan.js'"), 'demo-server 必须托管 patch-plan.js');
    assert(ui.includes('L0PatchPlan.planDoc('), 'ui.js 必须真的走判定层');
    assert(
      html.indexOf('src="/patch-plan.js"') < html.indexOf('src="/ui.js"'),
      'patch-plan.js 必须排在 ui.js 之前',
    );
  });

  process.exit(suite.report());
}

void main();
