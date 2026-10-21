import { publicKeyFingerprint, publicKeyFromSpki } from '../crypto/sm2.ts';
import { fromBase64 } from '../crypto/signature.ts';
import type { ReadingCredential } from '../core/controlled-reading.ts';

export interface ReadingAuthorityConfig {
  endpoint?: string;
  trustedIssuerFingerprint?: string;
  trustedIssuerPublicKeyBase64?: string;
}

/** 默认 = 什么都没有（未配置状态）。受控阅读在此状态下拒绝一切凭据  */
export const DEFAULT_READING_AUTHORITY: ReadingAuthorityConfig = {};

export type ReadingAuthorityErrorCode =
  | 'E_READING_AUTHORITY_INVALID'
  | 'E_READING_AUTHORITY_BAD_FINGERPRINT'
  | 'E_READING_AUTHORITY_KEY_MISMATCH';

export class ReadingAuthorityError extends Error {
  code: ReadingAuthorityErrorCode;

  constructor(code: ReadingAuthorityErrorCode, message: string) {
    super(message);
    this.name = 'ReadingAuthorityError';
    this.code = code;
  }
}

export interface ReadingAuthorityInput {
  endpoint?: string;
  trustedIssuerFingerprint?: string;
  trustedIssuerPublicKeyBase64?: string;
}

export function isFingerprint(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

function optionalText(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ReadingAuthorityError('E_READING_AUTHORITY_INVALID', `${name} 必须是非空字符串，实际 ${JSON.stringify(value)}`);
  }
  return value.trim();
}

export function validateReadingAuthority(input: ReadingAuthorityInput): ReadingAuthorityConfig {
  const config: ReadingAuthorityConfig = {};

  const endpoint = optionalText(input.endpoint, 'endpoint');
  if (endpoint) config.endpoint = endpoint;

  const keyText = optionalText(input.trustedIssuerPublicKeyBase64, 'trustedIssuerPublicKeyBase64') ?? '';
  let derived: string | undefined;
  if (keyText !== '') {
    try {
      derived = publicKeyFingerprint(publicKeyFromSpki(fromBase64(keyText)));
    } catch (err) {
      throw new ReadingAuthorityError(
        'E_READING_AUTHORITY_INVALID',
        `trustedIssuerPublicKeyBase64 不是合法的 SM2 公钥（SPKI base64）：${(err as Error).message}`,
      );
    }
    config.trustedIssuerPublicKeyBase64 = keyText;
  }

  const claimed = (optionalText(input.trustedIssuerFingerprint, 'trustedIssuerFingerprint') ?? '').toLowerCase();
  if (claimed !== '') {
    if (!isFingerprint(claimed)) {
      throw new ReadingAuthorityError(
        'E_READING_AUTHORITY_BAD_FINGERPRINT',
        `trustedIssuerFingerprint 必须是 64 位十六进制（SM3 指纹），实际 ${JSON.stringify(input.trustedIssuerFingerprint)}`,
      );
    }
    if (derived && derived !== claimed) {
      throw new ReadingAuthorityError(
        'E_READING_AUTHORITY_KEY_MISMATCH',
        `trustedIssuerFingerprint(${claimed}) 与 trustedIssuerPublicKeyBase64 的实际指纹(${derived}) 不一致：拒绝保存`,
      );
    }
    config.trustedIssuerFingerprint = claimed;
  } else if (derived) {
    config.trustedIssuerFingerprint = derived;
  }

  return config;
}

export type ReadingAuthorityDenyCode = 'E_UNTRUSTED_ISSUER';

export interface AuthorityDecision {
  ok: boolean;
  code?: ReadingAuthorityDenyCode;
  reason?: string;
}

export function isAuthorityConfigured(config: ReadingAuthorityConfig): boolean {
  return typeof config.trustedIssuerFingerprint === 'string' && config.trustedIssuerFingerprint !== '';
}

export function trustedIssuerFingerprints(config: ReadingAuthorityConfig): { fingerprints: string[] } {
  return { fingerprints: isAuthorityConfigured(config) ? [config.trustedIssuerFingerprint as string] : [] };
}

export function checkIssuerTrust(credential: ReadingCredential, config: ReadingAuthorityConfig): AuthorityDecision {
  const { fingerprints } = trustedIssuerFingerprints(config);
  if (fingerprints.length === 0) {
    return {
      ok: false,
      code: 'E_UNTRUSTED_ISSUER',
      reason: '尚未配置授权平台（信任的签发者公钥）：拒绝任何凭据 —— 宁可受控阅读不可用，也不放行来源不明的授权',
    };
  }
  const actual = credential.publicKeyFingerprint;
  if (!fingerprints.includes(actual)) {
    return {
      ok: false,
      code: 'E_UNTRUSTED_ISSUER',
      reason: `该凭据由 ${actual} 签发，不是当前信任的授权平台（${fingerprints.join('、')}）`,
    };
  }
  return { ok: true };
}

export type CredentialParseErrorCode = 'E_CREDENTIAL_MALFORMED';

export type ParsedCredential =
  | { ok: true; credential: ReadingCredential }
  | { ok: false; code: CredentialParseErrorCode; reason: string };

function requiredString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

export function parseCredential(text: string): ParsedCredential {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { ok: false, code: 'E_CREDENTIAL_MALFORMED', reason: `不是合法 JSON：${(err as Error).message}` };
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, code: 'E_CREDENTIAL_MALFORMED', reason: '授权凭据必须是一个 JSON 对象' };
  }
  const source = raw as Record<string, unknown>;
  const grantRaw = source.grant;
  if (grantRaw === null || typeof grantRaw !== 'object' || Array.isArray(grantRaw)) {
    return { ok: false, code: 'E_CREDENTIAL_MALFORMED', reason: '缺少 grant（授权书本体）' };
  }
  const grant = grantRaw as Record<string, unknown>;

  for (const key of ['grantId', 'docId', 'documentFingerprint', 'notBefore', 'notAfter', 'issuedBy', 'issuedAt', 'purpose'] as const) {
    if (!requiredString(grant, key)) {
      return { ok: false, code: 'E_CREDENTIAL_MALFORMED', reason: `授权书缺字段或字段为空：grant.${key}` };
    }
  }
  for (const key of ['allowedSections', 'allowedEnvironments'] as const) {
    if (!Array.isArray(grant[key])) {
      return { ok: false, code: 'E_CREDENTIAL_MALFORMED', reason: `授权书的 ${key} 必须是数组` };
    }
  }
  if (!(grant.maxReads === null || (typeof grant.maxReads === 'number' && Number.isFinite(grant.maxReads)))) {
    return { ok: false, code: 'E_CREDENTIAL_MALFORMED', reason: '授权书的 maxReads 必须是数字或 null（不限次）' };
  }

  for (const key of ['publicKeyBase64', 'publicKeyFingerprint', 'signatureValue', 'signedInfoDigest'] as const) {
    if (!requiredString(source, key)) {
      return { ok: false, code: 'E_CREDENTIAL_MALFORMED', reason: `凭据缺字段或字段为空：${key}` };
    }
  }
  if (!Array.isArray(source.references) || source.references.length === 0) {
    return { ok: false, code: 'E_CREDENTIAL_MALFORMED', reason: '凭据的 references 必须是非空数组（授权书靠它参与验签）' };
  }

  return { ok: true, credential: raw as ReadingCredential };
}
