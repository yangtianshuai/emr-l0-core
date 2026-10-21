#!/usr/bin/env node
/**
 * 版式一致性对拍探针（独立进程，不 import 仓库源码）。
 *
 * 输入两份互不相干的东西：
 *   1) 归档件 .ofd —— 按 XML 逐页抽 TextCode / ImageObject 的坐标与文本；
 *   2) 预览快照 .json —— 界面实际消费的那份排版结果（GET /api/layout）。
 * 对同一份文书，两者必须逐页、逐行、逐字、逐坐标对得上。
 *
 * 用法：
 *   node tools/layout-check/layout-check.mjs <file.ofd> --layout <layout.json> [--json report.json] [--tolerance 0.5]
 *
 * 退出码：0 全部通过；1 有失败项；2 输入不可读。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

const USAGE = `用法: node layout-check.mjs <file.ofd> --layout <layout.json> [--json <report.json>] [--tolerance <pt>]`;

function argsOf(argv) {
  const out = { file: '', layout: '', json: '', tolerance: 0.5 };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item === '--layout') out.layout = argv[++i] ?? '';
    else if (item === '--json') out.json = argv[++i] ?? '';
    else if (item === '--tolerance') out.tolerance = Number(argv[++i] ?? '0.5');
    else if (item === '-h' || item === '--help') out.help = true;
    else rest.push(item);
  }
  out.file = rest[0] ?? '';
  return out;
}

/** 只读本地文件头：本仓库的 OFD 用 store（0），外部件可能是 deflate（8） */
function readZip(buffer) {
  const entries = new Map();
  let offset = 0;
  while (offset + 30 <= buffer.length) {
    if (buffer.readUInt32LE(offset) !== 0x04034b50) break;
    const method = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const name = buffer.toString('utf8', offset + 30, offset + 30 + nameLength);
    const start = offset + 30 + nameLength + extraLength;
    const raw = buffer.subarray(start, start + compressedSize);
    entries.set(name, method === 0 ? raw : inflateRawSync(raw));
    offset = start + compressedSize;
  }
  return entries;
}

function unescapeXml(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function layersOf(xml) {
  const layers = new Map();
  const pattern = /<ofd:Layer ID="([^"]+)">([\s\S]*?)<\/ofd:Layer>/g;
  let match;
  while ((match = pattern.exec(xml)) !== null) layers.set(match[1], match[2]);
  return layers;
}

function textCodesOf(xml) {
  const out = [];
  const pattern = /<ofd:TextCode X="([-\d.]+)" Y="([-\d.]+)">([\s\S]*?)<\/ofd:TextCode>/g;
  let match;
  while ((match = pattern.exec(xml)) !== null) {
    out.push({ x: Number(match[1]), y: Number(match[2]), text: unescapeXml(match[3]) });
  }
  return out;
}

function imageObjectsOf(xml) {
  const out = [];
  const pattern = /<ofd:ImageObject\b[^>]*\bBoundary="([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+)"/g;
  let match;
  while ((match = pattern.exec(xml)) !== null) {
    out.push({ x: Number(match[1]), y: Number(match[2]), width: Number(match[3]), height: Number(match[4]) });
  }
  return out;
}

/** 按页抽出行：正文层取 TextObject/ImageObject，页面家具层单独取 */
function pagesOf(entries) {
  const names = [...entries.keys()]
    .map((name) => ({ name, match: /^Doc_0\/Pages\/Page_(\d+)\/Content\.xml$/.exec(name) }))
    .filter((item) => item.match !== null)
    .sort((a, b) => Number(a.match[1]) - Number(b.match[1]));

  return names.map(({ name, match }) => {
    const xml = entries.get(name).toString('utf8');
    const layers = layersOf(xml);
    let body = '';
    for (const [id, content] of layers) {
      if (id === 'layer0') body = content;
    }
    const headerLayer = [...layers.entries()].find(([id]) => /furniture-header/.test(id));
    const footerLayer = [...layers.entries()].find(([id]) => /furniture-footer/.test(id));
    return {
      number: Number(match[1]) + 1,
      body: [...textCodesOf(body).map((item) => ({ kind: 'text', ...item })), ...imageObjectsOf(body).map((item) => ({ kind: 'image', ...item }))]
        .sort((a, b) => (a.y === b.y ? a.x - b.x : a.y - b.y)),
      header: headerLayer ? textCodesOf(headerLayer[1]).map((item) => item.text).join('') : '',
      footer: footerLayer ? textCodesOf(footerLayer[1]).map((item) => item.text).join('') : '',
    };
  });
}

function near(a, b, tolerance) {
  return Math.abs(Number(a) - Number(b)) <= tolerance;
}

const args = argsOf(process.argv.slice(2));
if (args.help === true || args.file === '' || args.layout === '') {
  process.stdout.write(`${USAGE}\n`);
  process.exit(args.help === true ? 0 : 2);
}

