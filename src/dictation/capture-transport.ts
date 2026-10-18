// 采集层的底座：错误码与错误类型、音频规格常量、HTTP 传输（可注入）。

export type CaptureErrorCode =
  | 'E_CAPTURE_CONFIG_INVALID'
  /** 置信度上限 ≥ 关键内容阈值：未知按最保守处理这条纪律被放开 */
  | 'E_CAPTURE_CEILING_TOO_HIGH'
  | 'E_CAPTURE_NOT_CONFIGURED'
  /**
   * 选了公有云却没显式确认音频会出院。
   *
   * 这一条是采集里唯一"数据流向"级别的开关：院内服务收到的是院内的音频，
   * 而公有云收到的是要出院的音频。默认值必须是"不许"，确认必须是显式的一次动作，
   * 否则某天会有人在生产里留着一条云地址，而音频带着患者姓名发到公网。
    */
  | 'E_CAPTURE_CLOUD_NOT_ACKNOWLEDGED'
  /** 凭证没配全（该厂商需要凭据却没给）：不发出任何请求，直接判未配置可用  */
  | 'E_CAPTURE_CREDENTIAL_MISSING'
  /** 服务回了 `code !== 200`，或 `code === 200` 却没有 `task_id`：调用方的错，不重试  */
  | 'E_CAPTURE_SUBMIT_FAILED'
  /** 传输层非 2xx（重试耗尽后仍在）：响应体不记入错误信息（它可能回显音频侧内容）  */
  | 'E_CAPTURE_HTTP_STATUS'
  /** 响应不是预期结构（不是 JSON / 缺字段 / 状态值不认识）：不把"没有产出"当成"没有说话" */
  | 'E_CAPTURE_BAD_RESPONSE'
  /** 单段总预算耗尽：内网那台接口没有失败态，这是"识别失败"的唯一可判形态  */
  | 'E_CAPTURE_ASR_TIMEOUT'
  /** 采集端给出的时间轴不单调：不在这里重排（重排是 `normalizeSegments` 的职责） */
  | 'E_CAPTURE_BAD_TIMELINE'
  /** 入站请求不是"一段 multipart 音频"：字段名不对 / 不是 multipart / 夹带多余分段 */
  | 'E_CAPTURE_UPLOAD_INVALID'
  /** 采集端提交上来的转写段形状不合法（缺项 / 段号重复 / 区间倒置 / 附带 `confidence`） */
  | 'E_CAPTURE_BAD_SEGMENTS';

export class CaptureError extends Error {
  code: CaptureErrorCode;
  /** 是否值得重试：只对传输层故障成立；业务码错误重试只会错第二遍  */
  retryable: boolean;

  constructor(code: CaptureErrorCode, message: string, retryable = false) {
    super(message);
    this.name = 'CaptureError';
    this.code = code;
    this.retryable = retryable;
  }
}

export const CAPTURE_AUDIO = {
  container: 'wav',
  codec: 'pcm_s16le',
  sampleRate: 16_000,
  channels: 1,
  bitsPerSample: 16,
} as const;

/** 上传与轮询各最多重试几次（合计 1 + 2 次尝试）；只对传输层故障意味着"值得再试" */
export const CAPTURE_MAX_ATTEMPTS = 3;

export interface CaptureTransportRequest {
  method: 'GET' | 'POST';
  url: string;
  headers: Record<string, string>;
  /** 内网服务：multipart 提交（字段名 + 文件名 + 音频字节）。boundary 由 transport 构造  */
  audio?: { field: string; filename: string; bytes: Uint8Array };
  /**
   * 云厂商：原始请求体 + 显式 `Content-Type`。
   *
   * 两家的形状差得远，硬塞进 `audio` 那一格会让两边都不对：百度是 JSON
   * （音频转 base64 塞进 `speech` 字段），阿里云是裸音频字节流。
    */
  raw?: { contentType: string; body: string | Uint8Array };
  signal?: AbortSignal;
}

export interface CaptureTransportResponse {
  status: number;
  /** 响应体文本；只在内存里用于解析，不写日志、不进留痕、不放进错误信息  */
  body: string;
}

export type CaptureTransport = (request: CaptureTransportRequest) => Promise<CaptureTransportResponse>;

/** 把字节复制进独立 `ArrayBuffer`：`Uint8Array` 可能是大缓冲区上的视图，直接交出去会带上无关字节 */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

export const defaultTransport: CaptureTransport = async (request) => {
  const init: RequestInit = {
    method: request.method,
    headers: request.headers,
    ...(request.signal ? { signal: request.signal } : {}),
  };
  if (request.audio) {
    const form = new FormData();
    form.append(request.audio.field, new Blob([toArrayBuffer(request.audio.bytes)], { type: 'audio/wav' }), request.audio.filename);
    init.body = form;
  } else if (request.raw) {
    init.body = typeof request.raw.body === 'string' ? request.raw.body : toArrayBuffer(request.raw.body);
  }
  const response = await fetch(request.url, init);
  return { status: response.status, body: await response.text() };
};

/** 解析 JSON 对象响应。响应体不进错误信息：它可能回显音频侧内容（转写文本就在里面）  */
export function parseJsonObject(body: string, what: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.trim());
  } catch {
    throw new CaptureError('E_CAPTURE_BAD_RESPONSE', `${what}的输出不是 JSON（响应体未记录：它可能回显音频侧内容）`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CaptureError('E_CAPTURE_BAD_RESPONSE', `${what}的输出不是 JSON 对象`);
  }
  return parsed as Record<string, unknown>;
}
