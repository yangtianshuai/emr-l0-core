/**
 * 语音采集层（C1）：把"麦克风 → 一段段音频 → 带段号与时间区间的转写文本"收成三件**可离线验证**的纯逻辑。
 *
 * ## 它补的是 ASR 不给的那三样东西
 *
 * 院内 ASR 接口（`POST /api/audio/inference-realtime` + 轮询 `GET .../{task_id}`）在 `done` 时
 * **只回一个字符串**：没有时间戳、没有分段、没有置信度、没有模型信息。而 `dictate` 要的是
 * `{ index, startSec, endSec, text, confidence }`。逐项对账（`docs/L2-语音采集设计.md` 第一、三节）：
 *
 * | 要的 | 谁补 | 怎么补 |
 * |---|---|---|
 * | `index` / `startSec` / `endSec` | **本模块（唯一来源）** | 一次分片 = 一段 = 一次任务；时间以录音开始为 0 点累计 |
 * | `text` | ASR | `result` 原样（**空串是合法结果**，表示这段没听到内容，但要如实回报） |
 * | `confidence` | 本模块 | 接口不回 → 填 `confidenceCeiling`（<0.90），**不得自称 1.0 也不得留空** |
 * | `asrModelId` | 部署声明 | 接口不回模型信息，只能由部署方声明，且**必须带版本/日期** |
 * | `transcriptionId` | 采集会话 ID | **不用 `task_id`**：一次会话有 N 个任务，用它会把"一次录音"拆成 N 次 |
 *
 * ## 三条不可让步的规则
 *
 * 1) **采集层在内核之外**：它只产出 `TranscriptSegment[]`，`WriteSession.dictate` 一行都不改。
 *    整个模块可以换掉或拿掉，门控与留痕不受任何影响；
 * 2) **未知按最保守处理**：ASR 不回置信度，就填上限（恒 < 关键内容 0.90）——
 *    于是关键内容上照样必须"改后采纳"。**绝不因为"识别看起来成功了"就放宽**；
 * 3) **fail-closed**：端点未配置 → 采集入口不可用；该接口**没有失败态**（只有
 *    `pending/processing/done`），所以轮询必须有上限，超时即判该段失败。
 *    **绝不静默退回"模拟一段录音转写"** —— 那会让"已接入真实采集"变成一句假话。
 *
 * ## 为什么 transport 与临时文件存储都可注入
 *
 * 与 `src/dictation/external-placement.ts`、`src/ai/http-adapter.ts` 同一条理由：
 * 上传怎么构造、轮询怎么收口、失败怎么汇总，这三件最容易出错的事**必须能离线被测**。
 * 让自测去连真实 ASR、去开真实麦克风，等于让自测**偶尔失败**，而那种失败最终会被所有人忽略。
 *
 * ## 本文不做的事
 *
 * 不开麦克风（那是 C3 浏览器侧）、不写 HTTP 路由与配置文件（那是 C2）、不做流式实时上屏
 * （该接口是"整段文件 → 文本"，做流式等于换服务）、不做说话人分离、不默认留存音频。
 */

import type { ISODateTime } from '../model/types.ts';
import type { DictationInput, TranscriptSegment } from '../core/dictation.ts';
import { KEY_CONTENT_THRESHOLD } from './placement.ts';

/* ============================== 底座与厂商 ============================== */

/**
 * 错误、音频规格、传输、以及**厂商协议实现**都在下面两个模块里。这里**原样 re-export**：
 *
 * - `capture-transport.ts`：错误码 / `CaptureError` / `CAPTURE_AUDIO` / 传输形状与默认实现；
 * - `asr-adapters.ts`：三家协议（`intranet-task` / `baidu-rest` / `aliyun-nls`）、厂商声明表、公有云守卫。
 *
 * 为什么要拆（以及为什么 re-export 而不是让调用方改导入路径）见那两个文件头。
 * 一句话：厂商实现要用错误类型与音频规格常量，而 `CaptureError` 是**类**——
 * 留在本文件里就成了真正的循环依赖，不是"类型能被擦掉"那种假循环。
 */
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

