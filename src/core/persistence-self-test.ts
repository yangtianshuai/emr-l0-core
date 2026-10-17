/**
 * 持久化自测。
 *
 *   node src/core/persistence-self-test.ts
 *
 * 本套验证的不是"能存能读"，而是**失败时的行为**：
 *   P1 写后读回一致；P2 原子写不留临时文件；
 *   P3~P7 四类异常必须**显式报错** —— 文件不存在、JSON 截断、格式不符、版本不符、内容被改。
 *
 * 为什么重点在失败路径：这类系统里最危险的不是"读不到"，而是**把读不到伪装成读到了**——
 * 空启动会让质控痕迹消失而无人知晓（见 persistence.ts 文件头）。
 */

import { mkdirSync, readdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { TestSuite, assert, assertEqual } from '../testing/harness.ts';
import { cleanupTemp, readSnapshot, snapshotExists, writeSnapshot } from './persistence.ts';

/* 与 persistence.ts 同因：本环境的 node:fs 类型声明不完整，局部断言 */
const fsx = (await import('node:fs')) as unknown as {
  rmSync: (path: string, options: { recursive: boolean; force: boolean }) => void;
};

/* 用环境变量取临时目录，避免依赖 node:os 的默认导出形态（同样受类型声明影响） */
const TEMP = process.env.TEMP ?? process.env.TMP ?? '.';

const suite = new TestSuite('持久化自测', [
  '说明：重点在失败路径 —— 危险的不是"读不到"，而是把读不到伪装成读到了。',
  'P3/P4/P6 是防回退关键：不存在、截断、版本不符都必须显式报错。',
]);

const test = (name: string, fn: () => void | Promise<void>): Promise<void> => suite.test(name, fn);

const ROOT = join(TEMP, 'l0-persistence-self-test');
const file = (name: string): string => join(ROOT, name);
const cleanRoot = (): void => {
  if (existsSync(ROOT)) fsx.rmSync(ROOT, { recursive: true, force: true });
};

interface Sample {
  suggestions: Array<{ id: string; text: string }>;
}

const SAMPLE: Sample = { suggestions: [{ id: 'sg_0001', text: '草稿一' }, { id: 'sg_0002', text: '草稿二' }] };

async function main(): Promise<void> {
  cleanRoot();
  mkdirSync(ROOT, { recursive: true });

  await test('P1 写后读回一致：内容逐字节等价，元信息可用于审计', () => {
    const target = file('p1.json');
    const written = writeSnapshot(target, SAMPLE, { at: '2026-10-09T08:00:00Z' });
    assert(written.bytes > 0, '应报告写入字节数');
    assert(/^[0-9a-f]{64}$/.test(written.digest), '摘要应是 SHA-256 十六进制');

    const read = readSnapshot<Sample>(target);
    assertEqual(read.ok, true, '应读取成功');
    if (read.ok) {
      assertEqual(read.payload, SAMPLE, '内容应完全一致');
      assertEqual(read.meta.savedAt, '2026-10-09T08:00:00Z', '应保留保存时刻');
      assertEqual(read.meta.digest, written.digest, '摘要应与写入时一致');
    }
  });

  await test('P2 原子写：不残留临时文件；崩溃残留可被显式清理', () => {
    const target = file('p2.json');
    writeSnapshot(target, SAMPLE);
    assertEqual(
      readdirSync(ROOT).filter((name) => name.endsWith('.tmp')),
      [],
      '正常写完后不应有 .tmp 残留（否则每次崩溃都会攒一个）',
    );
    /* 模拟"崩在写一半"：留下一个临时文件 */
    const leftover = `${target}.tmp`;
    writeFileSync(leftover, '{"format":"l0-snapshot"', 'utf8');
    assertEqual(cleanupTemp(target), true, '应能清理残留');
    assertEqual(cleanupTemp(target), false, '没有残留时应返回 false（避免误报"清理过了"）');
    assertEqual(snapshotExists(target), true, '正式文件不受影响');
  });

  await test('P3 文件不存在 → E_SNAPSHOT_MISSING：调用方必须自己区分"首次启动"与"数据丢失"', () => {
    const result = readSnapshot(file('not-exist.json'));
    assertEqual(result.ok, false, '不得返回空数据');
    if (!result.ok) {
      assertEqual(result.code, 'E_SNAPSHOT_MISSING', '应给出可判定的错误码');
      assert(!/^undefined/.test(result.message), '应有人话说明');
    }
  });

  await test('P4 文件被截断 → E_SNAPSHOT_CORRUPT（不能当成空快照）', () => {
    const target = file('p4.json');
    writeSnapshot(target, SAMPLE);
    const text = readFileSync(target, 'utf8');
    writeFileSync(target, text.slice(0, Math.floor(text.length / 2)), 'utf8');
    const result = readSnapshot<Sample>(target);
    assertEqual(result.ok, false, '截断的文件不得被读出');
    if (!result.ok) assertEqual(result.code, 'E_SNAPSHOT_CORRUPT', '应报损坏');
  });

  await test('P5 格式不符 → E_SNAPSHOT_FORMAT（防止把别的 JSON 误当快照）', () => {
    const target = file('p5.json');
    writeSnapshot(target, SAMPLE, { format: 'l0-other' });
    const result = readSnapshot<Sample>(target, { format: 'l0-snapshot' });
    assertEqual(result.ok, false, '格式不符必须拒绝');
    if (!result.ok) assertEqual(result.code, 'E_SNAPSHOT_FORMAT', '应报格式问题');
  });

  await test('P6 版本不符 → E_SNAPSHOT_VERSION：**不猜**，迁移必须显式做', () => {
    const target = file('p6.json');
    writeSnapshot(target, { legacyField: 'v1 的布局' }, { version: 1 });
    const result = readSnapshot<Sample>(target, { version: 2 });
    assertEqual(result.ok, false, '版本不符必须拒绝');
    if (!result.ok) {
      assertEqual(result.code, 'E_SNAPSHOT_VERSION', '应报版本问题');
      assert(result.message.includes('迁移'), '错误信息应指出需要显式迁移');
    }
    /* 反过来：用正确版本读，仍然能读出来（说明拒绝的是"猜"而不是"旧数据"） */
    assertEqual(readSnapshot<{ legacyField: string }>(target, { version: 1 }).ok, true, '版本匹配时应可读');
  });

  await test('P7 内容被改动 → E_SNAPSHOT_CORRUPT（摘要能发现改动）', () => {
    const target = file('p7.json');
    writeSnapshot(target, SAMPLE);
    const envelope = JSON.parse(readFileSync(target, 'utf8')) as { payload: Sample };
    envelope.payload.suggestions[0] = { id: 'sg_0001', text: '被改过的内容' };
    writeFileSync(target, JSON.stringify(envelope, null, 2), 'utf8');
    const result = readSnapshot<Sample>(target);
    assertEqual(result.ok, false, '改动内容后摘要必然不符');
    if (!result.ok) assertEqual(result.code, 'E_SNAPSHOT_CORRUPT', '应报损坏');
  });

  await test('P8 清理测试目录（不留痕迹）', () => {
    cleanRoot();
    assertEqual(snapshotExists(join(ROOT, 'p1.json')), false, '温度目录应已清空');
  });

  process.exit(suite.report());
}

void main();
