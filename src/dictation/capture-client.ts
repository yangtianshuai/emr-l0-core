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

export interface SegmentTranscriber {
  (params: { sessionId: string; index: number; audio: Uint8Array }): Promise<{ text: string; modelId: string; confidenceNote?: string }>;
}

export interface DictationSubmitter {
  (params: { transcriptionId: string; asrModelId: string; segments: SubmittedSegment[] }): Promise<{
    ok: boolean;
    code?: string;
    message?: string;
    data?: { groupId?: string | null; unplaced?: number; submitted?: boolean; warnings?: string[] };
  }>;
}

export type CapturePhase = 'recording' | 'transcribing' | 'submitting' | 'done' | 'failed';

export interface CaptureProgress {
  phase: CapturePhase;
  elapsedSec: number;
  currentChunkSec: number;
  finalized: number;
  transcribed: number;
  failures: CaptureFailure[];
}

export interface CaptureOutcome {
  sessionId: string;
  asrModelId: string;
  /** 供界面标注"ASR 未提供置信度，按上限处理"（由服务端给出，界面照抄） */
  confidenceNote?: string;
  chunks: CaptureChunk[];
  failures: CaptureFailure[];
  emptyDropped: number;
  shortDropped: number;
  warnings: string[];
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
  sessionId: string;
  source: CaptureSource;
  segment: SegmentConfig;
  onProgress?: (progress: CaptureProgress) => void;
}

export interface CaptureRunDeps {
  transcriber: SegmentTranscriber;
  submitter?: DictationSubmitter;
}

export async function runDictationCapture(request: CaptureRunRequest, deps: CaptureRunDeps): Promise<CaptureOutcome> {
  const probe = request.source.probe();
  if (!probe.ok) {
    /* 不可用就到此为止：不打开设备、不发一个字节（与"端点未配置"同一条纪律）  */
    throw new CaptureSourceError({
      code: probe.code,
      message: `采集源「${probe.sourceId}」不可用：${probe.message}`,
      howTo: probe.howTo,
    });
  }

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

  const scheduleDrain = (): void => {
    draining = draining.then(() => drain());
  };

  const drain = async (): Promise<void> => {
    while (pending.length > 0) {
      const item = pending.shift() as { plan: ChunkPlan; audio: Uint8Array };
      try {
        const result = await deps.transcriber({ sessionId: request.sessionId, index: item.plan.index, audio: item.audio });
        if (result.modelId.trim() === '') {
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
      scheduleDrain();
    }
    currentChunkSec = assemble.openStartSec === null ? 0 : Math.max(0, frame.endSec - assemble.openStartSec);
    emit();
  };

  try {
    await request.source.start(onFrame);
    for (const chunk of assemble.finish(elapsedSec)) {
      finalized += 1;
      pending.push(chunk);
    }
    if (pending.length > 0) scheduleDrain();
    await draining;
  } catch (err) {
    phase = 'failed';
    emit();
    if (err instanceof CaptureError || err instanceof CaptureSourceError) throw err;
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
