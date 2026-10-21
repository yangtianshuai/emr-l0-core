import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TestSuite, assert, assertEqual } from '../testing/harness.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const ARTIFACTS = join(ROOT, 'artifacts');
const PORT = 8969;
const BASE = `http://127.0.0.1:${PORT}`;
const RUN_STAMP = `${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffffff).toString(36)}`;
const stateDir = join(ARTIFACTS, `state-dom-patch-${RUN_STAMP}`);
const runtimeDir = join(ARTIFACTS, `runtime-dom-patch-${RUN_STAMP}`);
const SESSION = `l0patch-${RUN_STAMP}`;
const CLI_TIMEOUT_MS = 120_000;

const suite = new TestSuite('正文局部重画 · 浏览器运行时验收', [
  '说明：本文件读的是**真实浏览器里的 DOM**，不是源码。',
  '     判定层本身由 `patch-plan-self-test.ts`（U1–U26）覆盖；这里只守"动 DOM 的那一步"。',
]);
const test = (name: string, fn: () => void | Promise<void>): Promise<void> => suite.test(name, fn);

const runSync = spawnSync as unknown as (
  command: string,
  args: string[],
  options: Record<string, unknown>,
) => { status: number | null; signal: string | null; stdout: string | null; stderr: string | null };

function step(message: string): void {
  process.stdout.write(`  [局部重画验收] ${message}\n`);
}

function runCli(command: string): { ok: boolean; stdout: string; stderr: string } {
  mkdirSync(ARTIFACTS, { recursive: true });
  const result = runSync(command, [], {
    shell: true,
    encoding: 'utf8',
    stdio: 'ignore',
    timeout: CLI_TIMEOUT_MS,
  });
  /* 这些调用只关心成败与"有没有超时"，正文一律走 evalInPage */
  assert(result.signal === null, `agent-browser 超过 ${CLI_TIMEOUT_MS / 1000}s 没返回：${command.slice(0, 90)}`);
  return { ok: result.status === 0, stdout: '', stderr: '' };
}

const ab = (args: string): string => `agent-browser --session ${SESSION} ${args}`;

function agentBrowserAvailable(): boolean {
  return runCli('agent-browser --version').ok;
}

