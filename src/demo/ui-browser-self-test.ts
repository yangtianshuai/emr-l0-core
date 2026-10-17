/**
 * 医生端「能力开关」的运行时验收 —— 在**真实 Chromium** 里跑，读 DOM。
 *
 *   npm run test:ui-browser        （不进 npm test 全量，理由见下）
 *
 * 为什么必须单独有这么一条：
 *   ui-self-test 的 A 部分是静态扫源码、B 部分走真实 HTTP —— **两者都不执行浏览器里的 JS**。
 *   于是"能力缺席时把页签摘掉 / 活动页签回退 / 「⋯」菜单空了也一起摘"这三件事在那边
 *   永远不会失败，只会静默不工作：源码里字都在、接口也都对，唯独医生看到的界面没变。
 *   A32 只证明"清单与白名单对得上"，证不了"注入之后页面真的少了那一栏"。这条补的就是这段。
 *
 * 为什么不在 `npm test` 里：
 *   它要拉真实 Chromium（首次安装约 500MB），而全量自测的定位是"零依赖、随便跑"。
 *   同理，**没装就明确失败**并打印安装命令，而不是静默跳过 —— 静默跳过会让它退化成
 *   一个永远绿的装饰，这比没有这条用例更糟。
 *
 * 覆盖（B = Browser）：
 *   B0 整轮跑在自己的 agent-browser 会话里，且每次打开都确认**真的落在应用页**上
 *      （见 SESSION 与 openAppPage：共用默认会话 / 冷启动漂移都会让断言读到空白页）
 *   B1 起一个独立实例（独立库 + 独立运行目录）
 *   B2 **反证**：未注入时，7 个页签与 9 个能力入口都在（否则 B3 的"变少了"可能只是页面坏了）
 *   B3 启动路径注入：页签 7→4、9 个标记元素全摘、持久化的 activeTab 回退、「⋯」菜单清空
 *   B4 同一页面里状态投影与配置镜像也成立（`S.scope`、`S.capture` 的键集）
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TestSuite, assert, assertEqual } from '../testing/harness.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SERVER_TS = join(ROOT, 'src', 'demo', 'demo-server.ts');
const ARTIFACTS = join(ROOT, 'artifacts');
/** 独立端口：不复用自测的 8799 / demo 的 8787，免得三者在同一台机器上互相踩 */
const PORT = 8949;
const BASE = `http://127.0.0.1:${PORT}`;
/**
 * 每次运行用**独立的目录与文件名**，而不是"先删掉上一次的"。
 *
 * 为什么：这台机器上 IDE 给 `rmSync` 套了一层"移到回收站"的垫片，而它在删目录/删文件时
 * 会**抛错**（本用例第一次跑就死在这里：`runCli` 里一句删除把整个进程直接带走了，
 * 日志里连报告都没留下）。用独立名字之后就没有"必须先删干净"这个前提，
 * 删除失败也不再影响结论 —— 失败的是清理，不是断言。
 */
const RUN_STAMP = `${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffffff).toString(36)}`;
const stateDir = join(ARTIFACTS, `state-browser-selftest-${RUN_STAMP}`);
const runtimeDir = join(ARTIFACTS, `runtime-browser-selftest-${RUN_STAMP}`);
/** 页面脚本运行**之前**注入的宿主接入点（用 agent-browser 的 `--init-script`） */
const INIT_SCRIPT = join(ARTIFACTS, `browser-selftest-init-${RUN_STAMP}.js`);
/** CLI 调用的序号：给每次调用的输出文件起唯一名字（理由同 RUN_STAMP） */
let cliSeq = 0;

/**
 * 本用例自己的 agent-browser 会话名。
 *
 * 为什么必须自己命名一个：agent-browser 的**默认会话是全机器共享的一个浏览器**
 * （官方 skill 原话：shared with every other agent on the machine）。上一次跑剩下的、
 * 或者编辑器里另一个 agent 手动探测用的浏览器，都挂在同一个默认会话上 ——
 * 实测过：默认会话里敲 `open http://127.0.0.1:8787/`，紧接着 `tab` 列出来的是
 * 上一轮跑剩下的 `8949` 页签。页签被别的会话拿走之后，断言读到的就是 about:blank
 * 的空 DOM，而不是报错。名字里带 RUN_STAMP，跨次运行也不会互相踩。
 *
 * 代价：每次运行会在 `~/.agent-browser` 下留两个几十字节的会话记录（`.config` / `.target`），
 * `close` 不会删它们。相对于"和别的 agent 抢同一个浏览器"，这个代价是值当的。
 * 注意它只解决"会话被抢"，解决不了冷启动时**第一条命令的工具侧漂移** ——
 * 那一层由 `openAppPage` 的确认 + 重开兜住。
 */
