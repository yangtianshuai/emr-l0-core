// 模板包（K4 的"包"那一半）。

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

/** 装载期校验：供 `PackRegistry.load` 的 `validate` 钩子使用（装包那一刻就把问题报全） */
export function validateTemplatePack(pack: TemplatePack): void {
  const issues = validateTemplatePackItems(pack);
  if (issues.length > 0) {
    throw new TemplateError('E_TPL_PACK_INVALID', `模板包「${pack.packId}」校验未通过：\n- ${issues.join('\n- ')}`);
  }
}

/** 就诊类型（与文档模型 `encounter.visitType` 同一套取值里的三类"有文书"的） */
export type VisitTypeScope = 'outpatient' | 'emergency' | 'inpatient';

export interface TemplateSummary {
  packId: string;
  templateId: string;
  name: string;
  docType: DocTypeRef;
  /** 这份文书能开在哪些就诊上；空数组 = 不限（认不出类型，就不能替人藏起来）  */
  visitTypes: VisitTypeScope[];
  sectionCount: number;
  slotCount: number;
  expressionCount: number;
}

/**
 * 一份文书能开在哪种就诊上 —— 判据是文书类型本身。
 *
 * 入院记录 / 病程记录 / 出院记录都是住院期间的文书；门（急）诊病历只有门诊与急诊会开
 * （国标里"门（急）诊"本来就是同一种文书，所以这两档共用 `WST500.2`）。
 *
 * 口径放在这一处，而不是让界面自己写一张"哪些能选"的表：
 * 「新建」清单按它过滤，服务端开具校验若也要拦，必须读同一个函数，否则两处迟早分叉。
 *
 * 认不出的类型一律返回空 = 不限：院内自定义（`local`）、导入件、新加的类型，
 * 我们不知道它属于哪一档 —— 不知道就不能替医生把它藏起来，藏了还没法解释。
  */
export function visitTypesOfDocType(docType: DocTypeRef | undefined): VisitTypeScope[] {
  const code = docType?.code ?? '';
  if (code === 'WST500.2') return ['outpatient', 'emergency'];
  if (code === 'WST500.1' || code === 'WST500.3' || code === 'WST500.4') return ['inpatient'];
  return [];
}

export function templateItemsOf(pack: TemplatePack): TemplateDefinition[] {
  return pack.items.filter((item) => item.itemType === 'template') as TemplateDefinition[];
}

/** 包里片段类条目  */
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

/**
 * 是不是草稿。
 *
 * 缺省（不写 `status`）= 已发布：既有包一份都没写这个字段，不能因为加了"草稿"这个概念
 * 就把它们一夜之间全变成开不出的文书。
  */
export function isTemplateDraft(definition: TemplateDefinition): boolean {
  return definition.status === 'draft';
}

/**
 * 这份文书现在开得出吗（`enabled` 与 `status` 两条都要过）。
 *
 * 两个开关回答的是两个问题，合成一个会答不准：
 *   - `status: draft` —— 内容层面"还没定稿"（新建出来的必然是它）；
 *   - `enabled: false` —— 部署层面"这份定了稿的文书，本院暂不开"。
  */
export function isTemplateOpenable(definition: TemplateDefinition): boolean {
  return definition.enabled !== false && !isTemplateDraft(definition);
}

/**
 * 这份文书能不能在某个科室的就诊上用。
 *
 * 口径只有这一处（清单过滤与开具校验共用它，两处各写一遍迟早对不上）：
 *   - 模板没配科室 = 通用 → 任何就诊都能用；
 *   - 配了科室 = 只在这些科能用 → 就诊科室必须在其中；
 *   - 就诊没有科室（历史数据、导入数据）→ 限科室的文书用不了，
 *     并如实报出原因。这里刻意不放行：放行会让"限产科"在缺数据时
 *     静默变成"全院都能开"，那正是这套判定要消灭的那句假话。
  */
export function deptAllowsTemplate(definition: TemplateDefinition, deptCode: string | undefined): boolean {
  const departments = Array.isArray(definition.departments) ? definition.departments.filter((code) => code !== '') : [];
  if (departments.length === 0) return true;
  if (!deptCode) return false;
  return departments.includes(deptCode);
}

