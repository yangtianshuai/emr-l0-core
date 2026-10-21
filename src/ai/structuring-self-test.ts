import { TestSuite, assert, assertEqual } from '../testing/harness.ts';
import { matchLongest, validatePlacementConfig, type DictationPlacementConfig } from '../dictation/placement.ts';
import { describePlacementConfig } from '../dictation/placement-store.ts';
import { TERM_MATCH_CONFIDENCE, proposeStructurings } from './structuring.ts';
import type { DataElementTag } from '../model/types.ts';

const suite = new TestSuite('即时结构化自测（V4）', [
  '说明：结构化在内核之外，只产出"这段算什么数据元"的**提议**；采纳与落笔是调用方的事。',
  'S2/S3/S5 是防回退关键：未命中不打标、三种"没标"分得开、非法词表不静默取默认 ——',
  '任一松动，都会让机读信息里出现"没人核对过、也说不清凭什么"的数据元。',
]);

const test = (name: string, fn: () => void | Promise<void>): Promise<void> => suite.test(name, fn);

const TEMP: DataElementTag = { system: 'WS445', code: 'DE05.01.001', display: '体温' };
const CHIEF: DataElementTag = { system: 'WST500', code: 'WST500.2.001', display: '主诉' };
const PRESENT: DataElementTag = { system: 'WST500', code: 'WST500.2.002', display: '现病史' };

const cfg = (patch: Partial<DictationPlacementConfig>): DictationPlacementConfig =>
  validatePlacementConfig({ candidate: { onlyTextNodes: true }, ...patch });

function codeOf(fn: () => unknown): string {
  try {
    fn();
    return 'OK';
  } catch (err) {
    const code = (err as { code?: string }).code;
    return code ?? `UNEXPECTED:${(err as Error).message}`;
  }
}

