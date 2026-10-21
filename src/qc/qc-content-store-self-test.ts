import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TestSuite, assert, assertEqual } from '../testing/harness.ts';
import { openConfigFixture, sealedBlobOf, writeCorruptRow } from '../testing/config-fixture.ts';
import {
  QC_CONTENT_ENGINE_KEY,
  QC_CONTENT_RULES_KEY,
  QC_CONTENT_TOKEN_KEY,
  QC_RULES_LEDGER_ID,
  describeQcContentConfig,
  importQcRulesOnce,
  loadQcContentConfig,
  saveQcContentConfig,
} from './qc-content-store.ts';

const suite = new TestSuite('内涵质控配置落库自测', [
  '说明：规则清单与引擎原先靠 `L0_QC_CONTENT_*` 环境变量给，现在都在 `config.qc-content.*` 三行里。',
  'QC3/QC4/QC5 是防回退关键：形态配错必须拒、坏规则必须报出来、清空后不许被旧文件导回来。',
]);

const test = (name: string, fn: () => void | Promise<void>): Promise<void> => suite.test(name, fn);
const AT = '2026-10-14T09:00:00.000Z';

const fsx = (await import('node:fs')) as unknown as { mkdtempSync: (prefix: string) => string };
const TEMP = process.env.TEMP ?? process.env.TMP ?? '.';
const ROOT = fsx.mkdtempSync(join(TEMP, 'l0-qc-content-'));
const rmRecursive = rmSync as unknown as (path: string, options: { recursive?: boolean; force?: boolean }) => void;

const GOOD_RULE = { ruleId: 'r-1', title: '缺记录时间', severity: 'warn', requirement: '病程记录应含记录时间' };
const BAD_RULE = { ruleId: 'r-2', title: '越界字段', severity: 'warn', requirement: 'x', extra: '不允许的字段' };

function codeOf(fn: () => unknown): string {
  try {
    fn();
    return 'NO_THROW';
  } catch (err) {
    return String((err as { code?: string }).code ?? (err as Error).name);
  }
}

