/**
 * T10 · AI 建议存储（SuggestionBook）。
 *
 * 设计要点：
 *   1) **建议不是文档内容**：它独立于节点表存在，因此"生成建议"不落笔、不留痕、不改 rev
 *      —— 门控在"落笔"这一步，不在"生成"这一步（低置信建议照样可以展示给医生看）。
 *   2) 状态机只有三条边：pending → accepted / rejected，且**不可逆**（重复采纳报状态错）。
 *   3) 统计口径固定在存储层（采纳率/修改率/拒绝率），避免各处算法不一致
 *      —— 修改率（医生改稿比例）是最诚实的效果指标，必须只有一种算法。
 *   4) **生成是幂等的**：同目标 + 同文本且那条**仍待处理** → 复用，不新建（见 `add`）。
 *      产出方可以是确定性的（离线模板），而"生成"是医生能连点的动作 ——
 *      不去重的后果不只是列表堆积：`metrics().suggested` 会随点击膨胀，**采纳率/拒绝率跟着失真**。
 *   5) **"改动幅度"同样只有一种算法**（`editRatioOf`）：采纳时把"建议文本 → 落笔文本"
 *      的差异算成一个 0~1 的比例，再分三档（`attribution`）。修改率只能回答"改没改"，
 *      而"改了一个错字"与"整段重写"指向**完全不同的修法**（改提示词 vs 改取数）——
 *      混成一个数字时，模型迭代没有方向。
 */

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
  /**
   * 采纳时被人改过（计入修改率）。
   *
   * ⚠️ 它是 `editRatio > 0` 的**粗粒度投影**，保留是为了兼容既有指标与跨实现指纹；
   * "改得轻还是改得重"要看 `editRatio`（见 `attribution`）。
   */
  modified?: boolean;
  /**
   * 采纳时的**改动幅度**（0~1，编辑距离 / 较长文本长度）。
   *
   * 为什么存比例而不是只存一档标签：分档边界（`SUGGESTION_EDIT_BANDS`）是产品参数，
   * 将来会调；存比例则历史数据能按新边界重新分档，存标签则不能 ——
   * 而"当时那个指标是怎么算出来的"正是这类报表最需要回答的事。
   *
   * **缺省 = 不知道**（老快照、别的实现写入的采纳），**不是**"原样采纳"：
   * 把"不知道"读成"模型写对了"，恰好会让指标向好的一侧偏（见 `attribution`）。
   */
  editRatio?: number;
  /**
   * 组 ID：一次批量提交（`suggestBatch`）产出的一组建议共用同一个 ID。
   *
   * **这是内部操作单元，不是语义**：它只让界面能把"同一批"当成一个整体操作
   * （接受本组 / 忽略本组），**不改变任何单条的门控与统计口径**。
   * 因此它**不参与 `fingerprint()`** —— 否则"批量提交 10 条"与"逐条提交 10 条"
   * 会被判成两个实现有差异，而它们的数据完全相同。
   */
  groupId?: string;
  /**
   * 外部调用关联 ID：由调用方（模型服务）指定，用于把"同一次模型调用"产生的
   * **多组**建议串起来（一次调用可能同时产出正文建议与质控提示 —— 那是两组）。
   *
   * 与 `groupId` **必须分开**：groupId 系统生成、不可伪造，是操作单元；
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

/* ============================ 三级归因（改动幅度） ============================ */

/**
 * 分档边界：改动幅度 ≤ `light` 算**微改**，超过算**大改**。
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

/**
 * **建议文本 → 落笔文本的改动幅度**（编辑距离 / 较长文本长度），0~1。
 *
 * 这是全仓唯一一处"改动幅度"算法：单条采纳与批量采纳都调它，界面与报表只读它的结果。
 * 两处各写一遍的后果不是多打几个字，而是"同一份数据在两张报表上不一样"。
 *
 * ## 为什么是编辑距离，而不是"不同字符数 / 长度差"
 *
 * 要区分的是"改了个错字"与"整句重写"。字符集合差分辨不出顺序与结构：
 * "血压偏高"改成"偏高血压"在集合口径下是 0 改动，而它明明是重写。
 *
 * ## 复杂度
 *
 * 先剥公共前后缀（医生改稿的公共部分通常极长），只对中间那段做 Levenshtein，
 * 且用滚动数组（空间 O(min(n,m))）。上界由 `MAX_SUGGESTION_CHARS` 限住，
 * 而它只在**采纳**这一个动作里跑一次，不在扫描 / 渲染的热路径上。
 */
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

