(function () {
  'use strict';

  function esc(text) {
    return String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  const MARK_TAGS = { bold: 'b', italic: 'i', underline: 'u', highlight: 'mark', sup: 'sup', sub: 'sub' };
  const TAG_MARKS = { B: 'bold', STRONG: 'bold', I: 'italic', EM: 'italic', U: 'underline', MARK: 'highlight', SUP: 'sup', SUB: 'sub' };

  function marksToHtml(run) {
    const marks = Array.isArray(run.marks) ? run.marks : [];
    let html = esc(run.text);
    for (const mark of marks) {
      const tag = MARK_TAGS[mark];
      if (tag) html = `<${tag}>${html}</${tag}>`;
    }
    return html;
  }

  function runHtml(run, fallback, nodeId) {
    const inner = marksToHtml(run);
    const provenance = run.provenance || fallback || null;
    if (!provenance) return inner;
    const src = nodeId ? ` data-src-node="${esc(String(nodeId))}"` : '';
    if (provenance.origin === 'ai') {
      const conf = typeof provenance.confidence === 'number' ? `，置信度 ${Number(provenance.confidence).toFixed(2)}` : '';
      const model = provenance.modelId ? `${esc(String(provenance.modelId))}` : '（未记模型）';
      return `<span class="run-ai"${src} title="这几句由 AI 起草（${model}${conf}）：采纳它的是人，责任也在人。点一下看来源">${inner}</span>`;
    }
    if (provenance.origin === 'imported') {
      return `<span class="run-imported"${src} title="这几句来自外部文件 / 剪贴板，未逐句核对。点一下看来源">${inner}</span>`;
    }
    return inner;
  }

  function runsHtml(item) {
    const runs = Array.isArray(item.runs) && item.runs.length > 0
      ? item.runs
      : [{ text: item.text || '' }];
    const fallback = { origin: item.origin, modelId: item.modelId, confidence: item.confidence };
    return runs.map((run) => runHtml(run, fallback, item.id)).join('');
  }

  function planOf(items) {
    const plan = [];
    let segment = null;
    let sectionId = null;
    let segIndex = 0;
    const closeSegment = () => {
      if (segment) plan.push(segment);
      segment = null;
    };
    for (const item of items || []) {
      if (!item) continue;
      if (item.kind === 'section') {
        closeSegment();
        sectionId = item.id;
        plan.push({ type: 'section', id: item.id, item });
        continue;
      }
      if (item.kind !== 'text' && item.kind !== 'field') {
        closeSegment();
        plan.push({ type: 'card', item });
        continue;
      }
      if (item.kind === 'field' && item.paragraphId === undefined) {
        closeSegment();
        plan.push({ type: 'card', item });
        continue;
      }
      if (!segment) {
        segIndex += 1;
        segment = { type: 'segment', key: `${sectionId || 'nosection'}#${segIndex}`, sectionId, blocks: [], items: [] };
      }
      let block = null;
      for (const candidate of segment.blocks) {
        if (candidate.paragraphId !== undefined && candidate.paragraphId === item.paragraphId) block = candidate;
      }
      if (!block) {
        block = { paragraphId: item.paragraphId, nodeId: null, text: '', runs: undefined, fields: [], items: [] };
        segment.blocks.push(block);
      }
      block.items.push(item);
      if (item.kind === 'text') {
        block.nodeId = item.id;
        block.text = item.text || '';
        block.runs = item.runs;
      } else {
        block.fields.push(item);
      }
    }
    closeSegment();
    return plan;
  }

  function paragraphDecoHtml(item, annotations) {
    const chips = [
      item.origin && item.origin !== 'human' ? window.L0DocView.chipOrigin(item) : '',
      item.keyContent ? '<span class="chip warn">关键内容</span>' : '',
      item.humanConfirmed === false ? window.L0DocView.confirmChip(item) : '',
      window.L0DocView.anchorBadge(item.id, annotations),
    ].filter((html) => html !== '').join(' ');
    if (chips === '') return '';
    return `<span class="fp-deco" contenteditable="false" data-para-deco="1">${chips}</span>`;
  }

  function fieldHtml(item, readonly, hint) {
    const label = item.label ? `${esc(item.label)} ` : '';
    const unit = item.unit ? ` <span class="muted">${esc(item.unit)}</span>` : '';
    const value = item.value === '' || item.value === undefined ? '<span class="muted">（空）</span>' : esc(item.value);
    const title = readonly ? hint : '点一下改这一格（它进的是内核的填写项写路径：留痕、机读、门控都一样）';
    return `<span class="fe${item.humanConfirmed ? '' : ' pending'}" contenteditable="false"`
      + ` data-field-node="${esc(item.id)}" title="${esc(title)}">${label}<b>${value}</b>${unit}</span>`;
  }

  function renderUnits(items, options) {
    const opts = options || {};
    const readonly = opts.readonly === true;
    const hint = String(opts.readonlyHint || '当前不可修改');
    const annotations = Array.isArray(opts.annotations) ? opts.annotations : [];
    const units = [];
    for (const unit of planOf(items)) {
      if (unit.type === 'section') {
        const item = unit.item;
        units.push({
          key: `sec:${item.id}`,
          kind: 'section',
          nodeIds: [item.id],
          html: `<div class="fsec" data-sec-id="${esc(item.id)}"><span class="fsec-title">${esc(item.title)}</span></div>`,
        });
        continue;
      }
      if (unit.type === 'card') {
        units.push({
          key: `card:${unit.item.id}`,
          kind: 'card',
          nodeIds: [unit.item.id],
          html: `<div class="fcard">${window.L0DocView.nodeHtml(unit.item, {
            readonly,
            readonlyHint: hint,
            clinical: opts.clinical === true,
            annotations,
          })}</div>`,
        });
        continue;
      }
      const body = unit.blocks.map((block) => {
        const textItem = block.items.find((item) => item.kind === 'text');
        const content = block.items.map((item) => (item.kind === 'text'
          ? runsHtml(item)
          : fieldHtml(item, readonly, hint))).join('');
        const deco = block.items
          .filter((item) => item.kind === 'text')
          .map((item) => paragraphDecoHtml(item, annotations))
          .join('');
        const imageEntry = readonly || !block.paragraphId
          ? ''
          : `<span class="fp-deco" contenteditable="false" data-para-deco="1"><button class="fp-image" data-para-image="${esc(block.paragraphId)}" title="在这一段后面贴一张图（只收 PNG / JPEG / WebP，上限 8 MB）">＋图</button></span>`;
        const attrs = [
          `class="fp${textItem ? '' : ' fp-notext'}${textItem && textItem.pageBreakBefore ? ' pb-before' : ''}"`,
          block.paragraphId ? `data-para-id="${esc(block.paragraphId)}"` : '',
          block.nodeId ? `data-node-id="${esc(block.nodeId)}"` : '',
          textItem ? `data-node-rev="${esc(textItem.rev)}"` : '',
        ].filter((text) => text !== '').join(' ');
        /* 空段落：给一个 `<br>`，否则一个空的块在浏览器里塌成 0 高度、点不进去 */
        return `<div ${attrs}>${content === '' ? '<br>' : content}${deco}${imageEntry}</div>`;
      }).join('');
      units.push({
        key: unit.key,
        kind: 'segment',
        nodeIds: unit.blocks.flatMap((block) => block.items.map((item) => item.id)),
        html: `<div class="fbody${readonly ? ' ro' : ''}" data-flow-seg="${esc(unit.key)}"`
          + ` data-flow-sec="${esc(unit.sectionId || '')}"`
          + ` contenteditable="${readonly ? 'false' : 'true'}"`
          + `${readonly ? ` title="${esc(hint)}"` : ''}>${body}</div>`,
      });
    }
    return units;
  }

  function render(items, options) {
    const units = renderUnits(items, options);
    if (units.length === 0) return '<div class="empty">本份病历暂无内容节点。</div>';
    return units.map((unit) => unit.html).join('');
  }

  function readBlock(el) {
    const runs = [];
    const fields = [];
    let text = '';
    const walk = (node, marks) => {
      for (const child of Array.from(node.childNodes)) {
        if (child.nodeType === 3) {
          const value = child.nodeValue || '';
          if (value === '') continue;
          runs.push(marks.length > 0 ? { text: value, marks: [...marks] } : { text: value });
          text += value;
          continue;
        }
        if (child.nodeType !== 1) continue;
        if (child.dataset && child.dataset.paraDeco) continue;
        if (child.dataset && child.dataset.fieldNode) {
          fields.push(child.dataset.fieldNode);
          continue;
        }
        if (child.tagName === 'BR') continue;
        const mark = TAG_MARKS[child.tagName];
        const next = mark ? [...marks, mark] : marks;
        walk(child, next);
      }
    };
    walk(el, []);
    return { text, runs: runs.filter((run) => run.text !== ''), fields };
  }

  function readBlocks(host) {
    const blocks = [];
    for (const el of Array.from(host.children)) {
      if (!el.classList || !el.classList.contains('fp')) continue;
      const read = readBlock(el);
      blocks.push({
        paragraphId: el.dataset.paraId || null,
        nodeId: el.dataset.nodeId || null,
        text: read.text,
        runs: read.runs,
        fields: read.fields,
        el,
      });
    }
    return blocks;
  }

  function marksKey(runs) {
    return (runs || []).map((run) => `${(run.marks || []).join('+')}:${run.text.length}`).join('|');
  }

  function carryProvenance(baselineRuns, newRuns) {
    const ranges = [];
    let cursor = 0;
    for (const run of baselineRuns || []) {
      const length = (run.text || '').length;
      if (run.provenance) ranges.push({ start: cursor, end: cursor + length, provenance: run.provenance });
      cursor += length;
    }
    if (ranges.length === 0) return newRuns;
    let offset = 0;
    return newRuns.map((run) => {
      const start = offset;
      const end = offset + (run.text || '').length;
      offset = end;
      const hit = ranges.find((range) => range.start <= start && end <= range.end);
      return hit ? { ...run, provenance: hit.provenance } : run;
    });
  }

  function diff(segment, domBlocks) {
    const ops = [];
    const blocked = [];
    const baseline = segment.blocks || [];
    const byNodeId = new Map();
    for (const block of domBlocks) if (block.nodeId) byNodeId.set(block.nodeId, block);

    domBlocks.forEach((block, index) => {
      const previous = index > 0 ? domBlocks[index - 1] : null;
      const anchor = previous ? (previous.nodeId || null) : null;
      if (!block.nodeId) {
        ops.push({ op: 'insert', afterNodeId: anchor, text: block.text, origin: block.origin || 'human' });
        return;
      }
      const base = baseline.find((candidate) => candidate.nodeId === block.nodeId);
      if (!base) {
        ops.push({ op: 'insert', afterNodeId: anchor, text: block.text });
        return;
      }
      const baseFields = (base.fields || []).map((item) => item.id).join(',');
      if (baseFields !== block.fields.join(',')) {
        blocked.push(`「${base.text.slice(0, 12) || '（空段）'}」这一节里的填写项被增删了：填写项不能靠打字改动（它进的是另一条写路径），请用卡片模式调整。`);
        return;
      }
      const textChanged = base.text !== block.text;
      const marksChanged = marksKey(base.runs) !== marksKey(block.runs);
      if (!textChanged && !marksChanged) return;
      if (marksChanged) {
        /* 格式变了：文本没变就按位移搬来源；文本也变了就不搬（位置对不上，搬了是错的） */
        const runs = textChanged ? block.runs : carryProvenance(base.runs || [{ text: base.text }], block.runs);
        ops.push({ op: 'runs', nodeId: block.nodeId, runs });
        return;
      }
      ops.push({ op: 'edit', nodeId: block.nodeId, text: block.text });
    });

    for (const base of baseline) {
      if (!base.nodeId) continue;
      if (!byNodeId.has(base.nodeId)) ops.push({ op: 'delete', nodeId: base.nodeId });
    }
    return { ops, blocked };
  }

  function caretOf(host) {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return null;
    const range = selection.getRangeAt(0);
    if (!host.contains(range.startContainer)) return null;
    const blocks = Array.from(host.children).filter((el) => el.classList && el.classList.contains('fp'));
    for (let index = 0; index < blocks.length; index += 1) {
      const block = blocks[index];
      if (!block.contains(range.startContainer)) continue;
      const prefix = document.createRange();
      prefix.selectNodeContents(block);
      try {
        prefix.setEnd(range.startContainer, range.startOffset);
      } catch {
        return { index, offset: 0, endOffset: null };
      }
      return { index, offset: prefix.toString().length, endOffset: null };
    }
    return null;
  }

  /** 还原光标（重画之后调用）。越界一律夹回，宁可落在段末，也不要丢到别处 */
  function setCaret(host, caret) {
    if (!caret) return false;
    const blocks = Array.from(host.children).filter((el) => el.classList && el.classList.contains('fp'));
    const block = blocks[caret.index];
    if (!block) return false;
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    let remaining = caret.offset;
    let node = walker.nextNode();
    while (node) {
      const length = (node.nodeValue || '').length;
      if (remaining <= length) {
        const range = document.createRange();
        range.setStart(node, remaining);
        range.collapse(true);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        return true;
      }
      remaining -= length;
      node = walker.nextNode();
    }
    const range = document.createRange();
    range.selectNodeContents(block);
    range.collapse(false);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  }

  function blockAt(host, node) {
    const blocks = Array.from(host.children).filter((el) => el.classList && el.classList.contains('fp'));
    for (let index = 0; index < blocks.length; index += 1) {
      if (blocks[index].contains(node)) return { index, el: blocks[index] };
    }
    return null;
  }

  function offsetIn(block, node, offset) {
    const range = document.createRange();
    range.selectNodeContents(block);
    try {
      range.setEnd(node, offset);
    } catch {
      return 0;
    }
    return range.toString().length;
  }

  window.L0FlowView = {
    esc,
    render,
    renderUnits,
    planOf,
    readBlocks,
    readBlock,
    diff,
    carryProvenance,
    caretOf,
    setCaret,
    blockAt,
    offsetIn,
    marksToHtml,
    MARK_TAGS,
  };
})();
