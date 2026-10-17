#!/usr/bin/env node
/**
 * S4 · AI 路径与门控 契约测试（ai-path-check，零 npm 依赖）
 *
 * 覆盖 DoD 8：把 API 清单第五节的门控规则变成可执行契约。
 * 关键点：所有"被拒"用例必须从 API 层发起 —— 前端拦截不算通过。
 *
 * 三种运行模式：
 *  1) 内存参考实现（默认）：lib/doc-store.mjs，26 条用例应全部通过；
 *  2) HTTP 直连真实后端：--adapter lib/http-store-adapter.mjs --base-url http://host:port
 *     —— 同一套用例，不区分同步/异步实现（所有调用统一 await）；
 *  3) 鉴别力自证：--noncompliant，跑"故意不合规实现"，用例集必须精确识别出 14 个违规点。
 *
 * 用法：
 *   node ai-path-check.mjs
 *   node ai-path-check.mjs --adapter .\tools\model-check\lib\http-store-adapter.mjs --base-url http://127.0.0.1:8790
 *   node ai-path-check.mjs --noncompliant
 *   node ai-path-check.mjs --emit .\samples\s4-signed-doc.json
 *   node ai-path-check.mjs --json report.json -v
 *
 * 退出码：0 = 契约满足（或 --noncompliant 下精确命中设计违规集）；1 = 契约被违反；2 = 参数/加载错误
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ContractError, createStore as defaultCreateStore, ERR } from './lib/doc-store.mjs';

const HUMAN = { id: 'DR_T', kind: 'human' };
const AI = { id: 'ai-pipeline', kind: 'ai' };
const SYS = { id: 'system/lis', kind: 'system' };

const VALID_PLAN = {
  layout: { pagination: 'derived', fontEmbedding: 'subset', textAsPath: false },
  machineReadable: { carrier: 'custom-data', namespace: 'urn:local:ofd-h-machine', signed: true, payloadFrom: 'machineReadable.dataElements' },
  signature: { algorithm: 'SM2' },
};

/** --noncompliant 下应当被识别出的用例（设计违规点） */
const EXPECTED_NONCOMPLIANT_FAILURES = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A11', 'A13', 'A14', 'A15', 'A17', 'A18', 'A23'];

function baseDoc() {
  const at = '2026-10-08T01:00:00Z';
  const prov = (origin, actorId) => ({ origin, actorId, at });
  return {
    schemaVersion: '1.0.0',
    docId: 'doc_contract_001',
    docType: { system: 'WST500', code: 'WST500.2', display: '门（急）诊病历' },
    patient: { patientId: 'P9001', nameMasked: '张**', gender: 'M' },
    encounter: { visitId: 'V001', visitType: 'outpatient' },
    status: 'draft',
    createdAt: at,
    updatedAt: at,
    createdBy: 'DR_T',
    rootId: 'n_root',
    nodes: {
      n_root: { id: 'n_root', type: 'document', parentId: null, order: 0, rev: 1, provenance: prov('system', 'seed') },
      n_sec: { id: 'n_sec', type: 'section', parentId: 'n_root', order: 10, rev: 1, title: '初步诊断', sectionCode: 'assessment', provenance: prov('human', 'DR_T') },
      n_p: { id: 'n_p', type: 'paragraph', parentId: 'n_sec', order: 10, rev: 1, semantic: 'assessment', provenance: prov('human', 'DR_T') },
      n_t: { id: 'n_t', type: 'text', parentId: 'n_p', order: 10, rev: 1, runs: [{ text: '原始文本' }], provenance: prov('human', 'DR_T') },
      n_f: {
        id: 'n_f',
        type: 'field',
        parentId: 'n_sec',
        order: 20,
        rev: 1,
        dataType: 'code',
        value: 'J18.9',
        valueText: '肺炎',
        keyContent: true,
        humanConfirmed: true,
        tags: [{ system: 'ICD10', code: 'J18.9', display: '肺炎' }],
        provenance: prov('human', 'DR_T'),
      },
      n_f2: {
        id: 'n_f2',
        type: 'field',
        parentId: 'n_sec',
        order: 30,
        rev: 1,
        dataType: 'number',
        value: 37,
        valueText: '37',
        unit: '℃',
        tags: [{ system: 'WS445', code: 'DE05.01.001', display: '体温' }],
        provenance: prov('system', 'system/lis'),
      },
      n_sig: { id: 'n_sig', type: 'signatureBlock', parentId: 'n_root', order: 90, rev: 1, signerRole: 'author', provenance: prov('human', 'DR_T') },
    },
    revisions: [],
  };
}

