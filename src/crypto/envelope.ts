/**
 * 认证加密信封：SM4-CTR + HMAC-SM3（**Encrypt-then-MAC**），口令派生密钥。
 *
 * 解决什么问题：本仓库此前的所有产物都是**明文**（OFD 是 ZIP、共享文档是纯 XML），
 * 受控阅读只解决"授权阅读"，挡不住"拿到文件的人"（我自己在诚实边界里写明了这一点）。
 * 这个模块补的就是**静态机密性**：离开系统的归档件是密文，没有密钥解不开。
 *
 * 关键设计（每条都有具体理由）：
 *   1) **EtM（先加密再 MAC）**：MAC 覆盖 `规范化头部 ‖ 密文`。若用 MAC-then-Encrypt，
 *      解密器必须先解密再校验，填充/解析错误会变成可利用的 oracle；EtM 下**校验不过就直接拒绝**，
 *      连解密都不做。CTR 无填充 + EtM 是这个组合的最小攻击面。
 *   2) **头部进 MAC**：IV、算法套件、KDF 参数都在被 MAC 覆盖的规范化文本里 ——
 *      否则改 IV 或把套件降级成"不加密"这类攻击不会被发现。
 *   3) **明文摘要单列**：头部带 `SM3(明文)`。它不能替代 MAC（MAC 保完整性），
 *      但它能让"解密后拿到的东西 ≠ 当初加密的东西"变成**可判定的错误**而不是静默错乱。
 *   4) **两个子密钥**：KDF 一次派生 48 字节 → `Kmac(32) ‖ Kenc(16)`。
 *      加密密钥与 MAC 密钥必须分开：用同一把钥匙既加密又 MAC 会引入跨算法攻击面。
 *   5) **随机 IV**：每次加密随机生成，且与 salt 一起随文保存（唯一性由随机保证）。
 *
 * ⚠️ 诚实边界：
 *   - 本模块只做**对称**加密（口令模式）。"给谁的密钥"这件事需要**公钥信封**（用接收方 SM2 公钥
 *     封装随机密钥），本模块**尚未实现**（下一步），因此当前形态适合"本单位口令保护的归档件"；
 *   - 口令熵低，安全性完全取决于口令强度与迭代次数；迭代次数写在头部（可被篡改？不会——头部进了 MAC，
 *     改了 MAC 就不过）但降低迭代次数的攻击需要能重新计算 MAC，即需要口令本身；
 *   - 不提供侧信道防护；生产应使用密码模块。
 */

import { randomBytes } from 'node:crypto';
import { sm3, sm3Hex, toHex, utf8 } from './sm3.ts';
import { DEFAULT_PBKDF2_ITERATIONS, concatBytes, hmacSm3, passphraseBytes, pbkdf2HmacSm3 } from './kdf.ts';
import { SM4_IV_LENGTH, assertSm4, sm4Ctr } from './sm4.ts';
import { publicKeyFingerprint, type Sm2Point } from './sm2.ts';
import { sm2Decrypt, sm2Encrypt } from './sm2-encrypt.ts';

export const ENVELOPE_SUITE = 'SM4-CTR-HMAC-SM3' as const;
export const ENVELOPE_VERSION = 1 as const;

/**
 * 密钥来源：**口令派生** 或 **公钥封装**（互斥，由 algorithm 判别）。
 *
 * 为什么要两种：口令模式解决"本机口令保护的归档件"；公钥模式解决**"给谁的密钥"** ——
 * 只有持有私钥的人能解出内容密钥，于是"授权"能成立在密码学层面（而不是靠"相信他只给该看的人"）。
 */
export type EnvelopeKeySource =
  | {
      algorithm: 'PBKDF2-HMAC-SM3';
      /** base64 */
      salt: string;
      iterations: number;
    }
  | {
      algorithm: 'SM2-ENVELOPE';
      /** SM2 加密后的内容密钥（C1C3C2，base64） */
      wrappedKey: string;
      /** 接收方公钥指纹（SM3(SPKI)）：用于"这个信封到底是不是给我的"的**早期**判断 */
      recipientFingerprint: string;
    };

export interface EnvelopeHeader {
  version: typeof ENVELOPE_VERSION;
  suite: typeof ENVELOPE_SUITE;
  /** SM4-CTR 的 IV（base64） */
  iv: string;
  kdf: EnvelopeKeySource;
  /** 明文长度（解密后可核对，避免"解出来少一截"被当成正常） */
  plaintextLength: number;
  /** SM3(明文)，十六进制小写 */
  plaintextDigest: string;
  /** HMAC-SM3(Kmac, 规范化头部 ‖ 密文)，十六进制小写 */
  mac: string;
}

