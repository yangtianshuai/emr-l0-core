/**
 * 口令轮换：把库里**所有密封行**从旧口令换成新口令。
 *
 * ## 为什么必须有它
 *
 * 口令从环境变量搬进库之后，多了一个共享口令时代没有的失败模式：
 * **换口令需要把已经写进去的每一行都重新密封一遍**。没有工具时，唯一的办法是
 * 导出、解密、再导入 —— 而那需要知道信封格式、盐的来源、摘要列的口径，不是能写进运维手册的路。
 * 更糟的是"没有工具的轮换"会停在半路：新写的行用新口令，历史行还是旧口令，
 * 而服务只认一把口令 → 现场表现是"一部分病历读不出来"，且**看起来像数据损坏**。
 *
 * ## 三条硬规矩
 *
 * 1. **先读通全部，再写任何一行**。逐行解密全部成功才进入写入阶段；任何一行解不开
 *    （口令给错 / 那行被改过）就**整批中止，库一字未动**。理由与 `core/store.ts` 的
 *    `resealSidecars` 完全相同：用错口令覆盖唯一一份数据，比"没轮换"严重得多。
 * 2. **写入在一个事务里**。中途失败整体回滚 —— 不会留下"一半新口令、一半旧口令"的库，
 *    而那恰恰是最难收拾的状态（两把口令都打不开全部）。
 * 3. **只动密文与摘要列**，不动 `updated_at` / `stored_at`：它们回答"这份数据/这份配置
 *    是什么时候被改的"，而轮换**没有改内容**。把时间戳刷新一遍，等于让审计里那行
 *    "配置何时改的"变成假话。
 *
 * ## 调用方必须自己保证的事
 *
 * **先停掉服务进程**。原因不是文件锁，而是语义：服务内存里持有的是旧口令派生的密钥与
 * 派生缓存，它在轮换进行中写入的任何一行都会用旧口令 —— 事务保护不了这种"跨进程混合"。
 * 这条由 `core/rekey-cli.ts` 在输出里明确提醒，代码层无法可靠检测。
 *
 * ## 已知边界（如实写下来）
 *
 * - **全量载入内存**：为保证"先读通全部再写"，所有载荷会被解密到内存里。
 *   演示与科室规模足够（几十份文书）；上千份文书时应改成分批 + 每批一个事务，
 *   代价是失去"整批原子"这个性质 —— 那是一个需要显式权衡的设计决定，不是顺手能改的小事。
 * - **不碰不加密的表**（`admin_audit` / `admin_audit_anchor` / `recipient_keys` / `knowledge_packs`）：
 *   它们本来就不是密封载荷（见 `schema.ts` 的文件头），轮换对它们无事可做。
 * - **不轮换盐**：盐不是秘密、且解密用的永远是信封头部那一个（见 `core/store.ts`）。
 *   本模块可以顺带换盐（`newSalt`），但"换盐不换口令"另有 `npm run salt:reseal` 那条路。
 */

import { inTransaction, type SqliteDatabase } from './sqlite.ts';
import { sealValue, unsealValue } from './sealed.ts';

/** 新旧口令（且未指定新盐）相同时拒绝：那种"轮换"什么也没换 */
export const REKEY_SAME_KEY_CODE = 'E_REKEY_SAME_KEY';
/** 有行读不通（口令错 / 那一行被改过）：整批中止，库一字未动 */
export const REKEY_UNREADABLE_CODE = 'E_REKEY_UNREADABLE';
export const REKEY_NO_KEY_CODE = 'E_REKEY_NO_KEY';

/** 三处密封载荷各有多少行 */
export interface RekeyScope {
  documents: number;
  sidecars: number;
  kv: number;
}

export interface RekeyPlan {
  scope: RekeyScope;
  total: number;
}

export type RekeyOutcome =
  | { ok: true; plan: RekeyPlan; /** true = 真的重写过；false = 只做了检查（试运行） */ applied: boolean }
  | { ok: false; code: string; message: string };

