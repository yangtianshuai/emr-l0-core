import { hashValue } from './hash.ts';
import type { DocNode, JsonValue, NodeId, NodeType, ProvenanceOrigin, TagSystem } from './types.ts';

const EMPTY_IDS: readonly NodeId[] = Object.freeze([]);

export interface NodeFilter {
  type?: NodeType;
  tag?: { system: TagSystem; code: string };
  origin?: ProvenanceOrigin;
  keyContent?: boolean;
}

export interface VerifyReport {
  ok: boolean;
  diffs: string[];
}

function tagKey(system: TagSystem | string, code: string): string {
  return `${system}:${code}`;
}

export class DocumentIndex {
  private readonly children = new Map<NodeId, NodeId[]>();

  private readonly dirtyParents = new Set<NodeId>();

  private readonly parents = new Map<NodeId, NodeId | null>();

  private readonly orders = new Map<NodeId, number>();

  private readonly nodeById = new Map<NodeId, DocNode>();

  private readonly tags = new Map<string, Set<NodeId>>();

  private readonly origins = new Map<ProvenanceOrigin, Set<NodeId>>();

  private readonly types = new Map<NodeType, Set<NodeId>>();

  private readonly keyContentIds = new Set<NodeId>();

  private root: NodeId;

  private constructor(rootId: NodeId) {
    this.root = rootId;
  }

  static build(nodes: Record<NodeId, DocNode>, rootId: NodeId): DocumentIndex {
    const index = new DocumentIndex(rootId);
    for (const node of Object.values(nodes)) index.onNodeAdded(node);
    return index;
  }

  get size(): number {
    return this.nodeById.size;
  }

  get rootId(): NodeId {
    return this.root;
  }

  setRoot(rootId: NodeId): void {
    this.root = rootId;
  }

  nodeOf(id: NodeId): DocNode | null {
    return this.nodeById.get(id) ?? null;
  }

  has(id: NodeId): boolean {
    return this.nodeById.has(id);
  }

  parentOf(id: NodeId): NodeId | null {
    return this.parents.get(id) ?? null;
  }

  childrenOf(id: NodeId): readonly NodeId[] {
    const list = this.children.get(id);
    if (!list) return EMPTY_IDS;
    if (this.dirtyParents.has(id)) {
      this.sortSiblings(list);
      this.dirtyParents.delete(id);
    }
    return list;
  }

  depthOf(id: NodeId): number {
    let depth = 0;
    let cursor = this.parents.get(id);
    while (cursor !== undefined && cursor !== null) {
      depth += 1;
      if (depth > 10_000) break;
      cursor = this.parents.get(cursor);
    }
    return depth;
  }

  subtreeIds(id: NodeId, maxDepth = Number.POSITIVE_INFINITY): NodeId[] {
    if (!this.nodeById.has(id)) return [];
    const out: NodeId[] = [];
    let frontier: NodeId[] = [id];
    let level = 0;
    while (frontier.length > 0 && level <= maxDepth) {
      out.push(...frontier);
      if (level === maxDepth) break;
      const next: NodeId[] = [];
      for (const current of frontier) next.push(...this.childrenOf(current));
      frontier = next;
      level += 1;
    }
    return out;
  }

  descendantCount(id: NodeId): number {
    return Math.max(0, this.subtreeIds(id).length - 1);
  }

  pathToRoot(id: NodeId): NodeId[] {
    const path: NodeId[] = [];
    let cursor: NodeId | null | undefined = id;
    const guard = new Set<NodeId>();
    while (cursor !== undefined && cursor !== null) {
      if (guard.has(cursor)) break;
      guard.add(cursor);
      path.push(cursor);
      cursor = this.parents.get(cursor);
    }
    return path;
  }

  ancestorsOf(id: NodeId): NodeId[] {
    return this.pathToRoot(id).slice(1);
  }

  siblingsOf(id: NodeId): NodeId[] {
    const parent = this.parentOf(id);
    if (parent === null) {
      return this.nodeById.has(id) && this.parents.get(id) === null ? [] : [];
    }
    return this.childrenOf(parent).filter((child) => child !== id);
  }

