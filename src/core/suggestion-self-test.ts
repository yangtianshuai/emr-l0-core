/**
 * T10~T15 验收自测：AI 建议通道与门控。
 *
 *   node src/core/suggestion-self-test.ts
 *
 * 两部分：
 *   A 契约用例（TS 真实实现）—— 直接对应 S4 的 26 条契约，逐条断言行为与错误码；
 *   B 跨实现一致性 —— 同一批场景分别跑「TS 真实实现」与「工具链 JS 参考实现（doc-store）」，
 *     要求两者的"成功/错误码"完全一致。**双实现交叉验证**能抓住"两套实现各自看起来都对、
 *     但语义已经漂移"的问题（例如阈值口径、门控顺序、状态机边界的差异）。
 *
 * 未覆盖（归属其他任务）：机读信息派生与陈旧检测（T04/T16）、OFD 导出计划校验（T17）。
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WriteSession, type Actor, type WriteOptions } from './session.ts';
import { editBandOf, editRatioOf, SuggestionBook, type SuggestionAttribution, type SuggestionMetrics } from './suggestions.ts';

const SAMPLES = join(fileURLToPath(new URL('../../', import.meta.url)), 'tools', 'model-check', 'samples');
import { buildSyntheticDoc } from '../testing/synthetic.ts';
import { TestSuite, assert, assertEqual, codeOfAsync } from '../testing/harness.ts';
import type { DocNode, DocumentModel, NodeId } from '../model/types.ts';

const HUMAN: Actor = { id: 'DR_T', kind: 'human' };
const AI: Actor = { id: 'ai-pipeline', kind: 'ai' };

const suite = new TestSuite('T10~T15 AI 建议通道与门控自测', [
  '说明：A 部分逐条断言契约行为；B 部分要求 TS 实现与工具链 JS 参考实现的判定完全一致。',
]);

const test = (name: string, fn: () => void | Promise<void>): Promise<void> => suite.test(name, fn);

function fixture() {
  return buildSyntheticDoc({ sections: 2, paragraphsPerSection: 2, fieldsPerParagraph: 1 });
}

function open(options: Parameters<typeof WriteSession.open>[1] = {}): { session: WriteSession; ids: ReturnType<typeof fixture>['ids'] } {
  const { doc, ids } = fixture();
  return { session: WriteSession.open(doc, options), ids };
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
    return 'OK';
  } catch (err) {
    const code = (err as { code?: string }).code;
    return code ?? `UNEXPECTED:${(err as Error).message}`;
  }
}

function textOf(session: WriteSession, nodeId: NodeId): string {
  const node = session.document.nodes[nodeId] as Extract<DocNode, { type: 'text' }>;
  return node.runs.map((run) => run.text).join('');
}

/* --------------------------------- A 部分 --------------------------------- */

