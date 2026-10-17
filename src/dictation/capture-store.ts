/**
 * 语音采集配置的**存储**（C2）：ASR 服务地址、超时预算、分片参数、音频留存开关。
 *
 * ## 为什么单独存一条，而不是塞进工作区快照
 *
 * 与 `placement-store.ts` / `ai/model-config-store.ts` 完全同一条理由：快照的语义是
 * "**工作区数据**"，而这里是**部署参数**。混在一起，"重置工作区"会把它清掉
 * （现场表现是"重置后采集悄悄不可用了"），"备份工作区"会把一套环境的 ASR 地址
 * 带到另一套环境（那边的地址根本不通）。
 *
 * 落**库**（`sealed_kv` 的 `config.capture` 与 `config.capture.apiKey`）而不是落文件：
 * 备份一次数据库就带走这台机器的全部部署参数。旧文件名 `dictation-capture.json`
 * 只留作一次性导入（见 `storage/config-files-import.ts`）。
 *
 * ## 密钥（若 ASR 需要 token）沿用 `ai-model.key` 的三条纪律
 *
 * | 规则 | 为什么 |
 * |---|---|
 * | **单独一行存、与配置分开** | "改个地址"不该顺手动了密钥那一行 |
 * | **永不回显**：读取只返回 `apiKeyPresent: boolean` | 回显一次就收不回来了（截图、日志、前端内存） |
 * | `undefined` 不改 / `null` 清除 / 字符串 设新值 | 把 `undefined` 当成"清空"，会让管理员只改个地址就把密钥弄丢，而现场表现是"ASR 突然 401" |
 *
 * ## 配置只有一个来源：库
 *
 * 原先这里还有第二档"环境变量引导值"（`L0_CAPTURE_ASR_ENDPOINT` / `L0_CAPTURE_ASR_MODEL_ID`
 * / `L0_CAPTURE_ASR_API_KEY_ENV` / `L0_CAPTURE_RETAIN_AUDIO`）。本轮取消：
 * **需要存储的东西一律入库**。这条在采集上尤其要紧 —— 它决定**音频发往哪台服务器**，
 * 散在环境里就有一处"备份带不走"的答案，而音频的去向恰恰是最该被审计的一件事。
 *
 * **分片与超时参数从来就只给界面这一个入口**（它们"在真实诊所里调出来的"，见设计文档
 * 第九节）：一次配错就是"建议条数忽然翻倍"这种难查的现场；能改的地方只有一个，
 * 排查方向就只有一个。现在**全部参数**都遵守这一条。
 */

import { CONFIG_KEY_PREFIX, type ConfigKv } from '../storage/config-kv.ts';
import {
  ASR_KINDS,
  CaptureError,
  DEFAULT_CAPTURE_CONFIG,
  missingCredentialSlots,
  validateCaptureConfig,
  vendorOf,
  type AsrKind,
  type CaptureConfig,
  type CaptureConfigPatch,
  type SegmentConfig,
} from './capture.ts';

/**
 * 库里的三个键名：配置一条、密钥两条（**各自分开**，免得"改地址"顺手动了密钥那一行）。
 *
 * 两个密钥槽对应 `asr-adapters.ts` 的凭据形态：`apiKey` 是主凭据
 * （院内 token / 百度 AK / 阿里云 NLS token），`apiSecret` 只有百度用得着（SK）。
 * 阿里云的 AppKey 不在这儿 —— 它是门牌号不是凭证，落在配置行里（`asr.appKey`）。
 */
export const CAPTURE_CONFIG_KEY = `${CONFIG_KEY_PREFIX}capture`;
export const CAPTURE_API_KEY_KEY = `${CONFIG_KEY_PREFIX}capture.apiKey`;
export const CAPTURE_API_SECRET_KEY = `${CONFIG_KEY_PREFIX}capture.apiSecret`;
/** 旧位置（`<状态目录>/dictation-capture.json`）：**只用于一次性导入**，不再写 */
export const CAPTURE_CONFIG_FILE = 'dictation-capture.json';

/**
 * 界面上能改的东西（扁平形状：路由直接把 `body` 递进来，少一层映射就少一处漏字段）。
 *
 * `apiKey` 的三种状态见文件头。**没有"密钥变量名"这一格**：界面上配的就是密钥本身，
 * 它随后被加密写进 `config.capture.apiKey`（而不是"去某个环境变量里找"）。
 */