  /** 从 rootId 不可达的节点（孤儿或被循环引用隔离） */
  unreachable(): NodeId[] {
    const visited = new Set<NodeId>();
    const stack: NodeId[] = this.nodeById.has(this.root) ? [this.root] : [];
    while (stack.length > 0) {
      const current = stack.pop() as NodeId;
      if (visited.has(current)) continue;
      visited.add(current);
      for (const child of this.childrenOf(current)) stack.push(child);
    }
    const out: NodeId[] = [];
    for (const id of this.nodeById.keys()) if (!visited.has(id)) out.push(id);
    return out.sort();
  }

  nodesWithTag(system: TagSystem | string, code: string): readonly NodeId[] {
    return sortedBucket(this.tags, tagKey(system, code));
  }

  nodesWithOrigin(origin: ProvenanceOrigin): readonly NodeId[] {
    return sortedBucket(this.origins, origin);
  }

  nodesOfType(type: NodeType): readonly NodeId[] {
    return sortedBucket(this.types, type);
  }

  keyContentNodes(): readonly NodeId[] {
    return [...this.keyContentIds].sort();
  }

  query(filter: NodeFilter): NodeId[] {
    let candidates: readonly NodeId[] = [...this.nodeById.keys()].sort();
    if (filter.type) candidates = candidates.filter((id) => this.nodeById.get(id)?.type === filter.type);
    if (filter.origin) candidates = candidates.filter((id) => this.nodeById.get(id)?.provenance?.origin === filter.origin);
    if (filter.keyContent === true) candidates = candidates.filter((id) => this.keyContentIds.has(id));
    if (filter.tag) {
      const allowed = new Set(this.nodesWithTag(filter.tag.system, filter.tag.code));
      candidates = candidates.filter((id) => allowed.has(id));
    }
    return [...candidates];
  }

  wouldCreateCycle(nodeId: NodeId, newParentId: NodeId): boolean {
    if (nodeId === newParentId) return true;
    let cursor: NodeId | null | undefined = newParentId;
    const guard = new Set<NodeId>();
    while (cursor !== undefined && cursor !== null) {
      if (cursor === nodeId) return true;
      if (guard.has(cursor)) break;
      guard.add(cursor);
      cursor = this.parents.get(cursor);
    }
    return false;
  }

  onNodeAdded(node: DocNode): void {
    if (this.nodeById.has(node.id)) this.detach(node.id);
    this.nodeById.set(node.id, node);
    this.orders.set(node.id, node.order);
    this.parents.set(node.id, node.parentId);
    if (!this.children.has(node.id)) this.children.set(node.id, []);
    if (node.parentId !== null) this.attachToParent(node.id, node.parentId);
    this.addMemberships(node);
  }

  onNodeRemoved(id: NodeId): void {
    const node = this.nodeById.get(id) ?? null;
    this.detach(id);
    this.nodeById.delete(id);
    this.orders.delete(id);
    this.parents.delete(id);
    this.removeMemberships(node, id);
  }

  removeSubtree(id: NodeId): NodeId[] {
    const victims = this.subtreeIds(id);
    for (const victim of [...victims].reverse()) this.onNodeRemoved(victim);
    return victims;
  }

  onNodeChanged(before: DocNode, after: DocNode): void {
    this.orders.set(after.id, after.order);
    this.nodeById.set(after.id, after);

    if (before.parentId !== after.parentId) {
      this.detach(after.id);
      this.parents.set(after.id, after.parentId);
      if (after.parentId !== null) this.attachToParent(after.id, after.parentId);
    } else if (before.order !== after.order) {
      this.resortSiblings(after.parentId);
    }

    this.removeMemberships(before, after.id);
    this.addMemberships(after);
  }

  fingerprint(): string {
    const projection: Record<string, JsonValue> = {};
    for (const id of [...this.nodeById.keys()].sort()) {
      const node = this.nodeById.get(id) as DocNode;
      projection[id] = {
        parent: this.parents.get(id) ?? null,
        order: this.orders.get(id) ?? null,
        children: [...this.childrenOf(id)],
        type: node.type,
        origin: node.provenance?.origin ?? null,
        tags: (node.tags ?? []).map((tag) => `${tag.system}:${tag.code}`).sort(),
        keyContent: this.keyContentIds.has(id),
      };
    }
    projection.__root = this.root;
    return hashValue(projection);
  }

