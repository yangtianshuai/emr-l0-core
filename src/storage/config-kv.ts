import type { WorkStore } from './work-store.ts';

export interface ConfigKv {
  read<T>(key: string): T | null;
  write(key: string, value: unknown): void;
  remove(key: string): void;
  has(key: string): boolean;
}

export const CONFIG_KEY_PREFIX = 'config.';

export class ConfigKvError extends Error {
  readonly key: string;

  constructor(key: string, message: string) {
    super(message);
    this.name = 'ConfigKvError';
    this.key = key;
  }
}

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
