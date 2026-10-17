/**
 * 出院汇总自测（D1~D6）。
 *
 *   node src/summary/discharge-summary-self-test.ts
 *
 * 这一族最容易写错的地方，各有用例钉住：
 *   D1 **原文搬运**：多段按固定连接符合并，不摘要、不改写；
 *   D2 **缺文书就是缺**：没有入院记录时如实报缺口，且不产生"凭空补上"的条目；
 *   D3 **空章节 ≠ 没这个事实**：源章存在但为空，报 E_SOURCE_EMPTY；
 *   D4 **目标章不存在**：给出内容但不给落点（`targetNodeId` 为 null）；
 *   D5 **三态**：空 → new；与派生一致 → same；已有不同文字 → changed；
 *   D6 **优先级**：出院诊断先取病程记录，没有才退回入院记录的初步诊断。
 *
 * 全部离线：合成文书，不读库、不联网。
 */

import { TestSuite, assert, assertEqual } from '../testing/harness.ts';
import {
  planDischargeSummary,
  dischargeSummaryApplicability,
  PARAGRAPH_JOINER,
  type SummaryDoc,
  type SummarySection,
} from './discharge-summary.ts';

const suite = new TestSuite('出院汇总自测', [
  '说明：只搬运原文并核对缺口 —— 不改写、不摘要、不猜；产出是建议，落笔由人决定。',
]);

const test = (name: string, fn: () => void | Promise<void>): Promise<void> => suite.test(name, fn);

/* ------------------------------ 夹具 ------------------------------ */

const section = (code: string, title: string, texts: string[]): SummarySection => ({
  code,
  title,
  paragraphs: texts.map((text, index) => ({ nodeId: `${code}_p${index}`, text })),
});

const doc = (params: {
  docId: string;
  title: string;
  docTypeCode: string;
  createdAt: string;
  sections: SummarySection[];
}): SummaryDoc => params;

const admission = (overrides: Partial<SummaryDoc> = {}): SummaryDoc => doc({
  docId: 'd_adm',
  title: '入院记录',
  docTypeCode: 'WST500.1',
  createdAt: '2026-10-05T03:00:00Z',
  sections: [
    section('chiefComplaint', '一、主诉', ['反复头晕1年，加重3天。']),
    section('presentIllness', '二、现病史', ['患者1年前发现血压升高，最高170/100mmHg。']),
    section('pastHistory', '三、既往史', ['高血压病史1年，否认糖尿病、冠心病史。']),
    section('diagnosis', '五、初步诊断', ['高血压病2级（高危）。']),
  ],
  ...overrides,
});

const progress = (overrides: Partial<SummaryDoc> = {}): SummaryDoc => doc({
  docId: 'd_prog',
  title: '病程记录',
  docTypeCode: 'WST500.3',
  createdAt: '2026-10-05T09:00:00Z',
  sections: [
    section('conditionChange', '一、病情变化', ['入院后予对症治疗，头晕减轻。']),
    section('plan', '四、诊治调整', ['继续口服降压药，监测血压。']),
  ],
  ...overrides,
});

const discharge = (params: { sections: SummarySection[] } = {
  sections: [
    section('admissionStatus', '一、入院情况', ['']),
    section('pastHistory', '二、既往史', ['']),
    section('hospitalCourse', '三、住院经过', ['']),
    section('dischargeDiagnosis', '四、出院诊断', ['']),
    section('dischargeAdvice', '四、出院医嘱', ['']),
  ],
}): SummaryDoc => doc({
  docId: 'd_dis',
  title: '出院记录',
  docTypeCode: 'WST500.4',
  createdAt: '2026-10-07T15:00:00Z',
  sections: params.sections,
});

const planOf = (docs: SummaryDoc[]) => planDischargeSummary({ currentDocId: 'd_dis', docs });
const itemOf = (plan: ReturnType<typeof planOf>, key: string) => plan.items.find((item) => item.key === key);

/* ------------------------------- 用例 ------------------------------- */

