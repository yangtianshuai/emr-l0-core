import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { demoKeyPair, softwareSigner, type Signer } from '../crypto/provider.ts';
import { DOCUMENT_COVERS, documentSignatureTargets, signTargets, signedInfoDigestOf, verifyTargets, type SignatureBlock, type SignatureTarget, type VerifySignatureResult } from '../crypto/signature.ts';
import { hashNodes } from '../model/hash.ts';
import { controlCellByKey, matchesControlCellType } from '../model/control.ts';
import { DocumentIndex } from '../model/indexes.ts';
import { codesOf, errorsOf, validateDocument, type DocumentModel, type DocNode, type EvidenceRef, type ISODateTime, type JsonValue, type MachineReadableBlock, type NodeId, type NodeType, type PatchOp, type Provenance, type RevisionEntry, type RevisionOp, type RunProvenance, type TextRun } from '../model/index.ts';
import { buildMachineReadable, machineReadableStaleness, type StalenessReport } from '../model/machine.ts';
import { cloneDoc, toJson } from '../model/serialize.ts';
import { buildOfdPackage, type OfdExportOptions, type OfdExportPlan, type OfdPackage } from '../export/ofd.ts';
import { buildWst500Xml, type Wst500ExportOptions, type Wst500ExportResult } from '../export/wst500.ts';
import { DEFAULT_IDLE_THRESHOLD_MS, WritingTimingAccumulator, type WritingTiming } from './writing-timing.ts';
import { applyPatch, jsonDiff } from './patch.ts';
import { applyTextRange, runsFromAiRanges, type AiRange } from './text-runs.ts';
import { editRatioOf, SuggestionBook, type Suggestion, type SuggestionAttribution, type SuggestionBatchInput, type SuggestionBookSnapshot, type SuggestionGroup, type SuggestionMetrics, type SuggestionStatus } from './suggestions.ts';
import { normalizeSegments, toSuggestionItems, type TranscriptSegment } from './dictation.ts';
import {
  AnnotationBook,
  type AnnotationBookSnapshot,
  type AnchorState,
  type Annotation,
  type AnnotationCounts,
  type AnnotationEvidence,
  type AnnotationSeverity,
  type AnnotationSource,
  type AnnotationStatus,
} from './annotations.ts';

export type ActorKind = 'human' | 'ai' | 'system';

export interface Actor {
  id: string;
  kind: ActorKind;
}

export interface WriteOptions {
  clientOpId?: string;
  /** 乐观锁：必须等于当前文档 rev（= revisions.length），否则报冲突 */
  expectedRev?: number;
  implyConfirm?: boolean;
  at?: ISODateTime;
}

export interface WriteResult {
  ok: true;
  targetId: NodeId | null;
  docRev: number;
  revision: number;
  replayed?: boolean;
}

const EDIT_IMPLIES_CONFIRM: ReadonlySet<RevisionOp> = new Set<RevisionOp>(['create', 'insert', 'update']);

const NOT_UNDOABLE: ReadonlySet<RevisionOp> = new Set<RevisionOp>([
  'sign',
  'unlock',
  'migrate',
  'import',
  'submit',
  'review',
  'void',
  'archive',
]);

const STATUS_OPS: ReadonlySet<RevisionOp> = new Set<RevisionOp>(['submit', 'review', 'void', 'archive']);

/** 会改旁挂数据（建议本）的 op：撤销时要连它一起回滚，否则会出现"内容退回去了、那条建议还是已采纳"  */
const TOUCHES_SUGGESTIONS: ReadonlySet<RevisionOp> = new Set<RevisionOp>(['accept-ai', 'reject-ai']);

export const WRITE_ERRORS = {
  E_ACTOR_INVALID: 'E_ACTOR_INVALID',
  E_AI_DIRECT_WRITE_FORBIDDEN: 'E_AI_DIRECT_WRITE_FORBIDDEN',
  E_REV_CONFLICT: 'E_REV_CONFLICT',
  E_TIME_INVALID: 'E_TIME_INVALID',
  /** 注入的时刻早于上一次提交：留痕必须单调，往回写会让"谁先谁后"无法判断 */
  E_TIME_REGRESS: 'E_TIME_REGRESS',
  E_SIGNED_IMMUTABLE: 'E_SIGNED_IMMUTABLE',
  E_NODE_NOT_FOUND: 'E_NODE_NOT_FOUND',
  E_PARENT_NOT_FOUND: 'E_PARENT_NOT_FOUND',
  E_TYPE_MISMATCH: 'E_TYPE_MISMATCH',
  /** 控件里没有这一格：拼错的键写进去不会报错，只会变成"医生填的值在导出里凭空不见" */
  E_CELL_UNKNOWN: 'E_CELL_UNKNOWN',
  E_CONTROL_VALUE_INVALID: 'E_CONTROL_VALUE_INVALID',
  E_IMAGE_REF_INVALID: 'E_IMAGE_REF_INVALID',
  E_KEY_CONTENT_PROTECTED: 'E_KEY_CONTENT_PROTECTED',
  E_REQUIRED_SECTION_PROTECTED: 'E_REQUIRED_SECTION_PROTECTED',
  E_CONFIRM_SCOPE_REQUIRED: 'E_CONFIRM_SCOPE_REQUIRED',
  /** 系统取数只能由 system 身份发起：AI 走建议通道，人类走 setFieldValue */
  E_EXTERNAL_ACTOR_INVALID: 'E_EXTERNAL_ACTOR_INVALID',
  /** 系统取数必须带强引用来源：没有来源的数据无法回溯，比不引入更糟 */
  E_EXTERNAL_EVIDENCE_REQUIRED: 'E_EXTERNAL_EVIDENCE_REQUIRED',
  E_EXTERNAL_CONFLICT: 'E_EXTERNAL_CONFLICT',
  E_EXTERNAL_SCOPE_REQUIRED: 'E_EXTERNAL_SCOPE_REQUIRED',
  E_HAS_CHILDREN: 'E_HAS_CHILDREN',
  E_CYCLE_DETECTED: 'E_CYCLE_DETECTED',
  E_INVALID_PATCH: 'E_INVALID_PATCH',
  E_NODE_TYPE_UNKNOWN: 'E_NODE_TYPE_UNKNOWN',
  E_AI_NOT_ALLOWED: 'E_AI_NOT_ALLOWED',
  E_AI_LOW_CONFIDENCE: 'E_AI_LOW_CONFIDENCE',
  E_AI_NO_PROVENANCE: 'E_AI_NO_PROVENANCE',
  E_SUGGESTION_NOT_FOUND: 'E_SUGGESTION_NOT_FOUND',
  E_SUGGESTION_STATE: 'E_SUGGESTION_STATE',
  E_SUGGESTION_SCOPE_REQUIRED: 'E_SUGGESTION_SCOPE_REQUIRED',
  E_ANNOTATION_NOT_FOUND: 'E_ANNOTATION_NOT_FOUND',
  E_ANNOTATION_STATE: 'E_ANNOTATION_STATE',
  E_ANNOTATION_NO_EVIDENCE: 'E_ANNOTATION_NO_EVIDENCE',
  E_KEY_CONTENT_UNCONFIRMED: 'E_KEY_CONTENT_UNCONFIRMED',
  E_TAG_UNCONFIRMED: 'E_TAG_UNCONFIRMED',
  E_SIGNED_WITH_UNCONFIRMED_AI: 'E_SIGNED_WITH_UNCONFIRMED_AI',
  E_IMPORTED_UNCONFIRMED: 'E_IMPORTED_UNCONFIRMED',
  E_MACHINE_READABLE_STALE: 'E_MACHINE_READABLE_STALE',
  E_EXPORT_INVALID_PLAN: 'E_EXPORT_INVALID_PLAN',
  E_OFFSET_RANGE: 'E_OFFSET_RANGE',
  E_UNLOCK_REASON_REQUIRED: 'E_UNLOCK_REASON_REQUIRED',
  E_UNLOCK_NOT_ALLOWED: 'E_UNLOCK_NOT_ALLOWED',
  E_DOC_STATUS: 'E_DOC_STATUS',
  E_REVIEWING_IMMUTABLE: 'E_REVIEWING_IMMUTABLE',
  E_DOC_VOID: 'E_DOC_VOID',
  E_SUBMIT_EMPTY: 'E_SUBMIT_EMPTY',
  /** 审核退回必须给出理由：不给理由的退回，医生改什么全靠猜 */
  E_REVIEW_NOTE_REQUIRED: 'E_REVIEW_NOTE_REQUIRED',
  /** 作废必须给出理由（写进留痕）："为什么这份没了"只能由留痕回答 */
  E_VOID_REASON_REQUIRED: 'E_VOID_REASON_REQUIRED',
  /** 没有可撤销的写入（只支持撤销最近一次；签章/解锁之后不可撤销） */
  E_NOTHING_TO_UNDO: 'E_NOTHING_TO_UNDO',
  E_REVERT_TARGET: 'E_REVERT_TARGET',
  E_REVERT_IMPOSSIBLE: 'E_REVERT_IMPOSSIBLE',
  E_REVERT_FOREIGN_WRITE: 'E_REVERT_FOREIGN_WRITE',
  E_SIGN_CONTENT_CHANGED: 'E_SIGN_CONTENT_CHANGED',
} as const;

export type WriteErrorCode = (typeof WRITE_ERRORS)[keyof typeof WRITE_ERRORS];

export class WriteError extends Error {
  code: WriteErrorCode;

  constructor(code: WriteErrorCode, message: string) {
    super(message);
    this.name = 'WriteError';
    this.code = code;
  }
}

export const DEMO_SIGNING_SEED = 'l0-demo-signing-key-2026-10-08';

export interface SessionOptions {
  /** local（默认，推荐）：只快照受影响节点；full：全量快照 + 全量 diff，仅用于等价性验证 */
  patchStrategy?: 'local' | 'full';
  /** 是否拦截 AI 直接写（默认 true；仅测试参考实现时需要放开） */
  blockAiDirectWrite?: boolean;
  /** 一般内容 AI 置信度阈值（默认 0.75） */
  aiThreshold?: number;
  /** 关键内容 AI 置信度阈值（默认 0.90，高于一般内容） */
  aiKeyContentThreshold?: number;
  /** 演示签名密钥种子（仅演示用；生产请改用 signer 注入密码设备） */
  signingKeySeed?: string;
  /** 签名后端：默认自研 SM2 软件实现 + 演示密钥；生产替换为经认证的密码模块适配器 */
  signer?: Signer;
  clock?: 'logical' | 'wall';
  idleThresholdMs?: number;
}

const STRUCTURAL_KEYS = new Set(['id', 'type', 'parentId', 'provenance', 'rev', 'required']);

function aiRunProvenance(suggestion: Suggestion): RunProvenance {
  return {
    origin: 'ai',
    modelId: suggestion.modelId,
    confidence: suggestion.confidence,
    suggestionId: suggestion.id,
  };
}

const KNOWN_NODE_TYPES = new Set<NodeType>([
  'document',
  'section',
  'paragraph',
  'text',
  'field',
  'control',
  'table',
  'tableRow',
  'tableCell',
  'image',
  'listGroup',
  'listItem',
  'signatureBlock',
  'extension',
]);

