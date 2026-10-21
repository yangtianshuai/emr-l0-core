import type { ControlKind, DataElementTag, DocTypeRef, FieldDataType, JsonValue } from '../model/types.ts';
import type { PackRegistry } from '../knowledge/pack.ts';
import { describeExpression } from './expression.ts';
import { validateExpression } from './expression.ts';
import { TemplateError, validateControlDefinition, validateFragmentDefinition, validateTemplateDefinition, validateTemplatePackItems } from './engine.ts';
import type {
  ControlDefinition,
  ControlFieldDef,
  ControlShape,
  ExprNode,
  ExpressionDefinition,
  FragmentDefinition,
  ReferenceRange,
  TemplateDefinition,
  TemplateListItem,
  TemplatePack,
  TemplateSection,
  TemplateSlot,
} from './types.ts';

/** 模板引擎契约版本。改名或改槽位语义都必须同时改它（契约不同即拒载） */
export const TEMPLATE_ENGINE_API = 'doc-template/1';

export const SUPPORTED_TEMPLATE_ENGINE_APIS: readonly string[] = [TEMPLATE_ENGINE_API];

export function validateTemplatePack(pack: TemplatePack): void {
  const issues = validateTemplatePackItems(pack);
  if (issues.length > 0) {
    throw new TemplateError('E_TPL_PACK_INVALID', `模板包「${pack.packId}」校验未通过：\n- ${issues.join('\n- ')}`);
  }
}

export type VisitTypeScope = 'outpatient' | 'emergency' | 'inpatient';

export interface TemplateSummary {
  packId: string;
  templateId: string;
  name: string;
  docType: DocTypeRef;
  visitTypes: VisitTypeScope[];
  sectionCount: number;
  slotCount: number;
  expressionCount: number;
}

export function visitTypesOfDocType(docType: DocTypeRef | undefined): VisitTypeScope[] {
  const code = docType?.code ?? '';
  if (code === 'WST500.2') return ['outpatient', 'emergency'];
  if (code === 'WST500.1' || code === 'WST500.3' || code === 'WST500.4') return ['inpatient'];
  return [];
}

export function templateItemsOf(pack: TemplatePack): TemplateDefinition[] {
  return pack.items.filter((item) => item.itemType === 'template') as TemplateDefinition[];
}

export function fragmentItemsOf(pack: TemplatePack): FragmentDefinition[] {
  return pack.items.filter((item) => item.itemType === 'fragment') as FragmentDefinition[];
}

export interface FragmentSummary {
  packId: string;
  fragmentId: string;
  name: string;
  sectionCount: number;
  slotCount: number;
  description?: string;
}

export function listFragments(registry: PackRegistry): FragmentSummary[] {
  const out: FragmentSummary[] = [];
  for (const { packId, item } of registry.activeItemsOf('template')) {
    const fragment = item as FragmentDefinition;
    if (fragment.itemType !== 'fragment') continue;
    const sections = Array.isArray(fragment.sections) ? fragment.sections : [];
    out.push({
      packId,
      fragmentId: fragment.itemId,
      name: fragment.name ?? fragment.itemId,
      sectionCount: sections.length,
      slotCount: sections.reduce((sum, section) => sum + (section.slots?.length ?? 0), 0),
      ...(fragment.description ? { description: fragment.description } : {}),
    });
  }
  return out;
}

export function isTemplateDraft(definition: TemplateDefinition): boolean {
  return definition.status === 'draft';
}

export function isTemplateOpenable(definition: TemplateDefinition): boolean {
  return definition.enabled !== false && !isTemplateDraft(definition);
}

export function deptAllowsTemplate(definition: TemplateDefinition, deptCode: string | undefined): boolean {
  const departments = Array.isArray(definition.departments) ? definition.departments.filter((code) => code !== '') : [];
  if (departments.length === 0) return true;
  if (!deptCode) return false;
  return departments.includes(deptCode);
}

export function listTemplates(registry: PackRegistry, options: { deptCode?: string } = {}): TemplateSummary[] {
  const out: TemplateSummary[] = [];
  for (const { packId, item } of registry.activeItemsOf('template')) {
    const pack = registry.get(packId) as TemplatePack | undefined;
    if (!pack) continue;
    const definition = item as TemplateDefinition;
    if (definition.itemType !== 'template') continue;
    if (isTemplateDraft(definition)) continue;
    if (options.deptCode !== undefined && !deptAllowsTemplate(definition, options.deptCode)) continue;
    const sections = Array.isArray(definition.sections) ? definition.sections : [];
    out.push({
      packId,
      templateId: definition.itemId,
      name: definition.name ?? definition.itemId,
      docType: definition.docType,
      visitTypes: visitTypesOfDocType(definition.docType),
      sectionCount: sections.length,
      slotCount: sections.reduce((sum, section) => sum + (section.slots?.length ?? 0), 0),
      expressionCount: sections.reduce(
        (sum, section) => sum + (section.slots ?? []).filter((slot) => slot.slot === 'expression').length,
        0,
      ),
    });
  }
  return out;
}

export interface ExpressionControlSummary {
  packId: string;
  controlId: string;
  name: string;
  unit: string;
  formula: string;
}

export function listExpressionControls(registry: PackRegistry): ExpressionControlSummary[] {
  const out: ExpressionControlSummary[] = [];
  for (const { packId, item } of registry.activeItemsOf('template')) {
    const control = item as ExpressionDefinition;
    if (control.itemType !== 'expression') continue;
    out.push({
      packId,
      controlId: control.itemId,
      name: control.name ?? control.itemId,
      unit: control.unit ?? '',
      formula: describeExpression(control.expression),
    });
  }
  return out;
}

export interface TemplateCatalogSlot {
  kind: 'text' | 'paragraph' | 'field' | 'expression' | 'table' | 'list' | 'control' | 'image';
  key: string;
  detail: string;
  tags?: DataElementTag[];
  required?: boolean;
  dataType?: FieldDataType;
  text?: string;
  useExpression?: string;
  useControl?: string;
  unit?: string;
  from?: string;
  keyContent?: boolean;
  value?: JsonValue;
  referenceRange?: ReferenceRange;
  newParagraph?: boolean;
  columns?: Array<{ title: string; dataType?: FieldDataType; unit?: string; tags?: DataElementTag[] }>;
  rows?: number;
  items?: TemplateListItem[];
  ordered?: boolean;
  resRef?: string;
  altText?: string;
  caption?: string;
}

export interface TemplateCatalogSection {
  sectionCode: string;
  title: string;
  slots: TemplateCatalogSlot[];
  required?: boolean;
  keyContent?: boolean;
  description?: string;
}

export interface TemplateCatalogControl {
  controlId: string;
  name: string;
  formula: string;
  unit: string;
  enabled: boolean;
}

export interface TemplateCatalogEntry {
  packId: string;
  itemId: string;
  itemType: 'template' | 'expression' | 'fragment' | 'control';
  name: string;
  enabled: boolean;
  status: 'draft' | 'active';
  detail: string;
  docType?: { system: string; code: string; display: string };
  departments: string[];
  openable: boolean;
  expression?: ExprNode;
  unit?: string;
  shape?: ControlShape;
  controlVersion?: number;
  controlKind?: ControlKind;
  fields?: ControlFieldDef[];
  rows?: Array<{ key: string; label: string }>;
  columns?: Array<{ key: string; label: string }>;
  description?: string;
  sections: TemplateCatalogSection[];
  controls: TemplateCatalogControl[];
}

