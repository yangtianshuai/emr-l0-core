// OpenAI 兼容的模型适配器（`POST {endpoint}/chat/completions`）。

import type { AiAdapter, AiSuggestRequest, AiSuggestResponse, AiSuggestionDraft, AiSuggestionMode } from './adapter.ts';
import { AiOutputError, validateSuggestions } from './adapter.ts';
import { modelIdOf, type AiModelConfig } from './model-config.ts';

export interface ModelTransportRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
}

export interface ModelTransportResponse {
  status: number;
  body: string;
}

export type ModelTransport = (request: ModelTransportRequest) => Promise<ModelTransportResponse>;

export type AiRequestErrorCode =
  | 'E_AI_HTTP_STATUS'
  | 'E_AI_TIMEOUT'
  | 'E_AI_BAD_JSON'
  | 'E_AI_NO_CONTENT'
  | 'E_AI_CONFIG_NO_ENDPOINT';

export class AiRequestError extends Error {
  code: AiRequestErrorCode;
  status?: number;

  constructor(code: AiRequestErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'AiRequestError';
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

const MODE_INSTRUCTION: Record<AiSuggestionMode, string> = {
  complete: '在目标段落现有内容之后续写，保持同一人称与专业术语。',
  draft: '为目标段落生成一段可编辑的草稿框架，不要编造未提供的检查结果或数值。',
  polish: '只做规范化（去冗余空白、统一标点），不得增删事实内容。',
};

function buildPrompt(request: AiSuggestRequest): string {
  const contextLines = request.context.items
    .map((item) => `- [${item.role}] nodeId=${item.nodeId}${item.tag ? ` tag=${item.tag}` : ''}：${item.text}`)
    .join('\n');
  const selectionLines = request.selection
    ? [
        '',
        `本次只润色 nodeId=${request.selection.nodeId} 中被选中的这一截：`,
        `「${request.selection.text}」`,
        '返回的 text 必须是**这一截润色后的替换文本**：不得包含选区之外的内容，不得增删事实。',
      ]
    : [];
  return [
    '你是电子病历编辑器的辅助模块。你**只能提出建议**，不能直接改写病历。',
    '',
    `任务：${MODE_INSTRUCTION[request.mode]}`,
    ...selectionLines,
    '',
    '本次允许建议落在以下 nodeId 上（**不得使用其它 nodeId**）：',
    request.allowedNodeIds.map((id) => `- ${id}`).join('\n'),
    '',
    '上下文（已脱敏；before/after 仅供理解语境，不要对它们提建议）：',
    contextLines,
    '',
    '只输出 JSON，不要输出任何解释文字或代码块标记。格式：',
    '{"suggestions":[{"nodeId":"...","text":"...","confidence":0.0,"rationale":"..."}]}',
    `最多 ${request.maxItems} 条；confidence 是 0~1 的数，表示你对这条建议的把握。`,
  ].join('\n');
}

function extractJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) {
      throw new AiRequestError('E_AI_BAD_JSON', '模型输出里找不到 JSON 对象（响应体未记录：可能含病历内容）');
    }
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch (err) {
      throw new AiRequestError('E_AI_BAD_JSON', `模型输出的 JSON 无法解析：${(err as Error).message}（响应体未记录）`);
    }
  }
}

function unwrapModelOutput(bodyText: string): { content: string; finishReason?: string } {
  let envelope: unknown;
  try {
    envelope = JSON.parse(bodyText);
  } catch {
    return { content: bodyText };
  }
  if (envelope && typeof envelope === 'object' && !Array.isArray(envelope)) {
    const choices = (envelope as Record<string, unknown>).choices;
    if (Array.isArray(choices)) {
      if (choices.length === 0) {
        throw new AiRequestError('E_AI_NO_CONTENT', '模型服务返回的 choices 为空（响应体未记录：常见于内容被拦下）');
      }
      const first = (choices[0] ?? {}) as Record<string, unknown>;
      const finishReason = typeof first.finish_reason === 'string' ? first.finish_reason : undefined;
      const raw = (first.message as Record<string, unknown> | undefined)?.content;
      const content =
        typeof raw === 'string'
          ? raw
          : Array.isArray(raw)
            ? raw
                .map((part) => (part && typeof part === 'object' ? (part as Record<string, unknown>).text : undefined))
                .filter((part): part is string => typeof part === 'string')
                .join('')
            : '';
      if (content.trim() === '') {
        throw new AiRequestError(
          'E_AI_NO_CONTENT',
          `模型返回里取不到正文（choices[0].message.content 为空${finishReason ? `，finish_reason=${finishReason}` : ''}）（响应体未记录）`,
        );
      }
      return { content, ...(finishReason ? { finishReason } : {}) };
    }
  }
  return { content: bodyText };
}

