/**
 * 文书类型自测（T1~T5）。
 *
 *   node src/storage/doc-type-store-self-test.ts
 *
 * 守五件事：
 *   T1 三态：没配 = **空**（不编一套默认类型出来）、配了能读回、坏了**抛错**（不当"没配过"）；
 *   T2 校验：**同体系内**编码唯一、显示名非空；**跨体系同码合法**（这条与科室字典刻意不同）；
 *   T3 停用 ≠ 删除：新建时选不到它，但**既有模板与已开出的病历照样显示它的名字**；
 *   T4 体系：缺省为 `local`，不认识的值当场报（它与文档模型的 `docType.system` 是同一套取值）；
 *   T5 播种标记：播过就记住 —— 删光类型后重启，它不会自己长回来。
 */

import { TestSuite, assert, assertEqual } from '../testing/harness.ts';
import { openConfigFixture, writeCorruptRow } from '../testing/config-fixture.ts';
import {
  DOC_TYPE_CONFIG_KEY,
  DOC_TYPE_SYSTEMS,
  docTypeDisplayOf,
  docTypeKeyOf,
  docTypesSeeded,
  describeDocTypes,
  isDocTypeSelectable,
  loadDocTypes,
  markDocTypesSeeded,
  saveDocTypes,
} from './doc-type-store.ts';

