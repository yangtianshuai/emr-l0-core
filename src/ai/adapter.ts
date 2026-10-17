/**
 * 模型适配器：**内核与模型之间的那一道边界**。
 *
 * 它只做一件事：吃进**已脱敏**的上下文包，吐出**建议条目**。
 *
 * ## 为什么签名里没有 session
 *
 * 适配器**拿不到 `WriteSession`**。想要上下文，就得走 `buildAiContext`（脱敏 + 预算 + 审计回执）；
 * 想让内容落笔，就得回到 `suggestBatch`（身份、门控、留痕）。这不是为了"看起来干净"：
 * 只要适配器能自由读文档，"脱敏上下文"就从机制退化成一句**自愿遵守的约定**，
 * 而没有任何一处能证明它被遵守了。
 *
 * 同理，`allowedNodeIds` 必须由调用方从**这次打包的上下文**里取，
 * 而不是"让模型自己说要落在哪一段"。
 *
 * ## 为什么产出必须过校验
 *
 * 模型返回的是**外部输入**，与 HTTP 请求体同级，不能直接当建议用。
 * 尤其 `confidence`：项目里已经踩过一次 —— 只判 `typeof === 'number'` 会让 `NaN` 通过，
 * 而 `NaN < threshold` 恒为 false，于是**低质量建议直接绕过置信度门控落笔**（两套实现都中招）。
 * 这里再防一次，而且比内核更早：宁可在此处报错，也不要让它进入建议集。
 *
 * ## 失败一律不落笔
 *
 * 超时、HTTP 错误、JSON 解析失败、校验失败 —— 结果都是"没有产出"：
 * 不产生建议、不留痕、不改 rev。这与"批量采纳一条都没落笔时不提交"是同一条纪律。
 */

import type { AiContextPackage } from '../core/ai-context.ts';
import type { NodeId } from '../model/types.ts';

/** 产出方式只影响提示词，不改变通道：三种方式在内核里都是同一条建议通道 */
export type AiSuggestionMode = 'complete' | 'draft' | 'polish';

export interface AiSuggestRequest {
  /** 已脱敏的上下文（由 `buildAiContext` 产出）。适配器看不到文档本身 */
  context: AiContextPackage;
  mode: AiSuggestionMode;
  /** 只允许建议落在这些节点上：模型返回的 nodeId 不在其中即判定为幻觉 */
  allowedNodeIds: NodeId[];
  maxItems: number;
  /** 关联 ID：写进 `traceId`，用于把"某次模型调用"与"某批建议"对上 */
  traceId?: string;
  signal?: AbortSignal;
}

export interface AiSuggestionDraft {
  nodeId: NodeId;
  text: string;
  confidence: number;
  /** 模型给出的理由（可选）。**仅供展示与排查，不是 evidence** —— 自由文本无法逐句回溯 */
  rationale?: string;
}

export interface AiSuggestResponse {
  items: AiSuggestionDraft[];
  /**
   * 实际产出方，写进 `suggestBatch` 的 `modelId`。
   * **由适配器如实报告**（它知道自己是谁），不由调用方传入 —— 否则"是谁写的"可以被伪造。
   */
  modelId: string;
  promptId?: string;
  usage: { latencyMs: number; inputChars?: number; outputChars?: number };
  /**
   * 产出方对"**哪些目标节点我没写、为什么**"的自述。
   *
   * ⚠️ **原始值，未经校验**：它与 HTTP 响应体同级（适配器可能只是把模型 JSON 原样搬过来），
   * 所以必须过 `resolveSilenceReport` 才能用 —— 那份校验挡的是"跳过声明本身就在说谎"
   * （幻觉 nodeId、与产出自相矛盾、自创原因码）。
   *
   * 它是**可选的**：产出方不说，内核会按"未说明"补记（见 `resolveSilenceReport`）。
   * 也就是说，"没填"不会让沉默消失，只会让理由变成"产出方没有说明" ——
   * 这正是本仓库一贯的姿态：不知道可以说不知道，但不能因此不报。
   */
  skipped?: unknown;
}

export interface AiAdapter {
  readonly id: string;
  suggest(request: AiSuggestRequest): Promise<AiSuggestResponse>;
}

/** 单条建议的长度上限：超过它的"建议"多半是模型把整篇输出了，不是一条建议 */
export const MAX_SUGGESTION_CHARS = 4000;

