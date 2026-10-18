// 语音落位可配置形态自测（V1）。

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
/* 本环境的 node:fs / node:os 类型声明不完整（缺 mkdtempSync / tmpdir / rmSync 的 recursive），
   局部断言（同 src/demo/demo-server.ts 的做法） */
const fsx = (await import('node:fs')) as unknown as {
  mkdtempSync: (prefix: string) => string;
  rmSync: (path: string, options?: { recursive?: boolean; force?: boolean }) => void;
};
const osx = (await import('node:os')) as unknown as { tmpdir: () => string };
import { TestSuite, assert, assertEqual } from '../testing/harness.ts';
import { buildSyntheticDoc } from '../testing/synthetic.ts';
import { WriteSession, type Actor } from '../core/session.ts';
import type { TranscriptSegment } from '../core/dictation.ts';
import type { NodeId } from '../model/types.ts';
import {
  collectCandidates,
  placePastedParagraphs,
  placeSegments,
  placedNodeIds,
  validatePlacementConfig,
  type DictationPlacementConfig,
} from './placement.ts';
import { resolvePlacements } from './external-placement.ts';
import {
  PLACEMENT_API_KEY_KEY,
  PLACEMENT_CONFIG_KEY,
  describePlacementConfig,
  loadPlacementConfig,
  savePlacementConfig,
} from './placement-store.ts';
import { openConfigFixture, sealedBlobOf, writeCorruptRow } from '../testing/config-fixture.ts';

const suite = new TestSuite('语音落位可配置形态自测（V1 + V2 外部服务）', [
  '说明：落位层在内核之外，只产出"目标节点或未落位"；配置只能改初始落点，不得变成免审开关。',
  'P2/P3/P7/P10/P11 是防回退关键：不兜底、不越阈值、不静默降级、不接受越界 nodeId、超时必须中止 ——',
  '任一松动都会让"落位"变成绕过门控的通道，或让"接了外部服务"变成一句假话。',
]);

const test = (name: string, fn: () => void | Promise<void>): Promise<void> => suite.test(name, fn);

const HUMAN: Actor = { id: 'DR_WANG', kind: 'human' };
const AI: Actor = { id: 'asr-pipeline', kind: 'ai' };

function open(): { session: WriteSession; ids: ReturnType<typeof buildSyntheticDoc>['ids'] } {
  const { doc, ids } = buildSyntheticDoc({ sections: 2, paragraphsPerSection: 2, fieldsPerParagraph: 0 });
  return { session: WriteSession.open(doc), ids };
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
    return 'OK';
  } catch (err) {
    const code = (err as { code?: string }).code;
    return code ?? `UNEXPECTED:${(err as Error).message}`;
  }
}

const localConfig = (patch: Partial<DictationPlacementConfig>): DictationPlacementConfig =>
  validatePlacementConfig({ candidate: { onlyTextNodes: true }, ...patch });

/** 异步版 codeOf：外部落位是异步的，错误只能 await 之后才拿得到 */
async function asyncCodeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return 'OK';
  } catch (err) {
    return (err as { code?: string }).code ?? `UNEXPECTED:${(err as Error).message}`;
  }
}

