#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { applyPatch, clone, deepEqual, isPlainObject, jsonDiff, makeRng, pick } from './lib/model-utils.mjs';

const HELP = `S3 · 节点操作 / 留痕 / 回放一致性检查

用法: node node-diff-check.mjs <doc.json|目录> [...] [选项]

选项:
  --steps <n>                  操作步数（默认 24）
  --seed <n>                   随机种子（默认 20261008）
  --json <file>                输出完整报告
  -v, --verbose                打印每步操作明细
  --inject-drop-patch <k>      丢弃第 k 条 patch（验证 D4）
  --inject-drop-revision <k>   丢弃第 k 条留痕（验证 D3）
  --inject-renumber            改名节点 id（验证 D6）
  --inject-strip-provenance    抹掉 provenance（验证 D5）
  -h, --help                   显示帮助
`;

function parseArgs(argv) {
  const out = {
    inputs: [],
    steps: 24,
    seed: 20261008,
    report: null,
    verbose: false,
    help: false,
    injectDropPatch: 0,
    injectCorruptPatch: false,
    injectDropRevision: 0,
    injectRenumber: false,
    injectStripProvenance: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--steps') out.steps = Number(argv[++i]) || 24;
    else if (a === '--seed') out.seed = Number(argv[++i]) || 1;
    else if (a === '--json') out.report = argv[++i];
    else if (a === '-v' || a === '--verbose') out.verbose = true;
    else if (a === '--inject-drop-patch') out.injectDropPatch = Number(argv[++i]) || 0;
    else if (a === '--inject-corrupt-patch') out.injectCorruptPatch = true;
    else if (a === '--inject-drop-revision') out.injectDropRevision = Number(argv[++i]) || 0;
    else if (a === '--inject-renumber') out.injectRenumber = true;
    else if (a === '--inject-strip-provenance') out.injectStripProvenance = true;
    else if (a === '-h' || a === '--help') out.help = true;
    else out.inputs.push(a);
  }
  return out;
}

const allNodes = (doc) => Object.values(doc.nodes);
const isLeaf = (doc, id) => !Object.values(doc.nodes).some((n) => n.parentId === id);
const siblingsOf = (doc, parentId) => Object.values(doc.nodes).filter((n) => n.parentId === parentId);
const nextOrder = (doc, parentId) => siblingsOf(doc, parentId).reduce((m, n) => Math.max(m, n.order || 0), 0) + 10;

function mkReplaceOrAdd(node, prop, value) {
  return { op: prop in node ? 'replace' : 'add', path: `/nodes/${node.id}/${prop}`, value };
}

function opInsertText(doc, rng) {
  const candidates = allNodes(doc).filter((n) => n.type === 'text' && Array.isArray(n.runs) && n.runs.length > 0);
  const node = pick(rng, candidates);
  if (!node) return null;
  const idx = node.runs.length - 1;
  const after = `${node.runs[idx].text}（追加${Math.floor(rng() * 1000)}）`;
  const next = clone(doc);
  next.nodes[node.id].runs[idx].text = after;
  return { revOp: 'insert', targetId: node.id, newDoc: next, patch: [{ op: 'replace', path: `/nodes/${node.id}/runs/${idx}/text`, value: after }], desc: `insertText ${node.id}` };
}

function opReplaceText(doc, rng) {
  const candidates = allNodes(doc).filter((n) => n.type === 'text' && Array.isArray(n.runs) && n.runs.length > 0);
  const node = pick(rng, candidates);
  if (!node) return null;
  const after = `改写后的文本 ${Math.floor(rng() * 1000)}`;
  const next = clone(doc);
  next.nodes[node.id].runs[0].text = after;
  return { revOp: 'update', targetId: node.id, newDoc: next, patch: [{ op: 'replace', path: `/nodes/${node.id}/runs/0/text`, value: after }], desc: `replaceText ${node.id}` };
}

function opUpdateProps(doc, rng) {
  const props = ['semantic', 'title', 'sectionCode'];
  const candidates = allNodes(doc).filter((n) => props.some((p) => p in n));
  const node = pick(rng, candidates);
  if (!node) return null;
  const prop = props.find((p) => p in node);
  const after = `${node[prop]}_v${Math.floor(rng() * 100)}`;
  const next = clone(doc);
  next.nodes[node.id][prop] = after;
  return { revOp: 'update', targetId: node.id, newDoc: next, patch: [mkReplaceOrAdd(node, prop, after)], desc: `updateProps ${node.id}.${prop}` };
}

