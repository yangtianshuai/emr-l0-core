/**
 * AI 模型的接入配置。
 *
 * ## 为什么需要它
 *
 * 设计上把"模型选择与提示词工程"划在内核之外（见 `docs/L2-智能能力接入设计.md` 第十节第 5 条），
 * 这个边界是对的。但"不在内核里"被当成了"不需要有地方配" —— 现状是：
 * 五类 AI 能力全部依赖模型，而**没有任何一处能配模型**，`modelId` 由各调用方各自写死
 * （例如 demo 服务里的 `const MODEL_ID = 'local/qwen-med:7b@2026-09-demo'`）。
 *
 * 后果不是"少一个开关"，而是**每个接入方各自发明一套**：密钥从哪读、超时多少、
 * 返回值怎么校验，口径各不相同 —— 这正是 L2 里那句"门越多，AI 原生越假"的翻版。
 *
 * ## 四条硬约束
 *
 * 1) **fail-closed**：选了 `openai-compatible` 却没有 endpoint，**直接抛错**，
 *    绝不静默退回离线模板。理由与"配了非法盐却退回派生盐"完全相同 ——
 *    静默降级会让"我配的是真模型"悄悄变成假话，而配置本身是**唯一**的迹象。
 * 2) **配置里没有密钥这一格**：密钥单独一行加密落库（`config.ai-model.apiKey`），
 *    读取只报"是否就位"（`apiKeyPresent`），`redactConfig()` 打印的也不含它。
 *    原先这里存的是**变量名**（`apiKeyEnv`），本轮取消：需要存储的东西一律入库，
 *    不再指向"去哪个环境变量里找" —— 环境变量会顺着 `docker inspect`、崩溃转储、
 *    子进程一路漏出去，而库里那一行与病历数据受同一把口令保护。
 * 3) **离线必须显式可见**：`format: 'offline'` 是默认值，但它产出的建议
 *    在 `modelId` 上带 `offline:` 前缀，进了留痕也能一眼看出"这不是真模型产出的"。
 * 4) **非法数值不取默认**：超时、条数写错了就抛错 —— 一律"帮你改成默认值"会让
 *    运维以为自己配的东西生效了（与约束 1 同一个病根）。
 */

export type AiModelFormat = 'offline' | 'openai-compatible';

export interface AiModelConfig {
  format: AiModelFormat;
  /**
   * 模型标识。**它会写进建议与文档留痕的 `modelId`**，所以必须能回答
   * "这条内容是哪个模型、哪一版产出的" —— 填 `qwen-med-7b` 而不是"AI"。
   */
  model: string;
  /** OpenAI 兼容服务的基地址（如 `http://127.0.0.1:11434/v1`）；`format` 为该格式时必填 */
  endpoint?: string;
  timeoutMs: number;
  /** 单次最多接受的建议条数。超出即报错，**不静默截断**（截断会让人以为模型只产出了这些） */
  maxItems: number;
}

export const DEFAULT_AI_MODEL_CONFIG: AiModelConfig = {
  format: 'offline',
  model: 'template-v1',
  timeoutMs: 20_000,
  maxItems: 20,
};

export type AiConfigErrorCode = 'E_AI_CONFIG_INVALID' | 'E_AI_CONFIG_NO_ENDPOINT';

export class AiConfigError extends Error {
  code: AiConfigErrorCode;

  constructor(code: AiConfigErrorCode, message: string) {
    super(message);
    this.name = 'AiConfigError';
    this.code = code;
  }
}

/* 这里原先有 `resolveModelConfig(env)`：从 `L0_AI_FORMAT` / `L0_AI_ENDPOINT` / `L0_AI_MODEL`
   / `L0_AI_TIMEOUT_MS` / `L0_AI_MAX_ITEMS` / `L0_AI_API_KEY_ENV` 解析配置，作为"界面 > 环境 > 默认"
   的第二档。本轮按"系统里任何需要存储的都放数据库"取消这一档：
   **配置只有一个来源（库），界面改完立即生效；不再有"环境变量把它压住了"这种现场。**
   解析与校验的口径现在只保留一处：`model-config-store.ts` 的 `validateModelConfigInput`。 */

/**
 * 写进建议与留痕的模型标识。
 *
 * 离线产出**强制加前缀**：它的目的是让"这条建议出自模板"在**留痕里**也成立 ——
 * 否则一份全是离线模拟内容的病历，事后看留痕会以为有模型参与过。
 */
export function modelIdOf(config: AiModelConfig): string {
  return config.format === 'offline' ? `offline:${config.model}` : config.model;
}

/**
 * 可安全打印的配置。
 *
 * **密钥值不在配置对象里**（它在库里单独一行），所以这里能安全打印。
 * "密钥是否就位"由 `model-config-store.ts` 的 `describeModelConfig` 给出（它读得到那一行有没有）——
 * 这一层不假装知道密钥的事，就不会有人从这里把值取出来。
 */
export function redactConfig(config: AiModelConfig): Record<string, unknown> {
  return {
    format: config.format,
    model: config.model,
    modelId: modelIdOf(config),
    endpoint: config.endpoint ?? null,
    timeoutMs: config.timeoutMs,
    maxItems: config.maxItems,
  };
}
