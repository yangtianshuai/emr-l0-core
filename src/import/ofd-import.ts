/**
 * T25 · OFD / OFD-H 导入（读取 + 还原 + 生成导入草稿）。
 *
 * 目标不是"把版式文件渲染出来"，而是**把文件里的数据拿回来**：
 *   ① 抽真实文本（并识破"路径化陷阱"）；
 *   ② 抽取机读信息（"-H" 的载体）→ 数据元清单；
 *   ③ 识别签名与覆盖范围 → 明确"这是副本还是原件"；
 *   ④ 产出可进入系统的**导入草稿**（全部标 `origin: 'imported'` + 来源证据）。
 *
 * 三条红线（与 AI 门控同级的纪律）：
 *   1) **导入件不继承签名**：源文件即使是已签章原件，导入出来的也是一份新草稿，
 *      法律效力仍在源文件上，不能在导入件上"继承"签章状态；
 *   2) **来源必须可追溯**：每个节点的 provenance 都带 `evidence{kind:'external-doc'}`，
 *      含文件名与文件 SHA-256，事后能回答"这条数据从哪个文件来的"；
 *   3) **导入内容一律标为未确认**（`humanConfirmed: false`），并在警告里提示人工核对
 *      —— 识别结果不得自动变成"已被医生确认过的病历"。
 *
 * ⚠️ 版式文件**不含段落语义**：页面上的行是"画"上去的，导入只能按页/行还原文本，
 *    段落切分、章节归属必须由人工整理或走 L3 后结构化。这一点写在警告里，不假装能做对。
 */

import { SCHEMA_VERSION, type DataElementTag, type DocNode, type DocTypeRef, type DocumentModel, type JsonValue, type NodeId } from '../model/types.ts';
import { buildMachineReadable } from '../model/machine.ts';
import { FURNITURE_LAYER_PREFIX, renderLines } from '../export/ofd.ts';
import { findEntry, openZip, type ZipArchive } from './zip-read.ts';
import { parseSignaturesXml } from '../crypto/ofd-signature-xml.ts';
import { rebuildParagraphs, type RebuildResult } from './layout.ts';
import { verifyTargets, type SignatureTarget } from '../crypto/signature.ts';
import { attrOf, childOf, childrenOf, findAll, findFirst, localNameOf, parseXml, textOf, type XmlNode } from './xml.ts';
import { IMPORT_EXTERNAL_KIND, ImportError, maskPersonName, sha256Hex, type ImportMeta, type ImportedDraft } from './import-types.ts';

/* 公共契约从 import-types 转出：调用方既可以继续从本模块导入（历史调用点无需改动），
   也能直接依赖 import-types —— 两种格式共用同一套纪律，不允许各定义一份。 */
export { ImportError } from './import-types.ts';
export type { ImportMeta, ImportedDraft } from './import-types.ts';

export interface ImportedElement {
  system: string;
  code: string;
  display?: string;
  value: string;
  valueText: string;
  unit?: string;
  origin?: string;
  confidence?: number;
  /** 源文件中的节点 id（仅用于回溯，导入后不沿用） */
  sourceNodeId?: string;
}

export interface ImportedTextLine {
  page: number;
  text: string;
  x?: number;
  y?: number;
  size?: number;
}

