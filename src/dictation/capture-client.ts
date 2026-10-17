/**
 * 采集编排（C3a）：把"采集源吐出的帧"变成"一组待落位的建议"。
 *
 * ## 它解决的问题
 *
 * C1 的分片规则、C2 的"提交一段音频 → 回文本"、以及 `/api/dictate` 收真实转写，
 * 三件都已经就位，但**没有任何一处把它们串起来**：
 *
 * ```
 *  [本模块] 采集源.onFrame ──► 流式分片器 ──► 逐片取 PCM ──► WAV ──► transcriber（同源路由）
 *                                                                        │
 *                                        提交给 /api/dictate ◄── 收集文本/失败/空结果
 * ```
 *
 * 串起来的这一层**与宿主形态无关**：录音发生在浏览器还是桌面壳里，
 * 只是换上来的 `CaptureSource` 不同（见 `capture-source.ts` 的槽位约定）。
 *
 * ## 四条纪律（都在编排层落地）
 *
 * 1) **不可用就不开始**：`probe()` 不通过直接抛错（带 why + howTo），
 *    **不打开设备、不发一个字节** —— 与"端点未配置时不静默退回模拟转写"同一条纪律；
 * 2) **逐段提交、逐段回显**：一句话说完就发出去，不等整段录完
 *    （设计第八节 `transcribing`：「转写中 3 段 / 已完成 1 段」）；
 * 3) **某段失败不阻塞其余段**，但失败段数、空结果段数、过短丢弃段数**全部如实回报**；
 * 4) **不代编时间区间**：片上交给转写的是流式分片器给出的 `[startSec, endSec]`，
 *    客户端**只负责把对应那段 PCM 拼出来**（拼错等于给了 ASR 另一段音频）。
 *
 * ## 它不做的事
 *
 * 不申请麦克风权限（那是采集源的事）、不落笔（建议仍然要走内核门控）、
 * 不决定置信度（服务端按配置上限填，见 `validateSubmittedSegments`）。
 */

import {
  CaptureError,
  createChunkAssembler,
  type CaptureChunk,
  type CaptureFailure,
  type ChunkPlan,
  type SegmentConfig,
  type SubmittedSegment,
} from './capture.ts';
import { CaptureSourceError, describeSourceFailure, type CaptureFrame, type CaptureSource } from './capture-source.ts';

/* ============================== 依赖 ============================== */

/** 转写一段音频（真实形态是 `POST /api/dictation/capture/segment`，同源） */
export interface SegmentTranscriber {
  (params: { sessionId: string; index: number; audio: Uint8Array }): Promise<{ text: string; modelId: string; confidenceNote?: string }>;
}

/** 把采集结果提交成建议（真实形态是 `POST /api/dictate`） */
export interface DictationSubmitter {
  (params: { transcriptionId: string; asrModelId: string; segments: SubmittedSegment[] }): Promise<{
    ok: boolean;
    code?: string;
    message?: string;
    data?: { groupId?: string | null; unplaced?: number; submitted?: boolean; warnings?: string[] };
  }>;
}

/* ============================== 状态与结果 ============================== */

export type CapturePhase = 'recording' | 'transcribing' | 'submitting' | 'done' | 'failed';

/**
 * 界面要渲染的全部状态。
 *
 * 为什么把它做成回调而不是让界面自己去拼：**"录音必须可见"是设计里唯一一条不讨论取舍的要求**
 * （病房里的人有权知道自己在被录）。把相位与计时集中在一处产出，界面就只剩"照着画"，
 * 而"忘了画计时"这类缺陷也就不可能在某一处悄悄发生。
 */
export interface CaptureProgress {
  phase: CapturePhase;
  /** 从开始采集算起的累计时长（秒）—— 录音态的计时（S1：暂停恢复不重置） */
  elapsedSec: number;
  /** 当前这一段（尚未定稿）已录时长（秒）；没有正在录的段时为 0 */
  currentChunkSec: number;
  /** 已定稿的段数（含转写失败与空结果的） */
  finalized: number;
  /** 已成功拿到文本的段数 */
  transcribed: number;
  /** 失败段：**如实回报**，不当成"什么都没说" */
  failures: CaptureFailure[];
}

