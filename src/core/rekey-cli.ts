/**
 * 命令行：口令轮换（把库里所有密封行重新密封到新口令）。
 *
 * ## 用法
 *
 * ```bash
 * npm run state:rekey                  # 试运行：只报告"有几行、能不能全部读通"，不写任何东西
 * npm run state:rekey -- --apply --new-key-file D:/keys/new.txt
 * npm run state:rekey -- --apply --new-key-file D:/keys/new.txt --yes    # 跳过交互确认（脚本用）
 * ```
 *
 * ## 三条刻意的选择
 *
 * 1. **默认只试运行**。轮换不可逆（换完旧口令就打不开了），而执行前最该确认的是
 *    "我手里这把旧口令对不对" —— 试运行用零代价回答它。
 * 2. **新口令从文件读，不从命令行参数读**。参数会进 shell 历史、`ps` 输出与 npm 日志
 *    （同 `auth/user-cli.ts` 的理由）。也不用标准输入：那一个流要留给"确认"这一步。
 * 3. **不自动改服务端配置文件**。工具替你把新口令写进 `server-config.json` 听起来贴心，
 *    实际是把"钥匙只存在于这一处、且已经换了"这件事藏起来 —— 万一写进去的值与真正生效的
 *    不一致，库就打不开了。所以它只**打印该写什么**，由人自己决定何时改、改完何时重启。
 *
 * ## 执行前必须做的一件事
 *
 * **停掉服务进程**。服务内存里是旧口令派生的密钥与派生缓存，在轮换进行中写入的任何一行
 * 都会用旧口令 —— 事务保护不了这种跨进程混合（详见 `storage/rekey.ts` 文件头）。
 */

import { existsSync, readFileSync } from 'node:fs';
import { MIGRATIONS, STORAGE_SCHEMA_VERSION } from '../storage/schema.ts';
import { openDatabase } from '../storage/sqlite.ts';
import { applyRekey, describeRekeyPlan, planRekey } from '../storage/rekey.ts';
import { resolveRuntimeLayout } from './runtime-dir.ts';
import { loadServerConfig, serverConfigPath, stateKeyOf, stateSaltHexOf } from './server-config.ts';

/* ⚠️ 本环境的 `@types/node` 对 `readFileSync` 只声明了字符串路径（运行时支持 fd 0 = 标准输入）。
   与 `auth/user-cli.ts` 同一套局部断言。 */
const fsx = (await import('node:fs')) as unknown as {
  readFileSync: (path: string | number, options: string) => string;
};

const USAGE = [
  '用法：npm run state:rekey [选项]',
  '',
  '  （默认）只做**试运行**：报告密封行数并验证全部能被旧口令读通，不写任何东西',
  '  --apply                    真正把每一行重新密封到新口令（不可逆）',
  '  --new-key-file <路径>      新口令所在的文件（内容为一行；--apply 时必填）',
  '  --new-salt <32 位 hex>     同时换盐（不传 = 按新口令派生；要用 `npm run salt:new` 生成）',
  '  --yes                      跳过交互确认（脚本用：确认这一步是防手滑，不是安全边界）',
  '  --db <路径>                指定库文件（默认取运行目录里的 l0.db）',
  '',
  '旧口令与旧盐从服务端配置文件读（`<运行目录>/server-config.json` 的 stateKey / stateSalt）。',
  '执行前请**停掉服务进程**；执行后旧口令就打不开这个库了。',
].join('\n');

function die(message: string, code = 2): never {
  process.stderr.write(`[口令轮换] ${message}\n`);
  process.exit(code);
  throw new Error(message);
}

interface Args {
  apply: boolean;
  newKeyFile?: string;
  newSalt?: string;
  yes: boolean;
  db?: string;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { apply: false, yes: false };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i] as string;
    if (item === '--apply') args.apply = true;
    else if (item === '--yes') args.yes = true;
    else if (item === '--new-key-file') args.newKeyFile = requireValue(argv, (i += 1), '--new-key-file');
    else if (item === '--new-salt') args.newSalt = requireValue(argv, (i += 1), '--new-salt');
    else if (item === '--db') args.db = requireValue(argv, (i += 1), '--db');
    else if (item === '--help' || item === '-h') {
      process.stdout.write(`${USAGE}\n`);
      process.exit(0);
    } else die(`不认识的参数：${item}\n\n${USAGE}`);
  }
  return args;
}

function requireValue(argv: readonly string[], index: number, name: string): string {
  const value = argv[index];
  if (value === undefined || value.trim() === '') die(`缺少参数值：${name}\n\n${USAGE}`);
  return value.trim();
}

/** 从文件读一行口令：**只去行尾换行**（口令本身可以含空格，顺手 trim 会静默改掉它） */
function readKeyFile(file: string): string {
  if (!existsSync(file)) die(`新口令文件不存在：${file}`);
  let raw: string;
  try {
    raw = fsx.readFileSync(file, 'utf8');
  } catch (err) {
    die(`新口令文件读不出来：${(err as Error).message}`);
  }
  const key = raw.replace(/\r?\n$/, '');
  if (key.trim() === '') die(`新口令文件是空的：${file}`);
  return key;
}

