// 判定方式库的落库层：库里有哪些判定方式（`config.qc-conditions` 一行）。
// - 配过但解不开（口令换过 / 那一行被改过）→ 抛错，拒绝按"没配过"继续。

import type { PackRegistry } from '../knowledge/pack.ts';
import { CONFIG_KEY_PREFIX, type ConfigKv } from '../storage/config-kv.ts';
import { conditionLibraryOf, validateConditionItems } from './condition-library.ts';
import { validateRulePack } from './rule-pack.ts';
import type { QcConditionDefinition, QcRulePack } from './types.ts';

export const CONDITION_CONFIG_KEY = `${CONFIG_KEY_PREFIX}qc-conditions`;
export const CONDITION_SEED_KEY = `${CONFIG_KEY_PREFIX}qc-conditions-seeded`;
/**
 * 记账："把留在包里的判定方式搬进库"那次一次性迁移跑过没有。
 *
 * 需要它，是因为判定方式一度是包内容（出厂种子写进自建包那一版）。
 * 迁移本身是幂等的（包里没有条件条目时什么都不做），但记账省掉每次启动扫一遍所有包，
 * 也让"这次启动到底动过什么"留在日志里只有一次。
  */
export const CONDITION_MIGRATION_KEY = `${CONFIG_KEY_PREFIX}qc-conditions-migrated`;

export interface LoadedConditions {
  items: QcConditionDefinition[];
  /** `empty` = 库里一条判定方式都没有（空就是空，不替你编几条出来）  */
  source: 'store' | 'empty';
  updatedAt?: string;
  updatedBy?: string;
}

export type ConditionStoreErrorCode = 'E_CONDITION_INVALID';

export class ConditionStoreError extends Error {
  code: ConditionStoreErrorCode;

  constructor(code: ConditionStoreErrorCode, message: string) {
    super(message);
    this.name = 'ConditionStoreError';
    this.code = code;
  }
}

interface StoredConditions {
  version: 1;
  items: QcConditionDefinition[];
  updatedAt: string;
  updatedBy: string;
}

function readStored(kv: ConfigKv): StoredConditions | null {
  const parsed = ((): StoredConditions | null => {
    try {
      return kv.read<StoredConditions>(CONDITION_CONFIG_KEY);
    } catch (err) {
      throw new ConditionStoreError(
        'E_CONDITION_INVALID',
        `判定方式库读不出来，拒绝按"库里没有判定方式"继续（那会让引用它们的规则集体变成悬空引用）：${(err as Error).message}`,
      );
    }
  })();
  if (parsed === null) return null;
  if (parsed?.version !== 1) return null;
  return parsed;
}

/** 读取判定方式库：库里有就用库里的，没有就是空  */
export function loadConditions(kv: ConfigKv): LoadedConditions {
  const stored = readStored(kv);
  if (!stored) return { items: [], source: 'empty' };
  return {
    items: validateConditionItems(stored.items),
    source: 'store',
    updatedAt: stored.updatedAt,
    updatedBy: stored.updatedBy,
  };
}

/** 保存判定方式库并返回生效后的那一份  */
export function saveConditions(
  kv: ConfigKv,
  rawItems: unknown,
  by: string,
  options: { at?: string } = {},
): LoadedConditions {
  const items = validateConditionItems(rawItems);
  const stored: StoredConditions = {
    version: 1,
    items,
    updatedAt: options.at ?? new Date().toISOString(),
    updatedBy: by,
  };
  kv.write(CONDITION_CONFIG_KEY, stored);
  return loadConditions(kv);
}

export function conditionsSeeded(kv: ConfigKv): boolean {
  return kv.read<boolean>(CONDITION_SEED_KEY) === true;
}

export function markConditionsSeeded(kv: ConfigKv): void {
  kv.write(CONDITION_SEED_KEY, true);
}

/** 给界面的视图（条目本身 + 来源与最近改动，界面据此说"库里有没有"） */
export function describeConditions(loaded: LoadedConditions): Record<string, unknown> {
  return {
    items: loaded.items,
    source: loaded.source,
    count: loaded.items.length,
    updatedAt: loaded.updatedAt ?? null,
    updatedBy: loaded.updatedBy ?? null,
  };
}

/**
 * 拿一份改动后的库把每个规则包试算一遍：任一包不通过就抛那句话（不落库）。
 *
 * 调用方在写入前用它：这样"改一条判定方式把某几条规则改坏"报在保存那一刻，
 * 并带上是哪一条规则 —— 而不是等到下次装包时冒出一句"整包不通过"。
  */
export function assertLibraryChangeIsSafe(registry: PackRegistry, items: readonly QcConditionDefinition[]): void {
  const library = conditionLibraryOf(items);
  const summaries = [...registry.list('rule')].sort((left, right) => left.packId.localeCompare(right.packId));
  for (const summary of summaries) {
    const pack = registry.get(summary.packId) as QcRulePack | null;
    if (!pack) continue;
    validateRulePack(pack, library);
  }
}
