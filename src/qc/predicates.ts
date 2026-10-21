import type { JsonValue } from '../model/types.ts';
import { QC_PREDICATE_KINDS, type QcContext, type QcNodeView, type QcPredicateKind, type QcPredicateResult } from './types.ts';
import {
  asPlainObject,
  describeCondition,
  explainConditionHit,
  QC_CONDITION_ID_PATTERN,
  evaluateCondition,
  hasTimeExpression,
  normalizeCondition,
  PLACEHOLDER_PATTERN,
  rejectUnknownParams,
  VISIT_TYPES,
  visitTimelineOf,
  type QcConditionNode,
} from './condition.ts';

export type QcParamKind =
  | 'integer'
  | 'number'
  | 'string'
  | 'enum'
  | 'string-list'
  | 'condition'
  | 'condition-ref'
  | 'condition-args';

export interface QcParamSpec {
  name: string;
  kind: QcParamKind;
  label: string;
  required?: boolean;
  options?: readonly string[];
  doc: string;
}

export interface QcPredicate {
  label: string;
  doc: string;
  paramsSpec: readonly QcParamSpec[];
  readonly params: readonly string[];
  normalizeParams(raw: unknown): Record<string, JsonValue> | null;
  check(node: QcNodeView, params: Record<string, JsonValue>, ctx: QcContext): QcPredicateResult | null;
}

function paramNamesOf(spec: readonly QcParamSpec[]): readonly string[] {
  return spec.map((item) => item.name);
}

const DEFAULT_MISSING_TIME_MIN_LENGTH = 10;

const MISSING_TIME_PARAMS: readonly QcParamSpec[] = [
  {
    name: 'minLength',
    kind: 'integer',
    label: '最短长度（字）',
    doc: '段落短于它就不判：一行标题或标签要求记录时间没有意义。不填按内置值 10 判。必须是正整数。',
  },
];

const PLACEHOLDER_PARAMS: readonly QcParamSpec[] = [
  {
    name: 'extraWords',
    kind: 'string-list',
    label: '额外占位词',
    doc: '内置词（待补充 / 待填写 / TODO / XXX 等）之外，本院还要把哪些词算占位文字。每个词都不能为空（空词会让任何文本都命中）。',
  },
];

const TIME_LIMIT_PARAMS: readonly QcParamSpec[] = [
  {
    name: 'limitHours',
    kind: 'number',
    label: '时限（小时）',
    required: true,
    doc: '超过它才算超时；正好等于不报（要求是"在 N 小时内完成"，压线算完成）。必须大于 0。',
  },
  {
    name: 'docTypeCode',
    kind: 'string',
    label: '限定文书类型码',
    doc: '只判这一类文书，如 WST500.1（入院记录）。留空 = 所有文书都判。',
  },
  {
    name: 'sectionCode',
    kind: 'string',
    label: '限定章节码',
    doc: '只判这一章。留空 = 只判文书级（不逐章重复报同一条）。',
  },
  {
    name: 'visitType',
    kind: 'enum',
    label: '限定就诊类型',
    options: VISIT_TYPES,
    doc: '只判这类就诊。留空 = 不限（同一时限在不同就诊类型下未必通用）。',
  },
];

const VISIT_INTERVAL_PARAMS: readonly QcParamSpec[] = [
  {
    name: 'docTypeCode',
    kind: 'string',
    label: '文书类型码',
    required: true,
    doc: '按哪一类文书的成文时刻算间隔，如 WST500.3（病程记录）。必填 —— 没有它无从知道在算谁之间的间隔。',
  },
  {
    name: 'maxGapHours',
    kind: 'number',
    label: '最大间隔（小时）',
    required: true,
    doc: '同类文书之间不得超过它。必须大于 0。已出院时右端取出院时刻（不把"出院后没再写"算成缺漏）。',
  },
  {
    name: 'visitType',
    kind: 'enum',
    label: '限定就诊类型',
    options: VISIT_TYPES,
    doc: '只判这类就诊。留空 = 不限。',
  },
];

