/**
 * 采集源（C3a）：**唯一与"音频从哪来"有关的一层**。
 *
 * ## 它为什么必须被单独抽出来
 *
 * `docs/L2-语音采集设计.md` 第二节把"麦克风拿不到"这件事的出路列了三条：
 * ① 内部 CA 上 HTTPS；② 采集下沉到桌面客户端；③ 用现成的采集设备（智能麦克风 / 语音输入法）。
 * 能力矩阵里 **K10「多端形态（浏览器 / Electron / 桌面控件）」的验收口径是"同一内核在 3 种宿主行为一致"** ——
 * 那就意味着"音频从哪来"必须是**一个可替换的槽位**，而不是散在页面里的几段 `getUserMedia` 代码。
 * 本模块就是那个槽位：换宿主只换一个实现，**下面的编排（分片 → 提交 → 建议）一行不改**。
 *
 * ## 三条纪律
 *
 * 1) **不可用必须给出"怎么办"**：设计第六节逐行列出了现场表现与可执行的那一步
 *    （"去浏览器站点设置里允许麦克风"）。只丢一个错误码等于让人去搜；
 * 2) **探测不申请权限**：`probe()` 只做只读判断（安全上下文 / 能力是否存在），
 *    **不打开设备、不弹权限框** —— 界面要在用户按下"开始"之前就能说清"这条路走不走得通"；
 * 3) **只由人按下开始**（设计第八节第 2 条）：本模块不提供"打开就开始听"的入口，
 *    也没有任何定时器/事件能自己调 `start()`。
 *
 * ## 诚实边界
 *
 * 本文**不含真实麦克风实现**：`getUserMedia` + PCM（`AudioWorklet` / `OfflineAudioContext`）
 * 在 `http://10.x` 下根本拿不到，写了也无法在这里验证 —— 而"写了没验证过的浏览器音频代码"
 * 比"没有这段代码"更危险（它会让人以为已经能用）。真实源落地时要接在同一个槽位上，
 * 并补上"真机采样率必须是 16 kHz"这条验证（设计第三节：浏览器可能给你 48000，而你以为拿到 16000）。
 */

/**
 * 帧的形状定义在 `capture.ts`（它是"帧 → 段"流水线上的通行形状，不只采集源在用）。
 * 这里重新导出，免得调用方为了一个类型多写一条 import。
 */
import type { CaptureFrame } from './capture.ts';
export type { CaptureFrame };

/* ============================== 可用性与失败语义（第六节） ============================== */

export type CaptureSourceFailureCode =
  /** 非安全上下文：`http://10.x` 下浏览器直接不给麦克风，且**没有任何前端办法绕过** */
  | 'E_CAPTURE_INSECURE_CONTEXT'
  | 'E_CAPTURE_PERMISSION_DENIED'
  | 'E_CAPTURE_NO_DEVICE'
  | 'E_CAPTURE_DEVICE_BUSY'
  | 'E_CAPTURE_UNSUPPORTED'
  | 'E_CAPTURE_SOURCE_UNKNOWN';

