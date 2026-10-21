import { existsSync } from 'node:fs';
import { loadSealedPayload } from '../core/store.ts';
import type { SqliteDatabase } from './sqlite.ts';
import { saveReadingGrant, type ReadingGrantStoreOptions } from './reading-grant-store.ts';

export const READING_GRANTS_LEDGER_ID = 'reading-grants-import';

export interface ReadingGrantsImportResult {
  ran: boolean;
  imported: number;
  found: number;
  skipped: number;
  problem: string | null;
  reason: string;
}

interface LegacyRecordShape {
  credential?: { grant?: { grantId?: unknown; docId?: unknown } };
  readCount?: unknown;
  revoked?: unknown;
}

function columnsOf(record: unknown): { grantId: string; docId: string; revoked: boolean; readCount: number } | null {
  const shape = record as LegacyRecordShape;
  const grantId = shape?.credential?.grant?.grantId;
  const docId = shape?.credential?.grant?.docId;
  if (typeof grantId !== 'string' || grantId.trim() === '') return null;
  if (typeof docId !== 'string' || docId.trim() === '') return null;
  return {
    grantId,
    docId,
    revoked: shape.revoked === true,
    readCount: Number.isInteger(shape.readCount) ? Number(shape.readCount) : 0,
  };
}

export function importReadingGrantsOnce(deps: {
  workStore: { ledgerHas(id: string): boolean; ledgerMark(id: string, note: string): void };
  db: SqliteDatabase;
  passphrase: string;
  file: string;
  exists?: (path: string) => boolean;
  options?: ReadingGrantStoreOptions;
}): ReadingGrantsImportResult {
  const empty = { imported: 0, found: 0, skipped: 0, problem: null };
  if (deps.workStore.ledgerHas(READING_GRANTS_LEDGER_ID)) {
    return { ran: false, ...empty, reason: '已经搬过一次（记账在库里）：不再看旧文件' };
  }
  const exists = deps.exists ?? existsSync;
  if (!exists(deps.file)) {
    return { ran: true, ...empty, reason: '没有旧的授权登记文件' };
  }

  const existing = Number(
    (deps.db.prepare('select count(*) as n from reading_grants').get() as { n?: number } | undefined)?.n ?? 0,
  );
  if (existing > 0) {
    deps.workStore.ledgerMark(READING_GRANTS_LEDGER_ID, `库里已有 ${existing} 条授权登记，旧文件不导入（保留原处）`);
    return { ran: true, ...empty, reason: `库里已有 ${existing} 条授权登记：不导入旧文件（不混来源）` };
  }

  const loaded = loadSealedPayload<{ version?: number; grants?: unknown[] }>(deps.file, deps.passphrase);
  if (!loaded.ok) {
    return {
      ran: true,
      ...empty,
      problem: `${loaded.code}：${loaded.message}`,
      reason: '旧授权登记文件读不出来：未导入、也**未记账**（修好之后下次启动会再试）',
    };
  }
  if (loaded.firstRun) {
    return { ran: true, ...empty, reason: '没有旧的授权登记文件' };
  }

  const grants = Array.isArray(loaded.data?.grants) ? loaded.data.grants : [];
  const result: ReadingGrantsImportResult = {
    ran: true,
    imported: 0,
    found: grants.length,
    skipped: 0,
    problem: null,
    reason: '已把旧文件搬进库',
  };
  for (const record of grants) {
    const columns = columnsOf(record);
    if (columns === null) {
      result.skipped += 1;
      result.problem = result.problem ?? `旧文件里有 ${result.skipped} 条记录缺少 grantId 或 docId（无法登记，已如实报出）`;
      continue;
    }
    saveReadingGrant(deps.db, deps.passphrase, { ...columns, payload: record }, deps.options ?? {});
    result.imported += 1;
  }
  if (result.skipped > 0) {
    result.problem = `旧文件共 ${result.found} 条，其中 ${result.skipped} 条缺少 grantId 或 docId 被丢弃（其余 ${result.imported} 条已登记）`;
  }

  deps.workStore.ledgerMark(
    READING_GRANTS_LEDGER_ID,
    `从旧文件搬入 ${result.imported} 条授权登记` + (result.skipped > 0 ? `（丢弃 ${result.skipped} 条形状不对的）` : ''),
  );
  return result;
}