export interface SignatureState {
  kind: 'none' | 'valid' | 'voided';
  latest: { algorithm: string; provider: string; publicKeyFingerprint: string; signedAt: string; covers: string[] } | null;
  verified: VerifySignatureResult | null;
  voidedBy: { reason: string; at: string; invalidated: Array<{ publicKeyFingerprint: string; signedAt: string }> } | null;
}

interface CommitParams {
  op: RevisionOp;
  actor: Actor;
  options: WriteOptions;
  /** 本次写入可能改动的节点（必须在 mutate 之前给出，用于快照与索引同步） */
  targets: NodeId[];
  mutate: () => { created?: NodeId[]; deleted?: NodeId[]; targetId?: NodeId | null; extra?: Partial<RevisionEntry> };
}

export class WriteSession {
  private doc: DocumentModel;

  private readonly index: DocumentIndex;

  private readonly strategy: 'local' | 'full';

  private readonly blockAiDirectWrite: boolean;

  private readonly aiThreshold: number;

  private readonly aiKeyContentThreshold: number;

  private readonly opIndex = new Map<string, WriteResult>();

  private undoSlot: {
    rev: number;
    op: RevisionOp;
    nodes: Map<NodeId, DocNode | undefined>;
    sidecars?: { suggestions: SuggestionBookSnapshot; annotations: AnnotationBookSnapshot };
  } | null = null;

  private undoGroup: {
    rev: number | null;
    op: RevisionOp | null;
    nodes: Map<NodeId, DocNode | undefined>;
    sidecars?: { suggestions: SuggestionBookSnapshot; annotations: AnnotationBookSnapshot };
  } | null = null;

  private book = new SuggestionBook();

  private annotations = new AnnotationBook();

  private signer: Signer;

  private clock: number;

  private pendingAt: ISODateTime | null = null;

  private pendingWallClock = false;

  private clockSource: 'logical' | 'wall';

  private readonly timingAcc: WritingTimingAccumulator;

  private seq = 0;

  private constructor(doc: DocumentModel, options: SessionOptions) {
    this.doc = doc;
    this.strategy = options.patchStrategy ?? 'local';
    this.blockAiDirectWrite = options.blockAiDirectWrite ?? true;
    this.aiThreshold = options.aiThreshold ?? 0.75;
    this.aiKeyContentThreshold = options.aiKeyContentThreshold ?? 0.9;
    this.signer = options.signer ?? softwareSigner(demoKeyPair(options.signingKeySeed ?? DEMO_SIGNING_SEED).privateKey);
    this.index = DocumentIndex.build(doc.nodes, doc.rootId);
    this.clock = Date.parse(doc.updatedAt);
    this.clockSource = options.clock ?? 'logical';
    this.timingAcc = new WritingTimingAccumulator(options.idleThresholdMs ?? DEFAULT_IDLE_THRESHOLD_MS);
  }

  /** 打开会话：先校验文档合法，再建索引（非法文档不得进入写路径） */
  static open(doc: DocumentModel, options: SessionOptions = {}): WriteSession {
    const issues = errorsOf(validateDocument(cloneDoc(doc)));
    if (issues.length > 0) {
      throw new Error(`文档不合法，无法打开写会话：${codesOf(issues).join(', ')}`);
    }
    return new WriteSession(cloneDoc(doc), options);
  }

  static openPersisted(doc: DocumentModel, options: SessionOptions = {}): WriteSession {
    const blocking = errorsOf(validateDocument(cloneDoc(doc))).filter(
      (issue) => issue.code !== WRITE_ERRORS.E_MACHINE_READABLE_STALE,
    );
    if (blocking.length > 0) {
      throw new Error(`文档不合法，无法打开写会话：${codesOf(blocking).join(', ')}`);
    }
    return new WriteSession(cloneDoc(doc), options);
  }

  setSigner(signer: Signer): void {
    this.signer = signer;
  }

  get document(): DocumentModel {
    return this.doc;
  }

  get indexes(): DocumentIndex {
    return this.index;
  }

  get docRev(): number {
    return this.doc.revisions.length;
  }

  auditLog(): RevisionEntry[] {
    return this.doc.revisions;
  }

  auditQuery(filter: { from?: ISODateTime; to?: ISODateTime; actorId?: string; op?: RevisionOp } = {}): RevisionEntry[] {
    const from = filter.from === undefined ? Number.NEGATIVE_INFINITY : Date.parse(filter.from);
    const to = filter.to === undefined ? Number.POSITIVE_INFINITY : Date.parse(filter.to);
    return this.doc.revisions.filter((entry) => {
      const at = Date.parse(entry.at);
      if (Number.isFinite(from) && at < from) return false;
      if (Number.isFinite(to) && at > to) return false;
      if (filter.actorId !== undefined && entry.actorId !== filter.actorId) return false;
      if (filter.op !== undefined && entry.op !== filter.op) return false;
      return true;
    });
  }

  timing(): WritingTiming {
    return this.timingAcc.snapshot();
  }

  getNode(id: NodeId): DocNode | null {
    return this.doc.nodes[id] ?? null;
  }

  snapshot(): DocumentModel {
    return cloneDoc(this.doc);
  }

  exportJson(options: { canonical?: boolean; pretty?: boolean } = {}): string {
    return toJson(this.doc, options);
  }

  verifyInvariants(): string[] {
    const problems: string[] = [];
    const issues = errorsOf(validateDocument(cloneDoc(this.doc)));
    if (issues.length > 0) problems.push(`文档校验失败：${codesOf(issues).join(', ')}`);
    const report = this.index.verifyAgainst(this.doc.nodes, this.doc.rootId);
    if (!report.ok) problems.push(...report.diffs);
    return problems;
  }

  createNode(
    params: { parentId: NodeId; type: NodeType; props?: Partial<DocNode>; order?: number },
    actor: Actor,
    options: WriteOptions = {},
  ): WriteResult {
    const { parentId, type, props = {}, order } = params;
    if (!KNOWN_NODE_TYPES.has(type)) throw new WriteError(WRITE_ERRORS.E_NODE_TYPE_UNKNOWN, `未知节点类型：${type}`);
    return this.commit({
      op: 'create',
      actor,
      options,
      targets: [],
      mutate: () => {
        if (!this.doc.nodes[parentId]) throw new WriteError(WRITE_ERRORS.E_PARENT_NOT_FOUND, `父节点不存在：${parentId}`);
        const id = this.nextNodeId();
        const node = {
          id,
          type,
          parentId,
          order: typeof order === 'number' ? order : this.nextOrder(parentId),
          rev: 1,
          provenance: this.provenanceFor(actor),
          ...props,
        } as DocNode;
        this.doc.nodes[id] = node;
        return { created: [id], targetId: id };
      },
    });
  }

  insertText(params: { nodeId: NodeId; text: string }, actor: Actor, options: WriteOptions = {}): WriteResult {
    const { nodeId, text } = params;
    return this.commit({
      op: 'insert',
      actor,
      options,
      targets: [nodeId],
      mutate: () => {
        const node = this.requireNode(nodeId);
        if (node.type !== 'text') throw new WriteError(WRITE_ERRORS.E_TYPE_MISMATCH, `节点 ${nodeId} 不是文本节点（type=${node.type}）`);
        const runs = node.runs.length > 0 ? node.runs : [{ text: '' }];
        const last = runs.length - 1;
        const previous = node.provenance;
        node.runs = [...runs.slice(0, last), { ...runs[last], text: `${runs[last]?.text ?? ''}${text}` }];
        node.rev += 1;
        node.provenance = this.humanProvenance(actor, node.provenance);
        void previous;
        return { targetId: nodeId };
      },
    });
  }

  updateNodeProps(
    params: { nodeId: NodeId; patch: Record<string, JsonValue | undefined | boolean | number | string | unknown[] | Record<string, unknown>> },
    actor: Actor,
    options: WriteOptions = {},
  ): WriteResult {
    const { nodeId, patch } = params;
    for (const key of Object.keys(patch)) {
      if (STRUCTURAL_KEYS.has(key)) {
        throw new WriteError(WRITE_ERRORS.E_INVALID_PATCH, `字段 ${key} 不允许通过 updateNodeProps 修改（结构类字段请走专用接口）`);
      }
    }
    return this.commit({
      op: 'update',
      actor,
      options,
      targets: [nodeId],
      mutate: () => {
        const node = this.requireNode(nodeId);
        for (const [key, value] of Object.entries(patch)) {
          (node as unknown as Record<string, unknown>)[key] = structuredClone(value);
        }
        node.rev += 1;
        if (!('provenance' in patch)) node.provenance = this.humanProvenance(actor, node.provenance);
        return { targetId: nodeId };
      },
    });
  }

  replaceRange(
    params: { nodeId: NodeId; start: number; end: number; payload: { text: string } | { runs: TextRun[] } },
    actor: Actor,
    options: WriteOptions = {},
  ): WriteResult {
    const { nodeId, start, end, payload } = params;
    return this.commit({
      op: 'update',
      actor,
      options,
      targets: [nodeId],
      mutate: () => {
        const node = this.requireNode(nodeId);
        if (node.type !== 'text') {
          throw new WriteError(WRITE_ERRORS.E_TYPE_MISMATCH, `节点 ${nodeId} 不是文本节点（type=${node.type}）—— 区间替换只作用于文本`);
        }
        node.runs = applyTextRange(
          node.runs,
          start,
          end,
          'runs' in payload ? { kind: 'runs', runs: payload.runs } : { kind: 'text', text: payload.text },
        );
        node.rev += 1;
        node.provenance = this.humanProvenance(actor, node.provenance);
        return { targetId: nodeId };
      },
    });
  }

  setFieldValue(
    params: { nodeId: NodeId; value: JsonValue; valueText?: string; unit?: string; sourceKey?: string },
    actor: Actor,
    options: WriteOptions = {},
  ): WriteResult {
    const { nodeId, value, valueText, unit, sourceKey } = params;
    return this.commit({
      op: 'update',
      actor,
      options,
      targets: [nodeId],
      mutate: () => {
        const node = this.requireNode(nodeId);
        if (node.type !== 'field') throw new WriteError(WRITE_ERRORS.E_TYPE_MISMATCH, `节点 ${nodeId} 不是字段节点（type=${node.type}）`);
        node.value = structuredClone(value);
        node.valueText = valueText ?? String(value);
        if (unit !== undefined) node.unit = unit;
        if (sourceKey !== undefined) node.sourceKey = sourceKey;
        node.rev += 1;
        node.provenance = this.humanProvenance(actor, node.provenance);
        return { targetId: nodeId };
      },
    });
  }

  setControlValue(
    params: { nodeId: NodeId; fieldKey: string; value: JsonValue },
    actor: Actor,
    options: WriteOptions = {},
  ): WriteResult {
    const { nodeId, fieldKey, value } = params;
    return this.commit({
      op: 'update',
      actor,
      options,
      targets: [nodeId],
      mutate: () => {
        const node = this.requireNode(nodeId);
        if (node.type !== 'control') {
          throw new WriteError(
            WRITE_ERRORS.E_TYPE_MISMATCH,
            `节点 ${nodeId} 不是控件节点（type=${node.type}）—— 控件里的格子只能写进控件`,
          );
        }
        const cell = controlCellByKey(node, fieldKey);
        if (!cell) {
          throw new WriteError(
            WRITE_ERRORS.E_CELL_UNKNOWN,
            `控件 ${nodeId} 上没有「${fieldKey}」这一格（形状 ${node.shape}）：键由形状算出来，拼错的键只会让值悄悄消失`,
          );
        }
        if (value === '' || value === null) {
          delete node.payload[fieldKey];
        } else {
          if (!matchesControlCellType(cell.dataType, value)) {
            throw new WriteError(
              WRITE_ERRORS.E_CONTROL_VALUE_INVALID,
              `「${cell.label}」的值与数据类型 ${cell.dataType} 对不上（控件的值会进机读信息，所以必须是真值）`,
            );
          }
          node.payload[fieldKey] = structuredClone(value);
        }
        node.rev += 1;
        node.provenance = this.humanProvenance(actor, node.provenance);
        return { targetId: nodeId };
      },
    });
  }

