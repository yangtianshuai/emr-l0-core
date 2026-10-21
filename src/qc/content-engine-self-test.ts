// 内涵类质控引擎契约自测（C1~C15）。

import { TestSuite, assert, assertEqual } from '../testing/harness.ts';
import {
  CONTENT_ENGINE_API,
  CONTENT_ENGINE_ERRORS,
  CONTENT_ENGINE_LIMITS,
  FORBIDDEN_CONTENT_FIELDS,
  buildContentRequest,
  createUnavailableEngine,
  describeContentContract,
  parseContentRules,
  validateEngineOutput,
  type ContentQcEngine,
  type ContentQcFinding,
  type ContentQcRequest,
  type ContentQcResponse,
  type NoForbiddenFields,
} from './content-engine.ts';

const findingHasNoForbidden: NoForbiddenFields<ContentQcFinding> = true;
const responseHasNoForbidden: NoForbiddenFields<ContentQcResponse> = true;

const suite = new TestSuite('内涵类质控引擎契约自测', [
  '说明：契约 + 产出校验；本轮未接任何外部引擎，未接入走"未判定"通道如实上报。',
  'C1 是类型级约束：能让本地代码连"塞一条建议"都写不出来；C4/C8 是运行时闸门：管住线上来的 JSON。',
]);

const test = (name: string, fn: () => void | Promise<void>): Promise<void> => suite.test(name, fn);

const RULE_IDS = {
  ok: 'R-CONTENT-01',
  strict: 'R-CONTENT-02',
};

/** 请求：两条规则（一条 info 上限、一条 warn 上限）+ 两个节点 */
function sampleRequest(overrides: Partial<ContentQcRequest> = {}): ContentQcRequest {
  return buildContentRequest({
    requestId: 'req-1',
    now: '2026-10-14T00:00:00.000Z',
    docTypeCode: 'WST500.1',
    visitType: 'inpatient',
    rules: [
      { ruleId: RULE_IDS.ok, title: '鉴别诊断依据', severity: 'info', requirement: '是否写明了鉴别诊断的依据' },
      { ruleId: RULE_IDS.strict, title: '病情变化记录', severity: 'warn', requirement: '病情变化是否有记录' },
    ],
    nodes: [
      { nodeId: 'n_a' as never, text: '考虑肺部感染，需与肺结核鉴别。', keyContent: true },
      { nodeId: 'n_b' as never, text: '今日一般情况可。', keyContent: false },
    ],
    ...overrides,
  });
}

function baseResponse(): Record<string, unknown> {
  return {
    api: CONTENT_ENGINE_API,
    engine: { id: 'test-engine', kind: 'rules', version: '1.0.0' },
    judged: [RULE_IDS.ok, RULE_IDS.strict],
    findings: [
      {
        ruleId: RULE_IDS.ok,
        nodeId: 'n_a',
        severity: 'info',
        title: '鉴别诊断未给出依据',
        rationale: '文中提到"需与肺结核鉴别"，但没有写依据（症状 / 影像 / 检验）',
        quote: '需与肺结核鉴别',
      },
    ],
    unevaluated: [],
  };
}

const withFinding = (patch: Record<string, unknown>): Record<string, unknown> => {
  const response = baseResponse();
  response.findings = [{ ...(response.findings as Array<Record<string, unknown>>)[0], ...patch }];
  return response;
};

function codeOf(raw: unknown, request = sampleRequest()): string {
  const result = validateEngineOutput(raw, request);
  return result.ok ? '（通过）' : result.code;
}

