/**
 * 旁挂注解自测（T30）。
 *
 *   node src/core/annotation-self-test.ts
 *
 * 背景：事中质控（内涵类）与人工批注都需要一个**不属于文档内容**的载体。
 * 走建议通道会污染采纳率/修改率，写进文档树则签章后无法再标记"已处理"。
 *
 * 本套断言的核心不是"能加注解"，而是四个最容易做错的地方（也最容易在改代码时被破坏）：
 *   N1 **注解不是文档内容**：不落笔、不改 rev、不进文档留痕
 *      —— 若混进 `revisions`，"rev 变化 ⇒ 文档变了"这个被机读陈旧判定依赖的前提会失效；
 *   N2 来源必须真实（AI 不得冒充人工）、AI/规则必须给依据；
 *   N3 去重：同键不重复、**已忽略的不复活**、**但内容变了允许重新提示**；
 *   N4~N6 锚点：三态派生、丢失必须人工确认、处置不进文档留痕。
 */

import { TestSuite, assert, assertEqual } from '../testing/harness.ts';
import { WriteSession, type Actor } from './session.ts';
import { buildSyntheticDoc } from '../testing/synthetic.ts';
import type { DocNode, NodeId } from '../model/types.ts';

const suite = new TestSuite('旁挂注解（质控提示 / 人工批注）自测', [
  '说明：注解与建议同源但留存相反 —— 建议被采纳后消失，注解永不消失、处置史留全。',
  'N1/N5 是防回退关键：注解的处置**绝不能**落进文档 rev 与文档留痕。',
]);

const test = (name: string, fn: () => void | Promise<void>): Promise<void> => suite.test(name, fn);

const HUMAN: Actor = { id: 'DR_WANG', kind: 'human' };
const QC: Actor = { id: 'QC_ZHANG', kind: 'human' };
const AI: Actor = { id: 'ai-qc', kind: 'ai' };
const SYSTEM: Actor = { id: 'rule-engine', kind: 'system' };