export interface OfdImportResult {
  format: 'ofd-h' | 'ofd' | 'unknown';
  files: string[];
  pages: number;
  lines: ImportedTextLine[];
  /**
   * 装饰层（页眉/页脚/页码）内容 —— **不计入 lines/texts 的正文口径**，单独列出。
   * 这样既不污染正文（页码不会混进数据元），又能让下游核对"这一页本来印了什么"。
   */
  decorations: ImportedTextLine[];
  /** 被识别为装饰层而分出的文本行数（0 表示该产物没有装饰层） */
  decorationsStripped: number;
  /** 落在任何 Layer 之外的 TextObject 内的 TextCode 数（容器结构不规范，需人工核） */
  uncoveredObjects: number;
  /** 正文层中位于页面上下边带、疑似页眉页脚的行数（仅提示，不自动剥离） */
  suspiciousFurnitureLines: number;
  texts: string[];
  textChars: number;
  /** 去掉空白后的字符数（与验收探针 C2 的口径一致，便于交叉比对） */
  textCharsNoSpace: number;
  pathObjects: number;
  machine: {
    found: boolean;
    generatedAt?: string;
    generator?: string;
    sourceHash?: string;
    modelSchemaVersion?: string;
    namespaces: string[];
    elements: ImportedElement[];
    keyContentRefs: number;
  };
  sourceDocument?: { docId?: string; docTypeSystem?: string; docTypeCode?: string; status?: string };
  sourcePatient?: { patientId?: string; nameMasked?: string; gender?: string };
  /** T26：按几何线索重建的段落（含判定依据与置信度），lines 保持原始行不变以便比对 */
  layout: RebuildResult;
  signature: {
    signed: boolean;
    method?: string;
    covers: string[];
    placeholder: boolean;
    signerId?: string;
    signedAt?: string;
    /** T18：对容器内被覆盖文件的**独立验签**结论（不依赖签名方任何代码） */
    verification?: { ok: boolean; reasons: string[]; publicKeyFingerprint: string; algorithm: string };
  };
  warnings: string[];
  fileSha256: string;
}

/** 页码自然序：Page_2 排在 Page_10 之前 */
function pageOrder(path: string): number {
  const match = /(\d+)(?!.*\d)/.exec(path);
  return match ? Number(match[1]) : 0;
}

