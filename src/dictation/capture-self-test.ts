// 语音采集层自测（C1）。

import { TestSuite, assert, assertEqual, codeOfAsync } from '../testing/harness.ts';
import { buildSyntheticDoc } from '../testing/synthetic.ts';
import { openConfigFixture, sealedBlobOf, writeCorruptRow } from '../testing/config-fixture.ts';
import { WriteSession, type Actor } from '../core/session.ts';
import { normalizeSegments, toSuggestionItems } from '../core/dictation.ts';
import type { NodeId } from '../model/types.ts';
import { parseMultipartAudio } from './capture-upload.ts';
import {
  CAPTURE_API_KEY_KEY,
  CAPTURE_API_SECRET_KEY,
  CAPTURE_CONFIG_KEY,
  describeCaptureConfig,
  loadCaptureConfig,
  saveCaptureConfig,
} from './capture-store.ts';
import {
  ASR_NO_CONFIDENCE_NOTE,
  ASR_VENDORS,
  CAPTURE_AUDIO,
  CaptureError,
  captureSession,
  clearAsrTokenCache,
  createAsrClient,
  createChunkAssembler,
  createChunkPlanner,
  encodeCaptureWav,
  parseCaptureWav,
  planChunks,
  toDictationInput,
  validateCaptureConfig,
  validateSubmittedSegments,
  vendorOf,
  type AudioTempStore,
  type CaptureConfig,
  type CaptureInput,
  type CaptureResult,
  type CaptureTransport,
  type CaptureTransportRequest,
  type ChunkPlan,
  type SegmentConfig,
  type SubmittedSegment,
} from './capture.ts';
import {
  createSampleCaptureSource,
  describeSourceFailure,
  probeMicEnvironment,
  type CaptureFrame,
  type CaptureProbe,
  type CaptureSource,
} from './capture-source.ts';
import { runDictationCapture } from './capture-client.ts';
import { checkBridgeToken, createCaptureBridge, tokenFromRequest } from './capture-bridge.ts';
import {
  CAPTURE_WEB_AUDIO,
  buildWavHeaderWeb,
  createBrowserMicSource,
  createChunkAssemblerWeb,
  createChunkPlannerWeb,
  createFrameChunker,
  describeSourceFailureWeb,
  encodeCaptureWavWeb,
  probeMicEnvironmentWeb,
  resampleLinear,
} from '../demo/capture-web.js';

const suite = new TestSuite('语音采集层自测（C1）', [
  '说明：采集层在内核之外，只补 ASR 不给的三样（段号 / 时间区间 / 置信度），产出仍是「建议」。',
  'AU1/AU5/AU7/AU8/AU12 是防回退关键：时间区间不许有缝或无上限等待，配置不许静默降级，',
  '端点未配置不许假装还能转写，音频清理不许只在成功路径成立。',
]);

const test = (name: string, fn: () => void | Promise<void>): Promise<void> => suite.test(name, fn);

const HUMAN: Actor = { id: 'DR_WANG', kind: 'human' };
const AI: Actor = { id: 'asr-pipeline', kind: 'ai' };

/** 造一段 16k 单声道 16-bit PCM：内容是假的，格式必须是真的（格式不对，对拍就没有意义）  */
function pcmOf(seconds: number, voiced: boolean): Uint8Array {
  const samples = Math.round(CAPTURE_AUDIO.sampleRate * seconds);
  const pcm = new Uint8Array(samples * 2);
  if (!voiced) return pcm;
  const view = new DataView(pcm.buffer);
  for (let i = 0; i < samples; i += 1) view.setInt16(i * 2, (i % 200) - 100, true);
  return pcm;
}

/** 让出一个事件循环：权限申请、设备打开这类异步点要等它落定 */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * 假麦克风：假 `getUserMedia` + 假 AudioContext。
 *
 * 自测绝不去开真麦克风：那种自测会在没有设备的机器上失败，
 * 而反复失败的自测最终会被所有人忽略（比没有自测更糟）。
  */
function makeFakeMic(): {
  options: {
    env: { isSecureContext: boolean; hasGetUserMedia: boolean; hasAudioContext: boolean };
    getUserMedia: () => Promise<unknown>;
    audioContextCtor: unknown;
  };
  drive: (seconds: number) => void;
  tracksStopped: () => number;
} {
  let proc: { onaudioprocess: ((event: unknown) => void) | null; connect: () => void; disconnect: () => void } | null = null;
  let stoppedTracks = 0;
  const track = { stop: (): void => { stoppedTracks += 1; }, onended: null as null | (() => void) };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  class FakeAudioContext {
    sampleRate = 48_000;
    destination = { connect: (): void => {} };
    createMediaStreamSource(): { connect: () => void; disconnect: () => void } {
      return { connect: (): void => {}, disconnect: (): void => {} };
    }
    createScriptProcessor() {
      const node = { onaudioprocess: null as ((event: unknown) => void) | null, connect: (): void => {}, disconnect: (): void => {} };
      proc = node;
      return node;
    }
    createGain() {
      return { gain: { value: 1 }, connect: (): void => {}, disconnect: (): void => {} };
    }
    async close(): Promise<void> {}
  }
  /** 按音频回调的形状喂音频（真实设备一次给一小块，这里也一样） */
  const drive = (seconds: number): void => {
    const block = new Float32Array(4096);
    for (let i = 0; i < block.length; i += 1) block[i] = 0.3;
    let fed = 0;
    const total = Math.round(48_000 * seconds);
    while (fed < total) {
      const size = Math.min(block.length, total - fed);
      const node = proc;
      if (node !== null && node.onaudioprocess !== null) {
        node.onaudioprocess({ inputBuffer: { getChannelData: () => (size === block.length ? block : block.subarray(0, size)) } });
      }
      fed += size;
    }
  };
  return {
    options: {
      env: { isSecureContext: true, hasGetUserMedia: true, hasAudioContext: true },
      getUserMedia: async () => stream,
      audioContextCtor: FakeAudioContext,
    },
    drive,
    tracksStopped: () => stoppedTracks,
  };
}

const ASR_ENDPOINT = 'http://asr.test:8089';
const ASR_MODEL = 'local/asr-zh-med:0.9@2026-09-demo';

function codeOf(fn: () => unknown): string {
  try {
    fn();
    return 'OK';
  } catch (err) {
    return (err as { code?: string }).code ?? `UNEXPECTED:${(err as Error).message}`;
  }
}

function configWith(patch: Parameters<typeof validateCaptureConfig>[0] = {}): CaptureConfig {
  return validateCaptureConfig({
    asr: { endpoint: ASR_ENDPOINT, modelId: ASR_MODEL, ...patch.asr },
    ...(patch.segment ? { segment: patch.segment } : {}),
    ...(patch.retainAudio !== undefined ? { retainAudio: patch.retainAudio } : {}),
    ...(patch.confidenceCeiling !== undefined ? { confidenceCeiling: patch.confidenceCeiling } : {}),
  });
}

const SEGMENT: Partial<SegmentConfig> = { silenceMs: 800, maxSeconds: 30, minSeconds: 1 };

const vframe = (startSec: number, endSec: number): CaptureInput => ({ kind: 'frame', startSec, endSec, voiced: true });
const sframe = (startSec: number, endSec: number): CaptureInput => ({ kind: 'frame', startSec, endSec, voiced: false });
const pause = (atSec: number): CaptureInput => ({ kind: 'pause', atSec });
const stop = (atSec: number): CaptureInput => ({ kind: 'stop', atSec });

/** 一段连续人声（按 step 切成帧） */
function voiced(fromSec: number, toSec: number, step = 1): CaptureInput[] {
  const frames: CaptureInput[] = [];
  for (let t = fromSec; t < toSec - 1e-9; t += step) {
    frames.push(vframe(Number(t.toFixed(6)), Number(Math.min(t + step, toSec).toFixed(6))));
  }
  return frames;
}

/** 用「人声 + 暂停定稿」拼出边界精确的分片序列（时间区间完全可控，便于断言 evidence.ref） */
function byPause(windows: Array<[number, number]>, tail: number): CaptureInput[] {
  const events: CaptureInput[] = [];
  for (const [from, to] of windows) {
    events.push(...voiced(from, to, 1), pause(to));
  }
  events.push(vframe(tail, tail + 1), stop(tail + 1));
  return events;
}

interface FakeClock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  elapsed: () => number;
}

/** 假时钟：`sleep` 直接推进时间，自测不真的等 */
function fakeClock(): FakeClock {
  let current = 0;
  return {
    now: () => current,
    sleep: async (ms: number) => {
      current += ms;
    },
    elapsed: () => current,
  };
}

interface FakeAsr {
  transport: CaptureTransport;
  calls: CaptureTransportRequest[];
  submits: number[];
  polls: number[];
}

/** 段号（从文件名或轮询 URL 里取），便于"某一段失败"这类用例精确指定 */
function indexOf(request: CaptureTransportRequest): number {
  const name = request.audio?.filename ?? '';
  const fromName = /#(\d+)\.wav$/.exec(name);
  if (fromName) return Number(fromName[1]);
  const fromUrl = /\/([^/]+)$/.exec(request.url);
  const fromTask = fromUrl ? /-(\d+)$/.exec(fromUrl[1] as string) : null;
  return fromTask ? Number(fromTask[1]) : -1;
}

function fakeAsr(handle: (request: CaptureTransportRequest, index: number) => { status: number; body: string }): FakeAsr {
  const calls: CaptureTransportRequest[] = [];
  const submits: number[] = [];
  const polls: number[] = [];
  return {
    calls,
    submits,
    polls,
    transport: async (request) => {
      calls.push(request);
      const index = indexOf(request);
      if (request.method === 'POST') submits.push(index);
      else polls.push(index);
      return handle(request, index);
    },
  };
}

/** 默认假 ASR：提交成功、轮询 done，文本由段号决定 */
function okAsr(textFor: (index: number) => string): FakeAsr {
  return fakeAsr((request, index) =>
    request.method === 'POST'
      ? { status: 200, body: JSON.stringify({ code: 200, task_id: `task-${index}` }) }
      : { status: 200, body: JSON.stringify({ status: 'done', result: textFor(index) }) },
  );
}

/**
 * 发出去的那一段 WAV：内容不重要，形状与长度重要（用例要断言"发出去的还是取出来的那一段"）。
 * 用 `encodeCaptureWav` 造而不是手写字节数组：长度 3200 是 16-bit 整数倍 ✓，
 * 而且这样一来"采集端产出的规格"与"发出去的字节"在用例里是同一份来源。
  */
const WAV_BYTES = encodeCaptureWav(new Uint8Array(3200));

/**
 * 三家的返回码照其公开文档写在这里，与实现各自独立。
 *
 * 独立是关键：若测试常量直接 import 实现里的私有常量，两边一起改错时用例照样绿 ——
 * 那种绿灯比没有用例更糟（它给了"已验证"的错觉）。
  */
const BAIDU_EMPTY_CODE = 3302;
const BAIDU_BAD_AUDIO_CODE = 3301;
const BAIDU_TOKEN_INVALID_CODE = 110;
const ALIYUN_OK_CODE = 20_000_000;
const ALIYUN_EMPTY_CODE = 4_000_000_1;
const ALIYUN_QUOTA_CODE = 4_000_000_5;

const isOauth = (request: CaptureTransportRequest): boolean => request.url.includes('/oauth/2.0/token');
const OAUTH_BODY = JSON.stringify({ access_token: 'tok-1', expires_in: 2_592_000 });
const baiduOk = (text: string): { status: number; body: string } => ({
  status: 200,
  body: JSON.stringify({ err_no: 0, err_msg: 'success.', result: [text] }),
});
const baiduErr = (errNo: number): { status: number; body: string } => ({
  status: 200,
  body: JSON.stringify({ err_no: errNo, err_msg: 'failed' }),
});

/** 云厂商的假服务：每次请求都留档（"请求长什么样"全靠它断言） */
function fakeCloud(
  handle: (request: CaptureTransportRequest, seq: number) => { status: number; body: string },
): { calls: CaptureTransportRequest[]; transport: CaptureTransport } {
  const calls: CaptureTransportRequest[] = [];
  return {
    calls,
    transport: async (request) => {
      calls.push(request);
      return handle(request, calls.length);
    },
  };
}

/** 建一个客户端并把时钟交出来：云厂商用例要能断言"一次都没睡"（它们没有轮询） */
function asrClient(
  config: CaptureConfig,
  transport: CaptureTransport,
  credentials: { apiKey?: string; apiSecret?: string } = {},
  clock: FakeClock = fakeClock(),
): { client: ReturnType<typeof createAsrClient>; clock: FakeClock } {
  return {
    client: createAsrClient(config.asr, {
      transport,
      ...(credentials.apiKey === undefined ? {} : { apiKey: credentials.apiKey }),
      ...(credentials.apiSecret === undefined ? {} : { apiSecret: credentials.apiSecret }),
      sleep: clock.sleep,
      now: clock.now,
    }),
    clock,
  };
}

interface FakeTempStore {
  store: AudioTempStore;
  written: string[];
  removed: string[];
}

function memoryTempStore(): FakeTempStore {
  const written: string[] = [];
  const removed: string[] = [];
  return {
    written,
    removed,
    store: {
      async write(name) {
        written.push(name);
        return `/runtime/audio/${name}`;
      },
      async remove(handle) {
        removed.push(handle);
      },
    },
  };
}

const AUDIO = encodeCaptureWav(new Uint8Array(1600));