export function templateCatalogOf(registry: PackRegistry): TemplateCatalogEntry[] {
  const out: TemplateCatalogEntry[] = [];
  for (const summary of registry.list('template')) {
    const pack = registry.get(summary.packId) as TemplatePack | undefined;
    if (!pack) continue;
    const controlById = new Map<string, ExpressionDefinition>();
    for (const item of pack.items) {
      if (item.itemType === 'expression') controlById.set(item.itemId, item);
    }
    const controlDefById = new Map<string, ControlDefinition>();
    for (const item of pack.items) {
      if (item.itemType === 'control') controlDefById.set(item.itemId, item);
    }
    for (const item of pack.items) {
      if (item.itemType === 'template') {
        const sections = Array.isArray(item.sections) ? item.sections : [];
        const slots = sections.reduce((sum, section) => sum + (section.slots?.length ?? 0), 0);
        const used = usedControlsOf(sections);
        out.push({
          packId: summary.packId,
          itemId: item.itemId,
          itemType: 'template',
          name: item.name ?? item.itemId,
          enabled: item.enabled !== false,
          status: isTemplateDraft(item) ? 'draft' : 'active',
          detail: `${item.docType?.display ?? item.docType?.code ?? '（未标文书类型）'} · ${sections.length} 章 / ${slots} 槽位`
            + (used.length > 0 ? ` · 引用 ${used.length} 个表达式控件` : ''),
          ...(item.docType
            ? { docType: { system: item.docType.system, code: item.docType.code, display: item.docType.display } }
            : {}),
          departments: Array.isArray(item.departments) ? [...item.departments] : [],
          openable: isTemplateOpenable(item),
          sections: catalogSectionsOf(sections, controlById, controlDefById),
          controls: used.map((controlId) => {
            const control = controlById.get(controlId);
            return {
              controlId,
              name: control?.name ?? controlId,
              formula: control ? describeExpression(control.expression) : '（包里没有这个控件）',
              unit: control?.unit ?? '',
              enabled: control ? control.enabled !== false : false,
            };
          }),
        });
      } else if (item.itemType === 'fragment') {
        const sections = Array.isArray(item.sections) ? item.sections : [];
        const slots = sections.reduce((sum, section) => sum + (section.slots?.length ?? 0), 0);
        const used = usedControlsOf(sections);
        out.push({
          packId: summary.packId,
          itemId: item.itemId,
          itemType: 'fragment',
          name: item.name ?? item.itemId,
          enabled: item.enabled !== false,
          status: 'draft',
          detail: `章节片段 · ${sections.length} 章 / ${slots} 槽位`
            + (used.length > 0 ? ` · 引用 ${used.length} 个表达式控件` : ''),
          ...(item.description ? { description: item.description } : {}),
          departments: [],
          openable: false,
          sections: catalogSectionsOf(sections, controlById, controlDefById),
          controls: [],
        });
      } else if (item.itemType === 'control') {
        const fields = Array.isArray(item.fields) ? item.fields : [];
        out.push({
          packId: summary.packId,
          itemId: item.itemId,
          itemType: 'control',
          name: item.name ?? item.itemId,
          enabled: item.enabled !== false,
          status: 'active',
          detail: `专科控件 · ${item.shape} · ${fields.length} 个字段`
            + (item.version !== undefined && item.version > 1 ? ` · 定义 v${item.version}` : ''),
          shape: item.shape,
          controlKind: item.controlKind,
          fields,
          ...(Array.isArray(item.rows) ? { rows: item.rows } : {}),
          ...(Array.isArray(item.columns) ? { columns: item.columns } : {}),
          ...(item.version !== undefined ? { controlVersion: item.version } : {}),
          ...(item.description ? { description: item.description } : {}),
          departments: [],
          openable: item.enabled !== false,
          sections: [],
          controls: [],
        });
      } else {
        out.push({
          packId: summary.packId,
          itemId: item.itemId,
          itemType: 'expression',
          name: item.name ?? item.itemId,
          enabled: item.enabled !== false,
          status: 'active',
          detail: `${describeExpression(item.expression)}${item.unit ? `（${item.unit}）` : ''}`,
          /* 公式原文与单位、说明都要给界面：编辑控件时构造器要回显它（不然"编辑"只能从头搭一遍）  */
          expression: item.expression,
          ...(item.unit ? { unit: item.unit } : {}),
          ...(item.description ? { description: item.description } : {}),
          departments: [],
          openable: item.enabled !== false,
          sections: [],
          controls: [],
        });
      }
    }
  }
  return out;
}

function catalogSectionsOf(
  sections: TemplateSection[],
  controlById: Map<string, ExpressionDefinition>,
  controlDefById: Map<string, ControlDefinition>,
): TemplateCatalogSection[] {
  return sections.map((section) => ({
    sectionCode: section.sectionCode,
    title: section.title,
    slots: (section.slots ?? []).map((slot) => slotViewOf(slot, controlById, controlDefById)),
    ...(section.required ? { required: true } : {}),
    ...(section.keyContent ? { keyContent: true } : {}),
    ...(section.description !== undefined ? { description: section.description } : {}),
  }));
}

function usedControlsOf(sections: TemplateSection[]): string[] {
  const used: string[] = [];
  for (const section of sections) {
    for (const slot of section.slots ?? []) {
      if (slot.slot === 'expression' && !used.includes(slot.useExpression)) used.push(slot.useExpression);
    }
  }
  return used;
}

function usedControlDefsOf(sections: TemplateSection[]): string[] {
  const used: string[] = [];
  for (const section of sections) {
    for (const slot of section.slots ?? []) {
      if (slot.slot === 'control' && !used.includes(slot.useControl)) used.push(slot.useControl);
    }
  }
  return used;
}

