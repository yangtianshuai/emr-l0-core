/**
 * 算子插件自测（P1~P9）。
 *
 *   node src/qc/plugin-self-test.ts
 *
 * 覆盖三件事：
 *   P1~P4 **验签与验文件**：没签名 / 签名不符 / 文件被改 / 密钥不对，一律不 import；
 *   P5~P7 **装载与一致性**：算子进内核、规则能用它；清单与模块不一致要拒；重名要拒；
 *   P8~P9 **失败可见**：没有密钥 / 目录里没有插件 —— 如实上报，不静默跳过。
 *
 * 为什么要用真文件、真 import：这套机制的全部价值就是"签名覆盖清单、清单覆盖文件"。
 * 用假的 importer 替掉文件系统，验的就不是同一件事了。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TestSuite, assert, assertEqual } from '../testing/harness.ts';
import type { NodeId } from '../model/types.ts';
import {
  conditionCatalog,
  extendedOperatorNames,
  normalizeCondition,
  evaluateCondition,
  unregisterConditionOperator,
  type QcConditionNode,
} from './condition.ts';
import { compileRulePack } from './rule-pack.ts';
import type { QcContext, QcNodeView, QcRulePack } from './types.ts';
import {
  E_PLUGIN_FILE_MISMATCH,
  E_PLUGIN_KEY_MISSING,
  E_PLUGIN_OPERATOR_MISMATCH,
  E_PLUGIN_SIGNATURE_INVALID,
  loadQcPlugins,
  readPluginKey,
  signPluginDir,
  verifyPluginDir,
  writePluginKey,
} from './plugin.ts';

const suite = new TestSuite('质控·算子插件（签名组件）', [
  '说明：包是数据（不签也收），插件是代码（必须验签）。签名覆盖清单，清单覆盖文件。',
  'P1~P4 是安全关键：签名不符、文件被改、密钥不对时，一个字节都不会被 import。',
]);

const test = (name: string, fn: () => void | Promise<void>): Promise<void> => suite.test(name, fn);

const CTX: QcContext = { now: '2026-10-16T12:00:00Z' };
const view = (over: Partial<QcNodeView> = {}): QcNodeView => ({
  nodeId: 'n_1' as NodeId,
  type: 'text',
  text: '',
  tags: [],
  keyContent: false,
  ...over,
});

/** 一份真实可用的插件：一个算子「字数多于 N 字」 */
const MODULE_SOURCE = `
export function register(api) {
  api.defineOperator('demo-length-over', {
    evaluate(node, atom) {
      const limit = typeof atom.value === 'number' ? atom.value : 0;
      return { hit: String(node.text ?? '').trim().length > limit };
    },
    explain(node, atom) {
      return { detail: '本段 ' + String(node.text ?? '').trim().length + ' 字，超过 ' + String(atom.value) + ' 字。', suggestion: '核对是否把模板内容整段抄了进来。' };
    },
  });
}
`;

const MANIFEST = {
  pluginId: 'qc.plugin.demo',
  name: '演示插件',
  version: '1.0.0',
  api: 'qc-operator/1',
  entry: 'index.mjs',
  files: [],
  operators: [
    {
      name: 'demo-length-over',
      label: '字数多于（插件）',
      fields: ['text'],
      value: { kind: 'integer', unit: '字', doc: '正整数。' },
      doc: '正文长于给定字数。由部署方安装的插件提供。',
    },
  ],
};

const ROOT = mkdtempSync(join(tmpdir(), 'qc-plugin-'));
const PLUGIN_DIR = join(ROOT, 'demo');
const KEY = 'plugin-self-test-key-0123456789';

