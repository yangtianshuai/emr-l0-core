import { TestSuite, assert, assertEqual } from '../testing/harness.ts';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../storage/sqlite.ts';
import { MIGRATIONS, STORAGE_SCHEMA_VERSION } from '../storage/schema.ts';
import {
  PASSWORD_MIN_LENGTH,
  UserStore,
  hashPassword,
  passwordParamsOf,
  verifyPassword,
} from './user-store.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DIR = join(ROOT, 'artifacts', 'state-selftest', 'user-store-selftest');

const fsRemove = (await import('node:fs')) as unknown as { rmSync: (path: string, options: { recursive: boolean; force: boolean }) => void };

const suite = new TestSuite('后台账号自测', [
  '说明：真实 sqlite + 真实 scrypt；每个用例一个独立库文件（隔离，不互相污染）。',
  '要守的四件事：只存哈希 / 三种失败分得开 / 三条红线 fail-closed / 参数自描述。',
]);

const test = (name: string, fn: () => void | Promise<void>): Promise<void> => suite.test(name, fn);

let dbSeq = 0;
function openStore(): { store: UserStore; db: ReturnType<typeof openDatabase>['db'] } {
  dbSeq += 1;
  const opened = openDatabase(join(DIR, `case-${dbSeq}.db`), {
    schemaVersion: STORAGE_SCHEMA_VERSION,
    migrations: MIGRATIONS,
    at: '2026-10-14T00:00:00.000Z',
  });
  return { store: new UserStore(opened.db, { now: () => '2026-10-14T09:00:00.000Z' }), db: opened.db };
}

const PASSWORD = 'correct-horse-battery';

const cryptoSpecifier = 'node:crypto';
const nodeCrypto = (await import(cryptoSpecifier)) as unknown as {
  randomBytes: (size: number) => Uint8Array;
  scryptSync: (password: string, salt: Uint8Array, keylen: number, options: { N: number; r: number; p: number }) => Uint8Array;
};
const b64 = (bytes: Uint8Array): string =>
  (globalThis as unknown as { Buffer: { from(b: Uint8Array): { toString(enc: string): string } } }).Buffer.from(bytes).toString('base64');

function codeOf(fn: () => unknown): string {
  try {
    fn();
    return 'OK';
  } catch (err) {
    return String((err as { code?: string }).code ?? 'UNKNOWN');
  }
}

function assertThrows(fn: () => unknown, expected: string, message = '应当以指定错误码被拒'): void {
  assertEqual(codeOf(fn), expected, message);
}

function dbContainsPlaintext(db: { prepare: (sql: string) => { all: (...p: unknown[]) => Array<Record<string, unknown>> } }, needle: string): boolean {
  const rows = db.prepare('select username, role, password_hash, updated_by from admin_users').all();
  return JSON.stringify(rows).includes(needle);
}

