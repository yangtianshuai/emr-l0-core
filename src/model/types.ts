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
  suggestionId?: string;
}

export interface TextRun {
  text: string;
  marks?: TextMark[];
  tags?: DataElementTag[];
  provenance?: RunProvenance;
}

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
  sourceKey?: string;
  sampledAt?: string;
  referenceRange?: { low?: number; high?: number; text?: string; unit?: string };
}

export type ControlKind = 'menstrualHistory' | 'odontogram' | 'vitalSignsChart' | 'scaleScore' | 'labTrend' | 'custom';

export type ControlShape = 'scale' | 'series' | 'matrix' | 'checklist' | 'image';

export const CONTROL_SHAPES: readonly ControlShape[] = ['scale', 'series', 'matrix', 'checklist', 'image'];

export interface ControlFieldSnapshot {
  key: string;
  label: string;
  dataType: FieldDataType;
  unit?: string;
  valueSet?: Array<{ code: string; display?: string }>;
  referenceRange?: { low?: number; high?: number; text?: string; unit?: string };
  required?: boolean;
  tag?: DataElementTag;
  axis?: 'time';
}

export interface ControlNode extends NodeBase {
  type: 'control';
  controlKind: ControlKind;
  shape: ControlShape;
  rows?: Array<{ key: string; label: string }>;
  columns?: Array<{ key: string; label: string }>;
  layout?: { columns?: number; maxPoints?: number };
  rowCount?: number;
  definitionId?: string;
  payloadVersion?: number;
  fields?: ControlFieldSnapshot[];
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
  | 'revert'
  | 'external'
  | 'submit'
  | 'review'
  | 'void'
  | 'archive';

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
  acknowledgedUnconfirmed?: { ai: NodeId[]; imported: NodeId[] };
  unlock?: {
    reason: string;
    invalidated: Array<{ publicKeyFingerprint: string; signedAt: string }>;
  };
  revert?: {
    revertedRev: number;
    revertedOp: RevisionOp;
  };
  revertedTo?: {
    toRev: number;
    revertedRevs: number[];
  };
  review?: {
    decision: 'submit' | 'approve' | 'reject';
    note?: string;
  };
  /** 作废理由（必填）：作废是终态动作，"为什么这份没了"只能由留痕回答 */
  voided?: {
    reason: string;
  };
}

/** 被签名文件的摘要条目（T18） */
export interface SignatureReference {
  /** 被覆盖文件的路径（与 OFD 容器内路径一致，便于第三方复算） */
  path: string;
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
  publicKeyFingerprint?: string;
  publicKeyBase64?: string;
  signedInfoDigest?: string;
  /** SM2 签名值（DER）的 base64 */
  signatureValue?: string;
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
  E_TAG_UNCONFIRMED: 'E_TAG_UNCONFIRMED',
  E_SIGNED_WITH_UNCONFIRMED_AI: 'E_SIGNED_WITH_UNCONFIRMED_AI',
  E_MACHINE_READABLE_STALE: 'E_MACHINE_READABLE_STALE',
  E_REVISION_GAP: 'E_REVISION_GAP',
  E_SCHEMA_VERSION_UNKNOWN: 'E_SCHEMA_VERSION_UNKNOWN',
} as const;

export type SemanticCode = (typeof SEMANTIC_CODES)[keyof typeof SEMANTIC_CODES];

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
  aiThreshold?: number;
  aiKeyContentThreshold?: number;
}
