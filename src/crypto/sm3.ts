/**
 * SM3 密码杂凑算法（GB/T 32905-2016）—— 自研纯 TS 实现，零依赖。
 *
 * ⚠️ **定位必须说清**：自研密码学用于**原型与交叉验证**，未经第三方审计，
 *    **不得直接用于生产签名**。生产对接须换成经认证的密码模块（商用密码产品 / HSM / UKey）——
 *    L0 通过 `CryptoProvider` 接口留出替换点，`nodeProvider`（OpenSSL）就是其中之一。
 *
 * 为什么还自己写：
 *   1) 零 npm 依赖是硬约束（医院内网装机环境常无法联网装包）；
 *   2) 但"零依赖"不能靠降低可信度来换 —— 本实现用两条独立证据锁死正确性：
 *      ① **国标测试向量**（'abc'、'abcd'×16）；
 *      ② **与 OpenSSL（node:crypto 的 sm3）逐字节比对**：同一批消息（含随机长消息）
 *         两个实现必须给出完全相同的摘要。
 *   这比"自己跟自己比"强得多：一个是标准答案，一个是另一套独立实现。
 */

/* ------------------------------- 常量与工具 ------------------------------- */

const IV = [0x7380166f, 0x4914b2b9, 0x172442d7, 0xda8a0600, 0xa96f30bc, 0x163138aa, 0xe38dee4d, 0xb0fb0e4e];

/** 32 位循环左移。n 为 0 时 (x >>> 32) 在 JS 里等于 (x >>> 0)，会得 0，故单独处理 */
function rotl(x: number, n: number): number {
  const s = n % 32;
  return s === 0 ? x >>> 0 : ((x << s) | (x >>> (32 - s))) >>> 0;
}

/** 置换 P0 */
function p0(x: number): number {
  return (x ^ rotl(x, 9) ^ rotl(x, 17)) >>> 0;
}

/** 置换 P1 */
function p1(x: number): number {
  return (x ^ rotl(x, 15) ^ rotl(x, 23)) >>> 0;
}

/* ------------------------------- 压缩函数 ------------------------------- */

/**
 * 压缩函数 CF。
 * 注意 JS 位运算返回**有符号** int32：`~e & g`、`a & b` 等在最高位为 1 时会变负数，
 * 直接参与加法就会算错。因此每个按位结果都要 `>>> 0` 归一到无符号 —— 这是本实现最容易踩的坑。
 */
function compress(v: Uint32Array, block: Uint8Array, offset: number): void {
  const w = new Uint32Array(68);
  const w1 = new Uint32Array(64);

  for (let i = 0; i < 16; i += 1) {
    const at = offset + i * 4;
    w[i] = ((block[at]! << 24) | (block[at + 1]! << 16) | (block[at + 2]! << 8) | block[at + 3]!) >>> 0;
  }
  for (let j = 16; j < 68; j += 1) {
    const x = (w[j - 16]! ^ w[j - 9]! ^ rotl(w[j - 3]!, 15)) >>> 0;
    w[j] = (p1(x) ^ rotl(w[j - 13]!, 7) ^ w[j - 6]!) >>> 0;
  }
  for (let j = 0; j < 64; j += 1) w1[j] = (w[j]! ^ w[j + 4]!) >>> 0;

  let a = v[0]!;
  let b = v[1]!;
  let c = v[2]!;
  let d = v[3]!;
  let e = v[4]!;
  let f = v[5]!;
  let g = v[6]!;
  let h = v[7]!;

  for (let j = 0; j < 64; j += 1) {
    const t = j < 16 ? 0x79cc4519 : 0x7a879d8a;
    const ss1 = rotl((rotl(a, 12) + e + rotl(t, j % 32)) >>> 0, 7);
    const ss2 = (ss1 ^ rotl(a, 12)) >>> 0;
    const ff = j < 16 ? (a ^ b ^ c) >>> 0 : ((a & b) | (a & c) | (b & c)) >>> 0;
    const gg = j < 16 ? (e ^ f ^ g) >>> 0 : ((e & f) | (~e & g)) >>> 0;
    const tt1 = (ff + d + ss2 + w1[j]!) >>> 0;
    const tt2 = (gg + h + ss1 + w[j]!) >>> 0;

    d = c;
    c = rotl(b, 9);
    b = a;
    a = tt1;
    h = g;
    g = rotl(f, 19);
    f = e;
    e = p0(tt2);
  }

  v[0] = (v[0]! ^ a) >>> 0;
  v[1] = (v[1]! ^ b) >>> 0;
  v[2] = (v[2]! ^ c) >>> 0;
  v[3] = (v[3]! ^ d) >>> 0;
  v[4] = (v[4]! ^ e) >>> 0;
  v[5] = (v[5]! ^ f) >>> 0;
  v[6] = (v[6]! ^ g) >>> 0;
  v[7] = (v[7]! ^ h) >>> 0;
}

/* --------------------------------- 主流程 --------------------------------- */

/**
 * 填充：追加 0x80，补 0 至 (len ≡ 56 mod 64)，最后 8 字节写入**比特**长度（大端）。
 * 用 BigInt 写长度：消息超过 2^32 bit（512MB）时 Number 位移会溢出，BigInt 不会。
 */
function padded(message: Uint8Array): Uint8Array {
  const len = message.length;
  const zeroCount = (56 - ((len + 1) % 64) + 64) % 64;
  const out = new Uint8Array(len + 1 + zeroCount + 8);
  out.set(message, 0);
  out[len] = 0x80;

  const bitLength = BigInt(len) * 8n;
  for (let i = 0; i < 8; i += 1) {
    out[out.length - 1 - i] = Number((bitLength >> BigInt(8 * i)) & 0xffn);
  }
  return out;
}

/** SM3 摘要（32 字节） */
export function sm3(message: Uint8Array): Uint8Array {
  const v = Uint32Array.from(IV);
  const data = padded(message);
  for (let offset = 0; offset < data.length; offset += 64) compress(v, data, offset);

  const out = new Uint8Array(32);
  for (let i = 0; i < 8; i += 1) {
    const word = v[i]!;
    out[i * 4] = (word >>> 24) & 0xff;
    out[i * 4 + 1] = (word >>> 16) & 0xff;
    out[i * 4 + 2] = (word >>> 8) & 0xff;
    out[i * 4 + 3] = word & 0xff;
  }
  return out;
}

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

export function fromHex(hex: string): Uint8Array {
  const clean = hex.replace(/\s+/g, '');
  if (clean.length % 2 !== 0) throw new Error('十六进制长度必须为偶数');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    const byte = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error(`非法十六进制：${clean.slice(i * 2, i * 2 + 2)}`);
    out[i] = byte;
  }
  return out;
}

export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** SM3 十六进制摘要（审计、指纹、签名都用它） */
export function sm3Hex(message: Uint8Array | string): string {
  return toHex(sm3(typeof message === 'string' ? utf8(message) : message));
}
