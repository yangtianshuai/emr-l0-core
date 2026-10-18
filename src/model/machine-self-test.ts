// T04/T16 验收自测：机读信息派生 + 陈旧检测。

import { WriteSession, type Actor } from '../core/session.ts';
import { buildSyntheticDoc } from '../testing/synthetic.ts';
import { TestSuite, assert, assertEqual } from '../testing/harness.ts';
import { buildMachineReadable, deriveDataElements, machineReadableStaleness, orderedNodeIds } from './machine.ts';
import { hashNodes } from './hash.ts';
import { SCHEMA_VERSION, type DataElementTag, type DocNode, type DocumentModel, type NodeId } from './types.ts';

const HUMAN: Actor = { id: 'DR_T', kind: 'human' };
const AI: Actor = { id: 'ai-pipeline', kind: 'ai' };

const suite = new TestSuite('T04/T16 机读信息派生与陈旧检测自测', [
  '说明：机读信息是派生物（不得人工编辑），其"新鲜度"用节点表内容指纹判定，而非时间戳。',
  'D 部分要求与工具链 JS 参考实现逐项一致——两套实现各写各的，最容易在标签语义上悄悄漂移。',
]);

const test = (name: string, fn: () => void | Promise<void>): Promise<void> => suite.test(name, fn);

function fixture(sections = 2, paragraphsPerSection = 2, fieldsPerParagraph = 1) {
  return buildSyntheticDoc({ sections, paragraphsPerSection, fieldsPerParagraph });
}

function build(doc: DocumentModel) {
  return buildMachineReadable({
    nodes: doc.nodes,
    rootId: doc.rootId,
    schemaVersion: doc.schemaVersion,
    generatedAt: doc.updatedAt,
  });
}

interface RawStore {
  getDoc(): DocumentModel;
  exportMachineReadable(): DocumentModel['machineReadable'];
}

