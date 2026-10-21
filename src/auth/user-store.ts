import { countOf, type SqliteDatabase } from '../storage/sqlite.ts';
import { ROLE_LABELS, type Role } from './principal.ts';

const cryptoSpecifier = 'node:crypto';
const nodeCrypto = (await import(cryptoSpecifier)) as unknown as {
  randomBytes: (size: number) => Uint8Array;
  scryptSync: (password: string, salt: Uint8Array, keylen: number, options: { N: number; r: number; p: number }) => Uint8Array;
  timingSafeEqual: (a: Uint8Array, b: Uint8Array) => boolean;
};

interface BufferCtor {
  from(bytes: Uint8Array): { toString(encoding: string): string };
  from(text: string, encoding: string): Uint8Array;
}
const Buf = (globalThis as unknown as { Buffer: BufferCtor }).Buffer;
const toBase64 = (bytes: Uint8Array): string => Buf.from(bytes).toString('base64');

/** 口令最小长度。唯一的长度规则：只设下限，不设"必须含大小写+符号"那类规则  */
export const PASSWORD_MIN_LENGTH = 8;

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 } as const;
const HASH_ALGO = 'scrypt';

const USERNAME_PATTERN = /^[A-Za-z0-9._@-]{2,32}$/;

export type UserErrorCode =
  | 'E_USER_INVALID'
  | 'E_USER_EXISTS'
  | 'E_USER_NOT_FOUND'
  | 'E_USER_DISABLED'
  | 'E_USER_BAD_PASSWORD'
  | 'E_USER_LAST_ADMIN'
  | 'E_USER_SELF_LOCKOUT';

export class UserError extends Error {
  readonly code: UserErrorCode;

  constructor(code: UserErrorCode, message: string) {
    super(message);
    this.name = 'UserError';
    this.code = code;
  }
}

export interface AdminUser {
  username: string;
  role: Role;
  roleLabel: string;
  disabled: boolean;
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
  lastLoginAt: string | null;
  passwordAlgo: string;
}

export type VerifyResult =
  | { ok: true; user: AdminUser }
  | { ok: false; code: 'E_USER_NOT_FOUND' | 'E_USER_DISABLED' | 'E_USER_BAD_PASSWORD' };

export function hashPassword(password: string): string {
  assertPasswordAcceptable(password);
  const salt = nodeCrypto.randomBytes(16);
  const derived = nodeCrypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return [HASH_ALGO, SCRYPT.N, SCRYPT.r, SCRYPT.p, toBase64(salt), toBase64(derived)].join('$');
}

