const $ = (id) => document.getElementById(id);
const L0_BASE = (document.documentElement && document.documentElement.dataset.l0Base) || '';
function esc(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function chips(items) {
  return items.filter(Boolean).map(([label, value, tone]) => `<span class="chipline">`
    + `<span class="chipline-k">${esc(label)}</span>`
    + `<span class="chipline-v${tone ? ` ${tone}` : ''}">${esc(value)}</span></span>`).join('');
}

function kvRows(rows) {
  return rows.filter(Boolean).map(([label, value, cls]) => {
    const text = value === undefined || value === null || value === '' ? '—' : String(value);
    return `<span class="kv-k">${esc(label)}</span>`
      + `<span class="kv-v${cls ? ` ${cls}` : ''}" title="${esc(text)}">${esc(text)}</span>`;
  }).join('');
}

function metricRow(items) {
  return items.filter(Boolean).map(([label, value]) => '<div class="metric">'
    + `<div class="metric-v">${esc(value ?? '—')}</div>`
    + `<div class="metric-k">${esc(label)}</div></div>`).join('');
}

const FORMAT_LABEL = {
  offline: '离线模板（不外呼）',
  'openai-compatible': '在线模型（会外呼）',
};

async function api(path, body) {
  const res = await fetch(`${L0_BASE}${path}`, body === undefined
    ? { method: 'GET' }
    : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    return await res.json();
  } catch {
    return { ok: false, code: 'E_BAD_RESPONSE', message: `响应不是 JSON（HTTP ${res.status}）` };
  }
}

function setLoginStatus(text, danger = false) {
  const el = $('loginStatus');
  el.textContent = text;
  el.classList.toggle('bad', danger);
}

let session = null;
let S = {};

const VIEW_META = {
  config: { title: '能力配置', sub: '这里配置的是部署参数：模型地址、签名服务、授权源、落位策略。' },
  master: { title: '基础数据', sub: '整个部署共用的主数据：科室字典、文书类型、以及规则里的「判定方式」（只读清单）。模板的「适用科室」、就诊科室的显示、「新建文书」的类型选项、规则库里的判定方式都读它们。' },
  accounts: { title: '账号管理', sub: '谁可以进入后台、以什么角色进入。口令只以哈希保存在数据库，任何位置都不回显。' },
  health: { title: '运行状态', sub: '签名服务与模型探测的留档，以及这台机器上现在有多少东西。' },
  audit: { title: '审计与安全', sub: '谁在什么时候改了配置、从什么改成什么。登录成功与失败也记录在此。' },
  system: { title: '系统信息', sub: '这台机器上跑的是什么：版本 / 环境 / 目录 / 生效配置指纹。' },
};

const LOGIN_URL = `${L0_BASE}/login?next=${encodeURIComponent(`${L0_BASE}/admin`)}`;

function renderSession() {
  const role = session && session.roleLabel ? `（${session.roleLabel}）` : '';
  $('adminWho').textContent = session ? `已登录：${session.actorId || session.adminId}${role}` : '';
  $('sideEnv').textContent = `环境：${(session && session.env) || '未标注'}`;
}

function toLogin() {
  location.href = LOGIN_URL;
}

async function logout() {
  await api('/api/admin/logout', {});
  session = null;
  toLogin();
}

async function requireSession() {
  if (session) return true;
  toLogin();
  return false;
}

function markCfgStatus(el, text) {
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('bad', /^(保存失败|测试失败|连接失败|导入失败|未导入|未能|请先)/.test(String(text)));
}
function setCfgStatus(text) { markCfgStatus($('cfgStatus'), text); }
function setPlaceStatus(text) { markCfgStatus($('cfgPlaceStatus'), text); }
/** 采集配置的状态行同样独立（同落位/签名：失败原因不同，混一行会互相覆盖） */
function setCaptureStatus(text) { markCfgStatus($('cfgCaptureStatus'), text); }
/** 签名配置的状态行同理独立：测试签名的诊断结论很长，盖掉别人会让人以为没生效 */
function setSignStatus(text) { markCfgStatus($('cfgSignStatus'), text); }
/** 授权源的状态行独立（同落位/签名） */
function setAuthStatus(text) { markCfgStatus($('cfgAuthStatus'), text); }
function setAuthImportStatus(text) { markCfgStatus($('cfgAuthImportStatus'), text); }
function setPrevisitStatus(text) { markCfgStatus($('cfgPrevisitStatus'), text); }
function setWorkspaceResetStatus(text) { markCfgStatus($('cfgWorkspaceResetStatus'), text); }
function setQcPackStatus(text) { markCfgStatus($('qcPackStatus'), text); }
function setTplPackStatus(text) { markCfgStatus($('tplPackStatus'), text); }
function setExprCatalogStatus(text) { markCfgStatus($('exprCatalogStatus'), text); }
function setCtrlCatalogStatus(text) { markCfgStatus($('ctrlCatalogStatus'), text); }

function setTplDrawerStatus(text) {
  const box = $(tplDrawerBodyId());
  const line = box ? box.querySelector('[data-tpl-drawer-status]') : null;
  if (line) line.innerHTML = text;
}

const CFG_ADMIN_ACTIONS = new Set([
  'cfgSave', 'cfgClearKey', 'cfgPlaceSave', 'cfgPlaceClearKey', 'cfgCaptureSave', 'cfgCaptureClearKey', 'cfgCaptureClearSecret', 'cfgPrevisitSave', 'cfgPrevisitClearKey', 'cfgAuthSave', 'cfgSignSave', 'cfgSignClearKey', 'cfgSignTest',
  'cfgSysPolicySave', 'cfgSysSeedClear', 'cfgQcContentSave', 'cfgQcTokenClear',
  'healthSignTest',
  'cfgWorkspaceReset',
]);

function setConfigReady(ready) {
  for (const id of CFG_ADMIN_ACTIONS) {
    const el = $(id);
    if (el) el.disabled = !ready;
  }
  if (!ready) setLoginStatus('正在加载当前配置…（表单就绪之前「保存」是禁用的，免得把空值提交上去）');
}

function selectCfgPane(tab) {
  const name = tab.dataset.cfgTab;
  const scope = tab.closest('[data-admin-view-pane]') || document;
  scope.querySelectorAll('[data-cfg-tab]').forEach((item) => {
    const active = item.dataset.cfgTab === name;
    item.classList.toggle('active', active);
    item.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  scope.querySelectorAll('[data-cfg-pane]').forEach((pane) => {
    pane.classList.toggle('active', pane.dataset.cfgPane === name);
  });
}

function renderModelPanel() {
  const cfg = S.model || {};
  $('cfgFormat').value = cfg.format === 'openai-compatible' ? 'openai-compatible' : 'offline';
  $('cfgModel').value = cfg.model || '';
  $('cfgEndpoint').value = cfg.endpoint || '';
  $('cfgTimeout').value = cfg.timeoutMs || 20000;
  $('cfgMaxItems').value = cfg.maxItems || 20;
  $('cfgApiKey').value = '';
  const rules = Array.isArray(S.formRules) ? S.formRules : [];
  $('cfgFormRules').textContent = rules.length === 0 ? '未加载' : rules.map((r) => `${r.id} ${r.title}`).join('；');
  const catalog = Array.isArray(((S || {}).knowledgePacks || {}).rules) ? S.knowledgePacks.rules : [];
  $('cfgFormRuleCount').textContent = catalog.length === 0
    ? '0（规则库里没有包）'
    : `${rules.length} / ${catalog.length} 条启用`;
  renderKnowledgePacks();
  renderTemplatePacks();
  refreshExprCatalog();
  refreshCtrlCatalog();
  void loadQcContentConfig();
  renderPlacementPanel();
  renderCapturePanel();
  renderSignPanel();
  renderReadingAuthorityPanel();
  renderPrevisitAccessPanel();
  renderRecipientKeys();
}

let RULE_KEYWORD_FILTER = '';
let RULE_PAGE = 1;
const RULE_PAGE_SIZE = 10;

let RULE_DRAWER_VIEW = '';
let RULE_DRAWER_ITEM = '';

const RULE_PARAMS_ID = 'ruleParams';
const RULE_CONDITION_ID = 'ruleCondition';
const CONDITION_BUILDER_ID = 'conditionLibCondition';

function renderKnowledgePacks() {
  const info = S.knowledgePacks || {};
  const packs = (Array.isArray(info.packs) ? info.packs : []).filter((pack) => pack.kind === 'rule');
  const rules = Array.isArray(info.rules) ? info.rules : [];

  const summary = $('qcPackSummary');
  if (summary) {
    summary.textContent = rules.length === 0
      ? `还没有任何规则：质控没有规则可跑（模板在「模板」页）；当前有 ${packs.length} 个规则包。`
      : '';
  }

  renderRuleTable(rules);
}

function renderRuleTable(rules) {
  const box = $('qcPackItems');
  if (!box) return;
  const keyword = RULE_KEYWORD_FILTER.trim().toLowerCase();
  const shown = keyword === ''
    ? rules
    : rules.filter((rule) => String(rule.title || '').toLowerCase().includes(keyword)
      || String(rule.itemId || '').toLowerCase().includes(keyword));
  if (rules.length === 0) {
    box.innerHTML = '<div class="muted">规则库是空的：点上面的「新建规则」建第一条。</div>';
    return;
  }
  if (shown.length === 0) {
    box.innerHTML = `<div class="muted">没有标题或规则号含「${esc(RULE_KEYWORD_FILTER.trim())}」的规则（库里共 ${rules.length} 条）。清空查询条件即可看全部。</div>`;
    return;
  }
  const pageCount = Math.max(1, Math.ceil(shown.length / RULE_PAGE_SIZE));
  if (RULE_PAGE > pageCount) RULE_PAGE = pageCount;
  if (RULE_PAGE < 1) RULE_PAGE = 1;
  const start = (RULE_PAGE - 1) * RULE_PAGE_SIZE;
  const pageRows = shown.slice(start, start + RULE_PAGE_SIZE);
  box.innerHTML = `
    <table class="mini tpl-table">
      <thead><tr>
        <th>状态</th><th>规则号</th><th>标题</th><th>级别</th><th>判定方式 / 参数</th><th>操作</th>
      </tr></thead>
      <tbody>${pageRows.map((rule) => ruleRowHtml(rule)).join('')}</tbody>
    </table>
    <div class="tpl-pager">
      <span class="muted">第 ${RULE_PAGE} / ${pageCount} 页 · 本页 ${pageRows.length} 条
        （共 ${shown.length} 条，每页 ${RULE_PAGE_SIZE} 条）</span>
      <span class="tpl-pager-btns">
        <button class="secondary" data-rule-page="${RULE_PAGE - 1}" ${RULE_PAGE <= 1 ? 'disabled' : ''}
          title="上一页（只翻这一页的表，不重新拉库里那份目录）">上一页</button>
        <button class="secondary" data-rule-page="${RULE_PAGE + 1}" ${RULE_PAGE >= pageCount ? 'disabled' : ''}
          title="下一页（只翻这一页的表，不重新拉库里那份目录）">下一页</button>
      </span>
    </div>`;
}

function ruleGotoItemPage(itemId) {
  if (RULE_KEYWORD_FILTER.trim() !== '') return;
  const rules = Array.isArray(((S || {}).knowledgePacks || {}).rules) ? S.knowledgePacks.rules : [];
  const index = rules.findIndex((rule) => rule.itemId === itemId);
  if (index < 0) return;
  RULE_PAGE = Math.floor(index / RULE_PAGE_SIZE) + 1;
}

function ruleItemOf(itemId) {
  const rules = Array.isArray(((S || {}).knowledgePacks || {}).rules) ? S.knowledgePacks.rules : [];
  return rules.find((rule) => rule.itemId === itemId) || null;
}

function conditionArgsSpec() {
  const list = Array.isArray(S && S.qcPredicates) ? S.qcPredicates : [];
  for (const brief of list) {
    const found = (brief.params || []).find((spec) => spec.kind === 'condition-args');
    if (found) return found;
  }
  return null;
}

function ruleArgSpecOf(conditionId, name) {
  const item = typeof conditionId === 'string' && conditionId !== '' ? conditionItemOf(conditionId) : null;
  const specs = item && Array.isArray(item.params) ? item.params : [];
  return specs.find((spec) => spec.name === name) || null;
}

function conditionCatalogOf() {
  const value = S && S.qcCondition;
  if (!value || !Array.isArray(value.fields) || !Array.isArray(value.operators)) {
    return { fields: [], operators: [], logic: [] };
  }
  return value;
}

function conditionFieldSpecOf(name) {
  return conditionCatalogOf().fields.find((item) => item.name === name) || null;
}

function conditionOperatorSpecOf(name) {
  return conditionCatalogOf().operators.find((item) => item.name === name) || null;
}

function conditionOperatorsForField(field) {
  return conditionCatalogOf().operators.filter((item) => Array.isArray(item.fields) && item.fields.includes(field));
}

function draftRowOf(atom) {
  return {
    field: typeof atom.field === 'string' ? atom.field : '',
    op: typeof atom.op === 'string' ? atom.op : '',
    value: atom.value,
  };
}

function conditionDraftFromCondition(condition) {
  const source = condition && typeof condition === 'object' && !Array.isArray(condition) ? condition : null;
  if (!source) return { logic: 'all', rows: [{ field: '', op: '', value: undefined }], nested: 0 };
  if (source.kind === 'atom') return { logic: 'all', rows: [draftRowOf(source)], nested: 0 };
  if (source.kind === 'all' || source.kind === 'any') {
    const children = Array.isArray(source.children) ? source.children.filter((child) => child && typeof child === 'object') : [];
    return {
      logic: source.kind,
      rows: children.filter((child) => child.kind === 'atom').map((child) => draftRowOf(child)),
      nested: children.filter((child) => child.kind !== 'atom').length,
    };
  }
  return { logic: 'all', rows: [{ field: '', op: '', value: undefined }], nested: 0 };
}

function conditionDraftFromDom(box) {
  const draft = { logic: 'all', rows: [], nested: 0 };
  if (!box) return draft;
  const logicEl = box.querySelector('[data-cond-logic]');
  draft.logic = logicEl && logicEl.value === 'any' ? 'any' : 'all';
  box.querySelectorAll('[data-cond-row]').forEach((row) => {
    const field = row.querySelector('[data-cond-field]');
    const op = row.querySelector('[data-cond-op]');
    const value = row.querySelector('[data-cond-value]');
    draft.rows.push({
      field: field ? field.value : '',
      op: op ? op.value : '',
      value: value ? value.value : undefined,
    });
  });
  return draft;
}

function conditionFieldOptionsHtml(selected) {
  const groups = [
    { scope: 'document', label: '适用范围（整篇文书一样）' },
    { scope: 'node', label: '判定条件（逐节点判）' },
  ];
  return groups.map((group) => {
    const items = conditionCatalogOf().fields.filter((item) => item.scope === group.scope);
    if (items.length === 0) return '';
    return `<optgroup label="${esc(group.label)}">${items.map((item) => `<option value="${esc(item.name)}"${item.name === selected ? ' selected' : ''}>${esc(item.label)}</option>`).join('')}</optgroup>`;
  }).join('');
}

function conditionValueControlHtml(index, opSpec, value) {
  const attr = `data-cond-value="${index}"`;
  if (!opSpec || opSpec.value === null) return '<span class="muted">这个算子不接受取值</span>';
  const spec = opSpec.value;
  if (spec.kind === 'enum') {
    const options = Array.isArray(spec.options) ? spec.options : [];
    const selected = typeof value === 'string' ? value : '';
    return `<select ${attr}><option value="">请选择</option>${options.map((option) => `<option value="${esc(option.value)}"${option.value === selected ? ' selected' : ''}>${esc(option.label)}</option>`).join('')}</select>`;
  }
  if (spec.kind === 'boolean') {
    const selected = value === true || value === 'true' ? 'true' : value === false || value === 'false' ? 'false' : '';
    return `<select ${attr}><option value="">请选择</option><option value="true"${selected === 'true' ? ' selected' : ''}>是</option><option value="false"${selected === 'false' ? ' selected' : ''}>否</option></select>`;
  }
  if (spec.kind === 'integer') {
    const shown = typeof value === 'number' ? String(value) : (typeof value === 'string' ? value : '');
    return `<input type="number" step="1" min="1" ${attr} value="${esc(shown)}" />`;
  }
  const shown = Array.isArray(value) ? value.join('、') : (typeof value === 'string' ? value : '');
  return `<input type="text" ${attr} value="${esc(shown)}" placeholder="用逗号或顿号分隔" />`;
}

function conditionRowHtml(row, index, locked) {
  const opSpec = conditionOperatorSpecOf(row.op);
  const ops = conditionOperatorsForField(row.field);
  const opOptions = ops.length === 0
    ? '<option value="">（这个字段还没有可用算子）</option>'
    : ops.map((item) => `<option value="${esc(item.name)}"${item.name === row.op ? ' selected' : ''}>${esc(item.label)}</option>`).join('');
  return `<div class="cond-row" data-cond-row="${index}">
      <div class="tpl-cell">
        <span class="tpl-label">字段</span>
        <select data-cond-field="${index}"${locked ? ' disabled' : ''}>${conditionFieldOptionsHtml(row.field)}</select>
      </div>
      <div class="tpl-cell">
        <span class="tpl-label">算子</span>
        <select data-cond-op="${index}"${locked ? ' disabled' : ''}>${opOptions}</select>
      </div>
      <div class="tpl-cell">
        <span class="tpl-label">取值</span>
        ${conditionValueControlHtml(index, opSpec, row.value)}
      </div>
      <div class="cond-row-foot">
        ${locked ? '' : `<button class="danger" data-cond-del="${index}" title="删掉这一条条件">删除</button>`}
      </div>
    </div>`;
}

function conditionBlockBodyHtml(draft) {
  const catalog = conditionCatalogOf();
  if (catalog.fields.length === 0) {
    return '<div class="hint">服务端没有下发可用的字段与算子 —— 构造器打不开。刷新一次；若仍然如此，说明服务端与界面不是同一版。</div>';
  }
  if (draft.nested > 0) {
    return `<div class="hint">这条规则里还有 <b>${draft.nested}</b> 组嵌套条件（「且」里套着「或」）。构造器只拼平铺的条件：
        重画一次就会把嵌套摊平，而<b>摊平会静默改变这条规则的含义</b> —— 所以这里只读。
        要改它，请先删掉这条规则再重建一条（或者保持原样不动）。</div>
      <div class="cond-rows">${draft.rows.map((row, index) => conditionRowHtml(row, index, true)).join('')}</div>`;
  }
  const logic = catalog.logic.length > 0 ? catalog.logic : [{ name: 'all', label: '满足全部', doc: '' }];
  const rows = draft.rows.length === 0 ? [{ field: '', op: '', value: undefined }] : draft.rows;
  return `
    <div class="tpl-cell">
      <span class="tpl-label">条件之间的关系</span>
      <select data-cond-logic>
        ${logic.map((item) => `<option value="${esc(item.name)}"${item.name === draft.logic ? ' selected' : ''}>${esc(item.label)} — ${esc(item.doc)}</option>`).join('')}
      </select>
    </div>
    <div class="cond-rows">${rows.map((row, index) => conditionRowHtml(row, index, false)).join('')}</div>
    <div class="form-actions">
      <button class="secondary" data-cond-add="1">加一条条件</button>
    </div>`;
}

function conditionItemsOfState() {
  return Array.isArray(S && S.qcConditions) ? S.qcConditions : [];
}

function conditionItemOf(itemId) {
  return conditionItemsOfState().find((item) => item.itemId === itemId) || null;
}

const RULE_ARGS_ID = 'ruleCondArgs';

function ruleArgValuesOf(params) {
  const args = params && typeof params.args === 'object' && params.args !== null && !Array.isArray(params.args) ? params.args : {};
  return args;
}

function conditionArgsHtml(spec, conditionId, params) {
  const item = typeof conditionId === 'string' && conditionId !== '' ? conditionItemOf(conditionId) : null;
  const specs = item && Array.isArray(item.params) ? item.params : [];
  if (item === null) {
    return `<div class="tpl-cell"><span class="tpl-label">${esc(spec.label)}</span></div>`;
  }
  if (specs.length === 0) {
    return `<div class="tpl-cell"><span class="tpl-label">${esc(spec.label)}</span></div>`;
  }
  const args = ruleArgValuesOf(params);
  const rows = specs.map((param) => {
    const shown = args[param.name] === undefined || args[param.name] === null
      ? ''
      : Array.isArray(args[param.name]) ? args[param.name].join('、') : String(args[param.name]);
    let control;
    if (param.kind === 'enum') {
      const options = Array.isArray(param.options) ? param.options : [];
      control = `<select data-rule-arg="${esc(param.name)}">
          <option value="">（未填）</option>
          ${options.map((option) => `<option value="${esc(option)}"${option === shown ? ' selected' : ''}>${esc(option)}</option>`).join('')}
        </select>`;
    } else if (param.kind === 'boolean') {
      control = `<select data-rule-arg="${esc(param.name)}">
          <option value="">（未填）</option>
          <option value="true"${shown === 'true' ? ' selected' : ''}>是</option>
          <option value="false"${shown === 'false' ? ' selected' : ''}>否</option>
        </select>`;
    } else if (param.kind === 'integer') {
      control = `<input type="number" step="1" data-rule-arg="${esc(param.name)}" value="${esc(shown)}" />`;
    } else if (param.kind === 'string-list') {
      control = `<input type="text" data-rule-arg="${esc(param.name)}" value="${esc(shown)}" placeholder="用逗号或顿号分隔" />`;
    } else {
      control = `<input type="text" data-rule-arg="${esc(param.name)}" value="${esc(shown)}" />`;
    }
    return `<div class="tpl-cell">
        <span class="tpl-label">${esc(param.label)}${param.required ? '（必填）' : ''} · <span class="mono">$${esc(param.name)}</span></span>
        ${control}
      </div>`;
  }).join('');
  return `<div class="tpl-cell" id="${esc(RULE_ARGS_ID)}">
      <span class="tpl-label">${esc(spec.label)} · <span class="mono">引用「${esc(item.name)}」</span></span>
      <div class="cond-args">${rows}</div>
    </div>`;
}

function conditionBuilderHtml(spec, condition, boxId = RULE_CONDITION_ID) {
  const draft = conditionDraftFromCondition(condition);
  return `<div class="tpl-cell">
      <span class="tpl-label">${esc(spec.label)}${spec.required ? '（必填）' : ''} · <span class="mono">${esc(spec.name)}</span></span>
      <div class="cond-builder" id="${esc(boxId)}" data-cond-locked="${draft.nested > 0 ? '1' : '0'}">${conditionBlockBodyHtml(draft)}</div>
    </div>`;
}

function refreshConditionBlock(box) {
  if (!box) return;
  const draft = conditionDraftFromDom(box);
  box.dataset.condLocked = draft.nested > 0 ? '1' : '0';
  box.innerHTML = conditionBlockBodyHtml(draft);
}

function conditionValueOf(spec, raw) {
  const text = String(raw === undefined || raw === null ? '' : raw).trim();
  if (spec.kind === 'boolean') return text === 'true' ? true : text === 'false' ? false : undefined;
  if (spec.kind === 'integer') {
    const value = Number(text);
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) return undefined;
    return value;
  }
  if (spec.kind === 'enum') return text === '' ? undefined : text;
  const words = text.split(/[,，、;；]/).map((part) => part.trim()).filter((part) => part !== '');
  return words.length === 0 ? undefined : words;
}

function readConditionDraftFrom(box) {
  const out = { kind: 'all', children: [] };
  if (!box) return out;
  const logicEl = box.querySelector('[data-cond-logic]');
  out.kind = logicEl && logicEl.value === 'any' ? 'any' : 'all';
  box.querySelectorAll('[data-cond-row]').forEach((row) => {
    const field = row.querySelector('[data-cond-field]');
    const op = row.querySelector('[data-cond-op]');
    if (!field || !op || field.value === '' || op.value === '') return;
    const atom = { kind: 'atom', field: field.value, op: op.value };
    const opSpec = conditionOperatorSpecOf(op.value);
    if (opSpec && opSpec.value !== null) {
      const control = row.querySelector('[data-cond-value]');
      const value = conditionValueOf(opSpec.value, control ? control.value : '');
      if (value === undefined) return;
      atom.value = value;
    }
    out.children.push(atom);
  });
  return out;
}

function readConditionDraft() {
  return readConditionDraftFrom($(RULE_CONDITION_ID));
}

function ruleConditionCellHtml(rule) {
  const params = rule && rule.params && typeof rule.params === 'object' ? rule.params : {};
  const conditionId = typeof params.conditionId === 'string' ? params.conditionId : '';
  if (conditionId === '') {
    const summary = typeof rule.conditionSummary === 'string' && rule.conditionSummary !== ''
      ? rule.conditionSummary
      : (params.when !== undefined ? '（条件树读不出来：包里那一份形状不对，请重新建一条）' : '');
    return `<span class="muted">（就地拼一条）</span><br /><span class="mono">${esc(summary)}</span>`;
  }
  const item = conditionItemOf(conditionId);
  const args = params.args && typeof params.args === 'object' && !Array.isArray(params.args) ? params.args : {};
  const argText = Object.keys(args)
    .map((key) => `${key}=${Array.isArray(args[key]) ? args[key].join('/') : args[key]}`)
    .join(' · ');
  return `${esc(item ? item.name : `（目录里已经没有这条判定方式：${conditionId}）`)}`
    + `<br /><span class="mono">${esc(argText === '' ? '（不带参数）' : argText)}</span>`;
}

function ruleRowHtml(rule) {
  const pair = `${esc(rule.packId)}|${esc(rule.itemId)}`;
  const status = rule.enabled
    ? '<span class="chip ok">启用中</span>'
    : '<span class="chip warn">已停用</span>';
  return `
    <tr class="tpl-row${rule.enabled ? '' : ' off'}">
      <td>${status}</td>
      <td class="mono">${esc(rule.itemId)}</td>
      <td class="tpl-name">${esc(rule.title)}</td>
      <td>${esc(rule.severity)}</td>
      <td class="muted">${ruleConditionCellHtml(rule)}</td>
      <td class="tpl-ops">
        <button class="secondary" data-rule-edit="${pair}"
          title="编辑这条规则：标题 / 级别 / 判定方式与参数 / 判定依据 / 建议动作都可改（改的是包内容：内容指纹会变、前后指纹进审计）">编辑</button>
        <button class="${rule.enabled ? 'danger' : 'primary'}"
          data-pack-toggle="${pair}"
          data-pack-enabled="${rule.enabled ? '1' : '0'}"
          title="开关规则：只影响下一轮质控跑哪些规则，不改动任何病历（文档、留痕、签名都不受影响）"
        >${rule.enabled ? '停用' : '启用'}</button>
        <button class="danger" data-rule-delete="${pair}"
          title="删除这条规则：已有病历不受影响（质控提示是旁挂注解，仍读得出来）">删除</button>
      </td>
    </tr>`;
}

let RULE_DRAWER_OPENER = null;

function openRuleDrawer(title, desc) {
  const dialog = $('ruleDrawer');
  if (!dialog) return;
  const titleEl = $('ruleDrawerTitle');
  const descEl = $('ruleDrawerDesc');
  if (titleEl) titleEl.textContent = title;
  if (descEl) descEl.innerHTML = desc;
  RULE_DRAWER_OPENER = document.activeElement;
  dialog.showModal();
  syncTplDrawerScrollLock();
}

function closeRuleDrawer() {
  const dialog = $('ruleDrawer');
  if (dialog && dialog.open) dialog.close();
}

function bindRuleDrawerOnce() {
  const dialog = $('ruleDrawer');
  if (!dialog) return;
  dialog.addEventListener('close', () => {
    const body = $('ruleDrawerBody');
    if (body) body.innerHTML = '';
    RULE_DRAWER_ITEM = '';
    RULE_DRAWER_VIEW = '';
    syncTplDrawerScrollLock();
    if (RULE_DRAWER_OPENER && typeof RULE_DRAWER_OPENER.focus === 'function') RULE_DRAWER_OPENER.focus();
    RULE_DRAWER_OPENER = null;
  });
  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    const inBox = event.clientX >= rect.left && event.clientX <= rect.right
      && event.clientY >= rect.top && event.clientY <= rect.bottom;
    if (!inBox) closeRuleDrawer();
  });
}

function customRulePackIdOfState() {
  return String(((S || {}).knowledgePacks || {}).customPackId || '');
}

function ruleConditionOptionsHtml(selected) {
  const list = conditionItemsOfState();
  const inlineOption = `<option value=""${selected === '' ? ' selected' : ''}>（就地拼一条：不引用判定方式）</option>`;
  return inlineOption
    + list.map((item) => `<option value="${esc(item.itemId)}"${item.itemId === selected ? ' selected' : ''}>${esc(item.name)}（${esc(item.itemId)}）</option>`).join('');
}

function ruleConditionLibraryHintHtml() {
  if (conditionItemsOfState().length > 0) return '';
  return '<div class="hint">库里还没有判定方式：要么先到「基础数据 · 判定方式」里建一条'
    + '（它是一份<b>共用资产</b>：改一处、引它的规则一起变），要么就用下面那个"就地拼一条"。</div>';
}

function conditionKindOf() {
  const list = Array.isArray(S && S.qcPredicates) ? S.qcPredicates : [];
  const brief = list.find((item) => (item.params || []).some((spec) => spec.kind === 'condition-ref'));
  return brief ? String(brief.kind) : '';
}

function conditionSpecOf() {
  const list = Array.isArray(S && S.qcPredicates) ? S.qcPredicates : [];
  for (const brief of list) {
    const found = (brief.params || []).find((spec) => spec.kind === 'condition');
    if (found) return found;
  }
  return null;
}

function ruleParamsHtml(conditionId, params) {
  const values = params && typeof params === 'object' ? params : {};
  if (conditionId === '') {
    const spec = conditionSpecOf();
    if (!spec) {
      return '<div class="hint">服务端没有下发"就地拼一条条件"的参数规格（`qcPredicates` 里带 `condition` 参数的那一种判法）：'
        + '这一格渲染不出来。刷新一次；仍是空的，说明服务端与界面不是同一版。</div>';
    }
    return conditionBuilderHtml(spec, values.when);
  }
  const spec = conditionArgsSpec();
  if (!spec) {
    return '<div class="hint">服务端没有下发"判定方式实参"的参数规格（`qcPredicates` 里带 `condition-args` 参数的那一种判法）：'
      + '实参格渲染不出来。刷新一次；仍是空的，说明服务端与界面不是同一版。</div>';
  }
  return conditionArgsHtml(spec, conditionId, { conditionId, args: ruleArgValuesOf(values) });
}

function ruleLegacyParamsHtml(params) {
  const source = params && typeof params === 'object' ? params : {};
  const parts = Object.keys(source).map((key) => `<span class="mono">${esc(key)}=`
    + `${esc(Array.isArray(source[key]) ? source[key].join('/') : String(source[key]))}</span>`);
  return `<div class="muted">原来那一套参数：${parts.length === 0 ? '（无）' : parts.join(' · ')}</div>`;
}

function readRuleLegacy(box) {
  const raw = box && box.dataset ? box.dataset.ruleLegacy : '';
  if (typeof raw !== 'string' || raw === '') return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed.kind === 'string' && parsed.kind !== '' ? parsed : null;
  } catch {
    return null;
  }
}

function renderRuleForm(seed) {
  const box = $('ruleDrawerBody');
  if (!box) return;
  const creating = seed.itemId === '';
  const legacyKind = typeof seed.legacyKind === 'string' ? seed.legacyKind : '';
  if (legacyKind === '') delete box.dataset.ruleLegacy;
  else box.dataset.ruleLegacy = JSON.stringify({ kind: legacyKind, params: seed.params || {} });
  const legacyOption = legacyKind === ''
    ? ''
    : `<option value="${esc(legacyKind)}" selected>（旧形态：内核判法「${esc(legacyKind)}」—— 它不再作为可选"判定方式"出现）</option>`;
  box.innerHTML = `
    <div class="tpl-edit-box">
      <div class="tpl-field">
        <span class="tpl-label">规则号</span>
        <div class="mono">${creating ? '（保存后由系统生成，形如 R-CUSTOM-1）' : esc(seed.itemId)}</div>
      </div>
      <div class="tpl-field">
        <span class="tpl-label">标题</span>
        <input type="text" data-rule-input="title" value="${esc(seed.title)}"
          placeholder="如：病程记录缺少记录时间" title="质控清单与医生端提示里显示的那一行" />
      </div>
      <div class="tpl-field">
        <span class="tpl-label">级别</span>
        <select data-rule-input="severity">
          <option value="info"${seed.severity === 'info' ? ' selected' : ''}>info（提示：只提示，不影响任何流程）</option>
          <option value="warn"${seed.severity === 'info' ? '' : ' selected'}>warn（警告：需要处理）</option>
        </select>
      </div>
      <div class="tpl-field">
        <span class="tpl-label">判定方式</span>
        <select data-rule-input="conditionId">
          ${legacyOption}${ruleConditionOptionsHtml(seed.conditionId)}
        </select>
        ${legacyKind === '' ? ruleConditionLibraryHintHtml() : ''}
      </div>
      <div id="ruleParams">${legacyKind === '' ? ruleParamsHtml(seed.conditionId, seed.params) : ruleLegacyParamsHtml(seed.params)}</div>
      <div class="tpl-field">
        <span class="tpl-label">判定依据（留空 = 用内置文案）</span>
        <textarea data-rule-input="detail" rows="3" placeholder="写给医生看的「判定依据」；留空则用该判定方式内置的那一句">${esc(seed.detail)}</textarea>
      </div>
      <div class="tpl-field">
        <span class="tpl-label">建议动作（留空 = 用内置文案）</span>
        <textarea data-rule-input="suggestion" rows="2" placeholder="希望医生接下来做什么；留空则用内置的那一句">${esc(seed.suggestion)}</textarea>
      </div>
      <div class="form-actions">
        <button class="primary" data-rule-submit="${creating ? 'create' : 'update'}">${creating ? '建为停用' : '保存'}</button>
        <button class="secondary" data-rule-cancel="1">取消</button>
      </div>
    </div>`;
}

