// SM2 椭圆曲线公钥密码算法（GB/T 32918）—— 自研纯 TS 实现，零依赖。
// 定位与 SM3 相同：原型与交叉验证用，未经第三方审计，不得直接用于生产签名。
// 生产必须换成经认证的密码模块（商用密码产品 / HSM / UKey）。

import { fromHex, sm3, toHex, utf8 } from './sm3.ts';

export const SM2_P = BigInt('0xfffffffeffffffffffffffffffffffffffffffff00000000ffffffffffffffff');
export const SM2_A = BigInt('0xfffffffeffffffffffffffffffffffffffffffff00000000fffffffffffffffc');
export const SM2_B = BigInt('0x28e9fa9e9d9f5e344d5a9e4bcf6509a7f39789f515ab8f92ddbcbd414d940e93');
export const SM2_N = BigInt('0xfffffffeffffffffffffffffffffffff7203df6b21c6052b53bbf40939d54123');
export const SM2_GX = BigInt('0x32c4ae2c1f1981195f9904466a39c9948fe30bbff2660be1715a4589334c74c7');
export const SM2_GY = BigInt('0xbc3736a2f4f6779c59bdcee36b692153d0a9877cc62a474002df32e52139f0a0');

/** OpenSSL 的 SM2 默认签名者标识（GB/T 32918 推荐值），不实现它就与 OpenSSL 不兼容 */
export const SM2_DEFAULT_ID = '1234567812345678';

export interface Sm2Point {
  x: bigint;
  y: bigint;
}

export interface Sm2Signature {
  r: bigint;
  s: bigint;
}

/** 无穷远点用 null 表示（仿射坐标无法表示） */
type MaybePoint = Sm2Point | null;

const BASE: Sm2Point = { x: SM2_GX, y: SM2_GY };

function mod(value: bigint, m: bigint): bigint {
  const r = value % m;
  return r < 0n ? r + m : r;
}

/** 模逆（扩展欧几里得），零依赖且对 256 位足够快 */
function invMod(value: bigint, m: bigint): bigint {
  let oldR = mod(value, m);
  let r = m;
  let oldS = 1n;
  let s = 0n;
  while (r !== 0n) {
    const q = oldR / r;
    [oldR, r] = [r, oldR - q * r];
    [oldS, s] = [s, oldS - q * s];
  }
  if (oldR !== 1n) throw new Error('SM2：元素不可逆（参数或输入非法）');
  return mod(oldS, m);
}

function addPoints(p1: MaybePoint, p2: MaybePoint): MaybePoint {
  if (!p1) return p2;
  if (!p2) return p1;
  if (p1.x === p2.x) {
    if (mod(p1.y + p2.y, SM2_P) === 0n) return null; // 互为逆元 → 无穷远
    const lambda = mod(3n * p1.x * p1.x + SM2_A, SM2_P) * invMod(2n * p1.y, SM2_P) % SM2_P;
    const x = mod(lambda * lambda - 2n * p1.x, SM2_P);
    return { x, y: mod(lambda * (p1.x - x) - p1.y, SM2_P) };
  }
  const lambda = mod(p2.y - p1.y, SM2_P) * invMod(mod(p2.x - p1.x, SM2_P), SM2_P) % SM2_P;
  const x = mod(lambda * lambda - p1.x - p2.x, SM2_P);
  return { x, y: mod(lambda * (p1.x - x) - p1.y, SM2_P) };
}

function multiply(k: bigint, point: Sm2Point): MaybePoint {
  let result: MaybePoint = null;
  let addend: MaybePoint = point;
  let scalar = k;
  while (scalar > 0n) {
    if (scalar & 1n) result = addPoints(result, addend);
    addend = addPoints(addend, addend);
    scalar >>= 1n;
  }
  return result;
}

export function isOnCurve(point: Sm2Point): boolean {
  return mod(point.y * point.y, SM2_P) === mod(point.x * point.x * point.x + SM2_A * point.x + SM2_B, SM2_P);
}

/** 随机标量（拒绝采样）。导出给 ECDSA 交叉验证桥复用，不重复实现随机源处理 */
function randomScalar(): bigint {
  const source = (globalThis as unknown as { crypto?: { getRandomValues(array: Uint8Array): Uint8Array } }).crypto;
  if (!source) throw new Error('SM2：当前环境没有安全随机源（crypto.getRandomValues 不可用）');
  /* 拒绝采样：直接取模会带来极小的偏向，密码学实现里不接受"极小" */
  for (let attempt = 0; attempt < 128; attempt += 1) {
    const bytes = source.getRandomValues(new Uint8Array(32));
    const value = BigInt(`0x${toHex(bytes)}`);
    if (value > 0n && value < SM2_N) return value;
  }
  throw new Error('SM2：随机数生成失败（连续 128 次越界，随机源可能异常）');
}

