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
  | 'E_RULE_ITEM_NOT_FOUND'
  | 'E_RULE_SEVERITY_EDIT_LIMIT'
  | 'E_RULE_CONDITION_UNKNOWN'
  | 'E_RULE_CONDITION_INVALID'
  | 'E_RULE_CONDITION_CHOICE'
  | 'E_RULE_CONDITION_NOT_FOUND'
  | 'E_RULE_CONDITION_IN_USE'
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

export function isConditionItem(item: PackItemBase): item is QcConditionDefinition {
  return (item as { itemType?: unknown }).itemType === 'condition';
}

export function conditionItemsOf(pack: QcRulePack): QcConditionDefinition[] {
  return pack.items.filter(isConditionItem);
}

export function ruleItemsOf(pack: QcRulePack): QcRuleDescriptor[] {
  return pack.items.filter((item) => !isConditionItem(item)) as QcRuleDescriptor[];
}

export interface ResolvedCondition {
  itemId: string;
  name: string;
  description?: string;
  params: QcConditionParamSpec[];
  when: QcConditionNode;
}

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
        + '判定方式是**库级资产**（管理后台「知识资产 · 判定方式」里维护），规则引用它时写的那个编码必须在库里存在；'
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
      if ('uncertain' in result) return { uncertain: `规则 ${resolved.itemId}：${result.uncertain}` };
      return {
        detail: `规则 ${resolved.itemId}：${resolved.detail ?? result.detail}`,
        suggestion: resolved.suggestion ?? result.suggestion,
        ...(result.quote !== undefined ? { quote: result.quote } : {}),
      };
    },
  };
}

export function compileRulePack(pack: QcRulePack, library: ConditionLibrary | null = null): QcRule[] {
  const conditions = resolvedConditionsOf(pack, library);
  return ruleItemsOf(pack).map((descriptor) => compileRuleDescriptor(pack.packId, descriptor, conditions));
}

export function validateRulePack(pack: QcRulePack, library: ConditionLibrary | null = null): void {
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

