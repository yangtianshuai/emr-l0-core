/**
 * 测试夹具：一个建在**临时库**上的部署参数键值层。
 *
 * 为什么要有它：四类部署参数（模型 / 落位 / 签名 / 授权源）现在都落库，
 * 于是每个自测都需要"一个临时库 + 一个口令 + 一个 `WorkStore`"这三件套。
 * 三行样板复制四遍，改一次要改四处 —— 夹具只写一遍。
 *
 * 顺带把 `workStore` 也交出来：断言"密钥不得明文落库"时，要**直接看库里的行**，
 * 而不是听服务端自报"已加密"（那正是这条用例要防的事）。
 */

import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { createConfigKv, type ConfigKv } from '../storage/config-kv.ts';
import { MIGRATIONS, STORAGE_SCHEMA_VERSION } from '../storage/schema.ts';
import { openDatabase } from '../storage/sqlite.ts';
import { WorkStore } from '../storage/work-store.ts';

/**
 * ⚠️ 本环境的 `node:fs` / `node:os` 类型声明不完整：`mkdtempSync` 与 `tmpdir` 都没声明
 * （运行时存在）。按仓库既有做法做**局部断言**，而不是换一种写法绕开。
 */
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
  /** 清掉临时目录（测试结尾调用；本环境删除偶发失败，故吞掉异常） */
  cleanup(): void;
}

/**
 * 派生迭代数：测试里压到 1000（理由同 `core/store.ts` 与 storage 自测的 `ITER`）。
 * 生产是 20 万次（约 12.5 秒，靠稳定 salt 缓存成一次）；测试里每个夹具都要建一次库，
 * 按生产值跑就是每套用例一分多钟 —— 而这里要验的是**语义**，不是 KDF 的强度。
 */
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
        /* 已关闭就算了 */
      }
      try {
        fsx.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* 见上：本环境对 SQLite 目录的删除偶发失败，不影响结论 */
      }
    },
  };
}

/**
 * 往库里塞一行**坏数据**（模拟"口令换过 / 有人改过那一行"）。
 *
 * 文件时代这件事靠"写一段半截 JSON"来模拟；现在写不出半截 JSON 了
 * （密封信封带 MAC，**半截 JSON 这种损坏已经不可能出现**）——
 * 但"解不开"仍然可能，而且它必须**不许被当作"没配过"**。这条就是它的替身。
 */
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

/**
 * 直接读某一行的**密文**（断言"明文没落库"用）。
 *
 * 刻意**另开一个连接**读文件，而不是问 `WorkStore`：
 * 这条断言要防的正是"服务端自报已加密、其实存了明文"，所以得自己去看那几行。
 */
export function sealedBlobOf(fixture: ConfigFixture, key: string): string | null {
  const { db } = openDatabase(fixture.dbFile, { schemaVersion: STORAGE_SCHEMA_VERSION, migrations: MIGRATIONS });
  try {
    const row = db.prepare('select payload_sealed from sealed_kv where key = ?').get(key) as { payload_sealed?: string } | undefined;
    return row?.payload_sealed === undefined ? null : String(row.payload_sealed);
  } finally {
    db.close();
  }
}
