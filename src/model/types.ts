/**
 * L0 文档模型 · 规范类型（modelSchemaVersion = 1.0.0）
 *
 * 与规格文件 schema/l0-document-model.ts 对应；本文件是**实现侧 canonical 类型**。
 *
 * 兼容性约束（Node 类型剥离 / erasable syntax only）：
 *   - 不使用 enum / namespace / 参数属性 / 装饰器；
 *   - 类型导入一律 `import type`；
 *   - 相对导入必须带扩展名。
 */

export const SCHEMA_VERSION = '1.0.0' as const;

export type ISODateTime = string;
export type NodeId = string;
export type ActorId = string;
export type RevisionNo = number;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

/* ------------------------------- 元数据 ------------------------------- */

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

/* ------------------------------- 来源链 ------------------------------- */

export type ProvenanceOrigin = 'human' | 'ai' | 'system' | 'imported';

/**
 * 证据来源类别。
 *
 * `dictation`（语音转写）是独立一类，不并入 `user-input`：两者在**追溯意义**上不同 ——
 * 语音还要能回答"哪段音频、什么时候说的、哪个模型听写的"。
 * 合并会让"哪些内容是语音来的"变得不可检索，而审计恰恰常问这个。
 *
 * ⚠️ 新增取值必须同步 `validate.ts` 的白名单（那里漏了不会当场报错，
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

/* ------------------------------- 数据元 ------------------------------- */

export type TagSystem = 'WS445' | 'WST500' | 'ICD10' | 'ICD9CM3' | 'LOINC' | 'local' | 'custom';

/**
 * 标签体系的**运行时清单**（与上面的联合类型同一份事实）。
 *
 * 文档校验与模板校验共用它：两处各写一份的结果是"模板改得进去、开出来的文档案校验不过"，
 * 而那个报错出现在医生要开文书的时候（见 `model/validate.ts` 顶部的等价性纪律）。
 */
export const TAG_SYSTEMS: TagSystem[] = ['WS445', 'WST500', 'ICD10', 'ICD9CM3', 'LOINC', 'local', 'custom'];

export interface DataElementTag {
  system: TagSystem;
  code: string;
  display?: string;
}

/* --------------------------------- 节点 --------------------------------- */

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
  /**
   * **机器绑上、但尚未由自然人确认**的数据元标签（即时结构化采纳时写入）。
   *
   * 与 `tags` 分开的两个理由：
   *   1) 标签要**立刻生效**（进机读信息、被下游消费），但"生效"不等于"医生认可"；
   *   2) 模板 / 导入 / 出厂自带的标签是**文书结构的一部分**，不该要求逐条确认 ——
   *      只有"写作过程中机器猜出来、由人采纳的"那些才需要。混进 `tags` 就只能二选一：
   *      要么全拦（开单即签不了章），要么全放（机器猜的标签白拿人工背书）。
   *
   * 由 `confirmNode` / `confirmNodes` / `confirmSubtree` 一并清空（医生看过这段 = 连带认可它的标签），
   * 未清空则签章被拦（`SESSION` 的签章门控 ① 与 `validate.ts` 的 `E_TAG_UNCONFIRMED`）。
   */
  unconfirmedTags?: DataElementTag[];
  styleRef?: string;
  presentation?: { keepWithNext?: boolean; pageBreakBefore?: boolean };
}

export type TextMark = 'bold' | 'italic' | 'underline' | 'sup' | 'sub' | 'highlight';

