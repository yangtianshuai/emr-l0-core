/**
 * 命令行账号维护：**忘记口令时唯一的出路**。
 *
 * ## 为什么必须有它（而不是"忘了就用环境变量兜底"）
 *
 * 口令搬进数据库之后，多了一个共享口令时代没有的失败模式：
 * **唯一的管理员口令想不起来了**。这时如果没有任何自助通道，唯一的办法就是改库文件 ——
 * 而那需要知道 `scrypt` 哈希格式、盐的编码、参数列的意思。那不是一条能写进运维手册的路。
 *
 * 所以这里给一条明确的路，同时**不引入新的弱口令**：
 * 它直接读写同一个库、走同一个 `UserStore`（于是"最后一个管理员不能被删"这类红线
 * 在这里同样生效），并且口令**从标准输入读**，不从命令行参数读 ——
 * 命令行参数会进 shell 历史与进程列表（`ps` 里一行就能看见）。
 *
 * ## 用法
 *
 * ```bash
 * npm run user -- list
 * npm run user -- add dr-zhang clinician
 * npm run user -- passwd admin              # 口令从标准输入读
 * npm run user -- role dr-zhang qc
 * npm run user -- disable dr-zhang
 * npm run user -- enable  dr-zhang
 * npm run user -- remove  dr-zhang
 * ```
 *
 * 口令也可以由 `L0_NEW_PASSWORD` 给出（便于脚本化）；两者都没有时会提示着从标准输入读一行。
 */

import { MIGRATIONS, STORAGE_SCHEMA_VERSION } from '../storage/schema.ts';
import { openDatabase } from '../storage/sqlite.ts';
import { resolveRuntimeLayout } from '../core/runtime-dir.ts';
import { ROLE_LABELS, type Role } from './principal.ts';
import { UserError, UserStore, PASSWORD_MIN_LENGTH } from './user-store.ts';

/* ⚠️ 本环境的 `@types/node` 里 `readFileSync` 只声明了字符串路径（运行时支持 fd 0 = 标准输入）。
   与 `core/persistence.ts` 对 fs 的处置同一套办法：局部断言用到的形状。 */
const fsx = (await import('node:fs')) as unknown as {
  readFileSync: (path: string | number, options: string) => string;
};

const USAGE = [
  '用法：npm run user -- <命令> [参数]',
  '',
  '  list                     列出全部账号（不含任何口令材料）',
  '  add <用户名> <角色>      新增账号（口令从标准输入读）',
  '  passwd <用户名>          重设口令（口令从标准输入读）',
  '  role <用户名> <角色>     改角色',
  '  disable <用户名>         停用账号（停用即不能登录，会话会被踢掉）',
  '  enable <用户名>          重新启用',
  '  remove <用户名>          删除账号',
  '',
  `角色：${Object.keys(ROLE_LABELS).join(' / ')}`,
  `口令：至少 ${PASSWORD_MIN_LENGTH} 位；可用 L0_NEW_PASSWORD 环境变量代替标准输入`,
].join('\n');

function die(message: string): never {
  process.stderr.write(`[账号] ${message}\n`);
  process.exit(1);
  throw new Error(message);
}

/**
 * 口令来源：环境变量 > 标准输入。
 *
 * **刻意不支持命令行参数**：`npm run user -- passwd admin mypassword` 会把这串口令
 * 写进 shell 历史、写进 `ps` 的输出、也写进 npm 的日志。而这三处都是别人能看到的。
 */
function readNewPassword(): string {
  const fromEnv = process.env.L0_NEW_PASSWORD;
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  const stdin = (process as unknown as { stdin?: { isTTY?: boolean } }).stdin;
  if (stdin?.isTTY) {
    process.stderr.write(
      `请输入新口令（至少 ${PASSWORD_MIN_LENGTH} 位），然后按 Ctrl+Z 回车（Windows）/ Ctrl+D（Linux）结束输入：\n`,
    );
  }
  let raw = '';
  try {
    raw = fsx.readFileSync(0, 'utf8');
  } catch {
    die('读不到标准输入。请用管道把口令送进来（echo "新口令" | npm run user -- passwd admin），或设 L0_NEW_PASSWORD');
  }
  /* 只去掉**行尾**的换行：口令本身可以含空格，顺手 trim 会在"口令两端有空格"时静默改掉它 */
  return raw.replace(/\r?\n$/, '');
}

