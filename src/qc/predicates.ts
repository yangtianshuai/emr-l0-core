/**
 * 质控谓词注册表（**封闭**）。
 *
 * ## 这里放什么、不放什么
 *
 * 放：判定本身 —— 正则、阈值、边界取舍。这些是**代码**，改动必须过评审与用例。
 * 不放：规则号、标题、级别、建议动作 —— 那些属于"怎么写规则"，由包提供（见 `rule-pack.ts`）。
 *
 * 这条分界线的用处：一个专科包可以改措辞、调阈值、关掉某条，但**改不了判定机制**，
 * 也无法新增一个"能写文档"的谓词。包能做的上限，由这份文件决定。
 *
 * ## 第 7 种判法为什么单起一个文件
 *
 * `field-condition`（条件树）让"判定条件"变成数据：适用范围、字段、算子、取值
 * 都能在管理后台拼出来，于是**新增规则不再需要改代码**。但**算子仍然是代码** ——
 * 它自己也有一份封闭清单，见 `condition.ts`。分界由此变成一句话：
 * **"判什么"可配，"怎么算"不可配**。边界取舍（读不到数据怎么办、哪些节点不判、
 * 什么时候算"判不了"）必须过评审、必须有用例，这是"宁可不报，不可误报"唯一的载体。
 *
 * ## 两条贯穿所有谓词的取向
 *
 * 1) **宁可不报，不可误报**：判定一律取保守方向。一条明显误报，会让医生此后
 *    忽略所有提示 —— 那时整套质控都失效了，这比漏报几条严重得多。
 * 2) **参数不合法就拒绝**：不做"取值不合法就用默认值"的兜底。兜底会让
 *    "我配的阈值没生效"变成一件没人能发现的事（有用的用例守着这条）。
 */

import type { JsonValue } from '../model/types.ts';
import { QC_PREDICATE_KINDS, type QcContext, type QcNodeView, type QcPredicateKind, type QcPredicateResult } from './types.ts';
/* `QcContext.visitDocs` 是跨文书判定的输入；类型上只依赖"哪一类文书、什么时候成的文" */
/* 共用的常量与参数小工具从 `condition.ts` 取：**同一份清单只能有一处**
   （时间表述的写法、就诊类型、参数名过滤都只写在那里，两处各写一份迟早漂移） */
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

/**
 * 参数的类型：界面据此决定给哪一种控件（数字格 / 文本框 / 下拉 / 词表）。
 *
 * 为什么把它的草稿处放在这里、而不写在界面上：参数名、类型与取值域**只有这一处**，
 * 界面照着生成表单。前端手抄一份的代价是——界面能选、引擎不认，而这类错误
 * 会一直潜伏到有人真的点了它（本仓库在表达式构造器上已经踩过一次，见 `EXPR_FUNCTIONS`）。
 */
export type QcParamKind =
  | 'integer'
  | 'number'
  | 'string'
  | 'enum'
  | 'string-list'
  /**
   * 条件树（`field-condition` 专用）。
   *
   * 它不是"多一种输入框"，而是一整块构造器：界面照 `conditionCatalog()` 下发的
   * 字段表与算子表长出"适用范围 + 条件 + 取值"三格。把它做成一个参数类型，
   * 是为了让"条件"走**同一条**参数校验与回显路径（读回 → 改 → 写回），
   * 而不是在规则表单里为它开一条旁路 —— 旁路是"少回显一格就静默清掉一次改动"的产地。
   */
  | 'condition'
  /**
   * **引用条件库里的具名条件**（`field-condition` 专用，与 `condition` 两选一）。
   *
   * 界面据此生成一个下拉，**选项来自服务端下发的条件目录**（`state.qcConditions`）——
   * 与前面几种一样，界面不自己抄一份清单。把它做成一个独立参数类型、而不是
   * "再给 `string` 加一格"，是因为"引用了什么"要能被认出来：保存前那句
   * "会影响哪几条规则"与删除时的引用保护，认的都是它。
   */
  | 'condition-ref'
  /**
   * **判定方式的实参**（T1 新增，与 `condition-ref` 配对使用）。
   *
   * 界面据此把"这条判定方式要填的几格"渲染成一组输入（规格来自服务端下发的条件目录）。
   * 校验分两段：这里只判"它是个对象"，**按规格判每一格**在编译期做（`rule-pack.ts`）——
   * 只有那一层拿得到判定方式的参数表。把它做成一个参数类型而不是"塞进 condition-ref 的值里"，
   * 是因为"这条规则填了哪几格"要能被单独认出来（回读、报错、界面回显都用它）。
   */
  | 'condition-args';

