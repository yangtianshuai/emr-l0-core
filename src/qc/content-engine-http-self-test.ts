/**
 * 内涵类质控 **HTTP 传输层**自测（H1~H8）。
 *
 *   node src/qc/content-engine-http-self-test.ts
 *
 * 用一个**本机假引擎**（真起 HTTP 服务）把三件事做成事实：
 *   H1 **明文只允许本机**：这一下会把病历内容发出去，配置写错一个字符就是明文外发；
 *   H2/H6 传输层**不修补**：它只搬运与拦"搬运层面的问题"（状态码 / 超时 / 非 JSON / 过大）；
 *   H8 分工真的成立：**想夹带建议**的引擎会被下游校验整份拒掉，
 *      **引文对不上**的会被逐条丢掉 —— 传输层不替它美化。
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { TestSuite, assert, assertEqual } from '../testing/harness.ts';
import {
  CONTENT_ENGINE_API,
  CONTENT_ENGINE_ERRORS,
  buildContentRequest,
  createHttpContentEngine,
  validateEngineOutput,
  type ContentQcRequest,
  type ContentQcResponse,
} from './content-engine.ts';

const suite = new TestSuite('内涵类质控 HTTP 传输层自测', [
  '说明：契约与校验已在上游就位；这一套只验"真的能调用"，以及搬运层面的边界。',
  'H1/H8 是重点：明文外发要在构造期就被拒；引擎想夹带建议要在下游被整份拒掉。',
]);

const test = (name: string, fn: () => void | Promise<void>): Promise<void> => suite.test(name, fn);

function sampleRequest(): ContentQcRequest {
  return buildContentRequest({
    requestId: 'req-http-1',
    now: '2026-10-14T00:00:00.000Z',
    docTypeCode: 'WST500.1',
    rules: [{ ruleId: 'R-DEMO-01', title: '演示用规则', severity: 'info', requirement: '是否写了依据' }],
    nodes: [{ nodeId: 'n_a' as never, text: '考虑肺部感染，需与肺结核鉴别。', keyContent: true }],
  });
}

/** 起一个本机假引擎（端口取 0，由系统分配），跑完就关 */
async function withFakeEngine(
  handler: (req: IncomingMessage, res: ServerResponse, body: string) => void,
  run: (endpoint: string) => Promise<void>,
): Promise<void> {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: { toString(): string }) => {
      body += chunk.toString();
    });
    req.on('end', () => handler(req, res, body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number } | null;
  assert(!!address, '假引擎应拿到端口');
  try {
    await run(`http://127.0.0.1:${address?.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/**
 * ⚠️ 本环境 `node:http` 的类型声明不全：`ServerResponse` 缺 `writeHead`（运行时存在）。
 * 按仓库既有做法做**局部断言**，而不是换一种写法绕开。
 */
interface RawResponse {
  writeHead(status: number, headers: Record<string, string>): void;
  end(body?: string): void;
}

const json = (res: ServerResponse, status: number, payload: unknown): void => {
  const raw = res as unknown as RawResponse;
  raw.writeHead(status, { 'Content-Type': 'application/json' });
  raw.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
};

/** 合法产出的形状（假引擎按它回答；具体内容各用例自己改） */
const goodResponse = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  api: CONTENT_ENGINE_API,
  engine: { id: 'fake-engine', kind: 'rules', version: '1' },
  judged: ['R-DEMO-01'],
  findings: [
    {
      ruleId: 'R-DEMO-01',
      nodeId: 'n_a',
      severity: 'info',
      title: '未给出鉴别依据',
      rationale: '提到了鉴别诊断但没写依据',
      quote: '需与肺结核鉴别',
    },
  ],
  ...overrides,
});

async function main(): Promise<void> {
  await test('H1 明文 HTTP 只允许本机：非本机的明文地址在**构造期**就被拒', () => {
    let code = '';
    try {
      createHttpContentEngine({ endpoint: 'http://qc.example.com/analyze' });
    } catch (err) {
      code = (err as Error).message;
    }
    assert(code.includes('明文 HTTP'), `非本机明文必须被拒，实际：${code}`);
    assert(code.includes('病历内容'), `理由要说清"这一步会把病历内容发出去"，实际：${code}`);
    assert(code.includes('https://'), '要给出可行的改法（改 https 或部署在本机）');

    /* 本机明文、以及任意 https 都允许（前者是开发/内网自测的常态，后者是生产的常态） */
    assert(!!createHttpContentEngine({ endpoint: 'http://127.0.0.1:9/x' }), '本机明文应允许');
    assert(!!createHttpContentEngine({ endpoint: 'http://localhost:9/x' }), 'localhost 视同本机');
    assert(!!createHttpContentEngine({ endpoint: 'https://qc.example.com/x' }), 'https 应允许');

    let bad = '';
    try {
      createHttpContentEngine({ endpoint: '不是地址' });
    } catch (err) {
      bad = (err as Error).message;
    }
    assert(bad.includes('不是合法 URL'), `非法地址要明确报错，实际：${bad}`);
  });

  await test('H2 正常一次调用：请求按契约发出，产出**原样**交回（传输层不修补）', async () => {
    let seenBody = '';
    let seenAuth: string | undefined;
    await withFakeEngine(
      (req, res, body) => {
        seenBody = body;
        /* 头可能是 string 或 string[]（本环境声明如此）：断言只关心值，故统一成字符串 */
        const auth = req.headers.authorization;
        seenAuth = Array.isArray(auth) ? auth.join(',') : auth;
        json(res, 200, goodResponse());
      },
      async (endpoint) => {
        const engine = createHttpContentEngine({ endpoint, token: 'secret-token', expectEngineId: 'fake-engine' });
        const request = sampleRequest();
        const produced = await engine.run(request, { timeoutMs: 3000 });
        /* 传输层交回的是**原始产出**：校验在调用方（这条分工是刻意的） */
        const validated = validateEngineOutput(produced, request);
        assertEqual(validated.ok, true, `合法产出应通过校验：${validated.ok ? '' : validated.message}`);
        assertEqual(validated.ok ? validated.findings.length : -1, 1, '一条发现');

        const sent = JSON.parse(seenBody) as { api: string; nodes: Array<{ nodeId: string }>; rules: unknown[] };
        assertEqual(sent.api, CONTENT_ENGINE_API, '请求要带契约版本');
        assertEqual(sent.nodes[0]?.nodeId, 'n_a', '请求里带着要判的节点');
        assertEqual(sent.rules.length, 1, '请求里只带**允许使用**的规则清单');
        assertEqual(seenAuth, 'Bearer secret-token', '配了令牌就带 Authorization');
      },
    );
  });

  await test('H3 非 200：报出状态码并把响应体截一段（否则现场只有"HTTP 500"无从排查）', async () => {
    await withFakeEngine(
      (_req, res) => json(res, 500, '引擎内部错误：模型未加载'),
      async (endpoint) => {
        const engine = createHttpContentEngine({ endpoint, timeoutMs: 3000 });
        let message = '';
        try {
          await engine.run(sampleRequest(), { timeoutMs: 3000 });
        } catch (err) {
          message = (err as Error).message;
        }
        assert(message.includes('HTTP 500'), `要报状态码，实际：${message}`);
        assert(message.includes('模型未加载'), `要带一小段响应体，实际：${message}`);
      },
    );
  });

  await test('H4 响应不是 JSON → 明确报错（截断的 JSON 解析失败也要说清）', async () => {
    await withFakeEngine(
      (_req, res) => json(res, 200, '<html>502 Bad Gateway</html>'),
      async (endpoint) => {
        const engine = createHttpContentEngine({ endpoint, timeoutMs: 3000 });
        let message = '';
        try {
          await engine.run(sampleRequest(), { timeoutMs: 3000 });
        } catch (err) {
          message = (err as Error).message;
        }
        assert(message.includes('不是合法 JSON'), `要说明是 JSON 解析失败，实际：${message}`);
      },
    );
  });

  await test('H5 超时：到点就断，不无限等（质控是"跑一次给人看"的动作）', async () => {
    await withFakeEngine(
      (_req, res) => {
        setTimeout(() => json(res, 200, goodResponse()), 400);
      },
      async (endpoint) => {
        const engine = createHttpContentEngine({ endpoint, timeoutMs: 120 });
        let failed = false;
        try {
          await engine.run(sampleRequest(), { timeoutMs: 120 });
        } catch {
          failed = true;
        }
        assertEqual(failed, true, '超时必须抛错（调用方据此报"未判定"，绝不能当"没问题"）');
      },
    );
  });

  await test('H6 响应过大 → 拒绝解析（失控的引擎不该把内存吃光）', async () => {
    await withFakeEngine(
      (_req, res) => json(res, 200, JSON.stringify({ ...goodResponse(), padding: 'x'.repeat(2000) })),
      async (endpoint) => {
        const engine = createHttpContentEngine({ endpoint, timeoutMs: 3000, maxResponseBytes: 500 });
        let message = '';
        try {
          await engine.run(sampleRequest(), { timeoutMs: 3000 });
        } catch (err) {
          message = (err as Error).message;
        }
        assert(message.includes('响应过大'), `要明确说"过大"，实际：${message}`);
      },
    );
  });

  await test('H7 引擎自称的 id 与配置不符 → 拒绝（判定标准换了必须看得出来）', async () => {
    await withFakeEngine(
      (_req, res) => json(res, 200, goodResponse({ engine: { id: '另一个引擎', kind: 'rules', version: '1' } })),
      async (endpoint) => {
        const engine = createHttpContentEngine({ endpoint, expectEngineId: 'fake-engine', timeoutMs: 3000 });
        let message = '';
        try {
          await engine.run(sampleRequest(), { timeoutMs: 3000 });
        } catch (err) {
          message = (err as Error).message;
        }
        assert(message.includes('不一致'), `要报"不一致"，实际：${message}`);
        assert(message.includes('判定标准换了'), `要说清为什么不能放过，实际：${message}`);
      },
    );
  });

  await test('H8 端到端分工：传输层不修补，**夹带建议的被整份拒、引文幻觉的被逐条丢**', async () => {
    /* 两条坏引擎，走**同一条真实通路**（HTTP → 传输层 → 校验）。 */
    await withFakeEngine(
      (_req, res) =>
        json(
          res,
          200,
          goodResponse({
            findings: [
              {
                ruleId: 'R-DEMO-01',
                nodeId: 'n_a',
                severity: 'info',
                title: '未给出鉴别依据',
                rationale: '提到了鉴别诊断但没写依据',
                quote: '需与肺结核鉴别',
                /* ← 想夹带一条"可落笔的建议"。它**过不了类型**，但类型过不了 JSON，
                   所以真正拦住它的是运行时校验。 */
                suggestion: '建议补充：结核接触史阴性、PPD 阴性。',
              },
            ],
          }),
        ),
      async (endpoint) => {
        const engine = createHttpContentEngine({ endpoint, timeoutMs: 3000 });
        const request = sampleRequest();
        const produced = await engine.run(request, { timeoutMs: 3000 });
        const validated = validateEngineOutput(produced, request);
        assertEqual(validated.ok, false, '夹带建议的产出必须**整份拒绝**');
        assertEqual(
          validated.ok ? '' : validated.code,
          CONTENT_ENGINE_ERRORS.E_QC_ENGINE_FORBIDDEN_FIELD,
          '要给专门的错误码（不是笼统的"字段不认识"）',
        );
      },
    );

    await withFakeEngine(
      (_req, res) =>
        json(
          res,
          200,
          goodResponse({
            findings: [
              {
                ruleId: 'R-DEMO-01',
                nodeId: 'n_a',
                severity: 'info',
                title: '引文对不上',
                rationale: '这条引了一句文档里没有的话',
                quote: '患者有肺结核接触史',
              },
            ],
          }),
        ),
      async (endpoint) => {
        const engine = createHttpContentEngine({ endpoint, timeoutMs: 3000 });
        const request = sampleRequest();
        const produced = (await engine.run(request, { timeoutMs: 3000 })) as ContentQcResponse;
        const validated = validateEngineOutput(produced, request);
        assertEqual(validated.ok, true, '整份保留（一条坏的不该废掉整份）');
        assertEqual(validated.ok ? validated.findings.length : -1, 0, '引文对不上的必须被丢弃');
        assertEqual(
          validated.ok ? validated.rejected[0]?.code : '',
          CONTENT_ENGINE_ERRORS.E_QC_FINDING_BAD_CITATION,
          '丢弃理由要是"引文找不到"',
        );
      },
    );
  });

  const code = suite.report();
  process.exit(code);
}

void main();
