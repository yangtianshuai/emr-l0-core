import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

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

const sqliteSpecifier = 'node:sqlite';
const sqlite = (await import(sqliteSpecifier)) as unknown as SqliteModule;

export const SCHEMA_VERSION_KEY = 'schema_version';

export interface Migration {
  id: string;
  note: string;
  sql: string[];
}

export interface OpenDatabaseOptions {
  schemaVersion: number;
  migrations: readonly Migration[];
  at?: string;
}

export interface OpenDatabaseResult {
  db: SqliteDatabase;
  applied: string[];
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

export function openDatabase(file: string, options: OpenDatabaseOptions): OpenDatabaseResult {
  let db: SqliteDatabase;
  let fresh = false;
  try {
    mkdirSync(dirname(file), { recursive: true });
    db = new sqlite.DatabaseSync(file);
  } catch (err) {
    throw new StorageError('E_STORAGE_OPEN_FAILED', `无法打开数据库 ${file}：${(err as Error).message}`);
  }

  try {
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
    }
    if (err instanceof StorageError) throw err;
    throw new StorageError('E_STORAGE_INIT_FAILED', `初始化数据库失败（${file}）：${(err as Error).message}`);
  }
}

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
    throw new StorageError(
      'E_STORAGE_MIGRATION_MISSING',
      `库结构版本为 ${current}，本程序需要 ${options.schemaVersion}，但迁移清单里没有对应的迁移：请补齐迁移，不要手改版本号`,
    );
  }
  return applied;
}

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

export function countOf(db: SqliteDatabase, sql: string, ...params: unknown[]): number {
  const row = db.prepare(sql).get(...params) as { n?: number | bigint } | undefined;
  const value = row?.n ?? 0;
  return typeof value === 'bigint' ? Number(value) : Number(value);
}
