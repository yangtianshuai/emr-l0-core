(function () {
  'use strict';

  /* 两边的来源标记：页面上可能有别的 postMessage 流量，靠它分得开，认不出的一律丢弃 */
  const SELF = 'l0-emr';
  const HOST = 'l0-emr-host';

  const HOST_PARAM = 'host';
  const ORIGIN_PARAM = 'hostOrigin';
  const PENDING_CLASS = 'l0-waiting-host';

  const INIT_TIMEOUT_MS = 10_000;
  /** 转发的等待上限：比 init 长得多，一次签名/导出可能要好几秒 */
  const REQUEST_TIMEOUT_MS = 60_000;

  const params = new URLSearchParams(window.location.search);
  const hostFlag = params.get(HOST_PARAM);
  const hosted = hostFlag !== null && hostFlag !== '0' && hostFlag !== 'false';
  const presetOrigin = params.get(ORIGIN_PARAM) || '';
  const inIframe = window.parent !== window;

  /** 允许通信的来源：先取 URL 上给的，否则等第一条消息把它钉住 */
  let hostOrigin = '';
  const inflight = new Map();
  let handlers = {};
  let seq = 0;
  let resolveInit = null;
  let initPromise = null;

  function post(message) {
    if (!inIframe) return;
    try {
      window.parent.postMessage(Object.assign({ source: SELF }, message), hostOrigin || '*');
    } catch {
    }
  }

  function emit(type, payload) {
    post({ type, payload: payload === undefined ? null : payload });
  }

  function whenReady() {
    if (!hosted) return Promise.resolve(false);
    if (initPromise !== null) return initPromise;
    initPromise = new Promise((resolve) => {
      resolveInit = resolve;
      window.setTimeout(() => {
        if (resolveInit === null) return;
        const done = resolveInit;
        resolveInit = null;
        done(false);
      }, INIT_TIMEOUT_MS);
    }).then((got) => {
      if (!got) {
        document.documentElement.classList.remove(PENDING_CLASS);
        emit('error', {
          code: 'E_HOST_INIT_TIMEOUT',
          message: `等待宿主 init 超过 ${INIT_TIMEOUT_MS / 1000}s，按未注入继续启动`,
        });
      }
      return got;
    });
    return initPromise;
  }

  function applyInit(payload) {
    const data = payload || {};
    if (!window.__L0_HOST__) window.__L0_HOST__ = {};
    const bridge = window.__L0_HOST__;
    if (data.identity) bridge.identity = data.identity;
    if (data.context) bridge.context = data.context;
    if (data.capabilities) bridge.capabilities = Object.assign({}, bridge.capabilities, data.capabilities);
    if (data.transport && data.transport.mode === 'message') {
      bridge.transport = { request: transportRequest };
    }
    document.documentElement.classList.remove(PENDING_CLASS);
  }

  function transportRequest(path, body) {
    const id = `${SELF}-${(seq += 1)}`;
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        inflight.delete(id);
        reject(new Error(`宿主未在 ${REQUEST_TIMEOUT_MS / 1000}s 内回应：${path}`));
      }, REQUEST_TIMEOUT_MS);
      inflight.set(id, { resolve, reject, timer });
      post({ type: 'request', id, payload: { path, body } });
    });
  }

  async function dispatch(type, payload, id) {
    const fn = handlers[type];
    if (typeof fn !== 'function') {
      post({
        type: 'result',
        id,
        ok: false,
        payload: { code: 'E_HOST_UNSUPPORTED', message: `控件不提供该能力：${type}` },
      });
      return;
    }
    try {
      const data = await fn(payload || {});
      post({ type: 'result', id, ok: true, payload: data === undefined ? null : data });
    } catch (err) {
      post({
        type: 'result',
        id,
        ok: false,
        payload: { code: 'E_HOST_FAILED', message: String((err && err.message) || err) },
      });
    }
  }

  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || typeof data !== 'object' || data.source !== HOST) return;

    const origin = typeof event.origin === 'string' ? event.origin : '';
    if (hostOrigin === '') {
      if (presetOrigin !== '' && origin !== presetOrigin) return;
      hostOrigin = origin;
    } else if (origin !== hostOrigin) {
      return;
    }

    const type = String(data.type || '');
    if (type === 'init') {
      applyInit(data.payload);
      if (resolveInit !== null) {
        const done = resolveInit;
        resolveInit = null;
        done(true);
      }
      return;
    }
    if (type === 'result') {
      const pending = inflight.get(data.id);
      if (!pending) return;
      inflight.delete(data.id);
      window.clearTimeout(pending.timer);
      if (data.ok === false) pending.reject(new Error(String((data.payload && data.payload.message) || '宿主拒绝了这次请求')));
      else pending.resolve(data.payload);
      return;
    }
    if (type === 'open' || type === 'flush' || type === 'canLeave' || type === 'getState' || type === 'setContext') {
      void dispatch(type, data.payload, data.id);
    }
  });

  if (hosted) document.documentElement.classList.add(PENDING_CLASS);

  window.L0Host = {
    mode: hosted ? 'hosted' : 'standalone',
    whenReady,
    register(next) { handlers = Object.assign({}, handlers, next || {}); },
    emit,
  };
})();
