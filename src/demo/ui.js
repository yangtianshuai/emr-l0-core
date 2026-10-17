/**
 * 电子病历编辑器 · Demo 界面脚本（从 ui.html 拆出）。
 *
 * 与 ui-self-test 锁定的交互纪律保持一致（改这里前先读测试）：
 *   · 脏值追踪：input 只记脏值，失焦延迟 250ms 保存；任何按钮动作先取消防抖并统一 flush
 *     （否则保存重绘会替换掉被点的按钮，click 到不了按钮）
 *   · 输入态（textarea/input/select）一律不拦单键；不可逆操作（拒绝/忽略）二次确认
 *   · 页签状态与折叠树持久化；内部标识按 演示/临床 模式条件渲染（不是渲染后隐藏）
 *   · 配置抽屉用 <dialog>.showModal()（top layer），关闭后焦点还给触发按钮
 *   · 宿主接入点**只有一个**（见下方 `hostBridge` / `api`）：只注入 identity / context /
 *     transport 三件事，且**不得出现任何写语义** —— 留痕、门控、签章都属内核
 */
const $ = (id) => document.getElementById(id);
let S = null;
/* 脏值追踪：先记录编辑、延迟保存（见文件头说明）。 */
const pendingEdits = new Map();
let blurTimer = null;
const TAB_KEY = 'l0demo.activeTab';

/**
 * 视图模式：演示 / 临床。
 *
 * 演示要透明（把 `sg_0003`、`rev 12`、`E_AI_LOW_CONFIDENCE` 都摆出来，让人看见门控与留痕真的在起作用）；
 * 临床要安静（医生不需要看内部标识）。技术信息不会消失，仍完整保留在「门控日志」与「指标与留痕」里。
 *
 * 实现上按模式条件渲染（`isClinical() ? '' : …`），而不是渲染后再用 CSS 藏，
 * 后者会把内容留在 DOM 里，复制、读屏、审查时仍会出现。
 */
const MODE_KEY = 'l0demo.viewMode';
let viewMode = (() => {
  try { return localStorage.getItem(MODE_KEY) === 'clinical' ? 'clinical' : 'demo'; } catch { return 'demo'; }
})();

function isClinical() { return viewMode === 'clinical'; }

/* --------------------------- 编辑范式（卡片 / 流式） ---------------------------
 *
 * 与上面的 `viewMode` 是**两个正交维度**，所以是两个开关、不是同一个控件里的两档：
 *   · `viewMode` 管"显示多少内部标识"（演示 / 临床）；
 *   · `editMode` 管"怎么落笔"（卡片 = 一段一张卡片；流式 = 整页连续书写）。
 * 合成一个控件的后果是"我到底在切什么"说不清 —— 而这两个问题的答案是互不替代的。
 *
 * 两者都只是**视图偏好**：不改数据、不改 rev、不进留痕，因此存在 localStorage 即可。
 * 换台机器、换个浏览器打开，看到的编辑方式可能不同，但病历是同一份。
 *
 * 住处与形态都不同：`viewMode` 在顶栏、就是一个下拉（它管整页）；
 * `editMode` 在正文卡的标题行右侧，是分段控件（它管的就是下面那一片纸，
 * 而"现在在哪个"得一眼看见）。位置与形态不表达从属关系，只表达"它作用在哪"。
 */
const EDIT_MODE_KEY = 'l0demo.editMode';
let editMode = (() => {
  try { return localStorage.getItem(EDIT_MODE_KEY) === 'flow' ? 'flow' : 'card'; } catch { return 'card'; }
})();

function isFlow() { return editMode === 'flow'; }

/* ---------------------------- 主题（深 / 浅） ----------------------------
   手动选择持久化；未选择时尊重系统偏好。CSS 只认 data-theme 令牌组。 */
const THEME_KEY = 'l0demo.theme';
let theme = (() => {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch { /* 隐私模式忽略 */ }
  try { return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; }
  catch { return 'light'; }
})();
function applyTheme() {
  document.documentElement.dataset.theme = theme;
  const button = $('btnTheme');
  if (button) button.textContent = theme === 'dark' ? '☀' : '◐';
}
applyTheme();

function markDirty(kind, id, value) {
  pendingEdits.set(kind + ':' + id, { kind, id, value });
}

function isEditor(el) {
  return !!(el && el.dataset && (el.dataset.edit || el.dataset.field || el.dataset.controlField));
}

/* 全局进行中指示：任何请求期间显示顶栏下方的细条，
   "有没有在跑"必须一眼可见，否则医生会重复点（不知道有没有生效）。 */
let inflight = 0;

/* --------------------------- 宿主接入点（唯一） ---------------------------
   医生端要能被嵌进医生工作站，"请求怎么发出去"就必须可被宿主替换。本文件只从下面
   这一个对象取外部能力 —— 与采集那条纪律同源：`captureClientOf()` 的地址与一次性
   令牌同样来自外部注入，页面不写死任何地址（A21/A22 把它们钉成了机器证明）。

   三条纪律（改这里之前先读 ui-self-test 的注入面断言）：
     · **只注入三件事**：identity（身份）、context（患者与文书寻址）、transport（传输）；
     · **不得出现任何写语义**（saveDocument / writeRevision / sign / accept…）：留痕、
       门控与签章都属内核，注入一个"保存文档"等于把内核的三条不变量搬到宿主侧重实现；
     · **注入缺失时行为不变**：仍走同源 fetch（本仓库独立运行的形态）。

   惰性读取而不是加载时快照：脚本是 defer，宿主注入的时机由宿主决定，
   "谁先谁后"不该成为一张必须遵守的时序表。 */
function hostBridge() {
  return (typeof window === 'undefined' ? null : window.__L0_HOST__) || null;
}

/** 默认传输：同源 fetch。宿主未注入时的行为与引入注入点之前逐字节一致 */
async function sameOriginFetch(path, body) {
  const res = await fetch(path, body === undefined
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

/* --------------------------- 会话：本页不碰 ---------------------------
   医生端既不登录、也没有任何"按身份置灰"的按钮（原先只有「重置」一个），
   所以本页**不再请求 `/api/session`**：少一次启动请求，也少一处会撒谎的界面状态。
   身份仍由服务端会话决定（写入留痕的 `writeActor` 读它）：要登录、要看身份，
   都在管理后台（`/admin` → `/login`，与这里共用同一个会话）。
   若以后重新往本页加"只有某人能做"的按钮，就照旧从 `/api/session` 的
   `actions` 取判定结果（服务端 `guard` 才是唯一拦点），别在前端自己推。 */

function esc(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------------------------- 页签状态（记忆） ---------------------------- */

const TABS = ['ai', 'voice', 'qc', 'timeline', 'compare', 'previsit', 'discharge', 'machine', 'export', 'log', 'metrics'];
/**
 * 低频页签：**装得下就摆在条子里，装不下才收进「⋯」菜单**（见 `layoutRailTabs()`）。
 * 无论摆在哪，"收起 ≠ 删除"这条底线不变：它们随时可打开、可切换、可高亮。
 *
 * 五个高频入口（顺序即使用频次）：AI 助手 → 语音转写 → 质控提示 → 时间轴 → 机读信息；
 * 时间轴紧跟质控提示：它们回答的是同一件事的两个形态 —— 前者逐条说"哪里可能有问题"，
 * 后者说"这条线断在哪"（缺口是线上的事，逐条提示看不见它）。
 * 定稿是"写完之后"的动作，门控日志与指标留痕是排查/审计时看的，三者排在最后。
 *
 * 配置管理（`model`）不在这里：它不是页签，而是顶栏按钮打开的抽屉浮层。
 */
const OPTIONAL_TABS = ['compare', 'previsit', 'discharge', 'export', 'log', 'metrics'];
let activeTab = (() => {
  try { return localStorage.getItem(TAB_KEY) || 'ai'; } catch { return 'ai'; }
})();
if (!TABS.includes(activeTab)) activeTab = 'ai';

/** 「⋯」菜单：装不下的页签收在这里（见 `layoutRailTabs()`），点开可切换 */
function setMoreMenu(open) {
  const menu = $('moreMenu');
  if (!menu) return;
  const more = $('btnMoreTabs');
  /* 纵向对齐到「⋯」那一行：条子是与面板等高的一整列，用 CSS 钉 `bottom` 会把它
     甩到条子底部（离按钮几百像素）。`offsetTop` 与菜单同为"相对条子的内边距盒"，
     所以直接对齐即可。 */
  if (open && more) {
    menu.style.top = `${Math.round(more.offsetTop)}px`;
    menu.style.bottom = 'auto';
  }
  menu.hidden = !open;
  if (more) more.setAttribute('aria-expanded', String(open));
  syncMoreButton();
}

/**
 * 图标按钮的高亮：菜单开着，或当前面板就在菜单里时亮起。
 * 后半条是关键：页签栏里已经没有"定稿"的位置了，若按钮不亮，
 * 用户停在定稿面板时界面上没有任何地方显示"你在哪一栏"。
 */
function syncMoreButton() {
  const button = $('btnMoreTabs');
  const menu = $('moreMenu');
  if (!button || !menu) return;
  button.classList.toggle('active', !menu.hidden || OPTIONAL_TABS.includes(activeTab));
  /* 菜单里装着门控日志：有被拒记录时图标必须报警（否则"日志收进菜单"
     就等于"被拒原因看不见"，那是功能倒退，不是紧凑） */
  const log = S && Array.isArray(S.log) ? S.log : [];
  const hasReject = log.some((item) => item.ok === false);
  button.classList.toggle('alert', hasReject);
  button.title = hasReject ? '更多页签（门控日志里有被拒记录）' : '装不下的页签收在这里（点开可切换）';
}

/**
 * 右栏菜单装满：**全部页签**按使用频次摆进竖排条子，只有高度真的不够时才把末尾几项
 * 收进「⋯」。
 *
 * 为什么不再固定"低频三项一律收进菜单"：竖排之后每个标签都拿到整条宽度、图标与全称
 * 上下叠放，八项加起来还不到视口的一半（见 .col.rail .tabbar）。此时再藏三项，只是
 * 让人多点一次 —— 而那三项里恰恰有"定稿"这种写完之后一定要走的动作。
 * 而"收起 ≠ 删除"这条底线不变：**放不下的**项仍旧进菜单，随时可打开。
 *
 * 量的对象是每个菜单项的实际下沿 vs 条子内底，不读 `scrollHeight`：条子上不能写
 * `overflow: hidden`（菜单是从条子左侧弹出去的浮层，会被一起裁掉），
 * 于是"有没有越界"只能按坐标自己算。
 */
function layoutRailTabs() {
  const bar = $('tabbar');
  const menu = $('moreMenu');
  const more = $('btnMoreTabs');
  /* 没有「⋯」就没有收容入口（能力开关把所有带 `data-capability` 的项摘光时，
     按钮会连同空菜单一起被摘掉）：那就一项都不收，宁可让条子自然溢出，
     也不能把页签搬进一个打不开的菜单里 */
  if (!bar || !menu || !more) return;
  /* ① 全部摆进条子，顺序按 TABS（使用频次）。菜单项本来就是页签，只是先在标记里住在菜单 */
  for (const key of TABS) {
    const tab = bar.querySelector(`[data-tab="${key}"]`) || menu.querySelector(`[data-tab="${key}"]`);
    if (tab) bar.insertBefore(tab, more);
  }
  /* ② 从末尾往回收，直到最后一项不再越出条子内底。
     先让「⋯」占上它那一行再量：它是溢出入口，不占位置就量不准 */
  more.hidden = false;
  const innerBottom = () => {
    const rect = bar.getBoundingClientRect();
    return rect.bottom - parseFloat(getComputedStyle(bar).paddingBottom || '0');
  };
  for (let guard = TABS.length + 1; guard > 0; guard -= 1) {
    /* 只数条子的**直接子项**：菜单本身也是条子的子节点，`querySelectorAll('.tab')`
       会连菜单里的项一起数到 —— 那第一轮就会把刚收进去的项当成"最后一行"，
       于是永远只收得掉一项（实测撞到）。 */
    const rows = [...bar.children].filter((el) => el.classList.contains('tab') && el !== more);
    const lastRow = rows[rows.length - 1];
    /* 这一列的最后一项是「⋯」（它在时就排在最下）。它也要算进高度：
       只盯着页签、不管「⋯」，装不下的「⋯」会画到条子外面去 */
    const tail = more.hidden ? lastRow : more;
    if (!tail || tail.getBoundingClientRect().bottom <= innerBottom() + 0.5) break;
    if (!lastRow) break;
    menu.insertBefore(lastRow, menu.firstChild);
  }
  /* ③ 菜单空着就把入口收起来：点开一个空盒子比不放更糟（与 `applyCapabilities` 同一条理由） */
  more.hidden = menu.children.length === 0;
  syncMoreButton();
}

/**
 * 顶栏高度写进 `--header-h`：它是 `position: static`、高度由内容决定（窗口一窄就折成
 * 两行，78 → 128），CSS 读不到"内容撑了多高"。而右栏的吸附位置与"伸到视口底部上方 14px"
 * 都按它算（见 `--rail-top`）—— 拍一个固定值，在折行的宽度上就会错掉 50px（实测踩到过）。
 */
function syncHeaderHeight() {
  const header = document.querySelector('header');
  if (!header) return;
  const height = Math.round(header.getBoundingClientRect().height);
  if (height > 0) document.documentElement.style.setProperty('--header-h', `${height}px`);
}

/* 视口一变，"能列几项"与"顶栏几行"都变，所以两个量都要重算。
   防抖：拖动窗口时不必每一帧都量（每次量都会强制一次布局） */
let railLayoutTimer = null;
function relayoutRail() {
  clearTimeout(railLayoutTimer);
  railLayoutTimer = setTimeout(() => {
    syncHeaderHeight();
    layoutRailTabs();
  }, 120);
}
window.addEventListener('resize', relayoutRail);
/* 字体落定后顶栏高度才稳定（换字体时行高会变一点），所以 `load` 再量一次 */
window.addEventListener('load', relayoutRail);

/**
 * 最近一次被拒，就地可见。
 * 门控日志收进「⋯」菜单后，被拒时页签栏上没有任何提示，错误反馈等于藏进了
 * 一个默认看不见的地方。而医生的下一个动作通常是"再点一次"，
 * 真正该做的却是"先看为什么被拒"。错误提示的位置决定了排查方向。
 */
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

/** 页签切换：只显示当前面板（紧凑），未显示的靠页签圆点传达状态 */
function applyPanelState() {
  for (const panel of document.querySelectorAll('.panel')) {
    panel.classList.toggle('active', panel.dataset.panel === activeTab);
  }
  /* 当前面板被收起时，它的页签要留个记号：面板整块不在了，
     "再点这一下能放回来"就只能由页签自己说出来 */
  const activePanel = document.querySelector('.panel.active');
  const folded = !!activePanel && activePanel.classList.contains('is-collapsed');
  /* 收起 = 这一栏此刻什么也没显示。整列让给正文（`--rail-col` 归零，见 CSS 侧
     `main.rail-folded`）：收了一栏还把 404px 空白留在右边，比不收更难看。 */
  const mainEl = document.querySelector('main');
  if (mainEl) mainEl.classList.toggle('rail-folded', folded);
  /* 菜单项也是页签，必须一同参与高亮；aria-selected 同步给读屏。
     收起的这块**不算选中**：页签若还亮着，人看到的会是"选中的那块不见了"；
     而它现在确实什么都没在显示，选中态只该属于"正在显示的那一块"。 */
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
  try { localStorage.setItem(TAB_KEY, key); } catch { /* 隐私模式忽略 */ }
  /* 切到某块 = "我要看这块"：它若被收起过，这里一并展开（否则切过去是一栏空白） */
  const panel = document.querySelector(`.panel[data-panel="${key}"]`);
  if (panel && panel.classList.contains('is-collapsed')) {
    collapsedPanels.delete(panelKeyOf(panel));
    saveSet(PH_KEY, collapsedPanels);
    applyPanelCollapsed(panel, false);
  }
  applyPanelState();
  // 面板刚从 display:none 变为可见，此时 scrollHeight 才有值
  autosizeAll();
}
applyPanelState();

/* --------------------------- 面板折叠 ---------------------------
   每个 `<h2 class="ph">` 右侧挂一枚收起按钮，收起的是**整块面板**：panel 整段
   向右隐去、一个像素都不留（连标题行、徽标与操作按钮一起），右栏只剩页签条。

   回来靠**页签自己**：再点一次「AI 助手」就是"把它放回来"（见点击处理里
   `tab.dataset.tab === activeTab` 那一条）。恢复入口必须留在 panel 外面 ——
   整块都收走了，入口若也在里面，收起来就等于删掉了。

   状态按面板名（`data-panel`）存 localStorage，与页签、病历树同一处置 ——
   这是**视图偏好**：不改数据、不改 rev、不进留痕。 */
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
  /* 页签上的"这块收起来了"记号跟着变（判据只有 `is-collapsed` 一处） */
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

/** 再点一次当前页签 = 把这一整块收起来 / 放回来（面板隐去后，页签是唯一还看得见的入口） */
function toggleActivePanelCollapse() {
  const panel = document.querySelector('.panel.active');
  if (!panel) return;
  if (panel.classList.contains('is-collapsed')) expandPanel(panel);
  else collapsePanel(panel);
}

function initPanelToggles() {
  for (const panel of document.querySelectorAll('.panel')) {
    for (const ph of panel.querySelectorAll(':scope > .ph')) {
      /* data-no-fold：这一行不要折叠按钮（同一面板里已经有顶部那一枚，重复的按钮只是噪音） */
      if (ph.hasAttribute('data-no-fold')) continue;
      if (ph.querySelector('[data-ph-toggle]')) continue;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'ph-toggle';
      button.dataset.phToggle = panelKeyOf(panel);
      /* 路径基态朝下，方向由 CSS 转出来：展开时朝右、收起后朝左（见 `.ph > .ph-toggle svg`） */
      button.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M4 6l4 4 4-4"/></svg>';
      ph.append(button);
    }
    applyPanelCollapsed(panel, collapsedPanels.has(panelKeyOf(panel)));
  }
  applyPanelState();
}
initPanelToggles();

/* ------------------------------- 能力开关 -------------------------------
   宿主可以按部署形态收窄界面：`__L0_HOST__.capabilities` 里显式给 `false` 的能力，
   对应的页签、面板与入口**整个不出现**。

   与"配了没有"必须分清（分不清就会做出"点了没反应"的界面）：
     · **能力缺席**（本段）→ 入口不摆出来，因为这台机器上这条链路根本不存在；
     · **配置缺失**（`capture.configured` / `readingAuthority.configured`）→ 入口在，
       但置灰并写清缺哪几格 —— 「未配置」与「配了但不通」必须长得不一样。

   两条纪律：
     · **默认全开**：没注入时就是今天的形态，所以这段不改变任何既有行为；
     · 它**不是安全边界** —— 真正的边界在服务端 `authorize()`，这里只是不再摆出
       用不上的入口。也正因如此，"能力名拼错"的表现只是"某个入口永远不显示"，
       而不会有任何报错：所以 A32 扫的是"页面上出现的每个 `data-capability`
       都必须在下面这个白名单里"，以及"白名单里不得有没人用的名字"。
*/
const CAPABILITIES = ['qc', 'finalize', 'log', 'metrics', 'import'];

function capabilityOff(name) {
  const caps = (hostBridge() || {}).capabilities;
  return !!(caps && caps[name] === false);
}

/** 把能力缺席的页签 / 面板 / 入口整个摘掉，并把活动页签回退到还在的那一个 */
function applyCapabilities() {
  document.querySelectorAll('[data-capability]').forEach((el) => {
    if (capabilityOff(el.dataset.capability)) el.remove();
  });
  /* 「⋯」菜单被摘空时按钮自己也该走：留一个点开什么都没有的图标，比不放更糟 */
  const menu = $('moreMenu');
  if (menu && menu.children.length === 0) {
    const more = $('btnMoreTabs');
    if (more) more.remove();
  }
  /* 活动页签可能就是刚被摘掉的那一个（它还存在 localStorage 里）：回退到还存在的页签。
     不回退的表现是"打开页面停在空气上"——页签栏没有任何一项是高亮的，面板也不显示。 */
  if (!document.querySelector(`[data-tab="${activeTab}"]`)) {
    const fallback = TABS.find((name) => document.querySelector(`[data-tab="${name}"]`));
    if (fallback) {
      switchTab(fallback);
      return;
    }
  }
  applyPanelState();
}

/** 面板是否还在文档里：被能力开关摘掉的面板不该再被渲染（摘了还渲染就是白算） */
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

/* ------------------------------- 顶部信息 ------------------------------- */

const VISIT_LABEL = { outpatient: '门诊', inpatient: '住院', emergency: '急诊', 'physical-exam': '体检' };
const GENDER_LABEL = { M: '男', F: '女', U: '未知' };

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
  /* rev 是内部标识：临床模式不下发到医生视线里（演示模式保留，供排查） */
  $('docStatus').textContent = `${d.status === 'signed' ? '已签章' : '草稿'}${isClinical() ? '' : ` · rev ${d.rev}`}`;
}

/* ------------------------------- 病历树（左栏导航） ------------------------------- */

const TREE_KEY = 'l0demo.collapsedTree';

function loadSet(key) {
  try { return new Set(JSON.parse(localStorage.getItem(key) || '[]')); } catch { return new Set(); }
}
function saveSet(key, set) {
  try { localStorage.setItem(key, JSON.stringify([...set])); } catch { /* 隐私模式忽略 */ }
}
const collapsedTree = loadSet(TREE_KEY);

const STATUS_LABEL = { draft: '草稿', reviewing: '审核中', signed: '已签章', archived: '已归档', void: '作废' };

/** 树状导航：患者 → 就诊 → 病历（活动病历展开章节）。列窄，状态用圆点 + 悬停明细表达 */
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
        /* 章节按层级缩进显示（嵌套章节如"诊断明细"属于"初步诊断"）。
           章节行带「确认本章」按钮（仅当该章还有待确认内容时出现）。
           范围取章节级：医生按章节阅读，"本章我看过了"有明确含义；
           整篇一键在几十页病历上只是"点了同意"。onclick 阻止冒泡，避免顺带切换文档。 */
        const sections = doc.sections.map((section) => {
          /* 必备章节：给一个看得见的标记 + 一句"还没写"的提醒。
             为什么只提醒、不拦签章：必备管「这一章在不在」（它删不掉 —— 内核的 `deleteNode` 拒删），
             不管「写得够不够」；刚开出来的草稿必然还是空的，把它算成"不能签"只会让门控变成噪声。 */
          const required = section.required
            ? `<span class="chip mini${section.requiredEmpty ? ' warn' : ''}"
                title="${section.requiredEmpty
                  ? '必备章节：这一章还没有内容。它删不掉（模板里标了必备），签章前请写清'
                  : '必备章节：这一章删不掉（模板里标了必备）'}">必备${section.requiredEmpty ? '·还没写' : ''}</span>`
            : '';
          /* 章节说明（模板里写的"这一章要写清什么"）：**摆出来**而不是塞进悬浮提示 ——
             提示的意义就是"不用去找"，藏进 tooltip 等于没有 */
          const hint = section.description
            ? `<div class="sec-hint">${esc(section.description)}</div>`
            : '';
          return `
          <div class="trow section" style="padding-left:${8 + (section.depth || 0) * 12}px"><span class="dot ${section.hasUnconfirmed ? 'warn' : 'ok'}"></span><span class="ttl">${esc(section.title)}</span>${required}${section.hasUnconfirmed ? `<button class="mini-btn" data-confirm-subtree="${esc(section.id)}" title="确认「${esc(section.title)}」整章内容，范围与条数会记入留痕" onclick="event.stopPropagation()">确认本章</button>` : ''}${hint}</div>`;
        }).join('');
        /* 删除入口**只给草稿**：签章/归档之后它是医疗记录，要改走「解锁修改」并留痕。
           与内核判定同一条口径（`status === 'draft'`），按钮不出现只是前置提示 ——
           服务端 `/api/delete-document` 会再判一次（绕过界面也删不掉）。 */
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

/* ------------------------------- 正文 ------------------------------- */

/* 逐个节点的渲染在 `/doc-view.js`（`window.L0DocView`）：**管理后台的模板预览用的是同一份**。
   把它留在这里就等于给"预览与正文长得不一样"开了口子，而那种不一致最难被发现 ——
   两处都自认为画对了（理由写在那个文件的文件头）。 */

/** 插入段落后把光标放进新段落（否则用户还得自己在几十段里找刚建好的那一段） */
function focusEdit(nodeId) {
  const el = document.querySelector(`[data-edit="${nodeId}"]`);
  if (el) el.focus();
}

/* ------------------------------- 正文贴图 ------------------------------- */

/**
 * 一张图的上限。**以后端为准**（`media/image-probe.ts` 的 `MAX_IMAGE_BYTES`）：
 * 这里拦一道只是省一次白跑的上传，真正的拒绝在 `/api/image-upload`。
 */
const IMAGE_MAX_BYTES = 8 * 1024 * 1024;

/** 让用户挑一张图。取消时 resolve(null) —— 不留一个永远 pending 的 Promise */
function pickImageFile() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/webp';
    input.addEventListener('change', () => {
      const picked = input.files && input.files.length > 0 ? input.files[0] : null;
      resolve(picked);
    }, { once: true });
    /* 取消选择：现代浏览器会发 `cancel`。不发的老浏览器也不会有副作用 ——
       input 没有插进文档，那份 Promise 不持有任何 DOM，不会拖住界面。 */
    input.addEventListener('cancel', () => resolve(null), { once: true });
    input.click();
  });
}

