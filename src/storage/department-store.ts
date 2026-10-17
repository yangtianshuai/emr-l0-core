/**
 * **科室字典的落库层**：院内有哪些科、各自的编码与显示名。
 *
 * ## 为什么它必须是一份主数据，而不是模板上的一个标签
 *
 * 原先"适用科室"只是模板包里的一段自由文本：既没有可选项（界面上靠人手打），
 * 也不参与判定 —— 而就诊侧（`encounter.deptCode`）却有科室编码。
 * 两边对不上，于是界面上写着"限产科"却谁都开得出，那是一句假话。
 * 有了这份字典，"限产科"才既有得选、又有可判定的依据（编码对齐）。
 *
 * ## 它与工作区种子是同一类东西
 *
 * 空库时播种一次（与患者/就诊的出厂演示数据同一次），之后**以库里的那一份为准**：
 * 删掉一个科室之后重启，它不会自己回来。
 *
 * ## 三态与包存储一字不差
 *
 *   - 库里没有 → `source: 'empty'`，**不编一套默认科室出来**（空就是空，
 *     界面上如实说"要先在这里加科室"）；
 *   - 配过且解得开 → `source: 'store'`；
 *   - 配过但解不开（口令换过 / 那一行被改过）→ 抛错，拒绝按"没配过"继续。
 *
 * ## 停用 ≠ 删除
 *
 * `enabled: false` 的科室：**新配置里选不到它，但既有内容一个字都不改** ——
 * 模板上已配的科室、已开出的病历都不受影响。与"停用一份文书"同一条纪律。
 */

import { CONFIG_KEY_PREFIX, type ConfigKv } from './config-kv.ts';

export const DEPARTMENT_CONFIG_KEY = `${CONFIG_KEY_PREFIX}departments`;

export interface DepartmentItem {
  /** 科室编码：**与就诊 `encounter.deptCode` 对齐**，判定就靠它（如 `DEPT_RESP`） */
  code: string;
  /** 显示名（如"呼吸内科"）：只用于展示与选择，不参与比对 */
  name: string;
  /** 停用 = 选不到它；既有内容不受影响 */
  enabled: boolean;
}

export interface LoadedDepartments {
  items: DepartmentItem[];
  /** `empty` = 库里一个科室都没有（**空就是空**，不替你编一套默认科室） */
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

/**
 * 校验科室清单（**读写两条路径共用**，口径只有这一处）。
 *
 * 编码必须唯一：两份科室挂着同一个编码时，"这份文书限哪个科"就没有确定答案，
 * 而界面上两行看起来都很正常。
 */
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
    /* `enabled` 缺省为 true：不写这个字段是"启用"，不是"不启用" */
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

/** 读取科室字典：**库里有就用库里的，没有就是空**（不再有第三档） */
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

/** 保存科室字典并返回**生效后**的那一份 */
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

/**
 * 这个库有没有**播过**科室字典。
 *
 * 与工作区不同（那里是"空库就播种"），科室可以被**有意删光**：
 * "我们把科室清了"与"这个库还没建过科室"必须分得开，
 * 否则删掉之后重启，它们会自己长回来 —— 而没人知道是谁加回来的。
 */
export function departmentsSeeded(kv: ConfigKv): boolean {
  return kv.read<boolean>(DEPARTMENT_SEED_KEY) === true;
}

export function markDepartmentsSeeded(kv: ConfigKv): void {
  kv.write(DEPARTMENT_SEED_KEY, true);
}

/** 给界面的视图：编码与名称都要（下拉显示名称、保存传编码） */
export function describeDepartments(loaded: LoadedDepartments): Record<string, unknown> {
  return {
    items: loaded.items,
    source: loaded.source,
    enabledCount: loaded.items.filter((item) => item.enabled).length,
    updatedAt: loaded.updatedAt ?? null,
    updatedBy: loaded.updatedBy ?? null,
  };
}

/**
 * 编码 → 显示名。**查不到就返回 undefined，不拿编码冒充名称**：
 * "字典里没有这个科室"是必须让人看见的事实（否则界面上是一个编码，
 * 看起来像个乱码名字，而没人知道该去补字典）。
 */
export function departmentNameOf(loaded: LoadedDepartments, code: string | undefined): string | undefined {
  if (!code) return undefined;
  return loaded.items.find((item) => item.code === code)?.name;
}

/**
 * 把就诊科室**归一**成编码。
 *
 * 为什么要归一：科室字典上线前，就诊与病历里存的可能是**名称**（"呼吸内科"）。
 * 那些病历不会因为我们改了写法就被回写 —— 改病历要留 rev 与审计，
 * 而"把主数据的表示法对齐"不该以改病历的方式完成。于是归一放在**读取时**：
 * 是编码就原样通过，是名称且能对上字典就换成编码。
 *
 * 对不上就**原样返回**：猜一个编码比留着更能掩盖问题（会把"字典缺这个科"说成"它属于某个科"）。
 */
export function normalizeDepartmentCode(loaded: LoadedDepartments, value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (loaded.items.some((item) => item.code === value)) return value;
  return loaded.items.find((item) => item.name === value)?.code ?? value;
}

/** 这个编码能不能被**新配置**选中（停用的与不存在的都不能） */
export function isDepartmentSelectable(loaded: LoadedDepartments, code: string): boolean {
  const item = loaded.items.find((entry) => entry.code === code);
  return Boolean(item && item.enabled);
}