  setImageRef(
    params: { nodeId: NodeId; resRef: string; altText?: string },
    actor: Actor,
    options: WriteOptions = {},
  ): WriteResult {
    const { nodeId, resRef, altText } = params;
    const ref = resRef.trim();
    if (ref === '') {
      throw new WriteError(
        WRITE_ERRORS.E_IMAGE_REF_INVALID,
        '图片地址不能为空：空地址的意思是"还没贴"；要清掉这张图请删节点（删图会留痕）',
      );
    }
    return this.commit({
      op: 'update',
      actor,
      options,
      targets: [nodeId],
      mutate: () => {
        const node = this.requireNode(nodeId);
        if (node.type !== 'image') {
          throw new WriteError(WRITE_ERRORS.E_TYPE_MISMATCH, `节点 ${nodeId} 不是图片节点（type=${node.type}）`);
        }
        node.resRef = ref;
        const currentAlt = node.altText ?? '';
        if (altText !== undefined && altText.trim() !== '' && currentAlt === '') {
          node.altText = altText.trim();
        }
        node.rev += 1;
        node.provenance = this.humanProvenance(actor, node.provenance);
        return { targetId: nodeId };
      },
    });
  }

  moveNode(
    params: { nodeId: NodeId; newParentId: NodeId; order?: number },
    actor: Actor,
    options: WriteOptions = {},
  ): WriteResult {
    const { nodeId, newParentId, order } = params;
    return this.commit({
      op: 'move',
      actor,
      options,
      targets: [nodeId],
      mutate: () => {
        const node = this.requireNode(nodeId);
        if (nodeId === this.doc.rootId) throw new WriteError(WRITE_ERRORS.E_CYCLE_DETECTED, '根节点不可移动');
        if (!this.doc.nodes[newParentId]) throw new WriteError(WRITE_ERRORS.E_PARENT_NOT_FOUND, `父节点不存在：${newParentId}`);
        if (this.index.wouldCreateCycle(nodeId, newParentId)) {
          throw new WriteError(WRITE_ERRORS.E_CYCLE_DETECTED, `移动 ${nodeId} 到 ${newParentId} 会形成环`);
        }
        node.parentId = newParentId;
        node.order = typeof order === 'number' ? order : this.nextOrder(newParentId);
        node.rev += 1;
        node.provenance = this.humanProvenance(actor, node.provenance);
        return { targetId: nodeId };
      },
    });
  }

  deleteNode(params: { nodeId: NodeId; mode?: 'single' | 'subtree' }, actor: Actor, options: WriteOptions = {}): WriteResult {
    const { nodeId, mode = 'single' } = params;
    return this.commit({
      op: 'delete',
      actor,
      options,
      targets: mode === 'subtree' ? this.index.subtreeIds(nodeId) : [nodeId],
      mutate: () => {
        this.requireNode(nodeId);
        if (nodeId === this.doc.rootId) throw new WriteError(WRITE_ERRORS.E_KEY_CONTENT_PROTECTED, '根节点不可删除');
        if (mode === 'single' && this.index.childrenOf(nodeId).length > 0) {
          throw new WriteError(WRITE_ERRORS.E_HAS_CHILDREN, `节点 ${nodeId} 仍有子节点，如需级联删除请显式指定 mode='subtree'`);
        }
        const victims = mode === 'subtree' ? this.index.subtreeIds(nodeId) : [nodeId];
        const protectedVictims = victims.filter((id) => this.doc.nodes[id]?.keyContent === true);
        if (protectedVictims.length > 0) {
          throw new WriteError(
            WRITE_ERRORS.E_KEY_CONTENT_PROTECTED,
            `关键内容节点禁止删除：${protectedVictims.join(', ')}`,
          );
        }
        const missingRequired = victims
          .map((id) => this.doc.nodes[id])
          .filter((node): node is Extract<DocNode, { type: 'section' }> =>
            node?.type === 'section' && node.required === true)
          .map((node) => node.title ?? node.id);
        if (missingRequired.length > 0) {
          throw new WriteError(
            WRITE_ERRORS.E_REQUIRED_SECTION_PROTECTED,
            `必备章节禁止删除：${missingRequired.join('、')}（这几章是这份文书必须有的部分，'
              + '要删请先在模板里去掉「必备章节」标记）`,
          );
        }
        for (const victim of victims) delete this.doc.nodes[victim];
        return { deleted: victims, targetId: nodeId };
      },
    });
  }

  suggestText(
    params: {
      nodeId: NodeId;
      text: string;
      confidence: number;
      modelId: string;
      promptId?: string;
      evidence?: EvidenceRef[];
      traceId?: string;
    },
    actor: Actor,
  ): { ok: true; suggestionId: string; reused: boolean } {
    this.assertActor(actor);
    const { nodeId, text, confidence, modelId, promptId, evidence, traceId } = params;
    const node = this.requireNode(nodeId);
    if (node.type !== 'text') throw new WriteError(WRITE_ERRORS.E_TYPE_MISMATCH, `节点 ${nodeId} 不是文本节点（type=${node.type}）`);
    if (!modelId || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      throw new WriteError(
        WRITE_ERRORS.E_AI_NO_PROVENANCE,
        'AI 建议必须携带 modelId 与 0~1 的 confidence（否则无法审计，且 NaN/越界值会绕过门控）',
      );
    }
    const { suggestion, created } = this.book.add({
      targetNodeId: nodeId,
      text,
      confidence,
      modelId,
      ...(promptId ? { promptId } : {}),
      ...(evidence ? { evidence } : {}),
      ...(traceId ? { traceId } : {}),
      at: this.tick(),
    });
    return { ok: true, suggestionId: suggestion.id, reused: created === false };
  }

  acceptSuggestion(
    params: { suggestionId: string; editedText?: string; aiRanges?: readonly AiRange[] },
    actor: Actor,
    options: WriteOptions = {},
  ): WriteResult {
    this.assertHuman(actor, '采纳 AI 建议');
    const suggestion = this.requirePendingSuggestion(params.suggestionId);
    const node = this.requireNode(suggestion.targetNodeId);
    const threshold = this.thresholdFor(node);
    if (suggestion.confidence < threshold) {
      throw new WriteError(
        WRITE_ERRORS.E_AI_LOW_CONFIDENCE,
        `置信度 ${suggestion.confidence} 低于阈值 ${threshold}（${node.keyContent === true ? '关键内容' : '一般内容'}），不得落笔`,
      );
    }
    const finalText = params.editedText === undefined ? suggestion.text : params.editedText;
    return this.commit({
      op: 'accept-ai',
      actor,
      options,
      targets: [suggestion.targetNodeId],
      mutate: () => {
        if (node.type !== 'text') throw new WriteError(WRITE_ERRORS.E_TYPE_MISMATCH, `建议目标不是文本节点：${node.id}`);
        const at = this.tick();
        const runs = node.runs.length > 0 ? node.runs : [{ text: '' }];
        const last = runs.length - 1;
        node.runs = params.aiRanges === undefined
          ? [...runs.slice(0, last), { ...runs[last], text: finalText, provenance: aiRunProvenance(suggestion) }]
          : runsFromAiRanges(finalText, params.aiRanges, aiRunProvenance(suggestion));
        node.rev += 1;
        node.provenance = {
          origin: 'ai',
          modelId: suggestion.modelId,
          ...(suggestion.promptId ? { promptId: suggestion.promptId } : {}),
          confidence: suggestion.confidence,
          ...(suggestion.evidence ? { evidence: suggestion.evidence } : {}),
          acceptedBy: actor.id,
          acceptedAt: at,
          suggestionId: suggestion.id,
          at,
        };
        node.humanConfirmed = false; // 采纳 ≠ 确认责任：签名前必须由人确认
        this.book.markAccepted(suggestion.id, actor.id, at, editRatioOf(suggestion.text, finalText));
        return {
          targetId: node.id,
          extra: { aiSuggestionId: suggestion.id, modelId: suggestion.modelId, confidence: suggestion.confidence },
        };
      },
    });
  }

  rejectSuggestion(params: { suggestionId: string; reason?: string }, actor: Actor, options: WriteOptions = {}): WriteResult {
    this.assertHuman(actor, '拒绝 AI 建议');
    const suggestion = this.requirePendingSuggestion(params.suggestionId);
    return this.commit({
      op: 'reject-ai',
      actor,
      options,
      targets: [],
      mutate: () => {
        const at = this.tick();
        this.book.markRejected(suggestion.id, actor.id, at, params.reason);
        return {
          targetId: suggestion.targetNodeId,
          extra: { aiSuggestionId: suggestion.id, modelId: suggestion.modelId, confidence: suggestion.confidence },
        };
      },
    });
  }

  suggestBatch(
    params: {
      items: Array<{ nodeId: NodeId; text: string; confidence: number; modelId?: string; promptId?: string; evidence?: EvidenceRef[] }>;
      /** 批级默认 modelId（逐条可覆盖）；每条最终都必须有 modelId，否则无法审计 */
      modelId?: string;
      promptId?: string;
      traceId?: string;
    },
    actor: Actor,
  ): { ok: true; groupId: string | undefined; suggestionIds: string[]; reused: string[] } {
    this.assertActor(actor);
    const items = params.items ?? [];
    if (items.length === 0) {
      throw new WriteError(WRITE_ERRORS.E_SUGGESTION_SCOPE_REQUIRED, '批量建议至少要有一条');
    }
    const prepared = items.map((item, index): SuggestionBatchInput => {
      const modelId = item.modelId ?? params.modelId ?? '';
      const node = this.requireNode(item.nodeId);
      if (node.type !== 'text') {
        throw new WriteError(WRITE_ERRORS.E_TYPE_MISMATCH, `第 ${index + 1} 条：节点 ${item.nodeId} 不是文本节点（type=${node.type}）`);
      }
      if (!modelId || !Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1) {
        throw new WriteError(
          WRITE_ERRORS.E_AI_NO_PROVENANCE,
          `第 ${index + 1} 条：必须携带 modelId 与 0~1 的 confidence（NaN/越界值会绕过门控）`,
        );
      }
      const promptId = item.promptId ?? params.promptId;
      return {
        targetNodeId: item.nodeId,
        text: item.text,
        confidence: item.confidence,
        modelId,
        ...(promptId ? { promptId } : {}),
        ...(item.evidence ? { evidence: item.evidence } : {}),
      };
    });
    const { groupId, suggestionIds, reused } = this.book.addBatch(prepared, this.tick(), params.traceId);
    return { ok: true, groupId, suggestionIds, reused };
  }