async function main(): Promise<void> {
  await test('C1 类型级约束：产出类型里**没有**任何"能写进文档"的字段，且契约自述列清了禁用清单', () => {
    assertEqual(findingHasNoForbidden, true, 'ContentQcFinding 不得含禁用字段（含则是编译期错误，这里跑不到）');
    assertEqual(responseHasNoForbidden, true, 'ContentQcResponse 不得含禁用字段');
    const contract = describeContentContract() as { constraints: string[]; api: string };
    assertEqual(contract.api, CONTENT_ENGINE_API, '契约自述要报出版本');
    for (const field of FORBIDDEN_CONTENT_FIELDS) {
      assert(
        contract.constraints.some((line) => line.includes(field)),
        `契约自述必须逐字列出禁用字段 ${field}（实现方要照着它改）`,
      );
    }
  });

  await test('C2 合法产出：通过校验，且带上下游锚点定位所需的规则标题与引文位置', () => {
    const result = validateEngineOutput(baseResponse(), sampleRequest());
    assertEqual(result.ok, true, `应通过：${result.ok ? '' : result.message}`);
    if (!result.ok) return;
    assertEqual(result.findings.length, 1, '一条发现');
    assertEqual(result.rejected, [], '没有丢弃');
    assertEqual(result.silentRules, [], '两条规则都报过 judged，不算沉默');
    const finding = result.findings[0]!;
    assertEqual(finding.ruleTitle, '鉴别诊断依据', '带上规则标题（下游注解要用）');
    assertEqual(finding.quoteAt >= 0, true, '引文位置必须算出来（锚点定位用）');
    assertEqual(finding.nodeId, 'n_a', '锚点指向被判节点');
  });

  await test('C3 契约版本不符 / 顶层形状不对 → **整份拒绝**（不猜、不挑拣）', () => {
    assertEqual(codeOf({ ...baseResponse(), api: 'qc.content/2' }), CONTENT_ENGINE_ERRORS.E_QC_ENGINE_API_MISMATCH, '版本不符要整份拒');
    assertEqual(codeOf({ ...baseResponse(), extra: 1 }), CONTENT_ENGINE_ERRORS.E_QC_ENGINE_SHAPE, '契约之外的顶层字段要拒');
    const noEngine = baseResponse();
    delete noEngine.engine;
    assertEqual(codeOf(noEngine), CONTENT_ENGINE_ERRORS.E_QC_ENGINE_SHAPE, '缺 engine 要拒（谁产出的必须可查）');
    const modelNoId = baseResponse();
    modelNoId.engine = { id: 'm', kind: 'model', version: '1' };
    assertEqual(codeOf(modelNoId), CONTENT_ENGINE_ERRORS.E_QC_ENGINE_SHAPE, 'model 来源必须给 modelId（无法回放与追责的不收）');
    assertEqual(codeOf('不是对象'), CONTENT_ENGINE_ERRORS.E_QC_ENGINE_SHAPE, '不是对象要拒');
  });

  await test('C4 **不得产出建议**：出现禁用字段 → 专门的错误码，且消息里给出禁用清单', () => {
    const withSuggestion = withFinding({ suggestion: '建议补充：肺结核接触史阴性。' });
    assertEqual(codeOf(withSuggestion), CONTENT_ENGINE_ERRORS.E_QC_ENGINE_FORBIDDEN_FIELD, 'suggestion 必须被整份拒绝');
    const result = validateEngineOutput(withSuggestion, sampleRequest());
    assertEqual(result.ok, false, '被拒');
    if (result.ok) return;
    assert(result.message.includes('suggestion'), `消息要点名那个字段，实际：${result.message}`);
    assert(result.message.includes('不得产出可落笔的内容'), `消息要说明为什么，实际：${result.message}`);
    for (const field of FORBIDDEN_CONTENT_FIELDS) {
      assert(result.message.includes(field), `消息里要给出禁用清单（实现方可照着改），缺：${field}`);
    }
    const firstFinding = (baseResponse().findings as Array<Record<string, unknown>>)[0]!;
    assertEqual(
      codeOf({ ...baseResponse(), findings: [{ ...firstFinding, meta: { patch: [] } }] }),
      CONTENT_ENGINE_ERRORS.E_QC_ENGINE_FORBIDDEN_FIELD,
      '嵌套的禁用字段同样要拒',
    );
    for (const field of ['patch', 'ops', 'newText', 'diff'] as const) {
      assertEqual(codeOf(withFinding({ [field]: 'x' })), CONTENT_ENGINE_ERRORS.E_QC_ENGINE_FORBIDDEN_FIELD, `${field} 必须被拒`);
    }
  });

  await test('C5 缺 `judged` → 整份拒绝（"没有发现"与"根本没跑"必须能被区分）', () => {
    const response = baseResponse();
    delete response.judged;
    assertEqual(codeOf(response), CONTENT_ENGINE_ERRORS.E_QC_ENGINE_SHAPE, '缺 judged 要拒');
    const result = validateEngineOutput(response, sampleRequest());
    assertEqual(result.ok, false, '被拒');
    if (!result.ok) assert(result.message.includes('根本没跑'), `理由要讲清为什么要它，实际：${result.message}`);
  });

  await test('C6 引擎自创规则号 → **逐条丢弃**，其余保留，并如实报出丢弃理由', () => {
    const response = baseResponse();
    response.findings = [
      ...(response.findings as unknown[]),
      { ruleId: 'R-我自己编的', nodeId: 'n_a', severity: 'info', title: 'x', rationale: 'y', quote: '肺部感染' },
    ];
    const result = validateEngineOutput(response, sampleRequest());
    assertEqual(result.ok, true, '整份不该被废：质控是提示性的，一条坏的不该废掉整份');
    if (!result.ok) return;
    assertEqual(result.findings.length, 1, '合法的那条要留下');
    assertEqual(result.rejected.length, 1, '坏的那条要报出来');
    assertEqual(result.rejected[0]?.code, CONTENT_ENGINE_ERRORS.E_QC_FINDING_UNKNOWN_RULE, '理由应是"规则号不在清单里"');
    assert(String(result.rejected[0]?.message).includes('不得自创规则'), `消息要说清原因，实际：${result.rejected[0]?.message}`);
  });

  await test('C7 引用本次没给出的节点 → 丢弃（越界即拒）', () => {
    const result = validateEngineOutput(withFinding({ nodeId: 'n_别的地方' }), sampleRequest());
    assertEqual(result.ok, true, '整份保留');
    if (!result.ok) return;
    assertEqual(result.findings, [], '越界的发现要被丢掉');
    assertEqual(result.rejected[0]?.code, CONTENT_ENGINE_ERRORS.E_QC_FINDING_OUT_OF_SCOPE, '理由应是"越界"');
  });

  await test('C8 引文对不上 = 幻觉 → 丢弃（医生会照着一条不存在的问题去改病历）', () => {
    const result = validateEngineOutput(withFinding({ quote: '患者有肺结核接触史' }), sampleRequest());
    assertEqual(result.ok, true, '整份保留');
    if (!result.ok) return;
    assertEqual(result.findings.length, 0, '引文对不上的必须丢弃');
    assertEqual(result.rejected[0]?.code, CONTENT_ENGINE_ERRORS.E_QC_FINDING_BAD_CITATION, '理由应是"引文找不到"');
    assert(String(result.rejected[0]?.message).includes('找不到'), '消息要说明是"在文本里找不到"');
    const quoted = validateEngineOutput(withFinding({ quote: '需与肺结核鉴别。' }), sampleRequest());
    assertEqual(quoted.ok && quoted.findings.length, 1, '逐字存在的引文应被接受');
    const rewritten = validateEngineOutput(withFinding({ quote: '需与肺结核鉴別' }), sampleRequest());
    assertEqual(rewritten.ok && rewritten.findings.length, 0, '改写过的引文应被丢弃');
  });

  await test('C9 级别越权 / 非法级别 → 丢弃（判定标准由本地控，引擎不得升级）', () => {
    const escalated = validateEngineOutput(withFinding({ severity: 'block' }), sampleRequest());
    assertEqual(escalated.ok && escalated.findings.length, 0, '规则上限是 info，引擎报 block 应被丢');
    assert(String(escalated.ok ? escalated.rejected[0]?.message : '').includes('不得高于规则声明的上限'), '理由要说清"不得越权升级"');
    const bad = validateEngineOutput(withFinding({ severity: '严重' }), sampleRequest());
    assertEqual(bad.ok && bad.findings.length, 0, '不在枚举里的级别要丢');
    /* 规则上限是 warn 的那条，报 warn 可以 */
    const allowed = validateEngineOutput(
      withFinding({ ruleId: RULE_IDS.strict, severity: 'warn' }),
      sampleRequest(),
    );
    assertEqual(allowed.ok && allowed.findings.length, 1, '不超过上限的级别应被接受');
  });

  await test('C10 confidence：NaN / 越界 / 非数字 → 丢弃；0~1 的有限数 → 接受', () => {
    for (const value of [Number.NaN, -0.1, 1.01, '0.5', Infinity]) {
      const result = validateEngineOutput(withFinding({ confidence: value }), sampleRequest());
      assertEqual(result.ok && result.findings.length, 0, `confidence=${String(value)} 必须被丢（NaN 会让门控失效）`);
    }
    const ok = validateEngineOutput(withFinding({ confidence: 0.6 }), sampleRequest());
    assertEqual(ok.ok && ok.findings[0]?.confidence, 0.6, '合法置信度要保留');
    const absent = validateEngineOutput(baseResponse(), sampleRequest());
    assertEqual(absent.ok && absent.findings[0]?.confidence, undefined, '不给置信度也可以（内容类判定常给不出有意义的数）');
  });

  await test('C11 同规则同节点重复上报 → 第二条丢弃', () => {
    const response = baseResponse();
    response.findings = [
      ...(response.findings as unknown[]),
      { ...(response.findings as Array<Record<string, unknown>>)[0], title: '换个说法再来一条' },
    ];
    const result = validateEngineOutput(response, sampleRequest());
    assertEqual(result.ok && result.findings.length, 1, '只留一条');
    assertEqual(result.ok ? result.rejected[0]?.code : '', CONTENT_ENGINE_ERRORS.E_QC_FINDING_DUPLICATE, '理由应是"重复"');
  });

  await test('C12 既没说判了、也没说没判的规则 → 点名进 `silentRules`（界面按"未判定"显示）', () => {
    const response = baseResponse();
    response.judged = [RULE_IDS.ok];
    response.unevaluated = [];
    const result = validateEngineOutput(response, sampleRequest());
    assertEqual(result.ok && result.silentRules, [RULE_IDS.strict], '沉默的规则要点名 —— 它既不是"干净"也不是"判不了"');
    const reported = baseResponse();
    reported.judged = [RULE_IDS.ok];
    reported.unevaluated = [{ ruleId: RULE_IDS.strict, reason: '本次未提供该规则所需上下文' }];
    const second = validateEngineOutput(reported, sampleRequest());
    assertEqual(second.ok && second.silentRules, [], '报过"判不了"就不该再算沉默');
    assertEqual(second.ok && second.unevaluated.length, 1, '未判定要保留（它必须显示出来）');
  });

  await test('C13 上限与节点挑选：发现超限整份拒；节点按关键内容优先、**不截断文本**、少送的计数', () => {
    const tooMany = baseResponse();
    tooMany.findings = Array.from({ length: CONTENT_ENGINE_LIMITS.maxFindings + 1 }, () => (baseResponse().findings as unknown[])[0]);
    assertEqual(codeOf(tooMany), CONTENT_ENGINE_ERRORS.E_QC_ENGINE_TOO_LARGE, '超过上限要整份拒（不做截断处理）');

    const many = Array.from({ length: 5 }, (_, index) => ({
      nodeId: `n_${index}` as never,
      text: index === 4 ? '关键内容' : '普通内容',
      keyContent: index === 4,
    }));
    const request = buildContentRequest({ requestId: 'r', now: 'now', rules: [], nodes: many, });
    assertEqual(request.nodes[0]?.nodeId, 'n_4', '关键内容节点要排在最前');
    assertEqual(request.omittedNodes, 0, '没超上限就不该有省略');
    const capped = buildContentRequest({
      requestId: 'r',
      now: 'now',
      rules: [],
      nodes: Array.from({ length: CONTENT_ENGINE_LIMITS.maxNodes + 3 }, (_, index) => ({
        nodeId: `n_${index}` as never,
        text: 'x',
        keyContent: false,
      })),
    });
    assertEqual(capped.nodes.length, CONTENT_ENGINE_LIMITS.maxNodes, '节点数按上限截');
    assertEqual(capped.omittedNodes, 3, '少送几个要**如实计数**（否则引擎会把"没给我"当成"没写"）');
    const long = buildContentRequest({
      requestId: 'r',
      now: 'now',
      rules: [],
      nodes: [{ nodeId: 'n_long' as never, text: 'a'.repeat(CONTENT_ENGINE_LIMITS.maxTotalChars + 100), keyContent: true }],
    });
    assertEqual(long.nodes[0]?.text.length > CONTENT_ENGINE_LIMITS.maxTotalChars, true, '单个超长节点**不截断**（半截文本会得出"这里没写"的错误结论）');
  });

  await test('C14 未接入的引擎：**全部规则报未判定**，而不是"没有发现"', async () => {
    const engine = createUnavailableEngine('内涵类质控引擎未接入');
    const request = sampleRequest();
    const produced = (await engine.run(request)) as ContentQcResponse;
    assertEqual(produced.findings, [], '未接入不产出任何发现（不编数据）');
    assertEqual(produced.judged, [], '也没判过任何规则');
    assertEqual(produced.unevaluated?.length, request.rules.length, '每条规则都要报"判不了"，界面据此显示未判定');
    assert(String(produced.unevaluated?.[0]?.reason).includes('未接入'), '理由要说清是未接入');
    const result = validateEngineOutput(produced, request);
    assertEqual(result.ok, true, '未接入的产出本身也要合法（它走的是同一条校验）');
    assertEqual(result.ok && result.silentRules, [], '报了未判定 → 不该再有沉默规则');
  });

  await test('C15 端到端：测试引擎（好 / 坏各一）走同一条通路，坏的那个被拦下', async () => {
    const request = sampleRequest();
    const engineOf = (id: string, mutate: (response: ContentQcResponse) => unknown): ContentQcEngine => ({
      id,
      kind: 'rules',
      version: 'test',
      run: async () => mutate(baseResponse() as unknown as ContentQcResponse) as ContentQcResponse,
    });
    const good = await engineOf('good', (response) => response).run(request);
    const goodResult = validateEngineOutput(good, request);
    assertEqual(goodResult.ok && goodResult.findings.length, 1, '好引擎的产出应被接受');

    /* 坏引擎：想把"建议"夹带进来（这是本契约最要紧的一条边界） */
    const sneaky = await engineOf('sneaky', (response) => ({
      ...(response as unknown as Record<string, unknown>),
      findings: [{ ...(response.findings[0] as unknown as Record<string, unknown>), suggestion: '建议改成……' }],
    })).run(request);
    const sneakyResult = validateEngineOutput(sneaky, request);
    assertEqual(sneakyResult.ok ? '（通过）' : sneakyResult.code, CONTENT_ENGINE_ERRORS.E_QC_ENGINE_FORBIDDEN_FIELD, '夹带建议的产出必须整份拒绝');
  });

  await test('C16 规则清单来自业务方：逐条校验（坏的那条报出来，其余仍可用）；空清单合法', () => {
    const parsed = parseContentRules([
      { ruleId: 'R-C-01', title: '鉴别诊断依据', severity: 'info', requirement: '是否写明了鉴别诊断的依据' },
      { ruleId: 'R-C-01', title: '重复号', severity: 'info', requirement: 'x' },
      { ruleId: 'R-C-02', title: 'x', severity: '严重', requirement: 'y' },
      { ruleId: 'R-C-03', title: 'x', severity: 'warn', requirement: 'y', suggestion: '清单里也不许带改法' },
      { notAnObject: true },
    ]);
    assertEqual(parsed.ok, true, '整份不该被废：一条写错不该让其余都不能用');
    if (!parsed.ok) return;
    assertEqual(parsed.rules.map((rule) => rule.ruleId), ['R-C-01'], '合法的留下');
    assertEqual(parsed.rejected.length, 4, '坏的四条都要逐条报出来');
    assert(parsed.rejected.some((item) => item.message.includes('重复')), '规则号重复要点名');
    assert(
      parsed.rejected.some((item) => item.message.includes('契约之外的字段')),
      '清单条目里带 suggestion 也要被拒（清单只描述"在问什么"，不给改法）',
    );
    const empty = parseContentRules([]);
    assertEqual(empty.ok, true, '空清单是合法状态（也是当前默认）');
    assertEqual(parseContentRules({}).ok, false, '不是数组要整份拒绝');
  });

  const code = suite.report();
  process.exit(code);
}

void main();
