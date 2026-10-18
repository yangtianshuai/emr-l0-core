export const SCHEMA_VERSION = '1.0.0' as const;

export type ISODateTime = string;
export type NodeId = string;
export type ActorId = string;
export type RevisionNo = number;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type DocStatus = 'draft' | 'reviewing' | 'signed' | 'archived' | 'void';

export interface DocTypeRef {
  system: 'WST500' | 'WS445' | 'local' | 'custom';
  code: string;
  display: string;
}

export interface PatientRef {
  patientId: string;
  nameMasked?: string;
  gender?: 'M' | 'F' | 'U';
  birthDate?: string;
}

export interface EncounterRef {
  visitId?: string;
  visitType?: 'outpatient' | 'inpatient' | 'emergency' | 'physical-exam';
  deptCode?: string;
  admittedAt?: ISODateTime;
  dischargedAt?: ISODateTime;
}

export type ProvenanceOrigin = 'human' | 'ai' | 'system' | 'imported';

/**
 * 证据来源类别。
 *
 * `dictation`（语音转写）是独立一类，不并入 `user-input`：两者在追溯意义上不同 ——
 * 语音还要能回答"哪段音频、什么时候说的、哪个模型听写的"。
 * 合并会让"哪些内容是语音来的"变得不可检索，而审计恰恰常问这个。
 *
 *  新增取值必须同步 `validate.ts` 的白名单（那里漏了不会当场报错，
 * 只在全量校验时以 `E_ENUM_INVALID` 暴露，且排查方向容易跑偏）。
  */
export type EvidenceKind = 'his' | 'lis' | 'pacs' | 'emr-prior' | 'guideline' | 'terminology' | 'template' | 'user-input' | 'external-doc' | 'dictation' | 'patient';

export interface EvidenceRef {
  kind: EvidenceKind;
  ref: string;
  field?: string;
  valueText?: string;
  quote?: string;
  nodeId?: NodeId;
  capturedAt?: ISODateTime;
}

/** 人工在 AI 内容上续改后，保留的 AI 来源链（否则 AI 参与度审计会断链） */
export interface AiDerivation {
  modelId?: string;
  confidence?: number;
  suggestionId?: string;
  editedBy: ActorId;
  editedAt: ISODateTime;
}

export interface Provenance {
  origin: ProvenanceOrigin;
  actorId?: ActorId;
  modelId?: string;
  promptId?: string;
  confidence?: number;
  evidence?: EvidenceRef[];
  acceptedBy?: ActorId;
  acceptedAt?: ISODateTime;
  suggestionId?: string;
  derivedFrom?: AiDerivation;
  at: ISODateTime;
}

export type TagSystem = 'WS445' | 'WST500' | 'ICD10' | 'ICD9CM3' | 'LOINC' | 'local' | 'custom';

export const TAG_SYSTEMS: TagSystem[] = ['WS445', 'WST500', 'ICD10', 'ICD9CM3', 'LOINC', 'local', 'custom'];

export interface DataElementTag {
  system: TagSystem;
  code: string;
  display?: string;
}

export type NodeType =
  | 'document'
  | 'section'
  | 'paragraph'
  | 'text'
  | 'field'
  | 'control'
  | 'table'
  | 'tableRow'
  | 'tableCell'
  | 'image'
  | 'listGroup'
  | 'listItem'
  | 'signatureBlock'
  | 'extension';

export interface NodeBase {
  id: NodeId;
  type: NodeType;
  parentId: NodeId | null;
  order: number;
  rev: RevisionNo;
  provenance: Provenance;
  keyContent?: boolean;
  humanConfirmed?: boolean;
  tags?: DataElementTag[];
  unconfirmedTags?: DataElementTag[];
  styleRef?: string;
  presentation?: { keepWithNext?: boolean; pageBreakBefore?: boolean };
}

export type TextMark = 'bold' | 'italic' | 'underline' | 'sup' | 'sub' | 'highlight';

export interface RunProvenance {
  origin: ProvenanceOrigin;
  modelId?: string;
  confidence?: number;
  /** 建议来源：采纳 AI 时写入，用于"这一句来自哪条建议"的逐句回溯 */
  suggestionId?: string;
}

export interface TextRun {
  text: string;
  marks?: TextMark[];
  tags?: DataElementTag[];
  provenance?: RunProvenance;
}