/** 文件 → dataURL（服务端要 base64；Blob 直接跨 JSON 传不了） */
function readImageAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve(String(reader.result || '')));
    reader.addEventListener('error', () => reject(new Error('E_READ')));
    reader.readAsDataURL(file);
  });
}

/**
 * 选一张图并上传，返回 `{ resource, name }`；用户取消或中途失败返回 `null`。
 *
 * 抽出来是因为有两条入口要用它（段落「＋图」插新图、图片槽「贴图」换地址）。
 * 两处各写一遍的结果是"一条记得拦大小、另一条忘了"，而那种差异只有在有人
 * 挑了一张 30 MB 的图时才会暴露。
 */
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

function renderDoc() {
  $('docMeta').textContent = `${S.doc.docType} · ${S.doc.docId}`;
  /* 正文上方的提示位：粘贴（按外来内容处理）、撤销结果、已签章的提醒都往这里说一句。
     已签章时不显示粘贴/撤销提示，而是把"为什么改不了、该怎么改"讲清楚。 */
  const signed = S.doc.status === 'signed';
  /* 已签章与已归档在界面上都不可编辑，判据与内核 `commit()` 那道门完全一致
     （`status === 'signed' || 'archived'`）。把"改不了"前置：
     内核只会在提交时拒（`E_SIGNED_IMMUTABLE`），于是医生可以先改掉一大段、
     点保存才被挡回来，那是最容易白做一场的顺序。
     但要说清限度：只读只是前置提示，真正的拦点始终在内核（绕过界面也改不动）。 */
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
  /* 撤销按钮：只在有可撤销项时可用，并把"撤的是哪一条"写进 title，只写"撤销"，
     医生只能靠猜自己撤掉了什么（连续点两次之后尤其如此） */
  const undo = S.undo;
  const undoButton = $('btnUndo');
  if (undoButton) {
    undoButton.disabled = !undo;
    undoButton.title = undo
      ? `撤销第 ${undo.rev} 条（${undo.op}）`
      : '没有可撤销的写入（只支持撤销最近一次；签章/解锁之后不可撤销）';
  }
  /* 派生值重算入口：只在本文书真有派生值时出现。文案要说清"它只改公式算出来的格子"，
     否则医生会担心它把自己的手写内容覆盖掉（而内核本来就不允许覆盖人工内容）。 */
  const derivedRow = $('derivedRow');
  if (derivedRow) {
    const derived = Number(S.derivedCount ?? 0);
    derivedRow.classList.toggle('hide', derived === 0);
    $('derivedHint').textContent = derived === 0
      ? ''
      : `本文书有 ${derived} 个派生值：按控件公式计算；输入项填好后点一次（手改过的不动，缺输入的不编数）。`;
  }
  /* 落盘冲突的出路：冲突时给出可点的入口，并把"会影响什么、不影响什么"写清楚，
     这是有后果的操作（放弃本终端尚未落盘的旁挂改动），不能只给一个裸按钮。 */
  const conflictRow = $('sidecarConflictRow');
  if (conflictRow) {
    const conflicted = !!((S.sidecar || {}).conflict);
    conflictRow.classList.toggle('hide', !conflicted);
    if (conflicted) {
      $('sidecarConflictHint').textContent =
        '本终端最近的改动没能落盘（磁盘上那一版来自另一处）。重新载入会放弃本终端尚未落盘的建议与注解处置；正文、留痕与签名不受影响。';
    }
  }

  /* 正文两种画法，**同一批视图项**：
       · 卡片模式（默认）由 `/doc-view.js` 给 —— 管理后台的模板预览用的是同一个函数、同一份样式；
       · 流式模式由 `/flow-view.js` 给 —— 表格与专科控件仍然复用 `L0DocView.nodeHtml`，
         所以"同一个控件在两种模式里长得不一样"不会发生。
     两处都只是画：写路径完全同一条（见 flushFlow 与 flushEdits），
     所以切换模式不会让"同一次改动"留下不同的痕迹。 */
  if (isFlow()) {
    const caret = pendingCaret;
    pendingCaret = null;
    /* 记下这一屏所基于的 rev：落笔时带上它做乐观锁。
       必须在这里记、而不是落笔时现读 `S.doc.rev` —— 后者可能已被别的动作推进过，
       那样乐观锁永远不报冲突，等于没接。 */
    flowBaselineRev = typeof S.doc.rev === 'number' ? S.doc.rev : null;
    $('docBody').innerHTML = L0FlowView.render(S.items, {
      readonly: immutable,
      readonlyHint: immutableHint,
      clinical: isClinical(),
      annotations: S.annotations || [],
    });
    /* 重画之后把光标放回去。这一步不是锦上添花：流式模式下一次落笔就会重画整片纸，
       不还原光标等于"每写完一句就被踢出编辑区"，只能靠鼠标重新点回去。
       `focus()` 要排在 `setCaret()` 前面：先聚焦会把光标默认放到元素开头/末尾，
       再设选区才能落到该在的位置（反过来做，选区会被聚焦这一步冲掉）。 */
    if (caret) {
      const host = flowHostOf(caret.key);
      if (host) {
        if (caret.focus === true) host.focus();
        L0FlowView.setCaret(host, caret.at);
      }
    }
    return;
  }
  $('docBody').innerHTML = L0DocView.nodesHtml(S.items, {
    readonly: immutable,
    readonlyHint: immutableHint,
    clinical: isClinical(),
    annotations: S.annotations || [],
  });
}

/* ------------------------------ 质控提示（旁挂注解） ------------------------------ */

/* 质控提示面板。与建议面板的关键差别：注解不会因为处置而消失，
   列表永久保留（含处置史），因为"曾经提示过什么、谁怎么处理"本身就是证据链。 */
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

/**
 * 就诊时间轴：把跨文书质控的结论放回**一条线**上。
 *
 * 与「质控提示」的分工：那一栏逐条回答"哪里可能有问题"，这一栏回答"这条线断在哪"。
 * 缺口是**线**上的事 —— 一条挂在节点上的提示说不清"断在哪两份文书之间"。
 *
 * 判定不在这里：服务端跑的仍是那批已编译的时限规则，回传的 `detail` 与注解**逐字相同**，
 * 所以两边不会各说一句话（措辞只在上游一处）。
 */
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

  /* 时刻只显示到分钟：年月日 + 时分足够回答"这两份之间隔了多久"，
     秒与毫秒在 238px 宽的栏里只会把真正要看的字挤掉（完整值仍在文档 JSON 里）。 */
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

  /* ------------------------- 四类待办：口径先写死在这里 -------------------------
   *
   * 为什么要在界面上**再算一次**，而不是让服务端下发"待办列表"：
   * 这四类的判据全都已经在下发的数据里（`status` / `exceeds` / `gaps` / `trend.unwritten`），
   * 再让服务端算一遍，等于把"什么算待办"多存一份口径 —— 那种东西迟早会和源头漂。
   * 服务端继续只负责**判定**（时限、缺口、对照），界面只负责**归类成一个清单**。
   *
   * 哪四类：
   *   1) 超时：同类文书间隔超过时限（`segments[].exceeds`）—— 线断了；
   *   2) 未签：状态不是已签、也不是归档/作废（`status`）—— 决定还没落定；
   *   3) 缺口：跨文书规则报出的"应有而缺 / 间隔超限"（`gaps`）；
   *   4) 变化未写入病程：参考范围外的采样点之后再没被记录或提到（`trend.unwritten`）—— 写了但没写进去。
   *
   * `status` 为 null 的文书**不计入未签**：不知道就是不知道，把它算成"未签"会让清单里
   * 永远挂着一份其实可能已签的文书；轴上仍标"状态未知"，人自己看。
   */

  /** 已签 / 未签 / 已归档作废 / 状态未知（四态，不让"未知"混进"未签"） */
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

  /* 每条待办都必须**能落到一个动作**上，否则它就只是又一句提示。
     动作只有一种是真的：切到那份文书（写不写、签不签仍然是人的事）。
     纯提示类（变化未写入病程）不给按钮 —— 病程里补哪一句，系统不该替人决定。 */
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

  /* 未判定与前提都摆在明处：只显示缺口数，会把"有一批根本没判"读成"这条线是连的" */
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

  /* 对照区只保留**已写入**的那部分：未写入的已经进了上面的待办，
     同一个事实在两处各写一遍，人就得比对"这两条说的是不是同一件事"。 */
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
  /* 判定口径（同一编码被再次记录，或正文提到它的名称，都算"写进去了"）不摆在标题上，
     改放 title：它是"凭什么说已写入"的依据，需要时悬停可看，不必每屏占一行。 */
  trendBox.innerHTML = `
    <div class="mt10" title="同一编码被后续文书再次记录，或正文里提到该数据元的名称，都算“写进去了”"><b>变化与后续文书的对照</b></div>
    ${changes}
    ${skipped}`;
}

/* ---------------------------- 跨次就诊对比 ----------------------------
 *
 * 只显示**差异**：相同章节折叠成一行。
 * 医生要回答的是"这次和上次差在哪"，把逐字相同的章节再念一遍，
 * 等于让他在两份病历里重新找一遍 —— 那正是这一页要省掉的活。
 *
 * 每一段都直接给原文：不做摘要。摘要一旦错了，医生没法发现；
 * 而原文错了，他一眼就看得出来。
 */
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

  /* 诊断：先给结论，再给依据。结论只有"同 / 不同 / 没有可比的东西"三种 */
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
    /* 删除线在下、新增在上：读起来就是"原来是这样 → 现在是这样" */
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

  /* 用药沿用：给得出原文才给按钮；给不出就说明原因，不用一个空块糊过去 */
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

/* ------------------------------ 出院汇总 ------------------------------
 *
 * 两栏：**派生条目**与**缺口**。
 *
 * 缺口必须单独成栏：混进条目里时，"这次为什么没有出院医嘱"会藏进某条的空字段，
 * 而那正是最容易被漏掉的地方。医生要的不是"系统尽力了"，是"还差哪份文书、哪一章"。
 *
 * 每条来源都可点：点一下就切到那份额文书 —— 让人自己核对原文，
 * 而不是相信一个"来源已溯源"的标记。派生本身只搬运原文，不做摘要。
 */
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

