import { TestSuite, assert, assertEqual } from '../testing/harness.ts';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSyntheticDoc } from '../testing/synthetic.ts';
import type { DocumentModel, RevisionEntry } from '../model/types.ts';
import { inTransaction, openDatabase } from './sqlite.ts';
import { MIGRATIONS, STORAGE_SCHEMA_VERSION } from './schema.ts';
import { WorkStore, openWorkStore, type StoredDoc, type WorkspaceStructure } from './work-store.ts';
import {
  canonicalRevision,
  E_REVISION_LEDGER_TAMPERED,
  E_REVISION_LEDGER_TORN,
  GENESIS_HASH,
} from '../core/revision-ledger.ts';
import { DOCUMENT_FORMAT } from './formats.ts';
import { sealFor } from './sealed.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DIR = join(ROOT, 'artifacts', 'state-selftest', 'storage-selftest');
const PASS = 'selftest-storage-passphrase';
const ITER = 1000;

const suite = new TestSuite('数据库存储自测', [
  '说明：验证结构版本、迁移、加密载荷与往返保真；写入走事务，读不出来一律显式报错。',
  '迭代数在测试里压到 1000 —— 只影响派生强度，不影响语义。',
]);

const test = (name: string, fn: () => void | Promise<void>): Promise<void> => suite.test(name, fn);

const fsRemove = (await import('node:fs')) as unknown as { rmSync: (path: string, options: { recursive: boolean; force: boolean }) => void };

let dbSeq = 0;
function freshDbFile(): string {
  dbSeq += 1;
  return join(DIR, `case-${dbSeq}.db`);
}

function open(file: string, schemaVersion = STORAGE_SCHEMA_VERSION) {
  return openDatabase(file, { schemaVersion, migrations: MIGRATIONS, at: '2026-10-12T00:00:00.000Z' });
}

function openStore(file: string): { store: WorkStore; applied: string[]; fresh: boolean } {
  const opened = open(file);
  return openWorkStore({ opened, passphrase: PASS, iterations: ITER, at: () => '2026-10-12T00:00:00.000Z' });
}

const fixture = (): DocumentModel => buildSyntheticDoc({ sections: 2, paragraphsPerSection: 2, fieldsPerParagraph: 1 }).doc;

function grow(doc: DocumentModel, count: number): DocumentModel {
  const revisions = [...doc.revisions] as RevisionEntry[];
  for (let index = 0; index < count; index += 1) {
    revisions.push({
      rev: revisions.length + 1,
      at: `2026-10-12T00:00:0${index}Z`,
      actorId: 'DR_A',
      op: 'update',
      targetId: 'n_1',
      patch: [{ op: 'replace', path: '/nodes/n_1/text', value: `第 ${index} 次改`, oldValue: `第 ${index - 1} 次改` }],
    });
  }
  return { ...doc, revisions };
}

function structureOf(
  doc: DocumentModel,
  docs: StoredDoc[] = [{ docId: doc.docId, title: '入院记录' }],
  visitId = doc.encounter?.visitId ?? 'V1',
): WorkspaceStructure {
  return {
    patients: [
      {
        patientId: doc.patient.patientId,
        nameMasked: doc.patient.nameMasked ?? '(未标注)',
        gender: doc.patient.gender ?? 'U',
        visits: [{ visitId, visitType: doc.encounter?.visitType ?? 'inpatient', docs }],
      },
    ],
  };
}

