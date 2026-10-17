/**
 * T25b · WS/T 500（电子病历共享文档）XML 映射导入（零依赖）。
 *
 * 与 OFD 导入的关键差别：**WS/T 500 是结构化文档，段落语义是真实存在的**。
 *   - OFD 是版式文件：文字是"画"上去的，只能按页/行还原，段落与章节归属必须人工整理；
 *   - WS/T 500 是 CDA 风格的临床文档：`section/code` 就是章节，`section/text` 就是叙述正文，
 *     `entry/observation` 就是结构化数据元 —— 可以**直接映射**到我们的 section/paragraph/text/field，
 *     章节归属与数据元标签都不丢。
 *
 * 因此这条通道是"AI 生成端直接产出合格病历"最快落地的入口：医院现场最常见的数据源就是
 * 这类共享文档 XML（区域平台、HIS 归档、病案系统导出），而不是 OFD 版式件。
 *
 * 但**纪律与 OFD 完全一致**（见 import-types.ts）：来源可追溯、不继承签名、
 * 全部标未确认、必须人工核对。
 *
 * ⚠️ 诚实边界（写进 warnings，不假装能做对）：
 *   1) `entryRelationship` / 深层 `component` 等嵌套关系**不还原**，只取 entry 的直接子层级；
 *      临床逻辑（如"用药与诊断的关联"）需人工确认；
 *   2) `codeSystem` 是 OID，我们的标签体系是受限枚举 —— 按 OID 根归类，**不保证等价**；
 *   3) XML 本身**不承载电子签章**（签章在随附的 XAdES/PDF/OFD 上），导入件一律是新草稿；
 *   4) 编码：按 XML 声明解码，环境不支持该编码时给出警告而不是静默乱码。
 */

import { SCHEMA_VERSION, type DataElementTag, type DocNode, type DocumentModel, type JsonValue, type NodeId, type TagSystem } from '../model/types.ts';
import { buildMachineReadable } from '../model/machine.ts';
import { attrOf, childOf, childrenOf, findFirst, localNameOf, parseXml, textOf, type XmlNode } from './xml.ts';
import { IMPORT_EXTERNAL_KIND, ImportError, maskPersonName, sha256Hex, type ImportMeta, type ImportedDraft } from './import-types.ts';

/** WS/T 500 系列标准的 codeSystem 根 OID（中国卫生信息标准） */
const WST500_OID_ROOT = '2.16.156.10011';

/** CDA 里可能承载"一条结构化数据元"的元素名 */
const CLINICAL_ELEMENTS = ['observation', 'procedure', 'act', 'substanceAdministration', 'encounter', 'organizer', 'supply', 'regionOfInterest'];

/** 需要下钻的容器元素（真实文档里数据元常藏在它们下面） */
const NESTING_CONTAINERS = ['entryRelationship', 'component', 'act', 'organizer'];

/** 嵌套下钻深度上限：超过就停并计数上报，避免病态文档导致无限递归/爆炸 */
const MAX_NESTING_DEPTH = 4;

export interface Wst500Field {
  tag: DataElementTag;
  /** 源文件里的 codeSystem（OID），保留下来供人工核对标签体系 */
  sourceCodeSystem?: string;
  /** 源文件记录该数据元由 AI 生成时的模型标识（跨系统交换后 AI 参与度不断链） */
  modelId?: string;
  /** AI 置信度 */
  confidence?: number;
  /** 采纳人（源系统记录） */
  acceptedBy?: string;
  valueText: string;
  unit?: string;
  dataType: 'number' | 'text';
  /** 承载它的元素名（observation / procedure …），便于回溯 */
  sourceElement: string;
  /** 取值本身是**编码型**时的机器可读编码（如诊断 ICD/SNOMED 编码）：valueText 给人看，这里给机器 */
  valueCode?: { code: string; codeSystem?: string };
  /** 该数据元位于 entry 下的嵌套层级（0 = entry 直接子元素） */
  nestingDepth?: number;
}