/**
 * 已启用模板的清单（界面据此列出"能开哪几种文书"）。
 *
 * `deptCode` 给了就按科室过滤（医生端「新建」里的那一份名单：
 * 列出开不出的文书，等于让医生点进去再被拒一次）。
  */
export function listTemplates(registry: PackRegistry, options: { deptCode?: string } = {}): TemplateSummary[] {
  const out: TemplateSummary[] = [];
  for (const { packId, item } of registry.activeItemsOf('template')) {
    const pack = registry.get(packId) as TemplatePack | undefined;
    if (!pack) continue;
    const definition = item as TemplateDefinition;
    /* 模板包里同时装着表达式控件，必须按 itemType 分辨 ——
       否则控件会被当成"一份没有章节的模板"混进清单（实测：3 份模板 + 5 个控件 = 8 条）  */
    if (definition.itemType !== 'template') continue;
    /* 草稿开不出：它还没定稿，让它出现在"新建"里，医生就会照着它开出结构残缺的病历  */
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
  /** 人类可读公式（界面直接展示"这个控件怎么算"，不要求人去看 AST） */
  formula: string;
}

/** 已启用包里的医学表达式控件清单 */
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

/** 目录里的一个槽位：界面要回答"这一章里都填些什么" */
export interface TemplateCatalogSlot {
  /**
   * 槽位类别：结构文本 / 空段落 / 填写项 / 表达式控件 / 表格 / 专科控件 / 图片。
   *
   * 这份清单必须与 `engine.ts` 的 `SLOT_KINDS` 一致：少一个，界面上那一格就画不出来
   * （`slotViewOf` 的分派落不到它，界面上表现为"这一格空白"，而包里明明有它）。
    */
  kind: 'text' | 'paragraph' | 'field' | 'expression' | 'table' | 'list' | 'control' | 'image';
  /** 模板内的名字（表达式靠它引用填写项） */
  key: string;
  /** 一行人话：填写项报类型与单位，表达式报引用哪个控件，文本报提示语 */
  detail: string;
  /**
   * 绑定的数据元（"这个空填的是什么"）。
   *
   * `system` 也要带给界面：医生端那一格"显示名"改的就是 `tags[0].display`，
   * 保存时要把整条标签原样送回来 —— 只回传 code / display 的话，
   * 在界面上动一下"从系统带入"，WS445 这个体系就悄悄掉了。
   */
  tags?: DataElementTag[];
  required?: boolean;
  dataType?: FieldDataType;
  text?: string;
  useExpression?: string;
  /** 专科控件槽位引用的是哪一份控件定义（`useControl`）—— 与 `useExpression` 同一条理由 */
  useControl?: string;
  unit?: string;
  /** 从系统带入的上下文路径（`encounter.admittedAt` 这类） */
  from?: string;
  keyContent?: boolean;
  value?: JsonValue;
  referenceRange?: ReferenceRange;
  newParagraph?: boolean;
  /**
   * 表格的列（`kind === 'table'`）。`tags` 必须一起带出来：列上绑的数据元落在格子上，
   * 抽屉要原样回显、原样回写 —— 少带这一项，表现是"列还是那几列、数据元没了"，
   * 而机读从此对不上（库里那一份也已经没有标签了）。
    */
  columns?: Array<{ title: string; dataType?: FieldDataType; unit?: string; tags?: DataElementTag[] }>;
  rows?: number;
  items?: TemplateListItem[];
  ordered?: boolean;
  /**
   * 图片槽的三项（只有 `kind === 'image'` 才有）。
   *
   * 同样要原样回显、原样回写：`altText` 与 `caption` 在抽屉里各有输入格，
   * 而 `resRef` 没有（模板不携带图片文件）—— 但它可能来自手写包，
   * 抽屉读不回来就等于"改一次别的、保存时把地址清掉"，而库里那一份再也回不去。
    */
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

/** 一份文书引用到的医学表达式控件：把公式与开关一并带出来，界面不必再回查一次 */
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
  /** 条目类别：一份文书（`template`）／一个医学表达式控件（`expression`）／一个章节片段（`fragment`）／一个专科控件（`control`） */
  itemType: 'template' | 'expression' | 'fragment' | 'control';
  name: string;
  enabled: boolean;
  status: 'draft' | 'active';
  /** 一行人话：模板报"什么文书 · 几章几槽"，控件报公式 */
  detail: string;
  /** 文书类型（控件条目为 undefined） */
  docType?: { system: string; code: string; display: string };
  /** 适用科室。空 = 通用（全院都能开）；今天只作标注，不参与"能不能开"的判定  */
  departments: string[];
  /** 能不能照着它开文书：`enabled` 与 `status` 两条都要过 */
  openable: boolean;
  /** 控件条目的公式（AST）：编辑控件时构造器要回显它 */
  expression?: ExprNode;
  /** 控件条目的单位与说明（也可回显） */
  unit?: string;
  shape?: ControlShape;
  controlVersion?: number;
  /**
   * 语义类型与完整字段定义：编辑那一屏要原样回显 ——
   * 少给一格，表现就是"库里配了三格、编辑框里只剩两格"，而人一保存就把它清掉了。
    */
  controlKind?: ControlKind;
  fields?: ControlFieldDef[];
  /** `matrix` 形状的行列（同样要能回显；其它条目为 undefined） */
  rows?: Array<{ key: string; label: string }>;
  columns?: Array<{ key: string; label: string }>;
  description?: string;
  /** 章节与槽位（控件条目为空数组） */
  sections: TemplateCatalogSection[];
  /** 这份文书引用到的控件（控件条目为空数组） */
  controls: TemplateCatalogControl[];
}

/**
 * 模板类条目的完整目录（含已停用的）。
 *
 * 与 `listTemplates` 的分工：`listTemplates` 只回答"能开哪几种文书"（医生端用），
 * 而管控要看得见"装了什么、哪一条被停了" —— 停用的条目不列出来，
 * "这一条是没装还是被关了"就永远分不开（与规则侧 `qcRuleCatalog` 同一口径）。
  */
export function templateCatalogOf(registry: PackRegistry): TemplateCatalogEntry[] {
  const out: TemplateCatalogEntry[] = [];
  /* 按 packId 排序走一遍：装载顺序不该决定界面顺序（跨包条目 id 唯一，谁在前都得住） */
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
          /* 片段开不出文书：它只是一段素材。`openable` 问的是"能不能照着它开一份"，
             答案是明确的"不能" —— 填 true 会让"能不能开"这个判据在界面上失去意义。  */
          openable: false,
          sections: catalogSectionsOf(sections, controlById, controlDefById),
          /* 片段不列 `controls`：插入时是按槽位上的 `useExpression` 逐个核对的，
             这里再列一份只会多一处"两处口径"（`sections[].slots[].useExpression` 已经是权威） */
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
          /* 专科控件没有"草稿 / 已发布"这道门：它开不出病历，只是"填的时候用哪个格子"。
             给它加一道发布门，只会让"想配一个量表"变成"先撤稿"。它与片段一样是素材，
             差别只在片段被拼进章节、控件被填进格子。  */
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
          /* 与表达式控件条目同一口径：`openable` 在这一层是"这一条现在可用吗"。
             控件与表达式都不是文书，真正的判据（`enabled`）对它们一致。 */
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

/** 这一串章节引用了哪些表达式控件（去重，保持出现顺序 —— 界面按这个顺序报"缺哪个控件"） */
function usedControlsOf(sections: TemplateSection[]): string[] {
  const used: string[] = [];
  for (const section of sections) {
    for (const slot of section.slots ?? []) {
      if (slot.slot === 'expression' && !used.includes(slot.useExpression)) used.push(slot.useExpression);
    }
  }
  return used;
}

/** 这一串章节引用了哪些专科控件（与上面那个表达式版本并列：字段名不同，判据一样）  */
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
  /** 把引用的控件定义复制一份进目标包，并把 `sections` 里指向它的引用改成新 id */
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

  /* 先控件、后表达式：专科控件的字段可以引用表达式控件（"这一格由那个公式算出来"），
     所以复制一个控件时要连它的公式依赖一起带过来 —— 反过来先处理表达式，这一批就漏了，
     而漏了的表现是"复制出来的文书校验不过：控件里引用了一个包里没有的表达式"。
     两条队列都写成"边处理边追加"：控件带进来的表达式引用会接着被处理。  */
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

/** 槽位的一行人话。界面不该逼人去读 JSON 才知道"这个空是填什么的" */
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
    /* 空段落这一行不能说"文本（结构提示）"：那会让人以为这里本该有字、只是模板没填。
       它要说的恰恰相反 —— 这块留白是有意的，字由医生写。  */
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
      /* 列上的数据元必须一起带出去：少带这一项，表现是"列还是那几列、数据元没了"，
         而机读从此对不上（库里那一份也已经没有标签了） */
      ...(column.tags !== undefined ? { tags: column.tags } : {}),
    }));
    if (slot.rows !== undefined) view.rows = slot.rows;
  } else if (slot.slot === 'list') {
    /* 列表这一行要答"有几项、编号还是圆点"。项一条都不在这里展开 ——
       抽屉按 `items` 原样回显，把内容抄进 `detail` 只会多一处会漂移的副本。  */
    view.detail = `列表：${slot.items.length} 项（${slot.ordered ? '编号' : '圆点'}）`
      + `${slot.items.some((item) => item.field) ? ' · 带填写格' : ''}`;
    /* 深拷贝：目录对象会被抽屉拿去当"当前表单"，与包里的对象共享引用的话，
       抽屉里改一个字就是在改库里的那一份（保存时指纹对不上，还查不出是谁改的） */
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
    /* 专科控件：这一行要答的是"用的是哪一份控件、里面有几格、填几条"。
       形状（量表 / 趋势 / 网格 / 清单）不在这一行里 —— 它是条目本身的属性，
       目录里已经有 `shape`，界面自己拼中文名（形状的中文名只有一处，在界面那侧）。  */
    const control = controlDefById.get(slot.useControl);
    const fieldCount = control ? (control.fields ?? []).length : 0;
    view.detail = `专科控件：${control?.name ?? slot.useControl}（${slot.useControl}）`
      + `${control ? ` · ${fieldCount} 格` : ''}${slot.rows ? ` · ${slot.rows} 行` : ''}`;
    view.useControl = slot.useControl;
    if (slot.rows !== undefined) view.rows = slot.rows;
  }
  /* 单位与关键内容：编辑抽屉读不回来，一保存就清掉了，所以逐项判类别。
     - 单位只在填写项与表达式控件上有（表格的单位在列上、专科控件在字段上，
       结构文本 / 空段落 / 图片根本不是"填一个数"）；
     - 关键内容要求医生端有"确认这一项"的动作：表格没有"确认这张表"，
       图片也没有"确认这一张图"（见 engine.ts 的槽位校验）—— 写进目录会造出一份
       签不出去、也无处确认的病历。 */
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
  /** 空数组 = 通用（全院都能开）  */
  departments?: string[];
  /** 草稿 / 已发布。发布是显式动作：保存完不会悄悄上线  */
  status?: 'draft' | 'active';
  sections?: TemplateSection[];
  slotMeta?: SlotMetaPatch[];
  sectionMeta?: SectionMetaPatch[];
}

