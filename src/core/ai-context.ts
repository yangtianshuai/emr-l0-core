// getContextForAI：给 AI 的脱敏上下文包。

import { maskPersonName } from '../import/import-types.ts';
import { orderedNodeIds } from '../model/machine.ts';
import type { DataElementTag, DocNode, DocumentModel, NodeId } from '../model/types.ts';

export type AiContextErrorCode = 'E_AI_CONTEXT_SCOPE_REQUIRED' | 'E_AI_CONTEXT_EMPTY';

export class AiContextError extends Error {
  code: AiContextErrorCode;

  constructor(code: AiContextErrorCode, message: string) {
    super(message);
    this.name = 'AiContextError';
    this.code = code;
  }
}

export interface AiContextRequest {
  nodeIds: NodeId[];
  contextBefore?: number;
  contextAfter?: number;
  tokenBudget?: number;
  /** 是否包含患者标识（默认 false；为 true 时也只给脱敏值）  */
  includePatient?: boolean;
  includeDataElements?: boolean;
  actor: { id: string; kind: string };
}

export interface AiContextItem {
  nodeId: NodeId;
  type: string;
  text: string;
  tag?: DataElementTag;
  origin: string;
  modelId?: string;
  confidence?: number;
  role: 'target' | 'before' | 'after';
}

export interface AiContextPolicy {
  includePatient: boolean;
  includeDataElements: boolean;
  /** 脱敏方式：复用导入侧的同一实现（不另写一套） */
  maskStrategy: 'mask-person-name';
}

export interface AiContextAudit {
  actorId: string;
  actorKind: string;
  at: string;
  requestedNodeIds: NodeId[];
  tokenBudget: number;
  droppedByBudget: number;
  missingNodeIds: NodeId[];
  droppedTargets: AiContextDrop[];
}

export interface AiContextDrop {
  nodeId: NodeId;
  code: 'empty-target' | 'context-budget';
  reason: string;
}

export interface AiContextPackage {
  docId: string;
  docType: { system: string; code: string; display: string };
  items: AiContextItem[];
  /** 患者标识：仅在 includePatient=true 时出现，且已脱敏  */
  patient?: { nameMasked?: string; gender?: string; birthDate?: string };
  policy: AiContextPolicy;
  stats: { items: number; chars: number; tokenBudget: number; droppedByBudget: number };
  audit: AiContextAudit;
}

export const DEFAULT_AI_CONTEXT_BUDGET = 2000;

function textOfNode(nodes: Record<NodeId, DocNode>, node: DocNode): string {
  switch (node.type) {
    case 'section':
      return node.title ?? node.sectionCode ?? '';
    case 'text':
      return node.runs.map((run) => run.text).join('');
    case 'field':
      return node.valueText ?? (node.value === null || node.value === undefined ? '' : String(node.value));
    case 'image':
      return `[图像：${node.altText ?? node.resRef}]`;
    case 'extension':
      return `[扩展：${node.namespace}]`;
    case 'paragraph':
    case 'listItem':
    case 'table':
    case 'signatureBlock':
    default:
      return '';
  }
}

