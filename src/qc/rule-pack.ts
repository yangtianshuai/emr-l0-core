// 规则包：把「声明式描述符」编译成「可运行的 QcRule」。

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
  | 'E_RULE_SEVERITY_EDIT_LIMIT'
  /** 引用了条件库里没有的条件（或调用方没把条件库给它）：悬空引用在装载期就拒 */
  | 'E_RULE_CONDITION_UNKNOWN'
  /** 具名条件本身不合法（编码形状 / 名称 / 条件树） */
  | 'E_RULE_CONDITION_INVALID'
  /** `params.conditionId` 与 `params.when` 同时给或都不给（两选一，不能都填） */
  | 'E_RULE_CONDITION_CHOICE'
  /** 条目级编辑：包里没有这一条条件 */
  | 'E_RULE_CONDITION_NOT_FOUND'
  | 'E_RULE_CONDITION_IN_USE'
  /** 引用判定方式时填的实参不合法：未知参数名 / 必填缺失 / 类型或取值域不符 */
  | 'E_RULE_CONDITION_PARAM_INVALID'
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
   一个规则包里有两类条目：规则（`QcRuleDescriptor`）与具名条件
   （`QcConditionDefinition`）。后者靠 `itemType: 'condition'` 认出来 ——
   规则条目不写这个字段，所以交付方那些老包原样兼容，一个字都不用改。  */

export function isConditionItem(item: PackItemBase): item is QcConditionDefinition {
  return (item as { itemType?: unknown }).itemType === 'condition';
}

/** 包里的具名条件（原样，未校验）：给"目录"这类只展示、不判定的地方用  */
export function conditionItemsOf(pack: QcRulePack): QcConditionDefinition[] {
  return pack.items.filter(isConditionItem);
}

/** 包里的规则条目（原样）：一个包允许只有条件、没有规则（条件可以先建好，规则慢慢写） */
export function ruleItemsOf(pack: QcRulePack): QcRuleDescriptor[] {
  return pack.items.filter((item) => !isConditionItem(item)) as QcRuleDescriptor[];
}

export interface ResolvedCondition {
  itemId: string;
  name: string;
  description?: string;
  /** 参数规格（缺省 = 不带参数） */
  params: QcConditionParamSpec[];
  /** 条件树。可能带占位符：它在引用处才被代入实参  */
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

  /* 恒允许占位符：占位符是否可用，由它与 `params` 的对照决定（下面两条），
     而不是由"有没有声明参数"决定 —— 后者会让一个拼错的占位符被当成普通字面量收下  */
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
 * 判定方式库（库级资产）：编码 → 已解析的判定方式。
 *
 * 它是"库里那一份"的形态 —— 不属于任何包。校验与编译都拿它当引用解析的来源。
  */
export type ConditionLibrary = Map<string, ResolvedCondition>;

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

export function resolvedConditionsOf(pack: QcRulePack, library: ConditionLibrary | null = null): ConditionLibrary {
  const out: ConditionLibrary = new Map();
  for (const item of conditionItemsOf(pack)) {
    putCondition(out, `规则包「${pack.packId}」条件「${String(item.itemId)}」`, item);
  }
  if (library) for (const [itemId, resolved] of library) out.set(itemId, resolved);
  return out;
}

/**
 * 校验并解析一条规则描述符。编译与装载期校验共用这一段 ——
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

  /* 「引用条件库」与「就地拼一条」两选一。这里先单独拦一次"两格都填"：
     `normalizeParams` 只能回一个 `null`，报出来的是"参数不合法"那句通用话，
     而使用者真正需要的是一句"你不能两格都填"。  */
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

  const conditionId = params.conditionId;
  const resolvedParams = conditionId === undefined
    ? params
    : withResolvedCondition(label, String(conditionId), params, conditions);

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
 * 引用具名条件时把条件名一起读出来：光显示编码等于让人去后台再查一次，
 * 而那句话本身就该是自解释的（"引用条件「C-CUSTOM-1 主诉缺少时间」：…"）。
 *
 * 读不出来时不猜：回 `null`，界面上退回显示参数原文，而不是显示一句编出来的话
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
    /* 实参一起读进去：界面上要看的是"这条规则实际按什么判"，
       而不是"这条判定方式大致判什么"（后者在有参数时等于少说了一半）  */
    const args = source.args !== undefined && source.args !== null && typeof source.args === 'object' && !Array.isArray(source.args)
      ? (source.args as Record<string, JsonValue>)
      : null;
    const shown = args === null ? found.when : (normalizeCondition(substitutePlaceholders(found.when, args)) ?? found.when);
    return `引用条件「${conditionId} ${found.name}」：${describeCondition(shown, null, args)}`;
  }
  const when = normalizeCondition(source.when);
  return when ? describeCondition(when) : null;
}

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
 * 只编译规则那一条条：具名条件不是规则，编译它没有意义 ——
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
  /* 先解析判定方式：它不合法时受伤的是引用它的规则，所以报错要报在它那一侧  */
  const conditions = resolvedConditionsOf(pack, library);
  for (const item of pack.items) {
    if (isConditionItem(item)) continue;
    resolveRule(pack.packId, item, conditions);
  }
}

export function assertRuleDescriptor(
  packId: string,
  raw: unknown,
  conditions: Map<string, ResolvedCondition> | null = null,
): void {
  resolveRule(packId, raw, conditions);
}

/**
 * 从注册表取启用中的规则，编译成可运行集合。
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

