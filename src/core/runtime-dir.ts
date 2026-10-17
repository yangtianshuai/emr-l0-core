/**
 * **运行时目录**：这台机器上"跑起来才会有的东西"放哪儿 —— 以及怎么把它们从仓库里搬出去。
 *
 * ## 为什么默认要落在**仓库之外**
 *
 * 此前它们全在 `<仓库>/artifacts/` 下：工作数据库（含患者数据）、加密后的模型密钥、
 * 管理审计与锚点、阅读授权登记、旧版知识包目录。
 *
 * 三条具体的坏处：
 *   ① **备份与打包要多一道"挑出来"的手续**，而少挑一次就是把患者数据或凭据一起发出去；
 *   ② **发布前排查会拦下自己**：`scan:phi` 对任何非空 `.key` 一律 ⛔（实测命中
 *      `artifacts/state/ai-model.key`）—— 那条检查**是对的**（真实凭据确实在工作树里），
 *      但它的正解不是让排查闭嘴，而是**别把运行时状态放在被审查的目录树里**；
 *   ③ 清库/重装时"哪些是代码、哪些是数据"要人去分辨。
 *
 * ## 环境变量仍然优先（这条不能变）
 *
 * `L0_RUNTIME_DIR` 或不带运行时的 `L0_STATE_DIR` / `L0_DB_FILE` / `L0_ADMIN_AUDIT_FILE` /
 * `L0_AUDIT_ANCHOR_FILE` / `L0_READING_GRANTS_FILE` / `L0_PACK_DIR` 任意一条被显式指定时，
 * 以它为准 —— **自测全靠这个隔离状态**（否则用例之间会互相污染）。
 *
 * ## 两件事，分工不同
 *
 * **① 迁移**（`planRuntimeMigration` / `runRuntimeMigration`）——**一次性**：
 * 目标目录还是空的、且**没人在环境变量里指定过路径**（`explicit === false`）时，
 * 把仓库里那份旧状态**复制**过来，并写 `migrated-from.json` 记账。
 * 三条刻意的选择：目标非空就不迁（不覆盖正在用的库）；旧位置不存在时不记账
 * （以后才出现的旧数据仍要能迁）；复制**失败就不记账**（记了账等于放弃那份数据）。
 *
 * **② 归档**（`planLegacyArchive` / `runLegacyArchive`）——**持续的不变量**：
 * "仓库树里不该有运行时状态"。只复制不搬走的话，患者数据库与加密凭据仍然躺在仓库里，
 * 备份/打包/发布前排查还是得再挑一次（实测：`scan:phi` 对 `.key` 一直报 ⛔，
 * 而那条检查是对的 —— 真实凭据确实还在工作树里）。
 *
 * 归档的安全闸只有一道，但它是要害：**只有新位置确实已经有这份数据才动旧的**。
 * 少了它，一次失败的迁移之后启动就会把唯一的一份搬去归档目录 ——
 * 那样"归档"就成了数据丢失的最后一幕。
 * 搬的方式也是先复制到归档目录、确认存在之后再删原处：任何时刻数据都至少两份。
 */

import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** ⚠️ 本环境 `node:fs` 的类型声明缺 `copyFileSync`（运行时存在），故局部断言（同 `pack-store` 的 `renameSync`） */
interface FsCopyExtra {
  copyFileSync: (from: string, to: string) => void;
}
const fsCopy = (await import('node:fs')) as unknown as FsCopyExtra;

/** ⚠️ 同样是类型声明不全：`rmSync` 缺 `recursive` 选项（运行时支持），故局部断言 */
interface FsRemoveExtra {
  rmSync: (path: string, options: { recursive: boolean; force: boolean }) => void;
}
const fsRemove = (await import('node:fs')) as unknown as FsRemoveExtra;

/** 运行时根目录名（平台默认位置下的子目录） */
export const RUNTIME_APP_DIR = 'l0-electronic-record';

/** 记账文件名：记下"从哪儿搬来的、搬了什么、什么时候" */
export const MIGRATION_MARKER = 'migrated-from.json';

export type RuntimeSource = 'env-root' | 'platform';

export interface RuntimeLayout {
  /** 运行时根目录（默认在**仓库之外**） */
  dir: string;
  source: RuntimeSource;
  /**
   * 调用方是否显式指定过路径（`L0_RUNTIME_DIR` 或任何一条具体路径变量）。
   * 为真时**不做**一次性迁移：显式指定 = 调用方自己在管这些文件，我们不去替他搬。
   */
  explicit: boolean;
  /** 工作数据库所在目录（模型接入配置、签名后端配置等也在这里） */
  stateDir: string;
  dbFile: string;
  auditFile: string;
  anchorFile: string;
  readingGrantsFile: string;
  /** 旧版知识包目录：只在一次性导入时读它 */
  legacyPackDir: string;
}

