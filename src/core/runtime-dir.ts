import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

interface FsCopyExtra {
  copyFileSync: (from: string, to: string) => void;
}
const fsCopy = (await import('node:fs')) as unknown as FsCopyExtra;

interface FsRemoveExtra {
  rmSync: (path: string, options: { recursive: boolean; force: boolean }) => void;
}
const fsRemove = (await import('node:fs')) as unknown as FsRemoveExtra;

/** 运行时根目录名（平台默认位置下的子目录） */
export const RUNTIME_APP_DIR = 'l0-electronic-record';

export const MIGRATION_MARKER = 'migrated-from.json';

export type RuntimeSource = 'env-root' | 'platform';

export interface RuntimeLayout {
  /** 运行时根目录（默认在仓库之外）  */
  dir: string;
  source: RuntimeSource;
  explicit: boolean;
  stateDir: string;
  dbFile: string;
  auditFile: string;
  anchorFile: string;
  readingGrantsFile: string;
  legacyPackDir: string;
}

type Env = Record<string, string | undefined>;

export function defaultRuntimeRoot(env: Env): string {
  const base =
    env.LOCALAPPDATA ??
    env.XDG_STATE_HOME ?? // Linux（XDG 约定）
    (env.HOME ? join(env.HOME, '.local', 'state') : undefined) ??
    (env.USERPROFILE ? join(env.USERPROFILE, 'AppData', 'Local') : undefined) ??
    env.TEMP ??
    env.TMPDIR ??
    '.';
  return join(base, RUNTIME_APP_DIR);
}

const PATH_KEYS = [
  'L0_RUNTIME_DIR',
  'L0_STATE_DIR',
  'L0_DB_FILE',
  'L0_ADMIN_AUDIT_FILE',
  'L0_AUDIT_ANCHOR_FILE',
  'L0_READING_GRANTS_FILE',
  'L0_PACK_DIR',
] as const;

export function resolveRuntimeLayout(env: Env, options: { root?: string } = {}): RuntimeLayout {
  const explicit = PATH_KEYS.some((key) => {
    const value = env[key];
    return value !== undefined && value.trim() !== '';
  });
  const rootFromEnv = options.root ?? (env.L0_RUNTIME_DIR?.trim() || undefined);
  const dir = rootFromEnv ?? defaultRuntimeRoot(env);
  const stateDir = env.L0_STATE_DIR?.trim() || join(dir, 'state');
  const auditFile = env.L0_ADMIN_AUDIT_FILE?.trim() || join(dir, 'admin-audit.log');
  return {
    dir,
    source: rootFromEnv === undefined ? 'platform' : 'env-root',
    explicit,
    stateDir,
    dbFile: env.L0_DB_FILE?.trim() || join(stateDir, 'l0.db'),
    auditFile,
    /* 锚点默认跟着审计文件走（一对）：两个实例共写一个锚点文件会把完好的链误报成"尾部被删"  */
    anchorFile: env.L0_AUDIT_ANCHOR_FILE?.trim() || `${auditFile}.anchors.ndjson`,
    readingGrantsFile: env.L0_READING_GRANTS_FILE?.trim() || join(dir, 'reading-grants.json'),
    legacyPackDir: env.L0_PACK_DIR?.trim() || join(dir, 'knowledge'),
  };
}

export interface LegacyLayout {
  stateDir: string;
  auditFile: string;
  anchorFile: string;
  readingGrantsFile: string;
  legacyPackDir: string;
}

export function legacyLayoutInRepo(repoRoot: string): LegacyLayout {
  const artifacts = join(repoRoot, 'artifacts');
  const auditFile = join(artifacts, 'admin-audit.log');
  return {
    stateDir: join(artifacts, 'state'),
    auditFile,
    anchorFile: `${auditFile}.anchors.ndjson`,
    readingGrantsFile: join(artifacts, 'reading-grants.json'),
    legacyPackDir: join(artifacts, 'knowledge'),
  };
}

export interface MigrationProbe {
  exists(path: string): boolean;
  dirHasEntries(path: string): boolean;
}

export function realMigrationProbe(): MigrationProbe {
  return {
    exists: (path) => existsSync(path),
    dirHasEntries: (path) => {
      try {
        return existsSync(path) && readdirSync(path).length > 0;
      } catch {
        return false;
      }
    },
  };
}

export interface MigrationPlan {
  needed: boolean;
  reason: string;
  copies: Array<{ from: string; to: string; kind: 'dir' | 'file' }>;
  marker: string;
  markerPayload: Record<string, unknown>;
}

