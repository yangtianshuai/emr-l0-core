import type { AnnotationSeverity } from '../core/annotations.ts';
import type { DocumentModel, NodeId } from '../model/types.ts';
import { buildTrends } from '../model/trend.ts';
import type { PackRegistry } from '../knowledge/pack.ts';
import { visitTimelineOf } from './condition.ts';
import { compileRuleDescriptor, ruleItemsOf } from './rule-pack.ts';
import type { QcRule, QcRulePack, QcVisitDoc } from './types.ts';

export type CrossDocRuleKind = 'visit-doc-interval' | 'visit-doc-required';

export const CROSS_DOC_RULE_KINDS: readonly CrossDocRuleKind[] = ['visit-doc-interval', 'visit-doc-required'];

export interface VisitTimelineRuleRef {
  rule: QcRule;
  kind: CrossDocRuleKind;
  docTypeCode: string;
  hours: number;
}

export function crossDocRulesOf(registry: PackRegistry): VisitTimelineRuleRef[] {
  const out: VisitTimelineRuleRef[] = [];
  const summaries = [...registry.list('rule')].sort((left, right) => left.packId.localeCompare(right.packId));
  for (const summary of summaries) {
    const pack = registry.get(summary.packId) as QcRulePack | null;
    if (!pack) continue;
    for (const descriptor of ruleItemsOf(pack)) {
      if (descriptor.enabled === false) continue;
      const kind = descriptor.predicate?.kind;
      if (kind !== 'visit-doc-interval' && kind !== 'visit-doc-required') continue;
      const params = descriptor.predicate?.params;
      if (!params || typeof params !== 'object' || Array.isArray(params)) continue;
      const source = params as Record<string, unknown>;
      const docTypeCode = typeof source.docTypeCode === 'string' ? source.docTypeCode : '';
      const hours = kind === 'visit-doc-interval' ? source.maxGapHours : source.withinHours;
      if (docTypeCode === '' || typeof hours !== 'number' || !Number.isFinite(hours) || hours <= 0) continue;
      out.push({
        rule: compileRuleDescriptor(pack.packId, descriptor),
        kind,
        docTypeCode,
        hours,
      });
    }
  }
  return out;
}

export interface VisitTimelineDocInput {
  docId: string;
  title?: string;
  docTypeCode: string;
  docTypeDisplay?: string;
  createdAt: string;
  status?: string;
  isCurrent?: boolean;
  doc?: DocumentModel;
}

export interface VisitTimelineInput {
  /** 判定时刻（注入，不取 `Date.now()`：不可复现的结论没法复核） */
  now: string;
  visitId?: string;
  visitDocs: readonly VisitTimelineDocInput[];
  rules: readonly VisitTimelineRuleRef[];
  admittedAt?: string;
  dischargedAt?: string;
  visitType?: string;
  progressDocTypeCode?: string;
}

export interface VisitTimelineAxisDoc {
  docId: string;
  title: string;
  docTypeCode: string;
  docTypeDisplay: string | null;
  createdAt: string;
  status: string | null;
  isCurrent: boolean;
  timed: boolean;
  hasBody: boolean;
}

export interface VisitTimelineSegment {
  docTypeCode: string;
  fromDocId: string;
  fromAt: string;
  toDocId: string | null;
  toAt: string;
  hours: number;
  limitHours: number;
  exceeds: boolean;
}

export interface VisitTimelineGap {
  ruleId: string;
  title: string;
  severity: AnnotationSeverity;
  kind: CrossDocRuleKind;
  docTypeCode: string;
  detail: string;
  suggestion: string;
  segment: VisitTimelineSegment | null;
  deadlineAt?: string;
}

export interface VisitTimelineChange {
  key: string;
  label: string;
  unit?: string;
  nodeId: NodeId;
  docId: string;
  sampledAt: string;
  valueText: string;
  flag: 'low' | 'high';
  writtenIn: Array<{ docId: string; how: 'element' | 'text' }>;
  unwritten: boolean;
  detail: string;
}

export interface VisitTimelineTrend {
  progressDocIds: string[];
  changes: VisitTimelineChange[];
  skipped: Array<{ reason: string; count: number }>;
}

