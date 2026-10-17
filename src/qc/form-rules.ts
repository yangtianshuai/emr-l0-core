/**
 * 质控规则引擎（**纯函数，本地运行，不依赖任何外部接口**）。
 *
 * ## 为什么规则类质控不需要接口
 *
 * "缺记录时间""必填项为空""模板占位符没删干净""入院记录是否 24 小时内完成"这类判断，
 * 规则本身就是**可判定的**：给定一份文档与一个注入的判定时刻，逐节点跑一遍就行。
 * 它不需要模型、不需要事件分发、也不需要网络 —— 所以它**今天就能产生真实收益**，
 * 而内涵类质控（诊断与用药不符）才真的需要外部引擎。
 * 把这两类混在一个"质控接口"里，会让规则类也背上网络依赖，而它本可以毫秒级完成。
 *
 * ## 判定需要的事实分两处（这也是契约从 `check(node)` 扩到 `check(node, ctx)` 的原因）
 *
 * 形式类只看**节点自己**；时限类还要看**文书级事实**（入院时刻、文书类型、就诊类型）——
 * 那些写在文档上而不在节点里，于是以 `QcContext` 显式传入。
 * 时刻**由调用方注入**（引擎不取 `Date.now()`）：不可复现的质控结论没法复核。
 *
 * ## 规则从哪来：包（`rule-pack.ts`），不是硬编码
 *
 * 本文件只负责**引擎**：把规则跑在节点上、产出命中。规则本身由**规则包**提供
 * （`QcRulePack` → 编译成 `QcRule[]`）。这样医院想关掉某一条不必删代码，
 * 专科包也能独立交付 —— 而"这台机器跑的是哪份规则"由注册表的内容指纹回答。
 *
 * **引擎不自带任何规则**：`rules` 是必填参数，调用方给什么就跑什么
 * （演示服务传 `rulesFromRegistry(registry)`）。这里曾经有一个 `FORM_RULES` 常量兜底，
 * 那是"内置包"时代的残留 —— 兜底会把"库里一个包都没有"悄悄变成"用内置那套跑"，
 * 而医生看到的会是"质控正常"。**空就是空**，界面上显示"未装载规则包：质控当前不可用"。
 *
 * ## 五条纪律（每条都有代价，见各条理由）
 *
 * 1) **只报不阻断**：`severity` 只是展示级别，不参与签章门控。
 *    一旦让规则间接拥有流程控制权，某条规则误报就会让病历签不出去，而临床不会等规则。
 * 2) **宁可不报，不可误报**：判定一律取**保守**方向（见 `predicates.ts`）。
 * 3) **判定必须可解释**：每条命中都要说清"凭什么这么判"（`detail`）。医生据此复核，
 *    才有资格判断"这条提示是不是对的"。
 * 4) **不落笔、不进正文**：产出走旁挂注解（不改 rev、不进文档留痕），签章后仍可处置。
 * 5) **纯函数、无副作用**：`check` 只读它拿到的那个节点，不读全局状态、不写任何东西。
 *
 * ## 与"注解必须给依据"的关系
 *
 * 内核要求 system 来源的注解必带 `ruleId`（无依据的提示无法复核）。这里每条命中都带
 * 规则号与原文片段，正好满足 —— 这不是为了过校验，而是因为**医生看到的每句话都该能追到出处**。
 */

import type { NodeId, DocNode, DocumentModel } from '../model/types.ts';
import type { QcContext, QcRule, QcRuleHit, QcNodeView, QcUnevaluated } from './types.ts';

/* 类型转发：既有调用方（自测、界面）从本文件取类型，改成两处 import 只会制造无谓的改动 */
export type { QcNodeView, QcRuleHit, QcRule, QcContext, QcUnevaluated } from './types.ts';

export interface QcScanResult {
  hits: QcRuleHit[];
  /** 跑过判定的节点数（如实上报，便于回答"它到底检查了什么"） */
  scannedNodes: number;
  /** 规则条数 */
  rules: number;
  /**
   * **适用但判不了**的那些（缺入院时间、时间无法解析、导入件…）。
   *
   * 单列一栏而不是混进 `hits`：它既不是"命中"也不是"没问题"。
   * 少了这一栏，"跑过了"就会被读成"都查过了"—— 而实际有一批根本没判。
   */
  unevaluated: QcUnevaluated[];
}

