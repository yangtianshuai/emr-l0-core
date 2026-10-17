/**
 * AI 模型接入自测（P1~P5）。
 *
 * 说明：本套件**全部是纯函数**，不连任何模型服务、不需要文档 —— 这本身就是设计要达成的性质：
 * "模型接入"里最容易出错的三件事（配置校验、产出校验、请求/响应/错误处理）都必须能在离线被验证。
 * 让自测去连一台真服务，等于让自测**偶尔失败**，而那种失败最终会被所有人忽略。
 *
 * 重点锁死的四条：
 *   P1 配置 **fail-closed**：选了真模型却没给地址 → 抛错，绝不静默退回离线模板；
 *   P3 产出校验：`NaN` / 越界 `confidence` / 幻觉 `nodeId` 必须在**进入建议集之前**被拦下
 *      （`NaN < threshold` 恒为 false，放过去就是绕过置信度门控）；
 *   P5 错误信息**不得携带响应体**（错误响应常回显请求内容，抄进日志等于把病历又存了一份）；
 *   P5 超时**不依赖传输层自觉响应 abort**（不理会 signal 的实现会让请求永远挂着）。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TestSuite, assert, assertEqual } from '../testing/harness.ts';
import { openConfigFixture, sealedBlobOf, writeCorruptRow } from '../testing/config-fixture.ts';
import {
  MODEL_CONFIG_KEY,
  MODEL_KEY_KEY,
  describeModelConfig,
  loadModelConfig,
  saveModelConfig,
  validateModelConfigInput,
} from './model-config-store.ts';
import type { AiContextPackage } from '../core/ai-context.ts';
import {
  AiOutputError,
  targetNodeIdsOf,
  validateSuggestions,
  type AiSuggestRequest,
  type AiSuggestionDraft,
} from './adapter.ts';
import { AiConfigError, DEFAULT_AI_MODEL_CONFIG, redactConfig, modelIdOf, type AiModelConfig } from './model-config.ts';
import { createOfflineAdapter } from './offline-adapter.ts';
import { AiRequestError, createHttpAdapter, type ModelTransport } from './http-adapter.ts';

const suite = new TestSuite('AI 模型接入自测', [
  '说明：验证配置与产出的**校验**、离线适配器的确定性，以及 HTTP 适配器的请求/解析/错误处理。',
  '全部离线：不连任何模型服务。真实调用只由部署环境触发。',
]);

const test = (name: string, fn: () => void | Promise<void>): Promise<void> => suite.test(name, fn);

const AT = '2026-10-09T10:00:00.000Z';

/* 本仓库环境的 node:fs 类型声明不完整（缺 mkdtempSync / rmSync 的完整声明，运行时存在）。
   这里做一次局部断言，与 core/store-self-test.ts 同一处理方式。 */
const fsx = (await import('node:fs')) as unknown as {
  mkdtempSync: (prefix: string) => string;
  rmSync: (path: string, options: { recursive?: boolean; force?: boolean }) => void;
};
const TEMP = process.env.TEMP ?? process.env.TMP ?? '.';

/** 一个最小的脱敏上下文包（真实场景由 buildAiContext 产出） */
function context(): AiContextPackage {
  return {
    docId: 'doc-1',
    docType: { system: 'WST500', code: 'A01', display: '入院记录' },
    items: [
      { nodeId: 'n_1', type: 'text', text: '患者主诉：胸痛3天。', origin: 'human', role: 'before' },
      { nodeId: 'n_2', type: 'text', text: '现病史：', origin: 'human', role: 'target' },
      { nodeId: 'n_3', type: 'text', text: '既往史：高血压5年。', origin: 'human', role: 'after' },
    ],
    policy: { includePatient: false, includeDataElements: false, maskStrategy: 'mask-person-name' },
    stats: { items: 3, chars: 30, tokenBudget: 2000, droppedByBudget: 0 },
    audit: {
      actorId: 'ai-1',
      actorKind: 'ai',
      at: AT,
      requestedNodeIds: ['n_2'],
      tokenBudget: 2000,
      droppedByBudget: 0,
      missingNodeIds: [],
      droppedTargets: [],
    },
  };
}

function request(overrides: Partial<AiSuggestRequest> = {}): AiSuggestRequest {
  return {
    context: context(),
    mode: 'complete',
    allowedNodeIds: ['n_2'],
    maxItems: 5,
    ...overrides,
  };
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
    return 'NO_THROW';
  } catch (err) {
    return String((err as { code?: string }).code ?? (err as Error).name);
  }
}

