import type { ISODateTime } from '../model/types.ts';
import type { DictationInput, TranscriptSegment } from '../core/dictation.ts';
import { KEY_CONTENT_THRESHOLD } from './placement.ts';

import {
  CAPTURE_AUDIO,
  CaptureError,
  defaultTransport,
  type CaptureTransport,
  type CaptureTransportRequest,
  type CaptureTransportResponse,
} from './capture-transport.ts';
import {
  ASR_KINDS,
  ASR_PROTOCOLS,
  assertPublicCloudAcknowledged,
  isAsrKind,
  missingCredentials,
  vendorOf,
  type AsrCredentials,
  type AsrKind,
} from './asr-adapters.ts';

export {
  CAPTURE_AUDIO,
  CAPTURE_MAX_ATTEMPTS,
  CaptureError,
  defaultTransport,
  parseJsonObject,
  type CaptureTransport,
  type CaptureTransportRequest,
  type CaptureTransportResponse,
} from './capture-transport.ts';
export {
  ASR_KINDS,
  ASR_PROTOCOLS,
  ASR_VENDORS,
  CAPTURE_AUDIO_FIELD,
  CAPTURE_SUBMIT_PATH,
  assertPublicCloudAcknowledged,
  clearAsrTokenCache,
  isAsrKind,
  missingCredentialSlots,
  missingCredentials,
  vendorOf,
  type AsrCredentials,
  type AsrProtocol,
  type AsrVendorSpec,
} from './asr-adapters.ts';
export type { CaptureErrorCode } from './capture-transport.ts';
export type { AsrKind } from './asr-adapters.ts';

export const ASR_NO_CONFIDENCE_NOTE = 'ASR 未提供置信度，按上限处理';

function writeAscii(target: Uint8Array, offset: number, text: string): void {
  for (let i = 0; i < text.length; i += 1) target[offset + i] = text.charCodeAt(i);
}

