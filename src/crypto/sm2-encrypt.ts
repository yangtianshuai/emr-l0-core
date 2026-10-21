import { sm3 } from './sm3.ts';
import { concatBytes, sm3Kdf } from './kdf.ts';
import {
  SM2_GX,
  SM2_GY,
  SM2_N,
  derivePublicKey,
  intToBytes32,
  isOnCurve,
  modOf,
  randomScalar,
  scalarMultiply,
  type Sm2Point,
} from './sm2.ts';

export const SM2_CIPHERTEXT_ORDER = 'C1C3C2' as const;
const C1_LENGTH = 65;
const C3_LENGTH = 32;

export type Sm2EncryptErrorCode =
  | 'E_SM2_MALFORMED'
  | 'E_SM2_POINT_NOT_ON_CURVE'
  | 'E_SM2_KDF_FAILED'
  | 'E_SM2_C3_MISMATCH';

export type Sm2DecryptResult =
  | { ok: true; plaintext: Uint8Array }
  | { ok: false; code: Sm2EncryptErrorCode; reason: string };

function encodePoint(point: Sm2Point): Uint8Array {
  return concatBytes(new Uint8Array([0x04]), intToBytes32(point.x), intToBytes32(point.y));
}

function decodePoint(bytes: Uint8Array): Sm2Point | undefined {
  if (bytes.length !== C1_LENGTH || bytes[0] !== 0x04) return undefined;
  const x = BigInt(`0x${toHexOf(bytes.subarray(1, 33))}`);
  const y = BigInt(`0x${toHexOf(bytes.subarray(33, 65))}`);
  return { x, y };
}

function toHexOf(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

/** 恒定时间比较（C3 校验不能用 `===`：提前返回会泄露"前几字节对了"） */
function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/** 结构预检：长度与 C1 是否合法。解密前先做，避免把"格式错"当成"密钥错" */
export function inspectSm2Ciphertext(ciphertext: Uint8Array): { ok: boolean; code?: Sm2EncryptErrorCode; reason?: string } {
  if (ciphertext.length < C1_LENGTH + C3_LENGTH) {
    return {
      ok: false,
      code: 'E_SM2_MALFORMED',
      reason: `密文过短：至少 ${C1_LENGTH + C3_LENGTH} 字节（C1 65 + C3 32），实际 ${ciphertext.length}`,
    };
  }
  const point = decodePoint(ciphertext.subarray(0, C1_LENGTH));
  if (!point) return { ok: false, code: 'E_SM2_MALFORMED', reason: 'C1 不是合法未压缩点（应为 04‖X‖Y）' };
  if (!isOnCurve(point)) {
    return { ok: false, code: 'E_SM2_POINT_NOT_ON_CURVE', reason: 'C1 不在 SM2 曲线上（密文被构造或损坏）' };
  }
  return { ok: true };
}

export interface Sm2EncryptOptions {
  k?: bigint;
  /** KDF 全 0 时的最大重试次数（标准要求换 k 重来） */
  maxRetries?: number;
}

export function sm2Encrypt(plaintext: Uint8Array, publicKey: Sm2Point, options: Sm2EncryptOptions = {}): Uint8Array {
  if (!isOnCurve(publicKey)) throw new Error('SM2 加密：接收方公钥不在曲线上');
  const maxRetries = options.maxRetries ?? 8;
  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    const k = options.k ?? (attempt === 0 ? randomScalar() : randomScalar());
    const c1 = scalarMultiply(k, { x: SM2_GX, y: SM2_GY });
    if (!c1) continue;
    const shared = scalarMultiply(k, publicKey);
    if (!shared) continue;

    let t: Uint8Array;
    try {
      t = sm3Kdf(concatBytes(intToBytes32(shared.x), intToBytes32(shared.y)), plaintext.length);
    } catch {
      /* KDF 全 0：按标准换 k 重来（不静默使用异常密钥） */
      continue;
    }
    const c2 = new Uint8Array(plaintext.length);
    for (let i = 0; i < plaintext.length; i += 1) c2[i] = plaintext[i]! ^ t[i]!;
    const c3 = sm3(concatBytes(intToBytes32(shared.x), plaintext, intToBytes32(shared.y)));
    return concatBytes(encodePoint(c1), c3, c2);
  }
  throw new Error('SM2 加密：KDF 连续返回异常值，已按标准终止（不使用异常密钥）');
}

export function sm2Decrypt(ciphertext: Uint8Array, privateKey: bigint): Sm2DecryptResult {
  const structure = inspectSm2Ciphertext(ciphertext);
  if (!structure.ok) return { ok: false, code: structure.code!, reason: structure.reason! };

  const c1 = decodePoint(ciphertext.subarray(0, C1_LENGTH))!;
  const c3 = ciphertext.subarray(C1_LENGTH, C1_LENGTH + C3_LENGTH);
  const c2 = ciphertext.subarray(C1_LENGTH + C3_LENGTH);

  const shared = scalarMultiply(modOf(privateKey, SM2_N), c1);
  if (!shared) return { ok: false, code: 'E_SM2_MALFORMED', reason: '共享点计算得到无穷远点（C1 非法）' };

  let t: Uint8Array;
  try {
    t = sm3Kdf(concatBytes(intToBytes32(shared.x), intToBytes32(shared.y)), c2.length);
  } catch (err) {
    return { ok: false, code: 'E_SM2_KDF_FAILED', reason: (err as Error).message };
  }

  const plaintext = new Uint8Array(c2.length);
  for (let i = 0; i < c2.length; i += 1) plaintext[i] = c2[i]! ^ t[i]!;

  const expected = sm3(concatBytes(intToBytes32(shared.x), plaintext, intToBytes32(shared.y)));
  if (!equalBytes(expected, c3)) {
    return {
      ok: false,
      code: 'E_SM2_C3_MISMATCH',
      reason: 'C3 校验失败：密文被篡改，或用错了私钥（两者在密码学上不可区分）',
    };
  }
  return { ok: true, plaintext };
}

export function publicKeyOf(privateKey: bigint): Sm2Point {
  return derivePublicKey(privateKey);
}