async function asyncCodeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return 'NO_THROW';
  } catch (err) {
    return String((err as { code?: string }).code ?? (err as Error).name);
  }
}

/** 一台"假模型"：按给定响应体返回，或永不返回（用于测超时） */
function fakeTransport(response: { status: number; body: string }): { transport: ModelTransport; seen: Array<{ url: string; headers: Record<string, string>; body: string }> } {
  const seen: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  return {
    seen,
    transport: async (req) => {
      seen.push({ url: req.url, headers: req.headers, body: req.body });
      return response;
    },
  };
}

async function main(): Promise<void> {
  await test('P1 配置 fail-closed：**选了真模型却没给地址必须抛错**，非法数值不取默认', () => {
    assertEqual(DEFAULT_AI_MODEL_CONFIG.format, 'offline', '默认离线（一个都没配就不外呼，病历内容也不出这台机器）');
    /* 校验口径**只有一处**（`validateModelConfigInput`）：界面保存与库读取共用它，
       所以这一组覆盖的是两条路径共通的规则，而不是某一条路径的私规 ——
       两条路径若各有一套口径，就会出现"界面能存进去、读的时候却拒绝"的配置。 */
    assertEqual(
      codeOf(() => validateModelConfigInput({ format: 'openai-compatible', model: 'qwen-med-7b' })),
      'E_AI_CONFIG_NO_ENDPOINT',
      '选了 openai-compatible 却没给地址，**必须抛错** —— 静默退回离线模板会让"已接入真模型"变成假话',
    );
    /* **模型名不能省**：它是写进留痕的 modelId，
       省掉它留痕就答不出"这条内容是哪个模型写的"，而那正是审计要看的东西 */
    assertEqual(
      codeOf(() => validateModelConfigInput({ format: 'openai-compatible', endpoint: 'http://x/v1' })),
      'E_AI_CONFIG_INVALID',
      '没有模型名时也要拦下（否则留痕里答不出"这条是哪个模型写的"）',
    );
    assertEqual(codeOf(() => validateModelConfigInput({ format: 'whatever' as never })), 'E_AI_CONFIG_INVALID', '格式枚举之外的取值必须拦下');
    assertEqual(codeOf(() => validateModelConfigInput({ format: 'offline', timeoutMs: 0 })), 'E_AI_CONFIG_INVALID', '超时不能为 0');
    assertEqual(codeOf(() => validateModelConfigInput({ format: 'offline', maxItems: -3 })), 'E_AI_CONFIG_INVALID', '条数不能为负');
    assertEqual(codeOf(() => validateModelConfigInput({ format: 'offline', maxItems: 1.5 })), 'E_AI_CONFIG_INVALID', '条数必须是整数（静默取整会让"我配了 1.5"变成没人知道的事）');

    const full = validateModelConfigInput({
      format: 'openai-compatible',
      endpoint: 'http://127.0.0.1:11434/v1',
      model: 'qwen-med-7b',
      timeoutMs: 5000,
      maxItems: 8,
    });
    assertEqual(full.timeoutMs, 5000, '超时应取配置值');
    assertEqual(full.maxItems, 8, '条数应取配置值');
    assert(new AiConfigError('E_AI_CONFIG_INVALID', 'x') instanceof Error, '配置错误应是 Error（供上层统一处理）');
  });

  await test('P2 modelId 与配置打印：离线带前缀、打印里根本没有密钥这一格', () => {
    assertEqual(modelIdOf(DEFAULT_AI_MODEL_CONFIG), 'offline:template-v1', '离线产出的 modelId 必须带 offline: 前缀（留痕里要能看出不是真模型）');
    assertEqual(
      modelIdOf({ format: 'openai-compatible', model: 'qwen-med-7b', endpoint: 'http://x/v1', timeoutMs: 1, maxItems: 1 }),
      'qwen-med-7b',
      '在线应直接用模型名（这才答得出"哪条内容是哪个模型写的"）',
    );

    /* 打印的配置里**没有密钥这一格**：密钥不在配置对象里（它在库里单独一行），
       所以"打印会不会漏出密钥"这个问题在类型层面就不存在（见 `model-config.ts` 约束 2）。
       "密钥是否就位"由 `describeModelConfig` 报（它读得到那一行有没有）。 */
    const shown = redactConfig({ format: 'openai-compatible', model: 'm', endpoint: 'http://x/v1', timeoutMs: 1, maxItems: 1 });
    assertEqual('apiKey' in shown, false, '打印配置不得含密钥字段');
    assertEqual('apiKeyEnv' in shown, false, '也不再有"密钥变量名"这一格（本轮取消了环境变量这一档）');
    assertEqual(shown.endpoint, 'http://x/v1', '地址如实打印：它不是秘密，而"接的到底哪台"必须能被核对');
  });

  await test('P3 产出校验：NaN / 越界 confidence / 幻觉 nodeId 必须在进入建议集之前被拦下', () => {
    const req = request();
    assertEqual(codeOf(() => validateSuggestions({ suggestions: [] }, req)), 'E_AI_OUTPUT_NOT_ARRAY', '非数组必须拦下');
    assertEqual(codeOf(() => validateSuggestions([], req)), 'E_AI_OUTPUT_EMPTY', '空产出是"调用失败"，不是"没有建议"');
    assertEqual(
      codeOf(() => validateSuggestions([{ nodeId: 'n_2', text: 'a', confidence: Number.NaN }], req)),
      'E_AI_OUTPUT_BAD_CONFIDENCE',
      '**NaN 必须拦下**：NaN < threshold 恒为 false，放过去等于绕过置信度门控（项目里踩过这个坑）',
    );
    assertEqual(
      codeOf(() => validateSuggestions([{ nodeId: 'n_2', text: 'a', confidence: Number.POSITIVE_INFINITY }], req)),
      'E_AI_OUTPUT_BAD_CONFIDENCE',
      'Infinity 同样要拦下',
    );
    assertEqual(
      codeOf(() => validateSuggestions([{ nodeId: 'n_2', text: 'a', confidence: 1.5 }], req)),
      'E_AI_OUTPUT_BAD_CONFIDENCE',
      '越界要拦下',
    );
    assertEqual(
      codeOf(() => validateSuggestions([{ nodeId: 'n_1', text: 'a', confidence: 0.9 }], req)),
      'E_AI_OUTPUT_UNKNOWN_NODE',
      '**幻觉 nodeId 必须拦下**：n_1 只是给模型看的背景（before 角色），按它落笔就是改到了别的段落',
    );
    assertEqual(
      codeOf(() => validateSuggestions([{ nodeId: 'n_2', text: '   ', confidence: 0.9 }], req)),
      'E_AI_OUTPUT_BAD_TEXT',
      '空文本必须拦下（医生点了采纳却什么也没发生）',
    );
    assertEqual(
      codeOf(() => validateSuggestions([{ nodeId: 'n_2', text: 'a', confidence: 0.9, extra: 1 }, { nodeId: 'n_2', text: 'b', confidence: 0.9 }], request({ maxItems: 1 }))),
      'E_AI_OUTPUT_TOO_MANY',
      '超上限必须报错而**不是静默截断**（截断会让人以为模型只产出了这些）',
    );

    const deduped = validateSuggestions(
      [
        { nodeId: 'n_2', text: '同样的话', confidence: 0.9, rationale: '理由' },
        { nodeId: 'n_2', text: '同样的话', confidence: 0.8 },
      ],
      req,
    );
    assertEqual(deduped.length, 1, '同节点同文本应去重（模型重复输出很常见，重复项只是废话）');
    assertEqual(deduped[0]?.rationale, '理由', '未被丢弃的那条应保留理由');

    assert(new AiOutputError('E_AI_OUTPUT_EMPTY', 'x') instanceof Error, '产出错误应是 Error');
    assertEqual(targetNodeIdsOf(context()).join(','), 'n_2', '允许落笔的节点只取 target（before/after 是给模型看的背景，不是让它改写的地方）');
  });

  await test('P4 离线适配器：确定性、只对目标节点产出、modelId 带 offline 前缀、不外呼', async () => {
    const adapter = createOfflineAdapter({ ...DEFAULT_AI_MODEL_CONFIG });
    const first = await adapter.suggest(request());
    const second = await adapter.suggest(request());

    assertEqual(JSON.stringify(first.items), JSON.stringify(second.items), '离线产出必须确定性（否则自测会被随机内容掩盖）');
    assertEqual(first.items.length, 1, '只应对 target 节点产出（before/after 不产出建议）');
    assertEqual(first.items[0]?.nodeId, 'n_2', '应落在目标节点上');
    assertEqual(
      first.items[0]?.confidence,
      0.95,
      '置信度须高于关键内容阈值：离线环境要能把"采纳→签章"整条链路走通，否则那段没有回归保护',
    );
    assertEqual(first.modelId, 'offline:template-v1', 'modelId 应带 offline: 前缀');
    assert(first.usage.latencyMs >= 0, '应如实报告耗时');

    const noTarget = await adapter.suggest(request({ context: { ...context(), items: [context().items[0] as never] } }));
    assertEqual(noTarget.items.length, 0, '没有目标节点时返回空（这不是"模型坏了"，而是这次范围里没有要写的东西）');

    const polished = await adapter.suggest(request({ mode: 'polish' }));
    assertEqual(String(polished.items[0]?.text).includes('离线模板润色'), false, '润色不得添加标记文字，只做规范化');
  });

  await test('P5 HTTP 适配器（假模型）：请求构造、围栏容错、**错误不携带响应体**、超时不靠传输层配合', async () => {
    /* 配置对象直接构造（它现在只从库里来，构造形状就是库里那一行的形状）；
       密钥**不在它里面** —— 它经 `createHttpAdapter` 的 `apiKey` 参数单独递进去，见下面那一处。 */
    const config: AiModelConfig = {
      format: 'openai-compatible',
      endpoint: 'http://127.0.0.1:11434/v1/',
      model: 'qwen-med-7b',
      timeoutMs: 3000,
      maxItems: DEFAULT_AI_MODEL_CONFIG.maxItems,
    };
    assertEqual(
      codeOf(() => createHttpAdapter({ ...config, endpoint: undefined })),
      'E_AI_CONFIG_NO_ENDPOINT',
      '缺地址时构造适配器就要抛错，不得"退化成离线模板"',
    );

    const ok = fakeTransport({
      status: 200,
      body: '```json\n{"suggestions":[{"nodeId":"n_2","text":"续写内容。","confidence":0.85}]}\n```',
    });
    const adapter = createHttpAdapter(config, { transport: ok.transport, apiKey: 'secret' });
    const result = await adapter.suggest(request());
    assertEqual(result.items.length, 1, '带 markdown 围栏的响应应能解析（模型经常无视"不要代码块"）');
    assertEqual(result.modelId, 'qwen-med-7b', 'modelId 应由适配器如实报告');
    assertEqual(ok.seen[0]?.url, 'http://127.0.0.1:11434/v1/chat/completions', 'URL 应去掉结尾斜杠再拼路径');
    assertEqual(ok.seen[0]?.headers.Authorization, 'Bearer secret', '有密钥时应带 Authorization 头');
    assertEqual(String(ok.seen[0]?.body).includes('n_2'), true, '请求体应列出允许的 nodeId');
    assertEqual(String(ok.seen[0]?.body).includes('secret'), false, '**请求体里不得出现密钥**（它只该在请求头）');

    /* 真服务（OpenAI 兼容）回的**不是模型输出，而是信封**：模型正文在
       `choices[0].message.content` 这个**字符串**里。少了拆信封这一步，
       配置全对也只会报"没有 suggestions 字段" —— 而错误信息按纪律不带响应体，
       现场几乎无从推断。假模型直接回模型输出，恰好把这一层遮住。 */
    const enveloped = fakeTransport({
      status: 200,
      body: JSON.stringify({
        id: 'chatcmpl-probe',
        object: 'chat.completion',
        model: 'deepseek-chat',
        choices: [
          {
            index: 0,
            finish_reason: 'stop',
            message: { role: 'assistant', content: '{"suggestions":[{"nodeId":"n_2","text":"信封里的续写。","confidence":0.8}]}' },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 20 },
      }),
    });
    const unwrapped = await createHttpAdapter(config, { transport: enveloped.transport }).suggest(request());
    assertEqual(unwrapped.items[0]?.text, '信封里的续写。', '标准 chat 信封必须先拆开取 content');

    /* 信封在、正文是空的：要报"取不到正文"，不能错误地退化成"没有 suggestions 字段" */
    const emptyContent = fakeTransport({
      status: 200,
      body: JSON.stringify({ choices: [{ finish_reason: 'content_filter', message: { role: 'assistant', content: '' } }] }),
    });
    assertEqual(
      await asyncCodeOf(() => createHttpAdapter(config, { transport: emptyContent.transport }).suggest(request())),
      'E_AI_NO_CONTENT',
      '信封里正文为空必须报错（含 finish_reason，便于判断是否被拦下）',
    );

    /* 截断：JSON 断在半截时，报错要带上 finish_reason —— 否则会被读成"模型不听话" */
    const truncated = fakeTransport({
      status: 200,
      body: JSON.stringify({
        choices: [{ finish_reason: 'length', message: { role: 'assistant', content: '{"suggestions":[{"nodeId":"n_2","text":"没写完' } }],
      }),
    });
    let truncatedMessage = '';
    try {
      await createHttpAdapter(config, { transport: truncated.transport }).suggest(request());
    } catch (err) {
      truncatedMessage = (err as Error).message;
    }
    assertEqual(truncatedMessage.includes('finish_reason=length'), true, '截断的输出要报出 finish_reason，否则排查方向会跑偏');

    /* 错误响应常回显请求内容 —— 若把它抄进错误信息，等于为了排查方便把病历又存了一份 */
    const leak = fakeTransport({ status: 400, body: 'invalid input: 患者主诉：胸痛3天。' });
    const leakAdapter = createHttpAdapter(config, { transport: leak.transport });
    let leakMessage = '';
    try {
      await leakAdapter.suggest(request());
    } catch (err) {
      leakMessage = (err as Error).message;
    }
    assertEqual(leakMessage.includes('胸痛'), false, '**错误信息不得携带响应体内容**（可能含病历）');
    assertEqual(leakMessage.includes('400'), true, '但应保留状态码，否则没法排查');

    const badJson = fakeTransport({ status: 200, body: '抱歉，我无法完成这个请求。' });
    assertEqual(
      await asyncCodeOf(() => createHttpAdapter(config, { transport: badJson.transport }).suggest(request())),
      'E_AI_BAD_JSON',
      '非 JSON 输出必须报错',
    );
    const noField = fakeTransport({ status: 200, body: '{"answer":"嗯"}' });
    assertEqual(
      await asyncCodeOf(() => createHttpAdapter(config, { transport: noField.transport }).suggest(request())),
      'E_AI_NO_CONTENT',
      '没有 suggestions 字段要报错',
    );
    const hallucination = fakeTransport({ status: 200, body: '{"suggestions":[{"nodeId":"n_1","text":"改上文","confidence":0.9}]}' });
    assertEqual(
      await asyncCodeOf(() => createHttpAdapter(config, { transport: hallucination.transport }).suggest(request())),
      'E_AI_OUTPUT_UNKNOWN_NODE',
      '模型越界到背景节点 → 在适配器内部就被拦下，不会进入建议集',
    );

    /* 一个**不理会 abort** 的传输层：若超时只靠 signal，这个请求会永远挂着 */
    const never: ModelTransport = () => new Promise(() => {});
    const timeoutConfig = { ...config, timeoutMs: 60 };
    const started = Date.now();
    const timeoutCode = await asyncCodeOf(() => createHttpAdapter(timeoutConfig, { transport: never }).suggest(request()));
    assertEqual(timeoutCode, 'E_AI_TIMEOUT', '**超时不能依赖传输层配合**：不响应 abort 的实现也必须被判超时');
    assert(Date.now() - started < 2000, '超时应按配置的时间中止，不是无限等');

    assert(new AiRequestError('E_AI_TIMEOUT', 'x') instanceof Error, '请求错误应是 Error');

    const suggestions: AiSuggestionDraft[] = result.items;
    assertEqual(suggestions[0]?.text, '续写内容。', '解析出的文本应原样保留');
  });

  await test('P6 配置存储：密钥密封落库且**永不回显**；三态语义；非法配置拒绝；清除是真删行', () => {
    const fixture = openConfigFixture({ prefix: 'l0-ai-config-', passphrase: 'cfg-pass' });
    const kv = fixture.kv;
    try {
      const base = { format: 'openai-compatible' as const, model: 'qwen-med-7b', endpoint: 'http://127.0.0.1:11434/v1', timeoutMs: 5000, maxItems: 8 };

      /* 首次：库里什么都没有 → 默认离线 */
      const initial = loadModelConfig(kv);
      assertEqual(initial.source, 'default', '没配过应是"默认"来源（界面要能显示它，否则"改了没生效"无从判断）');

      saveModelConfig(kv, { ...base, apiKey: 'secret-key-1' }, 'admin@test', { at: AT });
      /* 密钥必须**密封落库**：直接看库里那两行，不听服务端自报。
         注意口径的变化：从"非敏感部分明文"改成**一律密封** ——
         同一张表里有的加密有的明文，后来的人只看代码分不出哪行是明文（见 `storage/config-kv.ts`）。 */
      const keyBlob = sealedBlobOf(fixture, MODEL_KEY_KEY);
      assert(keyBlob !== null && keyBlob.length > 0, '密钥那一行应当存在');
      assertEqual(keyBlob?.includes('secret-key-1'), false, '密钥不得明文落库');
      const cfgBlob = sealedBlobOf(fixture, MODEL_CONFIG_KEY);
      assert(cfgBlob !== null, '配置那一行应当存在');
      assertEqual(cfgBlob?.includes('secret-key-1'), false, '配置里也不得出现密钥');
      assertEqual(cfgBlob?.includes('127.0.0.1:11434'), false, '一律密封：地址也不以明文躺在库里（同一张表不做两种待遇）');

      const loaded = loadModelConfig(kv);
      assertEqual(loaded.source, 'store', '应来自配置界面');
      assertEqual(loaded.apiKey, 'secret-key-1', '口令对时应能解出密钥（供适配器使用）');
      assertEqual(loaded.config.maxItems, 8, '配置应完整往返');
      const shown = describeModelConfig(loaded);
      assertEqual(JSON.stringify(shown).includes('secret-key-1'), false, '**下发给界面的视图绝不能含密钥**');
      assertEqual(shown.apiKeyPresent, true, '只报"是否就位"');
      assertEqual(shown.updatedBy, 'admin@test', '应记下是谁改的（这是一项改数据流向的操作）');

      /* 三态语义：不传 = 不改；null = 清除；字符串 = 设置 */
      saveModelConfig(kv, { ...base, model: 'qwen-med-8b' }, 'admin@test', { at: AT });
      assertEqual(loadModelConfig(kv).apiKey, 'secret-key-1', '**没传 apiKey 时不得动密钥**（否则改地址会顺手清掉密钥，现场表现是"模型突然 401"）');
      saveModelConfig(kv, { ...base, model: 'qwen-med-8b', apiKey: null }, 'admin@test', { at: AT });
      assertEqual(loadModelConfig(kv).apiKeyPresent, false, '显式 null 应清除密钥');
      /* 清除必须是**真删那一行**：留着一份"没人读的密文"，等于"我清掉了"是句假话。
         这里曾经写成"把文件写空"（注释说真删、实现留了个 0 字节空壳），所以这条要钉住。 */
      assertEqual(sealedBlobOf(fixture, MODEL_KEY_KEY), null, '清除密钥必须是真删行（不留空壳）');

      /* 非法配置必须拒绝（与环境变量那条路径同一口径） */
      assertEqual(
        codeOf(() => saveModelConfig(kv, { ...base, endpoint: '' }, 'admin@test')),
        'E_AI_CONFIG_NO_ENDPOINT',
        '选了在线却没填地址 → 拒绝保存（保存下去就等于"看起来接上了真模型"）',
      );
      assertEqual(codeOf(() => saveModelConfig(kv, { ...base, maxItems: 0 }, 'admin@test')), 'E_AI_CONFIG_INVALID', '非法条数拒绝');

      /* **配置只有一个来源（库）**：这里不再有"环境变量把界面配置压住"这一档。
         钉住它是因为那条现场最难查：改了界面、环境里还留着一份旧的，看起来像"没保存成功"。 */
      const again = loadModelConfig(kv);
      assertEqual(again.source, 'store', '库里有配置时来源就是 store（不再有 env 这一档）');
      assertEqual(again.config.model, 'qwen-med-8b', '生效的应是库里那一份');

      /* **解不开 ≠ 没配过**：口令换过（或那一行被改过）时必须报错。
         若静默当作"没配过"，现场会表现成"我配的模型悄悄变回离线模板" ——
         与"没配过"完全同形，而两件事的处置完全不同。 */
      writeCorruptRow(fixture, MODEL_CONFIG_KEY);
      assertEqual(codeOf(() => loadModelConfig(kv)), 'E_AI_CONFIG_INVALID', '配置读不出来时不得当作"没配过"');
      writeCorruptRow(fixture, MODEL_KEY_KEY);
      assertEqual(codeOf(() => loadModelConfig(kv)), 'E_AI_CONFIG_INVALID', '密钥读不出来时不得当作"没有密钥"');
    } finally {
      fixture.cleanup();
    }
  });

  process.exit(suite.report());
}

void main();
