import { TestSuite, assert, assertEqual } from '../testing/harness.ts';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SNAPSHOT_CONFLICT_CODE } from './persistence.ts';
import { loadSidecarsSealed, saveSidecarsSealed } from './store.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DIR = join(ROOT, 'artifacts', 'state-selftest', 'concurrency');
const FILE = join(DIR, 'doc_concurrency.json');
const PASS = 'selftest-concurrency-passphrase';
const ITER = 1000;

const fsRemove = (await import('node:fs')) as unknown as { rmSync: (path: string, options: { recursive: boolean; force: boolean }) => void };

interface SpawnSyncWithEnv {
  spawnSync: (
    command: string,
    args: string[],
    options: { cwd: string; encoding: 'utf8'; env: Record<string, string | undefined> },
  ) => { stdout?: string; stderr?: string; status?: number | null };
}
const childProcess = (await import('node:child_process')) as unknown as SpawnSyncWithEnv;
const parentPid = (process as unknown as { pid?: number }).pid ?? 0;

const suite = new TestSuite('并发写自测', [
  '说明：真跨进程（每次 spawn 一个 node 进程）写同一个快照文件，验证"落盘前置条件"这一层。',
  'C1 是对照实验：把"裸写会静默丢更新"复现出来并留档 —— 它证明这层保护是必要的。',
]);

const test = (name: string, fn: () => void | Promise<void>): Promise<void> => suite.test(name, fn);

const CHILD_SOURCE = `
const store = await import(process.env.L0C_STORE_URL);
const payload = {
  suggestions: { writer: process.env.L0C_TAG, items: [] },
  annotations: { writer: process.env.L0C_TAG, items: [] },
};
const options = { iterations: Number(process.env.L0C_ITERATIONS) };
const expect = process.env.L0C_EXPECT;
if (expect === 'missing') options.expect = { missing: true };
else if (expect) options.expect = { digest: expect };
let out;
try {
  const meta = store.saveSidecarsSealed(process.env.L0C_FILE, payload, process.env.L0C_PASS, options);
  out = { pid: process.pid, ok: true, digest: meta.digest };
} catch (err) {
  out = { pid: process.pid, ok: false, code: err && err.code, message: err && err.message };
}
console.log(JSON.stringify(out));
`;

interface WriterResult {
  pid: number;
  ok: boolean;
  digest?: string;
  code?: string;
  message?: string;
}

function writeFromAnotherProcess(tag: string, expect?: string): WriterResult {
  const result = childProcess.spawnSync(process.execPath, ['--input-type=module', '-e', CHILD_SOURCE], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      L0C_STORE_URL: pathToFileURL(join(ROOT, 'src', 'core', 'store.ts')).href,
      L0C_FILE: FILE,
      L0C_PASS: PASS,
      L0C_ITERATIONS: String(ITER),
      L0C_TAG: tag,
      ...(expect === undefined ? {} : { L0C_EXPECT: expect }),
    },
  });
  const line = String(result.stdout ?? '').trim().split('\n').pop() ?? '';
  assert(line !== '', `子进程（${tag}）没有输出；stderr=${String(result.stderr ?? '').slice(0, 400)}`);
  return JSON.parse(line) as WriterResult;
}

function writeHere(tag: string, expect?: { digest: string } | { missing: true }): string {
  const payload = { suggestions: { writer: tag, items: [] }, annotations: { writer: tag, items: [] } };
  const meta = saveSidecarsSealed(FILE, payload as never, PASS, { iterations: ITER, ...(expect ? { expect } : {}) });
  return meta.digest;
}

function writerOnDisk(): { writer: string | null; digest?: string } {
  const loaded = loadSidecarsSealed(FILE, PASS);
  /* `firstRun`（文件不存在）与"读写失败"都必须给 null，而不是"看起来有一版" */
  if (!loaded.ok || loaded.firstRun || !loaded.data) return { writer: null };
  const suggestions = loaded.data.suggestions as unknown as { writer?: string };
  return { writer: suggestions.writer ?? null, ...(loaded.digest ? { digest: loaded.digest } : {}) };
}

