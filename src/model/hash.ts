// 内容指纹（hash）实现 —— 与工具链 tools/model-check/lib/model-utils.mjs 必须逐字节一致。

import { createHash } from 'node:crypto';
import type { DocNode, JsonValue, NodeId } from './types.ts';

/** 递归按键名排序，数组保持顺序 */
export function canonicalize<T extends JsonValue>(value: T): JsonValue {
  if (Array.isArray(value)) return value.map((v) => canonicalize(v as JsonValue));
  if (value !== null && typeof value === 'object') {
    const src = value as { [key: string]: JsonValue };
    const out: { [key: string]: JsonValue } = {};
    for (const key of Object.keys(src).sort()) out[key] = canonicalize(src[key]);
    return out;
  }
  return value;
}

/** canonical JSON 文本（跨实现可复现） */
export function stableStringify(value: JsonValue): string {
  return JSON.stringify(canonicalize(value));
}

/** 节点表的内容指纹 */
export function hashNodes(nodes: Record<NodeId, DocNode>): string {
  return createHash('sha256').update(stableStringify(nodes as unknown as JsonValue)).digest('hex').slice(0, 32);
}

/** 任意值的内容指纹（用于 before/afterHash） */
export function hashValue(value: JsonValue): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex').slice(0, 32);
}

/** 依据节点表重建机读块（派生数据，不手工维护） */
export function buildSourceHash(nodes: Record<NodeId, DocNode>): string {
  return hashNodes(nodes);
}
