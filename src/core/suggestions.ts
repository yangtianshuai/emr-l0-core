// T10 · AI 建议存储（SuggestionBook）。

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
  /**
   * 组 ID：一次批量提交（`suggestBatch`）产出的一组建议共用同一个 ID。
   *
   * 这是内部操作单元，不是语义：它只让界面能把"同一批"当成一个整体操作
   * （接受本组 / 忽略本组），不改变任何单条的门控与统计口径。
   * 因此它不参与 `fingerprint()` —— 否则"批量提交 10 条"与"逐条提交 10 条"
   * 会被判成两个实现有差异，而它们的数据完全相同。
    */
  groupId?: string;
  /**
   * 外部调用关联 ID：由调用方（模型服务）指定，用于把"同一次模型调用"产生的
   * 多组建议串起来（一次调用可能同时产出正文建议与质控提示 —— 那是两组）。
   *
   * 与 `groupId` 必须分开：groupId 系统生成、不可伪造，是操作单元；
   * traceId 调用方给出，仅用于追溯。若让调用方指定 groupId，
   * 两次调用的建议会被错误地并成一组（界面上的"接受本组"会一次落笔两批不相干的建议）。
    */
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
  /** 采纳率 = accepted / suggested */
  adoptionRate: number;
  /** 修改率 = modified / accepted（医生改稿比例） */
  editRate: number;
  /** 拒绝率 = rejected / suggested */
  rejectRate: number;
}

/**
 * 分档边界：改动幅度 ≤ `light` 算微改，超过算大改。
 *
 * 0.2 的含义是"五分之一的字被改动"。定这个数不是为了精确，而是为了让
 * "改错字 / 换措辞"与"重写半句 / 补事实"落在不同的档里 —— 前者改提示词，
 * 后者改上下文供给（取数、模板、章节上下文）。
  */
export const SUGGESTION_EDIT_BANDS = {
  light: 0.2,
} as const;

export type SuggestionEditBand = 'as-is' | 'light' | 'heavy';

/** 把改动幅度分档。`0` 单独成"原样采纳"一档，不与"改得很少"混在一起 */
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

/** 编辑距离：滚动数组，空间 O(min(n,m))。按码点比较（调用方已用 `Array.from` 切好）  */
function levenshtein(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  /* 让较短的做列：滚动数组只需它的长度 */
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
    /* 双缓冲交换：刚算完的行使下一轮的"上一行"。旧 `prev` 转为缓冲，
       它每一格都会被覆写（`curr[0]` 赋值 + j 全遍历），因此不必清空 */
    const reuse = prev;
    prev = curr;
    curr = reuse;
  }
  return prev[short.length];
}

export interface SuggestionAttribution {
  /** 采纳总数（= `metrics().accepted`，两处必然相等） */
  accepted: number;
  /** 原样采纳（`editRatio === 0`）：模型写对了 */
  asIs: number;
  /** 微改（`0 < editRatio ≤ SUGGESTION_EDIT_BANDS.light`） */
  light: number;
  /** 大改（超过边界）：多半是事实或结构不对 */
  heavy: number;
  /** 没有改动幅度记录的采纳（老快照 / 别的实现写入）——不符合并进任何一档  */
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
  /** 由 `addBatch` 统一分配；单条 `add` 不带组 */
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
  /** 组内目标节点（去重），供界面一次性定位/高亮 */
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
      /* 按组号排序：组号递增即提交顺序，界面据此稳定展示（不依赖 Map 插入顺序） */
      .sort((a, b) => a.groupId.localeCompare(b.groupId));
  }

  /**
   * 采纳：记录改动幅度（不是"改没改"）。
   *
   * `editRatio` 由调用方用 `editRatioOf()` 算好传入（口径只写一处，见该函数）；
   * `modified` 是它的投影，不接受单独传入 —— 两个参数一旦能各自传入，
   * 就会出现"说改了、幅度却是 0"这种自相矛盾的记录，而它只会在报表对不上时才被发现。
    */
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

  /**
   * 导出为可持久化的快照。
   *
   *  必须带上 `seq` 与 `groupSeq`：它们决定下一个建议 / 组的 ID。
   * 若只存 `items`，重启后新建议会从 `sg_0001` 重新开始 ——
   * 于是历史留痕里引用的 `aiSuggestionId` 会指向另一个建议。
   * 这类"ID 复用"事故不会报错，只会让审计对不上账。
    */
  snapshot(): SuggestionBookSnapshot {
    return {
      seq: this.seq,
      groupSeq: this.groupSeq,
      items: [...this.items.values()].map((item) => structuredClone(item)),
    };
  }

  /** 从快照恢复。必要字段缺失即抛错（不猜、不修补 —— 与持久化的严格读一致）  */
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

  /**
   * 供跨实现比对使用的稳定投影（顺序固定，避免因插入顺序不同而误判差异）。
   *
   * 有意不含 `groupId` / `traceId`：它们是提交方式与调用关联（操作层），不是建议内容。
   * 若纳入，"一方批量提交、另一方逐条提交"会被判成数据差异，而两者的建议完全相同 ——
   * 跨实现比对会退化成"比对提交风格"。若将来分组影响了语义（例如同组共命运），
   * 必须同步更新这里，否则指纹会漏掉真正该比的东西。
    */
  fingerprint(): string {
    const projection = this.list()
      .map((item) => `${item.id}|${item.status}|${item.modified === true ? 'M' : '-'}|${item.confidence.toFixed(2)}`)
      .sort()
      .join(';');
    return projection;
  }
}