export interface QcParamSpec {
  name: string;
  kind: QcParamKind;
  /** 人话标签：界面上那一格的标题（不写中文名就等于逼使用者去读源码） */
  label: string;
  /** 必填：不给它这条规则根本没法判（如时限小时数），界面据此提前拦一次 */
  required?: boolean;
  /** `enum` 的可选值 */
  options?: readonly string[];
  /** 这一格填什么、留空会怎样、边界取在哪一边 —— 写成界面上能照读的一句话 */
  doc: string;
}

export interface QcPredicate {
  /** 谓词的人话名（界面"判定方式"下拉里那一行） */
  label: string;
  /** 这个谓词判什么、边界怎么取：下发给界面，省得前端再编一份说明 */
  doc: string;
  /** 参数规格（可序列化：界面与文档都读它） */
  paramsSpec: readonly QcParamSpec[];
  /**
   * 可配参数名。**由 `paramsSpec` 派生**，不手写第二份 ——
   * 两处各写一份迟早会漂移，而漂移的表现是"界面能配、引擎不认"。
   */
  readonly params: readonly string[];
  /**
   * 校验并归一化参数。
   * 返回 `null` = **参数不合法**（未知参数名、类型不对、取值越界）——
   * 调用方据此显式拒绝，而不是带着一份"以为配了、其实没配"的参数跑起来。
   */
  normalizeParams(raw: unknown): Record<string, JsonValue> | null;
  check(node: QcNodeView, params: Record<string, JsonValue>, ctx: QcContext): QcPredicateResult | null;
}

/** `paramsSpec` → 参数名清单（`params` 的唯一来源） */
function paramNamesOf(spec: readonly QcParamSpec[]): readonly string[] {
  return spec.map((item) => item.name);
}

/* ------------------------------ 判定用的正则 ------------------------------
   模板占位符残留的写法**只有一处**（`condition.ts` 的 `PLACEHOLDER_PATTERN`）：
   条件树的「含内置模式」用的就是它。两处各写一份的代价是"同一条规则在两种判法下
   给出不同结论"，而没人会想到去比对它们。 */

const DEFAULT_MISSING_TIME_MIN_LENGTH = 10;

/* 时间表述的正则（`TIME_PATTERNS` / `hasTimeExpression`）、就诊类型取值域、
   `asPlainObject` 与 `rejectUnknownParams` 都搬到了 `condition.ts`：
   条件树里有一档算子就是"缺少时间表述"，**同一份正则不能有两个拷贝** ——
   两份写得不一样时，同一条规则在两种判法下会给出不同结论，而且没人会想到去比对它们。 */

/* --------------------------- 参数规格（只写这一处） ---------------------------
   每份规格同时供三处使用：`paramsSpec`（下发给界面生成表单）、`params`（派生出的
   参数名清单，供装载期校验与文档展示）、以及下面 `normalizeParams` 里的判定。
   **不在这里另抄一份参数名**：两处各写一份迟早会漂移，而漂移的表现是
   "界面能配、引擎不认" —— 那类错误只会在有人真的点了它的时候才暴露。 */

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

/* ------------------------------- 谓词 ------------------------------- */

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
    /* 只对"记录类"文本判定：标题/短标签不算记录，对它们要求时间没有意义 */
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
    /* 只有**带数据元标签**且正文为空才算"必填为空"；
       没有标签的空白段落可能本就不必填，报它会误伤 */
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
      /* 空串会把"任何文本都命中"，等于把这条规则变成噪声源，因此直接拒绝而不是过滤掉 */
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
      /* quote 用命中片段本身：这段文字被改掉之后，锚点就该失效 ——
         拿整段当 quote 会让"改了一个字"也被判成"还在"，那正是重定位要避免的 */
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