function carryControlsInto(
  base: TemplatePack,
  sections: TemplateSection[],
  lookup: (controlId: string) => ExpressionDefinition | ControlDefinition | undefined,
  ownerLabel: string,
): {
  newControls: Array<ExpressionDefinition | ControlDefinition>;
  copiedControls: Array<{ from: string; to: string; name: string }>;
} {
  const known = new Set<string>();
  for (const item of base.items) {
    if (item.itemType === 'expression' || item.itemType === 'control') known.add(item.itemId);
  }
  const newControls: Array<ExpressionDefinition | ControlDefinition> = [];
  const copiedControls: Array<{ from: string; to: string; name: string }> = [];
  const copyInto = (definition: ExpressionDefinition | ControlDefinition, field: 'useExpression' | 'useControl'): void => {
    const newId = nextCustomId(
      [...base.items, ...newControls],
      definition.itemType === 'expression' ? 'expr.custom.' : 'ctrl.custom.',
    );
    newControls.push({ ...structuredClone(definition), itemId: newId, enabled: true });
    known.add(newId);
    for (const section of sections) {
      for (const slot of section.slots) {
        if (field === 'useExpression' && slot.slot === 'expression' && slot.useExpression === definition.itemId) {
          slot.useExpression = newId;
        }
        if (field === 'useControl' && slot.slot === 'control' && slot.useControl === definition.itemId) {
          slot.useControl = newId;
        }
      }
    }
    copiedControls.push({ from: definition.itemId, to: newId, name: definition.name ?? definition.itemId });
  };

  const pendingControls = usedControlDefsOf(sections);
  const pendingExpressions = usedControlsOf(sections);
  for (let i = 0; i < pendingControls.length; i += 1) {
    const controlId = pendingControls[i];
    if (known.has(controlId)) continue;
    const definition = lookup(controlId);
    if (!definition || definition.itemType !== 'control') {
      throw new TemplateError(
        'E_TPL_CONTROL_UNKNOWN',
        `${ownerLabel}引用了专科控件「${controlId}」，但目标包里没有它、也找不到它的定义：`
          + '文书用到的控件必须与文书同包 —— 请先把那个控件（或它所在的那份文书）复制进本院自建包',
      );
    }
    copyInto(definition, 'useControl');
    for (const field of definition.fields ?? []) {
      if (field.useExpression && !pendingExpressions.includes(field.useExpression)) {
        pendingExpressions.push(field.useExpression);
      }
    }
  }
  for (let i = 0; i < pendingExpressions.length; i += 1) {
    const controlId = pendingExpressions[i];
    if (known.has(controlId)) continue;
    const definition = lookup(controlId);
    if (!definition || definition.itemType !== 'expression') {
      throw new TemplateError(
        'E_TPL_EXPR_UNKNOWN',
        `${ownerLabel}引用了控件「${controlId}」，但目标包里没有它、也找不到它的定义：`
          + '模板用到的控件必须与模板同包 —— 请先把那个控件（或它所在的那份文书）复制进本院自建包',
      );
    }
    copyInto(definition, 'useExpression');
  }
  return { newControls, copiedControls };
}

function slotViewOf(
  slot: TemplateSlot,
  controlById: Map<string, ExpressionDefinition>,
  controlDefById: Map<string, ControlDefinition>,
): TemplateCatalogSlot {
  const view: TemplateCatalogSlot = { kind: slot.slot, key: slot.key, detail: '' };
  if (slot.slot === 'text') {
    view.detail = slot.text ? `文本：${slot.text.length > 48 ? `${slot.text.slice(0, 48)}…` : slot.text}` : '文本（结构提示）';
    if (slot.text !== undefined) view.text = slot.text;
  } else if (slot.slot === 'paragraph') {
    view.detail = '空段落（留白，由医生写）';
  } else if (slot.slot === 'image') {
    /* 图片槽要答"该放什么、有没有图"：空地址 = 待贴，不是"填过了"（与医生端那张空槽的写法一致） */
    view.detail = `图片：${slot.altText ?? '（未写说明）'}${slot.resRef ? '' : ' · 待贴图'}`;
    if (slot.resRef !== undefined) view.resRef = slot.resRef;
    if (slot.altText !== undefined) view.altText = slot.altText;
    if (slot.caption !== undefined) view.caption = slot.caption;
  } else if (slot.slot === 'field') {
    view.detail = `填写项 ${slot.dataType}${slot.unit ? `（${slot.unit}）` : ''}${slot.required ? ' · 必填' : ''}`;
    view.dataType = slot.dataType;
    if (slot.from !== undefined) view.from = slot.from;
  } else if (slot.slot === 'table') {
    const rows = slot.rows ?? 1;
    view.detail = `表格：${slot.columns.length} 列 × ${rows} 行（${slot.columns.map((column) => column.title).join(' / ')}）`;
    view.columns = slot.columns.map((column) => ({
      title: column.title,
      ...(column.dataType !== undefined ? { dataType: column.dataType } : {}),
      ...(column.unit !== undefined ? { unit: column.unit } : {}),
      ...(column.tags !== undefined ? { tags: column.tags } : {}),
    }));
    if (slot.rows !== undefined) view.rows = slot.rows;
  } else if (slot.slot === 'list') {
    view.detail = `列表：${slot.items.length} 项（${slot.ordered ? '编号' : '圆点'}）`
      + `${slot.items.some((item) => item.field) ? ' · 带填写格' : ''}`;
    view.items = slot.items.map((item) => ({
      text: item.text,
      ...(item.field
        ? {
          field: {
            dataType: item.field.dataType,
            ...(item.field.unit !== undefined ? { unit: item.field.unit } : {}),
            ...(item.field.tags ? { tags: item.field.tags.map((tag) => ({ ...tag })) } : {}),
          },
        }
        : {}),
    }));
    if (slot.ordered) view.ordered = true;
  } else if (slot.slot === 'expression') {
    const control = controlById.get(slot.useExpression);
    view.detail = `表达式：${control?.name ?? slot.useExpression}（${slot.useExpression}）${slot.unit ? ` · 单位 ${slot.unit}` : ''}`;
    view.useExpression = slot.useExpression;
  } else if (slot.slot === 'control') {
    const control = controlDefById.get(slot.useControl);
    const fieldCount = control ? (control.fields ?? []).length : 0;
    view.detail = `专科控件：${control?.name ?? slot.useControl}（${slot.useControl}）`
      + `${control ? ` · ${fieldCount} 格` : ''}${slot.rows ? ` · ${slot.rows} 行` : ''}`;
    view.useControl = slot.useControl;
    if (slot.rows !== undefined) view.rows = slot.rows;
  }
  if ((slot.slot === 'field' || slot.slot === 'expression') && slot.unit !== undefined) view.unit = slot.unit;
  if (
    (slot.slot === 'text' || slot.slot === 'paragraph' || slot.slot === 'field' || slot.slot === 'expression')
    && slot.keyContent === true
  ) {
    view.keyContent = true;
  }
  if (slot.newParagraph === true) view.newParagraph = true;
  if ((slot.slot === 'text' || slot.slot === 'field' || slot.slot === 'expression') && slot.tags && slot.tags.length > 0) {
    view.tags = slot.tags.map((tag) => ({ system: tag.system, code: tag.code, ...(tag.display ? { display: tag.display } : {}) }));
  }
  if (slot.slot === 'field') {
    if (slot.required === true) view.required = true;
    if (slot.value !== undefined) view.value = slot.value;
    if (slot.referenceRange !== undefined) view.referenceRange = { ...slot.referenceRange };
  }
  return view;
}

export interface TemplatePatch {
  name?: string;
  departments?: string[];
  status?: 'draft' | 'active';
  sections?: TemplateSection[];
  slotMeta?: SlotMetaPatch[];
  sectionMeta?: SectionMetaPatch[];
}

export interface SlotMetaPatch {
  sectionCode: string;
  key: string;
  from?: string | null;
  required?: boolean;
  unit?: string | null;
  display?: string | null;
  keyContent?: boolean;
  /** 模板预设的默认值（`null` = 清掉，回到空待填）；只对填写项有意义 */
  value?: JsonValue | null;
  referenceRange?: ReferenceRange | null;
  newParagraph?: boolean;
}

