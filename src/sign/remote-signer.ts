// 远程签名后端（`backend: 'http'`）：把"待签数据"交给医院的签名服务，拿回签名值。

import { publicKeyFingerprint, publicKeyFromSpki, type Sm2Point } from '../crypto/sm2.ts';
import { fromHex, sm3Hex, toHex, utf8 } from '../crypto/sm3.ts';
import { fromBase64, toBase64 } from '../crypto/signature.ts';
import { softwareVerifier, type Signer } from '../crypto/provider.ts';
import { SIGNATURE_ALGORITHM, SignConfigError, missingSignConfig, type HttpSignConfig, type SignBackendConfig } from './sign-config.ts';

export interface SignTransportRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
}

export interface SignTransportResponse {
  status: number;
  /** 响应体文本；只在内存里用于解析，不写日志、不进留痕、不放进错误信息  */
  body: string;
}

export type SignTransport = (request: SignTransportRequest) => Promise<SignTransportResponse>;

export type RemoteSignErrorCode =
  | 'E_SIGN_HTTP_STATUS'
  | 'E_SIGN_TIMEOUT'
  | 'E_SIGN_BAD_JSON'
  | 'E_SIGN_NO_SIGNATURE'
  | 'E_SIGN_NO_PUBLIC_KEY'
  | 'E_SIGN_BAD_ENCODING'
  | 'E_SIGN_FINGERPRINT_MISMATCH'
  | 'E_SIGN_VERIFY_FAILED';

export class RemoteSignError extends Error {
  code: RemoteSignErrorCode;
  /** HTTP 状态码（仅状态码，不含响应体） */
  status?: number;

  constructor(code: RemoteSignErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'RemoteSignError';
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

/** 测试签名用的固定文本：与病历无关，纯粹验证"服务能签、我们能验"  */
export const TEST_SIGN_MESSAGE = 'l0-sign-backend-probe/v1';

const defaultTransport: SignTransport = async (request) => {
  const response = await fetch(request.url, {
    method: 'POST',
    headers: request.headers,
    body: request.body,
    ...(request.signal ? { signal: request.signal } : {}),
  });
  return { status: response.status, body: await response.text() };
};

/** 读 JSON 路径：支持 `a.b` 与 `a[0].b`（够用即可，不引第三方库） */
export function readJsonPath(root: unknown, path: string): unknown {
  const tokens = path.replace(/\[(\d+)\]/g, '.$1').split('.').filter((token) => token !== '');
  let cursor: unknown = root;
  for (const token of tokens) {
    if (cursor === null || cursor === undefined) return undefined;
    if (Array.isArray(cursor)) {
      const index = Number(token);
      if (!Number.isInteger(index)) return undefined;
      cursor = cursor[index];
    } else if (typeof cursor === 'object') {
      cursor = (cursor as Record<string, unknown>)[token];
    } else {
      return undefined;
    }
  }
  return cursor;
}

export function writeJsonPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const tokens = path.replace(/\[(\d+)\]/g, '.$1').split('.').filter((token) => token !== '');
  if (tokens.length === 0) throw new RemoteSignError('E_SIGN_BAD_ENCODING', '请求字段路径为空');
  let cursor: Record<string, unknown> = target;
  for (let index = 0; index < tokens.length - 1; index += 1) {
    const token = tokens[index] as string;
    const next = cursor[token];
    if (next === undefined) {
      const created: Record<string, unknown> = {};
      cursor[token] = created;
      cursor = created;
      continue;
    }
    if (typeof next !== 'object' || next === null || Array.isArray(next)) {
      throw new RemoteSignError('E_SIGN_BAD_ENCODING', `请求字段路径 ${path} 与已存在字段冲突（${token} 不是对象）`);
    }
    cursor = next as Record<string, unknown>;
  }
  cursor[tokens[tokens.length - 1] as string] = value;
}

function encodeBytes(bytes: Uint8Array, encoding: 'base64' | 'hex'): string {
  return encoding === 'hex' ? toHex(bytes) : toBase64(bytes);
}

function decodeBytes(text: string, encoding: 'base64' | 'hex', what: string): Uint8Array {
  try {
    return encoding === 'hex' ? fromHex(text) : fromBase64(text);
  } catch (err) {
    throw new RemoteSignError('E_SIGN_BAD_ENCODING', `${what} 不是合法的 ${encoding} 数据：${(err as Error).message}`);
  }
}

/** 从模型输出里提取 JSON（容错提取：服务可能包一层 ```json 或加一句说明） */
function extractJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) {
      throw new RemoteSignError('E_SIGN_BAD_JSON', '签名服务输出里找不到 JSON 对象（响应体未记录）');
    }
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch (err) {
      throw new RemoteSignError('E_SIGN_BAD_JSON', `签名服务输出的 JSON 无法解析：${(err as Error).message}（响应体未记录）`);
    }
  }
}