export interface CaptureConfigInput {
  /** 厂商 / 协议（`intranet-task` / `baidu-rest` / `aliyun-nls`）；**不给就是院内服务** */
  kind?: string;
  endpoint?: string;
  appKey?: string;
  acknowledgePublicCloud?: boolean;
  modelId?: string;
  submitTimeoutMs?: number;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  silenceMs?: number;
  maxSeconds?: number;
  minSeconds?: number;
  retainAudio?: boolean;
  confidenceCeiling?: number;
  apiKey?: string | null;
  /** 次凭据（百度 SK）。三态与 `apiKey` 一致：不传 = 不改 / null = 清除 / 字符串 = 设新值 */
  apiSecret?: string | null;
}

interface StoredCaptureConfig {
  /**
   * 1 = 只有院内服务那套字段（`kind` 隐含为 `intranet-task`）；
   * 2 = 加上厂商 / `appKey` / 公有云确认。
   *
   * **读的时候两版都认**（v1 的直接补默认值 = 院内服务），只有写的时候一律写新版 ——
   * 若把 v1 当成"读不出来"，现场表现是"升级一下，采集配置没了"，
   * 而管理员明明配过、备份里也有。升级路径必须比版本号宽容。
   */
  version: 1 | 2;
  kind?: string;
  endpoint: string;
  appKey?: string;
  acknowledgePublicCloud?: boolean;
  modelId: string;
  submitTimeoutMs: number;
  pollIntervalMs: number;
  pollTimeoutMs: number;
  segment: SegmentConfig;
  retainAudio: boolean;
  confidenceCeiling: number;
  /** 是否有密钥被加密落盘（**不存密钥本身**，密钥在 `config.capture.apiKey` 那一行） */
  apiKeyStored: boolean;
  /** 同上，次凭据那一行 */
  apiSecretStored?: boolean;
  updatedAt: string;
  updatedBy: string;
}

export interface LoadedCaptureConfig {
  config: CaptureConfig;
  /** 已解出的主凭据（内存中，供转发时使用）。**不得进入任何返回值、日志或留痕** */
  apiKey?: string;
  /** 已解出的次凭据（百度 SK）。纪律同主凭据 */
  apiSecret?: string;
  /** 这份配置从哪来（`store` = 库里配过；`default` = 从没配过、走未配置默认） */
  source: 'store' | 'default';
  /** 主凭据是否就位（界面只显示这个） */
  apiKeyPresent: boolean;
  /** 次凭据是否就位 */
  apiSecretPresent: boolean;
  /**
   * 采集入口是否可用：**地址、模型标识、以及该厂商要求的凭据都齐了**才为真
   * （差一样就 fail-closed）。凭据也要算进来，因为"配了地址没配凭据"的现场
   * 表现是"点了没反应"或"每次都失败"，两者都不该发生在配好之前。
   */
  configured: boolean;
  updatedAt?: string;
  updatedBy?: string;
}

function readStored(kv: ConfigKv): StoredCaptureConfig | null {
  /* 解不开（口令换过 / 那一行被改过）**不静默当没有**：那会让"我配的采集没了"
     表现成"退回了未配置"，两件事的处置完全不同。裹回本模块的错误码：调用方依赖它。 */
  const parsed = ((): StoredCaptureConfig | null => {
    try {
      return kv.read<StoredCaptureConfig>(CAPTURE_CONFIG_KEY);
    } catch (err) {
      throw new CaptureError('E_CAPTURE_CONFIG_INVALID', `采集配置读不出来，拒绝按"未配置"继续：${(err as Error).message}`);
    }
  })();
  if (parsed === null) return null;
  /* v1 也认（旧库里只有院内服务那套字段）：升级不能表现成"我配的采集没了" */
  if (parsed?.version !== 1 && parsed?.version !== 2) return null;
  return parsed;
}

/** 取某一格密钥。**解不开 → 抛错**（`config-kv` 已保证不把"解不开"混成"没有"） */
function readStoredSecret(kv: ConfigKv, key: string, what: string): string | undefined {
  const value = ((): string | null => {
    try {
      return kv.read<string>(key);
    } catch (err) {
      throw new CaptureError(
        'E_CAPTURE_CONFIG_INVALID',
        `${what}读不出来（口令已更换，或那一行被改动过）：${(err as Error).message}；不会当作"没有密钥"继续`,
      );
    }
  })();
  if (value === null) return undefined;
  if (typeof value !== 'string' || value === '') {
    throw new CaptureError('E_CAPTURE_CONFIG_INVALID', `库里的${what}不会是它该有的样子：${JSON.stringify(value)?.slice(0, 40)}`);
  }
  return value;
}

