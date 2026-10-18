// 跨文书时限（频次 / 应有）自测（V1~V8）。

import { TestSuite, assert, assertEqual } from '../testing/harness.ts';
import { fileURLToPath } from 'node:url';
import type { DocNode, NodeId } from '../model/types.ts';
import { qcContextOf, runFormRules, type QcContext, type QcNodeView } from './form-rules.ts';
import { compileRuleDescriptor } from './rule-pack.ts';
import { readSamplePack, SAMPLE_PACK_FILES } from '../knowledge/sample-packs.ts';
import type { QcRulePack } from './types.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
/** 规则来自样例包（`samples/packs/qc.timelimit.builtin.json`），不再有代码里的内置包  */
const TIME_PACK = readSamplePack(ROOT, SAMPLE_PACK_FILES.timeRules) as QcRulePack;

const suite = new TestSuite('跨文书时限自测', [
  '说明：验证频次/间隔与"应有而缺"的判定方向、假阳性防护，以及"拿不到清单就不判"。',
  '全部离线：跨文书的事实由上下文提供（`visitDocs`），判定本身仍是纯函数。',
]);

const test = (name: string, fn: () => void | Promise<void>): Promise<void> => suite.test(name, fn);

const NOW = '2026-10-12T00:00:00Z';
const ADMITTED = '2026-10-05T03:00:00Z';
const hoursAfter = (base: string, h: number): string => new Date(Date.parse(base) + h * 3_600_000).toISOString();

const doc = (docId: string, docTypeCode: string, createdAt: string, title = '') => ({ docId, docTypeCode, createdAt, ...(title ? { title } : {}) });

/** 住院 + 入院时刻 + 该就诊的文书清单 */
const ctx = (visitDocs: Array<{ docId: string; docTypeCode: string; createdAt: string; title?: string }>, extra: Partial<QcContext> = {}): QcContext => ({
  now: NOW,
  admittedAt: ADMITTED,
  docTypeCode: 'WST500.1',
  visitType: 'inpatient',
  visitDocs,
  ...extra,
});

/** 样例时限包里的规则（走的是与医院自备包完全相同的路径）  */
const rules = TIME_PACK.items.map((item) => compileRuleDescriptor(TIME_PACK.packId, item));

function outcomeOf(id: string, view: QcNodeView, context: QcContext) {
  const rule = rules.find((item) => item.id === id);
  assert(!!rule, `前置：样例时限包里应有 ${id}`);
  const result = (rule as (typeof rules)[number]).check(view, context);
  if (result === null) return { kind: 'none' as const };
  if ('uncertain' in result) return { kind: 'uncertain' as const, reason: result.uncertain };
  return { kind: 'hit' as const, detail: result.detail, suggestion: result.suggestion };
}

const docView = (recordedAt = NOW): QcNodeView => ({
  nodeId: 'n_root' as NodeId,
  type: 'document',
  text: '',
  tags: [],
  keyContent: false,
  recordedAt,
  origin: 'human',
});

function codeOf(fn: () => unknown): string {
  try {
    fn();
    return '(未报错)';
  } catch (err) {
    return String((err as { code?: string }).code ?? '(无码)');
  }
}

const PROGRESS = 'WST500.3';
const ADMISSION = 'WST500.1';

