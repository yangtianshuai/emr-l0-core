// 图片探测（零依赖）：只看头部字节，得出格式、像素尺寸与 DPI。

/** 上传上限：8 MB。超出的图在 A4 正文宽度下已远超一页，且会显著拖慢签名与导出 */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export type ImageMime = 'image/png' | 'image/jpeg' | 'image/webp';

export interface ProbedImage {
  mime: ImageMime;
  width: number;
  height: number;
  /**
   * 图片自报的 DPI。读不到时按 96（浏览器与 Office 的默认值）。
   * 它是"像素 → pt"的唯一依据：不按 DPI 换算，一张 300 DPI 的 20mm 超声图
   * 会被画成 160mm 宽，而一张 96 DPI 的截图会被画得像邮票。
   */
  dpi: number;
}

/** 允许的扩展名（与 MIME 一一对应）：文件落盘时用 MIME 定扩展名，不采信上传方给的文件名 */
export const IMAGE_EXTENSION: Record<ImageMime, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

const MIME_BY_EXTENSION: Record<string, ImageMime> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

/** 扩展名 → MIME；认不出来返回 null（静态资源路由据此拒绝下发） */
export function mimeOfExtension(ext: string): ImageMime | null {
  return MIME_BY_EXTENSION[ext.toLowerCase()] ?? null;
}

const DEFAULT_DPI = 96;

function u16be(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}

function u32be(bytes: Uint8Array, offset: number): number {
  return (((bytes[offset] ?? 0) << 24) | ((bytes[offset + 1] ?? 0) << 16) | ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0)) >>> 0;
}

function u16le(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset + 1] ?? 0) << 8) | (bytes[offset] ?? 0);
}

function u24le(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset + 2] ?? 0) << 16) | ((bytes[offset + 1] ?? 0) << 8) | (bytes[offset] ?? 0);
}

function u32le(bytes: Uint8Array, offset: number): number {
  return (((bytes[offset + 3] ?? 0) << 24) | ((bytes[offset + 2] ?? 0) << 16) | ((bytes[offset + 1] ?? 0) << 8) | (bytes[offset] ?? 0)) >>> 0;
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.length < signature.length) return false;
  return signature.every((value, index) => bytes[index] === value);
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * PNG：IHDR 必在第一个块；DPI 在可选的 pHYs 里。
 * pHYs 的 unit=1 表示"每米像素"，换算 dpi = ppu × 0.0254。
 */
function probePng(bytes: Uint8Array): ProbedImage | null {
  if (!startsWith(bytes, PNG_SIGNATURE)) return null;
  if (bytes.length < 24) return null;
  /* 第一个块的类型必须是 IHDR（"IHDR" 在偏移 12） */
  if (u32be(bytes, 8) !== 13) return null;
  if (String.fromCharCode(...bytes.subarray(12, 16)) !== 'IHDR') return null;
  const width = u32be(bytes, 16);
  const height = u32be(bytes, 20);
  if (width <= 0 || height <= 0) return null;

  let dpi = DEFAULT_DPI;
  /* 逐个块扫 pHYs：块结构 = 长度(4) + 类型(4) + 数据 + CRC(4) */
  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const length = u32be(bytes, offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (type === 'pHYs' && length >= 9) {
      const ppuX = u32be(bytes, offset + 8);
      const unit = bytes[offset + 16] ?? 0;
      if (unit === 1 && ppuX > 0) {
        const computed = Math.round(ppuX * 0.0254);
        if (computed >= 24 && computed <= 1200) dpi = computed;
      }
      break;
    }
    if (type === 'IDAT' || type === 'IEND') break;
    offset += 12 + length;
  }
  return { mime: 'image/png', width, height, dpi };
}

/**
 * JPEG：SOF 段里是宽高；APP0/JFIF 里是 DPI。
 * 必须跳过每个段，不能按固定偏移读 —— 段长可变，且 EXIF 段可能很长。
  */
