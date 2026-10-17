/* 自由流式视图：**一份渲染 + 一份解析**（经典脚本，挂在 `window.L0FlowView`）。
 *
 * 与 `doc-view.js` 的分工（两者都必须在页面脚本之前 `<script src="...">`）：
 *   · `doc-view.js` = 卡片模式（一段一张卡片，每段一个输入框）；
 *   · `flow-view.js` = 流式模式（正文是一整片纸，段落是纸上的块，光标能跨段流动）。
 *
 * ## 为什么流式模式需要"解析"这一半
 * 卡片模式的每个段落是一个独立控件（`textarea`），它自己就知道"我这段改成了什么"。
 * 流式模式没有这个能力：整片纸是一个可编辑区，浏览器只会交回一棵 DOM 树。
 * 所以必须有一半代码负责把 DOM 读回成"每段现在是什么"，再与服务端下发的状态比对，
 * 才知道该发哪些写操作 —— 这就是 `plan` / `diff` 两个函数存在的理由。
 *
 * ## 三条设计约束（都不是可选项）
 *
 * 1. **只有"带文本节点的段落"进可编辑区**。
 *    填写项（`field`）、表格、专科控件**不参与**这片可编辑区：它们各自要么是
 *    独立控件（`<input>` 放进可编辑区会把光标流打断，且浏览器行为在跨段选区时不可预期），
 *    要么是整块的表单。所以可编辑区被它们**切成若干段**（本文件称 segment）——
 *    段与段之间是普通的块级卡片。代价：跨过一张表的"整段选中"选不了，
 *    这是刻意的边界，不是遗漏。
 *
 * 2. **换行只能是段落边界，绝不能进 runs**。
 *    模型里"一段里有多行"是不存在的状态（机读信息、WS/T 500 共享文档、OFD 导出全都按段落组织）。
 *    因此本文件的解析**不产生 `\n`**：回车由 ui.js 转成结构操作（拆段），
 *    粘贴的多行由 ui.js 转成多个段落。把 `\n` 塞进 runs 会得到一份"看起来正常、
 *    导出时才露馅"的病历。
 *
 * 3. **来源（provenance）不从 DOM 读**。
 *    DOM 里只有格式（`<b>` / `<u>`…），没有来源 —— 浏览器不提供"这段字是谁写的"。
 *    来源由内核维护（`core/text-runs.ts`：新插入的 run 不继承来源），
 *    界面只在**文本一字未动、只改了格式**时按位移把来源搬过去（`carryProvenance`），
 *    因为那种情况下位置一一对应、搬过去是准确的。
 */
