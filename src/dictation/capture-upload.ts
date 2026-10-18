// 采集层的入站面：从一次 `POST /api/dictation/capture/segment` 里取出那一段音频。

import { CAPTURE_AUDIO_FIELD, CaptureError } from './capture.ts';

export interface UploadedAudio {
  /** 客户端给的文件名（用于留痕/排障，不参与任何判定） */
  filename: string;
  bytes: Uint8Array;
}

const CRLF = Uint8Array.from([13, 10]);
const HEADER_END = Uint8Array.from([13, 10, 13, 10]);

/** 按字节找子串（`\r\n--boundary` 必须按字节比：转成字符串会破坏二进制正文）  */
function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, from = 0): number {
  if (needle.byteLength === 0) return -1;
  const last = haystack.byteLength - needle.byteLength;
  for (let i = Math.max(0, from); i <= last; i += 1) {
    let hit = true;
    for (let j = 0; j < needle.byteLength; j += 1) {
      if (haystack[i + j] !== needle[j]) {
        hit = false;
        break;
      }
    }
    if (hit) return i;
  }
  return -1;
}

function ascii(bytes: Uint8Array): string {
  return new TextDecoder('latin1').decode(bytes);
}

/** 取 `Content-Type` 里的 boundary（带或不带引号都认；缺了就直接拒） */
function boundaryOf(contentType: string | undefined): string {
  const raw = contentType ?? '';
  if (!/^multipart\/form-data\b/i.test(raw.trim())) {
    throw new CaptureError(
      'E_CAPTURE_UPLOAD_INVALID',
      `只接受 multipart/form-data 的分段音频，实际 Content-Type=${JSON.stringify(raw)}`,
    );
  }
  const matched = /;\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(raw);
  const boundary = (matched?.[1] ?? matched?.[2] ?? '').trim();
  if (boundary === '') {
    throw new CaptureError('E_CAPTURE_UPLOAD_INVALID', 'multipart/form-data 缺少 boundary：无法切分请求体，拒绝猜测');
  }
  return boundary;
}

interface RawPart {
  headers: string;
  body: Uint8Array;
}

/** 按 `--boundary` 切出各分段（不判字段名，留给调用方判） */
function splitParts(body: Uint8Array, boundary: string): RawPart[] {
  const delimiter = new TextEncoder().encode(`--${boundary}`);
  /** 正文与下一个分段之间的定界：`\r\n--boundary` */
  const nextDelimiter = new Uint8Array(CRLF.byteLength + delimiter.byteLength);
  nextDelimiter.set(CRLF, 0);
  nextDelimiter.set(delimiter, CRLF.byteLength);
  const first = indexOfBytes(body, delimiter, 0);
  if (first === -1) {
    throw new CaptureError('E_CAPTURE_UPLOAD_INVALID', '请求体里找不到 boundary 标记：不像是 multipart 分段（拒绝猜测）');
  }
  const parts: RawPart[] = [];
  let cursor = first + delimiter.byteLength;
  for (;;) {
    /* 定界符后面的两种情况：`--` = 结束；`\r\n` = 还有分段 */
    if (body[cursor] === 45 && body[cursor + 1] === 45) break;
    cursor = indexOfBytes(body, CRLF, cursor) + 2;
    if (cursor <= 1) break;
    const headerEnd = indexOfBytes(body, HEADER_END, cursor);
    if (headerEnd === -1) {
      throw new CaptureError('E_CAPTURE_UPLOAD_INVALID', '分段头部没有结束空行：请求体不完整（拒绝按"前半段"处理）');
    }
    const headers = ascii(body.subarray(cursor, headerEnd));
    const bodyStart = headerEnd + HEADER_END.byteLength;
    /* 正文结束于下一个 `\r\n--boundary`：按规范 boundary 不得出现在正文里，
       发送方（我们自己的前端）随机生成它，所以"第一个命中"就是真边界。  */
    const nextBoundary = indexOfBytes(body, nextDelimiter, bodyStart);
    if (nextBoundary === -1) {
      throw new CaptureError('E_CAPTURE_UPLOAD_INVALID', '分段没有结束标记：请求体被截断（拒绝按"读到的部分"当完整音频）');
    }
    parts.push({ headers, body: body.subarray(bodyStart, nextBoundary) });
    cursor = nextBoundary + nextDelimiter.byteLength;
  }
  return parts;
}

/** `content-disposition` 里的 `name` / `filename`（值可能带引号） */
function dispositionOf(headers: string): { name: string; filename: string } {
  const line = headers.split(/\r?\n/).find((item) => /^content-disposition\s*:/i.test(item)) ?? '';
  const pick = (key: string): string => {
    const matched = new RegExp(`${key}\\s*=\\s*(?:"([^"]*)"|([^;\\r\\n]*))`, 'i').exec(line);
    return (matched?.[1] ?? matched?.[2] ?? '').trim();
  };
  return { name: pick('name'), filename: pick('filename') };
}

/**
 * 取出这一段音频。
 *
 * `field` 默认是 ASR 要的字段名（`audio`）—— 前端与我们对齐的也是它：
 * 一个字段、一个文件、一次一段。多给分段一律拒，而不是"挑一个看着像的"。
 */
export function parseMultipartAudio(
  contentType: string | undefined,
  body: Uint8Array,
  field: string = CAPTURE_AUDIO_FIELD,
): UploadedAudio {
  const boundary = boundaryOf(contentType);
  if (body.byteLength === 0) {
    throw new CaptureError('E_CAPTURE_UPLOAD_INVALID', '请求体是空的：没有音频可提交（不把"空请求"当成"这段没说话"）');
  }
  const parts = splitParts(body, boundary);
  if (parts.length !== 1) {
    throw new CaptureError(
      'E_CAPTURE_UPLOAD_INVALID',
      `一次只接受一个分段音频，实际收到 ${parts.length} 个分段：拒绝"哪个是音频"的猜测`,
    );
  }
  const part = parts[0] as RawPart;
  const { name, filename } = dispositionOf(part.headers);
  if (name !== field) {
    throw new CaptureError('E_CAPTURE_UPLOAD_INVALID', `分段字段名必须是 ${JSON.stringify(field)}，实际 ${JSON.stringify(name)}`);
  }
  if (filename === '') {
    throw new CaptureError('E_CAPTURE_UPLOAD_INVALID', '分段缺少 filename：它不是一份文件（一次提交 = 一段音频）');
  }
  if (part.body.byteLength === 0) {
    throw new CaptureError('E_CAPTURE_UPLOAD_INVALID', '音频分段是空的：不把"零字节"当成一段录音');
  }
  return { filename, bytes: part.body };
}