const VISIT_REQUIRED_PARAMS: readonly QcParamSpec[] = [
  {
    name: 'docTypeCode',
    kind: 'string',
    label: '文书类型码',
    required: true,
    doc: '哪一类文书应当有，如 WST500.1（入院记录）。必填。',
  },
  {
    name: 'withinHours',
    kind: 'number',
    label: '期限内（小时）',
    required: true,
    doc: '就诊/入院后多少小时内应当有。必须大于 0。期限未到不报 —— 还没到点就说"没有"是催命，不是质控。',
  },
  {
    name: 'visitType',
    kind: 'enum',
    label: '限定就诊类型',
    options: VISIT_TYPES,
    doc: '只判这类就诊。留空 = 不限。',
  },
];

const missingTime: QcPredicate = {
  label: '记录类段落缺记录时间',
  doc: '记录类段落里必须出现时间表述（2026-10-09 / 10月9日 / 14:30 / 14时 等写法之一）。短于阈值的小节不判 —— 在标题与短标签上要求时间只会造成误报。',
  paramsSpec: MISSING_TIME_PARAMS,
  params: paramNamesOf(MISSING_TIME_PARAMS),
  normalizeParams(raw) {
    const source = raw === undefined || raw === null ? {} : asPlainObject(raw);
    if (!source) return null;
    if (!rejectUnknownParams(source, this.params)) return null;
    const out: Record<string, JsonValue> = {};
    if (source.minLength !== undefined) {
      const value = source.minLength;
      /* 阈值必须是正整数：`0` / 负数 / 小数会让"缺时间"在标题与短标签上疯狂误报 */
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) return null;
      out.minLength = value;
    }
    return out;
  },
  check(node, params) {
    if (node.type !== 'text') return null;
    const minLength = typeof params.minLength === 'number' ? params.minLength : DEFAULT_MISSING_TIME_MIN_LENGTH;
    if (node.text.trim().length < minLength) return null;
    if (hasTimeExpression(node.text)) return null;
    return {
      detail:
        '记录类段落应包含记录时间。本段未识别到任何时间表述（已按 2026-10-09 / 10月9日 / 14:30 / 14时 等写法检查）。',
      suggestion: '补记记录时间，并核对与上一条记录的时间间隔。',
    };
  },
};

const taggedEmptyText: QcPredicate = {
  label: '必填数据元的段落内容为空',
  doc: '带数据元标签、但正文为空的段落。没有标签的空白段落不判 —— 它可能本就不必填，报它会误伤。这条规则不接受参数。',
  paramsSpec: [],
  params: paramNamesOf([]),
  normalizeParams(raw) {
    const source = raw === undefined || raw === null ? {} : asPlainObject(raw);
    if (!source) return null;
    if (!rejectUnknownParams(source, this.params)) return null;
    return {};
  },
  check(node) {
    if (node.type !== 'text') return null;
    if (node.tags.length === 0) return null;
    if (node.text.trim() !== '') return null;
    return {
      detail: `本段带数据元标签（${node.tags.join('、')}）但正文为空。`,
      suggestion: '补齐该数据元对应内容，或确认本段确实无需填写（可标记误报）。',
    };
  },
};

const placeholderResidue: QcPredicate = {
  label: '模板占位符未替换',
  doc: '正文里还留着"待补充 / TODO / XXX"之类的占位文字。它会被下游（打印、导出、机读）当成真实内容，所以要在文书里查出来。',
  paramsSpec: PLACEHOLDER_PARAMS,
  params: paramNamesOf(PLACEHOLDER_PARAMS),
  normalizeParams(raw) {
    const source = raw === undefined || raw === null ? {} : asPlainObject(raw);
    if (!source) return null;
    if (!rejectUnknownParams(source, this.params)) return null;
    const out: Record<string, JsonValue> = {};
    if (source.extraWords !== undefined) {
      const value = source.extraWords;
      if (!Array.isArray(value)) return null;
      if (!value.every((word): word is string => typeof word === 'string' && word.trim() !== '')) return null;
      out.extraWords = value as JsonValue;
    }
    return out;
  },
  check(node, params) {
    if (node.type !== 'text') return null;
    const matched = matchPlaceholder(node.text, params.extraWords);
    if (!matched) return null;
    return {
      quote: matched,
      detail: `本段含未替换的模板占位文字"${matched}"。占位符留在正文里，会被下游（打印、导出、机读）当成真实内容。`,
      suggestion: `把"${matched}"替换为实际内容。`,
    };
  },
};

