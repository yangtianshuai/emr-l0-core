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
  disabled: string[];
  updatedAt: string;
}

export interface PackStoreReport {
  source: 'empty' | 'database';
  tables: string[];
  packs: Array<{ packId: string; kind: PackKind; itemCount: number; enabledItemCount: number; fingerprint: string }>;
}

export type OpenResult = { ok: true; report: PackStoreReport } | { ok: false; code: PackStoreErrorCode; message: string };

export interface OpenPackStoreInput {
  registry: PackRegistry;
  db: SqliteDatabase;
  supported: SupportedEngineApis;
  validateFor: (kind: PackKind) => ((pack: Pack) => void) | undefined;
}

export interface WritePackInput extends OpenPackStoreInput {
  input: unknown;
  by?: string;
}

export interface WritePackResult {
  report: PackStoreReport;
  packId: string;
  action: 'created' | 'updated' | 'unchanged';
  fingerprintBefore: string | null;
  fingerprintAfter: string;
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
    packs.push({ pack, disabled: row.disabled });
  }
  return { ok: true, packs };
}

export function openPackStore(input: OpenPackStoreInput): OpenResult {
  const rows = readPackRows(input.db);
  if (rows.length === 0) {
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
  const unloaded = input.registry.unload(input.packId);
  return { ok: true, report: buildReport(input.registry, input.db), ...(removed === 0 && !unloaded ? { code: 'E_PACK_STORE_WRITE' as PackStoreErrorCode } : {}) };
}

export function saveDisabledItems(registry: PackRegistry, db: SqliteDatabase, options: { at?: string } = {}): { tables: string[] } {
  const at = options.at ?? now();
  inTransaction(db, () => {
    for (const summary of registry.list()) {
      const disabled = summary.items.filter((item) => !item.enabled).map((item) => item.itemId);
      const updated = db
        .prepare('update knowledge_packs set disabled = ?, updated_at = ? where pack_id = ?')
        .run(JSON.stringify(disabled), at, summary.packId);
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
