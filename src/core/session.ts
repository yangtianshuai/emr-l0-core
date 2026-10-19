// T05/T06/T07 · 写路径会话（WriteSession）。

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
  /** 幂等令牌：同一 clientOpId 重复提交返回首次结果且不新增留痕 */
  clientOpId?: string;
  /** 乐观锁：必须等于当前文档 rev（= revisions.length），否则报冲突 */
  expectedRev?: number;
  /**
   * 是否套用"编辑即确认"（默认 `true` = 既有行为）。
   *
   * 只有一种情况该关掉它：这次提交一个字都没改（例如把一段文字绑上数据元标签）。
   * 那时"改过"这个前提不成立，再推定"医生看过并负责这段内容"就是替他签了一个他没做的字
   * （实测过：不关掉它，调用方写的 `humanConfirmed:false` 会被内核改回 `true`，
   * 于是机器猜出来的标签就拿到了人工背书）。
   *
   * 方向是保守的：关掉它只会少一次自动确认，不会少任何校验；默认仍是 `true`。
    */
  implyConfirm?: boolean;
  /**
   * 墙钟时刻（UTC，形如 `2026-10-18T09:30:00Z` 或带毫秒）。本次留痕与节点 provenance 都用它。
   *
   * 不传则退回逻辑时钟（每次提交 +1000ms，确定性、便于回放与 diff 比对）。
   * 代价必须讲清楚：逻辑时钟下算出来的「书写时长」是假的，等于"操作序号 × 1 秒"。
   * 所以只要有一次提交没带 `at`，`timing().clock` 就会如实标成 `logical` 或 `mixed`，
   * 且 `trusted` 为 false —— 不许拿它对外报数（见能力矩阵 G9：无可信时间戳）。
   *
   * 传入值必须单调不减（不得早于上一次提交时刻），否则报 `E_TIME_REGRESS`：
   * 留痕一旦能往回写，"后改的在先"就没法用时间判了。
   */
  at?: ISODateTime;
}

export interface WriteResult {
  ok: true;
  targetId: NodeId | null;
  /** 写入后的文档 rev */
  docRev: number;
  /** 本次写入产生的留痕 rev */
  revision: number;
  replayed?: boolean;
}

const EDIT_IMPLIES_CONFIRM: ReadonlySet<RevisionOp> = new Set<RevisionOp>(['create', 'insert', 'update']);

/**
 * 不可撤销的 op：它们改的是文档级字段（状态 / 签名 / 机读块 / 整份导入），
 * 而"撤销槽位"只保存节点表的提交前快照 —— 假装能撤会把状态与内容带偏
 * （例如"撤销签章"会把内容退回、状态却仍是 signed）。
 * 遇到这类动过之后，撤销槽位清空，而不是留着一个撤不动的旧槽位。
  */
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

/** 文档状态迁移类 op：它们改的是"这份病历现在处于哪一态"，而不是内容本身 */
const STATUS_OPS: ReadonlySet<RevisionOp> = new Set<RevisionOp>(['submit', 'review', 'void', 'archive']);

/** 会改旁挂数据（建议本）的 op：撤销时要连它一起回滚，否则会出现"内容退回去了、那条建议还是已采纳"  */
const TOUCHES_SUGGESTIONS: ReadonlySet<RevisionOp> = new Set<RevisionOp>(['accept-ai', 'reject-ai']);