/** 界面必须如实标注的一句：ASR 不回置信度，这里是"未知，且按最保守处理" */
export const ASR_NO_CONFIDENCE_NOTE = 'ASR 未提供置信度，按上限处理';

function writeAscii(target: Uint8Array, offset: number, text: string): void {
  for (let i = 0; i < text.length; i += 1) target[offset + i] = text.charCodeAt(i);
}

/**
 * WAV（PCM）头：44 字节，格式固定为 {@link CAPTURE_AUDIO}。
 *
 * 不做 MP3：浏览器端做 MP3 等于再引一个编码器，而 WAV 只是"给 PCM 加个头"。
 */
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
  view.setUint16(20, 1, true); /* 1 = PCM */
  view.setUint16(22, CAPTURE_AUDIO.channels, true);
  view.setUint32(24, CAPTURE_AUDIO.sampleRate, true);
  view.setUint32(28, CAPTURE_AUDIO.sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, CAPTURE_AUDIO.bitsPerSample, true);
  writeAscii(header, 36, 'data');
  view.setUint32(40, dataBytes, true);
  return header;
}

/**
 * 把 16-bit 小端 PCM 样本组装成可上传的 WAV。
 *
 * 校验字节数为偶数：16-bit 音频出现半字节，说明传进来的根本不是这个格式 ——
 * 与其让服务端收到一个坏文件后"识别出乱码"，不如在这里就报错。
 */
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

/** 解头（自测与排障用）：答得出"发出去的到底是不是 16k/单声道/16-bit" */
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

/* ============================== 配置 ============================== */

export interface AsrConfig {
  /**
   * 厂商 / 协议（见 `asr-adapters.ts` 的 `ASR_VENDORS`）。
   *
   * **默认值是院内服务**，这一条是刻意的：默认值决定"忘了配"会怎样，
   * 而"忘了配"绝不能等于"音频发去公网"。
   */
  kind: AsrKind;
  /** ASR 服务地址；**空 = 未配置** → 采集入口不可用（fail-closed） */
  endpoint: string;
  /**
   * 阿里云的 AppKey。它**不是密钥**（是"门牌号"），所以落在配置行里而不是密钥槽 ——
   * 混进密钥槽会让界面显示"密钥已就位"而实际一包也发不出去。
   */
  appKey: string;
  /** 上传超时（内网 15s 够；**外网/公有云必须上调** —— 百度那一次往返要 2~3s，公网抖动更要余量） */
  submitTimeoutMs: number;
  /**
   * 轮询间隔。**只对院内那台有意义**（`intranet-task` 是"提交 + 轮询"），
   * 两家公有云都是一次性请求 —— 这个值在它们身上不参与任何事，但界面上仍然要显示，
   * 因为"换回院内服务"时它就是主参数（藏起来会让人以为它消失了）。
   */
  pollIntervalMs: number;
  /** 单段总预算：**院内那台接口没有失败态，只能靠它收口**；公有云拿它当兜底 —— 哪一家都不允许"无限等" */
  pollTimeoutMs: number;
  /** 部署方声明的模型标识（三家都不返回模型信息），**必须带版本/日期** */
  modelId: string;
  /**
   * 显式确认"这份音频会发往院外"。
   *
   * 只有公有云 `kind` 需要它，且**必须为 true 才允许采集**（{@link assertPublicCloudAcknowledged}）。
   * 它不能被"一个更聪明的默认值"替代：语音里必然含患者信息，
   * 把音频发到院外公网这件事**只能由人显式的一次动作**来承担。
   */
  acknowledgePublicCloud: boolean;
  /* 这里曾有 `apiKeyEnv`（token 所在的**变量名**）。本轮取消：
     需要存储的东西一律入库 —— 密钥值单独一行加密落在 `config.capture.apiKey`，
     由 `capture-store.ts` 解出来直接交给 `createAsrClient` 的 `apiKey`，
     本结构里因此**没有**任何与凭据**值**有关的字段（它会被写进配置行、会被打印）。
     `appKey` 能落在配置行里，正是因为它是门牌号而不是凭证。 */
}