export interface RekeyOptions {
  /**
   * 新盐（32 位 hex）。不传 = **按新口令派生**（与 `resolveStateSalt` 同一口径）。
   * 注意：这与"沿用旧盐"不是一回事 —— 要沿用就把服务端配置里的盐显式传进来。
   */
  newSalt?: string;
  /** 写入时刻（测试可注入，保证可复现）；只用于日志与返回值，不写进任何时间戳列 */
  at?: string;
  /** 测试与复现专用：显式派生迭代数（理由同 `sealValue` 的注释） */
  iterations?: number;
}

interface SealedRow {
  table: 'documents' | 'sidecars' | 'sealed_kv';
  /** `documents` / `sidecars` 用 doc_id，`sealed_kv` 用 key */
  id: string;
  digest: string;
  sealed: string;
}

function rowOf(raw: unknown, table: SealedRow['table'], idField: string): SealedRow {
  const row = raw as Record<string, unknown>;
  return {
    table,
    id: String(row[idField]),
    digest: String(row.payload_digest),
    sealed: String(row.payload_sealed),
  };
}

/** 读出三处全部密封行（**只读密文**，不解密：这一步不该付出派生的代价） */
function readSealedRows(db: SqliteDatabase): SealedRow[] {
  const rows: SealedRow[] = [];
  for (const raw of db.prepare('select doc_id, payload_digest, payload_sealed from documents').all()) {
    rows.push(rowOf(raw, 'documents', 'doc_id'));
  }
  for (const raw of db.prepare('select doc_id, payload_digest, payload_sealed from sidecars').all()) {
    rows.push(rowOf(raw, 'sidecars', 'doc_id'));
  }
  for (const raw of db.prepare('select key, payload_digest, payload_sealed from sealed_kv').all()) {
    rows.push(rowOf(raw, 'sealed_kv', 'key'));
  }
  return rows;
}

function scopeOf(rows: readonly SealedRow[]): RekeyScope {
  return {
    documents: rows.filter((row) => row.table === 'documents').length,
    sidecars: rows.filter((row) => row.table === 'sidecars').length,
    kv: rows.filter((row) => row.table === 'sealed_kv').length,
  };
}

/**
 * 逐行解密。**任何一行失败就整体失败**（调用方据此中止，不写任何东西）。
 *
 * 报告里带上行号与身份，而不是一句"解密失败"：口令给错与"某一行被改过"是两件事，
 * 而它们的现场表现一模一样 —— 前者是"全部行都失败"，后者是"只有那一行失败"。
 * 把失败**行数与位置**写清楚，运维才能一眼分出自己踩的是哪一种。
 */
function decodeAll(
  rows: readonly SealedRow[],
  key: string,
  options: { iterations?: number },
): { ok: true; values: unknown[] } | { ok: false; code: string; message: string } {
  void options;
  const values: unknown[] = [];
  for (const [index, row] of rows.entries()) {
    const unsealed = unsealValue<unknown>({ digest: row.digest, sealed: row.sealed }, key);
    if (!unsealed.ok) {
      return {
        ok: false,
        code: REKEY_UNREADABLE_CODE,
        message:
          `第 ${index + 1}/${rows.length} 行（${row.table} · ${row.id}）读不通：${unsealed.message}。` +
          '**未改动任何数据**。若每一行都这样，是旧口令给错了；只有个别行这样，是那一行的数据坏了 —— 两者的处置不同，先别急着换口令',
      };
    }
    values.push(unsealed.data);
  }
  return { ok: true, values };
}

/**
 * 试运行：只回答"有几行、能不能全部读通"。**不写任何东西**。
 *
 * 为什么先给这一步：轮换是不可逆的（换完旧口令就打不开了），而执行前最该确认的
 * 恰好是"我拿的这把旧口令对不对"。让它在真正动手前就暴露，代价是零。
 */
