export type CaptureErrorCode =
  | 'E_CAPTURE_CONFIG_INVALID'
  /** 置信度上限 ≥ 关键内容阈值：未知按最保守处理这条纪律被放开 */
  | 'E_CAPTURE_CEILING_TOO_HIGH'
  | 'E_CAPTURE_NOT_CONFIGURED'
  | 'E_CAPTURE_CLOUD_NOT_ACKNOWLEDGED'
  | 'E_CAPTURE_CREDENTIAL_MISSING'
  | 'E_CAPTURE_SUBMIT_FAILED'
  | 'E_CAPTURE_HTTP_STATUS'
  | 'E_CAPTURE_BAD_RESPONSE'
  | 'E_CAPTURE_ASR_TIMEOUT'
  | 'E_CAPTURE_BAD_TIMELINE'
  | 'E_CAPTURE_UPLOAD_INVALID'
  | 'E_CAPTURE_BAD_SEGMENTS';

export class CaptureError extends Error {
  code: CaptureErrorCode;
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

export const CAPTURE_MAX_ATTEMPTS = 3;

export interface CaptureTransportRequest {
  method: 'GET' | 'POST';
  url: string;
  headers: Record<string, string>;
  audio?: { field: string; filename: string; bytes: Uint8Array };
  raw?: { contentType: string; body: string | Uint8Array };
  signal?: AbortSignal;
}

export interface CaptureTransportResponse {
  status: number;
  body: string;
}

export type CaptureTransport = (request: CaptureTransportRequest) => Promise<CaptureTransportResponse>;

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
