/**
 * 工作区存储：把"不属于文档内容、但丢了会出事"的三份数据一起存成**一个快照**。
 *
 * 三份数据：AI 建议（`SuggestionBook`）、旁挂注解（`AnnotationBook`）、患者主索引（`PatientIndex`）。
 * 它们此前都是会话级内存 —— 进程重启即失，而界面上看不出任何异常。
 *
 * ## 一个快照文件，而不是三个
 *
 * 分别存会引入**跨文件不一致**：建议存成功了、注解没存，重启后就会出现
 * "这批建议存在，但它们的处置记录不见了"。原子写只能保证**单文件**要么全写要么不写，
 * 要保证"三份一起生效"就必须放进同一个文件。
 *
 * ## 首次启动与数据丢失必须分开
 *
 * `loadWorkspace` 把"文件不存在"（`firstRun: true`）与"文件损坏"（`firstRun: false`）
 * 分得很清楚：前者可以安心建空工作区，后者**必须停下来报错**。
 * 把两者混成一个"读不出来就当空"的分支，是数据丢失最容易被伪装成正常的方式。
 */

import { AnnotationBook, type AnnotationBookSnapshot } from './annotations.ts';
import { SuggestionBook, type SuggestionBookSnapshot } from './suggestions.ts';
import { readSnapshot, snapshotExists, writeSnapshot, type SnapshotMeta, type SnapshotOptions, type SnapshotReadError } from './persistence.ts';
import { decryptEnvelope, encryptEnvelope, fromBase64, type Envelope } from '../crypto/envelope.ts';
import { fromHex, sm3, sm3Hex, toHex, utf8 } from '../crypto/sm3.ts';
import { PatientIndex, type PatientIndexSnapshot } from '../model/identity.ts';

/** 快照的格式标识与版本（改动结构时**必须**升版本，让旧文件被显式拒绝而不是被误解） */
export const WORKSPACE_FORMAT = 'l0-workspace';
export const WORKSPACE_VERSION = 1;

export interface WorkspaceData {
  suggestions: SuggestionBookSnapshot;
  annotations: AnnotationBookSnapshot;
  patients: PatientIndexSnapshot;
}

export interface WorkspaceScope {
  suggestions: SuggestionBook;
  annotations: AnnotationBook;
  patients: PatientIndex;
}

export type WorkspaceLoadResult =
  | { ok: true; scope: WorkspaceScope; meta: SnapshotMeta; firstRun: false }
  /** 首次启动：文件不存在，调用方可以建空工作区 */
  | { ok: true; scope: WorkspaceScope; meta: null; firstRun: true }
  /** 文件在、但读不出来：**必须停下来**，不能当空工作区继续 */
  | { ok: false; code: SnapshotReadError; message: string; firstRun: false };

/**
 * 仅旁挂数据（建议 + 注解）的存取，供"会话自带这两份数据"的场景使用
 * （演示服务就是这样：每份病历一个会话，主索引尚未接）。
 *
 * 用**独立的格式标识**，避免与三件套的 `l0-workspace` 互相误读 ——
 * 两个格式字段不同，读错会立刻报 `E_SNAPSHOT_FORMAT`，而不是"读出一份缺主索引的数据还当成正常"。
 */
export const SIDECAR_FORMAT = 'l0-sidecars';

export type SidecarData = { suggestions: SuggestionBookSnapshot; annotations: AnnotationBookSnapshot };

export type SidecarLoadResult =
  | { ok: true; firstRun: true; data: null }
  /**
   * `saltFingerprint` 是**写这个文件时用的盐指纹**（从信封头部读，不解密即可得）。
   * 未加密路径（`loadSidecars`）没有盐，故为可选。
   * 它存在的原因只有一个：让"还有哪些文件没迁移到新盐"这个问题**能被回答**。
   */
  /**
   * `digest` 是**这一版快照的内容摘要**，调用方要留着它 ——
   * 下次落盘时把它当作基线（`saveSidecarsSealed(..., { expect: { digest } })`），
   * "盘上还是不是我认的那一版"这件事才有依据（见 `persistence.ts` 的落盘前置条件）。
   */
  | { ok: true; firstRun: false; data: SidecarData; saltFingerprint?: string; digest?: string }
  | { ok: false; code: SnapshotReadError; message: string; firstRun: false };

