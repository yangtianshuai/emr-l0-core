import {
  CAPTURE_AUDIO,
  CAPTURE_MAX_ATTEMPTS,
  CaptureError,
  parseJsonObject,
  type CaptureTransportRequest,
  type CaptureTransportResponse,
} from './capture-transport.ts';
import type { AsrConfig } from './capture.ts';

export type AsrKind = 'intranet-task' | 'baidu-rest' | 'aliyun-nls';

export interface AsrVendorSpec {
  kind: AsrKind;
  label: string;
  /** 音频是否离开院内网络：true → 必须显式确认，且界面/审计必须红标 */
  leavesIntranet: boolean;
  credentials: 'none-or-token' | 'access-key-pair' | 'nls-token-and-appkey';
  /** 界面预填的地址（可改）。空串 = 必须自己填（院内服务的地址只有部署方知道）  */
  defaultEndpoint: string;
  /** 模型标识的填写示例：三家都不回模型信息，只能由部署方声明 */
  modelIdHint: string;
  protocol: string;
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

export interface AsrCredentials {
  apiKey?: string;
  apiSecret?: string;
}

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

export function assertPublicCloudAcknowledged(spec: AsrVendorSpec, acknowledged: boolean): void {
  if (!spec.leavesIntranet || acknowledged) return;
  throw new CaptureError(
    'E_CAPTURE_CLOUD_NOT_ACKNOWLEDGED',
    `已选择公有云（${spec.label}），但未确认"音频会发往院外"：拒绝采集。` +
      '语音里必然含患者信息，把这份音频发到院外公网需要**显式的一次确认**，不能由默认值代劳',
  );
}

export const CAPTURE_AUDIO_FIELD = 'audio';
export const CAPTURE_SUBMIT_PATH = '/api/audio/inference-realtime';

export interface AsrTranscribeRequest {
  index: number;
  audio: Uint8Array;
  sessionId: string;
}

export interface AsrTranscribeResult {
  text: string;
  taskId: string;
}

export interface AsrProtocolContext {
  config: AsrConfig;
  credentials: AsrCredentials;
  call: (request: CaptureTransportRequest, timeoutMs: number) => Promise<CaptureTransportResponse>;
  remaining: () => number;
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
    throw new CaptureError(
      'E_CAPTURE_CREDENTIAL_MISSING',
      `百度未返回 access_token（${String(parsed.error ?? '未知原因')}）：核对 AK/SK，以及该应用是否开通了短语音识别`,
    );
  }
  const expiresIn = Number(parsed.expires_in);
  const ttlMs = Number.isFinite(expiresIn) && expiresIn > 120 ? (expiresIn - 60) * 1000 : 60_000;
  tokenCache.set(cacheKey, { token: token.trim(), expiresAt: ctx.now() + ttlMs });
  return token.trim();
}

const baiduRest: AsrProtocol = async ({ audio, sessionId }, ctx) => {
  const token = await baiduToken(ctx);
  const budget = ctx.remaining();
  if (budget <= 0) throw ctx.timeoutError();

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

export const ASR_PROTOCOLS: Record<AsrKind, AsrProtocol> = {
  'intranet-task': intranetTask,
  'baidu-rest': baiduRest,
  'aliyun-nls': aliyunNls,
};
