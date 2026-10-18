// 会话存储：把"登录过"变成一件有寿命、可吊销、且不落明文的事。
// 供"改口令就踢掉全部旧会话"这类处置。绝对过期（无论多活跃，到点必须重登）没有做，

import { randomBytes } from 'node:crypto';
import { sm3Hex, utf8 } from '../crypto/sm3.ts';
import { AUTH_ERRORS, type Principal } from './principal.ts';

/** 会话里的身份（比 `Principal` 多一个展示名） */
export interface SessionPrincipal extends Principal {
  /** 展示用（如"王医生"），不进正文、不进留痕 */
  label?: string;
}

export interface SessionRecord extends SessionPrincipal {
  createdAt: number;
  /** 绝对时刻（毫秒）：`now >= expiresAt` 即失效 */
  expiresAt: number;
  lastSeenAt: number;
  /** 认领次数：用于"这个会话还在用吗"的判断（不含业务含义） */
  seen: number;
}

/** 只回指纹的展示形态（管理后台用；没有 id 原文）  */
export interface SessionSummary extends Omit<SessionRecord, never> {
  fingerprint: string;
}

export type ResolveResult =
  | { ok: true; record: SessionRecord }
  | { ok: false; code: typeof AUTH_ERRORS.E_AUTH_REQUIRED }
  | { ok: false; code: typeof AUTH_ERRORS.E_SESSION_EXPIRED; expiredAt: number };

export interface SessionStoreOptions {
  ttlMs: number;
  /** 注入时钟（测试用）。默认 `Date.now` */
  now?: () => number;
  /** 是否滑动续期（默认 true） */
  sliding?: boolean;
  /** 过期记录保留多久再清掉（默认 24 小时）：留一会儿是为了让"已过期"与"不存在"能分开报 */
  graceMs?: number;
  /** 最多保留多少条记录（防御性上限；超出时先清过期、再清最旧） */
  maxRecords?: number;
}

export class SessionStore {
  private readonly byFingerprint = new Map<string, SessionRecord>();

  private readonly ttlMs: number;

  private readonly now: () => number;

  private readonly sliding: boolean;

  private readonly graceMs: number;

  private readonly maxRecords: number;

  constructor(options: SessionStoreOptions) {
    if (!Number.isFinite(options.ttlMs) || options.ttlMs <= 0) {
      throw new Error(`会话寿命必须是正数（毫秒），实际 ${String(options.ttlMs)}`);
    }
    this.ttlMs = options.ttlMs;
    this.now = options.now ?? (() => Date.now());
    this.sliding = options.sliding ?? true;
    this.graceMs = options.graceMs ?? 24 * 60 * 60 * 1000;
    this.maxRecords = options.maxRecords ?? 4096;
  }

  /** 会话寿命（毫秒）：界面要能如实告诉用户"多久要重登" */
  get ttl(): number {
    return this.ttlMs;
  }

  /**
   * 签发会话。唯一返回 id 原文的地方 —— 调用方必须立刻把它写进 cookie，
   * 不要存进日志、不要进审计（审计里不该出现能换取权限的东西）。
    */
  issue(principal: SessionPrincipal): { id: string; record: SessionRecord } {
    const id = hex(randomBytes(32));
    const now = this.now();
    const record: SessionRecord = {
      ...principal,
      createdAt: now,
      expiresAt: now + this.ttlMs,
      lastSeenAt: now,
      seen: 0,
    };
    this.byFingerprint.set(fingerprintOf(id), record);
    this.enforceCap();
    return { id, record: { ...record } };
  }

