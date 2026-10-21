import { CONFIG_KEY_PREFIX, type ConfigKv } from './config-kv.ts';
import { CONTEXT_FIELDS } from '../template/engine.ts';

export const CONTEXT_FIELD_CONFIG_KEY = `${CONFIG_KEY_PREFIX}context-fields`;

export interface ContextFieldItem {
  path: string;
  label: string;
  group: string;
  /** 这个字段来自哪个系统（HIS / LIS / 本机…）。仅是标记，决定界面上怎么分组展示 */
  source: string;
  enabled: boolean;
}

export interface LoadedContextFields {
  items: ContextFieldItem[];
  source: 'store' | 'builtin';
  updatedAt?: string;
  updatedBy?: string;
}

export type ContextFieldErrorCode = 'E_CONTEXT_FIELD_INVALID';

export class ContextFieldError extends Error {
  code: ContextFieldErrorCode;

  constructor(code: ContextFieldErrorCode, message: string) {
    super(message);
    this.name = 'ContextFieldError';
    this.code = code;
  }
}

interface StoredContextFields {
  version: 1;
  items: ContextFieldItem[];
  updatedAt: string;
  updatedBy: string;
}

const PATH_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*(\.[A-Za-z0-9_-]+)*$/;

export const BUILTIN_CONTEXT_FIELDS: ContextFieldItem[] = CONTEXT_FIELDS.map((field) => ({
  path: field.path,
  label: field.label,
  group: field.group,
  source: '本机',
  enabled: true,
}));

export function validateContextFieldItems(raw: unknown): ContextFieldItem[] {
  if (!Array.isArray(raw)) {
    throw new ContextFieldError('E_CONTEXT_FIELD_INVALID', '字段清单必须是数组');
  }
  const items: ContextFieldItem[] = [];
  const seen = new Set<string>();
  raw.forEach((entry, index) => {
    const position = `第 ${index + 1} 项`;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new ContextFieldError('E_CONTEXT_FIELD_INVALID', `${position}不是一个字段对象`);
    }
    const record = entry as Record<string, unknown>;
    const path = typeof record.path === 'string' ? record.path.trim() : '';
    const label = typeof record.label === 'string' ? record.label.trim() : '';
    const group = typeof record.group === 'string' ? record.group.trim() : '';
    const source = typeof record.source === 'string' ? record.source.trim() : '';
    if (path === '') {
      throw new ContextFieldError('E_CONTEXT_FIELD_INVALID', `${position}缺取值路径（模板的「从系统带入」认的就是它）`);
    }
    if (!PATH_PATTERN.test(path)) {
      throw new ContextFieldError(
        'E_CONTEXT_FIELD_INVALID',
        `${position}的路径「${path}」不合法：只允许字母开头的点分路径，如 patient.nameMasked`,
      );
    }
    if (seen.has(path)) {
      throw new ContextFieldError('E_CONTEXT_FIELD_INVALID', `路径「${path}」出现了两次：同步程序按它对位，重名会写到同一格`);
    }
    seen.add(path);
    if (label === '') throw new ContextFieldError('E_CONTEXT_FIELD_INVALID', `${position}（${path}）缺显示名`);
    if (source === '') throw new ContextFieldError('E_CONTEXT_FIELD_INVALID', `${position}（${path}）缺来源系统`);
    if (record.enabled !== undefined && typeof record.enabled !== 'boolean') {
      throw new ContextFieldError('E_CONTEXT_FIELD_INVALID', `${position}（${path}）的启用状态只能是 true / false`);
    }
    items.push({ path, label, group, source, enabled: record.enabled !== false });
  });
  return items;
}

function readStored(kv: ConfigKv): StoredContextFields | null {
  const parsed = ((): StoredContextFields | null => {
    try {
      return kv.read<StoredContextFields>(CONTEXT_FIELD_CONFIG_KEY);
    } catch (err) {
      throw new ContextFieldError(
        'E_CONTEXT_FIELD_INVALID',
        `字段字典读不出来，拒绝按"没配过"继续：${(err as Error).message}`,
      );
    }
  })();
  if (parsed === null) return null;
  if (parsed?.version !== 1) return null;
  return parsed;
}

export function loadContextFields(kv: ConfigKv): LoadedContextFields {
  const stored = readStored(kv);
  if (!stored) return { items: BUILTIN_CONTEXT_FIELDS.map((item) => ({ ...item })), source: 'builtin' };
  return {
    items: validateContextFieldItems(stored.items),
    source: 'store',
    updatedAt: stored.updatedAt,
    updatedBy: stored.updatedBy,
  };
}

export function saveContextFields(
  kv: ConfigKv,
  rawItems: unknown,
  by: string,
  options: { at?: string } = {},
): LoadedContextFields {
  const items = validateContextFieldItems(rawItems);
  const stored: StoredContextFields = {
    version: 1,
    items,
    updatedAt: options.at ?? new Date().toISOString(),
    updatedBy: by,
  };
  kv.write(CONTEXT_FIELD_CONFIG_KEY, stored);
  return loadContextFields(kv);
}

export function describeContextFields(loaded: LoadedContextFields): Record<string, unknown> {
  return {
    items: loaded.items,
    source: loaded.source,
    enabledCount: loaded.items.filter((item) => item.enabled).length,
    sources: [...new Set(loaded.items.map((item) => item.source))],
    updatedAt: loaded.updatedAt ?? null,
    updatedBy: loaded.updatedBy ?? null,
  };
}
