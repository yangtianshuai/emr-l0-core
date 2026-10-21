import type { AnnotationSeverity } from '../core/annotations.ts';
import type { JsonValue } from '../model/types.ts';
import { QC_PREDICATES } from './predicates.ts';
import {
  RULE_ENGINE_API,
  RulePackError,
  assertRuleDescriptor,
  isConditionItem,
  resolvedConditionsOf,
  ruleItemsOf,
  type ConditionLibrary,
} from './rule-pack.ts';
import type { QcPredicateKind, QcRuleDescriptor, QcRulePack } from './types.ts';

export const CUSTOM_RULE_PACK_ID = 'doc.rule.custom';

export const EDITABLE_RULE_SEVERITIES: readonly AnnotationSeverity[] = ['info', 'warn'];

export function customRulePackBase(): QcRulePack {
  return {
    packId: CUSTOM_RULE_PACK_ID,
    kind: 'rule',
    engineApi: RULE_ENGINE_API,
    name: '院内自建质控规则',
    vendor: '本机构维护',
    items: [],
  };
}

export interface RuleDraftInput {
  title: string;
  severity: AnnotationSeverity;
  predicate: { kind: QcPredicateKind; params?: Record<string, JsonValue> };
  /** 覆盖谓词内置的判定依据（不得含自身规则号，有校验守着）  */
  detail?: string;
  suggestion?: string;
}

export interface RulePatch {
  title?: string;
  severity?: AnnotationSeverity;
  predicate?: { kind: QcPredicateKind; params?: Record<string, JsonValue> };
  detail?: string | null;
  suggestion?: string | null;
}

function trimOrEmpty(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeSeverity(value: unknown): AnnotationSeverity {
  if (typeof value !== 'string' || !(EDITABLE_RULE_SEVERITIES as readonly string[]).includes(value)) {
    throw new RulePackError(
      'E_RULE_SEVERITY_EDIT_LIMIT',
      `级别只能是 ${EDITABLE_RULE_SEVERITIES.join(' / ')}：block 是"卡住流程"那一档，`
        + '形式类质控的产出不含它 —— 要新造一条能阻断流程的规则，得改内核并加用例，不是改一次配置',
    );
  }
  return value as AnnotationSeverity;
}

export function addRule(
  pack: QcRulePack | null,
  input: RuleDraftInput,
  library: ConditionLibrary | null = null,
): { pack: QcRulePack; itemId: string } {
  const base = pack ?? customRulePackBase();
  let seq = 1;
  for (const item of ruleItemsOf(base)) {
    const matched = /^R-CUSTOM-(\d+)$/.exec(item.itemId);
    if (matched) seq = Math.max(seq, Number(matched[1]) + 1);
  }
  const itemId = `R-CUSTOM-${seq}`;
  const descriptor: QcRuleDescriptor = {
    itemId,
    title: trimOrEmpty(input.title),
    severity: normalizeSeverity(input.severity),
    predicate: input.predicate,
  };
  const detail = trimOrEmpty(input.detail);
  if (detail !== '') descriptor.detail = detail;
  const suggestion = trimOrEmpty(input.suggestion);
  if (suggestion !== '') descriptor.suggestion = suggestion;
  assertRuleDescriptor(base.packId, descriptor, resolvedConditionsOf(base, library));
  return { pack: { ...base, items: [...base.items, descriptor] }, itemId };
}

export function patchRuleDescriptor(
  pack: QcRulePack,
  itemId: string,
  patch: RulePatch,
  library: ConditionLibrary | null = null,
): QcRulePack {
  const index = pack.items.findIndex((item) => !isConditionItem(item) && item.itemId === itemId);
  if (index < 0) {
    throw new RulePackError('E_RULE_ITEM_NOT_FOUND', `规则包「${pack.packId}」里没有条目「${itemId}」：它可能已被删除`);
  }
  if (patch.title === undefined && patch.severity === undefined && patch.predicate === undefined
    && patch.detail === undefined && patch.suggestion === undefined) {
    throw new RulePackError(
      'E_RULE_ITEM_INVALID',
      '没有要改的字段（这里开放标题 / 级别 / 判定方式与参数 / 判定依据 / 建议动作）',
    );
  }
  const next: QcRuleDescriptor = { ...(pack.items[index] as QcRuleDescriptor) };
  if (patch.title !== undefined) next.title = trimOrEmpty(patch.title);
  if (patch.severity !== undefined) next.severity = normalizeSeverity(patch.severity);
  if (patch.predicate !== undefined) next.predicate = patch.predicate;
  if (patch.detail !== undefined) {
    const detail = patch.detail === null ? '' : trimOrEmpty(patch.detail);
    if (detail === '') delete next.detail;
    else next.detail = detail;
  }
  if (patch.suggestion !== undefined) {
    const suggestion = patch.suggestion === null ? '' : trimOrEmpty(patch.suggestion);
    if (suggestion === '') delete next.suggestion;
    else next.suggestion = suggestion;
  }
  assertRuleDescriptor(pack.packId, next, resolvedConditionsOf(pack, library));
  const items = pack.items.slice();
  items[index] = next;
  return { ...pack, items };
}

export function removeRule(pack: QcRulePack, itemId: string): QcRulePack {
  const index = pack.items.findIndex((item) => !isConditionItem(item) && item.itemId === itemId);
  if (index < 0) {
    throw new RulePackError('E_RULE_ITEM_NOT_FOUND', `规则包「${pack.packId}」里没有条目「${itemId}」`);
  }
  return { ...pack, items: pack.items.filter((item, at) => at !== index) };
}

export function predicateLabelOf(kind: string): string {
  if (!Object.prototype.hasOwnProperty.call(QC_PREDICATES, kind)) return kind;
  return QC_PREDICATES[kind as QcPredicateKind].label;
}
