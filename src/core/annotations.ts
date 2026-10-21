import type { ActorId, ISODateTime, NodeId } from '../model/types.ts';

export type AnnotationSeverity = 'info' | 'warn' | 'block';

export type AnnotationStatus = 'open' | 'acknowledged' | 'dismissed' | 'resolved';

export type AnchorState = 'valid' | 'relocated' | 'lost';

export interface AnnotationAnchor {
  nodeId: NodeId;
  quote?: string;
  nodeText?: string;
}

export interface AnnotationSource {
  kind: 'ai' | 'system' | 'human';
  actorId?: ActorId;
  modelId?: string;
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
  kind: 'quality' | 'form' | 'note';
  severity: AnnotationSeverity;
  anchor: AnnotationAnchor;
  title: string;
  detail?: string;
  suggestion?: string;
  source: AnnotationSource;
  evidence?: AnnotationEvidence[];
  dedupeKey?: string;
  status: AnnotationStatus;
  createdAt: ISODateTime;
  history: AnnotationHistoryEntry[];
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
  anchorLost: number;
}

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

  snapshot(): AnnotationBookSnapshot {
    return {
      seq: this.seq,
      items: [...this.items.values()].map((item) => structuredClone(item)),
    };
  }

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

  fingerprint(): string {
    return [...this.items.values()]
      .map((item) => `${item.id}|${item.status}|${item.kind}|${item.anchor.nodeId}`)
      .sort()
      .join(';');
  }
}

export const SEVERITY_IS_DISPLAY_ONLY = true;
