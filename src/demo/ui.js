const $ = (id) => document.getElementById(id);
const L0_BASE = (document.documentElement && document.documentElement.dataset.l0Base) || '';
let S = null;
const pendingEdits = new Map();
let blurTimer = null;
const TAB_KEY = 'l0demo.activeTab';

const MODE_KEY = 'l0demo.viewMode';
let viewMode = (() => {
  try { return localStorage.getItem(MODE_KEY) === 'clinical' ? 'clinical' : 'demo'; } catch { return 'demo'; }
})();

function isClinical() { return viewMode === 'clinical'; }

const EDIT_MODE_KEY = 'l0demo.editMode';
let editMode = (() => {
  try { return localStorage.getItem(EDIT_MODE_KEY) === 'flow' ? 'flow' : 'card'; } catch { return 'card'; }
})();

function isFlow() { return editMode === 'flow'; }

const THEME_KEY = 'l0demo.theme';
let theme = (() => {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch { }
  try { return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; }
  catch { return 'light'; }
})();
function applyTheme() {
  document.documentElement.dataset.theme = theme;
  const button = $('btnTheme');
  if (button) button.textContent = theme === 'dark' ? '☀' : '◐';
}
applyTheme();

const DOC_FONT_KEY = 'l0demo.docFont';
const DOC_FONT_STEPS = [14, 16, 18, 20];
let docFont = (() => {
  let saved = NaN;
  try { saved = Number(localStorage.getItem(DOC_FONT_KEY)); } catch { }
  return DOC_FONT_STEPS.indexOf(saved) >= 0 ? saved : DOC_FONT_STEPS[0];
})();

function applyDocFont() {
  document.documentElement.style.setProperty('--fs-doc', `${docFont}px`);
  const now = $('docFontNow');
  if (now) now.textContent = String(docFont);
  const wrap = $('docFont');
  if (!wrap) return;
  const at = DOC_FONT_STEPS.indexOf(docFont);
  wrap.querySelectorAll('[data-font]').forEach((button) => {
    const delta = Number(button.dataset.font);
    button.disabled = delta < 0 ? at <= 0 : at >= DOC_FONT_STEPS.length - 1;
  });
}

function stepDocFont(delta) {
  const at = DOC_FONT_STEPS.indexOf(docFont);
  const next = DOC_FONT_STEPS[Math.min(DOC_FONT_STEPS.length - 1, Math.max(0, at + delta))];
  if (next === docFont) return;
  docFont = next;
  try { localStorage.setItem(DOC_FONT_KEY, String(docFont)); } catch { }
  applyDocFont();
}

applyDocFont();

const PAPER_KEY = 'l0demo.paper';
let paperMode = (() => {
  try { return localStorage.getItem(PAPER_KEY) === '1'; } catch { return false; }
})();

function ptToPx(pt) {
  return `${Math.round(Number(pt || 0) * 96 / 72)}px`;
}

function applyPaper() {
  const wrap = document.querySelector('.doc-wrap');
  const button = $('btnPaper');
  if (wrap) wrap.classList.toggle('paper', paperMode);
  if (button) {
    button.setAttribute('aria-pressed', paperMode ? 'true' : 'false');
    button.classList.toggle('on', paperMode);
  }
  const paper = S && S.paper ? S.paper : null;
  if (!paper) return;
  const root = document.documentElement;
  root.style.setProperty('--paper-w', ptToPx(paper.widthPt));
  root.style.setProperty('--paper-h', ptToPx(paper.heightPt));
  root.style.setProperty('--paper-m', ptToPx(paper.marginPt));
}

function togglePaper() {
  paperMode = !paperMode;
  try { localStorage.setItem(PAPER_KEY, paperMode ? '1' : '0'); } catch { }
  applyPaper();
  if (paperMode) {
    toast('纸张视图：按 A4 纸面预览。真正的分页与页码由导出端的排版决定', 'info');
  }
}

function ensurePrintPageRule() {
  const paper = (S && S.paper) || {};
  const width = Number(paper.widthPt) || 595;
  const height = Number(paper.heightPt) || 842;
  const margin = Number(paper.marginPt) || 56;
  const binding = Number(paper.bindingMarginPt) || 0;
  const style = $('printPageRule');
  if (!style) return;
  style.textContent = `@page { size: ${width}pt ${height}pt; margin: ${margin}pt ${margin}pt ${margin}pt ${margin + binding}pt; }`;
}

function printDoc() {
  ensurePrintPageRule();
  window.print();
}

let previewLayout = null;

function ensurePreviewPageRule() {
  const style = $('printPageRule');
  if (!style || !previewLayout) return;
  style.textContent = `@page { size: ${previewLayout.widthPt}pt ${previewLayout.heightPt}pt; margin: 0; }`;
}

function previewLine(line, extraClass) {
  const el = document.createElement('div');
  el.className = extraClass ? `pv-line ${extraClass}` : 'pv-line';
  el.style.left = `${line.x}pt`;
  el.style.top = `${line.y - line.size}pt`;
  el.style.fontSize = `${line.size}pt`;
  if (line.bold) el.style.fontWeight = '600';
  if (line.image) {
    el.classList.add('pv-image');
    el.style.width = `${line.image.widthPt}pt`;
    el.style.height = `${line.image.heightPt}pt`;
    el.textContent = line.image.altText || '［图片］';
    return el;
  }
  el.textContent = line.text;
  return el;
}

function previewFormal() {
  const status = (S && S.doc && S.doc.status) || (previewLayout && previewLayout.status) || 'draft';
  return status === 'signed' || status === 'archived';
}

function renderPreview() {
  const host = $('previewPages');
  if (!host || !previewLayout) return;
  const layout = previewLayout;
  host.textContent = '';
  const formal = previewFormal();

  for (const page of layout.pages) {
    const sheet = document.createElement('div');
    sheet.className = 'pv-page';
    sheet.style.width = `${layout.widthPt}pt`;
    sheet.style.height = `${layout.heightPt}pt`;

    const guide = document.createElement('div');
    guide.className = 'pv-guide';
    guide.style.left = `${layout.content.left}pt`;
    guide.style.top = `${layout.content.top - layout.lineHeightPt}pt`;
    guide.style.width = `${layout.content.maxWidth}pt`;
    guide.style.height = `${layout.content.bottom - layout.content.top + layout.lineHeightPt}pt`;
    sheet.appendChild(guide);

    if (page.header) {
      sheet.appendChild(previewLine({ x: layout.furniture.x, y: layout.furniture.headerY, size: layout.furniture.size, text: page.header }, 'pv-furniture'));
    }
    if (page.footer) {
      sheet.appendChild(previewLine({ x: layout.furniture.x, y: layout.furniture.footerY, size: layout.furniture.size, text: page.footer }, 'pv-furniture'));
    }
    for (const line of page.lines) sheet.appendChild(previewLine(line));
    if (!formal) {
      const mark = document.createElement('div');
      mark.className = 'pv-watermark';
      mark.textContent = '草稿 · 未生效';
      sheet.appendChild(mark);
    }
    host.appendChild(sheet);
  }

  const meta = $('previewMeta');
  if (meta) meta.textContent = `${layout.pages.length} 页 · 正文 ${layout.stats.lines} 行 · 纸面 ${layout.widthPt}×${layout.heightPt}pt`;
  const chip = $('previewState');
  if (chip) {
    chip.className = formal ? 'chip ok' : 'chip warn';
    chip.textContent = formal ? '正式件' : '草稿件（打印件不是正式病历）';
  }
}

async function openPreview() {
  const dialog = $('previewDialog');
  if (!dialog) return;
  const res = await api('/api/layout');
  if (!res || res.ok !== true || !res.data) {
    toast(`分页预览失败：${(res && (res.message || res.code)) || '服务端没有返回排版结果'}`, 'danger');
    return;
  }
  previewLayout = res.data;
  renderPreview();
  if (!dialog.open) dialog.showModal();
  document.body.classList.add('preview-open');
  const button = $('previewPrint');
  if (button) button.focus();
}

function closePreview() {
  const dialog = $('previewDialog');
  if (!dialog) return;
  if (dialog.open) dialog.close();
  document.body.classList.remove('preview-open');
  const opener = $('btnPreview');
  if (opener) opener.focus();
}

function printPreview() {
  if (!previewLayout) return;
  ensurePreviewPageRule();
  document.body.classList.add('printing-preview');
  window.print();
}

{
  const dialog = $('previewDialog');
  if (dialog) {
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) closePreview();
    });
    dialog.addEventListener('close', () => document.body.classList.remove('preview-open'));
  }
  const opener = $('btnPreview');
  if (opener) opener.addEventListener('click', () => { void openPreview(); });
  const closer = $('previewClose');
  if (closer) closer.addEventListener('click', closePreview);
  const printer = $('previewPrint');
  if (printer) printer.addEventListener('click', printPreview);
}

window.addEventListener('beforeprint', () => {
  if (document.body.classList.contains('printing-preview')) ensurePreviewPageRule();
  else ensurePrintPageRule();
});

window.addEventListener('afterprint', () => {
  document.body.classList.remove('printing-preview');
  if (previewLayout) ensurePrintPageRule();
});

function markDirty(kind, id, value) {
  pendingEdits.set(kind + ':' + id, { kind, id, value });
}

function isEditor(el) {
  return !!(el && el.dataset && (el.dataset.edit || el.dataset.field || el.dataset.controlField));
}

let inflight = 0;

function hostBridge() {
  return (typeof window === 'undefined' ? null : window.__L0_HOST__) || null;
}

function hostEmit(type, payload) {
  const bridge = typeof window === 'undefined' ? null : window.L0Host;
  if (bridge && typeof bridge.emit === 'function') bridge.emit(type, payload);
}

/** 默认传输：同源 fetch。宿主未注入时的行为与引入注入点之前逐字节一致 */
async function sameOriginFetch(path, body) {
  const res = await fetch(`${L0_BASE}${path}`, body === undefined
    ? { method: 'GET' }
    : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return res.json();
}

async function api(path, body) {
  const bar = $('busyBar');
  inflight += 1;
  if (bar) bar.hidden = false;
  try {
    const bridge = hostBridge();
    const injected = bridge && bridge.transport && bridge.transport.request;
    const request = typeof injected === 'function' ? injected : sameOriginFetch;
    return await request(path, body);
  } finally {
    inflight -= 1;
    if (inflight === 0 && bar) bar.hidden = true;
  }
}

function esc(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const TABS = ['ai', 'voice', 'qc', 'timeline', 'compare', 'previsit', 'discharge', 'machine', 'export', 'log', 'metrics'];
const OPTIONAL_TABS = ['compare', 'previsit', 'discharge', 'export', 'log', 'metrics'];
let activeTab = (() => {
  try { return localStorage.getItem(TAB_KEY) || 'ai'; } catch { return 'ai'; }
})();
if (!TABS.includes(activeTab)) activeTab = 'ai';

function setMoreMenu(open) {
  const menu = $('moreMenu');
  if (!menu) return;
  const more = $('btnMoreTabs');
  if (open && more) {
    menu.style.top = `${Math.round(more.offsetTop)}px`;
    menu.style.bottom = 'auto';
  }
  menu.hidden = !open;
  if (more) more.setAttribute('aria-expanded', String(open));
  syncMoreButton();
}

function syncMoreButton() {
  const button = $('btnMoreTabs');
  const menu = $('moreMenu');
  if (!button || !menu) return;
  button.classList.toggle('active', !menu.hidden || OPTIONAL_TABS.includes(activeTab));
  const log = S && Array.isArray(S.log) ? S.log : [];
  const hasReject = log.some((item) => item.ok === false);
  button.classList.toggle('alert', hasReject);
  button.title = hasReject ? '更多页签（门控日志里有被拒记录）' : '装不下的页签收在这里（点开可切换）';
}

function layoutRailTabs() {
  const bar = $('tabbar');
  const menu = $('moreMenu');
  const more = $('btnMoreTabs');
  if (!bar || !menu || !more) return;
  for (const key of TABS) {
    const tab = bar.querySelector(`[data-tab="${key}"]`) || menu.querySelector(`[data-tab="${key}"]`);
    if (tab) bar.insertBefore(tab, more);
  }
  more.hidden = false;
  const innerBottom = () => {
    const rect = bar.getBoundingClientRect();
    return rect.bottom - parseFloat(getComputedStyle(bar).paddingBottom || '0');
  };
  for (let guard = TABS.length + 1; guard > 0; guard -= 1) {
    const rows = [...bar.children].filter((el) => el.classList.contains('tab') && el !== more);
    const lastRow = rows[rows.length - 1];
    const tail = more.hidden ? lastRow : more;
    if (!tail || tail.getBoundingClientRect().bottom <= innerBottom() + 0.5) break;
    if (!lastRow) break;
    menu.insertBefore(lastRow, menu.firstChild);
  }
  more.hidden = menu.children.length === 0;
  syncMoreButton();
}

function syncHeaderHeight() {
  const header = document.querySelector('header');
  if (!header) return;
  const height = Math.round(header.getBoundingClientRect().height);
  if (height > 0) document.documentElement.style.setProperty('--header-h', `${height}px`);
}

let railLayoutTimer = null;
function relayoutRail() {
  clearTimeout(railLayoutTimer);
  railLayoutTimer = setTimeout(() => {
    syncHeaderHeight();
    layoutRailTabs();
  }, 120);
}
window.addEventListener('resize', relayoutRail);
window.addEventListener('load', relayoutRail);

let dismissedRejectAt = null;

function renderRejectBanner() {
  const banner = $('rejectBanner');
  if (!banner) return;
  const log = S && Array.isArray(S.log) ? S.log : [];
  const latest = log.find((item) => item.ok === false);
  const shouldShow = !!latest && latest.at !== dismissedRejectAt;
  banner.hidden = !shouldShow;
  if (!latest || !shouldShow) return;
  banner.innerHTML = `<b>最近一次被拒</b>
    ${isClinical() ? '' : `<span class="chip danger">${esc(latest.code || '')}</span>`}
    <span class="grow">${esc(latest.action || '')}：${esc(latest.message || '')}</span>
    <button id="btnOpenLog">查看门控日志</button>
    <button id="btnDismissReject" title="先收起来（再次被拒时仍会出现）" aria-label="收起被拒横幅">×</button>`;
}

function applyPanelState() {
  for (const panel of document.querySelectorAll('.panel')) {
    panel.classList.toggle('active', panel.dataset.panel === activeTab);
  }
  /* 当前面板被收起时，它的页签要留个记号：面板整块不在了，
     "再点这一下能放回来"就只能由页签自己说出来 */
  const activePanel = document.querySelector('.panel.active');
  const folded = !!activePanel && activePanel.classList.contains('is-collapsed');
  const mainEl = document.querySelector('main');
  if (mainEl) mainEl.classList.toggle('rail-folded', folded);
  for (const tab of document.querySelectorAll('.tab, .more-item')) {
    const current = tab.dataset.tab === activeTab;
    const on = current && !folded;
    tab.classList.toggle('active', on);
    tab.classList.toggle('is-folded', current && folded);
    if (tab.dataset.tab) tab.setAttribute('aria-selected', String(on));
  }
  syncMoreButton();
}
function switchTab(key) {
  if (!TABS.includes(key)) return;
  activeTab = key;
  try { localStorage.setItem(TAB_KEY, key); } catch { }
  const panel = document.querySelector(`.panel[data-panel="${key}"]`);
  if (panel && panel.classList.contains('is-collapsed')) {
    collapsedPanels.delete(panelKeyOf(panel));
    saveSet(PH_KEY, collapsedPanels);
    applyPanelCollapsed(panel, false);
  }
  applyPanelState();
  autosizeAll();
}
applyPanelState();

const PH_KEY = 'l0demo.collapsedPanels';
const collapsedPanels = loadSet(PH_KEY);

function panelKeyOf(panel) {
  return panel.dataset.panel || 'panel';
}

function applyPanelCollapsed(panel, collapsed) {
  panel.classList.toggle('is-collapsed', collapsed);
  for (const button of panel.querySelectorAll('.ph-toggle')) {
    const label = collapsed ? '展开面板' : '收起面板';
    button.setAttribute('aria-expanded', String(!collapsed));
    button.setAttribute('aria-label', label);
    button.title = label;
  }
  applyPanelState();
}

function expandPanel(panel) {
  if (!panel) return;
  collapsedPanels.delete(panelKeyOf(panel));
  saveSet(PH_KEY, collapsedPanels);
  applyPanelCollapsed(panel, false);
  /* 收着时量出来的编辑框高度是 0，展开后必须重量一次，否则框是压扁的 */
  autosizeAll();
}

function collapsePanel(panel) {
  if (!panel) return;
  collapsedPanels.add(panelKeyOf(panel));
  saveSet(PH_KEY, collapsedPanels);
  applyPanelCollapsed(panel, true);
}

function togglePanelCollapsed(button) {
  const panel = button.closest('.panel');
  if (!panel) return;
  if (panel.classList.contains('is-collapsed')) expandPanel(panel);
  else collapsePanel(panel);
}

function toggleActivePanelCollapse() {
  const panel = document.querySelector('.panel.active');
  if (!panel) return;
  if (panel.classList.contains('is-collapsed')) expandPanel(panel);
  else collapsePanel(panel);
}

function initPanelToggles() {
  for (const panel of document.querySelectorAll('.panel')) {
    for (const ph of panel.querySelectorAll(':scope > .ph')) {
      if (ph.hasAttribute('data-no-fold')) continue;
      if (ph.querySelector('[data-ph-toggle]')) continue;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'ph-toggle';
      button.dataset.phToggle = panelKeyOf(panel);
      button.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M4 6l4 4 4-4"/></svg>';
      ph.append(button);
    }
    applyPanelCollapsed(panel, collapsedPanels.has(panelKeyOf(panel)));
  }
  applyPanelState();
}
initPanelToggles();

const CAPABILITIES = ['qc', 'finalize', 'log', 'metrics', 'import'];

function capabilityOff(name) {
  const caps = (hostBridge() || {}).capabilities;
  return !!(caps && caps[name] === false);
}

function applyCapabilities() {
  document.querySelectorAll('[data-capability]').forEach((el) => {
    if (capabilityOff(el.dataset.capability)) el.remove();
  });
  const menu = $('moreMenu');
  if (menu && menu.children.length === 0) {
    const more = $('btnMoreTabs');
    if (more) more.remove();
  }
  if (!document.querySelector(`[data-tab="${activeTab}"]`)) {
    const fallback = TABS.find((name) => document.querySelector(`[data-tab="${name}"]`));
    if (fallback) {
      switchTab(fallback);
      return;
    }
  }
  applyPanelState();
}

function panelAlive(name) {
  return !!document.querySelector(`[data-panel="${name}"]`);
}

/** 编辑框随内容自增高度：内容必须完整可见，不能在框内滚动 */
function autosizeAll() {
  for (const el of document.querySelectorAll('textarea.editor')) {
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + 2}px`;
  }
}

const VISIT_LABEL = { outpatient: '门诊', inpatient: '住院', emergency: '急诊', 'physical-exam': '体检' };
const GENDER_LABEL = { M: '男', F: '女', U: '未知' };
const DOC_STATUS_LABEL = { draft: '草稿', reviewing: '审核中', signed: '已签章', archived: '已归档', void: '已作废' };

function renderHeader() {
  const p = S.patient, e = S.encounter, d = S.doc;
  $('patientCard').innerHTML = `
    <div>
      <div class="name">${esc(p.nameMasked || p.patientId)}</div>
      <div class="meta">${esc(GENDER_LABEL[p.gender] || '未知')} ${p.age == null ? '' : p.age + '岁'} · 病案号 ${esc(p.patientId)}</div>
    </div>
    <div class="divider"></div>
    <div>
      <div class="doc-title">${esc(d.docType)}</div>
      <div class="meta">${esc(VISIT_LABEL[e.visitType] || e.visitType || '—')} · ${esc(e.deptName || e.dept || '—')} · ${esc(e.visitDate || '')}${e.visitId ? ' · ' + esc(e.visitId) : ''}</div>
    </div>`;
  $('docStatus').textContent = `${DOC_STATUS_LABEL[d.status] || d.status}${isClinical() ? '' : ` · rev ${d.rev}`}`;
}

const TREE_KEY = 'l0demo.collapsedTree';

function loadSet(key) {
  try { return new Set(JSON.parse(localStorage.getItem(key) || '[]')); } catch { return new Set(); }
}
function saveSet(key, set) {
  try { localStorage.setItem(key, JSON.stringify([...set])); } catch { }
}
const collapsedTree = loadSet(TREE_KEY);

const STATUS_LABEL = { draft: '草稿', reviewing: '审核中', signed: '已签章', archived: '已归档', void: '作废' };

function renderTree() {
  const patients = S.tree || [];
  const docCount = patients.reduce((sum, patient) => sum + patient.visits.reduce((n, visit) => n + visit.docs.length, 0), 0);
  $('treeSummary').textContent = `${patients.length} 患者 / ${docCount} 份`;

  $('tree').innerHTML = patients.map((patient) => {
    const groupKey = `p:${patient.patientId}`;
    const collapsed = collapsedTree.has(groupKey);
    const visits = patient.visits.map((visit) => {
      const visitKey = `v:${visit.visitId}`;
      const visitCollapsed = collapsedTree.has(visitKey);
      const docRows = visit.docs.map((doc) => {
        const mark = [STATUS_LABEL[doc.status] ?? doc.status, doc.pending > 0 ? `待处理建议${doc.pending}` : '', doc.unconfirmed > 0 ? `待确认${doc.unconfirmed}` : '', doc.machineStale ? '机读陈旧' : (doc.machineCount > 0 ? '机读最新' : '')]
          .filter(Boolean)
          .join(' · ');
        const dot = doc.machineStale ? 'danger' : (doc.unconfirmed > 0 ? 'warn' : (doc.status === 'signed' ? 'ok' : ''));
        const sections = doc.sections.map((section) => {
          const required = section.required
            ? `<span class="chip mini${section.requiredEmpty ? ' warn' : ''}"
                title="${section.requiredEmpty
                  ? '必备章节：这一章还没有内容。它删不掉（模板里标了必备），签章前请写清'
                  : '必备章节：这一章删不掉（模板里标了必备）'}">必备${section.requiredEmpty ? '·还没写' : ''}</span>`
            : '';
          const hint = section.description
            ? `<div class="sec-hint">${esc(section.description)}</div>`
            : '';
          return `
          <div class="trow section" style="padding-left:${8 + (section.depth || 0) * 12}px"><span class="dot ${section.hasUnconfirmed ? 'warn' : 'ok'}"></span><span class="ttl">${esc(section.title)}</span>${required}${section.hasUnconfirmed ? `<button class="mini-btn" data-confirm-subtree="${esc(section.id)}" title="确认「${esc(section.title)}」整章内容，范围与条数会记入留痕">确认本章</button>` : ''}${hint}</div>`;
        }).join('');
        const deletable = doc.status === 'draft';
        return `<div class="trow doc ${doc.active ? 'active' : ''}" data-doc="${esc(doc.docId)}" title="${esc(doc.title)} · ${esc(mark)}｜${esc(doc.docId)}">
            <span class="dot ${dot}"></span><span class="ttl">${esc(doc.title)}</span>
            ${deletable ? `<button class="mini-btn doc-del" data-doc-delete="${esc(doc.docId)}" title="删除这份草稿：正文、留痕与旁挂数据一并删除，不可恢复">删除</button>` : ''}
          </div>${doc.active ? sections : ''}`;
      }).join('');
      return `<div class="trow visit" data-toggle="${esc(visitKey)}">
          <span class="caret">${visitCollapsed ? '▸' : '▾'}</span>
          <span class="ttl">${esc(visit.date)} ${esc(VISIT_LABEL[visit.visitType] || visit.visitType)} ${esc(visit.dept)}</span>
        </div>${visitCollapsed ? '' : docRows}`;
    }).join('');
    return `<div class="trow patient" data-toggle="${esc(groupKey)}">
        <span class="caret">${collapsed ? '▸' : '▾'}</span>
        <span class="ttl">${esc(patient.nameMasked)} ${esc(GENDER_LABEL[patient.gender] || '')} ${patient.age}岁</span>
      </div>${collapsed ? '' : visits}`;
  }).join('');
}

/** 插入段落后把光标放进新段落（否则用户还得自己在几十段里找刚建好的那一段） */
function focusEdit(nodeId) {
  const el = document.querySelector(`[data-edit="${nodeId}"]`);
  if (el) el.focus();
}

const IMAGE_MAX_BYTES = 8 * 1024 * 1024;

function pickImageFile() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/webp';
    input.addEventListener('change', () => {
      const picked = input.files && input.files.length > 0 ? input.files[0] : null;
      resolve(picked);
    }, { once: true });
    input.addEventListener('cancel', () => resolve(null), { once: true });
    input.click();
  });
}

function readImageAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve(String(reader.result || '')));
    reader.addEventListener('error', () => reject(new Error('E_READ')));
    reader.readAsDataURL(file);
  });
}

async function uploadPickedImage() {
  const file = await pickImageFile();
  if (!file) return null;
  if (file.size > IMAGE_MAX_BYTES) {
    await apply({
      ok: false,
      code: 'E_IMAGE_TOO_LARGE',
      message: `这张图 ${(file.size / 1024 / 1024).toFixed(1)} MB，超过上限 ${IMAGE_MAX_BYTES / 1024 / 1024} MB`,
    });
    return null;
  }
  let dataUrl = '';
  try {
    dataUrl = await readImageAsDataUrl(file);
  } catch {
    await apply({ ok: false, code: 'E_IMAGE_READ', message: '读不了这个文件（可能没有权限，或已被移走）' });
    return null;
  }
  const uploaded = await api('/api/image-upload', { dataBase64: dataUrl });
  if (!uploaded.ok) {
    await apply(uploaded);
    return null;
  }
  return { resource: uploaded.data || {}, name: String(file.name || '').replace(/\.[^.]+$/, '') };
}

let lastDocSnapshot = null;

function cssQuote(value) {
  if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(String(value));
  return String(value).replace(/["\\]/g, '\\$&');
}

function captureScrolls(from) {
  const saved = [];
  for (let node = from; node; node = node.parentElement) {
    if (node.scrollTop) saved.push([node, node.scrollTop]);
  }
  return saved;
}

function restoreScrolls(saved) {
  for (const [node, top] of saved || []) {
    if (node && node.isConnected) node.scrollTop = top;
  }
}

function captureFieldFocus() {
  const active = document.activeElement;
  if (!active || typeof active.closest !== 'function' || !active.closest('#docBody')) return null;
  const data = active.dataset || {};
  const key = data.edit || data.field || data.controlField;
  if (!key) return null;
  let start = null;
  let end = null;
  try {
    start = active.selectionStart;
    end = active.selectionEnd;
  } catch { }
  return { key, start, end };
}

function restoreFieldFocus(saved) {
  if (!saved) return;
  const quote = cssQuote;
  const el = document.querySelector(`[data-edit="${quote(saved.key)}"]`)
    || document.querySelector(`[data-field="${quote(saved.key)}"]`)
    || document.querySelector(`[data-control-field="${quote(saved.key)}"]`);
  if (!el || typeof el.focus !== 'function') return;
  el.focus();
  if (saved.start !== null && saved.start !== undefined) {
    try { el.setSelectionRange(saved.start, saved.end === null ? saved.start : saved.end); } catch { }
  }
}

function renderDocFull(want) {
  const body = $('docBody');
  if (!body) return;
  const scrolls = captureScrolls(body);
  if (want.mode === 'flow') {
    const caret = pendingCaret;
    pendingCaret = null;
    body.innerHTML = L0FlowView.render(want.items, {
      readonly: want.readonly,
      readonlyHint: want.readonlyHint,
      clinical: want.clinical,
      annotations: want.annotations,
    });
    restoreScrolls(scrolls);
    if (caret) {
      const host = flowHostOf(caret.key);
      if (host) {
        if (caret.focus === true) host.focus();
        L0FlowView.setCaret(host, caret.at);
      }
    }
    return;
  }
  const focus = captureFieldFocus();
  body.innerHTML = L0DocView.nodesHtml(want.items, {
    readonly: want.readonly,
    readonlyHint: want.readonlyHint,
    clinical: want.clinical,
    annotations: want.annotations,
  });
  restoreScrolls(scrolls);
  restoreFieldFocus(focus);
}

function patchDoc(decision, want) {
  const body = $('docBody');
  if (!body) return false;
  return want.mode === 'flow'
    ? patchFlowDoc(body, decision, want)
    : patchCardDoc(body, decision, want);
}

function patchCardDoc(body, decision, want) {
  const items = want.items;
  const children = Array.from(body.children);
  if (children.length !== items.length) return false;
  const replace = new Set(decision.replace);
  const textOnly = new Set(decision.textOnly);
  const scrolls = captureScrolls(body);
  const focus = captureFieldFocus();
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!replace.has(item.id)) continue;
    const el = children[index];
    if (!el || el.dataset.nodeId !== item.id) return false;
    if (textOnly.has(item.id) && isTextUnchangedInCard(el, item)) {
      const rev = el.querySelector('.rev');
      if (rev) rev.textContent = `${item.id} · rev ${item.rev}`;
      continue;
    }
    el.outerHTML = L0DocView.nodeHtml(item, {
      readonly: want.readonly,
      readonlyHint: want.readonlyHint,
      clinical: want.clinical,
      annotations: want.annotations,
    });
  }
  restoreScrolls(scrolls);
  restoreFieldFocus(focus);
  return true;
}

function isTextUnchangedInCard(el, item) {
  if (!item || item.kind !== 'text') return false;
  const area = el.querySelector('textarea[data-edit]');
  return !!area && area.value === String(item.text === undefined ? '' : item.text);
}

function patchFlowDoc(body, decision, want) {
  const units = L0FlowView.renderUnits(want.items, {
    readonly: want.readonly,
    readonlyHint: want.readonlyHint,
    clinical: want.clinical,
    annotations: want.annotations,
  });
  const indexOfNode = new Map();
  const indexOfKey = new Map();
  units.forEach((unit, index) => {
    indexOfKey.set(unit.key, index);
    for (const id of unit.nodeIds) indexOfNode.set(id, index);
  });

  const replace = new Set(decision.replace);
  const textOnly = new Set(decision.textOnly);
  const dirty = new Set();
  for (const nodeId of replace) {
    const index = indexOfNode.get(nodeId);
    if (index === undefined) return false;
    const unit = units[index];
    const peersDirty = unit.nodeIds.some((id) => id !== nodeId && replace.has(id));
    if (textOnly.has(nodeId) && !peersDirty) {
      const item = want.items.find((entry) => entry.id === nodeId);
      const host = body.querySelector(`[data-flow-seg="${cssQuote(unit.key)}"]`);
      const blockEl = host ? host.querySelector(`[data-node-id="${cssQuote(nodeId)}"]`) : null;
      const parsed = blockEl ? L0FlowView.readBlock(blockEl) : null;
      if (item && parsed && parsed.text === String(item.text === undefined ? '' : item.text)) {
        if (blockEl.dataset) blockEl.dataset.nodeRev = String(item.rev);
        continue;
      }
    }
    dirty.add(index);
  }

  const scrolls = captureScrolls(body);
  const focus = captureFieldFocus();
  const activeHost = document.activeElement && typeof document.activeElement.closest === 'function'
    ? document.activeElement.closest('[data-flow-seg]')
    : null;
  const caret = activeHost
    ? { key: activeHost.dataset.flowSeg, at: L0FlowView.caretOf(activeHost), focus: true }
    : null;

  for (const index of Array.from(dirty).sort((a, b) => b - a)) {
    const unit = units[index];
    const el = unitElement(body, unit);
    if (!el) return false;
    el.outerHTML = unit.html;
  }
  restoreScrolls(scrolls);
  restoreFieldFocus(focus);
  if (caret && indexOfKey.has(caret.key) && dirty.has(indexOfKey.get(caret.key))) {
    const host = flowHostOf(caret.key);
    if (host) {
      host.focus();
      L0FlowView.setCaret(host, caret.at);
    }
  }
  return true;
}

function unitElement(body, unit) {
  if (!body || !unit) return null;
  if (unit.kind === 'section') return body.querySelector(`[data-sec-id="${cssQuote(unit.nodeIds[0])}"]`);
  if (unit.kind === 'card') {
    const inner = body.querySelector(`[data-node-id="${cssQuote(unit.nodeIds[0])}"]`);
    return inner && typeof inner.closest === 'function' ? inner.closest('.fcard') : null;
  }
  return body.querySelector(`[data-flow-seg="${cssQuote(unit.key)}"]`);
}

function docStatsSuffix() {
  const items = Array.isArray(S.items) ? S.items : [];
  const paragraphs = new Set();
  let chars = 0;
  let unconfirmed = 0;
  for (const item of items) {
    if (!item || item.kind === 'section') continue;
    if (item.kind === 'text') {
      if (item.paragraphId) paragraphs.add(item.paragraphId);
      chars += String(item.text || '').replace(/\s+/g, '').length;
    }
    if (item.humanConfirmed === false) unconfirmed += 1;
  }
  if (paragraphs.size === 0 && chars === 0) return '';
  const parts = [`${chars} 字`, `${paragraphs.size} 段`];
  if (unconfirmed > 0) parts.push(`${unconfirmed} 处待确认`);
  return ` · ${parts.join(' · ')}`;
}

function renderDoc() {
  $('docMeta').textContent = `${S.doc.docType} · ${S.doc.docId}${docStatsSuffix()}`;
  const signed = S.doc.status === 'signed';
  const immutable = signed || S.doc.status === 'archived';
  /* 禁用/只读控件必须带原因：不给理由的只读只会被当成"界面卡了" */
  const immutableHint = S.doc.status === 'archived'
    ? '已归档：归档是终态，不可修改'
    : '已签章：需先「解锁修改」才能改动（会留痕并作废本次签章），改完重新签章';
  $('docNotice').textContent = S.doc.status === 'archived'
    ? '本文档已归档：归档是终态，不可修改也不可解锁。需要修改请重新开具一份。'
    : signed
      ? '本文档已签章：内容不可修改。需要修改请到「定稿与导出」点「解锁修改」（会留痕并作废本次签章），改完重新签章。'
      : docNotice;
  const undo = S.undo;
  const undoButton = $('btnUndo');
  if (undoButton) {
    undoButton.title = undo
      ? `撤销 / 历史版本：可撤销第 ${undo.rev} 条（${undo.op}），也能回到最近 15 次里的任意一版`
      : '历史版本：最近 15 次写入（当前没有可撤销的写入；签章 / 解锁之后不可撤销）';
  }
  const derivedRow = $('derivedRow');
  if (derivedRow) {
    const derived = Number(S.derivedCount ?? 0);
    derivedRow.classList.toggle('hide', derived === 0);
    $('derivedHint').textContent = derived === 0
      ? ''
      : `本文书有 ${derived} 个派生值：按控件公式计算；输入项填好后点一次（手改过的不动，缺输入的不编数）。`;
  }
  const conflictRow = $('sidecarConflictRow');
  if (conflictRow) {
    const conflicted = !!((S.sidecar || {}).conflict);
    conflictRow.classList.toggle('hide', !conflicted);
    if (conflicted) {
      $('sidecarConflictHint').textContent =
        '本终端最近的改动没能落盘（磁盘上那一版来自另一处）。重新载入会放弃本终端尚未落盘的建议与注解处置；正文、留痕与签名不受影响。';
    }
  }

  const want = {
    docId: S.doc.docId,
    mode: isFlow() ? 'flow' : 'card',
    readonly: immutable,
    readonlyHint: immutableHint,
    clinical: isClinical(),
    annotations: S.annotations || [],
    items: S.items || [],
  };
  const decision = typeof L0PatchPlan !== 'undefined' && L0PatchPlan
    ? L0PatchPlan.planDoc(lastDocSnapshot, want)
    : { mode: 'full', reason: 'no-planner', replace: [], textOnly: [] };
  if (decision.mode === 'full') {
    renderDocFull(want);
  } else if (decision.mode === 'patch') {
    if (!patchDoc(decision, want)) {
      renderDocFull(want);
    } else {
      pendingCaret = null;
    }
  }
  lastDocSnapshot = want;
  if (want.mode === 'flow') {
    flowBaselineRev = typeof S.doc.rev === 'number' ? S.doc.rev : null;
  }
  applyPaper();
}