  dictate(
    params: {
      transcriptionId: string;
      asrModelId: string;
      refineModelId?: string;
      segments: TranscriptSegment[];
      targetNodeId?: NodeId;
      targetNodeIds?: NodeId[];
      maxConfidence?: number;
    },
    actor: Actor,
  ): { ok: true; dictationId: string; groupId: string | undefined; suggestionIds: string[]; warnings: string[]; segments: TranscriptSegment[] } {
    this.assertActor(actor);
    if (!params.transcriptionId || !params.asrModelId) {
      throw new WriteError(WRITE_ERRORS.E_AI_NO_PROVENANCE, '语音转写必须携带 transcriptionId 与 asrModelId（否则回不到音频、也无法追责）');
    }
    const hasSingle = params.targetNodeId !== undefined;
    const hasList = params.targetNodeIds !== undefined;
    if (hasSingle === hasList) {
      throw new WriteError(
        WRITE_ERRORS.E_SUGGESTION_SCOPE_REQUIRED,
        '必须且只能给出 targetNodeId 或 targetNodeIds 之一：落位必须明确，内核不替医生猜段落该放哪',
      );
    }
    const normalized = normalizeSegments(params.segments ?? []);
    if (normalized.segments.length === 0) {
      throw new WriteError(WRITE_ERRORS.E_SUGGESTION_SCOPE_REQUIRED, '这次转写没有任何可用文本（全部是空段）');
    }
    const nodeIds = hasList
      ? (params.targetNodeIds as NodeId[])
      : normalized.segments.map(() => params.targetNodeId as NodeId);
    if (nodeIds.length !== normalized.segments.length) {
      throw new WriteError(
        WRITE_ERRORS.E_SUGGESTION_SCOPE_REQUIRED,
        `targetNodeIds 长度（${nodeIds.length}）必须等于有效转写段数（${normalized.segments.length}）：逐段落位不允许"少给几个"`,
      );
    }
    for (const nodeId of nodeIds) {
      const node = this.requireNode(nodeId);
      if (node.type !== 'text') {
        throw new WriteError(WRITE_ERRORS.E_TYPE_MISMATCH, `语音转写只能落到文本节点（${nodeId} 的 type=${node.type}）`);
      }
    }
    const at = this.tick();
    const items = toSuggestionItems(
      {
        transcriptionId: params.transcriptionId,
        asrModelId: params.asrModelId,
        ...(params.refineModelId ? { refineModelId: params.refineModelId } : {}),
        segments: normalized.segments,
        at,
      },
      { nodeIds, ...(params.maxConfidence !== undefined ? { maxConfidence: params.maxConfidence } : {}) },
    );
    const { groupId, suggestionIds } = this.suggestBatch(
      { items, modelId: params.asrModelId, traceId: `dictation:${params.transcriptionId}` },
      actor,
    );
    const warnings: string[] = [];
    if (normalized.dropped > 0) warnings.push(`已丢弃 ${normalized.dropped} 段空文本（未生成建议）`);
    if (normalized.outOfOrder > 0) {
      warnings.push(`转写中有 ${normalized.outOfOrder} 段时间戳倒序，已按时间重排（可能是 ASR 流式输出乱序）`);
    }
    if (normalized.segments.length > 1 && new Set(nodeIds).size < normalized.segments.length) {
      warnings.push(
        '多段转写落在同一节点：采纳是**替换**而不是追加，逐条采纳会互相覆盖 —— 建议为每段指定不同节点，或只采纳其中一条',
      );
    }
    warnings.push('语音内容一律先成为建议，须人工逐条确认后才能签章；第一版不做自动落位');
    return { ok: true, dictationId: params.transcriptionId, groupId, suggestionIds, warnings, segments: normalized.segments };
  }

  acceptSuggestions(
    params: { groupId?: string; suggestionIds?: string[]; editedTexts?: Record<string, string> },
    actor: Actor,
    options: WriteOptions = {},
  ): { ok: boolean; accepted: string[]; blocked: Array<{ suggestionId: string; code: string; message: string }> } {
    this.assertHuman(actor, '采纳 AI 建议');
    const scope = this.resolveSuggestionScope(params, '采纳');
    const blocked: Array<{ suggestionId: string; code: string; message: string }> = [];
    const ready: Array<{ suggestion: Suggestion; finalText: string }> = [];
    for (const suggestion of scope) {
      const node = this.requireNode(suggestion.targetNodeId);
      const threshold = this.thresholdFor(node);
      if (suggestion.confidence < threshold) {
        blocked.push({
          suggestionId: suggestion.id,
          code: WRITE_ERRORS.E_AI_LOW_CONFIDENCE,
          message: `置信度 ${suggestion.confidence} 低于阈值 ${threshold}（${node.keyContent === true ? '关键内容' : '一般内容'}）；该条保持待处理，并未被拒绝`,
        });
        continue;
      }
      const edited = params.editedTexts?.[suggestion.id];
      ready.push({ suggestion, finalText: edited === undefined ? suggestion.text : edited });
    }
    if (ready.length === 0) return { ok: false, accepted: [], blocked };

    const result = this.commit({
      op: 'accept-ai',
      actor,
      options,
      targets: ready.map((item) => item.suggestion.targetNodeId),
      mutate: () => {
        const at = this.tick();
        for (const { suggestion, finalText } of ready) {
          const node = this.requireNode(suggestion.targetNodeId);
          if (node.type !== 'text') throw new WriteError(WRITE_ERRORS.E_TYPE_MISMATCH, `建议目标不是文本节点：${node.id}`);
          const runs = node.runs.length > 0 ? node.runs : [{ text: '' }];
          const last = runs.length - 1;
          node.runs = [...runs.slice(0, last), { ...runs[last], text: finalText, provenance: aiRunProvenance(suggestion) }];
          node.rev += 1;
          node.provenance = {
            origin: 'ai',
            modelId: suggestion.modelId,
            ...(suggestion.promptId ? { promptId: suggestion.promptId } : {}),
            confidence: suggestion.confidence,
            ...(suggestion.evidence ? { evidence: suggestion.evidence } : {}),
            acceptedBy: actor.id,
            acceptedAt: at,
            suggestionId: suggestion.id,
            at,
          };
          node.humanConfirmed = false;
          this.book.markAccepted(suggestion.id, actor.id, at, editRatioOf(suggestion.text, finalText));
        }
        const head = ready[0] as { suggestion: Suggestion };
        return {
          targetId: head.suggestion.targetNodeId,
          extra: { aiSuggestionIds: ready.map((item) => item.suggestion.id) },
        };
      },
    });
    return { ok: result.ok === true, accepted: ready.map((item) => item.suggestion.id), blocked };
  }

  rejectSuggestions(
    params: { groupId?: string; suggestionIds?: string[]; reason?: string },
    actor: Actor,
    options: WriteOptions = {},
  ): { ok: true; rejected: string[] } {
    this.assertHuman(actor, '拒绝 AI 建议');
    const scope = this.resolveSuggestionScope(params, '拒绝');
    const rejected = scope.map((item) => item.id);
    this.commit({
      op: 'reject-ai',
      actor,
      options,
      targets: [],
      mutate: () => {
        const at = this.tick();
        for (const suggestion of scope) this.book.markRejected(suggestion.id, actor.id, at, params.reason);
        return {
          targetId: (scope[0] as Suggestion).targetNodeId,
          extra: { aiSuggestionIds: rejected },
        };
      },
    });
    return { ok: true, rejected };
  }

  private resolveSuggestionScope(params: { groupId?: string; suggestionIds?: string[] }, action: string): Suggestion[] {
    const hasGroup = params.groupId !== undefined;
    const hasIds = params.suggestionIds !== undefined;
    if (hasGroup && hasIds) {
      throw new WriteError(
        WRITE_ERRORS.E_SUGGESTION_SCOPE_REQUIRED,
        `批量${action}不能同时给出 groupId 与 suggestionIds：范围必须唯一，否则留痕说不清操作了什么`,
      );
    }
    if (!hasGroup && !hasIds) {
      throw new WriteError(WRITE_ERRORS.E_SUGGESTION_SCOPE_REQUIRED, `批量${action}必须给出 groupId 或 suggestionIds`);
    }
    if (hasGroup) {
      const groupId = params.groupId as string;
      const inGroup = this.book.list({ groupId, status: 'pending' });
      if (inGroup.length === 0) {
        throw new WriteError(WRITE_ERRORS.E_SUGGESTION_STATE, `组 ${groupId} 内没有待处理建议（可能已全部处理）`);
      }
      return inGroup;
    }
    const ids = [...new Set(params.suggestionIds as string[])];
    if (ids.length === 0) {
      throw new WriteError(WRITE_ERRORS.E_SUGGESTION_SCOPE_REQUIRED, `批量${action}的 suggestionIds 为空数组`);
    }
    return ids.map((id) => this.requirePendingSuggestion(id));
  }

  listSuggestions(filter: { status?: SuggestionStatus; targetNodeId?: NodeId; groupId?: string } = {}): Suggestion[] {
    return this.book.list(filter).map((item) => structuredClone(item));
  }

  listSuggestionGroups(): SuggestionGroup[] {
    return this.book.listGroups();
  }

  sidecarSnapshot(): { suggestions: SuggestionBookSnapshot; annotations: AnnotationBookSnapshot } {
    return { suggestions: this.book.snapshot(), annotations: this.annotations.snapshot() };
  }

  restoreSidecars(snapshot: { suggestions: SuggestionBookSnapshot; annotations: AnnotationBookSnapshot }): void {
    if (this.book.size() > 0 || this.annotations.size() > 0) {
      throw new WriteError(
        WRITE_ERRORS.E_SUGGESTION_STATE,
        '会话已产生建议或注解，拒绝用快照覆盖（避免丢掉本次会话刚做的操作）',
      );
    }
    this.book = SuggestionBook.restore(snapshot.suggestions);
    this.annotations = AnnotationBook.restore(snapshot.annotations);
  }

  annotate(
    params: {
      nodeId: NodeId;
      kind?: Annotation['kind'];
      severity?: AnnotationSeverity;
      title: string;
      detail?: string;
      suggestion?: string;
      quote?: string;
      source: AnnotationSource;
      evidence?: AnnotationEvidence[];
      dedupeKey?: string;
    },
    actor: Actor,
  ): { ok: true; annotationId: string; created: boolean; anchorState: AnchorState } {
    this.assertActor(actor);
    const node = this.requireNode(params.nodeId);
    if (!params.title || params.title.trim() === '') {
      throw new WriteError(WRITE_ERRORS.E_ANNOTATION_NO_EVIDENCE, '注解必须有一句话结论（title 不能为空）：无法用一句话说清的提示，医生也无从处置');
    }
    if (params.source.kind !== actor.kind) {
      throw new WriteError(
        WRITE_ERRORS.E_ANNOTATION_NO_EVIDENCE,
        `注解来源必须与实际提交者一致：source.kind=${params.source.kind}，actor.kind=${actor.kind}`,
      );
    }
    if (actor.kind === 'ai' && !params.source.modelId) {
      throw new WriteError(WRITE_ERRORS.E_AI_NO_PROVENANCE, 'AI 注解必须携带 modelId（否则无法回放与追责）');
    }
    const hasEvidence = (params.evidence?.length ?? 0) > 0 || params.source.ruleId !== undefined;
    if (actor.kind !== 'human' && !hasEvidence) {
      throw new WriteError(
        WRITE_ERRORS.E_ANNOTATION_NO_EVIDENCE,
        'AI / 规则注解必须给出依据（evidence 或 source.ruleId）：无依据的质控提示无法复核',
      );
    }
    const nodeText = node.type === 'text' ? node.runs.map((run) => run.text).join('') : undefined;
    const { annotation, created } = this.annotations.add({
      kind: params.kind ?? 'quality',
      severity: params.severity ?? 'warn',
      anchor: {
        nodeId: params.nodeId,
        ...(params.quote ? { quote: params.quote } : {}),
        ...(nodeText !== undefined ? { nodeText } : {}),
      },
      title: params.title,
      ...(params.detail ? { detail: params.detail } : {}),
      ...(params.suggestion ? { suggestion: params.suggestion } : {}),
      source: { ...params.source, ...(actor.kind === 'ai' ? {} : { actorId: actor.id }) },
      ...(params.evidence ? { evidence: params.evidence } : {}),
      ...(params.dedupeKey ? { dedupeKey: params.dedupeKey } : {}),
      at: this.tick(),
    });
    return { ok: true, annotationId: annotation.id, created, anchorState: this.evaluateAnchor(annotation.anchor) };
  }