export interface VisitTimeline {
  visitId: string | null;
  visitType: string | null;
  admittedAt: string | null;
  dischargedAt: string | null;
  now: string;
  /** 间隔判定的右端：已出院取出院时刻，否则取判定时刻（与谓词同一规则） */
  endAt: string;
  docs: VisitTimelineAxisDoc[];
  segments: VisitTimelineSegment[];
  gaps: VisitTimelineGap[];
  trend: VisitTimelineTrend;
  unevaluated: Array<{ ruleId: string; title: string; reason: string }>;
  notes: string[];
}

const HOUR_MS = 3_600_000;

function parseAt(value: string | undefined | null): number | null {
  if (typeof value !== 'string' || value === '') return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
}

const isoOf = (ms: number): string => new Date(ms).toISOString();

function documentView(): Parameters<QcRule['check']>[0] {
  return { nodeId: 'n_root' as NodeId, type: 'document', text: '', tags: [], keyContent: false };
}

function textOf(doc: DocumentModel): string {
  const parts: string[] = [];
  for (const node of Object.values(doc.nodes)) {
    if (node.type === 'text') parts.push(node.runs.map((run) => run.text).join(''));
  }
  return parts.join('\n');
}

function intervalsByType(rules: readonly VisitTimelineRuleRef[]): Map<string, VisitTimelineRuleRef> {
  const out = new Map<string, VisitTimelineRuleRef>();
  for (const ref of rules) {
    if (ref.kind !== 'visit-doc-interval') continue;
    const current = out.get(ref.docTypeCode);
    if (!current || ref.hours < current.hours) out.set(ref.docTypeCode, ref);
  }
  return out;
}

function buildSegments(
  visitDocs: readonly VisitTimelineDocInput[],
  intervals: Map<string, VisitTimelineRuleRef>,
  endAt: number,
): { segments: VisitTimelineSegment[]; unreadable: string[] } {
  const segments: VisitTimelineSegment[] = [];
  const unreadable: string[] = [];
  for (const [docTypeCode, ref] of intervals) {
    const timeline = visitTimelineOf(visitDocs, docTypeCode);
    if (!timeline.ok) {
      unreadable.push(timeline.reason);
      continue;
    }
    const docs = timeline.docs;
    if (docs.length === 0) continue;
    const push = (from: { docId: string; at: number }, toDocId: string | null, toAt: number): void => {
      const hours = (toAt - from.at) / HOUR_MS;
      segments.push({
        docTypeCode,
        fromDocId: from.docId,
        fromAt: isoOf(from.at),
        toDocId,
        toAt: isoOf(toAt),
        hours,
        limitHours: ref.hours,
        exceeds: hours > ref.hours,
      });
    };
    for (let index = 1; index < docs.length; index += 1) {
      const from = docs[index - 1] as { docId: string; at: number };
      const to = docs[index] as { docId: string; at: number };
      push(from, to.docId, to.at);
    }
    push(docs[docs.length - 1] as { docId: string; at: number }, null, endAt);
  }
  return { segments, unreadable };
}

function widestOf(segments: readonly VisitTimelineSegment[], docTypeCode: string): VisitTimelineSegment | null {
  let worst: VisitTimelineSegment | null = null;
  for (const segment of segments) {
    if (segment.docTypeCode !== docTypeCode) continue;
    if (!worst || segment.hours > worst.hours) worst = segment;
  }
  return worst;
}

function toQcVisitDoc(doc: VisitTimelineDocInput): QcVisitDoc {
  return { docId: doc.docId, docTypeCode: doc.docTypeCode, createdAt: doc.createdAt, ...(doc.title ? { title: doc.title } : {}) };
}

interface TrendCheckInput {
  docs: readonly VisitTimelineDocInput[];
  changes: Array<{
    key: string;
    label: string;
    unit?: string;
    tags: Array<{ system: string; code: string; display?: string }>;
    nodeId: NodeId;
    docId: string;
    docAt: number;
    sampledAt: string;
    valueText: string;
    flag: 'low' | 'high';
  }>;
  skipped: Map<string, number>;
}