async function partA(): Promise<void> {
  await test('A1 生成建议不落笔、不留痕、不改 rev（门控在落笔，不在生成）', async () => {
    const { session, ids } = open();
    const textId = ids.textIds[0] as NodeId;
    const nodesBefore = JSON.stringify(session.document.nodes);
    const revBefore = session.docRev;
    const { suggestionId } = session.suggestText({ nodeId: textId, text: 'AI 草稿', confidence: 0.99, modelId: 'm1', promptId: 'p1' }, AI);
    assertEqual(JSON.stringify(session.document.nodes), nodesBefore, '节点表不应被改动');
    assertEqual(session.docRev, revBefore, '文档 rev 不应改变');
    assert(!!session.listSuggestions({ status: 'pending' }).find((item) => item.id === suggestionId), '建议应可在 pending 列表看到');
    assertEqual(session.verifyInvariants(), [], '不变量应成立');
  });

  await test('A2 低置信建议仍可展示（可被人工改后再采纳）', async () => {
    const { session, ids } = open();
    const { suggestionId } = session.suggestText({ nodeId: ids.textIds[0] as NodeId, text: 'AI 草稿', confidence: 0.4, modelId: 'm1' }, AI);
    const pending = session.listSuggestions({ status: 'pending' });
    assertEqual(pending.length, 1, '低置信建议应可见');
    assertEqual(pending[0]?.id, suggestionId, '应能取到该建议');
  });

  await test('A3 一般内容 0.60 < 0.75：采纳被拒', async () => {
    const { session, ids } = open();
    const { suggestionId } = session.suggestText({ nodeId: ids.textIds[0] as NodeId, text: '草稿', confidence: 0.6, modelId: 'm1' }, AI);
    const code = codeOf(() => session.acceptSuggestion({ suggestionId }, HUMAN));
    assertEqual(code, 'E_AI_LOW_CONFIDENCE', '低置信不得落笔');
    assertEqual(textOf(session, ids.textIds[0] as NodeId).includes('草稿'), false, '被拒后不应落笔');
  });

  await test('A4 关键内容 0.85 < 0.90：采纳被拒（阈值按节点属性切换）', async () => {
    const { session, ids } = open();
    const textId = ids.textIds[0] as NodeId;
    session.updateNodeProps({ nodeId: textId, patch: { keyContent: true } }, HUMAN);
    const { suggestionId } = session.suggestText({ nodeId: textId, text: '草稿', confidence: 0.85, modelId: 'm1' }, AI);
    assertEqual(codeOf(() => session.acceptSuggestion({ suggestionId }, HUMAN)), 'E_AI_LOW_CONFIDENCE', '关键内容阈值更高');
  });

  await test('A5 关键内容 0.95 可落笔，但 humanConfirmed 仍为 false（采纳 ≠ 确认责任）', async () => {
    const { session, ids } = open();
    const textId = ids.textIds[0] as NodeId;
    session.updateNodeProps({ nodeId: textId, patch: { keyContent: true } }, HUMAN);
    const { suggestionId } = session.suggestText({ nodeId: textId, text: 'AI 草稿', confidence: 0.95, modelId: 'm1', promptId: 'p1' }, AI);
    const result = session.acceptSuggestion({ suggestionId }, HUMAN);
    const node = session.document.nodes[textId] as Extract<DocNode, { type: 'text' }>;
    assertEqual(result.revision, session.docRev, '应产生一条留痕');
    assertEqual(textOf(session, textId), 'AI 草稿', '内容应落笔');
    assertEqual(node.provenance.origin, 'ai', '来源应为 ai');
    assertEqual(node.provenance.acceptedBy, HUMAN.id, '应记录采纳人');
    assertEqual(node.humanConfirmed, false, '采纳不等于确认责任');
    const revision = session.auditLog().at(-1);
    assertEqual(revision?.op, 'accept-ai', '留痕 op 应为 accept-ai');
    assertEqual(revision?.modelId, 'm1', '留痕应带 modelId');
    assertEqual(revision?.confidence, 0.95, '留痕应带 confidence');
    assertEqual(session.verifyInvariants(), [], '落笔后不变量应成立');
  });

  await test('A6 AI 不得确认内容 / 采纳建议 / 拒绝建议', async () => {
    const { session, ids } = open();
    const textId = ids.textIds[0] as NodeId;
    assertEqual(codeOf(() => session.confirmNode({ nodeId: textId }, AI)), 'E_AI_NOT_ALLOWED', 'AI 不得确认内容');
    const { suggestionId } = session.suggestText({ nodeId: textId, text: '草稿', confidence: 0.99, modelId: 'm1' }, AI);
    assertEqual(codeOf(() => session.acceptSuggestion({ suggestionId }, AI)), 'E_AI_NOT_ALLOWED', 'AI 不得采纳建议');
    assertEqual(codeOf(() => session.rejectSuggestion({ suggestionId }, AI)), 'E_AI_NOT_ALLOWED', 'AI 不得拒绝建议');
  });

  await test('A7 人工确认：幂等写入并留痕，未确认时签章被拒', async () => {
    const { session, ids } = open();
    const textId = ids.textIds[0] as NodeId;
    session.updateNodeProps({ nodeId: textId, patch: { keyContent: true } }, HUMAN);
    assertEqual(await codeOfAsync(() => session.sign({}, HUMAN)), 'E_KEY_CONTENT_UNCONFIRMED', '关键内容未确认不得签章');
    session.confirmNode({ nodeId: textId }, HUMAN);
    assertEqual((session.document.nodes[textId] as DocNode).humanConfirmed, true, '应标记已确认');
    assertEqual(await codeOfAsync(() => session.sign({}, HUMAN)), 'OK', '全部确认后应可签章');
    assertEqual(session.document.status, 'signed', '状态应为 signed');
  });

  await test('A8 采纳时人工改稿：计入修改率（最诚实的效果指标）', async () => {
    const { session, ids } = open();
    const textId = ids.textIds[0] as NodeId;
    const { suggestionId } = session.suggestText({ nodeId: textId, text: 'AI 原始草稿', confidence: 0.99, modelId: 'm1' }, AI);
    session.acceptSuggestion({ suggestionId, editedText: '医生修改后的文本' }, HUMAN);
    const suggestion = session.listSuggestions().find((item) => item.id === suggestionId);
    assertEqual(suggestion?.modified, true, '建议应标记为已修改');
    const metrics = session.getMetrics();
    assertEqual(metrics.accepted, 1, '采纳数应为 1');
    assertEqual(metrics.modified, 1, '修改数应为 1');
    assertEqual(metrics.editRate, 1, '修改率应为 1');
    assertEqual(textOf(session, textId), '医生修改后的文本', '应为改后文本');
  });

  await test('A9 拒绝建议：留痕 reject-ai、patch 允许为空、内容不变、拒绝率更新', async () => {
    const { session, ids } = open();
    const textId = ids.textIds[0] as NodeId;
    const before = textOf(session, textId);
    const { suggestionId } = session.suggestText({ nodeId: textId, text: 'AI 草稿', confidence: 0.99, modelId: 'm1' }, AI);
    const result = session.rejectSuggestion({ suggestionId, reason: '与病史不符' }, HUMAN);
    assert(result.ok === true, '拒绝应成功');
    const revision = session.auditLog().at(-1);
    assertEqual(revision?.op, 'reject-ai', '留痕 op 应为 reject-ai');
    assertEqual(revision?.aiSuggestionId, suggestionId, '留痕应关联建议 id');
    assertEqual(revision?.patch, [], 'reject-ai 不改节点，patch 允许为空');
    assertEqual(textOf(session, textId), before, '节点内容不应改变');
    assertEqual(session.getMetrics().rejectRate, 1, '拒绝率应为 1');
    assertEqual(session.verifyInvariants(), [], '不变量应成立');
  });

  await test('A10 状态机：重复采纳/拒绝被拒；不存在的建议报错', async () => {
    const { session, ids } = open();
    const { suggestionId } = session.suggestText({ nodeId: ids.textIds[0] as NodeId, text: '草稿', confidence: 0.99, modelId: 'm1' }, AI);
    session.rejectSuggestion({ suggestionId }, HUMAN);
    assertEqual(codeOf(() => session.rejectSuggestion({ suggestionId }, HUMAN)), 'E_SUGGESTION_STATE', '重复拒绝应被拒');
    assertEqual(codeOf(() => session.acceptSuggestion({ suggestionId }, HUMAN)), 'E_SUGGESTION_STATE', '已拒绝不可再采纳');
    assertEqual(codeOf(() => session.acceptSuggestion({ suggestionId: 'sg_9999' }, HUMAN)), 'E_SUGGESTION_NOT_FOUND', '不存在的建议应报错');
  });

  await test('A11 建议必须携带 modelId 与 confidence（否则无法审计）', async () => {
    const { session, ids } = open();
    const textId = ids.textIds[0] as NodeId;
    assertEqual(
      codeOf(() => session.suggestText({ nodeId: textId, text: 'x', confidence: 0.9, modelId: '' }, AI)),
      'E_AI_NO_PROVENANCE',
      '缺 modelId 应被拒',
    );
    assertEqual(
      codeOf(() => session.suggestText({ nodeId: textId, text: 'x', confidence: Number.NaN, modelId: 'm1' }, AI)),
      'E_AI_NO_PROVENANCE',
      '缺 confidence 应被拒',
    );
  });

  await test('A12 签章门控：未确认 AI 内容不得签章，签章覆盖机读文件', async () => {
    const { session, ids } = open();
    const textId = ids.textIds[0] as NodeId;
    const { suggestionId } = session.suggestText({ nodeId: textId, text: 'AI 草稿', confidence: 0.99, modelId: 'm1' }, AI);
    session.acceptSuggestion({ suggestionId }, HUMAN);
    assertEqual(await codeOfAsync(() => session.sign({}, HUMAN)), 'E_SIGNED_WITH_UNCONFIRMED_AI', '未确认 AI 内容不得签章');
    session.confirmNode({ nodeId: textId }, HUMAN);
    await session.sign({}, HUMAN);
    const covers = session.document.signatureRefs?.[0]?.covers ?? [];
    assert(covers.some((item) => /MachineReadable/.test(item)), `签名必须覆盖机读文件，实际：${covers.join(',')}`);
    assertEqual(session.auditLog().some((revision) => revision.op === 'sign'), true, '应留痕 sign');
  });

  await test('A13 签章后文档不可直接改动（须走解锁流程）', async () => {
    const { session, ids } = open();
    await session.sign({}, HUMAN);
    assertEqual(
      codeOf(() => session.insertText({ nodeId: ids.textIds[0] as NodeId, text: '改已签名文档' }, HUMAN)),
      'E_SIGNED_IMMUTABLE',
      '已签章不得直接改',
    );
    assertEqual(
      codeOf(() => {
        const { suggestionId } = (() => {
          const r = session.suggestText({ nodeId: ids.textIds[1] as NodeId, text: 'AI', confidence: 0.99, modelId: 'm1' }, AI);
          return { suggestionId: r.suggestionId };
        })();
        return session.acceptSuggestion({ suggestionId }, HUMAN);
      }),
      'E_SIGNED_IMMUTABLE',
      '已签章后采纳建议也应被拒',
    );
  });

  await test('A14 AI 来源链：人工续改后 origin 变 human 但保留 derivedFrom', async () => {
    const { session, ids } = open();
    const textId = ids.textIds[0] as NodeId;
    const { suggestionId } = session.suggestText({ nodeId: textId, text: 'AI 草稿', confidence: 0.99, modelId: 'local/qwen-med:7b@2026-09' }, AI);
    session.acceptSuggestion({ suggestionId }, HUMAN);
    session.confirmNode({ nodeId: textId }, HUMAN);
    session.insertText({ nodeId: textId, text: '（医生补充）' }, HUMAN);
    const node = session.document.nodes[textId] as Extract<DocNode, { type: 'text' }>;
    assertEqual(node.provenance.origin, 'human', 'origin 应变为 human');
    assertEqual(node.provenance.derivedFrom?.modelId, 'local/qwen-med:7b@2026-09', 'derivedFrom 应保留模型标识');
    assertEqual(node.provenance.derivedFrom?.editedBy, HUMAN.id, 'derivedFrom 应记录编辑人');
    assertEqual(session.getMetrics().editRate, 0, '未经改稿的采纳不应计入修改率');
  });

  /* ---------- A15~A21：建议分组（一次提交 = 一组）与批量门控 ---------- */

  await test('A15 批量提交 = 一组：不落笔、不留痕、不改 rev；组 ID 由存储层生成', async () => {
    const { session, ids } = open();
    const before = JSON.stringify(session.document.nodes);
    const revBefore = session.docRev;
    const batch = session.suggestBatch(
      {
        modelId: 'local/qwen-med:7b@2026-09',
        traceId: 'trace-001',
        items: ids.textIds.slice(0, 3).map((id, index) => ({ nodeId: id as NodeId, text: `草稿${index}`, confidence: 0.9 })),
      },
      AI,
    );
    assertEqual(batch.suggestionIds.length, 3, '三条都应生成');
    assertEqual(JSON.stringify(session.document.nodes), before, '生成建议不应改节点');
    assertEqual(session.docRev, revBefore, '生成建议不应改 rev');
    const inGroup = session.listSuggestions({ groupId: batch.groupId });
    assertEqual(inGroup.length, 3, '三条应同属一组');
    assertEqual(
      inGroup.every((item) => item.status === 'pending'),
      true,
      '都应是 pending',
    );
    assertEqual(inGroup[0]?.traceId, 'trace-001', 'traceId 应透传（与 groupId 各司其职）');
    /* 组 ID 系统生成：调用方给不了，也就无法把两批不相干的建议并成一组。
       注意 `groupId` **可能为空** —— 那只会发生在"整批都与仍待处理的旧建议同文本"时
       （那种情况不建组，见 `SuggestionBook.addBatch`）；这里三条都是新文本，必须建了组。 */
    assert((batch.groupId ?? '').startsWith('grp_'), `组 ID 应系统生成，实际 ${batch.groupId}`);
    assertEqual(session.verifyInvariants(), [], '不变量应成立');
  });

  await test('A16 组级采纳**仍逐条过门控**：够门槛的落笔、不够的保持待处理（不是拒绝）', async () => {
    const { session, ids } = open();
    const first = ids.textIds[0] as NodeId;
    const second = ids.textIds[1] as NodeId;
    /* 第二条设为关键内容（阈值 0.90），组内混入一条不够门槛的 */
    session.updateNodeProps({ nodeId: second, patch: { keyContent: true } }, HUMAN);
    const { groupId } = session.suggestBatch(
      {
        modelId: 'm1',
        items: [
          { nodeId: first, text: '一般内容草稿', confidence: 0.8 },
          { nodeId: second, text: '关键内容草稿', confidence: 0.8 },
        ],
      },
      AI,
    );
    const result = session.acceptSuggestions({ groupId }, HUMAN);
    assertEqual(result.accepted.length, 1, '只有够门槛的一条应落笔');
    assertEqual(result.blocked.length, 1, '另一条应被如实报告为被拦（不能静默跳过）');
    assertEqual(result.blocked[0]?.code, 'E_AI_LOW_CONFIDENCE', '被拦原因应为置信度不足');
    assertEqual(textOf(session, first), '一般内容草稿', '够门槛的应落笔');
    assertEqual(textOf(session, second).includes('关键内容草稿'), false, '不够门槛的不得落笔');
    /* 关键：被拦的条目仍是 pending —— 医生没有拒绝它，算成拒绝会污染拒绝率 */
    const stillPending = session.listSuggestions({ groupId, status: 'pending' });
    assertEqual(stillPending.length, 1, '被拦的条目应保持待处理');
    assertEqual(stillPending[0]?.id, result.blocked[0]?.suggestionId, '保持待处理的正是被拦那一条');
    assertEqual(session.getMetrics().rejected, 0, '置信度不足不得计入拒绝（与"医生不认可"是两件事）');
    const node = session.document.nodes[first] as Extract<DocNode, { type: 'text' }>;
    assertEqual(node.humanConfirmed, false, '批量采纳不等于确认责任');
    assertEqual(session.verifyInvariants(), [], '不变量应成立');
  });

  await test('A17 组级采纳：一条都没够门槛时不提交、不留痕、不改 rev；AI 不得调用', async () => {
    const { session, ids } = open();
    const textId = ids.textIds[0] as NodeId;
    session.updateNodeProps({ nodeId: textId, patch: { keyContent: true } }, HUMAN);
    const { groupId } = session.suggestBatch({ modelId: 'm1', items: [{ nodeId: textId, text: '草稿', confidence: 0.5 }] }, AI);
    const revBefore = session.docRev;
    const logBefore = session.auditLog().length;
    const result = session.acceptSuggestions({ groupId }, HUMAN);
    assertEqual(result.ok, false, '一条都没落笔时 ok 应为 false');
    assertEqual(session.docRev, revBefore, '没有落笔就不应改 rev');
    assertEqual(session.auditLog().length, logBefore, '没有落笔就不应留痕（否则日志里全是无内容的记录）');
    assertEqual(codeOf(() => session.acceptSuggestions({ groupId }, AI)), 'E_AI_NOT_ALLOWED', 'AI 不得批量采纳（批量不是提权通道）');
    assertEqual(codeOf(() => session.rejectSuggestions({ groupId }, AI)), 'E_AI_NOT_ALLOWED', 'AI 不得批量拒绝');
  });

  await test('A18 组不存状态：计数全由条状态推导，指标口径仍按条算', async () => {
    const { session, ids } = open();
    const { groupId } = session.suggestBatch(
      {
        modelId: 'm1',
        items: [
          { nodeId: ids.textIds[0] as NodeId, text: '草稿A', confidence: 0.9 },
          { nodeId: ids.textIds[1] as NodeId, text: '草稿B', confidence: 0.9 },
          { nodeId: ids.textIds[2] as NodeId, text: '草稿C', confidence: 0.9 },
        ],
      },
      AI,
    );
    const items = session.listSuggestions({ groupId });
    /* 逐条处理成"部分完成"：组不该因此产生一个"部分接受"状态 */
    session.acceptSuggestion({ suggestionId: String(items[0]?.id) }, HUMAN);
    session.rejectSuggestion({ suggestionId: String(items[1]?.id) }, HUMAN);

    const group = session.listSuggestionGroups().find((item) => item.groupId === groupId);
    assert(!!group, '应能查到该组');
    assertEqual(group?.total, 3, '组内总数');
    assertEqual(group?.accepted, 1, '已采纳计数应由条状态推导');
    assertEqual(group?.rejected, 1, '已拒绝计数应由条状态推导');
    assertEqual(group?.pending, 1, '待处理 = total - accepted - rejected');
    assertEqual(group?.targetNodeIds.length, 3, '组内目标节点应去重列出');

    /* 指标口径不变：按条算。组不参与统计，否则"采纳率"会随提交方式变化 */
    const metrics = session.getMetrics();
    assertEqual(metrics.suggested, 3, '建议数按条算');
    assertEqual(metrics.accepted, 1, '采纳数按条算');
    assertEqual(metrics.adoptionRate.toFixed(4), '0.3333', '采纳率按条算');
  });

  await test('A19 组级拒绝：一次留痕并记录整批范围；内容不变；组内不再有待处理', async () => {
    const { session, ids } = open();
    const first = ids.textIds[0] as NodeId;
    const second = ids.textIds[1] as NodeId;
    const before = [textOf(session, first), textOf(session, second)];
    const { groupId } = session.suggestBatch(
      {
        modelId: 'm1',
        items: [
          { nodeId: first, text: '草稿A', confidence: 0.9 },
          { nodeId: second, text: '草稿B', confidence: 0.9 },
        ],
      },
      AI,
    );
    const logBefore = session.auditLog().length;
    const result = session.rejectSuggestions({ groupId, reason: '整批与病史不符' }, HUMAN);
    assertEqual(result.rejected.length, 2, '两条都应被拒');
    assertEqual(session.auditLog().length, logBefore + 1, '批量拒绝应只产生一条留痕（不是每条一条）');
    const revision = session.auditLog().at(-1);
    assertEqual(revision?.op, 'reject-ai', '留痕 op 应为 reject-ai');
    assertEqual((revision?.aiSuggestionIds ?? []).length, 2, '留痕必须记录整批范围（否则事后说不清处理了哪一批）');
    assertEqual(revision?.patch, [], 'reject-ai 不改节点，patch 为空');
    assertEqual([textOf(session, first), textOf(session, second)], before, '拒绝不应改内容');
    assertEqual(session.listSuggestions({ groupId, status: 'pending' }).length, 0, '组内不应再有待处理');
    /* 必须查不变量：留痕新增字段（aiSuggestionIds）要同时登记进模型校验白名单，
       否则"批量拒绝后的文档"会以 E_UNKNOWN_FIELD 通不过校验 —— 不查就发现不了 */
    assertEqual(session.verifyInvariants(), [], '不变量应成立');
  });

  await test('A20 批量范围必须唯一且非空：同时给/都不给/空数组/不存在都是显式错误', async () => {
    const { session, ids } = open();
    const { groupId, suggestionIds } = session.suggestBatch(
      { modelId: 'm1', items: [{ nodeId: ids.textIds[0] as NodeId, text: '草稿', confidence: 0.9 }] },
      AI,
    );
    assertEqual(
      codeOf(() => session.acceptSuggestions({ groupId, suggestionIds }, HUMAN)),
      'E_SUGGESTION_SCOPE_REQUIRED',
      '同时给两个范围应被拒（取并集就说不清操作了什么）',
    );
    assertEqual(codeOf(() => session.acceptSuggestions({}, HUMAN)), 'E_SUGGESTION_SCOPE_REQUIRED', '不给范围应被拒');
    assertEqual(
      codeOf(() => session.acceptSuggestions({ suggestionIds: [] }, HUMAN)),
      'E_SUGGESTION_SCOPE_REQUIRED',
      '空数组应被拒（空范围操作不能静默成功）',
    );
    assertEqual(codeOf(() => session.suggestBatch({ modelId: 'm1', items: [] }, AI)), 'E_SUGGESTION_SCOPE_REQUIRED', '空批次应被拒');
    assertEqual(
      codeOf(() => session.acceptSuggestions({ suggestionIds: ['sg_9999'] }, HUMAN)),
      'E_SUGGESTION_NOT_FOUND',
      '显式指定不存在的建议应报错',
    );

    /* 两种范围的语义有意不同：显式指定已处理的条目报状态错；按组操作则跳过已处理项 */
    session.acceptSuggestion({ suggestionId: suggestionIds[0] as string }, HUMAN);
    assertEqual(
      codeOf(() => session.acceptSuggestions({ suggestionIds }, HUMAN)),
      'E_SUGGESTION_STATE',
      '显式指定已处理的建议应报状态错',
    );
    assertEqual(
      codeOf(() => session.acceptSuggestions({ groupId }, HUMAN)),
      'E_SUGGESTION_STATE',
      '组内已无待处理时应报错（避免"点了没反应"）',
    );
  });

  await test('A21 提交方式不进指纹：批量提交与逐条提交的跨实现比对结果相同', async () => {
    const batched = open();
    const oneByOne = open();
    const specs = [
      { nodeId: batched.ids.textIds[0] as NodeId, text: '草稿1', confidence: 0.9 },
      { nodeId: batched.ids.textIds[1] as NodeId, text: '草稿2', confidence: 0.95 },
    ];
    batched.session.suggestBatch({ modelId: 'm1', items: specs }, AI);
    for (const spec of specs) oneByOne.session.suggestText({ ...spec, modelId: 'm1' }, AI);

    assertEqual(
      batched.session.suggestionFingerprint(),
      oneByOne.session.suggestionFingerprint(),
      '提交方式不应影响指纹（组是操作层，不是建议内容）',
    );
    assertEqual(batched.session.listSuggestionGroups().length, 1, '批量提交应有一组');
    assertEqual(oneByOne.session.listSuggestionGroups().length, 0, '逐条提交不应产生组');
  });

  /* ---------- A22~A23：生成幂等（连点不膨胀建议数，也不膨胀指标） ---------- */

  await test('A22 单条幂等：同目标 + 同文本且仍待处理 → 复用；已处理的**不挡住**"再要一条"', async () => {
    const { session, ids } = open();
    const spec = { nodeId: ids.textIds[0] as NodeId, text: '离线模板续写', confidence: 0.95, modelId: 'offline:x' };

    /* ① 连点两次：第二次复用同一条 —— 建议数与 `suggested` 都不膨胀。
       这一条是**根因**所在：产出方可以是确定性的，而"生成"是医生能连点的动作，
       不去重就会让指标随点击次数失真（采纳率/拒绝率是要进质量报表的数字）。 */
    const first = session.suggestText(spec, AI);
    const second = session.suggestText(spec, AI);
    assertEqual(second.suggestionId, first.suggestionId, '同目标同文本且仍待处理时应复用同一条');
    assertEqual(second.reused, true, '应如实回报"复用了已有建议"（否则界面只能表现成"点了没反应"）');
    assertEqual(session.listSuggestions().length, 1, '建议数不应随点击次数膨胀');
    assertEqual(session.getMetrics().suggested, 1, '指标也不应膨胀');

    /* ② 文本不同就是另一条：产出方换了内容，就是新建议 */
    const other = session.suggestText({ ...spec, text: '另一段内容' }, AI);
    assertEqual(other.reused, false, '文本不同不应复用');
    assertEqual(session.listSuggestions().length, 2, '文本不同应新建');

    /* ③ 已被采纳 / 已被拒绝 → **允许再建**：医生再点"生成一条"是主动再要一条，
       被旧决定挡住会表现成"点了没反应"，那比重复更糟 */
    session.acceptSuggestion({ suggestionId: first.suggestionId }, HUMAN);
    const again = session.suggestText(spec, AI);
    assertEqual(again.reused, false, '已采纳的不算重复');
    assert(again.suggestionId !== first.suggestionId, '应是一条新建议');
    session.rejectSuggestion({ suggestionId: again.suggestionId, reason: '不合要求' }, HUMAN);
    const third = session.suggestText(spec, AI);
    assertEqual(third.reused, false, '已拒绝的也不该挡住"再要一条"');
  });

  await test('A23 整批幂等：重复的留在原组；全重复**不建组**，也不推进组号', async () => {
    const { session, ids } = open();
    const first = ids.textIds[0] as NodeId;
    const second = ids.textIds[1] as NodeId;
    const spec = (nodeId: NodeId, text: string) => ({ nodeId, text, confidence: 0.9 });

    const base = session.suggestBatch({ modelId: 'm1', items: [spec(first, 'A'), spec(second, 'B')] }, AI);
    assert((base.groupId ?? '').startsWith('grp_'), '首次整批应建组');
    const baseGroup = base.groupId as string;

    /* ① 部分重复：只有新文本进新组，重复的那条**留在它原来的组里**（复用不改原条，
       组是历史事实，不因复用而转移） */
    const mixed = session.suggestBatch({ modelId: 'm1', items: [spec(first, 'A'), spec(second, 'C')] }, AI);
    assertEqual(mixed.reused.length, 1, '重复的那条应如实列入 reused');
    assertEqual(mixed.reused[0], base.suggestionIds[0], 'reused 里应是原有那条的 id');
    assertEqual(mixed.suggestionIds.length, 1, '只有新文本进新组');
    assert(mixed.groupId !== baseGroup, '新文本应编入新组');
    assertEqual(session.listSuggestions({ groupId: baseGroup }).length, 2, '原组仍是两条');
    assertEqual(session.listSuggestions({ groupId: mixed.groupId as string }).length, 1, '新组只有新增那条');

    /* ② 全重复：不建组、不推进组号 —— 空组会让界面的"接受本组"落在一个不存在的范围上 */
    const groupsBefore = session.listSuggestionGroups().length;
    const allDuplicate = session.suggestBatch({ modelId: 'm1', items: [spec(first, 'A'), spec(second, 'B')] }, AI);
    assertEqual(allDuplicate.groupId, undefined, '全重复不应建组');
    assertEqual(allDuplicate.suggestionIds.length, 0, '全重复不应新增建议');
    assertEqual(allDuplicate.reused.length, 2, '两条都应如实回报复用');
    assertEqual(session.listSuggestionGroups().length, groupsBefore, '不应多出一个空组');
  });

  /* ---------- A24~A28：三级归因（"改了没有"之外，还要回答"改得轻还是重"） ---------- */

  await test('A24 改动幅度：一字未改记 0，不计修改率，也不进任何"改过"的档', async () => {
    const { session, ids } = open();
    const textId = ids.textIds[0] as NodeId;
    const { suggestionId } = session.suggestText({ nodeId: textId, text: 'AI 草稿原文', confidence: 0.99, modelId: 'm1' }, AI);
    session.acceptSuggestion({ suggestionId }, HUMAN);

    const suggestion = session.listSuggestions().find((item) => item.id === suggestionId);
    assertEqual(suggestion?.editRatio, 0, '一字未改时改动幅度应为 0');
    assertEqual(suggestion?.modified, false, '原样采纳不应计入修改率');

    const attribution = session.getSuggestionAttribution();
    assertEqual(attribution.accepted, 1, '采纳数应为 1');
    assertEqual(attribution.asIs, 1, '应归入"原样采纳"');
    assertEqual(attribution.light, 0, '不应归入微改');
    assertEqual(attribution.heavy, 0, '不应归入大改');
    assertEqual(attribution.unknown, 0, '不应出现未归因');
    assertEqual(attribution.asIsShare, 1, '原样占比应为 1');
  });

  await test('A25 改动幅度分档：改一个词 → 微改；整句重写 → 大改', async () => {
    const { session, ids } = open();
    const first = ids.textIds[0] as NodeId;
    const second = ids.textIds[1] as NodeId;
    /* 长文本 + 一处小改：剥掉公共前后缀后只剩一个字符，比例必然很小 */
    const long = '患者今日体温正常，无咳嗽咳痰，精神可，饮食睡眠可，二便正常。';
    const light = session.suggestText({ nodeId: first, text: long, confidence: 0.99, modelId: 'm1' }, AI);
    session.acceptSuggestion({ suggestionId: light.suggestionId, editedText: long.replace('精神可', '精神尚可') }, HUMAN);
    /* 短文本 + 整句重写：比例必然很大 */
    const heavy = session.suggestText({ nodeId: second, text: '考虑肺炎', confidence: 0.99, modelId: 'm1' }, AI);
    session.acceptSuggestion({ suggestionId: heavy.suggestionId, editedText: '考虑急性支气管炎，建议复查胸片' }, HUMAN);

    const attribution = session.getSuggestionAttribution();
    assertEqual(attribution.accepted, 2, '两条都应采纳');
    assertEqual(attribution.asIs, 0, '两条都不是原样');
    assertEqual(attribution.light, 1, '改一个词应归入微改');
    assertEqual(attribution.heavy, 1, '整句重写应归入大改');

    const lightItem = session.listSuggestions().find((item) => item.id === light.suggestionId);
    assert(
      typeof lightItem?.editRatio === 'number' && lightItem.editRatio > 0 && lightItem.editRatio <= 0.2,
      `微改的幅度应落在 (0, 0.2]，实际 ${lightItem?.editRatio}`,
    );
    assertEqual(lightItem?.modified, true, '有改动就仍要计入修改率（原口径不变）');
  });

  await test('A26 归因恒等式：四类之和恒等于采纳数，且与 metrics 的采纳数同源', async () => {
    const { session, ids } = open();
    /* 一条原样、一条微改、一条大改、外加一条拒绝（拒绝**不进归因**，它有自己的原因） */
    const asIs = session.suggestText({ nodeId: ids.textIds[0] as NodeId, text: '原文', confidence: 0.99, modelId: 'm1' }, AI);
    session.acceptSuggestion({ suggestionId: asIs.suggestionId }, HUMAN);
    /* 微改样本：只加一个"尚"字。注意 0.2 的边界**并不宽松** ——
       "甲：无异常。"改成"甲：未见异常。"（加两字 / 共七字）已经是 0.29，直接翻成大改；
       所以界面上"微改"这一档描述的确实是"只动了措辞" */
    const light = session.suggestText({ nodeId: ids.textIds[1] as NodeId, text: '甲：体温正常，精神可。', confidence: 0.99, modelId: 'm1' }, AI);
    session.acceptSuggestion({ suggestionId: light.suggestionId, editedText: '甲：体温正常，精神尚可。' }, HUMAN);
    const heavy = session.suggestText({ nodeId: ids.textIds[2] as NodeId, text: '考虑肺炎', confidence: 0.99, modelId: 'm1' }, AI);
    session.acceptSuggestion({ suggestionId: heavy.suggestionId, editedText: '考虑急性支气管炎，建议复查胸片，必要时住院' }, HUMAN);
    const rejected = session.suggestText({ nodeId: ids.textIds[3] as NodeId, text: '不与病史相符的结论', confidence: 0.99, modelId: 'm1' }, AI);
    session.rejectSuggestion({ suggestionId: rejected.suggestionId, reason: '与病史不符' }, HUMAN);

    const attribution = session.getSuggestionAttribution();
    assertEqual(
      attribution.asIs + attribution.light + attribution.heavy + attribution.unknown,
      attribution.accepted,
      '恒等式不成立就是有采纳没被归因（界面据此自查，而不是当成四舍五入）',
    );
    assertEqual(attribution.accepted, session.getMetrics().accepted, '采纳数必须与 metrics 相等（同一份数据，两个视图）');
    assertEqual(attribution.accepted, 3, '被拒的那条不进归因');
    assertEqual(attribution.asIs, 1, '一条原样');
    assertEqual(attribution.light, 1, '一条微改');
    assertEqual(attribution.heavy, 1, '一条大改');
    /* 占比分母是**采纳数**（含未归因）：把 unknown 从分母里拿掉，指标会随老数据存量无声变好 */
    assertEqual(attribution.asIsShare.toFixed(4), '0.3333', '占比分母应为采纳数');
  });

  await test('A27 未归因的采纳单列：老数据不能被读成"原样采纳"', async () => {
    /* `editRatio` 是这次才加的字段，老快照里的采纳没有它。
       默认成"原样采纳"恰好把指标推向**模型表现最好的一档** ——
       这正是本仓库反复拒绝的那种"把不知道说成知道"。 */
    const book = SuggestionBook.restore({
      seq: 1,
      groupSeq: 0,
      items: [
        {
          id: 'sg_0001',
          targetNodeId: 'n1',
          text: 'x',
          confidence: 0.9,
          modelId: 'm1',
          status: 'accepted',
          modified: false,
          at: '2026-10-16T00:00:00.000Z',
        },
      ],
    });
    const attribution = book.attribution();
    assertEqual(attribution.accepted, 1, '采纳数应照实算');
    assertEqual(attribution.asIs, 0, '没有幅度记录就不能算"原样采纳"');
    assertEqual(attribution.unknown, 1, '应单列为未归因');
    assertEqual(attribution.asIsShare, 0, '占比里也不该把它算进原样');
    assertEqual(book.metrics().accepted, 1, '与 metrics 仍是同一份数据');
  });

  await test('A28 改动幅度算法：顺序变了必须算改动（"不同字符数"口径会漏报）', async () => {
    assertEqual(editRatioOf('同样一句话', '同样一句话'), 0, '完全相同应为 0');
    assertEqual(editRatioOf('', ''), 0, '都为空应为 0');
    assertEqual(editRatioOf('', '新增内容'), 1, '从无到有应为 1');
    /* "血压偏高" → "偏高血压"：字符集合完全相同、顺序不同。
       用"不同字符数"算会得出 0（该记的改动被漏掉）；编辑距离会如实算成改动。 */
    assert(editRatioOf('血压偏高', '偏高血压') > 0.5, '字符顺序变了必须算改动');
    /* 长文本里改一个字：剥公共前后缀后只剩一个字符，比例极小 */
    const base = '患者今日体温正常，无咳嗽咳痰，精神可，饮食睡眠可，二便正常。';
    assert(editRatioOf(base, base.replace('精神可', '精神尚可')) <= 0.2, '一处小改应落在微改档内');
    /* 分档边界：`light` 是**闭区间**（≤），差一点就翻档 */
    assertEqual(editBandOf(0), 'as-is', '0 是原样');
    assertEqual(editBandOf(0.2), 'light', '边界值算微改（≤）');
    assertEqual(editBandOf(0.2000001), 'heavy', '刚过边界算大改');
  });

  await test('A29 逐句采纳：只给被采纳的句子标 AI 来源，医生保留的原句不标', async () => {
    const { session, ids } = open();
    const textId = ids.textIds[0] as NodeId;
    session.updateNodeProps({ nodeId: textId, patch: { runs: [{ text: '患者自诉发热。' }] } }, HUMAN);
    const { suggestionId } = session.suggestText(
      { nodeId: textId, text: '患者自诉发热。伴咳嗽三天。', confidence: 0.99, modelId: 'm1' },
      AI,
    );
    const finalText = '患者自诉发热。伴咳嗽三天。';
    const aiStart = finalText.indexOf('伴咳嗽');
    session.acceptSuggestion(
      { suggestionId, editedText: finalText, aiRanges: [{ start: aiStart, end: finalText.length }] },
      HUMAN,
    );
    const node = session.document.nodes[textId] as Extract<DocNode, { type: 'text' }>;
    assertEqual(textOf(session, textId), finalText, '正文应是组合后的整段');
    assertEqual(node.runs.length, 2, '应切成"原句 + AI 句"两个 run（多的说明没合并或没按区间切）');
    assertEqual(node.runs[0]?.provenance, undefined, '医生保留的原句不得标 AI 来源');
    assertEqual(node.runs[1]?.provenance?.origin, 'ai', '被采纳的句子应标 AI');
    assertEqual(node.runs[1]?.provenance?.suggestionId, suggestionId, '逐句来源要能指回这条建议');
    assertEqual(node.runs[1]?.provenance?.confidence, 0.99, '句级也带该建议的置信度');
    assertEqual(node.provenance.origin, 'ai', '节点级仍记"这条建议被采纳"（与句级来源是两件事）');
  });

  await test('A30 逐句区间不合法即拒绝落笔（越界 / 重叠 / 空区间），且文档不变', async () => {
    const { session, ids } = open();
    const textId = ids.textIds[0] as NodeId;
    const before = textOf(session, textId);
    const { suggestionId } = session.suggestText({ nodeId: textId, text: '一二三四', confidence: 0.99, modelId: 'm1' }, AI);
    assertEqual(
      codeOf(() => session.acceptSuggestion({ suggestionId, aiRanges: [{ start: 0, end: 99 }] }, HUMAN)),
      'E_OFFSET_RANGE',
      '越界应被拒',
    );
    assertEqual(
      codeOf(() => session.acceptSuggestion({ suggestionId, aiRanges: [{ start: 0, end: 3 }, { start: 2, end: 4 }] }, HUMAN)),
      'E_OFFSET_RANGE',
      '重叠应被拒（否则同一段字符会有两种来源）',
    );
    assertEqual(
      codeOf(() => session.acceptSuggestion({ suggestionId, aiRanges: [{ start: 1, end: 1 }] }, HUMAN)),
      'E_OFFSET_RANGE',
      '空区间应被拒（空数组才表示"一句都没用"）',
    );
    assertEqual(textOf(session, textId), before, '被拒时不得改动文档');
    const still = session.listSuggestions().find((item) => item.id === suggestionId);
    assertEqual(still?.status, 'pending', '被拒后建议仍应待处理（不能悄悄消费掉）');
  });

  await test('A31 空区间数组：采纳了但一句没用 → 正文里没有任何字符标 AI', async () => {
    const { session, ids } = open();
    const textId = ids.textIds[0] as NodeId;
    session.updateNodeProps({ nodeId: textId, patch: { runs: [{ text: '医生原句。' }] } }, HUMAN);
    const { suggestionId } = session.suggestText({ nodeId: textId, text: 'AI 想写的话。', confidence: 0.99, modelId: 'm1' }, AI);
    session.acceptSuggestion({ suggestionId, editedText: '医生原句。', aiRanges: [] }, HUMAN);
    const node = session.document.nodes[textId] as Extract<DocNode, { type: 'text' }>;
    assertEqual(textOf(session, textId), '医生原句。', '正文应保持医生写的那句');
    assertEqual(node.runs.length, 1, '没有 AI 字符就不该多出一段 run');
    assertEqual(node.runs[0]?.provenance, undefined, '一个字符都不该标 AI');
    /* 节点级仍是 ai：这是一次"采纳"的决策记录，与"谁逐字写了哪些字"分开记 */
    assertEqual(node.provenance.origin, 'ai', '节点级记录采纳行为');
  });
}

