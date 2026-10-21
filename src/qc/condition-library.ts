import type { JsonValue } from '../model/types.ts';
import type { PackRegistry } from '../knowledge/pack.ts';
import { describeCondition, normalizeCondition, normalizeConditionParams, QC_CONDITION_ID_PATTERN } from './condition.ts';
import { resolveCondition, RulePackError, ruleItemsOf, type ConditionLibrary } from './rule-pack.ts';
import type { QcConditionDefinition, QcConditionParamSpec, QcRulePack } from './types.ts';

export interface QcConditionUser {
  packId: string;
  itemId: string;
  title: string;
  enabled: boolean;
}

export interface QcConditionCatalogEntry {
  itemId: string;
  name: string;
  description: string | null;
  params: QcConditionParamSpec[];
  summary: string | null;
  when: JsonValue | null;
  usedBy: QcConditionUser[];
}

function trimOrEmpty(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export interface ConditionDraftInput {
  name: string;
  description?: string;
  params?: unknown;
  when: unknown;
}

export interface ConditionPatch {
  name?: string;
  description?: string | null;
  params?: unknown;
  when?: unknown;
}

export function validateConditionItems(raw: unknown): QcConditionDefinition[] {
  if (!Array.isArray(raw)) {
    throw new RulePackError('E_RULE_CONDITION_INVALID', '判定方式清单必须是数组');
  }
  const items: QcConditionDefinition[] = [];
  const seen = new Set<string>();
  raw.forEach((entry, index) => {
    const position = `第 ${index + 1} 项`;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new RulePackError('E_RULE_CONDITION_INVALID', `${position}不是一个判定方式对象`);
    }
    const record = entry as Record<string, unknown>;
    if (record.itemType !== 'condition') {
      throw new RulePackError(
        'E_RULE_CONDITION_INVALID',
        `${position}的 itemType 必须是 "condition"（判定方式库里不该出现规则条目）`,
      );
    }
    const itemId = typeof record.itemId === 'string' ? record.itemId : '';
    if (seen.has(itemId)) {
      throw new RulePackError(
        'E_RULE_CONDITION_INVALID',
        `判定方式编码「${itemId}」出现了两次：编码是规则引用它的键，同码两条等于"两条规则引用同一条"，而它们未必是同一件事`,
      );
    }
    seen.add(itemId);
    const resolved = resolveCondition(`判定方式库${position}`, {
      itemType: 'condition',
      itemId,
      name: typeof record.name === 'string' ? record.name : '',
      ...(record.description !== undefined ? { description: String(record.description) } : {}),
      ...(record.params !== undefined ? { params: record.params as QcConditionParamSpec[] } : {}),
      when: record.when as JsonValue,
    });
    items.push({
      itemType: 'condition',
      itemId: resolved.itemId,
      name: resolved.name,
      ...(resolved.description !== undefined ? { description: resolved.description } : {}),
      ...(resolved.params.length > 0 ? { params: resolved.params as QcConditionParamSpec[] } : {}),
      when: resolved.when as unknown as JsonValue,
    });
  });
  return items;
}

export function conditionUsedByInPack(pack: QcRulePack, conditionId: string): QcConditionUser[] {
  const out: QcConditionUser[] = [];
  for (const rule of ruleItemsOf(pack)) {
    if (rule.predicate?.kind !== 'field-condition') continue;
    const params = rule.predicate.params;
    if (!params || typeof params !== 'object' || Array.isArray(params)) continue;
    if ((params as Record<string, unknown>).conditionId !== conditionId) continue;
    out.push({
      packId: pack.packId,
      itemId: String(rule.itemId),
      title: typeof rule.title === 'string' && rule.title.trim() !== '' ? rule.title : String(rule.itemId),
      enabled: rule.enabled !== false,
    });
  }
  return out;
}

export function conditionUsedByAcrossPacks(registry: PackRegistry, conditionId: string): QcConditionUser[] {
  const out: QcConditionUser[] = [];
  const summaries = [...registry.list('rule')].sort((left, right) => left.packId.localeCompare(right.packId));
  for (const summary of summaries) {
    const pack = registry.get(summary.packId) as QcRulePack | null;
    if (!pack) continue;
    out.push(...conditionUsedByInPack(pack, conditionId));
  }
  return out;
}