export function buildWavHeader(dataBytes: number): Uint8Array {
  if (!Number.isInteger(dataBytes) || dataBytes < 0) {
    throw new CaptureError('E_CAPTURE_CONFIG_INVALID', `WAV 数据长度必须是非负整数，实际 ${JSON.stringify(dataBytes)}`);
  }
  const header = new Uint8Array(44);
  const view = new DataView(header.buffer);
  const blockAlign = CAPTURE_AUDIO.channels * (CAPTURE_AUDIO.bitsPerSample / 8);
  writeAscii(header, 0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(header, 8, 'WAVE');
  writeAscii(header, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, CAPTURE_AUDIO.channels, true);
  view.setUint32(24, CAPTURE_AUDIO.sampleRate, true);
  view.setUint32(28, CAPTURE_AUDIO.sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, CAPTURE_AUDIO.bitsPerSample, true);
  writeAscii(header, 36, 'data');
  view.setUint32(40, dataBytes, true);
  return header;
}

export function encodeCaptureWav(pcm: Uint8Array): Uint8Array {
  const bytesPerSample = CAPTURE_AUDIO.bitsPerSample / 8;
  if (pcm.byteLength % bytesPerSample !== 0) {
    throw new CaptureError(
      'E_CAPTURE_CONFIG_INVALID',
      `PCM 字节数 ${pcm.byteLength} 不是 ${bytesPerSample} 的整数倍：采集端必须产出 16-bit 小端 PCM`,
    );
  }
  const header = buildWavHeader(pcm.byteLength);
  const out = new Uint8Array(header.byteLength + pcm.byteLength);
  out.set(header, 0);
  out.set(pcm, header.byteLength);
  return out;
}

export function parseCaptureWav(bytes: Uint8Array): {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  dataBytes: number;
} {
  if (bytes.byteLength < 44) throw new CaptureError('E_CAPTURE_BAD_RESPONSE', 'WAV 不足 44 字节，解不出头');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (offset: number, length: number): string =>
    String.fromCharCode(...bytes.slice(offset, offset + length));
  if (ascii(0, 4) !== 'RIFF' || ascii(8, 4) !== 'WAVE') {
    throw new CaptureError('E_CAPTURE_BAD_RESPONSE', '不是 RIFF/WAVE 容器');
  }
  return {
    sampleRate: view.getUint32(24, true),
    channels: view.getUint16(22, true),
    bitsPerSample: view.getUint16(34, true),
    dataBytes: view.getUint32(40, true),
  };
}

export interface AsrConfig {
  kind: AsrKind;
  /** ASR 服务地址；空 = 未配置 → 采集入口不可用（fail-closed）  */
  endpoint: string;
  appKey: string;
  submitTimeoutMs: number;
  pollIntervalMs: number;
  pollTimeoutMs: number;
  /** 部署方声明的模型标识（三家都不返回模型信息），必须带版本/日期  */
  modelId: string;
  acknowledgePublicCloud: boolean;
}

export interface SegmentConfig {
  silenceMs: number;
  maxSeconds: number;
  minSeconds: number;
}

export interface CaptureConfig {
  asr: AsrConfig;
  segment: SegmentConfig;
  /** 是否留存音频；默认 false（录音必然含患者信息，进 PHI 扫描范围是另一整套工作）  */
  retainAudio: boolean;
  /** 未提供置信度时的填充值；必须 < 关键内容阈值 0.90  */
  confidenceCeiling: number;
}

export const DEFAULT_CAPTURE_CONFIG: CaptureConfig = {
  asr: {
    kind: 'intranet-task',
    endpoint: '',
    appKey: '',
    submitTimeoutMs: 15_000,
    pollIntervalMs: 1_000,
    pollTimeoutMs: 90_000,
    modelId: '',
    acknowledgePublicCloud: false,
  },
  segment: { silenceMs: 800, maxSeconds: 30, minSeconds: 1 },
  retainAudio: false,
  confidenceCeiling: 0.85,
};

/** `maxSeconds` 的上限：不设上限等于允许"一段装上十分钟"，那会让首条建议要等十分钟才出现 */
export const MAX_SEGMENT_SECONDS = 120;

function requirePositive(name: string, value: unknown, fallback: number, integer = true): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || (integer && !Number.isInteger(value))) {
    throw new CaptureError(
      'E_CAPTURE_CONFIG_INVALID',
      `${name} 必须是正的${integer ? '整' : ''}数，实际 ${JSON.stringify(value)}（拒绝静默取默认值：那会让"我配的没生效"表现成"功能坏了"）`,
    );
  }
  return value;
}

export interface CaptureConfigPatch {
  asr?: Partial<AsrConfig>;
  segment?: Partial<SegmentConfig>;
  retainAudio?: boolean;
  confidenceCeiling?: number;
}