function open(): { session: WriteSession; ids: ReturnType<typeof buildSyntheticDoc>['ids'] } {
  const { doc, ids } = buildSyntheticDoc({ sections: 2, paragraphsPerSection: 2, fieldsPerParagraph: 1 });
  return { session: WriteSession.open(doc), ids };
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

async function main(): Promise<void> {
  await test('N1 注解不是文档内容：不落笔、不改 rev、不写文档留痕、不变量成立', () => {
    const { session, ids } = open();
    const textId = ids.textIds[0] as NodeId;
    session.insertText({ nodeId: textId, text: '胸痛3天，伴心悸' }, HUMAN);
    const nodes = JSON.stringify(session.document.nodes);
    const rev = session.docRev;
    const logLength = session.auditLog().length;

    const result = session.annotate(
      {
        nodeId: textId,
        title: '主诉与现病史时间不一致',
        quote: '胸痛3天',
        source: { kind: 'ai', modelId: 'local/qwen-med:7b@2026-09' },
        evidence: [{ kind: 'other', ref: '现病史:第2段' }],
      },
      AI,
    );
    assertEqual(result.created, true, '应新增');
    assertEqual(result.anchorState, 'valid', '刚挂上时锚点应有效');
    assertEqual(JSON.stringify(session.document.nodes), nodes, '注解不得改动节点');
    assertEqual(
      session.docRev,
      rev,
      '注解不得改 rev —— 否则"rev 变化 ⇒ 文档变了"这个被机读陈旧判定依赖的前提会失效',
    );
    assertEqual(session.auditLog().length, logLength, '注解不得写进文档留痕');
    assertEqual(session.listAnnotations().length, 1, '注解应在旁挂层可查');
    assertEqual(session.verifyInvariants(), [], '不变量应成立');
  });

  await test('N2 来源必须真实：kind 与提交者一致、AI 必带 modelId、AI/规则必带依据', () => {
    const { session, ids } = open();
    const textId = ids.textIds[0] as NodeId;
    const withEvidence = { nodeId: textId, title: '提示', evidence: [{ kind: 'rule' as const, ref: 'R-001' }] };

    /* AI 冒充人工提交：等于给质控提示伪造责任主体（与身份收口同一条纪律） */
    assertEqual(
      codeOf(() => session.annotate({ ...withEvidence, source: { kind: 'human' } }, AI)),
      'E_ANNOTATION_NO_EVIDENCE',
      'source.kind 必须与提交者一致',
    );
    assertEqual(
      codeOf(() => session.annotate({ ...withEvidence, source: { kind: 'ai' } }, AI)),
      'E_AI_NO_PROVENANCE',
      'AI 注解必带 modelId',
    );
    assertEqual(
      codeOf(() => session.annotate({ nodeId: textId, title: '提示', source: { kind: 'ai', modelId: 'm1' } }, AI)),
      'E_ANNOTATION_NO_EVIDENCE',
      'AI 注解无依据应被拒（无依据的提示只能消耗医生的信任）',
    );
    assertEqual(
      codeOf(() => session.annotate({ nodeId: textId, title: '提示', source: { kind: 'system' } }, SYSTEM)),
      'E_ANNOTATION_NO_EVIDENCE',
      '规则注解无规则号应被拒',
    );
    assertEqual(
      codeOf(() => session.annotate({ nodeId: textId, title: '此处建议补充既往史', source: { kind: 'human' } }, HUMAN)),
      'OK',
      '人工批注不需要依据（医生写的是自己的观察）',
    );
    assertEqual(
      codeOf(() => session.annotate({ nodeId: textId, title: '   ', source: { kind: 'human' } }, HUMAN)),
      'E_ANNOTATION_NO_EVIDENCE',
      '空结论应被拒（说不清的提示，医生也无从处置）',
    );
  });

  await test('N3 去重：同键不重复、已忽略的不复活、但内容变了允许重新提示', () => {
    const { session, ids } = open();
    const textId = ids.textIds[0] as NodeId;
    session.insertText({ nodeId: textId, text: '胸痛3天' }, HUMAN);
    const spec = { nodeId: textId, title: '时限描述与记录时间不一致', source: { kind: 'system' as const, ruleId: 'R-100' }, dedupeKey: 'R-100' };

    const first = session.annotate(spec, SYSTEM);
    assertEqual(first.created, true, '首次应新增');
    const again = session.annotate(spec, SYSTEM);
    assertEqual(again.created, false, '同键重复提交不应新增（规则每 5 分钟跑一次，不该堆出几十条）');
    assertEqual(again.annotationId, first.annotationId, '应复用既有条目');
    assertEqual(session.listAnnotations().length, 1, '仍只有一条');

    session.resolveAnnotation({ annotationId: first.annotationId, status: 'dismissed', note: '本例为复诊，前次已记录' }, QC);
    assertEqual(
      session.annotate(spec, SYSTEM).created,
      false,
      '误报被忽略后、内容未变，不得复活 —— 反复弹回会让医生开始无脑点"忽略"，整套提示都会失效',
    );

    /* 内容变了 → 旧判断只针对当时那段文字，不再适用 */
    session.insertText({ nodeId: textId, text: '（本次新记录）' }, HUMAN);
    assertEqual(session.annotate(spec, SYSTEM).created, true, '内容已改后重新命中，应允许新增');
  });

  await test('N4 锚点三态（派生）：有效 → 可重锚 → 已丢失；非文本节点保守判有效', () => {
    const { session, ids } = open();
    const textId = ids.textIds[0] as NodeId;
    /* 用"改后采纳"把文本写成单 run 的整句（后续才能整段替换） */
    const first = session.suggestText({ nodeId: textId, text: 'x', confidence: 0.99, modelId: 'm1' }, AI);
    session.acceptSuggestion({ suggestionId: first.suggestionId, editedText: '胸痛3天，伴心悸' }, HUMAN);

    const { annotationId } = session.annotate(
      { nodeId: textId, title: '时限描述疑似不一致', quote: '胸痛3天', source: { kind: 'system', ruleId: 'R-200' } },
      SYSTEM,
    );
    const stateOf = (): string => session.listAnnotations().find((item) => item.id === annotationId)?.anchorState ?? 'missing';
    assertEqual(stateOf(), 'valid', '内容未变 → valid');

    session.insertText({ nodeId: textId, text: '（补充）' }, HUMAN);
    assertEqual(stateOf(), 'relocated', '内容变了但原文片段仍在 → 可重锚');

    /* 整段替换：改后采纳替换最后一个 run，此刻该节点只有一个 run */
    const second = session.suggestText({ nodeId: textId, text: 'y', confidence: 0.99, modelId: 'm1' }, AI);
    session.acceptSuggestion({ suggestionId: second.suggestionId, editedText: '腹痛1周' }, HUMAN);
    assertEqual(stateOf(), 'lost', '原文片段已不存在 → 锚点丢失（必须让人看见，不能静默消失）');

    /* 非文本节点不谈内容比较：误报 lost 会让人做无谓的确认 */
    const { annotationId: onRoot } = session.annotate(
      { nodeId: session.document.rootId, title: '本章缺少知情同意记录', source: { kind: 'system', ruleId: 'R-300' } },
      SYSTEM,
    );
    assertEqual(
      session.listAnnotations().find((item) => item.id === onRoot)?.anchorState,
      'valid',
      '非文本节点不应因"内容无法比较"被判丢失',
    );
  });

  await test('N5 处置：仅自然人、终态不可逆、处置史累积，且**不改 rev、不进文档留痕**', () => {
    const { session, ids } = open();
    const textId = ids.textIds[0] as NodeId;
    session.insertText({ nodeId: textId, text: '胸痛3天' }, HUMAN);
    const { annotationId } = session.annotate(
      { nodeId: textId, title: '时限描述疑似不一致', source: { kind: 'system', ruleId: 'R-1' } },
      SYSTEM,
    );
    const rev = session.docRev;
    const logLength = session.auditLog().length;

    assertEqual(
      codeOf(() => session.resolveAnnotation({ annotationId, status: 'resolved' }, AI)),
      'E_AI_NOT_ALLOWED',
      'AI 不得处置自己提出的提示（与"AI 不得采纳自己建议"同一条纪律）',
    );

    const acknowledged = session.resolveAnnotation({ annotationId, status: 'acknowledged', note: '已知悉，本次不改' }, HUMAN);
    assertEqual(acknowledged.status, 'acknowledged', '可先标记已知悉');
    assertEqual(session.docRev, rev, '处置不得改 rev');
    assertEqual(session.auditLog().length, logLength, '处置不得进文档留痕');

    const history = session.listAnnotations().find((item) => item.id === annotationId)?.history ?? [];
    assertEqual(history.length, 2, '"已知悉"与"已解决"在追责上是两回事，处置史必须累积');
    assertEqual(history[0]?.status, 'open', '处置史首条应为 open');
    assertEqual(history[1]?.note, '已知悉，本次不改', '处置史应带备注');

    session.resolveAnnotation({ annotationId, status: 'resolved' }, HUMAN);
    assertEqual(
      codeOf(() => session.resolveAnnotation({ annotationId, status: 'dismissed' }, HUMAN)),
      'E_ANNOTATION_STATE',
      '终态不可再处置（否则"已解决"可以被改成"已忽略"，证据链就断了）',
    );
    assertEqual(
      codeOf(() => session.resolveAnnotation({ annotationId: 'an_9999', status: 'resolved' }, HUMAN)),
      'E_ANNOTATION_NOT_FOUND',
      '不存在的注解应报错',
    );
  });

  await test('N6 锚点丢失必须人工确认：仍有效时被拒；失效后可确认并进处置史', () => {
    const { session, ids } = open();
    const textId = ids.textIds[1] as NodeId;
    session.insertText({ nodeId: textId, text: '待办：复核过敏史' }, HUMAN);
    const { annotationId } = session.annotate(
      { nodeId: textId, title: '缺少复核人签名', quote: '待办', source: { kind: 'system', ruleId: 'R-9' } },
      SYSTEM,
    );
    assertEqual(
      codeOf(() => session.confirmAnchorLost({ annotationId }, HUMAN)),
      'E_ANNOTATION_STATE',
      '锚点仍有效时不得确认"已随内容清除"（否则它就成了"随手清掉碍事提示"的捷径）',
    );

    session.deleteNode({ nodeId: textId }, HUMAN);
    assertEqual(session.listAnnotations({ anchorState: 'lost' }).length, 1, '节点被删后必须如实暴露为锚点丢失（不能静默消失）');
    assertEqual(session.annotationCounts().anchorLost, 1, '统计应把锚点丢失单列出来，便于排查');

    const confirmed = session.confirmAnchorLost({ annotationId, note: '该段已按主任意见删除' }, QC);
    assertEqual(confirmed.ok, true, '锚点确实失效后应可确认');
    const item = session.listAnnotations().find((annotation) => annotation.id === annotationId);
    assertEqual(item?.anchorLostAt !== undefined, true, '应记录确认时间');
    assertEqual(session.annotationCounts().open, 0, '确认后不应再挂在"待处理"里');
    assertEqual(
      session.annotationCounts().anchorLost,
      0,
      '确认后不应再计入"待处理的锚点丢失"（否则界面会永远挂着一个无从处理的计数，很快就会被无视）',
    );

    /* 已终态的注解即使锚点失效，也不需要人再确认一次 —— 它已经处理完了 */
    const otherId = ids.textIds[2] as NodeId;
    session.insertText({ nodeId: otherId, text: '（某段内容）' }, HUMAN);
    const done = session.annotate(
      { nodeId: otherId, title: '另一条提示', quote: '某段', source: { kind: 'system', ruleId: 'R-10' } },
      SYSTEM,
    );
    session.resolveAnnotation({ annotationId: done.annotationId, status: 'dismissed' }, HUMAN);
    session.deleteNode({ nodeId: otherId }, HUMAN);
    assertEqual(
      codeOf(() => session.confirmAnchorLost({ annotationId: done.annotationId }, HUMAN)),
      'E_ANNOTATION_STATE',
      '已终态的注解无需再确认锚点清除（否则"确认"会退化成例行公事，它就不再是一个需要判断的动作）',
    );
    assertEqual(session.annotationCounts().anchorLost, 0, '已终态的锚点失效不计入待处理');
  });

  await test('N7 统计按条；指纹不受文档内容变化影响（锚点状态是派生的，不落存储）', () => {
    const { session, ids } = open();
    const textId = ids.textIds[0] as NodeId;
    session.insertText({ nodeId: textId, text: 'AAA' }, HUMAN);
    const first = session.annotate({ nodeId: textId, title: '提示1', source: { kind: 'system', ruleId: 'R-1' } }, SYSTEM);
    session.annotate({ nodeId: textId, title: '提示2', source: { kind: 'system', ruleId: 'R-2' } }, SYSTEM);
    session.resolveAnnotation({ annotationId: first.annotationId, status: 'dismissed' }, HUMAN);

    const counts = session.annotationCounts();
    assertEqual(counts.total, 2, '总数按条算');
    assertEqual(counts.open, 1, '待处理计数');
    assertEqual(counts.dismissed, 1, '已忽略计数');
    assertEqual(session.listAnnotations({ status: 'open' }).length, 1, '按状态过滤');
    assertEqual(session.listAnnotations({ nodeId: textId }).length, 2, '按节点过滤');

    const fingerprint = session.annotationFingerprint();
    const textBefore = textOf(session, textId);
    session.insertText({ nodeId: textId, text: 'BBB' }, HUMAN);
    assert(textOf(session, textId) !== textBefore, '前置假设：文档文本确实变了（合成文档的文本节点初始非空，insertText 是追加）');
    assertEqual(
      session.annotationFingerprint(),
      fingerprint,
      '注解指纹不应随文档内容变化 —— 锚点状态是查询时派生的，不是存储里的字段',
    );
  });

  process.exit(suite.report());
}

void main();
