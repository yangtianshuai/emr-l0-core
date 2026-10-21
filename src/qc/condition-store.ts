import type { PackRegistry } from '../knowledge/pack.ts';
import { CONFIG_KEY_PREFIX, type ConfigKv } from '../storage/config-kv.ts';
import { conditionLibraryOf, validateConditionItems } from './condition-library.ts';
import { validateRulePack } from './rule-pack.ts';
import type { QcConditionDefinition, QcRulePack } from './types.ts';

export const CONDITION_CONFIG_KEY = `${CONFIG_KEY_PREFIX}qc-conditions`;
export const CONDITION_SEED_KEY = `${CONFIG_KEY_PREFIX}qc-conditions-seeded`;
export const CONDITION_MIGRATION_KEY = `${CONFIG_KEY_PREFIX}qc-conditions-migrated`;

export interface LoadedConditions {
  items: QcConditionDefinition[];
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

export function describeConditions(loaded: LoadedConditions): Record<string, unknown> {
  return {
    items: loaded.items,
    source: loaded.source,
    count: loaded.items.length,
    updatedAt: loaded.updatedAt ?? null,
    updatedBy: loaded.updatedBy ?? null,
  };
}

export function assertLibraryChangeIsSafe(registry: PackRegistry, items: readonly QcConditionDefinition[]): void {
  const library = conditionLibraryOf(items);
  const summaries = [...registry.list('rule')].sort((left, right) => left.packId.localeCompare(right.packId));
  for (const summary of summaries) {
    const pack = registry.get(summary.packId) as QcRulePack | null;
    if (!pack) continue;
    validateRulePack(pack, library);
  }
}
