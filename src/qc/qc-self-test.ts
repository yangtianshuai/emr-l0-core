/**
 * 形式类质控规则包自测（Q1~Q6）。
 *
 * 说明：本套件**全部离线、不需要文档模型**（引擎只吃 `nodes`），也不连任何服务 ——
 * 这正是形式类质控该有的性质：规则是可判定的纯函数，跑一次是毫秒级的事。
 *
 * 重点锁死的五条：
 *   Q1 **纯函数**：同输入两次结果完全一致、且**不修改输入**（有副作用就没法穷举验证）；
 *   Q2/Q3/Q4 三条规则各自的**保守方向**（宁可不报，不可误报）；
 *   Q5 每条命中都**可解释**（带规则号与判定依据，医生据此复核）；
 *   Q6 `severity` 只是展示级别：**不阻断写、不阻断签章**（引擎压根没有这个能力）。
 */

import { TestSuite, assert, assertEqual } from '../testing/harness.ts';
import { fileURLToPath } from 'node:url';
import type { DocNode, NodeId } from '../model/types.ts';
import { listFormRules, runFormRules, type QcContext, type QcNodeView, type QcRule } from './form-rules.ts';
import { compileRulePack } from './rule-pack.ts';
import { readSamplePack, SAMPLE_PACK_FILES } from '../knowledge/sample-packs.ts';
import type { QcRulePack } from './types.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/**
 * 本套件用的规则集：**就是样例包里那一份**（`samples/packs/qc.form.builtin.json`），
 * 走的是与生产完全相同的编译路径。
 *
 * 引擎的 `rules` 现在**必填**（`form-rules.ts` 里那个 `FORM_RULES` 兜底已经删掉）——
 * 兜底会把"这台机器一个规则包都没装"悄悄变成"用内置那套跑"。
 * 这里显式给规则，就是在替测试里的"这台机器"声明它装了哪一份包。
 */
const FORM_RULES: QcRule[] = compileRulePack(readSamplePack(ROOT, SAMPLE_PACK_FILES.formRules) as QcRulePack);

const suite = new TestSuite('形式类质控规则包自测', [
  '说明：验证规则的**判定方向**（保守）、可解释性，以及引擎无副作用。',
  '全部离线：形式类质控不依赖任何外部接口，这是它今天就能用的原因。',
]);

const test = (name: string, fn: () => void | Promise<void>): Promise<void> => suite.test(name, fn);

const AT = '2026-10-09T10:00:00.000Z';

/** 只构造规则会读的字段；用断言绕过 DocNode 的其余必填项（引擎也确实不读它们） */
function textNode(id: string, text: string, extra: { tags?: string[]; keyContent?: boolean } = {}): DocNode {
  return {
    id,
    type: 'text',
    runs: [{ text }],
    rev: 1,
    provenance: { origin: 'human', at: AT },
    ...extra,
  } as unknown as DocNode;
}

const nodesOf = (spec: Record<string, DocNode>): Record<NodeId, DocNode> => spec as Record<NodeId, DocNode>;

function viewOf(text: string, extra: Partial<QcNodeView> = {}): QcNodeView {
  return { nodeId: 'n_1' as NodeId, type: 'text', text, tags: [], keyContent: false, ...extra };
}

/**
 * 判定上下文。**显式写死一个时刻**：形式类这三条规则用不到它，但引擎契约要求传 ——
 * 而"写死"正是重点：判定结果不该随运行时刻变化，否则"同一份病历跑两次结论不同"就无从复核。
 */
const TEST_CTX: QcContext = { now: '2026-10-12T00:00:00Z' };

/**
 * 把判定的**三态**收敛成用例能断言的两态：
 * 命中 → 命中内容；不适用 → `null`；**"判不了" → 直接让用例失败**。
 *
 * 为什么第三种要失败而不是当成 null：形式类规则没有任何"判不了"的理由。
 * 若哪天它开始返回"判不了"，那说明有新情况混进了这条规则 —— 用例就该拦下来看，
 * 而不是把它悄悄读成"没问题"。
 */