export function saveSidecars(file: string, data: SidecarData, options: { at?: string } = {}): SnapshotMeta {
  return writeSnapshot(file, data, {
    format: SIDECAR_FORMAT,
    version: WORKSPACE_VERSION,
    ...(options.at ? { at: options.at } : {}),
  });
}

export function loadSidecars(file: string): SidecarLoadResult {
  if (!snapshotExists(file)) return { ok: true, firstRun: true, data: null };
  const read = readSnapshot<SidecarData>(file, { format: SIDECAR_FORMAT, version: WORKSPACE_VERSION });
  if (!read.ok) return { ok: false, code: read.code, message: read.message, firstRun: false };
  const data = read.payload;
  if (!data || !data.suggestions || !data.annotations) {
    return { ok: false, code: 'E_SNAPSHOT_CORRUPT', message: '旁挂快照缺少 suggestions / annotations 分区', firstRun: false };
  }
  return { ok: true, firstRun: false, data };
}

/**
 * 密封（加密）的旁挂快照。
 *
 * ## 为什么必须加密，而不是"靠服务器安全"
 *
 * 快照里含 **`nodeId`、`ruleId`、以及数据元相关文本** —— 它足以指回某个患者。
 * 明文落盘意味着：任何能读该目录的人（备份、运维、误拷、卸载残留）都能看到它。
 * "服务器只有自己人能登"不是加密的替代品 —— 那只是把风险从磁盘转移到权限管理上，
 * 而权限管理会出错、会被临时放宽、会被忽略。
 *
 * ## 复用仓库已有的信封，不自造
 *
 * 用 `SM4-CTR + HMAC-SM3`（`src/crypto/envelope.ts`，与文档加密同一套实现）：
 * 同一个仓库里出现两套加密实现，才是真正的风险 —— 总有一套没被审过。
 * `HMAC` 覆盖头部与密文，因此**改动密文会被发现**，而不是解出一段乱码当正常数据用。
 *
 * ## 口令从哪来
 *
 * 由调用方注入（演示用内置口令，生产必须来自密钥管理）。**没有口令就不写** ——
 * 静默退回明文是最坏的选择：它让"已加密"这个判断在某个时刻悄悄变成假的。
 * 解密失败一律报错，绝不当作"文件不存在"（那等于把数据丢失伪装成首次启动）。
 */
export const SEALED_FORMAT = 'l0-sidecars-sealed';

/**
 * 快照加密用的 salt —— **有意稳定**，不是随机。
 *
 * 为什么必须稳定：随机 salt 意味着**每次落盘都要重新派生**（200k 次迭代、约 7.6 秒）。
 * 而落盘是"每次写操作一次"，实测这会把全量自测从 37 秒拖到 **609 秒**。
 * 稳定的 salt 让派生结果可缓存（见 `envelope.ts` 的派生缓存），
 * 于是同一口令在**整个进程生命周期内只派生一次**。
 *
 * **代价必须说清**：salt 在同一口令范围内复用，于是"针对该口令的预计算"只需做一次。
 * 因此这个选择依赖一个前提 —— **口令是密钥管理系统注入的高熵密钥，不是人记的口令**。
 * 若口令是低熵的，应改为每文件随机 salt（并接受每次派生的开销）；
 * 但**不要**为此降低迭代数 —— 那是在双方都不知情的情况下削弱唯一的安全参数。
 *
 * 用域分隔串派生（而不是常量）：换口令即换 salt，且与其它用途（如 `.l0enc` 导出）天然隔离。
 *
 * ## 盐的来源与轮换
 *
 * 优先级：**显式参数（来自服务端文件配置 `stateSalt`）> 按口令派生**。
 * 注入的盐必须是 32 个十六进制字符（16 字节）；**非法即抛错，绝不静默退回派生盐** ——
 * 静默退回会让"我以为我配了独立盐"这个判断悄悄变成假的，而它恰好是唯一被改的那个参数。
 * （原先这一档读环境变量 `L0_STATE_SALT`，现在只由 `core/server-config.ts` 经参数传进来：
 * 盐与它服务的口令同源，两处配置会让"换了一处、漏了另一处"变成一场事故。）
 *
 * **轮换不需要"旧盐登记表"**：盐就写在每个信封的头部（`header.kdf.salt`），
 * 解密用的永远是信封里那一个。于是换盐之后**旧文件照常可读**，也不存在
 * "旧盐得留着"的回滚麻烦 —— 相反，去造一张需要同步的登记表才是风险（它必然漏同步）。
 *
 * 但"换盐"只让**今后写出的**文件用新盐。历史文件要靠 `resealSidecars` 重写迁移，
 * 而"还有哪些没迁移"由 `inspectSealedSidecars` 比对盐指纹来回答 ——
 * **没有这个可观测性，轮换就只是纸面上的**（新文件用新盐、旧文件永远用旧盐，安全目标并未达成）。
 */