async function main(): Promise<void> {
  await test('V1 间隔超限命中：相邻两份病程记录之间超过 24 小时，依据写明"哪两份、多长"', () => {
    /* 判定时刻取入院后 40 小时（而不是默认的"现在"）：这条要验的是"相邻两份之间"，
       若判定时刻远在最后一份之后，末尾那一段会大过相邻间隔，报出来的就不是这条了。
       实测踩到：夹具没造干净时，V1 报的是 125 小时（末尾那段）。  */
    const outcome = outcomeOf(
      'R-TIME-03',
      docView(),
      ctx([doc('d1', PROGRESS, ADMITTED), doc('d2', PROGRESS, hoursAfter(ADMITTED, 30))], { now: hoursAfter(ADMITTED, 40) }),
    );
    assertEqual(outcome.kind, 'hit', '30 小时间隔 > 24 小时应命中');
    const detail = outcome.kind === 'hit' ? outcome.detail : '';
    assert(detail.includes('30.0'), `依据里要写出实际最长间隔，实际：${detail}`);
    assert(detail.includes('d1') && detail.includes('d2'), `依据里要写出是哪两份之间，实际：${detail}`);
    assert(detail.includes('24'), '依据里要写出时限本身');
  });

  await test('V2 末尾那一段也要判：最后一份之后一直没写，正是最常见的缺漏', () => {
    /* 两份之间只隔 10 小时（不超），但最后一份距离"现在"已 168 小时 */
    const outcome = outcomeOf('R-TIME-03', docView(), ctx([doc('d1', PROGRESS, ADMITTED), doc('d2', PROGRESS, hoursAfter(ADMITTED, 10))]));
    assertEqual(outcome.kind, 'hit', '末尾间隔超限应命中');
    const detail = outcome.kind === 'hit' ? outcome.detail : '';
    assert(detail.includes('判定时刻'), `末尾那一段的右端应是判定时刻，实际：${detail}`);
  });

  await test('V3 **已出院**：右端取出院时刻，不把"出院之后"算成缺漏', () => {
    const dischargedAt = hoursAfter(ADMITTED, 12);
    /* 出院后 6 天没写病程记录 —— 这不该报（病人已经出院了） */
    const outcome = outcomeOf('R-TIME-03', docView(), ctx([doc('d1', PROGRESS, ADMITTED), doc('d2', PROGRESS, hoursAfter(ADMITTED, 6))], { dischargedAt }));
    assertEqual(outcome.kind, 'none', '出院之后的间隔不该算成缺漏（这是最容易被当成系统坏了的假阳性）');

    /* 而出院之前确实断了 30 小时 → 该报，且右端说明是出院时刻  */
    const bad = outcomeOf('R-TIME-03', docView(), ctx([doc('d1', PROGRESS, ADMITTED), doc('d2', PROGRESS, hoursAfter(ADMITTED, 30))], { dischargedAt: hoursAfter(ADMITTED, 40) }));
    assertEqual(bad.kind, 'hit', '出院前的真实断档仍应报');
  });

  await test('V4 拿不到文书清单 → **未判定**（不猜"都写齐了"）', () => {
    const outcome = outcomeOf('R-TIME-03', docView(), ctx([], { visitDocs: undefined }));
    assertEqual(outcome.kind, 'uncertain', '没有清单就不能算频次');
    assert(outcome.kind === 'uncertain' && outcome.reason.includes('清单'), `原因要说清缺的是清单，实际：${outcome.kind === 'uncertain' ? outcome.reason : ''}`);
  });

  await test('V5 时间坏掉的文书 → 未判定（**不静默跳过**，那等于把缺漏算成正常）', () => {
    const outcome = outcomeOf('R-TIME-03', docView(), ctx([doc('d1', PROGRESS, ADMITTED), doc('d2', PROGRESS, '不是时间')]));
    assertEqual(outcome.kind, 'uncertain', '有文书时间不可解析时应判不了');
    assert(outcome.kind === 'uncertain' && outcome.reason.includes('d2'), `原因要指出是哪一份，实际：${outcome.kind === 'uncertain' ? outcome.reason : ''}`);
  });

  await test('V6 应有而缺：期限内没有任何该类文书 → 命中；期限未到或期限内有一份 → 不报', () => {
    /* 入院 24 小时内应有入院记录：只有一份 30 小时后的 → 命中 */
    const missing = outcomeOf('R-TIME-04', docView(), ctx([doc('a1', ADMISSION, hoursAfter(ADMITTED, 30))]));
    assertEqual(missing.kind, 'hit', '期限内没有入院记录应命中');
    const detail = missing.kind === 'hit' ? missing.detail : '';
    assert(detail.includes(ADMISSION), '依据里要写出是哪一类文书');
    assert(detail.includes('a1'), `依据里要写出"其实有一份、但晚了"，实际：${detail}`);

    assertEqual(outcomeOf('R-TIME-04', docView(), ctx([doc('a1', ADMISSION, hoursAfter(ADMITTED, 5))])).kind, 'none', '期限内有一份就不报');

    /* 期限还没到（现在是入院后 10 小时）→ 不报：还没到点就说"没有"是催命，不是质控 */
    const early = outcomeOf('R-TIME-04', docView(), ctx([], { now: hoursAfter(ADMITTED, 10) }));
    assertEqual(early.kind, 'none', '期限未到时不该报');
  });

  await test('V7 分工不重叠：一份都没有时，**间隔规则不报**（那是"应有而缺"的职责）', () => {
    const none = { kind: 'none' as const };
    assertEqual(outcomeOf('R-TIME-03', docView(), ctx([])).kind, none.kind, '一份都没有时，间隔规则不报');
    assertEqual(outcomeOf('R-TIME-04', docView(), ctx([])).kind, 'hit', '同一情形由"应有而缺"报出来');
    /* 两条规则都报 = 同一件事提示两遍，而重复提示的处置是"直接略过" */
  });

  await test('V8 参数校验与节点限定：只对文书级节点判，参数写错在编译期就拒绝', () => {
    /* 章节与文本节点不判频次：频次是就诊/文书级的事实，逐节点判会重复报 */
    const sectionView: QcNodeView = { nodeId: 'n_s1' as NodeId, type: 'section', text: '', tags: [], keyContent: false, recordedAt: NOW, origin: 'human', sectionCode: 'plan' };
    assertEqual(outcomeOf('R-TIME-03', sectionView, ctx([])).kind, 'none', '章节节点不判跨文书时限');

    const raw = (params: unknown) =>
      compileRuleDescriptor('qc.demo.visit', {
        itemId: 'R-DEMO-V',
        title: '跨文书时限',
        severity: 'warn',
        predicate: { kind: 'visit-doc-interval', params },
      } as never);

    assertEqual(codeOf(() => raw({ maxGapHours: 24 })), 'E_RULE_PARAM_INVALID', '缺 docTypeCode 必须拒绝（否则会去统计全部文书）');
    assertEqual(codeOf(() => raw({ docTypeCode: PROGRESS })), 'E_RULE_PARAM_INVALID', '缺 maxGapHours 必须拒绝');
    assertEqual(codeOf(() => raw({ docTypeCode: PROGRESS, maxGapHours: 0 })), 'E_RULE_PARAM_INVALID', '0 小时间隔没有意义');
    assertEqual(codeOf(() => raw({ docTypeCode: PROGRESS, maxGapHours: 24, visitType: 'ICU' })), 'E_RULE_PARAM_INVALID', '就诊类型只认四种');
    assertEqual(codeOf(() => raw({ docTypeCode: PROGRESS, maxGapHours: 24 })), '(未报错)', '合法参数应通过');

    /* 引擎侧：内置包 + 上下文一起跑，跨文书规则进入命中而不是"未判定" */
    const scan = runFormRules(
      { n_root: { id: 'n_root', type: 'document', parentId: null, order: 0, rev: 1, provenance: { origin: 'human', at: NOW } } as unknown as DocNode },
      ctx([doc('d1', PROGRESS, ADMITTED)]),
      rules,
    );
    assert(scan.hits.some((hit) => hit.ruleId === 'R-TIME-03'), `跨文书规则应参与命中，实际：${JSON.stringify(scan.hits.map((h) => h.ruleId))}`);
  });

  await test('V9 上下文构造：`qcContextOf` 只带文书自己的事实，就诊文书清单由调用方补', () => {
    const built = qcContextOf(
      {
        encounter: { visitId: 'V1', visitType: 'inpatient', admittedAt: ADMITTED, dischargedAt: hoursAfter(ADMITTED, 100) },
        docType: { system: 'WST500', code: PROGRESS, display: '病程记录' },
      } as never,
      NOW,
    );
    assertEqual(built.dischargedAt, hoursAfter(ADMITTED, 100), '出院时刻要带进来（它决定频次判定的右端）');
    assertEqual(built.visitDocs, undefined, '**就诊文书清单不在这里取**：一份文书看不到别的文书，那是调用方才知道的事');
  });

  process.exit(suite.report());
}

void main();