/** 三态处理一格密钥（`undefined` 不改 / `null` 清除 / 字符串 设新值）：返回它该不该继续落盘 */
function applySecret(kv: ConfigKv, key: string, value: string | null | undefined, what: string): 'set' | 'cleared' | 'unchanged' {
  if (value === null) {
    /* 清除时**真删那一行**（同 `saveModelConfig` 尾部那段教训）：
       只把标记置 false 而留着密文，"我清掉了"这句话就是假的 */
    kv.remove(key);
    return 'cleared';
  }
  if (typeof value === 'string' && value !== '') {
    kv.write(key, value);
    return 'set';
  }
  if (value !== undefined && typeof value !== 'string') {
    throw new CaptureError('E_CAPTURE_CONFIG_INVALID', `${what}必须是字符串、null（清除）或不传（不改）`);
  }
  return 'unchanged';
}

/** 扁平输入 → `validateCaptureConfig` 要的嵌套补丁形状（**校验口径只有一处**：`capture.ts`） */
function toNested(input: CaptureConfigInput): CaptureConfigPatch {
  const asr: NonNullable<CaptureConfigPatch['asr']> = {};
  /* `kind` 的**运行时**校验只有一处：`validateCaptureConfig`（这里只做搬运）。
     把校验散到搬运层，就会出现"两条路径对同一个值的判断不一样"。 */
  if (input.kind !== undefined) asr.kind = input.kind as AsrKind;
  if (input.endpoint !== undefined) asr.endpoint = input.endpoint;
  if (input.appKey !== undefined) asr.appKey = input.appKey;
  if (input.acknowledgePublicCloud !== undefined) asr.acknowledgePublicCloud = input.acknowledgePublicCloud;
  if (input.modelId !== undefined) asr.modelId = input.modelId;
  if (input.submitTimeoutMs !== undefined) asr.submitTimeoutMs = input.submitTimeoutMs;
  if (input.pollIntervalMs !== undefined) asr.pollIntervalMs = input.pollIntervalMs;
  if (input.pollTimeoutMs !== undefined) asr.pollTimeoutMs = input.pollTimeoutMs;
  const segment: Partial<SegmentConfig> = {};
  if (input.silenceMs !== undefined) segment.silenceMs = input.silenceMs;
  if (input.maxSeconds !== undefined) segment.maxSeconds = input.maxSeconds;
  if (input.minSeconds !== undefined) segment.minSeconds = input.minSeconds;
  return {
    asr,
    segment,
    ...(input.retainAudio !== undefined ? { retainAudio: input.retainAudio } : {}),
    ...(input.confidenceCeiling !== undefined ? { confidenceCeiling: input.confidenceCeiling } : {}),
  };
}

/** 读取生效中的配置：**库里有就用库里的，没有就是未配置默认**（不再有环境变量这一档） */
export function loadCaptureConfig(kv: ConfigKv): LoadedCaptureConfig {
  const stored = readStored(kv);
  if (stored) {
    const config = validateCaptureConfig({
      asr: {
        /* v1 的行没有这三项：`undefined` → 校验层补默认（也就是"院内服务"），这正是升级该有的行为 */
        kind: stored.kind as AsrKind | undefined,
        endpoint: stored.endpoint,
        appKey: stored.appKey,
        acknowledgePublicCloud: stored.acknowledgePublicCloud,
        modelId: stored.modelId,
        submitTimeoutMs: stored.submitTimeoutMs,
        pollIntervalMs: stored.pollIntervalMs,
        pollTimeoutMs: stored.pollTimeoutMs,
      },
      segment: stored.segment,
      retainAudio: stored.retainAudio,
      confidenceCeiling: stored.confidenceCeiling,
    });
    /* 只在"配置说这一格就位"时才去读它：避免每次读配置都解一个用不到的信封 */
    const apiKey = stored.apiKeyStored ? readStoredSecret(kv, CAPTURE_API_KEY_KEY, '采集密钥') : undefined;
    const apiSecret = stored.apiSecretStored ? readStoredSecret(kv, CAPTURE_API_SECRET_KEY, '采集次凭据') : undefined;
    const apiKeyPresent = apiKey !== undefined && apiKey !== '';
    const apiSecretPresent = apiSecret !== undefined && apiSecret !== '';
    return {
      config,
      ...(apiKey !== undefined ? { apiKey } : {}),
      ...(apiSecret !== undefined ? { apiSecret } : {}),
      source: 'store',
      apiKeyPresent,
      apiSecretPresent,
      /* 凭据也算进"可用"：配了地址却没配凭据的现场表现是"点了没反应"或"每次都失败"，
         而这两件事都不该发生在"配好之前" */
      configured:
        config.asr.endpoint !== '' &&
        config.asr.modelId !== '' &&
        missingCredentialSlots(vendorOf(config.asr.kind), { apiKey: apiKeyPresent, apiSecret: apiSecretPresent }, config.asr.appKey).length === 0,
      updatedAt: stored.updatedAt,
      updatedBy: stored.updatedBy,
    };
  }
  const config = { ...DEFAULT_CAPTURE_CONFIG, asr: { ...DEFAULT_CAPTURE_CONFIG.asr }, segment: { ...DEFAULT_CAPTURE_CONFIG.segment } };
  return { config, source: 'default', apiKeyPresent: false, apiSecretPresent: false, configured: false };
}