/* --------------------------------- B 部分 --------------------------------- */

interface Ids {
  textId: NodeId;
  secondTextId: NodeId;
  fieldId: NodeId;
}

/** 直接复用真实实现的参数类型，避免适配层出现"两套参数定义"而悄悄漂移 */
type MethodKey = 'suggestText' | 'acceptSuggestion' | 'rejectSuggestion' | 'confirmNode' | 'sign' | 'insertText' | 'updateNodeProps' | 'deleteNode';
type P<M extends MethodKey> = Parameters<WriteSession[M]>[0];

interface ScenarioApi {
  suggestText(p: P<'suggestText'>, a: Actor): unknown;
  acceptSuggestion(p: P<'acceptSuggestion'>, a: Actor): unknown;
  rejectSuggestion(p: P<'rejectSuggestion'>, a: Actor): unknown;
  confirmNode(p: P<'confirmNode'>, a: Actor): unknown;
  sign(p: P<'sign'>, a: Actor): unknown;
  insertText(p: P<'insertText'>, a: Actor, o?: WriteOptions): unknown;
  updateNodeProps(p: P<'updateNodeProps'>, a: Actor): unknown;
  deleteNode(p: P<'deleteNode'>, a: Actor): unknown;
  getNode(id: NodeId): { humanConfirmed?: boolean; provenance?: { origin?: string } } | null;
  getDoc(): { status: string; revisions: unknown[] };
  listSuggestions(): Array<{ id: string; status: string; modified?: boolean }>;
  getMetrics(): SuggestionMetrics;
  getSuggestionAttribution(): SuggestionAttribution;
}