export function validateCaptureConfig(input: CaptureConfigPatch = {}): CaptureConfig {
  const asrInput = input.asr ?? {};
  const segmentInput = input.segment ?? {};

  const kindRaw: unknown = (asrInput as { kind?: unknown }).kind;
  if (kindRaw !== undefined && !isAsrKind(kindRaw)) {
    throw new CaptureError(
      'E_CAPTURE_CONFIG_INVALID',
      `asr.kind 不认识：${JSON.stringify(kindRaw)}（可选 ${ASR_KINDS.join(' / ')}）`,
    );
  }
  const kind: AsrKind = isAsrKind(kindRaw) ? kindRaw : DEFAULT_CAPTURE_CONFIG.asr.kind;

  const appKeyRaw: unknown = (asrInput as { appKey?: unknown }).appKey;
  if (appKeyRaw !== undefined && typeof appKeyRaw !== 'string') {
    throw new CaptureError('E_CAPTURE_CONFIG_INVALID', `asr.appKey 必须是字符串，实际 ${typeof appKeyRaw}`);
  }
  const appKey = (appKeyRaw ?? '').trim();

  const ackRaw: unknown = (asrInput as { acknowledgePublicCloud?: unknown }).acknowledgePublicCloud;
  if (ackRaw !== undefined && typeof ackRaw !== 'boolean') {
    throw new CaptureError('E_CAPTURE_CONFIG_INVALID', `asr.acknowledgePublicCloud 必须是布尔值，实际 ${typeof ackRaw}`);
  }
  const acknowledgePublicCloud = ackRaw === true;
  assertPublicCloudAcknowledged(vendorOf(kind), acknowledgePublicCloud);

  const endpointRaw = asrInput.endpoint ?? '';
  if (typeof endpointRaw !== 'string') {
    throw new CaptureError('E_CAPTURE_CONFIG_INVALID', `asr.endpoint 必须是字符串，实际 ${typeof endpointRaw}`);
  }
  const endpoint = endpointRaw.trim();
  if (endpoint !== '' && !/^https?:\/\//i.test(endpoint)) {
    throw new CaptureError('E_CAPTURE_CONFIG_INVALID', `asr.endpoint 必须是 http(s) 地址，实际 ${JSON.stringify(endpoint)}`);
  }

  const modelIdRaw = asrInput.modelId ?? '';
  if (typeof modelIdRaw !== 'string') {
    throw new CaptureError('E_CAPTURE_CONFIG_INVALID', `asr.modelId 必须是字符串，实际 ${typeof modelIdRaw}`);
  }
  const modelId = modelIdRaw.trim();
  if (modelId !== '' && !/[:@]/.test(modelId)) {
    throw new CaptureError(
      'E_CAPTURE_CONFIG_INVALID',
      `asr.modelId 必须带版本或日期（形如 local/asr-zh-med:0.9@2026-09-demo），实际 ${JSON.stringify(modelId)}：` +
        '否则留痕里的"哪个模型听写的"在换模型后就答不准了',
    );
  }

  const submitTimeoutMs = requirePositive('asr.submitTimeoutMs', asrInput.submitTimeoutMs, DEFAULT_CAPTURE_CONFIG.asr.submitTimeoutMs);
  const pollIntervalMs = requirePositive('asr.pollIntervalMs', asrInput.pollIntervalMs, DEFAULT_CAPTURE_CONFIG.asr.pollIntervalMs);
  const pollTimeoutMs = requirePositive('asr.pollTimeoutMs', asrInput.pollTimeoutMs, DEFAULT_CAPTURE_CONFIG.asr.pollTimeoutMs);
  if (pollTimeoutMs <= pollIntervalMs) {
    throw new CaptureError(
      'E_CAPTURE_CONFIG_INVALID',
      `asr.pollTimeoutMs(${pollTimeoutMs}) 必须大于 pollIntervalMs(${pollIntervalMs})：否则一次都问不到就已超时`,
    );
  }

  const silenceMs = requirePositive('segment.silenceMs', segmentInput.silenceMs, DEFAULT_CAPTURE_CONFIG.segment.silenceMs);
  const maxSeconds = requirePositive('segment.maxSeconds', segmentInput.maxSeconds, DEFAULT_CAPTURE_CONFIG.segment.maxSeconds);
  const minSeconds = requirePositive('segment.minSeconds', segmentInput.minSeconds, DEFAULT_CAPTURE_CONFIG.segment.minSeconds);
  if (minSeconds >= maxSeconds) {
    throw new CaptureError(
      'E_CAPTURE_CONFIG_INVALID',
      `segment.minSeconds(${minSeconds}) 必须小于 maxSeconds(${maxSeconds})：否则每一片都会被自己丢弃`,
    );
  }
  if (maxSeconds > MAX_SEGMENT_SECONDS) {
    throw new CaptureError('E_CAPTURE_CONFIG_INVALID', `segment.maxSeconds 不得超过 ${MAX_SEGMENT_SECONDS}s，实际 ${maxSeconds}`);
  }
  if (silenceMs >= maxSeconds * 1000) {
    throw new CaptureError(
      'E_CAPTURE_CONFIG_INVALID',
      `segment.silenceMs(${silenceMs}) 必须小于 maxSeconds 对应的毫秒数(${maxSeconds * 1000})：否则静音判停永远轮不到`,
    );
  }

  const retainAudio = input.retainAudio ?? DEFAULT_CAPTURE_CONFIG.retainAudio;
  if (typeof retainAudio !== 'boolean') {
    throw new CaptureError('E_CAPTURE_CONFIG_INVALID', `retainAudio 必须是布尔值，实际 ${JSON.stringify(input.retainAudio)}`);
  }

  const ceiling = input.confidenceCeiling ?? DEFAULT_CAPTURE_CONFIG.confidenceCeiling;
  if (typeof ceiling !== 'number' || !Number.isFinite(ceiling) || ceiling <= 0) {
    throw new CaptureError(
      'E_CAPTURE_CONFIG_INVALID',
      `confidenceCeiling 必须是 0~1 的有限正数，实际 ${JSON.stringify(input.confidenceCeiling)}（拒绝静默取默认值）`,
    );
  }
  if (ceiling >= KEY_CONTENT_THRESHOLD) {
    throw new CaptureError(
      'E_CAPTURE_CEILING_TOO_HIGH',
      `confidenceCeiling 必须小于关键内容阈值 ${KEY_CONTENT_THRESHOLD}，实际 ${ceiling}：` +
        '该接口不回置信度，填上限的语义是"未知且按最保守处理"，放开它等于让关键内容被自动落笔',
    );
  }

  return {
    asr: {
      kind,
      endpoint,
      appKey,
      submitTimeoutMs,
      pollIntervalMs,
      pollTimeoutMs,
      modelId,
      acknowledgePublicCloud,
    },
    segment: { silenceMs, maxSeconds, minSeconds },
    retainAudio,
    confidenceCeiling: ceiling,
  };
}

