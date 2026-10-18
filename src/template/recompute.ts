// 派生值重算（K4 的"表达式控件"在写路径上的那一半）。

import type { DocNode, JsonValue, NodeId, PatientRef, EncounterRef } from '../model/types.ts';
import type { PackRegistry } from '../knowledge/pack.ts';
import { evaluate } from './expression.ts';
import type { ExpressionDefinition, TemplatePack } from './types.ts';

/** 派生值的控件出处前缀 */
export const EXPR_REF_PREFIX = 'expr:';
/** 派生值的依赖边前缀 */
export const EXPR_DEP_REF_PREFIX = 'expr-dep:';

export interface RecomputeChange {
  nodeId: NodeId;
  /** 派生值所在槽位名（写进留痕与提示，便于回答"重算的是哪一格"） */
  key: string;
  controlId: string;
  previous: JsonValue;
  next: number | string;
}

export interface RecomputePending {
  nodeId: NodeId;
  key: string;
  controlName: string;
  /** 还缺的填写项（给人看的名字） */
  missing: string[];
}

export interface RecomputePlan {
  changes: RecomputeChange[];
  /** 依赖还不全、算不出来的派生值：如实上报，界面据此告诉医生"还缺什么"  */
  pending: RecomputePending[];
  /** 认不出控件（包里没有了 / 换了版本）的派生值：不猜、不算，只如实计数  */
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

/** 由文档派生上下文（患者 / 就诊 / 时间）—— 与实例化时的口径一致 */
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

/**
 * 规划重算。纯函数（除读注册表外无副作用，且不写任何东西）。
 *
 * 三个判断都取保守方向：
 *   - 控件找不到（包卸了 / 版本换了）→ 不算，计入 `unresolved`（宁可不改，不能改错）；
 *   - 依赖有缺 → 算不出来，计入 `pending`（不编值）；
 *   - 算出来与现值相同 → 不进 `changes`（调用方据此不产生无意义的留痕）。
  */
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

    /* 输入一律从这条边上取：`nodeId` 指节点、`field` 是槽位名。
       不去读输入节点自己的证据 —— 那份证据在医生填写之后就不存在了（见 engine.ts 的补边循环）。  */
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
      /* 依赖缺 → pending；依赖齐了却仍算不出（类型不符 / 除零）→ 也算 pending，
         但"缺什么"为空 —— 界面据此说"表达式无法求值"，而不是假装"还缺东西" */
      plan.pending.push({ nodeId: node.id, key, controlName: definition.name, missing });
      continue;
    }
    /* 医生手改过（或已确认）的派生值：不参与重算 —— 系统不覆盖人工内容这条纪律，
       在"算"的阶段就该生效，而不是等写路径抛冲突（一条冲突会让整批都失败）。  */
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
