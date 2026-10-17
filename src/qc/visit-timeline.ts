/**
 * 就诊时间轴 —— 把**一次就诊的全部文书**摊在一条轴上。
 *
 * ## 为什么要有它
 *
 * 跨文书质控（`visit-doc-interval` / `visit-doc-required`）今天只能以**单条注解**的形式出现：
 * "两份病程记录之间超过 24 小时"落在当前文书的根节点上，与"这一章有个空占位符"长得一模一样。
 * 于是质控的实际形态仍是"逐条找错"，而不是"看整条线缺了什么" ——
 * 而缺口是**线**上的事，一条挂在节点上的提示表达不了它。
 *
 * 本模块把那些结论**放回线上**：文书按成文时刻排开，同类型文书之间画出间隔段
 * （超过时限的那一段就是缺口），并顺带对照"变化有没有写进后面的文书"。
 *
 * ## 三条纪律（与 `predicates.ts` 同源，不另立一份判定）
 *
 * 1) **判定只有一处**：缺口"报不报"由**已编译的跨文书规则**（`QcRule.check`）决定 ——
 *    与 `/api/qc-form-check` 跑的是同一批规则、同一个上下文，所以措辞逐字一致。
 *    本模块只补一件事：把结论**定位到轴上**（哪两份之间、多少小时）。定位走
 *    `visitTimelineOf`（与谓词共用同一个"哪几份、什么时候"），因此不存在第二份口径；
 *    "轴上有缺口 ⇔ 谓词命中"由 `visit-timeline-self-test.ts` 钉住。
 * 2) **不猜**：拿不到就诊文书清单 / 时间解析不出来 / 期限未到，一律走 `unevaluated`。
 *    "画不出来"绝不能被显示成"这条线是连的"。
 * 3) **只是提示**：`severity` 只影响呈现（与旁挂注解同一约定），不参与任何门控。
 *
 * ## 趋势对照的边界（这一节请与 `model/consistency.ts` 的文件头一起读）
 *
 * "变化是否已写入病程记录"有两种做法：
 *   · **语义判定**（"这段话在讲那个指标"）需要模型，而它的误报率在没有评测集的前提下
 *     无法声称 —— `consistency.ts` 已经因为同一个理由拒绝过一次，这里不翻案；
 *   · 本模块走**编码级 + 子串**：变化点之后只要有文书**再次记录了同一编码的数据元**，
 *     或正文里出现了该数据元的名称，就算"写进去了"。
 *     它覆盖不了全部情形（医生可能写"白细胞偏高"而不填字段），所以每条都写明依据，
 *     且**措辞是提示不是结论**；判不了的（缺采样时间 / 后面没有文书）如实进 `skipped`。
 */

import type { AnnotationSeverity } from '../core/annotations.ts';
import type { DocumentModel, NodeId } from '../model/types.ts';
import { buildTrends } from '../model/trend.ts';
import type { PackRegistry } from '../knowledge/pack.ts';
import { visitTimelineOf } from './condition.ts';
import { compileRuleDescriptor, ruleItemsOf } from './rule-pack.ts';
import type { QcRule, QcRulePack, QcVisitDoc } from './types.ts';

/** 本模块只认这两种判定方式（它们是唯二"看多份文书"的谓词） */
export type CrossDocRuleKind = 'visit-doc-interval' | 'visit-doc-required';

export const CROSS_DOC_RULE_KINDS: readonly CrossDocRuleKind[] = ['visit-doc-interval', 'visit-doc-required'];

/* ------------------------------ 规则引用 ------------------------------ */

/**
 * 一条跨文书规则在轴上的用法。
 *
 * `rule` 保持**已编译**的形态（不是原始 JSON）：报不报由它判，措辞也从它来 ——
 * 时间轴与质控注解因此说的是同一句话，而不是"两处各写一遍、慢慢不一致"。
 */
export interface VisitTimelineRuleRef {
  rule: QcRule;
  kind: CrossDocRuleKind;
  /** 规则盯的文书类型码（如 `WST500.3`） */
  docTypeCode: string;
  /** `visit-doc-interval` = 允许的最大间隔；`visit-doc-required` = 期限（单位都是小时） */
  hours: number;
}

/**
 * 从已装载的规则包里挑出**跨文书**规则（与 `rulesFromRegistry` 同一段迭代口径）。
 *
 * 为什么在这里重新迭代一遍、而不是从 `rulesFromRegistry` 的结果里筛：
 * 编译后的 `QcRule` 只带 `id / title / severity / check`，**判定方式与参数不在上面**
 * （那是包内容，不是引擎的接口）。要按"哪一类判定方式、盯哪一类文书、时限多少"来用它们，
 * 就必须回到条目那一层读 `predicate`。读写两处都走 `ruleItemsOf` 且都跳过 `enabled === false`，
 * 因此不会出现"质控跑了这条、时间轴没跑"。
 */
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
      /* 参数在装包那一刻已被 `normalizeParams` 校验过；这里再判一次形状，是为了让
         "包被手改过"这件事表现为**这条规则不进轴**，而不是 NaN 小时的缺口 */
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

/* ------------------------------- 输入 ------------------------------- */

export interface VisitTimelineDocInput {
  docId: string;
  title?: string;
  docTypeCode: string;
  docTypeDisplay?: string;
  /** `document.createdAt`：**成文时刻**，不是"最后一次被改"的时刻（见 `QcVisitDoc`） */
  createdAt: string;
  status?: string;
  /** 当前正在看的那一份（轴上要标出来） */
  isCurrent?: boolean;
  /** 正文。给了才能做"变化有没有写进后面的文书"的对照；不给则该文书不参与对照 */
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
  /** "病程记录"的类型码：趋势对照只认**它**（`WST500.3`），别处写的东西不算进过病程 */
  progressDocTypeCode?: string;
}