export interface RemoteSignResult {
  signature: Uint8Array;
  /** 服务返回的公钥（SPKI base64），没有则为 undefined（此时用配置里预置的那把）  */
  publicKeyBase64?: string;
  certificates?: string[];
  algorithm: string;
  latencyMs: number;
}

export interface HttpSigner {
  readonly id: string;
  readonly provider: string;
  signMessage(toSign: Uint8Array, context?: { digestHex?: string; keyId?: string }): Promise<RemoteSignResult>;
}

export function createHttpSigner(
  config: HttpSignConfig,
  options: { transport?: SignTransport; fetchImpl?: typeof fetch; apiKey?: string } = {},
): HttpSigner {
  const transport = options.transport ?? (options.fetchImpl ? undefined : defaultTransport);
  /* 密钥只从参数来（由调用方从库里解出后递进来），不存进配置对象，也不进日志。
     不再从环境变量取：环境变量会顺着 docker inspect / 崩溃转储 / 子进程漏出去，且备份数据库带不走它。  */
  const apiKey = options.apiKey?.trim() || undefined;

  return {
    id: 'http-sign',
    provider: 'http',
    async signMessage(toSign: Uint8Array, context: { digestHex?: string; keyId?: string } = {}): Promise<RemoteSignResult> {
      const started = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.timeoutMs);

      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (config.auth && apiKey) headers[config.auth.headerName] = `${config.auth.scheme ?? ''}${apiKey}`;

      /* 字段名支持点路径（`data.content` → 嵌套对象）：真实签名服务的请求体几乎都是嵌套的，
         按扁平键名发过去，对方只会回一句"参数缺失"。  */
      const payload: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(config.request.extra ?? {})) writeJsonPath(payload, key, value);
      writeJsonPath(payload, config.request.toSignField, encodeBytes(toSign, config.request.toSignEncoding));
      if (config.request.digestField) writeJsonPath(payload, config.request.digestField, context.digestHex ?? sm3Hex(toSign));
      if (config.request.algorithmField) writeJsonPath(payload, config.request.algorithmField, SIGNATURE_ALGORITHM);
      const keyId = context.keyId ?? config.keyId;
      if (config.request.keyIdField && keyId) writeJsonPath(payload, config.request.keyIdField, keyId);
      const body = JSON.stringify(payload);

      /* 超时不能只靠 transport 自觉响应 abort：不理会 signal 的实现会让请求永远挂着，
         而"挂着的请求"在现场表现为"签名没反应"，排查方向会完全跑偏（同 ai/http-adapter.ts）。 */
      const timedOut = new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () =>
          reject(new RemoteSignError('E_SIGN_TIMEOUT', `签名服务调用超时（${config.timeoutMs}ms）已中止，未产生任何签名值`)),
        );
      });

      let response: SignTransportResponse;
      try {
        const doRequest: SignTransport =
          transport ??
          (async (req) => {
            const res = await (options.fetchImpl as typeof fetch)(req.url, {
              method: 'POST',
              headers: req.headers,
              body: req.body,
              ...(req.signal ? { signal: req.signal } : {}),
            });
            return { status: res.status, body: await res.text() };
          });
        response = await Promise.race([doRequest({ url: config.endpoint, headers, body }), timedOut]);
      } catch (err) {
        if (err instanceof RemoteSignError) throw err;
        if (controller.signal.aborted) {
          throw new RemoteSignError('E_SIGN_TIMEOUT', `签名服务调用超时（${config.timeoutMs}ms）已中止，未产生任何签名值`);
        }
        throw new RemoteSignError('E_SIGN_HTTP_STATUS', `签名服务调用失败：${(err as Error).message}（未产生任何签名值）`);
      } finally {
        clearTimeout(timer);
      }

      if (response.status < 200 || response.status >= 300) {
        throw new RemoteSignError(
          'E_SIGN_HTTP_STATUS',
          `签名服务返回 ${response.status}；响应体未记录（错误响应常回显请求内容）`,
          response.status,
        );
      }

      const parsed = extractJson(response.body);
      const rawSignature = readJsonPath(parsed, config.response.signaturePath);
      if (typeof rawSignature !== 'string' || rawSignature.trim() === '') {
        throw new RemoteSignError(
          'E_SIGN_NO_SIGNATURE',
          `签名服务输出里取不到签名值（路径 ${config.response.signaturePath}）：不把"没有产出"当成"签好了"`,
        );
      }

      const result: RemoteSignResult = {
        signature: decodeBytes(rawSignature.trim(), config.response.signatureEncoding, '签名值'),
        algorithm: SIGNATURE_ALGORITHM,
        latencyMs: Date.now() - started,
      };
      if (config.response.algorithmPath) {
        const algorithm = readJsonPath(parsed, config.response.algorithmPath);
        if (typeof algorithm === 'string' && algorithm.trim() !== '') result.algorithm = algorithm.trim();
      }
      if (config.response.publicKeyPath) {
        const publicKey = readJsonPath(parsed, config.response.publicKeyPath);
        if (typeof publicKey === 'string' && publicKey.trim() !== '') result.publicKeyBase64 = publicKey.trim();
      }
      const certificates: string[] = [];
      if (config.response.certificatePath) {
        const single = readJsonPath(parsed, config.response.certificatePath);
        if (typeof single === 'string' && single.trim() !== '') certificates.push(single.trim());
      }
      if (config.response.certificateChainPath) {
        const chain = readJsonPath(parsed, config.response.certificateChainPath);
        if (Array.isArray(chain)) {
          for (const item of chain) if (typeof item === 'string' && item.trim() !== '') certificates.push(item.trim());
        } else if (typeof chain === 'string' && chain.trim() !== '') {
          certificates.push(chain.trim());
        }
      }
      if (certificates.length > 0) result.certificates = certificates;
      return result;
    },
  };
}