/**
 * **run 级来源**：这一句（而不是"这一段"）是谁写的。
 *
 * 为什么需要它：节点级 `Provenance` 只回答"这一段整体算谁的"。在自由流式编辑里
 * 这个粒度不够 —— 医生在 AI 起草的一段中间插了自己的两句话，整段仍是"AI 起草"，
 * 于是逐句回溯（G2）与 AI 参与度标记（G3）会一起失真，且失真方向是"把医生写的算成 AI 写的"。
 *
 * 为什么不直接复用节点级 `Provenance`：那个结构带 evidence / acceptedBy / derivedFrom
 * 等需要按节点汇总的字段，逐 run 复制一份会让序列化体积与 diff 噪声一起膨胀；
 * 而"这一句是谁写的"只需要最少几个字段。
 *
 * **归属语义（一句话）**：没有 `provenance` 的 run **继承所属节点的 provenance**，
 * 有则覆盖它。这条规则让"一个 run 都没有 provenance"的旧文档行为完全不变，
 * 因此它是**可选字段**（不需要版本迁移，见 `model/migrations.ts` 的说明）。
 *
 * ⚠️ 新增字段必须同步三处：`validate.ts` 的 `RUN_KEYS` 白名单、`core/text-runs.ts` 的
 * `sameFormat`（否则格式不同的相邻 run 会被合并、来源被抹掉）、以及本文件的序列化顺序。
 */
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
  /** 见 `RunProvenance`：缺省表示继承节点级 provenance */
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
  /**
   * **必备章节**：这一章不允许被删掉。
   *
   * 它是**责任与结构**上的声明，不是"这一章必须写满"：由模板的章节属性在开文书那一刻抄进来
   * （与 `keyContent` / 槽位必填同一族，见 `template/types.ts` 的 `TemplateSection`）。
   *
   * 为什么必须落在**文档模型**里而不是只留在模板里：模板管不到已经开出来的病历 ——
   * "必备"若只是一句模板声明，医生把这一章删掉时系统一句话都不会说，
   * 而事后没人说得清"这份病历为什么少了主诉"。落进模型，写路径才拦得住
   * （见 `core/session.ts` 的 `deleteNode`）。
   *
   * 不写 = 普通章节：既有文档一份都没写它，不能因为加了"必备"这个概念就让它们突然变样。
   */
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
  /**
   * 采样时间（ISO8601）。**是标本采集/测量时间，不是报告时间**。
   *
   * 为什么必须是采样时间：住院看的是"病情随时间的演变"。用报告时间会把趋势画错位 ——
   * 上午抽血、下午出报告的结果若按报告时间落位，就会与下午的采样点混在一起。
   * 缺了它，"连续值趋势"在原理上无法还原（这是趋势功能的前提条件）。
   */
  sampledAt?: string;
  /**
   * 参考范围：`low/high` 承载可数值化的范围，`text` 承载无法数值化的（如"阴性"）。
   *
   * 缺了它只能显示数值，回答不了医生最关心的那个问题："**这个值是不是异常**"。
   * 异常值才是住院病程里真正要看的东西。
   */
  referenceRange?: { low?: number; high?: number; text?: string; unit?: string };
}

/**
 * 专科控件的**语义类型**：它回答"这是哪一种控件"（质控、机读摊平与导出按它分派）。
 *
 * 前五类是**已知的专科记录**：月经史、牙位图、生命体征单、量表评分、化验趋势；
 * 第六个 `custom` 是**兜底档** —— "归不进上面五类"。
 *
 * 为什么必须留这个兜底：它是**闭集**（新增一类要同时改这里的联合类型、
 * `model/validate.ts` 的 `CONTROL_KIND_VALUES` 与 `template/engine.ts` 的 `CONTROL_KINDS`；
 * 两处漂移的症状是"装得进去、产出的病历校验不过"）。没有兜底，任何"归不进这五类"的
 * 控件就**根本建不出来** —— 而控件恰恰是要让院内自建的（"控件很多"发生在数据里）。
 *
 * 代价要说清：选了 `custom` 就等于告诉下游"我不知道该怎么归类它"，
 * 按类型分派的地方只能走通用路径（导出里就是 `[控件：custom]` 这种占位文本）。
 * 所以它是**少数情况**，不是"懒得想时随手选的那个"。
 *
 * 注意它与 `itemId` 前缀 `ctrl.custom.N` **不是一回事**：那个说的是"这个控件由院内自建"
 * （相对于随产品分发的 `ctrl.std.*`），与语义类型相互独立 ——
 * 自建控件完全可以标成 `vitalSignsChart`，随产品分发的控件也可以标成 `custom`。
 */