function renderRuleEditForm(item) {
  RULE_DRAWER_VIEW = 'rule-edit';
  RULE_DRAWER_ITEM = item.itemId;
  const params = item.params && typeof item.params === 'object' ? item.params : {};
  const conditionId = typeof params.conditionId === 'string' ? params.conditionId : '';
  openRuleDrawer(
    `编辑：${item.title}`,
    '',
  );
  renderRuleForm({
    itemId: item.itemId,
    title: item.title || '',
    severity: item.severity === 'info' ? 'info' : 'warn',
    conditionId,
    params,
    legacyKind: params.conditionId === undefined && params.when === undefined && item.predicate
      ? String(item.predicate)
      : '',
    detail: item.detail || '',
    suggestion: item.suggestion || '',
  });
}

function renderRuleCreateForm() {
  RULE_DRAWER_VIEW = 'rule-create';
  RULE_DRAWER_ITEM = '';
  const first = conditionItemsOfState()[0];
  openRuleDrawer(
    '新建规则',
    '',
  );
  renderRuleForm({
    itemId: '',
    title: '',
    severity: 'warn',
    conditionId: first ? String(first.itemId) : '',
    params: {},
    legacyKind: '',
    detail: '',
    suggestion: '',
  });
}

function readRuleForm() {
  const box = $('ruleDrawerBody');
  const out = {
    title: '', severity: 'warn', kind: '', conditionId: '', params: {}, detail: '', suggestion: '',
    conditionLocked: false, conditionPending: false,
  };
  if (!box) return out;
  box.querySelectorAll('[data-rule-input]').forEach((el) => {
    const key = el.dataset.ruleInput;
    if (key === 'title') out.title = el.value;
    else if (key === 'severity') out.severity = el.value;
    else if (key === 'conditionId') out.conditionId = String(el.value || '');
    else if (key === 'detail') out.detail = el.value;
    else if (key === 'suggestion') out.suggestion = el.value;
  });
  const legacy = readRuleLegacy(box);
  if (legacy && out.conditionId === legacy.kind) {
    out.kind = legacy.kind;
    out.params = legacy.params;
    return out;
  }
  out.kind = conditionKindOf();
  if (out.conditionId !== '') {
    out.params.conditionId = out.conditionId;
    box.querySelectorAll('[data-rule-arg]').forEach((el) => {
      const name = el.dataset.ruleArg;
      if (!name) return;
      const raw = String(el.value === undefined || el.value === null ? '' : el.value).trim();
      if (raw === '') return;
      if (!out.params.args || typeof out.params.args !== 'object' || Array.isArray(out.params.args)) out.params.args = {};
      const spec = ruleArgSpecOf(out.conditionId, name);
      if (spec && spec.kind === 'integer') {
        const value = Number(raw);
        if (!Number.isFinite(value)) return;
        out.params.args[name] = Math.trunc(value);
        return;
      }
      if (spec && spec.kind === 'boolean') {
        if (raw === 'true' || raw === 'false') out.params.args[name] = raw === 'true';
        return;
      }
      if (spec && spec.kind === 'string-list') {
        const words = raw.split(/[,，、;；]/).map((part) => part.trim()).filter((part) => part !== '');
        if (words.length > 0) out.params.args[name] = words;
        return;
      }
      out.params.args[name] = raw;
    });
    return out;
  }
  const conditionBox = $(RULE_CONDITION_ID);
  if (conditionBox) {
    out.conditionLocked = conditionBox.dataset.condLocked === '1';
    if (!out.conditionLocked) {
      const condition = readConditionDraft(conditionBox);
      if (condition.children.length > 0) out.params.when = condition;
      else out.conditionPending = true;
    }
  }
  return out;
}

function renderRuleConditionSwitch(conditionId) {
  const box = $('ruleDrawerBody');
  const params = $(RULE_PARAMS_ID);
  const legacy = readRuleLegacy(box);
  if (legacy && conditionId === legacy.kind) {
    if (params) params.innerHTML = ruleLegacyParamsHtml(legacy.params);
    return;
  }
  if (params) params.innerHTML = ruleParamsHtml(conditionId, {});
}

const TPL_FIELD_TYPES = ['text', 'number', 'date', 'code', 'boolean'];

let TPL_DRAWER_ITEM = '';
let TPL_DRAWER_OPENER = null;
let TPL_DRAWER_OPENER2 = null;

function tplDrawerRefOf(level) {
  return level === 2
    ? { level: 2, dialog: 'tplDrawer2', title: 'tplDrawer2Title', desc: 'tplDrawer2Desc', body: 'tplDrawer2Body' }
    : { level: 1, dialog: 'tplDrawer', title: 'tplDrawerTitle', desc: 'tplDrawerDesc', body: 'tplDrawerBody' };
}

let TPL_FORM_LEVEL = 1;
let TPL_DRAWER_VIEW = '';

function tplDrawerBodyId() {
  return tplDrawerRefOf(TPL_FORM_LEVEL).body;
}

function openTplDrawer(title, desc, level) {
  const ref = tplDrawerRefOf(level);
  const dialog = $(ref.dialog);
  if (!dialog) return;
  const titleEl = $(ref.title);
  const descEl = $(ref.desc);
  if (titleEl) titleEl.textContent = title;
  if (descEl) descEl.innerHTML = desc;
  TPL_FORM_LEVEL = ref.level;
  if (ref.level === 2) TPL_DRAWER_OPENER2 = document.activeElement;
  else TPL_DRAWER_OPENER = document.activeElement;
  dialog.showModal();
  syncTplDrawerScrollLock();
}

function closeTplDrawer(level) {
  const dialog = $(tplDrawerRefOf(level || TPL_FORM_LEVEL).dialog);
  if (dialog && dialog.open) dialog.close();
}

function syncTplDrawerScrollLock() {
  const ids = [tplDrawerRefOf(1).dialog, tplDrawerRefOf(2).dialog, 'ruleDrawer', 'conditionDrawer'];
  const anyOpen = ids.some((id) => {
    const dialog = $(id);
    return Boolean(dialog && dialog.open);
  });
  if (anyOpen) document.documentElement.classList.add('drawer-open');
  else document.documentElement.classList.remove('drawer-open');
}

function bindTplDrawerOnce() {
  for (const level of [1, 2]) {
    const ref = tplDrawerRefOf(level);
    const dialog = $(ref.dialog);
    if (!dialog) continue;
    dialog.addEventListener('close', () => {
      const body = $(ref.body);
      if (body) body.innerHTML = '';
      if (ref.level === 1) {
        TPL_DRAWER_ITEM = '';
        TPL_DRAWER_VIEW = '';
        const second = $(tplDrawerRefOf(2).dialog);
        if (second && second.open) second.close();
      }
      TPL_FORM_LEVEL = 1;
      syncTplDrawerScrollLock();
      /* 焦点还回触发按钮：否则关闭后焦点落在 body 上，键盘用户要重新从头 tab */
      if (ref.level === 2) {
        if (TPL_DRAWER_OPENER2 && typeof TPL_DRAWER_OPENER2.focus === 'function') TPL_DRAWER_OPENER2.focus();
        TPL_DRAWER_OPENER2 = null;
      } else {
        if (TPL_DRAWER_OPENER && typeof TPL_DRAWER_OPENER.focus === 'function') TPL_DRAWER_OPENER.focus();
        TPL_DRAWER_OPENER = null;
      }
    });
    dialog.addEventListener('click', (event) => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      const inBox = event.clientX >= rect.left && event.clientX <= rect.right
        && event.clientY >= rect.top && event.clientY <= rect.bottom;
      if (!inBox) closeTplDrawer(ref.level);
    });
  }
}

let TPL_NAME_FILTER = '';
let TPL_PAGE = 1;
const TPL_PAGE_SIZE = 10;

function renderTemplatePacks() {
  const entries = Array.isArray(S.templateCatalog) ? S.templateCatalog : [];
  const templates = entries.filter((item) => item.itemType === 'template');
  const keyword = TPL_NAME_FILTER.trim().toLowerCase();
  const shown = keyword === ''
    ? templates
    : templates.filter((item) => String(item.name || '').toLowerCase().includes(keyword));

  const box = $('tplPackItems');
  if (!box) return;
  const fragHtml = tplFragmentsHtml(entries);
  if (templates.length === 0) {
    box.innerHTML = `<div class="muted">模板库是空的：点上面「新建文书」建第一份（建出来是<b>草稿</b>，发布之后医生端才能照着它开）。</div>${fragHtml}`;
    return;
  }
  if (shown.length === 0) {
    box.innerHTML = `<div class="muted">没有名称含「${esc(TPL_NAME_FILTER.trim())}」的模板（库里共 ${templates.length} 份）。清空查询条件即可看全部。</div>${fragHtml}`;
    return;
  }
  const pageCount = Math.max(1, Math.ceil(shown.length / TPL_PAGE_SIZE));
  if (TPL_PAGE > pageCount) TPL_PAGE = pageCount;
  if (TPL_PAGE < 1) TPL_PAGE = 1;
  const start = (TPL_PAGE - 1) * TPL_PAGE_SIZE;
  const pageRows = shown.slice(start, start + TPL_PAGE_SIZE);
  box.innerHTML = `
    <table class="mini tpl-table">
      <thead><tr>
        <th>状态</th><th>模板名称</th><th>文书类型</th><th>章节 / 槽位</th><th>适用科室</th><th>操作</th>
      </tr></thead>
      <tbody>${pageRows.map((item) => tplRowHtml(item)).join('')}</tbody>
    </table>
    <div class="tpl-pager">
      <span class="muted">第 ${TPL_PAGE} / ${pageCount} 页 · 本页 ${pageRows.length} 份
        （共 ${shown.length} 份，每页 ${TPL_PAGE_SIZE} 份）</span>
      <span class="tpl-pager-btns">
        <button class="secondary" data-tpl-page="${TPL_PAGE - 1}" ${TPL_PAGE <= 1 ? 'disabled' : ''}
          title="上一页（只翻这一页的表，不重新拉库里那份目录）">上一页</button>
        <button class="secondary" data-tpl-page="${TPL_PAGE + 1}" ${TPL_PAGE >= pageCount ? 'disabled' : ''}
          title="下一页（只翻这一页的表，不重新拉库里那份目录）">下一页</button>
      </span>
    </div>${fragHtml}`;
}

function tplGotoItemPage(itemId) {
  if (TPL_NAME_FILTER.trim() !== '') return;
  const templates = (Array.isArray(S && S.templateCatalog) ? S.templateCatalog : [])
    .filter((item) => item.itemType === 'template');
  const index = templates.findIndex((item) => item.itemId === itemId);
  if (index < 0) return;
  TPL_PAGE = Math.floor(index / TPL_PAGE_SIZE) + 1;
}

function tplRowHtml(item) {
  const draft = item.status === 'draft';
  const deptCodes = item.departments || [];
  const departments = deptCodes.length === 0 ? '通用' : (item.departmentNames || deptCodes).join('、');
  const status = draft
    ? '<span class="chip warn">草稿</span>'
    : item.enabled
      ? '<span class="chip ok">启用中</span>'
      : '<span class="chip">已停用</span>';
  const sections = Array.isArray(item.sections) ? item.sections : [];
  const slots = sections.reduce((sum, section) => sum + ((section.slots || []).length), 0);
  const used = Array.isArray(item.controls) ? item.controls.length : 0;
  const pair = `${esc(item.packId)}|${esc(item.itemId)}`;
  return `
    <tr class="tpl-row${item.openable ? '' : ' off'}">
      <td>${status}</td>
      <td class="tpl-name">${esc(item.name)}</td>
      <td>${esc((item.docType && item.docType.display) || '（未标类型）')}</td>
      <td class="muted">${sections.length} 章 / ${slots} 槽位${used > 0 ? ` · 引用 ${used} 个控件` : ''}</td>
      <td>${esc(departments)}</td>
      <td class="tpl-ops">
        <button class="secondary" data-tpl-preview="${pair}"
          title="预览：按当前患者与就诊的上下文试开一份，看医生点开之后是什么样子（不落库、不改任何病历）">预览</button>
        <button class="secondary" data-tpl-edit="${pair}"
          title="编辑：名称与适用科室随时可改；章节与槽位只有草稿能改">编辑</button>
        <button class="secondary" data-tpl-duplicate="${pair}"
          title="复制一份：从这一份出发改，而不是从零拼。副本进本院自建包、恒为草稿，它用到的表达式控件会一起带过来（模板用到的控件必须与模板同包）">复制</button>
        ${draft
          ? `<button class="primary" data-tpl-status="${pair}" data-tpl-to="active"
               title="发布：发布之后医生端才能照着它开文书（发布是一次显式动作，不随保存悄悄上线）">发布</button>`
          : `<button class="${item.enabled ? 'danger' : 'primary'}" data-pack-toggle="${pair}"
               data-pack-enabled="${item.enabled ? '1' : '0'}"
               title="开关文书：只影响还能不能开这一份，不改动任何已有病历（文档、留痕、签名都不受影响）"
             >${item.enabled ? '停用' : '启用'}</button>
             <button class="secondary" data-tpl-status="${pair}" data-tpl-to="draft"
               title="撤稿：撤稿后医生端**立刻开不出它**。要改章节与槽位，必须先撤稿">撤稿</button>`}
        <button class="danger" data-tpl-delete="${pair}"
          title="删除这份文书：已开出的病历不受影响（它们只带着模板指纹）">删除</button>
      </td>
    </tr>`;
}

function tplFragmentsHtml(entries) {
  const fragments = (Array.isArray(entries) ? entries : []).filter((item) => item.itemType === 'fragment');
  if (fragments.length === 0) {
    return `
      <div class="tpl-sep"></div>
      <div class="cfg-head"><b>章节片段</b><span class="chip">还没攒下第一段</span></div>
      <div class="muted">片段是"一串章节"的素材：在任意一份文书里点某一章上的「存为片段」就能攒出第一段，
        之后别的文书可以一次插进来（插入是<b>复制</b>，不是引用）。</div>`;
  }
  return `
    <div class="tpl-sep"></div>
    <div class="cfg-head"><b>章节片段</b><span class="chip">${fragments.length} 段</span></div>
    <table class="mini tpl-table">
      <thead><tr>
        <th>片段名称</th><th>规模</th><th>说明</th><th>操作</th>
      </tr></thead>
      <tbody>${fragments.map((item) => tplFragRowHtml(item)).join('')}</tbody>
    </table>
    <div class="muted">插入片段 = 把它的章节<b>复制</b>进那份文书，之后两者再无联系：
      改一段片段<b>不会</b>改动已经用它拼好的文书，也不会改动任何已开出的病历。
      要让那些文书跟着更新，得在那份文书里重新插一次。</div>`;
}

function tplFragRowHtml(item) {
  const sections = Array.isArray(item.sections) ? item.sections : [];
  const slots = sections.reduce((sum, section) => sum + ((section.slots || []).length), 0);
  const pair = `${esc(item.packId)}|${esc(item.itemId)}`;
  return `
    <tr class="tpl-row">
      <td class="tpl-name">${esc(item.name)}</td>
      <td class="muted">${sections.length} 章 / ${slots} 槽位</td>
      <td class="muted">${esc(item.description || '（没写说明）')}</td>
      <td class="tpl-ops">
        <button class="secondary" data-tpl-frag-edit="${pair}"
          title="编辑这一段：片段随时可改（它没有「已发布」这个概念）">编辑</button>
        <button class="danger" data-tpl-frag-delete="${pair}"
          title="删除这一段：用这个片段拼好的文书一个字都不会变（插入是复制，不是引用）">删除</button>
      </td>
    </tr>`;
}

async function openTplPreview(itemId) {
  const item = tplItemOf(itemId);
  TPL_DRAWER_VIEW = 'preview';
  openTplDrawer(`预览：${item ? item.name : itemId}`, '');
  const box = $(tplDrawerBodyId());
  if (box) box.innerHTML = '<div class="muted">正在试开…</div>';
  const r = await api('/api/template-preview', { templateId: itemId });
  const dialog = $('tplDrawer');
  if (!dialog || !dialog.open || TPL_DRAWER_VIEW !== 'preview') return;
  if (!r || !r.ok) {
    if (box) box.innerHTML = `<div class="muted">预览失败：${esc((r && (r.message || r.code)) || '未知原因')}</div>`;
    return;
  }
  renderTplPreview(r.data || {});
}

function renderTplPreview(data) {
  const box = $(tplDrawerBodyId());
  if (!box) return;
  const sections = Array.isArray(data.sections) ? data.sections : [];
  const warnings = Array.isArray(data.warnings) ? data.warnings : [];
  const slotCount = sections.reduce((sum, section) => sum + ((section.slots || []).length), 0);
  const deptNames = (Array.isArray(data.departmentNames) ? data.departmentNames : []).join('、');
  const status = data.status === 'draft'
    ? ['草稿', 'warn']
    : data.enabled === false
      ? ['已停用', 'warn']
      : ['启用中', 'ok'];
  const deptNote = data.departments && data.departments.length > 0
    ? data.deptApplicable
      ? `限 ${esc(deptNames)}；本次就诊是 ${esc(data.visitDeptName || '（无科室）')}：开得出`
      : data.visitDeptName
        ? `限 ${esc(deptNames)}；本次就诊是 ${esc(data.visitDeptName)}：<b>现在开不出来</b>（换一份文书，或在「编辑」里放开科室）`
        : `限 ${esc(deptNames)}；本次就诊<b>没有科室信息</b>：现在开不出来（先补就诊科室，或改成通用）`
    : `通用：任何科室都能开${data.visitDeptName ? `（本次就诊：${esc(data.visitDeptName)}）` : ''}`;

  const items = Array.isArray(data.items) ? data.items : [];
  const bodyHtml = L0DocView.nodesHtml(items, {
    readonly: true,
    readonlyHint: '这是预览：按当前患者与就诊试开的一份，没有落库，也改不了',
    clinical: true,
    annotations: [],
  });
  const checkHtml = sections.map((section) => `
    <div class="pv-check-sec">
      <div class="mono">${esc(section.sectionCode)} · ${esc(section.title)}</div>
      <ul class="pv-check-list">
        ${(section.slots || []).map((slot) => `<li>
          <span class="mono">${esc(slot.key)}</span>
          <span class="muted">${esc(slot.detail || '')}</span>
          ${slot.filled ? `<b>${esc(slot.value)}${esc(slot.unit || '')}</b>` : '<span class="muted">（待填）</span>'}
        </li>`).join('') || '<li class="muted">这一章没有任何槽位</li>'}
      </ul>
    </div>`).join('');

  box.innerHTML = `
    <div class="tpl-preview">
      <div class="pv-head">${chips([
        ['文书类型', (data.docType && data.docType.display) || '（未标类型）'],
        ['规模', `${sections.length} 章 / ${slotCount} 槽位`, 'mono'],
        ['状态', status[0], status[1]],
        ['出处', data.source, 'mono'],
      ])}</div>
      <div class="pv-dept${data.departments && data.departments.length > 0 && !data.deptApplicable ? ' warn' : ''}">${deptNote}</div>
      ${warnings.length === 0
        ? '<div class="hint">试开通过：没有待补项，医生点开会拿到一份结构完整的草稿。</div>'
        : `<div class="hint"><b>试开出来有 ${warnings.length} 处待补</b>：`
          + '<ul class="pv-warn">' + warnings.map((text) => `<li>${esc(text)}</li>`).join('') + '</ul></div>'}
      <div class="doc">${bodyHtml}</div>
      <details class="pv-check">
        <summary>核对信息：${sections.length} 章 / ${slotCount} 槽位（章节编码 · 槽位名 · 这一格是什么 · 试开取值）</summary>
        ${checkHtml}
      </details>
    </div>`;
}

let EXPR_NAME_FILTER = '';
let EXPR_PAGE = 1;
const EXPR_PAGE_SIZE = 10;

function renderExprCatalogShell() {
  const box = $('exprCatalogBody');
  if (!box) return;
  box.innerHTML = `
    <div class="row tpl-toolbar">
      <span>控件名称</span>
      <input type="search" id="exprSearchName" value="${esc(EXPR_NAME_FILTER)}"
        placeholder="按名称筛选（不区分大小写）" title="按控件名称筛：留空 = 全列。" />
    </div>
    <div id="exprCatalogTable"></div>`;
  renderExprCatalog();
}

function renderExprCatalog() {
  const box = $('exprCatalogTable');
  if (!box) { renderExprCatalogShell(); return; }
  const controls = (Array.isArray(S.templateCatalog) ? S.templateCatalog : [])
    .filter((item) => item.itemType === 'expression');
  const keyword = EXPR_NAME_FILTER.trim().toLowerCase();
  const shown = keyword === ''
    ? controls
    : controls.filter((item) => String(item.name || '').toLowerCase().includes(keyword));

  const summary = $('exprCatalogSummary');
  if (summary) {
    summary.textContent = `共 ${controls.length} 个` + (keyword === '' ? '' : `，筛出 ${shown.length} 个`);
  }
  if (controls.length === 0) {
    box.innerHTML = '<div class="muted">还没有任何表达式控件。建好之后，文书的槽位里就能选它。</div>';
    return;
  }
  /* 筛空了要分开说：与模板表同一口径，否则"条件把库筛空了"会被读成"控件没了" */
  if (shown.length === 0) {
    box.innerHTML = `<div class="muted">没有名称含「${esc(EXPR_NAME_FILTER.trim())}」的控件（库里共 ${controls.length} 个）。清空查询条件即可看全部。</div>`;
    return;
  }
  const pageCount = Math.max(1, Math.ceil(shown.length / EXPR_PAGE_SIZE));
  if (EXPR_PAGE > pageCount) EXPR_PAGE = pageCount;
  if (EXPR_PAGE < 1) EXPR_PAGE = 1;
  const start = (EXPR_PAGE - 1) * EXPR_PAGE_SIZE;
  const pageRows = shown.slice(start, start + EXPR_PAGE_SIZE);
  const rows = pageRows.map((item) => `
    <tr class="tpl-row${item.enabled ? '' : ' off'}">
      <td class="tpl-name">${esc(item.name)}</td>
      <td class="tpl-formula">${esc(item.detail)}</td>
      <td>${item.enabled ? '<span class="chip ok">启用中</span>' : '<span class="chip">已停用</span>'}</td>
      <td class="tpl-ops">
        <button class="secondary" data-expr-edit="${esc(item.packId)}|${esc(item.itemId)}"
          title="编辑这个控件：名称 / 单位 / 说明 / 公式（公式改了，已开出的病历不会自动重算）">编辑</button>
        <button class="${item.enabled ? 'danger' : 'primary'}"
          data-pack-toggle="${esc(item.packId)}|${esc(item.itemId)}"
          data-pack-enabled="${item.enabled ? '1' : '0'}"
          title="开关表达式控件：只影响它是否出现在可用控件清单里（实例化与重算按包内那一份公式执行）"
        >${item.enabled ? '停用' : '启用'}</button>
        <button class="danger" data-expr-delete="${esc(item.packId)}|${esc(item.itemId)}"
          title="删除这个控件：还被文书引用时会被拒绝（并列出是哪些文书在用）">删除</button>
      </td>
    </tr>`).join('');
  box.innerHTML = `
    <table class="mini tpl-table">
      <thead><tr><th>控件名称</th><th>公式</th><th>状态</th><th>操作</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="tpl-pager">
      <span class="muted">第 ${EXPR_PAGE} / ${pageCount} 页 · 本页 ${pageRows.length} 个
        （共 ${shown.length} 个，每页 ${EXPR_PAGE_SIZE} 个）</span>
      <span class="tpl-pager-btns">
        <button class="secondary" data-expr-page="${EXPR_PAGE - 1}" ${EXPR_PAGE <= 1 ? 'disabled' : ''}
          title="上一页（只翻这一张表，不重新拉库里那份目录）">上一页</button>
        <button class="secondary" data-expr-page="${EXPR_PAGE + 1}" ${EXPR_PAGE >= pageCount ? 'disabled' : ''}
          title="下一页（只翻这一张表，不重新拉库里那份目录）">下一页</button>
      </span>
    </div>`;
}

function exprGotoItemPage(itemId) {
  if (EXPR_NAME_FILTER.trim() !== '') return;
  const controls = (Array.isArray(S && S.templateCatalog) ? S.templateCatalog : [])
    .filter((item) => item.itemType === 'expression');
  const index = controls.findIndex((item) => item.itemId === itemId);
  if (index < 0) return;
  EXPR_PAGE = Math.floor(index / EXPR_PAGE_SIZE) + 1;
}

function refreshExprCatalog() {
  if ($('exprCatalogTable')) renderExprCatalog();
}

const CTRL_SHAPE_LABELS = {
  scale: '量表评分',
  series: '时序（趋势）',
  matrix: '行列表',
  checklist: '勾选清单',
  image: '影像',
};

let CTRL_NAME_FILTER = '';
let CTRL_PAGE = 1;
const CTRL_PAGE_SIZE = 10;

function renderCtrlCatalogShell() {
  const box = $('ctrlCatalogBody');
  if (!box) return;
  box.innerHTML = `
    <div class="row tpl-toolbar">
      <span>控件名称</span>
      <input type="search" id="ctrlSearchName" value="${esc(CTRL_NAME_FILTER)}"
        placeholder="按名称筛选（不区分大小写）" title="按控件名称筛：留空 = 全列。" />
    </div>
    <div id="ctrlCatalogTable"></div>`;
  renderCtrlCatalog();
}

function ctrlCatalogItems() {
  return (Array.isArray((S || {}).templateCatalog) ? S.templateCatalog : [])
    .filter((item) => item.itemType === 'control');
}

async function openCtrlPreview(itemId) {
  const item = tplItemOf(itemId);
  CTRL_EDIT_ID = '';
  CTRL_DRAFT = null;
  openTplDrawer(`预览：${item ? item.name : itemId}`, '', 2);
  const box = $(tplDrawerBodyId());
  if (box) box.innerHTML = '<div class="muted">正在生成…</div>';
  const r = await api('/api/control-preview', { itemId });
  const dialog = $(tplDrawerRefOf(2).dialog);
  if (!dialog || !dialog.open || CTRL_DRAFT !== null) return;
  if (!r || !r.ok) {
    if (box) box.innerHTML = `<div class="muted">预览失败：${esc((r && (r.message || r.code)) || '未知原因')}</div>`;
    return;
  }
  renderCtrlPreview(r.data || {});
}

function renderCtrlPreview(data) {
  const box = $(tplDrawerBodyId());
  if (!box) return;
  const items = Array.isArray(data.items) ? data.items : [];
  const cells = items.reduce((sum, item) => sum + (Array.isArray(item.cells) ? item.cells.length : 0), 0);
  const warnings = Array.isArray(data.warnings) ? data.warnings : [];
  const bodyHtml = L0DocView.nodesHtml(items, {
    readonly: true,
    readonlyHint: '这是预览：按当前患者试开的一份，没有落库，也改不了',
    clinical: true,
    annotations: [],
  });
  box.innerHTML = `
    <div class="tpl-preview">
      <div class="pv-head">${chips([
        ['形状', CTRL_SHAPE_LABELS[data.shape] || String(data.shape || '—')],
        ['规模', `${cells} 格`, 'mono'],
        ['状态', data.enabled === false ? '已停用' : '启用中', data.enabled === false ? 'warn' : 'ok'],
        ['出处', data.source || '', 'mono'],
      ])}</div>
      ${warnings.length === 0
        ? ''
        : `<div class="hint"><b>试开出来有 ${warnings.length} 处提示</b>：`
          + '<ul class="pv-warn">' + warnings.map((text) => `<li>${esc(text)}</li>`).join('') + '</ul></div>'}
      <div class="doc">${bodyHtml}</div>
    </div>`;
}

function renderCtrlCatalog() {
  const box = $('ctrlCatalogTable');
  if (!box) { renderCtrlCatalogShell(); return; }
  const controls = ctrlCatalogItems();
  const keyword = CTRL_NAME_FILTER.trim().toLowerCase();
  const shown = keyword === ''
    ? controls
    : controls.filter((item) => String(item.name || '').toLowerCase().includes(keyword));

  const summary = $('ctrlCatalogSummary');
  if (summary) {
    summary.textContent = `共 ${controls.length} 个` + (keyword === '' ? '' : `，筛出 ${shown.length} 个`);
  }
  if (controls.length === 0) {
    box.innerHTML = '<div class="muted">还没有任何专科控件。本系统<b>不预置内置控件</b>'
      + '（随产品发版的是形状：量表评分 / 时序 / 行列表 / 勾选清单），控件由本院按专科自建。</div>';
    return;
  }
  /* 筛空了要分开说：与模板表同一口径，否则"条件把库筛空了"会被读成"控件没了" */
  if (shown.length === 0) {
    box.innerHTML = `<div class="muted">没有名称含「${esc(CTRL_NAME_FILTER.trim())}」的控件（库里共 ${controls.length} 个）。清空查询条件即可看全部。</div>`;
    return;
  }
  const pageCount = Math.max(1, Math.ceil(shown.length / CTRL_PAGE_SIZE));
  if (CTRL_PAGE > pageCount) CTRL_PAGE = pageCount;
  if (CTRL_PAGE < 1) CTRL_PAGE = 1;
  const start = (CTRL_PAGE - 1) * CTRL_PAGE_SIZE;
  const pageRows = shown.slice(start, start + CTRL_PAGE_SIZE);
  const rows = pageRows.map((item) => `
    <tr class="tpl-row${item.enabled ? '' : ' off'}">
      <td class="tpl-name">${esc(item.name)}${item.description ? `<div class="muted">${esc(item.description)}</div>` : ''}</td>
      <td>${esc(CTRL_SHAPE_LABELS[item.shape] || String(item.shape || '—'))}</td>
      <td>${Array.isArray(item.fields) ? item.fields.length : 0} 格${item.controlVersion && item.controlVersion > 1 ? ` · 定义 v${item.controlVersion}` : ''}</td>
      <td>${item.enabled ? '<span class="chip ok">启用中</span>' : '<span class="chip">已停用</span>'}</td>
      <td class="tpl-ops">
        <button class="secondary" data-ctrl-preview="${esc(item.packId)}|${esc(item.itemId)}"
          title="预览这个控件在医生端的样子：按当前患者试开一次（不落库）—— 形状决定画法，所以看到的就是医生那一屏">预览</button>
        <button class="secondary" data-ctrl-edit="${esc(item.packId)}|${esc(item.itemId)}"
          title="编辑这个控件：名称 / 语义类型 / 形状 / 说明 / 字段（改到字段或形状，服务端会把定义升一版 —— 已开出的病历存着当时那份字段快照，不受影响）">编辑</button>
        <button class="${item.enabled ? 'danger' : 'primary'}"
          data-pack-toggle="${esc(item.packId)}|${esc(item.itemId)}"
          data-pack-enabled="${item.enabled ? '1' : '0'}"
          title="开关专科控件：只影响它还能不能被新建的病历选用；已开出的病历存的是当时的字段快照，不受影响"
        >${item.enabled ? '停用' : '启用'}</button>
        <button class="danger" data-ctrl-delete="${esc(item.packId)}|${esc(item.itemId)}"
          title="删除这个控件：没有撤销。已开出的病历带的是当时那份字段快照，不受影响">删除</button>
      </td>
    </tr>`).join('');
  box.innerHTML = `
    <table class="mini tpl-table">
      <thead><tr><th>控件名称</th><th>形态</th><th>字段</th><th>状态</th><th>操作</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="tpl-pager">
      <span class="muted">第 ${CTRL_PAGE} / ${pageCount} 页 · 本页 ${pageRows.length} 个
        （共 ${shown.length} 个，每页 ${CTRL_PAGE_SIZE} 个）</span>
      <span class="tpl-pager-btns">
        <button class="secondary" data-ctrl-page="${CTRL_PAGE - 1}" ${CTRL_PAGE <= 1 ? 'disabled' : ''}
          title="上一页（只翻这一张表，不重新拉库里那份目录）">上一页</button>
        <button class="secondary" data-ctrl-page="${CTRL_PAGE + 1}" ${CTRL_PAGE >= pageCount ? 'disabled' : ''}
          title="下一页（只翻这一张表，不重新拉库里那份目录）">下一页</button>
      </span>
    </div>`;
}