export interface SlotMetaPatch {
  sectionCode: string;
  key: string;
  /** 从系统带入的取值路径（`null` = 不带入）；只对填写项有意义 */
  from?: string | null;
  /** 必填（`false` = 去掉必填）；只对填写项有意义 */
  required?: boolean;
  /** 单位（`null` = 清掉）；结构文本没有单位 */
  unit?: string | null;
  /**
   * 医生端看到的名字（写进 `tags[0].display`）；`null` = 清掉显示名，回到按槽位名显示。
   *
   * 原来没有标签的槽位会按 `local` + 槽位名记一条数据元：
   * 标签的形状要求 system 与 code 齐备，只写一个显示名的标签会让产出的文档校验不过。
    */
  display?: string | null;
  keyContent?: boolean;
  /** 模板预设的默认值（`null` = 清掉，回到空待填）；只对填写项有意义 */
  value?: JsonValue | null;
  /** 参考范围（`null` = 清掉）；只对填写项有意义 */
  referenceRange?: ReferenceRange | null;
  /** 强制另起一段（`false` = 去掉）；结构文本本来就另起一段，给它没有意义 */
  newParagraph?: boolean;
}

export interface SectionMetaPatch {
  sectionCode: string;
  /** 必备章节（`false` = 去掉）；只在之后开出的病历上生效  */
  required?: boolean;
  /** 关键内容（`false` = 去掉） */
  keyContent?: boolean;
  /** 章节说明（`null` = 清掉） */
  description?: string | null;
}

