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

/** 交叉验证专用算法标识（不得写进产品签名元数据，否则等于谎报算法）  */
export const ECDSA_CROSS_ALGORITHM = 'ECDSA-SM3';

const BASE: Sm2Point = { x: SM2_GX, y: SM2_GY };

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