/** 解出口令哈希串里的算法与参数（自描述格式）；解不开返回 null（不猜、不回落到默认参数）  */
export function passwordParamsOf(encoded: string): { algo: string; N: number; r: number; p: number } | null {
  const parts = String(encoded).split('$');
  if (parts.length !== 6) return null;
  const [algo, rawN, rawR, rawP] = parts;
  const N = Number(rawN);
  const r = Number(rawR);
  const p = Number(rawP);
  if (algo !== HASH_ALGO || !Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return null;
  return { algo, N, r, p };
}

export function verifyPassword(password: string, encoded: string): boolean {
  const parts = String(encoded).split('$');
  if (parts.length !== 6) return false;
  const saltB64 = parts[4] ?? '';
  const hashB64 = parts[5] ?? '';
  const params = passwordParamsOf(encoded);
  if (!params) return false;
  let salt: Uint8Array;
  let expected: Uint8Array;
  try {
    salt = Buf.from(saltB64, 'base64');
    expected = Buf.from(hashB64, 'base64');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;
  let derived: Uint8Array;
  try {
    derived = nodeCrypto.scryptSync(String(password), salt, expected.length, { N: params.N, r: params.r, p: params.p });
  } catch {
    return false;
  }
  return derived.length === expected.length && nodeCrypto.timingSafeEqual(derived, expected);
}

const DUMMY_HASH = hashPassword('l0-user-store-dummy-password-不是任何真实口令');
function dummyVerify(password: string): void {
  verifyPassword(password, DUMMY_HASH);
}

function assertPasswordAcceptable(password: string): void {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH) {
    throw new UserError(
      'E_USER_INVALID',
      `口令至少 ${PASSWORD_MIN_LENGTH} 位（实际 ${typeof password === 'string' ? password.length : 0} 位）：` +
        '口令是人选的、熵低，短口令在库文件被拷走时几乎等于没有口令',
    );
  }
}

function assertUsernameAcceptable(username: string): void {
  if (!USERNAME_PATTERN.test(username)) {
    throw new UserError(
      'E_USER_INVALID',
      `用户名只能由字母、数字与 . _ @ - 组成，长度 2~32（实际 ${JSON.stringify(username)}）：` +
        '用户名是**账号**而不是姓名，两者混在一起事后必然要被问到"到底是哪个"',
    );
  }
}

function assertRoleAcceptable(role: Role): void {
  if (!Object.prototype.hasOwnProperty.call(ROLE_LABELS, role)) {
    throw new UserError('E_USER_INVALID', `角色只能是 ${Object.keys(ROLE_LABELS).join(' / ')}，实际 ${JSON.stringify(role)}`);
  }
}

interface UserRow {
  username?: string;
  role?: string;
  password_hash?: string;
  disabled?: number;
  created_at?: string;
  updated_at?: string;
  updated_by?: string;
  last_login_at?: string | null;
}

const COLUMNS = 'username, role, password_hash, disabled, created_at, updated_at, updated_by, last_login_at';

function toUser(row: UserRow): AdminUser {
  const role = String(row.role ?? '');
  if (!Object.prototype.hasOwnProperty.call(ROLE_LABELS, role)) {
    throw new UserError('E_USER_INVALID', `账号角色不是已知角色：${JSON.stringify(role)}（库被改过？）`);
  }
  const username = String(row.username ?? '');
  return {
    username,
    role: role as Role,
    roleLabel: ROLE_LABELS[role as Role],
    disabled: Number(row.disabled ?? 0) !== 0,
    createdAt: String(row.created_at ?? ''),
    updatedAt: String(row.updated_at ?? ''),
    updatedBy: String(row.updated_by ?? ''),
    lastLoginAt: row.last_login_at ? String(row.last_login_at) : null,
    passwordAlgo: passwordParamsOf(String(row.password_hash ?? ''))?.algo ?? '未知',
  };
}

export interface UserStoreOptions {
  now?: () => string;
}

export class UserStore {
  private readonly db: SqliteDatabase;
  private readonly now: () => string;

  constructor(db: SqliteDatabase, options: UserStoreOptions = {}) {
    this.db = db;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  count(): number {
    return countOf(this.db, 'select count(*) as n from admin_users');
  }

  enabledAdminCount(): number {
    return countOf(this.db, "select count(*) as n from admin_users where role = 'admin' and disabled = 0");
  }

  list(): AdminUser[] {
    return (this.db.prepare(`select ${COLUMNS} from admin_users order by role, username collate nocase`).all() as UserRow[]).map(toUser);
  }

  get(username: string): AdminUser | null {
    const row = this.db
      .prepare(`select ${COLUMNS} from admin_users where username = ? collate nocase`)
      .get(String(username).trim()) as UserRow | undefined;
    return row ? toUser(row) : null;
  }

  /** 库里记的真实用户名（用于把自己输入的 `Admin` 认成 `admin`，让会话里的名字永远与库一致） */
  canonicalUsernameOf(username: string): string | null {
    const row = this.db
      .prepare('select username from admin_users where username = ? collate nocase')
      .get(String(username).trim()) as { username?: string } | undefined;
    return row?.username ? String(row.username) : null;
  }

  verify(username: string, password: string): VerifyResult {
    const row = this.db
      .prepare(`select ${COLUMNS} from admin_users where username = ? collate nocase`)
      .get(String(username).trim()) as UserRow | undefined;
    if (!row) {
      dummyVerify(password);
      return { ok: false, code: 'E_USER_NOT_FOUND' };
    }
    const user = toUser(row);
    if (!verifyPassword(password, String(row.password_hash ?? ''))) {
      return { ok: false, code: 'E_USER_BAD_PASSWORD' };
    }
    if (user.disabled) return { ok: false, code: 'E_USER_DISABLED' };
    return { ok: true, user };
  }

  touchLogin(username: string): void {
    this.db.prepare('update admin_users set last_login_at = ? where username = ? collate nocase').run(this.now(), String(username).trim());
  }

  create(input: { username: string; password: string; role: Role; by: string }): AdminUser {
    const username = String(input.username).trim();
    assertBy(input.by);
    assertUsernameAcceptable(username);
    assertPasswordAcceptable(input.password);
    assertRoleAcceptable(input.role);
    if (this.get(username)) {
      throw new UserError('E_USER_EXISTS', `账号已存在：${username}（用户名不区分大小写，"${username}"与"admin"可能是同一个）`);
    }
    const at = this.now();
    const hash = hashPassword(input.password);
    this.db
      .prepare(`insert into admin_users (${COLUMNS}) values (?, ?, ?, 0, ?, ?, ?, null)`)
      .run(username, input.role, hash, at, at, input.by);
    const created = this.get(username);
    if (!created) throw new UserError('E_USER_NOT_FOUND', `账号写入后读不回来：${username}`);
    return created;
  }

  setPassword(input: { username: string; password: string; by: string }): AdminUser {
    assertBy(input.by);
    assertPasswordAcceptable(input.password);
    const user = this.requireUser(input.username);
    this.db
      .prepare('update admin_users set password_hash = ?, updated_at = ?, updated_by = ? where username = ? collate nocase')
      .run(hashPassword(input.password), this.now(), input.by, user.username);
    return this.requireUser(user.username);
  }

  setRole(input: { username: string; role: Role; by: string }): AdminUser {
    assertBy(input.by);
    assertRoleAcceptable(input.role);
    const user = this.requireUser(input.username);
    assertNotSelf(input.by, user.username, '改自己的角色');
    this.assertNotLastAdmin(user, input.role === 'admin' ? {} : { losingAdmin: true });
    this.db
      .prepare('update admin_users set role = ?, updated_at = ?, updated_by = ? where username = ? collate nocase')
      .run(input.role, this.now(), input.by, user.username);
    return this.requireUser(user.username);
  }

  setDisabled(input: { username: string; disabled: boolean; by: string }): AdminUser {
    assertBy(input.by);
    const user = this.requireUser(input.username);
    if (input.disabled) {
      assertNotSelf(input.by, user.username, '停用自己');
      this.assertNotLastAdmin(user, { losingAdmin: true });
    }
    this.db
      .prepare('update admin_users set disabled = ?, updated_at = ?, updated_by = ? where username = ? collate nocase')
      .run(input.disabled ? 1 : 0, this.now(), input.by, user.username);
    return this.requireUser(user.username);
  }

  remove(input: { username: string; by: string }): AdminUser {
    assertBy(input.by);
    const user = this.requireUser(input.username);
    assertNotSelf(input.by, user.username, '删除自己');
    this.assertNotLastAdmin(user, { losingAdmin: true });
    this.db.prepare('delete from admin_users where username = ? collate nocase').run(user.username);
    return user;
  }

  private requireUser(username: string): AdminUser {
    const user = this.get(username);
    if (!user) throw new UserError('E_USER_NOT_FOUND', `账号不存在：${String(username).trim()}`);
    return user;
  }

  private assertNotLastAdmin(user: AdminUser, options: { losingAdmin?: boolean }): void {
    if (!options.losingAdmin) return;
    if (user.role !== 'admin' || user.disabled) return;
    const remaining = this.enabledAdminCount() - 1;
    if (remaining <= 0) {
      throw new UserError(
        'E_USER_LAST_ADMIN',
        `不能把「${user.username}」移除或降级：他是**最后一个可登录的管理员**，` +
          '那样谁也进不了管理后台（记住口令也不能让口令在不在的问题），' +
          '请先建好另一个管理员账号',
      );
    }
  }
}

function assertBy(by: string): void {
  if (typeof by !== 'string' || by.trim() === '') {
    throw new UserError('E_USER_INVALID', '操作者不得为空（`updated_by` 要如实地记下是谁做的这件事）');
  }
}

function assertNotSelf(by: string, username: string, what: string): void {
  assertBy(by);
  if (by.toLowerCase() === username.toLowerCase()) {
    throw new UserError(
      'E_USER_SELF_LOCKOUT',
      `不允许${what}：手滑一次就把自己关在门外，而屏幕上没有任何迹象。` +
        '（改自己的**口令**是允许的 —— 那是该让人能自己做的事）',
    );
  }
}