export type SegmentEndReason = 'silence' | 'maxSeconds' | 'pause' | 'manual-stop';

export interface ChunkPlan {
  index: number;
  startSec: number;
  endSec: number;
  seconds: number;
  reason: SegmentEndReason;
}

export type CaptureInput =
  | {
      kind: 'frame';
      startSec: number;
      endSec: number;
      voiced: boolean;
    }
  | { kind: 'pause'; atSec: number }
  | { kind: 'stop'; atSec: number };

export interface PlanResult {
  chunks: ChunkPlan[];
  droppedShort: number;
}

export interface ChunkPlanner {
  feed(event: CaptureInput): ChunkPlan[];
  readonly open: boolean;
  readonly openStartSec: number | null;
  readonly droppedShort: number;
}

export function createChunkPlanner(config: SegmentConfig): ChunkPlanner {
  let droppedShort = 0;
  let nextIndex = 1;
  let start: number | null = null;
  let carry: number | null = null;
  let silenceSec = 0;
  let previousEnd = -1;

  const finalize = (endSec: number, reason: SegmentEndReason, out: ChunkPlan[]): void => {
    if (start === null) return;
    const seconds = endSec - start;
    if (seconds <= 0) {
      throw new CaptureError('E_CAPTURE_BAD_TIMELINE', `定稿时刻 ${endSec} 不晚于分片起点 ${start}`);
    }
    if (seconds < config.minSeconds) {
      droppedShort += 1;
    } else {
      out.push({ index: nextIndex, startSec: start, endSec, seconds, reason });
      nextIndex += 1;
    }
    carry = endSec;
    start = null;
    silenceSec = 0;
  };

  return {
    get open(): boolean {
      return start !== null;
    },
    get openStartSec(): number | null {
      return start;
    },
    get droppedShort(): number {
      return droppedShort;
    },
    feed(event: CaptureInput): ChunkPlan[] {
      const out: ChunkPlan[] = [];
      if (event.kind === 'frame' && (event.endSec < event.startSec || event.startSec < previousEnd)) {
        throw new CaptureError(
          'E_CAPTURE_BAD_TIMELINE',
          `帧时间轴必须单调不减：收到 [${event.startSec}, ${event.endSec}]，上一帧结束于 ${previousEnd}`,
        );
      }
      if (event.kind === 'pause') {
        finalize(event.atSec, 'pause', out);
        carry = null;
        previousEnd = event.atSec;
        return out;
      }
      if (event.kind === 'stop') {
        finalize(event.atSec, 'manual-stop', out);
        previousEnd = event.atSec;
        return out;
      }

      if (start === null) {
        if (!event.voiced) {
          previousEnd = event.endSec;
          return out;
        }
        start = carry ?? event.startSec;
      }
      silenceSec = event.voiced ? 0 : silenceSec + (event.endSec - event.startSec);

      if (event.endSec - start >= config.maxSeconds) {
        finalize(event.endSec, 'maxSeconds', out);
      } else if (!event.voiced && silenceSec * 1000 >= config.silenceMs) {
        finalize(event.endSec, 'silence', out);
      }
      previousEnd = event.endSec;
      return out;
    },
  };
}