function compareTrends(input: TrendCheckInput): VisitTimelineChange[] {
  const out: VisitTimelineChange[] = [];
  for (const change of input.changes) {
    const later = input.docs
      .map((doc) => ({ doc, at: parseAt(doc.createdAt) }))
      .filter((item): item is { doc: VisitTimelineDocInput; at: number } => item.at !== null && item.at > change.docAt);
    if (later.length === 0) {
      input.skipped.set('本文书之后没有更晚的文书可比', (input.skipped.get('本文书之后没有更晚的文书可比') ?? 0) + 1);
      continue;
    }
    const writtenIn: Array<{ docId: string; how: 'element' | 'text' }> = [];
    for (const item of later) {
      const doc = item.doc.doc;
      if (!doc) continue;
      const recorded = Object.values(doc.nodes).some((node) => {
        if (node.type !== 'field') return false;
        return (node.tags ?? []).some((tag) =>
          change.tags.some((wanted) => wanted.system === tag.system && wanted.code === tag.code));
      });
      if (recorded) {
        writtenIn.push({ docId: item.doc.docId, how: 'element' });
        continue;
      }
      const names = [...change.tags.map((tag) => tag.display), change.label].filter(
        (name): name is string => typeof name === 'string' && name !== '' && !name.includes(':'),
      );
      const text = textOf(doc);
      if (names.some((name) => text.includes(name))) writtenIn.push({ docId: item.doc.docId, how: 'text' });
    }
    const unit = change.unit ? change.unit : '';
    out.push({
      key: change.key,
      label: change.label,
      ...(change.unit ? { unit: change.unit } : {}),
      nodeId: change.nodeId,
      docId: change.docId,
      sampledAt: change.sampledAt,
      valueText: change.valueText,
      flag: change.flag,
      writtenIn,
      unwritten: writtenIn.length === 0,
      detail: writtenIn.length === 0
        ? `${change.label} 在 ${change.sampledAt} 为 ${change.valueText}${unit}（${change.flag === 'high' ? '偏高' : '偏低'}），但这之后的文书里没有再记录或提到它`
        : `${change.label} 在 ${change.sampledAt} 为 ${change.valueText}${unit}（${change.flag === 'high' ? '偏高' : '偏低'}），后续文书已在 ${writtenIn.map((item) => item.docId).join('、')} 记录`,
    });
  }
  return out;
}

