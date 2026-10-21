import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TestSuite, assert, assertEqual } from '../testing/harness.ts';
import { FIXTURE_PASSPHRASE, openConfigFixture, writeCorruptRow, sealedBlobOf } from '../testing/config-fixture.ts';
import { MODEL_CONFIG_FILE, MODEL_CONFIG_KEY, MODEL_KEY_FILE, MODEL_KEY_KEY } from '../ai/model-config-store.ts';
import { encryptEnvelope } from '../crypto/envelope.ts';
import { PLACEMENT_CONFIG_FILE, PLACEMENT_CONFIG_KEY } from '../dictation/placement-store.ts';
import { SIGN_CONFIG_FILE } from '../sign/sign-config-store.ts';
import {
  LEGACY_CONFIG_LEDGER_ID,
  importLegacyConfigOnce,
  planLegacyConfigImport,
  runLegacyConfigImport,
} from './config-files-import.ts';

const suite = new TestSuite('部署参数键值层与旧文件搬家自测', [
  '说明：四类部署参数（模型/落位/签名/授权源）落 sealed_kv；旧文件由一次性搬家导入并记账。',
  'K6 是重点：清除掉的密钥**不许**被还在状态目录里的旧文件导回来。',
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

/** 旧格式的模型配置（`version: 1`） */
const legacyModelConfig = (model = 'qwen-med-7b'): string =>
  JSON.stringify({
    version: 1,
    format: 'openai-compatible',
    model,
    endpoint: 'http://127.0.0.1:11434/v1',
    timeoutMs: 5000,
    maxItems: 8,
    apiKeyStored: true,
    updatedAt: '2026-10-01T00:00:00.000Z',
    updatedBy: 'old-admin',
  });

async function main(): Promise<void> {
  await test('K1 三态：没有 = null；有 = 读回；**解不开 = 抛错**（绝不当作"没有"）', () => {
    const fixture = openConfigFixture({ prefix: 'l0-kv-' });
    try {
      assertEqual(fixture.kv.read(MODEL_CONFIG_KEY), null, '没写过 → null');
      fixture.kv.write(MODEL_CONFIG_KEY, { version: 1, model: 'm' });
      assertEqual(fixture.kv.read<{ model: string }>(MODEL_CONFIG_KEY)?.model, 'm', '写过应能读回');
      assertEqual(fixture.kv.has(MODEL_CONFIG_KEY), true, 'has 只看行在不在');

      writeCorruptRow(fixture, MODEL_KEY_KEY);
      const code = codeOf(() => fixture.kv.read(MODEL_KEY_KEY));
      assert(code !== 'OK' && code !== 'null', `解不开必须抛错，实际：${code}`);
      assertEqual(fixture.kv.has(MODEL_KEY_KEY), true, '**has 仍然为真**：行在，只是读不出来（这正是"不许覆盖"的依据）');
    } finally {
      fixture.cleanup();
    }
  });

  await test('K2 一律密封：库里搜不到明文，且摘要存的是**密文**的摘要', () => {
    const fixture = openConfigFixture({ prefix: 'l0-kv-' });
    try {
      fixture.kv.write(MODEL_CONFIG_KEY, { endpoint: 'http://127.0.0.1:11434/v1', apiKey: 'secret-key-1' });
      const blob = sealedBlobOf(fixture, MODEL_CONFIG_KEY);
      assert(blob !== null && blob.length > 0, '应当有那一行');
      assertEqual(blob?.includes('secret-key-1'), false, '明文不得落库');
      assertEqual(blob?.includes('11434'), false, '地址也不以明文躺着（同一张表不做两种待遇）');
      assert(JSON.parse(String(blob))?.header !== undefined, '存的应当是信封（有 header）');

      const row = fixture.workStore.getSealed<{ apiKey: string }>(MODEL_CONFIG_KEY);
      assertEqual(row.ok && row.found && row.data.apiKey, 'secret-key-1', '读回经密封层仍然正确');
    } finally {
      fixture.cleanup();
    }
  });

  await test('K3 清掉是**真删行**：不留空壳（"我清掉了"必须与库里一致）', () => {
    const fixture = openConfigFixture({ prefix: 'l0-kv-' });
    try {
      fixture.kv.write(MODEL_KEY_KEY, 'secret-key-1');
      assertEqual(fixture.kv.has(MODEL_KEY_KEY), true, '前置：写进去了');
      fixture.kv.remove(MODEL_KEY_KEY);
      assertEqual(fixture.kv.has(MODEL_KEY_KEY), false, 'remove 之后行必须没了');
      assertEqual(sealedBlobOf(fixture, MODEL_KEY_KEY), null, '库里不该留下空壳');
      assertEqual(fixture.kv.read(MODEL_KEY_KEY), null, '读回来是"没有"，而不是"解不开"');
    } finally {
      fixture.cleanup();
    }
  });

  await test('K4 搬家：旧文件进库、**旧文件保留**、并记账', () => {
    const fixture = openConfigFixture({ prefix: 'l0-kv-' });
    try {
      /* 三份旧文件：模型配置、模型密钥（旧格式的密封信封）、落位配置 */
      writeFileSync(join(fixture.dir, MODEL_CONFIG_FILE), legacyModelConfig(), 'utf8');
      writeFileSync(
        join(fixture.dir, MODEL_KEY_FILE),
        JSON.stringify(encryptEnvelope(new TextEncoder().encode('old-secret'), { passphrase: FIXTURE_PASSPHRASE, iterations: 1000 })),
        'utf8',
      );
      writeFileSync(
        join(fixture.dir, PLACEMENT_CONFIG_FILE),
        JSON.stringify({ version: 1, strategy: 'ordered', candidate: { onlyTextNodes: true }, confidenceCeiling: 0.8, updatedAt: 'x', updatedBy: 'old' }),
        'utf8',
      );

      const result = importLegacyConfigOnce({
        workStore: fixture.workStore,
        kv: fixture.kv,
        dir: fixture.dir,
        passphrase: FIXTURE_PASSPHRASE,
      });
      assertEqual(result.failed, [], `搬家不该失败：${JSON.stringify(result.failed)}`);
      assertEqual(result.imported.length, 3, '三份都应搬进来');
      assertEqual(fixture.workStore.ledgerHas(LEGACY_CONFIG_LEDGER_ID), true, '有东西搬进来 → 必须记账');
      assertEqual(fixture.kv.read<{ model: string }>(MODEL_CONFIG_KEY)?.model, 'qwen-med-7b', '内容要搬对');
      assertEqual(fixture.kv.read(MODEL_KEY_KEY), 'old-secret', '旧密钥应能被解出并搬进来（解不开就不搬，见 K8）');
      assertEqual(fixture.kv.read<{ confidenceCeiling: number }>(PLACEMENT_CONFIG_KEY)?.confidenceCeiling, 0.8, '落位配置也要搬');

      assertEqual(planLegacyConfigImport(fixture.kv, fixture.dir).items.length, 0, '搬完之后"待搬"应为空');
      assertEqual(planLegacyConfigImport(fixture.kv, fixture.dir).skipped.length, 3, '三份都应记为"库里已有"（文件仍在原处）');
    } finally {
      fixture.cleanup();
    }
  });

  await test('K5 库里已有的**不覆盖**（哪怕那一行解不开）', () => {
    const fixture = openConfigFixture({ prefix: 'l0-kv-' });
    try {
      fixture.kv.write(MODEL_CONFIG_KEY, { version: 1, model: '库里已有的这一份' });
      writeCorruptRow(fixture, PLACEMENT_CONFIG_KEY);
      writeFileSync(join(fixture.dir, MODEL_CONFIG_FILE), legacyModelConfig('旧文件里的那一份'), 'utf8');
      writeFileSync(join(fixture.dir, PLACEMENT_CONFIG_FILE), JSON.stringify({ version: 1, strategy: 'ordered' }), 'utf8');

      const plan = planLegacyConfigImport(fixture.kv, fixture.dir);
      assertEqual(plan.needed, false, '两份都已在库里 → 不需要搬');
      assertEqual(plan.items, [], '一项都不该搬');
      assertEqual(plan.skipped.length, 2, '两份都要报成"跳过"');
      const result = runLegacyConfigImport(plan, { kv: fixture.kv, passphrase: FIXTURE_PASSPHRASE });
      assertEqual(result.imported, [], '一条都不该写');
      assertEqual(
        fixture.kv.read<{ model: string }>(MODEL_CONFIG_KEY)?.model,
        '库里已有的这一份',
        '库里那份**原封不动**（旧文件不得覆盖它）',
      );
      assertEqual(codeOf(() => fixture.kv.read(PLACEMENT_CONFIG_KEY)) === 'null', false, '解不开的那一行仍然在（没被"没有"处理掉）');
    } finally {
      fixture.cleanup();
    }
  });

  await test('K6 **记了账就不再碰旧文件**：清除掉的密钥不许被旧文件复活', () => {
    const fixture = openConfigFixture({ prefix: 'l0-kv-' });
    try {
      writeFileSync(join(fixture.dir, MODEL_CONFIG_FILE), legacyModelConfig(), 'utf8');
      writeFileSync(
        join(fixture.dir, MODEL_KEY_FILE),
        JSON.stringify(encryptEnvelope(new TextEncoder().encode('old-secret'), { passphrase: FIXTURE_PASSPHRASE, iterations: 1000 })),
        'utf8',
      );
      const first = importLegacyConfigOnce({
        workStore: fixture.workStore,
        kv: fixture.kv,
        dir: fixture.dir,
        passphrase: FIXTURE_PASSPHRASE,
      });
      assertEqual(first.imported.length, 2, '前置：两份搬进来了');
      assertEqual(fixture.kv.read(MODEL_KEY_KEY), 'old-secret', '前置：密钥在库里');

      fixture.kv.remove(MODEL_KEY_KEY);
      assertEqual(fixture.kv.read(MODEL_KEY_KEY), null, '前置：已清除');

      const second = importLegacyConfigOnce({
        workStore: fixture.workStore,
        kv: fixture.kv,
        dir: fixture.dir,
        passphrase: FIXTURE_PASSPHRASE,
      });
      assertEqual(second.ran, false, '记了账 → 这次不看旧文件');
      assertEqual(second.imported, [], '什么都不该搬');
      assertEqual(fixture.kv.read(MODEL_KEY_KEY), null, '**清除掉的密钥不许被旧文件复活**（这条是记账的全部理由）');
    } finally {
      fixture.cleanup();
    }
  });

  await test('K7 没有旧文件 → **不记账**（以后放进来的旧文件仍然该被搬一次）', () => {
    const fixture = openConfigFixture({ prefix: 'l0-kv-' });
    try {
      const first = importLegacyConfigOnce({
        workStore: fixture.workStore,
        kv: fixture.kv,
        dir: fixture.dir,
        passphrase: FIXTURE_PASSPHRASE,
      });
      assertEqual(first.imported, [], '没有旧文件，什么都不搬');
      assertEqual(fixture.workStore.ledgerHas(LEGACY_CONFIG_LEDGER_ID), false, '没搬东西就不该记账 —— 记早了会把"以后放进来"这条路堵死');

      writeFileSync(join(fixture.dir, MODEL_CONFIG_FILE), legacyModelConfig(), 'utf8');
      const second = importLegacyConfigOnce({
        workStore: fixture.workStore,
        kv: fixture.kv,
        dir: fixture.dir,
        passphrase: FIXTURE_PASSPHRASE,
      });
      assertEqual(second.imported.length, 1, '后放进来的旧文件应被搬一次');
      assertEqual(fixture.workStore.ledgerHas(LEGACY_CONFIG_LEDGER_ID), true, '真搬了才记账');
    } finally {
      fixture.cleanup();
    }
  });

  await test('K8 旧密钥解不开（口令不同）→ 如实失败、**不记账**（下次还得再试）', () => {
    const fixture = openConfigFixture({ prefix: 'l0-kv-' });
    try {
      writeFileSync(join(fixture.dir, MODEL_CONFIG_FILE), legacyModelConfig(), 'utf8');
      writeFileSync(
        join(fixture.dir, MODEL_KEY_FILE),
        JSON.stringify(encryptEnvelope(new TextEncoder().encode('old-secret'), { passphrase: '另一个口令', iterations: 1000 })),
        'utf8',
      );

      const result = importLegacyConfigOnce({
        workStore: fixture.workStore,
        kv: fixture.kv,
        dir: fixture.dir,
        passphrase: FIXTURE_PASSPHRASE,
      });
      assertEqual(result.failed.length, 1, '解不开的那一份要如实报出来（不能导个空值进去）');
      assert(String(result.failed[0]?.message).includes('解不开'), `理由要说清是解不开，实际：${result.failed[0]?.message}`);
      assertEqual(result.imported.length, 1, '能搬的那一份仍然要搬（四份之间没有依赖）');
      assertEqual(
        fixture.workStore.ledgerHas(LEGACY_CONFIG_LEDGER_ID),
        false,
        '**有失败就不记账** —— 记了账，那份就永远搬不过来（口令修好之后再启动也没机会了）',
      );
      assertEqual(fixture.kv.read(MODEL_KEY_KEY), null, '解不开的密钥不该被"导个空值"顶替');
    } finally {
      fixture.cleanup();
    }
  });

  process.exit(suite.report());
}

void main();
