import { CONFIG_KEY_PREFIX, type ConfigKv } from '../storage/config-kv.ts';
import type { DataElementTag } from '../model/types.ts';
import {
  DEFAULT_PLACEMENT_CONFIG,
  PlacementConfigError,
  validatePlacementConfig,
  type DictationPlacementConfig,
} from './placement.ts';

export const PLACEMENT_CONFIG_KEY = `${CONFIG_KEY_PREFIX}placement`;
export const PLACEMENT_API_KEY_KEY = `${CONFIG_KEY_PREFIX}placement.apiKey`;
export const PLACEMENT_CONFIG_FILE = 'dictation-placement.json';

interface StoredPlacementConfig {
  version: 1;
  strategy: DictationPlacementConfig['strategy'];
  candidate: DictationPlacementConfig['candidate'];
  sectionMap?: Record<string, string>;
  termMap?: Array<{ match: string; nodeId: string }>;
  structureMap?: Record<string, DataElementTag>;
  external?: { endpoint?: string; timeoutMs?: number };
  apiKeyStored: boolean;
  confidenceCeiling: number;
  updatedAt: string;
  updatedBy: string;
}

export interface LoadedPlacementConfig {
  config: DictationPlacementConfig;
  /** 已解出的密钥（内存中，供外呼使用）。不得进入任何返回值、日志或留痕  */
  apiKey?: string;
  /** 这份配置从哪来（`store` = 库里配过；`default` = 从没配过、走本地默认策略） */
  source: 'store' | 'default';
  apiKeyPresent: boolean;
  updatedAt?: string;
  updatedBy?: string;
}

function readStored(kv: ConfigKv): StoredPlacementConfig | null {
  const parsed = ((): StoredPlacementConfig | null => {
    try {
      return kv.read<StoredPlacementConfig>(PLACEMENT_CONFIG_KEY);
    } catch (err) {
      throw new PlacementConfigError('E_PLACEMENT_CONFIG_INVALID', `落位配置读不出来，拒绝按"未配置"继续：${(err as Error).message}`);
    }
  })();
  if (parsed === null) return null;
  if (parsed?.version !== 1) return null;
  return parsed;
}

function readStoredKey(kv: ConfigKv): string | undefined {
  const value = ((): string | null => {
    try {
      return kv.read<string>(PLACEMENT_API_KEY_KEY);
    } catch (err) {
      throw new PlacementConfigError(
        'E_PLACEMENT_CONFIG_INVALID',
        `外部落位密钥读不出来（口令已更换，或那一行被改动过）：${(err as Error).message}；不会当作"没有密钥"继续`,
      );
    }
  })();
  if (value === null) return undefined;
  if (typeof value !== 'string' || value === '') {
    throw new PlacementConfigError('E_PLACEMENT_CONFIG_INVALID', `库里的落位密钥不会是它该有的样子：${JSON.stringify(value)?.slice(0, 40)}`);
  }
  return value;
}

/** 读取生效中的配置：库里有就用库里的，没有就是本地默认策略（不再有环境变量这一档）  */
export function loadPlacementConfig(kv: ConfigKv): LoadedPlacementConfig {
  const stored = readStored(kv);
  if (stored) {
    const config = validatePlacementConfig({
      strategy: stored.strategy,
      candidate: stored.candidate,
      ...(stored.sectionMap ? { sectionMap: stored.sectionMap } : {}),
      ...(stored.termMap ? { termMap: stored.termMap } : {}),
      ...(stored.structureMap ? { structureMap: stored.structureMap } : {}),
      ...(stored.external ? { external: stored.external } : {}),
      confidenceCeiling: stored.confidenceCeiling,
    });
    const apiKey = stored.apiKeyStored ? readStoredKey(kv) : undefined;
    return {
      config,
      ...(apiKey !== undefined ? { apiKey } : {}),
      source: 'store',
      apiKeyPresent: apiKey !== undefined && apiKey !== '',
      updatedAt: stored.updatedAt,
      updatedBy: stored.updatedBy,
    };
  }
  return {
    config: { ...DEFAULT_PLACEMENT_CONFIG, candidate: { ...DEFAULT_PLACEMENT_CONFIG.candidate } },
    source: 'default',
    apiKeyPresent: false,
  };
}

export interface SavePlacementConfigResult {
  loaded: LoadedPlacementConfig;
  apiKeyAction: 'set' | 'cleared' | 'unchanged';
}

export function savePlacementConfig(
  kv: ConfigKv,
  rawInput: Partial<DictationPlacementConfig> & { apiKey?: string | null },
  by: string,
  options: { at?: string } = {},
): SavePlacementConfigResult {
  const { apiKey, ...configInput } = rawInput;
  const config = validatePlacementConfig(configInput);
  const previous = ((): LoadedPlacementConfig | null => {
    try {
      return loadPlacementConfig(kv);
    } catch {
      return null;
    }
  })();

  let apiKeyStored = previous?.source === 'store' ? Boolean(readStored(kv)?.apiKeyStored) : Boolean(previous?.apiKeyPresent);
  let apiKeyAction: SavePlacementConfigResult['apiKeyAction'] = 'unchanged';
  if (apiKey === null) {
    apiKeyStored = false;
    apiKeyAction = 'cleared';
  } else if (typeof apiKey === 'string' && apiKey !== '') {
    kv.write(PLACEMENT_API_KEY_KEY, apiKey);
    apiKeyStored = true;
    apiKeyAction = 'set';
  } else if (apiKey !== undefined && typeof apiKey !== 'string') {
    throw new PlacementConfigError('E_PLACEMENT_CONFIG_INVALID', 'apiKey 必须是字符串、null（清除）或不传（不改）');
  }

  const stored: StoredPlacementConfig = {
    version: 1,
    strategy: config.strategy,
    candidate: config.candidate,
    apiKeyStored,
    confidenceCeiling: config.confidenceCeiling,
    updatedAt: options.at ?? new Date().toISOString(),
    updatedBy: by,
  };
  if (config.sectionMap) stored.sectionMap = config.sectionMap;
  if (config.termMap) stored.termMap = config.termMap;
  if (config.structureMap) stored.structureMap = config.structureMap;
  if (config.external) stored.external = config.external;
  kv.write(PLACEMENT_CONFIG_KEY, stored);
  if (apiKeyAction === 'cleared') kv.remove(PLACEMENT_API_KEY_KEY);

  return { loaded: loadPlacementConfig(kv), apiKeyAction };
}

export function describePlacementConfig(loaded: LoadedPlacementConfig): Record<string, unknown> {
  return {
    strategy: loaded.config.strategy,
    candidate: loaded.config.candidate,
    sectionMap: loaded.config.sectionMap ?? {},
    termMap: loaded.config.termMap ?? [],
    structureMap: loaded.config.structureMap ?? {},
    external: loaded.config.external ?? null,
    confidenceCeiling: loaded.config.confidenceCeiling,
    keyContentThreshold: 0.9,
    apiKeyPresent: loaded.apiKeyPresent,
    source: loaded.source,
    updatedAt: loaded.updatedAt ?? null,
    updatedBy: loaded.updatedBy ?? null,
  };
}
