import type { AnnotationSeverity } from '../core/annotations.ts';
import type { JsonValue, NodeId } from '../model/types.ts';
import type { Pack, PackItemBase } from '../knowledge/pack.ts';

export interface QcRuleHit {
  ruleId: string;
  nodeId: NodeId;
  severity: AnnotationSeverity;
  title: string;
  detail: string;
  suggestion: string;
  quote?: string;
}

export interface QcUnevaluated {
  ruleId: string;
  title: string;
  nodeId: NodeId;
  reason: string;
}

export interface QcNodeView {
  nodeId: NodeId;
  type: string;
  text: string;
  tags: string[];
  keyContent: boolean;
  recordedAt?: string;
  origin?: string;
  sectionCode?: string;
}

export interface QcVisitDoc {
  docId: string;
  docTypeCode: string;
  createdAt: string;
  title?: string;
}

export interface QcContext {
  now: string;
  admittedAt?: string;
  docTypeCode?: string;
  visitType?: string;
  dischargedAt?: string;
  visitDocs?: QcVisitDoc[];
}

export interface QcRule {
  id: string;
  title: string;
  severity: AnnotationSeverity;
  check(node: QcNodeView, ctx: QcContext): QcPredicateResult | null;
}

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
  detail: string;
  suggestion: string;
  quote?: string;
}

export interface QcPredicateUncertain {
  uncertain: string;
}

export type QcPredicateResult = QcPredicateHit | QcPredicateUncertain;

export interface QcRuleDescriptor extends PackItemBase {
  itemId: string;
  title: string;
  severity: AnnotationSeverity;
  predicate: { kind: QcPredicateKind; params?: Record<string, JsonValue> };
  /** 覆盖谓词内置的判定依据（不得含规则号）  */
  detail?: string;
  suggestion?: string;
}

export type QcConditionParamKind = 'integer' | 'string' | 'enum' | 'string-list' | 'boolean';

export interface QcConditionParamSpec {
  name: string;
  kind: QcConditionParamKind;
  label: string;
  required?: boolean;
  options?: readonly string[];
  unit?: string;
  doc: string;
}

export interface QcConditionDefinition extends PackItemBase {
  itemType: 'condition';
  itemId: string;
  name: string;
  description?: string;
  params?: QcConditionParamSpec[];
  when: JsonValue;
}

export type QcRuleItem = QcRuleDescriptor | QcConditionDefinition;

export type QcRulePack = Pack<QcRuleItem>;