/* ------------------------------ 预问诊 ------------------------------
 *
 * 这一栏读的是**别人填好的东西**：患者候诊时写的原文，一个字都不是判断。
 * 所以它只有两件事可做：核对原文、生成建议。
 * 没有"一键写入正文"—— 患者自述进病历必须有医生签字那一步，
 * 而这一步在这个系统里就是建议通道（采纳 → 人工确认 → 才成为病历内容）。
 *
 * 为什么逐条列、不复述成一段：原文是证据。把"胸口闷三天"和"走快一点就闷"
 * 合成一段通顺的话，读起来更省事，但"哪句是他说的"就没了。
 */
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

  /* 页签栏这一格很窄，只放"几条"；提交/读取时刻放到面板里（见下面那行小字） */
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

/* ------------------------- 就诊范围（摆不摆这一栏） -------------------------
 *
 * 「出院汇总」只对住院有意义：门诊 / 急诊 / 体检上点进去只会得到"可派生 0 条 + 一堆缺口"，
 * 那些缺口说的都是同一件事（这不是住院），读起来像系统在报错。
 *
 * 判据由服务端下发（`encounter.dischargeSummaryAvailable`）：前端不复制"什么算住院"，
 * 复制一份必然漂移，而漂移的方向是"该出现的入口不出现"——这类问题不会报错，只会让人以为功能丢了。
 *
 * 与 `applyCapabilities` 的分工要分清：
 *   · 那个答"这台机器有没有这条链路" —— 一次性摘除，永不恢复；
 *   · 这个答"当前这份病历适不适用" —— 随切文书来回变，只能切换 `hidden`，不能删。
 */
function applyVisitScope() {
  const available = !!(S && S.encounter && S.encounter.dischargeSummaryAvailable);
  for (const el of document.querySelectorAll('[data-visit-scope="inpatient"]')) {
    el.hidden = !available;
  }
  /* 从住院切到门诊时，当前页签可能正是被摘掉的那一个：不退回就会出现
     "选中态停在一个看不见的面板上"（面板空、页签还亮，人只会以为卡住了）。 */
  if (!available && activeTab === 'discharge') switchTab('ai');
}

function renderAnnotations() {
  const list = S.annotations || [];
  const counts = S.annotationCounts || { total: 0, open: 0, acknowledged: 0, dismissed: 0, resolved: 0, anchorLost: 0 };

  /* 规则出处（哪几版包、启用了多少条）不再常驻显示：正常状态下它只是一行长字，
     对"点哪一条、这件事做没做"毫无帮助。**只保留异常态**——库里一条规则都没有时
     质控根本跑不了，那必须说出来，否则"没提示"会被读成"没问题"。
     "有没有规则可跑"看的是**规则条数**，不是包数：判定方式也是包内容，库里天然会有一个
     只装判定方式的包（出厂那 6 条就写在自建包里），拿包数当判据会把"一条规则都没有"
     显示成"质控正常"。 */
  const catalog = Array.isArray((S.knowledgePacks || {}).rules) ? S.knowledgePacks.rules : [];
  const packLine = $('qcPackLine');
  if (packLine) {
    packLine.textContent = catalog.length === 0 ? '还没有任何规则：质控当前不可用。' : '';
  }

  /* 未判定：与命中数同屏出现。时限类规则依赖入院时间或外部导入件的性质，
     判不了时既不报也不是"没问题"，不说出来，医生就会把"这次没报"当成"查过了"。 */
  /* 内涵类质控：没接上要写在界面上。它不是"没发现"，
     引擎未接入 / 规则清单为空这两件事，与"跑了 0 命中"在数据与界面上都长得一模一样，
     而处置完全不同（前者要配引擎/清单，后者是"确实干净"）。
     但"还没跑过"不写：那只是"这一栏还没被用过"，摆在首屏等于要求医生先读一句
     与当前动作无关的话；跑过之后的结论（可用 / 不可用）才必须写出来。 */
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

/* -------------------------- 本机客户端采集（C3b③） --------------------------

   形态：麦克风由**本机进程**采（浏览器在 http://10.x 下拿不到麦克风，本机进程没有这个限制），
   **分片也在客户端做**（它有音频，也直接复用 `capture.ts` 的同一份规则）。
   页面只做两件事：把段取过来、上传给同源采集路由（由服务端转发 ASR）——
   于是页面这边**一行分片规则都不需要**（这是这个形态最要紧的收益）。

   地址与一次性令牌来自 URL 参数（客户端打开页面时带上），页面**不写死任何地址**：
   写死地址等于把"音频从哪来"钉进前端，而它本来是部署参数。
--------------------------------------------------------------------------- */

/** 本机客户端的**固定约定**：只在本机回环、只在这个端口。
 *
 * 为什么可以写死：它不是拓扑地址（不是某台服务器的内网 IP），而是"本机装的那个客户端"——
 * 换机器也不变、与部署环境无关。地址仍可由 URL 参数覆盖（换端口做实验时不用改前端）。
 * 令牌是可选的：客户端没启用令牌时，页面空令牌直连；启用时页面从 URL/上次记录里取。 */
const DEFAULT_CAPTURE_CLIENT = '127.0.0.1:8901';

/** URL 里的本机客户端信息：`?captureClient=127.0.0.1:8901&captureToken=…`
 *
 * 优先级：URL 参数 > 上一次从客户端打开时记住的（本机同源 localStorage）> 固定约定。
 * 令牌只在前两者里出现：页面不生成、不猜令牌。 */ 
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
    return null; /* 隐私模式 / 坏数据：记住只是便利，不是能力 */
  }
}

