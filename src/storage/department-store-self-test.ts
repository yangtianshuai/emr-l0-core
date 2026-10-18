// 科室字典自测（D1~D5）。

import { TestSuite, assert, assertEqual } from '../testing/harness.ts';
import { openConfigFixture, writeCorruptRow } from '../testing/config-fixture.ts';
import {
  DEPARTMENT_CONFIG_KEY,
  departmentNameOf,
  departmentsSeeded,
  describeDepartments,
  isDepartmentSelectable,
  loadDepartments,
  markDepartmentsSeeded,
  normalizeDepartmentCode,
  saveDepartments,
} from './department-store.ts';

const suite = new TestSuite('科室字典自测（主数据：编码判定、名称展示）', [
  '说明：编码与就诊 `encounter.deptCode` 对齐（判定靠它），名称只用于展示与选择。',
  'D1/D4 是防回退关键：读不出来必须报，老写法必须能被对齐 —— 两者任一被放宽，"限产科"就会静默失效。',
]);

const test = (name: string, fn: () => void | Promise<void>): Promise<void> => suite.test(name, fn);

const codeOf = (fn: () => unknown): string => {
  try {
    fn();
    return 'OK';
  } catch (err) {
    return String((err as { code?: string }).code ?? `UNEXPECTED:${(err as Error).message}`);
  }
};

const ITEMS = [
  { code: 'DEPT_RESP', name: '呼吸内科', enabled: true },
  { code: 'DEPT_OB', name: '产科', enabled: true },
];