function matchPlaceholder(text: string, extraWords: JsonValue | undefined): string | null {
  const builtin = PLACEHOLDER_PATTERN.exec(text);
  if (builtin) return builtin[0];
  if (!Array.isArray(extraWords)) return null;
  for (const word of extraWords) {
    if (typeof word !== 'string') continue;
    if (word !== '' && text.includes(word)) return word;
  }
  return null;
}

const documentTimeLimit: QcPredicate = {
  label: '文书未在时限内完成',
  doc: '按系统内写入时刻判：文书应在就诊/入院后 N 小时内完成。外部导入件不判定（按写入时刻判补录件会得出"严重超时"的错误结论）—— 那时走"判不了"通道如实上报。',
  paramsSpec: TIME_LIMIT_PARAMS,
  params: paramNamesOf(TIME_LIMIT_PARAMS),
  normalizeParams(raw) {
    const source = raw === undefined || raw === null ? {} : asPlainObject(raw);
    if (!source) return null;
    if (!rejectUnknownParams(source, this.params)) return null;

    const limit = source.limitHours;
    /* 时限本身必填且必须是正数：缺它会得到"所有文书都超时"或"都不超时"，两种都是错的 */
    if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) return null;
    const out: Record<string, JsonValue> = { limitHours: limit };

    for (const key of ['docTypeCode', 'sectionCode'] as const) {
      const value = source[key];
      if (value === undefined) continue;
      if (typeof value !== 'string' || value.trim() === '') return null;
      out[key] = value;
    }
    const visitType = source.visitType;
    if (visitType !== undefined) {
      if (typeof visitType !== 'string' || !(VISIT_TYPES as readonly string[]).includes(visitType)) return null;
      out.visitType = visitType;
    }
    return out;
  },
  check(node, params, ctx) {
    if (node.type !== 'document' && node.type !== 'section') return null;
    if (node.type === 'section') {
      if (typeof params.sectionCode !== 'string') return null;
      if (node.sectionCode !== params.sectionCode) return null;
    }
    if (typeof params.docTypeCode === 'string' && ctx.docTypeCode !== params.docTypeCode) return null;
    if (typeof params.visitType === 'string' && ctx.visitType !== params.visitType) return null;

    const limitHours = params.limitHours as number;
    if (ctx.admittedAt === undefined || ctx.admittedAt === '') {
      return { uncertain: '本文书没有就诊/入院时间（文档 encounter.admittedAt），时限无法计算' };
    }
    if (node.origin === 'imported') {
      return { uncertain: '本文书由外部导入：系统内写入时刻不代表它的临床记录时间，按写入时刻判时限会得出错误结论' };
    }
    if (node.recordedAt === undefined || node.recordedAt === '') {
      return { uncertain: '该节点没有记录时间（provenance.at），时限无法计算' };
    }
    const baseline = Date.parse(ctx.admittedAt);
    const recorded = Date.parse(node.recordedAt);
    const now = Date.parse(ctx.now);
    if (!Number.isFinite(baseline)) return { uncertain: `入院时间无法解析：${ctx.admittedAt}` };
    if (!Number.isFinite(recorded)) return { uncertain: `记录时间无法解析：${node.recordedAt}` };
    if (!Number.isFinite(now)) return { uncertain: `判定时刻无法解析：${ctx.now}` };
    if (recorded > now) return { uncertain: `记录时间（${node.recordedAt}）晚于判定时刻（${ctx.now}），数据或时钟可能异常` };

    const elapsedHours = (recorded - baseline) / 3_600_000;
    if (elapsedHours <= limitHours) return null;
    return {
      detail:
        `本文书应在就诊/入院后 ${limitHours} 小时内完成。` +
        `入院/就诊时间 ${ctx.admittedAt}（文档 encounter.admittedAt），` +
        `本文书记录时间 ${node.recordedAt}（系统内写入时刻），实际间隔 ${elapsedHours.toFixed(1)} 小时。`,
      suggestion:
        '核对文书时间是否满足时限要求；若本次为补录或外部导入，请以原件时间为准 —— ' +
        '本条判定用的是系统内写入时刻，代表不了补录件的真实记录时间。',
    };
  },
};

