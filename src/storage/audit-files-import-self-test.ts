// 审计与锚点从旧 NDJSON 文件搬家自测（I1~I6）。

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TestSuite, assert, assertEqual } from '../testing/harness.ts';
import { openDbFixture } from '../testing/db-fixture.ts';
import { AdminAuditLog, GENESIS_HASH, auditRecordHash, type AdminAuditRecord, type ChainedAdminAuditRecord } from '../core/admin-audit-store.ts';
import { LEGACY_AUDIT_LEDGER_ID, importAuditOnce, readLegacyAuditFile } from './audit-files-import.ts';

const suite = new TestSuite('审计与锚点搬家自测', [
  '说明：旧 NDJSON（`admin-audit.log` / `.anchors.ndjson`）→ 库；记账在 `import_ledger`，记了就再也不看旧文件。',
  'I3/I4 是安全关键：两套链不能混；被清空过的审计不许被旧文件复活。',
]);

const test = (name: string, fn: () => void | Promise<void>): Promise<void> => suite.test(name, fn);

function chainOf(count: number): ChainedAdminAuditRecord[] {
  let prev = GENESIS_HASH;
  const out: ChainedAdminAuditRecord[] = [];
  for (let index = 1; index <= count; index += 1) {
    const base: AdminAuditRecord = {
      seq: index,
      at: `2026-10-01T0${index}:00:00.000Z`,
      actor: 'ADMIN',
      subject: '模型接入配置',
      kind: '变更',
      changes: [{ field: 'endpoint', before: `http://a${index}`, after: `http://b${index}` }],
    };
    const hash = auditRecordHash(prev, base);
    out.push({ ...base, prevHash: prev, hash });
    prev = hash;
  }
  return out;
}

const ndjson = (items: unknown[]): string => `${items.map((item) => JSON.stringify(item)).join('\n')}\n`;

/** 记账：一个只用到 `ledgerHas/ledgerMark` 的替身（真账本在 `WorkStore` 里，见 I4 注释） */
function ledgerStub(): { ledgerHas(id: string): boolean; ledgerMark(id: string, note: string): void; marks: string[] } {
  const marks: string[] = [];
  return {
    marks,
    ledgerHas: (id) => marks.some((item) => item.startsWith(`${id}|`)),
    ledgerMark: (id, note) => {
      marks.push(`${id}|${note}`);
    },
  };
}

