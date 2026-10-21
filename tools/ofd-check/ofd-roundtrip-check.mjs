#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, relative } from 'node:path';

const HELP = `OFD/OFD-H round-trip 验收探针

用法: node ofd-roundtrip-check.mjs <file.ofd> [options]

选项:
  -e, --expect <file.json>   机读数据清单，用于计算 round-trip 完整率
  -j, --json <file.json>     将完整报告写入指定文件
  -k, --keep                 保留解包目录
  -s, --require-signature    缺少签名即判为失败
  -t, --min-text <n>         文本字符数下限（默认 20）
  -h, --help                 显示帮助
`;

function parseArgs(argv) {
  const out = { file: null, expect: null, report: null, keep: false, requireSignature: false, minText: 20, help: false };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '-e' || a === '--expect') out.expect = argv[++i];
    else if (a === '-j' || a === '--json') out.report = argv[++i];
    else if (a === '-k' || a === '--keep') out.keep = true;
    else if (a === '-s' || a === '--require-signature') out.requireSignature = true;
    else if (a === '-t' || a === '--min-text') out.minText = Number(argv[++i]) || 20;
    else if (a === '-h' || a === '--help') out.help = true;
    else rest.push(a);
  }
  out.file = rest[0] || null;
  return out;
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: 'ignore', windowsHide: true });
  if (r.error) return { ok: false, why: `${cmd}: ${r.error.message}` };
  if (r.status !== 0) return { ok: false, why: `${cmd}: exit ${r.status}` };
  return { ok: true, why: `${cmd} 解包成功` };
}

function psQuote(p) {
  return `'${String(p).replace(/'/g, "''")}'`;
}

