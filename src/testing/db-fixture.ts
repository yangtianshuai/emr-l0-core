import { join } from 'node:path';
import { MIGRATIONS, STORAGE_SCHEMA_VERSION } from '../storage/schema.ts';
import { openDatabase, type SqliteDatabase } from '../storage/sqlite.ts';

const fsx = (await import('node:fs')) as unknown as {
  mkdtempSync: (prefix: string) => string;
  rmSync: (path: string, options: { recursive: boolean; force: boolean }) => void;
};
const osx = (await import('node:os')) as unknown as { tmpdir: () => string };

export interface DbFixture {
  db: SqliteDatabase;
  dir: string;
  dbFile: string;
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
