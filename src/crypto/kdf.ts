/**
 * 密钥派生：HMAC-SM3、PBKDF2-HMAC-SM3、以及 GB/T 32918.4 的 KDF。
 *
 * 用途分工：
 *   - **HMAC-SM3** 给认证加密做完整性（Encrypt-then-MAC，见 envelope.ts）；
 *   - **PBKDF2-HMAC-SM3** 把口令变成密钥（口令熵低，必须慢化）；
 *   - **SM3-KDF** 给 SM2 公钥加密生成密钥流（GB/T 32918.4 定义的那个计数器式 KDF）。
 *
 * ⚠️ 诚实边界：**PBKDF2-HMAC-SM3 没有公开的标准测试向量**（RFC 6070 只给了 HMAC-SHA1/SHA256）。
 *    因此这里不假装"通过标准向量"，改为验证三类可证伪的性质：
 *      ① 与运行时 OpenSSL 的 `createHmac('sm3')` 逐字节一致（HMAC 部分）；
 *      ② 确定性 + salt/迭代次数/长度各自的影响（改一个参数结果必变）；
 *      ③ 长度语义正确（前 N 字节与前一次派生的前 N 字节一致）。
 *    这些性质能抓住"参数没接进去""长度算错""常量搞反"这类真错误，但不能证明与某个第三方实现完全一致 —— 后者需要向量。
 */

import { createHmac } from 'node:crypto';
import { sm3, utf8 } from './sm3.ts';

/** HMAC-SM3（块长 64 字节，输出 32 字节）。走运行时 OpenSSL：与 SM3 同源，避免自写填充细节 */
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

/**
 * PBKDF2-HMAC-SM3（RFC 8018 的 PBKDF2，PRF 换成 HMAC-SM3）。
 *
 * 迭代次数不是"随便写个常数"：它决定离线暴力破解的成本。
 * 本仓库默认 `DEFAULT_PBKDF2_ITERATIONS`，测试里可以用小值（否则每个用例都要几百毫秒）。
 */
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

/**
 * SM3-KDF（GB/T 32918.4）：`Ha_i = SM3(Z ‖ ct)`，ct 为 32 位大端计数器，从 1 开始，取前 klen 字节。
 * 标准要求：若派生结果**全为 0** 则必须报错（说明共享秘密异常），不能"凑合用"。
 */
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