  resolveAnnotation(
    params: { annotationId: string; status: Exclude<AnnotationStatus, 'open'>; note?: string },
    actor: Actor,
  ): { ok: true; annotationId: string; status: AnnotationStatus } {
    this.assertHuman(actor, '处置质控注解');
    const annotation = this.annotations.get(params.annotationId);
    if (!annotation) throw new WriteError(WRITE_ERRORS.E_ANNOTATION_NOT_FOUND, `注解不存在：${params.annotationId}`);
    if (annotation.status !== 'open' && annotation.status !== 'acknowledged') {
      throw new WriteError(WRITE_ERRORS.E_ANNOTATION_STATE, `注解已处于终态（${annotation.status}），不可再处置`);
    }
    const at = this.tick();
    this.annotations.transition(annotation.id, params.status, actor.id, at, params.note);
    return { ok: true, annotationId: annotation.id, status: params.status };
  }

  confirmAnchorLost(params: { annotationId: string; note?: string }, actor: Actor): { ok: true; annotationId: string; anchorState: AnchorState } {
    this.assertHuman(actor, '确认锚点已失效');
    const annotation = this.annotations.get(params.annotationId);
    if (!annotation) throw new WriteError(WRITE_ERRORS.E_ANNOTATION_NOT_FOUND, `注解不存在：${params.annotationId}`);
    if (annotation.status !== 'open' && annotation.status !== 'acknowledged') {
      throw new WriteError(WRITE_ERRORS.E_ANNOTATION_STATE, `注解已处于终态（${annotation.status}），无需确认锚点清除`);
    }
    const state = this.evaluateAnchor(annotation.anchor);
    if (state !== 'lost') {
      throw new WriteError(
        WRITE_ERRORS.E_ANNOTATION_STATE,
        `锚点仍然可用（${state}），无需确认"已随内容清除"：这个动作只能用于确实失效的锚点`,
      );
    }
    const at = this.tick();
    this.annotations.markAnchorLost(annotation.id, at);
    this.annotations.transition(annotation.id, annotation.status === 'open' ? 'dismissed' : annotation.status, actor.id, at, params.note ?? '锚点已随内容清除');
    return { ok: true, annotationId: annotation.id, anchorState: state };
  }

  listAnnotations(
    filter: { status?: AnnotationStatus; kind?: Annotation['kind']; nodeId?: NodeId; anchorState?: AnchorState } = {},
  ): Array<Annotation & { anchorState: AnchorState }> {
    return this.annotations
      .list(filter)
      .map((item) => ({ ...structuredClone(item), anchorState: this.evaluateAnchor(item.anchor) }))
      .filter((item) => !filter.anchorState || item.anchorState === filter.anchorState);
  }

  annotationFingerprint(): string {
    return this.annotations.fingerprint();
  }

  /** 注解统计（`anchorLost` 是必须处理的一项：不能让它静默累积）  */
  annotationCounts(): AnnotationCounts {
    const all = this.listAnnotations();
    const actionable = (item: { status: AnnotationStatus }): boolean => item.status === 'open' || item.status === 'acknowledged';
    return {
      total: all.length,
      open: all.filter((item) => item.status === 'open').length,
      acknowledged: all.filter((item) => item.status === 'acknowledged').length,
      dismissed: all.filter((item) => item.status === 'dismissed').length,
      resolved: all.filter((item) => item.status === 'resolved').length,
      anchorLost: all.filter((item) => item.anchorState === 'lost' && actionable(item)).length,
    };
  }

  getMetrics(): SuggestionMetrics {
    return this.book.metrics();
  }

  getSuggestionAttribution(): SuggestionAttribution {
    return this.book.attribution();
  }

  suggestionFingerprint(): string {
    return this.book.fingerprint();
  }

  /** 人工确认内容：AI 不可调用（确认是责任转移，必须由自然人做出） */
  confirmNode(params: { nodeId: NodeId }, actor: Actor, options: WriteOptions = {}): WriteResult {
    this.assertHuman(actor, '确认内容');
    const { nodeId } = params;
    return this.commit({
      op: 'update',
      actor,
      options,
      targets: [nodeId],
      mutate: () => {
        const node = this.requireNode(nodeId);
        node.humanConfirmed = true;
        delete node.unconfirmedTags;
        node.rev += 1;
        return { targetId: nodeId };
      },
    });
  }

  confirmNodes(params: { nodeIds: NodeId[] }, actor: Actor, options: WriteOptions = {}): WriteResult {
    this.assertHuman(actor, '确认内容');
    const nodeIds = [...new Set(params.nodeIds ?? [])];
    if (nodeIds.length === 0) {
      throw new WriteError(WRITE_ERRORS.E_CONFIRM_SCOPE_REQUIRED, '批量确认必须给出节点范围');
    }
    for (const id of nodeIds) this.requireNode(id);
    return this.commit({
      op: 'update',
      actor,
      options,
      targets: nodeIds,
      mutate: () => {
        for (const id of nodeIds) {
          const target = this.requireNode(id);
          if (target.humanConfirmed !== true || (target.unconfirmedTags?.length ?? 0) > 0) {
            target.humanConfirmed = true;
            delete target.unconfirmedTags;
            target.rev += 1;
          }
        }
        return { targetId: nodeIds[0] as NodeId, extra: { confirmedNodeIds: nodeIds } };
      },
    });
  }

  confirmSubtree(params: { nodeId: NodeId }, actor: Actor, options: WriteOptions = {}): WriteResult {
    this.assertHuman(actor, '确认内容');
    const root = this.requireNode(params.nodeId);
    const isSelfOrDescendant = (id: NodeId): boolean => {
      let cursor: NodeId | null = id;
      const seen = new Set<NodeId>();
      while (cursor !== null && !seen.has(cursor)) {
        if (cursor === root.id) return true;
        seen.add(cursor);
        cursor = this.doc.nodes[cursor]?.parentId ?? null;
      }
      return false;
    };
    const ids = Object.values(this.doc.nodes)
      .filter((item) => (item.type === 'text' || item.type === 'field' || (item.type === 'section' && item.keyContent === true))
        && isSelfOrDescendant(item.id))
      .map((item) => item.id);
    if (ids.length === 0) {
      throw new WriteError(
        WRITE_ERRORS.E_CONFIRM_SCOPE_REQUIRED,
        `节点 ${params.nodeId} 的子树里没有可确认的内容节点（text/field）`,
      );
    }
    return this.confirmNodes({ nodeIds: ids }, actor, options);
  }

  private async performSign(params: {
    op: 'sign' | 'review';
    actor: Actor;
    options: WriteOptions;
    acknowledge: boolean;
    note?: string;
  }): Promise<WriteResult> {
    const { op, actor, options, acknowledge, note } = params;
    const gate = this.assessSignGate(acknowledge);

    const at = this.resolveAt(options.at);
    const machineReadable = this.machineReadableAt(at);
    const signatureRef = `sig_${this.doc.docId}_${this.doc.revisions.length + 1}`;
    const meta = {
      signatureRef,
      documentId: this.doc.docId,
      signerRole: (op === 'review' ? 'reviewer' : 'author') as 'author' | 'reviewer',
      signerId: actor.id,
      signedAt: at,
    };

    const signature = await signTargets(this.signatureTargetsWith(machineReadable), meta, this.signer);

    return this.commit({
      op,
      actor,
      options,
      targets: [],
      mutate: () => {
        const nowDigest = signedInfoDigestOf(this.signatureTargetsWith(this.machineReadableAt(at)), meta, this.signer);
        if (nowDigest !== signature.signedInfoDigest) {
          throw new WriteError(
            WRITE_ERRORS.E_SIGN_CONTENT_CHANGED,
            '签章期间病历内容发生了变化：本次签名值已放弃（不能签下一份正在变的病历），请重新签章',
          );
        }
        this.doc.machineReadable = machineReadable;
        this.doc.status = 'signed';
        this.doc.signatureRefs = [
          {
            signatureRef,
            signerRole: meta.signerRole,
            signerId: actor.id,
            signedAt: at,
            covers: [...DOCUMENT_COVERS],
            algorithm: signature.meta.algorithm,
            provider: signature.meta.provider,
            publicKeyFingerprint: signature.publicKeyFingerprint,
            publicKeyBase64: signature.publicKeyBase64,
            signedInfoDigest: signature.signedInfoDigest,
            signatureValue: signature.signatureValue,
            references: signature.references.map((reference) => ({ ...reference })),
          },
        ];
        const extra = {
          ...(op === 'review' ? { review: { decision: 'approve' as const, ...(note ? { note } : {}) } } : {}),
          ...(gate.acknowledgedUnconfirmed ? { acknowledgedUnconfirmed: gate.acknowledgedUnconfirmed } : {}),
        };
        return { targetId: this.doc.rootId, ...(Object.keys(extra).length > 0 ? { extra } : {}) };
      },
    });
  }

  async sign(params: { acknowledgeUnconfirmed?: boolean } = {}, actor: Actor, options: WriteOptions = {}): Promise<WriteResult> {
    this.assertHuman(actor, '签章');
    return this.performSign({ op: 'sign', actor, options, acknowledge: params.acknowledgeUnconfirmed === true });
  }

  submitForReview(params: { note?: string } = {}, actor: Actor, options: WriteOptions = {}): WriteResult {
    this.assertHuman(actor, '提交审核');
    this.assertMutable('submit');
    const content = Object.values(this.doc.nodes).filter((node) => node.type === 'text' || node.type === 'field');
    if (content.length === 0) {
      throw new WriteError(WRITE_ERRORS.E_SUBMIT_EMPTY, '空文档不能提交审核：一份没写内容的病历不值得占用一次审核');
    }
    return this.commit({
      op: 'submit',
      actor,
      options,
      targets: [],
      mutate: () => {
        this.doc.status = 'reviewing';
        return { targetId: this.doc.rootId, extra: { review: { decision: 'submit' as const, ...(params.note ? { note: params.note } : {}) } } };
      },
    });
  }