function deriveStateSalt(passphrase: string): Uint8Array {
  return sm3(utf8(`l0-sidecar-snapshot-salt-v1:${passphrase}`)).subarray(0, 16);
}

export type SaltSource = 'option' | 'derived';

/**
 * 解析注入的盐：**格式不对就抛错**（见文件头）。
 * 容忍分隔符与大小写，但**绝不猜测长度** —— 长度不对就是配置错了，不是"我帮你补一下"。
 */
function parseSalt(text: string, where: string): Uint8Array {
  const clean = text.replace(/[\s:_-]+/g, '');
  if (!/^[0-9a-fA-F]{32}$/.test(clean)) {
    throw new Error(
      `${where} 的盐必须是 32 个十六进制字符（16 字节），实际 ${clean.length} 个字符；拒绝静默退回派生盐（那会让"已注入独立盐"变成一句假话）`,
    );
  }
  return fromHex(clean);
}

/** 解析本次要用的盐（见文件头"盐的来源与轮换"）：显式参数优先，否则按口令派生 */
export function resolveStateSalt(passphrase: string, explicitHex?: string): { salt: Uint8Array; source: SaltSource } {
  if (explicitHex !== undefined) return { salt: parseSalt(explicitHex, '显式参数'), source: 'option' };
  return { salt: deriveStateSalt(passphrase), source: 'derived' };
}

/**
 * 盐指纹：`SM3(salt)` 的前 8 字节（16 个 hex 字符）。
 *
 * 为什么用指纹而不是盐本身：它能回答"这个文件是不是当前这代盐写的"，
 * 又不必把盐到处抄进日志与报表（盐不是秘密，但没必要扩散）。
 * 8 字节足以区分代次；它不承担任何抗伪造职责，故不需要更长。
 */
export function saltFingerprint(salt: Uint8Array): string {
  return sm3Hex(salt).slice(0, 16);
}

/** 当前配置下应当使用的盐指纹（运维据此判断"还有哪些文件没迁移"） */
export function currentSaltFingerprint(passphrase: string, explicitHex?: string): string {
  return saltFingerprint(resolveStateSalt(passphrase, explicitHex).salt);
}

/**
 * **通用**密封载荷写入：一份任意 JSON 载荷 → 同一个信封格式。
 *
 * 为什么抽出来而不是给阅读授权另写一套：项目里最怕的就是"同一个仓库出现两套加密实现"——
 * 总有一套没被审过。这里复用的正是与文档加密同一套 `SM4-CTR + HMAC-SM3`，
 * 差别只在**载荷形状**由调用方自己检查（形状检查不属于密码学职责）。
 *
 * 复用 `SEALED_FORMAT` 还有个实际好处：`salt:inspect` / `salt:reseal` 会把新载荷
 * **一并纳入盐轮换**，不需要另建一张"哪些文件也要换盐"的清单（那种清单必然漏同步）。
 */
