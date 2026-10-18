// T18d 接收方公钥目录：谁持有私钥、公钥长什么样、怎么交换。
// 那是纯演示（私钥可被任何人推导）。真实场景需要：接收方自己生成密钥对，把公钥交给发送方，

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  isOnCurve,
  parseSm2Spki,
  publicKeyFingerprint,
  publicKeyFromSpki,
  publicKeyToSpki,
  type Sm2Point,
} from '../crypto/sm2.ts';

export interface RecipientKey {
  keyId: string;
  /** 人类可读的标签（"张医生"/"会诊终端A"）——只是标签，不构成身份证明  */
  label: string;
  /** SM2 公钥 SPKI（DER）的 base64；私钥永不入库  */
  spkiBase64: string;
  /** SM3(SPKI) 指纹（完整值，不截断） */
  fingerprint: string;
  algorithm: 'SM2';
  createdAt: string;
  note?: string;
}

export interface RecipientKeyStore {
  version: 1;
  keys: RecipientKey[];
}

export type RecipientKeyErrorCode =
  | 'E_KEY_TEXT_EMPTY'
  | 'E_KEY_BASE64_INVALID'
  | 'E_KEY_SPKI_INVALID'
  | 'E_KEY_NOT_ON_CURVE'
  | 'E_KEY_DUPLICATE'
  | 'E_KEY_NOT_FOUND'
  | 'E_KEY_LABEL_EMPTY';

export type ParseResult =
  | { ok: true; publicKey: Sm2Point; spkiBase64: string; fingerprint: string }
  | { ok: false; code: RecipientKeyErrorCode; reason: string };

const PEM_BEGIN = '-----BEGIN PUBLIC KEY-----';
const PEM_END = '-----END PUBLIC KEY-----';

/**
 * 解析一段公钥文本：接受 PEM（含头尾与换行）、纯 base64、以及带空格/换行的 base64。
 * 解析成功后必须通过"点在曲线上"的校验才算数。
  */
export function parseRecipientPublicKey(text: string): ParseResult {
  const trimmed = (text ?? '').trim();
  if (trimmed === '') return { ok: false, code: 'E_KEY_TEXT_EMPTY', reason: '公钥文本为空' };

  const body = trimmed
    .replace(PEM_BEGIN, '')
    .replace(PEM_END, '')
    .replace(/\s+/g, '');
  if (body === '') return { ok: false, code: 'E_KEY_TEXT_EMPTY', reason: '去掉 PEM 头尾后没有内容' };
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(body) || body.length % 4 !== 0) {
    return {
      ok: false,
      code: 'E_KEY_BASE64_INVALID',
      reason: '不是合法的 base64：请检查是否混入了非 base64 字符（例如把整段 PEM 连注释一起贴进来）',
    };
  }

  let der: Uint8Array;
  try {
    der = new Uint8Array(Buffer.from(body, 'base64'));
  } catch (err) {
    return { ok: false, code: 'E_KEY_BASE64_INVALID', reason: `base64 解码失败：${(err as Error).message}` };
  }

  const parsedSpki = parseSm2Spki(der);
  if (!parsedSpki.ok) {
    /* 两种失败必须分开报：结构问题（传错/截断）与"点不在曲线上"（数据被改动）处置完全不同 */
    if (parsedSpki.code === 'E_SPKI_NOT_ON_CURVE') {
      return {
        ok: false,
        code: 'E_KEY_NOT_ON_CURVE',
        reason: '公钥点不在 SM2 曲线上：用它加密会产出一份**没有任何私钥能解开**的密文，因此拒绝导入',
      };
    }
    return {
      ok: false,
      code: 'E_KEY_SPKI_INVALID',
      reason: `${parsedSpki.reason}（本系统只接受 SM2 公钥的 SPKI 结构）`,
    };
  }
  const publicKey = parsedSpki.publicKey;
  /* 这里再确认一次"点在曲线上"不是多余：解析层已经保证，但加密交付是不可逆的动作，
     宁可多花一次模运算，也不要拿一把来历不明的钥匙去加密。  */
  if (!isOnCurve(publicKey)) {
    return { ok: false, code: 'E_KEY_NOT_ON_CURVE', reason: '公钥点不在 SM2 曲线上，拒绝导入' };
  }

  const spkiBase64 = Buffer.from(publicKeyToSpki(publicKey)).toString('base64');
  return { ok: true, publicKey, spkiBase64, fingerprint: publicKeyFingerprint(publicKey) };
}

