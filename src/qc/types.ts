// 质控（QC）类型定义。

import type { AnnotationSeverity } from '../core/annotations.ts';
import type { JsonValue, NodeId } from '../model/types.ts';
import type { Pack, PackItemBase } from '../knowledge/pack.ts';

export interface QcRuleHit {
  ruleId: string;
  nodeId: NodeId;
  severity: AnnotationSeverity;
  /** 一句话结论（界面主行） */
  title: string;
  /** 凭什么这么判：说清判定依据，医生才能复核  */
  detail: string;
  suggestion: string;
  /** 命中处原文片段：内容被改写后据此判断"那句话是否还在"（锚点重定位用） */
  quote?: string;
}

export interface QcUnevaluated {
  ruleId: string;
  title: string;
  nodeId: NodeId;
  reason: string;
}

/** 规则只看到这一个节点的这几项 —— 依赖面越窄，越容易证明它没有副作用 */
export interface QcNodeView {
  nodeId: NodeId;
  type: string;
  text: string;
  tags: string[];
  keyContent: boolean;
  recordedAt?: string;
  /** 来源（`human` / `ai` / `system` / `imported`）：时限判定要据此区分"能不能判" */
  origin?: string;
  /** 章节码（仅 `section` 节点有）：规则据此定位"哪一节" */
  sectionCode?: string;
}

/**
 * 同一次就诊下的另一份文书在判定里需要用到的几项。
 *
 * 用它就能表达"跨文书"的时限要求（如"病程记录之间不得超过 24 小时"），
 * 而不必新起一个引擎：跨文书的事实只是更多上下文 —— 与"入院时刻"同一处置。
 * 依赖面刻意收窄到"哪一类文书、什么时候成的文"，规则拿不到别的文书的内容。
  */
export interface QcVisitDoc {
  docId: string;
  /** 文书类型码（`docType.code`）：规则据此筛"哪一类文书要计入频次" */
  docTypeCode: string;
  /**
   * 该文书的成文时刻（`document.createdAt`）。
   *
   * 用 `createdAt` 而不是节点 `provenance.at`：后者是"最后一次被改"的时间，
   * 拿它算频次会得出"改一次就等于又写了一次"的错误结论。
   * 边界：系统内补录的文书，其 `createdAt` 是补录时刻（见交付说明）。
    */
  createdAt: string;
  title?: string;
}

export interface QcContext {
  /**
   * 判定时刻。注入而不是在谓词里取 `Date.now()`：
   * "超时 8 小时 1 分"这种边界只有在时刻可控时才可复现，而不可复现的质控结论没法复核。
    */
  now: string;
  /** 就诊/入院时刻（文档 `encounter.admittedAt`）。缺它 → 时限类规则不判定并如实上报 */
  admittedAt?: string;
  /** 文书类型码（`docType.code`，如 `WST500.1` 入院记录） */
  docTypeCode?: string;
  /** 就诊类型（门诊 / 住院 / 急诊 / 体检）：同一时限在不同就诊类型下不通用 */
  visitType?: string;
  /**
   * 出院时刻。它决定频次类判定的右端：
   * 已出院的就诊若拿"现在"当右端，最后一段间隔会被算成"出院后一直没写病程记录"——
   * 那是假阳性，而且是最容易被当成系统坏了的那类。
    */
  dischargedAt?: string;
  /**
   * 同一次就诊下的全部文书（含当前这一份）。
   * 缺省 = 调用方没有提供 → 频次类规则不判定并如实上报（不猜）。
    */
  visitDocs?: QcVisitDoc[];
}

export interface QcRule {
  id: string;
  /** 规则包内唯一；同规则同节点只提示一次（去重键的另一半由引擎拼） */
  title: string;
  severity: AnnotationSeverity;
  /**
   * 判定函数。纯函数：只看这一个节点与注入的上下文，不读全局状态、不写任何东西。
   * 返回 `null` 表示不适用或不命中（两者不区分是刻意的：医生不关心"规则没跑"）；
   * 返回 `uncertain` 表示规则适用但判不了（缺基线等）—— 这与"没命中"是两件事，
   * 必须能被看见（否则"没提示"会被当成"查过了没问题"）。
    */
  check(node: QcNodeView, ctx: QcContext): QcPredicateResult | null;
}

