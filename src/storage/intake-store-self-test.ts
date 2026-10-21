import { TestSuite, assert, assertEqual } from '../testing/harness.ts';
import { openConfigFixture } from '../testing/config-fixture.ts';
import {
  BUILTIN_CONTEXT_FIELDS,
  describeContextFields,
  loadContextFields,
  saveContextFields,
} from './context-field-store.ts';
import {
  checkIntakeAccess,
  describeIntake,
  loadIntakeConfig,
  saveIntakeConfig,
  templateRefKey,
} from './intake-store.ts';

const suite = new TestSuite('字段字典与外部带入配置自测', [
  '说明：字段字典决定模板「从系统带入」能选哪些路径；外部带入配置决定写入接口开不开、认不认密钥。',
  '两条底线：空库不编外部字段；describeIntake 永不下发密钥哈希。',
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

const KEY = 'intake-secret-0123456789abcdef';

async function main(): Promise<void> {
  await test('C1 字段字典：空库回内置 12 个，保存后以库为准；停用不丢，仍可翻译显示名', () => {
    const fixture = openConfigFixture({ prefix: 'l0-ctxfield-' });
    try {
      const builtin = loadContextFields(fixture.kv);
      assertEqual(builtin.source, 'builtin', '没配过时按内置字段兜底');
      assertEqual(builtin.items.length, BUILTIN_CONTEXT_FIELDS.length, '内置字段一个不少');
      assert(builtin.items.some((item) => item.path === 'patient.nameMasked'), '内置里有患者姓名');

      const saved = saveContextFields(
        fixture.kv,
        [
          { path: 'patient.nameMasked', label: '姓名', group: '患者', source: '本机' },
          { path: 'his.insuranceNo', label: '医保号', group: '患者', source: 'HIS' },
          { path: 'lis.crp', label: 'C 反应蛋白', group: '检验', source: 'LIS', enabled: false },
        ],
        'admin',
        { at: '2026-10-21T00:00:00.000Z' },
      );
      assertEqual(saved.source, 'store', '保存之后来源是库');
      assertEqual(describeContextFields(saved).enabledCount, 2, '停用的不计入启用数');
      assertEqual(
        saved.items.find((item) => item.path === 'lis.crp')?.label,
        'C 反应蛋白',
        '停用的字段仍要保留显示名：既有模板还在引用它',
      );
    } finally {
      fixture.cleanup();
    }
  });

  await test('C2 字段字典：非法路径与重复路径当场报（写错路径会让那一格永远空着）', () => {
    const fixture = openConfigFixture({ prefix: 'l0-ctxfield-' });
    try {
      assertEqual(
        codeOf(() => saveContextFields(fixture.kv, [{ path: '患者.姓名', label: '甲', group: '患者', source: 'HIS' }], 'admin')),
        'E_CONTEXT_FIELD_INVALID',
        '路径只收字母开头的点分路径',
      );
      assertEqual(
        codeOf(() => saveContextFields(fixture.kv, [
          { path: 'his.a', label: '甲', group: '患者', source: 'HIS' },
          { path: 'his.a', label: '乙', group: '患者', source: 'HIS' },
        ], 'admin')),
        'E_CONTEXT_FIELD_INVALID',
        '同一路径出现两次要拒：同步程序按它对位',
      );
      assertEqual(
        codeOf(() => saveContextFields(fixture.kv, [{ path: 'his.a', label: '', group: '患者', source: 'HIS' }], 'admin')),
        'E_CONTEXT_FIELD_INVALID',
        '缺显示名要拒',
      );
    } finally {
      fixture.cleanup();
    }
  });

  await test('C3 外部带入：未配置 → 开启未设密钥 → 设密钥后认密钥；关闭即一律拒', () => {
    const fixture = openConfigFixture({ prefix: 'l0-intake-' });
    try {
      assertEqual(loadIntakeConfig(fixture.kv), null, '没配过就是 null');
      assertEqual(checkIntakeAccess(null, '').ok, false, '未配置时写入一律拒');
      assertEqual((checkIntakeAccess(null, '') as { code: string }).code, 'E_INTAKE_DISABLED', '未配置按"未开启"报');

      saveIntakeConfig(fixture.kv, { enabled: true, requireKey: true }, 'admin', '2026-10-21T00:00:00.000Z');
      assertEqual(
        (checkIntakeAccess(loadIntakeConfig(fixture.kv), KEY) as { code: string }).code,
        'E_INTAKE_KEY_MISSING',
        '要求校验但没密钥：一律拒（不是"没开"）',
      );

      const { record, keyAction } = saveIntakeConfig(fixture.kv, { key: KEY }, 'admin', '2026-10-21T00:01:00.000Z');
      assertEqual(keyAction, 'set', '设密钥记成 set');
      assertEqual(checkIntakeAccess(record, KEY).ok, true, '正确密钥放行');
      assertEqual((checkIntakeAccess(record, '') as { code: string }).code, 'E_INTAKE_KEY_REQUIRED', '缺请求头要单独报');
      assertEqual((checkIntakeAccess(record, 'wrong-key') as { code: string }).code, 'E_INTAKE_KEY_BAD', '密钥不对要报');

      const desc = describeIntake(record);
      assert(!('keyHash' in desc), '描述里不得出现密钥哈希');
      assertEqual(desc.keyPresent, true, '只说"有没有"，不说是什么');

      const open = saveIntakeConfig(fixture.kv, { requireKey: false }, 'admin', '2026-10-21T00:02:00.000Z');
      assertEqual(checkIntakeAccess(open.record, '').ok, true, '显式关掉校验后不认密钥也放行（管理员的选择）');

      const off = saveIntakeConfig(fixture.kv, { enabled: false }, 'admin', '2026-10-21T00:03:00.000Z');
      assertEqual((checkIntakeAccess(off.record, KEY) as { code: string }).code, 'E_INTAKE_DISABLED', '总开关关掉后连正确密钥也拒');
    } finally {
      fixture.cleanup();
    }
  });

  await test('C4 外部带入：模板白名单去重、缺字段当场拒；清除密钥可回读为"已清除"', () => {
    const fixture = openConfigFixture({ prefix: 'l0-intake-' });
    try {
      const { record } = saveIntakeConfig(
        fixture.kv,
        {
          enabled: true,
          key: KEY,
          templates: [
            { packId: 'doc.template.custom', itemId: 't.a' },
            { packId: 'doc.template.custom', itemId: 't.a' },
            { packId: 'doc.template.builtin', itemId: 't.b' },
          ],
        },
        'admin',
        '2026-10-21T00:00:00.000Z',
      );
      assertEqual(record.templates.length, 2, '同 packId + itemId 只留一条');
      assertEqual(templateRefKey(record.templates[0]), 'doc.template.custom#t.a', '白名单键就是"包 + 条目"');

      assertEqual(
        codeOf(() => saveIntakeConfig(fixture.kv, { templates: [{ packId: '', itemId: 't.a' }] }, 'admin', '2026-10-21T00:00:00.000Z')),
        'E_INTAKE_INVALID',
        '缺 packId 要拒',
      );

      const cleared = saveIntakeConfig(fixture.kv, { key: null }, 'admin', '2026-10-21T00:04:00.000Z');
      assertEqual(cleared.keyAction, 'cleared', '清除记成 cleared');
      assertEqual(describeIntake(cleared.record).keyPresent, false, '清掉之后不再算有密钥');
    } finally {
      fixture.cleanup();
    }
  });

  process.exit(suite.report());
}

void main();
