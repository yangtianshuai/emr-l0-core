// 质控条件树（封闭）：判定条件的"数据化"落点。

import type { JsonValue } from '../model/types.ts';
import type { QcConditionParamKind, QcConditionParamSpec, QcContext, QcNodeView } from './types.ts';

/* ========================= 共用常量（谓词侧也从这里取） =========================
   下面这几份表被 `predicates.ts` 一起引用。放在这里的理由只有一条：
   同一份清单只能有一处。已踩过的坑是"界面能选、引擎不认"——
   两处各写一份的代价不是多打几个字，而是一个只在有人真的点了它的时候才暴露的错。  */

export const TIME_PATTERNS: readonly RegExp[] = [
  /\d{4}\s*[-/年.]\s*\d{1,2}\s*[-/月.]\s*\d{1,2}/, // 2026-10-09 / 2026年10月9日 / 2026.10.9
  /\d{1,2}\s*月\s*\d{1,2}\s*日/, // 10月9日
  /\d{1,2}\s*[:：]\s*\d{2}/, // 14:30
  /\d{1,2}\s*时\s*(\d{1,2}\s*分)?/, // 14时 / 14时30分
];

export const hasTimeExpression = (text: string): boolean => TIME_PATTERNS.some((pattern) => pattern.test(text));

/** 就诊类型。只写这一处：谓词参数的下拉与条件树的取值域都读它  */
export const VISIT_TYPES: readonly string[] = ['outpatient', 'inpatient', 'emergency', 'physical-exam'];

export const QC_CONDITION_ID_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;

export function asPlainObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** 拒绝未知参数名 / 未知键（拼错一格会让规则静默按别的意思跑，而"改了没生效"最难查） */
export function rejectUnknownParams(source: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(source).every((key) => allowed.includes(key));
}

export type QcConditionField =
  | 'text'
  | 'tags'
  | 'nodeType'
  | 'keyContent'
  | 'origin'
  | 'sectionCode'
  | 'recordedAt'
  | 'docType'
  | 'visitType'
  /**
   * 就诊文书（T2 新增）：同一次就诊下的文书清单（`ctx.visitDocs`）。
   *
   * 它不是一个"标量字段"，而是一族聚合取值器的输入 —— 跨文书的判定
   * （同类文书间隔、应有而缺）全部落在这一格上。做成字段而不是另起一种谓词，
   * 是为了让"跨文书"这件事也能被拼进条件树、被组合。
   *
   * 边界与两个内核谓词完全一致：拿不到清单 → `uncertain`（不猜）；清单里有一份
   * 成文时间无法解析 → `uncertain`（跳过会让"时间坏了"变成"那段时间没文书"）。
    */
  | 'visitDocs';

export type QcConditionOperator =
  | 'contains'
  | 'not-contains'
  | 'empty'
  | 'empty-with-tag'
  | 'has-tag'
  | 'matches-pattern'
  | 'length-less-than'
  | 'length-greater-than'
  | 'missing-pattern'
  | 'older-than-hours'
  | 'gap-exceeds-hours'
  | 'missing-within-hours'
  | 'in'
  | 'not-in'
  | 'is';

export interface QcConditionAtom {
  kind: 'atom';
  field: QcConditionField;
  op: string;
  /** 取值。形状由算子的取值规格决定；不接受取值的算子（如"正文为空"）不写这个字段 */
  value?: JsonValue;
}

/**
 * 条件树。
 *
 * 只有四种节点，与模板公式同一取舍：AST 没有语法、只有结构 ——
 * 校验它就是在校验一棵 JSON 树，错了能精确指到哪一个节点（`path`）。
 * 接受字符串表达式就得自己写解析器，而"多一层可错的语法"在这里没有任何回报。
  */
export type QcConditionNode =
  | { kind: 'all'; children: QcConditionNode[] }
  | { kind: 'any'; children: QcConditionNode[] }
  | { kind: 'not'; child: QcConditionNode }
  | QcConditionAtom;

/**
 * 一条条件的判定结论。
 *
 * `hit: false` 同时覆盖"不适用"与"不命中"——两者在医生眼里是同一件事（不提示），
 * 分开只会多一处需要维护的口径。但判不了必须单列：它与前两者都不是一回事。
  */
export type QcConditionVerdict =
  /**
   * 命中。`quote` 是命中处的原文片段（可选，只有"文字片段类"算子给得出）：
   * 它必须逐字出现在节点正文里 —— 下游（锚点重定位）靠它判断"那句话还在不在"，
   * 所以不能拿整段顶上（拿整段时"改了一个字"也会被判成"还在"，那正是重定位要避免的）。
    */
  | { hit: true; quote?: string }
  | { hit: false }
  | { uncertain: string };

/** 规模上限。必须有：条件树是外部数据，没有上限时一份包能拖垮每次质控扫描  */
export const QC_CONDITION_LIMITS = {
  maxDepth: 4,
  maxChildren: 20,
  maxWordLength: 64,
  maxParams: 8,
} as const;

export const QC_CONDITION_PLACEHOLDER_PATTERN = /^\$[A-Za-z][A-Za-z0-9_]{0,63}$/;

export function isPlaceholderValue(value: unknown): value is string {
  return typeof value === 'string' && QC_CONDITION_PLACEHOLDER_PATTERN.test(value);
}

/** 占位符名（去掉 `$`） */
export function placeholderNameOf(value: string): string {
  return value.slice(1);
}

export interface QcConditionOption {
  value: string;
  label: string;
}

export interface QcConditionFieldSpec {
  name: QcConditionField;
  label: string;
  /** 取值形态：界面据此决定"这一格能填什么"，引擎据此决定读出来是什么 */
  kind: 'text' | 'string-list' | 'enum' | 'boolean' | 'time';
  /**
   * 作用位置 —— 它决定界面上归哪一组，不改变判定：
   *   - `document`：整篇文书都一样（文书类型、就诊类型）→ 界面归入「适用范围」
   *   - `node`：逐节点不同 → 界面归入「判定条件」
    */
  scope: 'document' | 'node';
  options?: readonly QcConditionOption[];
  doc: string;
}

/**
 * 算子的取值规格。
 *
 * `record`（T2 新增）是聚合取值器的那一档：取值不是一个标量，而是"挑哪一类文书、
 * 阈值多少"这样一组具名格（如 `{ docTypeCode, hours }`）。它不是"嵌套对象"——
 * 只有这一层、格名封闭，所以它没有把取值变成一门可递归的小语言。
  */
export interface QcConditionValueFieldSpec {
  name: string;
  label: string;
  kind: 'string' | 'integer';
  /** 整数的单位（只用于人话回读） */
  unit?: string;
  required?: boolean;
  doc: string;
}

export type QcConditionValueSpec =
  | {
      kind: 'string-list' | 'integer' | 'boolean' | 'enum';
      unit?: string;
      options?: readonly QcConditionOption[];
      doc: string;
    }
  | { kind: 'record'; fields: readonly QcConditionValueFieldSpec[]; doc: string };

export interface QcConditionOperatorSpec {
  /**
   * 算子名。内置的在类型里封闭（`QcConditionOperator`），插件带来的扩展名是自由字符串 ——
   * 于是"这条规则用了哪个算子"永远读得出来，而"哪些算子是内核自带"这件事也不会被搅混。
    */
  name: string;
  label: string;
  /** 只能用在哪些字段上。只写这一处：界面照它筛可选项，引擎照它校验  */
  fields: readonly QcConditionField[];
  /** 取值那一格的规格；`null` = 这个算子不接受取值 */
  value: QcConditionValueSpec | null;
  doc: string;
  evaluate?(node: QcNodeView, atom: QcConditionAtom, ctx: QcContext): QcConditionVerdict | null;
  explain?(node: QcNodeView, atom: QcConditionAtom, ctx: QcContext): { detail: string; suggestion: string; quote?: string } | null;
}

/** 就诊类型：值 + 人话名（只写这一处，谓词参数下拉与条件树取值域共用） */
export const VISIT_TYPE_OPTIONS: readonly QcConditionOption[] = [
  { value: 'outpatient', label: '门诊' },
  { value: 'inpatient', label: '住院' },
  { value: 'emergency', label: '急诊' },
  { value: 'physical-exam', label: '体检' },
];