export interface SectionMetaPatch {
  sectionCode: string;
  required?: boolean;
  keyContent?: boolean;
  description?: string | null;
}

function expressionsOf(pack: TemplatePack): Map<string, ExpressionDefinition> {
  const map = new Map<string, ExpressionDefinition>();
  for (const item of pack.items) {
    if (item.itemType === 'expression') map.set(item.itemId, item);
  }
  return map;
}

function definitionByIdOf(pack: TemplatePack): Map<string, ExpressionDefinition | ControlDefinition> {
  const map = new Map<string, ExpressionDefinition | ControlDefinition>();
  for (const item of pack.items) {
    if (item.itemType === 'expression' || item.itemType === 'control') map.set(item.itemId, item);
  }
  return map;
}

function controlDefsOf(pack: TemplatePack): Map<string, ControlDefinition> {
  const map = new Map<string, ControlDefinition>();
  for (const item of pack.items) {
    if (item.itemType === 'control') map.set(item.itemId, item);
  }
  return map;
}

function normalizeDepartments(values: string[]): { list?: string[] } {
  const list: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed === '' || seen.has(trimmed)) continue;
    seen.add(trimmed);
    list.push(trimmed);
  }
  return list.length > 0 ? { list } : {};
}

export function patchTemplateMeta(pack: TemplatePack, itemId: string, patch: TemplatePatch): TemplatePack {
  const index = pack.items.findIndex((item) => item.itemId === itemId);
  if (index < 0) {
    throw new TemplateError('E_TPL_ITEM_NOT_FOUND', `模板包「${pack.packId}」里没有条目「${itemId}」`);
  }
  const current = pack.items[index];
  if (current.itemType !== 'template') {
    throw new TemplateError(
      'E_TPL_ITEM_NOT_TEMPLATE',
      `条目「${itemId}」是医学表达式控件，不是文书：控件的名称与公式就是它本身，改它属于换内容`,
    );
  }
  if (patch.name === undefined && patch.departments === undefined && patch.status === undefined
    && patch.sections === undefined && patch.slotMeta === undefined && patch.sectionMeta === undefined) {
    throw new TemplateError('E_TPL_FIELD_INVALID', '没有要改的字段（文书这里开放名称 / 适用科室 / 状态 / 骨架 / 槽位元数据 / 章节属性）');
  }
  if (patch.sections !== undefined && (patch.slotMeta !== undefined || patch.sectionMeta !== undefined)) {
    throw new TemplateError(
      'E_TPL_FIELD_INVALID',
      'sections（整份骨架）与 slotMeta / sectionMeta（元数据补丁）不能一起交：前者已经把每一格的显示名 / 单位 / 从系统带入 / 必填，'
        + '以及每一章的必备 / 关键内容 / 说明都写全了，后者是在库里那份骨架上再改一遍，'
        + '两个一起送来无从知道该照哪一份算。要改骨架就只交 sections，只改元数据就只交那些补丁',
    );
  }
  const next: TemplateDefinition = { ...current };
  if (patch.name !== undefined) {
    if (typeof patch.name !== 'string' || patch.name.trim() === '') {
      throw new TemplateError('E_TPL_FIELD_INVALID', '模板名称必须是非空字符串');
    }
    next.name = patch.name.trim();
  }
  if (patch.departments !== undefined) {
    if (!Array.isArray(patch.departments) || patch.departments.some((value) => typeof value !== 'string' || value.trim() === '')) {
      throw new TemplateError('E_TPL_FIELD_INVALID', '适用科室必须是字符串数组（空数组 = 通用）');
    }
    const { list } = normalizeDepartments(patch.departments);
    if (list) next.departments = list;
    else delete next.departments;
  }
  if (patch.status !== undefined) {
    if (patch.status !== 'draft' && patch.status !== 'active') {
      throw new TemplateError('E_TPL_FIELD_INVALID', '状态只能是 draft（草稿）或 active（已发布）');
    }
    next.status = patch.status;
  }
  if (patch.sections !== undefined) {
    if (!isTemplateDraft(current)) {
      throw new TemplateError(
        'E_TPL_STATUS_PUBLISHED',
        `「${current.name}」已发布，改不了章节与槽位：它可能已经开出过病历，改骨架会让"当时按哪一版开的"对不上。`
          + '要先改，请**先撤稿**（撤稿后医生端立刻开不出它），改完再发布',
      );
    }
    if (!Array.isArray(patch.sections)) {
      throw new TemplateError('E_TPL_FIELD_INVALID', '章节必须是数组（至少一章，否则这份文书产不出任何内容）');
    }
    next.sections = patch.sections;
  }
  let sectionsCloned = false;
  const cloneSections = (): void => {
    if (sectionsCloned) return;
    sectionsCloned = true;
    next.sections = next.sections.map((section) => ({
      ...section,
      slots: section.slots.map((slot) => ({ ...slot })),
    }));
  };
  if (patch.slotMeta !== undefined) {
    if (!Array.isArray(patch.slotMeta)) {
      throw new TemplateError('E_TPL_FIELD_INVALID', '槽位元数据必须是数组（每项给出章节编码、槽位名与要改的项）');
    }
    cloneSections();
    for (const item of patch.slotMeta) {
      if (!item || typeof item.sectionCode !== 'string' || typeof item.key !== 'string') {
        throw new TemplateError('E_TPL_FIELD_INVALID', '槽位元数据每一项都要给出 sectionCode 与 key（用它们定位那一格）');
      }
      const section = next.sections.find((candidate) => candidate.sectionCode === item.sectionCode);
      if (!section) {
        throw new TemplateError(
          'E_TPL_SLOT_NOT_FOUND',
          `槽位元数据定位不到：「${item.sectionCode}」这一章不在库里那份模板里（章节编码要照它写）`,
        );
      }
      const slotIndex = section.slots.findIndex((slot) => slot.key === item.key);
      if (slotIndex < 0) {
        throw new TemplateError(
          'E_TPL_SLOT_NOT_FOUND',
          `槽位元数据定位不到：「${item.sectionCode}」里没有槽位「${item.key}」（槽位名要照库里那份模板写）`,
        );
      }
      const slot = section.slots[slotIndex];
      const at = `「${item.sectionCode}」的槽位「${item.key}」`;
      if (slot.slot === 'table') {
        const touched = Object.keys(item as unknown as Record<string, unknown>)
          .filter((field) => field !== 'sectionCode' && field !== 'key' && (item as unknown as Record<string, unknown>)[field] !== undefined);
        if (touched.length > 0) {
          throw new TemplateError(
            'E_TPL_FIELD_INVALID',
            `${at}是表格：列定义与行数是**骨架**（只有草稿能改），表格也没有"显示名 / 从系统带入 / 必填 / 单位 / 关键内容"这些元数据`
              + `（要标就标在格子上）。收到的是：${touched.join(' / ')}`,
          );
        }
        continue;
      }
      if (slot.slot === 'list') {
        const touched = Object.keys(item as unknown as Record<string, unknown>)
          .filter((field) => field !== 'sectionCode' && field !== 'key' && (item as unknown as Record<string, unknown>)[field] !== undefined);
        if (touched.length > 0) {
          throw new TemplateError(
            'E_TPL_FIELD_INVALID',
            `${at}是列表：项与有序性是**骨架**（只有草稿能改），列表也没有"显示名 / 从系统带入 / 必填 / 单位 / 关键内容"这些元数据`
              + `（要标数据元就标在条目里的填写项上，本版尚未开放）。收到的是：${touched.join(' / ')}`,
          );
        }
        continue;
      }
      if (item.from !== undefined) {
        if (slot.slot !== 'field') {
          throw new TemplateError('E_TPL_FIELD_INVALID', `${at}不是填写项：「从系统带入」只对填写项有意义`);
        }
        const path = item.from === null ? '' : item.from.trim();
        if (path === '') delete slot.from;
        else slot.from = path;
      }
      if (item.required !== undefined) {
        if (slot.slot !== 'field') {
          throw new TemplateError('E_TPL_FIELD_INVALID', `${at}不是填写项：必填只对填写项有意义`);
        }
        if (item.required) slot.required = true;
        else delete slot.required;
      }
      if (item.unit !== undefined) {
        if (slot.slot === 'text' || slot.slot === 'paragraph' || slot.slot === 'image') {
          const label = slot.slot === 'text' ? '结构文本' : slot.slot === 'paragraph' ? '空段落' : '图片槽';
          throw new TemplateError('E_TPL_FIELD_INVALID', `${at}是${label}：${label}没有单位（单位只对填写项与表达式控件有意义）`);
        }
        if (slot.slot === 'control') {
          throw new TemplateError('E_TPL_FIELD_INVALID', `${at}是专科控件：控件整体没有单位（单位配在控件里的字段上）`);
        }
        const unit = item.unit === null ? '' : item.unit.trim();
        if (unit === '') delete slot.unit;
        else slot.unit = unit;
      }
      if (item.display !== undefined) {
        if (slot.slot === 'control') {
          throw new TemplateError('E_TPL_FIELD_INVALID', `${at}是专科控件：控件不绑数据元（要绑就绑在控件里的字段上）`);
        }
        if (slot.slot === 'paragraph' || slot.slot === 'image') {
          throw new TemplateError(
            'E_TPL_FIELD_INVALID',
            `${at}是${slot.slot === 'paragraph' ? '空段落' : '图片槽'}：不绑数据元（机器读的是填写项，这一格不产数据元）`,
          );
        }
        const display = item.display === null ? '' : item.display.trim();
        const tags = Array.isArray(slot.tags) ? [...slot.tags] : [];
        if (display === '') {
          if (tags.length > 0) {
            const first = { ...tags[0] };
            delete first.display;
            tags[0] = first;
            slot.tags = tags;
          }
        } else if (tags.length > 0) {
          tags[0] = { ...tags[0], display };
          slot.tags = tags;
        } else {
          slot.tags = [{ system: 'local', code: slot.key, display }];
        }
      }
      if (item.keyContent !== undefined) {
        if (slot.slot === 'image') {
          throw new TemplateError('E_TPL_FIELD_INVALID', `${at}是图片槽：图片不支持关键内容（医生端没有"确认这一张图"这个动作）`);
        }
        if (item.keyContent) slot.keyContent = true;
        else delete slot.keyContent;
      }
      if (item.newParagraph !== undefined) {
        if (slot.slot === 'text' || slot.slot === 'paragraph') {
          const label = slot.slot === 'text' ? '结构文本' : '空段落';
          throw new TemplateError('E_TPL_FIELD_INVALID', `${at}是${label}：它本来就另起一段，「强制另起一段」对它没有意义`);
        }
        if (item.newParagraph) slot.newParagraph = true;
        else delete slot.newParagraph;
      }
      if (item.value !== undefined) {
        if (slot.slot !== 'field') {
          throw new TemplateError('E_TPL_FIELD_INVALID', `${at}不是填写项：默认值只对填写项有意义`);
        }
        if (item.value === null) delete slot.value;
        else slot.value = structuredClone(item.value);
      }
      if (item.referenceRange !== undefined) {
        if (slot.slot !== 'field') {
          throw new TemplateError('E_TPL_FIELD_INVALID', `${at}不是填写项：参考范围只对填写项有意义`);
        }
        if (item.referenceRange === null) delete slot.referenceRange;
        else slot.referenceRange = { ...item.referenceRange };
      }
    }
  }
  if (patch.sectionMeta !== undefined) {
    if (!Array.isArray(patch.sectionMeta)) {
      throw new TemplateError('E_TPL_FIELD_INVALID', '章节属性必须是数组（每项给出章节编码与要改的项）');
    }
    cloneSections();
    for (const item of patch.sectionMeta) {
      if (!item || typeof item.sectionCode !== 'string' || item.sectionCode.trim() === '') {
        throw new TemplateError('E_TPL_FIELD_INVALID', '章节属性每一项都要给出 sectionCode（用它定位是哪一章）');
      }
      const matched = next.sections.filter((candidate) => candidate.sectionCode === item.sectionCode);
      if (matched.length === 0) {
        throw new TemplateError(
          'E_TPL_SECTION_INVALID',
          `章节属性定位不到：「${item.sectionCode}」这一章不在库里那份模板里（章节编码要照它写）`,
        );
      }
      if (matched.length > 1) {
        throw new TemplateError(
          'E_TPL_SECTION_INVALID',
          `章节属性定位不了：「${item.sectionCode}」在本文书里出现了 ${matched.length} 次。`
            + '按章节编码定位要求它在模板内唯一（编码也是跨文书比对的锚点）—— 请先把其中一章的编码改掉',
        );
      }
      const section = matched[0];
      if (item.required !== undefined) {
        if (item.required) section.required = true;
        else delete section.required;
      }
      if (item.keyContent !== undefined) {
        if (item.keyContent) section.keyContent = true;
        else delete section.keyContent;
      }
      if (item.description !== undefined) {
        const description = item.description === null ? '' : String(item.description).trim();
        if (description === '') delete section.description;
        else section.description = description;
      }
    }
  }
  const issues = validateTemplateDefinition(next, expressionsOf(pack), controlDefsOf(pack));
  if (issues.length > 0) {
    throw new TemplateError('E_TPL_PACK_INVALID', `这份文书改完通不过校验：\n- ${issues.join('\n- ')}`);
  }
  const items = pack.items.slice();
  items[index] = next;
  return { ...pack, items };
}