function rememberClient(host, token) {
  try {
    const remembered = readRememberedClient();
    if (remembered !== null && remembered.host === host && remembered.token === token) return;
    localStorage.setItem(CAPTURE_CLIENT_KEY, JSON.stringify({ host, token }));
  } catch {
    /* 存不下也不影响这次（URL 里本来就带着） */
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
  /* 兜底：本机客户端没带参数打开页面（裸地址）也照样检测 —— 地址是固定约定，令牌可空。
     客户端启用了令牌时会回 401，状态行会明确说"令牌不匹配"，不会静默失败。 */
  return { host: DEFAULT_CAPTURE_CLIENT, token: '', base: `http://${DEFAULT_CAPTURE_CLIENT}/dictation-capture` };
}

/** 本机客户端的检测结果（`null` = 正在检测 / 还没检测）。**只读：不打开设备、不发一个字节音频** */
let clientProbe = null;
/** 探测序号：只有最后一次探测的结果能落到界面上（先发后到的旧结果会把"已连接"冲回"连不上"） */
let clientProbeSeq = 0;
/** 探测是否在飞：心跳 3s 一次、单次最长 2.5s，不挡住并发就会叠出一串请求 */
let clientProbeInflight = false;
/** 最近一次探测成功时的源标识：断线时仍要能说清"刚才用的是哪个源" */
let clientSource = '';
/** 页面 ↔ 本机客户端的心跳间隔：状态必须能自己变，不能靠人点「重新检测」 */
const CLIENT_HEARTBEAT_MS = 3000;

/** 本机采集的页面侧状态（它不属于服务端 state：过程由客户端与页面共同产生） */
let localCapture = null;
/** 录音过程的轮询句柄（客户端把计时 / 电平放在 /hello 的 progress 里，页面按 300ms 取一次） */
let localProgressTimer = null;

async function bridgeFetch(client, path, options = {}) {
  const suffix = client.token === '' ? '' : `?token=${encodeURIComponent(client.token)}`;
  const res = await fetch(`${client.base}${path}${suffix}`, {
    method: options.method || 'GET',
    ...(options.body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(options.body) }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (res.status === 401) {
    /* 与"客户端不在"分开报：两者的处置完全不同（一个是去启动客户端，一个是重新从客户端打开页面） */
    const payload = await res.json().catch(() => ({}));
    throw Object.assign(new Error(payload.message || '令牌不匹配'), { code: payload.code || 'E_BRIDGE_BAD_TOKEN' });
  }
  return res.json();
}

/** 探测失败 → "现场表现 + 怎么办"（与采集源同一条纪律：只丢一个错误码等于让人去搜） */
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

/**
 * 检测本机客户端在不在、令牌对不对、采集源是什么。
 *
 * 为什么要单独检测、而且**定时**检测、而不是等按下"开始"再发现：地址与令牌由客户端给出，
 * 但**客户端进程可能还没启动或已经退出**（或端口被占）—— 那时按下去只会得到一句"连不上"，
 * 而医生会以为自己按错了。检测只打一个 `/hello`：不打开设备、不发任何音频。
 *
 * 心跳不看当前是"已连上"还是"连不上"：客户端后启动要能自动接上，中途退出也要在下一次心跳里
 * 显示出来 —— 只在已连上时复检，等于"断了就再也不看了"。
 */
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
  /* 上一次探测还没回来：等它落定即可（心跳下一次会接着探），不叠请求 */
  if (clientProbeInflight) return clientProbe;
  clientProbeInflight = true;
  const seq = (clientProbeSeq += 1);
  /* 只有第一次（还没有结论）才显示"正在检测"；心跳保持上一次结论，避免每 3s 闪一下 */
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

/** 秒数：一分钟以内给到 0.1s（录音时的计时感），超过就给 m:ss */
function fmtSeconds(value) {
  const sec = Math.max(0, Number(value) || 0);
  if (sec < 60) return `${sec.toFixed(1)}s`;
  return `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
}

/** 录音电平条：只反映客户端真实给出的帧（`voiced` / `level`），不是纯装饰动画 */
function updateLocalWave() {
  const wave = $('captureLocalWave');
  if (!wave) return;
  const active = !!(localCapture && localCapture.running);
  wave.hidden = !active;
  if (!active) return;
  const level = Math.max(0, Math.min(1, Number(localCapture.level || 0)));
  /* 平方根拉伸：脚本音频的 RMS 只有 ~0.18，线性画出来几乎看不见 */
  wave.style.setProperty('--amp', (level <= 0 ? 0.1 : Math.min(1, Math.sqrt(level) * 2.4)).toFixed(2));
  wave.dataset.voiced = localCapture.voiced === true ? '1' : '0';
}

/**
 * 采集中每 300ms 取一次进度：计时与电平要**在段定稿之前**就在动，否则看着像"按了没反应"。
 *
 * 除了进度，这里还要看 `sourceProblem`：设备被拔掉 / 被别的程序独占时，
 * 客户端不会"报错退出"，它只是**不再送帧**，最后被看门狗判成停摆并把 problem 写进 `/hello`。
 * 心跳那一路 3s 一次、只管连接是否还在，不会把这个变化带到界面上。
 */
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
      /* 过短丢弃的段数：它们不会出现在"失败"里，但医生会觉得"我说了一句却没变文字" */
      localCapture.shortDropped = Number(progress.shortDropped || 0);
      dirty = true;
    }
    /* 实际打开的设备与采样率由 /hello 的 source 带回：多卡环境下这条要尽早显示准确
       （心跳 3s 才更新一次 clientProbe，采集刚开始那几秒不能还停在旧文案上） */
    if (typeof hello.source === 'string' && hello.source !== '' && hello.source !== clientSource) {
      clientSource = hello.source;
      dirty = true;
    }
    /* 只在"有问题/问题变了/问题消失"时换一次，别每 300ms 重画整块状态栏 */
    const problem = hello.sourceProblem && typeof hello.sourceProblem === 'object' ? hello.sourceProblem : null;
    const before = localCapture.problem === null ? '' : String(localCapture.problem.code || '');
    const after = problem === null ? '' : String(problem.code || '');
    if (before !== after) {
      localCapture.problem = problem;
      dirty = true;
    }
    if (dirty) renderCaptureLocal();
  } catch {
    /* 轮询失败不打断采集：真正的问题由 /next 那一路报出来（这里的重试是 300ms 后） */
  }
}

function stopLocalProgressPoll() {
  if (localProgressTimer !== null) {
    clearInterval(localProgressTimer);
    localProgressTimer = null;
  }
}

/** 手动重试是否在进行中：只影响这个按钮（旋转 + 置灰），不影响状态卡里的结论 */
let reprobeBusy = false;

/** 状态卡右侧的"重新检测"图标按钮。
 * 它必须是**看得见在动**的：探测最长 2.5s，期间没有反馈的话，
 * 人只会怀疑"这按钮到底能不能按"，于是再点几下 —— 而结果是同一个。
 * 所以：点击即进入 spinning + disabled，落定后由重画收尾。 */
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

/** 采集状态卡的一行：标签（固定列）/ 值 / 动作（可选）。
 * 标签列对齐是这张卡的全部意义：同义的几组事实各自成行，
 * 换行位置不再由文字长度决定。 */
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
  /* 左侧色条取"最坏的那一条"：整块是正常、将就（能录但转不了）、还是坏了，一眼可见 */
  const card = (tone, rows, notes) => `<div class="cap-status${tone ? ` ${tone}` : ''}">`
    + rows.join('')
    + (notes.length === 0 ? '' : `<div class="cap-notes">${notes.map((note) => `<div class="cap-note">${note}</div>`).join('')}</div>`)
    + '</div>';

  if (client === null) {
    /* 本机客户端是**唯一**的采集来源：页面不是从它打开时，只留一行状态，
       不再展开"去哪儿启动、用哪个地址打开"的操作指引。 */
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
  /* `S` 在第一次取状态之前是 null（心跳会在那之前就跑起来）：不守卫会在这里抛错，
     而表现在界面上就是永远停在"正在检测"。 */
  const asrReady = !!(S && S.capture && S.capture.configured === true);
  const rows = [];
  const notes = [];
  let tone = '';
  const failed = Number(state.failed || 0);

  /* 录音中优先：心跳失败时也要先让人看见"它还在录"（连接断了另加一条），
     不能因为一次探测失败就把录音指示换成一行"不可用" —— 那会让人以为录音已经停了。 */
  if (state.running) {
    /* 页面自己的 running 只管"这一轮还在不在跑"；客户端若已先收尾（源停摆/被停止），
       要显示"收尾中"而不是继续挂着"录音中"——两边说法不一致时，人会以为录音还在继续 */
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
    /* 采集源异常（设备被拔掉/被独占）：**不能**只让秒数停住 —— 那看起来像卡死，不像故障 */
    if (state.problem) {
      notes.push(`采集源异常：${esc(state.problem.message)}。怎么办：${esc(state.problem.howTo || '')}`);
    }
    if (!connected) notes.push(`连接中断：${esc(clientProbe.message)}。怎么办：${esc(clientProbe.howTo)}`);
  } else if (!connected) {
    tone = 'danger';
    rows.push(capRow('本机客户端', `不可用 —— ${esc(clientProbe.message)}`, 'danger', reprobe));
    notes.push(`怎么办：${esc(clientProbe.howTo)}。页面每 ${Math.round(CLIENT_HEARTBEAT_MS / 1000)} 秒自动检测一次，也可以手动重试。`);
  } else {
    /* 能录、但转不了：这是"将就可用"，用 warn 而不是 danger —— 采集入口照旧可用 */
    tone = asrReady ? 'ok' : 'warn';
    rows.push(capRow('本机客户端', `● 已连接<span class="cap-host">${esc(client.host)}</span>`, 'ok', reprobe));
    if (clientSource) rows.push(capRow('采集源', esc(clientSource)));
    rows.push(capRow('语音识别', asrReady ? '已配置' : '未配置（可录，转写会失败）', asrReady ? 'ok' : 'warn'));
    if (state.outcome) {
      rows.push(capRow('上次采集', `用时 ${fmtSeconds(state.elapsedSec)} · 定稿 ${Number(state.finalized || 0)} 段 · 成功 ${Number(state.acked || 0)} 段`
        + (failed > 0 ? ` · 失败 ${failed} 段` : ''), failed > 0 ? 'danger' : ''));
    }
    if (state.message) notes.push(esc(state.message));
    /* 采集结束后 problem 仍要留着：设备就是刚才那一下掉的，"结束得正常"不能把原因盖掉 */
    const sourceProblem = state.problem || clientProbe.sourceProblem;
    if (sourceProblem) {
      notes.push(`客户端采集源异常：${esc(sourceProblem.message)}。怎么办：${esc(sourceProblem.howTo || '')}`);
    }
  }
  el.innerHTML = card(tone, rows, notes);
}

/* -------------------------- 采集入口：一个开始 + 一个停止 --------------------------

  来源只有**本机客户端**这一条：音频由本机进程采、分片也在本机做，
  页面只做"取段 → 上传同源路由 → 一组建议"。
  浏览器麦克风（`http://10.x` 下拿不到设备）与服务端脚本音频（只是演示）不再摆成可选项 ——
  把它们与真正的来源并排放在一个下拉里，现场只会去猜"哪个才是真的"。
--------------------------------------------------------------------------- */

/** 采集按钮的唯一状态来源：谁在跑、能不能跑、按下去会发生什么，都在这里判一次 */
function renderCaptureButtons() {
  const start = $('btnCaptureStart');
  const stop = $('btnCaptureStop');
  if (!start || !stop) return;
  const active = !!(localCapture && localCapture.running);
  /* **录音与转写是两件事**：这里只拦"采不到音"的情况（客户端不在 / 令牌不对）。
     语音识别没配就不让录，是把这个按钮当成了"转写按钮" —— 想试麦克风的人连按都按不下去，
     而失败本来就能逐段报出来（哪一段没转成、为什么）。 */
  const clientReady = clientProbe !== null && clientProbe.ok === true;
  start.disabled = active || !clientReady;
  stop.disabled = !active;
  /* 来源只有一条，文案就不必跟着选择走：按下去之前就知道这一次会从哪儿取音频 */
  start.textContent = '开始采集';
  /* **为什么按不动**贴在 title 上：页面上不常驻那几段说明，
     但理由仍要能问到 —— 灰按钮不给理由，只会被当成"界面卡了"。 */
  start.title = active
    ? '正在采集：先按「停止」结束这一次'
    : !clientReady
      ? (clientProbe === null ? '本机客户端：正在检测…' : `本机客户端：不可用 —— ${clientProbe.message}`)
      : '按本机客户端开始一次采集；中途随时可停，已说出口的段不丢';
}

async function startCapture() {
  /* 唯一的采集入口：本页只支持本机客户端（地址与令牌由客户端打开页面时带上） */
  await runLocalCapture();
}

async function stopCapture() {
  /* 按停只让**客户端**把当前那一段定稿；页面这边继续把队列取完（已经说出口的话不丢） */
  if (!localCapture || !localCapture.running) return;
  const client = captureClientOf();
  if (client === null) return;
  try {
    await bridgeFetch(client, '/stop', { method: 'POST', body: {} });
  } catch (err) {
    toast(`停止采集失败：${err.code || ''} ${err.message || ''}`, 'danger');
  }
}

/**
 * 本机客户端采集：取段 → 上传同源采集路由 → 按结果 ack → 全部收齐后提交成建议。
 *
 * 三条要点：
 *   - **ack 之前不推进队列**（客户端那边的纪律）：上传失败也要 ack(ok:false) 把原因带回去，
 *     否则那一段会在客户端队列里永远挂着，而页面什么都不知道；
 *   - **上传仍然只走同源**：不把 ASR 端点告诉页面（否则就退回被否决的方案 A）；
 *   - **时间区间原样带过去**：它是客户端给的，页面不代编（服务端也只校验）。
 */
async function runLocalCapture() {
  const client = captureClientOf();
  if (client === null) return;
  /* 按下去之前先确认客户端真的在：只凭 URL 里有参数是不够的（进程可能已经退出） */
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
    /* 采集源异常（设备被拔掉/被独占）：由 /hello 的 sourceProblem 带回来，收尾时也要留着 */
    problem: null,
    /* 客户端侧的状态（recording / done）：页面自己的 running 只管"这一轮还在不在跑" */
    clientState: '',
    shortDropped: 0,
    /* 这一轮的开始时间：采集记录要记"什么时候录的"，不能等收尾时补一个假的 */
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

    /* 逐段：取 → 上传同源路由 → ack */
    for (;;) {
      const payload = await bridgeFetch(client, '/next');
      const next = payload.next || {};
      if (next.kind === 'done') {
        localCapture.finalized = Number(next.total || 0);
        /* 先补一次进度：停在最后一段时计时要落到"真实的录音时长"，
           同时把设备停摆的 problem 取回来（否则"结束得正常"会把原因盖掉）。
           原因本身由 `state.problem` 那条说明行展开 —— 拼进摘要只会让同一句话出现两次。 */
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
        const uploaded = await fetch(`/api/dictation/capture/segment?sessionId=${encodeURIComponent(localCapture.sessionId)}&index=${meta.index}`, {
          method: 'POST',
          body: form,
        });
        const result = await uploaded.json();
        if (result.ok !== true) throw Object.assign(new Error(result.message || '上传失败'), { code: result.code });
        if (!localCapture.asrModelId) localCapture.asrModelId = String(result.data.modelId || '');
        localCapture.segments.push({ index: meta.index, text: result.data.text, startSec: meta.startSec, endSec: meta.endSec });
        localCapture.acked += 1;
      } catch (err) {
        /* 失败也要 ack 回去（客户端据此记账、并在 done 里如实回报）—— 不许让它挂在队列里 */
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
    /* 收尾时电平归零：录音指示不能停在"还在响"上（病房里看到的是它） */
    localCapture.voiced = false;
    localCapture.level = 0;
    renderCaptureLocal();
    /* 收齐后提交成建议：**与"页面自己录"完全同一条路**（`/api/dictate` 收真实转写） */
    if (localCapture.segments.length > 0 && localCapture.asrModelId !== '') {
      await apply(
        await api('/api/dictate', {
          transcriptionId: localCapture.sessionId,
          asrModelId: localCapture.asrModelId,
          segments: localCapture.segments.map((item) => ({ index: item.index, text: item.text, startSec: item.startSec, endSec: item.endSec })),
        }),
      );
    }
    /* 记一笔采集元数据（何时、哪块设备、多久、几段成败）。
       **音频不留存**，所以这条记录里没有音频字段，界面上也不会有回放入口。 */
    void submitCaptureRecord();
  }
}

/* --------------------------- 采集记录（只有元数据） --------------------------- */

let captureHistoryLoaded = false;
/**
 * 上一次读记录时用的是哪份病历。
 *
 * 只靠 `captureHistoryLoaded` 会让"切换病历"停在上一份的 DOM 上：`switchDoc` 之后
 * `renderAll` 每次都调 `renderCaptureHistory()`（不带 force），于是直接早退，
 * 面板里留着的就是上一个患者的采集记录 —— 既串档，也会被读成"这一份也录失败了"。
 */
let captureHistoryDocId = '';
/**
 * 读取序号：切病历很快时，先发的请求可能后到。
 * 没有它，"A → B"会以 A 的记录收场（而且表面上一切正常），排查时只能怀疑数据本身。
 */
let captureHistorySeq = 0;

/**
 * 提交一次采集的元数据。
 *
 * 为什么不在这条记录里带文本或音频：文本已经作为建议走 `/api/dictate`（带来源、带留痕），
 * 音频按设计不留存。把任何一样抄进来，都会多出一份"生命周期和门控都不一样"的副本。
 */
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
    /* 记录失败不打扰医生：采集与建议都已经完成，这只是一笔账 */
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

/**
 * 采集记录列表：**只到本份病历**，最近若干条，只到"哪次、哪块设备、多久、几段成败"。
 *
 * 这里**没有播放按钮**，不是漏了：音频按设计不留存，
 * 摆一个点了会说"文件不存在"的入口，比不摆更糟。
 *
 * 读取必须带 `docId` 且跟着当前病历走：记录是该次采集挂在哪份病历上的，
 * 而"上一份病历录了几段"不该出现在下一个患者的面板里。
 */
async function renderCaptureHistory(force) {
  const el = $('captureHistory');
  if (!el) return;
  const docId = (S && S.activeDocId) || '';
  /* 没有活动病历时没有"本份"可言：藏起来，而不是退化成"显示全部" */
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
    /* 读不到就不显示：记录是辅助信息，不能因为它报错就打断别的事 */
  }
  /* 等回来时病历已经又换了：这次响应过期，写进去就是"B 的面板上停着 A 的记录" */
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
  /* 清空按钮只清**本份病历**（服务端会再核一次 docId）：失败的记录留着没有用处，
     但"怎么删"必须写在界面上 —— 否则只能删文件或等 7 天，那是运维才知道的事。 */
  el.innerHTML = `<div class="row mb6">
      <span class="muted push">采集记录（本份病历 · 保留 ${Number(data.retentionDays) || 7} 天；只记元数据，音频不留存，无法回放）</span>
      <button data-capture-clear title="只清空本份病历的采集记录；管理审计里的采集记录不受影响">清空本份记录</button>
    </div>${rows}`;
  el.hidden = false;
}

/* ------------------------------- 语音转写 ------------------------------- */

/** 可接收拖放的节点集合（每次渲染语音页签时刷新，供下面的拖拽处理用） */
let placementCandidateIds = new Set();

/* 转写结果展示。把"规范化做了什么"（丢了空段、重排了乱序）摆在明面上，
   这类事静默处理的话，医生会以为自己的话被吞了，却查不出原因 */
function renderDictation() {
  const dictation = S.dictation;
  /* dragover 是高频事件：候选集在这里算好，别在事件处理里反复建 Set */
  placementCandidateIds = new Set((Array.isArray(S.placementCandidates) ? S.placementCandidates : []).map((item) => item.nodeId));
  /* 采集可用性：这段放在早返回之前 —— 它说的是服务端配置，不是"有没有转写结果"。
     但**只在已配置时写一行**：未配置时不在医生页面展开"缺哪几格、去哪儿配"，
     那是部署方的动作，摆在每台终端上只会每天重复一次；点采集仍会明确报错
     （`E_CAPTURE_NOT_CONFIGURED`），原因在那句报错里，而不是这里的一大段说明。 */
  const capture = S.capture || {};
  /* 这一行说的是**语音识别服务**（服务端配置），下面那一行说的是**麦克风**（本机环境）——
     两者是两件事，所以各自带主语，避免读成同一句"不可用"。 */
  /* 只说"能不能用"与"音频会不会被留下"：服务地址与模型标识属部署参数，由管理后台管。
     地址画在医生页面上没有任何用途，却把"这份内容与音频发往哪台服务器"摆到了每台终端上。 */
  const captureLine = $('dictationCapture');
  captureLine.textContent = capture.configured
    ? `语音识别服务：已配置（音频${capture.retainAudio ? '会留存' : '不留存'}）`
    : '';
  /* 未配置时整行**不占位**：空 div 仍带一段下边距，看起来像"这儿少了点什么" */
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
  /* 落点可指定 = 还没提交。提交后再改只能重新转写，
     建议一旦生成就有独立生命周期（采纳/拒绝/留痕），在它背后偷换落点会让留痕与内容对不上。 */
  const selectable = dictation.submitted !== true;
  const candidates = Array.isArray(S.placementCandidates) ? S.placementCandidates : [];
  const optionsFor = (selected) => ['<option value="">— 请选择落点 —</option>']
    .concat(candidates.map((item) => `<option value="${esc(item.nodeId)}"${item.nodeId === selected ? ' selected' : ''}>${esc(item.label)}</option>`))
    .join('');
  /* 文本从哪来必须标出来：模拟转写与真实采集在界面上长得一样（都是一段文本 + 时间区间），
     而"仓库里写死的一段话"与"真识别出来的"信任程度完全不同 */
  $('badgeVoice').innerHTML = `<span class="chip${dictation.source === 'capture' ? ' ok' : ' warn'}">${dictation.source === 'capture' ? '真实采集' : '模拟转写'}</span>`
    + ` <span class="chip ok">${segments.length} 段</span>`
    + (unplaced > 0 ? ` <span class="chip warn">未落位 ${unplaced}</span>` : '')
    + (isClinical() ? '' : ` <span class="chip">${dictation.submitted ? `组 ${esc(dictation.groupId)}` : '未生成建议'}</span>`);
  const rows = segments.map((segment) => {
    const span = segment.startSec === undefined ? '无时间戳' : `${segment.startSec}s ~ ${segment.endSec}s`;
    const placement = byIndex.get(segment.index);
    const chosen = placement && placement.nodeId ? placement.nodeId : '';
    /* 落点必须显式标出："系统猜的"与"没猜到"要让医生一眼分辨，
       错误落位比不落位更难被发现（主诉写进现病史，医生未必逐字看） */
    const target = selectable
      ? `<select data-place-index="${segment.index}" title="为这一段指定落点（只影响建议落点，不改门控档位）">${optionsFor(chosen)}</select>`
      : (chosen ? `<span class="chip ok">落点 ${esc(chosen)}</span>` : '<span class="chip warn">未落位</span>');
    const hint = placement ? `<span class="muted">${esc(placement.reason)}</span>` : '';
    /* 未提交时整块可拖到正文的段落上（见下面的拖拽处理），拖拽只是另一种指定落点的方式，
       与下拉等价：更顺手，但不是唯一路径（键盘用户与触屏仍用下拉）。 */
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

/* --------------------------- 拖拽指定落点（V2b） ---------------------------
   把语音页签里的一段拖到正文的段落上 = 给这一段选落点。
   它不新增任何通道：拖完只是改写那个下拉框的值，后面的"生成建议"照旧走 `/api/dictate-commit`。
   所以拖拽就算坏掉，也只是少了一种更顺手的操作方式，不会让落位逻辑出错。
   只接受候选集内的文本节点（内核也只认文本节点），其它位置不 preventDefault，
   浏览器自己会显示"禁止"光标，等于就地告诉用户"这里放不下"。 */

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
    /* 落点已提交、或转写已换过一次：没有对应的下拉框。说明，不静默忽略，
       否则用户会以为"拖成功了"，而实际上什么都没发生 */
    await askAlert('这一段现在没有可指定的落点（可能已生成建议，或转写已更新）：请在「语音转写」里重新确认');
    return;
  }
  select.value = zone.dataset.nodeId;
  /* 就地闪一下边框：拖完要立刻看得出"落点确实被改了"，否则用户会怀疑没生效 */
  select.classList.add('just-set');
  window.setTimeout(() => select.classList.remove('just-set'), 1200);
});

/* ------------------------------- AI 建议 ------------------------------- */

/* 产出方式标注：顺着我写的（续写）与模型自己写的（草稿）信任程度不一样，
   不区分的话，医生要么全信、要么全不信，两者都不对 */
const MODE_LABEL = { complete: '续写', draft: '草稿', polish: '润色', voice: '语音', consistency: '一致性', unknown: '未知', other: '其他' };

function chipMode(mode) {
  const label = MODE_LABEL[mode] || mode || '未知';
  return `<span class="chip${mode === 'voice' ? ' ai' : ''}" title="产出方式：${esc(label)}">${esc(label)}</span>`;
}

/* ------------- 接入状态：只读（配置已搬到管理后台 /admin） -------------
   这里没有任何配置控件：模型地址决定病历内容发往哪台服务器，那是数据流向，
   属于管理后台的动作（见 admin.html）。医生端只保留"这条建议由谁产出"的只读呈现，
   那是信任问题，不是配置问题，见 AI 面板的「产出方」。 */

/* 配置抽屉的开关、遮罩点击、Esc 与焦点归还已随抽屉一起移除，
   配置整体搬到管理后台独立页面（`/admin`，见 admin.html / admin.js）。
   医生端只留一条"去管理后台"的链接，不在这里复制一份配置入口：
   两个地方都能改配置，迟早会出现"改的是哪一处"的混乱。 */

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
  const from = cfg.source === 'store' ? '配置界面' : '默认（离线）';
  /* 时间要给人看：ISO 原始串是机器格式，管理界面上直接甩出来，读的人得自己拆一遍。 */
  const when = (iso) => {
    const time = new Date(String(iso));
    return Number.isNaN(time.getTime()) ? String(iso) : time.toLocaleString('zh-CN', { hour12: false });
  };
  $('cfgCurrent').textContent = `当前：${cfg.modelId || '—'} · 来源 ${from} · 密钥${cfg.apiKeyPresent ? '已配置' : '未配置'}`
    + (cfg.updatedBy ? ` · 最近由 ${cfg.updatedBy} 于 ${when(cfg.updatedAt)} 修改` : '');
  /* 原先这里按临床模式隐藏"配置管理"入口（入口已搬去管理后台，见 admin.html）。
     内置规则列出来：医生看到"缺记录时间"这条提示时，应当能查到它出自哪条规则 */
  const rules = Array.isArray(S.formRules) ? S.formRules : [];
  const rulesCell = $('cfgFormRules');
  if (rulesCell) rulesCell.textContent = rules.length === 0 ? '未加载' : rules.map((r) => `${r.id} ${r.title}`).join('；');
  renderPlacementPanel();
  renderSignPanel();
  renderReadingAuthorityPanel();
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

/* 落位配置表单：与模型配置同属"每次 state 更新都要同步"的内容（`/api/state` 已下发 `placement`） */
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
  /* 密钥永不回显：每次渲染都清空（同模型面板） */
  $('cfgPlaceApiKey').value = '';
  syncPlacementTerms(strategy);
  const from = pl.source === 'store' ? '配置界面' : '默认';
  $('cfgPlacementCurrent').textContent = `当前：策略 ${strategy} · 上限 ${pl.confidenceCeiling ?? 0.85} · 来源 ${from}`
    + (pl.updatedBy ? ` · 最近由 ${pl.updatedBy} 修改` : '');
}

/* --------------------------- 医院签名服务（声明式映射） ---------------------------
   字段映射是给"不同医院的签名服务"用的：换医院只填映射，不改代码。
   没有"内置软件签名"这一档：本系统唯一的签名后端就是这套服务，
   未配齐就签不了章（`E_SIGN_NOT_CONFIGURED`），绝不回退演示密钥。 */

/**
 * 授权平台配置回显。
 *
 * 这里只有"信任哪个平台"一件事，没有"演示替身"这一档：
 * 一个"本系统也能签发"的开关，迟早会被当成生产可选项打开。
 */
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

/**
 * 保存授权平台配置。
 *
 * 公钥留空 = 不修改（不回显全文，也就无法通过留空把它"悄悄"清掉，
 * 清掉等于没有信任根，受控阅读会整块不可用）。平台地址可单独改，留空即清空。
 */
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
  /* 密钥永不回显：每次渲染都清空 */
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
  const from = cfg.source === 'store' ? '配置界面' : '未配置';
  /* 未配置时要明说后果（签不了章），而不是只说"没配"，
     否则用户只会遇到"签章失败"，却找不到原因；而这里连"还缺哪一格"都给了。 */
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
  /* 密钥三态：留空 = 不改（不传该字段）；显式 null = 清除；填了 = 设置。
     把"留空"当成"清空"，会让管理员只改个地址就把密钥弄丢。 */
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

/**
 * 保存落位配置。
 *
 * 界面把两种策略的规则统一成"关键词=节点"一张表，保存时按策略分发：
 *   - `section-title` → `sectionMap`（对象）；
 *   - `term-table` → `termMap`（数组）。
 * 界面上只有一处要填（少一处就少一处配错的机会），而服务端仍能对两种形状分别校验。
 * 注意没有"自动落位"选项：策略只决定建议的初始落点，未命中就是"未落位"。
 */
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
    /* 外部落位：地址 / 超时；**密钥值单独走 `apiKey`**（单独一行加密落库、永不回显）。
       留空 = 不改（不传该字段）—— 把"留空"当成"清空"会让只改地址的人把密钥弄丢。 */
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
    setPlaceStatus('已保存：下次转写即按新策略落位（改完立即生效，无需重启）');
    await apply(r);
    renderPlacementPanel();
  } else {
    setPlaceStatus(`保存失败：${(r && (r.message || r.code)) || '未知原因'}`);
  }
}

/**
 * 保存签名服务配置。
 *
 * 服务地址是这段配置的锚：地址留空 = 未配置签名服务（签章随之不可用，这是明确行为）。
 * 此时不提交 `http` 段，免得"映射填了一半、地址忘填"被当成一份半成品配置存下来，
 * 那会让人以为"配过了"。期望指纹与预置公钥照常提交：它们不属于 http 段，是身份信息。
 */
async function saveSignBackendFromForm() {
  const body = { adminId: $('cfgAdmin').value.trim() };
  /* 密钥值**单独提交**（单独一行加密落库、永不回显）；留空 = 不改（不传该字段） */
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

/**
 * 建议列表的显示开关。
 *
 * 只影响显示，不影响数据与指标：已处理（含被拒绝的）经历是留痕与拒绝率的一部分，
 * 默认收起是为了让待办清爽，不是为了看不见（计数行始终把三类条数摆出来）。
 */
let showProcessedSuggestions = false;

/**
 * 上一次产出被判定为"重复"时的提示（幂等规则见 `core/suggestions.ts` 的 `add`）。
 *
 * 需要显式提示：幂等命中时界面上没有多出一条，不说清就会被当成"点了没反应"（系统坏了）。
 * 它在"任何其它动作"发生时清空，这句话只对刚刚那一下有意义。
 */
let suggestionNotice = '';

/**
 * 正文卡片上那一行提示（粘贴结果 / 撤销结果 / 已签章提醒）。
 *
 * 与 `suggestionNotice` 同一处置："点了没反应"必须能说出原因，粘贴被按外来内容处理、
 * 撤销撤掉了哪一条、已签章为什么改不了，都要有地方讲。
 */
let docNotice = '';

/**
 * 已采纳建议的改动幅度标签（三级归因落到**条**上）。
 *
 * 四种情况必须可分：
 *   · `heavy` / `light` → 标出来（前者多半是事实或结构不对，后者是措辞）；
 *   · `as-is` → **不加标签**：原样采纳是最干净的情况，加标签只会让界面变吵；
 *   · 无记录（`null`）→ 明说"幅度未记录"，**不显示成原样采纳** ——
 *     把"不知道"说成"模型写对了"，与指标面板把未归因并进原样是同一个错。
 *
 * 分档值由服务端下发（`editBandOf` 只在内核一处）：前端不自己定那个 0.2 的边界。
 */
function chipEditBand(s) {
  const base = '<span class="chip ok">已采纳</span>';
  const pct = typeof s.editRatio === 'number' ? ` ${Math.round(s.editRatio * 100)}%` : '';
  if (s.editBand === 'light') return `${base} <span class="chip">人工微改${pct}</span>`;
  if (s.editBand === 'heavy') return `${base} <span class="chip warn">人工大改${pct}</span>`;
  if (s.editBand === 'as-is') return base;
  return `${base} <span class="chip warn">改动幅度未记录</span>`;
}

/**
 * 沉默报告：本次 AI 调用**没产出**的目标节点与原因。
 *
 * 为什么非显示不可：医生对 AI 的信任崩塌，通常不是因为它写错了，而是因为它**不知道它没写**。
 * "这次没提示"会被读成"查过了没问题" —— 与质控里"没判"被读成"没问题"是同一个错误，
 * 而那个错误本仓库已经修过两次（形式类的未判定、内涵类的未报告规则），这是第三次。
 *
 * 三种状态必须互相可分：
 *   · `null`     → 还没调过 AI（**不能**显示成"本次没有跳过"）
 *   · 跳过为空   → 本次范围全部产出（这是值得说出来的事实，不是无话可说）
 *   · 跳过非空   → 按档位**分组计数**（同一档出现十次时，逐条列出会把真正要看的那档淹掉）
 */
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
    /* 档位的人话名由服务端下发（`AI_SILENCE_LABELS`）；缺了就退回原因码原文，
       而不是在前端编一个中文名 —— 编了就是两处口径，日志与界面迟早对不上 */
    const label = item.label || item.code;
    tally.set(label, (tally.get(label) || 0) + 1);
  }
  const detail = [...tally].map(([label, count]) => `${label} ×${count}`).join('；');
  /* 被丢弃的自述也要说：那说明产出方在**理由**上说了假话（幻觉节点 / 自相矛盾 / 自造原因码），
     不报出来就等于替它把这件事擦了 */
  const rejected = Array.isArray(silence.rejected) ? silence.rejected.length : 0;
  const rejectedNote = rejected > 0 ? `；另有 ${rejected} 条跳过说明不合规，已忽略` : '';
  line.className = 'muted warn-text';
  line.textContent = `${summary}，未产出 ${skipped.length} 个：${detail}${rejectedNote}`;
}