const TIMELINE_EPS = 1e-9;

export interface CaptureFrame {
  startSec: number;
  endSec: number;
  voiced: boolean;
  pcm: Uint8Array;
}

export interface AssembledChunk {
  plan: ChunkPlan;
  /** 该段对应的 WAV 字节（16k / 单声道 / 16-bit） */
  audio: Uint8Array;
}

export interface ChunkAssembler {
  feed(frame: CaptureFrame): AssembledChunk[];
  finish(atSec: number): AssembledChunk[];
  readonly openStartSec: number | null;
  readonly droppedShort: number;
}

export function createChunkAssembler(config: SegmentConfig): ChunkAssembler {
  const planner = createChunkPlanner(config);
  const frames: CaptureFrame[] = [];

  const take = (plan: ChunkPlan): AssembledChunk => {
    while (frames.length > 0 && (frames[0] as CaptureFrame).endSec <= plan.startSec + TIMELINE_EPS) frames.shift();
    const taken: CaptureFrame[] = [];
    while (frames.length > 0 && (frames[0] as CaptureFrame).endSec <= plan.endSec + TIMELINE_EPS) taken.push(frames.shift() as CaptureFrame);
    const total = taken.reduce((sum, frame) => sum + frame.pcm.byteLength, 0);
    const pcm = new Uint8Array(total);
    let offset = 0;
    for (const frame of taken) {
      pcm.set(frame.pcm, offset);
      offset += frame.pcm.byteLength;
    }
    return { plan, audio: encodeCaptureWav(pcm) };
  };

  return {
    get openStartSec(): number | null {
      return planner.openStartSec;
    },
    get droppedShort(): number {
      return planner.droppedShort;
    },
    feed(frame: CaptureFrame): AssembledChunk[] {
      frames.push(frame);
      return planner
        .feed({ kind: 'frame', startSec: frame.startSec, endSec: frame.endSec, voiced: frame.voiced })
        .map(take);
    },
    finish(atSec: number): AssembledChunk[] {
      return planner.feed({ kind: 'stop', atSec }).map(take);
    },
  };
}

export function planChunks(events: CaptureInput[], config: SegmentConfig): PlanResult {
  const planner = createChunkPlanner(config);
  const chunks: ChunkPlan[] = [];
  for (const event of events) chunks.push(...planner.feed(event));
  return { chunks, droppedShort: planner.droppedShort };
}

export interface AsrDeps {
  transport?: CaptureTransport;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  apiKey?: string;
  apiSecret?: string;
}

export interface AsrClient {
  transcribe(request: { index: number; audio: Uint8Array; sessionId: string }): Promise<{ text: string; taskId: string }>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function createAsrClient(config: AsrConfig, deps: AsrDeps = {}): AsrClient {
  const transport = deps.transport ?? defaultTransport;
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? (() => Date.now());
  const credentials: AsrCredentials = {
    ...(deps.apiKey === undefined ? {} : { apiKey: deps.apiKey }),
    ...(deps.apiSecret === undefined ? {} : { apiSecret: deps.apiSecret }),
  };
  const spec = vendorOf(config.kind);
  const protocol = ASR_PROTOCOLS[config.kind];

  const timeoutError = (): CaptureError =>
    new CaptureError(
      'E_CAPTURE_ASR_TIMEOUT',
      `单段转写超过 ${config.pollTimeoutMs}ms 仍未完成，判定该段失败（院内那台接口没有失败态，超时是唯一的终止条件；` +
        '公有云是一次性请求，同一份预算仍然成立 —— "无限等"在任何一家都不允许）',
      false,
    );

  return {
    async transcribe({ index, audio, sessionId }) {
      if (config.endpoint === '' || config.modelId === '') {
        throw new CaptureError(
          'E_CAPTURE_NOT_CONFIGURED',
          '未配置语音识别服务（asr.endpoint / asr.modelId 至少一项为空）：采集入口不可用，且不会退回"模拟一段录音转写"',
        );
      }
      assertPublicCloudAcknowledged(spec, config.acknowledgePublicCloud);
      const missing = missingCredentials(spec, credentials, config.appKey);
      if (missing.length > 0) {
        throw new CaptureError(
          'E_CAPTURE_CREDENTIAL_MISSING',
          `${spec.label}需要 ${missing.join('、')}：凭据没配全就**不发出任何请求** —— ` +
            '发一个注定 401 的包没有任何价值，而它会让"凭据缺失"表现成"识别失败"（两件事的处置完全不同）',
        );
      }

      const deadline = now() + config.pollTimeoutMs;
      const remaining = (): number => deadline - now();

      const call = async (request: CaptureTransportRequest, timeoutMs: number): Promise<CaptureTransportResponse> => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          return await transport({ ...request, signal: controller.signal });
        } finally {
          clearTimeout(timer);
        }
      };

      return protocol({ index, audio, sessionId }, { config, credentials, call, remaining, timeoutError, sleep, now });
    },
  };
}

