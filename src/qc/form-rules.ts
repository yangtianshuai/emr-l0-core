// 质控规则引擎（纯函数，本地运行，不依赖任何外部接口）。

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
   * 适用但判不了的那些（缺入院时间、时间无法解析、导入件…）。
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
 * 判定时刻由调用方给（不是在这里取 `Date.now()`）：引擎与谓词都必须是可复现的纯函数，
 * 否则"超时 8 小时 1 分"这种结论无法复核 —— 换一个时刻跑就变了。
  */
export function qcContextOf(doc: DocumentModel, now: string): QcContext {
  return {
    now,
    ...(doc.encounter?.admittedAt ? { admittedAt: doc.encounter.admittedAt } : {}),
    ...(doc.encounter?.dischargedAt ? { dischargedAt: doc.encounter.dischargedAt } : {}),
    ...(doc.docType?.code ? { docTypeCode: doc.docType.code } : {}),
    ...(doc.encounter?.visitType ? { visitType: doc.encounter.visitType } : {}),
    /* `visitDocs`（同一次就诊的全部文书）不在这里取：
       一份文书自己看不到别的文书，那是调用方（服务端/批处理）才知道的事 ——
       拿不到就不带，频次类规则会走"未判定"而不是猜。  */
  };
}

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

export function listFormRules(rules: readonly QcRule[]): Array<{ id: string; title: string; severity: QcRule['severity'] }> {
  return rules.map((rule) => ({ id: rule.id, title: rule.title, severity: rule.severity }));
}
