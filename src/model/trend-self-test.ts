// 趋势派生视图自测。

import { TestSuite, assert, assertEqual } from '../testing/harness.ts';
import { buildTrend, buildTrends } from './trend.ts';
import type { DocumentModel, DocNode } from './types.ts';

const suite = new TestSuite('趋势派生视图自测');
const test = (name: string, fn: () => void | Promise<void>): Promise<void> => suite.test(name, fn);

interface FieldSpec {
  id: string;
  order: number;
  value: number | string;
  valueText?: string;
  sampledAt?: string;
  unit?: string;
  sourceKey?: string;
  range?: { low?: number; high?: number; text?: string };
  confirmed?: boolean;
  tags?: Array<{ system: string; code: string; display?: string }>;
}

function docWith(fields: FieldSpec[]): DocumentModel {
  const at = '2026-10-08T01:00:00Z';
  const prov = { origin: 'system' as const, actorId: 'system/lis', at };
  const nodes: Record<string, DocNode> = {
    n_root: { id: 'n_root', type: 'document', parentId: null, order: 0, rev: 1, provenance: prov },
    n_p: { id: 'n_p', type: 'paragraph', parentId: 'n_root', order: 10, rev: 1, provenance: prov },
  };
  for (const spec of fields) {
    nodes[spec.id] = {
      id: spec.id,
      type: 'field',
      parentId: 'n_p',
      order: spec.order,
      rev: 1,
      dataType: 'number',
      value: spec.value,
      ...(spec.valueText !== undefined ? { valueText: spec.valueText } : {}),
      ...(spec.unit !== undefined ? { unit: spec.unit } : {}),
      ...(spec.sampledAt !== undefined ? { sampledAt: spec.sampledAt } : {}),
      ...(spec.sourceKey !== undefined ? { sourceKey: spec.sourceKey } : {}),
      ...(spec.range !== undefined ? { referenceRange: spec.range } : {}),
      ...(spec.confirmed === true ? { humanConfirmed: true } : {}),
      ...(spec.tags !== undefined ? { tags: spec.tags } : {}),
      provenance: prov,
    } as unknown as DocNode;
  }
  return {
    schemaVersion: '1.0.0',
    docId: 'doc_trend_1',
    docType: { system: 'WST500', code: 'WST500.2', display: '住院病历' },
    patient: { patientId: 'P1', nameMasked: '张**' },
    status: 'draft',
    createdAt: at,
    updatedAt: at,
    createdBy: 'DR_WANG',
    rootId: 'n_root',
    nodes,
    revisions: [],
  } as unknown as DocumentModel;
}

const RANGE = { low: 4, high: 10 };

