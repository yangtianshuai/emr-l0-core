/**
 * 预问诊自测（P1~P6）。
 *
 *   node src/previsit/previsit-self-test.ts
 *
 * 全部离线：入参是合成对象，落点走"摊平后的章节锚点"，不读库、不建文档树。
 */

import { TestSuite, assert, assertEqual } from '../testing/harness.ts';
import {
  MAX_ITEMS,
  PREVISIT_KEYS,
  PREVISIT_SECTION,
  parsePrevisitIntake,
  planPrevisitDrafts,
  type PrevisitRecord,
} from './previsit.ts';

const suite = new TestSuite('预问诊自测', [
  '说明：只把患者写的原文登记下来并给出候选落点 —— 不改写、不猜章节、不落笔，更不产出任何诊断类内容。',
]);

const test = (name: string, fn: () => void | Promise<void>): Promise<void> => suite.test(name, fn);

const NOW = '2026-10-17T02:00:00.000Z';

/** 造一份合法的入参（各用例按需改一处） */
function bodyOf(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    patientId: 'P_DEMO_001',
    visitId: 'V_20261008_0001',
    source: 'his-previsit',
    items: [
      { key: 'chiefComplaint', text: '胸口闷三天。' },
      { key: 'presentIllness', text: '走快一点就闷，休息几分钟能缓。' },
    ],
    ...overrides,
  };
}

const recordOf = (): PrevisitRecord => {
  const parsed = parsePrevisitIntake(bodyOf(), NOW);
  assert(parsed.ok === true, '前置：这份入参必须能通过');
  return (parsed as { ok: true; record: PrevisitRecord }).record;
};

