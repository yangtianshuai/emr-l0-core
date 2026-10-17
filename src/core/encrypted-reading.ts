/**
 * T18c 受控加密阅读：把「加密」与「受控阅读」缝成**一条链**。
 *
 * 之前的形态是两层各自为政：
 *   - 加密（envelope.ts）解决"文件离库后是密文"，但密钥怎么交给该看的人？口令模式又回到"共享口令"；
 *   - 受控阅读（controlled-reading.ts）解决"授权范围/期限/次数/终端"，但文件本身是明文，
 *     授权挡不住"拿到文件的人"（这条一直写在诚实边界里）。
 *
 * 本模块的做法是**授权即密钥交付**：把"内容密钥（被接收方公钥封装）"写进**授权书**，
 * 而授权书是被 SM2-SM3 签名的。于是三件事同时成立：
 *   ① 改接收方/改密钥 → 签名验不过（授权书被篡改）；
 *   ② 把授权书转给第三人 → 他没有对应私钥，解不出内容密钥（**换终端也没用**）；
 *   ③ 拿 A 文档的授权去读 B 文档 → 两处封装解出来的密钥不一致，本地直接拒绝。
 * 于是"凭证不可转让"从**自报的环境标识**升级为**密码学约束**。
 *
 * 加密对象是**文档 JSON**（`writeSession.exportJson()` 的产物），而不是 OFD 容器 ——
 * 因为受控阅读的粒度是文档模型（章节/字段级白名单）。要加密 OFD 容器请直接用 envelope 的口令/公钥接口。
 *
 * ⚠️ 诚实边界：
 *   - 授权校验（有效期/次数/终端/章节白名单）发生在**解密之后**：技术上密钥已经解出、明文已还原，
 *     校验失败时结果被丢弃而不会返回。若要"连解密都不做"，需要把授权校验前移，
 *     代价是密钥解封与文档绑定校验分处两地（本模块选择"先解后校验"，理由是可验证性更强：
 *     文档指纹校验必须在拿到文档之后才能进行）；
 *   - 次数记账仍由调用方持久化（本模块只判定），强制点在服务端集中记账；
 *   - 不防"接收方自己把解出的明文另行保存"——这是授权阅读的固有限制，不是实现缺陷。
 */

import { sm3Hex, utf8 } from '../crypto/sm3.ts';
import {
  decryptEnvelopeWithDek,
  encryptEnvelopeFor,
  unwrapWrappedKey,
  type Envelope,
  type RecipientPrivateKey,
  type RecipientPublicKey,
} from '../crypto/envelope.ts';
import { fromJson } from '../model/serialize.ts';
import type { DocumentModel } from '../model/types.ts';
import {
  openForReading,
  verifyCredential,
  type ReadingContext,
  type ReadingCredential,
  type ReadingDenyCode,
  type ReadingKeyDelivery,
  type ReadingView,
} from './controlled-reading.ts';

/** 加密 + 生成"密钥交付"片段：后者随授权书一起被签名 */
export interface SealedForReading {
  envelope: Envelope;
  keyDelivery: ReadingKeyDelivery;
}

/**
 * 加密一份**文档 JSON** 并生成交付片段。
 * `dek`/`iv` 只在测试与复现时显式传入；生产一律随机。
 */
export function sealForReading(
  plaintext: Uint8Array,
  recipient: RecipientPublicKey,
  options: { dek?: Uint8Array; iv?: Uint8Array } = {},
): SealedForReading {
  const envelope = encryptEnvelopeFor(plaintext, recipient, options);
  if (envelope.header.kdf.algorithm !== 'SM2-ENVELOPE') {
    throw new Error('内部错误：sealForReading 只支持公钥信封模式');
  }
  return {
    envelope,
    keyDelivery: {
      plaintextDigest: envelope.header.plaintextDigest,
      wrappedKey: envelope.header.kdf.wrappedKey,
      recipientFingerprint: envelope.header.kdf.recipientFingerprint,
    },
  };
}

