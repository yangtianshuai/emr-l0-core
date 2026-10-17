/**
 * L0 HTTP 适配器：让同一套 S4 契约用例既能跑内存参考实现，也能直连真实后端。
 *
 * 用法（ai-path-check 会自动注入 options.baseUrl）：
 *   node tools/model-check/ai-path-check.mjs --adapter .\tools\model-check\lib\http-store-adapter.mjs --base-url http://127.0.0.1:8790
 *   或设置环境变量 EMR_BASE_URL
 *
 * 设计说明：
 *  - createStore(doc, options) 保持同步签名（用例侧不感知），实际建文档在首次调用时惰性完成；
 *  - 所有方法返回 Promise（用例侧统一 await，因此同一套用例可同时适配同步/异步实现）；
 *  - 错误统一为 ContractError{ code, message, extra }，与内存实现完全一致，
 *    因此用例里的 expectCode 校验在两种实现下含义相同。
 */

import { ContractError, ERR } from './doc-store.mjs';

const KNOWN_CODES = new Set(Object.values(ERR));

function baseUrlOf(options = {}) {
  const url = options.baseUrl || process.env.EMR_BASE_URL;
  if (!url) throw new Error('缺少 baseUrl：请用 --base-url 或环境变量 EMR_BASE_URL 指定后端地址');
  return url.replace(/\/$/, '');
}

export function createStore(doc, options = {}) {
  const base = baseUrlOf(options);
  const headers = { 'content-type': 'application/json' };
  let docId = null;
  let pending = null;

  async function request(method, path, { body, actor } = {}) {
    const h = { ...headers };
    if (actor) {
      h['X-Actor-Id'] = actor.id;
      h['X-Actor-Kind'] = actor.kind;
    }
    const res = await fetch(`${base}${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    const isJson = (res.headers.get('content-type') || '').includes('application/json');
    const payload = isJson ? await res.json() : { message: await res.text() };
    if (!res.ok) {
      const code = KNOWN_CODES.has(payload.code) ? payload.code : payload.code || `E_HTTP_${res.status}`;
      throw new ContractError(code, payload.message || `HTTP ${res.status}`, payload.extra);
    }
    return payload;
  }

  /** 惰性建文档：保证 createStore 同步签名不变 */
  async function ensureDoc() {
    if (docId) return docId;
    if (!pending) {
      pending = request('POST', '/documents', { body: { doc } }).then((r) => {
        docId = r.docId;
        return docId;
      });
    }
    return pending;
  }

  const cmd = async (op, params, actor, opts = {}) => {
    const id = await ensureDoc();
    return request('POST', `/documents/${encodeURIComponent(id)}/commands`, {
      actor,
      body: { op, params, ...(opts.clientOpId ? { clientOpId: opts.clientOpId } : {}), ...(opts.expectedRev != null ? { expectedRev: opts.expectedRev } : {}) },
    });
  };

  return {
    /* 读 / 审计 */
    getDoc: async () => (await request('GET', `/documents/${await ensureDoc()}`)).doc,
    getNode: async (nodeId) => {
      try {
        return (await request('GET', `/documents/${await ensureDoc()}/nodes/${encodeURIComponent(nodeId)}`)).node;
      } catch (err) {
        if (err.code === ERR.E_NODE_NOT_FOUND) return null;
        throw err;
      }
    },
    getAuditLog: async (filter = {}) => {
      const q = new URLSearchParams();
      for (const [k, v] of Object.entries(filter)) if (v) q.set(k, String(v));
      const suffix = q.toString() ? `?${q}` : '';
      return (await request('GET', `/documents/${await ensureDoc()}/audit${suffix}`)).items;
    },
    getMetrics: async () => (await request('GET', `/documents/${await ensureDoc()}/metrics`)).metrics,
    listSuggestions: async (filter = {}) => {
      const q = new URLSearchParams();
      for (const [k, v] of Object.entries(filter)) if (v) q.set(k, String(v));
      const suffix = q.toString() ? `?${q}` : '';
      return (await request('GET', `/documents/${await ensureDoc()}/suggestions${suffix}`)).items;
    },

    /* 写操作 */
    createNode: (params, actor, opts) => cmd('createNode', params, actor, opts),
    insertText: (params, actor, opts) => cmd('insertText', params, actor, opts),
    updateNodeProps: (params, actor, opts) => cmd('updateNodeProps', params, actor, opts),
    setFieldValue: (params, actor, opts) => cmd('setFieldValue', params, actor, opts),
    deleteNode: (params, actor, opts) => cmd('deleteNode', params, actor, opts),
    confirmNode: (params, actor, opts) => cmd('confirmNode', params, actor, opts),
    sign: (params, actor, opts) => cmd('sign', params, actor, opts),

    /* AI 建议 */
    suggestText: async (params, actor) => request('POST', `/documents/${await ensureDoc()}/suggestions`, { actor, body: params }),
    acceptSuggestion: async (params, actor, opts) =>
      request('POST', `/documents/${await ensureDoc()}/suggestions/${encodeURIComponent(params.suggestionId)}/accept`, {
        actor,
        body: { editedText: params.editedText, ...(opts?.clientOpId ? { clientOpId: opts.clientOpId } : {}) },
      }),
    rejectSuggestion: async (params, actor, opts) =>
      request('POST', `/documents/${await ensureDoc()}/suggestions/${encodeURIComponent(params.suggestionId)}/reject`, {
        actor,
        body: { reason: params.reason, ...(opts?.clientOpId ? { clientOpId: opts.clientOpId } : {}) },
      }),

    /* 机读 / 导出 */
    exportMachineReadable: async () => (await request('GET', `/documents/${await ensureDoc()}/machine-readable`)).machineReadable,
    exportOFD: async (plan) => request('POST', `/documents/${await ensureDoc()}/export/ofd`, { body: { plan } }),
  };
}