const defaultTransport: ModelTransport = async (request) => {
  const response = await fetch(request.url, {
    method: 'POST',
    headers: request.headers,
    body: request.body,
    ...(request.signal ? { signal: request.signal } : {}),
  });
  return { status: response.status, body: await response.text() };
};

export function createHttpAdapter(
  config: AiModelConfig,
  options: {
    transport?: ModelTransport;
    fetchImpl?: typeof fetch;
    apiKey?: string;
  } = {},
): AiAdapter {
  if (!config.endpoint) {
    throw new AiRequestError(
      'E_AI_CONFIG_NO_ENDPOINT',
      'openai-compatible 适配器必须给出 endpoint；拒绝在缺地址的情况下"退化成离线模板"',
    );
  }
  const transport = options.transport ?? (options.fetchImpl ? undefined : defaultTransport);
  const modelId = modelIdOf(config);
  const apiKey = options.apiKey?.trim();

  return {
    id: 'openai-compatible',
    async suggest(request: AiSuggestRequest): Promise<AiSuggestResponse> {
      const started = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.timeoutMs);
      const url = `${(config.endpoint as string).replace(/\/+$/, '')}/chat/completions`;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      const body = JSON.stringify({
        model: config.model,
        temperature: 0.2,
        messages: [{ role: 'user', content: buildPrompt(request) }],
      });
      const timedOut = new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () =>
          reject(new AiRequestError('E_AI_TIMEOUT', `模型调用超时（${config.timeoutMs}ms）已中止，未产生任何建议`)),
        );
      });
      let transportResponse: ModelTransportResponse;
      try {
        const doRequest: ModelTransport =
          transport ??
          (async (req) => {
            const res = await (options.fetchImpl as typeof fetch)(req.url, {
              method: 'POST',
              headers: req.headers,
              body: req.body,
              ...(req.signal ? { signal: req.signal } : {}),
            });
            return { status: res.status, body: await res.text() };
          });
        transportResponse = await Promise.race([
          doRequest({ url, headers, body, ...(request.signal ? { signal: request.signal } : {}) }),
          timedOut,
        ]);
      } catch (err) {
        if (err instanceof AiRequestError) throw err;
        if (controller.signal.aborted) {
          throw new AiRequestError('E_AI_TIMEOUT', `模型调用超时（${config.timeoutMs}ms）已中止，未产生任何建议`);
        }
        throw new AiRequestError('E_AI_HTTP_STATUS', `模型调用失败：${(err as Error).message}（未产生任何建议）`);
      } finally {
        clearTimeout(timer);
      }

      if (transportResponse.status < 200 || transportResponse.status >= 300) {
        throw new AiRequestError(
          'E_AI_HTTP_STATUS',
          `模型服务返回 ${transportResponse.status}；响应体未记录（错误响应常回显请求内容，抄进日志等于把病历又存了一份）`,
          transportResponse.status,
        );
      }

      const { content, finishReason } = unwrapModelOutput(transportResponse.body);
      let parsed: unknown;
      try {
        parsed = extractJson(content);
      } catch (err) {
        if (err instanceof AiRequestError && finishReason && finishReason !== 'stop') {
          throw new AiRequestError(err.code, `${err.message}；本次 finish_reason=${finishReason}（输出被截断或未正常结束）`);
        }
        throw err;
      }
      const envelope = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
      const rawItems = envelope.suggestions;
      if (rawItems === undefined) {
        throw new AiRequestError('E_AI_NO_CONTENT', '模型输出里没有 suggestions 字段（响应体未记录）');
      }
      const items: AiSuggestionDraft[] = validateSuggestions(rawItems, request);
      const response: AiSuggestResponse = {
        items,
        modelId,
        promptId: `http-${request.mode}`,
        usage: {
          latencyMs: Date.now() - started,
          inputChars: body.length,
          outputChars: items.reduce((sum, item) => sum + item.text.length, 0),
        },
      };
      if (envelope.skipped !== undefined) response.skipped = envelope.skipped;
      return response;
    },
  };
}

export { AiOutputError };
