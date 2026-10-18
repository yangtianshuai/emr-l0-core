// 限流：滑动窗口计数。
// 管理员登录完全没有失败次数限制：口令是单一口令（`L0_ADMIN_TOKEN`），
// 口令本身的强度与轮换才是根；

import { AUTH_ERRORS } from './principal.ts';

export interface RateRule {
  /** 窗口内最多几次 */
  limit: number;
  /** 窗口长度（毫秒） */
  windowMs: number;
  /** 这个桶是干什么的（只进拒绝信息，方便运维定位） */
  label: string;
}

export type RateDecision =
  | { ok: true; limit: number; remaining: number }
  | {
      ok: false;
      code: typeof AUTH_ERRORS.E_RATE_LIMITED;
      message: string;
      /** 建议的重试间隔（秒，至少 1）：直接用于 `Retry-After` */
      retryAfterSec: number;
      limit: number;
    };

export interface RateLimiterOptions {
  /** 注入时钟（测试用）。默认 `Date.now` */
  now?: () => number;
  /** 最多记多少个键（超出淘汰最久没命中的） */
  maxKeys?: number;
}

export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  private readonly now: () => number;

  private readonly maxKeys: number;

  constructor(options: RateLimiterOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.maxKeys = options.maxKeys ?? 4096;
  }

  /** 键数量（测试与运维观察用） */
  get keyCount(): number {
    return this.hits.size;
  }

  /** 记一次命中并判定。先判定后记录：被拒的那次不进入窗口（否则拒绝本身会自我延长）  */
  hit(key: string, rule: RateRule): RateDecision {
    this.assertRule(rule);
    const now = this.now();
    const stamps = this.prune(key, rule, now);
    if (stamps.length >= rule.limit) {
      /* 把裁剪后的数组写回去：不写回的话，被拒期间旧时刻会一直留着 */
      this.hits.set(key, stamps);
      return this.deny(rule, stamps, now);
    }
    stamps.push(now);
    this.hits.set(key, stamps);
    this.enforceCap();
    return { ok: true, limit: rule.limit, remaining: rule.limit - stamps.length };
  }

  /** 只判定、不记录（界面可以据此提示"快到了"，而提示不该消耗额度） */
  peek(key: string, rule: RateRule): RateDecision {
    this.assertRule(rule);
    const now = this.now();
    const stamps = this.prune(key, rule, now);
    if (stamps.length >= rule.limit) return this.deny(rule, stamps, now);
    return { ok: true, limit: rule.limit, remaining: rule.limit - stamps.length };
  }

  /** 清掉一个键（例如登录成功后把该身份的失败计数清零：成功不该继续背着失败）  */
  reset(key: string): boolean {
    return this.hits.delete(key);
  }

  /** 清掉全部键（测试与"全部解锁"处置用） */
  resetAll(): void {
    this.hits.clear();
  }

  /** 清理所有键里已出窗口的时刻；没有任何时刻的键整个删掉。返回处理的键数 */
  sweep(): number {
    const now = this.now();
    let touched = 0;
    for (const [key, stamps] of [...this.hits]) {
      const kept = stamps.filter((stamp) => now - stamp < MAX_WINDOW_MS);
      if (kept.length === 0) this.hits.delete(key);
      else if (kept.length !== stamps.length) this.hits.set(key, kept);
      touched += 1;
    }
    return touched;
  }

  private deny(rule: RateRule, stamps: number[], now: number): RateDecision {
    const oldest = stamps[0] ?? now;
    const retryAfterSec = Math.max(1, Math.ceil((oldest + rule.windowMs - now) / 1000));
    return {
      ok: false,
      code: AUTH_ERRORS.E_RATE_LIMITED,
      retryAfterSec,
      limit: rule.limit,
      message: `${rule.label}过于频繁（${Math.round(rule.windowMs / 1000)} 秒内最多 ${rule.limit} 次），请 ${retryAfterSec} 秒后再试`,
    };
  }

  /** 保留窗口内的命中时刻（升序，最长 `limit` 条） */
  private prune(key: string, rule: RateRule, now: number): number[] {
    const stamps = this.hits.get(key) ?? [];
    const windowMs = Math.min(rule.windowMs, MAX_WINDOW_MS);
    return stamps.filter((stamp) => now - stamp < windowMs).slice(-rule.limit);
  }

  private enforceCap(): void {
    if (this.hits.size <= this.maxKeys) return;
    const ordered = [...this.hits.entries()].sort((a, b) => (a[1][a[1].length - 1] ?? 0) - (b[1][b[1].length - 1] ?? 0));
    for (const [key] of ordered) {
      if (this.hits.size <= this.maxKeys) break;
      this.hits.delete(key);
    }
  }

  private assertRule(rule: RateRule): void {
    if (!Number.isInteger(rule.limit) || rule.limit < 1) {
      /* 配置错了必须当场抛：一个"上限为 0 或 NaN"的限流器会静默变成"全部放行"或"全部拦截"  */
      throw new Error(`限流上限必须是正整数，实际 ${String(rule.limit)}（${rule.label}）`);
    }
    if (!Number.isFinite(rule.windowMs) || rule.windowMs <= 0) {
      throw new Error(`限流窗口必须是正数毫秒，实际 ${String(rule.windowMs)}（${rule.label}）`);
    }
  }
}

/** 单个窗口的上限：一天。超过这个值的窗口一律按一天算，防止数组无界增长 */
const MAX_WINDOW_MS = 24 * 60 * 60 * 1000;