/**
 * 节点类型。
 *
 * 与 `src/model/types.ts` 的 `NodeType` 对齐。列全而不是只列常用的四种：
 * 列一半会让"给表格单元定一条规则"变成一件做不到的事，而使用者只会以为是自己没找对地方。
  */
const NODE_TYPE_OPTIONS: readonly QcConditionOption[] = [
  { value: 'document', label: '整篇文书' },
  { value: 'section', label: '章节' },
  { value: 'paragraph', label: '段落' },
  { value: 'text', label: '文本段' },
  { value: 'field', label: '填写项' },
  { value: 'control', label: '控件' },
  { value: 'table', label: '表格' },
  { value: 'tableRow', label: '表格行' },
  { value: 'tableCell', label: '表格单元' },
  { value: 'image', label: '图像' },
  { value: 'listGroup', label: '列表组' },
  { value: 'listItem', label: '列表项' },
  { value: 'signatureBlock', label: '签名区' },
  { value: 'extension', label: '扩展节点' },
];

const ORIGIN_OPTIONS: readonly QcConditionOption[] = [
  { value: 'human', label: '人工录入' },
  { value: 'ai', label: 'AI 生成' },
  { value: 'system', label: '系统写入' },
  { value: 'imported', label: '外部导入' },
];

const PATTERN_OPTIONS: readonly QcConditionOption[] = [
  { value: 'time', label: '时间表述（2026-10-09 / 10月9日 / 14:30 / 14时）' },
];

/**
 * 模板占位文字的内置模式（T2 新增）。
 *
 * 与 `predicates.ts` 的 `placeholder-residue` 用的是同一份正则（就写在下面），
 * 两处各写一份的后果是"同一条规则在两种判法下给出不同结论"，而没人会想到去比对它们。
  */
export const PLACEHOLDER_PATTERN = /(待补充|待填写|待完善|待补|TODO|FIXME|\bXXX+\b|\bxxx+\b)/i;

export function hasPlaceholderExpression(text: string): boolean {
  return PLACEHOLDER_PATTERN.test(text);
}

/**
 * 命中处的原文片段（与 `hasPlaceholderExpression` 同一份正则，不另写一份）。
 *
 * 它单独存在，是因为"命中"与"凭什么命中"要一起给出来：医生要能核对被引的那几个字，
 * 下游还要拿它做锚点重定位（`quote` 逐字出现在正文里，重定位才有意义）。
 */
export function matchPlaceholderExpression(text: string): string | null {
  const matched = PLACEHOLDER_PATTERN.exec(text);
  return matched ? matched[0] : null;
}

const PLACEHOLDER_PATTERN_OPTIONS: readonly QcConditionOption[] = [
  { value: 'placeholder', label: '模板占位文字（待补充 / 待填写 / TODO / XXX 等）' },
];

export const QC_CONDITION_FIELDS: Record<QcConditionField, QcConditionFieldSpec> = {
  docType: {
    name: 'docType',
    label: '文书类型码',
    kind: 'text',
    scope: 'document',
    doc: '本文书的文书类型码（文档 docType.code，如 WST500.1）。留空/未装载类型码的文书读不到它，那条规则不命中。',
  },
  visitType: {
    name: 'visitType',
    label: '就诊类型',
    kind: 'enum',
    scope: 'document',
    options: VISIT_TYPE_OPTIONS,
    doc: '本次就诊的类型。同一时限在不同就诊类型下未必通用 —— 这是最常见的一格「适用范围」。',
  },
  nodeType: {
    name: 'nodeType',
    label: '节点类型',
    kind: 'enum',
    scope: 'node',
    options: NODE_TYPE_OPTIONS,
    doc: '这一类判定作用在哪种节点上。逐段落的判定要限定成「文本段」，否则章节与文书根会各报一次同样的提示。',
  },
  keyContent: {
    name: 'keyContent',
    label: '是否关键内容',
    kind: 'boolean',
    scope: 'node',
    doc: '关键内容在 AI 采纳时走更严的门控（0.90）。用它把规则收窄到关键内容，或刻意只判非关键内容。',
  },
  sectionCode: {
    name: 'sectionCode',
    label: '章节码',
    kind: 'text',
    scope: 'node',
    doc: '章节节点上的章节码。只对章节节点有值：拿它把规则限定到"主诉""现病史"这样的某一节。',
  },
  origin: {
    name: 'origin',
    label: '内容来源',
    kind: 'enum',
    scope: 'node',
    options: ORIGIN_OPTIONS,
    doc: '这段内容是谁写进来的。用它区分"人写的"与"AI 生成的"，或专门盯外部导入件。',
  },
  recordedAt: {
    name: 'recordedAt',
    label: '记录时间',
    kind: 'time',
    scope: 'node',
    doc: '该节点的系统内写入时刻（provenance.at），不是文书里写的临床记录时间。补录、迁移、外部导入会让两者差出几天 —— 所以导入件一律走"判不了"而不是"超时"。',
  },
  text: {
    name: 'text',
    label: '段落正文',
    kind: 'text',
    scope: 'node',
    doc: '节点的正文。只有「文本段」有正文 —— 章节与文书根的正文是空的，所以正文类算子一律只对文本段判定（否则每个章节都会命中）。',
  },
  tags: {
    name: 'tags',
    label: '数据元标签',
    kind: 'string-list',
    scope: 'node',
    doc: '节点上挂的数据元标签。用它把规则收窄到"带某个数据元标签的段落"。',
  },
  visitDocs: {
    name: 'visitDocs',
    label: '就诊文书（跨文书）',
    kind: 'string-list',
    scope: 'document',
    doc: '同一次就诊下的文书清单（从调用方传入）。它只能用「同类文书间隔超限」「应有而缺」这两档算子 —— 其余算子对它没有意义。拿不到清单时这两档走"判不了"，不猜。',
  },
};

/** 字段在界面上的排列顺序（就是这份数组的顺序，界面不另排一份） */
export const QC_CONDITION_FIELD_ORDER: readonly QcConditionField[] = [
  /* 先「适用范围」：整篇文书都一样的那几格，摆在最前面（它们决定这条规则管不管这份文书） */
  'docType',
  'visitType',
  'nodeType',
  'sectionCode',
  'keyContent',
  'origin',
  'text',
  'tags',
  'recordedAt',
  /* 跨文书放在最后：它是唯一一格"要调用方补上下文"的，不该和普通字段混在一起挑 */
  'visitDocs',
];

/** 词表取值的规格：多数算子共用，写一次（改一处就等于改掉所有用它的算子） */
function wordsValueSpec(doc: string): NonNullable<QcConditionOperatorSpec['value']> {
  return { kind: 'string-list', doc };
}