async function main(): Promise<void> {
  try {
    fsRemove.rmSync(DIR, { recursive: true, force: true });
  } catch {
  }
  mkdirSync(DIR, { recursive: true });

  await test('D1 首次建库：迁移执行、版本落库；再开一次不再重复迁移', () => {
    const file = freshDbFile();
    const first = open(file);
    assert(first.fresh, '新文件应被认成首次建库');
    assertEqual(first.applied, MIGRATIONS.map((migration) => migration.id), '应把清单里的迁移全部执行一遍');
    assertEqual(
      Number(first.db.prepare('select value from storage_meta where key = ?').get('schema_version')?.value),
      STORAGE_SCHEMA_VERSION,
      '结构版本要落库',
    );
    first.db.close();

    const second = open(file);
    assertEqual(second.fresh, false, '第二次打开不是首次建库');
    assertEqual(second.applied, [], '已是最新版本则不该再迁移');
    second.db.close();
  });

  await test('D2 库比程序新 → **拒绝启动**（不猜着读）', () => {
    const file = freshDbFile();
    const opened = open(file);
    opened.db
      .prepare('insert into storage_meta (key, value) values (?, ?) on conflict(key) do update set value = excluded.value')
      .run('schema_version', '99');
    opened.db.close();

    let code = '';
    try {
      open(file);
    } catch (err) {
      code = String((err as { code?: string }).code ?? '');
    }
    assertEqual(code, 'E_STORAGE_VERSION_AHEAD', '用旧程序读新库必须被拒 —— 猜着读会"成功地"读出错的内容');
  });

  await test('D3 迁移失败 → 整体回滚（不留半个结构，版本号也不动）', () => {
    const file = freshDbFile();
    const opened = open(file);
    opened.db.close();

    let code = '';
    try {
      openDatabase(file, {
        schemaVersion: STORAGE_SCHEMA_VERSION + 1,
        at: '2026-10-12T00:00:00.000Z',
        migrations: [
          ...MIGRATIONS,
          { id: '9999-broken', note: '故意失败：第二条语句语法错误', sql: ['create table ok_table (a integer)', 'create table ('] },
        ],
      });
    } catch (err) {
      code = String((err as { code?: string }).code ?? '');
    }
    assertEqual(code, 'E_STORAGE_MIGRATION_FAILED', '迁移失败要报出来');

    const reopened = open(file);
    assertEqual(
      reopened.db.prepare("select count(*) as n from sqlite_master where name = 'ok_table'").get()?.n,
      0,
      '失败的迁移必须整体回滚（第一条语句也不能留下）',
    );
    assertEqual(
      reopened.db.prepare('select count(*) as n from schema_migrations').get()?.n,
      MIGRATIONS.length,
      '失败的迁移不该被记账（成功的那些条数仍等于清单长度）',
    );
    reopened.db.close();
  });

  await test('D4 文书往返保真：读回来的文书的与写进去的逐字节相同，留痕行数与 rev 一致', () => {
    const file = freshDbFile();
    const { store } = openStore(file);
    const doc = fixture();
    store.saveStructure(structureOf(doc, [{ docId: doc.docId, title: '入院记录', kind: 'admission' }]));
    store.saveDocument(doc);

    const loaded = store.loadDocument(doc.docId);
    assert(loaded.ok && loaded.found, `应能读回文书：${loaded.ok ? '' : loaded.message}`);
    assertEqual(JSON.stringify(loaded.ok && loaded.found ? loaded.doc : null), JSON.stringify(doc), '往返必须逐字节相同');

    const revs = store.documentMeta().find((meta) => meta.docId === doc.docId);
    assertEqual(revs?.rev, doc.revisions.length, '可查询的 rev 应与留痕条数一致');
    assertEqual(revs?.title, '入院记录', '结构里的标题要能查到');
    store.close();
  });

  await test('D5 内容加密：库文件里**搜不到明文**（诊断、主诉这类内容）', () => {
    const file = freshDbFile();
    const { store } = openStore(file);
    const doc = fixture();
    store.saveStructure(structureOf(doc));
    store.saveDocument(doc);
    store.saveSidecars(doc.docId, { suggestions: { items: [{ text: '主诉：胸痛三天，伴出汗' }] }, annotations: { items: [] } });
    store.putSealed('reading-grants', { grants: [{ note: '授权给心内科会诊' }] });
    store.close();

    const haystack = [file, `${file}-wal`, `${file}-shm`]
      .filter((path) => existsSync(path))
      /* 用 latin1 读：逐字节保留（做子串搜索用二进制/单字节编码才对，UTF-8 解码会把密文读乱） */
      .map((path) => readFileSync(path, 'latin1'))
      .join('\n');
    for (const needle of ['胸痛', '主诉', '心内科会诊', '入院记录']) {
      assert(!haystack.includes(needle), `库文件里不该出现明文「${needle}」（含 WAL）`);
    }
    assert(haystack.includes(doc.docId), '文书 id 应能直接查到（否则"按患者/就诊查"就无从谈起）');
  });

  await test('D6 口令不对 → 报错，**不是**"没有这份文书"', () => {
    const file = freshDbFile();
    const { store } = openStore(file);
    const doc = fixture();
    store.saveStructure(structureOf(doc));
    store.saveDocument(doc);
    store.close();

    const opened = open(file);
    const wrong = openWorkStore({ opened, passphrase: 'wrong-passphrase', iterations: ITER });
    const result = wrong.store.loadDocument(doc.docId);
    assertEqual(result.ok, false, '口令不对必须报错');
    assertEqual(result.ok ? '' : result.code, 'E_SEALED_DECRYPT_FAILED', '应给出可定位的解密失败码');
    assert(result.ok ? true : !result.message.includes('不存在'), '错误信息不得把"解不开"说成"不存在"');
    wrong.store.close();
  });

  await test('D7 旁挂数据：往返保真，且"没有"与"解不开"是两种结果', () => {
    const file = freshDbFile();
    const { store } = openStore(file);
    const doc = fixture();
    store.saveStructure(structureOf(doc));
    store.saveDocument(doc);

    const missing = store.loadSidecars(doc.docId);
    assert(missing.ok && !missing.found, '没写过 → 明确"没有"（首次启动可以放心建空）');

    const payload = { suggestions: { items: [{ id: 'sg1' }] }, annotations: { items: [{ id: 'an1' }] } };
    const saved = store.saveSidecars(doc.docId, payload);
    const loaded = store.loadSidecars<typeof payload>(doc.docId);
    assert(loaded.ok && loaded.found, '写过的应能读回');
    assertEqual(JSON.stringify(loaded.ok && loaded.found ? loaded.data : null), JSON.stringify(payload), '旁挂数据往返必须逐字节相同');
    assertEqual(loaded.ok && loaded.found ? loaded.digest : '', saved.digest, '摘要应一致（它是"这一版的基线"）');
    store.close();
  });

  await test('D8 只有结构、还没有正文的文书 → 报"只有结构"，**不返回空文书**', () => {
    const file = freshDbFile();
    const { store } = openStore(file);
    store.saveStructure({ patients: [{ patientId: 'P1', nameMasked: '张**', gender: 'M', visits: [{ visitId: 'V1', visitType: 'inpatient', docs: [{ docId: 'doc_x', title: '入院记录' }] }] }] });

    const result = store.loadDocument('doc_x');
    assertEqual(result.ok, false, '占位行不能当成"一份空病历"打开');
    assertEqual(result.ok ? '' : result.code, 'E_STORAGE_DOC_EMPTY', '应给出"只有结构没有正文"的明确错误码');
    assertEqual(store.countDocuments(), 1, '它仍然是一份"已登记的文书"（列表与统计要能看到它）');
    store.close();
  });

  await test('D9 顺序即数据：患者 / 就诊 / 文书的呈现顺序按写入顺序还原', () => {
    const file = freshDbFile();
    const { store } = openStore(file);
    store.saveStructure({
      patients: [
        { patientId: 'P_B', nameMasked: 'B**', gender: 'F', visits: [{ visitId: 'V_B2', visitType: 'inpatient', docs: [{ docId: 'd_B2', title: '病程记录' }, { docId: 'd_B1', title: '入院记录' }] }] },
        { patientId: 'P_A', nameMasked: 'A**', gender: 'M', visits: [
          { visitId: 'V_A2', visitType: 'outpatient', docs: [{ docId: 'd_A2', title: '门诊病历' }] },
          { visitId: 'V_A1', visitType: 'outpatient', docs: [{ docId: 'd_A1', title: '门诊病历' }] },
        ] },
      ],
    });
    const restored = store.loadStructure();
    assertEqual(restored.patients.map((patient) => patient.patientId), ['P_B', 'P_A'], '患者顺序应按写入顺序，而不是按 id 排序');
    assertEqual(restored.patients[0]?.visits[0]?.docs.map((doc) => doc.docId), ['d_B2', 'd_B1'], '文书顺序同样要保住（时间/ID 排序会换位置）');
    assertEqual(restored.patients[1]?.visits.map((visit) => visit.visitId), ['V_A2', 'V_A1'], '就诊顺序同理');
    store.close();
  });

  await test('D10 小体量整体式数据 + 清空工作数据：清的是工作数据，不碰账本', () => {
    const file = freshDbFile();
    const { store } = openStore(file);
    const doc = fixture();
    store.saveStructure(structureOf(doc));
    store.saveDocument(doc);
    store.putSealed('reading-grants', { grants: [{ grantId: 'g1' }] });
    store.ledgerMark('imported-from-files', '演示：旧文件存储已导入');

    const grants = store.getSealed<{ grants: Array<{ grantId: string }> }>('reading-grants');
    assertEqual(grants.ok && grants.found ? grants.data.grants[0]?.grantId : '', 'g1', '整体式数据要能往返');
    const nothing = store.getSealed('nothing-here');
    assert(nothing.ok && !nothing.found, '没写过 → 明确"没有"（而不是报错，也不是返回空对象）');

    store.clearWorkData();
    assertEqual(store.countDocuments(), 0, '清空后不该还有文书');
    assertEqual(store.stats().patients, 0, '患者也该清掉（否则树里会出现无主的孤儿）');
    assertEqual(store.ledgerHas('imported-from-files'), true, '一次性动作的账本**不该**被清 —— 清掉会导致下次又导入一遍');
    const grantsAfterClear = store.getSealed<{ grants: Array<{ grantId: string }> }>('reading-grants');
    assert(grantsAfterClear.ok && grantsAfterClear.found, '授权登记不是"工作数据"，不该跟着重置被清（见交付说明）');
    store.close();
  });

  await test('D11 事务语义：写一半失败则整体回滚（"一份文书 + 它的留痕"必须同生共死）', () => {
    const file = freshDbFile();
    const opened = open(file);
    const store = new WorkStore(opened.db, PASS, { iterations: ITER });
    const doc = fixture();
    store.saveStructure(structureOf(doc));

    const before = store.stats().revisions;
    let threw = false;
    try {
      inTransaction(opened.db, () => {
        opened.db.prepare('insert into document_revisions (doc_id, rev, at, actor_id, op) values (?, ?, ?, ?, ?)').run(doc.docId, 999, '2026-10-12T00:00:00Z', 'X', 'update');
        throw new Error('模拟写到一半失败');
      });
    } catch {
      threw = true;
    }
    assert(threw, '事务里的异常要往外抛（调用方必须知道没写成）');
    assertEqual(store.stats().revisions, before, '回滚之后不该留下半条留痕');
    store.close();
  });

  await test('D12 摘要列与密文列**自洽**：两列被分别改动过要能发现', () => {
    const file = freshDbFile();
    const opened = open(file);
    const store = new WorkStore(opened.db, PASS, { iterations: ITER });
    const doc = fixture();
    store.saveStructure(structureOf(doc));
    store.saveDocument(doc);
    store.saveSidecars(doc.docId, { suggestions: { items: [] }, annotations: { items: [] } });

    opened.db
      .prepare('update sidecars set payload_digest = ? where doc_id = ?')
      .run('0'.repeat(64), doc.docId);

    const loaded = store.loadSidecars(doc.docId);
    assertEqual(loaded.ok, false, '摘要与密文不符时要报错');
    assertEqual(loaded.ok ? '' : loaded.code, 'E_SEALED_DIGEST_MISMATCH', '应给出可定位的错误码');
    store.close();
  });

  await test('D13 从 v1 库迁到 v2：**已有数据不受影响**，且包表就位（迁移必须在有数据的库上验）', () => {
    const file = freshDbFile();
    const v1 = openDatabase(file, {
      schemaVersion: 1,
      migrations: MIGRATIONS.filter((migration) => migration.id === '0001-init'),
      at: '2026-10-12T00:00:00.000Z',
    });
    const before = new WorkStore(v1.db, PASS, { iterations: ITER });
    const doc = fixture();
    before.saveStructure(structureOf(doc));
    const sealed = sealFor(DOCUMENT_FORMAT, doc, PASS, { iterations: ITER });
    v1.db
      .prepare(
        'update documents set status = ?, updated_at = ?, rev = ?, payload_format = ?, payload_digest = ?, payload_sealed = ?, stored_at = ? where doc_id = ?',
      )
      .run(
        doc.status,
        doc.updatedAt,
        doc.revisions.length,
        sealed.format,
        sealed.digest,
        sealed.sealed,
        '2026-10-12T00:00:00.000Z',
        doc.docId,
      );
    before.saveSidecars(doc.docId, { suggestions: { items: [{ id: 'sg-1' }] }, annotations: { items: [] } });
    for (const revision of doc.revisions) {
      v1.db
        .prepare('insert into document_revisions (doc_id, rev, at, actor_id, op, target_id) values (?, ?, ?, ?, ?, ?)')
        .run(doc.docId, revision.rev, revision.at, revision.actorId, revision.op, revision.targetId ?? null);
    }
    const statsBefore = before.stats();
    before.close();

    const v2 = openDatabase(file, { schemaVersion: STORAGE_SCHEMA_VERSION, migrations: MIGRATIONS, at: '2026-10-12T01:00:00.000Z' });
    assertEqual(
      v2.applied,
      MIGRATIONS.filter((migration) => migration.id !== '0001-init').map((migration) => migration.id),
      '从 v1 升上来：应把 0001 之外的那几条全部执行',
    );
    assertEqual(
      Number(v2.db.prepare("select count(*) as n from sqlite_master where name = 'knowledge_packs'").get()?.n),
      1,
      '包表应就位',
    );

    const after = new WorkStore(v2.db, PASS, { iterations: ITER });
    assertEqual(after.countDocuments(), statsBefore.documents, '文书条数不能变');
    assertEqual(after.stats().sidecars, statsBefore.sidecars, '旁挂数据条数不能变');
    assertEqual(statsBefore.revisions, doc.revisions.length, '前置：旧版本写下的留痕是有的');
    assertEqual(after.stats().revisions, 0, '没有链的旧留痕账按设计丢弃（留痕的权威来源是文书载荷，不是这张表）');

    const loaded = after.loadDocument(doc.docId);
    assert(loaded.ok && loaded.found, `迁移之后文书仍要能读出来：${loaded.ok ? '' : loaded.message}`);
    assertEqual(JSON.stringify(loaded.ok && loaded.found ? loaded.doc : null), JSON.stringify(doc), '内容也要逐字节相同');

    after.saveDocument(doc);
    const chain = after.revisionChainReport(doc.docId);
    assertEqual(chain.problem, null, `重建出来的账要一路验到尾：${JSON.stringify(chain.problem)}`);
    assertEqual(chain.loaded, doc.revisions.length, '账要与文书里的留痕条数一致（重建，不是继承）');
    after.close();
  });

  await test('D14 留痕账是链式且只追加：删一条会被发现，改一条也跑不掉', () => {
    const file = freshDbFile();
    const opened = open(file);
    const store = new WorkStore(opened.db, PASS, { iterations: ITER });
    const doc = grow(fixture(), 3);
    store.saveStructure(structureOf(doc));
    store.saveDocument(doc);
    assertEqual(store.stats().revisions, doc.revisions.length, '首次保存：留痕全进账');

    const first = store.revisionChainReport(doc.docId);
    assertEqual(first.firstRun, false, '账已开');
    assertEqual(first.problem, null, `第一次验链应当全绿：${JSON.stringify(first.problem)}`);
    assertEqual(first.loaded, doc.revisions.length, '验过的条数应等于留痕条数');
    assert(!!first.head, '链头要能给出（这是这份文书的账"说到哪一句"）');

    const before = store.stats().revisions;
    const rowsBefore = opened.db
      .prepare('select rev, prev_hash, hash from document_revisions where doc_id = ? order by rev asc')
      .all(doc.docId) as unknown as Array<{ rev: number; prev_hash: string; hash: string }>;
    const grown = grow(doc, 2);
    store.saveDocument(grown);
    const rowsAfter = opened.db
      .prepare('select rev, prev_hash, hash from document_revisions where doc_id = ? order by rev asc')
      .all(doc.docId) as unknown as Array<{ rev: number; prev_hash: string; hash: string }>;
    assertEqual(store.stats().revisions, before + 2, '第二次保存只多了两条');
    assertEqual(
      JSON.stringify(rowsAfter.slice(0, rowsBefore.length)),
      JSON.stringify(rowsBefore),
      '已有行一字未改（只追加，不重写）',
    );
    assertEqual(rowsAfter[0]?.prev_hash, GENESIS_HASH, '首条的 prev_hash 是全零常量');
    const second = store.revisionChainReport(doc.docId);
    assertEqual(second.problem, null, `追加之后链仍要全绿：${JSON.stringify(second.problem)}`);
    assert(second.head !== first.head, '多了两条，链头就该往前走');

    const ledger = store.documentRevisionLedger(doc.docId);
    assertEqual(ledger.entries.length, grown.revisions.length, '读出来的条数要对');
    assertEqual(
      ledger.entries.every((entry, index) => canonicalRevision(entry) === canonicalRevision(grown.revisions[index] as never)),
      true,
      '逐条内容要与文书里的留痕一致',
    );

    opened.db
      .prepare('update document_revisions set payload = ? where doc_id = ? and rev = ?')
      .run(canonicalRevision({ ...(grown.revisions[1] as RevisionEntry), op: 'delete' }), doc.docId, 2);
    const tampered = store.revisionChainReport(doc.docId);
    assertEqual(tampered.problem?.kind, 'tampered', `改过的那条要被点出来：${JSON.stringify(tampered.problem)}`);
    assertEqual(tampered.problem?.atRev, 2, '断点位置要指到被改的那条');
    assertEqual(tampered.loaded, 1, '断点之前的那几条仍然可用');
    assertEqual(tampered.discarded, grown.revisions.length - 1, '断点之后的如实报为"未验证"，而不是丢掉');
    assertEqual(tampered.head, null, '账有断点时不再声称链头');

    let code2 = 'OK';
    try {
      store.saveDocument(grown);
    } catch (err) {
      code2 = (err as { code?: string }).code ?? 'UNKNOWN';
    }
    assertEqual(code2, E_REVISION_LEDGER_TAMPERED, '账已于文书对不上时必须显式失败（替篡改者把账做平是最坏的结果）');
    store.close();
  });

  await test('D15 留痕账：抽掉中间一条 / 留痕被丢弃，都要说得出是哪一类', () => {
    const file = freshDbFile();
    const opened = open(file);
    const store = new WorkStore(opened.db, PASS, { iterations: ITER });
    const doc = grow(fixture(), 3);
    store.saveStructure(structureOf(doc));
    store.saveDocument(doc);
    opened.db.prepare('delete from document_revisions where doc_id = ? and rev = 2').run(doc.docId);
    const gapped = store.revisionChainReport(doc.docId);
    assertEqual(gapped.problem?.kind, 'revGap', `抽掉中间一条要报序号不连续：${JSON.stringify(gapped.problem)}`);
    assertEqual(gapped.loaded, 1, '断点之前的那条仍然可用');

    let code2 = 'OK';
    try {
      store.saveDocument({ ...doc, revisions: doc.revisions.slice(0, 2) });
    } catch (err) {
      code2 = (err as { code?: string }).code ?? 'UNKNOWN';
    }
    assertEqual(code2, E_REVISION_LEDGER_TORN, '文书里的留痕比账上少时要显式失败');
    store.close();
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