export interface CaptureChunk {
  index: number;
  startSec: number;
  endSec: number;
  text: string;
}

export interface CaptureFailure {
  index: number;
  startSec: number;
  endSec: number;
  code: string;
  message: string;
}

export interface CaptureResult {
  sessionId: string;
  asrModelId: string;
  chunks: CaptureChunk[];
  failures: CaptureFailure[];
  emptyDropped: number;
  shortDropped: number;
  audioRetained: boolean;
  warnings: string[];
}

export type ChunkOutcome =
  | { status: 'ok'; chunk: CaptureChunk }
  | { status: 'empty'; index: number; startSec: number; endSec: number }
  | { status: 'failed'; failure: CaptureFailure };

export interface AudioTempStore {
  write(name: string, bytes: Uint8Array): Promise<string>;
  remove(handle: string): Promise<void>;
}

export interface CaptureSessionRequest {
  sessionId: string;
  events: CaptureInput[];
  /** 片 → 音频字节（须为 {@link CAPTURE_AUDIO} 规格的 WAV）；真实实现由采集端给出 */
  audioFor: (chunk: ChunkPlan) => Uint8Array;
  tempStore: AudioTempStore;
  onChunk?: (outcome: ChunkOutcome) => void;
}

export async function captureSession(
  request: CaptureSessionRequest,
  config: CaptureConfig,
  deps: AsrDeps = {},
): Promise<CaptureResult> {
  const plan = planChunks(request.events, config.segment);
  const client = createAsrClient(config.asr, deps);
  const chunks: CaptureChunk[] = [];
  const failures: CaptureFailure[] = [];
  const written: string[] = [];
  let emptyDropped = 0;

  try {
    for (const planned of plan.chunks) {
      const bytes = request.audioFor(planned);
      try {
        written.push(await request.tempStore.write(`${request.sessionId}#${planned.index}.wav`, bytes));
        const { text } = await client.transcribe({ index: planned.index, audio: bytes, sessionId: request.sessionId });
        if (text.trim() === '') {
          /* 空串是合法结果（这段没听到内容），但必须计数：静默少一段比报错更难发现 */
          emptyDropped += 1;
          request.onChunk?.({ status: 'empty', index: planned.index, startSec: planned.startSec, endSec: planned.endSec });
          continue;
        }
        const chunk: CaptureChunk = { index: planned.index, startSec: planned.startSec, endSec: planned.endSec, text };
        chunks.push(chunk);
        request.onChunk?.({ status: 'ok', chunk });
      } catch (err) {
        if (!(err instanceof CaptureError)) throw err;
        const failure: CaptureFailure = {
          index: planned.index,
          startSec: planned.startSec,
          endSec: planned.endSec,
          code: err.code,
          message: err.message,
        };
        failures.push(failure);
        request.onChunk?.({ status: 'failed', failure });
      }
    }
  } finally {
    if (!config.retainAudio) {
      for (const handle of written) await request.tempStore.remove(handle);
    }
  }

  const warnings: string[] = [];
  if (plan.droppedShort > 0) {
    warnings.push(`已忽略 ${plan.droppedShort} 段过短语音（低于 ${config.segment.minSeconds}s，按误触丢弃）`);
  }
  if (emptyDropped > 0) {
    warnings.push(`${emptyDropped} 段识别结果为空：该段没有说话内容（空串是合法结果，但要如实回报）`);
  }
  if (failures.length > 0) {
    warnings.push(
      `${plan.chunks.length} 段中有 ${failures.length} 段转写失败：${failures.map((item) => `第 ${item.index} 段(${item.code})`).join('、')}`,
    );
  }
  if (!config.retainAudio && written.length > 0) {
    warnings.push('音频未留存：转写完成后临时文件已删除，争议时无法回放（这是刻意的默认）');
  }

  return {
    sessionId: request.sessionId,
    asrModelId: config.asr.modelId,
    chunks,
    failures,
    emptyDropped,
    shortDropped: plan.droppedShort,
    audioRetained: config.retainAudio && written.length > 0,
    warnings,
  };
}

