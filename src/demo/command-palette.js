/**
 * 命令面板（Ctrl+K）：**只负责"选"，不负责"做"**。
 *
 * 为什么单独一个文件：它是纯界面件 —— 候选从哪来、选中之后发生什么，全部由 ui.js 注入。
 * 于是"面板长什么样"与"命令能改什么"互不牵扯：换候选集不用碰这里，
 * 改键盘行为也不会顺手动了写路径。
 *
 * ## 三条不做
 *
 * 1) **不自带任何业务动作**：本文件不认识 `S`、不认识 `api()`，更不认识留痕与门控。
 *    它能做的只有把选中的 `cmd` 交回去 —— 命令怎么落笔，是 ui.js 的事。
 * 2) **不做模糊匹配的玄学**：规则只有一条 —— 每个词都得出现在标签 / 说明 / 关键词里。
 *    命令面板最怕"我打了字，它给了一堆看似相关的"，那等于逼人把列表重读一遍。
 * 3) **不靠滚动条控高度**：候选最多 `MAX_RESULTS` 条，多出来的靠"再输几个字"收敛。
 *    本页有一条硬纪律：正文与列表不出现内部滚动条（A9 用例守着），
 *    连 `.app-dialog-detail` 的那条限高都是单独记过的例外 —— 这里不添第二条。
 */