export function planRuntimeMigration(
  layout: RuntimeLayout,
  legacy: LegacyLayout,
  probe: MigrationProbe,
  at: string,
): MigrationPlan {
  const marker = join(layout.dir, MIGRATION_MARKER);
  const base: MigrationPlan = {
    needed: false,
    reason: '',
    copies: [],
    marker,
    markerPayload: { version: 1, migratedAt: at, from: legacy.stateDir, to: layout.dir },
  };

  if (layout.explicit) return { ...base, reason: '调用方显式指定了运行时路径（不做迁移）' };
  if (probe.exists(marker)) return { ...base, reason: '已经迁移过（见 migrated-from.json）' };
  if (probe.dirHasEntries(layout.dir)) return { ...base, reason: '目标运行时目录已有内容（不覆盖）' };
  if (!probe.exists(legacy.stateDir) && !probe.exists(legacy.auditFile)) {
    return { ...base, reason: '仓库里没有旧的运行时数据（无需迁移）' };
  }

  const candidates: Array<{ from: string; to: string; kind: 'dir' | 'file' }> = [
    { from: legacy.stateDir, to: layout.stateDir, kind: 'dir' },
    { from: legacy.auditFile, to: layout.auditFile, kind: 'file' },
    { from: legacy.anchorFile, to: layout.anchorFile, kind: 'file' },
    { from: legacy.readingGrantsFile, to: layout.readingGrantsFile, kind: 'file' },
    { from: legacy.legacyPackDir, to: layout.legacyPackDir, kind: 'dir' },
  ];
  return {
    ...base,
    needed: true,
    reason: '把仓库里的旧运行时数据复制到新位置（旧目录保留，不删）',
    copies: candidates.filter((item) => probe.exists(item.from)),
  };
}

export interface MigrationResult {
  copied: string[];
  failed: Array<{ path: string; message: string }>;
  marker: string | null;
}

export function runRuntimeMigration(plan: MigrationPlan): MigrationResult {
  if (!plan.needed) return { copied: [], failed: [], marker: null };
  const copied: string[] = [];
  const failed: Array<{ path: string; message: string }> = [];
  for (const item of plan.copies) {
    try {
      if (item.kind === 'dir') copyTree(item.from, item.to);
      else copyOne(item.from, item.to);
      copied.push(item.to);
    } catch (err) {
      failed.push({ path: item.from, message: (err as Error).message });
    }
  }
  let marker: string | null = null;
  if (failed.length === 0) {
    try {
      mkdirSync(dirname(plan.marker), { recursive: true });
      writeFileSync(plan.marker, JSON.stringify({ ...plan.markerPayload, copied }, null, 2), 'utf8');
      marker = plan.marker;
    } catch (err) {
      failed.push({ path: plan.marker, message: (err as Error).message });
    }
  }
  return { copied, failed, marker };
}

export const LEGACY_ARCHIVE_DIR = 'legacy-in-repo-backup';

export interface ArchivePlan {
  needed: boolean;
  reason: string;
  archiveDir: string;
  moves: Array<{ from: string; to: string; kind: 'dir' | 'file' }>;
  skipped: Array<{ from: string; why: string }>;
}

export function planLegacyArchive(
  layout: RuntimeLayout,
  legacy: LegacyLayout,
  probe: MigrationProbe,
  at: string,
): ArchivePlan {
  const archiveDir = join(layout.dir, `${LEGACY_ARCHIVE_DIR}-${at.slice(0, 10)}`);
  const pairs: Array<{ from: string; to: string; kind: 'dir' | 'file' }> = [
    { from: legacy.stateDir, to: layout.stateDir, kind: 'dir' },
    { from: legacy.auditFile, to: layout.auditFile, kind: 'file' },
    { from: legacy.anchorFile, to: layout.anchorFile, kind: 'file' },
    { from: legacy.readingGrantsFile, to: layout.readingGrantsFile, kind: 'file' },
    { from: legacy.legacyPackDir, to: layout.legacyPackDir, kind: 'dir' },
  ];
  const moves: ArchivePlan['moves'] = [];
  const skipped: ArchivePlan['skipped'] = [];
  for (const pair of pairs) {
    if (!probe.exists(pair.from)) continue;
    if (!probe.exists(pair.to)) {
      skipped.push({ from: pair.from, why: `新位置还没有对应数据（${pair.to}）—— 先别动旧的` });
      continue;
    }
    moves.push({ from: pair.from, to: join(archiveDir, pair.from.split(/[\\/]/).slice(-1)[0] as string), kind: pair.kind });
  }
  if (moves.length === 0) {
    return {
      needed: false,
      reason: skipped.length > 0 ? skipped[0]?.why ?? '无需归档' : '仓库里没有旧的运行时数据',
      archiveDir,
      moves,
      skipped,
    };
  }
  return { needed: true, reason: '把仓库里的旧运行时数据搬到归档目录（新位置已有数据，先复制后删源）', archiveDir, moves, skipped };
}

export interface ArchiveResult {
  archived: string[];
  failed: Array<{ path: string; message: string }>;
  archiveDir: string;
}

export function runLegacyArchive(plan: ArchivePlan): ArchiveResult {
  if (!plan.needed) return { archived: [], failed: [], archiveDir: plan.archiveDir };
  const archived: string[] = [];
  const failed: Array<{ path: string; message: string }> = [];
  for (const move of plan.moves) {
    try {
      if (move.kind === 'dir') copyTree(move.from, move.to);
      else copyOne(move.from, move.to);
      if (!existsSync(move.to)) throw new Error('归档副本不存在，未删除原处');
      fsRemove.rmSync(move.from, { recursive: true, force: true });
      archived.push(move.from);
    } catch (err) {
      failed.push({ path: move.from, message: (err as Error).message });
    }
  }
  return { archived, failed, archiveDir: plan.archiveDir };
}

function copyOne(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true });
  fsCopy.copyFileSync(from, to);
}

function copyTree(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from)) {
    const source = join(from, name);
    const target = join(to, name);
    if (statSync(source).isDirectory()) copyTree(source, target);
    else fsCopy.copyFileSync(source, target);
  }
}
