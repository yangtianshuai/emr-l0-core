// 书写时长：口径定义与累计器。
//
// 单独成一个模块（而不是塞进 session.ts）有两个理由：
//   1. 审计报告要读它，若定义在 session.ts 里，审计报告就得反过来依赖整个写会话（连带密码与导出）；
//   2. 口径必须只有一处定义 —— "有效时长/空闲阈值/可信标记"各自解释一遍，迟早对不上。

import type { DocumentModel, ISODateTime, JsonValue, RevisionOp } from '../model/index.ts';

/** 留痕时间的来源 */
export type TimingClock = 'wall' | 'logical' | 'mixed';

/** 与 `Actor.kind` 同构（不 import 是为了不让本模块反向依赖写会话） */
export type TimingActorKind = 'human' | 'ai' | 'system';

/**
 * 书写时长统计。
 *
 * 口径是**有效编辑时长**：相邻两次书写之间的间隔，只有不超过 `idleThresholdMs` 的那部分才累加。
 * 于是"挂机三小时"不会变成三小时工作量，而"连续写了 8 分钟"就是 8 分钟。
 *
 * 它不回答"这份病历有没有按时写完" —— 那是临床时限（入院记录 24h、首次病程 8h…），
 * 由 `src/qc` 的时限类规则管，两者不是一回事，别互相替代。
 */
export interface WritingTiming {
  /**
   * 时间来源。`wall` = 全部提交都用了墙钟；`logical` = 全部走逻辑时钟；
   * `mixed` = 两者混用过（最常见的情况：中途才想起来用真实时钟）。
   */
  clock: TimingClock;
  /** 可否对外报数：只有 `wall` 为真。混用与纯逻辑时钟都不可信（能力矩阵 G9：无可信时间戳） */
  trusted: boolean;
  firstEditAt: ISODateTime | null;
  lastEditAt: ISODateTime | null;
  /** 有效编辑时长（毫秒）：已剔除所有超过阈值的空闲段 */
  activeMs: number;
  /** 被判定为空闲而丢弃的时长（毫秒）。留着是为了让人看见"剔了多少"，而不是悄悄不算 */
  idleMs: number;
  /** 计入时长的书写次数（不含签章/解锁这类非书写动作） */
  editCount: number;
  /** 空闲阈值：写进结果里，免得拿到数字的人不知道它是按什么口径算的 */
  idleThresholdMs: number;
  /** 按操作来源拆分的有效时长（毫秒）：人是人写的，AI 采纳是医生审的 */
  byActor: { human: number; ai: number; system: number };
}

/** 书写时长在 `DocumentModel.extensions` 里的键名（落盘用，见 `applyWritingTiming`） */
export const WRITING_TIMING_KEY = 'emr.writingTiming';

/** 默认空闲阈值：两分钟没动静就算"不在写" */
export const DEFAULT_IDLE_THRESHOLD_MS = 120_000;

/** 计入书写时长的 op：只算真正动内容的，签章/解锁/迁移/整份导入不算"写" */
export const TIMED_OPS: ReadonlySet<RevisionOp> = new Set<RevisionOp>([
  'create',
  'insert',
  'update',
  'delete',
  'move',
  'accept-ai',
  'reject-ai',
]);

/**
 * 书写时长累计器。
 *
 * 只做一件事：每次书写进来时，把"这一段算不算在写"判清楚并记账。
 * 判据只有一个 —— 与上一次书写的间隔是否超过空闲阈值，不多猜（不猜"他在不在屏幕前"）。
 */
export class WritingTimingAccumulator {
  private readonly idleThresholdMs: number;

  private state = {
    firstEditAt: null as ISODateTime | null,
    lastEditAt: null as ISODateTime | null,
    activeMs: 0,
    idleMs: 0,
    editCount: 0,
    byActor: { human: 0, ai: 0, system: 0 },
    sawWall: false,
    sawLogical: false,
  };

  constructor(idleThresholdMs: number = DEFAULT_IDLE_THRESHOLD_MS) {
    this.idleThresholdMs = idleThresholdMs;
  }

  /** 记一笔。非书写类 op 直接忽略；`withWallClock` 说明这笔的时间是不是真实时钟给的 */
  record(op: RevisionOp, kind: TimingActorKind, at: ISODateTime, withWallClock: boolean): void {
    if (!TIMED_OPS.has(op)) return;
    const t = Date.parse(at);
    if (!Number.isFinite(t)) return;
    const state = this.state;
    if (withWallClock) state.sawWall = true;
    else state.sawLogical = true;
    if (state.lastEditAt !== null) {
      const gap = t - Date.parse(state.lastEditAt);
      if (gap > 0 && gap <= this.idleThresholdMs) {
        state.activeMs += gap;
        state.byActor[kind] += gap;
      } else if (gap > 0) {
        /* 超过阈值的整段丢进 idleMs：不猜"他是不是还在写"，只如实记账 */
        state.idleMs += gap;
      }
    }
    if (state.firstEditAt === null) state.firstEditAt = at;
    state.lastEditAt = at;
    state.editCount += 1;
  }

  /** 本次累计结果（拷贝，交给调用方随便看） */
  snapshot(): WritingTiming {
    const state = this.state;
    const clock: TimingClock = state.sawWall && state.sawLogical ? 'mixed' : state.sawWall ? 'wall' : 'logical';
    return {
      clock,
      trusted: clock === 'wall',
      firstEditAt: state.firstEditAt,
      lastEditAt: state.lastEditAt,
      activeMs: state.activeMs,
      idleMs: state.idleMs,
      editCount: state.editCount,
      idleThresholdMs: this.idleThresholdMs,
      byActor: { ...state.byActor },
    };
  }
}

/**
 * 把书写时长写进文档的 `extensions`，好让它跟着文档一起落盘（存 SQLite / 导出 OFD 时都在）。
 *
 * 为什么不是会话自己每次提交都往 `extensions` 里写：那会让每一次编辑都多出一条
 * "改了 extensions"的 patch，留痕里平白多一堆噪音，而真正要的是保存时这一个数。
 *
 * 返回的是新文档（不改入参）：时长是派生数据，不该有"改文档"的副作用。
 */
export function applyWritingTiming(doc: DocumentModel, timing: WritingTiming): DocumentModel {
  return {
    ...doc,
    extensions: { ...(doc.extensions ?? {}), [WRITING_TIMING_KEY]: timing as unknown as JsonValue },
  };
}

/** 从文档里读回书写时长（没有就返回 null —— 老文档本来就没有这一项） */
export function readWritingTiming(doc: DocumentModel): WritingTiming | null {
  const raw = doc.extensions?.[WRITING_TIMING_KEY];
  if (!raw || typeof raw !== 'object') return null;
  const timing = raw as unknown as WritingTiming;
  if (typeof timing.activeMs !== 'number') return null;
  return timing;
}
