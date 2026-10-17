/**
 * 自定义弹框：替代 `window.confirm` / `window.alert` / `window.prompt`。
 *
 * 为什么不用系统弹框（四条都是现场能看到的）：
 *   · 它不受本页样式控制 —— 字号、圆角、配色全由浏览器决定，与"这一屏里每一处文字
 *     都按同一套口径排版"直接冲突；
 *   · 它出现在浏览器窗口顶部（与浏览器自己的界面混在一起），和触发它的那个按钮
 *     没有任何视觉联系，人得先在页面上找回自己刚才点的是哪一行；
 *   · 按钮只有「确定 / 取消」两个词，而这里要人确认的动作是"删除 / 撤稿 / 清除 / 停用"
 *     —— 按钮上写动作本身，人才不用回头再读一遍上面的句子；
 *   · `prompt` 只能单行，而"解锁理由"这种要写一句话的输入，单行根本不够看；
 *     它还只能"先关掉再校验"，填空了就得从头点一遍。
 *
 * 做法与抽屉同源：原生 `<dialog>` + `showModal()` —— 遮罩、Esc、焦点困在框内都是内核给的，
 * 不必自造一层浮层（自造的那套总会漏掉 Esc 与焦点归还）。内核不管、这里补上的三件事：
 *   ① 点遮罩关闭（按坐标判"点在框外"，弹框自带内边距，点在那里还算框内）；
 *   ② 关闭后把焦点**还给触发它的那个按钮**（键盘用户不必从头 tab 一遍）；
 *   ③ "关闭即结论"：确认过的才算 true，Esc / 点遮罩 / 点取消一律算取消。
 *
 * 文案格式沿用原来那套：**首行当标题**（末尾的问号或冒号会去掉），空行分段，
 * 段内的换行原样保留（`white-space: pre-line`）。于是各处调用只需把
 * `window.confirm(文案)` 换成 `await askConfirm(文案)`，措辞一个字都不用改。
 *
 * 这个文件是医生端与管理后台**共用**的经典脚本（两页都 `<script src="/dialog.js">`），
 * 故意不 import 任何东西：与 ui.js / admin.js 同为经典脚本，靠 load 顺序拿全局函数。
 */
