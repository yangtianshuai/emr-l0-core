import {
  createChunkAssembler,
  type AssembledChunk,
  type CaptureFailure,
  type CaptureFrame,
  type SegmentConfig,
} from './capture.ts';

export interface BridgeSegmentMeta {
  /** 段号（从 1 起，由分片器给出；页面不得代编）  */
  index: number;
  startSec: number;
  endSec: number;
}

export type BridgeState = 'idle' | 'recording' | 'done';

export type BridgeNext =
  | { kind: 'segment'; sessionId: string; segment: BridgeSegmentMeta; audioBytes: number }
  | { kind: 'empty'; sessionId: string; state: BridgeState; finalized: number }
  | { kind: 'done'; sessionId: string; total: number; delivered: number; failures: CaptureFailure[]; shortDropped: number };

export type BridgeAckResult =
  | { ok: true; delivered: number }
  | { ok: false; code: 'E_BRIDGE_ACK_OUT_OF_ORDER' | 'E_BRIDGE_SEGMENT_GONE'; message: string };

export interface CaptureBridgeProgress {
  sessionId: string;
  state: BridgeState;
  finalized: number;
  delivered: number;
  failed: number;
  shortDropped: number;
  elapsedSec: number;
  currentChunkSec: number;
  voiced: boolean;
  level: number;
}

export interface CaptureBridge {
  readonly sessionId: string;
  readonly state: BridgeState;
  feed(frame: CaptureFrame): void;
  finish(atSec: number): void;
  next(): BridgeNext;
  /** 确认处理结果；`ok: false` 时必须带上失败原因（页面那一侧的分类失败） */
  ack(index: number, ok: boolean, failure?: { code: string; message: string }): BridgeAckResult;
  /** 某一段的 WAV 字节；仅在该段尚未被 ack 时可用（ack 即释放）  */
  audioOf(index: number): Uint8Array | null;
  progress(): CaptureBridgeProgress;
}

interface QueuedSegment {
  meta: BridgeSegmentMeta;
  audio: Uint8Array;
}

function levelOfPcm(pcm: Uint8Array): number {
  const samples = Math.floor(pcm.byteLength / 2);
  if (samples === 0) return 0;
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let sum = 0;
  for (let i = 0; i < samples; i += 1) {
    const value = view.getInt16(i * 2, true) / 32768;
    sum += value * value;
  }
  return Math.min(1, Math.sqrt(sum / samples));
}

export function createCaptureBridge(options: { sessionId: string; segment: SegmentConfig }): CaptureBridge {
  const assemble = createChunkAssembler(options.segment);
  const queue: QueuedSegment[] = [];
  const failures: CaptureFailure[] = [];
  let state: BridgeState = 'idle';
  let delivered = 0;
  let finalized = 0;
  let elapsedSec = 0;
  let voiced = false;
  let level = 0;

  const push = (chunks: AssembledChunk[]): void => {
    for (const chunk of chunks) {
      finalized += 1;
      queue.push({
        meta: { index: chunk.plan.index, startSec: chunk.plan.startSec, endSec: chunk.plan.endSec },
        audio: chunk.audio,
      });
    }
  };

  return {
    sessionId: options.sessionId,
    get state(): BridgeState {
      return state;
    },
    feed(frame) {
      if (state === 'done') throw new Error('采集已结束：不再接受新帧（否则队列会在 done 之后继续长出来）');
      state = 'recording';
      elapsedSec = frame.endSec;
      voiced = frame.voiced;
      level = levelOfPcm(frame.pcm);
      push(assemble.feed(frame));
    },
    finish(atSec) {
      if (state === 'done') return;
      elapsedSec = Math.max(elapsedSec, atSec);
      voiced = false;
      level = 0;
      push(assemble.finish(atSec));
      state = 'done';
    },
    next(): BridgeNext {
      const head = queue[0];
      if (head) {
        return { kind: 'segment', sessionId: options.sessionId, segment: { ...head.meta }, audioBytes: head.audio.byteLength };
      }
      if (state === 'done') {
        return {
          kind: 'done',
          sessionId: options.sessionId,
          total: finalized,
          delivered,
          failures: [...failures],
          shortDropped: assemble.droppedShort,
        };
      }
      return { kind: 'empty', sessionId: options.sessionId, state, finalized };
    },
    ack(index, ok, failure): BridgeAckResult {
      const head = queue[0];
      if (!head) {
        return { ok: false, code: 'E_BRIDGE_SEGMENT_GONE', message: `第 ${index} 段不在队列里（可能已经确认过了）` };
      }
      if (head.meta.index !== index) {
        return {
          ok: false,
          code: 'E_BRIDGE_ACK_OUT_OF_ORDER',
          message: `第 ${index} 段不是当前待确认的那一段（当前是第 ${head.meta.index} 段）：拒绝按序之外的确认`,
        };
      }
      queue.shift();
      delivered += 1;
      if (!ok) {
        failures.push({
          index: head.meta.index,
          startSec: head.meta.startSec,
          endSec: head.meta.endSec,
          code: failure?.code ?? 'E_CAPTURE_SEGMENT_FAILED',
          message: failure?.message ?? '该段在页面上传或转写环节失败（原因未回报）',
        });
      }
      return { ok: true, delivered };
    },
    audioOf(index) {
      const head = queue[0];
      return head && head.meta.index === index ? head.audio : null;
    },
    progress(): CaptureBridgeProgress {
      const openStart = assemble.openStartSec;
      return {
        sessionId: options.sessionId,
        state,
        finalized,
        delivered,
        failed: failures.length,
        shortDropped: assemble.droppedShort,
        elapsedSec,
        currentChunkSec: openStart === null ? 0 : Math.max(0, elapsedSec - openStart),
        voiced,
        level,
      };
    },
  };
}

export function tokenFromRequest(input: { header?: string | undefined; query?: string | undefined }): string {
  const fromHeader = (input.header ?? '').trim();
  if (fromHeader !== '') return fromHeader;
  return (input.query ?? '').trim();
}

export function checkBridgeToken(expected: string, provided: string): { ok: true } | { ok: false; code: string; message: string } {
  if (expected.trim() === '') {
    return { ok: false, code: 'E_BRIDGE_NO_TOKEN', message: '本地客户端没有配置令牌：拒绝服务（没有令牌的回环端口等于对全机开放）' };
  }
  if (provided !== expected) {
    return { ok: false, code: 'E_BRIDGE_BAD_TOKEN', message: '令牌不匹配：请从本地客户端打开的页面进入（页面地址里带着一次性令牌）' };
  }
  return { ok: true };
}