export const CUSTOM_TEMPLATE_PACK_ID = 'doc.template.custom';

export function customTemplatePackBase(): TemplatePack {
  return {
    packId: CUSTOM_TEMPLATE_PACK_ID,
    kind: 'template',
    engineApi: TEMPLATE_ENGINE_API,
    name: '院内自建模板与控件',
    vendor: '本机构维护',
    items: [],
  };
}

export interface TemplateDraftInput {
  name: string;
  docType: DocTypeRef;
  departments?: string[];
  sections?: TemplateSection[];
  status?: 'draft' | 'active';
}

function nextCustomId(items: Array<{ itemId: string }>, prefix: string): string {
  const pattern = new RegExp(`^${prefix.replace(/\./g, '\\.')}(\\d+)$`);
  let seq = 1;
  for (const item of items) {
    const matched = pattern.exec(item.itemId);
    if (matched) seq = Math.max(seq, Number(matched[1]) + 1);
  }
  return `${prefix}${seq}`;
}

export function minimalTemplateSections(): TemplateSection[] {
  return [{ sectionCode: 'body', title: '正文', slots: [{ slot: 'text', key: 'content', text: '' }] }];
}

export function addTemplate(pack: TemplatePack | null, input: TemplateDraftInput): { pack: TemplatePack; itemId: string } {
  const base: TemplatePack = pack ?? customTemplatePackBase();
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (name === '') {
    throw new TemplateError('E_TPL_FIELD_INVALID', '文书名称必须是非空字符串（它是「新建」里的那一行）');
  }
  const docType = input.docType as unknown as Record<string, unknown> | undefined;
  if (!docType || typeof docType.code !== 'string' || docType.code.trim() === '' || typeof docType.display !== 'string' || docType.display.trim() === '') {
    throw new TemplateError('E_TPL_FIELD_INVALID', '文书类型缺 code 或 display：它是"这份文书算哪一类"的唯一凭据');
  }
  const itemId = nextCustomId(base.items, 'tpl.custom.');
  const definition: TemplateDefinition = {
    itemType: 'template',
    itemId,
    name,
    docType: {
      system: (typeof docType.system === 'string' ? docType.system : 'local') as DocTypeRef['system'],
      code: docType.code.trim(),
      display: docType.display.trim(),
    },
    sections: Array.isArray(input.sections) && input.sections.length > 0 ? input.sections : minimalTemplateSections(),
    status: input.status === 'active' ? 'active' : 'draft',
  };
  const { list } = normalizeDepartments(Array.isArray(input.departments) ? input.departments : []);
  if (list) definition.departments = list;
  const issues = validateTemplateDefinition(definition, expressionsOf(base));
  if (issues.length > 0) {
    throw new TemplateError('E_TPL_PACK_INVALID', `新建的文书通不过校验：\n- ${issues.join('\n- ')}`);
  }
  return { pack: { ...base, items: [...base.items, definition] }, itemId };
}

