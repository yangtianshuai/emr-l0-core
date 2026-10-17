/**
 * 运行时目录自测（R1~R7）。
 *
 *   node src/core/runtime-dir-self-test.ts
 *
 * 守两件事：
 *   R1 **默认落在仓库之外** —— 这条一破，患者数据与加密凭据又回到被审查、被打包的目录树里；
 *   R4~R7 **一次性迁移的边界** —— 不覆盖、只做一次、失败不记账、旧目录不删。
 */

import { TestSuite, assert, assertEqual } from '../testing/harness.ts';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MIGRATION_MARKER,
  defaultRuntimeRoot,
  legacyLayoutInRepo,
  planLegacyArchive,
  planRuntimeMigration,
  realMigrationProbe,
  resolveRuntimeLayout,
  runLegacyArchive,
  runRuntimeMigration,
} from './runtime-dir.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DIR = join(ROOT, 'artifacts', 'state-selftest', 'runtime-dir');

/** ⚠️ 本环境 `node:fs` 的类型声明缺 `rmSync` 的 `recursive` 选项（运行时支持），故局部断言 */
const fsRemove = (await import('node:fs')) as unknown as { rmSync: (path: string, options: { recursive: boolean; force: boolean }) => void };

const suite = new TestSuite('运行时目录自测', [
  '说明：运行时状态（数据库 / 凭据 / 审计 / 授权登记）默认不在仓库里；环境变量逐条优先。',
  'R1 是全部理由所在：一旦默认位置回到仓库，备份、打包、发布前排查都要再"挑一次"。',
]);

const test = (name: string, fn: () => void | Promise<void>): Promise<void> => suite.test(name, fn);

/** 真文件系统探测器直接用模块里那份（计划函数本身是纯的，探测由调用方给） */
const realProbe = realMigrationProbe;

const legacy = legacyLayoutInRepo(ROOT);

