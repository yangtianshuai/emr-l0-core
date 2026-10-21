import { CONFIG_KEY_PREFIX, type ConfigKv } from '../storage/config-kv.ts';
import {
  ASR_KINDS,
  CaptureError,
  DEFAULT_CAPTURE_CONFIG,
  missingCredentialSlots,
  validateCaptureConfig,
  vendorOf,
  type AsrKind,
  type CaptureConfig,
  type CaptureConfigPatch,
  type SegmentConfig,
} from './capture.ts';

export const CAPTURE_CONFIG_KEY = `${CONFIG_KEY_PREFIX}capture`;
export const CAPTURE_API_KEY_KEY = `${CONFIG_KEY_PREFIX}capture.apiKey`;
export const CAPTURE_API_SECRET_KEY = `${CONFIG_KEY_PREFIX}capture.apiSecret`;
export const CAPTURE_CONFIG_FILE = 'dictation-capture.json';

export interface CaptureConfigInput {
  kind?: string;
  endpoint?: string;
  appKey?: string;
  acknowledgePublicCloud?: boolean;
  modelId?: string;
  submitTimeoutMs?: number;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  silenceMs?: number;
  maxSeconds?: number;
  minSeconds?: number;
  retainAudio?: boolean;
  confidenceCeiling?: number;
  apiKey?: string | null;
  apiSecret?: string | null;
}

interface StoredCaptureConfig {
  version: 1 | 2;
  kind?: string;
  endpoint: string;
  appKey?: string;
  acknowledgePublicCloud?: boolean;
  modelId: string;
  submitTimeoutMs: number;
  pollIntervalMs: number;
  pollTimeoutMs: number;
  segment: SegmentConfig;
  retainAudio: boolean;
  confidenceCeiling: number;
  apiKeyStored: boolean;
  apiSecretStored?: boolean;
  updatedAt: string;
  updatedBy: string;
}

export interface LoadedCaptureConfig {
  config: CaptureConfig;
  /** 已解出的主凭据（内存中，供转发时使用）。不得进入任何返回值、日志或留痕  */
  apiKey?: string;
  apiSecret?: string;
  /** 这份配置从哪来（`store` = 库里配过；`default` = 从没配过、走未配置默认） */
  source: 'store' | 'default';
  apiKeyPresent: boolean;
  apiSecretPresent: boolean;
  configured: boolean;
  updatedAt?: string;
  updatedBy?: string;
}

function readStored(kv: ConfigKv): StoredCaptureConfig | null {
  const parsed = ((): StoredCaptureConfig | null => {
    try {
      return kv.read<StoredCaptureConfig>(CAPTURE_CONFIG_KEY);
    } catch (err) {
      throw new CaptureError('E_CAPTURE_CONFIG_INVALID', `采集配置读不出来，拒绝按"未配置"继续：${(err as Error).message}`);
    }
  })();
  if (parsed === null) return null;
  if (parsed?.version !== 1 && parsed?.version !== 2) return null;
  return parsed;
}

function readStoredSecret(kv: ConfigKv, key: string, what: string): string | undefined {
  const value = ((): string | null => {
    try {
      return kv.read<string>(key);
    } catch (err) {
      throw new CaptureError(
        'E_CAPTURE_CONFIG_INVALID',
        `${what}读不出来（口令已更换，或那一行被改动过）：${(err as Error).message}；不会当作"没有密钥"继续`,
      );
    }
  })();
  if (value === null) return undefined;
  if (typeof value !== 'string' || value === '') {
    throw new CaptureError('E_CAPTURE_CONFIG_INVALID', `库里的${what}不会是它该有的样子：${JSON.stringify(value)?.slice(0, 40)}`);
  }
  return value;
}

function applySecret(kv: ConfigKv, key: string, value: string | null | undefined, what: string): 'set' | 'cleared' | 'unchanged' {
  if (value === null) {
    kv.remove(key);
    return 'cleared';
  }
  if (typeof value === 'string' && value !== '') {
    kv.write(key, value);
    return 'set';
  }
  if (value !== undefined && typeof value !== 'string') {
    throw new CaptureError('E_CAPTURE_CONFIG_INVALID', `${what}必须是字符串、null（清除）或不传（不改）`);
  }
  return 'unchanged';
}