export type ControlKind = 'menstrualHistory' | 'odontogram' | 'vitalSignsChart' | 'scaleScore' | 'labTrend' | 'custom';

/**
 * 专科控件的**形状**：**闭集**。
 *
 * 为什么是闭集、而不是让院方画界面：形状决定渲染器，而渲染器是**代码**。
 * 加一个形状要发一版；而"控件很多"这件事发生在**数据**里 —— 各种评分量表都是
 * `scale` 换一套字段，各种趋势都是 `series` 换一组数值字段。
 * 于是代码里只有几个形状，包里可以有几百个控件。
 *
 * 为什么它定义在**模型层**而不是模板层（原先在 `template/types.ts`）：
 * `ControlNode.shape` 要带着它进文档 —— 渲染器是纯函数，医生端、管理端预览、
 * 导入与导出**都拿不到包**（与 `ControlNode.fields` 那条理由一模一样）。
 * 而模型层不能反过来依赖模板层，所以形状与它的白名单落在最低那一层。
 *
 * `image`（影像）与其余四种的差别只有一条：**它的格子值是一条资源引用**（`text`），
 * 而不是一个可计算的量。之所以仍做成"形状"而不是新加一种 `FieldDataType`：
 * 决定画法的从来是形状，"这一格画成一张图"与"这一格画成一个输入框"是同级的差别；
 * 而字段类型是**机器真值的类型**（数值 / 日期 / 布尔），加一个 `image` 进去，
 * 等于让 `matchesFieldType` / 机读摊平 / 导入映射都要多认一种谁都算不出来的值。
 */
export type ControlShape = 'scale' | 'series' | 'matrix' | 'checklist' | 'image';

/**
 * 形状白名单（**校验用的那一份**）。
 *
 * 为什么类型之外还要有它：类型只在编译期存在，而包是**外部数据**（见 `knowledge/pack.ts`
 * 的"读失败绝不静默降级"），装包那一刻必须能拿一个数组去比 —— 与 `SLOT_KINDS` /
 * `FIELD_TYPES` 同一纪律：白名单只有一处，新增形状时改这里并补用例。
 */
export const CONTROL_SHAPES: readonly ControlShape[] = ['scale', 'series', 'matrix', 'checklist', 'image'];

/**
 * 专科控件里的一个字段（**实例侧的快照**）。
 *
 * 它是"这个控件里有哪些格、各自是什么"的声明，**随实例抄进节点**（见 `ControlNode.fields`）。
 * 字段的取值类型、单位、参考范围、取值域都复用 `FieldNode` 那一套 ——
 * 控件不是新的一套词汇，只是把一组字段装进一个格子里。
 */
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
   * 机读摊平用：**给了 tag 的字段才会产出数据元**（与 `FieldNode.tags` 同一个概念）。
   * 不绑 tag 的字段只给人看 —— 这是"这个控件能不能被机器读懂"的分水岭。
   */
  tag?: DataElementTag;
  /**
   * `series` 形状：哪一格是**时间轴**（趋势按它排序；整份控件只能有一格标它）。
   *
   * 它属于"声明"而不是"可执行内容"，所以与其它字段一起抄进节点 ——
   * 渲染趋势时不回查包也能知道"按哪一格排"。
   */
  axis?: 'time';
}