/* ------------------------------ C3a：采集源与编排用的假件 ------------------------------ */

/** 假帧的 PCM 长度：每帧 8 字节（2 个 16-bit 样本），开头 4 字节记"我是第几帧" */
const FRAME_BYTES = 8;

/** 记着"我是第几帧"的 PCM：拼接一旦错位（多带一帧、少带一帧），`framesOfAudio` 立刻看得出来 */
function markerPcm(index: number): Uint8Array {
  const pcm = new Uint8Array(FRAME_BYTES);
  new DataView(pcm.buffer).setInt32(0, index, true);
  return pcm;
}

/** 从上传的 WAV 里读出"它是由哪几帧拼成的"（跳过 44 字节头，按帧长取标记） */
function framesOfAudio(audio: Uint8Array): number[] {
  const { dataBytes } = parseCaptureWav(audio);
  const view = new DataView(audio.buffer, audio.byteOffset, audio.byteLength);
  const markers: number[] = [];
  for (let offset = 44; offset + FRAME_BYTES <= 44 + dataBytes; offset += FRAME_BYTES) {
    markers.push(view.getInt32(offset, true));
  }
  return markers;
}

/**
 * 脚本帧序列：每段 1s，人声与静音交替，最后一段人声收尾。
 *
 * 按 `silenceMs=800` 应切出 4 段：`[0,2] [2,4] [4,6] [6,7]` —— 边界精确，便于断言
 * "每段只带该段区间内的帧"（拼错就等于给了 ASR 另一段音频）。
 */
function buildScriptedFrames(): CaptureFrame[] {
  const script: Array<{ seconds: number; voiced: boolean }> = [
    { seconds: 1, voiced: true },
    { seconds: 1, voiced: false },
    { seconds: 1, voiced: true },
    { seconds: 1, voiced: false },
    { seconds: 1, voiced: true },
    { seconds: 1, voiced: false },
    { seconds: 1, voiced: true },
  ];
  const frames: CaptureFrame[] = [];
  let index = 0;
  let cursor = 0;
  for (const segment of script) {
    const frameSec = 0.5;
    const count = Math.round(segment.seconds / frameSec);
    for (let i = 0; i < count; i += 1) {
      const to = Number((cursor + frameSec).toFixed(6));
      frames.push({ startSec: cursor, endSec: to, voiced: segment.voiced, pcm: markerPcm(index) });
      cursor = to;
      index += 1;
    }
  }
  return frames;
}

