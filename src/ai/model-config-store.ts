// 模型接入配置的存储（供界面集中配置，取代"只能改环境变量"）。

import { CONFIG_KEY_PREFIX, type ConfigKv } from '../storage/config-kv.ts';
import {
  AiConfigError,
  DEFAULT_AI_MODEL_CONFIG,
  redactConfig,
  type AiModelConfig,
  type AiModelFormat,
} from './model-config.ts';

export const MODEL_CONFIG_KEY = `${CONFIG_KEY_PREFIX}ai-model`;
export const MODEL_KEY_KEY = `${CONFIG_KEY_PREFIX}ai-model.apiKey`;
export const MODEL_CONFIG_FILE = 'ai-model.json';
export const MODEL_KEY_FILE = 'ai-model.key';

export interface ModelConfigInput {
  format: AiModelFormat;
  model: string;
  endpoint?: string;
  timeoutMs: number;
  maxItems: number;
  apiKey?: string | null;
}

interface StoredModelConfig {
  version: 1;
  format: AiModelFormat;
  model: string;
  endpoint?: string;
  timeoutMs: number;
  maxItems: number;
  apiKeyStored: boolean;
  updatedAt: string;
  updatedBy: string;
}

export interface LoadedModelConfig {
  config: AiModelConfig;
  /** 已解出的密钥（内存中，供适配器使用）。不得进入任何返回值、日志或留痕  */
  apiKey?: string;
  /** 这份配置从哪来（`store` = 库里配过；`default` = 从没配过、走离线默认） */
  source: 'store' | 'default';
  apiKeyPresent: boolean;
  updatedAt?: string;
  updatedBy?: string;
}

function readStored(kv: ConfigKv): StoredModelConfig | null {
  const parsed = ((): StoredModelConfig | null => {
    try {
      return kv.read<StoredModelConfig>(MODEL_CONFIG_KEY);
    } catch (err) {
      throw new AiConfigError('E_AI_CONFIG_INVALID', `模型配置读不出来，拒绝按"未配置"继续：${(err as Error).message}`);
    }
  })();
  if (parsed === null) return null;
  if (parsed?.version !== 1) return null;
  return parsed;
}

function readStoredKey(kv: ConfigKv): string | undefined {
  const value = ((): string | null => {
    try {
      return kv.read<string>(MODEL_KEY_KEY);
    } catch (err) {
      throw new AiConfigError(
        'E_AI_CONFIG_INVALID',
        `模型密钥读不出来（口令已更换，或那一行被改动过）：${(err as Error).message}；不会当作"没有密钥"继续 —— 那会表现成"模型突然 401"`,
      );
    }
  })();
  if (value === null) return undefined;
  if (typeof value !== 'string' || value === '') {
    throw new AiConfigError('E_AI_CONFIG_INVALID', `库里的模型密钥不会是它该有的样子：${JSON.stringify(value)?.slice(0, 40)}`);
  }
  return value;
}

/**
 * 读取生效中的配置：库里有就用库里的，没有就是离线默认（不再有环境变量这一档）。
  */
export function loadModelConfig(kv: ConfigKv): LoadedModelConfig {
  const stored = readStored(kv);
  if (stored) {
    const config: AiModelConfig = {
      format: stored.format,
      model: stored.model,
      timeoutMs: stored.timeoutMs,
      maxItems: stored.maxItems,
    };
    if (stored.endpoint) config.endpoint = stored.endpoint;
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
    config: { ...DEFAULT_AI_MODEL_CONFIG },
    source: 'default',
    apiKeyPresent: false,
  };
}