/* ------------------------- 逐句审阅（采纳前先看清改了哪句） -------------------------
 *
 * ## 它解决什么
 *
 * 原来的卡片只有一个大文本框：AI 写了什么、和自己已经写的差在哪，全靠医生**逐字读**。
 * 而病历里"改动"其实是**句级**的 —— 加一句、删一句、把一句换掉。
 * 于是这里把建议与现正文按句对齐，逐句给出"新增 / 删除 / 改写"，并让人逐句取舍。
 *
 * ## 三条不越界
 *
 * 1) **不伪造逐句置信度**：`confidence` 是**整条建议**的口径（模型没按句给分），
 *    所以置信度只在卡片顶部出现一次，句子行只标"它是什么改动"。给每句编一个分数，
 *    等于把"整条可信"伪装成"每句都验过"，正好是这套系统最不能做的事。
 * 2) **不改写路径**：逐句取舍只是**算出最终文本**，落笔仍然是一次
 *    `acceptSuggestion({ editedText })` —— 一条留痕、一次门控、一个 `editRatio`。
 * 3) **勾选只是草稿**：它不落盘、不产生 rev；关掉页面就没了，这与"建议不是文档内容"同源。
 *
 * ## 为什么默认值是可解释的
 *
 * 采纳的语义是"整段被这条文本替换"，所以：AI 的新增句/改写句**默认采纳**，
 * AI 没提的原句**默认删除**（这正是"替换"的字面含义），而"保留原句"需要医生主动勾。
 * 反过来（默认全保留）会让"直接采纳"变成一个几乎不改动的动作，指标也随之失真。
 */

/** 建议 id → 它的句子级对照（每次渲染重建；勾选状态也只活在这一屏） */
const sentenceReviews = new Map();

/** 目标节点的当前正文（只有文本节点才有可对照的句子） */
function nodeTextOf(nodeId) {
  const item = (Array.isArray(S.items) ? S.items : []).find((node) => node.id === nodeId && node.kind === 'text');
  return item ? String(item.text || '') : null;
}

/** 按句切分：句末标点归前一句（"体温 36.5℃。" 是一整句，不是"体温 36.5℃"+"。"） */
function splitSentences(text) {
  const source = String(text || '');
  if (source === '') return [];
  const parts = source.match(/[^。！？；!?;\n]+[。！？；!?;\n]*|[。！？；!?;\n]+/g) || [];
  return parts.filter((part) => part !== '');
}

/**
 * 句子级 LCS —— 只用来**对齐**，不用来算相似度。
 *
 * 为什么不用字符级 diff：中文病历一句话二三十字，字符级 diff 会把"改为"拆成一堆碎块，
 * 读起来比原文还慢；而医生真正判断的是"这句要不要"。
 */
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

/**
 * 一段"连续的删/加"合成若干条"改写"：分开显示会让人以为是两件事。
 *
 * ⚠️ 必须**按组配对**，不能"遇到就合并"：连着删两句再加两句时，逐条合并会把
 * 第一句删的文本配到**最后一句加**的文本上（实测样例：删「伴咳嗽。」「既往高血压病史。」
 * 后加「伴咳嗽、咳痰。」「既往体健。」，逐条合并得到的是"既往高血压病史。=>伴咳嗽、咳痰。"，
 * 医生一眼就会觉得这系统不认识字）。按组内第 i 个删配第 i 个加，才是位置对齐。
 */
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

/** 一行在最终文本里贡献什么（`equal` 恒定；其余看勾选） */
function reviewRowText(row) {
  if (row.type === 'equal') return row.text;
  if (row.type === 'del') return row.pick ? row.text : '';
  if (row.type === 'ins') return row.pick ? row.text : '';
  return row.pick ? (row.after || '') : (row.before || '');
}

/** 按当前勾选拼出最终文本（顺序完全跟着 diff 走，所以句子不会跑位） */
function composeReview(review) {
  return review.rows.map(reviewRowText).join('');
}

/**
 * 由勾选结果算出"最终文本里哪几段是 AI 写的"。
 *
 * 只有"采纳了 AI 的那一句"（新增 / 改写且勾选）才算 AI；医生保留的原句**一个字都不标**。
 * 偏移按**拼出来的文本**累计，所以与 `composeReview` 必然对齐 —— 两处若各算一遍，
 * 迟早会出现"文本对、区间差一位"的错位，而那会让整段来源全部错位一格。
 */
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

/* 勾选与手改：都只改"草稿文本"，不落盘（见上面三条不越界）。
   用事件委托而不是逐条绑：卡片是整片 innerHTML 重画的，绑在元素上的监听活不过一次渲染。 */
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

/* 句级导航：↑/↓（或 j/k）在改动行之间走，空格取舍，Enter 采纳整条。
   为什么不把 Tab 劫持成"下一句"：Tab 是浏览器的焦点顺序，用户还要靠它走出卡片 ——
   抢走它，键盘用户就再也出不去了。复选框本身可聚焦，Tab 照样能用；
   这里只是给"逐句走查"多一条更顺的路（走完不必回到鼠标）。 */
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