(function () {
  'use strict';

  function esc(text) {
    return String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /** 标记 → 标签。顺序即嵌套顺序（由内到外），保证 `runHtml` 与 `marksOf` 互逆 */
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

  /**
   * 一个 run → HTML。
   *
   * `AI 起草` 的 run 用 `span.run-ai` 包一层：**只是显示**（点线 + 悬停说明），
   * 解析时不读它（来源不从 DOM 读，见文件头第 3 条）。
   * 医生在一句 AI 起草的话中间插字之后，那一段里会出现没有该 span 的字符 ——
   * 这正是"逐句可分辨"在界面上的样子。
   */
  function runHtml(run, fallback) {
    const inner = marksToHtml(run);
    const provenance = run.provenance || fallback || null;
    if (!provenance) return inner;
    if (provenance.origin === 'ai') {
      const conf = typeof provenance.confidence === 'number' ? `，置信度 ${Number(provenance.confidence).toFixed(2)}` : '';
      const model = provenance.modelId ? `${esc(String(provenance.modelId))}` : '（未记模型）';
      return `<span class="run-ai" title="这几句由 AI 起草（${model}${conf}）：采纳它的是人，责任也在人">${inner}</span>`;
    }
    if (provenance.origin === 'imported') {
      return `<span class="run-imported" title="这几句来自外部文件 / 剪贴板，未逐句核对">${inner}</span>`;
    }
    return inner;
  }

  /** 整段文本 → HTML（`runs` 缺省时按"一个纯文本 run"处理，与"下发了一份无标记 runs"等价） */
  function runsHtml(item) {
    const runs = Array.isArray(item.runs) && item.runs.length > 0
      ? item.runs
      : [{ text: item.text || '' }];
    /* 节点级来源作为兜底：run 自己没有来源时继承节点级（这条规则只有一处，见 types.ts 的 RunProvenance） */
    const fallback = { origin: item.origin, modelId: item.modelId, confidence: item.confidence };
    return runs.map((run) => runHtml(run, fallback)).join('');
  }

  /**
   * 视图项 → **渲染计划**。
   *
   * 计划与渲染必须来自同一处：两者各判一次"哪些段落进可编辑区"，
   * 迟早会出现"界面把两段画进了同一个区、解析却认为是两个区"，
   * 而那种错法表现为"改 A 段的内容跑到了 B 段"，且两边都不报错。
   */
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
      /* 表格 / 专科控件 / 没有文本节点的填写项：整块画成卡片，可编辑区在它这里断开 */
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
      /* 同一段落的文本与填写项归到同一个块：块的键是**段落 id**，不是文本节点 id ——
         段落才是"一整行"的单位，而一行里可能既有字又有格子。 */
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
        /* 一个段落里理论上只挂一个文本节点（模型如此），真出现两个时后者覆盖前者 ——
           不静默：多出来的那个仍然画出来（见渲染），只是不作为可编辑文本的载体 */
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

  /**
   * 段末的**只读装饰**：来源 / 关键内容 / 待确认 / 质控提示。
   *
   * 三条取舍：
   *   ① **只摆"需要动作"的状态**。卡片模式每段头上是一条密排表头（人工 · 已确认 · rev…），
   *      纸面上照搬会把正文淹掉，所以「人工」与「已确认」这两个默认态不占位 ——
   *      "这一段没有待确认标记"就是已确认。这条差异是刻意的，不是漏了。
   *   ② 包一层 `contenteditable="false"` + `data-para-deco`：纸面是一个整体可编辑区，
   *      落在 `.fp` 里的任何元素都会被浏览器当成正文，解析时也会被读成正文
   *      （解析器按 `data-para-deco` 整块跳过）。
   *   ③ 放在**段末**而不是段首：段首是医生最常落笔的位置，装饰挡在那里会吃掉第一次点击。
   */
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

  /**
   * 计划 → HTML。
   *
   * `options.readonly`：已签章 / 已归档时整片纸不可改（`contenteditable="false"`），
   * 理由由 `readonlyHint` 给 —— 只读而不给理由，人只会当成界面卡了。
   */
  function render(items, options) {
    const opts = options || {};
    const readonly = opts.readonly === true;
    const hint = String(opts.readonlyHint || '当前不可修改');
    const plan = planOf(items);
    if (plan.length === 0) return '<div class="empty">本份病历暂无内容节点。</div>';
    const parts = [];
    /* 质控提示：卡片分支与纸面分支都要用，取一次 */
    const annotations = Array.isArray(opts.annotations) ? opts.annotations : [];
    for (const unit of plan) {
      if (unit.type === 'section') {
        const item = unit.item;
        /* 章节标题上**不摆**状态徽标：关键内容 / 待确认是**节点级**的（标在文本节点上），
           而一个章节下面可能有好几段，摆在标题上会指向错的地方 ——
           "这一节里有关键内容"与"这一段是关键内容"是两句话。 */
        parts.push(`<div class="fsec" data-sec-id="${esc(item.id)}"><span class="fsec-title">${esc(item.title)}</span></div>`);
        continue;
      }
      if (unit.type === 'card') {
        /* 卡片：**画的就是卡片模式那一份**（`L0DocView.nodeHtml`），
           所以表格与专科控件在两种模式下长得一样、行为也一样 ——
           各自再画一份的结果是"同一个控件在两种模式里少了样东西"。 */
        parts.push(`<div class="fcard">${window.L0DocView.nodeHtml(unit.item, {
          readonly,
          readonlyHint: hint,
          clinical: opts.clinical === true,
          annotations,
        })}</div>`);
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
        /* 贴图入口：跟**段落**走（不跟 text 走 —— 段落里可以没有文本节点），
           放在段末并与状态徽标一样用 `data-para-deco` 包起来，解析器整块跳过。
           为什么纸面上也要放：流式视图是医生默认待的地方，若只有卡片模式能贴图，
           实际表现就是"看着能写、贴不了图"。做成低对比小按钮，不抢正文。 */
        const imageEntry = readonly || !block.paragraphId
          ? ''
          : `<span class="fp-deco" contenteditable="false" data-para-deco="1"><button class="fp-image" data-para-image="${esc(block.paragraphId)}" title="在这一段后面贴一张图（只收 PNG / JPEG / WebP，上限 8 MB）">＋图</button></span>`;
        const attrs = [
          `class="fp${textItem ? '' : ' fp-notext'}"`,
          block.paragraphId ? `data-para-id="${esc(block.paragraphId)}"` : '',
          block.nodeId ? `data-node-id="${esc(block.nodeId)}"` : '',
          /* rev 只作为属性挂着，由 CSS 在**演示模式**用 `::after` 显示出来。
             为什么不直接写进 DOM 文本：纸面是可编辑区，写进去就进了正文，
             解析时会当成医生打的字写回模型（见文件头第 3 条）。 */
          textItem ? `data-node-rev="${esc(textItem.rev)}"` : '',
        ].filter((text) => text !== '').join(' ');
        /* 空段落：给一个 `<br>`，否则一个空的块在浏览器里塌成 0 高度、点不进去 */
        return `<div ${attrs}>${content === '' ? '<br>' : content}${deco}${imageEntry}</div>`;
      }).join('');
      parts.push(`<div class="fbody${readonly ? ' ro' : ''}" data-flow-seg="${esc(unit.key)}"`
        + ` data-flow-sec="${esc(unit.sectionId || '')}"`
        + ` contenteditable="${readonly ? 'false' : 'true'}"`
        + `${readonly ? ` title="${esc(hint)}"` : ''}>${body}</div>`);
    }
    return parts.join('');
  }

  /* ------------------------------- 解析（DOM → 段落） ------------------------------- */

  /**
   * 一个段落块 → `{ text, runs, fields }`。
   *
   * `fields` 是块里被识别的填写项节点 id（按出现顺序）：它用于**拒绝**那些
   * "靠打字把填写项删掉/搬走"的编辑 —— 填写项不是正文，它的增删必须走结构操作。
   */
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
        /* 段末装饰（来源 / 关键内容 / 待确认 / 质控徽标）：**整块跳过**。
           它们是"给医生看的状态"，不是正文；读进段落文本的后果是
           下次落笔把这些字当成医生打的字写回模型（于是"待确认"三个字成了病历内容）。 */
        if (child.dataset && child.dataset.paraDeco) continue;
        if (child.dataset && child.dataset.fieldNode) {
          /* 填写项：**它的字不进段落文本**（它是另一个节点，值是另存的），
             但要把"它还在、排在第几位"记下来 —— 填写项不能靠打字增删。
             ⚠️ 只记 id 序列，**不记"文字被浏览器切成了几段"**：
             文本节点的切分方式随输入过程变化（打一个字就可能把一段文字拆成两个节点），
             拿它当判据会把每一次正常输入都误判成"填写项被搬动了"。 */
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

  /** 可编辑区 → 段落数组（顺序即界面顺序） */
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

  /* ------------------------------- 比对（DOM ↔ 模型） ------------------------------- */

  function marksKey(runs) {
    return (runs || []).map((run) => `${(run.marks || []).join('+')}:${run.text.length}`).join('|');
  }

  /**
   * 把基线里的**来源**按位移搬到新 runs 上（只在文本一字未动时调用）。
   *
   * 为什么需要它：DOM 读不回来源（浏览器不提供"这段字是谁写的"），
   * 而"只加了粗"这件事不该让"这几句是 AI 起草的"标记消失。
   * 位置一一对应是前提 —— 文本变了就别搬（搬了就是错位），由调用方保证。
   */
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

  /**
   * 一个可编辑区 → **待落笔的操作序列**（`/api/apply-edits` 的 `ops`）。
   *
   * 与卡片模式最大的不同：这里判的是"结构差"，不是"某个控件的值变了"。
   * 因此它天然覆盖了卡片模式覆盖不到的动作：拆段、合段、跨段改写、
   * 以及"选中三段一起删掉"（那就是三条 delete）。
   *
   * 返回 `{ ops, blocked }`：
   *   · `blocked` 非空表示这份改动**不能整批落笔**（例如填写项被删掉了），
   *     界面必须把它说出来并退回原状 —— 静默丢弃医生打的字，比报错糟得多。
   */
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
        /* 界面上新出来的一段（回车拆段 / 多行粘贴）：结构操作 —— 建段落 */
        ops.push({ op: 'insert', afterNodeId: anchor, text: block.text, origin: block.origin || 'human' });
        return;
      }
      const base = baseline.find((candidate) => candidate.nodeId === block.nodeId);
      if (!base) {
        /* 库里没有这个 id：理论上不该发生（id 只由服务端给）。当成新段处理比丢掉医生的字安全 */
        ops.push({ op: 'insert', afterNodeId: anchor, text: block.text });
        return;
      }
      /* 填写项：**数量与顺序必须一模一样**。它们不是正文，靠打字增删是模型之外的动作。
         比的是 id 序列（不是"界面上那几个字"）：值本身就存在节点里，
         拿节点的值去比会变成"改没改过这一格"的重复判断，而那件事由 set-field 负责。 */
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

    /* 从界面上消失的段落 → 删段落。放在最后：先改文本再删，
       这样"合段"（把第二段并进第一段、再删掉第二段）的顺序是对的 ——
       反过来的话，删掉的那一段里的字会先丢。 */
    for (const base of baseline) {
      if (!base.nodeId) continue;
      if (!byNodeId.has(base.nodeId)) ops.push({ op: 'delete', nodeId: base.nodeId });
    }
    return { ops, blocked };
  }

  /* ------------------------------- 光标 ------------------------------- */

  /**
   * 记下光标位置（块序号 + 块内字符偏移）。
   *
   * 为什么要"块序号 + 偏移"而不是直接存 Range：落笔之后界面会按服务端的新状态重画，
   * 原来那个 Range 的锚点节点已经被替换掉了，存了也用不了。
   * 块序号在重画前后是稳定的（顺序由服务端给），偏移做一次夹取即可。
   */
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
    /* 落在段末（或这一段是空的 `<br>`）：把光标放到块末尾 */
    const range = document.createRange();
    range.selectNodeContents(block);
    range.collapse(false);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  }

  /** 当前块与它在同区里的序号（回车拆段 / 退格合段要用） */
  function blockAt(host, node) {
    const blocks = Array.from(host.children).filter((el) => el.classList && el.classList.contains('fp'));
    for (let index = 0; index < blocks.length; index += 1) {
      if (blocks[index].contains(node)) return { index, el: blocks[index] };
    }
    return null;
  }

  /** 光标在一个块里的字符偏移（要跨子节点累加，不能只看 range.startOffset） */
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
