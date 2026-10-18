// 语音转写接入自测（T31）。

import { TestSuite, assert, assertEqual } from '../testing/harness.ts';
import { WriteSession, type Actor } from './session.ts';
import { demoTranscript, type TranscriptSegment } from './dictation.ts';
import { buildSyntheticDoc } from '../testing/synthetic.ts';
import type { DocNode, NodeId } from '../model/types.ts';

const suite = new TestSuite('语音转写接入自测', [
  '说明：内核不做 ASR，只把"带时间戳的转写流"规范成可审计的建议 —— 语音没有任何特权通道。',
  'D1/D3/D5 是防回退关键：语音绝不能直接落笔，也不能借"听得很清楚"越过阈值。',
]);

const test = (name: string, fn: () => void | Promise<void>): Promise<void> => suite.test(name, fn);

const HUMAN: Actor = { id: 'DR_WANG', kind: 'human' };
const AI: Actor = { id: 'asr-pipeline', kind: 'ai' };

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
  await test('D1 转写只生成建议：不落笔、不改 rev、不留痕；一组内全为 pending', () => {
    const { session, ids } = open();
    const targetNodeId = ids.textIds[0] as NodeId;
    const nodes = JSON.stringify(session.document.nodes);
    const rev = session.docRev;
    const logLength = session.auditLog().length;

    const input = demoTranscript('audio-abc', '2026-10-08T10:00:00Z');
    const result = session.dictate({ ...input, targetNodeId }, AI);

    assertEqual(result.suggestionIds.length, 3, '空段应被丢弃，只剩 3 段有效转写');
    assertEqual(JSON.stringify(session.document.nodes), nodes, '转写不得落笔');
    assertEqual(session.docRev, rev, '转写不得改 rev');
    assertEqual(session.auditLog().length, logLength, '转写不得留痕（此时还没有任何内容进入病历）');
    const inGroup = session.listSuggestions({ groupId: result.groupId });
    assertEqual(inGroup.length, 3, '三条应同属一组');
    assertEqual(
      inGroup.every((item) => item.status === 'pending'),
      true,
      '都应是待处理',
    );
    assertEqual(session.verifyInvariants(), [], '不变量应成立');
  });

  await test('D2 必须可追溯：ASR 模型、转写标识、时间区间、独立来源类别', () => {
    const { session, ids } = open();
    const targetNodeId = ids.textIds[0] as NodeId;
    const input = demoTranscript('audio-xyz', '2026-10-08T10:00:00Z');

    assertEqual(codeOf(() => session.dictate({ ...input, asrModelId: '', targetNodeId }, AI)), 'E_AI_NO_PROVENANCE', '缺 asrModelId 应被拒');
    assertEqual(
      codeOf(() => session.dictate({ ...input, transcriptionId: '', targetNodeId }, AI)),
      'E_AI_NO_PROVENANCE',
      '缺 transcriptionId 应被拒（回不到音频就无法追溯）',
    );

    const result = session.dictate({ ...input, targetNodeId }, AI);
    const first = session.listSuggestions({ groupId: result.groupId })[0];
    const evidence = first?.evidence?.[0];
    assertEqual(evidence?.kind, 'dictation', '来源类别应为 dictation（据此可检索"哪些内容是语音来的"）');
    assert(String(evidence?.ref).includes('audio-xyz#1'), `ref 应指向音频与段号，实际：${evidence?.ref}`);
    assert(/@0-4\.2s/.test(String(evidence?.ref)), `ref 应带时间区间，实际：${evidence?.ref}`);
    assertEqual(evidence?.quote, '患者三天前无明显诱因出现咳嗽，咳白色黏痰。', '应保留转写原文');
    assert(String(evidence?.valueText ?? '').includes('asr-refiner'), '做过后处理必须记下后处理模型（它也是内容来源的一部分）');
  });

  await test('D3 置信度上限：关键内容上不得落笔；"改后采纳"也不是后门', () => {
    const { session, ids } = open();
    const targetNodeId = ids.textIds[0] as NodeId;
    const input = demoTranscript('audio-cap', '2026-10-08T10:00:00Z');
    /* 模拟"ASR 非常肯定"：confidence = 1.0 */
    const segments: TranscriptSegment[] = [{ index: 1, text: '患者无药物过敏史。', startSec: 0, endSec: 2, confidence: 1 }];

    const firstRun = session.dictate({ ...input, segments, targetNodeId }, AI);
    const firstId = String(session.listSuggestions({ groupId: firstRun.groupId })[0]?.id);
    assertEqual(
      session.listSuggestions({ groupId: firstRun.groupId })[0]?.confidence,
      0.85,
      '听写置信度应被压到上限（它衡量"听清了没有"，不是"内容对不对"）',
    );
    assertEqual(session.acceptSuggestion({ suggestionId: firstId }, HUMAN).ok, true, '一般内容上（0.85 ≥ 0.75）可采纳');

    /* 关键内容（阈值 0.90）：0.85 不够 —— 口头说的关键信息不能因为"听清了"就落笔 */
    const secondRun = session.dictate({ ...input, segments, targetNodeId, transcriptionId: 'audio-cap-2' }, AI);
    const secondId = String(session.listSuggestions({ groupId: secondRun.groupId })[0]?.id);
    session.updateNodeProps({ nodeId: targetNodeId, patch: { keyContent: true } }, HUMAN);
    assertEqual(
      codeOf(() => session.acceptSuggestion({ suggestionId: secondId }, HUMAN)),
      'E_AI_LOW_CONFIDENCE',
      '关键内容上不得直接采纳',
    );
    assertEqual(
      codeOf(() => session.acceptSuggestion({ suggestionId: secondId, editedText: '患者否认药物及食物过敏史。' }, HUMAN)),
      'E_AI_LOW_CONFIDENCE',
      '**改后采纳也不是绕过阈值的后门**：改文本不改变来源的可信度，置信度不够就是不够',
    );
  });

  await test('D4 规范化：空段丢弃、乱序重排，且都**如实回报**', () => {
    const { session, ids } = open();
    const targetNodeId = ids.textIds[0] as NodeId;
    const input = demoTranscript('audio-order', '2026-10-08T10:00:00Z');
    const result = session.dictate({ ...input, targetNodeId }, AI);

    /* 演示样本刻意含：1 段空文本 + 两段时间戳颠倒（第 4 段实际排在 4.6s） */
    assert(
      result.warnings.some((text) => text.includes('空文本')),
      `应回报丢弃的空段，实际：${result.warnings.join(' | ')}`,
    );
    assert(
      result.warnings.some((text) => text.includes('倒序')),
      `应回报时间戳乱序，实际：${result.warnings.join(' | ')}`,
    );
    assertEqual(
      result.segments.map((segment) => segment.startSec),
      [0, 4.6, 9.1],
      '应按时间重排（ASR 流式输出乱序若照搬，病历里口述内容会前后颠倒，比缺字更难察觉）',
    );
    assertEqual(session.listSuggestions({ groupId: result.groupId }).length, 3, '空段不得生成建议');
  });

  await test('D5 语音没有特权通道：AI 仍不得直接写；空转写不得静默成功', () => {
    const { session, ids } = open();
    const targetNodeId = ids.textIds[0] as NodeId;

    assertEqual(
      codeOf(() => session.insertText({ nodeId: targetNodeId, text: '（转写内容）' }, AI)),
      'E_AI_DIRECT_WRITE_FORBIDDEN',
      '语音链路不得绕过"AI 只能出建议"的底线',
    );

    const input = demoTranscript('audio-empty', '2026-10-08T10:00:00Z');
    assertEqual(
      codeOf(() => session.dictate({ ...input, segments: [{ index: 1, text: '   ', confidence: 0.9 }], targetNodeId }, AI)),
      'E_SUGGESTION_SCOPE_REQUIRED',
      '全是空段时应显式报错，不能"看起来成功了"',
    );
    assertEqual(
      codeOf(() => session.dictate({ ...input, targetNodeId: session.document.rootId }, AI)),
      'E_TYPE_MISMATCH',
      '目标节点必须能承载文本',
    );
  });

  await test('D6 落位：多段同节点必须**警告**（采纳会互相覆盖）；逐段指定节点时各段各就各位', () => {
    const { session, ids } = open();
    const input = demoTranscript('audio-group', '2026-10-08T10:00:00Z');
    const single = ids.textIds[0] as NodeId;

    const together = session.dictate({ ...input, targetNodeId: single }, AI);
    assert(
      together.warnings.some((text) => text.includes('互相覆盖')),
      `多段落同一节点必须警告，实际：${together.warnings.join(' | ')}`,
    );
    const group = session.listSuggestionGroups().find((item) => item.groupId === together.groupId);
    assertEqual(group?.traceId, 'dictation:audio-group', 'traceId 应指向这次转写任务（把"一次录音"与"一批建议"对应起来）');

    const spreadRun = open();
    const targets = spreadRun.ids.textIds.slice(0, 3).map((id) => id as NodeId);
    const spread = spreadRun.session.dictate({ ...input, targetNodeIds: targets, transcriptionId: 'audio-spread' }, AI);
    assertEqual(
      targets.map((nodeId) => spreadRun.session.listSuggestions({ targetNodeId: nodeId, groupId: spread.groupId }).length),
      [1, 1, 1],
      '每段应落在各自的节点上',
    );
    /* 个数不匹配必须报错（逐段落位不允许"少给几个"） */
    assertEqual(
      codeOf(() => session.dictate({ ...input, targetNodeIds: [single], transcriptionId: 'audio-bad' }, AI)),
      'E_SUGGESTION_SCOPE_REQUIRED',
      '逐段落位的节点数必须与有效段数一致',
    );
    assertEqual(
      codeOf(() => session.dictate({ ...input, targetNodeId: single, targetNodeIds: targets, transcriptionId: 'audio-both' }, AI)),
      'E_SUGGESTION_SCOPE_REQUIRED',
      '两种落位方式不能同时给',
    );

    const bulk = spreadRun.session.acceptSuggestions({ groupId: spread.groupId }, HUMAN);
    assertEqual(bulk.accepted.length, 3, '逐段分节点后，整组采纳不会互相覆盖');
    assertEqual(bulk.blocked.length, 0, '本次没有被拦的条目');
    assertEqual(textOf(spreadRun.session, targets[0] as NodeId).includes('咳嗽'), true, '第 1 段应在第 1 个节点上');
    assertEqual(textOf(spreadRun.session, targets[2] as NodeId).includes('发热'), true, '第 3 段应在第 3 个节点上');
    assertEqual(
      (spreadRun.session.document.nodes[targets[0] as NodeId] as Extract<DocNode, { type: 'text' }>).humanConfirmed,
      false,
      '语音内容同样需要人工逐条确认（采纳 ≠ 确认责任）',
    );
    assertEqual(spreadRun.session.verifyInvariants(), [], '不变量应成立');
  });

  process.exit(suite.report());
}

void main();