export function toDictationInput(result: CaptureResult, at: ISODateTime, options: { confidenceCeiling: number }): DictationInput {
  return {
    transcriptionId: result.sessionId,
    asrModelId: result.asrModelId,
    at,
    segments: result.chunks.map((chunk) => ({
      index: chunk.index,
      text: chunk.text,
      startSec: chunk.startSec,
      endSec: chunk.endSec,
      confidence: options.confidenceCeiling,
    })),
  };
}

export interface SubmittedSegment {
  index: number;
  text: string;
  startSec: number;
  endSec: number;
}

export function validateSubmittedSegments(raw: unknown, options: { confidenceCeiling: number }): TranscriptSegment[] {
  if (!Array.isArray(raw)) {
    throw new CaptureError('E_CAPTURE_BAD_SEGMENTS', `转写段必须是数组，实际 ${typeof raw}`);
  }
  if (raw.length === 0) {
    throw new CaptureError(
      'E_CAPTURE_BAD_SEGMENTS',
      '没有任何转写段：不把"没有产出"当成"没有建议"（那会让"这段没转出来"看起来像"本来就没什么可说"）',
    );
  }
  const seen = new Set<number>();
  return raw.map((entry, position) => {
    const where = `第 ${position + 1} 项`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new CaptureError('E_CAPTURE_BAD_SEGMENTS', `${where}必须是对象`);
    }
    const item = entry as Record<string, unknown>;
    if (item.confidence !== undefined) {
      throw new CaptureError(
        'E_CAPTURE_BAD_SEGMENTS',
        `${where}带上了 confidence：置信度不由请求指定（该 ASR 也不回它），一律按配置的上限处理`,
      );
    }
    const index = item.index;
    if (typeof index !== 'number' || !Number.isInteger(index) || index <= 0) {
      throw new CaptureError('E_CAPTURE_BAD_SEGMENTS', `${where}的 index 必须是正整数（段号从 1 起），实际 ${JSON.stringify(index)}`);
    }
    if (seen.has(index)) {
      throw new CaptureError('E_CAPTURE_BAD_SEGMENTS', `段号 ${index} 出现了两次：一次录音里段号必须唯一（重复段号的区间会重叠，留痕也指不清）`);
    }
    seen.add(index);
    const text = item.text;
    if (typeof text !== 'string') {
      throw new CaptureError('E_CAPTURE_BAD_SEGMENTS', `${where}的 text 必须是字符串（空串合法，表示这段没听到内容），实际 ${typeof text}`);
    }
    const startSec = item.startSec;
    const endSec = item.endSec;
    if (typeof startSec !== 'number' || !Number.isFinite(startSec) || typeof endSec !== 'number' || !Number.isFinite(endSec)) {
      throw new CaptureError(
        'E_CAPTURE_BAD_SEGMENTS',
        `${where}的 startSec / endSec 必须是有限数（时间区间只能由采集端给出，服务端不代编）：实际 ${JSON.stringify({ startSec, endSec })}`,
      );
    }
    if (endSec <= startSec) {
      throw new CaptureError(
        'E_CAPTURE_BAD_SEGMENTS',
        `第 ${index} 段的区间 [${startSec}, ${endSec}] 不是正长度：零长度的时间区间是一种无法核对的证据`,
      );
    }
    return { index, text, startSec, endSec, confidence: options.confidenceCeiling };
  });
}

