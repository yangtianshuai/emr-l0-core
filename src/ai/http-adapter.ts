/**
 * OpenAI 兼容的模型适配器（`POST {endpoint}/chat/completions`）。
 *
 * 选这个协议不是因为它最好，而是因为**本机推理与一体机大多兼容它**
 * （vLLM / Ollama / 多数国产推理服务的兼容端点），于是"换模型"多数时候只改配置。
 *
 * ## transport 为什么可注入
 *
 * 自测用的是一台**假模型**：真实 `fetch` 由调用方传入，测试传入一个返回固定响应的函数。
 * 于是"请求怎么构造、响应怎么解析、错误怎么处理"这三件最容易出错的事**可以离线被测**，
 * 而自测不必依赖一台真实服务。
 *
 * 反过来说：让自测去连真模型，等于让自测**偶尔失败**，而那种失败最终会被所有人忽略。
 *
 * ## 响应体 ≠ 模型输出
 *
 * `/chat/completions` 的响应**不是**模型的输出本身，而是一个信封：
 * `{"choices":[{"message":{"content":"<模型的输出>"}}]}` —— 模型说的那段话是 `content` 这个
 * **字符串**。把响应体直接当模型输出解析，现场表现就是"连上了、也没 401，
 * 却永远报没有 suggestions 字段"，而错误信息里又看不到响应体，几乎无从推断。
 * 所以这里必须先拆信封（见 `unwrapModelOutput`）。
 *
 * ## 错误信息里为什么**不带响应体**
 *
 * 模型服务的错误响应经常**回显请求内容**（"invalid input: <你发的那段病历>"）。
 * 把它抄进日志，等于为了排查方便把病历内容又抄了一份到另一个地方。
 * 所以这里只报状态码与"响应体未记录"，排查靠 traceId 与服务端日志。
 *
 * ## 超时与"不落笔"
 *
 * 超时用 `AbortController` 主动中止，并且**任何失败都直接抛出**：
 * 不产出建议、不重试落笔、不退回模板。一次"什么都没发生"的失败，
 * 远好过一次"用模板假装成功"。
 */

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
  /** 响应体文本；**只在内存里用于解析**，不写日志、不进留痕、不放进错误信息 */
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
  /** HTTP 状态码（仅状态码，不含响应体） */
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

/**
 * 组装提示词。
 *
 * 三条刻意的约束：
 *   - **只给脱敏后的文本**（上下文包已经是脱敏产物，这里不再碰文档）；
 *   - **显式要求 JSON 且给出确切字段**：不依赖 `response_format`（不是所有兼容服务都支持它，
 *     发了可能直接 400），而是在提示词里说清 + 解析时容错提取；
 *   - **明确只允许落在给定 nodeId 上**：模型"顺手引用上文节点"是最常见的越界方式。
 */
function buildPrompt(request: AiSuggestRequest): string {
  const contextLines = request.context.items
    .map((item) => `- [${item.role}] nodeId=${item.nodeId}${item.tag ? ` tag=${item.tag}` : ''}：${item.text}`)
    .join('\n');
  return [
    '你是电子病历编辑器的辅助模块。你**只能提出建议**，不能直接改写病历。',
    '',
    `任务：${MODE_INSTRUCTION[request.mode]}`,
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

/**
 * 从模型输出里提取 JSON。
 *
 * 容错是**必要**的，不是宽容：即使提示词说了"不要代码块"，模型仍经常包一层
 * ```json 围栏或加一句"好的，以下是建议"。为此直接判失败，会让接入在第一天就不可用。
 * 但容错到此为止 —— **提取出来的结构仍要过 `validateSuggestions`**，
 * 那是"能不能落笔"的判断，不该有任何宽容余地。
 */
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

/**
 * 拆开 OpenAI 兼容的**响应信封**，取出模型正文。
 *
 * 收两种形状 —— 这不是"宽容"，取出来的东西仍要过 `validateSuggestions`：
 *   - 标准 chat 信封：`choices[0].message.content`（字符串；多模态服务可能是分段数组，
 *     只拼文本段，图像等分段忽略）；
 *   - 自建网关直出建议 JSON：没有 `choices` 时，**响应体本身**即模型输出。
 *
 * `finish_reason` 一并带出来：它是"输出被截断"这条线索的唯一来源，
 * 而截断的症状（JSON 断在半截）最容易被读成"模型不听话"。
 */
function unwrapModelOutput(bodyText: string): { content: string; finishReason?: string } {
  let envelope: unknown;
  try {
    envelope = JSON.parse(bodyText);
  } catch {
    /* 整个响应体不是 JSON：按"响应体即模型输出"交给 `extractJson` ——
       它本就要容忍围栏与一句前言，报错口径也留在它那里（E_AI_BAD_JSON）。
       在这里先抛一次，等于把"模型加了句前言"误判成"服务坏了"。 */
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
    /**
     * 密钥**直接给出**（由调用方从库里的 `config.ai-model.apiKey` 解出来）。
     *
     * 它**不进配置对象、不进日志**；调用方只把值递到这一层用一次。
     * 没有密钥时请求会以 401 失败，而现场现象是"模型没反应" ——
     * 所以界面那一侧必须把 `apiKeyPresent` 报出来，避免把排查方向引偏。
     */
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
      /* 超时**不能只靠 transport 自觉响应 abort**：一个不理会 signal 的实现会让请求永远挂着，
         而"挂着的请求"在现场表现为"AI 没反应"，排查方向会完全跑偏。
         所以额外 race 一个到点即 reject 的 promise —— 传输层守不守规矩，超时都成立。 */
      const timedOut = new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () =>
          reject(new AiRequestError('E_AI_TIMEOUT', `模型调用超时（${config.timeoutMs}ms）已中止，未产生任何建议`)),
        );
      });
      /* 传输层响应与下面要返回的 AiSuggestResponse 是两个东西：
         后者也叫 `response`（调用方读的是它），所以这里必须换个名字，否则同一作用域里重名。 */
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
        /* "JSON 坏了"是现象，finish_reason 才是线索：非 stop 多半是输出被截断（JSON 断在半截），
           只说前半句会把人引向"模型不听话"，而真正的处置是放宽 token 上限或缩短上下文。 */
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
      /* 校验在适配器内部完成：它最清楚自己的原始格式，也最该为"产出能不能用"负责。
         调用方若使用第三方适配器，**仍应再过一遍** `validateSuggestions`。 */
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
      /* `skipped` **原样带出，不在这里校验**：它与 `suggestions` 一样来自响应体，
         而"跳过声明是不是在说谎"（幻觉 nodeId、说没写又写了）只有拿范围去比对才能判 ——
         那是 `resolveSilenceReport` 的活。适配器在这里过滤，等于把
         "模型说了假话"这件事悄悄擦掉，而它恰恰是最该被看见的一种沉默。 */
      if (envelope.skipped !== undefined) response.skipped = envelope.skipped;
      return response;
    },
  };
}

export { AiOutputError };