export function saveSealedPayload<T>(
  file: string,
  payload: T,
  passphrase: string,
  options: {
    at?: string;
    /** 显式盐（32 位 hex）；一般不用，轮换靠服务端文件配置里的 `stateSalt` */
    salt?: string;
    /**
     * **测试与复现专用**：显式指定派生迭代数（默认 `DEFAULT_PBKDF2_ITERATIONS = 200_000`，
     * 纯 JS 的 HMAC-SM3 下单次派生约 7.6 秒）。
     *
     * 为什么做成**参数**而不是环境变量：环境变量会被"某个部署脚本顺手带上"，
     * 于是生产强度悄悄降下来而没人察觉（同 `resolveStateSalt` 里"非法注入不静默退回"的理由）。
     * 参数必须由调用方**显式**写出来，测试一眼可见。
     */
    iterations?: number;
    expect?: SnapshotOptions['expect'];
  } = {},
): SnapshotMeta {
  if (!passphrase) throw new Error('拒绝以明文写入密封快照：必须提供口令（生产从密钥管理注入）');
  const { salt } = resolveStateSalt(passphrase, options.salt);
  const envelope = encryptEnvelope(new TextEncoder().encode(JSON.stringify(payload)), {
    passphrase,
    salt,
    ...(options.iterations === undefined ? {} : { iterations: options.iterations }),
  });
  return writeSnapshot(
    file,
    { envelope },
    {
      format: SEALED_FORMAT,
      version: WORKSPACE_VERSION,
      ...(options.at ? { at: options.at } : {}),
      ...(options.expect ? { expect: options.expect } : {}),
    },
  );
}

export type SealedPayloadResult<T> =
  | { ok: true; firstRun: true; data: null }
  /** `digest` = 这一版的内容摘要，作为下次落盘的基线（同上） */
  | { ok: true; firstRun: false; data: T; saltFingerprint?: string; digest: string }
  | { ok: false; code: SnapshotReadError; message: string; firstRun: false };

/**
 * **通用**密封载荷读取：只保证"**能解密**且是合法 JSON"。
 * 分区形状（比如"必须有 suggestions")由各自的调用方检查 —— 那是业务约束，不是信封约束。
 *
 * 解密失败**一律报错**，绝不当作"文件不存在"：那会把"数据丢失"伪装成"首次启动"。
 */
export function loadSealedPayload<T>(file: string, passphrase: string): SealedPayloadResult<T> {
  if (!snapshotExists(file)) return { ok: true, firstRun: true, data: null };
  if (!passphrase) {
    return { ok: false, code: 'E_SNAPSHOT_CORRUPT', message: '缺少口令：无法解密快照（不会退回按明文读取）', firstRun: false };
  }
  const read = readSnapshot<{ envelope: Envelope }>(file, { format: SEALED_FORMAT, version: WORKSPACE_VERSION });
  if (!read.ok) return { ok: false, code: read.code, message: read.message, firstRun: false };
  const envelope = read.payload?.envelope;
  if (!envelope) return { ok: false, code: 'E_SNAPSHOT_CORRUPT', message: '加密封装缺少 envelope 字段', firstRun: false };
  const decrypted = decryptEnvelope(envelope, passphrase);
  if (!decrypted.ok) {
    return {
      ok: false,
      code: 'E_SNAPSHOT_CORRUPT',
      message: `解密失败（${String((decrypted as { code?: string }).code ?? '未知原因')}）：口令错误或文件被改动`,
      firstRun: false,
    };
  }
  let data: T;
  try {
    data = JSON.parse(new TextDecoder().decode(decrypted.plaintext)) as T;
  } catch {
    return { ok: false, code: 'E_SNAPSHOT_CORRUPT', message: '解密后的内容不是合法 JSON', firstRun: false };
  }
  const fingerprint = saltFingerprintOfEnvelope(envelope);
  return { ok: true, firstRun: false, data, digest: read.meta.digest, ...(fingerprint ? { saltFingerprint: fingerprint } : {}) };
}

export function saveSidecarsSealed(
  file: string,
  data: SidecarData,
  passphrase: string,
  options: {
    at?: string;
    /** 显式盐（32 位 hex）；一般不用，轮换靠服务端文件配置里的 `stateSalt` */
    salt?: string;
    /** 测试与复现专用：显式指定派生迭代数（理由见 `saveSealedPayload`） */
    iterations?: number;
    /**
     * 落盘前置条件：把上次读到的 `digest` 传进来，盘上若不是那一版就**拒写**。
     * 这是"两个终端改同一份病历"唯一的拦点（进程内的 `expectedRev` 拦不住跨进程）。
     */
    expect?: SnapshotOptions['expect'];
  } = {},
): SnapshotMeta {
  /* 口令检查留在这里，是为了保住这句**旁挂快照专属**的提示（抽出去的通用版说的是"密封快照"） */
  if (!passphrase) throw new Error('拒绝以明文写入旁挂快照：必须提供口令（生产从密钥管理注入）');
  return saveSealedPayload(file, data, passphrase, options);
}

