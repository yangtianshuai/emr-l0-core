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

export const SIGN_CONFIG_KEY = `${CONFIG_KEY_PREFIX}sign-backend`;
export const SIGN_API_KEY_KEY = `${CONFIG_KEY_PREFIX}sign.apiKey`;
export const SIGN_CONFIG_FILE = 'sign-backend.json';

interface StoredSignConfig extends SignBackendConfig {
  version: 1;
  apiKeyStored: boolean;
  updatedAt: string;
  updatedBy: string;
}

export interface LoadedSignConfig {
  config: SignBackendConfig;
  /** 已解出的密钥（内存中，供适配器使用）。不得进入任何返回值、日志或留痕  */
  apiKey?: string;
  source: 'store' | 'default';
  apiKeyPresent: boolean;
  updatedAt?: string;
  updatedBy?: string;
}

function readStored(kv: ConfigKv): StoredSignConfig | null {
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
    throw new SignConfigError('E_SIGN_CONFIG_INVALID', `库里的签名密钥不会是它该有的样子：${JSON.stringify(value)?.slice(0, 40)}`);
  }
  return value;
}

export function loadSignConfig(kv: ConfigKv): LoadedSignConfig {
  const stored = readStored(kv);
  if (stored) {
    const { version: _version, apiKeyStored, updatedAt, updatedBy, ...rest } = stored;
    void _version;
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
  apiKeyAction: 'set' | 'cleared' | 'unchanged';
}

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
    apiKeyPresent: loaded.apiKeyPresent,
    expectedFingerprint: config.expectedFingerprint ?? null,
    publicKeyPresent: Boolean(config.publicKeyBase64),
    publicKeyFingerprint: presetFingerprint,
    configured: missingSignConfig(config).length === 0,
    missing: missingSignConfig(config),
    source: loaded.source,
    updatedAt: loaded.updatedAt ?? null,
    updatedBy: loaded.updatedBy ?? null,
  };
}