function normalizeVisitParams(
  raw: unknown,
  hoursKey: 'maxGapHours' | 'withinHours',
  allowed: readonly string[],
): Record<string, JsonValue> | null {
  const source = raw === undefined || raw === null ? {} : asPlainObject(raw);
  if (!source) return null;
  if (!rejectUnknownParams(source, allowed)) return null;

  const code = source.docTypeCode;
  if (typeof code !== 'string' || code.trim() === '') return null;
  const hours = source[hoursKey];
  if (typeof hours !== 'number' || !Number.isFinite(hours) || hours <= 0) return null;

  const out: Record<string, JsonValue> = { docTypeCode: code, [hoursKey]: hours };
  const visitType = source.visitType;
  if (visitType !== undefined) {
    if (typeof visitType !== 'string' || !(VISIT_TYPES as readonly string[]).includes(visitType)) return null;
    out.visitType = visitType;
  }
  return out;
}

function timelineOf(
  ctx: QcContext,
  docTypeCode: string,
): { ok: true; docs: Array<{ docId: string; at: number; title?: string }> } | { ok: false; reason: string } {
  return visitTimelineOf(ctx.visitDocs ?? [], docTypeCode);
}

const hours = (ms: number): number => ms / 3_600_000;
const showHours = (ms: number): string => hours(ms).toFixed(1);

const visitDocInterval: QcPredicate = {
  label: '同类文书之间的间隔超限',
  doc: '同一次就诊内，同一类文书的成文时刻之间不得超过 N 小时（含最后一份到出院/现在那一段）。一份都没有时不报 —— 那种情况由"应有某类文书"那条规则负责，两条都报会得到重复提示。',
  paramsSpec: VISIT_INTERVAL_PARAMS,
  params: paramNamesOf(VISIT_INTERVAL_PARAMS),
  normalizeParams(raw) {
    return normalizeVisitParams(raw, 'maxGapHours', this.params);
  },
  check(node, params, ctx) {
    if (node.type !== 'document') return null;
    if (typeof params.visitType === 'string' && ctx.visitType !== params.visitType) return null;

    if (ctx.visitDocs === undefined) {
      return { uncertain: '本次判定没有拿到同一次就诊的文书清单，频次无法计算' };
    }
    const timeline = timelineOf(ctx, params.docTypeCode as string);
    if (!timeline.ok) return { uncertain: timeline.reason };
    const docs = timeline.docs;
    if (docs.length === 0) return null;

    const now = Date.parse(ctx.now);
    if (!Number.isFinite(now)) return { uncertain: `判定时刻无法解析：${ctx.now}` };
    const discharged = ctx.dischargedAt === undefined ? Number.NaN : Date.parse(ctx.dischargedAt);
    const end = Number.isFinite(discharged) ? Math.min(now, discharged) : now;
    const endLabel = Number.isFinite(discharged) && discharged < now ? `出院时刻 ${ctx.dischargedAt}` : `判定时刻 ${ctx.now}`;

    const maxGap = params.maxGapHours as number;
    let worst = { gap: Number.NEGATIVE_INFINITY, from: docs[0] as { docId: string; at: number }, toLabel: '' };
    for (let index = 1; index < docs.length; index += 1) {
      const from = docs[index - 1] as { docId: string; at: number };
      const to = docs[index] as { docId: string; at: number };
      const gap = to.at - from.at;
      if (gap > worst.gap) worst = { gap, from, toLabel: `下一份（${to.docId}）` };
    }
    const tail = end - (docs[docs.length - 1] as { at: number }).at;
    if (tail > worst.gap) {
      worst = { gap: tail, from: docs[docs.length - 1] as { docId: string; at: number; title?: string }, toLabel: endLabel };
    }

    if (worst.gap <= maxGap * 3_600_000) return null;
    return {
      detail:
        `同类文书（${params.docTypeCode as string}）之间不得超过 ${maxGap} 小时，` +
        `实际最长间隔 ${showHours(worst.gap)} 小时：自 ${new Date(worst.from.at).toISOString()}（${worst.from.docId}）到 ${worst.toLabel}。` +
        `本次就诊共 ${docs.length} 份该类文书。`,
      suggestion: '补记缺漏的文书；若该时段确实无需记录（如已转科、已出院），请核对该就诊的起止时间是否准确。',
    };
  },
};

