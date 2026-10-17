/**
 * L0 文档模型 · 类型定义（v0.1）
 * schemaVersion = "1.0.0"
 *
 * 设计约束（不可妥协）：
 *  1) 每个节点必须携带 provenance（来源）与 rev（版本），缺一不可 —— 这是 G1/G2/G3 能成立的前提
 *  2) 关键内容节点必须 keyContent = true，并强制 humanConfirmed（诊断/剂量/过敏/术式）
 *  3) 节点 id 全局唯一且创建后永不变更 —— AI 落位、留痕 diff、OFD-H 机读信息回指全靠它
 *  4) 机读信息不手工维护，一律由节点树派生（machineReadable 是派生物，可随时重建）
 *  5) 所有时间戳为 ISO8601 UTC 字符串；payload 内不放不可序列化的值
 *  6) schemaVersion 必须支持迁移（见 MIGRATION_NOTES）
 *
 * 载体说明：
 *  - 存储 canonical 形态 = 本模型的 JSON（视图与数据分离）
 *  - 交换/归档形态 = 由本模型映射生成的 OFD（导出侧，见 OfdExportPlan）
 *  - 机读信息落到 OFD 的扩展区：标准正文未公开前不写死命名空间，用 extensions 占位
 */

export const SCHEMA_VERSION = '1.0.0';

export type ISODateTime = string;
export type NodeId = string;
export type ActorId = string;
export type RevisionNo = number;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

/* ------------------------------------------------------------------ */
/* 元数据                                                              */
/* ------------------------------------------------------------------ */

export type DocStatus = 'draft' | 'reviewing' | 'signed' | 'archived' | 'void';

/** 文书类型（手术记录 / 门诊病历 / 超声报告 …） */
export interface DocTypeRef {
  system: 'WST500' | 'WS445' | 'local' | 'custom';
  code: string;
  display: string;
}

