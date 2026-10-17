/**
 * 受控阅读的**授权登记**：一条授权一行（迁移 `0007-reading-grants`）。
 *
 * ## 为什么从文件搬进库
 *
 * 原先是一个整体式的密封文件（`reading-grants.json`：把全部记录序列化后一次加密写出去）。
 * 它有文件存储那两处老毛病，这一处还多一条：
 *
 * 1. **备份带不走**：授权登记与病历属于同一批备份。恢复出病历却没有授权登记，
 *    现场是"文书在、却没人说得清它被谁看过"；
 * 2. **每次改动都要重写全量**：阅读一次就把整份登记重写一遍（次数要落盘）——
 *    授权越多，单次阅读的写放大越大；
 * 3. **它本来就有按行查询的需求**（"这份文书被谁授权过"、"哪些授权已被撤销"），
 *    而整体式存储只能整体读进内存再筛。
 *
 * ## 列与载荷的分工（与 `schema.ts` 的迁移说明同源）
 *
 * - **列**（`doc_id` / `revoked` / `read_count`）：不解密就要能答的问题 —— 列表、统计、次数门控；
 * - **载荷**（`credential` + `reads` + `sealed` 等**整条记录**）：加密落库。
 *   阅读流水含"谁在什么时候读了哪个患者的病历"，凭据含授权范围与用途 —— 与文书同一处置。
 *
 * 冗余由**同一行、同一条语句**写入保证一致；**读取一律以载荷为准**，
 * 列只用于筛选与统计（`listReadingGrants` 明确只读列，因此它**不需要口令**）。
 *
 * ## 一处刻意的严格
 *
 * 解密失败（口令换过 / 那一行被改过）**绝不当作"没有这条授权"**：
 * 那会把"数据坏了"伪装成"本来就没授权过"，而后者在界面上看起来是完全正常的。
 * 所以 `loadReadingGrant` 与 `loadAllReadingGrants` 都把失败显式报出来。
 */

import { countOf, inTransaction, type SqliteDatabase } from './sqlite.ts';
import { sealFor, unsealValue, type SealOptions } from './sealed.ts';
import { READING_GRANT_FORMAT } from './formats.ts';

/** 一条授权在库里的形状：可查的四列 + 一条完整的加密载荷 */
export interface ReadingGrantRecord {
  grantId: string;
  docId: string;
  revoked: boolean;
  readCount: number;
  /** 整条记录（授权书 / 公钥 / 阅读流水 / 加密交付片段）：**原样**加密落库，形状由调用方定 */
  payload: unknown;
}

/** 列表与统计用的**轻量行**（只读列，不解密，因此不需要口令） */
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

/**
 * 写一行（授权导入 / 撤销 / 阅读记账都走它）。
 *
 * 列与载荷在**同一条 upsert 语句**里写：不会出现"列说撤销了、载荷还说没撤"这种半截状态。
 */
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

/** 读一条授权（解密）。**解不开就报错**，不当作"没有这条授权" */
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

/**
 * 列出一批授权（**只读列，不解密**）。
 *
 * 为什么专门给一个不解密的入口：界面列表、统计、"哪些还生效"都只需要这几列，
 * 而解密每一行要付一次 PBKDF2 派生的代价（首次约 7.6 秒）—— 那会让一个纯查询变成慢操作。
 */
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

/** 读全部授权（**解密**）。启动时恢复内存索引用它；任何一行解不开就整批报错 */
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

/**
 * 全量同步：把表的内容变成 `records`（不在列表里的行删掉，其余 upsert）。
 *
 * 为什么保留"全量"这个语义：内存里那份索引就是权威（阅读记账、撤销都在那里改），
 * 而整体式文件时代的行为也正是"每次改动写一次全量"。按行增量是下一步的优化，
 * 不是这一轮该顺手改掉的语义 —— 改了它，就得同时回答"内存与库谁先谁后"。
 */
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

/** 清空授权登记（「重置工作区」用）：返回清掉的行数 */
export function clearReadingGrants(db: SqliteDatabase): number {
  return Number(db.prepare('delete from reading_grants').run().changes);
}

/** 不解密的统计：界面上"这台机器登记过多少授权、其中多少已撤销" */
export function countReadingGrants(db: SqliteDatabase): { total: number; revoked: number } {
  return {
    total: countOf(db, 'select count(*) as n from reading_grants'),
    revoked: countOf(db, 'select count(*) as n from reading_grants where revoked = 1'),
  };
}
