/**
 * 受控阅读的**授权源**：信任谁签发的阅读授权。
 *
 * ## 本系统**不签发**授权
 *
 * 授权回答的是"谁能读这份病历"—— 那是一个**对外授权**动作，不是文书写作的一部分。
 * 让写病历的医生顺手签发，等于让"写的人同时决定给谁看"：既没有职责分离，
 * 也把"授权范围"这种安全策略交到了单个临床用户手里。
 *
 * 所以本模块只有一个职责：**信任院内授权平台签发的凭据**。本系统**不持有签发私钥**，
 * 于是"能否自己签发"不取决于有没有校验，而是**它物理上没有那把私钥**
 * （同纪律先例：`src/sign/sign-config.ts` 私钥在密码设备；`src/core/recipient-keys.ts` 只存公钥）。
 *
 * ⚠️ 这里**没有"演示替身"档**。内置签发者只存在于测试与演示**工具**里，不构成产品路径 ——
 * 一个"本系统也能签发"的开关，迟早会被当成生产可选项打开。签发凭据这件事，
 * 在本系统里**没有任何入口**。
 *
 * ## 配置形态：信任谁（+ 平台在哪）
 *
 * | 字段 | 含义 |
 * |---|---|
 * | `trustedIssuerPublicKeyBase64` / `trustedIssuerFingerprint` | **信任根**：授权书的签发者必须是它（粘贴公钥即自动派生指纹） |
 * | `endpoint` | 授权平台地址。⚠️ **申请签发 / 同步授权的协议尚未实现**（需要真实平台的协议文档），当前凭据经**导入**进入本系统 |
 *
 * 关于 `endpoint`：与"外部落位服务""内涵类质控引擎"同一处置 ——
 * **没实现就标未接入**，不摆一个"填了也不生效"的地址（那种开关只会让人以为已经接上了）。
 *
 * ## ⚠️ 一个必须先说清的事实：内核**没有**信任根
 *
 * `openForReading()` 只做"凭据自洽"校验（签名与凭据**内嵌的公钥**匹配）——
 * 任何一把自生成的 SM2 密钥都能签出一份**自洽**的授权书。它那句
 * "（已被篡改或不是本签发者签发）"里的后半句，内核其实**判断不了**：内核不知道谁被信任。
 *
 * "谁被信任"是**部署决定**，属于应用层。所以本模块的 `checkIssuerTrust()` 是
 * 凭据进入本系统的**唯一入口校验**：指纹不在信任集里一律拒（`E_UNTRUSTED_ISSUER`）。
 * 少了这一层，"外部凭据导入"就等于"谁都能自签一份永久不限次的授权"。
 *
 * ## 未配置 = 拒绝一切（fail-closed）
 *
 * 没配信任根时 `checkIssuerTrust()` 拒绝**任何**凭据，而不是"先放行看看"。
 * 宁可受控阅读暂时不可用（界面会明说"尚未配置授权平台"），也不让一份来源不明的授权生效。
 *
 * ## 与内核的边界
 *
 * 本模块**单向依赖**内核（只读类型与指纹函数），内核不认识它 —— 同 `src/ai/adapter.ts`、
 * `src/dictation/placement.ts` 的纪律。签发原语 `issueReadingGrant` 仍在内核里：
 * 它是**为授权平台准备的**（也供测试与演示工具构造凭据），本系统自己不用它签发。
 */

import { publicKeyFingerprint, publicKeyFromSpki } from '../crypto/sm2.ts';
import { fromBase64 } from '../crypto/signature.ts';
import type { ReadingCredential } from '../core/controlled-reading.ts';

/**
 * 授权源配置。
 *
 * 刻意**没有**"默认有效期 / 默认次数"这类字段：那些是**签发策略**，
 * 属于授权平台的职责。本系统配置它们，等于又把"授权范围"收回到自己手里 ——
 * 那正是要移出去的东西。这里只配两件事：**信任谁**、**平台在哪**。
 */
export interface ReadingAuthorityConfig {
  /**
   * 授权平台地址（如 `https://authz.hospital.local/api/reading`）。
   *
   * ⚠️ **当前仅登记**：申请签发 / 同步授权的协议未实现，凭据经导入进入本系统。
   * 界面必须如实标注"待接入"，否则填了地址却不生效，比没有这一栏更糟。
   */
  endpoint?: string;
  /**
   * 被信任的签发者**公钥指纹**（SM3(SPKI)，64 位小写十六进制）。
   * 若同时给了 `trustedIssuerPublicKeyBase64`，本字段可省略（自动派生）。
   */
  trustedIssuerFingerprint?: string;
  /**
   * 被信任的签发者公钥（SPKI base64）。
   *
   * 用途是**可读与可核对**：管理员从平台拿到的是公钥，粘贴即可，指纹自动算 ——
   * 比手抄 64 位 hex 少一处出错机会。
   * 注意验签用的是**凭据自带的公钥**，所以信任判定最终仍落在指纹比对。
   */
  trustedIssuerPublicKeyBase64?: string;
}