/* ------------------------------- 输出 ------------------------------- */

export interface VisitTimelineAxisDoc {
  docId: string;
  title: string;
  docTypeCode: string;
  docTypeDisplay: string | null;
  createdAt: string;
  status: string | null;
  isCurrent: boolean;
  /** 成文时刻能否解析。解析不出来的仍**留在轴上**（不静默丢掉），但不参与间隔判定 */
  timed: boolean;
  /** 该文书的正文是否在手上（不在手上时，趋势对照看不到它） */
  hasBody: boolean;
}

/** 轴上的一段：同类型文书之间（或最后一份到"出院/现在"那一段） */
export interface VisitTimelineSegment {
  docTypeCode: string;
  fromDocId: string;
  fromAt: string;
  /** `null` = 右端不是文书，而是出院时刻或判定时刻 */
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
  /** 与质控注解**逐字相同**的依据（同一条规则、同一个上下文算出来的） */
  detail: string;
  suggestion: string;
  /** 轴上的定位：最宽的那一段（间隔类）或期限（应有而缺类，此时段为 null） */
  segment: VisitTimelineSegment | null;
  /** `visit-doc-required` 才有：期限时刻 */
  deadlineAt?: string;
}

export interface VisitTimelineChange {
  key: string;
  label: string;
  unit?: string;
  nodeId: NodeId;
  docId: string;
  /** 变化发生的时刻（`field.sampledAt`） */
  sampledAt: string;
  valueText: string;
  flag: 'low' | 'high';
  /** 在哪些后续文书里"写进去了"（再次记录同一编码，或正文提到了它的名字） */
  writtenIn: Array<{ docId: string; how: 'element' | 'text' }>;
  unwritten: boolean;
  detail: string;
}

export interface VisitTimelineTrend {
  /** 参与对照的后续文书（病程记录） */
  progressDocIds: string[];
  changes: VisitTimelineChange[];
  /** 没对照成的：**如实报出**，不能当成"写进去了" */
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
  /** 需要人知道的前提（共几份文书、有没有规则在跑、有没有时间坏掉的文书） */
  notes: string[];
}

/* ------------------------------ 小工具 ------------------------------ */

const HOUR_MS = 3_600_000;

function parseAt(value: string | undefined | null): number | null {
  if (typeof value !== 'string' || value === '') return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
}

const isoOf = (ms: number): string => new Date(ms).toISOString();

/** 谓词侧只看"是不是一个文档级节点"，其余字段与判定无关 */
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

/* ------------------------------- 轴 ------------------------------- */

/**
 * 从规则里挑出"每种文书类型按哪条时限标"。
 *
 * 同一类型被多条间隔规则盯上时（例如全院 24 小时 + 产科 12 小时），轴上只画一条线：
 * 取**最严的那条**（小时数最小）。不这么做的话同一段会被画两遍，而两条线在界面上
 * 无法分辨，医生会以为"系统算错了"。规则各自仍会照常出注解 —— 这里只决定画哪条。
 */
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
      /* 时间坏掉的文书不能静默跳过（跳过 = 把"有一份时间坏了"读成"那段时间没文书"） */
      unreadable.push(timeline.reason);
      continue;
    }
    const docs = timeline.docs;
    if (docs.length === 0) continue; /* 一份都没有：那是"应有而缺"的职责，间隔规则不报 */
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
    /* 末尾那一段同样要判：最后一份之后一直没写，正是最常见的缺漏 */
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

/* ---------------------------- 趋势对照 ---------------------------- */

interface TrendCheckInput {
  docs: readonly VisitTimelineDocInput[];
  /** 起点的采样点（由 `buildVisitTimeline` 从各文书里聚合出来） */
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
  /** 判不了的计数（缺采样时间 / 后面没有文书） */
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
      /* 正文里提到了名字也算：医生用文字写了这次变化，系统不该说"没写" */
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

/* ------------------------------ 主函数 ------------------------------ */

export function buildVisitTimeline(input: VisitTimelineInput): VisitTimeline {
  const notes: string[] = [];
  const unevaluated: Array<{ ruleId: string; title: string; reason: string }> = [];

  const nowAt = parseAt(input.now) ?? Date.now();
  const admittedAtMs = parseAt(input.admittedAt);
  const dischargedAt = parseAt(input.dischargedAt);
  /* 右端取 min(now, 出院时刻)：已出院的就诊拿"现在"当右端，会把"出院之后"算成缺漏 ——
     那是最容易被当成系统坏了的那类假阳性（同 `visitDocInterval`）。 */
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
      /* 时间解析不出来的排在最后：不丢，但要让人看出来（同 `trend.ts` 对缺采样点的处置） */
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
  /* 时间坏掉的文书：轴画不出那一段，但结论仍在 —— 说出来，别让"画不出来"看起来像"线是连的" */
  if (unreadable.length > 0) {
    for (const ref of intervals.values()) {
      unevaluated.push({ ruleId: ref.rule.id, title: ref.rule.title, reason: unreadable.join('；') });
    }
  }

  /* 缺口：判定交给**已编译的规则**（与质控注解同一句话），定位交给轴上的段 */
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

  /* 趋势对照：只承认"病程记录"之后的文书 —— 写在别处不算进过病程 */
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
    /* 回显统一成 ISO 形态：`endAt` 是算出来的（必然 ISO），若这两格原样回显，
       界面上会出现"窗口 15:00 出院，右端 15:00:00.000"这种同一时刻两种写法的对照 ——
       看起来像两个不同的时间点。解析不出来的原样回显（要看得见它是坏的）。 */
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
