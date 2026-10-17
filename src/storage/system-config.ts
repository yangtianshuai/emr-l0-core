/**
 * **系统策略配置的落库层**：鉴权模式、会话寿命、限流阈值、审计锚定节奏，以及锚点签名种子。
 *
 * ## 为什么这些原来在环境变量里、现在必须在库里
 *
 * 它们原先分别是 `L0_AUTH_MODE` / `L0_SESSION_TTL_MINUTES` / `L0_RATE_*` /
 * `L0_AUDIT_ANCHOR_EVERY` / `L0_AUDIT_ANCHOR_SEED`。三条具体的坏处：
 *
 *   ① **备份带不走**：`备份一次数据库` 是本项目的口径，而这五条决定了
 *      "这台机器到底防不防"（`open` 模式下任何能访问端口的人都能写入）与
 *      "审计链的锚点是谁锚的" —— 恰恰是最该跟着数据一起搬走的东西；
 *   ② **改了没人知道**：环境变量的特点是"改名、改值、忘重启"三种错法长得一模一样，
 *      而 `authMode` 配错的现场表现是**一切正常、只是没设防**；
 *   ③ **值会顺着进程漏出去**：`docker inspect`、崩溃转储、`ps e` 都能看到环境变量。
 *      落库之后它和病历数据一起被同一把口令保护（`sealed_kv` 一律密封，理由见 `config-kv.ts`）。
 *
 * ## 两处刻意的设计
 *
 * | 选择 | 为什么 |
 * |---|---|
 * | 锚点种子**单独一行**（`config.system.anchorSeed`） | 与模型/采集密钥同一纪律：改"策略"不该顺手动了密钥那一行；清掉它就真删行 |
 * | 默认值 = 原先环境变量的默认值（逐字） | 库里已锚过的那批锚点是用内置种子签的，换默认值会让旧锚点**验签失败** —— 那不是"更安全"，是"审计链断在更换默认值那天" |
 *
 * ## 三态（与 `config-kv` 一字不差）
 *
 *   - `read()` 返回 `null`：没配过 → 走默认；
 *   - 返回对象：配过，且解得开；
 *   - **抛错**：配过但解不开（口令换过 / 那一行被改过）→ 拒绝按"没配过"继续。
 *     把解不开当没配过，现场表现是"我以为设了 strict，它却退回 open"，
 *     而这正是本模块最不能出的一类错。
 */

import { CONFIG_KEY_PREFIX, type ConfigKv } from './config-kv.ts';

export const SYSTEM_CONFIG_KEY = `${CONFIG_KEY_PREFIX}system`;
/** 锚点签名种子（机密）：单独一行，见文件头 */
export const SYSTEM_ANCHOR_SEED_KEY = `${CONFIG_KEY_PREFIX}system.anchorSeed`;

/** 内置演示种子：与原先 `L0_AUDIT_ANCHOR_SEED` 的默认值逐字一致（改它会让历史锚点验签失败） */
export const DEMO_ANCHOR_SEED = 'l0-admin-audit-anchor-demo';

export type AuthMode = 'open' | 'strict';

export interface RateConfig {
  /** 同一身份的登录尝试（每 5 分钟） */
  loginPerActor: number;
  /** 同一来源的登录尝试（每 5 分钟） */
  loginPerSource: number;
  /** AI 调用（每分钟） */
  aiPerMinute: number;
  /** 导出（每分钟） */
  exportPerMinute: number;
}

export interface SystemConfig {
  /**
   * `open`：医生端写操作不要求会话（身份取病历创建人）—— **只在服务只监听回环地址时可接受**；
   * `strict`：写操作要求会话并按角色判定。生产必须 `strict`。
   */
  authMode: AuthMode;
  /** 会话寿命（分钟）：默认 8 小时，覆盖一个班次 */
  sessionTtlMinutes: number;
  rate: RateConfig;
  /** 审计链头每多少条记录锚一次（默认 1 = 每条都锚） */
  anchorEvery: number;
}

export const DEFAULT_SYSTEM_CONFIG: SystemConfig = {
  authMode: 'open',
  sessionTtlMinutes: 480,
  rate: { loginPerActor: 5, loginPerSource: 20, aiPerMinute: 120, exportPerMinute: 30 },
  anchorEvery: 1,
};

export type SystemConfigErrorCode = 'E_SYSTEM_CONFIG_INVALID';

export class SystemConfigError extends Error {
  code: SystemConfigErrorCode;