(function () {
  'use strict';

  /** 复用一个 `<dialog>`：一次只会开一个（它是模态的，第二个请求根本点不到） */
  let box = null;
  let parts = null;
  /** 当前这一屏的配置（按钮文案 / 是否要输入 / 空值怎么拦） */
  let current = null;
  /** 打开它的那个按钮：关闭后焦点还给它 */
  let opener = null;
  /** Promise 的收口：close 事件里只调它一次 */
  let settle = null;
  /** 关之前先记下的结论：Esc（含 `cancel` 事件）与点遮罩不经过按钮，结论保持 null = 取消 */
  let result = null;

  /** 文案拆成"标题 + 正文"：首行当标题，空行分段，段内的换行用 pre-line 原样显示 */
  function parse(text) {
    const raw = String(text == null ? '' : text).replace(/\r\n?/g, '\n').trim();
    /* 末尾那段单句的"继续？/确定？"不再显示：按钮上已经写着要执行的动作，
       再留一句问话等于让人读第二遍（原文案是给只有"确定/取消"的系统弹框写的） */
    const trimmed = raw.replace(/\n{2,}(继续|是否继续|确定)[？?]\s*$/, '');
    const [head, ...tail] = trimmed.split(/\n{2,}/);
    const headLines = head.split('\n');
    const title = headLines[0].trim().replace(/[？?:：]\s*$/, '');
    const detail = [headLines.slice(1).join('\n'), ...tail].join('\n').trim();
    /* `**粗体**` 是文案里残留的 Markdown 语法。弹框不解析它，直接去掉星号 ——
       系统弹框里它一直是原样显示的（用户看到的是一串 `**立刻开不出**`），
       换成自定义弹框时顺手把这一处也收拾了。 */
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
    /* 选择型：**点哪一条就是结论**（没有"先选再确认"两步）。
       一条都不显示的情况下（全被过滤掉）由调用方改用 askAlert 说明缘故，
       所以这里不需要"空清单"的兜底文案。 */
    parts.choices.addEventListener('click', (event) => {
      const picked = event.target instanceof Element ? event.target.closest('[data-choice]') : null;
      if (!picked) return;
      closeWith(picked.dataset.choice);
    });

    parts.ok.addEventListener('click', () => {
      /* 文本输入：空值**留在框里**并当场说明。原来那版是先关掉再弹一句"必须填写理由"，
         用户得从头点一遍，而理由还是空的 */
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
    /* 点遮罩 = 取消：与抽屉同一套判定（按坐标判"点在框外"；
       弹框自带内边距，点在那里同样是 target = box，但在框内，不该关） */
    box.addEventListener('click', (event) => {
      if (event.target !== box) return;
      const rect = box.getBoundingClientRect();
      const inBox = event.clientX >= rect.left && event.clientX <= rect.right
        && event.clientY >= rect.top && event.clientY <= rect.bottom;
      if (!inBox) closeWith(cancelValue());
    });
    /* 关闭后的收口全放在 close 事件里：点按钮关的、Esc 关的、点遮罩关的都只走这一处 */
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

  /**
   * 取消 / Esc / 点遮罩的结论。
   *
   * 三种形态各不相同：输入型是"没填"（null）、选择型是"没选"（null）、
   * 确认型是 false。混成同一个值，调用方就分不开"没做"与"做了但结果为空"。
   */
  function cancelValue() {
    const mode = current && current.mode;
    return mode === 'text' || mode === 'choose' ? null : false;
  }

  function open(options) {
    build();
    /* 一次只开一个。真发生了（有人在代码里连开两次）就按"没确认"收场，
       而不是把两个框叠在一起、让第一个 await 永远不返回 */
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

    /* 选择型：一条一按钮，点它就是结论。用 DOM 拼而不用字符串拼 HTML ——
       选项文字来自模板名/科室名这类外部数据，拼字符串就得自己记得转义 */
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
    /* 选择型没有"确定"这一步：选中哪一条由点击本身表达，多一个确定键只是多一次点击 */
    parts.ok.hidden = withChoices;
    parts.ok.textContent = String(config.okLabel || (alerting ? '知道了' : '确定'));
    parts.ok.className = config.tone === 'danger' ? 'danger' : 'primary';

    current = config;
    result = null;
    opener = document.activeElement;
    box.showModal();
    /* 背景滚动锁：弹框比视口短时，滚轮会直接落到背景页上（与抽屉同一条理由） */
    document.documentElement.classList.add('dialog-open');
    /* 焦点默认落在**取消**上：这些框十有八九是在拦一次不可逆动作，
       默认落在"确定"上等于给手快的人留了一条后悔不了的路。
       选择型相反：它不是在拦人，是在等人挑一条 —— 焦点落在第一条上，
       键盘用户 Enter 就能选（Tab / 方向键在列表里走）。 */
    const firstChoice = withChoices ? parts.choices.querySelector('[data-choice]') : null;
    if (withField) parts.input.focus();
    else if (firstChoice) firstChoice.focus();
    else if (alerting) parts.ok.focus();
    else parts.cancel.focus();

    return new Promise((resolve) => { settle = resolve; });
  }

  /** 「要不要做这件事」：返回布尔。取消 / Esc / 点遮罩一律 false */
  window.askConfirm = (text, options) => open({ ...(options || {}), mode: 'confirm', text });
  /** 「告诉我一件事」：只有一个按钮。返回值恒为 true（有的调用处会 await 它） */
  window.askAlert = (text, options) => open({ ...(options || {}), mode: 'alert', text });
  /** 「要一句话」：返回填的内容；取消 / Esc 返回 null（调用方据此判断"没填就算没做"） */
  window.askText = (text, options) => open({ ...(options || {}), mode: 'text', text });
  /**
   * 「从几条里挑一条」：`choices` 是 `{ value, label, detail }`，返回所选 `value`；
   * 取消 / Esc 返回 null。
   *
   * 与 `askConfirm` 的分工：那是"做不做"，这是"做哪一个"。用一串确认框问
   * "是不是这份？不是的话再看下一份？" 会把一次选择变成 N 次确认。
   */
  window.askChoose = (text, choices, options) => open({ ...(options || {}), mode: 'choose', choices, text });
})();
