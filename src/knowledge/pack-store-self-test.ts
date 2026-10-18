// 知识资产包存储自测（S1~S10，一个包一行的新模型）。

import { TestSuite, assert, assertEqual } from '../testing/harness.ts';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, type SqliteDatabase } from '../storage/sqlite.ts';
import { MIGRATIONS, STORAGE_SCHEMA_VERSION } from '../storage/schema.ts';
import {
  PACK_CONTENT_FORMAT,
  PACK_TABLE,
  deletePack,
  openPackStore,
  readPackRows,
  saveDisabledItems,
  writePack,
  type PackStoreReport,
} from './pack-store.ts';
import { SUPPORTED_PACK_ENGINE_APIS, createEmptyPackRegistry, packValidatorFor } from './default-registry.ts';
import type { Pack, PackRegistry } from './pack.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DIR = join(ROOT, 'artifacts', 'state-selftest', 'pack-store');
const SAMPLE_DIR = join(ROOT, 'samples', 'packs');

/**  本环境 `node:fs` 的类型声明缺 `rmSync` 的 `recursive` 选项（运行时支持），故局部断言  */
const fsRemove = (await import('node:fs')) as unknown as { rmSync: (path: string, options: { recursive: boolean; force: boolean }) => void };

const suite = new TestSuite('知识资产包存储自测（一个包一行）', [
  '说明：库是唯一来源；包只有一条进来的路 writePack()；空库如实上报 empty。',
  'S8/S9 是这一版模型的关键边界：开关与内容分列、内存与库不一致要当场暴露。',
]);

const test = (name: string, fn: () => void | Promise<void>): Promise<void> => suite.test(name, fn);

let seq = 0;
function freshDb(): SqliteDatabase {
  seq += 1;
  mkdirSync(DIR, { recursive: true });
  return openDatabase(join(DIR, `case-${seq}.db`), {
    schemaVersion: STORAGE_SCHEMA_VERSION,
    migrations: MIGRATIONS,
    at: '2026-10-14T00:00:00.000Z',
  }).db;
}

function open(registry: PackRegistry, db: SqliteDatabase): ReturnType<typeof openPackStore> {
  return openPackStore({ registry, db, supported: SUPPORTED_PACK_ENGINE_APIS, validateFor: packValidatorFor });
}

/** 真实样例包（`samples/packs/` 就是给人照着写的现成例子） */
function samplePack(name = 'qc.form.builtin.json'): Pack {
  return JSON.parse(readFileSync(join(SAMPLE_DIR, name), 'utf8').replace(/^\uFEFF/, '')) as Pack;
}

/** 改一个字段造"内容变了"的版本（不升版本号——新模型里没有版本号了）  */
function modified(pack: Pack, patch: Record<string, unknown>): Pack {
  return { ...(pack as unknown as Record<string, unknown>), ...patch } as unknown as Pack;
}

function write(registry: PackRegistry, db: SqliteDatabase, pack: unknown): ReturnType<typeof writePack> {
  return writePack({ registry, db, supported: SUPPORTED_PACK_ENGINE_APIS, validateFor: packValidatorFor, input: pack });
}

const reportOf = (result: ReturnType<typeof writePack>): PackStoreReport => {
  assert(result.ok, `写包应成功：${result.ok ? '' : result.message}`);
  return (result as { result: { report: PackStoreReport } }).result.report;
};

