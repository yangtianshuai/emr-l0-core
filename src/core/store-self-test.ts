import { mkdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TestSuite, assert, assertEqual } from '../testing/harness.ts';
import {
  inspectSealedSidecars,
  loadSidecarsSealed,
  loadWorkspace,
  resealSidecars,
  resolveStateSalt,
  saltFingerprint,
  saveSidecarsSealed,
  saveWorkspace,
  WORKSPACE_FORMAT,
  type WorkspaceScope,
} from './store.ts';
import { fromHex } from '../crypto/sm3.ts';
import { SuggestionBook } from './suggestions.ts';
import { AnnotationBook } from './annotations.ts';
import { PatientIndex } from '../model/identity.ts';

const suite = new TestSuite('工作区存储自测', [
  '说明：验证的是"重启之后还对不对"，重点是失败路径与 ID 不复用。',
  'S2/S3 是防回退关键：空启动会掩盖数据丢失，seq 重置会让审计对不上账。',
]);

const test = (name: string, fn: () => void | Promise<void>): Promise<void> => suite.test(name, fn);

const fsx = (await import('node:fs')) as unknown as {
  rmSync: (path: string, options: { recursive: boolean; force: boolean }) => void;
};
const TEMP = process.env.TEMP ?? process.env.TMP ?? '.';
const ROOT = join(TEMP, 'l0-store-self-test');
const file = (name: string): string => join(ROOT, name);
const cleanRoot = (): void => {
  if (existsSync(ROOT)) fsx.rmSync(ROOT, { recursive: true, force: true });
};

const AT = '2026-10-09T09:00:00Z';

function emptyScope(): WorkspaceScope {
  return { suggestions: new SuggestionBook(), annotations: new AnnotationBook(), patients: new PatientIndex() };
}