/** 交互确认：把"手滑执行"这一步挡住。它不是安全边界（有 `--yes`），只是一个减速带 */
function confirmRekey(): void {
  const stdin = (process as unknown as { stdin?: { isTTY?: boolean } }).stdin;
  if (stdin?.isTTY) {
    process.stderr.write('这将把库里每一行都换成新口令，且**不可撤销**。\n要继续请输入 rekey（其它任何输入都会中止）：\n');
  }
  let raw = '';
  try {
    raw = fsx.readFileSync(0, 'utf8');
  } catch {
    die('读不到标准输入。脚本里请显式加 --yes（交互确认是防手滑用的，不是安全边界）');
  }
  if (raw.trim() !== 'rekey') die('已中止（没有输入 rekey）。库未改动。', 1);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  /* 旧口令：一律从服务端配置文件读 —— 与 demo-server 用的是同一处，避免"CLI 用一把、服务用另一把" */
  const layout = resolveRuntimeLayout({ ...process.env });
  const configPath = serverConfigPath(layout.dir);
  const loaded = loadServerConfig(configPath);
  const old = stateKeyOf(loaded);
  const oldSalt = stateSaltHexOf(loaded);
  const dbFile = args.db ?? layout.dbFile;

  process.stdout.write(
    [
      '口令轮换（重新密封）',
      `  库文件      ${dbFile}`,
      `  旧口令来源  ${old.source === 'file' ? `服务端配置文件 ${configPath}` : '**内置演示口令**（换生产口令正是这一轮的用意）'}`,
      `  旧盐        ${oldSalt === undefined ? '无显式盐（按口令派生）' : oldSalt}`,
      `  服务端配置  ${configPath}`,
      '',
    ].join('\n'),
  );
  if (old.source === 'demo') {
    process.stdout.write('提示：现在用的是内置演示口令。轮换的目的通常就是把库换到生产口令上，请继续。\n\n');
  }

  const opened = ((): { db: ReturnType<typeof openDatabase>['db'] } => {
    try {
      return openDatabase(dbFile, { schemaVersion: STORAGE_SCHEMA_VERSION, migrations: MIGRATIONS });
    } catch (err) {
      die(`库打不开：${(err as Error).message}`);
    }
  })();
  const db = opened.db;

  try {
    if (!args.apply) {
      /* 试运行：不写任何东西，只回答"有几行、旧口令对不对" */
      const plan = planRekey(db, old.key);
      if (!plan.ok) {
        process.stderr.write(`[口令轮换] 试运行失败：${plan.message}\n`);
        process.exit(1);
        return;
      }
      process.stdout.write(
        [
          `事前检查：${describeRekeyPlan(plan.plan)}`,
          '  全部密封行都能用旧口令读通 ✓',
          '',
          '[试运行] 没有写入任何东西。确实要换口令时加 --apply（并给出 --new-key-file）。',
          '',
        ].join('\n'),
      );
      return;
    }

    if (args.newKeyFile === undefined) {
      die(`--apply 必须同时给出 --new-key-file（新口令从文件读，不从命令行参数读）\n\n${USAGE}`);
    }
    const newKey = readKeyFile(args.newKeyFile);
    if (newKey === old.key && args.newSalt === undefined) {
      die('新口令与旧口令相同，且没有指定 --new-salt：这次轮换什么也不会改变。', 1);
    }
    if (!args.yes) confirmRekey();

    const result = applyRekey(db, old.key, newKey, {
      ...(args.newSalt === undefined ? {} : { newSalt: args.newSalt }),
    });
    if (!result.ok) {
      process.stderr.write(`[口令轮换] 失败：${result.message}\n`);
      process.exit(1);
      return;
    }

    process.stdout.write(
      [
        `已重写：${describeRekeyPlan(result.plan)}`,
        '',
        '接下来三件事（顺序不要换）：',
        `  1) 把新口令写进服务端配置文件 ${configPath} 的 stateKey`,
        args.newSalt === undefined
          ? '     （盐沿用旧规则：配置文件里 stateSalt 为空就继续按新口令派生，无需改动）'
          : `     并把 stateSalt 改成 ${args.newSalt}`,
        `  2) 删掉新口令文件 ${args.newKeyFile ?? ''}（它现在只是一份明文口令副本），并按你们的密钥管理流程归档新口令`,
        '  3) 启动服务，确认启动日志里的"口令来源"与"盐"两行是预期的',
        '',
        '⚠️ 从这一刻起：**旧口令已经打不开这个库**（还没有换回旧口令的路）。',
        '⚠️ 如果服务进程现在还开着，请立刻停掉它再用新口令启动 —— 它内存里仍是旧口令。',
        '',
      ].join('\n'),
    );
  } finally {
    try {
      db.close();
    } catch {
      /* 关不掉就算了：进程马上就退出了 */
    }
  }
}

main();
