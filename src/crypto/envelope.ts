import { randomBytes } from 'node:crypto';
import { sm3, sm3Hex, toHex, utf8 } from './sm3.ts';
import { DEFAULT_PBKDF2_ITERATIONS, concatBytes, hmacSm3, passphraseBytes, pbkdf2HmacSm3 } from './kdf.ts';
import { SM4_IV_LENGTH, assertSm4, sm4Ctr } from './sm4.ts';
import { publicKeyFingerprint, type Sm2Point } from './sm2.ts';
import { sm2Decrypt, sm2Encrypt } from './sm2-encrypt.ts';

export const ENVELOPE_SUITE = 'SM4-CTR-HMAC-SM3' as const;
export const ENVELOPE_VERSION = 1 as const;

export type EnvelopeKeySource =
  | {
      algorithm: 'PBKDF2-HMAC-SM3';
      salt: string;
      iterations: number;
    }
  | {
      algorithm: 'SM2-ENVELOPE';
      wrappedKey: string;
      recipientFingerprint: string;
    };

export interface EnvelopeHeader {
  version: typeof ENVELOPE_VERSION;
  suite: typeof ENVELOPE_SUITE;
  iv: string;
  kdf: EnvelopeKeySource;
  plaintextLength: number;
  plaintextDigest: string;
  mac: string;
}

export interface Envelope {
  header: EnvelopeHeader;
  ciphertext: string;
}

export type EnvelopeErrorCode =
  | 'E_ENVELOPE_MALFORMED'
  | 'E_ENVELOPE_UNSUPPORTED'
  | 'E_ENVELOPE_MAC_MISMATCH'
  | 'E_ENVELOPE_LENGTH_MISMATCH'
  | 'E_ENVELOPE_DIGEST_MISMATCH'
  | 'E_ENVELOPE_WRONG_RECIPIENT'
  | 'E_ENVELOPE_KEY_UNWRAP_FAILED';

export type DecryptResult =
  | { ok: true; plaintext: Uint8Array }
  | { ok: false; code: EnvelopeErrorCode; reason: string };

export const toBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');
export const fromBase64 = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'base64'));

const hexToBytes = (text: string): Uint8Array => {
  if (typeof text !== 'string' || text.length % 2 !== 0 || !/^[0-9a-f]*$/.test(text)) return new Uint8Array(0);
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return out;
};

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  /* 恒定时间比较：MAC 校验不能用提前返回的 ===（会泄露"前几字节对了"） */
  for (let i = 0; i < a.length; i += 1) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export function canonicalHeader(header: EnvelopeHeader): Uint8Array {
  const keyLines =
    header.kdf.algorithm === 'PBKDF2-HMAC-SM3'
      ? [`kdf=${header.kdf.algorithm}`, `salt=${header.kdf.salt}`, `iterations=${header.kdf.iterations}`]
      : [
          `kdf=${header.kdf.algorithm}`,
          `wrappedKey=${header.kdf.wrappedKey}`,
          `recipient=${header.kdf.recipientFingerprint}`,
        ];
  return utf8(
    [
      `envelope/${header.version}`,
      `suite=${header.suite}`,
      `iv=${header.iv}`,
      ...keyLines,
      `plaintextLength=${header.plaintextLength}`,
      `plaintextDigest=${header.plaintextDigest}`,
      '',
    ].join('\n'),
  );
}

const DERIVED_KEY_CACHE = new Map<string, { kMac: Uint8Array; kEnc: Uint8Array }>();
const DERIVED_KEY_CACHE_LIMIT = 32;