async function main(): Promise<void> {
  await test('S1 命中词表即给出数据元（含命中词、置信度与理由）', () => {
    const outcome = proposeStructurings(
      { texts: ['患者体温 38.5℃，予对症处理。', '体温正常。'] },
      cfg({ strategy: 'section-title', structureMap: { 体温: TEMP }, confidenceCeiling: 0.85 }),
    );
    assertEqual(outcome.enabled, true, '"按章节词"策略应参与结构化');
    assertEqual(outcome.proposed, 2, '两段都含"体温"，都该被提议');
    assertEqual(outcome.items[0]?.tag?.code, TEMP.code, '要给出数据元编码（下游按它消费）');
    assertEqual(outcome.items[0]?.tag?.system, TEMP.system, '体系也要带上（同编码不同体系是两个数据元）');
    assertEqual(outcome.items[0]?.matched, '体温', '要回报命中的词（医生据此判断词表该不该改）');
    assertEqual(outcome.items[0]?.index, 1, '段序从 1 起（与界面上的"第 N 段"一致）');
    assert(
      (outcome.items[0]?.reason ?? '').includes('体温'),
      `理由要带上命中词 —— "凭什么标它"的答案，实际：${outcome.items[0]?.reason ?? ''}`,
    );
    assertEqual(outcome.warnings.length, 1, '提了标签就要有一句"标签是猜的、会进机读信息，请核对"');
  });

  await test('S2 未命中即"不打标"：绝不兜底给默认标签', () => {
    const outcome = proposeStructurings(
      { texts: ['患者一般情况可，饮食睡眠正常。'] },
      cfg({ strategy: 'section-title', structureMap: { 体温: TEMP }, confidenceCeiling: 0.85 }),
    );
    assertEqual(outcome.enabled, true, '词表非空 → 本次参与');
    assertEqual(outcome.proposed, 0, '没命中就不该产出标签');
    assertEqual(outcome.items[0]?.tag, null, '未命中必须是 null（不能退回某个默认数据元）');
    assertEqual(outcome.items[0]?.matched, null, '没命中就没有命中词');
    assertEqual(outcome.items[0]?.confidence, 0, '没命中不给置信度（给了就等于"猜的也算数"）');
    assert(
      (outcome.items[0]?.reason ?? '').includes('不打标'),
      `理由要说清"没标"，而不是留空，实际：${outcome.items[0]?.reason ?? ''}`,
    );
    assertEqual(outcome.warnings.length, 1, '一条都没命中要有提示（否则会被读成"这段本来就没有可结构化的内容"）');
  });

  await test('S3 三种"没标"分得开：策略不适用 / 词表为空 / 没命中', () => {
    const texts = ['体温 38.5℃'];
    const withRules = { structureMap: { 体温: TEMP } };

    const ordered = proposeStructurings({ texts }, cfg({ strategy: 'ordered', ...withRules }));
    assertEqual(ordered.enabled, false, '"按顺序"只答落点，不参与结构化');
    assertEqual(ordered.proposed, 0, '不参与就不产标签');
    assertEqual(ordered.items[0]?.tag, null, '不参与时也不打标');
    assert(
      (ordered.warnings[0] ?? '').includes('按顺序'),
      `要指出是哪个策略不参与（医生据此去改配置），实际：${ordered.warnings[0] ?? ''}`,
    );
    assert((ordered.items[0]?.reason ?? '') !== '', '逐段也要有说法，不能留空');

    const external = proposeStructurings(
      { texts },
      cfg({ strategy: 'external', external: { endpoint: 'http://127.0.0.1:9100/place' }, ...withRules }),
    );
    assertEqual(external.enabled, false, '外部落位服务不参与结构化');
    assert(
      (external.warnings[0] ?? '').includes('外部'),
      `要说明是外部服务且未接入（不拿本地词表冒充），实际：${external.warnings[0] ?? ''}`,
    );

    const empty = proposeStructurings({ texts }, cfg({ strategy: 'section-title', sectionMap: { 主诉: 'n_1' } }));
    assertEqual(empty.enabled, true, '策略参与了');
    assertEqual(empty.proposed, 0, '词表为空 → 一条都产不出');
    assert(
      (empty.warnings[0] ?? '').includes('词表为空'),
      `要说清是"没配词表"，而不是"没命中"（两件事处置不同），实际：${empty.warnings[0] ?? ''}`,
    );
  });

  await test('S4 命中判定与落位共用同一份实现：最长匹配优先', () => {
    const text = '现病史：患者3天前出现咳嗽。';
    const direct = matchLongest(text, [
      { match: '病史', payload: CHIEF, order: 0 },
      { match: '现病史', payload: PRESENT, order: 1 },
    ]);
    assertEqual(direct?.match, '现病史', '最长匹配优先：命中"现病史"而不是"病史"');
    assertEqual(direct?.payload.code, PRESENT.code, '结论取自命中的那一条规则');

    const outcome = proposeStructurings(
      { texts: [text] },
      cfg({ strategy: 'section-title', structureMap: { 病史: CHIEF, 现病史: PRESENT } }),
    );
    assertEqual(outcome.items[0]?.matched, direct?.match, '结构化选中的词必须与匹配器一致（同一份实现）');
    assertEqual(outcome.items[0]?.tag?.code, PRESENT.code, '同段文本上两处都该选"现病史"');
  });

  await test('S5 置信度受上限压制；非法词表一律拒（不静默取默认）；词表可回读', () => {
    const texts = ['体温 38.5℃'];
    const strict = proposeStructurings(
      { texts },
      cfg({ strategy: 'section-title', structureMap: { 体温: TEMP }, confidenceCeiling: 0.6 }),
    );
    assertEqual(strict.items[0]?.confidence, 0.6, '上限更低时按上限压');
    const loose = proposeStructurings(
      { texts },
      cfg({ strategy: 'section-title', structureMap: { 体温: TEMP }, confidenceCeiling: 0.85 }),
    );
    assertEqual(loose.items[0]?.confidence, TERM_MATCH_CONFIDENCE, '上限更高时用词表命中的基准分');
    assert((loose.items[0]?.confidence ?? 1) < 0.9, '关键内容阈值是 0.90：标签再确定也不得自动落到关键内容上');

    assertEqual(
      codeOf(() => cfg({ strategy: 'section-title', structureMap: { '': TEMP } })),
      'E_PLACEMENT_CONFIG_INVALID',
      '空词是"命中任何文本"的规则，必须拒',
    );
    assertEqual(
      codeOf(() => cfg({ strategy: 'section-title', structureMap: { 体温: { system: 'WS445', code: '' } as DataElementTag } })),
      'E_PLACEMENT_CONFIG_INVALID',
      '缺 code 必须拒（不能存成一个没有编码的标签）',
    );
    assertEqual(
      codeOf(() => cfg({ strategy: 'section-title', structureMap: { 体温: { system: 'NOPE' as never, code: 'X' } } })),
      'E_PLACEMENT_CONFIG_INVALID',
      'system 不在清单里必须拒（不静默改成 local）',
    );
    assertEqual(
      codeOf(() => cfg({ strategy: 'section-title', structureMap: { 体温: 'WS445' as never } })),
      'E_PLACEMENT_CONFIG_INVALID',
      '值必须是对象（把标签写成字符串是最常见的手误）',
    );

    const view = describePlacementConfig({
      config: cfg({ strategy: 'section-title', structureMap: { 体温: TEMP } }),
      source: 'store',
      apiKeyPresent: false,
    });
    assertEqual((view.structureMap as Record<string, DataElementTag>)['体温']?.code, TEMP.code, '词表要能回读（读不回来 = 配了等于没配）');
  });

  process.exit(suite.report());
}

void main();