/** 根节点。此前被漏在 DocNode 联合之外（由 T02 的合成夹具首次触发类型错误） */
export interface DocumentNode extends NodeBase {
  type: 'document';
}

export interface SectionNode extends NodeBase {
  type: 'section';
  title?: string;
  sectionCode?: string;
  required?: boolean;
}

export interface ParagraphNode extends NodeBase {
  type: 'paragraph';
  semantic?: string;
  align?: 'left' | 'center' | 'right' | 'justify';
}

export interface TextNode extends NodeBase {
  type: 'text';
  runs: TextRun[];
}

export type FieldDataType = 'text' | 'number' | 'date' | 'code' | 'boolean' | 'expression';

export interface FieldNode extends NodeBase {
  type: 'field';
  dataType: FieldDataType;
  value: JsonValue;
  valueText?: string;
  unit?: string;
  required?: boolean;
  valueSet?: Array<{ code: string; display?: string }>;
  /** 来源于外部系统时的稳定 key，如 "LIS.WBC"（也是趋势聚合的键） */
  sourceKey?: string;
  sampledAt?: string;
  /**
   * 参考范围：`low/high` 承载可数值化的范围，`text` 承载无法数值化的（如"阴性"）。
   *
   * 缺了它只能显示数值，回答不了医生最关心的那个问题："这个值是不是异常"。
   * 异常值才是住院病程里真正要看的东西。
    */
  referenceRange?: { low?: number; high?: number; text?: string; unit?: string };
}

export type ControlKind = 'menstrualHistory' | 'odontogram' | 'vitalSignsChart' | 'scaleScore' | 'labTrend' | 'custom';

export type ControlShape = 'scale' | 'series' | 'matrix' | 'checklist' | 'image';

export const CONTROL_SHAPES: readonly ControlShape[] = ['scale', 'series', 'matrix', 'checklist', 'image'];

export interface ControlFieldSnapshot {
  /** 控件内的唯一名：payload 的键就是它 */
  key: string;
  label: string;
  dataType: FieldDataType;
  unit?: string;
  valueSet?: Array<{ code: string; display?: string }>;
  referenceRange?: { low?: number; high?: number; text?: string; unit?: string };
  required?: boolean;
  /**
   * 机读摊平用：给了 tag 的字段才会产出数据元（与 `FieldNode.tags` 同一个概念）。
   * 不绑 tag 的字段只给人看 —— 这是"这个控件能不能被机器读懂"的分水岭。
    */
  tag?: DataElementTag;
  /**
   * `series` 形状：哪一格是时间轴（趋势按它排序；整份控件只能有一格标它）。
   *
   * 它属于"声明"而不是"可执行内容"，所以与其它字段一起抄进节点 ——
   * 渲染趋势时不回查包也能知道"按哪一格排"。
    */
  axis?: 'time';
}

export interface ControlNode extends NodeBase {
  type: 'control';
  controlKind: ControlKind;
  shape: ControlShape;
  rows?: Array<{ key: string; label: string }>;
  columns?: Array<{ key: string; label: string }>;
  /** `scale` 的排布（每行几格 / 满分多少）：只影响画法，不改变数据结构  */
  layout?: { columns?: number; maxPoints?: number };
  /** `series` 的记录行数：模板给几行就让医生填几条（趋势至少要两行才画得出变化） */
  rowCount?: number;
  /** 控件定义（包内 `ControlDefinition.itemId`）：溯源用，回答"这一版是按哪份定义开的" */
  definitionId?: string;
  /** 快照与 payload 按定义的哪一版生成（定义改了字段语义就要升版，见模板层） */
  payloadVersion?: number;
  fields?: ControlFieldSnapshot[];
  /**
   * 填进去的值。键的规则由形状决定，且只有一处定义（`model/control.ts` 的
   * `controlCellKey` —— 写路径、渲染器、机读摊平都从那里取；各拼一遍迟早对不上，
   * 而对不上的症状是"医生填的值在导出里凭空不见"）：
   *
   *   - `scale` / `checklist`：`payload[字段key]`；
   *   - `series`：`payload[字段key.rN]`（N 从 1 起，第 N 条记录）；
   *   - `matrix`：`payload[r行key.c列key]`。
   *
   * 没填过的格不存在这个键（不写 null）："空着"与"填了个空字符串"是两件事，
   * 混起来之后"这一格到底填没填过"就再也答不出来。
    */
  payload: Record<string, JsonValue>;
}

