// 模板体系 · 类型定义（K4）。

import type { ControlFieldSnapshot, ControlKind, ControlShape, DataElementTag, DocTypeRef, FieldDataType, JsonValue } from '../model/types.ts';
import type { Pack, PackItemBase } from '../knowledge/pack.ts';

/**
 * 表达式的值。刻意只有数字与字符串两类：
 *   - 数字覆盖全部计量与评分；
 *   - 字符串只用于日期（ISO8601），因为孕周/年龄这类"控件"必须由两个日期相减得到。
 * 布尔与枚举不进表达式：它们没有可计算的语义，混进来只会让求值规则变得不可解释。
  */
export type ExprValue = number | string;

export type ExprNode =
  | { kind: 'num'; value: number }
  /** 引用同一模板内的填写项（field 槽位），按 `key` 找  */
  | { kind: 'slot'; key: string }
  /** 引用实例化上下文（患者/就诊/时间），按点路径找，如 `patient.nameMasked` */
  | { kind: 'ctx'; key: string }
  | { kind: 'fn'; name: string; args: ExprNode[] };

export type ReferenceRange = { low?: number; high?: number; text?: string; unit?: string };

/**
 * 模板槽位：实例化后对应文档里的一个节点。
 *
 * `key` 是模板内的唯一名字，不是节点 id（节点 id 由引擎生成）。表达式靠它引用填写项。
  */
export type TemplateSlot =
  | {
      slot: 'text';
      key: string;
      /** 结构文本或占位提示；`{{ctx.path}}` 会被上下文替换，替换不到就原样保留并告警  */
      text?: string;
      tags?: DataElementTag[];
      keyContent?: boolean;
      /** 强制另起一段（默认：text 槽位本来就会另起一段） */
      newParagraph?: boolean;
    }
  | {
      slot: 'field';
      key: string;
      dataType: FieldDataType;
      /** 模板可给一个默认值（如就诊日期）；不给就是空待填 */
      value?: JsonValue;
      unit?: string;
      /** 从上下文取值的点路径（如 `encounter.admittedAt`）；取不到就是空待填 */
      from?: string;
      tags?: DataElementTag[];
      keyContent?: boolean;
      required?: boolean;
      referenceRange?: ReferenceRange;
      newParagraph?: boolean;
    }
  | {
      slot: 'expression';
      key: string;
      /** 引用本包医学表达式控件库里的一个控件（`ExpressionDefinition.itemId`）  */
      useExpression: string;
      tags?: DataElementTag[];
      keyContent?: boolean;
      /** 覆盖控件默认单位（同一控件在不同文书里单位可能不同） */
      unit?: string;
      newParagraph?: boolean;
    }
  | {
      slot: 'table';
      key: string;
      /** 表头各列（列名即表头单元格的文本），至少一列  */
      columns: TemplateTableColumn[];
      /** 数据行数（模板给几行空行让医生填）。不写 = 1 行 */
      rows?: number;
      /**
       *  表格没有 `tags` / `keyContent`，这是有意的：
       *
       *   - `keyContent` 的含义是"未人工确认就签不出去"。它要求节点有一个确认动作，
       *     而医生端只在文本 / 填写项上有「确认内容」按钮 —— 给表格标上它，等于造一份
       *     签不出去的病历（门控拦得住，人却不知道去哪儿确认）。
       *     表格里的格子是填写项，要标关键内容应在列上给（本版尚未开放）。
       *   - 表格不是数据元：机器读的是格子里的填写项（每个格子是一个 field 节点），
       *     给表格整体绑一个 tag 只会造出一条值为空、来源不明的数据元。
        */
      newParagraph?: boolean;
    }
  | {
      /**
       * 列表：产出 `listGroup` → 每项一个 `listItem`（里面一句 `text`，末尾可选一个 `field`）。
       *
       * 与表格同一族：它也是块级内容（必然另起一段），并且同样
       * 不绑数据元、不标关键内容 —— 机器读的是填写项，而医生端没有
       * "确认这一整条列表"的动作，标上它就是一份签不出去、也无处确认的病历。
       *
       * 每一项可以是"纯文字"，也可以带一个格子（`field`）：后者才是数据元的来源
       * （"体温 ____ ℃"）。这与表格的列完全同构 —— 列表不产数据元，格子才产。
        */
      slot: 'list';
      key: string;
      /** 列表项（至少一项） */
      items: TemplateListItem[];
      /** 有序 = 编号（`1. ` / `2. `）；缺省 = 圆点 */
      ordered?: boolean;
      newParagraph?: boolean;
    }
  | {
      slot: 'control';
      key: string;
      /** 引用本包专科控件库里的一个控件（`ControlDefinition.itemId`）  */
      useControl: string;
      rows?: number;
      keyContent?: boolean;
      newParagraph?: boolean;
    }
  | {
      slot: 'paragraph';
      key: string;
      keyContent?: boolean;
      /** 只有手写包才会带：段落本来就另起一段，这里原样透传，不在界面上给勾选框 */
      newParagraph?: boolean;
    }
  | {
      slot: 'image';
      key: string;
      /** 图片地址。留空（推荐）= 待贴的空槽；填了就固定引用那个资源 */
      resRef?: string;
      /** 医生端的提示（也是空槽上画出来的那行字），如「胸部 CT 正位」 */
      altText?: string;
      /** 图注：排在图下方。`{{ctx.path}}` 会被上下文替换 */
      caption?: string;
      newParagraph?: boolean;
    };

