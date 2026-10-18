// 模板实例化引擎（K4）。

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

/** 模板实例化写进 `provenance.actorId` 的来源标识（与 `demo-seed` / `system/lis` 同一约定） */
export const TEMPLATE_ENGINE_ACTOR = 'template-engine';

/** 文档类型可用的取值（与 `model/validate.ts` 的白名单一致；两处漂移会让产物校验失败） */
const DOC_TYPE_SYSTEMS = ['WST500', 'WS445', 'local', 'custom'];
const FIELD_TYPES: FieldDataType[] = ['text', 'number', 'date', 'code', 'boolean', 'expression'];
const SLOT_KINDS: string[] = ['text', 'paragraph', 'field', 'expression', 'table', 'list', 'control', 'image'];
/** 参考范围允许的键（与 `model/types.ts` 的 `FieldNode.referenceRange` 同一套；多处漂移会让产物校验失败） */
const REFERENCE_RANGE_KEYS = ['low', 'high', 'text', 'unit'];
const CONTROL_KINDS = ['menstrualHistory', 'odontogram', 'vitalSignsChart', 'scaleScore', 'labTrend', 'custom'];

export interface ContextField {
  path: string;
  /** 界面上显示的人话名称 */
  label: string;
  /** 分组（界面上按患者 / 就诊 / 医生 / 时间分块，不把十来项堆成一个长下拉） */
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
  /* 模板库页的编辑动作（新建 / 改 / 删）用的码：它们与"装载一份包"不是同一件事，
     各有一个能定位的码，界面才能把"改哪一项出的错"说清楚 */
  | 'E_TPL_ITEM_NOT_FOUND'
  | 'E_TPL_ITEM_NOT_TEMPLATE'
  | 'E_TPL_FIELD_INVALID'
  /* 已发布的文书不许改骨架（它可能已经开出过病历） */
  | 'E_TPL_STATUS_PUBLISHED'
  /* 科室编码对不上科室字典：一个对不上任何人的编码会让这份文书谁都开不出 */
  | 'E_TPL_DEPT_UNKNOWN'
  /* 控件还被文书引用着：删了它，报错会出现在"医生要开那份文书"的时候 */
  | 'E_TPL_EXPR_IN_USE'
  | 'E_TPL_EXPR_UNKNOWN'
  | 'E_TPL_ITEM_TYPE'
  | 'E_TPL_DOC_TYPE_INVALID'
  | 'E_TPL_SECTION_INVALID'
  | 'E_TPL_SLOT_INVALID'
  /* 槽位元数据（显示名 / 从系统带入 / 必填 / 单位）按"章节编码 + 槽位名"定位不到：
     静默改到别的格上是这类改动最坏的形态，所以定位不到就报错 */
  | 'E_TPL_SLOT_NOT_FOUND'
  | 'E_TPL_SLOT_KEY_DUPLICATE'
  | 'E_TPL_EXPR_INVALID'
  | 'E_TPL_EXPR_REF_INVALID'
  /* 控件槽位引用了包里没有的专科控件：装包校验本应先拦下它，
     这里是"引擎绝不静默产出半个节点"的兜底 */
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

/** 表格列允许的取值类型：不含 `expression` —— 派生值要靠槽位名引用具体格子，
 *  而"第 3 行第 2 列"这种位置引用既不稳定（行会增删）也读不懂  */
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
    /* 列上的数据元：标签会落到格子里的填写项上（机器读的是一格一格的值）  */
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
      /* 旧写法（一项一个字符串）在这里明说形状换了：
         报"必须是非空字符串"会让人以为标点写错了，而界面上一保存就会把整条列表改写成新形状。  */
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
      /* 派生值槽位的默认值没有意义（它由表达式算出来），但类型上不拦 —— 拦的是"形状不对" */
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

/**
 * 全包校验：一次把问题报全。
 *
 * 报一条改一条会让写模板的人放弃 —— 而模板是给人写的（专科顾问、临床科室），
 * 他们不该为了找全错误来回试十几遍。
  */
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
  /* 片段在所有条目都扫完之后才校验：与模板同理，它引用的控件可能排在它后面
     （顺序不该决定校验结果），而下面传的是整包的控件表  */
  for (const fragment of fragments) {
    issues.push(...validateFragmentDefinition(fragment, expressions, controlDefs));
  }
  /* 控件同样放在所有条目都扫完之后才校验：它的字段可能引用排在它后面的表达式控件，
     而"条目在数组里的次序"不该决定它能不能装进来  */
  for (const control of controls) {
    issues.push(...validateControlDefinition(control, expressions));
  }
  return issues;
}

