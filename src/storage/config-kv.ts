// 部署参数的键值层：模型接入 / 落位 / 签名后端 / 授权源，四类参数落在 `sealed_kv` 一张表里。
// 加密的代价是读一次解一次信封，而派生结果按口令缓存，整个进程只付一次（见下）。
// salt 来自 `L0_STATE_SALT`，没设时按口令推导（稳定），于是同一口令下派生结果可被缓存，

import type { WorkStore } from './work-store.ts';

export interface ConfigKv {
  /** 读一条：`null` = 没有；解不开 → 抛错（绝不当作"没有"）  */
  read<T>(key: string): T | null;
  /** 写一条（覆盖）。`value` 必须是可 JSON 化的对象 —— 空值不是一种配置状态，要清就 `remove` */
  write(key: string, value: unknown): void;
  /** 真删行：清掉就得是真清（写空壳会让"我清掉了"变成一句假话）  */
  remove(key: string): void;
  has(key: string): boolean;
}

/** 部署参数在 `sealed_kv` 里的键名统一带这个前缀，便于与将来的其它键区分 */
export const CONFIG_KEY_PREFIX = 'config.';

export class ConfigKvError extends Error {
  readonly key: string;

  constructor(key: string, message: string) {
    super(message);
    this.name = 'ConfigKvError';
    this.key = key;
  }
}

/**
 * 建一个建在 `WorkStore` 密封键值之上的配置层。
 *
 * 刻意不自己做加密：`putSealed` / `getSealed` 已经是仓库里唯一一处密封实现，
 * 再写一份就是"同一仓库两套实现，总有一套没被审过"（与模型密钥那条理由相同）。
  */
export function createConfigKv(workStore: WorkStore): ConfigKv {
  return {
    read<T>(key: string): T | null {
      const result = workStore.getSealed<T>(key);
      if (result.ok) return result.found ? result.data : null;
      throw new ConfigKvError(
        key,
        `配置「${key}」在库里但解不开（口令已更换，或这一行被改动过）：${result.message}；` +
          '不会当作"没配过"继续 —— 那会表现成"我配的东西悄悄变回去了"，两件事的处置完全不同',
      );
    },
    write(key: string, value: unknown): void {
      workStore.putSealed(key, value);
    },
    remove(key: string): void {
      workStore.removeSealed(key);
    },
    has(key: string): boolean {
      return workStore.hasSealed(key);
    },
  };
}
