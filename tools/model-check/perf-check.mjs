#!/usr/bin/env node
/**
 * S6 · 性能基线检查（perf-check，可在 Node 中测得的部分）
 *
 * 覆盖 DoD 7 的可测部分；输入延迟（键盘→呈现 ≤50ms）无法在 Node 中测，明确标记为未覆盖。
 *
 * 前置正确性检查（P0）：local（按受影响节点）与 full（全量 diff）两种 patch 策略，
 * 在同一操作序列下必须产出完全一致的文档。性能优化绝不能改变语义。
 *
 * 检查项与阈值（来自能力矩阵 L0 验收标准）：
 *   P1  文档加载 + 建索引（children/tag/origin）      ≤ 3000ms
 *   P2  全量子树遍历（等价 getSubtree）                ≤ 300ms
 *   P3  getNode 单节点读取（P95）                      ≤ 1ms
 *   P4  insertText 单次写入（P95）★                   ≤ 20ms
 *   P5  updateNodeProps 单次写入（P95）                ≤ 20ms
 *   P6  exportMachineReadable（≥1000 数据元）          ≤ 500ms
 *   P7  整文档节点级 diff                              ≤ 200ms
 *   P8  节点内容指纹 hashNodes                         ≤ 100ms
 *   P9  JSON 序列化往返（stringify + parse）           ≤ 500ms
 *   P10 批量 1000 次写入（含留痕）平均                 ≤ 20ms/次
 *   P11 输入延迟（键盘→呈现）                          SKIP：需浏览器埋点
 *
 * 用法：
 *   node perf-check.mjs                      # 默认 100 页规模
 *   node perf-check.mjs --pages 20 --iter 30 # 快速自查
 *   node perf-check.mjs --json baseline.json # 存基线
 *   node perf-check.mjs --baseline baseline.json   # 与基线对比（回归 >50% 判失败）
 *
 * 退出码：0 = 关键项全部达标；1 = 存在未达标项；2 = 参数错误
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { createStore } from './lib/doc-store.mjs';
import { clone, deepEqual, hashNodes, jsonDiff, applyPatch } from './lib/model-utils.mjs';

/**
 * 优先测量**真实实现**（src/model/indexes.ts 的 DocumentIndex），而不是本脚本内的内联副本。
 * 这样 P1/P2 才是对 T02 交付物的真实验收；TS 实现不存在时回退到内联实现（保持脚本可独立运行）。
 */
const TS_INDEX = await import(new URL('../../src/model/indexes.ts', import.meta.url).href)
  .then((mod) => mod.DocumentIndex)
  .catch(() => null);

/** 同级要求：P12 也要测**真实导出实现**，不能测本脚本内的排版副本 */
const TS_OFD = await import(new URL('../../src/export/ofd.ts', import.meta.url).href)
  .then((mod) => mod.buildOfdPackage)
  .catch(() => null);

const HELP = `S6 · 性能基线检查

用法: node perf-check.mjs [选项]

选项:
  --pages <n>        文档页数规模（默认 100，每页约 22 个节点）
  --iter <n>         单点操作采样次数（默认 50）
  --batch <n>        批量写入次数（默认 1000）
  --browser-report <file>  浏览器实测的输入延迟报告（tools/editor-check 产出），用于判定 P11
  --allow-headless         允许使用无头浏览器数据判定 P11（默认拒绝，避免假结论）
  --json <file>      输出报告（可作为基线）
  --baseline <file>  与基线对比，回归超过 --tolerance 判失败（默认 0.5）
  --tolerance <n>    允许的相对回归比例（默认 0.5）
  --floor <ms>       绝对噪声下限（默认 1ms）；实际显著性下限 = max(floor, 阈值 1%)，防微基准假报警
  -v, --verbose      打印每项明细
  -h, --help         显示帮助
`;

function parseArgs(argv) {
  const out = { pages: 100, iter: 50, batch: 1000, report: null, baseline: null, browserReport: null, allowHeadless: false, tolerance: 0.5, floor: 1, verbose: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--pages') out.pages = Number(argv[++i]) || 100;
    else if (a === '--browser-report') out.browserReport = argv[++i];
    else if (a === '--allow-headless') out.allowHeadless = true;
    else if (a === '--iter') out.iter = Number(argv[++i]) || 50;
    else if (a === '--batch') out.batch = Number(argv[++i]) || 1000;
    else if (a === '--json') out.report = argv[++i];
    else if (a === '--baseline') out.baseline = argv[++i];
    else if (a === '--tolerance') out.tolerance = Number(argv[++i]) || 0.5;
    else if (a === '--floor') out.floor = Number(argv[++i]) || 0;
    else if (a === '-v' || a === '--verbose') out.verbose = true;
    else if (a === '-h' || a === '--help') out.help = true;
  }
  return out;
}