async function main(): Promise<void> {
  await test('A1 按**采样时间**升序聚合（节点 order 不能决定先后）', () => {
    /* order 故意写成与时间相反：若实现按 order 排序，这条会失败 */
    const doc = docWith([
      { id: 'f_late', order: 10, value: 12.6, valueText: '12.6', sampledAt: '2026-10-08T07:00:00Z', sourceKey: 'LIS.WBC', range: RANGE },
      { id: 'f_early', order: 20, value: 9.8, valueText: '9.8', sampledAt: '2026-10-06T07:00:00Z', sourceKey: 'LIS.WBC', range: RANGE },
      { id: 'f_mid', order: 30, value: 15.2, valueText: '15.2', sampledAt: '2026-10-07T07:00:00Z', sourceKey: 'LIS.WBC', range: RANGE },
    ]);
    const trend = buildTrend(doc, 'LIS.WBC');
    assert(!!trend, '应能取到趋势');
    assertEqual(trend!.points.map((point) => point.nodeId), ['f_early', 'f_mid', 'f_late'], '必须按采样时间升序');
    assertEqual(trend!.stats.first, 9.8, 'first 应为最早的点');
    assertEqual(trend!.stats.last, 12.6, 'last 应为最新的点');
    assertEqual(trend!.stats.min, 9.8, 'min 应正确');
    assertEqual(trend!.stats.max, 15.2, 'max 应正确');
  });

  await test('A2 异常值必须标出来（参考范围外才是医生要看的）', () => {
    const doc = docWith([
      { id: 'f1', order: 10, value: 9.8, sampledAt: '2026-10-06T07:00:00Z', sourceKey: 'LIS.WBC', range: RANGE },
      { id: 'f2', order: 20, value: 2.1, sampledAt: '2026-10-07T07:00:00Z', sourceKey: 'LIS.WBC', range: RANGE },
      { id: 'f3', order: 30, value: 18.0, sampledAt: '2026-10-08T07:00:00Z', sourceKey: 'LIS.WBC', range: RANGE },
    ]);
    const trend = buildTrend(doc, 'LIS.WBC')!;
    assertEqual(trend.points.map((point) => point.flag), ['normal', 'low', 'high'], '应分别标为正常/偏低/偏高');
    assertEqual(trend.stats.abnormal, 2, '异常点数应为 2');
  });

  await test('A3 缺采样时间：排在末尾并如实警告，**不丢数据**', () => {
    const doc = docWith([
      { id: 'f1', order: 10, value: 9.8, sampledAt: '2026-10-06T07:00:00Z', sourceKey: 'LIS.WBC', range: RANGE },
      { id: 'f2', order: 20, value: 10.5, sourceKey: 'LIS.WBC', range: RANGE },
    ]);
    const trend = buildTrend(doc, 'LIS.WBC')!;
    assertEqual(trend.points.length, 2, '缺时间的点也必须列出（不丢数据）');
    assertEqual(trend.points[1]?.nodeId, 'f2', '缺时间的点排在末尾');
    assert(trend.warnings.some((text) => text.includes('缺少采样时间')), '必须警告，否则趋势图会"看起来完整"');
  });

  await test('A4 单位不一致：警告且**不给单一单位**（不可直接比较）', () => {
    const doc = docWith([
      { id: 'f1', order: 10, value: 12.6, unit: '10^9/L', sampledAt: '2026-10-06T07:00:00Z', sourceKey: 'LIS.WBC' },
      { id: 'f2', order: 20, value: 12600, unit: '/uL', sampledAt: '2026-10-07T07:00:00Z', sourceKey: 'LIS.WBC' },
    ]);
    const trend = buildTrend(doc, 'LIS.WBC')!;
    assertEqual(trend.unit, undefined, '单位不一致时不得给出单一单位');
    assert(trend.warnings.some((text) => text.includes('多种单位')), '必须警告单位不一致');
  });

  await test('A5 未确认点计数 + 无法聚合的孤立点单独报告', () => {
    const doc = docWith([
      { id: 'f1', order: 10, value: 9.8, sampledAt: '2026-10-06T07:00:00Z', sourceKey: 'LIS.WBC', range: RANGE },
      { id: 'f2', order: 20, value: 12.1, sampledAt: '2026-10-07T07:00:00Z', sourceKey: 'LIS.WBC', range: RANGE, confirmed: true },
      /* 既无 sourceKey 也无标签：无法归入任何趋势 */
      { id: 'f3', order: 30, value: 37.2 },
    ]);
    const trend = buildTrend(doc, 'LIS.WBC')!;
    assertEqual(trend.stats.unconfirmed, 1, '未确认点数应为 1');
    const orphan = buildTrends(doc).find((series) => series.key === '(无法聚合)');
    assert(!!orphan, '无法聚合的字段必须单独报告，而不是被静默忽略');
    assert(orphan!.warnings[0]?.includes('f3'), '报告里应指出具体节点');
  });

  await test('A6 标签回退：没有 sourceKey 时用 tags 聚合，文本节点不参与趋势', () => {
    const doc = docWith([
      {
        id: 'f1',
        order: 10,
        value: 38.5,
        valueText: '38.5',
        unit: '℃',
        sampledAt: '2026-10-06T07:00:00Z',
        tags: [{ system: 'WS445', code: 'DE05.01.001', display: '体温' }],
      },
    ]);
    const trend = buildTrend(doc, 'WS445:DE05.01.001')!;
    assert(!!trend, '无 sourceKey 时应按 tags 聚合');
    assertEqual(trend.label, '体温', '标签显示名应作为系列名');
    assertEqual(trend.points.length, 1, '应有一个采样点');

    /* text 节点里的数值不参与趋势：否则叙述内容会被当成采样点 */
    const withText = docWith([]);
    (withText.nodes as Record<string, DocNode>).n_t = {
      id: 'n_t',
      type: 'text',
      parentId: 'n_p',
      order: 5,
      rev: 1,
      runs: [{ text: '体温 38.5℃' }],
      tags: [{ system: 'WS445', code: 'DE05.01.001', display: '体温' }],
      provenance: { origin: 'human', actorId: 'DR_WANG', at: '2026-10-08T01:00:00Z' },
    } as unknown as DocNode;
    assertEqual(buildTrends(withText).filter((series) => series.points.length > 0).length, 0, 'text 节点不得进入趋势');
  });

  process.exit(suite.report());
}

void main();
