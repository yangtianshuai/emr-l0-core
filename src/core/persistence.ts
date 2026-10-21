import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

interface FsSyncExtras {
  openSync: (path: string, flags: string) => number;
  writeSync: (fd: number, data: string, encoding: string) => void;
  closeSync: (fd: number) => void;
  fsyncSync: (fd: number) => void;
  renameSync: (from: string, to: string) => void;
  unlinkSync: (path: string) => void;
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const fsx = (await import('node:fs')) as unknown as FsSyncExtras;

export interface SnapshotMeta {
  format: string;
  version: number;
  savedAt: string;
  digest: string;
  bytes: number;
}

export const SNAPSHOT_CONFLICT_CODE = 'E_CONCURRENT_MODIFICATION';

export class SnapshotConflictError extends Error {
  readonly code = SNAPSHOT_CONFLICT_CODE;

  readonly detail: { file: string; expected: string | null; actual: string | null; reason?: string };

  constructor(
    file: string,
    expected: string | null,
    actual: string | null,
    reason?: string,
  ) {
    super(
      `落盘冲突：${file} 已经不是我能写的那一版` +
        `（期望 ${expected === null ? '文件不存在' : expected.slice(0, 12)}…，实际 ${actual === null ? '文件不存在' : actual.slice(0, 12)}…）` +
        `${reason ? `；${reason}` : ''}。本次未写入：盘上那一版来自另一处（终端/进程）。` +
        `要继续落盘，需先重新载入盘上那一版（放弃本终端尚未落盘的改动）。`,
    );
    this.name = 'SnapshotConflictError';
    this.detail = { file, expected, actual, ...(reason ? { reason } : {}) };
  }
}

export interface SnapshotOptions {
  /** 格式标识：防止把别的文件误当成快照读进来 */
  format?: string;
  version?: number;
  at?: string;
  expect?: { digest: string } | { missing: true };
}

export type SnapshotReadError =
  | 'E_SNAPSHOT_MISSING'
  | 'E_SNAPSHOT_CORRUPT'
  | 'E_SNAPSHOT_FORMAT'
  | 'E_SNAPSHOT_VERSION';

export type SnapshotReadResult<T> =
  | { ok: true; payload: T; meta: SnapshotMeta }
  | { ok: false; code: SnapshotReadError; message: string };

const DEFAULT_FORMAT = 'l0-snapshot';
const DEFAULT_VERSION = 1;

function digestOf(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function currentDigest(file: string, format: string, version: number): { exists: boolean; digest: string | null; reason?: string } {
  if (!existsSync(file)) return { exists: false, digest: null };
  try {
    const raw = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    const envelope = JSON.parse(raw) as { format?: string; version?: number; payload?: unknown };
    if (envelope.format !== format) return { exists: true, digest: null, reason: `格式标识不同（${String(envelope.format)}）` };
    if (envelope.version !== version) return { exists: true, digest: null, reason: `格式版本不同（${String(envelope.version)}）` };
    return { exists: true, digest: digestOf(envelope.payload) };
  } catch (err) {
    return { exists: true, digest: null, reason: `盘上快照无法解析：${(err as Error).message}` };
  }
}

export function writeSnapshot<T>(file: string, payload: T, options: SnapshotOptions = {}): SnapshotMeta {
  const format = options.format ?? DEFAULT_FORMAT;
  const version = options.version ?? DEFAULT_VERSION;
  const savedAt = options.at ?? new Date().toISOString();

  if (options.expect) {
    const current = currentDigest(file, format, version);
    if ('missing' in options.expect) {
      if (current.exists) throw new SnapshotConflictError(file, null, current.digest, '期望首次落盘，但文件已存在');
    } else if (!current.exists) {
      throw new SnapshotConflictError(file, options.expect.digest, null, '基线上的文件已不存在（可能被删除或重置过）');
    } else if (current.digest === null || current.digest !== options.expect.digest) {
      throw new SnapshotConflictError(file, options.expect.digest, current.digest, current.reason);
    }
  }

  const envelope = { format, version, savedAt, digest: digestOf(payload), payload };
  const text = JSON.stringify(envelope, null, 2);

  mkdirSync(dirname(file), { recursive: true });
  /* 临时文件必须与原文件同目录：跨文件系统的 rename 不是原子操作，会退化成"复制+删除"  */
  const tmp = `${file}.tmp`;
  const fd = fsx.openSync(tmp, 'w');
  try {
    fsx.writeSync(fd, text, 'utf8');
    /* 先落盘再 rename：否则 rename 之后内容可能仍在页缓存里，断电就丢了 */
    fsx.fsyncSync(fd);
  } finally {
    fsx.closeSync(fd);
  }
  fsx.renameSync(tmp, file);
  return { format, version, savedAt, digest: digestOf(payload), bytes: text.length };
}

export function readSnapshot<T>(file: string, options: SnapshotOptions = {}): SnapshotReadResult<T> {
  if (!existsSync(file)) {
    return { ok: false, code: 'E_SNAPSHOT_MISSING', message: `快照不存在：${file}（调用方需显式决定"首次启动"还是"数据丢失"）` };
  }
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    return { ok: false, code: 'E_SNAPSHOT_CORRUPT', message: `无法读取快照：${(err as Error).message}` };
  }
  const text = raw.replace(/^\uFEFF/, '');
  let envelope: { format?: string; version?: number; savedAt?: string; digest?: string; payload?: T };
  try {
    envelope = JSON.parse(text) as typeof envelope;
  } catch {
    return { ok: false, code: 'E_SNAPSHOT_CORRUPT', message: '快照 JSON 解析失败（文件可能被截断）' };
  }
  const format = options.format ?? DEFAULT_FORMAT;
  if (envelope.format !== format) {
    return { ok: false, code: 'E_SNAPSHOT_FORMAT', message: `格式不匹配：期望 ${format}，实际 ${String(envelope.format)}` };
  }
  const version = options.version ?? DEFAULT_VERSION;
  if (envelope.version !== version) {
    return {
      ok: false,
      code: 'E_SNAPSHOT_VERSION',
      message: `格式版本不匹配：期望 ${version}，实际 ${String(envelope.version)}（需显式迁移，不做隐式猜测）`,
    };
  }
  const digest = digestOf(envelope.payload);
  if (digest !== envelope.digest) {
    return { ok: false, code: 'E_SNAPSHOT_CORRUPT', message: '内容摘要不一致（文件被截断或改动过）' };
  }
  return {
    ok: true,
    payload: envelope.payload as T,
    meta: { format, version, savedAt: String(envelope.savedAt), digest, bytes: text.length },
  };
}

export function snapshotExists(file: string): boolean {
  return existsSync(file);
}

export function cleanupTemp(file: string): boolean {
  const tmp = `${file}.tmp`;
  if (!existsSync(tmp)) return false;
  fsx.unlinkSync(tmp);
  return true;
}