/**
 * 时限类：**文书应在就诊/入院后 N 小时内完成**。
 *
 * ## 它为什么必须拿到上下文
 *
 * 前三个谓词都只看节点自己（"这段文字里有没有时间"），而时限判断的**另一半在文书之外**：
 * 入院/就诊时刻。所以它是第一个用 `ctx` 的谓词 —— 也是引擎契约从 `check(node)`
 * 扩到 `check(node, ctx)` 的原因。
 *
 * ## 判的是什么时间（**这条最容易被误解，所以写在明面上**）
 *
 * 用的是**系统内写入时刻**（节点 `provenance.at`），不是文书里写的临床记录时间。
 * 对"入院 8 小时内完成首次病程记录"这类要求，两者在正常情况下一致；但补录、迁移、
 * 外部导入会让它们**差出几天** —— 那时按写入时刻判会得出"严重超时"的错误结论。
 * 因此：
 *   1) 导入件（`origin === 'imported'`）**直接不判定**，走 `uncertain` 通道如实上报；
 *   2) 命中的依据里把**两个时间都写出来**，医生一眼能看出这个结论是怎么算的。
 *
 * ## 目标定位
 *
 * 按 `docTypeCode`（文书类型）/ `sectionCode`（章节码）/ `visitType`（就诊类型）过滤，
 * 三者都可省 —— 全省时对**所有文书/章节**判定。仅对 `document` 与 `section` 节点判定：
 * 时限是文书级要求，逐段落判会把同一件事重复报很多遍。
 *
 * ## 边界取保守
 *
 * 正好等于时限**不报**（要求是"在 N 小时内完成"，压线算完成）。
 */
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
      /* 空串会被当成"过滤条件为空"，于是规则静默地对全部文书生效 —— 直接拒绝 */
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
    /* 目标定位：**给了 `sectionCode` 就只判那一节；没给就只判文书级**（不逐章节判）。
       两条都是为了同一件事 —— 一条时限要求只该报**一次**。
       实测踩到：没做限制时，一份有 7 个章节的入院记录会得到 8 条一模一样的提示
       （文档根 + 每个章节各一条），而"质控提示"一旦变成噪声，医生就会全部忽略。 */
    if (node.type === 'section') {
      if (typeof params.sectionCode !== 'string') return null;
      if (node.sectionCode !== params.sectionCode) return null;
    }
    if (typeof params.docTypeCode === 'string' && ctx.docTypeCode !== params.docTypeCode) return null;
    if (typeof params.visitType === 'string' && ctx.visitType !== params.visitType) return null;

    const limitHours = params.limitHours as number;
    /* 从这里开始是"这条规则**适用**，但可能判不了" —— 判不了必须说出来，不能混进"没问题" */
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
    /* 记录时间晚于"现在"：时钟或数据有问题，此时算出来的间隔没有意义 */
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

/* --------------------------- 跨文书（频次/间隔） --------------------------- */

/** 频次类谓词共用的参数：必带一个小时代数 + 可选的就诊类型过滤 */
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

/**
 * 取出该就诊下**同一类文书**的成文时刻；有无法解析的 → 判不了（不猜）。
 *
 * 实现在 `condition.ts`（`visitTimelineOf`）里，这里只把 `ctx` 摊成它的入参 ——
 * 条件树的「同类文书间隔超过」用的就是同一份实现。两处各写一份的后果是
 * "同一件事在谓词与条件树里给出不同结论"，而那种差异不会有人去比对。
 */
function timelineOf(
  ctx: QcContext,
  docTypeCode: string,
): { ok: true; docs: Array<{ docId: string; at: number; title?: string }> } | { ok: false; reason: string } {
  return visitTimelineOf(ctx.visitDocs ?? [], docTypeCode);
}

const hours = (ms: number): number => ms / 3_600_000;
const showHours = (ms: number): string => hours(ms).toFixed(1);

/**
 * 频次类：**同一类文书之间不得超过 N 小时**（住院最常见的一条：病程记录）。
 *
 * ## 右端是"出院时刻"而不是"现在"
 *
 * 已出院的就诊若拿"现在"当右端，最后一段间隔会被算成"出院后一直没写病程记录" ——
 * 那是最容易被当成系统坏了的那类假阳性。所以右端取 `min(now, dischargedAt)`。
 *
 * ## 一份都没有时不报
 *
 * 那种情况由"应有某类文书"（`visit-doc-required`）负责。两条规则都报会得到两条重复提示，
 * 而"同一件事只提示一次"是这套质控能不能被看的前提。
 */
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
    if (docs.length === 0) return null; /* 由"应有该文书"那条规则负责，这里不报 */

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
    /* 末尾那一段同样要判：最后一份病程记录之后一直没写，正是最常见的缺漏 */
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

