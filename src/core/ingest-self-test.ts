// 系统取数（LIS/HIS 搬运）自测。

import { TestSuite, assert, assertEqual, codeOfAsync } from '../testing/harness.ts';
import { buildTrend } from '../model/trend.ts';
import { WriteSession } from './session.ts';
import type { DocumentModel, DocNode, JsonValue } from '../model/types.ts';

const suite = new TestSuite('系统取数（外部数据搬运）自测', [
  '说明：本套验证"搬运可直通"与"四条约束"并存，B5/B6 是防回退的关键。',
]);

const test = (name: string, fn: () => void | Promise<void>): Promise<void> => suite.test(name, fn);

const HUMAN = { id: 'DR_WANG', kind: 'human' as const };
const AI = { id: 'ai-pipeline', kind: 'ai' as const };
const SYSTEM = { id: 'system/lis', kind: 'system' as const };

function codeOf(fn: () => unknown): string {
  try {
    fn();
    return 'OK';
  } catch (err) {
    return (err as { code?: string }).code ?? '(无错误码)';
  }
}

type AnyNode = DocNode & { humanConfirmed?: boolean; valueText?: string; value?: unknown; provenance: { origin: string; evidence?: unknown[] } };

function fixture(): DocumentModel {
  const at = '2026-10-08T01:00:00Z';
  const prov = (origin: 'human' | 'system', actorId: string) => ({ origin, actorId, at });
  return {
    schemaVersion: '1.0.0',
    docId: 'doc_ingest_1',
    docType: { system: 'WST500', code: 'WST500.2', display: '门（急）诊病历' },
    patient: { patientId: 'P9001', nameMasked: '张**', gender: 'M' },
    status: 'draft',
    createdAt: at,
    updatedAt: at,
    createdBy: 'DR_WANG',
    rootId: 'n_root',
    nodes: {
      n_root: { id: 'n_root', type: 'document', parentId: null, order: 0, rev: 1, provenance: prov('system', 'seed') },
      n_p: { id: 'n_p', type: 'paragraph', parentId: 'n_root', order: 10, rev: 1, provenance: prov('human', 'DR_WANG') },
      /* 空字段：等系统带入 */
      n_wbc: {
        id: 'n_wbc',
        type: 'field',
        parentId: 'n_p',
        order: 10,
        rev: 1,
        dataType: 'number',
        value: '',
        valueText: '',
        unit: '10^9/L',
        keyContent: true,
        tags: [{ system: 'LOINC', code: '6690-2', display: '白细胞计数' }],
        provenance: prov('system', 'seed'),
      },
    },
    revisions: [],
  } as unknown as DocumentModel;
}

const EVIDENCE = [{ kind: 'lis' as const, ref: 'LIS:20261008-0100:WBC', field: 'WBC', valueText: '12.6', quote: '白细胞计数 12.6' }];
const item = (value: JsonValue, valueText: string, evidence = EVIDENCE) => ({ nodeId: 'n_wbc', value, valueText, evidence });

function nodeOf(session: WriteSession): AnyNode {
  return session.getNode('n_wbc') as unknown as AnyNode;
}

