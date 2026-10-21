import { createCipheriv, getCiphers } from 'node:crypto';
import { fromHex, toHex } from './sm3.ts';

export const SM4_IV_LENGTH = 16;
const SM4_KEY_LENGTH = 16;
const SM4_BLOCK_LENGTH = 16;

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

export function assertSm4(): void {
  const availability = sm4Availability();
  if (!availability.ok) {
    throw new Error(`SM4 不可用，加密/解密无法安全进行：${availability.reason}`);
  }
}

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
