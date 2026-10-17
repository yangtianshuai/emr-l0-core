/**
 * 浏览器端采集实现（C3b④）：**真实麦克风源**，以及它所需的那一份「段规则」。
 *
 * ## 为什么会有这个文件（本项目唯一一处刻意的第二份实现）
 *
 * 仓库没有打包步骤（`node` 直接跑 TS），而医生端 `ui.js` 是经典脚本 ——
 * 浏览器**拿不到 `src/dictation/*.ts` 里的任何代码**（`docs/L2-语音采集设计.md` 第九之二节）。
 * 于是"浏览器里接真实麦克风"这件事，必然要在浏览器侧再落一遍三样东西：
 * 分片规则（S1~S4）、WAV 组装、探测与失败语义。
 *
 * 「两份实现迟早分叉」不能靠自觉 —— 分叉的表现是**演示里切得对、真机上切得不对**，
 * 而那类 bug 只在现场、只在某一段录音上出现。所以 `test:capture` 的 AU34 把本文件
 * **真的 import 进 Node**，与 `capture.ts` 逐帧对拍：分片逐字段、WAV 逐字节、失败语义逐句。
 * 规则改了一边忘了另一边，那条用例立刻红。
 *
 * ## 谁加载它、怎么加载
 *
 * `ui.js`（经典脚本）用**动态 `import()`** 拉取（经典脚本里合法），
 * 由 `demo-server.ts` 以 `/capture-web.js` 托管（no-store，与 ui.js 同）。
 * 本文件**不 import 任何别的东西**，因此浏览器与 Node 两边都能直接加载。
 *
 * ## 诚实边界（写在这里，也要写进界面）
 *
 * - 它只在**安全上下文**（HTTPS / localhost）下能拿到麦克风；`http://10.x` 下浏览器
 *   根本不弹权限框，且没有任何前端办法绕过（第六节）；
 * - 人声判定用的是**能量阈值**（帧 RMS），不是真正的 VAD：安静诊室里够用，
 *   嘈杂环境下它会把噪声当人声（表现为"段切得很碎"）。换真 VAD 是另一个决定，不在这里假装做了；
 * - 采样用 `ScriptProcessorNode`（已废弃但仍在 Chromium 里可用）。它省掉了 `AudioWorklet`
 *   那一个**必须单独托管的工作线程文件**；换掉它是 K10（桌面形态）时的事；
 * - 浏览器采样率由设备决定（常见 48000），**必须重采样到 16 kHz**：不重采样就会得到
 *   "音调变尖、识别全错"的音频，而它听起来"有声音"，很容易被判成"识别不准"（第三节）。
 */

/* ============================== 音频规格 ============================== */

/**
 * 与 `src/dictation/capture-transport.ts` 的 `CAPTURE_AUDIO` 必须一致（AU34 逐字节守着）。
 * 16 kHz / 单声道 / 16-bit：ASR 侧的契约，不是随便挑的。
 */
export const CAPTURE_WEB_AUDIO = { sampleRate: 16000, channels: 1, bitsPerSample: 16 };

/** 采集源标识：留痕与界面要能回答"这段音频从哪来"（`sample` 是脚本音频，不是麦克风） */
export const CAPTURE_WEB_SOURCE_ID = 'browser-mic';

/** 帧长（秒）：与演示源的默认一致，静音判停的粒度就是它 */
export const CAPTURE_WEB_DEFAULT_FRAME_SEC = 0.5;

/**
 * 人声阈值（帧 RMS）。取 -40 dBFS 左右：宁可把安静的话当人声（多切一段，代价是段变多），
 * 也不要把小声的话当静音 —— 后者的表现是"我说的话一句都没进去"，而医生不知道为什么。
 */
export const CAPTURE_WEB_VAD_RMS = 0.01;

export class CaptureWebError extends Error {
  constructor(code, message, howTo) {
    super(message);
    this.name = 'CaptureWebError';
    this.code = code;
    this.howTo = howTo || '';
  }
}

/* ============================== WAV 组装（同 capture.ts） ============================== */

function writeAscii(target, offset, text) {
  for (let i = 0; i < text.length; i += 1) target[offset + i] = text.charCodeAt(i);
}

