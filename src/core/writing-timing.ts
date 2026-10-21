import type { DocumentModel, ISODateTime, JsonValue, RevisionOp } from '../model/index.ts';

export type TimingClock = 'wall' | 'logical' | 'mixed';

export type TimingActorKind = 'human' | 'ai' | 'system';

export interface WritingTiming {
  clock: TimingClock;
  /** 可否对外报数：只有 `wall` 为真。混用与纯逻辑时钟都不可信（能力矩阵 G9：无可信时间戳） */
  trusted: boolean;
  firstEditAt: ISODateTime | null;
  lastEditAt: ISODateTime | null;
  activeMs: number;
  idleMs: number;
  editCount: number;
  /** 空闲阈值：写进结果里，免得拿到数字的人不知道它是按什么口径算的 */
  idleThresholdMs: number;
  byActor: { human: number; ai: number; system: number };
}

export const WRITING_TIMING_KEY = 'emr.writingTiming';

/** 默认空闲阈值：两分钟没动静就算"不在写" */
export const DEFAULT_IDLE_THRESHOLD_MS = 120_000;

export const TIMED_OPS: ReadonlySet<RevisionOp> = new Set<RevisionOp>([
  'create',
  'insert',
  'update',
  'delete',
  'move',
  'accept-ai',
  'reject-ai',
]);

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
        state.idleMs += gap;
      }
    }
    if (state.firstEditAt === null) state.firstEditAt = at;
    state.lastEditAt = at;
    state.editCount += 1;
  }

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

export function applyWritingTiming(doc: DocumentModel, timing: WritingTiming): DocumentModel {
  return {
    ...doc,
    extensions: { ...(doc.extensions ?? {}), [WRITING_TIMING_KEY]: timing as unknown as JsonValue },
  };
}

export function readWritingTiming(doc: DocumentModel): WritingTiming | null {
  const raw = doc.extensions?.[WRITING_TIMING_KEY];
  if (!raw || typeof raw !== 'object') return null;
  const timing = raw as unknown as WritingTiming;
  if (typeof timing.activeMs !== 'number') return null;
  return timing;
}
