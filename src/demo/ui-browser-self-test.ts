import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TestSuite, assert, assertEqual } from '../testing/harness.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SERVER_TS = join(ROOT, 'src', 'demo', 'demo-server.ts');
const ARTIFACTS = join(ROOT, 'artifacts');
const PORT = 8949;
const BASE = `http://127.0.0.1:${PORT}`;
const RUN_STAMP = `${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffffff).toString(36)}`;
const stateDir = join(ARTIFACTS, `state-browser-selftest-${RUN_STAMP}`);
const runtimeDir = join(ARTIFACTS, `runtime-browser-selftest-${RUN_STAMP}`);
const INIT_SCRIPT = join(ARTIFACTS, `browser-selftest-init-${RUN_STAMP}.js`);
let cliSeq = 0;

const SESSION = `l0ui-${RUN_STAMP}`;

const DISABLED = { qc: false, finalize: false, log: false, metrics: false, import: false };
const TABS_AFTER = ['ai', 'voice', 'qc', 'machine'];

const suite = new TestSuite('医生端能力开关 · 浏览器运行时验收', [
  '说明：这条用例读的是**真实浏览器里的 DOM**，不是源码。它守的是"医生看到的界面"，',
  '      而 ui-self-test 的 A（扫源码）/ B（走 HTTP）都看不见这一层。',
]);

const test = (name: string, fn: () => void | Promise<void>): Promise<void> => suite.test(name, fn);

function step(message: string): void {
  process.stdout.write(`  [浏览器验收] ${message}\n`);
}

const runSync = spawnSync as unknown as (
  command: string,
  args: string[],
  options: { shell: boolean; encoding: 'utf8'; stdio: 'ignore'; timeout: number },
) => { status: number | null; signal: string | null };

/** 单条 CLI 的等待上限：浏览器冷启动慢，但超过两分钟就是卡住了，不该无限等 */
const CLI_TIMEOUT_MS = 120_000;

function runCli(command: string): { ok: boolean; stdout: string; stderr: string } {
  mkdirSync(ARTIFACTS, { recursive: true });
  cliSeq += 1;
  const outFile = join(ARTIFACTS, `browser-selftest-cli-${RUN_STAMP}-${cliSeq}.out`);
  const errFile = join(ARTIFACTS, `browser-selftest-cli-${RUN_STAMP}-${cliSeq}.err`);
  const result = runSync(`${command} 1> "${outFile}" 2> "${errFile}"`, [], {
    shell: true,
    encoding: 'utf8',
    stdio: 'ignore',
    timeout: CLI_TIMEOUT_MS,
  });
  assert(
    result.signal === null,
    `agent-browser 超过 ${CLI_TIMEOUT_MS / 1000}s 没返回（信号 ${result.signal}）：${command.slice(0, 90)}`,
  );
  return {
    ok: result.status === 0,
    stdout: existsSync(outFile) ? readFileSync(outFile, 'utf8') : '',
    stderr: existsSync(errFile) ? readFileSync(errFile, 'utf8') : '',
  };
}

function ab(args: string): string {
  return `agent-browser --session ${SESSION} ${args}`;
}

function agentBrowserAvailable(): boolean {
  return runCli('agent-browser --version').ok;
}

const rmRecursive = rmSync as unknown as (path: string, options: { recursive: boolean; force: boolean }) => void;

function tryRemove(path: string): void {
  try {
    rmRecursive(path, { recursive: true, force: true });
  } catch {
  }
}

function evalInPage(js: string): Record<string, unknown> {
  assert(!js.includes('"'), '页面代码里不得出现双引号（Windows 下要经 cmd.exe，参数里的双引号会被吃掉）');
  const run = runCli(ab(`eval "${js}"`));
  assert(
    !/Evaluation error/i.test(run.stderr),
    `浏览器执行页面代码失败：${run.stderr.split('\n')[0]?.trim() ?? '(无 stderr)'}`,
  );
  const lines = run.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const last = lines.at(-1);
  assert(last !== undefined, '浏览器没有返回任何内容（stdout 为空）');
  let once: unknown;
  try {
    once = JSON.parse(last);
  } catch {
    throw new Error(`浏览器返回值不是 JSON：${last.slice(0, 200)}`);
  }
  return (typeof once === 'string' ? JSON.parse(once) : once) as Record<string, unknown>;
}

