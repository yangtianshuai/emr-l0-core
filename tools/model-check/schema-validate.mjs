#!/usr/bin/env node
/**
 * S5 · L0 文档模型校验器（schema-validate，零 npm 依赖）
 *
 * 两块能力：
 *   A. 结构校验：按 schema/l0-document-model.schema.json 校验字段合法性
 *      （支持子集：$ref / allOf / oneOf / if-then / type / required / enum / const /
 *        pattern / format:date-time / minLength / minimum / maximum / minItems /
 *        minProperties / items / properties / additionalProperties）
 *      oneOf 采用"恰好匹配 1 个分支"判定，配合 type 常量做判别式校验。
 *   B. 语义校验：11 条硬规则（ValidationCode），这些是 JSON Schema 表达不了的
 *      —— AI 来源完整性、置信度门控、关键内容与标签确认、机读信息陈旧、留痕连续性等。
 *
 * 用法：
 *   node schema-validate.mjs <doc.json|目录> [更多文件...] [--json report.json] [--verbose]
 *   --thr 0.75        一般内容 AI 置信度阈值（默认 0.75）
 *   --thr-key 0.90    关键内容 AI 置信度阈值（默认 0.90）
 *   --skip-schema     只跑语义规则
 *
 * 退出码：0 = 无 error；1 = 存在 error；2 = 参数/读取错误
 *
 * 注意：本校验器是"自家模型的合法性门槛"，不判定是否符合 GB/T 48666—2026。
 * 若用于 CI，建议同时用 ajv（draft 2020-12）复核一遍，本脚本会自动列出未强制校验的关键字。
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { hashNodes } from './lib/model-utils.mjs';

const SCHEMA_PATH = resolve(process.cwd(), 'schema/l0-document-model.schema.json');
const KNOWN_SCHEMA_VERSIONS = new Set(['1.0.0']); // 与 schema/l0-document-model.ts 的 MIGRATION_NOTES 保持同步

/* ------------------------------ CLI ------------------------------ */

function parseArgs(argv) {
  const out = { inputs: [], report: null, verbose: false, thr: 0.75, thrKey: 0.9, skipSchema: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') out.report = argv[++i];
    else if (a === '--verbose' || a === '-v') out.verbose = true;
    else if (a === '--thr') out.thr = Number(argv[++i]);
    else if (a === '--thr-key') out.thrKey = Number(argv[++i]);
    else if (a === '--skip-schema') out.skipSchema = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else out.inputs.push(a);
  }
  return out;
}

const HELP = `L0 文档模型校验器（S5）

用法: node schema-validate.mjs <doc.json|目录> [更多文件...] [选项]

选项:
  --json <file>     输出完整报告到文件
  -v, --verbose     列出全部问题（默认每类只列前 5 条）
  --thr <n>         一般内容 AI 置信度阈值（默认 0.75）
  --thr-key <n>     关键内容 AI 置信度阈值（默认 0.90）
  --skip-schema     只跑语义规则
  -h, --help        显示帮助
`;

/* --------------------- JSON Schema 子集校验器 --------------------- */

function resolveRef(root, ref) {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) throw new Error(`仅支持本地 $ref，收到：${ref}`);
  const parts = ref
    .slice(2)
    .split('/')
    .map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
  let cur = root;
  for (const p of parts) {
    cur = cur == null ? undefined : cur[p];
    if (cur === undefined) throw new Error(`无法解析 $ref：${ref}`);
  }
  return cur;
}

function jsTypeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  if (typeof v === 'number') return 'number';
  return typeof v;
}