export interface Envelope {
  header: EnvelopeHeader;
  /** 密文（base64） */
  ciphertext: string;
}

export type EnvelopeErrorCode =
  | 'E_ENVELOPE_MALFORMED'
  | 'E_ENVELOPE_UNSUPPORTED'
  | 'E_ENVELOPE_MAC_MISMATCH'
  | 'E_ENVELOPE_LENGTH_MISMATCH'
  | 'E_ENVELOPE_DIGEST_MISMATCH'
  /** 信封不是给这把私钥的（指纹不符）——**在解封之前**就能判定，不必做无谓的私钥运算 */
  | 'E_ENVELOPE_WRONG_RECIPIENT'
  /** 密钥解封失败（封装被篡改，或私钥与指纹不配对） */
  | 'E_ENVELOPE_KEY_UNWRAP_FAILED';

export type DecryptResult =
  | { ok: true; plaintext: Uint8Array }
  | { ok: false; code: EnvelopeErrorCode; reason: string };

/* ------------------------------- 编解码工具 ------------------------------- */

/* 导出（而非模块私有）：调用方需要**读头部而不解密**时（例如判断一份快照是"哪一代盐"写的），
   必须能自己解析这些编码 —— 为此在 store 里另写一份 base64 实现，才是真正的风险（两套口径会漂移）。 */
export const toBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');
export const fromBase64 = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'base64'));

/* ⚠️ 这里曾有过一个真 bug，留痕以免重犯：
   早期有一个 `const hex = (bytes) => sm3Hex(bytes)`，然后到处写成 `hex(sm3(plaintext))` ——
   而 `sm3Hex` **自己就会做 SM3**，于是明文摘要与 MAC 都变成了"两层 SM3"。
   由于加密与校验用的是同一个错误口径，内部完全自洽，**所有既有用例都是绿的**；
   是后来加的一条"摘要必须等于 SM3(明文)（并用 OpenSSL 交叉印证）"的断言才把它抓出来。
   教训：**"取十六进制字符串"与"算摘要并取十六进制"必须是两个名字**。 */
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

/**
 * 头部规范化文本：**字段顺序固定**、`mac` 不参与（它就是要算出来的东西）。
 * 与签名链的 SignedInfo 同一纪律：协议字节不能随实现或对象属性顺序漂移。
 */
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
      /* 口令模式的字节序列与加入公钥模式之前**完全一致**（顺序未变），
         否则已经生成的 `.l0enc` 会全部验不过 —— 协议字节不能随功能扩展而漂移 */
      ...keyLines,
      `plaintextLength=${header.plaintextLength}`,
      `plaintextDigest=${header.plaintextDigest}`,
      '',
    ].join('\n'),
  );
}

/**
 * 派生结果缓存：**同 (口令, salt, 迭代数) 只派生一次**。
 *
 * 为什么必须缓存：`DEFAULT_PBKDF2_ITERATIONS = 200_000`，在纯 JS 的 HMAC-SM3 下
 * **单次派生约 7.6 秒**（实测，加解密各一次约 15 秒）。而"每次写操作落盘一次快照"
 * 的场景里，缓存与否是**全量自测 609 秒与 30 秒**的区别（实测）。
 * 换句话说：不缓存时，"落盘保护数据"这件事本身会慢到没人愿意开。
 *
 * 为什么缓存是安全的：
 *   - 派生是**纯函数**，相同输入必然相同输出，缓存不改变任何语义；
 *   - 缓存的是**子密钥**（不是口令）。能读进程内存的人早已能读到解密后的明文，
 *     所以它没有扩大信任边界；
 *   - 键里放口令的 **SM3 摘要**而不是口令字节：Map 的键会长期驻留，
 *     没必要把口令原文留在里面（摘要同样能区分不同口令）。
 *
 * ⚠️ 缓存**不降低**离线暴力破解成本：盐与迭代数仍写在信封头部，
 *    攻击者的成本只取决于这两者，与本进程缓存无关。
 */
const DERIVED_KEY_CACHE = new Map<string, { kMac: Uint8Array; kEnc: Uint8Array }>();
/** 正常只有 1~2 种（当前口令 + 轮换期的旧口令）；给 32 是留足余量，同时防止无限增长 */
const DERIVED_KEY_CACHE_LIMIT = 32;

