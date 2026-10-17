/**
 * 持久化：快照文件的**原子写**与**严格读**。
 *
 * 覆盖的对象是"不属于文档内容、但丢了会出事"的东西：AI 建议、旁挂注解、
 * 患者主索引。它们此前都是**会话级内存** —— 进程重启即失，而丢失的表现
 * 是"界面上干干净净"，看起来像正常状态。
 *
 * ## 三条不可让步的设计
 *
 * 1) **原子写**：先写 `<file>.tmp` → `fsync` → `rename`。
 *    写到一半崩溃只会留下 `.tmp`，正式文件要么是旧内容、要么是新内容，
 *    不会出现半个文件 —— **"半个文件"比"没有文件"更危险，因为它看起来是好的**。
 *    `rename` 在同一文件系统内是原子的，这也是为什么临时文件必须与原文件同目录。
 *
 * 2) **读失败绝不静默降级**：文件不存在、格式不符、版本不符、摘要不符，
 *    一律**显式报错**，绝不"当作空数据启动"。
 *    空启动会把"数据丢失"伪装成"本来就没有"—— 质控痕迹消失而无人知晓，
 *    这是这类系统里最难查的一类事故。
 *
 * 3) **版本不匹配不猜**：按新格式去解释旧数据，会"成功地"读出一份**错误**的内容，
 *    比报错危险得多。所以版本不符直接拒绝，迁移必须显式做（调用方决定怎么迁）。
 *
 * ## 摘要不是签名
 *
 * `digest` 用 `node:crypto` 的 SHA-256：它**只能发现截断与意外损坏**，
 * **防不住有意篡改**（改内容的人也能改摘要）。防篡改要靠签名（本仓库的 SM2 + SM3 链路），
 * 那是文档层的事，不该混进本地快照 —— 混进来会给人"这个文件被保护了"的错觉。
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * ⚠️ 本仓库所在环境的 `node:fs` **类型声明不完整**（缺少 `open/close/fsync/rename/unlink`
 * 等同步 API 的声明，运行时它们是存在的）。这里做一次**局部断言**，而不是改用
 * "写文件 + 直接覆盖" —— **原子写正是本模块存在的理由**，为了迁就类型声明放弃它，
 * 等于把"崩溃时不会留下半个文件"这个唯一保证丢掉。
 */
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

/**
 * 落盘冲突：**盘上的版本与我手上的基线不一致**。
 *
 * 它是"乐观锁的存储边界"那一半。进程内的 `expectedRev`（`session.ts`）拦得住同一个
 * `WriteSession` 上的过期写入，但拦不住**两个终端各自打开同一份病历**：
 * 两边内存里都自洽，谁都不知道对方改过 —— 而文件是**全量覆盖**，
 * 于是后写的那个**静默抹掉**前一个（实测可复现，见 `concurrency-self-test.ts` 的对照实验）。
 *
 * 这个错误就是"我发现盘上不是我认的那一版"的**显式拒绝**：宁可不落盘并说清楚，
 * 也不覆盖一份比它更新的内容 —— 后者会让"另一个终端刚写的东西消失"变成一件没人知道的事。
 */
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
  /** 格式版本：不匹配即拒绝（见文件头第 3 条） */
  version?: number;
  /** 保存时刻（测试可注入，保证可复现） */
  at?: string;
  /**
   * **落盘前置条件**（做 compare-and-swap 用）：
   *   - `{ digest }`：盘上快照的摘要必须正好等于它（"我是在这一版上改的"）；
   *   - `{ missing: true }`：文件必须不存在（首次落盘，只允许一个赢家）。
   *
   * 不满足 → 抛 `SnapshotConflictError`，**一个字节都不写**。
   * 不传 = 无条件覆盖（旧行为，保留它是为了"首次播种""显式重建"这类确实要覆盖的场合）。
   *
   * ⚠️ 它缩小而不消除竞态窗口：这里是"读摘要 → 比较 → 写"，两步之间有极小的空隙，
   * 理论上两个进程可能同时通过。它拦的是**人的时间尺度**上的交错（两个终端轮流改同一份病历）。
   * 真正的原子 CRUD 要么文件锁、要么数据库 —— 那正是"落库"那条线要解决的事，
   * 在拿到它之前，先用这一层把"静默丢更新"变成"显式拒绝"。
   */
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

/**
 * 盘上这一版快照的摘要（用于落盘前置条件）。
 *
 * 摘要**重算**而不是信任信封里那一个：信封里的 `digest` 是写的时候留下的，
 * 文件若被截断，它反而会"证明"一份残缺内容是对的。
 */
function currentDigest(file: string, format: string, version: number): { exists: boolean; digest: string | null; reason?: string } {
  if (!existsSync(file)) return { exists: false, digest: null };
  try {
    const raw = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    const envelope = JSON.parse(raw) as { format?: string; version?: number; payload?: unknown };
    if (envelope.format !== format) return { exists: true, digest: null, reason: `格式标识不同（${String(envelope.format)}）` };
    if (envelope.version !== version) return { exists: true, digest: null, reason: `格式版本不同（${String(envelope.version)}）` };
    return { exists: true, digest: digestOf(envelope.payload) };
  } catch (err) {
    /* 盘上那份读不出来时**不能当成"就是我要写的那一版"**：那等于拿一次解析失败当通行证 */
    return { exists: true, digest: null, reason: `盘上快照无法解析：${(err as Error).message}` };
  }
}

/** 原子写快照；返回写入元信息。目录不存在会自动创建。 */
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
  /* 临时文件必须与原文件**同目录**：跨文件系统的 rename 不是原子操作，会退化成"复制+删除" */
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

/**
 * 严格读取快照。**任何异常都显式返回错误码**，绝不返回"空数据"（见文件头第 2 条）。
 */
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
  /* 去掉 BOM：Windows 工具链产出的文件常带 BOM，JSON.parse 会直接失败 */
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

/** 存在性检查（供调用方区分"首次启动"与"数据丢失"—— 两者处置完全不同） */
export function snapshotExists(file: string): boolean {
  return existsSync(file);
}

/** 清理临时文件残留（崩在写一半时留下的 `.tmp`）；返回是否清理过 */
export function cleanupTemp(file: string): boolean {
  const tmp = `${file}.tmp`;
  if (!existsSync(tmp)) return false;
  fsx.unlinkSync(tmp);
  return true;
}