export const QC_CONDITION_OPERATORS: Record<QcConditionOperator, QcConditionOperatorSpec> = {
  in: {
    name: 'in',
    label: '属于（任一）',
    fields: ['docType', 'visitType', 'nodeType', 'origin', 'sectionCode'],
    value: wordsValueSpec('命中其中一个即算满足。每格都不能为空 —— 空值会匹配到一切，等于把这条规则变成噪声源。'),
    doc: '字段的取值落在给出的清单里。字段读不到时不命中（宁可不报，不可误报）。',
  },
  'not-in': {
    name: 'not-in',
    label: '不属于（全部）',
    fields: ['docType', 'visitType', 'nodeType', 'origin', 'sectionCode'],
    value: wordsValueSpec('清单里一个都不等于才算满足。'),
    doc: '字段的取值不在给出的清单里。字段读不到时同样不命中 —— 拿"读不到"当成"不属于"，会把系统缺数据变成一条质控结论。',
  },
  is: {
    name: 'is',
    label: '等于',
    fields: ['keyContent'],
    value: { kind: 'boolean', doc: '真 / 假。' },
    doc: '布尔字段的等值判断（目前只有「是否关键内容」）。',
  },
  contains: {
    name: 'contains',
    label: '包含（任一）',
    fields: ['text'],
    value: wordsValueSpec('词表里任一词出现在正文里即算满足。例如"待补充、TODO"。'),
    doc: '正文里出现词表中的任一词。只对文本段判定 —— 章节与文书根的正文是空的，对它们判"包不包含"必然得出错的结论。',
    /* 依据必须写出命中的那个词：医生看到"本段包含「待补充」"才知道该去改哪几个字；
       只给一句"包含下列词之一"等于让人自己在正文里找  */
    explain: (node, atom) => {
      const matched = wordsOf(atom).find((word) => node.text.includes(word));
      if (matched === undefined) return null;
      return {
        detail: `本段正文包含「${matched}」。`,
        suggestion: `把「${matched}」替换为实际内容（或确认它确实是正文的一部分）。`,
        quote: matched,
      };
    },
  },
  'not-contains': {
    name: 'not-contains',
    label: '不包含（全部）',
    fields: ['text'],
    value: wordsValueSpec('词表里一个词都不出现才算满足。'),
    doc: '正文里一个词都没出现。只对文本段判定（理由同上）。',
  },
  empty: {
    name: 'empty',
    label: '为空（去空白后）',
    fields: ['text'],
    value: null,
    doc: '正文去掉首尾空白与换行后为空。只对文本段判定。',
    explain: (node) => (node.text.trim() === ''
      ? { detail: '本段正文去掉首尾空白后为空。', suggestion: '补写这一段的内容。' }
      : null),
  },
  'empty-with-tag': {
    name: 'empty-with-tag',
    label: '带标签但正文为空',
    fields: ['tags'],
    value: wordsValueSpec('带其中任一个标签、且正文为空才算满足。'),
    doc: '带指定的数据元标签、但正文为空 —— "必填项没填"最常见的写法。没有标签的空白段落不算：它可能本就不必填，报它会误伤。',
    /* 依据要列出节点上的标签：医生据此核对"该填的是哪一项"，而不是只知道"有个必填项空着"  */
    explain: (node) => (node.text.trim() === '' && node.tags.length > 0
      ? {
        detail: `本段带数据元标签「${node.tags.join('」、「')}」，但正文去掉首尾空白后为空。`,
        suggestion: '补写这一段的内容；若这一项确实不必填，请去掉它的数据元标签（否则每一轮质控都会报它）。',
      }
      : null),
  },
  'length-less-than': {
    name: 'length-less-than',
    label: '字数少于',
    fields: ['text'],
    value: { kind: 'integer', unit: '字', doc: '正整数。按去掉首尾空白后的字符数计。' },
    doc: '正文短于给定字数。常用来拦"主诉只写了两个字"这类明显不完整的记录。',
  },
  'length-greater-than': {
    name: 'length-greater-than',
    label: '字数多于',
    fields: ['text'],
    value: { kind: 'integer', unit: '字', doc: '正整数。按去掉首尾空白后的字符数计。' },
    doc: '正文长于给定字数。常用来拦"把整篇模板抄进一格"这类明显异常的填写。',
  },
  'missing-pattern': {
    name: 'missing-pattern',
    label: '缺少内置模式',
    fields: ['text'],
    value: {
      kind: 'enum',
      options: PATTERN_OPTIONS,
      doc: '第一版只给"时间表述"一档。自由正则由界面填写不做 —— 写得松会"什么都像时间"，那正是这套质控最想避免的方向。',
    },
    doc: '正文里没有出现指定的内置模式。模式的写法在内核里（保守，只认几种明确写法），不由配置决定。',
    explain: (node) => (hasTimeExpression(node.text)
      ? null
      : {
        detail: '本段未识别到任何时间表述（已按 2026-10-09 / 10月9日 / 14:30 / 14时 等写法检查）。',
        suggestion: '补记记录时间，并核对与上一条记录的时间间隔。',
      }),
  },
  'older-than-hours': {
    name: 'older-than-hours',
    label: '距入院超过',
    fields: ['recordedAt'],
    value: { kind: 'integer', unit: '小时', doc: '正整数。正好等于不报（要求是"在 N 小时内完成"，压线算完成）。' },
    doc: '该节点的记录时间距就诊/入院时刻超过 N 小时。缺入院时刻、节点没有记录时间、或本文书由外部导入时走"判不了"，既不报也不静默放过。',
  },
  'has-tag': {
    name: 'has-tag',
    label: '带任意数据元标签',
    fields: ['tags'],
    value: null,
    doc: '节点上挂了至少一个数据元标签（不限定是哪一个）。它补的是"必填项为空"少了的那一格：「带标签 且 正文为空」里，前一格用「属于（任一）」表达不出来 —— 那一档要求先把标签名写出来。',
    /* 它常常与「为空」一起拼成"带标签且正文为空"，所以依据只写它知道的这一半：
       命中时把标签列出来，另一半个由「为空」那一格补上（`explainConditionHit` 会把两格并成一句） */
    explain: (node) => (node.tags.length > 0
      ? {
        detail: `本段带数据元标签「${node.tags.join('」、「')}」。`,
        suggestion: '核对这一段是否应当有内容。',
      }
      : null),
  },
  'matches-pattern': {
    name: 'matches-pattern',
    label: '含内置模式',
    fields: ['text'],
    value: {
      kind: 'enum',
      options: PLACEHOLDER_PATTERN_OPTIONS,
      doc: '第一版只给"模板占位文字"一档。注意它用的是内置正则（大小写不敏感、"XXX"按词边界匹配），与「包含（任一）」的子串包含不完全等价 —— 要的是精确口径就用内置判定方式「模板占位符未替换」。',
    },
    doc: '正文里出现了指定的内置模式。模式的写法在内核里，不由配置决定（自由正则不做：写得松会"什么都像占位文字"）。',
    explain: (node) => {
      const matched = matchPlaceholderExpression(node.text);
      if (matched === null) return null;
      return {
        detail: `本段含未替换的模板占位文字「${matched}」。占位符留在正文里，会被下游（打印、导出、机读）当成真实内容。`,
        suggestion: `把「${matched}」替换为实际内容。`,
        quote: matched,
      };
    },
  },
  'gap-exceeds-hours': {
    name: 'gap-exceeds-hours',
    label: '同类文书间隔超过',
    fields: ['visitDocs'],
    value: {
      kind: 'record',
      fields: [
        { name: 'docTypeCode', label: '文书类型码', kind: 'string', required: true, doc: '按哪一类文书的成文时刻算间隔，如 WST500.3（病程记录）。必填。' },
        { name: 'hours', label: '最大间隔', kind: 'integer', unit: '小时', required: true, doc: '同类文书之间不得超过它。必须大于 0。已出院时右端取出院时刻（不把"出院后没再写"算成缺漏）。' },
      ],
      doc: '同一次就诊内，同一类文书的成文时刻之间不得超过 N 小时（含最后一份到出院/现在那一段）。一份都没有时本档不报 —— 那种情况由「应有而缺」负责，两条都报会得到重复提示。',
    },
    doc: '同一次就诊内同类文书的间隔超限。拿不到就诊文书清单时走"判不了"。',
    /* 文案与算法在同一次计算里算出：依据里那些数字必须就是判定用的那个 */
    explain: (node, atom, ctx) => explainOf(evaluateVisitGap(node, atom, ctx)),
  },
  'missing-within-hours': {
    name: 'missing-within-hours',
    label: '应有而缺（期限内）',
    fields: ['visitDocs'],
    value: {
      kind: 'record',
      fields: [
        { name: 'docTypeCode', label: '文书类型码', kind: 'string', required: true, doc: '哪一类文书应当有，如 WST500.1（入院记录）。必填。' },
        { name: 'hours', label: '期限内', kind: 'integer', unit: '小时', required: true, doc: '就诊/入院后多少小时内应当有。必须大于 0。期限未到不报 —— 还没到点就说"没有"是催命，不是质控。' },
      ],
      doc: '就诊/入院后 N 小时内应当有某一类文书。与「距入院超过」互斥：那档判"有了但写晚了"，这档判"压根没有"。',
    },
    doc: '应有而缺的文书。缺入院时刻、拿不到就诊文书清单时走"判不了"。',
    explain: (node, atom, ctx) => explainOf(evaluateVisitMissing(node, atom, ctx)),
  },
};