interface Scenario {
  name: string;
  expect: string;
  /** 允许返回 Promise：签章走签名后端，可能是异步的（测试里必须 await 它，否则失败会被吞掉） */
  run: (api: ScenarioApi, ids: Ids) => unknown | Promise<unknown>;
}

interface RawStore {
  suggestText(p: unknown, a: unknown): unknown;
  acceptSuggestion(p: unknown, a: unknown): unknown;
  rejectSuggestion(p: unknown, a: unknown): unknown;
  confirmNode(p: unknown, a: unknown): unknown;
  sign(p: unknown, a: unknown): unknown;
  insertText(p: unknown, a: unknown, o?: unknown): unknown;
  updateNodeProps(p: unknown, a: unknown): unknown;
  deleteNode(p: unknown, a: unknown): unknown;
  getNode(id: string): { humanConfirmed?: boolean; provenance?: { origin?: string } } | null;
  getDoc(): { status: string; revisions: unknown[] };
  listSuggestions(f?: unknown): Array<{ id: string; status: string; modified?: boolean }>;
  getMetrics(): SuggestionMetrics;
  getSuggestionAttribution(): SuggestionAttribution;
}

function tsAdapter(session: WriteSession): ScenarioApi {
  return {
    suggestText: (p, a) => session.suggestText(p, a),
    acceptSuggestion: (p, a) => session.acceptSuggestion(p, a),
    rejectSuggestion: (p, a) => session.rejectSuggestion(p, a),
    confirmNode: (p, a) => session.confirmNode(p, a),
    sign: (p, a) => session.sign(p, a),
    insertText: (p, a, o) => session.insertText(p, a, o),
    updateNodeProps: (p, a) => session.updateNodeProps(p, a),
    deleteNode: (p, a) => session.deleteNode(p, a),
    getNode: (id) => {
      const node = session.getNode(id);
      return node ? { humanConfirmed: node.humanConfirmed, provenance: { origin: node.provenance?.origin } } : null;
    },
    getDoc: () => ({ status: session.document.status, revisions: session.auditLog() }),
    listSuggestions: () => session.listSuggestions().map((item) => ({ id: item.id, status: item.status, modified: item.modified })),
    getMetrics: () => session.getMetrics(),
    getSuggestionAttribution: () => session.getSuggestionAttribution(),
  };
}