export interface CaptureOutcome {
  sessionId: string;
  /** 部署声明的模型标识（取自转写响应，**不在客户端写死**） */
  asrModelId: string;
  /** 供界面标注"ASR 未提供置信度，按上限处理"（由服务端给出，界面照抄） */
  confidenceNote?: string;
  chunks: CaptureChunk[];
  failures: CaptureFailure[];
  /** `result` 为空串而被丢弃的段数（合法结果，但要如实回报） */
  emptyDropped: number;
  /** 短于 `minSeconds` 被丢弃的片数（S4） */
  shortDropped: number;
  warnings: string[];
  /** 提交结果（没给 `submitter` 时为 undefined；给了但没段可提交时为 `skipped`） */
  submit?: {
    ok: boolean;
    skipped?: boolean;
    code?: string;
    message?: string;
    groupId?: string | null;
    unplaced?: number;
    warnings?: string[];
  };
}

export interface CaptureRunRequest {
  /** 采集会话 ID：一次"说一段" = 一个会话（**不是 ASR 的 `task_id`**，见 C1 的 G 类判断） */
  sessionId: string;
  source: CaptureSource;
  segment: SegmentConfig;
  /** 逐段进度（界面据此画录音指示与计时） */
  onProgress?: (progress: CaptureProgress) => void;
}

export interface CaptureRunDeps {
  transcriber: SegmentTranscriber;
  submitter?: DictationSubmitter;
}

/**
 * 走完一次采集，并把结果提交成建议。
 *
 * 失败归属的划分（与 C1 的 `captureSession` 同口径）：
 *   - **分类失败**（`CaptureError`：字幕没拿到 / 超时 / 服务端拒收）→ 记进 `failures`，其余段照常；
 *   - **其他错误**（程序错误，或采集源本身的错误）→ **原样抛出**，不吞成"这段没说话"。
 */