/** 编辑距离：滚动数组，空间 O(min(n,m))。按**码点**比较（调用方已用 `Array.from` 切好） */
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

/**
 * **三级归因**：把"采纳"拆成 原样 / 微改 / 大改。
 *
 * ## 为什么 `metrics().editRate` 不够
 *
 * 修改率把"改了一个错字"和"整段重写"算成同一件事，而这两件事的修法完全不同：
 *   · 微改（措辞、错字、标点）→ **提示词 / 文风**问题；
 *   · 大改（事实、结构、结论）→ **上下文供给**问题（取数没到、模板没给、章节看不出）。
 * 只有一个"修改率"时，这两条改进线永远分不开，模型迭代也就没有方向。
 *
 * ## 四条边界
 *
 * 1) **分母只有采纳**：拒绝不进来 —— 它自己的原因在 `rejectReason`，
 *    与"改了多少"是两回事（混在一起会让人以为"拒绝 = 改得多"）。
 * 2) **`unknown` 单列，不并进任何一档**：老快照 / 别的实现写入的采纳没有 `editRatio`。
 *    把"不知道"读成"原样采纳"，正是本仓库反复拒绝的那种伪装 ——
 *    而且它恰好让指标**向好的一侧**偏（原样采纳看起来是模型表现最好的一档）。
 * 3) **恒等式**：`asIs + light + heavy + unknown === accepted`。界面据此能自查 ——
 *    对不上就是有采纳没被归因，而不是"显示四舍五入的误差"。
 * 4) **占比分母是 `accepted`**（含 `unknown`）：去掉 unknown 再算占比，等于偷偷把
 *    不知道的那部分从分母里拿掉，指标会随"有多少老数据"无声地变好看。
 */
export interface SuggestionAttribution {
  /** 采纳总数（= `metrics().accepted`，两处必然相等） */
  accepted: number;
  /** 原样采纳（`editRatio === 0`）：模型写对了 */
  asIs: number;
  /** 微改（`0 < editRatio ≤ SUGGESTION_EDIT_BANDS.light`） */
  light: number;
  /** 大改（超过边界）：多半是事实或结构不对 */
  heavy: number;
  /** **没有改动幅度记录**的采纳（老快照 / 别的实现写入）——不符合并进任何一档 */
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

/**
 * 组的**派生视图** —— 组本身**不存状态**。
 *
 * 为什么不给组一个 `status`：组状态与条状态一定会不一致（5 条里接受 3 条时，
 * 组是"部分接受"？没有这种状态可用）。一旦引入，就多出一处需要同步的真相，
 * 而它必然会漏同步（界面显示"已处理"、实际还有 pending）。
 * 这里全部由条状态推导，"组是否处理完"即 `pending === 0`。
 */
/** 可持久化的建议快照（见 `SuggestionBook.snapshot`：seq 必须带上） */
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

  /**
   * 生成建议：只进存储，不触碰文档。
   *
   * ## 幂等：同一产出的重复提交 → 复用，不新建（`created: false`）
   *
   * "同一次产出"由四元组认定：**目标节点 + 文本 + 产出方 + 置信度**，且那条**仍待处理**。
   *
   * 为什么必须有：产出方可以是**确定性**的（离线模板同输入同输出；真模型重试也常给出同段文本），
   * 而"生成"是医生**可以连点**的动作。不去重的后果不只是列表堆积 ——
   * `metrics().suggested` 会随点击次数膨胀，**采纳率/拒绝率跟着失真**，而那是要进质量报表的数字。
   * （放界面去重会漏：两个标签页、语音与草稿产出同一段，都不经过同一个界面函数。）
   *
   * 四条边界：
   *   1) 只看**仍待处理**的那条：已被采纳/拒绝的不算重复 —— 医生再点"生成一条"是**主动再要一条**，
   *      旧决定不该把它挡住（挡住的表现是"点了没反应"，比重复更糟）；
   *   2) **产出方与置信度必须一起参与判定**：弱产出方（自报 0.6）与强产出方（0.95）
   *      可能产出**同一段文字**，但那是两次不同的产出、两条不同的门控结论 ——
   *      只按"目标 + 文本"去重会让医生点了"生成"，拿到的却是那条**低于阈值、不能采纳**的旧条目
   *      （`test:ui` 的 B7 正是这个陷阱：取错 id 会静默失败）；
   *   3) **文本不同就是另一条**：产出方换了内容，那就是新建议；
   *   4) 复用**不改原条**：不改 `at` / `confidence` / `modelId` —— 它仍是"那一条"，
   *      不是两次产出的合并（合并会让置信度与产出方都说不清）。
   */
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

