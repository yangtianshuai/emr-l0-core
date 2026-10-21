import { MIGRATIONS, STORAGE_SCHEMA_VERSION } from '../storage/schema.ts';
import { openDatabase } from '../storage/sqlite.ts';
import { resolveRuntimeLayout } from '../core/runtime-dir.ts';
import { ROLE_LABELS, type Role } from './principal.ts';
import { UserError, UserStore, PASSWORD_MIN_LENGTH } from './user-store.ts';

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