/** 固定帧序列的采集源（自测用：把"录音"变成确定性事件） */
function fixedSource(frames: CaptureFrame[], probe: CaptureProbe = { ok: true, sourceId: 'test-fixed' }): CaptureSource {
  return {
    id: 'test-fixed',
    probe: () => probe,
    async start(onFrame) {
      for (const frame of frames) {
        onFrame(frame);
        /* 每帧之间让出一次：真实采集里帧是隔一段时间到达的，中间那几段会在"录的过程中"就转完；
           若这里同步吐完所有帧，编排里的时序竞态（例如"录完最后一段没人转"）会被自测掩盖 —— 实测踩到过。
           让出一次之后，自测里的时序与真实时间下的时序同形。  */
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    },
    async stop() {},
  };
}

async function main(): Promise<void> {
  await test('AU1 超长强制切分：相邻分片首尾相接（end_i === start_{i+1}，S2）', () => {
    const plan = planChunks([...voiced(0, 45, 1), stop(45)], { silenceMs: 800, maxSeconds: 30, minSeconds: 1 });

    assertEqual(plan.chunks.length, 2, '45s 连续口述在 30s 上限处应被强制切成两段');
    assertEqual(plan.chunks[0]?.reason, 'maxSeconds', '第 1 段应因达到上限而定稿（不是静音）');
    assertEqual(plan.chunks[0]?.endSec, 30, '第 1 段应切在 30s');
    assertEqual(plan.chunks[1]?.startSec, 30, '第 2 段应从第 1 段的结束点开始（不留缝、不重叠）');
    assertEqual(plan.chunks[0]?.endSec, plan.chunks[1]?.startSec, 'S2：相邻分片必须首尾相接');
    assertEqual(plan.chunks.map((chunk) => chunk.reason), ['maxSeconds', 'manual-stop'], '第 2 段应由手动停止定稿');
    assertEqual(plan.droppedShort, 0, '两段都不该被当作误触');
    assertEqual(plan.chunks.map((chunk) => chunk.index), [1, 2], '段号从 1 起、与时间同序（这里不重排）');
  });

  await test('AU2 分片短于 minSeconds：丢弃但计入上报（S4）', () => {
    const dropped = planChunks([vframe(0, 0.5), stop(0.5)], { silenceMs: 800, maxSeconds: 30, minSeconds: 1 });
    assertEqual(dropped.chunks.length, 0, '0.5s 短于 1s，按误触丢弃（麦克风刚打开那串噪声不该产生一个任务）');
    assertEqual(dropped.droppedShort, 1, '丢弃必须**计入上报**：静默少一段比报错更难发现');

    /* 反例：同样起点，只是话说得够长 —— 证明不是"一律丢" */
    const kept = planChunks(
      [vframe(0, 0.5), sframe(0.5, 1), sframe(1, 1.5), stop(1.5)],
      { silenceMs: 800, maxSeconds: 30, minSeconds: 1 },
    );
    assertEqual(kept.chunks.length, 1, '静音判停后时长 1.5s ≥ minSeconds，应保留');
    assertEqual(kept.chunks[0]?.reason, 'silence', '应由静音判停定稿');
    assertEqual(kept.chunks[0]?.endSec, 1.5, '定稿时刻应是静音判定成立的那一帧');
    assertEqual(kept.droppedShort, 0, '这一片不该被丢弃');
  });

  await test('AU3 result 为空串：合法结果，丢弃并计入丢弃数', async () => {
    const asr = okAsr(() => '   ');
    const temp = memoryTempStore();
    const result = await captureSession(
      { sessionId: 'sess-empty', events: [...voiced(0, 3, 1), stop(3)], audioFor: () => AUDIO, tempStore: temp.store },
      configWith({ segment: SEGMENT }),
      { transport: asr.transport, ...fakeClock() },
    );

    assertEqual(result.chunks.length, 0, '空结果不得变成一条空建议');
    assertEqual(result.emptyDropped, 1, '空结果必须计数（静默处理的话，医生会以为自己的话被吞了）');
    assert(
      result.warnings.some((text) => text.includes('为空')),
      `空结果应如实回报，实际：${result.warnings.join(' | ')}`,
    );
  });

  await test('AU4 某段上传 5xx：只该段失败，其余照常（失败不阻塞）', async () => {
    const events = [...voiced(0, 1, 1), pause(1), ...voiced(1, 2, 1), pause(2), ...voiced(2, 3, 1), stop(3)];
    const asr = fakeAsr((request, index) => {
      if (request.method === 'POST') {
        return index === 2
          ? { status: 503, body: 'busy' }
          : { status: 200, body: JSON.stringify({ code: 200, task_id: `task-${index}` }) };
      }
      return { status: 200, body: JSON.stringify({ status: 'done', result: `第 ${index} 段口述内容` }) };
    });
    const temp = memoryTempStore();
    const result = await captureSession(
      { sessionId: 'sess-fail', events, audioFor: () => AUDIO, tempStore: temp.store },
      configWith({ segment: SEGMENT }),
      { transport: asr.transport, ...fakeClock() },
    );

    assertEqual(result.chunks.map((chunk) => chunk.index), [1, 3], '只有第 2 段失败，其余两段照常产出');
    assertEqual(result.failures.map((item) => item.index), [2], '失败段应如实回报');
    assertEqual(result.failures[0]?.code, 'E_CAPTURE_HTTP_STATUS', '5xx 应报传输层错误（错误信息不带响应体）');
    assertEqual(
      asr.submits.filter((index) => index === 2).length,
      3,
      '传输层故障重试到上限（1 + 2 次）后收口，不无限重试',
    );
    assert(
      result.warnings.some((text) => text.includes('3 段中有 1 段转写失败')),
      `失败段数必须如实回报，实际：${result.warnings.join(' | ')}`,
    );
  });

  await test('AU5 轮询一直 processing：超时即判失败，不无限等（该接口没有失败态）', async () => {
    const asr = fakeAsr((request, index) =>
      request.method === 'POST'
        ? { status: 200, body: JSON.stringify({ code: 200, task_id: `task-${index}` }) }
        : { status: 200, body: JSON.stringify({ status: 'processing' }) },
    );
    const clock = fakeClock();
    const temp = memoryTempStore();
    const result = await captureSession(
      { sessionId: 'sess-hang', events: [...voiced(0, 2, 1), stop(2)], audioFor: () => AUDIO, tempStore: temp.store },
      configWith({ asr: { pollTimeoutMs: 10_000, pollIntervalMs: 1_000, submitTimeoutMs: 5_000 }, segment: SEGMENT }),
      { transport: asr.transport, now: clock.now, sleep: clock.sleep },
    );

    assertEqual(result.failures[0]?.code, 'E_CAPTURE_ASR_TIMEOUT', '超时应判该段失败（"识别失败"与"没处理完"在这接口上长得一样）');
    assertEqual(result.chunks.length, 0, '超时段不得产出任何文本');
    assert(asr.polls.length <= 11, `轮询次数必须有上限，实际 ${asr.polls.length} 次`);
    assert(clock.elapsed() <= 11_000, `轮询总时长不应超过预算太多，实际 ${clock.elapsed()}ms`);
  });

  await test('AU6 code !== 200 / task_id 为空：抛错且不重试', async () => {
    const rejected = fakeAsr(() => ({ status: 200, body: JSON.stringify({ code: 500, message: 'bad request' }) }));
    const clock = fakeClock();
    const temp = memoryTempStore();
    const first = await captureSession(
      { sessionId: 'sess-code', events: [...voiced(0, 2, 1), stop(2)], audioFor: () => AUDIO, tempStore: temp.store },
      configWith({ segment: SEGMENT }),
      { transport: rejected.transport, now: clock.now, sleep: clock.sleep },
    );
    assertEqual(first.failures[0]?.code, 'E_CAPTURE_SUBMIT_FAILED', 'code !== 200 应报"调用方给错了"');
    assertEqual(rejected.submits.length, 1, '**不得重试 code !== 200**：重试只会错第二遍');
    assertEqual(rejected.polls.length, 0, '提交没成功就不该去轮询');

    const noTaskId = fakeAsr(() => ({ status: 200, body: JSON.stringify({ code: 200, task_id: '' }) }));
    const second = await captureSession(
      { sessionId: 'sess-notask', events: [...voiced(0, 2, 1), stop(2)], audioFor: () => AUDIO, tempStore: memoryTempStore().store },
      configWith({ segment: SEGMENT }),
      { transport: noTaskId.transport, now: clock.now, sleep: clock.sleep },
    );
    assertEqual(second.failures[0]?.code, 'E_CAPTURE_SUBMIT_FAILED', '空 task_id 不得当成提交成功');
    assertEqual(noTaskId.polls.length, 0, '不得去轮询一个不存在的任务');
  });

  await test('AU7 配置非法一律报错，不静默取默认值', () => {
    const cases: Array<[string, Parameters<typeof validateCaptureConfig>[0], string]> = [
      ['minSeconds >= maxSeconds', { segment: { minSeconds: 5, maxSeconds: 5 } }, 'E_CAPTURE_CONFIG_INVALID'],
      ['上传超时非正数', { asr: { submitTimeoutMs: 0 } }, 'E_CAPTURE_CONFIG_INVALID'],
      ['轮询超时非正数', { asr: { pollTimeoutMs: -1 } }, 'E_CAPTURE_CONFIG_INVALID'],
      ['轮询超时不超过间隔', { asr: { pollTimeoutMs: 1_000, pollIntervalMs: 1_000 } }, 'E_CAPTURE_CONFIG_INVALID'],
      ['maxSeconds 超上限', { segment: { maxSeconds: 999 } }, 'E_CAPTURE_CONFIG_INVALID'],
      ['静音判停永远轮不到', { segment: { silenceMs: 30_000, maxSeconds: 30 } }, 'E_CAPTURE_CONFIG_INVALID'],
      ['retainAudio 非布尔', { retainAudio: 'yes' as never }, 'E_CAPTURE_CONFIG_INVALID'],
      ['端点不是 http(s)', { asr: { endpoint: '10.0.0.1:8089' } }, 'E_CAPTURE_CONFIG_INVALID'],
      ['模型标识无版本/日期', { asr: { modelId: 'asr' } }, 'E_CAPTURE_CONFIG_INVALID'],
      ['置信度上限等于关键内容阈值', { confidenceCeiling: 0.9 }, 'E_CAPTURE_CEILING_TOO_HIGH'],
      ['置信度上限为 NaN', { confidenceCeiling: Number.NaN }, 'E_CAPTURE_CONFIG_INVALID'],
    ];
    for (const [name, patch, expected] of cases) {
      assertEqual(codeOf(() => validateCaptureConfig(patch)), expected, `${name} 应报 ${expected}（不静默取默认值）`);
    }

    /* 未配置是合法状态（界面要显示"未配置语音识别服务"），默认值只在这里补齐  */
    const fallback = validateCaptureConfig({});
    assertEqual(fallback.asr.endpoint, '', '未配置端点应为空串（采集入口据此 fail-closed）');
    assertEqual(fallback.asr.submitTimeoutMs, 15_000, '上传超时默认 15s');
    assertEqual(fallback.asr.pollIntervalMs, 1_000, '轮询间隔默认 1s');
    assertEqual(fallback.asr.pollTimeoutMs, 90_000, '单段总预算默认 90s');
    assertEqual(fallback.segment, { silenceMs: 800, maxSeconds: 30, minSeconds: 1 }, '分片默认值应稳定');
    assertEqual(fallback.retainAudio, false, '**默认不留存音频**');
    assertEqual(fallback.confidenceCeiling, 0.85, '未给置信度时填 0.85（< 0.90）');

    const filled = configWith({ asr: { pollTimeoutMs: 60_000 }, confidenceCeiling: 0.6 });
    assertEqual(filled.asr.pollTimeoutMs, 60_000, '合法值应原样生效');
    assertEqual(filled.confidenceCeiling, 0.6, '合法上限应原样生效');
  });

  await test('AU8 端点未配置：采集入口不可用，且不静默退回"模拟转写"', async () => {
    let touched = 0;
    const transport: CaptureTransport = async () => {
      touched += 1;
      return { status: 200, body: JSON.stringify({ code: 200, task_id: 't' }) };
    };
    const clock = fakeClock();
    const temp = memoryTempStore();
    const result = await captureSession(
      { sessionId: 'sess-unconfigured', events: [...voiced(0, 2, 1), stop(2)], audioFor: () => AUDIO, tempStore: temp.store },
      validateCaptureConfig({}),
      { transport, now: clock.now, sleep: clock.sleep },
    );

    assertEqual(result.chunks.length, 0, '未配置不得产出任何"看起来成功"的转写');
    assertEqual(result.failures[0]?.code, 'E_CAPTURE_NOT_CONFIGURED', '应明确报"未配置"，而不是 500 或静默成功');
    assertEqual(touched, 0, '一个请求都不该发出去：外部服务不可用时，"看起来还在正常工作"比"明确报错"危险得多');
  });

  await test('AU9 暂停恢复不重置起点：时间区间连续增长（S1）', () => {
    const plan = planChunks(
      [...voiced(0, 2, 0.5), pause(2), ...voiced(5, 7, 0.5), stop(7)],
      { silenceMs: 800, maxSeconds: 30, minSeconds: 1 },
    );

    assertEqual(plan.chunks.map((chunk) => [chunk.startSec, chunk.endSec]), [[0, 2], [5, 7]], '暂停只定稿当前片，不重置时间轴');
    assertEqual(plan.chunks[0]?.reason, 'pause', '暂停应定稿当前分片');
    assert(
      (plan.chunks[1]?.startSec ?? 0) > (plan.chunks[0]?.startSec ?? 0),
      '恢复后的起点必须**连续增长**：一旦重置为 0，"何时说的"全错，而它不可事后补',
    );
    assertEqual(plan.chunks[1]?.startSec, 5, '起点应是恢复后的真实时刻，不是 0');
  });

  await test('AU10 汇总不重排：段号与区间原样带出，重排交给 normalizeSegments（S3）', async () => {
    const asr = okAsr((index) => `第 ${index} 段口述内容`);
    const result = await captureSession(
      {
        sessionId: 'sess-order',
        events: [...voiced(0, 1, 1), pause(1), ...voiced(1, 2, 1), pause(2), ...voiced(2, 3, 1), stop(3)],
        audioFor: () => AUDIO,
        tempStore: memoryTempStore().store,
      },
      configWith({ segment: SEGMENT }),
      { transport: asr.transport, ...fakeClock() },
    );
    assertEqual(result.chunks.map((chunk) => chunk.index), [1, 2, 3], '段号与时间同序');
    assertEqual(result.chunks.map((chunk) => chunk.startSec), [0, 1, 2], '时间区间原样');

    const scrambled: CaptureResult = {
      sessionId: 'sess-scramble',
      asrModelId: ASR_MODEL,
      chunks: [
        { index: 1, startSec: 9.1, endSec: 12.4, text: '伴发热，最高体温三十八度五。' },
        { index: 2, startSec: 0, endSec: 4.2, text: '患者三天前出现咳嗽。' },
      ],
      failures: [],
      emptyDropped: 0,
      shortDropped: 0,
      audioRetained: false,
      warnings: [],
    };
    const input = toDictationInput(scrambled, '2026-10-14T10:00:00Z', { confidenceCeiling: 0.85 });
    assertEqual(input.segments.map((segment) => segment.index), [1, 2], '汇总不重排：段号原样');
    assertEqual(input.segments[0]?.startSec, 9.1, '时间区间原样（不在这里修正）');

    const normalized = normalizeSegments(input.segments);
    assertEqual(normalized.segments.map((segment) => segment.startSec), [0, 9.1], '重排由 normalizeSegments 负责');
    assertEqual(normalized.outOfOrder, 1, '乱序段数如实上报');
  });

  await test('AU11 置信度一律等于上限（<0.90）：关键内容上仍必须"改后采纳"', async () => {
    const asr = okAsr(() => '患者无药物过敏史。');
    const result = await captureSession(
      { sessionId: 'sess-conf', events: [...voiced(0, 2, 1), stop(2)], audioFor: () => AUDIO, tempStore: memoryTempStore().store },
      configWith({ segment: SEGMENT }),
      { transport: asr.transport, ...fakeClock() },
    );

    const input = toDictationInput(result, '2026-10-14T10:00:00Z', { confidenceCeiling: 0.85 });
    assertEqual(input.segments.map((segment) => segment.confidence), [0.85], '该接口不回置信度 → 一律填上限（未知按最保守处理）');
    assert(
      input.segments.every((segment) => segment.confidence < 0.9),
      '上限必须低于关键内容阈值：不得因为"识别看起来成功了"而升高',
    );
    const lower = toDictationInput(result, '2026-10-14T10:00:00Z', { confidenceCeiling: 0.5 });
    assertEqual(lower.segments[0]?.confidence, 0.5, '上限由配置决定，不由 ASR 的"自信程度"决定');

    /* 走到内核：门控一行不松 */
    const { doc, ids } = buildSyntheticDoc({ sections: 2, paragraphsPerSection: 2, fieldsPerParagraph: 0 });
    const session = WriteSession.open(doc);
    const target = ids.textIds[0] as NodeId;
    const run = session.dictate({ ...input, targetNodeIds: [target], maxConfidence: 0.85 }, AI);
    const suggestionId = String(session.listSuggestions({ groupId: run.groupId })[0]?.id);
    assertEqual(
      session.listSuggestions({ groupId: run.groupId })[0]?.confidence,
      0.85,
      '内核里的置信度应等于采集层填的上限',
    );
    session.updateNodeProps({ nodeId: target, patch: { keyContent: true } }, HUMAN);
    assertEqual(
      await codeOfAsync(async () => session.acceptSuggestion({ suggestionId }, HUMAN)),
      'E_AI_LOW_CONFIDENCE',
      '关键内容上不得直接采纳：**不因为 ASR 没给置信度就放宽门控**',
    );
  });

  await test('AU12 retainAudio=false：成功、失败、异常三条路径都删掉临时音频', async () => {
    const events = [...voiced(0, 1, 1), pause(1), ...voiced(1, 2, 1), pause(2), ...voiced(2, 3, 1), stop(3)];

    const okTemp = memoryTempStore();
    const okRun = await captureSession(
      { sessionId: 'sess-retain-ok', events, audioFor: () => AUDIO, tempStore: okTemp.store },
      configWith({ segment: SEGMENT }),
      { transport: okAsr((index) => `第 ${index} 段`).transport, ...fakeClock() },
    );
    assertEqual(okTemp.written.length, 3, '三段各写一份临时音频');
    assertEqual(okTemp.removed.length, 3, '转写完成后应全部删除');
    assertEqual(okRun.audioRetained, false, '未留存应如实回报');

    const failTemp = memoryTempStore();
    await captureSession(
      { sessionId: 'sess-retain-fail', events, audioFor: () => AUDIO, tempStore: failTemp.store },
      configWith({ segment: SEGMENT }),
      {
        transport: fakeAsr((request, index) =>
          request.method === 'POST' && index === 2
            ? { status: 500, body: 'oops' }
            : request.method === 'POST'
              ? { status: 200, body: JSON.stringify({ code: 200, task_id: `task-${index}` }) }
              : { status: 200, body: JSON.stringify({ status: 'done', result: 'x' }) },
        ).transport,
        ...fakeClock(),
      },
    );
    assertEqual(failTemp.removed.length, failTemp.written.length, '失败路径也要删干净（"不留存"只在成功路径成立就不是不留存）');

    const boomTemp = memoryTempStore();
    let thrown: Error | null = null;
    try {
      await captureSession(
        {
          sessionId: 'sess-retain-boom',
          events,
          audioFor: (chunk) => {
            if (chunk.index === 2) throw new Error('音频准备失败');
            return AUDIO;
          },
          tempStore: boomTemp.store,
        },
        configWith({ segment: SEGMENT }),
        { transport: okAsr(() => 'x').transport, ...fakeClock() },
      );
    } catch (err) {
      thrown = err as Error;
    }
    assertEqual(thrown?.message, '音频准备失败', '非预期错误应继续抛（不吞成"这段没转出来"）');
    assertEqual(boomTemp.written.length, 1, '第 1 段已写下临时音频');
    assertEqual(boomTemp.removed.length, boomTemp.written.length, '异常路径也必须清理');

    const keepTemp = memoryTempStore();
    const kept = await captureSession(
      { sessionId: 'sess-retain-on', events, audioFor: () => AUDIO, tempStore: keepTemp.store },
      configWith({ segment: SEGMENT, retainAudio: true }),
      { transport: okAsr(() => 'x').transport, ...fakeClock() },
    );
    assertEqual(keepTemp.removed.length, 0, '开了留存就不该删');
    assertEqual(kept.audioRetained, true, '留存状态应如实回报（争议回放要用）');
  });

  await test('AU13 transcriptionId 是采集会话 ID（与 task_id 无关），ref 形如 sess#3@9.1-12.4s', async () => {
    const asr = okAsr((index) => `第 ${index} 段口述内容`);
    const result = await captureSession(
      {
        sessionId: 'sess-9',
        events: byPause(
          [
            [0, 4.2],
            [4.2, 9.1],
          ],
          9.1,
        ),
        audioFor: () => AUDIO,
        tempStore: memoryTempStore().store,
      },
      configWith({ segment: SEGMENT }),
      { transport: asr.transport, ...fakeClock() },
    );

    assertEqual(result.chunks.map((chunk) => [chunk.startSec, chunk.endSec]), [[0, 4.2], [4.2, 9.1], [9.1, 10.1]], '三段区间应精确');
    const input = toDictationInput(result, '2026-10-14T10:00:00Z', { confidenceCeiling: 0.85 });
    assertEqual(input.transcriptionId, 'sess-9', '转写标识应是**采集会话 ID**（一次会话有 N 个 task_id）');
    assert(input.transcriptionId !== 'task-3', '不得用 task_id（那会把"一次录音"拆成 N 次）');

    const { ids } = buildSyntheticDoc({ sections: 2, paragraphsPerSection: 2, fieldsPerParagraph: 0 });
    const nodeIds = ids.textIds.slice(0, 3).map((id) => id as NodeId);
    const items = toSuggestionItems(input, { nodeIds });
    assertEqual(items[2]?.evidence?.[0]?.ref, 'sess-9#3@9.1-10.1s', 'ref 应可回到"第几段第几秒"');
    assertEqual(items[0]?.evidence?.[0]?.ref, 'sess-9#1@0-4.2s', '第一段的 ref 应带时间区间');
    assertEqual(items[0]?.evidence?.[0]?.kind, 'dictation', '来源类别应为 dictation');
  });

  await test('AU14 端到端组装：有效段与失败段各归各位，dictate 不认识"失败"', async () => {
    const events = [
      ...voiced(0, 1, 1),
      pause(1),
      ...voiced(1, 2, 1),
      pause(2),
      ...voiced(2, 3, 1),
      pause(3),
      ...voiced(3, 4, 1),
      stop(4),
    ];
    const asr = fakeAsr((request, index) => {
      if (request.method === 'POST') {
        return index === 2
          ? { status: 500, body: 'down' }
          : { status: 200, body: JSON.stringify({ code: 200, task_id: `task-${index}` }) };
      }
      return { status: 200, body: JSON.stringify({ status: 'done', result: index === 3 ? '' : `第 ${index} 段口述内容` }) };
    });
    const result = await captureSession(
      { sessionId: 'sess-e2e', events, audioFor: () => AUDIO, tempStore: memoryTempStore().store },
      configWith({ segment: SEGMENT }),
      { transport: asr.transport, ...fakeClock() },
    );

    assertEqual(result.chunks.map((chunk) => chunk.index), [1, 4], '有效段 2 条');
    assertEqual(result.failures.map((item) => item.index), [2], '失败 1 条，如实带出');
    assertEqual(result.emptyDropped, 1, '空结果 1 条，计入丢弃数');
    assertEqual(result.warnings.length >= 2, true, `失败与空结果都应回报，实际：${result.warnings.join(' | ')}`);

    const input = toDictationInput(result, '2026-10-14T10:00:00Z', { confidenceCeiling: 0.85 });
    assertEqual(input.segments.length, 2, '交给 dictate 的只有有效段（失败段不进去）');

    const { doc, ids } = buildSyntheticDoc({ sections: 2, paragraphsPerSection: 2, fieldsPerParagraph: 0 });
    const session = WriteSession.open(doc);
    const targets = [ids.textIds[0] as NodeId, ids.textIds[1] as NodeId];
    const run = session.dictate({ ...input, targetNodeIds: targets, maxConfidence: 0.85 }, AI);
    assertEqual(session.listSuggestions({ groupId: run.groupId }).length, 2, 'group 里只有 2 条建议');
    assertEqual(
      session
        .listSuggestions({ groupId: run.groupId })
        .some((item) => item.promptId?.includes('sess-e2e') === true),
      true,
      '建议的 promptId 应指向这次采集会话',
    );
    /* `dictate` 不认识"失败"：它只看见 2 段有效内容。失败由调用方在外部处置
       （界面提示 + 审计），硬塞一条空文本只会变成"这条建议本来就是空的"。 */
    assertEqual(result.failures.length, 1, '失败仍留在采集结果里，供调用方处置');
  });

  await test('AU15 WAV 头固定 16k / 单声道 / 16-bit，且非 16-bit PCM 一律拒', () => {
    const wav = encodeCaptureWav(new Uint8Array(3200));
    const parsed = parseCaptureWav(wav);
    assertEqual(parsed.sampleRate, 16_000, '采样率必须固定 16 kHz（44.1 kHz 对识别没有增益，只让体积翻 2.75 倍）');
    assertEqual(parsed.channels, 1, '单声道（口述场景用不到立体声）');
    assertEqual(parsed.bitsPerSample, 16, '16-bit');
    assertEqual(parsed.dataBytes, 3200, '数据段长度应如实写入头');
    assertEqual(wav.byteLength, 44 + 3200, '44 字节头 + PCM');
    assertEqual(
      { rate: CAPTURE_AUDIO.sampleRate, channels: CAPTURE_AUDIO.channels, bits: CAPTURE_AUDIO.bitsPerSample },
      { rate: 16_000, channels: 1, bits: 16 },
      '格式是常量，不是参数：不给"改一改又变成别的规格"留口子',
    );

    assertEqual(
      codeOf(() => encodeCaptureWav(new Uint8Array(3))),
      'E_CAPTURE_CONFIG_INVALID',
      '字节数不是 16-bit 的整数倍应报错（与其让服务端识别出乱码，不如在这里就拒掉）',
    );
    assertEqual(
      codeOf(() => parseCaptureWav(new Uint8Array(10))),
      'E_CAPTURE_BAD_RESPONSE',
      '不足 44 字节解不出头',
    );
  });

  await test('AU16 采集配置存储：库是唯一来源；密钥永不回显；读不出来不静默', () => {
    const fixture = openConfigFixture({ prefix: 'l0-capture-' });
    try {
      const fresh = loadCaptureConfig(fixture.kv);
      assertEqual(fresh.source, 'default', '没配过应为默认');
      assertEqual(fresh.configured, false, '默认是未配置：采集入口随之不可用');
      assertEqual(fresh.config.retainAudio, false, '默认不留存音频');

      assertEqual(loadCaptureConfig(fixture.kv).source, 'default', '库空时只能是 default（不会去看环境变量）');

      const saved = saveCaptureConfig(
        fixture.kv,
        { endpoint: 'http://asr2.test:9000', modelId: 'dept/asr:1.2@2026-10', pollTimeoutMs: 45_000, maxSeconds: 20, retainAudio: false, apiKey: 'secret-token-1' },
        'ADMIN',
      );
      assertEqual(saved.apiKeyAction, 'set', '密钥动作应如实回报（界面据此提示"已更新"）');
      assertEqual(saved.loaded.source, 'store', '保存后来源应是 store');
      assertEqual(saved.loaded.config.asr.endpoint, 'http://asr2.test:9000', '配置应生效');
      assertEqual(saved.loaded.config.asr.pollTimeoutMs, 45_000, '单段预算应生效');
      assertEqual(saved.loaded.config.segment.maxSeconds, 20, '分片上限应生效');
      assertEqual(saved.loaded.config.segment.minSeconds, 1, '没改的字段应保持默认');
      const reloaded = loadCaptureConfig(fixture.kv);
      assertEqual(reloaded.source, 'store', '重新读也应来自库');
      assertEqual(reloaded.apiKey, 'secret-token-1', '密钥应能解出来供转发使用（只在内存里）');

      const view = describeCaptureConfig(reloaded);
      assertEqual(view.apiKeyPresent, true, '视图应报"密钥已就位"');
      assertEqual(
        Object.keys(view).some((key) => key.toLowerCase().includes('apikey') && key !== 'apiKeyPresent'),
        false,
        `视图不得带任何密钥字段，实际键：${Object.keys(view).join('/')}`,
      );
      assertEqual(
        JSON.stringify(view).includes('secret-token-1'),
        false,
        '**密钥值不得出现在视图里**：回显一次就收不回来了（截图、日志、前端内存）',
      );
      assertEqual(sealedBlobOf(fixture, CAPTURE_API_KEY_KEY)?.includes('secret-token-1'), false, '库里那一行不得是明文');

      /* ⑤ 清除 = 真删那一行（留着密文等于"我清掉了"是假话） */
      const cleared = saveCaptureConfig(fixture.kv, { endpoint: 'http://asr2.test:9000', modelId: 'dept/asr:1.2@2026-10', apiKey: null }, 'ADMIN');
      assertEqual(cleared.apiKeyAction, 'cleared', '清除应如实回报');
      assertEqual(cleared.loaded.apiKeyPresent, false, '清除后密钥不再就位');
      assertEqual(sealedBlobOf(fixture, CAPTURE_API_KEY_KEY), null, '清除后那一行必须真的不在库里');

      /* ⑥ 非法值一律拒（不静默取默认），且非法配置不落库  */
      assertEqual(
        codeOf(() => saveCaptureConfig(fixture.kv, { endpoint: 'http://asr2.test:9000', modelId: 'dept/asr:1.2@2026-10', minSeconds: 30, maxSeconds: 30 }, 'ADMIN')),
        'E_CAPTURE_CONFIG_INVALID',
        'minSeconds >= maxSeconds 应被拒',
      );
      assertEqual(
        codeOf(() => saveCaptureConfig(fixture.kv, { confidenceCeiling: 0.9 }, 'ADMIN')),
        'E_CAPTURE_CEILING_TOO_HIGH',
        '置信度上限不得达到关键内容阈值',
      );
      assertEqual(loadCaptureConfig(fixture.kv).config.asr.endpoint, 'http://asr2.test:9000', '被拒的保存不得改动已有配置');

      /* ⑦ 清空地址 = 回到未配置（这是 fail-closed 状态，不是"退回模拟转写"） */
      const unconfigured = saveCaptureConfig(fixture.kv, { endpoint: '', modelId: '' }, 'ADMIN');
      assertEqual(unconfigured.loaded.configured, false, '清空后应回到"未配置"');
      assertEqual(describeCaptureConfig(unconfigured.loaded).missing, ['服务地址', '模型标识'], '视图应说清缺哪几格');

      /* ⑧ 库里那一行读不出来 → 不许当作"没配过"（现场是"我配的采集没了"）  */
      writeCorruptRow(fixture, CAPTURE_CONFIG_KEY);
      assertEqual(codeOf(() => loadCaptureConfig(fixture.kv)), 'E_CAPTURE_CONFIG_INVALID', '读不出来的配置不得当作"没配过"');
    } finally {
      fixture.cleanup();
    }
  });

  await test('AU17 入站 multipart：只认"一个 audio 文件分段"，其余一律拒', () => {
    const body = (parts: Array<{ name: string; filename?: string; bytes: Uint8Array }>, boundary: string): Uint8Array => {
      const chunks: Uint8Array[] = [];
      const text = (value: string): Uint8Array => new TextEncoder().encode(value);
      for (const part of parts) {
        const disposition = `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"${part.filename ? `; filename="${part.filename}"` : ''}\r\nContent-Type: application/octet-stream\r\n\r\n`;
        chunks.push(text(disposition), part.bytes, text('\r\n'));
      }
      chunks.push(text(`--${boundary}--\r\n`));
      const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
      const out = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return out;
    };

    const boundary = '----l0capture7f3a';
    const audio = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x0d, 0x0a, 0x1a, 0xff, 0x80]);
    const parsed = parseMultipartAudio(`multipart/form-data; boundary=${boundary}`, body([{ name: 'audio', filename: 'sess#1.wav', bytes: audio }], boundary));
    assertEqual(Array.from(parsed.bytes), Array.from(audio), '取出的字节必须与送进来的**逐字节一致**（音频是二进制，不能按字符处理）');
    assertEqual(parsed.filename, 'sess#1.wav', '文件名应如实带出（留痕/排障用）');

    const quoted = parseMultipartAudio(
      `multipart/form-data; boundary="${boundary}"`,
      body([{ name: 'audio', filename: 'a.wav', bytes: audio }], boundary),
    );
    assertEqual(quoted.bytes.byteLength, audio.byteLength, '带引号的 boundary 同样应能解析');

    const cases: Array<[string, () => unknown]> = [
      [
        '不是 multipart',
        () => parseMultipartAudio('application/octet-stream', body([{ name: 'audio', filename: 'a.wav', bytes: audio }], boundary)),
      ],
      [
        '缺 boundary',
        () => parseMultipartAudio('multipart/form-data', body([{ name: 'audio', filename: 'a.wav', bytes: audio }], boundary)),
      ],
      [
        '字段名不符',
        () => parseMultipartAudio(`multipart/form-data; boundary=${boundary}`, body([{ name: 'file', filename: 'a.wav', bytes: audio }], boundary)),
      ],
      [
        '没有 filename（不是文件）',
        () => parseMultipartAudio(`multipart/form-data; boundary=${boundary}`, body([{ name: 'audio', bytes: audio }], boundary)),
      ],
      [
        '夹带多余分段',
        () =>
          parseMultipartAudio(
            `multipart/form-data; boundary=${boundary}`,
            body(
              [
                { name: 'audio', filename: 'a.wav', bytes: audio },
                { name: 'nodeId', bytes: new TextEncoder().encode('t_1') },
              ],
              boundary,
            ),
          ),
      ],
      ['空请求体', () => parseMultipartAudio(`multipart/form-data; boundary=${boundary}`, new Uint8Array(0))],
      [
        '请求体被截断（没有结束标记）',
        () => {
          const full = body([{ name: 'audio', filename: 'a.wav', bytes: audio }], boundary);
          return parseMultipartAudio(`multipart/form-data; boundary=${boundary}`, full.subarray(0, full.byteLength - 12));
        },
      ],
      [
        '零字节音频',
        () => parseMultipartAudio(`multipart/form-data; boundary=${boundary}`, body([{ name: 'audio', filename: 'a.wav', bytes: new Uint8Array(0) }], boundary)),
      ],
    ];
    for (const [name, run] of cases) {
      assertEqual(codeOf(run), 'E_CAPTURE_UPLOAD_INVALID', `${name} 应报 E_CAPTURE_UPLOAD_INVALID（拒绝猜测"哪一段是音频"）`);
    }
  });

  await test('AU18 提交的转写段：只校验不代编；带 confidence 一律拒；乱序允许（S3）', () => {
    /* 这正是"采集结果 → 建议"那一跳的入口：文本与时间区间由采集端给，
       服务端只校验、不补（补一个段号或一段区间就是伪造证据）。
       同时它是唯一一处能把"置信度"塞进建议的地方 —— 所以这里必须挡死。  */
    const accepted = validateSubmittedSegments(
      [
        { index: 2, text: '第二段口述内容', startSec: 9.1, endSec: 12.4 },
        { index: 1, text: '第一段口述内容', startSec: 0, endSec: 4.2 },
        { index: 3, text: '   ', startSec: 4.2, endSec: 9.1 },
      ],
      { confidenceCeiling: 0.85 },
    );
    assertEqual(accepted.map((segment) => segment.index), [2, 1, 3], '不在这里重排：乱序交给 normalizeSegments（S3）');
    assertEqual(accepted.map((segment) => segment.confidence), [0.85, 0.85, 0.85], '置信度一律按上限填，**不由请求指定**');
    assertEqual(accepted[0]?.startSec, 9.1, '时间区间原样带出（服务端不代编、不"顺手修正"）');
    const normalized = normalizeSegments(accepted);
    assertEqual(normalized.outOfOrder, 1, '乱序段数如实回报');
    assertEqual(normalized.dropped, 1, '空文本段由内核丢弃并计数');
    assertEqual(
      normalized.segments.map((segment) => segment.index),
      [1, 2],
      '重排由 normalizeSegments 负责（两处都排，会让"乱序段数"这个数失去意义）',
    );

    const cases: Array<[string, unknown]> = [
      ['不是数组', { index: 1 }],
      ['空数组', []],
      ['带 confidence', [{ index: 1, text: 'x', startSec: 0, endSec: 1, confidence: 0.99 }]],
      [
        '段号重复',
        [
          { index: 1, text: 'x', startSec: 0, endSec: 1 },
          { index: 1, text: 'y', startSec: 1, endSec: 2 },
        ],
      ],
      ['区间倒置', [{ index: 1, text: 'x', startSec: 4.2, endSec: 0 }]],
      ['零长度区间', [{ index: 1, text: 'x', startSec: 3, endSec: 3 }]],
      ['缺时间区间', [{ index: 1, text: 'x' }]],
      ['段号非整数', [{ index: 1.5, text: 'x', startSec: 0, endSec: 1 }]],
      ['段号为 0（段号从 1 起）', [{ index: 0, text: 'x', startSec: 0, endSec: 1 }]],
      ['区间不是有限数', [{ index: 1, text: 'x', startSec: 0, endSec: Number.POSITIVE_INFINITY }]],
      ['text 不是字符串', [{ index: 1, text: 5, startSec: 0, endSec: 1 }]],
      ['条目不是对象', ['第一段']],
    ];
    for (const [name, raw] of cases) {
      assertEqual(
        codeOf(() => validateSubmittedSegments(raw, { confidenceCeiling: 0.85 })),
        'E_CAPTURE_BAD_SEGMENTS',
        `${name} 应报 E_CAPTURE_BAD_SEGMENTS`,
      );
    }
  });

  await test('AU19 采集源探测：先判安全上下文，且每条拒绝都给出"怎么办"（第六节）', () => {
    /* 判定顺序是有讲究的：`http://10.x` 下浏览器根本不弹权限框，
       若把安全上下文排在后面，现场会显示成"未获得麦克风权限" —— 医生去设置里点半天也没用。  */
    const base = { isSecureContext: true, hasGetUserMedia: true, hasAudioContext: true };
    assertEqual(probeMicEnvironment(base).ok, true, '安全上下文 + 能力齐备时应可用');
    assertEqual(probeMicEnvironment(base).sourceId, 'browser-mic', '探测结果要带上是哪个源（多宿主并存时只报"不可用"答不出该换谁）');

    const rejects: Array<[string, Parameters<typeof probeMicEnvironment>[0], string]> = [
      ['非安全上下文', { ...base, isSecureContext: false }, 'E_CAPTURE_INSECURE_CONTEXT'],
      ['没有 getUserMedia', { ...base, hasGetUserMedia: false }, 'E_CAPTURE_UNSUPPORTED'],
      ['没有 Web Audio', { ...base, hasAudioContext: false }, 'E_CAPTURE_UNSUPPORTED'],
    ];
    for (const [name, env, expected] of rejects) {
      const probe = probeMicEnvironment(env);
      assertEqual(probe.ok, false, `${name} 应判不可用`);
      if (probe.ok) continue;
      assertEqual(probe.code, expected, `${name} 应报 ${expected}`);
      assert(probe.howTo.trim() !== '', `${name} 必须给出"怎么办"（只丢错误码等于让人去搜）`);
      assert(probe.message.trim() !== '', `${name} 必须给出给人看的现场表现`);
    }
    /* 安全上下文这一条排在最前：它的提示必须指向"换 https / 换桌面客户端"，
       而不是"去开权限"（那条路在 http://10.x 下根本走不通） */
    const insecure = probeMicEnvironment({ ...base, isSecureContext: false });
    assert(!insecure.ok && insecure.howTo.includes('https'), `非安全上下文的提示应指向换访问方式，实际：${!insecure.ok ? insecure.howTo : ''}`);
  });

  await test('AU20 采集失败语义：权限 / 无设备 / 被占用三类分得开，且各指向可执行的一步', () => {
    const withName = (name: string): Error => Object.assign(new Error(`模拟的 ${name}`), { name });
    const cases: Array<[string, unknown, string]> = [
      ['用户拒绝权限', withName('NotAllowedError'), 'E_CAPTURE_PERMISSION_DENIED'],
      ['没有可用设备', withName('NotFoundError'), 'E_CAPTURE_NO_DEVICE'],
      ['设备被别的程序占用', withName('NotReadableError'), 'E_CAPTURE_DEVICE_BUSY'],
      ['说不清原因', new Error('boom'), 'E_CAPTURE_SOURCE_UNKNOWN'],
    ];
    const howTos: string[] = [];
    for (const [name, err, expected] of cases) {
      const problem = describeSourceFailure(err);
      assertEqual(problem.code, expected, `${name} 应报 ${expected}（三类处置完全不同，不能混成一句"录音失败"）`);
      assert(problem.howTo.trim() !== '', `${name} 必须给出"怎么办"`);
      howTos.push(problem.howTo);
    }
    assertEqual(new Set(howTos).size, howTos.length, '三类失败给出的"怎么办"必须互不相同（否则提示指向不了正确的那一步）');
    assertEqual(
      describeSourceFailure(new Error('boom')).message.includes('boom'),
      true,
      '未知故障要**带上原始信息**（不吞），否则现场只能看到一句"采集失败"',
    );
  });

  await test('AU21 演示采集源：按脚本时间线出帧、停止即兑现、不重复打开设备', async () => {
    /* 演示源存在的理由与"靶子 ASR"完全一样：让整条链今天就能真的跑一遍。
       它不做音量分析（那是真实 VAD 的事），`voiced` 由脚本给出 —— 因此分片行为可复现。  */
    const frames: CaptureFrame[] = [];
    const source = createSampleCaptureSource({
      timeline: [
        { seconds: 2, voiced: true },
        { seconds: 1, voiced: false },
      ],
      frameSec: 0.5,
      sleep: async () => {},
    });
    const probe = source.probe();
    assertEqual(probe.ok, true, '演示源不依赖任何宿主能力，应始终可用');
    assertEqual(source.id, 'sample', '采集源标识要如实（界面与留痕都要能回答"音频从哪来"）');
    await source.start((frame) => frames.push(frame));

    assertEqual(frames.length, 6, '2s 人声 + 1s 静音、每帧 0.5s → 6 帧');
    assertEqual(
      frames.map((frame) => [frame.startSec, frame.endSec]),
      [
        [0, 0.5],
        [0.5, 1],
        [1, 1.5],
        [1.5, 2],
        [2, 2.5],
        [2.5, 3],
      ],
      '时间轴必须连续（S1/S2 的前提：缝隙里说的话不属于任何段）',
    );
    assertEqual(
      frames.map((frame) => frame.voiced),
      [true, true, true, true, false, false],
      'voiced 由脚本给出（演示源不假装自己做了音量分析）',
    );
    assertEqual(frames[0]?.pcm.byteLength, 16_000, '0.5s × 16000 样本/秒 × 2 字节 = 16000 字节（16 kHz / 单声道 / 16-bit）');
    assert(
      (frames[0]?.pcm ?? new Uint8Array()).some((byte) => byte !== 0),
      '人声帧的 PCM 应有非零样本（内容是假的，但格式与"这段有人声"必须是真的）',
    );
    assertEqual(
      (frames[4]?.pcm ?? new Uint8Array()).every((byte) => byte === 0),
      true,
      '静音帧应全零',
    );

    /* 按下停止要尽快兑现：把医生挂在"还在录"上是这条链上最糟的一种现场  */
    let ticks = 0;
    const long = createSampleCaptureSource({
      timeline: [{ seconds: 600, voiced: true }],
      frameSec: 0.5,
      sleep: async () => {
        ticks += 1;
        if (ticks === 3) await long.stop();
      },
    });
    await long.start(() => {});
    assertEqual(ticks, 3, '停止后不应继续出帧（600s 的脚本在第 3 帧就停了）');

    /* 重复开始：不重复打开设备 */
    const busy = createSampleCaptureSource({
      timeline: [{ seconds: 10, voiced: true }],
      frameSec: 0.5,
      sleep: () => new Promise<void>(() => {}),
    });
    const hanging = busy.start(() => {});
    assertEqual(
      await codeOfAsync(async () => busy.start(() => {})),
      'E_CAPTURE_SOURCE_UNKNOWN',
      '正在采集时再次开始应被拒（重复打开设备是真实存在的坑）',
    );
    void hanging;
  });

  await test('AU22 流式分片器与批处理入口必须是同一份实现（否则演示与真机会长出两套行为）', () => {
    const config = { silenceMs: 800, maxSeconds: 30, minSeconds: 1 };
    const events: CaptureInput[] = [...voiced(0, 45, 1), stop(45)];
    const batch = planChunks(events, config);
    const planner = createChunkPlanner(config);
    const streamed: ChunkPlan[] = [];
    for (const event of events) streamed.push(...planner.feed(event));

    assertEqual(streamed, batch.chunks, '流式与批处理的产出必须逐字段相同');
    assertEqual(planner.droppedShort, batch.droppedShort, '丢弃计数也要一致（S4 靠它如实上报）');

    /* 界面"正在录的这一段"靠这两个读数 */
    const live = createChunkPlanner(config);
    assertEqual(live.open, false, '还没说话时不应有正在录的段');
    live.feed(vframe(0, 1));
    assertEqual(live.open, true, '有人声后应进入"正在录"');
    assertEqual(live.openStartSec, 0, '段起点应从第一帧算起（界面据此显示"这一段已录 X 秒"）');
    live.feed(vframe(1, 2));
    assertEqual(live.openStartSec, 0, '同一段内起点不变');
    live.feed(stop(2));
    assertEqual(live.open, false, '停止后不应再有正在录的段');
    assertEqual(live.openStartSec, null, '没有段时起点必须是 null（界面据此不画计时）');
  });

  await test('AU23 客户端编排：帧 → 流式分片 → 逐段转写 → 提交；拼错音频/吞掉失败都会被抓', async () => {
    const frames = buildScriptedFrames();
    const uploaded: Array<{ index: number; audio: Uint8Array }> = [];
    const submitted: Array<{ transcriptionId: string; asrModelId: string; segments: SubmittedSegment[] }> = [];
    const phases: string[] = [];

    const outcome = await runDictationCapture(
      {
        sessionId: 'sess-c3',
        source: fixedSource(frames),
        segment: { silenceMs: 800, maxSeconds: 30, minSeconds: 1 },
        onProgress: (progress) => phases.push(progress.phase),
      },
      {
        transcriber: async ({ index, audio }) => {
          uploaded.push({ index, audio });
          if (index === 2) throw new CaptureError('E_CAPTURE_ASR_TIMEOUT', '这一段超时了');
          if (index === 3) return { text: '   ', modelId: ASR_MODEL, confidenceNote: ASR_NO_CONFIDENCE_NOTE };
          return { text: `第 ${index} 段口述内容`, modelId: ASR_MODEL, confidenceNote: ASR_NO_CONFIDENCE_NOTE };
        },
        submitter: async (params) => {
          submitted.push(params);
          return { ok: true, data: { groupId: 'g-c3', submitted: true, unplaced: 0, warnings: [] } };
        },
      },
    );

    assertEqual(uploaded.map((item) => item.index), [1, 2, 3, 4], '四段都应被提交转写（失败的那段也要试过）');
    assertEqual(
      uploaded.map((item) => framesOfAudio(item.audio)),
      [
        [0, 1, 2, 3],
        [4, 5, 6, 7],
        [8, 9, 10, 11],
        [12, 13],
      ],
      '每段的音频必须**只有该段区间内的那些帧**（多一帧就是把上一段的话又送了一次）',
    );
    assertEqual(outcome.chunks.map((chunk) => chunk.index), [1, 4], '有效段 2 条');
    assertEqual(outcome.failures.map((item) => item.code), ['E_CAPTURE_ASR_TIMEOUT'], '失败段如实回报');
    assertEqual(outcome.emptyDropped, 1, '空结果如实计数');
    assertEqual(outcome.asrModelId, ASR_MODEL, '模型标识取自转写响应（**不在客户端写死**）');
    assertEqual(outcome.confidenceNote, ASR_NO_CONFIDENCE_NOTE, '要不要标注"未提供置信度"由服务端说了算');
    assertEqual(
      outcome.warnings.some((text) => text.includes('转写失败')) && outcome.warnings.some((text) => text.includes('为空')),
      true,
      `失败与空结果都要回报，实际：${outcome.warnings.join(' | ')}`,
    );

    assertEqual(submitted.length, 1, '一次采集只提交一次');
    const payload = submitted[0] as { transcriptionId: string; asrModelId: string; segments: SubmittedSegment[] };
    assertEqual(payload.transcriptionId, 'sess-c3', '转写标识是**采集会话 ID**（一次会话有 N 个 task_id）');
    assertEqual(payload.asrModelId, ASR_MODEL, '出处要跟着提交走（留痕要答得出"哪个模型听写的"）');
    assertEqual(payload.segments.map((segment) => [segment.index, segment.startSec, segment.endSec]), [[1, 0, 2], [4, 6, 7]], '段号与时间区间原样交给服务端');
    assertEqual(
      Object.keys(payload.segments[0] as object).sort(),
      ['endSec', 'index', 'startSec', 'text'],
      '**客户端不得塞 confidence**：它是由服务端按配置上限填的（否则门控就交给调用方了）',
    );
    assertEqual(outcome.submit?.groupId, 'g-c3', '提交结果要带回来（界面据此显示"已生成一组建议"）');
    assertEqual(phases.includes('recording') && phases.includes('transcribing') && phases.includes('done'), true, '相位要能让界面把"在录 / 在转 / 完成"画出来');

    /* 源不可用：一个字节都不发出去（与"端点未配置"同一条纪律）  */
    const denied: typeof uploaded = [];
    assertEqual(
      await codeOfAsync(async () =>
        runDictationCapture(
          {
            sessionId: 'sess-c3-denied',
            source: fixedSource(frames, {
              ok: false,
              sourceId: 'browser-mic',
              code: 'E_CAPTURE_INSECURE_CONTEXT',
              message: '当前访问方式不允许录音（需 HTTPS 或 localhost）',
              howTo: '换用 https:// 打开，或改用桌面客户端',
            }),
            segment: { silenceMs: 800, maxSeconds: 30, minSeconds: 1 },
          },
          { transcriber: async ({ index, audio }) => {
            denied.push({ index, audio });
            return { text: 'x', modelId: ASR_MODEL };
          } },
        ),
      ),
      'E_CAPTURE_INSECURE_CONTEXT',
      '源不可用时应抛出带错误码的失败（界面据此显示"怎么办"）',
    );
    assertEqual(denied.length, 0, '不可用时**一个字节都不该发出去**');

    /* 全部是空结果 / 失败：不提交（提交空段会被服务端拒，那看起来像链路坏了） */
    const emptyRun = await runDictationCapture(
      { sessionId: 'sess-c3-empty', source: fixedSource(frames), segment: { silenceMs: 800, maxSeconds: 30, minSeconds: 1 } },
      {
        transcriber: async () => ({ text: '  ', modelId: ASR_MODEL }),
        submitter: async () => {
          throw new Error('不该被调用：没有有效文本时不应提交');
        },
      },
    );
    assertEqual(emptyRun.submit?.skipped, true, '没有有效文本时提交应被跳过并说明原因');
    assertEqual(emptyRun.submit?.ok, false, '跳过不是成功');
  });

  await test('AU24 桥：取走不等于处理完（未 ack 前重复取同一段），乱序 ack 被拒且不顺手删', () => {
    /* 这一条守的是"我说的话被吞了"这个最难查的现场：只有 ack 才推进队列。
       页面一次网络抖动若就把段算作"已取走"，那一段就静默消失了。  */
    const bridge = createCaptureBridge({ sessionId: 'sess-bridge', segment: { silenceMs: 800, maxSeconds: 30, minSeconds: 1 } });
    const frames = buildScriptedFrames();
    for (const frame of frames) bridge.feed(frame);
    bridge.finish((frames[frames.length - 1] as CaptureFrame).endSec);
    assertEqual(bridge.state, 'done', '源结束后桥应进入 done');

    const first = bridge.next();
    assert(first.kind === 'segment', `应能取到第 1 段，实际 ${JSON.stringify(first)}`);
    assertEqual(first.segment, { index: 1, startSec: 0, endSec: 2 }, '段号与时间区间来自客户端（页面不得代编）');
    assertEqual(first.audioBytes > 44, true, '应带上 WAV 字节长度（界面据此显示"这一段的音频多大"）');

    /* 幂等：没 ack 之前，再问一次还是同一段（页面重试是安全的） */
    const again = bridge.next();
    assert(again.kind === 'segment', '未 ack 时应仍取到第 1 段');
    assertEqual(again.segment.index, 1, '未 ack 时不得跳到下一段');
    assertEqual(bridge.audioOf(1)?.byteLength, first.audioBytes, '未 ack 时音频仍可取');
    assertEqual(bridge.audioOf(2), null, '还没轮到的段取不到音频（避免页面拿错段）');

    /* 乱序 ack：拒绝，而不是从队列里顺手删一个 —— 顺手删的现场表现是"某一句不见了"  */
    const outOfOrder = bridge.ack(2, true);
    assertEqual(outOfOrder.ok, false, '乱序 ack 应被拒');
    assertEqual(outOfOrder.ok === false ? outOfOrder.code : '', 'E_BRIDGE_ACK_OUT_OF_ORDER', '要给专门的错误码（页面据此判断是不是自己那一侧错位了）');
    const afterReject = bridge.next();
    assert(afterReject.kind === 'segment' && afterReject.segment.index === 1, '被拒之后队列不该变（仍应是第 1 段）');

    const done1 = bridge.ack(1, true);
    assertEqual(done1.ok, true, '按序 ack 应成功');
    assertEqual(bridge.audioOf(1), null, 'ack 之后音频应释放（一次门诊录音累积起来是几十 MB）');
    const second = bridge.next();
    assert(second.kind === 'segment' && second.segment.index === 2, 'ack 之后应轮到第 2 段');

    /* 失败也照样推进，但必须记账（S4：失败不阻塞其余段，但不许静默丢）  */
    assertEqual(bridge.ack(2, false, { code: 'E_CAPTURE_ASR_TIMEOUT', message: '这一段超时了' }).ok, true, '失败的 ack 也应推进队列');
    assertEqual(bridge.progress().failed, 1, '失败段数应如实记账');
    assertEqual(bridge.progress().delivered, 2, '确认过的段数应如实计数');

    for (const index of [3, 4]) {
      const item = bridge.next();
      assert(item.kind === 'segment' && item.segment.index === index, `应轮到第 ${index} 段`);
      assertEqual(bridge.ack(index, true).ok, true, `第 ${index} 段应能确认`);
    }
    const ended = bridge.next();
    assert(ended.kind === 'done', `取空后应回 done，实际 ${JSON.stringify(ended)}`);
    assertEqual(ended.total, 4, '总段数应如实回报');
    assertEqual(ended.delivered, 4, '已交付段数应如实回报');
    assertEqual(ended.failures.map((item) => item.index), [2], '失败段（含段号与原因）应随 done 一起带去页面');

    /* 结束之后不许再喂帧：队列不该在 done 之后继续长出来 */
    let thrown = '';
    try {
      bridge.feed({ startSec: 7, endSec: 8, voiced: true, pcm: new Uint8Array(8) });
    } catch (err) {
      thrown = (err as Error).message;
    }
    assert(thrown.includes('不再接受新帧'), `done 之后喂帧应被拒，实际：${thrown}`);
  });

  await test('AU25 桥的令牌：空令牌直接拒绝服务；错令牌与对令牌分得开（页面据此分辨"客户端不在"与"令牌不对"）', () => {
    assertEqual(tokenFromRequest({ header: ' abc ' }), 'abc', '优先取自定义头');
    assertEqual(tokenFromRequest({ query: 'q1' }), 'q1', '没有头时取查询参数（页面从 URL 里带的那个）');
    assertEqual(tokenFromRequest({}), '', '都没有就是空');

    const noToken = checkBridgeToken('', 'anything');
    assertEqual(noToken.ok, false, '客户端没配令牌时必须拒绝服务');
    assertEqual(noToken.ok === false ? noToken.code : '', 'E_BRIDGE_NO_TOKEN', '空令牌要单独一个错误码');
    const wrong = checkBridgeToken('right', 'wrong');
    assertEqual(wrong.ok, false, '错令牌应被拒');
    assertEqual(wrong.ok === false ? wrong.code : '', 'E_BRIDGE_BAD_TOKEN', '错令牌的错误码要能与"客户端不在"区分开');
    assertEqual(checkBridgeToken('right', 'right').ok, true, '对令牌应通过');
  });

  /* ==================== 厂商适配（公有云只作测试用，默认仍是院内） ==================== */

  await test('AU26 厂商默认值是院内服务；不认识的 kind 一律拒；旧库（v1）读出来仍是院内服务', () => {
    /* 这一格的默认值决定"忘了配"会怎样 —— 默认成公有云就等于"忘了配就把音频发去公网"。
       所以它必须默认在院内，且"不认识的名字"要报错而不是悄悄回落（回落的方向是数据流向）。  */
    assertEqual(validateCaptureConfig({}).asr.kind, 'intranet-task', 'kind 默认必须是院内服务');
    assertEqual(vendorOf('intranet-task').leavesIntranet, false, '院内服务不出院');
    assertEqual(ASR_VENDORS['baidu-rest'].leavesIntranet, true, '百度会出院');
    assertEqual(ASR_VENDORS['aliyun-nls'].leavesIntranet, true, '阿里云会出院');
    assertEqual(
      codeOf(() => validateCaptureConfig({ asr: { kind: 'openai-whisper' as never } })),
      'E_CAPTURE_CONFIG_INVALID',
      '不认识的厂商名必须报错（静默回落 = 音频悄悄换个地方发）',
    );
    /* 阿里云要 AppKey 这一格；它不是密钥，所以界面上它跟着地址走、不跟着密钥走  */
    assertEqual(vendorOf('aliyun-nls').credentials, 'nls-token-and-appkey', '阿里云的凭据形态是 token + appkey');
    assertEqual(vendorOf('baidu-rest').credentials, 'access-key-pair', '百度是 AK/SK 一对');

    /* 旧库兼容：v1 那一行没有 kind / appKey / 确认位 —— 读出来必须是院内服务，
       否则升级的表现就是"我配的采集没了"（而备份里明明有）。  */
    const fixture = openConfigFixture({ prefix: 'l0-capture-v1-' });
    try {
      fixture.kv.write(CAPTURE_CONFIG_KEY, {
        version: 1,
        endpoint: ASR_ENDPOINT,
        modelId: ASR_MODEL,
        submitTimeoutMs: 15_000,
        pollIntervalMs: 1_000,
        pollTimeoutMs: 90_000,
        segment: SEGMENT,
        retainAudio: false,
        confidenceCeiling: 0.85,
        apiKeyStored: false,
        updatedAt: '2026-01-01T00:00:00.000Z',
        updatedBy: 'ADMIN',
      });
      const legacy = loadCaptureConfig(fixture.kv);
      assertEqual(legacy.config.asr.kind, 'intranet-task', 'v1 的行就是院内服务那一套');
      assertEqual(legacy.config.asr.acknowledgePublicCloud, false, 'v1 没有确认位，补成"未确认"（保守）');
      assertEqual(legacy.configured, true, '升级不该把已配好的地址判成未配置');
    } finally {
      fixture.cleanup();
    }
  });

  await test('AU27 公有云必须显式确认：没确认就拒绝（保存被拒 + 转写时一个字节都不发）', async () => {
    /* 采集里唯一"数据流向"级别的开关。默认值必须是"不许"，确认必须是显式的一次动作 ——
       否则某天会有人在生产里留着一条云地址，而音频带着患者姓名发到公网。  */
    assertEqual(
      codeOf(() =>
        validateCaptureConfig({ asr: { kind: 'baidu-rest', endpoint: vendorOf('baidu-rest').defaultEndpoint, modelId: ASR_MODEL } }),
      ),
      'E_CAPTURE_CLOUD_NOT_ACKNOWLEDGED',
      '选了公有云却没确认：**保存时就该被拒**（不是存下来给个警告）',
    );
    assertEqual(
      codeOf(() => validateCaptureConfig({ asr: { kind: 'intranet-task', endpoint: ASR_ENDPOINT, modelId: ASR_MODEL } })),
      'OK',
      '院内服务不需要这一格确认（它不出院）',
    );
    const acked = validateCaptureConfig({
      asr: { kind: 'baidu-rest', endpoint: vendorOf('baidu-rest').defaultEndpoint, modelId: ASR_MODEL, acknowledgePublicCloud: true },
    });
    assertEqual(acked.asr.acknowledgePublicCloud, true, '确认后应原样生效');

    /* 就算配置是绕过保存硬塞进来的（库里被手改过），转写这一层也不放过 */
    const cloud = fakeCloud(() => baiduOk('不该被调用'));
    const notAcked: CaptureConfig = { ...acked, asr: { ...acked.asr, acknowledgePublicCloud: false } };
    const { client } = asrClient(notAcked, cloud.transport, { apiKey: 'AK', apiSecret: 'SK' });
    assertEqual(
      await codeOfAsync(() => client.transcribe({ index: 1, audio: WAV_BYTES, sessionId: 'sess-ack' })),
      'E_CAPTURE_CLOUD_NOT_ACKNOWLEDGED',
      '未确认时转写必须拒绝',
    );
    assertEqual(cloud.calls.length, 0, '拒绝要发生在**发出请求之前**：一个字节都不该出去');
  });

  await test('AU28 凭据没配全就不发请求：缺口说得出来，且不把"缺凭据"混成"识别失败"', async () => {
    const cloud = fakeCloud(() => baiduOk('不该被调用'));
    const baidu = validateCaptureConfig({
      asr: { kind: 'baidu-rest', endpoint: vendorOf('baidu-rest').defaultEndpoint, modelId: ASR_MODEL, acknowledgePublicCloud: true },
    });
    /* 缺 SK：不该发一个注定 401 的包，也不该等到服务端回来才报错 */
    const missingSk = asrClient(baidu, cloud.transport, { apiKey: 'AK' });
    assertEqual(
      await codeOfAsync(() => missingSk.client.transcribe({ index: 1, audio: WAV_BYTES, sessionId: 's' })),
      'E_CAPTURE_CREDENTIAL_MISSING',
      '缺 Secret Key 应判"凭据缺失"',
    );
    assertEqual(cloud.calls.length, 0, '凭据不齐时一个请求都不发');

    /* 阿里云缺 AppKey：AppKey 不是密钥，但它缺了照样发不出去，所以也算缺口 */
    const aliyun = validateCaptureConfig({
      asr: { kind: 'aliyun-nls', endpoint: vendorOf('aliyun-nls').defaultEndpoint, modelId: ASR_MODEL, acknowledgePublicCloud: true },
    });
    const missingApp = asrClient(aliyun, cloud.transport, { apiKey: 'NLS-TOKEN' });
    assertEqual(
      await codeOfAsync(() => missingApp.client.transcribe({ index: 1, audio: WAV_BYTES, sessionId: 's' })),
      'E_CAPTURE_CREDENTIAL_MISSING',
      '阿里云缺 AppKey 应判凭据缺失',
    );

    /* 院内服务那一格是可选 token：没 token 也照常工作 —— 否则就是把可选项做成了必填  */
    const local = okAsr(() => '好');
    const localClient = createAsrClient(configWith().asr, { transport: local.transport, ...fakeClock() });
    assertEqual((await localClient.transcribe({ index: 1, audio: WAV_BYTES, sessionId: 's' })).text, '好', '院内服务不带 token 也该能转');
  });

  await test('AU29 百度：OAuth 换 token → 一句话 JSON；token 会缓存（不能每段都去换一次）', async () => {
    clearAsrTokenCache();
    const cloud = fakeCloud((request) => (isOauth(request) ? { status: 200, body: OAUTH_BODY } : baiduOk('术后第一天')));
    const config = validateCaptureConfig({
      asr: { kind: 'baidu-rest', endpoint: vendorOf('baidu-rest').defaultEndpoint, modelId: ASR_MODEL, acknowledgePublicCloud: true },
    });
    const { client } = asrClient(config, cloud.transport, { apiKey: 'AK-1', apiSecret: 'SK-1' });
    const first = await client.transcribe({ index: 1, audio: WAV_BYTES, sessionId: 'sess-bd' });
    assertEqual(first.text, '术后第一天', '取 result 拼接成文本');
    assertEqual(first.taskId, '', '百度没有 task_id：不得伪装成院里那个（transcriptionId 用的是会话 ID）');

    const oauth = cloud.calls.filter(isOauth);
    assertEqual(oauth.length, 1, '第一次转写应换一次 token');
    assertEqual(oauth[0]?.method, 'GET', '换 token 是 GET');
    assert(oauth[0]?.url.includes('grant_type=client_credentials') === true, '走标准 client_credentials');
    assert(oauth[0]?.url.includes('client_id=AK-1') === true, 'AK 进 query');
    assert(oauth[0]?.url.includes('client_secret=SK-1') === true, 'SK 进 query');

    const post = cloud.calls.find((item) => !isOauth(item));
    assertEqual(post?.url, vendorOf('baidu-rest').defaultEndpoint, '转写地址就是配置里那个');
    assertEqual(post?.raw?.contentType, 'application/json', '百度要 JSON 体（不是 multipart）');
    const sent = JSON.parse(String(post?.raw?.body)) as Record<string, unknown>;
    assertEqual(sent.format, CAPTURE_AUDIO.container, 'format 必须与采集端产出规格一致');
    assertEqual(sent.rate, CAPTURE_AUDIO.sampleRate, 'rate 必须与产出规格一致：写错不报错，只会悄悄识别率变差');
    assertEqual(sent.channel, CAPTURE_AUDIO.channels, 'channel 同上');
    assertEqual(sent.len, WAV_BYTES.byteLength, 'len 是原始字节数');
    assertEqual(sent.token, 'tok-1', 'token 来自 OAuth');
    assertEqual(Buffer.from(String(sent.speech), 'base64').byteLength, WAV_BYTES.byteLength, 'base64 解回应是取出来的那一段音频');

    /* 第二段不再换 token：逐段转写一次查房几十段，每段换一次等于把自己打进对方的限流表  */
    const second = await client.transcribe({ index: 2, audio: WAV_BYTES, sessionId: 'sess-bd' });
    assertEqual(second.text, '术后第一天', '第二段照常');
    assertEqual(cloud.calls.filter(isOauth).length, 1, 'token 应被缓存：只换一次');
  });

  await test('AU30 百度的 err_no 语义分得开：3302 是"没听到"（空段），3301 是"没转成"（失败），110 要清缓存', async () => {
    clearAsrTokenCache();
    let errNo = BAIDU_EMPTY_CODE;
    const cloud = fakeCloud((request) =>
      isOauth(request) ? { status: 200, body: OAUTH_BODY } : errNo === 0 ? baiduOk('重新拿到了文本') : baiduErr(errNo),
    );
    const config = validateCaptureConfig({
      asr: { kind: 'baidu-rest', endpoint: vendorOf('baidu-rest').defaultEndpoint, modelId: ASR_MODEL, acknowledgePublicCloud: true },
    });
    const { client } = asrClient(config, cloud.transport, { apiKey: 'AK', apiSecret: 'SK' });

    assertEqual((await client.transcribe({ index: 1, audio: WAV_BYTES, sessionId: 's' })).text, '', '3302（结果为空）是**合法的空段**：这段确实没说话');
    errNo = 3301;
    assertEqual(
      await codeOfAsync(() => client.transcribe({ index: 2, audio: WAV_BYTES, sessionId: 's' })),
      'E_CAPTURE_SUBMIT_FAILED',
      '3301（音质差）必须判**失败**：归成空段会让医生以为"这段本来就没什么说的"，而现场是"偶尔丢一句"',
    );
    errNo = 110;
    assertEqual(
      await codeOfAsync(() => client.transcribe({ index: 3, audio: WAV_BYTES, sessionId: 's' })),
      'E_CAPTURE_CREDENTIAL_MISSING',
      '110（token 无效）应判凭据问题',
    );
    const beforeRetry = cloud.calls.filter(isOauth).length;
    errNo = 0;
    await client.transcribe({ index: 4, audio: WAV_BYTES, sessionId: 's' });
    assertEqual(cloud.calls.filter(isOauth).length, beforeRetry + 1, 'token 失效后要清缓存，下一次重新换（否则会一直用坏 token 直到有人重启进程）');
  });

  await test('AU31 阿里云：裸音频字节 + X-NLS-Token；"没听到"与"真失败"也分得开', async () => {
    let status = ALIYUN_OK_CODE;
    let result: unknown = '双肺呼吸音清';
    const cloud = fakeCloud(() => ({ status: 200, body: JSON.stringify({ status, result, message: 'SUCCESS' }) }));
    const config = validateCaptureConfig({
      asr: {
        kind: 'aliyun-nls',
        endpoint: vendorOf('aliyun-nls').defaultEndpoint,
        appKey: 'APP-9',
        modelId: ASR_MODEL,
        acknowledgePublicCloud: true,
      },
    });
    const { client } = asrClient(config, cloud.transport, { apiKey: 'NLS-TOKEN' });
    const first = await client.transcribe({ index: 1, audio: WAV_BYTES, sessionId: 's' });
    assertEqual(first.text, '双肺呼吸音清', '取 result');
    assertEqual(first.taskId, '', '阿里云也没有 task_id');

    const call = cloud.calls[0];
    assertEqual(call?.method, 'POST', '一句话识别是 POST');
    assertEqual(call?.headers['X-NLS-Token'], 'NLS-TOKEN', 'token 走自定义头（**不进 URL**：URL 会进日志）');
    assertEqual(call?.headers['Content-Type'], 'application/octet-stream', '要裸字节，不是 multipart');
    assert(call?.raw?.body instanceof Uint8Array, '音频要作为裸字节发出去');
    assertEqual((call?.raw?.body as Uint8Array).byteLength, WAV_BYTES.byteLength, '发出去的就是取出来的那一段');
    assert(call?.url.includes('appkey=APP-9') === true, 'AppKey 进 query');
    assert(call?.url.includes(`sample_rate=${CAPTURE_AUDIO.sampleRate}`) === true, '采样率必须与产出规格一致');
    assert(call?.url.includes(`format=${CAPTURE_AUDIO.container}`) === true, '格式同上');

    status = ALIYUN_EMPTY_CODE;
    assertEqual((await client.transcribe({ index: 2, audio: WAV_BYTES, sessionId: 's' })).text, '', '40000001（无有效语音）是合法的空段');
    status = ALIYUN_QUOTA_CODE;
    assertEqual(
      await codeOfAsync(() => client.transcribe({ index: 3, audio: WAV_BYTES, sessionId: 's' })),
      'E_CAPTURE_SUBMIT_FAILED',
      '配额超限必须判失败（不是"这段没说话"）',
    );
  });

  await test('AU32 云厂商没有轮询：轮询间隔不参与；但单段预算照样兜底 —— 哪一家都不许无限等', async () => {
    clearAsrTokenCache();
    const config = validateCaptureConfig({
      asr: {
        kind: 'baidu-rest',
        endpoint: vendorOf('baidu-rest').defaultEndpoint,
        modelId: ASR_MODEL,
        acknowledgePublicCloud: true,
        pollIntervalMs: 30_000,
        pollTimeoutMs: 60_000,
      },
    });
    const cloud = fakeCloud((request) => (isOauth(request) ? { status: 200, body: OAUTH_BODY } : baiduOk('好')));
    const { client, clock } = asrClient(config, cloud.transport, { apiKey: 'AK', apiSecret: 'SK' });
    await client.transcribe({ index: 1, audio: WAV_BYTES, sessionId: 's' });
    assertEqual(clock.elapsed(), 0, '一次性请求一次都不该睡（轮询间隔在云厂商身上不参与任何事）');
    assertEqual(cloud.calls.filter((item) => item.method === 'GET' && !isOauth(item)).length, 0, '没有轮询 GET');

    /* 预算耗尽时连请求都不发：明知来不及还去撞一下，只是把失败拖到超时之后  */
    let ticks = 0;
    const jumpy = createAsrClient(config.asr, {
      transport: cloud.transport,
      apiKey: 'AK',
      apiSecret: 'SK',
      now: () => (ticks += 100_000),
      sleep: async () => undefined,
    });
    const callsBefore = cloud.calls.length;
    assertEqual(
      await codeOfAsync(() => jumpy.transcribe({ index: 2, audio: WAV_BYTES, sessionId: 's' })),
      'E_CAPTURE_ASR_TIMEOUT',
      '预算耗尽应判该段失败（院内那台是这样，云厂商也一样）',
    );
    assertEqual(cloud.calls.length, callsBefore, '预算耗尽时一个请求都不发');
  });

  await test('AU33 两格凭据各自落库且永不回显；缺口与"是否出院"都要下发（界面红标与置灰靠它）', () => {
    const fixture = openConfigFixture({ prefix: 'l0-capture-cloud-' });
    try {
      const saved = saveCaptureConfig(
        fixture.kv,
        {
          kind: 'baidu-rest',
          endpoint: vendorOf('baidu-rest').defaultEndpoint,
          modelId: ASR_MODEL,
          acknowledgePublicCloud: true,
          apiKey: 'AK-9',
          apiSecret: 'SK-9',
        },
        'ADMIN',
      );
      assertEqual(saved.apiKeyAction, 'set', '主凭据应落盘');
      assertEqual(saved.apiSecretAction, 'set', '次凭据应落盘');
      assertEqual(fixture.kv.read(CAPTURE_API_SECRET_KEY), 'SK-9', '次凭据在**自己那一行**（改地址不该顺手动它）');

      const view = describeCaptureConfig(loadCaptureConfig(fixture.kv));
      assertEqual(view.kind, 'baidu-rest', '界面要知道是哪一家');
      assertEqual(view.leavesIntranet, true, '界面必须知道音频会出院（红标靠它）');
      assertEqual(view.acknowledgePublicCloud, true, '确认状态要下发');
      assertEqual(view.apiKeyPresent, true, '主凭据只报"就位"');
      assertEqual(view.apiSecretPresent, true, '次凭据同样只报"就位"');
      assertEqual(JSON.stringify(view).includes('AK-9'), false, '**主凭据值不得出现在视图里**');
      assertEqual(JSON.stringify(view).includes('SK-9'), false, '**次凭据值也不得出现**');
      assertEqual(view.configured, true, '都配全了才可用');

      /* 只改一格的补丁：不该顺手把别的清空（"我就调了下静音判停，采集没了"是最气人的一类现场）  */
      const patched = saveCaptureConfig(fixture.kv, { silenceMs: 1_200 }, 'ADMIN');
      assertEqual(patched.loaded.config.asr.endpoint, vendorOf('baidu-rest').defaultEndpoint, '补丁保存不得清掉地址');
      assertEqual(patched.loaded.config.asr.kind, 'baidu-rest', '也不得把厂商改回默认');

      /* 清掉次凭据 → 立刻不可用，且缺口说得出是哪一格 */
      const cleared = saveCaptureConfig(fixture.kv, { apiSecret: null }, 'ADMIN');
      assertEqual(cleared.apiSecretAction, 'cleared', '清除要记动作');
      assertEqual(fixture.kv.read(CAPTURE_API_SECRET_KEY), null, '清除要**真删那一行**（留着密文等于"我清掉了"是假的）');
      assertEqual(describeCaptureConfig(cleared.loaded).configured, false, '凭据缺一格就该不可用');
      assertEqual((describeCaptureConfig(cleared.loaded).missing as string[]).includes('Secret Key'), true, '缺口要说得出是哪一格');

      /* 换厂商不自动清另一家的凭据：否则"我改回院内服务，再换回来时全 401"  */
      const back = saveCaptureConfig(fixture.kv, { kind: 'intranet-task', acknowledgePublicCloud: false }, 'ADMIN');
      assertEqual((describeCaptureConfig(back.loaded).missing as string[]).includes('Secret Key'), false, '院内服务不需要凭据，缺口里不该有它');
      const again = saveCaptureConfig(fixture.kv, { kind: 'baidu-rest', acknowledgePublicCloud: true }, 'ADMIN');
      assertEqual(describeCaptureConfig(again.loaded).apiKeyPresent, true, '换回百度时主凭据还在（没被顺手清掉）');
      assertEqual(describeCaptureConfig(again.loaded).configured, false, '次凭据刚被清过：仍然不可用（不能"看起来又好了"）');
    } finally {
      fixture.cleanup();
    }
  });

  await test('AU34 浏览器侧段规则 ≡ capture.ts：分片逐字段、WAV 逐字节（两份实现的对照证明）', () => {
    /* 浏览器拿不到 TS（无打包步骤 + 经典脚本），所以"浏览器麦克风"这条路必然有第二份实现。
       这条用例就是那两份实现不许分叉的机器证明：分片规则同时决定建议条数与时间区间，
       分叉的表现是"演示里切得对、真机上切得不对"，而它只在现场、只在某一段录音上出现。  */
    const config: SegmentConfig = { silenceMs: 800, maxSeconds: 6, minSeconds: 1 };
    const events: CaptureInput[] = [];
    const frames: CaptureFrame[] = [];
    const feed = (fromSec: number, count: number, frameSec: number, voiced: boolean): number => {
      let at = fromSec;
      for (let i = 0; i < count; i += 1) {
        const frame: CaptureFrame = { startSec: at, endSec: Number((at + frameSec).toFixed(6)), voiced, pcm: pcmOf(frameSec, voiced) };
        frames.push(frame);
        events.push({ kind: 'frame', startSec: frame.startSec, endSec: frame.endSec, voiced });
        at = frame.endSec;
      }
      return at;
    };
    /* 什么情况都摆进来：开头静音 / 静音判停 / 超长强切 / 过短尾巴 / 暂停 / 手动停止 */
    let at = feed(0, 2, 0.5, false);
    at = feed(at, 4, 0.5, true);
    at = feed(at, 2, 0.5, false);
    at = feed(at, 14, 0.5, true);
    at = feed(at, 1, 0.5, true);
    events.push({ kind: 'pause', atSec: at });
    at = feed(at, 3, 0.5, true);
    events.push({ kind: 'stop', atSec: at });

    const ts = planChunks(events, config);
    const jsPlanner = createChunkPlannerWeb(config);
    const jsChunks: unknown[] = [];
    for (const event of events) jsChunks.push(...jsPlanner.feed(event));

    assert(ts.chunks.length >= 4, `这段脚本至少要切出 4 段（实际 ${ts.chunks.length}），否则对拍没有覆盖面`);
    assertEqual(jsChunks, ts.chunks, '分片结果必须逐字段一致（段号 / 区间 / 时长 / 定稿原因）');
    assertEqual(jsPlanner.droppedShort, ts.droppedShort, '被丢弃的过短片数也必须一致（S4 要如实上报）');

    const tsAssembler = createChunkAssembler(config);
    const jsAssembler = createChunkAssemblerWeb(config);
    const tsAudio: Uint8Array[] = [];
    const jsAudio: Uint8Array[] = [];
    for (const frame of frames) {
      tsAudio.push(...tsAssembler.feed(frame).map((chunk) => chunk.audio));
      jsAudio.push(...jsAssembler.feed(frame).map((chunk) => chunk.audio));
    }
    tsAudio.push(...tsAssembler.finish(at).map((chunk) => chunk.audio));
    jsAudio.push(...jsAssembler.finish(at).map((chunk) => chunk.audio));

    assertEqual(jsAudio.length, tsAudio.length, '段数就是建议条数：差一条就是医生会看到的那一条');
    jsAudio.forEach((bytes, i) => {
      const other = tsAudio[i] as Uint8Array;
      assertEqual(bytes.byteLength, other.byteLength, `第 ${i + 1} 段的 WAV 长度必须一致`);
      assert(bytes.every((value, index) => value === other[index]), `第 ${i + 1} 段的 WAV 必须逐字节一致`);
      const parsed = parseCaptureWav(bytes);
      assertEqual(
        [parsed.sampleRate, parsed.channels, parsed.bitsPerSample],
        [CAPTURE_AUDIO.sampleRate, CAPTURE_AUDIO.channels, CAPTURE_AUDIO.bitsPerSample],
        '每段都必须是 16k / 单声道 / 16-bit（浏览器可能给你 48000，而你以为拿到 16000）',
      );
    });

    /* 头与整包各自单独对拍一次：这样"组装器一致、编码器不一致"这种只改半边的情况不会漏 */
    assertEqual(
      Array.from(buildWavHeaderWeb(1234)),
      Array.from(encodeCaptureWav(new Uint8Array(1234)).slice(0, 44)),
      'WAV 头必须逐字节一致（差一个字段，ASR 侧收到的就是坏文件）',
    );
    const webWav = encodeCaptureWavWeb(pcmOf(0.1, true));
    const tsWav = encodeCaptureWav(pcmOf(0.1, true));
    assertEqual(webWav.byteLength, tsWav.byteLength, '同一份 PCM 编出来的 WAV 长度必须一致');
    assert(webWav.every((value, index) => value === tsWav[index]), '同一份 PCM 编出来的 WAV 必须逐字节一致（含头）');
    assertEqual(
      [CAPTURE_WEB_AUDIO.sampleRate, CAPTURE_WEB_AUDIO.channels, CAPTURE_WEB_AUDIO.bitsPerSample],
      [CAPTURE_AUDIO.sampleRate, CAPTURE_AUDIO.channels, CAPTURE_AUDIO.bitsPerSample],
      '浏览器侧的音频规格必须与采集层一致（否则上面几条只是"两边一起错"）',
    );
  });

  await test('AU35 浏览器侧探测与失败语义 ≡ capture.ts：逐句一致（照错的那一句去修就是白跑一趟）', () => {
    const envs = [
      ['非安全上下文', { isSecureContext: false, hasGetUserMedia: true, hasAudioContext: true }],
      ['缺 getUserMedia', { isSecureContext: true, hasGetUserMedia: false, hasAudioContext: true }],
      ['缺 Web Audio', { isSecureContext: true, hasGetUserMedia: true, hasAudioContext: false }],
      ['都具备', { isSecureContext: true, hasGetUserMedia: true, hasAudioContext: true }],
    ] as const;
    for (const [name, env] of envs) {
      assertEqual(probeMicEnvironmentWeb(env), probeMicEnvironment(env), `${name}：探测结论（含现场表现与"怎么办"）必须逐句一致`);
    }
    /* 顺序也要一致：先判安全上下文。`http://10.x` 下浏览器根本不弹权限框，
       说成"未获得麦克风权限"会让医生去站点设置里白点半天。 */
    assertEqual(
      probeMicEnvironmentWeb({ isSecureContext: false, hasGetUserMedia: false, hasAudioContext: false }).code,
      'E_CAPTURE_INSECURE_CONTEXT',
      '不可用时最先该说的是"换个访问方式"，而不是"缺能力"',
    );

    const failures: Array<[string, unknown]> = [
      ['权限被拒', { name: 'NotAllowedError', message: 'denied' }],
      ['没有设备', { name: 'NotFoundError', message: 'no device' }],
      ['设备被占用', { name: 'NotReadableError', message: 'busy' }],
      ['未知故障', new Error('boom')],
    ];
    const howTos = new Set<string>();
    for (const [name, err] of failures) {
      const tsProblem = describeSourceFailure(err);
      assertEqual(describeSourceFailureWeb(err), tsProblem, `${name}：失败语义必须逐句一致`);
      howTos.add(tsProblem.howTo);
    }
    assertEqual(howTos.size, failures.length, '四类失败的"怎么办"必须互不相同（混成一句"录音失败"等于让人去搜）');
    assertEqual(
      describeSourceFailureWeb(new Error('boom')).message.includes('boom'),
      true,
      '未知故障要带上原始信息（不吞），否则现场只能看到一句"采集失败"',
    );
  });

  await test('AU36 浏览器侧定帧：时间轴首尾相接、按停不丢尾巴、重采样到 16 kHz', () => {
    /* 帧的时间区间由已产出样本数算出（不是 wall clock）：wall clock 会因回调抖动算出重叠或缝隙，
       而 S2 一旦失守，"那段时间说的话不属于任何段"且看不出来。  */
    const chunker = createFrameChunker({ sampleRate: 16_000, frameSec: 0.5, vadThreshold: 0.01 });
    const frames: CaptureFrame[] = [];
    const total = Math.round(16_000 * 1.3);
    let fed = 0;
    while (fed < total) {
      const size = Math.min(4096, total - fed);
      const block = new Float32Array(size);
      for (let i = 0; i < size; i += 1) block[i] = 0.2;
      for (const frame of chunker.push(block)) frames.push(frame);
      fed += size;
    }
    assertEqual(frames.length, 2, '1.3 秒应凑出 2 个整帧（0.5 + 0.5），剩下的不足一帧');
    assertEqual(frames.map((frame) => [frame.startSec, frame.endSec]), [[0, 0.5], [0.5, 1]], '整帧的区间必须严格首尾相接（S2）');
    assertEqual(frames.map((frame) => frame.pcm.byteLength), [16_000, 16_000], '每帧必须是 16 kHz 单声道 16-bit（0.5s = 16000 字节）');
    assertEqual(frames.every((frame) => frame.voiced), true, '响度 0.2 远高于阈值，该帧应判为人声');

    const tail = chunker.flush();
    assertEqual(tail.length, 1, '收尾必须把不足一帧的尾巴也交出去（不发等于丢掉最后一句话）');
    assertEqual([tail[0]!.startSec, tail[0]!.endSec], [1, 1.3], '尾巴的区间接在整帧之后（不重叠、不留缝）');
    assertEqual(chunker.flush().length, 0, '尾巴只能交出去一次（重复发会把同一句话送两次）');
    assertEqual(chunker.elapsedSec, 1.3, '已录时长要算上还没成帧的部分（界面计时用它）');

    /* 重采样：流式喂与一次喂必须给出同一个波形（state 算错的表现是"每隔一会儿音调跳一下"） */
    const inputRate = 48_000;
    const source = new Float32Array(inputRate / 10);
    for (let i = 0; i < source.length; i += 1) source[i] = Math.sin((2 * Math.PI * 1000 * i) / inputRate);
    const once = resampleLinear(source, inputRate, 16_000, { pending: new Float32Array(0), readPos: 0 });
    const state = { pending: new Float32Array(0), readPos: 0 };
    const pieces: number[] = [];
    for (let offset = 0; offset < source.length; offset += 4096) {
      const piece = resampleLinear(source.subarray(offset, Math.min(source.length, offset + 4096)), inputRate, 16_000, state);
      for (const value of piece) pieces.push(value);
    }
    assert(Math.abs(once.length - 1600) <= 2, `重采样到 16 kHz 后长度应约等于 1600（实际 ${once.length}）`);
    assertEqual(pieces.length, once.length, '流式重采样的输出长度必须与一次性重采样一致');
    assert(
      pieces.every((value, i) => Math.abs(value - (once[i] as number)) < 1e-9),
      '流式重采样的波形必须与一次性重采样逐样本一致（否则"分块大小"会改变录到的内容）',
    );
  });

  await test('AU37 浏览器麦克风源：探测不碰设备、只由人 start、按停立刻兑现且真的放开设备', async () => {
    /* 这条守的是"页面侧的采集源"这个槽位本身：它与演示源、本地客户端同一个接口，下游一行不改。
       设备全是假的 —— 自测去开真麦克风，等于让自测偶尔失败。 */
    const insecure = createBrowserMicSource({
      env: { isSecureContext: false, hasGetUserMedia: true, hasAudioContext: true },
      getUserMedia: () => { throw new Error('不该被调用'); },
      audioContextCtor: class {},
    });
    assertEqual(insecure.probe().code, 'E_CAPTURE_INSECURE_CONTEXT', '非安全上下文：按下去之前就该说清');
    assertEqual(
      await codeOfAsync(() => insecure.start(() => {})),
      'E_CAPTURE_INSECURE_CONTEXT',
      '不可用时 start 必须拒绝（不申请权限、不打开设备）',
    );

    const denied = createBrowserMicSource({
      env: { isSecureContext: true, hasGetUserMedia: true, hasAudioContext: true },
      getUserMedia: async () => { throw Object.assign(new Error('denied'), { name: 'NotAllowedError' }); },
      audioContextCtor: class {},
    });
    assertEqual(
      await codeOfAsync(() => denied.start(() => {})),
      'E_CAPTURE_PERMISSION_DENIED',
      '权限被拒要给出"去站点设置里允许"这一步，而不是一句"录音失败"',
    );

    const fake = makeFakeMic();
    let acquired = 0;
    const seen: Array<{ startSec: number; endSec: number; bytes: number }> = [];
    const source = createBrowserMicSource({ ...fake.options, onAcquired: () => { acquired += 1; } });
    const ended = source.start((frame: CaptureFrame) => seen.push({ startSec: frame.startSec, endSec: frame.endSec, bytes: frame.pcm.byteLength }));
    await tick();
    assertEqual(acquired, 1, '设备真的打开之后才该说"正在采集"（权限框还开着的时候不能说）');
    assertEqual(
      await codeOfAsync(() => source.start(() => {})),
      'E_CAPTURE_SOURCE_UNKNOWN',
      '正在采集时再次开始应被拒（重复打开设备是真实存在的坑）',
    );

    fake.drive(1.05);
    assert(seen.length >= 2, `1.05 秒应至少出 2 帧（实际 ${seen.length}）`);
    assertEqual(seen.every((frame, i) => i === 0 || seen[i - 1]!.endSec === frame.startSec), true, '帧必须首尾相接（S2）');
    assertEqual(seen.every((frame) => frame.bytes === 16_000), true, '每帧必须是 16 kHz 单声道 16-bit 的 0.5 秒');

    await source.stop();
    await ended;
    assertEqual(fake.tracksStopped(), 1, '停止必须真的放开设备（不放开，麦克风指示灯会一直亮着）');
    const before = seen.length;
    fake.drive(0.5);
    assertEqual(seen.length, before, '停止之后不许再吐帧');
    assertEqual(seen[before - 1]!.endSec >= 1, true, '按停前的音频要交出去（不足一帧的尾巴也不丢）');
  });

  process.exit(suite.report());
}

void main();