/* ------------------------------ 断言工具 ------------------------------ */

async function expectCode(label, fn, code) {
  let result;
  try {
    result = await fn();
  } catch (e) {
    if (e instanceof ContractError || e?.code) {
      if (e.code !== code) throw new Error(`期望 ${code}，实际 ${e.code}（${e.message}）`);
      return e;
    }
    throw new Error(`抛出了非契约错误：${e.message}`);
  }
  void result;
  throw new Error(`期望抛出 ${code}，但调用成功了（门控失效）`);
}

function ok(label, cond, detail) {
  if (!cond) throw new Error(`${label}${detail ? `：${detail}` : ''}`);
}

/* -------------------------------- 用例 -------------------------------- */
/* 所有 store 调用统一 await：这样同一套用例既能跑同步内存实现，也能直连异步 HTTP 后端 */

const CASES = [
  /* G1：AI 不得直接调用写接口 */
  { id: 'A1', group: 'G1 AI 直接写', name: 'AI 调 insertText 被拒', run: async (s) => expectCode('insertText by ai', () => s.insertText({ nodeId: 'n_t', text: 'X' }, AI), ERR.E_AI_DIRECT_WRITE_FORBIDDEN) },
  { id: 'A2', group: 'G1 AI 直接写', name: 'AI 调 updateNodeProps 被拒', run: async (s) => expectCode('updateNodeProps by ai', () => s.updateNodeProps({ nodeId: 'n_t', patch: { semantic: 'x' } }, AI), ERR.E_AI_DIRECT_WRITE_FORBIDDEN) },
  { id: 'A3', group: 'G1 AI 直接写', name: 'AI 调 deleteNode 被拒', run: async (s) => expectCode('deleteNode by ai', () => s.deleteNode({ nodeId: 'n_t' }, AI), ERR.E_AI_DIRECT_WRITE_FORBIDDEN) },
  { id: 'A4', group: 'G1 AI 直接写', name: 'AI 调 setFieldValue 被拒', run: async (s) => expectCode('setFieldValue by ai', () => s.setFieldValue({ nodeId: 'n_f2', value: 39 }, AI), ERR.E_AI_DIRECT_WRITE_FORBIDDEN) },
  { id: 'A5', group: 'G1 AI 直接写', name: 'AI 调 createNode 被拒', run: async (s) => expectCode('createNode by ai', () => s.createNode({ parentId: 'n_p', type: 'text', props: { runs: [{ text: 'x' }] } }, AI), ERR.E_AI_DIRECT_WRITE_FORBIDDEN) },

  /* G2：置信度门控 */
  {
    id: 'A6',
    group: 'G2 置信度门控',
    name: '一般内容 0.60 < 0.75 不得落笔',
    run: async (s) => {
      const { suggestionId } = await s.suggestText({ nodeId: 'n_t', text: 'AI 草稿', confidence: 0.6, modelId: 'm1', promptId: 'p1' }, AI);
      return expectCode('accept low-confidence general', () => s.acceptSuggestion({ suggestionId }, HUMAN), ERR.E_AI_LOW_CONFIDENCE);
    },
  },
  {
    id: 'A7',
    group: 'G2 置信度门控',
    name: '关键内容 0.85 < 0.90 不得落笔',
    run: async (s) => {
      const { suggestionId } = await s.suggestText({ nodeId: 'n_t', text: 'AI 草稿', confidence: 0.85, modelId: 'm1', promptId: 'p1' }, AI);
      await s.updateNodeProps({ nodeId: 'n_t', patch: { keyContent: true } }, HUMAN);
      return expectCode('accept low-confidence key', () => s.acceptSuggestion({ suggestionId }, HUMAN), ERR.E_AI_LOW_CONFIDENCE);
    },
  },
  {
    id: 'A8',
    group: 'G2 置信度门控',
    name: '关键内容 0.95 可落笔，但需人工确认才算数',
    run: async (s) => {
      await s.updateNodeProps({ nodeId: 'n_t', patch: { keyContent: true } }, HUMAN);
      const { suggestionId } = await s.suggestText({ nodeId: 'n_t', text: 'AI 草稿', confidence: 0.95, modelId: 'm1', promptId: 'p1' }, AI);
      const r = await s.acceptSuggestion({ suggestionId }, HUMAN);
      ok('accept 应成功', r.ok === true);
      const node = await s.getNode('n_t');
      ok('内容已落笔', node.runs[0].text === 'AI 草稿');
      ok('来源为 ai', node.provenance.origin === 'ai');
      ok('有采纳人', node.provenance.acceptedBy === HUMAN.id);
      ok('采纳 ≠ 确认责任，humanConfirmed 应为 false', node.humanConfirmed === false);
      const rev = (await s.getAuditLog()).find((x) => x.op === 'accept-ai');
      ok('留痕 op=accept-ai', !!rev);
      ok('留痕带 modelId/confidence', rev.modelId === 'm1' && rev.confidence === 0.95);
    },
  },

  /* G3：建议态不落笔 */
  {
    id: 'A9',
    group: 'G3 建议态',
    name: 'suggest 不改变文档与留痕',
    run: async (s) => {
      const beforeNodes = JSON.stringify((await s.getDoc()).nodes);
      const beforeRev = (await s.getAuditLog()).length;
      await s.suggestText({ nodeId: 'n_t', text: 'AI 草稿', confidence: 0.99, modelId: 'm1', promptId: 'p1' }, AI);
      ok('节点未被改动', JSON.stringify((await s.getDoc()).nodes) === beforeNodes);
      ok('留痕未增加', (await s.getAuditLog()).length === beforeRev);
    },
  },
  {
    id: 'A10',
    group: 'G3 建议态',
    name: '低置信建议仍可展示（门控在落笔，不在生成）',
    run: async (s) => {
      const { suggestionId } = await s.suggestText({ nodeId: 'n_t', text: 'AI 草稿', confidence: 0.4, modelId: 'm1', promptId: 'p1' }, AI);
      const list = await s.listSuggestions({ status: 'pending' });
      ok('低置信建议可见', list.some((x) => x.id === suggestionId), `pending=${list.length}`);
    },
  },

  /* G4：人工确认 */
  {
    id: 'A11',
    group: 'G4 人工确认',
    name: 'AI 调 confirmNode 被拒',
    run: async (s) => {
      await s.updateNodeProps({ nodeId: 'n_t', patch: { keyContent: true } }, HUMAN);
      return expectCode('confirmNode by ai', () => s.confirmNode({ nodeId: 'n_t' }, AI), ERR.E_AI_NOT_ALLOWED);
    },
  },
  {
    id: 'A12',
    group: 'G4 人工确认',
    name: '人工 confirmNode 成功并留痕',
    run: async (s) => {
      await s.updateNodeProps({ nodeId: 'n_t', patch: { keyContent: true } }, HUMAN);
      const r = await s.confirmNode({ nodeId: 'n_t' }, HUMAN);
      ok('返回成功', r.ok === true);
      ok('humanConfirmed=true', (await s.getNode('n_t')).humanConfirmed === true);
      const rev = (await s.getAuditLog()).at(-1);
      ok('留痕 targetId 正确', rev.targetId === 'n_t' && rev.actorId === HUMAN.id);
    },
  },
  {
    id: 'A13',
    group: 'G4 人工确认',
    name: 'AI 调 acceptSuggestion 被拒',
    run: async (s) => {
      const { suggestionId } = await s.suggestText({ nodeId: 'n_t', text: 'AI 草稿', confidence: 0.99, modelId: 'm1', promptId: 'p1' }, AI);
      return expectCode('accept by ai', () => s.acceptSuggestion({ suggestionId }, AI), ERR.E_AI_NOT_ALLOWED);
    },
  },

  /* G5：签名门控 */
  {
    id: 'A14',
    group: 'G5 签名门控',
    name: '关键内容未确认则禁止签名',
    run: async (s) => {
      await s.updateNodeProps({ nodeId: 'n_f', patch: { humanConfirmed: false } }, HUMAN);
      return expectCode('sign with unconfirmed key', () => s.sign({}, HUMAN), ERR.E_KEY_CONTENT_UNCONFIRMED);
    },
  },
  {
    id: 'A15',
    group: 'G5 签名门控',
    name: '存在未确认 AI 内容则禁止签名',
    run: async (s) => {
      const { suggestionId } = await s.suggestText({ nodeId: 'n_t', text: 'AI 草稿', confidence: 0.99, modelId: 'm1', promptId: 'p1' }, AI);
      await s.acceptSuggestion({ suggestionId }, HUMAN);
      return expectCode('sign with unconfirmed ai', () => s.sign({}, HUMAN), ERR.E_SIGNED_WITH_UNCONFIRMED_AI);
    },
  },
  {
    id: 'A16',
    group: 'G5 签名门控',
    name: '全部确认后可签名，签名覆盖机读文件',
    run: async (s) => {
      const { suggestionId } = await s.suggestText({ nodeId: 'n_t', text: 'AI 草稿', confidence: 0.99, modelId: 'm1', promptId: 'p1' }, AI);
      await s.acceptSuggestion({ suggestionId }, HUMAN);
      await s.confirmNode({ nodeId: 'n_t' }, HUMAN);
      const r = await s.sign({}, HUMAN);
      ok('签名成功', r.ok === true);
      const doc = await s.getDoc();
      ok('状态为 signed', doc.status === 'signed');
      ok('留痕 op=sign', (await s.getAuditLog()).some((x) => x.op === 'sign'));
      const covers = doc.signatureRefs[0].covers || [];
      ok('签名覆盖机读文件', covers.some((c) => /MachineReadable/.test(c)), covers.join(','));
    },
  },

  /* G6：并发与幂等 */
  { id: 'A17', group: 'G6 并发幂等', name: 'expectedRev 过期返回冲突', run: async (s) => expectCode('stale rev', () => s.updateNodeProps({ nodeId: 'n_t', patch: { semantic: 'x' } }, HUMAN, { expectedRev: 0 }), ERR.E_REV_CONFLICT) },
  {
    id: 'A18',
    group: 'G6 并发幂等',
    name: '同 clientOpId 重复提交不产生重复留痕',
    run: async (s) => {
      const before = (await s.getAuditLog()).length;
      const r1 = await s.insertText({ nodeId: 'n_t', text: '追加' }, HUMAN, { clientOpId: 'op-1' });
      const mid = (await s.getAuditLog()).length;
      const r2 = await s.insertText({ nodeId: 'n_t', text: '追加' }, HUMAN, { clientOpId: 'op-1' });
      const after = (await s.getAuditLog()).length;
      ok('第一次写成功', r1.ok === true);
      ok('第二次返回首次结果', r1.revision === r2.revision && r1.targetId === r2.targetId, `r1.rev=${r1.revision} r2.rev=${r2.revision}`);
      ok('留痕只增加 1 条', mid === before + 1 && after === mid, `${before}→${mid}→${after}`);
      ok('文本未被追加两次', (await s.getNode('n_t')).runs[0].text === '原始文本追加', (await s.getNode('n_t')).runs[0].text);
    },
  },

  /* G7：审计与统计 */
  {
    id: 'A19',
    group: 'G7 审计统计',
    name: '采纳时人工改稿计入修改率',
    run: async (s) => {
      const { suggestionId } = await s.suggestText({ nodeId: 'n_t', text: 'AI 原始草稿', confidence: 0.99, modelId: 'm1', promptId: 'p1' }, AI);
      await s.acceptSuggestion({ suggestionId, editedText: '医生修改后的文本' }, HUMAN);
      const sug = (await s.listSuggestions()).find((x) => x.id === suggestionId);
      ok('建议标记为已修改', sug.modified === true);
      const m = await s.getMetrics();
      ok('editRate > 0', m.editRate > 0, JSON.stringify(m));
      ok('修正后文本已落笔', (await s.getNode('n_t')).runs[0].text === '医生修改后的文本');
    },
  },
  {
    id: 'A20',
    group: 'G7 审计统计',
    name: '拒绝建议留痕并计入拒绝率',
    run: async (s) => {
      const { suggestionId } = await s.suggestText({ nodeId: 'n_t', text: 'AI 草稿', confidence: 0.99, modelId: 'm1', promptId: 'p1' }, AI);
      const r = await s.rejectSuggestion({ suggestionId, reason: '与病史不符' }, HUMAN);
      ok('拒绝成功', r.ok === true);
      const rev = (await s.getAuditLog()).find((x) => x.op === 'reject-ai');
      ok('留痕 op=reject-ai', !!rev);
      ok('留痕关联建议 id', rev.aiSuggestionId === suggestionId);
      const m = await s.getMetrics();
      ok('rejectRate > 0', m.rejectRate > 0, JSON.stringify(m));
      ok('节点内容未被改动', (await s.getNode('n_t')).runs[0].text === '原始文本');
    },
  },
  {
    id: 'A21',
    group: 'G7 审计统计',
    name: '人工续改 AI 内容后仍保留 AI 来源链',
    run: async (s) => {
      const { suggestionId } = await s.suggestText({ nodeId: 'n_t', text: 'AI 草稿', confidence: 0.99, modelId: 'm1', promptId: 'p1' }, AI);
      await s.acceptSuggestion({ suggestionId }, HUMAN);
      await s.insertText({ nodeId: 'n_t', text: '（医生补充）' }, HUMAN);
      const node = await s.getNode('n_t');
      ok('origin 变为 human', node.provenance.origin === 'human');
      ok('derivedFrom 保留模型链路', node.provenance.derivedFrom?.modelId === 'm1', JSON.stringify(node.provenance));
      ok('derivedFrom.editedBy 记录编辑人', node.provenance.derivedFrom?.editedBy === HUMAN.id);
      const doc = await s.getDoc();
      for (const n of Object.values(doc.nodes)) {
        if (n.provenance?.origin === 'ai') ok(`AI 节点 ${n.id} 应有 modelId/confidence`, !!n.provenance.modelId && typeof n.provenance.confidence === 'number');
      }
    },
  },

  /* G8：机读与导出 */
  {
    id: 'A22',
    group: 'G8 机读导出',
    name: 'exportMachineReadable 重算并与节点一致',
    run: async (s) => {
      await s.setFieldValue({ nodeId: 'n_f2', value: 38.7, valueText: '38.7' }, HUMAN);
      const before = (await s.getDoc()).machineReadable;
      ok('改动后应判定为陈旧', before.generatedAt !== (await s.getDoc()).updatedAt || before.dataElements.find((d) => d.nodeId === 'n_f2').value === 37);
      const mr = await s.exportMachineReadable();
      ok('generatedAt 与 updatedAt 对齐', mr.generatedAt === (await s.getDoc()).updatedAt, `${mr.generatedAt} vs ${(await s.getDoc()).updatedAt}`);
      const de = mr.dataElements.find((d) => d.nodeId === 'n_f2');
      ok('数据元反映新值', de && de.value === 38.7, JSON.stringify(de));
      ok('数据元沿用标准标签', de.tag.code === 'DE05.01.001');
    },
  },
  {
    id: 'A23',
    group: 'G8 机读导出',
    name: '机读信息陈旧时禁止导出 OFD',
    run: async (s) => {
      await s.insertText({ nodeId: 'n_t', text: '改动后未重算机读信息' }, HUMAN);
      return expectCode('export with stale machine readable', () => s.exportOFD(VALID_PLAN), ERR.E_MACHINE_READABLE_STALE);
    },
  },
  {
    id: 'A24',
    group: 'G8 机读导出',
    name: '导出计划禁止文本路径化',
    run: async (s) => {
      const bad = { ...VALID_PLAN, layout: { ...VALID_PLAN.layout, textAsPath: true } };
      return expectCode('export with textAsPath', () => s.exportOFD(bad), ERR.E_EXPORT_INVALID_PLAN);
    },
  },

  /* 数据安全（与 AI 门控同级，始终强制） */
  {
    id: 'A25',
    group: 'G9 数据安全',
    name: '签名后禁止直接改动，须走解锁流程',
    run: async (s) => {
      await s.sign({}, HUMAN);
      ok('已签名', (await s.getDoc()).status === 'signed');
      return expectCode('mutate signed doc', () => s.insertText({ nodeId: 'n_t', text: 'X' }, HUMAN), ERR.E_SIGNED_IMMUTABLE);
    },
  },
  { id: 'A26', group: 'G9 数据安全', name: '关键内容节点禁止删除', run: async (s) => expectCode('delete keyContent node', () => s.deleteNode({ nodeId: 'n_f' }, HUMAN), ERR.E_KEY_CONTENT_PROTECTED) },
];