function typeMatches(value, t) {
  const actual = jsTypeOf(value);
  if (t === 'number') return actual === 'number' || actual === 'integer';
  if (t === 'integer') return actual === 'integer';
  return actual === t;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a && b && typeof a === 'object') {
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const UNSUPPORTED_KEYWORDS = new Set(['unevaluatedProperties', 'not', 'dependentRequired', 'patternProperties', '$dynamicRef']);

function validateAgainst(value, schema, ctx, path) {
  if (schema == null || typeof schema !== 'object') return;

  if (schema.$ref) {
    validateAgainst(value, resolveRef(ctx.root, schema.$ref), ctx, path);
    return;
  }
  if (Array.isArray(schema.allOf)) for (const s of schema.allOf) validateAgainst(value, s, ctx, path);
  if (schema.if) {
    const sub = silentErrors(value, schema.if, ctx.root);
    if (sub.length === 0 && schema.then) validateAgainst(value, schema.then, ctx, path);
  }
  if (Array.isArray(schema.oneOf)) {
    let matched = 0;
    for (const s of schema.oneOf) if (silentErrors(value, s, ctx.root).length === 0) matched += 1;
    if (matched !== 1) ctx.schemaErrors.push({ path, message: `oneOf 要求恰好匹配 1 个分支，实际匹配 ${matched} 个` });
  }
  for (const kw of Object.keys(schema)) if (UNSUPPORTED_KEYWORDS.has(kw)) ctx.unsupported.add(kw);

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeMatches(value, t))) {
      ctx.schemaErrors.push({ path, message: `类型应为 ${types.join('|')}，实际为 ${jsTypeOf(value)}` });
      return;
    }
  }
  if (schema.enum !== undefined && !schema.enum.some((e) => deepEqual(e, value))) {
    ctx.schemaErrors.push({ path, message: `取值不在枚举内：${JSON.stringify(value)}（允许：${schema.enum.join(', ')}）` });
  }
  if ('const' in schema && !deepEqual(schema.const, value)) {
    ctx.schemaErrors.push({ path, message: `取值必须为 ${JSON.stringify(schema.const)}，实际为 ${JSON.stringify(value)}` });
  }
  if (typeof value === 'string') {
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      ctx.schemaErrors.push({ path, message: `不匹配模式 ${schema.pattern}：${value}` });
    }
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      ctx.schemaErrors.push({ path, message: `长度应 ≥ ${schema.minLength}` });
    }
    if (schema.format === 'date-time' && !(ISO_DATETIME.test(value) && !Number.isNaN(Date.parse(value)))) {
      ctx.schemaErrors.push({ path, message: `不是合法 ISO8601 时间：${value}` });
    }
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) ctx.schemaErrors.push({ path, message: `应 ≥ ${schema.minimum}，实际 ${value}` });
    if (typeof schema.maximum === 'number' && value > schema.maximum) ctx.schemaErrors.push({ path, message: `应 ≤ ${schema.maximum}，实际 ${value}` });
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) ctx.schemaErrors.push({ path, message: `元素数应 ≥ ${schema.minItems}` });
    if (schema.items) value.forEach((item, i) => validateAgainst(item, schema.items, ctx, `${path}[${i}]`));
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    if (Array.isArray(schema.required)) {
      for (const r of schema.required) if (!(r in value)) ctx.schemaErrors.push({ path, message: `缺少必填字段 ${r}` });
    }
    const props = schema.properties || {};
    for (const [k, v] of Object.entries(value)) {
      if (Object.prototype.hasOwnProperty.call(props, k)) validateAgainst(v, props[k], ctx, `${path}.${k}`);
      else if (schema.additionalProperties === false) ctx.schemaErrors.push({ path: `${path}.${k}`, message: `不允许的字段 ${k}` });
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        validateAgainst(v, schema.additionalProperties, ctx, `${path}.${k}`);
      }
    }
    if (typeof schema.minProperties === 'number' && Object.keys(value).length < schema.minProperties) {
      ctx.schemaErrors.push({ path, message: `字段数应 ≥ ${schema.minProperties}` });
    }
  }
}

/** 静默校验（用于 if / oneOf 判定），返回错误数组 */
function silentErrors(value, schema, root) {
  const ctx = { root, schemaErrors: [], unsupported: new Set() };
  validateAgainst(value, schema, ctx, '$');
  return ctx.schemaErrors;
}