export interface SaveCaptureConfigResult {
  loaded: LoadedCaptureConfig;
  /** 主凭据发生了什么（**只记动作，不记值**） */
  apiKeyAction: 'set' | 'cleared' | 'unchanged';
  /** 次凭据（百度 SK）发生了什么 */
  apiSecretAction: 'set' | 'cleared' | 'unchanged';
}

/**
 * 保存配置并返回**生效后**的配置。
 *
 * 先写非敏感配置、再处理密钥（同 `saveModelConfig`）：若密钥这一步失败，
 * 至少不会出现"密钥已更新但配置还是旧的"这种半截状态。
 *
 * 允许把地址与模型标识都清空 —— 那是"回到未配置"，而**未配置就是采集入口不可用**
 * （fail-closed），不是"退回模拟转写"。
 */
export function saveCaptureConfig(
  kv: ConfigKv,
  rawInput: CaptureConfigInput,
  by: string,
  options: { at?: string } = {},
): SaveCaptureConfigResult {
  const previous = ((): LoadedCaptureConfig | null => {
    try {
      return loadCaptureConfig(kv);
    } catch {
      /* 旧配置读坏了不该阻止修复：管理界面正是用来修它的地方 */
      return null;
    }
  })();

  const nested = toNested(rawInput);
  /* 打补丁的**基底是当前生效的配置**，不是默认值。
     这一点很要紧：`validateCaptureConfig` 会把没给的项填成默认，而默认里 `endpoint` 是空串 ——
     于是"只改一下静音判停"会**顺手把地址清空**，现场表现是"我就是调了个参数，采集没了"。
     与本文件头那条密钥纪律（`undefined` 不是清空）是同一个病根。
     显式给 `endpoint: ''` 仍然是"回到未配置"✓（`toNested` 只搬运**给出过**的字段）。 */
  const base = previous?.config ?? DEFAULT_CAPTURE_CONFIG;
  /* 密钥与配置**分开**校验：密钥不是 `CaptureConfig` 的一部分（它只在内存里过一次） */
  const config = validateCaptureConfig({
    asr: { ...base.asr, ...nested.asr },
    segment: { ...base.segment, ...nested.segment },
    ...(nested.retainAudio === undefined ? { retainAudio: base.retainAudio } : { retainAudio: nested.retainAudio }),
    ...(nested.confidenceCeiling === undefined ? { confidenceCeiling: base.confidenceCeiling } : { confidenceCeiling: nested.confidenceCeiling }),
  });

  const previousStored = previous?.source === 'store' ? readStored(kv) : null;
  let apiKeyStored = previousStored ? Boolean(previousStored.apiKeyStored) : Boolean(previous?.apiKeyPresent);
  let apiSecretStored = previousStored ? Boolean(previousStored.apiSecretStored) : Boolean(previous?.apiSecretPresent);
  const apiKeyAction = applySecret(kv, CAPTURE_API_KEY_KEY, rawInput.apiKey, 'apiKey');
  if (apiKeyAction === 'set') apiKeyStored = true;
  if (apiKeyAction === 'cleared') apiKeyStored = false;
  const apiSecretAction = applySecret(kv, CAPTURE_API_SECRET_KEY, rawInput.apiSecret, 'apiSecret');
  if (apiSecretAction === 'set') apiSecretStored = true;
  if (apiSecretAction === 'cleared') apiSecretStored = false;
  /* 换厂商**不自动清掉另一家的凭据**：那等于"我改了个地址，密钥没了"，
     而现场表现是"换个厂商回来，全部 401"（同 `undefined` 不当清空那条纪律）。
     界面按 `credentialShape` 决定显示哪几格；用不到的那一格留着不影响任何行为。 */

  const stored: StoredCaptureConfig = {
    version: 2,
    kind: config.asr.kind,
    endpoint: config.asr.endpoint,
    appKey: config.asr.appKey,
    acknowledgePublicCloud: config.asr.acknowledgePublicCloud,
    modelId: config.asr.modelId,
    submitTimeoutMs: config.asr.submitTimeoutMs,
    pollIntervalMs: config.asr.pollIntervalMs,
    pollTimeoutMs: config.asr.pollTimeoutMs,
    segment: config.segment,
    retainAudio: config.retainAudio,
    confidenceCeiling: config.confidenceCeiling,
    apiKeyStored,
    apiSecretStored,
    updatedAt: options.at ?? new Date().toISOString(),
    updatedBy: by,
  };
  kv.write(CAPTURE_CONFIG_KEY, stored);

  return { loaded: loadCaptureConfig(kv), apiKeyAction, apiSecretAction };
}

