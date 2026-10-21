import { TestSuite, assert, assertEqual } from '../testing/harness.ts';
import { openDbFixture } from '../testing/db-fixture.ts';
import {
  AdminAuditLog,
  GENESIS_HASH,
  auditRecordHash,
  type AdminAuditRecord,
} from './admin-audit-store.ts';

const suite = new TestSuite('管理审计落库自测', [
  '说明：`admin_audit` 表 + SM3 链式摘要；验链不过就停在断点，不跳过、不修补、不删。',
  'A4/A5/A6 是防回退关键：改历史要能被指认；删尾检不出来是**已知边界**（靠锚点）。',
]);

const test = (name: string, fn: () => void | Promise<void>): Promise<void> => suite.test(name, fn);

function record(index: number): Omit<AdminAuditRecord, 'seq'> {
  return {
    at: `2026-10-12T0${index}:00:00.000Z`,
    actor: 'ADMIN',
    subject: '模型接入配置',
    kind: '变更',
    changes: [{ field: 'endpoint', before: `http://a${index}`, after: `http://b${index}` }],
    note: `第 ${index} 条`,
  };
}

const rowCount = (db: { prepare: (sql: string) => { get: () => unknown } }): number =>
  Number((db.prepare('select count(*) as n from admin_audit').get() as { n?: number } | undefined)?.n ?? 0);

