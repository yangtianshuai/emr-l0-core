/**
 * 模型接入配置的**存储**（供界面集中配置，取代"只能改环境变量"）。
 *
 * ## 为什么不塞进工作区快照
 *
 * 快照的语义是"**工作区数据**"（建议 / 注解 / 患者主索引）。模型配置是**部署参数**：
 * 两者混在一起，"重置工作区"会把模型配置一起清掉，而"备份工作区"会把别人的
 * 模型地址带到另一套环境里。所以单独存两条（`sealed_kv` 里的 `config.ai-model`
 * 与 `config.ai-model.apiKey`）。
 *
 * 落**库**而不是落文件：备份一次数据库就带走模型接入（原先"病历在、模型配置不在"）；
 * 而且那份 `.key` 密文原先躺在被审查的工作树里，让发布前排查每次都红 —— 那是真警报。
 *
 * ## 密钥是这里唯一真正难的部分
 *
 * | 规则 | 为什么 |
 * |---|---|
 * | **单独存、加密**（密封交给 `storage/config-kv.ts`，它建在仓库唯一的密封实现上） | 不另造一套加密实现（同一仓库两套实现，总有一套没被审过）。与快照同一口令，复用同一套救回路径 |
 * | **永不回显**：读取只返回 `apiKeyPresent: boolean` | 这是**唯一**能防住密钥顺着截图、日志、前端内存流出去的办法。界面只能"设置新值"或"清除" |
 * | **审计不记值**：只记"密钥已更新" | 审计日志会被导出、会被贴进工单 |
 * | **清除 = 真删那一行** | 把内容置空而留着密文，等于"我清掉了"这句话是假的（见 `saveModelConfig` 尾部那段教训） |
 *
 * ## 三种状态的语义必须分清（最容易出错的地方）
 *
 * | 传入 `apiKey` | 含义 |
 * |---|---|
 * | `undefined` | **不改**（界面没动这个字段 —— 表单里它是空的，而"空"不等于"清空"） |
 * | `null` | **清除**（显式点了"清除密钥"） |
 * | `''` 以外的字符串 | **设置为新值** |
 *
 * 把 `undefined` 当成"清空"，会让管理员只改个地址就把密钥弄丢，
 * 而现场表现是"模型突然 401"，没人会想到是"改地址顺手清了密钥"。
 *
 * ## 配置只有一个来源：库
 *
 * 原先这里还有第二档"环境变量引导值"（`L0_AI_FORMAT` / `L0_AI_ENDPOINT` / `L0_AI_MODEL` 等）。
 * 本轮取消：**需要存储的东西一律入库**。于是下面两种现场都不再存在 ——
 *   - "我改了界面却没生效，原来是环境变量把它压住了"（两处配置，谁都可能压住谁）；
 *   - "备份带走了病历，却带不走'模型接哪儿'"（部署参数散在环境里，恢复后要重新猜一遍）。
 * 部署时不想手点，就在界面上点一次：那一次会随数据库一起被备份、被恢复。
 */

import { CONFIG_KEY_PREFIX, type ConfigKv } from '../storage/config-kv.ts';
import {
  AiConfigError,
  DEFAULT_AI_MODEL_CONFIG,
  redactConfig,
  type AiModelConfig,
  type AiModelFormat,
} from './model-config.ts';

/** 库里的两个键名：配置一条、密钥一条（**分开**，免得"改地址"顺手动了密钥那一行） */
export const MODEL_CONFIG_KEY = `${CONFIG_KEY_PREFIX}ai-model`;
export const MODEL_KEY_KEY = `${CONFIG_KEY_PREFIX}ai-model.apiKey`;
/** 旧位置（`<状态目录>/ai-model.json` 与 `ai-model.key`）：**只用于一次性导入**，不再写 */
export const MODEL_CONFIG_FILE = 'ai-model.json';
export const MODEL_KEY_FILE = 'ai-model.key';

/** 界面上能改的东西（**没有环境变量名**：界面配置的是密钥本身，不是"去哪个变量里找"） */
export interface ModelConfigInput {
  format: AiModelFormat;
  model: string;
  endpoint?: string;
  timeoutMs: number;
  maxItems: number;
  /** 见文件头"三种状态的语义"：undefined 不改 / null 清除 / 字符串 设置 */
  apiKey?: string | null;
}

interface StoredModelConfig {
  version: 1;
  format: AiModelFormat;
  model: string;
  endpoint?: string;
  timeoutMs: number;
  maxItems: number;
  /** 是否有密钥被加密落盘（**不存密钥本身**，密钥在 `ai-model.key`） */
  apiKeyStored: boolean;
  updatedAt: string;
  updatedBy: string;
}