/** 默认 = 什么都没有（未配置状态）。受控阅读在此状态下**拒绝一切凭据** */
export const DEFAULT_READING_AUTHORITY: ReadingAuthorityConfig = {};

export type ReadingAuthorityErrorCode =
  | 'E_READING_AUTHORITY_INVALID'
  | 'E_READING_AUTHORITY_BAD_FINGERPRINT'
  | 'E_READING_AUTHORITY_KEY_MISMATCH';

export class ReadingAuthorityError extends Error {
  code: ReadingAuthorityErrorCode;

  constructor(code: ReadingAuthorityErrorCode, message: string) {
    super(message);
    this.name = 'ReadingAuthorityError';
    this.code = code;
  }
}

export interface ReadingAuthorityInput {
  endpoint?: string;
  trustedIssuerFingerprint?: string;
  trustedIssuerPublicKeyBase64?: string;
}

/** SM3 指纹的形态（64 位小写十六进制） */
export function isFingerprint(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

function optionalText(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ReadingAuthorityError('E_READING_AUTHORITY_INVALID', `${name} 必须是非空字符串，实际 ${JSON.stringify(value)}`);
  }
  return value.trim();
}

/**
 * 校验并归一化授权源配置。
 *
 * 允许**空配置**（= 未配置状态：受控阅读拒绝一切凭据）。这不矛盾 ——
 * "允许没配"与"配了就必须自洽"是两件事，后者才是这里的重点。
 */
export function validateReadingAuthority(input: ReadingAuthorityInput): ReadingAuthorityConfig {
  const config: ReadingAuthorityConfig = {};

  const endpoint = optionalText(input.endpoint, 'endpoint');
  if (endpoint) config.endpoint = endpoint;

  const keyText = optionalText(input.trustedIssuerPublicKeyBase64, 'trustedIssuerPublicKeyBase64') ?? '';
  let derived: string | undefined;
  if (keyText !== '') {
    /* 立刻试解析：配一把解不开的钥匙要在**保存时**报错，而不是等导入第一份凭据时 */
    try {
      derived = publicKeyFingerprint(publicKeyFromSpki(fromBase64(keyText)));
    } catch (err) {
      throw new ReadingAuthorityError(
        'E_READING_AUTHORITY_INVALID',
        `trustedIssuerPublicKeyBase64 不是合法的 SM2 公钥（SPKI base64）：${(err as Error).message}`,
      );
    }
    config.trustedIssuerPublicKeyBase64 = keyText;
  }

  const claimed = (optionalText(input.trustedIssuerFingerprint, 'trustedIssuerFingerprint') ?? '').toLowerCase();
  if (claimed !== '') {
    if (!isFingerprint(claimed)) {
      throw new ReadingAuthorityError(
        'E_READING_AUTHORITY_BAD_FINGERPRINT',
        `trustedIssuerFingerprint 必须是 64 位十六进制（SM3 指纹），实际 ${JSON.stringify(input.trustedIssuerFingerprint)}`,
      );
    }
    /* 指纹与公钥都在时必须自洽：手抄指纹抄错、或公钥与指纹不是一对，都要在保存时报错，
       否则"信任的是哪把钥匙"会变成两句互相矛盾的话 */
    if (derived && derived !== claimed) {
      throw new ReadingAuthorityError(
        'E_READING_AUTHORITY_KEY_MISMATCH',
        `trustedIssuerFingerprint(${claimed}) 与 trustedIssuerPublicKeyBase64 的实际指纹(${derived}) 不一致：拒绝保存`,
      );
    }
    config.trustedIssuerFingerprint = claimed;
  } else if (derived) {
    config.trustedIssuerFingerprint = derived;
  }

  return config;
}

/* ---------------------------- 运行时：信任判定 ---------------------------- */

/** 拒绝码：与"配置错误码"分开 —— 一个是"配错了"，一个是"这份凭据不被信任" */
export type ReadingAuthorityDenyCode = 'E_UNTRUSTED_ISSUER';

export interface AuthorityDecision {
  ok: boolean;
  code?: ReadingAuthorityDenyCode;
  reason?: string;
}

/** 是否已配置信任根（界面据此区分"未配置"与"配了但不匹配"——两者排查方向完全不同） */
export function isAuthorityConfigured(config: ReadingAuthorityConfig): boolean {
  return typeof config.trustedIssuerFingerprint === 'string' && config.trustedIssuerFingerprint !== '';
}