export function createRemoteSigner(
  config: SignBackendConfig,
  options: { transport?: SignTransport; fetchImpl?: typeof fetch; apiKey?: string } = {},
): Signer {
  const http = config.http;
  const publicKeyBase64 = config.publicKeyBase64;
  const missing = missingSignConfig(config);
  if (!http || !publicKeyBase64 || missing.length > 0) {
    throw new SignConfigError(
      'E_SIGN_NOT_CONFIGURED',
      `未配置签名服务，无法签章（本系统没有"内置软件签名"可回退）：还缺 ${missing.join('、')}`,
    );
  }

  const publicKeyDer = fromBase64(publicKeyBase64);
  let publicKey: Sm2Point;
  try {
    publicKey = publicKeyFromSpki(publicKeyDer);
  } catch (err) {
    throw new SignConfigError('E_SIGN_CONFIG_INVALID', `预置公钥不是合法的 SM2 公钥（SPKI base64）：${(err as Error).message}`);
  }
  const fingerprint = publicKeyFingerprint(publicKey);
  if (config.expectedFingerprint && config.expectedFingerprint !== fingerprint) {
    throw new SignConfigError(
      'E_SIGN_CONFIG_BAD_FINGERPRINT',
      `预置公钥指纹（${fingerprint}）与期望指纹（${config.expectedFingerprint}）不一致：配置自相矛盾，先纠正再签章`,
    );
  }

  const client = createHttpSigner(http, options);
  return {
    algorithm: SIGNATURE_ALGORITHM,
    provider: 'http',
    publicKey,
    publicKeyDer,
    fingerprint,
    async sign(message: Uint8Array): Promise<Uint8Array> {
      const result = await client.signMessage(message, http.keyId ? { keyId: http.keyId } : {});
      if (result.publicKeyBase64) {
        let remoteFingerprint: string;
        try {
          remoteFingerprint = publicKeyFingerprint(publicKeyFromSpki(fromBase64(result.publicKeyBase64.trim())));
        } catch (err) {
          throw new RemoteSignError('E_SIGN_NO_PUBLIC_KEY', `签名服务返回的公钥无法解析为 SM2 SPKI：${(err as Error).message}`);
        }
        if (remoteFingerprint !== fingerprint) {
          throw new RemoteSignError(
            'E_SIGN_FINGERPRINT_MISMATCH',
            `签名服务返回的公钥指纹（${remoteFingerprint}）与预置公钥（${fingerprint}）不一致：拒绝采纳这次签名值（服务换了把钥匙，或连错了环境）`,
          );
        }
      }
      return result.signature;
    },
  };
}