function probeJpeg(bytes: Uint8Array): ProbedImage | null {
  if ((bytes[0] ?? 0) !== 0xff || (bytes[1] ?? 0) !== 0xd8) return null;
  let dpi = DEFAULT_DPI;
  let width = 0;
  let height = 0;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if ((bytes[offset] ?? 0) !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1] ?? 0;
    /* 填充字节：FF FF … 之后才是真 marker */
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    /* 无长度的独立 marker（RSTn / SOI / EOI / TEM） */
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      offset += 2;
      continue;
    }
    const length = u16be(bytes, offset + 2);
    if (length < 2) return null;

    if (marker === 0xe0 && length >= 16) {
      const isJfif = String.fromCharCode(...bytes.subarray(offset + 4, offset + 9)) === 'JFIF\u0000';
      if (isJfif) {
        const unit = bytes[offset + 11] ?? 0;
        const xDensity = u16be(bytes, offset + 12);
        /* unit=1 是 dpi，unit=2 是"每厘米" */
        if (xDensity > 0 && unit === 1 && xDensity >= 24 && xDensity <= 1200) dpi = xDensity;
        if (xDensity > 0 && unit === 2) {
          const computed = Math.round(xDensity * 2.54);
          if (computed >= 24 && computed <= 1200) dpi = computed;
        }
      }
    }
    /* SOF0..SOF15，排除 DHT(C4) / JPG(C8) / DAC(CC) */
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof && length >= 7) {
      height = u16be(bytes, offset + 5);
      width = u16be(bytes, offset + 7);
      break;
    }
    offset += 2 + length;
  }
  if (width <= 0 || height <= 0) return null;
  return { mime: 'image/jpeg', width, height, dpi };
}

/** WebP：VP8X 有 24 位宽高；VP8 与 VP8L 各自一套紧凑编码 */
function probeWebp(bytes: Uint8Array): ProbedImage | null {
  if (bytes.length < 30) return null;
  if (String.fromCharCode(...bytes.subarray(0, 4)) !== 'RIFF') return null;
  if (String.fromCharCode(...bytes.subarray(8, 12)) !== 'WEBP') return null;
  const chunk = String.fromCharCode(...bytes.subarray(12, 16));
  if (chunk === 'VP8X') {
    const width = u24le(bytes, 24) + 1;
    const height = u24le(bytes, 27) + 1;
    if (width <= 0 || height <= 0) return null;
    return { mime: 'image/webp', width, height, dpi: DEFAULT_DPI };
  }
  if (chunk === 'VP8 ') {
    /* 帧头：3 字节帧标记 + 9D 01 2A 起始码，随后是 14 位宽、14 位高 */
    if ((bytes[23] ?? 0) !== 0x9d || (bytes[24] ?? 0) !== 0x01 || (bytes[25] ?? 0) !== 0x2a) return null;
    const width = u16le(bytes, 26) & 0x3fff;
    const height = u16le(bytes, 28) & 0x3fff;
    if (width <= 0 || height <= 0) return null;
    return { mime: 'image/webp', width, height, dpi: DEFAULT_DPI };
  }
  if (chunk === 'VP8L') {
    if ((bytes[20] ?? 0) !== 0x2f) return null;
    const bits = u32le(bytes, 21);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >>> 14) & 0x3fff) + 1;
    if (width <= 0 || height <= 0) return null;
    return { mime: 'image/webp', width, height, dpi: DEFAULT_DPI };
  }
  return null;
}

/**
 * 探测一张图。认不出来（非 PNG/JPEG/WebP、头部被截断、尺寸为 0）返回 null ——
 * 调用方必须把 null 当成拒绝，不要退回"按默认尺寸收下"。
  */
export function probeImage(bytes: Uint8Array): ProbedImage | null {
  if (bytes.length < 16) return null;
  return probePng(bytes) ?? probeJpeg(bytes) ?? probeWebp(bytes);
}

export function pixelsToPt(pixels: number, dpi: number): number {
  const safeDpi = dpi > 0 ? dpi : DEFAULT_DPI;
  return (pixels / safeDpi) * 72;
}
