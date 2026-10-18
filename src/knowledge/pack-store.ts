// 知识资产包存储：库里的 `knowledge_packs` 一张表，一个包一行。

import { createHash } from 'node:crypto';
import { inTransaction, type SqliteDatabase } from '../storage/sqlite.ts';
import {
  PackRegistry,
  packContentProjection,
  validatePack,
  type Pack,
  type PackKind,
  type SupportedEngineApis,
} from './pack.ts';

/** 库内包内容的形状标识（与 `storage/formats.ts` 同一用意：改形状必须换标识） */
export const PACK_CONTENT_FORMAT = 'l0-pack/1';

/** 包落在哪张表：让"数据在哪"是一句可以直接回答的话 */
export const PACK_TABLE = 'knowledge_packs';

export type PackStoreErrorCode =
  | 'E_PACK_STORE_BAD_CONTENT'
  | 'E_PACK_STORE_CONTENT_FORMAT'
  | 'E_PACK_STORE_ENGINE_UNKNOWN'
  | 'E_PACK_STORE_WRITE';

export class PackStoreError extends Error {
  code: PackStoreErrorCode;

  constructor(code: PackStoreErrorCode, message: string) {
    super(message);
    this.name = 'PackStoreError';
    this.code = code;
  }
}

export interface PackRow {
  packId: string;
  kind: string;
  contentFormat: string;
  content: string;
  fingerprint: string;
  /** 被停用的条目（缺省即启用，所以"全启用"在库里是空数组 —— 少一个会漂移的字段） */
  disabled: string[];
  updatedAt: string;
}

export interface PackStoreReport {
  /** `empty` = 库里一个包都没有（空就是空，不再有出厂包替你播种）；`database` = 从库装载  */
  source: 'empty' | 'database';
  tables: string[];
  packs: Array<{ packId: string; kind: PackKind; itemCount: number; enabledItemCount: number; fingerprint: string }>;
}

export type OpenResult = { ok: true; report: PackStoreReport } | { ok: false; code: PackStoreErrorCode; message: string };

export interface OpenPackStoreInput {
  registry: PackRegistry;
  /** 包存储所在的库（与文书、旁挂数据同一个库：备份一次就带走全部）  */
  db: SqliteDatabase;
  supported: SupportedEngineApis;
  /** 类别专有校验（如规则包的谓词参数）—— 与写包时用的是同一套 */
  validateFor: (kind: PackKind) => ((pack: Pack) => void) | undefined;
}

export interface WritePackInput extends OpenPackStoreInput {
  /** 外部提交的包（未校验的原始数据）  */
  input: unknown;
  /** 覆盖前先留痕用的操作者标识（只用于报告，不落库） */
  by?: string;
}

export interface WritePackResult {
  report: PackStoreReport;
  packId: string;
  /** `created` 新写进来的 / `updated` 覆盖了原有内容 / `unchanged` 内容逐字节相同（幂等重灌） */
  action: 'created' | 'updated' | 'unchanged';
  fingerprintBefore: string | null;
  fingerprintAfter: string;
  /** 覆盖时被丢弃的条目开关（新版里已不存在的条目）—— 不悄悄丢  */
  droppedSwitches: string[];
  disabled: string[];
  summary: ReturnType<PackRegistry['load']>;
}