function refreshCtrlCatalog() {
  if ($('ctrlCatalogTable')) renderCtrlCatalog();
}

const CTRL_KIND_LABELS = {
  menstrualHistory: '月经史',
  odontogram: '牙位图',
  vitalSignsChart: '生命体征单',
  scaleScore: '量表评分',
  labTrend: '化验趋势',
  custom: '其他（自定义）',
};

const CTRL_FIELD_TYPES = [...TPL_FIELD_TYPES, 'expression'];

let CTRL_EDIT_ID = '';
let CTRL_DRAFT = null;
let CTRL_BASELINE = '';

function ctrlSemanticSignature(draft) {
  return JSON.stringify({
    controlKind: draft.controlKind,
    shape: draft.shape,
    fields: draft.fields,
    rows: draft.shape === 'matrix' ? draft.rows : null,
    columns: draft.shape === 'matrix' ? draft.columns : null,
  });
}

/** 深拷贝一份 JSON 值：草稿与目录必须互不影响（改了草稿不该动到库里那一份） */
function cloneOf(value) {
  return JSON.parse(JSON.stringify(value === undefined ? null : value));
}

function emptyCtrlDraft() {
  return {
    packId: '',
    name: '',
    controlKind: 'custom',
    shape: 'scale',
    description: '',
    fields: [{ key: '', label: '', dataType: 'number' }],
    rows: [],
    columns: [],
  };
}

function ctrlDraftOf(item) {
  return {
    packId: String(item.packId ?? ''),
    name: String(item.name ?? ''),
    controlKind: String(item.controlKind ?? 'custom'),
    shape: String(item.shape ?? 'scale'),
    description: String(item.description ?? ''),
    fields: cloneOf(Array.isArray(item.fields) ? item.fields : []),
    rows: cloneOf(Array.isArray(item.rows) ? item.rows : []),
    columns: cloneOf(Array.isArray(item.columns) ? item.columns : []),
  };
}

function keyLabelText(list) {
  return (Array.isArray(list) ? list : [])
    .map((item) => `${item.key ?? ''}${item.label ? `=${item.label}` : ''}`)
    .join('\n');
}

function parseKeyLabel(text) {
  return String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => {
      const cut = line.indexOf('=');
      const key = (cut < 0 ? line : line.slice(0, cut)).trim();
      const label = cut < 0 ? '' : line.slice(cut + 1).trim();
      return { key, label: label === '' ? key : label };
    });
}

function valueSetText(list) {
  return (Array.isArray(list) ? list : [])
    .map((item) => `${item.code ?? ''}${item.display ? `=${item.display}` : ''}`)
    .join('\n');
}

function parseValueSet(text) {
  return parseKeyLabel(text).map((pair) => ({ code: pair.key, ...(pair.label === pair.key ? {} : { display: pair.label }) }));
}

function ctrlDefaultValueHtml(field, index) {
  const dataType = String(field.dataType ?? 'text');
  const value = field.defaultValue;
  const tip = '开文书时这一格预填成什么。控件不编临床内容：留空 = 空着等医生填';
  if (dataType === 'expression') return '<span class="muted">由公式算出来，不预设默认值</span>';
  if (dataType === 'boolean') {
    const current = value === true ? 'true' : value === false ? 'false' : '';
    return `<select data-ctrl-field="${index}:defaultValue" title="${esc(tip)}">
      <option value=""${current === '' ? ' selected' : ''}>（不预填）</option>
      <option value="true"${current === 'true' ? ' selected' : ''}>是</option>
      <option value="false"${current === 'false' ? ' selected' : ''}>否</option>
    </select>`;
  }
  if (dataType === 'number') {
    const text = typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
    return `<input type="number" step="any" data-ctrl-field="${index}:defaultValue" value="${esc(text)}" placeholder="可留空" title="${esc(tip)}" />`;
  }
  return `<input type="text" data-ctrl-field="${index}:defaultValue" value="${esc(typeof value === 'string' ? value : '')}" placeholder="可留空" title="${esc(tip)}" />`;
}

function ctrlFieldHtml(field, index, shape) {
  const dataType = String(field.dataType ?? 'text');
  const range = field.referenceRange || {};
  const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? String(value) : '');
  const isImage = shape === 'image';
  const typeAndUnit = isImage
    ? `<span>类型</span>
        <select data-ctrl-field="${index}:dataType"
          title="影像格的值是一条**地址**（本系统只存引用，图的字节不在病历里），所以它只能是 text">
          <option value="text" selected>text（地址）</option>
        </select>`
    : `<span>类型</span>
        <select data-ctrl-field="${index}:dataType"
          title="这一格填什么：expression = 由「表达式控件」里的那一份算出来（控件自身不带公式）">
          ${CTRL_FIELD_TYPES.map((type) => `<option value="${type}"${dataType === type ? ' selected' : ''}>${type}</option>`).join('')}
        </select>
        <span>单位</span>
        <input type="text" data-ctrl-field="${index}:unit" value="${esc(field.unit ?? '')}" placeholder="可留空" />`;
  return `
    <div class="ctrl-field">
      <div class="row">
        <span>key</span>
        <input type="text" data-ctrl-field="${index}:key" value="${esc(field.key ?? '')}" placeholder="如 sbp"
          title="控件内的唯一名：payload 的键就是它（表达式引用填写项也按它找）" />
        <span>名称</span>
        <input type="text" data-ctrl-field="${index}:label" value="${esc(field.label ?? '')}" placeholder="医生看到的那一格的名字" />
        ${typeAndUnit}
        <button class="secondary" data-ctrl-fieldup="${index}" title="上移一格">↑</button>
        <button class="secondary" data-ctrl-fielddown="${index}" title="下移一格">↓</button>
        <button class="danger" data-ctrl-fielddel="${index}" title="删掉这一格">×</button>
      </div>
      <div class="row">
        <label class="tpl-check"><input type="checkbox" data-ctrl-field="${index}:required" ${field.required ? 'checked' : ''} /> 必填</label>
        ${shape === 'series'
          ? `<label class="tpl-check" title="时序（趋势）按它排序：整份控件只能有一格标它"><input type="checkbox" data-ctrl-field="${index}:axis" ${field.axis === 'time' ? 'checked' : ''} /> 时间轴</label>`
          : ''}
        ${isImage ? '' : `<span>参考范围</span>
        <input type="number" data-ctrl-field="${index}:rangeLow" value="${num(range.low)}" placeholder="下限" />
        <input type="number" data-ctrl-field="${index}:rangeHigh" value="${num(range.high)}" placeholder="上限" />
        <input type="text" data-ctrl-field="${index}:rangeText" value="${esc(range.text ?? '')}" placeholder="或文本范围（如 阴性）" />`}
      </div>
      ${isImage
        ? `<div class="muted">这一格填**影像地址**（PACS / 院内服务的 http(s) 地址，或站内路径）。
            本系统只存引用，图的字节不在病历里。</div>`
        : `<div class="row">
        <span>取值域</span>
        <textarea data-ctrl-field="${index}:valueSet" rows="2" placeholder="一行一项：code=显示名（留空 = 自由填写）">${esc(valueSetText(field.valueSet))}</textarea>
      </div>`}
      <div class="row">
        <span>机读编码</span>
        <input type="text" data-ctrl-field="${index}:tagCode" value="${esc(field.tag?.code ?? '')}"
          placeholder="留空 = 这一格不产数据元"
          title="填了它，这一格的值才会进机读信息（成为一条数据元，显示名取上面的「名称」）。留空 = 只给人看 —— 这是「这一格能不能被机器读懂」的分水岭" />
        ${isImage ? '' : `<span>默认值</span>
        ${ctrlDefaultValueHtml(field, index)}`}
      </div>
      ${!isImage && dataType === 'expression' ? `
      <div class="row">
        <span>引用控件</span>
        <select data-ctrl-field="${index}:useExpression">${tplControlOptions(field.useExpression)}</select>
        <span class="muted">这一格的值由它算出来（公式在「表达式控件」那一页维护 —— 控件里不带公式）</span>
      </div>` : ''}
    </div>`;
}

function ctrlMatrixHtml(draft) {
  return `
    <div class="row">
      <span>行</span>
      <textarea id="ctrlNewRows" rows="4" title="行列表的行（如 32 颗牙）：一行一项，key=名称">${esc(keyLabelText(draft.rows))}</textarea>
      <span>列</span>
      <textarea id="ctrlNewColumns" rows="4" title="行列表的列（如 龋 / 充填 / 缺失）：一行一项，key=名称">${esc(keyLabelText(draft.columns))}</textarea>
    </div>`;
}

function renderCtrlForm() {
  const box = $(tplDrawerBodyId());
  if (!box) return;
  const editing = CTRL_EDIT_ID !== '';
  const draft = CTRL_DRAFT || emptyCtrlDraft();
  CTRL_DRAFT = draft;
  box.innerHTML = `
    <div class="tpl-edit-box">
      <div class="tpl-drawer-status" data-tpl-drawer-status></div>
      <div class="row">
        <span>名称</span>
        <input type="text" id="ctrlNewName" placeholder="如：疼痛数字量表" value="${esc(draft.name)}" />
      </div>
      <div class="row">
        <span>语义类型</span>
        <select id="ctrlNewKind" title="它回答「这是什么控件」：质控与机读分类按它问">
          ${Object.keys(CTRL_KIND_LABELS).map((kind) => `<option value="${kind}"${draft.controlKind === kind ? ' selected' : ''}>${CTRL_KIND_LABELS[kind]}</option>`).join('')}
        </select>
        <span>形状</span>
        <select id="ctrlNewShape"
          title="形状决定用哪个渲染器（渲染器是代码，所以形状是闭集）：量表评分 / 时序（趋势）/ 行列表 / 勾选清单 / 影像">
          ${Object.keys(CTRL_SHAPE_LABELS).map((shape) => `<option value="${shape}"${draft.shape === shape ? ' selected' : ''}>${CTRL_SHAPE_LABELS[shape]}</option>`).join('')}
        </select>
      </div>
      <div class="row">
        <span>说明</span>
        <input type="text" id="ctrlNewDesc" placeholder="一句话说明它记什么（可留空）" value="${esc(draft.description)}" />
      </div>
      ${draft.shape === 'matrix' ? ctrlMatrixHtml(draft) : ''}
      <div id="ctrlFieldsBox">${draft.fields.map((field, index) => ctrlFieldHtml(field, index, draft.shape)).join('')}</div>
      <div class="row">
        <button class="secondary" data-ctrl-addfield="1" title="加一格：控件就是「把一组字段装进一个格子」">加一格</button>
        <button class="primary" data-ctrl-submit="1">${editing ? '保存改动' : '保存'}</button>
        <button class="secondary" data-tpl-create-cancel="1">取消</button>
      </div>
      ${editing
        ? '<div class="muted">改到字段或形状，这份定义会<b>升一版</b>（已开出的病历存着当时那份字段快照，不跟着变）。</div>'
        : ''}
    </div>`;
}

/** 把表单里此刻的值读回草稿（切形状要先读再重绘，否则切一下就把刚填的丢了） */
function readCtrlForm() {
  const draft = CTRL_DRAFT;
  if (!draft) return;
  const nameEl = $('ctrlNewName');
  if (nameEl) draft.name = nameEl.value;
  const kindEl = $('ctrlNewKind');
  if (kindEl) draft.controlKind = kindEl.value;
  const descEl = $('ctrlNewDesc');
  if (descEl) draft.description = descEl.value;
  const rowsEl = $('ctrlNewRows');
  if (rowsEl) draft.rows = parseKeyLabel(rowsEl.value);
  const columnsEl = $('ctrlNewColumns');
  if (columnsEl) draft.columns = parseKeyLabel(columnsEl.value);

  const box = $('ctrlFieldsBox');
  if (!box) return;
  const fields = [...box.querySelectorAll('.ctrl-field')].map((card, index) => {
    const field = { ...(draft.fields[index] || {}) };
    [...card.querySelectorAll('[data-ctrl-field]')].forEach((el) => {
      const prop = String(el.dataset.ctrlField).split(':')[1];
      if (prop === 'required') {
        if (el.checked) field.required = true; else delete field.required;
        return;
      }
      if (prop === 'axis') {
        if (el.checked) field.axis = 'time'; else delete field.axis;
        return;
      }
      const value = String(el.value ?? '');
      if (prop === 'key') field.key = value.trim();
      else if (prop === 'label') field.label = value.trim();
      else if (prop === 'dataType') field.dataType = value;
      else if (prop === 'unit') { if (value.trim() === '') delete field.unit; else field.unit = value.trim(); }
      else if (prop === 'useExpression') { if (value === '') delete field.useExpression; else field.useExpression = value; }
      else if (prop === 'tagCode') {
        if (value.trim() === '') delete field.tag;
        else field.tag = { system: field.tag?.system ?? 'local', code: value.trim() };
      }
      /* 默认值：按数据类型收成**机器真值**（数字给数字、是/否给布尔） */
      else if (prop === 'defaultValue') {
        if (value === '') delete field.defaultValue;
        else if (field.dataType === 'boolean') field.defaultValue = value === 'true';
        else if (field.dataType === 'number') {
          const parsed = Number(value);
          if (Number.isFinite(parsed)) field.defaultValue = parsed;
          else delete field.defaultValue;
        } else field.defaultValue = value;
      }
      else if (prop === 'valueSet') {
        const list = parseValueSet(value);
        if (list.length === 0) delete field.valueSet; else field.valueSet = list;
      } else if (prop === 'rangeLow' || prop === 'rangeHigh' || prop === 'rangeText') {
        const range = { ...(field.referenceRange || {}) };
        if (prop === 'rangeText') {
          if (value.trim() === '') delete range.text; else range.text = value.trim();
        } else {
          const key = prop === 'rangeLow' ? 'low' : 'high';
          const parsed = Number(value);
          if (value.trim() === '' || !Number.isFinite(parsed)) delete range[key]; else range[key] = parsed;
        }
        if (Object.keys(range).length === 0) delete field.referenceRange; else field.referenceRange = range;
      }
    });
    return field;
  });
  for (const field of fields) {
    if (field.tag && field.label) field.tag = { ...field.tag, display: field.label };
  }
  const shapeEl = $('ctrlNewShape');
  const shapeNow = shapeEl ? String(shapeEl.value || '') : String(draft.shape || '');
  if (shapeNow === 'image') {
    for (const field of fields) {
      field.dataType = 'text';
      delete field.unit;
      delete field.referenceRange;
      delete field.valueSet;
      delete field.defaultValue;
      delete field.useExpression;
      delete field.axis;
    }
  }
  if (fields.length > 0) draft.fields = fields;
}

function markCtrlFieldBad(index, message) {
  const box = $('ctrlFieldsBox');
  const card = box ? box.querySelectorAll('.ctrl-field')[index] : null;
  if (card) {
    card.classList.add('bad');
    if (typeof card.scrollIntoView === 'function') card.scrollIntoView({ block: 'nearest' });
    const first = card.querySelector('input[data-ctrl-field$=":key"], input[data-ctrl-field$=":label"]');
    if (first) first.focus();
  }
  setTplDrawerStatus(message);
}

async function submitCtrlForm() {
  readCtrlForm();
  const draft = CTRL_DRAFT;
  if (!draft) return;
  const name = String(draft.name || '').trim();
  if (name === '') {
    const nameEl = $('ctrlNewName');
    if (nameEl) { nameEl.classList.add('bad'); nameEl.focus(); }
    setTplDrawerStatus('请填控件名称（它是这一页表里那一行）');
    return;
  }
  const rows = draft.fields || [];
  const filled = rows.filter((field) => String(field.key || '').trim() !== '' || String(field.label || '').trim() !== '');
  if (filled.length === 0) {
    markCtrlFieldBad(0, '至少要有一格（key 与名称都空着的那几格不算）：控件就是「把一组字段装进一个格子」');
    return;
  }
  const blank = rows.findIndex((field) => {
    const started = String(field.key || '').trim() !== '' || String(field.label || '').trim() !== '';
    if (!started) return false;
    return String(field.key || '').trim() === '' || String(field.label || '').trim() === '';
  });
  if (blank >= 0) {
    markCtrlFieldBad(blank, `第 ${blank + 1} 格缺 key 或名称：payload 按 key 存值，名称是医生看到的那一行`);
    return;
  }
  const fields = filled;
  if (draft.shape === 'matrix' && (draft.rows.length === 0 || draft.columns.length === 0)) {
    const rowsEl = $('ctrlNewRows');
    if (rowsEl) rowsEl.focus();
    setTplDrawerStatus('行列表（matrix）必须给行与列：少了任何一个，渲染出来都是一张空表');
    return;
  }
  const editing = CTRL_EDIT_ID !== '';
  const next = { ...draft, fields };
  const semanticsChanged = editing && ctrlSemanticSignature(next) !== CTRL_BASELINE;
  if (semanticsChanged && !(await askConfirm(
    `「${name}」这次改动包含字段或形状。\n\n会影响：这份控件的定义会升一版，之后新开的文书按新定义填。\n不影响：已经开出的病历（它们存着当时那份字段快照，一个字都不会变）。\n也不会：把旧病历按新定义重新解读 —— 那正是升版要挡住的事。\n审计里会记下改前改后的字段数与版本。`,
    { okLabel: '仍然保存' },
  ))) return;
  const r = await api(editing ? '/api/control-item-update' : '/api/control-item-create', {
    ...(editing ? { packId: draft.packId, itemId: CTRL_EDIT_ID } : {}),
    name,
    description: draft.description,
    controlKind: draft.controlKind,
    shape: draft.shape,
    fields,
    rows: draft.shape === 'matrix' ? draft.rows : null,
    columns: draft.shape === 'matrix' ? draft.columns : null,
  });
  if (r && r.state) {
    S = r.state;
    renderModelPanel();
  }
  if (r && r.ok) {
    CTRL_EDIT_ID = '';
    CTRL_DRAFT = null;
    CTRL_BASELINE = '';
    closeTplDrawer();
  }
  const message = r && r.ok
    ? editing
      ? `已保存控件「${name}」：${fields.length} 格${r.data && r.data.version ? `，定义 v${r.data.version}` : ''}`
      : `已新建控件「${name}」（${(r.data && r.data.itemId) || ''}）：${fields.length} 格`
    : `${editing ? '保存' : '新建'}失败：${(r && (r.message || r.code)) || '未知原因'}`;
  if (r && r.ok) setCtrlCatalogStatus(message);
  else setTplDrawerStatus(message);
}

function renderTplEditForm(item) {
  const box = $(tplDrawerBodyId());
  if (!box) return;
  if (item.itemType === 'fragment') {
    renderFragEditForm(item);
    return;
  }
  const structEditable = item.status === 'draft';
  box.innerHTML = `
    <div class="tpl-edit-box">
      <div class="tpl-drawer-status" data-tpl-drawer-status></div>
      <div class="tpl-field">
        <span class="tpl-label">名称</span>
        <input type="text" data-tpl-input="name" value="${esc(item.name)}"
          title="它是「新建」里的那一行；采集 / 同步程序按「模板名称 + 槽位名」对接，改了名称要让同步程序跟着改" />
      </div>
      <div class="tpl-field">
        <span class="tpl-label">适用科室</span>
        <div class="tpl-depts">${tplDeptPickerHtml(item.departments || [])}</div>
      </div>
      <div class="hint">${structEditable
        ? '草稿：章节与槽位可以改，顺序也能调（↑ / ↓ 或按住 ⠿ 拖）；发布之后就改不了了 —— 它可能已经开出过病历。'
        : '<b>已发布</b>：章节与槽位不可改、顺序也锁着（改骨架会让"当时按哪一版开的"对不上，要改请先<b>撤稿</b>，撤稿后医生端立刻开不出它）。<b>显示名 / 从系统带入 / 必填 / 单位 / 关键内容 / 默认值 / 参考范围</b>，以及章节的<b>必备章节 / 整章算关键内容 / 说明</b>照旧可以改 —— 它们在开文书那一刻才起作用，不进已开出的病历。'}</div>
      <div class="tpl-frag-bar">
        <span class="tpl-label">章节片段</span>
        <select data-tpl-frag-pick title="要插进来的是哪一段素材">${tplFragmentOptionsHtml()}</select>
        <button class="secondary" data-tpl-frag-append="${esc(item.itemId)}" title="把选中的片段追加到这份文书的末尾">追加到末尾</button>
      </div>
      <div class="tpl-secs">
        ${tplSectionsHtml(item, structEditable)}
      </div>
      ${structEditable ? `<button class="secondary tpl-add" data-tpl-sec-add="${esc(item.itemId)}">+ 加一章</button>` : ''}
      <div class="form-actions">
        <button class="primary" data-tpl-save="${esc(item.packId)}|${esc(item.itemId)}">保存</button>
        <button class="secondary" data-tpl-cancel="${esc(item.itemId)}">取消</button>
      </div>
    </div>`;
}

function renderFragEditForm(item) {
  const box = $(tplDrawerBodyId());
  if (!box) return;
  box.innerHTML = `
    <div class="tpl-edit-box">
      <div class="tpl-drawer-status" data-tpl-drawer-status></div>
      <div class="tpl-field">
        <span class="tpl-label">片段名称</span>
        <input type="text" data-tpl-input="name" value="${esc(item.name)}"
          title="它是插入片段时那个下拉里的那一行" />
      </div>
      <div class="tpl-field">
        <span class="tpl-label">说明（什么时候用这一段）</span>
        <input type="text" data-tpl-input="fragdesc" value="${esc(item.description || '')}"
          placeholder="可留空，如：门诊常规查体" />
      </div>
      <div class="hint">改这个片段<b>不会</b>改动任何已经用它拼好的文书，也不会改动任何已开出的病历 ——
        插入是<b>复制</b>，不是引用。要让已经拼好的那些文书跟着更新，得在那份文书里重新插一次。</div>
      <div class="tpl-secs">${tplSectionsHtml(item, true)}</div>
      <button class="secondary tpl-add" data-tpl-sec-add="${esc(item.itemId)}">+ 加一章</button>
      <div class="form-actions">
        <button class="primary" data-tpl-frag-save="${esc(item.packId)}|${esc(item.itemId)}">保存</button>
        <button class="secondary" data-tpl-cancel="${esc(item.itemId)}">取消</button>
      </div>
    </div>`;
}

function tplSectionsHtml(item, structEditable) {
  const sections = Array.isArray(item.sections) ? item.sections : [];
  return sections.map((section, si) => `
          <section class="tpl-sec" data-sec-index="${si}">
            <div class="tpl-sec-head">
              ${structEditable ? `<span class="tpl-drag-handle" draggable="true" data-drag-sec="${si}"
                title="拖动排序：按住这里把这一章拖到别处（也可以点旁边的 ↑ / ↓）">⠿</span>` : ''}
              <span class="tpl-sec-no">第 ${si + 1} 章</span>
              ${structEditable ? `<button class="secondary tpl-move" data-tpl-sec-move="${esc(item.itemId)}|${si}|-1"${si === 0 ? ' disabled' : ''} title="上移一章">↑</button>
              <button class="secondary tpl-move" data-tpl-sec-move="${esc(item.itemId)}|${si}|1"${si === sections.length - 1 ? ' disabled' : ''} title="下移一章">↓</button>` : ''}
              <div class="tpl-cell tpl-cell-wide">
                <span class="tpl-label">章节标题</span>
                <input type="text" data-tpl-input="sec:title:${si}" value="${esc(section.title)}" placeholder="如：主诉" ${structEditable ? '' : 'disabled'} />
              </div>
              <div class="tpl-cell">
                <span class="tpl-label">章节编码</span>
                <input type="text" class="tpl-code" data-tpl-input="sec:code:${si}" value="${esc(section.sectionCode)}"
                  title="章节编码：跨文书比对时的锚点" ${structEditable ? '' : 'disabled'} />
              </div>
              <button class="secondary" data-tpl-sec-frag="${esc(item.itemId)}|${si}"
                title="把这一章存成一个片段（含它的每一格），之后可以在别的文书里一次插进来。已发布的文书也能存：它不改这份文书。">存为片段</button>
              <button class="secondary" data-tpl-frag-insert="${esc(item.itemId)}|${si}"
                title="把上面「章节片段」里选中的那一段插到这一章之后">插入片段</button>
              ${structEditable ? `<button class="danger tpl-del" data-tpl-sec-del="${esc(item.itemId)}|${si}">删这一章</button>` : ''}
            </div>
            <div class="tpl-sec-meta">
              <label class="tpl-check" title="必备章节：这一章是这份文书必须有的部分 —— 开出的病历里它<b>删不掉</b>（写路径拒删）。它管「这一章在不在」，不管「写得够不够」：够不够是质控的事，刚开出来的草稿必然还是空的。">
                <input type="checkbox" data-tpl-input="sec:required:${si}" ${section.required ? 'checked' : ''} /> 必备章节
              </label>
              <label class="tpl-check" title="整章算关键内容：这一章整体按关键内容对待（未人工确认不得签章），不用一格一格标。">
                <input type="checkbox" data-tpl-input="sec:keyContent:${si}" ${section.keyContent ? 'checked' : ''} /> 整章算关键内容
              </label>
              <div class="tpl-cell tpl-cell-wide">
                <span class="tpl-label">这一章要写清什么（给医生的提示，不进病历）</span>
                <input type="text" data-tpl-input="sec:desc:${si}" value="${esc(section.description || '')}"
                  placeholder="可留空，如：症状 + 部位 + 时间" />
              </div>
            </div>
            <div class="tpl-slots">
              ${(section.slots || []).map((slot, ti) => tplSlotRowHtml(item.itemId, si, ti, slot, structEditable, (section.slots || []).length)).join('')
                || '<div class="muted">这一章还没有槽位：点下面的「+ 加一个槽位」</div>'}
            </div>
            ${structEditable ? `<button class="secondary tpl-add" data-tpl-slot-add="${esc(item.itemId)}|${si}">+ 加一个槽位</button>` : ''}
          </section>`).join('');
}

function tplFragmentOptionsHtml() {
  const fragments = Array.isArray((S || {}).fragments) ? S.fragments : [];
  if (fragments.length === 0) {
    return '<option value="">（还没有片段：在下面某一章上点「存为片段」，就能攒出第一段）</option>';
  }
  const head = '<option value="">选一段片段…</option>';
  return head + fragments.map((fragment) => `<option value="${esc(fragment.packId)}|${esc(fragment.fragmentId)}">`
    + `${esc(fragment.name)}（${fragment.sectionCount} 章 / ${fragment.slotCount} 槽位）</option>`).join('');
}

function fragmentSectionsOf(fragmentId) {
  const item = tplItemOf(fragmentId);
  if (!item || item.itemType !== 'fragment') return null;
  return (item.sections || []).map((section) => ({
    sectionCode: String(section.sectionCode ?? ''),
    title: String(section.title ?? ''),
    slots: (section.slots || []).map((slot) => slotOfView(slot)),
    ...(section.required ? { required: true } : {}),
    ...(section.keyContent ? { keyContent: true } : {}),
    ...(section.description !== undefined ? { description: section.description } : {}),
  }));
}

function fragmentControlGaps(sections, packId) {
  const available = new Set(
    (Array.isArray((S || {}).templateCatalog) ? S.templateCatalog : [])
      .filter((item) => item.itemType === 'expression' && item.packId === packId)
      .map((item) => item.itemId),
  );
  const gaps = [];
  for (const section of sections) {
    for (const slot of section.slots ?? []) {
      if (slot.slot !== 'expression') continue;
      const controlId = String(slot.useExpression ?? '');
      if (!available.has(controlId)) gaps.push({ section: section.title, key: slot.key, controlId });
    }
  }
  return gaps;
}

function tplInsertSections(form, at, sections) {
  const taken = new Set();
  for (const section of form.sections) for (const slot of section.slots ?? []) taken.add(String(slot.key ?? ''));
  let renamed = 0;
  for (const section of sections) {
    for (const slot of section.slots ?? []) {
      const key = String(slot.key ?? '');
      if (!taken.has(key)) {
        taken.add(key);
        continue;
      }
      let seq = 2;
      while (taken.has(`${key}_${seq}`)) seq += 1;
      slot.key = `${key}_${seq}`;
      taken.add(slot.key);
      renamed += 1;
    }
  }
  form.sections.splice(at, 0, ...sections);
  return renamed;
}

function tplMove(list, index, delta) {
  if (!Array.isArray(list) || !Number.isInteger(index)) return false;
  const target = index + delta;
  if (target < 0 || target >= list.length) return false;
  const [moved] = list.splice(index, 1);
  list.splice(target, 0, moved);
  return true;
}

function slotOfView(view) {
  const kind = String(view.kind ?? view.slot ?? 'text');
  const slot = { slot: kind, key: String(view.key ?? '') };
  if (Array.isArray(view.tags) && view.tags.length > 0) slot.tags = view.tags.map((tag) => ({ ...tag }));
  if (view.keyContent === true) slot.keyContent = true;
  if (view.newParagraph === true) slot.newParagraph = true;
  if (kind === 'text') {
    if (view.text !== undefined) slot.text = String(view.text);
  } else if (kind === 'paragraph') {
    delete slot.tags;
  } else if (kind === 'image') {
    if (view.resRef !== undefined && String(view.resRef) !== '') slot.resRef = String(view.resRef);
    if (view.altText !== undefined && String(view.altText) !== '') slot.altText = String(view.altText);
    if (view.caption !== undefined && String(view.caption) !== '') slot.caption = String(view.caption);
    delete slot.tags;
    delete slot.keyContent;
  } else if (kind === 'field') {
    slot.dataType = String(view.dataType ?? 'text');
    if (view.unit !== undefined && view.unit !== '') slot.unit = String(view.unit);
    if (view.from !== undefined && view.from !== '') slot.from = String(view.from);
    if (view.required === true) slot.required = true;
    if (view.value !== undefined) slot.value = view.value;
    if (view.referenceRange && typeof view.referenceRange === 'object') slot.referenceRange = { ...view.referenceRange };
  } else if (kind === 'table') {
    slot.columns = (Array.isArray(view.columns) ? view.columns : []).map((column) => ({
      title: String(column?.title ?? ''),
      ...(column?.dataType !== undefined ? { dataType: String(column.dataType) } : {}),
      ...(column?.unit !== undefined && column.unit !== '' ? { unit: String(column.unit) } : {}),
      ...(Array.isArray(column?.tags) && column.tags.length > 0
        ? { tags: column.tags.map((tag) => ({ ...tag })) }
        : {}),
    }));
    if (view.rows !== undefined) slot.rows = Number(view.rows);
  } else if (kind === 'list') {
    slot.items = (Array.isArray(view.items) ? view.items : []).map((item) => ({
      text: String(item?.text ?? ''),
      ...(item?.field
        ? {
          field: {
            dataType: String(item.field.dataType),
            ...(item.field.unit !== undefined ? { unit: String(item.field.unit) } : {}),
            ...(Array.isArray(item.field.tags) && item.field.tags.length > 0
              ? { tags: item.field.tags.map((tag) => ({ ...tag })) }
              : {}),
          },
        }
        : {}),
    }));
    if (view.ordered === true) slot.ordered = true;
    delete slot.tags;
    delete slot.keyContent;
  } else if (kind === 'expression') {
    slot.useExpression = String(view.useExpression ?? '');
    if (view.unit !== undefined && view.unit !== '') slot.unit = String(view.unit);
  } else if (kind === 'control') {
    slot.useControl = String(view.useControl ?? '');
    if (view.rows !== undefined) slot.rows = Number(view.rows);
  }
  return slot;
}

function slotTagOf(slot) {
  return Array.isArray(slot.tags) && slot.tags.length > 0 ? slot.tags[0] : null;
}

const TPL_VALUE_TIP = '模板预设的默认值（开文书时填上）；留空 = 这一格空着等医生填。'
  + '若同时配了「从系统带入」：开文书时用这个默认值，之后采集 / 同步程序同步进来的值会覆盖它';

function tplDefaultValueHtml(si, ti, slot) {
  const dataType = String(slot.dataType ?? 'text');
  const raw = slot.value === undefined || slot.value === null ? '' : String(slot.value);
  if (dataType === 'boolean') {
    return `<select data-tpl-input="slot:value:${si}:${ti}"
        title="${esc(TPL_VALUE_TIP)}">
        <option value=""${raw === '' ? ' selected' : ''}>不预设（空待填）</option>
        <option value="true"${slot.value === true ? ' selected' : ''}>是</option>
        <option value="false"${slot.value === false ? ' selected' : ''}>否</option>
      </select>`;
  }
  return `<input type="${dataType === 'number' ? 'number' : 'text'}" data-tpl-input="slot:value:${si}:${ti}" value="${esc(raw)}"
    placeholder="${dataType === 'date' ? '如 2026-10-16' : '不填 = 空待填'}"
    title="${esc(TPL_VALUE_TIP)}" />`;
}