export type AiOutputErrorCode =
  | 'E_AI_OUTPUT_NOT_ARRAY'
  | 'E_AI_OUTPUT_EMPTY'
  | 'E_AI_OUTPUT_TOO_MANY'
  | 'E_AI_OUTPUT_UNKNOWN_NODE'
  | 'E_AI_OUTPUT_BAD_TEXT'
  | 'E_AI_OUTPUT_BAD_CONFIDENCE';

export class AiOutputError extends Error {
  code: AiOutputErrorCode;

  constructor(code: AiOutputErrorCode, message: string) {
    super(message);
    this.name = 'AiOutputError';
    this.code = code;
  }
}

/**
 * 校验并规范化模型产出。**不合法就抛错，不做"尽力修补"**。
 *
 * 逐条理由：
 *   - `nodeId` 必须在 `allowedNodeIds` 内：模型很容易"顺手"给出一个上下文里出现过、
 *     但**不属于本次范围**的 id（例如上文里的节点）。真按它落笔，就是写到了别的段落上；
 *   - `confidence` 必须**有限**且 0~1：NaN / Infinity / 字符串都会绕过门控（见文件头）；
 *   - `text` 非空且有上限：空建议会让医生点了个"采纳"却什么也没发生；
 *   - 条数超限**报错而非截断**：静默截断会让人以为"模型只产出了这么多"，
 *     而实际是系统丢掉的 —— 那正是本项目反复避开的那类伪装。
 */
export function validateSuggestions(raw: unknown, request: AiSuggestRequest): AiSuggestionDraft[] {
  if (!Array.isArray(raw)) {
    throw new AiOutputError('E_AI_OUTPUT_NOT_ARRAY', `模型产出必须是数组，实际 ${typeof raw}`);
  }
  if (raw.length === 0) {
    throw new AiOutputError('E_AI_OUTPUT_EMPTY', '模型没有产出任何建议（空产出不是"没有建议"，而是这次调用失败了）');
  }
  if (raw.length > request.maxItems) {
    throw new AiOutputError(
      'E_AI_OUTPUT_TOO_MANY',
      `模型产出了 ${raw.length} 条，超过上限 ${request.maxItems}：不静默截断（截断会让人以为模型只产出了这些）`,
    );
  }
  const allowed = new Set<string>(request.allowedNodeIds);
  const seen = new Set<string>();
  const items: AiSuggestionDraft[] = [];
  raw.forEach((entry, index) => {
    const at = `第 ${index + 1} 条`;
    if (!entry || typeof entry !== 'object') throw new AiOutputError('E_AI_OUTPUT_NOT_ARRAY', `${at}：不是对象`);
    const candidate = entry as Record<string, unknown>;
    const nodeId = candidate.nodeId;
    if (typeof nodeId !== 'string' || nodeId === '') {
      throw new AiOutputError('E_AI_OUTPUT_UNKNOWN_NODE', `${at}：缺少 nodeId`);
    }
    if (!allowed.has(nodeId)) {
      throw new AiOutputError(
        'E_AI_OUTPUT_UNKNOWN_NODE',
        `${at}：nodeId ${nodeId} 不在本次允许范围内（模型常见的"顺手引用了上文节点"就属于这一类，不能按它落笔）`,
      );
    }
    const text = candidate.text;
    if (typeof text !== 'string' || text.trim() === '') {
      throw new AiOutputError('E_AI_OUTPUT_BAD_TEXT', `${at}：text 不能为空（空建议会让医生点了采纳却什么也没发生）`);
    }
    if (text.length > MAX_SUGGESTION_CHARS) {
      throw new AiOutputError('E_AI_OUTPUT_BAD_TEXT', `${at}：text 长度 ${text.length} 超过上限 ${MAX_SUGGESTION_CHARS}`);
    }
    const confidence = candidate.confidence;
    if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      throw new AiOutputError(
        'E_AI_OUTPUT_BAD_CONFIDENCE',
        `${at}：confidence 必须是 0~1 的有限数，实际 ${JSON.stringify(confidence)}（NaN 与越界值会绕过置信度门控）`,
      );
    }
    /* 同节点同文本只留一条：模型重复输出很常见，重复项会让"本组 3 条"里有一条是废话 */
    const key = `${nodeId}\u0000${text}`;
    if (seen.has(key)) return;
    seen.add(key);
    const draft: AiSuggestionDraft = { nodeId, text, confidence };
    const rationale = candidate.rationale;
    if (typeof rationale === 'string' && rationale.trim() !== '') draft.rationale = rationale;
    items.push(draft);
  });
  return items;
}

