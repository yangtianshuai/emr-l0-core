import { DocumentIndex } from './indexes.ts';
import { validateDocument, errorsOf } from './validate.ts';
import { buildLargeSyntheticDoc, buildSyntheticDoc } from '../testing/synthetic.ts';
import { TestSuite, assert, assertEqual, makeRng, pick } from '../testing/harness.ts';
import type { DocNode, NodeId } from './types.ts';

const suite = new TestSuite('T02 节点索引层自测', ['说明：结构指纹（fingerprint）覆盖父子关系、同级顺序、标签归属与关键内容标记。']);

const test = (name: string, fn: () => void | Promise<void>): Promise<void> => suite.test(name, fn);

function naiveChildren(nodes: Record<NodeId, DocNode>, id: NodeId): NodeId[] {
  return Object.values(nodes)
    .filter((node) => node.parentId === id)
    .sort((a, b) => (a.order !== b.order ? a.order - b.order : a.id < b.id ? -1 : 1))
    .map((node) => node.id);
}

function naivePath(nodes: Record<NodeId, DocNode>, id: NodeId): NodeId[] {
  const out: NodeId[] = [];
  const guard = new Set<NodeId>();
  let cursor: NodeId | null = id;
  while (cursor !== null && !guard.has(cursor)) {
    guard.add(cursor);
    out.push(cursor);
    cursor = nodes[cursor]?.parentId ?? null;
  }
  return out;
}

function naiveSubtree(nodes: Record<NodeId, DocNode>, id: NodeId): NodeId[] {
  if (!nodes[id]) return [];
  const out: NodeId[] = [];
  const stack: NodeId[] = [id];
  while (stack.length > 0) {
    const current = stack.pop() as NodeId;
    if (out.includes(current)) continue;
    out.push(current);
    for (const child of naiveChildren(nodes, current)) stack.push(child);
  }
  return out.sort();
}

