// T22 验收自测：契约 HTTP 服务端。

import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TestSuite, assert, assertEqual } from '../testing/harness.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PORT = 8802;
const BASE = `http://127.0.0.1:${PORT}`;
const CHECKER = join(ROOT, 'tools', 'model-check', 'ai-path-check.mjs');
const ADAPTER = join(ROOT, 'tools', 'model-check', 'lib', 'http-store-adapter.mjs');

const suite = new TestSuite('T22 契约 HTTP 服务端自测', [
  '说明：B 部分是"用工具链的同一套 26 条契约直连本服务"，与内存参考实现结论必须一致。',
  '该命令即验收表里 T22 的验收命令，本套用例把它固化下来，改动服务端即回归。',
]);

const test = (name: string, fn: () => void | Promise<void>): Promise<void> => suite.test(name, fn);

const HUMAN = { id: 'DR_T', kind: 'human' };
const AI = { id: 'ai-pipeline', kind: 'ai' };

interface HttpResult {
  status: number;
  body: Record<string, unknown>;
  /** 响应头：身份模式（x-l0-auth-mode / x-l0-actor-verified）等诊断信息在这里 */
  headers: Record<string, string>;
}

let child: { kill(signal?: string): boolean } | null = null;

async function call(
  method: string,
  path: string,
  options: { body?: unknown; actor?: { id: string; kind: string }; headers?: Record<string, string>; base?: string } = {},
): Promise<HttpResult> {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(options.headers ?? {}) };
  if (options.actor) {
    headers['X-Actor-Id'] = options.actor.id;
    headers['X-Actor-Kind'] = options.actor.kind;
  }
  const res = await fetch(`${options.base ?? BASE}${path}`, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    body = { _raw: text };
  }
  return {
    status: res.status,
    body,
    headers: {
      'x-l0-auth-mode': res.headers.get('x-l0-auth-mode') ?? '',
      'x-l0-actor-verified': res.headers.get('x-l0-actor-verified') ?? '',
    },
  };
}

function baseDoc(docId = 'doc_http_001') {
  const at = '2026-10-08T01:00:00Z';
  const prov = (origin: string, actorId: string) => ({ origin, actorId, at });
  return {
    schemaVersion: '1.0.0',
    docId,
    docType: { system: 'WST500', code: 'WST500.2', display: '门（急）诊病历' },
    patient: { patientId: 'P9001', nameMasked: '张**', gender: 'M' },
    status: 'draft',
    createdAt: at,
    updatedAt: at,
    createdBy: 'DR_T',
    rootId: 'n_root',
    nodes: {
      n_root: { id: 'n_root', type: 'document', parentId: null, order: 0, rev: 1, provenance: prov('system', 'seed') },
      n_p: { id: 'n_p', type: 'paragraph', parentId: 'n_root', order: 10, rev: 1, provenance: prov('human', 'DR_T') },
      n_t: { id: 'n_t', type: 'text', parentId: 'n_p', order: 10, rev: 1, runs: [{ text: '原始文本' }], provenance: prov('human', 'DR_T') },
      n_f: {
        id: 'n_f',
        type: 'field',
        parentId: 'n_p',
        order: 20,
        rev: 1,
        dataType: 'number',
        value: 37,
        valueText: '37',
        unit: '℃',
        keyContent: true,
        tags: [{ system: 'WS445', code: 'DE05.01.001', display: '体温' }],
        provenance: prov('system', 'system/lis'),
      },
    },
    revisions: [],
  };
}

async function createDoc(docId?: string): Promise<string> {
  const res = await call('POST', '/documents', { body: { doc: baseDoc(docId) } });
  assertEqual(res.status, 201, `建文档应返回 201，实际 ${res.status}：${JSON.stringify(res.body)}`);
  return String(res.body.docId);
}

/** 读回文档（状态机用例要盯的是 `status` 这个字段） */
async function docOf(docId: string): Promise<{ status: string }> {
  const res = await call('GET', `/documents/${docId}`);
  return res.body.doc as { status: string };
}

