import { countOf, inTransaction, type SqliteDatabase } from './sqlite.ts';
import { sealFor, unsealValue, type SealOptions } from './sealed.ts';
import { READING_GRANT_FORMAT } from './formats.ts';

export interface ReadingGrantRecord {
  grantId: string;
  docId: string;
  revoked: boolean;
  readCount: number;
  payload: unknown;
}

export interface ReadingGrantRow {
  grantId: string;
  docId: string;
  revoked: boolean;
  readCount: number;
}

export interface ReadingGrantStoreOptions extends SealOptions {
  at?: string;
}

export type LoadReadingGrantResult =
  | { ok: true; found: false }
  | { ok: true; found: true; record: ReadingGrantRecord }
  | { ok: false; code: string; message: string };

interface DbRow {
  grant_id: string;
  doc_id: string;
  revoked: number;
  read_count: number;
  payload_digest: string;
  payload_sealed: string;
}

function sealOptionsOf(options: ReadingGrantStoreOptions): SealOptions {
  const out: SealOptions = {};
  if (options.salt !== undefined) out.salt = options.salt;
  if (options.iterations !== undefined) out.iterations = options.iterations;
  return out;
}

function nowOf(options: ReadingGrantStoreOptions): string {
  return options.at ?? new Date().toISOString();
}

export function saveReadingGrant(
  db: SqliteDatabase,
  passphrase: string,
  record: ReadingGrantRecord,
  options: ReadingGrantStoreOptions = {},
): void {
  if (record.grantId.trim() === '') throw new Error('拒绝写入没有 grantId 的授权记录（它是对外识别这一条授权的唯一名字）');
  if (record.docId.trim() === '') throw new Error(`拒绝写入没有 docId 的授权记录：${record.grantId}（没有它就没法回答"这份文书被谁授权过"）`);
  const sealed = sealFor(READING_GRANT_FORMAT, record.payload, passphrase, sealOptionsOf(options));
  db.prepare(
    `insert into reading_grants (grant_id, doc_id, revoked, read_count, payload_format, payload_digest, payload_sealed, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)
     on conflict(grant_id) do update set
       doc_id = excluded.doc_id, revoked = excluded.revoked, read_count = excluded.read_count,
       payload_format = excluded.payload_format, payload_digest = excluded.payload_digest,
       payload_sealed = excluded.payload_sealed, updated_at = excluded.updated_at`,
  ).run(
    record.grantId,
    record.docId,
    record.revoked ? 1 : 0,
    Math.max(0, Math.trunc(record.readCount)),
    sealed.format,
    sealed.digest,
    sealed.sealed,
    nowOf(options),
  );
}

export function loadReadingGrant(
  db: SqliteDatabase,
  passphrase: string,
  grantId: string,
): LoadReadingGrantResult {
  const row = db.prepare('select * from reading_grants where grant_id = ?').get(grantId) as DbRow | undefined;
  if (!row) return { ok: true, found: false };
  const unsealed = unsealValue<unknown>({ digest: row.payload_digest, sealed: row.payload_sealed }, passphrase);
  if (!unsealed.ok) {
    return {
      ok: false,
      code: unsealed.code,
      message: `授权 ${row.grant_id} 的载荷读不出来（口令换过、或那一行被改动过）：${unsealed.message}；**不当作"没有这条授权"**`,
    };
  }
  return {
    ok: true,
    found: true,
    record: {
      grantId: String(row.grant_id),
      docId: String(row.doc_id),
      revoked: Number(row.revoked) !== 0,
      readCount: Number(row.read_count),
      payload: unsealed.data,
    },
  };
}

export function listReadingGrants(db: SqliteDatabase, filter: { docId?: string; revoked?: boolean } = {}): ReadingGrantRow[] {
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (filter.docId !== undefined) {
    where.push('doc_id = ?');
    params.push(filter.docId);
  }
  if (filter.revoked !== undefined) {
    where.push('revoked = ?');
    params.push(filter.revoked ? 1 : 0);
  }
  const rows = db.prepare(
    `select grant_id, doc_id, revoked, read_count from reading_grants${where.length > 0 ? ` where ${where.join(' and ')}` : ''} order by doc_id, grant_id`,
  ).all(...params) as unknown as Array<Omit<DbRow, 'payload_digest' | 'payload_sealed'>>;
  return rows.map((row) => ({
    grantId: String(row.grant_id),
    docId: String(row.doc_id),
    revoked: Number(row.revoked) !== 0,
    readCount: Number(row.read_count),
  }));
}

export function loadAllReadingGrants(
  db: SqliteDatabase,
  passphrase: string,
): { ok: true; records: ReadingGrantRecord[] } | { ok: false; code: string; message: string } {
  const rows = db.prepare('select * from reading_grants order by doc_id, grant_id').all() as unknown as DbRow[];
  const records: ReadingGrantRecord[] = [];
  for (const row of rows) {
    const unsealed = unsealValue<unknown>({ digest: row.payload_digest, sealed: row.payload_sealed }, passphrase);
    if (!unsealed.ok) {
      return {
        ok: false,
        code: unsealed.code,
        message: `授权 ${row.grant_id} 的载荷读不出来：${unsealed.message}；**不当作"这条授权不存在"**（已中断恢复，未丢弃任何行）`,
      };
    }
    records.push({
      grantId: String(row.grant_id),
      docId: String(row.doc_id),
      revoked: Number(row.revoked) !== 0,
      readCount: Number(row.read_count),
      payload: unsealed.data,
    });
  }
  return { ok: true, records };
}

export function syncReadingGrants(
  db: SqliteDatabase,
  passphrase: string,
  records: readonly ReadingGrantRecord[],
  options: ReadingGrantStoreOptions = {},
): { written: number; removed: number } {
  const keep = new Set(records.map((record) => record.grantId));
  let removed = 0;
  inTransaction(db, () => {
    for (const row of db.prepare('select grant_id from reading_grants').all() as unknown as Array<{ grant_id: string }>) {
      if (keep.has(String(row.grant_id))) continue;
      db.prepare('delete from reading_grants where grant_id = ?').run(String(row.grant_id));
      removed += 1;
    }
    for (const record of records) saveReadingGrant(db, passphrase, record, options);
  });
  return { written: records.length, removed };
}

export function clearReadingGrants(db: SqliteDatabase): number {
  return Number(db.prepare('delete from reading_grants').run().changes);
}

export function countReadingGrants(db: SqliteDatabase): { total: number; revoked: number } {
  return {
    total: countOf(db, 'select count(*) as n from reading_grants'),
    revoked: countOf(db, 'select count(*) as n from reading_grants where revoked = 1'),
  };
}