export interface TableNode extends NodeBase {
  type: 'table';
  colCount?: number;
  headerRows?: number;
}

export interface TableRowNode extends NodeBase {
  type: 'tableRow';
}

export interface TableCellNode extends NodeBase {
  type: 'tableCell';
  colSpan?: number;
  rowSpan?: number;
}

export interface ImageNode extends NodeBase {
  type: 'image';
  resRef: string;
  altText?: string;
  caption?: string;
}

export interface ListGroupNode extends NodeBase {
  type: 'listGroup';
  ordered?: boolean;
}

export interface ListItemNode extends NodeBase {
  type: 'listItem';
}

export interface SignatureBlockNode extends NodeBase {
  type: 'signatureBlock';
  signerRole?: 'author' | 'reviewer' | 'approver' | 'patient';
  signerId?: ActorId;
  signatureRef?: string;
}

export interface ExtensionNode extends NodeBase {
  type: 'extension';
  namespace: string;
  payload: JsonValue;
}

export type DocNode =
  | DocumentNode
  | SectionNode
  | ParagraphNode
  | TextNode
  | FieldNode
  | ControlNode
  | TableNode
  | TableRowNode
  | TableCellNode
  | ImageNode
  | ListGroupNode
  | ListItemNode
  | SignatureBlockNode
  | ExtensionNode;

export interface MachineDataElement {
  tag: DataElementTag;
  value: JsonValue;
  valueText?: string;
  unit?: string;
  nodeId: NodeId;
  origin: ProvenanceOrigin;
  confidence?: number;
}

export interface MachineReadableBlock {
  generatedAt: ISODateTime;
  generator: string;
  /** 生成时机读信息所依据的节点内容指纹（canonical JSON 的 sha256 前 32 位十六进制） */
  sourceHash?: string;
  modelSchemaVersion: string;
  dataElements: MachineDataElement[];
  keyContentRefs?: Array<{ nodeId: NodeId; tag?: DataElementTag; present: boolean }>;
}

export type RevisionOp =
  | 'create'
  | 'insert'
  | 'update'
  | 'delete'
  | 'move'
  | 'accept-ai'
  | 'reject-ai'
  | 'sign'
  | 'import'
  | 'migrate'
  | 'unlock'
  /**
   * 撤销某一次写入（以新 rev 回滚，不篡改历史）。
   *
   * 与 `unlock` 同理必须单独一个 op：撤销不改"内容是怎么来的"，它改的是"哪一次变更被退回了"，
   * 载荷 `RevisionEntry.revert.revertedRev` 指回被撤销的那条留痕，两者靠它关联。
    */
  | 'revert'
  | 'external';

export interface PatchOp {
  op: 'add' | 'remove' | 'replace';
  path: string;
  value?: JsonValue;
  oldValue?: JsonValue;
}

export interface RevisionEntry {
  rev: RevisionNo;
  at: ISODateTime;
  actorId: ActorId;
  op: RevisionOp;
  targetId?: NodeId;
  patch?: PatchOp[];
  aiSuggestionId?: string;
  aiSuggestionIds?: string[];
  modelId?: string;
  confidence?: number;
  beforeHash?: string;
  afterHash?: string;
  confirmedNodeIds?: NodeId[];
  /**
   * 签章时"已知但未逐条确认"的 AI / 导入内容清单。
   *
   * 这不是豁免，而是把责任显式落到签名人身上：签名有效，但记录里清楚写着
   * "哪些内容没有逐条点过确认"。没有它，分级放行就等于静默放行 ——
   * 那才是真正危险的做法。
    */
  acknowledgedUnconfirmed?: { ai: NodeId[]; imported: NodeId[] };
  unlock?: {
    reason: string;
    invalidated: Array<{ publicKeyFingerprint: string; signedAt: string }>;
  };
  /** 撤销：本条留痕撤回了第几条（`revertedRev`），并记下被撤销那条的 op */
  revert?: {
    revertedRev: number;
    revertedOp: RevisionOp;
  };
}