/** 导出为可线下交换的文本（PEM 或纯 base64） */
export function exportRecipientPublicKey(spkiBase64: string, format: 'pem' | 'base64' = 'pem'): string {
  if (format === 'base64') return spkiBase64;
  const wrapped = spkiBase64.replace(/(.{64})/g, '$1\n').trim();
  return `${PEM_BEGIN}\n${wrapped}\n${PEM_END}\n`;
}

/** 由目录条目取回公钥点（供加密交付使用） */
export function publicKeyOf(key: RecipientKey): Sm2Point {
  const parsed = publicKeyFromSpki(new Uint8Array(Buffer.from(key.spkiBase64, 'base64')));
  if (publicKeyFingerprint(parsed) !== key.fingerprint) {
    /* 条目被改过（指纹与公钥对不上）→ 宁可报错也不要拿一把来历不明的钥匙去加密 */
    throw new Error(`接收方公钥条目 ${key.keyId} 已被篡改：指纹与公钥不匹配`);
  }
  return parsed;
}

export const EMPTY_KEY_STORE: RecipientKeyStore = { version: 1, keys: [] };

export function addRecipientKey(
  store: RecipientKeyStore,
  input: { label: string; text: string; note?: string; now: string },
): { ok: true; key: RecipientKey; store: RecipientKeyStore } | { ok: false; code: RecipientKeyErrorCode; reason: string } {
  const label = (input.label ?? '').trim();
  if (label === '') return { ok: false, code: 'E_KEY_LABEL_EMPTY', reason: '接收方标签不能为空（标签是给人看的选择依据）' };

  const parsed = parseRecipientPublicKey(input.text);
  if (!parsed.ok) return parsed;

  if (store.keys.some((key) => key.fingerprint === parsed.fingerprint)) {
    return {
      ok: false,
      code: 'E_KEY_DUPLICATE',
      reason: `这把公钥已在目录里（指纹 ${parsed.fingerprint}）：重复条目会让"选哪一行"随列表顺序变化，因此拒绝`,
    };
  }

  const key: RecipientKey = {
    keyId: `rk_${store.keys.length + 1}_${parsed.fingerprint.slice(0, 8)}`,
    label,
    spkiBase64: parsed.spkiBase64,
    fingerprint: parsed.fingerprint,
    algorithm: 'SM2',
    createdAt: input.now,
    ...(input.note ? { note: input.note } : {}),
  };
  return { ok: true, key, store: { version: 1, keys: [...store.keys, key] } };
}

export function removeRecipientKey(
  store: RecipientKeyStore,
  keyId: string,
): { ok: boolean; store: RecipientKeyStore; reason?: string } {
  if (!store.keys.some((key) => key.keyId === keyId)) {
    return { ok: false, store, reason: `目录里没有这个接收方：${keyId}` };
  }
  return { ok: true, store: { version: 1, keys: store.keys.filter((key) => key.keyId !== keyId) } };
}

export function findRecipientKey(store: RecipientKeyStore, keyId: string): RecipientKey | undefined {
  return store.keys.find((key) => key.keyId === keyId);
}

/** 目录落盘为明文 JSON：里面只有公钥（公钥本就可公开），私钥从不进入本文件  */
export function saveRecipientKeys(path: string, store: RecipientKeyStore): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
}

export function loadRecipientKeys(path: string): RecipientKeyStore {
  /* 文件不存在是正常状态（首次使用）；其余错误必须显式抛出 ——
     静默返回空目录会让"我导入的接收方不见了"变成无从排查的问题。  */
  if (!existsSync(path)) return EMPTY_KEY_STORE;
  const text = readFileSync(path, 'utf8');
  let parsed: RecipientKeyStore;
  try {
    parsed = JSON.parse(text) as RecipientKeyStore;
  } catch (err) {
    throw new Error(`接收方公钥目录无法解析（${path}）：${(err as Error).message}`);
  }
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.keys)) {
    throw new Error(`接收方公钥目录结构不符（${path}）：应为 { version: 1, keys: [...] }`);
  }
  return parsed;
}
