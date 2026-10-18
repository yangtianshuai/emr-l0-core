// 语音转写接入（T31）：把音频侧的产物规范成可审计的建议输入。

import type { EvidenceRef, ISODateTime, NodeId } from '../model/types.ts';

/** ASR 的一段产物：一段话 + 时间区间 + 听写置信度 */
export interface TranscriptSegment {
  /** 段号（从 1 开始，与音频顺序一致） */
  index: number;
  text: string;
  /** 相对录音开始的秒数：保留"何时说的"，争议追溯要用 */
  startSec?: number;
  endSec?: number;
  confidence: number;
}

export interface DictationInput {
  /** 转写任务标识（音频指纹或 ASR 任务号）：争议时要能回到音频 */
  transcriptionId: string;
  asrModelId: string;
  /** 若做过后处理（顺句、纠错）必须记 —— 它也是内容来源的一部分 */
  refineModelId?: string;
  segments: TranscriptSegment[];
  at: ISODateTime;
}

/** 供 `Session.suggestBatch` 直接使用的建议输入（结构与 SuggestionBatchInput 一致） */
export interface DictationSuggestionItem {
  nodeId: NodeId;
  text: string;
  confidence: number;
  modelId: string;
  promptId: string;
  evidence: EvidenceRef[];
}

export interface NormalizeResult {
  segments: TranscriptSegment[];
  /** 丢弃的空段数（如实上报，不静默处理） */
  dropped: number;
  /** 时间戳不单调的段数（不阻断，但提示：ASR 输出可能乱序） */
  outOfOrder: number;
}

export function normalizeSegments(segments: TranscriptSegment[]): NormalizeResult {
  const nonEmpty = segments.filter((segment) => segment.text.trim() !== '');
  const dropped = segments.length - nonEmpty.length;
  let outOfOrder = 0;
  let previous = -1;
  for (const segment of nonEmpty) {
    if (segment.startSec !== undefined && previous >= 0 && segment.startSec < previous) outOfOrder += 1;
    if (segment.startSec !== undefined) previous = segment.startSec;
  }
  const sorted = [...nonEmpty].sort((a, b) => {
    if (a.startSec !== undefined && b.startSec !== undefined && a.startSec !== b.startSec) return a.startSec - b.startSec;
    return a.index - b.index;
  });
  return { segments: sorted, dropped, outOfOrder };
}

/**
 * 转写段 → 建议输入。
 *
 * 每条建议的 evidence：
 *   `kind: 'dictation'` —— 独立来源类别，据此可检索"哪些内容是语音来的"；
 *   `ref` —— 可回到音频的定位：转写标识 + 段号 + 时间区间；
 *   `quote` —— 原文，日后可核对"当初听到的到底是什么"；
 *   `valueText` —— 后处理模型（若做过顺句/纠错，它也是内容来源的一部分）。
  */
export function toSuggestionItems(input: DictationInput, options: { nodeIds: NodeId[]; maxConfidence?: number }): DictationSuggestionItem[] {
  const ceiling = options.maxConfidence ?? 0.85;
  return input.segments.map((segment, position) => {
    const nodeId = options.nodeIds[position] as NodeId;
    const span = segment.startSec === undefined ? '' : `@${segment.startSec}-${segment.endSec ?? segment.startSec}s`;
    const evidence: EvidenceRef = {
      kind: 'dictation',
      ref: `${input.transcriptionId}#${segment.index}${span}`,
      quote: segment.text,
      nodeId,
      capturedAt: input.at,
      ...(input.refineModelId ? { valueText: `后处理：${input.refineModelId}` } : {}),
    };
    return {
      nodeId,
      text: segment.text.trim(),
      /* 与上限取小：听写再"肯定"，也不该被当成可直接落笔的草稿 */
      confidence: Math.min(segment.confidence, ceiling),
      modelId: input.asrModelId,
      promptId: `dictation:${input.transcriptionId}`,
      evidence: [evidence],
    };
  });
}

export function demoTranscript(transcriptionId: string, at: ISODateTime): DictationInput {
  return {
    transcriptionId,
    asrModelId: 'local/asr-zh-med:0.9@2026-09-demo',
    refineModelId: 'local/asr-refiner:0.3@2026-09-demo',
    at,
    segments: [
      { index: 1, text: '患者三天前无明显诱因出现咳嗽，咳白色黏痰。', startSec: 0, endSec: 4.2, confidence: 0.92 },
      { index: 2, text: '   ', startSec: 4.2, endSec: 4.6, confidence: 0.4 },
      { index: 3, text: '伴发热，最高体温三十八度五。', startSec: 9.1, endSec: 12.4, confidence: 0.88 },
      { index: 4, text: '无明显胸闷气促，无咯血。', startSec: 4.6, endSec: 9.1, confidence: 0.95 },
    ],
  };
}