export interface Wst500Section {
  title: string;
  code?: string;
  codeSystem?: string;
  display?: string;
  /** section/text 里的叙述正文，按块/行切分 */
  paragraphs: string[];
  fields: Wst500Field[];
  children: Wst500Section[];
}

export interface Wst500ImportResult {
  format: 'wst500';
  fileSha256: string;
  document: {
    id?: string;
    code?: string;
    codeSystem?: string;
    display?: string;
    title?: string;
    effectiveTime?: string;
    authorName?: string;
    authorOrg?: string;
  };
  patient?: { patientId?: string; nameMasked?: string; gender?: 'M' | 'F' | 'U'; birthDate?: string };
  sections: Wst500Section[];
  stats: {
    sections: number;
    paragraphs: number;
    fields: number;
    textChars: number;
    skippedEntries: number;
    /** 来自深层嵌套（entry → act → entryRelationship → observation）的数据元数 */
    nestedFields: number;
    /** 取值为编码型（CD/CE/CV/CS）的数据元数 */
    codedValues: number;
    /** 因超出嵌套深度上限而停止下钻的次数（如实上报，不假装已还原全部） */
    depthTruncated: number;
  };
  hasStructuredBody: boolean;
  /** 源文件里出现过的 codeSystem（OID 清单），用于人工核对标签体系 */
  codeSystems: string[];
  warnings: string[];
}

/* ------------------------------- 小工具 ------------------------------- */

/** 保留 OID 但归类到受限的 TagSystem：只认 WS/T 500 的根 OID，其余一律 local（不猜） */
function tagSystemOf(codeSystem: string | undefined): TagSystem {
  if (codeSystem && codeSystem.startsWith(WST500_OID_ROOT)) return 'WST500';
  return 'local';
}

/** CDA 时间：20261008103000 / 20261008 → ISO；已是 ISO 则原样返回 */
function toIso(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const digits = value.replace(/\D/g, '');
  if (digits.length >= 14) {
    return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}T${digits.slice(8, 10)}:${digits.slice(10, 12)}:${digits.slice(12, 14)}`;
  }
  if (digits.length === 12) return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}T${digits.slice(8, 10)}:${digits.slice(10, 12)}:00`;
  if (digits.length === 8) return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
  return value;
}

const GENDER_BY_CODE: Record<string, 'M' | 'F' | 'U'> = {
  '1': 'M', '2': 'F', '0': 'U', '9': 'U',
  M: 'M', F: 'F', m: 'M', f: 'F',
};

function genderOf(code: string | undefined, display: string | undefined): 'M' | 'F' | 'U' {
  if (display?.includes('男')) return 'M';
  if (display?.includes('女')) return 'F';
  if (code && GENDER_BY_CODE[code]) return GENDER_BY_CODE[code] as 'M' | 'F' | 'U';
  return 'U';
}

/**
 * 解码源文件字节。
 * 医院现场常见 GB18030/GBK 编码的 XML：按声明解码；环境不支持时给出警告，
 * **不静默按 UTF-8 硬解**（那样中文会乱码，而用户看到的是"病历正文乱码"这种最坏结果）。
 */