/**
 * 给界面的配置视图。
 *
 * 两条刻意的取舍：
 *   - **密钥永远只报"是否就位"**（同 `describeModelConfig` 的纪律）；
 *   - **`configured` 单独给出**：界面要能一眼看出"采集入口现在是不是可用"，
 *     而"地址填了、模型标识没填"这种半配置状态在只看字段值时会显得像配好了。
 */
export function describeCaptureConfig(loaded: LoadedCaptureConfig): Record<string, unknown> {
  const vendor = vendorOf(loaded.config.asr.kind);
  return {
    /* 厂商与协议：界面**只从这张表渲染**（警告要不要出现、凭据几格、地址预填什么），
       否则"换了协议但界面没跟着变"就是必然的 */
    kind: loaded.config.asr.kind,
    vendorLabel: vendor.label,
    protocol: vendor.protocol,
    timingNote: vendor.timingNote,
    defaultEndpoint: vendor.defaultEndpoint,
    modelIdHint: vendor.modelIdHint,
    credentialShape: vendor.credentials,
    /* 整张厂商表一起下发：界面**只从它渲染**（下拉有几档、警告要不要出现、凭据几格、
       地址预填什么）。于是"加一家厂商"是服务端加一行，前端一行都不用动 ——
       反过来把厂商名单写进 HTML，加一家就得同时改两处，而漏掉的那一处表现是"选项里没有它"。 */
    vendors: ASR_KINDS.map((kind) => {
      const item = vendorOf(kind);
      return {
        kind: item.kind,
        label: item.label,
        leavesIntranet: item.leavesIntranet,
        credentialShape: item.credentials,
        defaultEndpoint: item.defaultEndpoint,
        modelIdHint: item.modelIdHint,
        protocol: item.protocol,
        timingNote: item.timingNote,
      };
    }),
    /* 音频是否出院：界面必须据此红标，审计也必须记下这一笔 */
    leavesIntranet: vendor.leavesIntranet,
    acknowledgePublicCloud: loaded.config.asr.acknowledgePublicCloud,
    appKey: loaded.config.asr.appKey,
    endpoint: loaded.config.asr.endpoint,
    modelId: loaded.config.asr.modelId,
    submitTimeoutMs: loaded.config.asr.submitTimeoutMs,
    pollIntervalMs: loaded.config.asr.pollIntervalMs,
    pollTimeoutMs: loaded.config.asr.pollTimeoutMs,
    segment: loaded.config.segment,
    retainAudio: loaded.config.retainAudio,
    confidenceCeiling: loaded.config.confidenceCeiling,
    keyContentThreshold: 0.9,
    /* 只报"就位没有"：密钥值永不回显 */
    apiKeyPresent: loaded.apiKeyPresent,
    apiSecretPresent: loaded.apiSecretPresent,
    /* 采集入口可用性（地址 + 模型标识 + 该厂商要的凭据都要有）—— 界面据此禁用入口并说明原因 */
    configured: loaded.configured,
    missing: [
      ...(loaded.config.asr.endpoint === '' ? ['服务地址'] : []),
      ...(loaded.config.asr.modelId === '' ? ['模型标识'] : []),
      ...missingCredentialSlots(vendor, { apiKey: loaded.apiKeyPresent, apiSecret: loaded.apiSecretPresent }, loaded.config.asr.appKey),
    ],
    source: loaded.source,
    updatedAt: loaded.updatedAt ?? null,
    updatedBy: loaded.updatedBy ?? null,
  };
}
