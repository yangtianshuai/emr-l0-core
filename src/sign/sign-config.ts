import type { Sm2Point } from '../crypto/sm2.ts';
import { publicKeyFingerprint, publicKeyFromSpki } from '../crypto/sm2.ts';
import { fromBase64 } from '../crypto/signature.ts';
import { SIGNATURE_ALGORITHM } from '../crypto/provider.ts';

export interface HttpRequestMapping {
  toSignField: string;
  toSignEncoding: 'base64' | 'hex';
  digestField?: string;
  algorithmField?: string;
  keyIdField?: string;
  extra?: Record<string, string>;
}

export interface HttpResponseMapping {
  /** 签名值的 JSON 路径，如 `data.signature` 或 `result[0].sig` */
  signaturePath: string;
  /** 签名值的编码 */
  signatureEncoding: 'base64' | 'hex';
  publicKeyPath?: string;
  certificatePath?: string;
  certificateChainPath?: string;
  algorithmPath?: string;
}

export interface HttpSignConfig {
  endpoint: string;
  timeoutMs: number;
  keyId?: string;
  auth?: { headerName: string; scheme?: string };
  request: HttpRequestMapping;
  response: HttpResponseMapping;
}

export interface SignBackendConfig {
  /** 医院签名服务。未配置即不可签章（没有内置软件签名可回退）  */
  http?: HttpSignConfig;
  /** 期望公钥指纹（SM3(SPKI) 的小写十六进制）。正式签章前必须固定  */
  expectedFingerprint?: string;
  publicKeyBase64?: string;
}

/** 未配置（= 签章不可用）。这不是"默认用内置软件签名"，而是明确没有后端  */
export const DEFAULT_SIGN_CONFIG: SignBackendConfig = {};

export interface SignConfigInput {
  http?: Partial<Omit<HttpSignConfig, 'request' | 'response' | 'auth'>> & {
    endpoint?: string;
    request?: Partial<HttpRequestMapping>;
    response?: Partial<HttpResponseMapping>;
    auth?: { headerName?: string; scheme?: string };
  };
  expectedFingerprint?: string;
  publicKeyBase64?: string;
  apiKey?: string | null;
}

export type SignConfigErrorCode =
  | 'E_SIGN_CONFIG_INVALID'
  | 'E_SIGN_CONFIG_NO_ENDPOINT'
  | 'E_SIGN_CONFIG_BAD_FINGERPRINT'
  /** 没配签名服务就要求签章：明确拒绝，而不是退回内置密钥  */
  | 'E_SIGN_NOT_CONFIGURED';

export class SignConfigError extends Error {
  code: SignConfigErrorCode;

  constructor(code: SignConfigErrorCode, message: string) {
    super(message);
    this.name = 'SignConfigError';
    this.code = code;
  }
}

function requiredText(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new SignConfigError('E_SIGN_CONFIG_INVALID', `${name} 必须是非空字符串，实际 ${JSON.stringify(value)}`);
  }
  return value.trim();
}

function optionalText(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return requiredText(value, name);
}

function positiveInt(value: unknown, fallback: number, name: string): number {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new SignConfigError('E_SIGN_CONFIG_INVALID', `${name} 必须是正整数，实际 ${JSON.stringify(value)}（拒绝静默取默认值）`);
  }
  return number;
}

function encodingOf(value: unknown, fallback: 'base64' | 'hex', name: string): 'base64' | 'hex' {
  if (value === undefined || value === null || value === '') return fallback;
  if (value !== 'base64' && value !== 'hex') {
    throw new SignConfigError('E_SIGN_CONFIG_INVALID', `${name} 只能是 base64 或 hex，实际 ${JSON.stringify(value)}`);
  }
  return value;
}

