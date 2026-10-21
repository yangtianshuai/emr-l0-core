import { createHash } from 'node:crypto';
import { decryptEnvelope, encryptEnvelope, type Envelope } from '../crypto/envelope.ts';
import { resolveStateSalt } from '../core/store.ts';

function digestOf(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export interface SealedContent {
  digest: string;
  sealed: string;
}

export interface SealedPayload extends SealedContent {
  format: string;
}

export interface SealOptions {
  salt?: string;
  iterations?: number;
}

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
