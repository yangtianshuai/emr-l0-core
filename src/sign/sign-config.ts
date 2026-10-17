/**
 * 电子签名后端配置（**声明式**）。
 *
 * ## 本系统唯一的签名后端，是"医院的签名服务"
 *
 * 这里**没有**"内置软件签名"这一档。内核当然有软件实现（`softwareSigner`，自测与交叉验证要用），
 * 但它**不出现在产品配置里**：一个"用内置密钥签"的选项，迟早会被当成生产可选项打开 ——
 * 那时界面显示"签章成功"，签的却是可被任何人推导的演示私钥。
 * 与受控阅读"本系统不签发授权"同一处置：**不是没权限，是没有那把钥匙**。
 *
 * 于是"未配置"是一种**正常且明确**的状态（`E_SIGN_NOT_CONFIGURED`）：受控签章不可用，
 * 而不是悄悄用别的东西顶上。
 *
 * ## 为什么是"声明式映射"而不是"给每家写一个适配器"
 *
 * 医院的签名服务各不相同，但**形态高度相似**：发一段待签数据过去，拿回签名值与公钥/证书。
 * 差异集中在三处 —— 字段叫什么、数据怎么编码、认证怎么带。把这三处做成配置，
 * 换医院就只需**填表**，不必改代码、更不必为每家医院出一版程序。
 *
 * ## 三条红线（与"用谁家的服务"无关）
 *
 * 1) **fail-closed**：没配地址 / 连不上 / 没拿到签名值 → 报错，**绝不回退软件签名**。
 *    回退的现场表现是"界面显示签名成功，其实是内置演示密钥"，这是最危险的一种"看起来能用"。
 * 2) **密钥不在配置里，在库里单独一行**（`config.sign.apiKey`，加密落库、永不回显）。这里只声明
 *    "认证头叫什么、前缀是什么"；密钥值由 `sign-config-store.ts` 单独存取（同 `ai/model-config-store.ts`
 *    与 `dictation/capture-store.ts` 的口径）。
 *
 *    **为什么不再用环境变量**：环境变量会顺着 `docker inspect`、崩溃转储、子进程的环境快照漏出去，
 *    而它又**不在数据库里** —— 备份一次数据库带不走密钥，换台机器就得在每台机器上重新配一遍
 *    （现场表现为"备份恢复后签名突然 401，且无从查起"）。落库则跟着备份一起走，且加密后
 *    即使那台机器的磁盘被拿走也读不出来。
 * 3) **指纹要固定**：拿到公钥后与配置里的期望指纹核对，不符即拒绝 ——
 *    防"连到测试环境""换了把钥"这类**静默**生效的错误。
 *
 * 签章链路已在 `src/core/session.ts` 接通（文档签章与 OFD 容器签名**同一个后端**），
 * 由 `createRemoteSigner()`（`src/sign/remote-signer.ts`）把配置变成内核可用的 `Signer`。
 */

import type { Sm2Point } from '../crypto/sm2.ts';
import { publicKeyFingerprint, publicKeyFromSpki } from '../crypto/sm2.ts';
import { fromBase64 } from '../crypto/signature.ts';
import { SIGNATURE_ALGORITHM } from '../crypto/provider.ts';

/** 请求怎么拼（字段名、编码、固定附加字段） */
export interface HttpRequestMapping {
  /** 承载"待签数据"的字段名 */
  toSignField: string;
  /** 待签数据的编码 */
  toSignEncoding: 'base64' | 'hex';
  /** 可选：同时给出 SM3 摘要（有些服务只收摘要） */
  digestField?: string;
  /** 可选：算法标识字段名 */
  algorithmField?: string;
  /** 可选：密钥/印章标识字段名 */
  keyIdField?: string;
  /** 固定附加字段（如 appId），值直接写在配置里（**不放密钥**） */
  extra?: Record<string, string>;
}

/** 响应怎么取（字段路径、编码） */
export interface HttpResponseMapping {
  /** 签名值的 JSON 路径，如 `data.signature` 或 `result[0].sig` */
  signaturePath: string;
  /** 签名值的编码 */
  signatureEncoding: 'base64' | 'hex';
  /** 可选：公钥（SPKI base64）路径。**本轮不支持从证书里提取公钥**（国密证书封装差异大，等真实样例） */
  publicKeyPath?: string;
  /** 可选：证书（DER base64）路径，仅作附带信息保存 */
  certificatePath?: string;
  /** 可选：证书链（DER base64 数组）路径 */
  certificateChainPath?: string;
  /** 可选：算法标识路径 */
  algorithmPath?: string;
}

