// 具名条件（判定方式库）的维护：新建 / 修改 / 删除 / "谁在用它" / 校验。

import type { JsonValue } from '../model/types.ts';
import type { PackRegistry } from '../knowledge/pack.ts';
import { describeCondition, normalizeCondition, normalizeConditionParams, QC_CONDITION_ID_PATTERN } from './condition.ts';
import { resolveCondition, RulePackError, ruleItemsOf, type ConditionLibrary } from './rule-pack.ts';
import type { QcConditionDefinition, QcConditionParamSpec, QcRulePack } from './types.ts';

/** 引用一条具名条件的规则（目录下发与删除保护共用这一份） */
export interface QcConditionUser {
  /** 规则所在包 —— 判定方式是库级的，引用方可能分布在多个包里，界面要说清是哪一包的那一条 */
  packId: string;
  itemId: string;
  title: string;
  enabled: boolean;
}

/** 目录里的一条条件：界面照它渲染"判定方式"那张表 */
export interface QcConditionCatalogEntry {
  itemId: string;
  name: string;
  description: string | null;
  /**
   * 参数规格（T1）。空数组 = 不带参数。
   *
   * 界面照它渲染"规则填实参"的那几格；参数表本身由界面在"判定方式"抽屉里维护。
   * 与 `when` 同出一处（这里的 `normalizeConditionParams`），两处各解析一遍的后果是
   * "界面显示的参数表"与"引擎按它校验的参数表"迟早不是同一份。
    */
  params: QcConditionParamSpec[];
  /** 人话回读。库里存的是校验过的条件，正常情况不为空 */
  summary: string | null;
  when: JsonValue | null;
  /**
   * 谁在用它 —— 保存前的"会影响哪几条"与删除时的拒绝，读的是同一份。
   * 两处各算一遍的后果不是多打几个字：是"界面说没人用、删除却被拒"这种对不上的话。
    */
  usedBy: QcConditionUser[];
}

function trimOrEmpty(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** 新建一条条件的输入（`itemId` 不给：由这里按序号生成） */
export interface ConditionDraftInput {
  name: string;
  description?: string;
  /** 参数规格（可省略 = 不带参数）。合法性由 `normalizeConditionParams` 判 */
  params?: unknown;
  /** 条件树（原样来自界面；合法性由 `normalizeCondition` 判，允许 `$参数` 占位符） */
  when: unknown;
}

/**
 * 修改一条条件。只开这三个字段。
 *
 * `description` 给 `null` 或空串 = 清掉它（与"写一个空串进去"是两件事：
 * 空串过不了校验，而且会让"改回原样"回不到原来那一版）。
 *
 * `when` 不给就是不动它 —— 这一点很重要：条件树的改动会影响所有引用它的规则，
 * 所以它必须是一次明确的、有内容的改动，而不是"这次提交里恰好带了它"。
  */
export interface ConditionPatch {
  name?: string;
  description?: string | null;
  params?: unknown;
  when?: unknown;
}

/**
 * 校验一份判定方式清单（读写两条路径共用，口径只有这一处）。
 *
 * 校验用的是内核那一段（`resolveCondition`）：编码形状 / 名称 / 参数规格 / 条件树 /
 * 占位符与参数表是否对得上 —— 全部在一次解析里判完。库里另写一套的后果是
 * "存进去时说合法、装包时却报它不合法"，而那时没人记得是谁存进去的。
 *
 * 返回值是归一化之后的那一份（`when` / `params` 按内核解析的形状回写）：
 * 于是"库里存着的"与"引擎按它校验的"字面一致。
  */
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

/** 引用这条条件的规则（某个包内，保持包内顺序）  */
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

/**
 * 引用这条条件的规则（跨所有包，按 packId 排序保证稳定）。
 *
 * 判定方式是库级资产，所以"谁在用它"必须跨包数 —— 只数一个包的后果是
 * "界面说没人用、删除却被拒"，而那句话没有任何地方能查出原因。
  */
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

/**
 * 判定方式目录。`summary` 用判定方式自己的那棵树算，`usedBy` 用引用它的规则算 ——
 * 两者都是"读现成的数据"，不猜、不推断。
  */
export function conditionCatalogOf(
  items: readonly QcConditionDefinition[],
  registry: PackRegistry,
): QcConditionCatalogEntry[] {
  return items.map((item) => {
    /* 允许占位符：带参数的判定方式，它的树里本来就有 `$参数`。
       这里用 `false` 解析的后果是"带参数的判定方式在界面上回显成空" —— 而界面看起来一切正常  */
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

/** 库里解析出来的那份引用表（试算 / 校验用） */
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

/** 新建一条判定方式：返回新的清单，原清单不动（调用方落库失败时要能保持内存原样）  */
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
  /* 参数规格原样收下、交给同一段校验判（`validateConditionItems` → `resolveCondition`）：
     在这里"顺手清掉不合法的参数"会让使用者以为它配上了 —— 那正是"我配的没生效" */
  if (input.params !== undefined) item.params = input.params as unknown as QcConditionParamSpec[];
  const next = [item, ...items];
  /* 交回同一条校验路径（编码 / 名称 / 参数表 / 条件树的合法性都在那里判），
     而不是在编辑口子另写一套 —— 两套的漂移表现是"保存时收下了、扫描时却少一条"  */
  return { items: validateConditionItems(next), itemId };
}

/** 改一条判定方式：返回新的清单，原清单不动  */
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
    /* 清掉说明时删字段而不是写空串：空串过不了校验  */
    if (description === '') delete next.description;
    else next.description = description;
  }
  if (patch.params !== undefined) {
    /* 清空参数表 = 删字段（空数组与缺省在判定上等价，但存下来的形状不同） */
    const params = patch.params as readonly QcConditionParamSpec[] | null;
    if (params === null || (Array.isArray(params) && params.length === 0)) delete next.params;
    else next.params = params as QcConditionParamSpec[];
  }
  if (patch.when !== undefined) next.when = patch.when as JsonValue;
  const out = items.slice();
  out[index] = next;
  /* 校验改动后的整份清单：编码唯一是清单级的性质，
     而"这一条改完还合法吗"由 `resolveCondition` 判  */
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
