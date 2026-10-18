// 类型守卫：把 unknown 收窄为模型类型。

import type { DocNode, DocumentModel, EvidenceRef, MachineReadableBlock, Provenance, RevisionEntry, TextNode, FieldNode, SectionNode, TableNode } from './types.ts';

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

const NODE_TYPES = new Set<string>([
  'document',
  'section',
  'paragraph',
  'text',
  'field',
  'control',
  'table',
  'tableRow',
  'tableCell',
  'image',
  'listGroup',
  'listItem',
  'signatureBlock',
  'extension',
]);

export function isKnownNodeType(value: unknown): boolean {
  return typeof value === 'string' && NODE_TYPES.has(value);
}

export function isProvenance(value: unknown): value is Provenance {
  if (!isPlainObject(value)) return false;
  return isNonEmptyString(value.origin) && isNonEmptyString(value.at);
}

export function isEvidenceRef(value: unknown): value is EvidenceRef {
  if (!isPlainObject(value)) return false;
  return isNonEmptyString(value.kind) && isNonEmptyString(value.ref);
}

export function isDocNode(value: unknown): value is DocNode {
  if (!isPlainObject(value)) return false;
  if (!isNonEmptyString(value.id) || !isKnownNodeType(value.type)) return false;
  if (!(value.parentId === null || typeof value.parentId === 'string')) return false;
  if (typeof value.order !== 'number' || typeof value.rev !== 'number') return false;
  return isProvenance(value.provenance);
}

export function isTextNode(value: unknown): value is TextNode {
  return isDocNode(value) && value.type === 'text' && Array.isArray((value as TextNode).runs);
}

export function isFieldNode(value: unknown): value is FieldNode {
  return isDocNode(value) && value.type === 'field' && isNonEmptyString((value as FieldNode).dataType) && 'value' in value;
}

export function isSectionNode(value: unknown): value is SectionNode {
  return isDocNode(value) && value.type === 'section';
}

export function isTableNode(value: unknown): value is TableNode {
  return isDocNode(value) && value.type === 'table';
}

export function isRevisionEntry(value: unknown): value is RevisionEntry {
  if (!isPlainObject(value)) return false;
  return typeof value.rev === 'number' && isNonEmptyString(value.at) && isNonEmptyString(value.actorId) && isNonEmptyString(value.op);
}

export function isMachineReadableBlock(value: unknown): value is MachineReadableBlock {
  if (!isPlainObject(value)) return false;
  return isNonEmptyString(value.generatedAt) && isNonEmptyString(value.modelSchemaVersion) && Array.isArray(value.dataElements);
}

/** 文档模型守卫：只做"足以安全使用"的最低校验，深度合法性交给 validate.ts */
export function isDocumentModel(value: unknown): value is DocumentModel {
  if (!isPlainObject(value)) return false;
  if (!isNonEmptyString(value.schemaVersion) || !isNonEmptyString(value.docId)) return false;
  if (!isNonEmptyString(value.rootId) || !isNonEmptyString(value.status)) return false;
  if (!isNonEmptyString(value.createdAt) || !isNonEmptyString(value.updatedAt)) return false;
  if (!isPlainObject(value.nodes) || !isPlainObject(value.docType) || !isPlainObject(value.patient)) return false;
  if (!Array.isArray(value.revisions)) return false;
  const nodes = value.nodes as Record<string, unknown>;
  if (!(value.rootId in nodes)) return false;
  for (const node of Object.values(nodes)) if (!isDocNode(node)) return false;
  return true;
}