export interface TemplateListItem {
  /** 这一项的文字（可含 `{{ctx.path}}`） */
  text: string;
  /**
   * 这一项末尾的填写项。给了就在 `listItem` 下再生成一个 `field` 节点，
   * 与表格格子同一套（`dataType` / `unit` / `tags`）。
   *
   *  仍然没有 `keyContent`：医生端列表项里只有一个输入框，没有"确认这一项"的动作。
    */
  field?: {
    dataType: FieldDataType;
    unit?: string;
    tags?: DataElementTag[];
  };
}

export interface TemplateTableColumn {
  /** 列名：它就是表头格子里那行字 */
  title: string;
  /** 这一列的值类型；不写 = text */
  dataType?: FieldDataType;
  /** 这一列的单位（如 mmHg）；不写 = 无单位 */
  unit?: string;
  /**
   * 这一列绑的数据元（如 WS445 / DE05.01.001 / 体温）。
   *
   * 标签落在格子里的填写项上，不是表格上：表格只是容器，机器读的是一格一格的值。
   * 同一列的多行共用同一条标签 —— "这一列是体温"这件事与第几行无关，
   * 而 `code` 保持一致正是跨文书比对要的（同一个数据元在不同文书里认得出是同一个）。
   *
   *  列上仍没有 `keyContent`：格子是填写项没错，但医生端表格里的格子只有一个输入框，
   * 没有"确认这一格"的动作 —— 标上去等于造一份签不出去、也无处确认的病历。
    */
  tags?: DataElementTag[];
}

export interface TemplateSection {
  /** 章节编码（如 `chiefComplaint`）。写进 `sectionCode`，是跨文书比对的锚点之一 */
  sectionCode: string;
  title: string;
  slots: TemplateSlot[];
  required?: boolean;
  /**
   * 章节级关键内容：这一章整体按关键内容对待。
   *
   * 与槽位级 `keyContent` 的关系：槽位级管"这一格"，章节级管"这一章"。
   * 两者都抄进文档的 `keyContent`（章节节点自身也允许标），
   * 于是"关键内容未人工确认不得签章"那条门对整章同样成立。
    */
  keyContent?: boolean;
  description?: string;
}

export interface TemplateDefinition extends PackItemBase {
  itemType: 'template';
  itemId: string;
  name: string;
  docType: DocTypeRef;
  sections: TemplateSection[];
  departments?: string[];
  status?: 'draft' | 'active';
  description?: string;
}

/**
 * 医学表达式控件（K4 要求 ≥5 个）。
 *
 * 它是可复用的：模板用 `useExpression` 引用它，于是"体质指数怎么算"只定义一次、
 * 全院的文书都引用同一份定义。控件库里改了公式，所有引用它的模板同时生效 ——
 * 这正是"知识资产"与"写死在一份表单里"的区别。
  */
export interface ExpressionDefinition extends PackItemBase {
  itemType: 'expression';
  /** 如 `expr.bmi` */
  itemId: string;
  name: string;
  unit?: string;
  expression: ExprNode;
  description?: string;
}

