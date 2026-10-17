/**
 * 质控（QC）类型定义。
 *
 * ## 为什么单独放一个文件
 *
 * 三处都要这些类型，而它们之间有**单向依赖**：
 *   `types.ts`  ←  `predicates.ts`（封闭谓词注册表）
 *   `types.ts`  ←  `rule-pack.ts`（包 → 可运行规则）
 *   `rule-pack.ts`  ←  `form-rules.ts`（引擎 + 内置包落成的规则集）
 *
 * 若把这些类型放在任一端（比如 `form-rules.ts`），`rule-pack.ts` 就必须回头 import 它，
 * 而 `form-rules.ts` 又要 import `rule-pack.ts` —— 立刻成环。类型单独成文件是**为了断环**，
 * 不是为了"整齐"。
 */

import type { AnnotationSeverity } from '../core/annotations.ts';
import type { JsonValue, NodeId } from '../model/types.ts';
import type { Pack, PackItemBase } from '../knowledge/pack.ts';

export interface QcRuleHit {
  ruleId: string;
  nodeId: NodeId;
  severity: AnnotationSeverity;
  /** 一句话结论（界面主行） */
  title: string;
  /** **凭什么这么判**：说清判定依据，医生才能复核 */
  detail: string;
  suggestion: string;
  /** 命中处原文片段：内容被改写后据此判断"那句话是否还在"（锚点重定位用） */
  quote?: string;
}

/**
 * 规则**适用但判不了**的一条记录。
 *
 * 界面必须把它显示出来：只说"共 N 条提示"、不说的那部分（没判的）会被读成"这些也查过了"。
 * 这与"读不出来不能说成没有"是同一条纪律。
 */
export interface QcUnevaluated {
  ruleId: string;
  title: string;
  nodeId: NodeId;
  /** 为什么判不了（可直接展示给人看，不含规则号——规则号在 `ruleId` 里） */
  reason: string;
}

/** 规则只看到这一个节点的这几项 —— 依赖面越窄，越容易证明它没有副作用 */
export interface QcNodeView {
  nodeId: NodeId;
  type: string;
  text: string;
  tags: string[];
  keyContent: boolean;
  /**
   * 该节点的**记录时间**（`provenance.at`）。
   *
   * ⚠️ 它的含义是"**系统内写入时刻**"，不是文书里写的临床记录时间。这两者在补录、
   * 迁移、外部导入时**不相等** —— 时限类规则必须把这一点说清，并在导入件上拒绝判定
   * （见 `predicates.ts` 的 `document-time-limit`）。
   */
  recordedAt?: string;
  /** 来源（`human` / `ai` / `system` / `imported`）：时限判定要据此区分"能不能判" */
  origin?: string;
  /** 章节码（仅 `section` 节点有）：规则据此定位"哪一节" */
  sectionCode?: string;
}

/**
 * 同一次就诊下的**另一份文书**在判定里需要用到的几项。
 *
 * 用它就能表达"跨文书"的时限要求（如"病程记录之间不得超过 24 小时"），
 * 而**不必新起一个引擎**：跨文书的事实只是**更多上下文** —— 与"入院时刻"同一处置。
 * 依赖面刻意收窄到"哪一类文书、什么时候成的文"，规则拿不到别的文书的内容。
 */
export interface QcVisitDoc {
  docId: string;
  /** 文书类型码（`docType.code`）：规则据此筛"哪一类文书要计入频次" */
  docTypeCode: string;
  /**
   * 该文书的**成文时刻**（`document.createdAt`）。
   *
   * 用 `createdAt` 而不是节点 `provenance.at`：后者是"最后一次被改"的时间，
   * 拿它算频次会得出"改一次就等于又写了一次"的错误结论。
   * 边界：系统内补录的文书，其 `createdAt` 是补录时刻（见交付说明）。
   */
  createdAt: string;
  title?: string;
}

/**
 * **文档级**上下文：节点自己看不到、但判定必须用到的那些事实。
 *
 * 为什么要单起一个参数（而不是塞进 `QcNodeView`）：这些值**整篇文书都一样**，
 * 塞进每个节点会让"每个节点各带一份入院时间"变成可能 —— 而那是自相矛盾的数据。
 *
 * 时限类规则**必须有它**：没有基线就不该判定，也不该猜（见 `uncertain` 通道）。
 */
export interface QcContext {
  /**
   * 判定时刻。**注入**而不是在谓词里取 `Date.now()`：
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
   * 出院时刻。**它决定频次类判定的右端**：
   * 已出院的就诊若拿"现在"当右端，最后一段间隔会被算成"出院后一直没写病程记录"——
   * 那是假阳性，而且是最容易被当成系统坏了的那类。
   */
  dischargedAt?: string;
  /**
   * **同一次就诊下的全部文书**（含当前这一份）。
   * 缺省 = 调用方没有提供 → 频次类规则**不判定**并如实上报（不猜）。
   */
  visitDocs?: QcVisitDoc[];
}

export interface QcRule {
  id: string;
  /** 规则包内唯一；同规则同节点只提示一次（去重键的另一半由引擎拼） */
  title: string;
  severity: AnnotationSeverity;
  /**
   * 判定函数。**纯函数**：只看这一个节点与注入的上下文，不读全局状态、不写任何东西。
   * 返回 `null` 表示不适用或不命中（两者不区分是刻意的：医生不关心"规则没跑"）；
   * 返回 `uncertain` 表示**规则适用但判不了**（缺基线等）—— 这与"没命中"是两件事，
   * 必须能被看见（否则"没提示"会被当成"查过了没问题"）。
   */
  check(node: QcNodeView, ctx: QcContext): QcPredicateResult | null;
}

