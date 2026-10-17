/**
 * 后台账号（用户名 + 口令 + 角色）落库。
 *
 * ## 为什么要有这一层，而不是继续用环境变量里的三条共享口令
 *
 * 三条共享口令（`L0_ADMIN_TOKEN` / `L0_QC_TOKEN` / `L0_CLINICIAN_TOKEN`）能表达
 * "管理员 / 质控员 / 医生"三档角色，但**加不了第 4 个人**：那三条口令是三条口令，
 * 不是三个账号 —— 两个人共用一条口令时，审计里那个名字就不再指向任何具体的人。
 * 落到库里的直接收益只有三条，但都是共享口令做不到的：
 *
 * | 收益 | 共享口令下的现状 |
 * |---|---|
 * | **多账号** | 一条口令多人持有，`actorId` 是登录时自己填的，可抵赖性为零 |
 * | **可轮换 / 可吊销** | 改口令 = 改 `.env` + **重启**（启动时读一次） |
 * | **可停用** | 只能整条口令作废，等于把同角色的所有人都关了 |
 *
 * ## 口令怎么存：**哈希，不是加密**
 *
 * | 规则 | 为什么 |
 * |---|---|
 * | `scrypt` + 每条独立的随机盐 | 口令是人选的、熵低，快哈希（SM3/SHA-256 裸算）面对被拷走的库文件就是离线爆破的靶子。这里**刻意不复用** `server/actor-directory.ts` 的 `tokenFingerprint()`（那是给高熵令牌用的，口令不能照搬） |
 * | 参数写进哈希串本身（`scrypt$N$r$p$salt$hash`） | 自描述：将来提高 N 时，旧口令仍能按它自称的参数被验证，而不是"全体口令一夜失效" |
 * | **不加密** | 加密要一把口令，而"打开后台需要的那把口令"又去依赖另一把 —— 一个说不清要先有谁的圈。哈希不可逆，所以没有这个圈 |
 * | 验证走 `timingSafeEqual` | 逐字节比较的耗时差异足够把口令一位一位试出来 |
 * | **用户名不存在时也做一次假验证** | 否则"用户不存在"比"口令错"快一个数量级，登录页那句"不区分两者"就成了谎话 |
 *
 * ## 三条 fail-closed 的红线（在 store 里判，不在路由里判）
 *
 * 放在 store 里，是因为它们是**数据完整性**规则：任何调用方（HTTP 路由、命令行工具、
 * 将来的批量导入）都必须被同一套规则挡住。写两遍迟早漏一处，而漏掉的那一处是：
 *
 *   1) **不许删掉/停用/降级最后一个能用的管理员** —— 那等于把所有人锁在门外，
 *      而门外的人没有任何自助路径（只能去改库文件，那比报错糟得多）；
 *   2) **不许停用/删除自己** —— 手滑一次就把自己关在外面，而屏幕上没有任何迹象；
 *      （改自己的**口令**是允许的，那正是该让人能自己做的事）
 *   3) **口令不短于 `PASSWORD_MIN_LENGTH`** —— 唯一的长度门槛。
 */

import { countOf, type SqliteDatabase } from '../storage/sqlite.ts';
import { ROLE_LABELS, type Role } from './principal.ts';

/* ⚠️ 本环境的 `@types/node` 里 `node:crypto` 的类型不完整（没有 `scryptSync` / `timingSafeEqual`，
   `randomBytes` 的返回值也只声明了无参 `toString()`）。处置办法与 `storage/sqlite.ts` 对
   `node:sqlite` 完全相同：用**变量**做说明符绕开模块解析，再按用到的形状局部断言。
   这里既是绕开类型的短板，也是在明说"类型是这个环境的短板" —— 而不是把类型放宽到 any。 */
const cryptoSpecifier = 'node:crypto';
const nodeCrypto = (await import(cryptoSpecifier)) as unknown as {
  randomBytes: (size: number) => Uint8Array;
  scryptSync: (password: string, salt: Uint8Array, keylen: number, options: { N: number; r: number; p: number }) => Uint8Array;
  timingSafeEqual: (a: Uint8Array, b: Uint8Array) => boolean;
};