function deriveKeys(passphrase: Uint8Array, salt: Uint8Array, iterations: number): { kMac: Uint8Array; kEnc: Uint8Array } {
  const cacheKey = `${iterations}|${toHex(salt)}|${sm3Hex(passphrase)}`;
  const cached = DERIVED_KEY_CACHE.get(cacheKey);
  if (cached) return cached;
  const material = pbkdf2HmacSm3(passphrase, salt, iterations, 48);
  const keys = { kMac: material.subarray(0, 32), kEnc: material.subarray(32, 48) };
  if (DERIVED_KEY_CACHE.size >= DERIVED_KEY_CACHE_LIMIT) {
    const oldest = DERIVED_KEY_CACHE.keys().next().value;
    if (oldest !== undefined) DERIVED_KEY_CACHE.delete(oldest);
  }
  DERIVED_KEY_CACHE.set(cacheKey, keys);
  return keys;
}

function macOf(kMac: Uint8Array, header: EnvelopeHeader, ciphertext: Uint8Array): string {
  return toHex(hmacSm3(kMac, concatBytes(canonicalHeader(header), ciphertext)));
}

export interface EncryptOptions {
  passphrase: string;
  /** 测试或复现时显式指定；生产不要传（随机才是默认） */
  iterations?: number;
  salt?: Uint8Array;
  iv?: Uint8Array;
}

export function encryptEnvelope(plaintext: Uint8Array, options: EncryptOptions): Envelope {
  assertSm4();
  const iterations = options.iterations ?? DEFAULT_PBKDF2_ITERATIONS;
  const salt = options.salt ?? new Uint8Array(randomBytes(16));
  const iv = options.iv ?? new Uint8Array(randomBytes(SM4_IV_LENGTH));
  if (iv.length !== SM4_IV_LENGTH) throw new Error(`IV 必须为 ${SM4_IV_LENGTH} 字节`);

  const { kMac, kEnc } = deriveKeys(passphraseBytes(options.passphrase), salt, iterations);
  const ciphertext = sm4Ctr(kEnc, iv, plaintext);
  const header: EnvelopeHeader = {
    version: ENVELOPE_VERSION,
    suite: ENVELOPE_SUITE,
    iv: toBase64(iv),
    kdf: { algorithm: 'PBKDF2-HMAC-SM3', salt: toBase64(salt), iterations },
    plaintextLength: plaintext.length,
    plaintextDigest: sm3Hex(plaintext),
    mac: '',
  };
  header.mac = macOf(kMac, header, ciphertext);
  return { header, ciphertext: toBase64(ciphertext) };
}

export function decryptEnvelope(envelope: Envelope, passphrase: string): DecryptResult {
  const header = envelope?.header;
  if (!header || typeof header.iv !== 'string' || typeof envelope.ciphertext !== 'string') {
    return { ok: false, code: 'E_ENVELOPE_MALFORMED', reason: '信封结构不完整（缺少 header 或 ciphertext）' };
  }
  if (header.version !== ENVELOPE_VERSION || header.suite !== ENVELOPE_SUITE) {
    return {
      ok: false,
      code: 'E_ENVELOPE_UNSUPPORTED',
      reason: `不支持的算法套件或版本：version=${header.version} suite=${header.suite}`,
    };
  }
  const kdf = header.kdf;
  if (!kdf) return { ok: false, code: 'E_ENVELOPE_MALFORMED', reason: '信封缺少 kdf 段' };
  if (kdf.algorithm === 'SM2-ENVELOPE') {
    return {
      ok: false,
      code: 'E_ENVELOPE_UNSUPPORTED',
      reason: '该信封用公钥封装密钥（SM2-ENVELOPE）：口令解密对它无效，请用 decryptEnvelopeWith 以私钥解封',
    };
  }
  if (kdf.algorithm !== 'PBKDF2-HMAC-SM3' || !Number.isInteger(kdf.iterations)) {
    return { ok: false, code: 'E_ENVELOPE_UNSUPPORTED', reason: `不支持的 KDF：${JSON.stringify(kdf)}` };
  }
  assertSm4();

  const iv = fromBase64(header.iv);
  const salt = fromBase64(kdf.salt);
  const ciphertext = fromBase64(envelope.ciphertext);
  const { kMac, kEnc } = deriveKeys(passphraseBytes(passphrase), salt, kdf.iterations);

  const expected = macOf(kMac, header, ciphertext);
  if (!equalBytes(hexToBytes(expected), hexToBytes(header.mac))) {
    return {
      ok: false,
      code: 'E_ENVELOPE_MAC_MISMATCH',
      reason: '完整性校验失败：口令不对，或文件/头部已被篡改（本模块无法区分这两者，如实说明）',
    };
  }

  const plaintext = sm4Ctr(kEnc, iv, ciphertext);
  if (plaintext.length !== header.plaintextLength) {
    return {
      ok: false,
      code: 'E_ENVELOPE_LENGTH_MISMATCH',
      reason: `解密长度与头部声明不符：声明 ${header.plaintextLength}，实际 ${plaintext.length}`,
    };
  }
  if (sm3Hex(plaintext) !== header.plaintextDigest) {
    return {
      ok: false,
      code: 'E_ENVELOPE_DIGEST_MISMATCH',
      reason: '明文摘要与头部记录不符：内容不是当初加密的那一份',
    };
  }
  return { ok: true, plaintext };
}