/**
 * 从上下文包里取"本次允许建议落在哪些节点上"。
 *
 * **有意只取目标类节点**（`role === 'target'`）：`before` / `after` 是**给模型看的背景**，
 * 不是让模型去改写的地方。若把它们也放进允许集，模型"顺手把上文也润色一遍"就成了合法产出 ——
 * 那会变成医生只点了"续写本段"，却收到对上一段的改写建议。
 */
export function targetNodeIdsOf(context: AiContextPackage): NodeId[] {
  return context.items.filter((item) => item.role === 'target').map((item) => item.nodeId);
}

/* ========================== 沉默的可解释性 ========================== */

/**
 * 产出方可用的**封闭**原因码。
 *
 * 为什么要封闭：这份清单是**调优燃料** —— "现有信息不足"与"该节点不需要建议"
 * 要改的东西完全不同（前者改取数 / 上下文供给，后者改提示词或产出范围）。
 * 一旦允许自创原因码，聚合就退化成"一堆各说各话的自由文本"，
 * 那正是这条通道最没用的时候。
 */
export type AiSkipCode = 'insufficient-context' | 'not-applicable' | 'existing-content' | 'other';

export const AI_SKIP_CODES: readonly AiSkipCode[] = [
  'insufficient-context',
  'not-applicable',
  'existing-content',
  'other',
];

/** 产出方对"为什么没为这个节点产出建议"的自述 */
export interface AiSkipDeclaration {
  nodeId: NodeId;
  code: AiSkipCode;
  reason: string;
}

/**
 * 沉默的一档原因：产出方自述的四类，加上**只有内核才能给出**的五类。
 *
 * 内核那五类正好覆盖"沉默发生的四个位置"：
 *   · `empty-target`    —— 这段没东西可写，**根本没进上下文**（模型不知道有过这一段）；
 *   · `context-budget`  —— 被上下文预算挤掉（同上）；
 *   · `missing-target`  —— 请求点名的节点在文档里不存在（多半已被删除）；
 *   · `max-items`       —— 上下文里看到了，但本次产出已达上限；
 *   · `unexplained`     —— 看到了、也有余量，产出方就是没说为什么没写。
 * 这五类若不分开，全部会塌缩成界面上一句"没有建议"。
 */
export type AiSilenceCode =
  | AiSkipCode
  | 'empty-target'
  | 'context-budget'
  | 'missing-target'
  | 'max-items'
  | 'unexplained';

/**
 * 九档原因的人话名。
 *
 * 放在内核而不是界面里：这些档位是**内核概念**（报表要按它聚合、日志要按它检索），
 * 界面自己编一份的下场是"同一档原因在日志里叫一个名、在界面上叫另一个名"。
 * 这与 `editRatioOf` 的口径只写一处是同一个理由。
 */
export const AI_SILENCE_LABELS: Record<AiSilenceCode, string> = {
  'insufficient-context': '现有信息不足',
  'not-applicable': '该节点不需要建议',
  'existing-content': '已有人工内容，不覆盖',
  other: '其他原因',
  'empty-target': '该段没有可写文本',
  'context-budget': '被上下文预算挤掉',
  'missing-target': '请求的节点已不存在',
  'max-items': '超出本次产出上限',
  unexplained: '产出方未说明',
};

export interface AiSilence {
  nodeId: NodeId;
  code: AiSilenceCode;
  /** 人话，可直接展示 */
  reason: string;
  /** 谁给出的判断 */
  source: 'adapter' | 'kernel';
}

/** 被丢弃的自述的失败码：它们描述的是"产出方在**理由**上说了假话"，不是产出本身失败 */
export type AiSilenceRejectCode =
  | 'E_AI_SILENCE_MALFORMED'
  | 'E_AI_SILENCE_UNKNOWN_NODE'
  | 'E_AI_SILENCE_CONTRADICTION'
  | 'E_AI_SILENCE_DUPLICATE'
  | 'E_AI_SILENCE_UNKNOWN_CODE'
  | 'E_AI_SILENCE_BAD_REASON';

export interface AiSilenceReject {
  index: number;
  code: AiSilenceRejectCode;
  message: string;
}