/* 跨文书一致性区块。放在「质控提示」面板里，它本身就是质控的一种，
   不另开页签（页签表达载体，不是功能）。 */
function renderConsistency() {
  const result = S.consistency;
  if (!result) {
    $('consistencyHint').textContent = '';
    $('consistency').innerHTML = '';
    return;
  }
  const issues = result.issues || [];
  $('consistencyHint').textContent = `已比对 ${result.scanned} 份文书，发现 ${issues.length} 处不一致`;
  if (issues.length === 0) {
    $('consistency').innerHTML = '<div class="empty">未发现编码级不一致（会自然变化的指标不在此列）。</div>';
    return;
  }
  $('consistency').innerHTML = issues
    .map((issue) => {
      const key = `${issue.tag.system}|${issue.tag.code}`;
      const detail = issue.docIds.map((docId, index) => `${esc(docId)}=${esc(issue.values[index])}`).join('，');
      return `<div class="sugg">
        <div class="row">
          <span class="chip ${issue.severity === 'block' ? 'danger' : 'warn'}">${issue.kind === 'identity' ? '身份不一致' : '事实不一致'}</span>
          <span class="chip">${esc(issue.tag.code)}</span>
          <span class="muted push">${esc(detail)}</span></div>
        <div class="mt6"><b>${esc(issue.tag.display)}</b></div>
        <div class="muted">${esc(issue.hint)}</div>
        <div class="row mt8">
          <button data-consistency="${esc(key)}" title="为涉及的每一份文书各生成一条核对建议，以哪一份为准由人工判断">生成核对待办</button>
        </div>
      </div>`;
    })
    .join('');
}

function renderTimeline() {
  const box = $('timeline');
  const trendBox = $('timelineTrend');
  const hint = $('timelineHint');
  const badge = $('badgeTimeline');
  if (!box || !trendBox || !hint || !badge) return;

  const t = S.visitTimeline;
  if (!t) {
    hint.textContent = '还没读过';
    badge.innerHTML = '';
    box.innerHTML = '<div class="empty">尚未读取。点上面的按钮，把本就诊的全部文书按成文时刻排开。</div>';
    trendBox.innerHTML = '';
    return;
  }

  const clock = (value) => {
    if (!value) return '—';
    const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(String(value));
    return match ? `${match[1]} ${match[2]}` : String(value);
  };

  const segmentsFrom = new Map();
  for (const segment of t.segments || []) {
    if (!segmentsFrom.has(segment.fromDocId)) segmentsFrom.set(segment.fromDocId, []);
    segmentsFrom.get(segment.fromDocId).push(segment);
  }

  const signStateOf = (doc) => {
    if (!doc.status) return 'unknown';
    if (doc.status === 'signed') return 'signed';
    if (doc.status === 'archived' || doc.status === 'void') return 'closed';
    return 'unsigned';
  };

  const docLabel = (docId) => {
    const hit = (t.docs || []).find((doc) => doc.docId === docId);
    return hit ? hit.title : String(docId || '');
  };
  const typeNameOf = (code) => {
    const hit = (t.docs || []).find((doc) => doc.docTypeCode === code);
    return (hit && (hit.docTypeDisplay || hit.docTypeCode)) || code || '类型未知';
  };

  const unsigned = (t.docs || []).filter((doc) => signStateOf(doc) === 'unsigned');
  const overdue = (t.segments || []).filter((segment) => segment.exceeds);
  const unwrittenChanges = ((t.trend || {}).changes || []).filter((item) => item.unwritten);

  const todos = [];
  for (const segment of overdue) {
    todos.push({
      kind: 'timeout',
      tag: '<span class="chip danger">超时</span>',
      title: `${typeNameOf(segment.docTypeCode)} 间隔 ${segment.hours.toFixed(1)} 小时，超出时限 ${(segment.hours - segment.limitHours).toFixed(1)} 小时`,
      detail: `${clock(segment.fromAt)} → ${segment.toAt ? clock(segment.toAt) : '判定时刻'}（时限 ${segment.limitHours} 小时）`,
      docId: segment.toDocId || segment.fromDocId,
    });
  }
  for (const doc of unsigned) {
    todos.push({
      kind: 'unsigned',
      tag: '<span class="chip warn">未签</span>',
      title: doc.title,
      detail: `成文 ${clock(doc.createdAt)} · 当前状态 ${doc.status}`,
      docId: doc.docId,
    });
  }
  for (const gap of t.gaps || []) {
    todos.push({
      kind: 'gap',
      tag: `<span class="chip ${gap.severity === 'block' ? 'danger' : 'warn'}">缺口</span>`,
      title: gap.title,
      detail: `${gap.detail}${gap.suggestion ? `　建议：${gap.suggestion}` : ''}`,
      meta: `${gap.ruleId} · ${gap.kind === 'visit-doc-interval' ? '同类文书间隔' : '应有而缺'}`,
      docId: (gap.segment && gap.segment.fromDocId) || null,
    });
  }
  for (const change of unwrittenChanges) {
    todos.push({
      kind: 'unwritten',
      tag: '<span class="chip warn">未写入病程</span>',
      title: `${change.label} ${change.valueText}${change.unit ? ` ${change.unit}` : ''}（${change.flag === 'high' ? '偏高' : '偏低'}）`,
      detail: change.detail,
      docId: null,
    });
  }

  const axis = (t.docs || [])
    .map((doc) => {
      const state = signStateOf(doc);
      const chips = [
        `<span class="chip">${esc(doc.docTypeDisplay || doc.docTypeCode || '类型未知')}</span>`,
        state === 'signed' ? '<span class="chip ok">已签</span>' : '',
        state === 'unsigned' ? '<span class="chip warn">未签</span>' : '',
        state === 'closed' ? `<span class="chip">${doc.status === 'void' ? '已作废' : '已归档'}</span>` : '',
        state === 'unknown' ? '<span class="chip">状态未知</span>' : '',
        doc.isCurrent ? '<span class="chip ok">当前</span>' : '',
        doc.timed ? '' : '<span class="chip danger">成文时刻无法解析</span>',
        doc.hasBody ? '' : '<span class="chip warn">正文读不到</span>',
      ].filter((item) => item !== '').join(' ');
      const rows = (segmentsFrom.get(doc.docId) || [])
        .map((segment) => {
          const right = segment.toDocId ? `下一份 ${esc(docLabel(segment.toDocId))}` : '出院 / 判定时刻';
          return `<div class="tl2-seg${segment.exceeds ? ' bad' : ''}">↓ ${esc(segment.hours.toFixed(1))} 小时（时限 ${esc(String(segment.limitHours))} 小时）→ ${right}${segment.exceeds ? ` ← 超时 ${esc((segment.hours - segment.limitHours).toFixed(1))} 小时` : ''}</div>`;
        })
        .join('');
      return `<div class="tl2-item${doc.isCurrent ? ' cur' : ''}">
        <span class="tl2-dot" aria-hidden="true"></span>
        <div class="row">${chips}</div>
        <div class="tl2-title"><b>${esc(doc.title)}</b> <span class="muted">${esc(clock(doc.createdAt))}</span></div>
        ${rows}
      </div>`;
    })
    .join('');

  const summary = `<div class="row mb8">
    <span class="chip ${todos.length > 0 ? 'warn' : 'ok'}">待办 ${todos.length}</span>
    <span class="chip">超时 ${overdue.length}</span>
    <span class="chip">未签 ${unsigned.length}</span>
    <span class="chip">缺口 ${(t.gaps || []).length}</span>
    <span class="chip">未写入 ${unwrittenChanges.length}</span>
  </div>`;

  const todoHtml = todos.length === 0
    ? '<div class="empty">这条线上没有待办：没有超时、没有未签、没有缺口，参考范围外的变化也都写进了病程。</div>'
    : todos
      .map((todo) => {
        const current = todo.docId && (t.docs || []).some((doc) => doc.docId === todo.docId && doc.isCurrent);
        const action = todo.docId && !current
          ? `<button class="mini-btn" data-open-doc="${esc(todo.docId)}" title="切到这份文书（写不写、签不签仍由人决定）">切到这份</button>`
          : '';
        return `<div class="todo todo-${todo.kind}">
          <div class="row">${todo.tag}${action ? `<span class="push">${action}</span>` : ''}</div>
          <div class="mt6"><b>${esc(todo.title)}</b></div>
          <div class="muted">${esc(todo.detail)}</div>
          ${todo.meta ? `<div class="muted">${esc(todo.meta)}</div>` : ''}
        </div>`;
      })
      .join('');

  const unevaluated = (t.unevaluated || [])
    .map((item) => `<div class="muted">未判定：${esc(item.ruleId)} ${esc(item.reason)}</div>`)
    .join('');
  const notes = (t.notes || []).map((note) => `<div class="muted">${esc(note)}</div>`).join('');

  hint.textContent = `${t.visitId ? `${t.visitId} · ` : ''}${(t.docs || []).length} 份文书 · 待办 ${todos.length}`;
  badge.innerHTML = todos.length > 0
    ? `<span class="chip ${overdue.length > 0 ? 'danger' : 'warn'}">待办 ${todos.length}</span>`
    : `<span class="chip">${(t.docs || []).length} 份文书</span>`;

  box.innerHTML = `
    <div class="muted mb6">就诊窗口：${esc(clock(t.admittedAt))} → ${esc(clock(t.dischargedAt || t.endAt))}${t.dischargedAt ? '（已出院，右端取出院时刻）' : '（未出院，右端取判定时刻）'}</div>
    ${summary}
    <div class="tl2">${axis || '<div class="empty">这次就诊还没有文书。</div>'}</div>
    <div class="mt10"><b>缺什么</b></div>
    ${todoHtml}
    ${unevaluated}
    ${notes}`;

  const trend = t.trend || { changes: [], skipped: [], progressDocIds: [] };
  const written = (trend.changes || []).filter((item) => !item.unwritten);
  const changes = written.length === 0
    ? '<div class="empty">没有已写入的变化（未写入的在上方待办里）。</div>'
    : written
      .map((item) => `<div class="sugg done">
        <div class="row">
          <span class="chip ok">已写入</span>
          <span class="chip">${esc(item.label)}</span>
          <span class="muted push">${esc(clock(item.sampledAt))}</span>
        </div>
        <div class="muted mt6">${esc(item.detail)}</div>
      </div>`)
      .join('');
  const skipped = (trend.skipped || [])
    .map((item) => `<div class="muted">未对照：${esc(item.reason)}（${esc(String(item.count))} 处）</div>`)
    .join('');
  trendBox.innerHTML = `
    <div class="mt10" title="同一编码被后续文书再次记录，或正文里提到该数据元的名称，都算“写进去了”"><b>变化与后续文书的对照</b></div>
    ${changes}
    ${skipped}`;
}

function renderCompare() {
  const box = $('comparePanel');
  const hint = $('compareHint');
  const badge = $('badgeCompare');
  if (!box || !hint || !badge) return;

  const data = S.visitCompare;
  if (!data) {
    hint.textContent = '还没读过';
    badge.innerHTML = '';
    box.innerHTML = '<div class="empty">尚未读取。点上面的按钮，选一份同患者的历史文书与本次并排看。</div>';
    return;
  }

  const candidates = Array.isArray(data.candidates) ? data.candidates : [];
  const compare = data.compare;
  hint.textContent = `${data.patientName || '患者'} · 历史文书 ${candidates.length} 份`;
  badge.innerHTML = compare
    ? `<span class="chip ${compare.changedSections > 0 ? 'warn' : 'ok'}">差异 ${compare.changedSections} 章</span>`
    : `<span class="chip">${candidates.length} 份历史</span>`;

  if (candidates.length === 0) {
    box.innerHTML = '<div class="empty">这位患者没有其他已装载的文书：跨次对比至少要跨两次就诊。</div>';
    return;
  }

  const options = candidates.map((item) => {
    const mark = item.sameDiagnosis ? '同诊断' : '非同一诊断';
    const date = String(item.visitDate || item.createdAt || '').slice(0, 10);
    return `<option value="${esc(item.docId)}"${item.docId === data.chosenDocId ? ' selected' : ''}>${esc(`${date} · ${item.title} · ${mark}`)}</option>`;
  }).join('');
  const picker = `<div class="row mb8">
    <label class="muted" for="comparePick">对比对象</label>
    <select id="comparePick" class="grow">${options}</select>
  </div>`;

  if (!compare) {
    box.innerHTML = `${picker}<div class="empty">没有可对照的历史文书。</div>`;
    return;
  }

  const diag = compare.diagnosis || { shared: [], onlyPrevious: [], onlyCurrent: [] };
  const label = (item) => esc(item.display || item.code);
  const diagChips = [];
  if (compare.sameDiagnosis) {
    diagChips.push('<span class="chip ok">同诊断</span>');
    for (const item of diag.shared) diagChips.push(`<span class="chip">${label(item)}</span>`);
  } else {
    diagChips.push('<span class="chip danger">不是同一诊断</span>');
    for (const item of diag.onlyPrevious) diagChips.push(`<span class="chip">上次 ${label(item)}</span>`);
    for (const item of diag.onlyCurrent) diagChips.push(`<span class="chip">本次 ${label(item)}</span>`);
    if ((diag.onlyPrevious || []).length === 0) diagChips.push('<span class="chip">上次无诊断编码</span>');
    if ((diag.onlyCurrent || []).length === 0) diagChips.push('<span class="chip">本次无诊断编码</span>');
  }

  const rows = Array.isArray(compare.sections) ? compare.sections : [];
  const changed = rows.filter((row) => row.state !== 'same');
  const same = rows.filter((row) => row.state === 'same');
  const stateChip = {
    added: '<span class="chip ok">本次新增</span>',
    removed: '<span class="chip danger">上次有</span>',
    changed: '<span class="chip warn">改写</span>',
  };

  const rowHtml = (row) => {
    const parts = [];
    for (const text of row.removed || []) parts.push(`<div class="cmp-p del">${esc(text)}</div>`);
    for (const text of row.added || []) parts.push(`<div class="cmp-p add">${esc(text)}</div>`);
    if (parts.length === 0) {
      parts.push(`<div class="muted">${row.state === 'added' ? '本次新开了这一章，目前还是空的。' : '这次没有这一章。'}</div>`);
    }
    return `<div class="cmp-row">
      <div class="row">${stateChip[row.state] || ''}<b>${esc(row.title)}</b></div>
      ${parts.join('')}
    </div>`;
  };

  const changedHtml = changed.length === 0
    ? '<div class="empty">两次文书的章节与段落逐字相同 —— 这是"没改动"，不是"没问题"。</div>'
    : changed.map(rowHtml).join('');

  const sameHtml = same.length === 0 ? '' : `<details class="mt10">
    <summary class="muted">另有 ${same.length} 章逐字相同（点开只看章节名）</summary>
    <div class="muted">${same.map((row) => esc(row.title)).join(' · ')}</div>
  </details>`;

  const med = compare.medication || { paragraphs: [], reason: null };
  let medHtml = '';
  if (med.reason) {
    medHtml = `<div class="muted">${esc(med.reason)}</div>`;
  } else {
    const target = data.medicationTarget;
    const action = target
      ? `<button class="mini-btn" data-carry="${esc(target.nodeId)}" title="把上面的原文生成一条建议（不直接写入；采纳与否由人决定）">沿用上次医嘱 → 生成建议</button>`
      : '<span class="muted">本次文书里没有对应的「医嘱 / 用药」章节：先建章节，再谈沿用。</span>';
    medHtml = `${(med.paragraphs || []).map((text) => `<div class="cmp-p med">${esc(text)}</div>`).join('')}
      <div class="row mt6">${action}</div>`;
  }

  const notes = (compare.notes || []).map((note) => `<div class="muted">${esc(note)}</div>`).join('');

  box.innerHTML = `${picker}
    <div class="row mb8">${diagChips.join(' ')}</div>
    ${changedHtml}
    ${sameHtml}
    <div class="mt10"><b>上次的医嘱 / 用药</b>${med.sectionTitle ? `<span class="muted">（${esc(med.sectionTitle)}）</span>` : ''}</div>
    ${medHtml}
    <div class="mt10">${notes}</div>`;
}

function renderDischarge() {
  const box = $('dischargePanel');
  const hint = $('dischargeHint');
  const badge = $('badgeDischarge');
  if (!box || !hint || !badge) return;

  const plan = S.dischargeSummary;
  if (!plan) {
    hint.textContent = '还没读过';
    badge.innerHTML = '';
    box.innerHTML = '<div class="empty">尚未读取。切到出院记录，点上面的按钮，把本次住院的原文汇总进来。</div>';
    return;
  }

  const items = Array.isArray(plan.items) ? plan.items : [];
  const gaps = Array.isArray(plan.gaps) ? plan.gaps : [];
  hint.textContent = `${plan.targetTitle || '本次文书'} · 可派生 ${items.length} 条 · 缺口 ${gaps.length} 条`;
  badge.innerHTML = items.length > 0
    ? `<span class="chip ${gaps.length > 0 ? 'warn' : 'ok'}">可派生 ${items.length}</span>`
    : '<span class="chip danger">无可派生内容</span>';

  const stateChip = {
    new: '<span class="chip ok">本次为空</span>',
    same: '<span class="chip ok">与原文一致</span>',
    changed: '<span class="chip warn">有差异</span>',
  };

  const itemHtml = items.map((item) => {
    const sources = (item.sources || [])
      .map((source) => `<button class="mini-btn" data-open-doc="${esc(source.docId)}" title="切到这份文书核对原文">${esc(source.docTitle)} · ${esc(source.sectionTitle)}</button>`)
      .join(' ');
    const pickable = !!item.targetNodeId;
    return `<div class="sugg">
      <div class="row">
        <input type="checkbox" data-derive-key="${esc(item.key)}"${pickable ? ' checked' : ' disabled'} title="${pickable ? '勾选后会生成一条建议（不落笔）' : '本次文书没有这一章，无法生成建议'}" />
        <b>${esc(item.title)}</b>
        ${stateChip[item.state] || ''}
        ${pickable ? '' : '<span class="chip danger">缺目标章节</span>'}
      </div>
      <div class="mt6">${esc(item.text)}</div>
      <div class="row mt6"><span class="muted">来源</span>${sources || '<span class="muted">没有来源</span>'}</div>
      ${item.state === 'changed' && item.current ? `<div class="muted mt6">本次现有：${esc(item.current)}</div>` : ''}
    </div>`;
  }).join('');

  const gapHtml = gaps.length === 0
    ? '<div class="empty">没有缺口：该有的源文书与目标章节都在，且都写了内容。</div>'
    : gaps.map((gap) => `<div class="sugg">
        <div class="row"><span class="chip warn">${esc(gap.title)}</span><span class="muted">${esc(gap.code)}</span></div>
        <div class="muted mt6">${esc(gap.detail)}</div>
      </div>`).join('');

  const notes = (plan.notes || []).map((note) => `<div class="muted">${esc(note)}</div>`).join('');
  const applyRow = items.some((item) => item.targetNodeId)
    ? '<div class="row mt10"><button class="primary" id="btnDischargeApply" title="把勾选的原文送进建议通道（不落笔；采纳后仍需人工确认）">生成建议（不落笔）</button></div>'
    : '';

  box.innerHTML = `
    ${itemHtml || '<div class="empty">这次没有可派生的内容。</div>'}
    <div class="mt10"><b>缺口</b><span class="muted">（派生不出来的原因，逐条对应一份文书或一章）</span></div>
    ${gapHtml}
    ${applyRow}
    <div class="mt10">${notes}</div>`;
}

function renderPrevisit() {
  const box = $('previsitPanel');
  const hint = $('previsitHint');
  const badge = $('badgePrevisit');
  if (!box || !hint || !badge) return;

  const when = (iso) => {
    const time = new Date(String(iso));
    return Number.isNaN(time.getTime()) ? String(iso) : time.toLocaleString('zh-CN', { hour12: false });
  };

  const data = S.previsit;
  if (!data || data.ok !== true) {
    hint.textContent = '读不到';
    badge.innerHTML = '<span class="chip danger">不可用</span>';
    box.innerHTML = `<div class="empty">${esc(data && data.message ? data.message : '预问诊记录读不到')}</div>`;
    return;
  }

  const record = data.record;
  const items = Array.isArray(data.items) ? data.items : [];
  if (!record) {
    hint.textContent = '没有记录';
    badge.innerHTML = '';
    box.innerHTML = `<div class="empty">这位患者还没有预问诊单。
      <div class="mt6">数据由接口写入（候诊时患者自填，或 HIS 预问诊端代传）：<code>POST /api/previsit/intake</code></div>
      <div class="mt6 muted">写入后刷新即可见。系统不替患者填，也不替你判断。</div></div>`;
    return;
  }

  hint.textContent = `${items.length} 条`;
  const missing = items.filter((item) => !item.hasTarget).length;
  badge.innerHTML = `<span class="chip ${missing > 0 ? 'warn' : 'ok'}">${items.length - missing}/${items.length} 条有落点</span>`;

  const rows = items.map((item) => `<div class="sugg">
      <div class="row">
        <input type="checkbox" data-previsit-key="${esc(item.key)}"${item.hasTarget ? ' checked' : ' disabled'} title="${item.hasTarget ? '勾选后生成一条建议（不落笔）' : '本次文书没有对应章节，无法生成建议'}" />
        <b>${esc(item.label)}</b>
        <span class="muted">${esc(when(item.reportedAt))}</span>
        ${item.hasTarget ? '' : '<span class="chip danger">本次文书缺该章</span>'}
      </div>
      <div class="mt6">${esc(item.text)}</div>
      <div class="row mt6"><span class="muted">来源</span><span class="chip">${esc(record.source)}</span></div>
    </div>`).join('');

  const anyTarget = items.some((item) => item.hasTarget);
  box.innerHTML = `
    <div class="muted mb10">提交于 ${esc(when(record.submittedAt))} · 读取于 ${esc(when(data.readAt))}</div>
    ${rows}
    ${anyTarget
      ? '<div class="row mt10"><button class="primary" id="btnPrevisitTake" title="把勾选的原文送进建议通道（不落笔；采纳后仍需人工确认）">生成建议（不落笔）</button></div>'
      : '<div class="mt10 muted">这份表单的字段在本次文书里都没有对应章节，无法生成建议。</div>'}`;
}

function applyVisitScope() {
  const available = !!(S && S.encounter && S.encounter.dischargeSummaryAvailable);
  for (const el of document.querySelectorAll('[data-visit-scope="inpatient"]')) {
    el.hidden = !available;
  }
  if (!available && activeTab === 'discharge') switchTab('ai');
}

function renderAnnotations() {
  const list = S.annotations || [];
  const counts = S.annotationCounts || { total: 0, open: 0, acknowledged: 0, dismissed: 0, resolved: 0, anchorLost: 0 };

  const catalog = Array.isArray((S.knowledgePacks || {}).rules) ? S.knowledgePacks.rules : [];
  const packLine = $('qcPackLine');
  if (packLine) {
    packLine.textContent = catalog.length === 0 ? '还没有任何规则：质控当前不可用。' : '';
  }

  const contentLine = $('qcContentLine');
  if (contentLine) {
    const info = S.qcContent;
    contentLine.textContent = !info
      ? ''
      : info.configured
        ? `内涵类质控：引擎已接入，规则 ${info.rules} 条，命中 ${info.findings} 条${info.unevaluated.length > 0 ? `；未判定 ${info.unevaluated.length} 条` : ''}`
        : `内涵类质控：当前不可用${info.reason ? `（${info.reason}）` : '（引擎未接入）'}；规则 ${info.rules} 条，这不代表内容已通过检查`;
    contentLine.className = !info ? 'muted' : info.configured ? 'muted' : 'muted warn-text';
  }

  const unevalLine = $('qcUnevalLine');
  if (unevalLine) {
    const unevaluated = Array.isArray(S.qcUnevaluated) ? S.qcUnevaluated : [];
    /* 同一条规则在多份节点上判不了时理由相同，按理由去重，否则一屏全是同一句话 */
    const reasons = [...new Set(unevaluated.map((item) => String(item.reason ?? '')))].filter((text) => text !== '');
    unevalLine.textContent =
      unevaluated.length === 0 ? '' : `另有 ${unevaluated.length} 条未判定：${reasons.join('；')}`;
  }

  $('badgeQc').innerHTML = `<span class="chip">共 ${counts.total}</span>`
    + (counts.open + counts.acknowledged > 0 ? ` <span class="chip warn">待处理 ${counts.open + counts.acknowledged}</span>` : '')
    + (counts.anchorLost > 0 ? ` <span class="chip danger">锚点丢失 ${counts.anchorLost}</span>` : '');

  if (list.length === 0) {
    $('annotations').innerHTML = '<div class="empty">暂无质控提示。选一个节点并点"提一条质控提示"。</div>';
    return;
  }
  const chipOf = (text, cls) => (text ? `<span class="chip ${cls || ''}">${esc(text)}</span>` : '');
  const severityOf = (value) => ({ info: ['提示', ''], warn: ['警示', 'warn'], block: ['严重', 'danger'] })[value] || [value, ''];
  const statusOf = (value) => ({ open: ['待处理', 'warn'], acknowledged: ['已知悉', ''], dismissed: ['已忽略', ''], resolved: ['已解决', 'ok'] })[value] || [value, ''];

  $('annotations').innerHTML = list.map((a) => {
    const actionable = a.status === 'open' || a.status === 'acknowledged';
    const anchorChip = a.anchorState === 'lost'
      ? chipOf('锚点已失效', 'danger')
      : (a.anchorState === 'relocated' ? chipOf('可重锚（内容已改）', 'warn') : '');
    const actions = actionable
      ? `<div class="row mt8">
           <button class="ok" data-anno-resolve="${esc(a.id)}" data-anno-status="resolved">已按提示修改</button>
           <button data-anno-resolve="${esc(a.id)}" data-anno-status="acknowledged">已知悉，暂不改</button>
           <button class="danger" data-anno-resolve="${esc(a.id)}" data-anno-status="dismissed">误报，忽略</button>
         </div>`
      : '';
    const lostAction = a.anchorState === 'lost' && actionable
      ? `<div class="row mt6"><button data-anno-lost="${esc(a.id)}" title="内容已被删除。锚点丢失不会自己消失，必须有人确认一次">确认锚点已随内容清除</button></div>`
      : '';
    const from = a.ruleId ? `规则 ${esc(a.ruleId)}` : (a.modelId ? `模型 ${esc(a.modelId)}` : '人工批注');
    return `<div class="sugg ${actionable ? '' : 'done'}">
      <div class="row">${chipOf(...severityOf(a.severity))} ${chipOf(...statusOf(a.status))} ${chipOf(a.kind)} ${anchorChip}
        ${isClinical() ? '' : `<span class="muted push">${esc(a.id)} → ${esc(a.nodeId)}</span>`}</div>
      <div class="mt6"><b>${esc(a.title)}</b></div>
      ${a.detail ? `<div class="muted">${esc(a.detail)}</div>` : ''}
      ${a.suggestion ? `<div class="muted">建议：${esc(a.suggestion)}</div>` : ''}
      <div class="muted mt4">${isClinical() ? '' : `来源：${from} · `}${esc(a.createdAt)}</div>
      ${actions}${lostAction}
    </div>`;
  }).join('');
}

const DEFAULT_CAPTURE_CLIENT = '127.0.0.1:8901';

const CAPTURE_CLIENT_KEY = 'l0demo.captureClient';

function readRememberedClient() {
  try {
    const raw = localStorage.getItem(CAPTURE_CLIENT_KEY);
    if (raw === null || raw === '') return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    if (typeof parsed.host !== 'string' || typeof parsed.token !== 'string') return null;
    const host = parsed.host.trim();
    if (host === '') return null;
    return { host, token: parsed.token.trim() };
  } catch {
    return null;
  }
}

function rememberClient(host, token) {
  try {
    const remembered = readRememberedClient();
    if (remembered !== null && remembered.host === host && remembered.token === token) return;
    localStorage.setItem(CAPTURE_CLIENT_KEY, JSON.stringify({ host, token }));
  } catch {
  }
}

function captureClientOf() {
  const params = new URLSearchParams(location.search);
  const host = (params.get('captureClient') || '').trim();
  const token = (params.get('captureToken') || '').trim();
  if (host !== '') {
    rememberClient(host, token);
    return { host, token, base: `http://${host}/dictation-capture` };
  }
  const remembered = readRememberedClient();
  if (remembered !== null) return { ...remembered, base: `http://${remembered.host}/dictation-capture` };
  return { host: DEFAULT_CAPTURE_CLIENT, token: '', base: `http://${DEFAULT_CAPTURE_CLIENT}/dictation-capture` };
}

/** 本机客户端的检测结果（`null` = 正在检测 / 还没检测）。**只读：不打开设备、不发一个字节音频** */
let clientProbe = null;
let clientProbeSeq = 0;
let clientProbeInflight = false;
let clientSource = '';
/** 页面 ↔ 本机客户端的心跳间隔：状态必须能自己变，不能靠人点「重新检测」 */
const CLIENT_HEARTBEAT_MS = 3000;

let localCapture = null;
let localProgressTimer = null;

