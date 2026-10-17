/**
 * 管理动作审计：**入库 + 链式摘要**（原先是一个 NDJSON 文件）。
 *
 * ## 为什么它必须留存（与落盘哪个载体无关）
 *
 * 审计回答的是"谁在什么时候把哪一格从什么改成了什么"。内存态时它有三个说不通的地方：
 *   ① 进程一重启，记录全没 —— 而"重启过了"这件事**没有任何痕迹**；
 *   ② 有人改配置、后来出问题，翻出来的是一份**从上次重启起**的账；
 *   ③ 为了防膨胀而"丢最旧"（原实现保留最近 500 条），于是**旧记录被静默删除** ——
 *      一份会自动丢历史的记录，不能作为审计证据。
 * 项目自己对这件事的判词很直接：**一份看起来像审计的记录，比没有更危险**。
 *
 * ## 为什么从文件搬进库（三条具体理由）
 *
 *   ① **审计要与它审计的数据待在同一个可恢复单元里**：恢复一份数据库时账要跟着回来；
 *   ② **多进程互相污染**：文件是"各自追加"，两个进程各有各的内存链，实测撞到
 *      同一份文件里混着两条互不相容的链的锚（286 条）。库里只有一份链，两个进程读同一条；
 *   ③ `seq` 成为**主键**：序号重复/乱序在库层面就不可能（文件时代只能靠读的时候发现）。
 *
 * 同一条纪律**变得更硬**：两个进程同时追加时，后到的会因为 `seq` 主键冲突而**失败**——
 * 那是可发现的失败，比"两条链混在一份文件里"好得多。
 *
 * ## 链式摘要防什么、不防什么
 *
 * 每条记录带上 `prevHash` 与 `hash = SM3(prevHash ‖ 规范化(记录))`，于是**改动任何一条历史**
 * 都会让它之后的所有 `hash` 对不上 —— 加载时能**指认断在第几条**，且只保留断点之前的记录
 * （不把未经验证的条目当成可信的展示出来）。
 *
 * **但它不防"有权限的人"**：能改库的人也能把整条链重算一遍。它防的是
 * "悄悄改掉一条旧记录"这类**局部篡改**。真正的防篡改要靠签名与外部存证 ——
 * 把这条写成"审计已防篡改"是最不该给出去的一句承诺（同 `persistence.ts` 的摘要口径）。
 *
 * ## 断点之后的记录**不删**
 *
 * 校验不过就停在断点、不展示后面的条目，但它们**留在库里**（`discarded` 只报数）。
 * 删掉它们就是"审计系统自己销毁证据" —— 而那正是最不该由它来做的一件事。
 */

import type { SqliteDatabase } from '../storage/sqlite.ts';
import { stableStringify } from '../model/hash.ts';
import { sm3Hex, utf8 } from '../crypto/sm3.ts';
import type { JsonValue } from '../model/types.ts';

/** 一条管理动作审计（与界面展示的字段一一对应） */
export interface AdminAuditRecord {
  seq: number;
  at: string;
  actor: string;
  subject: string;
  kind: '变更' | '动作';
  changes: Array<{ field: string; before: string; after: string }>;
  note?: string;
}

/** 入库形态：在记录之上补两个哈希（`prevHash` 指向**上一条**，`hash` 是这条自己的） */
export interface ChainedAdminAuditRecord extends AdminAuditRecord {
  prevHash: string;
  hash: string;
}

export const AUDIT_LOG_FORMAT = 'l0-admin-audit';
export const AUDIT_LOG_VERSION = 1;
/** 首条的 `prevHash`：全零。写死一个常量值而不是空串，是为了让"缺 prevHash"能被显式校验出来 */
export const GENESIS_HASH = '0'.repeat(64);
/** 表名（界面上要显示"账记在哪"，所以它是个对外可说的名字，不是内部细节） */
export const ADMIN_AUDIT_TABLE = 'admin_audit';

/** 规范化后求摘要：**与键序无关**（否则"换个序列化实现"会被判成"链断了"） */
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
  /**
   * 尾行不完整：崩溃/断电的典型形态，**不是**篡改（处置完全不同，故分开报）。
   *
   * 入库之后这类损坏**不可能再发生**（一行要么在、要么不在）；这个分支只剩一个来源：
   * **导入旧文件**时旧文件的尾行被撕断（见 `storage/audit-files-import.ts`）。
   * 保留它是因为"导入时截断"必须与"库里有人改过"分开说 —— 前者不用查，后者要查。
   */
  | { kind: 'tornTail'; atLine: number }
  /** 序号不连续：`seq` 一直写在记录里、也一直参与摘要，但**此前没有任何校验读过它** */
  | { kind: 'seqGap'; atLine: number; expected: number; actual: number };

export interface AuditLoadReport {
  /** 库里一条都没有：首次启动，可以建新账（**不是**"失败了"） */
  firstRun: boolean;
  /** 通过校验的记录数（**只有这些会被展示**） */
  loaded: number;
  /** 库里一共有多少条（含断点之后的） */
  totalInStore: number;
  /** 哪里出的问题；null = 整条链都验过了 */
  problem: AuditChainProblem | null;
  /** 断点之后**未展示**的条目数（如实上报：**没能验证 ≠ 没有**；它们仍留在库里） */
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

  /** 已通过校验、可展示的记录（追加顺序） */
  entries(): ChainedAdminAuditRecord[] {
    return [...this.records];
  }

  /** 最近 N 条，**最新的在前**（界面与既有 `/api/admin/audit` 的展示口径一致） */
  recent(limit: number): ChainedAdminAuditRecord[] {
    return this.records.slice(Math.max(0, this.records.length - limit)).reverse();
  }

  total(): number {
    return this.records.length;
  }

  /** 库里的总行数（含未通过校验的那些）—— 与"可展示的条数"分开报 */
  totalInStore(): number {
    const row = this.db.prepare('select count(*) as n from admin_audit').get() as { n?: number } | undefined;
    return Number(row?.n ?? 0);
  }

  /**
   * 读库并**逐条验链**。
   *
   * 校验不过就停在断点：**不修补、不跳过、不把后面的条目当好数据展示**。
   * "跳过坏的那条继续读"会让篡改看起来只是"少了一条"，而那正是审计最不能出的错。
   */
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
        /* `changes` 不是合法 JSON：库里的行被改过（写入时一定是合法 JSON） */
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
      /* `seq` 校验：主键只保证"不重复"，**不保证连续**（删掉中间一条就断号了）。
         它拦的是"拼接/错位"这类粗改：从别处搬来的片段、漏号、被改过序号的记录。
         **它不增加防篡改能力**：完整重写整条链的人照样能把 seq 一起写顺 ——
         那要靠链头锚点（见 `admin-audit-anchor.ts`）。 */
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
      /** 断点之后**不展示**，但绝不删除（删掉就是"审计系统自己销毁证据"） */
      discarded: rows.length - consumed,
    };
  }

  /**
   * 追加一条。返回入库后的记录（含两个哈希）。
   *
   * 链头每次都从**库里最后一行的 hash** 取（不是内存副本）：这样即便有另一个进程
   * 也在追加，接上的仍是同一条链 —— 而"接不上"的形态是 `seq` 主键冲突（可发现的失败）。
   *
   * **写失败会抛**：审计没写上必须让调用方知道（由调用方决定怎么如实告知使用者）。
   * 这里不做"吞掉错误继续跑" —— 那会让"这一次动作没有审计"变成一件没人知道的事。
   */
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

/** 写一条（供追加与**一次性导入**共用：两条路写进去的形态必须一字不差） */
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