  constructor(code: SystemConfigErrorCode, message: string) {
    super(message);
    this.name = 'SystemConfigError';
    this.code = code;
  }
}

interface StoredSystemConfig extends SystemConfig {
  version: 1;
  /** 是否有自定义种子被加密落盘（**不存种子本身**，种子在 `config.system.anchorSeed`） */
  anchorSeedStored: boolean;
  updatedAt: string;
  updatedBy: string;
}

export interface LoadedSystemConfig {
  config: SystemConfig;
  /** 已解出的锚点种子（内存中）。**不得进入任何返回值、日志或留痕** */
  anchorSeed: string;
  source: 'store' | 'default';
  /** 种子是否被显式配过（界面只显示这个，不显示值） */
  anchorSeedConfigured: boolean;
  updatedAt?: string;
  updatedBy?: string;
}

function readStored(kv: ConfigKv): StoredSystemConfig | null {
  const parsed = ((): StoredSystemConfig | null => {
    try {
      return kv.read<StoredSystemConfig>(SYSTEM_CONFIG_KEY);
    } catch (err) {
      throw new SystemConfigError(
        'E_SYSTEM_CONFIG_INVALID',
        `系统策略配置读不出来，拒绝按"没配过"继续（那会让 strict 悄悄退回 open）：${(err as Error).message}`,
      );
    }
  })();
  if (parsed === null) return null;
  if (parsed?.version !== 1) return null;
  return parsed;
}

function readStoredSeed(kv: ConfigKv): string | undefined {
  const value = ((): string | null => {
    try {
      return kv.read<string>(SYSTEM_ANCHOR_SEED_KEY);
    } catch (err) {
      throw new SystemConfigError(
        'E_SYSTEM_CONFIG_INVALID',
        `锚点签名种子读不出来（口令已更换，或那一行被改动过）：${(err as Error).message}；不会当作"用默认种子"继续 —— 那会让审计链的签名对不上而没人知道为什么`,
      );
    }
  })();
  if (value === null) return undefined;
  if (typeof value !== 'string' || value === '') {
    throw new SystemConfigError('E_SYSTEM_CONFIG_INVALID', `库里的锚点种子不会是它该有的样子：${JSON.stringify(value)?.slice(0, 40)}`);
  }
  return value;
}

/** 正整数校验：**非法即报错，不静默取默认**（静默取默认会让"我配了"变成假话） */
function positiveInt(raw: unknown, fallback: number, name: string): number {
  if (raw === undefined || raw === null) return fallback;
  const value = typeof raw === 'string' ? Number(raw) : raw;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new SystemConfigError('E_SYSTEM_CONFIG_INVALID', `${name} 必须是正整数，实际 ${JSON.stringify(raw)}（拒绝静默取默认值）`);
  }
  return value;
}

/** 校验界面/接口提交的策略（口径只有这一处：读写两条路径共用） */
export function validateSystemConfigInput(input: Partial<SystemConfig> & { anchorSeed?: string | null }): SystemConfig {
  const authMode = input.authMode ?? DEFAULT_SYSTEM_CONFIG.authMode;
  if (authMode !== 'open' && authMode !== 'strict') {
    throw new SystemConfigError('E_SYSTEM_CONFIG_INVALID', `authMode 只能是 open 或 strict，实际 ${JSON.stringify(input.authMode)}`);
  }
  const rate: Partial<RateConfig> = input.rate ?? {};
  return {
    authMode,
    sessionTtlMinutes: positiveInt(input.sessionTtlMinutes, DEFAULT_SYSTEM_CONFIG.sessionTtlMinutes, 'sessionTtlMinutes'),
    rate: {
      loginPerActor: positiveInt(rate.loginPerActor, DEFAULT_SYSTEM_CONFIG.rate.loginPerActor, 'rate.loginPerActor'),
      loginPerSource: positiveInt(rate.loginPerSource, DEFAULT_SYSTEM_CONFIG.rate.loginPerSource, 'rate.loginPerSource'),
      aiPerMinute: positiveInt(rate.aiPerMinute, DEFAULT_SYSTEM_CONFIG.rate.aiPerMinute, 'rate.aiPerMinute'),
      exportPerMinute: positiveInt(rate.exportPerMinute, DEFAULT_SYSTEM_CONFIG.rate.exportPerMinute, 'rate.exportPerMinute'),
    },
    anchorEvery: positiveInt(input.anchorEvery, DEFAULT_SYSTEM_CONFIG.anchorEvery, 'anchorEvery'),
  };
}