async function main(): Promise<void> {
  try {
    fsRemove.rmSync(DIR, { recursive: true, force: true });
  } catch {
  }
  mkdirSync(DIR, { recursive: true });

  await test('U1 空库 = 未初始化；建第一个管理员后计数正确', () => {
    const { store } = openStore();
    assertEqual(store.count(), 0, '空库应当是"未初始化"（服务据此决定登录页显示初始化表单）');
    assertEqual(store.enabledAdminCount(), 0, '空库没有可用管理员');

    const created = store.create({ username: 'admin', password: PASSWORD, role: 'admin', by: 'installer' });
    assertEqual(created.username, 'admin', '用户名应保留原样');
    assertEqual(created.roleLabel, '管理员', '角色名应来自 ROLE_LABELS（界面不另译一遍）');
    assertEqual(created.disabled, false, '新建账号默认可用');
    assertEqual(created.updatedBy, 'installer', '要记下是谁建的');
    assertEqual(created.lastLoginAt, null, '还没登录过就是从未');
    assertEqual(store.count(), 1, '建好了就是 1 个');
    assertEqual(store.enabledAdminCount(), 1, '可用管理员 1 个');
  });

  await test('U2 只存哈希：库里搜不到口令明文（口令可逆地存起来就不是口令了）', () => {
    const { store, db } = openStore();
    store.create({ username: 'admin', password: PASSWORD, role: 'admin', by: 'installer' });
    assertEqual(dbContainsPlaintext(db, PASSWORD), false, '库文件里不得出现口令明文');
    assertEqual(dbContainsPlaintext(db, PASSWORD.slice(0, 6)), false, '连前缀片段也不该出现');
    const row = db.prepare('select password_hash from admin_users').all()[0];
    assertEqual(passwordParamsOf(String(row.password_hash))?.algo, 'scrypt', '存的应当是自描述的 scrypt 哈希串');
  });

  await test('U3 盐独立：同一个口令在两个账号上哈希不同', () => {
    const { store, db } = openStore();
    store.create({ username: 'admin', password: PASSWORD, role: 'admin', by: 'installer' });
    store.create({ username: 'qc1', password: PASSWORD, role: 'qc', by: 'installer' });
    const rows = db.prepare('select username, password_hash from admin_users order by username').all();
    assertEqual(String(rows[0].password_hash) === String(rows[1].password_hash), false, '两条哈希必须不同（盐独立）');
    assertEqual(verifyPassword(PASSWORD, String(rows[0].password_hash)), true, '第一条仍能验证通过');
    assertEqual(verifyPassword(PASSWORD, String(rows[1].password_hash)), true, '第二条仍能验证通过');
  });

  await test('U4 三种失败分得开：不存在 / 口令错 / 已停用（文案合并、判定分开）', () => {
    const { store } = openStore();
    store.create({ username: 'admin', password: PASSWORD, role: 'admin', by: 'installer' });
    /* 被停用的是非管理员：管理员一律停用会先撞上"最后一个管理员"红线（那是 U7 的场景）  */
    store.create({ username: 'qc1', password: PASSWORD, role: 'qc', by: 'installer' });

    assertEqual(store.verify('admin', 'wrong-password').ok, false, '口令错应当失败');
    const bad = store.verify('admin', 'wrong-password');
    assertEqual(bad.ok === false ? bad.code : '', 'E_USER_BAD_PASSWORD', '口令错应当是 E_USER_BAD_PASSWORD');

    const missing = store.verify('nobody', PASSWORD);
    assertEqual(missing.ok === false ? missing.code : '', 'E_USER_NOT_FOUND', '用户不存在应当是 E_USER_NOT_FOUND');

    store.setDisabled({ username: 'qc1', disabled: true, by: 'admin' });
    const disabled = store.verify('qc1', PASSWORD);
    assertEqual(disabled.ok === false ? disabled.code : '', 'E_USER_DISABLED', '停用后即使是正确口令也应被拒');

    /* 先验口令、再报停用：否则"这个账号存在但被停用"不用口令就能问出来  */
    const disabledWrong = store.verify('qc1', 'wrong-password');
    assertEqual(disabledWrong.ok === false ? disabledWrong.code : '', 'E_USER_BAD_PASSWORD', '停用 + 口令错应先报"口令错"');

    store.setDisabled({ username: 'qc1', disabled: false, by: 'admin' });
    assertEqual(store.verify('qc1', PASSWORD).ok, true, '启用后恢复登录');
  });

  await test('U5 用户名大小写不敏感：admin 与 Admin 是同一个账号', () => {
    const { store } = openStore();
    store.create({ username: 'Doctor.Zhang', password: PASSWORD, role: 'clinician', by: 'installer' });
    assertEqual(store.get('doctor.zhang')?.username, 'Doctor.Zhang', '查询应大小写不敏感');
    assertEqual(store.verify('DOCTOR.ZHANG', PASSWORD).ok, true, '换个大小写也应能登录');
    assertEqual(store.canonicalUsernameOf('doctor.zhang'), 'Doctor.Zhang', '会话里的名字要取库里的写法（否则审计里会出现"两个名字"）');
    /* 大小写不同但同名 → 拒绝：否则界面上会出现两个看起来一样的账号  */
    assertThrows(() => store.create({ username: 'doctor.zhang', password: PASSWORD, role: 'qc', by: 'installer' }), 'E_USER_EXISTS');
    assertEqual(store.count(), 1, '不允许建出大小写不同的双胞胎');
  });

  await test('U6 输入校验：口令太短 / 用户名非法 / 角色非法 —— 一律拒绝，不取默认', () => {
    const { store } = openStore();
    assertThrows(
      () => store.create({ username: 'admin', password: 'short', role: 'admin', by: 'installer' }),
      'E_USER_INVALID',
    );
    assert(PASSWORD_MIN_LENGTH >= 8, `口令门槛不该松到 8 位以下，实际 ${PASSWORD_MIN_LENGTH}`);
    for (const bad of ['a', '有中文', 'has space', 'with/slash', '', 'x'.repeat(33)]) {
      assertThrows(() => store.create({ username: bad, password: PASSWORD, role: 'admin', by: 'installer' }), 'E_USER_INVALID');
    }
    assertThrows(
      () => store.create({ username: 'admin', password: PASSWORD, role: 'superuser' as never, by: 'installer' }),
      'E_USER_INVALID',
    );
    assertEqual(store.count(), 0, '被拒的创建不得留下任何账号');
  });

  await test('U7 最后一个管理员不能被删 / 停用 / 降级（否则谁也进不去）', () => {
    const { store } = openStore();
    store.create({ username: 'admin', password: PASSWORD, role: 'admin', by: 'installer' });
    assertThrows(() => store.remove({ username: 'admin', by: 'cli' }), 'E_USER_LAST_ADMIN');
    assertThrows(() => store.setDisabled({ username: 'admin', disabled: true, by: 'cli' }), 'E_USER_LAST_ADMIN');
    assertThrows(() => store.setRole({ username: 'admin', role: 'viewer', by: 'cli' }), 'E_USER_LAST_ADMIN');

    store.create({ username: 'admin2', password: PASSWORD, role: 'admin', by: 'cli' });
    const demoted = store.setRole({ username: 'admin', role: 'qc', by: 'cli' });
    assertEqual(demoted.roleLabel, '质控员', '有两个管理员时，降级一个应当被允许');
    assertEqual(store.enabledAdminCount(), 1, '此时只剩 admin2 一个可用管理员');
    assertThrows(() => store.remove({ username: 'admin2', by: 'cli' }), 'E_USER_LAST_ADMIN', '最后一个仍然不能被删');

    store.create({ username: 'admin3', password: PASSWORD, role: 'admin', by: 'cli' });
    assertEqual(store.enabledAdminCount(), 2, '现在有 2 个可用管理员');
    store.setDisabled({ username: 'admin2', disabled: true, by: 'cli' });
    assertThrows(() => store.remove({ username: 'admin3', by: 'cli' }), 'E_USER_LAST_ADMIN', 'admin2 已停用，admin3 就是最后一个');
  });

  await test('U8 不能停用/删除自己，但**可以**改自己的口令', () => {
    const { store } = openStore();
    store.create({ username: 'admin', password: PASSWORD, role: 'admin', by: 'installer' });
    store.create({ username: 'admin2', password: PASSWORD, role: 'admin', by: 'installer' });

    assertThrows(() => store.setDisabled({ username: 'admin', disabled: true, by: 'admin' }), 'E_USER_SELF_LOCKOUT');
    assertThrows(() => store.remove({ username: 'admin', by: 'ADMIN' }), 'E_USER_SELF_LOCKOUT', '自己比对也要大小写不敏感');
    assertThrows(() => store.setRole({ username: 'admin', role: 'qc', by: 'admin' }), 'E_USER_SELF_LOCKOUT');

    const next = 'another-long-password';
    store.setPassword({ username: 'admin', password: next, by: 'admin' });
    assertEqual(store.verify('admin', next).ok, true, '改自己的口令是该让人能自己做的事');
    assertEqual(store.verify('admin', PASSWORD).ok, false, '旧口令必须立刻失效');

    for (const act of [
      () => store.setPassword({ username: 'admin2', password: next, by: '' }),
      () => store.setPassword({ username: 'admin2', password: next, by: '   ' }),
      () => store.setRole({ username: 'admin2', role: 'qc', by: ' ' }),
      () => store.setDisabled({ username: 'admin2', disabled: false, by: '' }),
      () => store.remove({ username: 'admin2', by: '' }),
      () => store.create({ username: 'nobody2', password: next, role: 'qc', by: ' ' }),
    ]) {
      assertThrows(act, 'E_USER_INVALID', '空操作者的写路径应当一律被拒');
    }
    assertEqual(store.get('admin2')?.role, 'admin', '被拒的调用不得改动任何东西');
  });

  await test('U9 重设口令后旧口令失效；停用/启用往返；删除后查不到', () => {
    const { store } = openStore();
    store.create({ username: 'admin', password: PASSWORD, role: 'admin', by: 'installer' });
    store.create({ username: 'doc1', password: PASSWORD, role: 'clinician', by: 'installer' });

    store.setPassword({ username: 'doc1', password: 'brand-new-password', by: 'admin' });
    assertEqual(store.verify('doc1', PASSWORD).ok, false, '旧口令失效');
    assertEqual(store.verify('doc1', 'brand-new-password').ok, true, '新口令可用');
    assertEqual(store.get('doc1')?.updatedBy, 'admin', '记下是谁改的');

    store.setDisabled({ username: 'doc1', disabled: true, by: 'admin' });
    assertEqual(store.get('doc1')?.disabled, true, '停用落库');
    store.setDisabled({ username: 'doc1', disabled: false, by: 'admin' });
    assertEqual(store.get('doc1')?.disabled, false, '启用落库');

    store.remove({ username: 'doc1', by: 'admin' });
    assertEqual(store.get('doc1'), null, '删除后查不到');
    assertEqual(store.count(), 1, '只剩管理员');
  });

  await test('U10 参数自描述：换一组 scrypt 参数写下的哈希仍能验证（提高参数不会让口令一起失效）', () => {
    const salt = nodeCrypto.randomBytes(16);
    const legacyN = 1024;
    const derived = nodeCrypto.scryptSync(PASSWORD, salt, 32, { N: legacyN, r: 8, p: 1 });
    const legacy = ['scrypt', legacyN, 8, 1, b64(salt), b64(derived)].join('$');

    assertEqual(passwordParamsOf(legacy)?.N, legacyN, '参数应能从哈希串里读出来');
    assertEqual(verifyPassword(PASSWORD, legacy), true, '旧参数的哈希必须仍能验证通过');
    assertEqual(verifyPassword('wrong-password', legacy), false, '口令错仍要失败');
    assertEqual(passwordParamsOf('scrypt$16384$8'), null, '字段不足的串解不开（**不猜、不回落到默认参数**）');
    assertEqual(verifyPassword(PASSWORD, 'not-a-hash'), false, '形状不对一律判失败，不抛异常给调用方');
  });

  await test('U11 list 只下发白名单字段：响应体里没有哈希、没有盐', () => {
    const { store } = openStore();
    store.create({ username: 'admin', password: PASSWORD, role: 'admin', by: 'installer' });
    const listed = store.list();
    assertEqual(listed.length, 1, '应有 1 条');
    const keys = Object.keys(listed[0]).sort().join(',');
    assertEqual(
      keys,
      'createdAt,disabled,lastLoginAt,passwordAlgo,role,roleLabel,updatedAt,updatedBy,username',
      '字段白名单：多一个字段就等于多一份可能被下发的材料',
    );
    assertEqual(JSON.stringify(listed).includes('scrypt$'), false, '不得带出哈希串本身（只带算法名）');
  });

  await test('U12 touchLogin 记下最近登录时间（"这个账号到底有没有人在用"）', () => {
    const { store } = openStore();
    store.create({ username: 'admin', password: PASSWORD, role: 'admin', by: 'installer' });
    assertEqual(store.get('admin')?.lastLoginAt, null, '建完还没登录');
    store.touchLogin('admin');
    assertEqual(store.get('admin')?.lastLoginAt, '2026-10-14T09:00:00.000Z', '登录后应当记下时间');
  });

  await test('U13 角色值读不出来就报错，不回落成默认角色', () => {
    const { store, db } = openStore();
    store.create({ username: 'admin', password: PASSWORD, role: 'admin', by: 'installer' });
    db.prepare("update admin_users set role = 'superuser' where username = 'admin'").run();
    assertThrows(() => store.list(), 'E_USER_INVALID');
    assertThrows(() => store.get('admin'), 'E_USER_INVALID');
    assertThrows(() => store.verify('admin', PASSWORD), 'E_USER_INVALID');
  });

  await test('U14 hashPassword / verifyPassword 往返保真', () => {
    const encoded = hashPassword(PASSWORD);
    assertEqual(verifyPassword(PASSWORD, encoded), true, '正确口令应当通过');
    assertEqual(verifyPassword(`${PASSWORD} `, encoded), false, '多余空格是另一个口令（不做 trim）');
    assertEqual(verifyPassword('', encoded), false, '空口令不通过');
    assertEqual(encoded.split('$').length, 6, '格式是 scrypt$N$r$p$salt$hash');
    const odd = 'pass word@#123';
    assertEqual(verifyPassword(odd, hashPassword(odd)), true, '含空格的口令必须原样可用');
    assertThrows(() => hashPassword('short'), 'E_USER_INVALID');
  });

const code = suite.report();
  try {
    fsRemove.rmSync(DIR, { recursive: true, force: true });
  } catch (err) {
    console.log(`（提示）测试库清理失败，不影响结论：${(err as Error).message.split('\n')[0] ?? ''}`);
  }
  process.exit(code);
}

void main();
