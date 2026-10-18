// ASR 厂商适配层：把三家形状完全不同的协议收成同一个"一段音频 → 文本"语义。

import {
  CAPTURE_AUDIO,
  CAPTURE_MAX_ATTEMPTS,
  CaptureError,
  parseJsonObject,
  type CaptureTransportRequest,
  type CaptureTransportResponse,
} from './capture-transport.ts';
import type { AsrConfig } from './capture.ts';

/**
 * 三家的枚举。定义在这里而不是 `capture.ts`：谁提供协议，谁定义自己的名字 ——
 * 这样依赖是单向的（`capture.ts → asr-adapters.ts`），不靠"类型能被擦掉"来绕开循环。
  */
export type AsrKind = 'intranet-task' | 'baidu-rest' | 'aliyun-nls';

/**
 * 一家的"外部事实"：地址示例、凭据形态、是否出院、协议一句话。
 *
 * 界面只从这张表渲染，不在 HTML 里各写一份：三家要显示的东西不一样
 * （凭据几格、警告要不要出现、地址预填什么），散着写就会出现"换了协议但界面没跟着变"。
  */
export interface AsrVendorSpec {
  kind: AsrKind;
  label: string;
  /** 音频是否离开院内网络：true → 必须显式确认，且界面/审计必须红标 */
  leavesIntranet: boolean;
  /** 凭据形态：界面据此决定显示几格、哪些必填；服务端据此判"凭据配全了没有" */
  credentials: 'none-or-token' | 'access-key-pair' | 'nls-token-and-appkey';
  /** 界面预填的地址（可改）。空串 = 必须自己填（院内服务的地址只有部署方知道）  */
  defaultEndpoint: string;
  /** 模型标识的填写示例：三家都不回模型信息，只能由部署方声明 */
  modelIdHint: string;
  /** 协议一句话 */
  protocol: string;
  /** 这套协议下"分片与超时"的实际作用 —— 如实说明，不假装三家一样 */
  timingNote: string;
}

export const ASR_VENDORS: Record<AsrKind, AsrVendorSpec> = {
  'intranet-task': {
    kind: 'intranet-task',
    label: '院内语音识别服务（默认）',
    leavesIntranet: false,
    credentials: 'none-or-token',
    defaultEndpoint: '',
    modelIdHint: 'local/asr-zh-med:0.9@2026-09',
    /* 这句话会原样显示在管理后台（随 state 下发）。所以它不能带 `task_id` 这种协议字段名：
       前端一旦出现它，后来的人就会顺手在页面里写轮询 —— 而轮询是服务端的事（见设计文档第二节）。  */
    protocol: 'multipart 提交（字段 audio）→ 拿任务号 → 服务端内部轮询到完成',
    timingNote: '轮询间隔与单段预算是主参数：该接口没有失败态，超时是唯一的终止条件',
  },
  'baidu-rest': {
    kind: 'baidu-rest',
    label: '百度短语音识别（公有云，测试用）',
    leavesIntranet: true,
    credentials: 'access-key-pair',
    defaultEndpoint: 'https://vop.baidu.com/server_api',
    modelIdHint: 'baidu/short-speech:standard@2026-10（照你的应用实际型号声明）',
    protocol: 'AK/SK 换 access_token（缓存 30 天）→ 一句话 JSON（音频 base64）→ err_no=0',
    timingNote: '一次性请求：没有轮询，轮询间隔不参与；单段预算仍作为兜底终止条件',
  },
  'aliyun-nls': {
    kind: 'aliyun-nls',
    label: '阿里云智能语音交互（公有云，测试用）',
    leavesIntranet: true,
    credentials: 'nls-token-and-appkey',
    defaultEndpoint: 'https://nls-gateway-cn-shanghai.aliyuncs.com/stream/v1/asr',
    modelIdHint: 'aliyun/nls:一句话识别@2026-10',
    protocol: '裸音频字节 + X-NLS-Token → status=20000000（token 需自己获取，24h 过期）',
    timingNote: '一次性请求：没有轮询；单段预算仍作为兜底终止条件',
  },
};

export const ASR_KINDS = Object.keys(ASR_VENDORS) as AsrKind[];

export function isAsrKind(value: unknown): value is AsrKind {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(ASR_VENDORS, value);
}