function opSetFieldValue(doc, rng) {
  const candidates = allNodes(doc).filter((n) => n.type === 'field');
  const node = pick(rng, candidates);
  if (!node) return null;
  const next = clone(doc);
  let afterValue;
  if (typeof node.value === 'number') afterValue = Math.round((node.value + 0.1) * 100) / 100;
  else afterValue = `${node.value}_u`;
  const afterText = String(afterValue);
  next.nodes[node.id].value = afterValue;
  next.nodes[node.id].valueText = afterText;
  return {
    revOp: 'update',
    targetId: node.id,
    newDoc: next,
    patch: [mkReplaceOrAdd(node, 'value', afterValue), mkReplaceOrAdd(node, 'valueText', afterText)],
    desc: `setFieldValue ${node.id}`,
  };
}

function opMarkKeyContent(doc, rng) {
  const candidates = allNodes(doc).filter((n) => (n.type === 'field' || n.type === 'control') && n.keyContent !== true);
  const node = pick(rng, candidates);
  if (!node) return null;
  const next = clone(doc);
  // 关键内容必须人工确认，避免制造语义违规（S5 会拦）
  next.nodes[node.id].keyContent = true;
  next.nodes[node.id].humanConfirmed = true;
  return {
    revOp: 'update',
    targetId: node.id,
    newDoc: next,
    patch: [mkReplaceOrAdd(node, 'keyContent', true), mkReplaceOrAdd(node, 'humanConfirmed', true)],
    desc: `markKeyContent ${node.id}`,
  };
}

function opMoveNode(doc, rng) {
  const sections = allNodes(doc).filter((n) => n.type === 'section');
  if (sections.length < 2) return null;
  const candidates = allNodes(doc).filter((n) => n.parentId && n.type !== 'section' && n.id !== doc.rootId);
  const node = pick(rng, candidates);
  if (!node) return null;
  const targets = sections.filter((s) => s.id !== node.parentId);
  const parent = pick(rng, targets);
  if (!parent) return null;
  const order = nextOrder(doc, parent.id);
  const next = clone(doc);
  next.nodes[node.id].parentId = parent.id;
  next.nodes[node.id].order = order;
  return {
    revOp: 'move',
    targetId: node.id,
    newDoc: next,
    patch: [{ op: 'replace', path: `/nodes/${node.id}/parentId`, value: parent.id }, { op: 'replace', path: `/nodes/${node.id}/order`, value: order }],
    desc: `moveNode ${node.id} → ${parent.id}`,
  };
}

function opDeleteNode(doc, rng) {
  const candidates = allNodes(doc).filter(
    (n) => n.id !== doc.rootId && n.keyContent !== true && n.type !== 'signatureBlock' && n.type !== 'document' && isLeaf(doc, n.id),
  );
  const node = pick(rng, candidates);
  if (!node) return null;
  const next = clone(doc);
  delete next.nodes[node.id];
  const patch = [{ op: 'remove', path: `/nodes/${node.id}` }];
  const mr = next.machineReadable;
  if (mr && Array.isArray(mr.dataElements)) {
    const filtered = mr.dataElements.filter((de) => de.nodeId !== node.id);
    if (filtered.length !== mr.dataElements.length) {
      mr.dataElements = filtered;
      patch.push({ op: 'replace', path: '/machineReadable/dataElements', value: clone(filtered) });
    }
  }
  return { revOp: 'delete', targetId: node.id, newDoc: next, patch, desc: `deleteNode ${node.id}` };
}

let aiCounter = 0;
function opAiAddNode(doc, rng, at) {
  const paragraphs = allNodes(doc).filter((n) => n.type === 'paragraph');
  const parent = pick(rng, paragraphs);
  if (!parent) return null;
  aiCounter += 1;
  const id = `n_ai_${aiCounter}`;
  if (doc.nodes[id]) return null;
  const node = {
    id,
    type: 'text',
    parentId: parent.id,
    order: nextOrder(doc, parent.id),
    rev: 1,
    humanConfirmed: true,
    runs: [{ text: `AI 生成的评估语句 ${aiCounter}` }],
    provenance: {
      origin: 'ai',
      modelId: 'local/qwen-med:7b@2026-09',
      promptId: 'tpl-assessment-v3',
      confidence: 0.95,
      acceptedBy: 'DR_TEST',
      acceptedAt: at,
      at,
    },
  };
  const next = clone(doc);
  next.nodes[id] = node;
  return { revOp: 'accept-ai', targetId: id, newDoc: next, patch: [{ op: 'add', path: `/nodes/${id}`, value: clone(node) }], desc: `aiAddNode ${id} → ${parent.id}` };
}

