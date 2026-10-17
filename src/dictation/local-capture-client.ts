/**
 * 本地采集客户端（C3b③）：在医生这台机器上跑的小进程 —— **采音频、分片，把段交给页面**。
 *
 * ## 它为什么存在
 *
 * `http://10.x` 下浏览器**拿不到麦克风**（不是权限问题，是安全上下文问题，前端无法绕过）。
 * 而**本机进程没有这个限制**。于是把"采 + 分片"搬到这里，页面只做两件事：
 * 把段取过来、上传给同源采集路由（由服务端转发 ASR）。完整形态与理由见
 * `docs/L2-语音采集设计.md` 第九之三节。
 *
 * ```
 *   本进程：麦克风 → 帧 ──► createChunkAssembler（与页面/服务端同一份分片规则）──► 段队列
 *                                                                                  │
 *                    页面 ──GET /next──► 取段 ──GET /audio/{i}──► WAV
 *                         ──POST 同源 /api/dictation/capture/segment──► 服务端转发 ASR
 *                         ──POST /ack {ok}──► 客户端推进队列（成或败都要回来说一声）
 * ```
 *
 * ## 用法
 *
 * ```
 * node src/dictation/local-capture-client.ts --port 8901 --token <一次性令牌> [--page <服务端页面地址>]
 * ```
 *
 * 令牌由运维/装机脚本给出（没给就**拒绝启动**：没有令牌的回环端口等于对全机开放）。
 * 客户端会把"带令牌的页面地址"打印出来 —— 页面就是靠 URL 里的 `captureClient` / `captureToken`
 * 知道"本机有客户端、且我能连上它"的。
 *
 * ## 三条纪律
 *
 * 1) **只绑 `127.0.0.1`**：绑 `0.0.0.0` 等于把"谁能采你的麦克风"交给整个内网；
 * 2) **只认令牌**，且令牌错时回 **401**（页面据此区分"客户端不在"与"令牌不对"——处置完全不同）；
 * 3) **源失败要带回页面**：采集源自己炸了（设备被占用等）也要让页面看到"现场表现 + 怎么办"，
 *    不能表现成"没有段"（那看起来像"医生什么都没说"）。
 *
 * ## 诚实边界
 *
 * **本进程没有真实麦克风实现**：Node 没有 `getUserMedia`，真采要桌面壳的原生能力（属 K10）。
 * 现在这一版用的是**脚本音频源**（`createSampleCaptureSource`），于是"采 → 分片 → 交段 → 上传 →
 * 建议"这条链今天就能被真的跑一遍；真实采集接在 `createClientCaptureSource()` 这**一个函数**里。
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { createCaptureBridge, checkBridgeToken, tokenFromRequest, type CaptureBridge } from './capture-bridge.ts';
import { createSampleCaptureSource, type CaptureSource } from './capture-source.ts';
import { CaptureError, validateCaptureConfig, type SegmentConfig } from './capture.ts';

const PREFIX = '/dictation-capture';

/**
 * 演示脚本：两段人声各 2s + 中间 1.2s 静音 → 2 段。
 *
 * 与 demo 服务端那份默认脚本同形：它存在的意义是让"客户端这条链"今天就能跑通与被测，
 * 而不是让演示看起来更花哨（时长 5s 左右，计时是**真的在走**）。
 */
const DEFAULT_TIMELINE: Array<{ seconds: number; voiced: boolean }> = [
  { seconds: 2, voiced: true },
  { seconds: 1.2, voiced: false },
  { seconds: 2, voiced: true },
];

function argOf(argv: string[], name: string, fallback = ''): string {
  const at = argv.indexOf(`--${name}`);
  if (at === -1) return fallback;
  return argv[at + 1] ?? fallback;
}

/**
 * 采集源：**真实麦克风就接在这里**。
 *
 * 桌面壳（Electron 主进程 / Tauri / 原生）能用系统麦克风拿到 PCM 帧，于是只要在这里
 * 换成一个实现了 `CaptureSource` 的源，**下面整条链一行都不用改**。
 * Node 本身没有麦克风 API —— 这也是为什么"真实采集"这件事属于宿主形态（K10）而不是本进程。
 */
function createClientCaptureSource(): CaptureSource {
  return createSampleCaptureSource({ timeline: DEFAULT_TIMELINE });
}

