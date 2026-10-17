/**
 * 导入统一入口：**按内容识别格式**，而不是按用户选的文件后缀。
 *
 * 为什么不让用户先选"这是 OFD 还是 XML"：后缀不可信（医院导出的文件常被改成 .dat/.txt，
 * 或干脆没后缀），而两种格式的容器特征极其明确 —— ZIP 魔数 vs ClinicalDocument 根元素。
 * 让程序自己认，认不出来就明确报错，比让用户猜要可靠。
 *
 * 识别失败必须**明确抛错**，不能"猜一个格式硬试"：硬试会把一份 Xml 当 OFD 解析，
 * 报出来的错误（"不是有效的 ZIP 容器"）与真实问题（"这是排版不规范的 XML"）毫无关系，
 * 排查方向会被彻底带偏。
 */

import { ImportError } from './import-types.ts';
import type { ImportMeta, ImportedDraft } from './import-types.ts';
import { buildImportedDraft, importOfd, type OfdImportResult } from './ofd-import.ts';
import { buildWst500Draft, importWst500, type Wst500ImportResult } from './wst500-import.ts';

export type ImportFormat = 'ofd' | 'wst500' | 'unknown';

export type AnyImported = { kind: 'ofd'; result: OfdImportResult } | { kind: 'wst500'; result: Wst500ImportResult };

/** ZIP 本地文件头（OFD 是 ZIP 容器） */
function isZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

/**
 * 嗅探格式。只看前若干字节：
 *   - ZIP 魔数 → OFD 容器；
 *   - 文本且根元素为 ClinicalDocument（或含 structuredBody）→ WS/T 500。
 */
export function sniffImportFormat(bytes: Uint8Array): ImportFormat {
  if (isZip(bytes)) return 'ofd';
  const head = new TextDecoder('utf-8').decode(bytes.slice(0, 4096)).replace(/^\uFEFF/, '').trimStart();
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    if (/<(?:\w+:)?ClinicalDocument[\s>]/.test(head)) return 'wst500';
    if (/<(?:\w+:)?structuredBody[\s>]/.test(head)) return 'wst500';
  }
  return 'unknown';
}

export function importAnyDocument(bytes: Uint8Array, fileName = ''): AnyImported {
  const format = sniffImportFormat(bytes);
  if (format === 'ofd') return { kind: 'ofd', result: importOfd(bytes) };
  if (format === 'wst500') return { kind: 'wst500', result: importWst500(bytes) };
  const hint = fileName ? `（文件：${fileName}）` : '';
  throw new ImportError(
    `无法识别文件格式${hint}：既不是 OFD 容器（ZIP 魔数 504B0304），也不是 WS/T 500 临床文档 XML（根元素 ClinicalDocument）`,
  );
}

/** 由解析结果生成导入草稿（两种格式共用同一套纪律，见 import-types.ts） */
export function buildDraftFromAny(parsed: AnyImported, meta: ImportMeta): ImportedDraft {
  return parsed.kind === 'ofd' ? buildImportedDraft(parsed.result, meta) : buildWst500Draft(parsed.result, meta);
}

/** 统一的"人话摘要"，供日志与界面展示（两种格式的统计口径在这里对齐） */
export function describeAnyImport(parsed: AnyImported): string {
  if (parsed.kind === 'ofd') {
    const { format, pages, machine } = parsed.result;
    return `OFD 导入（${format}，${pages} 页，${machine.elements.length} 条机读数据元）`;
  }
  const { stats, sections } = parsed.result;
  return `WS/T 500 导入（${sections.length} 个章节，${stats.paragraphs} 段正文，${stats.fields} 条结构化数据元）`;
}