/**
 * 应有类：**入院后 N 小时内应当有某一类文书**（例如入院记录、首次病程记录）。
 *
 * 与 `document-time-limit` 的分工：那条判"有了但写晚了"，这条判"**压根没有**"。
 * 两者互斥 —— 都报会让医生收到两条关于同一件事的提示。
 * 期限未到时**不报**（还没到点就说"没有"是催命，不是质控）。
 */
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
    /* 期限还没到：此刻"没有"是正常的，报它就是催命 */
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

/* --------------------------- 自定义条件（第 7 种判法） --------------------------- */

const FIELD_CONDITION_PARAMS: readonly QcParamSpec[] = [
  {
    name: 'conditionId',
    kind: 'condition-ref',
    label: '引用条件库里的条件',
    /* 与 `when` **两选一**，所以两格都不标 required：
       标了 any 一格，界面就会把另一条路报成"没填" */
    doc: '从「基础数据 → 判定方式 → 条件库」里挑一条具名条件。它的好处是"改一处，引它的规则一起变"，代价也正在这句话上 —— 保存前界面会告诉你这一条会影响哪几条规则。与"就地拼一条"两选一。',
  },
  {
    name: 'when',
    kind: 'condition',
    label: '就地拼一条条件',
    doc: '自己拼一条判定：先圈适用范围（哪份文书、哪种就诊），再写"命中什么算违规"。可用的字段与算子由内核提供（管理后台「基础数据 → 判定方式」列了全表）。与"引用条件库"两选一 —— 只这一条规则要用的口径就地拼更省事，多几条规则共用同一口径才值得建一条具名条件。',
  },
  {
    name: 'args',
    kind: 'condition-args',
    label: '判定方式的实参',
    /* 它与 `conditionId` 是**配对的**（有引用才谈得上实参），所以不标 required：
       标了它，界面会把"就地拼一条"那条路也报成"没填" */
    doc: '给引用的判定方式填参数（如"时限 8 小时"）。要填哪几格由那条判定方式的参数表决定，界面照它渲染。只有引用了带参数的判定方式时才需要它 —— 多填一格会被拒（"填了不生效"是这套质控最不想留的错）。',
  },
];