export interface CopyTemplateResult {
  pack: TemplatePack;
  itemId: string;
  copiedControls: Array<{ from: string; to: string; name: string }>;
}

export function copyTemplateIntoPack(
  targetPack: TemplatePack | null,
  sourcePack: TemplatePack,
  sourceItemId: string,
  options: { name?: string } = {},
): CopyTemplateResult {
  const source = sourcePack.items.find((item) => item.itemId === sourceItemId);
  if (!source) {
    throw new TemplateError('E_TPL_ITEM_NOT_FOUND', `模板包「${sourcePack.packId}」里没有条目「${sourceItemId}」`);
  }
  if (source.itemType !== 'template') {
    throw new TemplateError(
      'E_TPL_ITEM_NOT_TEMPLATE',
      `条目「${sourceItemId}」不是文书，不能"复制一份文书"：`
        + (source.itemType === 'expression'
          ? '它是医学表达式控件（控件在本院自建包里新建或从模板里带过来）'
          : '它是章节片段（片段在文书编辑抽屉里按「插入」使用）'),
    );
  }
  const base: TemplatePack = targetPack ?? customTemplatePackBase();
  const name = (options.name ?? `${source.name}（副本）`).trim();
  if (name === '') {
    throw new TemplateError('E_TPL_FIELD_INVALID', '副本名称必须是非空字符串（它是「新建」里的那一行）');
  }
  const sections = structuredClone(source.sections) as TemplateSection[];
  const { newControls, copiedControls } = carryControlsInto(
    base,
    sections,
    (controlId) =>
      sourcePack.items.find(
        (item) => (item.itemType === 'expression' || item.itemType === 'control') && item.itemId === controlId,
      ) as ExpressionDefinition | ControlDefinition | undefined,
    `「${source.name}」`,
  );
  const itemId = nextCustomId(base.items, 'tpl.custom.');
  const definition: TemplateDefinition = {
    ...structuredClone(source),
    itemType: 'template',
    itemId,
    name,
    sections,
    status: 'draft',
    enabled: true,
  };
  const pack: TemplatePack = { ...base, items: [...base.items, ...newControls, definition] };
  const issues = validateTemplatePackItems(pack);
  if (issues.length > 0) {
    throw new TemplateError('E_TPL_PACK_INVALID', `复制出来的文书通不过校验：\n- ${issues.join('\n- ')}`);
  }
  return { pack, itemId, copiedControls };
}

export interface ExpressionDraftInput {
  name: string;
  expression: ExprNode;
  unit?: string;
  description?: string;
}

export function addExpression(pack: TemplatePack | null, input: ExpressionDraftInput): { pack: TemplatePack; itemId: string } {
  const base: TemplatePack = pack ?? customTemplatePackBase();
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (name === '') {
    throw new TemplateError('E_TPL_FIELD_INVALID', '控件名称必须是非空字符串（它是模板里选用控件时看到的那一行）');
  }
  const issues = validateExpression(input.expression, `${name} 的公式`);
  if (issues.length > 0) {
    throw new TemplateError('E_TPL_PACK_INVALID', `这个公式通不过校验：\n- ${issues.join('\n- ')}`);
  }
  const itemId = nextCustomId(base.items, 'expr.custom.');
  const definition: ExpressionDefinition = {
    itemType: 'expression',
    itemId,
    name,
    expression: input.expression,
    unit: typeof input.unit === 'string' && input.unit.trim() !== '' ? input.unit.trim() : undefined,
    description: typeof input.description === 'string' && input.description.trim() !== '' ? input.description.trim() : undefined,
  };
  return { pack: { ...base, items: [...base.items, definition] }, itemId };
}

export function removeTemplate(pack: TemplatePack, itemId: string): TemplatePack {
  const index = pack.items.findIndex((item) => item.itemId === itemId);
  if (index < 0) {
    throw new TemplateError('E_TPL_ITEM_NOT_FOUND', `模板包「${pack.packId}」里没有条目「${itemId}」`);
  }
  if (pack.items[index].itemType !== 'template') {
    throw new TemplateError('E_TPL_ITEM_NOT_TEMPLATE', `条目「${itemId}」不是文书（医学表达式控件另有其途）`);
  }
  return { ...pack, items: pack.items.filter((item) => item.itemId !== itemId) };
}

export interface ExpressionPatch {
  name?: string;
  unit?: string;
  description?: string;
  expression?: ExprNode;
}

export function expressionUsedBy(pack: TemplatePack, controlId: string): Array<{ itemId: string; name: string }> {
  const out: Array<{ itemId: string; name: string }> = [];
  for (const item of templateItemsOf(pack)) {
    const used = item.sections.some((section) => section.slots.some((slot) => slot.slot === 'expression' && slot.useExpression === controlId));
    if (used) out.push({ itemId: item.itemId, name: item.name ?? item.itemId });
  }
  return out;
}