async function main(): Promise<void> {
  fsRemove.rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });

  await test('C1 对照实验（存在的缺口）：**裸写会静默丢更新** —— 两次写入都没报错，内容只剩后一个', () => {
    rmSync(FILE, { force: true });
    const base = writeHere('base');
    assert(base.length === 64, '前置：拿到基线摘要');

    const a = writeFromAnotherProcess('A');
    const b = writeFromAnotherProcess('B');
    assert(a.ok && b.ok, `裸写两次都该"成功"（这正是问题所在）：${JSON.stringify({ a, b })}`);
    assert(a.pid !== parentPid && b.pid !== parentPid, '必须是**独立进程**在写（同一个进程里模拟不算跨进程）');
    assert(a.pid !== b.pid, '两次写入来自两个不同进程');

    const onDisk = writerOnDisk();
    assertEqual(onDisk.writer, 'B', 'A 的内容已经没了');
    assertEqual(a.ok, true, 'A 的那次写入当时是"成功"的 —— 丢失发生时没有任何信号');
  });

  await test('C2 真跨进程 + 基线：陈旧写入被**拒绝**，且一个字节都没写进去', () => {
    rmSync(FILE, { force: true });
    const d0 = writeHere('base');

    const a = writeFromAnotherProcess('A', d0);
    assertEqual(a.ok, true, `基于当前基线写入应成功：${a.code ?? ''} ${a.message ?? ''}`);
    assert(typeof a.digest === 'string' && a.digest !== d0, '写入后基线必然换新（否则"陈旧"永远检测不出来）');

    const b = writeFromAnotherProcess('B', d0);
    assertEqual(b.ok, false, '陈旧基线的写入必须被拒绝');
    assertEqual(b.code, SNAPSHOT_CONFLICT_CODE, '应给出可定位的错误码');
    assert(String(b.message ?? '').includes('未写入'), `错误信息要说清"本次未写入"，实际：${b.message ?? ''}`);
    assert(!String(b.message ?? '').includes('**'), `错误信息不得夹带 markdown 标记，实际：${b.message ?? ''}`);

    const onDisk = writerOnDisk();
    assertEqual(onDisk.writer, 'A', '被拒的那次**一个字节都不许写**（盘上仍是 A 的内容）');
    assertEqual(onDisk.digest, a.digest, '盘上摘要仍是 A 写完后的那一版');
  });

  await test('C3 首次落盘只允许一个赢家（`expect: missing`）', () => {
    rmSync(FILE, { force: true });
    const first = writeFromAnotherProcess('A', 'missing');
    assertEqual(first.ok, true, `首个写入应成功：${first.code ?? ''} ${first.message ?? ''}`);
    const second = writeFromAnotherProcess('B', 'missing');
    assertEqual(second.ok, false, '第二个"首次落盘"必须被拒 —— 否则会把先建的那份盖掉');
    assertEqual(second.code, SNAPSHOT_CONFLICT_CODE, '同一种冲突同一错误码');
    assertEqual(writerOnDisk().writer, 'A', '盘上仍是先到者的内容');
  });

  await test('C4 基线对应的文件被删除（重置/误删）→ 拒绝并说明"已不存在"', () => {
    rmSync(FILE, { force: true });
    const d0 = writeHere('base');
    rmSync(FILE, { force: true });
    let code = '';
    let message = '';
    try {
      writeHere('late', { digest: d0 });
    } catch (err) {
      code = String((err as { code?: string }).code ?? '');
      message = (err as Error).message;
    }
    assertEqual(code, SNAPSHOT_CONFLICT_CODE, '基线所指的文件没了，也不能凭空重建');
    assert(message.includes('已不存在'), `错误信息要说清原因，实际：${message}`);
    assertEqual(existsSync(FILE), false, '被拒时不得顺手把文件创建出来');
  });

  await test('C5 摘要即基线：写入返回的摘要与读回的摘要一致（前置条件成立的前提）', () => {
    rmSync(FILE, { force: true });
    const written = writeHere('base');
    assertEqual(writerOnDisk().digest, written, '写入返回的 digest 必须等于随后读到的 digest，否则基线永远对不上');

    const again = writeHere('base');
    assert(again !== written, '内容相同也应得到不同摘要（否则两次写入之间的"陈旧"检测不出来）');
  });

  await test('C6 崩溃残留：截断的 .tmp 不影响读取，也不影响带基线的写入', () => {
    rmSync(FILE, { force: true });
    const d0 = writeHere('base');
    writeFileSync(`${FILE}.tmp`, '{"format":"l0-sidecars","version":1,"savedAt":"2026-10-12T00:00:00.000Z","digest":"dead', 'utf8');
    assert(existsSync(`${FILE}.tmp`), '前置：临时文件在');

    assertEqual(writerOnDisk().writer, 'base', '正式文件不受残留临时文件影响');
    const next = writeHere('next', { digest: d0 });
    assert(next !== d0, '带基线的写入照常成功（基线只看正式文件）');
    assertEqual(writerOnDisk().writer, 'next', '写入生效');
  });

  fsRemove.rmSync(DIR, { recursive: true, force: true });

  process.exit(suite.report());
}

void main();
