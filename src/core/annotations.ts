// 旁挂注解（AnnotationBook）：质控提示与人工批注的载体。

import type { ActorId, ISODateTime, NodeId } from '../model/types.ts';

/** 展示级别。当前不参与任何门控（不阻塞签章、不阻塞导出），见文件尾注释。  */
export type AnnotationSeverity = 'info' | 'warn' | 'block';

/**
 * 处置状态。四个状态在质控追责上是本质不同的，不能合并：
 *   `acknowledged`（已知悉但暂不改）与 `resolved`（已按提示修改）的差别，
 *   正是"提示被容忍"与"提示起了作用"的差别。
  */
export type AnnotationStatus = 'open' | 'acknowledged' | 'dismissed' | 'resolved';

export type AnchorState = 'valid' | 'relocated' | 'lost';

export interface AnnotationAnchor {
  nodeId: NodeId;
  /** 提出提示时的原文片段：内容被改写后据此判断"那句话是否还在" */
  quote?: string;
  /** 提出提示时该节点的完整文本：用于判定"内容是否变过"（比哈希更直观、可解释） */
  nodeText?: string;
}

export interface AnnotationSource {
  kind: 'ai' | 'system' | 'human';
  /** human / system 来源必填 */
  actorId?: ActorId;
  /** ai 来源必填（与建议通道同一纪律：无来源的智能提示无法回放与追责） */
  modelId?: string;
  /** system 来源通常给规则号 */
  ruleId?: string;
}

export interface AnnotationEvidence {
  kind: 'data-element' | 'guideline' | 'record' | 'rule' | 'other';
  ref: string;
  detail?: string;
}

export interface AnnotationHistoryEntry {
  status: AnnotationStatus;
  at: ISODateTime;
  by: string;
  note?: string;
}

export interface Annotation {
  id: string;
  /** 语义类别：`quality` 内涵质控 / `form` 形式质控 / `note` 人工批注 */
  kind: 'quality' | 'form' | 'note';
  severity: AnnotationSeverity;
  anchor: AnnotationAnchor;
  /** 一句话结论（界面主行） */
  title: string;
  detail?: string;
  /** 建议怎么改（可为空：质控提示不一定给出改法） */
  suggestion?: string;
  source: AnnotationSource;
  /**
   * 依据。AI / 规则来源必须给（`evidence` 或 `source.ruleId` 二者之一）：
   * 无依据的质控提示无法复核 —— 医生只能选择"信"或"不信"，那是在消耗信任。
    */
  evidence?: AnnotationEvidence[];
  dedupeKey?: string;
  status: AnnotationStatus;
  createdAt: ISODateTime;
  /** 处置史 —— 留全（与建议的"消解即移除"相反，这是质控可追溯的载体）  */
  history: AnnotationHistoryEntry[];
  /** 锚点丢失后，由人工确认"已随内容清除"的时间 */
  anchorLostAt?: ISODateTime;
}

export interface AnnotationInput {
  kind: Annotation['kind'];
  severity: AnnotationSeverity;
  anchor: AnnotationAnchor;
  title: string;
  detail?: string;
  suggestion?: string;
  source: AnnotationSource;
  evidence?: AnnotationEvidence[];
  dedupeKey?: string;
  at: ISODateTime;
}

export interface AnnotationBookSnapshot {
  seq: number;
  items: Annotation[];
}

export interface AnnotationCounts {
  total: number;
  open: number;
  acknowledged: number;
  dismissed: number;
  resolved: number;
  /** 锚点已丢失（须人工确认"已随内容清除"，不能静默消失） */
  anchorLost: number;
}

/**
 * 存储 + 状态机。不做锚点求值（那需要当前文档），由 `Session` 负责。
  */
export class AnnotationBook {
  private readonly items = new Map<string, Annotation>();

  private seq = 0;

