/**
 * 密封载荷：把任意 JSON **加密**后存进数据库列。
 *
 * ## 为什么不是"落库就存明文"
 *
 * 本仓库既有的落盘口径是密封（理由见 `core/store.ts` 文件头：旁挂数据里的 nodeId / ruleId
 * 足以指回患者，明文会让备份、运维、误拷看到它）。**换成数据库不改变这个理由** ——
 * 备份、只读副本、`sqlite3` 命令行、误拷的库文件，都还是能看到明文。
 * 所以这里**复用同一条密码学链路**（`crypto/envelope.ts` 的信封 + `resolveStateSalt` 的盐），
 * 而不是另起一套"库里的加密"。
 *
 * ## 载荷格式标识
 *
 * `format` 是载荷自身的形状版本（如 `l0-document/1`）。它和信封版本是两件事：
 * 信封回答"这段密文怎么解"，format 回答"解出来应该长什么样"。
 * 少了它，结构升级后旧行会被当成新形状解析，然后"成功地"读出错的内容。
 */

import { createHash } from 'node:crypto';
import { decryptEnvelope, encryptEnvelope, type Envelope } from '../crypto/envelope.ts';
import { resolveStateSalt } from '../core/store.ts';

/** 与 `core/persistence.ts` 同一口径（SHA-256 十六进制）：它**只能发现损坏**，防不住有意篡改 */
function digestOf(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * 加密后的内容（信封 + 摘要），本身不知道"载荷是什么形状"。
 *
 * `digest` 取的是**密文**（信封 JSON）的摘要，不是明文的 —— 这是刻意的：
 * 它的用途是回答"**这是不是同一版**"（并发写入的基线），而信封含随机 IV，
 * 所以**任何一次写入都换一版** ✓。
 * 若取明文摘要，"另一处写了完全相同的内容"就会被判成"还是那一版" ——
 * 冲突检测会静默失效（实测踩到：B36 因此报"外部写入后摘要没变"）。
 *
 * 完整性**不靠它**：信封自身的 MAC 才是防篡改的那一层（见 `crypto/envelope.ts`）。
 * 这里只额外校验"摘要列与密文列是否自洽"（两列被分别改动过时能发现）。
 */
export interface SealedContent {
  digest: string;
  /** 信封的 JSON 文本（直接进数据库列） */
  sealed: string;
}

export interface SealedPayload extends SealedContent {
  /** 载荷形状版本（`l0-document/1` 等）。与信封版本是两件事，见文件头 */
  format: string;
}

export interface SealOptions {
  /** 显式盐（32 位 hex）；一般不用，轮换靠环境变量 `L0_STATE_SALT` */
  salt?: string;
  /** 测试与复现专用：显式指定派生迭代数（理由同 `core/store.ts` 的 `saveSealedPayload`） */
  iterations?: number;
}

/** 加密一段 JSON。口令为空**直接拒绝**：绝不退回明文（同 `core/store.ts`） */
export function sealValue(value: unknown, passphrase: string, options: SealOptions = {}): SealedContent {
  if (!passphrase) throw new Error('拒绝以明文写入数据库：必须提供口令（生产从密钥管理注入）');
  const text = JSON.stringify(value);
  const { salt } = resolveStateSalt(passphrase, options.salt);
  const envelope = encryptEnvelope(new TextEncoder().encode(text), {
    passphrase,
    salt,
    ...(options.iterations === undefined ? {} : { iterations: options.iterations }),
  });
  const sealed = JSON.stringify(envelope);
  return { digest: digestOf(sealed), sealed };
}

export type UnsealResult<T> = { ok: true; data: T } | { ok: false; code: string; message: string };

/**
 * 解密并解析。**任何失败都显式返回错误码**，绝不返回"空数据" ——
 * 把"解不开"当成"没有"是数据丢失最容易被伪装成正常的方式（同 `core/store.ts`）。
 */
export function unsealValue<T>(payload: SealedContent, passphrase: string): UnsealResult<T> {
  if (!passphrase) return { ok: false, code: 'E_SEALED_NO_PASSPHRASE', message: '缺少口令：无法解密（不会退回按明文读取）' };
  let envelope: Envelope;
  try {
    envelope = JSON.parse(payload.sealed) as Envelope;
  } catch (err) {
    return { ok: false, code: 'E_SEALED_MALFORMED', message: `信封不是合法 JSON：${(err as Error).message}` };
  }
  const decrypted = decryptEnvelope(envelope, passphrase);
  if (!decrypted.ok) {
    return {
      ok: false,
      code: 'E_SEALED_DECRYPT_FAILED',
      message: `解密失败（${String((decrypted as { code?: string }).code ?? '未知原因')}）：口令错误或内容被改动`,
    };
  }
  const text = new TextDecoder().decode(decrypted.plaintext);
  /* 摘要与密文**自洽**：两列被分别改动过（只改密文、或只改摘要）时能发现。
     防篡改本身靠信封的 MAC（上面那一步已经验过），这里只查"两列是否还配得上"。 */
  if (payload.digest !== '' && digestOf(payload.sealed) !== payload.digest) {
    return { ok: false, code: 'E_SEALED_DIGEST_MISMATCH', message: '摘要列与密文列不一致（这两列被分别改动过）' };
  }
  try {
    return { ok: true, data: JSON.parse(text) as T };
  } catch {
    return { ok: false, code: 'E_SEALED_BAD_JSON', message: '解密后的内容不是合法 JSON' };
  }
}

/** 组装一条可入库的密封记录（format 由调用方给，见文件头） */
export function sealFor<T>(format: string, value: T, passphrase: string, options: SealOptions = {}): SealedPayload {
  return { ...sealValue(value, passphrase, options), format };
}
