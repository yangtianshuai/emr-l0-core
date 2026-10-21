import type { ControlFieldSnapshot, ControlKind, ControlShape, DataElementTag, DocTypeRef, FieldDataType, JsonValue } from '../model/types.ts';
import type { Pack, PackItemBase } from '../knowledge/pack.ts';

export type ExprValue = number | string;

export type ExprNode =
  | { kind: 'num'; value: number }
  | { kind: 'slot'; key: string }
  | { kind: 'ctx'; key: string }
  | { kind: 'fn'; name: string; args: ExprNode[] };

export type ReferenceRange = { low?: number; high?: number; text?: string; unit?: string };

export type TemplateSlot =
  | {
      slot: 'text';
      key: string;
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
      columns: TemplateTableColumn[];
      rows?: number;
      newParagraph?: boolean;
    }
  | {
      slot: 'list';
      key: string;
      items: TemplateListItem[];
      ordered?: boolean;
      newParagraph?: boolean;
    }
  | {
      slot: 'control';
      key: string;
      useControl: string;
      rows?: number;
      keyContent?: boolean;
      newParagraph?: boolean;
    }
  | {
      slot: 'paragraph';
      key: string;
      keyContent?: boolean;
      newParagraph?: boolean;
    }
  | {
      slot: 'image';
      key: string;
      resRef?: string;
      altText?: string;
      caption?: string;
      newParagraph?: boolean;
    };

export interface TemplateListItem {
  text: string;
  field?: {
    dataType: FieldDataType;
    unit?: string;
    tags?: DataElementTag[];
  };
}

export interface TemplateTableColumn {
  title: string;
  dataType?: FieldDataType;
  unit?: string;
  tags?: DataElementTag[];
}

export interface TemplateSection {
  sectionCode: string;
  title: string;
  slots: TemplateSlot[];
  required?: boolean;
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

export interface ExpressionDefinition extends PackItemBase {
  itemType: 'expression';
  itemId: string;
  name: string;
  unit?: string;
  expression: ExprNode;
  description?: string;
}

export interface FragmentDefinition extends PackItemBase {
  itemType: 'fragment';
  itemId: string;
  name: string;
  sections: TemplateSection[];
  description?: string;
}

export type { ControlShape } from '../model/types.ts';
export { CONTROL_SHAPES } from '../model/types.ts';

export interface ControlFieldDef extends ControlFieldSnapshot {
  useExpression?: string;
  axis?: 'time';
  defaultValue?: JsonValue;
}

export interface ControlDefinition extends PackItemBase {
  itemType: 'control';
  itemId: string;
  name: string;
  controlKind: ControlKind;
  shape: ControlShape;
  version?: number;
  fields: ControlFieldDef[];
  rows?: Array<{ key: string; label: string }>;
  columns?: Array<{ key: string; label: string }>;
  layout?: { columns?: number; maxPoints?: number };
  description?: string;
  code?: { system: string; code: string; display?: string };
}

export type TemplatePackItem = TemplateDefinition | ExpressionDefinition | FragmentDefinition | ControlDefinition;

export type TemplatePack = Pack<TemplatePackItem>;

export interface TemplateContext {
  [path: string]: ExprValue | undefined;
}

export interface InstantiateInput {
  templateId: string;
  docId: string;
  createdBy: string;
  patient: { patientId: string; nameMasked?: string; gender?: 'M' | 'F' | 'U'; birthDate?: string };
  encounter?: { visitId?: string; visitType?: 'outpatient' | 'inpatient' | 'emergency' | 'physical-exam'; deptCode?: string; admittedAt?: string; dischargedAt?: string };
  doctor?: { actorId?: string };
  /** 实例化时间（ISO8601）：必须由调用方给，否则同一次实例化两次跑出来的时间戳不同  */
  at: string;
  context?: TemplateContext;
}

export interface InstantiateResult {
  templateId: string;
  source: string;
  slots: Record<string, string>;
  warnings: string[];
}