async function main(): Promise<void> {
  await test('D1 三态：没配 = 空（不编默认科室）、配了能读回、**坏了抛错**（不当"没配过"）', () => {
    const fixture = openConfigFixture({ prefix: 'l0-dept-' });
    try {
      const empty = loadDepartments(fixture.kv);
      assertEqual(empty.source, 'empty', '没配过就是空');
      assertEqual(empty.items.length, 0, '**不编一套默认科室**：空就是空，界面据此说"先去建科室"');

      const saved = saveDepartments(fixture.kv, ITEMS, 'admin', { at: '2026-10-15T00:00:00.000Z' });
      assertEqual(saved.source, 'store', '配过之后是 store');
      assertEqual(saved.items.length, 2, '两条都读回');
      assertEqual(saved.updatedBy, 'admin', '改动人记下来（谁把科室改了要答得出来）');

      const reloaded = loadDepartments(fixture.kv);
      assertEqual(JSON.stringify(reloaded.items), JSON.stringify(saved.items), '往返一致');

      const described = describeDepartments(reloaded);
      assertEqual(described.enabledCount, 2, '启用数供界面直接显示');

      /* 坏行：口令换过 / 有人改过那一行。必须抛错，不能当作"没配过" ——
         当成没配过会让所有"限科室"的判定静默失效（全院通用），而没人知道。  */
      writeCorruptRow(fixture, DEPARTMENT_CONFIG_KEY);
      assertEqual(codeOf(() => loadDepartments(fixture.kv)), 'E_DEPT_INVALID', '解不开必须报，不许静默降级');
    } finally {
      fixture.cleanup();
    }
  });

  await test('D2 校验：编码唯一、名称非空（"这份文书限哪个科"只能有一个答案）', () => {
    const fixture = openConfigFixture({ prefix: 'l0-dept-' });
    try {
      assertEqual(
        codeOf(() => saveDepartments(fixture.kv, { items: [] }, 'admin')),
        'E_DEPT_INVALID',
        '清单必须是数组（对象形状不对要当场报）',
      );
      assertEqual(
        codeOf(() => saveDepartments(fixture.kv, [{ name: '产科' }], 'admin')),
        'E_DEPT_INVALID',
        '缺编码要报：判定用的是它',
      );
      assertEqual(
        codeOf(() => saveDepartments(fixture.kv, [{ code: 'DEPT_OB' }], 'admin')),
        'E_DEPT_INVALID',
        '缺名称要报：界面上显示的是它',
      );
      assertEqual(
        codeOf(() => saveDepartments(fixture.kv, [{ code: 'DEPT_OB', name: '产科', enabled: 'yes' }], 'admin')),
        'E_DEPT_INVALID',
        '启用状态只能是布尔（"yes" 这种真值在界面上会显示成没勾）',
      );
      const duplicate = codeOf(() =>
        saveDepartments(fixture.kv, [{ code: 'DEPT_OB', name: '产科' }, { code: 'DEPT_OB', name: '产房' }], 'admin'),
      );
      assertEqual(duplicate, 'E_DEPT_INVALID', '编码重复要报：重复时"限哪个科"就没有确定答案');

      /* 空清单是合法输入（= 清空），不是错误：清空之后 source 回到 empty */
      const cleared = saveDepartments(fixture.kv, [], 'admin');
      assertEqual(cleared.source, 'store', '清空是一次**写入**（不是"没配过"）：谁清的要留在记录里');
      assertEqual(cleared.items.length, 0, '清空之后没有任何科室');
    } finally {
      fixture.cleanup();
    }
  });

  await test('D3 停用 ≠ 删除：新配置选不到它，但**既有模板照样显示它的名字**', () => {
    const fixture = openConfigFixture({ prefix: 'l0-dept-' });
    try {
      const loaded = saveDepartments(
        fixture.kv,
        [{ code: 'DEPT_RESP', name: '呼吸内科' }, { code: 'DEPT_OB', name: '产科', enabled: false }],
        'admin',
      );
      assertEqual(isDepartmentSelectable(loaded, 'DEPT_OB'), false, '停用的科室不能再被新配置选中');
      assertEqual(isDepartmentSelectable(loaded, 'DEPT_NOPE'), false, '不存在的编码当然也选不到');
      assertEqual(isDepartmentSelectable(loaded, 'DEPT_RESP'), true, '启用中的照旧可选');
      assertEqual(
        departmentNameOf(loaded, 'DEPT_OB'),
        '产科',
        '停用的科室仍然要能翻译出名称 —— 已经配了它的模板、已经开出的病历都还要显示"产科"',
      );
      assertEqual(departmentNameOf(loaded, 'DEPT_NOPE'), undefined, '字典里没有就返回 undefined，**不拿编码冒充名称**');
    } finally {
      fixture.cleanup();
    }
  });

  await test('D4 归一：老数据里的名称与字典里的编码说的是同一个科（读取时对齐，**不改病历**）', () => {
    const fixture = openConfigFixture({ prefix: 'l0-dept-' });
    try {
      const loaded = saveDepartments(fixture.kv, ITEMS, 'admin');
      assertEqual(normalizeDepartmentCode(loaded, 'DEPT_RESP'), 'DEPT_RESP', '是编码就原样通过');
      assertEqual(
        normalizeDepartmentCode(loaded, '呼吸内科'),
        'DEPT_RESP',
        '是名称且能对上字典 → 换成编码（否则老病历上的"限科室"会被无理由拦下）',
      );
      assertEqual(
        normalizeDepartmentCode(loaded, '外科'),
        '外科',
        '对不上就原样返回：猜一个编码会把"字典缺这个科"掩盖成"它属于某个科"',
      );
      assertEqual(normalizeDepartmentCode(loaded, undefined), undefined, '没有科室信息就是没有');
    } finally {
      fixture.cleanup();
    }
  });

  await test('D5 播种标记：播过就记住 —— 删光科室后重启，它不会自己长回来', () => {
    const fixture = openConfigFixture({ prefix: 'l0-dept-' });
    try {
      assertEqual(departmentsSeeded(fixture.kv), false, '没播过');
      markDepartmentsSeeded(fixture.kv);
      assertEqual(departmentsSeeded(fixture.kv), true, '播过就记下来（"我们把科室清了"与"还没建过科室"必须分得开）');
      /* 标记与内容互不影响：清空科室之后标记仍在，于是重启不会再播种 */
      saveDepartments(fixture.kv, [], 'admin');
      assertEqual(loadDepartments(fixture.kv).items.length, 0, '清空就是清空');
      assertEqual(departmentsSeeded(fixture.kv), true, '标记还在（重启不会把科室加回来）');
    } finally {
      fixture.cleanup();
    }
  });

  process.exit(suite.report());
}

void main();
