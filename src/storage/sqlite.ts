/**
 * SQLite 接入层：**唯一**触碰 `node:sqlite` 的地方。
 *
 * ## 为什么是内置的 `node:sqlite`，而不是某个 npm 驱动
 *
 * 本项目运行在不保证外网、不保证能装依赖的构建环境里。`node:sqlite` 是 Node 内置的
 * SQLite 绑定（本环境 v24 可用）—— 没有依赖、没有版本冲突、没有"装不上就整条链路不可用"。
 * 代价要说清：它是**单机嵌入式**数据库，多实例共享要走文件系统语义；
 * 换成 PostgreSQL 时改的是这一层与 `work-store.ts` 的 SQL，**上层仓储接口不变**。
 *
 * ## 三条与我们既有纪律一致的取舍
 *
 * 1) **结构版本不猜**：库里记着 `schema_version`。比本程序要求的高 → **直接拒绝启动**
 *    （用新版本写过的库，用旧版本去读会"成功地"读出一份错的内容，比报错危险得多）；
 *    低 → 按迁移清单**显式**往前推，每次迁移都在一个事务里，失败即回滚。
 * 2) **异步变同步**：`DatabaseSync` 是同步 API，与本仓库既有存储层（全是同步）一致 ——
 *    不必为了"落库"把几十个调用点改成 async（那种改动会把复杂度扩散到与它无关的地方）。
 * 3) ** durability 而不是速度**：`synchronous=FULL` + `journal_mode=WAL`。
 *    这是病历数据，宁可慢一点，也不要"提交了但断电后没了"。
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** ⚠️ 本环境的类型声明里没有 `node:sqlite`，按用到的形状局部断言（同 core/persistence.ts 对 fs 的处置） */
export interface SqliteStatement {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Array<Record<string, unknown>>;
}

export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

interface SqliteModule {
  DatabaseSync: new (file: string) => SqliteDatabase;
}

/* 用**变量**做说明符：本环境的 `@types/node` 里还没有 `node:sqlite` 的声明，
   写成字面量会在编译期报"找不到模块"。运行时是真模块（Node 内置），
   所以这里既是绕开类型解析，也是在明说"类型是这个环境的短板"。 */
const sqliteSpecifier = 'node:sqlite';
const sqlite = (await import(sqliteSpecifier)) as unknown as SqliteModule;

/** 库文件里记的键（`storage_meta` 表） */
export const SCHEMA_VERSION_KEY = 'schema_version';

export interface Migration {
  /** 迁移标识（`0001-init` 这种有序、可读的名字） */
  id: string;
  /** 一句话说明"这次迁移改了什么、为什么" */
  note: string;
  sql: string[];
}

export interface OpenDatabaseOptions {
  /** 本程序要求的结构版本。库里更低 → 迁到它；更高 → 拒绝 */
  schemaVersion: number;
  migrations: readonly Migration[];
  /** 迁移执行时刻（测试可注入，保证可复现） */
  at?: string;
}

export interface OpenDatabaseResult {
  db: SqliteDatabase;
  /** 本次实际执行的迁移 id（空 = 库已是最新） */
  applied: string[];
  /** 首次建库（文件是新的） */
  fresh: boolean;
}

export class StorageError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'StorageError';
    this.code = code;
  }
}

function readMeta(db: SqliteDatabase, key: string): string | null {
  const row = db.prepare('select value from storage_meta where key = ?').get(key) as { value?: string } | undefined;
  return typeof row?.value === 'string' ? row.value : null;
}

/**
 * 打开数据库并把它迁到本程序要求的版本。
 *
 * **失败即抛**（`StorageError`）：调用方据此决定"回落到文件存储"还是"拒绝启动"。
 * 绝不返回一个"看起来能用的"半迁移库 —— 那是数据损坏最常见的入口。
 */
