// 跨次就诊对比自测（C1~C6）。

import { TestSuite, assert, assertEqual } from '../testing/harness.ts';
import { SCHEMA_VERSION, type DataElementTag, type DocNode, type DocumentModel, type NodeId } from '../model/types.ts';
import { compareVisits } from './visit-compare.ts';

const suite = new TestSuite('跨次就诊对比自测', [
  '说明：只做编码级与原文级对照 —— 不判断语义是否等价，也不抽取药名（那两件事没有评测集就不该声称）。',
]);

const test = (name: string, fn: () => void | Promise<void>): Promise<void> => suite.test(name, fn);

interface ParagraphSpec {
  text: string;
  tags?: DataElementTag[];
}

interface SectionSpec {
  title: string;
  code?: string;
  paragraphs: ParagraphSpec[];
}

const AT = '2026-09-12T02:00:00Z';
const PROV = { origin: 'human' as const, actorId: 'u_doctor', at: AT };

function makeDoc(docId: string, sections: SectionSpec[]): DocumentModel {
  const nodes: Record<NodeId, DocNode> = {};
  nodes.n_root = { id: 'n_root' as NodeId, type: 'document', parentId: null, order: 0, rev: 1, provenance: PROV };

  sections.forEach((section, sectionIndex) => {
    const sectionId = `n_s${sectionIndex}` as NodeId;
    nodes[sectionId] = {
      id: sectionId,
      type: 'section',
      parentId: 'n_root' as NodeId,
      order: sectionIndex,
      rev: 1,
      provenance: PROV,
      title: section.title,
      ...(section.code ? { sectionCode: section.code } : {}),
    } as DocNode;
    section.paragraphs.forEach((paragraph, paragraphIndex) => {
      const paragraphId = `n_s${sectionIndex}_p${paragraphIndex}` as NodeId;
      const textId = `n_s${sectionIndex}_p${paragraphIndex}_t` as NodeId;
      nodes[paragraphId] = {
        id: paragraphId, type: 'paragraph', parentId: sectionId, order: paragraphIndex, rev: 1, provenance: PROV,
      };
      nodes[textId] = {
        id: textId,
        type: 'text',
        parentId: paragraphId,
        order: 0,
        rev: 1,
        provenance: PROV,
        runs: [{ text: paragraph.text }],
        ...(paragraph.tags ? { tags: paragraph.tags } : {}),
      } as DocNode;
    });
  });

  return {
    schemaVersion: SCHEMA_VERSION,
    docId,
    docType: { system: 'WST500', code: 'WST500.2', display: '门（急）诊病历' },
    patient: { patientId: 'P_DEMO_001', nameMasked: '王**', gender: 'M' },
    status: 'draft',
    createdAt: AT,
    updatedAt: AT,
    createdBy: 'u_doctor',
    rootId: 'n_root' as NodeId,
    nodes,
    revisions: [{ rev: 1, at: AT, actorId: 'u_doctor', op: 'create' }],
  };
}

const DIAGNOSIS = (code: string, display: string): DataElementTag =>
  ({ system: 'ICD10', code, display }) as DataElementTag;

const baseSections = (chief: string, diagnosis: string, extra: SectionSpec[] = []): SectionSpec[] => [
  { title: '一、主诉', code: 'chiefComplaint', paragraphs: [{ text: chief }] },
  { title: '二、现病史', code: 'presentIllness', paragraphs: [{ text: '无咯血、盗汗。' }] },
  ...extra,
  { title: '五、初步诊断', code: 'diagnosis', paragraphs: [{ text: diagnosis, tags: [DIAGNOSIS('J18.9', '肺炎')] }] },
];