export interface LoadedModelConfig {
  config: AiModelConfig;
  /** 已解出的密钥（内存中，供适配器使用）。**不得进入任何返回值、日志或留痕** */
  apiKey?: string;
  /** 这份配置从哪来（`store` = 库里配过；`default` = 从没配过、走离线默认） */
  source: 'store' | 'default';
  /** 密钥是否就位（真值来源，界面只显示这个） */
  apiKeyPresent: boolean;
  updatedAt?: string;
  updatedBy?: string;
}

function readStored(kv: ConfigKv): StoredModelConfig | null {
  const parsed = ((): StoredModelConfig | null => {
    try {
      return kv.read<StoredModelConfig>(MODEL_CONFIG_KEY);
    } catch (err) {
      /* 读坏了**不静默当没有**：那会让"我配的模型没了"表现为"退回了离线模板"。
         裹回本模块的错误码：调用方依赖的是 `E_AI_CONFIG_INVALID`。 */
      throw new AiConfigError('E_AI_CONFIG_INVALID', `模型配置读不出来，拒绝按"未配置"继续：${(err as Error).message}`);
    }
  })();
  if (parsed === null) return null;
  if (parsed?.version !== 1) return null;
  return parsed;
}

/** 取密钥。**解不开 → 抛错**（`config-kv` 已保证不把"解不开"混成"没有"） */
function readStoredKey(kv: ConfigKv): string | undefined {
  const value = ((): string | null => {
    try {
      return kv.read<string>(MODEL_KEY_KEY);
    } catch (err) {
      throw new AiConfigError(
        'E_AI_CONFIG_INVALID',
        `模型密钥读不出来（口令已更换，或那一行被改动过）：${(err as Error).message}；不会当作"没有密钥"继续 —— 那会表现成"模型突然 401"`,
      );
    }
  })();
  if (value === null) return undefined;
  if (typeof value !== 'string' || value === '') {
    /* 存着一个非字符串/空值：那是数据坏了，不是"没有密钥"。宁可报出来。 */
    throw new AiConfigError('E_AI_CONFIG_INVALID', `库里的模型密钥不会是它该有的样子：${JSON.stringify(value)?.slice(0, 40)}`);
  }
  return value;
}

/**
 * 读取生效中的配置：**库里有就用库里的，没有就是离线默认**（不再有环境变量这一档）。
 */
export function loadModelConfig(kv: ConfigKv): LoadedModelConfig {
  const stored = readStored(kv);
  if (stored) {
    const config: AiModelConfig = {
      format: stored.format,
      model: stored.model,
      timeoutMs: stored.timeoutMs,
      maxItems: stored.maxItems,
    };
    if (stored.endpoint) config.endpoint = stored.endpoint;
    /* 只在"配置说密钥就位"时才去读密钥那一行：避免每次读配置都解一个用不到的信封 */
    const apiKey = stored.apiKeyStored ? readStoredKey(kv) : undefined;
    return {
      config,
      ...(apiKey !== undefined ? { apiKey } : {}),
      source: 'store',
      apiKeyPresent: apiKey !== undefined && apiKey !== '',
      updatedAt: stored.updatedAt,
      updatedBy: stored.updatedBy,
    };
  }
  return {
    config: { ...DEFAULT_AI_MODEL_CONFIG },
    source: 'default',
    apiKeyPresent: false,
  };
}

/**
 * 校验界面提交的配置。
 *
 * **规则与 `resolveModelConfig` 完全一致**（fail-closed、非法数值不取默认）——
 * 两条配置路径若校验口径不同，就会出现"界面能存进去、环境变量却拒绝"的配置，
 * 而那种配置的失败现场极难复现。
 */
export function validateModelConfigInput(input: Partial<ModelConfigInput>): ModelConfigInput {
  const format = input.format;
  if (format !== 'offline' && format !== 'openai-compatible') {
    throw new AiConfigError('E_AI_CONFIG_INVALID', `format 只能是 offline 或 openai-compatible，实际 ${JSON.stringify(format)}`);
  }
  const model = typeof input.model === 'string' ? input.model.trim() : '';
  const endpoint = typeof input.endpoint === 'string' ? input.endpoint.trim() : '';
  if (format === 'openai-compatible' && !endpoint) {
    throw new AiConfigError(
      'E_AI_CONFIG_NO_ENDPOINT',
      '选了 openai-compatible 却没有填地址：拒绝保存（保存下去就等于"看起来接上了真模型"，而实际没有）',
    );
  }
  if (format === 'openai-compatible' && !model) {
    throw new AiConfigError('E_AI_CONFIG_INVALID', '选了 openai-compatible 却没填模型名：留痕里将答不出"这条内容是哪个模型写的"');
  }
  const timeoutMs = input.timeoutMs ?? DEFAULT_AI_MODEL_CONFIG.timeoutMs;
  const maxItems = input.maxItems ?? DEFAULT_AI_MODEL_CONFIG.maxItems;
  for (const [value, name] of [[timeoutMs, 'timeoutMs'], [maxItems, 'maxItems']] as const) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new AiConfigError('E_AI_CONFIG_INVALID', `${name} 必须是正整数，实际 ${JSON.stringify(value)}（拒绝静默取默认值）`);
    }
  }
  if (input.apiKey !== undefined && input.apiKey !== null && typeof input.apiKey !== 'string') {
    throw new AiConfigError('E_AI_CONFIG_INVALID', 'apiKey 必须是字符串、null（清除）或不传（不改）');
  }
  const result: ModelConfigInput = {
    format,
    model: model || DEFAULT_AI_MODEL_CONFIG.model,
    timeoutMs,
    maxItems,
    ...(endpoint ? { endpoint } : {}),
    ...(input.apiKey !== undefined ? { apiKey: input.apiKey } : {}),
  };
  return result;
}