async function main(): Promise<void> {
  await test('D1 多段原文按固定连接符合并，不摘要、不改写', () => {
    const plan = planOf([admission(), progress(), discharge()]);
    const admissionStatus = itemOf(plan, 'admissionStatus');
    /* 前一段已以句号收尾，不再插入连接符（否则会出现「3天。；患者……」） */
    assertEqual(
      admissionStatus?.text,
      '反复头晕1年，加重3天。患者1年前发现血压升高，最高170/100mmHg。',
      '入院情况应同时搬主诉与现病史，原文一字不改',
    );
    /* 两段都没有句末标点时才插入连接符：否则「咳嗽3天发热2天」会被读成一件事 */
    const noStop = planOf([
      admission({
        sections: [
          section('chiefComplaint', '一、主诉', ['咳嗽3天']),
          section('presentIllness', '二、现病史', ['发热2天']),
        ],
      }),
      progress(),
      discharge(),
    ]);
    assertEqual(
      itemOf(noStop, 'admissionStatus')?.text,
      `咳嗽3天${PARAGRAPH_JOINER}发热2天`,
      '缺分隔会读成一句话，必须补连接符',
    );
    assertEqual(admissionStatus?.sources.length, 2, '两段来源都要留下，界面才能逐段跳回');
    assertEqual(admissionStatus?.sources[0]?.nodeId, 'chiefComplaint_p0', '来源要指到具体节点');
    assertEqual(itemOf(plan, 'hospitalCourse')?.text, '入院后予对症治疗，头晕减轻。', '住院经过来自病程记录');
    assertEqual(itemOf(plan, 'dischargeAdvice')?.text, '继续口服降压药，监测血压。', '出院医嘱来自诊治调整');
  });

  await test('D2 缺源文书：如实报缺口，且不凭空产出条目', () => {
    const plan = planOf([progress(), discharge()]);
    assertEqual(itemOf(plan, 'pastHistory'), undefined, '没有入院记录就不该有既往史条目');
    const gap = plan.gaps.find((item) => item.code === 'E_NO_SOURCE_DOC' && item.title === '既往史');
    assert(gap !== undefined, '必须说明"本次就诊没有入院记录"');
    assert(gap.detail.includes('入院记录'), '缺口要指名缺的是哪份文书');
    /* 「入院情况」由主诉 + 现病史两个槽位组成，两者都指向入院记录：只能报一次，
       否则读起来像缺了两份文书 */
    assertEqual(
      plan.gaps.filter((item) => item.code === 'E_NO_SOURCE_DOC' && item.title === '入院情况').length,
      1,
      '同一句缺口不得重复',
    );
  });

  await test('D3 源章存在但为空：报"空"，不说成"没有这个事实"', () => {
    const emptyAdmission = admission({
      sections: [
        section('chiefComplaint', '一、主诉', ['']),
        section('presentIllness', '二、现病史', ['']),
      ],
    });
    const plan = planOf([emptyAdmission, progress(), discharge()]);
    const gap = plan.gaps.find((item) => item.code === 'E_SOURCE_EMPTY');
    assert(gap !== undefined, '空章节必须单独报出来');
    assert(gap.detail.includes('空的'), '措辞要说清是"没写"，不是"没有"');
  });

  await test('D4 目标章不存在：给内容但不给落点（null），供界面明说"先建这一章"', () => {
    const withoutAdvice = discharge({ sections: [section('hospitalCourse', '三、住院经过', [''])] });
    const plan = planOf([admission(), progress(), withoutAdvice]);
    const item = itemOf(plan, 'dischargeAdvice');
    assertEqual(item?.text, '继续口服降压药，监测血压。', '内容仍要给出（医生可以手工粘）');
    assertEqual(item?.targetNodeId, null, '没有目标章就不能自动落笔');
    assert(
      plan.gaps.some((gap) => gap.code === 'E_TARGET_SECTION_MISSING' && gap.title === '出院医嘱'),
      '必须说明缺的是目标章节',
    );
  });

  await test('D5 三态：空→new；与派生一致→same；已有不同文字→changed', () => {
    const fresh = planOf([admission(), progress(), discharge()]);
    assertEqual(itemOf(fresh, 'pastHistory')?.state, 'new', '目标章为空应是 new');

    const same = planOf([admission(), progress(), discharge({
      sections: [section('pastHistory', '二、既往史', ['高血压病史1年，否认糖尿病、冠心病史。'])],
    })]);
    assertEqual(itemOf(same, 'pastHistory')?.state, 'same', '逐字一致应是 same');

    const changed = planOf([admission(), progress(), discharge({
      sections: [section('pastHistory', '二、既往史', ['高血压病史1年，冠心病史2年。'])],
    })]);
    assertEqual(itemOf(changed, 'pastHistory')?.state, 'changed', '已有不同文字应是 changed');
    assert(changed.notes.some((note) => note.includes('覆盖')), 'changed 必须提醒会覆盖现有文字');
  });

  await test('D6 优先级：出院诊断先取病程记录，没有再退回入院记录的初步诊断', () => {
    const withProgressDiagnosis = progress({
      sections: [
        section('conditionChange', '一、病情变化', ['入院后予对症治疗。']),
        section('diagnosis', '五、复查诊断', ['高血压病2级（高危）。']),
      ],
    });
    assertEqual(
      itemOf(planOf([admission(), withProgressDiagnosis, discharge()]), 'dischargeDiagnosis')?.sources[0]?.docTitle,
      '病程记录',
      '病程记录有诊断时优先用它',
    );
    assertEqual(
      itemOf(planOf([admission(), progress(), discharge()]), 'dischargeDiagnosis')?.sources[0]?.docTitle,
      '入院记录',
      '病程记录没有诊断时退回入院记录',
    );
  });

  await test('D7 只在住院上摆这一栏：门诊 / 急诊 / 体检不可用，类型未知与导入件不挡', () => {
    assertEqual(dischargeSummaryApplicability({ visitType: 'inpatient' }).applicable, true, '住院可用');
    for (const type of ['outpatient', 'emergency', 'physical-exam']) {
      const result = dischargeSummaryApplicability({ visitType: type });
      assertEqual(result.applicable, false, `${type} 不是住院，不该摆出入口`);
      assert(result.reason !== null && result.reason.includes('住院'), '不可用要说清"为什么"');
    }
    /* 两条不挡：认不出就不替人断言。模板的 `templateFitsVisit` 是同一条口径 */
    assertEqual(dischargeSummaryApplicability({ visitType: '' }).applicable, true, '类型未知时不限制');
    assertEqual(
      dischargeSummaryApplicability({ visitType: 'outpatient', imported: true }).applicable,
      true,
      '导入件的类型是占位值（导入时统一写 outpatient）：不能因此挡住一份真实的出院记录',
    );
  });

  process.exit(suite.report());
}

void main();
