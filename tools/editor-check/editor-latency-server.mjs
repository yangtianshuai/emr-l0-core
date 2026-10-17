#!/usr/bin/env node
/**
 * 编辑器骨架本地服务（零依赖）
 *
 * 作用：把 editor.html 用 HTTP 提供出去，并接收页面回传的输入延迟报告，
 *      写入 tools/editor-check/samples/latency-report.json，供 perf-check 作为 P11 的实测输入。
 *
 * 为什么必须走 HTTP：file:// 下 fetch 会被浏览器拦截，报告无法回传；
 * 且真实的复制/粘贴、打印行为在 HTTP 下才接近生产环境。
 *
 * 用法：
 *   node editor-latency-server.mjs [--port 8787] [--doc <doc.json>]
 *   然后浏览器打开 http://127.0.0.1:8787/  → 点击"运行输入延迟测试"
 *
 * 退出：Ctrl+C
 */

import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLES = join(HERE, 'samples');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8' };

function parseArgs(argv) {
  const out = { port: 8787, doc: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--port') out.port = Number(argv[++i]) || 8787;
    else if (argv[i] === '--doc') out.doc = argv[++i];
    else if (argv[i] === '-h' || argv[i] === '--help') out.help = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  process.stdout.write('用法: node editor-latency-server.mjs [--port 8787] [--doc <doc.json>]\n');
  process.exit(0);
}

if (!existsSync(SAMPLES)) mkdirSync(SAMPLES, { recursive: true });

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'POST' && url.pathname === '/result') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 5_000_000) req.destroy();
    });
    req.on('end', () => {
      try {
        const report = JSON.parse(body);
        const file = join(SAMPLES, 'latency-report.json');
        writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
        const p95 = report?.input?.p95;
        const verdict = typeof p95 === 'number' && p95 <= (report.thresholdMs || 50) ? 'PASS' : 'FAIL';
        process.stdout.write(`收到延迟报告：输入 P95=${typeof p95 === 'number' ? p95.toFixed(2) : '—'}ms → ${verdict}  (已写入 ${file})\n`);
        res.writeHead(204).end();
      } catch (err) {
        res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  if (req.method !== 'GET') {
    res.writeHead(405).end('method not allowed');
    return;
  }

  let file = null;
  if (url.pathname === '/' || url.pathname === '/editor.html') file = join(HERE, 'editor.html');
  else if (url.pathname === '/doc.json' && args.doc && existsSync(args.doc)) file = args.doc;
  else if (url.pathname === '/result') {
    const saved = join(SAMPLES, 'latency-report.json');
    if (existsSync(saved)) file = saved;
  }

  if (!file || !existsSync(file)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
    return;
  }
  const type = MIME[extname(file)] || 'application/octet-stream';
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' }).end(readFileSync(file));
});

server.listen(args.port, '127.0.0.1', () => {
  process.stdout.write(`编辑器骨架已启动：http://127.0.0.1:${args.port}/\n`);
  process.stdout.write('在浏览器中打开上述地址 → 点击"运行输入延迟测试"，结果会自动回传。\n');
  process.stdout.write('注意：真实验收还需在医院老旧 PC / 信创终端上重复本测试。\n');
  process.stdout.write('按 Ctrl+C 退出。\n');
});
