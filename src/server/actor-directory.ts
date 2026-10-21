import { sm3Hex } from '../crypto/sm3.ts';

export type ActorKind = 'human' | 'ai' | 'system';

export interface VerifiedActor {
  id: string;
  kind: ActorKind;
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

  register(token: string, actor: VerifiedActor): void {
    if (token.trim() === '') throw new Error('凭证不得为空');
    if (actor.id.trim() === '') throw new Error('actor.id 不得为空');
    this.byFingerprint.set(tokenFingerprint(token), { ...actor });
  }

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

  list(): ActorRecord[] {
    return [...this.byFingerprint.entries()].map(([fingerprint, actor]) => ({ ...actor, tokenFingerprint: fingerprint }));
  }
}
