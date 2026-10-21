import { createHash } from 'node:crypto';
import type { DocNode, JsonValue, NodeId } from './types.ts';

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

export function stableStringify(value: JsonValue): string {
  return JSON.stringify(canonicalize(value));
}

export function hashNodes(nodes: Record<NodeId, DocNode>): string {
  return createHash('sha256').update(stableStringify(nodes as unknown as JsonValue)).digest('hex').slice(0, 32);
}

export function hashValue(value: JsonValue): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex').slice(0, 32);
}

export function buildSourceHash(nodes: Record<NodeId, DocNode>): string {
  return hashNodes(nodes);
}