/* --------------------------- 谓词与规则包 --------------------------- */

/**
 * **封闭的**谓词种类清单。
 *
 * 这是"包是数据不是代码"的落点：包里只能引用这几个内置谓词，**不能带来新判定逻辑**。
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
  /* 第 7 种是**唯一一种由使用者拼出来**的判法（条件树，见 `condition.ts`）：
     它排在最后，是因为它不解决"某类常见问题"，而是兜住"还没被命名为谓词的那些需求"。 */
  'field-condition',
];

export interface QcPredicateHit {
  /** 判定依据（**不得含规则号** —— 规则号由编译期注入，包无法伪造自己的身份） */
  detail: string;
  suggestion: string;
  quote?: string;
}

/**
 * **判不了**（与"没命中"必须分开）。
 *
 * 为什么单列一条通道：时限类规则的判定依赖文书外的事实（入院时间）。
 * 缺它时若静默按"没命中"处理，界面上就是"跑过了、没问题" —— 而实际是**根本没判**。
 * 这与本仓库"读不出来不能说成没有"是同一条纪律。
 */
export interface QcPredicateUncertain {
  uncertain: string;
}

export type QcPredicateResult = QcPredicateHit | QcPredicateUncertain;

/**
 * 包内一条规则的**声明式**描述符。全部字段都是 JSON 值：可序列化、可随文件交付、可版本化。
 *
 * `detail` / `suggestion` 都是**可选覆盖**：缺省时用谓词内置的文案。
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
  /** 覆盖谓词内置的判定依据（**不得含规则号**） */
  detail?: string;
  /** 覆盖谓词内置的建议动作 */
  suggestion?: string;
}

/**
 * **具名条件**（条件库）条目：一条可以被多条规则引用的判定条件。
 *
 * ## 为什么要有它
 *
 * 条件树内联在规则里时，"同一个口径要用在三条规则上"只能手抄三遍 ——
 * 抄错一处不会有人发现，改口径时也要记得改三处。具名条件把它变成一份被引用的资产：
 * 改一处，引它的规则一起变（**这正是它的代价，见下**）。
 *
 * ## 两条刻意的约束
 *
 * 1) **只能引用同一个包里的条件**（照模板公式引控件那一套）。
 *    跨包引用会让"这条规则到底按什么判"取决于另一个包有没有装、装的是哪一版，
 *    而包是可以单独装卸的 —— 那时"规则在跑、条件不在"就会成为一种常态。
 * 2) **条件没有"停用"这一档**（`enabled` 不写进内容）。别的条目停用意味着"这条不跑"，
 *    而条件自己不跑，它只是被引用：停用一条被引用的条件，等于停用那几条规则 ——
 *    那件事应该在规则上做，否则一次"停用条件"会静默改掉一批规则的存亡。
 *
 * ## 引用带来的代价（必须写在类型旁边）
 *
 * 改一条被引用的条件，会影响所有引用它的规则，而**规则包的内容指纹不会变**
 * （变的是条件本身所在的那一处内容）。所以界面在保存前必须把"会影响哪几条"摆出来，
 * 且删除被引用的条件必须被拒 —— 参照模板公式的 `removeExpression`。
 *
 * `when` 是**未校验的 JSON**（与规则的 `predicate.params` 同一个口径）：
 * 包里存的就是它，读的人必须自己过一遍 `normalizeCondition()` ——
 * 类型层面挡不住"包被手改过"，挡它的是那个校验函数（fail-closed）。
 */
/**
 * **判定方式的参数规格**（T1新增）：让一条判定方式被多条规则以不同阈值复用。
 *
 * ## 为什么它必须是封闭的四档
 *
 * 参数是"判定方式"唯一被开放的部分，所以它必须**窄**：一个整数、一个词表、一个枚举、
 * 一个布尔。一旦允许"参数决定算子"或"参数拼进字符串"，形式立刻收敛成自定义表达式 ——
 * 要么需要 `eval`（包就能塞可执行代码），要么需要自己写解析器。模板公式在同一处分了同一刀。
 *
 * ## 占位符只允许出现在取值位置
 *
 * `when` 里写 `"value": "$limitHours"`，只表示"这一格的值由规则填"。
 * **不能**替换 `field` / `op` / 结构节点 —— 那替换的是"读什么、怎么算"，
 * 而"怎么算"按约定不放开（见 `condition.ts` 文件头）。
 */
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
  /** 条目类别。规则的条目**不写**这个字段（老包原样兼容），见 `isConditionItem` */
  itemType: 'condition';
  /** 条件编码（如 `C-CUSTOM-1`）。包内唯一；规则引用时写的就是它 */
  itemId: string;
  name: string;
  description?: string;
  /**
   * 参数规格。缺省 = **不带参数**（老包原样兼容，行为一个字不变）。
   *
   * 带了它，`when` 里就能出现 `$名字` 占位符，由引用它的规则填实参 ——
   * 于是"一条判定方式被多条规则以不同阈值复用"不必发版。
   */
  params?: QcConditionParamSpec[];
  /** 判定条件本身（可含 `$参数` 占位符，见 `params`） */
  when: JsonValue;
}

/** 规则包里的一类条目：规则 或 具名条件 */
export type QcRuleItem = QcRuleDescriptor | QcConditionDefinition;

export type QcRulePack = Pack<QcRuleItem>;
