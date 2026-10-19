/**
 * 宿主接入桥 —— 医生端被嵌进医生工作站（iframe / 内嵌页）时的那一层。
 *
 * 为什么单独一个文件：嵌入这件事自带一套**时序与协议**（等 init、转发请求、广播事件、
 * 回答"能不能离开"），混进 ui.js 会让"界面怎么画"与"被谁驱动"缠在一起 —— 而界面脚本是
 * 改得最频繁的那一层，改一个页签的人不该先读一遍消息协议。
 *
 * 三条纪律（与 ui.js 里 `hostBridge()` 那段注释同源，改这里之前先读它）：
 *   · **只传递三件事**：identity（身份）、context（患者与文书寻址）、transport（传输）；
 *     任何写语义（保存 / 签章 / 采纳）都不经本文件 —— 留痕、门控与签章都属内核；
 *   · **独立运行时行为不变**：没有 `?host=1`、也没有 `window.__L0_HOST__` 时，本文件
 *     只注册一个什么都不做的监听，页面与引入它之前逐字节一致；
 *   · **宿主缺席不把页面钉死**：等 init 有上限，超时按"没有宿主"继续启动并广播 error。
 *
 * 加载顺序：必须在 ui.js **之前**（ui.html 里 `<script src="/host-bridge.js" defer>`）。
 * 原因不是"用了它的变量"，而是它决定"启动要不要先等宿主"：能力开关与初始文书都
 * 来自宿主注入，晚一步就会出现"先按全量画一帧、再被摘掉"的闪烁。
 *
 * 协议（postMessage，`event.data` 的形状）：
 *   宿主 → 控件：`{ source:'l0-emr-host', type:'init'|'open'|'flush'|'canLeave'|'getState'|'setContext', id?, payload? }`
 *   控件 → 宿主：`{ source:'l0-emr', type:'ready'|'state'|'dirty'|'saved'|'signed'|'error'|'result', id?, payload? }`
 * 带 `id` 的都是一问一答：宿主发请求、控件回一条同 `id` 的 `result`。
 */
(function () {
  'use strict';

  /* 两边的来源标记：页面上可能有别的 postMessage 流量，靠它分得开，认不出的一律丢弃 */
  const SELF = 'l0-emr';
  const HOST = 'l0-emr-host';

  /** URL 参数：`?host=1` —— 我是被嵌进来的，要等宿主 init 才启动 */
  const HOST_PARAM = 'host';
  /** URL 参数：`?hostOrigin=` —— 钉住允许通信的来源（不给则认第一次收到的来源） */
  const ORIGIN_PARAM = 'hostOrigin';
  /** 等待指示：宿主模式下等 init 期间挂在 `<html>` 上（样式见 ui.css） */
  const PENDING_CLASS = 'l0-waiting-host';

  /** 等 init 的上限：宿主永不出现时页面必须照常启动 ——
      白屏等一个不会来的消息，比"按没有宿主启动"坏得多 */
  const INIT_TIMEOUT_MS = 10_000;
  /** 转发的等待上限：比 init 长得多，一次签名/导出可能要好几秒 */
  const REQUEST_TIMEOUT_MS = 60_000;

  const params = new URLSearchParams(window.location.search);
  const hostFlag = params.get(HOST_PARAM);
  const hosted = hostFlag !== null && hostFlag !== '0' && hostFlag !== 'false';
  const presetOrigin = params.get(ORIGIN_PARAM) || '';
  /** 不在 iframe 里就没有宿主窗口：消息发给自己只会自己收到，所以一律不发 */
  const inIframe = window.parent !== window;

  /** 允许通信的来源：先取 URL 上给的，否则等第一条消息把它钉住 */
  let hostOrigin = '';
  /** 待应答的转发请求（id → { resolve, reject, timer }） */
  const inflight = new Map();
  /** ui.js 注册进来的能力（open / flush / canLeave / getState / setContext） */
  let handlers = {};
  let seq = 0;
  let resolveInit = null;
  let initPromise = null;

  /**
   * 发一条消息给宿主。
   *
   * 独立运行（不在 iframe 里）时直接不发：那时没有宿主，而"自己发给自己"会让
   * 本文件的监听器收到一条看似来自宿主的消息 —— 那正是最难排查的一类假象。
   */
  function post(message) {
    if (!inIframe) return;
    try {
      window.parent.postMessage(Object.assign({ source: SELF }, message), hostOrigin || '*');
    } catch {
      /* 宿主窗口已经没了（iframe 被卸载）：这时发不出去是正常的，不该抛 */
    }
  }

  /** 广播一个事件（不带 id，宿主不需要应答） */
  function emit(type, payload) {
    post({ type, payload: payload === undefined ? null : payload });
  }

  /**
   * 等宿主的 init。
   *
   * 超时也 resolve（而不是 reject）：宿主没来不该变成"界面起不来"，它只是一条
   * 必须说出口的事实 —— 所以这里广播一条 error，页面照常按未注入启动。
   */
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

  /**
   * 把 init 带来的注入写进 `window.__L0_HOST__`。
   *
   * ui.js 只从那一个对象取外部能力（这是它唯一的宿主接入点），所以本文件不另设一套：
   * 跨 iframe 传不了函数，于是 `transport` 在消息里退化成一个**声明**（`mode:'message'`），
   * 真正的请求函数由本文件按这个声明造出来再塞回去 —— ui.js 那段代码因此一行都不用改。
   */
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

  /** 转发一次请求给宿主（宿主再打自己的网关）：一问一答，带 id */
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

  /** 回答宿主的一次调用：能力没注册就明说不支持，而不是让它一直等 */
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
      /* 异常也要回：宿主侧是一问一答，收不到回应它会一直挂着 */
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

    /* 来源：预设了就只认它；没预设就把第一次收到的钉住。
       不钉住的话，任何站点都能往这个 iframe 里塞消息 —— 包括塞一个 context
       让它打开别人的病历。同源部署建议在 URL 上直接给 `hostOrigin`。 */
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
    /* 转发的应答：按 id 找回去（id 是控件自己发的，对不上就是别人的消息） */
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

  /* 宿主模式：先挂上等待指示，等 init 到了再摘（见 ui.css 的 .l0-waiting-host）。
     不给提示的话，"嵌进去之后一片空白"分不清是"在等宿主"还是"页面坏了"。 */
  if (hosted) document.documentElement.classList.add(PENDING_CLASS);

  window.L0Host = {
    /** 'standalone'（独立运行）/ 'hosted'（被嵌入，等 init） */
    mode: hosted ? 'hosted' : 'standalone',
    whenReady,
    /** ui.js 把能力注册进来（函数，不是数据：它要碰 S、要发请求，只有界面脚本知道怎么做） */
    register(next) { handlers = Object.assign({}, handlers, next || {}); },
    emit,
  };
})();