export interface SegmentConfig {
  /** 静音判停：一句话说完就发。**主路径** */
  silenceMs: number;
  /** 最长时长：长时间不静音（环境噪声、连续口述）不能把一段无限拖大 */
  maxSeconds: number;
  /** 最短时长：低于它按误触丢弃，不上传（麦克风刚打开那串噪声不该产生一个任务） */
  minSeconds: number;
}

export interface CaptureConfig {
  asr: AsrConfig;
  segment: SegmentConfig;
  /** 是否留存音频；**默认 false**（录音必然含患者信息，进 PHI 扫描范围是另一整套工作） */
  retainAudio: boolean;
  /** 未提供置信度时的填充值；**必须 < 关键内容阈值 0.90** */
  confidenceCeiling: number;
}

export const DEFAULT_CAPTURE_CONFIG: CaptureConfig = {
  asr: {
    /* 默认院内服务：见 `AsrConfig.kind` 那段 —— 默认值决定"忘了配"会怎样 */
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
/* `CAPTURE_MAX_ATTEMPTS`（重试上限）已下沉到 `capture-transport.ts`，见文件中部 re-export */

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

/**
 * 配置的**补丁形状**：允许逐组给部分字段（界面按组保存、环境变量只给一两项），
 * 未给出的项才取默认 —— **给出了但不合法的一律报错**，不做"帮你改成默认值"。
 *
 * 刻意不叫 `CaptureConfigInput`：那是**存储层**（`capture-store.ts`）用的、给界面提交的
 * **扁平**形状。两个不同形状的同名类型放在两个模块里，是排查时最费时间的坑之一。
 */
export interface CaptureConfigPatch {
  asr?: Partial<AsrConfig>;
  segment?: Partial<SegmentConfig>;
  retainAudio?: boolean;
  confidenceCeiling?: number;
}

/**
 * 校验配置。**非法值一律报错，不静默取默认** ——
 * "帮你改成默认值"会让运维以为自己配的东西生效了（同 `placement.ts` / `ai/model-config.ts` 同一个病根）。
 *
 * `endpoint` / `modelId` 允许为空：那是**尚未配置**这一合法状态（界面据此显示"未配置语音识别服务"，
 * 并由 {@link createAsrClient} 在真要转写时 fail-closed）。
 */
export function validateCaptureConfig(input: CaptureConfigPatch = {}): CaptureConfig {
  const asrInput = input.asr ?? {};
  const segmentInput = input.segment ?? {};

  /* `kind` 从**外部输入**来（库里的那一行、旧配置文件导入、HTTP body），
     所以即使类型上写着 `AsrKind` 也要在运行时核一遍 —— 库里存着上一版没有的名字时，
     静默取默认会让"我配的那家"悄悄变成院内服务（方向反了：那是**音频发去哪**的变更）。 */
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
  /* 公有云守卫在**校验层**也拦一次（不只在转写时拦）：保存时就拒绝，
     才不会出现"库里存着一条配了公有云却没确认的配置"，让人以为它配好了。 */
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
  /* G3：留痕要回答"哪个模型听写的"，而该接口不返回模型信息 ——
     一个不带版本/日期的标识答不出这个问题（换模型后旧留痕会指向新模型）。 */
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

/* ============================== 分片（时间区间是采集端唯一来源） ============================== */

export type SegmentEndReason = 'silence' | 'maxSeconds' | 'pause' | 'manual-stop';

export interface ChunkPlan {
  /** 段号，从 1 起、与时间同序（**这里不做重排**：重排是 `normalizeSegments` 的职责，两处都排会让"乱序段数如实上报"这个数失去意义） */
  index: number;
  startSec: number;
  endSec: number;
  seconds: number;
  /** 为何在此定稿 —— 界面与排障要能回答"为什么切在这" */
  reason: SegmentEndReason;
}

/**
 * 采集事件流。三件事都由**采集端**给出，而不是在事后补：
 * 帧（含人声判定）、暂停、停止。
 */
export type CaptureInput =
  | {
      kind: 'frame';
      startSec: number;
      endSec: number;
      voiced: boolean;
    }
  /** 暂停：定稿当前分片。**暂停期不存在音频，故允许出现真实间隙**（S2 约束的是连续录音内的相邻分片） */
  | { kind: 'pause'; atSec: number }
  /** 手动停止 / 录音结束：定稿当前分片（S1：时间轴**不重置**起点） */
  | { kind: 'stop'; atSec: number };

export interface PlanResult {
  chunks: ChunkPlan[];
  /** 短于 `minSeconds` 被丢弃的片数 —— **如实上报，不静默**（否则"我说的话被吞了"无从解释） */
  droppedShort: number;
}

/**
 * 分片器（**流式**）：`planChunks()` 与真实采集共用这一份实现。
 *
 * 为什么必须有流式入口：真实采集是"边说边切"—— 静音判停是主路径，一句话说完就该发出去，
 * 而不是录完十分钟再一次性切。批处理入口 `planChunks()` 只是它的一个用法（喂完再取结果）；
 * 若各写一套，两者迟早会在边界条件上长出两套行为，而**分片规则同时决定建议条数与时间区间**，
 * 两套行为意味着"同一段录音在演示里切得对、在真机上切得不对"。
 *
 * 四条语义（`docs/L2-语音采集设计.md` 第四节，逐条不可让步）：
 *   - **S1** 时间区间以录音开始为 0 点累计，暂停恢复不重置起点（一旦重置，"何时说的"全错，
 *     而它是留痕里**唯一不可事后补**的字段）；
 *   - **S2** 相邻分片首尾相接、不重叠不留缝（`end_i === start_{i+1}`）：有缝意味着"那段时间
 *     说的话不属于任何段"且看不出来；重叠则同一句话进两条建议，医生会以为 ASR 重复了；
 *   - **S3** 段号从 1 起、与时间同序，**这里不做重排**；
 *   - **S4** 短于 `minSeconds` 的片按误触丢弃，但**必须计数**。
 *
 * 分片边界取"定稿时刻"而不是"最后一个有人声的帧"：那样留下的静音会不属于任何一段，
 * 正好违反 S2。代价是分片窗口可能带上一点首尾静音 —— 这是刻意的取舍（第九节诚实边界）。
 */
export interface ChunkPlanner {
  /** 送入一个事件；返回**本次定稿**的分片（0 个或多个） */
  feed(event: CaptureInput): ChunkPlan[];
  /** 当前是否有尚未定稿的分片（界面"正在录的这一段"用它） */
  readonly open: boolean;
  /** 当前那一段的起点（秒）；没有正在录的段时为 `null` —— 界面据此算"这一段已录多久" */
  readonly openStartSec: number | null;
  /** 已被丢弃的过短片数（S4：如实上报，不静默） */
  readonly droppedShort: number;
}

export function createChunkPlanner(config: SegmentConfig): ChunkPlanner {
  let droppedShort = 0;
  let nextIndex = 1;
  let start: number | null = null;
  /** 上一分片的结束点：下一个分片从它开始，才谈得上"首尾相接" */
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
        start = carry ?? event.startSec;
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

/* ------------------------------ 帧 → 段（含 WAV）：只此一处 ------------------------------ */

/** 浮点比较的容差：段边界由帧边界推出，理论上严格相等，留一点点余量免得被浮点尾数咬到 */
const TIMELINE_EPS = 1e-9;

/**
 * 一帧音频。时间由**采集源**给出（S1：暂停恢复不重置起点）。
 *
 * 定义在这一层而不是采集源那一层：它是"帧 → 段"流水线上的通行形状 ——
 * 服务端编排（`runDictationCapture`）、本地客户端桥（`capture-bridge`）、自测都用它。
 */
export interface CaptureFrame {
  startSec: number;
  endSec: number;
  voiced: boolean;
  /** 16-bit 小端 PCM（单声道）；转成 WAV 头由 `encodeCaptureWav` 负责 */
  pcm: Uint8Array;
}

export interface AssembledChunk {
  plan: ChunkPlan;
  /** 该段对应的 WAV 字节（16k / 单声道 / 16-bit） */
  audio: Uint8Array;
}

export interface ChunkAssembler {
  feed(frame: CaptureFrame): AssembledChunk[];
  /** 采集结束（手动停止 / 时间线走完）：定稿当前那一段 */
  finish(atSec: number): AssembledChunk[];
  readonly openStartSec: number | null;
  readonly droppedShort: number;
}

/**
 * 把帧流拼成段（含该段的 WAV）。
 *
 * **只有这一处**：服务端的演示采集与本地客户端都用它。若各写一遍，
 * "每段上传的音频只含该段区间内的帧"这条（`AU23` 守着的）就守不住了 ——
 * 多带一帧就是把上一段的话又送了一次。
 */
export function createChunkAssembler(config: SegmentConfig): ChunkAssembler {
  const planner = createChunkPlanner(config);
  const frames: CaptureFrame[] = [];

  const take = (plan: ChunkPlan): AssembledChunk => {
    /* 属于这一片的帧：先丢掉落在片起点之前的（含被过短丢弃的那一片的残留），再取到片终点为止 */
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

/** 批处理入口：把一串事件喂给 {@link createChunkPlanner} 再取结果（语义与流式完全同一份实现） */
export function planChunks(events: CaptureInput[], config: SegmentConfig): PlanResult {
  const planner = createChunkPlanner(config);
  const chunks: ChunkPlan[] = [];
  for (const event of events) chunks.push(...planner.feed(event));
  return { chunks, droppedShort: planner.droppedShort };
}

/* ============================== ASR 调用（上传 + 轮询） ============================== */

export interface AsrDeps {
  transport?: CaptureTransport;
  /** 睡眠（轮询间隔）；自测注入假实现，不真的等。**云厂商用不到它**（没有轮询） */
  sleep?: (ms: number) => Promise<void>;
  /** 时钟；自测注入假时钟，好让"超时"与"token 到期"都可复现 */
  now?: () => number;
  /**
   * 主凭据**直接给出**（由调用方从库里的 `config.capture.apiKey` 解出来）：
   * 院内服务的 Bearer token / 百度 AK / 阿里云 NLS token。
   * 它不落在 `AsrConfig` 里，也不进日志：只在协议实现里用一次。
   */
  apiKey?: string;
  /** 次凭据（只有百度用得着：Secret Key）。落库位置与主凭据分开，理由见 `capture-store.ts` */
  apiSecret?: string;
}

export interface AsrClient {
  /**
   * 提交一段音频并等出文本；空串是**合法**结果（这段没听到内容）。
   *
   * 入参只要"段号 + 音频 + 会话"，**不要整个 `ChunkPlan`**：服务端转发（C2）只需要段号来命名文件，
   * 时间区间是采集端的事，服务端手里根本没有它 —— 要它就得编一个出来，那是在伪造证据。
   */
  transcribe(request: { index: number; audio: Uint8Array; sessionId: string }): Promise<{ text: string; taskId: string }>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** `parseJsonObject` 也已下沉到 `capture-transport.ts`（三家协议都要用它解析响应） */

/**
 * 生成 ASR 客户端：**fail-closed、超时收口、重试纪律只在这一处**，厂商差异全部交给
 * `asr-adapters.ts` 的协议实现。
 *
 * 这个接口上最需要点出来的一件事（对院内那台成立）：**状态集合只有 `pending / processing / done`，
 * 没有失败态。** 于是"识别失败"和"服务没处理完"长得一模一样（都是一直 `processing`），
 * 所以 `pollTimeoutMs` 不是"给一个准确的超时"，而是**给一个终止条件** ——
 * 没有它，一次服务端卡死会让界面永远停在"转写中"，而医生会一直等一个永远不会来的结果。
 * 云厂商是一次性请求（没有轮询），但同一份预算照样兜底：**哪一家都不允许"无限等"**。
 */
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
      /* 顺序要紧：**先判"能不能发"，再判"允不允许发"，最后判"发得出去吗"** ——
         三件事的处置完全不同（去填地址 / 去勾确认 / 去补凭据）。若顺序反过来，
         "还没填地址"会被报成"没确认公有云"，把人引到一个已经填好的格子上。 */
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


/* ============================== 组装 ============================== */

export interface CaptureChunk {
  index: number;
  startSec: number;
  endSec: number;
  /** ASR 的 result 原样 */
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
  /** 采集会话 ID —— 一次"说一段" = 一个会话；**不是 `task_id`**（一次会话有 N 个任务） */
  sessionId: string;
  asrModelId: string;
  chunks: CaptureChunk[];
  /** 失败的分片**如实回报**，绝不当成"什么都没说" */
  failures: CaptureFailure[];
  /** `result` 为空串而被丢弃的段数（合法结果，但要如实回报） */
  emptyDropped: number;
  /** 短于 `minSeconds` 被丢弃的片数 */
  shortDropped: number;
  audioRetained: boolean;
  warnings: string[];
}

export type ChunkOutcome =
  | { status: 'ok'; chunk: CaptureChunk }
  | { status: 'empty'; index: number; startSec: number; endSec: number }
  | { status: 'failed'; failure: CaptureFailure };

/** 临时音频存储（真实实现落运行时目录；`retainAudio=false` 时用它删干净） */
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
  /** 逐段回显：界面要能显示"转写中 3 段 / 已完成 1 段"，不等全部完成 */
  onChunk?: (outcome: ChunkOutcome) => void;
}

/**
 * 走完一次采集：分片 → 逐段转写 → 组装。
 *
 * 逐段**串行**提交（并发留给 C2 的服务端决定）：串行让失败归属与时间区间都只有一种解释，
 * 而"多段并行"在这里换来的那点延迟收益，远不及一次难复现的错位代价。
 *
 * 两条纪律：
 *   - **某段失败不阻塞其余段**，但失败段数必须如实回报；
 *   - **音频清理走 finally**：成功、失败、以及非预期的程序错误三条路径都删得掉 ——
 *     "不留存"如果只在成功路径成立，那就不是"不留存"。
 */
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
        /* 非 `CaptureError` = 程序错误（不是"这段没转出来"）：清理后继续抛，不吞 */
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

/**
 * 采集结果 → `dictate` 的入参。**中间不加新结构**，两处"人为决定"都已论证过：
 *   - `transcriptionId = sessionId` → `evidence.ref` 形如 `session#3@9.1-12.4s`，
 *     可回到音频（若留存）或至少定位到"第几段第几秒"（不留存时）；
 *   - `confidence = confidenceCeiling`（未知）→ 恒 < 0.90，关键内容上照样必须"改后采纳"。
 *
 * 失败段**不进入** `segments`：`dictate` 不认识"失败"这个概念，硬塞一条空文本只会
 * 变成"这条建议本来就是空的"。失败由调用方在外部处置（界面提示 + 审计）。
 */
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

/* ============================== 提交（采集端 → 服务端） ============================== */

/**
 * 采集端提交上来的一个转写段。**形状即 `CaptureChunk`，但它是外部输入** ——
 * 服务端只校验，不代编：段号与时间区间是采集端的产物，补一个出来就是伪造证据。
 */
export interface SubmittedSegment {
  index: number;
  text: string;
  startSec: number;
  endSec: number;
}

/**
 * 校验采集端提交的转写段，并**统一填上置信度上限**。
 *
 * 逐条理由：
 *   - **不接受 `confidence`**：置信度是产出方的判断，让它由请求指定，等于把"这条内容有多可信"
 *     交给不产出内容的一方 —— 那正是既有纪律（"门控档位不由调用方决定"）要挡住的那类口子。
 *     而且这份 ASR **根本不回置信度**，所以"未知 → 按上限处理"是唯一自洽的填法。
 *     **出现该字段一律报错，而不是忽略**：静默忽略会让调用方以为它生效了。
 *   - **段号唯一**：同一个段号出现两次 = 一次录音被拆成两条，时间区间还重叠 ——
 *     医生会以为 ASR 重复了某句，而留痕里的 `#3` 指向哪一条也说不清。
 *   - **区间必须正长度**：`endSec > startSec`。零长度的时间区间是一条无法核对的证据。
 *   - **不要求段号与时间同序**：乱序由 `normalizeSegments` 统一处理并**如实回报**（S3）。
 *     在这里顺手排序，会让"乱序段数"这个数失去意义。
 *   - **空文本段允许**：空串是合法结果（这段没听到内容），由内核丢弃并计入上报。
 */
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