/** 包内表达式控件表（校验骨架时要按它查 `useExpression` 引用得到底是什么） */
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

/** 包内专科控件表（槽位的 `useControl` 要按它查引用是不是真的存在） */
function controlDefsOf(pack: TemplatePack): Map<string, ControlDefinition> {
  const map = new Map<string, ControlDefinition>();
  for (const item of pack.items) {
    if (item.itemType === 'control') map.set(item.itemId, item);
  }
  return map;
}

/** 把"适用科室"这一列收成一个规范形式：去重保序，空 = 不写这个字段（= 通用） */
function normalizeDepartments(values: string[]): { list?: string[] } {
  const list: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed === '' || seen.has(trimmed)) continue;
    seen.add(trimmed);
    list.push(trimmed);
  }
  /* 空 = 通用 = 不写这个字段（而不是写一个空数组）：
     写空数组会让"改回原样"回不到原内容指纹 —— 于是"我把它改回去了"与
     "它还是另一版"分不开，而可逆是这条编辑口子唯一的安全感。  */
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
  /* `sections` 与元数据补丁（`slotMeta` / `sectionMeta`）表达的是两件不相容的事，不能一起交：
     `sections` 是整份骨架（每一格的显示名 / 单位 / 从系统带入 / 必填 / 关键内容 / 默认值 /
     参考范围，以及每一章的必备 / 关键内容 / 说明都写全了），两个 `*Meta` 是
     在库里那份骨架上再打一遍补丁 —— 同送时后者会盖掉前者，
     而"该照哪一份算"没有任何共识。
     与其让内核替调用方挑一个（那是猜），不如让它明说意图。  */
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
    /* 已发布的文书不许改骨架：它可能已经开出过病历 */
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
  /* 元数据补丁必须改在复制出来的一份上：`patchTemplateMeta` 的硬要求是
     原包一个字不动 —— 直接改 `next.sections` 里的对象会把库里那一份也改掉
     （两边还是同一批引用）。两个补丁块共用这一份复制，所以用一个标志位保证只拷一次。  */
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
      /* 表格没有元数据档：列定义与行数属于骨架（只有草稿能改），它也不接受
         显示名 / 从系统带入 / 必填 / 单位 / 默认值 / 参考范围 / 关键内容 / 另起一段 ——
         格子里才是填写项，表格本身没有"这一格叫什么、从哪儿带、多少算正常"这回事。
         送到这里就明说，而不是逐项悄悄忽略（忽略会让调用方以为改成功了）。  */
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
        /* 没要求改任何东西：这一条到此为止（表格没有元数据档） */
        continue;
      }
      /* 列表与表格同一条：项与有序性是骨架（只有草稿能改），
         也没有显示名 / 单位 / 关键内容这些元数据 ——
         列表不产数据元，医生端也没有"确认这一整条列表"的动作。  */
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
        /* 清掉时删字段而不是写空串：空串过不了校验（"取值路径必须是非空字符串"），
           而界面上"不填（留空待填）"就是这个意思  */
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
        /* 三类没有单位：结构文本是固定文字、空段落连字都没有、图片是一张图 ——
           它们都不是"填一个数"。收下它只会让包里多一个永远不被读到的字段。 */
        if (slot.slot === 'text' || slot.slot === 'paragraph' || slot.slot === 'image') {
          const label = slot.slot === 'text' ? '结构文本' : slot.slot === 'paragraph' ? '空段落' : '图片槽';
          throw new TemplateError('E_TPL_FIELD_INVALID', `${at}是${label}：${label}没有单位（单位只对填写项与表达式控件有意义）`);
        }
        /* 控件整体没有单位：单位在它里面的字段上（同一个控件里体温是 ℃、血压是 mmHg，
           整体给一个单位必然有一个是错的）—— 在这里明说，而不是悄悄忽略  */
        if (slot.slot === 'control') {
          throw new TemplateError('E_TPL_FIELD_INVALID', `${at}是专科控件：控件整体没有单位（单位配在控件里的字段上）`);
        }
        const unit = item.unit === null ? '' : item.unit.trim();
        if (unit === '') delete slot.unit;
        else slot.unit = unit;
      }
      if (item.display !== undefined) {
        /* 控件不绑数据元（机器读的是控件里带 `tag` 的字段）：明说，而不是悄悄忽略 ——
           忽略会让调用方以为"显示名改成功了"，而界面上那一格永远是键名 */
        if (slot.slot === 'control') {
          throw new TemplateError('E_TPL_FIELD_INVALID', `${at}是专科控件：控件不绑数据元（要绑就绑在控件里的字段上）`);
        }
        /* 空段落与图片槽同样不产数据元：机器读的是填写项。段落的字由医生写、图是一张图，
           给它们各绑一条 tag 只会造出一条值为空、来源不明的数据元。 */
        if (slot.slot === 'paragraph' || slot.slot === 'image') {
          throw new TemplateError(
            'E_TPL_FIELD_INVALID',
            `${at}是${slot.slot === 'paragraph' ? '空段落' : '图片槽'}：不绑数据元（机器读的是填写项，这一格不产数据元）`,
          );
        }
        const display = item.display === null ? '' : item.display.trim();
        const tags = Array.isArray(slot.tags) ? [...slot.tags] : [];
        if (display === '') {
          /* 清掉的是显示名，不是这个数据元：code 还要留给跨文书比对  */
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
        /* 图片槽不支持（与表格同一条理由）：医生端没有"确认这一张图"的动作，
           标上去等于造一份签不出去、也不知道去哪儿确认的病历。 */
        if (slot.slot === 'image') {
          throw new TemplateError('E_TPL_FIELD_INVALID', `${at}是图片槽：图片不支持关键内容（医生端没有"确认这一张图"这个动作）`);
        }
        if (item.keyContent) slot.keyContent = true;
        else delete slot.keyContent;
      }
      if (item.newParagraph !== undefined) {
        /* 结构文本与空段落本来就另起一段：这一项对它们没有意义（段落更是只剩这一个属性） */
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
        /* 清掉时删字段而不是写 `null`：`null` 与"不写"在引擎里意思相近，
           但在包内容里是两种指纹 —— 可逆是这条编辑口子唯一的安全感（改回原样要能改回原指纹）  */
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
      /* 按编码定位要求编码在模板内唯一，而校验里今天没有这条约束（只校验非空）。
         因此这里多做一步：重码时直接拒绝，而不是改到"第一个同码的章节"上 ——
         悄悄改错章节比报错糟得多，而编码本来就该是唯一的（它还是跨文书比对的锚点）。  */
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
        /* 清掉时删字段而不是写空串：空串过不了校验（"说明必须是非空字符串"），
           而界面上把说明清空就是这个意思 —— 与 `SlotMetaPatch` 的 `unit` 同一处理  */
        const description = item.description === null ? '' : String(item.description).trim();
        if (description === '') delete section.description;
        else section.description = description;
      }
    }
  }
  /* 骨架当场校验一遍：写包时也会校验整包，但那时报的是"整包不通过"，
     而人需要知道的是"第几章第几个槽位不对"。 */
  const issues = validateTemplateDefinition(next, expressionsOf(pack), controlDefsOf(pack));
  if (issues.length > 0) {
    throw new TemplateError('E_TPL_PACK_INVALID', `这份文书改完通不过校验：\n- ${issues.join('\n- ')}`);
  }
  const items = pack.items.slice();
  items[index] = next;
  return { ...pack, items };
}