/** 期望指纹必须是 64 位十六进制（SM3 输出） */
export function isFingerprint(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

export function missingSignConfig(config: SignBackendConfig): string[] {
  const missing: string[] = [];
  if (!config.http?.endpoint) missing.push('服务地址');
  if (!config.http?.request?.toSignField) missing.push('请求映射（待签字段）');
  if (!config.http?.response?.signaturePath) missing.push('响应映射（签名路径）');
  if (!config.publicKeyBase64) missing.push('签名方公钥（先点「测试签名」拿到指纹，再把公钥固定下来）');
  return missing;
}

export function isSignConfigured(config: SignBackendConfig): boolean {
  return missingSignConfig(config).length === 0;
}

export function validateSignConfig(input: SignConfigInput): SignBackendConfig {
  const config: SignBackendConfig = {};

  if (input.expectedFingerprint !== undefined && input.expectedFingerprint !== null && input.expectedFingerprint !== '') {
    const fingerprint = String(input.expectedFingerprint).trim().toLowerCase();
    if (!isFingerprint(fingerprint)) {
      throw new SignConfigError(
        'E_SIGN_CONFIG_BAD_FINGERPRINT',
        `expectedFingerprint 必须是 64 位十六进制（SM3 指纹），实际 ${JSON.stringify(input.expectedFingerprint)}`,
      );
    }
    config.expectedFingerprint = fingerprint;
  }

  if (input.publicKeyBase64 !== undefined && input.publicKeyBase64 !== null && input.publicKeyBase64 !== '') {
    const key = String(input.publicKeyBase64).trim();
    try {
      publicKeyFromSpki(fromBase64(key));
    } catch (err) {
      throw new SignConfigError('E_SIGN_CONFIG_INVALID', `publicKeyBase64 不是合法的 SM2 公钥（SPKI base64）：${(err as Error).message}`);
    }
    config.publicKeyBase64 = key;
  }

  const http = input.http;
  if (!http) return config;

  const endpoint = String(http.endpoint ?? '').trim();
  if (endpoint === '') {
    throw new SignConfigError(
      'E_SIGN_CONFIG_NO_ENDPOINT',
      '给了 http 段但服务地址为空：要么把地址填全，要么整段留空（留空 = 未配置，签章不可用）',
    );
  }

  const request: HttpRequestMapping = {
    toSignField: requiredText(http.request?.toSignField, 'http.request.toSignField'),
    toSignEncoding: encodingOf(http.request?.toSignEncoding, 'base64', 'http.request.toSignEncoding'),
  };
  const digestField = optionalText(http.request?.digestField, 'http.request.digestField');
  if (digestField) request.digestField = digestField;
  const algorithmField = optionalText(http.request?.algorithmField, 'http.request.algorithmField');
  if (algorithmField) request.algorithmField = algorithmField;
  const keyIdField = optionalText(http.request?.keyIdField, 'http.request.keyIdField');
  if (keyIdField) request.keyIdField = keyIdField;
  if (http.request?.extra !== undefined) {
    if (http.request.extra === null || typeof http.request.extra !== 'object' || Array.isArray(http.request.extra)) {
      throw new SignConfigError('E_SIGN_CONFIG_INVALID', 'http.request.extra 必须是"字段名 → 值"的对象');
    }
    const extra: Record<string, string> = {};
    for (const [key, value] of Object.entries(http.request.extra)) {
      if (key.trim() === '' || typeof value !== 'string') {
        throw new SignConfigError('E_SIGN_CONFIG_INVALID', `http.request.extra 的 "${key}" 必须是非空字段名与非字符串值`);
      }
      extra[key.trim()] = value;
    }
    if (Object.keys(extra).length > 0) request.extra = extra;
  }

  const response: HttpResponseMapping = {
    signaturePath: requiredText(http.response?.signaturePath, 'http.response.signaturePath'),
    signatureEncoding: encodingOf(http.response?.signatureEncoding, 'base64', 'http.response.signatureEncoding'),
  };
  for (const [key, name] of [
    ['publicKeyPath', 'http.response.publicKeyPath'],
    ['certificatePath', 'http.response.certificatePath'],
    ['certificateChainPath', 'http.response.certificateChainPath'],
    ['algorithmPath', 'http.response.algorithmPath'],
  ] as const) {
    const value = optionalText(http.response?.[key], name);
    if (value) response[key] = value;
  }

  const httpConfig: HttpSignConfig = {
    endpoint,
    timeoutMs: positiveInt(http.timeoutMs, 20_000, 'http.timeoutMs'),
    request,
    response,
  };
  const keyId = optionalText(http.keyId, 'http.keyId');
  if (keyId) httpConfig.keyId = keyId;
  if (http.auth !== undefined) {
    const headerName = requiredText(http.auth?.headerName, 'http.auth.headerName');
    const scheme = typeof http.auth?.scheme === 'string' ? http.auth.scheme : undefined;
    httpConfig.auth = { headerName, ...(scheme !== undefined ? { scheme } : {}) };
  }
  config.http = httpConfig;

  if (!config.publicKeyBase64 && !response.publicKeyPath) {
    throw new SignConfigError(
      'E_SIGN_CONFIG_INVALID',
      '既没有预置 publicKeyBase64，也没有配 http.response.publicKeyPath：' +
        '拿不到签名方公钥就无法构造待签内容（SignedInfo 里含公钥指纹）',
    );
  }

  return config;
}

/** 由 SPKI 求指纹（用于核对"签名方到底是谁"） */
export function fingerprintOfSpki(spki: Uint8Array): string {
  return publicKeyFingerprint(publicKeyFromSpki(spki));
}

export function publicKeyOfSpki(spki: Uint8Array): Sm2Point {
  return publicKeyFromSpki(spki);
}

export { SIGNATURE_ALGORITHM };
