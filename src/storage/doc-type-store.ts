import { CONFIG_KEY_PREFIX, type ConfigKv } from './config-kv.ts';

export const DOC_TYPE_CONFIG_KEY = `${CONFIG_KEY_PREFIX}doc-types`;

export const DOC_TYPE_SYSTEMS = ['WST500', 'WS445', 'local', 'custom'] as const;
export type DocTypeSystem = (typeof DOC_TYPE_SYSTEMS)[number];

export interface DocTypeItem {
  system: DocTypeSystem;
  code: string;
  display: string;
  enabled: boolean;
}

export interface LoadedDocTypes {
  items: DocTypeItem[];
  /** `empty` = 库里一个类型都没有（空就是空，不替你编一套默认类型）  */
  source: 'store' | 'empty';
  updatedAt?: string;
  updatedBy?: string;
}

export type DocTypeErrorCode = 'E_DOC_TYPE_INVALID';

export class DocTypeError extends Error {
  code: DocTypeErrorCode;

  constructor(code: DocTypeErrorCode, message: string) {
    super(message);
    this.name = 'DocTypeError';
    this.code = code;
  }
}

interface StoredDocTypes {
  version: 1;
  items: DocTypeItem[];
  updatedAt: string;
  updatedBy: string;
}

export function docTypeKeyOf(item: Pick<DocTypeItem, 'system' | 'code'>): string {
  return `${item.system}/${item.code}`;
}

function isSystem(value: unknown): value is DocTypeSystem {
  return typeof value === 'string' && (DOC_TYPE_SYSTEMS as readonly string[]).includes(value);
}

export function validateDocTypeItems(raw: unknown): DocTypeItem[] {
  if (!Array.isArray(raw)) {
    throw new DocTypeError('E_DOC_TYPE_INVALID', '文书类型清单必须是数组');
  }
  const items: DocTypeItem[] = [];
  const seen = new Set<string>();
  raw.forEach((entry, index) => {
    const position = `第 ${index + 1} 项`;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new DocTypeError('E_DOC_TYPE_INVALID', `${position}不是一个文书类型对象`);
    }
    const record = entry as Record<string, unknown>;
    const code = typeof record.code === 'string' ? record.code.trim() : '';
    const display = typeof record.display === 'string' ? record.display.trim() : '';
    const system = record.system === undefined ? 'local' : record.system;
    if (!isSystem(system)) {
      throw new DocTypeError(
        'E_DOC_TYPE_INVALID',
        `${position}的体系「${String(system)}」不认识（只认 ${DOC_TYPE_SYSTEMS.join(' / ')}；这些取值与文档模型的 docType.system 是同一套）`,
      );
    }
    if (code === '') throw new DocTypeError('E_DOC_TYPE_INVALID', `${position}缺类型编码（质控规则按它定位文书，不能空）`);
    if (display === '') throw new DocTypeError('E_DOC_TYPE_INVALID', `${position}（${code}）缺显示名（人在界面上看到的是它）`);
    const key = docTypeKeyOf({ system, code });
    if (seen.has(key)) {
      throw new DocTypeError(
        'E_DOC_TYPE_INVALID',
        `文书类型「${key}」出现了两次：键重复时"这条规则盯的是哪一类文书"就没有确定答案（同一编码在不同体系下可以并存，所以只查同一体系内的重复）`,
      );
    }
    seen.add(key);
    if (record.enabled !== undefined && typeof record.enabled !== 'boolean') {
      throw new DocTypeError('E_DOC_TYPE_INVALID', `${position}（${key}）的启用状态只能是 true / false`);
    }
    items.push({ system, code, display, enabled: record.enabled !== false });
  });
  return items;
}

function readStored(kv: ConfigKv): StoredDocTypes | null {
  const parsed = ((): StoredDocTypes | null => {
    try {
      return kv.read<StoredDocTypes>(DOC_TYPE_CONFIG_KEY);
    } catch (err) {
      throw new DocTypeError(
        'E_DOC_TYPE_INVALID',
        `文书类型读不出来，拒绝按"没配过"继续（那会让规则里的类型码变成没人认得的串）：${(err as Error).message}`,
      );
    }
  })();
  if (parsed === null) return null;
  if (parsed?.version !== 1) return null;
  return parsed;
}

export function loadDocTypes(kv: ConfigKv): LoadedDocTypes {
  const stored = readStored(kv);
  if (!stored) return { items: [], source: 'empty' };
  return {
    items: validateDocTypeItems(stored.items),
    source: 'store',
    updatedAt: stored.updatedAt,
    updatedBy: stored.updatedBy,
  };
}

export function saveDocTypes(
  kv: ConfigKv,
  rawItems: unknown,
  by: string,
  options: { at?: string } = {},
): LoadedDocTypes {
  const items = validateDocTypeItems(rawItems);
  const stored: StoredDocTypes = {
    version: 1,
    items,
    updatedAt: options.at ?? new Date().toISOString(),
    updatedBy: by,
  };
  kv.write(DOC_TYPE_CONFIG_KEY, stored);
  return loadDocTypes(kv);
}

export const DOC_TYPE_SEED_KEY = `${CONFIG_KEY_PREFIX}doc-types-seeded`;

export function docTypesSeeded(kv: ConfigKv): boolean {
  return kv.read<boolean>(DOC_TYPE_SEED_KEY) === true;
}

export function markDocTypesSeeded(kv: ConfigKv): void {
  kv.write(DOC_TYPE_SEED_KEY, true);
}

export function describeDocTypes(loaded: LoadedDocTypes): Record<string, unknown> {
  return {
    items: loaded.items,
    source: loaded.source,
    enabledCount: loaded.items.filter((item) => item.enabled).length,
    systems: [...DOC_TYPE_SYSTEMS],
    updatedAt: loaded.updatedAt ?? null,
    updatedBy: loaded.updatedBy ?? null,
  };
}

export function isDocTypeSelectable(loaded: LoadedDocTypes, system: string, code: string): boolean {
  const item = loaded.items.find((entry) => entry.system === system && entry.code === code);
  return Boolean(item && item.enabled);
}

export function docTypeDisplayOf(loaded: LoadedDocTypes, system: string | undefined, code: string | undefined): string | undefined {
  if (!system || !code) return undefined;
  return loaded.items.find((entry) => entry.system === system && entry.code === code)?.display;
}
