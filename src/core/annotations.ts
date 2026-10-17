/**
 * 旁挂注解（AnnotationBook）：**质控提示与人工批注的载体**。
 *
 * 与建议通道（`suggestions.ts`）的关系 —— 同源，但留存策略相反：
 *
 * | | 建议（SuggestionBook） | 注解（AnnotationBook） |
 * |---|---|---|
 * | 落点 | AI 想替你写的**内容** | 对**已有内容**的判断与提示 |
 * | 生命周期 | 短：采纳/拒绝后从活跃集移除 | **长：永不消失** |
 * | 处置后 | 只留计数与统计（采纳率是聚合量） | **留全处置史**（"提示过什么、谁怎么处理"就是证据链） |
 * | 参与者 | 医生 + AI | 医生 + 质控员 + 规则引擎 |
 * | 正文关系 | 采纳时**进正文** | **永进不了正文** |
 * | 签名覆盖 | 不覆盖（未采纳时） | **不覆盖**，且处置过程也不进文档留痕（见下） |
 *
 * ## 三条不可动摇的规则
 *
 * 1) **注解不是文档内容**：它不参与 `doc.nodes`、不进机读信息、不进签名范围、不随导出。
 *    若把质控提示塞进文档树，签章后它将无法再被标记"已处理"（签章后文档不可改），
 *    质控就变成了"一次性提示"而不是可追踪的流程。
 *
 * 2) **处置过程不进 `doc.revisions`**：`revisions` 的语义是"**文档内容**的变更记录"，
 *    机读信息陈旧判定、内容快照、`verifyInvariants` 全都建立在"rev 变化 ⇒ 文档变了"之上。
 *    把"某人把某条提示标为忽略"混进去，会让这个前提失效 ——
 *    那时"机读信息是否陈旧"就开始误报了。因此处置史留在**注解自己**的 `history` 里，
 *    文档内容一位都不动（`docRev` 不变）。
 *
 * 3) **锚点状态不存进存储，而是每次查询时对当前文档求值**（见 `Session.listAnnotations`）。
 *    与"组不存状态"同一理由：多一处需要同步的真相，就必然漏同步。
 *    节点被删改是**外部**事件，存储里的快照不可能知道 —— 只能查的时候算。
 */

import type { ActorId, ISODateTime, NodeId } from '../model/types.ts';

/** 展示级别。**当前不参与任何门控**（不阻塞签章、不阻塞导出），见文件尾注释。 */
export type AnnotationSeverity = 'info' | 'warn' | 'block';

/**
 * 处置状态。四个状态在质控追责上是**本质不同**的，不能合并：
 *   `acknowledged`（已知悉但暂不改）与 `resolved`（已按提示修改）的差别，
 *   正是"提示被容忍"与"提示起了作用"的差别。
 */
export type AnnotationStatus = 'open' | 'acknowledged' | 'dismissed' | 'resolved';

/**
 * 锚点状态 —— **派生值**，不存进存储（见文件头规则 3）：
 *   `valid`      锚点有效：节点在，且内容与提出提示时一致（或原文片段仍在）；
 *   `relocated`  内容已被改写，但提示针对的**原文片段仍能找到** → 可重锚；
 *   `lost`       节点已删，或内容被整段改写、原文已不存在 → 需人工确认"已随内容清除"。
 */
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
   * 依据。**AI / 规则来源必须给**（`evidence` 或 `source.ruleId` 二者之一）：
   * 无依据的质控提示无法复核 —— 医生只能选择"信"或"不信"，那是在消耗信任。
   */
  evidence?: AnnotationEvidence[];
  /** 去重键：同源同锚点同规则只保留一条（见 `AnnotationBook.add`） */
  dedupeKey?: string;
  status: AnnotationStatus;
  createdAt: ISODateTime;
  /** 处置史 —— **留全**（与建议的"消解即移除"相反，这是质控可追溯的载体） */
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

/** 可持久化的注解快照（见 `AnnotationBook.snapshot`：history 与 seq 都必须带上） */
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
 * 存储 + 状态机。**不做锚点求值**（那需要当前文档），由 `Session` 负责。
 */
export class AnnotationBook {
  private readonly items = new Map<string, Annotation>();

  private seq = 0;

  /**
   * 新增注解。返回 `created=false` 表示命中去重、未新增（调用方据此避免重复提示）。
   *
   * 去重规则（三条，缺一条都会让质控变成骚扰）：
   *   1) 给了 `dedupeKey` 且已存在同键记录、且那条**未被忽略** → 不新增；
   *   2) 若那条已被 `dismissed`（医生判过误报）→ **不复活**；
   *      "每 5 分钟重跑一次规则"最忌讳的就是把误报反复弹回来 ——
   *      医生一旦开始无脑点"忽略"，整套质控的提示都会失去意义；
   *   3) **但内容变了就允许新增**：`dismissed` 是针对**当时那段文字**的判定，
   *      文字被改写后再命中规则，是一条新提示（旧判断不适用于新内容）。
   */
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

  /** 人工确认"锚点已随内容清除"（防止注解静默消失，见 `Session.listAnnotations`） */
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
   * 注解的**处置史（`history`）必须完整带上** —— 它是质控可追溯的唯一载体，
   * 丢一条就少一环证据链。同样必须带 `seq`：ID 复用会让"这条提示当时是谁处理的"对不上。
   */
  snapshot(): AnnotationBookSnapshot {
    return {
      seq: this.seq,
      items: [...this.items.values()].map((item) => structuredClone(item)),
    };
  }

  /** 从快照恢复。**必要字段缺失即抛错**（不猜、不修补） */
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
 * 关于 `severity: 'block'` 的**明确边界**：它目前只是一个展示级别。
 *
 * 不参与签章门控、不拦截任何写操作。原因：把"某条规则是否应该阻止签章"这个判断
 * 交给提示本身，等于让规则库间接拥有了流程控制权 —— 一旦某条规则误报，
 * 病历就签不出去，而临床不会等规则。要阻塞，必须是**显式配置**的独立机制，
 * 不该从提示级别里隐式长出来。
 */
export const SEVERITY_IS_DISPLAY_ONLY = true;