/** 单份模板的校验（对外导出，便于"只校验一份模板"的调用方复用同一套规则） */
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

  /* 槽位 key 在整份模板内唯一：表达式按 key 引用填写项，重名会让引用指到别人身上  */
  const keys = new Map<string, TemplateSlot>();
  sections.forEach((section, sectionIndex) => {
    const sectionLabel = `${label}.sections[${sectionIndex}]`;
    if (typeof section.sectionCode !== 'string' || section.sectionCode.trim() === '') {
      issues.push(`${sectionLabel}.sectionCode：必须是非空字符串`);
    }
    if (typeof section.title !== 'string' || section.title.trim() === '') {
      issues.push(`${sectionLabel}.title：必须是非空字符串`);
    }
    /* 章节自身属性（必备 / 关键内容 / 说明）：类型错要在这里报，别等实例化时才炸
       —— `required` 与 `keyContent` 直接决定产出的章节节点能否通过文档校验
       （`model/validate.ts` 只认布尔），而"给了空串说明"与"不写说明"在包内容里是两种指纹。 */
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
      /* 校验槽位形状：类型不认识就报，别等到实例化时才抛
         （`slot` 的取值与 `dataType` 都直接决定产出的节点能否通过文档校验） */
      if (slot.slot === 'field' && !FIELD_TYPES.includes(slot.dataType)) {
        issues.push(`${slotLabel}.dataType：取值非法「${String(slot.dataType)}」（允许 ${FIELD_TYPES.join('/')}）`);
      }
      /* 从系统带入（`from`）：路径必须在白名单里。
         不校验的话，写错的路径表现是"这一格一直是空的" —— 与"医生还没填"长得一模一样，
         而人会去怀疑数据没同步，实际只是路径打错了一个字母。 */
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
      /* 默认值要与数据类型对得上：写错类型不会在任何地方报错 —— 它会一路走到
         派生值求值那里，表现成"这个数怎么也算不出来"，而人只会去怀疑公式写错了。
         复核的代价全落在了真正出错的那一层之外。  */
      if (slot.slot === 'field' && slot.value !== undefined && !matchesFieldType(slot.dataType, slot.value)) {
        issues.push(
          `${slotLabel}.value：默认值${describeValue(slot.value)}与数据类型 ${String(slot.dataType)} 对不上`
            + '（模板给的默认值是**机器真值**，不是展示文本：数字类型给数字、是/否给布尔、其余给字符串）',
        );
      }
      /* 参考范围：只对填写项有意义，且至少给"下限 / 上限 / 文本"里的一个 ——
         只填单位等于什么都没说，却会让界面显示成"这一格配了参考范围"。 */
      if (slot.slot === 'field' && slot.referenceRange !== undefined) {
        issues.push(...validateReferenceRange(slot.referenceRange, `${slotLabel}.referenceRange`));
      }
      if (slot.slot === 'table') {
        issues.push(...validateTableColumns(slot.columns, slot.rows, slotLabel));
        /* 表格不给关键内容：门控的含义是"未人工确认就签不出去"，而医生端没有确认一个表格的入口
           （确认按钮只在文本与填写项上）。标上它等于造出一份签不出去的病历 ——
           门控拦得住，人却不知道去哪儿确认。  */
        if (raw.keyContent !== undefined) {
          issues.push(`${slotLabel}.keyContent：表格不支持关键内容（没有"确认这个表格"这个动作）`);
        }
        /* 表格本身不绑数据元：机器读的是格子里的填写项，标签要配在列上（`columns[].tags`）。
           不收下它 —— 收下之后实例化根本不用这个字段，症状是"模板里配了、机读里一个字都没有"，
           而校验、界面、纸面全都不报错。  */
        if (raw.tags !== undefined) {
          issues.push(`${slotLabel}.tags：表格本身不绑数据元（机器读的是格子里的填写项）——把标签配在列上（columns[].tags）`);
        }
      }
      if (slot.slot === 'list') {
        issues.push(...validateListItems(slot.items, slotLabel));
        /* 与表格一字不差的两条：列表不产数据元（机器读的是填写项），
           而医生端没有"确认这一整条列表"的动作 —— 标上关键内容就是一份签不出去、
           也不知道去哪儿确认的病历。 */
        if (raw.tags !== undefined) {
          issues.push(`${slotLabel}.tags：列表不绑数据元（机器读的是填写项，列表本身不产数据元）`);
        }
        if (raw.keyContent !== undefined) {
          issues.push(`${slotLabel}.keyContent：列表不支持关键内容（医生端没有"确认这一整条列表"这个动作）`);
        }
      }
      /* 图片槽：不绑数据元、也不标关键内容 —— 两条理由都与表格相同。
         图不产数据元（机器读的是填写项）；医生端没有"确认这一张图"的动作，
         标上关键内容等于造一份签不出去、也不知道去哪儿确认的病历。  */
      if (slot.slot === 'image') {
        if (raw.tags !== undefined) {
          issues.push(`${slotLabel}.tags：图片槽不绑数据元（机器读的是填写项，图本身不产数据元）`);
        }
        if (raw.keyContent !== undefined) {
          issues.push(`${slotLabel}.keyContent：图片槽不支持关键内容（医生端没有"确认这一张图"这个动作）`);
        }
      }
      /* 控件槽位：要指明用哪一个专科控件，且不许绑数据元。
         控件不是数据元 —— 机器读的是控件里带 `tag` 的字段（`ControlFieldSnapshot.tag`），
         整体绑一个 tag 只会造出一条值为空、来源不明的数据元。  */
      if (slot.slot === 'control') {
        if (typeof slot.useControl !== 'string' || slot.useControl.trim() === '') {
          issues.push(`${slotLabel}.useControl：必须是非空字符串（控件槽要说明用哪一个专科控件）`);
        }
        /* 行数只对 `series` 有意义（`matrix` 的行列来自控件定义）。给错类型不会当场坏，
           而是开文书时画出一张行数诡异的表 —— 所以在这里就拒。 */
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
      /* 数据元标签（`tags`）：界面上那一格"显示名"与跨文书比对的锚点都靠它。
         在这里校验的原因与 `from` 相同 —— 一条 system 拼错、code 为空的标签，
         后果是"模板改得进去、开出来的病历却只显示槽位名"，或者比对把这个空认成数据元。 */
      if (raw.tags !== undefined) {
        issues.push(...validateDataElementTags(raw.tags, `${slotLabel}.tags`));
      }
      keys.set(raw.key, slot);
    });
  });

  /* 专科控件槽位：引用的控件必须在本包里（同包引用，理由与表达式一字不差）。
     它排在表达式那段之前：下面那条提前返回管的是表达式，
     顺序一换，"片段编辑时不查引用"就会连控件引用一起放过。  */
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
  /* 表达式槽位：控件必须存在，且只能引用本模板内的填写项（field 槽位）。
     `expressions === null` = 不查引用（片段的素材语义，见本函数头的注释）——
     后面再没有别的判定，因此这里提前返回与"整段跳过"等价。  */
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
        /* 只允许引用填写项：派生值依赖另一个派生值会让"这个数怎么来的"变成一条链，
           而链上任何一环变了都要重新解释整条链。一级派生是可复核的边界。  */
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
      /* 影像格的值是一条资源引用：它只能是 `text`。配成数值 / 日期 / 布尔，
         写路径会当场拒（`matchesControlCellType`），而医生看到的只是"这个格填不进去" ——
         症状与原因隔着一整条渲染链，所以必须在装包那一刻就拦下。  */
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

  /* matrix 的行列是形状的一部分：`ControlShape` 里说 matrix 就是"行 × 列"的格子表，
     少了行列渲染出来是一张空表；反过来，别的形状带了行列，界面并不知道拿它做什么。  */
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