export interface RecipientPublicKey {
  publicKey: Sm2Point;
  fingerprint?: string;
}

export interface RecipientPrivateKey {
  privateKey: bigint;
  fingerprint: string;
}

function macKeyOfDek(dek: Uint8Array): Uint8Array {
  return sm3(concatBytes(utf8('l0-envelope-mac'), dek));
}

export function encryptEnvelopeFor(
  plaintext: Uint8Array,
  recipient: RecipientPublicKey,
  options: { iv?: Uint8Array; dek?: Uint8Array } = {},
): Envelope {
  assertSm4();
  if (plaintext.length === 0) {
    throw new Error('公钥信封不支持空明文（SM2 加密的 KDF 要求长度 > 0）：空内容请改用口令模式');
  }
  const fingerprint = recipient.fingerprint ?? publicKeyFingerprint(recipient.publicKey);
  const dek = options.dek ?? new Uint8Array(randomBytes(16));
  if (dek.length !== 16) throw new Error(`内容密钥必须为 16 字节，实际 ${dek.length} 字节`);
  const iv = options.iv ?? new Uint8Array(randomBytes(SM4_IV_LENGTH));
  if (iv.length !== SM4_IV_LENGTH) throw new Error(`IV 必须为 ${SM4_IV_LENGTH} 字节`);

  const ciphertext = sm4Ctr(dek, iv, plaintext);
  const header: EnvelopeHeader = {
    version: ENVELOPE_VERSION,
    suite: ENVELOPE_SUITE,
    iv: toBase64(iv),
    kdf: {
      algorithm: 'SM2-ENVELOPE',
      wrappedKey: toBase64(sm2Encrypt(dek, recipient.publicKey)),
      recipientFingerprint: fingerprint,
    },
    plaintextLength: plaintext.length,
    plaintextDigest: sm3Hex(plaintext),
    mac: '',
  };
  header.mac = macOf(macKeyOfDek(dek), header, ciphertext);
  return { header, ciphertext: toBase64(ciphertext) };
}

export function decryptEnvelopeWith(envelope: Envelope, recipient: RecipientPrivateKey): DecryptResult {
  const header = envelope?.header;
  if (!header || typeof header.iv !== 'string' || typeof envelope.ciphertext !== 'string') {
    return { ok: false, code: 'E_ENVELOPE_MALFORMED', reason: '信封结构不完整（缺少 header 或 ciphertext）' };
  }
  if (header.version !== ENVELOPE_VERSION || header.suite !== ENVELOPE_SUITE) {
    return {
      ok: false,
      code: 'E_ENVELOPE_UNSUPPORTED',
      reason: `不支持的算法套件或版本：version=${header.version} suite=${header.suite}`,
    };
  }
  const kdf = header.kdf;
  if (!kdf) return { ok: false, code: 'E_ENVELOPE_MALFORMED', reason: '信封缺少 kdf 段' };
  if (kdf.algorithm !== 'SM2-ENVELOPE') {
    return {
      ok: false,
      code: 'E_ENVELOPE_UNSUPPORTED',
      reason: '该信封用口令派生密钥（PBKDF2-HMAC-SM3）：请用 decryptEnvelope 以口令解密',
    };
  }
  if (kdf.recipientFingerprint !== recipient.fingerprint) {
    return {
      ok: false,
      code: 'E_ENVELOPE_WRONG_RECIPIENT',
      reason: `这个信封不是给当前密钥的：信封指定接收方 ${kdf.recipientFingerprint.slice(0, 16)}…，当前密钥 ${recipient.fingerprint.slice(0, 16)}…`,
    };
  }
  assertSm4();

  const unwrapped = unwrapWrappedKey(kdf.wrappedKey, recipient.privateKey);
  if (!unwrapped.ok) return unwrapped;
  return decryptEnvelopeWithDek(envelope, unwrapped.key);
}