/**
 * 封闭的谓词种类清单。
 *
 * 这是"包是数据不是代码"的落点：包里只能引用这几个内置谓词，不能带来新判定逻辑。
 * 加一个新谓词 = 改代码 + 加用例，而不是"改一份配置"。听起来更麻烦，但正是它
 * 保证了任何一个包都不可能绕开门控去写文档 —— 它手里根本没有可写的东西。
  */
export type QcPredicateKind =
  | 'text-missing-time'
  | 'tagged-empty-text'
  | 'placeholder-residue'
  | 'document-time-limit'
  | 'visit-doc-interval'
  | 'visit-doc-required'
  | 'field-condition';

export const QC_PREDICATE_KINDS: readonly QcPredicateKind[] = [
  'text-missing-time',
  'tagged-empty-text',
  'placeholder-residue',
  'document-time-limit',
  'visit-doc-interval',
  'visit-doc-required',
  'field-condition',
];

export interface QcPredicateHit {
  /** 判定依据（不得含规则号 —— 规则号由编译期注入，包无法伪造自己的身份）  */
  detail: string;
  suggestion: string;
  quote?: string;
}

export interface QcPredicateUncertain {
  uncertain: string;
}

export type QcPredicateResult = QcPredicateHit | QcPredicateUncertain;

/**
 * 包内一条规则的声明式描述符。全部字段都是 JSON 值：可序列化、可随文件交付、可版本化。
 *
 * `detail` / `suggestion` 都是可选覆盖：缺省时用谓词内置的文案。
 * 于是"判定依据"的默认归属在代码侧（包无法谎报判定理由），
 * 而专科包仍可改写措辞（"本专科要求…"）。
  */
export interface QcRuleDescriptor extends PackItemBase {
  /** 规则号（如 `R-FORM-01`）。包内唯一 —— 它同时是去重键的一半与留痕里的依据编号 */
  itemId: string;
  title: string;
  severity: AnnotationSeverity;
  /** 用哪个内置谓词判、带什么参数 */
  predicate: { kind: QcPredicateKind; params?: Record<string, JsonValue> };
  /** 覆盖谓词内置的判定依据（不得含规则号）  */
  detail?: string;
  /** 覆盖谓词内置的建议动作 */
  suggestion?: string;
}

export type QcConditionParamKind = 'integer' | 'string' | 'enum' | 'string-list' | 'boolean';

export interface QcConditionParamSpec {
  /** 占位符名（`when` 里写 `$` + 它）。字母开头，字母数字下划线 */
  name: string;
  kind: QcConditionParamKind;
  /** 人话标签：规则表单里那一格的标题 */
  label: string;
  /** 必填：不给它这条判定方式根本没法判（界面据此提前拦一次，服务端照拒） */
  required?: boolean;
  /** `enum` 的可选值 */
  options?: readonly string[];
  /** 整数的单位（只用于人话回读：`24 小时` / `10 字`） */
  unit?: string;
  /** 这一格填什么、留空会怎样 —— 写成界面上能照读的一句话 */
  doc: string;
}

export interface QcConditionDefinition extends PackItemBase {
  itemType: 'condition';
  /** 条件编码（如 `C-CUSTOM-1`）。包内唯一；规则引用时写的就是它 */
  itemId: string;
  name: string;
  description?: string;
  /**
   * 参数规格。缺省 = 不带参数（老包原样兼容，行为一个字不变）。
   *
   * 带了它，`when` 里就能出现 `$名字` 占位符，由引用它的规则填实参 ——
   * 于是"一条判定方式被多条规则以不同阈值复用"不必发版。
    */
  params?: QcConditionParamSpec[];
  when: JsonValue;
}

/** 规则包里的一类条目：规则 或 具名条件 */
export type QcRuleItem = QcRuleDescriptor | QcConditionDefinition;

export type QcRulePack = Pack<QcRuleItem>;
