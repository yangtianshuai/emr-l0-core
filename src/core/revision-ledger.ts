import type { SqliteDatabase } from '../storage/sqlite.ts';
import { StorageError } from '../storage/sqlite.ts';
import { stableStringify } from '../model/hash.ts';
import { sm3Hex, utf8 } from '../crypto/sm3.ts';
import type { JsonValue, RevisionEntry } from '../model/types.ts';

export const REVISION_LEDGER_TABLE = 'document_revisions';
export const GENESIS_HASH = '0'.repeat(64);
export const E_REVISION_LEDGER_TAMPERED = 'E_REVISION_LEDGER_TAMPERED';
export const E_REVISION_LEDGER_TORN = 'E_REVISION_LEDGER_TORN';

interface LedgerRow {
  rev: number;
  payload: string;
  prev_hash: string;
  hash: string;
}

export function canonicalRevision(entry: RevisionEntry): string {
  return stableStringify({
    rev: entry.rev,
    at: entry.at,
    actorId: entry.actorId,
    op: entry.op,
    targetId: entry.targetId ?? null,
    patch: entry.patch ?? null,
    aiSuggestionId: entry.aiSuggestionId ?? null,
    aiSuggestionIds: entry.aiSuggestionIds ?? null,
    modelId: entry.modelId ?? null,
    confidence: entry.confidence ?? null,
    beforeHash: entry.beforeHash ?? null,
    afterHash: entry.afterHash ?? null,
    confirmedNodeIds: entry.confirmedNodeIds ?? null,
    acknowledgedUnconfirmed: entry.acknowledgedUnconfirmed ?? null,
    unlock: entry.unlock ?? null,
    revert: entry.revert ?? null,
    revertedTo: entry.revertedTo ?? null,
    review: entry.review ?? null,
    voided: entry.voided ?? null,
  } as unknown as JsonValue);
}

export function revisionEntryHash(prevHash: string, canonical: string): string {
  return sm3Hex(utf8(`${prevHash}\n${canonical}`));
}

export interface AppendRevisionsReport {
  appended: number;
  kept: number;
  head: string | null;
}