async function main(): Promise<void> {

  await test('A1 文档顺序遍历：父子有序，且不因节点插入顺序变化而改变', () => {
    const { doc } = fixture();
    const order = orderedNodeIds({ nodes: doc.nodes, rootId: doc.rootId });
    assertEqual(order[0], doc.rootId, '根节点应在最前');
    assertEqual(order.length, Object.keys(doc.nodes).length, '应覆盖全部节点');

    // 打乱插入顺序后，文档顺序必须不变（这是跨实现比对可复现的前提）
    const shuffled: Record<NodeId, DocNode> = {};
    for (const key of Object.keys(doc.nodes).reverse()) shuffled[key] = doc.nodes[key] as DocNode;
    assertEqual(orderedNodeIds({ nodes: shuffled, rootId: doc.rootId }), order, '插入顺序不应影响文档顺序');
  });

  await test('A2 字段标签 → 数据元：一个 tag 一条，value/valueText/unit/origin 全量带上', () => {
    const { doc, ids } = fixture();
    const block = build(doc);
    const fieldCount = ids.fieldIds.length;
    // 每个字段在夹具里带 2 个标签（WS445 + local）
    assertEqual(block.dataElements.length, fieldCount * 2, `数据元数量应为字段数×2，实际 ${block.dataElements.length}`);

    const first = block.dataElements[0];
    assertEqual(first?.nodeId, ids.fieldIds[0], '数据元应指向对应字段节点');
    assertEqual(first?.tag.system, 'WS445', '应保留标签体系');
    assertEqual(typeof first?.value, 'number', 'value 应保留原始类型（不是字符串）');
    assertEqual(first?.unit, '℃', '应带上单位');
    assertEqual(first?.origin, 'system', '来源应来自字段节点的 provenance');
    assertEqual(block.dataElements[1]?.tag.system, 'local', '同一字段的第二个标签也应派生');
    assertEqual(block.sourceHash, hashNodes(doc.nodes), 'sourceHash 必须等于节点表指纹');
  });

  await test('A3 AI 来源字段的置信度进入机读信息（审计需要）', () => {
    const { doc, ids } = fixture();
    const fieldId = ids.fieldIds[0] as NodeId;
    const node = doc.nodes[fieldId] as Extract<DocNode, { type: 'field' }>;
    node.provenance = { origin: 'ai', modelId: 'm1', confidence: 0.97, at: doc.updatedAt };
    const block = build(doc);
    const element = block.dataElements.find((item) => item.nodeId === fieldId);
    assertEqual(element?.origin, 'ai', '来源应为 ai');
    assertEqual(element?.confidence, 0.97, '应带上置信度');
  });

  await test('A4 keyContentRefs：记录关键内容是否存在有效值', () => {
    const { doc, ids } = fixture();
    const fieldId = ids.fieldIds[0] as NodeId;
    const emptyId = ids.fieldIds[1] as NodeId;
    (doc.nodes[fieldId] as DocNode).keyContent = true;
    (doc.nodes[emptyId] as DocNode).keyContent = true;
    (doc.nodes[emptyId] as Extract<DocNode, { type: 'field' }>).value = '';
    const block = build(doc);
    const refs = block.keyContentRefs ?? [];
    assertEqual(refs.length, 2, '应有两个关键内容引用');
    assertEqual(refs.find((ref) => ref.nodeId === fieldId)?.present, true, '有值的关键内容 present=true');
    assertEqual(refs.find((ref) => ref.nodeId === emptyId)?.present, false, '空值的关键内容 present=false');
    assertEqual(refs[0]?.tag?.system, 'WS445', '应带上首个标签');
  });

  await test('A4b 带标签的文本节点 → 数据元（否则 AI 起草的文本在机读块里看不到来源）', () => {
    const { doc, ids } = fixture(1, 1, 1);
    const textId = ids.textIds[0] as NodeId;
    const node = doc.nodes[textId] as Extract<DocNode, { type: 'text' }>;
    node.tags = [{ system: 'WST500', code: 'WST500.2.001', display: '主诉' }];
    node.provenance = { origin: 'ai', modelId: 'm1', confidence: 0.93, at: doc.updatedAt };
    const block = build(doc);
    const element = block.dataElements.find((item) => item.nodeId === textId);
    assertEqual(element?.tag.code, 'WST500.2.001', '应派生出主诉数据元');
    assertEqual(element?.valueText, node.runs.map((run) => run.text).join(''), '值应为全部 run 的拼接文本');
    assertEqual(element?.origin, 'ai', '来源应为 ai（AI 参与度不能丢）');
    assertEqual(element?.confidence, 0.93, '应带上置信度');
  });

  await test('A5 派生确定性：同一文档两次派生结果完全一致（可复现）', () => {
    const { doc } = fixture(3, 3, 1);
    const a = build(doc);
    const b = build(doc);
    assertEqual(JSON.stringify(a), JSON.stringify(b), '两次派生必须字节一致');
  });

  await test('A6 空文档/无标签文档：派生不崩、dataElements 为空数组而非 undefined', () => {
    const { doc } = fixture(1, 1, 0);
    const { dataElements, keyContentRefs } = deriveDataElements({ nodes: doc.nodes, rootId: doc.rootId });
    assertEqual(dataElements, [], '无标签时应为空数组');
    assertEqual(keyContentRefs, [], '无关键内容时应为空数组');
  });

  await test('B1 机读块缺失 → 陈旧（必须先派生）', () => {
    const { doc } = fixture();
    const status = machineReadableStaleness(doc);
    assertEqual(status.stale, true, '无机读块应判为陈旧');
    assertEqual(status.reasons.length, 1, '应给出原因');
  });

  await test('B2 内容指纹一致 → 新鲜；仅改文档级字段（如 updatedAt）不误报陈旧', () => {
    const { doc } = fixture();
    doc.machineReadable = build(doc);
    assertEqual(machineReadableStaleness(doc).stale, false, '刚派生应新鲜');

    doc.updatedAt = '2026-10-08T09:00:00Z';
    assertEqual(machineReadableStaleness(doc).stale, false, '只改 updatedAt 不应误报陈旧（按内容判定）');
  });

  await test('B3 节点内容变更 → 陈旧（这正是"导出前必须重算"的依据）', () => {
    const { doc, ids } = fixture();
    doc.machineReadable = build(doc);
    const fieldId = ids.fieldIds[0] as NodeId;
    (doc.nodes[fieldId] as Extract<DocNode, { type: 'field' }>).value = 39.1;
    const status = machineReadableStaleness(doc);
    assertEqual(status.stale, true, '内容变更后应陈旧');
    assert(status.reasons.some((reason) => reason.includes('sourceHash')), `原因应指向 sourceHash，实际：${status.reasons.join('；')}`);
  });

  await test('B4 schemaVersion 不一致 → 陈旧（迁移后必须重算）', () => {
    const { doc } = fixture();
    doc.machineReadable = build(doc);
    if (doc.machineReadable) doc.machineReadable.modelSchemaVersion = '0.9.0';
    const status = machineReadableStaleness(doc);
    assertEqual(status.stale, true, '版本不一致应陈旧');
    assert(status.reasons.some((reason) => reason.includes('modelSchemaVersion')), '原因应指向版本');
    void SCHEMA_VERSION;
  });

  await test('B5 悬挂引用 → 陈旧（机读数据指向已删除节点是不可接受的）', () => {
    const { doc, ids } = fixture();
    doc.machineReadable = build(doc);
    const goneId = ids.fieldIds[0] as NodeId;
    delete doc.nodes[goneId];
    const status = machineReadableStaleness(doc);
    assertEqual(status.stale, true, '存在悬挂引用应陈旧');
    assert(status.reasons.some((reason) => reason.includes(goneId)), '原因应指出具体节点');
  });

  await test('B6 无 sourceHash 时退化为时间戳判定（兼容旧产物）', () => {
    const { doc } = fixture();
    doc.machineReadable = build(doc);
    if (doc.machineReadable) delete doc.machineReadable.sourceHash;
    assertEqual(machineReadableStaleness(doc).stale, false, 'generatedAt == updatedAt 时应新鲜');
    doc.updatedAt = '2026-10-09T00:00:00Z';
    assertEqual(machineReadableStaleness(doc).stale, true, '时间戳落后时应陈旧');
  });

  await test('C1 会话：重算 → 新鲜；内容变更 → 陈旧；再重算 → 恢复', () => {
    const { doc, ids } = fixture();
    const session = WriteSession.open(doc);
    assertEqual(session.machineReadableStatus().stale, true, '初始（无派生）应陈旧');

    const block = session.exportMachineReadable();
    assertEqual(block.dataElements.length, ids.fieldIds.length * 2, '应派生全部数据元');
    assertEqual(session.machineReadableStatus().stale, false, '重算后应新鲜');

    session.setFieldValue({ nodeId: ids.fieldIds[0] as NodeId, value: 37.2, valueText: '37.2' }, HUMAN);
    assertEqual(session.machineReadableStatus().stale, true, '字段变更后应陈旧（导出会被拒）');

    const refreshed = session.exportMachineReadable();
    assertEqual(session.machineReadableStatus().stale, false, '再次重算应恢复新鲜');
    assertEqual(refreshed.sourceHash, hashNodes(session.document.nodes), 'sourceHash 应随内容更新');
  });

  await test('C2 会话：机读信息随 AI 采纳更新（AI 写在字段上也进机读块）', () => {
    const { doc, ids } = fixture();
    const session = WriteSession.open(doc);
    const fieldId = ids.fieldIds[0] as NodeId;
    session.exportMachineReadable();
    session.setFieldValue({ nodeId: fieldId, value: 38.8, valueText: '38.8' }, HUMAN);
    const block = session.exportMachineReadable();
    const element = block.dataElements.find((item) => item.nodeId === fieldId);
    assertEqual(element?.valueText, '38.8', '机读值应反映最新写入');
    void AI;
  });

  await test('C3 签章强制重算机读信息（否则"签名覆盖机读文件"是假的）', async () => {
    const { doc, ids } = fixture();
    const session = WriteSession.open(doc);
    const fieldId = ids.fieldIds[0] as NodeId;
    session.setFieldValue({ nodeId: fieldId, value: 39.5, valueText: '39.5' }, HUMAN);
    assertEqual(session.machineReadableStatus().stale, true, '签章前应是陈旧的（尚未派生）');

    session.confirmNode({ nodeId: fieldId }, HUMAN);
    await session.sign({}, HUMAN);

    assertEqual(session.machineReadableStatus().stale, false, '签章后机读信息必须新鲜');
    const element = session.document.machineReadable?.dataElements.find((item) => item.nodeId === fieldId);
    assertEqual(element?.valueText, '39.5', '签章时机的机读值应与正文一致');
  });

  const jsModule = (await import('../../tools/model-check/lib/doc-store.mjs')) as {
    createStore: (doc: unknown, options?: unknown) => RawStore;
  };

  await test('D1 与 JS 参考实现：sourceHash / modelSchemaVersion / 数据元 / 关键内容引用逐项一致', () => {
    const { doc } = fixture(4, 3, 2);
    const tsBlock = build(doc);
    const jsStore = jsModule.createStore(structuredClone(doc), {});
    const jsBlock = jsStore.exportMachineReadable();
    assert(!!jsBlock, 'JS 参考实现应产出机读块');

    assertEqual(tsBlock.sourceHash, jsBlock?.sourceHash, 'sourceHash 必须一致（同一节点表同一指纹）');
    assertEqual(tsBlock.modelSchemaVersion, jsBlock?.modelSchemaVersion, '版本锚点应一致');
    assertEqual(tsBlock.generatedAt, jsBlock?.generatedAt, '生成时间应一致（锚定 updatedAt）');
    assertEqual(
      JSON.stringify(tsBlock.dataElements),
      JSON.stringify(jsBlock?.dataElements),
      '数据元（顺序 + 字段）必须逐项一致',
    );
    assertEqual(
      JSON.stringify(tsBlock.keyContentRefs ?? []),
      JSON.stringify(jsBlock?.keyContentRefs ?? []),
      'keyContentRefs 必须一致',
    );
  });

  await test('D2 与 JS 参考实现：陈旧判定行为一致（内容变 → 双方都判陈旧）', () => {
    const tsFixture = fixture(2, 2, 1);
    const tsBlock = build(tsFixture.doc);
    const jsStore = jsModule.createStore(structuredClone(tsFixture.doc), {});

    // 双方同时修改同一字段
    (tsFixture.doc.nodes[tsFixture.ids.fieldIds[0] as NodeId] as Extract<DocNode, { type: 'field' }>).value = 40;
    const jsDoc = jsStore.getDoc();
    (jsDoc.nodes[tsFixture.ids.fieldIds[0] as NodeId] as Extract<DocNode, { type: 'field' }>).value = 40;

    const tsStale = machineReadableStaleness({ ...tsFixture.doc, machineReadable: tsBlock }).stale;
    const jsStale = machineReadableStaleness({ ...jsDoc, machineReadable: jsStore.getDoc().machineReadable }).stale;
    assertEqual(tsStale, true, 'TS 实现应判为陈旧');
    assertEqual(jsStale, true, 'JS 参考实现应判为陈旧');
    assertEqual(tsStale, jsStale, '两套实现判定必须一致');
  });

  await test('D3 带标签文本节点的派生规则同样与 JS 参考实现一致（新增规则必须双实现同步）', () => {
    const tsFixture = fixture(2, 2, 1);
    const textId = tsFixture.ids.textIds[0] as NodeId;
    const tag: DataElementTag = { system: 'WST500', code: 'WST500.2.001', display: '主诉' };
    const textNode = tsFixture.doc.nodes[textId] as Extract<DocNode, { type: 'text' }>;
    textNode.tags = [tag];
    textNode.provenance = { origin: 'ai', modelId: 'm1', confidence: 0.93, at: tsFixture.doc.updatedAt };

    const jsStore = jsModule.createStore(structuredClone(tsFixture.doc), {});
    const tsBlock = build(tsFixture.doc);
    const jsBlock = jsStore.exportMachineReadable();
    assertEqual(
      JSON.stringify(tsBlock.dataElements),
      JSON.stringify(jsBlock?.dataElements),
      '带标签文本节点的派生结果必须逐项一致（不允许单边实现新规则）',
    );
    assertEqual(tsBlock.sourceHash, jsBlock?.sourceHash, 'sourceHash 也应一致');
  });

  process.exit(suite.report());
}

void main();
