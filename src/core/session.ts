/**
 * T05/T06/T07 · 写路径会话（WriteSession）。
 *
 * 这是编辑器内核的"唯一写入口"：所有节点变更都必须经过 commit()，从而同时满足：
 *   - T05 写接口：createNode / insertText / updateNodeProps / setFieldValue / moveNode / deleteNode
 *   - T06 patch 策略：默认 local（只快照受影响节点，复杂度与文档规模无关）；full 仅作等价性参照
 *   - T07 留痕：每次写入追加一条 RevisionEntry（rev 连续、targetId、patch、时间戳）
 *   - T02 索引同步：写入后增量维护 DocumentIndex，保证"索引 ≡ 全量重建"
 *   - T08 骨架：expectedRev 乐观锁 + clientOpId 幂等
 *   - T09/T13 最小安全门：签名后不可改、关键内容禁删、AI 不得直接写
 *
 * 三条硬约束（由 self-test 强制）：
 *   1) applyPatch(写入前文档, revision.patch) 必须精确还原"写入后文档"；
 *   2) 写入后文档必须仍然通过 validateDocument（写路径绝不产出非法文档）；
 *   3) 写入后 DocumentIndex.verifyAgainst(节点表) 必须一致（索引绝不漂移）。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { demoKeyPair, softwareSigner, type Signer } from '../crypto/provider.ts';
import { DOCUMENT_COVERS, documentSignatureTargets, signTargets, signedInfoDigestOf, verifyTargets, type SignatureBlock, type SignatureTarget, type VerifySignatureResult } from '../crypto/signature.ts';
import { hashNodes } from '../model/hash.ts';
import { controlCellByKey, matchesControlCellType } from '../model/control.ts';
import { DocumentIndex } from '../model/indexes.ts';
import { codesOf, errorsOf, validateDocument, type DocumentModel, type DocNode, type EvidenceRef, type JsonValue, type MachineReadableBlock, type NodeId, type NodeType, type PatchOp, type Provenance, type RevisionEntry, type RevisionOp, type RunProvenance, type TextRun } from '../model/index.ts';
import { buildMachineReadable, machineReadableStaleness, type StalenessReport } from '../model/machine.ts';
import { cloneDoc, toJson } from '../model/serialize.ts';
import { buildOfdPackage, type OfdExportOptions, type OfdExportPlan, type OfdPackage } from '../export/ofd.ts';
import { buildWst500Xml, type Wst500ExportOptions, type Wst500ExportResult } from '../export/wst500.ts';
import { jsonDiff } from './patch.ts';
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
   * 只有一种情况该关掉它：**这次提交一个字都没改**（例如把一段文字绑上数据元标签）。
   * 那时"改过"这个前提不成立，再推定"医生看过并负责这段内容"就是替他签了一个他没做的字
   * （实测过：不关掉它，调用方写的 `humanConfirmed:false` 会被内核改回 `true`，
   * 于是机器猜出来的标签就拿到了人工背书）。
   *
   * 方向是**保守**的：关掉它只会少一次自动确认，不会少任何校验；默认仍是 `true`。
   */
  implyConfirm?: boolean;
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

/**
 * 哪些操作意味着"医生已经看过并负责"（编辑即确认）。
 *
 * 刻意**不含** `accept-ai`：采纳只表示"我同意用这段文字"，不表示"我核对了它的正确性" ——
 * "采纳 ≠ 确认责任"是本系统的核心纪律（契约 A12/A13 依赖它）。
 * 也不含 move/delete/import/migrate/sign/reject-ai：它们不表示对内容的审阅。
 *
 * 为什么"编辑即确认"必须存在：不这样做，医生改完自己写的字还要再点一次确认 ——
 * 这是纯粹的负担，而且会让人对确认按钮麻木，**连带关键内容的确认也变敷衍**。
 * "改过"是"看过且负责"的强证据；而"改过的"与"只点过确认的"在留痕里 op 不同，
 * 事后仍能分开看，不需要额外字段。
 */
const EDIT_IMPLIES_CONFIRM: ReadonlySet<RevisionOp> = new Set<RevisionOp>(['create', 'insert', 'update']);

/**
 * **不可撤销**的 op：它们改的是文档级字段（状态 / 签名 / 机读块 / 整份导入），
 * 而"撤销槽位"只保存**节点表**的提交前快照 —— 假装能撤会把状态与内容带偏
 * （例如"撤销签章"会把内容退回、状态却仍是 signed）。
 * 遇到这类动过之后，撤销槽位**清空**，而不是留着一个撤不动的旧槽位。
 */
const NOT_UNDOABLE: ReadonlySet<RevisionOp> = new Set<RevisionOp>(['sign', 'unlock', 'migrate', 'import']);

/** 会改**旁挂数据**（建议本）的 op：撤销时要连它一起回滚，否则会出现"内容退回去了、那条建议还是已采纳" */
const TOUCHES_SUGGESTIONS: ReadonlySet<RevisionOp> = new Set<RevisionOp>(['accept-ai', 'reject-ai']);

