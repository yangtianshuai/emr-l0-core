import { canonicalize } from './hash.ts';
import { isDocumentModel, isPlainObject } from './guards.ts';
import { migrate, type RawDoc } from './migrations.ts';
import { codesOf, errorsOf, validateDocument } from './validate.ts';
import type { DocumentModel, JsonValue, ValidationIssue, ValidateOptions } from './types.ts';

export type DocumentErrorCode = 'E_PARSE_FAILED' | 'E_NOT_OBJECT' | 'E_GUARD_FAILED' | 'E_VALIDATION_FAILED';

export class DocumentError extends Error {
  code: DocumentErrorCode;
  issues: ValidationIssue[];

  constructor(code: DocumentErrorCode, message: string, issues: ValidationIssue[] = []) {
    super(message);
    this.name = 'DocumentError';
    this.code = code;
    this.issues = issues;
  }
}

export interface SerializeOptions {
  pretty?: boolean;
  /** 键名排序，保证跨实现字节一致（用于哈希与 diff，不建议用于落盘） */
  canonical?: boolean;
}

export function toJson(doc: DocumentModel, options: SerializeOptions = {}): string {
  const value = (options.canonical ? canonicalize(doc as unknown as JsonValue) : doc) as JsonValue;
  return JSON.stringify(value, null, options.pretty ? 2 : 0);
}

export function cloneDoc(doc: DocumentModel): DocumentModel {
  return JSON.parse(JSON.stringify(doc)) as DocumentModel;
}

export interface ParseOptions extends ValidateOptions {
  /** 是否自动迁移到当前版本（默认 true） */
  migrate?: boolean;
  /** 是否执行校验（默认 true） */
  validate?: boolean;
  /** 迁移目标版本（默认当前版本） */
  targetVersion?: string;
}

export interface ParseResult {
  doc: DocumentModel;
  issues: ValidationIssue[];
  migrated: string[];
}

export function parseDocument(input: string | unknown, options: ParseOptions = {}): ParseResult {
  let raw: unknown = input;
  if (typeof input === 'string') {
    const text = input.replace(/^\uFEFF/, '');
    try {
      raw = JSON.parse(text);
    } catch (err) {
      throw new DocumentError('E_PARSE_FAILED', `JSON 解析失败：${(err as Error).message}`);
    }
  }
  if (!isPlainObject(raw)) throw new DocumentError('E_NOT_OBJECT', '文档必须是 JSON 对象');

  let current: RawDoc = raw;
  let migrated: string[] = [];
  if (options.migrate !== false) {
    const result = migrate(current, options.targetVersion);
    current = result.doc;
    migrated = result.applied;
  }

  if (!isDocumentModel(current)) {
    throw new DocumentError('E_GUARD_FAILED', '文档未通过结构守卫（缺少必需字段或节点结构不合法）');
  }

  const issues = options.validate === false ? [] : validateDocument(current, options);
  const errors = errorsOf(issues);
  if (errors.length > 0) {
    throw new DocumentError('E_VALIDATION_FAILED', `文档校验未通过（${errors.length} 个错误）：${codesOf(errors).join(', ')}`, issues);
  }

  return { doc: current, issues, migrated };
}

export function fromJson(input: string | unknown, options: ParseOptions = {}): DocumentModel {
  return parseDocument(input, options).doc;
}

export function migrateOnly(input: string | unknown, targetVersion?: string): { doc: RawDoc; applied: string[] } {
  let raw: unknown = input;
  if (typeof input === 'string') {
    const text = input.replace(/^\uFEFF/, '');
    try {
      raw = JSON.parse(text);
    } catch (err) {
      throw new DocumentError('E_PARSE_FAILED', `JSON 解析失败：${(err as Error).message}`);
    }
  }
  if (!isPlainObject(raw)) throw new DocumentError('E_NOT_OBJECT', '文档必须是 JSON 对象');
  return migrate(raw, targetVersion);
}
