export type AiModelFormat = 'offline' | 'openai-compatible';

export interface AiModelConfig {
  format: AiModelFormat;
  model: string;
  endpoint?: string;
  timeoutMs: number;
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

export function modelIdOf(config: AiModelConfig): string {
  return config.format === 'offline' ? `offline:${config.model}` : config.model;
}

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