/** 读取生效中的策略：**库里有就用库里的，没有就用默认**（不再有环境变量这一档） */
export function loadSystemConfig(kv: ConfigKv): LoadedSystemConfig {
  const stored = readStored(kv);
  if (stored) {
    const config = validateSystemConfigInput({
      authMode: stored.authMode,
      sessionTtlMinutes: stored.sessionTtlMinutes,
      rate: stored.rate,
      anchorEvery: stored.anchorEvery,
    });
    const seed = stored.anchorSeedStored ? readStoredSeed(kv) : undefined;
    return {
      config,
      anchorSeed: seed ?? DEMO_ANCHOR_SEED,
      source: 'store',
      anchorSeedConfigured: seed !== undefined,
      updatedAt: stored.updatedAt,
      updatedBy: stored.updatedBy,
    };
  }
  return { config: { ...DEFAULT_SYSTEM_CONFIG, rate: { ...DEFAULT_SYSTEM_CONFIG.rate } }, anchorSeed: DEMO_ANCHOR_SEED, source: 'default', anchorSeedConfigured: false };
}

export interface SaveSystemConfigResult {
  loaded: LoadedSystemConfig;
  /** 种子发生了什么（**只记动作，不记值**） */
  anchorSeedAction: 'set' | 'cleared' | 'unchanged';
}

/**
 * 保存策略并返回**生效后**的配置。
 *
 * 顺序与 `saveModelConfig` 一致：先写非敏感配置，再动种子那一行 ——
 * 若种子那一步失败，至少不会出现"种子换了但策略还是旧的"这种半截状态。
 */
export function saveSystemConfig(
  kv: ConfigKv,
  rawInput: Partial<SystemConfig> & { anchorSeed?: string | null },
  by: string,
  options: { at?: string } = {},
): SaveSystemConfigResult {
  const config = validateSystemConfigInput(rawInput);
  const previous = ((): LoadedSystemConfig | null => {
    try {
      return loadSystemConfig(kv);
    } catch {
      /* 旧配置读坏了不该阻止修复：配置界面正是用来修它的地方 */
      return null;
    }
  })();

  let anchorSeedStored = previous?.source === 'store' ? Boolean(readStored(kv)?.anchorSeedStored) : Boolean(previous?.anchorSeedConfigured);
  let anchorSeedAction: SaveSystemConfigResult['anchorSeedAction'] = 'unchanged';
  if (rawInput.anchorSeed === null) {
    anchorSeedStored = false;
    anchorSeedAction = 'cleared';
  } else if (typeof rawInput.anchorSeed === 'string' && rawInput.anchorSeed !== '') {
    kv.write(SYSTEM_ANCHOR_SEED_KEY, rawInput.anchorSeed);
    anchorSeedStored = true;
    anchorSeedAction = 'set';
  } else if (rawInput.anchorSeed !== undefined && typeof rawInput.anchorSeed !== 'string') {
    throw new SystemConfigError('E_SYSTEM_CONFIG_INVALID', 'anchorSeed 必须是字符串、null（清除回内置）、或不传（不改）');
  }

  const stored: StoredSystemConfig = {
    version: 1,
    ...config,
    anchorSeedStored,
    updatedAt: options.at ?? new Date().toISOString(),
    updatedBy: by,
  };
  kv.write(SYSTEM_CONFIG_KEY, stored);
  /* 清除**要真删那一行**：留着密文而报"已清除"，等于"我清掉了"这句话是假的（同 `saveModelConfig`） */
  if (anchorSeedAction === 'cleared') kv.remove(SYSTEM_ANCHOR_SEED_KEY);

  return { loaded: loadSystemConfig(kv), anchorSeedAction };
}

/** 给界面的策略视图：**种子只报"有没有自定义"**，值永不回显 */
export function describeSystemConfig(loaded: LoadedSystemConfig): Record<string, unknown> {
  return {
    authMode: loaded.config.authMode,
    sessionTtlMinutes: loaded.config.sessionTtlMinutes,
    rate: loaded.config.rate,
    anchorEvery: loaded.config.anchorEvery,
    anchorSeedConfigured: loaded.anchorSeedConfigured,
    /* 这一条必须显示：open 模式下医生端写操作不校验会话，界面上不能只写"演示模式"四个字 */
    writesRequireSession: loaded.config.authMode === 'strict',
    source: loaded.source,
    updatedAt: loaded.updatedAt ?? null,
    updatedBy: loaded.updatedBy ?? null,
  };
}