export function validateModelConfigInput(input: Partial<ModelConfigInput>): ModelConfigInput {
  const format = input.format;
  if (format !== 'offline' && format !== 'openai-compatible') {
    throw new AiConfigError('E_AI_CONFIG_INVALID', `format 只能是 offline 或 openai-compatible，实际 ${JSON.stringify(format)}`);
  }
  const model = typeof input.model === 'string' ? input.model.trim() : '';
  const endpoint = typeof input.endpoint === 'string' ? input.endpoint.trim() : '';
  if (format === 'openai-compatible' && !endpoint) {
    throw new AiConfigError(
      'E_AI_CONFIG_NO_ENDPOINT',
      '选了 openai-compatible 却没有填地址：拒绝保存（保存下去就等于"看起来接上了真模型"，而实际没有）',
    );
  }
  if (format === 'openai-compatible' && !model) {
    throw new AiConfigError('E_AI_CONFIG_INVALID', '选了 openai-compatible 却没填模型名：留痕里将答不出"这条内容是哪个模型写的"');
  }
  const timeoutMs = input.timeoutMs ?? DEFAULT_AI_MODEL_CONFIG.timeoutMs;
  const maxItems = input.maxItems ?? DEFAULT_AI_MODEL_CONFIG.maxItems;
  for (const [value, name] of [[timeoutMs, 'timeoutMs'], [maxItems, 'maxItems']] as const) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new AiConfigError('E_AI_CONFIG_INVALID', `${name} 必须是正整数，实际 ${JSON.stringify(value)}（拒绝静默取默认值）`);
    }
  }
  if (input.apiKey !== undefined && input.apiKey !== null && typeof input.apiKey !== 'string') {
    throw new AiConfigError('E_AI_CONFIG_INVALID', 'apiKey 必须是字符串、null（清除）或不传（不改）');
  }
  const result: ModelConfigInput = {
    format,
    model: model || DEFAULT_AI_MODEL_CONFIG.model,
    timeoutMs,
    maxItems,
    ...(endpoint ? { endpoint } : {}),
    ...(input.apiKey !== undefined ? { apiKey: input.apiKey } : {}),
  };
  return result;
}

export interface SaveModelConfigResult {
  loaded: LoadedModelConfig;
  apiKeyAction: 'set' | 'cleared' | 'unchanged';
}

export function saveModelConfig(
  kv: ConfigKv,
  rawInput: Partial<ModelConfigInput>,
  by: string,
  options: { at?: string } = {},
): SaveModelConfigResult {
  const input = validateModelConfigInput(rawInput);
  const previous = ((): LoadedModelConfig | null => {
    try {
      return loadModelConfig(kv);
    } catch {
      return null;
    }
  })();

  let apiKeyStored = previous?.source === 'store' ? Boolean(readStored(kv)?.apiKeyStored) : Boolean(previous?.apiKeyPresent);
  let apiKeyAction: SaveModelConfigResult['apiKeyAction'] = 'unchanged';

  if (input.apiKey === null) {
    apiKeyStored = false;
    apiKeyAction = 'cleared';
  } else if (typeof input.apiKey === 'string' && input.apiKey !== '') {
    kv.write(MODEL_KEY_KEY, input.apiKey);
    apiKeyStored = true;
    apiKeyAction = 'set';
  }

  const stored: StoredModelConfig = {
    version: 1,
    format: input.format,
    model: input.model,
    timeoutMs: input.timeoutMs,
    maxItems: input.maxItems,
    apiKeyStored,
    updatedAt: options.at ?? new Date().toISOString(),
    updatedBy: by,
  };
  if (input.endpoint) stored.endpoint = input.endpoint;
  kv.write(MODEL_CONFIG_KEY, stored);

  if (apiKeyAction === 'cleared') kv.remove(MODEL_KEY_KEY);

  return { loaded: loadModelConfig(kv), apiKeyAction };
}

export function describeModelConfig(loaded: LoadedModelConfig): Record<string, unknown> {
  return {
    ...redactConfig(loaded.config),
    source: loaded.source,
    apiKeyPresent: loaded.apiKeyPresent,
    updatedAt: loaded.updatedAt ?? null,
    updatedBy: loaded.updatedBy ?? null,
  };
}
