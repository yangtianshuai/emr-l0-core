import type { DocumentModel, NodeId } from './types.ts';

/**
 * 断页意图只认标在哪个节点上：标在章节上就是"这一章另起一页"。
 * 不向下继承——继承会让该章每一段都各起一页，把一章拆成一串单行纸。
 * 屏幕标记、预览、打印、导出四处共用这一份判定。
 */
export function breakBeforeOf(doc: DocumentModel): Set<NodeId> {
  const breaks = new Set<NodeId>();
  for (const node of Object.values(doc.nodes)) {
    if (node.presentation?.pageBreakBefore === true) breaks.add(node.id);
  }
  return breaks;
}