export interface FragmentDefinition extends PackItemBase {
  itemType: 'fragment';
  /** 如 `frag.custom.1` */
  itemId: string;
  name: string;
  /** 片段内容：一串章节，顺序即插入顺序 */
  sections: TemplateSection[];
  /** 说明：这个片段什么时候用、给谁用 */
  description?: string;
}

export type { ControlShape } from '../model/types.ts';
export { CONTROL_SHAPES } from '../model/types.ts';

export interface ControlFieldDef extends ControlFieldSnapshot {
  useExpression?: string;
  /** `series` 形状：哪个字段是时间轴（趋势按它排序） */
  axis?: 'time';
  /** 开文书时的初值。模板给的是骨架，不编临床内容 —— 只用来填"新病人也算得出来"那种默认值  */
  defaultValue?: JsonValue;
}

export interface ControlDefinition extends PackItemBase {
  itemType: 'control';
  /** `ctrl.std.*`（随产品）/ `ctrl.custom.N`（院内自建） */
  itemId: string;
  name: string;
  /** 语义类型：质控条件与机读分类按它问"这是什么控件"（沿用既有六个取值） */
  controlKind: ControlKind;
  shape: ControlShape;
  /**
   * 定义版本，缺省 1。
   *
   * 改了字段语义就必须升版，绝不原地改：已开出的病历里存的是当时那份字段快照，
   * 原地改会让"同一份 payload 在两次导出里被解读成两种意思"。
    */
  version?: number;
  fields: ControlFieldDef[];
  /** `matrix` 形状的行（如 32 颗牙）；其它形状不给 */
  rows?: Array<{ key: string; label: string }>;
  /** `matrix` 形状的列（如 龋 / 充填 / 缺失） */
  columns?: Array<{ key: string; label: string }>;
  layout?: { columns?: number; maxPoints?: number };
  description?: string;
  /** 跨院识别：机身之外的那一层（同 name 不同 code 的两份控件是两件事） */
  code?: { system: string; code: string; display?: string };
}

export type TemplatePackItem = TemplateDefinition | ExpressionDefinition | FragmentDefinition | ControlDefinition;

/**
 * 模板包。与规则包走同一套通用层（清单校验 / 契约匹配 / 冲突 / 开关 / 指纹），
 * 差别只在条目形状 —— 这正是把"包"抽成类别无关那一层的收益。
  */
export type TemplatePack = Pack<TemplatePackItem>;

/**
 * 上下文：表达式 `ctx:` 与文本占位符 `{{...}}` 的取值来源。
 * 全部是标量 —— 上下文里的东西要么是"事实"（患者、就诊、时间），要么没有。
 */
export interface TemplateContext {
  [path: string]: ExprValue | undefined;
}

export interface InstantiateInput {
  templateId: string;
  docId: string;
  createdBy: string;
  patient: { patientId: string; nameMasked?: string; gender?: 'M' | 'F' | 'U'; birthDate?: string };
  encounter?: { visitId?: string; visitType?: 'outpatient' | 'inpatient' | 'emergency' | 'physical-exam'; deptCode?: string; admittedAt?: string; dischargedAt?: string };
  /**
   * 开单医生。
   *
   * 只有账号（`actorId`），没有姓名：本系统的账号里就没有姓名字段
   * （`auth/user-store.ts` 的 `AdminUser`）。给一个取不到值的 `doctor.name`，
   * 表现是"这一格一直空着"，而人会以为是模板配错了。
    */
  doctor?: { actorId?: string };
  /** 实例化时间（ISO8601）：必须由调用方给，否则同一次实例化两次跑出来的时间戳不同  */
  at: string;
  /**
   * 覆盖/补充上下文（优先级高于由 patient/encounter/doctor/at 派生的默认值）。
   *
   * 用途是那些引擎自己查不到的上下文：`encounter.deptName` 要靠科室字典翻译，
   * 而字典在库侧、不在模板引擎手里（引擎只管"把给它的值填进去"）。
    */
  context?: TemplateContext;
}

/** 实例化产物：一份待医生填写的草稿 + 如实上报的告警  */
export interface InstantiateResult {
  templateId: string;
  /** 产出处的出处标识（包#模板@内容指纹）—— 写进每个节点的 evidence */
  source: string;
  /** 槽位 key → 生成的节点 id（便于后续"按槽位定位"，如把外部数据填回某个数据元） */
  slots: Record<string, string>;
  warnings: string[];
}