export function patchExpression(pack: TemplatePack, itemId: string, patch: ExpressionPatch): TemplatePack {
  const index = pack.items.findIndex((item) => item.itemId === itemId);
  if (index < 0) {
    throw new TemplateError('E_TPL_ITEM_NOT_FOUND', `模板包「${pack.packId}」里没有条目「${itemId}」`);
  }
  const current = pack.items[index];
  if (current.itemType !== 'expression') {
    throw new TemplateError(
      'E_TPL_ITEM_NOT_TEMPLATE',
      `条目「${itemId}」是文书，不是表达式控件：文书的名称与科室走「文书」那条路改`,
    );
  }
  if (patch.name === undefined && patch.unit === undefined && patch.description === undefined && patch.expression === undefined) {
    throw new TemplateError('E_TPL_FIELD_INVALID', '没有要改的字段（控件这里开放名称 / 单位 / 说明 / 公式）');
  }
  const next: ExpressionDefinition = { ...current };
  if (patch.name !== undefined) {
    if (typeof patch.name !== 'string' || patch.name.trim() === '') {
      throw new TemplateError('E_TPL_FIELD_INVALID', '控件名称必须是非空字符串（它是模板里选用控件时看到的那一行）');
    }
    next.name = patch.name.trim();
  }
  if (patch.unit !== undefined) {
    const unit = String(patch.unit).trim();
    if (unit === '') delete next.unit;
    else next.unit = unit;
  }
  if (patch.description !== undefined) {
    const description = String(patch.description).trim();
    if (description === '') delete next.description;
    else next.description = description;
  }
  if (patch.expression !== undefined) {
    const issues = validateExpression(patch.expression, `${next.name} 的公式`);
    if (issues.length > 0) {
      throw new TemplateError('E_TPL_PACK_INVALID', `这个公式通不过校验：\n- ${issues.join('\n- ')}`);
    }
    next.expression = patch.expression;
  }
  const items = pack.items.slice();
  items[index] = next;
  return { ...pack, items };
}

export function removeExpression(pack: TemplatePack, itemId: string): TemplatePack {
  const index = pack.items.findIndex((item) => item.itemId === itemId);
  if (index < 0) {
    throw new TemplateError('E_TPL_ITEM_NOT_FOUND', `模板包「${pack.packId}」里没有条目「${itemId}」`);
  }
  if (pack.items[index].itemType !== 'expression') {
    throw new TemplateError('E_TPL_ITEM_NOT_TEMPLATE', `条目「${itemId}」不是表达式控件（文书另有其途）`);
  }
  const users = expressionUsedBy(pack, itemId);
  if (users.length > 0) {
    throw new TemplateError(
      'E_TPL_EXPR_IN_USE',
      `控件「${itemId}」还被 ${users.length} 份文书引用（${users.map((user) => `「${user.name}」`).join('、')}）：`
        + '先在这些文书的槽位里改成别的控件（或删掉那些槽位），再删它',
    );
  }
  return { ...pack, items: pack.items.filter((item) => item.itemId !== itemId) };
}

function controlSemanticKey(control: ControlDefinition): string {
  return JSON.stringify({
    controlKind: control.controlKind,
    shape: control.shape,
    fields: control.fields,
    rows: control.rows ?? null,
    columns: control.columns ?? null,
  });
}

export interface ControlDraftInput {
  name: string;
  controlKind: ControlKind;
  shape: ControlShape;
  fields: ControlFieldDef[];
  rows?: Array<{ key: string; label: string }>;
  columns?: Array<{ key: string; label: string }>;
  description?: string;
}

export function addControl(pack: TemplatePack | null, input: ControlDraftInput): { pack: TemplatePack; itemId: string } {
  const base: TemplatePack = pack ?? customTemplatePackBase();
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (name === '') {
    throw new TemplateError('E_TPL_FIELD_INVALID', '控件名称必须是非空字符串（它是这一页表里的那一行）');
  }
  const itemId = nextCustomId(base.items, 'ctrl.custom.');
  const definition: ControlDefinition = {
    itemType: 'control',
    itemId,
    name,
    controlKind: input.controlKind,
    shape: input.shape,
    version: 1,
    fields: structuredClone(input.fields) as ControlFieldDef[],
    ...(Array.isArray(input.rows) ? { rows: structuredClone(input.rows) } : {}),
    ...(Array.isArray(input.columns) ? { columns: structuredClone(input.columns) } : {}),
    ...(typeof input.description === 'string' && input.description.trim() !== ''
      ? { description: input.description.trim() }
      : {}),
  };
  const issues = validateControlDefinition(definition, expressionsOf(base));
  if (issues.length > 0) {
    throw new TemplateError('E_TPL_PACK_INVALID', `这个控件通不过校验：\n- ${issues.join('\n- ')}`);
  }
  return { pack: { ...base, items: [...base.items, definition] }, itemId };
}

export interface ControlPatch {
  name?: string;
  description?: string | null;
  controlKind?: ControlKind;
  shape?: ControlShape;
  fields?: ControlFieldDef[];
  rows?: Array<{ key: string; label: string }> | null;
  columns?: Array<{ key: string; label: string }> | null;
}

export function patchControl(pack: TemplatePack, itemId: string, patch: ControlPatch): TemplatePack {
  const index = pack.items.findIndex((item) => item.itemId === itemId);
  if (index < 0) {
    throw new TemplateError('E_TPL_ITEM_NOT_FOUND', `模板包「${pack.packId}」里没有条目「${itemId}」`);
  }
  const current = pack.items[index];
  if (current.itemType !== 'control') {
    throw new TemplateError(
      'E_TPL_ITEM_TYPE',
      `条目「${itemId}」不是专科控件：`
        + (current.itemType === 'expression'
          ? '它是医学表达式控件（那是"这个值怎么算"，走「知识资产 → 表达式控件」那一页改）'
          : `它是一条 ${current.itemType} 条目`),
    );
  }
  if (
    patch.name === undefined && patch.description === undefined && patch.controlKind === undefined
    && patch.shape === undefined && patch.fields === undefined && patch.rows === undefined && patch.columns === undefined
  ) {
    throw new TemplateError('E_TPL_FIELD_INVALID', '没有要改的字段（控件这里开放名称 / 语义类型 / 形状 / 说明 / 字段 / 行列）');
  }

  const next: ControlDefinition = { ...current };
  if (patch.name !== undefined) {
    if (typeof patch.name !== 'string' || patch.name.trim() === '') {
      throw new TemplateError('E_TPL_FIELD_INVALID', '控件名称必须是非空字符串（它是这一页表里的那一行）');
    }
    next.name = patch.name.trim();
  }
  if (patch.description !== undefined) {
    const description = String(patch.description ?? '').trim();
    if (description === '') delete next.description;
    else next.description = description;
  }
  if (patch.controlKind !== undefined) next.controlKind = patch.controlKind;
  if (patch.shape !== undefined) next.shape = patch.shape;
  if (patch.fields !== undefined) next.fields = structuredClone(patch.fields) as ControlFieldDef[];
  if (patch.rows !== undefined) {
    if (patch.rows === null || patch.rows.length === 0) delete next.rows;
    else next.rows = structuredClone(patch.rows);
  }
  if (patch.columns !== undefined) {
    if (patch.columns === null || patch.columns.length === 0) delete next.columns;
    else next.columns = structuredClone(patch.columns);
  }

  if (controlSemanticKey(next) !== controlSemanticKey(current)) {
    next.version = (current.version ?? 1) + 1;
  }

  const issues = validateControlDefinition(next, expressionsOf(pack));
  if (issues.length > 0) {
    throw new TemplateError('E_TPL_PACK_INVALID', `这个控件通不过校验：\n- ${issues.join('\n- ')}`);
  }
  const items = pack.items.slice();
  items[index] = next;
  return { ...pack, items };
}

