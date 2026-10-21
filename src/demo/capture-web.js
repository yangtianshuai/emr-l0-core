export const CAPTURE_WEB_AUDIO = { sampleRate: 16000, channels: 1, bitsPerSample: 16 };

export const CAPTURE_WEB_SOURCE_ID = 'browser-mic';

/** 帧长（秒）：与演示源的默认一致，静音判停的粒度就是它 */
export const CAPTURE_WEB_DEFAULT_FRAME_SEC = 0.5;

export const CAPTURE_WEB_VAD_RMS = 0.01;

export class CaptureWebError extends Error {
  constructor(code, message, howTo) {
    super(message);
    this.name = 'CaptureWebError';
    this.code = code;
    this.howTo = howTo || '';
  }
}

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
  view.setUint16(20, 1, true);
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

export function readBrowserEnv() {
  const hasAudioContext = typeof AudioContext !== 'undefined' || typeof webkitAudioContext !== 'undefined';
  return {
    isSecureContext: typeof window !== 'undefined' && window.isSecureContext === true,
    hasGetUserMedia: !!(typeof navigator !== 'undefined' && navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
    hasAudioContext,
  };
}

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

const TIMELINE_EPS = 1e-9;

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
        start = carry === null ? event.startSec : carry;
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
    get elapsedSec() {
      return (producedSamples + pending.length) / sampleRate;
    },
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
    flush() {
      if (pending.length === 0) return [];
      const tail = pending;
      pending = new Float32Array(0);
      return [make(tail)];
    },
  };
}

function stopTracks(stream) {
  if (stream === null) return;
  try {
    for (const track of stream.getTracks()) track.stop();
  } catch {
  }
}

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
  const onAcquired = options.onAcquired === undefined ? () => {} : options.onAcquired;

  let stream = null;
  let ctx = null;
  let srcNode = null;
  let procNode = null;
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
        try { await ctx.close(); } catch { }
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
    async stop() {
      stopped = true;
      if (chunkerRef !== null && onFrameRef !== null) {
        const chunker = chunkerRef;
        const emit = onFrameRef;
        chunkerRef = null;
        onFrameRef = null;
        for (const frame of chunker.flush()) emit(frame);
      }
      if (procNode !== null) {
        try { procNode.onaudioprocess = null; } catch { }
        try { procNode.disconnect(); } catch { }
      }
      if (srcNode !== null) {
        try { srcNode.disconnect(); } catch { }
      }
      if (ctx !== null) {
        try { await ctx.close(); } catch { }
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