/** 页面转交过来的分片参数：值来自服务端配置，这里**复用同一份校验**（不合法就报错，不取默认） */
function parseSegment(raw: unknown): SegmentConfig {
  const input = (raw ?? {}) as { silenceMs?: unknown; maxSeconds?: unknown; minSeconds?: unknown };
  return validateCaptureConfig({
    segment: {
      ...(input.silenceMs === undefined ? {} : { silenceMs: Number(input.silenceMs) }),
      ...(input.maxSeconds === undefined ? {} : { maxSeconds: Number(input.maxSeconds) }),
      ...(input.minSeconds === undefined ? {} : { minSeconds: Number(input.minSeconds) }),
    },
  }).segment;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded) return;
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  /* 回环 + 令牌：CORS 放开到 * 是够的（令牌才是把关的东西），否则页面（另一个 origin）根本连不上 */
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, x-capture-token');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Uint8Array[] = [];
  await new Promise<void>((resolve) => {
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve());
  });
  const text = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
  if (text.trim() === '') return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    throw new CaptureError('E_CAPTURE_BAD_SEGMENTS', '桥的请求体不是合法 JSON');
  }
}

export interface LocalClientRuntime {
  /** 本次采集的桥；没有正在进行的采集时为 `null` */
  bridge(): CaptureBridge | null;
  /** 采集源自身的失败（现场表现 + 怎么办），由 `hello` 带给页面 */
  sourceProblem(): { code: string; message: string; howTo: string } | null;
  start(segment: SegmentConfig): { ok: true; sessionId: string } | { ok: false; code: string; message: string };
  stop(): Promise<void>;
  /** 采集驱动是否已收尾（自测用） */
  settle(): Promise<void>;
}

/** 采集驱动：把源送来的帧喂给桥，源结束后把桥收尾 */
export function createLocalClientRuntime(options: { sourceFactory?: () => CaptureSource } = {}): LocalClientRuntime {
  const sourceFactory = options.sourceFactory ?? createClientCaptureSource;
  let bridge: CaptureBridge | null = null;
  let source: CaptureSource | null = null;
  let collecting: Promise<void> | null = null;
  let problem: { code: string; message: string; howTo: string } | null = null;

  return {
    bridge: () => bridge,
    sourceProblem: () => problem,
    start(segment) {
      if (collecting !== null) {
        return { ok: false, code: 'E_BRIDGE_ALREADY_RUNNING', message: '已经在采集了：先按停止，再重新开始' };
      }
      const sessionId = `client-capture-${Date.now()}`;
      const next = createCaptureBridge({ sessionId, segment });
      const next2 = sourceFactory();
      bridge = next;
      source = next2;
      problem = null;
      collecting = (async () => {
        let elapsed = 0;
        try {
          await next2.start((frame) => {
            elapsed = frame.endSec;
            next.feed(frame);
          });
        } catch (err) {
          /* 源自己的失败：记下来带给页面（**不表现成"没有段"** —— 那看起来像医生什么都没说） */
          problem = {
            code: (err as { code?: string }).code ?? 'E_CAPTURE_SOURCE_UNKNOWN',
            message: (err as Error).message,
            howTo: (err as { howTo?: string }).howTo ?? '重试一次；仍然失败请把这条错误报给运维',
          };
        } finally {
          next.finish(elapsed);
        }
      })().finally(() => {
        /* **收尾后必须放开**：不放开的话，第二次采集会被判成"已经在采"
           （实测踩到：医生点第二次开始，界面报"已经在采集了"，而它其实早就停了）。 */
        collecting = null;
      });
      return { ok: true, sessionId };
    },
    async stop() {
      await source?.stop();
      await collecting;
    },
    async settle() {
      await collecting;
    },
  };
}