  /**
   * 认领：会话 id → 记录。
   *
   * 三种结果分开报：
   *   - `E_AUTH_REQUIRED`：没给 id，或这个 id 从来没签发过（不猜）；
   *   - `E_SESSION_EXPIRED`：确实签发过、但已经到点 —— 与"没登录"分开，否则医生刚登录就被说成没登录，
   *     会去反复重登而不是去查时间；
   *   - ok：并（在滑动模式下）续期。
   *
   * 过期记录不在这里删：删了之后第二次请求只能报"没登录"，把"过期"这件事盖掉。
   * 清理由 `sweep()` 在宽限期之后做。
   *
   * 有人会问：区分"已过期"与"从未存在"是不是泄露信息？会话 id 是 256 位随机值，
   * 攻击者猜不出一个存在的 id，所以这个区分不构成可利用的探测；
   * 换来的是医生界面上"会话已过期，请重新登录"这句准确的话。
    */
  resolve(id: string | null | undefined): ResolveResult {
    if (!id) return { ok: false, code: AUTH_ERRORS.E_AUTH_REQUIRED };
    const record = this.byFingerprint.get(fingerprintOf(id));
    if (!record) return { ok: false, code: AUTH_ERRORS.E_AUTH_REQUIRED };
    const now = this.now();
    if (now >= record.expiresAt) return { ok: false, code: AUTH_ERRORS.E_SESSION_EXPIRED, expiredAt: record.expiresAt };
    record.lastSeenAt = now;
    record.seen += 1;
    if (this.sliding) record.expiresAt = now + this.ttlMs;
    return { ok: true, record: { ...record } };
  }

  /** 吊销一个会话。返回是否确实存在过（不存在也返回 false，不报错 —— 登出应幂等）  */
  revoke(id: string | null | undefined): boolean {
    if (!id) return false;
    return this.byFingerprint.delete(fingerprintOf(id));
  }

  /** 踢掉某个身份的全部会话（改口令、降权、发现异常时用）。返回踢掉几个 */
  revokeAllFor(actorId: string): number {
    let removed = 0;
    for (const [fingerprint, record] of [...this.byFingerprint]) {
      if (record.actorId === actorId) {
        this.byFingerprint.delete(fingerprint);
        removed += 1;
      }
    }
    return removed;
  }

  /** 当前有效会话数（不含已过期） */
  get size(): number {
    const now = this.now();
    let live = 0;
    for (const record of this.byFingerprint.values()) if (now < record.expiresAt) live += 1;
    return live;
  }

  /** 活跃会话清单（只有指纹，没有 id）。已过期的默认不列  */
  list(includeExpired = false): SessionSummary[] {
    const now = this.now();
    return [...this.byFingerprint.entries()]
      .filter(([, record]) => includeExpired || now < record.expiresAt)
      .map(([fingerprint, record]) => ({ ...record, fingerprint }));
  }

  /** 清理：过期超过宽限期的记录、以及超出上限时最旧的记录。返回清掉几条 */
  sweep(): number {
    const now = this.now();
    let removed = 0;
    for (const [fingerprint, record] of [...this.byFingerprint]) {
      if (now >= record.expiresAt + this.graceMs) {
        this.byFingerprint.delete(fingerprint);
        removed += 1;
      }
    }
    removed += this.enforceCap();
    return removed;
  }

  /** 上限保护：先清过期，再按创建时刻清最旧（不静默丢当前有效的会话，只在上限真的顶住时才丢最旧）  */
  private enforceCap(): number {
    if (this.byFingerprint.size <= this.maxRecords) return 0;
    const now = this.now();
    let removed = 0;
    for (const [fingerprint, record] of [...this.byFingerprint]) {
      if (this.byFingerprint.size <= this.maxRecords) break;
      if (now >= record.expiresAt) {
        this.byFingerprint.delete(fingerprint);
        removed += 1;
      }
    }
    if (this.byFingerprint.size <= this.maxRecords) return removed;
    const ordered = [...this.byFingerprint.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt);
    for (const [fingerprint] of ordered) {
      if (this.byFingerprint.size <= this.maxRecords) break;
      this.byFingerprint.delete(fingerprint);
      removed += 1;
    }
    return removed;
  }
}

/** 会话指纹：与 actor-directory 同一口径（SM3 前 16 位，够比对、不可反推） */
export function fingerprintOf(id: string): string {
  return sm3Hex(utf8(id)).slice(0, 16);
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