  add(input: AnnotationInput): { annotation: Annotation; created: boolean } {
    if (input.dedupeKey) {
      const existing = [...this.items.values()].find((item) => item.dedupeKey === input.dedupeKey);
      if (existing) {
        const sameContent = existing.anchor.nodeText === input.anchor.nodeText;
        if (existing.status !== 'dismissed' || sameContent) {
          return { annotation: existing, created: false };
        }
      }
    }
    this.seq += 1;
    const annotation: Annotation = {
      id: `an_${String(this.seq).padStart(4, '0')}`,
      kind: input.kind,
      severity: input.severity,
      anchor: { ...input.anchor },
      title: input.title,
      ...(input.detail ? { detail: input.detail } : {}),
      ...(input.suggestion ? { suggestion: input.suggestion } : {}),
      source: { ...input.source },
      ...(input.evidence && input.evidence.length > 0 ? { evidence: input.evidence } : {}),
      ...(input.dedupeKey ? { dedupeKey: input.dedupeKey } : {}),
      status: 'open',
      createdAt: input.at,
      history: [{ status: 'open', at: input.at, by: input.source.actorId ?? input.source.modelId ?? input.source.ruleId ?? 'unknown' }],
    };
    this.items.set(annotation.id, annotation);
    return { annotation, created: true };
  }

  get(id: string): Annotation | undefined {
    return this.items.get(id);
  }

  list(filter: { status?: AnnotationStatus; kind?: Annotation['kind']; nodeId?: NodeId } = {}): Annotation[] {
    return [...this.items.values()].filter(
      (item) =>
        (!filter.status || item.status === filter.status) &&
        (!filter.kind || item.kind === filter.kind) &&
        (!filter.nodeId || item.anchor.nodeId === filter.nodeId),
    );
  }

  /** 状态流转：`open` → `acknowledged` / `dismissed` / `resolved`；后两者为终态（不可逆） */
  transition(id: string, status: AnnotationStatus, by: string, at: ISODateTime, note?: string): Annotation | undefined {
    const item = this.items.get(id);
    if (!item) return undefined;
    item.status = status;
    item.history.push({ status, at, by, ...(note ? { note } : {}) });
    return item;
  }

  markAnchorLost(id: string, at: ISODateTime): void {
    const item = this.items.get(id);
    if (item) item.anchorLostAt = at;
  }

  size(): number {
    return this.items.size;
  }

  /**
   * 导出为可持久化的快照。
   *
   * 注解的处置史（`history`）必须完整带上 —— 它是质控可追溯的唯一载体，
   * 丢一条就少一环证据链。同样必须带 `seq`：ID 复用会让"这条提示当时是谁处理的"对不上。
    */
  snapshot(): AnnotationBookSnapshot {
    return {
      seq: this.seq,
      items: [...this.items.values()].map((item) => structuredClone(item)),
    };
  }

  /** 从快照恢复。必要字段缺失即抛错（不猜、不修补）  */
  static restore(snapshot: AnnotationBookSnapshot): AnnotationBook {
    if (!snapshot || !Array.isArray(snapshot.items)) {
      throw new Error('注解快照结构非法：缺少 items');
    }
    if (!Number.isInteger(snapshot.seq)) {
      throw new Error('注解快照结构非法：缺少 seq（缺了会导致 ID 复用）');
    }
    const book = new AnnotationBook();
    for (const item of snapshot.items) {
      if (!item || typeof item.id !== 'string' || !item.anchor || !Array.isArray(item.history)) {
        throw new Error(`注解快照含非法条目：${JSON.stringify(item).slice(0, 80)}`);
      }
      book.items.set(item.id, structuredClone(item));
    }
    book.seq = snapshot.seq;
    return book;
  }

  /** 供跨实现比对使用的稳定投影（不含锚点派生状态 —— 那取决于文档，不属于注解自身） */
  fingerprint(): string {
    return [...this.items.values()]
      .map((item) => `${item.id}|${item.status}|${item.kind}|${item.anchor.nodeId}`)
      .sort()
      .join(';');
  }
}

/**
 * 关于 `severity: 'block'` 的明确边界：它目前只是一个展示级别。
 *
 * 不参与签章门控、不拦截任何写操作。原因：把"某条规则是否应该阻止签章"这个判断
 * 交给提示本身，等于让规则库间接拥有了流程控制权 —— 一旦某条规则误报，
 * 病历就签不出去，而临床不会等规则。要阻塞，必须是显式配置的独立机制，
 * 不该从提示级别里隐式长出来。
  */
export const SEVERITY_IS_DISPLAY_ONLY = true;