/** 算子在界面上的排列顺序 */
export const QC_CONDITION_OPERATOR_ORDER: readonly QcConditionOperator[] = [
  'contains',
  'not-contains',
  'empty',
  'empty-with-tag',
  'has-tag',
  'matches-pattern',
  'missing-pattern',
  'length-less-than',
  'length-greater-than',
  'older-than-hours',
  'gap-exceeds-hours',
  'missing-within-hours',
  'in',
  'not-in',
  'is',
];

const FIELD_BY_NAME = new Map<QcConditionField, QcConditionFieldSpec>(
  QC_CONDITION_FIELD_ORDER.map((name) => [name, QC_CONDITION_FIELDS[name]]),
);
const OPERATOR_BY_NAME = new Map<string, QcConditionOperatorSpec>(
  QC_CONDITION_OPERATOR_ORDER.map((name) => [name, QC_CONDITION_OPERATORS[name]]),
);

const EXTENDED_OPERATORS = new Map<string, QcConditionOperatorSpec>();

/** 插件带来的算子名（按注册顺序）。界面与文档用它回答"这台机器上多出了什么" */
export function extendedOperatorNames(): string[] {
  return [...EXTENDED_OPERATORS.keys()];
}

export class QcOperatorRegistrationError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export function registerConditionOperator(spec: QcConditionOperatorSpec): void {
  if (typeof spec.name !== 'string' || !/^[a-z][a-z0-9-]{2,47}$/.test(spec.name)) {
    throw new QcOperatorRegistrationError('E_OPERATOR_NAME_INVALID', `算子名「${String(spec.name)}」不合法：小写字母开头的 3-48 位（小写字母 / 数字 / 短横线）`);
  }
  if (OPERATOR_BY_NAME.has(spec.name)) {
    throw new QcOperatorRegistrationError('E_OPERATOR_NAME_TAKEN', `算子名「${spec.name}」已被占用（内置或已注册的插件算子）—— 重名会让"这条规则怎么算"取决于装了哪个插件`);
  }
  if (!Array.isArray(spec.fields) || spec.fields.length === 0) {
    throw new QcOperatorRegistrationError('E_OPERATOR_FIELDS_INVALID', `算子「${spec.name}」必须声明能用在哪些字段上`);
  }
  for (const field of spec.fields) {
    if (!FIELD_BY_NAME.has(field)) {
      throw new QcOperatorRegistrationError('E_OPERATOR_FIELDS_INVALID', `算子「${spec.name}」引用了不存在的字段「${String(field)}」—— 界面上拼不出来的算子等于不存在`);
    }
  }
  if (typeof spec.evaluate !== 'function') {
    throw new QcOperatorRegistrationError('E_OPERATOR_EVALUATE_MISSING', `算子「${spec.name}」没有实现：没有实现的算子会让引用它的规则永远不命中，而界面上一切正常`);
  }
  if (typeof spec.label !== 'string' || spec.label.trim() === '' || typeof spec.doc !== 'string' || spec.doc.trim() === '') {
    throw new QcOperatorRegistrationError('E_OPERATOR_NAME_INVALID', `算子「${spec.name}」必须带人话名与说明（界面上唯一能读到"它怎么算"的地方）`);
  }
  OPERATOR_BY_NAME.set(spec.name, spec);
  EXTENDED_OPERATORS.set(spec.name, spec);
}

/** 撤销一个插件算子（只给自测与插件卸载用：装着跑过一轮之后要能回到干净状态）  */
export function unregisterConditionOperator(name: string): boolean {
  if (!EXTENDED_OPERATORS.has(name)) return false;
  EXTENDED_OPERATORS.delete(name);
  OPERATOR_BY_NAME.delete(name);
  return true;
}

export function conditionFieldSpec(name: string): QcConditionFieldSpec | null {
  return FIELD_BY_NAME.get(name as QcConditionField) ?? null;
}

export function conditionOperatorSpec(name: string): QcConditionOperatorSpec | null {
  return OPERATOR_BY_NAME.get(name as QcConditionOperator) ?? null;
}

/* ================================= 校验 =================================
   不合法即拒，不做"取值不合法就用默认值"的兜底 ——
   兜底会让"我配的条件没生效"变成一件没人能发现的事（与 `predicates.ts` 同一条纪律）。  */

function normalizeWords(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  if (raw.length === 0) return null;
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') return null;
    const word = item.trim();
    /* 空词会匹配到一切：直接拒，而不是"过滤掉"—— 过滤会让使用者以为自己配上了 */
    if (word === '' || word.length > QC_CONDITION_LIMITS.maxWordLength) return null;
    if (!out.includes(word)) out.push(word);
  }
  return out;
}

function normalizeAtom(raw: Record<string, unknown>, allowPlaceholders: boolean): QcConditionAtom | null {
  if (!rejectUnknownParams(raw, ['kind', 'field', 'op', 'value'])) return null;
  const field = typeof raw.field === 'string' ? conditionFieldSpec(raw.field) : null;
  const op = typeof raw.op === 'string' ? conditionOperatorSpec(raw.op) : null;
  if (!field || !op) return null;
  /* 字段 × 算子的组合必须合法：把"字数少于"用在文书类型码上，算出来的东西没有意义 */
  if (!op.fields.includes(field.name)) return null;

  if (op.value === null) {
    if (raw.value !== undefined) return null;
    return { kind: 'atom', field: field.name, op: op.name };
  }

  const spec = op.value;
  const value = raw.value;
  if (value === undefined) return null;

  /* 占位符：整格替换。这里只认"它是个占位符"，
     具体形态（整数？词表？）要等实参代入后由同一段校验判 —— 于是
     "占位符最终落成什么类型"不会有两处说法。  */
  if (allowPlaceholders && isPlaceholderValue(value)) {
    return { kind: 'atom', field: field.name, op: op.name, value };
  }

  if (spec.kind === 'string-list') {
    const words = normalizeWords(value);
    if (!words) return null;
    if (words.length > QC_CONDITION_LIMITS.maxChildren) return null;
    return { kind: 'atom', field: field.name, op: op.name, value: words };
  }
  if (spec.kind === 'integer') {
    /* 必须是正整数：`0` / 负数 / 小数会得到"永远成立"或"永远不成立"的规则，而它看起来是配好的 */
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) return null;
    return { kind: 'atom', field: field.name, op: op.name, value };
  }
  if (spec.kind === 'boolean') {
    if (typeof value !== 'boolean') return null;
    return { kind: 'atom', field: field.name, op: op.name, value };
  }
  /* record（聚合取值器）：只有这一层、格名封闭 —— 拒未知格、拒缺必填格、逐格判类型 */
  if (spec.kind === 'record') {
    const record = asPlainObject(value);
    if (!record) return null;
    const names = spec.fields.map((item) => item.name);
    if (!rejectUnknownParams(record, names)) return null;
    const out: Record<string, JsonValue> = {};
    for (const item of spec.fields) {
      const fieldValue = record[item.name];
      if (fieldValue === undefined) {
        if (item.required === true) return null;
        continue;
      }
      /* 聚合取值器里的格同样可以是占位符（如 `{docTypeCode: "$docTypeCode", hours: 72}`）：
         它是"哪一类文书"这个选择器的实参，形态在代入后由同一段校验判 */
      if (allowPlaceholders && isPlaceholderValue(fieldValue)) {
        out[item.name] = fieldValue;
        continue;
      }
      if (item.kind === 'string') {
        /* 空串会被当成"不过滤"，于是那条规则静默地对全部文书生效 —— 直接拒 */
        if (typeof fieldValue !== 'string' || fieldValue.trim() === '') return null;
        out[item.name] = fieldValue;
        continue;
      }
      if (typeof fieldValue !== 'number' || !Number.isInteger(fieldValue) || fieldValue < 1) return null;
      out[item.name] = fieldValue;
    }
    return { kind: 'atom', field: field.name, op: op.name, value: out };
  }
  /* enum */
  const options = (spec.options ?? []).map((option) => option.value);
  if (typeof value !== 'string' || !options.includes(value)) return null;
  return { kind: 'atom', field: field.name, op: op.name, value };
}

