// 导入侧公共契约（OFD 与 WS/T 500 共用）。

import { createHash } from 'node:crypto';
import type { DocTypeRef, DocumentModel, EncounterRef, PatientRef } from '../model/types.ts';

/** 导入失败（格式无法识别、容器损坏、缺少必要结构等）；统一错误码便于服务端映射 HTTP 状态 */
export class ImportError extends Error {
  code = 'E_IMPORT_FAILED';

  constructor(message: string) {
    super(message);
    this.name = 'ImportError';
  }
}

export interface ImportMeta {
  docId: string;
  actorId: string;
  fileName: string;
  importedAt: string;
  docType?: DocTypeRef;
  patient?: PatientRef;
  encounter?: EncounterRef;
}

export interface ImportedDraft {
  doc: DocumentModel;
  reviewNotes: string[];
}

/** 来源证据的类型标识：所有导入节点都必须带它，否则"这条数据从哪来"永远答不上来 */
export const IMPORT_EXTERNAL_KIND = 'external-doc';

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function maskPersonName(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const trimmed = name.trim().replace(/\s+/g, '');
  if (trimmed === '') return undefined;
  const chars = [...trimmed];
  if (chars.length === 1) return `${chars[0]}`;
  return `${chars[0]}${'*'.repeat(Math.min(chars.length - 1, 3))}`;
}
