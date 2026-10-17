/**
 * 规则条目的编辑（新建 / 修改 / 删除）。
 *
 * ## 它改的是什么
 *
 * 与"整包载入"（`POST /api/knowledge-pack-load`）改的是同一件东西：**包内容**。
 * 所以路径也一样 —— 调用方走 `writePack()`：内容指纹变化、前后指纹进系统审计。
 * 这里刻意不提供"改个字段不留痕"的近路：承认有这种近路，等于承认
 * "当时按哪一版判的"可以查不出来。
 *
 * ## 开放到哪一格为止
 *
 * 只开放"包本来就能表达"的字段：标题 / 级别 / 判定方式与参数 / 判定依据文案 / 建议动作。
 * **判定机制不在其中**：谓词只能从封闭注册表里挑（`QC_PREDICATES`），参数交给每个谓词
 * 自己的 `normalizeParams()` 判。要加一种新判定逻辑，仍然得改代码 + 加用例 ——
 * 这正是"包是数据不是代码"的落点（见 `predicates.ts` 文件头）。
 *
 * 级别只开放 `info` / `warn`：`block` 是"卡住流程"那一档，形式类质控的产出一律不含它
 * （有用例守着），所以"能不能新造一条能阻断的规则"不该由一次保存决定。
 *
 * ## 条目编号
 *
 * `itemId` 由这里按 `R-CUSTOM-N` 递增生成，不由界面填：它同时是去重键的一半与
 * 留痕里的依据编号（医生看到的是"规则 R-CUSTOM-1：…"），事后改它等于换一条新规则。
 * 新建的条目放进**自建包**（`doc.rule.custom`），于是"哪些是本院自己维护的"
 * 一眼分得出来 —— 否则下次有人载入一份交付方的包，本院那几条会被整体覆盖，
 * 而没人知道覆盖掉了什么。
 */

import type { AnnotationSeverity } from '../core/annotations.ts';
import type { JsonValue } from '../model/types.ts';
import { QC_PREDICATES } from './predicates.ts';
import {
  RULE_ENGINE_API,
  RulePackError,
  assertRuleDescriptor,
  isConditionItem,
  resolvedConditionsOf,
  ruleItemsOf,
  type ConditionLibrary,
} from './rule-pack.ts';
import type { QcPredicateKind, QcRuleDescriptor, QcRulePack } from './types.ts';

/** **自建**（非交付方提供）的规则包 id：界面上新建的规则都放这一份里 */
export const CUSTOM_RULE_PACK_ID = 'doc.rule.custom';

/**
 * 条目级编辑可选的级别：**不含 `block`**。
 *
 * 界面上的下拉照它生成，服务端也照它拒 —— 两处同一个来源。
 * 理由：`block` 把一条判定变成"卡住流程"，而形式类质控的引擎产出里根本没有这一档；
 * 真要开一个能阻断的规则，那是一次内核改动（改这里 + 加用例），不是一次配置保存。
 */
export const EDITABLE_RULE_SEVERITIES: readonly AnnotationSeverity[] = ['info', 'warn'];

/**
 * 自建包的骨架。
 *
 * 为什么不塞进交付方那份包：**"哪些是本院自己维护的"必须一眼分得出来**，
 * 否则下次有人载入一份新包，本院改过的东西被整体覆盖，而没人知道覆盖掉了什么。
 */
export function customRulePackBase(): QcRulePack {
  return {
    packId: CUSTOM_RULE_PACK_ID,
    kind: 'rule',
    engineApi: RULE_ENGINE_API,
    name: '院内自建质控规则',
    vendor: '本机构维护',
    items: [],
  };
}

/** 新建一条规则的输入（`itemId` 不给：由这里按序号生成） */
export interface RuleDraftInput {
  title: string;
  severity: AnnotationSeverity;
  predicate: { kind: QcPredicateKind; params?: Record<string, JsonValue> };
  /** 覆盖谓词内置的判定依据（**不得含自身规则号**，有校验守着） */
  detail?: string;
  suggestion?: string;
}

