/* 管理后台脚本：能力配置 + 登录会话。
 *
 * 从医生端 `ui.js` 整体搬来，三处关键不同：
 *   1) 身份不再自报：保存/测试请求里没有 `adminId` 字段，操作者一律由服务端会话决定
 *      （原先"请求自己声明自己是管理员"，等于谁都能声称）。
 *   2) 没有 dialog 相关代码：抽屉变成了页面，`showModal`/遮罩/Esc/焦点归还全部不再需要。
 *   3) 登录门：未登录时配置体 `hidden`，保存前也先查会话，但这两条都只是省一次往返，
 *      真正的拦点在服务端（`requireAdminSession`）。
 */

const $ = (id) => document.getElementById(id);
/* 部署前缀（挂在工作站的某个路径下时由服务端注入在 `<html data-l0-base>` 上） */
const L0_BASE = (document.documentElement && document.documentElement.dataset.l0Base) || '';
function esc(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * 摘要行：`[标签, 值, 色调?]` → 一条条 chip。
 *
 * 为什么不用"当前：A · B · C · D"那种串法：一串用圆点分隔的灰字里，人只能靠自己找边界，
 * 而且要紧的那条（密钥未配置）和别的字一样灰，它应该是有颜色的。
 */
function chips(items) {
  return items.filter(Boolean).map(([label, value, tone]) => `<span class="chipline">`
    + `<span class="chipline-k">${esc(label)}</span>`
    + `<span class="chipline-v${tone ? ` ${tone}` : ''}">${esc(value)}</span></span>`).join('');
}

/**
 * 键值表：`[标签, 值, 类?]`。长值给 `title`，鼠标停上去看全，
 * 省略号不该是一条死路（截断是为了整齐，不是为了隐藏）。
 */
function kvRows(rows) {
  return rows.filter(Boolean).map(([label, value, cls]) => {
    const text = value === undefined || value === null || value === '' ? '—' : String(value);
    return `<span class="kv-k">${esc(label)}</span>`
      + `<span class="kv-v${cls ? ` ${cls}` : ''}" title="${esc(text)}">${esc(text)}</span>`;
  }).join('');
}

/**
 * 指标条：一个大数字 + 一行小标签。
 *
 * "展厅感"最直接的一处，也最容易走歪，所以先定死一条：只放真实数字。
 * 这几项都来自服务端的 counts；没有时间序列就不画趋势、没有对比就不摆百分比。
 */
function metricRow(items) {
  return items.filter(Boolean).map(([label, value]) => '<div class="metric">'
    + `<div class="metric-v">${esc(value ?? '—')}</div>`
    + `<div class="metric-k">${esc(label)}</div></div>`).join('');
}

/** 产出方式的人话：`offline` 是内部标识，界面上不该让人读它 */
const FORMAT_LABEL = {
  offline: '离线模板（不外呼）',
  'openai-compatible': '在线模型（会外呼）',
};


/* 会话 cookie 由服务端 Set-Cookie 下发（HttpOnly，脚本读不到），
   同源 fetch 默认带 cookie（credentials: 'same-origin'），所以这里不需要手动带任何头。 */
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

/** 页面级状态行（登录与加载）：与各面板的状态行分开，免得互相覆盖 */
function setLoginStatus(text, danger = false) {
  const el = $('loginStatus');
  el.textContent = text;
  el.classList.toggle('bad', danger);
}

/* -------------------------------- 会话 -------------------------------- */

/* 这一页只有登录后才会被下发（未登录时 `/admin` 会 302 到 `/login?next=/admin`），
   所以这里没有登录逻辑，也没有"未登录"这个状态，只有"现在是谁"与退出。

   会话中途失效（进程重启、口令被换）时跳回登录页，而不是让使用者对着一个
   "保存失败"猜原因：跳转比提示更干净，地址栏也会变成 `/login`。 */
let session = null;
let S = {};

/**
 * 每个分区在页头的标题与一行说明。
 *
 * 标题跟随分区：左栏回答"能去哪"，页头回答"现在在哪"，
 * 只高亮左栏的话，页面主体自己不说话，滚下去之后尤其容易失去方位。
 */
const VIEW_META = {
  config: { title: '能力配置', sub: '这里配置的是部署参数：模型地址、签名服务、授权源、落位策略。' },
  master: { title: '基础数据', sub: '整个部署共用的主数据：科室字典、文书类型、以及规则里的「判定方式」（只读清单）。模板的「适用科室」、就诊科室的显示、「新建文书」的类型选项、规则库里的判定方式都读它们。' },
  accounts: { title: '账号管理', sub: '谁可以进入后台、以什么角色进入。口令只以哈希保存在数据库，任何位置都不回显。' },
  health: { title: '运行状态', sub: '签名服务与模型探测的留档，以及这台机器上现在有多少东西。' },
  audit: { title: '审计与安全', sub: '谁在什么时候改了配置、从什么改成什么。登录成功与失败也记录在此。' },
  system: { title: '系统信息', sub: '这台机器上跑的是什么：版本 / 环境 / 目录 / 生效配置指纹。' },
};

/** 登录页地址：带上 next，登录后能自动回到后台（带部署前缀时两处都要带） */
const LOGIN_URL = `${L0_BASE}/login?next=${encodeURIComponent(`${L0_BASE}/admin`)}`;

function renderSession() {
  const role = session && session.roleLabel ? `（${session.roleLabel}）` : '';
  $('adminWho').textContent = session ? `已登录：${session.actorId || session.adminId}${role}` : '';
  /* 环境标识放左栏顶部：它是"你现在在哪一套环境"的唯一线索（此前只藏在「系统信息」里） */
  $('sideEnv').textContent = `环境：${(session && session.env) || '未标注'}`;
}

/** 回登录页。统一一处：免得有的分支跳、有的分支只提示，行为看运气 */
function toLogin() {
  location.href = LOGIN_URL;
}

async function logout() {
  /* 先告诉服务端删会话，再走，顺序反了的话，跳过去时 cookie 还活着 */
  await api('/api/admin/logout', {});
  session = null;
  toLogin();
}

/** 需要会话的动作统一前置检查；会话没了就送登录页（真正的判据在服务端返回码） */
async function requireSession() {
  if (session) return true;
  toLogin();
  return false;
}

/* ------------------------------ 状态行 ------------------------------ */

/**
 * 状态行：写文字，并按"成/败"着色。
 *
 * 失败若与"已保存"同色同字号，用户扫一眼就过去了，而配置类的失败恰恰最容易
 * 被读成"我点了但没生效"（表单里还留着自己填的值，看起来就像保存成功了）。
 */
function markCfgStatus(el, text) {
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('bad', /^(保存失败|测试失败|连接失败|导入失败|未导入|未能|请先)/.test(String(text)));
}
function setCfgStatus(text) { markCfgStatus($('cfgStatus'), text); }
/** 落位配置的状态行独立于模型配置：两处保存的失败原因不同，混在一行会互相覆盖 */
function setPlaceStatus(text) { markCfgStatus($('cfgPlaceStatus'), text); }
/** 采集配置的状态行同样独立（同落位/签名：失败原因不同，混一行会互相覆盖） */
function setCaptureStatus(text) { markCfgStatus($('cfgCaptureStatus'), text); }
/** 签名配置的状态行同理独立：测试签名的诊断结论很长，盖掉别人会让人以为没生效 */
function setSignStatus(text) { markCfgStatus($('cfgSignStatus'), text); }
/** 授权源的状态行独立（同落位/签名） */
function setAuthStatus(text) { markCfgStatus($('cfgAuthStatus'), text); }
function setAuthImportStatus(text) { markCfgStatus($('cfgAuthImportStatus'), text); }
/** 预问诊接入的状态行独立：它是外部写入的准入，与"授权谁可以读"是两件事 */
function setPrevisitStatus(text) { markCfgStatus($('cfgPrevisitStatus'), text); }
/** 「系统信息 · 工作区」的状态行同样独立：它与紧挨着的「系统策略」是两件事，混一行会互相覆盖 */
function setWorkspaceResetStatus(text) { markCfgStatus($('cfgWorkspaceResetStatus'), text); }
/** 规则包开关的状态行同样独立：它与"保存配置"是两件事，混在一行会互相覆盖 */
function setQcPackStatus(text) { markCfgStatus($('qcPackStatus'), text); }
/** 模板页的状态行独立于规则库页：两页都在改包，写进同一行会让人以为自己这页没生效 */
function setTplPackStatus(text) { markCfgStatus($('tplPackStatus'), text); }
/** 「基础数据 · 表达式控件」页的状态行同样独立：它在另一个页签上，写进模板页那行等于写在看不见的地方 */
function setExprCatalogStatus(text) { markCfgStatus($('exprCatalogStatus'), text); }
/** 「基础数据 · 专科控件」页的状态行同理独立（它在紧挨着的另一个页签上） */
function setCtrlCatalogStatus(text) { markCfgStatus($('ctrlCatalogStatus'), text); }

/**
 * 抽屉**自己**的状态行（在抽屉里，不在背后那块面板上）。
 *
 * 为什么必须有：排序（↑ / ↓）、插入片段、存为片段这些动作**不关抽屉** ——
 * 而 `#tplPackStatus` 在抽屉背后那块面板上，模态开着的时候它被遮住、看不见。
 * 把话写在看不见的地方等于没写：人会以为"点了没反应"，然后再点一次。
 */
function setTplDrawerStatus(text) {
  const box = $(tplDrawerBodyId());
  const line = box ? box.querySelector('[data-tpl-drawer-status]') : null;
  if (line) line.innerHTML = text;
}

/** 需要登录的动作：保存 / 清除密钥 / 测试。统一在一处拦，而不是在六个函数里各写一遍。 */
const CFG_ADMIN_ACTIONS = new Set([
  'cfgSave', 'cfgClearKey', 'cfgPlaceSave', 'cfgPlaceClearKey', 'cfgCaptureSave', 'cfgCaptureClearKey', 'cfgCaptureClearSecret', 'cfgPrevisitSave', 'cfgPrevisitClearKey', 'cfgAuthSave', 'cfgSignSave', 'cfgSignClearKey', 'cfgSignTest',
  /* 系统策略（决定"防不防"）与内涵质控（决定"病历内容发往哪台引擎"）：都是部署动作 */
  'cfgSysPolicySave', 'cfgSysSeedClear', 'cfgQcContentSave', 'cfgQcTokenClear',
  /* 运行状态页的"现在测一次"与它同源（都会外呼），一并要求登录 */
  'healthSignTest',
  /* 工作区重置（系统信息页）：只有管理员能做，且它擦的是全部病历 —— 一并纳入
     "数据到位之前禁用"，免得刚登进来时它是可点的（那一下的代价与其他按钮不是一个量级） */
  'cfgWorkspaceReset',
]);

/**
 * 数据到位之前，把配置动作按钮禁用。
 *
 * 为什么需要：后台页是整页下发的（独立登录页带来的结果），于是"页面已经出现、数据还没到"
 * 是一个真实存在的窗口，此时表单是空的，点"保存"就会把空值当新配置提交。
 * 服务端会拒（`timeoutMs 必须是正整数，实际 0`），但那是本不该出现的一次失败：
 * 实测发现过，现场表现是"我刚登进来点一下，它说我填错了"。
 */
function setConfigReady(ready) {
  for (const id of CFG_ADMIN_ACTIONS) {
    const el = $(id);
    if (el) el.disabled = !ready;
  }
  if (!ready) setLoginStatus('正在加载当前配置…（表单就绪之前「保存」是禁用的，免得把空值提交上去）');
}

/* ------------------------------ 渲染 ------------------------------ */

/**
 * 子页签：用隐藏而不是删掉/重建，切来切去时已填的内容不会丢。
 *
 * **必须限定在"点了哪一组页签"所属的分区里**（`data-admin-view-pane`）：
 * 管理后台不止一组子页签（「能力配置」一组、「基础数据」一组），
 * 而按 `document.querySelectorAll` 全局切换，会把**另一组**的面板一并置为非 active ——
 * 表现是"切了基础数据的页签，回到能力配置时一片空白"，且不会有任何报错。
 *
 * 所以这里收的是**被点的那颗页签本身**，而不是一个名字：分区从它身上问得出来，
 * 调用处因此不必知道"自己是哪一组"，多一组子页签也不用改这里。
 */
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
  /* 配置从 state 里取（`/api/state` 已下发脱敏后的 `model`），不另开读接口：
     少一条路由就少一处可被绕过的地方，而这份数据本来就是每次渲染都要用的。 */
  const cfg = S.model || {};
  $('cfgFormat').value = cfg.format === 'openai-compatible' ? 'openai-compatible' : 'offline';
  $('cfgModel').value = cfg.model || '';
  $('cfgEndpoint').value = cfg.endpoint || '';
  $('cfgTimeout').value = cfg.timeoutMs || 20000;
  $('cfgMaxItems').value = cfg.maxItems || 20;
  /* 密钥永不回显：每次渲染都清空。回显一次，密钥就进了浏览器内存、截图和前端日志。 */
  $('cfgApiKey').value = '';
  /* 形式类 / 时限类规则列出来（**只读**）：医生看到"缺记录时间"这条提示时，应当能查到它出自哪条规则。
     条数与内容都来自「规则库」里的包 —— 这一页改不动它，所以这里只报数、不摆控件。 */
  const rules = Array.isArray(S.formRules) ? S.formRules : [];
  $('cfgFormRules').textContent = rules.length === 0 ? '未加载' : rules.map((r) => `${r.id} ${r.title}`).join('；');
  const catalog = Array.isArray(((S || {}).knowledgePacks || {}).rules) ? S.knowledgePacks.rules : [];
  $('cfgFormRuleCount').textContent = catalog.length === 0
    ? '0（规则库里没有包）'
    : `${rules.length} / ${catalog.length} 条启用`;
  renderKnowledgePacks();
  renderTemplatePacks();
  /* 表达式控件那张表读的也是 `S.templateCatalog`：它挂在「基础数据」那个子页签下，
     刷新时一并跟上（还没切到那个页签时这个调用什么都不做） */
  refreshExprCatalog();
  /* 专科控件那张表读的也是同一份 `S.templateCatalog`（`itemType === 'control'` 的那些）：
     与表达式控件同理，刷新时一并跟上（还没切到那个页签时这个调用什么都不做） */
  refreshCtrlCatalog();
  /* 内涵质控配置（规则清单 + 引擎）也在库里：面板要显示"现在判的是哪一份" */
  void loadQcContentConfig();
  renderPlacementPanel();
  renderCapturePanel();
  renderSignPanel();
  renderReadingAuthorityPanel();
  renderPrevisitAccessPanel();
  renderRecipientKeys();
}

/**
 * 知识资产包页的页头。
 *
 * 曾经摆在这里的三样东西**都已撤掉**：包摘要（`名称 · rule · 契约 qc-rule/1 · 交付方`）、
 * 内容 / 生效指纹（原先"载的是哪一版"与"实际在跑什么"必须同时摆出来，因为只报一个的话，
 * "换了包"与"只是关了条规则"在界面上长得一样）、包存储来源（`empty` / `database` / `error`
 * 三种状态后果完全不同，最危险的是 `empty` —— 它以"质控跑了但 0 命中"的形式伪装成"没问题"）。
 * 它们都还在接口与审计里；页面上只在"一个规则包都没有"时说话（见 `renderKnowledgePacks`）。
 *
 * 开关按钮的后果写在按钮旁边而不是藏进确认框：关掉一条规则不改任何病历，
 * 只是下一轮质控少跑一条，先说清，比事后解释便宜。
 */

/* -------------------------------- 规则库（条目级维护） --------------------------------
   与「模板」页同一套做法：一张表、一行一条、行尾是操作按钮，编辑走一级抽屉。
   两页装的是同一套包机制（同一张表、同一对指纹），差别只在条目形状与后果：
   那里管"能开哪几份文书"，这里管"按哪条规则判"。

   与模板页一样，这一页**不做整包导入**：条目只在库里新建、修改、启用/停用，
   不从别处贴一段 JSON 搬进来（那会让人以为规则是外部文件，而它其实是本院维护的内容）。
   唯一的差别：规则没有"草稿 / 已发布"两态，条目开关就是它的那一态 —— 新建出来默认停用。 */
let RULE_KEYWORD_FILTER = '';
let RULE_PAGE = 1;
const RULE_PAGE_SIZE = 10;

/** 规则抽屉里此刻摆的是哪一屏（`''` = 没开）与哪一条（新建时为 `''`） */
let RULE_DRAWER_VIEW = '';
let RULE_DRAWER_ITEM = '';

/* 参数区的 id 写成常量：它是**抽屉里动态生成的**，不在静态页面上，
   而"就地重画参数区"必须点到它（换判定方式时只重画这一块，不动其它已填的格）。 */
const RULE_PARAMS_ID = 'ruleParams';
/* 条件构造器的容器 id：规则抽屉里一处、条件库抽屉里一处。构造器的读写与重画都按
   **传进来的那个容器**走（不写死 id）—— 写死的话，"条件库"那条路只能另抄一份构造器，
   而两份迟早不一样：一处能拼的算子，另一处填不了。 */
const RULE_CONDITION_ID = 'ruleCondition';
const CONDITION_BUILDER_ID = 'conditionLibCondition';

function renderKnowledgePacks() {
  const info = S.knowledgePacks || {};
  /* 这一页只显示**规则类**包：模板包搬到「模板」页了。
     两块内容装在同一张表里，不按 kind 过滤的话，这一页会列出自己管不了的东西。 */
  const packs = (Array.isArray(info.packs) ? info.packs : []).filter((pack) => pack.kind === 'rule');
  const rules = Array.isArray(info.rules) ? info.rules : [];

  /* 页头那三样**都已撤掉**：包摘要（`名称 · rule · 契约 qc-rule/1 · 交付方`）、
     内容 / 生效指纹、包存储来源 —— 它们是给接口与审计读的元数据，摆在这一页只是占版面。
     但"没有任何规则"必须说出来：它会以"质控跑了但 0 命中"的形式误导。
     判据是**规则条数**而不是包数：判定方式是库级资产（不在包里），所以"包在不在"
     与"有没有规则可跑"是两件事 —— 拿包数当判据会让这句话在"一个规则都没有"时闭嘴。 */
  const summary = $('qcPackSummary');
  if (summary) {
    summary.textContent = rules.length === 0
      ? `还没有任何规则：质控没有规则可跑（模板在「模板」页）；当前有 ${packs.length} 个规则包。`
      : '';
  }

  /* 整包载入入口**已撤销**：条目就在这张表里新建与修改（见下面「新建规则」）。
     留一个"贴 JSON 换一份包"的入口，会让人以为判定标准是外部文件，
     而它其实是本院自己维护的内容 —— 这也是模板页早先撤掉导入的同一条理由。 */

  renderRuleTable(rules);
}

/**
 * 规则表：一行一条规则 —— 状态 · 规则号 · 标题 · 级别 · 判定方式（含参数）· 操作。
 *
 * 为什么把"判定方式与参数"单独成列、而不是并进标题一格：这一页真正要一眼看出的
 * 是"这条规则**按什么判、判到什么尺度**"。摘要列并进标题之后，两行标题一样、
 * 参数不同的规则会长得几乎一模一样，而"我改的到底是哪一条"就没了依据。
 *
 * 查询与翻页都是**纯前端**的（目录本来就在 `state` 的 `knowledgePacks.rules` 里），
 * 与模板库同一套口径 —— 这一页不产生任何请求。
 */
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
  /* 筛空了要说清"是筛没了"而不是"库里没有"：两条路的下一步动作完全不同 */
  if (shown.length === 0) {
    box.innerHTML = `<div class="muted">没有标题或规则号含「${esc(RULE_KEYWORD_FILTER.trim())}」的规则（库里共 ${rules.length} 条）。清空查询条件即可看全部。</div>`;
    return;
  }
  /* 分页：页码读的是"筛完之后"的那一份清单。越界要**夹回来**而不是显示空表 ——
     删掉本页最后一条、或把查询条件改窄，都会让当前页号落到范围外，
     而"删完这一条，表格空了"看起来像删错了。 */
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

/** 把页码挪到某一条规则所在的那一页（新建 / 筛选之后的"我看不见它"） */
function ruleGotoItemPage(itemId) {
  if (RULE_KEYWORD_FILTER.trim() !== '') return;
  const rules = Array.isArray(((S || {}).knowledgePacks || {}).rules) ? S.knowledgePacks.rules : [];
  const index = rules.findIndex((rule) => rule.itemId === itemId);
  if (index < 0) return;
  RULE_PAGE = Math.floor(index / RULE_PAGE_SIZE) + 1;
}

/** 规则库里那一条（编辑抽屉据此回显：读回的是什么，保存时就要能原样写回） */
function ruleItemOf(itemId) {
  const rules = Array.isArray(((S || {}).knowledgePacks || {}).rules) ? S.knowledgePacks.rules : [];
  return rules.find((rule) => rule.itemId === itemId) || null;
}

/**
 * 实参那一格的规格：从下发的谓词清单里找"带 `condition-args` 参数的那一种判法"。
 *
 * **不写死判法名**：一旦这里出现某个判法的字面量，
 * 前端就多了一份"哪种判法有实参"的清单 —— 与引擎不一致时表现是"界面能填、引擎不认"。
 */
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

/* ------------------------------ 自定义条件（条件树） ------------------------------
   第 7 种判定方式（`field-condition`）的参数是一棵条件树，界面上它就是"条件构造器"：
   一行一条「字段 · 算子 · 取值」，上面选"满足全部 / 满足任一"。

   三条纪律：
   ① **字段名与算子名一个都不写死在这里** —— 表从服务端下发（`S.qcCondition`）。
      抄一份的后果是"界面能拼、引擎不认"，而它只会在有人真的点了它的时候才暴露；
   ② **一行都填不满时不让保存**：一条"字段都为空"的条件不是"宽松的规则"，
      而是一条永远不命中的规则 —— 它会以"质控跑了、没报什么"的形式骗人；
   ③ **嵌套条件只读**：构造器只拼平铺的「且 / 或」。树里已经有嵌套时，重画一次就会把它摊平，
      而摊平会**静默改变这条规则的含义** —— 那种规则这里只显示、不给改，并说清为什么。 */

/** 条件构造器的规格（服务端下发）。没读到就给空表 —— "一个格子都不给"远好过给一份错的 */
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

/** 某个字段可用的算子（顺序就是服务端给的顺序，前端不另排一份） */
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

/** 条件树 → 界面草稿。认不出来的形状**不猜**：退回"一条空行"，让人自己填 */
function conditionDraftFromCondition(condition) {
  const source = condition && typeof condition === 'object' && !Array.isArray(condition) ? condition : null;
  if (!source) return { logic: 'all', rows: [{ field: '', op: '', value: undefined }], nested: 0 };
  if (source.kind === 'atom') return { logic: 'all', rows: [draftRowOf(source)], nested: 0 };
  if (source.kind === 'all' || source.kind === 'any') {
    const children = Array.isArray(source.children) ? source.children.filter((child) => child && typeof child === 'object') : [];
    return {
      logic: source.kind,
      rows: children.filter((child) => child.kind === 'atom').map((child) => draftRowOf(child)),
      /* 「且里套或」这类结构在树里合法，平铺的构造器表示不了它 */
      nested: children.filter((child) => child.kind !== 'atom').length,
    };
  }
  return { logic: 'all', rows: [{ field: '', op: '', value: undefined }], nested: 0 };
}

/** 界面上当前这几行（**含还没填完的行**：填一半就重画一次不能把它弄丢） */
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

/** 字段下拉：按「适用范围 / 判定条件」分两组（分组只影响摆在哪一格，不改变判定） */
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

