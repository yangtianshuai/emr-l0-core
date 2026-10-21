import { CONFIG_KEY_PREFIX, type ConfigKv } from '../storage/config-kv.ts';
import {
  DEFAULT_READING_AUTHORITY,
  ReadingAuthorityError,
  isAuthorityConfigured,
  trustedIssuerFingerprints,
  validateReadingAuthority,
  type ReadingAuthorityConfig,
  type ReadingAuthorityInput,
} from './reading-authority.ts';

export const READING_AUTHORITY_KEY = `${CONFIG_KEY_PREFIX}reading-authority`;
export const READING_AUTHORITY_FILE = 'reading-authority.json';

interface StoredReadingAuthority extends ReadingAuthorityConfig {
  version: 1;
  updatedAt: string;
  updatedBy: string;
}

export interface LoadedReadingAuthorityConfig {
  config: ReadingAuthorityConfig;
  source: 'store' | 'default';
  updatedAt?: string;
  updatedBy?: string;
}

function readStored(kv: ConfigKv): StoredReadingAuthority | null {
  const parsed = ((): StoredReadingAuthority | null => {
    try {
      return kv.read<StoredReadingAuthority>(READING_AUTHORITY_KEY);
    } catch (err) {
      throw new ReadingAuthorityError(
        'E_READING_AUTHORITY_INVALID',
        `授权源配置读不出来，拒绝按"未配置"继续（否则会静默退回演示替身）：${(err as Error).message}`,
      );
    }
  })();
  if (parsed === null) return null;
  if (parsed?.version !== 1) return null;
  return parsed;
}

export function loadReadingAuthority(kv: ConfigKv): LoadedReadingAuthorityConfig {
  const stored = readStored(kv);
  if (stored) {
    const { version: _version, updatedAt, updatedBy, ...rest } = stored;
    void _version;
    return { config: validateReadingAuthority(rest), source: 'store', updatedAt, updatedBy };
  }
  return { config: { ...DEFAULT_READING_AUTHORITY }, source: 'default' };
}

export interface SaveReadingAuthorityResult {
  loaded: LoadedReadingAuthorityConfig;
}

export function saveReadingAuthority(
  kv: ConfigKv,
  rawInput: ReadingAuthorityInput,
  by: string,
  options: { at?: string } = {},
): SaveReadingAuthorityResult {
  const config = validateReadingAuthority(rawInput);
  const stored: StoredReadingAuthority = {
    ...config,
    version: 1,
    updatedAt: options.at ?? new Date().toISOString(),
    updatedBy: by,
  };
  kv.write(READING_AUTHORITY_KEY, stored);
  return { loaded: loadReadingAuthority(kv) };
}

export function describeReadingAuthority(loaded: LoadedReadingAuthorityConfig): Record<string, unknown> {
  const config = loaded.config;
  const trust = trustedIssuerFingerprints(config);
  return {
    endpoint: config.endpoint ?? null,
    trustedIssuerFingerprint: config.trustedIssuerFingerprint ?? null,
    trustedIssuerPublicKeyPresent: Boolean(config.trustedIssuerPublicKeyBase64),
    trustedFingerprints: trust.fingerprints,
    configured: isAuthorityConfigured(config),
    source: loaded.source,
    updatedAt: loaded.updatedAt ?? null,
    updatedBy: loaded.updatedBy ?? null,
  };
}
