import { TestSuite, assert, assertEqual } from '../testing/harness.ts';
import { AiContextError, buildAiContext, type AiContextPackage } from './ai-context.ts';
import { WriteSession } from './session.ts';
import type { DocumentModel } from '../model/types.ts';

const suite = new TestSuite('AI 上下文包与续写切片自测', [
  '说明：本套验证"AI 能力接入的最小闭环"，不涉及模型效果；效果只能由评测集测量。',
]);

const test = (name: string, fn: () => void | Promise<void>): Promise<void> => suite.test(name, fn);

const AI = { id: 'ai-pipeline', kind: 'ai' as const };
const DOCTOR = { id: 'DR_WANG', kind: 'human' as const };

function codeOf(fn: () => unknown): string {
  try {
    fn();
    return '(未抛错)';
  } catch (err) {
    return (err as { code?: string }).code ?? '(无错误码)';
  }
}

function fixtureDoc(): DocumentModel {
  const at = '2026-10-08T01:00:00Z';
  const prov = (origin: 'human' | 'system', actorId: string) => ({ origin, actorId, at });
  return {
    schemaVersion: '1.0.0',
    docId: 'doc_ai_ctx_1',
    docType: { system: 'WST500', code: 'WST500.2', display: '门（急）诊病历' },
    patient: { patientId: 'P9001', nameMasked: '张**', gender: 'M', birthDate: '1980-05-06' },
    status: 'draft',
    createdAt: at,
    updatedAt: at,
    createdBy: 'DR_WANG',
    rootId: 'n_root',
    nodes: {
      n_root: { id: 'n_root', type: 'document', parentId: null, order: 0, rev: 1, provenance: prov('system', 'seed') },
      n_sec: {
        id: 'n_sec',
        type: 'section',
        parentId: 'n_root',
        order: 10,
        rev: 1,
        title: '现病史',
        sectionCode: 'WST500.2.002',
        provenance: prov('human', 'DR_WANG'),
      },
      n_p: { id: 'n_p', type: 'paragraph', parentId: 'n_sec', order: 10, rev: 1, provenance: prov('human', 'DR_WANG') },
      n_t: {
        id: 'n_t',
        type: 'text',
        parentId: 'n_p',
        order: 10,
        rev: 1,
        runs: [{ text: '患者3天前出现咳嗽。' }],
        provenance: prov('human', 'DR_WANG'),
      },
      n_kt: {
        id: 'n_kt',
        type: 'text',
        parentId: 'n_p',
        order: 20,
        rev: 1,
        keyContent: true,
        runs: [{ text: '初步诊断待补。' }],
        provenance: prov('human', 'DR_WANG'),
      },
      n_f: {
        id: 'n_f',
        type: 'field',
        parentId: 'n_p',
        order: 30,
        rev: 1,
        dataType: 'number',
        value: 37,
        valueText: '37',
        unit: '℃',
        tags: [{ system: 'WS445', code: 'DE05.01.001', display: '体温' }],
        provenance: prov('system', 'system/lis'),
      },
    },
    revisions: [],
  } as unknown as DocumentModel;
}

/** 去掉时间戳后的包（用于比对"两次调用内容是否完全一致"） */
function withoutTimestamp(pkg: AiContextPackage): string {
  return JSON.stringify({ ...pkg, audit: { ...pkg.audit, at: '(time)' } });
}