function renderSuggestions() {
  const all = S.suggestions;
  /* 对照表每次重建：节点正文可能刚被改过，拿上一轮的句子来对齐就会指向已不存在的文字 */
  sentenceReviews.clear();
  const pending = all.filter((item) => item.status === 'pending');
  const acceptedCount = all.filter((item) => item.status === 'accepted').length;
  const rejectedCount = all.filter((item) => item.status === 'rejected').length;
  const list = showProcessedSuggestions ? all : pending;
  /* 计数行始终把三类都摆出来：过滤是显示选择，不是让已处理的消失 */
  $('suggCounts').textContent = `待处理 ${pending.length} · 已采纳 ${acceptedCount} · 已拒绝 ${rejectedCount}`;
  $('btnToggleProcessed').textContent = showProcessedSuggestions ? '只看待处理' : '显示已处理（含拒绝）';
  $('suggNotice').textContent = suggestionNotice;
  $('thresholdHint').textContent = `门控：一般内容 ≥ ${S.thresholds.general} 可落笔；关键内容 ≥ ${S.thresholds.key}。低于阈值只能拒绝或继续修改。`;
  /* 沉默报告要在**任何 return 之前**渲染：列表为空时（"产出方一条都没给"）
     它恰恰是最该出现的东西 —— 空列表配上沉默原因，才不是一句无从追问的"暂无建议" */
  renderAiSilence();

  /* 产出方必须显示：离线模板与真模型产出的建议，信任程度完全不同。
     只报**是谁产的**（服务地址与配置来源属部署参数，不进医生页面）。 */
  const model = S.model || {};
  $('modelInfo').textContent = model.modelId ? String(model.modelId) : '—';
  /* 前面留空格：它紧跟在 modelId 后面，不空格会粘成"offline:landed-v2离线模板" */
  $('modelHint').textContent = ' ' + (model.format === 'offline' ? '离线模板（未接入真实模型）' : '在线模型');

  /* 组条：一次提交（整批 / 语音 / 草稿）产出的多条建议可以整组操作。
     把"组级采纳不绕过门控"写在界面上，否则医生会以为"接受本组" = 全部落笔。 */
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
    /* 空态要分清两种：本来就没有 vs 待处理已清空，
       后者若也只说"暂无建议"，医生会以为处理过的记录丢了。 */
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
    /* 逐句对照只对"待处理的文本建议"有意义：已处理的只是记录，没有可取舍的东西 */
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

/* ------------------------------ 机读信息 ------------------------------ */

function renderMachine() {
  const m = S.machine;
  const badge = $('machineBadge');
  badge.className = 'chip ' + (m.stale ? 'danger' : 'ok');
  badge.textContent = m.stale ? '陈旧，需重算' : '最新';
  /* 指纹（sourceHash）不进界面：它是内部校验值，医生既看不懂也无法据此做任何操作，
     摆出来只会让人以为"机读信息里有一串看不懂的东西"。陈旧判定照旧按指纹做，只是不展示。 */
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

/* ------------------------------ 定稿导出 ------------------------------ */

/* ------------------------------ 定稿导出 ------------------------------
   一个主按钮 + 一份产物清单：顶栏的「导出」只产出归档产物（OFD-H），
   "这份病历产出过什么、各自什么状态、怎么取走"全在清单里说清，
   两种产物用途不同（归档封存 / 跨系统交换），摆成两张卡就不必再用一段话去解释它们的区别。 */

function renderExport() {
  const e = S.lastExport;
  const w = S.lastWst500;
  /* 「解锁修改」只在已签章时出现：没签章就"解锁"，是摆一个没意义的按钮 */
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

/**
 * 签名后端的人话名字。
 *
 * `provider` 是审计用的机器标识（`http` / `software`），直接摆在医生面前几乎等于没写：
 * 他要判断的是"这份病历由谁盖的章"，而不是"走没走 HTTP"。原始标识不丢，
 * 放在 `title` 里，留痕里也一直是原值。
 */
function providerLabel(provider) {
  if (provider === 'http') return '医院签名服务';
  if (provider === 'software') return '内置软件（演示）';
  return provider || '未知';
}

/**
 * 签名面板：算法 / 后端 / 公钥指纹 / 签章状态。
 *
 * 三态必须分开，而不是"验签通过 / 验签失败"两态：
 *   ① 当前有效：`signatureState.kind === 'valid'` 且独立验签通过；
 *   ② 已被解锁作废（`kind === 'voided'`）：这是一次有理由、有责任人的动作，不是出事了，
 *      它该显示的是"谁、为什么解锁、被作废的是哪一次签章"；
 *   ③ 验签失败（材料还在、状态也说已签章，但内容与签名对不上）：这才是要找人处理的信号。
 *
 * 把 ② 和 ③ 合成一个红色"验签失败"，读起来就是"这份病历被动过手脚"，
 * 而两者的处置完全不同：一个要查文件，一个只需看一眼留痕里的解锁理由。
 */
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
  /* 作废时不列"验签失败"的那几条理由：它们在解锁场景下必然出现（内容改了、摘要自然不符），
     照列只会把人推向"被篡改"的结论。改为把"作废"这件事本身讲清楚。 */
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

/**
 * 审计报告摘要：既要有"几项通过"，也要把未通过的证据直接摆出来，
 * 只显示"通过 5/7"而不说哪两条没过、为什么，等于让人自己去猜（核查场景最忌讳这个）。
 */
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

/**
 * 受控阅读面板：授权清单 + 最近一次受控视图 + 拒绝原因。
 *
 * 界面要让人一眼看出三件事：
 *   ① 这份授权还能读几次、读到什么时候、限哪台机器；
 *   ② 被拒绝时具体是哪一条控制拦住的（过期？次数？终端？文档被改？）；
 *   ③ 未被授权的章节不显示内容，但必须显示"有 N 个章节未授权"。
 */
/** base64 → PEM 文本（纯展示：便于线下交换，服务端始终只存 base64） */
function pemFromBase64(base64) {
  const wrapped = String(base64 || '').replace(/(.{64})/g, '$1\n').trim();
  return `-----BEGIN PUBLIC KEY-----\n${wrapped}\n-----END PUBLIC KEY-----`;
}

function renderReading() {
  const body = $('readingBody');
  if (!body) return;

  /* 接收方公钥目录：它现在是「交付目标」的登记处（供授权平台封装内容密钥），
     不再参与签发，本系统不签发授权，所以这里没有"选接收方"的下拉。 */
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
  /* 真实数据验证入口：文档 JSON 是独立探针（S2 保真 / S3 留痕回放 / S5 模型校验）的输入，
     它不经过我们的解析结论，直接查文档本身是否守规矩。 */
  const jsonLine = S.lastJson
    ? `<div class="chip ok mb8">已导出文档 JSON：${esc(S.lastJson.file)}（${S.lastJson.nodes} 节点 / ${S.lastJson.bytes} 字节），可直接供 S2/S3/S5 独立探针使用</div>`
    : '<div class="muted mb8">尚未导出文档 JSON（供独立探针核对）。</div>';
  if (grants.length === 0) {
    body.innerHTML = `${jsonLine}<div class="empty">尚无阅读授权：签章后的病历默认不出库。要给人看，需由<b>授权源</b>签发授权（演示模式下在「配置管理 → 受控阅读」）。</div>`;
    return;
  }

  /* 授权清单上要能看出"签发者还在不在信任集里"：换了授权源之后，旧授权会立刻变成读不了，
     这件事必须在列表上看得出来，否则用户只会遇到"被拒"却找不到原因。 */
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

/* ------------------------------ 导入来源 ------------------------------ */

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
  /* 签章状态与"验签结论"必须分开显示：
     "已签章"只说文件里带了签名文件，"验签通过"才说明被覆盖的文件与签名一致。
     只显示前者会把"文件可能被改过"藏起来。 */
  const verified = info.signatureVerified;
  const algorithm = info.signatureAlgorithm || '';
  let signature;
  if (!info.signed) signature = '<span class="chip">源文件未签章</span>';
  else if (info.signaturePlaceholder) signature = '<span class="chip warn">源签名为占位符（不能作合规证据）</span>';
  else if (verified === true) signature = `<span class="chip ok">源文件已签章 · 验签通过（${esc(algorithm)}）</span>`;
  else if (verified === false) signature = `<span class="chip danger">源文件已签章 · 验签失败（${esc(algorithm)}）</span>`;
  else signature = '<span class="chip warn">源文件已签章 · 未验签（缺少签名材料）</span>';
  /* 段落重建：把"切了多少段、其中多少段是猜的"直接摆出来。
     低置信段落是必须让人看见的信息，那部分边界需要人工确认。 */
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

/* ------------------------------ 日志/指标 ------------------------------ */

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
  /* 三级归因（原样 / 微改 / 大改）：修改率只能回答"改没改"，而"改一个错字"与"整段重写"
     要改的东西完全不同 —— 前者是提示词，后者是上下文供给（取数没到 / 模板没给）。
     口径由服务端算好下发（`editRatioOf` 只在内核一处），前端不自己算一份。
     `unknown`（没有改动幅度记录的采纳）**有才占位**：把它并进"原样采纳"就是让指标
     无端变好，而它出现的唯一原因是老数据 / 别的来源写入 —— 那件事该被看见，不该被抹平。 */
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
}

/* --------------------------- 折叠面板徽标（收起也能看状态） --------------------------- */

function renderPanelBadges() {
  const pending = S.suggestions.filter((s) => s.status === 'pending').length;
  const lastError = S.log.find((l) => !l.ok);

  $('badgeAi').innerHTML = `<span class="chip">建议 ${S.suggestions.length}</span>${pending ? ` <span class="chip warn">待处理 ${pending}</span>` : ''}`;

  /* 质控提示的页签圆点：待处理与"锚点丢失"都该被看见，
     锚点丢失不处理会一直挂着，那是设计使然（不能静默消失） */
  const annoCounts = S.annotationCounts || { open: 0, acknowledged: 0, anchorLost: 0 };
  const annoPending = annoCounts.open + annoCounts.acknowledged;
  const qcDot = $('tabDotQc');
  qcDot.className = `tdot${annoPending > 0 || annoCounts.anchorLost > 0 ? ' warn' : ''}`;
  qcDot.title = `待处理提示 ${annoPending} · 锚点丢失 ${annoCounts.anchorLost}`;

  /* 时间轴页签的圆点：这条线上有缺口时亮起。
     缺口与提示是同一件事的两个形态，提示有圆点而缺口没有，等于把"线断了"藏起来 */
  const timeline = S.visitTimeline;
  const timelineDot = $('tabDotTimeline');
  if (timelineDot) {
    const gaps = timeline ? timeline.gaps.length : 0;
    timelineDot.className = `tdot${gaps > 0 ? ' warn' : ''}`;
    timelineDot.title = timeline ? `就诊时间轴：缺口 ${gaps} 条` : '尚未读取就诊时间轴';
  }

  /* 语音页签的圆点：有转写结果时亮起（提示"这里有一组待处理的建议"） */
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

/* ------------------------- 模板（按模板新建文书） ------------------------- */

/** 就诊类型的中文名。界面上一律用中文：`outpatient` 是模型里的取值，不是给医生读的词 */
const VISIT_SCOPE_LABEL = { outpatient: '门诊', emergency: '急诊', inpatient: '住院' };

/**
 * 这份模板能不能开在本次就诊上。
 *
 * 判据来自服务端随模板下发的 `visitTypes`（口径只有一处：`template-pack.ts` 的
 * `visitTypesOfDocType` —— 入院记录 / 病程记录 / 出院记录属住院，门（急）诊病历属门诊与急诊）。
 * **空数组 = 不限**：认不出类型（院内自定义、导入件）就照旧列出来 ——
 * 我们不知道它属于哪一档，藏起来还解释不了"为什么这里没有它"。
 */
function templateFitsVisit(tpl, visitType) {
  const scope = Array.isArray(tpl.visitTypes) ? tpl.visitTypes : [];
  if (scope.length === 0 || !visitType) return true;
  return scope.includes(visitType);
}

/**
 * 「新建」：先问"开哪一类文书"，再按选中的模板建。返回 `templateId`，取消返回 null。
 *
 * 为什么是弹框而不是左栏一个下拉：左栏只有 238px，下拉里只放得下名字，
 * 而选它的依据是"这是什么文书 / 有多厚 / 这次就诊开不开得出"。弹框里一条一项，
 * 名称与说明分两行，且**只列本次就诊开得出的那几类** ——
 * 门诊 / 急诊只开「门（急）诊病历」，住院只开「入院记录」「病程记录」「出院记录」，
 * 列一份开不出来的，等于让人点进去再被拒一次。
 */
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
    /* 有模板、但一份都不是这次就诊能开的：说清"为什么没有"，而不是给一个空清单 */
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

/* ------------------------------- 总入口 ------------------------------- */

function renderAll() {
  /* 编辑范式决定的是**正文怎么画**，所以类名必须在 `renderDoc()` 之前就位 ——
     晚一步的后果是流式那一屏先按卡片模式的样式排一次版，看起来像闪了一下。 */
  document.body.classList.toggle('flow-mode', isFlow());
  /* 就诊范围要先于各栏渲染：切到门诊时，被摘掉的页签不能还亮着 */
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
  /* 模式选择器与状态保持同步（重渲染不重置用户的选择） */
  document.body.classList.toggle('clinical', isClinical());
  const viewSelect = $('viewMode');
  if (viewSelect && viewSelect.value !== viewMode) viewSelect.value = viewMode;
  /* 编辑范式同理：类名已经在 `renderAll` 开头就位（见那里的说明），
     这里只把切换器与工具栏的可见性跟状态对齐 */
  syncEditMode();
  const tools = $('flowTools');
  if (tools) tools.hidden = !isFlow();
  renderImport();
  renderMachine();
  /* 能力缺席时对应面板已被摘除：摘了就不再渲染（渲染函数摸到 null 会直接抛）。
     这三个在 renderAll 里都只有这一处调用点，所以守在这里是完整的。
     `renderImport` 不在此列：它渲染的是左栏"导入来源卡"（`importCard`），
     而能力开关摘掉的是顶栏那个"导入病历文件"按钮 —— 两者职责不同。 */
  if (panelAlive('export')) renderExport();
  if (panelAlive('log')) renderLog();
  if (panelAlive('metrics')) renderMetrics();
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

  /* 质控提示的目标节点：与建议共用同一份候选（同一个"内容节点"概念） */
  const qcSelect = $('qcTarget');
  const qcCurrent = qcSelect.value;
  qcSelect.innerHTML = optionsOf();
  if (qcCurrent) qcSelect.value = qcCurrent;
}

async function apply(result) {
  if (result && result.state) { S = result.state; renderAll(); }
  else await refresh();
  /* 全局回执：操作有结果就让人看见。失败尤其重要，没有回执时，
     医生的反应是"再点一次"，而不是"看为什么没生效"。 */
  if (result && result.ok === false) toast(`${result.code || ''} ${result.message || ''}`.trim(), 'danger');
  else if (result) toast('已生效', 'ok');
  return result;
}

let toastTimer = null;

function toast(text, kind) {
  const el = $('toast');
  if (!el) return;
  el.textContent = text;
  el.className = kind === 'danger' ? 'toast danger' : kind === 'info' ? 'toast info' : 'toast';
  /* 紧急程度对读屏可见：失败要打断（assertive），成功不必（polite） */
  el.setAttribute('aria-live', kind === 'danger' ? 'assertive' : 'polite');
  el.hidden = false;
  clearTimeout(toastTimer);
  /* 失败停留更久：错误码需要时间读 */
  toastTimer = setTimeout(() => { el.hidden = true; }, kind === 'danger' ? 4200 : 2600);
}

async function refresh() {
  const res = await api('/api/state');
  if (res.ok) { S = res.state; renderAll(); }
  return res;
}

/* ------------------------------- 交互 ------------------------------- */

/* 视图模式切换：改模式后必须整体重渲染，因为内部标识是条件渲染的，
   不重渲染的话，界面会停在上一个模式的形态（那比不做模式更糟） */
document.addEventListener('change', (event) => {
  const el = event.target;
  if (!el || el.id !== 'viewMode') return;
  viewMode = el.value === 'clinical' ? 'clinical' : 'demo';
  try { localStorage.setItem(MODE_KEY, viewMode); } catch { /* 隐私模式忽略 */ }
  renderAll();
});

/* 编辑范式切换器（卡片 / 流式）是一个**分段控件**（见 ui.html 的 `.seg` 与 ui.css 同名块）。
   它的全部状态只有两个：容器上的 `data-mode`（决定滑块停在哪一段）与每段的 `aria-checked`。
   都在这里一次同步完 —— 分两处写，重渲染之后必然出现"滑块在流式、正文还是卡片"的错位。 */
function syncEditMode(mode = editMode) {
  const seg = $('editMode');
  if (!seg) return;
  seg.dataset.mode = mode;
  seg.querySelectorAll('.seg-item').forEach((item) => {
    const on = item.dataset.mode === mode;
    item.setAttribute('aria-checked', on ? 'true' : 'false');
    /* 单选组的 Tab 只停一次，停在当前选中的那一段上（roving tabindex）：
       否则键盘用户要按两下 Tab 才能从这组里走过去，还得先猜哪一段是被选中的。 */
    item.tabIndex = on ? 0 : -1;
  });
}

/* 换范式后正文会整片重画，给它一次"重新排过一次版"的提示（见 ui.css 的 `.paper-swap`）。
   只在换范式时放：落笔也重画正文，那时也放就成了"每写一个字纸面闪一下"。 */
function paperSwap() {
  const host = $('docBody');
  if (!host) return;
  host.classList.remove('paper-swap');
  /* 读一次布局：同一次会话里来回切也看得见（不读的话第二次加同一个类名不会重放动画） */
  void host.offsetWidth;
  host.classList.add('paper-swap');
  host.addEventListener('animationend', () => host.classList.remove('paper-swap'), { once: true });
}

/* 编辑范式切换：**先落笔再换**（换模式会重画正文，没落笔的改动会随之消失，
   而那种"我的字不见了"没有任何提示，是最伤信任的一类失败）。
   换完必须整体重渲染：两种模式的正文 DOM 完全不是一回事。 */
async function setEditMode(mode) {
  const next = mode === 'flow' ? 'flow' : 'card';
  if (next === editMode) return;
  /* 滑块先走：落笔要等一次网络往返，等它回来才动滑块的话，点下去就像没反应 */
  syncEditMode(next);
  await flushEdits();
  editMode = next;
  try { localStorage.setItem(EDIT_MODE_KEY, editMode); } catch { /* 隐私模式忽略 */ }
  renderAll();
  paperSwap();
}

document.addEventListener('click', (event) => {
  const target = event.target;
  const item = target instanceof Element ? target.closest('.seg-edit .seg-item') : null;
  if (!item) return;
  void setEditMode(item.dataset.mode);
});

/* 单选组的键盘约定：左右方向键在选项之间走，并**立刻选中**（原生 radio 就是这样，
   "走一格还要再按一下确认"是另一种约定，两套混用会让人以为键盘坏了）。
   Tab 在整组上只停一次（roving tabindex 由 `syncEditMode` 维护）。 */
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

/* 落位策略切换：只调整规则表的可用性，不回显表单，
   回显会拿 state 里的旧策略覆盖用户刚选的策略（那正是"点了没反应"的典型现场） */
document.addEventListener('change', (event) => {
  const el = event.target;
  if (el && el.id === 'cfgPlaceStrategy') syncPlacementTerms(el.value);
});

/* ---------------------------- 命令面板（Ctrl+K） ----------------------------
 *
 * 医生的手离开键盘一次，就要"找鼠标 → 找按钮 → 找位置"三步；而跳段落、插检验值、
 * 套模板、查术语原本分散在左栏、右栏、顶栏与正文四处。面板把这四件事收成一次 Ctrl+K。
 *
 * 四条纪律（与下面的快捷键体系同源，缺一条它就从"省事"变成"又一个要背的东西"）：
 *   ① 打开前先记下光标 —— 面板会抢走焦点，落点只能提前存；
 *   ② 不新增写路径 —— 插入走 `/api/edit`、套模板走 `/api/template-create`，
 *      门控、留痕、乐观锁一条都不绕；
 *   ③ 插入不猜位置 —— 没有光标就明说"先点进某一段"，绝不往"最后一段"里塞；
 *   ④ 不可逆动作不进来 —— 删除文书、重置工作区一律不在这里。
 *
 * 面板本身只是界面件（`/command-palette.js`）：它不知道 S、不知道 api()，
 * 候选与动作全部由这里注入 —— 于是"面板长什么样"与"命令能改什么"是两件独立的事。
 */

/** 打开面板那一刻的光标。`null` = 当时没有落点（例如从顶栏按钮打开的）。 */
let paletteCaret = null;

/** 正文里能"定位到"的那一个元素。几种节点各有自己的锚点属性。 */
function anchorOfNode(item) {
  if (!item || !item.id) return null;
  const body = $('docBody');
  if (!body) return null;
  const quote = (value) => (window.CSS && typeof window.CSS.escape === 'function'
    ? window.CSS.escape(String(value))
    : String(value).replace(/["\\]/g, '\\$&'));
  const pick = (attr, value) => body.querySelector(`[${attr}="${quote(value)}"]`);
  /* 顺序按"最贴近可写的那一格"排：文本节点的外层 div 也带 `data-node-id`，
     先取外层就只能高亮、不能把光标放进去。`data-edit` / `data-field` 才是真正能打字的那个元素。
     章节标题在卡片模式下没有锚点（`doc-view.js` 画的是裸 `.sec`），
     所以章节一律由调用方换成它下面的第一段 —— 在这里猜一个选择器，只会猜出"点了没反应"。 */
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
  /* 高亮画在"整块"上：一个流式段落里可能有好几个节点，只亮那一个 input 说不清是哪一段 */
  const box = (el.closest && (el.closest('.node, .fp, .fcard, .fsec') || el)) || el;
  box.classList.add('node-hit');
  setTimeout(() => box.classList.remove('node-hit'), 1600);
  /* 跳过去多半是为了接着写，所以顺手把光标放进去 */
  if (el.matches && el.matches('textarea[data-edit]')) {
    el.focus();
    const end = el.value.length;
    try { el.setSelectionRange(end, end); } catch { /* 只读态不支持，忽略 */ }
  } else if (el.matches && el.matches('input[data-field]')) {
    el.focus();
    if (typeof el.select === 'function') el.select();
  }
}

/** 打开面板**之前**记下落点：面板一 showModal()，activeElement 就变成它自己的输入框了 */
function capturePaletteCaret() {
  const el = document.activeElement;
  if (el && el.tagName === 'TEXTAREA' && el.dataset && el.dataset.edit) {
    return {
      nodeId: el.dataset.edit,
      start: typeof el.selectionStart === 'number' ? el.selectionStart : null,
      end: typeof el.selectionEnd === 'number' ? el.selectionEnd : null,
    };
  }
  /* 流式模式：光标在 contenteditable 里，真正的节点是它所在的那个段落块 */
  if (isFlow()) {
    const selection = window.getSelection();
    const anchor = selection && selection.anchorNode ? selection.anchorNode : null;
    const host = anchor && (anchor.nodeType === 1 ? anchor : anchor.parentElement);
    const block = host && typeof host.closest === 'function' ? host.closest('.fp[data-node-id]') : null;
    if (block && block.dataset.nodeId) return { nodeId: block.dataset.nodeId, start: null, end: null };
  }
  return null;
}

/**
 * 把一句话写进"打开面板时的那一段"。
 *
 * 为什么不是"插成新段落"：医生打开面板要插入检验值，位置就在他刚写的那句话里；
 * 新建一段会把这个值挪到段尾，而段尾往往已经是"诊疗计划"了。
 */
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
    try { target.setSelectionRange(position, position); } catch { /* 只读态不支持，忽略 */ }
  }
}

/**
 * 候选清单：全部从**当前状态**现算，不缓存。
 *
 * 空查询时排在最前的是"命令 + 面板"（它们永远用得上）；一旦输入关键词，
 * 跳段落 / 检验值 / 模板 / 术语都会进入同一份结果里 —— 面板的价值正在于"不用先想这是哪一类"。
 */
function paletteCommands() {
  const commands = [];
  const items = Array.isArray(S && S.items) ? S.items : [];
  const templates = Array.isArray(S && S.templates) ? S.templates : [];
  const tree = Array.isArray(S && S.tree) ? S.tree : [];
  const modeLabel = { card: '卡片', flow: '流式' };
  const nextMode = isFlow() ? 'card' : 'flow';

  /* ① 命令：都是"别处有按钮，但找它要动鼠标"的那几件事 */
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

  /* ② 面板：与「更多」菜单里那几项同源，标签直接读页签上的字，不另写一份（两份必然漂） */
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

  /* ③ 套模板：只列本次就诊开得出的，理由与「新建」弹框一致（列一份开不出的等于让人点进去再被拒一次） */
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

  /* ④ 切换文书：当前这一份不必出现（"切到自己"是一次空动作） */
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

  /* ⑤ 正文：章节 / 段落 / 填写项 / 控件，以及由它们派生出的"术语"与"插入检验值" */
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
      /* 只搬"正文里已经有的值"：面板不是取数入口，取数要走 A2 的接口与证据链 */
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
    /* 术语：同一编码只出一条，跳向它第一次出现的地方 */
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
    placeholder: '跳转段落 / 插入检验值 / 套模板 / 查术语',
  });
}

/* 顶栏入口：不按键的人也要有一条路（发现性不是可选项） */
document.addEventListener('click', (event) => {
  if (!event.target.closest || !event.target.closest('#btnPalette')) return;
  openPalette();
});

/* 跨次对比的对象下拉：换一份历史文书就重算一次对照（不写任何东西，纯读） */
document.addEventListener('change', async (event) => {
  const el = event.target;
  if (!el || el.id !== 'comparePick') return;
  await apply(await api('/api/visit-compare', { previousDocId: el.value }));
});

/* ---------------------------- 键盘体系 ---------------------------- */

/* 用途：处理几十条建议时，鼠标要点很多次（定位 → 找按钮 → 点）。
   真实诊室是重度键盘的，没有键盘体系，"批量建议"这个能力就有一半用不出来。
   三条安全约束，任何一条做漏都会变成事故：
     ① 输入态一律禁用单键：在文本框里打字时按 a 会采纳建议，那是事故，不是便利；
     ② 不可逆操作二次确认：拒绝不可逆，单键直拒太危险；
     ③ 必须有可见选中态：否则 j/k 移动后不知道焦点在哪，等于没有这个功能。 */
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

/** 可键盘操作的建议（只有待处理的能动）；与 `#suggestions .sugg:not(.done)` 同序 */
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
  /* ⓪ Ctrl/⌘+K：命令面板。**必须排在"输入态不拦单键"之前** ——
     正在正文里写字时按它才是常态，排到后面等于最需要它的那一刻恰好不响应。
     它也不与单键空间冲突：j/k/a/r 是裸键，这里是组合键。 */
  if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && (event.key === 'k' || event.key === 'K')) {
    event.preventDefault();
    openPalette();
    return;
  }
  /* ① 安全底线：输入态一律不拦单键。
     Esc 是唯一例外，且它只做"失焦"，不触发任何写操作。 */
  if (isTyping()) {
    if (event.key === 'Escape' && document.activeElement && document.activeElement.blur) document.activeElement.blur();
    return;
  }
  /* 不抢浏览器 / 系统快捷键 */
  if (event.ctrlKey || event.metaKey) return;
  if (event.altKey) {
    /* Alt+1..4：四个常驻页签。用组合键而不是单键，避免与将来编辑器自身的按键冲突 */
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
  /* 「更多」菜单必须先于页签分支处理：图标按钮也带 .tab（复用样式），
     若放在后面会被 switchTab(undefined) 截住，菜单永远打不开 */
  if (event.target.closest('#btnMoreTabs')) {
    setMoreMenu($('moreMenu').hidden);
    return;
  }
  const tab = event.target.closest('.tab');
  if (tab) {
    /* 菜单项：选完就收起（不留一个挂着的浮层） */
    if (event.target.closest('#moreMenu')) setMoreMenu(false);
    /* 再点一次当前页签 = 收起 / 放回这一整块：面板收走之后，页签是唯一还看得见的入口，
       恢复入口只能是它自己（同一动作再点一下） */
    if (tab.dataset.tab === activeTab) toggleActivePanelCollapse();
    else switchTab(tab.dataset.tab);
    return;
  }
  /* 点到别处就关掉菜单 */
  if (!$('moreMenu').hidden) setMoreMenu(false);

  /* 面板标题上的折叠按钮只改视图，不是业务动作：必须挡在下面那条"通用按钮"分支之前，
     否则它会被按成 busy（禁用 + 转圈）、还会先 flush 一次编辑 */
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

  /* 清空采集记录：只清**本份病历**的元数据（服务端会再核一次 docId）。
     要问一次 —— 删掉的是"这次到底录成了没有"的线索，而它不能撤销。
     音频本来就不留存，所以这里不需要再提醒"录音也会没"。 */
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

  /* 删除草稿必须挡在 `[data-doc]` 之前：按钮长在病历行内，先走这里才不会顺带切文档。
     不在这颗按钮上写 `stopPropagation` —— 那会连这条委托一起挡掉（按钮就点了没反应）。 */
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
  /* 动作前先落盘未保存的编辑，并取消失焦防抖，避免"保存重绘把按钮点掉"的竞态 */
  clearTimeout(blurTimer);
  await flushEdits();
  /* 「新建」先弹一份可选文书清单：这一步是**选**，不是写，所以不进 busy 态 ——
     清单还开着的时候顶栏挂着"请求中"的进度条，那是谎报。选择走完才发建文书的请求 */
  if (el.id === 'btnTplCreate') {
    const templateId = await pickTemplate();
    if (!templateId) return;
    await apply(await api('/api/template-create', { templateId }));
    return;
  }
  /* 动作期间按钮进入 busy（disabled + aria-busy）：挡住连续点击，读屏也能感知 */
  el.disabled = true;
  el.setAttribute('aria-busy', 'true');
  try {
    /* 任何其它动作都把"上次产出被判为重复"的提示清掉：那句话只对刚刚那一下有意义
       （否则它会一直挂在那里，而这个节点上的待处理建议可能早就被采纳了） */
    if (el.id !== 'btnSuggest' && el.id !== 'btnSuggestBatch') suggestionNotice = '';
    if (el.id !== 'btnUndo') docNotice = '';
    if (el.id === 'btnReloadSidecars') {
      /* 有后果：放弃本终端尚未落盘的旁挂改动。先说清"影响什么、不影响什么"再问一次，
         与「忽略质控提示」「删除本段」同一处置口径。 */
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
      try { localStorage.setItem(THEME_KEY, theme); } catch { /* 隐私模式忽略 */ }
      applyTheme();
      return;
    }
    if (el.id === 'btnExportWst500') { await apply(await api('/api/export-wst500', {})); return; }
    if (el.id === 'btnExportJson') { await apply(await api('/api/export-json', {})); return; }
    if (el.id === 'btnAudit') { await apply(await api('/api/audit-report', {})); return; }
    /* 这里没有"签发授权"按钮：本系统不签发阅读授权（授权由院内授权平台签发，
       经「配置管理 → 受控阅读 → 导入授权凭据」进入）。少一个按钮，就少一条"顺手把病历放出去"的路径。 */
    if (el.id === 'btnImportKey') {
      await apply(await api('/api/recipient-keys/import', {
        label: $('rkLabel').value || '接收方',
        text: $('rkText').value || '',
      }));
      return;
    }
    if (el.dataset.rkRemove) { await apply(await api('/api/recipient-keys/remove', { keyId: el.dataset.rkRemove })); return; }
    if (el.dataset.rkExport) {
      /* 导出只做展示（回填到输入框，便于复制给对方）；服务端始终只存 base64 */
      const key = (S.recipientKeys?.keys || []).find((item) => item.keyId === el.dataset.rkExport);
      if (key) $('rkText').value = pemFromBase64(key.spkiBase64);
      return;
    }
    /* 授权行上的操作按钮是动态渲染的，用 data-* 委托而不是逐个绑监听 */
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
      const r = await api('/api/suggest', {
        nodeId: $('suggTarget').value,
        confidence: Number($('confidence').value),
        mode: $('suggMode').value,
      });
      /* 幂等命中（服务端复用了同内容的待处理建议）必须说出来：
         界面上没有多出一条，不说清就会被当成"点了没反应"（以为系统坏了）。 */
      const reusedId = r.ok && r.data && r.data.reused === true ? String(r.data.suggestionId || '') : '';
      suggestionNotice = reusedId === ''
        ? ''
        : `已有同样内容的待处理建议（${reusedId}），未重复生成。建议数与采纳/拒绝率不受影响。`;
      if (reusedId !== '') showProcessedSuggestions = false;
      await apply(r);
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
      /* 纯显示层切换：不动数据、不发请求（已处理的仍在 state 里，计数行始终摆着三类条数） */
      showProcessedSuggestions = !showProcessedSuggestions;
      renderSuggestions();
      return;
    }
    /* 能力配置整体搬到管理后台（`/admin`）：医生端不摆配置控件，只给一个入口链接。
       链接不是权限，权限在管理后台的登录里（服务端 `requireAdminSession`）。 */
    if (el.id === 'btnAdmin') { window.open('/admin', '_blank', 'noopener'); return; }
    if (el.id === 'cfgTest') {
      /* 测试连接只发一段与病历无关的测试文本：为了验证"配得对不对"而先把病历送出去，是本末倒置 */
      setCfgStatus('测试中…（只发一段与病历无关的测试文本）');
      const r = await api('/api/model-config/test');
      setCfgStatus(r.ok
        ? `连接正常：${r.data.modelId}，耗时 ${r.data.latencyMs}ms`
        : `连接失败：${(r && (r.message || r.code)) || '未知原因'}`);
      return;
    }
    if (el.id === 'btnQcContent') {
      /* 内涵类质控告的是外部引擎（形式类那颗是纯本地）：
         它会把文书内容送去判定，所以必须是单独一颗按钮，不能与形式类混在一起，
         否则医生点下去时并不知道"这一下会把内容发出去"。 */
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
      /* 契约是规格，给实现方看：把要点摊在界面上，完整 JSON 在 `/api/qc-content-contract` */
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
      /* 扫描结果报出来：扫了几个节点、命中几条、新增几条、已在册几条。
         不报数目的话，"跑了但一条没出"与"没跑"在界面上长得一模一样。 */
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
  /* 重新检测本机客户端：只读探测（不打开设备、不发音频）。它不走全局 busy 条
     （"客户端不在"时探测立刻失败，来回一闪反而像闪屏），但**按钮自己必须给出反应**：
     点下去立刻转圈并置灰，落定后重画回常态 —— 结果就是那张状态卡的新结论。
     最短 600ms：探测再快，也要让人看见"这一下被接住了"。 */
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
    /* 就诊时间轴：读一次（服务端把本就诊的全部文书摊开，判定复用已启用的时限规则） */
    if (el.id === 'btnVisitTimeline') { await apply(await api('/api/visit-timeline', {})); return; }
    /* 时间轴上"切到这份"：只换文书，不动正文、不代签。写与签仍然是人的动作 */
    if (el.dataset.openDoc) { await switchDoc(el.dataset.openDoc); return; }
    if (el.id === 'btnCompare') { await apply(await api('/api/visit-compare', {})); return; }
    /* 预问诊：读一次只读（并留痕）；"生成建议"仍不落笔 —— 患者自述进病历必须有医生签字那一步 */
    if (el.id === 'btnPrevisitRead') { await apply(await api('/api/previsit/read', {})); return; }
    if (el.id === 'btnPrevisitTake') {
      const keys = [...document.querySelectorAll('[data-previsit-key]:checked')].map((input) => input.dataset.previsitKey);
      if (keys.length === 0) { toast('先勾选要生成建议的条目', 'info'); return; }
      const result = await api('/api/previsit/take', { keys });
      await apply(result);
      /* 缺章节的条目必须**当面说**：否则人会以为"全生成了"，
         而那几条恰好是患者说得最要紧、文书里却没有位置的内容。 */
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
      /* 沿用上次医嘱：只生成建议。落笔与否由人在这份文书上决定 ——
         一步把上次的方案写进这次，等于让"上一次"替这次签字。 */
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
      /* 忽略是有后果的操作（同规则在同一内容上不会再提示），所以必须先说清再确认 */
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
      /* 部分成功必须说清楚：被拦的条目仍然待处理，医生需要知道是哪几条、
         以及原因是"置信度不足"而不是"系统出错"。静默处理会让医生以为全都落笔了。 */
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
      /* 分级签章：先按默认（不声明）试。
         若被拒的原因是"未确认的 AI / 导入内容"，再明确询问是否声明已通读；
         关键内容未确认则不给这个选项（内核也不会放行），界面上不能代用户勾这个声明。 */
      let r = await api('/api/sign', {});
      if (!r.ok && (r.code === 'E_SIGNED_WITH_UNCONFIRMED_AI' || r.code === 'E_IMPORTED_UNCONFIRMED')) {
        const agreed = await askConfirm(
          `${r.message || '存在未逐条确认的内容'}\n\n你是否已通读并认可这些内容？\n（确认即由你负责，该声明与未确认清单都会记入留痕）`,
          { okLabel: '我已通读并认可', tone: 'danger' },
        );
        if (agreed) r = await api('/api/sign', { acknowledgeUnconfirmed: true });
      }
      await apply(r);
      return;
    }
    if (el.id === 'btnExport') { await apply(await api('/api/export', {})); return; }

    const accept = el.dataset.accept;
    if (accept) {
      const area = document.querySelector(`[data-sugg-text="${accept}"]`);
      const origin = (Array.isArray(S.suggestions) ? S.suggestions : []).find((item) => item.id === accept);
      /* 逐句取舍 / 手改之后，落笔的必须是**医生看到的那个文本**；
         只有与 AI 原稿一字不差时才走"原样采纳"（否则修改率会被记成 0，而人明明改过） */
      const edited = area && origin && area.value !== origin.text ? area.value : undefined;
      /* 逐句归属只对"按勾选组合出来"的文本可信；手改之后归属不可知，
         退回整段口径（由内核按 AI 整段标）—— 多标与少标都不该由前端猜。 */
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
    /* 段落级操作（增 / 移 / 删）：操作单位是段落（服务端从内容节点回溯到段落），
       所以传的是文本节点 id，否则"移一段"会把它的字段落在原地。 */
    const paraInsert = el.dataset.paraInsert;
    if (paraInsert) {
      const r = await api('/api/insert-paragraph', { nodeId: paraInsert });
      await apply(r);
      /* 插入后把光标放进新段落：不聚焦的话，用户还得自己在几十段里找刚建好的那一段 */
      if (r.ok && r.data && r.data.textNodeId) focusEdit(r.data.textNodeId);
      return;
    }
    const paraUp = el.dataset.paraUp;
    if (paraUp) { await apply(await api('/api/move-node', { nodeId: paraUp, direction: 'up' })); return; }
    const paraDown = el.dataset.paraDown;
    if (paraDown) { await apply(await api('/api/move-node', { nodeId: paraDown, direction: 'down' })); return; }
    const paraDelete = el.dataset.paraDelete;
    if (paraDelete) {
      /* 删除没有撤销（撤销要等 revertTo）：所以问一次，并且直说不可恢复。
         关键内容的按钮在渲染时就已禁用，这里是第二道（服务端还会拦第三次）。 */
      if (!(await askConfirm(
        '删除本段（含其中的字段）？\n\n此操作会写入留痕，但内容不可恢复（当前没有撤销）。',
        { okLabel: '删除本段', tone: 'danger' },
      ))) return;
      await apply(await api('/api/delete-node', { nodeId: paraDelete }));
      return;
    }
    /* 贴图：**先上传拿地址，再插进病历**。
       为什么分两步而不是一次把字节送进写路径：上传会失败（格式认不出、超过上限），
       而"失败的半张图"不该先落进病历、再去删它。第二步失败时，字节只是躺在资源目录里
       （内容寻址：同一张图再贴一次还是那一份），不会留下半截病历。 */
    const imageDelete = el.dataset.imageDelete;
    if (imageDelete) {
      if (!(await askConfirm(
        '删掉这张图？\n\n同一段里的正文不会动；图片字节仍留在资源目录里（撤销也还能把它找回来）。',
        { okLabel: '删掉这张图', tone: 'danger' },
      ))) return;
      await apply(await api('/api/delete-image', { nodeId: imageDelete }));
      return;
    }
    /* 图片槽「贴图 / 换图」：改的是**已有**的那个图片节点（模板开出来的空槽）。
       与下面「＋图」的区别只在最后一步：那个是"新插一张"，这个是"把这一格填上"。 */
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
        /* 替代文字先用文件名：它至少能回答"这是哪张片子"，总比空着强 */
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
      const r = await api('/api/undo', {});
      docNotice = r.ok
        ? '已撤销上一次写入；这次撤销本身也写进了留痕（再点一次「撤销」＝重做）。'
        : `未能撤销：${(r && (r.message || r.code)) || '未知原因'}`;
      await apply(r);
      return;
    }
    if (el.id === 'btnUnlock') {
      /* 解锁必须填理由（内核也会拦），所以在界面就问出来，事后追责看的就是这句话。
         不做"默认理由"，也不允许空理由：静默作废一次签章是最不该发生的事之一。 */
      /* 空理由不再"先关掉再弹一句说明"：留在框里当场说明，人才不用从头点一遍
         （系统 prompt 是先关掉才告诉他必须填，而那时理由已经没了） */
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
    /* 章节级确认（左栏「确认本章」）：一次确认整章子树内的内容节点。
       范围与条数由服务端写进留痕，因此批量不等于说不清 */
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
  /* 控件里的一格。勾选框送的是"勾没勾"（它的 `value` 恒为 `on`，送 value 等于没送），
     其余一律按文本送 —— 转真值（数字 / 是-否）是服务端的事，见 `/api/set-control-field`。 */
  else {
    markDirty('control', el.dataset.controlField, el.type === 'checkbox' ? (el.checked ? 'true' : 'false') : el.value);
  }
  updateDirtyBadge();
}, true);

/**
 * 多行粘贴：拆成段落（单行不拦截，等价于"在该段里打字"）。
 *
 * 只拦多行文本：换行在模型里不是段落内的字符，而是段落的边界，把多行文本塞进一个
 * text 节点会得到"一段里有多行"，而机读信息、共享文档、OFD 导出全都按段落组织。
 * 单行粘贴保持原生行为：它是"编辑这一段"，不是"新增段落"。
 *
 * 粘贴进来的内容按外来内容处理（标 `imported` + 待确认）：剪贴板不提供来源，
 * 而"未核对的外部内容进了签名"是不可接受的失败方向，代价是医生多确认一次（界面会说明）。
 * 已知边界（写在这里）：从本文档内部复制的单行文字不会被标记，我们分辨不出它与外部内容。
 */
/**
 * 粘贴落位的一句说明（粘贴后紧跟在"已粘贴 N 段"后面）。
 *
 * 必须说清两件事：**哪几段被挪了、挪到了哪一章**，以及**凭什么**。
 * 落位是猜的，而"系统悄悄把内容放到了别处"是最伤信任的一种失败 ——
 * 医生找不回自己刚粘的东西，还不知道为什么。
 *
 * 三种情形都要有话说，尤其是第三种：
 *   · 落位没启用（策略不适用）→ 说清"为什么这次没用它"，否则医生会以为规则坏了；
 *   · 启用了但没改动任何落点 → 明确说"都落在你粘贴的位置"，
 *     沉默会被读成"它没处理过这件事"；
 *   · 真的挪了 → 逐段列出去向。
 */
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
  /* 这一段是拼进 `docNotice` 的，而它是用 `textContent` 渲染的 —— 所以这里**不写 HTML 标签**，
     写了只会让医生在界面上看到字面的尖括号 */
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
    /* `placement` 在响应**顶层**（与 `state`、`usage` 同类：它描述"这次调用是怎么做的"，
       不是"产出了什么"），所以读 `r.placement` 而不是 `r.data.placement` */
    docNotice = `已粘贴 ${paragraphs} 段（按外来内容处理：这些段落需要人工确认后才能签章）。`
      + placementNote(r.placement);
    await apply(r);
    /* 粘贴是"整段外来内容进来"的两个时机之一（另一个是采纳 AI 建议）：
       扫完再放光标 —— 自动扫描会重渲染，先把光标放好等于让它白设一次 */
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
  /* 流式模式的改动在另一套 DOM 里（整片纸），先落它：
     卡片模式的待落笔项只能来自输入框，两者不会同时有值，
     但"点任何按钮之前先落笔"这条纪律必须对两种模式一致。 */
  await flushFlow();
  if (pendingEdits.size === 0) return;
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
      /* 控件里的一格：`id` 是"节点id:格键"（doc-view 按服务端下发的 `data-control-field` 挂上来的）——
         这里只做**拆分**，键本身不在这里拼（理由见 doc-view.js 里那段说明）。 */
      const at = String(entry.id).indexOf(':');
      last = await api('/api/set-control-field', {
        nodeId: String(entry.id).slice(0, at),
        fieldKey: String(entry.id).slice(at + 1),
        value: entry.value,
      });
    }
  }
  await apply(last);
}