export interface HttpSignConfig {
  endpoint: string;
  timeoutMs: number;
  /** 多证书/多印章场景的标识 */
  keyId?: string;
  /**
   * 认证：header 名 + 前缀。**这里没有密钥**（也没有"密钥变量名"）——
   * 密钥单独加密存在库里（`config.sign.apiKey`），永不回显，见本文件头第 2 条红线。
   * 没配 auth 说明这个服务不需要认证（院内服务常见）。
   */
  auth?: { headerName: string; scheme?: string };
  request: HttpRequestMapping;
  response: HttpResponseMapping;
}

export interface SignBackendConfig {
  /** 医院签名服务。**未配置即不可签章**（没有内置软件签名可回退） */
  http?: HttpSignConfig;
  /** 期望公钥指纹（SM3(SPKI) 的小写十六进制）。**正式签章前必须固定** */
  expectedFingerprint?: string;
  /**
   * 预置身份：签名方公钥（SPKI base64）。
   *
   * 它**不是可选项**而是签章的前提：内核要在**拿到签名之前**构造 SignedInfo，
   * 而 SignedInfo 里含公钥指纹 —— 没有预置公钥就没有指纹，也就无从构造。
   * 与"用谁家的服务"无关，这是"待签内容是什么"决定的。
   */
  publicKeyBase64?: string;
}

/** 未配置（= 签章不可用）。这不是"默认用内置软件签名"，而是**明确没有后端** */
export const DEFAULT_SIGN_CONFIG: SignBackendConfig = {};

/**
 * 界面 / 调用方提交的配置：**各字段都可省**，省的走默认。
 *
 * 与 `SignBackendConfig` 分开，是为了如实表达"表单只填了一部分"——
 * 尤其 `http.request` / `http.response` 的映射项，界面允许只填关心的那几项。
 * 什么都不给 = **清空配置**（签章随之不可用，这是明确行为而非事故）。
 */
export interface SignConfigInput {
  http?: Partial<Omit<HttpSignConfig, 'request' | 'response' | 'auth'>> & {
    endpoint?: string;
    request?: Partial<HttpRequestMapping>;
    response?: Partial<HttpResponseMapping>;
    auth?: { headerName?: string; scheme?: string };
  };
  expectedFingerprint?: string;
  publicKeyBase64?: string;
  /**
   * 认证密钥本身（**不是** SignBackendConfig 的一部分，它只在内存里过一次、加密落库）。
   *
   * 三种状态与 `ai/model-config-store.ts` / `dictation/capture-store.ts` 完全同口径：
   * `undefined` 不改（界面没动它）/ `null` 清除（显式点了"清除密钥"）/ 字符串 设新值。
   * 把 `undefined` 当成"清空"，会让管理员只改个地址就把密钥弄丢，而现场表现是"签名突然 401"。
   */
  apiKey?: string | null;
}

export type SignConfigErrorCode =
  | 'E_SIGN_CONFIG_INVALID'
  | 'E_SIGN_CONFIG_NO_ENDPOINT'
  | 'E_SIGN_CONFIG_BAD_FINGERPRINT'
  /** 没配签名服务就要求签章：**明确拒绝**，而不是退回内置密钥 */
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
  /* 非法值一律报错，不静默取默认 —— 那会让"我配的超时生效了"变成假话 */
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

/**
 * 还缺哪些才**能签章**。
 *
 * 单独返回"缺什么"，而不是只说一句"没配好"：现场最常见的卡点就是
 * "地址填了、映射填了，就是签不了"（缺预置公钥），而这句提示能直接指出下一步做什么。
 */
export function missingSignConfig(config: SignBackendConfig): string[] {
  const missing: string[] = [];
  if (!config.http?.endpoint) missing.push('服务地址');
  if (!config.http?.request?.toSignField) missing.push('请求映射（待签字段）');
  if (!config.http?.response?.signaturePath) missing.push('响应映射（签名路径）');
  if (!config.publicKeyBase64) missing.push('签名方公钥（先点「测试签名」拿到指纹，再把公钥固定下来）');
  return missing;
}

/** 配置是否**足以签章**（不是"配过没有"：只填了地址也不算） */
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
    /* 立刻试解析：配一把解不开的钥匙，要在**保存时**就报错，而不是等到签章那一刻 */
    try {
      publicKeyFromSpki(fromBase64(key));
    } catch (err) {
      throw new SignConfigError('E_SIGN_CONFIG_INVALID', `publicKeyBase64 不是合法的 SM2 公钥（SPKI base64）：${(err as Error).message}`);
    }
    config.publicKeyBase64 = key;
  }

  /* 没给 http 段 = 未配置服务（或显式清空）——那是合法状态，签章会被明确拒绝 */
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
    /* 认证段只留"头叫什么、前缀是什么"：密钥值另有去处（库里单独一行），不在这里解析 */
    httpConfig.auth = { headerName, ...(scheme !== undefined ? { scheme } : {}) };
  }
  config.http = httpConfig;

  /* 配了服务却既没有预置公钥、也没有响应公钥路径：拿不到身份就没法构造 SignedInfo —— 保存时就拦住 */
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