function fingerprintOf(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function now(): string {
  return new Date().toISOString();
}

function parseDisabled(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

/** 读全表（顺序按 `pack_id`，装载顺序因此是确定的：跨包冲突的报错内容不会来回变） */
export function readPackRows(db: SqliteDatabase): PackRow[] {
  return db
    .prepare('select pack_id, kind, content_format, content, fingerprint, disabled, updated_at from knowledge_packs order by pack_id')
    .all()
    .map((row) => ({
      packId: String(row.pack_id),
      kind: String(row.kind),
      contentFormat: String(row.content_format),
      content: String(row.content),
      fingerprint: String(row.fingerprint),
      disabled: parseDisabled(row.disabled),
      updatedAt: String(row.updated_at),
    }));
}

function buildReport(registry: PackRegistry, db: SqliteDatabase): PackStoreReport {
  /* 指纹是内容的函数，读的时候重算，而不是信任列里的旧值：
     迁移会改写内容（如剥掉旧字段），而列里的值那时就与内容不符了 ——
     而"现在跑的是哪一份内容"必须永远答得准（下一句就是把它展示给人看）。  */
  const fingerprints = new Map(readPackRows(db).map((row) => [row.packId, fingerprintOf(row.content)]));
  return {
    source: registry.list().length === 0 ? 'empty' : 'database',
    tables: [PACK_TABLE],
    packs: registry.list().map((summary) => ({
      packId: summary.packId,
      kind: summary.kind,
      itemCount: summary.itemCount,
      enabledItemCount: summary.enabledItemCount,
      fingerprint: fingerprints.get(summary.packId) ?? '',
    })),
  };
}

/**
 * 在临时注册表上把整盘演练一遍。
 *
 * 包与包之间的冲突（同 packId、同条目）只会在装载那一刻暴露，而那时真注册表已经被清空。
 * 先演练，就把所有失败挡在"注册表被动过"之前 —— 于是契约变得干净：
 * 失败 ⇒ 注册表保持原样。
  */
function rehearsalOf(
  input: Pick<OpenPackStoreInput, 'supported' | 'validateFor'>,
  rows: Array<{ pack: Pack; disabled: string[] }>,
): { ok: true } | { ok: false; code: PackStoreErrorCode; message: string } {
  const rehearsal = new PackRegistry(input.supported);
  for (const { pack, disabled } of rows) {
    try {
      rehearsal.load(pack, { replace: true, validate: input.validateFor(pack.kind) });
      for (const item of pack.items) {
        if (disabled.includes(item.itemId)) rehearsal.setItemEnabled(pack.packId, item.itemId, false);
      }
    } catch (err) {
      return { ok: false, code: 'E_PACK_STORE_BAD_CONTENT', message: `装载演练失败（注册表未被动过）：${(err as Error).message}` };
    }
  }
  return { ok: true };
}

/** 把库里的那些行解析成可装载的包（逐行校验，一处不合法就整体拒绝）  */
function parseRows(
  input: Pick<OpenPackStoreInput, 'supported' | 'validateFor'>,
  rows: readonly PackRow[],
): { ok: true; packs: Array<{ pack: Pack; disabled: string[] }> } | { ok: false; code: PackStoreErrorCode; message: string } {
  const packs: Array<{ pack: Pack; disabled: string[] }> = [];
  for (const row of rows) {
    if (row.contentFormat !== PACK_CONTENT_FORMAT) {
      return {
        ok: false,
        code: 'E_PACK_STORE_CONTENT_FORMAT',
        message: `包内容形状不认识：${row.packId} 是 ${row.contentFormat}，本程序只认 ${PACK_CONTENT_FORMAT}（需显式迁移，不做隐式猜测）`,
      };
    }
    let pack: Pack;
    try {
      pack = validatePack(JSON.parse(row.content) as unknown, input.supported);
    } catch (err) {
      return { ok: false, code: 'E_PACK_STORE_BAD_CONTENT', message: `包校验未通过（${row.packId}）：${(err as Error).message}` };
    }
    const kindCheck = input.validateFor(pack.kind);
    if (!kindCheck) {
      return { ok: false, code: 'E_PACK_STORE_ENGINE_UNKNOWN', message: `本机没有 ${pack.kind} 类别的引擎：${row.packId}` };
    }
    try {
      kindCheck(pack);
    } catch (err) {
      return { ok: false, code: 'E_PACK_STORE_BAD_CONTENT', message: `包校验未通过（${row.packId}）：${(err as Error).message}` };
    }
    /* 内容在 `content` 列，条目开关在 `disabled` 列 —— 装载时按它把条目关回去 */
    packs.push({ pack, disabled: row.disabled });
  }
  return { ok: true, packs };
}

/**
 * 打开包存储：库是唯一来源（空库就是空库，不用任何出厂包顶上）。
 *
 * 顺序刻意如此：先读库校验 → 再清空注册表 → 统一装载。
 * 若装载阶段失败，注册表保持为空并如实报错 —— 不留"半个库状态"。
  */
export function openPackStore(input: OpenPackStoreInput): OpenResult {
  const rows = readPackRows(input.db);
  if (rows.length === 0) {
    /* 空库：把注册表清空并如实上报。不播种、不回退到任何内置内容 ——
       "看起来有规则在跑"是这里最危险的一种状态（医生以为质控在工作）。  */
    input.registry.clear();
    return { ok: true, report: { source: 'empty', tables: [PACK_TABLE], packs: [] } };
  }

  const parsed = parseRows(input, rows);
  if (!parsed.ok) return parsed;

  const rehearsal = rehearsalOf(input, parsed.packs);
  if (!rehearsal.ok) return rehearsal;

  input.registry.clear();
  for (const { pack, disabled } of parsed.packs) {
    input.registry.load(pack, { replace: true, validate: input.validateFor(pack.kind) });
    for (const item of pack.items) {
      if (disabled.includes(item.itemId)) input.registry.setItemEnabled(pack.packId, item.itemId, false);
    }
  }
  return { ok: true, report: buildReport(input.registry, input.db) };
}

/**
 * 写入（新增或覆盖）一个包，并立刻装载。
 *
 * 契约：
 *   - `action: 'unchanged'` 时什么都不写（重复灌同一个包不该让 `updated_at` 漂移）；
 *   - 覆盖时保留仍然存在的条目开关，丢弃新版里已不存在的条目，并在 `droppedSwitches` 里如实报出；
 *   - 失败 ⇒ 库与注册表都不动（校验与冲突判定全部先于写入）。
  */
export function writePack(input: WritePackInput): { ok: true; result: WritePackResult } | { ok: false; code: PackStoreErrorCode; message: string } {
  const pack = ((): Pack | { problem: string } => {
    try {
      const validated = validatePack(input.input, input.supported);
      input.validateFor(validated.kind)?.(validated);
      return validated;
    } catch (err) {
      return { problem: (err as Error).message };
    }
  })();
  if ('problem' in pack) {
    return { ok: false, code: 'E_PACK_STORE_BAD_CONTENT', message: pack.problem };
  }

  /* 冲突判定：同类别下 `itemId` 被别的包占用 → 拒绝。
     复用注册表自己的判定（它不是"只有装载时才跑"的逻辑，而是唯一一处口径）：
     临时装配"库里其它包 + 本次这个包"，冲突会在这里抛出来，且真注册表与库都还没动。  */
  const others = readPackRows(input.db).filter((row) => row.packId !== pack.packId);
  const parsedOthers = parseRows(input, others);
  if (!parsedOthers.ok) return parsedOthers;
  const rehearsal = rehearsalOf(input, [...parsedOthers.packs, { pack, disabled: [] }]);
  if (!rehearsal.ok) {
    return { ok: false, code: 'E_PACK_STORE_BAD_CONTENT', message: rehearsal.message.replace('装载演练失败（注册表未被动过）：', '') };
  }

  const content = JSON.stringify(packContentProjection(pack));
  const fingerprint = fingerprintOf(content);
  const previous = readPackRows(input.db).find((row) => row.packId === pack.packId) ?? null;
  const keep = (previous?.disabled ?? []).filter((itemId) => pack.items.some((item) => item.itemId === itemId));
  const droppedSwitches = (previous?.disabled ?? []).filter((itemId) => !pack.items.some((item) => item.itemId === itemId));

  const action: WritePackResult['action'] = !previous ? 'created' : previous.fingerprint === fingerprint ? 'unchanged' : 'updated';

  if (action !== 'unchanged') {
    const at = now();
    inTransaction(input.db, () => {
      input.db
        .prepare(
          `insert into knowledge_packs (pack_id, kind, content_format, content, fingerprint, disabled, updated_at)
           values (?, ?, ?, ?, ?, ?, ?)
           on conflict(pack_id) do update set
             kind = excluded.kind,
             content_format = excluded.content_format,
             content = excluded.content,
             fingerprint = excluded.fingerprint,
             disabled = excluded.disabled,
             updated_at = excluded.updated_at`,
        )
        .run(pack.packId, pack.kind, PACK_CONTENT_FORMAT, content, fingerprint, JSON.stringify(keep), at);
    });
  }

  /* 装载：走到这一步已经演练过了，不会失败。顺序是"先库、后内存"——
     反过来（先装载）会在写库失败时留下"内存里有、库里没有"，那是最难查的一种不一致。 */
  const summary = input.registry.load(pack, { replace: true, validate: input.validateFor(pack.kind) });
  for (const item of pack.items) {
    if (keep.includes(item.itemId)) input.registry.setItemEnabled(pack.packId, item.itemId, false);
  }

  return {
    ok: true,
    result: {
      report: buildReport(input.registry, input.db),
      packId: pack.packId,
      action,
      fingerprintBefore: previous?.fingerprint ?? null,
      fingerprintAfter: fingerprint,
      droppedSwitches,
      disabled: keep,
      summary,
    },
  };
}

export function deletePack(input: { registry: PackRegistry; db: SqliteDatabase; packId: string }): { ok: boolean; code?: PackStoreErrorCode; report: PackStoreReport } {
  const removed = inTransaction(input.db, () => {
    const result = input.db.prepare('delete from knowledge_packs where pack_id = ?').run(input.packId);
    return Number(result.changes);
  });
  /* 库里本来就没有：不算失败（删一个不存在的包，结果就是"没有它"），
     但要如实回给调用方 —— 否则"我删了"与"它本来就不在"又混成一件事 */
  const unloaded = input.registry.unload(input.packId);
  return { ok: true, report: buildReport(input.registry, input.db), ...(removed === 0 && !unloaded ? { code: 'E_PACK_STORE_WRITE' as PackStoreErrorCode } : {}) };
}

/**
 * 把条目开关写回库里（只改 `disabled` 列，不动内容）。
 *
 * 内容列一个字节都不碰：否则"关掉一条规则"会连带改变内容指纹，
 * 而"换了包"与"只是关了条规则"就又混成一件事了。
  */
export function saveDisabledItems(registry: PackRegistry, db: SqliteDatabase, options: { at?: string } = {}): { tables: string[] } {
  const at = options.at ?? now();
  inTransaction(db, () => {
    for (const summary of registry.list()) {
      const disabled = summary.items.filter((item) => !item.enabled).map((item) => item.itemId);
      const updated = db
        .prepare('update knowledge_packs set disabled = ?, updated_at = ? where pack_id = ?')
        .run(JSON.stringify(disabled), at, summary.packId);
      /* 注册表里有、库里却没有：不静默造一行出来（那等于凭空多出一份内容）。
         如实报错，让"内存与库不一致"当场暴露，而不是等重启后包内容变成另一份。  */
      if (Number(updated.changes) === 0) {
        throw new PackStoreError(
          'E_PACK_STORE_WRITE',
          `库里没有包「${summary.packId}」，无法写入条目开关：内存与库已经不一致，请重新从库装载`,
        );
      }
    }
  });
  return { tables: [PACK_TABLE] };
}
