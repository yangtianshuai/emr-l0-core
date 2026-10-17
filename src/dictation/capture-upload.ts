/**
 * 采集层的**入站面**：从一次 `POST /api/dictation/capture/segment` 里取出那一段音频。
 *
 * ## 为什么自己解 multipart，而不是"把请求体原样转给 ASR"
 *
 * 原样转发的确更短，但它把 **ASR 的协议暴露给了前端**（字段名、multipart 形状、甚至
 * 哪天换成 `audio_file` 就得改前端）—— 而"前端看不到 ASR 协议"正是采集层选
 * "浏览器 → 同源服务端 → ASR"这条路线的理由之一（见 `docs/L2-语音采集设计.md` 第二节）。
 * 前端与我们的契约只有一句：**提交一段音频，拿回这段的文本或失败原因**。
 *
 * ## 为什么解析器可以这么短（以及它守住了什么）
 *
 * 调用方是我们自己的前端，而 RFC 7578 的 multipart **没有嵌套、没有编码、没有 chunked**：
 * 一段前缀 + 若干"分段"（头部 + 空行 + 正文）+ 结束标记。于是这里只做四件事：
 *   ① 从 `Content-Type` 取 boundary（拿不到就拒）；
 *   ② 找到**唯一一个** `name="audio"` 的**文件**分段（`filename` 必须有）；
 *   ③ 按 `\r\n--boundary` 定界取正文（**按字节找，不按字符**：音频里任何一个字节都可能出现）；
 *   ④ 分段数不是 1 就拒。
 *
 * 第 ④ 条是刻意的严格：允许多余分段，就等于允许调用方夹带别的东西，
 * 而我们**不做**"哪个是音频"的猜测 —— 猜错一次就是把一份别的内容当成录音发出去。
 *
 * ## 它不校验音频内容
 *
 * 不检查是不是合法 WAV：那要读到文件头再判断，而"格式对不对"由 ASR 服务说了算，
 * 在这里再写一套判断只会造出第二个可能不一致的真相。这里只保证"取出来的字节就是那一段"。
 */

import { CAPTURE_AUDIO_FIELD, CaptureError } from './capture.ts';

export interface UploadedAudio {
  /** 客户端给的文件名（用于留痕/排障，不参与任何判定） */
  filename: string;
  bytes: Uint8Array;
}

const CRLF = Uint8Array.from([13, 10]);
const HEADER_END = Uint8Array.from([13, 10, 13, 10]);

/** 按**字节**找子串（`\r\n--boundary` 必须按字节比：转成字符串会破坏二进制正文） */
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
    /* 跳过定界符后的 CRLF */
    cursor = indexOfBytes(body, CRLF, cursor) + 2;
    if (cursor <= 1) break;
    const headerEnd = indexOfBytes(body, HEADER_END, cursor);
    if (headerEnd === -1) {
      throw new CaptureError('E_CAPTURE_UPLOAD_INVALID', '分段头部没有结束空行：请求体不完整（拒绝按"前半段"处理）');
    }
    const headers = ascii(body.subarray(cursor, headerEnd));
    const bodyStart = headerEnd + HEADER_END.byteLength;
    /* 正文结束于**下一个** `\r\n--boundary`：按规范 boundary 不得出现在正文里，
       发送方（我们自己的前端）随机生成它，所以"第一个命中"就是真边界。 */
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
