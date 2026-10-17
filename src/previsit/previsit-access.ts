/**
 * 预问诊接入凭据（机对机）。
 *
 * ## 为什么只存哈希，不加密存原文
 *
 * 采集 / 模型 / 落位那几项要**取出来用**（带着它去呼外部服务），所以加密存、用的时候解密。
 * 这一项只做一件事：把我们收到的请求头与它**比对**。既然永远不需要取回原文，就只存哈希 ——
 * 连管理员也看不到明文，"谁能把密钥抄走"这条路径直接不存在。
 *
 * ## 为什么用 sha256 而不是 scrypt
 *
 * scrypt 的代价是为"人记的口令"设计的：短、可猜、值得拖慢穷举。机对机密钥是随机串，
 * 穷举不成立；慢哈希只会让每次写入多花上百毫秒。盐仍然要（防两份部署用同一个密钥时哈希相同）。
 *
 * ## 三种状态必须分清
 *
 *   - **从没配过**（`null`）：这是"还没上锁"，不是"锁坏了"。演示模式放行（并如实标注），
 *     严格模式拒绝 —— 与系统里 `authMode` 的两档是同一把尺子。
 *   - **已关闭校验**（`enabled: false`）：管理员显式选择的"不上锁"，放行。
 *   - **已启用**（`enabled: true` + 有密钥）：必须带对，否则拒绝。
 *     启用但密钥为空是**配置不完整**，一律拒绝 —— 不能"没密钥就当没启用"，那等于把门开着还挂个锁。
 */

import nodeCrypto from 'node:crypto';
import { CONFIG_KEY_PREFIX, type ConfigKv } from '../storage/config-kv.ts';

export const PREVISIT_ACCESS_KEY = `${CONFIG_KEY_PREFIX}previsit`;

/** 请求头名称（外部系统按这个带密钥） */
export const PREVISIT_KEY_HEADER = 'x-previsit-key';

const HASH_SCHEME = 'sha256';
const SALT_BYTES = 16;

/**
 * 密钥长度下限。
 *
 * 24 个字符是"至少能装下 128 位随机数的 base64"的量级；短的、像人名的、像 `his123456`
 * 的字符串在这个位置上是常态，而它一旦被猜中，就等于任何人都能往任意患者名下写预问诊。
 */
export const MIN_KEY_LENGTH = 24;
/** 上限只为挡住"误粘贴一整篇文档"，不是安全边界 */
export const MAX_KEY_LENGTH = 512;

export interface PrevisitAccessRecord {
  version: 1;
  /** 是否要求带密钥 */
  enabled: boolean;
  /** `sha256$<salt-b64>$<hash-b64>`；`null` = 没有密钥 */
  keyHash: string | null;
  updatedAt: string;
  updatedBy: string;
}

export interface PrevisitAccessView {
  enabled: boolean;
  /** 密钥是否就位（界面只报这个，**不回显值**） */
  keyPresent: boolean;
  /** 真正生效 = 已启用且密钥就位 */
  effective: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
  /** 给界面的一句实话：现在到底是什么状态、谁会写不进来 */
  note: string;
}

/* ------------------------------- 哈希与校验 ------------------------------- */

export function hashAccessKey(key: string): string {
  const salt = nodeCrypto.randomBytes(SALT_BYTES);
  const digest = nodeCrypto.createHash(HASH_SCHEME).update(salt).update(key, 'utf8').digest();
  return `${HASH_SCHEME}$${salt.toString('base64')}$${digest.toString('base64')}`;
}

/**
 * 比对密钥。
 *
 * 用 `timingSafeEqual`：按字节提前返回的写法会泄漏"前几位对了"，
 * 而这里唯一的秘密就是一串随机字符，慢慢试出来是有意义的攻击。
 */
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

/** 校验一个准备保存的密钥：不合格就明说哪里不合格，不做"帮你改一改" */
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

/* --------------------------------- 读写配置 --------------------------------- */

export function loadAccess(kv: ConfigKv): PrevisitAccessRecord | null {
  return kv.read<PrevisitAccessRecord>(PREVISIT_ACCESS_KEY);
}

/**
 * 给界面的视图。
 *
 * `authMode` 只影响"从没配过"这一种状态的措辞：演示模式下它放行，必须说出来 ——
 * 界面上一句"未配置"，很容易被读成"已经安全了"。
 */
export function describeAccess(record: PrevisitAccessRecord | null, authMode: string): PrevisitAccessView {
  const keyPresent = typeof record?.keyHash === 'string' && record.keyHash !== '';
  const enabled = record?.enabled === true;
  const effective = enabled && keyPresent;
  let note: string;
  if (record === null) {
    /* 演示模式不给提示语：界面上那一格留给"配置本身是什么状态"，徽标已写明"未校验"。
       严格模式仍然要说一句 —— 那里不是提醒，是"现在写不进来、先配密钥"。 */
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
  /** 不给 = 不改 */
  enabled?: boolean;
  /** 三态：不给 = 不改 / `null` = 清除 / 字符串 = 设新值 */
  key?: string | null;
}

export interface SaveAccessResult {
  record: PrevisitAccessRecord;
  keyAction: KeyAction;
}

/**
 * 保存配置。
 *
 * 密钥三态与采集配置同一套（不传 / null / 字符串）：按钮就在旁边，语义含糊一次的代价是
 * "想清除却把上次那个密钥又存了一遍"，而界面上看起来是成功的。
 */
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
    /* 没给就沿用原值；从没配过时默认 **false**（关闭）。
       为什么不默认 true：默认 true 且没有密钥 = 配置不完整 = 写入全被拒，
       装完就"什么都写不进来"，而现场只会看到"接口坏了"。 */
    enabled: patch.enabled ?? previous?.enabled ?? false,
    keyHash,
    updatedAt: now,
    updatedBy: by,
  };
  kv.write(PREVISIT_ACCESS_KEY, record);
  return { record, keyAction };
}

/* --------------------------------- 准入判定 --------------------------------- */

export type AccessMode = 'key' | 'off' | 'unconfigured-demo';

export type AccessCheck = { ok: true; mode: AccessMode } | { ok: false; code: string; message: string };

/**
 * 判定一次写入能不能进来。
 *
 * `allowUnconfigured` 对应演示模式：**只对"从没配过"放行**，对"已启用但没密钥"仍然拒绝 ——
 * 后者是配置错误，不是"还没上锁"。
 */
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
