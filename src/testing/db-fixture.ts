// 测试夹具：一个空的临时库（结构已按当前版本建好）。

import { join } from 'node:path';
import { MIGRATIONS, STORAGE_SCHEMA_VERSION } from '../storage/schema.ts';
import { openDatabase, type SqliteDatabase } from '../storage/sqlite.ts';

/**  本环境的 `node:fs` / `node:os` 类型声明不完整（运行时存在）：按仓库既有做法局部断言  */
const fsx = (await import('node:fs')) as unknown as {
  mkdtempSync: (prefix: string) => string;
  rmSync: (path: string, options: { recursive: boolean; force: boolean }) => void;
};
const osx = (await import('node:os')) as unknown as { tmpdir: () => string };

export interface DbFixture {
  db: SqliteDatabase;
  dir: string;
  dbFile: string;
  /** 关连接并删掉临时目录（删除偶发失败，故吞掉异常 —— 不影响结论） */
  cleanup(): void;
}

export function openDbFixture(options: { prefix?: string; at?: string } = {}): DbFixture {
  const dir = fsx.mkdtempSync(join(osx.tmpdir(), options.prefix ?? 'l0-db-'));
  const dbFile = join(dir, 'l0.db');
  const { db } = openDatabase(dbFile, {
    schemaVersion: STORAGE_SCHEMA_VERSION,
    migrations: MIGRATIONS,
    at: options.at ?? '2026-10-14T00:00:00.000Z',
  });
  return {
    db,
    dir,
    dbFile,
    cleanup: () => {
      try {
        db.close();
      } catch {
      }
      try {
        fsx.rmSync(dir, { recursive: true, force: true });
      } catch {
      }
    },
  };
}