  async review(
    params: { decision: 'approve' | 'reject'; note?: string; acknowledgeUnconfirmed?: boolean },
    actor: Actor,
    options: WriteOptions = {},
  ): Promise<WriteResult> {
    this.assertHuman(actor, '审核');
    this.assertMutable('review');
    const { decision } = params;
    if (decision !== 'approve' && decision !== 'reject') {
      throw new WriteError(WRITE_ERRORS.E_DOC_STATUS, `审核结论只能是 approve 或 reject，收到：${String(decision)}`);
    }
    if (this.doc.status !== 'reviewing') {
      throw new WriteError(WRITE_ERRORS.E_DOC_STATUS, `当前状态是 ${this.doc.status}，不在审核中：请先把文档提交审核`);
    }
    if (decision === 'approve') {
      return this.performSign({
        op: 'review',
        actor,
        options,
        acknowledge: params.acknowledgeUnconfirmed === true,
        ...(params.note ? { note: params.note } : {}),
      });
    }
    const note = (params.note ?? '').trim();
    if (note === '') {
      throw new WriteError(
        WRITE_ERRORS.E_REVIEW_NOTE_REQUIRED,
        '退回必须给出理由（会写入留痕）：不给理由的退回，医生拿到的只有"被打回了"，改什么全靠猜',
      );
    }
    return this.commit({
      op: 'review',
      actor,
      options,
      targets: [],
      mutate: () => {
        this.doc.status = 'draft';
        return { targetId: this.doc.rootId, extra: { review: { decision: 'reject' as const, note } } };
      },
    });
  }

  voidDoc(params: { reason: string }, actor: Actor, options: WriteOptions = {}): WriteResult {
    this.assertHuman(actor, '作废');
    this.assertMutable('void');
    const reason = (params.reason ?? '').trim();
    if (reason === '') {
      throw new WriteError(WRITE_ERRORS.E_VOID_REASON_REQUIRED, '作废必须给出理由（会写入留痕）：不给理由的作废等于病历凭空消失');
    }
    return this.commit({
      op: 'void',
      actor,
      options,
      targets: [],
      mutate: () => {
        this.doc.status = 'void';
        return { targetId: this.doc.rootId, extra: { voided: { reason } } };
      },
    });
  }

  archiveDoc(params: { note?: string } = {}, actor: Actor, options: WriteOptions = {}): WriteResult {
    this.assertHuman(actor, '归档');
    this.assertMutable('archive');
    if (this.doc.status !== 'signed') {
      throw new WriteError(WRITE_ERRORS.E_DOC_STATUS, `当前状态是 ${this.doc.status}：只有已签章的文书能归档`);
    }
    return this.commit({
      op: 'archive',
      actor,
      options,
      targets: [],
      mutate: () => {
        this.doc.status = 'archived';
        return { targetId: this.doc.rootId };
      },
    });
  }

  unlock(params: { reason: string }, actor: Actor, options: WriteOptions = {}): WriteResult {
    this.assertHuman(actor, '解锁已签章文档');
    this.assertMutable('unlock');
    const reason = (params.reason ?? '').trim();
    if (reason === '') {
      throw new WriteError(
        WRITE_ERRORS.E_UNLOCK_REASON_REQUIRED,
        '解锁必须给出理由（会写入留痕）：不给理由的解锁等于静默作废一次签章',
      );
    }
    if (this.doc.status === 'archived') {
      throw new WriteError(WRITE_ERRORS.E_UNLOCK_NOT_ALLOWED, '归档件不可解锁：归档是终态，需修改请重新开具一份');
    }
    if (this.doc.status !== 'signed') {
      throw new WriteError(WRITE_ERRORS.E_UNLOCK_NOT_ALLOWED, `当前状态是 ${this.doc.status}，不是已签章：无需解锁`);
    }
    return this.commit({
      op: 'unlock',
      actor,
      options,
      targets: [],
      mutate: () => {
        const invalidated = (this.doc.signatureRefs ?? []).map((ref) => ({
          publicKeyFingerprint: ref.publicKeyFingerprint ?? '',
          signedAt: ref.signedAt ?? '',
        }));
        this.doc.status = 'draft';
        return { targetId: this.doc.rootId, extra: { unlock: { reason, invalidated } } };
      },
    });
  }

  undoTarget(): { rev: number; op: RevisionOp } | null {
    return this.undoSlot ? { rev: this.undoSlot.rev, op: this.undoSlot.op } : null;
  }

  beginUndoGroup(): void {
    this.undoGroup = { rev: null, op: null, nodes: new Map() };
  }

  endUndoGroup(): void {
    this.undoGroup = null;
  }

  undoLast(actor: Actor, options: WriteOptions = {}): WriteResult {
    this.assertHuman(actor, '撤销');
    const slot = this.undoSlot;
    if (!slot) {
      throw new WriteError(
        WRITE_ERRORS.E_NOTHING_TO_UNDO,
        '没有可撤销的写入：只支持撤销最近一次，且签章/解锁之后不可撤销（它们改的是文档级状态）',
      );
    }
    const { rev: revertedRev, op: revertedOp, nodes, sidecars } = slot;
    return this.commit({
      op: 'revert',
      actor,
      options,
      targets: [...nodes.keys()],
      mutate: () => {
        for (const [id, before] of nodes) {
          if (before === undefined) delete this.doc.nodes[id];
          else this.doc.nodes[id] = structuredClone(before);
        }
        if (sidecars) this.restoreSidecars(sidecars);
        return { targetId: this.doc.rootId, extra: { revert: { revertedRev, revertedOp } } };
      },
    });
  }

  revertTo(params: { rev: number }, actor: Actor, options: WriteOptions = {}): WriteResult {
    this.assertHuman(actor, '回到历史版本');
    this.assertMutable('revert');
    const entries = this.doc.revisions;
    const toRev = params.rev;
    if (!Number.isInteger(toRev) || toRev < 1 || toRev >= entries.length) {
      throw new WriteError(
        WRITE_ERRORS.E_REVERT_TARGET,
        `回到历史版本的目标必须是已有的留痕、且不能是最新的那条（可选 rev 1~${Math.max(0, entries.length - 1)}），收到 rev=${String(toRev)}`,
      );
    }

    const revertedRevs = entries.slice(toRev).map((entry) => entry.rev);
    const crossed = entries.slice(toRev).reverse();

    const foreign = crossed.filter((entry) => entry.actorId !== actor.id && (entry.patch?.length ?? 0) > 0);
    if (foreign.length > 0) {
      const who = [...new Set(foreign.map((entry) => entry.actorId))].join('、');
      throw new WriteError(
        WRITE_ERRORS.E_REVERT_FOREIGN_WRITE,
        `这段区间里有 ${who} 写的内容（${foreign.length} 处）：只能回到自己写的那一版，别人的修改要由本人退回`,
      );
    }
    const touched = new Set<NodeId>();
    const inverse: PatchOp[] = [];
    for (const entry of crossed) {
      if (!entry.patch || entry.patch.length === 0) continue;
      for (const id of patchNodeIds(entry.patch)) touched.add(id);
      const descending = [...entry.patch].sort((left, right) => (left.path > right.path ? -1 : left.path < right.path ? 1 : 0));
      inverse.push(...descending.map(inverseOf));
    }

    let nodes: Record<NodeId, DocNode>;
    try {
      nodes = applyPatch({ nodes: structuredClone(this.doc.nodes) } as { nodes: Record<NodeId, DocNode> }, inverse).nodes;
    } catch (err) {
      throw new WriteError(
        WRITE_ERRORS.E_REVERT_IMPOSSIBLE,
        `回到 rev ${toRev} 做不到（${(err as Error).message}）：文档未被改动，也没有留下这次回滚的痕迹`,
      );
    }

    return this.commit({
      op: 'revert',
      actor,
      options,
      targets: [...touched],
      mutate: () => {
        this.doc.nodes = nodes;
        return { targetId: this.doc.rootId, extra: { revertedTo: { toRev, revertedRevs } } };
      },
    });
  }

  private assessSignGate(acknowledge: boolean): { acknowledgedUnconfirmed: { ai: string[]; imported: string[] } | null } {
    const keyUnconfirmed = Object.values(this.doc.nodes).filter((node) => node.keyContent === true && node.humanConfirmed !== true);
    if (keyUnconfirmed.length > 0) {
      throw new WriteError(
        WRITE_ERRORS.E_KEY_CONTENT_UNCONFIRMED,
        `存在关键内容未人工确认（${keyUnconfirmed.length} 条）：${keyUnconfirmed.map((node) => node.id).join(', ')}`,
      );
    }
    const tagUnconfirmed = Object.values(this.doc.nodes).filter((node) => (node.unconfirmedTags?.length ?? 0) > 0);
    if (tagUnconfirmed.length > 0) {
      throw new WriteError(
        WRITE_ERRORS.E_TAG_UNCONFIRMED,
        `存在机器绑定、尚未人工确认的数据元标签（${tagUnconfirmed.length} 条）：${tagUnconfirmed.map((node) => node.id).join(', ')}；` +
          '标签会进机读信息被下游系统直接消费，请逐段确认（确认这一段内容即认可它的标签，不接受则先撤销那一次绑定）',
      );
    }
    const aiUnconfirmed = Object.values(this.doc.nodes).filter(
      (node) => node.provenance?.origin === 'ai' && node.humanConfirmed !== true,
    );
    const importedUnconfirmed = Object.values(this.doc.nodes).filter(
      (node) =>
        node.provenance?.origin === 'imported' &&
        node.humanConfirmed !== true &&
        (node.type === 'text' || node.type === 'field'),
    );
    if (!acknowledge && aiUnconfirmed.length > 0) {
      throw new WriteError(
        WRITE_ERRORS.E_SIGNED_WITH_UNCONFIRMED_AI,
        `存在未经人工确认的 AI 内容（${aiUnconfirmed.length} 条）：${aiUnconfirmed.map((node) => node.id).join(', ')}；` +
          '如已通读并认可，请显式传 acknowledgeUnconfirmed=true（该声明会记入留痕）',
      );
    }
    if (!acknowledge && importedUnconfirmed.length > 0) {
      throw new WriteError(
        WRITE_ERRORS.E_IMPORTED_UNCONFIRMED,
        `存在未经人工确认的导入内容（${importedUnconfirmed.length} 条）：${importedUnconfirmed.map((node) => node.id).join(', ')}；` +
          '如已通读并认可，请显式传 acknowledgeUnconfirmed=true（该声明会记入留痕）',
      );
    }
    const acknowledgedUnconfirmed =
      aiUnconfirmed.length > 0 || importedUnconfirmed.length > 0
        ? { ai: aiUnconfirmed.map((node) => node.id), imported: importedUnconfirmed.map((node) => node.id) }
        : null;
    return { acknowledgedUnconfirmed };
  }

  /** 指定时间戳下的机读块（纯函数）：待签内容要在签名之前就定型  */
  private machineReadableAt(at: string): MachineReadableBlock {
    return buildMachineReadable({ nodes: this.doc.nodes, rootId: this.doc.rootId, schemaVersion: this.doc.schemaVersion, generatedAt: at });
  }

  private signatureTargetsWith(machineReadable: MachineReadableBlock): SignatureTarget[] {
    return documentSignatureTargets({ ...this.doc, machineReadable }, hashNodes(this.doc.nodes));
  }

