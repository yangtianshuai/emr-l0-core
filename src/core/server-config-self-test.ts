// 服务端文件配置自测（`core/server-config.ts`）。
// SC1 文件不在 → 写出模板（并说明请填 stateKey），口令退回内置演示值且来源如实报出；
// SC2 文件在 → 口令 / 盐 / 环境标识 / 装机凭据都按文件来；

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { TestSuite, assert, assertEqual } from '../testing/harness.ts';
import {
  DEMO_STATE_KEY,
  bootstrapOf,
  describeServerConfig,
  envNameOf,
  importsOf,
  loadServerConfig,
  serverConfigPath,
  stateKeyOf,
  stateSaltHexOf,
} from './server-config.ts';

const suite = new TestSuite('服务端文件配置自测', [
  '说明：口令 / 盐 / 装机凭据是"打开数据库之前就要知道的东西"，它们放在服务端文件里（不进库）。',
  'SC3/SC4 是防回退关键：读坏不静默降级、并发启动不覆盖 —— 这两条都对应"整库密文解不开"这类事故。',
]);

const test = (name: string, fn: () => void | Promise<void>): Promise<void> => suite.test(name, fn);

/* 本环境的 node:fs 声明不完整（缺 mkdtempSync 的完整声明，运行时存在）：局部断言（同其它自测） */
const fsx = (await import('node:fs')) as unknown as { mkdtempSync: (prefix: string) => string };
const TEMP = process.env.TEMP ?? process.env.TMP ?? '.';
const ROOT = fsx.mkdtempSync(join(TEMP, 'l0-server-config-'));
/* 本环境的声明里 `rmSync` 只带 force / recursive 的一部分：局部断言（同各套件的处置） */
const rmRecursive = rmSync as unknown as (path: string, options: { recursive?: boolean; force?: boolean }) => void;
const cleanup = (): void => {
  rmRecursive(ROOT, { recursive: true, force: true });
};

