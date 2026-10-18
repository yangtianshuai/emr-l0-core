// 密钥派生：HMAC-SM3、PBKDF2-HMAC-SM3、以及 GB/T 32918.4 的 KDF。
// - PBKDF2-HMAC-SM3 把口令变成密钥（口令熵低，必须慢化）；

import { createHmac } from 'node:crypto';
import { sm3, utf8 } from './sm3.ts';

export function hmacSm3(key: Uint8Array, data: Uint8Array): Uint8Array {
  const hmac = createHmac('sm3', key);
  hmac.update(data);
  return new Uint8Array(hmac.digest());
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function int32be(value: number): Uint8Array {
  return new Uint8Array([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

export const DEFAULT_PBKDF2_ITERATIONS = 200_000;

export function pbkdf2HmacSm3(
  passphrase: Uint8Array,
  salt: Uint8Array,
  iterations: number,
  length = 32,
): Uint8Array {
  if (!Number.isInteger(iterations) || iterations < 1) {
    throw new Error(`PBKDF2 迭代次数必须为正整数，实际 ${iterations}`);
  }
  if (!Number.isInteger(length) || length < 1) throw new Error(`PBKDF2 输出长度必须为正整数，实际 ${length}`);

  const hLen = 32;
  const blocks = Math.ceil(length / hLen);
  const out = new Uint8Array(blocks * hLen);
  for (let i = 1; i <= blocks; i += 1) {
    let u = hmacSm3(passphrase, concatBytes(salt, int32be(i)));
    const accumulated = new Uint8Array(u);
    for (let round = 1; round < iterations; round += 1) {
      u = hmacSm3(passphrase, u);
      for (let j = 0; j < hLen; j += 1) accumulated[j]! ^= u[j]!;
    }
    out.set(accumulated, (i - 1) * hLen);
  }
  return out.subarray(0, length);
}

export function sm3Kdf(z: Uint8Array, klen: number): Uint8Array {
  if (!Number.isInteger(klen) || klen < 1) throw new Error(`KDF 输出长度必须为正整数，实际 ${klen}`);
  const blocks = Math.ceil(klen / 32);
  const chunks: Uint8Array[] = [];
  for (let i = 1; i <= blocks; i += 1) {
    chunks.push(sm3(concatBytes(z, int32be(i))));
  }
  const out = concatBytes(...chunks).subarray(0, klen);
  if (out.every((byte) => byte === 0)) {
    throw new Error('SM3-KDF 派生结果全为 0（共享秘密异常），按标准必须终止而不使用该密钥');
  }
  return out;
}

/** 短语口令 → 字节：统一 utf8，避免各调用点各写一套编码 */
export function passphraseBytes(passphrase: string): Uint8Array {
  const bytes = utf8(passphrase);
  if (bytes.length === 0) throw new Error('口令不能为空');
  return bytes;
}