async function main(): Promise<void> {
  await test('B1 系统取数可以直通落笔，但落笔后仍是"待核对"（搬运 ≠ 核对）', async () => {
    const session = WriteSession.open(fixture());
    const result = session.applyExternalData({ items: [item(12.6, '12.6')] }, SYSTEM);

    assertEqual(result.applied, ['n_wbc'], '应写入该字段');
    assertEqual(result.revision !== null, true, '应产生一条留痕');
    const node = nodeOf(session);
    assertEqual(node.valueText, '12.6', '值应已写入');
    assertEqual(node.provenance.origin, 'system', '来源应为 system（表明这是搬来的）');
    assertEqual(node.humanConfirmed, false, '搬运不等于核对：落笔后必须仍是待确认');
    assertEqual(session.auditLog().slice(-1)[0]?.op, 'external', '留痕 op 应为 external（不能混进 update）');
  });

  await test('B2 只有 system 身份能走这条通道；且必须带强引用来源', async () => {
    const session = WriteSession.open(fixture());
    assertEqual(
      codeOf(() => session.applyExternalData({ items: [item(12.6, '12.6')] }, AI)),
      'E_EXTERNAL_ACTOR_INVALID',
      'AI 不得走系统取数（它必须走建议通道，因为会编）',
    );
    assertEqual(
      codeOf(() => session.applyExternalData({ items: [item(12.6, '12.6')] }, HUMAN)),
      'E_EXTERNAL_ACTOR_INVALID',
      '人类不得走系统取数（那是他的判断，走 setFieldValue）',
    );
    assertEqual(
      codeOf(() => session.applyExternalData({ items: [{ nodeId: 'n_wbc', value: 12.6, evidence: [] }] }, SYSTEM)),
      'E_EXTERNAL_EVIDENCE_REQUIRED',
      '没有来源引用的数据不得写入病历（回溯不到就查不出错在哪）',
    );
    assertEqual(
      codeOf(() => session.applyExternalData({ items: [] }, SYSTEM)),
      'E_EXTERNAL_SCOPE_REQUIRED',
      '空调用必须拒绝（不静默成功）',
    );
  });

  await test('B3 幂等：同一报告同一字段重复到达 → 跳过，且不产生多余留痕', async () => {
    const session = WriteSession.open(fixture());
    session.applyExternalData({ items: [item(12.6, '12.6')] }, SYSTEM);
    const before = session.auditLog().length;

    const again = session.applyExternalData({ items: [item(12.6, '12.6')] }, SYSTEM);
    assertEqual(again.applied, [], '值相同应跳过');
    assertEqual(again.skipped, [{ nodeId: 'n_wbc', reason: 'duplicate' }], '应如实报告跳过原因');
    assertEqual(again.revision, null, '全部重复时不产生留痕');
    assertEqual(session.auditLog().length, before, '留痕数量不应变化（否则审计会被重复到达刷屏）');
  });

  await test('B4 值修正：同一来源但值变了 → 允许更新（检验结果有时会修正）', async () => {
    const session = WriteSession.open(fixture());
    session.applyExternalData({ items: [item(12.6, '12.6')] }, SYSTEM);
    const corrected = session.applyExternalData({ items: [item(12.9, '12.9')] }, SYSTEM);
    assertEqual(corrected.applied, ['n_wbc'], '值不同应允许更新');
    assertEqual(nodeOf(session).valueText, '12.9', '应更新为新值');
    assertEqual(nodeOf(session).humanConfirmed, false, '更新后仍待核对');
  });

  await test('B5 不覆盖人工内容：医生写过或已确认的字段一律拒绝（防回退）', async () => {
    const session = WriteSession.open(fixture());
    session.setFieldValue({ nodeId: 'n_wbc', value: 9.8, valueText: '9.8' }, HUMAN);
    assertEqual(
      codeOf(() => session.applyExternalData({ items: [item(12.6, '12.6')] }, SYSTEM)),
      'E_EXTERNAL_CONFLICT',
      '系统取数不得覆盖医生填写的内容 —— 系统悄悄改医生写的东西是最不能接受的事故',
    );
    assertEqual(nodeOf(session).valueText, '9.8', '冲突时原值必须保持不变');
  });

  await test('B6 关键内容照旧被签名门控拦住：搬运不豁免确认（防回退）', async () => {
    const session = WriteSession.open(fixture());
    session.applyExternalData({ items: [item(12.6, '12.6')] }, SYSTEM);
    assertEqual(
      await codeOfAsync(() => session.sign({ acknowledgeUnconfirmed: true }, HUMAN)),
      'E_KEY_CONTENT_UNCONFIRMED',
      '带进来的关键内容仍需显式确认，且声明也不能豁免',
    );
    /* 人工确认后可签章 —— 证明这条通道不会把文档锁死 */
    session.confirmNode({ nodeId: 'n_wbc' }, HUMAN);
    assertEqual((await session.sign({}, HUMAN)).ok, true, '确认后应可签章');
  });

  await test('B7 闭环：LIS 一次推入 3 天 WBC（带采样时间与参考范围）→ 趋势自动成形', async () => {
    /* 造 3 个空的白细胞字段，模拟 3 天的检验（每个采样值一个节点，独立留痕） */
    const base = fixture();
    const nodes = base.nodes as Record<string, DocNode>;
    for (const day of ['06', '07', '08']) {
      nodes[`n_wbc_${day}`] = {
        ...(nodes.n_wbc as DocNode),
        id: `n_wbc_${day}`,
        order: Number(day),
        sourceKey: 'LIS.WBC',
      } as DocNode;
    }
    const session = WriteSession.open(base);

    const range = { low: 4, high: 10 };
    const result = session.applyExternalData(
      {
        items: [
          { nodeId: 'n_wbc_06', value: 9.8, valueText: '9.8', sampledAt: '2026-10-06T07:00:00Z', referenceRange: range, evidence: [{ kind: 'lis' as const, ref: 'LIS:1006:WBC', valueText: '9.8' }] },
          { nodeId: 'n_wbc_07', value: 15.2, valueText: '15.2', sampledAt: '2026-10-07T07:00:00Z', referenceRange: range, evidence: [{ kind: 'lis' as const, ref: 'LIS:1007:WBC', valueText: '15.2' }] },
          { nodeId: 'n_wbc_08', value: 18.4, valueText: '18.4', sampledAt: '2026-10-08T07:00:00Z', referenceRange: range, evidence: [{ kind: 'lis' as const, ref: 'LIS:1008:WBC', valueText: '18.4' }] },
        ],
      },
      SYSTEM,
    );
    assertEqual(result.applied.length, 3, '三天数据应一次带入');
    assertEqual(session.auditLog().slice(-1)[0]?.op, 'external', '一次带入只产生一条留痕（同一次触发）');

    /* 关键：不需要任何额外步骤，趋势自动成形 —— 这就是闭环  */
    const trend = buildTrend(session.document, 'LIS.WBC');
    assert(!!trend, '带入后应自动形成趋势');
    assertEqual(trend!.points.map((point) => point.valueText), ['9.8', '15.2', '18.4'], '趋势应按采样时间升序');
    assertEqual(trend!.stats.abnormal, 2, '后两点高于参考上限，应标为异常');
    assertEqual(trend!.stats.unconfirmed, 3, '带入的值一律待核对（搬运 ≠ 核对）');
    assertEqual(trend!.stats.last, 18.4, 'last 应为最新值');
  });

  process.exit(suite.report());
}

void main();