/**
 * 自定义条件：**唯一一种由使用者拼出来的判法**。
 *
 * 它不取代前面 6 种，而是兜住"还没被命名为谓词"的那些需求 ——
 * 那 6 种各带着自己的边界取舍与用例（导入件拒判、出院时刻决定频次右端…），
 * 把它们拆成可拼装的原子，最容易丢的恰恰是那些边界。
 *
 * ## 它为什么仍然是"谓词"而不是另起一条通道
 *
 * 走同一条路（`predicate` 字段 + `normalizeParams` + `check`）换来的东西很实在：
 * 装包期校验、编辑期校验、编译期校验共用同一段代码，"条件写错"在还有人看着的时候
 * 就报出来；界面上的回显与读回也不必为它开旁路。开旁路是"少回显一格就静默清掉一次改动"的产地。
 */
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
    /* **两选一，且只能选一个**。两格都填时不能"以某个为准"：那等于承认一份数据里
       可以有两个互相矛盾的判定口径，而"哪一个是生效的"只能在代码里找答案。
       都不填时更糟 —— 它会存下一条永远不命中的规则，界面上一切正常。 */
    if (hasRef === hasInline) return null;
    /* 实参只对"引用"有意义：就地拼一条时它无处可代 —— 收下它等于收下一份不生效的输入 */
    if (source.args !== undefined && !hasRef) return null;
    if (hasRef) {
      const conditionId = source.conditionId;
      if (typeof conditionId !== 'string' || !QC_CONDITION_ID_PATTERN.test(conditionId)) return null;
      /* 引用只在这里做**形状**校验；"引用的条件到底在不在"、以及"实参对不对"
         由编译期对着包判（`rule-pack.ts`）—— 参数校验这一层看不到包，不该假装看得到 */
      const reference: Record<string, JsonValue> = { conditionId };
      if (source.args !== undefined) {
        const args = asPlainObject(source.args);
        if (!args) return null;
        reference.args = args as JsonValue;
      }
      return reference;
    }
    const when = normalizeCondition(source.when);
    /* 条件必须合法：**不合法即拒**，不做"看不懂就当没配"的兜底 ——
       兜底的表现是"规则建好了、质控里永远不出现"，而界面上一切正常 */
    if (!when) return null;
    const inline: Record<string, JsonValue> = { when: when as unknown as JsonValue };
    return inline;
  },
  check(node, params, ctx) {
    /* `when` 在编译期已经被填好：内联的直接用它，引用具名条件的由
       `rule-pack.ts` 把条件树解析进来（解析失败在装载期就报错，走不到这里）。
       真走到这里而没有 `when`，说明有人绕过了编译期 —— 那时**如实说判不了**，
       不能当成"没命中"：那会让一条根本没判的规则看起来正常运行。 */
    const when = params.when as unknown as QcConditionNode | undefined;
    if (!when) {
      return { uncertain: '这条规则引用的是条件库里的条件，但没有被解析成条件树（装载期本应拒绝这种状态）' };
    }
    const verdict = evaluateCondition(node, when, ctx);
    /* "判不了"原样往上传（缺入院时刻、导入件…）：它既不是命中，也不是"没问题" */
    if ('uncertain' in verdict) return { uncertain: verdict.uncertain };
    if (!verdict.hit) return null;
    /* 依据里必须写清"凭什么这么判"。条件树是使用者自己拼的，所以依据就是它的人话回读 ——
       医生据此复核，才有资格判断"这条提示是不是对的"。
       引用具名条件时**带上条件编码**：那条提示出自一份被多条规则共用的资产，
       编码是它在后台里唯一的抓手（改它会影响哪些规则，也靠它查）。 */
    const conditionId = typeof params.conditionId === 'string' ? params.conditionId : null;
    /* 富文案优先：跨文书那两档能说出"实际最长间隔 31.2 小时，自 … 到 …"，
       而整棵树的回读只能给出"间隔超过 文书类型码「WST500.3」、最大间隔 72 小时" */
    const explained = explainConditionHit(when, node, ctx);
    const subject = conditionId === null ? '命中本院的判定条件' : `命中本院的判定条件「${conditionId}」`;
    return {
      detail: explained ? `${subject}：${explained.detail}` : `${subject}：${describeCondition(when)}。`,
      suggestion: explained
        ? explained.suggestion
        : (conditionId === null
          ? '按本院的判定要求补正；若这条条件本身写得不对，去管理后台「规则库」调整它（不必改程序）。'
          : `按本院的判定要求补正；若这条条件本身写得不对，去管理后台「基础数据 → 判定方式」调整「${conditionId}」—— 它被多条规则共用，改一处会一起变。`),
      /* 命中片段原样带上去：它必须**逐字出现在正文里**（下游靠它做锚点重定位）。
         条件层给不出来时就不带（拿整段顶上会让"改了一个字"也算还在）。 */
      ...(explained?.quote === undefined ? {} : { quote: explained.quote }),
    };
  },
};

/**
 * 注册表。**新增谓词必须同时在这里登记并补用例** ——
 * 未登记的种类在编译包时会被明确拒绝（`E_RULE_PREDICATE_UNKNOWN`），不会静默跳过。
 */
export const QC_PREDICATES: Record<QcPredicateKind, QcPredicate> = {
  'text-missing-time': missingTime,
  'tagged-empty-text': taggedEmptyText,
  'placeholder-residue': placeholderResidue,
  'document-time-limit': documentTimeLimit,
  'visit-doc-interval': visitDocInterval,
  'visit-doc-required': visitDocRequired,
  'field-condition': fieldCondition,
};

/** 一份谓词的可下发投影（纯 JSON 值：界面不认函数，只认这份规格） */
export interface QcPredicateBrief {
  kind: QcPredicateKind;
  label: string;
  doc: string;
  params: QcParamSpec[];
}

/**
 * 谓词清单（下发界面用）：管理后台据此生成"判定方式"下拉与参数表单。
 *
 * 为什么要下发而不是让前端写死：**能配哪些参数**是判定机制的一部分，只有这一处知道。
 * 前端各写一份的后果是"界面能选、引擎不认"，而它只会在有人真的点了它的时候才暴露。
 * 顺序照 `QC_PREDICATE_KINDS`（与类型定义同一处），界面上看到的就是"有哪几种判定方式"。
 */
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