function toView(nodeId: NodeId, node: DocNode): QcNodeView {
  const text = node.type === 'text' ? node.runs.map((run) => run.text).join('') : '';
  return {
    nodeId,
    type: node.type,
    text,
    /* 统一成字符串：规则只需要"有没有标签、标签是什么"用于展示与去重，
       不必知道标签的完整结构（依赖面越窄越好） */
    tags: (node.tags ?? []).map((tag) => String(tag)),
    keyContent: node.keyContent === true,
    /* 记录时间与来源：时限类规则要判"什么时候写的、能不能判" */
    ...(node.provenance?.at ? { recordedAt: node.provenance.at } : {}),
    ...(node.provenance?.origin ? { origin: node.provenance.origin } : {}),
    /* `sectionCode` 只在 `SectionNode` 上有（联合类型里靠 `type` 收窄） */
    ...(node.type === 'section' && node.sectionCode ? { sectionCode: node.sectionCode } : {}),
  };
}

/**
 * 从一份文书构造判定上下文。
 *
 * **判定时刻由调用方给**（不是在这里取 `Date.now()`）：引擎与谓词都必须是可复现的纯函数，
 * 否则"超时 8 小时 1 分"这种结论无法复核 —— 换一个时刻跑就变了。
 */
export function qcContextOf(doc: DocumentModel, now: string): QcContext {
  return {
    now,
    ...(doc.encounter?.admittedAt ? { admittedAt: doc.encounter.admittedAt } : {}),
    ...(doc.encounter?.dischargedAt ? { dischargedAt: doc.encounter.dischargedAt } : {}),
    ...(doc.docType?.code ? { docTypeCode: doc.docType.code } : {}),
    ...(doc.encounter?.visitType ? { visitType: doc.encounter.visitType } : {}),
    /* `visitDocs`（同一次就诊的全部文书）**不在这里取**：
       一份文书自己看不到别的文书，那是调用方（服务端/批处理）才知道的事 ——
       拿不到就不带，频次类规则会走"未判定"而不是猜。 */
  };
}

/**
 * 扫描节点集合，返回所有命中。
 *
 * 参数**只要 `nodes`**（不是整份 `DocumentModel`）：引擎本来也只读节点 ——
 * 依赖面越窄，越容易证明它没有副作用（没有别的东西可读，也就没有别的东西可写）。
 *
 * 顺序取 `Object.keys` 的顺序（即文档自身的顺序）：命中排列必须稳定，
 * 同文档两次跑结果一致。顺序若随机跳动，医生会怀疑结果本身不可靠。
 *
 * `rules` **必填**：按**已装载并启用**的规则跑，传 `rulesFromRegistry(registry)`。
 * 不给缺省值是有意的 —— 缺省会把"没有规则"变成"用某套默认规则跑"，见文件头。
 */
export function runFormRules(
  nodes: Record<NodeId, DocNode>,
  ctx: QcContext,
  rules: readonly QcRule[],
): QcScanResult {
  const hits: QcRuleHit[] = [];
  const unevaluated: QcUnevaluated[] = [];
  const nodeIds = Object.keys(nodes) as NodeId[];
  for (const nodeId of nodeIds) {
    const node = nodes[nodeId];
    if (!node) continue;
    const view = toView(nodeId, node);
    for (const rule of rules) {
      const result = rule.check(view, ctx);
      if (!result) continue;
      /* 判不了的分开收集：它既不是命中，也不是"没问题" */
      if ('uncertain' in result) {
        unevaluated.push({ ruleId: rule.id, title: rule.title, nodeId, reason: result.uncertain });
        continue;
      }
      const hit: QcRuleHit = {
        ruleId: rule.id,
        nodeId,
        severity: rule.severity,
        title: rule.title,
        detail: result.detail,
        suggestion: result.suggestion,
      };
      if (result.quote) hit.quote = result.quote;
      hits.push(hit);
    }
  }
  return { hits, scannedNodes: nodeIds.length, rules: rules.length, unevaluated };
}

/** 规则清单（供界面展示"这条为什么弹"，而不是让医生猜） */
export function listFormRules(rules: readonly QcRule[]): Array<{ id: string; title: string; severity: QcRule['severity'] }> {
  return rules.map((rule) => ({ id: rule.id, title: rule.title, severity: rule.severity }));
}
