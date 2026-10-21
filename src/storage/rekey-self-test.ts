import { TestSuite, assert, assertEqual } from '../testing/harness.ts';
import { FIXTURE_ITERATIONS, openConfigFixture, type ConfigFixture } from '../testing/config-fixture.ts';
import { MIGRATIONS, STORAGE_SCHEMA_VERSION } from './schema.ts';
import { openDatabase, type SqliteDatabase } from './sqlite.ts';
import { WorkStore } from './work-store.ts';
import { REKEY_SAME_KEY_CODE, REKEY_UNREADABLE_CODE, applyRekey, planRekey } from './rekey.ts';
import { sealFor } from './sealed.ts';
import { DOCUMENT_FORMAT, KV_FORMAT, SIDECARS_FORMAT } from './formats.ts';

const suite = new TestSuite('口令轮换自测', [
  '说明：口令换掉之后，库里已写进去的每一行都得重新密封 —— 没有这个工具，"换口令"在运维上不成立。',
  'RK3/RK5 是防回退关键：读不通时**一字未动**。用错口令覆盖唯一一份数据，比"没轮换"严重得多。',
]);

const test = (name: string, fn: () => void | Promise<void>): Promise<void> => suite.test(name, fn);
const OLD_KEY = 'rekey-old-passphrase';
const NEW_KEY = 'rekey-new-passphrase';
const AT = '2026-10-14T00:00:00.000Z';

function connect(fixture: ConfigFixture): SqliteDatabase {
  return openDatabase(fixture.dbFile, { schemaVersion: STORAGE_SCHEMA_VERSION, migrations: MIGRATIONS, at: AT }).db;
}

function sealedSnapshot(db: SqliteDatabase): string {
  const parts: string[] = [];
  for (const sql of [
    'select payload_sealed from documents order by doc_id',
    'select payload_sealed from sidecars order by doc_id',
    'select payload_sealed from sealed_kv order by key',
  ]) {
    for (const row of db.prepare(sql).all()) parts.push(String((row as { payload_sealed?: unknown }).payload_sealed));
  }
  return parts.join('\u0000');
}

function seed(fixture: ConfigFixture, db: SqliteDatabase): void {
  fixture.workStore.putSealed('config.demo', { hello: 'world' });
  fixture.workStore.putSealed('config.list', [1, 2, 3]);

  db.exec(`insert into patients (patient_id, name_masked, gender, sort) values ('p1', '张*', 'M', 0)`);
  const doc = sealFor(DOCUMENT_FORMAT, { docId: 'd1', nodes: [{ id: 'n1', text: '主诉：胸痛' }] }, OLD_KEY, { iterations: FIXTURE_ITERATIONS });
  db.prepare(
    `insert into documents (doc_id, patient_id, visit_id, title, kind, status, created_at, updated_at,
       created_by, rev, sort, payload_format, payload_digest, payload_sealed, stored_at)
     values ('d1', 'p1', null, '门诊病历', '门诊', 'draft', ?, ?, 'tester', 1, 0, ?, ?, ?, ?)`,
  ).run(AT, AT, doc.format, doc.digest, doc.sealed, AT);
  const side = sealFor(SIDECARS_FORMAT, { suggestions: { items: [{ id: 's1' }] } }, OLD_KEY, { iterations: FIXTURE_ITERATIONS });
  db.prepare(
    `insert into sidecars (doc_id, payload_format, payload_digest, payload_sealed, updated_at) values ('d1', ?, ?, ?, ?)`,
  ).run(side.format, side.digest, side.sealed, AT);
}

function readAllAs(fixture: ConfigFixture, key: string): { ok: boolean; summary: string } {
  const db = connect(fixture);
  try {
    const store = new WorkStore(db, key, { iterations: FIXTURE_ITERATIONS });
    const doc = store.loadDocument('d1');
    const side = store.loadSidecars<{ suggestions?: { items?: unknown[] } }>('d1');
    const kv = store.getSealed<{ hello?: string }>('config.demo');
    if (!doc.ok || !doc.found || !side.ok || !side.found || !kv.ok || !kv.found) {
      return { ok: false, summary: `读不通（doc=${doc.ok} side=${side.ok} kv=${kv.ok}）` };
    }
    return {
      ok: true,
      summary: JSON.stringify({ doc: doc.doc, side: side.data, kv: kv.data }),
    };
  } finally {
    db.close();
  }
}