  applyExternalData(
    params: {
      items: Array<{
        nodeId: NodeId;
        value: JsonValue;
        valueText?: string;
        unit?: string;
        evidence: EvidenceRef[];
        sampledAt?: string;
        referenceRange?: { low?: number; high?: number; text?: string; unit?: string };
      }>;
    },
    actor: Actor,
    options: WriteOptions = {},
  ): { ok: true; applied: NodeId[]; skipped: Array<{ nodeId: NodeId; reason: 'duplicate' }>; revision: number | null } {
    this.assertActor(actor);
    if (actor.kind !== 'system') {
      throw new WriteError(
        WRITE_ERRORS.E_EXTERNAL_ACTOR_INVALID,
        `系统取数只能由 system 身份发起（当前 kind=${actor.kind}）：AI 请走建议通道，人类请用 setFieldValue`,
      );
    }
    const items = params.items ?? [];
    if (items.length === 0) {
      throw new WriteError(WRITE_ERRORS.E_EXTERNAL_SCOPE_REQUIRED, '系统取数必须给出条目：空调用等于什么都没做');
    }

    const applied: NodeId[] = [];
    const skipped: Array<{ nodeId: NodeId; reason: 'duplicate' }> = [];

    for (const item of items) {
      const node = this.requireNode(item.nodeId);
      if (node.type !== 'field') {
        throw new WriteError(
          WRITE_ERRORS.E_TYPE_MISMATCH,
          `节点 ${item.nodeId} 不是字段节点（type=${node.type}）：系统取数只能写入结构化字段`,
        );
      }
      if (!Array.isArray(item.evidence) || item.evidence.length === 0) {
        throw new WriteError(
          WRITE_ERRORS.E_EXTERNAL_EVIDENCE_REQUIRED,
          `字段 ${item.nodeId} 缺少来源引用（evidence）：无法回溯的数据不得写入病历`,
        );
      }
      if (node.provenance.origin === 'human' || node.humanConfirmed === true) {
        throw new WriteError(
          WRITE_ERRORS.E_EXTERNAL_CONFLICT,
          `字段 ${item.nodeId} 已有内容「${node.valueText ?? String(node.value)}」，系统取数不覆盖人工填写/确认的内容（新值「${item.valueText ?? String(item.value)}」）；如需更新请人工修改`,
        );
      }
      if (node.provenance.origin === 'system') {
        const refs = new Set(item.evidence.map((reference) => reference.ref));
        const previous = (node.provenance as { evidence?: EvidenceRef[] }).evidence ?? [];
        const seen = previous.some((reference) => refs.has(reference.ref));
        if (seen && String(node.value) === String(item.value)) {
          skipped.push({ nodeId: item.nodeId, reason: 'duplicate' });
          continue;
        }
      }
      applied.push(item.nodeId);
    }

    if (applied.length === 0) {
      return { ok: true, applied: [], skipped, revision: null };
    }

    const byId = new Map(items.map((item) => [item.nodeId, item]));
    const result = this.commit({
      op: 'external',
      actor,
      options,
      targets: applied,
      mutate: () => {
        for (const id of applied) {
          const item = byId.get(id);
          const node = this.requireNode(id);
          if (!item || node.type !== 'field') continue;
          node.value = structuredClone(item.value);
          if (item.valueText !== undefined) node.valueText = item.valueText;
          if (item.unit !== undefined) node.unit = item.unit;
          if (item.sampledAt !== undefined) node.sampledAt = item.sampledAt;
          if (item.referenceRange !== undefined) node.referenceRange = structuredClone(item.referenceRange);
          node.provenance = {
            origin: 'system',
            actorId: actor.id,
            at: this.tick(),
            evidence: structuredClone(item.evidence),
          };
          node.humanConfirmed = false;
          node.rev += 1;
        }
        return { targetId: applied[0] as NodeId };
      },
    });
    return { ok: true, applied, skipped, revision: result.revision };
  }

  exportMachineReadable(): MachineReadableBlock {
    const block = buildMachineReadable({
      nodes: this.doc.nodes,
      rootId: this.doc.rootId,
      schemaVersion: this.doc.schemaVersion,
      generatedAt: this.doc.updatedAt,
    });
    this.doc.machineReadable = block;
    return structuredClone(block);
  }

  machineReadableStatus(): StalenessReport {
    return machineReadableStaleness(this.doc);
  }

  verifySignature(index = 0): VerifySignatureResult {
    const ref = this.doc.signatureRefs?.[index];
    const empty = { algorithm: '', provider: '', publicKeyFingerprint: '', referenceCount: 0 };
    if (!ref) return { ok: false, reasons: ['文档没有签名'], details: empty };
    if (!ref.signatureValue || !ref.publicKeyBase64 || !ref.signedInfoDigest || !ref.references || !ref.publicKeyFingerprint) {
      return {
        ok: false,
        reasons: ['签名材料不完整（缺签名值/公钥/指纹/摘要清单）—— 这类"签章"不可验证'],
        details: { ...empty, algorithm: ref.algorithm ?? '', provider: ref.provider ?? '' },
      };
    }

    const block: SignatureBlock = {
      meta: {
        signatureRef: ref.signatureRef,
        documentId: this.doc.docId,
        signerRole: ref.signerRole ?? 'author',
        signerId: ref.signerId ?? '',
        signedAt: ref.signedAt ?? this.doc.updatedAt,
        algorithm: ref.algorithm ?? '',
        provider: ref.provider ?? '',
      },
      publicKeyBase64: ref.publicKeyBase64,
      publicKeyFingerprint: ref.publicKeyFingerprint,
      references: ref.references.map((reference) => ({ path: reference.path, digest: reference.digest })),
      signedInfoDigest: ref.signedInfoDigest,
      signatureValue: ref.signatureValue,
    };
    return verifyTargets(block, documentSignatureTargets(this.doc, hashNodes(this.doc.nodes)));
  }

  /** 签名元信息（供界面展示：算法、后端、公钥指纹），不涉及密钥材料 */
  signatureInfo(index = 0): { algorithm: string; provider: string; publicKeyFingerprint: string; signedAt: string; covers: string[] } | null {
    const ref = this.doc.signatureRefs?.[index];
    if (!ref) return null;
    return {
      algorithm: ref.algorithm ?? '',
      provider: ref.provider ?? '',
      publicKeyFingerprint: ref.publicKeyFingerprint ?? '',
      signedAt: ref.signedAt ?? '',
      covers: ref.covers ?? [],
    };
  }

  signatureState(): SignatureState {
    const latest = this.signatureInfo();
    let unlockEntry: RevisionEntry | null = null;
    for (const entry of this.doc.revisions) {
      if (entry.op === 'unlock' && entry.unlock) unlockEntry = entry;
    }

    const signedStatus = this.doc.status === 'signed' || this.doc.status === 'archived';
    const kind: SignatureState['kind'] = !latest ? 'none' : signedStatus ? 'valid' : 'voided';
    const unlock = unlockEntry?.unlock;
    return {
      kind,
      latest,
      verified: latest ? this.verifySignature() : null,
      voidedBy:
        kind === 'voided' && unlockEntry && unlock
          ? { reason: unlock.reason, at: unlockEntry.at, invalidated: unlock.invalidated }
          : null,
    };
  }

  async exportOfd(plan: OfdExportPlan, options: Pick<OfdExportOptions, 'resolveImage'> = {}): Promise<OfdPackage> {
    if (!plan?.layout || plan.layout.textAsPath !== false) {
      throw new WriteError(WRITE_ERRORS.E_EXPORT_INVALID_PLAN, '导出计划必须声明 layout.textAsPath=false（禁止文本路径化）');
    }
    if (!plan.machineReadable || plan.machineReadable.signed !== true) {
      throw new WriteError(WRITE_ERRORS.E_EXPORT_INVALID_PLAN, '机读信息必须纳入签名覆盖范围（machineReadable.signed=true）');
    }
    const status = this.machineReadableStatus();
    if (status.stale) {
      throw new WriteError(
        WRITE_ERRORS.E_MACHINE_READABLE_STALE,
        `机读信息陈旧，需先 exportMachineReadable() 重算：${status.reasons.join('；')}`,
      );
    }
    return buildOfdPackage(this.doc, plan, {
      date: new Date(this.doc.updatedAt),
      signer: this.signer,
      ...(options.resolveImage ? { resolveImage: options.resolveImage } : {}),
    });
  }

  exportWst500(options: Wst500ExportOptions = {}): Wst500ExportResult {
    return buildWst500Xml(this.doc, options);
  }