/**
 * 一次 AI 调用的**沉默报告**：我看了哪些目标、写了哪些、剩下的为什么没写。
 *
 * ## 为什么必须有这份东西
 *
 * 医生对 AI 的信任崩塌，通常不是因为它写错了，而是因为**它不知道它没写**。
 * "这次没提示"会被读成"查过了，没问题" —— 这与质控里"没判"被读成"没问题"
 * 是同一个错误。而那个错误本仓库已经修过两次：形式类的 `QcUnevaluated`、
 * 内涵类的 `judged` / `unevaluated` / `silentRules`（引擎没报告的规则会被点名）。
 * AI 侧一直没有修，这里是第三次修同一个错误。
 *
 * ## 三条纪律
 *
 * 1) **"产出方没说"也要报**（`unexplained`）：沉默不会因为没人解释就消失 ——
 *    把它吞掉，报表上就只剩"产出了 1 条"，看不出另外 11 个目标根本没被处理。
 * 2) **自述要过校验**：跳过声明与 HTTP 响应体同级，幻觉 nodeId、
 *    "说没写又写了"（自相矛盾）、自创原因码都会被逐条拒掉并记进 `rejected`。
 * 3) **顺序按范围排**：输出按 `allowedNodeIds` 的顺序，不按产出方说的顺序 ——
 *    报告是给人看的（"范围里的第几个没被处理"），且这样跨次可比对。
 */
export interface AiSilenceReport {
  /**
   * 本次**请求的目标节点数**（去重后）。
   *
   * 注意不是"能落笔的"那个数：被上下文裁掉的目标也算在范围内 ——
   * 否则"我让你看 3 个"会缩水成"上下文里剩的 2 个"，被裁掉的那个从此不在任何地方出现。
   */
  targets: number;
  /** 实际产出建议的**条数**（同一节点多条也算多条） */
  produced: number;
  skipped: AiSilence[];
  /** 被丢弃的自述（逐条报出，不静默吞掉） */
  rejected: AiSilenceReject[];
}

export const AI_SILENCE_LIMITS = {
  /** 一次调用最多接受多少条跳过自述（挡住"模型刷一堆理由"） */
  maxSkips: 100,
  /** 单条理由的长度上限（它是给人看的一句话，不是段落） */
  maxReason: 200,
} as const;

/**
 * 校验产出方的跳过自述，并**补记**产出方没说的那些目标。
 *
 * 这是唯一一处生成沉默报告的地方：适配器可以自报，但"报告完不完整"由它裁决 ——
 * 就像 `validateSuggestions` 之于产出，产出方可以给，能不能用由内核说了算。
 *
 * 注意 `declared` 是 `unknown`：它是未校验的外部输入（HTTP 响应体的一部分）。
 */
