import type { AiContextPackage } from '../core/ai-context.ts';
import type { NodeId } from '../model/types.ts';

export type AiSuggestionMode = 'complete' | 'draft' | 'polish';

export interface AiSuggestRequest {
  /** 已脱敏的上下文（由 `buildAiContext` 产出）。适配器看不到文档本身 */
  context: AiContextPackage;
  mode: AiSuggestionMode;
  allowedNodeIds: NodeId[];
  selection?: { nodeId: NodeId; text: string };
  maxItems: number;
  traceId?: string;
  signal?: AbortSignal;
}

export interface AiSuggestionDraft {
  nodeId: NodeId;
  text: string;
  confidence: number;
  rationale?: string;
}

export interface AiSuggestResponse {
  items: AiSuggestionDraft[];
  modelId: string;
  promptId?: string;
  usage: { latencyMs: number; inputChars?: number; outputChars?: number };
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

export function targetNodeIdsOf(context: AiContextPackage): NodeId[] {
  return context.items.filter((item) => item.role === 'target').map((item) => item.nodeId);
}

export type AiSkipCode = 'insufficient-context' | 'not-applicable' | 'existing-content' | 'other';

export const AI_SKIP_CODES: readonly AiSkipCode[] = [
  'insufficient-context',
  'not-applicable',
  'existing-content',
  'other',
];

export interface AiSkipDeclaration {
  nodeId: NodeId;
  code: AiSkipCode;
  reason: string;
}

export type AiSilenceCode =
  | AiSkipCode
  | 'empty-target'
  | 'context-budget'
  | 'missing-target'
  | 'max-items'
  | 'unexplained';

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
  reason: string;
  source: 'adapter' | 'kernel';
}

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

export interface AiSilenceReport {
  targets: number;
  produced: number;
  skipped: AiSilence[];
  rejected: AiSilenceReject[];
}

export const AI_SILENCE_LIMITS = {
  maxSkips: 100,
  /** 单条理由的长度上限（它是给人看的一句话，不是段落） */
  maxReason: 200,
} as const;

export function resolveSilenceReport(input: {
  request: AiSuggestRequest;
  items: AiSuggestionDraft[];
  declared: unknown;
}): AiSilenceReport {
  const { request, items, declared } = input;
  const allowedSet = new Set<NodeId>(request.allowedNodeIds);
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

  const skipped = requested.map((nodeId) => collected.get(nodeId)).filter((item): item is AiSilence => item !== undefined);
  return { targets: requested.length, produced: items.length, skipped, rejected };
}
