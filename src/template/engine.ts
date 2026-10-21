import {
  SCHEMA_VERSION,
  TAG_SYSTEMS,
  type DocNode,
  type DocumentModel,
  type FieldDataType,
  type JsonValue,
  type NodeId,
  type TagSystem,
} from '../model/types.ts';
import { collectExpressionRefs, describeExpression, evaluate, validateExpression } from './expression.ts';
import { SERIES_DEFAULT_ROWS } from '../model/control.ts';
import { packFingerprintOf } from '../knowledge/pack.ts';
import { CONTROL_SHAPES } from './types.ts';
import type {
  ControlDefinition,
  ExpressionDefinition,
  FragmentDefinition,
  InstantiateInput,
  InstantiateResult,
  TemplateDefinition,
  TemplatePack,
  TemplateSection,
  TemplateSlot,
} from './types.ts';

export const TEMPLATE_ENGINE_ACTOR = 'template-engine';

/** 文档类型可用的取值（与 `model/validate.ts` 的白名单一致；两处漂移会让产物校验失败） */
const DOC_TYPE_SYSTEMS = ['WST500', 'WS445', 'local', 'custom'];
const FIELD_TYPES: FieldDataType[] = ['text', 'number', 'date', 'code', 'boolean', 'expression'];
const SLOT_KINDS: string[] = ['text', 'paragraph', 'field', 'expression', 'table', 'list', 'control', 'image'];
const REFERENCE_RANGE_KEYS = ['low', 'high', 'text', 'unit'];
const CONTROL_KINDS = ['menstrualHistory', 'odontogram', 'vitalSignsChart', 'scaleScore', 'labTrend', 'custom'];

export interface ContextField {
  path: string;
  label: string;
  group: '患者' | '就诊' | '医生' | '时间';
}

export const CONTEXT_FIELDS: readonly ContextField[] = [
  { path: 'patient.patientId', label: '患者 ID', group: '患者' },
  { path: 'patient.nameMasked', label: '患者姓名（掩码）', group: '患者' },
  { path: 'patient.gender', label: '性别', group: '患者' },
  { path: 'patient.birthDate', label: '出生日期', group: '患者' },
  { path: 'encounter.visitId', label: '就诊号', group: '就诊' },
  { path: 'encounter.visitType', label: '就诊类型', group: '就诊' },
  { path: 'encounter.deptCode', label: '就诊科室（编码）', group: '就诊' },
  { path: 'encounter.deptName', label: '就诊科室（名称）', group: '就诊' },
  { path: 'encounter.admittedAt', label: '入院/就诊时间', group: '就诊' },
  { path: 'encounter.dischargedAt', label: '出院时间', group: '就诊' },
  { path: 'doctor.actorId', label: '开单医生（账号）', group: '医生' },
  { path: 'now', label: '当前时间', group: '时间' },
];

export const KNOWN_CONTEXT_PATHS: readonly string[] = CONTEXT_FIELDS.map((field) => field.path);

export type TemplateErrorCode =
  | 'E_TPL_PACK_INVALID'
  | 'E_TPL_TEMPLATE_UNKNOWN'
  | 'E_TPL_ITEM_NOT_FOUND'
  | 'E_TPL_ITEM_NOT_TEMPLATE'
  | 'E_TPL_FIELD_INVALID'
  | 'E_TPL_STATUS_PUBLISHED'
  | 'E_TPL_DEPT_UNKNOWN'
  | 'E_TPL_EXPR_IN_USE'
  | 'E_TPL_EXPR_UNKNOWN'
  | 'E_TPL_ITEM_TYPE'
  | 'E_TPL_DOC_TYPE_INVALID'
  | 'E_TPL_SECTION_INVALID'
  | 'E_TPL_SLOT_INVALID'
  | 'E_TPL_SLOT_NOT_FOUND'
  | 'E_TPL_SLOT_KEY_DUPLICATE'
  | 'E_TPL_EXPR_INVALID'
  | 'E_TPL_EXPR_REF_INVALID'
  | 'E_TPL_CONTROL_UNKNOWN'
  | 'E_TPL_CTX_UNKNOWN';

export class TemplateError extends Error {
  code: TemplateErrorCode;

