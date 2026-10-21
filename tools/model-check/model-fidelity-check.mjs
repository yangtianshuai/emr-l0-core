#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { clone, deepEqual, diffPaths, findUnserializable, isPlainObject } from './lib/model-utils.mjs';

const HELP = `S2 · 序列化往返保真检查

用法: node model-fidelity-check.mjs <doc.json|目录> [...] [选项]

选项:
  --impl <module.mjs>   真实实现模块（导出 toJson / fromJson）
  --lossy               使用内置劣化序列化器（自测探针有效性）
  --json <file>         输出完整报告
  -v, --verbose         打印全部差异
  -h, --help            显示帮助
`;

function parseArgs(argv) {
  const out = { inputs: [], impl: null, lossy: false, report: null, verbose: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--impl') out.impl = argv[++i];
    else if (a === '--lossy') out.lossy = true;
    else if (a === '--json') out.report = argv[++i];
    else if (a === '-v' || a === '--verbose') out.verbose = true;
    else if (a === '-h' || a === '--help') out.help = true;
    else out.inputs.push(a);
  }
  return out;
}

function lossyRoundTrip(doc) {
  const back = JSON.parse(JSON.stringify(doc));
  for (const node of Object.values(back.nodes || {})) {
    if (node.type === 'field' && typeof node.value === 'number') node.value = String(node.value);
    if (node.provenance && Array.isArray(node.provenance.evidence)) {
      node.provenance.evidence = node.provenance.evidence.slice(0, 1).map(({ quote, ...rest }) => rest);
    }
    if (node.parentId === null) delete node.parentId;
    if ('humanConfirmed' in node && node.humanConfirmed === true) delete node.humanConfirmed;
  }
  return back;
}

function collectJsonFiles(input) {
  const st = statSync(input);
  if (st.isDirectory()) return readdirSync(input).filter((f) => f.toLowerCase().endsWith('.json')).map((f) => resolve(input, f));
  return [resolve(input)];
}