function probeJs(): string {
  return [
    '(function(){',
    'var q=function(s){return [].slice.call(document.querySelectorAll(s))};',
    'var tabs=q(\'[data-tab]\').map(function(e){return e.dataset.tab});',
    'var marked=q(\'[data-capability]\').map(function(e){return e.id});',
    'var act=document.querySelector(\'[data-tab].active\');',
    'var panels=q(\'.panel\');',
    'var s=(typeof S!==\'undefined\'&&S)?S:null;',
    'return JSON.stringify({',
    'tabs:tabs,',
    'markedCount:marked.length,',
    'markedIds:marked,',
    'moreButton:!!document.querySelector(\'#btnMoreTabs\'),',
    'menuItems:document.querySelectorAll(\'#moreMenu > *\').length,',
    'activeTab:(typeof activeTab!==\'undefined\'?activeTab:null),',
    'highlighted:(act?act.dataset.tab:null),',
    'panelCount:panels.length,',
    'visiblePanels:panels.filter(function(p){return p.classList.contains(\'active\')}).map(function(p){return p.dataset.panel}),',
    'scope:(s?s.scope:null),',
    'captureKeys:(s&&s.capture?Object.keys(s.capture):null),',
    'itemCount:(s&&s.items?s.items.length:null)',
    '})})()',
  ].join('');
}