async function startServer(): Promise<void> {
  const spawned = spawn(process.execPath, ['src/server/contract-server.ts', '--port', String(PORT)], { cwd: ROOT, stdio: 'pipe' });
  child = spawned;
  spawned.stdout?.on('data', () => {});
  spawned.stderr?.on('data', () => {});
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/documents/__probe__`);
      if (res.status === 404 || res.status === 200) return;
    } catch {
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  spawned.kill();
  throw new Error('契约服务端启动超时（15s）');
}

/* ---------------- verified 模式实例（身份收口用例专用） ---------------- */

const VERIFIED_PORT = 8803;
const VERIFIED_BASE = `http://127.0.0.1:${VERIFIED_PORT}`;
/* 凭证只出现在测试与启动参数里；服务端内部只保留 SM3 指纹 */
const HUMAN_TOKEN = 'tok-human-wang';
const AI_TOKEN = 'tok-ai-pipeline';

async function startVerifiedServer(): Promise<{ kill(): void }> {
  const spawned = spawn(
    process.execPath,
    [
      'src/server/contract-server.ts',
      '--port',
      String(VERIFIED_PORT),
      '--auth-mode',
      'verified',
      '--actor',
      `${HUMAN_TOKEN}:DR_WANG:human:门诊医生工作站`,
      '--actor',
      `${AI_TOKEN}:ai-pipeline:ai:病历生成流水线`,
    ],
    { cwd: ROOT, stdio: 'pipe' },
  );
  spawned.stdout?.on('data', () => {});
  spawned.stderr?.on('data', () => {});
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${VERIFIED_BASE}/health`);
      if (res.ok) return spawned;
    } catch {
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  spawned.kill();
  throw new Error('verified 模式服务端启动超时（15s）');
}

async function main(): Promise<void> {
  await startServer();

  /* ===================== A 协议层契约（直打 HTTP） ===================== */

  await test('A1 建文档：201 + 返回 docId；初始状态被归一化为新草稿并带新鲜机读块', async () => {
    const docId = await createDoc();
    const res = await call('GET', `/documents/${docId}`);
    assertEqual(res.status, 200, '读文档应 200');
    const doc = res.body.doc as Record<string, unknown>;
    assertEqual(doc.status, 'draft', '无论提交什么状态，一律视为草稿');
    const revisions = doc.revisions as unknown[];
    assertEqual(revisions.length, 1, '留痕应重置为一条 create（保证 rev 连续）');
    const machine = doc.machineReadable as { dataElements: Array<{ nodeId: string }> } | undefined;
    assert(!!machine && machine.dataElements.length > 0, '建文档即派生机读块（否则"陈旧拒绝"用例无从触发）');
    assert(machine.dataElements.some((de) => de.nodeId === 'n_f'), '机读块应覆盖带标签字段');
  });

  await test('A2 身份：缺少 X-Actor-* 请求头 → 400 E_ACTOR_REQUIRED', async () => {
    const docId = await createDoc();
    const res = await call('POST', `/documents/${docId}/commands`, { body: { op: 'insertText', params: { nodeId: 'n_t', text: 'x' } } });
    assertEqual(res.status, 400, '缺身份应 400');
    assertEqual(res.body.code, 'E_ACTOR_REQUIRED', '错误码应为 E_ACTOR_REQUIRED');
  });

  await test('A3 路由：未知路径 404 E_ROUTE_NOT_FOUND；未知 op 400 E_UNKNOWN_OP', async () => {
    const notFound = await call('GET', '/documents/x/不存在');
    assertEqual(notFound.status, 404, '未知路径应 404');
    assertEqual(notFound.body.code, 'E_ROUTE_NOT_FOUND', '错误码应为 E_ROUTE_NOT_FOUND');

    const docId = await createDoc();
    const unknownOp = await call('POST', `/documents/${docId}/commands`, { body: { op: 'flyToMoon', params: {} }, actor: HUMAN });
    assertEqual(unknownOp.status, 400, '未知 op 应 400');
    assertEqual(unknownOp.body.code, 'E_UNKNOWN_OP', '错误码应为 E_UNKNOWN_OP');
  });

  await test('A4 错误码 → HTTP 状态码映射（门控类 403 / 冲突类 409 / 业务拒绝 422 / 找不到 404）', async () => {
    const docId = await createDoc();
    const cases: Array<{ label: string; expected: number; run: () => Promise<HttpResult> }> = [
      {
        label: 'AI 直接写 → 403',
        expected: 403,
        run: () => call('POST', `/documents/${docId}/commands`, { body: { op: 'insertText', params: { nodeId: 'n_t', text: 'x' } }, actor: AI }),
      },
      {
        label: '乐观锁过期 → 409',
        expected: 409,
        run: () => call('POST', `/documents/${docId}/commands`, { body: { op: 'insertText', params: { nodeId: 'n_t', text: 'x' }, expectedRev: 0 }, actor: HUMAN }),
      },
      {
        label: '关键内容未确认签章 → 422',
        expected: 422,
        run: () => call('POST', `/documents/${docId}/commands`, { body: { op: 'sign', params: {} }, actor: HUMAN }),
      },
      { label: '节点不存在 → 404', expected: 404, run: () => call('GET', `/documents/${docId}/nodes/n_missing`) },
      { label: '文档不存在 → 404', expected: 404, run: () => call('GET', '/documents/doc_not_exists') },
      { label: '建议不存在 → 404', expected: 404, run: () => call('POST', `/documents/${docId}/suggestions/sg_9999/accept`, { body: {}, actor: HUMAN }) },
    ];
    for (const item of cases) {
      const res = await item.run();
      assertEqual(res.status, item.expected, `${item.label}（实际 ${res.status} ${JSON.stringify(res.body)}）`);
      assert(typeof res.body.code === 'string', `${item.label}：响应体必须带 code`);
    }
  });

  await test('A5 文档隔离：同一 docId 二次提交会被分配新 id，两份文档互不影响', async () => {
    const first = await createDoc('doc_dup_001');
    const second = await createDoc('doc_dup_001');
    assert(first !== second, `同一 docId 二次提交应换新 id，实际都是 ${first}`);
    await call('POST', `/documents/${first}/commands`, { body: { op: 'insertText', params: { nodeId: 'n_t', text: '只改第一份' } }, actor: HUMAN });
    const untouched = await call('GET', `/documents/${second}/nodes/n_t`);
    const node = untouched.body.node as { runs: Array<{ text: string }> };
    assertEqual(node.runs[0]?.text, '原始文本', '第二份文档不应被第一份的写入影响');
  });

  await test('A6 读接口：audit 支持过滤、metrics 与 suggestions 形状稳定', async () => {
    const docId = await createDoc();
    await call('POST', `/documents/${docId}/commands`, { body: { op: 'insertText', params: { nodeId: 'n_t', text: '写入一次' } }, actor: HUMAN });
    const audit = await call('GET', `/documents/${docId}/audit?op=insert`);
    const items = audit.body.items as Array<{ op: string }>;
    assertEqual(items.length, 1, '按 op 过滤应命中一条');
    assertEqual(items[0]?.op, 'insert', 'op 应为 insert');

    const metrics = await call('GET', `/documents/${docId}/metrics`);
    const m = metrics.body.metrics as Record<string, number>;
    for (const key of ['suggested', 'accepted', 'rejected', 'modified', 'adoptionRate', 'editRate', 'rejectRate']) {
      assert(typeof m[key] === 'number', `metrics 缺少数值字段：${key}`);
    }
    const suggestions = await call('GET', `/documents/${docId}/suggestions?status=pending`);
    assert(Array.isArray(suggestions.body.items), 'suggestions 应返回 items 数组');
  });

  await test('A7 导出接口：成功时返回可判定摘要（不回传二进制，避免 JSON 体积爆炸）', async () => {
    const docId = await createDoc();
    const plan = { layout: { textAsPath: false }, machineReadable: { signed: true, carrier: 'separate-xml' } };
    const res = await call('POST', `/documents/${docId}/export/ofd`, { body: { plan } });
    assertEqual(res.status, 200, `导出应 200，实际 ${res.status}：${JSON.stringify(res.body)}`);
    const body = res.body as { entries?: string[]; pages?: number; stats?: { bytes?: number }; bytes?: unknown };
    assert(Array.isArray(body.entries) && body.entries.length > 0, '应返回文件清单');
    assert(typeof body.pages === 'number' && body.pages >= 1, '应返回页数');
    assert(!('bytes' in body), '不应把 Uint8Array 直接塞进 JSON');
    assert((body.stats?.bytes ?? 0) > 1000, '应给出真实字节数');

    const textAsPath = await call('POST', `/documents/${docId}/export/ofd`, { body: { plan: { ...plan, layout: { textAsPath: true } } } });
    assertEqual(textAsPath.status, 422, '路径化计划应 422');
    assertEqual(textAsPath.body.code, 'E_EXPORT_INVALID_PLAN', '错误码应为 E_EXPORT_INVALID_PLAN');
  });

  await test('A8 非法初始文档：400 E_BAD_DOC 并给出问题清单（参考实现不校验，这里收紧）', async () => {
    const broken = baseDoc('doc_bad_001');
    delete (broken.nodes as Record<string, unknown>).n_root;
    const res = await call('POST', '/documents', { body: { doc: broken } });
    assertEqual(res.status, 400, '非法文档应 400');
    assertEqual(res.body.code, 'E_BAD_DOC', '错误码应为 E_BAD_DOC');

    const noNodes = await call('POST', '/documents', { body: { doc: { docId: 'x' } } });
    assertEqual(noNodes.status, 400, '缺 nodes 应 400');
    assertEqual(noNodes.body.code, 'E_BAD_DOC', '错误码应为 E_BAD_DOC');
  });

  /* ================= B 端到端：同一套 26 条契约打本服务 ================= */

  await test('A9 审签状态机（K12）：送审 → 退回 → 改 → 通过 → 归档，每一步都在留痕里', async () => {
    const docId = await createDoc();
    const cmd = (op: string, params: Record<string, unknown> = {}, actor = HUMAN) =>
      call('POST', `/documents/${docId}/commands`, { body: { op, params }, actor });

    /* 逐条确认：契约层的文档里有一个关键内容字段，不确认就签不了 */
    const confirmed = await cmd('confirmNodes', { nodeIds: ['n_t', 'n_f'] });
    assertEqual(confirmed.status, 200, `逐条确认应成功：${JSON.stringify(confirmed.body)}`);

    const submitted = await cmd('submitForReview', { note: '请主任审核' });
    assertEqual(submitted.status, 200, `提交审核应成功：${JSON.stringify(submitted.body)}`);
    assertEqual((await docOf(docId)).status, 'reviewing', '提交后应为审核中');

    /* 审核中改内容 → 409（状态冲突，不是 400） */
    const frozen = await cmd('insertText', { nodeId: 'n_t', text: 'X' });
    assertEqual(frozen.status, 409, '审核中改内容应 409');
    assertEqual(frozen.body.code, 'E_REVIEWING_IMMUTABLE', '错误码应指向"审核中不可改"');

    /* 退回不给理由 → 422；给了理由 → 回到草稿 */
    const noNote = await cmd('review', { decision: 'reject' });
    assertEqual(noNote.status, 422, '退回不给理由应 422');
    assertEqual(noNote.body.code, 'E_REVIEW_NOTE_REQUIRED', '错误码应指向"理由必填"');

    const rejected = await cmd('review', { decision: 'reject', note: '主诉缺持续时间' });
    assertEqual(rejected.status, 200, `退回应成功：${JSON.stringify(rejected.body)}`);
    assertEqual((await docOf(docId)).status, 'draft', '退回后应回到草稿');

    await cmd('insertText', { nodeId: 'n_t', text: '；持续三天' });
    await cmd('confirmNodes', { nodeIds: ['n_t', 'n_f'] });
    await cmd('submitForReview', {});
    const approved = await cmd('review', { decision: 'approve' });
    assertEqual(approved.status, 200, `审核通过应成功：${JSON.stringify(approved.body)}`);
    assertEqual((await docOf(docId)).status, 'signed', '通过后应为已签章');

    const archived = await cmd('archiveDoc', {});
    assertEqual(archived.status, 200, `归档应成功：${JSON.stringify(archived.body)}`);
    assertEqual((await docOf(docId)).status, 'archived', '归档后应为终态');

    /* 留痕要把这条链还原出来 —— 状态和 HTTP 状态码都对了，留痕对不上照样不算数 */
    const audit = await call('GET', `/documents/${docId}/audit`);
    const items = audit.body.items as Array<{ op: string; review?: { decision: string; note?: string } }>;
    const flow = items.filter((item) => ['submit', 'review', 'archive'].includes(item.op));
    assertEqual(flow.map((item) => item.review?.decision ?? 'archive').join('>'), 'submit>reject>submit>approve>archive', '留痕应还原整条审签流');
    assertEqual(flow[1]?.review?.note, '主诉缺持续时间', '退回理由要在留痕里读得到');
  });

  await test('A10 作废：草稿可作废且是终态，已签章的不能直接作废', async () => {
    const docId = await createDoc();
    const voided = await call('POST', `/documents/${docId}/commands`, { body: { op: 'voidDoc', params: { reason: '患者未到诊' } }, actor: HUMAN });
    assertEqual(voided.status, 200, `作废应成功：${JSON.stringify(voided.body)}`);
    assertEqual((await docOf(docId)).status, 'void', '作废后应为 void');

    const after = await call('POST', `/documents/${docId}/commands`, { body: { op: 'insertText', params: { nodeId: 'n_t', text: 'X' } }, actor: HUMAN });
    assertEqual(after.status, 409, '作废后不得再改');
    assertEqual(after.body.code, 'E_DOC_VOID', '错误码应指向"已作废"');

    /* 已签章的文书要先解锁再作废：状态机不提供"绕过一次已生效签章"的通道 */
    const signedDoc = await createDoc();
    await call('POST', `/documents/${signedDoc}/commands`, { body: { op: 'confirmNodes', params: { nodeIds: ['n_t', 'n_f'] } }, actor: HUMAN });
    await call('POST', `/documents/${signedDoc}/commands`, { body: { op: 'sign', params: {} }, actor: HUMAN });
    const badVoid = await call('POST', `/documents/${signedDoc}/commands`, { body: { op: 'voidDoc', params: { reason: '想作废' } }, actor: HUMAN });
    assertEqual(badVoid.status, 409, '已签章的文书不能直接作废');
    assertEqual(badVoid.body.code, 'E_SIGNED_IMMUTABLE', '提示应指向"须先解锁"');
    assertEqual((await docOf(signedDoc)).status, 'signed', '被拒后状态不变');

    const unlocked = await call('POST', `/documents/${signedDoc}/commands`, { body: { op: 'unlock', params: { reason: '补既往史' } }, actor: HUMAN });
    assertEqual(unlocked.status, 200, '解锁应成功');
    const nowVoid = await call('POST', `/documents/${signedDoc}/commands`, { body: { op: 'voidDoc', params: { reason: '作废重开' } }, actor: HUMAN });
    assertEqual(nowVoid.status, 200, '解锁后可作废');
    assertEqual((await docOf(signedDoc)).status, 'void', '作废完成');
  });

  await test('A11 回到历史版本（K13）：内容回到那一版，且回滚自己占一条留痕', async () => {
    const docId = await createDoc();
    const cmd = (op: string, params: Record<string, unknown> = {}) => call('POST', `/documents/${docId}/commands`, { body: { op, params }, actor: HUMAN });

    /* 留痕：1 = 建文档（fixture 自带），2/3 = 两次插入 */
    await cmd('insertText', { nodeId: 'n_t', text: 'A' });
    await cmd('insertText', { nodeId: 'n_t', text: 'B' });
    const before = await docOf(docId);

    const reverted = await cmd('revertTo', { rev: 1 });
    assertEqual(reverted.status, 200, `回到第 1 版应成功：${JSON.stringify(reverted.body)}`);
    const after = await docOf(docId);
    assert(after !== before, '内容应回到那一版');
    assertEqual((await docOf(docId)).status, 'draft', '回滚不改文档状态（状态迁移有各自的动作）');

    const audit = await call('GET', `/documents/${docId}/audit`);
    const items = audit.body.items as Array<{ op: string; revertedTo?: { toRev: number; revertedRevs: number[] } }>;
    const last = items.at(-1);
    assertEqual(last?.op, 'revert', '回滚要单独留一条痕');
    assertEqual(last?.revertedTo?.toRev, 1, '回到哪一版要读得出来');
    assertEqual(JSON.stringify(last?.revertedTo?.revertedRevs ?? []), JSON.stringify([2, 3]), '被跨过的 rev 要记全');
    assertEqual(items.length, 4, '被回滚的那两条留痕仍在账上（历史只能追加）');

    /* 目标不合法：422，且语义明确 */
    for (const rev of [0, 99]) {
      const bad = await cmd('revertTo', { rev });
      assertEqual(bad.status, 422, `rev=${rev} 应被拒`);
      assertEqual(bad.body.code, 'E_REVERT_TARGET', '错误码应指向"目标不是已有版本"');
    }
  });

  await test('B1 工具链 S4 的 26 条契约直连本服务：26/26 全绿（T22 正式验收命令）', () => {
    const result = spawnSync(process.execPath, [CHECKER, '--adapter', ADAPTER, '--base-url', BASE], { cwd: ROOT, encoding: 'utf8' });
    const stdout = result.stdout ?? '';
    const failed = stdout
      .split('\n')
      .filter((line) => line.includes('FAIL'))
      .join(' | ');
    assertEqual(failed, '', `契约存在失败项：${failed}`);
    assertEqual(result.status, 0, `契约测试退出码应为 0，实际 ${result.status}`);
    assert(/用例数：26\s+通过：26\s+失败：0/.test(stdout), `26 条应全部通过，实际输出：\n${stdout.slice(-600)}`);
  });

  await test('B2 内存实现与 HTTP 实现结论一致（同一套用例、两种后端）', () => {
    const http = spawnSync(process.execPath, [CHECKER, '--adapter', ADAPTER, '--base-url', BASE], { cwd: ROOT, encoding: 'utf8' });
    const memory = spawnSync(process.execPath, [CHECKER], { cwd: ROOT, encoding: 'utf8' });
    const httpSummary = /用例数：26\s+通过：(\d+)    失败：(\d+)/.exec(http.stdout ?? '');
    const memorySummary = /用例数：26\s+通过：(\d+)    失败：(\d+)/.exec(memory.stdout ?? '');
    assert(!!httpSummary && !!memorySummary, '两次运行都应输出用例统计');
    assertEqual(httpSummary[1], memorySummary[1], 'HTTP 实现的通过数应与内存实现一致');
    assertEqual(httpSummary[2], memorySummary[2], 'HTTP 实现的失败数应与内存实现一致');
  });

  /* ================= D 身份收口（AI 门控的前置条件） =================
     这一组回答一个问题：门控建立在"调用方自报身份"之上时，它还算门控吗？
     结论是不算。因此下面的用例既固定"漏洞确实存在"（D2），
     也固定"收口之后漏洞确实被封住"（D3）。 */

  await test('D1 身份未验证必须显式可见：/health 与每次响应头都标注降级', async () => {
    const docId = await createDoc();
    const health = await call('GET', '/health');
    assertEqual(health.status, 200, '/health 应可匿名访问（供接入自助诊断）');
    assertEqual(health.body.authMode, 'trusted', '默认应为 trusted 模式');
    assertEqual(health.body.actorVerified, false, 'trusted 模式下必须自报"身份未验证"');
    assert(String(health.body.warning ?? '').includes('可被绕过'), '/health 必须明说"AI 门控在协议层可被绕过"');

    const res = await call('GET', `/documents/${docId}`);
    assertEqual(res.headers['x-l0-actor-verified'], 'false', '每一次响应都要带"身份未验证"标记');
    assertEqual(res.headers['x-l0-auth-mode'], 'trusted', '响应头应回显身份模式');
  });

  await test('D2 对照组：trusted 模式下 AI 自称 human 能直接写病历（这就是要修的问题）', async () => {
    const docId = await createDoc();
    const res = await call('POST', `/documents/${docId}/commands`, {
      actor: { id: 'ai-pipeline', kind: 'human' }, // ← 自称 human
      body: { op: 'insertText', params: { nodeId: 'n_t', text: 'AI 冒充医生写入' } },
    });
    assertEqual(res.status, 200, 'trusted 模式下这条写入会成功 —— 门控被协议层绕过（这正是必须收口的原因）');
  });

  await test('D3 verified 模式：身份由凭证决定，自称 human 的 AI 仍被拒（门控真正生效）', async () => {
    const server = await startVerifiedServer();
    try {
      const noToken = await call('POST', '/documents', { base: VERIFIED_BASE, body: { doc: baseDoc('doc_verified_1') } });
      assertEqual(noToken.status, 401, `verified 模式无凭证应 401，实际 ${noToken.status}`);
      assertEqual(noToken.body.code, 'E_ACTOR_UNVERIFIED', '错误码应为 E_ACTOR_UNVERIFIED');
      assertEqual(noToken.headers['x-l0-actor-verified'], 'true', '响应头应标注已启用验证模式');

      const badToken = await call('POST', '/documents', {
        base: VERIFIED_BASE,
        headers: { authorization: 'Bearer invalid-token-not-registered' },
        body: { doc: baseDoc('doc_verified_1') },
      });
      assertEqual(badToken.status, 401, '无效凭证应 401');

      const created = await call('POST', '/documents', {
        base: VERIFIED_BASE,
        headers: { authorization: `Bearer ${HUMAN_TOKEN}` },
        body: { doc: baseDoc('doc_verified_1') },
      });
      assertEqual(created.status, 201, `合法凭证应能建文档：${JSON.stringify(created.body)}`);
      const docId = String(created.body.docId);

      const spoof = await call('POST', `/documents/${docId}/commands`, {
        base: VERIFIED_BASE,
        headers: { authorization: `Bearer ${AI_TOKEN}` },
        actor: { id: 'DR_WANG', kind: 'human' }, // ← 冒充
        body: { op: 'insertText', params: { nodeId: 'n_t', text: 'AI 冒充医生写入' } },
      });
      assertEqual(spoof.status, 403, `身份来自凭证（ai），请求头自称 human 必须无效，实际 ${spoof.status}`);
      assertEqual(spoof.body.code, 'E_AI_DIRECT_WRITE_FORBIDDEN', 'AI 直写必须被拒 —— 这正是 trusted 模式丢掉的那道门');

      /* ⑤ 冒充尝试必须留证且可查询，而不是静默忽略 */
      const health = await call('GET', '/health', { base: VERIFIED_BASE });
      assertEqual(health.body.impersonationCount, 1, '冒充尝试应被计数');
      const attempt = (health.body.impersonationAttempts as Array<Record<string, unknown>>)[0] ?? {};
      assertEqual(attempt.claimedKind, 'human', '记录应含"自称的 kind"');
      assertEqual(attempt.actualKind, 'ai', '记录应含凭证真实的 kind');
      assert(!JSON.stringify(attempt).includes(AI_TOKEN), '记录里绝不能出现凭证本身');

      /* ⑥ 同一凭证的合法使用不受影响 */
      const read = await call('GET', `/documents/${docId}`, {
        base: VERIFIED_BASE,
        headers: { authorization: `Bearer ${HUMAN_TOKEN}` },
      });
      assertEqual(read.status, 200, '合法凭证读文档应正常');
    } finally {
      server.kill();
    }
  });

  await test('D4 AI 上下文取数接口：范围必填、默认脱敏、身份必填', async () => {
    const docId = await createDoc();

    const noScope = await call('GET', `/documents/${docId}/ai-context`, { actor: HUMAN });
    assertEqual(noScope.status, 400, `不传范围应 400，实际 ${noScope.status}`);
    assertEqual(noScope.body.code, 'E_AI_CONTEXT_SCOPE_REQUIRED', '错误码应为 E_AI_CONTEXT_SCOPE_REQUIRED');

    const noActor = await call('GET', `/documents/${docId}/ai-context?nodeId=n_t`);
    assertEqual(noActor.status, 400, '取数不传身份应 400');
    assertEqual(noActor.body.code, 'E_ACTOR_REQUIRED', '错误码应为 E_ACTOR_REQUIRED');

    const ok = await call('GET', `/documents/${docId}/ai-context?nodeId=n_t&contextBefore=1`, { actor: AI });
    assertEqual(ok.status, 200, `取上下文应 200：${JSON.stringify(ok.body)}`);
    assertEqual(ok.body.patient, undefined, '默认不得带患者标识');
    assert(!JSON.stringify(ok.body).includes('P9001'), '包内不得出现 patientId');
    const items = ok.body.items as Array<{ nodeId: string; role: string }>;
    assert(items.some((item) => item.role === 'target'), '应含目标条目');
    assertEqual(ok.headers['x-l0-actor-verified'], 'false', '响应头仍应标注"身份未验证"（trusted 模式）');

    const withPatient = await call('GET', `/documents/${docId}/ai-context?nodeId=n_t&includePatient=true`, { actor: AI });
    const patient = withPatient.body.patient as { nameMasked?: string } | undefined;
    assertEqual(patient?.nameMasked, '张**', '患者姓名应为掩码');
    assert(!JSON.stringify(withPatient.body).includes('P9001'), '即使显式要求也不得出现 patientId');

    /* ⑤ 目标不存在 → 404（资源问题，而非调用方参数错误） */
    const missing = await call('GET', `/documents/${docId}/ai-context?nodeId=n_not_exist`, { actor: AI });
    assertEqual(missing.status, 404, `目标不存在应 404，实际 ${missing.status}`);
    assertEqual(missing.body.code, 'E_AI_CONTEXT_EMPTY', '错误码应为 E_AI_CONTEXT_EMPTY');
  });

  if (child) child.kill();
  process.exit(suite.report());
}

void main();