export function generatePrivateKey(seed?: bigint): bigint {
  if (seed === undefined) return randomScalar();
  if (seed <= 0n || seed >= SM2_N) throw new Error('SM2：私钥必须在 [1, n-1] 内');
  return seed;
}

export function derivePublicKey(privateKey: bigint): Sm2Point {
  const point = multiply(mod(privateKey, SM2_N), BASE);
  if (!point) throw new Error('SM2：私钥导出的公钥为无穷远点（私钥非法）');
  return point;
}

function intToBytes32(value: bigint): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) out[31 - i] = Number((value >> BigInt(8 * i)) & 0xffn);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/**
 * 待签名摘要 e = SM3(Z ‖ M)，其中 Z = SM3(ENTL ‖ ID ‖ a ‖ b ‖ xG ‖ yG ‖ xA ‖ yA)。
 * 这一层不做就等于签了另一个算法：OpenSSL/国密设备的验签会直接失败。
  */
export function sm2Digest(message: Uint8Array, publicKey: Sm2Point, id: string = SM2_DEFAULT_ID): bigint {
  const idBytes = utf8(id);
  const bitLength = idBytes.length * 8;
  const entl = new Uint8Array([(bitLength >>> 8) & 0xff, bitLength & 0xff]);
  const z = sm3(
    concat([
      entl,
      idBytes,
      intToBytes32(SM2_A),
      intToBytes32(SM2_B),
      intToBytes32(SM2_GX),
      intToBytes32(SM2_GY),
      intToBytes32(publicKey.x),
      intToBytes32(publicKey.y),
    ]),
  );
  return BigInt(`0x${toHex(sm3(concat([z, message])))}`);
}

// 安全性：k 的取值依赖私钥 d（秘密），外部无法预测，因此不构成"k 可猜"的经典漏洞；

function deterministicK(privateKey: bigint, e: bigint, attempt: number): bigint {
  const seed = concat([intToBytes32(privateKey), intToBytes32(e), intToBytes32(BigInt(attempt))]);
  const digest = sm3(concat([utf8('SM2-DETERMINISTIC-K/V1'), seed]));
  return (BigInt(`0x${toHex(digest)}`) % (SM2_N - 1n)) + 1n;
}

export interface SignOptions {
  /** 注入固定 k（测试用；与 deterministic 互斥，优先使用它） */
  k?: bigint;
  /**
   * 确定性 k 派生（默认 true）：产物可复现是验收硬要求。
   * 置 false 则使用安全随机源。
   */
  deterministic?: boolean;
  id?: string;
}

export function sm2Sign(message: Uint8Array, privateKey: bigint, options: SignOptions = {}): Sm2Signature {
  const publicKey = derivePublicKey(privateKey);
  const e = sm2Digest(message, publicKey, options.id);
  const d = mod(privateKey, SM2_N);
  const inverse = invMod(1n + d, SM2_N);

  const deterministic = options.deterministic ?? true;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const k = options.k ?? (deterministic ? deterministicK(d, e, attempt) : randomScalar());
    const point = multiply(k, BASE);
    if (!point) continue;
    const r = mod(e + point.x, SM2_N);
    if (r === 0n) continue;
    if (r + k === SM2_N) continue;
    const s = mod(inverse * (k - r * d), SM2_N);
    if (s === 0n) continue;
    return { r, s };
  }
  throw new Error('SM2：签名失败（连续 100 次随机 k 均不满足条件，随机源可能异常）');
}

export function sm2Verify(message: Uint8Array, publicKey: Sm2Point, signature: Sm2Signature, id: string = SM2_DEFAULT_ID): boolean {
  const { r, s } = signature;
  if (r <= 0n || r >= SM2_N || s <= 0n || s >= SM2_N) return false;
  if (!isOnCurve(publicKey)) return false;

  const e = sm2Digest(message, publicKey, id);
  const t = mod(r + s, SM2_N);
  if (t === 0n) return false;

  const point = addPoints(multiply(s, BASE), multiply(t, publicKey));
  if (!point) return false;
  return mod(e + point.x, SM2_N) === r;
}

function encodeInteger(value: bigint): Uint8Array {
  let bytes: Uint8Array;
  if (value === 0n) {
    bytes = new Uint8Array([0]);
  } else {
    const hex = value.toString(16);
    const raw = fromHex(hex.length % 2 === 0 ? hex : `0${hex}`);
    /* DER INTEGER 用最小字节数、且为有符号：最高位为 1 时必须补一个 0x00  */
    bytes = (raw[0]! & 0x80) !== 0 ? concat([new Uint8Array([0]), raw]) : raw;
  }
  return concat([new Uint8Array([0x02, bytes.length]), bytes]);
}