(function () {
  'use strict';

  /** 一屏最多显示多少条。再多就该"输得再准一点"，而不是在弹框里滚。 */
  const MAX_RESULTS = 12;

  let dialog = null;
  let input = null;
  let listEl = null;
  let footEl = null;
  let commands = [];
  let filtered = [];
  let active = 0;
  let restoreFocus = null;

  function esc(text) {
    return String(text === null || text === undefined ? '' : text).replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[ch]));
  }

  /**
   * 建一次 DOM，之后反复开关只改内容。
   *
   * 用 `<dialog>` + `showModal()` 而不是自绘遮罩：遮罩、top-layer、Esc、焦点归还
   * 都由内核给 —— 与 dialog.js 的弹框同源，也就不会出现"这个浮层的 Esc 不灵"那种分叉。
   */
  function ensure() {
    if (dialog) return;
    dialog = document.createElement('dialog');
    dialog.className = 'app-dialog cmdk';
    dialog.setAttribute('aria-label', '命令面板');
    dialog.innerHTML = `
      <div class="cmdk-head">
        <span class="cmdk-key" aria-hidden="true">Ctrl K</span>
        <input class="cmdk-input" type="text" autocomplete="off" spellcheck="false"
               role="combobox" aria-expanded="true" aria-controls="cmdkList"
               aria-autocomplete="list" aria-label="命令搜索" />
      </div>
      <div class="cmdk-list" id="cmdkList" role="listbox" aria-label="命令候选"></div>
      <div class="cmdk-foot" id="cmdkFoot"></div>`;
    document.body.appendChild(dialog);

    input = dialog.querySelector('.cmdk-input');
    listEl = dialog.querySelector('.cmdk-list');
    footEl = dialog.querySelector('.cmdk-foot');

    input.addEventListener('input', render);

    input.addEventListener('keydown', (event) => {
      const total = Math.min(filtered.length, MAX_RESULTS);
      /* 方向键与 Tab 都走列表：Tab 用来"往下挑"是命令面板的惯例，
         而这里若让 Tab 跑出弹框，焦点会落到遮罩后面的按钮上 —— 那比不响更糟 */
      if (event.key === 'ArrowDown' || (event.key === 'Tab' && !event.shiftKey)) {
        event.preventDefault();
        if (total > 0) move(1);
        return;
      }
      if (event.key === 'ArrowUp' || (event.key === 'Tab' && event.shiftKey)) {
        event.preventDefault();
        if (total > 0) move(-1);
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        runActive();
        return;
      }
      /* 在面板里再按一次 Ctrl+K：收起（与打开同一个动作） */
      if ((event.ctrlKey || event.metaKey) && (event.key === 'k' || event.key === 'K')) {
        event.preventDefault();
        close();
      }
    });

    listEl.addEventListener('mousemove', (event) => {
      const row = event.target.closest ? event.target.closest('.cmdk-item') : null;
      if (!row) return;
      const index = Number(row.dataset.index);
      if (!Number.isInteger(index) || index === active) return;
      active = index;
      syncActive();
    });

    listEl.addEventListener('click', (event) => {
      const row = event.target.closest ? event.target.closest('.cmdk-item') : null;
      if (!row) return;
      const index = Number(row.dataset.index);
      if (!Number.isInteger(index)) return;
      active = index;
      runActive();
    });

    /* 点遮罩 = 关掉（<dialog> 的默认行为里没有这一条） */
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) close();
    });

    dialog.addEventListener('close', () => {
      document.documentElement.classList.remove('cmdk-open');
      const target = restoreFocus;
      restoreFocus = null;
      /* `close` 事件是**异步**派发的：命令若已经自己把焦点放进了正文（跳转、插入），
         此刻 activeElement 就不在 body 上 —— 这时再"归还焦点"会把光标抢回去，
         症状是"跳过去了一下，然后光标自己跑了"。只在没人接住焦点时才归还。
         注意"还没接住"的样子有两种：body，以及**焦点仍留在面板内**（输入框）。
         后者若不排除，Esc 关闭时会被判成"已被接住"，于是焦点悄悄掉到 body 上。 */
      const holder = document.activeElement;
      const taken = holder && holder !== document.body && !dialog.contains(holder);
      if (taken) return;
      /* 命令可能已经把正文重画过（节点被替换），因此要确认那个元素还在文档里 ——
         给一个已脱离的节点 focus() 等于把焦点丢给 body。 */
      if (target && target.isConnected && typeof target.focus === 'function') target.focus();
    });
  }

  function move(delta) {
    const total = Math.min(filtered.length, MAX_RESULTS);
    if (total === 0) return;
    active = (active + delta + total) % total;
    syncActive();
  }

  function syncActive() {
    const rows = listEl.querySelectorAll('.cmdk-item');
    rows.forEach((row, index) => {
      const on = index === active;
      row.classList.toggle('active', on);
      row.setAttribute('aria-selected', String(on));
    });
    const current = rows[active];
    if (!current) {
      input.removeAttribute('aria-activedescendant');
      return;
    }
    input.setAttribute('aria-activedescendant', current.id);
    if (current.scrollIntoView) current.scrollIntoView({ block: 'nearest' });
  }

  /**
   * 过滤：**每个词都要命中**，命中位置越靠前越优先。
   *
   * 为什么不用编辑距离那类"看起来更聪明"的算法：命令名是短句，
   * 近似匹配的收益很小，而误配的代价是把"我要的那一条"挤出前 12 条 ——
   * 一旦被挤出去，人只会以为"这功能没收录它"。
   */
  function filterCommands(all, query) {
    const tokens = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return all.slice();
    const scored = [];
    all.forEach((cmd, order) => {
      const label = String(cmd.label || '').toLowerCase();
      const hay = `${label} ${cmd.detail || ''} ${cmd.keywords || ''}`.toLowerCase();
      let score = 0;
      for (const token of tokens) {
        if (hay.indexOf(token) < 0) return;
        score += label.indexOf(token) === 0 ? 4 : (label.includes(token) ? 2 : 1);
      }
      scored.push({ cmd, order, score });
    });
    scored.sort((left, right) => (right.score - left.score) || (left.order - right.order));
    return scored.map((entry) => entry.cmd);
  }

  function render() {
    filtered = filterCommands(commands, input.value);
    active = 0;
    const shown = filtered.slice(0, MAX_RESULTS);
    let html = '';
    let group = null;
    shown.forEach((cmd, index) => {
      if (cmd.group && cmd.group !== group) {
        group = cmd.group;
        html += `<div class="cmdk-group">${esc(group)}</div>`;
      }
      html += `<div class="cmdk-item" role="option" id="cmdk-opt-${index}" data-index="${index}" aria-selected="false">`
        + `<span class="cmdk-label">${esc(cmd.label)}</span>`
        + (cmd.detail ? `<span class="cmdk-detail">${esc(cmd.detail)}</span>` : '')
        + '</div>';
    });
    if (shown.length === 0) {
      html = '<div class="cmdk-empty">没有匹配的命令。试试「主诉」「白细胞」「超声」「模板」。</div>';
    }
    listEl.innerHTML = html;
    syncActive();
    const hidden = filtered.length - shown.length;
    footEl.innerHTML = hidden > 0
      ? `<span>还有 ${hidden} 条 —— 再输几个字缩小范围</span>`
      : '<span>↑ ↓ 选择 · Enter 执行 · Esc 关闭</span>';
  }

  function runActive() {
    const cmd = filtered[active];
    if (!cmd) return;
    /* 先关面板再执行：命令可能重画正文、弹确认框，
       面板还开着的话它会盖在结果上，而且那时焦点已经不在输入框里了。 */
    close();
    try {
      const result = cmd.run();
      if (result && typeof result.catch === 'function') result.catch((err) => console.error('[命令面板]', err));
    } catch (err) {
      console.error('[命令面板]', err);
    }
  }

  function close() {
    if (!dialog || !dialog.open) return;
    dialog.close();
  }

  function open(options) {
    ensure();
    const opts = options || {};
    commands = Array.isArray(opts.commands)
      ? opts.commands.filter((cmd) => cmd && typeof cmd.run === 'function')
      : [];
    restoreFocus = document.activeElement && typeof document.activeElement.focus === 'function'
      ? document.activeElement
      : null;
    input.value = '';
    input.placeholder = opts.placeholder || '输入要做什么…';
    if (!dialog.open) dialog.showModal();
    document.documentElement.classList.add('cmdk-open');
    render();
    input.focus();
  }

  window.L0Palette = {
    open,
    close,
    isOpen: () => !!dialog && dialog.open,
  };
})();