/** 本环境 `Buffer` 只有值、没有可用的类型声明（`Buffer` 当类型用会编译报错），所以只借它的编码能力 */
interface BufferCtor {
  from(bytes: Uint8Array): { toString(encoding: string): string };
  from(text: string, encoding: string): Uint8Array;
}
const Buf = (globalThis as unknown as { Buffer: BufferCtor }).Buffer;
const toBase64 = (bytes: Uint8Array): string => Buf.from(bytes).toString('base64');

/** 口令最小长度。**唯一的**长度规则：只设下限，不设"必须含大小写+符号"那类规则 */
export const PASSWORD_MIN_LENGTH = 8;

/**
 * scrypt 参数（**改它 = 改这一常量**，旧哈希不会被破坏 —— 参数在哈希串里）。
 *
 * 取 2^14 的理由：单次验证约 50~80ms，登录页点一下的体感可以接受，
 * 而离线爆破的成本是每条候选口令都要付一次这个代价（内存 128·N·r = 16MB/次，也不是白给的）。
 * 再往上抬到 2^15 会让"密码管理器自动填表 + 慢网络"叠加成两秒级的等待 ——
 * 那个代价会让人去改短口令，反而更糟。
 */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 } as const;
const HASH_ALGO = 'scrypt';

/** 用户名规则：ASCII 工号/账号风格。**不做中文名** —— 中文名是"姓名"，不是账号，两者混在一起必然要被问到"到底是哪个" */
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

/**
 * 入库的账号视图。**不含任何口令材料** —— 它会被下发给管理后台，
 * 所以这里放什么，就等于"页面响应体里有什么"。
 */
export interface AdminUser {
  username: string;
  role: Role;
  roleLabel: string;
  disabled: boolean;
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
  lastLoginAt: string | null;
  /** 哈希算法标识（如 `scrypt`）：只用于展示"用的是什么算法"，不是哈希本身 */
  passwordAlgo: string;
}

export type VerifyResult =
  | { ok: true; user: AdminUser }
  | { ok: false; code: 'E_USER_NOT_FOUND' | 'E_USER_DISABLED' | 'E_USER_BAD_PASSWORD' };

/* ------------------------------ 口令哈希 ------------------------------ */

/**
 * 生成口令哈希：`scrypt$N$r$p$<salt-b64>$<hash-b64>`。
 *
 * 盐**每条独立随机**（16 字节）：共用盐会让"同一个口令在两个账号上哈希相同"，
 * 于是攻破一个就等于攻破另一个。
 */
export function hashPassword(password: string): string {
  assertPasswordAcceptable(password);
  const salt = nodeCrypto.randomBytes(16);
  const derived = nodeCrypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return [HASH_ALGO, SCRYPT.N, SCRYPT.r, SCRYPT.p, toBase64(salt), toBase64(derived)].join('$');
}

/** 解出口令哈希串里的算法与参数（自描述格式）；解不开返回 null（**不猜、不回落到默认参数**） */
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

/** 验证口令。参数按**哈希串自己声明的**取值（于是提高参数不会让旧口令一起失效） */
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
    /* 参数大到本机算不出来（如库被人改成 N=2^30）：**判为验证失败**，不把异常抛给调用方 ——
       抛出去会让登录接口 500，而那看起来像服务坏了，不像"口令不对"。 */
    return false;
  }
  return derived.length === expected.length && nodeCrypto.timingSafeEqual(derived, expected);
}

/**
 * 用户名不存在时用的**假验证**：让"用户不存在"与"口令错"的耗时落在同一个量级。
 *
 * 这里刻意用一条固定的哈希串（`DUMMY_HASH`）而不是"直接返回"：
 * 直接返回会让不存在的用户名快一个数量级，于是登录页那句
 * "不区分两者"在实际计时下就是假的 —— 而这种假话比不说更糟。
 */
const DUMMY_HASH = hashPassword('l0-user-store-dummy-password-不是任何真实口令');
function dummyVerify(password: string): void {
  verifyPassword(password, DUMMY_HASH);
}