/** 从信封头部取盐指纹；非口令模式（或结构损坏）返回 null */
function saltFingerprintOfEnvelope(envelope: Envelope | undefined): string | null {
  const kdf = envelope?.header?.kdf;
  if (!kdf || kdf.algorithm !== 'PBKDF2-HMAC-SM3') return null;
  return saltFingerprint(fromBase64(kdf.salt));
}

export type SealedInspectResult =
  | { ok: true; saltFingerprint: string; iterations: number; /** 未给 currentSalt 时为 undefined（"不知道"不能写成 false） */ usesCurrentSalt?: boolean }
  | { ok: false; code: SnapshotReadError | 'E_SEALED_NOT_PASSPHRASE'; message: string };

/**
 * 只读信封头部，**不解密**（因此不需要付出 7.6 秒的派生）。
 *
 * 这是"轮换能不能收尾"的关键：有了它，巡检整个数据目录只是在读 JSON ——
 * 若必须解密才能判断"迁移了没有"，没有人会为看一眼付每次 7.6 秒的代价，
 * 于是迁移率永远没人知道，轮换也就停在"新文件用新盐"。
 */
export function inspectSealedSidecars(file: string, currentSalt?: Uint8Array): SealedInspectResult {
  if (!snapshotExists(file)) return { ok: false, code: 'E_SNAPSHOT_MISSING', message: `快照不存在：${file}` };
  const read = readSnapshot<{ envelope: Envelope }>(file, { format: SEALED_FORMAT, version: WORKSPACE_VERSION });
  if (!read.ok) return { ok: false, code: read.code, message: read.message };
  const kdf = read.payload?.envelope?.header?.kdf;
  if (!kdf || kdf.algorithm !== 'PBKDF2-HMAC-SM3') {
    return { ok: false, code: 'E_SEALED_NOT_PASSPHRASE', message: '该文件不是口令模式的密封快照（不适用盐轮换）' };
  }
  const fingerprint = saltFingerprint(fromBase64(kdf.salt));
  return {
    ok: true,
    saltFingerprint: fingerprint,
    iterations: kdf.iterations,
    ...(currentSalt ? { usesCurrentSalt: fingerprint === saltFingerprint(currentSalt) } : {}),
  };
}

export type ResealResult =
  | { ok: true; changed: boolean; before: string; after: string }
  | { ok: false; code: SnapshotReadError | 'E_SEALED_NOT_PASSPHRASE'; message: string };

/**
 * 用**当前盐**重写一份密封快照（盐轮换的迁移动作）。
 *
 * 四条不许省：
 *   1) **先读通再写**：解密失败（口令不对 / 文件损坏 / 用了别的盐）时**绝不覆盖** ——
 *      用空数据或半份数据盖掉唯一一份快照，比"没迁移"严重得多；
 *   2) 解密用**信封里的盐**（`loadSidecarsSealed` 本来就如此），所以迁移**不需要知道旧盐**，
 *      也就不需要那张"旧盐登记表"；
 *   3) 写是**原子**的（`writeSnapshot`：tmp → fsync → rename），中途崩溃只留下 `.tmp`；
 *   4) 已经用当前盐写过的文件**原样跳过**（`changed: false`）—— 重复迁移只会白白多付一次派生。
 */
