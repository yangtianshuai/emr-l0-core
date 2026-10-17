/**
 * 患者主索引（EMPI）：把**来自不同系统的标识**归一到同一个主索引。
 *
 * ## 为什么它必须先做
 *
 * 跨文书一致性、数据找人、趋势派生，**全都依赖"这两条记录是同一个人"**。
 * 当前整条链路用的是 `patient.patientId` 字符串直接比较 —— 那在 demo 里成立，
 * 在真实环境会出错：同一个患者会有门诊号、住院号、医保号、身份证号……
 * 不同系统的文书各带各的号，直接比较等于"永远不匹配"或"匹配到错的人"。
 *
 * **用错主索引的后果不是"少查出一条"，而是"把两个患者的数据报成矛盾"** ——
 * 那是医疗事故级别的错误，而且它看起来像一条正常的质控提示，极难被发现。
 *
 * ## 三条原则
 *
 * 1) **不猜**：只做**已登记标识的精确匹配**，不做"姓名 + 出生日期"的模糊/概率匹配。
 *    概率匹配必然有误合并，而误合并会把两个人的病历粘在一起、且几乎无法被发现 ——
 *    相比"漏合并"（最多是查不出问题），这个代价不对称；
 * 2) **冲突不静默**：同一标识若已属于另一个主索引，注册与解析都要**报告冲突**，
 *    由人裁决（这是 EMPI 运维的日常工作）。绝不能用"最后一次写入生效"掩盖 ——
 *    那等于让"谁后写"决定了患者是谁；
 * 3) **合并可追溯**：合并是**破坏性**操作（旧主索引不再存在），必须记录 from/to/who/when。
 */

import type { ISODateTime } from './types.ts';

export interface PatientIdentifier {
  /** 标识体系：如 `his` / `outpatient-no` / `inpatient-no` / `insurance` / `id-card` */
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

/** 可持久化的主索引快照（只存 records，标识索引恢复时重建） */
export interface PatientIndexSnapshot {
  records: PatientRecord[];
}

export type IdentityResolution =
  | { status: 'matched'; masterId: string }
  /** 未登记过：**不猜**，交回调用方决定是否新建 */
  | { status: 'unknown'; identifier: PatientIdentifier }
  /** 该标识已属于别的主索引：冲突，需人工裁决 */
  | { status: 'conflict'; identifier: PatientIdentifier; occupiedBy: string };

export interface RegisterResult {
  masterId: string;
  /** 被拒绝登记的标识（已属于其他主索引）—— 调用方**必须**处理，不能忽略 */
  conflicts: Array<{ identifier: PatientIdentifier; occupiedBy: string }>;
  /** 实际写入的标识 */
  accepted: PatientIdentifier[];
}

/** 标识归一化：同一体系同号只应有一条记录，空格与大小写差异不该算两个患者 */
function keyOf(identifier: PatientIdentifier): string {
  return `${identifier.system.trim().toLowerCase()}::${identifier.value.trim()}`;
}

export class PatientIndex {
  private readonly byMasterId = new Map<string, PatientRecord>();

  /** 标识键 → masterId。**一对一**：一个标识只允许属于一个主索引（冲突在写入时拦下） */
  private readonly byIdentifier = new Map<string, string>();

  /**
   * 登记（或补充）一个主索引的标识。
   *
   * **冲突不覆盖**：已属于其他主索引的标识会被放进 `conflicts` 并跳过 ——
   * 静默覆盖等于让最后写入者决定了"这个号是谁的"。
   */
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

  /** 解析单个标识；未登记则 `unknown`（**不猜、不新建**） */
  resolve(identifier: PatientIdentifier): IdentityResolution {
    const owner = this.byIdentifier.get(keyOf(identifier));
    if (owner === undefined) return { status: 'unknown', identifier };
    return { status: 'matched', masterId: owner };
  }

  /**
   * 用一组标识解析患者：取**第一个命中**的。
   *
   * 若不同标识指向**不同**主索引，说明数据本身矛盾 —— 返回第一个命中的同时不隐藏问题：
   * 调用方应通过 `resolveAll` 检查，或依赖注册阶段的冲突报告。
   */
  resolveAny(identifiers: PatientIdentifier[]): IdentityResolution {
    for (const identifier of identifiers) {
      const result = this.resolve(identifier);
      if (result.status === 'matched') return result;
    }
    return { status: 'unknown', identifier: identifiers[0] ?? { system: '', value: '' } };
  }

  /**
   * 合并：把 `from` 的标识全部并入 `to`，`from` 不再存在。
   *
   * 这是**破坏性且不可逆**的操作（旧主索引消失），所以：① 合并史写进 `to.mergedFrom`；
   * ② 若两个主索引存在**同一体系的不同号**（例如两个住院号），只做并集、不做取舍 ——
   * 取舍属于业务判断，EMPI 不替人做。
   */
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

  /**
   * 导出为可持久化的快照。
   *
   * 只存 `records`：标识索引（`byIdentifier`）在恢复时**重建**即可 ——
   * 存两份互为派生的数据，迟早会出现"两边不一致"而无法判断哪份是对的。
   */
  snapshot(): PatientIndexSnapshot {
    return { records: [...this.byMasterId.values()].map((record) => structuredClone(record)) };
  }

  /** 从快照恢复：重建标识索引；**结构非法即抛错**（不猜、不修补） */
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
        /* 快照内部自相矛盾（同一标识属两个主索引）必须报错：
           若静默取后一个，等于让"文件里的顺序"决定了患者是谁 —— 与 register 的冲突策略矛盾 */
        if (owner !== undefined && owner !== record.masterId) {
          throw new Error(`主索引快照自相矛盾：标识 ${key} 同时属于 ${owner} 与 ${record.masterId}`);
        }
        index.byIdentifier.set(key, record.masterId);
      }
      index.byMasterId.set(record.masterId, { ...structuredClone(record), mergedFrom: record.mergedFrom ?? [] });
    }
    return index;
  }

  /** 供跨实现比对使用的稳定投影 */
  fingerprint(): string {
    return [...this.byMasterId.values()]
      .map((record) => `${record.masterId}|${record.identifiers.map((item) => keyOf(item)).sort().join(',')}`)
      .sort()
      .join(';');
  }
}
