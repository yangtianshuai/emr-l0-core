/**
 * T25 · ZIP 读取器（零依赖，除 node:zlib 外）。
 *
 * 为什么必须自己读：OFD 就是 ZIP 容器，导入必须先解包。出口侧（`src/export/zip.ts`）只写了
 * store 方式，而**别人的 OFD 几乎一定是 deflate 压缩**（method=8），所以这里必须支持两种，
 * 且必须**逐个条目校验 CRC32**——容器被改过一个字节就应该报出来（这正是"篡改可检出"的地基）。
 *
 * 解析顺序（不能颠倒）：
 *   1) 从尾部找 EOCD（可能带注释，因此要向前扫描）；
 *   2) 按 EOCD 给出的中央目录偏移遍历条目；
 *   3) **每个条目都要回到本地文件头**重新计算数据偏移 —— 本地头的扩展字段长度
 *      常与中央目录不同（写入器各异），直接复用中央目录的偏移是经典踩坑点。
 */

import { inflateRawSync } from 'node:zlib';
import { crc32 } from '../export/zip.ts';

export const ZIP_ERRORS = {
  E_ZIP_NOT_FOUND: 'E_ZIP_NOT_FOUND',
  E_ZIP_TRUNCATED: 'E_ZIP_TRUNCATED',
  E_ZIP_CRC_MISMATCH: 'E_ZIP_CRC_MISMATCH',
  E_ZIP_UNSUPPORTED_METHOD: 'E_ZIP_UNSUPPORTED_METHOD',
} as const;

export class ZipError extends Error {
  code: string;

  extra?: unknown;

  constructor(code: string, message: string, extra?: unknown) {
    super(message);
    this.name = 'ZipError';
    this.code = code;
    this.extra = extra;
  }
}

export interface ZipEntry {
  path: string;
  /** 0 = store，8 = deflate */
  method: number;
  /** 解压后字节数 */
  size: number;
  /** 压缩后字节数 */
  compressedSize: number;
  /** CRC32 校验是否通过 */
  crcOk: boolean;
  data: Uint8Array;
}

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** 从尾部向前扫描 EOCD（ZIP 注释最长 65535 字节） */
function findEocd(bytes: Uint8Array): number {
  const minOffset = Math.max(0, bytes.length - 65557);
  for (let offset = bytes.length - 22; offset >= minOffset; offset -= 1) {
    if (view(bytes).getUint32(offset, true) === EOCD_SIG) {
      const commentLength = view(bytes).getUint16(offset + 20, true);
      if (offset + 22 + commentLength <= bytes.length) return offset;
    }
  }
  throw new ZipError(ZIP_ERRORS.E_ZIP_NOT_FOUND, '不是有效的 ZIP 容器（未找到 EOCD 记录）');
}

function decodeName(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes);
}

export interface ReadZipOptions {
  /** CRC 不匹配时是否抛错（默认 true；导入侧希望"被改过就报出来"） */
  strictCrc?: boolean;
}

export function readZip(bytes: Uint8Array, options: ReadZipOptions = {}): ZipEntry[] {
  const strictCrc = options.strictCrc ?? true;
  const eocd = findEocd(bytes);
  const dv = view(bytes);
  const count = dv.getUint16(eocd + 10, true);
  const centralOffset = dv.getUint32(eocd + 16, true);

  const entries: ZipEntry[] = [];
  let cursor = centralOffset;
  for (let index = 0; index < count; index += 1) {
    if (dv.getUint32(cursor, true) !== CENTRAL_SIG) {
      throw new ZipError(ZIP_ERRORS.E_ZIP_TRUNCATED, `中央目录第 ${index + 1} 条记录签名错误（偏移 ${cursor}）`);
    }
    const method = dv.getUint16(cursor + 10, true);
    const expectedCrc = dv.getUint32(cursor + 16, true);
    const compressedSize = dv.getUint32(cursor + 20, true);
    const size = dv.getUint32(cursor + 24, true);
    const nameLength = dv.getUint16(cursor + 28, true);
    const extraLength = dv.getUint16(cursor + 30, true);
    const commentLength = dv.getUint16(cursor + 32, true);
    const localOffset = dv.getUint32(cursor + 42, true);
    const path = decodeName(bytes.subarray(cursor + 46, cursor + 46 + nameLength));

    if (dv.getUint32(localOffset, true) !== LOCAL_SIG) {
      throw new ZipError(ZIP_ERRORS.E_ZIP_TRUNCATED, `条目 ${path} 的本地文件头签名错误`);
    }
    const localNameLength = dv.getUint16(localOffset + 26, true);
    const localExtraLength = dv.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = bytes.subarray(dataStart, dataStart + compressedSize);

    let data: Uint8Array;
    if (method === 0) data = raw.slice();
    else if (method === 8) data = new Uint8Array(inflateRawSync(raw));
    else throw new ZipError(ZIP_ERRORS.E_ZIP_UNSUPPORTED_METHOD, `条目 ${path} 使用了不支持的压缩方式：${method}`, { path, method });

    const crcOk = crc32(data) === expectedCrc;
    if (!crcOk && strictCrc) {
      throw new ZipError(ZIP_ERRORS.E_ZIP_CRC_MISMATCH, `条目 ${path} 的 CRC32 校验失败（内容可能被改动或文件损坏）`, { path, expectedCrc, size });
    }
    if (data.length !== size) {
      throw new ZipError(ZIP_ERRORS.E_ZIP_TRUNCATED, `条目 ${path} 解压后长度不符：声明 ${size}，实际 ${data.length}`, { path });
    }

    entries.push({ path, method, size, compressedSize, crcOk, data });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

export interface ZipArchive {
  entries: ZipEntry[];
  byPath: Map<string, ZipEntry>;
  text(path: string): string | null;
  paths(): string[];
}

export function openZip(bytes: Uint8Array, options: ReadZipOptions = {}): ZipArchive {
  const entries = readZip(bytes, options);
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  const decoder = new TextDecoder('utf-8');
  return {
    entries,
    byPath,
    text: (path: string) => {
      const entry = byPath.get(path);
      return entry ? decoder.decode(entry.data) : null;
    },
    paths: () => entries.map((entry) => entry.path),
  };
}

/** 按驼峰约束查找入口（OFD 的实际文件名大小写与前缀可能各异） */
export function findEntry(archive: ZipArchive, pattern: RegExp): ZipEntry | undefined {
  return archive.entries.find((entry) => pattern.test(entry.path));
}