export function buildVisitTimeline(input: VisitTimelineInput): VisitTimeline {
  const notes: string[] = [];
  const unevaluated: Array<{ ruleId: string; title: string; reason: string }> = [];

  const nowAt = parseAt(input.now) ?? Date.now();
  const admittedAtMs = parseAt(input.admittedAt);
  const dischargedAt = parseAt(input.dischargedAt);
  const endAt = dischargedAt !== null && dischargedAt < nowAt ? dischargedAt : nowAt;

  const docs: VisitTimelineAxisDoc[] = input.visitDocs
    .map((doc) => ({
      docId: doc.docId,
      title: doc.title ?? doc.docId,
      docTypeCode: doc.docTypeCode,
      docTypeDisplay: doc.docTypeDisplay ?? null,
      createdAt: doc.createdAt,
      status: doc.status ?? null,
      isCurrent: doc.isCurrent === true,
      timed: parseAt(doc.createdAt) !== null,
      hasBody: !!doc.doc,
    }))
    .sort((left, right) => {
      const a = parseAt(left.createdAt);
      const b = parseAt(right.createdAt);
      if (a === null && b === null) return left.docId.localeCompare(right.docId);
      if (a === null) return 1;
      if (b === null) return -1;
      if (a !== b) return a - b;
      return left.docId.localeCompare(right.docId);
    });

  if (docs.length === 0) notes.push('这次就诊没有已加载的文书：轴上没有东西可摆。');
  if (docs.some((doc) => !doc.timed)) {
    notes.push(`有 ${docs.filter((doc) => !doc.timed).length} 份文书的成文时刻无法解析，它们不进间隔判定（跳过等于把缺漏算成正常）。`);
  }
  const intervals = intervalsByType(input.rules);
  if (intervals.size === 0) notes.push('没有启用"同类文书间隔"规则：轴上标不出时限，缺口只能看文书本身。');
  if (intervals.size > 1 && new Set(input.rules.filter((ref) => ref.kind === 'visit-doc-interval').map((ref) => ref.docTypeCode)).size !== intervals.size) {
    notes.push('同一类文书被多条间隔规则盯上：轴上按最严的那条画（各条规则本身照常出提示）。');
  }

  const { segments, unreadable } = buildSegments(input.visitDocs, intervals, endAt);
  if (unreadable.length > 0) {
    for (const ref of intervals.values()) {
      unevaluated.push({ ruleId: ref.rule.id, title: ref.rule.title, reason: unreadable.join('；') });
    }
  }

  const gaps: VisitTimelineGap[] = [];
  const visitDocs = input.visitDocs.map(toQcVisitDoc);
  for (const ref of input.rules) {
    const ctx = {
      now: input.now,
      visitDocs,
      docTypeCode: ref.docTypeCode,
      ...(input.admittedAt ? { admittedAt: input.admittedAt } : {}),
      ...(input.dischargedAt ? { dischargedAt: input.dischargedAt } : {}),
      ...(input.visitType ? { visitType: input.visitType } : {}),
    };
    const result = ref.rule.check(documentView(), ctx);
    if (!result) continue;
    if ('uncertain' in result) {
      unevaluated.push({ ruleId: ref.rule.id, title: ref.rule.title, reason: result.uncertain });
      continue;
    }
    const gap: VisitTimelineGap = {
      ruleId: ref.rule.id,
      title: ref.rule.title,
      severity: ref.rule.severity,
      kind: ref.kind,
      docTypeCode: ref.docTypeCode,
      detail: result.detail,
      suggestion: result.suggestion,
      segment: ref.kind === 'visit-doc-interval' ? widestOf(segments, ref.docTypeCode) : null,
    };
    if (ref.kind === 'visit-doc-required') {
      const admitted = parseAt(input.admittedAt);
      if (admitted !== null) gap.deadlineAt = isoOf(admitted + ref.hours * HOUR_MS);
    }
    gaps.push(gap);
  }

  const progressCode = input.progressDocTypeCode ?? 'WST500.3';
  const progressDocIds = docs.filter((doc) => doc.docTypeCode === progressCode).map((doc) => doc.docId);
  const skipped = new Map<string, number>();
  const changes: TrendCheckInput['changes'] = [];
  for (const doc of input.visitDocs) {
    if (!doc.doc) continue;
    const docAt = parseAt(doc.createdAt);
    if (docAt === null) continue;
    for (const series of buildTrends(doc.doc)) {
      for (const point of series.points) {
        if (point.flag !== 'low' && point.flag !== 'high') continue;
        if (point.at === undefined) {
          skipped.set('采样点没有采样时间（sampledAt），无法与后面的文书比先后', (skipped.get('采样点没有采样时间（sampledAt），无法与后面的文书比先后') ?? 0) + 1);
          continue;
        }
        const node = doc.doc.nodes[point.nodeId];
        const tags = (node && node.type === 'field' ? node.tags ?? [] : []).map((tag) => ({
          system: tag.system,
          code: tag.code,
          ...(tag.display ? { display: tag.display } : {}),
        }));
        changes.push({
          key: series.key,
          label: series.label,
          ...(series.unit ? { unit: series.unit } : {}),
          tags,
          nodeId: point.nodeId,
          docId: doc.docId,
          docAt,
          sampledAt: point.at,
          valueText: point.valueText,
          flag: point.flag,
        });
      }
    }
  }
  if (input.visitDocs.every((doc) => !doc.doc)) {
    skipped.set('这次请求没有带上任何文书的正文，趋势无从对照', input.visitDocs.length);
  }
  const trend: VisitTimelineTrend = {
    progressDocIds,
    changes: compareTrends({ docs: input.visitDocs, changes, skipped }),
    skipped: [...skipped.entries()]
      .filter(([, count]) => count > 0)
      .map(([reason, count]) => ({ reason, count })),
  };

  return {
    visitId: input.visitId ?? null,
    visitType: input.visitType ?? null,
    admittedAt: admittedAtMs === null ? input.admittedAt ?? null : isoOf(admittedAtMs),
    dischargedAt: dischargedAt === null ? input.dischargedAt ?? null : isoOf(dischargedAt),
    now: input.now,
    endAt: isoOf(endAt),
    docs,
    segments,
    gaps,
    trend,
    unevaluated,
    notes,
  };
}