/** 自建（非交付方提供）的模板包 id：界面上新建的文书与控件都放这一份里  */
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
  /** 空 = 通用 */
  departments?: string[];
  /** 不给则给一份最小骨架（一章一个文本槽位）：新建出来的是草稿，骨架由人接着改  */
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

/** 一份能过校验的最小骨架：一章"正文"、一个文本槽位  */
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
  /**
   * 一并从源包复制过来的控件（原名 → 新名）。
   *
   * 目标包里已有同名控件的那些不在这里（它们是复用，没有改名）：界面要能说清
   * "这份副本带了 2 个控件过来、另有 1 个用的是本院已有的"，否则人只会看到
   * 控件库里凭空多出两条而不知道谁建的。
    */
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
    /* 两类引用都从源包里找：表达式控件与专科控件（控件自带字段与形状，漏带它
       等于复制出一份校验不过的文书）  */
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
  /** 公式（AST）：由界面上的构造器搭出来 —— 不存在"文本能写但引擎读不懂"这一档 */
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

/**
 * 删掉一份文书：返回一份新包，原包不动。
 *
 * 已开出的病历不受影响（病历里只有模板指纹，模板不在了指纹还在，
 * 只是"出自哪一份"查不到内容了）。这条要说在界面上，否则"删掉一份文书"
 * 听起来像"删掉一批病历"。
  */
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
  /** 新公式（AST）：由界面上的构造器搭出来 */
  expression?: ExprNode;
}

