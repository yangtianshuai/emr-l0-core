import { CONFIG_KEY_PREFIX, type ConfigKv } from './config-kv.ts';

export const DEPARTMENT_CONFIG_KEY = `${CONFIG_KEY_PREFIX}departments`;

export interface DepartmentItem {
  code: string;
  name: string;
  enabled: boolean;
}

export interface LoadedDepartments {
  items: DepartmentItem[];
  /** `empty` = 库里一个科室都没有（空就是空，不替你编一套默认科室）  */
  source: 'store' | 'empty';
  updatedAt?: string;
  updatedBy?: string;
}

export type DepartmentErrorCode = 'E_DEPT_INVALID';

export class DepartmentError extends Error {
  code: DepartmentErrorCode;

  constructor(code: DepartmentErrorCode, message: string) {
    super(message);
    this.name = 'DepartmentError';
    this.code = code;
  }
}

interface StoredDepartments {
  version: 1;
  items: DepartmentItem[];
  updatedAt: string;
  updatedBy: string;
}

export function validateDepartmentItems(raw: unknown): DepartmentItem[] {
  if (!Array.isArray(raw)) {
    throw new DepartmentError('E_DEPT_INVALID', '科室清单必须是数组');
  }
  const items: DepartmentItem[] = [];
  const seen = new Set<string>();
  raw.forEach((entry, index) => {
    const position = `第 ${index + 1} 项`;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new DepartmentError('E_DEPT_INVALID', `${position}不是一个科室对象`);
    }
    const record = entry as Record<string, unknown>;
    const code = typeof record.code === 'string' ? record.code.trim() : '';
    const name = typeof record.name === 'string' ? record.name.trim() : '';
    if (code === '') throw new DepartmentError('E_DEPT_INVALID', `${position}缺科室编码（判定用的是它，不能空）`);
    if (name === '') throw new DepartmentError('E_DEPT_INVALID', `${position}（${code}）缺科室名称（人在界面上看到的是它）`);
    if (seen.has(code)) throw new DepartmentError('E_DEPT_INVALID', `科室编码「${code}」出现了两次：编码重复时"这份文书限哪个科"就没有确定答案`);
    seen.add(code);
    if (record.enabled !== undefined && typeof record.enabled !== 'boolean') {
      throw new DepartmentError('E_DEPT_INVALID', `${position}（${code}）的启用状态只能是 true / false`);
    }
    items.push({ code, name, enabled: record.enabled !== false });
  });
  return items;
}

function readStored(kv: ConfigKv): StoredDepartments | null {
  const parsed = ((): StoredDepartments | null => {
    try {
      return kv.read<StoredDepartments>(DEPARTMENT_CONFIG_KEY);
    } catch (err) {
      throw new DepartmentError(
        'E_DEPT_INVALID',
        `科室字典读不出来，拒绝按"没配过"继续（那会让"全院通用"变成假话）：${(err as Error).message}`,
      );
    }
  })();
  if (parsed === null) return null;
  if (parsed?.version !== 1) return null;
  return parsed;
}

export function loadDepartments(kv: ConfigKv): LoadedDepartments {
  const stored = readStored(kv);
  if (!stored) return { items: [], source: 'empty' };
  return {
    items: validateDepartmentItems(stored.items),
    source: 'store',
    updatedAt: stored.updatedAt,
    updatedBy: stored.updatedBy,
  };
}

export function saveDepartments(
  kv: ConfigKv,
  rawItems: unknown,
  by: string,
  options: { at?: string } = {},
): LoadedDepartments {
  const items = validateDepartmentItems(rawItems);
  const stored: StoredDepartments = {
    version: 1,
    items,
    updatedAt: options.at ?? new Date().toISOString(),
    updatedBy: by,
  };
  kv.write(DEPARTMENT_CONFIG_KEY, stored);
  return loadDepartments(kv);
}

export const DEPARTMENT_SEED_KEY = `${CONFIG_KEY_PREFIX}departments-seeded`;

export function departmentsSeeded(kv: ConfigKv): boolean {
  return kv.read<boolean>(DEPARTMENT_SEED_KEY) === true;
}

export function markDepartmentsSeeded(kv: ConfigKv): void {
  kv.write(DEPARTMENT_SEED_KEY, true);
}

export function describeDepartments(loaded: LoadedDepartments): Record<string, unknown> {
  return {
    items: loaded.items,
    source: loaded.source,
    enabledCount: loaded.items.filter((item) => item.enabled).length,
    updatedAt: loaded.updatedAt ?? null,
    updatedBy: loaded.updatedBy ?? null,
  };
}

export function departmentNameOf(loaded: LoadedDepartments, code: string | undefined): string | undefined {
  if (!code) return undefined;
  return loaded.items.find((item) => item.code === code)?.name;
}

export function normalizeDepartmentCode(loaded: LoadedDepartments, value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (loaded.items.some((item) => item.code === value)) return value;
  return loaded.items.find((item) => item.name === value)?.code ?? value;
}

export function isDepartmentSelectable(loaded: LoadedDepartments, code: string): boolean {
  const item = loaded.items.find((entry) => entry.code === code);
  return Boolean(item && item.enabled);
}
