// 签名后端配置的存储（供界面集中配置）。
// | 加密落库（密封交给 `storage/config-kv.ts`） | 与快照同一口令、复用同一套救回路径；备份一次数据库就带走它 |

import { fromBase64 } from '../crypto/signature.ts';
import { CONFIG_KEY_PREFIX, type ConfigKv } from '../storage/config-kv.ts';
import { publicKeyFingerprint, publicKeyFromSpki } from '../crypto/sm2.ts';
import {
  DEFAULT_SIGN_CONFIG,
  SignConfigError,
  missingSignConfig,
  validateSignConfig,
  type SignBackendConfig,
  type SignConfigInput,
} from './sign-config.ts';

/** 库里的两个键名：配置一条、密钥一条（分开，免得"改地址"顺手动了密钥那一行）  */
export const SIGN_CONFIG_KEY = `${CONFIG_KEY_PREFIX}sign-backend`;
export const SIGN_API_KEY_KEY = `${CONFIG_KEY_PREFIX}sign.apiKey`;
/** 旧位置（`<状态目录>/sign-backend.json`）：只用于一次性导入，不再写  */
export const SIGN_CONFIG_FILE = 'sign-backend.json';

interface StoredSignConfig extends SignBackendConfig {
  version: 1;
  /** 是否有认证密钥被加密落库（不存密钥本身，密钥在 `config.sign.apiKey`）  */
  apiKeyStored: boolean;
  updatedAt: string;
  updatedBy: string;
}

export interface LoadedSignConfig {
  config: SignBackendConfig;
  /** 已解出的密钥（内存中，供适配器使用）。不得进入任何返回值、日志或留痕  */
  apiKey?: string;
  /** 这份配置从哪来 —— 界面必须显示它，否则"我改了却没生效"无从判断 */
  source: 'store' | 'default';
  /** 密钥是否就位（真值来源，界面只显示这个） */
  apiKeyPresent: boolean;
  updatedAt?: string;
  updatedBy?: string;
}

function readStored(kv: ConfigKv): StoredSignConfig | null {
  /* 读坏了不静默当没有：那会让"我配的签名服务没了"表现成"退回了软件签名"，
     而"以为在用签名服务、其实是内置演示密钥"正是最危险的一种现场。
     （`config-kv` 负责"解密失败 ≠ 没有"这一半，这里只管版本号。）  */
  const parsed = ((): StoredSignConfig | null => {
    try {
      return kv.read<StoredSignConfig>(SIGN_CONFIG_KEY);
    } catch (err) {
      /* 裹回本模块的错误码：调用方依赖的是 `E_SIGN_CONFIG_INVALID` 这个契约 */
      throw new SignConfigError('E_SIGN_CONFIG_INVALID', `签名配置读不出来，拒绝按"未配置"继续：${(err as Error).message}`);
    }
  })();
  if (parsed === null) return null;
  if (parsed?.version !== 1) return null;
  return parsed;
}

/** 取密钥。解不开 → 抛错（`config-kv` 已保证不把"解不开"混成"没有"）  */
function readStoredKey(kv: ConfigKv): string | undefined {
  const value = ((): string | null => {
    try {
      return kv.read<string>(SIGN_API_KEY_KEY);
    } catch (err) {
      throw new SignConfigError(
        'E_SIGN_CONFIG_INVALID',
        `签名密钥读不出来（口令已更换，或那一行被改动过）：${(err as Error).message}；不会当作"没有密钥"继续 —— 那会表现成"签名突然 401"`,
      );
    }
  })();
  if (value === null) return undefined;
  if (typeof value !== 'string' || value === '') {
    /* 存着一个非字符串/空值：那是数据坏了，不是"没有密钥"。宁可报出来。 */
    throw new SignConfigError('E_SIGN_CONFIG_INVALID', `库里的签名密钥不会是它该有的样子：${JSON.stringify(value)?.slice(0, 40)}`);
  }
  return value;
}

