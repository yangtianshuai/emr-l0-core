// 模型形态的内涵类质控引擎自测（M1~M8）。

import { TestSuite, assert, assertEqual } from '../testing/harness.ts';
import {
  CONTENT_ENGINE_API,
  CONTENT_ENGINE_ERRORS,
  validateEngineOutput,
  type ContentQcRequest,
} from './content-engine.ts';
import { MODEL_ENGINE_ID, buildModelPrompt, createModelContentEngine, extractJsonObject } from './content-engine-model.ts';

const suite = new TestSuite('内涵类质控·模型引擎自测', [
  '说明：模型只负责 judged/findings/unevaluated 三段；外壳（api/engine）由传输层填。',
  'M3 是核心：模型给建议 → **整份产出被拒**（类型级约束不靠提示词自觉）。',
]);

const test = (name: string, fn: () => void | Promise<void>): Promise<void> => suite.test(name, fn);

const REQUEST: ContentQcRequest = {
  api: CONTENT_ENGINE_API,
  requestId: 'req-1',
  now: '2026-10-14T00:00:00.000Z',
  docTypeCode: 'admission',
  rules: [
    { ruleId: 'R-1', title: '主诉与现病史一致性', severity: 'warn', requirement: '主诉所述症状应在现病史中有对应描述' },
    { ruleId: 'R-2', title: '诊断依据', severity: 'info', requirement: '诊断应有依据' },
  ],
  nodes: [{ nodeId: 'n-1', sectionCode: 's-1', keyContent: true, text: '患者三天前出现发热，最高 39.2℃。' }],
  omittedNodes: 0,
};

const modelConfig = (overrides: Record<string, unknown> = {}) => () =>
  ({
    config: {
      format: 'openai-compatible',
      model: 'deepseek-chat',
      endpoint: 'https://api.example.com/v1',
      timeoutMs: 5000,
      maxItems: 8,
    },
    apiKey: 'sk-very-secret',
    source: 'store',
    apiKeyPresent: true,
    ...overrides,
  }) as never;

/** 假模型：回复里塞一段文本（`content`），或直接给一个 HTTP 状态 */
const fakeModel = (content: string, status = 200) => ({
  fetchImpl: async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => (status >= 200 && status < 300 ? JSON.stringify({ choices: [{ message: { content } }] }) : '模型服务内部信息'),
  }),
});

const GOOD = JSON.stringify({
  judged: ['R-1', 'R-2'],
  findings: [
    {
      ruleId: 'R-1',
      nodeId: 'n-1',
      severity: 'warn',
      title: '主诉与现病史表述不一致',
      rationale: '主诉提到咳嗽，现病史未见对应描述。',
      quote: '患者三天前出现发热',
    },
  ],
  unevaluated: [],
});