export interface ControlNode extends NodeBase {
  type: 'control';
  controlKind: ControlKind;
  /**
   * 形状：**渲染器按它分派**，所以它必须随节点走。
   *
   * 与下面 `fields` 是同一条纪律（那三条理由一字不改地适用于形状）：
   * 渲染、预览、导入、导出都拿不到包，靠回查包才知道"这一条该画成量表还是趋势图"，
   * 这条路走不通。
   */
  shape: ControlShape;
  /** `matrix` 的行 / 列标签：网格靠它们画出来（格的键怎么算见 `payload` 的注释） */
  rows?: Array<{ key: string; label: string }>;
  columns?: Array<{ key: string; label: string }>;
  /** `scale` 的排布（每行几格 / 满分多少）：**只影响画法**，不改变数据结构 */
  layout?: { columns?: number; maxPoints?: number };
  /** `series` 的记录行数：模板给几行就让医生填几条（趋势至少要两行才画得出变化） */
  rowCount?: number;
  /** 控件定义（包内 `ControlDefinition.itemId`）：溯源用，回答"这一版是按哪份定义开的" */
  definitionId?: string;
  /** 快照与 payload 按定义的哪一版生成（定义改了字段语义就要升版，见模板层） */
  payloadVersion?: number;
  /**
   * 字段快照：**抄进节点，而不是回查模板包**。三条理由缺一不可：
   *
   *   1. **机读派生是纯函数**：`buildMachineReadable` 在导入、会话、导出、演示服务里
   *      被各自调用，那些地方都拿不到包 —— 要靠包才能摊平数据元，这条路就走不通；
   *   2. **打开文书的人可能要 label 与单位**，而文档可能在定义升版、控件被停用之后才被打开；
   *   3. **历史病历必须永远解释得清**：靠回查包的话，一次定义升级就会让旧 payload
   *      变成"一堆读不懂的键"。
   *
   * 快照里**只有声明**（没有公式、没有可执行内容），与"派生值带出处与公式、但不带表达式树"
   * （K6）是同一条纪律。
   */
  fields?: ControlFieldSnapshot[];
  /**
   * 填进去的值。键的规则由**形状**决定，且**只有一处定义**（`model/control.ts` 的
   * `controlCellKey` —— 写路径、渲染器、机读摊平都从那里取；各拼一遍迟早对不上，
   * 而对不上的症状是"医生填的值在导出里凭空不见"）：
   *
   *   - `scale` / `checklist`：`payload[字段key]`；
   *   - `series`：`payload[字段key.rN]`（N 从 1 起，第 N 条记录）；
   *   - `matrix`：`payload[r行key.c列key]`。
   *
   * **没填过的格不存在这个键**（不写 null）："空着"与"填了个空字符串"是两件事，
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

/* ------------------------------- 机读信息 ------------------------------- */

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

/* --------------------------------- 留痕 --------------------------------- */

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
  /**
   * **解锁已签章文档**（把 `status` 从 `signed` 退回 `draft`，使内容可继续修改）。
   *
   * 为什么不复用 `update`：它改的是**文档级状态**而不是节点内容，而且它是"已签章文档不可改"
   * 那条禁令唯一的例外 —— 复用 `update` 会让审计分不清"改了一个字段"和"作废了一次签章"。
   * 它的载荷（`RevisionEntry.unlock`）必须记下**被作废的那次签章**与理由。
   */
  | 'unlock'
  /**
   * **撤销**某一次写入（以新 rev 回滚，不篡改历史）。
   *
   * 与 `unlock` 同理必须单独一个 op：撤销不改"内容是怎么来的"，它改的是"哪一次变更被退回了"，
   * 载荷 `RevisionEntry.revert.revertedRev` 指回被撤销的那条留痕，两者靠它关联。
   */
  | 'revert'
  /**
   * 系统取数（从 LIS/HIS 等搬移**确定性数据**）。
   *
   * 为什么必须单独一个 op，而不是复用 `update` 或 `import`：
   *   1) 复用 `update` 会**立刻**踩坑 —— `update` 在"编辑即确认"白名单里，
   *      系统带入的内容会被自动标成"医生已确认"，与本该有的"待核对"语义正好相反；
   *   2) 复用 `import` 会与"文件导入"混淆，审计上分不清"从 LIS 搬来一个值"
   *      和"导入了一份别人的病历"。
   * 它属于**变更类** op（必须带 patch），且**不在**"编辑即确认"白名单里。
   */
  | 'external';

export interface PatchOp {
  op: 'add' | 'remove' | 'replace';
  path: string;
  value?: JsonValue;
  /**
   * 该路径**改动前**的值（`replace` / `remove` 时给出）。
   *
   * 为什么必须有：JSON Patch 的 `replace` 只带新值 —— 于是"改前是什么"事后谁也答不出来，
   * 而审计与纠纷举证要的恰恰是这一句（今天的留痕只能回答"哪个节点变了"，靠 `before/afterHash` 兜底）。
   * 顺带它也让留痕**理论上可反向重放**，这是将来做 `revertTo(rev)` 的前提。
   *
   * 代价如实说：留痕体积会变大（每个 replace 多存一份旧值，文本节点的粒度为整段字符串）。
   */
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
  /**
   * 本次操作覆盖的**建议范围**（批量 / 组级采纳或拒绝时给出）。
   *
   * 与 `confirmedNodeIds` 同一条理由：批量把"点 N 次"变成"点 1 次"，
   * 若留痕只记 `aiSuggestionId`（第一条），事后就**无法回答"他当时处理了哪一批"**——
   * 那又是用可追溯性换便利性。
   *
   * 只记录**真正落笔/被拒**的条目：被门控拦下的条目**不进留痕** ——
   * 它们仍处于待处理状态（pending）、本身就查得到，写进文档留痕会让
   * "没有发生的变更"出现在变更记录里。
   */
  aiSuggestionIds?: string[];
  modelId?: string;
  confidence?: number;
  beforeHash?: string;
  afterHash?: string;
  /**
   * 本次操作覆盖的**确认范围**（批量确认 / 子树确认时给出）。
   *
   * 为什么必须有这个字段：批量确认把"点 N 次"变成"点 1 次"。若留痕里只记录 targets[0]，
   * 事后就**无法回答"他当时到底确认了哪些内容"** —— 那等于用可追溯性换便利性，不划算。
   * 有了它，才能既让医生少点，又能逐条追责。
   */
  confirmedNodeIds?: NodeId[];
  /**
   * 签章时"已知但未逐条确认"的 AI / 导入内容清单。
   *
   * 这不是豁免，而是**把责任显式落到签名人身上**：签名有效，但记录里清楚写着
   * "哪些内容没有逐条点过确认"。没有它，分级放行就等于静默放行 ——
   * 那才是真正危险的做法。
   */
  acknowledgedUnconfirmed?: { ai: NodeId[]; imported: NodeId[] };
  /**
   * 解锁已签章文档：**作废了哪一次签章、为什么**。
   *
   * 为什么必须记"被作废的那次签章"：解锁后原签名材料仍留在 `signatureRefs` 里（不删历史），
   * 但改了内容之后验签必然失败 —— 届时界面得能回答"为什么失败"。
   * 答案就在这里：不是被篡改，而是被一次有理由、有责任人的解锁动作作废了。
   */
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

/**
 * 签名引用（T18 起承载**真实签名值**）。
 *
 * 老字段（signatureRef/signerRole/covers 等）继续保留：它们是"签章动作"的元数据；
 * 新增字段是密码学材料，**成组出现**（要么都有，要么都没有 —— 由校验强制）：
 * 只有元数据而没有签名值的"签章"是最危险的产物：看起来已签，实际不可验证。
 */
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

/* --------------------------------- 文档 --------------------------------- */

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

/* --------------------------------- 校验 --------------------------------- */

/** 语义规则码（与工具链 S5 完全一致，跨实现必须同名） */
export const SEMANTIC_CODES = {
  E_NODE_ID_DUP: 'E_NODE_ID_DUP',
  E_PARENT_MISSING: 'E_PARENT_MISSING',
  E_ORPHAN_NODE: 'E_ORPHAN_NODE',
  E_AI_NO_PROVENANCE: 'E_AI_NO_PROVENANCE',
  E_AI_LOW_CONFIDENCE_UNCONFIRMED: 'E_AI_LOW_CONFIDENCE_UNCONFIRMED',
  E_KEY_CONTENT_UNCONFIRMED: 'E_KEY_CONTENT_UNCONFIRMED',
  /** 机器绑上的数据元标签未经人工确认就进入 signed/archived —— 与"关键内容未确认"同档：**永远阻断** */
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
