/**
 * 落位配置的**存储**（供界面集中配置，取代"写死在调用方"）。
 *
 * ## 为什么不塞进工作区快照
 *
 * 理由与 `ai/model-config-store.ts` 完全相同：快照的语义是"**工作区数据**"，
 * 而落位配置是**部署参数**。混在一起，"重置工作区"会把它一起清掉，
 * "备份工作区"会把一套环境的落点映射带到另一套环境（而它指向的节点 id 在那边根本不存在）。
 * 所以单独存一条（`sealed_kv` 里的 `config.placement`）。
 *
 * 落**库**而不是落文件：备份一次数据库就带走这台机器的全部部署参数（见 `storage/config-kv.ts`）；
 *
 * ## 密钥：从"变量名"改成库里的单独一行
 *
 * V1 的本地策略没有需要保密的字段，只有一份配置。V2 的外部落位服务需要凭据，
 * 原先存的是**环境变量名**（`external.apiKeyEnv`），值由进程环境提供 —— 那有三个问题：
 * 备份带不走、`docker inspect` 能看到、以及"改了环境却忘了重启"这种无迹可查的配错。
 * 现在按 `ai/model-config-store.ts` 同一套纪律：**密钥值单独一行加密落在
 * `config.placement.apiKey`，永不回显**（界面只报"是否就位"），清除时**真删那一行**。
 *
 * ## 配置只有一个来源：库
 *
 * 原先还有第二档"环境变量引导值"（`L0_PLACEMENT_STRATEGY` / `L0_PLACEMENT_CEILING`）。本轮取消。
 */

import { CONFIG_KEY_PREFIX, type ConfigKv } from '../storage/config-kv.ts';
import type { DataElementTag } from '../model/types.ts';
import {
  DEFAULT_PLACEMENT_CONFIG,
  PlacementConfigError,
  validatePlacementConfig,
  type DictationPlacementConfig,
} from './placement.ts';

/** 库里的键名 */
export const PLACEMENT_CONFIG_KEY = `${CONFIG_KEY_PREFIX}placement`;
/** 外部落位服务的密钥：**单独一行**（免得"改个地址"顺手动了密钥那一行） */
export const PLACEMENT_API_KEY_KEY = `${CONFIG_KEY_PREFIX}placement.apiKey`;
/** 旧位置（`<状态目录>/dictation-placement.json`）：**只用于一次性导入**，不再写 */
export const PLACEMENT_CONFIG_FILE = 'dictation-placement.json';

interface StoredPlacementConfig {
  version: 1;
  strategy: DictationPlacementConfig['strategy'];
  candidate: DictationPlacementConfig['candidate'];
  sectionMap?: Record<string, string>;
  termMap?: Array<{ match: string; nodeId: string }>;
  /** V4：即时结构化的词表（词 → 数据元标签）。与 sectionMap / termMap 共用匹配器，但结论不同 */
  structureMap?: Record<string, DataElementTag>;
  /** V2：外部落位服务（地址 / 超时）。**密钥不在这里**，见文件头 */
  external?: { endpoint?: string; timeoutMs?: number };
  /** 是否有密钥被加密落盘（**不存密钥本身**，密钥在 `config.placement.apiKey`） */
  apiKeyStored: boolean;
  confidenceCeiling: number;
  updatedAt: string;
  updatedBy: string;
}

export interface LoadedPlacementConfig {
  config: DictationPlacementConfig;
  /** 已解出的密钥（内存中，供外呼使用）。**不得进入任何返回值、日志或留痕** */
  apiKey?: string;
  /** 这份配置从哪来（`store` = 库里配过；`default` = 从没配过、走本地默认策略） */
  source: 'store' | 'default';
  /** 密钥是否就位（界面只显示这个） */
  apiKeyPresent: boolean;
  updatedAt?: string;
  updatedBy?: string;
}

function readStored(kv: ConfigKv): StoredPlacementConfig | null {
  /* 解不开（口令换过 / 那一行被改过）**不静默当没有**：那会让"我配的落位没了"
     表现成"退回了默认策略"，两件事的处置完全不同（一个是数据损坏要排查，一个是没配过）。
     这里把 `config-kv` 的错误**裹回本模块的错误码**：调用方依赖的是这里的契约。 */
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

/** 取密钥。**解不开 → 抛错**（`config-kv` 已保证不把"解不开"混成"没有"） */
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

/** 读取生效中的配置：**库里有就用库里的，没有就是本地默认策略**（不再有环境变量这一档） */
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
    /* 只在"配置说密钥就位"时才去读密钥那一行：避免每次读配置都解一个用不到的信封 */
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
  /** 密钥发生了什么（**只记动作，不记值**） */
  apiKeyAction: 'set' | 'cleared' | 'unchanged';
}

/**
 * 保存配置并返回**生效后**的配置。
 *
 * 先校验再落盘：非法配置（上限 ≥0.90、external 缺地址、规则表为空项）一律拒绝，
 * 绝不"存下去再用默认值跑" —— 那种现场极难复现。
 *
 * `apiKey` 三态与模型/采集配置逐字相同：`undefined` 不改 / `null` 清除 / 字符串 设新值。
 * **先写配置、最后动密钥那一行**：密钥那一步失败时不会留下"密钥换了、配置还是旧的"这种半截状态。
 */
export function savePlacementConfig(
  kv: ConfigKv,
  rawInput: Partial<DictationPlacementConfig> & { apiKey?: string | null },
  by: string,
  options: { at?: string } = {},
): SavePlacementConfigResult {
  /* 把 `apiKey` 摘出去再校验：它不是 `DictationPlacementConfig` 的一部分（凭据不进配置行） */
  const { apiKey, ...configInput } = rawInput;
  const config = validatePlacementConfig(configInput);
  const previous = ((): LoadedPlacementConfig | null => {
    try {
      return loadPlacementConfig(kv);
    } catch {
      /* 旧配置读坏了不该阻止修复：配置界面正是用来修它的地方 */
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
  /* 清除**要真删那一行**：留着密文而报"已清除"，等于"我清掉了"这句话是假的（同 `saveModelConfig`） */
  if (apiKeyAction === 'cleared') kv.remove(PLACEMENT_API_KEY_KEY);

  return { loaded: loadPlacementConfig(kv), apiKeyAction };
}

/**
 * 给界面的配置视图。
 *
 * `source` 一栏回答"现在跑的是库里配的那一份，还是从没配过的默认"；
 * `apiKeyPresent` 只报"密钥就位没有"（值永不回显，见文件头）。
 */
export function describePlacementConfig(loaded: LoadedPlacementConfig): Record<string, unknown> {
  return {
    strategy: loaded.config.strategy,
    candidate: loaded.config.candidate,
    sectionMap: loaded.config.sectionMap ?? {},
    termMap: loaded.config.termMap ?? [],
    /* V4 词表也要回读：界面靠它回答"这次按什么词标的标签"（读不回来 = 配了等于没配） */
    structureMap: loaded.config.structureMap ?? {},
    /* 只回显地址 / 超时：密钥值不在配置里（它在 `config.placement.apiKey`），所以这里回显是安全的 */
    external: loaded.config.external ?? null,
    confidenceCeiling: loaded.config.confidenceCeiling,
    keyContentThreshold: 0.9,
    /* 只报"就位没有"：密钥值永不回显 */
    apiKeyPresent: loaded.apiKeyPresent,
    source: loaded.source,
    updatedAt: loaded.updatedAt ?? null,
    updatedBy: loaded.updatedBy ?? null,
  };
}
