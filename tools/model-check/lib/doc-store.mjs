import { clone, hashNodes, jsonDiff } from './model-utils.mjs';

const EDIT_IMPLIES_CONFIRM = new Set(['create', 'insert', 'update']);

export const ERR = {
  E_AI_DIRECT_WRITE_FORBIDDEN: 'E_AI_DIRECT_WRITE_FORBIDDEN',
  E_AI_LOW_CONFIDENCE: 'E_AI_LOW_CONFIDENCE',
  E_AI_NOT_ALLOWED: 'E_AI_NOT_ALLOWED',
  E_AI_NO_PROVENANCE: 'E_AI_NO_PROVENANCE',
  E_KEY_CONTENT_UNCONFIRMED: 'E_KEY_CONTENT_UNCONFIRMED',
  E_KEY_CONTENT_PROTECTED: 'E_KEY_CONTENT_PROTECTED',
  E_SIGNED_WITH_UNCONFIRMED_AI: 'E_SIGNED_WITH_UNCONFIRMED_AI',
  E_IMPORTED_UNCONFIRMED: 'E_IMPORTED_UNCONFIRMED',
  E_SIGNED_IMMUTABLE: 'E_SIGNED_IMMUTABLE',
  E_REV_CONFLICT: 'E_REV_CONFLICT',
  E_MACHINE_READABLE_STALE: 'E_MACHINE_READABLE_STALE',
  E_CONFIRM_SCOPE_REQUIRED: 'E_CONFIRM_SCOPE_REQUIRED',
  E_EXTERNAL_ACTOR_INVALID: 'E_EXTERNAL_ACTOR_INVALID',
  E_EXTERNAL_EVIDENCE_REQUIRED: 'E_EXTERNAL_EVIDENCE_REQUIRED',
  E_EXTERNAL_CONFLICT: 'E_EXTERNAL_CONFLICT',
  E_EXTERNAL_SCOPE_REQUIRED: 'E_EXTERNAL_SCOPE_REQUIRED',
  E_EXPORT_INVALID_PLAN: 'E_EXPORT_INVALID_PLAN',
  E_NODE_NOT_FOUND: 'E_NODE_NOT_FOUND',
  E_TYPE_MISMATCH: 'E_TYPE_MISMATCH',
  E_SUGGESTION_NOT_FOUND: 'E_SUGGESTION_NOT_FOUND',
  E_SUGGESTION_STATE: 'E_SUGGESTION_STATE',
};

export class ContractError extends Error {
  constructor(code, message, extra) {
    super(message);
    this.name = 'ContractError';
    this.code = code;
    this.extra = extra;
  }
}

function fail(code, message, extra) {
  throw new ContractError(code, message, extra);
}

const SUGGESTION_EDIT_BANDS = { light: 0.2 };

function editBandOf(ratio) {
  if (!Number.isFinite(ratio) || ratio <= 0) return 'as-is';
  return ratio <= SUGGESTION_EDIT_BANDS.light ? 'light' : 'heavy';
}