/** 口令本身的规则（长度）。**不在口令上做字符集要求**：那类规则会把人逼去写 `Abc123!@#` */
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

/* ------------------------------ 存储 ------------------------------ */

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
    /* 角色值读不出来就**报错**，不回落成某个默认角色：把"库被人改坏了"静默变成
       "这个人现在是只读"，会让一个越权问题看起来像一个功能问题。 */
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
  /** 时钟（测试注入，保证可复现） */
  now?: () => string;
}

/**
 * 账号仓储。**本仓库唯一读写 `admin_users` 的地方** ——
 * 于是"口令怎么哈希、红了哪些线"只有一处答案。
 */
export class UserStore {
  private readonly db: SqliteDatabase;
  private readonly now: () => string;

  constructor(db: SqliteDatabase, options: UserStoreOptions = {}) {
    this.db = db;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /** 账号总数（**未初始化** = 0；服务据它决定登录页显示"初始化"还是"登录"） */
  count(): number {
    return countOf(this.db, 'select count(*) as n from admin_users');
  }

  /** 还有几个**能登录的管理员**：最后一个人不能被删/停用/降级，判据就是它 */
  enabledAdminCount(): number {
    return countOf(this.db, "select count(*) as n from admin_users where role = 'admin' and disabled = 0");
  }

  list(): AdminUser[] {
    return (this.db.prepare(`select ${COLUMNS} from admin_users order by role, username collate nocase`).all() as UserRow[]).map(toUser);
  }

  /** 按用户名取账号（**大小写不敏感**：`Admin` 与 `admin` 不该是两个账号，那只会让人登错入口） */
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

  /**
   * 验证登录。三种失败**在返回码里分开、在给用户的文案里合并** ——
   * 服务端要据此写审计（"有人在试不存在的账号"与"口令错"是两件事），
   * 而登录页一律只说"用户名或口令不正确"（多说一句就是给爆破者的反馈）。
   */
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
    /* **先验口令、再报停用**：反过来的话，"这个账号存在但被停用"会变成一个不需要口令
       就能问出来的事实（拿一个字典挨个试用户名即可）。 */
    if (user.disabled) return { ok: false, code: 'E_USER_DISABLED' };
    return { ok: true, user };
  }

  /** 记一次成功登录（审计之外唯一被更新的字段：它回答"这个账号到底有没有人在用"） */
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

  /**
   * 停用 / 启用。
   *
   * 启用的方向**不检查"最后一个管理员"**：把一个被停用的管理员重新启用只会让可用管理员变多，
   * 而"变多"永远不会把人锁在外面。
   */
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

  /**
   * 挡住"把最后一个能用管理员弄没"。
   *
   * 为什么这条必须是**数据层**的规则：它挡住的是一个**没有退路的**状态 ——
   * 门里没人了，门外的人只能去改库文件或直接删库。而"改库文件"不是一条可以
   * 写在运维手册里的出路（那需要知道哈希格式）。
   *
   * ⚠️ 一条容易被误读的性质：**走 HTTP 时这条规则几乎被"不许操作自己"遮住了** ——
   * 只有管理员能调那些接口，而库里只剩一个管理员时，他对自己动手会先撞上 `E_USER_SELF_LOCKOUT`
   * （那条更早判）。所以它真正起作用的地方是**命令行工具**（`npm run user`，
   * 那里的操作者记作 `cli`，永远不等于任何用户名）。这不是冗余：
   * 少了它，`npm run user -- remove admin` 会把这台机器变成谁也进不去的状态。
   */
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

/**
 * 操作者必填。**每个改数据的动作都要先过这一关** ——
 * `updated_by` 如实地记下"是谁做的这件事"是这张表存在的理由之一，
 * 而空操作者会让审计里出现一条没人认领的变更。
 *
 * 这一条曾经只写在 `assertNotSelf` 里，于是**只改了别人口令的那条路径漏掉了它**
 * （谁都能用空操作者改口令，审计里就查不出是谁改的）—— 被 U8 抓住。
 */
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