export const WRITE_ERRORS = {
  E_ACTOR_INVALID: 'E_ACTOR_INVALID',
  E_AI_DIRECT_WRITE_FORBIDDEN: 'E_AI_DIRECT_WRITE_FORBIDDEN',
  E_REV_CONFLICT: 'E_REV_CONFLICT',
  E_SIGNED_IMMUTABLE: 'E_SIGNED_IMMUTABLE',
  E_NODE_NOT_FOUND: 'E_NODE_NOT_FOUND',
  E_PARENT_NOT_FOUND: 'E_PARENT_NOT_FOUND',
  E_TYPE_MISMATCH: 'E_TYPE_MISMATCH',
  /** 控件里没有这一格：拼错的键写进去不会报错，只会变成"医生填的值在导出里凭空不见" */
  E_CELL_UNKNOWN: 'E_CELL_UNKNOWN',
  /** 值与那一格的 `dataType` 对不上：控件的 payload 是**机器真值**（带 tag 的格会摊成数据元） */
  E_CONTROL_VALUE_INVALID: 'E_CONTROL_VALUE_INVALID',
  /**
   * 图片地址非法（空串）。
   * 空 `resRef` 在模型里的意思是"**还没贴**"（模板开出来的空槽），
   * 把它当成"清空这张图"会把"医生删掉了图"与"这里一直没贴"混成一件事 ——
   * 要清图就删节点。
   */
  E_IMAGE_REF_INVALID: 'E_IMAGE_REF_INVALID',
  E_KEY_CONTENT_PROTECTED: 'E_KEY_CONTENT_PROTECTED',
  /**
   * 必备章节禁止删除。
   *
   * 与 `E_KEY_CONTENT_PROTECTED` 是**两道不同的门**：那一道判"这一块内容敢不敢删"（责任标记），
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
  /** 目标字段已被医生动过：系统取数**不覆盖**人工内容，报冲突交人决定 */
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
  /* 旁挂注解（质控提示 / 人工批注）。注意：它们**不是文档内容**，处置**不进文档留痕** */
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
   * 与"关键内容未确认"**同档：永远阻断、不受 `acknowledgeUnconfirmed` 影响**。
   * 理由是那个声明的语义是"这些**内容**我通读并认可了"，而标签是逐条的元数据：
   * 用一句通篇声明覆盖掉它，等于把"逐条确认"稀释成"点一下就行"。
   */
  E_TAG_UNCONFIRMED: 'E_TAG_UNCONFIRMED',
  E_SIGNED_WITH_UNCONFIRMED_AI: 'E_SIGNED_WITH_UNCONFIRMED_AI',
  E_IMPORTED_UNCONFIRMED: 'E_IMPORTED_UNCONFIRMED',
  /* 机读信息与导出（T16/T17） */
  E_MACHINE_READABLE_STALE: 'E_MACHINE_READABLE_STALE',
  E_EXPORT_INVALID_PLAN: 'E_EXPORT_INVALID_PLAN',
  /** 区间替换的偏移非法（越界 / 逆序 / 非整数 / 落在代理对中间）—— 规格见 `docs/L0-节点操作API清单.md` */
  E_OFFSET_RANGE: 'E_OFFSET_RANGE',
  /* 解锁与撤销 */
  /** 解锁必须给理由：不给理由的解锁等于**静默作废一次签章** */
  E_UNLOCK_REASON_REQUIRED: 'E_UNLOCK_REASON_REQUIRED',
  /** 当前状态不允许解锁（未签章 / 已归档 —— 归档是终态） */
  E_UNLOCK_NOT_ALLOWED: 'E_UNLOCK_NOT_ALLOWED',
  /** 没有可撤销的写入（只支持撤销最近一次；签章/解锁之后不可撤销） */
  E_NOTHING_TO_UNDO: 'E_NOTHING_TO_UNDO',
  /**
   * 取签名值与提交之间病历被改动：这一次的签名值对应的是**另一份内容**，必须放弃。
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
 * ⚠️ 种子公开 ⇒ 私钥可被任何人推导（`demoKeyPair` 就是确定性派生）。
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
}

/**
 * 不允许通过 updateNodeProps 直接改的字段（结构类字段须走专用接口以触发校验）。
 *
 * `required` 在这里的理由是**它自己就是一道门**：必备章节靠 `deleteNode` 拒删来兜底，
 * 若它反过来能被一次 `updateNodeProps` 关掉，那道门就等于形同虚设
 * （先把它改成 false、再删掉那一章，留痕里看只有"改过一个布尔值"）。
 * 它是模板在开文书那一刻写下的结构声明，不是可随手改的内容属性。
 */
const STRUCTURAL_KEYS = new Set(['id', 'type', 'parentId', 'provenance', 'rev', 'required']);

/**
 * AI 落笔时写进 run 的来源片段（单条采纳与批量采纳**共用一份**）。
 *
 * 为什么必须落到 run 上、而不只是节点的 `provenance`：节点级只回答"这一段整体算谁的"。
 * 医生在一句 AI 起草的话中间插了自己的字之后，同一段里两种来源并存 ——
 * 逐句回溯（G2）与 AI 参与度标记（G3）要能分开看，否则失真的方向是
 * "把医生写的算成 AI 写的"。见 `model/types.ts` 的 `RunProvenance`
 * 与 `core/text-runs.ts` 里"provenance 不随上下文继承"那条。
 */
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

/**
 * 签章状态（`WriteSession.signatureState()` 的返回值）。
 *
 * 它回答的是"**现在这份文档上有没有有效签章**"，而不是"签名材料还在不在" ——
 * 后者在解锁之后**仍然为真**（历史不删）。这两件事必须分开表达，否则界面只有
 * "有签名材料 + 验签失败"可看，只能得出"被篡改"这一个结论。
 */
export interface SignatureState {
  /** `none`：从没签过；`valid`：当前签章有效；`voided`：签过，但已被解锁作废 */
  kind: 'none' | 'valid' | 'voided';
  /** 最近一次签章的元信息（**已被作废也保留** —— 历史不删，界面要能显示"原签章是什么"） */
  latest: { algorithm: string; provider: string; publicKeyFingerprint: string; signedAt: string; covers: string[] } | null;
  /**
   * 对**当前内容**的独立验签结论。
   *
   * ⚠️ 它**不能**用来回答"这份病历是不是已被作废/被篡改"：解锁本身不改内容，
   * 所以解锁后若内容还没动过，它仍可能 `ok:true`（而签章其实已经作废）；改了内容之后必然 `ok:false`
   * （看起来又像被篡改）。这两种情况都**不是**篡改 —— 判断只能看 `kind`（这是本字段存在的理由）。
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

  /**
   * "撤销最近一次写入"所需的**提交前快照**（只有一个槽位，见 `undoLast`）。
   *
   * 为什么不留历史：留痕里只有 `patch`（JSON Patch 的 `replace` 不带旧值），没有每 rev 的节点快照，
   * 任意 rev 回滚做不到 —— 硬做就得给每条留痕存一份节点表快照，存储随编辑量线性膨胀。
   * 代价如实写进界面：**只能逐步撤销，不能跳到某个 rev**。
   */
  private undoSlot: {
    rev: number;
    op: RevisionOp;
    nodes: Map<NodeId, DocNode | undefined>;
    sidecars?: { suggestions: SuggestionBookSnapshot; annotations: AnnotationBookSnapshot };
  } | null = null;

  /**
   * 正在收集的**撤销组**（见 `beginUndoGroup`）。
   *
   * 一次用户动作常常落在多个节点上："粘贴 3 段" = 建 3 个段落 × 2 个节点 = **6 次提交**。
   * 若撤销只对齐"内核的一次提交"，医生点一次撤销只会拿回最后一小块，
   * 而且会留下**空段落**（文本节点被撤掉、段落还在）—— 一个看不见的坏结构。
   * 所以撤销必须对齐"动作"。
   */
  private undoGroup: {
    rev: number | null;
    op: RevisionOp | null;
    nodes: Map<NodeId, DocNode | undefined>;
    sidecars?: { suggestions: SuggestionBookSnapshot; annotations: AnnotationBookSnapshot };
  } | null = null;

  /**
   * AI 建议存储（不属于文档内容，不落笔、不留痕）。
   * **非 readonly**：启动时要从持久化快照整体替换（见 `restoreSidecars`）。
   * 这是有意的让步 —— 若坚持 readonly，就只能"逐条搬进去"，
   * 那会绕开 `seq` 的恢复，导致 ID 复用（见 `SuggestionBook.snapshot` 的注释）。
   */
  private book = new SuggestionBook();

  /**
   * 旁挂注解存储（质控提示 / 人工批注）。
   *
   * 与建议存储同属"不是文档内容"，但**留存策略相反**：建议被采纳/拒绝后从活跃集消失，
   * 注解**永不消失**、处置史留全（"提示过什么、谁怎么处理"就是可追溯的证据链）。
   * 详见 `src/core/annotations.ts` 文件头。
   */
  private annotations = new AnnotationBook();

  /**
   * 签名后端。
   *
   * 默认是自研软件实现 + 演示密钥（自测与可复现验收需要它）；**产品侧必须注入真实后端**：
   * `SessionOptions.signer`，或用 `setSigner()` 换成配置里的医院签名服务。
   */
  private signer: Signer;

  private clock: number;

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
  }

  /** 打开会话：先校验文档合法，再建索引（非法文档不得进入写路径） */
  static open(doc: DocumentModel, options: SessionOptions = {}): WriteSession {
    const issues = errorsOf(validateDocument(cloneDoc(doc)));
    if (issues.length > 0) {
      throw new Error(`文档不合法，无法打开写会话：${codesOf(issues).join(', ')}`);
    }
    return new WriteSession(cloneDoc(doc), options);
  }

  /**
   * 打开**从库里/盘上装载**的文书：与 `open` 同一道校验，**豁免一条** ——
   * 「机读信息陈旧」（`E_MACHINE_READABLE_STALE`）不算文档不合法。
   *
   * 为什么这一条要豁免：它描述的是**派生结果比内容旧**，而"内容改过、还没重算"是写路径
   * **正常可达**的中间态 —— 每一次写入之后、点「重算机读信息」之前，文档就是这个样子。
   * 把它当成"文档不合法"，后果不是"拦住一次坏写入"，而是**整台服务起不来**：
   * 装载走 `open` → 抛错 → 进程退出（实测：`doc_001_opd` 的 sourceHash 与内容指纹不一致，
   * demo 服务直接退出，而那份文书本来只差一次重算）。
   *
   * 豁免不会放松真正的门：机读信息新鲜度由**导出**那一侧把守 ——
   * `exportOfd` 用 `machineReadableStatus()` 判（与校验器无关），陈旧的照样导不出去；
   * 装载后 `machineReadableStatus().stale` 仍为真，界面照旧显示"机读信息变旧"。
   *
   * 其余错误一律照旧拒绝：结构缺陷、留痕断裂、`schemaVersion` 未登记、已签章却带未确认内容
   * ……那些是真缺陷，放行等于把"数据坏了"说成"看起来没事"。
   */
  static openPersisted(doc: DocumentModel, options: SessionOptions = {}): WriteSession {
    const blocking = errorsOf(validateDocument(cloneDoc(doc))).filter(
      (issue) => issue.code !== WRITE_ERRORS.E_MACHINE_READABLE_STALE,
    );
    if (blocking.length > 0) {
      throw new Error(`文档不合法，无法打开写会话：${codesOf(blocking).join(', ')}`);
    }
    return new WriteSession(cloneDoc(doc), options);
  }

  /**
   * 运行时更换签名后端。
   *
   * 为什么需要它：签名后端是**部署参数**，管理员改完配置应当**立即生效**，而不是要重启进程
   * （"改了要重启才生效"是运维最容易踩空的坑，现场表现是"我明明配了却没生效"）。
   *
   * 它**同时影响文档签章与 OFD 容器签名**（两者用的是同一个 `this.signer`）—— 这正是要的：
   * 两处若各签各的，会出现"文档签了、容器没签"或两套互不相认的签名（比不对接更糟）。
   *
   * 调用方应传**已配置好**的后端；未配置时应当**在调用前就拒绝签章**，
   * 而不是把一个"能签但签错身份"的东西注进来（见 `src/sign/sign-config.ts` 的 fail-closed 纪律）。
   */
  setSigner(signer: Signer): void {
    this.signer = signer;
  }

  /* ------------------------------ 读取 ------------------------------ */

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

  /* ------------------------------ 写接口 ------------------------------ */

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

  /**
   * **区间替换**：把文本节点内 `[start, end)` 的字符替换为给定内容（规格见 `docs/L0-节点操作API清单.md`）。
   *
   * 语义与边界条件的完整说明在 `src/core/text-runs.ts`（纯函数内核），这里只说三件与"会话"有关的事：
   *   1) 它是 `op: 'update'`，因此在**"编辑即确认"**白名单里 —— 医生改过的非关键内容自动视为看过，
   *      关键内容仍必须显式确认（理由见 `EDIT_IMPLIES_CONFIRM`）；
   *   2) 区间非法（越界 / 逆序 / 落在代理对中间）抛 `E_OFFSET_RANGE`，**不夹带任何修改**：
   *      校验在 `mutate` 内、赋值之前完成，所以拒绝就是拒绝，不会留下半成品；
   *   3) 它替换的是**节点内的字符区间**，不改变节点结构：拆段 / 合并段是结构操作，
   *      由 `createNode` / `moveNode` / `deleteNode` 组合完成（见 demo 的段落级操作）。
   */
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

  /**
   * 控件里某一格的写入。
   *
   * 与 `setFieldValue` 是同一族：都走 `commit()`（留痕、rev、乐观锁、索引同步一样不少），
   * 差别只在"哪一格"怎么定位 —— 控件的 payload 是一张扁平表，键由**形状**算出来
   * （`model/control.ts` 的 `controlCellByKey`）。
   *
   * 三条必须在这里守住，它们都属于"错了不报错、只是数据悄悄不对"：
   *   ① **格必须存在**：拼错的键写进去，导出时那一格凭空不见；
   *   ② **值要与那一格的 `dataType` 相符**：payload 是机器真值（带 tag 的格会摊成数据元），
   *      `"37.2"` 与 `37.2` 在展示上一样、在机器读的时候不是一回事；
   *   ③ **清空 = 删掉这个键**（不是写 null）："空着"与"我确认这里是空的"是两件事。
   *
   * 空值的判定按"空字符串"：界面把所有输入按文本送上来（与 `setFieldValue` 的 `valueText` 同源），
   * 让界面自己判断"这个空该不该转成 null"只会多出一处口径。
   */
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

  /**
   * 给图片节点**贴上 / 换掉**地址。
   *
   * 为什么不复用"插入一张图"：模板开出来的图片槽**节点已经在了**，只是 `resRef` 为空。
   * 再插一张会变成"空槽 + 一张图"两张并排，而人只点了一次贴图。
   *
   * 三条纪律与 `setControlValue` 同族：
   *   ① 目标必须是图片节点；
   *   ② 地址必须非空 —— **清图是删节点**，不是把地址写成空：
   *      空 `resRef` 在模型里的意思是"还没贴"，两种意思混在一起，
   *      事后分不清"这一格一直空着"还是"有人把图删了"；
   *   ③ 走 `commit()`：留痕、rev、乐观锁、机读失效一样不少。
   *
   * `altText` 只**补空**、不覆盖：空槽上的那行说明通常是模板给的（"胸部 CT 正位"），
   * 换一张图不该把"这一格是什么"一起改掉。
   */
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
        /* 关键内容禁删必须查**整棵被删子树**，不能只看目标节点。
           删一个段落（subtree）会连带删掉它下面的文本节点，而"关键内容"标记恰恰落在文本/字段节点上 ——
           只看目标就等于给"删父节点"留了一道绕过禁删的后门。
           （加段落级删除入口时实测发现：paragraph 本身不标 keyContent，它下面的 text 才标。） */
        const protectedVictims = victims.filter((id) => this.doc.nodes[id]?.keyContent === true);
        if (protectedVictims.length > 0) {
          throw new WriteError(
            WRITE_ERRORS.E_KEY_CONTENT_PROTECTED,
            `关键内容节点禁止删除：${protectedVictims.join(', ')}`,
          );
        }
        /* 必备章节禁删（`SectionNode.required`）。同样要查**整棵被删子树**：
           删一个上层节点（段落 / 外层章节）不得把必备章节连带删掉 ——
           否则"必备"就只挡得住直接点那一章的删除按钮。
           报的是**章节标题**而不是节点 id：医生要能看懂是哪一章。 */
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
   * 提交 AI 建议。**不落笔、不留痕、不改 rev**：门控在"落笔"而非"生成"，
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
      /** 外部调用关联（模型一次调用可能产出多条）：透传供追溯；**不构成分组**（分组走 suggestBatch） */
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
    /* `reused` 必须**如实往上传**（幂等规则见 `SuggestionBook.add`）：没有它，
       界面就只能表现成"点了没反应"，而医生会以为系统坏了 —— 这比重复更糟。 */
    return { ok: true, suggestionId: suggestion.id, reused: created === false };
  }

  /**
   * 采纳建议：仅自然人；置信度低于阈值不得落笔；落笔后仍需人工确认（采纳 ≠ 确认责任）。
   *
   * `aiRanges` 可选：逐句采纳时由调用方给出"最终文本里哪几段是 AI 写的"（见 `text-runs.ts`）。
   * 不给 = 沿用旧口径（整段标 AI）。给了就按区间分 —— 医生保留的原句**不标 AI**，
   * 于是"这一句谁写的"在留痕里是可查的，而不是靠事后猜。
   * 区间校验在内核做（越界/重叠/空区间/劈开生僻字一律报 `E_OFFSET_RANGE`），
   * 服务端只负责原样转发：这个参数决定的是**来源标记**，不能由客户端说了算而不校验。
   */
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
        /* 记**改动幅度**而不是"改没改"：口径在 `editRatioOf` 一处，
           界面上的三级归因与它读的是同一个值（见 `SuggestionAttribution`） */
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

  /**
   * 批量提交 AI 建议：一次调用产出**一组**（语音转写、整篇草稿、批量取数都走这里）。
   *
   * 三条规则，都是为了让"批量"不成为门控的旁路：
   *   1) **先全批校验，再写入**：任何一条不合法（节点不存在 / 非文本节点 / confidence 越界 /
   *      缺 modelId）就整批拒绝，不留下"半批建议"——半批会让医生以为模型只产出了这些；
   *   2) 组 ID 由存储层生成，**调用方不能指定**（否则两批不相干的建议会被并成一组，
   *      界面上的"接受本组"会一次落笔两批无关内容）；
   *   3) 批量只改**提交粒度**，不改门控：每条仍各自按关键/一般内容判阈值（见 `acceptSuggestions`）。
   */
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
    /* `groupId` 可能为空：整批都与**仍待处理**的旧建议同文本时，**不建组**
       （组是有条数的操作单元，空组会让界面的"接受本组"落在一个不存在的范围上）。
       此时 `reused` 里是那些旧建议的 id —— 界面必须如实说明"这些已在待处理里"，而不是报"新增 0 条"。 */
    const { groupId, suggestionIds, reused } = this.book.addBatch(prepared, this.tick(), params.traceId);
    return { ok: true, groupId, suggestionIds, reused };
  }

  /**
   * 接收一次**语音转写**，生成一组建议（**不落笔**）。
   *
   * 这是语音接入内核的唯一入口，形态是"转写流 → 一组建议"：
   *   - **不做自动落位**（`targetNodeId` 由医生指定）—— 理由见 `dictation.ts` 文件头：
   *     错误落位比不落位更危险；
   *   - 转写段先规范化（丢空段、重排乱序），被丢弃/重排的数量**如实回报**；
   *   - **复用 `suggestBatch`**：于是它天然继承批量建议的全部约束 ——
   *     逐条门控、组不存状态、组级操作不绕过阈值。
   *     语音**没有**任何特权通道，这是有意的。
   */
  dictate(
    params: {
      transcriptionId: string;
      asrModelId: string;
      refineModelId?: string;
      segments: TranscriptSegment[];
      /** 所有段落到**同一个**节点（适合单段转写）；与 `targetNodeIds` 二选一 */
      targetNodeId?: NodeId;
      /**
       * 逐段指定目标节点（与**有效段**一一对应）。
       *
       * 为什么必须有它：同一节点上的多条建议，逐条采纳会**互相覆盖**（采纳是替换，不是追加）——
       * 三段转写落一个节点，最后只剩一段，前两段白采纳了。所以多段场景必须分开落点。
       * **落位决策仍在内核之外**（医生指定，或由外部落位工具给出），内核不猜 —— 理由见 `dictation.ts`。
       */
      targetNodeIds?: NodeId[];
      /** 听写置信度上限（默认 0.85，低于关键内容阈值 0.90 —— 见 `dictation.ts`） */
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

  /**
   * 批量/组级采纳建议。**部分成功**语义，不是全或无。
   *
   * 为什么不是全或无：一批 20 条里可能有一条落在关键内容节点上（阈值更高）而不够门槛，
   * "整批失败"会让医生以为全部没落笔而反复重试；正确行为是够门槛的落笔、
   * 不够的**如实报告并保持待处理**。
   *
   * 三条不能省：
   *   1) **逐条过门控**：组是操作便利，不是权限升级 —— 绝不整组放行，
   *      也不改变"AI 内容仍需人工确认"（落笔后 `humanConfirmed` 仍为 false）；
   *   2) 被拦的条目**保持 `pending`，不置为 `rejected`**：医生并没有拒绝它。
   *      把它算成拒绝会直接污染拒绝率 ——"置信度不足"与"医生不认可"是两件事；
   *   3) 一条都没落笔时**不提交、不留痕、不改 rev**：没有落笔就没有留痕，
   *      否则"点了一次全被拦"会在审计日志里留下一串无内容的记录。
   */
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
          /* 批量与单条走**同一个**改动幅度算法：两处各写一遍的后果是
             "同一份数据在两张报表上不一样"，而报表正是拿来比版本好坏的 */
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
   * 解析批量操作范围：`groupId` 与 `suggestionIds` **二选一**。
   *
   * 同时给出会被拒（而不是取并集）：并集无法解释"我到底操作了什么"，而留痕必须能说明范围。
   * 都不给同样被拒（空范围不能静默成功）。
   *
   * 两种范围的语义**有意不同**：
   *   - 显式给 `suggestionIds`：任何一个不存在或非 pending 都**报错** —— 那是调用方的错误；
   *   - 按 `groupId` 过滤：已处理的条目**跳过**即可 —— 组内某条被别人先处理是正常时序，
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

  /** 组的派生视图（界面"接受本组"用；组不存状态，见 `SuggestionGroup`） */
  listSuggestionGroups(): SuggestionGroup[] {
    return this.book.listGroups();
  }

  /**
   * 导出**旁挂数据**（建议 + 注解）的快照，供持久化。
   *
   * 只导出旁挂数据，不含文档内容：文档有自己的导出链路（JSON / OFD / WS/T 500），
   * 而且它是**内容**、要进签名；旁挂数据是**过程**、不进签名。两者的存储与生命周期不该混在一起。
   */
  sidecarSnapshot(): { suggestions: SuggestionBookSnapshot; annotations: AnnotationBookSnapshot } {
    return { suggestions: this.book.snapshot(), annotations: this.annotations.snapshot() };
  }

  /**
   * 启动时用快照替换旁挂数据。
   *
   * ⚠️ **只在会话刚打开、尚未产生任何建议/注解时允许** —— 否则会用磁盘上的旧状态
   * 覆盖掉本次会话已经发生的操作（那是数据丢失，而且丢的是"刚刚做的"）。
   * 宁可显式报错，也不做"合并"：合并两批建议的语义（谁是新的、冲突怎么算）没有定义，
   * 而**未定义的合并比拒绝更危险**。
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

  /**
   * 提出一条旁挂注解。**不落笔、不改 rev、不进文档留痕**（见 `annotations.ts` 文件头）。
   *
   * 三条约束：
   *   1) `source.kind` 必须与 `actor.kind` 一致 —— "谁提出来的"必须真实可查。
   *      AI 以 human 身份提注解，等于给质控提示伪造了责任主体；
   *   2) AI / 规则来源**必须给依据**（`evidence` 或 `source.ruleId`）：无依据的提示
   *      医生只能选择信或不信，那是在消耗信任，不是在质控；
   *   3) 锚点必须指向**当前存在的节点**：挂不上锚的提示无法定位，等于无法处理。
   *      锚点失效是之后的事，由 `listAnnotations` 的派生状态暴露（不是现在）。
   */
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
    /* 锚点文本由内核采集，**不采信调用方给的**（否则可以伪造"当时写的是这句"，
       使锚点失效判定失去意义）。`actorId` 同理：一律取当前操作者。 */
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

  /**
   * 处置注解：`acknowledged`（已知悉暂不改）/ `dismissed`（误报）/ `resolved`（已按提示处理）。
   *
   * **仅自然人可处置**：AI 不得处置自己提出的提示（与"AI 不得采纳自己建议"同一条纪律）。
   *
   * **这里没有 commit**：处置不是文档变更 —— 不动 nodes、不动 `docRev`、不写 `revisions`。
   * 处置史留在注解自己的 `history` 里（理由见 `annotations.ts` 文件头规则 2：
   * 若混进 `revisions`，"rev 变化 ⇒ 文档变了"这个被机读陈旧判定依赖的前提就失效了）。
   */
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

  /**
   * 人工确认"锚点已随内容清除"。
   *
   * 为什么必须存在这个动作：节点被删掉后，注解**不能静默消失**（那是丢失质控痕迹），
   * 也**不能一直挂在不存在的文字上**（那是界面上的幽灵条目）。
   * 只能由人确认一次，把这条路径闭环。
   *
   * 只在锚点确实已失效时允许 —— 否则这个动作会变成"随手清掉碍事的提示"的捷径。
   */
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

  /**
   * 列出注解。每条都带**派生的锚点状态**（`valid` / `relocated` / `lost`）。
   *
   * 为什么锚点状态是派生的、不存进存储：节点被删改是**外部事件**，
   * 存储里的快照不可能知道；只有查询时对当前文档求值才准。
   * 与"组不存状态"同一理由 —— 多一处需要同步的真相，就必然漏同步。
   */
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
   * **不含锚点派生状态**：那取决于当前文档内容，不属于注解自身 ——
   * 若纳入，同一个注解集合在"文档被编辑过"与"没被编辑过"的两个实现上
   * 会被判成不一致，比对就失去了意义。
   */
  annotationFingerprint(): string {
    return this.annotations.fingerprint();
  }

  /** 注解统计（`anchorLost` 是**必须处理**的一项：不能让它静默累积） */
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
       * 只计**还需要人处理的**锚点丢失。
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
   * **三级归因**：采纳拆成 原样 / 微改 / 大改（外加"未归因"）。
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
        /* 确认"这一段我看过了"= **连带认可它上面机器绑的标签**（标签就挂在这段内容上）。
           不在这里清掉，医生就会卡在"确认了内容、门控还是拦"的死结里，而界面上没有任何按钮能解开。 */
        delete node.unconfirmedTags;
        node.rev += 1;
        return { targetId: nodeId };
      },
    });
  }

  /**
   * 批量确认：一次确认一批内容节点。
   *
   * 为什么必须有：`humanConfirmed` 是节点级的，导入一份文档要确认几十上百次 ——
   * 在真实诊室里，这种设计会退化成"不看就全点一遍"，**门控形式还在、实质已失效**。
   * 批量确认把操作次数降下来，同时把范围写进留痕（`confirmedNodeIds`），
   * 让"他当时确认了哪些"仍然逐条可查。
   *
   * 注意：这不是削弱门控。落笔权、关键内容确认、AI 不得自采全都不变，
   * 变的只是**确认动作的粒度**；粒度变粗的代价，由留痕的可解释性来补偿。
   */
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
          /* 已经确认过的节点**不再递增 rev**：嵌套章节会让同一节点落在两个子树里
             （实测：9 个内容节点的门诊病历，按章节确认时被确认 10 次），
             重复确认不该把版本号推高 —— rev 是给人做并发控制与版本判断的。 */
          /* 有待确认的机器标签时，**即使内容早就确认过**也要走一次：
             清标签本身就是一次真实写入，跳过它就会出现"确认过了、门控还是拦"的死结 */
          if (target.humanConfirmed !== true || (target.unconfirmedTags?.length ?? 0) > 0) {
            target.humanConfirmed = true;
            delete target.unconfirmedTags;
            target.rev += 1;
          }
        }
        /* 留痕记录的是**请求范围**（而不是"本次新确认的几个"）：
           审计要回答的是"他当时确认了哪些内容"，范围本身比增量更有意义 */
        return { targetId: nodeIds[0] as NodeId, extra: { confirmedNodeIds: nodeIds } };
      },
    });
  }

  /**
   * 按子树确认（界面的"本段确认 / 本屏确认"用它）：范围由结构决定，不用手写节点清单。
   *
   * 只收**承载内容**的节点（text/field）：document/section/paragraph 是结构，
   * 让医生"确认一个章节标题"没有意义，界面也不会给这种按钮；
   * 若把结构也算进来，导入件将永远无法确认完（死路 —— 这一条在签名门控里已经踩过）。
   *
   * **唯一的例外：自己标了 `keyContent` 的章节**（章节级关键内容，见 `template/types.ts`）。
   * 那种章节本身就在签名门控 ① 的范围内（`assessSignGate` 逐节点判 `keyContent`），
   * 而"确认本章"这个动作恰恰就是"这一章整章我看过了" —— 不把它算进来，
   * 标了章节级关键内容的文书会**永远签不出去**（正是上面那条被踩过的死路）。
   * 例外只开给"自己标了关键内容"的结构节点，不是给所有结构节点开门：
   * 普通章节、段落仍然不进确认范围，导入件"永远确认不完"那条老路照样封着。
   */
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
   * 签章：仅自然人。三道门按**风险分级**，而不是一律拦路：
   *   ① 关键内容（`keyContent`）未确认 → **始终阻断**，不受声明影响（这是"关键"二字的定义）；
   *   ② 存在未确认的 **AI 内容**：默认阻断；医生显式声明"已通读"（`acknowledgeUnconfirmed`）后放行，清单进留痕；
   *   ③ 存在未确认的**导入内容**：同上。
   *
   * 为什么改成分级：一律阻断会让"逐条确认"在诊室里退化成"不看就全点"——门控看似在、其实没了；
   * 一律放行则丢掉责任链。分级 + 留痕是两者之间的可行解：**操作次数降下来，责任记录一个不少。**
   * 放行不等于豁免 —— 签名有效，但记录里明写了"哪些内容没有逐条确认过"。
   *
   * 签名覆盖范围必须包含机读文件（MachineReadable.xml），否则机读数据可被改而不破坏签名。
   *
   * ## 为什么是 async，以及提交前为什么"再算一遍"
   *
   * 签名后端可能是**网络服务或密码设备**（`Signer.sign` 允许返回 Promise），
   * 于是【校验 → 取签名值 → 提交】必须分成三步，前两步都在进入同步提交路径**之前**完成。
   *
   * 由此产生一个并发窗口：await 期间文档可能被别的请求改动 —— 那样签下的就是**另一份内容**。
   * 所以提交时**重新计算待签摘要并比对**（`signedInfoDigestOf`），不一致就拒绝：
   * 宁可让人重试一次，也不能签一份正在变的病历。
   */
  async sign(params: { acknowledgeUnconfirmed?: boolean } = {}, actor: Actor, options: WriteOptions = {}): Promise<WriteResult> {
    this.assertHuman(actor, '签章');
    const acknowledge = params.acknowledgeUnconfirmed === true;

    /* ① 先把三道门查完：**先拦后签** —— 被拒时一次签名调用都不会发生
       （对密码设备而言，那可能是一次计费或一次用印记录，不能白签） */
    const gate = this.assessSignGate(acknowledge);

    /* ② 备好待签内容（纯计算，**不写文档**）：时间戳、机读块、摘要清单 */
    const at = this.tick();
    const machineReadable = this.machineReadableAt(at);
    const signatureRef = `sig_${this.doc.docId}_${this.doc.revisions.length + 1}`;
    const meta = { signatureRef, documentId: this.doc.docId, signerRole: 'author' as const, signerId: actor.id, signedAt: at };

    /* ③ 取签名值（可能是一次网络调用或一次密码设备调用） */
    const signature = await signTargets(this.signatureTargetsWith(machineReadable), meta, this.signer);

    /* ④ 同步提交；提交时**复算摘要**，确保签的就是此刻这份内容 */
    return this.commit({
      op: 'sign',
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
        /* 顺序很重要：**机读信息与签名一起落地**（签名覆盖 MachineReadable.xml）——
           反过来的话签下的是一份与正文对不上的机读数据，"签名覆盖"就成了空话。
           机读块的 generatedAt 与 updatedAt 对齐，保证验签时重建的快照与签名时一致。 */
        this.doc.machineReadable = machineReadable;
        this.doc.status = 'signed';
        this.doc.signatureRefs = [
          {
            signatureRef,
            signerRole: 'author',
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
        /* 声明放行时把"未逐条确认的清单"写进留痕 —— 这是分级放行的**代价记录**。
           没有它，分级就退化成静默放行，那才是真正危险的做法 */
        return {
          targetId: this.doc.rootId,
          ...(gate.acknowledgedUnconfirmed ? { extra: { acknowledgedUnconfirmed: gate.acknowledgedUnconfirmed } } : {}),
        };
      },
    });
  }

  /**
   * **解锁已签章文档**：把 `status` 从 `signed` 退回 `draft`，使内容可以继续修改。
   *
   * ## 为什么必须是"一次显式的解锁动作"，而不是"允许改已签章文档"
   *
   * 已签章不可改是**签名有效性的前提**：能静默改的话，"签的到底是什么"就答不上来。
   * 但病历几乎必然要改（入院记录写完要补、笔误要纠），所以缺的不是"允许改"，
   * 而是**一次留痕的解锁** —— 谁、何时、为什么，必须进变更记录。
   *
   * ## 三条纪律
   *
   * 1) 只有 `signed` 可解锁。`archived`（归档封存）**不可解锁**：归档是终态，要改就重开一份。
   *    未签章的自然也不需要解锁（拒绝，而不是静默成功）。
   * 2) **理由必填**：解锁是敏感动作，"因为要改一下"和"纠正诊断笔误"在事后追责里完全不是一回事。
   * 3) **不删历史、也不假装没签过**：`signatureRefs` 原样保留；解锁留痕里记下**被作废的那次签章**
   *    （指纹 + 签章时间）。于是"解锁后又改了内容、验签失败"时，界面能回答"为什么失败" ——
   *    不是被篡改，是被一次有理由、有责任人的解锁作废了。
   *
   * 解锁**只改状态、不改内容**，所以它自己是一条留痕（`op: 'unlock'`）；真正的内容修改要再提交一次，
   * 各留各的痕 —— 这样"解锁"与"改了什么"在审计里不会糊成一条。
   */
  unlock(params: { reason: string }, actor: Actor, options: WriteOptions = {}): WriteResult {
    this.assertHuman(actor, '解锁已签章文档');
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

  /**
   * 开始一个**撤销组**：随后的提交都并入同一个撤销单元，直到 `endUndoGroup()`。
   *
   * 用途与理由见 `undoGroup` 的注释 —— 撤销的对象应当是"用户的一次动作"。
   * 组内的节点快照只取**首次出现**的那份（那才是整组的基线状态），`rev` 取组内第一条，
   * 于是撤销这个组 = 精确恢复"这个动作开始之前"。
   *
   * ⚠️ 必须成对使用（`try/finally`）：组一直开着，会把后续无关的提交也吞进同一次撤销里。
   */
  beginUndoGroup(): void {
    this.undoGroup = { rev: null, op: null, nodes: new Map() };
  }

  /** 结束撤销组（此后的提交恢复为"各自一个撤销单元"） */
  endUndoGroup(): void {
    this.undoGroup = null;
  }

  /**
   * **撤销最近一次写入**。
   *
   * ## 为什么是"最近一次"而不是规格里的 `revertTo(rev)`
   *
   * `revertTo(rev)` 要求能反向重放任意一条留痕。但留痕只存 `patch`，而 JSON Patch 的 `replace`
   * 只带新值（现在补了 `oldValue`，反向重放**在理论上**可行，但要把"从当前状态一路反推到 rev"
   * 的所有 rev 的 patch 收集齐并保证中间没有不可逆的文档级变更 —— 那是一条独立的、需要专门设计的路径）。
   * 本轮做成**逐次撤销**：
   *   · 每次可撤销的提交都把**受影响节点的提交前快照**记进内存（一个槽位）；
   *   · 撤销即按该快照精确恢复，并**以新 rev 记录**（`op: 'revert'`，`revert.revertedRev` 指回被撤销那条）；
   *   · 撤销本身也是一次提交，于是"连点撤销"能一步步退回去，**不会一次退过头**。
   * 诚实边界：**只能逐步退，不能跳到某个 rev**；签章/解锁之后撤销槽位清空。
   *
   * ## 三条边界
   *
   * 1) 只撤**节点级**写入（见 `NOT_UNDOABLE`）；旁挂数据（建议本）随撤销一起回滚，
   *    否则会出现"内容退回去了、那条 AI 建议却还是已采纳"；
   * 2) **不篡改历史**：被撤销的那条留痕仍在，撤销动作本身也留痕，两者靠 `revertedRev` 关联；
   * 3) 撤销**必须是人**的动作（AI 不得借撤销绕过"AI 只能出建议"）。
   */
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
          /* 提交前是 `undefined` 的，说明该节点是那次提交**新建**的 → 撤销即删除它 */
          if (before === undefined) delete this.doc.nodes[id];
          else this.doc.nodes[id] = structuredClone(before);
        }
        if (sidecars) this.restoreSidecars(sidecars);
        return { targetId: this.doc.rootId, extra: { revert: { revertedRev, revertedOp } } };
      },
    });
  }

  /**
   * 签章的三道门（**纯判定，不改任何状态**）。
   *
   * 提取出来，是为了让 `sign()` 能在**取签名值之前**先拦一遍 ——
   * 提交内的同一段判定仍然保留（它是最后一道）。两处共用这一个实现，因此不会漂移。
   */
  private assessSignGate(acknowledge: boolean): { acknowledgedUnconfirmed: { ai: string[]; imported: string[] } | null } {
    /* ① 关键内容：**不受 acknowledge 影响**，永远阻断 */
    const keyUnconfirmed = Object.values(this.doc.nodes).filter((node) => node.keyContent === true && node.humanConfirmed !== true);
    if (keyUnconfirmed.length > 0) {
      throw new WriteError(
        WRITE_ERRORS.E_KEY_CONTENT_UNCONFIRMED,
        `存在关键内容未人工确认（${keyUnconfirmed.length} 条）：${keyUnconfirmed.map((node) => node.id).join(', ')}`,
      );
    }
    /* ①-2 机器绑的标签：**同属第一档**（不受 acknowledge 影响）。
       为什么不能跟 ②③ 一样"声明就可放行"：那个声明说的是"这些内容我通读并认可了"，
       而标签是**逐条的元数据**（"这一段算什么数据元"）—— 用一句通篇声明覆盖它，
       逐条确认就退化成"点一下就行"。何况它的数量本来就少（只存在于采纳过机器提议的地方），
       确认动作也现成：确认那一段内容 = 连带认可它上面的标签。 */
    const tagUnconfirmed = Object.values(this.doc.nodes).filter((node) => (node.unconfirmedTags?.length ?? 0) > 0);
    if (tagUnconfirmed.length > 0) {
      throw new WriteError(
        WRITE_ERRORS.E_TAG_UNCONFIRMED,
        `存在机器绑定、尚未人工确认的数据元标签（${tagUnconfirmed.length} 条）：${tagUnconfirmed.map((node) => node.id).join(', ')}；` +
          '标签会进机读信息被下游系统直接消费，请逐段确认（确认这一段内容即认可它的标签，不接受则先撤销那一次绑定）',
      );
    }
    /* ②③ AI 与导入内容：默认阻断；显式声明后放行，但清单进留痕 */
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

  /** 指定时间戳下的机读块（纯函数）：待签内容要在**签名之前**就定型 */
  private machineReadableAt(at: string): MachineReadableBlock {
    return buildMachineReadable({ nodes: this.doc.nodes, rootId: this.doc.rootId, schemaVersion: this.doc.schemaVersion, generatedAt: at });
  }

  /**
   * 待签目标 = 文档快照 + 指定的机读块。
   * 刻意用**浅拷贝**替换机读块：`documentSignatureTargets` 还要读 docId/患者/章节等，
   * 而那些字段的改动一旦发生，摘要就会对不上（这正是提交时复算要拦的情形）。
   */
  private signatureTargetsWith(machineReadable: MachineReadableBlock): SignatureTarget[] {
    return documentSignatureTargets({ ...this.doc, machineReadable }, hashNodes(this.doc.nodes));
  }

  /**
   * 系统取数（外部数据搬运）：把 LIS/HIS 的**确定性数值**直接写入字段节点。
   *
   * 为什么它可以"直接落笔"而 AI 不行：这是**搬运**不是**生成** ——
   * 值来自 LIS，权威性高于手抄，医生重抄只会更差；而门控防的是"编造"，不是"搬运"。
   *
   * 但它同样有四条硬约束（缺一不可）：
   *   ① 只能由 `system` 身份发起：AI 走建议通道（会编，必须人采纳），
   *      人类走 `setFieldValue`（那是他的判断，不是"系统取数"）；
   *   ② **必须带强引用 evidence**：没有 `ref` 的数据回溯不到报告，比不引入更糟；
   *   ③ **幂等**：同一份报告同一字段重复到达、且值相同 → 跳过，不产生留痕；
   *   ④ **不覆盖人工内容**：医生写过或已确认的字段一律拒绝并报冲突 ——
   *      系统悄悄覆盖医生写的东西，是最不能接受的一类事故。
   *
   * 落笔后 `humanConfirmed = false`：**搬运不等于核对**，仍待医生确认；
   * 关键内容更是如此，签名门控照旧会拦。
   */
  applyExternalData(
    params: {
      items: Array<{
        nodeId: NodeId;
        value: JsonValue;
        valueText?: string;
        unit?: string;
        evidence: EvidenceRef[];
        /** 采样时间（**是采集时间，不是报告时间**）：缺了它这个值进不了趋势 */
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

    /* 先做**全部**校验与幂等判定，再一次性写入：
       "一半成功一半失败"会让调用方无法重试（重试会重复写入成功的那一半） */
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
      /* 全部重复：**不产生空留痕** —— 留痕是给"发生了什么"用的，
         重复到达没有改变任何东西，写一条空留痕只会污染审计 */
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
          /* 采样时间与参考范围必须一起带进来：缺了它们，这个值**进不了趋势**、
             也无法判定异常 —— 那这次搬运的价值就只剩"少打几个字"，
             而"少打几个字"从来不是引入这条通道的理由。 */
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
   * 重算机读信息（**派生数据**，不得人工编辑）。
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
   * 独立验签（文档级）：从**当前文档模型**重建待签内容并验签。
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

  /**
   * 签章状态：现在有没有有效签章；上一次签章是不是**被解锁作废**的（而不是被篡改）。
   *
   * ## 为什么这件事必须由内核回答
   *
   * 解锁之后，文档表现为 `status='draft'` 而 `signatureRefs` **非空**（历史不删）。
   * 此时若只看 `verifySignature()`，会得到**两个都错**的结论：
   *   · 内容还没改过 → 它仍回 `ok:true`，于是界面看着像"签章还在"，而它其实**已经作废**；
   *   · 内容改过了 → 它回 `ok:false`，于是界面看着像"被篡改"，而它其实是一次**有理由、有责任人**的作废。
   * 两者的处置与"被篡改"完全不同（后者要找信息科，前者只需说明"谁、为什么解锁了"），
   * 却都无法从验签结论里读出来 —— 这就是本方法存在的理由。
   *
   * 所以判定收在内核这一处（界面、审计报告、契约服务端**共用同一口径**），
   * 并把解锁理由与**被作废的那次签章**一并带出来 —— 答案早就在留痕里
   * （`revision.unlock`），不该让每个调用方各查一遍、还各查得不一样。
   *
   * `archived` 算有效：归档是终态，它的签章仍然成立（归档件本身不允许解锁，见 `unlock`）。
   */
  signatureState(): SignatureState {
    const latest = this.signatureInfo();
    /* 一份文档可以被解锁多次：**最近那次**才是当前这次作废的原因 */
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

  /**
   * 导出 OFD / OFD-H。三道门依次判定，顺序不可颠倒：
   *   ① 计划合法性（禁止文本路径化、机读信息必须纳入签名覆盖）；
   *   ② 机读信息新鲜度（陈旧则拒绝导出，而不是导出后再报警）；
   *   ③ 生成真实 ZIP + XML 容器。
   */
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

  /** 导出共享文档并落盘 */
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
   * 锚点状态求值（**派生**，不落存储）：
   *
   *   `valid`      节点在，且内容与提出提示时一致（或未采集文本）；
   *   `relocated`  内容已被改写，但提示针对的**原文片段仍能找到** → 可重锚；
   *   `lost`       节点已删，或内容被整段改写、原文已不存在 → 需人工确认"已随内容清除"。
   *
   * 两处**刻意的保守**（宁可说"还在"，也不误报"丢了"）：
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

  /* ---------------------------- 内部实现 ---------------------------- */

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
    /* 已签章/已归档不可改 —— `unlock` 是**唯一**的例外（它就是为这一条而生的动作，见 `unlock()`）。
       它只把状态退回 draft、不改内容；真正的内容修改要再提交一次，各留一条痕。 */
    if ((this.doc.status === 'signed' || this.doc.status === 'archived') && op !== 'unlock') {
      throw new WriteError(
        WRITE_ERRORS.E_SIGNED_IMMUTABLE,
        `文档已 ${this.doc.status}：须先「解锁」（会留痕并作废原签章）再修改，改完重新签章`,
      );
    }

    /* 快照：始终只快照受影响节点（索引同步与 patch 都依赖它）；
       full 策略额外快照整张节点表，仅用于等价性验证。 */
    const snapshots = new Map<NodeId, DocNode | undefined>();
    for (const id of targets) snapshots.set(id, this.doc.nodes[id] ? cloneDoc({ nodes: { [id]: this.doc.nodes[id] } } as unknown as DocumentModel).nodes[id] : undefined);
    const beforeAll = this.strategy === 'full' ? (structuredClone(this.doc.nodes) as Record<NodeId, DocNode>) : null;

    /* 撤销所需的信息：**改前**的节点表与旁挂数据必须在 `mutate()` 之前取（只有此刻是对的）。
       但**新建的节点**要等 `mutate()` 返回 `result.created` 才知道 —— `createNode` 的 `targets` 是空的
       （它在提交前并不存在，快照里根本没有这个 id），所以槽位在 mutate **之后**才落定。
       首次实现时把这段整个放在 mutate 之前，于是"撤销一次粘贴"什么都没撤回来
       （槽位非空、节点集为空）—— 是被 `test:ui` 的 B26 抓出来的。 */
    const commitRev = this.doc.revisions.length + 1;
    const preSidecars = TOUCHES_SUGGESTIONS.has(op) ? this.sidecarSnapshot() : undefined;

    const result = mutate();

    const undoNodes = new Map(snapshots);
    for (const id of result.created ?? []) {
      if (!undoNodes.has(id)) undoNodes.set(id, undefined);
    }
    if (NOT_UNDOABLE.has(op)) {
      /* 不可撤销的 op 同时**作废整组**：一个撤不动的组留着只会误导（点下去要么报错、要么撤错东西） */
      this.undoSlot = null;
      this.undoGroup = null;
    } else if (this.undoGroup) {
      /* 组内：`rev` / `op` 取首条，节点快照只收**首次出现**的（那才是整组的基线状态） */
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
       跳过本次**新建**的节点：新建内容属于 human 来源，签名门控本来就不要求确认，
       给它加一次自动确认只会平白多一个 rev。 */
    if (actor.kind === 'human' && EDIT_IMPLIES_CONFIRM.has(op) && options.implyConfirm !== false) {
      for (const id of targets) {
        if (result.created?.includes(id)) continue;
        const node = this.doc.nodes[id];
        /* **关键内容（keyContent）不适用"编辑即确认"** —— 这条限制是被用例逼出来的：
           改动一个字，不等于核对过全部。医生把诊断"急性支气管炎"的标点改一下，
           不代表他核对了诊断本身；而 keyContent 恰恰是诊断/剂量/过敏/术式这类
           错一个字就出事的字段。所以关键内容**始终需要显式确认**，
           不能靠"碰过一下"来推定责任。（数量本来就少，显式确认的负担可以承受。）
           另：**不额外递增 rev** —— 同一次提交是原子操作，rev 只递增一次（内容变更那一次）；
           重复递增会让"改了一处"看起来像"改了两版"，而 rev 是要给人做并发控制与版本判断的。
           调用方声明"这次没改内容"（`options.implyConfirm === false`，如绑定数据元标签）时整段跳过：
           推定"改过"的前提不成立。 */
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

    const at = this.tick();
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
           注意这条分支**先于** `withOldValues` 返回，必须自己带上 —— 首次实现时漏了这里，
           被"local 与 full 策略等价"用例当场抓住（没有那条用例，换个策略留痕就不一样了）。 */
        ops.push({ op: 'remove', path: `/nodes/${encodePointer(id)}`, oldValue: before as unknown as JsonValue });
        continue;
      }
      /* 除了新值，把**改前的值**也记进留痕（`oldValue`）：JSON Patch 的 `replace` 只带新值，
         于是"改前是什么"事后谁也答不出来 —— 而审计与纠纷举证要的恰恰是这一句。
         求值根是 `{ nodes: { <id>: before } }`：`prefixNodePaths` 产出的路径正是以 `/nodes/<id>` 开头。 */
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

  /** 逻辑时钟：确定性、单调递增，便于回放与 diff 比对 */
  private tick(): string {
    this.clock += 1000;
    return new Date(this.clock).toISOString().replace(/\.\d{3}Z$/, 'Z');
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

/**
 * patch 归一化：按路径排序。
 *
 * 为什么必须排序：local 策略按"受影响节点集合"顺序产出 op，full 策略按"节点表键序"产出 op，
 * 同一批变更会得到**顺序不同**的 patch 数组，于是留痕不一致、跨实现比对失败
 * （实测：子树删除时两者顺序不同，导致 local 与 full 的文档 JSON 不相等）。
 * 归一化后，patch 只由"变更内容"决定，与策略、与实现内部遍历顺序都无关。
 *
 * 前提：同一节点不会被同时 add 与 remove；加/删/改的路径互不为前缀（由写接口保证）。
 */
function normalizePatchOrder(ops: PatchOp[]): PatchOp[] {
  return [...ops].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** 把 { id: node } 形式的 diff 路径加上 /nodes 前缀 */
function prefixNodePaths(ops: PatchOp[]): PatchOp[] {
  return ops.map((op) => ({ ...op, path: `/nodes${op.path === '/' ? '' : op.path}` }));
}

/**
 * 给 patch 补上 `oldValue`（"改前是什么"）。
 *
 * 为什么收敛到一个函数：两条 patch 策略（`local` / `full`）的产出必须**逐字段相同** ——
 * 这是"策略等价"用例守着的性质。补写逻辑各写一遍，迟早会漂移（而漂移的现场是
 * "换个策略留痕就不一样了"，极难发现）。
 */
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