async function main(): Promise<void> {
  await test('QC1 空库 = 引擎未接入 + 无规则（空是合法状态）', () => {
    const fixture = openConfigFixture({ prefix: 'l0-qc-content-' });
    try {
      const loaded = loadQcContentConfig(fixture.kv);
      assertEqual(loaded.source, 'default', '没配过应为默认');
      assertEqual(loaded.engine.kind, 'none', '默认不接引擎（不假装跑过）');
      assertEqual(loaded.rules.length, 0, '默认没有规则（本程序一条都不发明）');
      assertEqual(loaded.rulesProblem, null, '空清单不是"有问题"');
      assertEqual(loaded.tokenPresent, false, '没有凭据');
    } finally {
      fixture.cleanup();
    }
  });

  await test('QC2 引擎与凭据入库：地址可读回、凭据单独一行且**永不回显**', () => {
    const fixture = openConfigFixture({ prefix: 'l0-qc-content-' });
    try {
      const saved = saveQcContentConfig(
        fixture.kv,
        { engine: { kind: 'http', url: 'http://127.0.0.1:9200/qc', expectEngineId: 'qc-engine-1' }, token: 'qc-secret-1', rules: [GOOD_RULE] },
        'ADMIN',
        { at: AT },
      );
      assertEqual(saved.tokenAction, 'set', '凭据动作应如实回报');
      assertEqual(saved.loaded.engine.kind, 'http', '形态应生效');
      assertEqual(saved.loaded.engine.url, 'http://127.0.0.1:9200/qc', '地址应生效');
      assertEqual(saved.loaded.engine.expectEngineId, 'qc-engine-1', '期望引擎标识应生效');
      assertEqual(saved.loaded.token, 'qc-secret-1', '口令对时应能解出凭据（供外呼使用）');
      assertEqual(saved.loaded.rules.length, 1, '规则应入库');
      assertEqual(saved.loaded.rules[0]?.ruleId, 'r-1', '规则内容应往返一致');

      const view = describeQcContentConfig(saved.loaded);
      assertEqual(JSON.stringify(view).includes('qc-secret-1'), false, '**视图里不得出现凭据值**');
      assertEqual(view.tokenPresent, true, '只报"是否就位"');
      assertEqual(sealedBlobOf(fixture, QC_CONTENT_TOKEN_KEY)?.includes('qc-secret-1'), false, '凭据那一行不得是明文');
      assertEqual(sealedBlobOf(fixture, QC_CONTENT_ENGINE_KEY)?.includes('127.0.0.1:9200'), false, '一律密封：地址也不以明文躺在库里');
    } finally {
      fixture.cleanup();
    }
  });

  await test('QC3 形态校验 fail-closed：http 缺地址拒、model 不接受第二个地址', () => {
    const fixture = openConfigFixture({ prefix: 'l0-qc-content-' });
    try {
      assertEqual(
        codeOf(() => saveQcContentConfig(fixture.kv, { engine: { kind: 'http' } }, 'ADMIN')),
        'E_QC_CONFIG_NO_URL',
        '选了 http 却没地址 → 拒绝（存下去每次质控只会报调用失败）',
      );
      assertEqual(
        codeOf(() => saveQcContentConfig(fixture.kv, { engine: { kind: 'model', url: 'http://x/v1' } }, 'ADMIN')),
        'E_QC_CONFIG_INVALID',
        'model 形态用的是「能力配置」里那一个模型，不该再存第二个地址（那会有两处"病历发往哪儿"的答案）',
      );
      assertEqual(
        codeOf(() => saveQcContentConfig(fixture.kv, { engine: { kind: 'whatever' as never } }, 'ADMIN')),
        'E_QC_CONFIG_INVALID',
        '形态枚举之外必须拦下',
      );
      assertEqual(loadQcContentConfig(fixture.kv).source, 'default', '被拒的保存不得改动库里任何东西');
    } finally {
      fixture.cleanup();
    }
  });

  await test('QC4 规则清单逐条校验：坏的那条报出来，好的照常用', () => {
    const fixture = openConfigFixture({ prefix: 'l0-qc-content-' });
    try {
      const saved = saveQcContentConfig(fixture.kv, { engine: { kind: 'none' }, rules: [GOOD_RULE, BAD_RULE, { ruleId: 'r-3' }] }, 'ADMIN', { at: AT });
      assertEqual(saved.loaded.rules.length, 1, '只有合法的那条可用（其余不能被"整份拒绝"牵连）');
      assertEqual(saved.rulesRejected.length, 2, '被丢弃的必须**逐条报出来**（静默丢等于替它美化）');
      assert(
        saved.rulesRejected.some((item) => item.message.includes('契约之外的字段')),
        '丢弃原因要说清是什么：界面上要能直接照着改',
      );
      const reloaded = loadQcContentConfig(fixture.kv);
      assertEqual(reloaded.rules.length, 1, '重新读回来的可用条数一致');
      assertEqual(reloaded.rulesRejected.length, 2, '重新读也要报同一批丢弃（口径只有一处）');

      assertEqual(
        codeOf(() => saveQcContentConfig(fixture.kv, { engine: { kind: 'none' }, rules: { ruleId: 'x' } as never }, 'ADMIN')),
        'E_QC_CONFIG_INVALID',
        '规则清单必须是 JSON 数组',
      );
      assertEqual(sealedBlobOf(fixture, QC_CONTENT_RULES_KEY) !== null, true, '规则那一行应存在（整块密封）');
    } finally {
      fixture.cleanup();
    }
  });

  await test('QC5 凭据三态 + 读不出来不静默', () => {
    const fixture = openConfigFixture({ prefix: 'l0-qc-content-' });
    try {
      saveQcContentConfig(fixture.kv, { engine: { kind: 'http', url: 'http://127.0.0.1:9200/qc' }, token: 'qc-secret-2' }, 'ADMIN', { at: AT });
      const kept = saveQcContentConfig(fixture.kv, { engine: { kind: 'http', url: 'http://127.0.0.1:9201/qc' } }, 'ADMIN', { at: AT });
      assertEqual(kept.tokenAction, 'unchanged', '没传 token 时不得动凭据（否则改地址会顺手清掉凭据）');
      assertEqual(kept.loaded.token, 'qc-secret-2', '凭据仍在');
      const cleared = saveQcContentConfig(fixture.kv, { engine: { kind: 'http', url: 'http://127.0.0.1:9201/qc' }, token: null }, 'ADMIN', { at: AT });
      assertEqual(cleared.tokenAction, 'cleared', '显式 null 应清除');
      assertEqual(sealedBlobOf(fixture, QC_CONTENT_TOKEN_KEY), null, '清除必须是真删那一行');

      writeCorruptRow(fixture, QC_CONTENT_ENGINE_KEY);
      assertEqual(codeOf(() => loadQcContentConfig(fixture.kv)), 'E_QC_CONFIG_INVALID', '引擎配置读不出来时不得当作"未接入"');
    } finally {
      fixture.cleanup();
    }
  });

  await test('QC6 旧规则文件一次性搬运：带记账闸门（清空后不会被导回来）', () => {
    const fixture = openConfigFixture({ prefix: 'l0-qc-content-' });
    try {
      const file = join(ROOT, 'rules.json');
      writeFileSync(file, `${JSON.stringify([GOOD_RULE, BAD_RULE])}\n`, 'utf8');

      const first = importQcRulesOnce({ workStore: fixture.workStore, kv: fixture.kv, file, at: AT });
      assertEqual(first.imported, 1, '应导入合法的那条');
      assertEqual(fixture.workStore.ledgerHas(QC_RULES_LEDGER_ID), true, '导入成功必须记账（否则每次启动都会重演）');

      const again = importQcRulesOnce({ workStore: fixture.workStore, kv: fixture.kv, file, at: AT });
      assertEqual(again.ran, false, '记了账就不再碰旧文件');
      assertEqual(again.imported, 0, '第二次不该再导入');

      const cleared = saveQcContentConfig(fixture.kv, { engine: { kind: 'none' }, rules: [] }, 'ADMIN', { at: AT });
      assertEqual(cleared.loaded.rules.length, 0, '前置：规则已清空');
      const after = importQcRulesOnce({ workStore: fixture.workStore, kv: fixture.kv, file, at: AT });
      assertEqual(after.ran, false, '清空之后再启动，旧文件仍不该被读');
      assertEqual(loadQcContentConfig(fixture.kv).rules.length, 0, '规则必须保持空（被导回来就是"我清掉的东西自己长回来了"）');

      const fresh = openConfigFixture({ prefix: 'l0-qc-content-' });
      try {
        const missing = importQcRulesOnce({ workStore: fresh.workStore, kv: fresh.kv, file: join(ROOT, 'not-there.json'), at: AT });
        assertEqual(missing.ran, true, '没有旧文件时"跑过一次"这个动作仍要如实返回');
        assertEqual(fresh.workStore.ledgerHas(QC_RULES_LEDGER_ID), false, '没搬成就不许记账（记早了会把这条路堵死）');
        saveQcContentConfig(fresh.kv, { engine: { kind: 'none' }, rules: [GOOD_RULE] }, 'ADMIN', { at: AT });
        const skipped = importQcRulesOnce({ workStore: fresh.workStore, kv: fresh.kv, file, at: AT });
        assertEqual(skipped.imported, 0, '库里已有规则时不覆盖（旧文件只是回滚凭据）');
        assertEqual(loadQcContentConfig(fresh.kv).rules.length, 1, '库里的规则不受影响');
      } finally {
        fresh.cleanup();
      }
    } finally {
      fixture.cleanup();
    }
  });

  if (existsSync(ROOT)) rmRecursive(ROOT, { recursive: true, force: true });
  process.exit(suite.report());
}

void main();