  /**
   * 幂等判定的**唯一一处**：仍待处理 + 同目标节点 + 同文本 + 同产出方 + 同置信度。
   *
   * 四元组缺一不可，理由见 `add` 的第 2 条边界 —— 少一项就可能把"另一条产出"当成重复。
   */
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

  /**
   * 批量生成建议：一次调用产出**一组**（共用 `groupId`）。
   *
   * 为什么要分组：语音转写、整篇草稿、批量取数会一次产出十几到几十条建议。
   * 没有组，医生只能逐条点；有了组，界面可提供"接受本组"，而**每条仍各自过门控**。
   *
   * `at` 由调用方统一给出（同一批就是同一时刻），组 ID 由这里生成 ——
   * 调用方不能指定（理由见 `Suggestion.groupId` 注释）。
   *
   * ## 幂等（见 `add`）在建组**之前**做
   *
   * 一次"全是重复"的提交**不建组**（`groupId` 为空），也**不推进 `groupSeq`**：
   * 组是有条数的操作单元，空组会让界面上的"接受本组"落在一个不存在的范围上，
   * 而组号出现空档则会让人以为"少了那组"。
   * 部分重复时，重复的那些**留在它们原来的组里**（复用不改原条），只把新的编入新组。
   */
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

  /**
   * 组的**派生**视图（见 `SuggestionGroup` 注释：组不存状态，全部由条状态推导）。
   * 只遍历一次，不做"每组再扫全表"，因此组数增长不会带来平方复杂度。
   */
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
   * 采纳：记录**改动幅度**（不是"改没改"）。
   *
   * `editRatio` 由调用方用 `editRatioOf()` 算好传入（口径只写一处，见该函数）；
   * `modified` 是它的投影，**不接受单独传入** —— 两个参数一旦能各自传入，
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

  /**
   * **三级归因**（原样 / 微改 / 大改），口径见 `SuggestionAttribution`。
   *
   * 与 `metrics()` 并列而不是塞进 `metrics()` 的返回结构里，有两个理由：
   *   1) `metrics()` 的字段进了跨实现比对（TS 实现 vs 工具链参考实现），
   *      改它的结构会连同**与本次无关的**比对一起改口径；
   *   2) 两者回答的是不同的问题 —— "AI 有没有被采纳"与"采纳之后医生改了多少"。
   *
   * 恒等式：`asIs + light + heavy + unknown === accepted`（有用例守着）。
   */
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
   * ⚠️ **必须带上 `seq` 与 `groupSeq`**：它们决定下一个建议 / 组的 ID。
   * 若只存 `items`，重启后新建议会从 `sg_0001` 重新开始 ——
   * 于是历史留痕里引用的 `aiSuggestionId` 会指向**另一个建议**。
   * 这类"ID 复用"事故不会报错，只会让审计对不上账。
   */
  snapshot(): SuggestionBookSnapshot {
    return {
      seq: this.seq,
      groupSeq: this.groupSeq,
      items: [...this.items.values()].map((item) => structuredClone(item)),
    };
  }

  /** 从快照恢复。**必要字段缺失即抛错**（不猜、不修补 —— 与持久化的严格读一致） */
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
   * **有意不含 `groupId` / `traceId`**：它们是提交方式与调用关联（操作层），不是建议内容。
   * 若纳入，"一方批量提交、另一方逐条提交"会被判成数据差异，而两者的建议完全相同 ——
   * 跨实现比对会退化成"比对提交风格"。**若将来分组影响了语义（例如同组共命运），
   * 必须同步更新这里**，否则指纹会漏掉真正该比的东西。
   */
  fingerprint(): string {
    const projection = this.list()
      .map((item) => `${item.id}|${item.status}|${item.modified === true ? 'M' : '-'}|${item.confidence.toFixed(2)}`)
      .sort()
      .join(';');
    return projection;
  }
}