function tplRangeHtml(si, ti, range) {
  const r = range && typeof range === 'object' ? range : {};
  const cell = (key, label, value, placeholder) => `<span class="tpl-range-cell">
      <span class="tpl-label">${label}</span>
      <input type="${key === 'text' || key === 'unit' ? 'text' : 'number'}"
        data-tpl-input="slot:rr${key}:${si}:${ti}"
        value="${value === undefined || value === null ? '' : esc(String(value))}" placeholder="${placeholder}" /></span>`;
  return `<div class="tpl-range">
      ${cell('low', '低', r.low, '可留空')}
      ${cell('high', '高', r.high, '可留空')}
      ${cell('text', '文本', r.text, '如 阴性')}
      ${cell('unit', '单位', r.unit, '可留空')}
    </div>
    <div class="muted">低 / 高 / 文本至少要给一项：它是趋势判「偏高 / 偏低」的尺子，只写单位等于什么都没说</div>`;
}

function tplColumnRowHtml(si, ti, ci, column, lock) {
  const dataType = String(column?.dataType ?? 'text');
  const tag = Array.isArray(column?.tags) ? column.tags[0] : undefined;
  return `<span class="tpl-column">
      <input type="text" data-tpl-input="slot:coltitle:${si}:${ti}:${ci}" value="${esc(column?.title ?? '')}"
        placeholder="列名（如 体温）" title="列名：它就是表头格子里那行字" ${lock} />
      <select data-tpl-input="slot:coltype:${si}:${ti}:${ci}"
        title="这一列的值类型：数值列才画得出趋势、才判得了参考范围（派生值列不属于表格能表达的东西）" ${lock}>
        ${TPL_FIELD_TYPES.map((type) => `<option value="${type}"${dataType === type ? ' selected' : ''}>${type}</option>`).join('')}
      </select>
      <input type="text" data-tpl-input="slot:colunit:${si}:${ti}:${ci}" value="${esc(column?.unit ?? '')}" placeholder="单位" ${lock} />
      <input type="text" data-tpl-input="slot:collabel:${si}:${ti}:${ci}" value="${esc(tag?.display ?? '')}"
        placeholder="数据元（如 体温）" title="这一列绑的数据元：填了之后每一格的值都能被机读认出来（编码不在这里改）" ${lock} />
      <input type="hidden" data-tpl-input="slot:coltags:${si}:${ti}:${ci}"
        value="${esc(JSON.stringify(Array.isArray(column?.tags) ? column.tags : []))}" />
      <button class="danger tpl-del-col" data-tpl-col-del="${si}:${ti}:${ci}" title="删掉这一列" ${lock}>×</button>
    </span>`;
}

function tplListItemRowHtml(si, ti, ii, item, lock) {
  const field = item?.field;
  const hasField = Boolean(field);
  const tag = Array.isArray(field?.tags) ? field.tags[0] : undefined;
  const off = hasField ? '' : 'disabled';
  return `<span class="tpl-item">
      <input type="text" data-tpl-input="slot:itemtext:${si}:${ti}:${ii}" value="${esc(item?.text ?? '')}"
        placeholder="这一项写什么（如 否认药物过敏史）" title="列表项的文字；可写 {{ctx.path}}" ${lock} />
      <label class="tpl-check" title="这一项后面跟一个填写格（如 体温 ____ ℃）：只有带格子的项才产数据元">
        <input type="checkbox" data-tpl-input="slot:itemfield:${si}:${ti}:${ii}" ${hasField ? 'checked' : ''} ${lock} /> 格子
      </label>
      <select data-tpl-input="slot:itemtype:${si}:${ti}:${ii}" ${off} ${lock}
        title="格子的值类型：数值才画得出趋势、才判得了参考范围">
        ${TPL_FIELD_TYPES.map((type) => `<option value="${type}"${String(field?.dataType ?? 'text') === type ? ' selected' : ''}>${type}</option>`).join('')}
      </select>
      <input type="text" data-tpl-input="slot:itemunit:${si}:${ti}:${ii}" value="${esc(field?.unit ?? '')}"
        placeholder="单位" ${off} ${lock} />
      <input type="text" data-tpl-input="slot:itemlabel:${si}:${ti}:${ii}" value="${esc(tag?.display ?? '')}"
        placeholder="数据元" title="格子绑的数据元：填了机读才认得出这一格是什么（编码不在这里改）" ${off} ${lock} />
      <input type="hidden" data-tpl-input="slot:itemtags:${si}:${ti}:${ii}"
        value="${esc(JSON.stringify(Array.isArray(field?.tags) ? field.tags : []))}" />
      <button class="danger tpl-del-item" data-tpl-item-del="${si}:${ti}:${ii}" title="删掉这一项" ${lock}>×</button>
    </span>`;
}

function tplSlotRowHtml(itemId, si, ti, view, structEditable, slotCount) {
  const slot = slotOfView(view);
  const kind = slot.slot;
  const at = `${esc(itemId)}|${si}|${ti}`;
  const tag = slotTagOf(slot);
  const lock = structEditable ? '' : 'disabled';
  const tagTip = tag
    ? `医生在这一格上看到的名字。这一格绑的数据元是 ${tag.system} / ${tag.code}（编码不在这里改：跨文书比对按它认同一个数据元）`
    : '医生在这一格上看到的名字。这一格还没绑数据元：填了会按 local + 槽位名记一条';
  const kinds = [
    ['text', '结构文本'],
    ['paragraph', '空段落'],
    ['field', '填写项'],
    ['expression', '表达式控件'],
    ['table', '表格'],
    ['list', '列表'],
    ['control', '专科控件'],
    ['image', '图片 / 影像'],
  ];
  let extra = '';
  if (kind === 'paragraph') {
    extra = `<div class="muted">这一段开出来是<b>空的</b>，由医生写。
      如果想给医生一句提示（"其他：____"这种），用「结构文本」把提示写进去 ——
      空段落不提供文字框，就是为了不让人以为这里有东西没填。</div>`;
  } else if (kind === 'image') {
    extra = `<div class="tpl-cell tpl-cell-wide">
        <span class="tpl-label">图片说明</span>
        <input type="text" data-tpl-input="slot:alt:${si}:${ti}" value="${esc(slot.altText ?? '')}"
          placeholder="医生端空槽上显示的那行字（如 胸部 CT 正位）" ${lock} />
      </div>
      <div class="tpl-cell tpl-cell-wide">
        <span class="tpl-label">图注</span>
        <input type="text" data-tpl-input="slot:caption:${si}:${ti}" value="${esc(slot.caption ?? '')}"
          placeholder="排在图下方的一行说明（可留空，支持 {{ctx.path}}）" ${lock} />
      </div>
      <div class="muted">开出来是一个<b>待贴图的空槽</b>：医生在那一格上贴图，图会随归档件打进 <code>Res/MultiMedia</code>。
        模板<b>不携带图片文件</b>（在包里写死一个地址，换台机器、清一次资源目录就裂，而且不报错）。</div>`;
  } else if (kind === 'text') {
    extra = `<div class="tpl-cell tpl-cell-wide">
        <span class="tpl-label">结构文本 / 提示语</span>
        <input type="text" data-tpl-input="slot:text:${si}:${ti}" value="${esc(slot.text ?? '')}"
          placeholder="这一段的固定文字（可留空）" ${lock} />
      </div>`
      + (slot.newParagraph === true ? `<input type="hidden" data-tpl-input="slot:newp:${si}:${ti}" value="true" />` : '');
  } else if (kind === 'field') {
    extra = `<div class="tpl-cell">
        <span class="tpl-label">数据类型</span>
        <select data-tpl-input="slot:type:${si}:${ti}" ${lock}>
          ${TPL_FIELD_TYPES.map((type) => `<option value="${type}"${slot.dataType === type ? ' selected' : ''}>${type}</option>`).join('')}
        </select>
      </div>
      <div class="tpl-cell">
        <span class="tpl-label">单位</span>
        <input type="text" data-tpl-input="slot:unit:${si}:${ti}" value="${esc(slot.unit ?? '')}" placeholder="可留空" />
      </div>
      <div class="tpl-cell tpl-cell-wide">
        <span class="tpl-label">从系统带入</span>
        <select data-tpl-input="slot:from:${si}:${ti}"
          title="这是给采集 / 同步程序看的对接标记：它按「模板名称 + 槽位名」把值同步进这一格（留空 = 这一格不参与同步）。开文书时自动填上；取不到值就留空并告警，不编值">
          ${tplContextOptions(slot.from)}
        </select>
      </div>
      <label class="tpl-check"><input type="checkbox" data-tpl-input="slot:req:${si}:${ti}" ${slot.required ? 'checked' : ''} /> 必填项</label>
      <div class="tpl-cell">
        <span class="tpl-label">默认值</span>
        ${tplDefaultValueHtml(si, ti, slot)}
      </div>
      <div class="tpl-cell tpl-cell-wide">
        <span class="tpl-label">参考范围</span>
        ${tplRangeHtml(si, ti, slot.referenceRange)}
      </div>
      <label class="tpl-check"><input type="checkbox" data-tpl-input="slot:newp:${si}:${ti}" ${slot.newParagraph ? 'checked' : ''} /> 强制另起一段</label>`;
  } else if (kind === 'expression') {
    extra = `<div class="tpl-cell tpl-cell-wide">
        <span class="tpl-label">表达式控件</span>
        <select data-tpl-input="slot:expr:${si}:${ti}" ${lock}>
          ${tplControlOptions(slot.useExpression)}
        </select>
      </div>
      <div class="tpl-cell">
        <span class="tpl-label">单位</span>
        <input type="text" data-tpl-input="slot:unit:${si}:${ti}" value="${esc(slot.unit ?? '')}" placeholder="可留空" />
      </div>
      <label class="tpl-check"><input type="checkbox" data-tpl-input="slot:newp:${si}:${ti}" ${slot.newParagraph ? 'checked' : ''} /> 强制另起一段</label>`;
  } else if (kind === 'table') {
    const columns = Array.isArray(slot.columns) ? slot.columns : [];
    extra = `<div class="tpl-cell tpl-cell-wide">
        <span class="tpl-label">列（列名就是表头格子里那行字）</span>
        <div class="tpl-columns">
          ${columns.map((column, ci) => tplColumnRowHtml(si, ti, ci, column, lock)).join('')
            || '<div class="muted">至少要有一列：没有列的表产不出任何格子</div>'}
        </div>
        ${structEditable ? `<button class="secondary tpl-add-col" data-tpl-col-add="${si}:${ti}">+ 加一列</button>` : ''}
      </div>
      <div class="tpl-cell">
        <span class="tpl-label">数据行数</span>
        <input type="number" min="1" max="20" data-tpl-input="slot:rows:${si}:${ti}" value="${esc(String(slot.rows ?? 1))}"
          title="模板给几行空行让医生填（1~20 行）。行数与列一样是**骨架**，只有草稿能改：已开出的病历里那张表不会跟着变" ${lock} />
      </div>
      <div class="muted">格子里的东西是**填写项**：医生填法与正文里那些格子完全一样（留痕、质控、趋势都照旧）。
        表格本身不能标「关键内容」—— 要标就标到列上（本版先不开放）。</div>`;
  } else if (kind === 'list') {
    const items = Array.isArray(slot.items) ? slot.items : [];
    const rows = items.map((item, ii) => tplListItemRowHtml(si, ti, ii, item, lock)).join('');
    extra = `<div class="tpl-cell tpl-cell-wide">
        <span class="tpl-label">列表项（至少一项；勾「格子」才在这一项后面加一个填写格）</span>
        <div class="tpl-items">${rows || '<span class="muted">还没有项</span>'}</div>
        <button class="tpl-add-item" data-tpl-item-add="${si}:${ti}" ${lock}>+ 加一项</button>
      </div>
      <label class="tpl-check"><input type="checkbox" data-tpl-input="slot:listordered:${si}:${ti}" ${slot.ordered ? 'checked' : ''} ${lock} /> 编号（不勾 = 圆点）</label>
      <div class="muted">列表是<b>块级</b>内容：开出来自成一段；有序列表在纸面上按 <code>1.</code> <code>2.</code> 编号。
        条目里可以写 <code>{{ctx.path}}</code>（与结构文本同一套替换）。
        列表本身不产数据元 —— 产数据元的是勾了「格子」的那些填写格。</div>`;
  } else if (kind === 'control') {
    extra = `<div class="tpl-cell tpl-cell-wide">
        <span class="tpl-label">专科控件</span>
        <select data-tpl-input="slot:ctrl:${si}:${ti}" ${lock}>
          ${tplControlDefOptions(slot.useControl)}
        </select>
      </div>
      <div class="tpl-cell">
        <span class="tpl-label">记录行数</span>
        <input type="number" min="1" max="20" data-tpl-input="slot:rows:${si}:${ti}" value="${esc(String(slot.rows ?? 3))}"
          title="只有「时序（趋势）」吃这一项：模板给几条记录让医生填（留空 = 3 条）。行数是**骨架**，只有草稿能改 —— 已开出的病历里那几行不会跟着变；行列表的行列来自控件定义，不用这里填" ${lock} />
      </div>
      <div class="muted">这一格在医生端画成什么样，由控件的<b>形状</b>决定（量表评分 / 时序趋势 / 行列表 / 勾选清单）——
        这里只选"用哪一份控件"，画法跟着它走。想看画出来的样子：去「专科控件」页点那一行的<b>预览</b>。</div>`;
  }
  const tagsJson = Array.isArray(slot.tags) && slot.tags.length > 0 ? JSON.stringify(slot.tags) : '[]';
  return `
    <div class="tpl-slot-row">
      <input type="hidden" data-tpl-input="slot:tags:${si}:${ti}" value="${esc(tagsJson)}" />
      <div class="tpl-slot-head">
        ${structEditable ? `<span class="tpl-drag-handle" draggable="true" data-drag-slot="${si}:${ti}"
          title="拖动排序：按住这里把这一格拖到本章的别处（也可以点旁边的 ↑ / ↓）">⠿</span>
        <button class="secondary tpl-move" data-tpl-slot-move="${at}|-1"${ti === 0 ? ' disabled' : ''} title="上移一格">↑</button>
        <button class="secondary tpl-move" data-tpl-slot-move="${at}|1"${ti >= slotCount - 1 ? ' disabled' : ''} title="下移一格">↓</button>` : ''}
        <div class="tpl-cell">
          <span class="tpl-label">槽位名</span>
          <input type="text" data-tpl-input="slot:key:${si}:${ti}" value="${esc(slot.key ?? '')}"
            title="槽位名：表达式按它引用填写项，整份模板内不能重名；采集 / 同步程序也按「模板名称 + 槽位名」对接，改名要让同步程序跟着改" ${lock} />
        </div>
        ${kind === 'table' || kind === 'list' || kind === 'control' || kind === 'paragraph' || kind === 'image' ? '' : `<div class="tpl-cell">
          <span class="tpl-label">显示名</span>
          <input type="text" data-tpl-input="slot:label:${si}:${ti}" value="${esc(tag?.display ?? '')}"
            placeholder="医生端看到的名字（如 体温）" title="${esc(tagTip)}" />
        </div>`}
        <div class="tpl-cell">
          <span class="tpl-label">类别</span>
          <select data-tpl-input="slot:kind:${si}:${ti}" ${lock}>
            ${kinds.map(([value, label]) => `<option value="${value}"${kind === value ? ' selected' : ''}>${label}</option>`).join('')}
          </select>
        </div>
        ${kind === 'table' || kind === 'list' || kind === 'image' ? '' : `<label class="tpl-check"
          title="关键内容：**责任标记** —— 未人工确认就签不出去（见 model/validate.ts 的 E_KEY_CONTENT_UNCONFIRMED）。这一档在开文书那一刻才起作用，不进已开出的病历，所以任何状态下都能改">
          <input type="checkbox" data-tpl-input="slot:keyc:${si}:${ti}" ${slot.keyContent ? 'checked' : ''} /> 关键内容
        </label>`}
        ${structEditable ? `<button class="danger tpl-del" data-tpl-slot-del="${at}">删</button>` : ''}
      </div>
      <div class="tpl-slot-body">${extra}</div>
    </div>`;
}

function tplControlOptions(selected) {
  const controls = (Array.isArray(S.templateCatalog) ? S.templateCatalog : []).filter((item) => item.itemType === 'expression');
  const current = String(selected ?? '');
  const options = controls.map((item) => `<option value="${esc(item.itemId)}"${item.itemId === current ? ' selected' : ''}>${esc(item.name)}</option>`).join('');
  if (current !== '' && !controls.some((item) => item.itemId === current)) {
    return `<option value="${esc(current)}" selected>（已不在库里：${esc(current)}）</option>${options}`;
  }
  return options || `<option value="">（库里还没有任何表达式控件）</option>`;
}

function tplControlDefOptions(selected) {
  const controls = ctrlCatalogItems();
  const current = String(selected ?? '');
  const options = controls.map((item) => {
    const shape = CTRL_SHAPE_LABELS[item.shape] || String(item.shape || '');
    const cells = Array.isArray(item.fields) ? item.fields.length : 0;
    return `<option value="${esc(item.itemId)}"${item.itemId === current ? ' selected' : ''}>`
      + `${esc(item.name)}（${esc(shape)}${cells > 0 ? ` · ${cells} 格` : ''}）</option>`;
  }).join('');
  if (current !== '' && !controls.some((item) => item.itemId === current)) {
    return `<option value="${esc(current)}" selected>（已不在库里：${esc(current)}）</option>${options}`;
  }
  return options || '<option value="">（库里还没有任何专科控件 —— 先去「专科控件」页建一个）</option>';
}

function tplDeptPickerHtml(selected) {
  const picked = Array.isArray(selected) ? selected : [];
  const items = ((S && S.departments && S.departments.items) || []).filter((item) => item.enabled !== false);
  if (items.length === 0) {
    return '<span class="muted">科室字典还是空的：先去「基础数据」建科室，否则这份文书只能配成 <b>通用</b>（全院都能开）</span>';
  }
  return `${items.map((item) => `<label class="check" title="编码 ${esc(item.code)}">`
    + `<input type="checkbox" data-tpl-dept="${esc(item.code)}" ${picked.includes(item.code) ? 'checked' : ''} />${esc(item.name)}</label>`).join('')}`
    + '<span class="muted">一个都不勾 = <b>通用</b>（全院都能开）</span>';
}

function tplContextOptions(selected) {
  const fields = Array.isArray(S && S.contextFields) ? S.contextFields : [];
  const current = String(selected ?? '').trim();
  const orphan = current !== '' && !fields.some((field) => field.path === current)
    ? `<option value="${esc(current)}" selected>${esc(current)}（本机没有这个字段，原样保留）</option>`
    : '';
  const groups = new Map();
  for (const field of fields) {
    if (!groups.has(field.group)) groups.set(field.group, []);
    groups.get(field.group).push(field);
  }
  const body = [...groups.entries()].map(([group, list]) => `<optgroup label="${esc(group)}">`
    + list.map((field) => `<option value="${esc(field.path)}"${field.path === current ? ' selected' : ''}>${esc(field.label)}（${esc(field.path)}）</option>`).join('')
    + '</optgroup>').join('');
  if (orphan === '' && body === '') return '<option value="">（本机没有可带入的字段）</option>';
  return `<option value="">不标记（留空待填，也不参与同步）</option>${orphan}${body}`;
}

/** 按 id 取模板库里那一条（事件里拿不到渲染时的上下文，只能从当前状态里取） */
function tplItemOf(itemId) {
  return (Array.isArray((S || {}).templateCatalog) ? S.templateCatalog : []).find((item) => item.itemId === itemId) || null;
}

function tplFormStateOf(item, form) {
  return { ...item, name: form.name, departments: form.departments, sections: form.sections };
}

function readTplEditForm() {
  const boxId = tplDrawerBodyId();
  const box = $(boxId);
  const form = { name: '', departments: [], sections: [] };
  if (!box) return form;
  form.departments = tplPickedDepartments(boxId);
  for (const input of box.querySelectorAll('[data-tpl-input]')) {
    const path = String(input.dataset.tplInput || '');
    const value = input.type === 'checkbox' ? input.checked : input.value;
    if (path === 'name') form.name = String(value);
    else if (path === 'fragdesc') form.description = String(value);
    else if (path.startsWith('sec:')) {
      const [, field, indexText] = path.split(':');
      const index = Number(indexText);
      while (form.sections.length <= index) form.sections.push({ sectionCode: '', title: '', slots: [] });
      if (field === 'title') form.sections[index].title = String(value);
      else if (field === 'code') form.sections[index].sectionCode = String(value);
      else if (field === 'required') {
        if (value === true) form.sections[index].required = true;
        else delete form.sections[index].required;
      } else if (field === 'keyContent') {
        if (value === true) form.sections[index].keyContent = true;
        else delete form.sections[index].keyContent;
      } else if (field === 'desc') {
        const text = String(value).trim();
        if (text === '') delete form.sections[index].description;
        else form.sections[index].description = text;
      }
    } else if (path.startsWith('slot:')) {
      const [, field, sectionText, slotText, columnText] = path.split(':');
      const si = Number(sectionText);
      const ti = Number(slotText);
      while (form.sections.length <= si) form.sections.push({ sectionCode: '', title: '', slots: [] });
      const slots = form.sections[si].slots;
      if (field === 'kind') {
        const current = slots[ti] ?? { slot: 'text', key: '' };
        current.slot = value;
        if (current.key === undefined) current.key = '';
        if (value === 'text') {
          if (current.text === undefined) current.text = '';
          delete current.dataType;
          delete current.from;
          delete current.required;
          delete current.unit;
          delete current.value;
          delete current.referenceRange;
          delete current.columns;
          delete current.rows;
          delete current.useExpression;
          delete current.useControl;
          delete current.altText;
          delete current.caption;
        } else if (value === 'paragraph') {
          delete current.text;
          delete current.dataType;
          delete current.from;
          delete current.required;
          delete current.unit;
          delete current.value;
          delete current.referenceRange;
          delete current.columns;
          delete current.rows;
          delete current.useExpression;
          delete current.useControl;
          delete current.tags;
          delete current.altText;
          delete current.caption;
        } else if (value === 'image') {
          delete current.text;
          delete current.dataType;
          delete current.from;
          delete current.required;
          delete current.unit;
          delete current.value;
          delete current.referenceRange;
          delete current.columns;
          delete current.rows;
          delete current.useExpression;
          delete current.useControl;
          delete current.tags;
          delete current.keyContent;
        } else if (value === 'field') {
          if (current.dataType === undefined) current.dataType = 'text';
          delete current.text;
          delete current.useExpression;
          delete current.columns;
          delete current.rows;
        } else if (value === 'table') {
          if (!Array.isArray(current.columns) || current.columns.length === 0) current.columns = [{ title: '项目' }];
          if (current.rows === undefined) current.rows = 1;
          delete current.text;
          delete current.dataType;
          delete current.from;
          delete current.required;
          delete current.unit;
          delete current.keyContent;
          delete current.value;
          delete current.referenceRange;
        } else if (value === 'list') {
          if (!Array.isArray(current.items) || current.items.length === 0) current.items = [{ text: '待填写' }];
          delete current.text;
          delete current.dataType;
          delete current.from;
          delete current.required;
          delete current.unit;
          delete current.value;
          delete current.referenceRange;
          delete current.columns;
          delete current.rows;
          delete current.useExpression;
          delete current.useControl;
          delete current.tags;
          delete current.keyContent;
        } else if (value === 'control') {
          if (current.useControl === undefined) current.useControl = '';
          delete current.text;
          delete current.dataType;
          delete current.from;
          delete current.required;
          delete current.unit;
          delete current.value;
          delete current.referenceRange;
          delete current.columns;
          delete current.rows;
          delete current.tags;
        } else {
          if (current.useExpression === undefined) current.useExpression = '';
          delete current.text;
          delete current.dataType;
          delete current.from;
          delete current.required;
          /* 派生值的默认值由公式算出来，预设一个没有意义 */
          delete current.value;
          delete current.referenceRange;
          delete current.columns;
          delete current.rows;
        }
        slots[ti] = current;
      } else {
        const current = slots[ti] ?? { slot: 'text', key: '' };
        slots[ti] = current;
        if (field === 'key') current.key = String(value);
        else if (field === 'text') current.text = String(value);
        else if (field === 'alt') current.altText = String(value).trim() === '' ? undefined : String(value);
        else if (field === 'caption') current.caption = String(value).trim() === '' ? undefined : String(value);
        else if (field === 'itemtext' || field === 'itemfield' || field === 'itemtype'
          || field === 'itemunit' || field === 'itemlabel' || field === 'itemtags') {
          const ii = Number(columnText);
          const items = Array.isArray(current.items) ? current.items : (current.items = []);
          while (items.length <= ii) items.push({ text: '' });
          if (!items[ii] || typeof items[ii] !== 'object') items[ii] = { text: '' };
          const item = items[ii];
          if (field === 'itemtext') item.text = String(value);
          else if (field === 'itemfield') item.__enabled = value === true;
          else if (field === 'itemtype') item.__field = { ...(item.__field ?? {}), dataType: String(value) };
          else if (field === 'itemunit') {
            const draft = { ...(item.__field ?? {}) };
            if (String(value).trim() === '') delete draft.unit;
            else draft.unit = String(value).trim();
            item.__field = draft;
          } else if (field === 'itemlabel') item.__display = String(value);
          else item.__tags = parseSlotTags(value);
        } else if (field === 'listordered') {
          if (value === true) current.ordered = true;
          else delete current.ordered;
        }
        else if (field === 'unit') current.unit = String(value).trim() === '' ? undefined : String(value);
        else if (field === 'req') current.required = value === true;
        else if (field === 'type') current.dataType = String(value);
        else if (field === 'expr') current.useExpression = String(value);
        else if (field === 'ctrl') current.useControl = String(value);
        else if (field === 'from') current.from = String(value).trim() === '' ? undefined : String(value);
        else if (field === 'label') current.__display = String(value);
        else if (field === 'tags') current.__tags = parseSlotTags(value);
        else if (field === 'keyc') current.keyContent = value === true;
        else if (field === 'newp') current.newParagraph = String(value) === 'true';
        else if (field === 'value') current.__value = String(value);
        else if (field === 'rrlow') current.__rrlow = String(value);
        else if (field === 'rrhigh') current.__rrhigh = String(value);
        else if (field === 'rrtext') current.__rrtext = String(value);
        else if (field === 'rrunit') current.__rrunit = String(value);
        else if (field === 'rows') {
          const rows = Number(String(value).trim());
          if (Number.isInteger(rows) && rows >= 1 && rows <= 20) current.rows = rows;
          else delete current.rows;
        } else if (field === 'coltitle' || field === 'coltype' || field === 'colunit' || field === 'collabel' || field === 'coltags') {
          const ci = Number(columnText);
          const columns = Array.isArray(current.columns) ? current.columns : (current.columns = []);
          while (columns.length <= ci) columns.push({ title: '' });
          if (field === 'coltitle') columns[ci].title = String(value);
          else if (field === 'coltype') columns[ci].dataType = String(value);
          else if (field === 'collabel') columns[ci].__display = String(value);
          else if (field === 'coltags') columns[ci].__tags = parseSlotTags(value);
          else if (String(value).trim() === '') delete columns[ci].unit;
          else columns[ci].unit = String(value).trim();
        }
      }
    }
  }
  form.sections = form.sections.filter((section) => section !== undefined);
  for (const section of form.sections) {
    for (const slot of section.slots ?? []) {
      composeSlotDefaultValue(slot);
      composeSlotRange(slot);
      const columns = Array.isArray(slot.columns) ? slot.columns : [];
      columns.forEach((column, ci) => {
        if (column.__tags === undefined && column.__display === undefined) return;
        const tags = Array.isArray(column.__tags) ? column.__tags.map((tag) => ({ ...tag })) : [];
        const display = typeof column.__display === 'string' ? column.__display.trim() : '';
        if (display === '') {
          if (tags.length > 0) delete tags[0].display;
        } else if (tags.length > 0) {
          tags[0].display = display;
        } else if (String(slot.key ?? '') !== '') {
          tags.push({ system: 'local', code: `${String(slot.key)}.c${ci + 1}`, display });
        }
        if (tags.length > 0) column.tags = tags;
        else delete column.tags;
        delete column.__tags;
        delete column.__display;
      });
      const items = Array.isArray(slot.items) ? slot.items : [];
      items.forEach((item, ii) => {
        if (item.__enabled === undefined && item.__field === undefined
          && item.__display === undefined && item.__tags === undefined) return;
        const enabled = item.__enabled === true;
        const draft = item.__field ?? {};
        const display = typeof item.__display === 'string' ? item.__display.trim() : '';
        const tags = Array.isArray(item.__tags) ? item.__tags.map((tag) => ({ ...tag })) : [];
        delete item.__enabled;
        delete item.__field;
        delete item.__display;
        delete item.__tags;
        if (!enabled) {
          delete item.field;
          return;
        }
        const field = { dataType: String(draft.dataType ?? 'text') };
        if (draft.unit !== undefined && String(draft.unit).trim() !== '') field.unit = String(draft.unit).trim();
        if (display === '') {
          if (tags.length > 0) delete tags[0].display;
        } else if (tags.length > 0) {
          tags[0].display = display;
        } else if (String(slot.key ?? '') !== '') {
          tags.push({ system: 'local', code: `${String(slot.key)}.i${ii + 1}`, display });
        }
        if (tags.length > 0) field.tags = tags;
        item.field = field;
      });
      if (slot.__tags === undefined && slot.__display === undefined) continue;
      const tags = Array.isArray(slot.__tags) ? slot.__tags.map((tag) => ({ ...tag })) : [];
      const display = typeof slot.__display === 'string' ? slot.__display.trim() : '';
      if (display === '') {
        if (tags.length > 0) delete tags[0].display;
      } else if (tags.length > 0) {
        tags[0].display = display;
      } else if (String(slot.key ?? '') !== '') {
        tags.push({ system: 'local', code: String(slot.key), display });
      }
      if (tags.length > 0) slot.tags = tags;
      else delete slot.tags;
      delete slot.__tags;
      delete slot.__display;
    }
  }
  return form;
}