async function main(): Promise<void> {
  await test('SC1 文件不在 → 写出模板；口令退回内置演示值，且**来源如实报出**', () => {
    const file = join(ROOT, 'missing', 'server-config.json');
    const loaded = loadServerConfig(file);
    assertEqual(loaded.source, 'generated', '文件不在时应写出模板（source=generated）');
    assert(existsSync(file), '模板必须真的被写下（否则下次启动又要生成一遍，且没人知道该填哪儿）');
    const text = readFileSync(file, 'utf8');
    assert(text.includes('stateKey'), '模板里必须有 stateKey 这一格（它是这把钥匙本身）');
    /* 模板里不能写死演示口令的值：写了之后"来源"只能报 file，
       而启动日志里那句"口令用的是内置演示值"就永远不会出现（实测踩到）  */
    assertEqual(text.includes(DEMO_STATE_KEY), false, '模板里不得写出口令值（否则来源会被误报成"来自文件"）');
    assertEqual(stateKeyOf(loaded).source, 'demo', '模板里口令留空 → 来源必须报 demo（现场只能从这里看见）');
    assertEqual(stateKeyOf(loaded).key, DEMO_STATE_KEY, '口令应与内置演示值逐字一致（换掉它，已入库的密文就解不开了）');
    assertEqual(stateSaltHexOf(loaded), undefined, '模板里盐留空 → 由 core/store.ts 按口令派生');
    assertEqual(bootstrapOf(loaded).configured, false, '模板里没有装机凭据');
    assertEqual(envNameOf(loaded), null, '模板里环境标识留空 → null（界面显示"未标注"）');
    assertEqual(importsOf(loaded).qcRulesFile, '', '模板里一次性搬运来源为空');
    const line = describeServerConfig(loaded, stateKeyOf(loaded), 'derived');
    assert(line.includes('演示'), '启动日志那行必须点明"口令用的是内置演示值"');
    assertEqual(line.includes(DEMO_STATE_KEY), false, '**日志里绝不能出现口令值**（只报来源）');
  });

  await test('SC2 文件在 → 口令 / 盐 / 环境标识 / 装机凭据都按文件来', () => {
    const file = join(ROOT, 'ok', 'server-config.json');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      `${JSON.stringify({
        stateKey: 'production-key-1',
        stateSalt: '00112233445566778899aabbccddeeff',
        envName: 'prod-a',
        bootstrap: { token: 'deploy-token-1', user: 'ADMIN' },
        imports: { qcRulesFile: 'D:/legacy/qc-rules.json' },
        _note: '给人看的说明，读的时候忽略',
      }, null, 2)}\n`,
      'utf8',
    );
    const loaded = loadServerConfig(file);
    assertEqual(loaded.source, 'file', '文件在时来源应为 file');
    assertEqual(stateKeyOf(loaded).source, 'file', '口令应来自文件');
    assertEqual(stateKeyOf(loaded).key, 'production-key-1', '口令应取文件里的值');
    assertEqual(stateSaltHexOf(loaded), '00112233445566778899aabbccddeeff', '盐应取文件里的值');
    assertEqual(envNameOf(loaded), 'prod-a', '环境标识应取文件里的值');
    const bootstrap = bootstrapOf(loaded);
    assertEqual(bootstrap.token, 'deploy-token-1', '装机凭据应取文件里的值');
    assertEqual(bootstrap.user, 'ADMIN', '播种用户名应取文件里的值');
    assertEqual(bootstrap.configured, true, '给了 token 即为"已配置"');
    assertEqual(importsOf(loaded).qcRulesFile, 'D:/legacy/qc-rules.json', '一次性搬运来源应取文件里的值');

    /* 值就等于内置演示口令时，来源仍必须报 demo（哪怕它是写在文件里的）。
       判据是"实际生效的口令是不是演示值"，不是"它写在哪儿" ——
       否则日志里那句" 口令用的是内置演示值"会在最关键的一种现场消失
       （有人把模板里的演示值原样留在了文件里，却以为文件在就等于配好了）。  */
    const demoFile = join(ROOT, 'demo-value', 'server-config.json');
    mkdirSync(dirname(demoFile), { recursive: true });
    writeFileSync(demoFile, `${JSON.stringify({ stateKey: DEMO_STATE_KEY })}\n`, 'utf8');
    assertEqual(stateKeyOf(loadServerConfig(demoFile)).source, 'demo', '文件里写着演示口令 → 来源必须报 demo');
  });

  await test('SC3 文件在但读不出来 → **抛错**（绝不静默退回演示口令）', () => {
    const bad = join(ROOT, 'bad', 'server-config.json');
    mkdirSync(dirname(bad), { recursive: true });
    writeFileSync(bad, '{ "stateKey": "x", }\n', 'utf8'); /* JSON 里多一个逗号：最常见的"手改坏" */
    assert(
      (() => {
        try {
          loadServerConfig(bad);
          return false;
        } catch (err) {
          return (err as Error).message.includes('不是合法 JSON');
        }
      })(),
      '坏 JSON 必须抛错，且信息要点明是 JSON 的问题（否则运维只能猜）',
    );

    const wrongShape = join(ROOT, 'shape', 'server-config.json');
    mkdirSync(dirname(wrongShape), { recursive: true });
    writeFileSync(wrongShape, `${JSON.stringify({ stateKey: 123 })}\n`, 'utf8');
    assert(
      (() => {
        try {
          loadServerConfig(wrongShape);
          return false;
        } catch (err) {
          return (err as Error).message.includes('stateKey 必须是字符串');
        }
      })(),
      '类型不对必须抛错（把数字当口令用会得到一把永远解不开的钥匙）',
    );

    const arrayRoot = join(ROOT, 'array', 'server-config.json');
    mkdirSync(dirname(arrayRoot), { recursive: true });
    writeFileSync(arrayRoot, '[]\n', 'utf8');
    assert(
      (() => {
        try {
          loadServerConfig(arrayRoot);
          return false;
        } catch {
          return true;
        }
      })(),
      '根不是对象必须抛错',
    );
  });

  await test('SC4 已有文件时**不覆盖**（两个进程同时启动，只该有一个写成模板）', async () => {
    const file = join(ROOT, 'race', 'server-config.json');
    /* 先让一个"进程"写下模板 */
    const first = loadServerConfig(file);
    assertEqual(first.source, 'generated', '前置：第一次应生成模板');
    /* 再让"另一个进程"来读：它必须读到已有的那一份，而不是把模板再写一遍 */
    const second = loadServerConfig(file);
    assertEqual(second.source, 'file', '文件已在时应直接读它（不再生成）');
    /* 手改一份"运维填好的"，再读一次：值必须是我们填的 */
    writeFileSync(file, `${JSON.stringify({ stateKey: 'ops-filled' })}\n`, 'utf8');
    assertEqual(stateKeyOf(loadServerConfig(file)).key, 'ops-filled', '读到的必须是人填的那一份');
    assertEqual(serverConfigPath(ROOT).endsWith('server-config.json'), true, '路径助手应指向固定文件名（不支持改路径）');
  });

  cleanup();
  process.exit(suite.report());
}

void main();
