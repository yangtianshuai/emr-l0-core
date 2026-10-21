#!/usr/bin/env node

import { createServer } from 'node:http';
import { ContractError, createStore, ERR } from './doc-store.mjs';

const STATUS_BY_CODE = {
  [ERR.E_AI_DIRECT_WRITE_FORBIDDEN]: 403,
  [ERR.E_AI_NOT_ALLOWED]: 403,
  [ERR.E_REV_CONFLICT]: 409,
  [ERR.E_SIGNED_IMMUTABLE]: 409,
  [ERR.E_SUGGESTION_STATE]: 409,
  [ERR.E_AI_LOW_CONFIDENCE]: 422,
  [ERR.E_KEY_CONTENT_UNCONFIRMED]: 422,
  [ERR.E_KEY_CONTENT_PROTECTED]: 422,
  [ERR.E_SIGNED_WITH_UNCONFIRMED_AI]: 422,
  [ERR.E_IMPORTED_UNCONFIRMED]: 422,
  [ERR.E_MACHINE_READABLE_STALE]: 422,
  [ERR.E_EXPORT_INVALID_PLAN]: 422,
  [ERR.E_AI_NO_PROVENANCE]: 422,
  [ERR.E_NODE_NOT_FOUND]: 404,
  [ERR.E_SUGGESTION_NOT_FOUND]: 404,
  [ERR.E_TYPE_MISMATCH]: 400,
};

function send(res, status, body) {
  const text = JSON.stringify(body ?? {});
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 10_000_000) reject(new Error('请求体过大'));
    });
    req.on('end', () => {
      if (!raw) resolve({});
      else {
        try {
          resolve(JSON.parse(raw));
        } catch (err) {
          reject(err);
        }
      }
    });
    req.on('error', reject);
  });
}

function actorFrom(req) {
  const id = req.headers['x-actor-id'];
  const kind = req.headers['x-actor-kind'];
  if (!id || !kind) throw new ContractError('E_ACTOR_REQUIRED', '缺少 X-Actor-Id / X-Actor-Kind 请求头');
  return { id: String(id), kind: String(kind) };
}