type Env = Record<string, string | undefined>;

/**
 * 平台默认的运行时根目录。
 *
 * 用平台约定而不是"仓库旁边建一个目录"：这样**多个检出**（不同分支/目录）共用同一份运行时状态，
 * 不会各自攒一套；而"想让它跟着仓库走"的场景本来就该用 `L0_RUNTIME_DIR` 显式指定。
 */
export function defaultRuntimeRoot(env: Env): string {
  const base =
    env.LOCALAPPDATA ?? // Windows
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

/** 解析本次要用的运行时布局（环境变量逐条优先，其余从根目录派生） */
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
    /* 锚点默认**跟着审计文件走**（一对）：两个实例共写一个锚点文件会把完好的链误报成"尾部被删" */
    anchorFile: env.L0_AUDIT_ANCHOR_FILE?.trim() || `${auditFile}.anchors.ndjson`,
    readingGrantsFile: env.L0_READING_GRANTS_FILE?.trim() || join(dir, 'reading-grants.json'),
    legacyPackDir: env.L0_PACK_DIR?.trim() || join(dir, 'knowledge'),
  };
}

/** 旧的（仓库内）位置：只用于**一次性迁移**，不再写 */
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

/** 探测函数做成参数：判定逻辑因此是纯的，可以用假文件系统测 */
export interface MigrationProbe {
  exists(path: string): boolean;
  dirHasEntries(path: string): boolean;
}

/**
 * 真文件系统探测器：给一份现成的，免得每个调用方各写一遍。
 * 判定逻辑本身仍是纯的（探测从参数进来），所以仍可用假文件系统做用例。
 */
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
  /** 不做迁移的原因（要能一眼看懂，而不是"什么都没发生"） */
  reason: string;
  copies: Array<{ from: string; to: string; kind: 'dir' | 'file' }>;
  marker: string;
  markerPayload: Record<string, unknown>;
}

/**
 * 决定要不要迁移。**纯函数**：给布局、旧布局、探测结果，返回计划。
 *
 * 不迁的三种情形各有明确理由，日志里照原话说出来：
 *   - 显式指定过路径（`explicit`）→ 调用方自己在管，我们不替它搬；
 *   - 目标已经有内容 → **不覆盖**（正在用的库被盖掉是不可逆的）；
 *   - 已经记过账 → 只做一次（否则每次启动都搬一遍）。
 */
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
  /** 迁移出问题时**启动不该因此失败**：如实报告，让业务继续跑（数据还在旧位置） */
  marker: string | null;
}

/** 执行迁移计划（唯一一处真正动文件的地方） */
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
  /* **有失败就不记账**：记了账，下一次启动就不会再试，那份数据等于永远搬不过去 */
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

/** 归档目录：旧的（仓库内）运行时数据搬到这儿 —— **在仓库之外**，带日期，可回滚 */
export const LEGACY_ARCHIVE_DIR = 'legacy-in-repo-backup';

export interface ArchivePlan {
  needed: boolean;
  reason: string;
  archiveDir: string;
  /** 逐项：把旧位置搬到归档目录 */
  moves: Array<{ from: string; to: string; kind: 'dir' | 'file' }>;
  /** 想搬但**没敢搬**的（新位置没有对应数据）—— 理由要能逐条念出来 */
  skipped: Array<{ from: string; why: string }>;
}

/**
 * 决定要不要把**仓库里的**旧运行时数据归档出去。**纯函数**。
 *
 * 与 `planRuntimeMigration` 的分工：那个负责"把数据**搬进**新位置"（一次性），
 * 这个负责"把数据**搬出**仓库"（是个持续的不变量）——
 * 光复制不搬走，等于仓库树里仍然躺着患者数据库与加密凭据，
 * 备份、打包、发布前排查还是得再挑一次（实测：`scan:phi` 因此一直红）。
 *
 * **唯一的安全闸**：只有"新位置确实已经有这份数据"才动旧的。
 * 少了这道闸，一次失败的迁移之后启动就会把唯一的一份数据搬去归档目录 ——
 * 那样"归档"就成了数据丢失的最后一幕。
 */
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
  /** 归档目录（只有真搬了东西才有意义） */
  archiveDir: string;
}

/**
 * 执行归档：**先复制到归档目录，确认存在之后再删源**。
 *
 * 顺序不能反：反过来（先删后复制）中间失败就是真丢数据；
 * 这样安排之后，任何时刻数据都至少存在两份（新位置 + 归档 / 或新位置 + 原处）。
 */
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