const OPS = [
  ['insertText', opInsertText, 3],
  ['replaceText', opReplaceText, 2],
  ['updateProps', opUpdateProps, 2],
  ['setFieldValue', opSetFieldValue, 3],
  ['markKeyContent', opMarkKeyContent, 1],
  ['moveNode', opMoveNode, 2],
  ['deleteNode', opDeleteNode, 2],
  ['aiAddNode', opAiAddNode, 2],
];

function weightedPick(rng) {
  const total = OPS.reduce((s, [, , w]) => s + w, 0);
  let r = rng() * total;
  for (const [name, fn, w] of OPS) {
    r -= w;
    if (r <= 0) return [name, fn];
  }
  return [OPS[0][0], OPS[0][1]];
}

function runOne(doc, args) {
  const checks = [];
  const add = (id, name, pass, critical, detail, hint) => checks.push({ id, name, pass, critical, detail, hint });

  const rng = makeRng(args.seed);
  aiCounter = 0;

  let current = clone(doc);
  current.status = 'draft';
  const snapshots = [clone(current)];
  const boundaries = [];
  const replayPatches = [];
  const revisions = [];
  const touched = new Set();
  const deleted = new Set();
  const added = new Set();
  const stepErrors = { D1: [], D2: [] };
  const log = [];

  const baseTime = Date.parse(doc.updatedAt || doc.createdAt || new Date().toISOString());

  for (let step = 1; step <= args.steps; step += 1) {
    const at = new Date(baseTime + step * 60000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const [name, fn] = weightedPick(rng);
    const r = fn(current, rng, at);
    if (!r) {
      log.push({ step, skipped: name });
      continue;
    }

    /* D2：手写 patch 必须精确还原本次变更（最易出 bug 的一项） */
    try {
      const rebuilt = applyPatch(current, r.patch);
      if (!deepEqual(rebuilt, r.newDoc)) {
        stepErrors.D2.push({ step, op: name, reason: 'applyPatch(prev, patch) 与操作结果不一致', patch: r.patch });
      }
    } catch (err) {
      stepErrors.D2.push({ step, op: name, reason: `applyPatch 抛错：${err.message}`, patch: r.patch });
    }

    const next = clone(r.newDoc);
    next.updatedAt = at;
    if (next.machineReadable) next.machineReadable.generatedAt = at;
    const rev = { rev: revisions.length + 1, at, actorId: name.startsWith('ai') ? 'ai-pipeline' : 'DR_TEST', op: r.revOp, targetId: r.targetId, patch: clone(r.patch) };
    revisions.push(rev);
    next.revisions = clone(revisions);

    const d = jsonDiff(current, next);
    try {
      const rebuilt = applyPatch(current, d);
      if (!deepEqual(rebuilt, next)) stepErrors.D1.push({ step, op: name, reason: 'jsonDiff→applyPatch 与目标状态不一致', ops: d.length });
    } catch (err) {
      stepErrors.D1.push({ step, op: name, reason: `applyPatch 抛错：${err.message}`, ops: d.length });
    }
    replayPatches.push(...d);

    touched.add(r.targetId);
    if (r.revOp === 'delete') deleted.add(r.targetId);
    if (name === 'aiAddNode') added.add(r.targetId);

    log.push({ step, op: name, desc: r.desc, patchOps: r.patch.length });
    current = next;
    snapshots.push(clone(current));
    boundaries.push(replayPatches.length);
  }

  const verifyPatches = replayPatches.map((p) => clone(p));
  if (args.injectDropPatch > 0 && args.injectDropPatch <= verifyPatches.length) verifyPatches.splice(args.injectDropPatch - 1, 1);
  if (args.injectCorruptPatch && verifyPatches.length > 0) {
    const last = verifyPatches[verifyPatches.length - 1];
    if ('value' in last) last.value = '__CORRUPTED__';
    else last.path = `${last.path}/__corrupted__`;
  }
  const verifyRevisions = revisions.map((r) => clone(r));
  if (args.injectDropRevision > 0 && args.injectDropRevision <= verifyRevisions.length) verifyRevisions.splice(args.injectDropRevision - 1, 1);
  const verifyFinal = clone(current);
  if (args.injectRenumber) {
    const id = Object.keys(verifyFinal.nodes).find((k) => k !== verifyFinal.rootId);
    if (id) verifyFinal.nodes[`${id}_v2`] = verifyFinal.nodes[id];
  }
  if (args.injectStripProvenance) {
    const untouched = Object.keys(verifyFinal.nodes).find((k) => !touched.has(k) && k !== verifyFinal.rootId);
    if (untouched) delete verifyFinal.nodes[untouched].provenance;
  }

  add('D1', 'diff → apply 往返一致（patch 引擎自洽）', stepErrors.D1.length === 0, true, stepErrors.D1.length === 0 ? `校验 ${replayPatches.length} 条 patch` : `${stepErrors.D1.length} 步失败`, stepErrors.D1[0] ? `首例：step ${stepErrors.D1[0].step} ${stepErrors.D1[0].op} ${stepErrors.D1[0].reason}` : undefined);

  add('D2', '手写 patch 精确还原状态', stepErrors.D2.length === 0, true, stepErrors.D2.length === 0 ? '全部操作 patch 与真实变更一致' : `${stepErrors.D2.length} 步不一致`, stepErrors.D2[0] ? `首例：step ${stepErrors.D2[0].step} ${stepErrors.D2[0].op} ${stepErrors.D2[0].reason}` : undefined);

  const revIssues = [];
  const validOps = new Set(['create', 'insert', 'update', 'delete', 'move', 'accept-ai', 'reject-ai', 'sign', 'import', 'migrate', 'external']);
  const mutatingOps = new Set(['create', 'insert', 'update', 'delete', 'move', 'accept-ai', 'import', 'migrate', 'external']);
  verifyRevisions.forEach((rv, i) => {
    if (rv.rev !== i + 1) revIssues.push(`第 ${i + 1} 条 rev=${rv.rev}（应为 ${i + 1}）`);
    if (!validOps.has(rv.op)) revIssues.push(`第 ${i + 1} 条 op 非法：${rv.op}`);
    if (!rv.targetId) revIssues.push(`第 ${i + 1} 条缺少 targetId`);
    if (!rv.at) revIssues.push(`第 ${i + 1} 条缺少时间戳`);
    if (mutatingOps.has(rv.op) && (!Array.isArray(rv.patch) || rv.patch.length === 0)) {
      revIssues.push(`第 ${i + 1} 条（${rv.op}）缺少 patch`);
    }
  });
  add('D3', '留痕链完整（rev 连续 / op / targetId）', revIssues.length === 0, true, revIssues.length === 0 ? `${verifyRevisions.length} 条留痕全部合法` : `${revIssues.length} 处问题`, revIssues[0]);

  let replayOk = true;
  let replayDetail = `重放 ${verifyPatches.length} 条 patch，逐步校验 ${boundaries.length} 个检查点`;
  try {
    let state = clone(snapshots[0]);
    let cursor = 0;
    for (let i = 0; i < boundaries.length; i += 1) {
      state = applyPatch(state, verifyPatches.slice(cursor, boundaries[i]));
      cursor = boundaries[i];
      if (!deepEqual(state, snapshots[i + 1])) {
        replayOk = false;
        replayDetail = `第 ${i + 1} 个校验点状态与快照不一致（该点之前有 patch 缺失或被覆盖）`;
        break;
      }
    }
    if (replayOk && !deepEqual(state, verifyFinal)) {
      replayOk = false;
      replayDetail = '重放终态与最终文档不一致';
    }
  } catch (err) {
    replayOk = false;
    replayDetail = `重放抛错：${err.message}`;
  }
  add('D4', '全量重放确定性（含逐步校验点）', replayOk, true, replayDetail, replayOk ? undefined : `seed=${args.seed}（用同种子可复现）`);

  const provIssues = [];
  for (const [id, node] of Object.entries(doc.nodes)) {
    if (touched.has(id) || !verifyFinal.nodes[id]) continue;
    if (!verifyFinal.nodes[id].provenance) {
      provIssues.push(`${id} 未被子操作却丢失 provenance`);
      continue;
    }
    if (!deepEqual(node.provenance, verifyFinal.nodes[id].provenance)) provIssues.push(`${id} 未被子操作却 provenance 变更`);
  }
  for (const [id, node] of Object.entries(verifyFinal.nodes)) {
    if (node?.provenance?.origin === 'ai' && (!node.provenance.modelId || typeof node.provenance.confidence !== 'number')) {
      provIssues.push(`${id} 为 AI 节点但缺少 modelId/confidence`);
    }
  }
  add('D5', '来源标记保留（未操作节点逐字节不变）', provIssues.length === 0, true, provIssues.length === 0 ? `${Object.keys(doc.nodes).length} 个基线节点来源标记稳定` : `${provIssues.length} 处问题`, provIssues[0]);

  const baseIds = new Set(Object.keys(doc.nodes));
  const finalIds = new Set(Object.keys(verifyFinal.nodes));
  const idIssues = [];
  for (const id of baseIds) if (!deleted.has(id) && !finalIds.has(id)) idIssues.push(`基线节点 ${id} 未删除却消失（疑似重编号）`);
  for (const id of deleted) if (finalIds.has(id)) idIssues.push(`已删除 id ${id} 被复用`);
  for (const id of finalIds) if (!baseIds.has(id) && !added.has(id)) idIssues.push(`出现未登记的新 id ${id}`);
  add('D6', '节点 ID 稳定性（不重编号 / 不复用）', idIssues.length === 0, true, idIssues.length === 0 ? `id 集合一致（新增 ${added.size} 个，删除 ${deleted.size} 个）` : `${idIssues.length} 处问题`, idIssues[0]);

  const failed = checks.filter((c) => c.critical && !c.pass);
  return { checks, log, steps: args.steps, verdict: failed.length === 0 ? 'PASS' : 'FAIL', counts: { patches: replayPatches.length, revisions: revisions.length, added: added.size, deleted: deleted.size } };
}

function collectJsonFiles(input) {
  const st = statSync(input);
  if (st.isDirectory()) return readdirSync(input).filter((f) => f.toLowerCase().endsWith('.json')).map((f) => resolve(input, f));
  return [resolve(input)];
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
  for (const file of files) {
    let doc;
    try {
      doc = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    } catch (err) {
      results.push({ file, verdict: 'FAIL', checks: [{ id: 'D0', name: 'JSON 解析', pass: false, critical: true, detail: err.message }], log: [] });
      continue;
    }
    if (!doc || !isPlainObject(doc.nodes) || !doc.rootId) {
      results.push({ file, skipped: true, skipReason: '缺少 nodes 或 rootId，已跳过', checks: [], log: [] });
      continue;
    }
    results.push({ file, ...runOne(doc, args) });
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
    w(`随机操作 ${r.steps} 步 | patch ${r.counts?.patches ?? 0} 条 | 留痕 ${r.counts?.revisions ?? 0} 条 | 新增 ${r.counts?.added ?? 0} 删除 ${r.counts?.deleted ?? 0}（seed=${args.seed}）`);
    for (const c of r.checks) {
      w(`${c.pass ? 'PASS' : 'FAIL'}  [${c.id}] ${c.name}${c.critical ? '' : '  (非关键)'}`);
      w(`      ${c.detail}`);
      if (c.hint) w(`      提示: ${c.hint}`);
    }
    if (args.verbose) {
      w('  操作明细：');
      r.log.forEach((l) => w(`    ${l.skipped ? `step ${l.step} 跳过(${l.skipped})` : `step ${l.step} ${l.desc}（patch ${l.patchOps} 条）`}`));
    }
    w(`结论：${r.verdict}`);
  }

  const failed = results.filter((r) => r.verdict === 'FAIL');
  w('');
  w('─'.repeat(72));
  w(`文件数：${results.length}    通过：${results.filter((r) => r.verdict === 'PASS').length}    失败：${failed.length}    跳过：${results.filter((r) => r.verdict === 'SKIP').length}`);
  w('本脚本只验证"节点/留痕/回放"一致性，不覆盖渲染与打印一致性。');
  w('');
  process.stdout.write(out.join('\n'));

  if (args.report) {
    writeFileSync(
      args.report,
      `${JSON.stringify({ tool: 'node-diff-check', version: '1.0.0', generatedAt: new Date().toISOString(), seed: args.seed, steps: args.steps, results, verdict: failed.length === 0 ? 'PASS' : 'FAIL' }, null, 2)}\n`,
      'utf8',
    );
    process.stdout.write(`报告已写入：${args.report}\n`);
  }

  process.exit(failed.length === 0 ? 0 : 1);
}

main();
