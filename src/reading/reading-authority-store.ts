/**
 * 授权源配置的**存储**（供界面集中配置）。
 *
 * ## 为什么不塞进工作区快照
 *
 * 同 `ai/model-config-store.ts` 与 `sign/sign-config-store.ts`：它是**部署参数**，不是工作区数据。
 * 混进快照，"重置工作区"会把授权源配置一起清掉（现场表现是"重置之后授权悄悄退回演示替身"，
 * 没人会想到是重置干的），"备份工作区"会把一套环境的平台公钥带到另一套环境。
 * 单独存一条（`sealed_kv` 里的 `config.reading-authority`）—— 落库而不是落文件：
 * 备份一次数据库就带走它，也不会再出现"病历在、授权源不在"。
 *
 * ## 为什么没有"环境变量引导"档
 *
 * 同签名后端：这里的字段是**公钥材料**（SPKI base64，几百字符），环境变量既表达不了、
 * 又容易被截断或转义出错。只有**界面配置 > 默认**；部署要预置就走 `/api/reading-authority`，
 * 或者把一份旧的 `reading-authority.json` 放进状态目录、让**一次性导入**搬进库。
 *
 * ## 读坏了**不静默**
 *
 * 读坏时抛错而不是当"没配过"：那会让"我配的授权源没了"表现成"退回了演示替身"，
 * 而"以为在对接院内平台、其实谁都能自签"正是最危险的一种现场。
 */

import { CONFIG_KEY_PREFIX, type ConfigKv } from '../storage/config-kv.ts';
import {
  DEFAULT_READING_AUTHORITY,
  ReadingAuthorityError,
  isAuthorityConfigured,
  trustedIssuerFingerprints,
  validateReadingAuthority,
  type ReadingAuthorityConfig,
  type ReadingAuthorityInput,
} from './reading-authority.ts';

/** 库里的键名（落 `sealed_kv`） */
export const READING_AUTHORITY_KEY = `${CONFIG_KEY_PREFIX}reading-authority`;
/** 旧位置（`<状态目录>/reading-authority.json`）：**只用于一次性导入**，不再写 */
export const READING_AUTHORITY_FILE = 'reading-authority.json';

interface StoredReadingAuthority extends ReadingAuthorityConfig {
  version: 1;
  updatedAt: string;
  updatedBy: string;
}

export interface LoadedReadingAuthorityConfig {
  config: ReadingAuthorityConfig;
  /** 这份配置从哪来 —— 界面必须显示它，否则"我改了却没生效"无从判断 */
  source: 'store' | 'default';
  updatedAt?: string;
  updatedBy?: string;
}

function readStored(kv: ConfigKv): StoredReadingAuthority | null {
  const parsed = ((): StoredReadingAuthority | null => {
    try {
      return kv.read<StoredReadingAuthority>(READING_AUTHORITY_KEY);
    } catch (err) {
      /* 裹回本模块的错误码：否则"读坏了"会以另一个错误类型漏出去，
         而调用方（与用例）依赖的是"读坏了不许当作没配过"这条契约。 */
      throw new ReadingAuthorityError(
        'E_READING_AUTHORITY_INVALID',
        `授权源配置读不出来，拒绝按"未配置"继续（否则会静默退回演示替身）：${(err as Error).message}`,
      );
    }
  })();
  if (parsed === null) return null;
  if (parsed?.version !== 1) return null;
  return parsed;
}

export function loadReadingAuthority(kv: ConfigKv): LoadedReadingAuthorityConfig {
  const stored = readStored(kv);
  if (stored) {
    const { version: _version, updatedAt, updatedBy, ...rest } = stored;
    void _version;
    return { config: validateReadingAuthority(rest), source: 'store', updatedAt, updatedBy };
  }
  return { config: { ...DEFAULT_READING_AUTHORITY }, source: 'default' };
}

export interface SaveReadingAuthorityResult {
  loaded: LoadedReadingAuthorityConfig;
}

export function saveReadingAuthority(
  kv: ConfigKv,
  rawInput: ReadingAuthorityInput,
  by: string,
  options: { at?: string } = {},
): SaveReadingAuthorityResult {
  const config = validateReadingAuthority(rawInput);
  const stored: StoredReadingAuthority = {
    ...config,
    version: 1,
    updatedAt: options.at ?? new Date().toISOString(),
    updatedBy: by,
  };
  kv.write(READING_AUTHORITY_KEY, stored);
  return { loaded: loadReadingAuthority(kv) };
}

/**
 * 给界面的配置视图。
 *
 * **公钥不回显全文**（同 `sign/sign-config-store.ts`）：只报"是否已配"与**它的指纹**。
 * 另外必须给出**当前实际生效的信任集**（`trustedFingerprints`）—— 否则
 * "我改了信任的钥匙却没生效"无从判断。`localIssuanceAllowed` 供界面决定
 * 要不要显示"演示替身签发"入口：external 下界面不该摆出一个按下去必然失败的按钮。
 */
export function describeReadingAuthority(loaded: LoadedReadingAuthorityConfig): Record<string, unknown> {
  const config = loaded.config;
  const trust = trustedIssuerFingerprints(config);
  return {
    endpoint: config.endpoint ?? null,
    trustedIssuerFingerprint: config.trustedIssuerFingerprint ?? null,
    trustedIssuerPublicKeyPresent: Boolean(config.trustedIssuerPublicKeyBase64),
    /** 生效中的信任集（就是配置的那把平台公钥；未配置时为空） */
    trustedFingerprints: trust.fingerprints,
    /**
     * 是否已配置信任根。未配置时受控阅读**拒绝一切凭据**（fail-closed）——
     * 界面上要能区分"未配置"与"配了但不匹配"：两者的排查方向完全不同，
     * 不能都表现为一句"读不了"。
     */
    configured: isAuthorityConfigured(config),
    source: loaded.source,
    updatedAt: loaded.updatedAt ?? null,
    updatedBy: loaded.updatedBy ?? null,
  };
}
