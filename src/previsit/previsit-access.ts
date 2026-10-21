import nodeCrypto from 'node:crypto';
import { CONFIG_KEY_PREFIX, type ConfigKv } from '../storage/config-kv.ts';

export const PREVISIT_ACCESS_KEY = `${CONFIG_KEY_PREFIX}previsit`;

export const PREVISIT_KEY_HEADER = 'x-previsit-key';

const HASH_SCHEME = 'sha256';
const SALT_BYTES = 16;

export const MIN_KEY_LENGTH = 24;
/** 上限只为挡住"误粘贴一整篇文档"，不是安全边界 */
export const MAX_KEY_LENGTH = 512;

export interface PrevisitAccessRecord {
  version: 1;
  enabled: boolean;
  keyHash: string | null;
  updatedAt: string;
  updatedBy: string;
}

export interface PrevisitAccessView {
  enabled: boolean;
  keyPresent: boolean;
  effective: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
  note: string;
}

export function hashAccessKey(key: string): string {
  const salt = nodeCrypto.randomBytes(SALT_BYTES);
  const digest = nodeCrypto.createHash(HASH_SCHEME).update(salt).update(key, 'utf8').digest();
  return `${HASH_SCHEME}$${salt.toString('base64')}$${digest.toString('base64')}`;
}

export function verifyAccessKey(key: string, encoded: string): boolean {
  const parts = String(encoded ?? '').split('$');
  if (parts.length !== 3 || parts[0] !== HASH_SCHEME) return false;
  const salt = Buffer.from(parts[1] ?? '', 'base64');
  const expected = Buffer.from(parts[2] ?? '', 'base64');
  if (salt.length === 0 || expected.length === 0) return false;
  const actual = nodeCrypto.createHash(HASH_SCHEME).update(salt).update(key, 'utf8').digest();
  return actual.length === expected.length && nodeCrypto.timingSafeEqual(actual, expected);
}

export type KeyValidation = { ok: true; key: string } | { ok: false; code: string; message: string };

export function validateAccessKey(raw: unknown): KeyValidation {
  const key = typeof raw === 'string' ? raw : '';
  if (key.length < MIN_KEY_LENGTH) {
    return {
      ok: false,
      code: 'E_PREVISIT_KEY_TOO_SHORT',
      message: `接入密钥至少 ${MIN_KEY_LENGTH} 个字符（现在 ${key.length} 个）：这里要的是随机串，不是人记的口令`,
    };
  }
  if (key.length > MAX_KEY_LENGTH) {
    return { ok: false, code: 'E_PREVISIT_KEY_TOO_LONG', message: `接入密钥最多 ${MAX_KEY_LENGTH} 个字符（现在 ${key.length} 个），像是误粘贴了别的内容` };
  }
  if (/\s/.test(key)) {
    return { ok: false, code: 'E_PREVISIT_KEY_BAD_CHARS', message: '接入密钥不能包含空白字符（请求头里会被截断，双方都看不出原因）' };
  }
  return { ok: true, key };
}

export function loadAccess(kv: ConfigKv): PrevisitAccessRecord | null {
  return kv.read<PrevisitAccessRecord>(PREVISIT_ACCESS_KEY);
}

export function describeAccess(record: PrevisitAccessRecord | null, authMode: string): PrevisitAccessView {
  const keyPresent = typeof record?.keyHash === 'string' && record.keyHash !== '';
  const enabled = record?.enabled === true;
  const effective = enabled && keyPresent;
  let note: string;
  if (record === null) {
    note = authMode === 'strict'
      ? '未配置：严格模式下写入一律被拒（先在这里设置密钥，或显式关闭校验）'
      : '';
  } else if (enabled && !keyPresent) {
    note = '配置不完整：已要求校验但密钥为空 —— 写入一律被拒（这不是"没启用"，是把门开着还挂着锁）';
  } else if (enabled) {
    note = '已启用：写入必须带请求头 X-Previsit-Key，对不上的一律拒绝';
  } else {
    note = '已关闭校验：任何能访问本端口的人都能写入（管理员显式选择的状态）';
  }
  return {
    enabled,
    keyPresent,
    effective,
    updatedAt: record?.updatedAt ?? null,
    updatedBy: record?.updatedBy ?? null,
    note,
  };
}

export type KeyAction = 'set' | 'cleared' | 'unchanged';

export interface AccessPatch {
  enabled?: boolean;
  key?: string | null;
}

export interface SaveAccessResult {
  record: PrevisitAccessRecord;
  keyAction: KeyAction;
}

export function saveAccess(
  kv: ConfigKv,
  patch: AccessPatch,
  by: string,
  now: string,
): SaveAccessResult {
  const previous = loadAccess(kv);
  let keyHash = previous?.keyHash ?? null;
  let keyAction: KeyAction = 'unchanged';

  if (patch.key === null) {
    if (keyHash !== null) keyAction = 'cleared';
    keyHash = null;
  } else if (patch.key !== undefined) {
    const checked = validateAccessKey(patch.key);
    if (!checked.ok) {
      const error = new Error(checked.message) as Error & { code?: string };
      error.code = checked.code;
      throw error;
    }
    keyHash = hashAccessKey(checked.key);
    keyAction = 'set';
  }

  const record: PrevisitAccessRecord = {
    version: 1,
    enabled: patch.enabled ?? previous?.enabled ?? false,
    keyHash,
    updatedAt: now,
    updatedBy: by,
  };
  kv.write(PREVISIT_ACCESS_KEY, record);
  return { record, keyAction };
}

export type AccessMode = 'key' | 'off' | 'unconfigured-demo';

export type AccessCheck = { ok: true; mode: AccessMode } | { ok: false; code: string; message: string };

export function checkAccess(input: {
  record: PrevisitAccessRecord | null;
  presentedKey: string;
  allowUnconfigured: boolean;
}): AccessCheck {
  const { record, presentedKey, allowUnconfigured } = input;
  if (record === null) {
    if (allowUnconfigured) return { ok: true, mode: 'unconfigured-demo' };
    return {
      ok: false,
      code: 'E_PREVISIT_AUTH_UNCONFIGURED',
      message: '预问诊接入还没有配置：严格模式下必须先设置接入密钥（或显式关闭校验），写入才会被接受',
    };
  }
  if (record.enabled !== true) return { ok: true, mode: 'off' };

  const keyHash = record.keyHash;
  const keyPresent = typeof keyHash === 'string' && keyHash !== '';
  if (!keyPresent) {
    return {
      ok: false,
      code: 'E_PREVISIT_AUTH_UNCONFIGURED',
      message: '预问诊接入已要求校验，但密钥为空：配置不完整，写入一律拒绝',
    };
  }
  if (presentedKey === '') {
    return {
      ok: false,
      code: 'E_PREVISIT_AUTH_REQUIRED',
      message: '缺少接入口令：请求头 X-Previsit-Key 必填（本接口已启用校验）',
    };
  }
  if (!verifyAccessKey(presentedKey, keyHash)) {
    return {
      ok: false,
      code: 'E_PREVISIT_AUTH_BAD_KEY',
      message: '接入口令不对：请求头 X-Previsit-Key 与已配置的不一致',
    };
  }
  return { ok: true, mode: 'key' };
}
