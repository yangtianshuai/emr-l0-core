(function () {
  'use strict';

  let box = null;
  let parts = null;
  let current = null;
  let opener = null;
  let settle = null;
  let result = null;

  function parse(text) {
    const raw = String(text == null ? '' : text).replace(/\r\n?/g, '\n').trim();
    const trimmed = raw.replace(/\n{2,}(继续|是否继续|确定)[？?]\s*$/, '');
    const [head, ...tail] = trimmed.split(/\n{2,}/);
    const headLines = head.split('\n');
    const title = headLines[0].trim().replace(/[？?:：]\s*$/, '');
    const detail = [headLines.slice(1).join('\n'), ...tail].join('\n').trim();
    return { title: title.replace(/\*\*/g, ''), detail: detail.replace(/\*\*/g, '') };
  }

  function build() {
    if (box) return;
    box = document.createElement('dialog');
    box.className = 'app-dialog';
    box.innerHTML = `
      <div class="app-dialog-title"></div>
      <div class="app-dialog-detail"></div>
      <div class="app-dialog-choices" hidden></div>
      <div class="app-dialog-field" hidden>
        <input type="text" class="app-dialog-input" />
        <div class="app-dialog-hint" hidden></div>
      </div>
      <div class="app-dialog-actions">
        <button class="secondary" data-dialog="cancel">取消</button>
        <button class="primary" data-dialog="ok">确定</button>
      </div>`;
    document.body.appendChild(box);
    parts = {
      title: box.querySelector('.app-dialog-title'),
      detail: box.querySelector('.app-dialog-detail'),
      choices: box.querySelector('.app-dialog-choices'),
      field: box.querySelector('.app-dialog-field'),
      input: box.querySelector('.app-dialog-input'),
      hint: box.querySelector('.app-dialog-hint'),
      cancel: box.querySelector('[data-dialog="cancel"]'),
      ok: box.querySelector('[data-dialog="ok"]'),
    };
    parts.choices.addEventListener('click', (event) => {
      const picked = event.target instanceof Element ? event.target.closest('[data-choice]') : null;
      if (!picked) return;
      closeWith(picked.dataset.choice);
    });

    parts.ok.addEventListener('click', () => {
      if (current && current.mode === 'text' && current.required && parts.input.value.trim() === '') {
        parts.hint.textContent = current.requiredHint || '这一格必须填。';
        parts.hint.hidden = false;
        parts.input.focus();
        return;
      }
      closeWith(current && current.mode === 'text' ? parts.input.value.trim() : true);
    });
    parts.cancel.addEventListener('click', () => closeWith(cancelValue()));
    parts.input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); parts.ok.click(); }
    });
    box.addEventListener('click', (event) => {
      if (event.target !== box) return;
      const rect = box.getBoundingClientRect();
      const inBox = event.clientX >= rect.left && event.clientX <= rect.right
        && event.clientY >= rect.top && event.clientY <= rect.bottom;
      if (!inBox) closeWith(cancelValue());
    });
    box.addEventListener('close', () => {
      document.documentElement.classList.remove('dialog-open');
      const value = result;
      result = null;
      const resolve = settle;
      settle = null;
      current = null;
      const back = opener;
      opener = null;
      if (resolve) resolve(value);
      /* 焦点还回触发按钮：否则关闭后焦点落在 body 上，键盘用户要重新从头 tab */
      if (back && typeof back.focus === 'function') back.focus();
    });
  }

  function closeWith(value) {
    result = value;
    box.close();
  }

  function cancelValue() {
    const mode = current && current.mode;
    return mode === 'text' || mode === 'choose' ? null : false;
  }

  function open(options) {
    build();
    if (box.open) return Promise.resolve(null);
    const config = options || {};
    const text = parse(config.text);
    parts.title.textContent = text.title;
    parts.detail.textContent = text.detail;
    parts.detail.hidden = text.detail === '';

    const withField = config.mode === 'text';
    parts.field.hidden = !withField;
    parts.hint.hidden = true;
    parts.hint.textContent = '';
    if (withField) {
      parts.input.value = String(config.defaultValue == null ? '' : config.defaultValue);
      parts.input.placeholder = String(config.placeholder || '');
    }

    const withChoices = config.mode === 'choose';
    parts.choices.hidden = !withChoices;
    parts.choices.textContent = '';
    if (withChoices) {
      for (const item of config.choices || []) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'choice';
        button.dataset.choice = String(item.value);
        const label = document.createElement('span');
        label.className = 'choice-label';
        label.textContent = String(item.label);
        button.appendChild(label);
        if (item.detail) {
          const detail = document.createElement('span');
          detail.className = 'choice-detail';
          detail.textContent = String(item.detail);
          button.appendChild(detail);
        }
        parts.choices.appendChild(button);
      }
    }

    const alerting = config.mode === 'alert';
    parts.cancel.hidden = alerting;
    parts.ok.hidden = withChoices;
    parts.ok.textContent = String(config.okLabel || (alerting ? '知道了' : '确定'));
    parts.ok.className = config.tone === 'danger' ? 'danger' : 'primary';

    current = config;
    result = null;
    opener = document.activeElement;
    box.showModal();
    document.documentElement.classList.add('dialog-open');
    const firstChoice = withChoices ? parts.choices.querySelector('[data-choice]') : null;
    if (withField) parts.input.focus();
    else if (firstChoice) firstChoice.focus();
    else if (alerting) parts.ok.focus();
    else parts.cancel.focus();

    return new Promise((resolve) => { settle = resolve; });
  }

  /** 「要不要做这件事」：返回布尔。取消 / Esc / 点遮罩一律 false */
  window.askConfirm = (text, options) => open({ ...(options || {}), mode: 'confirm', text });
  window.askAlert = (text, options) => open({ ...(options || {}), mode: 'alert', text });
  window.askText = (text, options) => open({ ...(options || {}), mode: 'text', text });
  window.askChoose = (text, choices, options) => open({ ...(options || {}), mode: 'choose', choices, text });
})();