async function main(): Promise<void> {
  await test('P1 合法入参：缺省的 label / reportedAt / source 都按规则补齐，原文一字不动', () => {
    const record = recordOf();
    assertEqual(record.patientId, 'P_DEMO_001', '患者号原样保留');
    assertEqual(record.source, 'his-previsit', '来源原样保留（它决定"谁说的"）');
    assertEqual(record.items.length, 2, '两条都要在');
    assertEqual(record.items[0]?.label, '主诉', 'label 缺省取内置名字');
    assertEqual(record.items[0]?.text, '胸口闷三天。', '原文一字不改');
    assertEqual(record.items[0]?.reportedAt, NOW, '没给采集时刻就取到达时刻');
    assertEqual(record.submittedAt, NOW, '整份表单的到达时刻');

    /* 来源缺省：写一个明确的占位名，而不是空串 —— 空串在界面上会被读成"来源丢失" */
    const withoutSource = parsePrevisitIntake(bodyOf({ source: undefined }), NOW);
    assert(withoutSource.ok === true, '来源可以不填');
    assertEqual((withoutSource as { ok: true; record: PrevisitRecord }).record.source, 'previsit-api', '缺省来源要写明');
  });

  await test('P2 六种拒法各有自己的码：不合规的条目如实拒掉，不静默丢弃也不截断', () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ patientId: '' }, 'E_PREVISIT_NO_PATIENT'],
      [{ items: [] }, 'E_PREVISIT_NO_ITEMS'],
      [{ items: '不是数组' }, 'E_PREVISIT_NO_ITEMS'],
      [{ items: [{ key: 'diagnosis', text: '肺炎' }] }, 'E_PREVISIT_UNKNOWN_KEY'],
      [{ items: [{ key: 'chiefComplaint', text: '  ' }] }, 'E_PREVISIT_EMPTY_TEXT'],
      [{ items: [{ key: 'chiefComplaint', text: '一句话' }, { key: 'chiefComplaint', text: '再来一句' }] }, 'E_PREVISIT_DUPLICATE_KEY'],
      [{ items: [{ key: 'chiefComplaint', text: '一句话', reportedAt: '不是时间' }] }, 'E_PREVISIT_BAD_TIME'],
      [{ items: Array.from({ length: MAX_ITEMS + 1 }, (_, index) => ({ key: 'chiefComplaint', text: `第${index}条` })) }, 'E_PREVISIT_TOO_MANY'],
    ];
    for (const [overrides, expected] of cases) {
      const parsed = parsePrevisitIntake(bodyOf(overrides), NOW);
      assertEqual(parsed.ok, false, `应被拒：${expected}`);
      assertEqual((parsed as { ok: false; code: string }).code, expected, `拒法码应为 ${expected}`);
    }
    /* 关键的一条：`diagnosis` 被拒，不是"忽略"。预问诊 collects 的是自述，不是诊断 */
    assertEqual(PREVISIT_KEYS.includes('diagnosis' as never), false, '诊断不在预问诊字段里');
  });

  await test('P3 章节映射是显式白名单：诊断章永远不在映射里', () => {
    assertEqual(PREVISIT_SECTION.chiefComplaint, 'chiefComplaint', '主诉 → 主诉章');
    assertEqual(PREVISIT_SECTION.presentIllness, 'presentIllness', '现病史 → 现病史章');
    assertEqual(PREVISIT_SECTION.allergy, 'pastHistory', '过敏史落到既往史（明示的近似）');
    assertEqual(PREVISIT_SECTION.medication, 'plan', '用药落到诊疗计划');
    assertEqual(PREVISIT_SECTION.diagnosis, undefined, '诊断没有落点：那不是患者能填的东西');
    for (const key of PREVISIT_KEYS) {
      assert(PREVISIT_SECTION[key] !== undefined, `每个允许的字段都要有落点：${key}`);
    }
  });

  await test('P4 落点：本次文书有这一章才给 nodeId，没有就如实为 null（不往相近章节塞）', () => {
    const record = recordOf();
    const anchors = [
      { code: 'chiefComplaint', nodeId: 'n_s1_p1_t' },
      { code: 'presentIllness', nodeId: null },
    ];
    const drafts = planPrevisitDrafts(record, [], anchors);
    assertEqual(drafts.length, 2, '两条都要产出草稿（缺章的那条也在，只是没有落点）');
    const chief = drafts.find((item) => item.key === 'chiefComplaint');
    const present = drafts.find((item) => item.key === 'presentIllness');
    assertEqual(chief?.nodeId, 'n_s1_p1_t', '有这一章就有落点');
    assertEqual(present?.nodeId, null, '章节在但还没有文本节点 → null');
    assertEqual(present?.sectionCode, 'presentIllness', '缺落点时仍要说清缺的是哪一章');

    /* 文书里根本没有这一章：同样是 null，但绝不能改成"落到主诉" */
    const onlyChief = planPrevisitDrafts(record, ['presentIllness'], [{ code: 'chiefComplaint', nodeId: 'n_s1_p1_t' }]);
    assertEqual(onlyChief.length, 1, '只产出勾选的那一条');
    assertEqual(onlyChief[0]?.nodeId, null, '不能替它挑一个"看着差不多"的章节');
  });

  await test('P5 来源：kind=patient，ref 能定位到那一份表单，capturedAt 是患者填写的时刻', () => {
    const record = recordOf();
    const drafts = planPrevisitDrafts(record, [], [{ code: 'chiefComplaint', nodeId: 'n_s1_p1_t' }]);
    const evidence = drafts[0]?.evidence;
    assertEqual(evidence?.kind, 'patient', '来源类别必须是 patient（混进 user-input 就分不清谁说的）');
    assertEqual(evidence?.field, 'chiefComplaint', '字段键要留下');
    assertEqual(evidence?.valueText, '胸口闷三天。', '被引用的原文要能对上');
    assertEqual(evidence?.capturedAt, NOW, '采集时刻是患者填的那一刻');
    assert(
      typeof evidence?.ref === 'string' && evidence.ref.includes('P_DEMO_001') && evidence.ref.includes(NOW),
      'ref 要能定位到"谁的哪一份表单"',
    );
  });

  await test('P6 只产出候选：不落笔、不生成诊断、不改写', () => {
    const record = recordOf();
    const drafts = planPrevisitDrafts(record, [], [{ code: 'chiefComplaint', nodeId: 'n_s1_p1_t' }]);
    for (const draft of drafts) {
      assertEqual(draft.text, draft.evidence.valueText, '草稿文本必须与来源原文逐字相同（搬运不是改写）');
      assertEqual(draft.sectionCode === 'diagnosis', false, '任何一条都不许落进诊断章');
    }
    /* 函数签名里没有任何"写"的能力：它只返回数组，不回传文档 */
    assertEqual(typeof planPrevisitDrafts(record, [], []), 'object', '产出是纯数据');
  });

  process.exit(suite.report());
}

void main();
