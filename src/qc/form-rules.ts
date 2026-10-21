import type { NodeId, DocNode, DocumentModel } from '../model/types.ts';
import type { QcContext, QcRule, QcRuleHit, QcNodeView, QcUnevaluated } from './types.ts';

export type { QcNodeView, QcRuleHit, QcRule, QcContext, QcUnevaluated } from './types.ts';

export interface QcScanResult {
  hits: QcRuleHit[];
  scannedNodes: number;
  rules: number;
  unevaluated: QcUnevaluated[];
}

function toView(nodeId: NodeId, node: DocNode): QcNodeView {
  const text = node.type === 'text' ? node.runs.map((run) => run.text).join('') : '';
  return {
    nodeId,
    type: node.type,
    text,
    tags: (node.tags ?? []).map((tag) => String(tag)),
    keyContent: node.keyContent === true,
    ...(node.provenance?.at ? { recordedAt: node.provenance.at } : {}),
    ...(node.provenance?.origin ? { origin: node.provenance.origin } : {}),
    ...(node.type === 'section' && node.sectionCode ? { sectionCode: node.sectionCode } : {}),
  };
}

export function qcContextOf(doc: DocumentModel, now: string): QcContext {
  return {
    now,
    ...(doc.encounter?.admittedAt ? { admittedAt: doc.encounter.admittedAt } : {}),
    ...(doc.encounter?.dischargedAt ? { dischargedAt: doc.encounter.dischargedAt } : {}),
    ...(doc.docType?.code ? { docTypeCode: doc.docType.code } : {}),
    ...(doc.encounter?.visitType ? { visitType: doc.encounter.visitType } : {}),
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
