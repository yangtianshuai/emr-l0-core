(function () {
  'use strict';

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
      const holder = document.activeElement;
      const taken = holder && holder !== document.body && !dialog.contains(holder);
      if (taken) return;
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