/**
 * 校验并归一化一棵条件树。返回 `null` = 结构或取值不合法。
 *
 * 调用方（谓词的 `normalizeParams`）据此显式拒绝，而不是带着一份"以为配了、其实没配"的
 * 条件跑起来。这一步在装包那一刻就会跑（`validateRulePack` → `resolveRule`），
 * 于是"条件写错"在还有人看着的时候就报出来，而不是等医生点了"跑质控"才发现少了一条。
  */
export function normalizeCondition(raw: unknown, depth = 0, allowPlaceholders = false): QcConditionNode | null {
  if (depth > QC_CONDITION_LIMITS.maxDepth) return null;
  const source = asPlainObject(raw);
  if (!source) return null;
  const kind = source.kind;

  if (kind === 'all' || kind === 'any') {
    if (!rejectUnknownParams(source, ['kind', 'children'])) return null;
    const children = source.children;
    if (!Array.isArray(children)) return null;
    if (children.length === 0 || children.length > QC_CONDITION_LIMITS.maxChildren) return null;
    const out: QcConditionNode[] = [];
    for (const child of children) {
      const normalized = normalizeCondition(child, depth + 1, allowPlaceholders);
      if (!normalized) return null;
      out.push(normalized);
    }
    return kind === 'all' ? { kind: 'all', children: out } : { kind: 'any', children: out };
  }

  if (kind === 'not') {
    if (!rejectUnknownParams(source, ['kind', 'child'])) return null;
    const child = normalizeCondition(source.child, depth + 1, allowPlaceholders);
    if (!child) return null;
    return { kind: 'not', child };
  }

  if (kind === 'atom') return normalizeAtom(source, allowPlaceholders);
  return null;
}

export function collectPlaceholders(condition: QcConditionNode): string[] {
  const out: string[] = [];
  const remember = (value: unknown): void => {
    if (isPlaceholderValue(value)) {
      const name = placeholderNameOf(value);
      if (!out.includes(name)) out.push(name);
      return;
    }
    /* 聚合取值器的格（`{docTypeCode: "$docTypeCode", hours: 72}`）也算用到 */
    const record = asPlainObject(value);
    if (!record) return;
    for (const entry of Object.values(record)) {
      if (isPlaceholderValue(entry)) {
        const name = placeholderNameOf(entry);
        if (!out.includes(name)) out.push(name);
      }
    }
  };
  const walk = (node: QcConditionNode): void => {
    if (node.kind === 'all' || node.kind === 'any') {
      for (const child of node.children) walk(child);
      return;
    }
    if (node.kind === 'not') {
      walk(node.child);
      return;
    }
    remember(node.value);
  };
  walk(condition);
  return out;
}

/**
 * 把占位符替换成实参，返回未校验的 JSON 树。
 *
 * 刻意不在这里校验：替换完必须再过一次 `normalizeCondition`（不允许占位符），
 * 于是"代入后的树是否合法"与"内联一棵树是否合法"永远是同一段代码在判 ——
 * 两处各判一遍的后果是"占位符代入把类型换错了"只在扫描期表现为"这条规则不出现"。
  */
export function substitutePlaceholders(condition: QcConditionNode, args: Record<string, JsonValue>): JsonValue {
  /* 实参缺失不在这里兜底：调用方必须先做必填校验，缺了就不该走到这一步。
     真走到了，就把原占位符留下 —— 代入后那次校验会拒掉它（fail-closed）  */
  const fill = (value: unknown): unknown => {
    if (isPlaceholderValue(value)) {
      const name = placeholderNameOf(value);
      return Object.prototype.hasOwnProperty.call(args, name) ? (args[name] as JsonValue) : value;
    }
    const record = asPlainObject(value);
    if (!record) return value;
    const out: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(record)) out[key] = fill(entry) as JsonValue;
    return out;
  };

  const walk = (node: QcConditionNode): JsonValue => {
    if (node.kind === 'all' || node.kind === 'any') {
      return { kind: node.kind, children: node.children.map(walk) } as JsonValue;
    }
    if (node.kind === 'not') {
      return { kind: 'not', child: walk(node.child) } as JsonValue;
    }
    const out: Record<string, JsonValue> = { kind: 'atom', field: node.field, op: node.op };
    if (node.value !== undefined) out.value = fill(node.value) as JsonValue;
    return out as JsonValue;
  };
  return walk(condition);
}

/** 条件树里有几个原子（界面与日志用它回答"这条规则到底判了几件事"） */
export function conditionAtomCount(condition: QcConditionNode): number {
  if (condition.kind === 'all' || condition.kind === 'any') {
    return condition.children.reduce((sum, child) => sum + conditionAtomCount(child), 0);
  }
  if (condition.kind === 'not') return conditionAtomCount(condition.child);
  return 1;
}

/* ============================== 参数规格（T1） ==============================
   判定方式是数据，参数是它唯一被开放的部分。所以这一层的纪律与条件树本身一致：
   形状封闭、名字封闭、不合法一律拒、不做兜底。  */

export const QC_CONDITION_PARAM_KINDS: readonly { name: QcConditionParamKind; label: string; doc: string }[] = [
  { name: 'integer', label: '正整数', doc: '阈值：小时数、字数、条数。0 与负数一律拒 —— 它们会得到"永远成立"或"永远不成立"的规则。' },
  { name: 'string', label: '单行文本', doc: '一个非空字符串：文书类型码、章节码。' },
  { name: 'enum', label: '枚举', doc: '取值只能落在给定的选项里（如就诊类型）。' },
  { name: 'string-list', label: '词表', doc: '一组非空词。元素不能为空串 —— 空串会匹配到一切。' },
  { name: 'boolean', label: '真 / 假', doc: '布尔取值（如"是否关键内容"）。' },
];

const PARAM_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/**
 * 校验并归一化一条判定方式的参数规格。返回 `null` = 不合法（一律拒，不兜底）。
 *
 * `undefined` / `null` 都当"没有参数"（老包原样兼容）。空数组同样合法 ——
 * 它表示"这条判定方式显式声明不带参数"，与缺省在判定上等价。
 */
export function normalizeConditionParams(raw: unknown): QcConditionParamSpec[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return null;
  if (raw.length > QC_CONDITION_LIMITS.maxParams) return null;

  const out: QcConditionParamSpec[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const source = asPlainObject(item);
    if (!source) return null;
    if (!rejectUnknownParams(source, ['name', 'kind', 'label', 'required', 'options', 'unit', 'doc'])) return null;

    const name = source.name;
    if (typeof name !== 'string' || !PARAM_NAME_PATTERN.test(name)) return null;
    if (seen.has(name)) return null; /* 重名会让"填的是哪一格"变成两处说法 */
    seen.add(name);

    const kind = source.kind;
    if (typeof kind !== 'string' || !QC_CONDITION_PARAM_KINDS.some((entry) => entry.name === kind)) return null;

    const label = source.label;
    if (typeof label !== 'string' || label.trim() === '') return null;
    const doc = source.doc;
    if (typeof doc !== 'string' || doc.trim() === '') return null;

    const spec: QcConditionParamSpec = { name, kind: kind as QcConditionParamKind, label, doc };

    if (source.required !== undefined) {
      if (typeof source.required !== 'boolean') return null;
      spec.required = source.required;
    }
    if (source.unit !== undefined) {
      if (typeof source.unit !== 'string' || source.unit.trim() === '') return null;
      spec.unit = source.unit;
    }

    if (kind === 'enum') {
      const options = normalizeWords(source.options);
      if (!options) return null; /* 枚举没有选项 = 谁都填不进去 */
      spec.options = options;
    } else if (source.options !== undefined) {
      /* 只有枚举带选项：别的类型带它，说明使用者以为它生效了 —— 拒 */
      return null;
    }
    out.push(spec);
  }
  return out;
}