async function main(): Promise<void> {
  cleanRoot();
  mkdirSync(ROOT, { recursive: true });

  await test('S1 三份数据一起存、一起恢复（一个文件，避免跨文件不一致）', () => {
    const target = file('s1.json');
    const scope = emptyScope();
    scope.suggestions.add({ targetNodeId: 'n_1', text: '草稿', confidence: 0.9, modelId: 'm1', at: AT });
    scope.annotations.add({ kind: 'quality', severity: 'warn', anchor: { nodeId: 'n_1' }, title: '提示', source: { kind: 'system', ruleId: 'R-1' }, at: AT });
    scope.patients.register('P_001', [{ system: 'his', value: 'H1' }], AT, 'admin');

    const meta = saveWorkspace(target, scope, { at: AT });
    assertEqual(meta.format, WORKSPACE_FORMAT, '应带格式标识');

    const loaded = loadWorkspace(target);
    assertEqual(loaded.ok, true, '应加载成功');
    if (loaded.ok) {
      assertEqual(loaded.firstRun, false, '文件存在即非首次启动');
      assertEqual(loaded.scope.suggestions.size(), 1, '建议应恢复');
      assertEqual(loaded.scope.annotations.size(), 1, '注解应恢复');
      assertEqual(loaded.scope.patients.size(), 1, '主索引应恢复');
      assertEqual(loaded.scope.patients.resolve({ system: 'his', value: 'H1' }), { status: 'matched', masterId: 'P_001' }, '标识索引应被重建');
    }
  });

  await test('S2 **首次启动与数据损坏必须分开**：损坏时宁可停下，也不当空工作区继续', () => {
    const fresh = loadWorkspace(file('never-existed.json'));
    assertEqual(fresh.ok, true, '文件不存在 → 可以建空工作区');
    if (fresh.ok) assertEqual(fresh.firstRun, true, '应标记为首次启动');

    const broken = file('s2-broken.json');
    writeFileSync(broken, '{"format":"l0-workspace","version":1,"digest":"x","payload":', 'utf8');
    const result = loadWorkspace(broken);
    assertEqual(result.ok, false, '损坏的文件不得被当成空工作区');
    if (!result.ok) {
      assertEqual(result.firstRun, false, '必须与首次启动区分开');
      assertEqual(result.code, 'E_SNAPSHOT_CORRUPT', '应报损坏');
    }
  });

  await test('S3 **seq 不重置**：重启后新建议的 ID 继续递增，不复用历史 ID', () => {
    const target = file('s3.json');
    const before = emptyScope();
    const first = before.suggestions.add({ targetNodeId: 'n_1', text: 'a', confidence: 0.9, modelId: 'm1', at: AT }).suggestion;
    saveWorkspace(target, before, { at: AT });

    const loaded = loadWorkspace(target);
    assertEqual(loaded.ok, true, '应加载成功');
    if (!loaded.ok) return;
    const after = loaded.scope.suggestions.add({ targetNodeId: 'n_1', text: 'b', confidence: 0.9, modelId: 'm1', at: AT }).suggestion;
    assert(after.id !== first.id, `新建议 ID 不得与历史重复（${first.id} → ${after.id}）`);
    assertEqual(after.id, 'sg_0002', '应继续递增');
    assertEqual(loaded.scope.suggestions.size(), 2, '历史条目仍在');
  });

  await test('S4 注解处置史完整保留：它是质控可追溯的唯一载体', () => {
    const target = file('s4.json');
    const scope = emptyScope();
    const { annotation } = scope.annotations.add({
      kind: 'quality',
      severity: 'warn',
      anchor: { nodeId: 'n_1', nodeText: '原文' },
      title: '时限不一致',
      source: { kind: 'system', ruleId: 'R-9' },
      dedupeKey: 'R-9:n_1',
      at: AT,
    });
    scope.annotations.transition(annotation.id, 'acknowledged', 'DR_WANG', AT, '已知悉，本次不改');
    scope.annotations.transition(annotation.id, 'resolved', 'DR_WANG', AT, '已按提示修改');
    saveWorkspace(target, scope, { at: AT });

    const loaded = loadWorkspace(target);
    assertEqual(loaded.ok, true, '应加载成功');
    if (!loaded.ok) return;
    const restored = loaded.scope.annotations.get(annotation.id);
    assertEqual(restored?.status, 'resolved', '状态应保留');
    assertEqual(restored?.history.length, 3, '处置史应完整（open → acknowledged → resolved）');
    assertEqual(restored?.history[1]?.note, '已知悉，本次不改', '处置备注应保留');
    assertEqual(restored?.dedupeKey, 'R-9:n_1', '去重键应保留（否则重启后误报会复活）');
    assertEqual(loaded.scope.annotations.size(), 1, '只应有一条');
  });

  await test('S5 真实"重启"往返：进程重来后数据与上一次完全一致', () => {
    const target = file('s5.json');
    const scope = emptyScope();
    scope.suggestions.addBatch([{ targetNodeId: 'n_1', text: '段一', confidence: 0.85, modelId: 'm1' }], AT, 'trace-1');
    scope.patients.register('P_001', [{ system: 'id-card', value: '110101198103120011' }], AT, 'admin');
    saveWorkspace(target, scope, { at: AT });
    const fingerprintBefore = scope.suggestions.fingerprint();
    const patientsBefore = scope.patients.fingerprint();

    const reloaded = loadWorkspace(target);
    assertEqual(reloaded.ok, true, '应加载成功');
    if (!reloaded.ok) return;
    assertEqual(reloaded.scope.suggestions.fingerprint(), fingerprintBefore, '建议指纹应一致');
    assertEqual(reloaded.scope.patients.fingerprint(), patientsBefore, '主索引指纹应一致');
    /* 分组信息（groupId / traceId）也必须一起活下来：否则重启后"这批建议属于哪次录音"就断了 */
    const groups = reloaded.scope.suggestions.listGroups();
    assertEqual(groups.length, 1, '分组应恢复');
    assertEqual(groups[0]?.traceId, 'trace-1', 'traceId 应恢复（把"一次录音"与"一批建议"对应起来）');
  });

  await test('S6 快照自相矛盾（同一标识属两个主索引）→ 报错，不静默取舍', () => {
    const target = file('s6.json');
    const scope = emptyScope();
    scope.patients.register('P_001', [{ system: 'his', value: 'H1' }], AT, 'admin');
    scope.patients.register('P_002', [{ system: 'his', value: 'H2' }], AT, 'admin');
    saveWorkspace(target, scope, { at: AT });

    const text = readFileSync(target, 'utf8');
    const patched = text.replace('"value": "H2"', '"value": "H1"');
    writeFileSync(target, patched, 'utf8');
    const result = loadWorkspace(target);
    assertEqual(result.ok, false, '自相矛盾的快照必须被拒绝');
    if (!result.ok) {
      assert(
        result.code === 'E_SNAPSHOT_CORRUPT',
        `应报损坏或结构非法，实际：${result.code}`,
      );
    }
  });

  await test('S7 加密落盘：文件里搜不到明文；**没有口令就不写**、口令错必须报错', () => {
    const target = file('s7-sealed.json');
    const scope = emptyScope();
    scope.suggestions.add({ targetNodeId: 'n_secret', text: '患者主诉：胸痛3天', confidence: 0.9, modelId: 'm1', at: AT });
    const snapshot = scope.suggestions.snapshot();

    saveSidecarsSealed(target, { suggestions: snapshot, annotations: scope.annotations.snapshot() }, 'pass-1', { at: AT });
    const raw = readFileSync(target, 'utf8');
    assert(!raw.includes('n_secret'), '快照里不得出现明文节点 id');
    assert(!raw.includes('胸痛'), '快照里不得出现明文正文');
    assert(!raw.includes('suggestions'), '快照里连分区名都不该是明文');
    assert(raw.includes('l0-sidecars-sealed'), '应有格式标识（用于识别，不是内容）');

    const ok = loadSidecarsSealed(target, 'pass-1');
    assertEqual(ok.ok, true, '口令正确应能解密');
    if (ok.ok && !ok.firstRun) assertEqual(ok.data.suggestions.seq, 1, '内容应完整恢复');

    /* 口令错：必须报错，不能返回空数据（那会把"解不开"伪装成"本来就没有"）  */
    const wrong = loadSidecarsSealed(target, 'pass-2');
    assertEqual(wrong.ok, false, '口令错必须失败');
    if (!wrong.ok) assertEqual(wrong.firstRun, false, '不得被当成首次启动');

    assert(
      (() => {
        try {
          saveSidecarsSealed(file('s7-plain.json'), { suggestions: snapshot, annotations: scope.annotations.snapshot() }, '');
          return false;
        } catch {
          return true;
        }
      })(),
      '没有口令时必须拒绝写入（静默退回明文会让"已加密"这个判断悄悄变成假的）',
    );
    assertEqual(existsSync(file('s7-plain.json')), false, '拒绝之后不得留下任何文件');
  });

  const SALT_A = '00112233445566778899aabbccddeeff';
  const SALT_B = 'ffeeddccbbaa99887766554433221100';

  await test('S9 盐可注入（**显式参数**，来自服务端文件配置）；**注入非法必须拦下**', () => {
    const target = file('s9-salt.json');
    const scope = emptyScope();
    const data = { suggestions: scope.suggestions.snapshot(), annotations: scope.annotations.snapshot() };

    assertEqual(resolveStateSalt('pass-1', SALT_A).source, 'option', '显式给盐时来源应为 option');
    assertEqual(
      saltFingerprint(resolveStateSalt('pass-1', SALT_A).salt),
      saltFingerprint(fromHex(SALT_A)),
      '取到的应正是配置里的那个盐',
    );

    saveSidecarsSealed(target, data, 'pass-1', { at: AT, salt: SALT_A });
    const info = inspectSealedSidecars(target, fromHex(SALT_A));
    assertEqual(info.ok, true, '应能读出信封头部');
    if (info.ok) assertEqual(info.usesCurrentSalt, true, '写出的文件确实用了配置的盐');

    assertEqual(resolveStateSalt('pass-1').source, 'derived', '没给盐时应退回按口令派生');

    assert(
      (() => {
        try {
          resolveStateSalt('pass-1', 'not-a-salt');
          return false;
        } catch (err) {
          return (err as Error).message.includes('32 个十六进制');
        }
      })(),
      '非法盐必须抛错，且信息要点明正确格式（否则运维只能猜）',
    );
    let threw = false;
    try {
      saveSidecarsSealed(file('s9-bad.json'), data, 'pass-1', { salt: 'not-a-salt' });
    } catch {
      threw = true;
    }
    assertEqual(threw, true, '配置错时**写入也必须失败**，不能"照样用派生盐写出去"');
    assertEqual(existsSync(file('s9-bad.json')), false, '失败之后不得留下文件');

    assert(
      (() => {
        try {
          resolveStateSalt('pass-1', 'zz112233445566778899aabbccddeeff');
          return false;
        } catch {
          return true;
        }
      })(),
      '长度对但含非十六进制字符同样必须拦下（只查长度会放过它）',
    );
  });

  await test('S10 盐轮换：换盐后旧文件**仍可读**（盐写在信封里），新文件用新盐', () => {
    const target = file('s10-rotate.json');
    const scope = emptyScope();
    scope.suggestions.add({ targetNodeId: 'n_rotate', text: '患者主诉：胸痛3天', confidence: 0.9, modelId: 'm1', at: AT });
    const data = { suggestions: scope.suggestions.snapshot(), annotations: scope.annotations.snapshot() };

    saveSidecarsSealed(target, data, 'pass-1', { at: AT, salt: SALT_A });
    const before = inspectSealedSidecars(target, fromHex(SALT_A));
    if (before.ok) assertEqual(before.usesCurrentSalt, true, '前置：文件是盐 A 写的');
    const rawBefore = readFileSync(target, 'utf8');

    const loaded = loadSidecarsSealed(target, 'pass-1');
    assertEqual(loaded.ok, true, '换盐之后旧文件必须仍可读');
    if (loaded.ok && !loaded.firstRun) {
      assertEqual(loaded.data.suggestions.seq, 1, '内容应完整');
      assertEqual(loaded.saltFingerprint, saltFingerprint(fromHex(SALT_A)), '读出来的应是"写作时的盐"指纹');
    }

    const fresh = file('s10-fresh.json');
    saveSidecarsSealed(fresh, data, 'pass-1', { at: AT, salt: SALT_B });
    const info = inspectSealedSidecars(fresh, fromHex(SALT_B));
    if (info.ok) assertEqual(info.usesCurrentSalt, true, '新写入的文件应使用新盐');

    const stale = inspectSealedSidecars(target, fromHex(SALT_B));
    if (stale.ok) assertEqual(stale.usesCurrentSalt, false, '旧文件应被识别为"待迁移"');
    assertEqual(readFileSync(target, 'utf8'), rawBefore, '巡检与读取都不得改动文件');
  });

  await test('S11 reseal 迁移：盐指纹更新、内容一字不差；已是当前盐则跳过', () => {
    const target = file('s11-reseal.json');
    const scope = emptyScope();
    scope.suggestions.add({ targetNodeId: 'n_reseal', text: '既往史：高血压 5 年', confidence: 0.92, modelId: 'm1', at: AT });
    const data = { suggestions: scope.suggestions.snapshot(), annotations: scope.annotations.snapshot() };
    saveSidecarsSealed(target, data, 'pass-1', { at: AT, salt: SALT_A });
    const loadedBefore = loadSidecarsSealed(target, 'pass-1');

    const result = resealSidecars(target, 'pass-1', { salt: SALT_B, at: AT });
    assertEqual(result.ok, true, '迁移应成功');
    if (result.ok) {
      assertEqual(result.changed, true, '盐变了，应确实重写');
      assertEqual(result.before, saltFingerprint(fromHex(SALT_A)), '应记录重写前的盐指纹');
      assertEqual(result.after, saltFingerprint(fromHex(SALT_B)), '应记录重写后的盐指纹');
    }

    const after = loadSidecarsSealed(target, 'pass-1');
    assertEqual(after.ok, true, '迁移后应仍能读');
    if (after.ok && !after.firstRun && loadedBefore.ok && !loadedBefore.firstRun) {
      assertEqual(JSON.stringify(after.data), JSON.stringify(loadedBefore.data), '迁移前后数据必须完全一致');
      assertEqual(after.saltFingerprint, saltFingerprint(fromHex(SALT_B)), '文件应已是新盐');
    }

    const again = resealSidecars(target, 'pass-1', { salt: SALT_B });
    assertEqual(again.ok, true, '重复迁移应成功返回');
    if (again.ok) assertEqual(again.changed, false, '已是当前盐时应跳过 —— 重复迁移只该白白多付一次派生，不该重写');
  });

  await test('S12 迁移的安全底线：读不通时**绝不覆盖**（先读通再写）', () => {
    const target = file('s12-noclobber.json');
    const scope = emptyScope();
    scope.suggestions.add({ targetNodeId: 'n_keep', text: '不可丢失的内容', confidence: 0.9, modelId: 'm1', at: AT });
    const data = { suggestions: scope.suggestions.snapshot(), annotations: scope.annotations.snapshot() };
    saveSidecarsSealed(target, data, 'correct-pass', { at: AT, salt: SALT_A });
    const rawBefore = readFileSync(target, 'utf8');
    const loadedBefore = loadSidecarsSealed(target, 'correct-pass');

    const bad = resealSidecars(target, 'wrong-pass', { salt: SALT_B });
    assertEqual(bad.ok, false, '口令不对时迁移必须失败');
    assertEqual(
      readFileSync(target, 'utf8'),
      rawBefore,
      '失败时文件必须一字未动 —— 用空数据覆盖唯一一份快照，比"没迁移"严重得多',
    );

    const still = loadSidecarsSealed(target, 'correct-pass');
    assertEqual(still.ok, true, '原口令应仍能读回');
    if (still.ok && !still.firstRun && loadedBefore.ok && !loadedBefore.firstRun) {
      assertEqual(
        JSON.stringify(still.data),
        JSON.stringify(loadedBefore.data),
        '内容应完好 —— 字节相同还不够，要证明"还能解出来且一模一样"',
      );
    }

    const none = resealSidecars(target, '');
    assertEqual(none.ok, false, '缺口令应拒绝重写（没有口令就没有"读通"可言）');
    assertEqual(readFileSync(target, 'utf8'), rawBefore, '缺口令时文件同样不得变动');
  });

  await test('S8 清理测试目录（不留痕迹）', () => {
    cleanRoot();
    assertEqual(existsSync(ROOT), false, '温度目录应已清空');
  });

  process.exit(suite.report());
}

void main();
