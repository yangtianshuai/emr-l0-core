import type { EvidenceRef, ISODateTime, NodeId } from '../model/types.ts';

export interface TranscriptSegment {
  /** 段号（从 1 开始，与音频顺序一致） */
  index: number;
  text: string;
  startSec?: number;
  endSec?: number;
  confidence: number;
}

export interface DictationInput {
  transcriptionId: string;
  asrModelId: string;
  refineModelId?: string;
  segments: TranscriptSegment[];
  at: ISODateTime;
}

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
  dropped: number;
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