export async function runDictationCapture(request: CaptureRunRequest, deps: CaptureRunDeps): Promise<CaptureOutcome> {
  const probe = request.source.probe();
  if (!probe.ok) {
    /* 不可用就到此为止：**不打开设备、不发一个字节**（与"端点未配置"同一条纪律） */
    throw new CaptureSourceError({
      code: probe.code,
      message: `采集源「${probe.sourceId}」不可用：${probe.message}`,
      howTo: probe.howTo,
    });
  }

  /* 帧 → 段（含 WAV）走的是**同一份实现**（`createChunkAssembler`）：本地客户端桥也用它 */
  const assemble = createChunkAssembler(request.segment);
  const pending: Array<{ plan: ChunkPlan; audio: Uint8Array }> = [];
  const chunks: CaptureChunk[] = [];
  const failures: CaptureFailure[] = [];
  const warnings: string[] = [];
  let modelId = '';
  let confidenceNote: string | undefined;
  let emptyDropped = 0;
  let transcribed = 0;
  let finalized = 0;
  let elapsedSec = 0;
  let currentChunkSec = 0;
  let phase: CapturePhase = 'recording';
  let draining: Promise<void> = Promise.resolve();

  const emit = (): void => {
    request.onProgress?.({
      phase,
      elapsedSec,
      currentChunkSec,
      finalized,
      transcribed,
      failures: [...failures],
    });
  };

  /**
   * 把"转写队列"再往前推一格。
   *
   * **必须集中在一处**：录完时那一段（由 `stop` 定稿）是在 `draining` 已兑现之后才入队的，
   * 如果只在 `onFrame` 里挂链，那一段就**没人转**（chunks 里少一条，而它本来是一句话）。
   * 这个竞态在"边录边转"（真实时间）下必现，在同步吐帧的自测里反而看不见 —— 所以自测也加了"让出一次"。
   */
  const scheduleDrain = (): void => {
    draining = draining.then(() => drain());
  };

  /** 逐段串行转写：串行让失败归属与时间区间都只有一种解释（同 C1 的理由） */
  const drain = async (): Promise<void> => {
    while (pending.length > 0) {
      const item = pending.shift() as { plan: ChunkPlan; audio: Uint8Array };
      try {
        const result = await deps.transcriber({ sessionId: request.sessionId, index: item.plan.index, audio: item.audio });
        if (result.modelId.trim() === '') {
          /* 答不出"哪个模型听写的"就不该产出建议（同内核 E_AI_NO_PROVENANCE 的纪律） */
          throw new CaptureError('E_CAPTURE_BAD_RESPONSE', '转写响应里没有模型标识（留痕答不出"哪个模型听写的"）');
        }
        if (modelId === '') modelId = result.modelId.trim();
        else if (modelId !== result.modelId.trim()) {
          warnings.push(
            `本次采集里出现了两个模型标识（${modelId} / ${result.modelId.trim()}）：中途改过采集配置，建议按前一个记录`,
          );
        }
        if (confidenceNote === undefined && result.confidenceNote !== undefined) confidenceNote = result.confidenceNote;

        if (result.text.trim() === '') {
          emptyDropped += 1;
        } else {
          chunks.push({ index: item.plan.index, startSec: item.plan.startSec, endSec: item.plan.endSec, text: result.text });
          transcribed += 1;
        }
      } catch (err) {
        /* 与 C1 的 ASR 客户端同一口径：**传输层故障**算"这一段没转出来"（记进 failures、其余段照常），
           而不是程序错误 —— 否则一次网关抖动就会被放大成一整次采集中断。 */
        const failure =
          err instanceof CaptureError
            ? err
            : new CaptureError('E_CAPTURE_HTTP_STATUS', `转写请求失败（按传输层故障处理）：${(err as Error).message}`, true);
        failures.push({
          index: item.plan.index,
          startSec: item.plan.startSec,
          endSec: item.plan.endSec,
          code: failure.code,
          message: failure.message,
        });
      }
      emit();
    }
  };

  const onFrame = (frame: CaptureFrame): void => {
    elapsedSec = frame.endSec;
    for (const chunk of assemble.feed(frame)) {
      finalized += 1;
      currentChunkSec = 0;
      pending.push(chunk);
      phase = 'transcribing';
      /* 边录边转：不 `await`，让采集继续（逐段回显的关键） */
      scheduleDrain();
    }
    /* 正在录的这一段有多久：由分片器给出的段起点算（S1：不因暂停而重置） */
    currentChunkSec = assemble.openStartSec === null ? 0 : Math.max(0, frame.endSec - assemble.openStartSec);
    emit();
  };

  try {
    await request.source.start(onFrame);
    /* 录音结束（时间线走完 / 有人按停）：定稿当前那一段 */
    for (const chunk of assemble.finish(elapsedSec)) {
      finalized += 1;
      pending.push(chunk);
    }
    /* 最后这一段也得有人转：`draining` 可能早已兑现（前面几段在录的过程中就转完了），
       不重新挂链的话，它会安静地留在队列里 —— 现场表现是"最后一句没进建议"。 */
    if (pending.length > 0) scheduleDrain();
    await draining;
  } catch (err) {
    phase = 'failed';
    emit();
    if (err instanceof CaptureError || err instanceof CaptureSourceError) throw err;
    /* 采集源的失败要翻译成"现场表现 + 怎么办"（第六节）：
       只丢一个 DOMException 的名字，现场只能去搜。 */
    throw new CaptureSourceError(describeSourceFailure(err));
  }

  const shortDropped = assemble.droppedShort;
  if (shortDropped > 0) warnings.push(`已忽略 ${shortDropped} 段过短语音（低于 ${request.segment.minSeconds}s，按误触丢弃）`);
  if (emptyDropped > 0) warnings.push(`${emptyDropped} 段识别结果为空：该段没有说话内容（空串是合法结果，但要如实回报）`);
  if (failures.length > 0) {
    warnings.push(`${finalized} 段中有 ${failures.length} 段转写失败：${failures.map((item) => `第 ${item.index} 段(${item.code})`).join('、')}`);
  }

  const outcome: CaptureOutcome = {
    sessionId: request.sessionId,
    asrModelId: modelId,
    ...(confidenceNote !== undefined ? { confidenceNote } : {}),
    chunks,
    failures,
    emptyDropped,
    shortDropped,
    warnings,
  };

  if (deps.submitter === undefined) {
    phase = 'done';
    emit();
    return outcome;
  }

  if (chunks.length === 0) {
    /* 一段有效文本都没有：**不提交**（提交空段会被服务端拒，而那看起来像链路坏了） */
    outcome.submit = { ok: false, skipped: true, code: 'E_NO_TARGET', message: '这次采集没有任何有效文本（全部是空结果或失败），没有可提交的建议' };
    phase = 'done';
    emit();
    return outcome;
  }

  phase = 'submitting';
  emit();
  const submitted = await deps.submitter({
    transcriptionId: request.sessionId,
    asrModelId: modelId,
    segments: chunks.map((chunk) => ({ index: chunk.index, text: chunk.text, startSec: chunk.startSec, endSec: chunk.endSec })),
  });
  outcome.submit = {
    ok: submitted.ok,
    ...(submitted.code !== undefined ? { code: submitted.code } : {}),
    ...(submitted.message !== undefined ? { message: submitted.message } : {}),
    ...(submitted.data?.groupId !== undefined ? { groupId: submitted.data.groupId } : {}),
    ...(submitted.data?.unplaced !== undefined ? { unplaced: submitted.data.unplaced } : {}),
    ...(submitted.data?.warnings !== undefined ? { warnings: submitted.data.warnings } : {}),
  };
  phase = submitted.ok ? 'done' : 'failed';
  emit();
  return outcome;
}
