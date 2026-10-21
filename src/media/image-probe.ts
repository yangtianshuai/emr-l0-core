// 图片探测（零依赖）：只看头部字节，得出格式、像素尺寸与 DPI。

/** 上传上限：8 MB。超出的图在 A4 正文宽度下已远超一页，且会显著拖慢签名与导出 */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export type ImageMime = 'image/png' | 'image/jpeg' | 'image/webp';

export interface ProbedImage {
  mime: ImageMime;
  width: number;
  height: number;
  dpi: number;
}

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
        if (xDensity > 0 && unit === 1 && xDensity >= 24 && xDensity <= 1200) dpi = xDensity;
        if (xDensity > 0 && unit === 2) {
          const computed = Math.round(xDensity * 2.54);
          if (computed >= 24 && computed <= 1200) dpi = computed;
        }
      }
    }
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

export function probeImage(bytes: Uint8Array): ProbedImage | null {
  if (bytes.length < 16) return null;
  return probePng(bytes) ?? probeJpeg(bytes) ?? probeWebp(bytes);
}

export function pixelsToPt(pixels: number, dpi: number): number {
  const safeDpi = dpi > 0 ? dpi : DEFAULT_DPI;
  return (pixels / safeDpi) * 72;
}