export type SealedReadingCode =
  | ReadingDenyCode
  | 'E_KEY_DELIVERY_MISSING'
  | 'E_RECIPIENT_MISMATCH'
  | 'E_KEY_DELIVERY_MISMATCH'
  | 'E_PLAINTEXT_DIGEST_MISMATCH'
  | 'E_DOCUMENT_PARSE_FAILED'
  | 'E_ENVELOPE_MALFORMED'
  | 'E_ENVELOPE_UNSUPPORTED'
  | 'E_ENVELOPE_MAC_MISMATCH'
  | 'E_ENVELOPE_LENGTH_MISMATCH'
  | 'E_ENVELOPE_DIGEST_MISMATCH'
  | 'E_ENVELOPE_WRONG_RECIPIENT'
  | 'E_ENVELOPE_KEY_UNWRAP_FAILED';

export interface SealedReadingResult {
  ok: boolean;
  code?: SealedReadingCode;
  reasons: string[];
  /** 受控视图（章节白名单已生效，未授权章节不进视图） */
  view?: ReadingView;
  /** 解出的明文（仅 ok 时返回；校验失败时**不返回**，避免"被拒了却还能拿到内容"） */
  plaintext?: Uint8Array;
}

/** 恒定时间比较：密钥比对不能用 `===`（提前返回会泄露"前几字节对了"） */
function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export interface OpenSealedParams {
  envelope: Envelope;
  credential: ReadingCredential;
  /** 阅读者私钥（+ 公钥指纹）：没有它就连内容密钥都解不出来 */
  recipient: RecipientPrivateKey;
  context: ReadingContext;
  revokedGrantIds?: string[];
  /** 文档反序列化（默认用模型层的 fromJson）；注入点便于测试与复用 */
  parseDocument?: (text: string) => DocumentModel;
}

/**
 * 受控加密阅读：凭证与交付片段核对 → 解封密钥 → 解密 → 反序列化 → 走完整受控阅读校验 → 返回视图。
 *
 * 顺序说明：先用私钥解封并解密（私钥本身就界定了"谁是接收方"），
 * 再做授权校验（有效期/次数/终端/章节/文档指纹）。校验不过时**明文不返回**。
 */