export function unwrapWrappedKey(
  wrappedKeyBase64: string,
  privateKey: bigint,
): { ok: true; key: Uint8Array } | { ok: false; code: EnvelopeErrorCode; reason: string } {
  const unwrapped = sm2Decrypt(fromBase64(wrappedKeyBase64), privateKey);
  if (!unwrapped.ok) {
    return {
      ok: false,
      code: 'E_ENVELOPE_KEY_UNWRAP_FAILED',
      reason: `内容密钥解封失败（${unwrapped.code}）：${unwrapped.reason}`,
    };
  }
  if (unwrapped.plaintext.length !== 16) {
    return {
      ok: false,
      code: 'E_ENVELOPE_KEY_UNWRAP_FAILED',
      reason: `解出的内容密钥长度异常：${unwrapped.plaintext.length} 字节（应为 16）`,
    };
  }
  return { ok: true, key: unwrapped.plaintext };
}

export function decryptEnvelopeWithDek(envelope: Envelope, dek: Uint8Array): DecryptResult {
  const header = envelope?.header;
  if (!header || typeof header.iv !== 'string' || typeof envelope.ciphertext !== 'string') {
    return { ok: false, code: 'E_ENVELOPE_MALFORMED', reason: '信封结构不完整（缺少 header 或 ciphertext）' };
  }
  if (header.version !== ENVELOPE_VERSION || header.suite !== ENVELOPE_SUITE) {
    return {
      ok: false,
      code: 'E_ENVELOPE_UNSUPPORTED',
      reason: `不支持的算法套件或版本：version=${header.version} suite=${header.suite}`,
    };
  }
  if (header.kdf?.algorithm !== 'SM2-ENVELOPE') {
    return { ok: false, code: 'E_ENVELOPE_UNSUPPORTED', reason: '该信封不是公钥封装模式，不能用内容密钥直接解密' };
  }
  if (dek.length !== 16) return { ok: false, code: 'E_ENVELOPE_KEY_UNWRAP_FAILED', reason: `内容密钥长度异常：${dek.length} 字节` };
  assertSm4();

  const ciphertext = fromBase64(envelope.ciphertext);
  const expected = macOf(macKeyOfDek(dek), header, ciphertext);
  if (!equalBytes(hexToBytes(expected), hexToBytes(header.mac))) {
    return {
      ok: false,
      code: 'E_ENVELOPE_MAC_MISMATCH',
      reason: '完整性校验失败：文件或头部已被篡改（密钥已正确解出，故此处不是密钥问题）',
    };
  }

  const plaintext = sm4Ctr(dek, fromBase64(header.iv), ciphertext);
  if (plaintext.length !== header.plaintextLength) {
    return {
      ok: false,
      code: 'E_ENVELOPE_LENGTH_MISMATCH',
      reason: `解密长度与头部声明不符：声明 ${header.plaintextLength}，实际 ${plaintext.length}`,
    };
  }
  if (sm3Hex(plaintext) !== header.plaintextDigest) {
    return { ok: false, code: 'E_ENVELOPE_DIGEST_MISMATCH', reason: '明文摘要与头部记录不符：内容不是当初加密的那一份' };
  }
  return { ok: true, plaintext };
}