export const WRITE_ERRORS = {
  E_ACTOR_INVALID: 'E_ACTOR_INVALID',
  E_AI_DIRECT_WRITE_FORBIDDEN: 'E_AI_DIRECT_WRITE_FORBIDDEN',
  E_REV_CONFLICT: 'E_REV_CONFLICT',
  /** 注入的时刻不是 UTC ISO 串（形如 `2026-10-18T09:30:00Z`）：解析不了的时刻不能进留痕 */
  E_TIME_INVALID: 'E_TIME_INVALID',
  /** 注入的时刻早于上一次提交：留痕必须单调，往回写会让"谁先谁后"无法判断 */
  E_TIME_REGRESS: 'E_TIME_REGRESS',
  E_SIGNED_IMMUTABLE: 'E_SIGNED_IMMUTABLE',
  E_NODE_NOT_FOUND: 'E_NODE_NOT_FOUND',
  E_PARENT_NOT_FOUND: 'E_PARENT_NOT_FOUND',
  E_TYPE_MISMATCH: 'E_TYPE_MISMATCH',
  /** 控件里没有这一格：拼错的键写进去不会报错，只会变成"医生填的值在导出里凭空不见" */
  E_CELL_UNKNOWN: 'E_CELL_UNKNOWN',
  /** 值与那一格的 `dataType` 对不上：控件的 payload 是机器真值（带 tag 的格会摊成数据元）  */
  E_CONTROL_VALUE_INVALID: 'E_CONTROL_VALUE_INVALID',
  /**
   * 图片地址非法（空串）。
   * 空 `resRef` 在模型里的意思是"还没贴"（模板开出来的空槽），
   * 把它当成"清空这张图"会把"医生删掉了图"与"这里一直没贴"混成一件事 ——
   * 要清图就删节点。
    */
  E_IMAGE_REF_INVALID: 'E_IMAGE_REF_INVALID',
  E_KEY_CONTENT_PROTECTED: 'E_KEY_CONTENT_PROTECTED',
  /**
   * 必备章节禁止删除。
   *
   * 与 `E_KEY_CONTENT_PROTECTED` 是两道不同的门：那一道判"这一块内容敢不敢删"（责任标记），
   * 这一道判"这一章在不在"（结构标记，由模板的章节属性带来）。
   * 合成一个码会让界面只能说"这一块删不掉"，而医生说不出到底是"不能删内容"还是"不能删这一章"。
    */
  E_REQUIRED_SECTION_PROTECTED: 'E_REQUIRED_SECTION_PROTECTED',
  /** 批量确认未给出范围：空范围确认是"看起来做了事其实什么都没做"，必须拒绝 */
  E_CONFIRM_SCOPE_REQUIRED: 'E_CONFIRM_SCOPE_REQUIRED',
  /** 系统取数只能由 system 身份发起：AI 走建议通道，人类走 setFieldValue */
  E_EXTERNAL_ACTOR_INVALID: 'E_EXTERNAL_ACTOR_INVALID',
  /** 系统取数必须带强引用来源：没有来源的数据无法回溯，比不引入更糟 */
  E_EXTERNAL_EVIDENCE_REQUIRED: 'E_EXTERNAL_EVIDENCE_REQUIRED',
  /** 目标字段已被医生动过：系统取数不覆盖人工内容，报冲突交人决定  */
  E_EXTERNAL_CONFLICT: 'E_EXTERNAL_CONFLICT',
  E_EXTERNAL_SCOPE_REQUIRED: 'E_EXTERNAL_SCOPE_REQUIRED',
  E_HAS_CHILDREN: 'E_HAS_CHILDREN',
  E_CYCLE_DETECTED: 'E_CYCLE_DETECTED',
  E_INVALID_PATCH: 'E_INVALID_PATCH',
  E_NODE_TYPE_UNKNOWN: 'E_NODE_TYPE_UNKNOWN',
  /* AI 建议通道与门控（T10~T15） */
  E_AI_NOT_ALLOWED: 'E_AI_NOT_ALLOWED',
  E_AI_LOW_CONFIDENCE: 'E_AI_LOW_CONFIDENCE',
  E_AI_NO_PROVENANCE: 'E_AI_NO_PROVENANCE',
  E_SUGGESTION_NOT_FOUND: 'E_SUGGESTION_NOT_FOUND',
  E_SUGGESTION_STATE: 'E_SUGGESTION_STATE',
  /**
   * 批量建议操作未给出范围（或范围二义）。
   * 空范围操作是"看起来做了事其实什么都没做"，必须显式拒绝 —— 与批量确认同一条原则。
   */
  E_SUGGESTION_SCOPE_REQUIRED: 'E_SUGGESTION_SCOPE_REQUIRED',
  /* 旁挂注解（质控提示 / 人工批注）。注意：它们不是文档内容，处置不进文档留痕  */
  E_ANNOTATION_NOT_FOUND: 'E_ANNOTATION_NOT_FOUND',
  E_ANNOTATION_STATE: 'E_ANNOTATION_STATE',
  /**
   * AI / 规则来源的注解未给出依据。
   * 无依据的质控提示无法复核 —— 医生只能选择"信"或"不信"，那是在消耗信任，不是在质控。
   */
  E_ANNOTATION_NO_EVIDENCE: 'E_ANNOTATION_NO_EVIDENCE',
  E_KEY_CONTENT_UNCONFIRMED: 'E_KEY_CONTENT_UNCONFIRMED',
  /**
   * 机器绑定的数据元标签未经人工确认。
   *
   * 与"关键内容未确认"同档：永远阻断、不受 `acknowledgeUnconfirmed` 影响。
   * 理由是那个声明的语义是"这些内容我通读并认可了"，而标签是逐条的元数据：
   * 用一句通篇声明覆盖掉它，等于把"逐条确认"稀释成"点一下就行"。
    */
  E_TAG_UNCONFIRMED: 'E_TAG_UNCONFIRMED',
  E_SIGNED_WITH_UNCONFIRMED_AI: 'E_SIGNED_WITH_UNCONFIRMED_AI',
  E_IMPORTED_UNCONFIRMED: 'E_IMPORTED_UNCONFIRMED',
  /* 机读信息与导出（T16/T17） */
  E_MACHINE_READABLE_STALE: 'E_MACHINE_READABLE_STALE',
  E_EXPORT_INVALID_PLAN: 'E_EXPORT_INVALID_PLAN',
  E_OFFSET_RANGE: 'E_OFFSET_RANGE',
  /* 解锁与撤销 */
  E_UNLOCK_REASON_REQUIRED: 'E_UNLOCK_REASON_REQUIRED',
  /** 当前状态不允许解锁（未签章 / 已归档 —— 归档是终态） */
  E_UNLOCK_NOT_ALLOWED: 'E_UNLOCK_NOT_ALLOWED',
  /* 审签状态机（K12） */
  /** 当前状态下这个动作做不了（例如草稿直接审核 / 已归档再归档） */
  E_DOC_STATUS: 'E_DOC_STATUS',
  /**
   * 审核中不允许改内容。
   *
   * 这是"审核"这件事本身的要求：审核人在看的是 A 版，作者同时改成 B 版，
   * 审的东西和签的东西就不是一份。要改就先退回。
   */
  E_REVIEWING_IMMUTABLE: 'E_REVIEWING_IMMUTABLE',
  /** 已作废：作废是终态，需重新书写请新建一份 */
  E_DOC_VOID: 'E_DOC_VOID',
  /** 空文档提交审核：什么都没写的东西不值得占用一次审核 */
  E_SUBMIT_EMPTY: 'E_SUBMIT_EMPTY',
  /** 审核退回必须给出理由：不给理由的退回，医生改什么全靠猜 */
  E_REVIEW_NOTE_REQUIRED: 'E_REVIEW_NOTE_REQUIRED',
  /** 作废必须给出理由（写进留痕）："为什么这份没了"只能由留痕回答 */
  E_VOID_REASON_REQUIRED: 'E_VOID_REASON_REQUIRED',
  /** 没有可撤销的写入（只支持撤销最近一次；签章/解锁之后不可撤销） */
  E_NOTHING_TO_UNDO: 'E_NOTHING_TO_UNDO',
  /** 回到历史版本的目标 rev 不是已有留痕（或就是最新一条，等于没退） */
  E_REVERT_TARGET: 'E_REVERT_TARGET',
  /**
   * 那一版回不去：跨过的某条留痕缺可以改变方向的依据。
   * 半途回滚比不回滚更糟 —— 文档会变成一个从未存在过的样子，所以这里是整体失败。
   */
  E_REVERT_IMPOSSIBLE: 'E_REVERT_IMPOSSIBLE',
  /**
   * 取签名值与提交之间病历被改动：这一次的签名值对应的是另一份内容，必须放弃。
   * 宁可让人重试一次，也不能签下一份正在变的病历。
    */
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

/**
 * 演示签名密钥的种子。
 *  种子公开 ⇒ 私钥可被任何人推导（`demoKeyPair` 就是确定性派生）。
 *    仅用于演示与验收可复现；生产必须注入密码设备后端（`SessionOptions.signer`）。
  */
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
  /**
   * 时钟来源（默认 `logical`）。
   *
   * `logical`：每次提交 +1000ms。确定性，回放与 diff 比对需要它，自测默认走这条路 ——
   * 代价是留痕时间不是真实时间，书写时长不可信（`timing().trusted === false`）。
   *
   * `wall`：不传 `at` 时用 `Date.now()`。一次打开会话就不用再逐笔注入，
   * 适合服务端/客户端这类"本来就该记真实时间"的场景。
   */
  clock?: 'logical' | 'wall';
  /**
   * 书写时长的「空闲阈值」：相邻两次书写间隔超过它，这段间隔判为空闲、不计入有效时长（默认 120_000ms）。
   *
   * 它防的是最容易被钻的空子：挂着页面去查房/吃饭，回来再写两个字 ——
   * 若按 lastEditAt − firstEditAt 算，那份病历的"书写时长"是三小时。
   * 调大 = 更宽容（适合门诊连写），调小 = 更严格（适合只想要"纯打字时间"的场景）。
   */
  idleThresholdMs?: number;
}