export function buildAiContext(doc: DocumentModel, request: AiContextRequest): AiContextPackage {
  if (!Array.isArray(request.nodeIds) || request.nodeIds.length === 0) {
    throw new AiContextError(
      'E_AI_CONTEXT_SCOPE_REQUIRED',
      '必须显式给出要取的范围（nodeIds）：无范围取数等于把整份病历交给模型，本接口不允许',
    );
  }

  const budget = request.tokenBudget ?? DEFAULT_AI_CONTEXT_BUDGET;
  const includePatient = request.includePatient === true;
  const includeDataElements = request.includeDataElements === true;
  const before = Math.max(0, request.contextBefore ?? 0);
  const after = Math.max(0, request.contextAfter ?? 0);

  /* 文档顺序表：上下文按它取"相邻"，保证与人工阅读顺序一致（也保证裁剪顺序确定性） */
  const order = orderedNodeIds({ nodes: doc.nodes, rootId: doc.rootId });
  const positionOf = new Map<NodeId, number>();
  order.forEach((id, position) => positionOf.set(id, position));

  const targets = new Set(request.nodeIds.filter((id) => doc.nodes[id] !== undefined));
  const missingNodeIds = request.nodeIds.filter((id) => doc.nodes[id] === undefined);
  if (targets.size === 0) {
    throw new AiContextError('E_AI_CONTEXT_EMPTY', `请求的节点在文档中都不存在：${request.nodeIds.join(', ')}`);
  }

  type Candidate = { id: NodeId; role: AiContextItem['role'] };
  const candidates = new Map<NodeId, Candidate>();
  for (const position of [...targets].map((id) => positionOf.get(id) ?? -1).sort((a, b) => a - b)) {
    if (position < 0) continue;
    const targetId = order[position] as NodeId;
    if (!candidates.has(targetId)) candidates.set(targetId, { id: targetId, role: 'target' });
    for (let step = 1; step <= before; step += 1) {
      const id = order[position - step];
      if (id !== undefined && !candidates.has(id)) candidates.set(id, { id, role: 'before' });
    }
    for (let step = 1; step <= after; step += 1) {
      const id = order[position + step];
      if (id !== undefined && !candidates.has(id)) candidates.set(id, { id, role: 'after' });
    }
  }

  const orderedCandidates = [...candidates.values()].sort(
    (a, b) => (positionOf.get(a.id) ?? 0) - (positionOf.get(b.id) ?? 0),
  );
  const items: AiContextItem[] = [];
  const droppedTargets: AiContextDrop[] = [];
  let chars = 0;
  let droppedByBudget = 0;

  for (const candidate of orderedCandidates) {
    const node = doc.nodes[candidate.id];
    if (!node) continue;
    const text = textOfNode(doc.nodes, node).replace(/\s+/g, ' ').trim();
    if (text === '') {
      if (candidate.role === 'target') {
        droppedTargets.push({
          nodeId: candidate.id,
          code: 'empty-target',
          reason: '该节点没有可写的文本（空段），未进入上下文',
        });
      }
      continue;
    }
    if (chars + text.length > budget) {
      droppedByBudget += 1;
      if (candidate.role === 'target') {
        droppedTargets.push({
          nodeId: candidate.id,
          code: 'context-budget',
          reason: `本次上下文预算（${budget} 字符）已满，该目标节点未进入上下文`,
        });
      }
      continue;
    }
    const tag = node.type === 'field' ? (node.tags?.[0] ?? undefined) : undefined;
    items.push({
      nodeId: node.id,
      type: node.type,
      text,
      ...(includeDataElements && tag ? { tag } : {}),
      origin: node.provenance.origin,
      ...(node.provenance.modelId ? { modelId: node.provenance.modelId } : {}),
      ...(typeof node.provenance.confidence === 'number' ? { confidence: node.provenance.confidence } : {}),
      role: candidate.role,
    });
    chars += text.length;
  }

  const patient = doc.patient;
  return {
    docId: doc.docId,
    docType: { system: doc.docType.system, code: doc.docType.code, display: doc.docType.display },
    items,
    ...(includePatient
      ? {
          patient: {
            nameMasked: patient.nameMasked ? maskPersonName(patient.nameMasked) : '（未脱敏）',
            ...(patient.gender ? { gender: patient.gender } : {}),
            ...(patient.birthDate ? { birthDate: patient.birthDate } : {}),
          },
        }
      : {}),
    policy: { includePatient, includeDataElements, maskStrategy: 'mask-person-name' },
    stats: { items: items.length, chars, tokenBudget: budget, droppedByBudget },
    audit: {
      actorId: request.actor.id,
      actorKind: request.actor.kind,
      at: new Date().toISOString(),
      requestedNodeIds: [...request.nodeIds],
      tokenBudget: budget,
      droppedByBudget,
      missingNodeIds,
      droppedTargets,
    },
  };
}