async function bridgeFetch(client, path, options = {}) {
  const suffix = client.token === '' ? '' : `?token=${encodeURIComponent(client.token)}`;
  const res = await fetch(`${client.base}${path}${suffix}`, {
    method: options.method || 'GET',
    ...(options.body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(options.body) }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (res.status === 401) {
    const payload = await res.json().catch(() => ({}));
    throw Object.assign(new Error(payload.message || '令牌不匹配'), { code: payload.code || 'E_BRIDGE_BAD_TOKEN' });
  }
  return res.json();
}

function describeClientProbeFailure(err) {
  const code = String((err && err.code) || '');
  if (code === 'E_BRIDGE_BAD_TOKEN') {
    return {
      code,
      message: '令牌不匹配（本页地址不是这个客户端给出的）',
      howTo: '在本机重新运行 npm run dictation-client，用它打印的地址打开本页',
    };
  }
  if ((err && err.name) === 'AbortError') {
    return {
      code: 'E_BRIDGE_TIMEOUT',
      message: '本机客户端没有在 2.5s 内应答',
      howTo: '确认客户端仍在运行；安全软件不应拦截 127.0.0.1 的回环连接',
    };
  }
  return {
    code: code || 'E_BRIDGE_UNREACHABLE',
    message: `连不上本机客户端（${(err && err.message) || '连接被拒绝'}）`,
    howTo: '启动本机的「语音采集客户端.exe」（开发时也可 npm run dictation-client），再用它打印的地址打开本页',
  };
}

async function probeCaptureClient() {
  const client = captureClientOf();
  if (client === null) {
    clientProbe = {
      ok: false,
      code: 'E_CLIENT_NOT_WIRED',
      message: '本页不是从本机客户端打开的（地址里没有 captureClient / captureToken）',
      howTo: '启动本机的「语音采集客户端.exe」（开发时也可 npm run dictation-client），再用它打印的地址打开本页',
    };
    renderCaptureLocal();
    renderCaptureButtons();
    return clientProbe;
  }
  if (clientProbeInflight) return clientProbe;
  clientProbeInflight = true;
  const seq = (clientProbeSeq += 1);
  if (clientProbe === null) renderCaptureLocal();
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller === null ? null : setTimeout(() => controller.abort(), 2500);
  let next;
  try {
    const hello = await bridgeFetch(client, '/hello', controller === null ? {} : { signal: controller.signal });
    next = {
      ok: true,
      host: client.host,
      source: String(hello.source || ''),
      sourceProblem: hello.sourceProblem && typeof hello.sourceProblem === 'object' ? hello.sourceProblem : null,
    };
  } catch (err) {
    next = { ok: false, ...describeClientProbeFailure(err) };
  } finally {
    if (timer !== null) clearTimeout(timer);
    clientProbeInflight = false;
  }
  if (seq !== clientProbeSeq) return clientProbe;
  clientProbe = next;
  if (next.ok === true) clientSource = next.source;
  renderCaptureLocal();
  renderCaptureButtons();
  return clientProbe;
}

function fmtSeconds(value) {
  const sec = Math.max(0, Number(value) || 0);
  if (sec < 60) return `${sec.toFixed(1)}s`;
  return `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
}

function updateLocalWave() {
  const wave = $('captureLocalWave');
  if (!wave) return;
  const active = !!(localCapture && localCapture.running);
  wave.hidden = !active;
  if (!active) return;
  const level = Math.max(0, Math.min(1, Number(localCapture.level || 0)));
  wave.style.setProperty('--amp', (level <= 0 ? 0.1 : Math.min(1, Math.sqrt(level) * 2.4)).toFixed(2));
  wave.dataset.voiced = localCapture.voiced === true ? '1' : '0';
}

async function refreshLocalProgress() {
  const client = captureClientOf();
  if (client === null || !localCapture || !localCapture.running) return;
  try {
    const hello = await bridgeFetch(client, '/hello');
    let dirty = false;
    const progress = hello.progress;
    if (progress && typeof progress === 'object') {
      localCapture.elapsedSec = Number(progress.elapsedSec || 0);
      localCapture.currentChunkSec = Number(progress.currentChunkSec || 0);
      localCapture.finalized = Number(progress.finalized || 0);
      localCapture.level = Number(progress.level || 0);
      localCapture.voiced = progress.voiced === true;
      localCapture.clientState = String(progress.state || '');
      localCapture.shortDropped = Number(progress.shortDropped || 0);
      dirty = true;
    }
    if (typeof hello.source === 'string' && hello.source !== '' && hello.source !== clientSource) {
      clientSource = hello.source;
      dirty = true;
    }
    const problem = hello.sourceProblem && typeof hello.sourceProblem === 'object' ? hello.sourceProblem : null;
    const before = localCapture.problem === null ? '' : String(localCapture.problem.code || '');
    const after = problem === null ? '' : String(problem.code || '');
    if (before !== after) {
      localCapture.problem = problem;
      dirty = true;
    }
    if (dirty) renderCaptureLocal();
  } catch {
  }
}

function stopLocalProgressPoll() {
  if (localProgressTimer !== null) {
    clearInterval(localProgressTimer);
    localProgressTimer = null;
  }
}

let reprobeBusy = false;

function capRefreshButton() {
  return `<button class="cap-refresh${reprobeBusy ? ' spinning' : ''}" data-client-reprobe="1"`
    + (reprobeBusy ? ' disabled aria-busy="true"' : '')
    + ' title="重新检测本机客户端（只读探测：不打开设备、不发音频）" aria-label="重新检测本机客户端">'
    /* 顺时针箭头：与"刷新"的通行符号一致，不用文字也不会认错 */
    + '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"'
    + ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">'
    + '<polyline points="23 4 23 10 17 10"></polyline>'
    + '<path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>'
    + '</button>';
}

function capRow(label, valueHtml, cls, action) {
  return `<div class="cap-row"><span class="cap-k">${esc(label)}</span>`
    + `<span class="cap-v${cls ? ` ${cls}` : ''}">${valueHtml}</span>`
    + `<span class="cap-act">${action || ''}</span></div>`;
}

function renderCaptureLocal() {
  const el = $('captureLocalStatus');
  if (!el) return;
  renderCaptureButtons();
  updateLocalWave();
  const client = captureClientOf();
  const reprobe = capRefreshButton();
  const card = (tone, rows, notes) => `<div class="cap-status${tone ? ` ${tone}` : ''}">`
    + rows.join('')
    + (notes.length === 0 ? '' : `<div class="cap-notes">${notes.map((note) => `<div class="cap-note">${note}</div>`).join('')}</div>`)
    + '</div>';

  if (client === null) {
    el.hidden = false;
    el.innerHTML = card('danger', [capRow('本机客户端', '未检测到', 'danger')], []);
    return;
  }
  el.hidden = false;
  if (clientProbe === null) {
    el.innerHTML = card('', [capRow('本机客户端', `正在检测 ${esc(client.host)} …`)], []);
    return;
  }
  const state = localCapture || {};
  const connected = clientProbe.ok === true;
  const asrReady = !!(S && S.capture && S.capture.configured === true);
  const rows = [];
  const notes = [];
  let tone = '';
  const failed = Number(state.failed || 0);

  if (state.running) {
    tone = connected ? 'warn' : 'danger';
    rows.push(capRow(
      '状态',
      !connected
        ? '● 录音中（连接异常）'
        : state.clientState === 'done'
          ? '● 收尾中（客户端已结束录音）'
          : '● 录音中',
      connected ? 'warn' : 'danger',
    ));
    rows.push(capRow('本机客户端', esc(client.host)));
    if (clientSource) rows.push(capRow('采集源', esc(clientSource)));
    rows.push(capRow('已录', fmtSeconds(state.elapsedSec)
      + (Number(state.currentChunkSec || 0) > 0 ? ` · 当前段 ${fmtSeconds(state.currentChunkSec)}` : '')));
    rows.push(capRow('分段', `已定稿 ${Number(state.finalized || 0)} 段 · 已取段 ${Number(state.acked || 0)} 段`
      + (failed > 0 ? ` · 失败 ${failed} 段` : ''), failed > 0 ? 'danger' : ''));
    if (state.message) notes.push(esc(state.message));
    if (state.problem) {
      notes.push(`采集源异常：${esc(state.problem.message)}。怎么办：${esc(state.problem.howTo || '')}`);
    }
    if (!connected) notes.push(`连接中断：${esc(clientProbe.message)}。怎么办：${esc(clientProbe.howTo)}`);
  } else if (!connected) {
    tone = 'danger';
    rows.push(capRow('本机客户端', `不可用 —— ${esc(clientProbe.message)}`, 'danger', reprobe));
    notes.push(`怎么办：${esc(clientProbe.howTo)}。页面每 ${Math.round(CLIENT_HEARTBEAT_MS / 1000)} 秒自动检测一次，也可以手动重试。`);
  } else {
    tone = asrReady ? 'ok' : 'warn';
    rows.push(capRow('本机客户端', `● 已连接<span class="cap-host">${esc(client.host)}</span>`, 'ok', reprobe));
    if (clientSource) rows.push(capRow('采集源', esc(clientSource)));
    rows.push(capRow('语音识别', asrReady ? '已配置' : '未配置（可录，转写会失败）', asrReady ? 'ok' : 'warn'));
    if (state.outcome) {
      rows.push(capRow('上次采集', `用时 ${fmtSeconds(state.elapsedSec)} · 定稿 ${Number(state.finalized || 0)} 段 · 成功 ${Number(state.acked || 0)} 段`
        + (failed > 0 ? ` · 失败 ${failed} 段` : ''), failed > 0 ? 'danger' : ''));
    }
    if (state.message) notes.push(esc(state.message));
    const sourceProblem = state.problem || clientProbe.sourceProblem;
    if (sourceProblem) {
      notes.push(`客户端采集源异常：${esc(sourceProblem.message)}。怎么办：${esc(sourceProblem.howTo || '')}`);
    }
  }
  el.innerHTML = card(tone, rows, notes);
}

function renderCaptureButtons() {
  const start = $('btnCaptureStart');
  const stop = $('btnCaptureStop');
  if (!start || !stop) return;
  const active = !!(localCapture && localCapture.running);
  const clientReady = clientProbe !== null && clientProbe.ok === true;
  start.disabled = active || !clientReady;
  stop.disabled = !active;
  start.textContent = '开始采集';
  start.title = active
    ? '正在采集：先按「停止」结束这一次'
    : !clientReady
      ? (clientProbe === null ? '本机客户端：正在检测…' : `本机客户端：不可用 —— ${clientProbe.message}`)
      : '按本机客户端开始一次采集；中途随时可停，已说出口的段不丢';
}

async function startCapture() {
  await runLocalCapture();
}

async function stopCapture() {
  if (!localCapture || !localCapture.running) return;
  const client = captureClientOf();
  if (client === null) return;
  try {
    await bridgeFetch(client, '/stop', { method: 'POST', body: {} });
  } catch (err) {
    toast(`停止采集失败：${err.code || ''} ${err.message || ''}`, 'danger');
  }
}

async function runLocalCapture() {
  const client = captureClientOf();
  if (client === null) return;
  const probe = clientProbe !== null && clientProbe.ok === true ? clientProbe : await probeCaptureClient();
  if (probe === null || probe.ok !== true) {
    toast(`本机客户端不可用：${probe ? probe.message : '未检测到'}`, 'danger');
    return;
  }
  const segment = (S && S.capture && S.capture.segment) || { silenceMs: 800, maxSeconds: 30, minSeconds: 1 };
  localCapture = {
    running: true,
    acked: 0,
    failed: 0,
    segments: [],
    asrModelId: '',
    sessionId: '',
    message: '正在启动…',
    source: probe.source || '',
    elapsedSec: 0,
    currentChunkSec: 0,
    finalized: 0,
    level: 0,
    voiced: false,
    outcome: '',
    problem: null,
    clientState: '',
    shortDropped: 0,
    startedAt: new Date().toISOString(),
  };
  renderCaptureLocal();
  try {
    const started = await bridgeFetch(client, '/start', { method: 'POST', body: segment });
    if (started.ok !== true) throw Object.assign(new Error(started.message || '开始采集失败'), { code: started.code });
    localCapture.sessionId = String(started.sessionId || '');
    localCapture.message = '采集进行中（音频由本机客户端采集，分片也在客户端）';
    renderCaptureLocal();
    /* 计时与电平要在第一段定稿之前就动起来：否则开头几秒界面是静止的，看起来像"按了没反应" */
    stopLocalProgressPoll();
    localProgressTimer = setInterval(() => { void refreshLocalProgress(); }, 300);

    for (;;) {
      const payload = await bridgeFetch(client, '/next');
      const next = payload.next || {};
      if (next.kind === 'done') {
        localCapture.finalized = Number(next.total || 0);
        await refreshLocalProgress();
        localCapture.message = `采集结束（定稿 ${next.total} 段 / 失败 ${(next.failures || []).length} 段）`;
        localCapture.outcome = localCapture.message;
        break;
      }
      if (next.kind !== 'segment') {
        localCapture.message = '采集进行中（音频由本机客户端采集，分片也在客户端）';
        renderCaptureLocal();
        await new Promise((resolve) => setTimeout(resolve, 250));
        continue;
      }
      const meta = next.segment;
      let ok = true;
      let failure = null;
      try {
        const audio = await fetch(`${client.base}/audio/${meta.index}?token=${encodeURIComponent(client.token)}`);
        if (!audio.ok) throw Object.assign(new Error('取该段音频失败'), { code: 'E_BRIDGE_AUDIO_RELEASED' });
        const blob = await audio.blob();
        const form = new FormData();
        /* 字段名与文件名都按采集路由的契约（服务端只认一个 audio 文件分段） */
        form.append('audio', blob, `${localCapture.sessionId}#${meta.index}.wav`);
        const uploaded = await fetch(`${L0_BASE}/api/dictation/capture/segment?sessionId=${encodeURIComponent(localCapture.sessionId)}&index=${meta.index}`, {
          method: 'POST',
          body: form,
        });
        const result = await uploaded.json();
        if (result.ok !== true) throw Object.assign(new Error(result.message || '上传失败'), { code: result.code });
        if (!localCapture.asrModelId) localCapture.asrModelId = String(result.data.modelId || '');
        localCapture.segments.push({ index: meta.index, text: result.data.text, startSec: meta.startSec, endSec: meta.endSec });
        localCapture.acked += 1;
      } catch (err) {
        ok = false;
        failure = { code: err.code || 'E_CAPTURE_SEGMENT_FAILED', message: err.message || '该段上传失败' };
        localCapture.failed += 1;
      }
      await bridgeFetch(client, '/ack', { method: 'POST', body: { index: meta.index, ok, ...(failure ? failure : {}) } });
      renderCaptureLocal();
    }
  } catch (err) {
    localCapture.message = `本机采集失败：${err.code || ''} ${err.message || ''}`;
    toast(localCapture.message, 'danger');
  } finally {
    stopLocalProgressPoll();
    localCapture.running = false;
    localCapture.voiced = false;
    localCapture.level = 0;
    renderCaptureLocal();
    if (localCapture.segments.length > 0 && localCapture.asrModelId !== '') {
      await apply(
        await api('/api/dictate', {
          transcriptionId: localCapture.sessionId,
          asrModelId: localCapture.asrModelId,
          segments: localCapture.segments.map((item) => ({ index: item.index, text: item.text, startSec: item.startSec, endSec: item.endSec })),
        }),
      );
    }
    void submitCaptureRecord();
  }
}

let captureHistoryLoaded = false;
let captureHistoryDocId = '';
let captureHistorySeq = 0;

async function submitCaptureRecord() {
  const state = localCapture;
  if (!state || !state.startedAt) return;
  const client = captureClientOf();
  try {
    const response = await api('/api/dictation/capture/session', {
      at: state.startedAt,
      docTitle: (S && S.doc && S.doc.docType) || '',
      device: clientSource || state.source || '',
      client: client === null ? '' : client.host,
      elapsedSec: state.elapsedSec,
      total: state.finalized,
      uploaded: state.acked,
      failed: state.failed,
      shortDropped: state.shortDropped || 0,
      asrConfigured: !!(S && S.capture && S.capture.configured),
      asrModel: state.asrModelId || '',
      problem: state.problem ? String(state.problem.code || '') : '',
    });
    if (response && response.ok === true) await renderCaptureHistory(true);
  } catch {
  }
}

