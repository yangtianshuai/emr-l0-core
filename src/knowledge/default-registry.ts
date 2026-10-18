// 装配点：把"本机支持哪些契约"与"每类包怎么校验"集中在一处。

import { PackRegistry, type Pack, type PackKind, type SupportedEngineApis } from './pack.ts';
import type { QcRulePack } from '../qc/types.ts';
import { SUPPORTED_RULE_ENGINE_APIS, validateRulePack } from '../qc/rule-pack.ts';
import type { TemplatePack } from '../template/types.ts';
import { SUPPORTED_TEMPLATE_ENGINE_APIS, validateTemplatePack } from '../template/template-pack.ts';

export const SUPPORTED_PACK_ENGINE_APIS: SupportedEngineApis = {
  rule: SUPPORTED_RULE_ENGINE_APIS,
  template: SUPPORTED_TEMPLATE_ENGINE_APIS,
  term: [],
};

/** 类别专有校验：从库装载、写包、单测，用的是同一套  */
export const PACK_VALIDATORS: Partial<Record<PackKind, (pack: Pack) => void>> = {
  rule: (pack) => validateRulePack(pack as QcRulePack),
  template: (pack) => validateTemplatePack(pack as TemplatePack),
};

export function packValidatorFor(kind: PackKind): ((pack: Pack) => void) | undefined {
  return PACK_VALIDATORS[kind];
}

/**
 * 空装配：新库从零开始，一个包都不装载。
 *
 * 存在的意义是让"从空库装载"这件事在代码里也有一个明确的名字 ——
 * 演示服务启动时就用它，随后由 `openPackStore` 从库装载。
  */
export function createEmptyPackRegistry(): PackRegistry {
  return new PackRegistry(SUPPORTED_PACK_ENGINE_APIS);
}