/* --------------------------- 语义规则 --------------------------- */

const SEVERITY = { E_MACHINE_READABLE_STALE: 'error' };

function validateSemantics(doc, opts) {
  const issues = [];
  const push = (code, message, nodeId) =>
    issues.push({ code, message, nodeId: nodeId || null, severity: SEVERITY[code] || 'error', layer: 'semantic' });

  const nodes = doc && typeof doc.nodes === 'object' && doc.nodes !== null ? doc.nodes : {};
  const existing = new Set(Object.keys(nodes));

  /* E_NODE_ID_DUP */
  const seen = new Set();
  for (const [key, node] of Object.entries(nodes)) {
    if (!node || typeof node !== 'object') continue;
    if (node.id !== key) push('E_NODE_ID_DUP', `索引键 "${key}" 与 node.id "${node.id}" 不一致`, node.id);
    if (node.id && seen.has(node.id)) push('E_NODE_ID_DUP', `节点 id 重复：${node.id}`, node.id);
    if (node.id) seen.add(node.id);
  }

  /* E_PARENT_MISSING */
  for (const node of Object.values(nodes)) {
    if (!node || typeof node !== 'object') continue;
    if (node.parentId !== null && node.parentId !== undefined && !existing.has(node.parentId)) {
      push('E_PARENT_MISSING', `父节点不存在：${node.parentId}`, node.id);
    }
  }

  /* E_ORPHAN_NODE（从 rootId 不可达：孤儿或循环） */
  const children = new Map();
  for (const node of Object.values(nodes)) {
    if (!node || node.parentId == null) continue;
    if (!children.has(node.parentId)) children.set(node.parentId, []);
    children.get(node.parentId).push(node.id);
  }
  const reachable = new Set();
  const queue = doc.rootId && existing.has(doc.rootId) ? [doc.rootId] : [];
  while (queue.length > 0) {
    const cur = queue.pop();
    if (reachable.has(cur)) continue;
    reachable.add(cur);
    for (const c of children.get(cur) || []) queue.push(c);
  }
  for (const id of existing) if (!reachable.has(id)) push('E_ORPHAN_NODE', `节点不可从 rootId 到达（孤儿或循环引用）：${id}`, id);

  /* AI 来源与门控 */
  const inFinalState = doc.status === 'signed' || doc.status === 'archived';
  for (const node of Object.values(nodes)) {
    if (!node || !node.provenance) continue;
    const p = node.provenance;
    if (p.origin === 'ai') {
      if (!p.modelId || typeof p.confidence !== 'number') {
        push('E_AI_NO_PROVENANCE', 'AI 节点缺少 modelId 或 confidence（无法审计与回放）', node.id);
      }
      const threshold = node.keyContent ? opts.thrKey : opts.thr;
      if (typeof p.confidence === 'number' && p.confidence < threshold && node.humanConfirmed !== true) {
        push('E_AI_LOW_CONFIDENCE_UNCONFIRMED', `AI 置信度 ${p.confidence} 低于阈值 ${threshold} 且未经人工确认（不得落笔）`, node.id);
      }
    }
    if (inFinalState && node.keyContent === true && node.humanConfirmed !== true) {
      push('E_KEY_CONTENT_UNCONFIRMED', `关键内容节点在 ${doc.status} 状态仍未人工确认`, node.id);
    }
    /* 机器绑的标签：与关键内容同档。它不是内容而是元数据，会进机读信息被下游直接消费，
       而医生看正文时看不见它 —— 所以"没确认"这件事必须由门控说出口 */
    if (inFinalState && Array.isArray(node.unconfirmedTags) && node.unconfirmedTags.length > 0) {
      push('E_TAG_UNCONFIRMED', `机器绑定的数据元标签未经人工确认即进入 ${doc.status} 状态（${node.unconfirmedTags.length} 条）`, node.id);
    }
    if (inFinalState && p.origin === 'ai' && node.humanConfirmed !== true) {
      push('E_SIGNED_WITH_UNCONFIRMED_AI', `存在未经人工确认的 AI 内容即进入 ${doc.status} 状态`, node.id);
    }
  }

  /* 机读信息陈旧 */
  const mr = doc.machineReadable;
  if (mr && typeof mr === 'object') {
    if (mr.modelSchemaVersion !== doc.schemaVersion) {
      push('E_MACHINE_READABLE_STALE', `机读信息 modelSchemaVersion=${mr.modelSchemaVersion} 与文档 schemaVersion=${doc.schemaVersion} 不一致`);
    }
    if (mr.sourceHash) {
      // 按内容判定（推荐）：签名/改状态会推进 updatedAt，但节点内容未变，不应误报陈旧
      const actual = hashNodes(doc.nodes || {});
      if (mr.sourceHash !== actual) {
        push('E_MACHINE_READABLE_STALE', `机读信息 sourceHash=${mr.sourceHash} 与当前节点内容指纹=${actual} 不一致，需重算`);
      }
    } else if (mr.generatedAt && doc.updatedAt && Date.parse(mr.generatedAt) < Date.parse(doc.updatedAt)) {
      // 兜底：未提供 sourceHash 时退回时间戳判定（会误报签名后的文档，建议补 sourceHash）
      push('E_MACHINE_READABLE_STALE', `机读信息生成时间(${mr.generatedAt})早于文档更新时间(${doc.updatedAt})，需重算（建议补充 sourceHash 以按内容判定）`);
    }
    for (const de of Array.isArray(mr.dataElements) ? mr.dataElements : []) {
      if (de && de.nodeId && !existing.has(de.nodeId)) push('E_MACHINE_READABLE_STALE', `机读数据元引用了不存在的节点：${de.nodeId}`, de.nodeId);
    }
    for (const kc of Array.isArray(mr.keyContentRefs) ? mr.keyContentRefs : []) {
      if (kc && kc.nodeId && !existing.has(kc.nodeId)) push('E_MACHINE_READABLE_STALE', `keyContentRefs 引用了不存在的节点：${kc.nodeId}`, kc.nodeId);
    }
  }

  /* 留痕连续性 */
  if (Array.isArray(doc.revisions)) {
    doc.revisions.forEach((r, i) => {
      if (!r || r.rev !== i + 1) push('E_REVISION_GAP', `留痕 rev 不连续：第 ${i + 1} 条 rev=${r ? r.rev : '缺失'}（应为 ${i + 1}）`);
    });
  }

  /* schemaVersion 登记 */
  if (doc.schemaVersion && !KNOWN_SCHEMA_VERSIONS.has(doc.schemaVersion)) {
    push('E_SCHEMA_VERSION_UNKNOWN', `未登记的 schemaVersion：${doc.schemaVersion}（缺少迁移函数）`);
  }

  return issues;
}

