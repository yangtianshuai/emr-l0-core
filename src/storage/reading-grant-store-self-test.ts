import { TestSuite, assert, assertEqual } from '../testing/harness.ts';
import { FIXTURE_ITERATIONS, openConfigFixture, type ConfigFixture } from '../testing/config-fixture.ts';
import { saveSealedPayload } from '../core/store.ts';
import { MIGRATIONS, STORAGE_SCHEMA_VERSION } from './schema.ts';
import { openDatabase, type SqliteDatabase } from './sqlite.ts';
import {
  clearReadingGrants,
  countReadingGrants,
  listReadingGrants,
  loadAllReadingGrants,
  loadReadingGrant,
  saveReadingGrant,
  syncReadingGrants,
  type ReadingGrantRecord,
} from './reading-grant-store.ts';
import { READING_GRANTS_LEDGER_ID, importReadingGrantsOnce } from './reading-grants-import.ts';

const suite = new TestSuite('授权登记入库自测', [
  '说明：授权登记原先是一个整体式密封文件（整份加密、每次改动全量重写），现在是一条授权一行。',
  'RG2/RG5 是防回退关键：载荷必须真加密（不是"我们加密了"），解不开必须报错（不是"当作没有"）。',
]);

const test = (name: string, fn: () => void | Promise<void>): Promise<void> => suite.test(name, fn);
const AT = '2026-10-14T00:00:00.000Z';

function connect(fixture: ConfigFixture): SqliteDatabase {
  return openDatabase(fixture.dbFile, { schemaVersion: STORAGE_SCHEMA_VERSION, migrations: MIGRATIONS, at: AT }).db;
}

function recordOf(grantId: string, docId: string, extra: Partial<ReadingGrantRecord> = {}): ReadingGrantRecord {
  return {
    grantId,
    docId,
    revoked: false,
    readCount: 0,
    payload: { credential: { grant: { grantId, docId, purpose: '心内科会诊' } }, reads: [], readCount: 0, revoked: false },
    ...extra,
  };
}

function sealedOf(db: SqliteDatabase, grantId: string): string | null {
  const row = db.prepare('select payload_sealed from reading_grants where grant_id = ?').get(grantId) as { payload_sealed?: string } | undefined;
  return row?.payload_sealed === undefined ? null : String(row.payload_sealed);
}

/** 造一份旧的密封登记文件（形状与文件时代一致：`{ version, grants }`） */
function writeLegacyFile(fixture: ConfigFixture, grants: unknown[], name = 'reading-grants.json'): string {
  const file = `${fixture.dir}/${name}`;
  saveSealedPayload(file, { version: 1, grants }, fixture.passphrase, { iterations: FIXTURE_ITERATIONS, at: AT });
  return file;
}

