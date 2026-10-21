(function () {
  'use strict';

  function esc(text) {
    return String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function safeImageUrl(raw) {
    const text = String(raw ?? '').trim();
    if (text === '') return '';
    if (/^https?:\/\//i.test(text)) return text;
    if (text.startsWith('/') && !text.startsWith('//')) return text;
    return '';
  }

  const L0_BASE = (document.documentElement && document.documentElement.dataset.l0Base) || '';

  function withBase(url) {
    return url !== '' && url.startsWith('/') ? L0_BASE + url : url;
  }

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

  function confirmChip(item) {
    if (item.humanConfirmed) return '<span class="chip ok">已确认</span>';
    if (item.origin === 'imported') return '<span class="chip danger">待确认（导入内容）</span>';
    if (item.origin === 'ai') return '<span class="chip danger">待确认（AI 内容）</span>';
    if (item.keyContent) return '<span class="chip danger">待确认（关键内容）</span>';
    return '';
  }

  function fieldConfirmChip(item) {
    if (item.humanConfirmed) return '';
    if (item.keyContent || item.origin === 'ai' || item.origin === 'imported') return '';
    return '<span class="chip danger">待确认</span>';
  }

  function tagChips(tags) {
    return (tags || []).map((t) => `<span class="chip tag">${esc(t.system)}:${esc(t.code)}</span>`).join(' ');
  }

  function paragraphOps(item, lockHint = '') {
    const locked = lockHint !== '';
    /* 禁用时必须换掉 title：只把按钮变灰、title 还写着"与上一段交换位置"，人只会以为按钮坏了 */
    const attr = (enabled, text) => (enabled ? `title="${esc(text)}"` : `title="${esc(locked ? lockHint : text)}" disabled`);
    const deleteHint = item.keyContent
      ? '关键内容禁止删除（诊断、剂量、过敏这类"错一个字就出事"的内容）'
      : '删除本段（含其中的字段）：会写入留痕，但没有撤销';
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

  function anchorBadge(nodeId, annotations) {
    const mine = (annotations || []).filter((a) => a.nodeId === nodeId);
    if (mine.length === 0) return '';
    const pending = mine.filter((a) => a.status === 'open' || a.status === 'acknowledged').length;
    const lost = mine.filter((a) => a.anchorState === 'lost').length;
    return `<span class="chip warn" title="该节点上有 ${mine.length} 条质控提示">质控 ${mine.length} · 待处理 ${pending}${lost ? ` · 锚点丢失 ${lost}` : ''}</span>`;
  }

  function nodeHtml(item, options) {
    const opts = options || {};
    const readonly = opts.readonly === true;
    const hint = String(opts.readonlyHint || '当前不可修改');
    const annotations = Array.isArray(opts.annotations) ? opts.annotations : [];
    if (item.kind === 'section') return `<div class="sec">${esc(item.title)}</div>`;
    const classes = ['node'];
    if (item.keyContent) classes.push('key');
    if (item.origin === 'ai') classes.push('ai-origin');
    if (item.pageBreakBefore) classes.push('pb-before');
    const head = `<div class="head">${tagChips(item.tags)} ${chipOrigin(item)}
      ${item.keyContent ? '<span class="chip warn">关键内容</span>' : ''}
      ${confirmChip(item)}
      ${anchorBadge(item.id, annotations)}
      ${opts.clinical === true ? '' : `<span class="rev">${esc(item.id)} · rev ${item.rev}</span>`}</div>`;
    if (item.kind === 'listItem') {
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
      const isEmptySlot = !item.resRef;
      const url = withBase(safeImageUrl(item.resRef));
      const alt = item.altText || '图片';
      const shot = url
        ? `<a class="img-shot" href="${esc(url)}" target="_blank" rel="noopener noreferrer" title="点开看原图"><img src="${esc(url)}" alt="${esc(alt)}" loading="lazy" /></a>`
        : isEmptySlot
          ? `<div class="img-shot empty">待贴图${item.altText ? `：${esc(item.altText)}` : ''}</div>`
          : `<div class="img-shot empty">${esc(item.resRef)}</div>`;
      const ops = readonly
        ? ''
        : `<div class="ops">
        <button data-image-fill="${esc(item.id)}" title="${isEmptySlot ? '选一张图贴进这一格（图会随归档件一起导出）' : '换一张图（旧图的字节仍留在资源目录里）'}">${isEmptySlot ? '贴图' : '换图'}</button>
        ${isEmptySlot ? '' : `<button class="danger" data-image-delete="${esc(item.id)}" title="删掉这张图（同一段里的正文不动；图片字节留在资源目录里，撤销能找回来）">删图</button>`}
      </div>`;
      return `<div class="${classes.join(' ')} img" data-node-id="${esc(item.id)}">
      ${head}
      ${shot}
      ${item.caption ? `<div class="img-caption">${esc(item.caption)}</div>` : ''}
      ${ops}
    </div>`;
    }
    if (item.kind === 'table') {
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
      return `<div class="${classes.join(' ')}" data-node-id="${esc(item.id)}">${head}
        <textarea class="editor${readonly ? ' ro' : ''}" rows="2" data-edit="${esc(item.id)}"${readonly ? ' readonly' : ''}>${esc(item.text)}</textarea>
        <div class="row mt6">
          <button data-confirm="${esc(item.id)}"${readonly ? ` disabled title="${esc(hint)}"` : ''}>确认内容</button>
          ${paragraphOps(item, readonly ? hint : '')}
        </div></div>`;
    }
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
        body = `<div class="ctrl-list">${cells
          .map((cell) => `<label class="ctrl-item">${cellInput(cell)} <span>${esc(cell.label)}</span>${flagOf(cell)}</label>`)
          .join('')}</div>`;
      } else if (item.shape === 'image') {
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
        body = `<div class="ctrl-scale">${cells
          .map((cell) => `<div class="ctrl-line"><span class="ctrl-name">${esc(cell.label)}</span>${cellInput(cell)}${unitOf(cell)}${flagOf(cell)}</div>`)
          .join('')}</div>`;
      }
      return `<div class="${classes.join(' ')} ctrl ctrl-${esc(item.shape || 'scale')}" data-node-id="${esc(item.id)}">${head}
        <div class="ctrl-title">${esc(item.label)}</div>
        ${body}
        <div class="row mt6">
          <button data-confirm="${esc(item.id)}"${readonly ? ` disabled title="${esc(hint)}"` : ''}>确认内容</button>
          ${fieldConfirmChip(item)}
        </div></div>`;
    }
    return `<div class="${classes.join(' ')}" data-node-id="${esc(item.id)}">${head}
      <div class="row"><b>${esc(item.label)}</b>
        <input class="field${readonly ? ' ro' : ''}" data-field="${esc(item.id)}" value="${esc(item.value)}"${readonly ? ' readonly' : ''} />
        <span class="muted">${esc(item.unit || '')}</span>
        <button data-confirm="${esc(item.id)}"${readonly ? ` disabled title="${esc(hint)}"` : ''}>确认内容</button>
        ${fieldConfirmChip(item)}
      </div></div>`;
  }

  function nodesHtml(items, options) {
    const html = (items || []).map((item) => nodeHtml(item, options)).join('');
    return html || '<div class="empty">本份病历暂无内容节点。</div>';
  }

  window.L0DocView = { esc, nodesHtml, nodeHtml, chipOrigin, confirmChip, tagChips, anchorBadge };
})();