export function loadSignConfig(kv: ConfigKv): LoadedSignConfig {
  const stored = readStored(kv);
  if (stored) {
    const { version: _version, apiKeyStored, updatedAt, updatedBy, ...rest } = stored;
    void _version;
    /* 只在"配置说密钥就位"时才去读密钥那一行：避免每次读配置都解一个用不到的信封 */
    const apiKey = apiKeyStored ? readStoredKey(kv) : undefined;
    return {
      config: validateSignConfig(rest),
      ...(apiKey !== undefined ? { apiKey } : {}),
      source: 'store',
      apiKeyPresent: apiKey !== undefined && apiKey !== '',
      updatedAt,
      updatedBy,
    };
  }
  return { config: { ...DEFAULT_SIGN_CONFIG }, source: 'default', apiKeyPresent: false };
}

export interface SaveSignConfigResult {
  loaded: LoadedSignConfig;
  /** 密钥发生了什么（只记动作，不记值）  */
  apiKeyAction: 'set' | 'cleared' | 'unchanged';
}

/**
 * 保存配置并返回生效后的配置。
 *
 * 先写非敏感配置、最后处理密钥（同 `saveModelConfig` / `saveCaptureConfig`）：若密钥这一步失败
 * （比如口令缺失），至少不会出现"密钥已更新但配置还是旧的"这种半截状态。
  */
export function saveSignConfig(
  kv: ConfigKv,
  rawInput: SignConfigInput,
  by: string,
  options: { at?: string } = {},
): SaveSignConfigResult {
  const config = validateSignConfig(rawInput);
  const previous = ((): LoadedSignConfig | null => {
    try {
      return loadSignConfig(kv);
    } catch {
      /* 旧配置读坏了不该阻止修复：管理界面正是用来修它的地方 */
      return null;
    }
  })();

  let apiKeyStored = previous?.source === 'store' ? Boolean(readStored(kv)?.apiKeyStored) : Boolean(previous?.apiKeyPresent);
  let apiKeyAction: SaveSignConfigResult['apiKeyAction'] = 'unchanged';
  if (rawInput.apiKey === null) {
    apiKeyStored = false;
    apiKeyAction = 'cleared';
  } else if (typeof rawInput.apiKey === 'string' && rawInput.apiKey !== '') {
    kv.write(SIGN_API_KEY_KEY, rawInput.apiKey);
    apiKeyStored = true;
    apiKeyAction = 'set';
  } else if (rawInput.apiKey !== undefined && typeof rawInput.apiKey !== 'string') {
    throw new SignConfigError('E_SIGN_CONFIG_INVALID', 'apiKey 必须是字符串、null（清除）或不传（不改）');
  }

  const stored: StoredSignConfig = {
    ...config,
    version: 1,
    apiKeyStored,
    updatedAt: options.at ?? new Date().toISOString(),
    updatedBy: by,
  };
  kv.write(SIGN_CONFIG_KEY, stored);
  /* 清除时要真删那一行：只把 apiKeyStored 置 false 而留着密文，
     等于"我清掉了"这句话是假的（同 `saveModelConfig` 尾部那段教训）。  */
  if (apiKeyAction === 'cleared') kv.remove(SIGN_API_KEY_KEY);

  return { loaded: loadSignConfig(kv), apiKeyAction };
}

export function describeSignConfig(loaded: LoadedSignConfig): Record<string, unknown> {
  const config = loaded.config;
  let presetFingerprint: string | null = null;
  if (config.publicKeyBase64) {
    try {
      presetFingerprint = publicKeyFingerprint(publicKeyFromSpki(fromBase64(config.publicKeyBase64)));
    } catch {
      presetFingerprint = null;
    }
  }
  return {
    http: config.http ?? null,
    /** 密钥是否就位（真值来源）：界面据此显示"已设置/未设置"，值永不回显  */
    apiKeyPresent: loaded.apiKeyPresent,
    expectedFingerprint: config.expectedFingerprint ?? null,
    publicKeyPresent: Boolean(config.publicKeyBase64),
    publicKeyFingerprint: presetFingerprint,
    /**
     * 是否足以签章（不是"配过没有"：只填了地址也不算）。
     * 不够时把缺哪些一并给出 —— 界面上"签不了"必须能一路追到"还差哪一格"。
      */
    configured: missingSignConfig(config).length === 0,
    missing: missingSignConfig(config),
    source: loaded.source,
    updatedAt: loaded.updatedAt ?? null,
    updatedBy: loaded.updatedBy ?? null,
  };
}