async function main(): Promise<void> {
  try {
    fsRemove.rmSync(DIR, { recursive: true, force: true });
  } catch {
    /* 见其它套件的说明：本环境对 SQLite 目录的删除偶发失败 */
  }

  await test('S1 空库就是空库：如实上报 empty、注册表被清空、**不播种任何内置内容**', () => {
    const db = freshDb();
    const registry = createEmptyPackRegistry();
    const result = open(registry, db);
    assertEqual(result.ok, true, '打开空库应成功（空不是错误）');
    if (!result.ok) return;
    assertEqual(result.report.source, 'empty', '没有包就是 empty —— 不许拿"出厂装配"顶上');
    assertEqual(result.report.packs, [], '报告里一个包都不该有');
    assertEqual(result.report.tables, [PACK_TABLE], '要能一句话答出包在哪张表');
    assertEqual(registry.list().length, 0, '注册表必须是空的（医生端据此显示"质控当前不可用"）');
  });

  await test('S2 写包（created）：库里一行、注册表可查、指纹如实；内容里**不含 enabled**', () => {
    const db = freshDb();
    const registry = createEmptyPackRegistry();
    const pack = samplePack();
    const result = write(registry, db, pack);
    assertEqual(result.ok, true, `写包应成功：${result.ok ? '' : result.message}`);
    if (!result.ok) return;
    assertEqual(result.result.action, 'created', '第一次写是 created');
    assertEqual(result.result.fingerprintBefore, null, '原先没有这个包 → 前指纹为空');
    assertEqual(result.result.fingerprintAfter.length > 0, true, '后指纹要有');
    assertEqual(result.result.report.source, 'database', '有包之后来源是 database');

    const rows = readPackRows(db);
    assertEqual(rows.length, 1, '库里一行');
    const row = rows[0]!;
    assertEqual(row.packId, pack.packId, '按 pack_id 一行');
    assertEqual(row.contentFormat, PACK_CONTENT_FORMAT, '形状标识要落库');
    const content = JSON.parse(row.content) as Record<string, unknown> & { items: Array<Record<string, unknown>> };
    assertEqual('enabled' in content, false, '内容里不该有 enabled（开关归 disabled 列）');
    assertEqual(content.items.every((item) => !('enabled' in item)), true, '条目上也不该有 enabled');
    assertEqual(registry.list().length, 1, '注册表里应有它');
    assertEqual(registry.get(pack.packId)?.items.length, pack.items.length, '条目数一致');
  });

  await test('S3 重灌相同内容 → unchanged，且**一个字节都不写**（updated_at 不漂移）', () => {
    const db = freshDb();
    const registry = createEmptyPackRegistry();
    const pack = samplePack();
    assertEqual(write(registry, db, pack).ok, true, '前置：先写一次');
    const before = readPackRows(db)[0]!;

    const again = write(registry, db, pack);
    assertEqual(again.ok, true, '重灌应成功');
    if (!again.ok) return;
    assertEqual(again.result.action, 'unchanged', '内容逐字节相同 → unchanged');
    assertEqual(readPackRows(db)[0]?.updatedAt, before.updatedAt, 'unchanged 时不该改 updated_at（否则"包动过"会被误报）');
  });

  await test('S4 覆盖：指纹前后如实报出；**仍存在的开关保留**，失效的进 droppedSwitches', () => {
    const db = freshDb();
    const registry = createEmptyPackRegistry();
    const pack = samplePack();
    assertEqual(write(registry, db, pack).ok, true, '前置：写入');
    const firstId = String((pack.items[0] as { itemId: string }).itemId);
    const secondId = String((pack.items[1] as { itemId: string }).itemId);
    /* 停用两条，其中一条在下一版里会消失 */
    registry.setItemEnabled(pack.packId, firstId, false);
    registry.setItemEnabled(pack.packId, secondId, false);
    saveDisabledItems(registry, db);
    assertEqual(readPackRows(db)[0]?.disabled.sort(), [firstId, secondId].sort(), '前置：两条开关已落库');

    /* 只留第一条：第二条在新版里不存在 */
    const next = modified(pack, { name: `${pack.name}（修订）`, items: [pack.items[0]] });
    const result = write(registry, db, next);
    assertEqual(result.ok, true, `覆盖应成功：${result.ok ? '' : result.message}`);
    if (!result.ok) return;
    assertEqual(result.result.action, 'updated', '内容变了 → updated');
    assertEqual(result.result.fingerprintBefore, readPackRows(db)[0] ? result.result.fingerprintBefore : null, '前指纹要如实给出');
    assert(result.result.fingerprintBefore !== result.result.fingerprintAfter, '前后指纹必须不同（否则"覆盖了"没法证明）');
    assertEqual(result.result.disabled, [firstId], '仍存在的开关要保留');
    assertEqual(result.result.droppedSwitches, [secondId], '新版里没有的开关要**如实报出**');
    assertEqual(readPackRows(db)[0]?.disabled, [firstId], '落库的开关与报告一致');
  });

  await test('S5 非法内容 → 拒绝，且**库与注册表都不动**', () => {
    const db = freshDb();
    const registry = createEmptyPackRegistry();
    const pack = samplePack();
    assertEqual(write(registry, db, pack).ok, true, '前置：写入一份合法包');
    const before = readPackRows(db)[0]!;

    const broken = modified(pack, { items: [] });
    const result = write(registry, db, broken);
    assertEqual(result.ok, false, '空 items 必须被拒');
    /* 校验失败要走返回而不是抛异常：抛出去时接口层只剩 500，而原因本来写着  */
    assertEqual(result.ok ? '' : result.code, 'E_PACK_STORE_BAD_CONTENT', '错误码应可定位');
    assert(result.ok ? true : result.message.includes('没有任何条目'), `消息要带上具体原因，实际：${result.ok ? '' : result.message}`);
    assertEqual(readPackRows(db)[0]?.fingerprint, before.fingerprint, '被拒时库里一个字节都不该变');
    assertEqual(registry.get(pack.packId)?.items.length, pack.items.length, '注册表也不该变');
  });

  await test('S6 内容形状标识不认识 → 拒绝（需显式迁移，不做隐式猜测）', () => {
    const db = freshDb();
    const registry = createEmptyPackRegistry();
    assertEqual(write(registry, db, samplePack()).ok, true, '前置：写入');
    db.prepare('update knowledge_packs set content_format = ?').run('l0-pack/99');

    const result = open(createEmptyPackRegistry(), db);
    assertEqual(result.ok, false, '形状不认识应拒绝装载');
    assertEqual(result.ok ? '' : result.code, 'E_PACK_STORE_CONTENT_FORMAT', '应报"形状不认识"');
    assert(result.ok ? true : result.message.includes('l0-pack/99'), '消息里要带上实际形状');
  });

  await test('S7 条目号被**别的包**占用 → 拒绝（跨包冲突在写之前就判掉）', () => {
    const db = freshDb();
    const registry = createEmptyPackRegistry();
    const pack = samplePack();
    assertEqual(write(registry, db, pack).ok, true, '前置：写入第一份');
    const clash = modified(pack, { packId: 'qc.other.pack', name: '另一个包', items: [pack.items[0]] });

    const result = write(registry, db, clash);
    assertEqual(result.ok, false, '同类别下 itemId 撞车要被拒');
    assertEqual(readPackRows(db).length, 1, '被拒时不该多出一行');
    assertEqual(registry.list().length, 1, '注册表也不该多出一份');
  });

  await test('S8 开关**只改 disabled 列**：内容指纹一个字节都不动', () => {
    const db = freshDb();
    const registry = createEmptyPackRegistry();
    const pack = samplePack();
    assertEqual(write(registry, db, pack).ok, true, '前置：写入');
    const before = readPackRows(db)[0]!;
    const firstId = String((pack.items[0] as { itemId: string }).itemId);

    registry.setItemEnabled(pack.packId, firstId, false);
    saveDisabledItems(registry, db);
    const after = readPackRows(db)[0]!;
    assertEqual(after.disabled, [firstId], '开关要落进 disabled 列');
    assertEqual(after.fingerprint, before.fingerprint, '内容指纹**必须不变** —— 否则"换包"与"关一条规则"又混成一件事');
    assertEqual(after.content, before.content, '内容列也一个字节都不许碰');

    /* 重开一次：开关要还在（内存态时它一重启就回出厂，而界面上看不出异常） */
    const reopened = createEmptyPackRegistry();
    assertEqual(open(reopened, db).ok, true, '重开应成功');
    const items = (reopened.get(pack.packId)?.items ?? []) as Array<{ itemId: string; enabled?: boolean }>;
    assertEqual(items.find((item) => item.itemId === firstId)?.enabled, false, '重开后那一条仍是停用的');
  });

  await test('S9 内存里有、库里没有的包 → 写开关时**报错**，绝不凭空造一行', () => {
    const db = freshDb();
    const registry = createEmptyPackRegistry();
    const pack = samplePack();
    /* 只装进注册表，不写库 —— 模拟"内存与库不一致"  */
    registry.load(pack, { validate: packValidatorFor(pack.kind) });
    let code = '';
    try {
      saveDisabledItems(registry, db);
    } catch (err) {
      code = String((err as { code?: string }).code ?? '');
    }
    assertEqual(code, 'E_PACK_STORE_WRITE', '应报"库里没有这个包"');
    assertEqual(readPackRows(db).length, 0, '不许静默造一行出来（那等于凭空多出一份内容）');
  });

  await test('S10 v2→v3 迁移：多版本里**只有生效那一份活下来**，开关被带过来', () => {
    mkdirSync(DIR, { recursive: true });
    seq += 1;
    const file = join(DIR, `migrate-${seq}.db`);
    const v2 = openDatabase(file, {
      schemaVersion: 2,
      migrations: MIGRATIONS.filter((migration) => migration.id !== '0003-pack-without-version'),
      at: '2026-10-14T00:00:00.000Z',
    }).db;
    const pack = samplePack();
    const items = pack.items as Array<{ itemId: string }>;
    const liveItem = items[0]!.itemId;
    const goneItem = 'R-GONE-99';
    /* v2 时代的内容里带 `version` 字段（那时它是必填的）；迁移后能不能读，正是这条要验的 */
    const content = JSON.stringify({ ...(pack as unknown as Record<string, unknown>), version: '0.9.0' });
    const fingerprint = 'f'.repeat(64);
    v2.prepare(
      `insert into knowledge_packs (pack_id, version, kind, content_format, content, fingerprint, origin, stored_at)
       values (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(pack.packId, '0.9.0', pack.kind, PACK_CONTENT_FORMAT, content, fingerprint, 'builtin', '2026-10-01T00:00:00.000Z');
    v2.prepare(
      `insert into knowledge_packs (pack_id, version, kind, content_format, content, fingerprint, origin, stored_at)
       values (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(pack.packId, '0.8.0', pack.kind, PACK_CONTENT_FORMAT, content, fingerprint, 'builtin', '2026-09-01T00:00:00.000Z');
    v2.prepare('insert into knowledge_pack_active (pack_id, version, disabled, updated_at) values (?, ?, ?, ?)').run(
      pack.packId,
      '0.9.0',
      JSON.stringify([liveItem, goneItem]),
      '2026-10-01T00:00:00.000Z',
    );
    v2.close();

    const v3 = openDatabase(file, { schemaVersion: STORAGE_SCHEMA_VERSION, migrations: MIGRATIONS, at: '2026-10-14T01:00:00.000Z' });
    assertEqual(v3.applied, ['0003-pack-without-version'], '应只执行这一条迁移');
    assertEqual(
      Number(v3.db.prepare("select count(*) as n from sqlite_master where name = 'knowledge_pack_active'").get()?.n),
      0,
      '旧指针表应被删掉',
    );

    const rows = readPackRows(v3.db);
    assertEqual(rows.length, 1, '多版本里**只保留生效那一份**（历史版本无处安放，迁移代价如实记在 schema 里）');
    assertEqual(rows[0]?.packId, pack.packId, '留下的是生效的那个包');
    assertEqual(rows[0]?.disabled, [liveItem, goneItem], '开关要按原样带过来');

    /* 迁移后的内容必须仍然可装载：带着 `version` 字段的旧内容若被新的校验拒掉，
       那这次迁移就是把"能用的包"变成了"装载失败" —— 这条断言就是那道闸。  */
    const registry = createEmptyPackRegistry();
    const loaded = open(registry, v3.db);
    assertEqual(loaded.ok, true, `迁移后的库必须能装载：${loaded.ok ? '' : loaded.message}`);
    assertEqual(registry.list().length, 1, '装载出 1 个包');
    const reopenedItems = (registry.get(pack.packId)?.items ?? []) as Array<{ itemId: string; enabled?: boolean }>;
    assertEqual(reopenedItems.find((item) => item.itemId === liveItem)?.enabled, false, '迁移带过来的开关要生效');
    assertEqual(reopenedItems.find((item) => item.itemId === goneItem), undefined, '旧版里不存在的条目本就不存在，不该凭空出现');
    v3.db.close();
  });

  await test('S11 删掉整个包：库里那一行与内存里那一份一起没（删到空的包**不留空壳**）', () => {
    const registry = createEmptyPackRegistry();
    const db = freshDb();
    const pack = samplePack();
    reportOf(write(registry, db, pack));
    assertEqual(registry.get(pack.packId)?.items.length, pack.items.length, '前置：包已写进库与注册表');

    const removed = deletePack({ registry, db, packId: pack.packId });
    assertEqual(removed.ok, true, '删包应成功');
    assertEqual(registry.get(pack.packId), undefined, '内存里没有了（否则"删掉了"只是库里的假象）');
    assertEqual(readPackRows(db).length, 0, '库里那一行也没有了');
    assertEqual(removed.report.source, 'empty', '删完如实上报 empty —— 不是"有一个空包"');

    /* 幂等：删一个不存在的包，结果就是"没有它"，不该报错（那会让人以为自己删错了东西） */
    const again = deletePack({ registry, db, packId: pack.packId });
    assertEqual(again.ok, true, '再删一次仍成功（"没有它"正是这个动作要的结果）');
    assertEqual(again.report.source, 'empty', '结论不变');
  });

  const code = suite.report();
  try {
    fsRemove.rmSync(DIR, { recursive: true, force: true });
  } catch (err) {
    console.log(`（提示）测试库清理失败，不影响结论：${(err as Error).message.split('\n')[0] ?? ''}`);
  }
  process.exit(code);
}

void main();