function parseSlotTags(raw) {
  try {
    const parsed = JSON.parse(String(raw ?? '[]'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function composeSlotDefaultValue(slot) {
  if (slot.__value === undefined) return;
  const raw = String(slot.__value).trim();
  delete slot.__value;
  if (raw === '') {
    delete slot.value;
    return;
  }
  const dataType = String(slot.dataType ?? 'text');
  if (dataType === 'number') {
    const num = Number(raw);
    slot.value = Number.isFinite(num) ? num : raw;
    return;
  }
  if (dataType === 'boolean') {
    slot.value = raw === 'true';
    return;
  }
  slot.value = raw;
}

const TPL_RANGE_FIELDS = [['low', '__rrlow'], ['high', '__rrhigh'], ['text', '__rrtext'], ['unit', '__rrunit']];

function composeSlotRange(slot) {
  if (TPL_RANGE_FIELDS.every(([, marker]) => slot[marker] === undefined)) return;
  const range = {};
  for (const [key, marker] of TPL_RANGE_FIELDS) {
    const raw = String(slot[marker] ?? '').trim();
    delete slot[marker];
    if (raw === '') continue;
    if (key === 'low' || key === 'high') {
      const num = Number(raw);
      /* 数字格填了非数字：不猜，交给内核校验报"必须是一个有限的数字" */
      range[key] = Number.isFinite(num) ? num : raw;
    } else {
      range[key] = raw;
    }
  }
  if (Object.keys(range).length === 0) {
    delete slot.referenceRange;
    return;
  }
  slot.referenceRange = range;
}

function slotMetaOf(sections) {
  const out = [];
  for (const section of Array.isArray(sections) ? sections : []) {
    for (const slot of section.slots ?? []) {
      const kind = String(slot.slot ?? 'text');
      if (kind === 'table' || kind === 'list' || kind === 'image') continue;
      const entry = {
        sectionCode: String(section.sectionCode ?? ''),
        key: String(slot.key ?? ''),
        keyContent: slot.keyContent === true,
      };
      if (kind === 'text' || kind === 'field' || kind === 'expression') {
        entry.display = slotTagOf(slot)?.display ?? null;
      }
      const isTextLike = kind === 'text' || kind === 'paragraph';
      if (!isTextLike) entry.unit = slot.unit ?? null;
      if (!isTextLike) entry.newParagraph = slot.newParagraph === true;
      if (kind === 'field') {
        entry.from = slot.from ?? null;
        entry.required = slot.required === true;
        entry.value = slot.value === undefined ? null : slot.value;
        entry.referenceRange = slot.referenceRange ?? null;
      }
      out.push(entry);
    }
  }
  return out;
}

function sectionMetaOf(sections) {
  const out = [];
  for (const section of Array.isArray(sections) ? sections : []) {
    out.push({
      sectionCode: String(section.sectionCode ?? ''),
      required: section.required === true,
      keyContent: section.keyContent === true,
      description: typeof section.description === 'string' && section.description.trim() !== ''
        ? section.description.trim()
        : null,
    });
  }
  return out;
}

function tplMoveTo(list, from, to) {
  if (!Array.isArray(list) || !Number.isInteger(from) || !Number.isInteger(to)) return false;
  if (from < 0 || from >= list.length || to < 0 || to >= list.length) return false;
  if (from === to) return false;
  const [moved] = list.splice(from, 1);
  list.splice(to, 0, moved);
  return true;
}

let TPL_DRAG = null;

function tplDropTargetOf(target) {
  const el = target && target.closest ? target : null;
  if (!el) return null;
  const section = el.closest('.tpl-sec');
  if (!section) return null;
  const si = Number(section.dataset.secIndex);
  if (!Number.isInteger(si)) return null;
  const slotRow = el.closest('.tpl-slot-row');
  if (slotRow) {
    const rows = Array.from(section.querySelectorAll('.tpl-slot-row'));
    return { kind: 'slot', si, ti: rows.indexOf(slotRow) };
  }
  return { kind: 'sec', si };
}

document.addEventListener('dragstart', (event) => {
  const handle = event.target && event.target.closest ? event.target.closest('[data-drag-sec],[data-drag-slot]') : null;
  if (!handle) return;
  if (handle.dataset.dragSec !== undefined) {
    TPL_DRAG = { kind: 'sec', si: Number(handle.dataset.dragSec), ti: -1 };
  } else {
    const [si, ti] = String(handle.dataset.dragSlot).split(':');
    TPL_DRAG = { kind: 'slot', si: Number(si), ti: Number(ti) };
  }
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', `l0-tpl-${TPL_DRAG.kind}`);
  }
});

document.addEventListener('dragend', () => { TPL_DRAG = null; });

document.addEventListener('dragover', (event) => {
  if (!TPL_DRAG) return;
  const drop = tplDropTargetOf(event.target);
  if (!drop) return;
  const acceptable = TPL_DRAG.kind === 'sec'
    ? drop.kind === 'sec'
    : drop.kind === 'slot' && drop.si === TPL_DRAG.si;
  if (!acceptable) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
});

document.addEventListener('drop', (event) => {
  if (!TPL_DRAG) return;
  const drag = TPL_DRAG;
  TPL_DRAG = null;
  const drop = tplDropTargetOf(event.target);
  if (!drop) return;
  const item = tplItemOf(TPL_DRAWER_ITEM);
  if (!item) return;
  const form = readTplEditForm();
  if (drag.kind === 'sec' && drop.kind === 'sec') {
    if (!tplMoveTo(form.sections, drag.si, drop.si)) return;
    event.preventDefault();
    renderTplEditForm(tplFormStateOf(item, form));
    setTplDrawerStatus(`已把第 ${drag.si + 1} 章拖到第 ${drop.si + 1} 章的位置（保存前都还没写进库）`);
    return;
  }
  if (drag.kind === 'slot' && drop.kind === 'slot' && drag.si === drop.si) {
    const section = form.sections[drag.si];
    if (!section || !tplMoveTo(section.slots, drag.ti, drop.ti)) return;
    event.preventDefault();
    renderTplEditForm(tplFormStateOf(item, form));
    setTplDrawerStatus(`已把「${section.title || `第 ${drag.si + 1} 章`}」里的第 ${drag.ti + 1} 格拖到第 ${drop.ti + 1} 格的位置（保存前都还没写进库）`);
  }
});

document.addEventListener('input', (event) => {
  const el = event.target;
  if (!el || !el.dataset) return;
  if (el.id === 'tplSearchName') {
    TPL_NAME_FILTER = String(el.value || '');
    TPL_PAGE = 1;
    renderTemplatePacks();
    return;
  }
  if (el.id === 'ruleSearchKeyword') {
    RULE_KEYWORD_FILTER = String(el.value || '');
    RULE_PAGE = 1;
    renderRuleTable(Array.isArray(((S || {}).knowledgePacks || {}).rules) ? S.knowledgePacks.rules : []);
    return;
  }
  if (el.id === 'exprSearchName') {
    EXPR_NAME_FILTER = String(el.value || '');
    EXPR_PAGE = 1;
    renderExprCatalog();
    return;
  }
  if (el.id === 'ctrlSearchName') {
    CTRL_NAME_FILTER = String(el.value || '');
    CTRL_PAGE = 1;
    renderCtrlCatalog();
    return;
  }
  if (el.id === 'ctrlNewShape') {
    readCtrlForm();
    if (CTRL_DRAFT) CTRL_DRAFT.shape = String(el.value || 'scale');
    renderCtrlForm();
    return;
  }
  if (el.dataset && el.dataset.ctrlField) {
    const card = el.closest ? el.closest('.ctrl-field') : null;
    if (card) card.classList.remove('bad');
  }
  if (el.id === 'ctrlNewName') el.classList.remove('bad');
  if (el.dataset.exprNum !== undefined) {
    TPL_EXPR_DRAFT = exprMutate(TPL_EXPR_DRAFT, String(el.dataset.exprNum), (node) => {
      const value = Number(el.value);
      node.value = Number.isFinite(value) ? value : 0;
      return node;
    });
    return;
  }
  if (el.dataset.exprSlot !== undefined) {
    TPL_EXPR_DRAFT = exprMutate(TPL_EXPR_DRAFT, String(el.dataset.exprSlot), (node) => {
      node.key = String(el.value);
      return node;
    });
  }
});

let TPL_EXPR_DRAFT = { kind: 'slot', key: '' };

let TPL_EXPR_EDIT_ID = '';
let TPL_EXPR_BASELINE = '';

const TPL_EXPR_KINDS = [['num', '数字'], ['slot', '填写项'], ['ctx', '系统字段'], ['fn', '函数']];

/** 换类别时给这一格一个**合法**的默认值：空节点会让"保存被拒"变成第一印象 */
function exprDefaultNodeOf(kind) {
  if (kind === 'num') return { kind: 'num', value: 0 };
  if (kind === 'slot') return { kind: 'slot', key: '' };
  if (kind === 'ctx') {
    const fields = Array.isArray(S && S.contextFields) ? S.contextFields : [];
    return { kind: 'ctx', key: fields.length > 0 ? fields[0].path : '' };
  }
  const functions = Array.isArray(S && S.expressionFunctions) ? S.expressionFunctions : [];
  const fn = functions[0];
  const args = [];
  for (let index = 0; index < (fn ? fn.minArgs : 1); index += 1) args.push({ kind: 'num', value: 0 });
  return { kind: 'fn', name: fn ? fn.name : 'add', args };
}

function exprSteps(path) {
  return String(path).split('.').slice(1).map((step) => Number(step));
}

function exprMutate(root, path, mutate) {
  const steps = exprSteps(path);
  if (steps.length === 0) return mutate(root);
  let parent = root;
  for (const step of steps.slice(0, -1)) parent = parent.args[step];
  parent.args[steps[steps.length - 1]] = mutate(parent.args[steps[steps.length - 1]]);
  return root;
}

function exprFunctionOf(name) {
  const list = Array.isArray(S && S.expressionFunctions) ? S.expressionFunctions : [];
  return list.find((fn) => fn.name === name) || null;
}

function exprFnOptions(selected) {
  const list = Array.isArray(S && S.expressionFunctions) ? S.expressionFunctions : [];
  if (list.length === 0) return '<option value="">（本机没有可用函数）</option>';
  return list.map((fn) => `<option value="${esc(fn.name)}"${fn.name === selected ? ' selected' : ''}>`
    + `${esc(fn.name)} —— ${esc(fn.doc)}</option>`).join('');
}

function exprContextOptions(selected) {
  const fields = Array.isArray(S && S.contextFields) ? S.contextFields : [];
  if (fields.length === 0) return '<option value="">（本机没有可引用的系统字段）</option>';
  return fields.map((field) => `<option value="${esc(field.path)}"${field.path === selected ? ' selected' : ''}>`
    + `${esc(field.label)}（${esc(field.path)}）</option>`).join('');
}

function exprNodeHtml(node, path, depth) {
  const kind = String(node && node.kind ? node.kind : 'num');
  const indent = `style="margin-left:${Math.min(depth, 8) * 16}px"`;
  const kindSelect = `<select data-expr-kind="${path}" title="这一格是什么">`
    + TPL_EXPR_KINDS.map(([value, label]) => `<option value="${value}"${kind === value ? ' selected' : ''}>${label}</option>`).join('')
    + '</select>';
  if (kind === 'num') {
    return `<div class="expr-node" ${indent}>${kindSelect}`
      + `<input type="number" step="any" data-expr-num="${path}" value="${esc(String(node.value ?? 0))}" placeholder="数字" /></div>`;
  }
  if (kind === 'slot') {
    return `<div class="expr-node" ${indent}>${kindSelect}`
      + `<input type="text" data-expr-slot="${path}" value="${esc(node.key ?? '')}" placeholder="填写项的 key（如 height）" `
      + 'title="按 key 引用**某一份文书**里的填写项：控件本身不绑文书，引用对不对在用到它的那份文书里校验" /></div>';
  }
  if (kind === 'ctx') {
    return `<div class="expr-node" ${indent}>${kindSelect}`
      + `<select data-expr-ctx="${path}">${exprContextOptions(node.key)}</select></div>`;
  }
  const fn = exprFunctionOf(node.name);
  const minArgs = fn ? fn.minArgs : 1;
  const maxArgs = fn && fn.maxArgs !== null ? fn.maxArgs : Number.POSITIVE_INFINITY;
  const args = Array.isArray(node.args) ? node.args : [];
  const argHtml = args.map((arg, index) => exprNodeHtml(arg, `${path}.${index}`, depth + 1)).join('');
  return `<div class="expr-fn" ${indent}>
    <div class="expr-node">${kindSelect}
      <select data-expr-fn="${path}" title="选一个**登记过的**函数；界面能选、引擎不认是这里最要避免的错">${exprFnOptions(node.name)}</select>
      ${args.length < maxArgs ? `<button class="secondary" data-expr-addarg="${path}" title="再加一个参数">＋参数</button>` : ''}
      ${args.length > minArgs ? `<button class="danger" data-expr-delarg="${path}" title="去掉最后一个参数">－参数</button>` : ''}
    </div>
    ${argHtml}
  </div>`;
}

function renderExprTree() {
  const box = $('exprTree');
  if (box) box.innerHTML = exprNodeHtml(TPL_EXPR_DRAFT, '0', 0);
}

function renderExprForm(item) {
  const box = $(tplDrawerBodyId());
  if (!box) return;
  const editing = !!item;
  box.innerHTML = `
    <div class="tpl-edit-box">
      <div class="tpl-drawer-status" data-tpl-drawer-status></div>
      <div class="row">
        <span>名称</span>
        <input type="text" id="exprNewName" placeholder="如 BMI" value="${esc((item && item.name) || '')}" />
        <span>单位</span>
        <input type="text" id="exprNewUnit" placeholder="如 kg/m²（可留空）" value="${esc((item && item.unit) || '')}" />
      </div>
      <div class="row">
        <span>说明</span>
        <input type="text" id="exprNewDesc" placeholder="一句话说明它算什么（可留空）" value="${esc((item && item.description) || '')}" />
      </div>
      <div class="expr-tree" id="exprTree"></div>
      <div class="row">
        <button class="primary" data-expr-create-submit="1">${editing ? '保存改动' : '保存'}</button>
        <button class="secondary" data-tpl-create-cancel="1">取消</button>
      </div>
    </div>`;
  renderExprTree();
}

function renderTplCreateForm() {
  const box = $(tplDrawerBodyId());
  if (!box) return;
  /* 字典里**启用中**的类型就是全部可选项（停用的选不到，与科室一致） */
  const dict = S.docTypes && Array.isArray(S.docTypes.items)
    ? S.docTypes.items.filter((item) => item && item.enabled !== false)
    : [];
  const fromDict = dict.length > 0;
  const known = fromDict
    ? dict.map((item) => ({ key: `${item.system}/${item.code}`, code: item.code, display: item.display, system: item.system }))
    : [];
  if (!fromDict) {
    for (const item of Array.isArray(S.templateCatalog) ? S.templateCatalog : []) {
      if (item.itemType !== 'template' || !item.docType) continue;
      const key = `${item.docType.system}/${item.docType.code}`;
      if (known.some((option) => option.key === key)) continue;
      known.push({ key, code: item.docType.code, display: item.docType.display, system: item.docType.system });
    }
  }
  box.innerHTML = `
    <div class="tpl-edit-box">
      <div class="tpl-field">
        <span class="tpl-label">名称</span>
        <input type="text" id="tplNewName" placeholder="如：产科门诊病历" />
      </div>
      <div class="tpl-field">
        <span class="tpl-label">文书类型</span>
        <select id="tplNewDocType">
          ${known.length === 0 ? '<option value="">（还没有可用类型）</option>' : ''}
          ${known.map((option) => `<option value="${esc(option.key)}">${esc(option.display)}（${esc(option.code)}）</option>`).join('')}
        </select>
        <div class="muted">${fromDict
          ? '类型只来自「基础数据 → 文书类型」：要加新类型，先去那里加一行（在这里手打编码，质控规则认不出它）。'
          : '还没建文书类型，下面这些是从已有模板反推的。<b>建议先去「基础数据 → 文书类型」把类型定下来</b>，否则同一个"入院记录"会有几种写法。'}</div>
      </div>
      <div class="tpl-field">
        <span class="tpl-label">适用科室</span>
        <div class="tpl-depts" id="tplNewDept">${tplDeptPickerHtml([])}</div>
      </div>
      <div class="form-actions">
        <button class="primary" data-tpl-create-submit="1">建为草稿</button>
        <button class="secondary" data-tpl-create-cancel="1">取消</button>
      </div>
    </div>`;
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
}

function renderCapturePanel() {
  const cap = S.capture || {};
  const segment = cap.segment || {};
  const vendors = Array.isArray(cap.vendors) ? cap.vendors : [];
  const kind = cap.kind || 'intranet-task';

  const select = $('cfgCaptureKind');
  const wanted = vendors.map((item) => `<option value="${esc(item.kind)}">${esc(item.label)}</option>`).join('');
  if (select.dataset.rendered !== wanted) {
    select.innerHTML = wanted;
    select.dataset.rendered = wanted;
  }
  select.value = kind;
  applyCaptureVendorUi(kind);

  $('cfgCaptureEndpoint').value = cap.endpoint || '';
  $('cfgCaptureModel').value = cap.modelId || '';
  $('cfgCaptureAppKey').value = cap.appKey || '';
  $('cfgCaptureSubmitTimeout').value = cap.submitTimeoutMs || 15000;
  $('cfgCapturePollInterval').value = cap.pollIntervalMs || 1000;
  $('cfgCapturePollTimeout').value = cap.pollTimeoutMs || 90000;
  $('cfgCaptureSilence').value = segment.silenceMs || 800;
  $('cfgCaptureMaxSeconds').value = segment.maxSeconds || 30;
  $('cfgCaptureMinSeconds').value = segment.minSeconds || 1;
  $('cfgCaptureRetain').value = cap.retainAudio ? 'true' : 'false';
  $('cfgCaptureAck').checked = cap.acknowledgePublicCloud === true;

  $('cfgCaptureChip').textContent = cap.configured ? '已配置' : '未配置';
  $('cfgCaptureChip').className = cap.configured ? 'chip ok' : 'chip warn';
}

function applyCaptureVendorUi(kind) {
  const cap = S.capture || {};
  const vendors = Array.isArray(cap.vendors) ? cap.vendors : [];
  const vendor = vendors.find((item) => item.kind === kind) || {};
  const shape = vendor.credentialShape || 'none-or-token';

  $('cfgCaptureEndpoint').placeholder = vendor.defaultEndpoint
    ? `${vendor.defaultEndpoint}（该服务的默认地址，可改）`
    : '院内服务的地址，形如 https://asr.院内域名/（留空 = 未配置：采集入口随之不可用）';
  $('cfgCaptureModel').placeholder = vendor.modelIdHint || '须带版本/日期';

  const usesSecret = shape === 'access-key-pair';
  const usesAppKey = shape === 'nls-token-and-appkey';
  const showKey = shape !== 'none-or-token' || cap.apiKeyPresent === true;
  $('cfgCaptureKeyLabel').hidden = !showKey;
  $('cfgCaptureKey').hidden = !showKey;
  $('cfgCaptureSecretLabel').hidden = !usesSecret;
  $('cfgCaptureSecret').hidden = !usesSecret;
  $('cfgCaptureAppKeyLabel').hidden = !usesAppKey;
  $('cfgCaptureAppKey').hidden = !usesAppKey;
  $('cfgCaptureKeyLabel').textContent = shape === 'access-key-pair' ? 'Access Key' : shape === 'nls-token-and-appkey' ? 'Token' : '凭据（可选）';
  $('cfgCaptureClearSecret').hidden = !usesSecret;

  $('cfgCaptureCloudWarn').hidden = vendor.leavesIntranet !== true;
  $('cfgCaptureAck').checked = false;
  $('cfgCaptureProtocol').textContent = [vendor.protocol, vendor.timingNote].filter(Boolean).join('；');
}

function syncCaptureKindHint(kind) {
  const vendors = Array.isArray(S.capture && S.capture.vendors) ? S.capture.vendors : [];
  const vendor = vendors.find((item) => item.kind === kind);
  if (!vendor) return;
  const current = $('cfgCaptureEndpoint').value.trim();
  if (current !== '' && vendor.defaultEndpoint && current !== vendor.defaultEndpoint) {
    setCaptureStatus(`已切到「${vendor.label}」：地址仍是 ${current} —— 换一家就要重新核对音频发往哪里，确认后再保存。`);
    return;
  }
  if (current === '' && vendor.defaultEndpoint) {
    setCaptureStatus(`「${vendor.label}」的地址可以填 ${vendor.defaultEndpoint}（示例已写进输入框的提示里）。`);
    return;
  }
  setCaptureStatus('');
}

async function saveCaptureFromForm(apiKeyOverride, apiSecretOverride) {
  const body = {
    kind: $('cfgCaptureKind').value,
    endpoint: $('cfgCaptureEndpoint').value.trim(),
    modelId: $('cfgCaptureModel').value.trim(),
    appKey: $('cfgCaptureAppKey').value.trim(),
    acknowledgePublicCloud: $('cfgCaptureAck').checked === true,
    submitTimeoutMs: Number($('cfgCaptureSubmitTimeout').value),
    pollIntervalMs: Number($('cfgCapturePollInterval').value),
    pollTimeoutMs: Number($('cfgCapturePollTimeout').value),
    silenceMs: Number($('cfgCaptureSilence').value),
    maxSeconds: Number($('cfgCaptureMaxSeconds').value),
    minSeconds: Number($('cfgCaptureMinSeconds').value),
    retainAudio: $('cfgCaptureRetain').value === 'true',
  };
  const typedKey = $('cfgCaptureKey').value;
  if (apiKeyOverride === null) body.apiKey = null;
  else if (typedKey !== '') body.apiKey = typedKey;
  const typedSecret = $('cfgCaptureSecret').value;
  if (apiSecretOverride === null) body.apiSecret = null;
  else if (typedSecret !== '') body.apiSecret = typedSecret;

  const saving = typeof body.apiKey === 'string' || typeof body.apiSecret === 'string';
  if (saving) setCaptureStatus('正在保存…凭据落盘要做口令派生（约 10~15 秒），请勿重复点击');
  const r = await api('/api/capture-config', body);
  if (r.ok) {
    $('cfgCaptureKey').value = '';
    $('cfgCaptureSecret').value = '';
    const describe = (action, what) => `${what}：${action === 'set' ? '已更新' : action === 'cleared' ? '已清除' : '未改动'}`;
    const usable = r.data && r.data.configured;
    setCaptureStatus(
      `已保存（${describe(r.data && r.data.apiKeyAction, '主凭据')}；${describe(r.data && r.data.apiSecretAction, '次凭据')}）`
        + (usable ? '；采集入口可用' : '；**仍未配置完整**，采集入口仍不可用（上面写了缺哪一格）'),
    );
    await apply(r);
  } else {
    setCaptureStatus(`保存失败：${(r && (r.message || r.code)) || '未知原因'}`);
    await requireSession();
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
}

function renderPrevisitAccessPanel() {
  const cfg = S.previsitAccess || {};
  if (cfg.error) {
    $('cfgPrevisitChip').textContent = '配置解不开';
    $('cfgPrevisitChip').className = 'chip bad';
    setPrevisitStatus(`读配置失败：${cfg.error}`);
    return;
  }
  $('cfgPrevisitEnabled').value = cfg.enabled === true ? 'true' : 'false';
  $('cfgPrevisitKey').value = '';
  $('cfgPrevisitKey').placeholder = cfg.keyPresent
    ? '已配置接入密钥：留空 = 不修改（原文不可回显，忘了只能重设）'
    : '至少 24 个字符的随机串（不是人记的口令）';
  $('cfgPrevisitChip').textContent = cfg.effective ? '已启用校验' : cfg.enabled ? '配置不完整' : '未校验';
  $('cfgPrevisitChip').className = `chip ${cfg.effective ? 'ok' : 'bad'}`;
  setPrevisitStatus(cfg.note || '');
}

function pemFromBase64(base64) {
  const wrapped = String(base64 || '').replace(/(.{64})/g, '$1\n').trim();
  return `-----BEGIN PUBLIC KEY-----\n${wrapped}\n-----END PUBLIC KEY-----`;
}

function renderRecipientKeys() {
  const keyBody = $('rkBody');
  if (!keyBody) return;
  const keyStore = S.recipientKeys || { keys: [], error: null };
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

let currentAdminView = 'config';

function selectAdminView(name) {
  currentAdminView = name;
  document.querySelectorAll('[data-admin-view]').forEach((btn) => {
    const active = btn.dataset.adminView === name;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  document.querySelectorAll('[data-admin-view-pane]').forEach((pane) => {
    pane.classList.toggle('active', pane.dataset.adminViewPane === name);
  });
  const meta = VIEW_META[name];
  if (meta) {
    $('viewTitle').textContent = meta.title;
    $('viewSub').textContent = meta.sub;
    document.title = `${meta.title} · 管理后台`;
  }
}

async function loadAdminView(name) {
  if (name === 'accounts') {
    const r = await api('/api/admin/users');
    if (r.ok) renderAccounts(r.data);
    else setLoginStatus(`读取账号失败：${r.message || r.code || '未知原因'}`, true);
    return;
  }
  if (name === 'health') {
    const r = await api('/api/admin/health');
    if (r.ok) renderHealth(r);
    else setLoginStatus(`读取运行状态失败：${r.message || r.code || '未知原因'}`, true);
    return;
  }
  if (name === 'audit') {
    const r = await api('/api/admin/audit');
    if (r.ok) renderAudit(r);
    else setLoginStatus(`读取审计失败：${r.message || r.code || '未知原因'}`, true);
    return;
  }
  if (name === 'master') {
    const [dept, docTypes] = await Promise.all([api('/api/departments'), api('/api/doc-types')]);
    if (dept.ok) renderDepartments(dept.data);
    else setLoginStatus(`读取科室字典失败：${dept.message || dept.code || '未知原因'}`, true);
    if (docTypes.ok) renderDocTypes(docTypes.data);
    else setLoginStatus(`读取文书类型失败：${docTypes.message || docTypes.code || '未知原因'}`, true);
    renderPredicates();
    renderExprCatalog();
    renderCtrlCatalog();
    return;
  }
  if (name === 'system') {
    const r = await api('/api/admin/system');
    if (r.ok) renderSystem(r);
    else setLoginStatus(`读取系统信息失败：${r.message || r.code || '未知原因'}`, true);
  }
}

function conditionParamRange(spec) {
  if (Array.isArray(spec.options) && spec.options.length > 0) return spec.options.join(' / ');
  if (spec.kind === 'integer' || spec.kind === 'number') return spec.required ? '必填的正数' : '不填按内置值判';
  if (spec.kind === 'string-list') return '词表（逗号或顿号分隔）';
  if (spec.kind === 'boolean') return '是 / 否';
  return spec.required ? '必填' : '不限';
}

function renderConditionCatalog() {
  const box = $('conditionBody');
  if (!box) return;
  const catalog = conditionCatalogOf();
  const chip = $('conditionChip');
  if (chip) chip.textContent = catalog.fields.length === 0 ? '未载入' : `${catalog.fields.length} 个字段 · ${catalog.operators.length} 个算子`;
  if (catalog.fields.length === 0) {
    box.innerHTML = '<div class="muted">没有收到字段表与算子表（<span class="mono">qcCondition</span>）：刷新一次；仍是空的，说明服务端与界面不是同一版。</div>';
    return;
  }
  const fieldRows = catalog.fields.map((item) => `
    <tr>
      <td class="mono">${esc(item.name)}</td>
      <td>${esc(item.label)}</td>
      <td>${item.scope === 'document' ? '适用范围' : '判定条件'}</td>
      <td class="muted">${esc(item.doc)}</td>
    </tr>`).join('');
  const operatorRows = catalog.operators.map((item) => {
    const fields = item.fields.map((name) => {
      const spec = conditionFieldSpecOf(name);
      return spec ? spec.label : name;
    }).join(' / ');
    const value = item.value === null
      ? '不接受取值'
      : item.value.kind === 'string-list' ? '词表'
        : item.value.kind === 'integer' ? `整数${item.value.unit ? `（${item.value.unit}）` : ''}`
          : item.value.kind === 'boolean' ? '是 / 否'
            : (item.value.options || []).map((option) => option.label).join(' / ');
    return `<tr>
      <td class="mono">${esc(item.name)}</td>
      <td>${esc(item.label)}</td>
      <td class="muted">${esc(fields)}</td>
      <td class="muted">${esc(value)}</td>
      <td class="muted">${esc(item.doc)}</td>
    </tr>`;
  }).join('');
  box.innerHTML = `
    <div class="predicate-card">
      <div class="cfg-head"><b>字段</b><span class="chip">决定"读什么"</span></div>
      <table class="mini tpl-table">
        <thead><tr><th>内部名</th><th>人话名</th><th>归在哪一组</th><th>说明</th></tr></thead>
        <tbody>${fieldRows}</tbody>
      </table>
    </div>
    <div class="predicate-card">
      <div class="cfg-head"><b>算子</b><span class="chip">决定"怎么算"</span></div>
      <table class="mini tpl-table">
        <thead><tr><th>内部名</th><th>人话名</th><th>可用字段</th><th>取值</th><th>说明</th></tr></thead>
        <tbody>${operatorRows}</tbody>
      </table>
    </div>${pluginCardHtml()}`;
}

function renderPredicates() {
  renderConditionLibrary();
  renderConditionCatalog();
}

function pluginCardHtml() {
  const info = S && S.qcPlugins ? S.qcPlugins : null;
  if (!info) return '';
  const loaded = Array.isArray(info.loaded) ? info.loaded : [];
  const failures = Array.isArray(info.failures) ? info.failures : [];
  const rows = loaded.map((item) => `<tr>
      <td class="mono">${esc(item.pluginId)}</td>
      <td>${esc(item.name)}<div class="muted">v${esc(String(item.version))} · 密钥标识 ${esc(String(item.keyId))}</div></td>
      <td class="muted">${esc((item.operators || []).join(' / '))}</td>
      <td class="muted mono">${esc(item.dir)}</td>
    </tr>`).join('');
  const failed = failures.map((item) => `<div class="hint">（${esc(item.code)}）${esc(item.dir)}：${esc(item.reason)}</div>`).join('');
  const body = loaded.length === 0 && failures.length === 0
    ? `<div class="muted">${info.dirPresent === false
      ? `这台机器没有安装插件（<span class="mono">${esc(String(info.root))}</span> 不存在）：只用内核自带的算子。`
      : `插件目录是空的（<span class="mono">${esc(String(info.root))}</span>）：只用内核自带的算子。`}</div>`
    : `<table class="mini tpl-table">
        <thead><tr><th>插件</th><th>版本</th><th>带来的算子</th><th>目录</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>${failed}`;
  return `<div class="predicate-card">
      <div class="cfg-head"><b>算子插件</b><span class="chip">部署方安装的签名组件</span></div>
      ${body}
      <div class="hint">插件是<b>代码</b>，必须验签（签名覆盖清单、清单覆盖文件）；规则包是<b>数据</b>，不签也收。
        加一个算子不必与应用同版本发版，但它必须由部署方签名安装 —— 见 <span class="mono">src/qc/plugin.ts</span>。</div>
    </div>`;
}

const CONDITION_LIB_BODY_ID = 'conditionLibraryBody';
let CONDITION_DRAWER_ITEM = '';

function setConditionLibStatus(text) { markCfgStatus($('conditionLibStatus'), text); }

function conditionUsedByHtml(usedBy) {
  const users = Array.isArray(usedBy) ? usedBy : [];
  if (users.length === 0) return '<span class="chip warn">还没有规则引用</span>';
  const enabled = users.filter((user) => user.enabled).length;
  const packs = new Set(users.map((user) => String(user.packId || '')));
  return `<span class="chip ok">${users.length} 条规则引用（启用 ${enabled}）</span>`
    + (packs.size > 1 ? `<div class="muted">分布在 ${packs.size} 个包</div>` : '')
    + `<div class="muted">${users.map((user) => esc(`${user.packId ? `${user.packId} / ` : ''}${user.title}`)).join('、')}</div>`;
}

function conditionParamsInlineHtml(item) {
  const params = Array.isArray(item.params) ? item.params : [];
  if (params.length === 0) return '<div class="muted">不带参数</div>';
  return `<div class="muted">参数：${params
    .map((spec) => `<span class="mono">$${esc(spec.name)}</span>（${esc(spec.label)} · ${spec.required ? '必填' : '可留空'} · ${esc(conditionParamRange(spec))}）`)
    .join('、')}</div>`;
}

function conditionLibRowHtml(item) {
  const itemId = esc(item.itemId);
  const summary = typeof item.summary === 'string' && item.summary !== ''
    ? esc(item.summary)
    : '<span class="chip warn">条件读不出来</span>';
  return `<tr class="tpl-row">
      <td class="mono">${itemId}</td>
      <td class="tpl-name">${esc(item.name)}${item.description ? `<div class="muted">${esc(item.description)}</div>` : ''}</td>
      <td class="muted">${summary}${conditionParamsInlineHtml(item)}</td>
      <td>${conditionUsedByHtml(item.usedBy)}</td>
      <td class="tpl-ops">
        <button class="secondary" data-condlib-edit="${itemId}"
          title="改这条判定方式：名称 / 说明 / 参数表 / 条件本身。它是一份**共用资产**（判定方式库，不属于任何包），改一次会**影响所有引用它的规则**（可能跨好几个包）">编辑</button>
        <button class="secondary" data-condlib-copy="${itemId}"
          title="以这条为模板复制一条（新编码，两条从此互不影响）：改口径之前先留一份">复制</button>
        <button class="danger" data-condlib-delete="${itemId}"
          title="删这条判定方式：被任何包的规则引用时都会被拒（报错里会列出那几条规则与它们在哪个包）">删除</button>
      </td>
    </tr>`;
}

function renderConditionLibrary() {
  const box = $(CONDITION_LIB_BODY_ID);
  if (!box) return;
  const items = conditionItemsOfState();
  const library = (S || {}).qcConditionLibrary || {};
  const referenced = items.filter((item) => Array.isArray(item.usedBy) && item.usedBy.length > 0).length;
  const users = items.reduce((sum, item) => sum + (Array.isArray(item.usedBy) ? item.usedBy.length : 0), 0);
  const rules = Array.isArray(((S || {}).knowledgePacks || {}).rules) ? S.knowledgePacks.rules : [];
  const chip = $('conditionLibChip');
  if (chip) {
    chip.textContent = items.length === 0 ? '库里没有判定方式' : `${items.length} 条`;
    chip.className = `chip${items.length === 0 ? ' warn' : ' ok'}`;
  }
  const summary = $('conditionLibSummary');
  if (summary) {
    summary.innerHTML = chips([
      ['判定方式', `${items.length} 条`],
      ['被规则引用', `${referenced} 条（共 ${users} 条规则）`],
      ['规则库', `${rules.length} 条`],
      ['改动方式', '均可改可删（被规则引用时拒删）'],
      ['最近改动', typeof library.updatedBy === 'string' && library.updatedBy !== ''
        ? `${library.updatedBy} · ${String(library.updatedAt ?? '').replace('T', ' ').slice(0, 19)}`
        : '（还没改过）'],
    ]);
  }
  if (items.length === 0) {
    box.innerHTML = '<div class="muted">库里还没有判定方式。出厂那几条（缺记录时间 / 必填为空 / '
      + '占位符未替换 / 时限类三条）由种子在首次启动时写进库里一次，此后归本院维护'
      + '（改掉、删掉都不会在下次启动被覆盖或长回来）。这一页也可以自己新建 —— 它只在'
      + '"多条规则共用同一套口径"时才值得建：改一处、引它的规则一起变，'
      + '只给一条规则用的口径，直接在规则里就地拼更省事。</div>';
    return;
  }
  box.innerHTML = `<table class="mini tpl-table">
      <thead><tr><th>编码</th><th>名称</th><th>判定条件与参数</th><th>谁在用它</th><th>操作</th></tr></thead>
      <tbody>${items.map((item) => conditionLibRowHtml(item)).join('')}</tbody>
    </table>`;
}

let CONDITION_DRAWER_OPENER = null;

function openConditionDrawer(title, desc) {
  const dialog = $('conditionDrawer');
  if (!dialog) return;
  const titleEl = $('conditionDrawerTitle');
  const descEl = $('conditionDrawerDesc');
  if (titleEl) titleEl.textContent = title;
  if (descEl) descEl.innerHTML = desc;
  CONDITION_DRAWER_OPENER = document.activeElement;
  dialog.showModal();
  syncTplDrawerScrollLock();
}

function closeConditionDrawer() {
  const dialog = $('conditionDrawer');
  if (dialog && dialog.open) dialog.close();
}

function bindConditionDrawerOnce() {
  const dialog = $('conditionDrawer');
  if (!dialog) return;
  dialog.addEventListener('close', () => {
    const body = $('conditionDrawerBody');
    if (body) body.innerHTML = '';
    CONDITION_DRAWER_ITEM = '';
    syncTplDrawerScrollLock();
    if (CONDITION_DRAWER_OPENER && typeof CONDITION_DRAWER_OPENER.focus === 'function') CONDITION_DRAWER_OPENER.focus();
    CONDITION_DRAWER_OPENER = null;
  });
  /* 点遮罩关掉它：与另外两个抽屉同一条口径（按坐标判，点在抽屉内边距上不算点遮罩） */
  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    const inBox = event.clientX >= rect.left && event.clientX <= rect.right
      && event.clientY >= rect.top && event.clientY <= rect.bottom;
    if (!inBox) closeConditionDrawer();
  });
}

const CONDITION_PARAM_KINDS = [
  ['integer', '正整数'],
  ['string', '单行文本'],
  ['enum', '枚举'],
  ['string-list', '词表'],
  ['boolean', '真 / 假'],
];

function conditionParamRowsHtml(params) {
  const list = Array.isArray(params) ? params : [];
  if (list.length === 0) {
    return '<div class="muted">（这条判定方式不带参数：引用它的规则只把条件原样拿去用）</div>';
  }
  return list.map((spec) => `<div class="cond-param-row" data-cond-param-row="1">
      <input data-cond-param-field="name" value="${esc(spec.name)}" placeholder="参数名（如 limitHours）" />
      <select data-cond-param-field="kind">
        ${CONDITION_PARAM_KINDS.map(([kind, label]) => `<option value="${esc(kind)}"${kind === spec.kind ? ' selected' : ''}>${esc(label)}</option>`).join('')}
      </select>
      <input data-cond-param-field="label" value="${esc(spec.label || '')}" placeholder="人话标签（规则表单上那一格的标题）" />
      <label class="cond-param-flag"><input type="checkbox" data-cond-param-field="required"${spec.required ? ' checked' : ''} /> 必填</label>
      <input data-cond-param-field="options" value="${esc(Array.isArray(spec.options) ? spec.options.join('、') : '')}" placeholder="枚举选项（逗号分隔，只有枚举要填）" />
      <input data-cond-param-field="unit" value="${esc(spec.unit || '')}" placeholder="单位（如 小时 / 字，只有数字要填）" />
      <input data-cond-param-field="doc" value="${esc(spec.doc || '')}" placeholder="说明（必填：这一格填什么、留空会怎样）" />
      <button class="danger" data-cond-param-del="1" title="删掉这个参数">删</button>
    </div>`).join('');
}

function readConditionParams(box) {
  const out = [];
  if (!box) return out;
  box.querySelectorAll('[data-cond-param-row]').forEach((row) => {
    const field = (name) => {
      const el = row.querySelector(`[data-cond-param-field="${name}"]`);
      if (!el) return '';
      return String(el.value === undefined || el.value === null ? '' : el.value).trim();
    };
    const name = field('name');
    if (name === '') return;
    const spec = { name, kind: field('kind') || 'integer', label: field('label'), doc: field('doc') };
    const requiredEl = row.querySelector('[data-cond-param-field="required"]');
    if (requiredEl && requiredEl.checked) spec.required = true;
    const unit = field('unit');
    if (unit !== '') spec.unit = unit;
    if (spec.kind === 'enum') {
      spec.options = field('options').split(/[,，、;；]/).map((part) => part.trim()).filter((part) => part !== '');
    }
    out.push(spec);
  });
  return out;
}

function renderConditionForm(seed) {
  const box = $('conditionDrawerBody');
  if (!box) return;
  const creating = seed.itemId === '';
  const draft = conditionDraftFromCondition(seed.when);
  const locked = draft.nested > 0;
  const users = Array.isArray(seed.usedBy) ? seed.usedBy : [];
  box.innerHTML = `
    <div class="tpl-edit-box">
      <div class="tpl-field">
        <span class="tpl-label">条件编码</span>
        <div class="mono">${creating ? '（保存后由系统生成，形如 C-CUSTOM-1）' : esc(seed.itemId)}</div>
        <div class="hint">编码是<b>引用键</b>：引用这条条件的规则写的就是它 —— 所以不给改，改它等于换一条新条件（那些规则会立刻变成悬空引用）。</div>
      </div>
      <div class="tpl-field">
        <span class="tpl-label">名称</span>
        <input type="text" data-cond-input="name" value="${esc(seed.name)}"
          placeholder="如：病程记录缺少记录时间" title="条件库里按它挑，所以名称要一眼分得出这条条件管什么" />
      </div>
      <div class="tpl-field">
        <span class="tpl-label">说明（留空 = 不写）</span>
        <textarea data-cond-input="description" rows="2"
          placeholder="写给同事看的一句话：这条条件管什么、为什么这么定">${esc(seed.description)}</textarea>
      </div>
      ${creating ? '' : `<div class="tpl-field">
        <span class="tpl-label">这条条件的引用面</span>
        ${conditionUsedByHtml(users)}
        <div class="hint">改完会<b>立刻</b>作用到这 ${users.length} 条规则上（下一轮质控生效）：内容指纹变、前后指纹进系统审计。</div>
      </div>`}
      <div class="tpl-cell">
        <span class="tpl-label">参数（留空 = 这条判定方式不带参数）</span>
        <div class="cond-params" id="condParamsBox">${conditionParamRowsHtml(seed.params)}</div>
        <button class="secondary" data-cond-param-add="1">加一个参数</button>
        <div class="hint">带了参数，这条判定方式就能被多条规则以不同阈值复用：条件树里把那一格的值写成 <span class="mono">$参数名</span>，规则里再填实参。
          <b>声明了却没用到的参数会被拒</b> —— 那会让规则表单上出现一个"填了也不生效"的格。</div>
      </div>
      <div class="tpl-cell">
        <span class="tpl-label">条件（适用范围 + 字段 · 算子 · 取值）</span>
        <div class="cond-builder" id="${esc(CONDITION_BUILDER_ID)}" data-cond-locked="${locked ? '1' : '0'}">${conditionBlockBodyHtml(draft)}</div>
      </div>
      <div class="form-actions">
        <button class="primary" data-cond-submit="${creating ? 'create' : 'update'}">${creating ? '建为可用' : '保存'}</button>
        <button class="secondary" data-cond-cancel="1">取消</button>
      </div>
    </div>`;
}

function readConditionForm() {
  const box = $('conditionDrawerBody');
  const out = { name: '', description: '', params: [], conditionLocked: false, conditionPending: false, when: null };
  if (!box) return out;
  out.params = readConditionParams($('condParamsBox'));
  box.querySelectorAll('[data-cond-input]').forEach((el) => {
    const key = el.dataset.condInput;
    if (key === 'name') out.name = String(el.value === undefined ? '' : el.value).trim();
    else if (key === 'description') out.description = String(el.value === undefined ? '' : el.value).trim();
  });
  const builder = $(CONDITION_BUILDER_ID);
  if (builder) {
    out.conditionLocked = builder.dataset.condLocked === '1';
    if (!out.conditionLocked) {
      const when = readConditionDraftFrom(builder);
      if (when.children.length > 0) out.when = when;
      else out.conditionPending = true;
    }
  }
  return out;
}

function renderConditionEditForm(item) {
  CONDITION_DRAWER_ITEM = item.itemId;
  openConditionDrawer(`编辑判定方式：${item.name || item.itemId}`, '');
  renderConditionForm({
    itemId: item.itemId,
    name: item.name || '',
    description: item.description || '',
    params: Array.isArray(item.params) ? item.params : [],
    when: item.when,
    usedBy: Array.isArray(item.usedBy) ? item.usedBy : [],
  });
}

function renderConditionCreateForm(seed) {
  CONDITION_DRAWER_ITEM = '';
  CONDITION_DRAWER_PACK = '';
  const source = seed && typeof seed === 'object' ? seed : {};
  openConditionDrawer(
    source.itemId ? `复制判定方式（源自「${source.name || source.itemId}」）` : '新建：判定方式',
    '',
  );
  renderConditionForm({
    itemId: '',
    name: source.name || '',
    description: source.description || '',
    params: Array.isArray(source.params) ? source.params : [],
    when: source.when === undefined ? null : source.when,
    usedBy: [],
  });
}

function renderDepartments(data) {
  const view = data && typeof data === 'object' ? data : { items: [], source: 'empty', error: null };
  const items = Array.isArray(view.items) ? view.items : [];
  const enabled = items.filter((item) => item.enabled !== false).length;

  const chip = $('deptChip');
  if (chip) {
    chip.textContent = view.error
      ? '读不出来'
      : items.length === 0
        ? '尚未建任何科室'
        : `${items.length} 个（启用 ${enabled}）`;
    chip.className = `chip${view.error ? ' danger' : items.length === 0 ? ' warn' : ' ok'}`;
  }
  const summary = $('deptSummary');
  if (summary) {
    summary.innerHTML = chips([
      ['来源', view.source === 'store' ? '数据库（唯一来源）' : '库里没有科室', view.source === 'store' ? 'ok' : 'warn'],
      ['最近改动', view.updatedBy ? `${view.updatedBy} · ${fmtShort(view.updatedAt)}` : '—', 'mono'],
      /* 读不出来必须显眼：那会让所有"限科室"的判定都失去依据 */
      ['读库情况', view.error || '正常', view.error ? 'danger' : 'ok'],
    ]);
  }

  const body = $('deptBody');
  if (!body) return;
  body.innerHTML = items.length === 0
    ? '<div class="muted">还没有任何科室。点「新增一行」建第一个（编码如 <span class="mono">DEPT_OB</span>、名称如"产科"）。'
      + '在此之前，模板只能配成<b>通用</b> —— 没有科室，就没有"限某个科"的依据。</div>'
    : items.map((item) => deptRowHtml(item)).join('');
}

function deptRowHtml(item) {
  return `
    <div class="dept-row">
      <input type="text" data-dept-code value="${esc(item.code)}" placeholder="编码（如 DEPT_OB）"
        title="判定用的就是它：就诊的科室编码与模板上的适用科室按它比对。改动它会让配了它的文书立刻开不出" />
      <input type="text" data-dept-name value="${esc(item.name)}" placeholder="名称（如 产科）"
        title="只用于展示与选择：改名称不影响任何已配好的模板" />
      <label class="check"><input type="checkbox" data-dept-enabled ${item.enabled === false ? '' : 'checked'} /> 启用</label>
      <button class="danger" data-dept-del="1" title="从清单里去掉这一行（仍然要点「保存科室字典」才写库）">删除</button>
    </div>`;
}

function setDeptStatus(text) {
  const box = $('deptStatus');
  if (box) box.innerHTML = text;
}

function tplPickedDepartments(containerId) {
  const box = $(containerId);
  if (!box) return [];
  return [...box.querySelectorAll('[data-tpl-dept]')]
    .filter((input) => input.checked)
    .map((input) => String(input.dataset.tplDept));
}

function readDepartmentRows() {
  const out = [];
  for (const row of document.querySelectorAll('#deptBody .dept-row')) {
    const code = String((row.querySelector('[data-dept-code]') || {}).value || '').trim();
    const name = String((row.querySelector('[data-dept-name]') || {}).value || '').trim();
    const enabledEl = row.querySelector('[data-dept-enabled]');
    out.push({ code, name, enabled: enabledEl ? Boolean(enabledEl.checked) : true });
  }
  return out;
}

let DOC_TYPE_SYSTEMS = ['WST500', 'WS445', 'local', 'custom'];

function renderDocTypes(data) {
  const view = data && typeof data === 'object' ? data : { items: [], source: 'empty', error: null };
  const items = Array.isArray(view.items) ? view.items : [];
  if (Array.isArray(view.systems) && view.systems.length > 0) DOC_TYPE_SYSTEMS = view.systems.map((value) => String(value));
  const enabled = items.filter((item) => item.enabled !== false).length;

  const chip = $('docTypeChip');
  if (chip) {
    chip.textContent = view.error
      ? '读不出来'
      : items.length === 0
        ? '尚未建任何类型'
        : `${items.length} 个（启用 ${enabled}）`;
    chip.className = `chip${view.error ? ' danger' : items.length === 0 ? ' warn' : ' ok'}`;
  }
  const summary = $('docTypeSummary');
  if (summary) {
    summary.innerHTML = chips([
      ['来源', view.source === 'store' ? '数据库（唯一来源）' : '库里没有类型', view.source === 'store' ? 'ok' : 'warn'],
      ['最近改动', view.updatedBy ? `${view.updatedBy} · ${fmtShort(view.updatedAt)}` : '—', 'mono'],
      /* 读不出来必须显眼：那会让所有按类型定位的质控规则失去依据 */
      ['读库情况', view.error || '正常', view.error ? 'danger' : 'ok'],
    ]);
  }

  const body = $('docTypeBody');
  if (!body) return;
  body.innerHTML = items.length === 0
    ? '<div class="muted">还没有任何文书类型。点「新增一行」建第一个（体系 <span class="mono">WST500</span>、编码 <span class="mono">WST500.1</span>、名称"入院记录"）。'
      + '在此之前，「新建文书」只能从已有模板反推类型或手打一个编码 —— 那正是质控规则认不出它的来源。</div>'
    : items.map((item) => docTypeRowHtml(item)).join('');
}

function docTypeRowHtml(item) {
  const current = String((item && item.system) || 'local');
  const options = DOC_TYPE_SYSTEMS
    .map((value) => `<option value="${esc(value)}"${value === current ? ' selected' : ''}>${esc(value)}</option>`)
    .join('');
  return `
    <div class="dept-row doc-type-row">
      <select data-doctype-system title="体系：判重只看同一体系内（国标体系与院内 local 各有一个 A01 是两回事）">${options}</select>
      <input type="text" data-doctype-code value="${esc(item.code)}" placeholder="编码（如 WST500.1）"
        title="判定用的是它：质控规则按 docType.code 定位文书。改掉它，原来的规则就再也认不出这类文书（且不会报错）" />
      <input type="text" data-doctype-display value="${esc(item.display)}" placeholder="名称（如 入院记录）"
        title="只用于展示与选择：改名称不影响任何已配好的模板与已开出的病历" />
      <label class="check"><input type="checkbox" data-doctype-enabled ${item.enabled === false ? '' : 'checked'} /> 启用</label>
      <button class="danger" data-doctype-del="1" title="从清单里去掉这一行（仍然要点「保存类型字典」才写库）">删除</button>
    </div>`;
}

function setDocTypeStatus(text) {
  const box = $('docTypeStatus');
  if (box) box.innerHTML = text;
}

function readDocTypeRows() {
  const out = [];
  for (const row of document.querySelectorAll('#docTypeBody .doc-type-row')) {
    const system = String((row.querySelector('[data-doctype-system]') || {}).value || 'local').trim();
    const code = String((row.querySelector('[data-doctype-code]') || {}).value || '').trim();
    const display = String((row.querySelector('[data-doctype-display]') || {}).value || '').trim();
    const enabledEl = row.querySelector('[data-doctype-enabled]');
    out.push({ system, code, display, enabled: enabledEl ? Boolean(enabledEl.checked) : true });
  }
  return out;
}

function fmtWhen(iso) {
  const time = new Date(String(iso));
  return Number.isNaN(time.getTime()) ? String(iso ?? '—') : time.toLocaleString('zh-CN', { hour12: false });
}

function fmtShort(iso) {
  const time = new Date(String(iso));
  if (Number.isNaN(time.getTime())) return String(iso ?? '—');
  return time.toLocaleString('zh-CN', {
    hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

function fmtDuration(ms) {
  const total = Math.max(0, Math.floor(Number(ms) / 1000));
  if (total < 60) return `${total} 秒`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes} 分 ${total % 60} 秒`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

function renderHealth(h) {
  const sign = h.sign || {};
  const configured = sign.configured === true;
  const chip = $('healthSignChip');
  chip.textContent = configured ? '已配置' : '未配置（签不了章）';
  chip.className = `chip ${configured ? 'ok' : 'danger'}`;
  const signMissing = Array.isArray(sign.missing) && sign.missing.length > 0 ? sign.missing : ['地址或公钥'];
  $('healthSign').innerHTML = chips([
    ['状态', configured ? '已配置（签章会经过它）' : '未配齐（签不了章）', configured ? 'ok' : 'danger'],
    configured ? null : ['还缺', `${signMissing.length} 项`, 'warn'],
    ['测试', `成功 ${sign.ok ?? 0} 次 / 失败 ${sign.fail ?? 0} 次`, sign.fail > 0 ? 'warn' : null],
  ]);
  $('healthSignMissing').textContent = configured ? '' : `还缺：${signMissing.join('、')}`;
  $('healthSignLast').textContent = sign.last
    ? `最近一次：${fmtWhen(sign.last.at)}（${sign.last.detail}）`
    : '最近一次：尚未测过（配好之后点下面的按钮，或去「能力配置 → 电子签名」）';

  const model = h.model || {};
  const modelChip = $('healthModelChip');
  modelChip.textContent = FORMAT_LABEL[model.format] ?? FORMAT_LABEL.offline;
  modelChip.className = 'chip';
  $('healthModel').innerHTML = chips([
    ['模型', model.modelId || '—', 'mono'],
    ['地址', model.endpoint || '—'],
    ['测试', `成功 ${model.ok ?? 0} 次 / 失败 ${model.fail ?? 0} 次`, model.fail > 0 ? 'warn' : null],
  ]);
  $('healthModelLast').textContent = model.last
    ? `最近一次：${fmtWhen(model.last.at)}（${model.last.detail}）`
    : '最近一次：尚未测过（去「能力配置 → 模型接入」点「测试连接」）';

  const counts = h.counts || {};
  $('healthMetrics').innerHTML = metricRow([
    ['病历份数', counts.documents],
    ['接收方公钥', counts.recipientKeys],
    ['后台账号', counts.adminAccounts],
    ['登录会话', counts.activeSessions],
    ['审计记录', counts.auditEntries],
  ]);
  $('healthCounts').innerHTML = kvRows([['本进程启动于', fmtWhen(h.startedAt)]]);
}

let AUDIT_PAGE = 1;
const AUDIT_PAGE_SIZE = 10;
let AUDIT_ENTRIES = [];

function renderAudit(a) {
  const entries = Array.isArray(a.entries) ? a.entries : [];
  const counts = a.counts || {};
  const chain = a.chain || {};
  $('auditCount').textContent = `${entries.length} 条（本次下发上限 ${counts.limit ?? '—'}`
    + (counts.dropped > 0 ? `，另有更早的 ${counts.dropped} 条未下发（**都在库里**，没有丢）` : '') + '）';

  $('auditChain').innerHTML = chips([
    ['记账位置', chain.table || '—', 'mono'],
    ['旧文件（不再读）', chain.legacyFile || '—', 'mono'],
    chain.intact
      ? ['链校验', '完好（逐条复算通过）', 'ok']
      : ['链校验', `断裂（第 ${chain.problem && chain.problem.atLine ? chain.problem.atLine : '?'} 条：${(chain.problem && (chain.problem.reason || chain.problem.kind)) || '原因未知'}）`, 'danger'],
    chain.discarded > 0 ? ['未能验证', `${chain.discarded} 条（不展示、**但仍留在库里**，见边界说明）`, 'warn'] : null,
    a.writeError ? ['写入失败', a.writeError, 'danger'] : null,
  ]);

  AUDIT_ENTRIES = entries;
  AUDIT_PAGE = 1;
  renderAuditEntries();
  $('auditBoundary').innerHTML = (Array.isArray(a.boundary) ? a.boundary : [])
    .map((item) => `<li>${esc(item)}</li>`).join('');
}

function renderAuditEntries() {
  const body = $('auditBody');
  if (!body) return;
  const entries = AUDIT_ENTRIES;
  if (entries.length === 0) {
    body.innerHTML = '<div class="empty">还没有记录。登录、改配置、测试签名都会记在这里。</div>';
    return;
  }
  const pageCount = Math.max(1, Math.ceil(entries.length / AUDIT_PAGE_SIZE));
  if (AUDIT_PAGE > pageCount) AUDIT_PAGE = pageCount;
  if (AUDIT_PAGE < 1) AUDIT_PAGE = 1;
  const start = (AUDIT_PAGE - 1) * AUDIT_PAGE_SIZE;
  const pageRows = entries.slice(start, start + AUDIT_PAGE_SIZE);

  const rows = pageRows.map((entry) => {
    const changes = Array.isArray(entry.changes) ? entry.changes : [];
    const head = `<div class="muted">${esc(fmtWhen(entry.at))}</div>`
      + `<div><b>${esc(entry.actor)}</b> <span class="muted">·</span> ${esc(entry.subject)}</div>`
      + `<div class="muted">${esc(entry.kind)}</div>`;
    const diff = changes.length === 0
      ? `<div class="muted">（无字段变化${entry.note ? `：${esc(entry.note)}` : ''}）</div>`
      : `<div class="audit-diff">${changes.map((item) => `<div>· ${esc(item.field)}：`
        + `<s>${esc(item.before)}</s> → <b>${esc(item.after)}</b></div>`).join('')}</div>`
        + (entry.note ? `<div class="muted">${esc(entry.note)}</div>` : '');
    return `<div class="audit-row">${head}${diff}</div>`;
  }).join('');

  body.innerHTML = rows
    + `<div class="tpl-pager">`
    + `<span class="muted">第 ${AUDIT_PAGE} / ${pageCount} 页 · 本页 ${pageRows.length} 条`
    + `（共 ${entries.length} 条，每页 ${AUDIT_PAGE_SIZE} 条）</span>`
    + `<span class="tpl-pager-btns">`
    + `<button class="secondary" data-audit-page="${AUDIT_PAGE - 1}" ${AUDIT_PAGE <= 1 ? 'disabled' : ''}`
    + ` title="上一页（只翻这一块，不重新拉审计）">上一页</button>`
    + `<button class="secondary" data-audit-page="${AUDIT_PAGE + 1}" ${AUDIT_PAGE >= pageCount ? 'disabled' : ''}`
    + ` title="下一页（只翻这一块，不重新拉审计）">下一页</button>`
    + `</span></div>`;
}

const ROLE_OPTIONS = [['admin', '管理员'], ['qc', '质控员'], ['clinician', '医生'], ['viewer', '只读']];

function setAcctStatus(text) { markCfgStatus($('acctStatus'), text); }
function setAcctPwdStatus(text) { markCfgStatus($('acctPwdStatus'), text); }

function renderAccounts(data) {
  const accounts = (data && data.accounts) || {};
  const users = Array.isArray(data && data.users) ? data.users : [];
  S.users = users;

  const admins = Number(accounts.admins ?? 0);
  const chip = $('acctChip');
  chip.textContent = admins > 0 ? `${admins} 个可用管理员` : '没有可用管理员';
  chip.className = `chip ${admins > 0 ? 'ok' : 'danger'}`;

  $('acctSummary').innerHTML = chips([
    ['账号总数', String(accounts.total ?? users.length)],
    ['可用管理员', String(admins), admins > 0 ? 'ok' : 'danger'],
    ['口令存储', 'scrypt 哈希（不可逆，不回显）', 'ok'],
  ]);

  const body = $('acctBody');
  if (users.length === 0) {
    body.innerHTML = '<div class="empty">还没有账号。</div>';
    return;
  }
  body.innerHTML = users.map((user) => {
    const name = esc(user.username);
    const roleSelect = `<select data-acct-role="${name}" title="改角色会立刻吊销该账号的会话">`
      + ROLE_OPTIONS.map(([value, label]) => `<option value="${value}"${value === user.role ? ' selected' : ''}>${esc(label)}</option>`).join('')
      + '</select>';
    const toggle = user.disabled
      ? `<button data-acct-enable="${name}">启用</button>`
      : `<button data-acct-disable="${name}" title="立刻禁止登录，并踢掉它已登录的会话">停用</button>`;
    return '<div class="acct-row">'
      + `<div class="acct-name">${name}</div>`
      + `<div class="muted">${esc(user.roleLabel)}${user.disabled ? ' · <b>已停用</b>' : ''}</div>`
      + `<div class="muted">最近登录 ${esc(user.lastLoginAt ? fmtWhen(user.lastLoginAt) : '（从未）')}</div>`
      + `<div class="acct-actions">${roleSelect}`
      + `<button data-acct-reset="${name}">重设口令</button>${toggle}`
      + `<button class="danger" data-acct-remove="${name}">删除</button></div>`
      + `<div class="muted acct-meta">${esc(user.passwordAlgo)} · 由 ${esc(user.updatedBy)} 于 ${esc(fmtWhen(user.updatedAt))} 最后修改</div>`
      + '</div>';
  }).join('');
}

async function accountAction(path, body, statusSetter, okText) {
  if (!(await requireSession())) return false;
  const r = await api(path, body);
  if (r.ok) {
    statusSetter(`${okText}${r.data && r.data.action ? `（${r.data.action}）` : ''}`);
    renderAccounts(r.data);
    return true;
  }
  statusSetter(`失败：${(r && (r.message || r.code)) || '未知原因'}`);
  return false;
}

function renderSystem(s) {
  $('sysInfo').innerHTML = kvRows([
    ['版本', s.version, 'mono'],
    ['运行环境', `Node ${s.node} · 进程 ${s.pid ?? '—'}`, 'mono'],
    ['环境标识', s.env || '未标注（可在服务端配置文件 server-config.json 的 envName 里标上）。仅作标注，不做隔离', s.env ? 'mono' : 'wrap'],
    ['启动时间', fmtWhen(s.startedAt)],
    ['已运行', fmtDuration(s.uptimeMs)],
    ['数据目录', s.stateDir, 'mono'],
    ['产物目录', s.artifactsDir, 'mono'],
    ['账号来源', (s.accounts && s.accounts.source) || '—'],
    ['可用管理员', s.accounts ? String(s.accounts.admins ?? 0) : '—'],
  ]);
  $('sysFingerprints').innerHTML = kvRows(
    Object.entries(s.configFingerprints || {}).map(([key, value]) => [key, value, 'mono']),
  );

  $('sysMissing').innerHTML = [
    '环境隔离：环境标识只是标注（server-config.json 的 envName），不改变任何行为（还没有预发 / 生产分离）',
    '配置版本与回滚：需手动改回，审计中有前后值可参照',
    '统一身份与多因素：现在是"本机账号 + 口令"，没有对接医院 CA / SSO，也没有二次验证（属 T23）',
    '会话落盘：会话在内存里，进程重启即全失效（多实例部署需要粘性会话或共享存储）',
    '审计防篡改：审计在文件里由链式摘要自证，但能改数据目录的人就能重签锚点（属 T23）',
    '告警与通知：不会主动告诉任何人"签名服务挂了"',
    '不看病历正文：本后台管"系统怎么接"，要看内容得走医生端的受控阅读（授权 + 留痕）',
  ].map((item) => `<li>${esc(item)}</li>`).join('');
  void loadSystemPolicy();
}

async function loadSystemPolicy() {
  const r = await api('/api/system-config');
  if (!r || !r.ok) {
    $('cfgSysPolicyCurrent').textContent = `读不出来：${(r && (r.message || r.code)) || '未知原因'}`;
    return;
  }
  const p = r.data || {};
  const rate = p.rate || {};
  $('cfgSysAuthMode').value = p.authMode === 'strict' ? 'strict' : 'open';
  $('cfgSysSessionTtl').value = p.sessionTtlMinutes ?? 480;
  $('cfgSysRateActor').value = rate.loginPerActor ?? 5;
  $('cfgSysRateSource').value = rate.loginPerSource ?? 20;
  $('cfgSysRateAi').value = rate.aiPerMinute ?? 120;
  $('cfgSysRateExport').value = rate.exportPerMinute ?? 30;
  $('cfgSysAnchorEvery').value = p.anchorEvery ?? 1;
  $('cfgSysAnchorSeed').value = '';
  $('cfgSysPolicyCurrent').innerHTML = chips([
    ['鉴权', p.authMode === 'strict' ? 'strict（写操作要求会话）' : 'open（演示模式：写病历不鉴权）', p.authMode === 'strict' ? 'ok' : 'warn'],
    ['来源', p.source === 'store' ? '管理后台（存入数据库）' : '默认'],
    ['锚点种子', p.anchorSeedConfigured ? '已自定义' : '内置演示种子（拿得到代码的人也能重签锚点）', p.anchorSeedConfigured ? 'ok' : 'warn'],
    p.updatedBy ? ['最近修改', `${p.updatedBy} · ${fmtShort(p.updatedAt)}`] : null,
  ]);
}

async function saveSystemPolicyFromForm(anchorSeedOverride) {
  const body = {
    authMode: $('cfgSysAuthMode').value,
    sessionTtlMinutes: Number($('cfgSysSessionTtl').value),
    anchorEvery: Number($('cfgSysAnchorEvery').value),
    rate: {
      loginPerActor: Number($('cfgSysRateActor').value),
      loginPerSource: Number($('cfgSysRateSource').value),
      aiPerMinute: Number($('cfgSysRateAi').value),
      exportPerMinute: Number($('cfgSysRateExport').value),
    },
  };
  const typedSeed = $('cfgSysAnchorSeed').value;
  if (anchorSeedOverride === null) body.anchorSeed = null;
  else if (typedSeed !== '') body.anchorSeed = typedSeed;
  const r = await api('/api/system-config', body);
  if (r.ok) {
    $('cfgSysAnchorSeed').value = '';
    $('cfgSysPolicyStatus').textContent = '已保存：**重启服务后生效**（这几项决定会话表、限流器与锚点签名者怎么建）';
    await loadSystemPolicy();
  } else {
    $('cfgSysPolicyStatus').textContent = `保存失败：${(r && (r.message || r.code)) || '未知原因'}`;
    await requireSession();
  }
}

/** 内涵质控：规则清单是"判定标准"本体，引擎决定"病历内容发往哪台服务器" */
async function loadQcContentConfig() {
  const r = await api('/api/qc-content-config');
  if (!r || !r.ok) {
    $('cfgQcStatus').textContent = `读不出来：${(r && (r.message || r.code)) || '未知原因'}`;
    return;
  }
  const qc = r.data || {};
  const engine = qc.engine || { kind: 'none' };
  $('cfgQcKind').value = engine.kind || 'none';
  $('cfgQcUrl').value = engine.url || '';
  $('cfgQcEngineId').value = engine.expectEngineId || '';
  /* 凭据永不回显；规则清单回显（它是判定标准，要能被核对、被 diff） */
  $('cfgQcToken').value = '';
  /* 规则清单**原样回显**（判定标准要能被逐条核对与 diff）；空清单时留空 = 保存时"不动规则" */
  const rules = Array.isArray(qc.rules) ? qc.rules : [];
  $('cfgQcRules').value = rules.length === 0 ? '' : JSON.stringify(rules, null, 2);
  const rejected = Array.isArray(qc.rulesRejected) ? qc.rulesRejected : [];
  if (qc.rulesProblem) $('cfgQcStatus').textContent = `规则清单有问题：${qc.rulesProblem}`;
  else if (rejected.length > 0) $('cfgQcStatus').textContent = `规则清单有 ${rejected.length} 条校验不通过，已被丢弃`;
}

async function saveQcContentFromForm(tokenOverride) {
  const body = { engine: { kind: $('cfgQcKind').value } };
  const url = $('cfgQcUrl').value.trim();
  const engineId = $('cfgQcEngineId').value.trim();
  if (body.engine.kind === 'http') {
    body.engine.url = url;
  }
  if (engineId !== '') body.engine.expectEngineId = engineId;
  const typedToken = $('cfgQcToken').value;
  if (tokenOverride === null) body.token = null;
  else if (typedToken !== '') body.token = typedToken;
  const rulesText = $('cfgQcRules').value.trim();
  if (rulesText !== '') {
    let parsed;
    try {
      parsed = JSON.parse(rulesText);
    } catch (err) {
      $('cfgQcStatus').textContent = `规则清单不是合法 JSON：${(err && err.message) || ''}`;
      return;
    }
    if (!Array.isArray(parsed)) {
      $('cfgQcStatus').textContent = '规则清单必须是 JSON 数组';
      return;
    }
    body.rules = parsed;
  }
  const r = await api('/api/qc-content-config', body);
  if (r.ok) {
    $('cfgQcToken').value = '';
    const action = r.data && r.data.tokenAction;
    const rejected = (r.data && r.data.rulesRejected) || [];
    $('cfgQcStatus').textContent =
      `已保存：改完立即生效，下次质控按新规则判（凭据：${action === 'set' ? '已更新' : action === 'cleared' ? '已清除' : '未改动'}）` +
      (rejected.length > 0 ? `；**${rejected.length} 条规则被丢弃**：${rejected.slice(0, 3).map((item) => `#${item.index} ${item.message}`).join('；')}` : '');
    await loadQcContentConfig();
  } else {
    $('cfgQcStatus').textContent = `保存失败：${(r && (r.message || r.code)) || '未知原因'}`;
    await requireSession();
  }
}

async function saveModelConfigFromForm(apiKeyOverride) {
  const body = {
    format: $('cfgFormat').value,
    model: $('cfgModel').value.trim(),
    endpoint: $('cfgEndpoint').value.trim(),
    timeoutMs: Number($('cfgTimeout').value),
    maxItems: Number($('cfgMaxItems').value),
  };
  const typed = $('cfgApiKey').value;
  if (apiKeyOverride === null) body.apiKey = null;
  else if (typed !== '') body.apiKey = typed;
  const savingKey = typeof body.apiKey === 'string' && body.apiKey !== '';
  if (savingKey) setCfgStatus('正在保存…API Key 落盘要做口令派生（约 10~15 秒），请勿重复点击');
  const r = await api('/api/model-config', body);
  if (r.ok) {
    $('cfgApiKey').value = '';
    const action = r.data && r.data.apiKeyAction;
    setCfgStatus(`已保存（API Key：${action === 'set' ? '已更新' : action === 'cleared' ? '已清除' : '未改动'}）`);
    await apply(r);
  } else {
    setCfgStatus(`保存失败：${(r && (r.message || r.code)) || '未知原因'}`);
    await requireSession();
  }
}

async function savePlacementFromForm(apiKeyOverride) {
  const strategy = $('cfgPlaceStrategy').value;
  const sections = $('cfgPlaceSections').value.split(',').map((item) => item.trim()).filter((item) => item !== '');
  const endpoint = $('cfgPlaceEndpoint').value.trim();
  const timeoutMs = Number($('cfgPlaceTimeout').value);
  const typed = $('cfgPlaceApiKey').value;
  const body = {
    strategy,
    confidenceCeiling: Number($('cfgPlaceCeiling').value),
    candidate: { onlyTextNodes: true, ...(sections.length > 0 ? { withinSections: sections } : {}) },
    external: {
      ...(endpoint ? { endpoint } : {}),
      ...(Number.isInteger(timeoutMs) && timeoutMs > 0 ? { timeoutMs } : {}),
    },
  };
  if (apiKeyOverride === null) body.apiKey = null;
  else if (typed !== '') body.apiKey = typed;
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
    const action = r.data && r.data.apiKeyAction;
    setPlaceStatus(
      `已保存：下次转写即按新策略落位（改完立即生效，无需重启）` +
        `（密钥：${action === 'set' ? '已更新' : action === 'cleared' ? '已清除' : '未改动'}）`,
    );
    await apply(r);
  } else {
    setPlaceStatus(`保存失败：${(r && (r.message || r.code)) || '未知原因'}`);
    await requireSession();
  }
}

async function saveSignBackendFromForm(apiKeyOverride) {
  const body = {};
  const typedKey = $('cfgSignApiKey').value;
  if (apiKeyOverride === null) body.apiKey = null;
  else if (typedKey !== '') body.apiKey = typedKey;
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
    const action = r.data && r.data.apiKeyAction;
    setSignStatus(
      `已保存：改完立即生效，无需重启（密钥：${action === 'set' ? '已更新' : action === 'cleared' ? '已清除' : '未改动'}）`,
    );
    $('cfgSignPublicKey').value = '';
    $('cfgSignApiKey').value = '';
    await apply(r);
  } else {
    setSignStatus(`保存失败：${(r && (r.message || r.code)) || '未知原因'}`);
    await requireSession();
  }
}

async function savePrevisitAccessFromForm(keyOverride) {
  const body = { enabled: $('cfgPrevisitEnabled').value === 'true' };
  const typed = $('cfgPrevisitKey').value;
  if (keyOverride === null) body.key = null;
  else if (keyOverride !== undefined) body.key = keyOverride;
  else if (typed !== '') body.key = typed;

  if (typeof body.key === 'string') setPrevisitStatus('正在保存…密钥要做哈希，请勿重复点击');
  const r = await api('/api/previsit-config', body);
  if (r.ok) {
    $('cfgPrevisitKey').value = '';
    const action = r.data && r.data.keyAction;
    const label = action === 'set' ? '已更新' : action === 'cleared' ? '已清除' : '未改动';
    setPrevisitStatus(`已保存（密钥：${label}）${r.data && r.data.note ? `；${r.data.note}` : ''}`);
    await apply(r);
  } else {
    setPrevisitStatus(`保存失败：${(r && (r.message || r.code)) || '未知原因'}`);
    await requireSession();
  }
}

async function saveAuthorityFromForm() {
  const body = { endpoint: $('cfgAuthEndpoint').value.trim() };
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
  } else {
    setAuthStatus(`保存失败：${(r && (r.message || r.code)) || '未知原因'}`);
    await requireSession();
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
    setAuthImportStatus(`已导入并登记：${grantId}（去医生端「定稿与导出 → 受控阅读」执行阅读）`);
    $('cfgAuthCredential').value = '';
    await apply(r);
  } else {
    setAuthImportStatus(`未导入：${(r && (r.message || r.code)) || '未知原因'}`);
  }
}

async function runSignTest(statusEl) {
  const set = (text) => markCfgStatus(statusEl ?? $('cfgSignStatus'), text);
  set('测试中…（签一段与病历无关的测试文本，并尝试自验）');
  const r = await api('/api/sign-backend/test', {});
  if (!r.ok) {
    set(`测试失败：${(r && (r.message || r.code)) || '未知原因'}`);
    await requireSession();
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
  set(parts.join(' · ') + (d.notes && d.notes.length ? ` · ${d.notes.join('；')}` : ''));
}

function adoptState(state) {
  S = state;
  if (!state || state.scope !== 'admin') {
    setLoginStatus('当前身份读不到管理端配置视图（登录可能已失效）：请重新登录后再看本页。', true);
  }
}

async function refresh() {
  const r = await api('/api/state');
  if (!r.state) {
    setLoginStatus(`读取工作区失败：${r.message || r.code || '未知原因'}`, true);
    return;
  }
  adoptState(r.state);
  renderModelPanel();
}

async function apply(result) {
  if (result && result.state) {
    adoptState(result.state);
    renderModelPanel();
    return;
  }
  await refresh();
}

document.addEventListener('click', async (event) => {
  const el = event.target && event.target.closest ? event.target.closest('button') : null;

  const view = event.target && event.target.closest ? event.target.closest('[data-admin-view]') : null;
  if (view) {
    const name = view.dataset.adminView;
    selectAdminView(name);
    await loadAdminView(name);
    return;
  }

  if (el && el.dataset && el.dataset.tplPage) {
    const next = Number(el.dataset.tplPage);
    if (Number.isFinite(next) && next >= 1) {
      TPL_PAGE = next;
      renderTemplatePacks();
    }
    return;
  }

  if (el && el.dataset && el.dataset.exprPage) {
    const next = Number(el.dataset.exprPage);
    if (Number.isFinite(next) && next >= 1) {
      EXPR_PAGE = next;
      renderExprCatalog();
    }
    return;
  }

  if (el && el.dataset && el.dataset.ctrlPage) {
    const next = Number(el.dataset.ctrlPage);
    if (Number.isFinite(next) && next >= 1) {
      CTRL_PAGE = next;
      renderCtrlCatalog();
    }
    return;
  }

  if (el && el.dataset && el.dataset.auditPage) {
    const next = Number(el.dataset.auditPage);
    if (Number.isFinite(next) && next >= 1) {
      AUDIT_PAGE = next;
      renderAuditEntries();
    }
    return;
  }

  const tab = event.target && event.target.closest ? event.target.closest('[data-cfg-tab]') : null;
  if (tab) {
    selectCfgPane(tab);
    if (tab.dataset.cfgTab === 'predicates') renderPredicates();
    if (tab.dataset.cfgTab === 'expressions') renderExprCatalog();
    if (tab.dataset.cfgTab === 'ctrlDefs') renderCtrlCatalog();
    if (tab.dataset.cfgTab === 'previsit') renderPrevisitAccessPanel();
    return;
  }
  if (!el) return;

  if (el.id === 'loginBtn') { await login(); return; }
  if (el.id === 'logoutBtn') { await logout(); return; }
  if (el.id === 'btnImportKey') {
    await apply(await api('/api/recipient-keys/import', {
      label: $('rkLabel').value || '接收方',
      text: $('rkText').value || '',
    }));
    return;
  }

  if (el.id === 'btnNewExpression') {
    if (!(await requireSession())) return;
    TPL_DRAWER_ITEM = '';
    TPL_EXPR_EDIT_ID = '';
    TPL_EXPR_BASELINE = '';
    TPL_EXPR_DRAFT = { kind: 'slot', key: '' };
    openTplDrawer('新建：表达式控件', '', 2);
    renderExprForm(null);
    const nameEl = $('exprNewName');
    if (nameEl) nameEl.focus();
    return;
  }

  if (el.id === 'btnNewControl') {
    if (!(await requireSession())) return;
    CTRL_EDIT_ID = '';
    CTRL_BASELINE = '';
    CTRL_DRAFT = emptyCtrlDraft();
    openTplDrawer('新建：专科控件', '', 2);
    renderCtrlForm();
    const ctrlNameEl = $('ctrlNewName');
    if (ctrlNameEl) ctrlNameEl.focus();
    return;
  }

  if (el.dataset && el.dataset.ctrlPreview) {
    const [, itemId] = String(el.dataset.ctrlPreview).split('|');
    await openCtrlPreview(itemId);
    return;
  }

  /* 编辑一个专科控件：把它的定义**回显**进表单（否则「编辑」只能从头搭一遍） */
  if (el.dataset && el.dataset.ctrlEdit) {
    const item = tplItemOf(String(el.dataset.ctrlEdit).split('|')[1]);
    if (!item) return;
    CTRL_EDIT_ID = String(item.itemId ?? '');
    CTRL_DRAFT = ctrlDraftOf(item);
    CTRL_BASELINE = ctrlSemanticSignature(CTRL_DRAFT);
    openTplDrawer(`编辑控件：${item.name}`, '', 2);
    renderCtrlForm();
    return;
  }

  if (el.dataset && (el.dataset.ctrlAddfield || el.dataset.ctrlFielddel || el.dataset.ctrlFieldup || el.dataset.ctrlFielddown)) {
    if (!CTRL_DRAFT) return;
    readCtrlForm();
    const fields = CTRL_DRAFT.fields;
    if (el.dataset.ctrlAddfield) {
      fields.push({ key: '', label: '', dataType: 'number' });
    } else if (el.dataset.ctrlFielddel !== undefined) {
      if (fields.length <= 1) {
        setTplDrawerStatus('至少要留一格：没有字段的控件是个空壳');
        return;
      }
      fields.splice(Number(el.dataset.ctrlFielddel), 1);
    } else {
      const from = Number(el.dataset.ctrlFieldup !== undefined ? el.dataset.ctrlFieldup : el.dataset.ctrlFielddown);
      const to = el.dataset.ctrlFieldup !== undefined ? from - 1 : from + 1;
      if (!Number.isFinite(to) || to < 0 || to >= fields.length) return;
      const moved = fields.splice(from, 1)[0];
      fields.splice(to, 0, moved);
    }
    renderCtrlForm();
    return;
  }

  if (el.dataset && el.dataset.ctrlSubmit) {
    if (!(await requireSession())) return;
    await submitCtrlForm();
    return;
  }

  if (el.dataset && el.dataset.ctrlDelete) {
    if (!(await requireSession())) return;
    const [packId, itemId] = String(el.dataset.ctrlDelete).split('|');
    const item = tplItemOf(itemId);
    if (!(await askConfirm(
      `删除控件「${item?.name ?? itemId}」？\n\n会影响：以后新建的病历里不能再选它。\n不影响：已经开出的病历（它们带的是当时那份字段快照）。\n没有撤销。`,
      { okLabel: '删除', tone: 'danger' },
    ))) return;
    const r = await api('/api/control-item-delete', { packId, itemId });
    if (r && r.state) {
      S = r.state;
      renderModelPanel();
    }
    setCtrlCatalogStatus(r && r.ok
      ? `已删除控件「${item?.name ?? itemId}」`
      : `删除失败：${(r && (r.message || r.code)) || '未知原因'}`);
    return;
  }

  /* 编辑一个表达式控件：把它的公式**回显**进构造器（否则"编辑"只能从头搭一遍） */
  if (el.dataset && el.dataset.exprEdit) {
    const item = tplItemOf(String(el.dataset.exprEdit).split('|')[1]);
    if (!item) return;
    TPL_DRAWER_ITEM = '';
    TPL_EXPR_EDIT_ID = item.itemId;
    TPL_EXPR_DRAFT = item.expression ? JSON.parse(JSON.stringify(item.expression)) : { kind: 'slot', key: '' };
    TPL_EXPR_BASELINE = item.expression ? JSON.stringify(item.expression) : '';
    openTplDrawer(`编辑控件：${item.name}`, '', 2);
    renderExprForm(item);
    return;
  }

  if (el.dataset && el.dataset.exprCreateSubmit) {
    if (!(await requireSession())) return;
    const name = (($('exprNewName') || {}).value || '').trim();
    if (name === '') {
      setTplDrawerStatus('请填控件名称（它是模板里选用控件时看到的那一行）');
      return;
    }
    const editing = TPL_EXPR_EDIT_ID !== '';
    const item = editing ? tplItemOf(TPL_EXPR_EDIT_ID) : null;
    const formulaChanged = editing && JSON.stringify(TPL_EXPR_DRAFT) !== TPL_EXPR_BASELINE;
    if (formulaChanged && !(await askConfirm(
      `「${name}」这次改动包含公式。\n\n会影响：之后新开的文书按新公式算；已开出的病历在你点「重算派生值」时也按新公式重算。\n不影响：已经算出来的数不会自己变（重算是一次显式动作）。\n审计里会记下改前改后的公式原文。`,
      { okLabel: '仍然保存' },
    ))) return;
    const r = await api(editing ? '/api/expression-item-update' : '/api/expression-item-create', {
      ...(editing ? { packId: String(item?.packId ?? ''), itemId: TPL_EXPR_EDIT_ID } : {}),
      name,
      unit: (($('exprNewUnit') || {}).value || '').trim(),
      description: (($('exprNewDesc') || {}).value || '').trim(),
      expression: TPL_EXPR_DRAFT,
    });
    if (r && r.state) {
      S = r.state;
      if (r.ok && !editing && r.data && r.data.itemId) exprGotoItemPage(String(r.data.itemId));
      renderModelPanel();
    }
    if (r && r.ok) {
      TPL_EXPR_EDIT_ID = '';
      TPL_EXPR_BASELINE = '';
      closeTplDrawer();
    }
    const exprMessage = r && r.ok
      ? editing
        ? `已保存控件「${name}」：${r.data && r.data.formula}${formulaChanged ? '（公式换了一版：已开出的病历不重算，下次重算时按新公式）' : ''}`
        : `已新建控件「${name}」（${r.data && r.data.itemId}）：${r.data && r.data.formula} —— 现在可以在文书的槽位里选它了`
      : `${editing ? '保存' : '新建'}失败：${(r && (r.message || r.code)) || '未知原因'}`;
    if (r && r.ok) setExprCatalogStatus(exprMessage);
    else setTplDrawerStatus(exprMessage);
    return;
  }

  if (el.dataset && el.dataset.exprDelete) {
    if (!(await requireSession())) return;
    const [packId, itemId] = String(el.dataset.exprDelete).split('|');
    const item = tplItemOf(itemId);
    if (!(await askConfirm(
      `删除控件「${item?.name ?? itemId}」？\n\n会影响：模板里不能再选它。\n如果还有文书用着它，这次删除会被拒绝（并告诉你哪些文书在用）——先改那些槽位。\n不影响：已经开出的病历（它们带着当时的公式原文）。\n没有撤销。`,
      { okLabel: '删除', tone: 'danger' },
    ))) return;
    const r = await api('/api/expression-item-delete', { packId, itemId });
    if (r && r.state) {
      S = r.state;
      renderModelPanel();
    }
    setExprCatalogStatus(r && r.ok
      ? `已删除控件「${item?.name ?? itemId}」`
      : `删除失败：${(r && (r.message || r.code)) || '未知原因'}`);
    return;
  }

  if (el.dataset && el.dataset.exprAddarg) {
    TPL_EXPR_DRAFT = exprMutate(TPL_EXPR_DRAFT, String(el.dataset.exprAddarg), (node) => {
      node.args = [...(Array.isArray(node.args) ? node.args : []), { kind: 'num', value: 0 }];
      return node;
    });
    renderExprTree();
    return;
  }
  if (el.dataset && el.dataset.exprDelarg) {
    TPL_EXPR_DRAFT = exprMutate(TPL_EXPR_DRAFT, String(el.dataset.exprDelarg), (node) => {
      if (Array.isArray(node.args) && node.args.length > 1) node.args = node.args.slice(0, -1);
      return node;
    });
    renderExprTree();
    return;
  }

  if (el.id === 'btnCreateTemplate') {
    if (!(await requireSession())) return;
    TPL_DRAWER_ITEM = '';
    openTplDrawer('新建文书', '');
    renderTplCreateForm();
    const nameEl = $('tplNewName');
    if (nameEl) nameEl.focus();
    return;
  }

  if (el.id === 'tplDrawerClose') {
    closeTplDrawer();
    return;
  }

  if (el.id === 'tplDrawer2Close') {
    closeTplDrawer(2);
    return;
  }

  if (el.dataset && el.dataset.tplCreateCancel) {
    closeTplDrawer();
    return;
  }

  if (el.dataset && el.dataset.tplCreateSubmit) {
    if (!(await requireSession())) return;
    const name = (($('tplNewName') || {}).value || '').trim();
    if (name === '') {
      setTplPackStatus('请填文书名称（它是「新建」里的那一行）');
      return;
    }
    const kindEl = $('tplNewDocType');
    const chosen = kindEl ? String(kindEl.value || '') : '';
    let docType = null;
    if (chosen !== '') {
      const [system, code] = chosen.split('/');
      const fromDict = (Array.isArray((S || {}).docTypes && S.docTypes.items) ? S.docTypes.items : [])
        .find((item) => item && `${item.system}/${item.code}` === chosen);
      const fromCatalog = (Array.isArray((S || {}).templateCatalog) ? S.templateCatalog : [])
        .find((item) => item.itemType === 'template' && item.docType && `${item.docType.system}/${item.docType.code}` === chosen);
      docType = {
        system: system || 'local',
        code: code || '',
        display: (fromDict && fromDict.display)
          || (fromCatalog && fromCatalog.docType ? fromCatalog.docType.display : '')
          || code || '',
      };
    }
    if (!docType || docType.code === '' || docType.display === '') {
      setTplPackStatus('请先选文书类型：去「基础数据 → 文书类型」建一个，它决定这份文书算哪一类');
      return;
    }
    const r = await api('/api/template-item-create', {
      name,
      docType,
      departments: tplPickedDepartments('tplNewDept'),
    });
    if (r && r.state) {
      S = r.state;
      if (r.ok && r.data && r.data.itemId) tplGotoItemPage(String(r.data.itemId));
      renderModelPanel();
    }
    if (r && r.ok) closeTplDrawer();
    setTplPackStatus(r && r.ok
      ? `已新建「${name}」（${r.data && r.data.itemId}）：状态是<b>草稿</b> —— 医生端开不出它；定稿后在那一行点「发布」`
      : `新建失败：${(r && (r.message || r.code)) || '未知原因'}`);
    return;
  }

  if (el.dataset && el.dataset.tplPreview) {
    const [, itemId] = String(el.dataset.tplPreview).split('|');
    await openTplPreview(itemId);
    return;
  }

  if (el.dataset && el.dataset.tplEdit) {
    const [, itemId] = String(el.dataset.tplEdit).split('|');
    const item = tplItemOf(itemId);
    if (!item) return;
    TPL_DRAWER_ITEM = itemId;
    openTplDrawer(`编辑：${item.name}`, '');
    renderTplEditForm(item);
    return;
  }

  if (el.dataset && el.dataset.tplCancel) {
    closeTplDrawer();
    return;
  }

  if (el.dataset && el.dataset.tplSecAdd) {
    const item = tplItemOf(TPL_DRAWER_ITEM);
    if (!item) return;
    const form = readTplEditForm();
    const seq = form.sections.length + 1;
    form.sections.push({ sectionCode: `section${seq}`, title: `第 ${seq} 章`, slots: [{ slot: 'text', key: `text${seq}`, text: '' }] });
    renderTplEditForm(tplFormStateOf(item, form));
    return;
  }
  if (el.dataset && el.dataset.tplSecDel) {
    const item = tplItemOf(TPL_DRAWER_ITEM);
    if (!item) return;
    const form = readTplEditForm();
    form.sections.splice(Number(String(el.dataset.tplSecDel).split('|')[1]), 1);
    renderTplEditForm(tplFormStateOf(item, form));
    return;
  }
  if (el.dataset && el.dataset.tplSlotAdd) {
    const item = tplItemOf(TPL_DRAWER_ITEM);
    if (!item) return;
    const form = readTplEditForm();
    const section = form.sections[Number(String(el.dataset.tplSlotAdd).split('|')[1])];
    if (section) section.slots.push({ slot: 'text', key: `slot${section.slots.length + 1}`, text: '' });
    renderTplEditForm(tplFormStateOf(item, form));
    return;
  }
  if (el.dataset && el.dataset.tplColAdd) {
    const item = tplItemOf(TPL_DRAWER_ITEM);
    if (!item) return;
    const [, sectionText, slotText] = String(el.dataset.tplColAdd).split(':');
    const form = readTplEditForm();
    const slot = form.sections[Number(sectionText)]?.slots?.[Number(slotText)];
    if (slot) {
      if (!Array.isArray(slot.columns)) slot.columns = [];
      slot.columns.push({ title: '', dataType: 'text' });
    }
    renderTplEditForm(tplFormStateOf(item, form));
    setTplDrawerStatus('已加一列（保存前都还没写进库）；记得给这一列填列名');
    return;
  }
  if (el.dataset && el.dataset.tplColDel) {
    const item = tplItemOf(TPL_DRAWER_ITEM);
    if (!item) return;
    const [, sectionText, slotText, columnText] = String(el.dataset.tplColDel).split(':');
    const form = readTplEditForm();
    const slot = form.sections[Number(sectionText)]?.slots?.[Number(slotText)];
    if (slot && Array.isArray(slot.columns)) {
      if (slot.columns.length <= 1) {
        setTplDrawerStatus('这是最后一列：表格至少要有一列，否则它产不出任何格子。要整张表都去掉，请直接删掉这个槽位。');
        return;
      }
      slot.columns.splice(Number(columnText), 1);
    }
    renderTplEditForm(tplFormStateOf(item, form));
    setTplDrawerStatus('已删一列（保存前都还没写进库）');
    return;
  }
  if (el.dataset && el.dataset.tplItemAdd) {
    const item = tplItemOf(TPL_DRAWER_ITEM);
    if (!item) return;
    const [, sectionText, slotText] = String(el.dataset.tplItemAdd).split(':');
    const form = readTplEditForm();
    const slot = form.sections[Number(sectionText)]?.slots?.[Number(slotText)];
    if (slot) {
      if (!Array.isArray(slot.items)) slot.items = [];
      slot.items.push({ text: '' });
    }
    renderTplEditForm(tplFormStateOf(item, form));
    setTplDrawerStatus('已加一项（保存前都还没写进库）；记得填这一项的文字');
    return;
  }
  if (el.dataset && el.dataset.tplItemDel) {
    const item = tplItemOf(TPL_DRAWER_ITEM);
    if (!item) return;
    const [, sectionText, slotText, itemText] = String(el.dataset.tplItemDel).split(':');
    const form = readTplEditForm();
    const slot = form.sections[Number(sectionText)]?.slots?.[Number(slotText)];
    if (slot && Array.isArray(slot.items)) {
      if (slot.items.length <= 1) {
        setTplDrawerStatus('这是最后一项：列表至少要有一项，否则它什么都不产出。要整条列表都去掉，请直接删掉这个槽位。');
        return;
      }
      slot.items.splice(Number(itemText), 1);
    }
    renderTplEditForm(tplFormStateOf(item, form));
    setTplDrawerStatus('已删一项（保存前都还没写进库）');
    return;
  }
  if (el.dataset && el.dataset.tplSlotDel) {
    const item = tplItemOf(TPL_DRAWER_ITEM);
    if (!item) return;
    const form = readTplEditForm();
    const [, sectionText, slotText] = String(el.dataset.tplSlotDel).split('|');
    const section = form.sections[Number(sectionText)];
    if (section) section.slots.splice(Number(slotText), 1);
    renderTplEditForm(tplFormStateOf(item, form));
    return;
  }

  if (el.dataset && el.dataset.tplSecMove) {
    const item = tplItemOf(TPL_DRAWER_ITEM);
    if (!item) return;
    const [, indexText, deltaText] = String(el.dataset.tplSecMove).split('|');
    const form = readTplEditForm();
    const from = Number(indexText);
    const delta = Number(deltaText);
    if (!tplMove(form.sections, from, delta)) return;
    renderTplEditForm(tplFormStateOf(item, form));
    setTplDrawerStatus(`已把第 ${from + 1} 章挪到第 ${from + delta + 1} 章的位置（保存前都还没写进库）`);
    return;
  }
  if (el.dataset && el.dataset.tplSlotMove) {
    const item = tplItemOf(TPL_DRAWER_ITEM);
    if (!item) return;
    const [, sectionText, slotText, deltaText] = String(el.dataset.tplSlotMove).split('|');
    const form = readTplEditForm();
    const si = Number(sectionText);
    const ti = Number(slotText);
    const section = form.sections[si];
    if (!section || !tplMove(section.slots, ti, Number(deltaText))) return;
    renderTplEditForm(tplFormStateOf(item, form));
    setTplDrawerStatus(`已挪动「${section.title || `第 ${si + 1} 章`}」里的第 ${ti + 1} 格（保存前都还没写进库）`);
    return;
  }

  if (el.dataset && el.dataset.tplSecFrag) {
    if (!(await requireSession())) return;
    const [, indexText] = String(el.dataset.tplSecFrag).split('|');
    const form = readTplEditForm();
    const section = form.sections[Number(indexText)];
    if (!section) return;
    const name = await askText(
      '把这一章存成一个片段？\n\n存下来的是这一章此刻的内容（含它的每一格）：以后在别的文书里可以一次插进来。\n会落在本院自建包里；这一章用到的表达式控件会一起带过去（模板用到的控件必须与模板同包）。\n不影响：这份文书，也不影响任何已开出的病历。',
      {
        defaultValue: String(section.title || '未命名的片段'),
        placeholder: '片段名称（如：门诊常规查体）',
        okLabel: '存为片段',
        required: true,
        requiredHint: '片段名称不能为空：它是插入片段时看到的那一行。',
      },
    );
    if (name === null) return;
    const r = await api('/api/fragment-item-create', { name, sections: [section] });
    if (r && r.state) {
      S = r.state;
      renderModelPanel();
    }
    if (r && r.ok) {
      const fresh = tplItemOf(TPL_DRAWER_ITEM);
      if (fresh) renderTplEditForm(tplFormStateOf(fresh, form));
    }
    const carried = r && r.ok && r.data && Array.isArray(r.data.copiedControls) && r.data.copiedControls.length > 0
      ? `（一并带过来 ${r.data.copiedControls.length} 个表达式控件：${r.data.copiedControls.map((one) => `${esc(one.from)} → ${esc(one.to)}`).join('、')}）`
      : '';
    setTplDrawerStatus(r && r.ok
      ? `已存为片段「${esc(name)}」（${esc(String(r.data && r.data.itemId))}）：现在可以在别的文书里插它了${carried}`
      : `存为片段失败：${esc(String((r && (r.message || r.code)) || '未知原因'))}`);
    return;
  }

  if (el.dataset && (el.dataset.tplFragAppend || el.dataset.tplFragInsert)) {
    const item = tplItemOf(TPL_DRAWER_ITEM);
    if (!item) return;
    const box = $(tplDrawerBodyId());
    const picker = box ? box.querySelector('[data-tpl-frag-pick]') : null;
    const picked = picker ? String(picker.value || '') : '';
    if (picked === '') {
      setTplDrawerStatus('先在「章节片段」里选一段，再点「追加到末尾」，或某一章上的「插入片段」');
      return;
    }
    const [, fragmentId] = picked.split('|');
    const incoming = fragmentSectionsOf(fragmentId);
    if (!incoming) {
      setTplDrawerStatus('这段片段在库里找不到了（可能在别处被删掉）：关掉抽屉重开一次再试');
      return;
    }
    const gaps = fragmentControlGaps(incoming, item.packId);
    if (gaps.length > 0) {
      setTplDrawerStatus('这段片段用到了这份文书所属包里没有的表达式控件，插不进来：'
        + gaps.map((gap) => `「${esc(gap.section)}」的「${esc(gap.key)}」引用了 <b>${esc(gap.controlId)}</b>`).join('；')
        + '<br>模板用到的控件必须与模板同包：先把那个控件（或引用了它的那份文书）复制进本院自建包；'
        + '或者在片段抽屉里把那一格删掉再插。');
      return;
    }
    const form = readTplEditForm();
    const at = el.dataset.tplFragInsert
      ? Number(String(el.dataset.tplFragInsert).split('|')[1]) + 1
      : form.sections.length;
    const renamed = tplInsertSections(form, at, incoming);
    renderTplEditForm(tplFormStateOf(item, form));
    setTplDrawerStatus(`已插入 ${incoming.length} 章（来自片段）：`
      + (renamed > 0
        ? `其中 ${renamed} 个槽位名与现有重复，已自动改名（加 <b>_2</b> 这样的后缀）—— 槽位名在整份文书里必须唯一`
        : '槽位名没有冲突')
      + '。位置用章标题旁的 ↑ / ↓ 调；保存前都还没写进库。');
    return;
  }

  if (el.dataset && el.dataset.tplDuplicate) {
    if (!(await requireSession())) return;
    const [packId, itemId] = String(el.dataset.tplDuplicate).split('|');
    const item = tplItemOf(itemId);
    const name = await askText(
      `复制「${item?.name ?? itemId}」？\n\n会得到：本院自建包里的一份草稿副本（要开它得先「发布」）。\n会一起带过来：它用到的表达式控件（缺哪个带哪个、换成自建编号）—— 模板用到的控件必须与模板同包。\n不影响：原模板，以及任何已开出的病历。`,
      {
        defaultValue: `${item?.name ?? itemId}（副本）`,
        placeholder: '副本名称',
        okLabel: '复制',
        required: true,
        requiredHint: '副本名称不能为空：它是「新建」里的那一行。',
      },
    );
    if (name === null) return;
    const r = await api('/api/template-item-duplicate', { packId, itemId, name });
    if (r && r.state) {
      S = r.state;
      renderModelPanel();
    }
    if (r && r.ok && r.data) {
      const fresh = tplItemOf(String(r.data.itemId));
      if (fresh) {
        TPL_DRAWER_ITEM = fresh.itemId;
        openTplDrawer(`编辑：${fresh.name}`, '');
        renderTplEditForm(fresh);
      }
    }
    const carried = r && r.ok && r.data && Array.isArray(r.data.copiedControls) && r.data.copiedControls.length > 0
      ? `（一并带过来 ${r.data.copiedControls.length} 个表达式控件：${r.data.copiedControls.map((one) => `${esc(one.from)} → ${esc(one.to)}`).join('、')}）`
      : '';
    setTplPackStatus(r && r.ok
      ? `已复制「${item?.name ?? itemId}」→ ${esc(String(r.data && r.data.itemId))}「${esc(String(name))}」：状态是<b>草稿</b>${carried}`
      : `复制失败：${(r && (r.message || r.code)) || '未知原因'}`);
    return;
  }

  if (el.dataset && el.dataset.tplFragEdit) {
    const [, fragmentId] = String(el.dataset.tplFragEdit).split('|');
    const item = tplItemOf(fragmentId);
    if (!item) return;
    TPL_DRAWER_ITEM = fragmentId;
    openTplDrawer(`编辑片段：${item.name}`, '');
    renderTplEditForm(item);
    return;
  }
  if (el.dataset && el.dataset.tplFragDelete) {
    if (!(await requireSession())) return;
    const [packId, itemId] = String(el.dataset.tplFragDelete).split('|');
    const item = tplItemOf(itemId);
    if (!(await askConfirm(
      `删除章节片段「${item?.name ?? itemId}」？\n\n会影响：片段库里少一段，插入片段的下拉里立刻没有它。\n不影响：已经用这个片段拼好的文书（插入是复制，不是引用 —— 那些文书一个字都不会变），也不影响任何已开出的病历。\n这是一次换包内容的动作：内容指纹会变，前后指纹进系统审计，没有撤销。`,
      { okLabel: '删除', tone: 'danger' },
    ))) return;
    const r = await api('/api/fragment-item-delete', { packId, itemId });
    if (r && r.state) {
      S = r.state;
      renderModelPanel();
    }
    setTplPackStatus(r && r.ok
      ? `已删除片段「${item?.name ?? itemId}」：用这个片段拼好的文书一个字都不会变`
      : `删除失败：${(r && (r.message || r.code)) || '未知原因'}`);
    return;
  }
  if (el.dataset && el.dataset.tplFragSave) {
    if (!(await requireSession())) return;
    const [packId, itemId] = String(el.dataset.tplFragSave).split('|');
    const form = readTplEditForm();
    const name = String(form.name || '').trim();
    if (name === '') {
      setTplDrawerStatus('片段名称不能为空（它是插入片段时看到的那一行）');
      return;
    }
    if (!tplItemOf(itemId)) {
      setTplDrawerStatus('这个片段在库里找不到了（可能已在别处删除）：关掉抽屉重新打开一次再存');
      return;
    }
    const r = await api('/api/fragment-item-update', {
      packId,
      itemId,
      name,
      description: String(form.description || ''),
      sections: form.sections,
    });
    if (r && r.state) {
      S = r.state;
      renderModelPanel();
    }
    if (r && r.ok) closeTplDrawer();
    setTplPackStatus(r && r.ok
      ? r.data && r.data.action === 'unchanged'
        ? `已保存片段「${name}」：内容与库里那份相同，未改动`
        : `已保存片段「${name}」：换了一版内容（已经用它拼好的文书不受影响）`
      : `保存失败：${(r && (r.message || r.code)) || '未知原因'}`);
    return;
  }

  if (el.dataset && el.dataset.tplSave) {
    if (!(await requireSession())) return;
    const [packId, itemId] = String(el.dataset.tplSave).split('|');
    const item = tplItemOf(itemId);
    const form = readTplEditForm();
    const name = form.name.trim();
    if (name === '') {
      setTplPackStatus('名称不能为空（它是文书在「新建」里的那一行）');
      return;
    }
    const payload = {
      packId,
      itemId,
      name,
      departments: form.departments,
    };
    if (!item) {
      setTplPackStatus('这份文书在库里找不到了（可能已在别处删除）：关掉抽屉重新打开一次再存');
      return;
    }
    if (item.status === 'draft') payload.sections = form.sections;
    else {
      payload.slotMeta = slotMetaOf(form.sections);
      payload.sectionMeta = sectionMetaOf(form.sections);
    }
    const r = await api('/api/template-item-update', payload);
    if (r && r.state) {
      S = r.state;
      renderModelPanel();
    }
    if (r && r.ok) closeTplDrawer();
    setTplPackStatus(r && r.ok
      ? r.data && r.data.action === 'unchanged'
        ? `已保存「${name}」：内容与库里那份相同，未改动`
        : `已保存「${name}」：换了一版内容`
      : `保存失败：${(r && (r.message || r.code)) || '未知原因'}`);
    return;
  }

  if (el.dataset && el.dataset.tplStatus) {
    if (!(await requireSession())) return;
    const [packId, itemId] = String(el.dataset.tplStatus).split('|');
    const to = String(el.dataset.tplTo || '');
    if (to === 'draft' && !(await askConfirm(
      `把「${tplItemOf(itemId)?.name ?? itemId}」撤稿？\n\n会影响：医生端立刻开不出这一份文书（撤稿后要改章节与槽位，改完再点「发布」）。\n不影响：已经开出的病历（一个字都不变）。`,
      { okLabel: '撤稿', tone: 'danger' },
    ))) return;
    const r = await api('/api/template-item-update', { packId, itemId, status: to });
    if (r && r.state) {
      S = r.state;
      renderModelPanel();
    }
    setTplPackStatus(r && r.ok
      ? `${to === 'active' ? '已发布' : '已撤稿'}：${tplItemOf(itemId)?.name ?? itemId}`
        + `${to === 'active' ? '（医生端现在能照着它开文书了）' : '（医生端现在开不出它了）'}`
      : `${to === 'active' ? '发布' : '撤稿'}失败：${(r && (r.message || r.code)) || '未知原因'}`);
    return;
  }

  if (el.dataset && el.dataset.tplDelete) {
    if (!(await requireSession())) return;
    const [packId, itemId] = String(el.dataset.tplDelete).split('|');
    const item = tplItemOf(itemId);
    if (!(await askConfirm(
      `删除文书「${item?.name ?? itemId}」？\n\n会影响：模板库里少一份，医生端「新建」里立刻没有它。\n不影响：已经开出的病历（它们只带着模板指纹，一个字都不变）。\n这是一次换包内容的动作：内容指纹会变，前后指纹进系统审计，没有撤销。`,
      { okLabel: '删除', tone: 'danger' },
    ))) return;
    const r = await api('/api/template-item-delete', { packId, itemId });
    if (r && r.state) {
      S = r.state;
      renderModelPanel();
    }
    setTplPackStatus(r && r.ok
      ? `已删除「${item?.name ?? itemId}」；内容指纹 → ${r.data && r.data.fingerprintAfter}`
      : `删除失败：${(r && (r.message || r.code)) || '未知原因'}`);
    return;
  }

  if (el.id === 'btnCreateRule') {
    renderRuleCreateForm();
    const body = $('ruleDrawerBody');
    const nameEl = body ? body.querySelector('[data-rule-input="title"]') : null;
    if (nameEl) nameEl.focus();
    return;
  }

  if (el.id === 'ruleDrawerClose') {
    closeRuleDrawer();
    return;
  }

  if (el.dataset && el.dataset.condAdd) {
    const box = el.closest ? el.closest('.cond-builder') : null;
    if (!box) return;
    const draft = conditionDraftFromDom(box);
    draft.rows.push({ field: '', op: '', value: undefined });
    box.innerHTML = conditionBlockBodyHtml(draft);
    return;
  }

  if (el.dataset && el.dataset.condDel) {
    const box = el.closest ? el.closest('.cond-builder') : null;
    if (!box) return;
    const draft = conditionDraftFromDom(box);
    const index = Number(el.dataset.condDel);
    if (Number.isInteger(index) && index >= 0 && index < draft.rows.length) draft.rows.splice(index, 1);
    box.innerHTML = conditionBlockBodyHtml(draft);
    return;
  }

  if (el.dataset && el.dataset.ruleEdit) {
    const [, itemId] = String(el.dataset.ruleEdit).split('|');
    const item = ruleItemOf(itemId);
    if (!item) return;
    renderRuleEditForm(item);
    return;
  }

  if (el.dataset && el.dataset.ruleCancel) {
    closeRuleDrawer();
    return;
  }

  if (el.dataset && el.dataset.rulePage) {
    RULE_PAGE = Number(el.dataset.rulePage) || 1;
    renderRuleTable(Array.isArray(((S || {}).knowledgePacks || {}).rules) ? S.knowledgePacks.rules : []);
    return;
  }

  if (el.dataset && el.dataset.ruleSubmit) {
    if (!(await requireSession())) return;
    const form = readRuleForm();
    const title = form.title.trim();
    if (title === '') {
      setQcPackStatus('请填标题（它是质控清单与医生端提示里显示的那一行）');
      return;
    }
    if (form.kind === '') {
      setQcPackStatus('判定方式没读到（服务端没下发 `qcPredicates`）：刷新一次再存。'
        + '规则不说明「按什么判」不成立，而交一条引擎不认的规则要等质控跑起来才会暴露。');
      return;
    }
    if (form.params.conditionId !== undefined && form.params.when !== undefined) {
      setQcPackStatus('判定方式是「引用一条判定方式」与「就地拼一条」两选一：请把其中一格留空');
      return;
    }
    if (form.conditionLocked) {
      setQcPackStatus('这条规则里有嵌套条件，构造器改不了 —— 摊平会改变它的含义；请先删掉它再重建一条');
      return;
    }
    if (form.conditionPending) {
      setQcPackStatus('就地拼一条：至少要有一条「字段 + 算子 + 取值」都填好的条件。'
        + '（要引用判定方式的话，在上面那一格选一条。）');
      return;
    }
    const isCreate = String(el.dataset.ruleSubmit) === 'create';
    const current = isCreate ? null : ruleItemOf(RULE_DRAWER_ITEM);
    if (!isCreate && !current) {
      setQcPackStatus('这条规则在库里找不到了（可能已在别处删除）：关掉抽屉重新打开一次再存');
      return;
    }
    const payload = {
      title,
      severity: form.severity,
      predicate: { kind: form.kind, params: form.params },
      detail: form.detail,
      suggestion: form.suggestion,
    };
    const r = isCreate
      ? await api('/api/rule-item-create', payload)
      : await api('/api/rule-item-update', { packId: current.packId, itemId: current.itemId, ...payload });
    if (r && r.state) {
      S = r.state;
      if (r.ok && isCreate && r.data && r.data.itemId) ruleGotoItemPage(String(r.data.itemId));
      renderModelPanel();
    }
    if (r && r.ok) closeRuleDrawer();
    setQcPackStatus(r && r.ok
      ? isCreate
        ? `已新建「${title}」（${(r.data && r.data.itemId) || ''}）：状态是<b>停用</b> —— 下一轮质控不跑它；确认无误后在那一行点「启用」`
        : r.data && r.data.action === 'unchanged'
          ? `已保存「${title}」：内容与库里那份相同，未改动`
          : `已保存「${title}」：换了一版内容（内容指纹已变，前后指纹进系统审计）`
      : `保存失败：${(r && (r.message || r.code)) || '未知原因'}`);
    return;
  }

  if (el.dataset && el.dataset.ruleDelete) {
    if (!(await requireSession())) return;
    const [packId, itemId] = String(el.dataset.ruleDelete).split('|');
    const item = ruleItemOf(itemId);
    const label = (item && item.title) || itemId;
    if (!(await askConfirm(
      `删除规则「${label}」？\n\n会影响：规则库里少一条，下一轮质控不再跑它（若它本来启用着）。\n不影响：已经产生的质控提示（它们是旁挂注解，仍读得出来）与已有病历（一个字都不变）。\n这是一次换包内容的动作：内容指纹会变，前后指纹进系统审计，没有撤销。`,
      { okLabel: '删除', tone: 'danger' },
    ))) return;
    const r = await api('/api/rule-item-delete', { packId, itemId });
    if (r && r.state) {
      S = r.state;
      renderModelPanel();
    }
    setQcPackStatus(r && r.ok
      ? `已删除「${label}」${r.data && r.data.action === 'deleted'
        ? '（它是这个包里最后一条，包一并移除）'
        : `；内容指纹 → ${(r.data && r.data.fingerprintAfter) || '—'}`}`
      : `删除失败：${(r && (r.message || r.code)) || '未知原因'}`);
    return;
  }

  if (el.dataset && el.dataset.packToggle) {
    if (!(await requireSession())) return;
    const [packId, itemId] = String(el.dataset.packToggle).split('|');
    const enabled = el.dataset.packEnabled !== '1';
    const catalogItem = (Array.isArray((S || {}).templateCatalog) ? S.templateCatalog : [])
      .find((item) => item.itemId === itemId);
    let status = setQcPackStatus;
    if (catalogItem) {
      if (catalogItem.itemType === 'control') status = setCtrlCatalogStatus;
      else if (catalogItem.itemType === 'expression') status = setExprCatalogStatus;
      else status = setTplPackStatus;
    }
    const r = await api('/api/knowledge-pack-toggle', { packId, itemId, enabled });
    if (r && r.state) {
      S = r.state;
      renderModelPanel();
    }
    status(r && r.ok
      ? `已${enabled ? '启用' : '停用'} ${itemId}；生效指纹 ${((S || {}).knowledgePacks || {}).effectiveFingerprint || '—'}`
      : `未能修改开关：${(r && (r.message || r.code)) || '未知原因'}`);
    return;
  }

  if (CFG_ADMIN_ACTIONS.has(el.id) && !(await requireSession())) return;

  if (el.id === 'cfgSave') { await saveModelConfigFromForm(undefined); return; }
  if (el.id === 'cfgClearKey') {
    /* 危险操作二次确认：它不可撤销，密钥一清，模型立刻 401，而按钮就在"保存"旁边 */
    if (!(await askConfirm(
      '确定清除模型的 API Key？\n\n清除后模型会立刻不可用，需要重新填写（此操作没有撤销）。',
      { okLabel: '清除', tone: 'danger' },
    ))) return;
    await saveModelConfigFromForm(null);
    return;
  }
  if (el.id === 'cfgPlaceSave') { await savePlacementFromForm(undefined); return; }
  if (el.id === 'cfgPlaceClearKey') {
    /* 危险操作二次确认（同模型/采集密钥）：它会立刻让外部落位服务不可用 */
    if (!(await askConfirm(
      '确定清除外部落位服务的密钥？\n\n清除后该类落位会立刻失败，需要重新填写（此操作没有撤销）。',
      { okLabel: '清除', tone: 'danger' },
    ))) return;
    await savePlacementFromForm(null);
    return;
  }
  if (el.id === 'cfgPrevisitSave') { await savePrevisitAccessFromForm(undefined); return; }
  if (el.id === 'cfgPrevisitClearKey') {
    if (!(await askConfirm(
      '确定清除预问诊接入口令？\n\n清除后若仍要求校验，外部系统会立刻写不进来（"已要求校验但没有密钥"= 一律拒绝）。此操作没有撤销。',
      { okLabel: '清除', tone: 'danger' },
    ))) return;
    await savePrevisitAccessFromForm(null);
    return;
  }
  if (el.id === 'cfgCaptureSave') { await saveCaptureFromForm(undefined, undefined); return; }
  if (el.id === 'cfgCaptureClearKey') {
    if (!(await askConfirm(
      '确定清除语音采集的凭据？\n\n若该服务需要认证，清除后采集会立刻失败，需要重新填写（此操作没有撤销）。',
      { okLabel: '清除', tone: 'danger' },
    ))) return;
    await saveCaptureFromForm(null, undefined);
    return;
  }
  if (el.id === 'cfgCaptureClearSecret') {
    if (!(await askConfirm(
      '确定清除语音采集的次凭据（Secret Key）？\n\n若当前选的是百度，清除后采集会立刻失败（此操作没有撤销）。',
      { okLabel: '清除', tone: 'danger' },
    ))) return;
    await saveCaptureFromForm(undefined, null);
    return;
  }
  if (el.id === 'cfgAuthSave') { await saveAuthorityFromForm(); return; }
  if (el.id === 'cfgAuthImportBtn') { await importCredentialFromForm(); return; }
  if (el.id === 'cfgSysPolicySave') { await saveSystemPolicyFromForm(undefined); return; }
  if (el.id === 'cfgSysSeedClear') {
    if (!(await askConfirm(
      '确定清除自定义的锚点签名种子？\n\n清除后改用内置演示种子：任何拿得到本仓库代码的人都能重签锚点（此操作没有撤销）。',
      { okLabel: '清除', tone: 'danger' },
    ))) return;
    await saveSystemPolicyFromForm(null);
    return;
  }
  if (el.id === 'cfgWorkspaceReset') {
    if (!(await askConfirm(
      '确定清空工作区？\n\n'
      + '会清掉：全部病历（含留痕）、已落盘的旁挂数据（AI 建议 / 标注）、阅读授权登记；随后按出厂演示数据重新播种。\n'
      + '不会动：账号、能力配置、系统策略、知识资产（模板 / 规则 / 控件）、管理审计。\n'
      + '另外一个后果：医生端已打开的页面要刷新 —— 它手里的版本号还是重置之前的。\n\n'
      + '此操作不可撤销。',
      { okLabel: '清空并复位', tone: 'danger' },
    ))) return;
    const r = await api('/api/reset', {});
    if (r && r.ok) {
      await apply(r);
      const tree = Array.isArray(r.state && r.state.tree) ? r.state.tree : [];
      const docs = tree.reduce((sum, patient) => sum + (Array.isArray(patient.visits) ? patient.visits : [])
        .reduce((count, visit) => count + (Array.isArray(visit.docs) ? visit.docs.length : 0), 0), 0);
      setWorkspaceResetStatus(`已清空并复位：现在库里有 ${tree.length} 位患者 / ${docs} 份病历（医生端请刷新页面）`);
    } else {
      setWorkspaceResetStatus(`未能清空：${(r && (r.message || r.code)) || '未知原因'}`);
      await requireSession();
    }
    return;
  }
  if (el.id === 'cfgQcContentSave') { await saveQcContentFromForm(undefined); return; }
  if (el.id === 'cfgQcTokenClear') {
    if (!(await askConfirm(
      '确定清除内涵质控引擎的凭据？\n\n若引擎需要认证，清除后质控外呼会立刻失败（此操作没有撤销）。',
      { okLabel: '清除', tone: 'danger' },
    ))) return;
    await saveQcContentFromForm(null);
    return;
  }
  if (el.id === 'cfgSignSave') { await saveSignBackendFromForm(undefined); return; }
  if (el.id === 'cfgSignClearKey') {
    /* 危险操作二次确认（同模型/采集/落位密钥）：清除后若签名服务需要认证，签章会立刻失败 */
    if (!(await askConfirm(
      '确定清除签名服务的密钥？\n\n若签名服务需要认证，清除后签章会立刻失败，需要重新填写（此操作没有撤销）。',
      { okLabel: '清除', tone: 'danger' },
    ))) return;
    await saveSignBackendFromForm(null);
    return;
  }
  if (el.id === 'cfgSignTest') { await runSignTest(); return; }
  if (el.id === 'healthSignTest') {
    await runSignTest($('healthSignStatus'));
    await loadAdminView('health');
    return;
  }
  if (el.id === 'auditRefresh') { await loadAdminView('audit'); return; }
  if (el.id === 'acctRefresh') { await loadAdminView('accounts'); return; }

  if (el.id === 'deptRefresh') { await loadAdminView('master'); return; }

  if (el.id === 'exprCatalogRefresh') { await refresh(); return; }

  if (el.id === 'ctrlCatalogRefresh') { await refresh(); return; }

  if (el.id === 'conditionLibRefresh') { await loadAdminView('master'); return; }

  if (el.id === 'btnCreateCondition') {
    renderConditionCreateForm();
    const body = $('conditionDrawerBody');
    const nameEl = body ? body.querySelector('[data-cond-input="name"]') : null;
    if (nameEl) nameEl.focus();
    return;
  }

  if (el.id === 'conditionDrawerClose') {
    closeConditionDrawer();
    return;
  }

  if (el.dataset && el.dataset.condCancel) {
    closeConditionDrawer();
    return;
  }

  if (el.dataset && el.dataset.condParamAdd) {
    const params = readConditionParams($('condParamsBox'));
    params.push({ name: '', kind: 'integer', label: '', doc: '' });
    const box = $('condParamsBox');
    if (box) box.innerHTML = conditionParamRowsHtml(params);
    return;
  }
  if (el.dataset && el.dataset.condParamDel) {
    const row = el.closest ? el.closest('[data-cond-param-row]') : null;
    if (row && row.parentElement) row.parentElement.removeChild(row);
    return;
  }

  if (el.dataset && el.dataset.condlibCopy) {
    const item = conditionItemOf(String(el.dataset.condlibCopy));
    if (!item) {
      setConditionLibStatus('这条判定方式在库里找不到了：刷新这一页再看');
      return;
    }
    renderConditionCreateForm(item);
    return;
  }

  if (el.dataset && el.dataset.condlibEdit) {
    const itemId = String(el.dataset.condlibEdit);
    const item = conditionItemOf(itemId);
    if (!item) {
      setConditionLibStatus('这条判定方式在库里找不到了（可能已在别处删除）：刷新这一页再看');
      return;
    }
    renderConditionEditForm(item);
    return;
  }

  if (el.dataset && el.dataset.condSubmit) {
    if (!(await requireSession())) return;
    const form = readConditionForm();
    if (form.name === '') {
      setConditionLibStatus('请填名字（规则抽屉的「判定方式」那一格按名字挑它）');
      return;
    }
    if (form.conditionPending) {
      setConditionLibStatus('判定方式还空着：至少要有一条「字段 + 算子 + 取值」都填好的条件');
      return;
    }
    const isCreate = String(el.dataset.condSubmit) === 'create';
    const payload = {
      name: form.name,
      description: form.description,
      params: form.params,
      ...(form.conditionLocked ? {} : { when: form.when }),
    };
    const r = isCreate
      ? await api('/api/qc-condition-create', payload)
      : await api('/api/qc-condition-update', { itemId: CONDITION_DRAWER_ITEM, ...payload });
    const users = (r && r.data && Array.isArray(r.data.usedBy)) ? r.data.usedBy : [];
    if (r && r.state) {
      S = r.state;
      renderPredicates();
      renderKnowledgePacks();
    }
    if (r && r.ok) closeConditionDrawer();
    setConditionLibStatus(r && r.ok
      ? isCreate
        ? `已新建判定方式「${form.name}」（${(r.data && r.data.itemId) || ''}）：规则抽屉里「判定方式」那一格就能挑到它`
        : form.conditionLocked
          ? `已保存判定方式「${form.name}」的名称与说明；条件本身有嵌套，这次没有改动它`
          : `已保存判定方式「${form.name}」：引用它的 ${users.length} 条规则下一轮质控会跟着变`
            + `${users.length > 0 ? `（分布在 ${new Set(users.map((user) => user.packId)).size} 个包）` : ''}`
      : `保存失败：${(r && (r.message || r.code)) || '未知原因'}`);
    return;
  }

  if (el.dataset && el.dataset.condlibDelete) {
    if (!(await requireSession())) return;
    const itemId = String(el.dataset.condlibDelete);
    const item = conditionItemOf(itemId);
    const label = (item && item.name) || itemId;
    const users = item && Array.isArray(item.usedBy) ? item.usedBy : [];
    if (users.length > 0) {
      setConditionLibStatus(`「${label}」还被 ${users.length} 条规则引用（${users.map((user) => `${user.packId} / ${user.title}`).join('、')}）：先把那些规则改成别的判定方式，再删它`);
      return;
    }
    if (!(await askConfirm(
      `删除判定方式「${label}」（${itemId}）？\n\n会影响：没有规则引用它，规则库一条都不变。\n不影响：已有病历（质控提示是旁挂注解，仍读得出来）。\n判定方式库不属于任何包，所以这次动作不动包内容；但审计里会单独记一条，没有撤销。`,
      { okLabel: '删除', tone: 'danger' },
    ))) return;
    const r = await api('/api/qc-condition-delete', { itemId });
    if (r && r.state) {
      S = r.state;
      renderPredicates();
      renderKnowledgePacks();
    }
    setConditionLibStatus(r && r.ok
      ? `已删除判定方式「${label}」`
      : `未能删除「${label}」：${(r && (r.message || r.code)) || '未知原因'}`);
    return;
  }
  if (el.id === 'deptAdd') {
    const body = $('deptBody');
    if (body) {
      /* 第一次点"新增"时那句"还没有任何科室"要先消失，否则行会加在那段说明后面 */
      if (body.querySelector('.muted') && !body.querySelector('.dept-row')) body.innerHTML = '';
      body.insertAdjacentHTML('beforeend', deptRowHtml({ code: '', name: '', enabled: true }));
      const row = body.querySelector('.dept-row:last-child [data-dept-code]');
      if (row) row.focus();
    }
    return;
  }
  if (el.dataset && el.dataset.deptDel) {
    const row = el.closest ? el.closest('.dept-row') : null;
    if (!row) return;
    const code = String((row.querySelector('[data-dept-code]') || {}).value || '').trim();
    const name = String((row.querySelector('[data-dept-name]') || {}).value || '').trim();
    if (code !== '' && !(await askConfirm(
      `删掉科室「${name || code}」（${code}）？\n\n保存之后：模板上配了这个科室的文书立刻开不出（编码对不上任何人）—— 那些文书本身不受影响，改回科室即可恢复。\n已经开出的病历一个字都不变。`,
      { okLabel: '删除', tone: 'danger' },
    ))) return;
    row.remove();
    return;
  }
  if (el.id === 'deptSave') {
    if (!(await requireSession())) return;
    const items = readDepartmentRows();
    const r = await api('/api/departments', { items });
    if (r && r.state) {
      S = r.state;
      renderModelPanel();
    }
    if (r && r.ok) renderDepartments(r.data);
    setDeptStatus(r && r.ok
      ? `已保存 ${items.length} 个科室`
        + `${(r.data && r.data.removedCodes || []).length > 0
          ? `；被去掉的：${(r.data.removedCodes || []).join('、')}（配了它们的文书现在开不出，改回来即可恢复）`
          : ''}`
      : `保存失败：${(r && (r.message || r.code)) || '未知原因'}`);
    return;
  }

  if (el.id === 'docTypeRefresh') { await loadAdminView('master'); return; }
  if (el.id === 'docTypeAdd') {
    const body = $('docTypeBody');
    if (body) {
      /* 第一次点"新增"时那句"还没有任何类型"要先消失，否则行会加在那段说明后面 */
      if (body.querySelector('.muted') && !body.querySelector('.doc-type-row')) body.innerHTML = '';
      body.insertAdjacentHTML('beforeend', docTypeRowHtml({ system: DOC_TYPE_SYSTEMS[0] || 'local', code: '', display: '', enabled: true }));
      const row = body.querySelector('.doc-type-row:last-child [data-doctype-code]');
      if (row) row.focus();
    }
    return;
  }
  if (el.dataset && el.dataset.doctypeDel) {
    const row = el.closest ? el.closest('.doc-type-row') : null;
    if (!row) return;
    const code = String((row.querySelector('[data-doctype-code]') || {}).value || '').trim();
    const display = String((row.querySelector('[data-doctype-display]') || {}).value || '').trim();
    if (code !== '' && !(await askConfirm(
      `删掉文书类型「${display || code}」（${code}）？\n\n保存之后：质控规则里按这个编码定位文书的条目**再也判不到它** —— 不报错，只是静默不判（看起来"没问题"）。\n模板与已经开出的病历一个字都不变，改回来即可恢复。`,
      { okLabel: '删除', tone: 'danger' },
    ))) return;
    row.remove();
    return;
  }
  if (el.id === 'docTypeSave') {
    if (!(await requireSession())) return;
    const items = readDocTypeRows();
    const r = await api('/api/doc-types', { items });
    if (r && r.state) {
      S = r.state;
      renderModelPanel();
    }
    if (r && r.ok) renderDocTypes(r.data);
    setDocTypeStatus(r && r.ok
      ? `已保存 ${items.length} 个文书类型`
        + `${(r.data && r.data.removedKeys || []).length > 0
          ? `；被去掉的：${(r.data.removedKeys || []).join('、')}（按这些编码定位文书的质控规则现在判不到它，改回来即可恢复）`
          : ''}`
      : `保存失败：${(r && (r.message || r.code)) || '未知原因'}`);
    return;
  }

  if (el.id === 'acctCreate') {
    const username = $('acctNewName').value.trim();
    const password = $('acctNewPassword').value;
    $('acctNewPassword').value = '';
    if (username === '' || password === '') {
      setAcctStatus('账号与口令都必填（口令至少 8 位）');
      $('acctNewName').focus();
      return;
    }
    await accountAction('/api/admin/users', { username, password, role: $('acctNewRole').value }, setAcctStatus, `已新增账号「${username}」`);
    return;
  }
  if (el.id === 'acctPasswd') {
    const username = $('acctPwdName').value.trim();
    const password = $('acctPwdValue').value;
    $('acctPwdValue').value = '';
    if (username === '' || password === '') {
      setAcctPwdStatus('账号与新口令都必填（口令至少 8 位）');
      $('acctPwdName').focus();
      return;
    }
    await accountAction('/api/admin/users/password', { username, password }, setAcctPwdStatus, `已重设「${username}」的口令`);
    return;
  }
  if (el.dataset.acctReset) {
    $('acctPwdName').value = el.dataset.acctReset;
    $('acctPwdValue').value = '';
    $('acctPwdValue').focus();
    setAcctPwdStatus(`已选中「${el.dataset.acctReset}」：请在下方输入新口令`);
    return;
  }
  if (el.dataset.acctDisable || el.dataset.acctEnable) {
    const enable = Boolean(el.dataset.acctEnable);
    const username = enable ? el.dataset.acctEnable : el.dataset.acctDisable;
    if (!enable && !(await askConfirm(
      `停用账号「${username}」？\n\n它会立刻登不进来（已登录的会话也会被吊销），但账号与口令都还留着，随时可以启用。`,
      { okLabel: '停用', tone: 'danger' },
    ))) return;
    await accountAction('/api/admin/users/disabled', { username, disabled: !enable }, setAcctStatus, `${enable ? '已启用' : '已停用'}「${username}」`);
    return;
  }
  if (el.dataset.acctRemove) {
    const username = el.dataset.acctRemove;
    if (!(await askConfirm(
      `删除账号「${username}」？\n\n账号与口令哈希都会从数据库里删掉，没有撤销。\n如果他将来还要用，请改用「停用」。`,
      { okLabel: '删除', tone: 'danger' },
    ))) return;
    await accountAction('/api/admin/users/remove', { username }, setAcctStatus, `已删除「${username}」`);
    return;
  }
  if (el.id === 'cfgTest') {
    setCfgStatus('测试中…（只发一段与病历无关的测试文本）');
    const r = await api('/api/model-config/test', {});
    setCfgStatus(r.ok
      ? `连接正常：${r.data.modelId}，耗时 ${r.data.latencyMs}ms`
      : `连接失败：${(r && (r.message || r.code)) || '未知原因'}`);
    return;
  }
  if (el.dataset.rkRemove) { await apply(await api('/api/recipient-keys/remove', { keyId: el.dataset.rkRemove })); return; }
  if (el.dataset.rkExport) {
    const key = (S.recipientKeys && S.recipientKeys.keys ? S.recipientKeys.keys : []).find((item) => item.keyId === el.dataset.rkExport);
    if (key) $('rkText').value = pemFromBase64(key.spkiBase64);
  }
});

document.addEventListener('change', async (event) => {
  const el = event.target;
  if (el && el.dataset && el.dataset.ruleInput === 'conditionId') {
    renderRuleConditionSwitch(String(el.value || ''));
    return;
  }
  if (el && el.dataset && (el.dataset.condField !== undefined || el.dataset.condOp !== undefined || el.dataset.condLogic !== undefined)) {
    refreshConditionBlock(el.closest ? el.closest('.cond-builder') : null);
    return;
  }
  if (el && el.id === 'cfgPlaceStrategy') { syncPlacementTerms(el.value); return; }
  if (el && el.id === 'cfgCaptureKind') { applyCaptureVendorUi(el.value); syncCaptureKindHint(el.value); return; }
  if (el && el.dataset && el.dataset.acctRole) {
    const username = el.dataset.acctRole;
    const next = el.value;
    const before = (S.users || []).find((user) => user.username === username);
    if (!(await askConfirm(
      `把「${username}」的角色改为「${el.options[el.selectedIndex].text}」？\n\n该角色立刻生效，并吊销他已登录的会话（需重新登录）。`,
      { okLabel: '改角色' },
    ))) {
      /* 撤销这次选择：下拉框已经跳过去了，必须放回去，否则界面显示的是一份没生效的角色 */
      if (before) el.value = before.role;
      return;
    }
    const ok = await accountAction('/api/admin/users/role', { username, role: next }, setAcctStatus, `已改「${username}」的角色`);
    if (!ok && before) el.value = before.role;
  }
  if (el && el.dataset && String(el.dataset.tplInput || '').startsWith('slot:kind:')) {
    const item = tplItemOf(TPL_DRAWER_ITEM);
    if (!item) return;
    renderTplEditForm(tplFormStateOf(item, readTplEditForm()));
    return;
  }
  if (el && el.dataset && el.dataset.exprKind !== undefined) {
    TPL_EXPR_DRAFT = exprMutate(TPL_EXPR_DRAFT, String(el.dataset.exprKind), () => exprDefaultNodeOf(String(el.value)));
    renderExprTree();
    return;
  }
  if (el && el.dataset && el.dataset.exprFn !== undefined) {
    TPL_EXPR_DRAFT = exprMutate(TPL_EXPR_DRAFT, String(el.dataset.exprFn), (node) => {
      const fn = exprFunctionOf(String(el.value));
      const args = Array.isArray(node.args) ? node.args.slice() : [];
      const minArgs = fn ? fn.minArgs : 1;
      const maxArgs = fn && fn.maxArgs !== null ? fn.maxArgs : Number.POSITIVE_INFINITY;
      while (args.length < minArgs) args.push({ kind: 'num', value: 0 });
      if (args.length > maxArgs) args.length = maxArgs;
      return { kind: 'fn', name: String(el.value), args };
    });
    renderExprTree();
    return;
  }
  if (el && el.dataset && el.dataset.exprCtx !== undefined) {
    TPL_EXPR_DRAFT = exprMutate(TPL_EXPR_DRAFT, String(el.dataset.exprCtx), (node) => {
      node.key = String(el.value);
      return node;
    });
    return;
  }

});

(async () => {
  setConfigReady(false);
  bindTplDrawerOnce();
  bindRuleDrawerOnce();
  bindConditionDrawerOnce();
  const r = await api('/api/admin/session');
  if (r.ok) {
    session = { adminId: r.adminId, actorId: r.actorId, role: r.role, roleLabel: r.roleLabel, env: r.env };
    renderSession();
  } else {
    toLogin();
    return;
  }
  await refresh();
  const loaded = Boolean(S && S.model);
  setConfigReady(loaded);
  if (loaded) setLoginStatus('');
})();