function formatRecordTime(iso) {
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return String(iso || '');
  const pad = (value) => String(value).padStart(2, '0');
  return `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

const RECORD_OUTCOME = {
  ok: '<span class="chip ok">全部转写成功</span>',
  partial: '<span class="chip warn">部分失败</span>',
  failed: '<span class="chip danger">没有一段成功</span>',
};

async function renderCaptureHistory(force) {
  const el = $('captureHistory');
  if (!el) return;
  const docId = (S && S.activeDocId) || '';
  if (docId === '') {
    captureHistoryLoaded = false;
    captureHistoryDocId = '';
    el.hidden = true;
    el.innerHTML = '';
    return;
  }
  /* 切过病历就必须重读：见 `captureHistoryDocId` 的说明 */
  if (captureHistoryLoaded && force !== true && captureHistoryDocId === docId) return;
  const seq = ++captureHistorySeq;
  let data = null;
  try {
    const response = await api(`/api/dictation/capture/records?docId=${encodeURIComponent(docId)}`);
    if (response && response.ok === true) data = response.data || null;
  } catch {
  }
  if (seq !== captureHistorySeq || docId !== ((S && S.activeDocId) || '')) return;
  captureHistoryLoaded = true;
  captureHistoryDocId = docId;
  const records = data && Array.isArray(data.records) ? data.records : [];
  if (records.length === 0) {
    el.hidden = true;
    el.innerHTML = '';
    return;
  }
  const rows = records.slice(0, 20).map((record) => {
    const detail = `${fmtSeconds(record.elapsedSec)} · 定稿 ${record.total} 段 · 成功 ${record.uploaded} / 失败 ${record.failed}`
      + (Number(record.shortDropped) > 0 ? ` / 过短丢弃 ${record.shortDropped}` : '');
    const extra = (record.asrConfigured === true ? '' : '<span class="chip warn">未配置识别</span>')
      + (record.problem ? `<span class="chip danger">采集源异常 ${esc(record.problem)}</span>` : '');
    return `<div class="sugg">
      <div class="row"><span class="chip">${esc(formatRecordTime(record.at))}</span>${RECORD_OUTCOME[record.outcome] || ''}${extra}</div>
      <div class="mt6">${esc(detail)}</div>
      <div class="muted mt6">设备：${esc(record.device || '未回报')}${record.client ? ` · 客户端 ${esc(record.client)}` : ''}</div>
    </div>`;
  }).join('');
  el.innerHTML = `<div class="row mb6">
      <span class="muted push">采集记录（本份病历 · 保留 ${Number(data.retentionDays) || 7} 天；只记元数据，音频不留存，无法回放）</span>
      <button data-capture-clear title="只清空本份病历的采集记录；管理审计里的采集记录不受影响">清空本份记录</button>
    </div>${rows}`;
  el.hidden = false;
}

let placementCandidateIds = new Set();

function renderDictation() {
  const dictation = S.dictation;
  placementCandidateIds = new Set((Array.isArray(S.placementCandidates) ? S.placementCandidates : []).map((item) => item.nodeId));
  const capture = S.capture || {};
  const captureLine = $('dictationCapture');
  captureLine.textContent = capture.configured
    ? `语音识别服务：已配置（音频${capture.retainAudio ? '会留存' : '不留存'}）`
    : '';
  captureLine.hidden = capture.configured !== true;
  if (!dictation) {
    $('badgeVoice').innerHTML = '<span class="chip">未接入</span>';
    $('dictation').innerHTML = '<div class="empty">暂无转写。点"模拟一段录音转写"看完整链路。</div>';
    return;
  }
  const segments = dictation.segments || [];
  const placements = Array.isArray(dictation.placements) ? dictation.placements : [];
  const byIndex = new Map(placements.map((item) => [item.index, item]));
  const unplaced = Number(dictation.unplaced || 0);
  const selectable = dictation.submitted !== true;
  const candidates = Array.isArray(S.placementCandidates) ? S.placementCandidates : [];
  const optionsFor = (selected) => ['<option value="">— 请选择落点 —</option>']
    .concat(candidates.map((item) => `<option value="${esc(item.nodeId)}"${item.nodeId === selected ? ' selected' : ''}>${esc(item.label)}</option>`))
    .join('');
  $('badgeVoice').innerHTML = `<span class="chip${dictation.source === 'capture' ? ' ok' : ' warn'}">${dictation.source === 'capture' ? '真实采集' : '模拟转写'}</span>`
    + ` <span class="chip ok">${segments.length} 段</span>`
    + (unplaced > 0 ? ` <span class="chip warn">未落位 ${unplaced}</span>` : '')
    + (isClinical() ? '' : ` <span class="chip">${dictation.submitted ? `组 ${esc(dictation.groupId)}` : '未生成建议'}</span>`);
  const rows = segments.map((segment) => {
    const span = segment.startSec === undefined ? '无时间戳' : `${segment.startSec}s ~ ${segment.endSec}s`;
    const placement = byIndex.get(segment.index);
    const chosen = placement && placement.nodeId ? placement.nodeId : '';
    const target = selectable
      ? `<select data-place-index="${segment.index}" title="为这一段指定落点（只影响建议落点，不改门控档位）">${optionsFor(chosen)}</select>`
      : (chosen ? `<span class="chip ok">落点 ${esc(chosen)}</span>` : '<span class="chip warn">未落位</span>');
    const hint = placement ? `<span class="muted">${esc(placement.reason)}</span>` : '';
    const dragAttrs = selectable ? ` draggable="true" data-drag-segment="${segment.index}"` : '';
    return `<div class="sugg${selectable ? ' draggable' : ''}"${dragAttrs}>
      <div class="row"><span class="chip">第 ${segment.index} 段</span><span class="chip">${esc(span)}</span>
        <span class="muted push">听写置信度 ${Number(segment.confidence).toFixed(2)}</span></div>
      <div class="mt6">${esc(segment.text)}</div>
      <div class="row mt6">${target}${hint}</div>
    </div>`;
  }).join('');
  const warns = (dictation.warnings || []).map((text) => `<span class="chip warn wrap">${esc(text)}</span>`).join(' ');
  const commitBar = selectable
    ? `<div class="row mt10">
         <button class="primary" data-dictate-commit="1">按这些落点生成建议</button>
       </div>`
    : '';
  $('dictation').innerHTML = `
    <div class="row mb8"><b>转写结果</b>
      <span class="muted">${dictation.submitted
        ? '已生成一组建议，可在「AI」页签按组采纳或拒绝'
        : '落点确认后才生成建议：逐段选落点（也可以把整段<b>拖</b>到正文的目标段落上），再点下方按钮'}</span></div>
    ${rows}
    ${commitBar}
    ${warns ? `<div class="row mt10"><b>规范化与落位提示</b></div><div class="row mt4">${warns}</div>` : ''}
    <div class="muted mt10">这些是<b>建议</b>，尚未写入正文；采纳后仍需人工确认才能签章。</div>`;
}

/** 命中的落点容器；不在候选集内返回 null（不 preventDefault = 此处不可放） */
function dropZoneOf(target) {
  const zone = target && target.closest ? target.closest('[data-node-id]') : null;
  if (!zone) return null;
  return placementCandidateIds.has(zone.dataset.nodeId) ? zone : null;
}

function clearDropMarks() {
  document.querySelectorAll('.drop-target').forEach((el) => el.classList.remove('drop-target'));
}

document.addEventListener('dragstart', (event) => {
  const source = event.target.closest ? event.target.closest('[data-drag-segment]') : null;
  if (!source || !event.dataTransfer) return;
  event.dataTransfer.setData('text/plain', source.dataset.dragSegment);
  event.dataTransfer.effectAllowed = 'copy';
  source.classList.add('dragging');
});

document.addEventListener('dragend', (event) => {
  const source = event.target.closest ? event.target.closest('[data-drag-segment]') : null;
  if (source) source.classList.remove('dragging');
  clearDropMarks();
});

document.addEventListener('dragover', (event) => {
  const zone = dropZoneOf(event.target);
  if (!zone) return;
  /* 必须 preventDefault 才允许放下；不做就是"此处不可放" */
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  zone.classList.add('drop-target');
});

document.addEventListener('dragleave', (event) => {
  const zone = dropZoneOf(event.target);
  if (zone) zone.classList.remove('drop-target');
});

document.addEventListener('drop', async (event) => {
  const zone = dropZoneOf(event.target);
  if (!zone) return;
  event.preventDefault();
  clearDropMarks();
  const index = Number(event.dataTransfer ? event.dataTransfer.getData('text/plain') : '');
  const select = Number.isInteger(index) ? document.querySelector(`[data-place-index="${index}"]`) : null;
  if (!select) {
    await askAlert('这一段现在没有可指定的落点（可能已生成建议，或转写已更新）：请在「语音转写」里重新确认');
    return;
  }
  select.value = zone.dataset.nodeId;
  /* 就地闪一下边框：拖完要立刻看得出"落点确实被改了"，否则用户会怀疑没生效 */
  select.classList.add('just-set');
  window.setTimeout(() => select.classList.remove('just-set'), 1200);
});

const MODE_LABEL = { complete: '续写', draft: '草稿', polish: '润色', voice: '语音', consistency: '一致性', unknown: '未知', other: '其他' };

function chipMode(mode) {
  const label = MODE_LABEL[mode] || mode || '未知';
  return `<span class="chip${mode === 'voice' ? ' ai' : ''}" title="产出方式：${esc(label)}">${esc(label)}</span>`;
}

function renderModelPanel() {
  const cfg = S.model || {};
  $('cfgFormat').value = cfg.format === 'openai-compatible' ? 'openai-compatible' : 'offline';
  $('cfgModel').value = cfg.model || '';
  $('cfgEndpoint').value = cfg.endpoint || '';
  $('cfgTimeout').value = cfg.timeoutMs || 20000;
  $('cfgMaxItems').value = cfg.maxItems || 20;
  $('cfgApiKey').value = '';
  const from = cfg.source === 'store' ? '配置界面' : '默认（离线）';
  /* 时间要给人看：ISO 原始串是机器格式，管理界面上直接甩出来，读的人得自己拆一遍。 */
  const when = (iso) => {
    const time = new Date(String(iso));
    return Number.isNaN(time.getTime()) ? String(iso) : time.toLocaleString('zh-CN', { hour12: false });
  };
  $('cfgCurrent').textContent = `当前：${cfg.modelId || '—'} · 来源 ${from} · 密钥${cfg.apiKeyPresent ? '已配置' : '未配置'}`
    + (cfg.updatedBy ? ` · 最近由 ${cfg.updatedBy} 于 ${when(cfg.updatedAt)} 修改` : '');
  const rules = Array.isArray(S.formRules) ? S.formRules : [];
  const rulesCell = $('cfgFormRules');
  if (rulesCell) rulesCell.textContent = rules.length === 0 ? '未加载' : rules.map((r) => `${r.id} ${r.title}`).join('；');
  renderPlacementPanel();
  renderSignPanel();
  renderReadingAuthorityPanel();
}

function syncPlacementTerms(strategy) {
  const terms = $('cfgPlaceTerms');
  /* 用默认值兜底：策略来自界面上可能为空的新值 */
  const selected = strategy || 'ordered';
  const usesRules = selected === 'section-title' || selected === 'term-table';
  terms.disabled = !usesRules;
  terms.placeholder = usesRules ? '每行一条：主诉=t_1\n现病史=t_2' : `当前策略（${selected}）不使用规则表`;
  const structure = $('cfgPlaceStructure');
  if (structure) {
    structure.disabled = !usesRules;
    structure.placeholder = usesRules
      ? '结构化词表（每行一条）：体温=WS445:DE05.01.001:体温\n格式：词=体系:编码[:显示名]；留空 = 不做任何数据元提议'
      : `当前策略（${selected}）不产出数据元提议`;
  }
}

function structureMapLines(structureMap) {
  return Object.entries(structureMap || {})
    .map(([word, tag]) => `${word}=${tag.system}:${tag.code}${tag.display ? `:${tag.display}` : ''}`)
    .join('\n');
}

function parseStructureMapInput(text) {
  const map = {};
  const lines = String(text || '').split('\n').map((line) => line.trim()).filter((line) => line !== '');
  for (const [position, line] of lines.entries()) {
    const at = line.indexOf('=');
    const word = at < 0 ? '' : line.slice(0, at).trim();
    const spec = at < 0 ? '' : line.slice(at + 1).trim();
    const parts = spec.split(':');
    const system = (parts[0] || '').trim();
    const code = (parts[1] || '').trim();
    const display = parts.slice(2).join(':').trim();
    if (word === '' || system === '' || code === '') {
      return { ok: false, message: `结构化词表第 ${position + 1} 行不合法：需要"词=体系:编码[:显示名]"，例如 体温=WS445:DE05.01.001:体温` };
    }
    map[word] = display === '' ? { system, code } : { system, code, display };
  }
  return { ok: true, map };
}

function renderPlacementPanel() {
  const pl = S.placement || {};
  const strategy = pl.strategy || 'ordered';
  $('cfgPlaceStrategy').value = strategy;
  $('cfgPlaceCeiling').value = pl.confidenceCeiling ?? 0.85;
  const within = (pl.candidate && pl.candidate.withinSections) || [];
  $('cfgPlaceSections').value = within.join(',');
  const pairs = strategy === 'term-table'
    ? (pl.termMap || []).map((item) => `${item.match}=${item.nodeId}`)
    : Object.entries(pl.sectionMap || {}).map(([key, value]) => `${key}=${value}`);
  $('cfgPlaceTerms').value = pairs.join('\n');
  const structureField = $('cfgPlaceStructure');
  if (structureField) structureField.value = structureMapLines(pl.structureMap);
  const external = pl.external || {};
  $('cfgPlaceEndpoint').value = external.endpoint || '';
  $('cfgPlaceTimeout').value = external.timeoutMs || 20000;
  $('cfgPlaceApiKey').value = '';
  syncPlacementTerms(strategy);
  const from = pl.source === 'store' ? '配置界面' : '默认';
  $('cfgPlacementCurrent').textContent = `当前：策略 ${strategy} · 上限 ${pl.confidenceCeiling ?? 0.85} · 来源 ${from}`
    + (pl.updatedBy ? ` · 最近由 ${pl.updatedBy} 修改` : '');
}

function renderReadingAuthorityPanel() {
  const auth = S.readingAuthority || {};
  $('cfgAuthEndpoint').value = auth.endpoint || '';
  /* 公钥不回显全文（同签名后端）：只报"是否已配 + 指纹"，留空即不修改 */
  $('cfgAuthPublicKey').value = '';
  $('cfgAuthPublicKey').placeholder = auth.trustedIssuerPublicKeyPresent
    ? `已配公钥（指纹 ${String(auth.trustedIssuerFingerprint || '').slice(0, 16)}…）：留空 = 不修改`
    : 'SPKI base64；粘贴后指纹自动派生';
  $('cfgAuthFingerprint').value = auth.trustedIssuerFingerprint || '';
  const configured = auth.configured === true;
  const from = auth.source === 'store' ? '配置界面' : '未配置';
  $('cfgAuthCurrent').textContent = `当前：${configured ? '已配置授权平台' : '尚未配置（任何凭据都会被拒）'}`
    + ` · 信任 ${configured ? `${String(auth.trustedIssuerFingerprint || '').slice(0, 16)}…` : '（无）'}`
    + ` · 来源 ${from}`
    + (auth.endpoint ? ` · 平台地址 ${auth.endpoint}` : '')
    + (auth.updatedBy ? ` · 最近由 ${auth.updatedBy} 修改` : '');
}

async function saveAuthorityFromForm() {
  const body = { adminId: $('cfgAdmin').value.trim(), endpoint: $('cfgAuthEndpoint').value.trim() };
  const key = $('cfgAuthPublicKey').value.trim();
  const fingerprint = $('cfgAuthFingerprint').value.trim();
  if (key !== '') body.trustedIssuerPublicKeyBase64 = key;
  if (fingerprint !== '') body.trustedIssuerFingerprint = fingerprint;
  const r = await api('/api/reading-authority', body);
  if (r.ok) {
    const configured = r.data && r.data.configured === true;
    setAuthStatus(configured
      ? '已保存：只接纳该平台签发的授权（本系统不签发授权）'
      : '已保存，但尚未配置信任根：此时任何凭据都会被拒（受控阅读不可用）');
    await apply(r);
    renderReadingAuthorityPanel();
  } else {
    setAuthStatus(`保存失败：${(r && (r.message || r.code)) || '未知原因'}`);
  }
}

async function importCredentialFromForm() {
  const text = $('cfgAuthCredential').value.trim();
  if (text === '') {
    setAuthImportStatus('请先粘贴授权书 JSON（院内授权平台签发的那一份）');
    return;
  }
  const r = await api('/api/reading/import-credential', { text });
  if (r.ok) {
    const grantId = (r.data && r.data.grantId) || '';
    setAuthImportStatus(`已导入并登记：${grantId}（去「定稿与导出 → 受控阅读」执行阅读）`);
    $('cfgAuthCredential').value = '';
    await apply(r);
  } else {
    setAuthImportStatus(`未导入：${(r && (r.message || r.code)) || '未知原因'}`);
  }
}

function renderSignPanel() {
  const cfg = S.signBackend || {};
  const http = cfg.http || {};
  const request = http.request || {};
  const response = http.response || {};
  const auth = http.auth || {};
  $('cfgSignEndpoint').value = http.endpoint || '';
  $('cfgSignTimeout').value = http.timeoutMs || 20000;
  $('cfgSignKeyId').value = http.keyId || '';
  $('cfgSignAuthHeader').value = auth.headerName || '';
  $('cfgSignAuthScheme').value = auth.scheme || '';
  $('cfgSignApiKey').value = '';
  $('cfgSignToSignField').value = request.toSignField || 'toSign';
  $('cfgSignToSignEncoding').value = request.toSignEncoding || 'base64';
  $('cfgSignDigestField').value = request.digestField || '';
  $('cfgSignAlgorithmField').value = request.algorithmField || '';
  $('cfgSignKeyIdField').value = request.keyIdField || '';
  $('cfgSignExtra').value = request.extra ? JSON.stringify(request.extra) : '';
  $('cfgSignSignaturePath').value = response.signaturePath || 'signature';
  $('cfgSignSignatureEncoding').value = response.signatureEncoding || 'base64';
  $('cfgSignPublicKeyPath').value = response.publicKeyPath || '';
  $('cfgSignCertificatePath').value = response.certificatePath || '';
  $('cfgSignFingerprint').value = cfg.expectedFingerprint || '';
  $('cfgSignPublicKey').value = '';
  $('cfgSignPublicKey').placeholder = cfg.publicKeyPresent
    ? `已预置公钥（指纹 ${String(cfg.publicKeyFingerprint || '').slice(0, 16)}…）：留空 = 不修改`
    : 'SPKI base64（签章必需：先点「测试签名」拿到指纹，再把公钥固定下来）';
  const from = cfg.source === 'store' ? '配置界面' : '未配置';
  const missing = Array.isArray(cfg.missing) ? cfg.missing : [];
  const head = cfg.configured === true
    ? '当前：已配置医院签名服务（签章会经过它）'
    : '当前：尚未配置。本系统没有内置软件签名可回退，未配齐则无法签章'
      + (missing.length > 0 ? `（还缺 ${missing.join('、')}）` : '');
  $('cfgSignCurrent').textContent = `${head} · 来源 ${from}`
    + (cfg.updatedBy ? ` · 最近由 ${cfg.updatedBy} 修改` : '')
    + (cfg.publicKeyFingerprint ? ` · 预置公钥指纹 ${String(cfg.publicKeyFingerprint).slice(0, 16)}…` : '');
}

async function saveModelConfigFromForm(apiKeyOverride) {
  const body = {
    adminId: $('cfgAdmin').value.trim(),
    format: $('cfgFormat').value,
    model: $('cfgModel').value.trim(),
    endpoint: $('cfgEndpoint').value.trim(),
    timeoutMs: Number($('cfgTimeout').value),
    maxItems: Number($('cfgMaxItems').value),
  };
  const typed = $('cfgApiKey').value;
  if (apiKeyOverride === null) body.apiKey = null;
  else if (typed !== '') body.apiKey = typed;
  const r = await api('/api/model-config', body);
  if (r.ok) {
    $('cfgApiKey').value = '';
    const action = r.data && r.data.apiKeyAction;
    setCfgStatus(`已保存（密钥：${action === 'set' ? '已更新' : action === 'cleared' ? '已清除' : '未改动'}）`);
    await apply(r);
    renderModelPanel();
  } else {
    setCfgStatus(`保存失败：${(r && (r.message || r.code)) || '未知原因'}`);
  }
}

async function savePlacementFromForm() {
  const strategy = $('cfgPlaceStrategy').value;
  const sections = $('cfgPlaceSections').value.split(',').map((item) => item.trim()).filter((item) => item !== '');
  const endpoint = $('cfgPlaceEndpoint').value.trim();
  const timeoutMs = Number($('cfgPlaceTimeout').value);
  const typedKey = $('cfgPlaceApiKey').value;
  const body = {
    adminId: $('cfgAdmin').value.trim(),
    strategy,
    confidenceCeiling: Number($('cfgPlaceCeiling').value),
    candidate: { onlyTextNodes: true, ...(sections.length > 0 ? { withinSections: sections } : {}) },
    external: {
      ...(endpoint ? { endpoint } : {}),
      ...(Number.isInteger(timeoutMs) && timeoutMs > 0 ? { timeoutMs } : {}),
    },
    ...(typedKey !== '' ? { apiKey: typedKey } : {}),
  };
  if (strategy !== 'ordered') {
    const entries = $('cfgPlaceTerms').value.split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
      .map((line) => {
        const at = line.indexOf('=');
        return { match: at < 0 ? '' : line.slice(0, at).trim(), nodeId: at < 0 ? '' : line.slice(at + 1).trim() };
      });
    if (entries.length === 0) {
      setPlaceStatus('规则表为空：请至少填一条"关键词=节点id"，或把策略改回"按顺序"');
      return;
    }
    if (strategy === 'section-title') body.sectionMap = Object.fromEntries(entries.map((entry) => [entry.match, entry.nodeId]));
    else body.termMap = entries;
  }
  const structureField = $('cfgPlaceStructure');
  const parsedStructure = parseStructureMapInput(structureField ? structureField.value : '');
  if (parsedStructure.ok !== true) {
    setPlaceStatus(parsedStructure.message);
    return;
  }
  if (Object.keys(parsedStructure.map).length > 0) body.structureMap = parsedStructure.map;
  const r = await api('/api/placement-config', body);
  if (r.ok) {
    $('cfgPlaceApiKey').value = '';
    setPlaceStatus('已保存：下次转写即按新策略落位（改完立即生效，无需重启）');
    await apply(r);
    renderPlacementPanel();
  } else {
    setPlaceStatus(`保存失败：${(r && (r.message || r.code)) || '未知原因'}`);
  }
}

async function saveSignBackendFromForm() {
  const body = { adminId: $('cfgAdmin').value.trim() };
  const typedSignKey = $('cfgSignApiKey').value;
  if (typedSignKey !== '') body.apiKey = typedSignKey;
  if ($('cfgSignEndpoint').value.trim() !== '') {
    let extra;
    const extraText = $('cfgSignExtra').value.trim();
    if (extraText !== '') {
      try {
        extra = JSON.parse(extraText);
      } catch {
        setSignStatus('附加字段不是合法 JSON');
        return;
      }
      if (!extra || typeof extra !== 'object' || Array.isArray(extra)) {
        setSignStatus('附加字段必须是 JSON 对象');
        return;
      }
    }
    const authHeader = $('cfgSignAuthHeader').value.trim();
    body.http = {
      endpoint: $('cfgSignEndpoint').value.trim(),
      timeoutMs: Number($('cfgSignTimeout').value),
      ...($('cfgSignKeyId').value.trim() ? { keyId: $('cfgSignKeyId').value.trim() } : {}),
      ...(authHeader
        ? {
            auth: {
              headerName: authHeader,
              ...($('cfgSignAuthScheme').value ? { scheme: $('cfgSignAuthScheme').value } : {}),
            },
          }
        : {}),
      request: {
        toSignField: $('cfgSignToSignField').value.trim() || 'toSign',
        toSignEncoding: $('cfgSignToSignEncoding').value,
        ...($('cfgSignDigestField').value.trim() ? { digestField: $('cfgSignDigestField').value.trim() } : {}),
        ...($('cfgSignAlgorithmField').value.trim() ? { algorithmField: $('cfgSignAlgorithmField').value.trim() } : {}),
        ...($('cfgSignKeyIdField').value.trim() ? { keyIdField: $('cfgSignKeyIdField').value.trim() } : {}),
        ...(extra ? { extra } : {}),
      },
      response: {
        signaturePath: $('cfgSignSignaturePath').value.trim() || 'signature',
        signatureEncoding: $('cfgSignSignatureEncoding').value,
        ...($('cfgSignPublicKeyPath').value.trim() ? { publicKeyPath: $('cfgSignPublicKeyPath').value.trim() } : {}),
        ...($('cfgSignCertificatePath').value.trim() ? { certificatePath: $('cfgSignCertificatePath').value.trim() } : {}),
      },
    };
    if ($('cfgSignFingerprint').value.trim()) body.expectedFingerprint = $('cfgSignFingerprint').value.trim();
    if ($('cfgSignPublicKey').value.trim()) body.publicKeyBase64 = $('cfgSignPublicKey').value.trim();
  }
  const r = await api('/api/sign-backend-config', body);
  if (r.ok) {
    setSignStatus('已保存：改完立即生效，无需重启');
    $('cfgSignPublicKey').value = '';
    await apply(r);
    renderSignPanel();
  } else {
    setSignStatus(`保存失败：${(r && (r.message || r.code)) || '未知原因'}`);
  }
}

/** 测试签名：签一段与病历无关的文本，并把"能不能验、指纹对不对"报出来 */
async function runSignTest() {
  setSignStatus('测试中…（签一段与病历无关的测试文本，并尝试自验）');
  const r = await api('/api/sign-backend/test', { adminId: $('cfgAdmin').value.trim() });
  if (!r.ok) {
    setSignStatus(`测试失败：${(r && (r.message || r.code)) || '未知原因'}`);
    return;
  }
  const d = r.data || {};
  const verify = d.selfVerified === true ? '自验通过' : d.selfVerified === false ? '自验未通过' : '无法自验（缺公钥）';
  const match = d.fingerprintMatches === true ? '指纹一致' : d.fingerprintMatches === false ? '指纹不一致' : '指纹尚未固定';
  const parts = [
    `签名成功（${d.latencyMs}ms / ${d.signatureBytes} 字节）`,
    verify,
    match,
    `实际指纹 ${d.actualFingerprint ? `${String(d.actualFingerprint).slice(0, 16)}…` : '未知'}`,
  ];
  if (d.certificateCount > 0) parts.push(`证书 ${d.certificateCount} 张`);
  setSignStatus(parts.join(' · ') + (d.notes && d.notes.length ? ` · ${d.notes.join('；')}` : ''));
}

let showProcessedSuggestions = false;

let suggestionNotice = '';

let docNotice = '';

function chipEditBand(s) {
  const base = '<span class="chip ok">已采纳</span>';
  const pct = typeof s.editRatio === 'number' ? ` ${Math.round(s.editRatio * 100)}%` : '';
  if (s.editBand === 'light') return `${base} <span class="chip">人工微改${pct}</span>`;
  if (s.editBand === 'heavy') return `${base} <span class="chip warn">人工大改${pct}</span>`;
  if (s.editBand === 'as-is') return base;
  return `${base} <span class="chip warn">改动幅度未记录</span>`;
}

function renderAiSilence() {
  const line = $('aiSilenceLine');
  if (!line) return;
  const silence = S.aiSilence;
  if (!silence) {
    line.textContent = '';
    return;
  }
  const skipped = Array.isArray(silence.skipped) ? silence.skipped : [];
  const summary = `本次范围 ${silence.targets} 个目标，产出 ${silence.produced} 条`;
  if (skipped.length === 0) {
    line.className = 'muted';
    line.textContent = `${summary}，没有跳过。`;
    return;
  }
  const tally = new Map();
  for (const item of skipped) {
    const label = item.label || item.code;
    tally.set(label, (tally.get(label) || 0) + 1);
  }
  const detail = [...tally].map(([label, count]) => `${label} ×${count}`).join('；');
  const rejected = Array.isArray(silence.rejected) ? silence.rejected.length : 0;
  const rejectedNote = rejected > 0 ? `；另有 ${rejected} 条跳过说明不合规，已忽略` : '';
  line.className = 'muted warn-text';
  line.textContent = `${summary}，未产出 ${skipped.length} 个：${detail}${rejectedNote}`;
}

const sentenceReviews = new Map();

function nodeTextOf(nodeId) {
  const item = (Array.isArray(S.items) ? S.items : []).find((node) => node.id === nodeId && node.kind === 'text');
  return item ? String(item.text || '') : null;
}

function splitSentences(text) {
  const source = String(text || '');
  if (source === '') return [];
  const parts = source.match(/[^。！？；!?;\n]+[。！？；!?;\n]*|[。！？；!?;\n]+/g) || [];
  return parts.filter((part) => part !== '');
}

function sentenceDiff(before, after) {
  const rows = before.length;
  const cols = after.length;
  const dp = Array.from({ length: rows + 1 }, () => new Array(cols + 1).fill(0));
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      dp[i][j] = before[i] === after[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (before[i] === after[j]) {
      ops.push({ type: 'equal', text: before[i] });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: 'del', text: before[i] });
      i += 1;
    } else {
      ops.push({ type: 'ins', text: after[j] });
      j += 1;
    }
  }
  while (i < rows) { ops.push({ type: 'del', text: before[i] }); i += 1; }
  while (j < cols) { ops.push({ type: 'ins', text: after[j] }); j += 1; }
  return ops;
}

function pairReplacements(ops) {
  const out = [];
  let index = 0;
  while (index < ops.length) {
    if (ops[index].type === 'equal') {
      out.push({ ...ops[index] });
      index += 1;
      continue;
    }
    const dels = [];
    const inss = [];
    while (index < ops.length && ops[index].type !== 'equal') {
      if (ops[index].type === 'del') dels.push(ops[index].text);
      else inss.push(ops[index].text);
      index += 1;
    }
    const pairs = Math.min(dels.length, inss.length);
    for (let k = 0; k < pairs; k += 1) out.push({ type: 'rep', before: dels[k], after: inss[k] });
    for (let k = pairs; k < dels.length; k += 1) out.push({ type: 'del', text: dels[k] });
    for (let k = pairs; k < inss.length; k += 1) out.push({ type: 'ins', text: inss[k] });
  }
  return out;
}

function buildReview(suggestion, currentText) {
  const ops = pairReplacements(sentenceDiff(splitSentences(currentText), splitSentences(suggestion.text)));
  const rows = ops.map((op, index) => ({
    index,
    type: op.type,
    text: op.type === 'rep' ? op.after : op.text,
    before: op.type === 'rep' ? op.before : undefined,
    after: op.type === 'rep' ? op.after : undefined,
    /* 见文件头：AI 的新增/改写默认采纳，AI 没提的原句默认删除 */
    pick: op.type === 'ins' || op.type === 'rep',
  }));
  return { rows, currentText, aiText: suggestion.text, manual: false };
}

function reviewRowText(row) {
  if (row.type === 'equal') return row.text;
  if (row.type === 'del') return row.pick ? row.text : '';
  if (row.type === 'ins') return row.pick ? row.text : '';
  return row.pick ? (row.after || '') : (row.before || '');
}

function composeReview(review) {
  return review.rows.map(reviewRowText).join('');
}

function aiRangesOf(review) {
  const ranges = [];
  let offset = 0;
  for (const row of review.rows) {
    const text = reviewRowText(row);
    const fromAi = (row.type === 'ins' || row.type === 'rep') && row.pick;
    if (fromAi && text.length > 0) ranges.push({ start: offset, end: offset + text.length });
    offset += text.length;
  }
  return ranges;
}

function reviewSummary(review) {
  const changed = review.rows.filter((row) => row.type !== 'equal');
  const picked = changed.filter((row) => row.pick).length;
  return `逐句对照 ${changed.length} 处 · 已选 ${picked} 处`;
}

function renderReviewHtml(suggestion, review) {
  const changed = review.rows.filter((row) => row.type !== 'equal');
  if (changed.length === 0) return '';
  const rowHtml = (row) => {
    const tag = row.type === 'ins' ? '新增' : row.type === 'del' ? '删除' : '改写';
    const body = row.type === 'rep'
      ? `<s>${esc(row.before || '')}</s> → ${esc(row.after || '')}`
      : esc(row.text || '');
    const title = row.type === 'del'
      ? '勾选 = 保留原句（不勾选则采纳后这句消失）'
      : '勾选 = 采纳这句（取消则保留原样）';
    return `<label class="sr-row ${row.type}" title="${title}">
      <input type="checkbox" data-sugg-pick="${esc(suggestion.id)}" data-pick-index="${row.index}" ${row.pick ? 'checked' : ''} />
      <span class="sr-tag ${row.type}">${tag}</span>
      <span class="sr-text">${body}</span>
    </label>`;
  };
  return `<div class="sugg-review">
    <div class="muted" data-review-hint="${esc(suggestion.id)}">${reviewSummary(review)}（Tab 逐句走，空格取舍）</div>
    ${review.rows.map(rowHtml).join('')}
  </div>`;
}

document.addEventListener('change', (event) => {
  const box = event.target;
  if (!box || !box.dataset || !box.dataset.suggPick) return;
  const review = sentenceReviews.get(box.dataset.suggPick);
  if (!review) return;
  const row = review.rows[Number(box.dataset.pickIndex)];
  if (!row) return;
  row.pick = box.checked === true;
  const area = document.querySelector(`[data-sugg-text="${box.dataset.suggPick}"]`);
  if (area) {
    area.value = composeReview(review);
    review.manual = false;
  }
  const hint = document.querySelector(`[data-review-hint="${box.dataset.suggPick}"]`);
  if (hint) hint.textContent = `${reviewSummary(review)}（Tab 逐句走，空格取舍）`;
});

document.addEventListener('input', (event) => {
  const area = event.target;
  if (!area || !area.dataset || !area.dataset.suggText) return;
  const review = sentenceReviews.get(area.dataset.suggText);
  if (!review || review.manual) return;
  review.manual = true;
  const hint = document.querySelector(`[data-review-hint="${area.dataset.suggText}"]`);
  if (hint) hint.textContent = '已手动改写全文：上方勾选不再与文本同步（改动会按"修改率"计入）';
});

function reviewRowOf(target) {
  return target && target.closest ? target.closest('.sr-row') : null;
}

function focusReviewRow(row, delta) {
  const list = row.parentElement ? Array.from(row.parentElement.querySelectorAll('.sr-row')) : [];
  const index = list.indexOf(row);
  const next = list[Math.max(0, Math.min(list.length - 1, index + delta))];
  if (!next || next === row) return;
  const box = next.querySelector('input[type="checkbox"]');
  if (box) box.focus();
}

document.addEventListener('keydown', (event) => {
  const row = reviewRowOf(event.target);
  if (!row) return;
  if (event.key === 'ArrowDown' || event.key === 'j' || event.key === 'J') {
    event.preventDefault();
    focusReviewRow(row, 1);
    return;
  }
  if (event.key === 'ArrowUp' || event.key === 'k' || event.key === 'K') {
    event.preventDefault();
    focusReviewRow(row, -1);
    return;
  }
  if (event.key === 'Enter') {
    event.preventDefault();
    const card = row.closest ? row.closest('.sugg') : null;
    const accept = card ? card.querySelector('button[data-accept]') : null;
    if (accept) accept.click();
  }
});

document.addEventListener('focusin', (event) => {
  const box = event.target;
  if (!box || !box.dataset || !box.dataset.suggPick) return;
  const review = sentenceReviews.get(box.dataset.suggPick);
  if (!review) return;
  const changed = review.rows.filter((row) => row.type !== 'equal');
  const position = changed.indexOf(review.rows[Number(box.dataset.pickIndex)]) + 1;
  const hint = document.querySelector(`[data-review-hint="${box.dataset.suggPick}"]`);
  if (hint) hint.textContent = `${reviewSummary(review)} · 第 ${position}/${changed.length} 处（空格取舍，Enter 采纳）`;
});

async function runSuggestFor(nodeId, mode) {
  const id = String(nodeId || '').trim();
  if (id === '') {
    toast('没有指明要给哪一段生成建议', 'info');
    return null;
  }
  /* 让右栏的状态与这次请求一致：否则面板上还停在上一次的目标，人会以为建议挂错了段 */
  const target = $('suggTarget');
  if (target && [...target.options].some((option) => option.value === id)) target.value = id;
  const modeSelect = $('suggMode');
  if (modeSelect && [...modeSelect.options].some((option) => option.value === mode)) modeSelect.value = mode;
  const confidenceInput = $('confidence');
  const r = await api('/api/suggest', {
    nodeId: id,
    confidence: Number(confidenceInput ? confidenceInput.value : 0.95),
    mode,
  });
  const reusedId = r.ok && r.data && r.data.reused === true ? String(r.data.suggestionId || '') : '';
  suggestionNotice = reusedId === ''
    ? ''
    : `已有同样内容的待处理建议（${reusedId}），未重复生成。建议数与采纳/拒绝率不受影响。`;
  if (reusedId !== '') showProcessedSuggestions = false;
  await apply(r);
  switchTab('ai');
  return r;
}

function renderSuggestions() {
  const all = S.suggestions;
  sentenceReviews.clear();
  const pending = all.filter((item) => item.status === 'pending');
  const acceptedCount = all.filter((item) => item.status === 'accepted').length;
  const rejectedCount = all.filter((item) => item.status === 'rejected').length;
  const list = showProcessedSuggestions ? all : pending;
  $('suggCounts').textContent = `待处理 ${pending.length} · 已采纳 ${acceptedCount} · 已拒绝 ${rejectedCount}`;
  $('btnToggleProcessed').textContent = showProcessedSuggestions ? '只看待处理' : '显示已处理（含拒绝）';
  $('suggNotice').textContent = suggestionNotice;
  $('thresholdHint').textContent = `门控：一般内容 ≥ ${S.thresholds.general} 可落笔；关键内容 ≥ ${S.thresholds.key}。低于阈值只能拒绝或继续修改。`;
  renderAiSilence();

  const model = S.model || {};
  $('modelInfo').textContent = model.modelId ? String(model.modelId) : '—';
  $('modelHint').textContent = ' ' + (model.format === 'offline' ? '离线模板（未接入真实模型）' : '在线模型');

  const groupBar = (S.groups || [])
    .filter((group) => group.pending > 0)
    .map((group) => `<div class="sugg group">
      <div class="row"><span class="chip ai">一组 ${group.total} 条</span>
        <span class="chip warn">待处理 ${group.pending}</span>
        ${group.accepted > 0 ? `<span class="chip ok">已采纳 ${group.accepted}</span>` : ''}
        <span class="muted push">${esc(group.groupId)}</span></div>
      <div class="muted mt4">组级采纳仍<b>逐条过门控</b>：不够门槛的保持待处理。</div>
      <div class="row mt8">
        <button class="ok" data-accept-group="${esc(group.groupId)}">接受本组</button>
        <button class="danger" data-reject-group="${esc(group.groupId)}">忽略本组</button>
      </div>
    </div>`).join('');

  if (list.length === 0) {
    $('suggestions').innerHTML = groupBar + (all.length === 0
      ? '<div class="empty">暂无建议。选一个节点，点"生成一条"或"生成整批"。</div>'
      : `<div class="empty">待处理已清空（已处理 ${all.length} 条：已采纳 ${acceptedCount} · 已拒绝 ${rejectedCount}，点上方按钮可查看）。</div>`);
    return;
  }
  $('suggestions').innerHTML = groupBar + list.map((s) => {
    const low = s.confidence < s.threshold;
    const badge = s.status === 'pending'
      ? (low ? '<span class="chip danger">低于阈值</span>' : '<span class="chip ok">可落笔</span>')
      : (s.status === 'accepted' ? chipEditBand(s) : '<span class="chip danger">已拒绝</span>');
    const currentText = s.status === 'pending' ? nodeTextOf(s.targetNodeId) : null;
    const review = currentText === null ? null : buildReview(s, currentText);
    if (review) sentenceReviews.set(s.id, review);
    const showReview = !!review && review.rows.some((row) => row.type !== 'equal');
    const actions = s.status === 'pending'
      ? `<div class="row mt8">
           <button class="ok" data-accept="${esc(s.id)}">${showReview ? '采纳（按上面勾选）' : '直接采纳'}</button>
           <button class="danger" data-reject="${esc(s.id)}">拒绝</button>
         </div>`
      : '';
    return `<div class="sugg ${s.status === 'pending' ? '' : 'done'}">
      <div class="row">${badge} ${chipMode(s.mode)}
        ${isClinical() ? '' : `<span class="chip ai">${esc(s.modelId)}</span>`}
        ${s.keyContent ? '<span class="chip warn">目标为关键内容</span>' : ''}
        ${isClinical() ? '' : `<span class="muted push">${esc(s.id)} → ${esc(s.targetNodeId)}</span>`}</div>
      <div class="bar"><i class="${low ? 'low' : ''}" style="width:${Math.round(s.confidence * 100)}%"></i></div>
      <div class="muted">置信度 ${Number(s.confidence).toFixed(2)} / 阈值 ${s.threshold}
        <span title="模型只给了整条建议一个分数，没有按句打分">（整条建议的口径，不按句拆分）</span></div>
      ${showReview ? renderReviewHtml(s, review) : ''}
      <textarea class="editor" rows="2" data-sugg-text="${esc(s.id)}" ${s.status === 'pending' ? '' : 'disabled'}>${esc(s.text)}</textarea>
      ${actions}
    </div>`;
  }).join('');
}

function renderMachine() {
  const m = S.machine;
  const badge = $('machineBadge');
  badge.className = 'chip ' + (m.stale ? 'danger' : 'ok');
  badge.textContent = m.stale ? '陈旧，需重算' : '最新';
  $('machineMeta').innerHTML = `数据元 <b>${m.count}</b> 条<br/>生成时间 ${esc(m.generatedAt || '—')}`;
  $('machineReasons').innerHTML = m.stale ? `<div class="row">${m.reasons.map((r) => `<span class="chip danger">${esc(r)}</span>`).join('')}</div>` : '';
  $('machineElements').innerHTML = m.elements.length === 0
    ? '<div class="empty">尚无机读数据元（先点"重算"）。</div>'
    : `<table class="mini"><thead><tr><th>标签</th><th>值</th><th>来源</th><th>置信度</th></tr></thead><tbody>
        ${m.elements.map((e) => `<tr>
          <td><code>${esc(e.code)}</code><div class="muted">${esc(e.display)}</div></td>
          <td>${esc(e.value)} <span class="muted">${esc(e.unit)}</span></td>
          <td>${e.origin === 'ai' ? '<span class="chip ai">AI</span>' : `<span class="chip">${esc(e.origin)}</span>`}</td>
          <td>${e.confidence == null ? '—' : Number(e.confidence).toFixed(2)}</td>
        </tr>`).join('')}
      </tbody></table>`;
}

function renderExport() {
  const e = S.lastExport;
  const w = S.lastWst500;
  const unlockButton = $('btnUnlock');
  if (unlockButton) unlockButton.classList.toggle('hide', S.doc.status !== 'signed');
  /* 签名信息与导出记录分开渲染：即使还没导出，只要签了章就应该能看到"用了什么算法、验签是否通过" */
  renderSignature();
  renderReading();
  renderAudit();

  const checks = (e?.probe?.checks || []).map((c) => `<div class="check">
      <span class="verdict ${c.pass ? 'ok' : 'bad'}">${c.pass ? 'PASS' : 'FAIL'}</span>
      <span><b>[${esc(c.id)}]</b> ${esc(c.name)}${c.critical ? '' : ' <span class="muted">(非关键)</span>'}<br/><span class="muted">${esc(c.detail)}</span></span>
    </div>`).join('');
  const rt = e?.probe?.roundTrip;

  $('exportBody').innerHTML = `
    <div class="muted mb10"><b>两种产物都要留</b>：OFD 归档、XML 交换。</div>

    <div class="sugg">
      <div class="row">
        <span class="chip ${e ? (e.probeExit === 0 ? 'ok' : 'danger') : ''}">OFD-H 归档定版</span>
        ${e
          ? `<span class="chip">${e.pages} 页</span>
             <span class="chip">真实文本 ${e.stats.textChars} 字</span>
             <span class="chip">数据元 ${e.stats.dataElements}</span>
             <span class="chip">${(e.stats.bytes / 1024).toFixed(1)} KB</span>
             <span class="chip ${e.probeExit === 0 ? 'ok' : 'danger'}">探针 ${esc(e.probe?.verdict ?? 'N/A')}</span>
             <a class="push" href="/api/download">下载 OFD-H</a>`
          : '<span class="muted push">尚未导出，点右上角「导出」</span>'}
      </div>
      ${e
        ? `<div class="muted mt4">产物：<code>${esc(e.file)}</code>（ZIP 容器，可解包核查） · ${esc(e.exportedAt || '—')}</div>
           ${rt ? `<div class="chip ${rt.completeness >= 0.95 ? 'ok' : 'danger'} mt6">round-trip 完整率 ${(rt.completeness * 100).toFixed(1)}%（${rt.found}/${rt.total}）</div>` : ''}
           <div class="checks">${checks}</div>`
        : `<div class="muted mt4">版式文件 + 机读信息 + 签章，用来<b>归档封存</b>。</div>
           <div class="muted mt4">会拦的只有两种：<b>机读信息陈旧</b>（到「机读信息」点重算）、<b>签名服务未配置</b>。</div>`}
    </div>

    <div class="sugg">
      <div class="row">
        <span class="chip ${w ? 'ok' : ''}">WS/T 500 共享文档</span>
        ${w
          ? `<span class="chip">${w.sections} 章节 / ${w.paragraphs} 段 / ${w.fields} 数据元</span>
             <span class="chip">${(w.bytes / 1024).toFixed(1)} KB</span>
             <a class="push" href="/api/download-wst500">下载 XML</a>`
          : '<span class="muted push">尚未导出</span>'}
      </div>
      ${w
        ? `<div class="muted mt4">产物：<code>${esc(w.file)}</code>（结构化 XML，可被他人系统抽取） · ${esc(w.exportedAt || '—')}</div>`
        : '<div class="muted mt4">结构化 XML，用来<b>进区域平台 / 被他人系统抽取</b>。</div>'}
      <div class="row mt8"><button id="btnExportWst500">${w ? '重新导出' : '导出共享文档'}</button></div>
    </div>`;
}

function providerLabel(provider) {
  if (provider === 'http') return '医院签名服务';
  if (provider === 'software') return '内置软件（演示）';
  return provider || '未知';
}

function renderSignature() {
  const el = $('signBody');
  if (!el) return;
  const sign = S.sign;
  if (!sign) {
    el.innerHTML = '<div class="empty">本份病历尚未签章。签章前需通过三道门：关键内容已确认、无未确认 AI 内容、无未确认导入内容。</div>';
    return;
  }
  const state = S.signatureState || null;
  const verify = S.signatureVerified;
  const voided = !!state && state.kind === 'voided';
  const verdict = voided
    ? '<span class="chip warn">原签章已作废（已解锁）</span>'
    : !verify
      ? '<span class="chip">未验签</span>'
      : verify.ok
        ? '<span class="chip ok">验签通过</span>'
        : '<span class="chip danger">验签失败</span>';
  const reasons = (!voided && verify && !verify.ok ? verify.reasons : []).map((text) => `<li>${esc(text)}</li>`).join('');
  const invalidated = voided ? state.voidedBy && state.voidedBy.invalidated[0] : null;
  const voidedNote = voided
    ? `<div class="note mt8">本份病历已被<b>解锁</b>：原签章作废，当前<b>没有有效签章</b>，改完需重新签章。
        独立验签的结果不能用于判断"是否被篡改"（解锁后内容未改，仍会通过）；两种情形都<b>不是被篡改</b>。</div>
       <div class="muted mt6">解锁理由：${esc((state.voidedBy && state.voidedBy.reason) || '—')}</div>
       <div class="muted">解锁时间：${esc((state.voidedBy && state.voidedBy.at) || '—')}（留痕里可查）</div>
       <div class="muted mt6">被作废的签章：指纹 <code>${esc(String((invalidated && invalidated.publicKeyFingerprint) || '').slice(0, 32))}…</code>${
         invalidated && invalidated.signedAt ? ` · 签于 ${esc(invalidated.signedAt)}` : ''
       }</div>`
    : '';
  el.innerHTML = `
    <div class="row mb8">
      <span class="chip">${esc(sign.algorithm || '未知算法')}</span>
      <span class="chip" title="签名元数据里的 provider：${esc(sign.provider || '')}">签名后端 ${esc(providerLabel(sign.provider))}</span>
      ${verdict}
    </div>
    <div class="muted mb6">公钥指纹（SM3/SPKI）：<code>${esc((sign.publicKeyFingerprint || '').slice(0, 32))}…</code></div>
    <div class="muted mb6">签章时间：${esc(sign.signedAt || '—')}</div>
    <div class="muted">覆盖范围：${(sign.covers || []).map((item) => `<code>${esc(item)}</code>`).join(' ')}</div>
    ${voidedNote}
    ${reasons ? `<ul class="note-list mt6">${reasons}</ul>` : ''}`;
}

function renderAudit() {
  const body = $('auditBody');
  if (!body) return;
  const audit = S.lastAudit;
  if (!audit) {
    body.innerHTML = '<div class="empty">尚未生成审计报告。报告只汇总"本系统能证明的事实"，不构成合规结论。</div>';
    return;
  }
  const chip = audit.passed === audit.total
    ? `<span class="chip ok">机器可判定项 ${audit.passed}/${audit.total} 通过</span>`
    : `<span class="chip danger">机器可判定项 ${audit.passed}/${audit.total} 通过</span>`;
  const failed = (audit.failed || []).map((item) => `
    <div class="muted ml8">❌ ${esc(item.description)}${item.detail ? ` · 证据：<code>${esc(item.detail)}</code>` : ''}</div>`).join('');
  body.innerHTML = `
    <div class="mb4">${chip} <span class="muted">生成于 ${esc((audit.generatedAt || '').slice(0, 19))}</span></div>
    <div class="muted">报告指纹 <code>${esc(audit.reportDigest || '')}</code></div>
    <div class="muted">Markdown <code>${esc(audit.mdPath || '')}</code><br />JSON <code>${esc(audit.jsonPath || '')}</code></div>
    ${failed}`;
}

function pemFromBase64(base64) {
  const wrapped = String(base64 || '').replace(/(.{64})/g, '$1\n').trim();
  return `-----BEGIN PUBLIC KEY-----\n${wrapped}\n-----END PUBLIC KEY-----`;
}

function renderReading() {
  const body = $('readingBody');
  if (!body) return;

  const keyStore = S.recipientKeys || { keys: [], error: null };
  const keyBody = $('rkBody');
  if (keyBody) {
    const rows = (keyStore.keys || []).map((key) => `
      <div class="trow">
        <div><span class="ttl">${esc(key.label)}</span> <span class="muted">指纹 ${esc((key.fingerprint || '').slice(0, 16))}…</span></div>
        <div class="row no-grow push">
          <button data-rk-export="${esc(key.keyId)}">导出公钥</button>
          <button data-rk-remove="${esc(key.keyId)}">移除</button>
        </div>
      </div>`).join('');
    keyBody.innerHTML = (keyStore.error ? `<div class="chip danger mb6">公钥目录读取失败：${esc(keyStore.error)}</div>` : '')
      + (rows || '<div class="empty">尚未导入接收方公钥。</div>');
  }
  const reading = S.reading || { grants: [], lastView: null, reads: [] };
  const grants = reading.grants || [];
  /* 文档指纹要看得见、能复制：它是交给授权平台的输入，
     平台不可能猜出这份文档的指纹，藏起来等于"对接无从谈起"。 */
  const fpCell = $('readingDocFingerprint');
  if (fpCell) fpCell.textContent = reading.documentFingerprint || '—';
  const jsonLine = S.lastJson
    ? `<div class="chip ok mb8">已导出文档 JSON：${esc(S.lastJson.file)}（${S.lastJson.nodes} 节点 / ${S.lastJson.bytes} 字节），可直接供 S2/S3/S5 独立探针使用</div>`
    : '<div class="muted mb8">尚未导出文档 JSON（供独立探针核对）。</div>';
  if (grants.length === 0) {
    body.innerHTML = `${jsonLine}<div class="empty">尚无阅读授权：签章后的病历默认不出库。要给人看，需由<b>授权源</b>签发授权（演示模式下在「配置管理 → 受控阅读」）。</div>`;
    return;
  }

  const trustedFingerprints = (S.readingAuthority && Array.isArray(S.readingAuthority.trustedFingerprints))
    ? S.readingAuthority.trustedFingerprints
    : [];
  const rows = grants.map((grant) => {
    const remaining = grant.maxReads === null ? '不限' : Math.max(0, grant.maxReads - grant.readCount);
    const issuerTrusted = trustedFingerprints.includes(grant.publicKeyFingerprint);
    const stateChip = grant.revoked
      ? '<span class="chip danger">已停用</span>'
      : remaining === 0
        ? '<span class="chip danger">次数用尽</span>'
        : (issuerTrusted ? '<span class="chip ok">有效</span>' : '<span class="chip warn">签发者不受信</span>');
    return `<div class="trow align-start">
      <div>
        <div><code>${esc(grant.grantId)}</code> ${stateChip}${grant.encryptedDelivery ? ' <span class="chip warn">加密交付</span>' : ' <span class="chip">明文阅读</span>'}</div>
        <div class="muted mt4">用途 ${esc(grant.purpose)} · 至 ${esc(grant.notAfter.slice(0, 16))} · 已读 ${grant.readCount}/${grant.maxReads === null ? '∞' : grant.maxReads}（剩 ${remaining}）${grant.environments.length ? ` · 限终端 ${esc(grant.environments.join('/'))}` : ' · 不限终端'}${grant.concealPatientIdentity ? ' · 隐藏身份' : ''}</div>
        <div class="muted mt4">签发者公钥指纹 <code>${esc((grant.publicKeyFingerprint || '').slice(0, 24))}…</code></div>
      </div>
      <div class="row no-grow push">
        <button class="primary" data-grant-open="${esc(grant.grantId)}">以此为授权阅读</button>
        <button data-grant-revoke="${esc(grant.grantId)}" ${grant.revoked ? 'disabled' : ''} title="只作用于本系统：真实撤销应由授权源（院内平台）发起">停用（本系统）</button>
      </div>
    </div>`;
  }).join('');

  const denied = (reading.reads || []).filter((read) => !read.allowed).slice(-1)[0];
  const denyLine = denied
    ? `<div class="chip danger my6">最近一次拒绝：${esc(denied.code || '')} · ${esc(denied.reason || '')}（终端 ${esc(denied.environmentId || '')}）</div>`
    : '';

  const view = reading.lastView;
  let viewBlock = '<div class="muted mt8">尚未读取。</div>';
  if (view) {
    const sections = view.sections.length === 0
      ? '<div class="chip danger">本次授权未放行任何章节（不默认放行）</div>'
      : view.sections.map((section) => `
        <div class="mt6">
          <div><span class="ttl">${esc(section.title)}</span> <span class="muted">（${section.fields.length} 条数据元）</span></div>
          ${section.paragraphs.map((text) => `<div class="muted ml8">${esc(text)}</div>`).join('')}
          ${section.fields.map((field) => `<div class="muted ml8"><code>${esc(field.code)}</code> ${esc(field.display || '')} = ${esc(field.value)}${field.unit ? ' ' + esc(field.unit) : ''}</div>`).join('')}
        </div>`).join('');
    viewBlock = `
      <div class="mt8">
        ${view.notices.map((text) => `<div class="chip warn mb4">${esc(text)}</div>`).join('')}
        <div class="chip ok my6">视图来源：${reading.lastViewSource === 'unsealed' ? '受控加密阅读（已解封内容密钥）' : '明文阅读'}</div>
        <div class="muted my6">患者：${esc(view.patientLabel)} · 剩余次数 ${view.remainingReads === null ? '不限' : view.remainingReads} · 隐藏章节 ${view.concealedSectionCount} 个</div>
        ${sections}
      </div>`;
  }

  body.innerHTML = `${jsonLine}<div class="checks">${rows}</div>${denyLine}${viewBlock}`;
}

function renderImport() {
  const card = $('importCard');
  const info = S.importSource;
  if (!info) {
    card.style.display = 'none';
    return;
  }
  card.style.display = 'block';
  /* 摘要由服务端给出（两种格式口径一致）；老数据没有 summary 时退回按字段拼接 */
  $('importMeta').textContent = info.summary || `${info.format} · ${info.pages} 页 · ${info.textChars} 字 · 机读数据 ${info.machineElements ?? 0} 条`;
  const verified = info.signatureVerified;
  const algorithm = info.signatureAlgorithm || '';
  let signature;
  if (!info.signed) signature = '<span class="chip">源文件未签章</span>';
  else if (info.signaturePlaceholder) signature = '<span class="chip warn">源签名为占位符（不能作合规证据）</span>';
  else if (verified === true) signature = `<span class="chip ok">源文件已签章 · 验签通过（${esc(algorithm)}）</span>`;
  else if (verified === false) signature = `<span class="chip danger">源文件已签章 · 验签失败（${esc(algorithm)}）</span>`;
  else signature = '<span class="chip warn">源文件已签章 · 未验签（缺少签名材料）</span>';
  const low = Number(info.layoutLow ?? 0);
  const layout = info.layoutParagraphs === undefined
    ? ''
    : `<span class="chip ${low > 0 ? 'warn' : 'ok'}">段落重建 ${info.layoutParagraphs} 段 · 高 ${info.layoutHigh ?? 0} / 中 ${info.layoutMedium ?? 0} / 低 ${low}</span>
       <span class="chip">策略 ${esc(String(info.layoutStrategy ?? ''))}</span>`;
  const warnings = (info.warnings || []).map((text) => `<span class="chip danger">${esc(text)}</span>`).join(' ');
  const notes = (info.reviewNotes || []).map((text) => `<li>${esc(text)}</li>`).join('');
  $('importBody').innerHTML = `
    <div class="row mb8">
      <span class="chip">源文件 ${esc(info.fileName)}</span>
      ${signature}
      <span class="chip tag">sha256:${esc(String(info.sha256 ?? '').slice(0, 12))}…</span>
    </div>
    ${layout ? `<div class="row mb8">${layout}</div>` : ''}
    <div class="hint mb8">导入件是<b>新草稿</b>，不继承源文件的签名状态；法律效力仍在源文件上。下列提示来自识别过程，请人工核对后再使用。</div>
    ${warnings ? `<div class="row mb8">${warnings}</div>` : ''}
    ${notes ? `<ul class="muted note-list">${notes}</ul>` : ''}`;
}

function renderLog() {
  $('logBody').innerHTML = S.log.length === 0
    ? '<div class="empty">暂无操作记录。</div>'
    : S.log.map((l) => `<div class="logline">
        <span class="time">${esc((l.at || '').slice(11, 19))}</span>
        ${l.ok ? '<code class="ok">OK</code>' : `<code class="bad">${esc(l.code)}</code>`}
        <span>${esc(l.action)}${l.message ? `<br/><span class="muted">${esc(l.message)}</span>` : ''}</span>
      </div>`).join('');
}

function renderMetrics() {
  const m = S.metrics;
  const a = S.attribution;
  const attribution = a
    ? `<div class="stat" title="采纳后一字未改：模型写对了"><b>${a.asIs}</b><span>采纳·原样</span></div>
       <div class="stat" title="改动幅度 ≤20%：多半是措辞 / 错字 → 该改提示词"><b>${a.light}</b><span>采纳·微改</span></div>
       <div class="stat" title="改动幅度 >20%：多半是事实或结构不对 → 该改上下文供给"><b>${a.heavy}</b><span>采纳·大改</span></div>
       ${a.unknown > 0 ? `<div class="stat" title="这些采纳没有改动幅度记录（老数据 / 别的来源写入）——不符合并进任何一档"><b>${a.unknown}</b><span>采纳·未归因</span></div>` : ''}`
    : '';
  $('metrics').innerHTML = `
    <div class="stat"><b>${m.suggested}</b><span>AI 建议数</span></div>
    <div class="stat"><b>${(m.adoptionRate * 100).toFixed(0)}%</b><span>采纳率</span></div>
    <div class="stat"><b>${(m.editRate * 100).toFixed(0)}%</b><span>修改率（最诚实）</span></div>
    <div class="stat"><b>${(m.rejectRate * 100).toFixed(0)}%</b><span>拒绝率</span></div>
    ${attribution}`;
  $('audit').innerHTML = `<table class="mini"><thead><tr><th>rev</th><th>操作</th><th>执行者</th><th>patch</th><th>AI 信息</th></tr></thead><tbody>
    ${S.audit.map((a) => `<tr>
      <td>${a.rev}</td><td><code>${esc(a.op)}</code></td><td>${esc(a.actorId)}</td>
      <td>${a.patchOps}</td>
      <td>${a.modelId ? `${esc(a.modelId)} / ${a.confidence ?? ''}` : '—'}</td>
    </tr>`).join('')}</tbody></table>`;
  renderHistory();
}

const HISTORY_LIMIT = 15;

async function doUndo() {
  const r = await api('/api/undo', {});
  docNotice = r.ok
    ? '已撤销上一次写入；这次撤销本身也写进了留痕（再点一次「撤销」＝重做）。'
    : `未能撤销：${(r && (r.message || r.code)) || '未知原因'}`;
  await apply(r);
}

function openHistory() {
  const drawer = $('historyDrawer');
  if (!drawer) return;
  renderHistory();
  if (!drawer.open) drawer.showModal();
  document.body.classList.add('drawer-open');
  const close = $('historyClose');
  if (close) close.focus();
}

function closeHistory() {
  const drawer = $('historyDrawer');
  if (!drawer) return;
  if (drawer.open) drawer.close();
  document.body.classList.remove('drawer-open');
  /* 焦点还给触发按钮：否则键盘用户关掉浮层就"掉"回页面顶部 */
  const opener = $('btnUndo');
  if (opener) opener.focus();
}

{
  const drawer = $('historyDrawer');
  if (drawer) {
    drawer.addEventListener('cancel', () => {
      document.body.classList.remove('drawer-open');
      const opener = $('btnUndo');
      if (opener) opener.focus();
    });
    drawer.addEventListener('click', (event) => {
      if (event.target === drawer) closeHistory();
    });
  }
}

function showHistoryError(message) {
  const body = $('historyBody');
  if (!body) return;
  const old = body.querySelector('.hist-error');
  if (old) old.remove();
  const box = document.createElement('div');
  box.className = 'hist-error';
  box.textContent = message;
  body.prepend(box);
}

function renderHistory() {
  const body = $('historyBody');
  if (!body) return;
  const status = (S.doc && S.doc.status) || 'draft';
  const latest = (S.doc && S.doc.rev) || 0;
  const undo = S.undo;

  const blocked =
    status === 'reviewing'
      ? '审核中不可回滚：要改先由审核人退回'
      : status === 'signed'
        ? '已签章不可回滚：须先「解锁」'
        : status === 'archived' || status === 'void'
          ? `已${status === 'archived' ? '归档' : '作废'}：终态不可回滚`
          : '';

  const shown = (S.audit || []).slice(0, HISTORY_LIMIT);
  const rows = shown.map((a) => {
    const at = String(a.at || '').replace('T', ' ').slice(5, 19);
    const summary = String(a.summary || a.op || '');
    let action;
    if (a.rev >= latest) action = '<span class="hist-note">当前版本</span>';
    else if (blocked) action = `<span class="hist-note">${esc(blocked)}</span>`;
    else {
      action = `<button class="hist-btn" data-revert-rev="${a.rev}" title="回到第 ${a.rev} 版">回到这一版</button>`;
    }
    return `<div class="hist-row">
      <span class="hist-rev">#${a.rev}</span>
      <span class="hist-time">${esc(at)}</span>
      <span class="hist-sum" title="${esc(summary)}">${esc(summary)}</span>
      <span class="hist-act">${action}</span>
    </div>`;
  }).join('');

  body.innerHTML = `
    <div class="hist-top">
      <button class="hist-undo" data-undo-now="1" ${undo ? '' : 'disabled'}
        title="${undo ? `撤销第 ${undo.rev} 条（${esc(undo.op)}）` : '没有可撤销的写入（只支持撤销最近一次；签章 / 解锁之后不可撤销）'}">
        撤销最近一次${undo ? `　#${undo.rev} · ${esc(undo.op)}` : ''}
      </button>
    </div>
    <div class="hist-caption">最近 ${shown.length} 次${(S.audit || []).length > shown.length ? `（共 ${(S.audit || []).length} 次）` : ''}</div>
    <div class="hist-list">${rows || '<div class="empty">这份病历还没有写入记录。</div>'}</div>`;
}

function renderPanelBadges() {
  const pending = S.suggestions.filter((s) => s.status === 'pending').length;
  const lastError = S.log.find((l) => !l.ok);

  $('badgeAi').innerHTML = `<span class="chip">建议 ${S.suggestions.length}</span>${pending ? ` <span class="chip warn">待处理 ${pending}</span>` : ''}`;

  const annoCounts = S.annotationCounts || { open: 0, acknowledged: 0, anchorLost: 0 };
  const annoPending = annoCounts.open + annoCounts.acknowledged;
  const qcDot = $('tabDotQc');
  qcDot.className = `tdot${annoPending > 0 || annoCounts.anchorLost > 0 ? ' warn' : ''}`;
  qcDot.title = `待处理提示 ${annoPending} · 锚点丢失 ${annoCounts.anchorLost}`;

  const timeline = S.visitTimeline;
  const timelineDot = $('tabDotTimeline');
  if (timelineDot) {
    const gaps = timeline ? timeline.gaps.length : 0;
    timelineDot.className = `tdot${gaps > 0 ? ' warn' : ''}`;
    timelineDot.title = timeline ? `就诊时间轴：缺口 ${gaps} 条` : '尚未读取就诊时间轴';
  }

  const voiceDot = $('tabDotVoice');
  voiceDot.className = `tdot${S.dictation ? ' warn' : ''}`;
  voiceDot.title = S.dictation ? `最近一次转写：${S.dictation.segments.length} 段 → 一组建议` : '尚无转写';
  $('badgeLog').innerHTML = lastError
    ? `<span class="chip danger">最近被拒 ${esc(lastError.code)}</span>`
    : `<span class="chip">${S.log.length} 条</span>`;
  const m = S.metrics;
  $('badgeMetrics').innerHTML = `<span class="chip">修改率 ${(m.editRate * 100).toFixed(0)}%</span>`;

  /* 未显示的面板靠页签上的小圆点传达状态（否则切走就"断线"了） */
  const e = S.lastExport;
  const exportDot = e ? (e.probeExit === 0 ? 'ok' : 'danger') : (S.doc.status === 'signed' ? 'ok' : '');
  $('tabDotAi').className = `tdot ${pending > 0 ? 'warn' : ''}`;
  $('tabDotMachine').className = `tdot ${S.machine.stale ? 'danger' : 'ok'}`;
  $('tabDotExport').className = `tdot ${exportDot}`;
  $('tabDotLog').className = `tdot ${lastError ? 'danger' : ''}`;
  $('tabDotMetrics').className = `tdot ${m.editRate > 0.5 ? 'warn' : ''}`;
}

/** 就诊类型的中文名。界面上一律用中文：`outpatient` 是模型里的取值，不是给医生读的词 */
const VISIT_SCOPE_LABEL = { outpatient: '门诊', emergency: '急诊', inpatient: '住院' };

function templateFitsVisit(tpl, visitType) {
  const scope = Array.isArray(tpl.visitTypes) ? tpl.visitTypes : [];
  if (scope.length === 0 || !visitType) return true;
  return scope.includes(visitType);
}

async function pickTemplate() {
  const all = Array.isArray(S.templates) ? S.templates : [];
  const visitType = (S.encounter && S.encounter.visitType) || '';
  const visitLabel = VISIT_SCOPE_LABEL[visitType] || '';
  const list = all.filter((tpl) => templateFitsVisit(tpl, visitType));

  if (all.length === 0) {
    await askAlert('未装载模板包\n\n这台机器上一份可开的模板都没有（没装，或全部被停用），所以开不出新文书。由管理员在「模板」里装载。');
    return null;
  }
  if (list.length === 0) {
    await askAlert(
      `本次就诊开不出文书\n\n已装载的模板都属于别的就诊类型（本次是${visitLabel || '未知类型'}）。`
      + '\n\n门诊 / 急诊开「门（急）诊病历」，住院开「入院记录」「病程记录」「出院记录」；要别的写法，由管理员在「模板库」里加一份。',
    );
    return null;
  }

  const choices = list.map((tpl) => ({
    value: tpl.templateId,
    label: tpl.name,
    detail: [
      (tpl.docType && tpl.docType.display) || '',
      `${tpl.sectionCount} 章 / ${tpl.slotCount} 项`,
      tpl.expressionCount > 0 ? `${tpl.expressionCount} 个派生值` : '',
      tpl.visitTypes && tpl.visitTypes.length > 0
        ? `适用于${tpl.visitTypes.map((type) => VISIT_SCOPE_LABEL[type] || type).join(' / ')}`
        : '不限就诊类型',
    ].filter((part) => part !== '').join(' · '),
  }));

  const head = visitLabel
    ? `新建文书 · 本次就诊：${visitLabel}${S.encounter && S.encounter.deptName ? ` ${S.encounter.deptName}` : ''}`
    : '新建文书';
  return askChoose(
    `${head}\n\n只列出本次就诊开得出的文书。模板只给章节骨架与数据元绑定，正文由医生填写。`,
    choices,
  );
}

function renderAll() {
  document.body.classList.toggle('flow-mode', isFlow());
  applyVisitScope();
  renderHeader();
  renderTree();
  renderDoc();
  renderSuggestions();
  renderAnnotations();
  renderConsistency();
  renderTimeline();
  renderCompare();
  renderPrevisit();
  renderDischarge();
  renderDictation();
  renderCaptureLocal();
  void renderCaptureHistory();
  renderRejectBanner();
  document.body.classList.toggle('clinical', isClinical());
  const viewSelect = $('viewMode');
  if (viewSelect && viewSelect.value !== viewMode) viewSelect.value = viewMode;
  syncEditMode();
  const tools = $('flowTools');
  if (tools) tools.hidden = !isFlow();
  if (!isFlow()) setFlowToolsFloating(false);
  renderImport();
  renderMachine();
  if (panelAlive('export')) renderExport();
  if (panelAlive('log')) renderLog();
  if (panelAlive('metrics')) renderMetrics();
  renderHistory();
  renderPanelBadges();
  updateDirtyBadge();
  autosizeAll();

  const select = $('suggTarget');
  const current = select.value;
  const targets = S.items.filter((i) => i.kind === 'text');
  const optionsOf = () => targets.map((i) => {
    const label = (i.tags[0]?.display || i.text.slice(0, 18) || i.id).trim();
    return `<option value="${esc(i.id)}">${esc(label)} ${i.keyContent ? '（关键内容）' : ''} · ${esc(i.id)}</option>`;
  }).join('');
  select.innerHTML = optionsOf();
  if (current) select.value = current;

  const qcSelect = $('qcTarget');
  const qcCurrent = qcSelect.value;
  qcSelect.innerHTML = optionsOf();
  if (qcCurrent) qcSelect.value = qcCurrent;
}

async function apply(result) {
  /* 重画会换掉 textarea 里的选区：浮条必须一起收掉，
     否则它会悬在一段已经不是"刚才选中那段"的文字上方。 */
  hideSelectionBar();
  if (result && result.state) { S = result.state; renderAll(); }
  else await refresh();
  if (result && result.ok === false) toast(`${result.code || ''} ${result.message || ''}`.trim(), 'danger');
  else if (result) toast('已生效', 'ok');
  hostEmit('state', hostSnapshot());
  return result;
}

let toastTimer = null;

function toast(text, kind) {
  const el = $('toast');
  if (!el) return;
  el.textContent = text;
  el.className = kind === 'danger' ? 'toast danger' : kind === 'info' ? 'toast info' : 'toast';
  el.setAttribute('aria-live', kind === 'danger' ? 'assertive' : 'polite');
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, kind === 'danger' ? 4200 : 2600);
}

async function refresh() {
  const res = await api('/api/state');
  if (res.ok) { S = res.state; renderAll(); }
  return res;
}

document.addEventListener('change', (event) => {
  const el = event.target;
  if (!el || el.id !== 'viewMode') return;
  viewMode = el.value === 'clinical' ? 'clinical' : 'demo';
  try { localStorage.setItem(MODE_KEY, viewMode); } catch { }
  renderAll();
});

function syncEditMode(mode = editMode) {
  const seg = $('editMode');
  if (!seg) return;
  seg.dataset.mode = mode;
  seg.querySelectorAll('.seg-item').forEach((item) => {
    const on = item.dataset.mode === mode;
    item.setAttribute('aria-checked', on ? 'true' : 'false');
    item.tabIndex = on ? 0 : -1;
  });
}

function paperSwap() {
  const host = $('docBody');
  if (!host) return;
  host.classList.remove('paper-swap');
  void host.offsetWidth;
  host.classList.add('paper-swap');
  host.addEventListener('animationend', () => host.classList.remove('paper-swap'), { once: true });
}

async function setEditMode(mode) {
  const next = mode === 'flow' ? 'flow' : 'card';
  if (next === editMode) return;
  syncEditMode(next);
  await flushEdits();
  editMode = next;
  try { localStorage.setItem(EDIT_MODE_KEY, editMode); } catch { }
  renderAll();
  paperSwap();
}

document.addEventListener('click', (event) => {
  const target = event.target;
  const item = target instanceof Element ? target.closest('.seg-edit .seg-item') : null;
  if (!item) return;
  void setEditMode(item.dataset.mode);
});

document.addEventListener('click', (event) => {
  const target = event.target;
  const button = target instanceof Element ? target.closest('#docFont [data-font]') : null;
  if (!button) return;
  stepDocFont(Number(button.dataset.font) < 0 ? -1 : 1);
});

document.addEventListener('keydown', (event) => {
  const target = event.target;
  const item = target instanceof Element ? target.closest('.seg-edit .seg-item') : null;
  if (!item) return;
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  event.preventDefault();
  const items = [...item.parentElement.querySelectorAll('.seg-item')];
  const step = event.key === 'ArrowRight' ? 1 : -1;
  const next = items[(items.indexOf(item) + step + items.length) % items.length];
  if (!next || next === item) return;
  next.focus();
  void setEditMode(next.dataset.mode);
});

document.addEventListener('change', (event) => {
  const el = event.target;
  if (el && el.id === 'cfgPlaceStrategy') syncPlacementTerms(el.value);
});

let MY_CONTENT = [];
let MY_CONTENT_ERRORS = [];

const MY_CONTENT_KIND = { phrase: '常用语', 'content-paragraph': '内容段落' };
const MY_CONTENT_SCOPE = { personal: '我的', dept: '本科室', hospital: '全院' };

let contentTargetCaret = null;
let lastCaret = null;
let contentContinuous = false;

function currentDocId() {
  return (S && S.doc && S.doc.docId) ? String(S.doc.docId) : '';
}

function caretAlive(caret) {
  if (!caret || !caret.nodeId) return false;
  if (caret.docId && currentDocId() && caret.docId !== currentDocId()) return false;
  const items = Array.isArray(S && S.items) ? S.items : [];
  return items.some((node) => node.id === caret.nodeId && node.kind === 'text');
}

function rememberCaret() {
  const el = document.activeElement;
  if (el && el.tagName === 'TEXTAREA' && el.dataset && el.dataset.edit) {
    lastCaret = {
      nodeId: el.dataset.edit,
      start: typeof el.selectionStart === 'number' ? el.selectionStart : null,
      end: typeof el.selectionEnd === 'number' ? el.selectionEnd : null,
      docId: currentDocId(),
    };
    return;
  }
  if (!isFlow()) return;
  const selection = window.getSelection();
  const anchor = selection && selection.anchorNode ? selection.anchorNode : null;
  const host = anchor && (anchor.nodeType === 1 ? anchor : anchor.parentElement);
  const block = host && typeof host.closest === 'function' ? host.closest('.fp[data-node-id]') : null;
  if (block && block.dataset.nodeId) {
    lastCaret = { nodeId: block.dataset.nodeId, start: null, end: null, docId: currentDocId() };
  }
}

function sectionTitleOf(nodeId) {
  const items = Array.isArray(S && S.items) ? S.items : [];
  const index = items.findIndex((node) => node.id === nodeId);
  if (index < 0) return '';
  for (let cursor = index; cursor >= 0; cursor -= 1) {
    if (items[cursor].kind === 'section') return String(items[cursor].title || '');
  }
  return '';
}

function renderContentTarget() {
  const el = $('contentTarget');
  if (!el) return;
  const caret = contentTargetCaret;
  if (!caret || !caretAlive(caret)) {
    el.textContent = '没有落点：先点进正文某一段，再打开这里';
    el.classList.add('warn');
    return;
  }
  el.classList.remove('warn');
  const node = (Array.isArray(S && S.items) ? S.items : []).find((candidate) => candidate.id === caret.nodeId);
  const whole = String((node && node.text) || '');
  const section = sectionTitleOf(caret.nodeId);
  const hasRange = typeof caret.start === 'number' && typeof caret.end === 'number' && caret.end > caret.start;
  if (hasRange) {
    const picked = whole.slice(caret.start, caret.end).trim();
    const pickedPreview = picked.length > 18 ? `${picked.slice(0, 18)}…` : picked;
    el.textContent = `将替换选中的 ${caret.end - caret.start} 个字${pickedPreview ? `：「${pickedPreview}」` : ''}`;
    return;
  }
  const text = whole.trim();
  const preview = text === ''
    ? '空段落（会优先填它）'
    : (text.length > 26 ? `${text.slice(0, 26)}…` : text);
  el.textContent = `将插入到：${section ? `${section} · ` : ''}${preview}`;
}

async function loadMyContent() {
  let result;
  try {
    result = await api('/api/content-list', {});
  } catch {
    MY_CONTENT = [];
    MY_CONTENT_ERRORS = ['内容清单读不出来（服务端没有响应）'];
    renderMyContent();
    return;
  }
  if (!result || result.ok !== true) {
    MY_CONTENT = [];
    MY_CONTENT_ERRORS = [String((result && (result.message || result.code)) || '内容清单读不出来')];
    renderMyContent();
    return;
  }
  const data = result.data || {};
  MY_CONTENT = Array.isArray(data.items) ? data.items : [];
  MY_CONTENT_ERRORS = Array.isArray(data.errors) ? data.errors : [];
  renderMyContent();
}

function focusEditAt(nodeId, position) {
  if (!nodeId) return;
  const target = document.querySelector(`[data-edit="${nodeId}"]`);
  if (!target) return;
  target.focus();
  const text = String(target.value ?? '');
  const at = position === null || position === undefined
    ? text.length
    : Math.max(0, Math.min(position, text.length));
  try {
    target.setSelectionRange(at, at);
  } catch {
  }
}

async function insertMyContent(item, caret, options = {}) {
  if (!item) return { ok: false, caret: null };
  if (!caret || !caret.nodeId) {
    toast('先把光标点进正文某一段，再按 Ctrl+K —— 没有落点就不猜位置', 'info');
    return { ok: false, caret: null };
  }
  /* 先落盘：插入要在"服务端那一版正文"上算位置，否则会把防抖里还没发出去的字盖掉 */
  clearTimeout(blurTimer);
  await flushEdits();
  const body = { itemId: item.id, nodeId: caret.nodeId };
  if (item.kind === 'phrase') {
    const node = (Array.isArray(S.items) ? S.items : []).find((candidate) => candidate.id === caret.nodeId);
    const length = String((node && node.text) || '').length;
    body.start = typeof caret.start === 'number' ? caret.start : length;
    body.end = typeof caret.end === 'number' ? caret.end : body.start;
  } else if (typeof caret.start === 'number' && typeof caret.end === 'number') {
    body.replaceStart = caret.start;
    body.replaceEnd = caret.end;
  }
  const result = await api('/api/content-insert', body);
  await apply(result);
  if (!(result && result.ok === true)) return { ok: false, caret: null };
  const data = result.data || {};
  const verb = item.kind === 'phrase' ? '已插入' : (data.triggerExpanded ? '已按触发词带入' : '已带入');
  toast(`${verb}「${item.name}」${data.summary ? ` · ${data.summary}` : ''}`, 'ok');

  let nextCaret = null;
  if (item.kind === 'phrase') {
    const inline = data.inline || {};
    const node = (Array.isArray(S.items) ? S.items : []).find((candidate) => candidate.id === caret.nodeId);
    const length = String((node && node.text) || '').length;
    const at = typeof inline.start === 'number'
      ? Math.min(inline.start + Number(inline.length || 0), length)
      : length;
    nextCaret = { nodeId: caret.nodeId, start: at, end: at, docId: currentDocId() };
    if (!options.keepFocus) focusEditAt(caret.nodeId, at);
  } else {
    const landed = [...(data.filled || []), ...(data.created || [])];
    const lastId = landed.length > 0 ? landed[landed.length - 1] : caret.nodeId;
    const node = (Array.isArray(S.items) ? S.items : []).find((candidate) => candidate.id === lastId);
    const length = String((node && node.text) || '').length;
    nextCaret = { nodeId: lastId, start: length, end: length, docId: currentDocId() };
    if (!options.keepFocus) focusEditAt(landed[0] || caret.nodeId, null);
  }
  void loadMyContent();
  return { ok: true, caret: nextCaret, data };
}

const TRIGGER_PATTERN_UI = /(?:^|[\s\u3000])[;；]([A-Za-z0-9_\-\u4e00-\u9fa5]{1,12})$/;

let triggerInflight = false;

function triggerHitFor(el) {
  const caret = typeof el.selectionStart === 'number' ? el.selectionStart : null;
  if (caret === null) return null;
  const before = String(el.value || '').slice(0, caret);
  const matched = TRIGGER_PATTERN_UI.exec(before);
  if (!matched) return null;
  const code = matched[1].toLowerCase();
  const item = MY_CONTENT.find((candidate) => String(candidate.trigger || '').toLowerCase() === code);
  if (!item) return null;
  const start = caret - matched[0].length;
  return { item, start, end: caret, prefix: before.slice(0, start) };
}

async function expandTrigger(hit, el) {
  if (triggerInflight) return;
  triggerInflight = true;
  try {
    await insertMyContent(hit.item, {
      nodeId: el.dataset.edit,
      start: hit.start,
      end: hit.end,
      docId: currentDocId(),
    });
  } finally {
    triggerInflight = false;
  }
}

document.addEventListener('keydown', (event) => {
  if (event.isComposing || event.keyCode === 229) return;
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.key !== ' ' && event.key !== 'Enter') return;
  const el = event.target;
  if (!el || el.tagName !== 'TEXTAREA' || !el.dataset || !el.dataset.edit) return;
  const hit = triggerHitFor(el);
  if (!hit) return;
  if (hit.item.kind === 'content-paragraph' && hit.prefix.trim() !== '') return;
  event.preventDefault();
  void expandTrigger(hit, el);
}, true);

/** 把当前这一段存进"个人模板"。脱敏与 PHI 检查在服务端，客户端只负责问名字 */
async function saveParagraphAsContent(kind, caret) {
  if (!caret || !caret.nodeId) {
    toast('先把光标点进要存的那一段正文', 'info');
    return;
  }
  const node = (Array.isArray(S.items) ? S.items : []).find((candidate) => candidate.id === caret.nodeId);
  const text = String((node && node.text) || '').trim();
  if (text === '') {
    toast('这一段还是空的：先写下要存的内容', 'info');
    return;
  }
  const name = await askText(
    `给这${kind === 'phrase' ? '句常用语' : '段内容'}起个名字\n\n名字是清单里的那一行，写“腹部查体（正常）”“我这里正常”这类一眼认得出的。`,
    { okLabel: '存进个人模板', required: true },
  );
  if (!name) return;
  const result = await api('/api/content-save-from-doc', { nodeId: caret.nodeId, kind, name });
  await apply(result);
  if (result && result.ok === true) {
    const replaced = (result.data && Array.isArray(result.data.replaced)) ? result.data.replaced : [];
    toast(
      `已存进个人模板「${name}」${replaced.length > 0 ? ` · ${replaced.length} 处患者信息换成了占位符` : ''}`,
      'ok',
    );
    await loadMyContent();
    contentGotoItem(String((result.data && result.data.item && result.data.item.id) || ''));
  }
}

async function saveSectionAsContent(caret) {
  const at = caret && caretAlive(caret) ? caret : (caretAlive(lastCaret) ? lastCaret : null);
  if (!at) {
    toast('先点进正文某一段，再另存整章 —— 没有落点就不知道存哪一章', 'info');
    return;
  }
  const title = sectionTitleOf(at.nodeId);
  const name = await askText(
    `把「${title || '光标所在这一章'}」整章存成一条内容段落？\n\n`
      + '存进去的是这一章现有的每一段（空段不存，子章节不算在内）。患者信息会换成占位符，残余的身份信息会被拦住。',
    {
      okLabel: '存进个人模板',
      required: true,
      ...(title !== '' ? { defaultValue: `${title}（整套）` } : {}),
    },
  );
  if (!name) return;
  const result = await api('/api/content-save-from-doc', {
    nodeId: at.nodeId,
    kind: 'content-paragraph',
    name,
    source: 'section',
  });
  await apply(result);
  if (result && result.ok === true) {
    const count = Number((result.data && result.data.paragraphs) || 0);
    const replaced = result.data && Array.isArray(result.data.replaced) ? result.data.replaced : [];
    toast(
      `已存进个人模板「${name}」 · ${count} 段${replaced.length > 0 ? ` · ${replaced.length} 处患者信息换成了占位符` : ''}`,
      'ok',
    );
    contentTab = 'content-paragraph';
    contentKeyword = '';
    const searchBox = $('contentSearch');
    if (searchBox) searchBox.value = '';
    await loadMyContent();
    contentGotoItem(String((result.data && result.data.item && result.data.item.id) || ''));
    return;
  }
  toast(String((result && (result.message || result.code)) || '没能存进去'), 'error');
}

let selCaret = null;
let selBarDismissed = false;

function readSelectionCaret() {
  if (!S.doc || S.doc.status === 'signed' || S.doc.status === 'archived') return null;
  if (isFlow()) {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
    const range = selection.getRangeAt(0);
    const anchor = range.commonAncestorContainer;
    const host = anchor && (anchor.nodeType === 1 ? anchor : anchor.parentElement);
    const block = host && typeof host.closest === 'function' ? host.closest('.fp[data-node-id]') : null;
    if (!block) return null;
    const startBlock = L0FlowView.blockAt(block, range.startContainer);
    const endBlock = L0FlowView.blockAt(block, range.endContainer);
    if (!startBlock || !endBlock || startBlock.el !== block || endBlock.el !== block) return null;
    const start = L0FlowView.offsetIn(block, range.startContainer, range.startOffset);
    const end = L0FlowView.offsetIn(block, range.endContainer, range.endOffset);
    if (end <= start) return null;
    const text = String(block.textContent || '').slice(start, end);
    if (text.trim() === '') return null;
    return { nodeId: block.dataset.nodeId, start, end, text, rect: range.getBoundingClientRect(), docId: currentDocId() };
  }
  const el = document.activeElement;
  if (!el || el.tagName !== 'TEXTAREA' || !el.dataset || !el.dataset.edit || el.readOnly) return null;
  const start = el.selectionStart;
  const end = el.selectionEnd;
  if (typeof start !== 'number' || typeof end !== 'number' || end <= start) return null;
  const text = String(el.value || '').slice(start, end);
  if (text.trim() === '') return null;
  return { nodeId: el.dataset.edit, start, end, text, rect: el.getBoundingClientRect(), docId: currentDocId() };
}

function placeSelectionBar(caret) {
  const bar = $('selBar');
  if (!bar) return;
  bar.hidden = false;
  const size = bar.getBoundingClientRect();
  const width = window.innerWidth;
  const height = window.innerHeight;
  let left = caret.rect.left + caret.rect.width / 2 - size.width / 2;
  left = Math.max(8, Math.min(left, width - size.width - 8));
  let top = caret.rect.top - size.height - 8;
  if (top < 8) top = caret.rect.bottom + 8;
  if (top + size.height > height - 8) top = Math.max(8, height - size.height - 8);
  bar.style.left = `${Math.round(left)}px`;
  bar.style.top = `${Math.round(top)}px`;
}

function hideSelectionBar() {
  const bar = $('selBar');
  if (bar) bar.hidden = true;
  selCaret = null;
}

function refreshSelectionBar() {
  if (selBarDismissed) return;
  const caret = readSelectionCaret();
  selCaret = caret;
  if (!caret) {
    hideSelectionBar();
    return;
  }
  placeSelectionBar(caret);
}

/** 把选中的那一截存成常用语：仍走脱敏 + PHI 关卡，客户端只负责问名字 */
async function saveSelectionAsContent(caret) {
  const picked = String(caret.text || '').trim();
  if (picked === '') return;
  const preview = picked.length > 40 ? `${picked.slice(0, 40)}…` : picked;
  const name = await askText(
    `把选中的 ${picked.length} 个字存成一条常用语？\n\n「${preview}」\n\n患者信息会换成占位符，残余的身份信息会被拦住。`,
    { okLabel: '存进个人模板', required: true },
  );
  if (!name) return;
  const result = await api('/api/content-save-from-doc', {
    nodeId: caret.nodeId,
    kind: 'phrase',
    name,
    start: caret.start,
    end: caret.end,
  });
  await apply(result);
  if (result && result.ok === true) {
    const replaced = result.data && Array.isArray(result.data.replaced) ? result.data.replaced : [];
    toast(
      `已存进个人模板「${name}」${replaced.length > 0 ? ` · ${replaced.length} 处患者信息换成了占位符` : ''}`,
      'ok',
    );
    await loadMyContent();
    contentGotoItem(String((result.data && result.data.item && result.data.item.id) || ''));
    return;
  }
  toast(String((result && (result.message || result.code)) || '没能存进去'), 'error');
}

/** 复制为纯文本：贴到别处不带样式，也不带占位符外的格式 */
async function copySelectionText(caret) {
  const text = String(caret.text || '');
  if (text === '') return;
  try {
    await navigator.clipboard.writeText(text);
    toast(`已复制 ${text.length} 个字（纯文本）`, 'ok');
  } catch {
    const holder = document.createElement('textarea');
    holder.value = text;
    holder.setAttribute('readonly', '');
    holder.style.position = 'fixed';
    holder.style.left = '-9999px';
    document.body.appendChild(holder);
    holder.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    holder.remove();
    toast(ok ? `已复制 ${text.length} 个字（纯文本）` : '浏览器不让复制：请用 Ctrl+C', ok ? 'ok' : 'error');
  }
}

let polishCandidate = null;
let compareCandidate = null;

async function polishSelection(caret) {
  const result = await api('/api/polish-selection', {
    nodeId: caret.nodeId,
    start: caret.start,
    end: caret.end,
  });
  if (!(result && result.ok === true)) {
    toast(String((result && (result.message || result.code)) || 'AI 润色没有结果'), 'error');
    return;
  }
  polishCandidate = { ...result.data, nodeId: caret.nodeId, length: caret.end - caret.start };
  const dialog = $('polishDialog');
  if (!dialog) return;
  const before = $('polishBefore');
  const after = $('polishAfter');
  if (before) before.textContent = String(polishCandidate.before || '');
  if (after) after.textContent = String(polishCandidate.after || '');
  const meta = $('polishMeta');
  if (meta) {
    const confidence = typeof polishCandidate.confidence === 'number'
      ? ` · 置信度 ${Math.round(polishCandidate.confidence * 100)}%`
      : '';
    meta.textContent = `${polishCandidate.modelId || ''}${confidence}`;
  }
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
  const accept = $('polishAccept');
  if (accept) accept.focus();
}

async function acceptPolish() {
  const candidate = polishCandidate;
  const dialog = $('polishDialog');
  if (dialog && typeof dialog.close === 'function') dialog.close();
  polishCandidate = null;
  if (!candidate) return;
  const result = await api('/api/edit', { nodeId: candidate.nodeId, text: candidate.fullText });
  await apply(result);
  if (result && result.ok === true) {
    toast(`已替换选中的 ${candidate.length} 个字（AI 润色 · ${candidate.modelId || '模型'}）`, 'ok');
    return;
  }
  toast(String((result && (result.message || result.code)) || '没能替换'), 'error');
}

async function compareSelection(caret) {
  const result = await api('/api/compare-selection', {
    nodeId: caret.nodeId,
    start: caret.start,
    end: caret.end,
  });
  if (!(result && result.ok === true)) {
    toast(String((result && (result.message || result.code)) || '没有可对照的上一次'), 'info');
    return;
  }
  compareCandidate = result.data || {};
  const dialog = $('compareDialog');
  if (!dialog) return;
  const text = $('compareText');
  if (text) text.textContent = String(compareCandidate.previousText || '');
  const meta = $('compareMeta');
  if (meta) {
    const date = String(compareCandidate.createdAt || '').slice(0, 10);
    const align = compareCandidate.aligned && compareCandidate.sectionTitle
      ? `同章「${compareCandidate.sectionTitle}」`
      : '不同章（按内容相似度匹配）';
    const type = compareCandidate.sameDocType === false ? ' · 不同文书类型' : '';
    const score = Math.round(Number(compareCandidate.score || 0) * 100);
    meta.textContent = `${compareCandidate.title || compareCandidate.docId || ''} · ${date} · ${align}${type} · 重合 ${score}%`;
  }
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
  const close = $('compareClose');
  if (close) close.focus();
}

(() => {
  const polishDialog = $('polishDialog');
  if (polishDialog) {
    polishDialog.addEventListener('close', () => { polishCandidate = null; });
    const cancel = $('polishCancel');
    if (cancel) cancel.addEventListener('click', () => polishDialog.close());
    const accept = $('polishAccept');
    if (accept) accept.addEventListener('click', () => { void acceptPolish(); });
  }
  const compareDialog = $('compareDialog');
  if (compareDialog) {
    compareDialog.addEventListener('close', () => { compareCandidate = null; });
    const close = $('compareClose');
    if (close) close.addEventListener('click', () => compareDialog.close());
    const copy = $('compareCopy');
    if (copy) {
      copy.addEventListener('click', async () => {
        if (!compareCandidate) return;
        try {
          await navigator.clipboard.writeText(String(compareCandidate.previousText || ''));
          toast('已复制上次那一段', 'ok');
        } catch {
          toast('浏览器不让复制：请选中文字后 Ctrl+C', 'error');
        }
      });
    }
  }
})();

(() => {
  const bar = $('selBar');
  if (!bar) return;
  bar.addEventListener('mousedown', (event) => event.preventDefault());
  bar.addEventListener('click', async (event) => {
    const button = event.target instanceof Element ? event.target.closest('[data-sel-action]') : null;
    if (!button) return;
    const caret = selCaret;
    hideSelectionBar();
    if (!caret) return;
    const action = button.dataset.selAction;
    if (action === 'save-content') { await saveSelectionAsContent(caret); return; }
    if (action === 'replace-content') { contentTab = 'phrase'; openMyContent(caret); return; }
    if (action === 'polish-selection') { await polishSelection(caret); return; }
    if (action === 'compare-previous') { await compareSelection(caret); return; }
    if (action === 'copy') await copySelectionText(caret);
  });

  let frame = 0;
  const schedule = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = 0; refreshSelectionBar(); });
  };
  document.addEventListener('mouseup', schedule, true);
  document.addEventListener('keyup', (event) => {
    if (event.key === 'Escape') { selBarDismissed = true; hideSelectionBar(); return; }
    selBarDismissed = false;
    schedule();
  }, true);
  document.addEventListener('selectionchange', schedule);
  document.addEventListener('mousedown', (event) => {
    const target = event.target;
    if (target instanceof Element && bar.contains(target)) return;
    selBarDismissed = false;
    hideSelectionBar();
  }, true);
  window.addEventListener('scroll', () => hideSelectionBar(), true);
  window.addEventListener('resize', () => hideSelectionBar());
})();

let contentTab = 'phrase';
let contentKeyword = '';
let contentPage = 1;
/* 10 条一页：与「模板库」同一口径；抽屉一屏大约能扫六七条，10 条是"翻一次刚好"的量 */
const CONTENT_PAGE_SIZE = 10;
let contentEditorOpener = null;
let similarTimer = null;
let similarKey = '';

function escapeHtml(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function composeRows() {
  const text = $('contentText');
  return String((text && text.value) || '')
    .split(/\r?\n/)
    .map((row) => row.trim())
    .filter((row) => row !== '');
}

function updateContentHint() {
  const hint = $('contentHint');
  if (!hint) return;
  const rows = composeRows();
  const chars = rows.join('').length;
  if (rows.length === 0) {
    hint.textContent = '一行话：会插进光标所在的那一句';
    return;
  }
  if (rows.length === 1) {
    hint.textContent = chars > 500
      ? `一行 ${chars} 字，超过 500：中间按一次回车就能作为多段落带入`
      : `一行话 · ${chars} 字：会插进光标所在的那一句`;
    return;
  }
  hint.textContent = `${rows.length} 段 · ${chars} 字：会在光标之后另起 ${rows.length} 段`;
}

function renderContentSimilar(data) {
  const box = $('contentSimilar');
  if (!box) return;
  const exact = data && data.exact ? data.exact : null;
  const similar = data && Array.isArray(data.similar) ? data.similar : [];
  if (!exact && similar.length === 0) {
    box.hidden = true;
    box.innerHTML = '';
    return;
  }
  box.hidden = false;
  box.innerHTML = (exact
    ? `<div class="content-similar-exact">已有同名条目「${escapeHtml(exact.name)}」：保存会被拒 —— 改个名字，或者直接去改那一条。</div>`
    : '')
    + (similar.length > 0
      ? `<div class="content-similar-head">这里已经有相近的内容，确认不是同一件事再存：</div>`
        + similar.map((hit) => '<div class="content-similar-row">'
          + `<span class="content-similar-name">${escapeHtml(hit.item.name)}</span>`
          + `<span class="content-similar-score">${Math.round(Number(hit.score || 0) * 100)}%</span>`
          + `<span class="content-similar-preview">${escapeHtml(hit.item.preview)}</span>`
          + '</div>').join('')
      : '');
}

function scheduleContentSimilar() {
  clearTimeout(similarTimer);
  const name = String(($('contentName') && $('contentName').value) || '').trim();
  const rows = composeRows();
  if (name === '' && rows.length === 0) {
    similarKey = '';
    renderContentSimilar(null);
    return;
  }
  const key = `${name}\u0000${rows.join('\u0001')}`;
  if (key === similarKey) return;
  similarKey = key;
  similarTimer = setTimeout(() => {
    void (async () => {
      let result = null;
      try {
        result = await api('/api/content-similar', { name, paragraphs: rows });
      } catch {
        result = null;
      }
      if (!result || result.ok !== true) return;
      renderContentSimilar(result.data || {});
    })();
  }, 320);
}

function openContentEditor() {
  const dialog = $('contentEditor');
  if (!dialog) return;
  const name = $('contentName');
  const text = $('contentText');
  const trigger = $('contentTrigger');
  if (name) name.value = '';
  if (text) text.value = '';
  if (trigger) trigger.value = '';
  similarKey = '';
  clearTimeout(similarTimer);
  renderContentSimilar(null);
  updateContentHint();
  contentEditorOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
  document.documentElement.classList.add('dialog-open');
  if (name) name.focus();
}

function closeContentEditor() {
  const dialog = $('contentEditor');
  if (!dialog) return;
  clearTimeout(similarTimer);
  if (typeof dialog.close === 'function') dialog.close();
  else dialog.removeAttribute('open');
  document.documentElement.classList.remove('dialog-open');
  const opener = contentEditorOpener;
  contentEditorOpener = null;
  if (opener && opener.isConnected && typeof opener.focus === 'function') opener.focus();
}

async function submitContentEditor() {
  const name = String(($('contentName') && $('contentName').value) || '').trim();
  const rows = composeRows();
  if (name === '') {
    toast('先给它起个名字：那是清单里的那一行', 'info');
    const input = $('contentName');
    if (input) input.focus();
    return;
  }
  if (rows.length === 0) {
    toast('内容是空的：先写下要存的话', 'info');
    const text = $('contentText');
    if (text) text.focus();
    return;
  }
  const kind = rows.length > 1 ? 'content-paragraph' : 'phrase';
  /* 触发词可以不填：它不是"必须起个短码"，而是给每天都用的那几条留的近路。 */
  const trigger = String(($('contentTrigger') && $('contentTrigger').value) || '').trim();
  const result = await api('/api/content-create', {
    kind,
    name,
    paragraphs: rows,
    ...(trigger !== '' ? { trigger } : {}),
  });
  await apply(result);
  if (result && result.ok === true) {
    const saved = (result.data && result.data.item) || {};
    const savedTrigger = String(saved.trigger || '');
    toast(
      `已存进个人模板「${saved.name || name}」 · ${MY_CONTENT_KIND[kind]}`
        + (savedTrigger !== '' ? ` · 正文里打 ;${savedTrigger} 再按空格即可带入` : ''),
      'ok',
    );
    closeContentEditor();
    contentTab = kind;
    contentKeyword = '';
    const searchBox = $('contentSearch');
    if (searchBox) searchBox.value = '';
    await loadMyContent();
    contentGotoItem(String(saved.id || ''));
    return;
  }
  toast(String((result && (result.message || result.code)) || '没能存进去'), 'error');
  if (result && result.code === 'E_CONTENT_DUPLICATE_NAME') {
    renderContentSimilar({ exact: { name }, similar: [] });
  }
  if (result && result.code === 'E_CONTENT_DUPLICATE_TRIGGER') {
    const input = $('contentTrigger');
    if (input) input.focus();
  }
}

function setContentTab(tab) {
  const next = tab === 'content-paragraph' ? 'content-paragraph' : 'phrase';
  if (next === contentTab) return;
  contentTab = next;
  contentPage = 1;
  renderMyContent();
}

function contentMatches(item, keyword) {
  if (keyword === '') return true;
  const fields = [item.name, item.trigger, item.group, item.preview];
  if (Array.isArray(item.paragraphs)) fields.push(...item.paragraphs);
  return fields.some((value) => String(value ?? '').toLowerCase().includes(keyword));
}

function contentGotoItem(itemId) {
  if (!itemId || contentKeyword.trim() !== '') return;
  const items = MY_CONTENT.filter((item) => item.kind === contentTab);
  const index = items.findIndex((item) => item.id === itemId);
  if (index < 0) return;
  contentPage = Math.floor(index / CONTENT_PAGE_SIZE) + 1;
  renderMyContent();
}

function renderMyContent() {
  renderContentTarget();
  const list = $('contentList');
  if (!list) return;
  const errors = $('contentErrors');
  if (errors) {
    errors.hidden = MY_CONTENT_ERRORS.length === 0;
    errors.textContent = MY_CONTENT_ERRORS.join('；');
  }

  const phrases = MY_CONTENT.filter((item) => item.kind === 'phrase');
  const paragraphs = MY_CONTENT.filter((item) => item.kind === 'content-paragraph');
  const phraseCount = $('contentPhraseCount');
  if (phraseCount) phraseCount.textContent = String(phrases.length);
  const paraCount = $('contentParaCount');
  if (paraCount) paraCount.textContent = String(paragraphs.length);

  const keyword = contentKeyword.trim().toLowerCase();
  if (contentTab === 'phrase' && phrases.length === 0 && paragraphs.length > 0) contentTab = 'content-paragraph';
  if (contentTab === 'content-paragraph' && paragraphs.length === 0 && phrases.length > 0) contentTab = 'phrase';

  if (keyword !== '') {
    const currentHits = (contentTab === 'phrase' ? phrases : paragraphs).filter((item) => contentMatches(item, keyword)).length;
    const otherHits = (contentTab === 'phrase' ? paragraphs : phrases).filter((item) => contentMatches(item, keyword)).length;
    if (currentHits === 0 && otherHits > 0) contentTab = contentTab === 'phrase' ? 'content-paragraph' : 'phrase';
  }

  const tabs = $('contentTabs');
  if (tabs) {
    for (const button of tabs.querySelectorAll('[data-content-tab]')) {
      const active = button.dataset.contentTab === contentTab;
      button.setAttribute('aria-selected', active ? 'true' : 'false');
      button.classList.toggle('active', active);
      button.tabIndex = active ? 0 : -1;
    }
  }

  const kindLabel = contentTab === 'phrase' ? '常用语' : '内容段落';
  const canInsert = !!contentTargetCaret && caretAlive(contentTargetCaret);
  const cardOf = (item) => {
    const count = Number(item.paragraphCount || (Array.isArray(item.paragraphs) ? item.paragraphs.length : 1));
    const marks = [
      item.pinned ? '置顶' : '',
      item.scope && item.scope !== 'personal' ? (MY_CONTENT_SCOPE[item.scope] || item.scope) : '',
      item.trigger ? `;${item.trigger}` : '',
      item.group || '',
      Array.isArray(item.placeholders) && item.placeholders.length > 0 ? `占位符 ${item.placeholders.length}` : '',
    ].filter((part) => part !== '');
    const more = count > 1 ? `<div class="content-more">还有 ${count - 1} 段</div>` : '';
    return '<div class="content-card">'
      + '<div class="content-card-main">'
      + `<div class="content-name">${escapeHtml(item.name)}</div>`
      + `<div class="content-preview">${escapeHtml(item.preview)}</div>`
      + more
      + (marks.length > 0 ? `<div class="content-meta">${marks.map(escapeHtml).join(' · ')}</div>` : '')
      + '</div>'
      + '<div class="content-actions">'
      + `<button data-content-insert="${escapeHtml(item.id)}"${canInsert ? '' : ' disabled title="先点进正文某一段，再打开个人模板"'}>${contentContinuous ? '带入并继续' : '带入'}</button>`
      + `<button data-content-pin="${escapeHtml(item.id)}" title="${item.pinned ? '从清单最前面撤下来' : '钉在清单最前面（只影响你自己的顺序）'}">${item.pinned ? '取消置顶' : '置顶'}</button>`
      + `<button data-content-delete="${escapeHtml(item.id)}" title="只从个人模板里删掉，已写进病历的字不动">删</button>`
      + '</div>'
      + '</div>';
  };

  const items = contentTab === 'phrase' ? phrases : paragraphs;
  if (items.length === 0) {
    list.innerHTML = '<div class="content-empty">'
      + (MY_CONTENT.length === 0
        ? '还没有内容：在正文里按 <kbd>Ctrl</kbd>+<kbd>K</kbd> 存一条，或点「新建内容」写一条。'
        : `这一签还没有${kindLabel}：点「新建内容」写一条。`)
      + '</div>';
    return;
  }
  const matched = keyword === '' ? items : items.filter((item) => contentMatches(item, keyword));
  if (matched.length === 0) {
    list.innerHTML = '<div class="content-empty">'
      + `没有名称或内容含「${escapeHtml(contentKeyword.trim())}」的${kindLabel}（这一签共 ${items.length} 条）。`
      + '<br>换个词，或清空上方的查询条件。'
      + '</div>';
    return;
  }
  const pageCount = Math.max(1, Math.ceil(matched.length / CONTENT_PAGE_SIZE));
  if (contentPage > pageCount) contentPage = pageCount;
  if (contentPage < 1) contentPage = 1;
  const start = (contentPage - 1) * CONTENT_PAGE_SIZE;
  const pageRows = matched.slice(start, start + CONTENT_PAGE_SIZE);
  const pager = pageCount > 1
    ? '<div class="tpl-pager">'
      + `<span class="muted">第 ${contentPage} / ${pageCount} 页 · 本页 ${pageRows.length} 条`
      + `（共 ${matched.length} 条，每页 ${CONTENT_PAGE_SIZE} 条）</span>`
      + '<span class="tpl-pager-btns">'
      + `<button class="secondary" data-content-page="${contentPage - 1}"${contentPage <= 1 ? ' disabled' : ''}`
      + ' title="上一页（只翻这一页的清单，不重新拉）">上一页</button>'
      + `<button class="secondary" data-content-page="${contentPage + 1}"${contentPage >= pageCount ? ' disabled' : ''}`
      + ' title="下一页（只翻这一页的清单，不重新拉）">下一页</button>'
      + '</span></div>'
    : '';
  list.innerHTML = pageRows.map(cardOf).join('') + pager;
}

let findQuery = '';
let findCaseSensitive = false;
let findHits = [];
let findCursor = -1;

function isDocLocked() {
  const status = S && S.doc ? String(S.doc.status || '') : '';
  return status === 'signed' || status === 'archived';
}

function findCandidates() {
  const items = Array.isArray(S.items) ? S.items : [];
  const out = [];
  for (const item of items) {
    if (!item) continue;
    if (item.kind === 'text' && typeof item.text === 'string') {
      out.push({ itemId: item.id, writeId: item.id, field: false });
    } else if (item.kind === 'field') {
      out.push({ itemId: item.id, writeId: item.id, field: true });
    } else if (item.kind === 'listItem') {
      if (item.textId) out.push({ itemId: item.id, writeId: item.textId, field: false });
      if (item.fieldId) out.push({ itemId: item.id, writeId: item.fieldId, field: true });
    }
  }
  return out;
}

function textOfCandidate(candidate) {
  const item = (S.items || []).find((node) => node.id === candidate.itemId);
  if (!item) return '';
  return String((candidate.field ? item.value : item.text) ?? '');
}

function scanFindHits() {
  const query = findQuery;
  if (query === '') {
    findHits = [];
    findCursor = -1;
    return;
  }
  const fold = (text) => (findCaseSensitive ? text : text.toLowerCase());
  const needle = fold(query);
  const hits = [];
  for (const candidate of findCandidates()) {
    const text = textOfCandidate(candidate);
    if (text === '') continue;
    const body = fold(text);
    let at = body.indexOf(needle);
    while (at >= 0) {
      hits.push({ ...candidate, index: at, length: query.length });
      at = body.indexOf(needle, at + Math.max(needle.length, 1));
    }
  }
  findHits = hits;
  if (findCursor >= hits.length) findCursor = hits.length - 1;
  if (findCursor < 0 && hits.length > 0) findCursor = 0;
}

function findReplaceValue() {
  const input = $('findReplace');
  return input ? String(input.value) : '';
}

function replaceEveryIn(text) {
  if (text === '' || findQuery === '') return text;
  if (findCaseSensitive) return text.split(findQuery).join(findReplaceValue());
  const pattern = new RegExp(findQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  return text.replace(pattern, () => findReplaceValue());
}

function replaceOneIn(text, index) {
  return text.slice(0, index) + findReplaceValue() + text.slice(index + findQuery.length);
}

async function writeCandidate(candidate, nextText) {
  return candidate.field
    ? api('/api/set-field', { nodeId: candidate.writeId, value: nextText })
    : api('/api/edit', { nodeId: candidate.writeId, text: nextText });
}

function renderFindBar() {
  const count = $('findCount');
  if (count) {
    count.textContent = findHits.length === 0 ? '0 / 0' : `${findCursor + 1} / ${findHits.length}`;
  }
  const locked = isDocLocked();
  for (const id of ['findReplaceOne', 'findReplaceAll']) {
    const button = $(id);
    if (button) button.disabled = locked || findHits.length === 0;
  }
}

async function revealHit(hit) {
  const item = (S.items || []).find((node) => node.id === hit.itemId);
  if (!item) return;
  scrollToItem(item);
  const selector = hit.field ? `[data-field="${hit.writeId}"]` : `[data-edit="${hit.writeId}"]`;
  const element = document.querySelector(selector);
  if (element) {
    element.focus({ preventScroll: true });
    if (typeof element.setSelectionRange === 'function') {
      try { element.setSelectionRange(hit.index, hit.index + hit.length); } catch { }
    }
    return;
  }
  const block = document.querySelector(`[data-flow-seg] [data-node-id="${hit.writeId}"]`)
    || document.querySelector(`[data-flow-seg] [data-node-id="${hit.itemId}"]`);
  if (!block) return;
  block.classList.remove('find-flash');
  void block.offsetWidth;
  block.classList.add('find-flash');
  setTimeout(() => block.classList.remove('find-flash'), 950);
}

function moveFindCursor(delta) {
  if (findHits.length === 0) return;
  findCursor = (findCursor + delta + findHits.length) % findHits.length;
  renderFindBar();
  void revealHit(findHits[findCursor]);
}

function openFindBar() {
  const bar = $('findBar');
  if (!bar) return;
  bar.hidden = false;
  const input = $('findInput');
  if (input) {
    findQuery = String(input.value || '');
    scanFindHits();
    input.focus();
    input.select();
  }
  renderFindBar();
}

function closeFindBar() {
  const bar = $('findBar');
  if (!bar) return;
  bar.hidden = true;
  const input = $('findInput');
  if (input) input.blur();
}

async function replaceOneHit() {
  if (isDocLocked()) {
    toast('已签章 / 已归档的文书不能替换', 'info');
    return;
  }
  await flushEdits();
  scanFindHits();
  const hit = findHits[findCursor];
  if (!hit) {
    renderFindBar();
    return;
  }
  const before = textOfCandidate(hit);
  const next = replaceOneIn(before, hit.index);
  if (next === before) return;
  const result = await writeCandidate(hit, next);
  await apply(result);
  if (!(result && result.ok)) {
    toast(`替换未生效：${(result && (result.message || result.code)) || '未知原因'}`, 'error');
  }
  scanFindHits();
  renderFindBar();
  if (findHits.length > 0) void revealHit(findHits[findCursor]);
}

async function replaceAllHits() {
  if (findQuery === '') return;
  if (isDocLocked()) {
    toast('已签章 / 已归档的文书不能替换', 'info');
    return;
  }
  await flushEdits();
  scanFindHits();
  if (findHits.length === 0) {
    renderFindBar();
    return;
  }
  const groups = new Map();
  for (const hit of findHits) {
    const key = `${hit.field ? 'f' : 't'}:${hit.writeId}`;
    const found = groups.get(key);
    if (found) found.count += 1;
    else groups.set(key, { candidate: hit, count: 1 });
  }
  let changed = 0;
  let last = null;
  const failures = [];
  for (const { candidate, count } of groups.values()) {
    const before = textOfCandidate(candidate);
    const next = replaceEveryIn(before);
    if (next === before) continue;
    const result = await writeCandidate(candidate, next);
    if (result && result.ok) {
      changed += count;
      last = result;
    } else {
      failures.push(String((result && (result.code || result.message)) || '未知原因'));
    }
  }
  if (last) await apply(last);
  scanFindHits();
  renderFindBar();
  if (failures.length > 0) {
    toast(`替换 ${changed} 处，${failures.length} 处未生效（${failures[0]}）`, 'error');
  } else if (changed > 0) {
    toast(`已替换 ${changed} 处`, 'ok');
  }
}

(() => {
  const bar = $('findBar');
  if (!bar) return;
  const input = $('findInput');
  if (input) {
    input.addEventListener('input', () => {
      findQuery = String(input.value || '');
      findCursor = 0;
      scanFindHits();
      renderFindBar();
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        moveFindCursor(event.shiftKey ? -1 : 1);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        closeFindBar();
      }
    });
  }
  const replaceInput = $('findReplace');
  if (replaceInput) {
    replaceInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); void replaceOneHit(); }
      else if (event.key === 'Escape') { event.preventDefault(); closeFindBar(); }
    });
  }
  const bind = (id, handler) => {
    const button = $(id);
    if (button) button.addEventListener('click', handler);
  };
  bind('findPrev', () => moveFindCursor(-1));
  bind('findNext', () => moveFindCursor(1));
  bind('findReplaceOne', () => { void replaceOneHit(); });
  bind('findReplaceAll', () => { void replaceAllHits(); });
  bind('findClose', () => closeFindBar());
  const caseButton = $('findCase');
  if (caseButton) {
    caseButton.addEventListener('click', () => {
      findCaseSensitive = !findCaseSensitive;
      caseButton.setAttribute('aria-pressed', findCaseSensitive ? 'true' : 'false');
      scanFindHits();
      renderFindBar();
    });
  }

  document.addEventListener('keydown', (event) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    if (String(event.key).toLowerCase() !== 'f') return;
    event.preventDefault();
    openFindBar();
  });
})();

const EVIDENCE_KIND_LABEL = {
  his: 'HIS 取数',
  lis: '检验（LIS）',
  pacs: '影像（PACS）',
  'emr-prior': '既往病历',
  guideline: '指南 / 规范',
  terminology: '术语库',
  template: '模板',
  'user-input': '人工录入',
  'external-doc': '外部文档',
  dictation: '语音转写',
  patient: '患者自述',
};

const ORIGIN_LABEL = { human: '人工书写', ai: 'AI 起草', system: '系统带入', imported: '外部导入' };

function openSource(nodeId) {
  const drawer = $('sourceDrawer');
  const body = $('sourceBody');
  if (!drawer || !body) return;
  const item = (Array.isArray(S.items) ? S.items : []).find((node) => node.id === nodeId);
  if (!item) {
    toast('这一处已经不在正文里了', 'info');
    return;
  }
  const evidence = Array.isArray(item.evidence) ? item.evidence : [];
  const runs = Array.isArray(item.runs) ? item.runs : [];
  const aiRun = runs.find((run) => run.provenance && run.provenance.origin === 'ai');
  const modelId = String((aiRun && aiRun.provenance.modelId) || item.modelId || '');
  const confidence = aiRun && typeof aiRun.provenance.confidence === 'number'
    ? aiRun.provenance.confidence
    : (typeof item.confidence === 'number' ? item.confidence : null);
  const suggestionId = String(item.suggestionId || (aiRun && aiRun.provenance.suggestionId) || '');
  const originLabel = ORIGIN_LABEL[item.origin] || String(item.origin || '');

  const head = [
    `<span class="chip">${escapeHtml(originLabel)}</span>`,
    modelId ? `<span class="muted">模型 ${escapeHtml(modelId)}</span>` : '',
    typeof confidence === 'number' ? `<span class="muted">置信度 ${confidence.toFixed(2)}</span>` : '',
    suggestionId ? `<span class="muted">建议 ${escapeHtml(suggestionId)}</span>` : '',
  ].filter((part) => part !== '').join(' ');

  const rows = evidence.map((ref) => {
    const kind = EVIDENCE_KIND_LABEL[ref.kind] || String(ref.kind || '来源');
    const meta = [
      ref.field ? `字段 ${escapeHtml(String(ref.field))}` : '',
      ref.capturedAt ? String(ref.capturedAt).replace('T', ' ').slice(0, 16) : '',
    ].filter((part) => part !== '').join(' · ');
    return `<div class="src-item">
      <div class="src-head"><b>${escapeHtml(kind)}</b>${meta === '' ? '' : `<span class="muted">${meta}</span>`}</div>
      <div class="src-ref">${escapeHtml(String(ref.ref || '（没有编号）'))}</div>
      ${ref.valueText ? `<div class="src-quote">${escapeHtml(String(ref.valueText))}</div>` : ''}
      ${ref.quote ? `<div class="src-quote">「${escapeHtml(String(ref.quote))}」</div>` : ''}
      ${ref.nodeId ? `<button data-goto-node="${escapeHtml(String(ref.nodeId))}">跳到那一处</button>` : ''}
    </div>`;
  }).join('');

  const isAiOrigin = item.origin === 'ai';
  const emptyHtml = isAiOrigin
    ? '<div class="empty">这条 AI 建议采纳时<b>没有随附依据</b>：模型没有返回来源。'
      + '<br /><br />服务端会原样保存模型给的依据，所以这里空着意味着"模型没给"，不是"界面取不到"。'
      + '真实接入的模型应当返回依据；没有依据的句子只能靠人工核对。</div>'
    : '<div class="empty">这一格是人工录入的，本来就不登记依据 —— 人工输入只记"谁在什么时候改的"，不记来源。'
      + '<br /><br />会在这里列出来源的只有：模板带入、外部文件导入、语音转写、预问诊、既往文书汇总，'
      + '它们各自写着模板编号 / 文件摘要 / 录音时间 / 单据号。</div>';
  body.innerHTML = `<div class="src-top">${head}</div>`
    + (rows === '' ? emptyHtml : `<div class="src-list">${rows}</div>`);

  if (typeof drawer.showModal === 'function') drawer.showModal();
  else drawer.setAttribute('open', '');
  document.documentElement.classList.add('drawer-open');
  const close = $('sourceClose');
  if (close) close.focus();
}

function closeSource() {
  const drawer = $('sourceDrawer');
  if (!drawer) return;
  if (typeof drawer.close === 'function') drawer.close();
  else drawer.removeAttribute('open');
  document.documentElement.classList.remove('drawer-open');
}

document.addEventListener('click', (event) => {
  const target = event.target && event.target.closest ? event.target : null;
  if (!target) return;
  const srcNode = target.closest('[data-src-node]');
  if (srcNode) {
    openSource(srcNode.dataset.srcNode);
    return;
  }
  if (target.closest('#sourceClose')) {
    closeSource();
    return;
  }
  const goto = target.closest('[data-goto-node]');
  if (goto) {
    closeSource();
    const item = (Array.isArray(S.items) ? S.items : []).find((node) => node.id === goto.dataset.gotoNode);
    if (item) scrollToItem(item);
    else toast('那一处已经不在正文里了', 'info');
  }
});

const sourceDrawerEl = $('sourceDrawer');
if (sourceDrawerEl) {
  sourceDrawerEl.addEventListener('click', (event) => {
    if (event.target === sourceDrawerEl) closeSource();
  });
  sourceDrawerEl.addEventListener('close', () => document.documentElement.classList.remove('drawer-open'));
}

function openMyContent(preferredCaret = null) {
  const drawer = $('contentDrawer');
  if (!drawer) return;
  const preferred = preferredCaret && caretAlive(preferredCaret) ? { ...preferredCaret } : null;
  const active = capturePaletteCaret();
  contentTargetCaret = preferred || active || (caretAlive(lastCaret) ? { ...lastCaret } : null);
  contentContinuous = false;
  const continuous = $('contentContinuous');
  if (continuous) continuous.checked = false;
  contentKeyword = '';
  contentPage = 1;
  const search = $('contentSearch');
  if (search) search.value = '';
  renderMyContent();
  void loadMyContent();
  if (typeof drawer.showModal === 'function') drawer.showModal();
  else drawer.setAttribute('open', '');
  document.documentElement.classList.add('drawer-open');
  const focusTarget = $('contentSearch') || $('contentClose');
  if (focusTarget) focusTarget.focus();
}

function closeMyContent() {
  const drawer = $('contentDrawer');
  if (!drawer) return;
  closeContentEditor();
  if (typeof drawer.close === 'function') drawer.close();
  else drawer.removeAttribute('open');
  document.documentElement.classList.remove('drawer-open');
  /* 关掉即退出连续；勾选框也归零，下次打开看到的和这次一致 */
  contentContinuous = false;
  const continuous = $('contentContinuous');
  if (continuous) continuous.checked = false;
}

(() => {
  const drawer = $('contentDrawer');
  if (!drawer) return;
  drawer.addEventListener('click', (event) => {
    if (event.target === drawer) closeMyContent();
  });
  drawer.addEventListener('cancel', () => {
    document.documentElement.classList.remove('drawer-open');
  });
  const close = $('contentClose');
  if (close) close.addEventListener('click', () => closeMyContent());
  /* 新建入口是标记里那个固定按钮（不随清单重画而重建，否则每次渲染都要重新挂事件） */
  const newButton = $('btnNewMyPhrase');
  if (newButton) newButton.addEventListener('click', () => openContentEditor());
  const sectionButton = $('btnSaveSection');
  if (sectionButton) sectionButton.addEventListener('click', () => { void saveSectionAsContent(contentTargetCaret); });
  const continuous = $('contentContinuous');
  if (continuous) {
    continuous.addEventListener('change', () => {
      contentContinuous = continuous.checked === true;
      renderMyContent();
    });
  }
  const search = $('contentSearch');
  if (search) {
    search.addEventListener('input', () => {
      contentKeyword = String(search.value || '');
      contentPage = 1;
      renderMyContent();
    });
    search.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || String(search.value || '') === '') return;
      event.preventDefault();
      event.stopPropagation();
      search.value = '';
      contentKeyword = '';
      contentPage = 1;
      renderMyContent();
    });
  }
  const tabs = $('contentTabs');
  if (tabs) {
    tabs.addEventListener('click', (event) => {
      const tab = event.target instanceof Element ? event.target.closest('[data-content-tab]') : null;
      if (tab) setContentTab(tab.dataset.contentTab);
    });
  }
  const cancelEditor = $('btnContentCancel');
  if (cancelEditor) cancelEditor.addEventListener('click', () => closeContentEditor());
  const editorDialog = $('contentEditor');
  if (editorDialog) {
    editorDialog.addEventListener('click', (event) => {
      if (event.target === editorDialog) closeContentEditor();
    });
    editorDialog.addEventListener('close', () => {
      document.documentElement.classList.remove('dialog-open');
      const opener = contentEditorOpener;
      contentEditorOpener = null;
      if (opener && opener.isConnected && typeof opener.focus === 'function') opener.focus();
    });
  }
  const editorForm = $('contentEditorForm');
  if (editorForm) {
    editorForm.addEventListener('submit', (event) => {
      event.preventDefault();
      void submitContentEditor();
    });
  }
  const editorName = $('contentName');
  if (editorName) editorName.addEventListener('input', () => { updateContentHint(); scheduleContentSimilar(); });
  const editorText = $('contentText');
  if (editorText) editorText.addEventListener('input', () => { updateContentHint(); scheduleContentSimilar(); });
  const entryButton = $('btnMyContent');
  if (entryButton) entryButton.addEventListener('click', () => openMyContent());
  const body = $('contentBody');
  if (!body) return;
  body.addEventListener('click', async (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const page = target.closest('[data-content-page]');
    if (page) {
      const next = Number(page.dataset.contentPage);
      if (Number.isFinite(next) && next !== contentPage) {
        contentPage = next;
        renderMyContent();
      }
      return;
    }
    const insert = target.closest('[data-content-insert]');
    if (insert) {
      const item = MY_CONTENT.find((candidate) => candidate.id === insert.dataset.contentInsert);
      if (!item) return;
      if (!contentTargetCaret || !caretAlive(contentTargetCaret)) {
        toast('先点进正文某一段，再打开个人模板 —— 没有落点就不猜位置', 'info');
        return;
      }
      const caret = { ...contentTargetCaret };
      const keepOpen = contentContinuous;
      if (!keepOpen) closeMyContent();
      const outcome = await insertMyContent(item, caret, { keepFocus: keepOpen });
      if (keepOpen && outcome && outcome.ok && outcome.caret) {
        contentTargetCaret = outcome.caret;
        renderMyContent();
      }
      return;
    }
    const pin = target.closest('[data-content-pin]');
    if (pin) {
      const item = MY_CONTENT.find((candidate) => candidate.id === pin.dataset.contentPin);
      if (!item) return;
      const result = await api('/api/content-pin', { itemId: item.id, pinned: !item.pinned });
      await apply(result);
      if (result && result.ok === true) {
        toast(item.pinned ? '已取消置顶' : '已置顶：以后它排在清单最前面', 'ok');
        await loadMyContent();
      }
      return;
    }
    const remove = target.closest('[data-content-delete]');
    if (remove) {
      const item = MY_CONTENT.find((candidate) => candidate.id === remove.dataset.contentDelete);
      if (!item) return;
      const sure = await askConfirm(`删掉「${item.name}」？\n\n只从个人模板里删掉这一条，已经插进病历的字不受影响。`, {
        okLabel: '删掉',
        tone: 'danger',
      });
      if (!sure) return;
      const result = await api('/api/content-delete', { itemId: item.id });
      await apply(result);
      if (result && result.ok === true) await loadMyContent();
    }
  });
})();

let paletteCaret = null;

function anchorOfNode(item) {
  if (!item || !item.id) return null;
  const body = $('docBody');
  if (!body) return null;
  const quote = (value) => (window.CSS && typeof window.CSS.escape === 'function'
    ? window.CSS.escape(String(value))
    : String(value).replace(/["\\]/g, '\\$&'));
  const pick = (attr, value) => body.querySelector(`[${attr}="${quote(value)}"]`);
  return pick('data-edit', item.id)
    || pick('data-field', item.id)
    || pick('data-node-id', item.id)
    || pick('data-sec-id', item.id)
    || (item.paragraphId ? pick('data-para-id', item.paragraphId) : null)
    || (item.paragraphId ? pick('data-para-image', item.paragraphId) : null);
}

function scrollToItem(item) {
  const el = anchorOfNode(item);
  if (!el) {
    toast('这一处当前不在正文里（可能已被删除）', 'info');
    return;
  }
  if (el.scrollIntoView) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  const box = (el.closest && (el.closest('.node, .fp, .fcard, .fsec') || el)) || el;
  box.classList.add('node-hit');
  setTimeout(() => box.classList.remove('node-hit'), 1600);
  if (el.matches && el.matches('textarea[data-edit]')) {
    el.focus();
    const end = el.value.length;
    try { el.setSelectionRange(end, end); } catch { }
  } else if (el.matches && el.matches('input[data-field]')) {
    el.focus();
    if (typeof el.select === 'function') el.select();
  }
}

function capturePaletteCaret() {
  rememberCaret();
  if (!caretAlive(lastCaret)) return null;
  return { ...lastCaret };
}

async function insertIntoCurrentParagraph(text) {
  const caret = paletteCaret;
  if (!caret) {
    toast('先把光标点进正文某一段，再按 Ctrl+K —— 没有落点就不猜位置', 'info');
    return;
  }
  /* 先落盘：插入要在"服务端那一版正文"上算位置，否则会把防抖里还没发出去的字盖掉 */
  clearTimeout(blurTimer);
  await flushEdits();
  const item = (Array.isArray(S.items) ? S.items : []).find((node) => node.id === caret.nodeId && node.kind === 'text');
  if (!item) {
    toast('光标所在的那一段已经不在正文里了，请重新点一下', 'info');
    return;
  }
  const current = String(item.text || '');
  const start = caret.start === null ? current.length : Math.max(0, Math.min(caret.start, current.length));
  const end = caret.end === null ? start : Math.max(start, Math.min(caret.end, current.length));
  const before = current.slice(0, start);
  /* 不粘字：前一个字既不是标点也不是空白时补一个分隔号，否则会写出"体温36.5" */
  const lead = before !== '' && !/[；;，,。、\s]$/.test(before) ? '；' : '';
  const payload = `${lead}${text}`;
  await apply(await api('/api/edit', { nodeId: caret.nodeId, text: `${before}${payload}${current.slice(end)}` }));
  /* 落笔会整片重画：把光标放回插入点之后，否则每插一次都得用鼠标找回去 */
  const target = document.querySelector(`[data-edit="${caret.nodeId}"]`);
  if (target) {
    target.focus();
    const position = start + payload.length;
    try { target.setSelectionRange(position, position); } catch { }
  }
}

function paletteParagraphTarget() {
  const caret = paletteCaret;
  if (!caret || !caret.nodeId) return null;
  const items = Array.isArray(S.items) ? S.items : [];
  const item = items.find((node) => node.id === caret.nodeId);
  if (!item) return null;
  return { item, nodeId: item.id, paragraphId: item.paragraphId || null };
}

function pushMyContentCommands(commands) {
  for (const item of MY_CONTENT) {
    const isPhrase = item.kind === 'phrase';
    const scopeLabel = MY_CONTENT_SCOPE[item.scope] || item.scope;
    const placeholderHint = Array.isArray(item.placeholders) && item.placeholders.length > 0 ? ' · 按病人上下文填' : '';
    commands.push({
      group: isPhrase ? '个人模板 · 常用语' : '个人模板 · 内容段落',
      label: `${isPhrase ? '插入常用语' : '带入内容段落'}：${item.name}`,
      detail: `${item.pinned ? '置顶 · ' : ''}${scopeLabel}${item.group ? ` · ${item.group}` : ''}${item.trigger ? ` · ;${item.trigger} 空格展开` : ''}${placeholderHint}${item.preview ? ` · ${item.preview}` : ''}`,
      keywords: `content 内容 常用语 内容段落 模板 ${item.name} ${item.trigger ? `;${item.trigger}` : ''} ${item.group || ''} ${item.anchorHint || ''} ${(Array.isArray(item.paragraphs) ? item.paragraphs.join(' ') : '').slice(0, 400)}`,
      run: async () => { await insertMyContent(item, paletteCaret); },
    });
  }
  if (MY_CONTENT.length === 0) {
    commands.push({
      group: '个人模板',
      label: '个人模板还是空的：把当前段存进来…',
      detail: '存一次，以后一键插回',
      keywords: 'content 内容 常用语 存为 模板',
      run: async () => { await saveParagraphAsContent('content-paragraph', paletteCaret); },
    });
  }
  commands.push({
    group: '个人模板',
    label: '管理个人模板…',
    detail: MY_CONTENT.length > 0 ? `已有 ${MY_CONTENT.length} 条` : '还没有内容',
    keywords: 'content 内容 管理 删除 常用语 内容段落',
    run: () => openMyContent(),
  });
  commands.push({
    group: '个人模板',
    label: '把当前段存为常用语…',
    detail: '存进个人模板，写病历时一键插回这一句',
    keywords: 'content 保存 常用语 存为',
    run: async () => { await saveParagraphAsContent('phrase', paletteCaret); },
  });
  commands.push({
    group: '个人模板',
    label: '把当前段存为内容段落…',
    detail: '存进个人模板，下次整段带入',
    keywords: 'content 保存 内容段落 存为 模板',
    run: async () => { await saveParagraphAsContent('content-paragraph', paletteCaret); },
  });
  const sectionTitle = paletteCaret ? sectionTitleOf(paletteCaret.nodeId) : '';
  commands.push({
    group: '个人模板',
    label: '把当前章存为内容段落…',
    detail: sectionTitle !== '' ? `整章「${sectionTitle}」一次存好` : '整章一次存好（光标要落在正文里）',
    keywords: 'content 保存 整章 章节 另存 内容段落 模板',
    run: async () => { await saveSectionAsContent(paletteCaret); },
  });
}

function paletteCommands() {
  const commands = [];
  const items = Array.isArray(S && S.items) ? S.items : [];
  const templates = Array.isArray(S && S.templates) ? S.templates : [];
  const tree = Array.isArray(S && S.tree) ? S.tree : [];
  const modeLabel = { card: '卡片', flow: '流式' };
  const nextMode = isFlow() ? 'card' : 'flow';

  commands.push({
    group: '命令',
    label: '保存未落盘的编辑',
    detail: '平时失焦会自动保存',
    keywords: 'save 保存 落盘',
    run: async () => { clearTimeout(blurTimer); await flushEdits(); toast('已保存', 'ok'); },
  });
  commands.push({
    group: '命令',
    label: `切换到${modeLabel[nextMode]}模式`,
    detail: `当前是${modeLabel[editMode]}模式`,
    keywords: 'editmode 编辑方式 卡片 流式',
    run: () => setEditMode(nextMode),
  });
  commands.push({
    group: '命令',
    label: '撤销最近一次写入',
    detail: '与顶栏「撤销」同一条路径',
    keywords: 'undo 撤销 回退',
    run: () => {
      const button = $('btnUndo');
      if (button && !button.disabled) button.click();
      else toast('现在没有可撤销的操作', 'info');
    },
  });
  commands.push({
    group: '命令',
    label: '键盘快捷键一览',
    detail: '与按 ? 同一个浮层',
    keywords: 'help 帮助 快捷键',
    run: () => toggleKeysHelp(),
  });
  commands.push({
    group: '命令',
    label: `切换到${theme === 'dark' ? '浅色' : '深色'}主题`,
    detail: '视图偏好：不改数据、不进留痕',
    keywords: 'theme 主题 深色 浅色 夜间',
    run: () => { const button = $('btnTheme'); if (button) button.click(); },
  });
  /* 字号的两个方向各一条：命令面板是键盘用户的路，只给"放大"等于让缩小只能靠鼠标 */
  commands.push({
    group: '命令',
    label: '放大正文字号',
    detail: `当前 ${docFont}px（只作用于病历正文；视图偏好，不进留痕）`,
    keywords: 'font 字号 字体 放大 正文',
    run: () => stepDocFont(1),
  });
  commands.push({
    group: '命令',
    label: '缩小正文字号',
    detail: `当前 ${docFont}px（最小 14px：比它小的正文不该存在）`,
    keywords: 'font 字号 字体 缩小 正文',
    run: () => stepDocFont(-1),
  });
  commands.push({
    group: '命令',
    label: '打开「定稿与导出」',
    detail: '提交审核 / 签章 / 导出 OFD 都在那一栏',
    keywords: 'export 导出 定稿 签章 提交 审核',
    run: () => { setMoreMenu(false); switchTab('export'); },
  });
  commands.push({
    group: '命令',
    label: '打开历史版本',
    detail: '最近 15 次写入，可回到任意一版',
    keywords: 'history 历史 版本 回滚 撤销',
    run: () => { const button = $('btnUndo'); if (button && !button.disabled) button.click(); },
  });
  commands.push({
    group: '命令',
    label: paperMode ? '退出纸张视图' : '纸张视图（A4 预览）',
    detail: '纸面尺寸与页边距取自导出端的排版参数',
    keywords: 'paper 纸张 A4 预览 分页 版式',
    run: () => togglePaper(),
  });
  commands.push({
    group: '命令',
    label: '分页预览',
    detail: '按排版结果分页显示纸面；打印走这一份，页数与换行与归档件同源',
    keywords: 'preview 预览 分页 纸 打印 pagination',
    run: () => openPreview(),
  });
  commands.push({
    group: '命令',
    label: '打印当前视图',
    detail: '按当前视图打印（无页眉页脚与页码）；正式打印请用「分页预览」',
    keywords: 'print 打印 输出 纸质 纸',
    run: () => printDoc(),
  });

  const paraTarget = paletteParagraphTarget();
  const readOnlyDoc = !!(S.doc && (S.doc.status === 'signed' || S.doc.status === 'archived'));
  if (paraTarget && !readOnlyDoc) {
    const preview = String(paraTarget.item.text || paraTarget.item.label || '').replace(/\s+/g, '').slice(0, 12);
    const where = preview === '' ? '（空段）' : `「${preview}」`;
    commands.push({
      group: '当前段',
      label: '在本段之后插入新段落',
      detail: `${where} 之后新起一段，光标跟过去`,
      keywords: 'insert paragraph 插入 新段 段落 加一段',
      run: async () => {
        clearTimeout(blurTimer);
        await flushEdits();
        const result = await api('/api/insert-paragraph', { nodeId: paraTarget.nodeId });
        await apply(result);
        if (result.ok && result.data && result.data.textNodeId) focusEdit(result.data.textNodeId);
      },
    });
    commands.push({
      group: '当前段',
      label: '本段上移',
      detail: `${where} 与上一段交换位置`,
      keywords: 'move up 上移 段落 排序',
      run: async () => {
        clearTimeout(blurTimer);
        await flushEdits();
        await apply(await api('/api/move-node', { nodeId: paraTarget.nodeId, direction: 'up' }));
      },
    });
    commands.push({
      group: '当前段',
      label: '本段下移',
      detail: `${where} 与下一段交换位置`,
      keywords: 'move down 下移 段落 排序',
      run: async () => {
        clearTimeout(blurTimer);
        await flushEdits();
        await apply(await api('/api/move-node', { nodeId: paraTarget.nodeId, direction: 'down' }));
      },
    });
    if (paraTarget.item.humanConfirmed !== true) {
      commands.push({
        group: '当前段',
        label: '确认本段内容',
        detail: `${where} 与段尾「确认内容」同一条写路径`,
        keywords: 'confirm 确认 内容 待确认',
        run: async () => {
          clearTimeout(blurTimer);
          await flushEdits();
          await apply(await api('/api/confirm', { nodeId: paraTarget.nodeId }));
        },
      });
    }
    if (paraTarget.paragraphId) {
      commands.push({
        group: '当前段',
        label: '在本段后面贴一张图',
        detail: 'PNG / JPEG / WebP，上限 8 MB',
        keywords: 'image 图片 贴图 图',
        run: async () => {
          const picked = await uploadPickedImage();
          if (!picked) return;
          const inserted = await api('/api/insert-image', {
            paragraphId: paraTarget.paragraphId,
            resRef: picked.resource.resRef,
            altText: picked.name,
          });
          await apply(inserted);
          if (inserted.ok) {
            docNotice = `已贴图：${picked.resource.width}×${picked.resource.height}，${Math.round((picked.resource.bytes || 0) / 1024)} KB。导出归档件时图会打进 Res/MultiMedia。`;
            renderDoc();
          }
        },
      });
    }
    if (paraTarget.item.kind === 'text' && !paraTarget.item.keyContent) {
      commands.push({
        group: '当前段',
        label: '删除本段（含其中的字段）',
        detail: '写入留痕，但内容不可恢复（没有撤销）',
        keywords: 'delete 删除 删段',
        run: async () => {
          if (!(await askConfirm(
            '删除本段（含其中的字段）？\n\n此操作会写入留痕，但内容不可恢复（当前没有撤销）。',
            { okLabel: '删除本段', tone: 'danger' },
          ))) return;
          clearTimeout(blurTimer);
          await flushEdits();
          await apply(await api('/api/delete-node', { nodeId: paraTarget.nodeId }));
        },
      });
    }
  }

  pushMyContentCommands(commands);

  TABS.forEach((key, index) => {
    const tab = document.querySelector(`#tabbar [data-tab="${key}"]`);
    if (!tab) return;
    const title = tab.querySelector('.tl');
    const label = title ? String(title.textContent || key).trim() : key;
    commands.push({
      group: '面板',
      label: `打开面板：${label}`,
      detail: index < 4 ? `Alt+${index + 1}` : '',
      keywords: `tab panel 面板 ${key}`,
      run: () => { setMoreMenu(false); switchTab(key); },
    });
  });

  /* ④ 套模板：只列本次就诊开得出的，理由与「新建」弹框一致（列一份开不出的等于让人点进去再被拒一次） */
  const visitType = (S && S.encounter && S.encounter.visitType) || '';
  for (const tpl of templates) {
    if (!templateFitsVisit(tpl, visitType)) continue;
    const docType = (tpl.docType && tpl.docType.display) || '';
    commands.push({
      group: '套模板',
      label: `新建文书：${tpl.name}`,
      detail: [docType, tpl.sectionCount ? `${tpl.sectionCount} 章` : ''].filter((part) => part !== '').join(' · '),
      keywords: `template 模板 新建 ${tpl.name}`,
      run: async () => { await apply(await api('/api/template-create', { templateId: tpl.templateId })); },
    });
  }

  for (const patient of tree) {
    for (const visit of (Array.isArray(patient.visits) ? patient.visits : [])) {
      for (const doc of (Array.isArray(visit.docs) ? visit.docs : [])) {
        if (doc.active) continue;
        commands.push({
          group: '文书',
          label: `切换文书：${doc.title || doc.docId}`,
          detail: [patient.nameMasked, visit.date].filter((part) => part).join(' · '),
          keywords: `doc 文书 ${doc.docId}`,
          run: () => switchDoc(doc.docId),
        });
      }
    }
  }

  const terms = new Map();
  let section = '';
  items.forEach((item, index) => {
    if (!item || !item.id) return;
    if (item.kind === 'section') {
      section = String(item.title || '（未命名章节）');
      const next = items.slice(index + 1).find((candidate) => candidate && candidate.kind !== 'section');
      commands.push({
        group: '章节',
        label: section,
        detail: '跳到本章第一段',
        keywords: `section 章节 ${section}`,
        run: () => (next ? scrollToItem(next) : toast('这一章下面还没有内容', 'info')),
      });
      return;
    }
    if (item.kind === 'text') {
      const compact = String(item.text || '').replace(/\s+/g, ' ').trim();
      commands.push({
        group: '段落',
        label: compact === '' ? '（空段落）' : (compact.length > 46 ? `${compact.slice(0, 46)}…` : compact),
        detail: section || '正文',
        keywords: compact,
        run: () => scrollToItem(item),
      });
    } else if (item.kind === 'field') {
      const name = String(item.label || '填写项');
      const value = item.value === null || item.value === undefined ? '' : String(item.value);
      const unit = String(item.unit || '');
      const shown = value === '' ? '（未填）' : `${value}${unit ? ` ${unit}` : ''}`;
      commands.push({
        group: '填写项',
        label: `${name}：${shown}`,
        detail: section || '正文',
        keywords: `${name} ${value} ${unit} 数据元`,
        run: () => scrollToItem(item),
      });
      if (value !== '') {
        commands.push({
          group: '插入检验值',
          label: `插入：${name} ${shown}`,
          detail: `${section || '正文'} · 写在光标处`,
          keywords: `insert 插入 检验 ${name} ${value}`,
          run: () => insertIntoCurrentParagraph(`${name} ${shown}`),
        });
      }
    } else if (item.kind === 'control' || item.kind === 'table' || item.kind === 'image') {
      const label = item.kind === 'control'
        ? `控件：${item.label || item.controlKind || '专科控件'}`
        : item.kind === 'table'
          ? `表格：${(item.columns || []).join(' / ') || '（无表头）'}`
          : `图片：${item.altText || item.caption || '未命名'}`;
      commands.push({
        group: '跳转',
        label,
        detail: section || '正文',
        keywords: `${item.kind} ${label}`,
        run: () => scrollToItem(item),
      });
    }
    const tags = Array.isArray(item.tags) ? item.tags : [];
    for (const tag of tags) {
      if (!tag || !tag.code) continue;
      const key = `${tag.system}|${tag.code}`;
      const seen = terms.get(key);
      if (seen) { seen.count += 1; continue; }
      terms.set(key, { tag, count: 1, item });
    }
  });
  for (const entry of terms.values()) {
    const display = entry.tag.display || entry.tag.code;
    commands.push({
      group: '术语',
      label: `术语：${display}`,
      detail: `${entry.tag.system}:${entry.tag.code} · 正文里 ${entry.count} 处`,
      keywords: `${entry.tag.code} ${display} 术语 数据元`,
      run: () => scrollToItem(entry.item),
    });
  }

  return commands;
}