async function waitReady(): Promise<boolean> {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/state`);
      if (res.ok) return true;
    } catch {
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

function writeInitScript(): void {
  mkdirSync(ARTIFACTS, { recursive: true });
  writeFileSync(
    INIT_SCRIPT,
    [
      '/* 本文件由 src/demo/ui-browser-self-test.ts 生成，用完即删。',
      '   模拟"宿主在页面脚本之前注入接入层"：用 agent-browser 的 --init-script，',
      '   所以它跑在 ui.js 之前 —— 这样验的才是**启动路径**，而不是事后手工调一次函数。 */',
      `window.__L0_HOST__ = ${JSON.stringify({ capabilities: DISABLED })};`,
      '',
      '/* 顺带把持久化的活动页签设成 `log`（它即将被摘掉），用来验启动时的回退。',
      '   不回退的表现是"打开页面停在空气上"：页签栏一项都不高亮、面板也不显示。 */',
      "try { localStorage.setItem('l0demo.activeTab', 'log'); } catch (error) { /* 隐私模式忽略 */ }",
      '',
    ].join('\n'),
    'utf8',
  );
}

function closeBrowser(): void {
  runCli(ab('close'));
}

const OPEN_DEADLINE_MS = 45_000;

function openAppPage(prefix = ''): void {
  const deadline = Date.now() + OPEN_DEADLINE_MS;
  let attempt = 0;
  let lastHref = '';
  while (Date.now() < deadline) {
    attempt += 1;
    runCli(ab(`${prefix}open ${BASE}`));
    runCli(ab('wait --load load'));
    lastHref = String(evalInPage('JSON.stringify({href:location.href})').href ?? '');
    if (lastHref.startsWith(BASE)) {
      if (attempt > 1) step(`重开 ${attempt - 1} 次后落上应用页（前几次是工具侧冷启动漂移，不是页面问题）`);
      return;
    }
    step(`第 ${attempt} 次打开落在 ${lastHref || '(空)'}，不是应用页，重开…`);
    closeBrowser();
  }
  assert(false,
    `打开 ${BASE} 后 ${OPEN_DEADLINE_MS / 1000}s 内浏览器始终没落在应用页上（试了 ${attempt} 次，最后一次落在 ${lastHref || '(空)'}）`);
}

async function main(): Promise<void> {
  if (!agentBrowserAvailable()) {
    process.stdout.write(
      [
        '',
        '未找到 agent-browser —— 这条用例要真实浏览器，不能降级成静态检查（那等于没跑）。',
        '安装：',
        '  npm install -g agent-browser',
        '  agent-browser install',
        '',
      ].join('\n'),
    );
    process.exit(1);
  }

  let instance: ChildProcess | null = null;
  try {
    writeInitScript();

    await test('B1 起一个独立实例（独立库 + 独立运行目录）', async () => {
      step(`启动独立实例（端口 ${PORT}，独立库与运行目录）…`);
      instance = spawn(process.execPath, ['src/demo/demo-server.ts', '--port', String(PORT)], {
        cwd: ROOT,
        stdio: 'pipe',
        env: {
          ...process.env,
          L0_RUNTIME_DIR: runtimeDir,
          L0_STATE_DIR: stateDir,
          L0_ADMIN_AUDIT_FILE: join(stateDir, 'admin-audit.log'),
          L0_READING_GRANTS_FILE: join(stateDir, 'reading-grants.json'),
          L0_PACK_DIR: join(stateDir, 'knowledge'),
        },
      });
      instance.stdout?.on('data', () => {});
      instance.stderr?.on('data', () => {});
      assert(await waitReady(), `Demo 服务启动超时（30s）：${BASE}/api/state 一直没有响应`);
      step('实例就绪');
    });

    await test('B2 反证：未注入时页签与能力入口都在（8 个页签 / 9 个入口）', () => {
      step('基线：不带注入打开页面（Chromium 冷启动可能要十几秒）…');
      closeBrowser();
      openAppPage();
      const seen = evalInPage(probeJs());
      step(`基线取回：${(seen.tabs as string[]).length} 个页签 / ${seen.markedCount} 个能力入口`);
      const tabs = seen.tabs as string[];
      assertEqual(tabs.length, 8, `未注入时应有 8 个页签（否则 B3 的"变少了"可能只是页面本身坏了）`);
      assertEqual(seen.markedCount, 9, '未注入时 9 个 data-capability 入口都应还在');
      assertEqual(seen.moreButton, true, '未注入时「⋯」按钮应在');
      assertEqual(seen.scope, 'doctor', '医生端（无会话）拿到的应是医生端投影');
    });

    await test('B3 启动路径注入：页签只剩 4 个、9 个入口全摘、活动页签回退、「⋯」菜单清空', () => {
      step('注入：--init-script 在首次导航之前注册，并把活动页签预置成即将被摘掉的 log…');
      closeBrowser();
      openAppPage(`--init-script "${INIT_SCRIPT}" `);
      const seen = evalInPage(probeJs());
      step(`注入后取回：${(seen.tabs as string[]).length} 个页签 / ${seen.markedCount} 个能力入口 / 活动页签 ${seen.activeTab}`);
      assertEqual(seen.tabs, TABS_AFTER, '能力缺席的三个页签（定稿/日志/指标）应当被摘掉');
      assertEqual(seen.markedCount, 0, '所有 data-capability 入口都应当被摘掉');
      assertEqual(seen.activeTab, 'ai', '持久化的活动页签是被摘掉的那一个时应回退（否则停在空气上）');
      assertEqual(seen.highlighted, 'ai', '页签栏必须有一项是高亮的');
      assertEqual(seen.visiblePanels, ['ai'], '被摘掉的面板不该再是可见面板');
      assertEqual(seen.panelCount, 4, '面板应随页签一起被摘（只摘页签会留下切不回去的面板）');
      assertEqual(seen.moreButton, false, '「⋯」菜单被摘空后按钮自己也该走');
      assertEqual(seen.menuItems, 0, '菜单里不该还有内容');
    });

    await test('B4 同一页面里：状态投影与配置镜像的切分也成立', () => {
      const seen = evalInPage(probeJs());
      assertEqual(seen.scope, 'doctor', '无会话拿到的应是医生端投影（`scope` 随响应自我声明）');
      assertEqual(seen.captureKeys, ['configured', 'missing', 'retainAudio', 'segment'],
        '医生端的采集配置只剩可用性与告知义务：地址 / 厂商协议 / 凭据状态都不该下发');
      assert(typeof seen.itemCount === 'number' && (seen.itemCount as number) >= 12,
        `医生端投影必须仍带正文节点，实际 ${seen.itemCount}`);
    });
  } finally {
    closeBrowser();
    if (instance !== null) (instance as ChildProcess).kill();
    await new Promise((resolve) => setTimeout(resolve, 300));
    for (const dir of [stateDir, runtimeDir, INIT_SCRIPT]) tryRemove(dir);
  }

  const proc = process as unknown as { exitCode: number };
  proc.exitCode = suite.report();
}

await main();
