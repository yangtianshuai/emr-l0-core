/**
 * 授权登记**从旧密封文件搬进库**的一次性动作。
 *
 * ## 三条规则（与 `audit-files-import.ts` 同源）
 *
 * **① 只在库里一条都没有时导入，并且**不混来源**。** 授权登记是"这台机器认不认某份授权"的唯一依据；
 * 库里已有记录时把旧文件再倒进去，等于让两批"谁被授权过"的记录并排存在，
 * 而它们的编号体系（grantId）来自不同时间点的签发平台 —— 混起来之后，
 * "这个 grantId 是哪一批的"就没人答得上来。
 *
 * **② 读不出来就不搬，且不记账。** 旧文件是密封的，解不开只有两种原因：口令不对，或文件被改过。
 * 两种都不该被"跳过继续"，也不该被记成"搬过了" —— 记了就再也不会重试，
 * 而正确的处置（找回口令 / 换用正确的文件）恰恰需要它能再试一次。
 *
 * **③ 逐条校验必需字段，坏的那条单独报出来。** 与质检规则清单同一条纪律：
 * 不因为一条坏就把整份拒绝（那会让人以为文件全废了），也不静默丢（那会让"登记少了"没人知道）。
 *
 * ## 为什么不删旧文件
 *
 * 与审计、部署参数那两处一致：**文件留着作回滚凭据**，而且删掉它会让"重跑一次"变成不可能
 * （要重跑只需删掉 `import_ledger` 里那一行）。
 */

import { existsSync } from 'node:fs';
import { loadSealedPayload } from '../core/store.ts';
import type { SqliteDatabase } from './sqlite.ts';
import { saveReadingGrant, type ReadingGrantStoreOptions } from './reading-grant-store.ts';

export const READING_GRANTS_LEDGER_ID = 'reading-grants-import';

export interface ReadingGrantsImportResult {
  /** 这次有没有真的执行（被记账拦住时为 false —— 那是**正常**结果，不是错误） */
  ran: boolean;
  imported: number;
  /** 旧文件里一共有多少条（用来核对"是不是都进来了"） */
  found: number;
  /** 被丢弃的条数（形状不对） */
  skipped: number;
  /** 旧文件本身的问题（读不出来 / 个别条目形状不对）；null = 一切正常 */
  problem: string | null;
  reason: string;
}

interface LegacyRecordShape {
  credential?: { grant?: { grantId?: unknown; docId?: unknown } };
  readCount?: unknown;
  revoked?: unknown;
}

/**
 * 从一条旧记录里取出"可查的四列"。取不出来就返回 null（由调用方计入 skipped）。
 *
 * 这里**只做最小校验**（两个 id 必须有）：整条记录原样进载荷，
 * 它的完整形状由 demo 层自己认（`storage` 不该知道 `ReadingRecord` 的全部字段）。
 */
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

/** 带记账闸门的搬家 —— 启动时该调用的就是它（在库打开、口令就位之后） */
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
    /* 没有旧文件 → **不记账**：部署时后放进来仍然该被搬一次 */
    return { ran: true, ...empty, reason: '没有旧的授权登记文件' };
  }

  const existing = Number(
    (deps.db.prepare('select count(*) as n from reading_grants').get() as { n?: number } | undefined)?.n ?? 0,
  );
  if (existing > 0) {
    /* 库里已有登记：**绝不混来源**（两批 grantId 并排存在，事后谁也说不清哪条是哪一批的） */
    deps.workStore.ledgerMark(READING_GRANTS_LEDGER_ID, `库里已有 ${existing} 条授权登记，旧文件不导入（保留原处）`);
    return { ran: true, ...empty, reason: `库里已有 ${existing} 条授权登记：不导入旧文件（不混来源）` };
  }

  const loaded = loadSealedPayload<{ version?: number; grants?: unknown[] }>(deps.file, deps.passphrase);
  if (!loaded.ok) {
    /* 读不出来**不记账**：记了就再也不会重试，而正确的处置（口令 / 文件）恰恰需要能再试 */
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