function num(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/* ------------------------------ 主体：导入 ------------------------------ */

export function importOfd(bytes: Uint8Array): OfdImportResult {
  const warnings: string[] = [];
  const fileSha256 = sha256Hex(bytes);

  let archive: ZipArchive;
  try {
    archive = openZip(bytes);
  } catch (err) {
    throw new ImportError(`无法读取容器：${(err as Error).message}`);
  }

  const files = archive.paths();
  const contentEntries = archive.entries.filter((entry) => /Content\.xml$/i.test(entry.path)).sort((a, b) => pageOrder(a.path) - pageOrder(b.path));
  const machineEntry = findEntry(archive, /MachineReadable\.xml$/i);
  const signatureEntry = findEntry(archive, /Signatures?\.xml$/i);
  const hasOfdEntry = files.some((path) => /(^|\/)OFD\.xml$/i.test(path));
  const hasDocumentEntry = files.some((path) => /Document\.xml$/i.test(path));

  /* ---- 正文文本（按页序） ----
     优先按 TextObject 遍历：字号（Size）在 TextObject 上、坐标与文本在 TextCode 上，
     而 XML 节点没有父指针（极简解析器有意不维护），所以只能从父元素这一层取。 */
  const lines: ImportedTextLine[] = [];
  /**
   * 装饰层内容（页眉/页脚/页码）**单独收集**：
   * 既不能混进正文（否则"导入成功"里会多出一堆页码，还会污染数据元统计），
   * 也不能静默丢弃（下游需要知道"这份产物本来有页眉，正文是干净的"）。
   */
  const decorations: ImportedTextLine[] = [];
  let pathObjects = 0;
  let uncoveredObjects = 0;
  let suspiciousFurnitureLines = 0;
  /**
   * 图对象计数（`ImageObject`）。
   *
   * 为什么只数、不还原：还原要动"字节从容器取出来 → 落到本机资源目录 → 把 resRef 改写成
   * `/res/...`"三步，而导入进的是一份**草稿**（谁都不该指望草稿里的图能直接进归档件）。
   * 但**必须报出来**：不报的话，文本一切正常、看起来导入成功，而图静默消失 ——
   * 这类"少了一半而没人知道"正是本系统一路上在避免的。
   */
  let imageObjects = 0;

  const pushLine = (page: number, textNode: XmlNode, size: number | undefined, into: ImportedTextLine[]): void => {
    const x = num(attrOf(textNode, 'X'));
    const y = num(attrOf(textNode, 'Y'));
    into.push({
      page,
      text: textOf(textNode),
      ...(x !== undefined ? { x } : {}),
      ...(y !== undefined ? { y } : {}),
      ...(size !== undefined ? { size } : {}),
    });
  };
  const isFurnitureLayer = (layerId: string): boolean => layerId.toLowerCase().startsWith(FURNITURE_LAYER_PREFIX);
  const pushObject = (page: number, object: XmlNode, into: ImportedTextLine[]): number => {
    const size = num(attrOf(object, 'Size'));
    const codes = childrenOf(object, 'TextCode');
    for (const textNode of codes) pushLine(page, textNode, size, into);
    return codes.length;
  };

  contentEntries.forEach((entry, pageIndex) => {
    const xml = parseXml(new TextDecoder('utf-8').decode(entry.data));
    pathObjects += findAll(xml, 'PathObject').length;
    imageObjects += findAll(xml, 'ImageObject').length;

    /* 页高用于"疑似页眉页脚"的几何提示（见下） */
    const box = findFirst(xml, 'PhysicalBox');
    const pageHeight = box ? num(textOf(box).trim().split(/\s+/)[3]) : undefined;

    const textObjects = findAll(xml, 'TextObject');
    const layers = findAll(xml, 'Layer');
    if (layers.length > 0) {
      let covered = 0;
      for (const layer of layers) {
        const decorative = isFurnitureLayer(attrOf(layer, 'ID') ?? '');
        for (const object of findAll(layer, 'TextObject')) {
          covered += pushObject(pageIndex, object, decorative ? decorations : lines);
        }
      }
      /* 有 Layer 结构却仍有 TextObject 落在任何 Layer 之外：容器结构不规范。
         如实计数上报，而不是"看起来导入成功了"。 */
      uncoveredObjects += Math.max(0, textObjects.length - covered);
    } else if (textObjects.length > 0) {
      for (const object of textObjects) pushObject(pageIndex, object, lines);
    } else {
      /* 兜底：结构异常时仍尽量把 TextCode 抽出来 */
      for (const textNode of findAll(xml, 'TextCode')) pushLine(pageIndex, textNode, undefined, lines);
    }

    /* 几何提示：别家实现常把页码/页眉直接放在正文层（没有装饰层约定）。
       这里**不自动剥离**（可能是真实正文，误删比留着更危险），只做提示。 */
    if (pageHeight !== undefined && pageHeight > 0) {
      const lower = pageHeight * 0.08;
      const upper = pageHeight * 0.92;
      suspiciousFurnitureLines += lines.filter(
        (line) => line.page === pageIndex && line.y !== undefined && (line.y < lower || line.y > upper),
      ).length;
    }
  });
  const texts = lines.map((line) => line.text);
  const joined = texts.join('');
  const textChars = joined.length;
  const textCharsNoSpace = joined.replace(/\s+/g, '').length;

  /* ---- 机读信息 ---- */
  const machine: OfdImportResult['machine'] = { found: false, namespaces: [], elements: [], keyContentRefs: 0 };
  let sourceDocument: OfdImportResult['sourceDocument'];
  let sourcePatient: OfdImportResult['sourcePatient'];

  if (machineEntry) {
    const xml = parseXml(new TextDecoder('utf-8').decode(machineEntry.data));
    const root = findFirst(xml, 'MachineReadable') ?? childOf(xml, 'MachineReadable');
    if (root) {
      machine.found = true;
      machine.generatedAt = attrOf(root, 'generatedAt');
      machine.generator = attrOf(root, 'generator');
      machine.sourceHash = attrOf(root, 'sourceHash');
      machine.modelSchemaVersion = attrOf(root, 'modelSchemaVersion');
      machine.namespaces = Object.keys(root.attrs)
        .filter((key) => key.startsWith('xmlns'))
        .map((key) => root.attrs[key] as string);

      for (const element of childrenOf(root, 'DataElement')) {
        machine.elements.push({
          system: attrOf(element, 'system') ?? 'local',
          code: attrOf(element, 'code') ?? '',
          ...(attrOf(element, 'display') ? { display: attrOf(element, 'display') as string } : {}),
          value: textOf(element),
          valueText: textOf(element),
          ...(attrOf(element, 'unit') ? { unit: attrOf(element, 'unit') as string } : {}),
          ...(attrOf(element, 'origin') ? { origin: attrOf(element, 'origin') as string } : {}),
          ...(num(attrOf(element, 'confidence')) !== undefined ? { confidence: num(attrOf(element, 'confidence')) as number } : {}),
          ...(attrOf(element, 'nodeId') ? { sourceNodeId: attrOf(element, 'nodeId') as string } : {}),
        });
      }
      machine.keyContentRefs = childrenOf(root, 'KeyContentRef').length;

      const docNode = childOf(root, 'Document');
      if (docNode) {
        sourceDocument = {
          ...(attrOf(docNode, 'docId') ? { docId: attrOf(docNode, 'docId') as string } : {}),
          ...(attrOf(docNode, 'docTypeSystem') ? { docTypeSystem: attrOf(docNode, 'docTypeSystem') as string } : {}),
          ...(attrOf(docNode, 'docTypeCode') ? { docTypeCode: attrOf(docNode, 'docTypeCode') as string } : {}),
          ...(attrOf(docNode, 'status') ? { status: attrOf(docNode, 'status') as string } : {}),
        };
      }
      const patientNode = childOf(root, 'Patient');
      if (patientNode) {
        sourcePatient = {
          ...(attrOf(patientNode, 'patientId') ? { patientId: attrOf(patientNode, 'patientId') as string } : {}),
          ...(attrOf(patientNode, 'nameMasked') ? { nameMasked: attrOf(patientNode, 'nameMasked') as string } : {}),
          ...(attrOf(patientNode, 'gender') ? { gender: attrOf(patientNode, 'gender') as string } : {}),
        };
      }
    } else {
      warnings.push('存在 MachineReadable.xml，但未找到机读块根元素（结构异常）');
    }
  }

  /* ---- 签名（含独立验签） ---- */
  const signature: OfdImportResult['signature'] = { signed: false, covers: [], placeholder: false };
  if (signatureEntry) {
    const signatureText = new TextDecoder('utf-8').decode(signatureEntry.data);
    const xml = parseXml(signatureText);
    const referenceNodes = findAll(xml, 'Reference');
    const method = findFirst(xml, 'SignatureMethod');
    const signedValue = findFirst(xml, 'SignedValue');
    const signer = findFirst(xml, 'Signer');
    const signedAt = findFirst(xml, 'SignatureDateTime');
    signature.signed = true;
    signature.covers = referenceNodes.map((node) => attrOf(node, 'FileRef') ?? '').filter(Boolean);
    if (method) signature.method = textOf(method);
    if (signer && attrOf(signer, 'ID')) signature.signerId = attrOf(signer, 'ID');
    if (signedAt) signature.signedAt = textOf(signedAt);
    signature.placeholder = /PLACEHOLDER/i.test(signature.method ?? '') || /PLACEHOLDER/i.test(textOf(signedValue ?? undefined));
    if (signature.placeholder) warnings.push('源文件的签名为占位符（未接入国密算法），不能作为合规证据');

    /* **独立验签**：拿签名块里记录的摘要清单，与容器内文件的真实字节逐项复算比对，再用内嵌公钥验签名。
       这是导入能力里最有价值的一环 —— 它能回答"这份外来文件在我拿到之前有没有被动过"。
       验签失败要当作**明确警告**报出来：只写"已签章"而不写"验签是否通过"等于谎报。 */
    const block = parseSignaturesXml(signatureText);
    if (block && !signature.placeholder) {
      const targets: SignatureTarget[] = [];
      for (const reference of block.references) {
        const entry = archive.byPath.get(reference.path);
        if (entry) targets.push({ path: reference.path, bytes: entry.data });
      }
      const verification = verifyTargets(block, targets, { requireAllCovered: false });
      signature.verification = {
        ok: verification.ok,
        reasons: verification.reasons,
        publicKeyFingerprint: block.publicKeyFingerprint,
        algorithm: block.meta.algorithm,
      };
      if (!verification.ok) {
        warnings.push(`⚠️ 源文件签名验签**失败**：${verification.reasons.join('；')} —— 文件可能已被改动，或与签名不匹配`);
      }
    } else if (block && signature.placeholder) {
      signature.verification = { ok: false, reasons: ['源文件使用占位符签名，不具备可验证性'], publicKeyFingerprint: '', algorithm: block.meta.algorithm };
    }
    warnings.push('源文件为已签章副本：导入件不继承签名状态，法律效力仍在源文件上');
  }

  /* ---- 格式判定与警告 ---- */
  const format: OfdImportResult['format'] = contentEntries.length === 0 ? 'unknown' : machine.found ? 'ofd-h' : 'ofd';
  if (contentEntries.length === 0) warnings.push('未找到任何页面内容（Content.xml），可能不是 OFD 文件');
  else if (!hasOfdEntry || !hasDocumentEntry) warnings.push(`OFD 结构不完整：入口 OFD.xml=${hasOfdEntry ? '有' : '缺'}，Document.xml=${hasDocumentEntry ? '有' : '缺'}`);
  if (textChars === 0 && pathObjects > 0) warnings.push('疑似"可视化陷阱"：页面由路径对象绘制，机器无法抽取任何文本');
  if (!machine.found) warnings.push('不含机读信息（"-H"）：只能得到版式文本，结构化需要另行识别或人工录入');
  /* 图要**明说**：这条警告是"这份文件里的图没跟过来"的唯一出口。
     文本一切正常、看起来导入成功，而图静默消失 —— 没人会去查一个没报错的导入。 */
  if (imageObjects > 0) {
    warnings.push(`源文件含 ${imageObjects} 张图：当前导入只还原文字，图未进入导入件（字节仍在容器的 Res/MultiMedia 下）`);
  }
  if (machine.modelSchemaVersion && machine.modelSchemaVersion !== SCHEMA_VERSION) {
    warnings.push(`机读块版本 ${machine.modelSchemaVersion} 与当前模型版本 ${SCHEMA_VERSION} 不一致，需对齐后使用`);
  }
  if (machine.found && (machine.sourceHash === undefined || machine.sourceHash === '')) {
    warnings.push('机读块缺少 sourceHash，无法按内容判定其是否与正文一致（可能是旧版产物）');
  }
  /* 段落重建（T26）：版式文件本身不含段落语义，这里按几何线索（段前间距/首行缩进/字号）
     重建段落，并把"判定依据 + 置信度"一并带出。低置信度必须如实提示，不能假装分对了。 */
  const layout = rebuildParagraphs(lines);
  warnings.push(...layout.warnings);
  if (lines.length > 0) {
    const lowRatio = layout.stats.paragraphs > 0 ? layout.stats.low / layout.stats.paragraphs : 0;
    warnings.push(
      `段落重建：${layout.stats.paragraphs} 段（高置信 ${layout.stats.high} / 中 ${layout.stats.medium} / 低 ${layout.stats.low}），` +
        (lowRatio > 0.5
          ? '过半数段落无几何线索，段落边界需人工重点核对'
          : '版式文件不含段落语义，段落与章节归属仍需人工确认'),
    );
  }

  /* 装饰层：分出来了就必须说清楚 ——"剥离了什么"和"保留了什么"都要报，
     否则使用方会以为"页码丢了"或"正文里本来就有页码"。 */
  if (decorations.length > 0) {
    warnings.push(
      `已剥离 ${decorations.length} 行页眉/页脚（页码、文书号等装饰内容），未计入正文；内容保留在 decorations 中供核对`,
    );
  }
  if (uncoveredObjects > 0) {
    warnings.push(`有 ${uncoveredObjects} 处文本对象不在任何 Layer 内（容器结构不规范），已按正文处理，需人工核对`);
  }
  if (suspiciousFurnitureLines > 0) {
    warnings.push(
      `正文层中有 ${suspiciousFurnitureLines} 行位于页面上下边带，疑似页眉/页脚或页码 —— 未自动剥离（可能是真实正文），请人工确认`,
    );
  }

  return {
    format,
    files,
    pages: contentEntries.length,
    lines,
    decorations,
    decorationsStripped: decorations.length,
    uncoveredObjects,
    suspiciousFurnitureLines,
    texts,
    textChars,
    textCharsNoSpace,
    pathObjects,
    machine,
    ...(sourceDocument ? { sourceDocument } : {}),
    ...(sourcePatient ? { sourcePatient } : {}),
    layout,
    signature,
    warnings,
    fileSha256,
  };
}

/* --------------------------- 与源文件闭环比对 --------------------------- */

export interface RoundTripReport {
  /** 源文档渲染出的字符数 */
  textCharsSource: number;
  /** 从 OFD 抽回的字符数 */
  textCharsImported: number;
  textMatches: boolean;
  elementsSource: number;
  elementsFound: number;
  completeness: number;
  missing: Array<{ code: string; valueText: string }>;
  /** 机读块里的 sourceHash 是否等于源文档节点指纹（证明"它就是这份文档的产物"） */
  sourceHashMatch: boolean;
  sourceHashExpected: string;
  sourceHashImported?: string;
}

/**
 * 闭环验收：把"导入结果"和"导出它的那份源文档"对起来。
 * 这是导入能力最省钱、最有说服力的验收 —— **连自己导出的都还原不回来，别家文件更不可能**。
 */
export function verifyAgainstSource(imported: OfdImportResult, sourceDoc: DocumentModel): RoundTripReport {
  const sourceLines = renderLines(sourceDoc);
  const textCharsSource = sourceLines.reduce((sum, line) => sum + line.text.length, 0);
  const textCharsImported = imported.textChars;

  const sourceElements = sourceDoc.machineReadable?.dataElements ?? [];
  const pool = new Map<string, number>();
  for (const element of imported.machine.elements) {
    const key = `${element.code}\u0000${element.valueText}`;
    pool.set(key, (pool.get(key) ?? 0) + 1);
  }
  const missing: Array<{ code: string; valueText: string }> = [];
  let found = 0;
  for (const element of sourceElements) {
    const valueText = element.valueText ?? (element.value === null || element.value === undefined ? '' : String(element.value));
    const key = `${element.tag.code}\u0000${valueText}`;
    const remaining = pool.get(key) ?? 0;
    if (remaining > 0) {
      pool.set(key, remaining - 1);
      found += 1;
    } else {
      missing.push({ code: element.tag.code, valueText });
    }
  }

  const expected = sourceDoc.machineReadable?.sourceHash ?? '';
  return {
    textCharsSource,
    textCharsImported,
    textMatches: textCharsSource === textCharsImported,
    elementsSource: sourceElements.length,
    elementsFound: found,
    completeness: sourceElements.length === 0 ? 0 : found / sourceElements.length,
    missing,
    sourceHashMatch: expected !== '' && imported.machine.sourceHash === expected,
    sourceHashExpected: expected,
    ...(imported.machine.sourceHash ? { sourceHashImported: imported.machine.sourceHash } : {}),
  };
}

/* ---------------------------- 生成导入草稿 ---------------------------- */

export function buildImportedDraft(imported: OfdImportResult, meta: ImportMeta): ImportedDraft {
  const nodes: Record<NodeId, DocNode> = {};
  const at = meta.importedAt;
  const evidence = {
    kind: IMPORT_EXTERNAL_KIND as 'external-doc',
    ref: `${meta.fileName}#sha256:${imported.fileSha256}`,
    ...(imported.machine.generator ? { field: `generator=${imported.machine.generator}` } : {}),
    capturedAt: at,
  };
  const provenance = (extra: Record<string, unknown> = {}): DocNode['provenance'] => ({
    origin: 'imported',
    actorId: meta.actorId,
    evidence: [evidence],
    at,
    ...extra,
  });

  nodes.n_root = { id: 'n_root', type: 'document', parentId: null, order: 0, rev: 1, provenance: provenance() };

  let order = 10;
  let seq = 0;
  const addSection = (title: string, code: string): string => {
    seq += 1;
    const id = `n_imp_s${seq}`;
    nodes[id] = { id, type: 'section', parentId: 'n_root', order: (order += 10), rev: 1, title, sectionCode: code, provenance: provenance() };
    return id;
  };

  const reviewNotes: string[] = [];
  const pageCount = imported.pages;
  /* 正文按**重建后的段落**落地（而不是"每页一坨文本"）：
     每个段落一个 paragraph + text 节点，段落判定依据写进来源链，
     事后能回答"这段是算法切的还是人切的、依据是什么"。 */
  const importedParagraphs = imported.layout.paragraphs.filter((paragraph) => paragraph.text.trim() !== '');
  if (pageCount > 0 && importedParagraphs.length > 0) {
    const sectionId = addSection(`导入内容（${meta.fileName}，共 ${pageCount} 页）`, 'importedContent');
    for (const paragraph of importedParagraphs) {
      seq += 1;
      const paragraphId = `n_imp_p${seq}`;
      nodes[paragraphId] = {
        id: paragraphId,
        type: 'paragraph',
        parentId: sectionId,
        order: (seq + 1) * 10,
        rev: 1,
        semantic: 'imported',
        provenance: provenance({
          evidence: [
            evidence,
            {
              kind: IMPORT_EXTERNAL_KIND as 'external-doc',
              ref: `layout://${imported.layout.strategy}/page-${paragraph.page}`,
              field: `段落重建（置信度 ${paragraph.confidence}，合并 ${paragraph.lineCount} 行）：${paragraph.evidence.join('；')}`,
              capturedAt: at,
            },
          ],
        }),
      };
      const textId = `${paragraphId}_t`;
      nodes[textId] = {
        id: textId,
        type: 'text',
        parentId: paragraphId,
        order: 10,
        rev: 1,
        runs: [{ text: paragraph.text }],
        humanConfirmed: false,
        provenance: provenance(),
      };
    }
    const { stats } = imported.layout;
    reviewNotes.push(
      `导入正文重建为 ${stats.paragraphs} 段（高置信 ${stats.high} / 中 ${stats.medium} / 低 ${stats.low}），段落与章节归属仍需人工核对`,
    );
    if (imported.layout.strategy !== 'geometry') {
      reviewNotes.push('源文件缺少坐标信息，段落按页合并，切分需人工整理');
    } else if (stats.low > 0) {
      reviewNotes.push(`其中 ${stats.low} 段未找到几何线索（行距均匀且无缩进），段落边界需人工确认`);
    }
  } else if (pageCount > 0) {
    reviewNotes.push('源文件有页面但没有可抽取的正文文本，正文需人工录入或改用结构化数据源');
  }

  if (imported.machine.elements.length > 0) {
    const sectionId = addSection('导入的机读数据（需逐项核对）', 'importedDataElements');
    // 同一标签可能多次出现（如多次测量的体温）：按标签归组，保持出现顺序
    const grouped = new Map<string, { tag: DataElementTag; values: ImportedElement[] }>();
    for (const element of imported.machine.elements) {
      const key = `${element.system}|${element.code}`;
      const bucket = grouped.get(key);
      if (bucket) bucket.values.push(element);
      else grouped.set(key, { tag: { system: element.system as DataElementTag['system'], code: element.code, ...(element.display ? { display: element.display } : {}) }, values: [element] });
    }
    for (const { tag, values } of grouped.values()) {
      values.forEach((element, index) => {
        seq += 1;
        const fieldId = `n_imp_f${seq}`;
        const numeric = /^-?\d+(\.\d+)?$/.test(element.valueText.trim()) ? Number(element.valueText) : null;
        nodes[fieldId] = {
          id: fieldId,
          type: 'field',
          parentId: sectionId,
          order: (index + 1) * 10,
          rev: 1,
          dataType: numeric !== null ? 'number' : 'text',
          value: (numeric !== null ? numeric : element.valueText) as JsonValue,
          valueText: element.valueText,
          ...(element.unit ? { unit: element.unit } : {}),
          tags: [tag],
          humanConfirmed: false,
          provenance: provenance({
            ...(element.origin === 'ai'
              ? { modelId: 'imported', confidence: element.confidence, derivedFrom: { editedBy: meta.actorId, editedAt: at } }
              : {}),
          }),
        };
      });
    }
    reviewNotes.push(`导入 ${imported.machine.elements.length} 条机读数据元，需人工逐项核对后才能使用`);
  } else {
    reviewNotes.push('源文件不含机读数据元，结构化数据需人工录入或另行识别');
  }

  /* 签名验签结论必须写进"来源档案"并在核对提示里点名：
     "已签章"与"验签通过"是两件事 —— 只说前者、不说后者，等于把"文件可能被改过"藏起来。 */
  const verification = imported.signature.verification;
  if (verification) {
    if (verification.ok) {
      reviewNotes.push(`源文件签名（${verification.algorithm}）验签通过，被覆盖文件与签名一致`);
    } else {
      reviewNotes.push(`⚠️ 源文件签名验签失败：${verification.reasons.join('；')} —— 导入前请核实文件来源与完整性`);
    }
    if (verification.publicKeyFingerprint) {
      reviewNotes.push(`签章公钥指纹（SM3/SPKI）：${verification.publicKeyFingerprint.slice(0, 32)}…`);
    }
  }

  const sourceInfo: JsonValue = {
    fileName: meta.fileName,
    sha256: imported.fileSha256,
    format: imported.format,
    /* summary：与 WS/T 500 通道共用的"一行摘要"，界面直接显示它，避免两处各拼一套口径 */
    summary: `${imported.format} · ${imported.pages} 页 · ${imported.textChars} 字 · 机读数据 ${imported.machine.elements.length} 条`,
    pages: imported.pages,
    textChars: imported.textChars,
    /* T26：段落重建策略与置信度分布（供界面展示"有多少段是猜的"） */
    layoutStrategy: imported.layout.strategy,
    layoutParagraphs: imported.layout.stats.paragraphs,
    layoutHigh: imported.layout.stats.high,
    layoutMedium: imported.layout.stats.medium,
    layoutLow: imported.layout.stats.low,
    signed: imported.signature.signed,
    signaturePlaceholder: imported.signature.placeholder,
    signatureCovers: imported.signature.covers,
    signatureAlgorithm: verification?.algorithm ?? imported.signature.method ?? null,
    signatureVerified: verification ? verification.ok : null,
    signatureVerifyReasons: verification?.reasons ?? [],
    signaturePublicKeyFingerprint: verification?.publicKeyFingerprint ?? null,
    machineElements: imported.machine.elements.length,
    keyContentRefs: imported.machine.keyContentRefs,
    generator: imported.machine.generator ?? null,
    machineSchemaVersion: imported.machine.modelSchemaVersion ?? null,
    sourceDocId: imported.sourceDocument?.docId ?? null,
    warnings: imported.warnings,
    reviewNotes,
  };

  const maskedName = maskPersonName(imported.sourcePatient?.nameMasked);

  const doc: DocumentModel = {
    schemaVersion: SCHEMA_VERSION,
    docId: meta.docId,
    docType: meta.docType ?? {
      system: (imported.sourceDocument?.docTypeSystem as DocTypeRef['system']) ?? 'local',
      code: imported.sourceDocument?.docTypeCode ?? 'imported',
      display: '导入病历',
    },
    patient:
      meta.patient ??
      {
        patientId: imported.sourcePatient?.patientId ?? 'UNKNOWN',
        /* 统一走脱敏：别家 OFD 的机读块里 `nameMasked` 未必真掩码（可能是明文），
           照抄会把明文姓名落库。maskPersonName 幂等，已掩码的再掩一次不变。 */
        ...(maskedName ? { nameMasked: maskedName } : {}),
      },
    ...(meta.encounter ? { encounter: meta.encounter } : {}),
    status: 'draft',
    createdAt: at,
    updatedAt: at,
    createdBy: meta.actorId,
    rootId: 'n_root',
    nodes,
    revisions: [
      { rev: 1, at, actorId: meta.actorId, op: 'import', targetId: 'n_root', patch: [{ op: 'add', path: '/nodes/n_root', value: nodes.n_root as unknown as JsonValue }] },
    ],
    extensions: { 'import.source': sourceInfo },
  };

  doc.machineReadable = buildMachineReadable({ nodes: doc.nodes, rootId: doc.rootId, schemaVersion: doc.schemaVersion, generatedAt: doc.updatedAt });
  return { doc, reviewNotes };
}

export { localNameOf };
