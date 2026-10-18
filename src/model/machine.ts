// T04 · 机读信息（machineReadable）派生与陈旧判定。

import { hashNodes } from './hash.ts';
import { controlCellsOf } from './control.ts';
import type { DataElementTag, DocNode, DocumentModel, MachineDataElement, MachineReadableBlock, NodeId, ProvenanceOrigin } from './types.ts';

/** 机读块的生成器标识（各实现不同，跨实现比对时应排除该字段） */
export const MACHINE_GENERATOR = 'l0-session/1.0.0';

export interface DeriveOptions {
  nodes: Record<NodeId, DocNode>;
  rootId: NodeId;
}

export interface BuildMachineOptions extends DeriveOptions {
  schemaVersion: string;
  generatedAt: string;
  generator?: string;
}

/** 按文档顺序（父 → 子，order 升序，同序按 id）遍历节点；无法到达的节点按 id 追加，避免丢数据 */
export function orderedNodeIds({ nodes, rootId }: DeriveOptions): NodeId[] {
  const children = new Map<NodeId | null, DocNode[]>();
  for (const node of Object.values(nodes)) {
    if (!node || typeof node !== 'object') continue;
    const key = node.parentId ?? null;
    const bucket = children.get(key);
    if (bucket) bucket.push(node);
    else children.set(key, [node]);
  }
  for (const bucket of children.values()) {
    bucket.sort((a, b) => (a.order === b.order ? a.id.localeCompare(b.id) : a.order - b.order));
  }

  const visited = new Set<NodeId>();
  const out: NodeId[] = [];
  const walk = (id: NodeId): void => {
    if (visited.has(id)) return; // 防御：非法数据里的环
    visited.add(id);
    out.push(id);
    for (const child of children.get(id) ?? []) walk(child.id);
  };
  if (nodes[rootId]) walk(rootId);
  const leftovers = Object.keys(nodes)
    .filter((id) => !visited.has(id))
    .sort((a, b) => a.localeCompare(b));
  for (const id of leftovers) walk(id);
  return out;
}

function originOf(node: DocNode): ProvenanceOrigin {
  const origin = node.provenance?.origin;
  return origin ?? 'system';
}

/** 派生数据元清单（不含 generatedAt/sourceHash 等元信息，便于跨实现比较） */
export function deriveDataElements({ nodes, rootId }: DeriveOptions): {
  dataElements: MachineDataElement[];
  keyContentRefs: Array<{ nodeId: NodeId; tag?: DataElementTag; present: boolean }>;
} {
  const dataElements: MachineDataElement[] = [];
  const keyContentRefs: Array<{ nodeId: NodeId; tag?: DataElementTag; present: boolean }> = [];

  for (const id of orderedNodeIds({ nodes, rootId })) {
    const node = nodes[id];
    if (!node || typeof node !== 'object') continue;

    if (node.type === 'field' && Array.isArray(node.tags)) {
      for (const tag of node.tags) {
        const element: MachineDataElement = {
          tag: { ...tag },
          value: node.value,
          nodeId: node.id,
          origin: originOf(node),
        };
        if (node.valueText !== undefined) element.valueText = node.valueText;
        if (node.unit !== undefined) element.unit = node.unit;
        const confidence = node.provenance?.confidence;
        if (typeof confidence === 'number') element.confidence = confidence;
        dataElements.push(element);
      }
    }

    if (node.type === 'text' && Array.isArray(node.tags)) {
      const text = node.runs.map((run) => run.text).join('');
      for (const tag of node.tags) {
        const element: MachineDataElement = {
          tag: { ...tag },
          value: text,
          valueText: text,
          nodeId: node.id,
          origin: originOf(node),
        };
        const confidence = node.provenance?.confidence;
        if (typeof confidence === 'number') element.confidence = confidence;
        dataElements.push(element);
      }
    }

    if (node.type === 'control') {
      const cellByKey = new Map(controlCellsOf(node).map((cell) => [cell.key, cell]));
      for (const [cellKey, cellValue] of Object.entries(node.payload ?? {})) {
        const cell = cellByKey.get(cellKey);
        if (!cell?.tag) continue;
        if (cellValue === null || cellValue === undefined || cellValue === '') continue;
        const element: MachineDataElement = {
          tag: { ...cell.tag },
          value: cellValue,
          valueText: String(cellValue),
          nodeId: node.id,
          origin: originOf(node),
        };
        if (cell.unit !== undefined) element.unit = cell.unit;
        const confidence = node.provenance?.confidence;
        if (typeof confidence === 'number') element.confidence = confidence;
        dataElements.push(element);
      }
    }

    if (node.keyContent === true) {
      const ref: { nodeId: NodeId; tag?: DataElementTag; present: boolean } = { nodeId: node.id, present: hasValue(node) };
      if (Array.isArray(node.tags) && node.tags[0]) ref.tag = { ...node.tags[0] };
      keyContentRefs.push(ref);
    }
  }

  return { dataElements, keyContentRefs };
}