let entries;
let snapshot;
try {
  entries = readZip(readFileSync(args.file));
} catch (err) {
  process.stdout.write(`无法读取 OFD：${err.message}\n`);
  process.exit(2);
}
try {
  snapshot = JSON.parse(readFileSync(args.layout, 'utf8').replace(/^\uFEFF/, ''));
} catch (err) {
  process.stdout.write(`无法读取排版快照：${err.message}\n`);
  process.exit(2);
}
if (snapshot && snapshot.data && Array.isArray(snapshot.data.pages)) snapshot = snapshot.data;

const checks = [];
const add = (id, name, pass, detail) => checks.push({ id, name, pass, detail });

const pages = pagesOf(entries);
const expected = Array.isArray(snapshot.pages) ? snapshot.pages : [];

add('C1', '页数一致', pages.length === expected.length, `归档件 ${pages.length} 页 / 预览 ${expected.length} 页`);

let textMismatch = null;
let coordMismatch = null;
let countMismatch = null;

const limit = Math.min(pages.length, expected.length);
for (let i = 0; i < limit; i += 1) {
  const actual = pages[i];
  const want = expected[i];
  const wantLines = Array.isArray(want.lines) ? want.lines : [];
  if (actual.body.length !== wantLines.length) {
    countMismatch = countMismatch ?? { page: i + 1, actual: actual.body.length, want: wantLines.length };
    continue;
  }
  for (let j = 0; j < wantLines.length; j += 1) {
    const a = actual.body[j];
    const w = wantLines[j];
    if (a.kind === 'text') {
      if (a.text !== String(w.text ?? '')) {
        textMismatch = textMismatch ?? { page: i + 1, line: j + 1, actual: a.text, want: w.text };
        break;
      }
      if (!near(a.x, w.x, args.tolerance) || !near(a.y, w.y, args.tolerance)) {
        coordMismatch = coordMismatch ?? { page: i + 1, line: j + 1, actual: { x: a.x, y: a.y }, want: { x: w.x, y: w.y } };
        break;
      }
    } else {
      if (!near(a.width, w.image?.widthPt ?? -1, args.tolerance) || !near(a.height, w.image?.heightPt ?? -1, args.tolerance)) {
        coordMismatch = coordMismatch ?? { page: i + 1, line: j + 1, actual: { w: a.width, h: a.height }, want: w.image };
        break;
      }
    }
  }
}

add('C2', '每页行数一致', countMismatch === null, countMismatch === null ? `逐页行数相等（${pages.map((p) => p.body.length).join('/')}）` : `第 ${countMismatch.page} 页行数不符：归档 ${countMismatch.actual} / 预览 ${countMismatch.want}`);
add('C3', '逐行文本完全一致', textMismatch === null, textMismatch === null ? '文本逐行相等' : `第 ${textMismatch.page} 页第 ${textMismatch.line} 行：归档「${textMismatch.actual}」/ 预览「${textMismatch.want}」`);
add('C4', `逐行坐标一致（容差 ${args.tolerance}pt）`, coordMismatch === null, coordMismatch === null ? '坐标逐行相等' : `第 ${coordMismatch.page} 页第 ${coordMismatch.line} 行：归档 ${JSON.stringify(coordMismatch.actual)} / 预览 ${JSON.stringify(coordMismatch.want)}`);

const furnitureFailures = [];
for (let i = 0; i < limit; i += 1) {
  const want = expected[i];
  const actual = pages[i];
  if (String(want.header ?? '') !== '' && actual.header !== String(want.header)) {
    furnitureFailures.push(`第 ${i + 1} 页页眉：归档「${actual.header}」/ 预览「${want.header}」`);
  }
  if (String(want.footer ?? '') !== '' && actual.footer !== String(want.footer)) {
    furnitureFailures.push(`第 ${i + 1} 页页脚：归档「${actual.footer}」/ 预览「${want.footer}」`);
  }
}
add('C5', '页眉页脚一致（含页码）', furnitureFailures.length === 0, furnitureFailures.length === 0 ? '页眉页脚逐页相等' : furnitureFailures.join('；'));

const failed = checks.filter((check) => !check.pass);
const report = {
  verdict: failed.length === 0 ? 'PASS' : 'FAIL',
  stats: {
    pages: pages.length,
    expectedPages: expected.length,
    lines: pages.reduce((sum, page) => sum + page.body.length, 0),
    chars: pages.reduce((sum, page) => sum + page.body.reduce((count, line) => count + (line.kind === 'text' ? line.text.length : 0), 0), 0),
  },
  checks,
};

if (args.json !== '') writeFileSync(args.json, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

const lines = [];
lines.push(`版式一致性对拍  |  ${args.file}`);
lines.push(`对照快照：${args.layout}`);
lines.push('─'.repeat(78));
for (const check of checks) {
  lines.push(`${check.pass ? 'PASS' : 'FAIL'}  [${check.id}] ${check.name}`);
  lines.push(`      ${check.detail}`);
}
lines.push('─'.repeat(78));
lines.push(`结论：${report.verdict}    页 ${report.stats.pages}    行 ${report.stats.lines}    字 ${report.stats.chars}`);
lines.push('说明：只比对"预览与归档件"两个实现。编辑区与打印消费同一份坐标，不单独参与对拍。');
process.stdout.write(`${lines.join('\n')}\n`);
process.exit(failed.length === 0 ? 0 : 1);
