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
  label: string;
  spkiBase64: string;
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
  if (!isOnCurve(publicKey)) {
    return { ok: false, code: 'E_KEY_NOT_ON_CURVE', reason: '公钥点不在 SM2 曲线上，拒绝导入' };
  }

  const spkiBase64 = Buffer.from(publicKeyToSpki(publicKey)).toString('base64');
  return { ok: true, publicKey, spkiBase64, fingerprint: publicKeyFingerprint(publicKey) };
}

export function exportRecipientPublicKey(spkiBase64: string, format: 'pem' | 'base64' = 'pem'): string {
  if (format === 'base64') return spkiBase64;
  const wrapped = spkiBase64.replace(/(.{64})/g, '$1\n').trim();
  return `${PEM_BEGIN}\n${wrapped}\n${PEM_END}\n`;
}

export function publicKeyOf(key: RecipientKey): Sm2Point {
  const parsed = publicKeyFromSpki(new Uint8Array(Buffer.from(key.spkiBase64, 'base64')));
  if (publicKeyFingerprint(parsed) !== key.fingerprint) {
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

export function saveRecipientKeys(path: string, store: RecipientKeyStore): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
}

export function loadRecipientKeys(path: string): RecipientKeyStore {
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
