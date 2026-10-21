import type { DataElementTag, DocumentModel, JsonValue, NodeId, ProvenanceOrigin } from './types.ts';
import { orderedNodeIds } from './machine.ts';

export type TrendFlag = 'low' | 'normal' | 'high' | 'unknown';

export interface TrendPoint {
  nodeId: NodeId;
  at?: string;
  value: number | string;
  valueText: string;
  unit?: string;
  flag: TrendFlag;
  origin: ProvenanceOrigin;
  humanConfirmed: boolean;
}

export interface TrendSeries {
  key: string;
  label: string;
  unit?: string;
  referenceRange?: { low?: number; high?: number; text?: string; unit?: string };
  points: TrendPoint[];
  stats: {
    count: number;
    first?: number;
    last?: number;
    min?: number;
    max?: number;
    abnormal: number;
    unconfirmed: number;
  };
  warnings: string[];
}

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

export function buildTrend(doc: DocumentModel, key: string): TrendSeries | undefined {
  return buildTrends(doc).find((series) => series.key === key);
}
