// 系统策略落库自测（`storage/system-config.ts`）。

import { TestSuite, assert, assertEqual } from '../testing/harness.ts';
import { openConfigFixture, sealedBlobOf, writeCorruptRow } from '../testing/config-fixture.ts';
import {
  DEFAULT_SYSTEM_CONFIG,
  DEMO_ANCHOR_SEED,
  SYSTEM_ANCHOR_SEED_KEY,
  SYSTEM_CONFIG_KEY,
  describeSystemConfig,
  loadSystemConfig,
  saveSystemConfig,
} from './system-config.ts';

const suite = new TestSuite('系统策略落库自测', [
  '说明：鉴权模式 / 会话寿命 / 限流阈值 / 锚定节奏 / 锚点种子原先都是环境变量，现在都在 config.system 一行里。',
  'SY3/SY4 是防回退关键：非法值不许静默取默认，读不出来不许当作"没配过" —— 后者会让 strict 悄悄退回 open。',
]);

const test = (name: string, fn: () => void | Promise<void>): Promise<void> => suite.test(name, fn);
const AT = '2026-10-14T09:00:00.000Z';

function codeOf(fn: () => unknown): string {
  try {
    fn();
    return 'NO_THROW';
  } catch (err) {
    return String((err as { code?: string }).code ?? (err as Error).name);
  }
}