const SESSION = `l0ui-${RUN_STAMP}`;

/** 能力缺席时应当被摘掉的东西（与 ui.html 上的 `data-capability` 一一对应） */
const DISABLED = { qc: false, finalize: false, log: false, metrics: false, import: false };
/** 注入之后还剩哪些页签：常驻四个高频入口 + 机读信息 */
const TABS_AFTER = ['ai', 'voice', 'qc', 'machine'];

const suite = new TestSuite('医生端能力开关 · 浏览器运行时验收', [
  '说明：这条用例读的是**真实浏览器里的 DOM**，不是源码。它守的是"医生看到的界面"，',
  '      而 ui-self-test 的 A（扫源码）/ B（走 HTTP）都看不见这一层。',
]);

const test = (name: string, fn: () => void | Promise<void>): Promise<void> => suite.test(name, fn);

/**
 * 阶段进度。
 *
 * 这条用例整体要几十秒（要拉真实 Chromium），而报告只在最后一次性打印 ——
 * 静默的长任务分不清"在跑"与"卡住了"，而这两者该做的处置完全不同
 * （前者等，后者要去看谁占着浏览器/端口）。所以每个阶段各打一行。
 */
function step(message: string): void {
  process.stdout.write(`  [浏览器验收] ${message}\n`);
}

/**
 * 跑一条 agent-browser 命令。
 *
 * 必须走 shell：Windows 上 npm 全局装出来的是 `.cmd` / `.ps1` 垫片，
 * 不经过 shell 起不来（Node 从 18.20 起也不再允许直接 exec `.cmd`）。
 */
/**
 * 走 shell 跑一条命令。
 *
 * 与 `ui-self-test.ts` 里 `rmRecursive` 同一处境：编辑器注入的 node 语言垫片把
 * `spawnSync` 的选项类型收成了 `{ encoding, cwd, windowsHide }`，**没有 `shell`**，
 * 而真实运行时是支持的。这里按真实语义转一次类型，而不是为了过检查去掉 `shell: true`
 * —— 去掉之后 `.cmd` 垫片在当前 Node 上根本起不来（表现是"命令找不到"，不是"参数不对"）。
 */
const runSync = spawnSync as unknown as (
  command: string,
  args: string[],
  options: { shell: boolean; encoding: 'utf8'; stdio: 'ignore'; timeout: number },
) => { status: number | null; signal: string | null };

/** 单条 CLI 的等待上限：浏览器冷启动慢，但超过两分钟就是卡住了，不该无限等 */
const CLI_TIMEOUT_MS = 120_000;

/**
 * 跑一条 agent-browser 命令并取回它的输出。
 *
 * Windows 上有两个坑都必须绕过，否则这条用例会**静默挂住**（第一次跑就挂在 `open` 上：
 * 既不报错也不结束，看起来像"还在跑"）：
 *   ① 必须经 shell —— npm 全局装出来的是 `.cmd` / `.ps1` 垫片，不经 shell 起不来；
 *   ② **输出必须重定向到文件，不能走管道**：agent-browser 会把一个常驻 daemon 留在后台，
 *      而它继承着父进程的 stdout/stderr 管道。`spawnSync` 等的是"管道关闭"，
 *      于是 CLI 早就退出了、它却永远等下去。改成重定向到文件，这个依赖就没了。
 */
