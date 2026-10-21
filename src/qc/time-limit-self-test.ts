import { TestSuite, assert, assertEqual } from '../testing/harness.ts';
import { fileURLToPath } from 'node:url';
import type { DocNode, NodeId } from '../model/types.ts';
import { qcContextOf, runFormRules, type QcContext, type QcNodeView } from './form-rules.ts';
import { compileRuleDescriptor, compileRulePack } from './rule-pack.ts';
import { readSamplePack, SAMPLE_PACK_FILES } from '../knowledge/sample-packs.ts';
import type { QcRulePack } from './types.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const FORM_RULES = compileRulePack(readSamplePack(ROOT, SAMPLE_PACK_FILES.formRules) as QcRulePack);
const TIME_PACK = readSamplePack(ROOT, SAMPLE_PACK_FILES.timeRules) as QcRulePack;

const suite = new TestSuite('时限类质控自测', [
  '说明：验证"入院后 N 小时内完成"的判定方向、未判定通道，以及"用的是哪个时间"这条边界。',
  '全部离线：时限判定是纯函数，不需要模型与网络。',
]);

const test = (name: string, fn: () => void | Promise<void>): Promise<void> => suite.test(name, fn);

/** 判定时刻写死：判定结果不该随运行时刻变化，否则"超时 8 小时 1 分"这种结论没法复核 */
const NOW = '2026-10-12T00:00:00Z';
const ADMITTED = '2026-10-05T03:00:00Z';

const ctx = (extra: Partial<QcContext> = {}): QcContext => ({ now: NOW, admittedAt: ADMITTED, docTypeCode: 'WST500.3', visitType: 'inpatient', ...extra });

const documentNode = (recordedAt: string, origin = 'human'): QcNodeView => ({
  nodeId: 'n_root' as NodeId,
  type: 'document',
  text: '',
  tags: [],
  keyContent: false,
  recordedAt,
  origin,
});

const sectionNode = (sectionCode: string, recordedAt: string): QcNodeView => ({
  nodeId: 'n_s1' as NodeId,
  type: 'section',
  text: '',
  tags: [],
  keyContent: false,
  recordedAt,
  origin: 'human',
  sectionCode,
});

const rules = TIME_PACK.items.map((item) => compileRuleDescriptor(TIME_PACK.packId, item));

function ruleOf(id: string) {
  const rule = rules.find((item) => item.id === id);
  assert(!!rule, `前置：样例时限包里应有 ${id}`);
  return rule as (typeof rules)[number];
}

type Outcome = { kind: 'hit'; detail: string } | { kind: 'uncertain'; reason: string } | { kind: 'none' };

function outcomeOf(id: string, view: QcNodeView, context: QcContext = ctx()): Outcome {
  const result = ruleOf(id).check(view, context);
  if (result === null) return { kind: 'none' };
  if ('uncertain' in result) return { kind: 'uncertain', reason: result.uncertain };
  return { kind: 'hit', detail: result.detail };
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
    return '(未报错)';
  } catch (err) {
    return String((err as { code?: string }).code ?? '(无码)');
  }
}

const plusHours = (base: string, hours: number): string => new Date(Date.parse(base) + hours * 3_600_000).toISOString();

