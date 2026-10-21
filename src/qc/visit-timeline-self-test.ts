import { fileURLToPath } from 'node:url';
import { TestSuite, assert, assertEqual } from '../testing/harness.ts';
import { createEmptyPackRegistry } from '../knowledge/default-registry.ts';
import { readSamplePack, SAMPLE_PACK_FILES } from '../knowledge/sample-packs.ts';
import { validateRulePack } from './rule-pack.ts';
import { crossDocRulesOf, buildVisitTimeline, type VisitTimelineDocInput, type VisitTimelineRuleRef } from './visit-timeline.ts';
import type { QcContext, QcNodeView, QcRulePack } from './types.ts';
import type { DocNode, DocumentModel, NodeId } from '../model/types.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const TIME_PACK = readSamplePack(ROOT, SAMPLE_PACK_FILES.timeRules) as QcRulePack;

const registry = createEmptyPackRegistry();
registry.load(TIME_PACK, { validate: (pack) => validateRulePack(pack as QcRulePack) });

const RULES: VisitTimelineRuleRef[] = crossDocRulesOf(registry);

const suite = new TestSuite('就诊时间轴自测', [
  '说明：轴只做一件新事 —— 把跨文书结论**定位到线上**；判定仍由已编译的规则给出（与质控注解同一句话）。',
  '全部离线：规则来自样例包，趋势对照用合成文书，时间一律注入。',
]);

const test = (name: string, fn: () => void | Promise<void>): Promise<void> => suite.test(name, fn);

const NOW = '2026-10-12T00:00:00Z';
const ADMITTED = '2026-10-05T03:00:00Z';
const hoursAfter = (base: string, h: number): string => new Date(Date.parse(base) + h * 3_600_000).toISOString();

const PROGRESS = 'WST500.3';
const ADMISSION = 'WST500.1';

const visitDoc = (
  docId: string,
  docTypeCode: string,
  createdAt: string,
  extra: Partial<VisitTimelineDocInput> = {},
): VisitTimelineDocInput => ({
  docId,
  docTypeCode,
  createdAt,
  title: docTypeCode === PROGRESS ? '病程记录' : '入院记录',
  ...extra,
});

interface FieldSpec {
  id: string;
  order: number;
  value: number | string;
  valueText?: string;
  sampledAt?: string;
  sourceKey?: string;
  range?: { low?: number; high?: number };
  tags?: Array<{ system: string; code: string; display?: string }>;
}

function docWith(docId: string, text: string, fields: FieldSpec[]): DocumentModel {
  const at = '2026-10-05T03:00:00Z';
  const prov = { origin: 'system' as const, actorId: 'system/lis', at };
  const nodes: Record<string, DocNode> = {
    n_root: { id: 'n_root', type: 'document', parentId: null, order: 0, rev: 1, provenance: prov },
    n_p: { id: 'n_p', type: 'paragraph', parentId: 'n_root', order: 10, rev: 1, provenance: prov },
    n_t: { id: 'n_t', type: 'text', parentId: 'n_p', order: 20, rev: 1, runs: [{ text }], provenance: prov },
  };
  for (const spec of fields) {
    nodes[spec.id] = {
      id: spec.id,
      type: 'field',
      parentId: 'n_p',
      order: spec.order,
      rev: 1,
      dataType: 'number',
      value: spec.value,
      ...(spec.valueText !== undefined ? { valueText: spec.valueText } : {}),
      ...(spec.sampledAt !== undefined ? { sampledAt: spec.sampledAt } : {}),
      ...(spec.sourceKey !== undefined ? { sourceKey: spec.sourceKey } : {}),
      ...(spec.range !== undefined ? { referenceRange: spec.range } : {}),
      ...(spec.tags !== undefined ? { tags: spec.tags } : {}),
      provenance: prov,
    } as unknown as DocNode;
  }
  return {
    schemaVersion: '1.0.0',
    docId,
    docType: { system: 'WST500', code: 'WST500.1', display: '入院记录' },
    patient: { patientId: 'P1', nameMasked: '张**' },
    status: 'draft',
    createdAt: at,
    updatedAt: at,
    createdBy: 'DR_WANG',
    rootId: 'n_root',
    nodes,
    revisions: [],
  } as unknown as DocumentModel;
}

const WBC_TAG = { system: 'WS445', code: 'DE04.30.001', display: '白细胞计数' };
const RANGE = { low: 4, high: 10 };

function ruleOf(ruleId: string): VisitTimelineRuleRef {
  const found = RULES.find((ref) => ref.rule.id === ruleId);
  assert(!!found, `前置：样例时限包里应有 ${ruleId}`);
  return found as VisitTimelineRuleRef;
}

