/**
 * 限流：滑动窗口计数。给"会被暴力猜、会花钱、会拖垮服务"的动作加代价。
 *
 * ## 它现在补的是哪个洞
 *
 * 管理员登录**完全没有失败次数限制**：口令是单一口令（`L0_ADMIN_TOKEN`），
 * 于是"猜一万次"与"猜一次"的成本一样 —— 这是当前最容易被打穿的一处
 * （审计里会留下失败记录，但审计是**事后**看的，它拦不住正在进行的爆破）。
 * 另外两个接入点是**外呼花钱**的动作：测试连接 / 测试签名，以及导出这类重操作。
 *
 * ## 为什么是滑动窗口，不是固定窗口
 *
 * 固定窗口（每分钟清零）有一个众所周知的缺口：在窗口边界两侧各打满一轮，
 * 瞬时速率是上限的两倍。这里的目的不是精算流量，而是让**爆破变得不划算**，
 * 所以选不会给边界漏洞的实现。代价是每个键要保留窗口内的命中时刻（内存与命中数成正比，
 * 上限就是 `limit`，因为超过就不再记录）。
 *
 * ## 内存与隐私
 *
 *   - 键由调用方给（如 `login:actor:ADMIN`），本模块**只计数、不解释键**；
 *   - 命中时刻**不落盘、不进审计**：限流是运行时的自我约束，不是证据
 *     （把 IP 或身份写进审计需要有依据，见文件末尾边界）；
 *   - 键的数量有上限，超出后淘汰**最久没命中**的键 —— 否则"每个来源一个键"本身就是一条内存耗尽路径。
 *
 * ## 边界（必须一起说）
 *
 * ① 单进程内存态：多实例部署时**每实例各算一份**，真实额度是 N 倍 —— 要准就得靠共享存储；
 * ② 不防"慢速爆破"（每 5 分钟猜 4 次）：限流只能提高成本，不能消除风险，
 *    口令本身的强度与轮换才是根；
 * ③ 只按给定键限流，**不识别代理后真实来源**（`X-Forwarded-For` 可伪造，采信它等于让攻击者自己选桶）。
 */

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

  /** 记一次命中并判定。**先判定后记录**：被拒的那次不进入窗口（否则拒绝本身会自我延长） */
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

  /** 清掉一个键（例如**登录成功后**把该身份的失败计数清零：成功不该继续背着失败） */
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
    /* 窗口最多 `MAX_WINDOW_MS`：避免注入一个超大窗口后，数组无界增长 */
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
      /* 配置错了必须**当场抛**：一个"上限为 0 或 NaN"的限流器会静默变成"全部放行"或"全部拦截" */
      throw new Error(`限流上限必须是正整数，实际 ${String(rule.limit)}（${rule.label}）`);
    }
    if (!Number.isFinite(rule.windowMs) || rule.windowMs <= 0) {
      throw new Error(`限流窗口必须是正数毫秒，实际 ${String(rule.windowMs)}（${rule.label}）`);
    }
  }
}

/** 单个窗口的上限：一天。超过这个值的窗口一律按一天算，防止数组无界增长 */
const MAX_WINDOW_MS = 24 * 60 * 60 * 1000;
