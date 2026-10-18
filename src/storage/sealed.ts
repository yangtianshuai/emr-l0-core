// 密封载荷：把任意 JSON 加密后存进数据库列。

import { createHash } from 'node:crypto';
import { decryptEnvelope, encryptEnvelope, type Envelope } from '../crypto/envelope.ts';
import { resolveStateSalt } from '../core/store.ts';

/** 与 `core/persistence.ts` 同一口径（SHA-256 十六进制）：它只能发现损坏，防不住有意篡改  */
function digestOf(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export interface SealedContent {
  digest: string;
  /** 信封的 JSON 文本（直接进数据库列） */
  sealed: string;
}

export interface SealedPayload extends SealedContent {
  format: string;
}

export interface SealOptions {
  /** 显式盐（32 位 hex）；一般不用，轮换靠环境变量 `L0_STATE_SALT` */
  salt?: string;
  /** 测试与复现专用：显式指定派生迭代数（理由同 `core/store.ts` 的 `saveSealedPayload`） */
  iterations?: number;
}

/** 加密一段 JSON。口令为空直接拒绝：绝不退回明文（同 `core/store.ts`）  */
export function sealValue(value: unknown, passphrase: string, options: SealOptions = {}): SealedContent {
  if (!passphrase) throw new Error('拒绝以明文写入数据库：必须提供口令（生产从密钥管理注入）');
  const text = JSON.stringify(value);
  const { salt } = resolveStateSalt(passphrase, options.salt);
  const envelope = encryptEnvelope(new TextEncoder().encode(text), {
    passphrase,
    salt,
    ...(options.iterations === undefined ? {} : { iterations: options.iterations }),
  });
  const sealed = JSON.stringify(envelope);
  return { digest: digestOf(sealed), sealed };
}

export type UnsealResult<T> = { ok: true; data: T } | { ok: false; code: string; message: string };

/**
 * 解密并解析。任何失败都显式返回错误码，绝不返回"空数据" ——
 * 把"解不开"当成"没有"是数据丢失最容易被伪装成正常的方式（同 `core/store.ts`）。
  */
export function unsealValue<T>(payload: SealedContent, passphrase: string): UnsealResult<T> {
  if (!passphrase) return { ok: false, code: 'E_SEALED_NO_PASSPHRASE', message: '缺少口令：无法解密（不会退回按明文读取）' };
  let envelope: Envelope;
  try {
    envelope = JSON.parse(payload.sealed) as Envelope;
  } catch (err) {
    return { ok: false, code: 'E_SEALED_MALFORMED', message: `信封不是合法 JSON：${(err as Error).message}` };
  }
  const decrypted = decryptEnvelope(envelope, passphrase);
  if (!decrypted.ok) {
    return {
      ok: false,
      code: 'E_SEALED_DECRYPT_FAILED',
      message: `解密失败（${String((decrypted as { code?: string }).code ?? '未知原因')}）：口令错误或内容被改动`,
    };
  }
  const text = new TextDecoder().decode(decrypted.plaintext);
  /* 摘要与密文自洽：两列被分别改动过（只改密文、或只改摘要）时能发现。
     防篡改本身靠信封的 MAC（上面那一步已经验过），这里只查"两列是否还配得上"。  */
  if (payload.digest !== '' && digestOf(payload.sealed) !== payload.digest) {
    return { ok: false, code: 'E_SEALED_DIGEST_MISMATCH', message: '摘要列与密文列不一致（这两列被分别改动过）' };
  }
  try {
    return { ok: true, data: JSON.parse(text) as T };
  } catch {
    return { ok: false, code: 'E_SEALED_BAD_JSON', message: '解密后的内容不是合法 JSON' };
  }
}

export function sealFor<T>(format: string, value: T, passphrase: string, options: SealOptions = {}): SealedPayload {
  return { ...sealValue(value, passphrase, options), format };
}