export function openSealedForReading(params: OpenSealedParams): SealedReadingResult {
  const { envelope, credential, recipient, context } = params;

  /* ① 凭证本身与撤销（不涉及文档内容，先做掉，避免"无效凭证也做私钥运算"） */
  const credentialCheck = verifyCredential(credential);
  if (!credentialCheck.ok) {
    return {
      ok: false,
      code: 'E_CREDENTIAL_INVALID',
      reasons: [`授权凭证无效（已被篡改或不是本签发者签发）：${credentialCheck.reasons.join('；')}`],
    };
  }
  if ((params.revokedGrantIds ?? []).includes(credential.grant.grantId)) {
    return { ok: false, code: 'E_GRANT_REVOKED', reasons: [`授权 ${credential.grant.grantId} 已被撤销`] };
  }

  /* ② 授权书里必须带密钥交付片段，否则这就是一份"没给钥匙的授权" */
  const delivery = credential.grant.keyDelivery;
  if (!delivery) {
    return {
      ok: false,
      code: 'E_KEY_DELIVERY_MISSING',
      reasons: ['该授权书不含密钥交付片段（keyDelivery）：它只能用于明文阅读，无法解密受控归档件'],
    };
  }
  if (delivery.recipientFingerprint !== recipient.fingerprint) {
    return {
      ok: false,
      code: 'E_RECIPIENT_MISMATCH',
      reasons: [
        `授权书交付给接收方 ${delivery.recipientFingerprint.slice(0, 16)}…，当前密钥 ${recipient.fingerprint.slice(0, 16)}…`,
        '凭证不可转让：换人/换终端需要重新签发授权',
      ],
    };
  }

  /* ③ 信封必须也是给同一个接收方的（否则就是"授权书与密文对不上"） */
  const kdf = envelope?.header?.kdf;
  if (!envelope?.header || typeof envelope.ciphertext !== 'string') {
    return { ok: false, code: 'E_ENVELOPE_MALFORMED', reasons: ['信封结构不完整'] };
  }
  if (kdf?.algorithm !== 'SM2-ENVELOPE') {
    return {
      ok: false,
      code: 'E_ENVELOPE_UNSUPPORTED',
      reasons: ['受控加密阅读要求公钥封装信封（SM2-ENVELOPE）；这是口令信封，请用口令解密接口'],
    };
  }
  if (kdf.recipientFingerprint !== delivery.recipientFingerprint) {
    return {
      ok: false,
      code: 'E_KEY_DELIVERY_MISMATCH',
      reasons: [
        '授权书交付的接收方与密文信封指定的接收方不一致（授权书与密文不是同一份）',
      ],
    };
  }

  /* ④ 两处封装必须解出**同一把**内容密钥：这是"授权书交付的就是这份密文用的密钥"的证明 */
  const fromCredential = unwrapWrappedKey(delivery.wrappedKey, recipient.privateKey);
  if (!fromCredential.ok) {
    return { ok: false, code: fromCredential.code, reasons: [fromCredential.reason] };
  }
  const fromEnvelope = unwrapWrappedKey(kdf.wrappedKey, recipient.privateKey);
  if (!fromEnvelope.ok) {
    return { ok: false, code: fromEnvelope.code, reasons: [fromEnvelope.reason] };
  }
  if (!equalBytes(fromCredential.key, fromEnvelope.key)) {
    return {
      ok: false,
      code: 'E_KEY_DELIVERY_MISMATCH',
      reasons: ['授权书里的内容密钥与密文实际使用的密钥不一致：该授权不是为这份密文签发的'],
    };
  }

  /* ⑤ 解密（内部会验 MAC、长度与明文摘要） */
  const decrypted = decryptEnvelopeWithDek(envelope, fromCredential.key);
  if (!decrypted.ok) {
    return { ok: false, code: decrypted.code, reasons: [decrypted.reason] };
  }
  if (sm3Hex(decrypted.plaintext) !== delivery.plaintextDigest) {
    return {
      ok: false,
      code: 'E_PLAINTEXT_DIGEST_MISMATCH',
      reasons: ['解出的明文与授权书记录的摘要不符：授权绑定的是另一份内容'],
    };
  }

  /* ⑥ 反序列化 + 完整受控阅读校验（有效期/次数/终端/章节白名单/文档指纹） */
  let doc: DocumentModel;
  try {
    doc = params.parseDocument
      ? params.parseDocument(new TextDecoder().decode(decrypted.plaintext))
      : fromJson(new TextDecoder().decode(decrypted.plaintext));
  } catch (err) {
    return {
      ok: false,
      code: 'E_DOCUMENT_PARSE_FAILED',
      reasons: [`解密成功但无法还原为文档模型（加密的可能不是文档 JSON）：${(err as Error).message}`],
    };
  }

  const decision = openForReading(credential, doc, context, { revokedGrantIds: params.revokedGrantIds ?? [] });
  if (!decision.allowed) {
    return { ok: false, code: decision.code, reasons: decision.reasons };
  }
  return { ok: true, reasons: [], view: decision.view, plaintext: decrypted.plaintext };
}

/** 把明文摘要算出来（供签发授权时填充 keyDelivery；与信封实现同源，避免两处口径不同） */
export function digestOfPlaintext(plaintext: Uint8Array): string {
  return sm3Hex(plaintext);
}

/** 便于调用方把"文档 JSON 文本"直接加密（少一步编码转换，避免各处各写一遍） */
export function sealDocumentJson(
  json: string,
  recipient: RecipientPublicKey,
  options: { dek?: Uint8Array; iv?: Uint8Array } = {},
): SealedForReading {
  return sealForReading(utf8(json), recipient, options);
}
