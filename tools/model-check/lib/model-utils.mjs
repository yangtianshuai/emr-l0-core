import { createHash } from 'node:crypto';

export function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function clone(v) {
  if (v === undefined) return undefined;
  return JSON.parse(JSON.stringify(v));
}

export function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== 'object') return Number.isNaN(a) && Number.isNaN(b) ? true : false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!deepEqual(a[k], b[k])) return false;
  return true;
}

export function diffPaths(a, b, path = '$', out = [], limit = 500) {
  if (out.length >= limit) return out;
  if (deepEqual(a, b)) return out;
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      if (!(k in a)) out.push({ path: `${path}.${k}`, from: '<缺失>', to: b[k] });
      else if (!(k in b)) out.push({ path: `${path}.${k}`, from: a[k], to: '<缺失>' });
      else diffPaths(a[k], b[k], `${path}.${k}`, out, limit);
      if (out.length >= limit) break;
    }
    return out;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      out.push({ path, from: `数组长度 ${a.length}`, to: `数组长度 ${b.length}` });
      return out;
    }
    for (let i = 0; i < a.length; i += 1) {
      diffPaths(a[i], b[i], `${path}[${i}]`, out, limit);
      if (out.length >= limit) break;
    }
    return out;
  }
  out.push({ path, from: a, to: b });
  return out;
}

function esc(seg) {
  return String(seg).replace(/~/g, '~0').replace(/\//g, '~1');
}

export function parsePointer(p) {
  if (p === '' || p === '/') return p === '' ? [] : [];
  return p
    .replace(/^\//, '')
    .split('/')
    .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
}

export function getAt(root, parts) {
  let cur = root;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

export function jsonDiff(a, b, path = '') {
  const ops = [];
  const rec = (x, y, p) => {
    if (deepEqual(x, y)) return;
    if (isPlainObject(x) && isPlainObject(y)) {
      for (const k of Object.keys(x)) if (!(k in y)) ops.push({ op: 'remove', path: `${p}/${esc(k)}` });
      for (const k of Object.keys(y)) {
        if (!(k in x)) ops.push({ op: 'add', path: `${p}/${esc(k)}`, value: clone(y[k]) });
        else rec(x[k], y[k], `${p}/${esc(k)}`);
      }
      return;
    }
    if (Array.isArray(x) && Array.isArray(y) && x.length === y.length) {
      for (let i = 0; i < x.length; i += 1) rec(x[i], y[i], `${p}/${i}`);
      return;
    }
    ops.push({ op: 'replace', path: p === '' ? '/' : p, value: clone(y) });
  };
  rec(a, b, path);
  return ops;
}

export function applyPatch(doc, ops) {
  let out = clone(doc);
  for (const op of ops) {
    if (op.path === '/' || op.path === '') {
      if (op.op !== 'replace') throw new Error(`根路径仅支持 replace：${JSON.stringify(op)}`);
      out = clone(op.value);
      continue;
    }
    const parts = parsePointer(op.path);
    const container = parts.length === 1 ? out : getAt(out, parts.slice(0, -1));
    const key = parts[parts.length - 1];
    if (container === undefined || container === null) throw new Error(`patch 路径不可达：${op.path}`);
    if (op.op === 'remove') {
      if (Array.isArray(container)) {
        const i = Number(key);
        if (!Number.isInteger(i) || i < 0 || i >= container.length) throw new Error(`remove 索引越界：${op.path}`);
        container.splice(i, 1);
      } else {
        if (!(key in container)) throw new Error(`remove 目标不存在：${op.path}`);
        delete container[key];
      }
    } else if (op.op === 'add') {
      if (Array.isArray(container)) container.splice(Number(key), 0, clone(op.value));
      else container[key] = clone(op.value);
    } else if (op.op === 'replace') {
      if (Array.isArray(container)) {
        const i = Number(key);
        if (!Number.isInteger(i) || i < 0 || i >= container.length) throw new Error(`replace 索引越界：${op.path}`);
        container[i] = clone(op.value);
      } else {
        container[key] = clone(op.value);
      }
    } else {
      throw new Error(`不支持的 patch op：${op.op}`);
    }
  }
  return out;
}

/** 遍历所有值，交给 visit(path, value)；用于发现不可序列化值 */
export function walkValues(value, visit, path = '$') {
  visit(path, value);
  if (Array.isArray(value)) value.forEach((v, i) => walkValues(v, visit, `${path}[${i}]`));
  else if (isPlainObject(value)) for (const [k, v] of Object.entries(value)) walkValues(v, visit, `${path}.${k}`);
}

/** 不可序列化值检测（JSON.stringify 会静默吞掉/转换，是真实事故源） */
export function findUnserializable(value) {
  const found = [];
  walkValues(value, (path, v) => {
    if (v === undefined) found.push({ path, issue: 'undefined（JSON 会丢失该键）' });
    else if (typeof v === 'number' && Number.isNaN(v)) found.push({ path, issue: 'NaN（JSON 会变成 null）' });
    else if (v === Infinity || v === -Infinity) found.push({ path, issue: 'Infinity（JSON 会变成 null）' });
    else if (typeof v === 'bigint') found.push({ path, issue: 'BigInt（JSON.stringify 会抛错）' });
    else if (typeof v === 'function') found.push({ path, issue: 'function（会被丢弃）' });
    else if (typeof v === 'symbol') found.push({ path, issue: 'symbol（会被丢弃）' });
    else if (v instanceof Date) found.push({ path, issue: 'Date 实例（会被转成字符串，丢失类型）' });
    else if (v instanceof Map || v instanceof Set) found.push({ path, issue: 'Map/Set（会被转成空对象）' });
  });
  return found;
}

export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
    return out;
  }
  return value;
}

export function hashNodes(nodes) {
  return createHash('sha256').update(JSON.stringify(canonicalize(nodes))).digest('hex').slice(0, 32);
}

export function makeRng(seed) {
  let s = (seed >>> 0) || 1;
  return function rng() {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick(rng, arr) {
  if (!arr || arr.length === 0) return null;
  return arr[Math.floor(rng() * arr.length) % arr.length];
}

export function nowIso(offsetMs = 0) {
  return new Date(Date.now() + offsetMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