/* ----------------------------- 主流程 ----------------------------- */

function collectJsonFiles(input) {
  const st = statSync(input);
  if (st.isDirectory()) {
    return readdirSync(input)
      .filter((f) => f.toLowerCase().endsWith('.json'))
      .map((f) => join(input, f));
  }
  return [input];
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.inputs.length === 0) {
    process.stdout.write(HELP);
    process.exit(args.help ? 0 : 2);
  }
  if (!args.skipSchema && !existsSync(SCHEMA_PATH)) {
    process.stderr.write(`找不到 schema：${SCHEMA_PATH}（请在项目根目录运行，或加 --skip-schema）\n`);
    process.exit(2);
  }
  const schema = args.skipSchema ? null : JSON.parse(readFileSync(SCHEMA_PATH, 'utf8').replace(/^\uFEFF/, ''));

  const files = [];
  for (const input of args.inputs) {
    if (!existsSync(input)) {
      process.stderr.write(`找不到输入：${input}\n`);
      process.exit(2);
    }
    files.push(...collectJsonFiles(input));
  }

  const results = [];
  const unsupported = new Set();

  for (const file of files) {
    let doc;
    try {
      doc = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    } catch (err) {
      results.push({ file, skipped: false, parseError: err.message, schemaErrors: [], semantic: [], verdict: 'FAIL' });
      continue;
    }
    if (!doc || typeof doc !== 'object' || !doc.nodes) {
      results.push({ file, skipped: true, skipReason: '不含 nodes 字段，判定为非文档模型文件（已跳过）', schemaErrors: [], semantic: [], verdict: 'SKIP' });
      continue;
    }

    let schemaErrors = [];
    if (schema) {
      const ctx = { root: schema, schemaErrors: [], unsupported };
      validateAgainst(doc, schema, ctx, '$');
      schemaErrors = ctx.schemaErrors;
    }
    const semantic = validateSemantics(doc, args);
    const errorCount = schemaErrors.length + semantic.filter((i) => i.severity === 'error').length;
    results.push({ file, skipped: false, schemaErrors, semantic, verdict: errorCount === 0 ? 'PASS' : 'FAIL' });
  }

  const out = [];
  const w = (s) => out.push(s);
  const limit = args.verbose ? Number.MAX_SAFE_INTEGER : 5;

  for (const r of results) {
    const name = basename(r.file);
    w('');
    w(`── ${name} ──`);
    if (r.skipped) {
      w(`SKIP  ${r.skipReason}`);
      continue;
    }
    if (r.parseError) {
      w(`FAIL  不是合法 JSON：${r.parseError}`);
      continue;
    }
    if (r.schemaErrors.length > 0) {
      w(`结构校验：${r.schemaErrors.length} 个问题`);
      r.schemaErrors.slice(0, limit).forEach((e) => w(`  - ${e.path}  ${e.message}`));
      if (r.schemaErrors.length > limit) w(`  … 其余 ${r.schemaErrors.length - limit} 条见报告文件`);
    } else if (schema) {
      w('结构校验：通过');
    } else {
      w('结构校验：已跳过（--skip-schema）');
    }

    const byCode = new Map();
    for (const i of r.semantic) {
      if (!byCode.has(i.code)) byCode.set(i.code, []);
      byCode.get(i.code).push(i);
    }
    if (byCode.size === 0) {
      w('语义校验：通过');
    } else {
      w(`语义校验：${r.semantic.length} 个问题，涉及 ${byCode.size} 类规则`);
      for (const [code, list] of byCode) {
        w(`  [${code}] ${list.length} 处`);
        list.slice(0, limit).forEach((i) => w(`      ${i.nodeId ? `${i.nodeId} ` : ''}${i.message}`));
        if (list.length > limit) w(`      … 其余 ${list.length - limit} 处见报告文件`);
      }
    }
    w(`结论：${r.verdict}`);
  }

  const failed = results.filter((r) => r.verdict === 'FAIL');
  w('');
  w('─'.repeat(72));
  w(`文件数：${results.length}    通过：${results.filter((r) => r.verdict === 'PASS').length}    失败：${failed.length}    跳过：${results.filter((r) => r.verdict === 'SKIP').length}`);
  if (unsupported.size > 0) {
    w(`未强制校验的 Schema 关键字（建议 CI 用 ajv 复核）：${[...unsupported].join(', ')}`);
  }
  w('本校验器不判定是否符合 GB/T 48666—2026。');
  w('');

  process.stdout.write(out.join('\n'));

  if (args.report) {
    writeFileSync(
      args.report,
      `${JSON.stringify({ tool: 'schema-validate', version: '1.0.0', generatedAt: new Date().toISOString(), thresholds: { ai: args.thr, aiKeyContent: args.thrKey }, results, verdict: failed.length === 0 ? 'PASS' : 'FAIL' }, null, 2)}\n`,
      'utf8',
    );
    process.stdout.write(`报告已写入：${args.report}\n`);
  }

  process.exit(failed.length === 0 ? 0 : 1);
}

main();
