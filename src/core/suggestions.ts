import type { ActorId, EvidenceRef, ISODateTime, NodeId } from '../model/types.ts';

export type SuggestionStatus = 'pending' | 'accepted' | 'rejected';

export interface Suggestion {
  id: string;
  targetNodeId: NodeId;
  text: string;
  /** 0~1；低于阈值不得落笔（阈值由会话按"是否关键内容"决定） */
  confidence: number;
  modelId: string;
  promptId?: string;
  evidence?: EvidenceRef[];
  status: SuggestionStatus;
  modified?: boolean;
  editRatio?: number;
  groupId?: string;
  traceId?: string;
  at: ISODateTime;
  acceptedBy?: ActorId;
  acceptedAt?: ISODateTime;
  rejectedBy?: ActorId;
  rejectedAt?: ISODateTime;
  rejectReason?: string;
}

export interface SuggestionMetrics {
  suggested: number;
  accepted: number;
  rejected: number;
  modified: number;
  adoptionRate: number;
  editRate: number;
  rejectRate: number;
}

export const SUGGESTION_EDIT_BANDS = {
  light: 0.2,
} as const;

export type SuggestionEditBand = 'as-is' | 'light' | 'heavy';

export function editBandOf(ratio: number): SuggestionEditBand {
  if (!Number.isFinite(ratio) || ratio <= 0) return 'as-is';
  return ratio <= SUGGESTION_EDIT_BANDS.light ? 'light' : 'heavy';
}