  verifyAgainst(nodes: Record<NodeId, DocNode>, rootId: NodeId): VerifyReport {
    const rebuilt = DocumentIndex.build(nodes, rootId);
    const diffs: string[] = [];

    if (this.size !== rebuilt.size) diffs.push(`节点数不一致：增量 ${this.size} vs 重建 ${rebuilt.size}`);

    const allIds = new Set<NodeId>([...this.nodeById.keys(), ...rebuilt.nodeById.keys()]);
    for (const id of [...allIds].sort()) {
      const a = this.childrenOf(id).join(',');
      const b = rebuilt.childrenOf(id).join(',');
      if (a !== b) diffs.push(`子节点顺序不一致 @${id}：增量 [${a}] vs 重建 [${b}]`);
      const pa = this.parentOf(id);
      const pb = rebuilt.parentOf(id);
      if (pa !== pb) diffs.push(`父节点不一致 @${id}：增量 ${pa} vs 重建 ${pb}`);
    }

    for (const [system, codes] of [
      ['WS445', ['DE05.01.000', 'DE05.01.001']],
      ['local', ['LT0', 'LT1']],
    ] as const) {
      for (const code of codes) {
        const a = this.nodesWithTag(system, code).join(',');
        const b = rebuilt.nodesWithTag(system, code).join(',');
        if (a !== b) diffs.push(`tag ${system}:${code} 归属不一致：增量 [${a}] vs 重建 [${b}]`);
      }
    }

    if (this.unreachable().join(',') !== rebuilt.unreachable().join(',')) {
      diffs.push(`不可达节点不一致：增量 [${this.unreachable().join(',')}] vs 重建 [${rebuilt.unreachable().join(',')}]`);
    }
    if (this.keyContentNodes().join(',') !== rebuilt.keyContentNodes().join(',')) {
      diffs.push('关键内容集合不一致');
    }
    if (this.fingerprint() !== rebuilt.fingerprint()) diffs.push('结构指纹不一致');

    return { ok: diffs.length === 0, diffs };
  }

  private attachToParent(childId: NodeId, parentId: NodeId): void {
    const list = this.children.get(parentId) ?? [];
    list.push(childId);
    this.children.set(parentId, list);
    this.dirtyParents.add(parentId);
  }

  private sortSiblings(list: NodeId[]): void {
    list.sort((a, b) => {
      const oa = this.orders.get(a) ?? 0;
      const ob = this.orders.get(b) ?? 0;
      if (oa !== ob) return oa - ob;
      return a < b ? -1 : a > b ? 1 : 0;
    });
  }

  private resortSiblings(parentId: NodeId | null): void {
    if (parentId === null) return;
    if (this.children.has(parentId)) this.dirtyParents.add(parentId);
  }

  private detach(childId: NodeId): void {
    const parentId = this.parents.get(childId);
    if (parentId !== undefined && parentId !== null) {
      const list = this.children.get(parentId);
      if (list) {
        const at = list.indexOf(childId);
        if (at >= 0) list.splice(at, 1);
      }
    }
    this.parents.set(childId, null);
  }

  private addMemberships(node: DocNode): void {
    for (const tag of node.tags ?? []) this.addToBucket(this.tags, tagKey(tag.system, tag.code), node.id);
    const origin = node.provenance?.origin;
    if (origin) this.addToBucket(this.origins, origin, node.id);
    this.addToBucket(this.types, node.type, node.id);
    if (node.keyContent === true) this.keyContentIds.add(node.id);
  }

  private removeMemberships(node: DocNode | null, id: NodeId): void {
    if (!node) return;
    for (const tag of node.tags ?? []) this.removeFromBucket(this.tags, tagKey(tag.system, tag.code), id);
    const origin = node.provenance?.origin;
    if (origin) this.removeFromBucket(this.origins, origin, id);
    this.removeFromBucket(this.types, node.type, id);
    if (node.keyContent === true) this.keyContentIds.delete(id);
  }

  private addToBucket<K>(bucket: Map<K, Set<NodeId>>, key: K, id: NodeId): void {
    const set = bucket.get(key) ?? new Set<NodeId>();
    set.add(id);
    bucket.set(key, set);
  }

  private removeFromBucket<K>(bucket: Map<K, Set<NodeId>>, key: K, id: NodeId): void {
    const set = bucket.get(key);
    if (!set) return;
    set.delete(id);
    if (set.size === 0) bucket.delete(key);
  }
}

function sortedBucket<K>(bucket: Map<K, Set<NodeId>>, key: K): readonly NodeId[] {
  const set = bucket.get(key);
  if (!set || set.size === 0) return EMPTY_IDS;
  return [...set].sort();
}

export { tagKey };
