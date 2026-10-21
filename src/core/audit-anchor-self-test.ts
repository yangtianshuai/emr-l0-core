import { TestSuite, assert, assertEqual } from '../testing/harness.ts';
import { openDbFixture } from '../testing/db-fixture.ts';
import {
  AdminAuditLog,
  GENESIS_HASH,
  auditRecordHash,
  insertAuditRow,
  type AdminAuditRecord,
  type ChainedAdminAuditRecord,
} from './admin-audit-store.ts';
import {
  ANCHOR_ERRORS,
  AuditAnchorStore,
  anchorText,
  headOf,
  signAnchor,
  verifyAnchor,
} from './admin-audit-anchor.ts';
import { demoKeyPair, softwareSigner, softwareVerifier } from '../crypto/provider.ts';
import { utf8 } from '../crypto/sm3.ts';
import type { SqliteDatabase } from '../storage/sqlite.ts';

let db: SqliteDatabase;

const signer = softwareSigner(demoKeyPair('l0-audit-anchor-demo').privateKey);
const verifier = softwareVerifier(signer.publicKey);
const OTHER_SIGNER = softwareSigner(demoKeyPair('l0-audit-anchor-demo-other').privateKey);
const verify = (text: string, signature: Uint8Array): boolean => verifier.verify(utf8(text), signature);