function nodeEntries(doc) {
  return Object.entries(doc.nodes || {});
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.inputs.length === 0) {
    process.stdout.write(HELP);
    process.exit(args.help ? 0 : 2);
  }

  const files = [];
  for (const input of args.inputs) {
    if (!existsSync(input)) {
      process.stderr.write(`找不到输入：${input}\n`);
      process.exit(2);
    }
    files.push(...collectJsonFiles(input));
  }

  const results = [];
  const limit = args.verbose ? Number.MAX_SAFE_INTEGER : 6;

  return (async () => {
    let impl = null;
    if (args.impl) {
      const mod = await import(pathToFileURL(resolve(args.impl)).href);
      if (typeof mod.toJson !== 'function' || typeof mod.fromJson !== 'function') {
        process.stderr.write(`--impl 模块必须导出 toJson 与 fromJson：${args.impl}\n`);
        process.exit(2);
      }
      impl = mod;
    }

    for (const file of files) {
      const checks = [];
      const add = (id, name, pass, critical, detail, hint) => checks.push({ id, name, pass, critical, detail, hint });

      let doc;
      try {
        doc = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
      } catch (err) {
        results.push({ file, checks: [{ id: 'F0', name: 'JSON 解析', pass: false, critical: true, detail: err.message }], verdict: 'FAIL' });
        continue;
      }
      if (!doc || !isPlainObject(doc.nodes)) {
        results.push({ file, skipped: true, skipReason: '不含 nodes 字段，已跳过', checks: [], verdict: 'SKIP' });
        continue;
      }

      let back;
      let how;
      try {
        if (args.lossy) {
          back = lossyRoundTrip(doc);
          how = '内置劣化序列化器（自测模式）';
        } else if (impl) {
          const json = impl.toJson(doc);
          back = impl.fromJson(typeof json === 'string' ? JSON.parse(json) : json);
          how = `真实实现 ${basename(args.impl)}`;
        } else {
          back = JSON.parse(JSON.stringify(doc));
          how = '原生 JSON.stringify / JSON.parse';
        }
      } catch (err) {
        results.push({ file, checks: [{ id: 'F0', name: '往返执行', pass: false, critical: true, detail: err.message }], verdict: 'FAIL' });
        continue;
      }

      /* F1 往返语义一致 */
      const diffs = diffPaths(doc, back);
      add('F1', '往返语义一致', diffs.length === 0, true, diffs.length === 0 ? `无差异（方式：${how}）` : `发现 ${diffs.length} 处差异`, diffs.length ? '差异明细见下' : undefined);

      const missing = [];
      for (const [key, node] of nodeEntries(back)) {
        if (!node || !isPlainObject(node)) {
          missing.push({ path: key, issue: '节点不是对象' });
          continue;
        }
        for (const f of ['id', 'type', 'parentId', 'order', 'rev', 'provenance']) {
          if (!(f in node)) missing.push({ path: `${key}.${f}`, issue: '字段丢失' });
        }
        if (node.provenance && (!node.provenance.origin || !node.provenance.at)) missing.push({ path: `${key}.provenance`, issue: 'origin 或 at 丢失' });
        if (typeof node.order !== 'number') missing.push({ path: `${key}.order`, issue: `类型漂移为 ${typeof node.order}` });
        if (typeof node.rev !== 'number') missing.push({ path: `${key}.rev`, issue: `类型漂移为 ${typeof node.rev}` });
      }
      add('F2', '必填字段未丢失', missing.length === 0, true, missing.length === 0 ? '全部节点字段完整' : `${missing.length} 处缺失`);

      const aiLoss = [];
      for (const [key, node] of nodeEntries(doc)) {
        if (!node || node.provenance?.origin !== 'ai') continue;
        const after = back.nodes?.[key];
        if (!after || after.provenance?.origin !== 'ai') {
          aiLoss.push({ path: key, issue: 'AI 来源标记丢失' });
          continue;
        }
        if (after.provenance.modelId !== node.provenance.modelId) aiLoss.push({ path: `${key}.provenance.modelId`, issue: '丢失或变更' });
        if (after.provenance.confidence !== node.provenance.confidence) aiLoss.push({ path: `${key}.provenance.confidence`, issue: '丢失或变更' });
        const before = node.provenance.evidence || [];
        const nowEv = after.provenance.evidence || [];
        if (before.length !== nowEv.length) aiLoss.push({ path: `${key}.provenance.evidence`, issue: `依据数量 ${before.length} → ${nowEv.length}` });
      }
      add('F3', 'AI 来源完整（modelId/confidence/evidence）', aiLoss.length === 0, true, aiLoss.length === 0 ? '全部 AI 节点来源信息完整' : `${aiLoss.length} 处丢失`);

      const nullLoss = [];
      for (const [key, node] of nodeEntries(doc)) {
        if (node && node.parentId === null) {
          const after = back.nodes?.[key];
          if (!after || after.parentId !== null) nullLoss.push({ path: `${key}.parentId`, issue: 'null 被丢弃或改写' });
        }
      }
      add('F4', 'null 语义保真（parentId）', nullLoss.length === 0, true, nullLoss.length === 0 ? 'null 均保留' : `${nullLoss.length} 处 null 丢失`);

      const tsLoss = [];
      const collectIso = (obj, path, acc) => {
        if (typeof obj === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(obj)) acc.push([path, obj]);
        else if (Array.isArray(obj)) obj.forEach((v, i) => collectIso(v, `${path}[${i}]`, acc));
        else if (isPlainObject(obj)) for (const [k, v] of Object.entries(obj)) collectIso(v, `${path}.${k}`, acc);
      };
      const beforeTs = [];
      collectIso(doc, '$', beforeTs);
      for (const [path, value] of beforeTs) {
        const segs = path.replace(/^\$\./, '').split(/[.[\]]/).filter(Boolean);
        let cur = back;
        for (const s of segs) {
          if (cur == null) break;
          cur = cur[s];
        }
        if (typeof cur !== 'string' || Date.parse(cur) !== Date.parse(value)) tsLoss.push({ path, issue: `'${value}' → '${cur}'` });
      }
      add('F5', '时间戳稳定（ISO8601）', tsLoss.length === 0, true, tsLoss.length === 0 ? `检查 ${beforeTs.length} 处时间戳` : `${tsLoss.length} 处异常`);

      const typeDrift = [];
      const walkBoth = (a, b, path) => {
        if (a === null || b === null) return;
        if (typeof a !== typeof b) {
          typeDrift.push({ path, issue: `${typeof a} → ${typeof b}` });
          return;
        }
        if (Array.isArray(a) && Array.isArray(b)) {
          a.forEach((v, i) => walkBoth(v, b[i], `${path}[${i}]`));
          return;
        }
        if (isPlainObject(a) && isPlainObject(b)) for (const k of Object.keys(a)) if (k in b) walkBoth(a[k], b[k], `${path}.${k}`);
      };
      walkBoth(doc, back, '$');
      add('F6', '类型漂移（数字/布尔被字符串化等）', typeDrift.length === 0, true, typeDrift.length === 0 ? '无类型漂移' : `${typeDrift.length} 处漂移`);

      const reorder = (v) => {
        if (Array.isArray(v)) return v.map(reorder);
        if (isPlainObject(v)) {
          const o = {};
          for (const k of Object.keys(v).sort().reverse()) o[k] = reorder(v[k]);
          return o;
        }
        return v;
      };
      const stable = deepEqual(JSON.parse(JSON.stringify(reorder(doc))), JSON.parse(JSON.stringify(doc)));
      add('F7', '键顺序无关（语义等价）', stable, false, stable ? '键序变化不影响语义' : '键序变化导致语义变化（模型层有隐藏依赖）');

      /* F8 不可序列化值 */
      const bad = findUnserializable(doc);
      add('F8', '不可序列化值', bad.length === 0, true, bad.length === 0 ? '未发现 undefined/NaN/Infinity/BigInt/Date 实例等' : `${bad.length} 处`);

      const textBlob = JSON.stringify(doc);
      const covered = {
        newline: /\\n/.test(textBlob),
        quote: /\\"/.test(textBlob),
        cjkExt: /[\u3400-\u4DBF\u{20000}-\u{2FFFF}]/u.test(textBlob),
      };
      const missingCoverage = Object.entries(covered).filter(([, v]) => !v).map(([k]) => k);
      add(
        'F9',
        '特殊字符覆盖（换行/引号/生僻字）',
        missingCoverage.length === 0,
        false,
        `覆盖：${Object.entries(covered).filter(([, v]) => v).map(([k]) => k).join(', ') || '无'}`,
        missingCoverage.length ? `样例未覆盖：${missingCoverage.join(', ')}，建议补充边界样例再验收` : undefined,
      );

      /* F10 视觉一致性（不假装通过） */
      add('F10', '视觉一致性（需浏览器渲染层）', true, false, '本脚本不执行渲染比对，标记为未覆盖（需 UI 层实现，建议 Playwright 截图 diff）');

      const failed = checks.filter((c) => c.critical && !c.pass);
      results.push({ file, checks, diffs: diffs.slice(0, 200), verdict: failed.length === 0 ? 'PASS' : 'FAIL', how });
    }

    const out = [];
    const w = (s) => out.push(s);
    for (const r of results) {
      w('');
      w(`── ${basename(r.file)} ──`);
      if (r.skipped) {
        w(`SKIP  ${r.skipReason}`);
        continue;
      }
      if (r.how) w(`往返方式：${r.how}`);
      for (const c of r.checks) {
        w(`${c.pass ? 'PASS' : 'FAIL'}  [${c.id}] ${c.name}${c.critical ? '' : '  (非关键)'}`);
        w(`      ${c.detail}`);
        if (c.hint) w(`      提示: ${c.hint}`);
      }
      if (r.diffs && r.diffs.length > 0) {
        w(`  差异明细（前 ${Math.min(limit, r.diffs.length)} 条）：`);
        r.diffs.slice(0, limit).forEach((d) => w(`    ${d.path}  ${JSON.stringify(d.from)} → ${JSON.stringify(d.to)}`));
      }
      w(`结论：${r.verdict}`);
    }

    const failedAll = results.filter((r) => r.verdict === 'FAIL');
    w('');
    w('─'.repeat(72));
    w(`文件数：${results.length}    通过：${results.filter((r) => r.verdict === 'PASS').length}    失败：${failedAll.length}    跳过：${results.filter((r) => r.verdict === 'SKIP').length}`);
    w('F10 视觉一致性未覆盖：本脚本只保证"数据不丢"，画面是否一致需 UI 层渲染比对。');
    w('');
    process.stdout.write(out.join('\n'));

    if (args.report) {
      writeFileSync(
        args.report,
        `${JSON.stringify({ tool: 'model-fidelity-check', version: '1.0.0', generatedAt: new Date().toISOString(), mode: args.lossy ? 'lossy' : args.impl ? 'impl' : 'json', results, verdict: failedAll.length === 0 ? 'PASS' : 'FAIL' }, null, 2)}\n`,
        'utf8',
      );
      process.stdout.write(`报告已写入：${args.report}\n`);
    }

    process.exit(failedAll.length === 0 ? 0 : 1);
  })();
}

main();