async function main(): Promise<void> {
  await test('RK1 空库：计划是 0 行，且"无事可做"如实报出（不是失败）', () => {
    const fixture = openConfigFixture({ prefix: 'l0-rekey-' });
    const db = connect(fixture);
    try {
      const plan = planRekey(db, OLD_KEY);
      assertEqual(plan.ok, true, '空库的试运行应当是成功的（没有坏消息要报）');
      if (!plan.ok) return;
      assertEqual(plan.plan.total, 0, '没有任何密封行');
      assertEqual(plan.plan.scope.documents, 0, '文档 0 行');
      assertEqual(plan.applied, false, '试运行不得标记为"已重写"');
      const applied = applyRekey(db, OLD_KEY, NEW_KEY);
      assertEqual(applied.ok, true, '空库上执行也应当成功（幂等）');
    } finally {
      db.close();
      fixture.cleanup();
    }
  });

  await test('RK2 全量往返：三处密封行换完新口令都读得回来，且时间戳没被刷新', () => {
    const fixture = openConfigFixture({ prefix: 'l0-rekey-', passphrase: OLD_KEY });
    const db = connect(fixture);
    try {
      seed(fixture, db);
      const before = readAllAs(fixture, OLD_KEY);
      assertEqual(before.ok, true, '前置：旧口令能读通');
      const updatedBefore = String(
        (db.prepare(`select updated_at from sealed_kv where key = 'config.demo'`).get() as { updated_at?: string }).updated_at,
      );

      const result = applyRekey(db, OLD_KEY, NEW_KEY, { iterations: FIXTURE_ITERATIONS });
      assertEqual(result.ok, true, '轮换应当成功');
      if (!result.ok) return;
      assertEqual(result.applied, true, '应标记为真的重写过');
      assertEqual(result.plan.total, 4, '1 份文书 + 1 条旁挂数据 + 2 行配置 = 4 行');

      const after = readAllAs(fixture, NEW_KEY);
      assertEqual(after.ok, true, '**新口令必须能读通全部三处**');
      assertEqual(after.summary, before.summary, '内容必须逐字一致（轮换只换钥匙，不换数据）');
      assertEqual(readAllAs(fixture, OLD_KEY).ok, false, '换完之后旧口令打不开（这正是"轮换成功了"的证据）');

      const updatedAfter = String(
        (db.prepare(`select updated_at from sealed_kv where key = 'config.demo'`).get() as { updated_at?: string }).updated_at,
      );
      assertEqual(updatedAfter, updatedBefore, '轮换不得刷新 sealed_kv.updated_at（它回答"内容何时被改"，而轮换没改内容）');
    } finally {
      db.close();
      fixture.cleanup();
    }
  });

  await test('RK3 旧口令给错 → **整批中止，库一字未动**', () => {
    const fixture = openConfigFixture({ prefix: 'l0-rekey-', passphrase: OLD_KEY });
    const db = connect(fixture);
    try {
      seed(fixture, db);
      const before = sealedSnapshot(db);

      const plan = planRekey(db, 'not-the-old-passphrase');
      assertEqual(plan.ok, false, '试运行就该发现口令不对（这是它最有用的一刻）');
      if (!plan.ok) assertEqual(plan.code, REKEY_UNREADABLE_CODE, '错误码应指向"读不通"');

      const result = applyRekey(db, 'not-the-old-passphrase', NEW_KEY, { iterations: FIXTURE_ITERATIONS });
      assertEqual(result.ok, false, '口令错时执行必须失败');
      assertEqual(sealedSnapshot(db), before, '**库里的密文必须一字未动**（用错口令覆盖唯一一份数据是最坏的结局）');
      assertEqual(readAllAs(fixture, OLD_KEY).ok, true, '原口令仍然能读通（证明什么都没被破坏）');
    } finally {
      db.close();
      fixture.cleanup();
    }
  });

  await test('RK4 新旧口令相同且未给新盐 → 拒绝（不让"什么都没换"报成功）', () => {
    const fixture = openConfigFixture({ prefix: 'l0-rekey-', passphrase: OLD_KEY });
    const db = connect(fixture);
    try {
      seed(fixture, db);
      const before = sealedSnapshot(db);
      const result = applyRekey(db, OLD_KEY, OLD_KEY, { iterations: FIXTURE_ITERATIONS });
      assertEqual(result.ok, false, '同口令轮换应当被拒');
      if (!result.ok) assertEqual(result.code, REKEY_SAME_KEY_CODE, '错误码应说清"这次轮换什么也没换"');
      assertEqual(sealedSnapshot(db), before, '被拒时不得改写任何一行');
    } finally {
      db.close();
      fixture.cleanup();
    }
  });

  await test('RK5 只有一行坏 → 同样整批中止，可读的行也不许被改写', () => {
    const fixture = openConfigFixture({ prefix: 'l0-rekey-', passphrase: OLD_KEY });
    const db = connect(fixture);
    try {
      seed(fixture, db);
      db.prepare(`update sealed_kv set payload_sealed = ? where key = 'config.list'`).run('这不是一个信封');
      const before = sealedSnapshot(db);

      const result = applyRekey(db, OLD_KEY, NEW_KEY, { iterations: FIXTURE_ITERATIONS });
      assertEqual(result.ok, false, '有一行读不通就必须整批失败');
      if (!result.ok) {
        assertEqual(result.code, REKEY_UNREADABLE_CODE, '错误码应指向"读不通"');
        assert(result.message.includes('config.list'), '要说清是**哪一行**读不通（个别行坏与口令错是两件事，处置不同）');
      }
      assertEqual(sealedSnapshot(db), before, '**其它可读的行也必须保持原样**（不许"部分完成"）');
    } finally {
      db.close();
      fixture.cleanup();
    }
  });

  process.exit(suite.report());
}

void main();
