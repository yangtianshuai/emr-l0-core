// 留痕账（链式，只追加）。
//
// 原先保存文书时把留痕整批删掉重写一遍（`delete from document_revisions` + 全量 insert）。
// 那样做，"删掉一条留痕"在库里不留任何破绽 —— 审计问"这条记录怎么没了"，
// 库里答"从来没有过"，而文书里的留痕是重新算出来的，看不出少过一条。
// 留痕账改链式追加之后，删一条 = 链断一节，验链当场发现。
//
// 写法与 `admin-audit-store`（管理动作审计）是同一套：每条自带 `prev_hash` 指向上一条，
// `hash` 是"链头 + 本条内容"的摘要。差别只在链的粒度：那边全库一条链（管理动作少），
// 这边按文书各一条链（留痕多，一条链跨文书会让"这份的账"与"那份的账"互相牵连）。
//
// 一条规矩：账只追加，不改写、不删除。文档被删除时留痕随之外键级联（那是"文书没了"，
// 不是"留痕没了"）；文书存续期间，账上发生过的就是发生过。

import type { SqliteDatabase } from '../storage/sqlite.ts';
import { StorageError } from '../storage/sqlite.ts';
import { stableStringify } from '../model/hash.ts';
import { sm3Hex, utf8 } from '../crypto/sm3.ts';
import type { JsonValue, RevisionEntry } from '../model/types.ts';

/** 表名（界面上要能显示"留痕记在哪"） */
export const REVISION_LEDGER_TABLE = 'document_revisions';
/** 首条的 `prev_hash`：全零。写死常量而不是空串，是为了让"缺 prev_hash"能被显式校验出来 */
export const GENESIS_HASH = '0'.repeat(64);
/** 账与文档对不上（留痕被改或被丢） */
export const E_REVISION_LEDGER_TAMPERED = 'E_REVISION_LEDGER_TAMPERED';
/** 账被撕过：账上有的留痕，文档里没有 */
export const E_REVISION_LEDGER_TORN = 'E_REVISION_LEDGER_TORN';

interface LedgerRow {
  rev: number;
  payload: string;
  prev_hash: string;
  hash: string;
}

/**
 * 留痕的规范化形态：与键序无关、字段齐全（缺的写 `null`）。
 *
 * 与键序无关是必须的：换个序列化实现就"链断了"，那是在惩罚实现差异，不是在防篡改。
 * 字段齐全是必须的：新增一个载荷字段却忘了进摘要，等于那条字段可以不留痕迹地改 ——
 * 所以下面的清单是显式的（有意不写"整个对象丢进去"，那样新字段会悄悄溜出摘要）。
 *
 * patch 里带着改前的值（`oldValue`）：它回答"改前是什么"，也是撤销/回到历史版本的依据。
 */
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

/** 本条的摘要 = 链头 + 本条内容 */
export function revisionEntryHash(prevHash: string, canonical: string): string {
  return sm3Hex(utf8(`${prevHash}\n${canonical}`));
}

export interface AppendRevisionsReport {
  /** 本次新入库的条数 */
  appended: number;
  /** 已在账上、本次没动的条数 */
  kept: number;
  /** 链头（最后一条的 hash）；空账时为 null */
  head: string | null;
}

/**
 * 把文档里的留痕接到账上：只追加，不删不改。
 *
 * 已经入库的那些条要逐条对一遍（内容、链位置、摘要）：这是"账 = 文档留痕"这条
 * 等式的日常体检。不查的话，"有人直接改了库里的留痕"会安静地活到下一次审计。
 *
 * 查出来对不上就抛：**不修补、不覆盖、不跳过**。修补等于替篡改者把账做平，
 * 那比坏账更糟 —— 坏账务必让人看见。
 */
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
      /* 留痕按 rev 连续成链：缺一条就是账被撕过（不是"少存了一条"） */
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

  /* 账上有、文档没有：那不是"还没保存"，是留痕被丢了 */
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
  /** 本条内容与自己的 hash 不符（记录被改过） */
  | { kind: 'tampered' | 'broken'; atRev: number; reason: string }
  /** 序号不连续 */
  | { kind: 'revGap'; atRev: number; expected: number; actual: number };

export interface RevisionLedgerReport {
  /** 这份文书还没有留痕账（首次保存）—— 不是"失败了" */
  firstRun: boolean;
  /** 通过校验、可展示的条数 */
  loaded: number;
  /** 库里一共有多少条（含断点之后的） */
  totalInStore: number;
  /** 链头：这份文书的账"说到哪一句"（供对外展示与锚定） */
  head: string | null;
  /** 哪里出的问题；null = 整条链都验过了 */
  problem: RevisionLedgerProblem | null;
  /** 断点之后未展示的条数（如实上报：没能验证 ≠ 没有；它们仍留在库里） */
  discarded: number;
}

/**
 * 读账并逐条验链。
 *
 * 校验不过就停在断点：不修补、不跳过、不把后面的条目当好数据展示。
 * "跳过坏的那条继续读"会让篡改看起来只是"少了一条"，而那正是审计最不能出的错。
 */
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
    /* 断点之后链头就没有意义了：它指向的那一节没验过 */
    head: problem === null ? prevHash : null,
    problem,
    discarded: rows.length - consumed,
  };
}

/** 把规范化形态还原成留痕（`canonical` 里缺失的字段写成 `null`，还原时去掉） */
export function parseRevisionPayload(payload: string): RevisionEntry {
  const raw = JSON.parse(payload) as Record<string, unknown>;
  const entry: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value !== null) entry[key] = value;
  }
  return entry as unknown as RevisionEntry;
}

/** 读出这份文书的留痕（只含验过链的那些；断点之后的留在库里，但不展示） */
export function readRevisionLedger(db: SqliteDatabase, docId: string): { report: RevisionLedgerReport; entries: RevisionEntry[] } {
  const report = loadRevisionChain(db, docId);
  if (report.loaded === 0) return { report, entries: [] };
  const rows = db
    .prepare(`select rev, payload from ${REVISION_LEDGER_TABLE} where doc_id = ? order by rev asc limit ?`)
    .all(docId, report.loaded) as unknown as Array<{ payload: string }>;
  return { report, entries: rows.map((row) => parseRevisionPayload(String(row.payload))) };
}