const suite = new TestSuite('文书类型自测（主数据：编码判定、名称展示）', [
  '说明：编码与模板 `docType.code`、质控规则的 `docTypeCode` 对齐（判定靠它），显示名只用于展示与选择。',
  'T2 是防回退关键：判重键是「体系 + 编码」—— 退回成"编码唯一"会误杀国标与院内同码的合法配置。',
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
  { system: 'WST500', code: 'WST500.1', display: '入院记录', enabled: true },
  { system: 'WST500', code: 'WST500.3', display: '病程记录', enabled: true },
];

async function main(): Promise<void> {
  await test('T1 三态：没配 = 空（不编默认类型）、配了能读回、**坏了抛错**（不当"没配过"）', () => {
    const fixture = openConfigFixture({ prefix: 'l0-doctype-' });
    try {
      const empty = loadDocTypes(fixture.kv);
      assertEqual(empty.source, 'empty', '没配过就是空');
      assertEqual(empty.items.length, 0, '**不编一套默认类型**：空就是空，界面据此说"先去建类型"');

      const saved = saveDocTypes(fixture.kv, ITEMS, 'admin', { at: '2026-10-16T00:00:00.000Z' });
      assertEqual(saved.source, 'store', '配过之后是 store');
      assertEqual(saved.items.length, 2, '两条都读回');
      assertEqual(saved.updatedBy, 'admin', '改动人记下来（谁把类型改了要答得出来）');

      const reloaded = loadDocTypes(fixture.kv);
      assertEqual(JSON.stringify(reloaded.items), JSON.stringify(saved.items), '往返一致');

      const described = describeDocTypes(reloaded);
      assertEqual(described.enabledCount, 2, '启用数供界面直接显示');
      assertEqual(
        JSON.stringify(described.systems),
        JSON.stringify([...DOC_TYPE_SYSTEMS]),
        '体系白名单随视图下发：界面的下拉与后端校验取同一处，不各写一份',
      );

      /* 坏行：口令换过 / 有人改过那一行。**必须抛错**，不能当作"没配过" ——
         当成没配过会让所有按类型定位的质控规则静默不判，而没人知道。 */
      writeCorruptRow(fixture, DOC_TYPE_CONFIG_KEY);
      assertEqual(codeOf(() => loadDocTypes(fixture.kv)), 'E_DOC_TYPE_INVALID', '解不开必须报，不许静默降级');
    } finally {
      fixture.cleanup();
    }
  });

  await test('T2 校验：同体系内编码唯一、显示名非空 —— 但**跨体系同码是合法的**', () => {
    const fixture = openConfigFixture({ prefix: 'l0-doctype-' });
    try {
      assertEqual(
        codeOf(() => saveDocTypes(fixture.kv, { items: [] }, 'admin')),
        'E_DOC_TYPE_INVALID',
        '清单必须是数组（对象形状不对要当场报）',
      );
      assertEqual(
        codeOf(() => saveDocTypes(fixture.kv, [{ system: 'local', display: '甲' }], 'admin')),
        'E_DOC_TYPE_INVALID',
        '缺编码要报：规则按它定位文书',
      );
      assertEqual(
        codeOf(() => saveDocTypes(fixture.kv, [{ system: 'local', code: 'A01' }], 'admin')),
        'E_DOC_TYPE_INVALID',
        '缺显示名要报：界面上显示的是它',
      );
      assertEqual(
        codeOf(() => saveDocTypes(fixture.kv, [{ system: 'local', code: 'A01', display: '甲', enabled: 'yes' }], 'admin')),
        'E_DOC_TYPE_INVALID',
        '启用状态只能是布尔（"yes" 这种真值在界面上会显示成没勾）',
      );
      assertEqual(
        codeOf(() => saveDocTypes(
          fixture.kv,
          [{ system: 'WST500', code: 'A01', display: '甲' }, { system: 'WST500', code: 'A01', display: '乙' }],
          'admin',
        )),
        'E_DOC_TYPE_INVALID',
        '同一体系内编码重复要报：重复时"这条规则盯的是哪一类文书"就没有确定答案',
      );

      /* **本字典与科室字典的关键差别**：判重键是 `system/code`。
         国标 `WST500/A01` 与院内 `local/A01` 是两个东西，共存是合法配置 ——
         照抄科室那条"编码唯一"会把它误判成重复，而那正是最需要支持的场景。 */
      const both = saveDocTypes(
        fixture.kv,
        [{ system: 'WST500', code: 'A01', display: '国标甲' }, { system: 'local', code: 'A01', display: '院内甲' }],
        'admin',
      );
      assertEqual(both.items.length, 2, '跨体系同码应能并存');
      assertEqual(docTypeKeyOf(both.items[0]!), 'WST500/A01', '判重键的写法只有一处（`docTypeKeyOf`）');
      assertEqual(docTypeKeyOf(both.items[1]!), 'local/A01', '另一个键虽然编码相同，但体系不同');

      /* 空清单是合法输入（= 清空），不是错误：清空之后 source 回到 store 的空清单 */
      const cleared = saveDocTypes(fixture.kv, [], 'admin');
      assertEqual(cleared.source, 'store', '清空是一次**写入**（不是"没配过"）：谁清的要留在记录里');
      assertEqual(cleared.items.length, 0, '清空之后没有任何类型');
    } finally {
      fixture.cleanup();
    }
  });

  await test('T3 停用 ≠ 删除：新建时选不到它，但**既有内容照样显示它的名字**', () => {
    const fixture = openConfigFixture({ prefix: 'l0-doctype-' });
    try {
      const loaded = saveDocTypes(
        fixture.kv,
        [
          { system: 'WST500', code: 'WST500.1', display: '入院记录' },
          { system: 'WST500', code: 'WST500.4', display: '出院记录', enabled: false },
        ],
        'admin',
      );
      assertEqual(isDocTypeSelectable(loaded, 'WST500', 'WST500.4'), false, '停用的类型不能再被新建的文书选中');
      assertEqual(isDocTypeSelectable(loaded, 'WST500', 'WST500.9'), false, '不存在的编码当然也选不到');
      assertEqual(isDocTypeSelectable(loaded, 'WST500', 'WST500.1'), true, '启用中的照旧可选');
      /* 体系也要一起比：编码对但体系不对，是另一个东西 */
      assertEqual(isDocTypeSelectable(loaded, 'local', 'WST500.1'), false, '体系不匹配不算选得到');
      assertEqual(
        docTypeDisplayOf(loaded, 'WST500', 'WST500.4'),
        '出院记录',
        '停用的类型仍然要能翻译出显示名 —— 已经配了它的模板、已经开出的病历都还要显示"出院记录"',
      );
      assertEqual(
        docTypeDisplayOf(loaded, 'WST500', 'WST500.9'),
        undefined,
        '字典里没有就返回 undefined，**不拿编码冒充名称**',
      );
    } finally {
      fixture.cleanup();
    }
  });

  await test('T4 体系：缺省为 local，不认识的值当场报（它与文档模型的 docType.system 是同一套取值）', () => {
    const fixture = openConfigFixture({ prefix: 'l0-doctype-' });
    try {
      const loaded = saveDocTypes(fixture.kv, [{ code: 'A01', display: '院内甲' }], 'admin');
      assertEqual(loaded.items[0]?.system, 'local', '不给体系时按 local 兜底（缺省只写在这一处）');
      assertEqual(
        codeOf(() => saveDocTypes(fixture.kv, [{ system: 'HL7', code: 'A01', display: '甲' }], 'admin')),
        'E_DOC_TYPE_INVALID',
        '不认识的体系要报：它写不进文档模型的 docType.system，存下来只会在导出时炸',
      );
      assert(DOC_TYPE_SYSTEMS.includes('WST500') && DOC_TYPE_SYSTEMS.includes('custom'), '白名单里要有国标与自定义两档');
    } finally {
      fixture.cleanup();
    }
  });

  await test('T5 播种标记：播过就记住 —— 删光类型后重启，它不会自己长回来', () => {
    const fixture = openConfigFixture({ prefix: 'l0-doctype-' });
    try {
      assertEqual(docTypesSeeded(fixture.kv), false, '没播过');
      markDocTypesSeeded(fixture.kv);
      assertEqual(docTypesSeeded(fixture.kv), true, '播过就记下来（"我们把类型清了"与"还没建过类型"必须分得开）');
      /* 标记与内容互不影响：清空类型之后标记仍在，于是重启不会再播种 */
      saveDocTypes(fixture.kv, [], 'admin');
      assertEqual(loadDocTypes(fixture.kv).items.length, 0, '清空就是清空');
      assertEqual(docTypesSeeded(fixture.kv), true, '标记还在（重启不会把类型加回来）');
    } finally {
      fixture.cleanup();
    }
  });

  process.exit(suite.report());
}

void main();
