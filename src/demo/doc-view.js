/* 正文渲染：**医生端正文与管理后台的「模板预览」共用的一份**（经典脚本，挂在 `window.L0DocView`）。
 *
 * 为什么单独一份、而不是两处各画一遍：
 *   预览要回答的是"医生点开之后面前是什么"。只要两处各画一份，就一定会分叉 ——
 *   今天差一个 chip、明天差一处只读态，而两处都"看起来对"，直到有人并排比较才发现。
 *   而"预览与正文长得不一样"恰恰与模板预览的存在意义相反：所见非所得。
 *
 * 两处的差别只有一处：**能不能改**。
 *   · 医生端：已签章 / 已归档时只读（`readonly: true`），其余可编辑；
 *   · 管理后台预览：一律只读（它本来就不是一份真实文书，点了也不该有反应），
 *     只读的原因由 `readonlyHint` 给（禁用而不给理由，人只会当成"界面卡了"）。
 *
 * 页面顺序：医生端与管理后台都必须在自己的页面脚本之前 `<script src="/doc-view.js">`。
 */
(function () {
  'use strict';

  function esc(text) {
    return String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /**
   * 影像地址只允许 **http(s) 与站内相对路径**，其余一律返回空串。
   *
   * 为什么必须有这一道：地址是**病历内容**（外部数据），而它会被放进 `img[src]` 与 `a[href]`。
   * `esc()` 只管引号，管不了协议 —— `javascript:` 写进 `href` 就是一处"点一下病历就执行"的脚本，
   * `//example.com`（协议相对）则会绕过"站内"这个判断。
   * 认不出来的地址**不画成图、也不画成链接**，但值仍然留在输入框里不丢：
   * 悄悄把它当空值处理，等于让一条真实的引用在界面上消失，而没有任何地方会报错。
   */
  function safeImageUrl(raw) {
    const text = String(raw ?? '').trim();
    if (text === '') return '';
    if (/^https?:\/\//i.test(text)) return text;
    if (text.startsWith('/') && !text.startsWith('//')) return text;
    return '';
  }

  /* 部署前缀（页面挂在工作站的某个路径下时，由服务端注入在 `<html data-l0-base>`）。
     站内地址要带上它，否则 `/res/...` 会打到工作站自己的根上 —— 表现是"图没了"，
     而病历里的地址本身并没有错。 */
  const L0_BASE = (document.documentElement && document.documentElement.dataset.l0Base) || '';

  /** 站内地址补前缀；站外地址（http(s)）原样返回 */
  function withBase(url) {
    return url !== '' && url.startsWith('/') ? L0_BASE + url : url;
  }

  /**
   * 来源徽标。`system` 要分三种说，否则医生要么以为姓名没带进来、要么以为骨架就是内容：
   *   ① 这一格**已经把系统里的值填进去了**（模板配了"从系统带入"）→ 说清是从哪儿带的；
   *   ② 只是模板给的骨架 → "模板带入"；
   *   ③ 真的由外部系统写进来的内容 → "系统带入"。
   */
  function chipOrigin(item) {
    if (item.origin === 'ai') {
      const conf = item.confidence != null ? ` ${Number(item.confidence).toFixed(2)}` : '';
      return `<span class="chip ai">AI 起草${conf}</span>`;
    }
    if (item.origin === 'system') {
      if (item.fromRef) {
        const from = item.fromLabel ? esc(item.fromLabel) : esc(String(item.fromRef));
        return `<span class="chip ok" title="开文书时从系统带进来的：${esc(String(item.fromRef))}"
        >系统带入（${from}）</span>`;
      }
      if (item.templateRef) {
        return '<span class="chip" title="由模板生成：章节骨架与数据元绑定来自模板包，正文由你填写">模板带入</span>';
      }
      return '<span class="chip">系统带入</span>';
    }
    if (item.origin === 'imported') return '<span class="chip warn">导入自外部文件</span>';
    if (item.origin === 'human') {
      return `<span class="chip">人工${item.modelId ? '（AI 来源已保留）' : ''}</span>`;
    }
    return `<span class="chip">${esc(item.origin)}</span>`;
  }

  /**
   * 确认状态徽标。注意：不只是关键内容需要确认，
   * 未确认的 AI 内容与未确认的导入内容同样会挡住签章（服务端有门控），
   * 界面上必须同样醒目，否则用户会"点签章被拒却看不出为什么要确认"。
   */
  function confirmChip(item) {
    if (item.humanConfirmed) return '<span class="chip ok">已确认</span>';
    if (item.origin === 'imported') return '<span class="chip danger">待确认（导入内容）</span>';
    if (item.origin === 'ai') return '<span class="chip danger">待确认（AI 内容）</span>';
    if (item.keyContent) return '<span class="chip danger">待确认（关键内容）</span>';
    return '';
  }

  function tagChips(tags) {
    return (tags || []).map((t) => `<span class="chip tag">${esc(t.system)}:${esc(t.code)}</span>`).join(' ');
  }

  /**
   * 段落级操作（增 / 移 / 删）。
   *
   * 按钮放在段落上：医生的动作永远是"在这一段之后加一段"、"把这段挪上去"，
   * 放进工具栏就必须先选中目标，多一次"先选中再说"的往返。
   *
   * 三处的细节：
   *   · 首段的「↑」、末段的「↓」禁用：边界服务端会拦，但死按钮（点了没反应）更糟；
   *   · 关键内容禁用「删段」：内核禁止删关键内容，界面就不该摆一个按下去必然失败的按钮；
   *   · 删除没有撤销，所以点下去要问一次，并写明"留痕有记录，但内容不可恢复"。
   */
  function paragraphOps(item, lockHint = '') {
    const locked = lockHint !== '';
    /* 禁用时必须换掉 title：只把按钮变灰、title 还写着"与上一段交换位置"，人只会以为按钮坏了 */
    const attr = (enabled, text) => (enabled ? `title="${esc(text)}"` : `title="${esc(locked ? lockHint : text)}" disabled`);
    const deleteHint = item.keyContent
      ? '关键内容禁止删除（诊断、剂量、过敏这类"错一个字就出事"的内容）'
      : '删除本段（含其中的字段）：会写入留痕，但没有撤销';
    /* 贴图按钮给的是**段落 id**（不是文本节点 id）：图挂在段落下面，
       而段落里可能不止一个文本节点。 */
    const imageButton = item.paragraphId
      ? `<button data-para-image="${esc(item.paragraphId)}" ${attr(!locked, '在这一段后面贴一张图（只收 PNG / JPEG / WebP，上限 8 MB）')}>＋图</button>`
      : '';
    return `<span class="muted push">段落</span>
    <button data-para-insert="${esc(item.id)}" ${attr(!locked, '在本段之后插入一个新段落')}>＋段</button>
    ${imageButton}
    <button data-para-up="${esc(item.id)}" ${attr(!locked && !item.paragraphFirst, item.paragraphFirst ? '已经是本节第一段' : '与上一段交换位置')}>↑</button>
    <button data-para-down="${esc(item.id)}" ${attr(!locked && !item.paragraphLast, item.paragraphLast ? '已经是本节最后一段' : '与下一段交换位置')}>↓</button>
    <button class="danger" data-para-delete="${esc(item.id)}" ${attr(!locked && !item.keyContent, deleteHint)}>删段</button>`;
  }

  /** 节点旁的质控提示徽标：提示一直挂在原处，不因签章、导出、翻页而消失（那不是 bug，是设计要求） */
  function anchorBadge(nodeId, annotations) {
    const mine = (annotations || []).filter((a) => a.nodeId === nodeId);
    if (mine.length === 0) return '';
    const pending = mine.filter((a) => a.status === 'open' || a.status === 'acknowledged').length;
    const lost = mine.filter((a) => a.anchorState === 'lost').length;
    return `<span class="chip warn" title="该节点上有 ${mine.length} 条质控提示">质控 ${mine.length} · 待处理 ${pending}${lost ? ` · 锚点丢失 ${lost}` : ''}</span>`;
  }

  /**
   * 一个节点（或章节）→ HTML。
   *
   * `options`：
   *   · `readonly`（默认 false）：只读。控件加 `readonly`、按钮 `disabled` 并带上原因；
   *   · `readonlyHint`：只读的原因（医生端是"已签章/已归档"，预览是"这不是一份真实文书"）；
   *   · `clinical`：临床模式 —— 收起节点 id / rev 这类内部标识；
   *   · `annotations`：质控提示（预览没有它，传空数组即可）。
   */
  function nodeHtml(item, options) {
    const opts = options || {};
    const readonly = opts.readonly === true;
    const hint = String(opts.readonlyHint || '当前不可修改');
    const annotations = Array.isArray(opts.annotations) ? opts.annotations : [];
    if (item.kind === 'section') return `<div class="sec">${esc(item.title)}</div>`;
    const classes = ['node'];
    if (item.keyContent) classes.push('key');
    if (item.origin === 'ai') classes.push('ai-origin');
    const head = `<div class="head">${tagChips(item.tags)} ${chipOrigin(item)}
      ${item.keyContent ? '<span class="chip warn">关键内容</span>' : ''}
      ${confirmChip(item)}
      ${anchorBadge(item.id, annotations)}
      ${opts.clinical === true ? '' : `<span class="rev">${esc(item.id)} · rev ${item.rev}</span>`}</div>`;
    if (item.kind === 'listItem') {
      /* 列表项：行首标记（`· ` / `1. `）**由服务端给**（`item.marker`）。
         前端按顺序自己数，就会与纸面（`export/ofd.ts`）各算一次 ——
         删掉一项之后，屏幕上与归档件里就会各有一个"第 3 条"，而两边看起来都对。
         文本与填写项各走既有写路径（`data-edit` / `data-field`）：列表里的格子也是格子，
         另开一条写路径就要再实现一遍留痕、机读与门控。 */
      const mark = `<span class="li-mark">${esc(item.marker || '· ')}</span>`;
      const body = item.textId
        ? `<textarea class="editor li-text${readonly ? ' ro' : ''}" rows="1" data-edit="${esc(item.textId)}"
          placeholder="（这一项为空）"${readonly ? ' readonly' : ''}>${esc(item.text || '')}</textarea>`
        : `<span class="li-text">${esc(item.text || '')}</span>`;
      const field = item.fieldId
        ? `<label class="fe${item.humanConfirmed ? '' : ' pending'}">${item.label ? `<span class="muted">${esc(item.label)}</span> ` : ''}
          <input class="field${readonly ? ' ro' : ''}" data-field="${esc(item.fieldId)}" value="${esc(item.value || '')}"
            placeholder="${readonly ? '' : '（空）'}"${readonly ? ' readonly' : ''} />${item.unit ? ` <span class="muted">${esc(item.unit)}</span>` : ''}</label>`
        : '';
      return `<div class="${classes.join(' ')} li" data-node-id="${esc(item.id)}">${head}
      <div class="li-row">${mark}${body}${field}</div></div>`;
    }
    if (item.kind === 'image') {
      /* 图：`resRef` 是**病历内容**（外部数据），要塞进 `src` / `href` ——
         `javascript:` 那类地址一旦进去，就是"点一下图就执行"。所以过 `safeImageUrl`
         的白名单（只认 http(s) 与站内路径），与「影像」控件里的预览同一条规则。
         地址取不到或不合规时**把地址原样显示出来**：只写"加载失败"的话，
         现场分不清是"图没了"还是"地址写错了"。 */
      /* 空槽与"地址不合规"要分开写：前者是**还没贴**（该催），后者是**地址不对**（该修）。
         都写成一句"没有地址"，现场就分不清该找医生还是该找配置。 */
      const isEmptySlot = !item.resRef;
      const url = withBase(safeImageUrl(item.resRef));
      const alt = item.altText || '图片';
      const shot = url
        ? `<a class="img-shot" href="${esc(url)}" target="_blank" rel="noopener noreferrer" title="点开看原图"><img src="${esc(url)}" alt="${esc(alt)}" loading="lazy" /></a>`
        : isEmptySlot
          ? `<div class="img-shot empty">待贴图${item.altText ? `：${esc(item.altText)}` : ''}</div>`
          : `<div class="img-shot empty">${esc(item.resRef)}</div>`;
      /* 删图**单独一条动作**（`data-image-delete`）：走 `/api/delete-node` 会把这一段的
         正文一起删掉 —— 它的删除单位是段落。贴错一张图而赔上一段病历，这个代价不对等。
         空槽不给「删图」（没有图可删），给的是「贴图」。 */
      const ops = readonly
        ? ''
        : `<div class="ops">
        <button data-image-fill="${esc(item.id)}" title="${isEmptySlot ? '选一张图贴进这一格（图会随归档件一起导出）' : '换一张图（旧图的字节仍留在资源目录里）'}">${isEmptySlot ? '贴图' : '换图'}</button>
        ${isEmptySlot ? '' : `<button class="danger" data-image-delete="${esc(item.id)}" title="删掉这张图（同一段里的正文不动；图片字节留在资源目录里，撤销能找回来）">删图</button>`}
      </div>`;
      return `<div class="${classes.join(' ')} img">
      ${head}
      ${shot}
      ${item.caption ? `<div class="img-caption">${esc(item.caption)}</div>` : ''}
      ${ops}
    </div>`;
    }
    if (item.kind === 'table') {
    /* 表格：表头只读，数据格是**填写项** —— 它们带 `data-field`，走的是与正文填写项
       完全相同的那条写路径（留痕、索引同步、乐观锁都一样），所以这里不需要任何新事件处理。
       表格上没有"加一行 / 删一行"：行数是模板给的骨架，临床上改动行数会改变这张表单的结构，
       那属于改模板，不属于填病历（真要改，去后台改草稿再发布）。 */
    const columns = Array.isArray(item.columns) ? item.columns : [];
    const rows = Array.isArray(item.rows) ? item.rows : [];
    const headerRow = `<tr>${columns.map((title) => `<th>${esc(title)}</th>`).join('')}</tr>`;
    const bodyRows = rows
      .map((row) => `<tr>${(Array.isArray(row) ? row : []).map((cell) => {
        const unit = cell.unit ? ` <span class="muted">${esc(cell.unit)}</span>` : '';
        if (!cell.nodeId) return `<td>${esc(cell.text)}${unit}</td>`;
        return `<td><input class="field${readonly ? ' ro' : ''}" data-field="${esc(cell.nodeId)}"
          value="${esc(cell.text)}"${readonly ? ' readonly' : ''} />${unit}</td>`;
      }).join('')}</tr>`)
      .join('');
    return `<div class="${classes.join(' ')}" data-node-id="${esc(item.id)}">${head}
      <table class="doc-table"><thead>${headerRow}</thead><tbody>${bodyRows}</tbody></table></div>`;
  }
  if (item.kind === 'text') {
      /* 外层容器带 data-node-id：它是拖放落点的目标（把语音页签里的一段拖到这里）。
         放在外层而不是 textarea 上：textarea 会自己吃掉 drop 事件，拖到它上面反而放不下。 */
      return `<div class="${classes.join(' ')}" data-node-id="${esc(item.id)}">${head}
        <textarea class="editor${readonly ? ' ro' : ''}" rows="2" data-edit="${esc(item.id)}"${readonly ? ' readonly' : ''}>${esc(item.text)}</textarea>
        <div class="row mt6">
          <button data-confirm="${esc(item.id)}"${readonly ? ` disabled title="${esc(hint)}"` : ''}>确认内容</button>
          ${paragraphOps(item, readonly ? hint : '')}
        </div></div>`;
    }
    /* 专科控件：**形状决定画法**（量表评分 / 时序趋势 / 行列表 / 勾选清单）。
       四种画法其实只做一件事：把 `item.cells`（服务端算好的格）摆出来，并挂上
       `data-control-field="节点id:格键"` —— 写由 ui.js 的全局委托接手。
       界面**不拼键**：键由形状算出来（`model/control.ts`），在浏览器里再拼一遍，
       一旦与内核漂移，症状是"医生填的值在导出里凭空不见"，而两端都不报错。 */
    if (item.kind === 'control') {
      const cells = Array.isArray(item.cells) ? item.cells : [];
      const cellInput = (cell) => {
        const attrs = `data-control-field="${esc(item.id)}:${esc(cell.key)}"`;
        if (Array.isArray(cell.valueSet) && cell.valueSet.length > 0) {
          const options = ['<option value="">（未选）</option>']
            .concat(cell.valueSet.map((option) => {
              const label = option.display || option.code;
              return `<option value="${esc(option.code)}"${cell.value === option.code ? ' selected' : ''}>${esc(label)}</option>`;
            }))
            .join('');
          return `<select class="ctrl-input${readonly ? ' ro' : ''}" ${attrs}${readonly ? ' disabled' : ''}>${options}</select>`;
        }
        if (cell.dataType === 'boolean') {
          return `<input type="checkbox" class="ctrl-box" ${attrs}${cell.value === 'true' ? ' checked' : ''}${readonly ? ' disabled' : ''} />`;
        }
        return `<input class="field ctrl-input${readonly ? ' ro' : ''}" ${attrs} value="${esc(cell.value || '')}"${readonly ? ' readonly' : ''} />`;
      };
      const unitOf = (cell) => (cell.unit ? ` <span class="muted">${esc(cell.unit)}</span>` : '');
      const flagOf = (cell) => (cell.required ? ' <span class="chip warn">必填</span>' : '');
      /* 同一形状里"有哪些行 / 有哪些列"从 cells 自身推出来：
         服务端按"字段序 → 行序"生成（`controlCellsOf`），所以顺序就是界面上的顺序。 */
      const uniqueOf = (list, pick) => {
        const out = [];
        for (const entry of list) {
          const value = pick(entry);
          if (value !== undefined && value !== null && out.indexOf(value) < 0) out.push(value);
        }
        return out;
      };
      let body = '';
      if (item.shape === 'series') {
        /* 时序（趋势）：一张表 —— 行是"第几条记录"，列是字段（时间轴那一列排最前，
           定义里标了 `axis`）。行数由模板给：改行数属于改模板，这里没有加删行。 */
        const rowKeys = uniqueOf(cells, (cell) => cell.row);
        const headCells = rowKeys.length > 0 ? cells.filter((cell) => cell.row === rowKeys[0]) : cells;
        const header = `<tr><th class="ctrl-rowhead">#</th>${headCells
          .map((cell) => `<th>${esc(cell.label)}${cell.unit ? ` <span class="muted">${esc(cell.unit)}</span>` : ''}</th>`)
          .join('')}</tr>`;
        const rows = rowKeys
          .map((row) => {
            const line = cells.filter((cell) => cell.row === row);
            return `<tr><th class="ctrl-rowhead">第 ${esc(row)} 次</th>${line
              .map((cell) => `<td>${cellInput(cell)}</td>`)
              .join('')}</tr>`;
          })
          .join('');
        body = `<table class="doc-table ctrl-table"><thead>${header}</thead><tbody>${rows}</tbody></table>`;
      } else if (item.shape === 'matrix') {
        /* 行列表：行 × 列 的网格（如 32 颗牙 × 龋/充填/缺失）。格子是"打点"，
           行列名来自控件定义（32 颗牙不该由这份文书自己改）。 */
        const rowKeys = uniqueOf(cells, (cell) => cell.rowKey);
        const columnKeys = uniqueOf(cells, (cell) => cell.columnKey);
        const labelOfRow = (key) => (cells.find((cell) => cell.rowKey === key) || {}).rowLabel || key;
        const labelOfColumn = (key) => (cells.find((cell) => cell.columnKey === key) || {}).columnLabel || key;
        const header = `<tr><th class="ctrl-rowhead"></th>${columnKeys
          .map((key) => `<th>${esc(labelOfColumn(key))}</th>`)
          .join('')}</tr>`;
        const rows = rowKeys
          .map((key) => {
            const line = cells.filter((cell) => cell.rowKey === key);
            return `<tr><th class="ctrl-rowhead">${esc(labelOfRow(key))}</th>${columnKeys
              .map((columnKey) => {
                const cell = line.find((candidate) => candidate.columnKey === columnKey);
                return `<td class="ctrl-cell">${cell ? cellInput(cell) : ''}</td>`;
              })
              .join('')}</tr>`;
          })
          .join('');
        body = `<table class="doc-table ctrl-table ctrl-matrix"><thead>${header}</thead><tbody>${rows}</tbody></table>`;
      } else if (item.shape === 'checklist') {
        /* 勾选清单：一格一项，横着铺开（清单是"有哪些项"，竖排会长得像个表单） */
        body = `<div class="ctrl-list">${cells
          .map((cell) => `<label class="ctrl-item">${cellInput(cell)} <span>${esc(cell.label)}</span>${flagOf(cell)}</label>`)
          .join('')}</div>`;
      } else if (item.shape === 'image') {
        /* 影像：一格一张 —— 名称 + 地址 + 预览。
           地址**看得见也改得动**（而不是只给一个"预览"）：本系统只存引用，
           图的字节不在文书里，所以"这张不是他的 / 地址换了"唯一能纠正的地方就是这一格。
           地址为空、或不被 `safeImageUrl` 认下时不画图 —— 但值仍留在那一格里不丢。 */
        body = `<div class="ctrl-images">${cells
          .map((cell) => {
            const raw = String(cell.value || '');
            const url = safeImageUrl(raw);
            const shot = url
              ? `<a class="ctrl-shot" href="${esc(url)}" target="_blank" rel="noopener noreferrer"
                  title="在新窗口打开原图（本系统只存地址，图本身在 PACS / 院内服务上）"
                ><img src="${esc(url)}" alt="${esc(cell.label)}" loading="lazy" /></a>`
              : `<div class="ctrl-shot empty">${raw === '' ? '尚未关联影像' : '地址不是 http(s) / 站内路径，无法预览'}</div>`;
            const addr = readonly
              ? (url
                ? `<a class="ctrl-addr" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(raw)}</a>`
                : `<span class="ctrl-addr muted">${esc(raw === '' ? '（未填）' : raw)}</span>`)
              : cellInput(cell);
            return `<div class="ctrl-image-item">
              <div class="ctrl-image-head"><span class="ctrl-image-name">${esc(cell.label)}</span>${flagOf(cell)}</div>
              ${addr}
              ${shot}
            </div>`;
          })
          .join('')}</div>`;
      } else {
        /* 量表评分（默认档）：一格一行 —— 名字 + 输入或选项 + 单位 + 必填标记。
           为什么一行一格：评分量表的每一格都要人**逐格核对**，挤成一行之后
           "我在改哪一格"要靠数格子才敢确认。 */
        body = `<div class="ctrl-scale">${cells
          .map((cell) => `<div class="ctrl-line"><span class="ctrl-name">${esc(cell.label)}</span>${cellInput(cell)}${unitOf(cell)}${flagOf(cell)}</div>`)
          .join('')}</div>`;
      }
      return `<div class="${classes.join(' ')} ctrl ctrl-${esc(item.shape || 'scale')}" data-node-id="${esc(item.id)}">${head}
        <div class="ctrl-title">${esc(item.label)}</div>
        ${body}
        <div class="row mt6">
          <button data-confirm="${esc(item.id)}"${readonly ? ` disabled title="${esc(hint)}"` : ''}>确认内容</button>
          ${item.humanConfirmed ? '<span class="chip ok">已确认</span>' : '<span class="chip danger">待确认</span>'}
        </div></div>`;
    }
    return `<div class="${classes.join(' ')}">${head}
      <div class="row"><b>${esc(item.label)}</b>
        <input class="field${readonly ? ' ro' : ''}" data-field="${esc(item.id)}" value="${esc(item.value)}"${readonly ? ' readonly' : ''} />
        <span class="muted">${esc(item.unit || '')}</span>
        <button data-confirm="${esc(item.id)}"${readonly ? ` disabled title="${esc(hint)}"` : ''}>确认内容</button>
        ${item.humanConfirmed ? '<span class="chip ok">已确认</span>' : '<span class="chip danger">待确认</span>'}
      </div></div>`;
  }

  /** 整份正文 → HTML（章节与节点按服务端给的顺序） */
  function nodesHtml(items, options) {
    const html = (items || []).map((item) => nodeHtml(item, options)).join('');
    return html || '<div class="empty">本份病历暂无内容节点。</div>';
  }

  /* `anchorBadge` 也导出：自由流式视图要用**同一份**质控徽标（不另写一份）。
     两处各写一份的结果是"提示的个数对得上、措辞对不上"，而这正是质控提示最不该有的分歧。 */
  window.L0DocView = { esc, nodesHtml, nodeHtml, chipOrigin, confirmChip, tagChips, anchorBadge };
})();