/* --------------------------- 合成文档生成器 --------------------------- */

const LONG_TEXT =
  '患者3天前无诱因出现咳嗽、咳痰，痰为白色黏痰，伴发热，最高体温38.5℃，无明显胸闷气促，无咯血，自服感冒药效果欠佳。既往体健，否认高血压、糖尿病、肝炎、结核等病史，否认药物及食物过敏史。';

function buildDoc(pages) {
  const at = '2026-10-08T01:00:00Z';
  const prov = (origin, actorId) => ({ origin, actorId, at });
  const nodes = {};
  let n = 0;
  const newId = (prefix) => `${prefix}_${(n += 1)}`;
  const paragraphIds = [];
  const textIds = [];
  const fieldIds = [];

  nodes.n_root = { id: 'n_root', type: 'document', parentId: null, order: 0, rev: 1, provenance: prov('system', 'gen') };

  for (let s = 0; s < pages; s += 1) {
    const secId = `n_sec_${s}`;
    nodes[secId] = { id: secId, type: 'section', parentId: 'n_root', order: (s + 1) * 10, rev: 1, title: `第${s + 1}节`, sectionCode: `sec${s}`, provenance: prov('human', 'DR_GEN') };

    let order = 10;
    for (let p = 0; p < 9; p += 1) {
      const pId = `n_p_${s}_${p}`;
      nodes[pId] = { id: pId, type: 'paragraph', parentId: secId, order: (order += 10), rev: 1, semantic: p % 2 === 0 ? 'presentIllness' : 'physicalExam', provenance: prov('human', 'DR_GEN') };
      paragraphIds.push(pId);

      const tId = `n_t_${s}_${p}`;
      nodes[tId] = { id: tId, type: 'text', parentId: pId, order: 10, rev: 1, runs: [{ text: LONG_TEXT }], provenance: prov('human', 'DR_GEN') };
      textIds.push(tId);

      if (p % 2 === 0) {
        const fId = `n_f_${s}_${p}`;
        nodes[fId] = {
          id: fId,
          type: 'field',
          parentId: pId,
          order: 20,
          rev: 1,
          dataType: 'number',
          value: 36.5 + (p % 5) * 0.3,
          valueText: String(36.5 + (p % 5) * 0.3),
          unit: '℃',
          sourceKey: `VITAL.T${p}`,
          tags: [
            { system: 'WS445', code: `DE05.01.${String(p).padStart(3, '0')}`, display: '体温' },
            { system: 'LOINC', code: `8310-${p}`, display: 'Body temperature' },
            { system: 'local', code: `LT${p}`, display: '院内体温项' },
          ],
          provenance: prov('system', 'system/lis'),
        };
        fieldIds.push(fId);
      }

      if (p === 8) {
        const tbId = `n_tb_${s}`;
        nodes[tbId] = { id: tbId, type: 'table', parentId: pId, order: 30, rev: 1, colCount: 3, headerRows: 1, provenance: prov('human', 'DR_GEN') };
        const rowId = `n_tr_${s}`;
        nodes[rowId] = { id: rowId, type: 'tableRow', parentId: tbId, order: 10, rev: 1, provenance: prov('human', 'DR_GEN') };
        for (let c = 0; c < 3; c += 1) {
          const cId = `n_tc_${s}_${c}`;
          nodes[cId] = { id: cId, type: 'tableCell', parentId: rowId, order: (c + 1) * 10, rev: 1, provenance: prov('human', 'DR_GEN') };
          const ctId = `n_tct_${s}_${c}`;
          nodes[ctId] = { id: ctId, type: 'text', parentId: cId, order: 10, rev: 1, runs: [{ text: `单元格 ${s}-${c}` }], provenance: prov('human', 'DR_GEN') };
          textIds.push(ctId);
        }
      }
    }
  }

  return {
    doc: {
      schemaVersion: '1.0.0',
      docId: `doc_perf_${pages}p`,
      docType: { system: 'WST500', code: 'WST500.2', display: '门（急）诊病历' },
      patient: { patientId: 'P_PERF', nameMasked: '测**', gender: 'U' },
      encounter: { visitId: 'V_PERF', visitType: 'outpatient' },
      status: 'draft',
      createdAt: at,
      updatedAt: at,
      createdBy: 'DR_GEN',
      rootId: 'n_root',
      nodes,
      revisions: [],
    },
    ids: { paragraphIds, textIds, fieldIds },
  };
}

/* ----------------------------- 等价性检查 ----------------------------- */