export function createLocalClientServer(options: { token: string; runtime?: LocalClientRuntime; pageUrl?: string }) {
  const runtime = options.runtime ?? createLocalClientRuntime();
  const token = options.token;

  return createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const path = url.pathname;
      if (!path.startsWith(PREFIX)) {
        json(res, 404, { ok: false, code: 'E_BRIDGE_NO_ROUTE', message: `只服务 ${PREFIX}/*：本进程不是 Web 服务，别拿它当服务端用` });
        return;
      }
      /* 预检不校验令牌：浏览器不会在预检里带自定义头，拦它等于所有跨源请求都失败 */
      if ((req.method ?? 'GET') === 'OPTIONS') {
        json(res, 204, {});
        return;
      }
      const header = req.headers['x-capture-token'];
      const provided = tokenFromRequest({
        header: Array.isArray(header) ? header[0] : header,
        query: url.searchParams.get('token') ?? undefined,
      });
      const checked = checkBridgeToken(token, provided);
      if (!checked.ok) {
        json(res, 401, { ok: false, code: checked.code, message: checked.message });
        return;
      }

      const action = path.slice(PREFIX.length);
      const method = req.method ?? 'GET';
      try {
        if (method === 'GET' && action === '/hello') {
          json(res, 200, {
            ok: true,
            client: 'l0-dictation-client',
            pageUrl: options.pageUrl ?? null,
            source: 'sample（脚本音频；真实麦克风尚未接入）',
            progress: runtime.bridge()?.progress() ?? null,
            sourceProblem: runtime.sourceProblem(),
          });
          return;
        }
        if (method === 'POST' && action === '/start') {
          const body = await readJsonBody(req);
          const started = runtime.start(parseSegment(body));
          json(res, 200, { ok: started.ok, ...(started.ok ? { sessionId: started.sessionId } : { code: started.code, message: started.message }) });
          return;
        }
        if (method === 'POST' && action === '/stop') {
          /* 读掉请求体（哪怕不看它）：不读会让连接上留一截没人要的字节 */
          await readJsonBody(req);
          await runtime.stop();
          json(res, 200, { ok: true, data: { stopped: true } });
          return;
        }
        if (method === 'GET' && action === '/next') {
          const next = runtime.bridge()?.next();
          if (!next) {
            json(res, 200, { ok: false, code: 'E_BRIDGE_NOT_STARTED', message: '还没有开始采集：请先按「开始采集」' });
            return;
          }
          json(res, 200, { ok: true, next });
          return;
        }
        if (method === 'POST' && action === '/ack') {
          const body = await readJsonBody(req);
          const index = Number(body.index);
          const okFlag = body.ok !== false;
          const code = typeof body.code === 'string' ? body.code : undefined;
          const message = typeof body.message === 'string' ? body.message : undefined;
          const current = runtime.bridge();
          if (!current) {
            json(res, 200, { ok: false, code: 'E_BRIDGE_NOT_STARTED', message: '还没有开始采集' });
            return;
          }
          const result = current.ack(index, okFlag, code !== undefined && message !== undefined ? { code, message } : undefined);
          json(res, 200, result.ok ? { ok: true, data: { delivered: result.delivered } } : { ok: false, code: result.code, message: result.message });
          return;
        }
        const audioMatch = /^\/audio\/(\d+)$/.exec(action);
        if (method === 'GET' && audioMatch) {
          const index = Number(audioMatch[1]);
          const bytes = runtime.bridge()?.audioOf(index) ?? null;
          if (bytes === null) {
            /* ack 之后音频就释放了（第九之三节第 4 条）：取不到不是错误，是"你已经处理过了" */
            json(res, 404, { ok: false, code: 'E_BRIDGE_AUDIO_RELEASED', message: `第 ${index} 段的音频不在了（可能已经确认过，或段号不对）` });
            return;
          }
          res.statusCode = 200;
          res.setHeader('Content-Type', 'audio/wav');
          res.setHeader('Content-Length', bytes.byteLength);
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.end(bytes);
          return;
        }
        json(res, 404, { ok: false, code: 'E_BRIDGE_NO_ROUTE', message: `不认识的桥端点：${method} ${action}` });
      } catch (err) {
        json(res, 200, {
          ok: false,
          code: (err as { code?: string }).code ?? 'E_BRIDGE_FAILED',
          message: (err as Error).message,
        });
      }
    })();
  });
}

/* ------------------------------ CLI ------------------------------ */

if (process.argv[1]?.includes('local-capture-client')) {
  const port = Number(argOf(process.argv, 'port', '8901'));
  const providedToken = argOf(process.argv, 'token');
  const pageUrl = argOf(process.argv, 'page');
  /* 令牌**没给就拒绝启动**：没有令牌的回环端口等于对全机开放（第九之三节） */
  const token = providedToken === '' ? randomBytes(16).toString('hex') : providedToken;
  const server = createLocalClientServer({ token, pageUrl });
  server.listen(port, '127.0.0.1', () => {
    const composed = `${pageUrl === '' ? 'http://<服务端地址>/' : pageUrl}?captureClient=127.0.0.1:${port}&captureToken=${token}`;
    process.stdout.write(`  本地采集客户端：只绑 127.0.0.1:${port}（音频不出本机，段由页面取走后再上传）\n`);
    process.stdout.write(`  采集源：脚本音频（真实麦克风属宿主形态，见 local-capture-client.ts 的诚实边界）\n`);
    process.stdout.write(`  页面地址（带着一次性令牌，用它打开医生端）：\n    ${composed}\n`);
    if (providedToken === '') process.stdout.write('  ⚠ 本次令牌是临时生成的：请用上面那条地址打开页面，否则页面连不上\n');
    process.stdout.write('  Ctrl+C 停止\n');
  });
}
