import { SCHEMA_VERSION, type DataElementTag, type DocNode, type DocumentModel, type JsonValue, type NodeId, type TagSystem } from '../model/types.ts';
import { buildMachineReadable } from '../model/machine.ts';
import { attrOf, childOf, childrenOf, findFirst, localNameOf, parseXml, textOf, type XmlNode } from './xml.ts';
import { IMPORT_EXTERNAL_KIND, ImportError, maskPersonName, sha256Hex, type ImportMeta, type ImportedDraft } from './import-types.ts';

/** WS/T 500 系列标准的 codeSystem 根 OID（中国卫生信息标准） */
const WST500_OID_ROOT = '2.16.156.10011';

const CLINICAL_ELEMENTS = ['observation', 'procedure', 'act', 'substanceAdministration', 'encounter', 'organizer', 'supply', 'regionOfInterest'];

const NESTING_CONTAINERS = ['entryRelationship', 'component', 'act', 'organizer'];

/** 嵌套下钻深度上限：超过就停并计数上报，避免病态文档导致无限递归/爆炸 */
const MAX_NESTING_DEPTH = 4;

export interface Wst500Field {
  tag: DataElementTag;
  sourceCodeSystem?: string;
  modelId?: string;
  confidence?: number;
  acceptedBy?: string;
  valueText: string;
  unit?: string;
  dataType: 'number' | 'text';
  sourceElement: string;
  valueCode?: { code: string; codeSystem?: string };
  nestingDepth?: number;
}

export interface Wst500Section {
  title: string;
  code?: string;
  codeSystem?: string;
  display?: string;
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
    nestedFields: number;
    codedValues: number;
    /** 因超出嵌套深度上限而停止下钻的次数（如实上报，不假装已还原全部） */
    depthTruncated: number;
  };
  hasStructuredBody: boolean;
  codeSystems: string[];
  warnings: string[];
}

function tagSystemOf(codeSystem: string | undefined): TagSystem {
  if (codeSystem && codeSystem.startsWith(WST500_OID_ROOT)) return 'WST500';
  return 'local';
}

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
    const collect = (element: XmlNode, depth: number): number => {
      const elementName = localNameOf(element.name);
      let extracted = 0;

      if (CLINICAL_ELEMENTS.includes(elementName)) {
        const codeOfElement = tagOf(childOf(element, 'code'));
        const value = readValueNode(childOf(element, 'value')) ?? readValueNode(childOf(element, 'text'));
        if (codeOfElement && value) {
          if (codeOfElement.codeSystem) codeSystems.add(codeOfElement.codeSystem);
          if (value.coded) stats.codedValues += 1;
          const trimmed = value.valueText;
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
            nestingDepth: Math.max(0, depth),
          });
          stats.fields += 1;
          if (depth > 0) stats.nestedFields += 1;
          extracted += 1;
        }
      }

      for (const child of element.children) {
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
  /* 深层嵌套与编码型值都必须如实上报：既要说清楚还原了什么，也要说清楚什么没还原  */
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
