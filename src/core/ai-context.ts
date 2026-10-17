/**
 * getContextForAI：给 AI 的**脱敏上下文包**。
 *
 * 为什么这是五类 AI 能力的共同前置：无论语音落位、草稿生成、数据找人还是质控，
 * 都要先把"相关的病历片段"交给模型。不做统一打包，每个接入方就会各写一套取数逻辑，
 * 结果是**脱敏口径、预算口径、审计口径全部不一致** —— 而"脱敏不一致"意味着泄露。
 *
 * 六条硬约束（对应 docs/L2-智能能力接入设计.md 第五节）：
 *   1. **必须显式给出范围**（`nodeIds`）：没有范围就抛 `E_AI_CONTEXT_SCOPE_REQUIRED`。
 *      禁止"不传参数即全量" —— 那等于把整份病历交给模型，是这套机制里最贵的错误；
 *   2. **脱敏复用现有策略**（`src/import/import-types.ts` 的 `maskPersonName`），不另写一套：
 *      两套脱敏规则意味着两套泄露面；
 *   3. **裁剪顺序必须确定性**：同一文档两次调用必须给出同样的内容，
 *      否则"同一输入两次给模型不同的东西"，效果无法回放、问题无法复现；
 *   4. **超预算如实上报**（`droppedByBudget`），不静默截断；
 *   5. **每包带审计回执**（谁、取了哪段、预算多少、丢了多少）；
 *   6. **不带与 AI 无关的元数据**（revisions / 签名 / 机读块指纹一律不进包）。
 *
 * 边界（诚实说明）：本模块只做"范围 + 预算 + 脱敏 + 审计"，**不判断内容该不该给模型**；
 * 也不识别正文里的其他人名（患者姓名按 `patient.nameMasked` 处理，正文中提及的第三方
 * 姓名无法可靠识别）—— 这一点必须让使用方知道，不能以为"过了本模块就绝对安全"。
 */

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
  /**
   * 要取的节点 id。**必填且非空**（见约束 1）。
   * 续写场景通常传目标节点 + 靠 `contextBefore` 自动带上文。
   */
  nodeIds: NodeId[];
  /** 目标节点之前的上下文条数（按文档顺序取相邻节点） */
  contextBefore?: number;
  /** 目标节点之后的上下文条数 */
  contextAfter?: number;
  /** 单次预算（字符数，作为 token 的近似下界）。超出按确定性顺序裁剪 */
  tokenBudget?: number;
  /** 是否包含患者标识（默认 **false**；为 true 时也只给脱敏值） */
  includePatient?: boolean;
  /** 是否附带机读数据元（标签/单位/来源） */
  includeDataElements?: boolean;
  /** 调用者：写进审计回执。**不参与门控**（门控在落笔时按目标节点判定） */
  actor: { id: string; kind: string };
}

export interface AiContextItem {
  nodeId: NodeId;
  type: string;
  /** 该节点的可读文本（已按节点类型归并，如段落合并其子文本） */
  text: string;
  tag?: DataElementTag;
  /** 来源类型（human / ai / imported / …），供模型理解"这段是谁写的" */
  origin: string;
  /** 若该节点内容来自 AI：模型标识与置信度（让模型知道自己面对的是草稿还是定稿） */
  modelId?: string;
  confidence?: number;
  /** 与请求目标的关系：目标本身 / 上文 / 下文 */
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
  /** 请求的范围与预算（回显，便于事后回答"当时给了模型什么"） */
  requestedNodeIds: NodeId[];
  tokenBudget: number;
  /** 因预算被丢弃的条目数（约束 4：如实上报） */
  droppedByBudget: number;
  /** 请求里未找到的节点 id（源文档可能已变更） */
  missingNodeIds: NodeId[];
  /**
   * **请求点了名、却没能进入上下文**的目标节点，以及原因。
   *
   * `droppedByBudget` 只有计数，回答得了"丢了几个"，回答不了"丢的是谁、为什么"。
   * 而"AI 没看到这一段"与"AI 看到了但没写"在界面上长得一模一样（都是"没有建议"）——
   * 这两种沉默要分开说，才谈得上可解释（见 `AiSilenceReport`）。
   *
   * 只记 **target**：`before` / `after` 本就只是给模型看的背景，它们被丢弃不构成沉默。
   */
  droppedTargets: AiContextDrop[];
}

/** 没能进入上下文的一个目标节点 */
export interface AiContextDrop {
  nodeId: NodeId;
  /** `empty-target` = 空段（没有可写的文本）；`context-budget` = 被预算挤掉 */
  code: 'empty-target' | 'context-budget';
  reason: string;
}

export interface AiContextPackage {
  docId: string;
  docType: { system: string; code: string; display: string };
  items: AiContextItem[];
  /** 患者标识：**仅在 includePatient=true 时出现，且已脱敏** */
  patient?: { nameMasked?: string; gender?: string; birthDate?: string };
  policy: AiContextPolicy;
  stats: { items: number; chars: number; tokenBudget: number; droppedByBudget: number };
  audit: AiContextAudit;
}

export const DEFAULT_AI_CONTEXT_BUDGET = 2000;

/* ------------------------------ 节点文本 ------------------------------ */

/** 取单个节点的可读文本（按类型归并；不递归子树的深层结构，避免把整份文档拖进来） */
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
      /* 这几类的内容在其子节点里：由调用方通过 orderedNodeIds 逐节点取，本函数不做递归，
         以免"取一个段落"变成"拖走整棵子树"（预算失控的常见来源）。 */
      return '';
  }
}

/* ------------------------------ 主体 ------------------------------ */

/**
 * 组装上下文包。
 *
 * 性能说明：本函数会**按文档顺序遍历一次**（`orderedNodeIds`，O(n)），1000 页规模下约数毫秒。
 * 因此**不要**在每次按键时调用它 —— 它是"一次提问打一次包"，不是实时同步机制。
 * 若将来确有高频需求，应改为复用 `DocumentIndex`，而不是每帧重建。
 */
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

  /* 选定候选：目标本身 + 其前后各 N 个相邻节点（按文档顺序，天然确定） */
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
    /* 注意：这里**不能**在 before/after 都为 0 时 break —— 那会漏掉后续目标节点
       （多目标请求时静默少给内容，是那种"看起来成功"的错误） */
  }

  /* 按文档顺序生成条目。**裁剪也按这个顺序**：先目标、再近邻，超预算即停并计数。
     顺序确定性的意义：同一文档两次调用给出完全相同的包（可回放、可复现）。 */
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
      /* 空段：只有它是 **target** 时才记 —— 那意味着"调用方要这段建议，但这段没东西可写"，
         而模型那边永远不会知道有过这么一段（它根本没进上下文） */
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
    /* 患者标识：只有明确要求时才带，且**一律经 maskPersonName**。
       为什么对已经是掩码的 `nameMasked` 还要再脱敏一次：因为该字段只是"约定为掩码"，
       源数据（尤其是导入件）可能把全名塞进来。再过一遍同一个函数是廉价的兜底，
       并且保证**全系统只有一套脱敏规则** —— 两套规则意味着两个泄露面。
       姓名字段缺失时写"（未脱敏）"，**绝不回落到 patientId**（页眉上已踩过这个坑）。 */
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