function openPalette() {
  if (!window.L0Palette) return;
  paletteCaret = capturePaletteCaret();
  window.L0Palette.open({
    commands: paletteCommands(),
    placeholder: '跳转段落 / 插入检验值 / 套模板 / 个人模板 / 查术语',
  });
}

document.addEventListener('click', (event) => {
  if (!event.target.closest || !event.target.closest('#btnPalette')) return;
  openPalette();
});

document.addEventListener('change', async (event) => {
  const el = event.target;
  if (!el || el.id !== 'comparePick') return;
  await apply(await api('/api/visit-compare', { previousDocId: el.value }));
});

let focusIndex = -1;
let pendingRejectId = null;
let pendingRejectTimer = null;

function isTyping() {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT' || el.isContentEditable === true;
}

function showKeyHint(text) {
  const hint = $('keyHint');
  hint.textContent = text;
  hint.hidden = false;
}

function hideKeyHint() { $('keyHint').hidden = true; }

function toggleKeysHelp() {
  const help = $('keysHelp');
  help.hidden = !help.hidden;
}

function actionableSuggestions() {
  return (S && Array.isArray(S.suggestions) ? S.suggestions : []).filter((item) => item.status === 'pending');
}

function syncFocus() {
  const cards = [...document.querySelectorAll('#suggestions .sugg:not(.done)')];
  cards.forEach((card, index) => card.classList.toggle('focused', index === focusIndex));
  const current = cards[focusIndex];
  if (current && current.scrollIntoView) current.scrollIntoView({ block: 'nearest' });
}