async function main(): Promise<void> {
  const fixture = openDbFixture({ prefix: 'l0-audit-' });
  const { db } = fixture;
  const seed = (): AdminAuditLog => {
    const log = new AdminAuditLog(db);
    log.load();
    return log;
  };

  try {
    await test('A1 首次启动：库里一条都没有 → firstRun，且**不写任何行**（空库与"启动过"是两件事）', () => {
      const log = new AdminAuditLog(db);
      const report = log.load();
      assertEqual(report.firstRun, true, '库里为空应报 firstRun');
      assertEqual(report.totalInStore, 0, '没有记录');
      assertEqual(report.problem, null, '没有问题');
      assertEqual(log.total(), 0, '内存里也是空的');
      assertEqual(rowCount(db), 0, '只读不写：不应凭空插进一行');
    });

    await test('A2 追加与链：每条 prevHash 指向上一条，hash 可复算', () => {
      const log = seed();
      const first = log.append(record(1));
      const second = log.append(record(2));
      const third = log.append(record(3));

      assertEqual(first.seq, 1, '序号从 1 开始');
      assertEqual(first.prevHash, GENESIS_HASH, '首条的 prevHash 应为全零');
      assertEqual(second.prevHash, first.hash, '第二条指向上一条');
      assertEqual(third.prevHash, second.hash, '第三条指向上一条');
      assertEqual(auditRecordHash(third.prevHash, third), third.hash, 'hash 必须可复算（否则"验链"没有依据）');
      assertEqual(rowCount(db), 3, '写了三行');
      const changesRow = db.prepare('select changes from admin_audit where seq = 2').get() as unknown as { changes?: string };
      assertEqual(
        String(changesRow?.changes),
        JSON.stringify([{ field: 'endpoint', before: 'http://a2', after: 'http://b2' }]),
        'changes 以 JSON 存一列（形状与链式摘要里用的那一份一致）',
      );
    });

    await test('A3 重载一致：新实例读出来与写进去的逐条相同', () => {
      const reloaded = new AdminAuditLog(db);
      const report = reloaded.load();
      assertEqual(report.firstRun, false, '库里有记录');
      assertEqual(report.loaded, 3, '三条都通过验链');
      assertEqual(report.problem, null, '链完好');
      assertEqual(report.discarded, 0, '没有丢弃任何条目');

      const entries = reloaded.entries();
      assertEqual(entries.map((item) => item.seq), [1, 2, 3], '序号连续');
      assertEqual(entries.map((item) => item.note), ['第 1 条', '第 2 条', '第 3 条'], '内容逐条保留');
      assertEqual(reloaded.recent(2).map((item) => item.seq), [3, 2], '最近 N 条**最新的在前**（界面口径）');
      assertEqual(reloaded.total(), 3, '总数');
    });

    await test('A4 改一条历史 → 指认断点；断点之后的条目**不展示但仍留在库里**', () => {
      db.prepare('update admin_audit set changes = ? where seq = 2').run(
        JSON.stringify([{ field: 'endpoint', before: 'http://a2', after: 'http://TAMPERED' }]),
      );

      const log = new AdminAuditLog(db);
      const report = log.load();
      assertEqual(report.problem?.kind, 'broken', '必须报"链断"');
      assertEqual((report.problem as { kind: string; atLine: number; seq: number | null }).atLine, 2, '应指认断在第 2 条');
      assertEqual((report.problem as { kind: string; seq: number | null }).seq, 2, '应指认是第 2 条');
      assertEqual(report.loaded, 1, '只保留断点之前的记录');
      assertEqual(report.discarded, 2, '断点之后未展示的条目数要如实上报（没能验证 ≠ 没有）');
      assertEqual(log.entries().map((item) => item.seq), [1], '**不把未经验证的条目当好数据展示**');
      assertEqual(rowCount(db), 3, '**断点之后的行留在库里**：删掉它们就是审计系统自己销毁证据');
    });

    await test('A5 **删尾在链内检不出来**（如实承认边界：它才是锚点存在的理由）', () => {
      db.exec('delete from admin_audit');
      const log = seed();
      log.append(record(1));
      log.append(record(2));
      log.append(record(3));
      db.prepare('delete from admin_audit where seq = 3').run();

      const after = new AdminAuditLog(db);
      const report = after.load();
      assertEqual(report.loaded, 2, '剩下两条自身都自洽');
      assertEqual(report.problem, null, '**链内一切正常** —— 尾部被删这件事，链自己说不出来');
      assertEqual(report.totalInStore, 2, '库里就两行（被删的那一行不知去向，链内无从判断）');
    });

    await test('A6 删掉中间一条 → 链断（下一行的 prevHash 对不上）', () => {
      db.exec('delete from admin_audit');
      const log = seed();
      log.append(record(1));
      log.append(record(2));
      log.append(record(3));
      db.prepare('delete from admin_audit where seq = 2').run();

      const after = new AdminAuditLog(db);
      const report = after.load();
      assertEqual(report.problem?.kind, 'broken', '删一条也是"链断"');
      assertEqual((report.problem as { atLine: number }).atLine, 2, '断点落在被删条目的位置');
      assertEqual(String((report.problem as { reason: string }).reason).includes('prevHash'), true, '原因要说清是 prevHash 对不上');
      assertEqual(report.loaded, 1, '只保留第一条');
    });

    await test('A7 摘要与键序无关（否则"换个序列化实现"会被误判成"链断了"）', () => {
      const base: AdminAuditRecord = {
        seq: 7,
        at: '2026-10-12T07:00:00.000Z',
        actor: 'ADMIN',
        subject: '签名配置',
        kind: '动作',
        changes: [{ field: 'a', before: '1', after: '2' }],
      };
      const shuffled: AdminAuditRecord = {
        changes: [{ before: '1', after: '2', field: 'a' }],
        kind: '动作',
        subject: '签名配置',
        actor: 'ADMIN',
        at: '2026-10-12T07:00:00.000Z',
        seq: 7,
      };
      assertEqual(auditRecordHash(GENESIS_HASH, shuffled), auditRecordHash(GENESIS_HASH, base), '键序不同、内容相同 → 同一摘要');

      const changed = { ...base, changes: [{ field: 'a', before: '1', after: '3' }] };
      assert(auditRecordHash(GENESIS_HASH, changed) !== auditRecordHash(GENESIS_HASH, base), '内容不同必须得到不同摘要');

      assertEqual(
        auditRecordHash(GENESIS_HASH, { ...base, note: undefined }),
        auditRecordHash(GENESIS_HASH, { ...base }),
        'note 缺省与未给应等价',
      );
    });

    await test('A8 序号被改并**重算该条自己的 hash** → 报 seqGap（链内其它校验都看不出）', () => {
      db.exec('delete from admin_audit');
      const log = seed();
      log.append(record(1));
      log.append(record(2));
      log.append(record(3));

      const target = db.prepare('select * from admin_audit where seq = 3').get() as unknown as {
        prev_hash: string;
        at: string;
        actor: string;
        subject: string;
        kind: string;
        changes: string;
        note: string | null;
      };
      const tampered: AdminAuditRecord = {
        seq: 99,
        at: String(target.at),
        actor: String(target.actor),
        subject: String(target.subject),
        kind: String(target.kind) as AdminAuditRecord['kind'],
        changes: JSON.parse(String(target.changes)) as AdminAuditRecord['changes'],
        note: String(target.note),
      };
      const newHash = auditRecordHash(String(target.prev_hash), tampered);
      db.prepare('update admin_audit set seq = 99, hash = ? where seq = 3').run(newHash);

      const after = new AdminAuditLog(db);
      const report = after.load();
      assert(!!report.problem && report.problem.kind === 'seqGap', `应报序号不连续，实际：${JSON.stringify(report.problem)}`);
      if (report.problem && report.problem.kind === 'seqGap') {
        assertEqual(report.problem.atLine, 3, '应指认第 3 条');
        assertEqual(report.problem.expected, 3, '期望序号 3');
        assertEqual(report.problem.actual, 99, '实际序号 99');
      }
      assertEqual(report.loaded, 2, '停在断点之前，不把后面的当好数据');
    });

    await test('A9 **两个实例接同一条链**：序号与 prevHash 连续（文件时代这里会混出两条链）', () => {
      db.exec('delete from admin_audit');
      const first = seed();
      const second = seed();

      const a1 = first.append(record(1));
      const b1 = second.append(record(2));
      const a2 = first.append(record(3));

      assertEqual([a1.seq, b1.seq, a2.seq], [1, 2, 3], '两个实例交替追加，序号仍然连续');
      assertEqual(b1.prevHash, a1.hash, '第二个实例接的是**库里**的链头（不是它自己的内存副本）');
      assertEqual(a2.prevHash, b1.hash, '第一个实例回头再追加，也要接上库里最新的那一条');

      const reread = new AdminAuditLog(db);
      assertEqual(reread.load().problem, null, '重新读一遍：整条链自洽');
    });

    await test('A10 序号重复被主键拦住（可发现的失败，好过"两条链混在一份文件里"）', () => {
      const log = seed();
      let message = 'OK';
      try {
        db.prepare(
          `insert into admin_audit (seq, at, actor, subject, kind, changes, note, prev_hash, hash)
           values (2, '2026-10-12T09:00:00.000Z', 'X', '模板', '变更', '[]', null, 'x', 'y')`,
        ).run();
        log.load();
      } catch (err) {
        message = (err as Error).message;
      }
      assert(message !== 'OK', '重复序号必须失败（而不是静默覆盖或追加成第二条链）');
      assert(
        message.includes('UNIQUE') || message.includes('PRIMARY KEY') || message.includes('constraint'),
        `失败原因要说清是唯一性约束，实际：${message}`,
      );
      assertEqual(rowCount(db), 3, '失败之后库里还是原来那三条（没有半截状态）');
    });
  } finally {
    fixture.cleanup();
  }

  process.exit(suite.report());
}

void main();