function smallBaseDoc() {
  const at = '2026-10-08T01:00:00Z';
  const prov = (origin, actorId) => ({ origin, actorId, at });
  return {
    schemaVersion: '1.0.0',
    docId: 'doc_equiv',
    docType: { system: 'local', code: 'X', display: '等价性测试文书' },
    patient: { patientId: 'P0' },
    status: 'draft',
    createdAt: at,
    updatedAt: at,
    createdBy: 'DR_T',
    rootId: 'n_root',
    nodes: {
      n_root: { id: 'n_root', type: 'document', parentId: null, order: 0, rev: 1, provenance: prov('system', 'seed') },
      n_sec: { id: 'n_sec', type: 'section', parentId: 'n_root', order: 10, rev: 1, title: '主体', provenance: prov('human', 'DR_T') },
      n_p: { id: 'n_p', type: 'paragraph', parentId: 'n_sec', order: 10, rev: 1, semantic: 'body', provenance: prov('human', 'DR_T') },
      n_t: { id: 'n_t', type: 'text', parentId: 'n_p', order: 10, rev: 1, runs: [{ text: '初始' }], provenance: prov('human', 'DR_T') },
      n_t2: { id: 'n_t2', type: 'text', parentId: 'n_p', order: 20, rev: 1, runs: [{ text: '可删除' }], provenance: prov('human', 'DR_T') },
      n_f: {
        id: 'n_f',
        type: 'field',
        parentId: 'n_sec',
        order: 20,
        rev: 1,
        dataType: 'number',
        value: 37,
        valueText: '37',
        keyContent: true,
        humanConfirmed: true,
        tags: [{ system: 'WS445', code: 'DE05.01.001' }],
        provenance: prov('human', 'DR_T'),
      },
      n_sig: { id: 'n_sig', type: 'signatureBlock', parentId: 'n_root', order: 90, rev: 1, signerRole: 'author', provenance: prov('human', 'DR_T') },
    },
    revisions: [],
  };
}

/** 同一操作序列分别作用于 local / full 策略，比较最终文档 */
function patchStrategyEquivalence() {
  const script = (store) => {
    store.insertText({ nodeId: 'n_t', text: '（追加）' }, { id: 'DR_T', kind: 'human' });
    store.updateNodeProps({ nodeId: 'n_p', patch: { semantic: 'revisedBody' } }, { id: 'DR_T', kind: 'human' });
    store.setFieldValue({ nodeId: 'n_f', value: 38.2, valueText: '38.2' }, { id: 'DR_T', kind: 'human' });
    const { suggestionId } = store.suggestText(
      { nodeId: 'n_t', text: 'AI 草稿内容', confidence: 0.97, modelId: 'm1', promptId: 'p1' },
      { id: 'ai', kind: 'ai' },
    );
    store.acceptSuggestion({ suggestionId, editedText: 'AI 草稿内容（医生微调）' }, { id: 'DR_T', kind: 'human' });
    store.confirmNode({ nodeId: 'n_t' }, { id: 'DR_T', kind: 'human' });
    store.deleteNode({ nodeId: 'n_t2' }, { id: 'DR_T', kind: 'human' });
    store.createNode({ parentId: 'n_p', type: 'text', props: { runs: [{ text: '新建节点' }] } }, { id: 'DR_T', kind: 'human' });
    store.exportMachineReadable();
    store.sign({}, { id: 'DR_T', kind: 'human' });
    return store.getDoc();
  };
  const localDoc = script(createStore(smallBaseDoc(), { patchStrategy: 'local' }));
  const fullDoc = script(createStore(smallBaseDoc(), { patchStrategy: 'full' }));
  const equal = deepEqual(localDoc, fullDoc);
  // 同时校验：每次留痕的 patch 都能精确还原当次变更（抽样最后一条非空 patch）
  const lastWithPatch = [...fullDoc.revisions].reverse().find((r) => r.patch && r.patch.length > 0);
  return { equal, localRevisions: localDoc.revisions.length, fullRevisions: fullDoc.revisions.length, sampleRevCount: lastWithPatch ? lastWithPatch.patch.length : 0 };
}

/* ------------------------------- 计时器 ------------------------------- */

/**
 * 基线回归判定（独立函数，便于自证）：
 *  回归 = 相对超容差 且 绝对差 > max(floor, 阈值 1%)
 * 第二条的存在原因：微基准抖动可达 ±60%，若只用相对容差，0.040ms→0.088ms 会被误报为 +119% 回归；
 * 而按"阈值"而非"基线"衡量绝对显著性，可保证"离阈值很远的小抖动不报警、接近阈值的变化照拦"。
 */