function focusSuggestion(delta) {
  const count = actionableSuggestions().length;
  if (count === 0) return;
  focusIndex = (focusIndex + delta + count) % count;
  /* 当前不在「AI 助手」就先切过去，否则"移动了却看不见" */
  if (activeTab !== 'ai') switchTab('ai');
  syncFocus();
}

async function acceptFocused() {
  const target = actionableSuggestions()[focusIndex];
  if (!target) return;
  await apply(await api('/api/accept', { suggestionId: target.id }));
  const count = actionableSuggestions().length;
  focusIndex = count === 0 ? -1 : Math.min(focusIndex, count - 1);
  syncFocus();
}

async function rejectFocused() {
  const target = actionableSuggestions()[focusIndex];
  if (!target) return;
  /* 拒绝不可逆（建议一旦 rejected 就回不到 pending），单键直拒太危险，必须按两次 */
  if (pendingRejectId !== target.id) {
    pendingRejectId = target.id;
    showKeyHint('再按一次 r 确认拒绝（拒绝不可逆）');
    clearTimeout(pendingRejectTimer);
    pendingRejectTimer = setTimeout(() => {
      pendingRejectId = null;
      hideKeyHint();
    }, 2500);
    return;
  }
  pendingRejectId = null;
  clearTimeout(pendingRejectTimer);
  hideKeyHint();
  await apply(await api('/api/reject', { suggestionId: target.id, reason: '键盘快速拒绝' }));
  const count = actionableSuggestions().length;
  focusIndex = count === 0 ? -1 : Math.min(focusIndex, count - 1);
  syncFocus();
}

