/**
 * 语音转写接入（T31）：把**音频侧的产物**规范成可审计的建议输入。
 *
 * ## 边界：内核不做语音识别
 *
 * ASR 在外部（本地引擎或云端），内核只接收它的产物：**带时间戳的转写文本流**。三条理由：
 *   1) ASR 重依赖（麦克风、声学模型、方言口音），塞进内核会让"零依赖 + 可离线"的底线失守；
 *   2) 内核真正该守的不是"怎么听懂话"，而是**听写出来的内容怎么进入病历**；
 *   3) 医院里 ASR 往往已由别的系统提供（语音输入法、智能麦克风），再做一个只会造成两套并存。
 *
 * ## 三条不可让步的规则
 *
 * 1) **转写一律走建议通道**：语音绝不能直接落笔。AI 直写门控已兜住一层，
 *    这里再保证转写产物**只生成建议** —— 不写节点、不改 rev、不留痕；
 * 2) **必须可追溯**：每条建议带 ASR 模型标识、转写任务标识与**时间区间**。
 *    有争议时要能回答"这句话什么时候说的、哪个模型听写的、能不能回到音频"；
 * 3) **第一版不做自动落位**：段落 → 节点的猜测交给医生。
 *    落位准确率需要评测集才能声称，而**错误落位比不落位更危险** ——
 *    它会把主诉的内容塞进现病史，而医生未必逐字看。让医生拖一下，代价小得多。
 *
 * ## 置信度上限（最容易被忽略的一条）
 *
 * 转写建议的置信度一律被压到 `maxConfidence`（默认 0.85）以下。原因是概念区分：
 * 听写置信度衡量的是**"听清了没有"**，不是**"内容对不对"**，把它当成内容可信度是错位。
 * 而 0.85 < 关键内容阈值 0.90 —— 于是**关键内容节点上必须"改后采纳"**：
 * 口头说出的关键信息，不该因为"听清了"就被当成可直接落笔的草稿。
 */

import type { EvidenceRef, ISODateTime, NodeId } from '../model/types.ts';

/** ASR 的一段产物：一段话 + 时间区间 + 听写置信度 */
export interface TranscriptSegment {
  /** 段号（从 1 开始，与音频顺序一致） */
  index: number;
  text: string;
  /** 相对录音开始的秒数：保留"何时说的"，争议追溯要用 */
  startSec?: number;
  endSec?: number;
  /** **听写**置信度（0~1）：衡量"听清了没有"，**不是"内容对不对"**（见文件头） */
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

/**
 * 规范化转写段：丢弃空段、按时间（或段号）稳定排序。
 *
 * 为什么不直接信任调用方给的顺序：ASR 输出**常常乱序或带碎段**（流式识别尤其如此）。
 * 照搬的话，病历里会出现前后颠倒的口述内容 —— 而医生面对的是一段段文本，
 * 很难发现顺序错了，比缺字更难察觉。
 */
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
 *   `ref` —— **可回到音频的定位**：转写标识 + 段号 + 时间区间；
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

/**
 * 演示用的模拟转写（**不是真实 ASR**）：让界面能演示完整链路。
 *
 * 刻意包含三处"真实会发生"的形态，用来暴露规范化与门控的作用：
 *   ① 一段空文本（应当被丢弃并如实上报）；
 *   ② 两段时间戳颠倒（应当被重排并给出提示）；
 *   ③ 一段 confidence 极高（应当被上限压下去）。
 */
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
