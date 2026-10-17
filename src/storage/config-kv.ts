/**
 * **部署参数的键值层**：模型接入 / 落位 / 签名后端 / 授权源，四类参数落在 `sealed_kv` 一张表里。
 *
 * ## 为什么这些参数也要落库
 *
 * 此前它们是五个文件（`ai-model.json`、`ai-model.key`、`dictation-placement.json`、
 * `sign-backend.json`、`reading-authority.json`）。三条具体的坏处：
 *
 *   ① **备份带不走**：备份一次数据库，判定标准与接入配置留在磁盘上 ——
 *      换台机器就变成"病历在、配置不在"，而配置决定了质控按什么标准判；
 *   ② **"重置工作区"要逐文件挑**（原先靠 `CONFIG_FILES` 那张白名单）。白名单漏一个，
 *      现场就是"重置之后模型悄悄变回离线模板 / 落位退回默认"，而没人会想到是重置干的；
 *   ③ **凭据待在会被审查、会被打包的目录树里**：`ai-model.key` 让发布前排查每次都红 ——
 *      而那是一条**真**警报（工作树里确实躺着一份可离线爆破的密文）。
 *
 * ## 一律密封，哪怕"地址不是秘密"
 *
 * 四份参数里只有模型密钥是秘密，其余（地址、策略、指纹）不是。这张表仍然统一密封：
 * **同一张表里"有的加密有的明文"才是最危险的状态** —— 后来的人只看代码，
 * 分不出哪一行是明文，于是每一次新增字段都要重新判断一遍。
 * 加密的代价是读一次解一次信封，而派生结果按口令缓存，整个进程只付一次（见下）。
 *
 * ## salt 沿用仓库里的稳定口径（不是每条各一把）
 *
 * 密封走 `WorkStore.putSealed` → `sealValue` → `resolveStateSalt`：
 * salt 来自 `L0_STATE_SALT`，没设时按口令**推导**（稳定），于是同一口令下派生结果可被缓存，
 * 整个进程只付一次 20 万次派生（实测约 12.5 秒，一次）。
 *
 * 这一条不是小事：四类配置在**每次请求**都会被重新读（适配器不缓存，为的是"改完立即生效"），
 * 若每条配置各用一把随机 salt，每个请求都要付一次 12.5 秒 —— 服务直接不可用。
 * 前提与仓库里其它稳定 salt 完全相同：**口令是密钥管理系统注入的高熵密钥，不是人记的口令**。
 *
 * ## 三态必须分清（本层最要紧的一条）
 *
 *   - `read()` 返回 `null`：**没有这一条**（从没配过）；
 *   - `read()` 返回对象：有，且解得开；
 *   - `read()` **抛错**：有，但**解不开**（口令换过 / 被改过）。
 *
 * 解不开若当作"没有"，现场表现是"我配的模型悄悄变回离线模板" ——
 * 与"没配过"完全同形，而处置完全不同（一个要排查数据，一个什么都不用做）。
 * 这条纪律与快照那边一字不差，只是换了个载体。
 */

import type { WorkStore } from './work-store.ts';

export interface ConfigKv {
  /** 读一条：`null` = 没有；**解不开 → 抛错**（绝不当作"没有"） */
  read<T>(key: string): T | null;
  /** 写一条（覆盖）。`value` 必须是可 JSON 化的对象 —— 空值不是一种配置状态，要清就 `remove` */
  write(key: string, value: unknown): void;
  /** **真删行**：清掉就得是真清（写空壳会让"我清掉了"变成一句假话） */
  remove(key: string): void;
  /** 只问有没有这一行，**不解内容**（一次性导入全靠它不覆盖已有数据，见 `hasSealed`） */
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
 * 刻意**不自己做加密**：`putSealed` / `getSealed` 已经是仓库里唯一一处密封实现，
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