export function planRekey(db: SqliteDatabase, oldKey: string): RekeyOutcome {
  if (!oldKey) {
    return { ok: false, code: REKEY_NO_KEY_CODE, message: '缺少旧口令：没有口令就没有"读通"可言（拒绝按明文处理）' };
  }
  const rows = readSealedRows(db);
  const decoded = decodeAll(rows, oldKey, {});
  if (!decoded.ok) return { ok: false, code: decoded.code, message: decoded.message };
  return { ok: true, plan: { scope: scopeOf(rows), total: rows.length }, applied: false };
}

/**
 * 执行轮换：**先全部读通，再在一个事务里逐行重密封**。
 *
 * `newKey` 与新盐必须由调用方给出；两者都与旧值相同时**拒绝** ——
 * 让一次什么都没换的运维动作**失败**，而不是打印"完成"。
 */
export function applyRekey(
  db: SqliteDatabase,
  oldKey: string,
  newKey: string,
  options: RekeyOptions = {},
): RekeyOutcome {
  if (!oldKey) {
    return { ok: false, code: REKEY_NO_KEY_CODE, message: '缺少旧口令：拒绝在没有"能读通"的前提下重写库' };
  }
  if (!newKey) {
    return { ok: false, code: REKEY_NO_KEY_CODE, message: '缺少新口令：拒绝用空口令重写（那等于把数据交给任何能读到库文件的人）' };
  }
  if (newKey === oldKey && options.newSalt === undefined) {
    return {
      ok: false,
      code: REKEY_SAME_KEY_CODE,
      message: '新旧口令相同、且没有指定新盐：这次轮换不会改变任何东西，拒绝执行（它只会让日志上多一条"已完成"）',
    };
  }

  const rows = readSealedRows(db);
  /* 阶段一：全部读通。这一步之后才允许写 —— 顺序反了就是"用错口令覆盖唯一一份数据" */
  const decoded = decodeAll(rows, oldKey, options);
  if (!decoded.ok) return { ok: false, code: decoded.code, message: decoded.message };

  const values = decoded.values;
  /* 阶段二：一个事务里全部重密封（信封每次写入都换 IV，于是摘要与密文一起变） */
  try {
    inTransaction(db, () => {
      rows.forEach((row, index) => {
        const sealed = sealValue(values[index], newKey, {
          ...(options.newSalt === undefined ? {} : { salt: options.newSalt }),
          ...(options.iterations === undefined ? {} : { iterations: options.iterations }),
        });
        if (row.table === 'documents') {
          db.prepare('update documents set payload_digest = ?, payload_sealed = ? where doc_id = ?')
            .run(sealed.digest, sealed.sealed, row.id);
        } else if (row.table === 'sidecars') {
          db.prepare('update sidecars set payload_digest = ?, payload_sealed = ? where doc_id = ?')
            .run(sealed.digest, sealed.sealed, row.id);
        } else {
          /* `updated_at` **刻意不更新**：它回答"这份配置何时被改"，而轮换没改内容 */
          db.prepare('update sealed_kv set payload_digest = ?, payload_sealed = ? where key = ?')
            .run(sealed.digest, sealed.sealed, row.id);
        }
      });
    });
  } catch (err) {
    return {
      ok: false,
      code: 'E_REKEY_WRITE_FAILED',
      message: `重写失败，已整体回滚（库仍是旧口令，可继续用）：${(err as Error).message}`,
    };
  }
  void options.at;
  return { ok: true, plan: { scope: scopeOf(rows), total: rows.length }, applied: true };
}

/** 给运维看的行数与分布（试运行与执行后都用同一句话） */
export function describeRekeyPlan(plan: RekeyPlan): string {
  if (plan.total === 0) return '库里没有任何密封行（空库：轮换无事可做）';
  return `文档 ${plan.scope.documents} 行 / 旁挂数据 ${plan.scope.sidecars} 行 / 配置与整体式数据 ${plan.scope.kv} 行，合计 ${plan.total} 行`;
}
