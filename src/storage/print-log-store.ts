import { countOf, type SqliteDatabase } from './sqlite.ts';

export interface PrintLogRecord {
  docId: string;
  actorId: string;
  at: string;
  rev: number;
  pages: number;
  status: string;
  /** 打印时是否已签名/归档：草稿打出来的纸不是正式病历 */
  formal: boolean;
}

export interface PrintStats {
  count: number;
  formalCount: number;
  lastAt: string | null;
  lastActorId: string | null;
}

interface DbRow {
  doc_id: string;
  actor_id: string;
  at: string;
  rev: number;
  pages: number;
  status: string;
  formal: number;
}

export function appendPrintLog(db: SqliteDatabase, record: PrintLogRecord): void {
  if (record.docId.trim() === '') throw new Error('拒绝写入没有 docId 的打印留痕（否则查不出这份文书被谁打过）');
  if (record.actorId.trim() === '') throw new Error('拒绝写入没有操作者的打印留痕（打印必须能追到人）');
  if (!Number.isInteger(record.pages) || record.pages < 1) throw new Error(`打印页数必须是从 1 开始的整数，实际：${record.pages}`);
  db.prepare(
    `insert into print_logs (doc_id, actor_id, at, rev, pages, status, formal) values (?, ?, ?, ?, ?, ?, ?)`,
  ).run(record.docId, record.actorId, record.at, Math.max(0, Math.trunc(record.rev)), Math.trunc(record.pages), record.status, record.formal ? 1 : 0);
}

export function loadPrintStats(db: SqliteDatabase, docId: string): PrintStats {
  const count = countOf(db, 'select count(*) as n from print_logs where doc_id = ?', docId);
  const formalCount = countOf(db, 'select count(*) as n from print_logs where doc_id = ? and formal = 1', docId);
  const last = db.prepare('select actor_id, at from print_logs where doc_id = ? order by seq desc limit 1').get(docId) as
    | { actor_id?: string; at?: string }
    | undefined;
  return {
    count,
    formalCount,
    lastAt: last?.at ?? null,
    lastActorId: last?.actor_id ?? null,
  };
}

export function listPrintLogs(db: SqliteDatabase, docId: string, limit = 20): PrintLogRecord[] {
  const rows = db
    .prepare('select doc_id, actor_id, at, rev, pages, status, formal from print_logs where doc_id = ? order by seq desc limit ?')
    .all(docId, Math.max(1, Math.trunc(limit))) as unknown as DbRow[];
  return rows.map((row) => ({
    docId: row.doc_id,
    actorId: row.actor_id,
    at: row.at,
    rev: Number(row.rev),
    pages: Number(row.pages),
    status: row.status,
    formal: Number(row.formal) === 1,
  }));
}
