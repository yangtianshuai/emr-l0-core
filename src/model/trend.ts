/**
 * 检验/体征趋势 —— **派生视图**，不是文档结构。
 *
 * 核心判断：趋势**不进文档树**。
 *   1) 文档是**签名对象**，签章后不可改；而趋势数据每天在增长 ——
 *      把趋势做成文档里的一个结构，签章后就再也追不上了（临床上正是签章之后还在看趋势）；
 *   2) 正确做法：每个采样值 = 一个独立 `field` 节点（带 `sampledAt`、独立留痕），
 *      趋势 = 把这些节点按同一聚合键 + 时间排序算出来的视图。
 *   这与"机读信息是派生物"的既有原则一致：**派生数据不手工维护**。
 *
 * 聚合键的优先级：`sourceKey`（如 `LIS.WBC`）→ 否则 `tags[0]` 的 `system:code`。
 * 两条都可能缺：缺了就**无法聚合**，只能如实报告为"孤立点"，而不是硬凑成趋势。
 *
 * 本模块只做"排序 + 极值 + 异常标记"，**不做**：
 *   - 单位换算（不同单位的同名检验值必须人工确认后才能比，这里只提示单位不一致）；
 *   - 采样错误识别（把日期填错的点排到首位，本模块不会发现）；
 *   - "变化是否已写入病程记录"的一致性提示（那是质控，需要与文本比对）。
 */

import type { DataElementTag, DocumentModel, JsonValue, NodeId, ProvenanceOrigin } from './types.ts';
import { orderedNodeIds } from './machine.ts';

export type TrendFlag = 'low' | 'normal' | 'high' | 'unknown';

export interface TrendPoint {
  nodeId: NodeId;
  /** 采样时间（ISO8601）；缺失时为 undefined —— 该点仍会列出，但不参与时间排序 */
  at?: string;
  value: number | string;
  valueText: string;
  unit?: string;
  flag: TrendFlag;
  origin: ProvenanceOrigin;
  /** 是否已人工确认：趋势里的"未确认点"要能看出来（它们还没被医生核对过） */
  humanConfirmed: boolean;
}

export interface TrendSeries {
  /** 聚合键：`sourceKey` 或 `system:code` */
  key: string;
  label: string;
  unit?: string;
  referenceRange?: { low?: number; high?: number; text?: string; unit?: string };
  /** 时间升序；**缺 sampledAt 的点排在最后**（不丢数据，但要让人看出来） */
  points: TrendPoint[];
  stats: {
    count: number;
    first?: number;
    last?: number;
    min?: number;
    max?: number;
    /** 参考范围外的点数 —— 住院看趋势，真正要看的就是它 */
    abnormal: number;
    /** 尚未人工确认的点数 */
    unconfirmed: number;
  };
  warnings: string[];
}

/** 数值化：只接受真正的 number；字符串数字不硬转（避免把"阴性"变成 NaN） */
function numericOf(value: JsonValue): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function flagOf(value: JsonValue, range: TrendSeries['referenceRange']): TrendFlag {
  const numeric = numericOf(value);
  if (numeric === undefined || !range) return 'unknown';
  if (typeof range.low === 'number' && numeric < range.low) return 'low';
  if (typeof range.high === 'number' && numeric > range.high) return 'high';
  if (typeof range.low === 'number' || typeof range.high === 'number') return 'normal';
  return 'unknown';
}

function keyOf(sourceKey: string | undefined, tags: DataElementTag[] | undefined): { key: string; label: string } | undefined {
  if (sourceKey) return { key: sourceKey, label: sourceKey };
  const tag = tags?.[0];
  if (tag) return { key: `${tag.system}:${tag.code}`, label: tag.display ?? `${tag.system}:${tag.code}` };
  return undefined;
}

/**
 * 聚合出全部趋势序列（按聚合键分组）。
 *
 * 只收 `field` 节点：`text` 节点里的数值可能是叙述的一部分（"体温 38.5℃"），
 * 把它们也当采样点会让趋势混入非结构化内容 —— 那是"看起来更全、实际更脏"。
 */
