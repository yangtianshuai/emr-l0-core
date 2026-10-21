import type { DocNode, JsonValue, NodeId, PatientRef, EncounterRef } from '../model/types.ts';
import type { PackRegistry } from '../knowledge/pack.ts';
import { evaluate } from './expression.ts';
import type { ExpressionDefinition, TemplatePack } from './types.ts';

export const EXPR_REF_PREFIX = 'expr:';
export const EXPR_DEP_REF_PREFIX = 'expr-dep:';

export interface RecomputeChange {
  nodeId: NodeId;
  key: string;
  controlId: string;
  previous: JsonValue;
  next: number | string;
}

export interface RecomputePending {
  nodeId: NodeId;
  key: string;
  controlName: string;
  missing: string[];
}

export interface RecomputePlan {
  changes: RecomputeChange[];
  pending: RecomputePending[];
  unresolved: NodeId[];
  skipped: Array<{ nodeId: NodeId; key: string }>;
}

function evidenceOf(node: DocNode): NonNullable<DocNode['provenance']['evidence']> {
  return node.provenance.evidence ?? [];
}

function parseRef(ref: string): { packId: string; controlId: string } | null {
  const body = ref.slice(EXPR_REF_PREFIX.length);
  const at = body.indexOf('/');
  if (at <= 0 || at === body.length - 1) return null;
  return { packId: body.slice(0, at), controlId: body.slice(at + 1) };
}

export function contextFromDocument(doc: { patient: PatientRef; encounter?: EncounterRef }, at: string): Record<string, string | undefined> {
  return {
    'patient.patientId': doc.patient.patientId,
    'patient.nameMasked': doc.patient.nameMasked,
    'patient.gender': doc.patient.gender,
    'patient.birthDate': doc.patient.birthDate,
    'encounter.visitId': doc.encounter?.visitId,
    'encounter.visitType': doc.encounter?.visitType,
    'encounter.deptCode': doc.encounter?.deptCode,
    'encounter.admittedAt': doc.encounter?.admittedAt,
    'encounter.dischargedAt': doc.encounter?.dischargedAt,
    now: at,
  };
}

function sameValue(current: JsonValue, computed: number | string): boolean {
  if (typeof computed === 'number') {
    if (typeof current === 'number') return Number.isFinite(current) && Math.abs(current - computed) < 1e-9;
    if (typeof current === 'string' && current.trim() !== '') return Number(current) === computed;
    return false;
  }
  return typeof current === 'string' && current === computed;
}

export interface PlanRecomputeInput {
  nodes: Record<NodeId, DocNode>;
  patient: PatientRef;
  encounter?: EncounterRef;
  /** 求值时刻（ISO8601）：由调用方给，否则同一次计划两次跑出来的结果不同  */
  at: string;
  registry: PackRegistry;
}

export function planRecompute(input: PlanRecomputeInput): RecomputePlan {
  const plan: RecomputePlan = { changes: [], pending: [], unresolved: [], skipped: [] };
  const context = contextFromDocument({ patient: input.patient, ...(input.encounter ? { encounter: input.encounter } : {}) }, input.at);

  for (const node of Object.values(input.nodes)) {
    if (node.type !== 'field' || node.dataType !== 'expression') continue;
    const evidence = evidenceOf(node);
    const controlEvidence = evidence.find((item) => item.ref.startsWith(EXPR_REF_PREFIX) && !item.ref.startsWith(EXPR_DEP_REF_PREFIX));
    if (!controlEvidence) continue;
    const parsed = parseRef(controlEvidence.ref);
    const key = evidence.find((item) => item.field && !item.ref.startsWith(EXPR_REF_PREFIX))?.field ?? node.id;
    if (!parsed) {
      plan.unresolved.push(node.id);
      continue;
    }

    /* 控件与依赖一律从包里取：文档只记了"用了哪条"，没记公式本身（记了就会与包不一致）  */
    const pack = input.registry.get(parsed.packId) as TemplatePack | undefined;
    const definition = pack?.items.find((item) => item.itemType === 'expression' && item.itemId === parsed.controlId) as
      | ExpressionDefinition
      | undefined;
    if (!definition) {
      plan.unresolved.push(node.id);
      continue;
    }

    const edges = evidence.filter((item) => item.ref.startsWith(EXPR_DEP_REF_PREFIX) && item.nodeId);
    const slots: Record<string, number | string | null> = {};
    const missing: string[] = [];
    for (const edge of edges) {
      const slotKey = edge.field;
      const dep = input.nodes[edge.nodeId as NodeId];
      if (!slotKey) continue;
      const value = dep?.type === 'field' ? dep.value : null;
      const usable = typeof value === 'number' || (typeof value === 'string' && value.trim() !== '');
      slots[slotKey] = usable ? (value as number | string) : null;
      if (!usable) missing.push((dep?.tags?.[0]?.display as string | undefined) ?? slotKey);
    }

    const computed = evaluate(definition.expression, { slots, context });
    if (computed === null) {
      plan.pending.push({ nodeId: node.id, key, controlName: definition.name, missing });
      continue;
    }
    if (node.provenance.origin !== 'system' || node.humanConfirmed === true) {
      if (!sameValue(node.value, computed)) plan.skipped.push({ nodeId: node.id, key });
      continue;
    }

    const current = node.value;
    if (sameValue(current, computed)) continue;
    plan.changes.push({ nodeId: node.id, key, controlId: definition.itemId, previous: current, next: computed });
  }

  return plan;
}
