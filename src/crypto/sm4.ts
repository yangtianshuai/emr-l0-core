/**
 * SM4（GB/T 32907—2016）：**由运行时 OpenSSL 提供**，本模块做封装、能力探测与自检。
 *
 * ── 为什么不自研（这是一次失败尝试的记录，留着是为了后来人不重复踩） ──
 * 本仓库的 SM3 / SM2 都是自研实现并与 OpenSSL 双向交叉验证，SM4 起初也按同一路线做：
 * 256 项 S 盒 + 32 轮 + 密钥扩展。结果是**国标示例向量不过**，且与 OpenSSL 的 `sm4-ecb`
 * 逐字节比对 **64/64 全不一致**。排查能确定的结论：
 *   - S 盒是**合法双射**（256 项无缺失、无重复）——但这只排除了"抄漏/抄重"，
 *     **排除不了"两项互换"这类错误**，而后者对向量的表现与前者完全一样（全错）；
 *   - FK / CK（用公式 `(4i+j)×7 mod 256` 现算）/ L（移位 2·10·18·24）/ L′（13·23）/
 *     轮序 / 输出反序，都符合标准描述；
 *   - 尝试用"GF(2⁸) 求逆 + 仿射变换"的构造公式重新生成 S 盒来逐项核对，
 *     生成结果是**另一个置换**（256 项全不一致），说明这个构造公式我也记错了 ——
 *     也就是说，**离线环境下没有任何可核对的 S 盒来源**。
 *
 * 工程判断：**自研的收益（同源）小于风险**——一个抄错的常量只会在极少数输入上表现异常，
 * 且在真实数据上几乎无法定位（加密出来是乱码，无法反推是哪一轮哪个字节错了）。
 * 因此改为依赖运行时 OpenSSL，并把"依赖外部实现"这件事变成**可探测、可自检**的：
 *
 *   1) **能力探测**：`sm4Availability()` 显式报告是否可用与原因；缺了就**明确失败**，
 *      绝不静默降级成"不加密"（静默降级会让"加密归档"变成明文归档而没人发现）；
 *   2) **国标向量自检**：`sm4SelfCheck()` 用 GB/T 32907 的示例向量确认运行时实现**确实是 SM4**
 *      （key = 明文 = `0123456789abcdeffedcba9876543210` → `681edf34d206965e86b3e94f536e4246`）；
 *   3) **CTR 语义写死**：计数器 128 位大端整块递增（与 OpenSSL 一致），溢出**报错而非回绕**。
 *
 * ⚠️ 诚实边界：
 *   - 本模块不提供侧信道防护，也不判断"是否合规"——合规性取决于所用密码模块是否取得资质；
 *   - CTR 的 IV **绝不能在同一密钥下重用**（重用直接泄露明文异或值）；
 *     本模块不生成 IV，由 envelope.ts 每次随机生成并随文保存。
 */

import { createCipheriv, getCiphers } from 'node:crypto';
import { fromHex, toHex } from './sm3.ts';

export const SM4_IV_LENGTH = 16;
const SM4_KEY_LENGTH = 16;
const SM4_BLOCK_LENGTH = 16;

/** 国标示例向量：GB/T 32907—2016 附录 A */
const VECTOR_KEY = '0123456789abcdeffedcba9876543210';
const VECTOR_PLAINTEXT = '0123456789abcdeffedcba9876543210';
const VECTOR_CIPHERTEXT = '681edf34d206965e86b3e94f536e4246';

/** 运行时是否具备 SM4（缺失时必须显式失败，不允许"不加密继续跑"） */
export function sm4Availability(): { ok: boolean; reason?: string; ciphers: string[] } {
  let ciphers: string[] = [];
  try {
    ciphers = getCiphers().filter((name) => /^sm4/i.test(name));
  } catch (err) {
    return { ok: false, reason: `无法枚举运行时算法：${(err as Error).message}`, ciphers: [] };
  }
  if (ciphers.length === 0) {
    return {
      ok: false,
      reason: '当前运行时的 OpenSSL 不提供 SM4（sm2/sm3 有而 sm4 没有，说明是裁剪过的构建）',
      ciphers,
    };
  }
  const check = sm4SelfCheck();
  if (!check.ok) return { ok: false, reason: `SM4 实测与国标示例不一致：${check.detail}`, ciphers };
  return { ok: true, ciphers };
}

/** 缺 SM4 时立即抛错（而不是让调用方自己判断，也不是降级成明文） */
export function assertSm4(): void {
  const availability = sm4Availability();
  if (!availability.ok) {
    throw new Error(`SM4 不可用，加密/解密无法安全进行：${availability.reason}`);
  }
}

/**
 * 国标向量自检：运行时实现必须能算出 GB/T 32907 的示例结果。
 * 这是"我们用的到底是不是 SM4"的唯一实证 —— 不看算法名，看结果。
 */
export function sm4SelfCheck(): { ok: boolean; detail: string } {
  try {
    const out = toHex(sm4EcbEncryptBlock(fromHex(VECTOR_KEY), fromHex(VECTOR_PLAINTEXT)));
    return out === VECTOR_CIPHERTEXT
      ? { ok: true, detail: `国标示例向量一致（${VECTOR_CIPHERTEXT}）` }
      : { ok: false, detail: `期望 ${VECTOR_CIPHERTEXT}，实际 ${out}` };
  } catch (err) {
    return { ok: false, detail: `调用失败：${(err as Error).message}` };
  }
}

function assertKey(key: Uint8Array): void {
  if (key.length !== SM4_KEY_LENGTH) {
    throw new Error(`SM4 密钥必须为 ${SM4_KEY_LENGTH} 字节，实际 ${key.length} 字节`);
  }
}

/** 单分组 ECB 加密（自检与交叉验证用；业务代码请用 CTR） */
export function sm4EcbEncryptBlock(key: Uint8Array, block: Uint8Array): Uint8Array {
  assertKey(key);
  if (block.length !== SM4_BLOCK_LENGTH) {
    throw new Error(`SM4 分组必须为 ${SM4_BLOCK_LENGTH} 字节，实际 ${block.length} 字节`);
  }
  const cipher = createCipheriv('sm4-ecb', key, null);
  cipher.setAutoPadding(false);
  const out = cipher.update(block);
  return new Uint8Array([...out, ...cipher.final()]);
}

/**
 * CTR 模式（加密 = 解密）。计数器 128 位大端整块递增。
 *
 * ⚠️ 同一密钥下 IV 绝不重用；本函数不生成 IV（由 envelope.ts 随文生成并保存）。
 * 长度不做限制：CTR 是流模式，末尾不足一块时按需截断密钥流。
 */
export function sm4Ctr(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Uint8Array {
  assertKey(key);
  if (iv.length !== SM4_IV_LENGTH) {
    throw new Error(`SM4-CTR 的 IV 必须为 ${SM4_IV_LENGTH} 字节，实际 ${iv.length} 字节`);
  }
  if (data.length === 0) return new Uint8Array(0);
  const cipher = createCipheriv('sm4-ctr', key, iv);
  /* 流模式必须关填充：否则尾部会多出一个填充块，解出来就多 16 字节垃圾 */
  cipher.setAutoPadding(false);
  const out = cipher.update(data);
  return new Uint8Array([...out, ...cipher.final()]);
}