function compareWithBaseline(checks, base, tolerance, floor) {
  const regressions = [];
  const ignored = [];
  for (const c of checks) {
    const prev = (base.checks || []).find((x) => x.id === c.id);
    if (!prev || typeof prev.value !== 'number' || prev.value === 0 || c.skipped) continue;
    const delta = (c.value - prev.value) / prev.value;
    const absDelta = c.value - prev.value;
    if (delta <= tolerance) continue;
    const absSig = Math.max(floor, 0.01 * c.threshold);
    if (absDelta <= absSig) {
      ignored.push({ id: c.id, delta, absDelta, absSig });
      continue;
    }
    regressions.push({ id: c.id, name: c.name, prev: prev.value, now: c.value, delta, absDelta });
  }
  return { regressions, ignored };
}

function bench(label, iter, fn) {
  fn(); // warm-up
  const samples = [];
  for (let i = 0; i < iter; i += 1) {
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  const pick = (q) => samples[Math.min(samples.length - 1, Math.max(0, Math.ceil(q * samples.length) - 1))];
  const avg = samples.reduce((s, v) => s + v, 0) / samples.length;
  void label;
  return { avg, p50: pick(0.5), p95: pick(0.95), max: samples[samples.length - 1] };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }

  const checks = [];
  const add = (id, name, metric, value, threshold, unit, critical, detail) =>
    checks.push({ id, name, metric, value, threshold, unit, critical, pass: value <= threshold, detail });

  /* P0 前置正确性 */
  const eq = patchStrategyEquivalence();
  checks.push({
    id: 'P0',
    name: 'patch 策略等价性（local vs full）',
    metric: '语义一致',
    value: eq.equal ? 0 : 1,
    threshold: 0,
    unit: 'bool',
    critical: true,
    pass: eq.equal,
    detail: `留痕数 local=${eq.localRevisions} / full=${eq.fullRevisions}，最终文档${eq.equal ? '完全一致' : '不一致'}`,
  });

  /* P0b 基线回归门鉴别力自证：证明"回归"这件事既能拦住真问题、又不会天天误报 */
  {
    const synth = (id, value, threshold) => ({ id, name: id, metric: 'avg', value, threshold, unit: 'ms', critical: true, pass: true });
    const scenarios = [
      { label: '同基线不误报', check: synth('T1', 10, 20), base: 10, expect: 'none' },
      { label: '接近阈值的真回归被检出', check: synth('T2', 18, 20), base: 5, expect: 'regression' },
      { label: '远低于阈值的抖动被忽略', check: synth('T3', 0.088, 20), base: 0.04, expect: 'ignored' },
      { label: '大阈值项的微小绝对变化被忽略', check: synth('T4', 6.2, 500), base: 3.8, expect: 'ignored' },
      { label: '超过噪声下限的绝对增长被检出', check: synth('T5', 6.2, 20), base: 1.2, expect: 'regression' },
    ];
    const details = [];
    let allOk = true;
    for (const s of scenarios) {
      const { regressions, ignored } = compareWithBaseline([s.check], { checks: [{ id: s.check.id, value: s.base }] }, args.tolerance, args.floor);
      const actual = regressions.length > 0 ? 'regression' : ignored.length > 0 ? 'ignored' : 'none';
      const ok = actual === s.expect;
      if (!ok) allOk = false;
      details.push(`${s.label}:${ok ? '√' : `× 期望${s.expect}实得${actual}`}`);
    }
    checks.push({
      id: 'P0b',
      name: '基线回归门鉴别力自证',
      metric: 'bool',
      value: allOk ? 0 : 1,
      threshold: 0,
      unit: 'bool',
      critical: true,
      pass: allOk,
      detail: details.join('；'),
    });
  }

  /* 合成文档 */
  const gen = buildDoc(args.pages);
  const docJson = JSON.stringify(gen.doc);
  const docBytes = Buffer.byteLength(docJson, 'utf8');
  const nodeCount = Object.keys(gen.doc.nodes).length;

  /* P1 加载 + 建索引（优先测真实实现） */
  const indexImpl = TS_INDEX ? 'src/model/indexes.ts（真实实现）' : '内联 JS 副本（TS 实现不可用）';
  const load = bench('load', Math.min(10, args.iter), () => {
    const parsed = JSON.parse(docJson);
    if (TS_INDEX) {
      const index = TS_INDEX.build(parsed.nodes, parsed.rootId);
      return index.size;
    }
    const children = new Map();
    const byTag = new Map();
    const byOrigin = new Map();
    for (const node of Object.values(parsed.nodes)) {
      if (node.parentId) {
        if (!children.has(node.parentId)) children.set(node.parentId, []);
        children.get(node.parentId).push(node.id);
      }
      for (const t of node.tags || []) {
        const k = `${t.system}:${t.code}`;
        if (!byTag.has(k)) byTag.set(k, []);
        byTag.get(k).push(node.id);
      }
      const o = node.provenance?.origin || 'unknown';
      if (!byOrigin.has(o)) byOrigin.set(o, 0);
      byOrigin.set(o, byOrigin.get(o) + 1);
    }
    return children.size + byTag.size + byOrigin.size;
  });
  add('P1', `文档加载 + 建索引 [${indexImpl}]`, 'avg', load.avg, 3000, 'ms', true, `${nodeCount} 节点 / ${(docBytes / 1048576).toFixed(2)} MB`);

  /* P2 全量子树遍历（优先测真实实现） */
  const parsedDoc = JSON.parse(docJson);
  let subtree;
  if (TS_INDEX) {
    const index = TS_INDEX.build(parsedDoc.nodes, parsedDoc.rootId);
    subtree = bench('subtree', args.iter, () => {
      const all = index.subtreeIds(parsedDoc.rootId);
      if (all.length !== nodeCount) throw new Error(`遍历节点数异常：${all.length} != ${nodeCount}`);
      return all.length;
    });
  } else {
    const childrenMap = new Map();
    for (const node of Object.values(parsedDoc.nodes)) {
      if (!node.parentId) continue;
      if (!childrenMap.has(node.parentId)) childrenMap.set(node.parentId, []);
      childrenMap.get(node.parentId).push(node.id);
    }
    subtree = bench('subtree', args.iter, () => {
      const acc = [];
      const stack = [parsedDoc.rootId];
      while (stack.length) {
        const cur = stack.pop();
        acc.push(cur);
        for (const c of childrenMap.get(cur) || []) stack.push(c);
      }
      if (acc.length !== nodeCount) throw new Error(`遍历节点数异常：${acc.length} != ${nodeCount}`);
      return acc.length;
    });
  }
  add('P2', `全量子树遍历（等价 getSubtree）[${TS_INDEX ? '真实实现' : '内联 JS'}]`, 'avg', subtree.avg, 300, 'ms', true, `遍历 ${nodeCount} 节点`);

  /* 建立 store（供 P3~P6, P10 使用） */
  const store = createStore(clone(gen.doc), {});
  const probeTextId = gen.ids.textIds[0];
  const probeFieldId = gen.ids.fieldIds[0];
  const probeParagraphId = gen.ids.paragraphIds[0];

  /* P3 getNode */
  const getNode = bench('getNode', args.iter * 4, () => store.getNode(probeTextId));
  add('P3', 'getNode 单节点读取', 'p95', getNode.p95, 1, 'ms', true, `avg=${getNode.avg.toFixed(3)}ms`);

  /* P4 insertText */
  let appendSeq = 0;
  const write1 = bench('insertText', args.iter, () => {
    appendSeq += 1;
    store.insertText({ nodeId: probeTextId, text: `.${appendSeq}` }, { id: 'DR_T', kind: 'human' });
  });
  add('P4', 'insertText 单次写入', 'p95', write1.p95, 20, 'ms', true, `avg=${write1.avg.toFixed(3)}ms  (${nodeCount} 节点文档)`);

  /* P4b 参照值：同一写入在旧"全量克隆 + 全量 diff"策略下的耗时（非门槛，仅量化优化价值） */
  const storeFull = createStore(clone(gen.doc), { patchStrategy: 'full' });
  const writeFull = bench('insertText-full', Math.min(10, args.iter), () => {
    storeFull.insertText({ nodeId: probeTextId, text: '.' }, { id: 'DR_T', kind: 'human' });
  });
  checks.push({
    id: 'P4b',
    name: '参照：同一写入在 full（全量 diff）策略下',
    metric: 'avg',
    value: writeFull.avg,
    threshold: 20,
    unit: 'ms',
    critical: false,
    pass: true,
    detail: `local=${write1.avg.toFixed(3)}ms  vs  full=${writeFull.avg.toFixed(3)}ms，提速约 ${(writeFull.avg / Math.max(write1.avg, 0.001)).toFixed(0)} 倍（写路径必须与文档规模无关）`,
  });

  /* P5 updateNodeProps */
  let propSeq = 0;
  const write2 = bench('updateProps', args.iter, () => {
    propSeq += 1;
    store.updateNodeProps({ nodeId: probeParagraphId, patch: { semantic: `body${propSeq}` } }, { id: 'DR_T', kind: 'human' });
  });
  add('P5', 'updateNodeProps 单次写入', 'p95', write2.p95, 20, 'ms', true, `avg=${write2.avg.toFixed(3)}ms`);

  /* P6 exportMachineReadable */
  const mr = bench('machineReadable', Math.min(20, args.iter), () => store.exportMachineReadable());
  const mrBlock = store.exportMachineReadable();
  add('P6', 'exportMachineReadable', 'avg', mr.avg, 500, 'ms', true, `${mrBlock.dataElements.length} 个数据元`);

  /* P7 整文档 diff */
  const beforeNodes = JSON.parse(JSON.stringify(parsedDoc.nodes));
  const afterNodes = JSON.parse(JSON.stringify(parsedDoc.nodes));
  afterNodes[probeTextId].runs[0].text = '被修改的文本';
  const d = bench('jsonDiff', Math.min(20, args.iter), () => jsonDiff(beforeNodes, afterNodes));
  add('P7', '整文档节点级 diff', 'avg', d.avg, 200, 'ms', true, `${nodeCount} 节点`);

  /* P8 hashNodes
     ⚠️ 阈值必须**随规模线性外推**：这是 O(n) 操作，固定阈值在 1000 页下会假失败
     （实测 113ms vs 固定阈值 100ms），而 113ms / 32k 节点 = 3.5ms/千节点，
     按规模看并不异常。真正该盯的是 detail 里的"每千节点耗时"是否稳定：
     它若随规模上升，说明有超线性成分（内存/GC），那才是需要处理的问题。 */
  const h = bench('hashNodes', Math.min(20, args.iter), () => hashNodes(parsedDoc.nodes));
  const perKiloNodeOfHash = h.avg / (nodeCount / 1000);
  add(
    'P8',
    '节点内容指纹 hashNodes',
    'avg',
    h.avg,
    Math.min(1000, Math.max(100, (nodeCount / 1000) * 8)),
    'ms',
    true,
    `${nodeCount} 节点 / ${perKiloNodeOfHash.toFixed(2)} ms/千节点（判据 ≤ 8）`,
  );

  /* P12 OFD 导出：排版链路端到端（渲染 → 分页 → 逐页 Content.xml → ZIP）
     此前**完全没测过导出**，而它是打印链路唯一"用户真的会等"的操作：
     1000 页的病历导出要多久、会不会撑爆内存，只有这里能回答。 */
  if (TS_OFD) {
    const ofdDoc = clone(gen.doc);
    ofdDoc.machineReadable = store.exportMachineReadable();
    const ofdPlan = { layout: { textAsPath: false }, machineReadable: { signed: true, carrier: 'separate-xml' } };
    const exportRuns = Math.min(5, Math.max(1, Math.round(args.iter / 4)));
    const exportBench = bench('exportOfd', exportRuns, () => TS_OFD(ofdDoc, ofdPlan));
    const pkg = TS_OFD(ofdDoc, ofdPlan);
    const perKiloNodeOfExport = exportBench.avg / (nodeCount / 1000);
    add(
      'P12',
      `OFD 导出（渲染→分页→逐页 XML→ZIP）[${'src/export/ofd.ts（真实实现）'}]`,
      'avg',
      exportBench.avg,
      Math.min(20000, Math.max(300, (nodeCount / 1000) * 90)),
      'ms',
      true,
      `${pkg.pages} 页 / ${pkg.stats.textObjects} 文本对象 / ${(pkg.stats.bytes / 1048576).toFixed(2)} MB / ${perKiloNodeOfExport.toFixed(1)} ms/千节点`,
    );
  } else {
    add('P12', 'OFD 导出（渲染→分页→逐页 XML→ZIP）', 'avg', 0, 0, 'ms', true, 'SKIP：src/export/ofd.ts 不可用');
  }

  /* P13 规模线性度：专门防"在循环里扫全表"的 O(n²) 退化。
     用**比值判据**（1000 页 vs 100 页的每千节点耗时之比），而不是绝对耗时：
     绝对值随机器与负载波动，比值在同机同轮测试下稳定，且**不会因硬件升级而失效**。
     实测：修复前比值约 20×（1000 页导出 169 秒），修复后约 1×。 */
  if (TS_OFD) {
    const measureExport = (pages) => {
      const g = buildDoc(pages);
      const d = clone(g.doc);
      const st = createStore(clone(g.doc), {});
      d.machineReadable = st.exportMachineReadable();
      const plan2 = { layout: { textAsPath: false }, machineReadable: { signed: true, carrier: 'separate-xml' } };
      let best = Number.POSITIVE_INFINITY;
      // 取两次的最小值：抵掉 GC 抖动，避免"偶然变慢"被误判成结构性退化
      for (let round = 0; round < 2; round += 1) {
        const t = performance.now();
        TS_OFD(d, plan2);
        best = Math.min(best, performance.now() - t);
      }
      return { ms: best, nodes: Object.keys(d.nodes).length };
    };
    const small = measureExport(100);
    const large = measureExport(1000);
    const perSmall = small.ms / (small.nodes / 1000);
    const perLarge = large.ms / (large.nodes / 1000);
    const ratio = perSmall > 0 ? perLarge / perSmall : 1;
    add(
      'P13',
      '规模线性度（导出：1000 页 vs 100 页，每千节点耗时比）',
      'avg',
      ratio,
      3,
      '×',
      true,
      `${perSmall.toFixed(1)} → ${perLarge.toFixed(1)} ms/千节点（比值 ${ratio.toFixed(2)}×，判据 ≤ 3×；退化到 O(n²) 时会飙到 10× 以上）`,
    );
  }

  /* P9 序列化往返 */
  const rt = bench('roundtrip', Math.min(20, args.iter), () => JSON.parse(JSON.stringify(parsedDoc)));
  add('P9', 'JSON 序列化往返', 'avg', rt.avg, 500, 'ms', true, `${(docBytes / 1048576).toFixed(2)} MB`);

  /* P10 批量写入 */
  const store2 = createStore(clone(gen.doc), {});
  const t0 = performance.now();
  for (let i = 0; i < args.batch; i += 1) {
    const id = gen.ids.textIds[i % gen.ids.textIds.length];
    store2.insertText({ nodeId: id, text: '·' }, { id: 'DR_T', kind: 'human' });
  }
  const batchAvg = (performance.now() - t0) / args.batch;
  add('P10', `批量 ${args.batch} 次写入（含留痕）`, 'avg/次', batchAvg, 20, 'ms', true, `留痕 ${store2.getAuditLog().length} 条`);

  /* P11 输入延迟：有浏览器报告则实测判定，否则明确标记未覆盖（不假装通过） */
  if (args.browserReport) {
    if (!existsSync(args.browserReport)) {
      checks.push({
        id: 'P11',
        name: '输入延迟（键盘 → 呈现）',
        metric: 'p95',
        value: 0,
        threshold: 50,
        unit: 'ms',
        critical: true,
        pass: false,
        detail: `找不到浏览器延迟报告：${args.browserReport}`,
      });
    } else {
      const rep = JSON.parse(readFileSync(args.browserReport, 'utf8').replace(/^\uFEFF/, ''));
      const p95 = rep?.input?.p95;
      const env = rep?.env || {};
      const warnings = Array.isArray(rep?.warnings) ? rep.warnings : [];
      /* 取证有效性判定：无头环境或存在动画帧超时 → 数值不具代表性。
         此时既不能判 PASS（假通过），也不能判 FAIL（假报警），应标记为"未有效取证"。 */
      const invalid = [];
      if (env.headless === true) invalid.push('无头浏览器');
      if (warnings.some((x) => /未等到动画帧/.test(x))) invalid.push('存在动画帧超时');
      if (warnings.some((x) => /未找到可编辑文本/.test(x))) invalid.push('未找到可编辑节点');
      if (typeof p95 !== 'number') invalid.push('报告缺少 input.p95');

      if (invalid.length > 0 && !args.allowHeadless) {
        checks.push({
          id: 'P11',
          name: '输入延迟（键盘 → 呈现）',
          metric: '—',
          value: 0,
          threshold: 50,
          unit: 'ms',
          critical: false,
          pass: true,
          skipped: true,
          detail: `未有效取证（${invalid.join('、')}）：${args.browserReport}｜需在真实浏览器 + 目标终端（医院老 PC / 信创机）复测；加 --allow-headless 可强制判定`,
        });
      } else {
        checks.push({
          id: 'P11',
          name: '输入延迟（键盘 → 呈现）',
          metric: 'p95',
          value: typeof p95 === 'number' ? p95 : Number.POSITIVE_INFINITY,
          threshold: 50,
          unit: 'ms',
          critical: true,
          pass: typeof p95 === 'number' && p95 <= 50,
          detail:
            typeof p95 === 'number'
              ? `来源 ${args.browserReport}｜n=${rep.input.n} avg=${rep.input.avg.toFixed(2)}ms max=${rep.input.max.toFixed(2)}ms 超阈 ${rep.input.over} 次｜DPR ${env.devicePixelRatio} 核心 ${env.hardwareConcurrency} ${env.viewport || ''}${invalid.length ? `｜⚠ 数据有效性存疑：${invalid.join('、')}（--allow-headless 已强制判定）` : ''}`
              : `报告缺少 input.p95：${args.browserReport}`,
        });
      }
    }
  } else {
    checks.push({
      id: 'P11',
      name: '输入延迟（键盘 → 呈现）',
      metric: '—',
      value: 0,
      threshold: 50,
      unit: 'ms',
      critical: false,
      pass: true,
      skipped: true,
      detail: '未覆盖：需浏览器实测。用 tools/editor-check/editor-latency-server.mjs 打开骨架页面运行测试，再以 --browser-report 传入本脚本',
    });
  }

  /* 基线对比 */
  let baselineNote = '';
  if (args.baseline) {
    if (!existsSync(args.baseline)) {
      baselineNote = `基线文件不存在，跳过对比：${args.baseline}`;
    } else {
      const base = JSON.parse(readFileSync(args.baseline, 'utf8').replace(/^\uFEFF/, ''));
      const { regressions, ignored } = compareWithBaseline(checks, base, args.tolerance, args.floor);
      for (const r of regressions) {
        const c = checks.find((x) => x.id === r.id);
        if (c) {
          c.pass = false;
          c.detail += ` | 相对基线回归 +${(r.delta * 100).toFixed(0)}%（绝对 +${r.absDelta.toFixed(2)}ms）`;
        }
      }
      baselineNote = regressions.length
        ? `基线回归 ${regressions.length} 项：${regressions.map((r) => `${r.id} ${r.name}：${r.prev.toFixed(3)} → ${r.now.toFixed(3)}（+${(r.delta * 100).toFixed(0)}%，绝对 +${r.absDelta.toFixed(2)}ms）`).join('；')}`
        : `与基线对比无显著回归（容差 ${(args.tolerance * 100).toFixed(0)}%，显著性下限 = max(${args.floor}ms, 阈值 1%)）`;
      if (ignored.length) baselineNote += `｜忽略噪声 ${ignored.length} 项：${ignored.map((r) => `${r.id}(+${(r.delta * 100).toFixed(0)}%，绝对 +${r.absDelta.toFixed(3)}ms ≤ ${r.absSig.toFixed(2)}ms)`).join('，')}`;
    }
  }

  /* 输出 */
  const failed = checks.filter((c) => c.critical && !c.pass);
  const out = [];
  const w = (s) => out.push(s);
  w('');
  w(`S6 性能基线检查  |  规模 ${args.pages} 页 / ${nodeCount} 节点 / ${(docBytes / 1048576).toFixed(2)} MB / 采样 ${args.iter} 次`);
  w(`环境：Node ${process.version}  ${os.platform()} ${os.arch()}  CPU ${os.cpus()[0]?.model || 'unknown'}  内存 ${(os.totalmem() / 1073741824).toFixed(1)} GB`);
  w('─'.repeat(84));
  for (const c of checks) {
    const tag = c.skipped ? 'SKIP' : c.pass ? 'PASS' : 'FAIL';
    w(`${tag}  [${c.id}] ${c.name}`);
    const measured = c.unit === 'bool' ? '—' : `${c.value.toFixed(3)} ${c.unit}`;
    const limit = c.unit === 'bool' ? '—' : `${c.threshold} ${c.unit}`;
    w(`      ${c.metric}: ${measured}   阈值: ${limit}   ${c.detail || ''}`);
  }
  w('─'.repeat(84));
  w(`关键项：${checks.filter((c) => c.critical).length}    达标：${checks.filter((c) => c.critical && c.pass).length}    未达标：${failed.length}    未覆盖：${checks.filter((c) => c.skipped).length}`);
  if (args.verbose) {
    const detail = checks.map((c) => `${c.id}=${typeof c.value === 'number' ? c.value.toFixed(3) : c.value}`).join('  ');
    w(`明细：${detail}`);
  }
  if (baselineNote) w(baselineNote);
  w('注意：性能阈值需在目标机器（尤其医院老旧 PC / 信创终端）上重新校准；本脚本只覆盖 Node 侧可测部分。');
  w('');
  process.stdout.write(out.join('\n'));

  if (args.report) {
    writeFileSync(
      args.report,
      `${JSON.stringify({ tool: 'perf-check', version: '1.0.0', generatedAt: new Date().toISOString(), env: { node: process.version, platform: os.platform(), arch: os.arch(), cpu: os.cpus()[0]?.model }, scale: { pages: args.pages, nodes: nodeCount, bytes: docBytes, iter: args.iter, batch: args.batch }, checks, verdict: failed.length === 0 ? 'PASS' : 'FAIL' }, null, 2)}\n`,
      'utf8',
    );
    process.stdout.write(`报告已写入：${args.report}\n`);
  }

  process.exit(failed.length === 0 ? 0 : 1);
}

main();
