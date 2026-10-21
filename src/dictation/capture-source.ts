import type { CaptureFrame } from './capture.ts';
export type { CaptureFrame };

export type CaptureSourceFailureCode =
  | 'E_CAPTURE_INSECURE_CONTEXT'
  | 'E_CAPTURE_PERMISSION_DENIED'
  | 'E_CAPTURE_NO_DEVICE'
  | 'E_CAPTURE_DEVICE_BUSY'
  | 'E_CAPTURE_UNSUPPORTED'
  | 'E_CAPTURE_SOURCE_UNKNOWN';

export interface CaptureSourceProblem {
  code: CaptureSourceFailureCode;
  message: string;
  howTo: string;
}

export class CaptureSourceError extends Error {
  code: CaptureSourceFailureCode;
  howTo: string;

  constructor(problem: CaptureSourceProblem) {
    super(problem.message);
    this.name = 'CaptureSourceError';
    this.code = problem.code;
    this.howTo = problem.howTo;
  }
}

export type CaptureProbe = { ok: true; sourceId: string } | ({ ok: false; sourceId: string } & CaptureSourceProblem);

export interface CaptureEnvironment {
  isSecureContext: boolean;
  hasGetUserMedia: boolean;
  hasAudioContext: boolean;
}

export function probeMicEnvironment(env: CaptureEnvironment, sourceId = 'browser-mic'): CaptureProbe {
  if (!env.isSecureContext) {
    return {
      ok: false,
      sourceId,
      code: 'E_CAPTURE_INSECURE_CONTEXT',
      message: '当前访问方式不允许录音（需 HTTPS 或 localhost）',
      howTo: '换用 https:// 打开本系统（内部 CA 签发即可），或改用桌面客户端 / 现成的采集设备',
    };
  }
  if (!env.hasGetUserMedia) {
    return {
      ok: false,
      sourceId,
      code: 'E_CAPTURE_UNSUPPORTED',
      message: '当前浏览器不支持录音（缺少 getUserMedia）',
      howTo: '换用 Chromium 系浏览器，或改用桌面客户端 / 现成的采集设备',
    };
  }
  if (!env.hasAudioContext) {
    return {
      ok: false,
      sourceId,
      code: 'E_CAPTURE_UNSUPPORTED',
      message: '当前浏览器缺少 Web Audio 能力（拿不到 PCM）',
      howTo: '换用 Chromium 系浏览器，或改用桌面客户端 / 现成的采集设备',
    };
  }
  return { ok: true, sourceId };
}

export function describeSourceFailure(err: unknown): CaptureSourceProblem {
  const name = String((err as { name?: unknown })?.name ?? '');
  const detail = String((err as { message?: unknown })?.message ?? err ?? '');
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
    return {
      code: 'E_CAPTURE_PERMISSION_DENIED',
      message: '未获得麦克风权限',
      howTo: '在浏览器地址栏的站点设置里把麦克风改成"允许"，然后重新点「开始采集」',
    };
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') {
    return {
      code: 'E_CAPTURE_NO_DEVICE',
      message: '未检测到麦克风',
      howTo: '接上麦克风（或确认设备已启用）后重新点「开始采集」',
    };
  }
  if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') {
    return {
      code: 'E_CAPTURE_DEVICE_BUSY',
      message: '麦克风被其他程序占用',
      howTo: '关掉正在用麦克风的程序（会议软件、录音机等）后重新点「开始采集」',
    };
  }
  return {
    code: 'E_CAPTURE_SOURCE_UNKNOWN',
    message: `采集失败：${detail}`,
    howTo: '重试一次；仍然失败请把这条错误报给运维（这是采集源的未知故障，不是"这段没说话"）',
  };
}

export interface CaptureSource {
  readonly id: string;
  /** 可用性自检：不通过时必须给出 why + howTo；不申请权限、不打开设备  */
  probe(): CaptureProbe;
  start(onFrame: (frame: CaptureFrame) => void): Promise<void>;
  stop(): Promise<void>;
}

export interface SampleCaptureOptions {
  timeline: Array<{ seconds: number; voiced: boolean }>;
  /** 帧长（秒），默认 0.5：够细以体现分片规则，又不至于在演示里刷出上千帧 */
  frameSec?: number;
  sampleRate?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 生成一帧 PCM：人声段给一个可听的正弦，静音段给零（内容是假的，但格式必须是真的）  */
function synthesizePcm(sampleRate: number, seconds: number, voiced: boolean): Uint8Array {
  const samples = Math.round(sampleRate * seconds);
  const pcm = new Uint8Array(samples * 2);
  if (!voiced) return pcm;
  const view = new DataView(pcm.buffer);
  for (let i = 0; i < samples; i += 1) {
    const value = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 8192);
    view.setInt16(i * 2, value, true);
  }
  return pcm;
}

export function createSampleCaptureSource(options: SampleCaptureOptions): CaptureSource {
  const frameSec = options.frameSec ?? 0.5;
  const sampleRate = options.sampleRate ?? 16_000;
  const sleep = options.sleep ?? defaultSleep;
  let stopped = false;
  let running = false;

  return {
    id: 'sample',
    probe() {
      return { ok: true, sourceId: 'sample' };
    },
    async start(onFrame) {
      if (running) {
        throw new CaptureSourceError({
          code: 'E_CAPTURE_SOURCE_UNKNOWN',
          message: '采集源已在运行（不重复打开设备）',
          howTo: '先按「停止」，再重新点「开始采集」',
        });
      }
      running = true;
      stopped = false;
      try {
        let cursor = 0;
        for (const segment of options.timeline) {
          if (stopped) break;
          const frames = Math.max(1, Math.round(segment.seconds / frameSec));
          for (let i = 0; i < frames; i += 1) {
            if (stopped) break;
            const from = cursor;
            const to = Number((cursor + segment.seconds / frames).toFixed(6));
            await sleep(Math.round((to - from) * 1000));
            onFrame({ startSec: from, endSec: to, voiced: segment.voiced, pcm: synthesizePcm(sampleRate, to - from, segment.voiced) });
            cursor = to;
          }
        }
      } finally {
        running = false;
      }
    },
    async stop() {
      stopped = true;
    },
  };
}