/** 哪些文书在用这个控件（按槽位引用找）。删除前要看它，改公式前也要说清影响面。  */
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
    /* 空 = 不要这个字段（而不是留一个空串）：空串会让"改回原样"回不到原内容指纹 */
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

/**
 * 删一个医学表达式控件：返回一份新包，原包不动。
 *
 * 被文书引用时拒绝（`E_TPL_EXPR_IN_USE`，并列出是哪些文书在用）：
 * 删掉它会让那些文书校验不过（"控件库中没有「x」"），而报错出现的时候是
 * 医生要开那份文书的时候 —— 那时人早就想不起自己前段时间删过什么。
 * 拦住它的代价是"先去把引用它的槽位改掉"，而那条路看得见、走得通。
  */
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
  /** `matrix` 形状的行（如 32 颗牙）；其它形状不给（多给了界面也不知道拿它做什么） */
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
    /* 新建恒为 v1：版本回答的是"这份定义改到第几版"，不是"建过几次" */
    version: 1,
    fields: structuredClone(input.fields) as ControlFieldDef[],
    ...(Array.isArray(input.rows) ? { rows: structuredClone(input.rows) } : {}),
    ...(Array.isArray(input.columns) ? { columns: structuredClone(input.columns) } : {}),
    ...(typeof input.description === 'string' && input.description.trim() !== ''
      ? { description: input.description.trim() }
      : {}),
  };
  /* 校验只在这一条上做，但引用查的是整包的表达式表：字段的 `useExpression` 必须落在
     同一个包里（跨包引用会让"这份控件的算法"取决于装了哪些包，而装机每台都不一样）  */
  const issues = validateControlDefinition(definition, expressionsOf(base));
  if (issues.length > 0) {
    throw new TemplateError('E_TPL_PACK_INVALID', `这个控件通不过校验：\n- ${issues.join('\n- ')}`);
  }
  return { pack: { ...base, items: [...base.items, definition] }, itemId };
}