export interface PatientRef {
  /** 院内患者主索引，禁止存姓名以外的明文敏感字段 */
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

/* ------------------------------------------------------------------ */
/* 来源与依据（AI 原生能力的核心）                                      */
/* ------------------------------------------------------------------ */

export type ProvenanceOrigin = 'human' | 'ai' | 'system' | 'imported';

export type EvidenceKind =
  | 'his'          // 医嘱/诊断/手术等
  | 'lis'          // 检验
  | 'pacs'         // 影像/心电
  | 'emr-prior'    // 院内既往文书
  | 'guideline'    // 指南/知识库
  | 'terminology'  // 术语库/ICD/LOINC
  | 'template'     // 模板
  | 'user-input'   // 医生口述/键盘
  | 'external-doc';// 外院文档

export interface EvidenceRef {
  kind: EvidenceKind;
  /** 稳定引用标识，如 "LIS:20261008-0930:WBC"、"PACS:CT-10231:结论" */
  ref: string;
  field?: string;
  /** 引用时的原始值文本，用于回溯展示；不得二次加工 */
  valueText?: string;
  /** 依据片段（指南条目原文等） */
  quote?: string;
  /** 若来源是院内其他文书的某个节点 */
  nodeId?: NodeId;
  capturedAt?: ISODateTime;
}

/**
 * AI 来源的"派生记录"：当人工在 AI 生成内容上继续编辑后，origin 会变为 human，
 * 但必须保留"这段文字原本来自哪个模型/哪条建议、被谁在某时刻改过"，
 * 否则 AI 参与度审计（哪些内容经过 AI、修改率多少）会在编辑后断链。
 */
export interface AiDerivation {
  modelId?: string;
  confidence?: number;
  suggestionId?: string;
  editedBy: ActorId;
  editedAt: ISODateTime;
}

export interface Provenance {
  origin: ProvenanceOrigin;
  /** human: 医生工号；system: 服务名；imported: 来源系统 */
  actorId?: ActorId;
  /** ai: 模型标识与版本，如 "local/qwen-med:7b@2026-09" */
  modelId?: string;
  /** ai: 提示词模板标识，用于评测与回放 */
  promptId?: string;
  /** ai 必填，0~1 */
  confidence?: number;
  evidence?: EvidenceRef[];
  /** ai 内容被采纳时的确认人（必须是人） */
  acceptedBy?: ActorId;
  acceptedAt?: ISODateTime;
  /** 未被采纳的 AI 建议 id（用于统计医疗修改率） */
  suggestionId?: string;
  /** 若该节点内容曾由 AI 生成、后被人工编辑，此处保留 AI 来源链 */
  derivedFrom?: AiDerivation;
  at: ISODateTime;
}

/* ------------------------------------------------------------------ */
/* 数据元标签                                                          */
/* ------------------------------------------------------------------ */

export interface DataElementTag {
  system: 'WS445' | 'WST500' | 'ICD10' | 'ICD9CM3' | 'LOINC' | 'local' | 'custom';
  code: string;
  display?: string;
}

/* ------------------------------------------------------------------ */
/* 节点                                                                */
/* ------------------------------------------------------------------ */

export type NodeType =
  | 'document'
  | 'section'
  | 'paragraph'
  | 'text'           // 行内文本容器（runs）
  | 'field'          // 数据元值控件（结构化落点）
  | 'control'        // 医学表达式控件（月经史/牙位图/三测单…）
  | 'table'
  | 'tableRow'
  | 'tableCell'
  | 'image'
  | 'listGroup'
  | 'listItem'
  | 'signatureBlock'
  | 'extension';     // 私有/待标准明确的扩展节点（OFD-H 机读信息载体候选）

export interface NodeBase {
  id: NodeId;
  type: NodeType;
  parentId: NodeId | null;
  /** 同级顺序，稀疏整数便于插入 */
  order: number;
  rev: RevisionNo;
  provenance: Provenance;
  /** 关键内容：必须人工确认后方可进入 signed 状态 */
  keyContent?: boolean;
  /** 是否已由人工确认（人签名前必须全部为 true） */
  humanConfirmed?: boolean;
  tags?: DataElementTag[];
  /**
   * 机器绑上、尚未由自然人确认的数据元标签（即时结构化采纳时写入）。
   *
   * 与 `tags` 分开：模板/导入自带的标签属文书结构，不该要求逐条确认；
   * 只有"机器在写作过程中猜出来、由人采纳的"那些才需要人再确认一次。
   * 未清空则签章被拦（`E_TAG_UNCONFIRMED`，与"关键内容未确认"同档）。
   */
  unconfirmedTags?: DataElementTag[];
  styleRef?: string;
  /** 仅用于渲染的辅助信息，不参与语义与机读导出 */
  presentation?: { keepWithNext?: boolean; pageBreakBefore?: boolean };
}

export interface TextRun {
  text: string;
  marks?: Array<'bold' | 'italic' | 'underline' | 'sup' | 'sub' | 'highlight'>;
  tags?: DataElementTag[];
}

export interface DocumentNode extends NodeBase {
  type: 'document';
}

export interface SectionNode extends NodeBase {
  type: 'section';
  title?: string;
  /** 章节编码，便于机读定位 */
  sectionCode?: string;
  /** 必备章节：由模板的章节属性带入；写路径拒绝删除它（不写 = 普通章节） */
  required?: boolean;
}

export interface ParagraphNode extends NodeBase {
  type: 'paragraph';
  /** 段落级语义，如 "presentIllness"、"pastHistory"、"physicalExam" */
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
  /** 结构化值（机器真值）；文本展示由 valueText 承担 */
  value: JsonValue;
  valueText?: string;
  unit?: string;
  required?: boolean;
  /** code 类型时的可选值域快照（便于离线校验） */
  valueSet?: Array<{ code: string; display?: string }>;
  /** 来源于外部系统时的稳定 key，如 "LIS.WBC"（趋势聚合的键） */
  sourceKey?: string;
  /** 采样时间（**标本采集/测量时间，不是报告时间**）：趋势按它排序，用报告时间会错位 */
  sampledAt?: ISODateTime;
  /** 参考范围：回答"这个值是不是异常"；text 用于无法数值化的范围（如"阴性"） */
  referenceRange?: { low?: number; high?: number; text?: string; unit?: string };
}

export type ControlKind =
  | 'menstrualHistory'
  | 'odontogram'
  | 'vitalSignsChart'
  | 'scaleScore'
  | 'labTrend'
  | 'custom';

export interface ControlNode extends NodeBase {
  type: 'control';
  controlKind: ControlKind;
  /** 控件私有数据；机读导出时映射为具体 tag */
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
  /** 资源引用（导出 OFD 时写入 Res） */
  resRef: string;
  altText?: string;
  /** 影像结论等文本化摘要，可被机读 */
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
  /** 签名占位：真实签名值在导出 OFD 签名区承载 */
  signatureRef?: string;
}

export interface ExtensionNode extends NodeBase {
  type: 'extension';
  /** 命名空间标识，标准未明确前用自定义值，如 "local/ai-provenance"、"candidate/ofd-h-machine" */
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

/* ------------------------------------------------------------------ */
/* 机读信息（OFD-H 侧派生物 + round-trip 校验基准）                     */
/* ------------------------------------------------------------------ */

export interface MachineDataElement {
  tag: DataElementTag;
  value: JsonValue;
  valueText?: string;
  unit?: string;
  /** 回指源节点，round-trip 时按 nodeId 对齐 */
  nodeId: NodeId;
  origin: ProvenanceOrigin;
  confidence?: number;
}

export interface MachineReadableBlock {
  generatedAt: ISODateTime;
  generator: string;
  /**
   * 生成时机读信息所依据的节点内容指纹。
   *
   * 规格（跨实现必须一致，否则会互相误判陈旧）：
   *   sourceHash = sha256( stableStringify(nodes) ) 的十六进制前 32 位
   *   其中 stableStringify 为 canonical JSON —— 对象键名递归排序，数组保持顺序。
   *
   * 两条教训（均已实测踩到）：
   *   1) 不能用时间戳判定陈旧：签名/改状态会推进 updatedAt 但内容未变，按时间戳判会误报"刚签完就陈旧"；
   *   2) 不能用非 canonical 的 JSON.stringify：键序在不同实现下不稳定，
   *      同一内容会算出不同指纹 → 跨实现假警报。哈希算法一旦变更（含 canonical 化），
   *      存量文档的 sourceHash 全部失效，必须提供一次性重算步骤。
   */
  sourceHash?: string;
  /** 与 schemaVersion 同步，便于跨版本对齐 */
  modelSchemaVersion: string;
  dataElements: MachineDataElement[];
  /** 关键内容清单（用于定版态校验"关键内容缺失"） */
  keyContentRefs?: Array<{ nodeId: NodeId; tag?: DataElementTag; present: boolean }>;
}

/* ------------------------------------------------------------------ */
/* 留痕与审计                                                          */
/* ------------------------------------------------------------------ */

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
  /** 系统取数（LIS/HIS 搬运确定性数据）；**不在**"编辑即确认"白名单里 */
  | 'external';

export interface RevisionEntry {
  rev: RevisionNo;
  at: ISODateTime;
  actorId: ActorId;
  op: RevisionOp;
  targetId?: NodeId;
  /** 结构化补丁（json-patch 风格子集） */
  patch?: Array<{ op: 'add' | 'remove' | 'replace'; path: string; value?: JsonValue }>;
  /** 采纳/拒绝 AI 建议时关联，用于计算修改率 */
  aiSuggestionId?: string;
  modelId?: string;
  confidence?: number;
  beforeHash?: string;
  afterHash?: string;
}

export interface SignatureRef {
  signatureRef: string;
  signerRole?: SignatureBlockNode['signerRole'];
  signerId?: ActorId;
  signedAt?: ISODateTime;
  /** 签名覆盖的文件清单（导出 OFD 后回填，用于校验结构化数据是否在签名范围内） */
  covers?: string[];
}

/* ------------------------------------------------------------------ */
/* 文档根                                                              */
/* ------------------------------------------------------------------ */

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
  /** 扁平索引 + parentId/order 形成树：便于 AI 按 id 落位与 diff */
  nodes: Record<NodeId, DocNode>;
  /** 派生：由节点树重建，可校验一致性 */
  machineReadable?: MachineReadableBlock;
  revisions: RevisionEntry[];
  signatureRefs?: SignatureRef[];
  /** 私有扩展与标准未明确区（含 OFD-H 机读信息占位） */
  extensions?: Record<string, JsonValue>;
  /** 渲染资源（图片等），导出 OFD 时写入 Res */
  resources?: Record<string, { mime: string; dataBase64?: string; sha256?: string }>;
}

/* ------------------------------------------------------------------ */
/* OFD 导出计划（导出侧契约，实现见后续阶段）                           */
/* ------------------------------------------------------------------ */

export interface OfdExportPlan {
  /** 呈现侧：节点 → 页面对象映射策略 */
  layout: {
    pagination: 'derived' | 'template-fixed';
    fontEmbedding: 'subset' | 'full';
    /** 文本必须落为真实文本对象，禁止路径化 */
    textAsPath: false;
  };
  /** 机读侧：机读信息写入载体 */
  machineReadable: {
    /** 'extension-node' | 'custom-data' | 'embedded-xml' —— 标准未明确前保持可替换 */
    carrier: 'extension-node' | 'custom-data' | 'embedded-xml';
    namespace: string;
    /** 是否将机读信息纳入签名覆盖范围（必须为 true） */
    signed: true;
    payloadFrom: 'machineReadable.dataElements';
  };
  /** 签名侧 */
  signature: {
    algorithm: 'SM2' | 'SM3' | 'RSA';
    timestampAuthority?: string;
    /** 签章服务地址（院内） */
    provider?: string;
  };
}

/* ------------------------------------------------------------------ */
/* 校验与迁移                                                          */
/* ------------------------------------------------------------------ */

export type ValidationCode =
  | 'E_NODE_ID_DUP'
  | 'E_PARENT_MISSING'
  | 'E_ORPHAN_NODE'
  | 'E_AI_NO_PROVENANCE'
  | 'E_AI_LOW_CONFIDENCE_UNCONFIRMED'
  | 'E_KEY_CONTENT_UNCONFIRMED'
  | 'E_MACHINE_READABLE_STALE'
  | 'E_REVISION_GAP'
  | 'E_SCHEMA_VERSION_UNKNOWN'
  | 'E_SIGNED_WITH_UNCONFIRMED_AI';

export interface ValidationIssue {
  code: ValidationCode;
  nodeId?: NodeId;
  message: string;
  severity: 'error' | 'warning';
}

/** 迁移约定：schemaVersion 递增必须附迁移函数，禁止原地改字段语义 */
export const MIGRATION_NOTES: Record<string, string> = {
  '1.0.0': '初始版本：扁平节点树 + provenance + revisions + machineReadable 派生块',
};