function toNested(input: CaptureConfigInput): CaptureConfigPatch {
  const asr: NonNullable<CaptureConfigPatch['asr']> = {};
  if (input.kind !== undefined) asr.kind = input.kind as AsrKind;
  if (input.endpoint !== undefined) asr.endpoint = input.endpoint;
  if (input.appKey !== undefined) asr.appKey = input.appKey;
  if (input.acknowledgePublicCloud !== undefined) asr.acknowledgePublicCloud = input.acknowledgePublicCloud;
  if (input.modelId !== undefined) asr.modelId = input.modelId;
  if (input.submitTimeoutMs !== undefined) asr.submitTimeoutMs = input.submitTimeoutMs;
  if (input.pollIntervalMs !== undefined) asr.pollIntervalMs = input.pollIntervalMs;
  if (input.pollTimeoutMs !== undefined) asr.pollTimeoutMs = input.pollTimeoutMs;
  const segment: Partial<SegmentConfig> = {};
  if (input.silenceMs !== undefined) segment.silenceMs = input.silenceMs;
  if (input.maxSeconds !== undefined) segment.maxSeconds = input.maxSeconds;
  if (input.minSeconds !== undefined) segment.minSeconds = input.minSeconds;
  return {
    asr,
    segment,
    ...(input.retainAudio !== undefined ? { retainAudio: input.retainAudio } : {}),
    ...(input.confidenceCeiling !== undefined ? { confidenceCeiling: input.confidenceCeiling } : {}),
  };
}

/** 读取生效中的配置：库里有就用库里的，没有就是未配置默认（不再有环境变量这一档）  */
export function loadCaptureConfig(kv: ConfigKv): LoadedCaptureConfig {
  const stored = readStored(kv);
  if (stored) {
    const config = validateCaptureConfig({
      asr: {
        /* v1 的行没有这三项：`undefined` → 校验层补默认（也就是"院内服务"），这正是升级该有的行为 */
        kind: stored.kind as AsrKind | undefined,
        endpoint: stored.endpoint,
        appKey: stored.appKey,
        acknowledgePublicCloud: stored.acknowledgePublicCloud,
        modelId: stored.modelId,
        submitTimeoutMs: stored.submitTimeoutMs,
        pollIntervalMs: stored.pollIntervalMs,
        pollTimeoutMs: stored.pollTimeoutMs,
      },
      segment: stored.segment,
      retainAudio: stored.retainAudio,
      confidenceCeiling: stored.confidenceCeiling,
    });
    const apiKey = stored.apiKeyStored ? readStoredSecret(kv, CAPTURE_API_KEY_KEY, '采集密钥') : undefined;
    const apiSecret = stored.apiSecretStored ? readStoredSecret(kv, CAPTURE_API_SECRET_KEY, '采集次凭据') : undefined;
    const apiKeyPresent = apiKey !== undefined && apiKey !== '';
    const apiSecretPresent = apiSecret !== undefined && apiSecret !== '';
    return {
      config,
      ...(apiKey !== undefined ? { apiKey } : {}),
      ...(apiSecret !== undefined ? { apiSecret } : {}),
      source: 'store',
      apiKeyPresent,
      apiSecretPresent,
      configured:
        config.asr.endpoint !== '' &&
        config.asr.modelId !== '' &&
        missingCredentialSlots(vendorOf(config.asr.kind), { apiKey: apiKeyPresent, apiSecret: apiSecretPresent }, config.asr.appKey).length === 0,
      updatedAt: stored.updatedAt,
      updatedBy: stored.updatedBy,
    };
  }
  const config = { ...DEFAULT_CAPTURE_CONFIG, asr: { ...DEFAULT_CAPTURE_CONFIG.asr }, segment: { ...DEFAULT_CAPTURE_CONFIG.segment } };
  return { config, source: 'default', apiKeyPresent: false, apiSecretPresent: false, configured: false };
}

export interface SaveCaptureConfigResult {
  loaded: LoadedCaptureConfig;
  apiKeyAction: 'set' | 'cleared' | 'unchanged';
  apiSecretAction: 'set' | 'cleared' | 'unchanged';
}

