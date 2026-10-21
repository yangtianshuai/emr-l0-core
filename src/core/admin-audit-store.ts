import type { SqliteDatabase } from '../storage/sqlite.ts';
import { stableStringify } from '../model/hash.ts';
import { sm3Hex, utf8 } from '../crypto/sm3.ts';
import type { JsonValue } from '../model/types.ts';

export interface AdminAuditRecord {
  seq: number;
  at: string;
  actor: string;
  subject: string;
  kind: '变更' | '动作';
  changes: Array<{ field: string; before: string; after: string }>;
  note?: string;
}

export interface ChainedAdminAuditRecord extends AdminAuditRecord {
  prevHash: string;
  hash: string;
}

export const AUDIT_LOG_FORMAT = 'l0-admin-audit';
export const AUDIT_LOG_VERSION = 1;
export const GENESIS_HASH = '0'.repeat(64);
export const ADMIN_AUDIT_TABLE = 'admin_audit';

/** 规范化后求摘要：与键序无关（否则"换个序列化实现"会被判成"链断了"）  */
export function auditRecordHash(prevHash: string, record: AdminAuditRecord): string {
  const canonical = stableStringify({
    seq: record.seq,
    at: record.at,
    actor: record.actor,
    subject: record.subject,
    kind: record.kind,
    changes: record.changes.map((change) => ({ field: change.field, before: change.before, after: change.after })),
    note: record.note ?? null,
  } as unknown as JsonValue);
  return sm3Hex(utf8(`${prevHash}\n${canonical}`));
}

export type AuditChainProblem =
  | { kind: 'broken'; atLine: number; seq: number | null; reason: string }
  | { kind: 'tornTail'; atLine: number }
  | { kind: 'seqGap'; atLine: number; expected: number; actual: number };

export interface AuditLoadReport {
  firstRun: boolean;
  loaded: number;
  totalInStore: number;
  problem: AuditChainProblem | null;
  discarded: number;
}

interface AuditRow {
  seq: number;
  at: string;
  actor: string;
  subject: string;
  kind: string;
  changes: string;
  note: string | null;
  prev_hash: string;
  hash: string;
}

export class AdminAuditLog {
  private records: ChainedAdminAuditRecord[] = [];

  private readonly db: SqliteDatabase;

  constructor(db: SqliteDatabase) {
    this.db = db;
  }

  /** 账记在哪（界面要能显示它，否则"审计在哪"只能靠猜） */
  get table(): string {
    return ADMIN_AUDIT_TABLE;
  }

  entries(): ChainedAdminAuditRecord[] {
    return [...this.records];
  }

  /** 最近 N 条，最新的在前（界面与既有 `/api/admin/audit` 的展示口径一致）  */
  recent(limit: number): ChainedAdminAuditRecord[] {
    return this.records.slice(Math.max(0, this.records.length - limit)).reverse();
  }

  total(): number {
    return this.records.length;
  }

  totalInStore(): number {
    const row = this.db.prepare('select count(*) as n from admin_audit').get() as { n?: number } | undefined;
    return Number(row?.n ?? 0);
  }

  load(): AuditLoadReport {
    const rows = this.db.prepare('select * from admin_audit order by seq asc').all() as unknown as AuditRow[];
    if (rows.length === 0) {
      this.records = [];
      return { firstRun: true, loaded: 0, totalInStore: 0, problem: null, discarded: 0 };
    }

    const verified: ChainedAdminAuditRecord[] = [];
    let problem: AuditChainProblem | null = null;
    let consumed = 0;

    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index] as AuditRow;
      let parsed: ChainedAdminAuditRecord;
      try {
        parsed = {
          seq: Number(row.seq),
          at: String(row.at),
          actor: String(row.actor),
          subject: String(row.subject),
          kind: String(row.kind) as AdminAuditRecord['kind'],
          changes: JSON.parse(String(row.changes)) as AdminAuditRecord['changes'],
          ...(row.note === null || row.note === undefined ? {} : { note: String(row.note) }),
          prevHash: String(row.prev_hash),
          hash: String(row.hash),
        };
      } catch {
        problem = { kind: 'broken', atLine: index + 1, seq: Number(row.seq), reason: 'changes 不是合法 JSON（该行被改过）' };
        break;
      }
      const previous = verified[verified.length - 1];
      const expectedPrev = previous ? previous.hash : GENESIS_HASH;
      if (parsed.prevHash !== expectedPrev) {
        problem = {
          kind: 'broken',
          atLine: index + 1,
          seq: Number(parsed.seq),
          reason: `prevHash 与上一条对不上（期望 ${expectedPrev.slice(0, 12)}…，实际 ${String(parsed.prevHash).slice(0, 12)}…）`,
        };
        break;
      }
      const expectedSeq = previous ? previous.seq + 1 : 1;
      if (Number(parsed.seq) !== expectedSeq) {
        problem = { kind: 'seqGap', atLine: index + 1, expected: expectedSeq, actual: Number(parsed.seq) };
        break;
      }
      const recomputed = auditRecordHash(parsed.prevHash, parsed);
      if (recomputed !== parsed.hash) {
        problem = {
          kind: 'broken',
          atLine: index + 1,
          seq: Number(parsed.seq),
          reason: '本条内容与自身 hash 不一致（记录被改过）',
        };
        break;
      }
      verified.push(parsed);
      consumed = index + 1;
    }

    this.records = verified;
    return {
      firstRun: false,
      loaded: verified.length,
      totalInStore: rows.length,
      problem,
      discarded: rows.length - consumed,
    };
  }

  append(record: Omit<AdminAuditRecord, 'seq'>): ChainedAdminAuditRecord {
    const last = this.db.prepare('select seq, hash from admin_audit order by seq desc limit 1').get() as
      | { seq?: number; hash?: string }
      | undefined;
    const seq = (last?.seq === undefined ? 0 : Number(last.seq)) + 1;
    const prevHash = last?.hash === undefined ? GENESIS_HASH : String(last.hash);
    const base: AdminAuditRecord = {
      seq,
      at: record.at,
      actor: record.actor,
      subject: record.subject,
      kind: record.kind,
      changes: record.changes.map((change) => ({ ...change })),
      ...(record.note !== undefined ? { note: record.note } : {}),
    };
    const chained: ChainedAdminAuditRecord = { ...base, prevHash, hash: auditRecordHash(prevHash, base) };

    insertAuditRow(this.db, chained);

    this.records.push(chained);
    return chained;
  }
}

/** 写一条（供追加与一次性导入共用：两条路写进去的形态必须一字不差）  */
export function insertAuditRow(db: SqliteDatabase, record: ChainedAdminAuditRecord): void {
  db.prepare(
    `insert into admin_audit (seq, at, actor, subject, kind, changes, note, prev_hash, hash)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    record.seq,
    record.at,
    record.actor,
    record.subject,
    record.kind,
    JSON.stringify(record.changes),
    record.note ?? null,
    record.prevHash,
    record.hash,
  );
}