function extract(file, destDir) {
  const attempts = [];
  attempts.push(() => run('tar', ['-xf', file, '-C', destDir]));
  attempts.push(() => run('unzip', ['-o', '-q', file, '-d', destDir]));
  if (process.platform === 'win32') {
    attempts.push(() => {
      const zipCopy = `${destDir}.zip`;
      copyFileSync(file, zipCopy);
      return run('powershell', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Expand-Archive -LiteralPath ${psQuote(zipCopy)} -DestinationPath ${psQuote(destDir)} -Force`,
      ]);
    });
  }
  const tried = [];
  for (const attempt of attempts) {
    const r = attempt();
    tried.push(r.why);
    if (r.ok) return { tool: r.why, tried };
  }
  throw new Error(`解包失败。已尝试：${tried.join(' | ')}`);
}

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}

function readTextSafe(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    try {
      return readFileSync(file, 'latin1');
    } catch {
      return '';
    }
  }
}

/** 读取 JSON，兼容 Windows 工具常见的 UTF-8 BOM */
function readJsonSafe(file) {
  const raw = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`不是合法 JSON：${file}（${err.message}）`);
  }
}

const FURNITURE_PREFIX = 'layer-furniture';

function splitFurnitureLayers(xmlText) {
  const reLayer = /<(?:[\w.-]+:)?Layer\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:[\w.-]+:)?Layer>)/g;
  let count = 0;
  let text = '';
  const body = xmlText.replace(reLayer, (all, attrs = '', inner = '') => {
    const idMatch = /\bID\s*=\s*"([^"]*)"/.exec(attrs);
    const id = (idMatch ? idMatch[1] : '').toLowerCase();
    if (id.startsWith(FURNITURE_PREFIX)) {
      count += 1;
      text += inner;
      return '';
    }
    return all;
  });
  return { body, count, text };
}

const RE_TEXTCODE = /<(?:[\w.-]+:)?TextCode\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?TextCode>/g;
const RE_PATHOBJ = /<(?:[\w.-]+:)?PathObject\b/g;
const RE_IMAGEOBJ = /<(?:[\w.-]+:)?ImageObject\b/g;
const RE_FILE_REF = /\bFileRef="([^"]+)"/g;
const RE_PREFIX = /<([A-Za-z_][\w.-]*):([\w.-]+)/g;

const KNOWN_PREFIXES = new Set(['ofd', 'xsi', 'xs', 'xsd', 'xlink', 'ds', 'xml']);
const MACHINE_KEYWORDS = ['dataelement', 'machine', 'customdata', 'structured', 'ofdh', 'ofd-h', 'metadatablock'];

function detectMachineReadable(xmlTexts) {
  const prefixes = new Map();
  const keywords = new Map();
  for (const { rel, text } of xmlTexts) {
    let m;
    RE_PREFIX.lastIndex = 0;
    while ((m = RE_PREFIX.exec(text)) !== null) {
      const prefix = m[1];
      if (KNOWN_PREFIXES.has(prefix)) continue;
      if (!prefixes.has(prefix)) prefixes.set(prefix, { count: 0, files: new Set(), sample: m[2] });
      const entry = prefixes.get(prefix);
      entry.count += 1;
      entry.files.add(rel);
    }
    for (const kw of MACHINE_KEYWORDS) {
      const hits = text.toLowerCase().split(kw).length - 1;
      if (hits > 0) {
        if (!keywords.has(kw)) keywords.set(kw, { count: 0, files: new Set() });
        const entry = keywords.get(kw);
        entry.count += hits;
        entry.files.add(rel);
      }
    }
  }
  return {
    customPrefixes: [...prefixes.entries()].map(([prefix, v]) => ({
      prefix,
      count: v.count,
      files: [...v.files],
      sampleTag: v.sample,
    })),
    keywordHits: [...keywords.entries()].map(([kw, v]) => ({ keyword: kw, count: v.count, files: [...v.files] })),
  };
}

function detectSignatures(files, xmlTexts) {
  const signatureFiles = files.filter((f) => /signatures?\.xml$/i.test(f) || /[\\/]signatures[\\/]/i.test(f));
  const signedRefs = new Set();
  for (const { text } of xmlTexts) {
    let m;
    RE_FILE_REF.lastIndex = 0;
    while ((m = RE_FILE_REF.exec(text)) !== null) signedRefs.add(m[1]);
  }
  return { signatureFiles, signedRefs: [...signedRefs] };
}

function parseSignatureReferences(text) {
  const out = [];
  const re = /<(?:[\w.-]+:)?Reference\b([^>]*)\/?>/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const fileRef = /\bFileRef\s*=\s*"([^"]*)"/.exec(m[1]);
    const digest = /\bDigest\s*=\s*"([0-9a-fA-F]+)"/.exec(m[1]);
    if (fileRef && digest) out.push({ fileRef: fileRef[1], digest: digest[1] });
  }
  return out;
}

/** 本机 OpenSSL 是否提供 SM3：不提供时**不能**给出"摘要一致"的结论（宁可报失败并说明） */
function hasSm3() {
  try {
    createHash('sm3').update('abc').digest('hex');
    return true;
  } catch {
    return false;
  }
}

function sm3Hex(bytes) {
  return createHash('sm3').update(bytes).digest('hex');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.file) {
    process.stdout.write(HELP);
    process.exit(args.help ? 0 : 2);
  }
  if (!existsSync(args.file)) {
    process.stderr.write(`找不到文件：${args.file}\n`);
    process.exit(2);
  }

  const checks = [];
  const add = (id, name, pass, critical, detail, hint) => checks.push({ id, name, pass, critical, detail, hint });

  const workRoot = mkdtempSync(join(tmpdir(), 'ofd-check-'));
  const extractDir = join(workRoot, 'unpacked');

  let xmlish = [];
  let files = [];
  let signatureInfo = { signatureFiles: [], signedRefs: [] };
  let stats = { textChars: 0, textCodeCount: 0, pathObjectCount: 0, imageObjectCount: 0, pageCount: 0 };
  let machine = { customPrefixes: [], keywordHits: [] };
  let structureOk = false;
  let roundTrip = null;

  try {
    const { tool } = extract(args.file, extractDir);
    files = walk(extractDir);
    if (files.length === 0) throw new Error('解包目录为空，文件可能不是有效的 OFD（ZIP 容器）');

    const relOf = (p) => relative(extractDir, p).replace(/\\/g, '/');
    xmlish = files.map((p) => ({ abs: p, rel: relOf(p), text: readTextSafe(p) }));
    const xmlTexts = xmlish.filter((f) => f.text.length > 0);

    const hasOfdEntry = xmlTexts.some((f) => /(^|\/)OFD\.xml$/i.test(f.rel));
    const hasDocument = xmlTexts.some((f) => /Document\.xml$/i.test(f.rel));
    const contentFiles = xmlTexts.filter((f) => /Content\.xml$/i.test(f.rel));
    stats.pageCount = contentFiles.length;
    structureOk = hasOfdEntry && hasDocument && contentFiles.length > 0;
    add(
      'C1',
      '结构完整性',
      structureOk,
      true,
      `OFD.xml=${hasOfdEntry ? '有' : '无'}，Document.xml=${hasDocument ? '有' : '无'}，Content.xml=${contentFiles.length} 个`,
      structureOk ? undefined : '请确认文件确为 OFD（本工具按 ZIP 容器解包）',
    );

    const joined = xmlTexts.map((f) => f.text).join('\n');
    const furniture = splitFurnitureLayers(joined);
    const countChars = (s) => s.replace(/<[^>]+>/g, '').replace(/\s+/g, '').length;
    const textCodes = furniture.body.match(RE_TEXTCODE) || [];
    const textChars = textCodes.reduce((sum, s) => sum + countChars(s), 0);
    stats.textCodeCount = textCodes.length;
    stats.textChars = textChars;
    stats.furnitureLayers = furniture.count;
    stats.furnitureChars = countChars(furniture.text);
    stats.pathObjectCount = (joined.match(RE_PATHOBJ) || []).length;
    stats.imageObjectCount = (joined.match(RE_IMAGEOBJ) || []).length;

    const textOk = textChars >= args.minText;
    add(
      'C2',
      '文本真实性（非路径化）',
      textOk,
      true,
      `正文文本字符=${textChars}，TextCode=${stats.textCodeCount}，PathObject=${stats.pathObjectCount}，ImageObject=${stats.imageObjectCount}` +
        (stats.furnitureLayers > 0 ? `，装饰层 ${stats.furnitureLayers} 层 / ${stats.furnitureChars} 字符（页眉页脚，未计入正文）` : ''),
      textOk
        ? undefined
        : textChars === 0 && stats.pathObjectCount > 0
          ? '疑似“可视化陷阱”：页面由路径对象绘制，无真实文本，机器无法抽取任何内容'
          : `文本字符低于下限 ${args.minText}，请人工确认是否内容为图像/路径`,
    );

    machine = detectMachineReadable(xmlTexts);
    const machineFound = machine.customPrefixes.length > 0 || machine.keywordHits.length > 0;
    add(
      'C3',
      '机读信息探测（启发式）',
      machineFound,
      false,
      machineFound
        ? `自定义命名空间 ${machine.customPrefixes.length} 个，关键词命中 ${machine.keywordHits.length} 类`
        : '未探测到自定义命名空间或机读关键词',
      machineFound
        ? '命中不等于合规：标准正文未公开，需人工核对该扩展区是否承载结构化机读信息'
        : '若供应商宣称“结构化友好”，请索要机读信息规范与标签字典；否则本文件仅为版式文档',
    );

    /* -- C4 签名与覆盖范围 -- */
    signatureInfo = detectSignatures(files, xmlTexts);
    const hasSignature = signatureInfo.signatureFiles.length > 0 || signatureInfo.signedRefs.length > 0;
    add(
      'C4',
      '签名与覆盖范围',
      args.requireSignature ? hasSignature : true,
      args.requireSignature,
      hasSignature
        ? `签名文件 ${signatureInfo.signatureFiles.length} 个，被签文件引用 ${signatureInfo.signedRefs.length} 条`
        : args.requireSignature
          ? '未发现签名，但本次运行要求签名必须存在'
          : '未发现签名（草稿阶段可接受）',
      hasSignature
        ? signatureInfo.signedRefs.length
          ? undefined
          : '签名存在但未解析到 FileRef 覆盖清单，需人工确认结构化数据是否在签名范围内'
        : args.requireSignature
          ? '定版/归档产物应具备签名'
          : '定版前应补齐签名，且签名必须覆盖正文与机读信息',
    );

    if (args.expect) {
      if (!existsSync(args.expect)) throw new Error(`--expect 文件不存在：${args.expect}`);
      const raw = readJsonSafe(args.expect);
      const elements = Array.isArray(raw) ? raw : raw.elements || raw.dataElements || [];
      if (elements.length === 0) throw new Error('--expect 中未找到 elements/dataElements 数组');
      const haystack = joined;
      const missing = [];
      let found = 0;
      for (const el of elements) {
        const code = el.code || (el.tag && el.tag.code);
        const valueText = el.valueText != null ? String(el.valueText) : el.value != null ? String(el.value) : '';
        const hit = (code && haystack.includes(String(code))) || (valueText && haystack.includes(valueText));
        if (hit) found += 1;
        else missing.push({ code: code || null, valueText: valueText || null, nodeId: el.nodeId || null });
      }
      const completeness = found / elements.length;
      roundTrip = { total: elements.length, found, missing, completeness };
      const pass = completeness >= 0.95;
      add(
        'C5',
        'round-trip 完整率',
        pass,
        true,
        `期望元素 ${elements.length} 个，命中 ${found} 个，完整率 ${(completeness * 100).toFixed(1)}%（阈值 95%）`,
        pass ? undefined : `缺失 ${missing.length} 个元素，示例：${JSON.stringify(missing.slice(0, 3))}`,
      );
    }

    const signatureText = xmlTexts.find((f) => /Signatures?\.xml$/i.test(f.rel));
    const references = signatureText ? parseSignatureReferences(signatureText.text) : [];
    if (references.length === 0) {
      add('C6', '签名真实性（SM3 独立复算）', true, false, '未发现带摘要的签名引用清单（草稿阶段可接受）',
        '定版产物应带 Signatures.xml，且其中每个 Reference 都应含 Digest');
    } else {
      const sm3Available = hasSm3();
      const mismatched = [];
      const missingFiles = [];
      for (const ref of references) {
        const abs = join(extractDir, ref.fileRef);
        if (!existsSync(abs)) {
          missingFiles.push(ref.fileRef);
          continue;
        }
        if (!sm3Available) continue;
        const actual = sm3Hex(readFileSync(abs));
        if (actual.toLowerCase() !== ref.digest.toLowerCase()) mismatched.push(ref.fileRef);
      }
      if (!sm3Available) {
        add('C6', '签名真实性（SM3 独立复算）', false, true, `发现 ${references.length} 条签名引用，但本机 OpenSSL 不支持 SM3`,
          '无法独立复算摘要时不应给出"通过"结论：请升级 OpenSSL/Node，或改用具备国密能力的校验工具');
      } else {
        const detail = `被签文件 ${references.length} 个，摘要不符 ${mismatched.length} 个${missingFiles.length ? `，文件缺失 ${missingFiles.length} 个` : ''}`;
        add('C6', '签名真实性（SM3 独立复算）', mismatched.length === 0 && missingFiles.length === 0, true, detail,
          mismatched.length === 0 && missingFiles.length === 0
            ? '本工具仅复算摘要（不做 SM2 验签）；签名算法的有效性与合规性仍需具备国密资质的工具/设备确认'
            : `签名覆盖的文件已被改动：${[...mismatched, ...missingFiles].slice(0, 5).join('、')}`);
      }
    }
  } catch (err) {
    process.stderr.write(`执行失败：${err.message}\n`);
    if (!args.keep) rmSync(workRoot, { recursive: true, force: true });
    else process.stderr.write(`解包目录保留于：${extractDir}\n`);
    process.exit(2);
  }

  const criticalFailed = checks.filter((c) => c.critical && !c.pass);
  const exitCode = criticalFailed.length === 0 ? 0 : 1;

  const report = {
    tool: 'ofd-roundtrip-check',
    version: '1.0.0',
    file: args.file,
    generatedAt: new Date().toISOString(),
    structureOk,
    stats,
    machineReadable: machine,
    signatures: { files: signatureInfo.signatureFiles.map((f) => relative(extractDir, f).replace(/\\/g, '/')), signedRefs: signatureInfo.signedRefs },
    roundTrip,
    checks,
    verdict: exitCode === 0 ? 'PASS' : 'FAIL',
    disclaimer: 'C3 为启发式探测；本工具不判定是否符合 GB/T 48666—2026，结论不得用于对外合规声明。',
  };

  const line = (s) => process.stdout.write(`${s}\n`);
  line('');
  line(`OFD round-trip 验收探针  |  ${basename(args.file)}`);
  line('─'.repeat(72));
  for (const c of checks) {
    line(`${c.pass ? 'PASS' : 'FAIL'}  [${c.id}] ${c.name}${c.critical ? '' : '  (非关键)'}`);
    line(`      ${c.detail}`);
    if (c.hint) line(`      提示: ${c.hint}`);
  }
  line('─'.repeat(72));
  line(`结论: ${report.verdict}    关键失败项: ${criticalFailed.length}`);
  line(report.disclaimer);
  line('');

  if (args.report) {
    writeFileSync(args.report, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    line(`报告已写入: ${args.report}`);
  }

  if (args.keep) {
    line(`解包目录保留: ${extractDir}`);
  } else {
    rmSync(workRoot, { recursive: true, force: true });
  }

  process.exit(exitCode);
}

main();
