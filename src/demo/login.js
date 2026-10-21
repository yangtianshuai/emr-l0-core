const $ = (id) => document.getElementById(id);
const L0_BASE = (document.documentElement && document.documentElement.dataset.l0Base) || '';

function safeNext() {
  const raw = new URLSearchParams(location.search).get('next') ?? '';
  return isSafeNext(raw) ? raw : `${L0_BASE}/admin`;
}

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

function clearPasswordInputs() {
  for (const id of ['loginPassword', 'bootPassword', 'bootPassword2']) {
    const el = $(id);
    if (el) el.value = '';
  }
}

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
    const res = await fetch(`${L0_BASE}/api/admin/session`, {
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
  clearPasswordInputs();
  location.href = safeNext();
}

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
    const res = await fetch(`${L0_BASE}/api/admin/bootstrap`, {
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
  const next = safeNext();
  location.href = `${L0_BASE}/login?next=${encodeURIComponent(next)}&created=${encodeURIComponent(payload.data ? payload.data.username : username)}`;
}

const loginForm = $('loginForm');
const bootstrapForm = $('bootstrapForm');
if (loginForm) loginForm.addEventListener('submit', submitLogin);
if (bootstrapForm) bootstrapForm.addEventListener('submit', submitBootstrap);

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