function substituteContext(text: string, context: Record<string, string | number | undefined>, warnings: string[]): string {
  return text.replace(/\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g, (_match, path: string) => {
    const value = context[path];
    if (value === undefined || value === '') {
      /* 原样保留 + 告警，不"猜一个"：把取不到的东西悄悄换成空串，
         医生看到的就是一句读不通的话，而没人知道那里本来该有内容  */
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

/** 派生值控件的出处标识：`expr:<包 id>/<控件 id>`（重算时要据此回到包里取公式） */
function expressionRefOf(packId: string, controlId: string): string {
  return `expr:${packId}/${controlId}`;
}

/** 依赖边的出处标识。带 `nodeId` 指向具体的填写项节点 —— 重算的输入就是这些节点当前的值 */
function expressionDepRefOf(packId: string, controlId: string): string {
  return `expr-dep:${packId}/${controlId}`;
}

/** 由 patient / encounter / doctor / at 派生上下文；调用方传入的 `context` 优先（便于测试与替换） */
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
    /* 开单医生：只认"账号"，不认姓名（账号体系里没有姓名字段） */
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

  /* 专科控件定义表：`control` 槽位按 `useControl` 回这里取定义（取不到就抛，见下面的分支） */
  const controlById = new Map<string, ControlDefinition>();
  for (const item of pack.items) if (item.itemType === 'control') controlById.set(item.itemId, item);

  const context = buildContext(input);
  const warnings: string[] = [];
  const source = `${pack.packId}#${template.itemId}@${packFingerprintOf(pack)}`;
  const nodes: Record<NodeId, DocNode> = {};
  const slotNodeIds: Record<string, string> = {};
  /** 填写项的值（表达式按 key 从这里取） */
  const slotValues: Record<string, number | string | null> = {};

  const slotLabels: Record<string, string> = {};
  for (const section of template.sections) {
    for (const slot of section.slots) {
      slotLabels[slot.key] = slot.slot === 'field' ? (slot.tags?.[0]?.display ?? slot.key) : slot.key;
    }
  }

  /** 派生值的依赖边：建完所有槽位后再补（模板里派生槽位可以写在它的填写项之前）  */
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
      /* 章节自身属性抄进节点：`required` 让写路径拒删这一章（`core/session.ts` 的 deleteNode），
         `keyContent` 让"整章算关键内容"落进签名门控。两者只在开文书那一刻抄一次 ——
         模板事后改了不会回头改动已经开出的病历（与槽位属性同一族纪律）。
         不写 `false`：`undefined` 才是"没这一回事"，而 `false` 会在包内容里多出一份指纹差异。  */
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

      /* 结构文本与空段落产出同一种节点：一个 text 节点。差别只在"结构文本那一栏有没有字"——
         段落槽没有 `text` 字段，`raw` 就是 undefined，于是 runs 里是一个空串。
         两处各写一遍的后果是"空段落"与"空的结构文本"在模型里长得不一样，
         而下游（机读、导出、受控阅读）只有一条路能认。  */
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

      /* 图片槽：`resRef` 留空 = 待贴的空槽。这里不校验资源是否存在 ——
         模板不该知道部署里有没有那个文件；真正要验的是导出那一刻（取不到就报 warning）。  */
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
          /* 这一项带格子（"体温 ____ ℃"）：与表格格子同一套 —— 空待填、不编值，
             单位与数据元从模板抄进来。格子自己有一个槽位名（`key.i<项序>`），
             它同时是证据链里的 `field`，于是"这个数从哪一项来的"事后查得清。 */
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
          /* 参考范围照抄进节点，且深拷贝：它是"这一格多少算正常"的机器口径
             （趋势按它标偏高/偏低）。浅拷会让同一份模板开出的多份文书共用同一个对象 ——
             改一份的参考范围，悄悄改到另一份身上，而那正是模板反复实例化最容易踩的坑。  */
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

        /* 表头：第 0 行。行序即列序（`order` 从 10 起递增），单元格里放一段文本 */
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

        /* 数据行：每格一个空填写项。格子的槽位名是 `key.r<行>c<列>`（1 起）——
           它同时是证据链里的 `field`，于是"这个数从哪一格来的"事后查得清，
           而重算仍只认顶层槽位名（格子不参与派生值：行会增删，位置引用不稳定）。  */
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
              /* 空待填：模板不编值。列上给了单位就带上（"32 是什么"要有答案） */
              value: null,
              valueText: '',
              ...(column.unit ? { unit: column.unit } : {}),
              /* 列上绑的数据元落到格子上：机器读的是一格一格的值，
                 表格只是容器（同一列的多行共用同一条标签，`code` 也一致 —— 这正是跨文书比对要的）  */
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
          /* 字段快照：只抄声明那一层。`useExpression`（公式在哪）与 `defaultValue`（初值）
             是定义期语义，不进快照；`axis` 是例外 —— 它回答"这一格在时间轴上、
             趋势按它排"，渲染时不回查包也要知道，所以一起抄。  */
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

      /* 派生值：算不出来就是 null + 告警，不编值  */
      const definition = expressionById.get(slot.useExpression) as ExpressionDefinition;
      const refs = collectExpressionRefs(definition.expression);
      const computed = evaluate(definition.expression, { slots: slotValues, context });
      const fieldId = `${parent}_x${childSeq}`;
      const valueText = computed === null ? '' : String(computed);
      if (computed === null) {
        /* 告警要能指着医生说"去填哪一格" —— 否则它会和"系统坏了"长得一样。
           文案只陈述"还缺什么"，不承诺"填好就自动算"：本版的重算是显式动作
           （正文区「重算派生值」按钮），把它写成自动的，医生一填发现没变就会认为功能坏了。  */
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
          /* 控件出处 + 公式原文：派生值最怕"结果在、公式不见了"  */
          {
            kind: 'template',
            ref: expressionRefOf(pack.packId, definition.itemId),
            field: 'expression',
            valueText: describeExpression(definition.expression),
          },
        ]),
      };
      slotNodeIds[slot.key] = fieldId;
      /* 依赖边等到全部槽位建完再补：模板里派生槽位可以写在它的填写项之前，
         那时 `slotNodeIds` 里还没有那一项 —— 当场建边会漏，而漏了的表现是
         "这个派生值永远算不出来"（重算找不到输入）。  */
      pendingDependencies.push({ fieldId, controlId: definition.itemId, slotKeys: refs.slots });
    }
  }

  /* 补依赖边：每条边指向一个具体的填写项节点，重算据此从文档自身取输入  */
  for (const pending of pendingDependencies) {
    const node = nodes[pending.fieldId];
    if (!node) continue;
    for (const key of pending.slotKeys) {
      const depNodeId = slotNodeIds[key];
      if (typeof depNodeId !== 'string') continue;
      node.provenance.evidence = node.provenance.evidence ?? [];
      /* `field` 放的是槽位名：它必须挂在这条边上，而不是去读输入节点自己的证据 ——
         人工写入会替换 provenance（只保留 AI 的 derivedFrom，不保留 evidence），
         所以输入节点上的槽位名会在医生一填之后就消失，重算再也找不到它（实测踩到过）。  */
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