export function buildTrends(doc: DocumentModel): TrendSeries[] {
  const buckets = new Map<string, { label: string; points: TrendPoint[] }>();
  const orphans: string[] = [];

  for (const id of orderedNodeIds({ nodes: doc.nodes, rootId: doc.rootId })) {
    const node = doc.nodes[id];
    if (!node || node.type !== 'field') continue;
    const value = node.value;
    if (value === null || value === undefined || value === '') continue;

    const named = keyOf(node.sourceKey, node.tags);
    if (!named) {
      orphans.push(node.id);
      continue;
    }
    const bucket = buckets.get(named.key) ?? { label: named.label, points: [] };
    bucket.points.push({
      nodeId: node.id,
      ...(node.sampledAt ? { at: node.sampledAt } : {}),
      value: numericOf(value) ?? String(value),
      valueText: node.valueText ?? String(value),
      ...(node.unit ? { unit: node.unit } : {}),
      flag: flagOf(value, node.referenceRange),
      origin: node.provenance.origin,
      humanConfirmed: node.humanConfirmed === true,
    });
    buckets.set(named.key, bucket);
  }

  const series: TrendSeries[] = [];
  for (const [key, bucket] of buckets) {
    /* 有时间的按时间升序；**没时间的排在最后**（不丢数据，但要让人看出来） */
    const timed = bucket.points.filter((point) => point.at !== undefined);
    const untimed = bucket.points.filter((point) => point.at === undefined);
    timed.sort((a, b) => (a.at as string).localeCompare(b.at as string));
    const points = [...timed, ...untimed];

    const numbers = points.map((point) => (typeof point.value === 'number' ? point.value : undefined)).filter((n): n is number => n !== undefined);
    const units = new Set(points.map((point) => point.unit).filter((unit): unit is string => unit !== undefined));
    const range = doc.nodes[points[0]?.nodeId as NodeId]?.type === 'field' ? (doc.nodes[points[0]?.nodeId as NodeId] as { referenceRange?: TrendSeries['referenceRange'] }).referenceRange : undefined;

    const warnings: string[] = [];
    if (untimed.length > 0) {
      warnings.push(`${untimed.length} 个采样点缺少采样时间（sampledAt），已排在末尾且不参与时间比较 —— 趋势图会因此不完整`);
    }
    if (units.size > 1) {
      warnings.push(`同一指标出现多种单位（${[...units].join(' / ')}），**不可直接比较**，需人工确认换算关系`);
    }
    if (points.some((point) => !point.humanConfirmed)) {
      warnings.push(`${points.filter((point) => !point.humanConfirmed).length} 个采样点尚未人工确认`);
    }
    if (numbers.length > 0 && numbers.length < points.length) {
      warnings.push('部分采样点不是数值（如"阴性"），未参与极值统计');
    }

    series.push({
      key,
      label: bucket.label,
      ...(units.size === 1 ? { unit: [...units][0] } : {}),
      ...(range ? { referenceRange: range } : {}),
      points,
      stats: {
        count: points.length,
        ...(numbers.length > 0
          ? {
              first: numbers[0],
              last: numbers[numbers.length - 1],
              min: Math.min(...numbers),
              max: Math.max(...numbers),
            }
          : {}),
        abnormal: points.filter((point) => point.flag === 'low' || point.flag === 'high').length,
        unconfirmed: points.filter((point) => !point.humanConfirmed).length,
      },
      warnings,
    });
  }

  /* 无法聚合的孤立点：如实报告 —— 硬凑成趋势比不给趋势更糟 */
  if (orphans.length > 0) {
    series.push({
      key: '(无法聚合)',
      label: '缺少 sourceKey 与标签的字段',
      points: [],
      stats: { count: 0, abnormal: 0, unconfirmed: 0 },
      warnings: [`${orphans.length} 个字段既没有 sourceKey 也没有标签，无法归入任何趋势：${orphans.join(', ')}`],
    });
  }

  return series.sort((a, b) => a.key.localeCompare(b.key));
}

/** 取单条趋势（按聚合键） */
export function buildTrend(doc: DocumentModel, key: string): TrendSeries | undefined {
  return buildTrends(doc).find((series) => series.key === key);
}