export interface ControlPatch {
  name?: string;
  /** `null` = 清掉说明（空说明与没有说明是同一件事） */
  description?: string | null;
  controlKind?: ControlKind;
  shape?: ControlShape;
  /** 整份字段表替换：字段的增删改都在这一份里（不必为"改一格的单位"再开一个口子） */
  fields?: ControlFieldDef[];
  /** `matrix` 的行列；`null` = 清掉 */
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
          ? '它是医学表达式控件（那是"这个值怎么算"，走「基础数据 → 表达式控件」那一页改）'
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
    /* 空 = 不要这个字段（而不是留一个空串）：空串会让"改回原样"回不到原内容指纹 */
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

  /* 语义一变就升版（名称与说明不算）：这条由代码保证，不靠人记得改 */
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

/**
 * 删一个专科控件：返回一份新包，原包不动。
 *
 * 与表达式控件不同，这里今天没有"还被谁引用"的检查：文书的槽位还没有"控件"这一类，
 * 所以没有任何东西会引用它。等槽位能引用控件之后，这条检查必须补上 ——
 * 否则删掉它，报错会出现在"医生要开那份文书"的时候，而那时人早就想不起自己删过什么。
  */
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
  /** 片段内容：一串章节（顺序即插入顺序）。至少要有一章 —— 空片段插进去什么都不会发生 */
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
  /** 空串 = 清掉说明（而不是留一个空串的说明，那会让"改回原样"回不到原内容指纹） */
  description?: string;
  /** 整份内容替换（片段没有"骨架 vs 元数据"两档：它本来就只是素材） */
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