async function main(): Promise<void> {
  await test('C1 同诊断只认 ICD 编码；段落改写被算作"改写"而不是"相同"', () => {
    const previous = makeDoc('d_prev', baseSections('发热3天，伴咳嗽。', '肺炎'));
    const current = makeDoc('d_curr', baseSections('反复发热三天，伴咳嗽、咳痰。', '肺炎'));
    const result = compareVisits(previous, current);

    assertEqual(result.sameDiagnosis, true, '两侧都有 J18.9 → 同诊断');
    assertEqual(result.diagnosis.shared.length, 1, '应有 1 个共同诊断编码');
    const chief = result.sections.find((row) => row.key === 'chiefComplaint');
    assertEqual(chief?.state, 'changed', '同一章内容不同 → changed');
    assertEqual(chief?.added[0], '反复发热三天，伴咳嗽、咳痰。', '本次新增（改写后的那段）');
    assertEqual(chief?.removed[0], '发热3天，伴咳嗽。', '上次有、这次没了');
    assertEqual(result.changedSections, 1, '只有主诉一章有差异');
    /* 诊断章两侧逐字相同 → same，不该被算成差异 */
    assertEqual(result.sections.find((row) => row.key === 'diagnosis')?.state, 'same', '诊断章未改动');
  });

  await test('C2 两侧都有诊断但无交集：不算同诊断，并说明"仅供参考"', () => {
    const previous = makeDoc('d_prev', [
      { title: '五、初步诊断', code: 'diagnosis', paragraphs: [{ text: '肺炎', tags: [DIAGNOSIS('J18.9', '肺炎')] }] },
    ]);
    const current = makeDoc('d_curr', [
      { title: '五、初步诊断', code: 'diagnosis', paragraphs: [{ text: '胃炎', tags: [DIAGNOSIS('K29.5', '慢性胃炎')] }] },
    ]);
    const result = compareVisits(previous, current);
    assertEqual(result.sameDiagnosis, false, '没有共同编码');
    assertEqual(result.diagnosis.onlyPrevious.length, 1, '上次独有 1 个');
    assertEqual(result.diagnosis.onlyCurrent.length, 1, '本次独有 1 个');
    assert(result.notes.some((note) => note.includes('没有交集')), '必须说明这不是同诊断复诊');
  });

  await test('C3 两侧都没有诊断：不是"同诊断"，且两侧都要说明', () => {
    const previous = makeDoc('d_prev', [{ title: '一、主诉', code: 'chiefComplaint', paragraphs: [{ text: '咳嗽。' }] }]);
    const current = makeDoc('d_curr', [{ title: '一、主诉', code: 'chiefComplaint', paragraphs: [{ text: '咳嗽。' }] }]);
    const result = compareVisits(previous, current);
    assertEqual(result.sameDiagnosis, false, '没有诊断编码就不能声称同诊断');
    assertEqual(result.diagnosis.previousEmpty, true, '上次为空应如实报出');
    assertEqual(result.diagnosis.currentEmpty, true, '本次为空应如实报出');
    assert(result.notes.some((note) => note.includes('上次')), '要说明上次没有诊断');
    assert(result.notes.some((note) => note.includes('本次')), '要说明本次还没有诊断');
  });

  await test('C4 新增章节与消失章节都看得见，且顺序按"这次有什么"排', () => {
    const previous = makeDoc('d_prev', [
      { title: '一、主诉', code: 'chiefComplaint', paragraphs: [{ text: '咳嗽。' }] },
      { title: '九、随访', code: 'followUp', paragraphs: [{ text: '两周后复查。' }] },
    ]);
    const current = makeDoc('d_curr', [
      { title: '一、主诉', code: 'chiefComplaint', paragraphs: [{ text: '咳嗽。' }] },
      { title: '八、用药', code: 'medication', paragraphs: [{ text: '头孢克洛 0.25g tid。' }] },
    ]);
    const result = compareVisits(previous, current);
    const states = result.sections.map((row) => `${row.key}:${row.state}`);
    assertEqual(states[0], 'chiefComplaint:same', '本次有的章节排在前面');
    assertEqual(states[1], 'medication:added', '本次新开的章节应为 added');
    assertEqual(states[2], 'followUp:removed', '上次有、这次没有的章节排在最后');
  });

  await test('C5 用药沿用：只给上次那一章的原文；没有该章时说明原因', () => {
    const withOrders = makeDoc('d_prev', [
      { title: '一、主诉', code: 'chiefComplaint', paragraphs: [{ text: '咳嗽。' }] },
      { title: '八、医嘱', code: 'orders', paragraphs: [{ text: '头孢克洛 0.25g tid 口服 5 天。' }, { text: '两周后复查。' }] },
    ]);
    const current = makeDoc('d_curr', [{ title: '一、主诉', code: 'chiefComplaint', paragraphs: [{ text: '咳嗽。' }] }]);
    const carried = compareVisits(withOrders, current).medication;
    assertEqual(carried.paragraphs.length, 2, '应原样交出上次医嘱的两段');
    assertEqual(carried.paragraphs[0], '头孢克洛 0.25g tid 口服 5 天。', '原文一字不改');
    assertEqual(carried.reason, null, '给得出时不该有原因');

    const noOrders = makeDoc('d_prev2', [{ title: '一、主诉', code: 'chiefComplaint', paragraphs: [{ text: '咳嗽。' }] }]);
    const missing = compareVisits(noOrders, current).medication;
    assertEqual(missing.paragraphs.length, 0, '没有该章时不给任何段落');
    assert(missing.reason !== null && missing.reason.includes('没有'), '必须说明为什么给不出，而不是给一个空数组让人以为"上次没吃药"');
  });

  await test('C6 逐字相同：说"没改动"，不说"没问题"', () => {
    const sections = baseSections('咳嗽3天。', '肺炎');
    const result = compareVisits(makeDoc('d_prev', sections), makeDoc('d_curr', sections));
    assertEqual(result.changedSections, 0, '应无差异');
    assert(result.notes.some((note) => note.includes('没改动')), '要说清楚"相同"的含义');
  });

  process.exit(suite.report());
}

void main();