function verdictOf(ref: VisitTimelineRuleRef, visitDocs: VisitTimelineDocInput[], extra: Partial<QcContext> = {}) {
  const view: QcNodeView = { nodeId: 'n_root' as NodeId, type: 'document', text: '', tags: [], keyContent: false };
  const ctx: QcContext = {
    now: NOW,
    admittedAt: ADMITTED,
    docTypeCode: ref.docTypeCode,
    visitType: 'inpatient',
    visitDocs: visitDocs.map((doc) => ({ docId: doc.docId, docTypeCode: doc.docTypeCode, createdAt: doc.createdAt })),
    ...extra,
  };
  const result = ref.rule.check(view, ctx);
  if (result === null) return { kind: 'none' as const };
  if ('uncertain' in result) return { kind: 'uncertain' as const, reason: result.uncertain };
  return { kind: 'hit' as const, detail: result.detail };
}

function timelineOf(visitDocs: VisitTimelineDocInput[], extra: Partial<Parameters<typeof buildVisitTimeline>[0]> = {}) {
  return buildVisitTimeline({
    now: NOW,
    visitId: 'V_TEST_1',
    visitType: 'inpatient',
    admittedAt: ADMITTED,
    visitDocs,
    rules: RULES,
    ...extra,
  });
}

async function main(): Promise<void> {

  await test('TL0 前置：跨文书规则从包里被挑出来（且只挑这两种判定方式）', () => {
    assertEqual(
      RULES.map((ref) => ref.rule.id).sort(),
      ['R-TIME-03', 'R-TIME-04'],
      '四个内置时限规则里只有两条是跨文书（另外两条看单份文书，不摆到轴上）',
    );
    assertEqual(ruleOf('R-TIME-03').kind, 'visit-doc-interval', 'R-TIME-03 是间隔类');
    assertEqual(ruleOf('R-TIME-03').hours, 24, '间隔上限要从包内容里读出来，不能在代码里写死 24');
    assertEqual(ruleOf('R-TIME-04').kind, 'visit-doc-required', 'R-TIME-04 是应有而缺类');
  });

  await test('TL1 轴按**成文时刻**升序；时间坏的排最后但不丢；当前文书标出来', () => {
    const timeline = timelineOf([
      visitDoc('d3', 'WST500.4', hoursAfter(ADMITTED, 60)),
      visitDoc('d1', ADMISSION, ADMITTED),
      visitDoc('d2', PROGRESS, hoursAfter(ADMITTED, 6), { isCurrent: true }),
      visitDoc('d_bad', 'WST500.9', '不是时间'),
    ]);
    assertEqual(
      timeline.docs.map((doc) => doc.docId),
      ['d1', 'd2', 'd3', 'd_bad'],
      '按成文时刻升序；解析不出来的排在最后（不丢，但要让人看出来）',
    );
    assertEqual(timeline.docs.filter((doc) => doc.isCurrent).map((doc) => doc.docId), ['d2'], '当前文书要标出来');
    assertEqual(timeline.docs.find((doc) => doc.docId === 'd_bad')?.timed, false, '时间坏掉的文书要标成 timed:false');
    assert(
      timeline.notes.some((note) => note.includes('无法解析')),
      `有文书时间坏掉时必须说出来，实际：${JSON.stringify(timeline.notes)}`,
    );
  });

  await test('TL2 轴与谓词**等价**：命中 ⇔ 出现超限段，且依据文字逐字相同', () => {
    /* 判定时刻取入院后 40 小时：让"相邻两份之间"成为最宽的一段（否则末尾那段会盖过它） */
    const visitDocs = [
      visitDoc('prog1', PROGRESS, ADMITTED),
      visitDoc('prog2', PROGRESS, hoursAfter(ADMITTED, 30)),
    ];
    const ref = ruleOf('R-TIME-03');
    const verdict = verdictOf(ref, visitDocs, { now: hoursAfter(ADMITTED, 40) });
    const timeline = timelineOf(visitDocs, { now: hoursAfter(ADMITTED, 40) });

    assertEqual(verdict.kind, 'hit', '前置：30 小时间隔应命中');
    const gap = timeline.gaps.find((item) => item.ruleId === 'R-TIME-03');
    assert(!!gap, '命中就必须在轴上出现缺口 —— 少了它，医生看到的是"一条连着的线"');
    assertEqual(gap?.detail, verdict.kind === 'hit' ? verdict.detail : '', '两处依据必须逐字相同（措辞只该有一处）');
    assertEqual(gap?.segment?.fromDocId, 'prog1', '缺口要定位到是哪两份之间');
    assertEqual(gap?.segment?.toDocId, 'prog2', '缺口要定位到是哪两份之间');
    assertEqual(Math.round((gap?.segment?.hours ?? 0) * 10) / 10, 30, '段上要写出实际小时数');
    assertEqual(gap?.segment?.exceeds, true, '超过时限的那一段必须被标出来');

    const quiet = timelineOf(
      [visitDoc('prog1', PROGRESS, ADMITTED), visitDoc('prog2', PROGRESS, hoursAfter(ADMITTED, 6))],
      { now: hoursAfter(ADMITTED, 10) },
    );
    assertEqual(
      quiet.segments.filter((segment) => segment.exceeds).length,
      0,
      '两段（6 小时与 4 小时）都在 24 小时内，轴上不该有超限段',
    );
    assertEqual(
      quiet.gaps.map((item) => item.ruleId),
      [],
      '没有超限就不该有缺口（阙值附近的假阳性会让整套提示被忽略）',
    );
  });

  await test('TL3 **已出院**：右端取出院时刻，不把"出院之后"算成缺口', () => {
    const dischargedAt = hoursAfter(ADMITTED, 12);
    const timeline = timelineOf(
      [visitDoc('prog1', PROGRESS, ADMITTED), visitDoc('prog2', PROGRESS, hoursAfter(ADMITTED, 6))],
      { dischargedAt, now: hoursAfter(ADMITTED, 12) },
    );
    assertEqual(timeline.endAt, dischargedAt, '间隔判定的右端应落在出院时刻上');
    assertEqual(timeline.gaps.map((item) => item.ruleId), [], '出院之后的空白不该算成缺漏');
    assertEqual(
      timeline.segments.filter((segment) => segment.toDocId === null).map((segment) => Math.round(segment.hours)),
      [6],
      '末段只算到出院为止（6 小时）',
    );
  });

  await test('TL4 应有而缺：缺口带**期限**，但轴上不画段（它断的不是两段之间）', () => {
    const timeline = timelineOf([visitDoc('a1', ADMISSION, hoursAfter(ADMITTED, 30))]);
    const gap = timeline.gaps.find((item) => item.ruleId === 'R-TIME-04');
    assert(!!gap, '期限内没有入院记录应命中');
    assertEqual(gap?.segment, null, '"压根没有"没有段可画：硬画一段会让人以为"这两份之间有间隔"');
    assertEqual(gap?.deadlineAt, hoursAfter(ADMITTED, 24), '期限要算出来（界面上要说清"到期时还没有"）');
    const verdict = verdictOf(ruleOf('R-TIME-04'), [visitDoc('a1', ADMISSION, hoursAfter(ADMITTED, 30))]);
    assertEqual(gap?.detail, verdict.kind === 'hit' ? verdict.detail : '', '依据同样要逐字相同');
  });

  await test('TL5 画不出来必须说出来：时间坏掉 / 缺入院时间都进 `unevaluated`', () => {
    const broken = timelineOf([
      visitDoc('prog1', PROGRESS, ADMITTED),
      visitDoc('prog2', PROGRESS, '不是时间'),
    ]);
    assert(
      broken.unevaluated.some((item) => item.ruleId === 'R-TIME-03' && item.reason.includes('prog2')),
      `时间坏掉的文书要让间隔规则报"判不了"（跳过等于把缺漏算成正常），实际：${JSON.stringify(broken.unevaluated)}`,
    );
    assertEqual(
      broken.segments.some((segment) => segment.docTypeCode === PROGRESS),
      false,
      '时间坏掉时那一条线画不出来 —— 但不能因此画一条"看起来是连着的"线',
    );

    const noAdmission = timelineOf([visitDoc('d1', PROGRESS, ADMITTED)], { admittedAt: undefined });
    assert(
      noAdmission.unevaluated.some((item) => item.ruleId === 'R-TIME-04' && item.reason.includes('入院')),
      `缺入院时间时"应有而缺"判不了，要如实上报，实际：${JSON.stringify(noAdmission.unevaluated)}`,
    );
  });

  await test('TL6 趋势对照：后续文书**再次记录同一编码**或正文提到名称，都算"写进去了"', () => {
    const timeline = timelineOf([
      visitDoc('d_adm', ADMISSION, ADMITTED, {
        doc: docWith('d_adm', '入院时白细胞升高。', [
          { id: 'f_wbc', order: 10, value: 15.2, valueText: '15.2', sampledAt: ADMITTED, sourceKey: 'LIS.WBC', range: RANGE, tags: [WBC_TAG] },
        ]),
      }),
      visitDoc('d_prog', PROGRESS, hoursAfter(ADMITTED, 6), {
        doc: docWith('d_prog', '复查：白细胞较前下降。', [
          { id: 'f_wbc2', order: 10, value: 9.8, valueText: '9.8', sampledAt: hoursAfter(ADMITTED, 6), sourceKey: 'LIS.WBC', range: RANGE, tags: [WBC_TAG] },
        ]),
      }),
    ]);
    const change = timeline.trend.changes[0];
    assert(!!change, '异常点应进入对照');
    assertEqual(change?.flag, 'high', '15.2 高于参考范围上限 10');
    assertEqual(change?.unwritten, false, '后续文书再次记录了同一编码 → 算写进去了');
    assertEqual(change?.writtenIn, [{ docId: 'd_prog', how: 'element' }], '要说明是"记了数据元"而不是"提到了名字"');
    assert(timeline.trend.progressDocIds.includes('d_prog'), '参与对照的后续文书要列出来');

    const byText = timelineOf([
      visitDoc('d_adm', ADMISSION, ADMITTED, {
        doc: docWith('d_adm', '入院时白细胞升高。', [
          { id: 'f_wbc', order: 10, value: 15.2, valueText: '15.2', sampledAt: ADMITTED, sourceKey: 'LIS.WBC', range: RANGE, tags: [WBC_TAG] },
        ]),
      }),
      visitDoc('d_prog', PROGRESS, hoursAfter(ADMITTED, 6), {
        doc: docWith('d_prog', '今日白细胞计数较前下降，继续观察。', []),
      }),
    ]);
    assertEqual(byText.trend.changes[0]?.writtenIn, [{ docId: 'd_prog', how: 'text' }], '正文提到名称应记为 text 命中');
    assertEqual(byText.trend.changes[0]?.unwritten, false, '提到了就不该报"没写"');
  });

  await test('TL7 对照不了 ≠ 已写入：后面没有文书 / 缺采样时间都进 `skipped`', () => {
    const noLater = timelineOf([
      visitDoc('d_adm', ADMISSION, ADMITTED, {
        doc: docWith('d_adm', '入院时白细胞升高。', [
          { id: 'f_wbc', order: 10, value: 15.2, valueText: '15.2', sampledAt: ADMITTED, sourceKey: 'LIS.WBC', range: RANGE, tags: [WBC_TAG] },
        ]),
      }),
    ]);
    assertEqual(noLater.trend.changes.length, 0, '这是最后一份文书，没有更晚的文书可比');
    assert(
      noLater.trend.skipped.some((item) => item.reason.includes('没有更晚的文书')),
      `判不了要说出来，实际：${JSON.stringify(noLater.trend.skipped)}`,
    );

    const noSampleTime = timelineOf([
      visitDoc('d_adm', ADMISSION, ADMITTED, {
        doc: docWith('d_adm', '入院时白细胞升高。', [
          { id: 'f_wbc', order: 10, value: 15.2, valueText: '15.2', sourceKey: 'LIS.WBC', range: RANGE, tags: [WBC_TAG] },
        ]),
      }),
      visitDoc('d_prog', PROGRESS, hoursAfter(ADMITTED, 6), { doc: docWith('d_prog', '', []) }),
    ]);
    assertEqual(noSampleTime.trend.changes.length, 0, '没有采样时间的点无法与后续文书比先后');
    assert(
      noSampleTime.trend.skipped.some((item) => item.reason.includes('采样时间')),
      `缺采样时间要说出来（不能并进"写进去了"），实际：${JSON.stringify(noSampleTime.trend.skipped)}`,
    );
  });

  await test('TL8 没有正文时如实说：趋势无从对照，而不是"没有异常"', () => {
    const timeline = timelineOf([visitDoc('d1', ADMISSION, ADMITTED), visitDoc('d2', PROGRESS, hoursAfter(ADMITTED, 6))]);
    assertEqual(timeline.trend.changes.length, 0, '没给正文就没有可对照的变化');
    assert(
      timeline.trend.skipped.some((item) => item.reason.includes('没有带上任何文书的正文')),
      `要写明是"没带正文"而不是"没有异常"，实际：${JSON.stringify(timeline.trend.skipped)}`,
    );
  });

  await test('TL9 空就诊与无规则：轴为空 / 没有间隔规则时都要说清楚', () => {
    const empty = buildVisitTimeline({ now: NOW, visitDocs: [], rules: RULES });
    assertEqual(empty.docs.length, 0, '没有文书时轴是空的');
    assertEqual(empty.gaps.length, 0, '两条跨文书规则都判不了或没触发');
    assert(
      empty.notes.some((note) => note.includes('没有已加载的文书')),
      `空轴要说出来，实际：${JSON.stringify(empty.notes)}`,
    );

    const noRules = buildVisitTimeline({ now: NOW, visitDocs: [visitDoc('d1', PROGRESS, ADMITTED)], rules: [] });
    assert(
      noRules.notes.some((note) => note.includes('没有启用')),
      `一条间隔规则都没有时要说清"轴上标不出时限"，实际：${JSON.stringify(noRules.notes)}`,
    );
    assertEqual(noRules.gaps.length, 0, '没有规则就没有缺口（时间轴自己不会发明判定）');
  });

  process.exit(suite.report());
}

void main();