/** 从口令派生两个子密钥：Kmac(32) ‖ Kenc(16)。密钥分离是硬要求，不是风格偏好 */
function deriveKeys(passphrase: Uint8Array, salt: Uint8Array, iterations: number): { kMac: Uint8Array; kEnc: Uint8Array } {
  const cacheKey = `${iterations}|${toHex(salt)}|${sm3Hex(passphrase)}`;
  const cached = DERIVED_KEY_CACHE.get(cacheKey);
  if (cached) return cached;
  const material = pbkdf2HmacSm3(passphrase, salt, iterations, 48);
  const keys = { kMac: material.subarray(0, 32), kEnc: material.subarray(32, 48) };
  if (DERIVED_KEY_CACHE.size >= DERIVED_KEY_CACHE_LIMIT) {
    /* 按插入序淘汰最早一条（不做 LRU：这里命中率天然极高，不值得为它引入计数器） */
    const oldest = DERIVED_KEY_CACHE.keys().next().value;
    if (oldest !== undefined) DERIVED_KEY_CACHE.delete(oldest);
  }
  DERIVED_KEY_CACHE.set(cacheKey, keys);
  return keys;
}

function macOf(kMac: Uint8Array, header: EnvelopeHeader, ciphertext: Uint8Array): string {
  /* toHex（纯转换），不是 sm3Hex（会再算一次摘要） */
  return toHex(hmacSm3(kMac, concatBytes(canonicalHeader(header), ciphertext)));
}

/* --------------------------------- 加密 --------------------------------- */

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

/* --------------------------------- 解密 --------------------------------- */

/**
 * 解密顺序**必须**是：结构校验 → MAC 校验 → 解密 → 长度/摘要校验。
 * 先解密再校验会让攻击者用"错误类型"当 oracle（填充/解析差异都能被利用）。
 */
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

  /* ① MAC 先验：不过就直接拒绝，**不解密**（避免把解密错误当成信息泄露出去） */
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

/* ------------------------------ 公钥信封模式 ------------------------------ */

export interface RecipientPublicKey {
  publicKey: Sm2Point;
  /** 缺省时由公钥算（SM3(SPKI)）；显式传入便于与外部核对 */
  fingerprint?: string;
}

export interface RecipientPrivateKey {
  privateKey: bigint;
  /** 公钥指纹：用于"这个信封是不是给我的"的**早期**判断（在动用私钥之前） */
  fingerprint: string;
}

/**
 * MAC 密钥由内容密钥**再派生**一次（带域分隔），不复用内容密钥本身：
 * 同一份密钥材料既做加密又做认证会引入跨用途攻击面。
 */
function macKeyOfDek(dek: Uint8Array): Uint8Array {
  return sm3(concatBytes(utf8('l0-envelope-mac'), dek));
}

/**
 * 用接收方**公钥**加密：随机内容密钥（DEK）加密正文，DEK 再用 SM2 封装进头部。
 * 于是"谁能读"由密码学保证：没有私钥就解不出 DEK，拿到文件也没用。
 */
export function encryptEnvelopeFor(
  plaintext: Uint8Array,
  recipient: RecipientPublicKey,
  options: { iv?: Uint8Array; dek?: Uint8Array } = {},
): Envelope {
  assertSm4();
  /* 边界（实测发现）：SM2 加密的 KDF 要求输出长度为正整数，
     所以**空明文无法用公钥模式加密**。这里给出明确错误，
     而不是把"KDF 输出长度必须为正整数"这种内部错误抛给调用方。
     需要加密空内容（例如空草稿）时用口令模式。 */
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

/**
 * 用接收方**私钥**解密。
 *
 * 顺序：结构校验 → 指纹是否匹配（**先判断"是不是给我的"**，避免无谓的私钥运算）
 * → SM2 解封 DEK（C3 校验）→ 验整体 MAC → SM4 解密 → 长度/摘要校验。
 * 与口令模式的差别：这里必须先解出 DEK 才能算 MAC，因此把"密钥解封失败"独立成一个错误码，
 * 避免和"MAC 不符"混在一起（现场排查时这两个原因的处置完全不同）。
 */
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

/**
 * 解封被封装的**内容密钥**（低层接口）。
 *
 * 为什么单独暴露：受控阅读的"授权即密钥交付"需要**比较两处封装**——
 * 授权书里的 `wrappedKey` 与信封头部里的 `wrappedKey` 必须解出同一把钥匙，
 * 才能证明"授权书交付的密钥就是这份密文用的密钥"（否则可以拿 A 文档的授权去读 B 文档）。
 */
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

/**
 * 用**已解封的内容密钥**解密（低层接口）：校验头部/套件 → 验 MAC → 解密 → 核对长度与摘要。
 * 结构校验在这里重做一遍，因为它也可能被独立调用（不能依赖调用方已经校验过）。
 */
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