document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && (event.key === 'k' || event.key === 'K')) {
    event.preventDefault();
    openPalette();
    return;
  }
  if (isFlow() && (event.ctrlKey || event.metaKey) && !event.altKey) {
    const markKey = event.key;
    if (event.shiftKey && (markKey === 'H' || markKey === 'h')) {
      event.preventDefault();
      applyFlowMark('highlight');
      return;
    }
    if (event.shiftKey && (markKey === '+' || markKey === '=')) {
      event.preventDefault();
      applyFlowMark('sup');
      return;
    }
    if (!event.shiftKey && markKey === '=') {
      event.preventDefault();
      applyFlowMark('sub');
      return;
    }
  }
  /* ① 安全底线：输入态一律不拦单键。
     Esc 是唯一例外，且它只做"失焦"，不触发任何写操作。 */
  if (isTyping()) {
    if (event.key === 'Escape' && document.activeElement && document.activeElement.blur) document.activeElement.blur();
    return;
  }
  if (event.ctrlKey || event.metaKey) return;
  if (event.altKey) {
    if (/^[1-4]$/.test(event.key)) {
      const key = TABS[Number(event.key) - 1];
      if (key) {
        setMoreMenu(false);
        switchTab(key);
        event.preventDefault();
      }
    }
    return;
  }
  if (event.key === 'j' || event.key === 'J') { event.preventDefault(); focusSuggestion(1); return; }
  if (event.key === 'k' || event.key === 'K') { event.preventDefault(); focusSuggestion(-1); return; }
  if (event.key === 'a' || event.key === 'A') { event.preventDefault(); void acceptFocused(); return; }
  if (event.key === 'r' || event.key === 'R') { event.preventDefault(); void rejectFocused(); return; }
  if (event.key === '?') { event.preventDefault(); toggleKeysHelp(); return; }
  if (event.key === 'Escape') {
    setMoreMenu(false);
    hideKeyHint();
    $('keysHelp').hidden = true;
    focusIndex = -1;
    syncFocus();
  }
});

document.addEventListener('click', async (event) => {
  if (event.target.closest('#btnMoreTabs')) {
    setMoreMenu($('moreMenu').hidden);
    return;
  }
  const tab = event.target.closest('.tab');
  if (tab) {
    if (event.target.closest('#moreMenu')) setMoreMenu(false);
    if (tab.dataset.tab === activeTab) toggleActivePanelCollapse();
    else switchTab(tab.dataset.tab);
    return;
  }
  if (!$('moreMenu').hidden) setMoreMenu(false);

  const phToggle = event.target.closest('[data-ph-toggle]');
  if (phToggle) {
    togglePanelCollapsed(phToggle);
    return;
  }

  const toggle = event.target.closest('[data-toggle]');
  if (toggle) {
    const key = toggle.dataset.toggle;
    if (collapsedTree.has(key)) collapsedTree.delete(key); else collapsedTree.add(key);
    saveSet(TREE_KEY, collapsedTree);
    renderTree();
    return;
  }

  const captureClear = event.target.closest('[data-capture-clear]');
  if (captureClear) {
    const ok = await askConfirm(
      '清空本份病历的采集记录？\n\n只删"什么时候、录了几段、成败几段"这些元数据，不可恢复。\n音频本来就不留存，管理审计里的采集记录不受影响。',
      { okLabel: '清空记录', tone: 'danger' },
    );
    if (!ok) return;
    const result = await api('/api/dictation/capture/records/clear', { docId: (S && S.activeDocId) || '' });
    if (!result || result.ok !== true) {
      toast(`${(result && result.code) || ''} ${(result && result.message) || '清空失败'}`.trim(), 'danger');
      return;
    }
    const removed = result.data && Number.isFinite(Number(result.data.removed)) ? Number(result.data.removed) : 0;
    captureHistoryLoaded = false;
    await renderCaptureHistory(true);
    toast(`已清空 ${removed} 条采集记录`, 'ok');
    return;
  }

  const docDel = event.target.closest('[data-doc-delete]');
  if (docDel) {
    const docId = docDel.dataset.docDelete;
    const doc = (S.tree || [])
      .flatMap((patient) => patient.visits)
      .flatMap((visit) => visit.docs)
      .find((item) => item.docId === docId);
    const ok = await askConfirm(
      `删除草稿「${(doc && doc.title) || docId}」？\n\n正文、留痕与旁挂数据一并删除，不可恢复。\n已签章 / 已归档的病历不能删。`,
      { okLabel: '删除草稿', tone: 'danger' },
    );
    if (!ok) return;
    /* 删的正是当前打开的这份：先取消挂起的"失焦即保存"，
       否则删除完成后那一次保存会打到一份已经不存在的文档上 */
    if (docId === S.activeDocId) clearTimeout(blurTimer);
    await apply(await api('/api/delete-document', { docId }));
    return;
  }

  const docRow = event.target.closest('[data-doc]');
  if (docRow) {
    await switchDoc(docRow.dataset.doc);
    return;
  }

  const el = event.target.closest('button');
  if (!el) return;
  clearTimeout(blurTimer);
  await flushEdits();
  if (el.id === 'btnTplCreate') {
    const templateId = await pickTemplate();
    if (!templateId) return;
    await apply(await api('/api/template-create', { templateId }));
    return;
  }
  el.disabled = true;
  el.setAttribute('aria-busy', 'true');
  try {
    if (el.id !== 'btnSuggest' && el.id !== 'btnSuggestBatch') suggestionNotice = '';
    if (el.id !== 'btnUndo') docNotice = '';
    if (el.id === 'btnReloadSidecars') {
      const ok = await askConfirm(
        '重新载入旁挂数据：接受磁盘上那一版建议与注解，放弃本终端尚未落盘的改动。\n\n正文、留痕与签名不受影响。',
        { okLabel: '重新载入', tone: 'danger' },
      );
      if (!ok) return;
      await apply(await api('/api/reload-sidecars', {}));
      return;
    }
    if (el.id === 'btnRecompute') {
      const r = await api('/api/template-recompute', {});
      if (r.ok && r.data) {
        const applied = (r.data.applied || []).length;
        const pending = r.data.pending || [];
        const unresolved = (r.data.unresolved || []).length;
        const skipped = r.data.skipped || [];
        const parts = [];
        if (applied > 0) parts.push(`已重算 ${applied} 个派生值`);
        if (pending.length > 0) {
          parts.push(`另有 ${pending.length} 个还缺输入（${pending.map((item) => `${item.controlName}：缺 ${item.missing.join('、') || '有效取值'}`).join('；')}）`);
        }
        if (skipped.length > 0) parts.push(`${skipped.length} 个你手改过，按纪律不覆盖（系统不覆盖人工内容）`);
        if (unresolved > 0) parts.push(`${unresolved} 个派生值的控件在当前模板包中找不到，已保持原值不动`);
        docNotice = parts.length === 0 ? '没有需要重算的派生值。' : `${parts.join('；')}。`;
      }
      await apply(r);
      return;
    }
    if (el.id === 'btnSaveAll') { await flushEdits(); await refresh(); return; }
    if (el.id === 'btnImport') { $('fileInput').click(); return; }
    if (el.id === 'btnKeys') { toggleKeysHelp(); return; }
    if (el.id === 'btnTheme') {
      theme = theme === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem(THEME_KEY, theme); } catch { }
      applyTheme();
      return;
    }
    if (el.id === 'btnPaper') { togglePaper(); return; }
    if (el.id === 'btnExportWst500') { await apply(await api('/api/export-wst500', {})); return; }
    if (el.id === 'btnExportJson') { await apply(await api('/api/export-json', {})); return; }
    if (el.id === 'btnAudit') { await apply(await api('/api/audit-report', {})); return; }
    if (el.id === 'btnImportKey') {
      await apply(await api('/api/recipient-keys/import', {
        label: $('rkLabel').value || '接收方',
        text: $('rkText').value || '',
      }));
      return;
    }
    if (el.dataset.rkRemove) { await apply(await api('/api/recipient-keys/remove', { keyId: el.dataset.rkRemove })); return; }
    if (el.dataset.rkExport) {
      const key = (S.recipientKeys?.keys || []).find((item) => item.keyId === el.dataset.rkExport);
      if (key) $('rkText').value = pemFromBase64(key.spkiBase64);
      return;
    }
    if (el.dataset.grantOpen) {
      await apply(await api('/api/reading/open', {
        grantId: el.dataset.grantOpen,
        environmentId: $('rgReadEnv').value || 'WS-01',
        recipientSeed: $('rgReadSeed').value || 'dept-a-2026',
      }));
      return;
    }
    if (el.dataset.grantRevoke) { await apply(await api('/api/reading/revoke', { grantId: el.dataset.grantRevoke })); return; }
    if (el.id === 'btnSuggest') {
      await runSuggestFor($('suggTarget').value, $('suggMode').value);
      return;
    }
    if (el.id === 'btnSuggestBatch') {
      const r = await api('/api/suggest-batch', { mode: $('suggMode').value });
      const data = (r.ok && r.data) || {};
      const reusedIds = Array.isArray(data.reused) ? data.reused : [];
      const added = Array.isArray(data.suggestionIds) ? data.suggestionIds.length : 0;
      if (reusedIds.length === 0) {
        suggestionNotice = '';
      } else {
        showProcessedSuggestions = false;
        suggestionNotice = added === 0
          ? `本次产出的 ${reusedIds.length} 条都已有同样内容的待处理建议（${reusedIds.join('、')}），未重复生成。`
          : `新增 ${added} 条；另有 ${reusedIds.length} 条已有同样内容的待处理建议（${reusedIds.join('、')}），未重复生成。`;
      }
      await apply(r);
      return;
    }
    if (el.id === 'btnToggleProcessed') {
      showProcessedSuggestions = !showProcessedSuggestions;
      renderSuggestions();
      return;
    }
    if (el.id === 'btnAdmin') { window.open('/admin', '_blank', 'noopener'); return; }
    if (el.id === 'cfgTest') {
      setCfgStatus('测试中…（只发一段与病历无关的测试文本）');
      const r = await api('/api/model-config/test');
      setCfgStatus(r.ok
        ? `连接正常：${r.data.modelId}，耗时 ${r.data.latencyMs}ms`
        : `连接失败：${(r && (r.message || r.code)) || '未知原因'}`);
      return;
    }
    if (el.id === 'btnQcContent') {
      const r = await api('/api/qc-content-check', {});
      await apply(r);
      const hint = $('qcContentHint');
      const data = (r && r.data) || {};
      if (hint) {
        hint.textContent = data.configured
          ? `引擎「${data.engine.name}」：判了 ${(data.judged || []).length} 条规则，命中 ${(data.findings || []).length} 条`
          : `未接入/不可用：${data.availability || '（未说明）'}`;
      }
      return;
    }
    if (el.id === 'btnQcContract') {
      const r = await api('/api/qc-content-contract');
      const data = (r && r.data) || {};
      const local = data.local || {};
      const hint = $('qcContentHint');
      if (hint) {
        hint.textContent = `契约 ${data.api} · 本机引擎「${local.engine || '—'}」· 规则清单 ${local.rules ?? 0} 条`;
      }
      console.info('内涵类质控契约（完整）', data);
      return;
    }
    if (el.id === 'btnQcForm') {
      const r = await api('/api/qc-form-check', {});
      if (r.ok && r.data) {
        const d = r.data;
        setCfgStatus(`形式质控：扫描 ${d.scannedNodes} 个节点 / ${d.rules} 条规则，命中 ${d.hits} 条（新增 ${d.created}，已在册 ${d.already}）`);
      }
      await apply(r);
      return;
    }
    if (el.id === 'btnAnnotate') { await apply(await api('/api/annotate', { nodeId: $('qcTarget').value })); return; }
    if (el.id === 'btnDictate') { await apply(await api('/api/dictate', {})); return; }
  if (el.id === 'btnCaptureStart') { await startCapture(); return; }
  if (el.id === 'btnCaptureStop') { await stopCapture(); return; }
  if (el.dataset.clientReprobe) {
    if (reprobeBusy) return;
    reprobeBusy = true;
    renderCaptureLocal();
    try {
      await Promise.all([
        probeCaptureClient(),
        new Promise((resolve) => setTimeout(resolve, 600)),
      ]);
    } finally {
      reprobeBusy = false;
      renderCaptureLocal();
    }
    return;
  }
    /* 落点确认后提交：先把"每段都选了"在界面拦一次（服务端还会再校验），
       否则用户点了没反应，只能靠猜 */
    if (event.target.closest('[data-dictate-commit]')) {
      const targets = [...document.querySelectorAll('[data-place-index]')]
        .map((select) => ({ index: Number(select.dataset.placeIndex), nodeId: select.value }));
      const missing = targets.filter((item) => item.nodeId === '');
      if (missing.length > 0) {
        await askAlert(`还有 ${missing.length} 段没选落点（第 ${missing.map((item) => item.index).join('、')} 段）：每段都要指定才能生成建议`);
        return;
      }
      await apply(await api('/api/dictate-commit', {
        transcriptionId: S.dictation && S.dictation.transcriptionId,
        targets,
      }));
      return;
    }
    if (el.id === 'btnCheckConsistency') { await apply(await api('/api/check-consistency', {})); return; }
    if (el.id === 'btnVisitTimeline') { await apply(await api('/api/visit-timeline', {})); return; }
    if (el.dataset.openDoc) { await switchDoc(el.dataset.openDoc); return; }
    if (el.id === 'btnCompare') { await apply(await api('/api/visit-compare', {})); return; }
    if (el.id === 'btnPrevisitRead') { await apply(await api('/api/previsit/read', {})); return; }
    if (el.id === 'btnPrevisitTake') {
      const keys = [...document.querySelectorAll('[data-previsit-key]:checked')].map((input) => input.dataset.previsitKey);
      if (keys.length === 0) { toast('先勾选要生成建议的条目', 'info'); return; }
      const result = await api('/api/previsit/take', { keys });
      await apply(result);
      if (result && Array.isArray(result.blocked) && result.blocked.length > 0) {
        toast(`${result.blocked.length} 条因本次文书缺对应章节未生成：${result.blocked.map((item) => item.label).join('、')}`, 'info');
      }
      return;
    }
    /* 出院汇总：读一次只算不写；"生成建议"也仍然不落笔（落笔只能在建议列表里由人采纳） */
    if (el.id === 'btnDischargeRead') { await apply(await api('/api/discharge-summary', {})); return; }
    if (el.id === 'btnDischargeApply') {
      const keys = [...document.querySelectorAll('[data-derive-key]:checked')].map((input) => input.dataset.deriveKey);
      if (keys.length === 0) { toast('先勾选要生成建议的章节', 'info'); return; }
      await apply(await api('/api/discharge-summary/apply', { keys }));
      return;
    }
    if (el.dataset.carry) {
      const source = S.visitCompare && S.visitCompare.compare && S.visitCompare.compare.medication;
      const paragraphs = source && Array.isArray(source.paragraphs) ? source.paragraphs : [];
      if (paragraphs.length === 0) { toast('没有可沿用的原文', 'info'); return; }
      const result = await api('/api/compare/carry-over', {
        targetNodeId: el.dataset.carry,
        text: paragraphs.join('\n'),
      });
      await apply(result);
      if (result && result.ok === true) {
        toast('已生成 1 条建议 —— 去「AI 助手」采纳后才落笔', 'ok');
      }
      return;
    }
    const consistencyKey = el.dataset.consistency;
    if (consistencyKey) { await apply(await api('/api/apply-consistency', { key: consistencyKey })); return; }
    if (el.id === 'btnOpenLog') { setMoreMenu(false); switchTab('log'); return; }
    if (el.id === 'btnDismissReject') {
      const latest = (S.log || []).find((item) => item.ok === false);
      dismissedRejectAt = latest ? latest.at : null;
      renderRejectBanner();
      return;
    }
    const annoResolve = el.dataset.annoResolve;
    if (annoResolve) {
      if (el.dataset.annoStatus === 'dismissed'
        && !(await askConfirm(
          '标记为误报：同一条规则在「内容未变」时不会再提示。\n\n若误报反复提示，容易形成习惯性忽略，整套质控会失效。',
          { okLabel: '忽略这条', tone: 'danger' },
        ))) return;
      await apply(await api('/api/resolve-annotation', { annotationId: annoResolve, status: el.dataset.annoStatus }));
      return;
    }
    const annoLost = el.dataset.annoLost;
    if (annoLost) { await apply(await api('/api/confirm-anchor-lost', { annotationId: annoLost })); return; }
    const acceptGroup = el.dataset.acceptGroup;
    if (acceptGroup) {
      const r = await api('/api/accept-group', { groupId: acceptGroup });
      const blocked = (r.data && r.data.blocked) || [];
      if (blocked.length > 0) {
        await askAlert(`本组有 ${blocked.length} 条未落笔（置信度不足，仍待处理）：\n\n` + blocked.map((b) => `${b.suggestionId}：${b.message}`).join('\n'));
      }
      await apply(r);
      return;
    }
    const rejectGroup = el.dataset.rejectGroup;
    if (rejectGroup) { await apply(await api('/api/reject-group', { groupId: rejectGroup })); return; }
    if (el.id === 'btnRefreshMachine') { await apply(await api('/api/refresh-machine', {})); return; }
    if (el.id === 'btnSign') {
      let r = await api('/api/sign', {});
      if (!r.ok && (r.code === 'E_SIGNED_WITH_UNCONFIRMED_AI' || r.code === 'E_IMPORTED_UNCONFIRMED')) {
        const agreed = await askConfirm(
          `${r.message || '存在未逐条确认的内容'}\n\n你是否已通读并认可这些内容？\n（确认即由你负责，该声明与未确认清单都会记入留痕）`,
          { okLabel: '我已通读并认可', tone: 'danger' },
        );
        if (agreed) r = await api('/api/sign', { acknowledgeUnconfirmed: true });
      }
      await apply(r);
      if (r && r.ok) hostEmit('signed', hostSnapshot());
      return;
    }
    if (el.id === 'btnExport') { await apply(await api('/api/export', {})); return; }

    const accept = el.dataset.accept;
    if (accept) {
      const area = document.querySelector(`[data-sugg-text="${accept}"]`);
      const origin = (Array.isArray(S.suggestions) ? S.suggestions : []).find((item) => item.id === accept);
      const edited = area && origin && area.value !== origin.text ? area.value : undefined;
      const review = sentenceReviews.get(accept);
      await apply(await api('/api/accept', {
        suggestionId: accept,
        ...(edited === undefined ? {} : { editedText: edited }),
        ...(review && !review.manual ? { aiRanges: aiRangesOf(review) } : {}),
      }));
      return;
    }
    const reject = el.dataset.reject;
    if (reject) { await apply(await api('/api/reject', { suggestionId: reject, reason: '演示拒绝' })); return; }
    const confirm = el.dataset.confirm;
    if (confirm) { await apply(await api('/api/confirm', { nodeId: confirm })); return; }
    const revertRev = el.dataset.revertRev;
    if (revertRev) {
      const ok = await askConfirm(`把整份病历的内容回到第 ${revertRev} 版？当前内容会被替换成那一版的样子。`, {
        okLabel: '回到这一版',
      });
      if (!ok) return;
      const result = await api('/api/revert-to', { rev: Number(revertRev) });
      if (!result.ok) {
        showHistoryError(result.message || result.code || '未能回到这一版');
        return;
      }
      closeHistory();
      await apply(result);
      return;
    }
    const paraInsert = el.dataset.paraInsert;
    if (paraInsert) {
      const r = await api('/api/insert-paragraph', { nodeId: paraInsert });
      await apply(r);
      if (r.ok && r.data && r.data.textNodeId) focusEdit(r.data.textNodeId);
      return;
    }
    const paraUp = el.dataset.paraUp;
    if (paraUp) { await apply(await api('/api/move-node', { nodeId: paraUp, direction: 'up' })); return; }
    const paraDown = el.dataset.paraDown;
    if (paraDown) { await apply(await api('/api/move-node', { nodeId: paraDown, direction: 'down' })); return; }
    const paraDelete = el.dataset.paraDelete;
    if (paraDelete) {
      if (!(await askConfirm(
        '删除本段（含其中的字段）？\n\n此操作会写入留痕，但内容不可恢复（当前没有撤销）。',
        { okLabel: '删除本段', tone: 'danger' },
      ))) return;
      await apply(await api('/api/delete-node', { nodeId: paraDelete }));
      return;
    }
    const imageDelete = el.dataset.imageDelete;
    if (imageDelete) {
      if (!(await askConfirm(
        '删掉这张图？\n\n同一段里的正文不会动；图片字节仍留在资源目录里（撤销也还能把它找回来）。',
        { okLabel: '删掉这张图', tone: 'danger' },
      ))) return;
      await apply(await api('/api/delete-image', { nodeId: imageDelete }));
      return;
    }
    const imageFill = el.dataset.imageFill;
    if (imageFill) {
      const picked = await uploadPickedImage();
      if (!picked) return;
      const result = await api('/api/set-image', {
        nodeId: imageFill,
        resRef: picked.resource.resRef,
        ...(picked.name ? { altText: picked.name } : {}),
      });
      await apply(result);
      if (result.ok) {
        docNotice = `已贴图：${picked.resource.width}×${picked.resource.height}，${Math.round((picked.resource.bytes || 0) / 1024)} KB。导出归档件时图会打进 Res/MultiMedia。`;
        renderDoc();
      }
      return;
    }
    const paraImage = el.dataset.paraImage;
    if (paraImage) {
      const picked = await uploadPickedImage();
      if (!picked) return;
      const inserted = await api('/api/insert-image', {
        paragraphId: paraImage,
        resRef: picked.resource.resRef,
        altText: picked.name,
      });
      await apply(inserted);
      if (inserted.ok) {
        docNotice = `已贴图：${picked.resource.width}×${picked.resource.height}，${Math.round((picked.resource.bytes || 0) / 1024)} KB。导出归档件时图会打进 Res/MultiMedia。`;
        renderDoc();
      }
      return;
    }
    if (el.id === 'btnUndo') {
      openHistory();
      return;
    }
    if (el.id === 'historyClose') { closeHistory(); return; }
    if (el.dataset.undoNow) {
      await doUndo();
      return;
    }
    if (el.id === 'btnUnlock') {
      const reason = await askText(
        '解锁理由（会写入留痕，事后追责看的就是它）：\n例如：纠正诊断笔误 / 补充既往用药',
        {
          okLabel: '解锁',
          required: true,
          requiredHint: '必须填写解锁理由。',
          placeholder: '例如：纠正诊断笔误',
        },
      );
      if (reason === null) return;
      const r = await api('/api/unlock', { reason });
      docNotice = r.ok ? '已解锁：现在可以修改，改完请重新签章（原签章已作废，可在留痕里查到理由）。' : '';
      await apply(r);
      return;
    }
    const confirmSubtree = el.dataset.confirmSubtree;
    if (confirmSubtree) {
      await apply(await api('/api/confirm-subtree', { nodeId: confirmSubtree }));
      return;
    }
  } catch (err) {
    console.error(err);
  } finally {
    el.disabled = false;
    el.removeAttribute('aria-busy');
  }
});