const visitDocRequired: QcPredicate = {
  label: '应有而缺的文书',
  doc: '就诊/入院后 N 小时内应当有某一类文书（例如入院记录、首次病程记录）。期限未到不报；与"未在时限内完成"互斥 —— 那条判"有了但写晚了"，这条判"压根没有"。',
  paramsSpec: VISIT_REQUIRED_PARAMS,
  params: paramNamesOf(VISIT_REQUIRED_PARAMS),
  normalizeParams(raw) {
    return normalizeVisitParams(raw, 'withinHours', this.params);
  },
  check(node, params, ctx) {
    if (node.type !== 'document') return null;
    if (typeof params.visitType === 'string' && ctx.visitType !== params.visitType) return null;

    if (ctx.visitDocs === undefined) {
      return { uncertain: '本次判定没有拿到同一次就诊的文书清单，无法判断"应有而缺"的文书' };
    }
    if (ctx.admittedAt === undefined || ctx.admittedAt === '') {
      return { uncertain: '本文书没有就诊/入院时间（文档 encounter.admittedAt），期限无法计算' };
    }
    const baseline = Date.parse(ctx.admittedAt);
    const now = Date.parse(ctx.now);
    if (!Number.isFinite(baseline)) return { uncertain: `入院时间无法解析：${ctx.admittedAt}` };
    if (!Number.isFinite(now)) return { uncertain: `判定时刻无法解析：${ctx.now}` };

    const withinHours = params.withinHours as number;
    const deadline = baseline + withinHours * 3_600_000;
    if (now <= deadline) return null;

    const timeline = timelineOf(ctx, params.docTypeCode as string);
    if (!timeline.ok) return { uncertain: timeline.reason };
    const docs = timeline.docs;
    if (docs.some((item) => item.at <= deadline)) return null;

    const earliest = docs.length > 0 ? `，最早一份是 ${new Date((docs[0] as { at: number }).at).toISOString()}（${(docs[0] as { docId: string }).docId}）` : '';
    return {
      detail:
        `入院后 ${withinHours} 小时内应当有「${params.docTypeCode as string}」类文书，` +
        `实际该期限内没有任何一份${earliest}。入院时间 ${ctx.admittedAt}，期限 ${new Date(deadline).toISOString()}。`,
      suggestion: '补写该文书；若该文书存在于其它系统，请确认是否已完成数据对接（本系统只统计已进入本系统的文书）。',
    };
  },
};

const FIELD_CONDITION_PARAMS: readonly QcParamSpec[] = [
  {
    name: 'conditionId',
    kind: 'condition-ref',
    label: '引用条件库里的条件',
    doc: '从「知识资产 → 判定方式 → 条件库」里挑一条具名条件。它的好处是"改一处，引它的规则一起变"，代价也正在这句话上 —— 保存前界面会告诉你这一条会影响哪几条规则。与"就地拼一条"两选一。',
  },
  {
    name: 'when',
    kind: 'condition',
    label: '就地拼一条条件',
    doc: '自己拼一条判定：先圈适用范围（哪份文书、哪种就诊），再写"命中什么算违规"。可用的字段与算子由内核提供（管理后台「知识资产 → 判定方式」列了全表）。与"引用条件库"两选一 —— 只这一条规则要用的口径就地拼更省事，多几条规则共用同一口径才值得建一条具名条件。',
  },
  {
    name: 'args',
    kind: 'condition-args',
    label: '判定方式的实参',
    doc: '给引用的判定方式填参数（如"时限 8 小时"）。要填哪几格由那条判定方式的参数表决定，界面照它渲染。只有引用了带参数的判定方式时才需要它 —— 多填一格会被拒（"填了不生效"是这套质控最不想留的错）。',
  },
];