function requireArg(args: string[], index: number, name: string): string {
  const value = args[index];
  if (value === undefined || value.trim() === '') die(`缺少参数：${name}\n\n${USAGE}`);
  return value.trim();
}

function formatUser(user: { username: string; role: Role; roleLabel: string; disabled: boolean; updatedAt: string; updatedBy: string; lastLoginAt: string | null; passwordAlgo: string }): string {
  return [
    user.username.padEnd(20),
    user.roleLabel.padEnd(6),
    user.disabled ? '已停用' : '可用  ',
    `最近登录 ${user.lastLoginAt ?? '（从未）'}`.padEnd(30),
    `${user.passwordAlgo} · 由 ${user.updatedBy} 于 ${user.updatedAt} 最后修改`,
  ].join(' ');
}

function main(): void {
  const args = process.argv.slice(2);
  const command = args[0];
  if (command === undefined || command === '--help' || command === '-h') {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  const runtime = resolveRuntimeLayout(process.env);
  const opened = (() => {
    try {
      return openDatabase(runtime.dbFile, { schemaVersion: STORAGE_SCHEMA_VERSION, migrations: MIGRATIONS });
    } catch (err) {
      die(`打开数据库失败（${runtime.dbFile}）：${(err as Error).message}`);
    }
  })();
  /* 命令行工具的操作者在审计里记成 **cli**（而不是某个用户名）：
     它就是"有人在服务器上执行了命令"，冒充成某个用户名只会让审计说谎。
     这条也顺带说明了一件事：拿到服务器 shell 的人本来就能做这一切 —— 本工具不承诺抵抗它。 */
  const BY = 'cli';
  const store = new UserStore(opened.db);

  try {
    switch (command) {
      case 'list': {
        const users = store.list();
        if (users.length === 0) {
          process.stdout.write(`（还没有任何账号）数据库：${runtime.dbFile}\n在浏览器打开 /login 可创建第一个管理员，或用本工具 add 一个\n`);
          return;
        }
        process.stdout.write(`共 ${users.length} 个账号（数据库：${runtime.dbFile}）\n\n`);
        for (const user of users) process.stdout.write(`${formatUser(user)}\n`);
        return;
      }
      case 'add': {
        const username = requireArg(args, 1, '用户名');
        const role = requireArg(args, 2, '角色') as Role;
        const user = store.create({ username, password: readNewPassword(), role, by: BY });
        process.stdout.write(`已创建账号：${user.username}（${user.roleLabel}）\n`);
        return;
      }
      case 'passwd': {
        const username = requireArg(args, 1, '用户名');
        const user = store.setPassword({ username, password: readNewPassword(), by: BY });
        process.stdout.write(`已重设口令：${user.username}（${user.roleLabel}）\n**该账号已登录的会话需要在服务侧重启或由管理员在界面上重设后才会失效**\n`);
        return;
      }
      case 'role': {
        const username = requireArg(args, 1, '用户名');
        const role = requireArg(args, 2, '角色') as Role;
        const user = store.setRole({ username, role, by: BY });
        process.stdout.write(`已改角色：${user.username} → ${user.roleLabel}\n`);
        return;
      }
      case 'disable':
      case 'enable': {
        const username = requireArg(args, 1, '用户名');
        const user = store.setDisabled({ username, disabled: command === 'disable', by: BY });
        process.stdout.write(`已${command === 'disable' ? '停用' : '启用'}：${user.username}\n`);
        return;
      }
      case 'remove': {
        const username = requireArg(args, 1, '用户名');
        const user = store.remove({ username, by: BY });
        process.stdout.write(`已删除：${user.username}（${user.roleLabel}）\n`);
        return;
      }
      default:
        die(`未知命令：${command}\n\n${USAGE}`);
    }
  } catch (err) {
    if (err instanceof UserError) die(`${err.code}：${err.message}`);
    die((err as Error).message);
  } finally {
    opened.db.close();
  }
}

main();
