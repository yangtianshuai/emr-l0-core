import type { ISODateTime } from './types.ts';

export interface PatientIdentifier {
  system: string;
  value: string;
}

export interface PatientMergeRecord {
  masterId: string;
  at: ISODateTime;
  by: string;
}

export interface PatientRecord {
  masterId: string;
  identifiers: PatientIdentifier[];
  /** 本主索引吸收过哪些旧主索引（可追溯：合并是破坏性的，必须留痕） */
  mergedFrom: PatientMergeRecord[];
}

export interface PatientIndexSnapshot {
  records: PatientRecord[];
}

export type IdentityResolution =
  | { status: 'matched'; masterId: string }
  | { status: 'unknown'; identifier: PatientIdentifier }
  | { status: 'conflict'; identifier: PatientIdentifier; occupiedBy: string };

export interface RegisterResult {
  masterId: string;
  conflicts: Array<{ identifier: PatientIdentifier; occupiedBy: string }>;
  accepted: PatientIdentifier[];
}

function keyOf(identifier: PatientIdentifier): string {
  return `${identifier.system.trim().toLowerCase()}::${identifier.value.trim()}`;
}

export class PatientIndex {
  private readonly byMasterId = new Map<string, PatientRecord>();

  private readonly byIdentifier = new Map<string, string>();

  register(masterId: string, identifiers: PatientIdentifier[], at: ISODateTime, by: string): RegisterResult {
    const record = this.byMasterId.get(masterId) ?? { masterId, identifiers: [], mergedFrom: [] };
    const conflicts: RegisterResult['conflicts'] = [];
    const accepted: PatientIdentifier[] = [];
    for (const identifier of identifiers) {
      const key = keyOf(identifier);
      const owner = this.byIdentifier.get(key);
      if (owner !== undefined && owner !== masterId) {
        conflicts.push({ identifier, occupiedBy: owner });
        continue;
      }
      if (owner === undefined) this.byIdentifier.set(key, masterId);
      if (!record.identifiers.some((item) => keyOf(item) === key)) record.identifiers.push({ ...identifier });
      accepted.push(identifier);
    }
    this.byMasterId.set(masterId, record);
    void at;
    void by;
    return { masterId, conflicts, accepted };
  }

  resolve(identifier: PatientIdentifier): IdentityResolution {
    const owner = this.byIdentifier.get(keyOf(identifier));
    if (owner === undefined) return { status: 'unknown', identifier };
    return { status: 'matched', masterId: owner };
  }

  resolveAny(identifiers: PatientIdentifier[]): IdentityResolution {
    for (const identifier of identifiers) {
      const result = this.resolve(identifier);
      if (result.status === 'matched') return result;
    }
    return { status: 'unknown', identifier: identifiers[0] ?? { system: '', value: '' } };
  }

  merge(from: string, to: string, at: ISODateTime, by: string): { ok: boolean; reason?: string } {
    if (from === to) return { ok: false, reason: '不能与自己合并' };
    const source = this.byMasterId.get(from);
    const target = this.byMasterId.get(to);
    if (!source) return { ok: false, reason: `源主索引不存在：${from}` };
    if (!target) return { ok: false, reason: `目标主索引不存在：${to}` };

    for (const identifier of source.identifiers) {
      const key = keyOf(identifier);
      this.byIdentifier.set(key, to);
      if (!target.identifiers.some((item) => keyOf(item) === key)) target.identifiers.push({ ...identifier });
    }
    target.mergedFrom.push({ masterId: from, at, by });
    this.byMasterId.delete(from);
    return { ok: true };
  }

  get(masterId: string): PatientRecord | undefined {
    const record = this.byMasterId.get(masterId);
    return record ? structuredClone(record) : undefined;
  }

  size(): number {
    return this.byMasterId.size;
  }

  snapshot(): PatientIndexSnapshot {
    return { records: [...this.byMasterId.values()].map((record) => structuredClone(record)) };
  }

  static restore(snapshot: PatientIndexSnapshot): PatientIndex {
    if (!snapshot || !Array.isArray(snapshot.records)) {
      throw new Error('主索引快照结构非法：缺少 records');
    }
    const index = new PatientIndex();
    for (const record of snapshot.records) {
      if (!record || typeof record.masterId !== 'string' || !Array.isArray(record.identifiers)) {
        throw new Error(`主索引快照含非法记录：${JSON.stringify(record).slice(0, 80)}`);
      }
      for (const identifier of record.identifiers) {
        const key = keyOf(identifier);
        const owner = index.byIdentifier.get(key);
        if (owner !== undefined && owner !== record.masterId) {
          throw new Error(`主索引快照自相矛盾：标识 ${key} 同时属于 ${owner} 与 ${record.masterId}`);
        }
        index.byIdentifier.set(key, record.masterId);
      }
      index.byMasterId.set(record.masterId, { ...structuredClone(record), mergedFrom: record.mergedFrom ?? [] });
    }
    return index;
  }

  fingerprint(): string {
    return [...this.byMasterId.values()]
      .map((record) => `${record.masterId}|${record.identifiers.map((item) => keyOf(item)).sort().join(',')}`)
      .sort()
      .join(';');
  }
}