async function main(): Promise<void> {
  const fixture = openDbFixture({ prefix: 'l0-audit-import-' });
  const { db, dir } = fixture;
  const auditFile = join(dir, 'admin-audit.log');
  const anchorFile = `${auditFile}.anchors.ndjson`;

  try {
    await test('I1 没有旧文件 → 什么都不搬，而且**不记账**（以后放进来仍会被搬一次）', () => {
      const ledger = ledgerStub();
      const result = importAuditOnce({ workStore: ledger, db, auditFile, anchorFile });
      assertEqual(result.ran, true, '该跑一遍（判断"要不要搬"本身就是它的工作）');
      assertEqual(result.records, 0, '没有记录可搬');
      assertEqual(ledger.marks.length, 0, '**没搬东西就不该记账** —— 记早了会把"以后放进来"这条路堵死');
    });

    await test('I2 旧文件被撕断 → 只导入**验过的那一段**，并如实报问题', () => {
      const chain = chainOf(3);
      /* 第三条只有半截（崩溃留下的残行） */
      writeFileSync(auditFile, `${ndjson(chain.slice(0, 2))}${JSON.stringify(chain[2]).slice(0, 40)}`, 'utf8');
      /* 锚点：两条指向导入链上、一条指向"链外"（旧文件时代的污染） */
      writeFileSync(
        anchorFile,
        ndjson([
          { seq: 1, hash: chain[0]!.hash, at: '2026-10-01T01:30:00.000Z' },
          { seq: 2, hash: chain[1]!.hash, at: '2026-10-01T02:30:00.000Z' },
          { seq: 9, hash: 'f'.repeat(64), at: '2026-10-01T09:30:00.000Z' },
        ]),
        'utf8',
      );

      const ledger = ledgerStub();
      const result = importAuditOnce({ workStore: ledger, db, auditFile, anchorFile });
      assertEqual(result.records, 2, '撕断的那条**不导入**（不修补、不猜）');
      assert(String(result.problem ?? '').includes('尾行不完整'), `要把问题说出来，实际：${result.problem}`);
      assertEqual(result.anchors, 2, '指向导入链上的两条锚点入库');
      assertEqual(result.droppedAnchors, 1, '指向链外的那一条被丢弃（并把条数报出来）');
      assertEqual(ledger.marks.length, 1, '真搬了东西 → 记账');

      const log = new AdminAuditLog(db);
      const report = log.load();
      assertEqual(report.loaded, 2, '库里的链自洽');
      assertEqual(report.problem, null, '导入之后链内一切正常');
      assertEqual(
        Number((db.prepare('select count(*) as n from admin_audit_anchor').get() as { n?: number } | undefined)?.n),
        2,
        '库里只有指向本链的两条锚点',
      );
    });

    await test('I3 库里已有记录 → **一条都不导**（两套链不能混）', () => {
      /* 前置：库里已经有链（I2 导入的），且旧文件里是另一条链 */
      const other = chainOf(2);
      writeFileSync(auditFile, ndjson(other), 'utf8');
      const ledger = ledgerStub();
      const result = importAuditOnce({ workStore: ledger, db, auditFile, anchorFile });
      assertEqual(result.records, 0, '不导入（混进去会在第一条就断，那是看起来最像篡改的形态）');
      assert(String(result.reason).includes('已有'), `理由要说清，实际：${result.reason}`);
      assertEqual(ledger.marks.length, 1, '仍然记账（否则每次启动都要再看一遍这个文件）');
      assertEqual(new AdminAuditLog(db).load().loaded, 2, '库里还是原来那两条');
    });

    await test('I4 **记了账就不再碰旧文件**：清空审计之后，旧文件不许把它导回来', () => {
      db.exec('delete from admin_audit');
      const ledger = ledgerStub();
      ledger.ledgerMark(LEGACY_AUDIT_LEDGER_ID, '前置：假装这次实例已经搬过');
      const result = importAuditOnce({ workStore: ledger, db, auditFile, anchorFile });
      assertEqual(result.ran, false, '记了账 → 这次不看旧文件');
      assertEqual(result.records, 0, '什么都不导');
      assertEqual(
        Number((db.prepare('select count(*) as n from admin_audit').get() as { n?: number } | undefined)?.n),
        0,
        '**清空掉的审计不许被旧文件复活**（这条是记账的全部理由：清除是安全动作）',
      );
    });

    await test('I5 只有锚点文件、没有审计文件 → 不导入锚点（它们指向的链不在库里）', () => {
      const chain = chainOf(2);
      writeFileSync(anchorFile, ndjson([{ seq: 2, hash: chain[1]!.hash, at: '2026-10-01T02:30:00.000Z' }]), 'utf8');
      const ledger = ledgerStub();
      const result = importAuditOnce({
        workStore: ledger,
        db,
        auditFile: join(dir, '不存在的审计.log'),
        anchorFile,
        exists: (path) => path === anchorFile,
      });
      assertEqual(result.anchors, 0, '没有链可比，锚点导进来毫无意义');
      assert(String(result.reason).includes('只有锚点'), `理由要说清，实际：${result.reason}`);
    });

    await test('I6 旧文件里"改过一条"要能被指认（导入不是"照单全收"）', () => {
      const chain = chainOf(3);
      const tampered = { ...chain[1]!, changes: [{ field: 'endpoint', before: 'x', after: 'y' }] };
      const text = ndjson([chain[0]!, tampered, chain[2]!]);
      writeFileSync(auditFile, text, 'utf8');
      const parsed = readLegacyAuditFile(auditFile);
      assertEqual(parsed.records.length, 1, '只保留断点之前的那一条');
      assert(String(parsed.problem ?? '').includes('hash 不一致'), `要指认"内容与自身 hash 不一致"，实际：${parsed.problem}`);
      assertEqual(parsed.totalLines, 3, '文件里一共三行（断点之后的**留在原处**，不删）');
    });
  } finally {
    fixture.cleanup();
  }

  process.exit(suite.report());
}

void main();
