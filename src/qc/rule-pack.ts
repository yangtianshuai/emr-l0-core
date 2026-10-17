/**
 * 规则包：把「声明式描述符」编译成「可运行的 QcRule」。
 *
 * ## 三条约束（都是为了让包"只能做它该做的事"）
 *
 * 1) **规则号由编译期注入，不由包提供**。包给的是标题、级别、建议与（可选的）依据文案，
 *    编译后每条判定都会带上 `规则 <ruleId>：` 前缀。于是包**无法伪造或隐藏自己的身份** ——
 *    医生看到的依据永远能追到注册表里真实存在的那一条。
 * 2) **谓词只能从封闭注册表里选**。未知种类在编译期直接拒绝（`E_RULE_PREDICATE_UNKNOWN`），
 *    不会静默跳过 —— 静默跳过会让"规则没生效"变成一件没人发现的事。
 * 3) **参数不合法与未知参数名一律拒绝**。不做"取值不合法就用默认值"的兜底：
 *    兜底会让"我配的阈值没生效"永远查不出来。
 * 4) **引用判定方式的规则，那条判定方式必须在库里**（`itemType: 'condition'`）。
 *    悬空引用在**装载那一刻**就被拒（`E_RULE_CONDITION_UNKNOWN`），而不是等到扫描时
 *    少跑一条。
 *
 *    ## 判定方式是**库级资产**（2026-10-16 定稿）
 *
 *    它曾经是"包内容、只允许同包引用"，代价是**交付方包里的规则永远用不上具名判定方式**
 *    （那些包里没有判定方式，而规则抽屉只列本包的那几条）。定稿的模型是：
 *    判定方式存在**库里**（与科室字典同级：全院一份、不在任何包里），任何包的规则都能引用。
 *    改一条判定方式，所有引用它的规则一起变 —— 这才是"具名资产"的价值所在。
 *
 *    包内仍可以带 `itemType: 'condition'` 条目，那是两种情形：
 *      - **老库还没迁移**（方案 B 时代把种子写进了自建包）：库里那份这时是空的，包内生效；
 *      - **包自带的私有判定方式**（交付方随包给的，编码不与库里撞）。
 *    **库优先**：同码时以库里那份为准（库里那份归本院维护）。装载报告里会说一句，
 *    迁移会把包里那份同码条目删掉。
 *
 * ## 具名条件怎么进到判定里
 *
 * 条件树在**编译期**解析进来（`params.conditionId` → 条件树填进 `params.when`），
 * 而不是在扫描时按 id 现查：判定函数只拿到参数，运行时不该再去访问注册表
 * （那是"判定是纯函数"的边界）。于是"改一条条件"这件事的生效方式很直接 ——
 * 换了一版包内容，重新装配规则集，所有引用它的规则一起变。
 *
 * ## 为什么编译发生在装载期，而不是每次扫描时
 *
 * 一条规则若参数写错，应当在**装包那一刻**就报错（那时还有人看着），
 * 而不是等到医生点了"跑质控"才发现"怎么少了一条"。所以这里同时导出
 * `validateRulePack` 供 `PackRegistry.load` 的 `validate` 钩子使用；
 * 它与编译共用同一段校验代码，不存在"两处判断不一致"的可能。
 */

import type { AnnotationSeverity } from '../core/annotations.ts';
import type { JsonValue } from '../model/types.ts';
import type { PackItemBase, PackRegistry } from '../knowledge/pack.ts';
import {
  collectPlaceholders,
  describeCondition,
  normalizeCondition,
  normalizeConditionParams,
  placeholderNameOf,
  QC_CONDITION_ID_PATTERN,
  substitutePlaceholders,
  validateConditionArgs,
  type QcConditionNode,
} from './condition.ts';
import { QC_PREDICATES, type QcPredicate } from './predicates.ts';
import type {
  QcConditionDefinition,
  QcConditionParamSpec,
  QcPredicateKind,
  QcRule,
  QcRuleDescriptor,
  QcRuleItem,
  QcRulePack,
} from './types.ts';

/** 本规则引擎的契约版本。包必须精确声明它，见 `knowledge/pack.ts` 文件头 */
export const RULE_ENGINE_API = 'qc-rule/1';

export const SUPPORTED_RULE_ENGINE_APIS: readonly string[] = [RULE_ENGINE_API];

