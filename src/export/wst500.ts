import type { DataElementTag, DocNode, DocumentModel, FieldNode, NodeId, SectionNode } from '../model/types.ts';

export interface Wst500ExportOptions {
  tagSystemOids?: Record<string, string>;
  /** 文档类型 codeSystem（默认 urn:l0:docType：明确表示"这不是标准里的文书类型编码"） */
  docTypeCodeSystem?: string;
}

export interface Wst500ExportResult {
  xml: string;
  stats: { sections: number; paragraphs: number; fields: number; textChars: number; aiFields: number };
  warnings: string[];
}

const DEFAULT_TAG_SYSTEM_OIDS: Record<string, string> = {
  WST500: '2.16.156.10011.2.1.1.4',
  WS445: '2.16.156.10011.2.1.1.5',
  ICD10: '2.16.840.1.113883.6.3',
  ICD9CM3: '2.16.840.1.113883.6.4',
  LOINC: '2.16.840.1.113883.6.1',
  local: 'urn:l0:tag:local',
  custom: 'urn:l0:tag:custom',
};

/** XML 转义；同时剔除 XML 1.0 不允许的控制字符（否则产出的文件无法被第三方解析） */
function esc(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function toCdaTime(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const digits = iso.replace(/\D/g, '');
  if (digits.length >= 14) return digits.slice(0, 14);
  if (digits.length === 8) return digits;
  return undefined;
}

const GENDER_TO_CDA: Record<string, { code: string; display: string }> = {
  M: { code: '1', display: '男' },
  F: { code: '2', display: '女' },
  U: { code: '9', display: '未说明' },
};

function childrenOf(doc: DocumentModel, parentId: NodeId | null): DocNode[] {
  return Object.values(doc.nodes)
    .filter((node) => node.parentId === parentId)
    .sort((a, b) => a.order - b.order);
}

function textOfNode(node: DocNode): string {
  return node.type === 'text' ? node.runs.map((run) => run.text).join('') : '';
}

function isField(node: DocNode): node is FieldNode {
  return node.type === 'field';
}

function isSection(node: DocNode): node is SectionNode {
  return node.type === 'section';
}

export function buildWst500Xml(doc: DocumentModel, options: Wst500ExportOptions = {}): Wst500ExportResult {
  const warnings: string[] = [];
  const tagOids = { ...DEFAULT_TAG_SYSTEM_OIDS, ...(options.tagSystemOids ?? {}) };
  const docTypeCodeSystem = options.docTypeCodeSystem ?? 'urn:l0:docType';

  const stats = { sections: 0, paragraphs: 0, fields: 0, textChars: 0, aiFields: 0 };
  const usedSystems = new Set<string>();
  const skippedTables: string[] = [];

  const codeSystemOf = (field: FieldNode): string => {
    const original = field.provenance?.evidence
      ?.map((item) => item.ref ?? '')
      .find((ref) => ref.startsWith('codeSystem:'));
    const tag = field.tags?.[0];
    if (original) return original.slice('codeSystem:'.length);
    const system = tag?.system ?? 'custom';
    usedSystems.add(system);
    return tagOids[system] ?? 'urn:l0:tag:unmapped';
  };

  const collect = (section: SectionNode): { paragraphs: string[]; fields: FieldNode[]; childSections: SectionNode[] } => {
    const paragraphs: string[] = [];
    const fields: FieldNode[] = [];
    const childSections: SectionNode[] = [];
    for (const child of childrenOf(doc, section.id)) {
      if (isSection(child)) {
        childSections.push(child);
        continue;
      }
      if (child.type === 'table') {
        skippedTables.push(`${section.title ?? section.sectionCode ?? section.id}（${child.colCount ?? '?'} 列）`);
        continue;
      }
      if (child.type === 'paragraph' || child.type === 'listItem') {
        const text = childrenOf(doc, child.id).map(textOfNode).join('').trim();
        if (text.length > 0) {
          paragraphs.push(text);
          stats.paragraphs += 1;
          stats.textChars += text.length;
        }
        for (const grandChild of childrenOf(doc, child.id)) if (isField(grandChild)) fields.push(grandChild);
        continue;
      }
      if (isField(child)) fields.push(child);
    }
    return { paragraphs, fields, childSections };
  };

  const observationXml = (field: FieldNode, indent: string): string[] => {
    const tag = field.tags?.[0];
    const valueText = field.valueText ?? (field.value === null || field.value === undefined ? '' : String(field.value));
    const lines: string[] = [];
    lines.push(`${indent}<observation classCode="OBS" moodCode="EVN">`);
    if (tag) {
      lines.push(
        `${indent}  <code code="${esc(tag.code)}" codeSystem="${esc(codeSystemOf(field))}"${tag.display ? ` displayName="${esc(tag.display)}"` : ''}/>`,
      );
    }
    if (valueText !== '') {
      if (field.dataType === 'number' && /^-?\d+(\.\d+)?$/.test(valueText.trim())) {
        lines.push(`${indent}  <value xsi:type="PQ" value="${esc(valueText)}"${field.unit ? ` unit="${esc(field.unit)}"` : ''}/>`);
      } else {
        lines.push(`${indent}  <value xsi:type="ST">${esc(valueText)}</value>`);
      }
    }
    const provenance = field.provenance;
    const aiModelId = provenance?.origin === 'ai' ? (provenance.modelId ?? 'unknown') : provenance?.derivedFrom?.modelId;
    if (aiModelId) {
      stats.aiFields += 1;
      const aiConfidence = provenance?.origin === 'ai' ? provenance.confidence : provenance?.derivedFrom?.confidence;
      const aiAcceptedBy = provenance?.origin === 'ai' ? provenance.acceptedBy : provenance?.derivedFrom?.editedBy;
      lines.push(`${indent}  <author>`);
      lines.push(`${indent}    <assignedAuthor>`);
      lines.push(`${indent}      <id extension="ai:${esc(aiModelId)}"/>`);
      if (typeof aiConfidence === 'number') {
        lines.push(`${indent}      <l0:confidence value="${aiConfidence}"/>`);
      }
      if (aiAcceptedBy && aiAcceptedBy !== 'external-system') {
        lines.push(`${indent}      <l0:acceptedBy extension="${esc(aiAcceptedBy)}"/>`);
      }
      lines.push(`${indent}    </assignedAuthor>`);
      lines.push(`${indent}  </author>`);
    }
    lines.push(`${indent}</observation>`);
    return lines;
  };

  const sectionXml = (section: SectionNode, indent: string): string[] => {
    stats.sections += 1;
    const { paragraphs, fields, childSections } = collect(section);
    const lines: string[] = [];
    lines.push(`${indent}<section>`);
    if (section.sectionCode) {
      lines.push(`${indent}  <code code="${esc(section.sectionCode)}" codeSystem="${esc(tagOids.WST500 ?? 'urn:l0:tag:unmapped')}"/>`);
    }
    lines.push(`${indent}  <title>${esc(section.title ?? '')}</title>`);
    if (paragraphs.length > 0) {
      lines.push(`${indent}  <text>`);
      for (const paragraph of paragraphs) lines.push(`${indent}    <paragraph>${esc(paragraph)}</paragraph>`);
      lines.push(`${indent}  </text>`);
    }
    for (const field of fields) {
      stats.fields += 1;
      lines.push(`${indent}  <entry>`);
      lines.push(...observationXml(field, `${indent}    `));
      lines.push(`${indent}  </entry>`);
    }
    for (const child of childSections) {
      lines.push(`${indent}  <component>`);
      lines.push(...sectionXml(child, `${indent}    `));
      lines.push(`${indent}  </component>`);
    }
    lines.push(`${indent}</section>`);
    return lines;
  };

  const rootSections = childrenOf(doc, doc.rootId).filter(isSection);
  if (rootSections.length === 0) {
    warnings.push('文档没有章节：导出的共享文档只有头部信息，对方系统会认为"无正文"');
  }

  const patient = doc.patient;
  const gender = GENDER_TO_CDA[patient.gender ?? 'U'] ?? GENDER_TO_CDA.U!;
  const effectiveTime = toCdaTime(doc.updatedAt) ?? '';
  const birthTime = toCdaTime(patient.birthDate);

  const head: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<ClinicalDocument xmlns="urn:hl7-org:v3" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:l0="urn:l0:emr">',
    `  <id root="urn:l0:doc" extension="${esc(doc.docId)}"/>`,
    `  <code code="${esc(doc.docType.code)}" codeSystem="${esc(docTypeCodeSystem)}" displayName="${esc(doc.docType.display)}"/>`,
    `  <title>${esc(doc.docType.display)}</title>`,
    `  <effectiveTime value="${effectiveTime}"/>`,
    '  <author>',
    '    <assignedAuthor>',
    `      <id extension="${esc(doc.createdBy)}"/>`,
    '    </assignedAuthor>',
    '  </author>',
    '  <recordTarget>',
    '    <patientRole>',
    `      <id extension="${esc(patient.patientId)}"/>`,
    '      <patient>',
    /* 只写掩码：模型里本就没有明文姓名，导出不得从别处"补全" */
    ...(patient.nameMasked ? [`        <name>${esc(patient.nameMasked)}</name>`] : []),
    `        <administrativeGenderCode code="${gender.code}" displayName="${gender.display}"/>`,
    ...(birthTime ? [`        <birthTime value="${birthTime}"/>`] : []),
    '      </patient>',
    '    </patientRole>',
    '  </recordTarget>',
  ];

  const body: string[] = [];
  if (rootSections.length > 0) {
    body.push('  <component>');
    body.push('    <structuredBody>');
    for (const section of rootSections) {
      body.push('      <component>');
      body.push(...sectionXml(section, '        '));
      body.push('      </component>');
    }
    body.push('    </structuredBody>');
    body.push('  </component>');
  }

  if (skippedTables.length > 0) {
    warnings.push(
      `有 ${skippedTables.length} 张表格未导出（WS/T 500 的章节结构里没有表格容器）：`
        + `${skippedTables.join('、')} —— 表格里的结构化数据在源文书里仍然完整，但对方系统收不到`,
    );
  }
  if (doc.status !== 'draft') {
    warnings.push(`源文档状态为 ${doc.status}：共享文档本身不承载签章，签章效力仍在源文件/原系统`);
  }
  if (usedSystems.size > 0) {
    warnings.push(
      `标签体系 OID 使用：${[...usedSystems].join('、')} —— 默认映射表需按院方字典核对（可通过 tagSystemOids 注入覆盖）`,
    );
  }
  warnings.push('本文件为按 WS/T 500 结构的**最小可用映射**，不构成对标准的符合性声明；模板与字典须院方确认');

  const xml = [...head, ...body, '</ClinicalDocument>', ''].join('\n');
  return { xml, stats, warnings };
}