const fieldCondition: QcPredicate = {
  label: '自定义条件',
  doc: '自己拼一条判定：适用范围（文书类型码 / 就诊类型）+ 条件（字段 · 算子 · 取值）。字段与算子是内核提供的封闭清单（判法可以配，"怎么算"不能配）—— 它们决定了读不到数据时算不算命中、边界取在哪一边这类取舍。',
  paramsSpec: FIELD_CONDITION_PARAMS,
  params: paramNamesOf(FIELD_CONDITION_PARAMS),
  normalizeParams(raw) {
    const source = raw === undefined || raw === null ? {} : asPlainObject(raw);
    if (!source) return null;
    if (!rejectUnknownParams(source, this.params)) return null;
    const hasRef = source.conditionId !== undefined;
    const hasInline = source.when !== undefined;
    if (hasRef === hasInline) return null;
    if (source.args !== undefined && !hasRef) return null;
    if (hasRef) {
      const conditionId = source.conditionId;
      if (typeof conditionId !== 'string' || !QC_CONDITION_ID_PATTERN.test(conditionId)) return null;
      const reference: Record<string, JsonValue> = { conditionId };
      if (source.args !== undefined) {
        const args = asPlainObject(source.args);
        if (!args) return null;
        reference.args = args as JsonValue;
      }
      return reference;
    }
    const when = normalizeCondition(source.when);
    if (!when) return null;
    const inline: Record<string, JsonValue> = { when: when as unknown as JsonValue };
    return inline;
  },
  check(node, params, ctx) {
    const when = params.when as unknown as QcConditionNode | undefined;
    if (!when) {
      return { uncertain: '这条规则引用的是条件库里的条件，但没有被解析成条件树（装载期本应拒绝这种状态）' };
    }
    const verdict = evaluateCondition(node, when, ctx);
    if ('uncertain' in verdict) return { uncertain: verdict.uncertain };
    if (!verdict.hit) return null;
    const conditionId = typeof params.conditionId === 'string' ? params.conditionId : null;
    const explained = explainConditionHit(when, node, ctx);
    const subject = conditionId === null ? '命中本院的判定条件' : `命中本院的判定条件「${conditionId}」`;
    return {
      detail: explained ? `${subject}：${explained.detail}` : `${subject}：${describeCondition(when)}。`,
      suggestion: explained
        ? explained.suggestion
        : (conditionId === null
          ? '按本院的判定要求补正；若这条条件本身写得不对，去管理后台「规则库」调整它（不必改程序）。'
          : `按本院的判定要求补正；若这条条件本身写得不对，去管理后台「知识资产 → 判定方式」调整「${conditionId}」—— 它被多条规则共用，改一处会一起变。`),
      ...(explained?.quote === undefined ? {} : { quote: explained.quote }),
    };
  },
};

export const QC_PREDICATES: Record<QcPredicateKind, QcPredicate> = {
  'text-missing-time': missingTime,
  'tagged-empty-text': taggedEmptyText,
  'placeholder-residue': placeholderResidue,
  'document-time-limit': documentTimeLimit,
  'visit-doc-interval': visitDocInterval,
  'visit-doc-required': visitDocRequired,
  'field-condition': fieldCondition,
};

export interface QcPredicateBrief {
  kind: QcPredicateKind;
  label: string;
  doc: string;
  params: QcParamSpec[];
}

export function qcPredicateCatalog(): QcPredicateBrief[] {
  return QC_PREDICATE_KINDS.map((kind) => {
    const predicate = QC_PREDICATES[kind];
    return {
      kind,
      label: predicate.label,
      doc: predicate.doc,
      params: predicate.paramsSpec.map((spec) => ({
        name: spec.name,
        kind: spec.kind,
        label: spec.label,
        doc: spec.doc,
        ...(spec.required === true ? { required: true } : {}),
        ...(spec.options ? { options: [...spec.options] } : {}),
      })),
    };
  });
}