/**
 * 当前信任集：**信任的是哪把公钥**。
 *
 * 没有"演示替身"这一支 —— 信任集只可能来自部署配置。未配置时返回空集，
 * 于是 `checkIssuerTrust()` 会拒绝一切（fail-closed）。
 */
export function trustedIssuerFingerprints(config: ReadingAuthorityConfig): { fingerprints: string[] } {
  return { fingerprints: isAuthorityConfigured(config) ? [config.trustedIssuerFingerprint as string] : [] };
}

/**
 * 这份凭据的签发者在不在信任集里。
 *
 * **这是凭据进入本系统的唯一入口校验**：登记时（导入）与阅读时都要过。
 * 阅读时再判一次是必要的 —— 否则"把信任的授权源改掉"之后，索引里的旧凭据依然能读。
 */
export function checkIssuerTrust(credential: ReadingCredential, config: ReadingAuthorityConfig): AuthorityDecision {
  const { fingerprints } = trustedIssuerFingerprints(config);
  if (fingerprints.length === 0) {
    return {
      ok: false,
      code: 'E_UNTRUSTED_ISSUER',
      reason: '尚未配置授权平台（信任的签发者公钥）：拒绝任何凭据 —— 宁可受控阅读不可用，也不放行来源不明的授权',
    };
  }
  const actual = credential.publicKeyFingerprint;
  if (!fingerprints.includes(actual)) {
    return {
      ok: false,
      code: 'E_UNTRUSTED_ISSUER',
      reason: `该凭据由 ${actual} 签发，不是当前信任的授权平台（${fingerprints.join('、')}）`,
    };
  }
  return { ok: true };
}

/* ---------------------------- 外部凭据的导入 ---------------------------- */

export type CredentialParseErrorCode = 'E_CREDENTIAL_MALFORMED';

export type ParsedCredential =
  | { ok: true; credential: ReadingCredential }
  | { ok: false; code: CredentialParseErrorCode; reason: string };

function requiredString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/**
 * 解析**授权平台签发的**授权书 JSON。
 *
 * 结构校验必须**先做**：`verifyCredential()` 会直接对 `grant` 做规范化，
 * 缺字段时抛的是 `undefined.grantId` 这类内部错误 —— 那会被当成"系统坏了"，
 * 而实际情况是"粘错了内容"。
 *
 * 注意这里**只做形状校验**，不做信任判定：形状对但签发者不可信，由
 * `checkIssuerTrust()` 拒（两个原因要能分辨，否则排查会串）。
 */
export function parseCredential(text: string): ParsedCredential {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { ok: false, code: 'E_CREDENTIAL_MALFORMED', reason: `不是合法 JSON：${(err as Error).message}` };
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, code: 'E_CREDENTIAL_MALFORMED', reason: '授权凭据必须是一个 JSON 对象' };
  }
  const source = raw as Record<string, unknown>;
  const grantRaw = source.grant;
  if (grantRaw === null || typeof grantRaw !== 'object' || Array.isArray(grantRaw)) {
    return { ok: false, code: 'E_CREDENTIAL_MALFORMED', reason: '缺少 grant（授权书本体）' };
  }
  const grant = grantRaw as Record<string, unknown>;

  for (const key of ['grantId', 'docId', 'documentFingerprint', 'notBefore', 'notAfter', 'issuedBy', 'issuedAt', 'purpose'] as const) {
    if (!requiredString(grant, key)) {
      return { ok: false, code: 'E_CREDENTIAL_MALFORMED', reason: `授权书缺字段或字段为空：grant.${key}` };
    }
  }
  for (const key of ['allowedSections', 'allowedEnvironments'] as const) {
    if (!Array.isArray(grant[key])) {
      return { ok: false, code: 'E_CREDENTIAL_MALFORMED', reason: `授权书的 ${key} 必须是数组` };
    }
  }
  if (!(grant.maxReads === null || (typeof grant.maxReads === 'number' && Number.isFinite(grant.maxReads)))) {
    return { ok: false, code: 'E_CREDENTIAL_MALFORMED', reason: '授权书的 maxReads 必须是数字或 null（不限次）' };
  }

  for (const key of ['publicKeyBase64', 'publicKeyFingerprint', 'signatureValue', 'signedInfoDigest'] as const) {
    if (!requiredString(source, key)) {
      return { ok: false, code: 'E_CREDENTIAL_MALFORMED', reason: `凭据缺字段或字段为空：${key}` };
    }
  }
  if (!Array.isArray(source.references) || source.references.length === 0) {
    return { ok: false, code: 'E_CREDENTIAL_MALFORMED', reason: '凭据的 references 必须是非空数组（授权书靠它参与验签）' };
  }

  return { ok: true, credential: raw as ReadingCredential };
}