/* ------------------------------- 运行 ------------------------------- */

const HELP = `S4 · AI 路径与门控契约测试

用法: node ai-path-check.mjs [选项]

选项:
  --noncompliant          跑"故意不合规实现"，验证用例集的鉴别力（meta 测试）
  --adapter <file>        自定义适配器（需导出 createStore(doc, options)）
  --base-url <url>        传给适配器的后端地址（HTTP 适配器必需）
  --json <file>           输出报告
  --emit <file>           走一遍规范定版流程，导出签名后的文档（供 S5/S2 交叉验证）
  -v, --verbose           打印每条用例结果
  -h, --help              显示帮助
`;

function parseArgs(argv) {
  const out = { noncompliant: false, adapter: null, baseUrl: null, report: null, emit: null, verbose: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--noncompliant') out.noncompliant = true;
    else if (a === '--adapter') out.adapter = argv[++i];
    else if (a === '--base-url') out.baseUrl = argv[++i];
    else if (a === '--json') out.report = argv[++i];
    else if (a === '--emit') out.emit = argv[++i];
    else if (a === '-v' || a === '--verbose') out.verbose = true;
    else if (a === '-h' || a === '--help') out.help = true;
  }
  return out;
}

/**
 * 规范定版流程（用于 --emit）：走完"AI 建议 → 人工采纳并改稿 → 人工确认 → 数据更新 → 机读重算 → 签章"
 * 产出的文档可交给 S5（结构+语义校验）与 S2（序列化保真）做交叉验证，形成工具链闭环。
 */
