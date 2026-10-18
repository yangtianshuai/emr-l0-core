// T02 · 节点索引层。

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

  /** 子节点列表待排序的父节点（延迟排序：写入 O(1)，读取时才排序） */
  private readonly dirtyParents = new Set<NodeId>();

  private readonly parents = new Map<NodeId, NodeId | null>();

  private readonly orders = new Map<NodeId, number>();

  private readonly nodeById = new Map<NodeId, DocNode>();

  /* 倒排索引用 Set 存储：写入 O(1)，读取时排序。
     早期版本用数组并在每次插入时 includes + sort，导致批量建索引退化为 O(n²)
     —— 3601 节点实测 99ms，改为 Set 后大幅下降。 */
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

  /** 根节点变更（如切换文书模板）时调用，不改变其它索引 */
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

  /** 单节点深度：沿父链上溯（带环保护） */
  depthOf(id: NodeId): number {
    let depth = 0;
    let cursor = this.parents.get(id);
    while (cursor !== undefined && cursor !== null) {
      depth += 1;
      if (depth > 10_000) break; // 环保护
      cursor = this.parents.get(cursor);
    }
    return depth;
  }

  /** 子树 id（含自身），可选深度限制（0 = 仅自身） */
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

  /** 从自身到根的路径（含两端） */
  pathToRoot(id: NodeId): NodeId[] {
    const path: NodeId[] = [];
    let cursor: NodeId | null | undefined = id;
    const guard = new Set<NodeId>();
    while (cursor !== undefined && cursor !== null) {
      if (guard.has(cursor)) break; // 环保护
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
      // 根节点无兄弟
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

  /** 把 nodeId 移到 newParentId 下是否会成环 */
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

  /** 仅移除该节点；其子节点保留（成为孤儿，可由 unreachable() 发现） */
  onNodeRemoved(id: NodeId): void {
    const node = this.nodeById.get(id) ?? null;
    this.detach(id);
    this.nodeById.delete(id);
    this.orders.delete(id);
    this.parents.delete(id);
    this.removeMemberships(node, id);
  }

  /** 显式级联删除（含全部后代）；返回被删除的 id 列表 */
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

  /** 结构指纹：覆盖父子关系、同级顺序、标签/来源/类型归属与关键内容标记 */
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

  /** 与"从节点表全量重建"的结果对比（增量维护的正确性判据） */
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
    this.dirtyParents.add(parentId); // 延迟到读取时排序
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

  /** 桶写入 O(1)：直接加入 Set，排序推迟到读取（sortedBucket） */
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

/** 读取桶时排序，保证查询结果与插入顺序无关（指纹与等价性断言依赖这一点） */
function sortedBucket<K>(bucket: Map<K, Set<NodeId>>, key: K): readonly NodeId[] {
  const set = bucket.get(key);
  if (!set || set.size === 0) return EMPTY_IDS;
  return [...set].sort();
}

export { tagKey };