/** 切换病历：先落盘未保存的编辑，再走 /api/open（切换必须经服务端，不能只改前端状态） */
async function switchDoc(docId) {
  if (!docId) return;
  clearTimeout(blurTimer);
  await flushEdits();
  await apply(await api('/api/open', { docId }));
  lastCaret = null;
  contentTargetCaret = null;
}

for (const caretEvent of ['focusin', 'keyup', 'mouseup', 'selectionchange']) {
  document.addEventListener(caretEvent, rememberCaret, true);
}

document.addEventListener('input', (event) => {
  const el = event.target;
  if (!isEditor(el)) return;
  if (el.tagName === 'TEXTAREA') {
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + 2}px`;
  }
  if (el.dataset.edit) markDirty('edit', el.dataset.edit, el.value);
  else if (el.dataset.field) markDirty('field', el.dataset.field, el.value);
  else {
    markDirty('control', el.dataset.controlField, el.type === 'checkbox' ? (el.checked ? 'true' : 'false') : el.value);
  }
  updateDirtyBadge();
}, true);

function placementNote(placement) {
  if (!placement) return '';
  const items = Array.isArray(placement.items) ? placement.items : [];
  if (placement.enabled !== true) {
    const warning = (placement.warnings || [])[0];
    return warning ? ` ${warning}。` : '';
  }
  const moved = items.filter((item) => item.moved === true);
  if (moved.length === 0) {
    return items.length > 0 ? ' 落位规则没有改动落点：都落在你粘贴的位置。' : '';
  }
  const detail = moved
    .map((item) => `第 ${item.index} 段 →「${item.sectionTitle}」（命中"${item.matched}"）`)
    .join('；');
  const rest = items.length - moved.length;
  return ` ${moved.length} 段被落位规则放到了别的章节：${detail}。`
    + (rest > 0 ? `其余 ${rest} 段落在你粘贴的位置。` : '')
    + '被挪走的段落追加在该章节末尾 —— 落位是猜的，请核对后再确认。';
}

document.addEventListener('paste', async (event) => {
  const el = event.target;
  if (!isEditor(el) || !el.dataset.edit) return;
  const text = (event.clipboardData && event.clipboardData.getData('text/plain')) || '';
  if (!/[\r\n]/.test(text)) return;
  event.preventDefault();
  const r = await api('/api/paste-text', { nodeId: el.dataset.edit, text });
  if (r.ok) {
    const paragraphs = (r.data && r.data.paragraphs) || 0;
    docNotice = `已粘贴 ${paragraphs} 段（按外来内容处理：这些段落需要人工确认后才能签章）。`
      + placementNote(r.placement);
    await apply(r);
    await autoScanStructuring('粘贴');
    const ids = (r.data && r.data.textNodeIds) || [];
    if (ids.length > 0) focusEdit(ids[0]);
  } else {
    docNotice = `粘贴未生效：${(r && (r.message || r.code)) || '未知原因'}`;
    renderDoc();
  }
});

document.addEventListener('blur', (event) => {
  const el = event.target;
  if (!isEditor(el)) return;
  clearTimeout(blurTimer);
  blurTimer = setTimeout(() => { void flushEdits(); }, 250);
}, true);

async function flushEdits() {
  await flushFlow();
  if (pendingEdits.size === 0) return null;
  const entries = [...pendingEdits.values()];
  pendingEdits.clear();
  updateDirtyBadge();
  let last = null;
  for (const entry of entries) {
    if (entry.kind === 'edit') {
      last = await api('/api/edit', { nodeId: entry.id, text: entry.value });
    } else if (entry.kind === 'field') {
      last = await api('/api/set-field', { nodeId: entry.id, value: entry.value });
    } else {
      const at = String(entry.id).indexOf(':');
      last = await api('/api/set-control-field', {
        nodeId: String(entry.id).slice(0, at),
        fieldKey: String(entry.id).slice(at + 1),
        value: entry.value,
      });
    }
  }
  await apply(last);
  return last;
}

function updateDirtyBadge() {
  const el = document.getElementById('dirtyBadge');
  const dirty = pendingEdits.size > 0 || flowDirty.size > 0;
  if (el) {
    el.style.display = dirty ? 'inline-flex' : 'none';
    el.textContent = '有未保存编辑（失焦 250ms 自动保存）';
  }
  hostEmit('dirty', { dirty });
}

function hostSnapshot() {
  const p = (S && S.patient) || null;
  const e = (S && S.encounter) || null;
  const d = (S && S.doc) || null;
  return {
    docId: (S && S.activeDocId) || (d && d.docId) || '',
    docType: (d && d.docType) || '',
    status: (d && d.status) || '',
    rev: (d && typeof d.rev === 'number' ? d.rev : null),
    dirty: pendingEdits.size > 0 || flowDirty.size > 0,
    patientId: (p && p.patientId) || '',
    visitId: (e && e.visitId) || '',
  };
}

async function openFromHostContext() {
  const ctx = (hostBridge() || {}).context;
  const docId = ctx && ctx.docId;
  if (!docId) return;
  if (S && S.activeDocId === docId) return;
  await apply(await api('/api/open', { docId }));
}

async function canLeave() {
  clearTimeout(blurTimer);
  const last = await flushEdits();
  const dirty = pendingEdits.size > 0 || flowDirty.size > 0;
  const failed = !!(last && last.ok === false);
  return {
    ok: !dirty && !failed,
    dirty,
    failed,
    reason: failed ? '有编辑未落盘（服务端拒绝了写入）' : dirty ? '有未保存编辑' : '',
    state: hostSnapshot(),
  };
}

function registerHostApi() {
  const bridge = typeof window === 'undefined' ? null : window.L0Host;
  if (!bridge || typeof bridge.register !== 'function') return;
  bridge.register({
    open: (payload) => switchDoc(payload && payload.docId),
    flush: () => flushEdits(),
    canLeave: () => canLeave(),
    getState: () => hostSnapshot(),
    setContext: async (payload) => {
      if (window.__L0_HOST__) window.__L0_HOST__ = Object.assign({}, window.__L0_HOST__, { context: payload || {} });
      await openFromHostContext();
      return hostSnapshot();
    },
  });
}

let flowDirty = new Set();
let flowTimer = null;
let composing = false;
let pendingCaret = null;
let flowInflight = false;
let flowBaselineRev = null;

function flowHostOf(key) {
  const hosts = document.querySelectorAll('[data-flow-seg]');
  for (const host of hosts) {
    if (host.dataset.flowSeg === key) return host;
  }
  return null;
}

function flowBlocks(host) {
  return Array.from(host.children).filter((el) => el.classList && el.classList.contains('fp'));
}

function markFlowDirty(host) {
  if (host && host.dataset.flowSeg) flowDirty.add(host.dataset.flowSeg);
}

function scheduleFlowFlush(delay) {
  clearTimeout(flowTimer);
  flowTimer = setTimeout(() => { void flushFlow(); }, delay === undefined ? 700 : delay);
}

function collectFlowOps(keys, insertOrigin) {
  const plan = L0FlowView.planOf(S.items || []);
  const segments = new Map(plan.filter((unit) => unit.type === 'segment').map((unit) => [unit.key, unit]));
  const ops = [];
  const blocked = [];
  const carets = [];
  keys.forEach((key) => {
    const host = flowHostOf(key);
    const segment = segments.get(key);
    if (!host || !segment) return;
    const outcome = L0FlowView.diff(segment, L0FlowView.readBlocks(host));
    outcome.ops.forEach((op) => {
      ops.push(insertOrigin !== undefined && op.op === 'insert' ? { ...op, origin: insertOrigin } : op);
    });
    blocked.push(...outcome.blocked);
    if (outcome.ops.length > 0) {
      const caret = L0FlowView.caretOf(host);
      if (caret) carets.push({ key, at: caret, focus: host.contains(document.activeElement) });
    }
  });
  return { ops, blocked, carets };
}

async function sendFlowOps(ops) {
  const request = { ops };
  if (typeof flowBaselineRev === 'number') request.expectedRev = flowBaselineRev;
  return api('/api/apply-edits', request);
}

async function flushFlow() {
  if (!isFlow() || composing || flowDirty.size === 0) return null;
  if (flowInflight) {
    scheduleFlowFlush(150);
    return null;
  }
  const keys = [...flowDirty];
  flowDirty.clear();
  const first = collectFlowOps(keys);
  if (first.blocked.length > 0) {
    docNotice = `有一处改动没有落笔：${first.blocked[0]}`;
    pendingCaret = null;
    renderDoc();
    updateDirtyBadge();
    return null;
  }
  if (first.ops.length === 0) {
    updateDirtyBadge();
    return null;
  }
  flowInflight = true;
  let response = await sendFlowOps(first.ops);
  let carets = first.carets;
  if (!response.ok && response.code === 'E_REV_CONFLICT') {
    const fresh = await api('/api/state');
    if (fresh && fresh.state) {
      S = fresh.state;
      flowBaselineRev = S.doc.rev;
      const retry = collectFlowOps(keys);
      if (retry.blocked.length === 0 && retry.ops.length > 0) {
        response = await sendFlowOps(retry.ops);
        carets = retry.carets;
        if (response.ok) {
          docNotice = '落笔时这份病历已被别处改过：已按最新内容重新落笔一次，你写的字都在。';
        }
      }
    }
  }
  flowInflight = false;
  if (response.ok) {
    const data = response.data || {};
    const failed = Array.isArray(data.failed) ? data.failed : [];
    if (failed.length > 0) {
      docNotice = `已落笔 ${data.applied ?? first.ops.length} 处，其中 ${failed.length} 处未生效：${failed.map((item) => item.message).join('；')}`;
      toast(`有 ${failed.length} 处改动未生效（原因见正文上方）`, 'danger');
    } else if (docNotice === '' || docNotice.indexOf('已被别处改过') < 0) {
      docNotice = '';
    }
  } else {
    docNotice = `落笔未生效：${(response.message || response.code) || '未知原因'}`;
  }
  pendingCaret = carets[0] || null;
  await apply(response);
  updateDirtyBadge();
  return response;
}

function splitFlowBlock(host) {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || !selection.isCollapsed) return;
  const range = selection.getRangeAt(0);
  const found = L0FlowView.blockAt(host, range.startContainer);
  if (!found) return;
  const block = found.el;
  const tailRange = document.createRange();
  tailRange.setStart(range.startContainer, range.startOffset);
  if (block.lastChild) tailRange.setEndAfter(block.lastChild);
  else tailRange.setEnd(block, 0);
  const fragment = tailRange.extractContents();
  const holder = document.createElement('div');
  holder.appendChild(fragment);
  const tail = holder.innerHTML;
  if (block.textContent === '') block.innerHTML = '<br>';
  const next = document.createElement('div');
  next.className = 'fp';
  next.innerHTML = tail === '' ? '<br>' : tail;
  block.parentNode.insertBefore(next, block.nextSibling);
  const caret = document.createRange();
  caret.selectNodeContents(next);
  caret.collapse(true);
  selection.removeAllRanges();
  selection.addRange(caret);
  markFlowDirty(host);
  updateDirtyBadge();
  void flushFlow();
}

function mergeFlowBlock(host, event) {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || !selection.isCollapsed) return;
  const range = selection.getRangeAt(0);
  const found = L0FlowView.blockAt(host, range.startContainer);
  if (!found || found.index === 0) return;
  const offset = L0FlowView.offsetIn(found.el, range.startContainer, range.startOffset);
  if (offset !== 0) return;
  event.preventDefault();
  const blocks = flowBlocks(host);
  const previous = blocks[found.index - 1];
  if (!previous) return;
  const seam = previous.textContent.length;
  while (found.el.firstChild) previous.appendChild(found.el.firstChild);
  if (previous.textContent === '') previous.innerHTML = '<br>';
  found.el.remove();
  L0FlowView.setCaret(host, { index: found.index - 1, offset: seam });
  markFlowDirty(host);
  updateDirtyBadge();
  void flushFlow();
}

document.addEventListener('input', (event) => {
  if (!isFlow()) return;
  const host = event.target && event.target.closest ? event.target.closest('[data-flow-seg]') : null;
  if (!host) return;
  markFlowDirty(host);
  updateDirtyBadge();
  scheduleFlowFlush(700);
}, true);

document.addEventListener('compositionstart', (event) => {
  if (isFlow() && event.target && event.target.closest && event.target.closest('[data-flow-seg]')) composing = true;
}, true);

document.addEventListener('compositionend', (event) => {
  if (!isFlow()) return;
  const host = event.target && event.target.closest ? event.target.closest('[data-flow-seg]') : null;
  if (!host) return;
  composing = false;
  markFlowDirty(host);
  scheduleFlowFlush(250);
}, true);

document.addEventListener('keydown', (event) => {
  if (!isFlow()) return;
  const accel = event.ctrlKey || event.metaKey;
  const target = event.target;
  const inField = !!(target && target.tagName && ['INPUT', 'TEXTAREA', 'SELECT'].indexOf(target.tagName) >= 0);
  const inDialog = !!(target && target.closest && target.closest('[role="dialog"], .dialog, .modal'));
  if (accel && !event.altKey && !inField && !inDialog
    && (event.key === 'z' || event.key === 'Z' || event.key === 'y' || event.key === 'Y')) {
    event.preventDefault();
    if (!S.undo) {
      docNotice = '没有可撤销的写入（只支持撤销最近一次；签章 / 解锁之后不可撤销）。';
      renderDoc();
      return;
    }
    void doUndo();
    return;
  }
  const host = event.target && event.target.closest ? event.target.closest('[data-flow-seg]') : null;
  if (!host) return;
  if (composing) return;
  if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
    event.preventDefault();
    splitFlowBlock(host);
    return;
  }
  if (event.key === 'Backspace' && !event.ctrlKey && !event.metaKey && !event.altKey) {
    mergeFlowBlock(host, event);
  }
}, true);

document.addEventListener('blur', (event) => {
  if (!isFlow()) return;
  const host = event.target && event.target.closest ? event.target.closest('[data-flow-seg]') : null;
  if (!host) return;
  clearTimeout(flowTimer);
  scheduleFlowFlush(200);
}, true);

document.addEventListener('paste', async (event) => {
  if (!isFlow()) return;
  const host = event.target && event.target.closest ? event.target.closest('[data-flow-seg]') : null;
  if (!host) return;
  const text = (event.clipboardData && event.clipboardData.getData('text/plain')) || '';
  if (!/[\r\n]/.test(text) || composing) return;
  event.preventDefault();
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return;
  const range = selection.getRangeAt(0);
  const found = L0FlowView.blockAt(host, range.startContainer);
  if (!found) return;
  const offset = L0FlowView.offsetIn(found.el, range.startContainer, range.startOffset);
  const whole = found.el.textContent;
  const head = whole.slice(0, offset);
  const tail = whole.slice(offset);
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '');
  if (lines.length === 0) return;
  const blocks = flowBlocks(host);
  const index = blocks.indexOf(found.el);
  found.el.innerHTML = '';
  found.el.appendChild(document.createTextNode(head + lines[0]));
  let cursor = found.el;
  for (let i = 1; i < lines.length; i += 1) {
    const block = document.createElement('div');
    block.className = 'fp';
    block.textContent = i === lines.length - 1 ? lines[i] + tail : lines[i];
    cursor.parentNode.insertBefore(block, cursor.nextSibling);
    cursor = block;
  }
  if (lines.length === 1 && tail !== '') found.el.textContent = head + lines[0] + tail;
  const lastIndex = index + lines.length - 1;
  L0FlowView.setCaret(host, { index: lastIndex, offset: (lines[lines.length - 1] + tail).length });
  markFlowDirty(host);
  updateDirtyBadge();
  await flushFlowPaste();
}, true);

async function flushFlowPaste() {
  if (flowInflight) {
    await flushFlow();
    return;
  }
  const keys = [...flowDirty];
  flowDirty.clear();
  const { ops, blocked, carets } = collectFlowOps(keys, 'imported');
  if (blocked.length > 0) {
    docNotice = `粘贴的内容没有落笔：${blocked[0]}`;
    pendingCaret = null;
    renderDoc();
    updateDirtyBadge();
    return;
  }
  if (ops.length === 0) return;
  const paragraphs = ops.filter((op) => op.op === 'insert').length;
  flowInflight = true;
  const response = await sendFlowOps(ops);
  flowInflight = false;
  if (response.ok) {
    const data = response.data || {};
    const failed = Array.isArray(data.failed) ? data.failed : [];
    docNotice = `已粘贴 ${paragraphs} 段（按外来内容处理：这些段落需要人工确认后才能签章）。`
      + (failed.length > 0 ? ` 其中 ${failed.length} 段未生效：${failed.map((item) => item.message).join('；')}` : '');
  } else {
    docNotice = `粘贴未生效：${(response.message || response.code) || '未知原因'}`;
  }
  pendingCaret = carets[0] || null;
  await apply(response);
  updateDirtyBadge();
}

document.addEventListener('click', async (event) => {
  if (!isFlow()) return;
  const chip = event.target && event.target.closest ? event.target.closest('.fe[data-field-node]') : null;
  if (!chip) return;
  if (S.doc.status === 'signed' || S.doc.status === 'archived') {
    toast('本文书已签章 / 已归档：内容不可修改', 'danger');
    return;
  }
  const item = (S.items || []).find((candidate) => candidate.id === chip.dataset.fieldNode);
  if (!item) return;
  const label = item.label || '这一格';
  const value = await askText(`${label}（当前：${item.value === '' ? '空' : item.value}${item.unit ? ` ${item.unit}` : ''}）\n\n写入会留痕，机读信息随之变旧（签章前需重算）。`, {
    defaultValue: item.value || '',
    okLabel: '写入',
  });
  if (value === null || value === undefined || String(value) === item.value) return;
  await flushEdits();
  const response = await api('/api/set-field', { nodeId: item.id, value: String(value) });
  await apply(response);
}, true);

const MARK_COMMAND = {
  bold: 'bold',
  italic: 'italic',
  underline: 'underline',
  sup: 'superscript',
  sub: 'subscript',
};

function toggleInlineTag(tagName) {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return false;
  const range = selection.getRangeAt(0);
  const tag = String(tagName || '').toLowerCase();
  if (tag === '') return false;

  const root = range.commonAncestorContainer.nodeType === 1
    ? range.commonAncestorContainer
    : range.commonAncestorContainer.parentNode;
  if (!root) return false;

  const targets = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.nodeValue || '';
    if (text === '') continue;
    if (!range.intersectsNode(node)) continue;
    let start = 0;
    let end = text.length;
    if (node === range.startContainer) start = range.startOffset;
    if (node === range.endContainer) end = range.endOffset;
    if (end <= start) continue;
    targets.push({ node, start, end });
  }
  if (targets.length === 0) return false;

  const host = root.closest ? root.closest('[data-flow-seg]') : null;
  /* 已经整段套着的 → 解开（再点一次就是"取消高亮"，与工具栏按钮的直觉一致） */
  const wrapped = targets.every((item) => item.node.parentNode
    && item.node.parentNode.tagName
    && item.node.parentNode.tagName.toLowerCase() === tag);
  if (wrapped) {
    const parents = [];
    for (const item of targets) {
      const parent = item.node.parentNode;
      if (parent && !parents.includes(parent)) parents.push(parent);
    }
    for (const parent of parents) {
      const holder = document.createDocumentFragment();
      while (parent.firstChild) holder.appendChild(parent.firstChild);
      parent.replaceWith(holder);
    }
    if (host) host.normalize();
    selection.removeAllRanges();
    return true;
  }

  for (let i = targets.length - 1; i >= 0; i -= 1) {
    const item = targets[i];
    let node = item.node;
    if (item.end < (node.nodeValue || '').length) node = node.splitText(item.end);
    if (item.start > 0) node = node.splitText(item.start);
    const wrapper = document.createElement(tag);
    node.parentNode.insertBefore(wrapper, node);
    wrapper.appendChild(node);
  }
  selection.removeAllRanges();
  return true;
}

function flowHostOfSelection() {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  const root = range.commonAncestorContainer.nodeType === 1
    ? range.commonAncestorContainer
    : range.commonAncestorContainer.parentNode;
  return root && root.closest ? root.closest('[data-flow-seg]') : null;
}

/** 把一次格式动作落进写路径（走与打字完全相同的那条路） */
function applyFlowMark(mark) {
  const host = document.querySelector('[data-flow-seg]:focus-within') || flowHostOfSelection();
  if (!host) {
    toast('先把光标放进正文，再点格式按钮', 'info');
    return;
  }
  if (mark === 'highlight') {
    if (!toggleInlineTag('mark')) {
      toast('先选中要标记的字', 'info');
      return;
    }
  } else if (!document.execCommand(MARK_COMMAND[mark] || mark)) {
    toast('这个格式在当前浏览器里不可用', 'info');
    return;
  }
  markFlowDirty(host);
  updateDirtyBadge();
  scheduleFlowFlush(400);
}

function setFlowToolsFloating(on) {
  const tools = $('flowTools');
  if (!tools) return;
  const spacer = $('flowToolsSpacer');
  if (!on) {
    tools.classList.remove('floating');
    if (spacer) {
      spacer.hidden = true;
      spacer.style.height = '0';
    }
    return;
  }
  if (tools.classList.contains('floating')) return;
  if (spacer) {
    spacer.style.height = `${Math.ceil(tools.getBoundingClientRect().height)}px`;
    spacer.hidden = false;
  }
  tools.classList.add('floating');
}

function positionFlowTools() {
  const tools = $('flowTools');
  if (!tools) return;
  if (!isFlow() || tools.hidden) {
    setFlowToolsFloating(false);
    return;
  }
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    setFlowToolsFloating(false);
    return;
  }
  const range = selection.getRangeAt(0);
  const root = range.commonAncestorContainer.nodeType === 1
    ? range.commonAncestorContainer
    : range.commonAncestorContainer.parentNode;
  if (!root || !root.closest || !root.closest('[data-flow-seg]')) {
    setFlowToolsFloating(false);
    return;
  }
  const rect = range.getBoundingClientRect();
  if (!rect || (rect.width === 0 && rect.height === 0)) {
    setFlowToolsFloating(false);
    return;
  }
  setFlowToolsFloating(true);
  const width = tools.offsetWidth || 300;
  const height = tools.offsetHeight || 34;
  const left = Math.min(Math.max(8, rect.left + rect.width / 2 - width / 2), window.innerWidth - width - 8);
  const above = rect.top - height - 8;
  const top = above >= 8 ? above : Math.min(rect.bottom + 8, window.innerHeight - height - 8);
  tools.style.left = `${Math.round(left)}px`;
  tools.style.top = `${Math.round(top)}px`;
}

let flowFloatTimer = null;
document.addEventListener('selectionchange', () => {
  if (!isFlow()) return;
  clearTimeout(flowFloatTimer);
  flowFloatTimer = setTimeout(positionFlowTools, 40);
});
window.addEventListener('scroll', () => {
  const tools = $('flowTools');
  if (tools && tools.classList.contains('floating')) positionFlowTools();
}, { passive: true, capture: true });
window.addEventListener('resize', () => {
  const tools = $('flowTools');
  if (tools && tools.classList.contains('floating')) positionFlowTools();
}, { passive: true });
/* 点浮条时不让正文失焦：失焦会清掉选区，而"给选中的字加格式"全部依赖那个选区 */
const flowToolsEl = $('flowTools');
if (flowToolsEl) {
  flowToolsEl.addEventListener('mousedown', (event) => {
    if (event.target && event.target.closest && event.target.closest('[data-mark]')) event.preventDefault();
  });
}

document.addEventListener('click', (event) => {
  const button = event.target && event.target.closest ? event.target.closest('[data-mark]') : null;
  if (!button || !isFlow()) return;
  applyFlowMark(button.dataset.mark);
}, true);

$('fileInput').addEventListener('change', async (event) => {
  const input = event.target;
  const file = input.files && input.files[0];
  if (!file) return;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const result = await api('/api/import', { fileName: file.name, base64: btoa(binary) });
    await apply(result);
    if (!result.ok) console.warn('导入失败', result);
  } catch (err) {
    console.error(err);
  } finally {
    input.value = '';
  }
});

(function initCaptureLocalDetection() {
  const wave = $('captureLocalWave');
  if (wave && wave.childElementCount === 0) {
    for (let i = 0; i < 14; i += 1) {
      const bar = document.createElement('i');
      bar.style.animationDelay = `-${i * 110}ms`;
      wave.appendChild(bar);
    }
  }
  void probeCaptureClient();
  setInterval(() => {
    if (document.hidden) return;
    if (captureClientOf() === null) return;
    void probeCaptureClient();
  }, CLIENT_HEARTBEAT_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    if (captureClientOf() === null) return;
    void probeCaptureClient();
  });
})();

void (async () => {
  if (window.L0Host) await window.L0Host.whenReady();
  applyCapabilities();
  syncHeaderHeight();
  layoutRailTabs();
  registerHostApi();
  await openFromHostContext();
  await refresh();
  await loadMyContent();
  hostEmit('ready', hostSnapshot());
})();
