// 患者主索引（EMPI）自测。

import { TestSuite, assert, assertEqual } from '../testing/harness.ts';
import { PatientIndex, type PatientIdentifier } from './identity.ts';

const suite = new TestSuite('患者主索引（EMPI）自测', [
  '说明：跨文书一致性 / 数据找人 / 趋势全部依赖"这是同一个患者"，主索引错了会把两个人的数据报成矛盾。',
  'M3/M5 是防误合并的关键：宁可漏合并（查不出），也不能误合并（粘连且难发现）。',
]);

const test = (name: string, fn: () => void | Promise<void>): Promise<void> => suite.test(name, fn);

const AT = '2026-10-09T08:00:00Z';
const id = (system: string, value: string): PatientIdentifier => ({ system, value });

async function main(): Promise<void> {
  await test('M1 登记后可按标识解析到同一主索引', () => {
    const index = new PatientIndex();
    index.register('P_001', [id('his', 'H0001')], AT, 'admin');
    assertEqual(index.resolve(id('his', 'H0001')), { status: 'matched', masterId: 'P_001' }, '应命中');
    assertEqual(index.size(), 1, '一个主索引');
  });

  await test('M2 多系统标识归一到同一患者：门诊号 / 住院号 / 医保号 / 身份证', () => {
    const index = new PatientIndex();
    index.register(
      'P_001',
      [id('outpatient-no', 'M2026001'), id('inpatient-no', 'Z2026123'), id('insurance', 'YB8899'), id('id-card', '110101198103120011')],
      AT,
      'admin',
    );
    /* 任意一个标识都应解析到同一个人 —— 这正是"不同系统各带各的号"要解决的问题 */
    for (const identifier of [id('outpatient-no', 'M2026001'), id('inpatient-no', 'Z2026123'), id('id-card', '110101198103120011')]) {
      assertEqual(index.resolve(identifier), { status: 'matched', masterId: 'P_001' }, `${identifier.system} 应命中同一患者`);
    }
  });

  await test('M3 **冲突必须报告且不覆盖**：同一标识已属于别人时不得改写归属', () => {
    const index = new PatientIndex();
    index.register('P_001', [id('id-card', '110101198103120011')], AT, 'admin');
    const result = index.register('P_002', [id('id-card', '110101198103120011'), id('his', 'H0002')], AT, 'admin');

    assertEqual(result.conflicts.length, 1, '占用冲突必须报告');
    assertEqual(result.conflicts[0]?.occupiedBy, 'P_001', '应指出被谁占用');
    assertEqual(result.accepted.length, 1, '不冲突的标识照常登记（不能因一条冲突丢掉整批）');
    assertEqual(
      index.resolve(id('id-card', '110101198103120011')),
      { status: 'matched', masterId: 'P_001' },
      '归属不得被覆盖 —— 否则"谁后写"就决定了患者是谁',
    );
    assertEqual(index.resolve(id('his', 'H0002')), { status: 'matched', masterId: 'P_002' }, '其他标识正常工作');
  });

  await test('M4 未登记的标识返回 unknown：**不猜、不自动新建**', () => {
    const index = new PatientIndex();
    index.register('P_001', [id('his', 'H0001')], AT, 'admin');
    const result = index.resolve(id('his', 'H9999'));
    assertEqual(result.status, 'unknown', '陌生标识不得被猜测归属');
    assertEqual(index.size(), 1, '解析不产生新患者');
  });

  await test('M5 **不做概率匹配**：姓名、性别、生日相同但标识不同 → 不合并', () => {
    const index = new PatientIndex();
    index.register('P_001', [id('outpatient-no', 'M001')], AT, 'admin');
    index.register('P_002', [id('outpatient-no', 'M002')], AT, 'admin');
    /* 同名同生日在医院里真实存在（尤其常见姓名）。靠概率匹配代替主索引，
       会把两个人的病历粘在一起，而且这种错误看起来像正常数据，几乎无法发现。  */
    assertEqual(index.resolve(id('outpatient-no', 'M002')), { status: 'matched', masterId: 'P_002' }, '不同号是不同患者');
    assertEqual(index.size(), 2, '不得自动合并');
  });

  await test('M6 合并可追溯：源主索引消失，合并史留在目标上', () => {
    const index = new PatientIndex();
    index.register('P_old', [id('outpatient-no', 'M001')], AT, 'admin');
    index.register('P_new', [id('id-card', '110101198103120011')], AT, 'admin');

    assertEqual(index.merge('P_old', 'P_new', AT, 'emp-admin').ok, true, '合并应成功');
    assertEqual(index.size(), 1, '源主索引不再存在（合并是破坏性的）');
    assertEqual(index.resolve(id('outpatient-no', 'M001')), { status: 'matched', masterId: 'P_new' }, '原标识改属目标');
    const merged = index.get('P_new');
    assertEqual(merged?.mergedFrom.length, 1, '合并史必须留痕');
    assertEqual(merged?.mergedFrom[0]?.masterId, 'P_old', '应记录被吸收的主索引');
    assertEqual(merged?.mergedFrom[0]?.by, 'emp-admin', '应记录操作人');

    assertEqual(index.merge('P_new', 'P_new', AT, 'admin').ok, false, '不能与自己合并');
    assertEqual(index.merge('P_none', 'P_new', AT, 'admin').ok, false, '源不存在应失败');
  });

  await test('M7 标识归一化：空格与大小写差异不算两个患者', () => {
    const index = new PatientIndex();
    index.register('P_001', [id('HIS', 'H0001')], AT, 'admin');
    assertEqual(
      index.resolve(id(' his ', '  H0001 ')),
      { status: 'matched', masterId: 'P_001' },
      '同一体系同号（含空格 / 大小写差异）应视为同一标识',
    );
  });

  process.exit(suite.report());
}

void main();