export function resealSidecars(
  file: string,
  passphrase: string,
  options: { at?: string; salt?: string } = {},
): ResealResult {
  if (!passphrase) return { ok: false, code: 'E_SNAPSHOT_CORRUPT', message: '缺少口令：拒绝重写（没有口令就没有"读通"可言）' };
  const current = resolveStateSalt(passphrase, options.salt).salt;
  const inspect = inspectSealedSidecars(file, current);
  if (!inspect.ok) return { ok: false, code: inspect.code, message: inspect.message };
  if (inspect.usesCurrentSalt === true) {
    return { ok: true, changed: false, before: inspect.saltFingerprint, after: inspect.saltFingerprint };
  }
  /* 用**通用**读取（不看分区形状）：重写的判据是"能不能解密"，与载荷是哪一种无关 ——
     否则新加的密封载荷（如阅读授权）会在这里被判成"读不通"，轮换就覆盖不到它。 */
  const load = loadSealedPayload<unknown>(file, passphrase);
  if (!load.ok) return { ok: false, code: load.code, message: `重写前无法读通，未做任何改动：${load.message}` };
  if (load.firstRun) return { ok: false, code: 'E_SNAPSHOT_MISSING', message: `快照不存在：${file}` };
  saveSealedPayload(file, load.data, passphrase, { ...(options.at ? { at: options.at } : {}), salt: toHex(current) });
  return { ok: true, changed: true, before: inspect.saltFingerprint, after: saltFingerprint(current) };
}

/**
 * 旁挂快照的读取：在通用实现之上加**形状检查**。
 *
 * 这条形状检查必须留在这一层：它防的是"信封完好、但载荷不是旁挂数据"——
 * 比如把别处的密封载荷当快照读进来。那种情况若放过，表现是"建议与注解全空"，
 * 而界面上看起来只是"还没有数据"。
 */
export function loadSidecarsSealed(file: string, passphrase: string): SidecarLoadResult {
  const loaded = loadSealedPayload<SidecarData>(file, passphrase);
  if (!loaded.ok) return { ok: false, code: loaded.code, message: loaded.message, firstRun: false };
  if (loaded.firstRun) return { ok: true, firstRun: true, data: null };
  const data = loaded.data;
  if (!data || !data.suggestions || !data.annotations) {
    return { ok: false, code: 'E_SNAPSHOT_CORRUPT', message: '旁挂快照缺少 suggestions / annotations 分区', firstRun: false };
  }
  return {
    ok: true,
    firstRun: false,
    data,
    digest: loaded.digest,
    ...(loaded.saltFingerprint ? { saltFingerprint: loaded.saltFingerprint } : {}),
  };
}

export function saveWorkspace(file: string, scope: WorkspaceScope, options: { at?: string } = {}): SnapshotMeta {
  const data: WorkspaceData = {
    suggestions: scope.suggestions.snapshot(),
    annotations: scope.annotations.snapshot(),
    patients: scope.patients.snapshot(),
  };
  return writeSnapshot(file, data, {
    format: WORKSPACE_FORMAT,
    version: WORKSPACE_VERSION,
    ...(options.at ? { at: options.at } : {}),
  });
}

export function loadWorkspace(file: string): WorkspaceLoadResult {
  if (!snapshotExists(file)) {
    /* 首次启动：给一个空工作区。这只在**文件确实不存在**时成立 —— 见下面的分支 */
    return {
      ok: true,
      firstRun: true,
      meta: null,
      scope: { suggestions: new SuggestionBook(), annotations: new AnnotationBook(), patients: new PatientIndex() },
    };
  }
  const read = readSnapshot<WorkspaceData>(file, { format: WORKSPACE_FORMAT, version: WORKSPACE_VERSION });
  if (!read.ok) {
    return { ok: false, code: read.code, message: read.message, firstRun: false };
  }
  const data = read.payload;
  if (!data || !data.suggestions || !data.annotations || !data.patients) {
    return {
      ok: false,
      code: 'E_SNAPSHOT_CORRUPT',
      message: '工作区快照缺少必备分区（suggestions / annotations / patients）',
      firstRun: false,
    };
  }
  try {
    return {
      ok: true,
      firstRun: false,
      meta: read.meta,
      scope: {
        suggestions: SuggestionBook.restore(data.suggestions),
        annotations: AnnotationBook.restore(data.annotations),
        patients: PatientIndex.restore(data.patients),
      },
    };
  } catch (err) {
    /* 分区存在但内部非法：同样**不修补**，直接报错（修补等于替人改数据） */
    return { ok: false, code: 'E_SNAPSHOT_CORRUPT', message: (err as Error).message, firstRun: false };
  }
}