export function createReferenceServer(options = {}) {
  const stores = new Map();
  let seq = 0;

  // 必须把 url 一并转发：需要查询串的路由（audit / suggestions 列表）依赖第 4 个参数
  const wrap = (fn) => async (req, res, params, url) => {
    try {
      const body = await fn(req, res, params, url);
      if (!res.writableEnded) send(res, body?.status || 200, body?.payload ?? body);
    } catch (err) {
      if (err instanceof ContractError) {
        send(res, STATUS_BY_CODE[err.code] || 400, { code: err.code, message: err.message, ...(err.extra ? { extra: err.extra } : {}) });
      } else {
        send(res, 500, { code: 'E_INTERNAL', message: err.message });
      }
    }
  };

  const routes = [
    {
      method: 'POST',
      pattern: /^\/documents$/,
      handler: wrap(async (req) => {
        const { doc } = await readBody(req);
        if (!doc || !doc.nodes) throw new ContractError('E_BAD_DOC', '请求体必须包含完整 doc（含 nodes）');
        seq += 1;
        const docId = doc.docId && !stores.has(doc.docId) ? doc.docId : `doc_srv_${seq}`;
        stores.set(docId, createStore({ ...doc, docId }, options));
        return { status: 201, payload: { docId } };
      }),
    },
    {
      method: 'GET',
      pattern: /^\/documents\/([^/]+)$/,
      handler: wrap(async (req, res, [, docId]) => {
        const store = stores.get(docId);
        if (!store) throw new ContractError('E_DOC_NOT_FOUND', `文档不存在：${docId}`);
        return { doc: store.getDoc() };
      }),
    },
    {
      method: 'GET',
      pattern: /^\/documents\/([^/]+)\/nodes\/([^/]+)$/,
      handler: wrap(async (req, res, [, docId, nodeId]) => {
        const store = stores.get(docId);
        if (!store) throw new ContractError('E_DOC_NOT_FOUND', `文档不存在：${docId}`);
        const node = store.getNode(decodeURIComponent(nodeId));
        if (!node) throw new ContractError(ERR.E_NODE_NOT_FOUND, `节点不存在：${nodeId}`);
        return { node };
      }),
    },
    {
      method: 'GET',
      pattern: /^\/documents\/([^/]+)\/audit$/,
      handler: wrap(async (req, res, [, docId], url) => {
        const store = stores.get(docId);
        if (!store) throw new ContractError('E_DOC_NOT_FOUND', `文档不存在：${docId}`);
        const items = store.getAuditLog({
          actorId: url.searchParams.get('actorId') || undefined,
          op: url.searchParams.get('op') || undefined,
          targetId: url.searchParams.get('targetId') || undefined,
        });
        return { items };
      }),
    },
    {
      method: 'GET',
      pattern: /^\/documents\/([^/]+)\/metrics$/,
      handler: wrap(async (req, res, [, docId]) => {
        const store = stores.get(docId);
        if (!store) throw new ContractError('E_DOC_NOT_FOUND', `文档不存在：${docId}`);
        return { metrics: store.getMetrics() };
      }),
    },
    {
      method: 'GET',
      pattern: /^\/documents\/([^/]+)\/suggestions$/,
      handler: wrap(async (req, res, [, docId], url) => {
        const store = stores.get(docId);
        if (!store) throw new ContractError('E_DOC_NOT_FOUND', `文档不存在：${docId}`);
        const items = store.listSuggestions({
          status: url.searchParams.get('status') || undefined,
          targetNodeId: url.searchParams.get('targetNodeId') || undefined,
        });
        return { items };
      }),
    },
    {
      method: 'POST',
      pattern: /^\/documents\/([^/]+)\/suggestions$/,
      handler: wrap(async (req, res, [, docId]) => {
        const store = stores.get(docId);
        if (!store) throw new ContractError('E_DOC_NOT_FOUND', `文档不存在：${docId}`);
        const actor = actorFrom(req);
        const body = await readBody(req);
        const result = store.suggestText(body, actor);
        return { status: 201, payload: result };
      }),
    },
    {
      method: 'POST',
      pattern: /^\/documents\/([^/]+)\/suggestions\/([^/]+)\/(accept|reject)$/,
      handler: wrap(async (req, res, [, docId, sid, action]) => {
        const store = stores.get(docId);
        if (!store) throw new ContractError('E_DOC_NOT_FOUND', `文档不存在：${docId}`);
        const actor = actorFrom(req);
        const body = await readBody(req);
        const result =
          action === 'accept'
            ? store.acceptSuggestion({ suggestionId: sid, ...body }, actor)
            : store.rejectSuggestion({ suggestionId: sid, ...body }, actor);
        return result;
      }),
    },
    {
      method: 'GET',
      pattern: /^\/documents\/([^/]+)\/machine-readable$/,
      handler: wrap(async (req, res, [, docId]) => {
        const store = stores.get(docId);
        if (!store) throw new ContractError('E_DOC_NOT_FOUND', `文档不存在：${docId}`);
        return { machineReadable: store.exportMachineReadable() };
      }),
    },
    {
      method: 'POST',
      pattern: /^\/documents\/([^/]+)\/export\/ofd$/,
      handler: wrap(async (req, res, [, docId]) => {
        const store = stores.get(docId);
        if (!store) throw new ContractError('E_DOC_NOT_FOUND', `文档不存在：${docId}`);
        const { plan } = await readBody(req);
        return store.exportOFD(plan);
      }),
    },
    {
      method: 'POST',
      pattern: /^\/documents\/([^/]+)\/commands$/,
      handler: wrap(async (req, res, [, docId]) => {
        const store = stores.get(docId);
        if (!store) throw new ContractError('E_DOC_NOT_FOUND', `文档不存在：${docId}`);
        const actor = actorFrom(req);
        const { op, params = {}, clientOpId, expectedRev } = await readBody(req);
        const opts = { ...(clientOpId ? { clientOpId } : {}), ...(expectedRev != null ? { expectedRev } : {}) };
        switch (op) {
          case 'createNode':
            return store.createNode(params, actor, opts);
          case 'insertText':
            return store.insertText(params, actor, opts);
          case 'updateNodeProps':
            return store.updateNodeProps(params, actor, opts);
          case 'setFieldValue':
            return store.setFieldValue(params, actor, opts);
          case 'deleteNode':
            return store.deleteNode(params, actor, opts);
          case 'confirmNode':
            return store.confirmNode(params, actor, opts);
          case 'sign':
            return store.sign(params, actor, opts);
          default:
            throw new ContractError('E_UNKNOWN_OP', `未知操作：${op}`);
        }
      }),
    },
  ];

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    for (const route of routes) {
      if (route.method !== req.method) continue;
      const m = route.pattern.exec(url.pathname);
      if (m) {
        await route.handler(req, res, m, url);
        return;
      }
    }
    send(res, 404, { code: 'E_ROUTE_NOT_FOUND', message: `未找到路由：${req.method} ${url.pathname}` });
  });

  return {
    server,
    async listen(port = 8790, host = '127.0.0.1') {
      await new Promise((resolve) => server.listen(port, host, resolve));
      return `http://${host}:${port}`;
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
    reset: () => stores.clear(),
  };
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (isMain) {
  const argv = process.argv.slice(2);
  let port = 8790;
  for (let i = 0; i < argv.length; i += 1) if (argv[i] === '--port') port = Number(argv[++i]) || 8790;
  const ref = createReferenceServer();
  const url = await ref.listen(port);
  process.stdout.write(`L0 参考服务端已启动：${url}\n`);
  process.stdout.write('协议见 docs/L0-节点操作API清单.md 的「HTTP 绑定」一节。按 Ctrl+C 退出。\n');
}