export function openDatabase(file: string, options: OpenDatabaseOptions): OpenDatabaseResult {
  let db: SqliteDatabase;
  let fresh = false;
  try {
    /* 父目录不存在时 SQLite 会直接报 "unable to open database file"（它不建目录）——
       同 `core/persistence.ts` 的 `writeSnapshot`：目录不存在就建，别让调用方先猜这一步。 */
    mkdirSync(dirname(file), { recursive: true });
    db = new sqlite.DatabaseSync(file);
  } catch (err) {
    throw new StorageError('E_STORAGE_OPEN_FAILED', `无法打开数据库 ${file}：${(err as Error).message}`);
  }

  try {
    /* WAL：读写不互相阻塞；FULL：提交即落盘（病历数据不接受"提交了但断电丢了"） */
    db.exec('pragma journal_mode = wal');
    db.exec('pragma synchronous = full');
    db.exec('pragma foreign_keys = on');
    db.exec('pragma busy_timeout = 5000');
    db.exec(
      'create table if not exists storage_meta (key text primary key, value text not null)',
    );
    db.exec(
      'create table if not exists schema_migrations (id text primary key, applied_at text not null, note text not null)',
    );

    const recorded = readMeta(db, SCHEMA_VERSION_KEY);
    fresh = recorded === null;
    const current = recorded === null ? 0 : Number(recorded);
    if (!Number.isInteger(current) || current < 0) {
      throw new StorageError('E_STORAGE_VERSION_INVALID', `库里的 ${SCHEMA_VERSION_KEY} 不是非负整数：${String(recorded)}`);
    }
    if (current > options.schemaVersion) {
      /* 用更新的程序写过、再用旧程序读：结构可能已经不同，猜着读会"成功地"读出错内容 */
      throw new StorageError(
        'E_STORAGE_VERSION_AHEAD',
        `数据库结构版本 ${current} 高于本程序支持的 ${options.schemaVersion}（${file}）：请升级程序，不要用旧版本读新库`,
      );
    }

    const applied = migrate(db, options, current);
    return { db, applied, fresh };
  } catch (err) {
    try {
      db.close();
    } catch {
      /* 关闭失败不掩盖真正的错误 */
    }
    if (err instanceof StorageError) throw err;
    throw new StorageError('E_STORAGE_INIT_FAILED', `初始化数据库失败（${file}）：${(err as Error).message}`);
  }
}

/** 按清单把库推到目标版本。**每个迁移一个事务**：失败即回滚，不留半个结构 */
function migrate(db: SqliteDatabase, options: OpenDatabaseOptions, current: number): string[] {
  const done = new Set(
    db.prepare('select id from schema_migrations').all().map((row) => String(row.id)),
  );
  const applied: string[] = [];
  for (const migration of options.migrations) {
    if (done.has(migration.id)) continue;
    db.exec('begin immediate');
    try {
      for (const statement of migration.sql) db.exec(statement);
      db.prepare('insert into schema_migrations (id, applied_at, note) values (?, ?, ?)').run(
        migration.id,
        options.at ?? new Date().toISOString(),
        migration.note,
      );
      db.exec('commit');
    } catch (err) {
      db.exec('rollback');
      throw new StorageError('E_STORAGE_MIGRATION_FAILED', `迁移「${migration.id}」失败（已回滚）：${(err as Error).message}`);
    }
    applied.push(migration.id);
  }
  if (applied.length > 0) {
    db.prepare('insert into storage_meta (key, value) values (?, ?) on conflict(key) do update set value = excluded.value').run(
      SCHEMA_VERSION_KEY,
      String(options.schemaVersion),
    );
  } else if (current !== options.schemaVersion) {
    /* 清单里没有可执行的迁移，却版本不符 —— 不能静默把版本号改掉（那等于凭空宣称"迁过了"） */
    throw new StorageError(
      'E_STORAGE_MIGRATION_MISSING',
      `库结构版本为 ${current}，本程序需要 ${options.schemaVersion}，但迁移清单里没有对应的迁移：请补齐迁移，不要手改版本号`,
    );
  }
  return applied;
}

/** 在一个事务里执行一段写入（失败即回滚）。用于"多表一起生效"的场景，如保存一份文书 + 它的留痕 */
export function inTransaction<T>(db: SqliteDatabase, fn: () => T): T {
  db.exec('begin immediate');
  try {
    const result = fn();
    db.exec('commit');
    return result;
  } catch (err) {
    db.exec('rollback');
    throw err;
  }
}

/** 计数用的小工具（把 `select count(*)` 的返回值收敛成 number） */
export function countOf(db: SqliteDatabase, sql: string, ...params: unknown[]): number {
  const row = db.prepare(sql).get(...params) as { n?: number | bigint } | undefined;
  const value = row?.n ?? 0;
  return typeof value === 'bigint' ? Number(value) : Number(value);
}