/** 被签名文件的摘要条目（T18） */
export interface SignatureReference {
  /** 被覆盖文件的路径（与 OFD 容器内路径一致，便于第三方复算） */
  path: string;
  /** SM3 摘要（十六进制小写） */
  digest: string;
}

export interface SignatureRef {
  signatureRef: string;
  signerRole?: SignatureBlockNode['signerRole'];
  signerId?: ActorId;
  signedAt?: ISODateTime;
  covers?: string[];
  /** 签名算法（如 SM2-SM3） */
  algorithm?: string;
  /** 签名后端（software / openssl / hsm / ukey …），如实标注便于审计 */
  provider?: string;
  /** 公钥指纹 = SM3(SPKI) */
  publicKeyFingerprint?: string;
  /** 公钥 SPKI（DER）的 base64，第三方验签只需它 */
  publicKeyBase64?: string;
  /** SM3(SignedInfo) */
  signedInfoDigest?: string;
  /** SM2 签名值（DER）的 base64 */
  signatureValue?: string;
  /** 被覆盖文件的摘要清单 */
  references?: SignatureReference[];
}

export interface DocumentModel {
  schemaVersion: string;
  docId: string;
  docType: DocTypeRef;
  patient: PatientRef;
  encounter?: EncounterRef;
  status: DocStatus;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
  createdBy: ActorId;
  rootId: NodeId;
  /** 扁平索引 + parentId/order 构成有序树（便于 AI 按 id 落位与 diff） */
  nodes: Record<NodeId, DocNode>;
  machineReadable?: MachineReadableBlock;
  revisions: RevisionEntry[];
  signatureRefs?: SignatureRef[];
  extensions?: Record<string, JsonValue>;
  resources?: Record<string, { mime: string; dataBase64?: string; sha256?: string }>;
}

/** 语义规则码（与工具链 S5 完全一致，跨实现必须同名） */
export const SEMANTIC_CODES = {
  E_NODE_ID_DUP: 'E_NODE_ID_DUP',
  E_PARENT_MISSING: 'E_PARENT_MISSING',
  E_ORPHAN_NODE: 'E_ORPHAN_NODE',
  E_AI_NO_PROVENANCE: 'E_AI_NO_PROVENANCE',
  E_AI_LOW_CONFIDENCE_UNCONFIRMED: 'E_AI_LOW_CONFIDENCE_UNCONFIRMED',
  E_KEY_CONTENT_UNCONFIRMED: 'E_KEY_CONTENT_UNCONFIRMED',
  /** 机器绑上的数据元标签未经人工确认就进入 signed/archived —— 与"关键内容未确认"同档：永远阻断  */
  E_TAG_UNCONFIRMED: 'E_TAG_UNCONFIRMED',
  E_SIGNED_WITH_UNCONFIRMED_AI: 'E_SIGNED_WITH_UNCONFIRMED_AI',
  E_MACHINE_READABLE_STALE: 'E_MACHINE_READABLE_STALE',
  E_REVISION_GAP: 'E_REVISION_GAP',
  E_SCHEMA_VERSION_UNKNOWN: 'E_SCHEMA_VERSION_UNKNOWN',
} as const;

export type SemanticCode = (typeof SEMANTIC_CODES)[keyof typeof SEMANTIC_CODES];

/** 结构规则码（实现侧自定，工具链按 JSON Schema 表达） */
export type StructuralCode =
  | 'E_REQUIRED_FIELD'
  | 'E_TYPE_INVALID'
  | 'E_ENUM_INVALID'
  | 'E_UNKNOWN_FIELD'
  | 'E_DATETIME_INVALID'
  | 'E_UNKNOWN_NODE_TYPE'
  | 'E_PATTERN_INVALID'
  /** T18：签名材料缺失成组字段（只留元数据、丢了签名值的"签章"不可验证） */
  | 'E_SIGNATURE_INCOMPLETE';

export type ValidationCode = SemanticCode | StructuralCode;

export interface ValidationIssue {
  code: ValidationCode;
  message: string;
  path: string;
  nodeId?: NodeId;
  severity: 'error' | 'warning';
}

export interface ValidateOptions {
  /** 一般内容 AI 置信度阈值 */
  aiThreshold?: number;
  /** 关键内容 AI 置信度阈值 */
  aiKeyContentThreshold?: number;
}