export interface CaptureSourceProblem {
  code: CaptureSourceFailureCode;
  /** 现场表现（给人看的一句话） */
  message: string;
  /** **怎么办** —— 失败必须同时给出可执行的一步，而不是只丢一个错误码 */
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

/** 只读环境事实（由调用方从宿主里读出来，便于自测注入） */
export interface CaptureEnvironment {
  /** HTTPS 或 localhost */
  isSecureContext: boolean;
  /** 宿主是否提供 `getUserMedia` */
  hasGetUserMedia: boolean;
  /** 宿主是否提供 Web Audio（拿 PCM 要靠它） */
  hasAudioContext: boolean;
}

/**
 * 探测麦克风这条路走不走得通。**纯函数、不碰设备**。
 *
 * 判定的顺序是有讲究的：**先判安全上下文**。`http://10.x` 下不仅拿不到麦克风，
 * 连"是不是用户拒绝了权限"这个问题都问不出来（浏览器根本不会弹框）——
 * 把它排在后面，现场就会显示成"未获得麦克风权限"，而医生去设置里点半天也没用。
 */
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

/**
 * 把采集过程中的失败翻译成"现场表现 + 怎么办"。**纯函数**（喂 Error-like 对象即可测）。
 *
 * 为什么不区分得更细：这三类（权限 / 没有设备 / 被占用）覆盖了现场绝大多数情况，
 * 而它们的处置**完全不同**（去设置里开权限 / 插设备 / 关掉别的程序）——
 * 按 `DOMException.name` 分开正是为了让提示能指向正确的那一步。
 */
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

/* ============================== 采集源接口 ============================== */

export interface CaptureSource {
  /** 采集源标识（`browser-mic` / `shell` / `device` / `sample`）—— 留痕与界面要能回答"音频从哪来" */
  readonly id: string;
  /** 可用性自检：不通过时必须给出 why + howTo；**不申请权限、不打开设备** */
  probe(): CaptureProbe;
  /**
   * 开始采集：帧通过 `onFrame` 回调给出。
   *
   * 约定：**返回的 Promise 在采集结束时兑现**（时间线走完 / 设备停止 / 有人调了 `stop()`）。
   * 调用方负责"先让录音指示可见，再调它"（设计第八节第 1 条：不允许任何"看不见在录"的路径）。
   */
  start(onFrame: (frame: CaptureFrame) => void): Promise<void>;
  /** 停止采集。**停止本身不该失败**：它被按停时抛错，只会让人以为出了别的问题 */
  stop(): Promise<void>;
}

/* ============================== 演示采集源 ============================== */

export interface SampleCaptureOptions {
  /**
   * 脚本时间线：一段一段给出"这段算不算人声"。
   *
   * **它不做音量分析**（那是真实 VAD 的事）：演示源按脚本判定 `voiced`，
   * 因此"静音判停"这类行为在演示里也是可复现的 —— 而不是靠对着麦克风说话。
   */
  timeline: Array<{ seconds: number; voiced: boolean }>;
  /** 帧长（秒），默认 0.5：够细以体现分片规则，又不至于在演示里刷出上千帧 */
  frameSec?: number;
  sampleRate?: number;
  /** 睡眠可注入：自测用假实现，不真的等 */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 生成一帧 PCM：人声段给一个可听的正弦，静音段给零（内容是假的，但**格式必须是真的**） */
function synthesizePcm(sampleRate: number, seconds: number, voiced: boolean): Uint8Array {
  const samples = Math.round(sampleRate * seconds);
  const pcm = new Uint8Array(samples * 2);
  if (!voiced) return pcm;
  const view = new DataView(pcm.buffer);
  for (let i = 0; i < samples; i += 1) {
    /* 440Hz、幅度 1/4：只为让"这段有人声"这件事在波形上也不假，不追求像人说话 */
    const value = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 8192);
    view.setInt16(i * 2, value, true);
  }
  return pcm;
}

/**
 * 演示采集源：按脚本时间线产出帧，**不需要麦克风、不需要 HTTPS**。
 *
 * 它存在的理由和"靶子 ASR"完全一样：让"采集 → 分片 → 提交 → 建议"这条链在今天就能被
 * 真的跑一遍与真的测一遍。真实源（浏览器麦克风 / 桌面壳采集）接在同一个槽位上，
 * 因而**它验过的编排逻辑，换源之后不用重验**。
 */
export function createSampleCaptureSource(options: SampleCaptureOptions): CaptureSource {
  const frameSec = options.frameSec ?? 0.5;
  const sampleRate = options.sampleRate ?? 16_000;
  const sleep = options.sleep ?? defaultSleep;
  let stopped = false;
  let running = false;

  return {
    id: 'sample',
    probe() {
      /* 演示源不依赖任何宿主能力 —— 但它**必须标明自己是演示源**（不是真识别，也不是真录音） */
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