export function validateConditionArgs(
  specs: readonly QcConditionParamSpec[],
  raw: unknown,
): Record<string, JsonValue> | null {
  const source = raw === undefined || raw === null ? {} : asPlainObject(raw);
  if (!source) return null;
  if (!rejectUnknownParams(source, specs.map((spec) => spec.name))) return null;

  const out: Record<string, JsonValue> = {};
  for (const spec of specs) {
    const value = source[spec.name];
    if (value === undefined) {
      if (spec.required === true) return null;
      continue;
    }
    if (spec.kind === 'integer') {
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) return null;
      out[spec.name] = value;
      continue;
    }
    if (spec.kind === 'boolean') {
      if (typeof value !== 'boolean') return null;
      out[spec.name] = value;
      continue;
    }
    if (spec.kind === 'string') {
      if (typeof value !== 'string' || value.trim() === '') return null;
      out[spec.name] = value;
      continue;
    }
    if (spec.kind === 'enum') {
      if (typeof value !== 'string' || !(spec.options ?? []).includes(value)) return null;
      out[spec.name] = value;
      continue;
    }
    const words = normalizeWords(value);
    if (!words) return null;
    out[spec.name] = words;
  }
  return out;
}

function wordsOf(atom: QcConditionAtom): string[] {
  return Array.isArray(atom.value) ? (atom.value.filter((item): item is string => typeof item === 'string')) : [];
}

/** 取字段的当前值。取不到就给 `undefined`：由各算子按"宁可不报"处置，不在这里替它猜  */
function fieldTextOf(node: QcNodeView, field: QcConditionField, ctx: QcContext): string | undefined {
  switch (field) {
    case 'docType':
      return ctx.docTypeCode;
    case 'visitType':
      return ctx.visitType;
    case 'nodeType':
      return node.type;
    case 'sectionCode':
      return node.sectionCode;
    case 'origin':
      return node.origin;
    case 'recordedAt':
      return node.recordedAt;
    case 'text':
      return node.text;
    /* 下面两个不是"一个字符串"：`tags` 是清单（由算子自己读），`keyContent` 是布尔 */
    case 'tags':
    case 'keyContent':
      return undefined;
    default:
      return undefined;
  }
}

/* --------------------------- 跨文书（T2：聚合取值器） ---------------------------
   下面两档算子的语义与 `predicates.ts` 的两个跨文书谓词逐条对齐：
   右端取出院时刻（或判定时刻）、一份都没有时不报、期限未到不报、时间解析不出走"判不了"。
   实现在这里、而不是在 predicates 里各写一份：同一份口径只能有一处。  */

interface VisitTimelineDoc {
  docId: string;
  at: number;
  title?: string;
}

/** 取出该就诊下同一类文书的成文时刻；有无法解析的 → 判不了（不猜）  */
export function visitTimelineOf(
  visitDocs: readonly { docId: string; docTypeCode: string; createdAt: string; title?: string }[],
  docTypeCode: string,
): { ok: true; docs: VisitTimelineDoc[] } | { ok: false; reason: string } {
  const picked: VisitTimelineDoc[] = [];
  for (const item of visitDocs) {
    if (item.docTypeCode !== docTypeCode) continue;
    const at = Date.parse(item.createdAt);
    /* 时间解析不出来的文书不能静默跳过：跳过会让"有一份时间坏了的文书"变成
       "那段时间没有文书"，从而把一次真实缺漏算成正常，或把正常算成缺漏 —— 两种都是错的。  */
    if (!Number.isFinite(at)) return { ok: false, reason: `文书 ${item.docId} 的成文时间无法解析（${item.createdAt}）` };
    picked.push({ docId: item.docId, at, ...(item.title ? { title: item.title } : {}) });
  }
  picked.sort((left, right) => left.at - right.at);
  return { ok: true, docs: picked };
}

const hoursOf = (ms: number): number => ms / 3_600_000;

type VisitVerdict =
  | { kind: 'uncertain'; reason: string }
  /** 不报：不适用、或明确不命中（两者在医生眼里是同一件事） */
  | { kind: 'none' }
  | { kind: 'hit'; detail: string; suggestion: string };

function recordOf(atom: QcConditionAtom): Record<string, JsonValue> {
  return (asPlainObject(atom.value) ?? {}) as Record<string, JsonValue>;
}

/** 「同类文书间隔超过」：判定与文案同一次算出（文案里的数字必须就是判定用的那个）  */
function evaluateVisitGap(node: QcNodeView, atom: QcConditionAtom, ctx: QcContext): VisitVerdict {
  if (node.type !== 'document') return { kind: 'none' };
  if (ctx.visitDocs === undefined) return { kind: 'uncertain', reason: '本次判定没有拿到同一次就诊的文书清单，频次无法计算' };

  const record = recordOf(atom);
  const docTypeCode = String(record.docTypeCode);
  const maxGapHours = Number(record.hours);
  const timeline = visitTimelineOf(ctx.visitDocs, docTypeCode);
  if (!timeline.ok) return { kind: 'uncertain', reason: timeline.reason };
  const docs = timeline.docs;
  if (docs.length === 0) return { kind: 'none' }; /* 由「应有而缺」负责，两条都报会得到重复提示 */

  const now = Date.parse(ctx.now);
  if (!Number.isFinite(now)) return { kind: 'uncertain', reason: `判定时刻无法解析：${ctx.now}` };
  const discharged = ctx.dischargedAt === undefined ? Number.NaN : Date.parse(ctx.dischargedAt);
  const end = Number.isFinite(discharged) ? Math.min(now, discharged) : now;
  const endLabel = Number.isFinite(discharged) && discharged < now ? `出院时刻 ${ctx.dischargedAt}` : `判定时刻 ${ctx.now}`;

  let worst = { gap: Number.NEGATIVE_INFINITY, from: docs[0] as VisitTimelineDoc, toLabel: '' };
  for (let index = 1; index < docs.length; index += 1) {
    const from = docs[index - 1] as VisitTimelineDoc;
    const to = docs[index] as VisitTimelineDoc;
    const gap = to.at - from.at;
    if (gap > worst.gap) worst = { gap, from, toLabel: `下一份（${to.docId}）` };
  }
  const tail = end - (docs[docs.length - 1] as VisitTimelineDoc).at;
  /* 末尾那一段同样要判：最后一份病程记录之后一直没写，正是最常见的缺漏 */
  if (tail > worst.gap) {
    worst = { gap: tail, from: docs[docs.length - 1] as VisitTimelineDoc, toLabel: endLabel };
  }

  if (worst.gap <= maxGapHours * 3_600_000) return { kind: 'none' };
  return {
    kind: 'hit',
    detail:
      `同类文书（${docTypeCode}）之间不得超过 ${maxGapHours} 小时，`
      + `实际最长间隔 ${hoursOf(worst.gap).toFixed(1)} 小时：自 ${new Date(worst.from.at).toISOString()}（${worst.from.docId}）到 ${worst.toLabel}。`
      + `本次就诊共 ${docs.length} 份该类文书。`,
    suggestion: '补记缺漏的文书；若该时段确实无需记录（如已转科、已出院），请核对该就诊的起止时间是否准确。',
  };
}

/** 「应有而缺（期限内）」 */
function evaluateVisitMissing(node: QcNodeView, atom: QcConditionAtom, ctx: QcContext): VisitVerdict {
  if (node.type !== 'document') return { kind: 'none' };
  if (ctx.visitDocs === undefined) {
    return { kind: 'uncertain', reason: '本次判定没有拿到同一次就诊的文书清单，无法判断"应有而缺"的文书' };
  }
  if (ctx.admittedAt === undefined || ctx.admittedAt === '') {
    return { kind: 'uncertain', reason: '本文书没有就诊/入院时间（文档 encounter.admittedAt），期限无法计算' };
  }
  const baseline = Date.parse(ctx.admittedAt);
  const now = Date.parse(ctx.now);
  if (!Number.isFinite(baseline)) return { kind: 'uncertain', reason: `入院时间无法解析：${ctx.admittedAt}` };
  if (!Number.isFinite(now)) return { kind: 'uncertain', reason: `判定时刻无法解析：${ctx.now}` };

  const record = recordOf(atom);
  const docTypeCode = String(record.docTypeCode);
  const withinHours = Number(record.hours);
  const deadline = baseline + withinHours * 3_600_000;
  /* 期限还没到：此刻"没有"是正常的，报它就是催命 */
  if (now <= deadline) return { kind: 'none' };

  const timeline = visitTimelineOf(ctx.visitDocs, docTypeCode);
  if (!timeline.ok) return { kind: 'uncertain', reason: timeline.reason };
  const docs = timeline.docs;
  if (docs.some((item) => item.at <= deadline)) return { kind: 'none' };

  const earliest = docs.length > 0
    ? `，最早一份是 ${new Date((docs[0] as VisitTimelineDoc).at).toISOString()}（${(docs[0] as VisitTimelineDoc).docId}）`
    : '';
  return {
    kind: 'hit',
    detail:
      `入院后 ${withinHours} 小时内应当有「${docTypeCode}」类文书，`
      + `实际该期限内没有任何一份${earliest}。入院时间 ${ctx.admittedAt}，期限 ${new Date(deadline).toISOString()}。`,
    suggestion: '补写该文书；若该文书存在于其它系统，请确认是否已完成数据对接（本系统只统计已进入本系统的文书）。',
  };
}

