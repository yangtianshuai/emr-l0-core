// 模型形态的内涵类质控引擎：把"外部质控引擎"换成这台机器已经接上的那个模型。

import type { LoadedModelConfig } from '../ai/model-config-store.ts';
import { CONTENT_ENGINE_API, resolveEngineEndpoint, type ContentQcEngine, type ContentQcRequest } from './content-engine.ts';

export interface ModelEngineOptions {
  /**
   * 取当前生效的模型接入配置。每次 `run` 都取一次 —— 与仓库其它配置同一口径：
   * 管理员改完立即生效，不做缓存（"改了要重启才生效"是运维最容易踩空的坑）。
    */
  loadConfig: () => LoadedModelConfig;
  /** 测试可注入（默认用全局 fetch） */
  fetchImpl?: (input: string, init: Record<string, unknown>) => Promise<{
    ok: boolean;
    status: number;
    text: () => Promise<string>;
  }>;
  /** 不传则用模型配置里的 `timeoutMs`，再退到 20000 */
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export const MODEL_ENGINE_ID = 'qc-content-model';

/**
 * 提示词：照契约写，但真正的约束在校验里。
 *
 * 刻意不在这里复制一份"完整契约"（那会与 `describeContentContract()` 漂移）：
 * 该说的三件事说清楚 —— 只能用给的规则、只能报判过的与判不了的、不许给建议。
  */
export function buildModelPrompt(request: ContentQcRequest): string {
  return [
    '你在做病历内涵质控：**只判定，不改写**。',
    '',
    `可用的规则（只能用这些 ruleId）：${request.rules.map((rule) => `${rule.ruleId}（${rule.title}｜允许的最高级别 ${rule.severity}）：${rule.requirement}`).join('\n')}`,
    '',
    '判定要求：',
    '1. 只依据上面给出的规则与下面给出的节点文本判定；不得引用未给出的节点或规则。',
    '2. `quote` 必须是该节点文本里**逐字出现**的片段（引用原文，不是改写）。',
    '3. `severity` 不得超过该规则允许的最高级别。',
    '4. 判不了的规则必须放进 `unevaluated` 并说明原因 —— **没判不等于没问题**。',
    '5. **不得给出任何修改建议、不得产出任何建议/改写类字段**：本系统的产出里没有可以落笔的地方，',
    '   带建议字段的整份产出会被拒收。',
    '',
    '只输出**一个 JSON 对象**，字段恰好三段：',
    '{"judged": ["判过的 ruleId"], "findings": [{"ruleId","nodeId","severity","title","rationale","quote","confidence?"}], "unevaluated": [{"ruleId","reason"}]}',
    '',
    `待判定的节点：${JSON.stringify(request.nodes)}`,
    request.omittedNodes > 0 ? `（另有 ${request.omittedNodes} 个节点因上限未能送入：不得据此推断"没写"）` : '',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/** 从模型回复里取出那个 JSON 对象：容忍 ```json 围栏与前后废话，取第一个 `{` 到最后一个 `}` */
export function extractJsonObject(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error(`模型回复里找不到 JSON 对象：${text.slice(0, 200)}`);
  try {
    return JSON.parse(text.slice(start, end + 1)) as unknown;
  } catch (err) {
    throw new Error(`模型回复里的 JSON 解析不了：${(err as Error).message}`);
  }
}

export function createModelContentEngine(options: ModelEngineOptions): ContentQcEngine {
  const timeoutMs = options.timeoutMs ?? 20000;
  const maxBytes = options.maxResponseBytes ?? 512 * 1024;
  const doFetch = options.fetchImpl ?? ((input, init) => fetch(input, init as RequestInit) as never);

  return {
    id: MODEL_ENGINE_ID,
    kind: 'model',
    version: '1',
    async run(request, signal): Promise<unknown> {
      const loaded = options.loadConfig();
      if (loaded.config.format !== 'openai-compatible' || !loaded.config.endpoint) {
        throw new Error(
          `模型未接入（当前来源：${loaded.source}；format=${loaded.config.format}）—— 内涵类质控引擎不可用。` +
            '请在管理后台「能力配置」里把模型接上，或改用 http 引擎。',
        );
      }
      const url = resolveEngineEndpoint(loaded.config.endpoint);
      /* 与模型适配器同一路径：`/chat/completions`（地址里已经带 /v1 就不要再加一层） */
      const target = `${url.toString().replace(/\/+$/, '')}/chat/completions`;
      const budget = signal?.timeoutMs ?? loaded.config.timeoutMs ?? timeoutMs;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), budget);
      try {
        const response = await doFetch(target, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(loaded.apiKey ? { Authorization: `Bearer ${loaded.apiKey}` } : {}),
          },
          body: JSON.stringify({
            model: loaded.config.model,
            temperature: 0,
            messages: [
              { role: 'system', content: '你只输出 JSON。' },
              { role: 'user', content: buildModelPrompt(request) },
            ],
          }),
          signal: controller.signal,
        });
        if (!response.ok) {
          /* 只带状态码，不回显响应体：它可能含模型服务的内部信息（令牌也绝不进这里） */
          throw new Error(`模型返回 HTTP ${response.status}`);
        }
        const raw = await response.text();
        if (raw.length > maxBytes) throw new Error(`模型响应过大（${raw.length} 字节 > 上限 ${maxBytes}）：拒绝解析`);
        let envelope: unknown;
        try {
          envelope = JSON.parse(raw);
        } catch (err) {
          throw new Error(`模型响应不是合法 JSON：${(err as Error).message}`);
        }
        const content = (envelope as { choices?: Array<{ message?: { content?: unknown } }> } | null)?.choices?.[0]?.message?.content;
        if (typeof content !== 'string' || content.trim() === '') {
          throw new Error('模型响应里没有可用的文本内容（choices[0].message.content 为空）');
        }
        const body = extractJsonObject(content) as Record<string, unknown>;

        /* 外壳是我们的：模型自报的 api/engine 一律被覆盖（它答的是别人的身份）。
           模型多给的其它字段原样带上去 —— 由校验去拒，这里不替它清理门户。  */
        return {
          api: CONTENT_ENGINE_API,
          engine: { id: MODEL_ENGINE_ID, kind: 'model', version: '1', modelId: loaded.config.model },
          ...body,
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