export function editRatioOf(suggested: string, final: string): number {
  if (suggested === final) return 0;
  const a = Array.from(suggested);
  const b = Array.from(final);
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 0;
  if (a.length === 0 || b.length === 0) return 1;
  let start = 0;
  const shortest = Math.min(a.length, b.length);
  while (start < shortest && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  return levenshtein(a.slice(start, endA), b.slice(start, endB)) / longest;
}

function levenshtein(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const short = a.length <= b.length ? a : b;
  const long = a.length <= b.length ? b : a;
  let prev = Array.from({ length: short.length + 1 }, (_, index) => index);
  let curr = new Array<number>(short.length + 1).fill(0);
  for (let i = 1; i <= long.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= short.length; j += 1) {
      const cost = long[i - 1] === short[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    const reuse = prev;
    prev = curr;
    curr = reuse;
  }
  return prev[short.length];
}

export interface SuggestionAttribution {
  accepted: number;
  asIs: number;
  light: number;
  heavy: number;
  unknown: number;
  asIsShare: number;
  lightShare: number;
  heavyShare: number;
}

export interface SuggestionInput {
  targetNodeId: NodeId;
  text: string;
  confidence: number;
  modelId: string;
  promptId?: string;
  evidence?: EvidenceRef[];
  groupId?: string;
  traceId?: string;
  at: ISODateTime;
}

export interface SuggestionBatchInput {
  targetNodeId: NodeId;
  text: string;
  confidence: number;
  modelId: string;
  promptId?: string;
  evidence?: EvidenceRef[];
}

export interface SuggestionBookSnapshot {
  seq: number;
  groupSeq: number;
  items: Suggestion[];
}

export interface SuggestionGroup {
  groupId: string;
  traceId?: string;
  total: number;
  pending: number;
  accepted: number;
  rejected: number;
  targetNodeIds: NodeId[];
  firstAt: ISODateTime;
  lastAt: ISODateTime;
}

export class SuggestionBook {
  private readonly items = new Map<string, Suggestion>();

  private seq = 0;

  private groupSeq = 0;

  add(input: SuggestionInput): { suggestion: Suggestion; created: boolean } {
    const existing = this.findPendingDuplicate(input.targetNodeId, input.text, input.modelId, input.confidence);
    if (existing) return { suggestion: existing, created: false };
    this.seq += 1;
    const id = `sg_${String(this.seq).padStart(4, '0')}`;
    const suggestion: Suggestion = {
      id,
      targetNodeId: input.targetNodeId,
      text: input.text,
      confidence: input.confidence,
      modelId: input.modelId,
      ...(input.promptId ? { promptId: input.promptId } : {}),
      ...(input.evidence && input.evidence.length > 0 ? { evidence: input.evidence } : {}),
      status: 'pending',
      modified: false,
      ...(input.groupId ? { groupId: input.groupId } : {}),
      ...(input.traceId ? { traceId: input.traceId } : {}),
      at: input.at,
    };
    this.items.set(id, suggestion);
    return { suggestion, created: true };
  }

  private findPendingDuplicate(targetNodeId: NodeId, text: string, modelId: string, confidence: number): Suggestion | undefined {
    for (const item of this.items.values()) {
      if (
        item.status === 'pending' &&
        item.targetNodeId === targetNodeId &&
        item.text === text &&
        item.modelId === modelId &&
        item.confidence === confidence
      ) {
        return item;
      }
    }
    return undefined;
  }

  addBatch(
    inputs: SuggestionBatchInput[],
    at: ISODateTime,
    traceId?: string,
  ): { groupId: string | undefined; suggestionIds: string[]; reused: string[] } {
    const fresh: SuggestionBatchInput[] = [];
    const reused: string[] = [];
    for (const input of inputs) {
      const duplicate = this.findPendingDuplicate(input.targetNodeId, input.text, input.modelId, input.confidence);
      if (duplicate) reused.push(duplicate.id);
      else fresh.push(input);
    }
    if (fresh.length === 0) return { groupId: undefined, suggestionIds: [], reused };
    this.groupSeq += 1;
    const groupId = `grp_${String(this.groupSeq).padStart(4, '0')}`;
    const suggestionIds = fresh.map(
      (input) =>
        this.add({
          ...input,
          groupId,
          ...(traceId ? { traceId } : {}),
          at,
        }).suggestion.id,
    );
    return { groupId, suggestionIds, reused };
  }

  get(id: string): Suggestion | undefined {
    return this.items.get(id);
  }

  list(filter: { status?: SuggestionStatus; targetNodeId?: NodeId; groupId?: string } = {}): Suggestion[] {
    return [...this.items.values()].filter(
      (item) =>
        (!filter.status || item.status === filter.status) &&
        (!filter.targetNodeId || item.targetNodeId === filter.targetNodeId) &&
        (!filter.groupId || item.groupId === filter.groupId),
    );
  }

  listGroups(): SuggestionGroup[] {
    const buckets = new Map<string, Suggestion[]>();
    for (const item of this.items.values()) {
      if (!item.groupId) continue;
      const bucket = buckets.get(item.groupId);
      if (bucket) bucket.push(item);
      else buckets.set(item.groupId, [item]);
    }
    return [...buckets.entries()]
      .map(([groupId, items]) => {
        const accepted = items.filter((item) => item.status === 'accepted').length;
        const rejected = items.filter((item) => item.status === 'rejected').length;
        const ats = items.map((item) => item.at).sort();
        const head = items[0] as Suggestion;
        return {
          groupId,
          ...(head.traceId ? { traceId: head.traceId } : {}),
          total: items.length,
          pending: items.length - accepted - rejected,
          accepted,
          rejected,
          targetNodeIds: [...new Set(items.map((item) => item.targetNodeId))],
          firstAt: ats[0] as ISODateTime,
          lastAt: ats[ats.length - 1] as ISODateTime,
        };
      })
      .sort((a, b) => a.groupId.localeCompare(b.groupId));
  }

  markAccepted(id: string, actor: ActorId, at: ISODateTime, editRatio: number): void {
    const item = this.items.get(id);
    if (!item) return;
    item.status = 'accepted';
    item.modified = editRatio > 0;
    item.editRatio = editRatio;
    item.acceptedBy = actor;
    item.acceptedAt = at;
  }

  markRejected(id: string, actor: ActorId, at: ISODateTime, reason?: string): void {
    const item = this.items.get(id);
    if (!item) return;
    item.status = 'rejected';
    item.rejectedBy = actor;
    item.rejectedAt = at;
    if (reason) item.rejectReason = reason;
  }

  size(): number {
    return this.items.size;
  }

  metrics(): SuggestionMetrics {
    const all = [...this.items.values()];
    const accepted = all.filter((item) => item.status === 'accepted');
    const rejected = all.filter((item) => item.status === 'rejected');
    const modified = accepted.filter((item) => item.modified === true);
    const ratio = (numerator: number, denominator: number): number => (denominator === 0 ? 0 : numerator / denominator);
    return {
      suggested: all.length,
      accepted: accepted.length,
      rejected: rejected.length,
      modified: modified.length,
      adoptionRate: ratio(accepted.length, all.length),
      editRate: ratio(modified.length, accepted.length),
      rejectRate: ratio(rejected.length, all.length),
    };
  }

  attribution(): SuggestionAttribution {
    const accepted = [...this.items.values()].filter((item) => item.status === 'accepted');
    let asIs = 0;
    let light = 0;
    let heavy = 0;
    let unknown = 0;
    for (const item of accepted) {
      if (item.editRatio === undefined) {
        unknown += 1;
        continue;
      }
      switch (editBandOf(item.editRatio)) {
        case 'as-is':
          asIs += 1;
          break;
        case 'light':
          light += 1;
          break;
        default:
          heavy += 1;
      }
    }
    const share = (value: number): number => (accepted.length === 0 ? 0 : value / accepted.length);
    return {
      accepted: accepted.length,
      asIs,
      light,
      heavy,
      unknown,
      asIsShare: share(asIs),
      lightShare: share(light),
      heavyShare: share(heavy),
    };
  }

  snapshot(): SuggestionBookSnapshot {
    return {
      seq: this.seq,
      groupSeq: this.groupSeq,
      items: [...this.items.values()].map((item) => structuredClone(item)),
    };
  }

  static restore(snapshot: SuggestionBookSnapshot): SuggestionBook {
    if (!snapshot || !Array.isArray(snapshot.items)) {
      throw new Error('建议快照结构非法：缺少 items');
    }
    if (!Number.isInteger(snapshot.seq) || !Number.isInteger(snapshot.groupSeq)) {
      throw new Error('建议快照结构非法：缺少 seq / groupSeq（缺了会导致 ID 复用）');
    }
    const book = new SuggestionBook();
    for (const item of snapshot.items) {
      if (!item || typeof item.id !== 'string' || !Number.isFinite(item.confidence)) {
        throw new Error(`建议快照含非法条目：${JSON.stringify(item).slice(0, 80)}`);
      }
      book.items.set(item.id, structuredClone(item));
    }
    book.seq = snapshot.seq;
    book.groupSeq = snapshot.groupSeq;
    return book;
  }

  fingerprint(): string {
    const projection = this.list()
      .map((item) => `${item.id}|${item.status}|${item.modified === true ? 'M' : '-'}|${item.confidence.toFixed(2)}`)
      .sort()
      .join(';');
    return projection;
  }
}
