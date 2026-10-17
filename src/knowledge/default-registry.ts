/**
 * 装配点：把"本机支持哪些契约"与"每类包怎么校验"集中在一处。
 *
 * ## 为什么单独成文件
 *
 * `knowledge/pack.ts` 是**通用层**，它不该知道有哪些引擎存在；
 * `qc/rule-pack.ts` 是**规则层的实现**，它不该知道系统里一共装配了哪些包。
 * 两边都不适合放这份清单，于是单起一个"装配点"：
 * 谁要扩展知识资产（加术语引擎），就改这里，而不用侵入通用层。
 *
 * ## 这里**不再有出厂包**
 *
 * 曾经这里挂着 `BUILTIN_PACKS`（三个内置包）：启动时用它播种，并与库里的内容比对。
 * 已经删掉 —— **库是唯一来源**。包只有一条进来的路：`writePack()`
 * （演示服务里是 `POST /api/knowledge-pack-load`，见 `pack-store.ts` 文件头）。
 *
 * 代价要认下来：**新库是空的** —— 没有任何规则、一个模板也没有，质控与模板都不可用，
 * 直到有人把包写进去。这个状态会**如实报出来**（`openPackStore` 的 `source: 'empty'`；
 * 医生端显示"未装载规则包：质控当前不可用"），而不是让人以为它在跑 ——
 * "看起来有规则在跑"是这里最危险的一种状态。现成的样例包见 `samples/packs/`。
 *
 * ## 未实现的类别一律留空
 *
 * 在那里登记一个契约版本，等于对上层宣称"装进来的包会被使用" ——
 * 而实际没有任何东西会读它。那份"装进去了但没人用"的成功，比拒绝装载危险得多。
 * 模板引擎落地后 `template` 已经登记；`term` **保持为空**，载入术语包仍会被明确拒绝。
 */

import { PackRegistry, type Pack, type PackKind, type SupportedEngineApis } from './pack.ts';
import type { QcRulePack } from '../qc/types.ts';
import { SUPPORTED_RULE_ENGINE_APIS, validateRulePack } from '../qc/rule-pack.ts';
import type { TemplatePack } from '../template/types.ts';
import { SUPPORTED_TEMPLATE_ENGINE_APIS, validateTemplatePack } from '../template/template-pack.ts';

/** 本机**真实实现**的引擎契约。未实现的类别一律留空，见文件头 */
export const SUPPORTED_PACK_ENGINE_APIS: SupportedEngineApis = {
  rule: SUPPORTED_RULE_ENGINE_APIS,
  template: SUPPORTED_TEMPLATE_ENGINE_APIS,
  term: [],
};

/** 类别专有校验：从库装载、写包、单测，用的是**同一套** */
export const PACK_VALIDATORS: Partial<Record<PackKind, (pack: Pack) => void>> = {
  rule: (pack) => validateRulePack(pack as QcRulePack),
  template: (pack) => validateTemplatePack(pack as TemplatePack),
};

export function packValidatorFor(kind: PackKind): ((pack: Pack) => void) | undefined {
  return PACK_VALIDATORS[kind];
}

/**
 * 空装配：**新库从零开始**，一个包都不装载。
 *
 * 存在的意义是让"从空库装载"这件事在代码里也有一个明确的名字 ——
 * 演示服务启动时就用它，随后由 `openPackStore` 从库装载。
 */
export function createEmptyPackRegistry(): PackRegistry {
  return new PackRegistry(SUPPORTED_PACK_ENGINE_APIS);
}