async function main(): Promise<void> {
  await test('SY1 空库 → 默认策略（并且**没有**环境变量这一档）', () => {
    const fixture = openConfigFixture({ prefix: 'l0-system-config-' });
    try {
      const loaded = loadSystemConfig(fixture.kv);
      assertEqual(loaded.source, 'default', '没配过应为默认');
      assertEqual(loaded.config.authMode, 'open', '默认鉴权模式是 open（演示可用；生产必须改）');
      assertEqual(loaded.config.sessionTtlMinutes, DEFAULT_SYSTEM_CONFIG.sessionTtlMinutes, '会话寿命应有默认值');
      assertEqual(loaded.config.anchorEvery, 1, '默认每条都锚（未锚定的尾部那一段被删是检不出来的）');
      assertEqual(loaded.config.rate.loginPerActor, DEFAULT_SYSTEM_CONFIG.rate.loginPerActor, '限流默认值应生效');
      assertEqual(loaded.anchorSeed, DEMO_ANCHOR_SEED, '未配种子时用内置演示种子（与历史锚点验签一致）');
      assertEqual(loaded.anchorSeedConfigured, false, '未配种子 → 界面只能看到"没自定义"');
    } finally {
      fixture.cleanup();
    }
  });

  await test('SY2 保存后可读回，且记下是谁改的（改 authMode 等于"把门打开"）', () => {
    const fixture = openConfigFixture({ prefix: 'l0-system-config-' });
    try {
      const { loaded } = saveSystemConfig(
        fixture.kv,
        { authMode: 'strict', sessionTtlMinutes: 60, anchorEvery: 5, rate: { loginPerActor: 3, loginPerSource: 9, aiPerMinute: 60, exportPerMinute: 7 } },
        'ADMIN',
        { at: AT },
      );
      assertEqual(loaded.source, 'store', '保存后来源应是 store');
      assertEqual(loaded.config.authMode, 'strict', '鉴权模式应生效');
      assertEqual(loaded.config.sessionTtlMinutes, 60, '会话寿命应生效');
      assertEqual(loaded.config.anchorEvery, 5, '锚定节奏应生效');
      assertEqual(loaded.config.rate.exportPerMinute, 7, '限流阈值应生效');
      assertEqual(loaded.updatedBy, 'ADMIN', '应记下是谁改的');
      assertEqual(loaded.updatedAt, AT, '应记下改动时刻');

      /* 库里那一行必须是密封的：同一张表里"有的加密有的明文"是最危险的状态  */
      const blob = sealedBlobOf(fixture, SYSTEM_CONFIG_KEY);
      assert(blob !== null && blob.length > 0, '策略行应当存在');
      assertEqual(blob?.includes('strict'), false, '策略值不得明文躺在库里');

      const view = describeSystemConfig(loadSystemConfig(fixture.kv));
      assertEqual(view.writesRequireSession, true, '视图必须能回答"医生端写病历要不要会话"（这是这一屏最要紧的一句）');
      assertEqual(view.source, 'store', '视图要报来源：改了没生效与根本没配在界面上要分得开');
    } finally {
      fixture.cleanup();
    }
  });

  await test('SY3 非法值一律拒绝（不静默取默认）', () => {
    const fixture = openConfigFixture({ prefix: 'l0-system-config-' });
    try {
      assertEqual(codeOf(() => saveSystemConfig(fixture.kv, { authMode: 'whatever' as never }, 'ADMIN')), 'E_SYSTEM_CONFIG_INVALID', '枚举之外的模式必须拦下');
      assertEqual(codeOf(() => saveSystemConfig(fixture.kv, { sessionTtlMinutes: 0 }, 'ADMIN')), 'E_SYSTEM_CONFIG_INVALID', '会话寿命不能为 0');
      assertEqual(codeOf(() => saveSystemConfig(fixture.kv, { sessionTtlMinutes: 1.5 }, 'ADMIN')), 'E_SYSTEM_CONFIG_INVALID', '会话寿命必须是整数');
      assertEqual(codeOf(() => saveSystemConfig(fixture.kv, { anchorEvery: -1 }, 'ADMIN')), 'E_SYSTEM_CONFIG_INVALID', '锚定节奏不能为负');
      assertEqual(
        codeOf(() => saveSystemConfig(fixture.kv, { rate: { aiPerMinute: 0 } as never }, 'ADMIN')),
        'E_SYSTEM_CONFIG_INVALID',
        '限流阈值不能为 0（等于把那条规则关掉，而关掉是另一件事：应该显式放开上限，不是填 0）',
      );
      assertEqual(loadSystemConfig(fixture.kv).source, 'default', '被拒的保存不得改动库里任何东西');
    } finally {
      fixture.cleanup();
    }
  });

  await test('SY4 种子三态 + **永不回显** + 读不出来不静默', () => {
    const fixture = openConfigFixture({ prefix: 'l0-system-config-' });
    try {
      const set = saveSystemConfig(fixture.kv, { authMode: 'open', anchorSeed: 'anchor-seed-1' }, 'ADMIN', { at: AT });
      assertEqual(set.anchorSeedAction, 'set', '设新值应如实回报动作');
      assertEqual(set.loaded.anchorSeedConfigured, true, '已配置自定义种子');
      const view = describeSystemConfig(set.loaded);
      assertEqual(JSON.stringify(view).includes('anchor-seed-1'), false, '**视图里不得出现种子值**（它是签名私钥的种子）');
      assertEqual(sealedBlobOf(fixture, SYSTEM_ANCHOR_SEED_KEY)?.includes('anchor-seed-1'), false, '种子那一行不得是明文');

      const kept = saveSystemConfig(fixture.kv, { authMode: 'open', anchorEvery: 2 }, 'ADMIN', { at: AT });
      assertEqual(kept.anchorSeedAction, 'unchanged', '没传 anchorSeed 时不得动那一行');
      assertEqual(kept.loaded.anchorSeed, 'anchor-seed-1', '改别的字段不该把种子弄丢');

      const cleared = saveSystemConfig(fixture.kv, { authMode: 'open', anchorSeed: null }, 'ADMIN', { at: AT });
      assertEqual(cleared.anchorSeedAction, 'cleared', '清除应如实回报');
      assertEqual(cleared.loaded.anchorSeed, DEMO_ANCHOR_SEED, '清除后回到内置演示种子');
      assertEqual(sealedBlobOf(fixture, SYSTEM_ANCHOR_SEED_KEY), null, '清除必须是真删行（留着密文等于"我清掉了"是假话）');

      writeCorruptRow(fixture, SYSTEM_CONFIG_KEY);
      assertEqual(codeOf(() => loadSystemConfig(fixture.kv)), 'E_SYSTEM_CONFIG_INVALID', '策略读不出来时不得当作"没配过"（那会让 strict 悄悄退回 open）');
    } finally {
      fixture.cleanup();
    }
  });

  process.exit(suite.report());
}

void main();