function naiveTag(nodes: Record<NodeId, DocNode>, system: string, code: string): NodeId[] {
  return Object.values(nodes)
    .filter((node) => (node.tags ?? []).some((tag) => tag.system === system && tag.code === code))
    .map((node) => node.id)
    .sort();
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

async function main(): Promise<void> {
  const synthetic = buildSyntheticDoc({ sections: 4, paragraphsPerSection: 3, fieldsPerParagraph: 1, withTables: true });
  const { doc } = synthetic;
  const nodes = doc.nodes;

  await test('前置：合成夹具必须是合法文档（否则测的是幻觉）', () => {
    assertEqual(errorsOf(validateDocument(clone(doc))), [], 'synthetic 夹具应通过校验');
  });

  await test('构建：父子关系与同级顺序与朴素实现一致', () => {
    const index = DocumentIndex.build(nodes, doc.rootId);
    assertEqual(index.size, Object.keys(nodes).length, '索引节点数应与文档一致');
    for (const id of Object.keys(nodes)) {
      assertEqual([...index.childrenOf(id)], naiveChildren(nodes, id), `子节点不一致 @${id}`);
      assertEqual(index.parentOf(id), nodes[id]?.parentId ?? null, `父节点不一致 @${id}`);
    }
    assertEqual([...index.childrenOf(doc.rootId)], naiveChildren(nodes, doc.rootId), '根节点子列表应有序');
  });

  await test('查询：pathToRoot / subtree / depth 与朴素实现一致', () => {
    const index = DocumentIndex.build(nodes, doc.rootId);
    for (const id of Object.keys(nodes)) {
      assertEqual(index.pathToRoot(id), naivePath(nodes, id), `路径不一致 @${id}`);
      assertEqual(index.subtreeIds(id).sort(), naiveSubtree(nodes, id), `子树不一致 @${id}`);
      assertEqual(index.depthOf(id), naivePath(nodes, id).length - 1, `深度不一致 @${id}`);
    }
    assertEqual(index.subtreeIds(doc.rootId).length, Object.keys(nodes).length, '根子树应覆盖全部节点');
    assertEqual(index.unreachable(), [], '合法文档不应有不可达节点');
  });

  await test('倒排索引：tag / origin / type / keyContent 与朴素扫描一致', () => {
    const index = DocumentIndex.build(nodes, doc.rootId);
    assertEqual([...index.nodesWithTag('WS445', 'DE05.01.000')], naiveTag(nodes, 'WS445', 'DE05.01.000'), 'tag 归属不一致');
    assertEqual([...index.nodesWithOrigin('system')].sort(), Object.values(nodes).filter((n) => n.provenance.origin === 'system').map((n) => n.id).sort(), 'origin 归属不一致');
    assertEqual([...index.nodesOfType('text')].sort(), Object.values(nodes).filter((n) => n.type === 'text').map((n) => n.id).sort(), 'type 归属不一致');
    assertEqual(index.keyContentNodes(), [], '夹具未标记关键内容');
    assertEqual(index.query({ type: 'field', tag: { system: 'WS445', code: 'DE05.01.000' } }).sort(), naiveTag(nodes, 'WS445', 'DE05.01.000'), '组合过滤应等于 tag 查询（夹具中该 tag 只在 field 上）');
  });

  await test('稳定性：同级 order 相同时按 id 升序（结果不依赖插入顺序）', () => {
    const a: DocNode = { id: 'n_a', type: 'text', parentId: 'n_root', order: 100, rev: 1, runs: [{ text: 'a' }], provenance: { origin: 'human', actorId: 'x', at: '2026-10-08T01:00:00Z' } };
    const b: DocNode = { id: 'n_b', type: 'text', parentId: 'n_root', order: 100, rev: 1, runs: [{ text: 'b' }], provenance: { origin: 'human', actorId: 'x', at: '2026-10-08T01:00:00Z' } };
    const root: DocNode = { id: 'n_root', type: 'document', parentId: null, order: 0, rev: 1, provenance: { origin: 'system', actorId: 'x', at: '2026-10-08T01:00:00Z' } };
    const forward = DocumentIndex.build({ n_root: root, n_a: a, n_b: b }, 'n_root');
    const backward = DocumentIndex.build({ n_root: root, n_b: b, n_a: a }, 'n_root');
    assertEqual([...forward.childrenOf('n_root')], ['n_a', 'n_b'], 'order 相同应按 id 升序');
    assertEqual(forward.fingerprint(), backward.fingerprint(), '插入顺序不同不应影响结构指纹');
  });

  await test('增量等价（核心）：300 步随机操作后与全量重建一致', () => {
    const truth = clone(nodes);
    const index = DocumentIndex.build(truth, doc.rootId);
    const rng = makeRng(20261008);
    let ops = 0;
    let seq = 0;

    for (let step = 0; step < 300; step += 1) {
      const paragraphs = Object.values(truth).filter((n) => n.type === 'paragraph');
      const sections = Object.values(truth).filter((n) => n.type === 'section');
      const leaves = Object.values(truth).filter((n) => n.type === 'text' && !Object.values(truth).some((m) => m.parentId === n.id));
      const roll = rng();

      if (roll < 0.3 && paragraphs.length > 0) {
        const parent = pick(rng, paragraphs) as DocNode;
        seq += 1;
        const node: DocNode = {
          id: `n_ins_${seq}`,
          type: 'text',
          parentId: parent.id,
          order: 1000 + seq,
          rev: 1,
          runs: [{ text: `插入 ${seq}` }],
          provenance: { origin: 'human', actorId: 'DR_TEST', at: '2026-10-08T02:00:00Z' },
        };
        truth[node.id] = node;
        index.onNodeAdded(node);
        ops += 1;
      } else if (roll < 0.5 && leaves.length > 1) {
        const victim = pick(rng, leaves) as DocNode;
        delete truth[victim.id];
        index.onNodeRemoved(victim.id);
        ops += 1;
      } else if (roll < 0.75 && sections.length > 1) {
        const node = pick(rng, Object.values(truth).filter((n) => n.parentId !== null && n.type !== 'section')) as DocNode | null;
        const target = pick(rng, sections.filter((s) => s.id !== node?.parentId)) as DocNode | null;
        if (node && target && !index.wouldCreateCycle(node.id, target.id)) {
          const before = clone(node);
          const after = clone(node);
          after.parentId = target.id;
          after.order = 5000 + step;
          truth[after.id] = after;
          index.onNodeChanged(before, after);
          ops += 1;
        }
      } else {
        const node = pick(rng, Object.values(truth).filter((n) => n.type === 'field')) as DocNode | null;
        if (node) {
          const before = clone(node);
          const after = clone(node);
          after.order = 3000 + step;
          if (after.type === 'field') after.tags = [{ system: 'custom', code: `C${step}`, display: '测试标签' }];
          after.keyContent = step % 2 === 0;
          truth[after.id] = after;
          index.onNodeChanged(before, after);
          ops += 1;
        }
      }

      if (step % 10 === 0) {
        const report = index.verifyAgainst(truth, doc.rootId);
        assert(report.ok, `第 ${step} 步后索引与重建不一致：${report.diffs.slice(0, 3).join(' | ')}`);
        const probe = pick(rng, Object.keys(truth));
        if (probe) {
          assertEqual([...index.childrenOf(probe)], naiveChildren(truth, probe), `第 ${step} 步后子节点不一致 @${probe}`);
          assertEqual(index.pathToRoot(probe), naivePath(truth, probe), `第 ${step} 步后路径不一致 @${probe}`);
        }
      }
    }

    assert(ops > 200, `有效操作数偏少（${ops}），等价性验证不充分`);
    const finalReport = index.verifyAgainst(truth, doc.rootId);
    assert(finalReport.ok, `最终不一致：${finalReport.diffs.slice(0, 5).join(' | ')}`);
  });

  await test('删除语义：默认不级联（子节点成孤儿），removeSubtree 才级联', () => {
    const truth = clone(nodes);
    const index = DocumentIndex.build(truth, doc.rootId);
    const paragraph = Object.values(truth).find((n) => n.type === 'paragraph') as DocNode;
    const childCount = index.childrenOf(paragraph.id).length;
    assert(childCount > 0, '用例前提：该段落应有子节点');

    delete truth[paragraph.id];
    index.onNodeRemoved(paragraph.id);
    assert(index.unreachable().length > 0, '删除父节点后其子节点应变为不可达（默认不级联）');
    assert(index.verifyAgainst(truth, doc.rootId).ok, '不级联删除后索引仍应与重建一致');

    const truth2 = clone(nodes);
    const index2 = DocumentIndex.build(truth2, doc.rootId);
    const removed = index2.removeSubtree(paragraph.id);
    for (const id of removed) delete truth2[id];
    assertEqual(index2.unreachable(), [], '级联删除后不应残留不可达节点');
    assertEqual(removed.length, childCount + 1, '级联删除应包含自身与全部后代');
    assert(index2.verifyAgainst(truth2, doc.rootId).ok, '级联删除后索引应与重建一致');
  });

  await test('环检测：把父节点移到自己的后代下会被识别', () => {
    const index = DocumentIndex.build(nodes, doc.rootId);
    const section = Object.values(nodes).find((n) => n.type === 'section') as DocNode;
    const paragraph = Object.values(nodes).find((n) => n.type === 'paragraph' && n.parentId === section.id) as DocNode;
    const text = Object.values(nodes).find((n) => n.type === 'text' && n.parentId === paragraph.id) as DocNode;
    assert(index.wouldCreateCycle(section.id, text.id), '把祖先移到后代下应判定为成环');
    assert(index.wouldCreateCycle(paragraph.id, paragraph.id), '自引用应判定为成环');
    assert(!index.wouldCreateCycle(text.id, section.id), '正常上移不应判定为成环');
    assert(!index.wouldCreateCycle(text.id, doc.rootId), '挂到根下不应判定为成环');
  });

  await test('边界：空文档与不存在 rootId 不抛错', () => {
    const empty = DocumentIndex.build({}, 'n_missing');
    assertEqual(empty.size, 0, '空文档索引应为空');
    assertEqual(empty.unreachable(), [], '空文档不可达集合应为空');
    assertEqual(empty.subtreeIds('n_missing'), [], '不存在的节点子树应为空');
    assertEqual(empty.pathToRoot('n_missing'), ['n_missing'], '不存在节点的路径应返回自身（便于排查）');

    const stray = DocumentIndex.build(nodes, 'n_not_exists');
    assertEqual(stray.unreachable().length, Object.keys(nodes).length, 'rootId 不存在时全部节点都不可达');
  });

  await test('性能：3200 节点级文档的构建 / 遍历 / 增量更新', () => {
    const large = buildLargeSyntheticDoc();
    assertEqual(errorsOf(validateDocument(clone(large.doc))), [], '大文档夹具必须合法');
    const size = Object.keys(large.doc.nodes).length;
    assert(size > 3000, `大文档规模不足：${size}`);

    const t0 = performance.now();
    const index = DocumentIndex.build(large.doc.nodes, large.doc.rootId);
    const buildMs = performance.now() - t0;

    const t1 = performance.now();
    const all = index.subtreeIds(large.doc.rootId);
    const traverseMs = performance.now() - t1;
    assertEqual(all.length, size, '全量遍历应覆盖所有节点');

    const rng = makeRng(42);
    const textIds = large.ids.textIds;
    const samples: number[] = [];
    for (let i = 0; i < 200; i += 1) {
      const id = pick(rng, textIds) as NodeId;
      const node = index.nodeOf(id) as DocNode;
      const snapshot = clone(node);
      const after = clone(node);
      if (after.type === 'text') after.runs = [{ text: `增量 ${i}` }];
      after.order = 100 + i;
      const t = performance.now();
      index.onNodeChanged(snapshot, after);
      samples.push(performance.now() - t);
    }
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.min(samples.length - 1, Math.ceil(0.95 * samples.length) - 1)] as number;

    assert(buildMs <= 1000, `索引构建过慢：${buildMs.toFixed(1)}ms（阈值 1000ms）`);
    assert(traverseMs <= 100, `全量遍历过慢：${traverseMs.toFixed(1)}ms（阈值 100ms）`);
    assert(p95 <= 2, `增量更新 P95 过慢：${p95.toFixed(3)}ms（阈值 2ms）`);

    process.stdout.write(
      `      [性能] ${size} 节点：构建 ${buildMs.toFixed(1)}ms，全量遍历 ${traverseMs.toFixed(1)}ms，增量更新 P95 ${p95.toFixed(3)}ms\n`,
    );
  });

  await test('大文档一致性：增量维护后仍与全量重建等价', () => {
    const large = buildLargeSyntheticDoc();
    const truth = clone(large.doc.nodes);
    const index = DocumentIndex.build(truth, large.doc.rootId);
    const rng = makeRng(7);
    for (let i = 0; i < 100; i += 1) {
      const id = pick(rng, large.ids.textIds) as NodeId;
      const snapshot = clone(truth[id] as DocNode);
      const after = clone(snapshot);
      if (after.type === 'text') after.runs = [{ text: `mutated ${i}` }];
      after.order = 500 + i;
      truth[id] = after;
      index.onNodeChanged(snapshot, after);
    }
    const report = index.verifyAgainst(truth, large.doc.rootId);
    assert(report.ok, `大文档增量维护后不一致：${report.diffs.slice(0, 3).join(' | ')}`);
  });

  process.exit(suite.report());
}

void main();