const suite = new TestSuite('审计链头锚定自测', [
  '说明：链内校验（admin-audit-store）只保证内部自洽；本套件验证"链外参照点"能查出删尾与整链重写。',
  'A8 是已知边界：拿得到签名私钥的人重签锚点后可绕过 —— 这一条被写成用例，而不是一句注释。',
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

function buildChain(n: number): ChainedAdminAuditRecord[] {
  db.exec('delete from admin_audit');
  const log = new AdminAuditLog(db);
  log.load();
  for (let i = 1; i <= n; i += 1) log.append(record(i));
  const reloaded = new AdminAuditLog(db);
  reloaded.load();
  return reloaded.entries();
}

function rewriteChain(
  removeSeq: number[] = [],
  mutate?: (records: ChainedAdminAuditRecord[]) => void,
): ChainedAdminAuditRecord[] {
  const before = new AdminAuditLog(db);
  before.load();
  const parsedAll = before.entries().map((item) => ({ ...item, changes: item.changes.map((change) => ({ ...change })) }));
  mutate?.(parsedAll);
  const kept = parsedAll.filter((item) => !removeSeq.includes(item.seq));
  let prev = GENESIS_HASH;
  const rewritten: ChainedAdminAuditRecord[] = [];
  kept.forEach((item, index) => {
    const base: AdminAuditRecord = {
      seq: index + 1,
      at: item.at,
      actor: item.actor,
      subject: item.subject,
      kind: item.kind,
      changes: item.changes,
      ...(item.note !== undefined ? { note: item.note } : {}),
    };
    const hash = auditRecordHash(prev, base);
    rewritten.push({ ...base, prevHash: prev, hash });
    prev = hash;
  });
  db.exec('delete from admin_audit');
  for (const item of rewritten) insertAuditRow(db, item);
  const after = new AdminAuditLog(db);
  const reload = after.load();
  assertEqual(reload.problem, null, '前置：重写后的链必须**内部自洽**（否则这条用例没在测锚点）');
  return after.entries();
}

async function main(): Promise<void> {
  const fixture = openDbFixture({ prefix: 'l0-anchor-' });
  db = fixture.db;

  await test('A1 未锚定：必须如实说"删尾与整链重写无从判断"，而不是报通过', () => {
    const records = buildChain(3);
    const report = verifyAnchor(records, null, { verify });
    assertEqual(report.status, 'none', '没有锚点时不能报 match');
    assertEqual(report.signed, false, '未签名');
    assert(report.message.includes('无法检出'), `信息要说清局限，实际：${report.message}`);
    assertEqual(report.headSeq, 3, '仍应报出当前链头，便于人工比对');
  });

  await test('A2 锚定到链头：一致即通过，并如实报"锚点之后还有几条没被锚定"', () => {
    const records = buildChain(3);
    const head = headOf(records);
    assert(!!head, '前置：链头存在');
    const anchor = signAnchor(head!, '2026-10-12T03:30:00.000Z', signer);

    const report = verifyAnchor(records, anchor, { verify });
    assertEqual(report.status, 'match', '一致应通过');
    assertEqual(report.signed, true, '应识别出带签名');
    assertEqual(report.unanchored, 0, '锚点就在链头，没有未锚定的部分');
    assertEqual(report.anchorSeq, 3, '应回报锚点位置');
    assertEqual(report.anchorAt, '2026-10-12T03:30:00.000Z', '应回报锚定时刻');
  });

  await test('A3 锚点之后继续追加是**正常**的（检查点语义，不是"链头必须相等"）', () => {
    const records = buildChain(5);
    const anchor = signAnchor({ seq: 3, hash: records[2]!.hash }, '2026-10-12T03:30:00.000Z', signer);
    const report = verifyAnchor(records, anchor, { verify });
    assertEqual(report.status, 'match', '追加记录不该被判成篡改');
    assertEqual(report.unanchored, 2, '但要如实报出"其后的 2 条尚无锚点"');
    assert(report.message.includes('尚无锚点'), `信息要提示再锚定，实际：${report.message}`);

    const truncated = buildChain(3);
    const blind = verifyAnchor(truncated, anchor, { verify });
    assertEqual(blind.status, 'match', '锚点只覆盖到第 3 条，删掉第 4/5 条时它看不出问题 —— 这就是要周期性锚定的原因');
  });

  await test('A4 **删尾**（链的前缀依然完好）→ 锚点检出', () => {
    const full = buildChain(5);
    const anchor = signAnchor(headOf(full)!, '2026-10-12T05:00:00.000Z', signer);

    db.prepare('delete from admin_audit where seq > 3').run();
    const afterDelete = new AdminAuditLog(db);
    const reload = afterDelete.load();
    assertEqual(reload.problem, null, '前置：链内校验**发现不了**删尾（这正是缺口）');
    assertEqual(reload.loaded, 3, '链路读出来 3 条，且自洽');

    const report = verifyAnchor(afterDelete.entries(), anchor, { verify });
    assertEqual(report.status, 'mismatch', '锚点必须检出删尾');
    assertEqual(report.code, ANCHOR_ERRORS.E_AUDIT_ANCHOR_MISMATCH, '应给出可定位的错误码');
    assert(report.message.includes('尾部被删'), `信息要说清是删尾，实际：${report.message}`);
  });

  await test('A5 改一条历史内容后重算整链（链内自洽）→ 锚点检出', () => {
    const full = buildChain(4);
    const anchor = signAnchor(headOf(full)!, '2026-10-12T05:00:00.000Z', signer);

    const records = rewriteChain([], (items) => {
      items[1]!.changes = [{ field: 'endpoint', before: 'http://a2', after: 'http://INNOCENT' }];
    });
    assertEqual(records[1]?.changes[0]?.after, 'http://INNOCENT', '前置：内容确实被改了');

    const report = verifyAnchor(records, anchor, { verify });
    assertEqual(report.status, 'mismatch', '锚点必须检出"改内容并重算链"');
    assert(
      report.message.includes('整条链被重写') || report.message.includes('该条被改'),
      `信息要点明形态，实际：${report.message}`,
    );
  });

  await test('A6 **删一条 + 重新编号 + 重算整链**（seq 连续、完全自洽）→ 锚点检出', () => {
    const full = buildChain(5);
    const anchor = signAnchor(headOf(full)!, '2026-10-12T05:00:00.000Z', signer);

    const records = rewriteChain([3]);
    assertEqual(records.map((item) => item.seq), [1, 2, 3, 4], '重写后 seq 连续（链内校验与 seq 校验都看不出问题）');
    assertEqual(records.length, 4, '少了一条');

    const report = verifyAnchor(records, anchor, { verify });
    assertEqual(report.status, 'mismatch', '锚点必须检出"删一条并重编号"');
    assertEqual(report.code, ANCHOR_ERRORS.E_AUDIT_ANCHOR_MISMATCH, '错误码');
    assert(report.message.includes('尾部被删'), `删到第 5 条没了，表现形式就是"链比锚点短"，实际：${report.message}`);
  });

  await test('A7 锚点被**另一把密钥**重签 → 验签不过（锚点本身被动过）', () => {
    const records = buildChain(3);
    const forged = signAnchor(headOf(records)!, '2026-10-12T05:00:00.000Z', OTHER_SIGNER);
    const report = verifyAnchor(records, forged, { verify });
    assertEqual(report.status, 'mismatch', '不是持有该密钥的一方签的，不能算通过');
    assertEqual(report.code, ANCHOR_ERRORS.E_AUDIT_ANCHOR_SIGNATURE, '应给出签名错误码');
    assert(report.message.includes('签名验不过'), `信息要说清是签名问题，实际：${report.message}`);
  });

  await test('A8 **已知边界**：拿得到签名私钥的人删尾后重签锚点 → 检不出来', () => {
    const full = buildChain(5);
    void signAnchor(headOf(full)!, '2026-10-12T05:00:00.000Z', signer);

    db.prepare('delete from admin_audit where seq > 3').run();
    const afterDelete = new AdminAuditLog(db);
    afterDelete.load();
    const records = afterDelete.entries();

    const resigned = signAnchor(headOf(records)!, '2026-10-12T06:00:00.000Z', signer);
    const report = verifyAnchor(records, resigned, { verify });
    assertEqual(report.status, 'match', '**这是边界**：私钥泄露（或公开种子）时检不出来 —— 不能对外说成"防篡改已解决"');
    assertEqual(report.signed, true, '签名仍然"有效"（它确实是那把密钥签的）');
  });

  await test('A9 锚点带签名但没提供验签能力 → fail-closed（验不了不算通过）', () => {
    const records = buildChain(3);
    const anchor = signAnchor(headOf(records)!, '2026-10-12T05:00:00.000Z', signer);
    const report = verifyAnchor(records, anchor, {});
    assertEqual(report.status, 'mismatch', '"有签名但我验不了"不能当作"验过了没问题"');
    assertEqual(report.code, ANCHOR_ERRORS.E_AUDIT_ANCHOR_SIGNATURE, '错误码');
    assert(report.message.includes('fail-closed'), `信息要说明为什么拒绝，实际：${report.message}`);
    /* 未签名的锚点则必须在没有验签能力时也能用（否则等于强制要求签名）  */
    const unsigned = { seq: anchor.seq, hash: anchor.hash, at: anchor.at };
    const okReport = verifyAnchor(records, unsigned, {});
    assertEqual(okReport.status, 'match', '未签名锚点不要求验签能力');
    assertEqual(okReport.signed, false, '并如实标注"未签名"（弱化的一档，不能说成签名已核对）');
  });

  await test('A10 记录被清空 → 锚点检出（锚点还在，链没了）', () => {
    const records = buildChain(3);
    const anchor = signAnchor(headOf(records)!, '2026-10-12T05:00:00.000Z', signer);
    const report = verifyAnchor([], anchor, { verify });
    assertEqual(report.status, 'mismatch', '空链与锚点不可能一致');
    assert(report.message.includes('尾部被删光') || report.message.includes('清空'), `信息要说清，实际：${report.message}`);
  });

  await test('A11 锚点入库：非法形状**写不进去**，重复锚定是幂等的', () => {
    db.exec('delete from admin_audit_anchor');
    const store = new AuditAnchorStore(db);
    assertEqual(store.load().firstRun, true, '库里没有锚点应报 firstRun');
    assertEqual(store.append({ seq: 1, hash: 'a'.repeat(64), at: '2026-10-12T01:00:00.000Z' }), true, '第一条是新写入');
    assertEqual(store.append({ seq: 2, hash: 'b'.repeat(64), at: '2026-10-12T02:00:00.000Z' }), true, '第二条是新写入');
    assertEqual(store.count(), 2, '追加两条');
    assertEqual(new AuditAnchorStore(db).load().anchors.length, 2, '重新读出来还是两条');
    assertEqual(store.latest()?.seq, 2, 'latest 应给最后一条');

    assertEqual(store.append({ seq: 2, hash: 'b'.repeat(64), at: '2026-10-12T03:00:00.000Z' }), false, '重复锚定不产生第二行');
    assertEqual(new AuditAnchorStore(db).load().anchors.length, 2, '库里仍然只有两条');

    /* 非法形状（缺 head_hash）必须写不进去：可发现的失败，好过库里悄悄多一条坏锚 */
    let failure = 'OK';
    try {
      db.prepare('insert into admin_audit_anchor (head_seq, head_hash, at) values (9, null, ?)').run('2026-10-12T09:00:00.000Z');
    } catch (err) {
      failure = (err as Error).message;
    }
    assert(failure !== 'OK', '缺 head_hash 的锚点必须写不进去');
    assert(
      failure.includes('NOT NULL') || failure.includes('constraint') || failure.includes('null'),
      `失败原因要说清是列约束，实际：${failure}`,
    );
    assertEqual(new AuditAnchorStore(db).load().error, null, '库里剩下的锚点仍然是好的（没有半截状态）');
  });

  await test('A12 锚点文本规范化：字段顺序与分隔固定（换实现不会验不过）', () => {
    const text = anchorText({ seq: 7, hash: 'd'.repeat(64) }, '2026-10-12T07:00:00.000Z');
    assertEqual(
      text,
      `l0-admin-audit-anchor/v1\nseq=7\nhash=${'d'.repeat(64)}\nat=2026-10-12T07:00:00.000Z`,
      '规范化文本必须逐字固定：否则"换个序列化实现就验不过"',
    );
  });

  await test('A13 **锚点要能被带出这台机器**（它与链同库，同机另一处挡不住同一个人）', () => {
    db.exec('delete from admin_audit_anchor');
    const store = new AuditAnchorStore(db);
    assertEqual(store.table, 'admin_audit_anchor', '表名要能对使用者交代（它不是内部细节）');
    store.append(signAnchor({ seq: 7, hash: 'e'.repeat(64) }, '2026-10-12T07:00:00.000Z', signer));

    const exported = new AuditAnchorStore(db).load().anchors.find((item) => item.seq === 7);
    assert(!!exported, '锚点应能从库里读出来（导出就是一条查询）');
    assertEqual(exported?.hash, 'e'.repeat(64), '导出必须包含链头摘要');
    assertEqual(exported?.at, '2026-10-12T07:00:00.000Z', '导出必须包含锚定时刻');
    assertEqual(exported?.signerFingerprint, signer.fingerprint, '导出必须包含签名者指纹（否则答不出"是谁锚的"）');
    assert(!!exported?.signature, '带签名的锚点，导出必须带上签名本身');
    assertEqual(store.append({ seq: 7, hash: 'e'.repeat(64), at: '2026-10-12T08:00:00.000Z' }), false, '同一链头再锚一次是幂等的');
  });

  fixture.cleanup();
  process.exit(suite.report());
}

void main();
