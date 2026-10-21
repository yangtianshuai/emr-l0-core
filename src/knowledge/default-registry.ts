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

export const PACK_VALIDATORS: Partial<Record<PackKind, (pack: Pack) => void>> = {
  rule: (pack) => validateRulePack(pack as QcRulePack),
  template: (pack) => validateTemplatePack(pack as TemplatePack),
};

export function packValidatorFor(kind: PackKind): ((pack: Pack) => void) | undefined {
  return PACK_VALIDATORS[kind];
}

export function createEmptyPackRegistry(): PackRegistry {
  return new PackRegistry(SUPPORTED_PACK_ENGINE_APIS);
}