export function vendorOf(kind: AsrKind): AsrVendorSpec {
  return ASR_VENDORS[kind];
}

/**
 * 凭据（内存里过一次，不进配置行、不进日志、不回显）。
 *
 * 两个槽而不是三个：`apiKey` 是主凭据（院内 token / 百度 AK / 阿里云 NLS token），
 * `apiSecret` 只有百度用得着（SK）。阿里云的 AppKey 不是密钥，落在配置里（`asr.appKey`）——
 * 它跟地址一样是"门牌号"，不是凭证；混进密钥槽会让界面显示"密钥已就位"而实际发不出去。
  */
export interface AsrCredentials {
  apiKey?: string;
  apiSecret?: string;
}

/**
 * 凭据缺哪些（只返回缺口名，不返回任何值）：界面据此禁用入口并说明缺哪一格。
 *
 * 这个"按位判空"的版本是给存储层用的：它手上只有 `apiKeyPresent` 这类布尔，
 * 不该为了判个"缺不缺"把密钥值再多传一处（多传一处就多一处可能被打印的地方）。
 * 带值的版本 {@link missingCredentials} 只是它的一层包装 —— 缺口名只有一份定义。
  */
export function missingCredentialSlots(
  spec: AsrVendorSpec,
  present: { apiKey: boolean; apiSecret: boolean },
  appKey: string,
): string[] {
  switch (spec.credentials) {
    case 'none-or-token':
      return [];
    case 'access-key-pair':
      return [...(present.apiKey ? [] : ['Access Key']), ...(present.apiSecret ? [] : ['Secret Key'])];
    case 'nls-token-and-appkey':
      return [...(present.apiKey ? [] : ['Token']), ...(appKey.trim() === '' ? ['AppKey'] : [])];
    /* 穷尽性检查：新增一种凭据形态而忘了在这里判缺口，会静默变成"永远配得全" */
    default: {
      const never: never = spec.credentials;
      throw new CaptureError('E_CAPTURE_CONFIG_INVALID', `不认识的凭据形态：${String(never)}`);
    }
  }
}

export function missingCredentials(spec: AsrVendorSpec, credentials: AsrCredentials, appKey: string): string[] {
  const has = (value: string | undefined): boolean => typeof value === 'string' && value.trim() !== '';
  return missingCredentialSlots(spec, { apiKey: has(credentials.apiKey), apiSecret: has(credentials.apiSecret) }, appKey);
}

/**
 * 公有云守卫：没显式确认就拒绝，且必须在发出任何请求之前拒绝。
 *
 * "拒绝"而不是"降级回院内"：降级会让管理员以为自己配的云地址生效了（同 `placement.ts`
 * 那条"不许静默退回模拟转写"）。地址填错、音频发错地方，是这一层唯一不能容忍的事。
  */
export function assertPublicCloudAcknowledged(spec: AsrVendorSpec, acknowledged: boolean): void {
  if (!spec.leavesIntranet || acknowledged) return;
  throw new CaptureError(
    'E_CAPTURE_CLOUD_NOT_ACKNOWLEDGED',
    `已选择公有云（${spec.label}），但未确认"音频会发往院外"：拒绝采集。` +
      '语音里必然含患者信息，把这份音频发到院外公网需要**显式的一次确认**，不能由默认值代劳',
  );
}

/** 提交音频的 multipart 字段名（院内服务的文档写死，不做成配置项 —— 它只有一个正确值） */
export const CAPTURE_AUDIO_FIELD = 'audio';
/** 院内服务的提交与轮询路径（同一段前缀，只有 `task_id` 部分不同） */
export const CAPTURE_SUBMIT_PATH = '/api/audio/inference-realtime';

export interface AsrTranscribeRequest {
  index: number;
  audio: Uint8Array;
  sessionId: string;
}

export interface AsrTranscribeResult {
  /** 文本；空串是合法结果（这段没听到内容），但要如实回报  */
  text: string;
  /** 厂商的任务号。云厂商没有 → 空串（`transcriptionId` 用的是会话 ID，不是它）  */
  taskId: string;
}

