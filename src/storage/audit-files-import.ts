/**
 * 管理审计与锚点**从旧 NDJSON 文件搬进库**的一次性动作。
 *
 * ## 三条只有在这里才说得清的规则
 *
 * **① 只在库里一条都没有时导入。** 两套链不能混：库里的第一条必须是"链的开头"，
 * 否则逐条验链会在第一条就断（`prevHash` 对不上零值），而那是**看起来最像篡改**的一种形态。
 * 所以：库里已有记录 → 不导入、只记账（旧文件留着作凭据）。
 *
 * **② 只导入**验过的那一段**。** 旧文件可能是被撕断的尾行、也可能中间被人改过 ——
 * 两者都**只导入断点之前**的记录，并把问题如实报出来（不修补、不跳过）。
 * 这与"审计系统不销毁证据"一致：**文件本身不动**，断点之后的记录留在原处。
 *
 * **③ 锚点只保留"指向本次导入链上"的那些。** 这一点是刻意的清理，不是顺手：
 * 旧文件时代多进程各自追加，实测同一份文件里混着**两条互不相容的链的锚**（286 条）。
 * 把它们照搬进库，等于把那个混乱原样封存；只留指向本链的锚，
 * 才是"锚点回答的问题"（这条链在某个时刻是什么样）。丢掉的条数**如实报**。
 *
 * ## 记账（同部署参数那条教训）
 *
 * 记了账就不再碰旧文件。否则"库里没有就从旧文件导"会每次启动重演 ——
 * 而管理员**清空审计**（比如换了合规要求）之后，旧文件会把清掉的记录**悄悄导回来**。
 */

import { existsSync, readFileSync } from 'node:fs';
import { GENESIS_HASH, auditRecordHash, insertAuditRow, type ChainedAdminAuditRecord } from '../core/admin-audit-store.ts';
import type { AuditAnchor } from '../core/admin-audit-anchor.ts';
import type { SqliteDatabase } from '../storage/sqlite.ts';

export const LEGACY_AUDIT_LEDGER_ID = 'admin-audit-files-import';

export interface AuditImportResult {
  /** 这次有没有真的执行（被记账拦住时为 false —— 那是**正常**结果） */
  ran: boolean;
  records: number;
  anchors: number;
  /** 指向"不在本次导入链上"的锚点数（旧文件时代的污染，如实报） */
  droppedAnchors: number;
  /** 旧文件里的问题（撕断的尾行 / 中间被改过）；null = 整份都验过了 */
  problem: string | null;
  reason: string;
}

interface LegacyLineResult {
  records: ChainedAdminAuditRecord[];
  problem: string | null;
  /** 文件里一共有多少行（含断点之后的） */
  totalLines: number;
}

/**
 * 读旧文件并**逐条验链**。
 *
 * 这段逻辑只此一处：文件格式已经没有别的读者了（写入早就走库）。
 * 之所以不删掉"能读旧文件"的能力，是因为**搬家要能重跑**（删掉记账那行即可），
 * 而重跑时得能再验一遍旧文件的链 —— 否则"导进来的东西可信吗"就答不上来。
 */
export function readLegacyAuditFile(file: string): LegacyLineResult {
  const text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const lines = text.split('\n');
  const rawLines = lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines;

  const verified: ChainedAdminAuditRecord[] = [];
  let problem: string | null = null;
  for (let index = 0; index < rawLines.length; index += 1) {
    const line = rawLines[index] as string;
    let parsed: ChainedAdminAuditRecord;
    try {
      parsed = JSON.parse(line) as ChainedAdminAuditRecord;
    } catch {
      problem =
        index === rawLines.length - 1
          ? `旧审计文件尾行不完整（第 ${index + 1} 行）：崩溃留下的残行，只导入它之前的 ${verified.length} 条`
          : `旧审计文件第 ${index + 1} 行不是合法 JSON（中间行损坏，疑似被改动）`;
      break;
    }
    const previous = verified[verified.length - 1];
    const expectedPrev = previous ? previous.hash : GENESIS_HASH;
    if (parsed.prevHash !== expectedPrev) {
      problem = `旧审计文件第 ${index + 1} 行的 prevHash 与上一条对不上（链断在这里）`;
      break;
    }
    const expectedSeq = previous ? previous.seq + 1 : 1;
    if (Number(parsed.seq) !== expectedSeq) {
      problem = `旧审计文件第 ${index + 1} 行序号不连续（期望 ${expectedSeq}，实际 ${Number(parsed.seq)}）`;
      break;
    }
    if (auditRecordHash(parsed.prevHash, parsed) !== parsed.hash) {
      problem = `旧审计文件第 ${index + 1} 行内容与自身 hash 不一致（被改过）`;
      break;
    }
    verified.push(parsed);
  }
  return { records: verified, problem, totalLines: rawLines.length };
}

