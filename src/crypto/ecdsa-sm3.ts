/**
 * ECDSA-SM3 交叉验证桥 —— **不是产品签名算法**，只为建立一条能与 OpenSSL 对上的通道。
 *
 * 为什么需要它（这是实测结论，不是推测）：
 *   Node 的 `crypto.sign('sm3', data, ecKeyOnSm2Curve)` 产出的是
 *   **SM3 摘要 + sm2p256v1 曲线 + ECDSA 签名方程**的签名，**不是** GB/T 32918 的 SM2 签名。
 *   证据（可复现）：同一个签名，用本文件的 ECDSA 验签器能验通，
 *   用 SM2 验签器验不通 —— 也就是说 Node 暴露的 API 里**没有 SM2 签名算法**
 *   （OpenSSL 的 EVP_PKEY_SM2 路径未被 Node 暴露）。
 *
 * 这带来一个必须正视的问题：**自研 SM2 无法用 OpenSSL 做交叉验证**。
 * 于是正确性只能靠三重证据合成：
 *   ① **SM3 与 OpenSSL 逐字节比对**（同算法交叉，覆盖填充与压缩）；
 *   ② **本桥的 ECDSA-SM3 与 OpenSSL 双向签验**（覆盖曲线参数、点运算、模逆、DER、SPKI ——
 *      这些是"自研实现最容易错"且"SM2 与 ECDSA 完全共用"的部分）；
 *   ③ **GB/T 32918 示例向量**锁死 SM2 签名方程本身（r/s 与标准示例逐字节一致）。
 *
 * 单靠任何一条都不够：①不碰点运算；②不碰 SM2 的 (1+d)⁻¹ 与 e+x₁；③只有一条固定向量。
 * 三条同时成立，才敢说"自研国密实现是对的"。
 */

import { sm3, toHex, utf8 } from './sm3.ts';
import {
  SM2_GX,
  SM2_GY,
  SM2_N,
  concatBytes,
  intToBytes32,
  inverseOf,
  modOf,
  pointAdd,
  randomScalar,
  scalarMultiply,
  type Sm2Point,
  type Sm2Signature,
} from './sm2.ts';

/** 交叉验证专用算法标识（**不得**写进产品签名元数据，否则等于谎报算法） */
export const ECDSA_CROSS_ALGORITHM = 'ECDSA-SM3';

const BASE: Sm2Point = { x: SM2_GX, y: SM2_GY };

/** 与 SM2 侧同思路的确定性 k（保证交叉验证与产物比对都能复现） */
function ecdsaDeterministicK(privateKey: bigint, e: bigint, attempt: number): bigint {
  const seed = new Uint8Array(32 * 3);
  const d = intToBytes32(privateKey);
  const ev = intToBytes32(e);
  const counter = intToBytes32(BigInt(attempt));
  seed.set(d, 0);
  seed.set(ev, 32);
  seed.set(counter, 64);
  const digest = sm3(concatBytes([utf8('ECDSA-SM3-DETERMINISTIC-K/V1'), seed]));
  return (BigInt(`0x${toHex(digest)}`) % (SM2_N - 1n)) + 1n;
}

/** ECDSA-SM3 签名（DER 由调用方编码，与 OpenSSL 输出格式一致；k 默认确定性派生以便产物可复现） */
export function ecdsaSm3Sign(message: Uint8Array, privateKey: bigint, options: { k?: bigint; deterministic?: boolean } = {}): Sm2Signature {
  const e = BigInt(`0x${toHex(sm3(message))}`);
  const d = modOf(privateKey, SM2_N);
  const deterministic = options.deterministic ?? true;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const k = options.k ?? (deterministic ? ecdsaDeterministicK(d, e, attempt) : randomScalar());
    const point = scalarMultiply(k, BASE);
    if (!point) continue;
    const r = modOf(point.x, SM2_N);
    if (r === 0n) continue;
    const s = modOf(inverseOf(k, SM2_N) * (e + r * d), SM2_N);
    if (s === 0n) continue;
    return { r, s };
  }
  throw new Error('ECDSA 交叉验证：签名失败（连续 100 次随机 k 均不满足条件）');
}

export function ecdsaSm3Verify(message: Uint8Array, publicKey: Sm2Point, signature: Sm2Signature): boolean {
  const { r, s } = signature;
  if (r <= 0n || r >= SM2_N || s <= 0n || s >= SM2_N) return false;
  const e = BigInt(`0x${toHex(sm3(message))}`);
  const w = inverseOf(s, SM2_N);
  const point = pointAdd(scalarMultiply(modOf(e * w, SM2_N), BASE), scalarMultiply(modOf(r * w, SM2_N), publicKey));
  return point !== null && modOf(point.x, SM2_N) === r;
}