/**
 * 条目级编辑只动这几个字段。
 *
 * `detail` / `suggestion` 给 `null` 或空串 = **清掉这个覆盖**（回到谓词内置文案）——
 * 与"写一个空串进去"是两件事：空串过不了校验，而且会让"改回原样"回不到原来那一版内容指纹。
 */
export interface RulePatch {
  title?: string;
  severity?: AnnotationSeverity;
  predicate?: { kind: QcPredicateKind; params?: Record<string, JsonValue> };
  detail?: string | null;
  suggestion?: string | null;
}

function trimOrEmpty(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** 级别：只收 `info` / `warn`（`block` 与非法值都拒，理由见文件头） */
function normalizeSeverity(value: unknown): AnnotationSeverity {
  if (typeof value !== 'string' || !(EDITABLE_RULE_SEVERITIES as readonly string[]).includes(value)) {
    throw new RulePackError(
      'E_RULE_SEVERITY_EDIT_LIMIT',
      `级别只能是 ${EDITABLE_RULE_SEVERITIES.join(' / ')}：block 是"卡住流程"那一档，`
        + '形式类质控的产出不含它 —— 要新造一条能阻断流程的规则，得改内核并加用例，不是改一次配置',
    );
  }
  return value as AnnotationSeverity;
}

/**
 * 新建一条规则：返回一份**新包**（`pack` 为 null 时连包一起建出来），原包不动。
 *
 * 条目上**不设** `enabled`：条目开关在库里是单独一列（`disabled`），不在包内容里 ——
 * 若写进内容，"关掉一条规则"就会连带改变内容指纹，而"换了包"与"只是关了条规则"
 * 就又混成一件事了（见 `pack-store.ts`）。"新建出来先不跑"由调用方落那一列。
 */
export function addRule(
  pack: QcRulePack | null,
  input: RuleDraftInput,
  library: ConditionLibrary | null = null,
): { pack: QcRulePack; itemId: string } {
  const base = pack ?? customRulePackBase();
  /* `itemId` 按 `R-CUSTOM-N` 递增：可读、稳定，且不依赖时间（同一秒建两条也不会撞）。
     只数**规则**条目：包里还有具名条件（`C-CUSTOM-N`），它们的编码不参与这里的递增 */
  let seq = 1;
  for (const item of ruleItemsOf(base)) {
    const matched = /^R-CUSTOM-(\d+)$/.exec(item.itemId);
    if (matched) seq = Math.max(seq, Number(matched[1]) + 1);
  }
  const itemId = `R-CUSTOM-${seq}`;
  const descriptor: QcRuleDescriptor = {
    itemId,
    title: trimOrEmpty(input.title),
    severity: normalizeSeverity(input.severity),
    predicate: input.predicate,
  };
  const detail = trimOrEmpty(input.detail);
  if (detail !== '') descriptor.detail = detail;
  const suggestion = trimOrEmpty(input.suggestion);
  if (suggestion !== '') descriptor.suggestion = suggestion;
  /* 判定方式与参数交给**同一条**校验路径判（未知谓词 / 非法参数都在这里被拒），
     而不是在编辑口子另写一套 —— 两套的漂移表现是"保存时收下了、扫描时却少一条"。
     带上"这个包能引用到的判定方式"（**库里的 + 包自带的**）：规则可以引用判定方式，
     校验必须看得见它们 —— 少了 `library` 这一步，"用得上判定方式"的规则会在保存时被误拒 */
  assertRuleDescriptor(base.packId, descriptor, resolvedConditionsOf(base, library));
  return { pack: { ...base, items: [...base.items, descriptor] }, itemId };
}

/**
 * 改一条规则：返回一份**新包**，原包不动。
 *
 * 为什么返回新包而不是就地改：调用方要能在写库失败时保持内存里那一份原样。
 * 就地改的话，一次失败的保存会留下"界面说没成功、内容却已经变了"。
 */
export function patchRuleDescriptor(
  pack: QcRulePack,
  itemId: string,
  patch: RulePatch,
  library: ConditionLibrary | null = null,
): QcRulePack {
  /* 只找**规则**条目：包里还有具名条件，它们的编码与规则同一命名空间，
     若不加这一层判断，"改一条规则"可能改到一条条件对象上（字段名不同，会静默写坏） */
  const index = pack.items.findIndex((item) => !isConditionItem(item) && item.itemId === itemId);
  if (index < 0) {
    throw new RulePackError('E_RULE_ITEM_NOT_FOUND', `规则包「${pack.packId}」里没有条目「${itemId}」：它可能已被删除`);
  }
  if (patch.title === undefined && patch.severity === undefined && patch.predicate === undefined
    && patch.detail === undefined && patch.suggestion === undefined) {
    throw new RulePackError(
      'E_RULE_ITEM_INVALID',
      '没有要改的字段（这里开放标题 / 级别 / 判定方式与参数 / 判定依据 / 建议动作）',
    );
  }
  const next: QcRuleDescriptor = { ...(pack.items[index] as QcRuleDescriptor) };
  if (patch.title !== undefined) next.title = trimOrEmpty(patch.title);
  if (patch.severity !== undefined) next.severity = normalizeSeverity(patch.severity);
  if (patch.predicate !== undefined) next.predicate = patch.predicate;
  /* 清掉覆盖时**删字段**而不是写空串：空串过不了校验（"若提供就必须是非空字符串"），
     而且会让"改回原样"回不到原来那一版内容指纹 —— 可逆是这条编辑口子唯一的安全感 */
  if (patch.detail !== undefined) {
    const detail = patch.detail === null ? '' : trimOrEmpty(patch.detail);
    if (detail === '') delete next.detail;
    else next.detail = detail;
  }
  if (patch.suggestion !== undefined) {
    const suggestion = patch.suggestion === null ? '' : trimOrEmpty(patch.suggestion);
    if (suggestion === '') delete next.suggestion;
    else next.suggestion = suggestion;
  }
  /* 改完当场校验一遍：写包时也会校验整包，但那时报的是"整包不通过"，
     而人需要知道的是"这一条哪里不对"。判定方式表一并带上（改的可能是"引用哪一条判定方式"），
     且**要带上库那一份** —— 少了它，"改成引用库里的判定方式"会被误拒 */
  assertRuleDescriptor(pack.packId, next, resolvedConditionsOf(pack, library));
  const items = pack.items.slice();
  items[index] = next;
  return { ...pack, items };
}

/**
 * 删一条规则：返回一份**新包**，原包不动。
 *
 * 删掉它**不改动任何病历**：质控提示是**旁挂注解**（带着当时的规则号与依据文案），
 * 规则不在了，注解还在、还读得出来 —— 只是"出自哪一条规则"再也追不到内容了。
 * 这句话要说在界面上，否则"删掉一条规则"听起来像"删掉一批质控结论"。
 */
export function removeRule(pack: QcRulePack, itemId: string): QcRulePack {
  /* 同上：只删规则条目，别把同名的条件（如果有）一起删掉 */
  const index = pack.items.findIndex((item) => !isConditionItem(item) && item.itemId === itemId);
  if (index < 0) {
    throw new RulePackError('E_RULE_ITEM_NOT_FOUND', `规则包「${pack.packId}」里没有条目「${itemId}」`);
  }
  return { ...pack, items: pack.items.filter((item, at) => at !== index) };
}

/** 谓词的人话名（审计与界面提示里用）。未知谓词**原样回报**，不替它编一个名字出来 */
export function predicateLabelOf(kind: string): string {
  if (!Object.prototype.hasOwnProperty.call(QC_PREDICATES, kind)) return kind;
  return QC_PREDICATES[kind as QcPredicateKind].label;
}