/** 44 字节 PCM 头，格式固定为 {@link CAPTURE_WEB_AUDIO} */
export function buildWavHeaderWeb(dataBytes) {
  if (!Number.isInteger(dataBytes) || dataBytes < 0) {
    throw new CaptureWebError(
      'E_CAPTURE_CONFIG_INVALID',
      `WAV 数据长度必须是非负整数，实际 ${JSON.stringify(dataBytes)}`,
      '这是内部错误（采集端算错了音频长度），请把这条报给运维',
    );
  }
  const header = new Uint8Array(44);
  const view = new DataView(header.buffer);
  const blockAlign = CAPTURE_WEB_AUDIO.channels * (CAPTURE_WEB_AUDIO.bitsPerSample / 8);
  writeAscii(header, 0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(header, 8, 'WAVE');
  writeAscii(header, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); /* 1 = PCM */
  view.setUint16(22, CAPTURE_WEB_AUDIO.channels, true);
  view.setUint32(24, CAPTURE_WEB_AUDIO.sampleRate, true);
  view.setUint32(28, CAPTURE_WEB_AUDIO.sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, CAPTURE_WEB_AUDIO.bitsPerSample, true);
  writeAscii(header, 36, 'data');
  view.setUint32(40, dataBytes, true);
  return header;
}

/** PCM → 可上传的 WAV（半字节即报错：那说明传进来的根本不是 16-bit PCM） */
export function encodeCaptureWavWeb(pcm) {
  const bytesPerSample = CAPTURE_WEB_AUDIO.bitsPerSample / 8;
  if (pcm.byteLength % bytesPerSample !== 0) {
    throw new CaptureWebError(
      'E_CAPTURE_CONFIG_INVALID',
      `PCM 字节数 ${pcm.byteLength} 不是 ${bytesPerSample} 的整数倍：采集端必须产出 16-bit 小端 PCM`,
      '这是内部错误（采集端算错了音频长度），请把这条报给运维',
    );
  }
  const header = buildWavHeaderWeb(pcm.byteLength);
  const out = new Uint8Array(header.byteLength + pcm.byteLength);
  out.set(header, 0);
  out.set(pcm, header.byteLength);
  return out;
}

/* ============================== 探测与失败语义（第六节） ============================== */

/**
 * 只读探测：**不申请权限、不打开设备**。
 *
 * 判定顺序同 `capture.ts`：先判安全上下文。`http://10.x` 下浏览器连权限框都不弹，
 * 把它排在后面，现场会显示成"未获得麦克风权限"，而医生去站点设置里点半天也没用。
 */
export function probeMicEnvironmentWeb(env, sourceId = CAPTURE_WEB_SOURCE_ID) {
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

/** 读宿主事实（探测的输入由宿主提供，便于自测注入） */
export function readBrowserEnv() {
  const hasAudioContext = typeof AudioContext !== 'undefined' || typeof webkitAudioContext !== 'undefined';
  return {
    isSecureContext: typeof window !== 'undefined' && window.isSecureContext === true,
    hasGetUserMedia: !!(typeof navigator !== 'undefined' && navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
    hasAudioContext,
  };
}

/**
 * 采集失败 → "现场表现 + 怎么办"。三类（权限 / 无设备 / 被占用）的处置完全不同，
 * 混成一句"录音失败"等于让人自己去搜。
 */
export function describeSourceFailureWeb(err) {
  const name = String((err && err.name) || '');
  const detail = String((err && err.message) || err || '');
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

/* ============================== 帧 → 段（与 capture.ts 同一套规则） ============================== */

/** 浮点比较容差：段边界由帧边界推出，理论上严格相等（与 capture.ts 同一个值） */
const TIMELINE_EPS = 1e-9;

/**
 * 分片器（流式）。四条语义（第四节，逐条不可让步）：
 *   - S1 时间区间以录音开始为 0 点累计，暂停恢复不重置起点；
 *   - S2 相邻分片首尾相接、不重叠不留缝（`end_i === start_{i+1}`）；
 *   - S3 段号从 1 起、与时间同序，这里不做重排；
 *   - S4 短于 `minSeconds` 的片按误触丢弃，但**必须计数**。
 *
 * 分片边界取"定稿时刻"而不是"最后一个有人声的帧"：否则留下的静音不属于任何一段，正好违反 S2。
 */
export function createChunkPlannerWeb(config) {
  let droppedShort = 0;
  let nextIndex = 1;
  let start = null;
  let carry = null;
  let silenceSec = 0;
  let previousEnd = -1;

  const finalize = (endSec, reason, out) => {
    if (start === null) return;
    const seconds = endSec - start;
    if (seconds <= 0) {
      throw new CaptureWebError('E_CAPTURE_BAD_TIMELINE', `定稿时刻 ${endSec} 不晚于分片起点 ${start}`, '这是内部错误（时间轴倒了），请把这条报给运维');
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
    get open() {
      return start !== null;
    },
    get openStartSec() {
      return start;
    },
    get droppedShort() {
      return droppedShort;
    },
    feed(event) {
      const out = [];
      if (event.kind === 'frame' && (event.endSec < event.startSec || event.startSec < previousEnd)) {
        throw new CaptureWebError(
          'E_CAPTURE_BAD_TIMELINE',
          `帧时间轴必须单调不减：收到 [${event.startSec}, ${event.endSec}]，上一帧结束于 ${previousEnd}`,
          '这是内部错误（时间轴倒了），请把这条报给运维',
        );
      }
      if (event.kind === 'pause') {
        finalize(event.atSec, 'pause', out);
        carry = null; /* 暂停期没有音频：下一个分片从恢复后的第一帧开始 */
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
          return out; /* 开头那段静音不属于任何分片 */
        }
        start = carry === null ? event.startSec : carry;
      }
      silenceSec = event.voiced ? 0 : silenceSec + (event.endSec - event.startSec);

      /* 超长优先于静音：连续口述不能把一段无限拖大 */
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

/**
 * 帧流 → 段（含该段的 WAV）。
 *
 * 与 `capture.ts` 同规则、逐字节同结果（AU34）。"每段上传的音频只含该段区间内的帧"这条
 * 必须守住：多带一帧就是把上一段的话又送了一次。
 */
export function createChunkAssemblerWeb(config) {
  const planner = createChunkPlannerWeb(config);
  const frames = [];

  const take = (plan) => {
    while (frames.length > 0 && frames[0].endSec <= plan.startSec + TIMELINE_EPS) frames.shift();
    const taken = [];
    while (frames.length > 0 && frames[0].endSec <= plan.endSec + TIMELINE_EPS) taken.push(frames.shift());
    const total = taken.reduce((sum, frame) => sum + frame.pcm.byteLength, 0);
    const pcm = new Uint8Array(total);
    let offset = 0;
    for (const frame of taken) {
      pcm.set(frame.pcm, offset);
      offset += frame.pcm.byteLength;
    }
    return { plan, audio: encodeCaptureWavWeb(pcm) };
  };

  return {
    get openStartSec() {
      return planner.openStartSec;
    },
    get droppedShort() {
      return planner.droppedShort;
    },
    feed(frame) {
      frames.push(frame);
      return planner.feed({ kind: 'frame', startSec: frame.startSec, endSec: frame.endSec, voiced: frame.voiced }).map(take);
    },
    finish(atSec) {
      return planner.feed({ kind: 'stop', atSec }).map(take);
    },
  };
}

/* ============================== PCM 处理（重采样 / 定帧 / VAD） ============================== */

/** 帧的响度（RMS）：人声判定的输入，也是"这段有没有声音"的唯一依据 */
export function rmsOf(samples) {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

/** Float32（[-1,1]）→ 16-bit 小端 PCM。**必须夹紧**：越界值会绕回成刺耳的爆音 */
export function pcm16FromFloat32(samples) {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i += 1) {
    const value = samples[i] < -1 ? -1 : samples[i] > 1 ? 1 : samples[i];
    view.setInt16(i * 2, Math.round(value * 32767), true);
  }
  return out;
}

/**
 * 线性插值重采样（**流式**：`state` 跨回调继续，由调用方持有）。
 *
 * 为什么不用 `OfflineAudioContext` 一把梭：它是"喂完再出结果"，而分片要的是**边说边出帧**
 * （静音判停是主路径）。线性插值对 16 kHz 的语音识别足够，代价是高频有轻微损失。
 */
export function resampleLinear(input, inputRate, targetRate, state) {
  if (inputRate === targetRate) return input.slice();
  const step = inputRate / targetRate;
  const merged = new Float32Array(state.pending.length + input.length);
  merged.set(state.pending, 0);
  merged.set(input, state.pending.length);
  const out = [];
  let pos = state.readPos;
  while (pos + 1 < merged.length) {
    const i = Math.floor(pos);
    const frac = pos - i;
    out.push(merged[i] * (1 - frac) + merged[i + 1] * frac);
    pos += step;
  }
  const consumed = Math.floor(pos);
  state.pending = merged.slice(consumed);
  state.readPos = pos - consumed;
  return Float32Array.from(out);
}

/**
 * 定长帧切分：把连续 PCM 切成 `frameSec` 长度的帧，并给出每帧的时间区间。
 *
 * 时间区间由**已产出样本数**算出（不是 wall clock）：它天然满足 S1/S2，
 * 而 wall clock 会因为回调抖动算出重叠或缝隙，那两样都会让 S2 失守。
 */
export function createFrameChunker(options = {}) {
  const sampleRate = options.sampleRate === undefined ? CAPTURE_WEB_AUDIO.sampleRate : options.sampleRate;
  const frameSec = options.frameSec === undefined ? CAPTURE_WEB_DEFAULT_FRAME_SEC : options.frameSec;
  const vadThreshold = options.vadThreshold === undefined ? CAPTURE_WEB_VAD_RMS : options.vadThreshold;
  const frameSamples = Math.round(sampleRate * frameSec);
  let pending = new Float32Array(0);
  let producedSamples = 0;

  const make = (samples) => {
    const startSec = producedSamples / sampleRate;
    const endSec = (producedSamples + samples.length) / sampleRate;
    producedSamples += samples.length;
    return { startSec, endSec, voiced: rmsOf(samples) >= vadThreshold, pcm: pcm16FromFloat32(samples) };
  };

  return {
    /** 已录时长（秒，含尚未凑成一帧的部分）—— 界面计时用它 */
    get elapsedSec() {
      return (producedSamples + pending.length) / sampleRate;
    },
    /** 送入一段 16 kHz PCM；返回本次凑满的帧（0 个或多个） */
    push(chunk) {
      const merged = new Float32Array(pending.length + chunk.length);
      merged.set(pending, 0);
      merged.set(chunk, pending.length);
      const frames = [];
      let offset = 0;
      while (merged.length - offset >= frameSamples) {
        frames.push(make(merged.subarray(offset, offset + frameSamples)));
        offset += frameSamples;
      }
      pending = merged.slice(offset);
      return frames;
    },
    /**
     * 收尾：把不足一帧的尾巴**也发出去**（低于一帧就不发等于丢掉最后一句话，
     * 而"少一句"是这条链上最糟的失败）。
     */
    flush() {
      if (pending.length === 0) return [];
      const tail = pending;
      pending = new Float32Array(0);
      return [make(tail)];
    },
  };
}

/* ============================== 真实麦克风采集源 ============================== */

function stopTracks(stream) {
  if (stream === null) return;
  try {
    for (const track of stream.getTracks()) track.stop();
  } catch {
    /* 停止本身不该失败：拆设备时的异常只会掩盖"停止失败"这件不该发生的事 */
  }
}

/**
 * 浏览器麦克风采集源：`getUserMedia` → Web Audio → 16 kHz 单声道 PCM 帧。
 *
 * 它是 `CaptureSource` 接口在浏览器里的那个实现（`src/dictation/capture-source.ts` 的槽位）：
 * `probe()` 只读、`start()` 只能由人调用、`stop()` 立刻兑现。**下面的编排一行不改**，
 * 与演示源（脚本音频）、本地客户端（Node 侧）走的是同一条下游：
 * 帧 → 分片 → 上传同源路由 → ASR → 建议。
 *
 * 宿主能力全部可注入（`env` / `getUserMedia` / `audioContextCtor`）：不自测就只能等一台真机，
 * 而"等真机"这件事的结果通常是这段代码再也没被验证过。
 */
export function createBrowserMicSource(options = {}) {
  const env = options.env === undefined ? readBrowserEnv() : options.env;
  const frameSec = options.frameSec === undefined ? CAPTURE_WEB_DEFAULT_FRAME_SEC : options.frameSec;
  const vadThreshold = options.vadThreshold === undefined ? CAPTURE_WEB_VAD_RMS : options.vadThreshold;
  const targetRate = CAPTURE_WEB_AUDIO.sampleRate;
  const getUserMediaFn = options.getUserMedia === undefined
    ? (env.hasGetUserMedia ? navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices) : null)
    : options.getUserMedia;
  const AudioCtor = options.audioContextCtor === undefined
    ? (typeof AudioContext !== 'undefined' ? AudioContext : (typeof webkitAudioContext !== 'undefined' ? webkitAudioContext : null))
    : options.audioContextCtor;
  /** 设备真的打开了（权限框已过）：界面据此把"正在请求权限"换成"正在采集" */
  const onAcquired = options.onAcquired === undefined ? () => {} : options.onAcquired;

  let stream = null;
  let ctx = null;
  let srcNode = null;
  let procNode = null;
  /** 定帧器与出帧回调要活到 `stop()`：收尾时得把不足一帧的尾巴交出去 */
  let chunkerRef = null;
  let onFrameRef = null;
  let running = false;
  let stopped = false;
  let resolveStart = null;

  const source = {
    id: CAPTURE_WEB_SOURCE_ID,
    probe() {
      return probeMicEnvironmentWeb(env, CAPTURE_WEB_SOURCE_ID);
    },
    async start(onFrame) {
      if (running) {
        throw new CaptureWebError('E_CAPTURE_SOURCE_UNKNOWN', '采集源已在运行（不重复打开设备）', '先按「停止」，再重新点「开始采集」');
      }
      const probe = source.probe();
      if (!probe.ok) throw new CaptureWebError(probe.code, probe.message, probe.howTo);
      if (getUserMediaFn === null) {
        throw new CaptureWebError('E_CAPTURE_UNSUPPORTED', '当前浏览器不支持录音（缺少 getUserMedia）', '换用 Chromium 系浏览器，或改用桌面客户端 / 现成的采集设备');
      }
      if (AudioCtor === null) {
        throw new CaptureWebError('E_CAPTURE_UNSUPPORTED', '当前浏览器缺少 Web Audio 能力（拿不到 PCM）', '换用 Chromium 系浏览器，或改用桌面客户端 / 现成的采集设备');
      }

      running = true;
      stopped = false;
      try {
        stream = await getUserMediaFn({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      } catch (err) {
        running = false;
        const problem = describeSourceFailureWeb(err);
        throw new CaptureWebError(problem.code, problem.message, problem.howTo);
      }
      if (stopped) {
        stopTracks(stream);
        stream = null;
        running = false;
        return;
      }

      ctx = new AudioCtor();
      srcNode = ctx.createMediaStreamSource(stream);
      procNode = typeof ctx.createScriptProcessor === 'function' ? ctx.createScriptProcessor(4096, 1, 1) : null;
      if (procNode === null) {
        try { await ctx.close(); } catch { /* 关不掉也不影响这次判断 */ }
        ctx = null;
        stopTracks(stream);
        stream = null;
        running = false;
        throw new CaptureWebError('E_CAPTURE_UNSUPPORTED', '当前浏览器缺少音频处理能力（拿不到 PCM）', '换用 Chromium 系浏览器，或改用桌面客户端 / 现成的采集设备');
      }

      const resampleState = { pending: new Float32Array(0), readPos: 0 };
      chunkerRef = createFrameChunker({ sampleRate: targetRate, frameSec, vadThreshold });
      onFrameRef = onFrame;
      procNode.onaudioprocess = (event) => {
        if (stopped || chunkerRef === null || onFrameRef === null) return;
        const input = event.inputBuffer.getChannelData(0);
        const at16k = resampleLinear(input, ctx.sampleRate, targetRate, resampleState);
        for (const frame of chunkerRef.push(at16k)) onFrameRef(frame);
      };
      srcNode.connect(procNode);
      /* ScriptProcessor 必须挂在输出链上才会被驱动；接一个 0 增益节点既驱动它、又不产生回声 */
      const sink = ctx.createGain();
      sink.gain.value = 0;
      procNode.connect(sink);
      sink.connect(ctx.destination);

      /* 设备被拔掉 / 被别处停用：采集自然结束（而不是留在"正在采集"上不动） */
      const track = stream.getAudioTracks()[0];
      if (track) track.onended = () => { void source.stop(); };

      onAcquired();

      return new Promise((resolve) => {
        resolveStart = resolve;
        if (stopped) {
          resolveStart = null;
          resolve();
        }
      });
    },
    /** 停止。**停止本身不该失败**：它被按停时抛错，只会让人以为出了别的问题 */
    async stop() {
      stopped = true;
      /* 收尾先于拆设备：把不足一帧的尾巴交出去（低于一帧就不发等于丢掉最后一句话，
         而"少一句"是这条链上最糟的失败）。它也让"按停不丢最后一句"可被断言。 */
      if (chunkerRef !== null && onFrameRef !== null) {
        const chunker = chunkerRef;
        const emit = onFrameRef;
        chunkerRef = null;
        onFrameRef = null;
        for (const frame of chunker.flush()) emit(frame);
      }
      if (procNode !== null) {
        try { procNode.onaudioprocess = null; } catch { /* 见上 */ }
        try { procNode.disconnect(); } catch { /* 见上 */ }
      }
      if (srcNode !== null) {
        try { srcNode.disconnect(); } catch { /* 见上 */ }
      }
      if (ctx !== null) {
        try { await ctx.close(); } catch { /* 见上 */ }
      }
      stopTracks(stream);
      stream = null;
      ctx = null;
      srcNode = null;
      procNode = null;
      chunkerRef = null;
      onFrameRef = null;
      running = false;
      const resolve = resolveStart;
      resolveStart = null;
      if (resolve) resolve();
    },
  };

  return source;
}