function checkOrNull(rule: QcRule, view: QcNodeView): { detail: string; suggestion: string; quote?: string } | null {
  const result = rule.check(view, TEST_CTX);
  assert(!(result && 'uncertain' in result), `形式类规则不该出现"判不了"：${result && 'uncertain' in result ? result.uncertain : ''}`);
  return result as { detail: string; suggestion: string; quote?: string } | null;
}

async function main(): Promise<void> {
  await test('Q1 纯函数：两次结果完全一致，且**不修改输入**', () => {
    const nodes = nodesOf({
      n_1: textNode('n_1', '患者三天前出现咳嗽，无发热。'),
      n_2: textNode('n_2', '待补充'),
    });
    const before = JSON.stringify(nodes);

    const first = runFormRules(nodes, TEST_CTX, FORM_RULES);
    const second = runFormRules(nodes, TEST_CTX, FORM_RULES);

    assertEqual(JSON.stringify(first), JSON.stringify(second), '同输入两次必须得到完全一致的结果（否则医生会看到提示随机跳动）');
    assertEqual(JSON.stringify(nodes), before, '**引擎不得修改输入**（有副作用就无法穷举验证）');
    assertEqual(first.scannedNodes, 2, '应如实上报扫描了多少节点');
    assertEqual(first.rules, FORM_RULES.length, '应上报规则条数');
    assert(first.hits.length > 0, '这两段应命中规则（前置假设）');

    /* 顺序稳定：命中顺序与传入顺序一致，不依赖内部哈希 */
    const reordered = runFormRules(
      nodesOf({ n_2: textNode('n_2', '待补充'), n_1: textNode('n_1', '患者三天前出现咳嗽，无发热。') }),
      TEST_CTX,
      FORM_RULES,
    );
    assertEqual(reordered.hits.length, first.hits.length, '节点插入顺序不同，命中条数应一致');
  });

  await test('Q2 R-FORM-01 保守判定：认得出时间就不报；过短的段落不报', () => {
    const rule = FORM_RULES[0] as (typeof FORM_RULES)[number];
    const id = rule.id;
    assertEqual(id, 'R-FORM-01', '前置：第一条应是"缺记录时间"');
    const check = (view: QcNodeView) => checkOrNull(rule, view);

    /* 各种时间写法都应被认出来 —— 认得越少，误报越多 */
    for (const text of [
      '2026-10-09 患者诉咳嗽加重，伴咳痰。',
      '2026年10月9日 查体：双肺呼吸音粗。',
      '10月9日 14:30 患者体温 38.5℃。',
      '14时 患者出现寒战，予对症处理。',
    ]) {
      assertEqual(check(viewOf(text)), null, `含时间表述不应报：${text.slice(0, 12)}…`);
    }

    /* 真正缺时间的记录类段落才报 */
    const hit = check(viewOf('患者三天前无明显诱因出现咳嗽，咳白色黏痰，伴发热。'));
    assert(hit !== null, '记录类段落完全没有时间表述时应报');
    assert(String(hit?.detail).includes('R-FORM-01'), '依据里应写明规则号');
    assert(String(hit?.detail).length > 20, 'detail 要说清判定依据，不能只给结论');

    /* 过短的文本不判：标题、短标签本来就不需要时间，对它们报就是纯噪声 */
    assertEqual(check(viewOf('现病史：')), null, '短文本（标题类）不应报');
    assertEqual(check(viewOf('现病史：', { type: 'section' })), null, '非文本节点不应报');
  });

  await test('Q3 R-FORM-02 只报"带数据元标签且正文为空"；无标签的空白不报', () => {
    const rule = FORM_RULES[1] as (typeof FORM_RULES)[number];
    assertEqual(rule.id, 'R-FORM-02', '前置：第二条应是"必填为空"');
    const check = (view: QcNodeView) => checkOrNull(rule, view);

    const hit = check(viewOf('', { tags: ['DE-001'] }));
    assert(hit !== null, '带标签且为空应报');
    assert(String(hit?.detail).includes('DE-001'), '依据里应列出数据元标签，医生才能核对');

    /* 保守方向：没有标签的空白段落可能本就不必填 —— 报它是误伤，而误伤会让医生忽略全部提示 */
    assertEqual(check(viewOf('', { tags: [] })), null, '没有数据元标签的空白段落不应报');
    assertEqual(check(viewOf('内容已填', { tags: ['DE-001'] })), null, '有内容的段落不应报');
    assertEqual(check(viewOf('   ', { tags: [] })), null, '无标签的纯空白不应报');
  });

  await test('Q4 R-FORM-03 占位符：quote 取**命中片段本身**（不是整段）', () => {
    const rule = FORM_RULES[2] as (typeof FORM_RULES)[number];
    assertEqual(rule.id, 'R-FORM-03', '前置：第三条应是"占位符未替换"');
    const check = (view: QcNodeView) => checkOrNull(rule, view);

    const hit = check(viewOf('患者于待补充入院，主诉胸痛3天。'));
    assert(hit !== null, '含"待补充"应报');
    /* 关键：quote 若取整段，那么"改了一个字"也会被判成"原文还在"，
       锚点重定位就失去意义（它本该只在原文确实还在时才重定位） */
    assertEqual(hit?.quote, '待补充', 'quote 应只是命中片段，不是整段');

    for (const text of ['患者无药物过敏史。', '（既往史见前次住院记录）', '体格检查：双肺呼吸音清。']) {
      assertEqual(check(viewOf(text)), null, `正常内容不应报：${text.slice(0, 10)}…`);
    }
  });

  await test('Q5 每条命中都可解释：带规则号、判定依据与建议动作', () => {
    const nodes = nodesOf({
      n_1: textNode('n_1', '患者三天前出现咳嗽，咳白色黏痰。'),
      n_2: textNode('n_2', '', { tags: ['DE-002'] }),
      n_3: textNode('n_3', '既往史：待补充。'),
    });
    const result = runFormRules(nodes, TEST_CTX, FORM_RULES);
    assertEqual(result.hits.length, 3, '三段应各命中一条');

    for (const hit of result.hits) {
      assert(hit.ruleId.startsWith('R-FORM-'), `每条命中都必须带规则号，实际 ${hit.ruleId}`);
      assert(hit.detail.includes(hit.ruleId), '判定依据里应写明规则号（医生据此查规则）');
      assert(hit.detail.trim().length > 15, '判定依据不能只是复述结论');
      assert(hit.suggestion.trim().length > 5, '必须给出可执行的动作，否则医生只知道"有问题"却不知做什么');
      assert(hit.severity === 'warn', `形式类提示不应是更高级别，实际 ${hit.severity}`);
    }

    const ids = listFormRules(FORM_RULES).map((rule) => rule.id);
    assertEqual(ids, ['R-FORM-01', 'R-FORM-02', 'R-FORM-03'], '规则清单应能列出来（界面要展示"这台机器在跑哪些规则"，而不是让人猜）');
  });

  await test('Q6 只报不阻断：severity 仅是展示级别，引擎没有落笔/拦截能力', () => {
    /* 结构级证明：引擎的返回值只有命中列表与计数，**没有任何写操作通道**。
       它不是"我们承诺不阻断"，而是"它拿不到能阻断的东西" ——
       一旦让规则间接拥有流程控制权，一条误报就会让病历签不出去，而临床不会等规则。 */
    const result = runFormRules(nodesOf({ n_1: textNode('n_1', '患者三天前出现咳嗽。') }), TEST_CTX, FORM_RULES);
    /* 产出里**仍然没有任何"是否放行/是否阻断"的字段**；`unevaluated` 是**报告**不是闸门 ——
       它只说明"这几条没判成"，改不了"能不能签、能不能存"（引擎手里没有那样的能力）。 */
    assertEqual(
      Object.keys(result).sort(),
      ['hits', 'rules', 'scannedNodes', 'unevaluated'],
      '引擎产出应只有命中、计数与"未判定"报告，不含任何"是否放行/是否阻断"的字段',
    );
    assert(result.hits.every((hit) => hit.severity !== 'block'), '形式类规则不应产出 block 级别');
  });

  process.exit(suite.report());
}

void main();
