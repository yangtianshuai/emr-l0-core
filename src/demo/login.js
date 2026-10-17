/* 管理后台登录页脚本：只做两件事，换一个服务端会话（然后整页去后台），
 * 或者在第一次运行时创建第一个管理员账号。
 *
 * 为什么不留"登录后原地切显隐"：那样地址栏停在 /login 而内容已经变成后台，
 * 刷新一下又回到登录页；整页导航让"地址栏 = 页面内容 = 会话状态"三者始终一致。
 *
 * 为什么两种形态共用这一个脚本：它们不可能同时出现（服务端二选一），
 * 所以"哪一个在页面上"就是模式本身，不需要再传一个模式参数（传了就有对不上的一天）。
 */

const $ = (id) => document.getElementById(id);

/**
 * 登录成功后去哪：`?next=` 是可以被人手改的。
 *
 * 不校验就等于把这个登录页做成开放重定向的跳板，而它长得就像"我们医院的登录页"，
 * 一条 `/login?next=https://evil.example` 的链接足以用来钓口令。
 * 所以只接受站内路径，其余一律回落到 `/admin`。
 */
function safeNext() {
  const raw = new URLSearchParams(location.search).get('next') ?? '';
  return isSafeNext(raw) ? raw : '/admin';
}

/** 判据独立成函数（故意不写成内联三元：这条逻辑错一次，就是一个钓鱼入口） */
function isSafeNext(raw) {
  /* 必须以单个 `/` 开头：`//evil.example` 是协议相对 URL，浏览器会当成站外域名 */
  if (!raw.startsWith('/') || raw.startsWith('//')) return false;
  if (raw.includes('\\') || raw.includes(':')) return false;
  if (raw.length > 200) return false;
  return true;
}

function setStatus(text, danger = false) {
  const el = $('loginStatus');
  el.textContent = text;
  el.classList.toggle('bad', danger);
}

/** 口令用完即弃：失败或成功后立刻清空，它不该留在输入框里被人从背后看见 */
function clearPasswordInputs() {
  for (const id of ['loginPassword', 'bootPassword', 'bootPassword2']) {
    const el = $(id);
    if (el) el.value = '';
  }
}

/* ------------------------------ 登录 ------------------------------ */

async function submitLogin(event) {
  event.preventDefault();
  const username = $('loginUsername').value.trim();
  const password = $('loginPassword').value;
  if (username === '' || password === '') {
    setStatus('请填「账号」与「口令」（两者都必填）', true);
    $(username === '' ? 'loginUsername' : 'loginPassword').focus();
    return;
  }
  setStatus('登录中…');
  let payload;
  try {
    const res = await fetch('/api/admin/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    payload = await res.json();
  } catch {
    setStatus('登录失败：服务端没有响应（进程是否还在？）', true);
    return;
  }
  if (payload.ok !== true) {
    setStatus(`登录失败：${payload.message || payload.code || '未知原因'}`, true);
    clearPasswordInputs();
    $('loginPassword').focus();
    return;
  }
  /* 会话在 HttpOnly cookie 里，脚本读不到也不需要读；整页去后台即可 */
  clearPasswordInputs();
  location.href = safeNext();
}

/* --------------------------- 首次初始化 --------------------------- */

/**
 * 创建第一个管理员。
 *
 * 两处前端也要做的校验（服务端同样会拒，但在点之前说比点完再说强）：
 *   - 两遍口令必须一致：这是唯一一次"设了口令没人能替你核对"的场合，
 *     打错的后果是"记了一辈子"的那个也不是真的；
 *   - 至少 8 位：与服务端 `PASSWORD_MIN_LENGTH` 同一个数，
 *     本地校验只是把一次往返省掉，判据仍在服务端。
 */
async function submitBootstrap(event) {
  event.preventDefault();
  const username = $('bootUsername').value.trim();
  const password = $('bootPassword').value;
  const again = $('bootPassword2').value;
  if (username === '' || password === '') {
    setStatus('账号与口令都必填', true);
    $(username === '' ? 'bootUsername' : 'bootPassword').focus();
    return;
  }
  if (password !== again) {
    setStatus('两遍口令不一致：请重新输入（这一次没有第二次机会替你核对）', true);
    clearPasswordInputs();
    $('bootPassword').focus();
    return;
  }
  const deployEl = $('bootDeployToken');
  const body = { username, password };
  if (deployEl) body.deployToken = deployEl.value;
  setStatus('创建中…');
  let payload;
  try {
    const res = await fetch('/api/admin/bootstrap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    payload = await res.json();
  } catch {
    setStatus('创建失败：服务端没有响应（进程是否还在？）', true);
    return;
  }
  if (payload.ok !== true) {
    setStatus(`创建失败：${payload.message || payload.code || '未知原因'}`, true);
    clearPasswordInputs();
    return;
  }
  clearPasswordInputs();
  /* 不自动登录：让刚设的那条口令当场被用一次。
     "我记得住它"是这次初始化里唯一没有别的办法验证的一件事，而自动登录恰好把它跳过去了。
     带着账号名跳回登录页，并把这件事说清楚。 */
  const next = safeNext();
  location.href = `/login?next=${encodeURIComponent(next)}&created=${encodeURIComponent(payload.data ? payload.data.username : username)}`;
}

/* ------------------------------ 绑定 ------------------------------ */

const loginForm = $('loginForm');
const bootstrapForm = $('bootstrapForm');
if (loginForm) loginForm.addEventListener('submit', submitLogin);
if (bootstrapForm) bootstrapForm.addEventListener('submit', submitBootstrap);

/* 刚初始化完跳回来：把"账号已建好、请用它的口令登录"说在状态行上。
   不用 alert（那会被当成错误），也不只在 URL 里带个名字了事（那样没人知道该干什么）。 */
const created = new URLSearchParams(location.search).get('created');
if (created !== null && loginForm) {
  setStatus(`管理员账号「${created}」已创建（口令已存入数据库）。请用该口令登录一次，确认口令可用。`);
  $('loginUsername').value = created;
  $('loginPassword').focus();
} else if (bootstrapForm) {
  $('bootUsername').focus();
} else {
  $('loginUsername').focus();
}