function hasValue(node: DocNode): boolean {
  if (node.type === 'field') {
    if (node.value === null || node.value === undefined || node.value === '') return false;
    return true;
  }
  if (node.type === 'text') return node.runs.some((run) => run.text.trim().length > 0);
  if (node.type === 'control') return Object.keys(node.payload ?? {}).length > 0;
  if (node.type === 'image') return Boolean(node.resRef);
  return true;
}

/** 依据节点树重建整个机读块（含 sourceHash 与 schemaVersion 锚点） */
export function buildMachineReadable(options: BuildMachineOptions): MachineReadableBlock {
  const { dataElements, keyContentRefs } = deriveDataElements(options);
  return {
    generatedAt: options.generatedAt,
    generator: options.generator ?? MACHINE_GENERATOR,
    sourceHash: hashNodes(options.nodes),
    modelSchemaVersion: options.schemaVersion,
    dataElements,
    keyContentRefs,
  };
}

export interface StalenessReport {
  stale: boolean;
  reasons: string[];
}

/**
 * 陈旧判定。任何一条成立即为陈旧：
 *   - 机读块缺失；
 *   - `modelSchemaVersion` 与文档 `schemaVersion` 不一致（迁移后必须重算）；
 *   - 有 `sourceHash` 且与当前节点指纹不一致（按内容判定，因此签章等只改文档级字段的操作不会误报）；
 *   - 无 `sourceHash` 时退化为时间戳判定（`generatedAt` 早于 `updatedAt`）；
 *   - 引用了不存在的节点。
  */
export function machineReadableStaleness(doc: Pick<DocumentModel, 'machineReadable' | 'nodes' | 'schemaVersion' | 'updatedAt'>): StalenessReport {
  const reasons: string[] = [];
  const block = doc.machineReadable;
  if (!block) return { stale: true, reasons: ['机读信息缺失，需先派生'] };

  if (block.modelSchemaVersion !== doc.schemaVersion) {
    reasons.push(`modelSchemaVersion=${block.modelSchemaVersion} 与 schemaVersion=${doc.schemaVersion} 不一致`);
  }
  if (block.sourceHash) {
    const actual = hashNodes(doc.nodes);
    if (block.sourceHash !== actual) reasons.push(`sourceHash=${block.sourceHash} 与当前节点指纹=${actual} 不一致`);
  } else if (block.generatedAt && doc.updatedAt && Date.parse(block.generatedAt) < Date.parse(doc.updatedAt)) {
    reasons.push(`generatedAt=${block.generatedAt} 早于 updatedAt=${doc.updatedAt}`);
  }
  for (const element of block.dataElements ?? []) {
    if (element.nodeId && !doc.nodes[element.nodeId]) reasons.push(`数据元引用了不存在的节点：${element.nodeId}`);
  }
  for (const ref of block.keyContentRefs ?? []) {
    if (ref.nodeId && !doc.nodes[ref.nodeId]) reasons.push(`keyContentRefs 引用了不存在的节点：${ref.nodeId}`);
  }
  return { stale: reasons.length > 0, reasons };
}

/** 反向抽取视图：把机读块转成"标签 → 值"列表（用于验收 round-trip 完整率） */
export function machineToExpectation(block: MachineReadableBlock): Array<{ code: string; system: string; valueText: string; nodeId: NodeId }> {
  return block.dataElements.map((element) => ({
    code: element.tag.code,
    system: element.tag.system,
    valueText: element.valueText ?? (element.value === null || element.value === undefined ? '' : String(element.value)),
    nodeId: element.nodeId,
  }));
}