function verdictOf(outcome: VisitVerdict): QcConditionVerdict {
  if (outcome.kind === 'hit') return { hit: true };
  if (outcome.kind === 'uncertain') return { uncertain: outcome.reason };
  return { hit: false };
}

function explainOf(outcome: VisitVerdict): { detail: string; suggestion: string } | null {
  return outcome.kind === 'hit' ? { detail: outcome.detail, suggestion: outcome.suggestion } : null;
}

function evaluateAtom(node: QcNodeView, atom: QcConditionAtom, ctx: QcContext): QcConditionVerdict {
  const words = wordsOf(atom);

  /* 正文类算子只对文本段判定：章节与文书根的正文是空串，
     对它们判"包不包含 / 是否为空"会得出一个看似合理其实是错误的结论  */
  const textOnly = (): QcConditionVerdict | null => (node.type === 'text' ? null : { hit: false });
  const trimmed = node.text.trim();

  /* 插件算子（T3）：实现挂在算子规格上，判定走它自己。
     放在 switch 之前，是因为它本来就不在下面那张封闭的名单里。
     `null` 按"不适用/不命中"处置 —— 与内置算子的返回口径一致  */
  const extended = conditionOperatorSpec(atom.op);
  if (extended?.evaluate) return extended.evaluate(node, atom, ctx) ?? { hit: false };

  switch (atom.op) {
    case 'contains': {
      const guard = textOnly();
      if (guard) return guard;
      const matched = words.find((word) => node.text.includes(word));
      return matched === undefined ? { hit: false } : { hit: true, quote: matched };
    }
    case 'not-contains': {
      const guard = textOnly();
      if (guard) return guard;
      return { hit: !words.some((word) => node.text.includes(word)) };
    }
    case 'empty': {
      const guard = textOnly();
      if (guard) return guard;
      return { hit: trimmed === '' };
    }
    case 'empty-with-tag': {
      const guard = textOnly();
      if (guard) return guard;
      /* 没有标签的空白段不算：它可能本就不必填（与 `tagged-empty-text` 同一条理由）  */
      if (node.tags.length === 0) return { hit: false };
      if (trimmed !== '') return { hit: false };
      return { hit: words.some((word) => node.tags.includes(word)) };
    }
    case 'has-tag': {
      /* 它只回答"带没带标签"，所以不限定节点类型：标签挂在哪种节点上由文档决定  */
      return { hit: node.tags.length > 0 };
    }
    case 'matches-pattern': {
      const guard = textOnly();
      if (guard) return guard;
      /* 第一版只有 `placeholder` 一档；取值域已在校验里收住，这里不做二次猜测 */
      const matched = matchPlaceholderExpression(node.text);
      return matched === null ? { hit: false } : { hit: true, quote: matched };
    }
    case 'length-less-than': {
      const guard = textOnly();
      if (guard) return guard;
      const limit = typeof atom.value === 'number' ? atom.value : 0;
      return { hit: trimmed.length < limit };
    }
    case 'length-greater-than': {
      const guard = textOnly();
      if (guard) return guard;
      const limit = typeof atom.value === 'number' ? atom.value : 0;
      return { hit: trimmed.length > limit };
    }
    case 'missing-pattern': {
      const guard = textOnly();
      if (guard) return guard;
      /* 第一版只有 `time` 一档；校验已经把取值收在取值域里，这里不做二次猜测 */
      return { hit: !hasTimeExpression(node.text) };
    }
    case 'older-than-hours': {
      /* 时限是文书级要求：逐段落判会把同一件事报很多遍
         （实测踩过：一份有 7 个章节的入院记录会得到 8 条一模一样的提示）。
         要限定到某一节，用「章节码 属于」那一条去配。  */
      if (node.type !== 'document' && node.type !== 'section') return { hit: false };
      if (ctx.admittedAt === undefined || ctx.admittedAt === '') {
        return { uncertain: '本文书没有就诊/入院时间（文档 encounter.admittedAt），时限无法计算' };
      }
      if (node.origin === 'imported') {
        return { uncertain: '本文书由外部导入：系统内写入时刻不代表它的临床记录时间，按写入时刻判时限会得出错误结论' };
      }
      if (node.recordedAt === undefined || node.recordedAt === '') {
        return { uncertain: '该节点没有记录时间（provenance.at），时限无法计算' };
      }
      const baseline = Date.parse(ctx.admittedAt);
      const recorded = Date.parse(node.recordedAt);
      const now = Date.parse(ctx.now);
      if (!Number.isFinite(baseline)) return { uncertain: `入院时间无法解析：${ctx.admittedAt}` };
      if (!Number.isFinite(recorded)) return { uncertain: `记录时间无法解析：${node.recordedAt}` };
      if (!Number.isFinite(now)) return { uncertain: `判定时刻无法解析：${ctx.now}` };
      if (recorded > now) return { uncertain: `记录时间（${node.recordedAt}）晚于判定时刻（${ctx.now}），数据或时钟可能异常` };
      const limitHours = typeof atom.value === 'number' ? atom.value : 0;
      const elapsedHours = (recorded - baseline) / 3_600_000;
      /* 正好等于时限不报：要求是"在 N 小时内完成"，压线算完成  */
      return { hit: elapsedHours > limitHours };
    }
    case 'gap-exceeds-hours':
      return verdictOf(evaluateVisitGap(node, atom, ctx));
    case 'missing-within-hours':
      return verdictOf(evaluateVisitMissing(node, atom, ctx));
    case 'in':
    case 'not-in': {
      const current = fieldTextOf(node, atom.field, ctx);
      /* 读不到字段 → 不命中（两个算子都一样）：
         拿"读不到"当成"不属于"，会把系统缺数据变成一条质控结论，而它看起来是配好的  */
      if (current === undefined) return { hit: false };
      const included = words.includes(current);
      return { hit: atom.op === 'in' ? included : !included };
    }
    case 'is': {
      if (atom.field !== 'keyContent') return { hit: false };
      return { hit: (node.keyContent === true) === (atom.value === true) };
    }
    default:
      return { hit: false };
  }
}

/**
 * 判一棵条件树。
 *
 * `all` / `any` 的短路取向是假优先：只要有一个分支明确不命中，整棵就"不命中"，
 * 即使别的分支"判不了" —— 一条规则有没有命中是可判定的，就不该因为另一分支缺数据而变成"判不了"。
 * 反过来，`not` 里出现"判不了"仍然是"判不了"：把一个未知取反，还是未知。
  */
export function evaluateCondition(node: QcNodeView, condition: QcConditionNode, ctx: QcContext): QcConditionVerdict {
  if (condition.kind === 'atom') return evaluateAtom(node, condition, ctx);

  if (condition.kind === 'not') {
    const inner = evaluateCondition(node, condition.child, ctx);
    if ('uncertain' in inner) return inner;
    return { hit: !inner.hit };
  }

  let uncertain: string | null = null;
  if (condition.kind === 'all') {
    for (const child of condition.children) {
      const verdict = evaluateCondition(node, child, ctx);
      if ('uncertain' in verdict) {
        if (uncertain === null) uncertain = verdict.uncertain;
        continue;
      }
      if (!verdict.hit) return { hit: false };
    }
    return uncertain === null ? { hit: true } : { uncertain };
  }

  for (const child of condition.children) {
    const verdict = evaluateCondition(node, child, ctx);
    if ('uncertain' in verdict) {
      if (uncertain === null) uncertain = verdict.uncertain;
      continue;
    }
    if (verdict.hit) return { hit: true };
  }
  return uncertain === null ? { hit: false } : { uncertain };
}