async function main(): Promise<void> {
  try {
    fsRemove.rmSync(DIR, { recursive: true, force: true });
  } catch {
    /* 见其它套件的说明：本环境对 SQLite 目录的删除偶发失败 */
  }
  mkdirSync(DIR, { recursive: true });

  await test('R1 默认根目录**在仓库之外**，且与平台约定一致', () => {
    const root = defaultRuntimeRoot({ LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' });
    assertEqual(root, join('C:\\Users\\x\\AppData\\Local', 'l0-electronic-record'), 'Windows 用 LOCALAPPDATA');
    assertEqual(root.startsWith(ROOT), false, `默认运行时目录绝不能落在仓库里，实际：${root}`);

    const linux = defaultRuntimeRoot({ XDG_STATE_HOME: '/home/x/.state' }); 
    assertEqual(linux, join('/home/x/.state', 'l0-electronic-record'), 'Linux 用 XDG_STATE_HOME');
    const homeOnly = defaultRuntimeRoot({ HOME: '/home/x' });
    assertEqual(homeOnly, join('/home/x', '.local', 'state', 'l0-electronic-record'), '没有 XDG 时回落到 ~/.local/state');

    /* 整个布局的每一个默认路径都不该在仓库里（不只是根目录） */
    const layout = resolveRuntimeLayout({ LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' });
    for (const [name, value] of Object.entries(layout)) {
      if (typeof value !== 'string') continue;
      assert(!value.startsWith(ROOT), `默认布局里的 ${name} 也不该在仓库里，实际：${value}`);
    }
    assertEqual(layout.explicit, false, '没设任何路径变量 → 不算显式指定');
  });

  await test('R2 环境变量逐条优先：根目录、以及每条具体路径', () => {
    const rooted = resolveRuntimeLayout({ L0_RUNTIME_DIR: 'D:\\rt' });
    assertEqual(rooted.dir, 'D:\\rt', 'L0_RUNTIME_DIR 决定根目录');
    assertEqual(rooted.source, 'env-root', '来源应记为环境变量');
    assertEqual(rooted.stateDir, join('D:\\rt', 'state'), '未单独指定的路径从根目录派生');
    assertEqual(rooted.explicit, true, '设了 L0_RUNTIME_DIR 即视为显式指定');

    const overridden = resolveRuntimeLayout({
      L0_RUNTIME_DIR: 'D:\\rt',
      L0_STATE_DIR: 'E:\\isolated',
      L0_ADMIN_AUDIT_FILE: 'E:\\isolated\\audit.log',
      L0_DB_FILE: 'E:\\isolated\\custom.db',
    });
    assertEqual(overridden.stateDir, 'E:\\isolated', '单条变量优先于派生值');
    assertEqual(overridden.auditFile, 'E:\\isolated\\audit.log', '审计文件同样优先');
    assertEqual(overridden.dbFile, 'E:\\isolated\\custom.db', '数据库文件同样优先');

    /* 空串**不算**指定：环境变量被导出成空值是很常见的意外，不该因此改变路径 */
    const blank = resolveRuntimeLayout({ LOCALAPPDATA: 'C:\\L', L0_STATE_DIR: '   ' });
    assertEqual(blank.explicit, false, '空白取值不算显式指定');
    assertEqual(blank.stateDir, join('C:\\L', 'l0-electronic-record', 'state'), '空白取值走派生');
  });

  await test('R3 锚点默认**跟着审计文件走**（两实例共写一个锚点文件会被误报成"尾部被删"）', () => {
    const layout = resolveRuntimeLayout({ L0_RUNTIME_DIR: 'D:\\rt' });
    assertEqual(layout.anchorFile, `${layout.auditFile}.anchors.ndjson`, '锚点与审计成对');
    const moved = resolveRuntimeLayout({ L0_RUNTIME_DIR: 'D:\\rt', L0_ADMIN_AUDIT_FILE: 'E:\\a\\audit.log' });
    assertEqual(moved.anchorFile, 'E:\\a\\audit.log.anchors.ndjson', '只改审计文件时锚点要跟着走');
  });

  await test('R4 显式指定过路径 → **不做迁移**（调用方自己在管这些文件）', () => {
    const layout = resolveRuntimeLayout({ L0_RUNTIME_DIR: DIR });
    const plan = planRuntimeMigration(layout, legacy, realProbe(), '2026-10-14T00:00:00.000Z');
    assertEqual(plan.needed, false, '显式指定时不该迁移');
    assert(plan.reason.includes('显式'), `理由要能看懂，实际：${plan.reason}`);
  });

  await test('R5 目标已有内容 / 已记过账 → 不迁（**绝不覆盖正在用的库**）', () => {
    const target = join(DIR, 'occupied');
    mkdirSync(join(target, 'state'), { recursive: true });
    writeFileSync(join(target, 'state', 'l0.db'), 'x', 'utf8');
    const occupied = planRuntimeMigration(
      resolveRuntimeLayout({}, { root: target }),
      { ...legacy, stateDir: join(DIR, 'legacy-occupied') },
      realProbe(),
      '2026-10-14T00:00:00.000Z',
    );
    assertEqual(occupied.needed, false, '目标非空 → 不迁移');
    assert(occupied.reason.includes('不覆盖'), `理由要说清"不覆盖"，实际：${occupied.reason}`);

    /* 造一份真实存在的旧数据 + 一个记账文件，验证"记过账就不再迁" */
    const source = join(DIR, 'legacy-done');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'l0.db'), 'y', 'utf8');
    const target2 = join(DIR, 'migrated');
    mkdirSync(target2, { recursive: true });
    writeFileSync(join(target2, MIGRATION_MARKER), '{"version":1}', 'utf8');
    const done = planRuntimeMigration(
      resolveRuntimeLayout({}, { root: target2 }),
      { ...legacy, stateDir: source },
      realProbe(),
      '2026-10-14T00:00:00.000Z',
    );
    assertEqual(done.needed, false, '记过账 → 不重复迁移');
    assert(done.reason.includes('已经迁移过'), `理由要指出记账文件，实际：${done.reason}`);
  });

  await test('R6 仓库里旧数据不存在 → 不迁、且**不记账**（以后出现的旧数据仍要能迁）', () => {
    const empty = join(DIR, 'fresh');
    mkdirSync(empty, { recursive: true });
    const plan = planRuntimeMigration(
      resolveRuntimeLayout({}, { root: empty }),
      {
        stateDir: join(DIR, 'no-such-legacy-state'),
        auditFile: join(DIR, 'no-such-audit.log'),
        anchorFile: join(DIR, 'no-such-anchor'),
        readingGrantsFile: join(DIR, 'no-such-grants.json'),
        legacyPackDir: join(DIR, 'no-such-packs'),
      },
      realProbe(),
      '2026-10-14T00:00:00.000Z',
    );
    assertEqual(plan.needed, false, '没有旧数据就不迁');
    assertEqual(existsSync(join(empty, MIGRATION_MARKER)), false, '不记账 —— 记了账，以后真出现的旧数据就永远搬不过来');
  });

  await test('R7 迁移真做一次：内容复制齐、记账写出、**旧目录仍在**；失败则不记账', () => {
    const legacyState = join(DIR, 'legacy-live', 'state');
    mkdirSync(join(legacyState, 'nested'), { recursive: true });
    writeFileSync(join(legacyState, 'l0.db'), 'db-bytes', 'utf8');
    writeFileSync(join(legacyState, 'ai-model.key'), 'sealed', 'utf8');
    writeFileSync(join(legacyState, 'nested', 'x.txt'), 'deep', 'utf8');
    const legacyAudit = join(DIR, 'legacy-live', 'admin-audit.log');
    writeFileSync(legacyAudit, '{"seq":1}\n', 'utf8');

    const target = join(DIR, 'target-live');
    const layout = resolveRuntimeLayout({}, { root: target });
    const plan = planRuntimeMigration(
      layout,
      {
        stateDir: legacyState,
        auditFile: legacyAudit,
        anchorFile: join(DIR, 'legacy-live', 'admin-audit.log.anchors.ndjson'),
        readingGrantsFile: join(DIR, 'legacy-live', 'reading-grants.json'),
        legacyPackDir: join(DIR, 'legacy-live', 'knowledge'),
      },
      realProbe(),
      '2026-10-14T00:00:00.000Z',
    );
    assertEqual(plan.needed, true, '目标为空 + 有旧数据 → 应迁移');
    assertEqual(plan.copies.length, 2, '只复制**存在**的那两项（目录树 + 审计文件）');

    const result = runRuntimeMigration(plan);
    assertEqual(result.failed, [], `迁移不该失败：${JSON.stringify(result.failed)}`);
    assertEqual(readFileSync(join(layout.stateDir, 'l0.db'), 'utf8'), 'db-bytes', '数据库要复制过来');
    assertEqual(readFileSync(join(layout.stateDir, 'ai-model.key'), 'utf8'), 'sealed', '凭据文件也要（否则模型接入会"莫名失效"）');
    assertEqual(readFileSync(join(layout.stateDir, 'nested', 'x.txt'), 'utf8'), 'deep', '子目录要递归复制');
    assertEqual(readFileSync(layout.auditFile, 'utf8'), '{"seq":1}\n', '审计要复制过来');
    assert(result.marker !== null && existsSync(result.marker), '要写出记账文件');
    const marker = JSON.parse(readFileSync(String(result.marker), 'utf8')) as { copied: string[]; from: string };
    assertEqual(marker.copied.length, 2, '记账里要写清搬了哪几项');
    /* **旧目录保留**：新位置出问题时它是回滚凭据 */
    assertEqual(existsSync(join(legacyState, 'l0.db')), true, '旧目录不该被删');

    /* 再跑一次：已记账 → 不再迁（否则每次启动都搬一遍，且会覆盖新位置里刚写的东西） */
    const again = planRuntimeMigration(layout, { ...legacy, stateDir: legacyState }, realProbe(), '2026-10-14T01:00:00.000Z');
    assertEqual(again.needed, false, '第二次不该再迁');

    /* 失败就不记账：拿一个不存在的源让复制失败，随后**计划仍应判定需要迁移** */
    const failTarget = join(DIR, 'target-fail');
    const failPlan = {
      ...planRuntimeMigration(resolveRuntimeLayout({}, { root: failTarget }), { ...legacy, stateDir: legacyState }, realProbe(), '2026-10-14T02:00:00.000Z'),
      copies: [{ from: join(DIR, 'definitely-missing.json'), to: join(failTarget, 'x.json'), kind: 'file' as const }],
    };
    const failed = runRuntimeMigration(failPlan);
    assert(failed.failed.length > 0, '复制失败要如实报出来');
    assertEqual(failed.marker, null, '失败时不记账');
    assertEqual(
      planRuntimeMigration(resolveRuntimeLayout({}, { root: failTarget }), { ...legacy, stateDir: legacyState }, realProbe(), '2026-10-14T02:01:00.000Z').needed,
      true,
      '失败之后下一次启动仍应尝试迁移（记账早了就等于放弃那份数据）',
    );
  });

  await test('R8 归档：**新位置没有的旧数据绝不动**；有的才搬（先复制后删源）', () => {
    /* 安全闸：这条是"归档"会不会变成数据丢失的分界线。
       少了它，一次失败的迁移之后启动就会把**唯一的一份**搬去归档目录。 */
    const legacyState = join(DIR, 'arch-legacy', 'state');
    mkdirSync(legacyState, { recursive: true });
    writeFileSync(join(legacyState, 'l0.db'), 'db-bytes', 'utf8');
    const legacyShares = {
      stateDir: legacyState,
      auditFile: join(DIR, 'arch-legacy', 'admin-audit.log'),
      anchorFile: join(DIR, 'arch-legacy', 'admin-audit.log.anchors.ndjson'),
      readingGrantsFile: join(DIR, 'arch-legacy', 'reading-grants.json'),
      legacyPackDir: join(DIR, 'arch-legacy', 'knowledge'),
    };

    /* ① 新位置是空的 → 不归档（并说明是"新位置还没有对应数据"） */
    const bare = resolveRuntimeLayout({}, { root: join(DIR, 'arch-target-bare') });
    const gate = planLegacyArchive(bare, legacyShares, realProbe(), '2026-10-14T00:00:00.000Z');
    assertEqual(gate.needed, false, '新位置没有数据时不该归档');
    assertEqual(gate.moves, [], '一项都不该动');
    assertEqual(gate.skipped.length, 1, '要报出"想搬但没敢搬"的那一项');
    assert(gate.skipped[0]?.why.includes('新位置'), `理由要指向安全闸，实际：${gate.skipped[0]?.why ?? ''}`);
    assertEqual(existsSync(join(legacyState, 'l0.db')), true, '被跳过时原处必须原封不动');

    /* ② 新位置有数据了 → 归档：搬进归档目录、原处清空、归档里内容一致 */
    const target = resolveRuntimeLayout({}, { root: join(DIR, 'arch-target-full') });
    mkdirSync(target.stateDir, { recursive: true });
    writeFileSync(join(target.stateDir, 'l0.db'), 'db-bytes', 'utf8');
    const plan = planLegacyArchive(target, legacyShares, realProbe(), '2026-10-14T00:00:00.000Z');
    assertEqual(plan.needed, true, '新位置已有数据 → 应归档');
    assertEqual(plan.moves.length, 1, '只搬存在的那一项');

    const result = runLegacyArchive(plan);
    assertEqual(result.failed, [], `归档不该失败：${JSON.stringify(result.failed)}`);
    assertEqual(existsSync(join(legacyState, 'l0.db')), false, '归档之后原处应清空（这才是"搬出仓库"）');
    assertEqual(
      readFileSync(join(result.archiveDir, 'state', 'l0.db'), 'utf8'),
      'db-bytes',
      '归档目录里要有可回滚的那一份，内容一致',
    );
    assert(
      result.archiveDir.startsWith(target.dir),
      `归档目录必须在**仓库之外**的运行时目录下，实际：${result.archiveDir}`,
    );

    /* ③ 归档失败 → 原处不动（任何时刻都不低于两份）。
       用一份**新的**夹具：② 已经按设计把它搬走了，拿同一个路径断"没被动过"是测不出东西的
       （实测第一次就是这么红了一次）。
       失败也是**真**失败：把归档目标指向一个**已存在的文件**之下，mkdir 必然 ENOTDIR。 */
    const failLegacy = join(DIR, 'arch-legacy-fail', 'state');
    mkdirSync(failLegacy, { recursive: true });
    writeFileSync(join(failLegacy, 'l0.db'), 'still-here', 'utf8');
    const blocking = join(DIR, 'blocking-file');
    writeFileSync(blocking, 'x', 'utf8');
    const failed = runLegacyArchive({
      needed: true,
      reason: '测试用：制造一次归档失败',
      archiveDir: join(target.dir, 'archive'),
      moves: [{ from: failLegacy, to: join(blocking, 'nested'), kind: 'dir' }],
      skipped: [],
    });
    assert(failed.failed.length > 0, '失败要如实报出来');
    assertEqual(readFileSync(join(failLegacy, 'l0.db'), 'utf8'), 'still-here', '失败时原处必须原封不动');
  });

  const code = suite.report();
  try {
    fsRemove.rmSync(DIR, { recursive: true, force: true });
  } catch (err) {
    console.log(`（提示）测试目录清理失败，不影响结论：${(err as Error).message.split('\n')[0] ?? ''}`);
  }
  process.exit(code);
}

void main();