/** 取值那一格：控件由**算子规格**决定（下拉 / 数字 / 是-否 / 词表），前端不另判一套 */
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
    /* 值可能是布尔（来自包）也可能是字符串（从 DOM 读回来的草稿）：两种都要认，
       否则"加一条条件"重画一次就把上面那条的取值清掉了 */
    const selected = value === true || value === 'true' ? 'true' : value === false || value === 'false' ? 'false' : '';
    return `<select ${attr}><option value="">请选择</option><option value="true"${selected === 'true' ? ' selected' : ''}>是</option><option value="false"${selected === 'false' ? ' selected' : ''}>否</option></select>`;
  }
  if (spec.kind === 'integer') {
    /* 同上：整数也可能以字符串形式在草稿里流转 */
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

/** 判定方式目录（**库级资产，不带包**）：规则抽屉那个下拉与判定方式那张表读的是同一份 */
function conditionItemsOfState() {
  return Array.isArray(S && S.qcConditions) ? S.qcConditions : [];
}

function conditionItemOf(itemId) {
  return conditionItemsOfState().find((item) => item.itemId === itemId) || null;
}

/**
 * **判定方式的实参**那一格：引用了带参数的判定方式时才要填。
 *
 * 要填哪几格由**服务端下发的参数表**决定（`state.qcConditions[].params`），前端不抄一份 ——
 * 抄来的那份与内核不一致时表现是"界面能填、引擎不认"，而它只会在有人真的点了它的时候才暴露。
 *
 * 引用换了一条（`conditionId` 变了）就必须重画：否则会出现"按上一条的参数表填的值"
 * 被当成下一条的实参提交上去 —— 服务端会拒，但报错指向的是那条规则而不是这次误操作。
 */
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

/** 条件构造器那一格（参数区里的一格） */
function conditionBuilderHtml(spec, condition, boxId = RULE_CONDITION_ID) {
  const draft = conditionDraftFromCondition(condition);
  return `<div class="tpl-cell">
      <span class="tpl-label">${esc(spec.label)}${spec.required ? '（必填）' : ''} · <span class="mono">${esc(spec.name)}</span></span>
      <div class="cond-builder" id="${esc(boxId)}" data-cond-locked="${draft.nested > 0 ? '1' : '0'}">${conditionBlockBodyHtml(draft)}</div>
    </div>`;
}

/**
 * 重画条件构造器。
 *
 * 为什么要整块重画：字段一变，能用的算子就变；算子一变，取值那一格的控件也变
 * （下拉 / 数字 / 是-否 / 词表）。所以草稿**先从 DOM 读回来再画** ——
 * 不读回的话，加一条条件就把上面几条刚填的值清掉了。
 */
function refreshConditionBlock(box) {
  if (!box) return;
  const draft = conditionDraftFromDom(box);
  box.dataset.condLocked = draft.nested > 0 ? '1' : '0';
  box.innerHTML = conditionBlockBodyHtml(draft);
}

/** 取值那一格的文本 → 条件树里的取值（形状照算子规格；服务端仍会再校验一次） */
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

/**
 * 从构造器读回一棵条件树。**填不完整的那一条直接丢掉**（服务端会拒，这里不必送过去）。
 *
 * 容器由调用方给：一页上可能有两个构造器（规则抽屉里一个、条件库抽屉里一个），
 * 写死某一个的后果是"另一个抽屉里的条件读不出来"。
 */
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

/** 规则抽屉里那一个构造器读回的入口（`field-condition` 的 `when` 参数走它） */
function readConditionDraft() {
  return readConditionDraftFrom($(RULE_CONDITION_ID));
}

/**
 * 表里「判定方式」那一列的说法：引用了判定方式 → 它的名字 + 实参；就地拼一条 → 条件回读那句。
 *
 * 名字取自服务端下发的判定方式目录（`state.qcConditions`）：规则里存的是编码，
 * 而编码对读的人没有意义 —— 反过来说，目录里那条还在不在（是不是被删了）
 * 也只有这里看得出来，所以找不到时照实说，不悄悄显示一个裸编码。
 */
function ruleConditionCellHtml(rule) {
  const params = rule && rule.params && typeof rule.params === 'object' ? rule.params : {};
  const conditionId = typeof params.conditionId === 'string' ? params.conditionId : '';
  if (conditionId === '') {
    /* 就地拼一条：显示**服务端算好的那句话**（"段落正文 包含（任一）「待补充」"），
       而不是 `when=[object Object]` —— 措辞只在上游一处，界面不另编一句 */
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

/** 表里一行一条规则：状态 · 规则号 · 标题 · 级别 · 判定方式 · 操作按钮 */
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

/* ------------------------------ 规则抽屉 ------------------------------
   与文书模板那两级同一套做法（原生 <dialog> + showModal()，遮罩 / Esc / 焦点归还都是内核给的），
   只是规则只开一层：一条规则的字段摆得下，不必"左一层右一层"。
   为什么又是弹层、而不是在行下方展开：编辑一条规则要同时看见"判定方式、它的参数、
   判定依据与建议动作"，行内展开会被列表行宽挤住，而"我在改哪一条"就跟着丢了。 */

/** 打开规则抽屉的那个按钮：关闭后焦点要还回去 */
let RULE_DRAWER_OPENER = null;

function openRuleDrawer(title, desc) {
  const dialog = $('ruleDrawer');
  if (!dialog) return;
  const titleEl = $('ruleDrawerTitle');
  const descEl = $('ruleDrawerDesc');
  if (titleEl) titleEl.textContent = title;
  if (descEl) descEl.innerHTML = desc;
  /* `showModal()` 会把焦点收进抽屉，所以要在这之前记下触发它的那个按钮 */
  RULE_DRAWER_OPENER = document.activeElement;
  dialog.showModal();
  syncTplDrawerScrollLock();
}

function closeRuleDrawer() {
  const dialog = $('ruleDrawer');
  if (dialog && dialog.open) dialog.close();
}

/** 抽屉关闭后的清理统一放在 `close` 事件里：Esc 关的、点按钮关的都只走这一处 */
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
  /* 点遮罩关掉它：按坐标判而不是只判 `target === dialog` —— 抽屉自带内边距，
     点在那一圈同样是 target = dialog，可它在框内，那一下不该把抽屉关掉。 */
  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    const inBox = event.clientX >= rect.left && event.clientX <= rect.right
      && event.clientY >= rect.top && event.clientY <= rect.bottom;
    if (!inBox) closeRuleDrawer();
  });
}

/** 本院自建包的包 id：新建的规则落它（由服务端下发，界面不写死） */
function customRulePackIdOfState() {
  return String(((S || {}).knowledgePacks || {}).customPackId || '');
}

/**
 * "判定方式"下拉：**库里那几条** + "（就地拼一条）"。
 *
 * 判定方式是**库级资产**（全院一份、不属于任何包），所以这里列的是全库的那几条：
 * 任何包的规则都能引用它们（这正是它从"包内容"搬出来的原因 ——
 * 交付方包里的规则那时永远用不上具名判定方式）。
 *
 * 选项来自服务端下发的判定方式目录（`state.qcConditions`）：前端不另排一份、也不写死任何编码。
 * 这里不再出现"内核判法"这一层：规则只说"引用哪一条判定方式、实参是多少"。
 */
function ruleConditionOptionsHtml(selected) {
  const list = conditionItemsOfState();
  const inlineOption = `<option value=""${selected === '' ? ' selected' : ''}>（就地拼一条：不引用判定方式）</option>`;
  return inlineOption
    + list.map((item) => `<option value="${esc(item.itemId)}"${item.itemId === selected ? ' selected' : ''}>${esc(item.name)}（${esc(item.itemId)}）</option>`).join('');
}

/** 库里一条判定方式都没有时说的话：要给出路（去哪建一条），而不是只报一句"没有" */
function ruleConditionLibraryHintHtml() {
  if (conditionItemsOfState().length > 0) return '';
  return '<div class="hint">库里还没有判定方式：要么先到「基础数据 · 判定方式」里建一条'
    + '（它是一份<b>共用资产</b>：改一处、引它的规则一起变），要么就用下面那个"就地拼一条"。</div>';
}

/**
 * 承载"判定方式"的那一种判法：**结构性识别，不写判法名**。
 *
 * 判据是参数类型 —— `condition-ref`（引用判定方式）是"这条判法按一条具名判定方式判"的
 * 机器可读说法，`condition`（就地拼一条）与它同属这一种判法。
 * 写死判法名的后果是前端多出一份"哪种判法有判定方式"的清单：
 * 与引擎不一致时表现是"界面能填、引擎不认"，而它只会在有人真的点了它的时候才暴露。
 */
function conditionKindOf() {
  const list = Array.isArray(S && S.qcPredicates) ? S.qcPredicates : [];
  const brief = list.find((item) => (item.params || []).some((spec) => spec.kind === 'condition-ref'));
  return brief ? String(brief.kind) : '';
}

/** "就地拼一条"那一格的规格（同样是结构性识别：参数类型 `condition`） */
function conditionSpecOf() {
  const list = Array.isArray(S && S.qcPredicates) ? S.qcPredicates : [];
  for (const brief of list) {
    const found = (brief.params || []).find((spec) => spec.kind === 'condition');
    if (found) return found;
  }
  return null;
}

/**
 * 参数区：按**选中的判定方式**生成控件（选了判定方式 → 实参；"就地拼一条" → 条件构造器）。
 *
 * 两种形态二选一，与服务端那段校验是同一件事：选了判定方式就填它的实参，选"就地拼一条"
 * 就拼条件树。这里不会同时渲染"另一条路"的格子 —— 那正是服务端会拒掉的"两个都填"。
 *
 * 要填哪几格**只由服务端下发的参数表决定**（被引用那条判定方式的 `params`），前端不抄一份：
 * 抄来的那份与引擎不一致时表现是"界面能填、引擎不认"，而它只会在有人真的点了它的时候才暴露。
 */
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

/**
 * 旧形态规则的参数块：**只读**列出原来那一套参数。
 *
 * 不渲染成可改的控件：那些参数属于内核判法，而界面上已经没有那一层了 ——
 * 渲染成能改的样子，等于让人以为改完这一格就能存成新形态，而实际存下去的仍是内核判法那一套。
 */
function ruleLegacyParamsHtml(params) {
  const source = params && typeof params === 'object' ? params : {};
  const parts = Object.keys(source).map((key) => `<span class="mono">${esc(key)}=`
    + `${esc(Array.isArray(source[key]) ? source[key].join('/') : String(source[key]))}</span>`);
  return `<div class="muted">原来那一套参数：${parts.length === 0 ? '（无）' : parts.join(' · ')}</div>`;
}

/** 旧形态规则的原始判法参数（`renderRuleForm` 挂在抽屉根上；读不出来就当它不是旧形态） */
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

/**
 * 规则表单（编辑与新建共用同一屏）。
 *
 * "规则号"是**只读**的：它同时是去重键的一半与留痕里的依据编号
 * （医生看到的是"规则 R-CUSTOM-3：…"）。事后改它等于换一条新规则，所以不给改；
 * 新建时由服务端按序号生成。
 */
function renderRuleForm(seed) {
  const box = $('ruleDrawerBody');
  if (!box) return;
  const creating = seed.itemId === '';
  /* 旧形态规则（"内核判法 + 参数"）：这类规则还在库里（出厂样例包就是），
     而它用的那一种判法**已经不再作为可选"判定方式"出现** —— 于是打开它时要说清两件事，
     否则看起来像"参数丢了"：
       ① 下拉里那一项是什么（用一个明确写着"旧形态"的选项回显，不假装它是空值）；
       ② 不动下拉时保存，交回去的仍是原来那一套判法参数（改标题 / 级别 / 文案不该顺手把判定口径改掉）。 */
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

/** 打开"编辑这一条规则"的抽屉 */
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
    /* 引用了判定方式就回显那一条；否则这一条是"就地拼一条"（`when` 就是它的树）。
       两种情况之外的（旧的"内核判法 + 参数"规则）交给 `legacyKind` 去说明，
       而不是硬塞进上面两种形态里的任一种 —— 塞进去的结果是"保存一次，口径被改写"。 */
    conditionId,
    params,
    legacyKind: params.conditionId === undefined && params.when === undefined && item.predicate
      ? String(item.predicate)
      : '',
    detail: item.detail || '',
    suggestion: item.suggestion || '',
  });
}

/**
 * 打开"新建一条规则"的抽屉。
 *
 * 默认落在**库里第一条判定方式**上（而不是"就地拼一条"）：规则库里绝大多数规则是
 * "引用一条判定方式 + 填实参"，默认值该落在人多数的路上；要就地拼的，下拉里第一项就是它。
 *
 * 新规则落**自建包**（服务端口径），但那与判定方式无关：判定方式是库级资产，
 * 任何包的规则都能引用 —— 所以这里不需要按包过滤那个下拉。
 */
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

/**
 * 读回表单：**界面上能改的每一格都要读回来**。
 *
 * 少读一格，点一次保存就把它清掉了，而且没有任何地方会报错（包写得进去、校验也过得去）——
 * 这与模板编辑那条回路是同一条纪律（见 `slotOfView` 的注释）。
 */
function readRuleForm() {
  const box = $('ruleDrawerBody');
  const out = {
    title: '', severity: 'warn', kind: '', conditionId: '', params: {}, detail: '', suggestion: '',
    /* 自定义条件那两种"存不下去"的情况，读的时候一并带出来（见各自的理由） */
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
  /* 旧形态规则（下拉里那一项就是它原来用的内核判法，人没动过）：**原样交回去**。
     改标题 / 级别 / 文案是一次普通保存，不该顺手把判定口径改写掉 ——
     那会静默改变这条规则"按什么判"，而审计里看不出来（包只记了内容指纹变过）。 */
  const legacy = readRuleLegacy(box);
  if (legacy && out.conditionId === legacy.kind) {
    out.kind = legacy.kind;
    out.params = legacy.params;
    return out;
  }
  /* 判定方式：承载它的那种判法由目录**结构性**认出来（`conditionKindOf`），不写判法名。
     目录读不到时 `kind` 为空 —— 保存会被拦下（"判定方式没读到"），
     而不是交一条引擎不认的规则（那要等到质控跑起来才暴露）。 */
  out.kind = conditionKindOf();
  if (out.conditionId !== '') {
    /* 引用判定方式：只读实参格（条件树那一路整块不存在 —— "两选一"由形态保证）。
       实参按**那一条判定方式**的参数表读回（`ruleArgSpecOf` 读的就是服务端下发的那份）。
       未填的格子**照原样不交**：服务端会按"必填缺失"拒掉它，比在这里猜一个值可靠。
       非整数/非布尔的形态按原样字符串交出去 —— 形状不对由服务端判（同一段校验）。 */
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
  /* 就地拼一条：走的是 `when` 参数。两种"存不下去"的情况分开报，不合成一句含糊的话 ——
     它们该做的事完全不同：
       - 锁住：树里有嵌套，构造器改不了 → 得删掉重建；
       - 还空着：一条完整条件都没有 → 补一条就行。 */
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

/**
 * 换判定方式：只重画参数区。
 *
 * 不重画整屏：重画会把刚填好的标题、判定依据、建议动作一起清掉 ——
 * 那正是这套界面最不该出现的一种"帮你重置"。
 * 而参数区**必须**整块重画：换一条判定方式就是换一套实参格，留着上一套的输入框
 * 只会让人把 A 的实参填进 B 的格子里。
 */
function renderRuleConditionSwitch(conditionId) {
  const box = $('ruleDrawerBody');
  const params = $(RULE_PARAMS_ID);
  /* 选回那条"旧形态"选项：参数块画回原来那一套（只读），不是去目录里找一条同名的判定方式 */
  const legacy = readRuleLegacy(box);
  if (legacy && conditionId === legacy.kind) {
    if (params) params.innerHTML = ruleLegacyParamsHtml(legacy.params);
    return;
  }
  if (params) params.innerHTML = ruleParamsHtml(conditionId, {});
}

/** 填写项的数据类型（与引擎 `FIELD_TYPES` 同一套取值） */
const TPL_FIELD_TYPES = ['text', 'number', 'date', 'code', 'boolean'];

/** 抽屉里正在编辑哪一份文书（一次只开一个：两份一起改容易改串） */
let TPL_DRAWER_ITEM = '';
/** 一级抽屉的触发按钮：关闭后焦点还给它（键盘上能接着走，不必重新找位置） */
let TPL_DRAWER_OPENER = null;
/** 二级抽屉的触发按钮（两级各记一个：两个都开着时，各关各的都要还回去） */
let TPL_DRAWER_OPENER2 = null;

/**
 * 两级抽屉：一级从**右**侧滑入（默认），二级从**左**侧滑入（`#tplDrawer2`，样式里的 `.from-left`）。
 *
 * 为什么分两级：表达式控件的公式构造器从**左**侧进来（二级），而它要改的那张控件表
 * 就在「基础数据 → 表达式控件」页面上，两不相扰；模板的编辑 / 预览走右侧那一级（一级）。
 * 挤在一层里，表单会把背后的表格顶掉，改完这一条就想不起来刚才改的是哪一行。
 *
 * 为什么用弹层、而不是在行下方展开：编辑一份文书要同时看见"名称 / 科室 / 每一章 / 每个槽位"，
 * 行内展开会被列表行宽与后半页那些说明挤住；弹层自带遮罩与滚动锁，
 * "我在改这一份"和"后面那张列表"分得开 —— 编辑时视野里不该有别的东西等着被误点。
 *
 * 用原生 `<dialog>` + `showModal()`：遮罩、Esc、焦点困在框内都是内核给的，
 * 不必自造一层浮层（自造的那套总会漏掉 Esc 与焦点归还）。
 * 两级同时 `showModal()` 是允许的：后开的那一层在 top layer 更靠上。
 */
function tplDrawerRefOf(level) {
  return level === 2
    ? { level: 2, dialog: 'tplDrawer2', title: 'tplDrawer2Title', desc: 'tplDrawer2Desc', body: 'tplDrawer2Body' }
    : { level: 1, dialog: 'tplDrawer', title: 'tplDrawerTitle', desc: 'tplDrawerDesc', body: 'tplDrawerBody' };
}

/** 这一屏表单画在哪一层（1 = 一级在右，2 = 二级在左）：渲染与关闭都按它走 */
let TPL_FORM_LEVEL = 1;
/** 一级抽屉里此刻摆的是哪一屏（`''` = 没开）：状态刷新后要重画它，才知道该重画哪一屏 */
let TPL_DRAWER_VIEW = '';

/** 当前这一屏表单该写进哪个抽屉体（id，因为读表单要按容器取） */
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
  /* 打开它的那个按钮：`showModal()` 会把焦点收进抽屉，所以要在这之前记下来 */
  if (ref.level === 2) TPL_DRAWER_OPENER2 = document.activeElement;
  else TPL_DRAWER_OPENER = document.activeElement;
  dialog.showModal();
  syncTplDrawerScrollLock();
}

/** 关掉当前这一层的抽屉（关闭按钮 / Esc / 取消 / 保存成功都走这里；也可点名关某一层） */
function closeTplDrawer(level) {
  const dialog = $(tplDrawerRefOf(level || TPL_FORM_LEVEL).dialog);
  if (dialog && dialog.open) dialog.close();
}

/**
 * 背景页滚动锁：抽屉内容比视口短时，滚轮事件会直接落到背景页上，
 * 表现为"在抽屉里滚，后面的页面跟着动"（这条锁与 .drawer 样式是同一套结论）。
 *
 * 每次开关都按"还有没有开着的抽屉"重算：两级可能同时开着，
 * 二级关上时一级还在，锁不能跟着一起解开。
 */
function syncTplDrawerScrollLock() {
  /* 四个抽屉共用这一把锁（模板一级 / 模板二级 / 规则 / 条件）。它必须看**全部**抽屉：
     只认其中几个的话，剩下的那些开着时背景页照样跟着滚，
     "在抽屉里滚、后面的页面跟着动"正是这条锁要解决的那一件事。 */
  const ids = [tplDrawerRefOf(1).dialog, tplDrawerRefOf(2).dialog, 'ruleDrawer', 'conditionDrawer'];
  const anyOpen = ids.some((id) => {
    const dialog = $(id);
    return Boolean(dialog && dialog.open);
  });
  if (anyOpen) document.documentElement.classList.add('drawer-open');
  else document.documentElement.classList.remove('drawer-open');
}

/** 抽屉关闭后的清理统一放在 `close` 事件里：Esc 关的、点按钮关的都只走这一处 */
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
        /* 一级关上时二级不能留在屏上：它本来就是"从一级里开出来"的那一层 */
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
    /* 点遮罩（抽屉之外那层阴影）关掉**这一层**：内核的 `<dialog>` 只管遮罩的样式与
       `showModal()` 的模态性，不提供"点它关闭"这个行为，得自己接。
       为什么按坐标判、而不是只判 `event.target === dialog`：抽屉自带内边距
       （左右 32px、底部 44px），点在那一圈同样是 target = dialog，可它在框内，
       那一下不该把抽屉关掉 —— 只有点在框外（也就是那片阴影上）才算"点遮罩"。
       两级各自接自己的：二级开着时，阴影属于二级，点它关掉的是二级（一级留在原地）。 */
    dialog.addEventListener('click', (event) => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      const inBox = event.clientX >= rect.left && event.clientX <= rect.right
        && event.clientY >= rect.top && event.clientY <= rect.bottom;
      if (!inBox) closeTplDrawer(ref.level);
    });
  }
}

/** 模板库的查询条件（模板名称）：只按名称筛，活在这一页的状态里，切走再回来不丢 */
let TPL_NAME_FILTER = '';
/** 模板库的页码（从 1 起）与每页条数：翻页是纯客户端的事，不重新拉目录 */
let TPL_PAGE = 1;
const TPL_PAGE_SIZE = 10;

/**
 * 模板库页（`data-cfg-pane="templates"`）：一张表，一行一份病历模板，行尾是操作按钮。
 *
 * 与「规则库」页共用同一套包机制（同一张表、同一对指纹），差别只在条目形状与后果：
 * 这里管的是"能开哪份文书"，那里管的是"按哪条规则判"。
 *
 * 医学表达式控件**不在这张表里**：它是被文书引用的独立内容、**比模板更基础**，
 * 在「基础数据 → 表达式控件」那一页单独维护（见 `renderExprCatalog`）。
 *
 * 这一页**不做导入**：内容只在库里（新建与编辑都直接写库），
 * "贴一段 JSON 载入"那条路留着只会让人以为"模板是从别处搬来的文件"，
 * 而它其实是本院维护的内容。
 */