function jsAdapter(raw: RawStore): ScenarioApi {
  return {
    suggestText: (p, a) => raw.suggestText(p, a),
    acceptSuggestion: (p, a) => raw.acceptSuggestion(p, a),
    rejectSuggestion: (p, a) => raw.rejectSuggestion(p, a),
    confirmNode: (p, a) => raw.confirmNode(p, a),
    sign: (p, a) => raw.sign(p, a),
    insertText: (p, a, o) => raw.insertText(p, a, o),
    updateNodeProps: (p, a) => raw.updateNodeProps(p, a),
    deleteNode: (p, a) => raw.deleteNode(p, a),
    getNode: (id) => raw.getNode(id),
    getDoc: () => raw.getDoc(),
    listSuggestions: () => raw.listSuggestions(),
    getMetrics: () => raw.getMetrics(),
    getSuggestionAttribution: () => raw.getSuggestionAttribution(),
  };
}

const SUGGEST = (nodeId: NodeId, confidence: number) => ({ nodeId, text: 'AI 草稿', confidence, modelId: 'm1', promptId: 'p1' });

const SCENARIOS: Scenario[] = [
  { name: 'AI 直接写 insertText', expect: 'E_AI_DIRECT_WRITE_FORBIDDEN', run: (api, ids) => api.insertText({ nodeId: ids.textId, text: 'AI 直写' }, AI) },
  { name: '一般内容低置信采纳', expect: 'E_AI_LOW_CONFIDENCE', run: (api, ids) => api.acceptSuggestion({ suggestionId: suggestId(api, ids.textId, 0.6) }, HUMAN) },
  {
    name: '关键内容 0.85 采纳',
    expect: 'E_AI_LOW_CONFIDENCE',
    run: async (api, ids) => {
      api.updateNodeProps({ nodeId: ids.textId, patch: { keyContent: true } }, HUMAN);
      api.acceptSuggestion({ suggestionId: suggestId(api, ids.textId, 0.85) }, HUMAN);
    },
  },
  {
    name: '关键内容 0.95 采纳',
    expect: 'OK',
    run: async (api, ids) => {
      api.updateNodeProps({ nodeId: ids.textId, patch: { keyContent: true } }, HUMAN);
      api.acceptSuggestion({ suggestionId: suggestId(api, ids.textId, 0.95) }, HUMAN);
    },
  },
  { name: 'AI 确认内容', expect: 'E_AI_NOT_ALLOWED', run: (api, ids) => api.confirmNode({ nodeId: ids.textId }, AI) },
  { name: 'AI 采纳建议', expect: 'E_AI_NOT_ALLOWED', run: (api, ids) => api.acceptSuggestion({ suggestionId: suggestId(api, ids.textId, 0.99) }, AI) },
  { name: 'AI 拒绝建议', expect: 'E_AI_NOT_ALLOWED', run: (api, ids) => api.rejectSuggestion({ suggestionId: suggestId(api, ids.textId, 0.99) }, AI) },
  {
    name: '未确认 AI 内容签章',
    expect: 'E_SIGNED_WITH_UNCONFIRMED_AI',
    run: async (api, ids) => {
      api.acceptSuggestion({ suggestionId: suggestId(api, ids.textId, 0.99) }, HUMAN);
      await api.sign({}, HUMAN);
    },
  },
  {
    name: '全部确认后签章',
    expect: 'OK',
    run: async (api, ids) => {
      api.acceptSuggestion({ suggestionId: suggestId(api, ids.textId, 0.99) }, HUMAN);
      api.confirmNode({ nodeId: ids.textId }, HUMAN);
      await api.sign({}, HUMAN);
    },
  },
  {
    name: '签章后改文档',
    expect: 'E_SIGNED_IMMUTABLE',
    run: async (api, ids) => {
      await api.sign({}, HUMAN);
      api.insertText({ nodeId: ids.textId, text: 'X' }, HUMAN);
    },
  },
  {
    name: '删除关键内容节点',
    expect: 'E_KEY_CONTENT_PROTECTED',
    run: async (api, ids) => {
      api.updateNodeProps({ nodeId: ids.fieldId, patch: { keyContent: true, humanConfirmed: true } }, HUMAN);
      api.deleteNode({ nodeId: ids.fieldId }, HUMAN);
    },
  },
  { name: '乐观锁过期', expect: 'E_REV_CONFLICT', run: (api, ids) => api.insertText({ nodeId: ids.textId, text: 'X' }, HUMAN, { expectedRev: 0 }) },
  {
    name: '重复拒绝建议',
    expect: 'E_SUGGESTION_STATE',
    run: async (api, ids) => {
      const suggestionId = suggestId(api, ids.textId, 0.99);
      api.rejectSuggestion({ suggestionId }, HUMAN);
      api.rejectSuggestion({ suggestionId }, HUMAN);
    },
  },
  { name: '采纳不存在的建议', expect: 'E_SUGGESTION_NOT_FOUND', run: (api) => api.acceptSuggestion({ suggestionId: 'sg_9999' }, HUMAN) },
  {
    name: '建议缺少置信度',
    expect: 'E_AI_NO_PROVENANCE',
    run: (api, ids) => api.suggestText({ nodeId: ids.textId, text: 'x', confidence: Number.NaN, modelId: 'm1' }, AI),
  },
  {
    name: '关键内容未确认签章',
    expect: 'E_KEY_CONTENT_UNCONFIRMED',
    run: async (api, ids) => {
      api.updateNodeProps({ nodeId: ids.fieldId, patch: { keyContent: true } }, HUMAN);
      await api.sign({}, HUMAN);
    },
  },
];

