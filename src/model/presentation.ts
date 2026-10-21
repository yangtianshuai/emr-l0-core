import type { DocumentModel, NodeId } from './types.ts';

/**
 * 断页意图：标在节点上等于"这一段另起一页"，标在章节上等于"这一章另起一页"。
 * 屏幕、预览、打印、导出四处必须用同一份判定，否则"改了分页、纸面没变"。
 */
export function breakBeforeOf(doc: DocumentModel): Set<NodeId> {
  const breaks = new Set<NodeId>();
  for (const node of Object.values(doc.nodes)) {
    if (node.presentation?.pageBreakBefore === true) breaks.add(node.id);
  }
  if (breaks.size === 0) return breaks;

  const memo = new Map<NodeId, boolean>();
  const inherited = (id: NodeId): boolean => {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    const node = doc.nodes[id];
    const parentId = node?.parentId;
    const result = parentId === null || parentId === undefined ? false : breaks.has(parentId) || inherited(parentId);
    memo.set(id, result);
    return result;
  };
  for (const node of Object.values(doc.nodes)) {
    if (inherited(node.id)) breaks.add(node.id);
  }
  return breaks;
}
