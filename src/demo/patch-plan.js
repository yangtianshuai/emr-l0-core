(function (root) {
  'use strict';

  const IGNORE_FIELDS = new Set(['id', 'order', 'parentId', 'styleRef', 'provenance']);

  /** 稳定的比较串：`undefined` 与缺字段必须得到同一个结果 */
  function serialize(value) {
    try {
      const text = JSON.stringify(value, (_key, item) => (item === undefined ? null : item));
      return text === undefined ? 'undefined' : text;
    } catch {
      /* 循环引用在视图项里不该出现；真出现了也必须"判成不一样"（安全方向） */
      return `\u0000unserializable:${Math.random()}`;
    }
  }

  function annotationSummary(annotations, nodeId) {
    const mine = (annotations || []).filter((entry) => entry && entry.nodeId === nodeId);
    let pending = 0;
    let lost = 0;
    for (const entry of mine) {
      if (entry.status === 'open' || entry.status === 'acknowledged') pending += 1;
      if (entry.anchorState === 'lost') lost += 1;
    }
    return { total: mine.length, pending, lost };
  }

  function sameNode(previous, next, annA, annB) {
    if (!previous || !next) return previous === next;
    if (previous.id !== next.id) return false;
    const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
    for (const key of keys) {
      if (IGNORE_FIELDS.has(key)) continue;
      if (serialize(previous[key]) !== serialize(next[key])) return false;
    }
    return serialize(annA) === serialize(annB);
  }

  function viewKeyOf(snapshot) {
    const snap = snapshot || {};
    return [
      String(snap.docId === undefined ? '' : snap.docId),
      snap.mode === 'flow' ? 'flow' : 'card',
      snap.readonly === true ? 'ro' : 'rw',
      snap.clinical === true ? 'clinical' : 'demo',
      String(snap.readonlyHint === undefined ? '' : snap.readonlyHint),
    ].join('|');
  }

  function planDoc(previous, next) {
    const prev = previous || null;
    const want = next || {};

    if (!prev) return { mode: 'full', reason: 'first', replace: [], textOnly: [] };
    if (viewKeyOf(prev) !== viewKeyOf(want)) {
      return { mode: 'full', reason: 'view-options', replace: [], textOnly: [] };
    }

    const before = Array.isArray(prev.items) ? prev.items : [];
    const after = Array.isArray(want.items) ? want.items : [];

    if (before.length !== after.length) {
      return { mode: 'full', reason: 'structure', replace: [], textOnly: [] };
    }
    for (let index = 0; index < after.length; index += 1) {
      if (!before[index] || !after[index] || before[index].id !== after[index].id) {
        return { mode: 'full', reason: 'structure', replace: [], textOnly: [] };
      }
    }
    if (after.length === 0) return { mode: 'full', reason: 'empty', replace: [], textOnly: [] };

    const annBefore = Array.isArray(prev.annotations) ? prev.annotations : [];
    const annAfter = Array.isArray(want.annotations) ? want.annotations : [];

    const replace = [];
    const textOnly = [];
    for (let index = 0; index < after.length; index += 1) {
      const previousItem = before[index];
      const nextItem = after[index];
      const annA = annotationSummary(annBefore, nextItem.id);
      const annB = annotationSummary(annAfter, nextItem.id);
      if (sameNode(previousItem, nextItem, annA, annB)) continue;
      if (nextItem.kind === 'section') {
        return { mode: 'full', reason: 'section', replace: [], textOnly: [] };
      }
      replace.push(nextItem.id);
      if (isTextOnlyChange(previousItem, nextItem, annA, annB)) textOnly.push(nextItem.id);
    }

    if (replace.length === 0) return { mode: 'none', reason: 'no-change', replace: [], textOnly: [] };
    return { mode: 'patch', reason: 'nodes', replace, textOnly };
  }

  function isTextOnlyChange(previous, next, annA, annB) {
    if (!previous || !next || next.kind !== 'text') return false;
    if (serialize(annA) !== serialize(annB)) return false;
    const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
    for (const key of keys) {
      if (key === 'text' || key === 'rev' || IGNORE_FIELDS.has(key)) continue;
      if (serialize(previous[key]) !== serialize(next[key])) return false;
    }
    return true;
  }

  root.L0PatchPlan = { planDoc, sameNode, annotationSummary, viewKeyOf, isTextOnlyChange, IGNORE_FIELDS };
})(typeof window !== 'undefined' ? window : globalThis);