function suggestId(api: ScenarioApi, nodeId: NodeId, confidence: number): string {
  const result = api.suggestText(SUGGEST(nodeId, confidence), AI) as { suggestionId: string };
  return result.suggestionId;
}

async function partB(createJsStore: (doc: unknown, options?: unknown) => RawStore): Promise<void> {
  for (const scenario of SCENARIOS) {
    await test(`B 跨实现一致性：${scenario.name}`, async () => {
      const tsFixture = fixture();
      const tsSession = WriteSession.open(tsFixture.doc);
      const tsIds: Ids = {
        textId: tsFixture.ids.textIds[0] as NodeId,
        secondTextId: tsFixture.ids.textIds[1] as NodeId,
        fieldId: tsFixture.ids.fieldIds[0] as NodeId,
      };
      const jsFixture = fixture();
      const jsStore = createJsStore(structuredClone(jsFixture.doc), {});
      const jsIds: Ids = {
        textId: jsFixture.ids.textIds[0] as NodeId,
        secondTextId: jsFixture.ids.textIds[1] as NodeId,
        fieldId: jsFixture.ids.fieldIds[0] as NodeId,
      };

      /* 用**异步版**：签章场景返回 Promise，同步 codeOf 抓不到它的拒绝
         （那会让"应当被拒"的场景假装通过 —— 这次改造里真实踩到过） */
      const tsOutcome = await codeOfAsync(() => scenario.run(tsAdapter(tsSession), tsIds));
      const jsOutcome = await codeOfAsync(() => scenario.run(jsAdapter(jsStore), jsIds));

      assertEqual(tsOutcome, scenario.expect, `TS 实现判定不符（场景：${scenario.name}）`);
      assertEqual(jsOutcome, scenario.expect, `JS 参考实现判定不符（场景：${scenario.name}）`);
      assertEqual(tsOutcome, jsOutcome, `两套实现判定不一致（场景：${scenario.name}）`);
    });
  }
}