async function canonicalSignedDoc(store) {
  const { suggestionId } = await store.suggestText(
    {
      nodeId: 'n_t',
      text: '结合病史与体征，考虑社区获得性肺炎。',
      confidence: 0.96,
      modelId: 'local/qwen-med:7b@2026-09',
      promptId: 'tpl-assessment-v3',
      evidence: [{ kind: 'lis', ref: 'LIS:20261008-0100:WBC', valueText: '9.8' }],
    },
    AI,
  );
  await store.acceptSuggestion({ suggestionId, editedText: '结合病史与体征，考虑社区获得性肺炎，建议抗感染治疗并复查。' }, HUMAN);
  await store.confirmNode({ nodeId: 'n_t' }, HUMAN);
  await store.setFieldValue({ nodeId: 'n_f2', value: 38.7, valueText: '38.7' }, HUMAN);
  await store.exportMachineReadable();
  await store.sign({}, HUMAN);
  return store.getDoc();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }

  let createStore = defaultCreateStore;
  let implLabel = 'lib/doc-store.mjs（内存参考实现）';
  if (args.adapter) {
    if (!existsSync(args.adapter)) {
      process.stderr.write(`找不到适配器：${args.adapter}\n`);
      process.exit(2);
    }
    const mod = await import(pathToFileURL(resolve(args.adapter)).href);
    if (typeof mod.createStore !== 'function') {
      process.stderr.write(`适配器必须导出 createStore(doc, options)：${args.adapter}\n`);
      process.exit(2);
    }
    createStore = mod.createStore;
    implLabel = `${args.adapter}${args.baseUrl ? ` @ ${args.baseUrl}` : ''}`;
    if (args.baseUrl) process.env.EMR_BASE_URL = args.baseUrl;
  }

  const results = [];
  for (const c of CASES) {
    let store;
    try {
      store = createStore(baseDoc(), { noncompliant: args.noncompliant, baseUrl: args.baseUrl || undefined });
    } catch (e) {
      results.push({ id: c.id, group: c.group, name: c.name, pass: false, message: `创建实现失败：${e.message}` });
      continue;
    }
    let pass = true;
    let message = '';
    try {
      await c.run(store);
    } catch (e) {
      pass = false;
      message = e?.message || String(e);
    }
    results.push({ id: c.id, group: c.group, name: c.name, pass, message });
  }

  const failed = results.filter((r) => !r.pass);
  const failedIds = failed.map((r) => r.id);
  const expected = EXPECTED_NONCOMPLIANT_FAILURES;
  const matched = failedIds.length === expected.length && expected.every((id) => failedIds.includes(id));

  const out = [];
  const w = (s) => out.push(s);
  w('');
  w(`S4 契约测试  |  被测实现：${implLabel}${args.noncompliant ? '（noncompliant 模式）' : ''}`);
  w('─'.repeat(72));
  if (args.verbose) {
    let group = '';
    for (const r of results) {
      if (r.group !== group) {
        group = r.group;
        w(`[${group}]`);
      }
      w(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.id}  ${r.name}`);
      if (!r.pass) w(`        ${r.message}`);
    }
  } else {
    const byGroup = new Map();
    for (const r of results) {
      if (!byGroup.has(r.group)) byGroup.set(r.group, []);
      byGroup.get(r.group).push(r);
    }
    for (const [g, list] of byGroup) {
      const okCount = list.filter((r) => r.pass).length;
      w(`${okCount === list.length ? 'PASS' : 'FAIL'}  ${g}  ${okCount}/${list.length}`);
    }
    for (const r of failed) w(`      ${r.id}  ${r.name}\n        ${r.message}`);
  }
  w('─'.repeat(72));
  w(`用例数：${results.length}    通过：${results.length - failed.length}    失败：${failed.length}`);

  let verdict;
  if (args.noncompliant) {
    verdict = matched ? 'PASS' : 'FAIL';
    w(`鉴别力自证：设计违规点 ${expected.length} 个，实际识别 ${failedIds.length} 个 → ${matched ? '精确命中' : '不符合预期'}`);
    if (!matched) {
      const missed = expected.filter((id) => !failedIds.includes(id));
      const extra = failedIds.filter((id) => !expected.includes(id));
      if (missed.length) w(`  漏检（用例集强度不足）：${missed.join(', ')}`);
      if (extra.length) w(`  多检（用例与实现约定不一致）：${extra.join(', ')}`);
    }
  } else {
    verdict = failed.length === 0 ? 'PASS' : 'FAIL';
  }
  w(`结论：${verdict}`);
  w('说明：本测试从 API 层发起，前端拦截不算通过；所有"被拒"用例都校验了具体错误码。');
  w('');
  process.stdout.write(out.join('\n'));

  if (args.emit) {
    const store = createStore(baseDoc(), { noncompliant: args.noncompliant, baseUrl: args.baseUrl || undefined });
    const doc = await canonicalSignedDoc(store);
    writeFileSync(args.emit, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
    process.stdout.write(`规范定版文档已导出（供 S5/S2 交叉验证）：${args.emit}  status=${doc.status}\n`);
  }

  if (args.report) {
    writeFileSync(
      args.report,
      `${JSON.stringify({ tool: 'ai-path-check', version: '1.0.0', generatedAt: new Date().toISOString(), mode: args.noncompliant ? 'noncompliant' : 'compliant', impl: implLabel, results, failedIds, expectedNoncompliantFailures: expected, verdict }, null, 2)}\n`,
      'utf8',
    );
    process.stdout.write(`报告已写入：${args.report}\n`);
  }

  process.exit(verdict === 'PASS' ? 0 : 1);
}

main();
