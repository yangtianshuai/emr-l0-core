/**
 * 本地客户端 ↔ 页面的桥（C3b③）：**段交接的服务端侧**（跑在客户端进程里）。
 *
 * ## 为什么要有这一层
 *
 * 形态见 `docs/L2-语音采集设计.md` 第九之三节：麦克风由**本机客户端**采（不受安全上下文约束），
 * **分片也在客户端做**（它有音频，也能直接复用 `capture.ts` 的同一份规则），
 * 页面只做两件事：把段取过来、上传给同源采集路由（由服务端转发 ASR）。
 *
 * 于是"段"成了客户端与页面之间唯一要谈的东西。本模块就是那本账：
 *
 * ```
 * 采集源 ──帧──► createChunkAssembler（同一份分片规则）──► 段队列
 *                                                          │  next()（幂等：未 ack 前重复给同一段）
 *                                                          ▼
 *                                             页面 ──► 上传同源路由 ──► ASR
 *                                                          │
 *                                              ack(index, ok) ◄── 成或败都要回来说一声
 * ```
 *
 * ## 四条不可让步的规则
 *
 * 1) **取走不等于处理完**：只有 `ack` 才推进队列。否则页面一次网络抖动就会让那一段**静默消失**
 *    （"我说的话被吞了"是最难查的一类现场）；未 ack 时 `next` 会**再给同一段**，页面重试是安全的；
 * 2) **ack 必须按序**：只认队列头那一段。乱序 ack 说明页面那一侧错位了（例如把两次采集的段
 *    混在了一起），此时**报错而不是"顺手删掉一个"** —— 顺手删的现场表现是"某一句不见了"；
 * 3) **失败照样推进，但必须记账**：某段在页面上传/转写失败时，客户端要把它记进 `failures`
 *    并如实回报（同 S4：失败不阻塞其余段，但**不许静默**）；
 * 4) **音频随 ack 释放**：段一旦被确认处理，它对应的 WAV 就不该再留在内存里
 *    （一次门诊录音累积起来是几十 MB，而它已经用完了）。
 *
 * ## 它不做什么
 *
 * 不碰 ASR（上传与转写都在页面那一侧，走同源路由）、不落笔、不决定置信度。
 * 于是它可以在**没有服务端**的情况下被单独测：喂帧、取段、ack，全是纯逻辑。
 */

import {
  createChunkAssembler,
  type AssembledChunk,
  type CaptureFailure,
  type CaptureFrame,
  type SegmentConfig,
} from './capture.ts';

export interface BridgeSegmentMeta {
  /** 段号（从 1 起，由分片器给出；**页面不得代编**） */
  index: number;
  startSec: number;
  endSec: number;
}

export type BridgeState = 'idle' | 'recording' | 'done';

export type BridgeNext =
  /** 有未确认的段（幂等：未 ack 前重复取到同一段） */
  | { kind: 'segment'; sessionId: string; segment: BridgeSegmentMeta; audioBytes: number }
  /** 还没有可取的段（仍在录） */
  | { kind: 'empty'; sessionId: string; state: BridgeState; finalized: number }
  /** 采集结束且队列已清空：整次交接到此为止 */
  | { kind: 'done'; sessionId: string; total: number; delivered: number; failures: CaptureFailure[]; shortDropped: number };

export type BridgeAckResult =
  | { ok: true; delivered: number }
  | { ok: false; code: 'E_BRIDGE_ACK_OUT_OF_ORDER' | 'E_BRIDGE_SEGMENT_GONE'; message: string };

export interface CaptureBridgeProgress {
  sessionId: string;
  state: BridgeState;
  /** 已定稿的段数（含尚未被取走、以及已失败的） */
  finalized: number;
  /** 已被页面确认处理过的段数 */
  delivered: number;
  /** 页面回报失败的段数（**如实**，不当成"没有这一段"） */
  failed: number;
  shortDropped: number;
  /**
   * 已录时长（秒）：取自最后一帧的 `endSec`，**不是 wall clock** ——
   * 计时要与分片时间轴同源，否则界面上的秒数与段的区间对不上。
   */
  elapsedSec: number;
  /** 当前尚未定稿那一段已录时长（秒）；没有正在录的段时为 0 */
  currentChunkSec: number;
  /** 最近一帧是否被判为人声（由采集源给出，页面不猜） */
  voiced: boolean;
  /** 最近一帧的响度（0~1，16-bit PCM 的 RMS）：界面据此画电平，静音帧为 0 */
  level: number;
}

export interface CaptureBridge {
  readonly sessionId: string;
  readonly state: BridgeState;
  /** 采集源送来一帧（内部走 `createChunkAssembler`：与页面、服务端**同一份**分片规则） */
  feed(frame: CaptureFrame): void;
  /** 采集结束（源走完 / 医生按停）：定稿当前那一段，此后 `next()` 会在取空后回 `done` */
  finish(atSec: number): void;
  /** 取当前未确认的那一段 */
  next(): BridgeNext;
  /** 确认处理结果；`ok: false` 时必须带上失败原因（页面那一侧的分类失败） */
  ack(index: number, ok: boolean, failure?: { code: string; message: string }): BridgeAckResult;
  /** 某一段的 WAV 字节；**仅在该段尚未被 ack 时可用**（ack 即释放） */
  audioOf(index: number): Uint8Array | null;
  progress(): CaptureBridgeProgress;
}

interface QueuedSegment {
  meta: BridgeSegmentMeta;
  audio: Uint8Array;
}

/**
 * 16-bit 小端 PCM 的 RMS（0~1）。
 *
 * 为什么由桥来算、而不是页面算：页面拿不到音频（它只取段），而"录音中"的可见性与计时
 * 恰恰要在**取段之前**就能显示 —— 否则第一段定稿前的几秒，界面是静止的，
 * 看起来像"按了没反应"。这里算的是采集源真实给出的帧，不是动画。
 */
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
  /* 录音过程的可见性（计时 / 电平）：由**帧**推进，不看墙上时钟 */
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
        /* **不顺手删掉一个**：那会让"某一句不见了"变成一个查不出来的现场 */
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

/* ============================== 令牌与请求校验（纯函数，便于测） ============================== */

/** 只认 `x-capture-token` 头或 `token` 查询参数；两者都没有就等于没有令牌 */
export function tokenFromRequest(input: { header?: string | undefined; query?: string | undefined }): string {
  const fromHeader = (input.header ?? '').trim();
  if (fromHeader !== '') return fromHeader;
  return (input.query ?? '').trim();
}

/**
 * 校验令牌。**回环端口不是安全边界**：本机任何进程都能连它，
 * 所以令牌是唯一把关的东西 —— 它挡的是"误连"与"顺手扫端口"，不是"本机已被攻陷"（第九之三节）。
 */
export function checkBridgeToken(expected: string, provided: string): { ok: true } | { ok: false; code: string; message: string } {
  if (expected.trim() === '') {
    return { ok: false, code: 'E_BRIDGE_NO_TOKEN', message: '本地客户端没有配置令牌：拒绝服务（没有令牌的回环端口等于对全机开放）' };
  }
  if (provided !== expected) {
    return { ok: false, code: 'E_BRIDGE_BAD_TOKEN', message: '令牌不匹配：请从本地客户端打开的页面进入（页面地址里带着一次性令牌）' };
  }
  return { ok: true };
}