async function main(): Promise<void> {
  await partA();

  const jsModule = (await import('../../tools/model-check/lib/doc-store.mjs')) as {
    createStore: (doc: unknown, options?: unknown) => RawStore;
  };
  await partB((doc, options) => jsModule.createStore(doc, options));

  await test('C 交叉验收：走完"AI 采纳 → 人工确认 → 签章"并产出供 S5/S2 复核的文档', async () => {
    const { session, ids } = open();
    const textId = ids.textIds[0] as NodeId;
    const { suggestionId } = session.suggestText(
      {
        nodeId: textId,
        text: '结合病史与体征，考虑社区获得性肺炎。',
        confidence: 0.96,
        modelId: 'local/qwen-med:7b@2026-09',
        promptId: 'tpl-assessment-v3',
        evidence: [{ kind: 'lis', ref: 'LIS:20261008-0100:WBC', valueText: '9.8' }],
      },
      AI,
    );
    session.acceptSuggestion({ suggestionId, editedText: '结合病史与体征，考虑社区获得性肺炎，建议抗感染治疗并复查。' }, HUMAN);
    session.confirmNode({ nodeId: textId }, HUMAN);
    await session.sign({}, HUMAN);

    assertEqual(session.document.status, 'signed', '应完成签章');
    assertEqual(session.verifyInvariants(), [], '定版后不变量应成立');
    const metrics = session.getMetrics();
    assertEqual({ suggested: metrics.suggested, accepted: metrics.accepted, modified: metrics.modified }, { suggested: 1, accepted: 1, modified: 1 }, '统计应可回放');

    if (!existsSync(SAMPLES)) mkdirSync(SAMPLES, { recursive: true });
    writeFileSync(join(SAMPLES, 'ts-suggest-output.json'), `${session.exportJson({ pretty: true })}\n`, 'utf8');
    assert(existsSync(join(SAMPLES, 'ts-suggest-output.json')), '应写出 ts-suggest-output.json');
  });

  await test('B 汇总：两套实现的统计口径一致（采纳/修改/拒绝率）', async () => {
    const tsFixture = fixture();
    const tsSession = WriteSession.open(tsFixture.doc);
    const jsFixture = fixture();
    const jsStore = jsModule.createStore(structuredClone(jsFixture.doc), {});

    for (const api of [tsAdapter(tsSession), jsAdapter(jsStore)] as ScenarioApi[]) {
      const first = suggestId(api, tsFixture.ids.textIds[0] as NodeId, 0.99);
      api.acceptSuggestion({ suggestionId: first, editedText: '改过的文本' }, HUMAN);
      const second = suggestId(api, tsFixture.ids.textIds[1] as NodeId, 0.99);
      api.acceptSuggestion({ suggestionId: second }, HUMAN);
      const third = suggestId(api, tsFixture.ids.textIds[1] as NodeId, 0.99);
      api.rejectSuggestion({ suggestionId: third, reason: '不同意' }, HUMAN);
    }

    const tsMetrics = tsSession.getMetrics();
    const jsMetrics = jsStore.getMetrics();
    assertEqual(
      { suggested: tsMetrics.suggested, accepted: tsMetrics.accepted, rejected: tsMetrics.rejected, modified: tsMetrics.modified },
      { suggested: jsMetrics.suggested, accepted: jsMetrics.accepted, rejected: jsMetrics.rejected, modified: jsMetrics.modified },
      '统计明细应一致',
    );
    assertEqual(tsMetrics.editRate, jsMetrics.editRate, '修改率应一致');
    assertEqual(tsMetrics.rejectRate, jsMetrics.rejectRate, '拒绝率应一致');
    assertEqual(tsMetrics.adoptionRate, jsMetrics.adoptionRate, '采纳率应一致');
    assert(tsMetrics.editRate > 0 && tsMetrics.editRate < 1, `修改率应在 (0,1) 之间，实际 ${tsMetrics.editRate}`);

    /* 三级归因同样跨实现比对：改动幅度是一个**算法**（剥公共前后缀、滚动数组边界、
       分档的闭区间），两套实现各写一遍正是双实现验证的意义 ——
       任何一处漂移都会在这里露出来，而不是等到某天发现两张报表对不上 */
    const tsAttribution = tsSession.getSuggestionAttribution();
    assertEqual(tsAttribution, jsStore.getSuggestionAttribution(), '三级归因应逐项一致');
    assertEqual(
      { asIs: tsAttribution.asIs, light: tsAttribution.light, heavy: tsAttribution.heavy, unknown: tsAttribution.unknown },
      { asIs: 1, light: 0, heavy: 1, unknown: 0 },
      'B 场景：一条原样采纳、一条整段改写、一条被拒（拒绝不进归因）',
    );
  });

  process.exit(suite.report());
}

void main();