export function appendRevisions(
  db: SqliteDatabase,
  docId: string,
  entries: readonly RevisionEntry[],
): AppendRevisionsReport {
  const rows = db
    .prepare(`select rev, payload, prev_hash, hash from ${REVISION_LEDGER_TABLE} where doc_id = ? order by rev asc`)
    .all(docId) as unknown as LedgerRow[];
  const stored = new Map<number, LedgerRow>(rows.map((row) => [Number(row.rev), row]));

  let prevHash = GENESIS_HASH;
  let expectedRev = 1;
  let kept = 0;
  const pending: Array<{ entry: RevisionEntry; prevHash: string; hash: string; canonical: string }> = [];

  for (const entry of entries) {
    const row = stored.get(entry.rev);
    if (row !== undefined) {
      const canonical = canonicalRevision(entry);
      if (row.prev_hash !== prevHash) {
        throw new StorageError(
          E_REVISION_LEDGER_TAMPERED,
          `留痕账断链（${docId} rev ${entry.rev}）：prev_hash 与上一条对不上 —— 中间被删过或被改过`,
        );
      }
      if (row.payload !== canonical) {
        throw new StorageError(
          E_REVISION_LEDGER_TAMPERED,
          `留痕被改过（${docId} rev ${entry.rev}）：账上记录的这条与文书里的这条不是同一条`,
        );
      }
      if (revisionEntryHash(row.prev_hash, canonical) !== row.hash) {
        throw new StorageError(E_REVISION_LEDGER_TAMPERED, `留痕账摘要不符（${docId} rev ${entry.rev}）`);
      }
      prevHash = row.hash;
      kept += 1;
    } else {
      if (entry.rev !== expectedRev) {
        throw new StorageError(
          E_REVISION_LEDGER_TORN,
          `留痕序列断了（${docId}）：rev ${entry.rev} 之前缺了 rev ${expectedRev}`,
        );
      }
      const canonical = canonicalRevision(entry);
      const hash = revisionEntryHash(prevHash, canonical);
      pending.push({ entry, prevHash, hash, canonical });
      prevHash = hash;
    }
    expectedRev = entry.rev + 1;
  }

  const lastStoredRev = rows.length > 0 ? Number(rows[rows.length - 1]?.rev ?? 0) : 0;
  const lastEntryRev = entries.length > 0 ? entries[entries.length - 1]?.rev ?? 0 : 0;
  if (lastStoredRev > lastEntryRev) {
    throw new StorageError(
      E_REVISION_LEDGER_TORN,
      `留痕账比文书多（${docId}）：账上到 rev ${lastStoredRev}，文书只到 rev ${lastEntryRev} —— 留痕被丢弃，本次未写入`,
    );
  }

  if (pending.length > 0) {
    const stmt = db.prepare(
      `insert into ${REVISION_LEDGER_TABLE} (doc_id, rev, at, actor_id, op, target_id, payload, prev_hash, hash)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const item of pending) {
      stmt.run(
        docId,
        item.entry.rev,
        item.entry.at,
        item.entry.actorId,
        item.entry.op,
        item.entry.targetId ?? null,
        item.canonical,
        item.prevHash,
        item.hash,
      );
    }
  }

  return { appended: pending.length, kept, head: prevHash === GENESIS_HASH ? null : prevHash };
}

export type RevisionLedgerProblem =
  | { kind: 'tampered' | 'broken'; atRev: number; reason: string }
  | { kind: 'revGap'; atRev: number; expected: number; actual: number };

export interface RevisionLedgerReport {
  firstRun: boolean;
  loaded: number;
  totalInStore: number;
  head: string | null;
  problem: RevisionLedgerProblem | null;
  discarded: number;
}

export function loadRevisionChain(db: SqliteDatabase, docId: string): RevisionLedgerReport {
  const rows = db
    .prepare(`select rev, payload, prev_hash, hash from ${REVISION_LEDGER_TABLE} where doc_id = ? order by rev asc`)
    .all(docId) as unknown as LedgerRow[];
  if (rows.length === 0) {
    return { firstRun: true, loaded: 0, totalInStore: 0, head: null, problem: null, discarded: 0 };
  }

  let prevHash = GENESIS_HASH;
  let expectedRev = 1;
  let consumed = 0;
  let problem: RevisionLedgerProblem | null = null;

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index] as LedgerRow;
    const rev = Number(row.rev);
    if (rev !== expectedRev) {
      problem = { kind: 'revGap', atRev: rev, expected: expectedRev, actual: rev };
      break;
    }
    if (row.prev_hash !== prevHash) {
      problem = {
        kind: 'broken',
        atRev: rev,
        reason: `prev_hash 与上一条对不上（期望 ${prevHash.slice(0, 12)}…，实际 ${row.prev_hash.slice(0, 12)}…）`,
      };
      break;
    }
    if (revisionEntryHash(row.prev_hash, row.payload) !== row.hash) {
      problem = { kind: 'tampered', atRev: rev, reason: '本条内容与自身 hash 不一致（记录被改过）' };
      break;
    }
    prevHash = row.hash;
    expectedRev = rev + 1;
    consumed = index + 1;
  }

  return {
    firstRun: false,
    loaded: consumed,
    totalInStore: rows.length,
    head: problem === null ? prevHash : null,
    problem,
    discarded: rows.length - consumed,
  };
}

export function parseRevisionPayload(payload: string): RevisionEntry {
  const raw = JSON.parse(payload) as Record<string, unknown>;
  const entry: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value !== null) entry[key] = value;
  }
  return entry as unknown as RevisionEntry;
}

export function readRevisionLedger(db: SqliteDatabase, docId: string): { report: RevisionLedgerReport; entries: RevisionEntry[] } {
  const report = loadRevisionChain(db, docId);
  if (report.loaded === 0) return { report, entries: [] };
  const rows = db
    .prepare(`select rev, payload from ${REVISION_LEDGER_TABLE} where doc_id = ? order by rev asc limit ?`)
    .all(docId, report.loaded) as unknown as Array<{ payload: string }>;
  return { report, entries: rows.map((row) => parseRevisionPayload(String(row.payload))) };
}