const SEVERITIES: readonly AnnotationSeverity[] = ['info', 'warn', 'block'];

export type RulePackErrorCode =
  | 'E_RULE_ITEM_INVALID'
  | 'E_RULE_SEVERITY_INVALID'
  | 'E_RULE_PREDICATE_UNKNOWN'
  | 'E_RULE_PARAM_INVALID'
  | 'E_RULE_DETAIL_INVALID'
  /** 条目级编辑（`rule-edit.ts`）：包里没有这一条 */
  | 'E_RULE_ITEM_NOT_FOUND'
  /**
   * 条目级编辑：级别只开放 `info` / `warn`。
   *
   * `block` 与"警告"不是同一件事：它会把一条判定变成"卡住流程"。
   * 形式类质控的引擎产出一律不含 block（见 `qc-self-test` 的断言），
   * 所以"能不能新造一条 block 规则"不该由一次保存决定，而该由改这里决定。
   */
  | 'E_RULE_SEVERITY_EDIT_LIMIT'
  /** 引用了条件库里没有的条件（或调用方没把条件库给它）：悬空引用在装载期就拒 */
  | 'E_RULE_CONDITION_UNKNOWN'
  /** 具名条件本身不合法（编码形状 / 名称 / 条件树） */
  | 'E_RULE_CONDITION_INVALID'
  /** `params.conditionId` 与 `params.when` 同时给或都不给（两选一，不能都填） */
  | 'E_RULE_CONDITION_CHOICE'
  /** 条目级编辑：包里没有这一条条件 */
  | 'E_RULE_CONDITION_NOT_FOUND'
  /**
   * 条目级编辑：这条条件还被规则引用着，不能删。
   *
   * 与模板公式的 `E_TPL_EXPR_IN_USE` 同一条纪律：删掉一个被引用的资产，
   * 报错会出现在"引用它的那些规则"上 —— 那时报错的地方离原因很远（医生点跑质控、
   * 或下次装包时整包不通过），而且说不出该改哪一条。
   */
  | 'E_RULE_CONDITION_IN_USE'
  /** 引用判定方式时填的实参不合法：未知参数名 / 必填缺失 / 类型或取值域不符 */
  | 'E_RULE_CONDITION_PARAM_INVALID'
  /**
   * 占位符用错了：出现在取值之外的位置、用了没声明的名字、或声明了参数却没用上。
   *
   * 单列一个码的理由：这三种错**都不是"条件写错了"**，而是"参数表和条件树对不上" ——
   * 报错必须说清是哪一种，否则使用者只会看到一句"条件树不合法"，然后去改一棵没错的树。
   */
  | 'E_RULE_CONDITION_PLACEHOLDER';

export class RulePackError extends Error {
  code: RulePackErrorCode;

  constructor(code: RulePackErrorCode, message: string) {
    super(message);
    this.name = 'RulePackError';
    this.code = code;
  }
}