function decodeSource(bytes: Uint8Array): { text: string; warnings: string[] } {
  const head = new TextDecoder('utf-8').decode(bytes.slice(0, 256));
  const encoding = (/encoding\s*=\s*["']([\w.-]+)["']/i.exec(head)?.[1] ?? 'utf-8').toLowerCase();
  const hasBom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const body = hasBom ? bytes.slice(3) : bytes;
  const normalized = encoding.replace(/_/g, '-');
  if (normalized === 'utf-8' || normalized === 'utf8') {
    return { text: new TextDecoder('utf-8').decode(body), warnings: [] };
  }
  try {
    return {
      text: new TextDecoder(normalized).decode(body),
      warnings: [`源文件声明编码 ${encoding}，已按声明解码，请核对中文是否正常`],
    };
  } catch {
    return {
      text: new TextDecoder('utf-8').decode(body),
      warnings: [`源文件声明编码 ${encoding}，当前运行环境不支持该编码，已按 UTF-8 解码，中文可能乱码`],
    };
  }
}

/** code 元素 → 我们的数据元标签（保留源 codeSystem，归类不保证等价） */
function tagOf(codeNode: XmlNode | undefined): { tag: DataElementTag; codeSystem?: string } | undefined {
  const code = attrOf(codeNode, 'code');
  if (!code) return undefined;
  const codeSystem = attrOf(codeNode, 'codeSystem');
  const display = attrOf(codeNode, 'displayName') ?? attrOf(codeNode, 'display');
  return {
    tag: { system: tagSystemOf(codeSystem), code, ...(display ? { display } : {}) },
    ...(codeSystem ? { codeSystem } : {}),
  };
}

/**
 * value 元素 → 取值。**必须按 `xsi:type` 分派**，因为 CDA 的值类型差别很大：
 *   - `PQ` / `INT` / `REAL` / `MO`：数值在 `@value`（+ `@unit`）；
 *   - `CD` / `CE` / `CV` / `CS`：**编码型值**（诊断、检验结论、过敏原…），
 *     人类可读的是 `@displayName`，机器可读的是 `@code`；
 *   - `ST` / `ED` / `TX`：值就是元素文本。
 *
 * ⚠️ 早期实现只读 `@value` 与元素文本（实测由**外部真实样例**暴露）：
 *   真实 C-CDA 里"入院诊断"长这样 ——
 *   `<value xsi:type="CD" code="233604007" codeSystem="…6.96" displayName="Pneumonia"/>`，
 *   既没有 `@value` 也没有元素文本，于是**整条诊断被当成"没有取值"静默跳过**。
 *   这是最坏的一类缺陷：导入"成功"、报告里只多一行"跳过 2 条"，而丢的是诊断。
 */
function readValueNode(
  node: XmlNode | undefined,
): { valueText: string; unit?: string; coded?: { code: string; codeSystem?: string } } | undefined {
  if (!node) return undefined;
  const type = (attrOf(node, 'type') ?? '').toUpperCase();
  const raw = attrOf(node, 'value');
  const unit = attrOf(node, 'unit');
  const display = attrOf(node, 'displayName');
  const code = attrOf(node, 'code');
  const codeSystem = attrOf(node, 'codeSystem');
  const text = textOf(node).trim();

  const isCoded = ['CD', 'CE', 'CV', 'CS', 'CO'].includes(type);
  const valueText = (isCoded ? (display ?? code ?? raw ?? text) : (raw ?? display ?? text)).trim();
  if (valueText === '') return undefined;
  return {
    valueText,
    ...(unit ? { unit } : {}),
    ...(isCoded && code ? { coded: { code, ...(codeSystem ? { codeSystem } : {}) } } : {}),
  };
}

/** 叙述文本：优先按块级子元素（paragraph/item/caption）切分，否则按换行切分 */
function narrativeLines(textNode: XmlNode | undefined): string[] {
  if (!textNode) return [];
  const blocks = textNode.children.filter((child) => ['paragraph', 'item', 'caption', 'content', 'td'].includes(localNameOf(child.name)));
  const source = blocks.length > 0 ? blocks.map((block) => textOf(block)) : textOf(textNode).split(/\r?\n/);
  return source.map((line) => line.replace(/[ \t]+/g, ' ').trim()).filter((line) => line !== '');
}

function childSections(section: XmlNode): XmlNode[] {
  return [...childrenOf(section, 'section'), ...childrenOf(section, 'component').flatMap((component) => childrenOf(component, 'section'))];
}

/* ------------------------------ 主体：导入 ------------------------------ */

export function importWst500(bytes: Uint8Array): Wst500ImportResult {
  const fileSha256 = sha256Hex(bytes);
  const decoded = decodeSource(bytes);
  const warnings = [...decoded.warnings];

  let xml: XmlNode;
  try {
    xml = parseXml(decoded.text);
  } catch (err) {
    throw new ImportError(`XML 无法解析：${(err as Error).message}`);
  }

  const root = findFirst(xml, 'ClinicalDocument') ?? (localNameOf(xml.name) === 'ClinicalDocument' ? xml : childOf(xml, 'ClinicalDocument'));
  if (!root) {
    throw new ImportError('不是 WS/T 500 结构的临床文档（根元素不是 ClinicalDocument）');
  }

  /* ---- 文档头 ---- */
  const idNode = childOf(root, 'id');
  const codeNode = childOf(root, 'code');
  const codeInfo = tagOf(codeNode);
  const effectiveTime = toIso(attrOf(childOf(root, 'effectiveTime'), 'value'));
  const title = textOf(childOf(root, 'title')).trim();
  const authorName = textOf(findFirst(childOf(root, 'author') ?? root, 'name')).trim();
  const authorOrg = textOf(findFirst(childOf(root, 'author') ?? root, 'representedOrganization')).trim();

  const document: Wst500ImportResult['document'] = {
    ...(attrOf(idNode, 'extension') ? { id: attrOf(idNode, 'extension') as string } : {}),
    ...(codeInfo ? { code: codeInfo.tag.code } : {}),
    ...(codeInfo?.codeSystem ? { codeSystem: codeInfo.codeSystem } : {}),
    ...(codeInfo?.tag.display ? { display: codeInfo.tag.display } : {}),
    ...(title ? { title } : {}),
    ...(effectiveTime ? { effectiveTime } : {}),
    ...(authorName ? { authorName } : {}),
    ...(authorOrg ? { authorOrg } : {}),
  };

  /* ---- 患者 ---- */
  const patientRole = findFirst(root, 'patientRole');
  const patientNode = childOf(patientRole ?? root, 'patient');
  const rawName = textOf(findFirst(patientNode ?? root, 'name')).replace(/\s+/g, '').trim();
  const maskedName = maskPersonName(rawName);
  if (rawName && maskedName && rawName !== maskedName) {
    warnings.push(`患者姓名已按 L0 默认策略脱敏（仅保留姓氏：${maskedName}）`);
  }
  const genderCodeNode = childOf(patientNode ?? root, 'administrativeGenderCode');
  const patient: Wst500ImportResult['patient'] | undefined = patientNode || patientRole
    ? {
        ...(attrOf(childOf(patientRole ?? root, 'id'), 'extension') ? { patientId: attrOf(childOf(patientRole ?? root, 'id'), 'extension') as string } : {}),
        ...(maskedName ? { nameMasked: maskedName } : {}),
        gender: genderOf(attrOf(genderCodeNode, 'code'), attrOf(genderCodeNode, 'displayName')),
        ...(toIso(attrOf(childOf(patientNode ?? root, 'birthTime'), 'value')) ? { birthDate: toIso(attrOf(childOf(patientNode ?? root, 'birthTime'), 'value')) as string } : {}),
      }
    : undefined;

  /* ---- 章节树（结构化正文） ---- */
  const structuredBody = findFirst(root, 'structuredBody');
  if (!structuredBody) {
    warnings.push('源文档没有结构化正文（structuredBody），只能导入头部信息，正文需人工处理');
  }
  const codeSystems = new Set<string>();
  const stats: Wst500ImportResult['stats'] = {
    sections: 0,
    paragraphs: 0,
    fields: 0,
    textChars: 0,
    skippedEntries: 0,
    nestedFields: 0,
    codedValues: 0,
    depthTruncated: 0,
  };

  const parseSection = (node: XmlNode): Wst500Section => {
    stats.sections += 1;
    const sectionCodeNode = childOf(node, 'code');
    const sectionCode = tagOf(sectionCodeNode);
    if (sectionCode?.codeSystem) codeSystems.add(sectionCode.codeSystem);

    const paragraphs = narrativeLines(childOf(node, 'text'));
    for (const line of paragraphs) stats.textChars += line.length;
    stats.paragraphs += paragraphs.length;

    const fields: Wst500Field[] = [];
    /* 真实文档里"一条数据元"往往不在 entry 的直接子层级：
       C-CDA 的入院诊断是 `entry → act → entryRelationship → observation`（三层）。
       早期实现只扫 entry 的直接子元素 → **诊断这类数据元被整批静默跳过**
       （由外部真实样例暴露：报告只多一行"跳过 2 条"，丢的却是诊断）。
       这里按 CDA 的容器关系下钻，并如实记录层级与截断次数。 */
    const collect = (element: XmlNode, depth: number): number => {
      const elementName = localNameOf(element.name);
      let extracted = 0;

      if (CLINICAL_ELEMENTS.includes(elementName)) {
        const codeOfElement = tagOf(childOf(element, 'code'));
        /* 值可能在 <value>，也可能在 <text>（CDA 允许用叙述承载值） */
        const value = readValueNode(childOf(element, 'value')) ?? readValueNode(childOf(element, 'text'));
        if (codeOfElement && value) {
          if (codeOfElement.codeSystem) codeSystems.add(codeOfElement.codeSystem);
          if (value.coded) stats.codedValues += 1;
          const trimmed = value.valueText;
          /* AI 参与度：源系统把"这条是谁生成的"写在 observation/author 里，
             我们读回来（`id@extension = ai:<modelId>`，置信度在 l0:confidence）。
             丢了它，跨系统交换之后"AI 参与度审计"就断链了。 */
          const authorNode = childOf(element, 'author');
          const assigned = authorNode ? childOf(authorNode, 'assignedAuthor') : undefined;
          const authorId = assigned ? attrOf(childOf(assigned, 'id'), 'extension') : undefined;
          const modelId = authorId?.startsWith('ai:') ? authorId.slice(3) : undefined;
          const confidenceRaw = assigned ? attrOf(childOf(assigned, 'confidence'), 'value') : undefined;
          const confidence = confidenceRaw === undefined ? undefined : Number(confidenceRaw);
          const acceptedBy = assigned ? attrOf(childOf(assigned, 'acceptedBy'), 'extension') : undefined;

          fields.push({
            tag: codeOfElement.tag,
            ...(codeOfElement.codeSystem ? { sourceCodeSystem: codeOfElement.codeSystem } : {}),
            ...(modelId ? { modelId } : {}),
            ...(confidence !== undefined && Number.isFinite(confidence) ? { confidence } : {}),
            ...(acceptedBy ? { acceptedBy } : {}),
            valueText: trimmed,
            ...(value.unit ? { unit: value.unit } : {}),
            ...(value.coded ? { valueCode: value.coded } : {}),
            dataType: /^-?\d+(\.\d+)?$/.test(trimmed) ? 'number' : 'text',
            sourceElement: elementName,
            /* depth 语义：entry 的直接子元素为 0 层，往下每进一层 +1（entry 自身传 -1） */
            nestingDepth: Math.max(0, depth),
          });
          stats.fields += 1;
          if (depth > 0) stats.nestedFields += 1;
          extracted += 1;
        }
      }

      for (const child of element.children) {
        /* 下钻条件必须同时包含"容器"与"临床元素"：
           只看容器的话，`entryRelationship → observation` 这一步里 observation 不是容器，
           递归就停在那里，**数据元永远提取不到**（实测由外部样例暴露：
           entry 下明明是 act/entryRelationship/observation 三层，结果 0 条字段 + "跳过 1 条"）。 */
        const name = localNameOf(child.name);
        if (!NESTING_CONTAINERS.includes(name) && !CLINICAL_ELEMENTS.includes(name)) continue;
        if (depth + 1 > MAX_NESTING_DEPTH) {
          stats.depthTruncated += 1;
          continue;
        }
        extracted += collect(child, depth + 1);
      }
      return extracted;
    };

    for (const entry of childrenOf(node, 'entry')) {
      /* 只有"整条 entry 一条都没提取到"才算跳过：容器（如 act）自身没有取值是正常的，
         把它也计入 skipped，报表会出现"缺取值 N 条"的噪声，反而掩盖真正的丢数据。
         entry 自身传 -1：它只是容器，`entry → observation`（直接子）应当算第 0 层，不是"嵌套"。 */
      if (collect(entry, -1) === 0) stats.skippedEntries += 1;
    }

    const children = childSections(node).map(parseSection);
    return {
      title: textOf(childOf(node, 'title')).trim() || sectionCode?.tag.display || '（无标题章节）',
      ...(sectionCode ? { code: sectionCode.tag.code } : {}),
      ...(sectionCode?.codeSystem ? { codeSystem: sectionCode.codeSystem } : {}),
      ...(sectionCode?.tag.display ? { display: sectionCode.tag.display } : {}),
      paragraphs,
      fields,
      children,
    };
  };

  const sections = structuredBody
    ? [...childrenOf(structuredBody, 'section'), ...childrenOf(structuredBody, 'component').flatMap((component) => childrenOf(component, 'section'))].map(parseSection)
    : [];

  if (stats.sections === 0 && structuredBody) warnings.push('结构化正文里没有找到任何 section');
  if (stats.skippedEntries > 0) {
    warnings.push(`有 ${stats.skippedEntries} 条 entry 缺少编码或取值，未导入（不生成空值字段，避免被误读为"阴性/正常"）`);
  }
  warnings.push('WS/T 500 的 XML 本身不承载电子签章：法律效力取决于随附的签名载体或原件，导入件一律为新草稿');
  /* 深层嵌套与编码型值都必须**如实上报**：既要说清楚还原了什么，也要说清楚什么没还原 */
  if (stats.nestedFields > 0) {
    warnings.push(`其中 ${stats.nestedFields} 条数据元位于深层嵌套（act/entryRelationship 等）中，已按容器关系下钻还原`);
  }
  if (stats.depthTruncated > 0) {
    warnings.push(`有 ${stats.depthTruncated} 处嵌套超过 ${MAX_NESTING_DEPTH} 层上限，未继续下钻（不假装已还原全部）`);
  }
  if (stats.codedValues > 0) {
    warnings.push(`其中 ${stats.codedValues} 条取值为编码型（CD/CE/CV）：已同时保留人类可读文本与机器编码，编码体系须人工核对`);
  }
  warnings.push('entry 之间的临床关联语义（如"某用药针对哪条诊断"）未还原，临床逻辑须人工核对');

  return {
    format: 'wst500',
    fileSha256,
    document,
    ...(patient ? { patient } : {}),
    sections,
    stats,
    hasStructuredBody: structuredBody !== undefined,
    codeSystems: [...codeSystems],
    warnings,
  };
}

/* ---------------------------- 生成导入草稿 ---------------------------- */

function jsonText(value: string | undefined): JsonValue {
  return value ?? null;
}

export function buildWst500Draft(imported: Wst500ImportResult, meta: ImportMeta): ImportedDraft {
  const at = meta.importedAt;
  const evidence = {
    kind: IMPORT_EXTERNAL_KIND as 'external-doc',
    ref: `${meta.fileName}#sha256:${imported.fileSha256}`,
    field: 'format=wst500',
    capturedAt: at,
  };
  const provenance = (extra: Record<string, unknown> = {}): DocNode['provenance'] => ({
    origin: 'imported',
    actorId: meta.actorId,
    evidence: [evidence],
    at,
    ...extra,
  });

  const nodes: Record<NodeId, DocNode> = {};
  nodes.n_root = { id: 'n_root', type: 'document', parentId: null, order: 0, rev: 1, provenance: provenance() };

  const reviewNotes: string[] = [];
  let seq = 0;

  const addSection = (section: Wst500Section, parentId: string, order: number): void => {
    seq += 1;
    const sectionId = `n_ws_s${seq}`;
    nodes[sectionId] = {
      id: sectionId,
      type: 'section',
      parentId,
      order,
      rev: 1,
      title: section.title,
      ...(section.code ? { sectionCode: section.code } : {}),
      provenance: provenance(),
    };

    let childOrder = 0;
    for (const paragraph of section.paragraphs) {
      seq += 1;
      childOrder += 10;
      const paragraphId = `n_ws_p${seq}`;
      nodes[paragraphId] = {
        id: paragraphId,
        type: 'paragraph',
        parentId: sectionId,
        order: childOrder,
        rev: 1,
        semantic: 'imported',
        provenance: provenance(),
      };
      const textId = `${paragraphId}_t`;
      nodes[textId] = {
        id: textId,
        type: 'text',
        parentId: paragraphId,
        order: 10,
        rev: 1,
        runs: [{ text: paragraph }],
        humanConfirmed: false,
        provenance: provenance(),
      };
    }

    for (const field of section.fields) {
      seq += 1;
      childOrder += 10;
      const fieldId = `n_ws_f${seq}`;
      const numeric = /^-?\d+(\.\d+)?$/.test(field.valueText) ? Number(field.valueText) : null;
      nodes[fieldId] = {
        id: fieldId,
        type: 'field',
        parentId: sectionId,
        order: childOrder,
        rev: 1,
        dataType: field.dataType,
        value: (numeric !== null ? numeric : field.valueText) as JsonValue,
        valueText: field.valueText,
        ...(field.unit ? { unit: field.unit } : {}),
        tags: [field.tag],
        humanConfirmed: false,
        /* source 保持 'imported'（外来内容未经本系统确认，这条纪律不能破），
           但把"源系统记录的 AI 生成信息"放进 derivedFrom 与证据链 —— 参与度保留、责任不被继承。
           另外把**原始 codeSystem(OID)** 也记进证据：再导出时优先用它，
           否则受限枚举体系会把 LOINC 之类的 OID 改写成本地命名空间，标签体系在往返中丢失。 */
        provenance: provenance({
          evidence: [
            evidence,
            ...(field.sourceCodeSystem
              ? [
                  {
                    kind: IMPORT_EXTERNAL_KIND as 'external-doc',
                    ref: `codeSystem:${field.sourceCodeSystem}`,
                    field: `源标签体系 codeSystem=${field.sourceCodeSystem}（再导出时优先沿用，避免被本地枚举改写）`,
                    capturedAt: at,
                  },
                ]
              : []),
            /* 编码型取值（诊断编码等）与嵌套层级都留在来源链上：
               前者是"人读的值"之外的机器语义，后者能回答"这条是从文档哪个层级挖出来的"。 */
            ...(field.valueCode
              ? [
                  {
                    kind: IMPORT_EXTERNAL_KIND as 'external-doc',
                    ref: `valueCode:${field.valueCode.code}${field.valueCode.codeSystem ? `@${field.valueCode.codeSystem}` : ''}`,
                    field: `源取值编码=${field.valueCode.code}${field.valueCode.codeSystem ? `（${field.valueCode.codeSystem}）` : ''}${
                      field.nestingDepth ? `，位于 entry 下第 ${field.nestingDepth} 层嵌套` : ''
                    }`,
                    capturedAt: at,
                  },
                ]
              : []),
            ...(field.modelId
              ? [
                  {
                    kind: IMPORT_EXTERNAL_KIND as 'external-doc',
                    ref: `ai:${field.modelId}`,
                    field: `源文档记录该数据元由 AI 生成（置信度 ${field.confidence ?? '未记录'}${field.acceptedBy ? `，采纳人 ${field.acceptedBy}` : ''}）`,
                    capturedAt: at,
                  },
                ]
              : []),
          ],
          ...(field.modelId
            ? {
                derivedFrom: {
                  modelId: field.modelId,
                  ...(field.confidence !== undefined ? { confidence: field.confidence } : {}),
                  /* 采纳人写进 editedBy（源系统记录的"谁采纳了 AI 内容"）：
                     这样再导出时能把它写回去，跨系统往返不丢责任链。 */
                  editedBy: field.acceptedBy ?? 'external-system',
                  editedAt: at,
                },
              }
            : {}),
        }),
      };
    }

    for (const child of section.children) addSection(child, sectionId, (childOrder += 10));
  };

  imported.sections.forEach((section, index) => addSection(section, 'n_root', (index + 1) * 10));

  if (imported.stats.sections > 0) {
    reviewNotes.push(
      `导入 ${imported.stats.sections} 个章节、${imported.stats.paragraphs} 段正文、${imported.stats.fields} 条结构化数据，需人工逐项核对`,
    );
    reviewNotes.push('章节与数据元按源文件 code 映射；源 codeSystem 为 OID，标签体系归类不保证等价，需人工确认');
  }
  if (imported.stats.skippedEntries > 0) {
    reviewNotes.push(`有 ${imported.stats.skippedEntries} 条 entry 未导入（缺编码或取值），若确为有效临床数据需人工补录`);
  }
  if (!imported.hasStructuredBody) reviewNotes.push('源文档不含结构化正文，正文需人工录入或走版式文件识别');
  if (imported.patient?.nameMasked) reviewNotes.push(`患者姓名已脱敏为 ${imported.patient.nameMasked}，核对身份时请以病历号为准`);

  const sourceInfo: JsonValue = {
    fileName: meta.fileName,
    sha256: imported.fileSha256,
    format: imported.format,
    /* summary：两种格式共用的"一行摘要"，界面/日志直接显示它，避免各自拼字符串而口径不一 */
    summary: `WS/T 500 · ${imported.stats.sections} 章节 · ${imported.stats.paragraphs} 段正文 · ${imported.stats.fields} 条结构化数据 · ${imported.stats.textChars} 字`,
    documentId: jsonText(imported.document.id),
    docTypeCode: jsonText(imported.document.code),
    docTypeDisplay: jsonText(imported.document.display),
    effectiveTime: jsonText(imported.document.effectiveTime),
    authorName: jsonText(imported.document.authorName),
    authorOrg: jsonText(imported.document.authorOrg),
    patient: {
      patientId: jsonText(imported.patient?.patientId),
      nameMasked: jsonText(imported.patient?.nameMasked),
      gender: jsonText(imported.patient?.gender),
      birthDate: jsonText(imported.patient?.birthDate),
    },
    sections: imported.stats.sections,
    paragraphs: imported.stats.paragraphs,
    fields: imported.stats.fields,
    textChars: imported.stats.textChars,
    skippedEntries: imported.stats.skippedEntries,
    codeSystems: imported.codeSystems,
    signed: false,
    signatureNote: 'WS/T 500 XML 不承载电子签章，导入件为新草稿',
    warnings: imported.warnings,
    reviewNotes,
  };

  const doc: DocumentModel = {
    schemaVersion: SCHEMA_VERSION,
    docId: meta.docId,
    docType:
      meta.docType ??
      {
        system: 'WST500',
        code: imported.document.code ?? 'wst500',
        display: imported.document.display ?? '电子病历共享文档（WS/T 500）',
      },
    patient:
      meta.patient ??
      {
        patientId: imported.patient?.patientId ?? 'UNKNOWN',
        ...(imported.patient?.nameMasked ? { nameMasked: imported.patient.nameMasked } : {}),
        ...(imported.patient?.gender ? { gender: imported.patient.gender } : {}),
        ...(imported.patient?.birthDate ? { birthDate: imported.patient.birthDate } : {}),
      },
    ...(meta.encounter ? { encounter: meta.encounter } : {}),
    status: 'draft',
    createdAt: at,
    updatedAt: at,
    createdBy: meta.actorId,
    rootId: 'n_root',
    nodes,
    revisions: [
      {
        rev: 1,
        at,
        actorId: meta.actorId,
        op: 'import',
        targetId: 'n_root',
        patch: [{ op: 'add', path: '/nodes/n_root', value: nodes.n_root as unknown as JsonValue }],
      },
    ],
    extensions: { 'import.source': sourceInfo },
  };

  doc.machineReadable = buildMachineReadable({ nodes: doc.nodes, rootId: doc.rootId, schemaVersion: doc.schemaVersion, generatedAt: doc.updatedAt });
  return { doc, reviewNotes };
}

export { localNameOf };
