/**
 * json-patch 子集（TS 实现）。
 *
 * 与工具链 tools/model-check/lib/model-utils.mjs 的语义保持一致：
 *   - 路径为 JSON Pointer 风格（`/nodes/n_1/value`），`~0`/`~1` 转义；
 *   - 数组长度不同时整数组 replace（不做逐项增删），换取路径稳定与实现简单；
 *   - 根路径以 '' 或 '/' 表示，仅支持 replace。
 *
 * 为什么留痕的 patch 值不值得"手写"：手写 patch 是真实事故高发点（路径写错、漏字段、
 * 顺序错），因此写路径一律用"快照 → 变更后 diff"自动生成 patch，并由测试断言
 * `applyPatch(prev, patch)` 必须精确还原 `next`。
 */

import type { JsonValue, PatchOp } from '../model/types.ts';

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => deepEqual(left[key], right[key]));
}

function escapeSegment(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

export function parsePointer(path: string): string[] {
  if (path === '' || path === '/') return [];
  return path
    .replace(/^\//, '')
    .split('/')
    .map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function getAt(root: unknown, parts: readonly string[]): unknown {
  let cursor: unknown = root;
  for (const part of parts) {
    if (cursor === null || cursor === undefined) return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

export function jsonDiff(before: unknown, after: unknown, path = ''): PatchOp[] {
  const ops: PatchOp[] = [];
  const walk = (a: unknown, b: unknown, at: string): void => {
    if (deepEqual(a, b)) return;
    if (isPlainObject(a) && isPlainObject(b)) {
      for (const key of Object.keys(a)) {
        if (!(key in b)) ops.push({ op: 'remove', path: `${at}/${escapeSegment(key)}` });
      }
      for (const key of Object.keys(b)) {
        if (!(key in a)) ops.push({ op: 'add', path: `${at}/${escapeSegment(key)}`, value: b[key] as JsonValue });
        else walk(a[key], b[key], `${at}/${escapeSegment(key)}`);
      }
      return;
    }
    if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
      for (let i = 0; i < a.length; i += 1) walk(a[i], b[i], `${at}/${i}`);
      return;
    }
    ops.push({ op: 'replace', path: at === '' ? '/' : at, value: (b as JsonValue) ?? null });
  };
  walk(before, after, path);
  return ops;
}

export function applyPatch<T>(doc: T, ops: readonly PatchOp[]): T {
  let out = structuredClone(doc) as unknown;
  for (const op of ops) {
    if (op.path === '' || op.path === '/') {
      if (op.op !== 'replace') throw new Error(`根路径仅支持 replace：${JSON.stringify(op)}`);
      out = structuredClone(op.value ?? null);
      continue;
    }
    const parts = parsePointer(op.path);
    const container = parts.length === 1 ? (out as Record<string, unknown>) : (getAt(out, parts.slice(0, -1)) as Record<string, unknown> | undefined);
    const key = parts[parts.length - 1] as string;
    if (container === undefined || container === null) throw new Error(`patch 路径不可达：${op.path}`);

    if (op.op === 'remove') {
      if (Array.isArray(container)) {
        const index = Number(key);
        if (!Number.isInteger(index) || index < 0 || index >= container.length) throw new Error(`remove 索引越界：${op.path}`);
        container.splice(index, 1);
      } else {
        if (!(key in container)) throw new Error(`remove 目标不存在：${op.path}`);
        delete container[key];
      }
    } else if (op.op === 'add') {
      if (Array.isArray(container)) container.splice(Number(key), 0, structuredClone(op.value ?? null));
      else container[key] = structuredClone(op.value ?? null);
    } else if (op.op === 'replace') {
      if (Array.isArray(container)) {
        const index = Number(key);
        if (!Number.isInteger(index) || index < 0 || index >= container.length) throw new Error(`replace 索引越界：${op.path}`);
        container[index] = structuredClone(op.value ?? null);
      } else {
        container[key] = structuredClone(op.value ?? null);
      }
    } else {
      throw new Error(`不支持的 patch op：${(op as PatchOp).op}`);
    }
  }
  return out as T;
}