function readLegacyAnchorFile(file: string): { anchors: AuditAnchor[]; problem: string | null } {
  const text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const lines = text.split('\n');
  const rawLines = lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines;
  const anchors: AuditAnchor[] = [];
  let problem: string | null = null;
  for (let index = 0; index < rawLines.length; index += 1) {
    try {
      const item = JSON.parse(rawLines[index] as string) as AuditAnchor;
      if (!Number.isInteger(item.seq) || typeof item.hash !== 'string' || typeof item.at !== 'string') {
        problem = `旧锚点文件第 ${index + 1} 行缺少必要字段（seq/hash/at）`;
        break;
      }
      anchors.push(item);
    } catch {
      problem =
        index === rawLines.length - 1
          ? `旧锚点文件尾行不完整（第 ${index + 1} 行）：崩溃留下的残行，已忽略`
          : `旧锚点文件第 ${index + 1} 行不是合法 JSON（中间行损坏，疑似被改动）`;
      break;
    }
  }
  return { anchors, problem };
}

/** 带记账闸门的搬家 —— 启动时该调用的就是它 */
export function importAuditOnce(deps: {
  workStore: { ledgerHas(id: string): boolean; ledgerMark(id: string, note: string): void };
  db: SqliteDatabase;
  auditFile: string;
  anchorFile: string;
  exists?: (path: string) => boolean;
}): AuditImportResult {
  const empty = { records: 0, anchors: 0, droppedAnchors: 0, problem: null };
  if (deps.workStore.ledgerHas(LEGACY_AUDIT_LEDGER_ID)) {
    return { ran: false, ...empty, reason: '已经搬过一次（记账在库里）：不再看旧文件' };
  }
  const exists = deps.exists ?? existsSync;
  const hasAuditFile = exists(deps.auditFile);
  const hasAnchorFile = exists(deps.anchorFile);
  if (!hasAuditFile && !hasAnchorFile) {
    /* 没有旧文件 → **不记账**：部署时后放进来仍然该被搬一次 */
    return { ran: true, ...empty, reason: '没有旧的审计文件' };
  }

  const existing = Number((deps.db.prepare('select count(*) as n from admin_audit').get() as { n?: number } | undefined)?.n ?? 0);
  if (existing > 0) {
    /* 库里已有链：**绝不混**（混进去会在第一条就断，而那是看起来最像篡改的形态） */
    deps.workStore.ledgerMark(LEGACY_AUDIT_LEDGER_ID, `库里已有 ${existing} 条审计记录，旧文件不导入（保留原处）`);
    return { ran: true, ...empty, reason: `库里已有 ${existing} 条审计记录：不导入旧文件（两套链不能混）` };
  }

  const result: AuditImportResult = { ran: true, ...empty, reason: '已把旧文件搬进库' };
  if (hasAuditFile) {
    const legacy = readLegacyAuditFile(deps.auditFile);
    for (const record of legacy.records) insertAuditRow(deps.db, record);
    result.records = legacy.records.length;
    result.problem = legacy.problem;
    const onChain = new Set(legacy.records.map((record) => `${record.seq}:${record.hash}`));
    if (hasAnchorFile) {
      const anchors = readLegacyAnchorFile(deps.anchorFile);
      for (const anchor of anchors.anchors) {
        /* **只留指向本次导入链上的锚**：旧文件里可能混着另一条链的锚
           （多进程各自追加留下的污染），那些指着链外，照搬进库只会把混乱封存起来。 */
        if (!onChain.has(`${anchor.seq}:${anchor.hash}`)) {
          result.droppedAnchors += 1;
          continue;
        }
        deps.db
          .prepare(
            `insert or ignore into admin_audit_anchor (head_seq, head_hash, at, signature, signer_fingerprint)
             values (?, ?, ?, ?, ?)`,
          )
          .run(anchor.seq, anchor.hash, anchor.at, anchor.signature ?? null, anchor.signerFingerprint ?? null);
        result.anchors += 1;
      }
      result.problem = result.problem ?? anchors.problem;
    }
  } else if (hasAnchorFile) {
    /* 只有锚点、没有审计：锚指向的链不在库里，导入它们毫无意义（保留文件待查） */
    result.reason = '只有锚点文件、没有审计文件：不导入（锚指向的链不在库里）';
  }

  deps.workStore.ledgerMark(
    LEGACY_AUDIT_LEDGER_ID,
    `从旧文件搬入 ${result.records} 条审计、${result.anchors} 条锚点` +
      (result.droppedAnchors > 0 ? `（丢弃 ${result.droppedAnchors} 条指向链外的锚）` : ''),
  );
  return result;
}