export function removeControl(pack: TemplatePack, itemId: string): TemplatePack {
  const index = pack.items.findIndex((item) => item.itemId === itemId);
  if (index < 0) {
    throw new TemplateError('E_TPL_ITEM_NOT_FOUND', `模板包「${pack.packId}」里没有条目「${itemId}」`);
  }
  if (pack.items[index].itemType !== 'control') {
    throw new TemplateError('E_TPL_ITEM_TYPE', `条目「${itemId}」不是专科控件（别的类别各有其途）`);
  }
  return { ...pack, items: pack.items.filter((item) => item.itemId !== itemId) };
}

export interface FragmentDraftInput {
  name: string;
  sections: TemplateSection[];
  description?: string;
}

export function addFragment(
  pack: TemplatePack | null,
  input: FragmentDraftInput,
  options: { lookupControl?: (controlId: string) => ExpressionDefinition | ControlDefinition | undefined } = {},
): { pack: TemplatePack; itemId: string; copiedControls: Array<{ from: string; to: string; name: string }> } {
  const base: TemplatePack = pack ?? customTemplatePackBase();
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (name === '') {
    throw new TemplateError('E_TPL_FIELD_INVALID', '片段名称必须是非空字符串（它是插入片段时看到的那一行）');
  }
  if (!Array.isArray(input.sections) || input.sections.length === 0) {
    throw new TemplateError('E_TPL_FIELD_INVALID', '片段至少要有一章（空片段插进去什么都不会发生）');
  }
  const sections = structuredClone(input.sections) as TemplateSection[];
  const lookup = options.lookupControl ?? ((controlId: string) => definitionByIdOf(base).get(controlId));
  const { newControls, copiedControls } = carryControlsInto(base, sections, lookup, `片段「${name}」`);
  const itemId = nextCustomId(base.items, 'frag.custom.');
  const definition: FragmentDefinition = {
    itemType: 'fragment',
    itemId,
    name,
    sections,
    ...(typeof input.description === 'string' && input.description.trim() !== ''
      ? { description: input.description.trim() }
      : {}),
  };
  const withControls: TemplatePack = { ...base, items: [...base.items, ...newControls] };
  const issues = validateFragmentDefinition(definition, expressionsOf(withControls));
  if (issues.length > 0) {
    throw new TemplateError('E_TPL_PACK_INVALID', `这个片段通不过校验：\n- ${issues.join('\n- ')}`);
  }
  return { pack: { ...withControls, items: [...withControls.items, definition] }, itemId, copiedControls };
}

export interface FragmentPatch {
  name?: string;
  description?: string;
  sections?: TemplateSection[];
}

export function patchFragment(
  pack: TemplatePack,
  itemId: string,
  patch: FragmentPatch,
  options: { lookupControl?: (controlId: string) => ExpressionDefinition | ControlDefinition | undefined } = {},
): TemplatePack {
  const index = pack.items.findIndex((item) => item.itemId === itemId);
  if (index < 0) {
    throw new TemplateError('E_TPL_ITEM_NOT_FOUND', `模板包「${pack.packId}」里没有条目「${itemId}」`);
  }
  const current = pack.items[index];
  if (current.itemType !== 'fragment') {
    throw new TemplateError(
      'E_TPL_ITEM_NOT_TEMPLATE',
      `条目「${itemId}」不是章节片段：文书的名称与科室走「文书」那条路，控件的公式走「控件」那条路`,
    );
  }
  if (patch.name === undefined && patch.description === undefined && patch.sections === undefined) {
    throw new TemplateError('E_TPL_FIELD_INVALID', '没有要改的字段（片段这里开放名称 / 说明 / 内容）');
  }
  const next: FragmentDefinition = { ...current };
  if (patch.name !== undefined) {
    if (typeof patch.name !== 'string' || patch.name.trim() === '') {
      throw new TemplateError('E_TPL_FIELD_INVALID', '片段名称必须是非空字符串');
    }
    next.name = patch.name.trim();
  }
  if (patch.description !== undefined) {
    const description = String(patch.description).trim();
    if (description === '') delete next.description;
    else next.description = description;
  }
  const newControls: Array<ExpressionDefinition | ControlDefinition> = [];
  if (patch.sections !== undefined) {
    if (!Array.isArray(patch.sections) || patch.sections.length === 0) {
      throw new TemplateError('E_TPL_FIELD_INVALID', '片段至少要有一章（空片段插进去什么都不会发生）');
    }
    const sections = structuredClone(patch.sections) as TemplateSection[];
    const lookup = options.lookupControl ?? ((controlId: string) => definitionByIdOf(pack).get(controlId));
    const carried = carryControlsInto(pack, sections, lookup, `片段「${next.name}」`);
    newControls.push(...carried.newControls);
    next.sections = sections;
  }
  const withControls: TemplatePack = { ...pack, items: [...pack.items, ...newControls] };
  const issues = validateFragmentDefinition(next, expressionsOf(withControls), controlDefsOf(withControls));
  if (issues.length > 0) {
    throw new TemplateError('E_TPL_PACK_INVALID', `这个片段改完通不过校验：\n- ${issues.join('\n- ')}`);
  }
  const items = withControls.items.slice();
  items[items.findIndex((item) => item.itemId === itemId)] = next;
  return { ...withControls, items };
}

export function removeFragment(pack: TemplatePack, itemId: string): TemplatePack {
  const index = pack.items.findIndex((item) => item.itemId === itemId);
  if (index < 0) {
    throw new TemplateError('E_TPL_ITEM_NOT_FOUND', `模板包「${pack.packId}」里没有条目「${itemId}」`);
  }
  if (pack.items[index].itemType !== 'fragment') {
    throw new TemplateError('E_TPL_ITEM_NOT_TEMPLATE', `条目「${itemId}」不是章节片段`);
  }
  return { ...pack, items: pack.items.filter((item) => item.itemId !== itemId) };
}

export function findTemplate(registry: PackRegistry, templateId: string): { pack: TemplatePack; definition: TemplateDefinition } | null {
  for (const { packId, item } of registry.activeItemsOf('template')) {
    const definition = item as TemplateDefinition;
    if (definition.itemType !== 'template' || definition.itemId !== templateId) continue;
    /* 与 `listTemplates` 同一口径：草稿开不出，"找得到"与"开得出"必须是同一件事 */
    if (isTemplateDraft(definition)) continue;
    const pack = registry.get(packId) as TemplatePack | undefined;
    if (pack) return { pack, definition };
  }
  return null;
}