async function main(): Promise<void> {
  await test('RG1 空表 = 没有登记（不是错误）', () => {
    const fixture = openConfigFixture({ prefix: 'l0-reading-grants-' });
    const db = connect(fixture);
    try {
      const all = loadAllReadingGrants(db, fixture.passphrase);
      assertEqual(all.ok, true, '空表应正常返回空清单');
      if (all.ok) assertEqual(all.records.length, 0, '一条都没有');
      assertEqual(countReadingGrants(db).total, 0, '统计应为 0');
      const one = loadReadingGrant(db, fixture.passphrase, 'g-none');
      assertEqual(one.ok && one.found === false, true, '查不存在的授权应回答"没有"，而不是报错');
    } finally {
      db.close();
      fixture.cleanup();
    }
  });

  await test('RG2 往返保真，且**载荷不得以明文落库**', () => {
    const fixture = openConfigFixture({ prefix: 'l0-reading-grants-' });
    const db = connect(fixture);
    try {
      saveReadingGrant(db, fixture.passphrase, recordOf('g1', 'd1'), { iterations: FIXTURE_ITERATIONS, at: AT });
      const loaded = loadReadingGrant(db, fixture.passphrase, 'g1');
      assertEqual(loaded.ok && loaded.found, true, '写入之后应读得到');
      if (!loaded.ok || !loaded.found) return;
      assertEqual(loaded.record.docId, 'd1', '列上的 doc_id 应正确');
      assertEqual(loaded.record.revoked, false, '列上的撤销状态应正确');
      assertEqual(loaded.record.readCount, 0, '列上的阅读次数应正确');
      assertEqual(
        JSON.stringify(loaded.record.payload),
        JSON.stringify(recordOf('g1', 'd1').payload),
        '载荷应逐字往返（整条记录原样进出）',
      );
      /* 直接看那一行的密文：授权用途、章节范围、阅读流水都不得以明文躺在库里 */
      const sealed = sealedOf(db, 'g1');
      assert(sealed !== null && sealed.length > 0, '载荷应真的写了进去');
      assertEqual(String(sealed).includes('心内科'), false, '授权用途不得明文落库');
      assertEqual(String(sealed).includes('d1'), false, '就连 docId 也不该出现在密文里（它在列上，不在载荷的明文中）');
    } finally {
      db.close();
      fixture.cleanup();
    }
  });

  await test('RG3 撤销与计数：列与载荷同一次写入更新，且是 upsert 不是追加', () => {
    const fixture = openConfigFixture({ prefix: 'l0-reading-grants-' });
    const db = connect(fixture);
    try {
      saveReadingGrant(db, fixture.passphrase, recordOf('g1', 'd1'), { iterations: FIXTURE_ITERATIONS, at: AT });
      const updated = recordOf('g1', 'd1', {
        revoked: true,
        readCount: 3,
        payload: { credential: { grant: { grantId: 'g1', docId: 'd1' } }, reads: [{ at: AT, actorId: 'dr-zhang' }], readCount: 3, revoked: true },
      });
      saveReadingGrant(db, fixture.passphrase, updated, { iterations: FIXTURE_ITERATIONS, at: AT });

      assertEqual(countReadingGrants(db).total, 1, '同一 grantId 再写一次必须是覆盖，不是新增一行');
      assertEqual(countReadingGrants(db).revoked, 1, '撤销状态应体现在列上（它是"哪些还生效"唯一读的地方）');
      const loaded = loadReadingGrant(db, fixture.passphrase, 'g1');
      assertEqual(loaded.ok && loaded.found && loaded.record.readCount, 3, '阅读次数应更新');
      assertEqual(loaded.ok && loaded.found && loaded.record.revoked, true, '撤销应更新');
      if (loaded.ok && loaded.found) {
        const payload = loaded.record.payload as { reads?: unknown[] };
        assertEqual(payload.reads?.length, 1, '阅读流水应随载荷一起更新（两者不能各自为政）');
      }
    } finally {
      db.close();
      fixture.cleanup();
    }
  });

  await test('RG4 按 doc_id / revoked 筛选走列，**不需要口令**', () => {
    const fixture = openConfigFixture({ prefix: 'l0-reading-grants-' });
    const db = connect(fixture);
    try {
      saveReadingGrant(db, fixture.passphrase, recordOf('g1', 'd1'), { iterations: FIXTURE_ITERATIONS, at: AT });
      saveReadingGrant(db, fixture.passphrase, recordOf('g2', 'd1', { revoked: true }), { iterations: FIXTURE_ITERATIONS, at: AT });
      saveReadingGrant(db, fixture.passphrase, recordOf('g3', 'd2'), { iterations: FIXTURE_ITERATIONS, at: AT });

      const byDoc = listReadingGrants(db, { docId: 'd1' });
      assertEqual(byDoc.length, 2, 'd1 应有两条授权');
      assertEqual(byDoc.map((row) => row.grantId).join(','), 'g1,g2', '顺序稳定（按 doc_id, grant_id）');
      assertEqual(listReadingGrants(db, { docId: 'd1', revoked: true }).map((row) => row.grantId).join(','), 'g2', '按撤销状态可筛');
      assertEqual(listReadingGrants(db, { revoked: false }).length, 2, '未撤销的应有两条（g1 与 g3）');
      assertEqual(listReadingGrants(db, {}).length, 3, '不带筛选应列全部');
    } finally {
      db.close();
      fixture.cleanup();
    }
  });

  await test('RG5 载荷解不开 → **报错，不当作"没有这条授权"**', () => {
    const fixture = openConfigFixture({ prefix: 'l0-reading-grants-' });
    const db = connect(fixture);
    try {
      saveReadingGrant(db, fixture.passphrase, recordOf('g1', 'd1'), { iterations: FIXTURE_ITERATIONS, at: AT });
      db.prepare('update reading_grants set payload_sealed = ? where grant_id = ?').run('这不是一个信封', 'g1');

      const one = loadReadingGrant(db, fixture.passphrase, 'g1');
      assertEqual(one.ok, false, '单条读取必须报错');
      if (!one.ok) assert(one.message.includes('不当作'), '错误信息要说清它**不等于**"没有这条授权"（后者在界面上看起来完全正常）');
      const all = loadAllReadingGrants(db, fixture.passphrase);
      assertEqual(all.ok, false, '启动恢复也必须整批报错（不许静默丢一条）');
      if (!all.ok) assert(all.message.includes('g1'), '要指出是哪一条读不出来');
    } finally {
      db.close();
      fixture.cleanup();
    }
  });

  await test('RG6 全量同步与清空：不在清单里的行会被删掉（不是只增不减）', () => {
    const fixture = openConfigFixture({ prefix: 'l0-reading-grants-' });
    const db = connect(fixture);
    try {
      saveReadingGrant(db, fixture.passphrase, recordOf('g1', 'd1'), { iterations: FIXTURE_ITERATIONS, at: AT });
      saveReadingGrant(db, fixture.passphrase, recordOf('g2', 'd1'), { iterations: FIXTURE_ITERATIONS, at: AT });
      assertEqual(countReadingGrants(db).total, 2, '前置：两条');

      const synced = syncReadingGrants(db, fixture.passphrase, [recordOf('g2', 'd1', { readCount: 1 })], { iterations: FIXTURE_ITERATIONS, at: AT });
      assertEqual(synced.written, 1, '应写入 1 条');
      assertEqual(synced.removed, 1, '应删掉 1 条（不在清单里的那条）');
      assertEqual(countReadingGrants(db).total, 1, '库里只该剩 1 条');
      assertEqual(listReadingGrants(db, {}).map((row) => row.grantId).join(','), 'g2', '留下的应是清单里那条');

      assertEqual(clearReadingGrants(db), 1, '清空应返回清掉的行数');
      assertEqual(countReadingGrants(db).total, 0, '清空之后一条不剩');
    } finally {
      db.close();
      fixture.cleanup();
    }
  });

  await test('RG7 一次性导入：记账闸门、不混来源、读不出来**不记账**', () => {
    const fixture = openConfigFixture({ prefix: 'l0-reading-grants-import-' });
    const db = connect(fixture);
    try {
      const missing = importReadingGrantsOnce({
        workStore: fixture.workStore,
        db,
        passphrase: fixture.passphrase,
        file: `${fixture.dir}/no-such-file.json`,
        options: { iterations: FIXTURE_ITERATIONS, at: AT },
      });
      assertEqual(missing.ran, true, '"跑过一次"这个动作要如实返回');
      assertEqual(missing.imported, 0, '没有文件就没得导入');
      assertEqual(fixture.workStore.ledgerHas(READING_GRANTS_LEDGER_ID), false, '没搬成不许记账（记早了会把这条路堵死）');

      const file = writeLegacyFile(fixture, [
        { credential: { grant: { grantId: 'g1', docId: 'd1' } }, readCount: 2, revoked: false, reads: [] },
        { credential: { grant: { grantId: 'g2', docId: 'd1' } }, readCount: 0, revoked: true, reads: [] },
      ]);
      const first = importReadingGrantsOnce({ workStore: fixture.workStore, db, passphrase: fixture.passphrase, file, options: { iterations: FIXTURE_ITERATIONS, at: AT } });
      assertEqual(first.imported, 2, '两条都应导入');
      assertEqual(first.skipped, 0, '没有形状不对的');
      assertEqual(fixture.workStore.ledgerHas(READING_GRANTS_LEDGER_ID), true, '导入成功必须记账');
      assertEqual(countReadingGrants(db).total, 2, '库里应有两行');
      assertEqual(countReadingGrants(db).revoked, 1, '撤销状态应从旧记录搬过来');
      const imported = loadReadingGrant(db, fixture.passphrase, 'g1');
      assertEqual(imported.ok && imported.found ? imported.record.readCount : -1, 2, '阅读计数应从旧记录搬过来（它决定"还能读几次"）');

      const again = importReadingGrantsOnce({ workStore: fixture.workStore, db, passphrase: fixture.passphrase, file, options: { iterations: FIXTURE_ITERATIONS, at: AT } });
      assertEqual(again.ran, false, '记了账就不再碰旧文件');

      const other = openConfigFixture({ prefix: 'l0-reading-grants-import-' });
      const otherDb = connect(other);
      try {
        saveReadingGrant(otherDb, other.passphrase, recordOf('g9', 'd9'), { iterations: FIXTURE_ITERATIONS, at: AT });
        const keep = importReadingGrantsOnce({ workStore: other.workStore, db: otherDb, passphrase: other.passphrase, file, options: { iterations: FIXTURE_ITERATIONS, at: AT } });
        assertEqual(keep.imported, 0, '库里已有登记时不得倒入旧文件（两批 grantId 混在一起，事后谁也说不清）');
        assertEqual(countReadingGrants(otherDb).total, 1, '库里那条不该被动');
        assertEqual(other.workStore.ledgerHas(READING_GRANTS_LEDGER_ID), true, '这种情况要记账（否则每次启动都要判一次）');

        const broken = `${other.dir}/broken.json`;
        saveSealedPayload(broken, { version: 1, grants: [] }, 'wrong-passphrase', { iterations: FIXTURE_ITERATIONS, at: AT });
        const fresh = openConfigFixture({ prefix: 'l0-reading-grants-import-' });
        const freshDb = connect(fresh);
        try {
          const failed = importReadingGrantsOnce({ workStore: fresh.workStore, db: freshDb, passphrase: fresh.passphrase, file: broken, options: { iterations: FIXTURE_ITERATIONS, at: AT } });
          assert(failed.problem !== null, '读不出来必须如实报出来');
          assertEqual(fresh.workStore.ledgerHas(READING_GRANTS_LEDGER_ID), false, '**读不出来不许记账**：记了就再也不会重试');

          const mixed = writeLegacyFile(fresh, [
            { credential: { grant: { grantId: 'g1', docId: 'd1' } }, readCount: 0, revoked: false, reads: [] },
            { credential: { grant: { grantId: 'g2' } } },
            { nothing: true },
          ], 'mixed.json');
          const partial = importReadingGrantsOnce({ workStore: fresh.workStore, db: freshDb, passphrase: fresh.passphrase, file: mixed, options: { iterations: FIXTURE_ITERATIONS, at: AT } });
          assertEqual(partial.imported, 1, '合法的那条要导入（不因为一条坏就整份拒绝）');
          assertEqual(partial.skipped, 2, '被丢弃的必须逐条数出来');
          assert(partial.problem !== null && partial.problem.includes('缺少 grantId 或 docId'), '丢弃原因要说清是"缺什么"');
        } finally {
          freshDb.close();
          fresh.cleanup();
        }
      } finally {
        otherDb.close();
        other.cleanup();
      }
    } finally {
      db.close();
      fixture.cleanup();
    }
  });

  process.exit(suite.report());
}

void main();