function renderTemplatePacks() {
  const entries = Array.isArray(S.templateCatalog) ? S.templateCatalog : [];
  const templates = entries.filter((item) => item.itemType === 'template');
  const keyword = TPL_NAME_FILTER.trim().toLowerCase();
  const shown = keyword === ''
    ? templates
    : templates.filter((item) => String(item.name || '').toLowerCase().includes(keyword));

  const box = $('tplPackItems');
  if (!box) return;
  /* 章节片段是**另一张表**，摆在文书表下面。
     为什么单摆一张而不是混进文书表：两者的"操作"根本不是一回事
     （片段没有发布 / 停用，文书没有"插入"），混排会让"这一行我能不能发布"变成猜。
     两张表各自为空都要说得清：所以下面每条早退路径都带着片段表一起输出。 */
  const fragHtml = tplFragmentsHtml(entries);
  if (templates.length === 0) {
    box.innerHTML = `<div class="muted">模板库是空的：点上面「新建文书」建第一份（建出来是<b>草稿</b>，发布之后医生端才能照着它开）。</div>${fragHtml}`;
    return;
  }
  /* 筛空了要说清"是筛没了"而不是"库里没有"：两条路的下一步动作完全不同 */
  if (shown.length === 0) {
    box.innerHTML = `<div class="muted">没有名称含「${esc(TPL_NAME_FILTER.trim())}」的模板（库里共 ${templates.length} 份）。清空查询条件即可看全部。</div>${fragHtml}`;
    return;
  }
  /* 分页：页码读的是"筛完之后"的那一份清单。
     越界要**夹回来**而不是显示空表：删掉本页最后一份、或把查询条件改窄，
     都会让当前页号落到范围外，而"删完这一条，表格空了"看起来像删错了。 */
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

/**
 * 把页码挪到某一份模板所在的那一页。
 *
 * 为什么需要：目录超过一页之后，"新建"出来的那一份落在哪一页取决于它在目录里的位置，
 * 停在原页上会看到"建完了，列表里没有它" —— 与"我没建成"长得一模一样。
 * 有查询条件时不动页码：那一行本来就可能被条件筛掉，乱挪页只会让人更糊涂。
 */
function tplGotoItemPage(itemId) {
  if (TPL_NAME_FILTER.trim() !== '') return;
  const templates = (Array.isArray(S && S.templateCatalog) ? S.templateCatalog : [])
    .filter((item) => item.itemType === 'template');
  const index = templates.findIndex((item) => item.itemId === itemId);
  if (index < 0) return;
  TPL_PAGE = Math.floor(index / TPL_PAGE_SIZE) + 1;
}

/** 表里一行一份文书：状态 · 名称 · 类型 · 规模 · 科室 · 操作按钮 */
function tplRowHtml(item) {
  const draft = item.status === 'draft';
  /* 科室显示**名称**（服务端按字典翻译好一并下发）：存的编码是给判定用的，
     摆在表里只会让人去猜 DEPT_OB 是哪个科 */
  const deptCodes = item.departments || [];
  const departments = deptCodes.length === 0 ? '通用' : (item.departmentNames || deptCodes).join('、');
  const status = draft
    ? '<span class="chip warn">草稿</span>'
    : item.enabled
      ? '<span class="chip ok">启用中</span>'
      : '<span class="chip">已停用</span>';
  /* 规模与"引用了几个控件"从目录里现算：服务端那一行人话（detail）是给日志与接口读的，
     表里分列摆出来才对齐得上（"几章几槽"在这一列、"限哪些科"在那一列） */
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

/**
 * 章节片段那张表（摆在文书表下面）。
 *
 * 与文书表的三处不同，各有理由：
 *   - **没有发布 / 停用**：片段开不出病历，只有一个"停用"意义上的开关，
 *     而那个开关属于部署策略（"这一段本院暂时不让用"），不摆在这一屏；
 *   - **没有适用科室、没有文书类型**：片段不是"一种文书"，它是素材；
 *   - 有**「规模」与说明**：只看名称选不出该插哪一段（"主诉"在两个片段里长得一样），
 *     规模与说明是最省事的区分线索。
 *
 * 表尾固定摆一句"片段怎么用、改它影响谁"：这一页是**唯一**能改片段内容的地方，
 * 而人对"改片段"的后果最容易想反（以为会改到那些文书上）。
 */
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

/** 片段表里的一行 */
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

/* ------------------------------ 模板预览 ------------------------------
   预览回答的是"**医生点开之后面前是什么**"，不是"模板里写了什么"：
   后者（章节 / 槽位 / 引用哪个控件）在模板表与编辑抽屉里本来就看得见。
   所以这一屏的数据来自服务端 `POST /api/template-preview` —— 它按当前患者与就诊
   的上下文真的开一遍（不落库），于是"系统带入的值填上没有、派生值算没算出来、
   还缺哪几格"都能如实摆出来。前端不自己照着 `templateCatalog` 画一份骨架：
   那样画出来的东西答不了上面那三个问题，却会让人以为那就是预览。 */

/** 打开预览（一级抽屉，与编辑同一层） */
async function openTplPreview(itemId) {
  const item = tplItemOf(itemId);
  TPL_DRAWER_VIEW = 'preview';
  openTplDrawer(`预览：${item ? item.name : itemId}`, '');
  const box = $(tplDrawerBodyId());
  if (box) box.innerHTML = '<div class="muted">正在试开…</div>';
  const r = await api('/api/template-preview', { templateId: itemId });
  /* 试开是异步的：回来时抽屉可能已经被关掉了。这时什么都不写 ——
     否则下一次打开抽屉会先看到上一次的预览结果（"打开就是别人那一份"） */
  const dialog = $('tplDrawer');
  if (!dialog || !dialog.open || TPL_DRAWER_VIEW !== 'preview') return;
  if (!r || !r.ok) {
    if (box) box.innerHTML = `<div class="muted">预览失败：${esc((r && (r.message || r.code)) || '未知原因')}</div>`;
    return;
  }
  renderTplPreview(r.data || {});
}

/** 预览正文：文书头（类型 / 规模 / 状态 / 科室 / 出处）+ 试开结果 + 待补清单 */
function renderTplPreview(data) {
  const box = $(tplDrawerBodyId());
  if (!box) return;
  const sections = Array.isArray(data.sections) ? data.sections : [];
  const warnings = Array.isArray(data.warnings) ? data.warnings : [];
  const slotCount = sections.reduce((sum, section) => sum + ((section.slots || []).length), 0);
  const deptNames = (Array.isArray(data.departmentNames) ? data.departmentNames : []).join('、');
  /* 状态只有两项：文案 + chip 颜色（`chips()` 的用法）。
     "草稿 / 停用 → 医生端现在开不出它"这层意思由状态 chip 本身与列表里的发布 / 启用按钮表达，
     预览页上不再另写一段说明。 */
  const status = data.status === 'draft'
    ? ['草稿', 'warn']
    : data.enabled === false
      ? ['已停用', 'warn']
      : ['启用中', 'ok'];
  /* 适用科室：**真的按本次就诊判一次**并如实报出结论 ——
     "限产科"配上"本次就诊是呼吸内科"正是要在这里被看见的那种配错 */
  const deptNote = data.departments && data.departments.length > 0
    ? data.deptApplicable
      ? `限 ${esc(deptNames)}；本次就诊是 ${esc(data.visitDeptName || '（无科室）')}：开得出`
      : data.visitDeptName
        ? `限 ${esc(deptNames)}；本次就诊是 ${esc(data.visitDeptName)}：<b>现在开不出来</b>（换一份文书，或在「编辑」里放开科室）`
        : `限 ${esc(deptNames)}；本次就诊<b>没有科室信息</b>：现在开不出来（先补就诊科室，或改成通用）`
    : `通用：任何科室都能开${data.visitDeptName ? `（本次就诊：${esc(data.visitDeptName)}）` : ''}`;

  const items = Array.isArray(data.items) ? data.items : [];
  /* 正文：与医生端**同一份渲染、同一份样式**（`/doc-view.js`）。
     所见即所得不是"照着医生端画得像"，而是"画的就是它那一套"。
     只读：这不是一份真实文书，点了也不该有反应；原因放在 title 里 ——
     无理由的禁用只会被当成"界面卡了"。 */
  const bodyHtml = L0DocView.nodesHtml(items, {
    readonly: true,
    readonlyHint: '这是预览：按当前患者与就诊试开的一份，没有落库，也改不了',
    clinical: true,
    annotations: [],
  });
  /* 管理员要核对的内部信息收在这一块里（默认折叠）：章节编码与槽位名**不属于文书本身**，
     把它们摆进正文，就是在"医生看到的那一屏"里读内部标识。 */
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

/**
 * 医学表达式控件的表格页（「基础数据 → 表达式控件」子页签）：控件单独维护，一行一个。
 *
 * 为什么单独一页：控件是**被引用**的内容（一份公式被多份文书引用，改一处处处生效），
 * 它跟"本院能开哪几份文书"不是同一个问题；混在文书那张表里只能挤成一列名字。
 * 它与科室字典、文书类型同一档（**比模板更基础**：先有控件，才谈得上一份文书去引用它），
 * 所以它占「基础数据」里的一个子页签，而不是模板页右上角的一个按钮（2026-10-16 挪过来）。
 * 表里给的是"叫什么、公式长什么样、还开不开得动"，改动动作（编辑 / 开关 / 删除）
 * 都在行尾 —— 点「编辑」进二级抽屉（左侧）改公式，改完这一页还在。
 *
 * 查询（控件名称）与分页跟模板库那张表是**同一套做法**（同一套状态命名、
 * 同一个 `.tpl-pager`）：两边都是"会一直长"的清单，长得不一样只会让人以为
 * 其中一边少了什么。
 */

/** 控件表格页的查询条件（控件名称）与页码：与模板表各记一份，互不干扰 */
let EXPR_NAME_FILTER = '';
let EXPR_PAGE = 1;
const EXPR_PAGE_SIZE = 10;

/**
 * 控件表格页的"壳"：查询条是**常驻**的，只有下面那张表会被重画。
 *
 * 为什么壳与表要分开（模板表那边是天然的，它的输入框在表格之外）：
 * 输入框若跟着表一起重画，打一个字就丢焦点、光标跳回开头 ——
 * 而"边打边筛"正是这一格要的效果。
 * 「新建表达式控件」不在这里，它在页面标题那一行（`#exprCatalogBody` 之外）：
 * 壳会被重画，按钮没必要跟着重建，而重复的 id 是这一页最容易留下的坑（见 ui-self-test A24）。
 */
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

/** 控件表格页的表与分页条（只重画这一块，上面那条查询条不动） */
function renderExprCatalog() {
  const box = $('exprCatalogTable');
  /* 壳不在（有人直接调了这一步）就先把壳画出来：状态刷新走的是同一条路 */
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
  /* 分页：页码读的是筛完之后那一份清单，越界夹回（删掉本页最后一条不该显示空表） */
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

/**
 * 新建一个控件之后，把页码挪到它所在的那一页。
 *
 * 与模板表同一条理由：超过一页之后，新建的那一条可能落在别的页上，
 * 停在原页看到的是"建完了，表里没有它" —— 与"没建成"长得一模一样。
 * 有查询条件时不动页码：那一行本来就可能被条件筛掉。
 */
function exprGotoItemPage(itemId) {
  if (EXPR_NAME_FILTER.trim() !== '') return;
  const controls = (Array.isArray(S && S.templateCatalog) ? S.templateCatalog : [])
    .filter((item) => item.itemType === 'expression');
  const index = controls.findIndex((item) => item.itemId === itemId);
  if (index < 0) return;
  EXPR_PAGE = Math.floor(index / EXPR_PAGE_SIZE) + 1;
}

/**
 * 状态变化后把表达式控件那张表重画一遍（**面板已挂载时**）。
 *
 * 为什么需要：那张表与模板表读的是同一份 `S.templateCatalog`，而 `renderModelPanel`
 * 重画模板表时不管它 —— 不补这一下，在这一页点了"停用"，行上的按钮纹丝不动，
 * 看起来像没生效。没挂载（还没切到那个子页签）时什么都不做：下次切过去自己会画。
 */
function refreshExprCatalog() {
  if ($('exprCatalogTable')) renderExprCatalog();
}

/* ------------------------------ 专科控件（基础数据 → 专科控件） ------------------------------
   它紧挨着「表达式控件」那一页摆，正因为两者最容易混：那一页是**公式**（这个值怎么算 ——
   标量、无界面），这一页是**控件**（长什么样、填什么 —— 有结构、有界面）。
   控件里若有一格要算，那一格引用的是**表达式控件**里的那一份，所以本页不该出现任何公式：
   公式在这里露头，就等于出现了第二处"公式怎么表达"。

   查询与分页跟模板库 / 表达式控件那两张表是**同一套做法**（同一套状态命名、同一个 `.tpl-pager`）：
   都是"会一直长"的清单，长得不一样只会让人以为其中一边少了什么。

   **本系统不预置专科控件**（随产品发版的是形状，形状决定渲染器，而渲染器是代码）：
   这一页初始就是空的 —— 空态必须把"为什么是空的"说清，否则它看起来像少装了一个包。 */

/** 形状的中文名：界面要说清"这一条会被画成什么"，`scale` / `series` 这种词医生读不出来 */
const CTRL_SHAPE_LABELS = {
  scale: '量表评分',
  series: '时序（趋势）',
  matrix: '行列表',
  checklist: '勾选清单',
  image: '影像',
};

/** 控件表格页的查询条件（控件名称）与页码：与模板表 / 表达式表各记一份，互不干扰 */
let CTRL_NAME_FILTER = '';
let CTRL_PAGE = 1;
const CTRL_PAGE_SIZE = 10;

/**
 * 控件表格页的"壳"：查询条**常驻**，只有下面那张表会被重画。
 *
 * 与表达式控件那一页同一条理由：输入框若跟着表一起重画，打一个字就丢焦点、光标跳回开头 ——
 * 而"边打边筛"正是这一格要的效果。
 */
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

/** 专科控件条目：目录里 `itemType === 'control'` 的那些（与表达式控件同在一个目录里） */
function ctrlCatalogItems() {
  return (Array.isArray((S || {}).templateCatalog) ? S.templateCatalog : [])
    .filter((item) => item.itemType === 'control');
}

/* ------------------------------ 专科控件预览 ------------------------------
   预览回答的是"**医生点开之后这一条长什么样**"：形状怎么画、有哪几格、哪几格是空的。
   数据来自 `POST /api/control-preview` —— 服务端临时造一份只含这个控件的文书**真的开一遍**
   （不落库），于是页面上的每一格与医生端是**同一段代码**生成的（格键由形状算出来，
   见 `model/control.ts`）。前端不照着目录里的 `fields` 自己画一份：那样画出来的东西
   答不了"矩阵的行列怎么排、格键是什么"，却会让人以为那就是预览。 */

/** 打开控件预览（二级抽屉，与控件表单同一层） */
async function openCtrlPreview(itemId) {
  const item = tplItemOf(itemId);
  CTRL_EDIT_ID = '';
  CTRL_DRAFT = null;
  openTplDrawer(`预览：${item ? item.name : itemId}`, '', 2);
  const box = $(tplDrawerBodyId());
  if (box) box.innerHTML = '<div class="muted">正在生成…</div>';
  const r = await api('/api/control-preview', { itemId });
  /* 生成是异步的：回来时抽屉可能已经被关掉了，或者用户已经点了别的（编辑 / 新建）——
     那时这一屏已经不是预览，把结果写进去就是"打开的是编辑表单、里面摆着预览内容"。
     两道判据：**二级**抽屉（这一屏画在二级 `openTplDrawer(..., 2)`，照抄模板预览去判一级
     会永远为 false，表现是"点了预览、标题变了、里面什么都没有"）+ `CTRL_DRAFT` 仍为 null
     （预览里它恒为 null，而编辑与新建都会给它赋值）。 */
  const dialog = $(tplDrawerRefOf(2).dialog);
  if (!dialog || !dialog.open || CTRL_DRAFT !== null) return;
  if (!r || !r.ok) {
    if (box) box.innerHTML = `<div class="muted">预览失败：${esc((r && (r.message || r.code)) || '未知原因')}</div>`;
    return;
  }
  renderCtrlPreview(r.data || {});
}

/** 预览正文：控件头（形状 / 格数 / 状态 / 出处）+ 医生端那一屏（只读） */
function renderCtrlPreview(data) {
  const box = $(tplDrawerBodyId());
  if (!box) return;
  const items = Array.isArray(data.items) ? data.items : [];
  const cells = items.reduce((sum, item) => sum + (Array.isArray(item.cells) ? item.cells.length : 0), 0);
  const warnings = Array.isArray(data.warnings) ? data.warnings : [];
  /* 没有提示时**什么都不说**：正文自己就是结论（每一格画出来了就是画出来了）。
     再补一句"试开通过"，读的人得先把它翻译成"没问题、可以走了"—— 那是噪声。 */
  /* 正文与医生端**同一份渲染、同一份样式**（`/doc-view.js`）。所见即所得不是
     "照着医生端画得像"，而是"画的就是它那一套"；只读的原因放进 `title` ——
     无理由的禁用只会被当成"界面卡了"。 */
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

/** 控件表格页的表与分页条（只重画这一块，上面那条查询条不动） */
function renderCtrlCatalog() {
  const box = $('ctrlCatalogTable');
  /* 壳不在（有人直接调了这一步）就先把壳画出来：状态刷新走的是同一条路 */
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
  /* 空态：这一页**天然**是空的（不预置内置控件），所以话要说清"空是正常的"，
     而不是像别的表那样写着"去建一个"却连入口都还没有 */
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
  /* 分页：页码读的是筛完之后那一份清单，越界夹回（删掉本页最后一条不该显示空表） */
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

/**
 * 状态变化后把专科控件那张表重画一遍（**面板已挂载时**）：与表达式控件那张表同一条理由 ——
 * 不补这一下，在这一页点了"停用"，行上的按钮纹丝不动，看起来像没生效。
 */
function refreshCtrlCatalog() {
  if ($('ctrlCatalogTable')) renderCtrlCatalog();
}

/* ------------------------------ 专科控件：编辑器 ------------------------------
   表单画在**二级**抽屉（左侧滑入），与「表达式控件」的公式构造器同一层、同一条理由：
   它要改的那张表就在页面上（「基础数据 → 专科控件」），两不相扰 ——
   保存完关掉这一层，还看得见自己改的是表里哪一行。

   与公式构造器的差别在"改什么"：
     · 公式构造器改的是一棵 **AST**（这个值怎么算），由程序保证与引擎读得懂的结构一一对应；
     · 这里改的是一组**格子的声明**（填什么），字段是数据，所以它可以是一张能增删的清单。
   两边都**不出现公式**：要算的格子引用「表达式控件」里的那一份（同一件事只有一处口径）。

   界面上不开的字段（如数据元标签 `tag`）不在这里改，但**必须原样带回去** ——
   读不回来的表现是"一保存就把它清掉了"，而那种丢失从来不会报错。 */

/** 语义类型的中文名：controlKind 回答"这是什么控件"（质控与机读分类按它问），界面不该让人读英文 */
const CTRL_KIND_LABELS = {
  menstrualHistory: '月经史',
  odontogram: '牙位图',
  vitalSignsChart: '生命体征单',
  scaleScore: '量表评分',
  labTrend: '化验趋势',
  custom: '其他（自定义）',
};

/**
 * 控件字段可选的**取值类型**：比模板槽位那套（`TPL_FIELD_TYPES`）多一个 `expression`。
 *
 * 槽位那套里为什么没有它：槽位的"这一格要算"是由**槽位类别**（`kind: 'expression'`）表达的，
 * 公式另走一条引用。而控件里每一格都是字段，"这一格要算"就只能由**字段类型**表达 ——
 * 少了这一项，控件里永远建不出"由表达式算出来"的格子，而那是控件的一半意义。
 */
const CTRL_FIELD_TYPES = [...TPL_FIELD_TYPES, 'expression'];

/** 正在编辑的控件 id（空 = 新建）、它的草稿、以及"进去时是什么样"（判断这次改动是否碰到字段语义） */
let CTRL_EDIT_ID = '';
let CTRL_DRAFT = null;
let CTRL_BASELINE = '';

/**
 * 草稿的**语义签名**：形状 / 语义类型 / 字段 / 行列。
 *
 * 与内核 `controlSemanticKey` 同一份口径（那一边决定要不要升版，这一边决定要不要问一次）。
 * 名称与说明不算：改个称呼不值得拦一次。
 */
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

/** 新建一份空草稿：一上来就给一格（全空的表单让人不知道从哪儿下手） */
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

/** 目录条目 → 草稿（深拷贝：编辑时「取消」要回到库里那一份） */
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

/** matrix 的行列：一行一项，`key=名称`（名称可省，省了就与 key 同名） */
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

/** 取值域：`code=显示名`，与行列共用一套解析（两者都是"编码 + 给人看的名字"） */
function valueSetText(list) {
  return (Array.isArray(list) ? list : [])
    .map((item) => `${item.code ?? ''}${item.display ? `=${item.display}` : ''}`)
    .join('\n');
}

function parseValueSet(text) {
  return parseKeyLabel(text).map((pair) => ({ code: pair.key, ...(pair.label === pair.key ? {} : { display: pair.label }) }));
}

/**
 * 「默认值」那一格：**形状跟数据类型走**（与模板槽位的默认值同一纪律）。
 *
 * 为什么不给一个文本框了事：`number` 型的默认值写成 "37.2"（字符串）在界面上一模一样，
 * 落进病历却是一个字符串值 —— 它要进机读信息、要被公式当数字用，那时没人会回头怀疑控件里的默认值。
 * 由公式算出来的格不给默认值：那个值该由公式给（预设一个，等于在公式之外又留了一条编数的路）。
 */
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

/** 一格字段的编辑卡：key / 名称 / 类型 / 单位 / 必填 / 参考范围 / 取值域 / 机读编码 / 默认值（+ 表达式引用 / 时间轴） */
function ctrlFieldHtml(field, index, shape) {
  const dataType = String(field.dataType ?? 'text');
  const range = field.referenceRange || {};
  const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? String(value) : '');
  /* 影像形状的格**只收一条地址**：类型只能是 text（内核在装包那一刻也这么要求），
     单位 / 参考范围 / 取值域 / 默认值对一张图都没有含义 —— 留着它们，人会以为
     "这张影像要填个正常值范围"，而那是量表那一格的事。
     界面上收起来的项由 `readCtrlForm` 一并清掉：它的读法是从草稿那一格出发的
     （见那里的注释），不主动清，"从量表改成影像"会把旧那几项一路带进新定义。 */
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

/** matrix 的行列：只有行列表才画（别的形状给了它们，界面也不知道拿它做什么） */
function ctrlMatrixHtml(draft) {
  return `
    <div class="row">
      <span>行</span>
      <textarea id="ctrlNewRows" rows="4" title="行列表的行（如 32 颗牙）：一行一项，key=名称">${esc(keyLabelText(draft.rows))}</textarea>
      <span>列</span>
      <textarea id="ctrlNewColumns" rows="4" title="行列表的列（如 龋 / 充填 / 缺失）：一行一项，key=名称">${esc(keyLabelText(draft.columns))}</textarea>
    </div>`;
}

/**
 * 表单（渲染进**二级**抽屉）：新建与编辑共用一份 ——
 * 差别只有"初值从哪来"与"提交时走哪条路"，分成两套的代价是两边迟早长得不一样。
 */
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
    /* 从**草稿**那一格出发（不是从零开始）：界面上不开的字段（如数据元标签）要原样带回去，
       否则"保存"会把它们静默清掉 —— 而那种丢失从来不会报错。 */
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
      /* 机读编码：填了才绑数据元（体系沿用原来的 —— 包提供的数据元可能是 WS445，
         界面这里只改编码与显示名，不该把体系一起改成 local） */
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
  /* 机读标签的显示名统一取字段的「名称」：放到这里做，是因为谁先被读到取决于 DOM 顺序，
     而"先读到名称、还是先读到编码"不该决定结果（与模板槽位那一套同一处置） */
  for (const field of fields) {
    if (field.tag && field.label) field.tag = { ...field.tag, display: field.label };
  }
  /* 影像形状的格只留**地址**相关的几项：类型归一到 text，清掉单位 / 参考范围 / 取值域 /
     默认值 / 表达式引用 / 时间轴。
     为什么必须在这里做：上面那个循环是**从草稿那一格出发**的（为了不丢掉界面上没开的键，
     如数据元标签），于是"界面上收起来的项"会被原样带回 —— 从量表改成影像时，
     原来那一格的 ℃ 与参考范围会一路跟到新定义里，而它们对一张图没有任何含义
     （内核那边也会因为影像格不是 text 而拒收这份包）。 */
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

/**
 * 把出问题的那一格**指出来**：卡片标红、滚进视野、焦点送过去，然后才写状态行。
 *
 * 为什么不止写一行字：只在抽屉顶上写，人扫一眼会读成"我点了保存、它没反应"，
 * 然后就走了 —— 而"控件没建出来"的现场恰恰就长这样（第一遍用，key 与名称很容易漏填一个）。
 */
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

/**
 * 提交：新建 / 保存改动。
 *
 * 字段或形状变了要**问一次**：内核那边会自动把定义升一版，而升版的后果要说在人眼前 ——
 * 已开出的病历里存着当时那份字段快照，一个字都不会变；而"把旧病历按新定义重新解读"
 * 正是升版要挡住的事。
 */
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
  /* 校验**一格一格说**，并把出问题的那一格指出来（标红 + 滚过去 + 落焦点）：
     把话只写在抽屉顶上，"我点了保存、它没反应"就是这个现场 ——
     而 key 与名称都要填，第一遍用很容易漏一个。 */
  const rows = draft.fields || [];
  const filled = rows.filter((field) => String(field.key || '').trim() !== '' || String(field.label || '').trim() !== '');
  if (filled.length === 0) {
    markCtrlFieldBad(0, '至少要有一格（key 与名称都空着的那几格不算）：控件就是「把一组字段装进一个格子」');
    return;
  }
  const blank = rows.findIndex((field) => {
    const started = String(field.key || '').trim() !== '' || String(field.label || '').trim() !== '';
    /* 整格空着不算错：提交时丢掉即可（多留一格空白的，是"我还想再加一格"的常态） */
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
    /* 只关这张表单：页面上那张控件表还在，接着要建下一条不必重新切页签 */
    closeTplDrawer();
  }
  /* 成功了：抽屉已经收走，话说在页面上（此刻唯一看得见的地方）；
     失败了：抽屉还开着，话说在抽屉里 —— 写在背后那行等于没写。 */
  const message = r && r.ok
    ? editing
      ? `已保存控件「${name}」：${fields.length} 格${r.data && r.data.version ? `，定义 v${r.data.version}` : ''}`
      : `已新建控件「${name}」（${(r.data && r.data.itemId) || ''}）：${fields.length} 格`
    : `${editing ? '保存' : '新建'}失败：${(r && (r.message || r.code)) || '未知原因'}`;
  if (r && r.ok) setCtrlCatalogStatus(message);
  else setTplDrawerStatus(message);
}

/**
 * 编辑抽屉的内容：名称 / 适用科室常开，章节与槽位**只有草稿**能改。
 *
 * 排版口径（这一屏此前挤成"一行里塞五六个控件"）：**一格一块，块内再分两行** ——
 * 标签在上、控件在下，一节一卡。按行挤的时候，"这一格的标题"与"下一格的编码"
 * 长得一样近，改完一章要来回数格子才敢确认自己改的是哪一个。
 */
function renderTplEditForm(item) {
  const box = $(tplDrawerBodyId());
  if (!box) return;
  /* 片段抽屉**复用这一个入口**（章节与槽位的增删、排序按钮都调它）：
     在这里按条目类别分派，而不是让二十来个调用处各自判断该画哪一屏 ——
     那样漏一处就是"点了一下加槽位，整屏变成了模板编辑"这类错，
     而且只在片段这一路上出现，模板那一路上永远试不出来。 */
  if (item.itemType === 'fragment') {
    renderFragEditForm(item);
    return;
  }
  /* 两档可编辑，界线是"改它要不要有人担代价"：
     - **骨架**（章节与槽位的增删、槽位名、类别、数据类型、结构文本、引用哪个控件）只有草稿能改 ——
       已发布的文书可能已经开出过病历，改骨架会让"当时按哪一版开的"对不上，要改先撤稿；
     - **槽位元数据**（显示名 / 从系统带入 / 必填 / 单位 / 关键内容 / 默认值 / 参考范围 / 另起一段）
       任何状态都能改：它们在开文书那一刻才起作用，不进任何已开出的病历（见内核的 `SlotMetaPatch`）。
     不分开的代价是真实的：为了让"体温"这一格显示中文名而撤稿，医生端会立刻开不出这份文书。 */
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

/**
 * **片段抽屉**的内容（放在 `TemplateCatalogEntry` 上渲染，与模板抽屉共用同一套章节编辑器）。
 *
 * 与模板抽屉的两处不同，各有理由：
 *   - 章节与槽位**永远**能改（片段没有"草稿 / 已发布"这个概念）：改片段不影响任何已开出的
 *     病历，也不影响任何已经用它拼好的文书 —— 插入是**复制**，不是引用。这句话必须写在界面上，
 *     否则"改了片段"听起来就像"改了那些文书"。
 *   - 没有科室、没有文书类型、没有「发布」：片段不是"一种文书"，开不出病历。
 */
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

/**
 * 章节与槽位的编辑区（**模板抽屉与片段抽屉共用同一份**）。
 *
 * 为什么共用：片段"就是一串章节"，它该有的编辑能力与模板里那一段**完全相同**。
 * 各写一遍的后果不是当场报错，而是漂移 —— 出现"模板里能改的东西，片段里改不了"，
 * 而人只会以为是自己看错了地方。
 *
 * 排序（↑ / ↓ 与拖动）只给 `structEditable`（草稿）：顺序**就是数组顺序**
 * （引擎按这个顺序生成章节节点、`order = 序号 × 10`），改它就是改骨架 ——
 * 已发布的文书改骨架会让"当时按哪一版开的"对不上，与增删章节同一条界线。
 * 章节属性（必备 / 关键内容 / 说明）**任何状态都能改**：它们在开文书那一刻才抄进节点，
 * 之后与模板再无联系，不进任何已开出的病历（见 `sectionMetaOf`）。
 */
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

/**
 * 「章节片段」下拉的选项（**只列启用中的片段**：服务端已按这个口径筛过）。
 *
 * 为什么把「N 章 / M 槽位」写进选项：只看名称的话，"主诉"这种名字在两个片段里
 * 长得一模一样，插错了才发现；规模是最省事的一条区分线索。
 * 一个片段都没有时给一句**可执行的**话（去哪儿攒第一段），而不是一个空下拉。
 */
function tplFragmentOptionsHtml() {
  const fragments = Array.isArray((S || {}).fragments) ? S.fragments : [];
  if (fragments.length === 0) {
    return '<option value="">（还没有片段：在下面某一章上点「存为片段」，就能攒出第一段）</option>';
  }
  const head = '<option value="">选一段片段…</option>';
  return head + fragments.map((fragment) => `<option value="${esc(fragment.packId)}|${esc(fragment.fragmentId)}">`
    + `${esc(fragment.name)}（${fragment.sectionCount} 章 / ${fragment.slotCount} 槽位）</option>`).join('');
}

/**
 * 片段（目录投影）→ 可以插进骨架的**定义形状**章节数组。取不到返回 `null`。
 *
 * 为什么插进去的是**副本**而不是引用：与"改模板不影响已开出的病历"同一条纪律 ——
 * 下游不能被上游悄悄改掉。代价是片段内容更新后要重新插一次，这句话写在界面上。
 */
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

/**
 * 这段片段引用的控件，**这份文书所属的包**里有没有。
 *
 * 为什么要拦在插入这一刻：模板包里 `useExpression` 只允许同包引用。放进去的话，
 * 报错要等到保存时以"模板里引用了控件库里没有的控件"出现 —— 而那条消息
 * 完全指不到"因为你刚插了一段从别的包存下来的片段"。缺哪一格、缺哪个控件要说清。
 */
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

/**
 * 把片段里的章节插到 `at` 位置，并**自动给重名的槽位改名**。
 *
 * 为什么必须改名而不是报错：槽位名在整份模板内唯一（表达式按它引用填写项），
 * 校验会直接拒掉整包。而"插一段片段"是人正在拼文书时最顺手的一步，
 * 因为库里恰好有一个叫 `temperature` 的格子就停下来让人逐个改名，等于把
 * 拼装变成了校对。改名的规则可读、可预期（`temperature` → `temperature_2`），
 * 并且**在状态行里说明改了几个** —— 悄悄改名比报错更糟。
 *
 * 返回改名的个数。
 */
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

/** 把 `list[index]` 挪 `delta` 格（-1 上移 / 1 下移）；挪不动（到边上了 / 下标不合法）返回 false */
function tplMove(list, index, delta) {
  if (!Array.isArray(list) || !Number.isInteger(index)) return false;
  const target = index + delta;
  if (target < 0 || target >= list.length) return false;
  const [moved] = list.splice(index, 1);
  list.splice(target, 0, moved);
  return true;
}

/**
 * 目录里的那一格（**给人看的投影**）→ 模板定义里的那一格（**要写回包里的形状**）。
 *
 * 两边的写法本就不同（投影里叫 `kind`，定义里叫 `slot`），而编辑抽屉是一条
 * "读回 → 改 → 写回"的回路：少认一个字段（如 `keyContent`）就等于"点一次保存把它清掉了"，
 * 而且没有任何地方会报错（包写得进去、校验也过得去）。所以这里一处对一处地翻译过来。
 */
function slotOfView(view) {
  const kind = String(view.kind ?? view.slot ?? 'text');
  const slot = { slot: kind, key: String(view.key ?? '') };
  if (Array.isArray(view.tags) && view.tags.length > 0) slot.tags = view.tags.map((tag) => ({ ...tag }));
  if (view.keyContent === true) slot.keyContent = true;
  if (view.newParagraph === true) slot.newParagraph = true;
  if (kind === 'text') {
    if (view.text !== undefined) slot.text = String(view.text);
  } else if (kind === 'paragraph') {
    /* 空段落只认「槽位名 / 关键内容 / 另起一段」：数据元与文字都不该带回来 ——
       带上它们会被内核当成"这一格有这些字段"而拒（段落不产数据元）。 */
    delete slot.tags;
  } else if (kind === 'image') {
    /* 图片槽的三项说明**必须原样回写**：说明与图注在抽屉里有输入格，而 `resRef`
       没有（模板不携带图片文件，只可能来自手写包）—— 目录少给一项，
       就是"改一次别的、保存时把它清掉"，而库里那一份再也回不去。 */
    if (view.resRef !== undefined && String(view.resRef) !== '') slot.resRef = String(view.resRef);
    if (view.altText !== undefined && String(view.altText) !== '') slot.altText = String(view.altText);
    if (view.caption !== undefined && String(view.caption) !== '') slot.caption = String(view.caption);
    /* 图片不绑数据元、也不标关键内容（医生端没有"确认这一张图"这个动作） */
    delete slot.tags;
    delete slot.keyContent;
  } else if (kind === 'field') {
    slot.dataType = String(view.dataType ?? 'text');
    if (view.unit !== undefined && view.unit !== '') slot.unit = String(view.unit);
    if (view.from !== undefined && view.from !== '') slot.from = String(view.from);
    if (view.required === true) slot.required = true;
    /* 默认值与参考范围同样要**原样回显**：目录里少给一项，表现就是"库里配了参考范围、
       编辑框里却是空的"，一保存就把库里那份覆盖没了（包写得进去、校验也过得去） */
    if (view.value !== undefined) slot.value = view.value;
    if (view.referenceRange && typeof view.referenceRange === 'object') slot.referenceRange = { ...view.referenceRange };
  } else if (kind === 'table') {
    /* 列与行数同样**原样回显**：少给一列，表现是"库里配了三列、编辑框里只剩两列"，
       而人一保存就把它清掉了 —— 表格少一列不会报错，只是数据从此无处可填 */
    slot.columns = (Array.isArray(view.columns) ? view.columns : []).map((column) => ({
      title: String(column?.title ?? ''),
      ...(column?.dataType !== undefined ? { dataType: String(column.dataType) } : {}),
      ...(column?.unit !== undefined && column.unit !== '' ? { unit: String(column.unit) } : {}),
      /* 列上的数据元也要回写：少给这一项，表现是"列还是那几列、数据元没了"，
         而机读从此对不上（列表里那一格的值再也认不出是哪个数据元） */
      ...(Array.isArray(column?.tags) && column.tags.length > 0
        ? { tags: column.tags.map((tag) => ({ ...tag })) }
        : {}),
    }));
    if (view.rows !== undefined) slot.rows = Number(view.rows);
  } else if (kind === 'list') {
    /* 项与有序性同样**原样回显**：少给一项，表现是"库里配了三条、编辑框里只剩两条"，
       而人一保存就把它清掉了 —— 列表少一条不会报错，只是那条内容从此不存在。 */
    /* 项要连**格子**一起回写（`field`）：少回显它，表现是"库里配了数据元、编辑框里变回没绑"，
       一保存机读就对不上了 —— 而列表少一格不会报错，只是那一项从此不进机读。 */
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
    /* 列表不产数据元、也不能标关键内容（内核会当场拒） */
    delete slot.tags;
    delete slot.keyContent;
  } else if (kind === 'expression') {
    slot.useExpression = String(view.useExpression ?? '');
    if (view.unit !== undefined && view.unit !== '') slot.unit = String(view.unit);
  } else if (kind === 'control') {
    /* 专科控件槽：引用的控件与**记录行数**都要原样回显 —— 少回显一项，
       表现就是"库里给的是 5 行、编辑框里回到默认 3 行"，一保存就把行数改掉了 */
    slot.useControl = String(view.useControl ?? '');
    if (view.rows !== undefined) slot.rows = Number(view.rows);
  }
  return slot;
}

/** 这一格绑的数据元标签（医生端那一格"显示名"就是它的 `display`） */
function slotTagOf(slot) {
  return Array.isArray(slot.tags) && slot.tags.length > 0 ? slot.tags[0] : null;
}

/**
 * 槽位一块：第一行是"这一格是什么"（槽位名 / 显示名 / 类别），第二行才是类别专有的字段。
 *
 * 可用性分两档（`structEditable` 只管**骨架**那几格）：
 *   - 骨架：槽位名 / 类别 / 数据类型 / 结构文本 / 引用哪个控件 —— 只有草稿能改；
 *   - 元数据：显示名 / 从系统带入 / 必填 / 单位 / 关键内容 / 默认值 / 参考范围 / 另起一段 ——
 *     任何状态都能改（见 `renderTplEditForm`）。
 *
 * 第二档为什么这么宽：它们在**开文书那一刻**才起作用（引擎把它们抄进节点，之后与模板再无联系），
 * 所以**不进任何已开出的病历** —— 与"改章节与槽位"不是一回事。
 *
 * 显示名为什么要单独一格：医生端显示的字段名取自**数据元标签**（`tags[0].display ?? 槽位名`），
 * 而后台一直只有"槽位名"（`temperature` 这类内部标识）—— 于是"体温"这个名字
 * 在编辑界面上从头到尾没有地方出现，也没有地方能改。
 */
/**
 * 「默认值」那一格的提示。
 *
 * 为什么要把"同时配了'从系统带入'会怎样"讲清楚：两样一起配是**正当的**
 * （开文书时先给个默认值，之后采集 / 同步程序把实测值同步进来覆盖它），
 * 但那件事在界面上看不出来 —— 而"我配了带入，怎么开出来是默认值"这种问法，
 * 答案只能写在能看见的地方。
 */
const TPL_VALUE_TIP = '模板预设的默认值（开文书时填上）；留空 = 这一格空着等医生填。'
  + '若同时配了「从系统带入」：开文书时用这个默认值，之后采集 / 同步程序同步进来的值会覆盖它';

/**
 * 「默认值」那一格：模板预设的机器真值，**形状跟数据类型走**。
 *
 * 为什么不给一个文本框了事：`number` 型的默认值写成 "37.2"（字符串）在界面上一模一样，
 * 落进文档却是一个字符串值 —— 派生值按它算会算不出来，而那时没人会回头怀疑模板里的默认值。
 * 是 / 否型的默认值只有"真 / 假"两种，文本框等于让人自己拼字符串。
 */
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

/**
 * 「参考范围」那几个格子。
 *
 * 为什么四个格一起给：它是**判异常的尺子**（趋势按它标偏高 / 偏低，见 `model/trend.ts`）。
 * 数值范围用低 / 高，判不了数的范围（"阴性"）用文本，单位单独一格 ——
 * 只给一个文本框，人会顺手把「3.5-9.5」整体写进去，而引擎解析不了那句话。
 */
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

/**
 * 表格里的一列。
 *
 * 为什么每列要带**类型**与**单位**：一张表的价值全在"每个格子是什么"。
 * 全是自由文本的表，机器读不出一个数（趋势画不出来、参考范围判不了），
 * 这张表在系统里就退化成一张图片 —— 而它恰恰是住院最常见的那类表（体温单、检验结果）。
 */
function tplColumnRowHtml(si, ti, ci, column, lock) {
  const dataType = String(column?.dataType ?? 'text');
  /* 列上的数据元与槽位级同一条规则：界面只改**显示名**，体系与编码放在隐藏格里原样带着走 ——
     编码决定跨文书比对认不认得出"这是同一个体温"，不该由"列名叫什么"来定。 */
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

/**
 * 列表的一项：文字 + 可选的一个格子（勾了才出现类型 / 单位 / 数据元）。
 *
 * 为什么"格子"是一个复选框而不是"每项都必有"：临床上多数列表项是**纯文字**
 * （"否认高血压"），少数才带格子（"体温 ____ ℃"）。每项都强制带一格，
 * 会造出一堆空着没人填的格子，而那些格子一旦绑了数据元就进机读。
 */
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
    /* 空段落**刻意不给文字框**：给一个空着"结构文本"框，人会以为是自己没填完。
       要写提示语就选「结构文本」——两者产出的节点完全一样，差别只在意图。 */
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
      /* 结构文本本来就另起一段，所以这一档不给「强制另起一段」的勾选框；但库里若**已经**带着它
         （手写包），要用一个隐藏格原样带回去 —— 读不回来就等于一保存把它清掉了。 */
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
    /* 一项一行、顺序就是数组顺序：加一项 / 删一项都是**数组级的动作**，
       不让人手写行号或拖动排序 —— 那种错法只有导出之后才看得见（"屏幕上第 3 条"和
       "纸面上第 3 条"不是同一句）。 */
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
  /* 数据元标签原样带着走（隐藏格）：界面上只改**显示名**，体系与编码不能因为动了一下别的输入框而掉。
     医生说"这一格是体温"，落到包里是 WS445 / DE05.01.001 / 体温 ——
     只剩一个中文名的标签，跨文书比对就认不出它（比对认的是 `system + code`）。 */
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

/** 可选控件：来自模板库里已装载的医学表达式控件 */
function tplControlOptions(selected) {
  const controls = (Array.isArray(S.templateCatalog) ? S.templateCatalog : []).filter((item) => item.itemType === 'expression');
  const current = String(selected ?? '');
  const options = controls.map((item) => `<option value="${esc(item.itemId)}"${item.itemId === current ? ' selected' : ''}>${esc(item.name)}</option>`).join('');
  /* 引用的控件已经不在库里（被删了）：留一个选中项，别让浏览器默认选中第一个控件 ——
     `readTplEditForm` 是全量读 DOM 的，那会把"这一格引用了哪个控件"静默换成另一个，
     而它所在的这一格此刻看着毫无异常。 */
  if (current !== '' && !controls.some((item) => item.itemId === current)) {
    return `<option value="${esc(current)}" selected>（已不在库里：${esc(current)}）</option>${options}`;
  }
  return options || `<option value="">（库里还没有任何表达式控件）</option>`;
}

/**
 * 可选**专科控件**：来自模板库里 `itemType === 'control'` 的那些条目。
 *
 * 选项里带上形状与格数：选的时候就要看得出"这一格画出来是什么" ——
 * 只给名字（"疼痛数字量表"）不写形状，"它是量表还是一张网格"在选的那一刻是看不出来的，
 * 而这两者填法完全不同。停用的控件不在这里过滤：管控视图要看得见被停用的那几份
 * （与模板表同一口径），能不能用由服务端的开文书校验回答。
 */
function tplControlDefOptions(selected) {
  const controls = ctrlCatalogItems();
  const current = String(selected ?? '');
  const options = controls.map((item) => {
    const shape = CTRL_SHAPE_LABELS[item.shape] || String(item.shape || '');
    const cells = Array.isArray(item.fields) ? item.fields.length : 0;
    return `<option value="${esc(item.itemId)}"${item.itemId === current ? ' selected' : ''}>`
      + `${esc(item.name)}（${esc(shape)}${cells > 0 ? ` · ${cells} 格` : ''}）</option>`;
  }).join('');
  /* 引用的控件已经不在库里（被删了）：留一个选中项，别让浏览器默认选中第一个 ——
     `readTplEditForm` 是全量读 DOM 的，那会把"这一格引用了哪个控件"静默换成另一个。
     与 `tplControlOptions`（表达式控件那一份）是同一条理由。 */
  if (current !== '' && !controls.some((item) => item.itemId === current)) {
    return `<option value="${esc(current)}" selected>（已不在库里：${esc(current)}）</option>${options}`;
  }
  return options || '<option value="">（库里还没有任何专科控件 —— 先去「专科控件」页建一个）</option>';
}

/**
 * 适用科室：从科室字典里**勾选**，不让人在这里现打编码。
 *
 * 为什么是勾选而不是输入框：判定用的是编码，而手打的编码**打错一个字母就谁都开不出**
 * （诊断时只看到一个陌生串）。字典为空时如实说明"只能配成通用" ——
 * 没有科室主数据，"限某个科"本来就没有依据。
 */
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

/**
 * "从系统带入"的选项：按患者 / 就诊 / 医生 / 时间分组（十来项堆成一个长下拉没法看）。
 *
 * ⚠️ 这个词是**对接标记**，不是"本系统的值"—— 别改写它（也不叫"外部带入"）：
 * 外部**采集 / 同步程序**按「**模板名称 + 槽位名**」找到标了它的那一格，把值同步进来；
 * 本系统只负责在开文书时把值填上，取不到就留空并告警、不编值。
 * 名字要与对接方约定的叫法一致，界面上换一个词，对接方那边就对不上话。
 * 配对键是"模板名称 + 槽位名"，所以这两处输入框的提示里都写明了改名的后果。
 */
function tplContextOptions(selected) {
  const fields = Array.isArray(S && S.contextFields) ? S.contextFields : [];
  const current = String(selected ?? '').trim();
  /* 库里记着、本机字段字典里**没有**的那条带入路径：原样留一个选中项。
     为什么非留不可：下拉里没有它时，浏览器会默认选中第一项（"不标记"），
     而 `readTplEditForm` 是**全量读 DOM** 的 —— 用户根本没碰过这个下拉，
     一保存就把这一格的带入标记清掉了（外部采集 / 同步程序随后就找不到这一格），
     而且全程没有任何提示。字段字典为空时更狠：整份模板的带入标记会被一次全清。
     留这一项的同时，也让人看见"这一格为什么长这样"。 */
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
  /* 空选项说的是"**这一格不带系统带入标记**"（而不是"这一格不用填"）：
     标记的效果有两个 —— 开文书时自动填、以及外部采集 / 同步程序会来同步它；
     不标就是两件都不做，这一格照旧由医生自己填（那正是"留空待填"）。 */
  if (orphan === '' && body === '') return '<option value="">（本机没有可带入的字段）</option>';
  return `<option value="">不标记（留空待填，也不参与同步）</option>${orphan}${body}`;
}

/** 按 id 取模板库里那一条（事件里拿不到渲染时的上下文，只能从当前状态里取） */
function tplItemOf(itemId) {
  return (Array.isArray((S || {}).templateCatalog) ? S.templateCatalog : []).find((item) => item.itemId === itemId) || null;
}

/** 库里那一条 + 抽屉里此刻填的东西 = 重绘抽屉要用的状态（改了哪章哪槽都在 form 里） */
function tplFormStateOf(item, form) {
  return { ...item, name: form.name, departments: form.departments, sections: form.sections };
}

/**
 * 把编辑区里当前填的东西读回来（增删章节/槽位时先读、改完再重绘）。
 *
 * 为什么不维护一份内存草稿：界面上唯一可信的东西就是人此刻看到的那一屏，
 * 内存态一多，"看到的"与"待保存的"就分家了。
 */
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
    /* 片段的说明：与名称一样是"人写的元数据"，一并在这一处读回来（读表单只有这一处） */
    else if (path === 'fragdesc') form.description = String(value);
    else if (path.startsWith('sec:')) {
      const [, field, indexText] = path.split(':');
      const index = Number(indexText);
      while (form.sections.length <= index) form.sections.push({ sectionCode: '', title: '', slots: [] });
      if (field === 'title') form.sections[index].title = String(value);
      else if (field === 'code') form.sections[index].sectionCode = String(value);
      /* 章节自身属性（必备 / 整章算关键内容）：**取消勾选要删掉这个键**，而不是写 `false` ——
         写 `false` 会在包内容里多出一份指纹差异，"我把它改回去了"就说不清了。
         说明同理：清空 = 删掉这个键（空串过不了校验，它也不表示"有一句空的说明"）。 */
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
      /* 第五段只有表格的列用得上（`slot:coltitle:2:1:3` = 第 2 章第 1 格的第 3 列） */
      const [, field, sectionText, slotText, columnText] = path.split(':');
      const si = Number(sectionText);
      const ti = Number(slotText);
      while (form.sections.length <= si) form.sections.push({ sectionCode: '', title: '', slots: [] });
      const slots = form.sections[si].slots;
      if (field === 'kind') {
        /* 类别一改，这一格下面要填的东西就换了（填写项要数据类型，表达式要选控件）。
           但**已经读到的**那几样（槽位名 / 数据元标签 / 显示名 / 关键内容）与类别无关，
           必须留在原对象上 —— 重建对象会把它们丢掉，界面上表现为"改一下类别，这一格的名字就没了"，
           而且它是静默的：保存后才发现，那时已经在库里了。 */
        const current = slots[ti] ?? { slot: 'text', key: '' };
        current.slot = value;
        if (current.key === undefined) current.key = '';
        if (value === 'text') {
          if (current.text === undefined) current.text = '';
          /* 结构文本没有"数据类型 / 从系统带入 / 必填 / 单位 / 默认值 / 参考范围 / 列"：
             留着它们会被写进包里 */
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
          /* 从图片槽切回结构文本时，说明与图注不能跟着留（它们对一段文字没有意义） */
          delete current.altText;
          delete current.caption;
        } else if (value === 'paragraph') {
          /* 空段落什么字段都不带（没有文字、也没有数据元）：把上一类留下的字段清干净。
             不清的后果是"从填写项切成空段落"把 dataType 一路写进包里 —— 它不会报错，
             只会在下次有人打开这份模板时看到一个莫名其妙的字段。 */
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
          /* 医生端没有"确认这一张图"的动作：标了关键内容就签不出去，且无处确认 */
          delete current.keyContent;
        } else if (value === 'field') {
          if (current.dataType === undefined) current.dataType = 'text';
          delete current.text;
          delete current.useExpression;
          delete current.columns;
          delete current.rows;
        } else if (value === 'table') {
          /* 换成表格时给一个**能保存的最小形状**（一列、一行），而不是空数组：
             空 columns 过不了校验，而人刚把类别改成表格就被拒在保存那一步，
             除了"这一格不对"之外什么也没说。 */
          if (!Array.isArray(current.columns) || current.columns.length === 0) current.columns = [{ title: '项目' }];
          if (current.rows === undefined) current.rows = 1;
          delete current.text;
          delete current.dataType;
          delete current.from;
          delete current.required;
          delete current.unit;
          /* 表格没有关键内容（没有"确认这张表"这个动作，见 engine 里的槽位校验） */
          delete current.keyContent;
          delete current.value;
          delete current.referenceRange;
        } else if (value === 'list') {
          /* 切成列表：给一个**能保存的最小形状**（一项），与表格那一档同一条理由 ——
             切成哪一类都要能先存下去再慢慢填。 */
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
          /* 列表不产数据元、也不能标关键内容（见 engine 里的槽位校验） */
          delete current.tags;
          delete current.keyContent;
        } else if (value === 'control') {
          /* 换成专科控件：先空着引用（人接着去下拉里选），行数删掉 = 用默认。
             与表格那一档同一条理由 —— 切成哪一类都要能先存下去再慢慢填 */
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
          /* 控件不绑数据元（机器读的是控件里带 tag 的字段）：切成它的时候
             把那一条摘掉，否则保存会被服务端拒（见 engine 里的槽位校验） */
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
        /* 图片槽的两格说明：空着就**删掉**（不写空串）——
           空串在包里是一个"有但为空"的字段，而它的意思与"没有"没有区别 */
        else if (field === 'alt') current.altText = String(value).trim() === '' ? undefined : String(value);
        else if (field === 'caption') current.caption = String(value).trim() === '' ? undefined : String(value);
        else if (field === 'itemtext' || field === 'itemfield' || field === 'itemtype'
          || field === 'itemunit' || field === 'itemlabel' || field === 'itemtags') {
          /* 列表项也是**数组**：项序就是数组序。所有格先写进中间态（`__` 前缀），
             最后统一折算 —— 勾选框与它那几个格谁先被读到取决于 DOM 顺序，
             而"这一项到底有没有格子"不该由顺序决定。 */
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
          /* 不勾 = 无序：**删掉这个键**（`false` 与"不写"同义，写进去只会多一份指纹差异） */
          if (value === true) current.ordered = true;
          else delete current.ordered;
        }
        else if (field === 'unit') current.unit = String(value).trim() === '' ? undefined : String(value);
        else if (field === 'req') current.required = value === true;
        else if (field === 'type') current.dataType = String(value);
        else if (field === 'expr') current.useExpression = String(value);
        else if (field === 'ctrl') current.useControl = String(value);
        /* "从系统带入"：空选项 = 不带入，那时要把 `from` **删掉**（而不是留一个空串），
           否则写包时校验会因为"取值路径必须是字符串"而拒掉这份看起来没问题的模板 */
        else if (field === 'from') current.from = String(value).trim() === '' ? undefined : String(value);
        /* 显示名与它绑的数据元标签是**同一条东西**（`tags[0].display`）：界面上只有"显示名"
           能改，体系与编码放在隐藏格里原样带着走。两格留到循环之后统一合成 ——
           谁先被读到取决于它在 DOM 里的位置，而先读到谁不该决定结果。 */
        else if (field === 'label') current.__display = String(value);
        else if (field === 'tags') current.__tags = parseSlotTags(value);
        else if (field === 'keyc') current.keyContent = value === true;
        /* 比的是**字符串**而不是布尔：勾选框读回来的是 `true/false`，
           而结构文本那一格（这一项对它没有意义，界面不给勾选框）用一个隐藏格原样带回来 ——
           界面读不回来 = 一保存就把它清掉了，指纹一变，"我把它改回去了"就说不清了。 */
        else if (field === 'newp') current.newParagraph = String(value) === 'true';
        /* 默认值与参考范围先**原样收着**（`__` 前缀是本轮读回来的中间态），
           等这一格读完之后统一折算 —— 谁先被读到取决于 DOM 顺序，先读到谁不该决定结果 */
        else if (field === 'value') current.__value = String(value);
        else if (field === 'rrlow') current.__rrlow = String(value);
        else if (field === 'rrhigh') current.__rrhigh = String(value);
        else if (field === 'rrtext') current.__rrtext = String(value);
        else if (field === 'rrunit') current.__rrunit = String(value);
        /* 表格的行数。非法值（空 / 0 / 30）**不塞进包**：内核校验在保存那一刻就会拒，
           而人还得回来猜是哪儿写错了；这里直接当作"没改"（界面下一屏也照旧显示原值）。 */
        else if (field === 'rows') {
          const rows = Number(String(value).trim());
          if (Number.isInteger(rows) && rows >= 1 && rows <= 20) current.rows = rows;
          else delete current.rows;
        } else if (field === 'coltitle' || field === 'coltype' || field === 'colunit' || field === 'collabel' || field === 'coltags') {
          /* 列是**数组**，所以按四段路径逐格读回来；列的次序就是数组次序，没有折算的余地。
             `title` 允许先空着（人正在填），空列名会在保存时被校验拦下并指出是第几列。
             显示名与隐藏格里的标签原文先**原样收着**（`__` 前缀是本轮读回来的中间态），
             等这一格读完之后统一折算 —— 谁先被读到取决于 DOM 顺序，先读到谁不该决定结果。 */
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
  /* 半填的格子也要留下：人正在填到一半，不该因为点了一下"加一个槽位"就被清空 */
  form.sections = form.sections.filter((section) => section !== undefined);
  /* 中间态统一折算：默认值按数据类型收成机器真值、参考范围的四个格收成一个对象、
     显示名 + 隐藏格里的标签原文 → 数据元标签（两者本来就是同一条东西）。
     为什么都留到这里做：这几件事**依赖别的格已经读到**（数字型的默认值要知道 dataType），
     而谁先被读到取决于 DOM 顺序 —— 先读到谁不该决定结果。 */
  for (const section of form.sections) {
    for (const slot of section.slots ?? []) {
      composeSlotDefaultValue(slot);
      composeSlotRange(slot);
      /* 表格列上的数据元：与槽位级同一套折算（显示名 + 隐藏格里的编码 → `tags`）。
         没绑过的列按 `local` + `槽位名.c<列序>` 记一条 —— 列序是骨架，
         改它本来就是换了一版骨架，而"这一列是体温"这件事与第几行无关。 */
      const columns = Array.isArray(slot.columns) ? slot.columns : [];
      columns.forEach((column, ci) => {
        if (column.__tags === undefined && column.__display === undefined) return;
        const tags = Array.isArray(column.__tags) ? column.__tags.map((tag) => ({ ...tag })) : [];
        const display = typeof column.__display === 'string' ? column.__display.trim() : '';
        if (display === '') {
          /* 清掉的是**显示名**，不是这个数据元：编码还要留给跨文书比对 */
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
      /* 列表项里的格子：只有勾了「格子」的项才留下 `field`（其余是纯文字项）。
         `dataType` 缺省 text；单位空着就删键。数据元的折算与列/槽位同一套 ——
         没绑过的项按 `local` + `槽位名.i<项序>` 记一条（与实例化时那个格子槽位名同族）。 */
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
        /* 清掉的是**显示名**，不是这个数据元：编码还要留给跨文书比对 */
        if (tags.length > 0) delete tags[0].display;
      } else if (tags.length > 0) {
        tags[0].display = display;
      } else if (String(slot.key ?? '') !== '') {
        /* 还没绑数据元的槽位：按本机构自定义（`local`）+ 槽位名记一条 ——
           标签的形状要求体系与编码齐备（见 `model/validate.ts`），
           只写一个显示名的标签会让**产出的文档**校验不过。 */
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

/** 隐藏格里那份标签原文（JSON）：读不回来就当"没有标签"，**绝不猜一个** */
function parseSlotTags(raw) {
  try {
    const parsed = JSON.parse(String(raw ?? '[]'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * 中间态 `__value` → 模板定义里的 `value`，**按数据类型折算**。
 *
 * 为什么必须折算：`<input type="number">` 里的 `37.2` 读出来是**字符串** ——
 * 原样写进包里，这一格的 `dataType` 是 number 而默认值却是字符串，
 * 派生值按它算会算不出来；而错在模板里，人排查却会从公式开始。
 *
 * 折算不了的（数字格里填了非数字）**原样留下**：内核校验会当场拒掉并指出是哪一格，
 * 那比在界面里猜用户想表达什么要诚实 —— 猜错一次，库里就多一条没人看得懂的默认值。
 */
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

/** 参考范围的四个格 → 一个对象（全空 = **清掉这个设置**） */
const TPL_RANGE_FIELDS = [['low', '__rrlow'], ['high', '__rrhigh'], ['text', '__rrtext'], ['unit', '__rrunit']];

/**
 * 中间态 `__rr*` → `referenceRange`。
 *
 * 四个格全空 = **清掉**（而不是留一个空对象）：空对象过不了内核校验
 * （"至少要给下限 / 上限 / 文本里的一项"），而界面上把它们清空的意思就是"不配参考范围"。
 *
 * ⚠️ 逐格折算、**不合并成一句话**：数值范围用 low/high（判高低），
 * 判不了数的用 text（只显示）。把「3.5-9.5」当一句话收进来，趋势那边解析不了。
 */
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

/**
 * 读回来的骨架 → **槽位元数据补丁**（已发布的文书走这条路，草稿走整份 `sections`）。
 *
 * 为什么按类别挑字段、而不是整份塞过去：结构文本没有单位、也没有"从系统带入"，表格更没有
 * 任何一项元数据，一起送过去只会换来一句"这一格不是填写项"的报错 —— 而那件事界面本来就知道。
 *
 * 定位用**章节编码 + 槽位名**：已发布的骨架是锁着的，这两个值此刻必定与库里一致，
 * 所以定位不会失手（真失手了服务端会明说"定位不到"，而不是静默改到别的格上）。
 */
function slotMetaOf(sections) {
  const out = [];
  for (const section of Array.isArray(sections) ? sections : []) {
    for (const slot of section.slots ?? []) {
      const kind = String(slot.slot ?? 'text');
      /* 表格 / 列表 / 图片**没有元数据档**（列定义、行数、列表项、图片说明与图注都属于骨架，
         只有草稿能改），所以它们一条都不送：送过去只会换来一句"这一类没有这些元数据"。
         空段落与结构文本同类，但**更窄**：单位与「另起一段」都不送，显示名也不送
         （段落不产数据元，内核会当场拒）。 */
      if (kind === 'table' || kind === 'list' || kind === 'image') continue;
      const entry = {
        sectionCode: String(section.sectionCode ?? ''),
        key: String(slot.key ?? ''),
        /* 关键内容三种类别都能标：它是责任标记，与类别无关 */
        keyContent: slot.keyContent === true,
      };
      /* 显示名就是 `tags[0].display`：**只给会产数据元的三类**送这一项。
         空段落与图片槽不绑数据元（内核会当场拒掉"给它们配数据元"），
         送一个 `null` 过去等于要求"清掉显示名"，而它们压根没有这一档。 */
      if (kind === 'text' || kind === 'field' || kind === 'expression') {
        /* 显示名给 `null` = 清掉它（回到按槽位名显示）；内核只动 `tags[0].display`，
           体系与编码留在库里不动 */
        entry.display = slotTagOf(slot)?.display ?? null;
      }
      const isTextLike = kind === 'text' || kind === 'paragraph';
      if (!isTextLike) entry.unit = slot.unit ?? null;
      /* 结构文本与段落本来就另起一段：这一项对它们没有意义，送过去只会换来一句报错 */
      if (!isTextLike) entry.newParagraph = slot.newParagraph === true;
      if (kind === 'field') {
        entry.from = slot.from ?? null;
        entry.required = slot.required === true;
        /* `null` = 清掉。为什么不像显示名那样 `?? null` 一把收：默认值本身可以是 `0` / `false`
           （"体温默认 0 度"没人会这么写，但"某量表默认 0 分"很常见），
           用 `??` 会把它们之外的 `undefined` 与"不填"混成一件事，而这两件事后果相反。 */
        entry.value = slot.value === undefined ? null : slot.value;
        entry.referenceRange = slot.referenceRange ?? null;
      }
      out.push(entry);
    }
  }
  return out;
}

/**
 * 读回来的骨架 → **章节属性补丁**（已发布的文书走这条路；草稿随整份 `sections` 一起交）。
 *
 * 为什么它必须与槽位元数据同一档、而不能"跟着骨架一起锁"：章节属性在**开文书那一刻**
 * 才被抄进章节节点，之后与模板再无联系 —— 所以已发布的文书也能改，不进任何已开出的病历
 * （见内核的 `SectionMetaPatch`）。而"哪几章算必备、哪几章整章算关键内容、说明怎么写"
 * 恰恰是上线之后随着质控反馈反复调的东西；为了调它去撤一次稿（医生端立刻开不出这份文书）
 * 是拿一个不存在的风险换一个真实的代价。
 *
 * 定位用**章节编码**：已发布的骨架此刻必定与库里一致，所以定位不会失手
 * （真失手了服务端会明说"定位不到"，而不是静默改到第一个同码的章节上）。
 */
function sectionMetaOf(sections) {
  const out = [];
  for (const section of Array.isArray(sections) ? sections : []) {
    out.push({
      sectionCode: String(section.sectionCode ?? ''),
      required: section.required === true,
      keyContent: section.keyContent === true,
      /* `null` = 清掉这一句说明（而不是留一个空串的说明：空串过不了校验，
         也不表示"有一句空的说明"） */
      description: typeof section.description === 'string' && section.description.trim() !== ''
        ? section.description.trim()
        : null,
    });
  }
  return out;
}

/** 把 `list[from]` 挪到 `to` 位置（拖动用的语义是"落到第几格"，不是"挪几格"） */
function tplMoveTo(list, from, to) {
  if (!Array.isArray(list) || !Number.isInteger(from) || !Number.isInteger(to)) return false;
  if (from < 0 || from >= list.length || to < 0 || to >= list.length) return false;
  if (from === to) return false;
  const [moved] = list.splice(from, 1);
  list.splice(to, 0, moved);
  return true;
}

/**
 * 拖放排序（**章节之间 / 同一章内部的槽位之间**）。
 *
 * 为什么用 document 级委托，而不是给每个把手挂监听：抽屉每重绘一次，DOM 都是新的 ——
 * 逐个挂监听就得在每一条重绘路径上记得重挂，漏一处就是"某些章拖得动、某些章拖不动"，
 * 而那种错只在特定的操作顺序下出现。委托挂在 document 上，重绘多少次都还在。
 *
 * 为什么拖动之外还留一组 ↑ / ↓：拖放**不是键盘可达的**，
 * 而"给一份 12 章的文书调顺序"不该只有鼠标一条路（拖放也常被触控板手势打断）。
 *
 * 只在**章节**与**同一章内的槽位**之间排序，不跨章拖槽位：跨章拖动要先决定
 * "那一格跟着哪一章走"（显示名 / 参考范围 / 表达式引用都在槽位上，跨章多半是想换个位置而已），
 * 而这个决定在提交前无法回退 —— 先删掉再在新章里加一格，是同一件事的显式做法。
 */
let TPL_DRAG = null;

/** 落点上是什么（哪一章 / 哪一章的第几格）；不在可落下的地方返回 null */
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
    /* 有的浏览器不设 data 就不发 drop 事件（顺序在内存里，这份载荷本身用不到） */
    event.dataTransfer.setData('text/plain', `l0-tpl-${TPL_DRAG.kind}`);
  }
});

/* 拖完（无论落在哪儿）都要清掉：留着它，下一次不相关的 dragover 会被当成"还在拖" */
document.addEventListener('dragend', () => { TPL_DRAG = null; });

document.addEventListener('dragover', (event) => {
  if (!TPL_DRAG) return;
  const drop = tplDropTargetOf(event.target);
  if (!drop) return;
  const acceptable = TPL_DRAG.kind === 'sec'
    ? drop.kind === 'sec'
    : drop.kind === 'slot' && drop.si === TPL_DRAG.si;
  if (!acceptable) return;
  /* 只在**不接受**的落点上不给"可以放下"的反馈：满屏都给，人就以为哪儿都能放 */
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
});

/* 落下来才真正改顺序：改完**重绘抽屉**（与 ↑ / ↓ 同一条路 —— 界面上看到的
   与待保存的必须是同一份，不做局部 DOM 插入） */
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

/* ------------------------------ 表达式控件：构造器 ------------------------------ */
/* 输入事件单列一份委托：数字与填写项 key 是"边打边改树"，
   不走 change（change 要等失焦），也不重绘（重绘会让人打一个字就丢焦点） */
document.addEventListener('input', (event) => {
  const el = event.target;
  if (!el || !el.dataset) return;
  /* 模板库的查询条件（模板名称）：边打边筛，不重绘输入框本身（它在表格之外，不会被重画）。
     查询一改就回到第 1 页：留在第 3 页上看"筛出来的第 3 页"，
     多数时候是一片空白，而空白会被读成"没有匹配的模板"。 */
  if (el.id === 'tplSearchName') {
    TPL_NAME_FILTER = String(el.value || '');
    TPL_PAGE = 1;
    renderTemplatePacks();
    return;
  }
  /* 规则库的查询条件（标题或规则号）：与模板库同一套做法 ——
     常驻的查询条 + 只重画下面那张表，所以输一个字也不会丢焦点。 */
  if (el.id === 'ruleSearchKeyword') {
    RULE_KEYWORD_FILTER = String(el.value || '');
    RULE_PAGE = 1;
    renderRuleTable(Array.isArray(((S || {}).knowledgePacks || {}).rules) ? S.knowledgePacks.rules : []);
    return;
  }
  /* 控件表格页的查询条件（控件名称）：与模板表同一套做法 ——
     常驻的查询条 + 只重画下面那张表，所以输一个字也不会丢焦点。 */
  if (el.id === 'exprSearchName') {
    EXPR_NAME_FILTER = String(el.value || '');
    EXPR_PAGE = 1;
    renderExprCatalog();
    return;
  }
  /* 专科控件表格页的查询条件（控件名称）：与上面两条同一套做法 */
  if (el.id === 'ctrlSearchName') {
    CTRL_NAME_FILTER = String(el.value || '');
    CTRL_PAGE = 1;
    renderCtrlCatalog();
    return;
  }
  /* 控件表单里换形状：行列表的行列、时序的时间轴勾选框都随形状出现或消失，
     所以要先"读回草稿"再重画 —— 不读这一下，切个形状就把刚填的那些丢了。 */
  if (el.id === 'ctrlNewShape') {
    readCtrlForm();
    if (CTRL_DRAFT) CTRL_DRAFT.shape = String(el.value || 'scale');
    renderCtrlForm();
    return;
  }
  /* 一动就把红框撤掉：红框说的是"刚才出问题的就是这一格"，
     改完还留着会让人以为还没改好（不 return：它只是一次清理，这一格还要继续被别的分支处理） */
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

/**
 * 正在编辑中的公式（AST）。
 *
 * 这里**用内存草稿**、而不是"每次从 DOM 读回"，与文书表单那套是相反的：
 * 公式是一棵树，DOM 上是它的展开图，两者的对应关系要一层层算路径 ——
 * 从 DOM 反推树会把"读回"变成又一次解析，而解析正是这里最不该出现的东西。
 * 于是：树是唯一的真相，界面每次重绘它（输入框用 `input` 事件直接改树，不重绘，免得丢焦点）。
 */
let TPL_EXPR_DRAFT = { kind: 'slot', key: '' };

/** 正在编辑哪一个控件（空 = 新建一个）。新建与编辑共用同一份表单，差别只在这里 */
let TPL_EXPR_EDIT_ID = '';
/** 打开编辑那一刻的公式原文：保存前比一下，才知道"这次到底改了公式没有"（只有改公式才需要确认） */
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

/** 按路径定位树里的节点（路径形如 `0.1.2`：第一段恒为根，其余是参数下标） */
function exprSteps(path) {
  return String(path).split('.').slice(1).map((step) => Number(step));
}

/** 改树：`mutate` 返回新节点。根被改时返回新根（所以调用方要接返回值） */
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

/** 函数下拉：**只列登记过的函数**（界面能选、引擎不认，是最难查的一类错） */
function exprFnOptions(selected) {
  const list = Array.isArray(S && S.expressionFunctions) ? S.expressionFunctions : [];
  if (list.length === 0) return '<option value="">（本机没有可用函数）</option>';
  return list.map((fn) => `<option value="${esc(fn.name)}"${fn.name === selected ? ' selected' : ''}>`
    + `${esc(fn.name)} —— ${esc(fn.doc)}</option>`).join('');
}

/** 系统字段下拉（`ctx` 节点）：**必须选一个**，所以没有"不填"这一项 */
function exprContextOptions(selected) {
  const fields = Array.isArray(S && S.contextFields) ? S.contextFields : [];
  if (fields.length === 0) return '<option value="">（本机没有可引用的系统字段）</option>';
  return fields.map((field) => `<option value="${esc(field.path)}"${field.path === selected ? ' selected' : ''}>`
    + `${esc(field.label)}（${esc(field.path)}）</option>`).join('');
}

/** 一个节点渲染成一行（函数节点会把自己的参数递归展开，缩进表示层级） */
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

/** 重绘构造器里那棵树（只有"换类别 / 换函数 / 加删参数"才重绘：输入时不重绘，免得丢焦点） */
function renderExprTree() {
  const box = $('exprTree');
  if (box) box.innerHTML = exprNodeHtml(TPL_EXPR_DRAFT, '0', 0);
}

/**
 * 表达式控件的表单（渲染进**二级**抽屉，从左侧滑入）：名称 / 单位 / 说明 / 公式。
 *
 * 新建与编辑共用一份表单：它们的差别只有"初值从哪来"与"提交时走哪条路"，
 * 分成两套的代价是两边迟早长得不一样（一边加了字段另一边没有）。
 * `item` 为空 = 新建。
 * 它画在二级层（`openTplDrawer(..., 2)`），而它要改的那张控件表就在页面上
 * （「基础数据 → 表达式控件」），两不相扰 —— 保存完关掉这一层，还看得见自己改的是表里哪一行。
 */
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

/**
 * 新建文书的表单（渲染进一级抽屉）：名称 / 文书类型 / 适用科室。
 *
 * 文书类型**只从「基础数据 → 文书类型」里选** —— 与科室下拉同一条纪律：
 * 类型编码是质控规则定位文书的依据，手打一个编码出来，那些规则就再也认不得这类文书，
 * 且不会有任何地方报错。字典为空时退回"从已有模板反推"，并在下方明说该去补字典：
 * **空字典只表示"还没建"，不表示"没有类型"**。两者都取不到时不给"自定义"这条后门。
 */
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
    /* 兜底：从已有模板反推类型（字典上线前的行为，保留给"还没建字典"的库） */
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

/** 规则表的可用性随策略变化：用"禁用"而不是"隐藏"，隐藏会让人以为这一格不存在 */
function syncPlacementTerms(strategy) {
  const terms = $('cfgPlaceTerms');
  /* 用默认值兜底：策略来自界面上可能为空的新值 */
  const selected = strategy || 'ordered';
  /* "按顺序"与"外部落位服务"都不使用规则表 */
  const usesRules = selected === 'section-title' || selected === 'term-table';
  terms.disabled = !usesRules;
  terms.placeholder = usesRules ? '每行一条：主诉=t_1\n现病史=t_2' : `当前策略（${selected}）不使用规则表`;
  /* 结构化词表跟着同一个开关位：策略不参与时它也不会被用到（既然要说"不参与"，就不能让它看起来还能配） */
  const structure = $('cfgPlaceStructure');
  if (structure) {
    structure.disabled = !usesRules;
    structure.placeholder = usesRules
      ? '结构化词表（每行一条）：体温=WS445:DE05.01.001:体温\n格式：词=体系:编码[:显示名]；留空 = 不做任何数据元提议'
      : `当前策略（${selected}）不产出数据元提议`;
  }
}

/* 结构化词表回显：形状是"词 → { system, code, display? }"，界面统一成"词=体系:编码[:显示名]" */
function structureMapLines(structureMap) {
  return Object.entries(structureMap || {})
    .map(([word, tag]) => `${word}=${tag.system}:${tag.code}${tag.display ? `:${tag.display}` : ''}`)
    .join('\n');
}

/**
 * 解析结构化词表输入（"词=体系:编码[:显示名]"）。
 *
 * 返回 `{ ok: true, map }` 或 `{ ok: false, message }`：不合法就当场点名第几行，
 * 而不是"保存成功、其中一条悄悄没生效" —— 配置类错误最怕这种沉默。
 * **体系是否合法交给服务端判**（清单只有一份）：前端再抄一份，
 * 迟早出现"前端放过去、后端拒了"或反过来的分歧。
 */
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
  /* 规则表按当前策略回显：两种策略的数据形状不同（对象 / 数组），界面统一成"关键词=节点" */
  const pairs = strategy === 'term-table'
    ? (pl.termMap || []).map((item) => `${item.match}=${item.nodeId}`)
    : Object.entries(pl.sectionMap || {}).map(([key, value]) => `${key}=${value}`);
  $('cfgPlaceTerms').value = pairs.join('\n');
  /* 结构化词表独立回显：它与落位规则表是两张表（可以只配一张），不复用上面的 pairs */
  const structureField = $('cfgPlaceStructure');
  if (structureField) structureField.value = structureMapLines(pl.structureMap);
  const external = pl.external || {};
  $('cfgPlaceEndpoint').value = external.endpoint || '';
  $('cfgPlaceTimeout').value = external.timeoutMs || 20000;
  /* 密钥永不回显：每次渲染都清空（回显一次，密钥就进了浏览器内存、截图与前端日志） */
  $('cfgPlaceApiKey').value = '';
  syncPlacementTerms(strategy);
}

/**
 * 语音采集：地址 / 超时预算 / 分片参数 / 留存开关。
 *
 * 有两件事在字段值上看不出来，必须另外说清：
 *   - **采集入口现在是否可用**："地址填了、模型标识没填"这种半配置状态，
 *     只看字段值会显得像配好了 —— 由页头那个 chip（已配置 / 未配置）与保存后的状态行负责明说；
 *   - **音频会不会留存**：它是数据流向问题（留存的音频里必然含患者信息），
 *     所以直接写在「音频留存」那一格的选项文字里，不藏在别处。
 */
function renderCapturePanel() {
  const cap = S.capture || {};
  const segment = cap.segment || {};
  const vendors = Array.isArray(cap.vendors) ? cap.vendors : [];
  const kind = cap.kind || 'intranet-task';

  /* 下拉**只从服务端下发的厂商表渲染**：界面里没有一份写死的厂商名单，
     所以"加一家厂商"是服务端加一行，前端不动（写死就会出现"选项里没有它"这种半接线）。 */
  const select = $('cfgCaptureKind');
  const wanted = vendors.map((item) => `<option value="${esc(item.kind)}">${esc(item.label)}</option>`).join('');
  if (select.dataset.rendered !== wanted) {
    select.innerHTML = wanted;
    select.dataset.rendered = wanted;
  }
  /* 只有**从 state 整页回显**时才把下拉框写回生效值。
     用户刚选完那一下不能回写：那一写会把他的选择覆盖掉，界面表现就是"点了没反应"
     （同 ui.js 里落位策略那条教训 —— 它们都是"回显覆盖了刚做的操作"）。 */
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

/**
 * 随**厂商**变化的那部分界面：警告块、凭据格、占位示例、协议说明。
 *
 * 抽出来是为了让"换厂商"能立刻反映到表单上、又**不回写下拉框与状态行**：
 *   - 回写下拉框 = 覆盖用户刚做的选择（"点了没反应"）；
 *   - 回写状态行 = 让人以为"已经生效了"，而生效要等保存。
 * 它只描述**表单里这份待保存的配置**。
 */
function applyCaptureVendorUi(kind) {
  const cap = S.capture || {};
  const vendors = Array.isArray(cap.vendors) ? cap.vendors : [];
  const vendor = vendors.find((item) => item.kind === kind) || {};
  const shape = vendor.credentialShape || 'none-or-token';

  /* 占位文字里**不写死任何 IP**：院内那台的地址只有部署方知道，
     写一个示例地址反而会让人以为"照这个填就行"（它必然是错的）。
     有默认地址的那几家由服务端的厂商表给出，前端不重复一份。 */
  $('cfgCaptureEndpoint').placeholder = vendor.defaultEndpoint
    ? `${vendor.defaultEndpoint}（该服务的默认地址，可改）`
    : '院内服务的地址，形如 https://asr.院内域名/（留空 = 未配置：采集入口随之不可用）';
  $('cfgCaptureModel').placeholder = vendor.modelIdHint || '须带版本/日期';

  /* 凭据格按厂商显示：给一家不需要的格子留着，会出现"密钥已就位"而实际发不出去。
     院内那一档的凭据是**可选**的：没配过就不显示这一格（省掉一行"你可以不填"的噪音），
     配过则显示，好让人看得见"有这么一份凭据"并能清掉它。 */
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

  /* 公有云警告：**平时整块不出现**，选了公有云才出现，并要求勾确认。
     换厂商时把勾选**清掉**：确认是"对某一家、某一次"的确认，
     留着上一次的勾，等于替人把这一次也确认了。 */
  $('cfgCaptureCloudWarn').hidden = vendor.leavesIntranet !== true;
  $('cfgCaptureAck').checked = false;
  $('cfgCaptureProtocol').textContent = [vendor.protocol, vendor.timingNote].filter(Boolean).join('；');
}

/**
 * 换厂商时的**提示**（不改值）：地址留着上一家的就明说，别让人以为它自动换好了。
 *
 * 空地址时把这一家的示例地址写进 placeholder 已经是 `renderCapturePanel` 做的事；
 * 这里只负责"地址还是别家的"这一句提示 —— 那是切换厂商时最常见的半配置状态。
 */
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

/**
 * 保存采集配置：两格凭据都是三态（留空 = 不改 / 传 null = 清除 / 填了 = 设新值），与模型配置一致。
 *
 * `apiSecretOverride` 与 `apiKeyOverride` 分开传：一个动作只该动一格 ——
 * 清次凭据时顺手把主凭据也带上，就会把"我只想清一个"变成"两个都动了"。
 */
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
    /* 公有云没勾确认 / 数据流向类错误要**原样显示服务端那句话**：它比前端能编的任何提示都准 */
    setCaptureStatus(`保存失败：${(r && (r.message || r.code)) || '未知原因'}`);
    await requireSession();
  }
}

/* 医院签名服务：字段映射是给"不同医院的签名服务"用的：换医院只填映射，不改代码。
   没有"内置软件签名"这一档：未配齐就签不了章（`E_SIGN_NOT_CONFIGURED`），绝不回退演示密钥。 */
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
  /* 密钥永不回显：每次渲染都清空（同模型/落位/采集密钥） */
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
  /* 预置公钥不回显全文（太长，且它只需要被核对）：只报"已预置 + 指纹"，留空即不修改 */
  $('cfgSignPublicKey').value = '';
  $('cfgSignPublicKey').placeholder = cfg.publicKeyPresent
    ? `已预置公钥（指纹 ${String(cfg.publicKeyFingerprint || '').slice(0, 16)}…）：留空 = 不修改`
    : 'SPKI base64（签章必需：先点「测试签名」拿到指纹，再把公钥固定下来）';
}

/** 授权平台：只有"信任哪个平台"一件事，没有"演示替身"这一档（那迟早会被当成生产可选项打开） */
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

/**
 * 预问诊接入：只有两格 —— 要不要校验、密钥是什么。
 *
 * 密钥**永远不回显**（库里只有哈希，想回显也回显不出来）。所以输入框一直是空的，
 * placeholder 承担"现在到底配没配"这个信息：一句"留空 = 不修改"读不出状态，
 * 而"已配置（…）· 留空 = 不修改"能。
 */
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
  /* 服务端给的那句话就是最准的说明（它知道 authMode 是演示还是严格），
     前端再编一句必然会在某个分支上说不准 */
  setPrevisitStatus(cfg.note || '');
}

/** base64 → PEM 文本（纯展示：便于线下交换，服务端始终只存 base64） */
function pemFromBase64(base64) {
  const wrapped = String(base64 || '').replace(/(.{64})/g, '$1\n').trim();
  return `-----BEGIN PUBLIC KEY-----\n${wrapped}\n-----END PUBLIC KEY-----`;
}

/** 接收方公钥目录：交付目标的登记处（供授权平台封装内容密钥），不参与签发 */
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

/* ------------------------------ 分区（一级） ------------------------------ */

/**
 * 分区切换 + 懒加载。
 *
 * 数据的取用是懒的：切到哪个分区才拉哪个接口。这里不轮询，
 * 一个管理后台不该在背后不停发请求，而"审计与运行状态"也不是越实时越好：
 * 它们要的是"我来看的时候是准的"，不是"每秒都在变"。
 */
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
    /* 标签页标题也跟着走：同时开着医生端与后台时，靠它一眼分辨（比辨认 URL 快） */
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
    /* 两份字典**一起拉**：它们是同一页的两块，串行发两次请求会让页面先显示一半，
       而"另一半是空的"看起来像"那份字典没配"，与事实不符。
       「判定方式」不用拉：它是内核的判定机制，随 `state` 一起下发（`qcPredicates`），
       界面不许自己抄一份判法清单 —— 抄出来的那份与引擎不一致时表现是"界面能选、引擎不认"。 */
    const [dept, docTypes] = await Promise.all([api('/api/departments'), api('/api/doc-types')]);
    if (dept.ok) renderDepartments(dept.data);
    else setLoginStatus(`读取科室字典失败：${dept.message || dept.code || '未知原因'}`, true);
    if (docTypes.ok) renderDocTypes(docTypes.data);
    else setLoginStatus(`读取文书类型失败：${docTypes.message || docTypes.code || '未知原因'}`, true);
    renderPredicates();
    /* 表达式控件的目录随 `/api/state` 下发（`templateCatalog` 里 `itemType === 'expression'` 的那些），
       不用另拉接口：这里按当前 state 画一遍，切到那个子页签时另有一次。 */
    renderExprCatalog();
    /* 专科控件的目录同样随 `/api/state` 下发（同一个 `templateCatalog` 里 `itemType === 'control'` 的那些） */
    renderCtrlCatalog();
    return;
  }
  if (name === 'system') {
    const r = await api('/api/admin/system');
    if (r.ok) renderSystem(r);
    else setLoginStatus(`读取系统信息失败：${r.message || r.code || '未知原因'}`, true);
  }
}

/* ------------------------------ 基础数据：判定方式 ------------------------------
   这一页两组：判定方式（一张表，**全部可改可删**）与"自定义条件能拼哪些格"（字段表 / 算子表）。
   判定方式是一份**被规则引用的资产**：规则只说"引用哪一条、实参是多少"，
   所以改一条判定方式，引用它的规则一起变。它是**库级资产**（全院一份、不属于任何包）——
   任何包的规则都能引用它；出厂那几条由种子写进库里一次，此后与本院自己建的完全同级。
   目录来源是 `state.qcConditions` —— 与规则抽屉里那个下拉**同一份**，
   界面不另抄一份清单（两处漂移的表现是"界面能选、引擎不认"）。
   原先这一页还有一组"内核判法（只读卡片）"：它与判定方式是同一件事的两处摆法，
   已经并进下面那张表 —— 规则库引用的是判定方式，界面上不再单摆一层"内核判法"。 */

/** 参数格里的「取值」：下拉列出取值域；数字说清必填 / 不填按内置值；其余写不限 */
function conditionParamRange(spec) {
  if (Array.isArray(spec.options) && spec.options.length > 0) return spec.options.join(' / ');
  if (spec.kind === 'integer' || spec.kind === 'number') return spec.required ? '必填的正数' : '不填按内置值判';
  if (spec.kind === 'string-list') return '词表（逗号或顿号分隔）';
  if (spec.kind === 'boolean') return '是 / 否';
  return spec.required ? '必填' : '不限';
}

/**
 * 自定义条件的字段表与算子表（只读）。
 *
 * 为什么要把它们列出来：这两张表就是"能拼什么"的**全部答案**。不列的话，
 * 使用者只能在规则抽屉里一个个试 —— 而"这个格子没有我要的选项"与
 * "这件事这套系统做不了"是两件事，看起来却一模一样。
 */
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

/**
 * 「基础数据 · 判定方式」整页。
 *
 * 这一页原先三组：内核判法（只读卡片）· 条件库（具名条件）· 字段与算子表。
 * 前两组其实是同一件事的两处摆法（数据化那 6 条与内核那 6 种判法逐条对应），
 * 现在只有**一张表**：判定方式（库级资产，一律可改可删）+ 字段与算子表。
 * 撤掉"内核判法"那一组的理由不是页面太长，而是：规则库引用的是**判定方式**，
 * 界面上再摆一层"内核判法"，人会以为造规则要经过两个选择 —— 而它们本来就是同一层。
 *
 * 这一页要回答的仍然是那三件事：有哪几条判定方式、各自怎么判、有没有人在用。
 * "谁在用它"是它真正的价值：一条判定方式没人用，要么是本院用不上、要么是还没人配 ——
 * 两者下一步动作完全不同，在此之前只能把规则库从头翻一遍才看得出来。
 */
function renderPredicates() {
  renderConditionLibrary();
  renderConditionCatalog();
}

/**
 * **算子插件**那一块（T3）：这台机器上装了哪些、各带来了哪些算子、装不上的为什么。
 *
 * 为什么必须显示而不是只打日志：插件带来的是**算子**，
 * 而"为什么这台机器上没有那个算子"这个问题的答案，只可能在启动输出里，
 * 那是没人会去看的地方。装不上更不能沉默 —— 它会表现成"规则没命中"，而界面上一切正常。
 */
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

/* ------------------------------ 基础数据：判定方式 ------------------------------
   判定方式是一份**被规则引用的资产**：多条规则共用同一套口径时，改一处、引它的规则一起变。
   它是**库级资产**（全院一份、不属于任何包；出厂那几条由种子写进库里一次），
   所以这一页一律可改可删，只有"被规则引用时拒删"这一条保护。
   改它**不改任何包的内容指纹** —— 留痕由库级写入单独记一条（`condition-store.ts`）。
   代价就是那半句话，所以这一页有三处刻意的做法：
   ① 「谁在用它」是表里的一列 —— 数据来自 `state.qcConditions[].usedBy`，
      与删除保护读的是同一个函数（两处各算一遍会得到"界面说没人用、删除却被拒"）；
   ② 编辑抽屉在**提交前**就把影响面摆在参数那一格下面，而不是保存完再告诉人；
   ③ 编码（`C-CUSTOM-N`）只读：它是引用键，改了它，引用它的规则会立刻变成悬空引用。

   与规则库同一套口径：目录本来就在 `state` 里，这一页只读不拉（保存后由 `state` 回冲）。 */

const CONDITION_LIB_BODY_ID = 'conditionLibraryBody';
/** 判定方式抽屉里此刻摆的是哪一条（新建时为 `''`）。判定方式不属于任何包，所以没有"哪个包"这一格 */
let CONDITION_DRAWER_ITEM = '';

function setConditionLibStatus(text) { markCfgStatus($('conditionLibStatus'), text); }

/** 谁在用它：引用面是结构不是措辞，所以读不出来也要照旧列出来（用的还是同一份 usedBy）。
 *
 * 判定方式是**库级资产**：引用它的规则可能分布在好几个包里，所以每一行都带上它在哪个包 ——
 * "会影响哪几条"在那时才真的有用（人不仅要认出规则名，还要知道去哪一页找它）。 */
function conditionUsedByHtml(usedBy) {
  const users = Array.isArray(usedBy) ? usedBy : [];
  if (users.length === 0) return '<span class="chip warn">还没有规则引用</span>';
  const enabled = users.filter((user) => user.enabled).length;
  const packs = new Set(users.map((user) => String(user.packId || '')));
  return `<span class="chip ok">${users.length} 条规则引用（启用 ${enabled}）</span>`
    + (packs.size > 1 ? `<div class="muted">分布在 ${packs.size} 个包</div>` : '')
    + `<div class="muted">${users.map((user) => esc(`${user.packId ? `${user.packId} / ` : ''}${user.title}`)).join('、')}</div>`;
}

/** 参数表在表里的说法：`$minLength（最短长度 · 必填 · 必填的正数）` —— 一列的字，不摊成一块 */
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
  /* **判定方式一律可改可删**（出厂那几条也一样：它们由种子写进库里，此后归本院）。
     每行都给三个动作，没有"只读、只能复制"那一档：
       - 改：改的是**判定方式库**（不属于任何包），审计里单独记一条，而且**影响所有引用它的规则**
         （可能跨好几个包 —— "谁在用它"那一列会先说出来）；
       - 复制：留着一条改之前的口径；
       - 删：被任何包的规则引用时拒删（服务端与这里的判据是同一份 `usedBy`）。 */
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

/**
 * 判定方式那张表：**一张表**（编码 · 名称 · 判定条件与参数 · 谁在用它 · 操作）。
 *
 * 它走过两站：先是"一张表两组"（内置只读 / 本院自建），再是"包内容、按包分组"。
 * 定稿是**库级资产**（全院一份、不属于任何包）：
 *   - 出厂那几条由种子写进库里一次（`seed-conditions.ts`），与本院自己建的完全同级；
 *   - **任何包的规则都能引用它** —— 所以表上不再有"在哪个包"这一列，
 *     而"谁在用它"那一列反过来要带上包（引用方可能分布在好几个包里）。
 */
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
      /* 这一格是这一页最容易被读错的地方，所以把"谁能改"直接写在表头上方 */
      ['改动方式', '均可改可删（被规则引用时拒删）'],
      /* 判定方式不进包内容指纹，"改了没有"只能靠这一格答 —— 它直接读库那一侧的记账 */
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

/* ------------------------------ 条件抽屉 ------------------------------ */

/** 打开条件抽屉的那个按钮：关闭后焦点要还回去 */
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

/** 关闭后的清理统一放在 `close` 事件里：Esc 关的、点按钮关的都只走这一处 */
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

/**
 * 条件表单（新建与编辑共用同一屏）。
 *
 * "条件编码"是**只读**的：它同时是引用键与留痕里的出处，事后改它等于换一条新条件。
 * 名字与说明之外，条件本身就是条件树 —— 走的是与规则抽屉里**同一个构造器**
 * （`conditionBuilderHtml`，只是容器换了一个），字段表与算子表仍然由服务端下发。
 */
/**
 * **参数表**（T1）：一条判定方式带哪几个参数、各自什么类型。
 *
 * 它是"一条判定方式被多条规则以不同阈值复用"的全部依据 —— 参数表怎么写，
 * 引用它的规则就能填哪几格。所以这一块必须**逐格都能改**（类型、必填、取值域、说明），
 * 而不是只给一个名字：给一个名字的话，界面能填的格与引擎认的格迟早对不上。
 *
 * 参数名一律以 `$` 显示（`when` 里写的就是 `$名字`）：让人一眼对得上条件树里那一格。
 */
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

/** 从参数表那一段读回规格。**名字空的整行丢掉**（服务端会拒，不必送过去） */
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

/**
 * 读回条件表单。
 *
 * 与规则表单同一条纪律：**界面上能改的每一格都要读回来** —— 少读一格，
 * 点一次保存就把它清掉了，而且没有任何地方会报错。
 *
 * `conditionLocked`（树里有嵌套）时**不交 `when`**：构造器只拼平铺的条件，
 * 交上去就是把嵌套摊平 —— 那会静默改变这条条件的含义。不交 = 服务端不动它
 * （`patchCondition` 的语义正是"不给就不改"）。
 */
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

/** 打开"编辑这一条条件"的抽屉（按钮在判定方式表行尾） */
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

/** 打开"新建一条条件"的抽屉（`seed` 来自表里那一行"复制"） */
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

/* ------------------------------ 基础数据：科室字典 ------------------------------ */

/**
 * 科室字典页：一行一个科室（编码 / 名称 / 启用 / 删除）。
 *
 * 为什么"编码"是这一页的主角：判定靠它（就诊的科室编码与模板上的适用科室按它比对），
 * 名称只是给人看的。所以改名称是安全的，改编码会让配了它的文书立刻开不出 ——
 * 后者在界面上必须说清楚，否则那会是一次"只改了个字母"的事故。
 */
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

/** 读一个勾选容器里被勾上的科室编码（新建与编辑两处共用；勾选框的值就是编码） */
function tplPickedDepartments(containerId) {
  const box = $(containerId);
  if (!box) return [];
  return [...box.querySelectorAll('[data-tpl-dept]')]
    .filter((input) => input.checked)
    .map((input) => String(input.dataset.tplDept));
}

/** 读回界面上此刻的科室清单（保存与"是否有改动"都看它，不看内存副本） */
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

/* ------------------------------ 基础数据：文书类型 ------------------------------ */

/** 体系下拉的取值：先用服务端给的白名单，拿到之前用同一份兜底（两处各写一套迟早对不上） */
let DOC_TYPE_SYSTEMS = ['WST500', 'WS445', 'local', 'custom'];

/**
 * 文书类型页：一行一个类型（体系 / 编码 / 显示名 / 启用 / 删除）。
 *
 * 造型与科室字典一致，只多一格「体系」：判重看的是「体系 + 编码」这一对
 * （国标 `WST500` 与院内 `local` 各有一个 `A01` 是两回事），
 * 所以体系必须摆在行里 —— 藏起来的话，"为什么 A01 能加两次"就没有解释。
 */
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

/** 读回界面上此刻的类型清单（保存与"是否有改动"都看它，不看内存副本） */
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

/** ISO 时间 → 本地可读（管理界面上直接甩 ISO 串，读的人得自己拆一遍） */
function fmtWhen(iso) {
  const time = new Date(String(iso));
  return Number.isNaN(time.getTime()) ? String(iso ?? '—') : time.toLocaleString('zh-CN', { hour12: false });
}

/** 摘要里的时间只到分钟：精确到秒是给审计用的，摆在摘要里纯属噪声 */
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
  /* 状态与"还缺什么"拆成 chip：一大段括号套括号的句子，读的人得先把括号配对才看得懂 */
  const signMissing = Array.isArray(sign.missing) && sign.missing.length > 0 ? sign.missing : ['地址或公钥'];
  $('healthSign').innerHTML = chips([
    ['状态', configured ? '已配置（签章会经过它）' : '未配齐（签不了章）', configured ? 'ok' : 'danger'],
    configured ? null : ['还缺', `${signMissing.length} 项`, 'warn'],
    ['测试', `成功 ${sign.ok ?? 0} 次 / 失败 ${sign.fail ?? 0} 次`, sign.fail > 0 ? 'warn' : null],
  ]);
  /* 完整清单放在 chip 行下方：chip 里只报"几项"，因为它是清单，不能只给个数 */
  $('healthSignMissing').textContent = configured ? '' : `还缺：${signMissing.join('、')}`;
  $('healthSignLast').textContent = sign.last
    ? `最近一次：${fmtWhen(sign.last.at)}（${sign.last.detail}）`
    : '最近一次：尚未测过（配好之后点下面的按钮，或去「能力配置 → 电子签名」）';

  const model = h.model || {};
  const modelChip = $('healthModelChip');
  /* 产出方式给人话（`offline` 是内部标识，不该让人读它） */
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
    /* 会话数用 `activeSessions`：服务端给的字段名就是它。
       这里曾写成 `counts.adminSessions`（一个不存在的键），于是这一格永远是空的，
       而"空格子"最容易被读成"零"。（`undefined ?? '—'` 至少让它显示成一个破折号） */
    ['登录会话', counts.activeSessions],
    ['审计记录', counts.auditEntries],
  ]);
  $('healthCounts').innerHTML = kvRows([['本进程启动于', fmtWhen(h.startedAt)]]);
}

/* 动作审计的页码（从 1 起）与每页条数：与模板库 / 控件表格页同一套做法（每页 10 条也一样）。
   审计记录只会越攒越多（单次下发窗口是 500 条），铺满一屏之后"最近发生了什么"反而要先滚半天，
   所以这里也分页；而翻页是纯客户端的事（条目已在本次下发里），不重新请求。 */
let AUDIT_PAGE = 1;
const AUDIT_PAGE_SIZE = 10;
/** 最近一次下发的审计条目：翻页要能重画同一份数据，所以在这里留一份 */
let AUDIT_ENTRIES = [];

function renderAudit(a) {
  const entries = Array.isArray(a.entries) ? a.entries : [];
  const counts = a.counts || {};
  const chain = a.chain || {};
  $('auditCount').textContent = `${entries.length} 条（本次下发上限 ${counts.limit ?? '—'}`
    + (counts.dropped > 0 ? `，另有更早的 ${counts.dropped} 条未下发（**都在库里**，没有丢）` : '') + '）';

  /* 链校验：改过历史就指认断在第几条。这一栏是"审计可不可信"的唯一依据，
     所以"完好"也要说清是"逐条复算通过"，而不是一个绿点。 */
  $('auditChain').innerHTML = chips([
    /* 账记在哪（库）与旧文件在哪，是**两个问题** —— 混成一个字段就答不准任一。
       旧文件在搬家之后不再被读，但要说清它还在原处（回滚凭据）。 */
    ['记账位置', chain.table || '—', 'mono'],
    ['旧文件（不再读）', chain.legacyFile || '—', 'mono'],
    chain.intact
      ? ['链校验', '完好（逐条复算通过）', 'ok']
      : ['链校验', `断裂（第 ${chain.problem && chain.problem.atLine ? chain.problem.atLine : '?'} 条：${(chain.problem && (chain.problem.reason || chain.problem.kind)) || '原因未知'}）`, 'danger'],
    chain.discarded > 0 ? ['未能验证', `${chain.discarded} 条（不展示、**但仍留在库里**，见边界说明）`, 'warn'] : null,
    a.writeError ? ['写入失败', a.writeError, 'danger'] : null,
  ]);

  /* 每次下拉都是一份新数据（刷新 / 切回本页都走这里），所以从第 1 页看起：
     留在第 3 页上看"新到的那几条"，多数时候是一片对不上的旧记录 */
  AUDIT_ENTRIES = entries;
  AUDIT_PAGE = 1;
  renderAuditEntries();
  $('auditBoundary').innerHTML = (Array.isArray(a.boundary) ? a.boundary : [])
    .map((item) => `<li>${esc(item)}</li>`).join('');
}

/**
 * 审计条目那一块（记录列表 + 分页条）：只重画这一块，翻页不重新请求。
 *
 * 页码读的是本次下发的那一份清单，越界要**夹回来**（换页后在别处刷新、或下发的窗口变短，
 * 都会让当前页号落到范围外，而"翻到这一页是空的"看起来像记录丢了）。
 */
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
    /* 三列对齐（时间 / 谁对什么 / 类型）：此前是"时间 · 人 · 对象 · 类型"串一行，扫读得自己找边界 */
    const head = `<div class="muted">${esc(fmtWhen(entry.at))}</div>`
      + `<div><b>${esc(entry.actor)}</b> <span class="muted">·</span> ${esc(entry.subject)}</div>`
      + `<div class="muted">${esc(entry.kind)}</div>`;
    /* 变化用"旧值删除线 → 新值加粗"：审计要能一眼看出方向，
       而不是让人自己在两串文字里找不同 */
    const diff = changes.length === 0
      ? `<div class="muted">（无字段变化${entry.note ? `：${esc(entry.note)}` : ''}）</div>`
      : `<div class="audit-diff">${changes.map((item) => `<div>· ${esc(item.field)}：`
        + `<s>${esc(item.before)}</s> → <b>${esc(item.after)}</b></div>`).join('')}</div>`
        + (entry.note ? `<div class="muted">${esc(entry.note)}</div>` : '');
    return `<div class="audit-row">${head}${diff}</div>`;
  }).join('');

  /* 只有一页时也照常显示（两个按钮都置灰）：分页是一个稳定存在的机制，
     藏起来会让人不知道"这份记录还有没有下一页" */
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

/* ------------------------------ 账号管理 ------------------------------ */

/** 角色的人话（与 `principal.ts` 的 `ROLE_LABELS` 同一套词）：列表下拉框与新增表单共用一处 */
const ROLE_OPTIONS = [['admin', '管理员'], ['qc', '质控员'], ['clinician', '医生'], ['viewer', '只读']];

/** 账号动作的状态行：两处独立（新增 / 重设口令），理由同"落位 / 签名各占一行"，
    混在一行会互相覆盖，而那两个动作的失败原因不一样 */
function setAcctStatus(text) { markCfgStatus($('acctStatus'), text); }
function setAcctPwdStatus(text) { markCfgStatus($('acctPwdStatus'), text); }

/**
 * 账号列表。
 *
 * 只渲染服务端给的字段（`user-store.ts` 的 `AdminUser` 白名单里没有口令材料），
 * 本页因此不存在"不小心把哈希渲染出去"这条路径，而不是靠这里记得别渲染。
 */
function renderAccounts(data) {
  const accounts = (data && data.accounts) || {};
  const users = Array.isArray(data && data.users) ? data.users : [];
  S.users = users;

  const admins = Number(accounts.admins ?? 0);
  const chip = $('acctChip');
  chip.textContent = admins > 0 ? `${admins} 个可用管理员` : '没有可用管理员';
  /* 「可用管理员 0」= 谁也进不来。它与"我口令记错了"在现场同形，
     所以它必须是一个红色徽标，而不是一堆数字里的一格。 */
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
    /* 角色改在下拉框里而不是弹窗：改角色是这条列表上最常做的一件事，
       而"点按钮 → 弹窗 → 选 → 确认"四步里有三步是界面自找的。 */
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

/**
 * 账号写动作的统一出口。
 *
 * 五个动作的"成功之后做什么"完全一样（重画列表 + 一行反馈），而失败口径也必须一样。
 * 各写一遍的代价是：漏掉其中一处的 `renderAccounts`，界面就会停在旧列表上，
 * 那看起来像"点了没反应"，而实际是"改成功了但没画出来"。
 */
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
    /* 路径与指纹用等宽：l/1/I 与 0/O 在比例字体里会看错，而这两栏是拿来逐字比对的 */
    ['数据目录', s.stateDir, 'mono'],
    ['产物目录', s.artifactsDir, 'mono'],
    /* 这一栏原先叫「管理口令来源」，答的是"环境变量注没注"；
       口令搬进数据库之后，该问的是"账号在哪、有几个"，问题变了，栏目也跟着变 */
    ['账号来源', (s.accounts && s.accounts.source) || '—'],
    ['可用管理员', s.accounts ? String(s.accounts.admins ?? 0) : '—'],
  ]);
  $('sysFingerprints').innerHTML = kvRows(
    Object.entries(s.configFingerprints || {}).map(([key, value]) => [key, value, 'mono']),
  );

  /* 这一段是的：把"本页没有的"逐条写出来。
     缺席的东西会被默认成存在（"管理后台嘛，总该有版本回滚吧"），
     而默认它存在，比知道它不存在危险得多。 */
  $('sysMissing').innerHTML = [
    '环境隔离：环境标识只是标注（server-config.json 的 envName），不改变任何行为（还没有预发 / 生产分离）',
    '配置版本与回滚：需手动改回，审计中有前后值可参照',
    /* 这一条逐字改过：账号入库之后，"单一口令 + 手填身份"已经不再成立，
       而这一段的全部价值就在于"它说的每一句都是现在的事实"。
       剩下的缺口照实说：有账号与角色了，但没有口令策略、没有多因素、没有统一身份。 */
    '统一身份与多因素：现在是"本机账号 + 口令"，没有对接医院 CA / SSO，也没有二次验证（属 T23）',
    '会话落盘：会话在内存里，进程重启即全失效（多实例部署需要粘性会话或共享存储）',
    '审计防篡改：审计在文件里由链式摘要自证，但能改数据目录的人就能重签锚点（属 T23）',
    '告警与通知：不会主动告诉任何人"签名服务挂了"',
    '不看病历正文：本后台管"系统怎么接"，要看内容得走医生端的受控阅读（授权 + 留痕）',
  ].map((item) => `<li>${esc(item)}</li>`).join('');
  /* 系统策略不在 `/api/admin/system` 的返回里（它是配置，不是运行信息），单独取一次 */
  void loadSystemPolicy();
}

/* ------------------------------ 系统策略（系统信息页） ------------------------------ */

/**
 * 系统策略：鉴权模式 / 会话寿命 / 限流阈值 / 锚定节奏 / 锚点种子。
 *
 * 它**与其它配置的关键差别是"改完要重启"**（这几项落在会话表、限流器、锚点签名者
 * 这三个进程内结构的构造上），所以这一屏必须把这句话写在按钮旁边 ——
 * 否则现场的表象是"我改了、什么都没发生"，而人只会怀疑自己没保存成功。
 */
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
  /* 种子永不回显：每次渲染都清空（回显一次，它就进了浏览器内存与截图） */
  $('cfgSysAnchorSeed').value = '';
  $('cfgSysPolicyCurrent').innerHTML = chips([
    ['鉴权', p.authMode === 'strict' ? 'strict（写操作要求会话）' : 'open（演示模式：写病历不鉴权）', p.authMode === 'strict' ? 'ok' : 'warn'],
    ['来源', p.source === 'store' ? '管理后台（存入数据库）' : '默认'],
    ['锚点种子', p.anchorSeedConfigured ? '已自定义' : '内置演示种子（拿得到代码的人也能重签锚点）', p.anchorSeedConfigured ? 'ok' : 'warn'],
    p.updatedBy ? ['最近修改', `${p.updatedBy} · ${fmtShort(p.updatedAt)}`] : null,
  ]);
}

/** 保存系统策略（`anchorSeedOverride === null` = 显式清除种子，由「清除锚点种子」按钮触发） */
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

/* ------------------------------ 内涵类质控配置（质控页） ------------------------------ */

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
  /* 两项"读出来的问题"都落到状态行：它们原先写在摘要行里，摘要行去掉后不能就此静默 */
  const rejected = Array.isArray(qc.rulesRejected) ? qc.rulesRejected : [];
  if (qc.rulesProblem) $('cfgQcStatus').textContent = `规则清单有问题：${qc.rulesProblem}`;
  else if (rejected.length > 0) $('cfgQcStatus').textContent = `规则清单有 ${rejected.length} 条校验不通过，已被丢弃`;
}

/** 保存内涵质控配置（`tokenOverride === null` = 显式清除凭据） */
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

/* ------------------------------ 保存 ------------------------------ */

async function saveModelConfigFromForm(apiKeyOverride) {
  /* 没有 adminId：操作者由服务端会话决定。请求自报身份在这里已被彻底移除。 */
  const body = {
    format: $('cfgFormat').value,
    model: $('cfgModel').value.trim(),
    endpoint: $('cfgEndpoint').value.trim(),
    timeoutMs: Number($('cfgTimeout').value),
    maxItems: Number($('cfgMaxItems').value),
  };
  /* 密钥三态：留空 = 不改（不传该字段）；显式 null = 清除；填了 = 设置。
     把"留空"当成"清空"，会让管理员只改个地址就把密钥弄丢。 */
  const typed = $('cfgApiKey').value;
  if (apiKeyOverride === null) body.apiKey = null;
  else if (typed !== '') body.apiKey = typed;
  /* 带密钥的保存会明显变慢：密钥落盘前要过 PBKDF2-HMAC-SM3（20 万次迭代），
     实测单次派生约 7.6 秒、加解密各一次约 15 秒。不提前说一声，管理员会以为界面卡死，
     然后再点两次，而那会写出多份快照。慢是设计（口令熵低必须慢化），但沉默不是。 */
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

/**
 * 保存落位配置：界面把两种策略的规则统一成"关键词=节点"一张表，保存时按策略分发。
 *
 * 密钥三态与模型/采集一致：**留空 = 不改**（界面永远拿不到原值），
 * `apiKeyOverride === null` 表示显式清除（由「清除密钥」按钮触发）。
 * 把"留空"当成"清空"的代价很具体：管理员只改个地址，密钥就没了，
 * 而现场表现是"外部落位突然 401"，没人会想到是"改地址顺手清了密钥"。
 */
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
    /* 外部落位：地址 / 超时。**密钥值单独走 `apiKey`**（它单独一行加密落库、永不回显）。
       即便当前策略不是 external 也一并回传地址，免得"切过去再切回来"把地址弄丢。 */
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
  /* 结构化词表与策略无关地一起保存（与落位规则表是两张独立的表）。
     输入框为空 = 不带该字段：服务端是**整体替换**配置，所以那就是"清空词表"。 */
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

/**
 * 保存签名服务配置：服务地址是这段配置的锚（地址留空 = 未配置签名服务，签章随之不可用）。
 *
 * 密钥三态与其它配置一致：**留空 = 不改**（界面拿不到原值）、
 * `apiKeyOverride === null` = 显式清除（「清除密钥」按钮）、填了 = 设新值。
 */
async function saveSignBackendFromForm(apiKeyOverride) {
  const body = {};
  /* 密钥值**单独提交**（它单独一行加密落库、永不回显），与字段映射那一堆分开 */
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

/**
 * 保存预问诊接入配置。
 *
 * `keyOverride` 三态与后端一致：`undefined` = 不改；`null` = 清除；字符串 = 设新值。
 * 传 `undefined` 时以输入框为准，而**空串表示"不改"** —— 若把空串当成"清空"，
 * 那么点一次"保存接入配置"就会把密钥悄悄删掉，而界面上看起来是保存成功了。
 */
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

/** 保存授权平台：公钥留空 = 不修改（不回显全文，也就无法通过留空把它"悄悄"清掉，清掉等于没有信任根） */
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

/** 导入外部平台的授权书：服务端做三道判定（形状 → 自洽 → 受信），界面只负责回报结论 */
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

/**
 * 测试签名：签一段与病历无关的文本，并把"能不能验、指纹对不对"报出来。
 *
 * 状态行由调用方给：配置页与「运行状态」页都要用它，而两处各写一份措辞，
 * 迟早会出现"这一页说通过、那一页说失败"这种没法查的分歧。
 */
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

/* ------------------------------ 数据流 ------------------------------ */

/**
 * 收下服务端下发的状态。
 *
 * 状态是**按身份投影**的（见 demo-server 的 `stateFor`）：管理端拿到 `scope: 'admin'`，
 * 其余身份拿到 `scope: 'doctor'` —— 后者不含 `templateCatalog` / `departments` 等
 * 管理端专用字段。会话失效时会出现"页面打得开、配置面板却一片空白"的局面，而空白
 * 与本页满地的 `S.x || {}` 兜底组合起来**不会报任何错**。所以这里显式判一次：
 * 拿到的不是管理端投影就说出来（该重新登录），而不是让人以为系统坏了。
 */
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

/** 保存后的统一收敛：state 随响应回来就直接用，省一次往返 */
async function apply(result) {
  if (result && result.state) {
    adoptState(result.state);
    renderModelPanel();
    return;
  }
  await refresh();
}

/* ------------------------------ 事件 ------------------------------ */

document.addEventListener('click', async (event) => {
  const el = event.target && event.target.closest ? event.target.closest('button') : null;

  /* 一级分区（按钮，非配置动作）：切过去并按需拉数据 */
  const view = event.target && event.target.closest ? event.target.closest('[data-admin-view]') : null;
  if (view) {
    const name = view.dataset.adminView;
    selectAdminView(name);
    await loadAdminView(name);
    return;
  }

  /* 模板库翻页：只翻这一页的表（目录已在 `S.templateCatalog` 里，翻页不产生任何请求）。
     页号只接**有效值**：上一页/下一页在首末页上是 disabled，走到这里的一定是能落的范围。 */
  if (el && el.dataset && el.dataset.tplPage) {
    const next = Number(el.dataset.tplPage);
    if (Number.isFinite(next) && next >= 1) {
      TPL_PAGE = next;
      renderTemplatePacks();
    }
    return;
  }

  /* 控件表格页翻页：同一套（只重画那一张表，翻页不产生任何请求） */
  if (el && el.dataset && el.dataset.exprPage) {
    const next = Number(el.dataset.exprPage);
    if (Number.isFinite(next) && next >= 1) {
      EXPR_PAGE = next;
      renderExprCatalog();
    }
    return;
  }

  /* 专科控件表格页翻页：同一套 */
  if (el && el.dataset && el.dataset.ctrlPage) {
    const next = Number(el.dataset.ctrlPage);
    if (Number.isFinite(next) && next >= 1) {
      CTRL_PAGE = next;
      renderCtrlCatalog();
    }
    return;
  }

  /* 动作审计翻页：同一套（只重画记录那一块，翻页不产生任何请求） */
  if (el && el.dataset && el.dataset.auditPage) {
    const next = Number(el.dataset.auditPage);
    if (Number.isFinite(next) && next >= 1) {
      AUDIT_PAGE = next;
      renderAuditEntries();
    }
    return;
  }

  /* 子页签（按钮，非配置动作） */
  const tab = event.target && event.target.closest ? event.target.closest('[data-cfg-tab]') : null;
  if (tab) {
    selectCfgPane(tab);
    /* 切到「判定方式」时按当前 state 重画一次：「谁在用它」要跟着规则库的变化走，
       而规则库里那几条是在别的页签上改的，这一页不会自己知道。 */
    if (tab.dataset.cfgTab === 'predicates') renderPredicates();
    /* 切到「表达式控件」同理：那张表读的是 `S.templateCatalog`，
       而控件可能是在别处（模板预览、另一台终端）改的 —— 每次切过来画一遍，
       代价只有一次 DOM 重绘，换来的是"这一页不显示旧数据"。 */
    if (tab.dataset.cfgTab === 'expressions') renderExprCatalog();
    /* 切到「专科控件」同理：那张表读的也是 `S.templateCatalog`，而控件可能是在别处改的 ——
       每次切过来画一遍，代价只有一次 DOM 重绘，换来的是"这一页不显示旧数据" */
    if (tab.dataset.cfgTab === 'ctrlDefs') renderCtrlCatalog();
    /* 预问诊接入同理：密钥可能刚在另一台终端上改过，切过来重画一次即可 */
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

  /* 新建一个表达式控件（按钮在「基础数据 → 表达式控件」页头）：公式构造器在**二级**抽屉里，
     从左侧滑入。控件表在页面上、表单从另一侧进来，那张表因此不会被顶掉 ——
     建完关掉表单，还看得见自己在表里的位置。 */
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

  /* 新建一个专科控件（按钮在「基础数据 → 专科控件」页头）：表单在**二级**抽屉里、
     从左侧滑入，页面上那张控件表因此不会被顶掉 —— 建完关掉这一层，还看得见自己的位置。 */
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

  /* 预览一个专科控件：按当前患者**试开一次**（不落库），看它在医生端长什么样。
     为什么值得跑一趟服务端而不是本地画：形状决定画法，而形状与格清单是服务端
     按定义算出来的（`model/control.ts`）—— 前端再拼一份就是第二份口径。 */
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

  /* 字段的增删与排序：都只改草稿，然后重画表单（草稿是唯一真相，DOM 只是它的投影） */
  if (el.dataset && (el.dataset.ctrlAddfield || el.dataset.ctrlFielddel || el.dataset.ctrlFieldup || el.dataset.ctrlFielddown)) {
    if (!CTRL_DRAFT) return;
    readCtrlForm();
    const fields = CTRL_DRAFT.fields;
    if (el.dataset.ctrlAddfield) {
      fields.push({ key: '', label: '', dataType: 'number' });
    } else if (el.dataset.ctrlFielddel !== undefined) {
      /* 删到最后一格要拦住：没有字段的控件是个空壳（内核那边同样校验不过） */
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

  /* 删一个专科控件。与表达式控件不同，这里不拦"还被谁引用"：文书的槽位今天还没有"控件"
     这一类，没有任何东西会引用它。但后果仍要说清 —— 已开出的病历带的是当时那份字段快照。 */
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
    /* 深拷贝：构造器是边搭边改的，直接改目录里那一份的话，"取消"就回不去了 */
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
    /* 改公式要问一次：它不是"改个标签"，而是换掉"这个数怎么算出来的" ——
       改名的后果只是换个称呼，不值得拦一次；改公式的后果要由人显式承担。 */
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
      /* 新建的那一个可能落在别的页上：页码先挪过去（只在"新建"时挪，改名字不换页） */
      if (r.ok && !editing && r.data && r.data.itemId) exprGotoItemPage(String(r.data.itemId));
      renderModelPanel();
    }
    if (r && r.ok) {
      TPL_EXPR_EDIT_ID = '';
      TPL_EXPR_BASELINE = '';
      /* 只关这张表单：页面上那张控件表还在，接着要建下一条不必重新切页签 */
      closeTplDrawer();
    }
    /* 成功了：抽屉已经收走，话说在页面上（此刻唯一看得见的地方）；
       失败了：抽屉还开着，话说在抽屉里 —— 写在背后那行等于没写。 */
    const exprMessage = r && r.ok
      ? editing
        ? `已保存控件「${name}」：${r.data && r.data.formula}${formulaChanged ? '（公式换了一版：已开出的病历不重算，下次重算时按新公式）' : ''}`
        : `已新建控件「${name}」（${r.data && r.data.itemId}）：${r.data && r.data.formula} —— 现在可以在文书的槽位里选它了`
      : `${editing ? '保存' : '新建'}失败：${(r && (r.message || r.code)) || '未知原因'}`;
    if (r && r.ok) setExprCatalogStatus(exprMessage);
    else setTplDrawerStatus(exprMessage);
    return;
  }

  /* 删一个控件：被文书引用时服务端会拒（并列出是哪些文书在用），这里先把后果说清 */
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
      /* 删掉的那一行要从表里消失：`renderModelPanel` 会顺路把控件表重画一遍 */
      renderModelPanel();
    }
    setExprCatalogStatus(r && r.ok
      ? `已删除控件「${item?.name ?? itemId}」`
      : `删除失败：${(r && (r.message || r.code)) || '未知原因'}`);
    return;
  }

  /* 函数的参数增删：参数个数按函数表的上下限来（界面不该长出引擎不认的节点） */
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

  /* 新建一份文书骨架（按钮在模板库页顶部）：表单在抽屉里 */
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

  /* 二级抽屉的关闭按钮：与一级同一套清理（它在 close 事件里），只是关的是左边那一层 */
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
      /* 显示名先从**字典**取（选项本来就来自它），取不到再退回模板目录 ——
         两处各写一份的话，同一次提交会出现两个口径 */
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
      /* 科室是勾选框（值就是编码）：一个都不勾 = 通用 */
      departments: tplPickedDepartments('tplNewDept'),
    });
    if (r && r.state) {
      S = r.state;
      /* 新建的那一份可能落在别的页上（目录按 packId + 添加顺序排）：先把页码挪到它那一页，
         再画表 —— 否则超过一页之后就是"建完了，列表里看不见它"（看着像没建成） */
      if (r.ok && r.data && r.data.itemId) tplGotoItemPage(String(r.data.itemId));
      renderModelPanel();
    }
    if (r && r.ok) closeTplDrawer();
    setTplPackStatus(r && r.ok
      ? `已新建「${name}」（${r.data && r.data.itemId}）：状态是<b>草稿</b> —— 医生端开不出它；定稿后在那一行点「发布」`
      : `新建失败：${(r && (r.message || r.code)) || '未知原因'}`);
    return;
  }

  /* 预览一份文书（按钮在模板表行尾）：读视图，不要求管理员会话之外的东西 ——
     它不写任何东西，只是把"医生点开会看到什么"摆出来 */
  if (el.dataset && el.dataset.tplPreview) {
    const [, itemId] = String(el.dataset.tplPreview).split('|');
    await openTplPreview(itemId);
    return;
  }

  /* 打开一份文书的编辑抽屉 */
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

  /* 章节 / 槽位的增删：先读回抽屉里此刻填的东西，改完重绘 ——
     不做"局部插入 DOM"，那会让"界面上看到的"与"待保存的"变成两份。
     这些按钮只在抽屉里出现，所以正在改的就是 `TPL_DRAWER_ITEM` 那一份。 */
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
  /* 表格的列：加一列 / 删一列。与"加一个槽位"同一条界线 —— 列定义是**骨架**，只有草稿能改。
     删到最后一列时不留空：空 columns 过不了校验，而这个动作的目的也不是"造一份存不下去的模板"，
     所以直接拦住并说明（比让它存的时候报错更早一步）。 */
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
  /* 列表的项：加一项 / 删一项。与表格的列同一条界线 —— 项与有序性都是**骨架**。
     删到最后一项时不留空：空 items 过不了校验，而这个动作的目的也不是"造一份存不下去的模板"。 */
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

  /* 排序：章节与槽位的**上移 / 下移**（拖动见下面那一段 document 级的拖放委托）。
     顺序**不是包里的一个字段**，而是数组顺序 —— 引擎按这个顺序生成章节节点、
     `order = 序号 × 10`。所以"排序"就是把两个元素换个位置：
     不改数据结构、不改包格式、不动内核。与增删同一条界线：只有草稿能改。 */
  if (el.dataset && el.dataset.tplSecMove) {
    const item = tplItemOf(TPL_DRAWER_ITEM);
    if (!item) return;
    const [, indexText, deltaText] = String(el.dataset.tplSecMove).split('|');
    const form = readTplEditForm();
    const from = Number(indexText);
    const delta = Number(deltaText);
    if (!tplMove(form.sections, from, delta)) return;
    renderTplEditForm(tplFormStateOf(item, form));
    /* 状态行写在**抽屉里**（不是背后那块面板）：这个动作不关抽屉 */
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

  /* 把一章**存成一个片段**：以后别的文书可以一次插这一章。
     它读的是抽屉里此刻显示的那一章，**不改这份文书** —— 所以已发布的文书也能存。
     服务端会把它存进本院自建包，并把这一章用到的表达式控件一起带过去。 */
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
      /* 重画抽屉：下拉里要立刻多出这一段 —— 否则人的判断是"没存上"，然后再存一遍 */
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

  /* 插入片段：**追加到末尾**（工具条上的按钮）或**插到某一章之后**（章标题旁的按钮）。
     插进来的是**副本**：之后它与那段片段再无联系（与"改模板不影响已开出的病历"同一条纪律 ——
     下游不能被上游悄悄改掉）。代价是片段内容更新后要重新插一次，这句话写在界面上。 */
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
    /* 控件引用要**先核对再插入**：模板包里 `useExpression` 只允许同包引用，
       而这一段可能来自别的包（比如从交付方的那份文书里存下来的）。
       放进去的话，报错要等到保存时才以"模板里引用了控件库里没有的控件"出现 —— 而那条消息
       完全指不到"因为你刚插了一段从别处存下来的片段"。 */
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

  /* 复制一份文书：**从已有模板复制**（而不是从零拼）。
     副本落进本院自建包、且**恒为草稿**：复制多半是为了改它，让它当场可开，
     就会有人照着它开出结构残缺的病历（与新建文书同一条理由）。 */
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
      /* 建完**直接把副本的编辑抽屉打开**：复制出来就是为了改它，
         让人再去表里翻一遍那一行纯属多此一举 */
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

  /* ---- 片段目录：编辑 / 删除 / 保存 ---- */
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
      /* 说明清空 = 删掉这一项（服务端按空串处理），而不是留一句空的说明 */
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

  /* 保存一份文书：名称 / 适用科室随时可改，**章节与槽位只有草稿能改**。
     它**不是"改个标签"**：这些字段写在包内容里，改了就是换一版内容 ——
     服务端走 `writePack()`，内容指纹会变、前后指纹进系统审计、条目开关保留。
     **状态行不摆指纹**：那一串十六进制没人能对着它做决定，它该待的地方是
     「审计与安全」（前后指纹都记着）与「规则库 / 模板库」顶部那一对指纹，而不是刚点完保存的那一行。 */
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
      /* 科室交**编码数组**（勾选框的值就是编码）：服务端会核对它是否在字典里，
         一个对不上任何人的编码会让这份文书谁都开不出，所以那条校验不能省 */
      departments: form.departments,
    };
    /* 取不到库里那一条：抽屉开着的时候它被别处删掉了（或状态没刷新到）。
       此时**不能猜**它是不是草稿：猜成"非草稿"就会走槽位元数据那条路，
       而人在这上面做的骨架改动（增删章节与槽位 / 改槽位名 / 改类别）会被静默丢掉 ——
       只有槽位名没变的那几格会悄悄存下去，看起来还像是成功了。宁可让他关掉重开一次。 */
    if (!item) {
      setTplPackStatus('这份文书在库里找不到了（可能已在别处删除）：关掉抽屉重新打开一次再存');
      return;
    }
    /* 草稿：整份骨架一起交上去（章节与槽位的增删只有它允许）。
       已发布：骨架交上去会被服务端拒（它可能已经开出过病历），但**槽位元数据**照改 ——
       显示名 / 从系统带入 / 必填 / 单位在开文书那一刻才起作用，不进任何已开出的病历
       （见内核的 `SlotMetaPatch`）。 */
    if (item.status === 'draft') payload.sections = form.sections;
    else {
      payload.slotMeta = slotMetaOf(form.sections);
      /* 章节属性（必备 / 整章算关键内容 / 说明）同样**已发布也能改**：它们在开文书那一刻
         才被抄进章节节点，之后与模板再无联系，不进任何已开出的病历 ——
         而"哪几章算必备"恰恰是上线后随着质控反馈反复调的东西（见 `sectionMetaOf`）。 */
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

  /* 发布 / 撤稿：状态是"这份文书定稿了没有"，与"本院开不开它"（开关）是两件事。
     发布才让它可被开具；撤稿则**立刻**开不出 —— 所以撤稿要问一次。 */
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

  /* 删除一份文书：包里少一条内容，已开出的病历不受影响（它们只带着模板指纹）。
     即便如此也要问一次 —— 删掉的是"本院自己维护的内容"，没有撤销。 */
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

  /* 「新建规则」按钮：打开新建抽屉（字段与编辑同一屏，只是规则号由服务端按序号生成） */
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

  /* -------- 自定义条件构造器：加一条 / 删一条 --------
     两件事都"先读回草稿、再重画"：直接重画会把上面几条刚填的值清掉。
     （它们与"打开编辑抽屉"是两件事，所以摆在它前面，读起来才不会像抽屉的一个分支。） */

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

  /* 打开一条规则的编辑抽屉（按钮在规则表行尾）。
     抽屉里的每一格都**读自库里那一条**：编辑是一条"读回 → 改 → 写回"的回路，
     读不全就等于写不全（少回显一个字段，那一次保存就会把它静默清掉）。 */
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

  /* 规则表翻页：纯前端，只重画这一页的表（不重新拉目录，也不产生请求） */
  if (el.dataset && el.dataset.rulePage) {
    RULE_PAGE = Number(el.dataset.rulePage) || 1;
    renderRuleTable(Array.isArray(((S || {}).knowledgePacks || {}).rules) ? S.knowledgePacks.rules : []);
    return;
  }

  /* 保存 / 新建一条规则：两条路走的是**同一个表单**，只是提交到不同的接口。
     新建落进去是**停用**的（服务端把这一条写进库里的 `disabled` 列，不写进包内容）——
     判定标准不该随保存悄悄上线。 */
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
    /* 「引用判定方式」与「就地拼一条」**两选一**，服务端对这一条有硬校验。
       界面现在只渲染其中一套格子（选了下拉就换掉整块参数区），所以这一格拦不到正常情况下的人 ——
       留着它是因为"两格同时出现"意味着表单结构被改坏了，那时宁可拦住，也不要把一条两处口径的规则写进库。 */
    if (form.params.conditionId !== undefined && form.params.when !== undefined) {
      setQcPackStatus('判定方式是「引用一条判定方式」与「就地拼一条」两选一：请把其中一格留空');
      return;
    }
    /* "就地拼一条"的两道前置拦：都是为了不让"保存成功、却什么也判不了"发生。
       服务端同样会拒（参数必填且必须合法），这里先拦一次只是为了少一次往返。 */
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
    /* 取不到库里那一条：抽屉开着的时候它被别处删掉了（或状态没刷新到）。
       此时**不猜**它还在不在 —— 猜错的代价是把这次改动写到一个不存在的条目上。 */
    if (!isCreate && !current) {
      setQcPackStatus('这条规则在库里找不到了（可能已在别处删除）：关掉抽屉重新打开一次再存');
      return;
    }
    const payload = {
      title,
      severity: form.severity,
      /* 判定方式与参数一起交：换判定方式时参数必须整套换（每个谓词收的参数不同），
         留空的参数**不出现在这里**（空串会过不了校验，而"不填"是包本来就有的一档） */
      predicate: { kind: form.kind, params: form.params },
      detail: form.detail,
      suggestion: form.suggestion,
    };
    const r = isCreate
      ? await api('/api/rule-item-create', payload)
      : await api('/api/rule-item-update', { packId: current.packId, itemId: current.itemId, ...payload });
    if (r && r.state) {
      S = r.state;
      /* 新建的那一条可能落在别的页上（目录按 packId + 添加顺序排）：先把页码挪过去再画表 ——
         否则超过一页之后就是"建完了、列表里看不见它"（看着像没建成） */
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

  /* 删除一条规则：包里少一条内容。已有病历不受影响（质控提示是旁挂注解，仍读得出来），
     即便如此也要问一次 —— 删掉的是"本院自己维护的内容"，没有撤销。 */
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

  /* 包条目开关（规则条目与模板条目走的是同一个接口）：部署策略，要管理员身份，服务端也会拒。
     它不改动任何病历，所以不落"文档留痕"，只写系统级审计。
     状态行按条目所在页给：在「模板」页点的开关，回话要出现在那一页，
     否则"点了、这页一点反应没有"，而话其实写在另一个页签的状态行里。 */
  if (el.dataset && el.dataset.packToggle) {
    if (!(await requireSession())) return;
    const [packId, itemId] = String(el.dataset.packToggle).split('|');
    const enabled = el.dataset.packEnabled !== '1';
    /* 回话必须落在**条目所在的那一页**：写在别的页签上等于写在看不见的地方，
       而"点了没反应"会让人再点一次。目录（`templateCatalog`）里查得到的就是四类：
       模板 / 片段 → 模板库；表达式控件 → 基础数据·表达式控件；专科控件 → 基础数据·专科控件。
       查不到的（规则条目）走规则库那一行。 */
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
      /* 表达式控件那张表里的开关同理：这一行要跟着换字（停用 / 启用），否则看起来像没生效 ——
         `renderModelPanel` 里那一遍刷新负责它 */
      renderModelPanel();
    }
    status(r && r.ok
      ? `已${enabled ? '启用' : '停用'} ${itemId}；生效指纹 ${((S || {}).knowledgePacks || {}).effectiveFingerprint || '—'}`
      : `未能修改开关：${(r && (r.message || r.code)) || '未知原因'}`);
    return;
  }

  /* 需要登录的动作统一在这一处拦：服务端也会拒，但那时使用者看到的是
     "点了、什么也没变"，而报错小字在别处；这里把话说在动作发生之前。 */
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
    /* 危险操作二次确认（同模型密钥）：清掉之后 ASR 若需要 token 会立刻 401，
       而按钮就在「保存」旁边，选错一次的代价是"采集突然全失败"。 */
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
    /* 危险操作二次确认：清除后回到内置演示种子，而"拿得到代码的人也能重签锚点"这条边界随之成立 */
    if (!(await askConfirm(
      '确定清除自定义的锚点签名种子？\n\n清除后改用内置演示种子：任何拿得到本仓库代码的人都能重签锚点（此操作没有撤销）。',
      { okLabel: '清除', tone: 'danger' },
    ))) return;
    await saveSystemPolicyFromForm(null);
    return;
  }
  if (el.id === 'cfgWorkspaceReset') {
    /* 这个按钮的代价与"清除某个密钥"不是一个量级：它擦掉的是全部病历与留痕。
       所以确认框按"会清什么 / 不会动什么 / 还有一个后果"三段写 ——
       只问一句"确定要重置吗"，等于让人凭想象决定。
       不会动的那一段是**有意的**：重置之后最该查得到的，恰恰是"谁在什么时候清空了这台机器"
       （管理审计跨重置留存，见服务端 `/api/reset` 那段的原因说明）。 */
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
      /* 重置会换掉整棵树：state 随响应回来，走统一的收敛路径（`apply`），
         否则界面还挂着已经不存在的病历 —— 那看起来像"清空了但没生效"。 */
      await apply(r);
      const tree = Array.isArray(r.state && r.state.tree) ? r.state.tree : [];
      const docs = tree.reduce((sum, patient) => sum + (Array.isArray(patient.visits) ? patient.visits : [])
        .reduce((count, visit) => count + (Array.isArray(visit.docs) ? visit.docs.length : 0), 0), 0);
      setWorkspaceResetStatus(`已清空并复位：现在库里有 ${tree.length} 位患者 / ${docs} 份病历（医生端请刷新页面）`);
    } else {
      setWorkspaceResetStatus(`未能清空：${(r && (r.message || r.code)) || '未知原因'}`);
      /* 会话可能刚好失效（进程重启 / 口令被换）：与系统策略那条一样，失败后回问一次会话 */
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
    /* 在「运行状态」页测一次：结果写进这一页的状态行；测完重新拉一次留档，
       让"最近一次 + 计数"立刻跟上（否则要手动刷新才看得到刚测的结果） */
    await runSignTest($('healthSignStatus'));
    await loadAdminView('health');
    return;
  }
  if (el.id === 'auditRefresh') { await loadAdminView('audit'); return; }
  if (el.id === 'acctRefresh') { await loadAdminView('accounts'); return; }

  /* -------- 基础数据：科室字典 -------- */

  if (el.id === 'deptRefresh') { await loadAdminView('master'); return; }

  /* -------- 基础数据：表达式控件 -------- */

  /* 与科室 / 文书类型那两个刷新不同：控件的目录不在一份独立接口里，它是 `state.templateCatalog`
     的一部分（跟着 `/api/state` 下发），所以这里要重取整份 state，而不是 master 那两条字典接口。 */
  if (el.id === 'exprCatalogRefresh') { await refresh(); return; }

  /* 专科控件的目录同样是 `state.templateCatalog` 的一部分（`itemType === 'control'` 的那些），
     所以这里与上面那条一样要重取整份 state，而不是 master 那两条字典接口。 */
  if (el.id === 'ctrlCatalogRefresh') { await refresh(); return; }

  /* -------- 基础数据：判定方式（只读清单） -------- */

  /* 与另外两个刷新按钮同一条路径：判定方式本身不用拉，但"谁在用它"要跟着规则库走，
     而规则库是在别的页签上改的 —— 这里顺路一起重画，省掉一次"为什么数字是旧的"的疑问 */
  if (el.id === 'conditionLibRefresh') { await loadAdminView('master'); return; }

  /* -------- 基础数据：判定方式（具名条件，库级资产） -------- */

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

  /* 参数表：加一格。（**先读回再重画** —— 与条件构造器同一条纪律：
     不读回的话，点一下"加一个参数"就把刚才填好的那几格清掉了。） */
  if (el.dataset && el.dataset.condParamAdd) {
    const params = readConditionParams($('condParamsBox'));
    params.push({ name: '', kind: 'integer', label: '', doc: '' });
    const box = $('condParamsBox');
    if (box) box.innerHTML = conditionParamRowsHtml(params);
    return;
  }
  /* 参数表：删一格。**只从 DOM 里摘掉那一行**，不重画 —— 重画要先把别的行读回来，
     而"删一行"这件事本身不需要改动其它任何一格 */
  if (el.dataset && el.dataset.condParamDel) {
    const row = el.closest ? el.closest('[data-cond-param-row]') : null;
    if (row && row.parentElement) row.parentElement.removeChild(row);
    return;
  }

  /* 复制一条判定方式：以它当模板开一张新建表单（新编码，两条从此互不影响）。
     主要用途是"改口径之前先留一份原样" —— 判定方式是库级资产，复制不是为了换包。 */
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
      /* 点击与目录之间可能已经错开（别处刚删了它）：**不猜**它还在不在 */
      setConditionLibStatus('这条判定方式在库里找不到了（可能已在别处删除）：刷新这一页再看');
      return;
    }
    renderConditionEditForm(item);
    return;
  }

  /* 保存 / 新建一条条件：两条路走同一个表单，服务端是两条路径 ——
     改一条条件会让**所有引用它的规则一起变**，审计里那句话必须一眼分得出"动的是共用资产"。 */
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
      /* 参数表一并交上去：**空数组 = 这条判定方式不带参数**（服务端会删掉这个字段，
         与缺省等价）。不与条件树绑在一起提交 —— 参数表可以单独改，那是一次普通保存。 */
      params: form.params,
      /* 树里有嵌套时不交 `when`（构造器只拼平铺的条件，交上去就是把它摊平）：
         服务端 `patchCondition` 的语义正是"不给这一格就不动它" */
      ...(form.conditionLocked ? {} : { when: form.when }),
    };
    const r = isCreate
      ? await api('/api/qc-condition-create', payload)
      : await api('/api/qc-condition-update', { itemId: CONDITION_DRAWER_ITEM, ...payload });
    const users = (r && r.data && Array.isArray(r.data.usedBy)) ? r.data.usedBy : [];
    if (r && r.state) {
      S = r.state;
      renderPredicates();
      /* 规则库那张表也要跟上：引用这条条件的规则，那一列显示的是服务端算好的条件读法 */
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

  /* 删一条条件：**被规则引用时先拦在这里**（判据与删除保护读的是同一份 `usedBy`），
     否则人只会看到"点了删除、它还在" —— 而原因写在服务端那句话里，不在这里。
     判定方式是库级资产，所以引用面是**跨包**的：列出来的规则要带上它在哪个包。 */
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

  /* -------- 基础数据：文书类型（与科室字典同一套动作） -------- */

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
      /* 类型字典变了，「新建文书」的类型下拉要跟着变（它读的是这一份） */
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

  /* -------- 账号管理：一处出口、五个动作 -------- */

  if (el.id === 'acctCreate') {
    const username = $('acctNewName').value.trim();
    const password = $('acctNewPassword').value;
    /* 口令无论成败都立刻清空：成功时它已经进了库（留着只是多一份副本在浏览器内存里），
       失败时留着会让人以为"再点一次就行"，而失败原因多半是账号名不合规或口令太短。 */
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
  /* 列表行上的「重设口令」：只回填账号名，不弹输入框，
     口令在一处输入、一处提交，比"行内弹窗 + 顶上一个表单"两条路更不容易填错地方。
     属性名叫 `data-acct-reset` 而不是 `...passwd`：后者会让 "硬编码口令" 那条排查规则
     把 `${name}` 这个模板占位符当成一个口令值报出来（实测发现），用一个准确的属性名
     比往复核记录里加一条"这不是口令"更省事，也更不容易在下次改这里时被重新踩一遍。 */
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
    /* 删除不可撤销（没有回收站，也没有"撤销删除"），所以问两件事：删谁、以及他知道这是永久的 */
    if (!(await askConfirm(
      `删除账号「${username}」？\n\n账号与口令哈希都会从数据库里删掉，没有撤销。\n如果他将来还要用，请改用「停用」。`,
      { okLabel: '删除', tone: 'danger' },
    ))) return;
    await accountAction('/api/admin/users/remove', { username }, setAcctStatus, `已删除「${username}」`);
    return;
  }
  if (el.id === 'cfgTest') {
    /* 测试连接只发一段与病历无关的测试文本：为了验证"配得对不对"而先把病历送出去，是本末倒置 */
    setCfgStatus('测试中…（只发一段与病历无关的测试文本）');
    const r = await api('/api/model-config/test', {});
    setCfgStatus(r.ok
      ? `连接正常：${r.data.modelId}，耗时 ${r.data.latencyMs}ms`
      : `连接失败：${(r && (r.message || r.code)) || '未知原因'}`);
    return;
  }
  if (el.dataset.rkRemove) { await apply(await api('/api/recipient-keys/remove', { keyId: el.dataset.rkRemove })); return; }
  if (el.dataset.rkExport) {
    /* 导出只做展示（回填到输入框，便于复制给对方）；服务端始终只存 base64 */
    const key = (S.recipientKeys && S.recipientKeys.keys ? S.recipientKeys.keys : []).find((item) => item.keyId === el.dataset.rkExport);
    if (key) $('rkText').value = pemFromBase64(key.spkiBase64);
  }
});

/* 策略一变就同步规则表的可用性（禁用而不是隐藏） */
document.addEventListener('change', async (event) => {
  const el = event.target;
  /* 规则库：换"判定方式"就重画参数区（每一格的说明与控件都跟着换）。
     只重画参数区，不动其它输入 —— 重画整屏会把刚填的标题与文案一起清掉。 */
  if (el && el.dataset && el.dataset.ruleInput === 'conditionId') {
    renderRuleConditionSwitch(String(el.value || ''));
    return;
  }
  /* 自定义条件：换字段 → 能用的算子跟着换；换算子 → 取值那一格的控件跟着换。
     两者都要整块重画（草稿先从 DOM 读回来，已填的内容不丢）；
     换"条件之间的关系"只影响那一格，但一并重画最省事，代价也只是重画一次。
     重画的是**这一格所属的那个构造器**（规则抽屉里一个、条件库抽屉里一个）。 */
  if (el && el.dataset && (el.dataset.condField !== undefined || el.dataset.condOp !== undefined || el.dataset.condLogic !== undefined)) {
    refreshConditionBlock(el.closest ? el.closest('.cond-builder') : null);
    return;
  }
  if (el && el.id === 'cfgPlaceStrategy') { syncPlacementTerms(el.value); return; }
  /* 换识别服务：**只重渲染这一块**（警告块、凭据格、协议说明都跟着这一家变）。
     刻意不自动填地址：地址是"音频发去哪"的答案，让人自己确认过再填，
     比"我帮你换了一台服务器"安全 —— 何况换厂商本来就要重新核对一遍音频去哪儿了。 */
  if (el && el.id === 'cfgCaptureKind') { applyCaptureVendorUi(el.value); syncCaptureKindHint(el.value); return; }
  /* 改角色：先确认再提交，它会立刻吊销那个人的会话（正在写病历的医生会突然掉线），
     而"选错了再选回来"看起来和"没改过"一模一样，事后只能靠审计才分得出 */
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
  /* 槽位**类别**一改，这一格要填的东西就换了（填写项要类型与单位，表达式控件要选控件）：
     读回界面上此刻的状态，按新类别重绘抽屉里的表单 */
  if (el && el.dataset && String(el.dataset.tplInput || '').startsWith('slot:kind:')) {
    /* 这类下拉只在抽屉里出现，正在改的就是 `TPL_DRAWER_ITEM` 那一份 */
    const item = tplItemOf(TPL_DRAWER_ITEM);
    if (!item) return;
    renderTplEditForm(tplFormStateOf(item, readTplEditForm()));
    return;
  }
  /* -------- 表达式构造器：换类别 / 换函数 / 换系统字段 --------
     这三件事都要**重绘整棵树**（换类别会换掉这一格下面的一切），
     而数字与填写项 key 的输入不重绘（见下面的 input 委托：重绘会让人打一个字就丢焦点） */
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
      /* 换函数时参数个数要跟着函数表走：少了补数字，多了截掉 ——
         否则界面上会留下"这个函数不认的第 3 个参数"，而引擎那边的校验才会报错 */
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

/* （"回车即登录"那段搬去了登录页：那边用 `<form>` 提交，回车天然可用） */

/* 页面能打开，就说明服务端已经确认过会话（未登录会被 302 到 /login）。
   这里再问一次只为拿到"当前是谁"，随后加载数据，若这中间会话刚好失效，
   服务端会返回失败，于是直接送回登录页，而不是留一个"看起来已登录"的空壳。 */
(async () => {
  setConfigReady(false);
  /* 抽屉的关闭清理（滚动锁 / 清空 / 焦点归还）绑在这里：Esc 关的与点按钮关的都走同一处。
     「规则库」那个抽屉同理 —— 它只开一层，所以只有一处要绑。 */
  bindTplDrawerOnce();
  bindRuleDrawerOnce();
  bindConditionDrawerOnce();
  const r = await api('/api/admin/session');
  if (r.ok) {
    /* 角色要一起收下来：`GET /api/admin/session` 已经给出它（服务端按会话判定的角色），
       丢掉它就只剩"已登录"，而"以什么身份登录"才是决定能改什么的那一半。 */
    session = { adminId: r.adminId, actorId: r.actorId, role: r.role, roleLabel: r.roleLabel, env: r.env };
    renderSession();
  } else {
    toLogin();
    return;
  }
  await refresh();
  /* refresh 失败时会自己往这条状态行写原因，那种情况下既不该清掉它，也不该放开按钮 */
  const loaded = Boolean(S && S.model);
  setConfigReady(loaded);
  if (loaded) setLoginStatus('');
})();