/** DER：SEQUENCE { INTEGER r, INTEGER s }（与 OpenSSL 输出一致，便于互操作） */
export function encodeDerSignature(signature: Sm2Signature): Uint8Array {
  const body = concat([encodeInteger(signature.r), encodeInteger(signature.s)]);
  if (body.length < 128) return concat([new Uint8Array([0x30, body.length]), body]);
  const lengthBytes = fromHex(body.length.toString(16).padStart(2, '0'));
  return concat([new Uint8Array([0x30, 0x80 | lengthBytes.length]), lengthBytes, body]);
}

function readLength(bytes: Uint8Array, at: number): { length: number; next: number } {
  const first = bytes[at]!;
  if (first < 0x80) return { length: first, next: at + 1 };
  const count = first & 0x7f;
  let length = 0;
  for (let i = 0; i < count; i += 1) length = (length << 8) | bytes[at + 1 + i]!;
  return { length, next: at + 1 + count };
}

function readInteger(bytes: Uint8Array, at: number): { value: bigint; next: number } {
  if (bytes[at] !== 0x02) throw new Error(`SM2：DER 结构非法（期望 INTEGER，实际 0x${bytes[at]!.toString(16)}）`);
  const { length, next } = readLength(bytes, at + 1);
  let value = 0n;
  for (let i = 0; i < length; i += 1) value = (value << 8n) | BigInt(bytes[next + i]!);
  return { value, next: next + length };
}

export function decodeDerSignature(bytes: Uint8Array): Sm2Signature {
  if (bytes[0] !== 0x30) throw new Error('SM2：DER 结构非法（期望 SEQUENCE）');
  const { next } = readLength(bytes, 1);
  const r = readInteger(bytes, next);
  const s = readInteger(bytes, r.next);
  return { r: r.value, s: s.value };
}

/**
 * SM2 公钥 SPKI 的固定前缀（26 字节）：
 *   SEQUENCE / AlgorithmIdentifier(id-ecPublicKey + sm2p256v1) / BIT STRING 头
 * 之后紧跟 04 ‖ X(32) ‖ Y(32)。自测里用 OpenSSL 导出的 SPKI 做逐字节比对，
 * 证明这个前缀不是"抄错了也不会有人发现"的魔法常量。
 */
const SM2_SPKI_HEAD = fromHex('3059301306072a8648ce3d020106082a811ccf5501822d034200');

export function publicKeyToSpki(publicKey: Sm2Point): Uint8Array {
  return concat([SM2_SPKI_HEAD, new Uint8Array([0x04]), intToBytes32(publicKey.x), intToBytes32(publicKey.y)]);
}

export type SpkiParseResult =
  | { ok: true; publicKey: Sm2Point }
  | { ok: false; code: 'E_SPKI_STRUCTURE' | 'E_SPKI_NOT_ON_CURVE'; reason: string };

// 若拿去加密，会产出一份没有任何私钥能解开的密文（加密本身不会报错）。

export function parseSm2Spki(der: Uint8Array): SpkiParseResult {
  if (der.length < 65 || der[der.length - 65] !== 0x04) {
    return { ok: false, code: 'E_SPKI_STRUCTURE', reason: 'SPKI 结构非法（末尾不是 04‖X‖Y 未压缩点）' };
  }
  const x = der.subarray(der.length - 64, der.length - 32);
  const y = der.subarray(der.length - 32);
  const point = { x: BigInt(`0x${toHex(x)}`), y: BigInt(`0x${toHex(y)}`) };
  if (!isOnCurve(point)) {
    return { ok: false, code: 'E_SPKI_NOT_ON_CURVE', reason: 'SPKI 中的公钥点不在 SM2 曲线上' };
  }
  return { ok: true, publicKey: point };
}

/** 便捷形式：解析失败即抛错（既有调用点保持不变） */
export function publicKeyFromSpki(der: Uint8Array): Sm2Point {
  const result = parseSm2Spki(der);
  if (!result.ok) throw new Error(`SM2：${result.reason}`);
  return result.publicKey;
}

/** 公钥指纹：SPKI 的 SM3 摘要（十六进制），用于"这把钥匙是不是同一把"的展示与比对 */
export function publicKeyFingerprint(publicKey: Sm2Point): string {
  return toHex(sm3(publicKeyToSpki(publicKey)));
}

export {
  concat as concatBytes,
  intToBytes32,
  /* 点运算导出给自测用：`nG = 无穷远` 是曲线参数正确性的最强检查（抄错一个参数就过不了） */
  addPoints as pointAdd,
  multiply as scalarMultiply,
  /* 数学工具导出给 ECDSA 交叉验证桥复用（同一套模运算，避免"两处各写一份"埋下不一致） */
  mod as modOf,
  invMod as inverseOf,
  randomScalar,
};
