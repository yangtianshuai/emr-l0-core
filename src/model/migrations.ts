/**
 * schemaVersion 迁移框架。
 *
 * 铁律：**禁止原地修改字段语义**。任何模型变更必须新增一条迁移，形成 from→to 链；
 * 否则线上存量文档会在升级后静默变成"能读但语义已变"的数据 —— 这是最难排查的一类事故。
 *
 * 职责边界：
 *   - migrate() 只负责版本与结构搬迁，不做业务校验；
 *   - 校验由 validate() 负责（只接受当前版本）；
 *   - 调用顺序：fromJson() → migrate() → validate()。
 */

import { hashNodes } from './hash.ts';
import { isPlainObject } from './guards.ts';
import { SCHEMA_VERSION, type DocNode, type NodeId } from './types.ts';

export type RawDoc = Record<string, unknown>;

export interface Migration {
  from: string;
  to: string;
  description: string;
  apply(doc: RawDoc): RawDoc;
}

export type MigrationErrorCode = 'E_SCHEMA_VERSION_UNKNOWN' | 'E_NO_MIGRATION_PATH' | 'E_MIGRATION_FAILED';

export class MigrationError extends Error {
  code: MigrationErrorCode;

  constructor(code: MigrationErrorCode, message: string) {
    super(message);
    this.name = 'MigrationError';
    this.code = code;
  }
}

/**
 * 迁移登记表。新增版本时**必须**在此追加一条，并补一条 self-test 用例。
 * 0.9.0 → 1.0.0 为示例迁移（真实项目里 0.9.0 是标准发布前的内部版本）：
 *   - 为机读块补充 sourceHash（内容指纹）；
 *   - 为缺省 provenance 的节点补 origin='imported'（历史数据可能没有来源标记）。
 */
export const MIGRATIONS: Migration[] = [
  {
    from: '0.9.0',
    to: '1.0.0',
    description: '补充机读信息内容指纹 sourceHash；历史节点缺 provenance 时标记为 imported',
    apply(doc: RawDoc): RawDoc {
      const next: RawDoc = { ...doc, schemaVersion: '1.0.0' };

      const nodesRaw = isPlainObject(doc.nodes) ? (doc.nodes as Record<string, RawDoc>) : {};
      const nodes: Record<string, RawDoc> = {};
      for (const [key, node] of Object.entries(nodesRaw)) {
        const copy: RawDoc = { ...node };
        if (!isPlainObject(copy.provenance)) {
          copy.provenance = { origin: 'imported', actorId: 'migration', at: String(doc.updatedAt ?? doc.createdAt ?? new Date(0).toISOString()) };
        }
        nodes[key] = copy;
      }
      next.nodes = nodes;

      if (isPlainObject(doc.machineReadable)) {
        next.machineReadable = {
          ...(doc.machineReadable as RawDoc),
          sourceHash: hashNodes(nodes as unknown as Record<NodeId, DocNode>),
          modelSchemaVersion: '1.0.0',
        };
      }
      return next;
    },
  },
];

/** 计算迁移路径（版本号列表，不含起点）；无路径返回 null */
export function migrationPath(from: string, to: string = SCHEMA_VERSION): string[] | null {
  if (from === to) return [];
  const byFrom = new Map(MIGRATIONS.map((m) => [m.from, m]));
  const path: string[] = [];
  let cursor = from;
  const guard = new Set<string>();
  while (cursor !== to) {
    if (guard.has(cursor)) return null; // 环
    guard.add(cursor);
    const step = byFrom.get(cursor);
    if (!step) return null;
    path.push(step.to);
    cursor = step.to;
  }
  return path;
}

export interface MigrateResult {
  doc: RawDoc;
  applied: string[];
}

/**
 * 迁移到目标版本（默认当前版本）。
 * 已是目标版本 → 原样返回（applied 为空）；未知起点或无路径 → 抛 MigrationError。
 */
export function migrate(doc: RawDoc, target: string = SCHEMA_VERSION): MigrateResult {
  const from = typeof doc.schemaVersion === 'string' ? doc.schemaVersion : '';
  if (!from) throw new MigrationError('E_MIGRATION_FAILED', '文档缺少 schemaVersion');
  if (from === target) return { doc, applied: [] };

  const path = migrationPath(from, target);
  if (path === null) {
    const known = new Set<string>([SCHEMA_VERSION, ...MIGRATIONS.map((m) => m.from)]);
    const code: MigrationErrorCode = known.has(from) ? 'E_NO_MIGRATION_PATH' : 'E_SCHEMA_VERSION_UNKNOWN';
    throw new MigrationError(code, `无法从 ${from} 迁移到 ${target}（已登记版本：${[...known].sort().join(', ')}）`);
  }

  let current = doc;
  const applied: string[] = [];
  for (const stepTo of path) {
    const version = String(current.schemaVersion);
    const step = MIGRATIONS.find((m) => m.from === version && m.to === stepTo);
    if (!step) throw new MigrationError('E_NO_MIGRATION_PATH', `缺少迁移步骤 ${version} → ${stepTo}`);
    try {
      current = step.apply(current);
    } catch (err) {
      throw new MigrationError('E_MIGRATION_FAILED', `迁移 ${version} → ${stepTo} 失败：${(err as Error).message}`);
    }
    if (current.schemaVersion !== stepTo) throw new MigrationError('E_MIGRATION_FAILED', `迁移 ${version} → ${stepTo} 未正确设置 schemaVersion`);
    applied.push(`${version}→${stepTo}`);
  }
  return { doc: current, applied };
}

/** 已登记的全部已知版本（含历史版本） */
export function knownVersions(): string[] {
  return [...new Set([SCHEMA_VERSION, ...MIGRATIONS.map((m) => m.from), ...MIGRATIONS.map((m) => m.to)])].sort();
}