function runCli(command: string): { ok: boolean; stdout: string; stderr: string } {
  mkdirSync(ARTIFACTS, { recursive: true });
  /* 每次调用换一对文件名，而不是覆盖同一对：覆盖需要先删，而删除在这台机器上会抛错 */
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

/** 本用例的所有 agent-browser 调用都收在自己的会话里（理由见 SESSION） */
function ab(args: string): string {
  return `agent-browser --session ${SESSION} ${args}`;
}

function agentBrowserAvailable(): boolean {
  return runCli('agent-browser --version').ok;
}

/**
 * 递归删目录。
 *
 * 与 `ui-self-test.ts` 里同一处写法一样要转一次类型：编辑器注入的 node 语言垫片
 * 把 `rmSync` 的选项类型收成了 `{force}`，而真实签名是支持 `recursive` 的。
 * 不转的话类型检查过不去，转了才是"按真实运行时的语义用"。
 */
const rmRecursive = rmSync as unknown as (path: string, options: { recursive: boolean; force: boolean }) => void;

/** 尽力删除：删不掉不算失败（见 RUN_STAMP 的说明），但也不假装删过 */
function tryRemove(path: string): void {
  try {
    rmRecursive(path, { recursive: true, force: true });
  } catch {
    /* 垫片把删除变成了"移到回收站"，它失败时不该拖垮用例 */
  }
}

/**
 * 把一段页面代码交给浏览器执行，取回它返回的 JSON。
 *
 * **页面代码里不得出现双引号**：命令要经 cmd.exe，参数里的双引号会被吃掉或截断，
 * 而那时的表现是 `SyntaxError` 或莫名其妙的 `xxx is not defined` —— 与真正的失败
 * 分不开。所以这里把它变成一条硬约束，而不是靠写的时候记得。
 */
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
  /* CLI 会把页面返回的字符串再 JSON 编码一次，所以这里可能要解两层 */
  let once: unknown;
  try {
    once = JSON.parse(last);
  } catch {
    throw new Error(`浏览器返回值不是 JSON：${last.slice(0, 200)}`);
  }
  return (typeof once === 'string' ? JSON.parse(once) : once) as Record<string, unknown>;
}

/** 页面侧通用探针：页签、能力入口、菜单、活动页签，以及状态投影的形状。 */
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
      /* 尚未就绪 */
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
  /* 无论成功失败都要关：留着就是常驻 daemon + 一个 Chromium 进程 */
  runCli(ab('close'));
}

/**
 * 打开应用页，并确认**真的落在它上面**。
 *
 * 只 `open` + `wait` 不够：实测这台机器上"冷启动后第一条命令 `open` 到的浏览器，
 * 会在该条命令退出时一起消失"，下一条命令于是起了个新的空白浏览器 ——
 * 而这一切都不报错，只是让后面每一条断言读到 about:blank 的空 DOM，
 * 把"浏览器没连上"错读成"页面少了几栏"（第一次跑就是这样：B2 取回 0 个页签）。
 * 所以这里显式验一次 `location.href`，不对就把会话关掉重开。
 *
 * 为什么按**时间**兜而不是按次数：这个漂移是随机的，实测同一轮里连着两次都可能命中
 * （B2 试到第 3 次才落上）。给死一个"三次"会把偶发的工具侧漂移读成"页面坏了"，
 * 所以只保证"45 秒内没落上就是真失败"，中途不等固定次数。
 */
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
      /* 不需要"先清空"：目录名带 RUN_STAMP，天然是从空库出发的 */
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
      /* 8 = 五个高频 + 三个低频（定稿 / 日志 / 指标）。低频那三项住在「⋯」菜单的标记里，
         但 `[data-tab]` 在 DOM 里一直都在（页签栏或菜单，两者都算"页面上的页签"）。 */
      assertEqual(tabs.length, 8, `未注入时应有 8 个页签（否则 B3 的"变少了"可能只是页面本身坏了）`);
      assertEqual(seen.markedCount, 9, '未注入时 9 个 data-capability 入口都应还在');
      assertEqual(seen.moreButton, true, '未注入时「⋯」按钮应在');
      assertEqual(seen.scope, 'doctor', '医生端（无会话）拿到的应是医生端投影');
    });

    await test('B3 启动路径注入：页签只剩 4 个、9 个入口全摘、活动页签回退、「⋯」菜单清空', () => {
      step('注入：--init-script 在首次导航之前注册，并把活动页签预置成即将被摘掉的 log…');
      closeBrowser();
      /* 关键：`--init-script` 注册在**首次导航之前**，且活动页签预置成将被摘掉的 `log` */
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

  /* 设 exitCode 而不调 `process.exit()`：stdout 重定向到文件时写入是异步的，直接退会把
     还没落盘的报告整段丢掉 —— 这条用例第一次跑就是"无声结束"的（日志里只有进度、没有报告）。
     让事件循环自己走完即可：本进程除了 spawnSync 没有别的常驻句柄，浏览器与实例都已在
     finally 里收掉。这里转一次类型同样是因为编辑器注入的 node 垫片把 `process` 收窄了。 */
  const proc = process as unknown as { exitCode: number };
  proc.exitCode = suite.report();
}

await main();