export interface SaveModelConfigResult {
  loaded: LoadedModelConfig;
  /** 密钥发生了什么（**只记动作，不记值**） */
  apiKeyAction: 'set' | 'cleared' | 'unchanged';
}

/**
 * 保存配置并返回**生效后**的配置。
 *
 * 先写非敏感配置、再处理密钥：若密钥这一步失败（比如口令缺失），
 * 至少不会出现"密钥已更新但配置还是旧的"这种半截状态 —— 反过来的半截状态更难解释。
 */
export function saveModelConfig(
  kv: ConfigKv,
  rawInput: Partial<ModelConfigInput>,
  by: string,
  options: { at?: string } = {},
): SaveModelConfigResult {
  const input = validateModelConfigInput(rawInput);
  const previous = ((): LoadedModelConfig | null => {
    try {
      return loadModelConfig(kv);
    } catch {
      /* 旧配置读坏了不该阻止修复：管理界面正是用来修它的地方 */
      return null;
    }
  })();

  let apiKeyStored = previous?.source === 'store' ? Boolean(readStored(kv)?.apiKeyStored) : Boolean(previous?.apiKeyPresent);
  let apiKeyAction: SaveModelConfigResult['apiKeyAction'] = 'unchanged';

  if (input.apiKey === null) {
    apiKeyStored = false;
    apiKeyAction = 'cleared';
  } else if (typeof input.apiKey === 'string' && input.apiKey !== '') {
    /* 这里原先守一句"没有口令就拒绝存密钥"。现在这条**由构造期保证**：
       `WorkStore` 没有口令直接抛（"不做没口令就存明文的兜底"），
       而 `config-kv` 不自己加密、只走它的 `putSealed` —— 所以走到这里就一定是有口令的。 */
    kv.write(MODEL_KEY_KEY, input.apiKey);
    apiKeyStored = true;
    apiKeyAction = 'set';
  }

  const stored: StoredModelConfig = {
    version: 1,
    format: input.format,
    model: input.model,
    timeoutMs: input.timeoutMs,
    maxItems: input.maxItems,
    apiKeyStored,
    updatedAt: options.at ?? new Date().toISOString(),
    updatedBy: by,
  };
  if (input.endpoint) stored.endpoint = input.endpoint;
  kv.write(MODEL_CONFIG_KEY, stored);

  /* 清除时**要真删那一行**：只把 apiKeyStored 置 false 而留着密文，
     等于"我清掉了"这句话是假的（密文还在库里，只是没人读它）。

     这里曾经写成"把文件写空"—— **注释说真删，实现却留下一个 0 字节的空壳**：
     对注释读代码的人以为它删了，看磁盘的人以为密钥还在。实测代价很具体：
     发布前排查（`npm run scan:phi`）每次都为这个空壳报一次"必须处置"，
     而它是我们自己造出来的假警报 —— 一道天天红的门禁等于没有门禁。
     现在是 `removeSealed`：一条 `delete`，没有"空壳"这种中间状态。 */
  if (apiKeyAction === 'cleared') kv.remove(MODEL_KEY_KEY);

  return { loaded: loadModelConfig(kv), apiKeyAction };
}

/**
 * 给界面的配置视图。**密钥永远只报"是否就位"**（见文件头）。
 *
 * `source` 一栏是刻意加的：它回答"现在跑的是库里配的那一份，还是从没配过的离线默认"。
 * 只有一档配置之后它变得更短，但**不能省** —— 省的后果是"我配了但没生效"与"我根本没配"
 * 在界面上长得一模一样。
 */
export function describeModelConfig(loaded: LoadedModelConfig): Record<string, unknown> {
  return {
    ...redactConfig(loaded.config),
    source: loaded.source,
    apiKeyPresent: loaded.apiKeyPresent,
    updatedAt: loaded.updatedAt ?? null,
    updatedBy: loaded.updatedBy ?? null,
  };
}