export function conditionCatalogOf(
  items: readonly QcConditionDefinition[],
  registry: PackRegistry,
): QcConditionCatalogEntry[] {
  return items.map((item) => {
    const when = normalizeCondition(item.when, 0, true);
    return {
      itemId: String(item.itemId),
      name: trimOrEmpty(item.name),
      description: item.description === undefined ? null : String(item.description),
      params: normalizeConditionParams(item.params) ?? [],
      summary: when ? describeCondition(when) : null,
      when: when ? (when as unknown as JsonValue) : null,
      usedBy: conditionUsedByAcrossPacks(registry, String(item.itemId)),
    };
  });
}

export function conditionLibraryOf(items: readonly QcConditionDefinition[]): ConditionLibrary {
  const out: ConditionLibrary = new Map();
  for (const item of items) {
    const resolved = resolveCondition(`判定方式库「${String(item.itemId)}」`, item);
    out.set(resolved.itemId, resolved);
  }
  return out;
}

function nextConditionId(items: readonly QcConditionDefinition[]): string {
  let seq = 1;
  for (const item of items) {
    const matched = /^C-CUSTOM-(\d+)$/.exec(String(item.itemId));
    if (matched) seq = Math.max(seq, Number(matched[1]) + 1);
  }
  return `C-CUSTOM-${seq}`;
}

export function addCondition(
  items: readonly QcConditionDefinition[],
  input: ConditionDraftInput,
): { items: QcConditionDefinition[]; itemId: string } {
  const itemId = nextConditionId(items);
  const item: QcConditionDefinition = {
    itemType: 'condition',
    itemId,
    name: trimOrEmpty(input.name),
    when: input.when as JsonValue,
  };
  const description = trimOrEmpty(input.description);
  if (description !== '') item.description = description;
  if (input.params !== undefined) item.params = input.params as unknown as QcConditionParamSpec[];
  const next = [item, ...items];
  return { items: validateConditionItems(next), itemId };
}

export function patchCondition(
  items: readonly QcConditionDefinition[],
  itemId: string,
  patch: ConditionPatch,
): QcConditionDefinition[] {
  const index = items.findIndex((item) => String(item.itemId) === itemId);
  if (index < 0) {
    throw new RulePackError('E_RULE_CONDITION_NOT_FOUND', `判定方式库里没有「${itemId}」：它可能已被删除`);
  }
  if (patch.name === undefined && patch.description === undefined && patch.params === undefined && patch.when === undefined) {
    throw new RulePackError('E_RULE_CONDITION_INVALID', '没有要改的字段（这里开放名称 / 说明 / 参数表 / 条件本身）');
  }
  const current = items[index] as QcConditionDefinition;
  const next: QcConditionDefinition = { ...current };
  if (patch.name !== undefined) next.name = trimOrEmpty(patch.name);
  if (patch.description !== undefined) {
    const description = patch.description === null ? '' : trimOrEmpty(patch.description);
    if (description === '') delete next.description;
    else next.description = description;
  }
  if (patch.params !== undefined) {
    const params = patch.params as readonly QcConditionParamSpec[] | null;
    if (params === null || (Array.isArray(params) && params.length === 0)) delete next.params;
    else next.params = params as QcConditionParamSpec[];
  }
  if (patch.when !== undefined) next.when = patch.when as JsonValue;
  const out = items.slice();
  out[index] = next;
  return validateConditionItems(out);
}

export function removeCondition(
  items: readonly QcConditionDefinition[],
  itemId: string,
  registry: PackRegistry,
): QcConditionDefinition[] {
  if (!items.some((item) => String(item.itemId) === itemId)) {
    throw new RulePackError('E_RULE_CONDITION_NOT_FOUND', `判定方式库里没有「${itemId}」`);
  }
  const users = conditionUsedByAcrossPacks(registry, itemId);
  if (users.length > 0) {
    throw new RulePackError(
      'E_RULE_CONDITION_IN_USE',
      `判定方式「${itemId}」还被 ${users.length} 条规则引用（`
        + `${users.map((user) => `「${user.packId} / ${user.title}」`).join('、')}）：`
        + '先把那些规则改成别的判定方式（或在规则里就地拼一条），再删它',
    );
  }
  return items.filter((item) => String(item.itemId) !== itemId);
}

/** 判断一条条件的编码是否合规（界面在提交前先拦一次；服务端仍会再判） */
export function isValidConditionId(value: unknown): boolean {
  return typeof value === 'string' && QC_CONDITION_ID_PATTERN.test(value);
}