async function main(): Promise<void> {
  await test('T1 命中：入院后 9.5 小时的病程记录，按 8 小时判超时，且依据里写明两个时间', () => {
    const outcome = outcomeOf('R-TIME-02', documentNode('2026-10-05T12:30:00Z'));
    assertEqual(outcome.kind, 'hit', '9.5 小时 > 8 小时应命中');
    const detail = outcome.kind === 'hit' ? outcome.detail : '';
    /* 依据必须自带算式：医生看到"超时"时，第一件想知道的事是"你拿哪两个时间比的"  */
    assert(detail.includes(ADMITTED), `依据里要写出入院时间，实际：${detail}`);
    assert(detail.includes('2026-10-05T12:30:00Z'), `依据里要写出记录时间，实际：${detail}`);
    assert(detail.includes('9.5'), `依据里要写出实际间隔，实际：${detail}`);
    assert(detail.includes('8'), '依据里要写出时限本身');
    assert(detail.includes('R-TIME-02'), '依据里应带规则号（由引擎注入）');
  });

  await test('T2 边界取保守：正好等于时限不报；超出 1 分钟才报', () => {
    assertEqual(outcomeOf('R-TIME-02', documentNode(plusHours(ADMITTED, 8))).kind, 'none', '正好 8 小时算"压线完成"，不该报');
    assertEqual(outcomeOf('R-TIME-02', documentNode(plusHours(ADMITTED, 7.99))).kind, 'none', '不足 8 小时不报');
    assertEqual(outcomeOf('R-TIME-02', documentNode(plusHours(ADMITTED, 8.02))).kind, 'hit', '超出即报（8 小时 1 分）');
  });

  await test('T3 缺入院时间 → **未判定**，绝不等于"没问题"', () => {
    const outcome = outcomeOf('R-TIME-02', documentNode(plusHours(ADMITTED, 30)), ctx({ admittedAt: undefined }));
    assertEqual(outcome.kind, 'uncertain', '没有基线就不能判定');
    assert(outcome.kind === 'uncertain' && outcome.reason.includes('admittedAt'), `原因要说清缺的是哪一个字段，实际：${outcome.kind === 'uncertain' ? outcome.reason : ''}`);
  });

  await test('T4 外部导入件 → 未判定（系统内写入时刻不代表它的临床记录时间）', () => {
    const outcome = outcomeOf('R-TIME-02', documentNode(plusHours(ADMITTED, 300), 'imported'));
    assertEqual(outcome.kind, 'uncertain', '导入件不判时限');
    assert(outcome.kind === 'uncertain' && outcome.reason.includes('导入'), `原因要说清是导入件，实际：${outcome.kind === 'uncertain' ? outcome.reason : ''}`);
  });

  await test('T5 时间不可解析 / 缺记录时间 / 未来时间 → 三种都走未判定', () => {
    const badBaseline = outcomeOf('R-TIME-02', documentNode(plusHours(ADMITTED, 30)), ctx({ admittedAt: '昨天下午' }));
    assertEqual(badBaseline.kind, 'uncertain', '入院时间不可解析应未判定');

    const noRecorded: QcNodeView = { nodeId: 'n_root' as NodeId, type: 'document', text: '', tags: [], keyContent: false };
    assertEqual(outcomeOf('R-TIME-02', noRecorded).kind, 'uncertain', '缺记录时间应未判定');

    const future = outcomeOf('R-TIME-02', documentNode(plusHours(NOW, 1)));
    assertEqual(future.kind, 'uncertain', '记录时间晚于判定时刻应未判定（时钟或数据有问题，算出来的间隔没有意义）');
  });

  await test('T6 目标定位：文书类型 / 就诊类型 / 章节码三个条件各自生效', () => {
    assertEqual(outcomeOf('R-TIME-02', documentNode(plusHours(ADMITTED, 30)), ctx({ docTypeCode: 'WST500.1' })).kind, 'none', '病程记录的规则不应去判入院记录');
    assertEqual(outcomeOf('R-TIME-02', documentNode(plusHours(ADMITTED, 30)), ctx({ visitType: 'outpatient' })).kind, 'none', '门诊文书不适用住院时限');
    const textView: QcNodeView = { nodeId: 'n_x' as NodeId, type: 'text', text: '患者诉咳嗽。', tags: [], keyContent: false, recordedAt: plusHours(ADMITTED, 30), origin: 'human' };
    assertEqual(outcomeOf('R-TIME-02', textView).kind, 'none', '文本节点不判时限');

    const docWithSections = {
      n_root: node('n_root', 'document', plusHours(ADMITTED, 30)),
      n_s1: section('n_s1', 'chiefComplaint', plusHours(ADMITTED, 30)),
      n_s2: section('n_s2', 'presentIllness', plusHours(ADMITTED, 30)),
      n_s3: section('n_s3', 'diagnosis', plusHours(ADMITTED, 30)),
    };
    const docLevelScan = runFormRules(docWithSections, ctx(), rules);
    assertEqual(
      docLevelScan.hits.filter((hit) => hit.ruleId === 'R-TIME-02').length,
      1,
      '文书级时限规则对一份文书只报一次（不逐章节重复）',
    );

    const bySection = compileRuleDescriptor(
      'qc.demo.section',
      {
        itemId: 'R-DEMO-SEC',
        title: '首次病程记录未在 8 小时内完成',
        severity: 'warn',
        predicate: { kind: 'document-time-limit', params: { limitHours: 8, sectionCode: 'conditionChange' } },
      } as never,
    );
    const hit = bySection.check(sectionNode('conditionChange', plusHours(ADMITTED, 20)), ctx());
    assert(hit !== null && !('uncertain' in hit), '章节码对得上且超时应命中');
    assertEqual(bySection.check(sectionNode('labResult', plusHours(ADMITTED, 20)), ctx()), null, '章节码对不上不判');
  });

  await test('T7 参数不合法一律在编译期拒绝（不做兜底）', () => {
    const raw = (params: unknown) =>
      compileRuleDescriptor('qc.demo.rule', {
        itemId: 'R-DEMO-T',
        title: '时限',
        severity: 'warn',
        predicate: { kind: 'document-time-limit', params },
      } as never);

    assertEqual(codeOf(() => raw({})), 'E_RULE_PARAM_INVALID', '缺 limitHours 必须拒绝 —— 兜底会让"所有文书都超时"');
    assertEqual(codeOf(() => raw({ limitHours: 0 })), 'E_RULE_PARAM_INVALID', '0 小时没有意义');
    assertEqual(codeOf(() => raw({ limitHours: -8 })), 'E_RULE_PARAM_INVALID', '负数时限没有意义');
    assertEqual(codeOf(() => raw({ limitHours: 8, sectionCode: '' })), 'E_RULE_PARAM_INVALID', '空串会被当成"没有过滤条件"从而对全部文书生效');
    assertEqual(codeOf(() => raw({ limitHours: 8, visitType: 'ICU' })), 'E_RULE_PARAM_INVALID', '就诊类型只认四种');
    assertEqual(codeOf(() => raw({ limitHours: 8, limit: 9 })), 'E_RULE_PARAM_INVALID', '拼错的参数名必须拒绝（否则"我配的没生效"查不出来）');
    assertEqual(codeOf(() => raw({ limitHours: 8, docTypeCode: 'WST500.3' })), '(未报错)', '合法参数应通过');
  });

  await test('T8 引擎侧：未判定单独成栏，**不混进命中**，且两者可以同时存在', () => {
    const nodes = {
      n_root: node('n_root', 'document', plusHours(ADMITTED, 30)),
      n_imp: node('n_imp', 'document', plusHours(ADMITTED, 30), 'imported'),
    };
    const scan = runFormRules(nodes, ctx(), [...FORM_RULES, ...rules]);

    assert(scan.hits.some((hit) => hit.ruleId === 'R-TIME-02'), `超时的病程记录应命中，实际命中：${JSON.stringify(scan.hits.map((h) => h.ruleId))}`);
    assert(scan.unevaluated.length > 0, '同一份文档里"没判成"的那些要单独列出来（导入件同在这个批次里）');
    assert(
      scan.unevaluated.some((item) => item.reason.includes('导入')),
      `未判定的原因要说得具体，实际：${JSON.stringify(scan.unevaluated.map((item) => item.reason))}`,
    );
    assert(
      scan.hits.every((hit) => !hit.detail.includes('无法计算')),
      '未判定的条目不得出现在命中里',
    );
    const reasons = scan.unevaluated.map((item) => item.reason);
    assert(reasons.every((reason) => reason.includes('规则 R-TIME-')), `未判定的原因要能追到规则，实际：${JSON.stringify(reasons.slice(0, 2))}`);
  });

  await test('T9 门诊文书：形式类照常判，时限类如实"未判定"（这就是演示工作区的实际形态）', () => {
    const outpatientCtx: QcContext = { now: NOW, docTypeCode: 'WST500.2', visitType: 'outpatient' };
    const nodes = {
      n_root: node('n_root', 'document', '2026-10-08T01:00:00Z'),
      n_t1: text('n_t1', '患者无明显诱因出现咳嗽，咳白色黏痰，伴发热。', '2026-10-08T01:00:00Z'),
    };
    const scan = runFormRules(nodes, outpatientCtx, [...FORM_RULES, ...rules]);

    assert(scan.hits.some((hit) => hit.ruleId === 'R-FORM-01'), '形式类规则应照常命中（它不需要入院时间）');
    assertEqual(
      scan.unevaluated.filter((item) => item.ruleId.startsWith('R-TIME-')).length,
      0,
      '文书类型对不上的规则应"不适用"，不进未判定',
    );
    assert(
      scan.hits.every((hit) => !hit.ruleId.startsWith('R-TIME-')),
      '时限规则不得因为"没基线"而产出命中',
    );
  });

  await test('T10 上下文由文档事实构造：缺哪个字段就不带哪个，不臆造默认值', () => {
    const full = qcContextOf(
      {
        encounter: { visitId: 'V1', visitType: 'inpatient', admittedAt: ADMITTED },
        docType: { system: 'WST500', code: 'WST500.3', display: '病程记录' },
      } as never,
      NOW,
    );
    assertEqual(full.admittedAt, ADMITTED, '有入院时间就带');
    assertEqual(full.docTypeCode, 'WST500.3', '有文书类型码就带');
    assertEqual(full.visitType, 'inpatient', '有就诊类型就带');

    const bare = qcContextOf({ nodes: {} } as never, NOW);
    assertEqual(bare.admittedAt, undefined, '没有 encounter 就**不带** admittedAt —— 不能填个默认值让它看起来能判');
    assertEqual(bare.now, NOW, '判定时刻始终由调用方给');
  });

  process.exit(suite.report());
}

function node(id: string, type: string, recordedAt: string, origin = 'human'): DocNode {
  return { id, type, parentId: null, order: 0, rev: 1, provenance: { origin, at: recordedAt } } as unknown as DocNode;
}

function section(id: string, sectionCode: string, recordedAt: string): DocNode {
  return { id, type: 'section', sectionCode, parentId: 'n_root', order: 10, rev: 1, provenance: { origin: 'human', at: recordedAt } } as unknown as DocNode;
}

function text(id: string, body: string, recordedAt: string): DocNode {
  return { id, type: 'text', runs: [{ text: body }], parentId: 'n_root', order: 20, rev: 1, provenance: { origin: 'human', at: recordedAt } } as unknown as DocNode;
}

void main();
