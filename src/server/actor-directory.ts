/**
 * 身份目录（凭证 → actor）：把"身份声明"变成"服务端事实"。
 *
 * 为什么必须单独一层：在此之前服务端从请求头 `X-Actor-Kind` 读身份，
 * 于是**调用方可以自称 human** —— 所有 AI 门控（AI 禁直写、建议只能人工采纳、
 * 关键内容只能人工确认）在协议层都能被绕过。建立在"被控方自报身份"之上的门控，
 * 不是门控，是君子协定。
 *
 * 三条纪律：
 *   1. `kind` **只来自本目录**；请求头里的同名字段一律不采信 —— 用凭证定身份；
 *   2. 目录**只存凭证的 SM3 指纹**，不存明文 —— 内存快照泄露也无法复原凭证；
 *   3. 凭证可撤销（`revoke`），撤销即失效（与受控阅读的撤销同一语义）。
 *
 * 边界（必须说清）：本模块解决"身份不可自报"，**不解决**"凭证怎么发、怎么轮换、
 * 怎么防重放"。生产环境需要签名令牌（含有效期、绑定终端）或对接医院 CA；
 * 这里给的是**收口点与语义**，不是完整的认证方案。
 */

import { sm3Hex } from '../crypto/sm3.ts';

export type ActorKind = 'human' | 'ai' | 'system';

export interface VerifiedActor {
  id: string;
  kind: ActorKind;
  /** 展示用名称（如"门诊医生工作站"），不进正文、不进机读块 */
  label?: string;
}

export interface ActorRecord extends VerifiedActor {
  /** 凭证的 SM3 指纹前 16 位：用于"这是哪把凭证"的比对，不可反推凭证本身 */
  tokenFingerprint: string;
}

/** 凭证指纹：只用于比对与展示，不可用于换取权限 */
export function tokenFingerprint(token: string): string {
  return sm3Hex(token).slice(0, 16);
}

export class ActorDirectory {
  private readonly byFingerprint = new Map<string, VerifiedActor>();

  /** 注册凭证。同一凭证重复注册视为覆盖（便于轮换） */
  register(token: string, actor: VerifiedActor): void {
    if (token.trim() === '') throw new Error('凭证不得为空');
    if (actor.id.trim() === '') throw new Error('actor.id 不得为空');
    this.byFingerprint.set(tokenFingerprint(token), { ...actor });
  }

  /** 撤销凭证：撤销即失效（返回是否确实存在过） */
  revoke(token: string): boolean {
    return this.byFingerprint.delete(tokenFingerprint(token));
  }

  /** 认领：凭证 → actor。未注册或已撤销一律返回 undefined（fail-closed） */
  resolve(token: string): VerifiedActor | undefined {
    const found = this.byFingerprint.get(tokenFingerprint(token));
    return found ? { ...found } : undefined;
  }

  size(): number {
    return this.byFingerprint.size;
  }

  /** 展示清单：**不含凭证本身**，只含指纹 */
  list(): ActorRecord[] {
    return [...this.byFingerprint.entries()].map(([fingerprint, actor]) => ({ ...actor, tokenFingerprint: fingerprint }));
  }
}