interface ResolvedRule {
  itemId: string;
  title: string;
  severity: AnnotationSeverity;
  detail?: string;
  suggestion?: string;
  predicate: QcPredicate;
  params: Record<string, JsonValue>;
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function requiredText(source: Record<string, unknown>, key: string, label: string): string {
  const value = source[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new RulePackError('E_RULE_ITEM_INVALID', `${label} 的字段 ${key} 必须是非空字符串，实际 ${typeof value}`);
  }
  return value;
}

/* ------------------------------- 包内的两类条目 -------------------------------
   一个规则包里有两类条目：**规则**（`QcRuleDescriptor`）与**具名条件**
   （`QcConditionDefinition`）。后者靠 `itemType: 'condition'` 认出来 ——
   规则条目不写这个字段，所以交付方那些老包原样兼容，一个字都不用改。 */

export function isConditionItem(item: PackItemBase): item is QcConditionDefinition {
  return (item as { itemType?: unknown }).itemType === 'condition';
}

/** 包里的具名条件（**原样**，未校验）：给"目录"这类只展示、不判定的地方用 */
export function conditionItemsOf(pack: QcRulePack): QcConditionDefinition[] {
  return pack.items.filter(isConditionItem);
}

/** 包里的规则条目（原样）：一个包允许只有条件、没有规则（条件可以先建好，规则慢慢写） */
export function ruleItemsOf(pack: QcRulePack): QcRuleDescriptor[] {
  return pack.items.filter((item) => !isConditionItem(item)) as QcRuleDescriptor[];
}

/**
 * 校验通过的具名条件（判定方式）：`when` 已经是一棵**条件树**（可以带 `$参数` 占位符）。
 *
 * 引用它的规则直接拿去用 —— 带参数的先用实参代一遍（见 `withResolvedCondition`）。
 */
export interface ResolvedCondition {
  itemId: string;
  name: string;
  description?: string;
  /** 参数规格（缺省 = 不带参数） */
  params: QcConditionParamSpec[];
  /** 条件树。**可能带占位符**：它在引用处才被代入实参 */
  when: QcConditionNode;
}

/** 解析一条具名条件（不合法即抛）。装载期、写库期、编译期走的是同一段 */
export function resolveCondition(label: string, item: QcConditionDefinition): ResolvedCondition {
  if (typeof item.itemId !== 'string' || !QC_CONDITION_ID_PATTERN.test(item.itemId)) {
    throw new RulePackError(
      'E_RULE_CONDITION_INVALID',
      `${label}：条件编码必须是字母开头的 1-64 位（字母 / 数字 / 点 / 下划线 / 短横线）—— 编码会被人读、被规则写、进留痕，形状必须能一眼比对`,
    );
  }
  if (typeof item.name !== 'string' || item.name.trim() === '') {
    throw new RulePackError('E_RULE_CONDITION_INVALID', `${label}：条件名不能为空（界面上要按名字挑它）`);
  }
  if (item.description !== undefined && (typeof item.description !== 'string' || item.description.trim() === '')) {
    throw new RulePackError('E_RULE_CONDITION_INVALID', `${label}：说明若提供就必须是非空字符串`);
  }

  const params = normalizeConditionParams(item.params);
  if (!params) {
    throw new RulePackError(
      'E_RULE_CONDITION_INVALID',
      `${label} 的参数规格不合法：名字（字母开头的 1-64 位）/ 类型 / 标签 / 说明必填，`
        + `枚举必须给选项，且名字不能重复、个数不超过 ${String(8)}`,
    );
  }

  /* **恒允许占位符**：占位符是否可用，由它与 `params` 的对照决定（下面两条），
     而不是由"有没有声明参数"决定 —— 后者会让一个拼错的占位符被当成普通字面量收下 */
  const when = normalizeCondition(item.when, 0, true);
  if (!when) {
    throw new RulePackError(
      'E_RULE_CONDITION_INVALID',
      `${label} 的条件树不合法：字段 / 算子 / 取值的组合或形状不对（可用清单见 condition.ts 的字段表与算子表）`,
    );
  }

  const used = collectPlaceholders(when);
  for (const name of used) {
    if (!params.some((spec) => spec.name === name)) {
      throw new RulePackError(
        'E_RULE_CONDITION_PLACEHOLDER',
        `${label} 的条件树里用了占位符「$${name}」，但参数表里没有它：`
          + `参数表里有的是 ${params.length === 0 ? '（一个都没有）' : params.map((spec) => `$${spec.name}`).join(' / ')}。`
          + '用了没声明 = 实参来了也没处校验，所以一律拒',
      );
    }
  }
  for (const spec of params) {
    if (!used.includes(spec.name)) {
      throw new RulePackError(
        'E_RULE_CONDITION_PLACEHOLDER',
        `${label} 声明了参数「$${spec.name}」，但条件树里没有用到它：`
          + '那会让规则表单上出现一个"填了也不生效"的格 —— 这正是"我配的没生效"最难查的那种错',
      );
    }
  }

  return {
    itemId: item.itemId,
    name: item.name,
    ...(item.description !== undefined ? { description: item.description } : {}),
    params,
    when,
  };
}

function putCondition(out: Map<string, ResolvedCondition>, label: string, item: QcConditionDefinition): void {
  const resolved = resolveCondition(label, item);
  if (out.has(resolved.itemId)) {
    throw new RulePackError(
      'E_RULE_CONDITION_INVALID',
      `${label}：条件编码重复 —— 同一份判定方式里不能有两条同码`
        + '（编码是规则引用它的键：同码就是"两条规则引用同一条"，而它们未必是同一件事）',
    );
  }
  out.set(resolved.itemId, resolved);
}

/**
 * 判定方式库（**库级资产**）：编码 → 已解析的判定方式。
 *
 * 它是"库里那一份"的形态 —— 不属于任何包。校验与编译都拿它当引用解析的来源。
 */
export type ConditionLibrary = Map<string, ResolvedCondition>;

/**
 * 把库里那几条判定方式解析成"编码 → 条件树"。**不合法即抛**：
 * 库读进来的时候、写库之前、编译之前走的是同一段（`resolveCondition`）。
 *
 * 为什么要在这里一次解析完（而不是留到有人用的时候）：判定方式是**被引用**的一方，
 * 它不合法时受伤的是引用它的规则。报错必须报在"打开库"这一刻，并说清是哪一条 ——
 * 等到某条规则判定时才发现，界面上只会表现为"这条规则没出现"。
 */
export function resolveConditionLibrary(
  items: readonly QcConditionDefinition[],
  label = '判定方式库',
): ConditionLibrary {
  const out: ConditionLibrary = new Map();
  for (const item of items) {
    putCondition(out, `${label}「${String(item.itemId)}」`, item);
  }
  return out;
}

/**
 * 一个包能引用到哪些判定方式：**库里的**（权威）**+ 包自带的**。
 *
 * 优先级刻意写成"库优先、包内兜底"，两种情形都对：
 *   - 库里还没有这一条（老库还没迁移，或包自带私有判定方式）→ 用包内那份；
 *   - 库里已经有了同码的那一条（本院口径）→ **以库里那份为准**，包内那份被遮住。
 *
 * 为什么不"同码即拒"：装载期报错会让一个还能跑的库直接起不来（包里那份只是历史遗留），
 * 而权威位本身是清楚的 —— 判定方式归库里那一份。迁移会把包里那份删掉（`demo-server`），
 * 这里只负责"装着的那一份是哪一个"。
 */
export function resolvedConditionsOf(pack: QcRulePack, library: ConditionLibrary | null = null): ConditionLibrary {
  const out: ConditionLibrary = new Map();
  for (const item of conditionItemsOf(pack)) {
    putCondition(out, `规则包「${pack.packId}」条件「${String(item.itemId)}」`, item);
  }
  if (library) for (const [itemId, resolved] of library) out.set(itemId, resolved);
  return out;
}

/**
 * 校验并解析一条规则描述符。**编译与装载期校验共用这一段** ——
 * 两处各写一遍迟早会漂移，而漂移的表现是"装载时说没问题、扫描时却少了一条"。
 */
function resolveRule(
  packId: string,
  raw: unknown,
  conditions: Map<string, ResolvedCondition> | null,
): ResolvedRule {
  const descriptor = asObject(raw);
  const itemId = descriptor && typeof descriptor.itemId === 'string' ? descriptor.itemId : '(缺 itemId)';
  const label = `规则包「${packId}」条目「${itemId}」`;
  if (!descriptor) {
    throw new RulePackError('E_RULE_ITEM_INVALID', `${label}：条目必须是对象`);
  }

  const title = requiredText(descriptor, 'title', label);

  const severity = descriptor.severity;
  if (typeof severity !== 'string' || !(SEVERITIES as readonly string[]).includes(severity)) {
    throw new RulePackError(
      'E_RULE_SEVERITY_INVALID',
      `${label} 的级别「${String(severity)}」非法：只支持 ${SEVERITIES.join(' / ')}`,
    );
  }

  const predicateRef = asObject(descriptor.predicate);
  if (!predicateRef) {
    throw new RulePackError('E_RULE_ITEM_INVALID', `${label} 缺少 predicate（规则必须说明"用哪个内置谓词判"）`);
  }
  const kind = predicateRef.kind;
  if (typeof kind !== 'string' || !Object.prototype.hasOwnProperty.call(QC_PREDICATES, kind)) {
    throw new RulePackError(
      'E_RULE_PREDICATE_UNKNOWN',
      `${label} 引用了未知谓词「${String(kind)}」：可用的是 ${Object.keys(QC_PREDICATES).join(' / ')}。` +
        '包只能组合既有谓词，不能带来新判定逻辑 —— 这条限制正是"包不是代码"的落点',
    );
  }
  const predicate = QC_PREDICATES[kind as QcPredicateKind];

  /* 「引用条件库」与「就地拼一条」**两选一**。这里先单独拦一次"两格都填"：
     `normalizeParams` 只能回一个 `null`，报出来的是"参数不合法"那句通用话，
     而使用者真正需要的是一句"你不能两格都填"。 */
  const rawParams = predicateRef.params === undefined ? {} : asObject(predicateRef.params);
  if (rawParams && rawParams.conditionId !== undefined && rawParams.when !== undefined) {
    throw new RulePackError(
      'E_RULE_CONDITION_CHOICE',
      `${label} 同时填了 conditionId（引用条件库）与 when（就地拼条件）：这两格只能填一格。`
        + '两个都填等于一份数据里有两个判定口径，"哪一个在生效"就只能去代码里找答案',
    );
  }

  const params = predicate.normalizeParams(predicateRef.params === undefined ? {} : predicateRef.params);
  if (params === null) {
    throw new RulePackError(
      'E_RULE_PARAM_INVALID',
      `${label} 的谓词参数不合法：${kind} 可配 ${predicate.params.length === 0 ? '（无）' : predicate.params.join(' / ')}。` +
        '未知参数名或非法取值一律拒绝 —— 否则"我配的没生效"永远查不出来',
    );
  }

  /* 引用具名条件：**在编译期把条件树解析进来**（理由见文件头）。
     悬空引用在这里就报 —— 那时还有人看着，而"扫描时少跑一条"没人看得出来。 */
  const conditionId = params.conditionId;
  const resolvedParams = conditionId === undefined
    ? params
    : withResolvedCondition(label, String(conditionId), params, conditions);

  /* detail / suggestion 是**可选覆盖**：缺省时用谓词内置文案 */
  const detail = descriptor.detail;
  if (detail !== undefined) {
    if (typeof detail !== 'string' || detail.trim() === '') {
      throw new RulePackError('E_RULE_ITEM_INVALID', `${label} 的 detail 若提供就必须是非空字符串`);
    }
    if (detail.includes(itemId)) {
      throw new RulePackError(
        'E_RULE_DETAIL_INVALID',
        `${label} 的 detail 里出现了规则号：规则号由引擎注入，包不得自带 —— 否则会出现「规则 X：规则 X：…」这种双重编号，且允许包自证身份`,
      );
    }
  }
  const suggestion = descriptor.suggestion;
  if (suggestion !== undefined && (typeof suggestion !== 'string' || suggestion.trim() === '')) {
    throw new RulePackError('E_RULE_ITEM_INVALID', `${label} 的 suggestion 若提供就必须是非空字符串`);
  }

  return {
    itemId,
    title,
    severity: severity as AnnotationSeverity,
    ...(detail !== undefined ? { detail } : {}),
    ...(suggestion !== undefined ? { suggestion } : {}),
    predicate,
    params: resolvedParams,
  };
}

/**
 * 把 `params.conditionId`（+ 实参 `params.args`）解析成条件树，写进 `params.when`。
 *
 * 为什么写进 `when` 而不是另开一个字段：`check()` 只拿得到参数，而**内联与引用
 * 两种写法的判定路径必须完全一样** —— 若引用走另一条路，"引用的条件"就会慢慢
 * 长出与内联不同的行为（那是两套判定，只是没人看得见）。
 *
 * 解析失败一律抛：悬空引用会让一条规则**静默地什么也判不了**，
 * 而它在界面上仍然列着、看着一切正常。
 *
 * ## 实参代入（T1）走的是"两段同一处"
 *
 * 第一段：`validateConditionArgs` 按该条件的参数规格判实参（未知名 / 必填 / 类型 / 取值域）。
 * 第二段：代入后的树**再过一次 `normalizeCondition`**（这一次不允许占位符）——
 * 于是"占位符代入把类型换错了"在内核里就报出来，而不是等到扫描那一刻表现为"这条规则不出现"。
 */
function withResolvedCondition(
  label: string,
  conditionId: string,
  params: Record<string, JsonValue>,
  conditions: Map<string, ResolvedCondition> | null,
): Record<string, JsonValue> {
  if (conditions === null) {
    throw new RulePackError(
      'E_RULE_CONDITION_UNKNOWN',
      `${label} 引用了判定方式「${conditionId}」，但这次校验没有带上判定方式库：`
        + '引用只能指向**库里**的判定方式（判定方式是库级资产，不属于任何包），'
        + '所以校验必须把库传进来（这是调用方漏了参数，不是包写错了）',
    );
  }
  const found = conditions.get(conditionId);
  if (!found) {
    const available = [...conditions.keys()].join(' / ');
    throw new RulePackError(
      'E_RULE_CONDITION_UNKNOWN',
      `${label} 引用了库里没有的判定方式「${conditionId}」：可用的是 ${available === '' ? '（库里一条都没有）' : available}。`
        + '判定方式是**库级资产**（管理后台「基础数据 · 判定方式」里维护），规则引用它时写的那个编码必须在库里存在；'
        + '悬空引用会让这条规则什么都判不了，而它在界面上仍然列着、看着一切正常。',
    );
  }

  const args = validateConditionArgs(found.params, params.args);
  if (!args) {
    const required = found.params.filter((spec) => spec.required === true).map((spec) => spec.name);
    throw new RulePackError(
      'E_RULE_CONDITION_PARAM_INVALID',
      `${label} 引用判定方式「${conditionId} ${found.name}」时实参不合法：`
        + `它接受 ${found.params.length === 0 ? '（无参数）' : found.params.map((spec) => spec.name).join(' / ')}，`
        + `其中必填 ${required.length === 0 ? '（无）' : required.join(' / ')}。`
        + '未知参数名、必填缺失、类型或取值域不符一律拒绝 —— 否则"我填的没生效"永远查不出来',
    );
  }

  const expanded = normalizeCondition(substitutePlaceholders(found.when, args));
  if (!expanded) {
    throw new RulePackError(
      'E_RULE_CONDITION_INVALID',
      `${label} 引用的判定方式「${conditionId}」代入实参后的条件不合法：`
        + '实参的"值形态"与它落的那一格不匹配（如把单个词填进了要求词表的格）。'
        + '这一句是在代入之后、用**与内联条件完全相同的那段校验**判出来的',
    );
  }
  return { ...params, when: expanded as unknown as JsonValue };
}

/**
 * 一条规则的"判什么"的人话回读（不是自定义条件 → `null`）。
 *
 * 放在内核里、而且只有这一处：界面上那一列（规则表「参数」）与将来任何一处
 * 要显示"这条规则按什么判"的地方，都读它。界面另编一句的后果是两家说的话
 * 慢慢不一致，而两边看上去都对。
 *
 * **引用具名条件时把条件名一起读出来**：光显示编码等于让人去后台再查一次，
 * 而那句话本身就该是自解释的（"引用条件「C-CUSTOM-1 主诉缺少时间」：…"）。
 *
 * 读不出来时**不猜**：回 `null`，界面上退回显示参数原文，而不是显示一句编出来的话
 * （库里存的是校验过的内容，但"包被手改过"这件事类型层面挡不住）。
 */
export function conditionSummaryOf(
  descriptor: QcRuleDescriptor,
  conditions: Map<string, ResolvedCondition> | null = null,
): string | null {
  if (descriptor.predicate?.kind !== 'field-condition') return null;
  const params = descriptor.predicate.params;
  if (!params || typeof params !== 'object' || Array.isArray(params)) return null;
  const source = params as Record<string, unknown>;
  const conditionId = source.conditionId;
  if (typeof conditionId === 'string') {
    const found = conditions?.get(conditionId) ?? null;
    if (!found) return `引用条件「${conditionId}」：库里没有这一条（它被删掉了，或这次没把判定方式库带上）`;
    /* 实参一起读进去：界面上要看的是"这条规则**实际**按什么判"，
       而不是"这条判定方式大致判什么"（后者在有参数时等于少说了一半） */
    const args = source.args !== undefined && source.args !== null && typeof source.args === 'object' && !Array.isArray(source.args)
      ? (source.args as Record<string, JsonValue>)
      : null;
    const shown = args === null ? found.when : (normalizeCondition(substitutePlaceholders(found.when, args)) ?? found.when);
    return `引用条件「${conditionId} ${found.name}」：${describeCondition(shown, null, args)}`;
  }
  const when = normalizeCondition(source.when);
  return when ? describeCondition(when) : null;
}

/**
 * 编译单条（装载期的校验也走这条路径，避免"两处判断不一致"）。
 *
 * `conditions` 是"这个包能引用到的判定方式"（库里的 + 包自带的，见 `resolvedConditionsOf`）。
 * 不给也可以：只有当这条规则引用了判定方式时才需要它，而那时缺它会被明确拒绝
 * （不是"猜一个默认值"）。
 */
export function compileRuleDescriptor(
  packId: string,
  raw: unknown,
  conditions: Map<string, ResolvedCondition> | null = null,
): QcRule {
  const resolved = resolveRule(packId, raw, conditions);
  return {
    id: resolved.itemId,
    title: resolved.title,
    severity: resolved.severity,
    check(node, ctx) {
      const result = resolved.predicate.check(node, resolved.params, ctx);
      if (!result) return null;
      /* "判不了"原样往上传（只补规则号）：它必须走到引擎的 `unevaluated` 通道，
         不能被当成"命中"或"没命中" —— 两者都会让"没判"看起来像"查过了"。 */
      if ('uncertain' in result) return { uncertain: `规则 ${resolved.itemId}：${result.uncertain}` };
      return {
        /* 规则号在这里注入：包给的只是"判定依据本身"，身份由引擎补上 */
        detail: `规则 ${resolved.itemId}：${resolved.detail ?? result.detail}`,
        suggestion: resolved.suggestion ?? result.suggestion,
        ...(result.quote !== undefined ? { quote: result.quote } : {}),
      };
    },
  };
}

/**
 * 编译整包（按包内顺序，保证命中顺序稳定）。
 *
 * **只编译规则那一条条**：具名条件不是规则，编译它没有意义 ——
 * 早先这里直接 `pack.items.map(...)`，加了条件条目之后那会把条件当成规则去要
 * `title / severity / predicate`，报错还会说成"这条规则不合法"。条件的问题
 * 必须报在条件上（`resolvedConditionsOf`）。
 */
export function compileRulePack(pack: QcRulePack, library: ConditionLibrary | null = null): QcRule[] {
  const conditions = resolvedConditionsOf(pack, library);
  return ruleItemsOf(pack).map((descriptor) => compileRuleDescriptor(pack.packId, descriptor, conditions));
}

/** 仅校验不编译：供 `PackRegistry.load` 的 `validate` 钩子使用（装包那一刻就报错） */
export function validateRulePack(pack: QcRulePack, library: ConditionLibrary | null = null): void {
  /* 先解析判定方式：它不合法时受伤的是**引用它的规则**，所以报错要报在它那一侧 */
  const conditions = resolvedConditionsOf(pack, library);
  for (const item of pack.items) {
    if (isConditionItem(item)) continue;
    resolveRule(pack.packId, item, conditions);
  }
}

/**
 * 只校验**一条**描述符（不编译）：供条目级编辑在写包前逐条把关。
 *
 * 为什么编辑口子也走这里、而不是自己写一套字段校验：装载期的校验、编译期的校验与
 * 编辑期的校验只该是同一段代码。三处各写一遍的后果是"保存时收下了、扫描时却少一条"，
 * 而那时的表现是"质控跑了但没报"，没人会想到是当初保存放过了一条。
 */
export function assertRuleDescriptor(
  packId: string,
  raw: unknown,
  conditions: Map<string, ResolvedCondition> | null = null,
): void {
  resolveRule(packId, raw, conditions);
}

/**
 * 从注册表取**启用中**的规则，编译成可运行集合。
 *
 * 只取 `kind === 'rule'` 的包：模板包与术语包即使装载了也不该进入质控引擎 ——
 * 它们各有各的引擎（尚未实现），混进来会得到"看起来跑了、其实跑的不是这套规则"。
 *
 * 逐个包走（而不是 `activeItemsOf('rule')` 拉平）：包里可能自带私有判定方式，
 * 编译一条规则必须拿到"它自己那个包能引用到的那份表"（库 + 本包）——
 * 拉平之后包的边界就丢了。顺序照 packId 排序，与 `activeItemsOf` 同口径（命中顺序必须稳定）。
 */
export function rulesFromRegistry(registry: PackRegistry, library: ConditionLibrary | null = null): QcRule[] {
  const out: QcRule[] = [];
  const summaries = [...registry.list('rule')].sort((left, right) => left.packId.localeCompare(right.packId));
  for (const summary of summaries) {
    const pack = registry.get(summary.packId) as QcRulePack | null;
    if (!pack) continue;
    const conditions = resolvedConditionsOf(pack, library);
    for (const item of ruleItemsOf(pack)) {
      if (item.enabled === false) continue;
      out.push(compileRuleDescriptor(pack.packId, item, conditions));
    }
  }
  return out;
}