async function main(): Promise<void> {
  await test('P1 section-title：命中章节词即落到映射节点', () => {
    const { session, ids } = open();
    const config = localConfig({
      strategy: 'section-title',
      sectionMap: { '第 1 节': ids.textIds[0] as NodeId, '第 2 节': ids.textIds[1] as NodeId },
    });
    const candidates = collectCandidates(session.indexes, config);
    assertEqual(candidates.total, 4, '本案共有 4 个文本节点');

    const segments: TranscriptSegment[] = [
      { index: 1, text: '第 1 节：患者三天前出现咳嗽。', confidence: 0.9 },
      { index: 2, text: '第 2 节：既往体健。', confidence: 0.9 },
    ];
    const outcome = placeSegments({ segments, candidates }, config);
    assertEqual(outcome.items.map((item) => item.nodeId), [ids.textIds[0], ids.textIds[1]], '应按规则落到各自节点');
    assertEqual(outcome.unplaced, 0, '两段都应落位');
    assertEqual(placedNodeIds(outcome), [ids.textIds[0], ids.textIds[1]], '已落位节点应按段序给出');
  });

  await test('P2 未命中即"未落位"：不兜底到第一个节点（含 ordered 候选不足）', () => {
    const { session, ids } = open();

    const configured = localConfig({ strategy: 'section-title', sectionMap: { '现病史': ids.textIds[1] as NodeId } });
    const outcomes = placeSegments(
      { segments: [{ index: 1, text: '患者三天前出现咳嗽。', confidence: 0.9 }], candidates: collectCandidates(session.indexes, configured) },
      configured,
    );
    assertEqual(outcomes.items[0]?.nodeId, null, '没命中就应是未落位，不能顺手塞到第一个候选');
    assert(
      outcomes.warnings.some((text) => text.includes('未落位')),
      `必须回报未落位，实际：${outcomes.warnings.join(' | ')}`,
    );

    const narrow = localConfig({ strategy: 'ordered', candidate: { onlyTextNodes: true, withinSections: ['sec1'] } });
    const candidates = collectCandidates(session.indexes, narrow);
    assertEqual(candidates.nodeIds.length, 2, 'sec1 之下只有 2 个文本节点');
    const segments: TranscriptSegment[] = [1, 2, 3].map((index) => ({ index, text: `第 ${index} 段口述内容`, confidence: 0.9 }));
    const ordered = placeSegments({ segments, candidates }, narrow);
    assertEqual(ordered.items.map((item) => item.nodeId !== null), [true, true, false], '第 3 段候选不足，应未落位');
    assertEqual(ordered.unplaced, 1, '恰有 1 段未落位');
  });

  await test('P3 置信度上限：必须小于关键内容阈值；非法值一律报错', () => {
    assertEqual(codeOf(() => validatePlacementConfig({ confidenceCeiling: 0.95 })), 'E_PLACEMENT_CEILING_TOO_HIGH', '高于阈值应被拒');
    assertEqual(codeOf(() => validatePlacementConfig({ confidenceCeiling: 0.9 })), 'E_PLACEMENT_CEILING_TOO_HIGH', '恰好等于阈值也拒（必须严格小于）');
    assertEqual(codeOf(() => validatePlacementConfig({ confidenceCeiling: -1 })), 'E_PLACEMENT_CONFIG_INVALID', '负数应被拒');
    assertEqual(codeOf(() => validatePlacementConfig({ confidenceCeiling: Number.NaN })), 'E_PLACEMENT_CONFIG_INVALID', 'NaN 应被拒（NaN 比较恒为 false，会绕过判断）');
    assertEqual(validatePlacementConfig({}).confidenceCeiling, 0.85, '未指定时默认 0.85');
    assertEqual(codeOf(() => validatePlacementConfig({ candidate: { onlyTextNodes: false } as never })), 'E_PLACEMENT_CONFIG_INVALID', '不得声称能放宽"只落文本节点"');
  });

  await test('P4 落位不改变门控：关键内容上仍必须"改后采纳"', () => {
    const { session, ids } = open();
    const target = ids.textIds[0] as NodeId;
    session.updateNodeProps({ nodeId: target, patch: { keyContent: true } }, HUMAN);

    const config = localConfig({ strategy: 'ordered' });
    const candidates = collectCandidates(session.indexes, config);
    assert(candidates.nodeIds.includes(target), '关键内容节点照常进入候选集（排除它等于"让口语说不出关键信息"）');

    const segments: TranscriptSegment[] = [{ index: 1, text: '患者无药物过敏史。', confidence: 0.99 }];
    const outcome = placeSegments({ segments, candidates }, config);
    assertEqual(outcome.items[0]?.nodeId, target, '第一段落第一个候选节点');

    const run = session.dictate(
      { transcriptionId: 'p4-audio', asrModelId: 'local/asr-zh-med:demo', segments, targetNodeIds: placedNodeIds(outcome), maxConfidence: config.confidenceCeiling },
      AI,
    );
    const suggestionId = String(session.listSuggestions({ groupId: run.groupId })[0]?.id);
    assertEqual(
      session.listSuggestions({ groupId: run.groupId })[0]?.confidence,
      0.85,
      '听写置信度应被上限压到 0.85（听清了 ≠ 内容对）',
    );
    assertEqual(
      codeOf(() => session.acceptSuggestion({ suggestionId }, HUMAN)),
      'E_AI_LOW_CONFIDENCE',
      '关键内容上不得直接采纳：落位配置改变不了门控档位',
    );
  });

  await test('P5 配置不得放宽内核约束：落到非文本节点由 dictate 硬拒', () => {
    const { session, ids } = open();
    const config = localConfig({ strategy: 'section-title', sectionMap: { '第 1 节': ids.sectionIds[0] as NodeId } });
    const segments: TranscriptSegment[] = [{ index: 1, text: '第 1 节 口述内容', confidence: 0.9 }];
    const outcome = placeSegments({ segments, candidates: collectCandidates(session.indexes, config) }, config);
    assertEqual(outcome.items[0]?.nodeId, ids.sectionIds[0], '落位层照配置给出 section 节点（它不判断类型）');

    assertEqual(
      codeOf(() => session.dictate({ transcriptionId: 'p5-audio', asrModelId: 'local/asr:demo', segments, targetNodeIds: placedNodeIds(outcome) }, AI)),
      'E_TYPE_MISMATCH',
      '非文本节点必须由内核硬拒：配置层不能放宽 dictate 的约束',
    );
  });

  await test('P6 落位只产建议：不改 rev、不留痕', () => {
    const { session, ids } = open();
    const config = localConfig({ strategy: 'ordered' });
    const segments: TranscriptSegment[] = [{ index: 1, text: '患者三天前出现咳嗽。', confidence: 0.9 }];
    const outcome = placeSegments({ segments, candidates: collectCandidates(session.indexes, config) }, config);

    const before = JSON.stringify(session.document.nodes);
    const rev = session.docRev;
    const logLength = session.auditLog().length;
    session.dictate({ transcriptionId: 'p6-audio', asrModelId: 'local/asr:demo', segments, targetNodeIds: placedNodeIds(outcome) }, AI);

    assertEqual(JSON.stringify(session.document.nodes), before, '落位建议不得落笔');
    assertEqual(session.docRev, rev, '落位建议不得改 rev');
    assertEqual(session.auditLog().length, logLength, '落位建议不得留痕');
    assertEqual(session.verifyInvariants(), [], '不变量应成立');
    void ids;
  });

  await test('P7 external：必须给服务地址，且只能走异步入口（不静默降价）', () => {
    assertEqual(
      codeOf(() => validatePlacementConfig({ strategy: 'external' })),
      'E_PLACEMENT_CONFIG_INVALID',
      'external 缺服务地址必须被拒（静默退回 ordered 会让"已接入外部落位"变成假话）',
    );
    const ok = validatePlacementConfig({ strategy: 'external', external: { endpoint: 'http://127.0.0.1:9100/place' } });
    assertEqual(ok.external?.timeoutMs, 20_000, '缺省超时应填默认值');
    /* 同步入口不处理 external：必须走 resolvePlacements，否则"配了外部服务却走本地"会静默发生 */
    assertEqual(
      codeOf(() => placeSegments({ segments: [], candidates: { nodeIds: [], total: 0, excluded: 0 } }, ok)),
      'E_PLACEMENT_EXTERNAL_REQUIRES_ASYNC',
      '外部落位必须走 resolvePlacements()',
    );
  });

  await test('P8 配置存储：库是唯一来源；外部落位密钥单独一行、永不回显；读不出来不静默', () => {
    const fixture = openConfigFixture({ prefix: 'l0-placement-' });
    const kv = fixture.kv;
    try {
      assertEqual(loadPlacementConfig(kv).source, 'default', '没配过应为默认（库空时不会去看环境变量）');

      savePlacementConfig(kv, { strategy: 'section-title', sectionMap: { '主诉': 't_main' }, confidenceCeiling: 0.8 }, 'ADMIN');
      const stored = loadPlacementConfig(kv);
      assertEqual(stored.source, 'store', '保存后来源应是 store');
      assertEqual(stored.config.strategy, 'section-title', '配置应生效');
      assertEqual(stored.config.confidenceCeiling, 0.8, '上限应生效');
      assertEqual(stored.config.sectionMap, { '主诉': 't_main' }, '规则表应持久化');

      assertEqual(codeOf(() => savePlacementConfig(kv, { confidenceCeiling: 0.95 }, 'ADMIN')), 'E_PLACEMENT_CEILING_TOO_HIGH', '非法配置不得落库');

      /* 外部落位密钥：单独一行、加密、永不回显（与模型/采集密钥同一套纪律）。
         三种状态逐条钉住，因为"没传 apiKey"被当成"清空"的代价很具体：
         管理员只改个地址，密钥就没了，而现场表现是"外部落位突然 401"。  */
      const withKey = savePlacementConfig(
        kv,
        { strategy: 'external', external: { endpoint: 'http://127.0.0.1:9100/place' }, apiKey: 'place-secret-1' },
        'ADMIN',
      );
      assertEqual(withKey.apiKeyAction, 'set', '设新值应如实回报');
      assertEqual(withKey.loaded.apiKeyPresent, true, '密钥应就位');
      assertEqual(withKey.loaded.apiKey, 'place-secret-1', '口令对时应能解出来（供外呼使用）');
      assertEqual(
        JSON.stringify(describePlacementConfig(withKey.loaded)).includes('place-secret-1'),
        false,
        '**视图里不得出现密钥值**：回显一次就收不回来了（截图、日志、前端内存）',
      );
      assertEqual(sealedBlobOf(fixture, PLACEMENT_API_KEY_KEY)?.includes('place-secret-1'), false, '库里那一行不得是明文');
      const kept = savePlacementConfig(kv, { strategy: 'external', external: { endpoint: 'http://127.0.0.1:9101/place' } }, 'ADMIN');
      assertEqual(kept.apiKeyAction, 'unchanged', '没传 apiKey 时不得动密钥');
      assertEqual(kept.loaded.apiKey, 'place-secret-1', '改地址后密钥仍在');
      const cleared = savePlacementConfig(kv, { strategy: 'external', external: { endpoint: 'http://127.0.0.1:9101/place' }, apiKey: null }, 'ADMIN');
      assertEqual(cleared.apiKeyAction, 'cleared', '显式 null 应清除');
      assertEqual(sealedBlobOf(fixture, PLACEMENT_API_KEY_KEY), null, '清除必须是真删那一行（不留空壳）');

      /* 库里那一行读不出来（口令换过 / 被人改过）→ 不许当作"没配过"。
         文件时代这里模拟的是"写一段半截 JSON"；现在写不出半截 JSON 了
         （密封信封带 MAC，"半截"这种损坏已经不可能出现），但"解不开"仍然可能，
         而且它是更危险的那种 —— 现场会表现成"我配的落位没了"。  */
      writeCorruptRow(fixture, PLACEMENT_CONFIG_KEY);
      assertEqual(codeOf(() => loadPlacementConfig(kv)), 'E_PLACEMENT_CONFIG_INVALID', '读不出来的配置不得当作"没配过"');
    } finally {
      fixture.cleanup();
    }
  });

  await test('P9 外部落位：按服务返回的映射落位，并如实报告产出方', async () => {
    const { session, ids } = open();
    const config = validatePlacementConfig({ strategy: 'external', external: { endpoint: 'http://placement.test/place' } });
    const candidates = collectCandidates(session.indexes, config);
    const segments: TranscriptSegment[] = [
      { index: 1, text: '第 1 段口述内容', confidence: 0.9 },
      { index: 2, text: '第 2 段口述内容', confidence: 0.9 },
    ];
    let seenBody = '';
    const outcome = await resolvePlacements({ segments, candidates }, config, {
      transport: async (request) => {
        seenBody = request.body;
        return {
          status: 200,
          body: JSON.stringify({
            placements: [{ index: 1, nodeId: ids.textIds[0] }, { index: 2, nodeId: ids.textIds[1] }],
            modelId: 'dept-placement-v1',
          }),
        };
      },
    });
    assertEqual(outcome.items.map((item) => item.nodeId), [ids.textIds[0], ids.textIds[1]], '应按服务返回落位');
    assertEqual(outcome.source, 'external', '应标明落点来自外部服务');
    assertEqual(outcome.modelId, 'dept-placement-v1', '应如实记录服务标识（否则答不出"这条落点是谁给的"）');
    const sent = JSON.parse(seenBody) as { segments: unknown[]; candidates: string[] };
    assertEqual(Object.keys(sent).sort(), ['candidates', 'segments'], '请求体只应包含"本次要落位的段"与"候选集"，不夹带整篇文档');
    assertEqual(sent.segments.length, 2, '请求应只带本次转写段');
    assertEqual(sent.candidates.length, candidates.nodeIds.length, '请求应带上候选集（服务只能在其中选）');
  });

  await test('P10 外部落位：越界 nodeId 与陌生段号一律拒；未给出的段记为未落位', async () => {
    const { session, ids } = open();
    const config = validatePlacementConfig({ strategy: 'external', external: { endpoint: 'http://placement.test/place' } });
    const candidates = collectCandidates(session.indexes, config);
    const segments: TranscriptSegment[] = [
      { index: 1, text: '第 1 段', confidence: 0.9 },
      { index: 2, text: '第 2 段', confidence: 0.9 },
    ];
    const call = (placements: unknown) =>
      resolvePlacements({ segments, candidates }, config, {
        transport: async () => ({ status: 200, body: JSON.stringify({ placements }) }),
      });

    assertEqual(await asyncCodeOf(() => call([{ index: 1, nodeId: 'n_root' }])), 'E_PLACEMENT_UNKNOWN_NODE', '越界 nodeId 必须被拒');
    assertEqual(
      await asyncCodeOf(() => call([{ index: 99, nodeId: ids.textIds[0] }])),
      'E_PLACEMENT_UNKNOWN_NODE',
      '不属于本次的段号必须被拒',
    );
    const partial = await call([{ index: 1, nodeId: ids.textIds[0] }]);
    assertEqual(partial.items.map((item) => item.nodeId), [ids.textIds[0], null], '未给出的段应为未落位（交人工指定）');
    assertEqual(partial.unplaced, 1, '未落位数应如实回报');
  });

  await test('P11 外部落位：超时与服务错误一律 fail-closed（不退回本地策略）', async () => {
    const { session } = open();
    const candidates = collectCandidates(session.indexes, validatePlacementConfig({ strategy: 'ordered' }));
    const segments: TranscriptSegment[] = [{ index: 1, text: '第 1 段', confidence: 0.9 }];

    const httpError = validatePlacementConfig({ strategy: 'external', external: { endpoint: 'http://placement.test/place' } });
    assertEqual(
      await asyncCodeOf(() => resolvePlacements({ segments, candidates }, httpError, { transport: async () => ({ status: 503, body: 'busy' }) })),
      'E_PLACEMENT_HTTP_STATUS',
      '服务返回非 2xx 应报错（错误信息不带响应体）',
    );

    /* 超时：transport 永不返回且不理会 abort —— 必须靠 race 兜住，
       否则"服务挂住"在现场表现为"落位没反应"，排查方向会完全跑偏  */
    const timeout = validatePlacementConfig({ strategy: 'external', external: { endpoint: 'http://placement.test/place', timeoutMs: 30 } });
    assertEqual(
      await asyncCodeOf(() => resolvePlacements({ segments, candidates }, timeout, { transport: () => new Promise(() => {}) })),
      'E_PLACEMENT_TIMEOUT',
      '超时必须被中止',
    );
  });

  await test('P12 外部落位：响应结构非法一律报错（不把"没有产出"当成"没有建议"）', async () => {
    const { session } = open();
    const config = validatePlacementConfig({ strategy: 'external', external: { endpoint: 'http://placement.test/place' } });
    const candidates = collectCandidates(session.indexes, config);
    const segments: TranscriptSegment[] = [{ index: 1, text: '第 1 段', confidence: 0.9 }];
    const call = (body: string) => resolvePlacements({ segments, candidates }, config, { transport: async () => ({ status: 200, body }) });

    const cases: Array<[string, string]> = [
      ['这是一段说明文字，没有 JSON', 'E_PLACEMENT_BAD_JSON'],
      ['{"result":"ok"}', 'E_PLACEMENT_NO_CONTENT'],
      ['{"placements":"不是数组"}', 'E_PLACEMENT_NO_CONTENT'],
    ];
    for (const [body, expected] of cases) {
      assertEqual(await asyncCodeOf(() => call(body)), expected, `响应 ${body} 应报 ${expected}`);
    }
  });

  /* ============ Q1~Q6：粘贴落位（V3）—— 落点是章节，未命中落在锚点 ============ */

  await test('Q1 命中章节词 → 落到该章节；未命中 → 落在锚点（不是"未落位"）', () => {
    const { session, ids } = open();
    const config = localConfig({ strategy: 'section-title', sectionMap: { '现病史': ids.textIds[2] as NodeId } });
    const outcome = placePastedParagraphs(
      { texts: ['现病史：患者三天前出现咳嗽。', '这一行没有任何章节词。'], anchorSectionId: ids.sectionIds[0] as NodeId },
      session.indexes,
      config,
    );
    assertEqual(outcome.enabled, true, '本策略参与粘贴落位');
    assertEqual(outcome.items[0]?.sectionId, ids.sectionIds[1], '命中"现病史"应落到它所在的章节');
    assertEqual(outcome.items[0]?.matched, '现病史', '要回报命中的是哪个词（否则查不出落位依据）');
    assertEqual(outcome.items[1]?.sectionId, null, '未命中的段落由调用方落到锚点');
    assertEqual(outcome.items[1]?.index, 2, '段序从 1 起（与界面上的"第 N 段"一致）');
    assertEqual(outcome.moved, 1, '只有第一段被挪走');
    assert(
      outcome.warnings.some((text) => text.includes('别的章节')),
      `有段落被挪走时必须回报，实际：${outcome.warnings.join(' | ')}`,
    );
  });

  await test('Q2 term-table：术语表策略同样落到章节', () => {
    const { session, ids } = open();
    const config = localConfig({ strategy: 'term-table', termMap: [{ match: '既往史', nodeId: ids.textIds[3] as NodeId }] });
    const outcome = placePastedParagraphs(
      { texts: ['既往史：高血压五年。'], anchorSectionId: ids.sectionIds[0] as NodeId },
      session.indexes,
      config,
    );
    assertEqual(outcome.items[0]?.sectionId, ids.sectionIds[1], '应落到术语表指向的章节');
    assertEqual(outcome.moved, 1, '跨章节即计入 moved');
  });

  await test('Q3 命中但本来就在同一章节：给出 sectionId、moved 为 0', () => {
    const { session, ids } = open();
    const config = localConfig({ strategy: 'section-title', sectionMap: { '主诉': ids.textIds[1] as NodeId } });
    const outcome = placePastedParagraphs({ texts: ['主诉：胸痛三天。'], anchorSectionId: ids.sectionIds[0] as NodeId }, session.indexes, config);
    assertEqual(outcome.items[0]?.sectionId, ids.sectionIds[0], '目标就是锚点所在章节');
    assertEqual(outcome.moved, 0, '没被挪走就不能计入 moved —— 否则界面会虚报"挪了 N 段"');
  });

  await test('Q4 ordered 不参与粘贴落位："按顺序"的前提在粘贴场景不成立', () => {
    const { session, ids } = open();
    const outcome = placePastedParagraphs(
      { texts: ['甲', '乙', '丙'], anchorSectionId: ids.sectionIds[0] as NodeId },
      session.indexes,
      localConfig({ strategy: 'ordered' }),
    );
    assertEqual(outcome.enabled, false, '按顺序策略不参与');
    assertEqual(
      outcome.items.every((item) => item.sectionId === null),
      true,
      '一段都不该被挪走：往光标处粘三行，不该散落到三个章节里',
    );
    assertEqual(outcome.moved, 0, '没有移动');
    assert(
      outcome.warnings.some((text) => text.includes('按顺序')),
      `要说清为什么这次没参与（否则医生会以为落位坏了），实际：${outcome.warnings.join(' | ')}`,
    );
  });

  await test('Q5 external 不退回本地规则冒充：如实说"未接入"', () => {
    const { session, ids } = open();
    const config = localConfig({ strategy: 'external', external: { endpoint: 'http://127.0.0.1:9/place' } });
    const outcome = placePastedParagraphs({ texts: ['现病史：x。'], anchorSectionId: ids.sectionIds[0] as NodeId }, session.indexes, config);
    assertEqual(outcome.enabled, false, '外部策略不参与粘贴落位');
    assertEqual(outcome.items[0]?.sectionId, null, '落回锚点，而不是"猜一个"');
    assert(
      outcome.warnings.some((text) => text.includes('外部')),
      `要说明是外部策略且未接入，实际：${outcome.warnings.join(' | ')}`,
    );
  });

  await test('Q6 规则指向的节点已失效：如实说"规则可能过期"，不硬塞到别处', () => {
    const { session, ids } = open();
    const config = localConfig({ strategy: 'term-table', termMap: [{ match: '主诉', nodeId: 'n_ghost' as NodeId }] });
    const outcome = placePastedParagraphs({ texts: ['主诉：胸痛三天。'], anchorSectionId: ids.sectionIds[0] as NodeId }, session.indexes, config);
    assertEqual(outcome.items[0]?.sectionId, null, '指不到章节就落锚点');
    assertEqual(outcome.items[0]?.matched, '主诉', '仍要回报命中了哪个词 —— 否则查不出"是规则过期了"');
    assert(
      /过期|不在任何章节/.test(outcome.items[0]?.reason ?? ''),
      `理由要指向"规则可能过期"，实际 ${outcome.items[0]?.reason}`,
    );
  });

  await test('Q7 与语音落位共用同一个匹配器：最长匹配优先', () => {
    const { session, ids } = open();
    const config = localConfig({
      strategy: 'term-table',
      termMap: [
        { match: '现病史', nodeId: ids.textIds[0] as NodeId },
        { match: '现病史与既往史', nodeId: ids.textIds[2] as NodeId },
      ],
    });
    const outcome = placePastedParagraphs(
      { texts: ['现病史与既往史：同前。'], anchorSectionId: ids.sectionIds[0] as NodeId },
      session.indexes,
      config,
    );
    assertEqual(outcome.items[0]?.matched, '现病史与既往史', '更长的规则词优先（否则落位会随声明顺序漂移）');
    assertEqual(outcome.items[0]?.sectionId, ids.sectionIds[1], '落到长词指向的章节');
  });

  process.exit(suite.report());
}

void main();
