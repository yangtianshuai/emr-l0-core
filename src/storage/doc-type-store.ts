/**
 * **文书类型的落库层**：院内有哪些文书类型（"入院记录""门（急）诊病历"…），
 * 各自的体系、编码与显示名。
 *
 * ## 为什么它必须是一份主数据，而不是每份模板里各写一遍
 *
 * 类型此前是**模板上的一个字段**：每建一份文书就手填一次类型码。
 * 于是同一个"入院记录"可以被打成 `WST500.1`、`wst500.1`、`入院记录` 三种写法，
 * 而**质控规则是按类型编码定位文书的**（`QcContext.docTypeCode`）——
 * 规则写着"入院记录须在 24 小时内完成"，实际却一份都判不到，且没有任何地方会报错。
 * 与科室字典同一个道理：一份集中的字典，"限这类文书"才既有得选、又有可判定的依据。
 *
 * ## 它与科室字典的**唯一实质差别**：唯一性看"体系 + 编码"这一对
 *
 * 科室编码全院一套命名空间，重名就是要出事。文书类型不同：
 * 国标体系（`WST500` / `WS445`）与院内自定义（`local`）可以各有一个 `A01`，
 * 那是两个东西。所以这里的判重键是 `system/code`，**不是 `code` 单键** ——
 * 照抄科室那条 `code` 唯一会误杀合法的跨体系重码。
 *
 * ## 三态、停用纪律、播种口径：与科室字典一字不差
 *
 *   - 库里没有 → `source: 'empty'`，**不编一套默认类型出来**；
 *   - 配过且解得开 → `source: 'store'`；
 *   - 配过但解不开（口令换过 / 那一行被改过）→ 抛错，拒绝按"没配过"继续；
 *   - `enabled: false` 的类型：**新建文书时选不到它，但既有模板与已开出的病历一个字都不改**。
 */

import { CONFIG_KEY_PREFIX, type ConfigKv } from './config-kv.ts';

export const DOC_TYPE_CONFIG_KEY = `${CONFIG_KEY_PREFIX}doc-types`;

/**
 * 文书类型的体系。**与 `DocTypeRef.system`（`src/model/types.ts`）同一套取值**，
 * 不是另立一份清单：两处必须一起改，否则字典里存得下、文档模型里存不下。
 */
export const DOC_TYPE_SYSTEMS = ['WST500', 'WS445', 'local', 'custom'] as const;
export type DocTypeSystem = (typeof DOC_TYPE_SYSTEMS)[number];

export interface DocTypeItem {
  /** 体系：编码只在**同一体系内**要求唯一（见文件头"唯一实质差别"） */
  system: DocTypeSystem;
  /** 类型编码：与模板 `docType.code`、质控规则的 `docTypeCode` 对齐，判定靠它（如 `WST500.1`） */
  code: string;
  /** 显示名（如"入院记录"）：只用于展示与选择，不参与比对 */
  display: string;
  /** 停用 = 新建文书时选不到它；既有内容不受影响 */
  enabled: boolean;
}

export interface LoadedDocTypes {
  items: DocTypeItem[];
  /** `empty` = 库里一个类型都没有（**空就是空**，不替你编一套默认类型） */
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

/** 判重键：**跨体系不冲突**（`local/A01` 与 `WST500/A01` 是两个东西，见文件头） */
export function docTypeKeyOf(item: Pick<DocTypeItem, 'system' | 'code'>): string {
  return `${item.system}/${item.code}`;
}

function isSystem(value: unknown): value is DocTypeSystem {
  return typeof value === 'string' && (DOC_TYPE_SYSTEMS as readonly string[]).includes(value);
}

/**
 * 校验文书类型清单（**读写两条路径共用**，口径只有这一处）。
 *
 * `system/code` 必须唯一：两份类型挂着同一个键时，"这条质控规则盯的是哪一类文书"
 * 就没有确定答案 —— 而界面上两行看起来都很正常。
 */
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
    /* 体系：不给就按 `local`（院内自定义）兜底 —— 这是唯一有合理缺省的一格，
       而缺省的值写在这里、读的时候也走同一条，不会两边各猜一个 */
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
    /* `enabled` 缺省为 true：不写这个字段是"启用"，不是"不启用" */
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

/** 读取文书类型：**库里有就用库里的，没有就是空**（不再有第三档） */
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

/** 保存文书类型并返回**生效后**的那一份 */
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

/**
 * 这个库有没有**播过**文书类型。
 *
 * 与科室字典同一条纪律：类型可以被**有意删光**（"我们把类型清了"与"这个库还没建过类型"
 * 必须分得开），删掉之后重启不该自己长回来 —— 长回来又没人知道是谁加的。
 */
export function docTypesSeeded(kv: ConfigKv): boolean {
  return kv.read<boolean>(DOC_TYPE_SEED_KEY) === true;
}

export function markDocTypesSeeded(kv: ConfigKv): void {
  kv.write(DOC_TYPE_SEED_KEY, true);
}

/** 给界面的视图：编码与显示名都要（下拉显示名称、保存传编码 + 体系） */
export function describeDocTypes(loaded: LoadedDocTypes): Record<string, unknown> {
  return {
    items: loaded.items,
    source: loaded.source,
    enabledCount: loaded.items.filter((item) => item.enabled).length,
    /* 体系白名单随视图一起给：界面的下拉选项与后端校验用同一处取值（各写一份迟早对不上） */
    systems: [...DOC_TYPE_SYSTEMS],
    updatedAt: loaded.updatedAt ?? null,
    updatedBy: loaded.updatedBy ?? null,
  };
}

/** 这个类型能不能被**新建的文书**选中（停用的与不存在的都不能） */
export function isDocTypeSelectable(loaded: LoadedDocTypes, system: string, code: string): boolean {
  const item = loaded.items.find((entry) => entry.system === system && entry.code === code);
  return Boolean(item && item.enabled);
}

/**
 * `system/code` → 显示名。**查不到就返回 undefined，不拿编码冒充名称**：
 * "字典里没有这个类型"是必须让人看见的事实，否则界面上会出现一个谁也不认识的串，
 * 而没人知道该去补字典。
 */
export function docTypeDisplayOf(loaded: LoadedDocTypes, system: string | undefined, code: string | undefined): string | undefined {
  if (!system || !code) return undefined;
  return loaded.items.find((entry) => entry.system === system && entry.code === code)?.display;
}