export interface AsrProtocolContext {
  config: AsrConfig;
  credentials: AsrCredentials;
  /** 带超时的一次调用（超时由调用方按剩余预算收口） */
  call: (request: CaptureTransportRequest, timeoutMs: number) => Promise<CaptureTransportResponse>;
  /** 距"单段总预算"还剩多少 ms */
  remaining: () => number;
  /** 预算耗尽时抛的错（内网那台没有失败态，这是唯一可判形态） */
  timeoutError: () => CaptureError;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export type AsrProtocol = (request: AsrTranscribeRequest, context: AsrProtocolContext) => Promise<AsrTranscribeResult>;

function retryableHttp(code: string, message: string, retryable = true): CaptureError {
  return new CaptureError('E_CAPTURE_HTTP_STATUS', message, retryable);
}

function requireText(value: unknown, what: string): string {
  if (typeof value !== 'string') {
    throw new CaptureError(
      'E_CAPTURE_BAD_RESPONSE',
      `${what}：不把"没有产出"当成"这段没有说话内容"（空结果是空串，不是缺失）`,
    );
  }
  return value;
}

const intranetTask: AsrProtocol = async ({ index, audio, sessionId }, ctx) => {
  const { config } = ctx;
  const apiKey = ctx.credentials.apiKey?.trim();
  const headers: Record<string, string> = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  const url = `${config.endpoint}${CAPTURE_SUBMIT_PATH}`;

  /* ---- 上传：只重试传输层故障；`code !== 200` 是"调用方给错了"，重试只会错第二遍 ----  */
  let taskId = '';
  for (let attempt = 1; attempt <= CAPTURE_MAX_ATTEMPTS && taskId === ''; attempt += 1) {
    const budget = ctx.remaining();
    if (budget <= 0) throw ctx.timeoutError();
    try {
      const response = await ctx.call(
        {
          method: 'POST',
          url,
          headers,
          audio: { field: CAPTURE_AUDIO_FIELD, filename: `${sessionId}#${index}.wav`, bytes: audio },
        },
        Math.min(config.submitTimeoutMs, budget),
      );
      if (response.status < 200 || response.status >= 300) {
        throw retryableHttp('E_CAPTURE_HTTP_STATUS', `语音识别服务返回 ${response.status}（响应体未记录）`);
      }
      const parsed = parseJsonObject(response.body, '语音识别服务');
      if (Number(parsed.code) !== 200) {
        throw new CaptureError(
          'E_CAPTURE_SUBMIT_FAILED',
          `语音识别服务拒绝本次提交（code=${JSON.stringify(parsed.code)}）：这是调用方的错，不重试`,
        );
      }
      const rawTaskId = parsed.task_id;
      if (typeof rawTaskId !== 'string' || rawTaskId.trim() === '') {
        throw new CaptureError(
          'E_CAPTURE_SUBMIT_FAILED',
          '语音识别服务回了 code=200 却没有 task_id：不得当成提交成功（否则会去轮询一个不存在的任务）',
        );
      }
      taskId = rawTaskId.trim();
    } catch (err) {
      if (err instanceof CaptureError && !err.retryable) throw err;
      if (ctx.remaining() <= 0) throw ctx.timeoutError();
      if (attempt >= CAPTURE_MAX_ATTEMPTS) {
        if (err instanceof CaptureError) throw err;
        throw retryableHttp('E_CAPTURE_HTTP_STATUS', `上传失败：${(err as Error).message}（响应体未记录）`);
      }
    }
  }

  let pollFailures = 0;
  for (;;) {
    const budget = ctx.remaining();
    if (budget <= 0) throw ctx.timeoutError();
    let response: CaptureTransportResponse;
    try {
      response = await ctx.call(
        { method: 'GET', url: `${url}/${encodeURIComponent(taskId)}`, headers },
        Math.min(config.submitTimeoutMs, budget),
      );
    } catch (err) {
      if (err instanceof CaptureError && !err.retryable) throw err;
      pollFailures += 1;
      if (pollFailures > CAPTURE_MAX_ATTEMPTS - 1) {
        throw retryableHttp('E_CAPTURE_HTTP_STATUS', `轮询失败：${(err as Error).message}（响应体未记录）`);
      }
      await ctx.sleep(config.pollIntervalMs);
      continue;
    }
    if (response.status < 200 || response.status >= 300) {
      pollFailures += 1;
      if (pollFailures > CAPTURE_MAX_ATTEMPTS - 1) {
        throw retryableHttp('E_CAPTURE_HTTP_STATUS', `轮询返回 ${response.status}（重试已耗尽，响应体未记录）`);
      }
      await ctx.sleep(config.pollIntervalMs);
      continue;
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = parseJsonObject(response.body, '语音识别服务');
    } catch (err) {
      /* 网关抖一下回一张 HTML 错误页是常见的：算一次可重试的传输问题，而不是"这段白说了" */
      pollFailures += 1;
      if (pollFailures > CAPTURE_MAX_ATTEMPTS - 1) throw err;
      await ctx.sleep(config.pollIntervalMs);
      continue;
    }

    const status = parsed.status;
    if (status === 'done') {
      return { text: requireText(parsed.result, 'status=done 但 result 不是字符串'), taskId };
    }
    if (status !== 'pending' && status !== 'processing') {
      throw new CaptureError(
        'E_CAPTURE_BAD_RESPONSE',
        `语音识别服务返回了未知 status=${JSON.stringify(status)}（文档只约定 pending / processing / done）：不无限等`,
      );
    }
    await ctx.sleep(config.pollIntervalMs);
  }
};

const BAIDU_OAUTH = 'https://aip.baidubce.com/oauth/2.0/token';
const BAIDU_EMPTY = 3302;
const BAIDU_BAD_AUDIO = 3301;
const BAIDU_TOKEN_INVALID = [110, 111];

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

export function clearAsrTokenCache(): void {
  tokenCache.clear();
}

async function baiduToken(ctx: AsrProtocolContext): Promise<string> {
  const ak = ctx.credentials.apiKey?.trim() ?? '';
  const sk = ctx.credentials.apiSecret?.trim() ?? '';
  const cacheKey = `baidu|${ctx.config.endpoint}|${ak}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > ctx.now()) return cached.token;

  const url = `${BAIDU_OAUTH}?grant_type=client_credentials&client_id=${encodeURIComponent(ak)}&client_secret=${encodeURIComponent(sk)}`;
  const budget = ctx.remaining();
  if (budget <= 0) throw ctx.timeoutError();
  const response = await ctx.call({ method: 'GET', url, headers: {} }, Math.min(ctx.config.submitTimeoutMs, budget));
  if (response.status < 200 || response.status >= 300) {
    throw retryableHttp('E_CAPTURE_HTTP_STATUS', `换取百度访问令牌失败：HTTP ${response.status}（响应体未记录）`);
  }
  const parsed = parseJsonObject(response.body, '百度鉴权服务');
  const token = parsed.access_token;
  if (typeof token !== 'string' || token.trim() === '') {
    /* 百度把鉴权失败也回 HTTP 200，错误在 error / error_description 里。
       不点出来，现场看到的就是"HTTP 200 却没有 token"这种没有方向的报错。 */
    throw new CaptureError(
      'E_CAPTURE_CREDENTIAL_MISSING',
      `百度未返回 access_token（${String(parsed.error ?? '未知原因')}）：核对 AK/SK，以及该应用是否开通了短语音识别`,
    );
  }
  const expiresIn = Number(parsed.expires_in);
  /* 提前 60s 到期（时钟漂移 + 请求往返），拿不到 expires_in 就只信 1 分钟 */
  const ttlMs = Number.isFinite(expiresIn) && expiresIn > 120 ? (expiresIn - 60) * 1000 : 60_000;
  tokenCache.set(cacheKey, { token: token.trim(), expiresAt: ctx.now() + ttlMs });
  return token.trim();
}

const baiduRest: AsrProtocol = async ({ audio, sessionId }, ctx) => {
  const token = await baiduToken(ctx);
  const budget = ctx.remaining();
  if (budget <= 0) throw ctx.timeoutError();

  /* `format/rate/channel` 必须是音频真实规格，写错不会报错，只会悄悄识别率变差 ——
     所以它取自 CAPTURE_AUDIO（采集端唯一产出规格），不是另写一份字面量。  */
  const body = JSON.stringify({
    format: CAPTURE_AUDIO.container,
    rate: CAPTURE_AUDIO.sampleRate,
    channel: CAPTURE_AUDIO.channels,
    cuid: `l0-emr-${sessionId}`.slice(0, 60),
    token,
    len: audio.byteLength,
    speech: Buffer.from(audio).toString('base64'),
  });
  const response = await ctx.call(
    {
      method: 'POST',
      url: ctx.config.endpoint,
      headers: { 'Content-Type': 'application/json' },
      raw: { contentType: 'application/json', body },
    },
    Math.min(ctx.config.submitTimeoutMs, budget),
  );
  if (response.status < 200 || response.status >= 300) {
    throw retryableHttp('E_CAPTURE_HTTP_STATUS', `百度语音识别返回 ${response.status}（响应体未记录）`);
  }
  const parsed = parseJsonObject(response.body, '百度语音识别服务');
  const errNo = Number(parsed.err_no);
  if (errNo === BAIDU_EMPTY) return { text: '', taskId: '' };
  if (BAIDU_TOKEN_INVALID.includes(errNo)) {
    /* token 失效：清缓存，让下一次采集重新换。本次仍旧失败 ——
       "悄悄重试一次"会让"凭据不对"表现成"偶尔成功"，那是最难查的一类现场。  */
    clearAsrTokenCache();
    throw new CaptureError('E_CAPTURE_CREDENTIAL_MISSING', `百度判定访问令牌无效（err_no=${errNo}）：AK/SK 或应用授权有问题，本次已清掉缓存令牌`);
  }
  if (errNo !== 0) {
    throw new CaptureError(
      'E_CAPTURE_SUBMIT_FAILED',
      `百度拒绝本次识别（err_no=${errNo}${errNo === BAIDU_BAD_AUDIO ? '：音频质量差' : ''}）：` +
        '这段**没转成**，不会当成"这段没说话"',
    );
  }
  const result = parsed.result;
  if (!Array.isArray(result)) {
    throw new CaptureError('E_CAPTURE_BAD_RESPONSE', '百度回了 err_no=0 但 result 不是数组（响应体未记录）');
  }
  return { text: result.map((item) => (typeof item === 'string' ? item : '')).join(''), taskId: '' };
};

/** 阿里云返回码（照其公开文档写，未对真实服务核过）：成功 20000000；40000001 无有效语音；40000004 静音超时  */
const ALIYUN_OK = 20_000_000;
const ALIYUN_EMPTY_CODES = [4_000_000_1, 4_000_000_4, 4_000_000_3];

const aliyunNls: AsrProtocol = async ({ audio }, ctx) => {
  const token = ctx.credentials.apiKey?.trim() ?? '';
  const appKey = ctx.config.appKey.trim();
  const budget = ctx.remaining();
  if (budget <= 0) throw ctx.timeoutError();

  const query = new URLSearchParams({
    appkey: appKey,
    format: CAPTURE_AUDIO.container,
    sample_rate: String(CAPTURE_AUDIO.sampleRate),
    /* 标点与数字规范化：口述病历里"一天两次"写成"1天2次"是医生最烦的一类后处理 */
    enable_punctuation_prediction: 'true',
    enable_inverse_text_normalization: 'true',
  });
  const separator = ctx.config.endpoint.includes('?') ? '&' : '?';
  const response = await ctx.call(
    {
      method: 'POST',
      url: `${ctx.config.endpoint}${separator}${query.toString()}`,
      headers: { 'X-NLS-Token': token, 'Content-Type': 'application/octet-stream' },
      raw: { contentType: 'application/octet-stream', body: audio },
    },
    Math.min(ctx.config.submitTimeoutMs, budget),
  );
  if (response.status < 200 || response.status >= 300) {
    throw retryableHttp('E_CAPTURE_HTTP_STATUS', `阿里云语音识别返回 ${response.status}（响应体未记录）`);
  }
  const parsed = parseJsonObject(response.body, '阿里云语音识别服务');
  const status = Number(parsed.status);
  if (status === ALIYUN_OK) return { text: requireText(parsed.result, 'status=20000000 但 result 不是字符串'), taskId: '' };
  if (ALIYUN_EMPTY_CODES.includes(status)) return { text: '', taskId: '' };
  throw new CaptureError(
    'E_CAPTURE_SUBMIT_FAILED',
    `阿里云拒绝本次识别（status=${status} ${String(parsed.message ?? '')}）：这段**没转成**，不会当成"这段没说话"`,
  );
};

/** 三家实现（key 与 `AsrKind` 一一对应，缺一个编译期就报错） */
export const ASR_PROTOCOLS: Record<AsrKind, AsrProtocol> = {
  'intranet-task': intranetTask,
  'baidu-rest': baiduRest,
  'aliyun-nls': aliyunNls,
};