export interface TestSignReport {
  ok: true;
  provider: string;
  algorithm: string;
  latencyMs: number;
  signatureBytes: number;
  /** 实际用到的公钥指纹（拿不到公钥时为 null） */
  actualFingerprint: string | null;
  /** 配置里固定的期望指纹 */
  expectedFingerprint: string | null;
  /** null = 尚未固定指纹（首次登记时允许，但正式签章前必须固定）  */
  fingerprintMatches: boolean | null;
  /** 自验结论：用拿到的公钥验这条签名。null = 没有公钥，无法自验 */
  selfVerified: boolean | null;
  certificateCount: number;
  notes: string[];
}

/**
 * 测试签名：签一段与病历无关的文本，并尽量做完这几件事 ——
 *   - 服务能不能签（连通性与字段映射对不对）
 *   - 拿回来的公钥指纹是多少（供管理员固定下来）
 *   - 用自己的验签器验一遍：证明"这把钥确实能验这条签名"
 *
 * 最后一条最重要：只报"服务返回 200"没有任何意义 —— 那证明不了签名值可用。
  */
export async function testSign(
  config: SignBackendConfig,
  options: { transport?: SignTransport; fetchImpl?: typeof fetch; apiKey?: string } = {},
): Promise<TestSignReport> {
  if (!config.http) {
    throw new SignConfigError('E_SIGN_NOT_CONFIGURED', '测试签名需要先填服务地址与字段映射（本系统没有"内置软件签名"可测）');
  }
  const signer = createHttpSigner(config.http, options);
  const message = utf8(TEST_SIGN_MESSAGE);
  const result = await signer.signMessage(message, { digestHex: sm3Hex(message) });

  const notes: string[] = [];
  const publicKeyBase64 = config.publicKeyBase64 ?? result.publicKeyBase64 ?? null;
  let actualFingerprint: string | null = null;
  let selfVerified: boolean | null = null;

  if (publicKeyBase64) {
    try {
      const publicKey = publicKeyFromSpki(fromBase64(publicKeyBase64));
      actualFingerprint = publicKeyFingerprint(publicKey);
      selfVerified = softwareVerifier(publicKey).verify(message, result.signature);
      if (selfVerified !== true) {
        notes.push('签名值未能用该公钥验过：可能是算法不是标准 SM2，或返回的公钥与签名私钥不是一对');
      }
    } catch (err) {
      notes.push(`公钥无法解析为 SM2 SPKI：${(err as Error).message}`);
    }
  } else {
    notes.push('签名服务没有返回公钥，且配置里也没有预置 publicKeyBase64：无法核对身份，也无法自验');
  }

  const expectedFingerprint = config.expectedFingerprint ?? null;
  const fingerprintMatches = expectedFingerprint === null ? null : actualFingerprint === expectedFingerprint;
  if (fingerprintMatches === false) {
    notes.push(`公钥指纹与配置不一致：实际 ${actualFingerprint}，期望 ${expectedFingerprint}`);
  } else if (fingerprintMatches === null && actualFingerprint) {
    notes.push(`指纹尚未固定：请把 ${actualFingerprint} 填入"期望指纹"并保存，之后每次签名都会核对`);
  }

  return {
    ok: true,
    provider: 'http',
    algorithm: result.algorithm,
    latencyMs: result.latencyMs,
    signatureBytes: result.signature.length,
    actualFingerprint,
    expectedFingerprint,
    fingerprintMatches,
    selfVerified,
    certificateCount: result.certificates?.length ?? 0,
    notes,
  };
}