function optionLabelOf(options: readonly QcConditionOption[] | undefined, value: string): string {
  if (!options) return value;
  const found = options.find((option) => option.value === value);
  return found ? found.label : value;
}

function valueTextOf(
  op: QcConditionOperatorSpec,
  value: JsonValue | undefined,
  options?: readonly QcConditionOption[],
  args?: Record<string, JsonValue> | null,
): string {
  if (op.value === null || value === undefined) return '';
  if (op.value.kind === 'string-list') {
    const words = Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
    const shown = words.map((word) => optionLabelOf(options, word));
    return ` 「${shown.join('、')}」`;
  }
  if (op.value.kind === 'integer') {
    return ` ${String(value)}${op.value.unit ?? ''}`;
  }
  if (op.value.kind === 'boolean') return value === true ? ' 是' : ' 否';
  if (op.value.kind === 'record') {
    const record: Record<string, unknown> = asPlainObject(value) ?? {};
    const parts: string[] = [];
    for (const item of op.value.fields) {
      const current = record[item.name];
      if (current === undefined) continue;
      /* 格里的占位符同样读成实参（读不到就明写 `⟨名字⟩`，不编一个数字） */
      const shown: JsonValue = isPlaceholderValue(current) && args && Object.prototype.hasOwnProperty.call(args, placeholderNameOf(current))
        ? (args[placeholderNameOf(current)] as JsonValue)
        : (current as JsonValue);
      if (isPlaceholderValue(shown)) {
        parts.push(`${item.label} ⟨${placeholderNameOf(shown)}⟩`);
        continue;
      }
      parts.push(item.kind === 'string'
        ? `${item.label}「${String(shown)}」`
        : `${item.label} ${String(shown)}${item.unit ?? ''}`);
    }
    return ` ${parts.join('、')}`;
  }
  return ` ${optionLabelOf(op.value.options, String(value))}`;
}

/**
 * 人话回读。
 *
 * `args` 只在"这条判定方式带了参数、而规则已经填了实参"时给（T1）：
 * 给了就把占位符读成实参（界面上要看的是"这条规则实际按什么判"）；
 * 不给就把它读成 `⟨参数名⟩` —— 回读一句编出来的数字，比留着一个明显的占位符更糟。
  */
export function describeCondition(
  condition: QcConditionNode,
  parent: QcConditionNode['kind'] | null = null,
  args?: Record<string, JsonValue> | null,
): string {
  if (condition.kind === 'atom') {
    const field = conditionFieldSpec(condition.field);
    const op = conditionOperatorSpec(condition.op);
    if (!field || !op) return '（无法识别的条件）';
    /* 取值是词表、而这个字段本身有取值域（节点类型、内容来源…）时，回读要用人话名：
       否则界面上会写"节点类型 属于（任一） 「text」"，读的人得先去查表才知道 `text` 是什么 */
    const options = op.value !== null && op.value.kind === 'string-list' ? field.options : undefined;
    if (isPlaceholderValue(condition.value)) {
      const name = placeholderNameOf(condition.value);
      if (args && Object.prototype.hasOwnProperty.call(args, name)) {
        return `${field.label} ${op.label}${valueTextOf(op, args[name] as JsonValue, options, args)}`;
      }
      return `${field.label} ${op.label} ⟨${name}⟩`;
    }
    return `${field.label} ${op.label}${valueTextOf(op, condition.value, options, args)}`;
  }

  if (condition.kind === 'not') {
    return `非（${describeCondition(condition.child, 'not', args)}）`;
  }

  const joiner = condition.kind === 'all' ? ' 且 ' : ' 或 ';
  const text = condition.children.map((child) => describeCondition(child, condition.kind, args)).join(joiner);
  /* 混用「且」「或」时必须加括号：不加的话读起来是一串等价的连接词，而它们的含义完全不同 */
  const needParens = parent !== null && parent !== condition.kind;
  return needParens ? `（${text}）` : text;
}

export function explainConditionHit(
  condition: QcConditionNode,
  node: QcNodeView,
  ctx: QcContext,
): { detail: string; suggestion: string; quote?: string } | null {
  const walk = (current: QcConditionNode, out: Array<{ detail: string; suggestion: string; quote?: string }>): void => {
    if (current.kind === 'not') return; /* 取反之后的文案没有意义，退回整棵树的回读 */
    if (current.kind === 'all' || current.kind === 'any') {
      for (const child of current.children) walk(child, out);
      return;
    }
    const op = conditionOperatorSpec(current.op);
    if (!op?.explain) return;
    const verdict = evaluateAtom(node, current, ctx);
    if (!('hit' in verdict) || !verdict.hit) return;
    const explained = op.explain(node, current, ctx);
    if (explained) out.push(explained);
  };
  const found: Array<{ detail: string; suggestion: string; quote?: string }> = [];
  walk(condition, found);
  if (found.length === 0) return null;
  const quote = found.find((item) => item.quote !== undefined)?.quote;
  return {
    detail: found.map((item) => item.detail).join('，且'),
    suggestion: found[0].suggestion,
    ...(quote === undefined ? {} : { quote }),
  };
}

/** 逻辑连接词的规格（界面照它生成"满足全部 / 满足任一"那一格） */
const LOGIC_SPECS: readonly { name: 'all' | 'any'; label: string; doc: string }[] = [
  { name: 'all', label: '满足全部', doc: '所有条件都成立才算命中（条件之间是「且」）。' },
  { name: 'any', label: '满足任一', doc: '任意一条成立就算命中（条件之间是「或」）。' },
];

export interface QcConditionCatalog {
  fields: QcConditionFieldSpec[];
  operators: QcConditionOperatorSpec[];
  logic: Array<{ name: 'all' | 'any'; label: string; doc: string }>;
  limits: { maxDepth: number; maxChildren: number; maxWordLength: number; maxParams: number };
  /** 参数规格可用的类型（界面照它生成"参数表"那一列的下拉） */
  paramKinds: Array<{ name: QcConditionParamKind; label: string; doc: string }>;
}

/**
 * 下发给界面的算子规格：把函数摘掉。
 *
 * 界面拿到的只是"有哪些算子、能用在哪、怎么填"；实现（`evaluate` / `explain`）留在内核与插件里。
 * 不摘也不影响 JSON 序列化（函数会被丢掉），但"这一份是给界面的清单"这件事要写在代码上 ——
 * 否则将来有人往里塞一个函数，会得到一份"本地测试看得见、线上看不见"的清单。
  */
function catalogOperatorOf(spec: QcConditionOperatorSpec): QcConditionOperatorSpec {
  const { evaluate: _evaluate, explain: _explain, ...rest } = spec;
  return rest as QcConditionOperatorSpec;
}

export function conditionCatalog(): QcConditionCatalog {
  const extended = extendedOperatorNames().map((name) => OPERATOR_BY_NAME.get(name)).filter((item): item is QcConditionOperatorSpec => !!item);
  return {
    fields: QC_CONDITION_FIELD_ORDER.map((name) => ({ ...QC_CONDITION_FIELDS[name] })),
    operators: [
      ...QC_CONDITION_OPERATOR_ORDER.map((name) => catalogOperatorOf(QC_CONDITION_OPERATORS[name])),
      /* 插件算子在最后：内置那些是"出厂口径"，界面靠顺序把它们摆在前面 */
      ...extended.map(catalogOperatorOf),
    ],
    logic: LOGIC_SPECS.map((item) => ({ ...item })),
    limits: { ...QC_CONDITION_LIMITS },
    paramKinds: QC_CONDITION_PARAM_KINDS.map((item) => ({ ...item })),
  };
}