function levenshtein(a, b) {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const short = a.length <= b.length ? a : b;
  const long = a.length <= b.length ? b : a;
  let prev = Array.from({ length: short.length + 1 }, (_, index) => index);
  let curr = new Array(short.length + 1).fill(0);
  for (let i = 1; i <= long.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= short.length; j += 1) {
      const cost = long[i - 1] === short[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    const reuse = prev;
    prev = curr;
    curr = reuse;
  }
  return prev[short.length];
}

function editRatioOf(suggested, final) {
  if (suggested === final) return 0;
  const a = Array.from(suggested);
  const b = Array.from(final);
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 0;
  if (a.length === 0 || b.length === 0) return 1;
  let start = 0;
  const shortest = Math.min(a.length, b.length);
  while (start < shortest && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  return levenshtein(a.slice(start, endA), b.slice(start, endB)) / longest;
}

function buildMachineReadable(doc) {
  const dataElements = [];
  const keyContentRefs = [];
  for (const node of Object.values(doc.nodes || {})) {
    if (!node || typeof node !== 'object') continue;
    if (node.type === 'field' && Array.isArray(node.tags)) {
      for (const tag of node.tags) {
        const de = { tag: clone(tag), value: clone(node.value), nodeId: node.id, origin: node.provenance?.origin || 'system' };
        if (node.valueText !== undefined) de.valueText = node.valueText;
        if (node.unit !== undefined) de.unit = node.unit;
        if (typeof node.provenance?.confidence === 'number') de.confidence = node.provenance.confidence;
        dataElements.push(de);
      }
    }
    /* 带标签的文本节点（如主诉、结论）：否则 AI 起草的文本在机读块里看不到来源与置信度 */
    if (node.type === 'text' && Array.isArray(node.tags)) {
      const text = (node.runs || []).map((run) => run.text || '').join('');
      for (const tag of node.tags) {
        const de = { tag: clone(tag), value: text, valueText: text, nodeId: node.id, origin: node.provenance?.origin || 'system' };
        if (typeof node.provenance?.confidence === 'number') de.confidence = node.provenance.confidence;
        dataElements.push(de);
      }
    }
    if (node.keyContent === true) {
      const ref = { nodeId: node.id, present: true };
      if (Array.isArray(node.tags) && node.tags[0]) ref.tag = clone(node.tags[0]);
      keyContentRefs.push(ref);
    }
  }
  return {
    generatedAt: doc.updatedAt,
    generator: 'doc-store/0.1',
    modelSchemaVersion: doc.schemaVersion,
    sourceHash: hashNodes(doc.nodes || {}),
    dataElements,
    keyContentRefs,
  };
}

function normalizeBase(doc) {
  doc.status = 'draft';
  doc.signatureRefs = [];
  doc.updatedAt = doc.updatedAt || doc.createdAt;
  doc.revisions = [{ rev: 1, at: doc.updatedAt, actorId: doc.createdBy || 'seed', op: 'create', targetId: doc.rootId }];
  doc.machineReadable = buildMachineReadable(doc);
  return doc;
}

export function createStore(inputDoc, options = {}) {
  const noncompliant = Boolean(options.noncompliant);
  const thrGeneral = typeof options.thr === 'number' ? options.thr : 0.75;
  const thrKey = typeof options.thrKey === 'number' ? options.thrKey : 0.9;
  const patchStrategy = options.patchStrategy === 'full' ? 'full' : 'local';

  const state = normalizeBase(clone(inputDoc));
  const suggestions = new Map();
  const opIndex = new Map();
  let clock = Date.parse(state.updatedAt || state.createdAt || '2026-01-01T00:00:00Z');
  let suggestionSeq = 0;
  let nodeSeq = 0;

  const now = () => {
    clock += 1000;
    return new Date(clock).toISOString().replace(/\.\d{3}Z$/, 'Z');
  };

  const assertActor = (actor) => {
    if (!actor || typeof actor !== 'object' || !actor.id || !['human', 'ai', 'system'].includes(actor.kind)) {
      throw new Error(`actor 必须形如 { id, kind: human|ai|system }，收到：${JSON.stringify(actor)}`);
    }
  };

  const nextOrder = (parentId) =>
    Object.values(state.nodes)
      .filter((n) => n.parentId === parentId)
      .reduce((m, n) => Math.max(m, n.order || 0), 0) + 10;

  function humanProvenance(actor, prev, at) {
    const p = { origin: 'human', actorId: actor.id, at };
    if (prev && (prev.origin === 'ai' || prev.derivedFrom)) {
      p.derivedFrom = {
        modelId: prev.derivedFrom?.modelId ?? prev.modelId,
        confidence: prev.derivedFrom?.confidence ?? prev.confidence,
        suggestionId: prev.derivedFrom?.suggestionId ?? prev.suggestionId,
        editedBy: actor.id,
        editedAt: at,
      };
    }
    return p;
  }

  function isMachineStale() {
    const mr = state.machineReadable;
    if (!mr) return true;
    if (mr.modelSchemaVersion !== state.schemaVersion) return true;
    // 按内容指纹判定：签名等操作会改 updatedAt 但内容未变，不应误报陈旧
    if (mr.sourceHash && mr.sourceHash !== hashNodes(state.nodes)) return true;
    if (!mr.sourceHash && mr.generatedAt !== state.updatedAt) return true;
    for (const de of mr.dataElements || []) if (!state.nodes[de.nodeId]) return true;
    return false;
  }

  function commit({ op, actor, clientOpId, expectedRev, targetId, targets = [], mutate }) {
    assertActor(actor);

    if (!noncompliant && actor.kind === 'ai') {
      fail(ERR.E_AI_DIRECT_WRITE_FORBIDDEN, `AI 不得直接调用写接口（op=${op}）；请改用 suggest* + 人工 accept`, { op });
    }
    if (clientOpId && opIndex.has(clientOpId) && !noncompliant) {
      return { ...clone(opIndex.get(clientOpId)), replayed: true };
    }
    if (expectedRev != null && !noncompliant && expectedRev !== state.revisions.length) {
      fail(ERR.E_REV_CONFLICT, `乐观锁冲突：期望 rev=${expectedRev}，当前 rev=${state.revisions.length}`, { currentRev: state.revisions.length });
    }
    if (state.status === 'signed' || state.status === 'archived') {
      fail(ERR.E_SIGNED_IMMUTABLE, `文档已 ${state.status}，须按"解锁 → 留痕 → 重新签章"流程处理`);
    }

    const snap = new Map();
    if (patchStrategy === 'local') {
      for (const id of targets) snap.set(id, state.nodes[id] === undefined ? undefined : clone(state.nodes[id]));
    }
    const beforeAll = patchStrategy === 'full' ? clone(state.nodes) : null;

    const ret = mutate() || {};

    if (actor.kind === 'human' && EDIT_IMPLIES_CONFIRM.has(op)) {
      for (const id of targets) {
        if ((ret.created || []).includes(id)) continue;
        const node = state.nodes[id];
        if (node && node.humanConfirmed !== true && node.keyContent !== true) {
          node.humanConfirmed = true;
        }
      }
    }

    const tid = ret.targetId || targetId || null;

    let patch;
    if (patchStrategy === 'full') {
      patch = jsonDiff(beforeAll, state.nodes).map((o) => ({ ...o, path: `/nodes${o.path === '/' ? '' : o.path}` }));
    } else {
      const ids = new Set([...targets, ...(ret.created || []), ...(ret.deleted || [])]);
      patch = [];
      for (const id of ids) {
        const before = snap.has(id) ? snap.get(id) : undefined;
        const after = state.nodes[id];
        if (before === undefined && after === undefined) continue;
        if (before === undefined) patch.push({ op: 'add', path: `/nodes/${id}`, value: clone(after) });
        else if (after === undefined) patch.push({ op: 'remove', path: `/nodes/${id}` });
        else patch.push(...jsonDiff(before, after).map((o) => ({ ...o, path: `/nodes/${id}${o.path === '/' ? '' : o.path}` })));
      }
    }
    state.updatedAt = now();
    const revision = {
      rev: state.revisions.length + 1,
      at: state.updatedAt,
      actorId: actor.id,
      op,
      targetId: tid,
      patch,
      ...(ret.extra || {}),
    };
    state.revisions.push(revision);

    const result = { ok: true, targetId: tid, docRev: state.revisions.length, revision: revision.rev };
    if (clientOpId) opIndex.set(clientOpId, result);
    return result;
  }

  function confirmNodesImpl(params = {}, actor, opts = {}) {
    if (actor?.kind !== 'human' && !noncompliant) {
      fail(ERR.E_AI_NOT_ALLOWED, `仅自然人可确认内容（actor.kind=${actor?.kind}）`);
    }
    const nodeIds = [...new Set(params.nodeIds || [])];
    if (nodeIds.length === 0) {
      fail(ERR.E_CONFIRM_SCOPE_REQUIRED, '批量确认必须给出节点范围：空范围确认等于什么都没做，不能静默成功');
    }
    for (const id of nodeIds) if (!state.nodes[id]) fail(ERR.E_NODE_NOT_FOUND, `节点不存在：${id}`);
    return commit({
      op: 'update',
      actor,
      targetId: nodeIds[0],
      targets: nodeIds,
      ...opts,
      mutate: () => {
        for (const id of nodeIds) {
          const node = state.nodes[id];
          if (node.humanConfirmed !== true) {
            node.humanConfirmed = true;
            node.rev = (node.rev || 1) + 1;
          }
        }
        return { targetId: nodeIds[0], extra: { confirmedNodeIds: nodeIds } };
      },
    });
  }

  return {
    getDoc: () => clone(state),
    getNode: (id) => (state.nodes[id] ? clone(state.nodes[id]) : null),
    getAuditLog: (filter = {}) =>
      clone(state.revisions.filter((r) => (!filter.actorId || r.actorId === filter.actorId) && (!filter.op || r.op === filter.op) && (!filter.targetId || r.targetId === filter.targetId))),
    listSuggestions: (filter = {}) =>
      [...suggestions.values()]
        .filter((s) => (!filter.status || s.status === filter.status) && (!filter.targetNodeId || s.targetNodeId === filter.targetNodeId))
        .map((s) => clone(s)),
    getMetrics: () => {
      const all = [...suggestions.values()];
      const accepted = all.filter((s) => s.status === 'accepted');
      const rejected = all.filter((s) => s.status === 'rejected');
      const modified = accepted.filter((s) => s.modified === true);
      return {
        suggested: all.length,
        accepted: accepted.length,
        rejected: rejected.length,
        modified: modified.length,
        adoptionRate: all.length ? accepted.length / all.length : 0,
        editRate: accepted.length ? modified.length / accepted.length : 0,
        rejectRate: all.length ? rejected.length / all.length : 0,
      };
    },
    getSuggestionAttribution: () => {
      const accepted = [...suggestions.values()].filter((s) => s.status === 'accepted');
      let asIs = 0;
      let light = 0;
      let heavy = 0;
      let unknown = 0;
      for (const s of accepted) {
        if (s.editRatio === undefined) {
          unknown += 1;
          continue;
        }
        const band = editBandOf(s.editRatio);
        if (band === 'as-is') asIs += 1;
        else if (band === 'light') light += 1;
        else heavy += 1;
      }
      const share = (value) => (accepted.length === 0 ? 0 : value / accepted.length);
      return {
        accepted: accepted.length,
        asIs,
        light,
        heavy,
        unknown,
        asIsShare: share(asIs),
        lightShare: share(light),
        heavyShare: share(heavy),
      };
    },

    createNode(params = {}, actor, opts = {}) {
      const { parentId, type = 'text', props = {}, order } = params;
      return commit({
        op: 'create',
        actor,
        targets: [],
        ...opts,
        mutate: () => {
          if (!state.nodes[parentId]) fail(ERR.E_NODE_NOT_FOUND, `父节点不存在：${parentId}`);
          nodeSeq += 1;
          const id = `n_new_${nodeSeq}`;
          state.nodes[id] = {
            id,
            type,
            parentId,
            order: typeof order === 'number' ? order : nextOrder(parentId),
            rev: 1,
            provenance: { origin: 'human', actorId: actor.id, at: now() },
            ...clone(props),
          };
          return { targetId: id, created: [id] };
        },
      });
    },

    insertText(params = {}, actor, opts = {}) {
      const { nodeId, text } = params;
      return commit({
        op: 'insert',
        actor,
        targetId: nodeId,
        targets: [nodeId],
        ...opts,
        mutate: () => {
          const node = state.nodes[nodeId];
          if (!node) fail(ERR.E_NODE_NOT_FOUND, `节点不存在：${nodeId}`);
          if (node.type !== 'text') fail(ERR.E_TYPE_MISMATCH, `节点 ${nodeId} 不是文本节点（type=${node.type}）`);
          if (!Array.isArray(node.runs) || node.runs.length === 0) node.runs = [{ text: '' }];
          const idx = node.runs.length - 1;
          const at = now();
          node.runs[idx].text = `${node.runs[idx].text}${text}`;
          node.rev += 1;
          node.provenance = humanProvenance(actor, node.provenance, at);
          return { targetId: nodeId };
        },
      });
    },

    updateNodeProps(params = {}, actor, opts = {}) {
      const { nodeId, patch = {} } = params;
      return commit({
        op: 'update',
        actor,
        targetId: nodeId,
        targets: [nodeId],
        ...opts,
        mutate: () => {
          const node = state.nodes[nodeId];
          if (!node) fail(ERR.E_NODE_NOT_FOUND, `节点不存在：${nodeId}`);
          const at = now();
          for (const [k, v] of Object.entries(patch)) node[k] = clone(v);
          node.rev += 1;
          if (!('provenance' in patch)) node.provenance = humanProvenance(actor, node.provenance, at);
          return { targetId: nodeId };
        },
      });
    },

    setFieldValue(params = {}, actor, opts = {}) {
      const { nodeId, value, valueText, unit, sourceKey } = params;
      return commit({
        op: 'update',
        actor,
        targetId: nodeId,
        targets: [nodeId],
        ...opts,
        mutate: () => {
          const node = state.nodes[nodeId];
          if (!node) fail(ERR.E_NODE_NOT_FOUND, `节点不存在：${nodeId}`);
          if (node.type !== 'field') fail(ERR.E_TYPE_MISMATCH, `节点 ${nodeId} 不是字段节点（type=${node.type}）`);
          const at = now();
          node.value = clone(value);
          if (valueText !== undefined) node.valueText = valueText;
          else node.valueText = String(value);
          if (unit !== undefined) node.unit = unit;
          if (sourceKey !== undefined) node.sourceKey = sourceKey;
          node.rev += 1;
          node.provenance = humanProvenance(actor, node.provenance, at);
          return { targetId: nodeId };
        },
      });
    },

    deleteNode(params = {}, actor, opts = {}) {
      const { nodeId } = params;
      return commit({
        op: 'delete',
        actor,
        targetId: nodeId,
        targets: [nodeId],
        ...opts,
        mutate: () => {
          const node = state.nodes[nodeId];
          if (!node) fail(ERR.E_NODE_NOT_FOUND, `节点不存在：${nodeId}`);
          if (nodeId === state.rootId) fail(ERR.E_KEY_CONTENT_PROTECTED, '根节点不可删除');
          if (node.keyContent === true) fail(ERR.E_KEY_CONTENT_PROTECTED, `关键内容节点禁止删除：${nodeId}`);
          const hasChildren = Object.values(state.nodes).some((n) => n.parentId === nodeId);
          if (hasChildren) fail(ERR.E_KEY_CONTENT_PROTECTED, `节点有子节点，需先处理子节点：${nodeId}`);
          delete state.nodes[nodeId];
          if (state.machineReadable && Array.isArray(state.machineReadable.dataElements)) {
            state.machineReadable.dataElements = state.machineReadable.dataElements.filter((de) => de.nodeId !== nodeId);
          }
          return { targetId: nodeId, deleted: [nodeId] };
        },
      });
    },

    /** 人工确认内容（AI 不可调用） */
    confirmNode(params = {}, actor, opts = {}) {
      const { nodeId } = params;
      if (actor?.kind !== 'human' && !noncompliant) {
        fail(ERR.E_AI_NOT_ALLOWED, `仅自然人可确认内容（actor.kind=${actor?.kind}）`);
      }
      return commit({
        op: 'update',
        actor,
        targetId: nodeId,
        targets: [nodeId],
        ...opts,
        mutate: () => {
          const node = state.nodes[nodeId];
          if (!node) fail(ERR.E_NODE_NOT_FOUND, `节点不存在：${nodeId}`);
          node.humanConfirmed = true;
          node.rev += 1;
          return { targetId: nodeId };
        },
      });
    },

    confirmNodes(params = {}, actor, opts = {}) {
      return confirmNodesImpl(params, actor, opts);
    },

    confirmSubtree(params = {}, actor, opts = {}) {
      if (actor?.kind !== 'human' && !noncompliant) {
        fail(ERR.E_AI_NOT_ALLOWED, `仅自然人可确认内容（actor.kind=${actor?.kind}）`);
      }
      const root = state.nodes[params.nodeId];
      if (!root) fail(ERR.E_NODE_NOT_FOUND, `节点不存在：${params.nodeId}`);
      const isSelfOrDescendant = (id) => {
        let cursor = id;
        const seen = new Set();
        while (cursor != null && !seen.has(cursor)) {
          if (cursor === root.id) return true;
          seen.add(cursor);
          cursor = state.nodes[cursor]?.parentId ?? null;
        }
        return false;
      };
      const ids = Object.values(state.nodes)
        .filter((n) => (n.type === 'text' || n.type === 'field') && isSelfOrDescendant(n.id))
        .map((n) => n.id);
      if (ids.length === 0) {
        fail(ERR.E_CONFIRM_SCOPE_REQUIRED, `节点 ${params.nodeId} 的子树里没有可确认的内容节点（text/field）—— 不静默成功`);
      }
      return confirmNodesImpl({ nodeIds: ids }, actor, opts);
    },

    suggestText(params = {}, actor) {
      assertActor(actor);
      const { nodeId, text, confidence, modelId, promptId, evidence } = params;
      const node = state.nodes[nodeId];
      if (!node) fail(ERR.E_NODE_NOT_FOUND, `节点不存在：${nodeId}`);
      if (node.type !== 'text') fail(ERR.E_TYPE_MISMATCH, `节点 ${nodeId} 不是文本节点`);
      if (!modelId || typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
        fail(ERR.E_AI_NO_PROVENANCE, 'AI 建议必须携带 modelId 与 0~1 的 confidence（否则无法审计，且 NaN/越界值会绕过门控）');
      }
      suggestionSeq += 1;
      const id = `sg_${String(suggestionSeq).padStart(4, '0')}`;
      suggestions.set(id, {
        id,
        targetNodeId: nodeId,
        text,
        confidence,
        modelId,
        promptId,
        evidence: clone(evidence || []),
        status: 'pending',
        modified: false,
        at: now(),
      });
      return { ok: true, suggestionId: id };
    },

    acceptSuggestion(params = {}, actor, opts = {}) {
      const { suggestionId, editedText } = params;
      if (actor?.kind !== 'human' && !noncompliant) {
        fail(ERR.E_AI_NOT_ALLOWED, `仅自然人可采纳 AI 建议（actor.kind=${actor?.kind}）`);
      }
      const s = suggestions.get(suggestionId);
      if (!s) fail(ERR.E_SUGGESTION_NOT_FOUND, `建议不存在：${suggestionId}`);
      if (s.status !== 'pending') fail(ERR.E_SUGGESTION_STATE, `建议状态非 pending：${s.status}`);
      const node = state.nodes[s.targetNodeId];
      if (!node) fail(ERR.E_NODE_NOT_FOUND, `目标节点不存在：${s.targetNodeId}`);
      const threshold = node.keyContent === true ? thrKey : thrGeneral;
      if (!noncompliant && s.confidence < threshold) {
        fail(ERR.E_AI_LOW_CONFIDENCE, `置信度 ${s.confidence} 低于阈值 ${threshold}（${node.keyContent === true ? '关键内容' : '一般内容'}），不得落笔`, {
          confidence: s.confidence,
          threshold,
        });
      }
      const finalText = editedText === undefined ? s.text : editedText;
      return commit({
        op: 'accept-ai',
        actor,
        targetId: s.targetNodeId,
        targets: [s.targetNodeId],
        ...opts,
        mutate: () => {
          const at = now();
          if (!Array.isArray(node.runs) || node.runs.length === 0) node.runs = [{ text: '' }];
          const idx = node.runs.length - 1;
          node.runs[idx].text = finalText;
          node.rev += 1;
          node.provenance = {
            origin: 'ai',
            modelId: s.modelId,
            promptId: s.promptId,
            confidence: s.confidence,
            evidence: clone(s.evidence),
            acceptedBy: actor.id,
            acceptedAt: at,
            suggestionId: s.id,
            at,
          };
          node.humanConfirmed = false;
          s.status = 'accepted';
          s.editRatio = editRatioOf(s.text, finalText);
          s.modified = s.editRatio > 0;
          s.acceptedBy = actor.id;
          s.acceptedAt = at;
          return { targetId: node.id, extra: { aiSuggestionId: s.id, modelId: s.modelId, confidence: s.confidence } };
        },
      });
    },

    rejectSuggestion(params = {}, actor, opts = {}) {
      const { suggestionId, reason } = params;
      if (actor?.kind !== 'human' && !noncompliant) {
        fail(ERR.E_AI_NOT_ALLOWED, `仅自然人可拒绝 AI 建议（actor.kind=${actor?.kind}）`);
      }
      const s = suggestions.get(suggestionId);
      if (!s) fail(ERR.E_SUGGESTION_NOT_FOUND, `建议不存在：${suggestionId}`);
      if (s.status !== 'pending') fail(ERR.E_SUGGESTION_STATE, `建议状态非 pending：${s.status}`);
      return commit({
        op: 'reject-ai',
        actor,
        targetId: s.targetNodeId,
        ...opts,
        mutate: () => {
          s.status = 'rejected';
          s.rejectedBy = actor.id;
          s.rejectReason = reason;
          s.rejectedAt = now();
          return { targetId: s.targetNodeId, extra: { aiSuggestionId: s.id, modelId: s.modelId, confidence: s.confidence } };
        },
      });
    },

    sign(params = {}, actor, opts = {}) {
      if (actor?.kind !== 'human' && !noncompliant) {
        fail(ERR.E_AI_NOT_ALLOWED, `仅自然人可签名（actor.kind=${actor?.kind}）`);
      }
      return commit({
        op: 'sign',
        actor,
        targetId: state.rootId,
        ...opts,
        mutate: () => {
          const acknowledge = params.acknowledgeUnconfirmed === true;
          const keyUnconfirmed = Object.values(state.nodes).filter((n) => n.keyContent === true && n.humanConfirmed !== true);
          if (!noncompliant && keyUnconfirmed.length > 0) {
            fail(ERR.E_KEY_CONTENT_UNCONFIRMED, `存在关键内容未人工确认（${keyUnconfirmed.length} 条）：${keyUnconfirmed.map((n) => n.id).join(', ')}`, { nodes: keyUnconfirmed.map((n) => n.id) });
          }
          const aiUnconfirmed = Object.values(state.nodes).filter((n) => n.provenance?.origin === 'ai' && n.humanConfirmed !== true);
          if (!noncompliant && !acknowledge && aiUnconfirmed.length > 0) {
            fail(ERR.E_SIGNED_WITH_UNCONFIRMED_AI, `存在未经人工确认的 AI 内容（${aiUnconfirmed.length} 条）：${aiUnconfirmed.map((n) => n.id).join(', ')}；如已通读并认可，请显式传 acknowledgeUnconfirmed=true（该声明会记入留痕）`, { nodes: aiUnconfirmed.map((n) => n.id) });
          }
          const importedUnconfirmed = Object.values(state.nodes).filter(
            (n) => n.provenance?.origin === 'imported' && n.humanConfirmed !== true && (n.type === 'text' || n.type === 'field'),
          );
          if (!noncompliant && !acknowledge && importedUnconfirmed.length > 0) {
            fail(ERR.E_IMPORTED_UNCONFIRMED, `存在未经人工确认的导入内容（${importedUnconfirmed.length} 条）：${importedUnconfirmed.map((n) => n.id).join(', ')}；如已通读并认可，请显式传 acknowledgeUnconfirmed=true（该声明会记入留痕）`, { nodes: importedUnconfirmed.map((n) => n.id) });
          }
          const acknowledgedUnconfirmed =
            aiUnconfirmed.length > 0 || importedUnconfirmed.length > 0
              ? { ai: aiUnconfirmed.map((n) => n.id), imported: importedUnconfirmed.map((n) => n.id) }
              : null;
          state.status = 'signed';
          state.signatureRefs = [
            {
              signatureRef: 'sig_test',
              signerRole: 'author',
              signerId: actor.id,
              signedAt: now(),
              covers: ['Document.xml', 'Pages/Page_0/Content.xml', 'MachineReadable.xml'],
            },
          ];
          return { targetId: state.rootId, ...(acknowledgedUnconfirmed ? { extra: { acknowledgedUnconfirmed } } : {}) };
        },
      });
    },

    applyExternalData(params = {}, actor, opts = {}) {
      assertActor(actor);
      if (actor.kind !== 'system' && !noncompliant) {
        fail(ERR.E_EXTERNAL_ACTOR_INVALID, `系统取数只能由 system 身份发起（当前 kind=${actor.kind}）：AI 请走建议通道，人类请用 setFieldValue`);
      }
      const items = params.items || [];
      if (items.length === 0) {
        fail(ERR.E_EXTERNAL_SCOPE_REQUIRED, '系统取数必须给出条目：空调用等于什么都没做');
      }
      const applied = [];
      const skipped = [];
      for (const item of items) {
        const node = state.nodes[item.nodeId];
        if (!node) fail(ERR.E_NODE_NOT_FOUND, `节点不存在：${item.nodeId}`);
        if (node.type !== 'field') fail(ERR.E_TYPE_MISMATCH, `节点 ${item.nodeId} 不是字段节点：系统取数只能写入结构化字段`);
        if (!Array.isArray(item.evidence) || item.evidence.length === 0) {
          fail(ERR.E_EXTERNAL_EVIDENCE_REQUIRED, `字段 ${item.nodeId} 缺少来源引用（evidence）：无法回溯的数据不得写入病历`);
        }
        if (node.provenance?.origin === 'human' || node.humanConfirmed === true) {
          fail(
            ERR.E_EXTERNAL_CONFLICT,
            `字段 ${item.nodeId} 已有内容「${node.valueText ?? node.value}」，系统取数不覆盖人工填写/确认的内容（新值「${item.valueText ?? item.value}」）`,
          );
        }
        if (node.provenance?.origin === 'system') {
          const refs = new Set(item.evidence.map((e) => e.ref));
          const prev = node.provenance.evidence || [];
          if (prev.some((e) => refs.has(e.ref)) && String(node.value) === String(item.value)) {
            skipped.push({ nodeId: item.nodeId, reason: 'duplicate' });
            continue;
          }
        }
        applied.push(item.nodeId);
      }
      if (applied.length === 0) return { ok: true, applied: [], skipped, revision: null };
      const byId = new Map(items.map((item) => [item.nodeId, item]));
      const result = commit({
        op: 'external',
        actor,
        targetId: applied[0],
        targets: applied,
        ...opts,
        mutate: () => {
          for (const id of applied) {
            const item = byId.get(id);
            const node = state.nodes[id];
            node.value = clone(item.value);
            if (item.valueText !== undefined) node.valueText = item.valueText;
            if (item.unit !== undefined) node.unit = item.unit;
            if (item.sampledAt !== undefined) node.sampledAt = item.sampledAt;
            if (item.referenceRange !== undefined) node.referenceRange = clone(item.referenceRange);
            node.provenance = { origin: 'system', actorId: actor.id, at: now(), evidence: clone(item.evidence) };
            node.humanConfirmed = false;
            node.rev = (node.rev || 1) + 1;
          }
          return { targetId: applied[0] };
        },
      });
      return { ok: true, applied, skipped, revision: result.revision };
    },

    exportMachineReadable() {
      state.machineReadable = buildMachineReadable(state);
      return clone(state.machineReadable);
    },

    exportOFD(plan) {
      if (!plan || !plan.layout || plan.layout.textAsPath !== false) {
        fail(ERR.E_EXPORT_INVALID_PLAN, '导出计划必须声明 layout.textAsPath=false（禁止文本路径化）');
      }
      if (!plan.machineReadable || plan.machineReadable.signed !== true) {
        fail(ERR.E_EXPORT_INVALID_PLAN, '机读信息必须纳入签名覆盖范围（machineReadable.signed=true）');
      }
      if (!noncompliant && isMachineStale()) {
        fail(ERR.E_MACHINE_READABLE_STALE, '机读信息陈旧，需先调用 exportMachineReadable 重算');
      }
      return { ok: true, file: 'mock://ofd/export', carrier: plan.machineReadable.carrier, signed: true };
    },
  };
}