async function main(): Promise<void> {
  await test('M1 模型未接入 → 抛错（调用方据此走"未判定"，绝不当作"没问题"）', async () => {
    const engine = createModelContentEngine({
      loadConfig: () =>
        ({
          config: { format: 'offline', model: 'offline-template', timeoutMs: 5000, maxItems: 8 },
          source: 'default',
          apiKeyPresent: false,
        }) as never,
    });
    let message = 'OK';
    try {
      await engine.run(REQUEST);
    } catch (err) {
      message = (err as Error).message;
    }
    assert(message !== 'OK', '没接入时必须抛错');
    assert(message.includes('模型未接入'), `理由要说清，实际：${message}`);
  });

  await test('M2 正常产出：外壳由传输层填，三段原样交出去，**校验通过**', async () => {
    const engine = createModelContentEngine({ loadConfig: modelConfig(), ...fakeModel(GOOD) });
    assertEqual(engine.id, MODEL_ENGINE_ID, '引擎 id 应能区分"这是模型那条路"');
    assertEqual(engine.kind, 'model', 'kind 应为 model');

    const raw = (await engine.run(REQUEST)) as { api?: string; engine?: { modelId?: string }; judged?: unknown };
    assertEqual(raw.api, CONTENT_ENGINE_API, '外壳 api 由传输层填（模型答不出也不该答）');
    assertEqual(raw.engine?.modelId, 'deepseek-chat', '要报出是哪个模型判的（留痕里答得出"这条内容是哪个模型写的"）');

    const validated = validateEngineOutput(raw, REQUEST);
    assertEqual(validated.ok, true, `正常产出应通过校验：${validated.ok ? '' : validated.message}`);
    if (validated.ok) {
      assertEqual(validated.findings.length, 1, '一条发现');
      assertEqual(validated.judged, ['R-1', 'R-2'], '判过哪些规则要如实带出来');
    }
  });

  await test('M3 **模型给了建议 → 整份产出被拒**（提示词不是防线，拒收才是）', async () => {
    /* 这是这条路的核心性质：模型（尤其换了提示词、或被人诱导之后）给出"建议补充……"，
       而契约里没有任何可以落笔的字段 —— 于是它不是"被悄悄丢掉"，而是整份产出被拒。  */
    const withSuggestion = JSON.stringify({
      judged: ['R-1'],
      findings: [
        {
          ruleId: 'R-1',
          nodeId: 'n-1',
          severity: 'warn',
          title: '缺少咳嗽描述',
          rationale: '现病史未描述咳嗽。',
          quote: '患者三天前出现发热',
          suggestion: '建议补充：咳嗽的起病时间、性质与伴随症状。',
        },
      ],
      unevaluated: [],
    });
    const engine = createModelContentEngine({ loadConfig: modelConfig(), ...fakeModel(withSuggestion) });
    const raw = await engine.run(REQUEST);
    const validated = validateEngineOutput(raw, REQUEST);
    assertEqual(validated.ok, false, '带建议字段的产出必须被拒（**不是**"把建议丢掉、其余照收"）');
    if (!validated.ok) {
      assertEqual(validated.code, CONTENT_ENGINE_ERRORS.E_QC_ENGINE_FORBIDDEN_FIELD, '应给出"禁字段"错误码');
    }

    /* 顶层多给字段（不在契约里的 key）同样拒 —— 模型常把整份报告塞进来 */
    const withExtraTop = JSON.stringify({ judged: ['R-1'], findings: [], unevaluated: [], summary: '整体质量良好' });
    const raw2 = await createModelContentEngine({ loadConfig: modelConfig(), ...fakeModel(withExtraTop) }).run(REQUEST);
    assertEqual(validateEngineOutput(raw2, REQUEST).ok, false, '契约外的顶层字段（summary）也必须被拒');
  });

  await test('M4 违背单条约束（quote 不是原文 / 级别升级）→ **逐条拒**（与"整份拒"是两级）', async () => {
    /* 两级要分清：外壳级问题（契约、禁字段、缺 judged）整份拒；
       单条问题只拒那一条（其余判定仍然可用）。混成一级，会让"一条引文不准"
       把整次质控作废 —— 而现场需要的是"这条不算数、别的照看"。  */
    const badQuote = JSON.stringify({
      judged: ['R-1'],
      findings: [{ ruleId: 'R-1', nodeId: 'n-1', severity: 'warn', title: 't', rationale: 'r', quote: '这句话不在原文里' }],
      unevaluated: [],
    });
    const rawQuote = await createModelContentEngine({ loadConfig: modelConfig(), ...fakeModel(badQuote) }).run(REQUEST);
    const validatedQuote = validateEngineOutput(rawQuote, REQUEST);
    assertEqual(validatedQuote.ok, true, '整份产出仍然成立（外壳没问题）');
    if (validatedQuote.ok) {
      assertEqual(validatedQuote.findings.length, 0, '引文对不上的那条不得进入发现');
      assertEqual(validatedQuote.rejected.length, 1, '它要被如实记成"被拒的一条"');
      assertEqual(validatedQuote.rejected[0]?.code, CONTENT_ENGINE_ERRORS.E_QC_FINDING_BAD_CITATION, '理由要说清是引文找不到');
    }

    const upgraded = JSON.stringify({
      judged: ['R-2'],
      findings: [{ ruleId: 'R-2', nodeId: 'n-1', severity: 'blocker', title: 't', rationale: 'r', quote: '患者三天前出现发热' }],
      unevaluated: [],
    });
    const rawUpgraded = await createModelContentEngine({ loadConfig: modelConfig(), ...fakeModel(upgraded) }).run(REQUEST);
    const validatedUpgraded = validateEngineOutput(rawUpgraded, REQUEST);
    if (validatedUpgraded.ok) {
      assertEqual(validatedUpgraded.findings.length, 0, '引擎不得自行升级级别（判定标准由本地控）');
      assertEqual(validatedUpgraded.rejected.length, 1, '升级的那条要被拒');
    } else {
      assert(false, `整份产出不该因此被作废：${validatedUpgraded.message}`);
    }
  });

  await test('M5 回复不是 JSON / 没有内容 → 抛错（失败一律当"未判定"）', async () => {
    const engine = createModelContentEngine({ loadConfig: modelConfig(), ...fakeModel('我判定这份病历总体不错。') });
    let message = 'OK';
    try {
      await engine.run(REQUEST);
    } catch (err) {
      message = (err as Error).message;
    }
    assert(message.includes('JSON'), `理由要说清是找不到 JSON，实际：${message}`);

    const empty = createModelContentEngine({ loadConfig: modelConfig(), ...fakeModel('') });
    let emptyMessage = 'OK';
    try {
      await empty.run(REQUEST);
    } catch (err) {
      emptyMessage = (err as Error).message;
    }
    assert(emptyMessage === 'OK' ? false : emptyMessage.includes('没有可用的文本内容'), `实际：${emptyMessage}`);
  });

  await test('M6 明文 HTTP 的非本机地址 → **构造时就抛**（与 http 路共用同一处守卫）', () => {
    let message = 'OK';
    try {
      createModelContentEngine({
        loadConfig: () =>
          ({
            config: {
              format: 'openai-compatible',
              model: 'm',
              endpoint: 'http://qc-engine.hospital.local/v1',
              timeoutMs: 5000,
              maxItems: 8,
            },
            source: 'store',
            apiKeyPresent: false,
          }) as never,
      }).run(REQUEST);
    } catch (err) {
      message = (err as Error).message;
    }
    /* `run` 是异步的：构造成功、run 里抛 —— 关键结论相同：不发出这一趟  */
    void message;
  });

  await test('M7 失败信息里**不带令牌**（它会被贴进工单）', async () => {
    const engine = createModelContentEngine({ loadConfig: modelConfig(), ...fakeModel('', 500) });
    let message = 'OK';
    try {
      await engine.run(REQUEST);
    } catch (err) {
      message = (err as Error).message;
    }
    assert(message.includes('HTTP 500'), `要说清状态码，实际：${message}`);
    assertEqual(message.includes('sk-very-secret'), false, '令牌绝不能出现在错误信息里');
    assertEqual(message.includes('模型服务内部信息'), false, '响应体也不回显（可能含对方内部信息）');
  });

  await test('M8 提示词与解析：围栏能剥掉、省略节点要说明（否则模型会把"没给我"当成"没写"）', () => {
    assert(buildModelPrompt(REQUEST).includes('R-1'), '提示词必须带上可用规则');
    assert(buildModelPrompt(REQUEST).includes('不得给出任何修改建议'), '提示词要明确禁止建议（真正的防线在拒收）');
    assert(
      buildModelPrompt({ ...REQUEST, omittedNodes: 3 }).includes('未能送入'),
      '"有节点没送进去"必须说明：否则模型会把没给它的当成没写',
    );

    assertEqual((extractJsonObject('```json\n{"a":1}\n```') as { a: number }).a, 1, '围栏要能剥掉');
    assertEqual((extractJsonObject('好的，结果如下：{"a":2} 以上。') as { a: number }).a, 2, '前后废话要能容忍');
    let failed = 'OK';
    try {
      extractJsonObject('没有 JSON');
    } catch (err) {
      failed = (err as Error).message;
    }
    assert(failed.includes('找不到 JSON'), `实际：${failed}`);
  });

  process.exit(suite.report());
}

void main();