async function main(): Promise<void> {

  await test('A1 不传范围必须被拒：无范围取数等于把整份病历交给模型', () => {
    const doc = fixtureDoc();
    assertEqual(
      codeOf(() => buildAiContext(doc, { nodeIds: [], actor: AI })),
      'E_AI_CONTEXT_SCOPE_REQUIRED',
      '空范围必须拒绝',
    );
    assertEqual(
      codeOf(() => buildAiContext(doc, { nodeIds: undefined as never, actor: AI })),
      'E_AI_CONTEXT_SCOPE_REQUIRED',
      '缺省范围必须拒绝（而不是默认全量）',
    );
  });

  await test('A2 目标节点不存在 → 明确报错，而不是给个空包假装成功', () => {
    const doc = fixtureDoc();
    assertEqual(
      codeOf(() => buildAiContext(doc, { nodeIds: ['n_不存在'], actor: AI })),
      'E_AI_CONTEXT_EMPTY',
      '全部目标缺失应报错',
    );
    /* 部分缺失：不报错，但必须如实列出 missingNodeIds */
    const pkg = buildAiContext(doc, { nodeIds: ['n_t', 'n_也不存在'], actor: AI });
    assertEqual(pkg.audit.missingNodeIds, ['n_也不存在'], '部分缺失必须如实上报');
  });

  await test('B1 默认不含患者标识，且 patientId 绝不出现在包里', () => {
    const doc = fixtureDoc();
    const pkg = buildAiContext(doc, { nodeIds: ['n_t'], actor: AI });
    assertEqual(pkg.patient, undefined, '默认不带患者标识');
    assert(!JSON.stringify(pkg).includes('P9001'), '包内绝不能出现 patientId（含审计回执）');
    assertEqual(pkg.policy.maskStrategy, 'mask-person-name', '必须声明复用导入侧的脱敏策略');
  });

  await test('B2 确实需要患者标识时：只给掩码，且绝不回落到 patientId', () => {
    const doc = fixtureDoc();
    const pkg = buildAiContext(doc, { nodeIds: ['n_t'], includePatient: true, actor: AI });
    assertEqual(pkg.patient?.nameMasked, '张**', '姓名应为掩码');
    assert(!JSON.stringify(pkg).includes('P9001'), '即使显式要求，也不得出现 patientId');

    const noName = fixtureDoc();
    noName.patient = { patientId: 'P9002' };
    const pkg2 = buildAiContext(noName, { nodeIds: ['n_t'], includePatient: true, actor: AI });
    assertEqual(pkg2.patient?.nameMasked, '（未脱敏）', '姓名缺失时写"（未脱敏）"，而不是塞 patientId');
  });

  await test('C1 确定性：同一文档同一请求，两次给出完全相同的包（否则效果无法回放）', () => {
    const doc = fixtureDoc();
    const request = { nodeIds: ['n_t'], contextBefore: 2, contextAfter: 2, actor: AI };
    const a = buildAiContext(doc, request);
    const b = buildAiContext(doc, request);
    assertEqual(withoutTimestamp(a), withoutTimestamp(b), '两次调用内容必须逐字一致');
  });

  await test('C2 预算裁剪：超预算如实计数，与回执口径一致', () => {
    const doc = fixtureDoc();
    const scope = { nodeIds: ['n_t'], contextBefore: 5, contextAfter: 5, actor: AI };
    const small = buildAiContext(doc, { ...scope, tokenBudget: 12 });
    assert(small.stats.droppedByBudget > 0, `小预算应丢弃条目，实际 ${small.stats.droppedByBudget}`);
    assertEqual(small.audit.droppedByBudget, small.stats.droppedByBudget, '回执与统计必须同一口径');
    assert(small.stats.chars <= small.stats.tokenBudget, `字符数 ${small.stats.chars} 不应超过预算 ${small.stats.tokenBudget}`);

    const big = buildAiContext(doc, { ...scope, tokenBudget: 100000 });
    assertEqual(big.stats.droppedByBudget, 0, '预算充足不应丢弃');
    assert(
      big.stats.items >= small.stats.items,
      `预算更大时应给出不少于小预算的内容（大 ${big.stats.items} / 小 ${small.stats.items}）`,
    );
    assert(big.stats.chars >= small.stats.chars, '预算更大时内容字符数不应减少');
  });

  await test('C3 上下文角色：目标/上文/下文按文档顺序标注', () => {
    const doc = fixtureDoc();
    const pkg = buildAiContext(doc, { nodeIds: ['n_t'], contextBefore: 2, contextAfter: 2, actor: AI });
    const roles = pkg.items.map((item) => `${item.role}:${item.nodeId}`);
    assert(roles.includes('target:n_t'), `应含目标条目，实际 ${roles.join(', ')}`);
    assert(roles.includes('before:n_sec'), `应含上文条目，实际 ${roles.join(', ')}`);
    assert(roles.includes('after:n_kt'), `应含下文条目，实际 ${roles.join(', ')}`);
  });

  await test('C4 机读标签按需附带：默认不带，要求时带 tag 与来源', () => {
    const doc = fixtureDoc();
    const plain = buildAiContext(doc, { nodeIds: ['n_f'], actor: AI });
    assertEqual(plain.items[0]?.tag, undefined, '默认不带机读标签');

    const withTag = buildAiContext(doc, { nodeIds: ['n_f'], includeDataElements: true, actor: AI });
    assertEqual(withTag.items[0]?.tag?.code, 'DE05.01.001', '要求时应带标签');
    assertEqual(withTag.items[0]?.origin, 'system', '条目应带来源（让模型知道这段是谁写的）');
  });

  await test('C5 没进上下文的目标要留名字：空段与超预算是两种不同的沉默', () => {
    const doc = fixtureDoc();
    (doc.nodes.n_kt as unknown as { runs: unknown[] }).runs = [];
    const pkg = buildAiContext(doc, { nodeIds: ['n_t', 'n_kt'], contextBefore: 0, contextAfter: 0, actor: AI });
    assertEqual(pkg.items.some((item) => item.nodeId === 'n_kt'), false, '空段确实没进上下文');
    assertEqual(pkg.audit.droppedTargets.length, 1, '它必须出现在丢弃名单里');
    assertEqual(pkg.audit.droppedTargets[0]?.nodeId, 'n_kt', '名单里就是它');
    assertEqual(pkg.audit.droppedTargets[0]?.code, 'empty-target', '原因是"空段"，不是"超预算"');

    /* 预算挤掉的是另一档：两者必须能分开，否则界面只能说一句含糊的"没进上下文" */
    const squeezed = buildAiContext(fixtureDoc(), { nodeIds: ['n_t', 'n_kt'], contextBefore: 0, contextAfter: 0, actor: AI, tokenBudget: 5 });
    assertEqual(squeezed.audit.droppedTargets.length, 2, '两个目标都进不去');
    assertEqual(
      squeezed.audit.droppedTargets.every((drop) => drop.code === 'context-budget'),
      true,
      '这一组的原因都应是"超预算"',
    );
    assertEqual(squeezed.audit.droppedTargets.length <= squeezed.audit.droppedByBudget, true, '名单不得多于计数');
  });

  await test('C6 只有 target 才进丢弃名单：背景被裁掉不构成沉默', () => {
    const doc = fixtureDoc();
    const pkg = buildAiContext(doc, { nodeIds: ['n_f'], contextBefore: 1, contextAfter: 0, actor: AI, tokenBudget: 6 });
    assert(pkg.audit.droppedByBudget > 0, `前置：应确有背景条目被挤掉，实际 ${pkg.audit.droppedByBudget}`);
    assertEqual(pkg.audit.droppedTargets.length, 0, '被裁掉的是背景节点，不该进沉默名单');
  });

  await test('D1 续写闭环：上下文 → AI 出建议 → AI 不得自采 → 人工采纳 → 来源链与指标', () => {
    const session = WriteSession.open(fixtureDoc());

    const pkg = buildAiContext(session.document, { nodeIds: ['n_t'], contextBefore: 1, actor: AI });
    assert(pkg.items.length > 0, '应能取到续写所需上下文');
    assert(!JSON.stringify(pkg).includes('P9001'), '上下文包不得带患者标识');

    const suggestion = session.suggestText(
      { nodeId: 'n_t', text: '患者3天前出现咳嗽，伴发热，最高体温38.5℃。', confidence: 0.82, modelId: 'demo-model' },
      AI,
    );
    assert(suggestion.suggestionId.trim() !== '', `应返回建议 id，实际 ${JSON.stringify(suggestion.suggestionId)}`);
    const nodeBefore = session.getNode('n_t') as unknown as { runs: Array<{ text: string }> };
    assertEqual(nodeBefore.runs[0]?.text, '患者3天前出现咳嗽。', '建议态不得落笔');

    assertEqual(
      codeOf(() => session.acceptSuggestion({ suggestionId: suggestion.suggestionId }, AI)),
      'E_AI_NOT_ALLOWED',
      'AI 不得采纳建议',
    );

    session.acceptSuggestion({ suggestionId: suggestion.suggestionId }, DOCTOR);
    const node = session.getNode('n_t') as unknown as {
      runs: Array<{ text: string }>;
      provenance: { origin: string; modelId?: string; confidence?: number };
      humanConfirmed?: boolean;
    };
    assertEqual(node.runs[0]?.text, '患者3天前出现咳嗽，伴发热，最高体温38.5℃。', '采纳后应落笔');
    assertEqual(node.provenance.origin, 'ai', '落笔后必须保留 AI 来源');
    assertEqual(node.provenance.modelId, 'demo-model', '来源链应记录模型标识');
    assertEqual(node.humanConfirmed, false, '采纳 ≠ 确认责任，仍待人工确认');

    const metrics = session.getMetrics();
    assertEqual(metrics.adoptionRate, 1, '应有 1 条被采纳');
    assertEqual(metrics.editRate, 0, '未人工改稿，修改率应为 0');
  });

  await test('D2 门控按目标节点判定：关键内容 0.82 不得落笔（调用方无权声明"这不关键"）', () => {
    const session = WriteSession.open(fixtureDoc());
    const suggestion = session.suggestText(
      { nodeId: 'n_kt', text: '初步诊断：急性支气管炎。', confidence: 0.82, modelId: 'demo-model' },
      AI,
    );
    assertEqual(
      codeOf(() => session.acceptSuggestion({ suggestionId: suggestion.suggestionId }, DOCTOR)),
      'E_AI_LOW_CONFIDENCE',
      '关键内容阈值 0.90，0.82 不得落笔',
    );

    const normal = session.suggestText(
      { nodeId: 'n_t', text: '补充：夜间咳嗽加重。', confidence: 0.82, modelId: 'demo-model' },
      AI,
    );
    assertEqual(session.acceptSuggestion({ suggestionId: normal.suggestionId }, DOCTOR).ok, true, '一般内容 0.82 应可落笔');
  });

  await test('D3 无来源的建议不得生成：modelId/confidence 缺失或越界一律拒绝', () => {
    const session = WriteSession.open(fixtureDoc());
    assertEqual(
      codeOf(() => session.suggestText({ nodeId: 'n_t', text: 'x', confidence: 0.9, modelId: '' }, AI)),
      'E_AI_NO_PROVENANCE',
      '缺 modelId 应拒绝',
    );
    assertEqual(
      codeOf(() => session.suggestText({ nodeId: 'n_t', text: 'x', confidence: Number.NaN, modelId: 'm' }, AI)),
      'E_AI_NO_PROVENANCE',
      'NaN 置信度应拒绝（NaN 比较恒为 false，会绕过门控）',
    );
    assertEqual(
      codeOf(() => session.suggestText({ nodeId: 'n_t', text: 'x', confidence: 1.5, modelId: 'm' }, AI)),
      'E_AI_NO_PROVENANCE',
      '越界置信度应拒绝',
    );
  });

  process.exit(suite.report());
}

void main();