  constructor(code: TemplateErrorCode, message: string) {
    super(message);
    this.name = 'TemplateError';
    this.code = code;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 默认值写成 JSON 的样子（报错里要能看见"到底给了什么"，而不是只说"类型不对"） */
function describeValue(value: JsonValue): string {
  const text = JSON.stringify(value);
  if (text === undefined) return `「${String(value)}」`;
  return text.length > 40 ? `「${text.slice(0, 40)}…」` : `「${text}」`;
}

/** 表格的规模上限：超过这个数，窄屏与打印页上这张表就已经读不了了 */
const TABLE_MAX_COLUMNS = 8;
const TABLE_MAX_ROWS = 20;

const TABLE_COLUMN_TYPES: FieldDataType[] = FIELD_TYPES.filter((type) => type !== 'expression');

function validateDataElementTags(raw: unknown, label: string): string[] {
  const issues: string[] = [];
  if (!Array.isArray(raw) || raw.length === 0) {
    issues.push(`${label}：要绑数据元就给非空数组（不绑就删掉这个字段：空数组会让"回退到槽位名"这条规则失效）`);
    return issues;
  }
  (raw as unknown[]).forEach((tag, tagIndex) => {
    const tagLabel = `${label}[${tagIndex}]`;
    if (!isPlainObject(tag)) {
      issues.push(`${tagLabel}：必须是对象（system / code / display）`);
      return;
    }
    const record = tag as Record<string, unknown>;
    if (!TAG_SYSTEMS.includes(String(record.system) as TagSystem)) {
      issues.push(`${tagLabel}.system：取值非法「${String(record.system)}」（允许 ${TAG_SYSTEMS.join('/')}）`);
    }
    if (typeof record.code !== 'string' || record.code.trim() === '') {
      issues.push(`${tagLabel}.code：必须是非空字符串`);
    }
    if (record.display !== undefined && (typeof record.display !== 'string' || record.display.trim() === '')) {
      issues.push(`${tagLabel}.display：给了就得是非空字符串（空显示名与"不写"同义，会让界面回退成槽位名）`);
    }
  });
  return issues;
}

function validateTableColumns(columns: unknown, rows: unknown, label: string): string[] {
  const issues: string[] = [];
  if (!Array.isArray(columns) || columns.length === 0) {
    issues.push(`${label}.columns：至少要有一列（没有列的表产不出任何格子）`);
    return issues;
  }
  if (columns.length > TABLE_MAX_COLUMNS) {
    issues.push(`${label}.columns：最多 ${TABLE_MAX_COLUMNS} 列（实际 ${columns.length} 列）`);
  }
  columns.forEach((column, index) => {
    const columnLabel = `${label}.columns[${index}]`;
    if (!isPlainObject(column)) {
      issues.push(`${columnLabel}：必须是对象（title / dataType / unit）`);
      return;
    }
    const record = column as Record<string, unknown>;
    if (typeof record.title !== 'string' || record.title.trim() === '') {
      issues.push(`${columnLabel}.title：列名必须是非空字符串（它就是表头格子里那行字）`);
    }
    if (record.dataType !== undefined && !TABLE_COLUMN_TYPES.includes(record.dataType as FieldDataType)) {
      issues.push(
        `${columnLabel}.dataType：取值非法「${String(record.dataType)}」（允许 ${TABLE_COLUMN_TYPES.join('/')}）`
          + '；派生值列不属于表格能表达的东西（公式要引用具体格子，而格子会随行数增减）',
      );
    }
    if (record.unit !== undefined && (typeof record.unit !== 'string' || record.unit.trim() === '')) {
      issues.push(`${columnLabel}.unit：给了就得是非空字符串（不给就删掉这个键）`);
    }
    if (record.tags !== undefined) {
      issues.push(...validateDataElementTags(record.tags, `${columnLabel}.tags`));
    }
  });
  if (rows !== undefined && (!Number.isInteger(rows) || (rows as number) < 1 || (rows as number) > TABLE_MAX_ROWS)) {
    issues.push(`${label}.rows：必须是 1~${TABLE_MAX_ROWS} 的整数（实际 ${String(rows)}）`);
  }
  return issues;
}

/** 列表最多几项：再长就该是一张表了；上限只是为了让界面与纸面不至于失控 */
const LIST_MAX_ITEMS = 50;

function validateListItems(items: unknown, label: string): string[] {
  const issues: string[] = [];
  if (!Array.isArray(items) || items.length === 0) {
    issues.push(`${label}.items：至少要有一项（没有项的列表什么都不产出）`);
    return issues;
  }
  if (items.length > LIST_MAX_ITEMS) {
    issues.push(`${label}.items：最多 ${LIST_MAX_ITEMS} 项（实际 ${items.length} 项）`);
  }
  items.forEach((item, index) => {
    const itemLabel = `${label}.items[${index}]`;
    if (!isPlainObject(item)) {
      issues.push(`${itemLabel}：必须是对象（text 必有；要格子就再加 field）—— 列表项不再接受"一个字符串"的旧写法`);
      return;
    }
    const record = item as Record<string, unknown>;
    if (typeof record.text !== 'string' || record.text.trim() === '') {
      issues.push(`${itemLabel}.text：必须是非空字符串（空项在纸面上会被丢掉，屏幕与归档件就对不上）`);
    }
    if (record.field === undefined) return;
    if (!isPlainObject(record.field)) {
      issues.push(`${itemLabel}.field：必须是对象（dataType 必填，可带 unit / tags）`);
      return;
    }
    const field = record.field as Record<string, unknown>;
    if (!TABLE_COLUMN_TYPES.includes(field.dataType as FieldDataType)) {
      issues.push(
        `${itemLabel}.field.dataType：取值非法「${String(field.dataType)}」（允许 ${TABLE_COLUMN_TYPES.join('/')}）`
          + '；派生值不属于列表项能表达的东西（公式要引用具体格子，而行会增删）',
      );
    }
    if (field.unit !== undefined && (typeof field.unit !== 'string' || field.unit.trim() === '')) {
      issues.push(`${itemLabel}.field.unit：给了就得是非空字符串（不给就删掉这个键）`);
    }
    if (field.tags !== undefined) {
      issues.push(...validateDataElementTags(field.tags, `${itemLabel}.field.tags`));
    }
  });
  return issues;
}

function matchesFieldType(dataType: FieldDataType, value: JsonValue): boolean {
  if (value === null) return true;
  switch (dataType) {
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'expression':
      return typeof value === 'number' || typeof value === 'string';
    default:
      return typeof value === 'string';
  }
}

function validateReferenceRange(range: unknown, label: string): string[] {
  const issues: string[] = [];
  if (!isPlainObject(range)) {
    issues.push(`${label}：必须是对象（low / high / text / unit）`);
    return issues;
  }
  for (const key of Object.keys(range)) {
    if (!REFERENCE_RANGE_KEYS.includes(key)) {
      issues.push(`${label}.${key}：不认识的键（只支持 ${REFERENCE_RANGE_KEYS.join(' / ')}）`);
    }
  }
  for (const key of ['low', 'high']) {
    const value = range[key];
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) {
      issues.push(`${label}.${key}：必须是一个有限的数字（给不出数字的范围用 text，如"阴性"）`);
    }
  }
  for (const key of ['text', 'unit']) {
    const value = range[key];
    if (value !== undefined && (typeof value !== 'string' || value.trim() === '')) {
      issues.push(`${label}.${key}：给了就得是非空字符串（不给就删掉这个键）`);
    }
  }
  const low = typeof range.low === 'number' ? range.low : undefined;
  const high = typeof range.high === 'number' ? range.high : undefined;
  if (low !== undefined && high !== undefined && low > high) {
    issues.push(`${label}：下限 ${low} 大于上限 ${high}（颠倒会让趋势上的"偏高 / 偏低"整个反过来）`);
  }
  if (low === undefined && high === undefined && range.text === undefined) {
    issues.push(`${label}：至少要给下限 / 上限 / 文本里的一项（只写单位等于什么都没说）`);
  }
  return issues;
}

export function validateTemplatePackItems(pack: TemplatePack): string[] {
  const issues: string[] = [];
  const templates: TemplateDefinition[] = [];
  const fragments: FragmentDefinition[] = [];
  const controls: ControlDefinition[] = [];
  const expressions = new Map<string, ExpressionDefinition>();
  const controlDefs = new Map<string, ControlDefinition>();

  for (const item of pack.items) {
    const raw = item as unknown as Record<string, unknown>;
    const itemType = raw.itemType;
    if (itemType === 'expression') {
      const expression = item as ExpressionDefinition;
      if (typeof expression.name !== 'string' || expression.name.trim() === '') {
        issues.push(`表达式「${String(expression.itemId)}」：name 必须是非空字符串`);
      }
      if (expression.unit !== undefined && (typeof expression.unit !== 'string' || expression.unit.trim() === '')) {
        issues.push(`表达式「${String(expression.itemId)}」：unit 若提供必须是非空字符串`);
      }
      issues.push(...validateExpression(expression.expression, `表达式「${expression.itemId}」.expression`));
      expressions.set(expression.itemId, expression);
      continue;
    }
    if (itemType === 'template') {
      templates.push(item as TemplateDefinition);
      continue;
    }
    if (itemType === 'fragment') {
      fragments.push(item as FragmentDefinition);
      continue;
    }
    if (itemType === 'control') {
      const control = item as ControlDefinition;
      controls.push(control);
      controlDefs.set(control.itemId, control);
      continue;
    }
    issues.push(`条目「${String(item.itemId)}」：itemType 必须是 template / expression / fragment / control，实际「${String(itemType)}」`);
  }

  for (const template of templates) {
    issues.push(...validateTemplateDefinition(template, expressions, controlDefs));
  }
  for (const fragment of fragments) {
    issues.push(...validateFragmentDefinition(fragment, expressions, controlDefs));
  }
  for (const control of controls) {
    issues.push(...validateControlDefinition(control, expressions));
  }
  return issues;
}

export function validateTemplateDefinition(
  template: TemplateDefinition,
  expressions: Map<string, ExpressionDefinition>,
  controls: Map<string, ControlDefinition> | null = null,
): string[] {
  const label = `模板「${template.itemId}」`;
  const issues: string[] = [];

  if (typeof template.name !== 'string' || template.name.trim() === '') issues.push(`${label}：name 必须是非空字符串`);

  const docType = template.docType as unknown as Record<string, unknown> | undefined;
  if (!isPlainObject(docType)) {
    issues.push(`${label}：缺少 docType`);
  } else {
    if (!DOC_TYPE_SYSTEMS.includes(String(docType.system))) {
      issues.push(`${label}.docType.system：取值非法「${String(docType.system)}」（允许 ${DOC_TYPE_SYSTEMS.join('/')}）`);
    }
    for (const key of ['code', 'display']) {
      if (typeof docType[key] !== 'string' || (docType[key] as string).trim() === '') {
        issues.push(`${label}.docType.${key}：必须是非空字符串`);
      }
    }
  }

  if (!Array.isArray(template.sections) || template.sections.length === 0) {
    issues.push(`${label}：sections 必须是非空数组（空模板产不出任何东西）`);
    return issues;
  }

  issues.push(...validateTemplateSections(template.sections, expressions, label, controls));
  return issues;
}

export function validateTemplateSections(
  sections: TemplateSection[],
  expressions: Map<string, ExpressionDefinition> | null,
  ownerLabel: string,
  controls: Map<string, ControlDefinition> | null = null,
): string[] {
  const label = ownerLabel;
  const issues: string[] = [];

  const keys = new Map<string, TemplateSlot>();
  sections.forEach((section, sectionIndex) => {
    const sectionLabel = `${label}.sections[${sectionIndex}]`;
    if (typeof section.sectionCode !== 'string' || section.sectionCode.trim() === '') {
      issues.push(`${sectionLabel}.sectionCode：必须是非空字符串`);
    }
    if (typeof section.title !== 'string' || section.title.trim() === '') {
      issues.push(`${sectionLabel}.title：必须是非空字符串`);
    }
    for (const key of ['required', 'keyContent']) {
      const value = (section as unknown as Record<string, unknown>)[key];
      if (value !== undefined && typeof value !== 'boolean') {
        issues.push(`${sectionLabel}.${key}：给了就得是布尔（true / false）`);
      }
    }
    if (section.description !== undefined && (typeof section.description !== 'string' || section.description.trim() === '')) {
      issues.push(`${sectionLabel}.description：给了就得是非空字符串（不写说明就删掉这个键）`);
    }
    if (!Array.isArray(section.slots) || section.slots.length === 0) {
      issues.push(`${sectionLabel}.slots：必须是非空数组`);
      return;
    }
    section.slots.forEach((slot, slotIndex) => {
      const slotLabel = `${sectionLabel}.slots[${slotIndex}]`;
      const raw = slot as unknown as Record<string, unknown>;
      if (typeof raw.key !== 'string' || raw.key.trim() === '') {
        issues.push(`${slotLabel}.key：必须是非空字符串`);
        return;
      }
      if (keys.has(raw.key)) {
        issues.push(`E_TPL_SLOT_KEY_DUPLICATE ${slotLabel}.key：「${raw.key}」在模板内重复（表达式按 key 引用填写项，重名会指到别人身上）`);
        return;
      }
      if (slot.slot === 'field' && !FIELD_TYPES.includes(slot.dataType)) {
        issues.push(`${slotLabel}.dataType：取值非法「${String(slot.dataType)}」（允许 ${FIELD_TYPES.join('/')}）`);
      }
      if (slot.slot === 'field' && slot.from !== undefined) {
        if (typeof slot.from !== 'string' || slot.from.trim() === '') {
          issues.push(`${slotLabel}.from：取值路径必须是非空字符串（要"从系统带入"就给路径，不要这里就删掉这个字段）`);
        } else if (!KNOWN_CONTEXT_PATHS.includes(slot.from)) {
          issues.push(
            `${slotLabel}.from：上下文里没有「${slot.from}」（可用：${KNOWN_CONTEXT_PATHS.join(' / ')}）`
              + '；写错的路径会让这一格永远空着，所以这里直接拒绝',
          );
        }
      }
      if (slot.slot === 'field' && slot.value !== undefined && !matchesFieldType(slot.dataType, slot.value)) {
        issues.push(
          `${slotLabel}.value：默认值${describeValue(slot.value)}与数据类型 ${String(slot.dataType)} 对不上`
            + '（模板给的默认值是**机器真值**，不是展示文本：数字类型给数字、是/否给布尔、其余给字符串）',
        );
      }
      if (slot.slot === 'field' && slot.referenceRange !== undefined) {
        issues.push(...validateReferenceRange(slot.referenceRange, `${slotLabel}.referenceRange`));
      }
      if (slot.slot === 'table') {
        issues.push(...validateTableColumns(slot.columns, slot.rows, slotLabel));
        if (raw.keyContent !== undefined) {
          issues.push(`${slotLabel}.keyContent：表格不支持关键内容（没有"确认这个表格"这个动作）`);
        }
        if (raw.tags !== undefined) {
          issues.push(`${slotLabel}.tags：表格本身不绑数据元（机器读的是格子里的填写项）——把标签配在列上（columns[].tags）`);
        }
      }
      if (slot.slot === 'list') {
        issues.push(...validateListItems(slot.items, slotLabel));
        if (raw.tags !== undefined) {
          issues.push(`${slotLabel}.tags：列表不绑数据元（机器读的是填写项，列表本身不产数据元）`);
        }
        if (raw.keyContent !== undefined) {
          issues.push(`${slotLabel}.keyContent：列表不支持关键内容（医生端没有"确认这一整条列表"这个动作）`);
        }
      }
      if (slot.slot === 'image') {
        if (raw.tags !== undefined) {
          issues.push(`${slotLabel}.tags：图片槽不绑数据元（机器读的是填写项，图本身不产数据元）`);
        }
        if (raw.keyContent !== undefined) {
          issues.push(`${slotLabel}.keyContent：图片槽不支持关键内容（医生端没有"确认这一张图"这个动作）`);
        }
      }
      if (slot.slot === 'control') {
        if (typeof slot.useControl !== 'string' || slot.useControl.trim() === '') {
          issues.push(`${slotLabel}.useControl：必须是非空字符串（控件槽要说明用哪一个专科控件）`);
        }
        if (slot.rows !== undefined && (!Number.isInteger(slot.rows) || slot.rows < 1)) {
          issues.push(`${slotLabel}.rows：行数若提供必须是 ≥1 的整数`);
        }
        if (raw.tags !== undefined) {
          issues.push(
            `${slotLabel}.tags：控件不绑数据元（机器读的是控件里带 tag 的字段）——`
              + '给控件整体绑一个标签只会造出一条值为空、来源不明的数据元',
          );
        }
      }
      if (!SLOT_KINDS.includes(String(slot.slot))) {
        issues.push(`${slotLabel}.slot：未知槽位类型「${String((raw as { slot?: unknown }).slot)}」（只支持 ${SLOT_KINDS.join(' / ')}）`);
      }
      if (raw.tags !== undefined) {
        issues.push(...validateDataElementTags(raw.tags, `${slotLabel}.tags`));
      }
      keys.set(raw.key, slot);
    });
  });

  if (controls !== null) {
    sections.forEach((section, sectionIndex) => {
      section.slots.forEach((slot, slotIndex) => {
        if (slot.slot !== 'control') return;
        const slotLabel = `${label}.sections[${sectionIndex}].slots[${slotIndex}]`;
        if (!controls.has(slot.useControl)) {
          issues.push(
            `${slotLabel}.useControl：专科控件库里没有「${slot.useControl}」（可用：${[...controls.keys()].join(' / ') || '（空）'}）`
              + '；控件必须与文书同包 —— 跨包引用会让"这份文书依赖哪几个包同时在线"变成隐式条件',
          );
        }
      });
    });
  }
  if (expressions === null) return issues;
  sections.forEach((section, sectionIndex) => {
    section.slots.forEach((slot, slotIndex) => {
      if (slot.slot !== 'expression') return;
      const slotLabel = `${label}.sections[${sectionIndex}].slots[${slotIndex}]`;
      const definition = expressions.get(slot.useExpression);
      if (!definition) {
        issues.push(
          `${slotLabel}.useExpression：控件库中没有「${slot.useExpression}」（可用：${[...expressions.keys()].join(' / ') || '（空）'}）`,
        );
        return;
      }
      const refs = collectExpressionRefs(definition.expression);
      for (const key of refs.slots) {
        const target = keys.get(key);
        if (!target) {
          issues.push(`${slotLabel}：控件「${slot.useExpression}」引用了模板里不存在的填写项「${key}」`);
          continue;
        }
        if (target.slot !== 'field') {
          issues.push(`${slotLabel}：控件「${slot.useExpression}」引用的「${key}」不是填写项（派生值只能依赖填写项，不能依赖另一个派生值）`);
        }
      }
      for (const path of refs.context) {
        if (!KNOWN_CONTEXT_PATHS.includes(path)) {
          issues.push(`${slotLabel}：控件「${slot.useExpression}」引用了未登记的上下文「${path}」（可用的见 KNOWN_CONTEXT_PATHS）`);
        }
      }
    });
  });

  return issues;
}

export function validateFragmentDefinition(
  fragment: FragmentDefinition,
  expressions: Map<string, ExpressionDefinition> | null = null,
  controls: Map<string, ControlDefinition> | null = null,
): string[] {
  const label = `片段「${fragment.itemId}」`;
  const issues: string[] = [];

  if (typeof fragment.name !== 'string' || fragment.name.trim() === '') {
    issues.push(`${label}：name 必须是非空字符串（它是插入片段时看到的那一行）`);
  }
  if (fragment.description !== undefined && (typeof fragment.description !== 'string' || fragment.description.trim() === '')) {
    issues.push(`${label}：description 给了就得是非空字符串（不写说明就删掉这个键）`);
  }
  if (!Array.isArray(fragment.sections) || fragment.sections.length === 0) {
    issues.push(`${label}：sections 必须是非空数组（空片段插进去什么都不会发生）`);
    return issues;
  }

  issues.push(...validateTemplateSections(fragment.sections, expressions, label, controls));
  return issues;
}

export function validateControlDefinition(
  control: ControlDefinition,
  expressions: Map<string, ExpressionDefinition> | null = null,
): string[] {
  const label = `控件「${control.itemId}」`;
  const issues: string[] = [];

  if (typeof control.name !== 'string' || control.name.trim() === '') {
    issues.push(`${label}：name 必须是非空字符串（它是医生看到的那个标题）`);
  }
  if (!CONTROL_KINDS.includes(control.controlKind)) {
    issues.push(`${label}：controlKind 取值非法「${String(control.controlKind)}」（允许 ${CONTROL_KINDS.join(' / ')}）`);
  }
  if (!(CONTROL_SHAPES as readonly string[]).includes(control.shape)) {
    issues.push(`${label}：shape 取值非法「${String(control.shape)}」（允许 ${CONTROL_SHAPES.join(' / ')}）—— 形状决定渲染器，而渲染器是代码，认不出来的形状画不出来`);
  }
  if (control.version !== undefined && (!Number.isInteger(control.version) || control.version < 1)) {
    issues.push(`${label}：version 若提供必须是 ≥1 的整数（它是"这份定义改到第几版"的唯一凭据）`);
  }
  if (control.description !== undefined && (typeof control.description !== 'string' || control.description.trim() === '')) {
    issues.push(`${label}：description 给了就得是非空字符串（不写说明就删掉这个键）`);
  }

  const fields = control.fields;
  if (!Array.isArray(fields) || fields.length === 0) {
    issues.push(`${label}：fields 必须是非空数组（控件就是"把一组字段装进一个格子"，没有字段的控件是个空壳）`);
    return issues;
  }

  const keys = new Set<string>();
  let timeAxes = 0;
  fields.forEach((field, index) => {
    const where = `${label}.fields[${index}]`;
    const raw = field as unknown as Record<string, unknown>;

    if (typeof raw.key !== 'string' || raw.key.trim() === '') {
      issues.push(`${where}：key 必须是非空字符串（payload 的键就是它）`);
    } else if (keys.has(raw.key)) {
      issues.push(`${label}：字段 key「${raw.key}」重复（两次写入同一个格，后者会静默覆盖前者）`);
    } else {
      keys.add(raw.key);
    }
    if (typeof raw.label !== 'string' || raw.label.trim() === '') {
      issues.push(`${where}：label 必须是非空字符串（它是医生看到的那一格的名字）`);
    }
    if (!FIELD_TYPES.includes(raw.dataType as FieldDataType)) {
      issues.push(`${where}：dataType 取值非法「${String(raw.dataType)}」（允许 ${FIELD_TYPES.join(' / ')}）`);
    } else if (control.shape === 'image' && raw.dataType !== 'text') {
      issues.push(`${where}：影像形状（image）的格子只存资源地址，dataType 只能是 text，现在是 ${String(raw.dataType)}`);
    }
    if (raw.unit !== undefined && (typeof raw.unit !== 'string' || raw.unit.trim() === '')) {
      issues.push(`${where}：unit 若提供必须是非空字符串`);
    }

    if (raw.dataType === 'expression') {
      if (typeof raw.useExpression !== 'string' || raw.useExpression.trim() === '') {
        issues.push(`${where}：dataType 是 expression 就必须给 useExpression（否则那一格永远算不出来，而它看起来只是"还没填"）`);
      } else if (expressions && !expressions.has(raw.useExpression)) {
        issues.push(`${where}：useExpression 指向的表达式「${raw.useExpression}」不在本包里（控件不能跨包引用，否则同一份控件的算法会随装机而异）`);
      }
    } else if (raw.useExpression !== undefined) {
      issues.push(`${where}：useExpression 只在 dataType 是 expression 时有意义（这一格现在是 ${String(raw.dataType)}）`);
    }

    if (raw.axis !== undefined && raw.axis !== 'time') {
      issues.push(`${where}：axis 只允许 time（趋势按它排序，没有第二种轴）`);
    }
    if (raw.axis === 'time') timeAxes += 1;
  });

  if (timeAxes > 1) {
    issues.push(`${label}：标了时间轴（axis: time）的字段有 ${timeAxes} 个，只能有一个 —— 两个时间轴排不出唯一顺序`);
  }

  const hasRows = Array.isArray(control.rows) && control.rows.length > 0;
  const hasColumns = Array.isArray(control.columns) && control.columns.length > 0;
  if (control.shape === 'matrix') {
    if (!hasRows) issues.push(`${label}：matrix 形状必须有 rows（如 32 颗牙），否则渲染出来是一张空表`);
    if (!hasColumns) issues.push(`${label}：matrix 形状必须有 columns（如 龋 / 充填 / 缺失）`);
  } else {
    if (control.rows !== undefined) issues.push(`${label}：rows 只对 matrix 形状有意义（当前 shape 是 ${String(control.shape)}）`);
    if (control.columns !== undefined) issues.push(`${label}：columns 只对 matrix 形状有意义（当前 shape 是 ${String(control.shape)}）`);
  }

  return issues;
}

export function substituteContext(text: string, context: Record<string, string | number | undefined>, warnings: string[]): string {
  return text.replace(/\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g, (_match, path: string) => {
    const value = context[path];
    if (value === undefined || value === '') {
      warnings.push(`文本里的 {{${path}}} 取不到值，已原样保留`);
      return `{{${path}}}`;
    }
    return String(value);
  });
}

function provenanceOf(
  input: InstantiateInput,
  source: string,
  slotKey: string,
  extra?: DocNode['provenance']['evidence'],
): DocNode['provenance'] {
  return {
    origin: 'system',
    actorId: TEMPLATE_ENGINE_ACTOR,
    at: input.at,
    evidence: [{ kind: 'template', ref: source, field: slotKey }, ...(extra ?? [])],
  };
}

function expressionRefOf(packId: string, controlId: string): string {
  return `expr:${packId}/${controlId}`;
}

function expressionDepRefOf(packId: string, controlId: string): string {
  return `expr-dep:${packId}/${controlId}`;
}

export function buildContext(input: InstantiateInput): Record<string, string | number | undefined> {
  return {
    'patient.patientId': input.patient.patientId,
    'patient.nameMasked': input.patient.nameMasked,
    'patient.gender': input.patient.gender,
    'patient.birthDate': input.patient.birthDate,
    'encounter.visitId': input.encounter?.visitId,
    'encounter.visitType': input.encounter?.visitType,
    'encounter.deptCode': input.encounter?.deptCode,
    'encounter.admittedAt': input.encounter?.admittedAt,
    'encounter.dischargedAt': input.encounter?.dischargedAt,
    'doctor.actorId': input.doctor?.actorId,
    now: input.at,
    ...(input.context ?? {}),
  };
}

export interface InstantiateOutput {
  doc: DocumentModel;
  result: InstantiateResult;
}

export function instantiateTemplate(pack: TemplatePack, input: InstantiateInput): InstantiateOutput {
  const issues = validateTemplatePackItems(pack);
  if (issues.length > 0) {
    throw new TemplateError('E_TPL_PACK_INVALID', `模板包校验未通过：\n- ${issues.join('\n- ')}`);
  }

  const template = pack.items.find((item) => item.itemType === 'template' && item.itemId === input.templateId) as
    | TemplateDefinition
    | undefined;
  if (!template) {
    const available = pack.items.filter((item) => item.itemType === 'template').map((item) => item.itemId);
    throw new TemplateError('E_TPL_TEMPLATE_UNKNOWN', `模板包「${pack.packId}」中没有模板「${input.templateId}」（可用：${available.join(' / ') || '（空）'}）`);
  }

  const expressionById = new Map<string, ExpressionDefinition>();
  for (const item of pack.items) if (item.itemType === 'expression') expressionById.set(item.itemId, item);

  const controlById = new Map<string, ControlDefinition>();
  for (const item of pack.items) if (item.itemType === 'control') controlById.set(item.itemId, item);

  const context = buildContext(input);
  const warnings: string[] = [];
  const source = `${pack.packId}#${template.itemId}@${packFingerprintOf(pack)}`;
  const nodes: Record<NodeId, DocNode> = {};
  const slotNodeIds: Record<string, string> = {};
  const slotValues: Record<string, number | string | null> = {};

  const slotLabels: Record<string, string> = {};
  for (const section of template.sections) {
    for (const slot of section.slots) {
      slotLabels[slot.key] = slot.slot === 'field' ? (slot.tags?.[0]?.display ?? slot.key) : slot.key;
    }
  }

  const pendingDependencies: Array<{ fieldId: string; controlId: string; slotKeys: string[] }> = [];

  nodes.n_root = {
    id: 'n_root',
    type: 'document',
    parentId: null,
    order: 0,
    rev: 1,
    provenance: provenanceOf(input, source, 'document'),
  };

  let sectionSeq = 0;
  for (const section of template.sections) {
    sectionSeq += 1;
    const sectionId = `n_t${sectionSeq}`;
    nodes[sectionId] = {
      id: sectionId,
      type: 'section',
      parentId: 'n_root',
      order: sectionSeq * 10,
      rev: 1,
      title: section.title,
      sectionCode: section.sectionCode,
      ...(section.required ? { required: true } : {}),
      ...(section.keyContent ? { keyContent: true } : {}),
      provenance: provenanceOf(input, source, 'section'),
    };

    let paragraphSeq = 0;
    let paragraphId: string | null = null;
    let childSeq = 0;

    for (const slot of section.slots) {
      const startsParagraph = slot.slot === 'text' || slot.slot === 'paragraph'
        || slot.slot === 'table' || slot.slot === 'list' || slot.slot === 'control' || slot.slot === 'image'
        || slot.newParagraph === true || paragraphId === null;
      if (startsParagraph) {
        paragraphSeq += 1;
        paragraphId = `${sectionId}_p${paragraphSeq}`;
        childSeq = 0;
        nodes[paragraphId] = {
          id: paragraphId,
          type: 'paragraph',
          parentId: sectionId,
          order: paragraphSeq * 10,
          rev: 1,
          provenance: provenanceOf(input, source, 'paragraph'),
        };
      }
      childSeq += 1;
      const parent = paragraphId as string;
      const order = childSeq * 10;

      if (slot.slot === 'text' || slot.slot === 'paragraph') {
        const textId = `${parent}_t${childSeq}`;
        const raw = slot.slot === 'text' ? slot.text : undefined;
        const text = raw === undefined ? '' : substituteContext(raw, context, warnings);
        nodes[textId] = {
          id: textId,
          type: 'text',
          parentId: parent,
          order,
          rev: 1,
          runs: [{ text }],
          provenance: provenanceOf(input, source, slot.key),
          ...(slot.slot === 'text' && slot.tags ? { tags: slot.tags } : {}),
          ...(slot.keyContent ? { keyContent: true } : {}),
        };
        slotNodeIds[slot.key] = textId;
        continue;
      }

      if (slot.slot === 'image') {
        const imageId = `${parent}_img${childSeq}`;
        nodes[imageId] = {
          id: imageId,
          type: 'image',
          parentId: parent,
          order,
          rev: 1,
          resRef: slot.resRef ?? '',
          ...(slot.altText ? { altText: slot.altText } : {}),
          ...(slot.caption ? { caption: substituteContext(slot.caption, context, warnings) } : {}),
          provenance: provenanceOf(input, source, slot.key),
        };
        slotNodeIds[slot.key] = imageId;
        continue;
      }

      if (slot.slot === 'list') {
        const groupId = `${parent}_lg${childSeq}`;
        nodes[groupId] = {
          id: groupId,
          type: 'listGroup',
          parentId: parent,
          order,
          rev: 1,
          ...(slot.ordered ? { ordered: true } : {}),
          provenance: provenanceOf(input, source, slot.key),
        };
        slot.items.forEach((item, itemIndex) => {
          const itemId = `${groupId}_i${itemIndex + 1}`;
          nodes[itemId] = {
            id: itemId,
            type: 'listItem',
            parentId: groupId,
            order: (itemIndex + 1) * 10,
            rev: 1,
            provenance: provenanceOf(input, source, slot.key),
          };
          nodes[`${itemId}_t`] = {
            id: `${itemId}_t`,
            type: 'text',
            parentId: itemId,
            order: 10,
            rev: 1,
            runs: [{ text: substituteContext(item.text, context, warnings) }],
            provenance: provenanceOf(input, source, slot.key),
          };
          if (item.field) {
            const fieldKey = `${slot.key}.i${itemIndex + 1}`;
            const fieldId = `${itemId}_f`;
            nodes[fieldId] = {
              id: fieldId,
              type: 'field',
              parentId: itemId,
              order: 20,
              rev: 1,
              dataType: item.field.dataType,
              value: null,
              valueText: '',
              ...(item.field.unit ? { unit: item.field.unit } : {}),
              ...(item.field.tags ? { tags: item.field.tags } : {}),
              provenance: provenanceOf(input, source, fieldKey),
            };
            slotNodeIds[fieldKey] = fieldId;
          }
        });
        slotNodeIds[slot.key] = groupId;
        continue;
      }

      if (slot.slot === 'field') {
        const fieldId = `${parent}_f${childSeq}`;
        let value: JsonValue = null;
        if (slot.value !== undefined) {
          value = slot.value;
        } else if (slot.from !== undefined) {
          const fromValue = context[slot.from];
          if (fromValue === undefined || fromValue === '') {
            warnings.push(`字段「${slot.key}」想从上下文 ${slot.from} 取值，但那里是空的（保持未填）`);
          } else {
            value = fromValue;
          }
        }
        const valueText = value === null ? '' : String(value);
        const provenance = provenanceOf(input, source, slot.key);
        if (slot.from !== undefined) {
          provenance.evidence = [
            ...(provenance.evidence ?? []),
            {
              kind: 'his',
              ref: `ctx:${slot.from}`,
              field: slot.key,
              ...(valueText === '' ? { quote: '取不到值，保持未填' } : { valueText }),
            },
          ];
        }
        nodes[fieldId] = {
          id: fieldId,
          type: 'field',
          parentId: parent,
          order,
          rev: 1,
          dataType: slot.dataType,
          value,
          valueText,
          ...(slot.unit ? { unit: slot.unit } : {}),
          ...(slot.tags ? { tags: slot.tags } : {}),
          ...(slot.keyContent ? { keyContent: true } : {}),
          ...(slot.required ? { required: true } : {}),
          ...(slot.referenceRange ? { referenceRange: structuredClone(slot.referenceRange) } : {}),
          provenance,
        };
        slotNodeIds[slot.key] = fieldId;
        slotValues[slot.key] = typeof value === 'number' || typeof value === 'string' ? value : null;
        continue;
      }

      if (slot.slot === 'table') {
        const tableId = `${parent}_tb${childSeq}`;
        const rowCount = slot.rows ?? 1;
        nodes[tableId] = {
          id: tableId,
          type: 'table',
          parentId: parent,
          order,
          rev: 1,
          colCount: slot.columns.length,
          headerRows: 1,
          provenance: provenanceOf(input, source, slot.key),
        };
        slotNodeIds[slot.key] = tableId;

        const headerId = `${tableId}_r0`;
        nodes[headerId] = {
          id: headerId,
          type: 'tableRow',
          parentId: tableId,
          order: 10,
          rev: 1,
          provenance: provenanceOf(input, source, slot.key),
        };
        slot.columns.forEach((column, columnIndex) => {
          const cellId = `${headerId}_c${columnIndex + 1}`;
          nodes[cellId] = {
            id: cellId,
            type: 'tableCell',
            parentId: headerId,
            order: (columnIndex + 1) * 10,
            rev: 1,
            provenance: provenanceOf(input, source, slot.key),
          };
          const textId = `${cellId}_t`;
          nodes[textId] = {
            id: textId,
            type: 'text',
            parentId: cellId,
            order: 10,
            rev: 1,
            runs: [{ text: column.title }],
            provenance: provenanceOf(input, source, slot.key),
          };
        });

        for (let rowIndex = 1; rowIndex <= rowCount; rowIndex += 1) {
          const rowId = `${tableId}_r${rowIndex}`;
          nodes[rowId] = {
            id: rowId,
            type: 'tableRow',
            parentId: tableId,
            order: (rowIndex + 1) * 10,
            rev: 1,
            provenance: provenanceOf(input, source, slot.key),
          };
          slot.columns.forEach((column, columnIndex) => {
            const cellKey = `${slot.key}.r${rowIndex}c${columnIndex + 1}`;
            const cellId = `${rowId}_c${columnIndex + 1}`;
            nodes[cellId] = {
              id: cellId,
              type: 'tableCell',
              parentId: rowId,
              order: (columnIndex + 1) * 10,
              rev: 1,
              provenance: provenanceOf(input, source, slot.key),
            };
            const fieldId = `${cellId}_f`;
            nodes[fieldId] = {
              id: fieldId,
              type: 'field',
              parentId: cellId,
              order: 10,
              rev: 1,
              dataType: column.dataType ?? 'text',
              value: null,
              valueText: '',
              ...(column.unit ? { unit: column.unit } : {}),
              ...(column.tags ? { tags: column.tags } : {}),
              provenance: provenanceOf(input, source, cellKey),
            };
            slotNodeIds[cellKey] = fieldId;
          });
        }
        continue;
      }

      if (slot.slot === 'control') {
        const definition = controlById.get(slot.useControl);
        if (!definition) {
          throw new TemplateError(
            'E_TPL_CONTROL_UNKNOWN',
            `模板「${input.templateId}」的槽位「${slot.key}」引用了专科控件「${slot.useControl}」，但包里没有它`,
          );
        }
        const controlNodeId = `${parent}_c${childSeq}`;
        const payload: Record<string, JsonValue> = {};
        for (const field of definition.fields ?? []) {
          if (field.defaultValue !== undefined) payload[field.key] = structuredClone(field.defaultValue);
        }
        nodes[controlNodeId] = {
          id: controlNodeId,
          type: 'control',
          parentId: parent,
          order,
          rev: 1,
          controlKind: definition.controlKind,
          shape: definition.shape,
          definitionId: definition.itemId,
          payloadVersion: definition.version ?? 1,
          fields: (definition.fields ?? []).map((field) => ({
            key: field.key,
            label: field.label,
            dataType: field.dataType,
            ...(field.unit ? { unit: field.unit } : {}),
            ...(field.valueSet ? { valueSet: structuredClone(field.valueSet) } : {}),
            ...(field.referenceRange ? { referenceRange: structuredClone(field.referenceRange) } : {}),
            ...(field.required ? { required: true } : {}),
            ...(field.tag ? { tag: structuredClone(field.tag) } : {}),
            ...(field.axis === 'time' ? { axis: 'time' as const } : {}),
          })),
          ...(definition.rows ? { rows: structuredClone(definition.rows) } : {}),
          ...(definition.columns ? { columns: structuredClone(definition.columns) } : {}),
          ...(definition.layout ? { layout: structuredClone(definition.layout) } : {}),
          ...(definition.shape === 'series' ? { rowCount: slot.rows ?? SERIES_DEFAULT_ROWS } : {}),
          ...(slot.keyContent ? { keyContent: true } : {}),
          payload,
          provenance: provenanceOf(input, source, slot.key, [
            {
              kind: 'template',
              ref: `control:${pack.packId}/${definition.itemId}@v${definition.version ?? 1}`,
              field: 'control',
              valueText: definition.name,
            },
          ]),
        };
        slotNodeIds[slot.key] = controlNodeId;
        continue;
      }

      const definition = expressionById.get(slot.useExpression) as ExpressionDefinition;
      const refs = collectExpressionRefs(definition.expression);
      const computed = evaluate(definition.expression, { slots: slotValues, context });
      const fieldId = `${parent}_x${childSeq}`;
      const valueText = computed === null ? '' : String(computed);
      if (computed === null) {
        const missingSlots = refs.slots.filter((key) => slotValues[key] === null || slotValues[key] === undefined);
        const missingContext = refs.context.filter((path) => context[path] === undefined || context[path] === '');
        if (missingSlots.length > 0) {
          warnings.push(`派生值「${definition.name}」未算出：还缺 ${missingSlots.map((key) => slotLabels[key] ?? key).join('、')}（填好后点「重算派生值」）`);
        } else if (missingContext.length > 0) {
          warnings.push(`派生值「${definition.name}」未算出：还缺就诊信息 ${missingContext.join('、')}`);
        } else {
          warnings.push(`派生值「${definition.name}」未算出：表达式无法求值，请核对取值类型`);
        }
      }
      nodes[fieldId] = {
        id: fieldId,
        type: 'field',
        parentId: parent,
        order,
        rev: 1,
        dataType: 'expression',
        value: computed,
        valueText,
        ...(slot.unit ?? definition.unit ? { unit: slot.unit ?? definition.unit } : {}),
        ...(slot.tags ? { tags: slot.tags } : {}),
        ...(slot.keyContent ? { keyContent: true } : {}),
        provenance: provenanceOf(input, source, slot.key, [
          {
            kind: 'template',
            ref: expressionRefOf(pack.packId, definition.itemId),
            field: 'expression',
            valueText: describeExpression(definition.expression),
          },
        ]),
      };
      slotNodeIds[slot.key] = fieldId;
      pendingDependencies.push({ fieldId, controlId: definition.itemId, slotKeys: refs.slots });
    }
  }

  for (const pending of pendingDependencies) {
    const node = nodes[pending.fieldId];
    if (!node) continue;
    for (const key of pending.slotKeys) {
      const depNodeId = slotNodeIds[key];
      if (typeof depNodeId !== 'string') continue;
      node.provenance.evidence = node.provenance.evidence ?? [];
      node.provenance.evidence.push({
        kind: 'template',
        ref: expressionDepRefOf(pack.packId, pending.controlId),
        field: key,
        nodeId: depNodeId,
      });
    }
  }

  const doc: DocumentModel = {
    schemaVersion: SCHEMA_VERSION,
    docId: input.docId,
    docType: template.docType,
    patient: { ...input.patient },
    ...(input.encounter ? { encounter: { ...input.encounter } } : {}),
    status: 'draft',
    createdAt: input.at,
    updatedAt: input.at,
    createdBy: input.createdBy,
    rootId: 'n_root',
    nodes,
    revisions: [
      {
        rev: 1,
        at: input.at,
        actorId: input.createdBy,
        op: 'create',
        targetId: 'n_root',
        patch: [{ op: 'add', path: '/nodes/n_root', value: nodes.n_root as unknown as JsonValue }],
      },
    ],
  };

  return { doc, result: { templateId: template.itemId, source, slots: slotNodeIds, warnings } };
}