function updateDirtyBadge() {
  const el = document.getElementById('dirtyBadge');
  if (!el) return;
  /* 两种模式的"脏"各有一份来源：卡片是输入框里的待落笔项，流式是动过的可编辑区。
     只算其中一份的后果是"卡片说没改、纸上却是新打的字"。 */
  const dirty = pendingEdits.size > 0 || flowDirty.size > 0;
  el.style.display = dirty ? 'inline-flex' : 'none';
  el.textContent = '有未保存编辑（失焦 250ms 自动保存）';
}

/* ============================ 自由流式编辑 ============================
 *
 * 与卡片模式的根本差别：**落笔的单位不是"某个控件"，而是"结构差"**。
 * 卡片模式里每段自带一个输入框，它自己就知道"我改成了什么"；
 * 流式模式整片纸是一个可编辑区，浏览器只交回一棵 DOM 树 ——
 * 所以这里做的是：读 DOM → 与 `S.items`（服务端给的那份状态）比对 → 得出一串写操作，
 * 一次性发给 `/api/apply-edits`（服务端在一个撤销组里执行，见那条路由的说明）。
 *
 * 四条纪律，每条都有现场理由：
 *   ① **一次动作一次落笔**：回车拆段、退格合段、粘一整块都是"一次用户动作"，
 *      必须合成一个撤销单元，否则"撤销"会退成半个动作（拆段只退回了新段，尾巴还留在里面）；
 *   ② **输入法合成期间不落笔**：落笔会重画整片纸，正好把候选框打断 ——
 *      现场表现是"打字打到一半候选框消失、字跑到了别处"；
 *   ③ **落笔后还原光标**：不还原等于"每写完一句就被踢出编辑区"，只能靠鼠标点回去；
 *   ④ **服务端是权威**：被拒的改动随重画消失，并写明为什么被拒 ——
 *      宁可让医生看到"我打的字没了 + 原因"，也不要界面留着一份没落笔的内容。
 */