function evalInPage(js: string): Record<string, unknown> {
  assert(!js.includes('"'), '页面代码里不得出现双引号（Windows 下要经 cmd.exe）');
  const run = runSync(`agent-browser --session ${SESSION} eval "${js}"`, [], {
    shell: true,
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: CLI_TIMEOUT_MS,
  });
  const lines = `${run.stdout || ''}`.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  const last = lines.at(-1);
  assert(last !== undefined, `浏览器没有返回任何内容：${`${run.stderr || ''}`.slice(0, 200)}`);
  let once: unknown;
  try {
    once = JSON.parse(last);
  } catch {
    throw new Error(`浏览器返回值不是 JSON：${last.slice(0, 200)}`);
  }
  return (typeof once === 'string' ? JSON.parse(once) : once) as Record<string, unknown>;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

async function waitServerReady(): Promise<boolean> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/state`);
      if (res.ok) return true;
    } catch {
    }
    await sleep(250);
  }
  return false;
}

function openAppPage(): void {
  const deadline = Date.now() + 45_000;
  let lastHref = '';
  while (Date.now() < deadline) {
    runCli(ab(`open ${BASE}`));
    runCli(ab('wait --load load'));
    lastHref = String(evalInPage('JSON.stringify({href:location.href})').href ?? '');
    if (lastHref.startsWith(BASE)) return;
    runCli(ab('close'));
  }
  assert(false, `45s 内浏览器始终没落在应用页上（最后一次落在 ${lastHref || '(空)'}）`);
}

async function waitDocBody(): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const probe = evalInPage("(function(){var b=document.getElementById('docBody');"
      + 'return JSON.stringify({n:(b?b.children.length:0),planner:(typeof L0PatchPlan!=='
      + "'undefined'" + ')})})()');
    if (Number(probe.n) > 1) return probe;
    await sleep(500);
  }
  assert(false, '30s 内正文没有画出来');
  return {};
}

function markNodes(): Record<string, unknown> {
  return evalInPage("(function(){"
    + "var body=document.getElementById('docBody');"
    + 'var kids=[].slice.call(body.children);'
    + 'kids.forEach(function(el,i){el.__keep=i});'
    + "var areas=[].slice.call(document.querySelectorAll('#docBody textarea[data-edit]'));"
    + 'window.__first=(areas[0]?areas[0].dataset.edit:null);'
    + 'window.__second=(areas[1]?areas[1].dataset.edit:null);'
    + 'return JSON.stringify({count:kids.length,first:window.__first,second:window.__second})'
    + '})()');
}

function keptCount(): Record<string, unknown> {
  return evalInPage("(function(){"
    + "var kids=[].slice.call(document.getElementById('docBody').children);"
    + 'var kept=kids.filter(function(el){return typeof el.__keep==='
    + "'number'" + '}).length;'
    + 'return JSON.stringify({count:kids.length,kept:kept})'
    + '})()');
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
    await test('D1 起独立实例，页面里能拿到判定层（拿不到会静默退回整片）', async () => {
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
      assert(await waitServerReady(), `Demo 服务启动超时：${BASE}/api/state 一直没有响应`);

      step('打开页面并等正文画出来…');
      runCli(ab('close'));
      openAppPage();
      const probe = await waitDocBody();
      step(`正文节点 ${probe.n} 个，判定层已加载=${probe.planner}`);
      assertEqual(probe.planner, true, '页面里必须能拿到 L0PatchPlan（拿不到就退回整片，且不报错）');
    });

    await test('D2 自己打的字落笔后，连它自己都不该被替换（L3）', async () => {
      const marked = markNodes();
      const count = Number(marked.count);
      const target = String(marked.first || '');
      assert(count > 1 && target !== '', '前置：应有可编辑的文本段');

      step(`在 ${target} 追加一个字并失焦（触发自动落笔）…`);
      evalInPage('(function(){'
        + 'var id=window.__first;'
        + 'window.__t=id;'
        + "var all=document.querySelectorAll('#docBody textarea[data-edit]');"
        + 'var el=null;'
        + 'for(var i=0;i<all.length;i++){if(all[i].dataset.edit===id){el=all[i];break}}'
        + 'if(!el){return JSON.stringify({ok:false})}'
        + 'el.value=el.value+String.fromCharCode(88);'
        + "el.dispatchEvent(new Event('input',{bubbles:true}));"
        + 'el.blur();'
        + 'return JSON.stringify({ok:true})'
        + '})()');
      await sleep(2500);

      const after = keptCount();
      const textOk = evalInPage("(function(){"
        + "var all=document.querySelectorAll('#docBody textarea[data-edit]');"
        + 'var el=null;'
        + 'for(var i=0;i<all.length;i++){if(all[i].dataset.edit===window.__t){el=all[i];break}}'
        + 'return JSON.stringify({ok:!!(el&&el.value.indexOf(String.fromCharCode(88))>0)})'
        + '})()');
      step(`落笔后：${after.kept}/${after.count} 个节点保留原元素，文本已落上=${textOk.ok}`);
      assertEqual(after.count, count, '节点数不该变');
      assertEqual(after.kept, count, '自己打的那一段也不该被替换：界面上的字就是服务端那一份，换掉只会切断撤销栈');
      assertEqual(textOk.ok, true, '打的字必须真的进了那一格');
    });

    await test('D3 别处改一个节点：只有它被替换，其余原地不动（L2）', async () => {
      const marked = markNodes();
      const count = Number(marked.count);
      const target = String(marked.second || marked.first || '');
      assert(count > 1 && target !== '', '前置：应有第二个可编辑段');

      step(`直接改 ${target}（走 /api/edit + apply），模拟"别处动了这一格"…`);
      evalInPage('(function(){'
        + 'var id=window.__second;'
        + 'window.__p=id;'
        + "var all=document.querySelectorAll('#docBody textarea[data-edit]');"
        + 'var el=null;'
        + 'for(var i=0;i<all.length;i++){if(all[i].dataset.edit===id){el=all[i];break}}'
        + 'if(!el){return JSON.stringify({ok:false})}'
        + "fetch('/api/edit',{method:'POST',headers:{'Content-Type':'application/json'},"
        + 'body:JSON.stringify({nodeId:id,text:el.value+String.fromCharCode(89)})})'
        + '.then(function(r){return r.json()})'
        + '.then(function(res){if(res&&res.state){apply({state:res.state})}window.__done=1})'
        + '.catch(function(){window.__done=2});'
        + 'return JSON.stringify({ok:true})'
        + '})()');
      await sleep(2500);

      const after = evalInPage("(function(){"
        + "var body=document.getElementById('docBody');"
        + 'var kids=[].slice.call(body.children);'
        + 'var kept=kids.filter(function(el){return typeof el.__keep==='
        + "'number'" + '}).length;'
        + 'var target=null;'
        + 'for(var i=0;i<kids.length;i++){if(kids[i].dataset.nodeId===window.__p){target=kids[i];break}}'
        + 'return JSON.stringify({count:kids.length,kept:kept,done:window.__done||0,'
        + 'targetReplaced:!!(target&&typeof target.__keep!=='
        + "'number'" + ')})'
        + '})()');
      step(`改完：${after.kept}/${after.count} 个节点保留原元素，目标节点被替换=${after.targetReplaced}`);
      assertEqual(after.done, 1, '这一笔应真的落盘并拿到新状态');
      assertEqual(after.count, count, '节点数不该变');
      assertEqual(after.targetReplaced, true, '变了的那个节点必须被替换（否则界面上留着旧内容）');
      assertEqual(after.kept, count - 1, '其余节点必须原地不动 —— 这正是"局部重画"的全部意义');
    });
  } finally {
    try { runCli(ab('close')); } catch { }
    if (instance !== null) {
      try { (instance as ChildProcess).kill(); } catch { }
    }
  }

  process.exit(suite.report());
}

void main();
