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

/**
 * 导入元数据：由调用方给出（新 docId、操作者、文件名、导入时刻）。
 * 其余元数据（患者、文档类型、就诊）尽量从文件里识别出来 —— 这就是"自动识别"能带回来的东西。
 */
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
  /** 需要人工核对的提示（写进文档 extensions，界面据此展示） */
  reviewNotes: string[];
}

/** 来源证据的类型标识：所有导入节点都必须带它，否则"这条数据从哪来"永远答不上来 */
export const IMPORT_EXTERNAL_KIND = 'external-doc';

/**
 * 文件指纹（SHA-256，十六进制小写，对文件原始字节计算）。
 * 两种格式必须共用这一个实现：否则同一份文件的来源证据会出现两种哈希，回溯时对不上。
  */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * 姓名脱敏（L0 默认隐私策略）。
 *
 * 导入不得把明文姓名直接落库：源文件（尤其是院内导出的正式文档）里通常是完整姓名，
 * 而病历在研发/演示/分析环节以掩码形式流转是硬约束。保留姓氏便于人工核对身份，
 * 其余用 `*` 顶替；复姓（欧阳/司马…）与少数民族长名不做识别——宁可多打码，不可漏打码。
  */
export function maskPersonName(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const trimmed = name.trim().replace(/\s+/g, '');
  if (trimmed === '') return undefined;
  const chars = [...trimmed];
  if (chars.length === 1) return `${chars[0]}`;
  return `${chars[0]}${'*'.repeat(Math.min(chars.length - 1, 3))}`;
}