export function saveCaptureConfig(
  kv: ConfigKv,
  rawInput: CaptureConfigInput,
  by: string,
  options: { at?: string } = {},
): SaveCaptureConfigResult {
  const previous = ((): LoadedCaptureConfig | null => {
    try {
      return loadCaptureConfig(kv);
    } catch {
      return null;
    }
  })();

  const nested = toNested(rawInput);
  const base = previous?.config ?? DEFAULT_CAPTURE_CONFIG;
  const config = validateCaptureConfig({
    asr: { ...base.asr, ...nested.asr },
    segment: { ...base.segment, ...nested.segment },
    ...(nested.retainAudio === undefined ? { retainAudio: base.retainAudio } : { retainAudio: nested.retainAudio }),
    ...(nested.confidenceCeiling === undefined ? { confidenceCeiling: base.confidenceCeiling } : { confidenceCeiling: nested.confidenceCeiling }),
  });

  const previousStored = previous?.source === 'store' ? readStored(kv) : null;
  let apiKeyStored = previousStored ? Boolean(previousStored.apiKeyStored) : Boolean(previous?.apiKeyPresent);
  let apiSecretStored = previousStored ? Boolean(previousStored.apiSecretStored) : Boolean(previous?.apiSecretPresent);
  const apiKeyAction = applySecret(kv, CAPTURE_API_KEY_KEY, rawInput.apiKey, 'apiKey');
  if (apiKeyAction === 'set') apiKeyStored = true;
  if (apiKeyAction === 'cleared') apiKeyStored = false;
  const apiSecretAction = applySecret(kv, CAPTURE_API_SECRET_KEY, rawInput.apiSecret, 'apiSecret');
  if (apiSecretAction === 'set') apiSecretStored = true;
  if (apiSecretAction === 'cleared') apiSecretStored = false;

  const stored: StoredCaptureConfig = {
    version: 2,
    kind: config.asr.kind,
    endpoint: config.asr.endpoint,
    appKey: config.asr.appKey,
    acknowledgePublicCloud: config.asr.acknowledgePublicCloud,
    modelId: config.asr.modelId,
    submitTimeoutMs: config.asr.submitTimeoutMs,
    pollIntervalMs: config.asr.pollIntervalMs,
    pollTimeoutMs: config.asr.pollTimeoutMs,
    segment: config.segment,
    retainAudio: config.retainAudio,
    confidenceCeiling: config.confidenceCeiling,
    apiKeyStored,
    apiSecretStored,
    updatedAt: options.at ?? new Date().toISOString(),
    updatedBy: by,
  };
  kv.write(CAPTURE_CONFIG_KEY, stored);

  return { loaded: loadCaptureConfig(kv), apiKeyAction, apiSecretAction };
}

export function describeCaptureConfig(loaded: LoadedCaptureConfig): Record<string, unknown> {
  const vendor = vendorOf(loaded.config.asr.kind);
  return {
    kind: loaded.config.asr.kind,
    vendorLabel: vendor.label,
    protocol: vendor.protocol,
    timingNote: vendor.timingNote,
    defaultEndpoint: vendor.defaultEndpoint,
    modelIdHint: vendor.modelIdHint,
    credentialShape: vendor.credentials,
    vendors: ASR_KINDS.map((kind) => {
      const item = vendorOf(kind);
      return {
        kind: item.kind,
        label: item.label,
        leavesIntranet: item.leavesIntranet,
        credentialShape: item.credentials,
        defaultEndpoint: item.defaultEndpoint,
        modelIdHint: item.modelIdHint,
        protocol: item.protocol,
        timingNote: item.timingNote,
      };
    }),
    /* 音频是否出院：界面必须据此红标，审计也必须记下这一笔 */
    leavesIntranet: vendor.leavesIntranet,
    acknowledgePublicCloud: loaded.config.asr.acknowledgePublicCloud,
    appKey: loaded.config.asr.appKey,
    endpoint: loaded.config.asr.endpoint,
    modelId: loaded.config.asr.modelId,
    submitTimeoutMs: loaded.config.asr.submitTimeoutMs,
    pollIntervalMs: loaded.config.asr.pollIntervalMs,
    pollTimeoutMs: loaded.config.asr.pollTimeoutMs,
    segment: loaded.config.segment,
    retainAudio: loaded.config.retainAudio,
    confidenceCeiling: loaded.config.confidenceCeiling,
    keyContentThreshold: 0.9,
    apiKeyPresent: loaded.apiKeyPresent,
    apiSecretPresent: loaded.apiSecretPresent,
    configured: loaded.configured,
    missing: [
      ...(loaded.config.asr.endpoint === '' ? ['服务地址'] : []),
      ...(loaded.config.asr.modelId === '' ? ['模型标识'] : []),
      ...missingCredentialSlots(vendor, { apiKey: loaded.apiKeyPresent, apiSecret: loaded.apiSecretPresent }, loaded.config.asr.appKey),
    ],
    source: loaded.source,
    updatedAt: loaded.updatedAt ?? null,
    updatedBy: loaded.updatedBy ?? null,
  };
}