/**
 * 不允许通过 updateNodeProps 直接改的字段（结构类字段须走专用接口以触发校验）。
 *
 * `required` 在这里的理由是它自己就是一道门：必备章节靠 `deleteNode` 拒删来兜底，
 * 若它反过来能被一次 `updateNodeProps` 关掉，那道门就等于形同虚设
 * （先把它改成 false、再删掉那一章，留痕里看只有"改过一个布尔值"）。
 * 它是模板在开文书那一刻写下的结构声明，不是可随手改的内容属性。
  */
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
  /** `none`：从没签过；`valid`：当前签章有效；`voided`：签过，但已被解锁作废 */
  kind: 'none' | 'valid' | 'voided';
  /** 最近一次签章的元信息（已被作废也保留 —— 历史不删，界面要能显示"原签章是什么"）  */
  latest: { algorithm: string; provider: string; publicKeyFingerprint: string; signedAt: string; covers: string[] } | null;
  /**
   * 对当前内容的独立验签结论。
   *
   *  它不能用来回答"这份病历是不是已被作废/被篡改"：解锁本身不改内容，
   * 所以解锁后若内容还没动过，它仍可能 `ok:true`（而签章其实已经作废）；改了内容之后必然 `ok:false`
   * （看起来又像被篡改）。这两种情况都不是篡改 —— 判断只能看 `kind`（这是本字段存在的理由）。
    */
  verified: VerifySignatureResult | null;
  /** 被解锁作废时：理由、时间，以及被作废的那一次签章（指纹与时间） */
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

  /**
   * 签名后端。
   *
   * 默认是自研软件实现 + 演示密钥（自测与可复现验收需要它）；产品侧必须注入真实后端：
   * `SessionOptions.signer`，或用 `setSigner()` 换成配置里的医院签名服务。
    */
  private signer: Signer;

  private clock: number;

  /**
   * 本次提交的时间锚点。
   *
   * 一次提交内部有多处要落时间（节点 provenance、建议本、批注、留痕条目），
   * 它们必须拿到**同一个**时刻 —— 否则"改了内容"和"留痕"会出现两个不同的时间，
   * 提交就不再是原子的。注入墙钟时它锁住那个值，逻辑时钟下为 null（照旧递增）。
   */
  private pendingAt: ISODateTime | null = null;

  /** 本次提交的时刻是不是真实时钟给的（决定时长能不能信） */
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

  /**
   * 留痕检索：按时间窗 / 操作人 / op 过滤。
   *
   * 痕迹攒到几百条之后，"把整份 revisions 丢给前端自己筛"既慢又容易筛错口径
   * （尤其是时间窗的闭合区间怎么算）。这里把口径钉死：`from`/`to` 都是闭区间。
   */
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

  /**
   * 书写时长。
   *
   * `trusted` 为 false 时这个数字只能自己看：它来自逻辑时钟（或混用过），
   * 本质是"操作序号 × 1 秒"，不是医生真花的时间（G9：无可信时间戳）。
   */
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

  /** 不变量自检：文档合法 + 索引未漂移。供调用方在批量写入后抽样使用 */
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

  /**
   * 删除节点。
   *   mode='single'（默认）：有子节点则拒绝（隐式级联是数据事故常见来源）；
   *   mode='subtree'：连同全部后代一起删除。
   * 关键内容节点（keyContent）在两种模式下都禁止删除。
   */
  deleteNode(params: { nodeId: NodeId; mode?: 'single' | 'subtree' }, actor: Actor, options: WriteOptions = {}): WriteResult {
    const { nodeId, mode = 'single' } = params;
    return this.commit({
      op: 'delete',
      actor,
      options,
      targets: mode === 'subtree' ? this.index.subtreeIds(nodeId) : [nodeId],
      mutate: () => {
        /* 存在性检查（不绑定变量：关键内容判定改为查整棵子树，见下） */
        this.requireNode(nodeId);
        if (nodeId === this.doc.rootId) throw new WriteError(WRITE_ERRORS.E_KEY_CONTENT_PROTECTED, '根节点不可删除');
        if (mode === 'single' && this.index.childrenOf(nodeId).length > 0) {
          throw new WriteError(WRITE_ERRORS.E_HAS_CHILDREN, `节点 ${nodeId} 仍有子节点，如需级联删除请显式指定 mode='subtree'`);
        }
        const victims = mode === 'subtree' ? this.index.subtreeIds(nodeId) : [nodeId];
        /* 关键内容禁删必须查整棵被删子树，不能只看目标节点。
           删一个段落（subtree）会连带删掉它下面的文本节点，而"关键内容"标记恰恰落在文本/字段节点上 ——
           只看目标就等于给"删父节点"留了一道绕过禁删的后门。
           （加段落级删除入口时实测发现：paragraph 本身不标 keyContent，它下面的 text 才标。）  */
        const protectedVictims = victims.filter((id) => this.doc.nodes[id]?.keyContent === true);
        if (protectedVictims.length > 0) {
          throw new WriteError(
            WRITE_ERRORS.E_KEY_CONTENT_PROTECTED,
            `关键内容节点禁止删除：${protectedVictims.join(', ')}`,
          );
        }
        /* 必备章节禁删（`SectionNode.required`）。同样要查整棵被删子树：
           删一个上层节点（段落 / 外层章节）不得把必备章节连带删掉 ——
           否则"必备"就只挡得住直接点那一章的删除按钮。
           报的是章节标题而不是节点 id：医生要能看懂是哪一章。  */
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

  /* ------------------- AI 建议通道与门控（T10~T15） ------------------- */

  /**
   * 提交 AI 建议。不落笔、不留痕、不改 rev：门控在"落笔"而非"生成"，
   * 因此低置信建议照样可以展示（医生可能人工修改后采纳）。
   * 必须携带 modelId 与 confidence，否则无法审计与回放。
    */
  suggestText(
    params: {
      nodeId: NodeId;
      text: string;
      confidence: number;
      modelId: string;
      promptId?: string;
      evidence?: EvidenceRef[];
      /** 外部调用关联（模型一次调用可能产出多条）：透传供追溯；不构成分组（分组走 suggestBatch）  */
      traceId?: string;
    },
    actor: Actor,
  ): { ok: true; suggestionId: string; reused: boolean } {
    this.assertActor(actor);
    const { nodeId, text, confidence, modelId, promptId, evidence, traceId } = params;
    const node = this.requireNode(nodeId);
    if (node.type !== 'text') throw new WriteError(WRITE_ERRORS.E_TYPE_MISMATCH, `节点 ${nodeId} 不是文本节点（type=${node.type}）`);
    /* 必须校验"有限且在 0~1"：仅判 typeof === 'number' 会让 NaN 通过，
       而 NaN < threshold 恒为 false —— 低质量建议会直接绕过置信度门控落笔（实测踩到，两套实现都中招）。 */
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
        /* 落笔同时写 run 级来源：这一段被 AI 覆盖的字符从此标着 "ai"，
           医生随后在它中间插字会生成没有来源的新 run（见 text-runs.ts），两种来源可分辨。
           给了 `aiRanges` 就按区间分：逐句采纳时医生保留的原句不标 AI。
           节点级 provenance 两种情况下都记 ai —— 它回答的是"这条建议被谁采纳"，
           与"哪些字符是 AI 逐字写的"（run 级）是两件事，不该互相冒充。 */
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

  /** 拒绝建议：仅自然人；留痕 op=reject-ai（不改节点内容，故 patch 允许为空） */
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
    /* `groupId` 可能为空：整批都与仍待处理的旧建议同文本时，不建组
       （组是有条数的操作单元，空组会让界面的"接受本组"落在一个不存在的范围上）。
       此时 `reused` 里是那些旧建议的 id —— 界面必须如实说明"这些已在待处理里"，而不是报"新增 0 条"。  */
    const { groupId, suggestionIds, reused } = this.book.addBatch(prepared, this.tick(), params.traceId);
    return { ok: true, groupId, suggestionIds, reused };
  }

  dictate(
    params: {
      transcriptionId: string;
      asrModelId: string;
      refineModelId?: string;
      segments: TranscriptSegment[];
      /** 所有段落到同一个节点（适合单段转写）；与 `targetNodeIds` 二选一  */
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
          /* 与单条采纳同一份来源构造：两处各写一遍的后果是"同一份数据在两张报表上不一样" */
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
          node.humanConfirmed = false; // 采纳 ≠ 确认责任：批量采纳同样不替医生负责
          /* 批量与单条走同一个改动幅度算法：两处各写一遍的后果是
             "同一份数据在两张报表上不一样"，而报表正是拿来比版本好坏的  */
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

  /** 批量/组级拒绝建议：一次留痕；空范围同样被拒（与采纳对称） */
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

  /**
   * 解析批量操作范围：`groupId` 与 `suggestionIds` 二选一。
   *
   * 同时给出会被拒（而不是取并集）：并集无法解释"我到底操作了什么"，而留痕必须能说明范围。
   * 都不给同样被拒（空范围不能静默成功）。
   *
   * 两种范围的语义有意不同：
   *   - 显式给 `suggestionIds`：任何一个不存在或非 pending 都报错 —— 那是调用方的错误；
   *   - 按 `groupId` 过滤：已处理的条目跳过即可 —— 组内某条被别人先处理是正常时序，
   *     不该让整组操作莫名失败（但整组都已处理时仍报错，避免"点了没反应"）。
    */
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

  /**
   * 导出旁挂数据（建议 + 注解）的快照，供持久化。
   *
   * 只导出旁挂数据，不含文档内容：文档有自己的导出链路（JSON / OFD / WS/T 500），
   * 而且它是内容、要进签名；旁挂数据是过程、不进签名。两者的存储与生命周期不该混在一起。
    */
  sidecarSnapshot(): { suggestions: SuggestionBookSnapshot; annotations: AnnotationBookSnapshot } {
    return { suggestions: this.book.snapshot(), annotations: this.annotations.snapshot() };
  }

  /**
   * 启动时用快照替换旁挂数据。
   *
   *  只在会话刚打开、尚未产生任何建议/注解时允许 —— 否则会用磁盘上的旧状态
   * 覆盖掉本次会话已经发生的操作（那是数据丢失，而且丢的是"刚刚做的"）。
   * 宁可显式报错，也不做"合并"：合并两批建议的语义（谁是新的、冲突怎么算）没有定义，
   * 而未定义的合并比拒绝更危险。
    */
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

  /* ------------------- 旁挂注解：质控提示与人工批注 ------------------- */

  annotate(
    params: {
      nodeId: NodeId;
      kind?: Annotation['kind'];
      severity?: AnnotationSeverity;
      title: string;
      detail?: string;
      suggestion?: string;
      /** 提出提示时的原文片段（内容被改写后据此判断"那句话是否还在"） */
      quote?: string;
      source: AnnotationSource;
      evidence?: AnnotationEvidence[];
      /** 去重键：同源同锚点同规则只保留一条（已忽略的不复活，但内容变了可重新提） */
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
    /* 锚点文本由内核采集，不采信调用方给的（否则可以伪造"当时写的是这句"，
       使锚点失效判定失去意义）。`actorId` 同理：一律取当前操作者。  */
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
    /* 已终态的注解无需确认锚点清除：它已经处理完了，再确认一次没有意义，
       还会让"确认"这个动作看起来像例行公事（那它就不再是一个需要判断的动作了）。 */
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

  /**
   * 注解指纹（跨实现比对用）。
   *
   * 不含锚点派生状态：那取决于当前文档内容，不属于注解自身 ——
   * 若纳入，同一个注解集合在"文档被编辑过"与"没被编辑过"的两个实现上
   * 会被判成不一致，比对就失去了意义。
    */
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
      /**
       * 只计还需要人处理的锚点丢失。
       *
       * 已解决 / 已忽略的注解即使锚点失效，也不需要谁去确认 —— 它已经处理完了。
       * 若把它们也算进来，界面上会永远挂着一个"锚点丢失 N"，而其中几条根本无从处理，
       * 那这个计数就从"提醒"变成了"噪音"，很快会被无视（实测端到端时撞到：一条已忽略的
       * 注解因内容被改写而锚点失效，却仍在计数里）。
        */
      anchorLost: all.filter((item) => item.anchorState === 'lost' && actionable(item)).length,
    };
  }

  getMetrics(): SuggestionMetrics {
    return this.book.metrics();
  }

  /**
   * 三级归因：采纳拆成 原样 / 微改 / 大改（外加"未归因"）。
   *
   * 与 `getMetrics()` 并列：前者回答"AI 的建议有没有被用"，它回答"用了之后医生改了多少、
   * 改得轻还是重"。后者决定该改提示词还是改取数，混成一个"修改率"就分不出来了。
    */
  getSuggestionAttribution(): SuggestionAttribution {
    return this.book.attribution();
  }

  /** 供跨实现比对使用的建议状态指纹 */
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
        /* 确认"这一段我看过了"= 连带认可它上面机器绑的标签（标签就挂在这段内容上）。
           不在这里清掉，医生就会卡在"确认了内容、门控还是拦"的死结里，而界面上没有任何按钮能解开。  */
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
          /* 已经确认过的节点不再递增 rev：嵌套章节会让同一节点落在两个子树里
             （实测：9 个内容节点的门诊病历，按章节确认时被确认 10 次），
             重复确认不该把版本号推高 —— rev 是给人做并发控制与版本判断的。  */
          /* 有待确认的机器标签时，即使内容早就确认过也要走一次：
             清标签本身就是一次真实写入，跳过它就会出现"确认过了、门控还是拦"的死结  */
          if (target.humanConfirmed !== true || (target.unconfirmedTags?.length ?? 0) > 0) {
            target.humanConfirmed = true;
            delete target.unconfirmedTags;
            target.rev += 1;
          }
        }
        /* 留痕记录的是请求范围（而不是"本次新确认的几个"）：
           审计要回答的是"他当时确认了哪些内容"，范围本身比增量更有意义  */
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

  /**
   * 签章的共用路径：`sign`（自书自签）与 `review(approve)`（审核通过即签章）都走这里。
   *
   * 两条路刻意共用且只共用这一处 —— "签下去的东西是什么、覆盖到哪、留痕记什么"
   * 一旦有两份实现，迟早会出现"审核通过签的"和"自己签的"行为不一样。
   * 差别只有签名角色：作者签 `author`，审核人签 `reviewer`。
   */
  private async performSign(params: {
    op: 'sign' | 'review';
    actor: Actor;
    options: WriteOptions;
    acknowledge: boolean;
    note?: string;
  }): Promise<WriteResult> {
    const { op, actor, options, acknowledge, note } = params;
    const gate = this.assessSignGate(acknowledge);

    /* 签章要在提交前算签名值，所以时刻得在这里就定下来（与提交内是同一个锚点）。
       不注入墙钟时这里照旧走逻辑时钟 —— 与改动前的时序完全一致。 */
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
        /* 顺序很重要：机读信息与签名一起落地（签名覆盖 MachineReadable.xml）——
           反过来的话签下的是一份与正文对不上的机读数据，"签名覆盖"就成了空话。
           机读块的 generatedAt 与 updatedAt 对齐，保证验签时重建的快照与签名时一致。  */
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
        /* 声明放行时把"未逐条确认的清单"写进留痕 —— 这是分级放行的代价记录。
           没有它，分级就退化成静默放行，那才是真正危险的做法  */
        const extra = {
          ...(op === 'review' ? { review: { decision: 'approve' as const, ...(note ? { note } : {}) } } : {}),
          ...(gate.acknowledgedUnconfirmed ? { acknowledgedUnconfirmed: gate.acknowledgedUnconfirmed } : {}),
        };
        return { targetId: this.doc.rootId, ...(Object.keys(extra).length > 0 ? { extra } : {}) };
      },
    });
  }

  /**
   * 自书自签（单人场景：门诊病历医生自己写完自己签）。
   * 有审核环节的走 `submitForReview` → `review(approve)`，那条链上的签名人是审核人。
   */
  async sign(params: { acknowledgeUnconfirmed?: boolean } = {}, actor: Actor, options: WriteOptions = {}): Promise<WriteResult> {
    this.assertHuman(actor, '签章');
    return this.performSign({ op: 'sign', actor, options, acknowledge: params.acknowledgeUnconfirmed === true });
  }

  /**
   * 提交审核（`draft → reviewing`）。
   *
   * 提交之后内容即冻结（`E_REVIEWING_IMMUTABLE`）：审核人在看 A 版的同时作者改成 B 版，
   * 审的东西和签的东西就不是一份。这是"审核"这件事成立的前提，不是附加的约束。
   */
  submitForReview(params: { note?: string } = {}, actor: Actor, options: WriteOptions = {}): WriteResult {
    this.assertHuman(actor, '提交审核');
    /* 门禁先过（"这一态允许哪些动作"只有一处判），再判本动作自己的前提 */
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

  /**
   * 审核裁决（`reviewing → signed` 通过 / `reviewing → draft` 退回）。
   *
   * 通过即签章（走 `performSign`，签名角色 `reviewer`）：
   * "审核通过"如果只是改个状态字段，文档就会变成"状态是已签章、却没有签名"，
   * 那时验签答不出、审计也说不清是谁签的 —— 状态与签名必须一起落地。
   */
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

  /** 作废（终态）：草稿或审核中的文书可以作废，理由是必填项 */
  voidDoc(params: { reason: string }, actor: Actor, options: WriteOptions = {}): WriteResult {
    this.assertHuman(actor, '作废');
    /* 先过状态门禁：已签章 / 已归档的文书要先解锁再作废，出路由门禁那条消息指；
       作废本身不另开一条"从 signed 直接作废"的通道 —— 那等于绕过一次已生效的签章。 */
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

  /** 归档（终态）：只有已签章的文书能归档 —— 归档不改内容，因此不破坏签名 */
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
    /* 终态（作废/归档）的出路由状态门禁统一回答，不在这里另说一套 */
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

  /** 撤销槽位里有什么（供界面显示"撤销：<上一次动作>"并决定按钮是否可点）；没有则返回 null */
  undoTarget(): { rev: number; op: RevisionOp } | null {
    return this.undoSlot ? { rev: this.undoSlot.rev, op: this.undoSlot.op } : null;
  }

  beginUndoGroup(): void {
    this.undoGroup = { rev: null, op: null, nodes: new Map() };
  }

  /** 结束撤销组（此后的提交恢复为"各自一个撤销单元"） */
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
          /* 提交前是 `undefined` 的，说明该节点是那次提交新建的 → 撤销即删除它  */
          if (before === undefined) delete this.doc.nodes[id];
          else this.doc.nodes[id] = structuredClone(before);
        }
        if (sidecars) this.restoreSidecars(sidecars);
        return { targetId: this.doc.rootId, extra: { revert: { revertedRev, revertedOp } } };
      },
    });
  }

  /**
   * 回到历史版本：把文档内容回到第 `rev` 条留痕**之后**的样子。
   *
   * 与 `undoLast`（撤销最近一次）是两件事：那个撤回一条，这个跨过一整段。
   * 而且**回滚本身也是一条留痕**（op=revert，载荷 `revertedTo` 记着被跨过哪些 rev）——
   * 病历里没有"悄悄回到过去"这回事：谁在什么时刻把文档退回到哪一版，必须答得出来。
   *
   * 回滚的办法是把跨过的那些留痕**反放一遍**：每条留痕都带着改前的值（`oldValue`），
   * 所以并不需要额外保存历史快照 —— 而"这条留痕能不能反放"因此成为唯一的限制：
   * 反不了就整体失败（`E_REVERT_IMPOSSIBLE`），绝不反到一半。半途回滚造出的
   * 是一份从未存在过的病历，比不回滚糟得多。
   *
   * 状态迁移类留痕（提交审核 / 裁决 / 作废 / 归档 / 签章 / 解锁）不参与回滚：
   * 它们改的是文档那一态，不是内容。要改状态有各自的动作，回滚只管内容。
   */
  revertTo(params: { rev: number }, actor: Actor, options: WriteOptions = {}): WriteResult {
    this.assertHuman(actor, '回到历史版本');
    /* 状态门禁：只有草稿能回到历史版本（已签章的要先解锁 —— 解锁本身就留了痕） */
    this.assertMutable('revert');
    const entries = this.doc.revisions;
    const toRev = params.rev;
    if (!Number.isInteger(toRev) || toRev < 1 || toRev >= entries.length) {
      throw new WriteError(
        WRITE_ERRORS.E_REVERT_TARGET,
        `回到历史版本的目标必须是已有的留痕、且不能是最新的那条（可选 rev 1~${Math.max(0, entries.length - 1)}），收到 rev=${String(toRev)}`,
      );
    }

    /** 被跨过的那些留痕：patch 要从最新往回反放（顺序反了，嵌套的父子节点会先删父再删子），
        但记进留痕的清单按 rev 升序 —— 那是给人读的（"这次回滚动了哪些"，从早到晚看才顺）。 */
    const revertedRevs = entries.slice(toRev).map((entry) => entry.rev);
    const crossed = entries.slice(toRev).reverse();
    const touched = new Set<NodeId>();
    const inverse: PatchOp[] = [];
    for (const entry of crossed) {
      /* 状态迁移类留痕没有 patch：它们改的不是内容 */
      if (!entry.patch || entry.patch.length === 0) continue;
      for (const id of patchNodeIds(entry.patch)) touched.add(id);
      /* 每条留痕内部也要逆序：正向 patch 是按路径升序排过的（父在子前），
         反放就得反过来（子在父前）。 */
      const descending = [...entry.patch].sort((left, right) => (left.path > right.path ? -1 : left.path < right.path ? 1 : 0));
      inverse.push(...descending.map(inverseOf));
    }

    /* 先在副本上试算，整条链都反得回去才真改 —— 不做"反到一半" */
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

  /**
   * 签章的三道门（纯判定，不改任何状态）。
   *
   * 提取出来，是为了让 `sign()` 能在取签名值之前先拦一遍 ——
   * 提交内的同一段判定仍然保留（它是最后一道）。两处共用这一个实现，因此不会漂移。
    */
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

  /**
   * 待签目标 = 文档快照 + 指定的机读块。
   * 刻意用浅拷贝替换机读块：`documentSignatureTargets` 还要读 docId/患者/章节等，
   * 而那些字段的改动一旦发生，摘要就会对不上（这正是提交时复算要拦的情形）。
    */
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
        /** 采样时间（是采集时间，不是报告时间）：缺了它这个值进不了趋势  */
        sampledAt?: string;
        /** 参考范围：缺了它趋势里这一点无法判定异常 */
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

    /* 先做全部校验与幂等判定，再一次性写入：
       "一半成功一半失败"会让调用方无法重试（重试会重复写入成功的那一半）  */
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
      /* 全部重复：不产生空留痕 —— 留痕是给"发生了什么"用的，
         重复到达没有改变任何东西，写一条空留痕只会污染审计  */
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
          /* 采样时间与参考范围必须一起带进来：缺了它们，这个值进不了趋势、
             也无法判定异常 —— 那这次搬运的价值就只剩"少打几个字"，
             而"少打几个字"从来不是引入这条通道的理由。  */
          if (item.sampledAt !== undefined) node.sampledAt = item.sampledAt;
          if (item.referenceRange !== undefined) node.referenceRange = structuredClone(item.referenceRange);
          /* 来源与"待核对"必须一起写：origin=system 表明"系统搬来的"，
             humanConfirmed=false 表明"还没有人核对" */
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

  /* ------------------- 机读信息与 OFD-H 导出（T16/T17） ------------------- */

  /**
   * 重算机读信息（派生数据，不得人工编辑）。
   * 时机由调用方掌握：内容变更后机读块会因 sourceHash 不匹配而"陈旧"，导出前必须重算。
    */
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

  /**
   * 独立验签（文档级）：从当前文档模型重建待签内容并验签。
   * 不依赖签名时的任何内存状态 —— 因此用它自证"签完之后文档有没有被动过"。
   * 改动任何被覆盖内容（节点、机读数据、患者/文书元数据）都会导致验签失败。
    */
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
    /* 一份文档可以被解锁多次：最近那次才是当前这次作废的原因  */
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
      /* 图片字节由调用方注入：内核不认识"图存在哪儿"（demo 在 state/resources，用例是内存夹具）。
         不注入时就导不出真图 —— 纸面会画 `[图片缺失]` 并把原因写进 warnings，
         而不是悄悄少一块。 */
      ...(options.resolveImage ? { resolveImage: options.resolveImage } : {}),
    });
  }

  /**
   * 导出 WS/T 500 共享文档 XML（区域平台/HIS 交换用）。
   * 与 `src/import/wst500-import.ts` 互为逆映射：导出 → 导入 的内容必须逐项一致。
   */
  exportWst500(options: Wst500ExportOptions = {}): Wst500ExportResult {
    return buildWst500Xml(this.doc, options);
  }

  writeWst500File(filePath: string, options: Wst500ExportOptions = {}): { filePath: string; bytes: number; stats: Wst500ExportResult['stats'] } {
    const result = this.exportWst500(options);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, result.xml, 'utf8');
    return { filePath, bytes: result.xml.length, stats: result.stats };
  }

  /** 导出并落盘（返回文件信息，便于在验收脚本与 Demo 里直接核验产物） */
  async writeOfdFile(
    filePath: string,
    plan: OfdExportPlan,
    options: Pick<OfdExportOptions, 'resolveImage'> = {},
  ): Promise<{ filePath: string; pages: number; stats: OfdPackage['stats']; warnings: string[] }> {
    const pkg = await this.exportOfd(plan, options);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, pkg.bytes);
    /* warnings 一路带回调用方：这是"归档件比病历少了一块"的唯一出口，
       吞在导出层里，现场就只知道"导出成功了"。 */
    return { filePath, pages: pkg.pages, stats: pkg.stats, warnings: pkg.warnings };
  }

  /**
   * 锚点状态求值（派生，不落存储）：
   *
   *   `valid`      节点在，且内容与提出提示时一致（或未采集文本）；
   *   `relocated`  内容已被改写，但提示针对的原文片段仍能找到 → 可重锚；
   *   `lost`       节点已删，或内容被整段改写、原文已不存在 → 需人工确认"已随内容清除"。
   *
   * 两处刻意的保守（宁可说"还在"，也不误报"丢了"）：
   *   1) 非文本节点（章节 / 表格 / 字段）不比较内容，只看节点是否存在 ——
   *      误报 `lost` 会让医生去做无谓的确认，比漏报更能消耗信任；
   *   2) 未采集 `nodeText`（例如非 text 节点）时一律判 `valid`。
    */
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

    /* 时间锚点必须在 `mutate()` 之前定下来：mutate 内部要给节点写 provenance、
       给建议本/批注落时间，它们都读同一个锚点 —— 一次提交 = 一个时刻。 */
    const at = this.resolveAt(options.at);
    this.pendingAt = at;
    this.pendingWallClock = options.at !== undefined || this.clockSource === 'wall';

    /* 快照：始终只快照受影响节点（索引同步与 patch 都依赖它）；
       full 策略额外快照整张节点表，仅用于等价性验证。 */
    const snapshots = new Map<NodeId, DocNode | undefined>();
    for (const id of targets) snapshots.set(id, this.doc.nodes[id] ? cloneDoc({ nodes: { [id]: this.doc.nodes[id] } } as unknown as DocumentModel).nodes[id] : undefined);
    const beforeAll = this.strategy === 'full' ? (structuredClone(this.doc.nodes) as Record<NodeId, DocNode>) : null;

    /* 撤销所需的信息：改前的节点表与旁挂数据必须在 `mutate()` 之前取（只有此刻是对的）。
       但新建的节点要等 `mutate()` 返回 `result.created` 才知道 —— `createNode` 的 `targets` 是空的
       （它在提交前并不存在，快照里根本没有这个 id），所以槽位在 mutate 之后才落定。
       首次实现时把这段整个放在 mutate 之前，于是"撤销一次粘贴"什么都没撤回来
       （槽位非空、节点集为空）—— 是被 `test:ui` 的 B26 抓出来的。  */
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
      /* 组内：`rev` / `op` 取首条，节点快照只收首次出现的（那才是整组的基线状态）  */
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

    /* 编辑即确认：人类的内容类操作，视为对其触及节点的"看过并负责"（见 EDIT_IMPLIES_CONFIRM）。
       位置很关键 —— 在 mutate 之后、patch 计算之前，这样确认动作本身也进 patch（可回溯）。
       跳过本次新建的节点：新建内容属于 human 来源，签名门控本来就不要求确认，
       给它加一次自动确认只会平白多一个 rev。  */
    if (actor.kind === 'human' && EDIT_IMPLIES_CONFIRM.has(op) && options.implyConfirm !== false) {
      for (const id of targets) {
        if (result.created?.includes(id)) continue;
        const node = this.doc.nodes[id];
        /* 关键内容（keyContent）不适用"编辑即确认" —— 这条限制是被用例逼出来的：
           改动一个字，不等于核对过全部。医生把诊断"急性支气管炎"的标点改一下，
           不代表他核对了诊断本身；而 keyContent 恰恰是诊断/剂量/过敏/术式这类
           错一个字就出事的字段。所以关键内容始终需要显式确认，
           不能靠"碰过一下"来推定责任。（数量本来就少，显式确认的负担可以承受。）
           另：不额外递增 rev —— 同一次提交是原子操作，rev 只递增一次（内容变更那一次）；
           重复递增会让"改了一处"看起来像"改了两版"，而 rev 是要给人做并发控制与版本判断的。
           调用方声明"这次没改内容"（`options.implyConfirm === false`，如绑定数据元标签）时整段跳过：
           推定"改过"的前提不成立。  */
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

  /** local 策略：只对受影响节点做 diff，写入复杂度与文档规模无关 */
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
        /* 被删掉的节点整块记进 `oldValue`：它既回答"删掉的是什么"，也是"撤销删除"的依据。
           注意这条分支先于 `withOldValues` 返回，必须自己带上 —— 首次实现时漏了这里，
           被"local 与 full 策略等价"用例当场抓住（没有那条用例，换个策略留痕就不一样了）。  */
        ops.push({ op: 'remove', path: `/nodes/${encodePointer(id)}`, oldValue: before as unknown as JsonValue });
        continue;
      }
      /* 除了新值，把改前的值也记进留痕（`oldValue`）：JSON Patch 的 `replace` 只带新值，
         于是"改前是什么"事后谁也答不出来 —— 而审计与纠纷举证要的恰恰是这一句。
         求值根是 `{ nodes: { <id>: before } }`：`prefixNodePaths` 产出的路径正是以 `/nodes/<id>` 开头。  */
      ops.push(
        ...withOldValues(prefixNodePaths(jsonDiff({ [id]: before }, { [id]: after } as Record<NodeId, DocNode>)), {
          nodes: { [id]: before },
        } as unknown as JsonValue),
      );
    }
    return ops;
  }

  /** 索引增量同步：由快照 + 当前状态推导，保证与 patch 描述的是同一批变更 */
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

  /**
   * 状态门禁：哪些动作在这一态下能做。
   *
   * 顺序不是随意的 —— 终态（void）先判，再看审核中，最后才是"已签章"：
   * 审核中的文档还没签章，"必须先解锁才能改"这条提示对它根本不成立，
   * 真正该说的是"审核中不能改，要改先退回"。
   */
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
    /* 归档是终态：只有解锁这一条路能开这扇门，而 `unlock` 自己还会再拒一次归档件 */
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

  /**
   * 本次提交的时刻。
   *
   * 默认走逻辑时钟（+1000ms，确定性、便于回放与 diff 比对）；
   * 若这次提交注入了墙钟（`WriteOptions.at`），所有落时间的地方都返回那个值 ——
   * 一次提交只应有一个时刻，否则留痕与内容时间会各说各话。
   */
  private tick(): string {
    if (this.pendingAt !== null) return this.pendingAt;
    this.clock += 1000;
    return new Date(this.clock).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  /**
   * 墙钟：`SessionOptions.clock === 'wall'` 且不逐笔注入 `at` 时走这里。
   *
   * `Math.max` 那一下不是多余的：文档可能带着一个"未来"的 `updatedAt`
   * （例如导入的文书、或服务器时间往前跳了一下），此时硬取 `Date.now()` 会让留痕倒流。
   */
  private nowIso(): ISODateTime {
    const now = Math.max(Date.now(), this.clock);
    this.clock = now;
    return new Date(now).toISOString();
  }

  /** 定本次提交的时间锚点：注入值要先过形状与单调两道门，逻辑时钟则照旧递增 */
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

/** 取 path 里第一段（即节点 id）：留痕里所有 patch 路径都以 `/nodes/<id>` 开头 */
function patchNodeIds(patch: readonly PatchOp[]): NodeId[] {
  const ids: NodeId[] = [];
  for (const item of patch) {
    const matched = /^\/nodes\/([^/]+)/.exec(item.path);
    if (matched) ids.push(matched[1] as NodeId);
  }
  return ids;
}

/**
 * 一条 patch 的反操作 —— 回滚与撤销都靠它。
 *
 * 成立的前提是"每条留痕都带着改前的值"（`localPatch` / `full` 策略都写 `oldValue`）；
 * 这也是为什么"不写 oldValue 的 diff"在这里等于"永久不可回滚"。
 * 反操作自己同样带 `oldValue`（等于正向的新值），于是回滚这条留痕本身也能被再回滚回去。
 */
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

/** 把 { id: node } 形式的 diff 路径加上 /nodes 前缀 */
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

/**
 * 取 JSON Pointer 指向的值。
 *
 * 用途只有一个：给留痕 patch 的 `oldValue` 求值（"改前是什么"）。
 * 路径由 `prefixNodePaths` 产出、以 `/nodes/<id>` 开头，因此求值的根是 `{ nodes: { <id>: before } }`。
 */
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