function writePlugin(over: { manifest?: Record<string, unknown>; module?: string; operatorName?: string } = {}): void {
  /* 每个用例都从干净目录开始：上一个用例留下的文件会让"签名覆盖文件"这件事失去意义 */
  rmSync(PLUGIN_DIR, { recursive: true, force: true });
  mkdirSync(PLUGIN_DIR, { recursive: true });
  const manifest = { ...MANIFEST, ...(over.manifest ?? {}) } as Record<string, unknown>;
  if (over.operatorName !== undefined) {
    manifest.operators = [{ ...(MANIFEST.operators[0] as object), name: over.operatorName }];
  }
  writeFileSync(join(PLUGIN_DIR, 'qc-plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  writeFileSync(join(PLUGIN_DIR, 'index.mjs'), over.module ?? MODULE_SOURCE, 'utf8');
  signPluginDir(PLUGIN_DIR, KEY, 'self-test');
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
    return 'OK';
  } catch (error) {
    return String((error as { code?: string }).code ?? (error as Error).message);
  }
}

async function main(): Promise<void> {
  try {
    /* ============================ P1~P4 验签与验文件 ============================ */

    await test('P1 没签名一律不装：包可以不带签名，插件不行', () => {
      mkdirSync(PLUGIN_DIR, { recursive: true });
      writeFileSync(join(PLUGIN_DIR, 'qc-plugin.json'), `${JSON.stringify(MANIFEST)}\n`, 'utf8');
      writeFileSync(join(PLUGIN_DIR, 'index.mjs'), MODULE_SOURCE, 'utf8');
      assertEqual(
        codeOf(() => verifyPluginDir(PLUGIN_DIR, KEY)),
        E_PLUGIN_SIGNATURE_INVALID,
        '未签名的插件目录必须拒（它带来的是可执行的东西）',
      );
      rmSync(PLUGIN_DIR, { recursive: true, force: true });
    });

    await test('P2 清单被改过 → 签名失效；实现被改过 → 文件摘要不符', () => {
      writePlugin();
      verifyPluginDir(PLUGIN_DIR, KEY); /* 先证明合法的那一份能过 */

      const manifestPath = join(PLUGIN_DIR, 'qc-plugin.json');
      const original = readFileSync(manifestPath, 'utf8');

      writeFileSync(manifestPath, original.replace('演示插件', '改过的插件'), 'utf8');
      assertEqual(codeOf(() => verifyPluginDir(PLUGIN_DIR, KEY)), E_PLUGIN_SIGNATURE_INVALID, '清单被改 → 签名对不上');

      writeFileSync(manifestPath, original, 'utf8');
      const modulePath = join(PLUGIN_DIR, 'index.mjs');
      const moduleText = readFileSync(modulePath, 'utf8');
      writeFileSync(modulePath, `${moduleText}\n// 偷偷加一行\n`, 'utf8');
      assertEqual(
        codeOf(() => verifyPluginDir(PLUGIN_DIR, KEY)),
        E_PLUGIN_FILE_MISMATCH,
        '实现被改 → 与清单里的摘要不符（"改了实现没重签"必须在这里被拒）',
      );
      rmSync(PLUGIN_DIR, { recursive: true, force: true });
    });

    await test('P3 密钥不对 → 验不过；没有密钥 → 明确说不装', async () => {
      writePlugin();
      assertEqual(codeOf(() => verifyPluginDir(PLUGIN_DIR, '另一把钥匙')), E_PLUGIN_SIGNATURE_INVALID, '密钥不对要拒');

      const noKey = await loadQcPlugins({ dir: ROOT, key: null });
      assertEqual(noKey.loaded.length, 0, '没有密钥时一个插件都不装');
      assertEqual(noKey.failures[0]?.code, E_PLUGIN_KEY_MISSING, '失败要如实上报，不静默跳过');
      rmSync(PLUGIN_DIR, { recursive: true, force: true });
    });

    await test('P4 清单与模块不一致要拒：多注册一个算子，或少了实现', async () => {
      /* 多注册：模块里多定义一个清单没写的算子 */
      writePlugin({
        module: `${MODULE_SOURCE}\nexport function extra(api) { api.defineOperator('demo-not-declared', { evaluate: () => ({ hit: true }) }); }\n`,
      });
      const smuggled = MODULE_SOURCE.replace(
        "api.defineOperator('demo-length-over'",
        "api.defineOperator('demo-not-declared', { evaluate: () => ({ hit: true }) });\n  api.defineOperator('demo-length-over'",
      );
      writeFileSync(join(PLUGIN_DIR, 'index.mjs'), smuggled, 'utf8');
      signPluginDir(PLUGIN_DIR, KEY, 'self-test');
      const extraReport = await loadQcPlugins({ dir: ROOT, key: KEY });
      assertEqual(extraReport.loaded.length, 0, '注册了清单里没有的算子 → 整个插件不装');
      assertEqual(extraReport.failures[0]?.code, E_PLUGIN_OPERATOR_MISMATCH, '报"清单与模块不一致"');
      rmSync(PLUGIN_DIR, { recursive: true, force: true });

      /* 少实现：清单里声明了两个，模块只注册一个 */
      writePlugin({
        manifest: {
          operators: [
            ...MANIFEST.operators,
            { name: 'demo-never-implemented', label: '没有实现的算子', fields: ['text'], value: null, doc: 'x' },
          ],
        },
      });
      const missingReport = await loadQcPlugins({ dir: ROOT, key: KEY });
      assertEqual(missingReport.loaded.length, 0, '清单里的算子没有实现 → 不装');
      assertEqual(missingReport.failures[0]?.code, E_PLUGIN_OPERATOR_MISMATCH, '少了实现的算子会让规则永远不命中，必须拒');
      rmSync(PLUGIN_DIR, { recursive: true, force: true });
    });

    /* ============================ P5~P7 装载与一致性 ============================ */

    await test('P5 装上一个签名插件：算子进内核、规则能用它、命中依据来自插件', async () => {
      writePlugin();
      assert(!extendedOperatorNames().includes('demo-length-over'), '装之前不该有这个算子');

      const report = await loadQcPlugins({ dir: ROOT, key: KEY });
      assertEqual(report.failures.length, 0, `不该有失败：${JSON.stringify(report.failures)}`);
      assertEqual(report.loaded.length, 1, '装上一个插件');
      assertEqual(report.loaded[0]?.operators.join(','), 'demo-length-over', '注册的算子照清单');
      assert(extendedOperatorNames().includes('demo-length-over'), '算子进了内核的算子表');
      assert(
        conditionCatalog().operators.some((item) => item.name === 'demo-length-over'),
        '下发界面的清单里也要有它（否则界面上拼不出来，而引擎却认它）',
      );

      /* 用它的规则要能跑：字段 × 算子组合校验、取值校验、判定都走既有那段代码 */
      const [rule] = compileRulePack(packRef({
        kind: 'all',
        children: [
          { kind: 'atom', field: 'nodeType', op: 'in', value: ['text'] },
          { kind: 'atom', field: 'text', op: 'demo-length-over', value: 5 },
        ],
      }));
      if (!rule) throw new Error('应编译出规则');
      const hit = rule.check(view({ text: '把整段模板内容抄了进来' }), CTX);
      if (!hit || 'uncertain' in hit) throw new Error('应命中');
      assert(String(hit.detail).includes('超过 5 字'), '命中依据来自插件的 explain（数字必须与判定用的是同一个）');
      assertEqual(rule.check(view({ text: '腹痛' }), CTX), null, '不超过阈值不命中');
    });

    await test('P6 插件算子重名要拒：内核里已有的名字不能被顶掉', async () => {
      writePlugin({ operatorName: 'contains', module: MODULE_SOURCE.replace('demo-length-over', 'contains') });
      const report = await loadQcPlugins({ dir: ROOT, key: KEY });
      assertEqual(report.loaded.length, 0, '重名 → 不装');
      assertEqual(report.failures[0]?.code, 'E_OPERATOR_NAME_TAKEN', '报"名字被占用"');
      assert(
        normalizeCondition({ kind: 'atom', field: 'text', op: 'contains', value: ['x'] }) !== null,
        '内置算子照旧好用（插件没能污染它）',
      );
      rmSync(PLUGIN_DIR, { recursive: true, force: true });
    });

    await test('P7 没装插件时，插件算子名连条件树都过不了（包带不来算子）', () => {
      const condition = normalizeCondition({ kind: 'atom', field: 'text', op: 'demo-unknown-op', value: 3 });
      assertEqual(condition, null, '包只能引用既有算子：未知算子名连树都不合法');
    });

    /* ============================ P8~P9 失败可见 ============================ */

    await test('P8 目录里没有插件 = 这台机器没装插件（不是错误）', async () => {
      const emptyRoot = mkdtempSync(join(tmpdir(), 'qc-plugin-empty-'));
      const report = await loadQcPlugins({ dir: emptyRoot, key: KEY });
      assertEqual(report.dirPresent, true, '目录在');
      assertEqual(report.loaded.length + report.failures.length, 0, '没有插件目录 = 什么都没发生');
      rmSync(emptyRoot, { recursive: true, force: true });

      const missingRoot = join(emptyRoot, 'not-created');
      const missing = await loadQcPlugins({ dir: missingRoot, key: KEY });
      assertEqual(missing.dirPresent, false, '根目录不存在时如实说出来');
      assertEqual(missing.failures.length, 0, '那不是错误');
    });

    await test('P9 密钥落盘与读取：没有密钥文件就读不出来（不猜、不默认）', () => {
      const keyRoot = mkdtempSync(join(tmpdir(), 'qc-plugin-key-'));
      assertEqual(readPluginKey(keyRoot), null, '没有密钥文件 → null');
      const path = writePluginKey(keyRoot, KEY);
      assert(existsSync(path), '密钥写盘');
      assertEqual(readPluginKey(keyRoot), KEY, '读回来是同一把');
      rmSync(keyRoot, { recursive: true, force: true });
    });

    process.exit(suite.report());
  } finally {
    unregisterConditionOperator('demo-length-over');
    unregisterConditionOperator('contains');
    rmSync(ROOT, { recursive: true, force: true });
  }
}

/** 被测的那条规则：引用刚装上的插件算子 */
function packRef(when: unknown): QcRulePack {
  return {
    packId: 'qc.plugin-test',
    name: '插件算子的自测包',
    kind: 'rule',
    engineApi: 'qc-rule/1',
    items: [{
      itemId: 'R-PLUGIN-1',
      title: '本段字数异常',
      severity: 'warn',
      predicate: { kind: 'field-condition', params: { when } as never },
    }],
  };
}

void main();