let flowDirty = new Set();
let flowTimer = null;
let composing = false;
/** 落笔前记下的光标（`{key, at}`），重画后放回去；只有流式落笔这条路会设它 */
let pendingCaret = null;
/** 一批落笔在飞行中：**同一时刻只允许一批**（原因见 flushFlow 里的说明） */
let flowInflight = false;
/**
 * 纸上那一屏所基于的 rev（乐观锁基线）。
 *
 * 为什么界面要自己记住它：落笔的请求要告诉服务端"我是基于哪一版改的"，
 * 服务端才能发现"你看的那一版已经不是最新的了"（`E_REV_CONFLICT`）。
 * 基线只在**画纸的时候就确定**（`renderDoc` 的流式分支里赋值），不能临时去读 `S.doc.rev` ——
 * 后者在落笔那一瞬间可能已经被别的动作推进过，那样乐观锁就永远不报冲突，等于没有。
 */
let flowBaselineRev = null;

function flowHostOf(key) {
  const hosts = document.querySelectorAll('[data-flow-seg]');
  for (const host of hosts) {
    if (host.dataset.flowSeg === key) return host;
  }
  return null;
}

/** 一个可编辑区里的段落块（顺序即界面顺序） */
function flowBlocks(host) {
  return Array.from(host.children).filter((el) => el.classList && el.classList.contains('fp'));
}

function markFlowDirty(host) {
  if (host && host.dataset.flowSeg) flowDirty.add(host.dataset.flowSeg);
}

function scheduleFlowFlush(delay) {
  clearTimeout(flowTimer);
  /* 停手后再落笔：比"每敲一个字发一次"省得多，又不必等到失焦才保存。
     700ms 是"打字停顿"的量级：太短会把一个词切成两次写入（留痕里多出半句），
     太长则切走页签时还在等定时器。 */
  flowTimer = setTimeout(() => { void flushFlow(); }, delay === undefined ? 700 : delay);
}

/**
 * 读当前界面 → 待落笔操作（**可重复调用**）。
 *
 * 为什么要能重复调用：乐观锁冲突之后要按新的基线把差异**重算一次**
 * （见 `flushFlow`），而"读 DOM、比状态、出操作"这件事只有这一处实现，
 * 重算时复用它，才不会出现"第一次和第二次的判据不一样"。
 *
 * `insertOrigin` 给了就把它标在新建段落上（粘贴用它标 `imported`，
 * 因为剪贴板不提供来源，而"未核对的外部内容进了签名"是不可接受的失败方向）。
 */
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
      /* 记下"焦点是否就在这片纸上"：重画（`innerHTML` 整体替换）会把焦点丢到 `body` 上，
         只还原选区是不够的 —— 选区在没有焦点的元素里不可见，而且**后续按键根本进不来**
         （现场表现：落笔一次之后接着打字没反应，得先拿鼠标点一下）。
         但也不能无条件抢焦点：重画可能是右侧面板的动作触发的，那时把焦点抢进正文很粗暴。 */
      if (caret) carets.push({ key, at: caret, focus: host.contains(document.activeElement) });
    }
  });
  return { ops, blocked, carets };
}

/** 发一批落笔。基线 rev 一起带上，服务端据此判"你看到的还是最新那一版吗" */
async function sendFlowOps(ops) {
  const request = { ops };
  if (typeof flowBaselineRev === 'number') request.expectedRev = flowBaselineRev;
  return api('/api/apply-edits', request);
}

/**
 * 把界面上动过的可编辑区落笔。
 *
 * 返回是否真的发了请求：调用方（`flushEdits` / 回车 / 退格）都不需要区分，
 * 但 `null` 与"发了但被拒"在日志里必须能分开看，所以这里不吞返回值。
 */
async function flushFlow() {
  if (!isFlow() || composing || flowDirty.size === 0) return null;
  /* 上一批还没回来：**不能并发发出去**。
     并发的第二批带的是同一条基线 rev，会被乐观锁判成冲突 —— 而那份改动其实是我们自己，
     于是医生会看到"有人同时改了这份病历"这种莫名其妙的提示，字还可能被回退掉。 */
  if (flowInflight) {
    scheduleFlowFlush(150);
    return null;
  }
  const keys = [...flowDirty];
  flowDirty.clear();
  const first = collectFlowOps(keys);
  if (first.blocked.length > 0) {
    /* 不可落笔的改动（例如填写项被打字删掉了）：**整批不落**并退回原状，
       把原因说出来。静默丢掉医生打的字，比报错糟得多。 */
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
    /* 冲突：这一批一个字节都没落笔，而**界面上那些字还在**（这条路上绝不能重画）。
       处理办法是静默刷新一次状态、按新基线把差异重算一遍再试一次 ——
       冲突的真实原因通常是别的端刚改过同一份病历，而不是这份改动本身有问题。 */
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
  /* 重画前才设光标：冲突重试那条路上没有重画，提前设了会在下一次无关的重画里乱跳 */
  pendingCaret = carets[0] || null;
  /* 无论成败都按服务端状态重画：成功时它带来新的 rev / 机读陈旧标记，
     失败时它是唯一能把界面上那份"没落笔的内容"清掉的依据。 */
  await apply(response);
  updateDirtyBadge();
  return response;
}

/**
 * 回车：把光标之后的内容切到一个新段落里。
 *
 * 为什么不让浏览器自己造一个新块：浏览器在可编辑区里按回车造出来的是它自己的
 * `div` / `br`（各家还不一样），我们再从 DOM 反推"它是新段还是同段的换行"已经晚了 ——
 * 而换行在模型里**只能是段落边界**（见 flow-view.js 文件头第 2 条）。
 * 自己切，语义从一开始就是对的。
 */
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
  /* 拆段是结构操作，不能等失焦：等下去的话，医生按完回车接着打字，
     打的字会落进"还没有 id 的新段"，两次改动被并成一批，撤销时一起退掉。 */
  void flushFlow();
}

/**
 * 段首退格：与上一段合并（这是"合段"在键盘上的唯一表达）。
 *
 * 只在"光标在本段第一个字符处、且本段不是本区第一段"时接管；其余情况一律放给浏览器 ——
 * 抢多了的后果是"想在段中删一个字，结果两段并了"。
 */
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

/* 流式模式的输入 / 回车 / 退格 / 粘贴 / 填写项点击 /
   输入法合成 —— 全部挂在这个区块里，与卡片模式的处理器互不干扰
   （卡片那几个只认 `data-edit` / `data-field` / `data-control-field`，
   而可编辑区的元素一个都不带这些属性）。 */

document.addEventListener('input', (event) => {
  if (!isFlow()) return;
  const host = event.target && event.target.closest ? event.target.closest('[data-flow-seg]') : null;
  if (!host) return;
  markFlowDirty(host);
  updateDirtyBadge();
  scheduleFlowFlush(700);
}, true);

/* 输入法：合成期间不落笔（落笔重画会把候选框打断），合成结束再排一次 */
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
  /* Ctrl+Z **必须拦下来**，这是流式模式里最容易骗人的一处：
     不拦的话，按键落到浏览器的原生撤销上 —— 它只改 DOM、不进模型，
     而且每次落笔重画纸面时原生撤销栈就被清掉了。
     现场表现是"按了 Ctrl+Z，字变了，可模型没变"，接着一打字，那次改动才被当成新输入写回去。
     拦下来之后交给撤销按钮那条既有路径（它撤的是"最近一次写入"，
     并且**再按一次 = 重做** —— 服务端的撤销是可逆的，见该按钮的 title）。
     Ctrl+Y / Ctrl+Shift+Z 同样是"重做"的常见按法，一并映射过去。 */
  const accel = event.ctrlKey || event.metaKey;
  const target = event.target;
  const inField = !!(target && target.tagName && ['INPUT', 'TEXTAREA', 'SELECT'].indexOf(target.tagName) >= 0);
  const inDialog = !!(target && target.closest && target.closest('[role="dialog"], .dialog, .modal'));
  /* 判据**不看焦点在不在纸上**：刚打开页面、或刚从左侧树切进来时焦点常在 `body` 上，
     而医生按 Ctrl+Z 想撤的正是"我刚才在纸上打的那句"。
     唯一的例外是"正在别的输入框里打字"（右侧面板、弹框）—— 那时原生撤销才是他要的。 */
  if (accel && !event.altKey && !inField && !inDialog
    && (event.key === 'z' || event.key === 'Z' || event.key === 'y' || event.key === 'Y')) {
    event.preventDefault();
    const undoButton = $('btnUndo');
    if (!undoButton || undoButton.disabled) {
      docNotice = '没有可撤销的写入（只支持撤销最近一次；签章 / 解锁之后不可撤销）。';
      renderDoc();
      return;
    }
    undoButton.click();
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
  /* 单行粘贴保持原生：它是"在段内打字"，来源不变（与卡片模式同一条口径）。
     合成期间也不接管：那时浏览器正在管自己的输入事务。 */
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
  /* 依次改写本段 + 追加新段（最后一段接上光标后面的原文）。
     全部合成成一批操作：**粘贴是一件事**，撤销必须一次退掉整块。 */
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
  /* 粘贴进来的内容**按外来内容处理**：新段落走 `origin: 'imported'`，
     由服务端标成"待确认"（剪贴板不提供来源，而未核对的外部内容进了签名是不可接受的失败方向）。
     这一段文字在界面上的样子不变，区别在落笔时那条 op 的来源字段 —— 见 flow-view.js 的 diff。 */
  await flushFlowPaste();
}, true);

/**
 * 粘贴专用：新段落要标 `imported`，所以落笔前把"界面上新出来的段"逐个标上来源。
 *
 * 走的是与 `flushFlow` 同一条路（同一个 `collectFlowOps` / `sendFlowOps`），
 * 差别只有两处：新建段落带来源、以及提示语说的是"粘贴"而不是"落笔"。
 * 冲突**不在这里重试**：粘贴是一次性动作，重试会让"粘了几段"与提示语对不上，
 * 宁可让它退回、把原因说清（那批字还在界面上，可以再按一次 Ctrl+V）。
 */
async function flushFlowPaste() {
  if (flowInflight) {
    /* 极端并发（上一次落笔还没回来就粘贴）：退回普通落笔，别插队 */
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

/* 填写项：在流式模式里它是一个行内小格（不是输入框，输入框放进可编辑区会把光标流打断）。
   点它 → 问一次 → 走与卡片模式**完全相同**的 `/api/set-field` 写路径。 */
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

/* 段内格式：加粗 / 斜体 / 下划线。
   为什么用 `execCommand`：它产出的就是 `<b>` / `<i>` / `<u>`，正是
   `flow-view.js` 解析时认得的那几个标签；而"自己实现选区加格式"要处理的
   选区边界与嵌套，工作量比这个按钮大一个数量级，收益却一样。
   已知边界（写在这里）：它是废弃 API，在将来某个浏览器里可能被移除，
   那时这里的表现应当是"按钮失效"，而不是"文档被改坏"（它不改模型）。 */
document.addEventListener('click', (event) => {
  const button = event.target && event.target.closest ? event.target.closest('[data-mark]') : null;
  if (!button || !isFlow()) return;
  const host = document.querySelector('[data-flow-seg]:focus-within');
  if (!host) {
    toast('先把光标放进正文，再点格式按钮', 'info');
    return;
  }
  document.execCommand(button.dataset.mark);
  markFlowDirty(host);
  updateDirtyBadge();
  scheduleFlowFlush(400);
}, true);

/* 置信度滑块已移除：置信度由产出方给出，界面不提供调节。
   控件本身也删干净了，留着"没人用的监听器"比删掉更容易误导后来人。 */

/* 导入病历文件：读文件 → base64 → 服务端按内容识别格式（OFD 容器 / WS/T 500 XML）
   → 生成导入草稿 → 切到该病历。故意不按后缀分派：源文件常被改名或没有后缀。 */
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

/* 本机客户端：它是**唯一**的采集来源。打开页面就检测一次，之后**每 3 秒**再检测一次 ——
   不论当前是"已连上"还是"连不上"：客户端后启动要能自动接上，中途退出也要在下一次心跳里显示出来。
   只在已连上时复检，等于"断了就再也不看了"，而那正是最需要显示出来的时刻。
   检测只打 `/hello`（不打开设备、不发音频）。
   页面没有客户端地址（不是从客户端打开的）时无从检测：地址与令牌只能由客户端注入，页面不写死。 */
(function initCaptureLocalDetection() {
  const wave = $('captureLocalWave');
  if (wave && wave.childElementCount === 0) {
    for (let i = 0; i < 14; i += 1) {
      const bar = document.createElement('i');
      /* 错开相位：同一段音频也能看出"在动"，而不是一排整齐的方块同时跳 */
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
  /* 切回本页立刻补一次：后台标签页停掉的心跳不该让人白等最多 3 秒 */
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    if (captureClientOf() === null) return;
    void probeCaptureClient();
  });
})();

/* 能力开关必须在第一次取状态之前落定：晚一步的话，被摘掉的页签会先渲染一帧再消失。
   它只读宿主注入、不碰服务端，所以放在这里不必等网络。 */
applyCapabilities();

/* 紧跟着把右栏摆好：先量顶栏（它决定右栏吸附位置），再按条子的实际高度决定
   哪几项留在条子里、哪几项收进「⋯」。能力开关摘完再量，否则会把已摘掉的位置也算进去。 */
syncHeaderHeight();
layoutRailTabs();

/* 启动：取一次状态即可画出整页 —— 本页不再有任何"要先知道身份才能画对"的控件，
   原先"先问会话、再取状态"的两段式因此收敛成一段（那一段的存在理由是「重置」按钮）。 */
void refresh();