export function resolveSilenceReport(input: {
  request: AiSuggestRequest;
  items: AiSuggestionDraft[];
  declared: unknown;
}): AiSilenceReport {
  const { request, items, declared } = input;
  const allowedSet = new Set<NodeId>(request.allowedNodeIds);
  /* **范围是"请求点了名的"，不是"能落笔的"**。若拿 `allowedNodeIds` 当范围，
     被上下文裁掉的那些会凭空消失 —— 而"AI 根本没看到这一段"恰恰是最该说出来的沉默：
     模型自己都不知道有过这一段，它**不可能**自述，只能由内核说。 */
  const requested: NodeId[] = [];
  const requestedSet = new Set<NodeId>();
  for (const nodeId of request.context.audit.requestedNodeIds) {
    if (requestedSet.has(nodeId)) continue;
    requestedSet.add(nodeId);
    requested.push(nodeId);
  }
  const producedSet = new Set(items.map((item) => item.nodeId));
  const collected = new Map<NodeId, AiSilence>();
  const rejected: AiSilenceReject[] = [];
  const rawList: unknown[] = Array.isArray(declared) ? declared : [];
  rawList.forEach((entry, index) => {
    if (index >= AI_SILENCE_LIMITS.maxSkips) {
      rejected.push({
        index,
        code: 'E_AI_SILENCE_MALFORMED',
        message: `跳过自述超过 ${AI_SILENCE_LIMITS.maxSkips} 条上限，其后内容未处理`,
      });
      return;
    }
    const reject = (code: AiSilenceRejectCode, message: string): void => {
      rejected.push({ index, code, message });
    };
    if (typeof entry !== 'object' || entry === null) {
      reject('E_AI_SILENCE_MALFORMED', `跳过自述必须是对象，实际 ${typeof entry}`);
      return;
    }
    const candidate = entry as Record<string, unknown>;
    const nodeId = candidate.nodeId;
    if (typeof nodeId !== 'string' || nodeId === '') {
      reject('E_AI_SILENCE_MALFORMED', 'nodeId 必须是非空字符串');
      return;
    }
    if (!allowedSet.has(nodeId)) {
      /* 与"幻觉 nodeId"同一类错误：它不是本次范围里的目标，说了也不算 */
      reject('E_AI_SILENCE_UNKNOWN_NODE', `nodeId ${nodeId} 不在本次允许产出的目标里（幻觉 nodeId）`);
      return;
    }
    if (producedSet.has(nodeId)) {
      /* 说"没写"又写了：两条记录只可能有一条真，而这种自相矛盾必须被看见 */
      reject('E_AI_SILENCE_CONTRADICTION', `nodeId ${nodeId} 既声称未产出、又出现在产出里`);
      return;
    }
    if (collected.has(nodeId)) {
      reject('E_AI_SILENCE_DUPLICATE', `nodeId ${nodeId} 的跳过自述重复出现`);
      return;
    }
    const code = candidate.code;
    if (typeof code !== 'string' || !(AI_SKIP_CODES as readonly string[]).includes(code)) {
      reject(
        'E_AI_SILENCE_UNKNOWN_CODE',
        `原因码必须是 ${AI_SKIP_CODES.join(' / ')} 之一，实际 ${JSON.stringify(code)}（自创原因码会让聚合失去意义）`,
      );
      return;
    }
    const reason = candidate.reason;
    if (typeof reason !== 'string' || reason.trim() === '') {
      reject('E_AI_SILENCE_BAD_REASON', '理由不能为空：说不出理由的"沉默"无法被人复核');
      return;
    }
    if (reason.length > AI_SILENCE_LIMITS.maxReason) {
      reject('E_AI_SILENCE_BAD_REASON', `理由长度 ${reason.length} 超过上限 ${AI_SILENCE_LIMITS.maxReason}`);
      return;
    }
    collected.set(nodeId, { nodeId, code: code as AiSkipCode, reason: reason.trim(), source: 'adapter' });
  });

  /* 内核补记：产出方没说、范围里又确实没产出的目标。**这一步不能省** ——
     它保证"沉默"永远有一份完整清单，不依赖任何产出方的自觉。
     补记的**顺序就是沉默发生的位置**：先在上下文这一侧（没进来），再到产出这一侧（进来了没写）。 */
  const audit = request.context.audit;
  const droppedByNode = new Map(audit.droppedTargets.map((drop) => [drop.nodeId, drop]));
  const missing = new Set<NodeId>(audit.missingNodeIds);
  const atLimit = items.length >= request.maxItems;
  for (const nodeId of requested) {
    if (producedSet.has(nodeId) || collected.has(nodeId)) continue;
    const drop = droppedByNode.get(nodeId);
    if (drop) {
      collected.set(nodeId, { nodeId, code: drop.code, reason: drop.reason, source: 'kernel' });
      continue;
    }
    if (missing.has(nodeId)) {
      collected.set(nodeId, {
        nodeId,
        code: 'missing-target',
        reason: '请求的节点在当前文档里不存在（可能已被删除）',
        source: 'kernel',
      });
      continue;
    }
    if (!allowedSet.has(nodeId)) {
      /* 不在上下文里、也不在丢弃名单里：说明调用方请求的范围与上下文对不上。
         如实说"它没进上下文、也没记原因"，而不是随便套一个看起来合理的理由 */
      collected.set(nodeId, {
        nodeId,
        code: 'unexplained',
        reason: '该目标没有进入本次上下文，也没有记录原因',
        source: 'kernel',
      });
      continue;
    }
    collected.set(nodeId, {
      nodeId,
      code: atLimit ? 'max-items' : 'unexplained',
      reason: atLimit
        ? `产出方没有说明；本次产出已达上限（maxItems=${request.maxItems}），该目标节点未被处理`
        : '产出方没有说明为什么没有为这个节点产出建议',
      source: 'kernel',
    });
  }

  /* 按**范围顺序**输出：报告是给人看的"范围里第几个没被处理"，也便于跨次比对 */
  const skipped = requested.map((nodeId) => collected.get(nodeId)).filter((item): item is AiSilence => item !== undefined);
  return { targets: requested.length, produced: items.length, skipped, rejected };
}
