import { CONFIG_KEY_PREFIX, type ConfigKv } from './config-kv.ts';
import { hashAccessKey, validateAccessKey, verifyAccessKey } from '../previsit/previsit-access.ts';

export const INTAKE_CONFIG_KEY = `${CONFIG_KEY_PREFIX}intake`;

export const INTAKE_KEY_HEADER = 'x-intake-key';

export interface IntakeTemplateRef {
  packId: string;
  itemId: string;
}

export interface IntakeConfigRecord {
  version: 1;
  /** 外部写入总开关：关掉时接口一律拒（不是"没配过"） */
  enabled: boolean;
  /** 是否要求 X-Intake-Key；开着但没密钥 = 一律拒 */
  requireKey: boolean;
  keyHash: string | null;
  /** 允许外部写入的模板白名单（由模板抽屉里的勾选决定） */
  templates: IntakeTemplateRef[];
  updatedAt: string;
  updatedBy: string;
}

export type IntakeErrorCode = 'E_INTAKE_INVALID';

export class IntakeError extends Error {
  code: IntakeErrorCode;

  constructor(code: IntakeErrorCode, message: string) {
    super(message);
    this.name = 'IntakeError';
    this.code = code;
  }
}

export function templateRefKey(ref: Pick<IntakeTemplateRef, 'packId' | 'itemId'>): string {
  return `${ref.packId}#${ref.itemId}`;
}

function validateTemplates(raw: unknown): IntakeTemplateRef[] {
  if (!Array.isArray(raw)) throw new IntakeError('E_INTAKE_INVALID', '模板白名单必须是数组');
  const items: IntakeTemplateRef[] = [];
  const seen = new Set<string>();
  raw.forEach((entry, index) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new IntakeError('E_INTAKE_INVALID', `白名单第 ${index + 1} 项不是一个模板引用`);
    }
    const record = entry as Record<string, unknown>;
    const packId = typeof record.packId === 'string' ? record.packId.trim() : '';
    const itemId = typeof record.itemId === 'string' ? record.itemId.trim() : '';
    if (packId === '' || itemId === '') {
      throw new IntakeError('E_INTAKE_INVALID', `白名单第 ${index + 1} 项缺 packId 或 itemId`);
    }
    const key = templateRefKey({ packId, itemId });
    if (seen.has(key)) return;
    seen.add(key);
    items.push({ packId, itemId });
  });
  return items;
}

export function loadIntakeConfig(kv: ConfigKv): IntakeConfigRecord | null {
  const record = kv.read<IntakeConfigRecord>(INTAKE_CONFIG_KEY);
  if (record === null || record === undefined) return null;
  if (record.version !== 1) return null;
  return { ...record, templates: validateTemplates(record.templates) };
}

export interface IntakePatch {
  enabled?: boolean;
  requireKey?: boolean;
  key?: string | null;
  templates?: unknown;
}

export type IntakeKeyAction = 'set' | 'cleared' | 'unchanged';

export function saveIntakeConfig(
  kv: ConfigKv,
  patch: IntakePatch,
  by: string,
  now: string,
): { record: IntakeConfigRecord; keyAction: IntakeKeyAction } {
  const previous = loadIntakeConfig(kv);
  let keyHash = previous?.keyHash ?? null;
  let keyAction: IntakeKeyAction = 'unchanged';

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

  const record: IntakeConfigRecord = {
    version: 1,
    enabled: patch.enabled ?? previous?.enabled ?? false,
    requireKey: patch.requireKey ?? previous?.requireKey ?? true,
    keyHash,
    templates: patch.templates === undefined
      ? (previous?.templates ?? [])
      : validateTemplates(patch.templates),
    updatedAt: now,
    updatedBy: by,
  };
  kv.write(INTAKE_CONFIG_KEY, record);
  return { record, keyAction };
}

export function describeIntake(record: IntakeConfigRecord | null): Record<string, unknown> {
  const keyPresent = typeof record?.keyHash === 'string' && record.keyHash !== '';
  const enabled = record?.enabled === true;
  const requireKey = record?.requireKey !== false;
  let note = '';
  if (record === null) note = '未配置：写入接口一律拒绝';
  else if (!enabled) note = '已关闭：写入接口一律拒绝';
  else if (requireKey && !keyPresent) note = '已开启但没设密钥：写入一律拒绝';
  else if (requireKey) note = `已开启：写入必须带请求头 ${INTAKE_KEY_HEADER}`;
  else note = '已开启且不校验密钥：任何能访问本端口的人都能写入';
  return {
    enabled,
    requireKey,
    keyPresent,
    keyHeader: INTAKE_KEY_HEADER,
    templates: record?.templates ?? [],
    note,
    updatedAt: record?.updatedAt ?? null,
    updatedBy: record?.updatedBy ?? null,
  };
}

export type IntakeAccessCheck =
  | { ok: true; mode: 'key' | 'open' }
  | { ok: false; code: string; message: string };

export function checkIntakeAccess(record: IntakeConfigRecord | null, presentedKey: string): IntakeAccessCheck {
  if (record === null || record.enabled !== true) {
    return { ok: false, code: 'E_INTAKE_DISABLED', message: '外部带入没有开启：先由管理员在「能力配置 · 数据采集」里启用' };
  }
  if (record.requireKey === false) return { ok: true, mode: 'open' };
  const keyHash = record.keyHash;
  if (typeof keyHash !== 'string' || keyHash === '') {
    return { ok: false, code: 'E_INTAKE_KEY_MISSING', message: '已要求校验但密钥为空：配置不完整，写入一律拒绝' };
  }
  if (presentedKey === '') {
    return { ok: false, code: 'E_INTAKE_KEY_REQUIRED', message: `缺少接入口令：请求头 ${INTAKE_KEY_HEADER} 必填` };
  }
  if (!verifyAccessKey(presentedKey, keyHash)) {
    return { ok: false, code: 'E_INTAKE_KEY_BAD', message: `接入口令不对：请求头 ${INTAKE_KEY_HEADER} 与已配置的不一致` };
  }
  return { ok: true, mode: 'key' };
}