  writeWst500File(filePath: string, options: Wst500ExportOptions = {}): { filePath: string; bytes: number; stats: Wst500ExportResult['stats'] } {
    const result = this.exportWst500(options);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, result.xml, 'utf8');
    return { filePath, bytes: result.xml.length, stats: result.stats };
  }

  async writeOfdFile(
    filePath: string,
    plan: OfdExportPlan,
    options: Pick<OfdExportOptions, 'resolveImage'> = {},
  ): Promise<{ filePath: string; pages: number; stats: OfdPackage['stats']; warnings: string[] }> {
    const pkg = await this.exportOfd(plan, options);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, pkg.bytes);
    return { filePath, pages: pkg.pages, stats: pkg.stats, warnings: pkg.warnings };
  }

  private evaluateAnchor(anchor: Annotation['anchor']): AnchorState {
    const node = this.doc.nodes[anchor.nodeId];
    if (!node) return 'lost';
    if (node.type !== 'text') return 'valid';
    const current = node.runs.map((run) => run.text).join('');
    if (anchor.nodeText === undefined || current === anchor.nodeText) return 'valid';
    if (anchor.quote !== undefined && anchor.quote !== '' && current.includes(anchor.quote)) return 'relocated';
    return 'lost';
  }

  private thresholdFor(node: DocNode): number {
    return node.keyContent === true ? this.aiKeyContentThreshold : this.aiThreshold;
  }

  private assertHuman(actor: Actor, action: string): void {
    this.assertActor(actor);
    if (actor.kind !== 'human') {
      throw new WriteError(WRITE_ERRORS.E_AI_NOT_ALLOWED, `仅自然人可执行"${action}"（actor.kind=${actor.kind}）`);
    }
  }

  private requirePendingSuggestion(id: string): Suggestion {
    const suggestion = this.book.get(id);
    if (!suggestion) throw new WriteError(WRITE_ERRORS.E_SUGGESTION_NOT_FOUND, `建议不存在：${id}`);
    if (suggestion.status !== 'pending') {
      throw new WriteError(WRITE_ERRORS.E_SUGGESTION_STATE, `建议状态非 pending：${suggestion.status}`);
    }
    return suggestion;
  }

  private commit(params: CommitParams): WriteResult {
    const { op, actor, options, targets, mutate } = params;
    this.assertActor(actor);

    if (this.blockAiDirectWrite && actor.kind === 'ai') {
      throw new WriteError(WRITE_ERRORS.E_AI_DIRECT_WRITE_FORBIDDEN, `AI 不得直接调用写接口（op=${op}）；请改用建议通道 + 人工采纳`);
    }
    if (options.clientOpId) {
      const replayed = this.opIndex.get(options.clientOpId);
      if (replayed) return { ...replayed, replayed: true };
    }
    if (options.expectedRev !== undefined && options.expectedRev !== this.docRev) {
      throw new WriteError(WRITE_ERRORS.E_REV_CONFLICT, `乐观锁冲突：期望 rev=${options.expectedRev}，当前 rev=${this.docRev}`);
    }
    this.assertMutable(op);

    const at = this.resolveAt(options.at);
    this.pendingAt = at;
    this.pendingWallClock = options.at !== undefined || this.clockSource === 'wall';

    const snapshots = new Map<NodeId, DocNode | undefined>();
    for (const id of targets) snapshots.set(id, this.doc.nodes[id] ? cloneDoc({ nodes: { [id]: this.doc.nodes[id] } } as unknown as DocumentModel).nodes[id] : undefined);
    const beforeAll = this.strategy === 'full' ? (structuredClone(this.doc.nodes) as Record<NodeId, DocNode>) : null;

    const commitRev = this.doc.revisions.length + 1;
    const preSidecars = TOUCHES_SUGGESTIONS.has(op) ? this.sidecarSnapshot() : undefined;

    const result = mutate();

    const undoNodes = new Map(snapshots);
    for (const id of result.created ?? []) {
      if (!undoNodes.has(id)) undoNodes.set(id, undefined);
    }
    if (NOT_UNDOABLE.has(op)) {
      /* 不可撤销的 op 同时作废整组：一个撤不动的组留着只会误导（点下去要么报错、要么撤错东西）  */
      this.undoSlot = null;
      this.undoGroup = null;
    } else if (this.undoGroup) {
      if (this.undoGroup.rev === null) {
        this.undoGroup.rev = commitRev;
        this.undoGroup.op = op;
        if (preSidecars) this.undoGroup.sidecars = preSidecars;
      }
      for (const [id, before] of undoNodes) {
        if (!this.undoGroup.nodes.has(id)) this.undoGroup.nodes.set(id, before);
      }
      this.undoSlot = {
        rev: this.undoGroup.rev,
        op: this.undoGroup.op as RevisionOp,
        nodes: this.undoGroup.nodes,
        ...(this.undoGroup.sidecars ? { sidecars: this.undoGroup.sidecars } : {}),
      };
    } else {
      this.undoSlot = {
        rev: commitRev,
        op,
        nodes: undoNodes,
        ...(preSidecars ? { sidecars: preSidecars } : {}),
      };
    }

    if (actor.kind === 'human' && EDIT_IMPLIES_CONFIRM.has(op) && options.implyConfirm !== false) {
      for (const id of targets) {
        if (result.created?.includes(id)) continue;
        const node = this.doc.nodes[id];
        if (node && node.humanConfirmed !== true && node.keyContent !== true) {
          node.humanConfirmed = true;
        }
      }
    }

    const patch: PatchOp[] = normalizePatchOrder(
      this.strategy === 'full'
        ? withOldValues(prefixNodePaths(jsonDiff(beforeAll as Record<NodeId, DocNode>, this.doc.nodes)), {
            nodes: beforeAll,
          } as unknown as JsonValue)
        : this.localPatch(snapshots, result),
    );

    this.doc.updatedAt = at;
    const revision: RevisionEntry = {
      rev: this.doc.revisions.length + 1,
      at,
      actorId: actor.id,
      op,
      ...(result.targetId ? { targetId: result.targetId } : {}),
      patch,
      ...(result.extra ?? {}),
    };
    this.doc.revisions = [...this.doc.revisions, revision];

    this.timingAcc.record(op, actor.kind, at, this.pendingWallClock);
    this.pendingAt = null;
    this.pendingWallClock = false;

    this.syncIndex(snapshots, result);

    const writeResult: WriteResult = { ok: true, targetId: result.targetId ?? null, docRev: this.docRev, revision: revision.rev };
    if (options.clientOpId) this.opIndex.set(options.clientOpId, writeResult);
    return writeResult;
  }

  private localPatch(snapshots: Map<NodeId, DocNode | undefined>, result: { created?: NodeId[]; deleted?: NodeId[] }): PatchOp[] {
    const ids = new Set<NodeId>([...snapshots.keys(), ...(result.created ?? []), ...(result.deleted ?? [])]);
    const ops: PatchOp[] = [];
    for (const id of ids) {
      const before = snapshots.get(id);
      const after = this.doc.nodes[id];
      if (before === undefined && after === undefined) continue;
      if (before === undefined) {
        ops.push({ op: 'add', path: `/nodes/${encodePointer(id)}`, value: after as unknown as JsonValue });
        continue;
      }
      if (after === undefined) {
        ops.push({ op: 'remove', path: `/nodes/${encodePointer(id)}`, oldValue: before as unknown as JsonValue });
        continue;
      }
      ops.push(
        ...withOldValues(prefixNodePaths(jsonDiff({ [id]: before }, { [id]: after } as Record<NodeId, DocNode>)), {
          nodes: { [id]: before },
        } as unknown as JsonValue),
      );
    }
    return ops;
  }

  private syncIndex(snapshots: Map<NodeId, DocNode | undefined>, result: { created?: NodeId[]; deleted?: NodeId[] }): void {
    const handled = new Set<NodeId>();
    for (const id of result.created ?? []) {
      const node = this.doc.nodes[id];
      if (node) this.index.onNodeAdded(node);
      handled.add(id);
    }
    for (const id of result.deleted ?? []) {
      if (!handled.has(id)) this.index.onNodeRemoved(id);
      handled.add(id);
    }
    for (const [id, before] of snapshots) {
      if (handled.has(id)) continue;
      const after = this.doc.nodes[id];
      if (before && after) this.index.onNodeChanged(before, after);
      else if (!before && after) this.index.onNodeAdded(after);
      else if (before && !after) this.index.onNodeRemoved(id);
    }
  }

  private assertMutable(op: RevisionOp): void {
    const status = this.doc.status;
    if (status === 'void') {
      throw new WriteError(
        WRITE_ERRORS.E_DOC_VOID,
        '文档已作废：作废是终态，任何修改都不被接受（需重新书写请新建一份）',
      );
    }
    if (status === 'reviewing' && op !== 'review' && op !== 'void') {
      throw new WriteError(
        WRITE_ERRORS.E_REVIEWING_IMMUTABLE,
        `文档正在审核中（reviewing）：改内容会让"审核人看的"与"最终签的"不是同一份；要修改请先由审核人退回`,
      );
    }
    if (status === 'archived' && op !== 'unlock') {
      throw new WriteError(WRITE_ERRORS.E_SIGNED_IMMUTABLE, '文档已归档：归档是终态，需修改请先解锁再签章');
    }
    /* 已签章：可解锁重来，也可归档（归档不改内容，不破坏签名） */
    if (status === 'signed' && op !== 'unlock' && op !== 'archive') {
      throw new WriteError(
        WRITE_ERRORS.E_SIGNED_IMMUTABLE,
        '文档已签章：须先「解锁」（会留痕并作废原签章）再修改，改完重新签章',
      );
    }
  }

  private requireNode(id: NodeId): DocNode {
    const node = this.doc.nodes[id];
    if (!node) throw new WriteError(WRITE_ERRORS.E_NODE_NOT_FOUND, `节点不存在：${id}`);
    return node;
  }

  private assertActor(actor: Actor): void {
    if (!actor || typeof actor.id !== 'string' || actor.id.length === 0 || !['human', 'ai', 'system'].includes(actor.kind)) {
      throw new WriteError(WRITE_ERRORS.E_ACTOR_INVALID, `actor 必须形如 { id, kind: human|ai|system }，收到：${JSON.stringify(actor)}`);
    }
  }

  private tick(): string {
    if (this.pendingAt !== null) return this.pendingAt;
    this.clock += 1000;
    return new Date(this.clock).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  private nowIso(): ISODateTime {
    const now = Math.max(Date.now(), this.clock);
    this.clock = now;
    return new Date(now).toISOString();
  }

  private resolveAt(injected?: ISODateTime): ISODateTime {
    if (injected === undefined) {
      return this.clockSource === 'wall' ? this.nowIso() : this.tick();
    }
    if (typeof injected !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(injected)) {
      throw new WriteError(
        WRITE_ERRORS.E_TIME_INVALID,
        `at 必须是 UTC ISO 时刻（形如 2026-10-18T09:30:00Z），收到：${JSON.stringify(injected)}`,
      );
    }
    const parsed = Date.parse(injected);
    if (!Number.isFinite(parsed)) {
      throw new WriteError(WRITE_ERRORS.E_TIME_INVALID, `at 无法解析：${JSON.stringify(injected)}`);
    }
    if (parsed < this.clock) {
      throw new WriteError(
        WRITE_ERRORS.E_TIME_REGRESS,
        `at 早于上一次提交（${new Date(this.clock).toISOString()}）：留痕必须单调，收到 ${injected}`,
      );
    }
    this.clock = parsed;
    return injected;
  }

  private provenanceFor(actor: Actor): Provenance {
    const base: Provenance = { origin: actor.kind === 'human' ? 'human' : actor.kind === 'ai' ? 'ai' : 'system', actorId: actor.id, at: this.tick() };
    return base;
  }

  /** 人工写入时保留 AI 来源链（否则 AI 参与度审计会在编辑后断链） */
  private humanProvenance(actor: Actor, previous: Provenance): Provenance {
    const at = this.tick();
    const next: Provenance = { origin: actor.kind === 'human' ? 'human' : 'system', actorId: actor.id, at };
    if (previous.origin === 'ai' || previous.derivedFrom) {
      next.derivedFrom = {
        modelId: previous.derivedFrom?.modelId ?? previous.modelId,
        confidence: previous.derivedFrom?.confidence ?? previous.confidence,
        suggestionId: previous.derivedFrom?.suggestionId ?? previous.suggestionId,
        editedBy: actor.id,
        editedAt: at,
      };
    }
    return next;
  }

  private nextNodeId(): NodeId {
    let candidate = '';
    do {
      this.seq += 1;
      candidate = `n_new_${this.seq}`;
    } while (this.doc.nodes[candidate]);
    return candidate;
  }

  private nextOrder(parentId: NodeId): number {
    let max = 0;
    for (const child of this.index.childrenOf(parentId)) {
      const order = this.doc.nodes[child]?.order ?? 0;
      if (order > max) max = order;
    }
    return max + 10;
  }
}

function encodePointer(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

function normalizePatchOrder(ops: PatchOp[]): PatchOp[] {
  return [...ops].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function patchNodeIds(patch: readonly PatchOp[]): NodeId[] {
  const ids: NodeId[] = [];
  for (const item of patch) {
    const matched = /^\/nodes\/([^/]+)/.exec(item.path);
    if (matched) ids.push(matched[1] as NodeId);
  }
  return ids;
}

export function inverseOf(op: PatchOp): PatchOp {
  if (op.op === 'add') return { op: 'remove', path: op.path, ...(op.value !== undefined ? { oldValue: op.value } : {}) };
  if (op.op === 'remove') {
    return op.oldValue === undefined ? { op: 'add', path: op.path, value: null } : { op: 'add', path: op.path, value: op.oldValue };
  }
  return {
    op: 'replace',
    path: op.path,
    value: op.oldValue ?? null,
    ...(op.value !== undefined ? { oldValue: op.value } : {}),
  };
}

function prefixNodePaths(ops: PatchOp[]): PatchOp[] {
  return ops.map((op) => ({ ...op, path: `/nodes${op.path === '/' ? '' : op.path}` }));
}

function withOldValues(ops: PatchOp[], root: JsonValue): PatchOp[] {
  return ops.map((op) => {
    if (op.op === 'add') return op;
    const oldValue = valueAtPointer(root, op.path);
    return oldValue === undefined ? op : { ...op, oldValue };
  });
}

function valueAtPointer(root: unknown, pointer: string): JsonValue | undefined {
  if (!pointer.startsWith('/')) return undefined;
  let cursor: unknown = root;
  for (const rawSegment of pointer.slice(1).split('/')) {
    const segment = rawSegment.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(cursor)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= cursor.length) return undefined;
      cursor = cursor[index];
    } else if (cursor && typeof cursor === 'object') {
      cursor = (cursor as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return cursor as JsonValue | undefined;
}
