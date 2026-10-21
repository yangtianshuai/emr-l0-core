import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { createConfigKv, type ConfigKv } from '../storage/config-kv.ts';
import { MIGRATIONS, STORAGE_SCHEMA_VERSION } from '../storage/schema.ts';
import { openDatabase } from '../storage/sqlite.ts';
import { WorkStore } from '../storage/work-store.ts';

const fsx = (await import('node:fs')) as unknown as {
  mkdtempSync: (prefix: string) => string;
  rmSync: (path: string, options: { recursive: boolean; force: boolean }) => void;
  writeFileSync: (path: string, data: string, encoding: string) => void;
};
const osx = (await import('node:os')) as unknown as { tmpdir: () => string };

export const FIXTURE_PASSPHRASE = 'fixture-passphrase-for-config-kv';

export interface ConfigFixture {
  kv: ConfigKv;
  workStore: WorkStore;
  dir: string;
  dbFile: string;
  passphrase: string;
  cleanup(): void;
}

export const FIXTURE_ITERATIONS = 1000;

export function openConfigFixture(options: { prefix?: string; passphrase?: string; at?: () => string } = {}): ConfigFixture {
  const dir = fsx.mkdtempSync(join(osx.tmpdir(), options.prefix ?? 'l0-config-'));
  const passphrase = options.passphrase ?? FIXTURE_PASSPHRASE;
  const dbFile = join(dir, 'l0.db');
  const { db } = openDatabase(dbFile, {
    schemaVersion: STORAGE_SCHEMA_VERSION,
    migrations: MIGRATIONS,
    at: '2026-10-14T00:00:00.000Z',
  });
  const workStore = new WorkStore(db, passphrase, {
    iterations: FIXTURE_ITERATIONS,
    ...(options.at ? { at: options.at } : {}),
  });
  return {
    kv: createConfigKv(workStore),
    workStore,
    dir,
    dbFile,
    passphrase,
    cleanup: () => {
      try {
        workStore.close();
      } catch {
      }
      try {
        fsx.rmSync(dir, { recursive: true, force: true });
      } catch {
      }
    },
  };
}

export function writeCorruptRow(fixture: ConfigFixture, key: string, payloadSealed = '这不是一个信封'): void {
  const { db } = openDatabase(fixture.dbFile, { schemaVersion: STORAGE_SCHEMA_VERSION, migrations: MIGRATIONS });
  try {
    db.prepare(
      `insert into sealed_kv (key, payload_format, payload_digest, payload_sealed, updated_at)
       values (?, ?, ?, ?, ?)
       on conflict(key) do update set payload_format = excluded.payload_format,
         payload_digest = excluded.payload_digest, payload_sealed = excluded.payload_sealed, updated_at = excluded.updated_at`,
    ).run(key, 'l0-kv/1', 'deadbeef', payloadSealed, '2026-10-14T00:00:00.000Z');
  } finally {
    db.close();
  }
}

export function sealedBlobOf(fixture: ConfigFixture, key: string): string | null {
  const { db } = openDatabase(fixture.dbFile, { schemaVersion: STORAGE_SCHEMA_VERSION, migrations: MIGRATIONS });
  try {
    const row = db.prepare('select payload_sealed from sealed_kv where key = ?').get(key) as { payload_sealed?: string } | undefined;
    return row?.payload_sealed === undefined ? null : String(row.payload_sealed);
  } finally {
    db.close();
  }
}
