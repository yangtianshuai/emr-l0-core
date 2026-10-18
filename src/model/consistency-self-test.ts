// 跨文书一致性检查自测（L2 · I6）。

import { TestSuite, assert, assertEqual } from '../testing/harness.ts';
import { checkConsistency, toSuggestionDrafts } from './consistency.ts';
import type { DataElementTag, MachineReadableBlock } from './types.ts';

const suite = new TestSuite('跨文书一致性检查自测', [
  '说明：只做编码级、可复现、零误报的比对；语义矛盾不在范围内（需要评测集才能声称误报率）。',
  'C4/C6 是防误报的关键：把正常波动或文字差异报成矛盾，会让医生此后忽略所有提示。',
]);

const test = (name: string, fn: () => void | Promise<void>): Promise<void> => suite.test(name, fn);

function block(elements: Array<{ tag: DataElementTag; value: string }>): MachineReadableBlock {
  return {
    generatedAt: '2026-10-08T10:00:00Z',
    generator: 'consistency-self-test',
    sourceHash: 'test',
    modelSchemaVersion: '1',
    dataElements: elements.map((item) => ({ tag: item.tag, value: item.value, nodeId: 'n_test' })),
    keyContentRefs: [],
  } as unknown as MachineReadableBlock;
}

const tagOf = (code: string, display: string): DataElementTag => ({ system: 'WST500', code, display });

async function main(): Promise<void> {
  await test('C1 同一编码出现不同值 → 报告；身份类为 block（且仅展示级别）', () => {
    const issues = checkConsistency([
      { docId: 'doc-A', block: block([{ tag: tagOf('sex', '性别'), value: 'M' }]) },
      { docId: 'doc-B', block: block([{ tag: tagOf('sex', '性别'), value: 'F' }]) },
    ]);
    assertEqual(issues.length, 1, '应报一条');
    const issue = issues[0];
    assertEqual(issue?.kind, 'identity', '性别属身份类');
    assertEqual(issue?.severity, 'block', '身份不一致是硬错误');
    assertEqual(issue?.docIds, ['doc-A', 'doc-B'], '应列出涉及的文书');
    assertEqual(issue?.values, ['M', 'F'], '值应与文书一一对应');
    assert(String(issue?.message).includes('性别'), `描述应有人话，实际：${issue?.message}`);
  });

  await test('C2 值相同不报；只有一份有不报（缺项是另一类问题）', () => {
    const same = checkConsistency([
      { docId: 'doc-A', block: block([{ tag: tagOf('bloodType', '血型'), value: 'A' }]) },
      { docId: 'doc-B', block: block([{ tag: tagOf('bloodType', '血型'), value: 'A' }]) },
    ]);
    assertEqual(same, [], '值相同不算矛盾');

    const onlyOne = checkConsistency([
      { docId: 'doc-A', block: block([{ tag: tagOf('allergy', '过敏史'), value: '青霉素过敏' }]) },
      { docId: 'doc-B', block: block([]) },
    ]);
    assertEqual(onlyOne, [], '只有一份记录时无法比对（缺项由形式类规则负责，不属于一致性）');
  });

  await test('C3 单份文档、零份文档：不该报（内部一致性是另一个问题）', () => {
    assertEqual(checkConsistency([]), [], '无文档');
    assertEqual(checkConsistency([{ docId: 'doc-A', block: block([{ tag: tagOf('sex', '性别'), value: 'M' }]) }]), [], '单份文档不做跨文书比对');
  });

  await test('C4 **会自然变化的项一律不报**：血压/体温/检验值/评分', () => {
    /* 这是本工具最容易死的地方：把正常波动报成矛盾，医生会立刻不再相信任何提示 */
    const issues = checkConsistency([
      {
        docId: 'doc-A',
        block: block([
          { tag: tagOf('BP-SYS', '收缩压'), value: '120' },
          { tag: tagOf('TEMPERATURE', '体温'), value: '36.5' },
          { tag: tagOf('WBC', '白细胞计数'), value: '6.2' },
          { tag: tagOf('NRS2002', '营养风险评分'), value: '1' },
        ]),
      },
      {
        docId: 'doc-B',
        block: block([
          { tag: tagOf('BP-SYS', '收缩压'), value: '150' },
          { tag: tagOf('TEMPERATURE', '体温'), value: '38.9' },
          { tag: tagOf('WBC', '白细胞计数'), value: '12.0' },
          { tag: tagOf('NRS2002', '营养风险评分'), value: '3' },
        ]),
      },
    ]);
    assertEqual(issues, [], '纵向会变化的指标差异是正常现象，报出来就是误报');
  });

  await test('C5 稳定事实类 → warn：过敏史 / 血型 / 既往史的不一致必须人工核对', () => {
    const issues = checkConsistency([
      { docId: 'doc-A', block: block([{ tag: tagOf('ALLERGY', '过敏史'), value: '青霉素过敏' }]) },
      { docId: 'doc-B', block: block([{ tag: tagOf('ALLERGY', '过敏史'), value: '否认药物及食物过敏史' }]) },
    ]);
    assertEqual(issues.length, 1, '应报一条');
    assertEqual(issues[0]?.kind, 'stable', '过敏史属稳定事实类');
    assertEqual(issues[0]?.severity, 'warn', '稳定事实类不一致需人工核对（warn）');
    assert(String(issues[0]?.hint).includes('哪一份为准'), `应给出核对方向，实际：${issues[0]?.hint}`);
  });

  await test('C6 **不做语义推断**：不同编码之间的矛盾（"无高血压" vs 诊断"高血压"）不报', () => {
    /* 这条是有意的空白，不是漏做：文本蕴含需要模型，其误报率在没有评测集时无法声称。
       一条明显误报会让医生此后忽略所有提示 —— 那比不做更糟。  */
    const issues = checkConsistency([
      { docId: 'doc-A', block: block([{ tag: tagOf('PAST-HISTORY', '既往史'), value: '否认高血压病史' }]) },
      { docId: 'doc-B', block: block([{ tag: tagOf('DIAGNOSIS', '诊断'), value: '高血压 2 级' }]) },
    ]);
    assertEqual(issues, [], '不同编码的语义矛盾不在编码级比对的范围内（需评测集之后再评估）');
  });

  await test('C7 提示草稿发给**每一份**文书：系统不替医生决定"以哪一份为准"', () => {
    const issues = checkConsistency([
      { docId: 'doc-A', block: block([{ tag: tagOf('bloodType', '血型'), value: 'A' }]) },
      { docId: 'doc-B', block: block([{ tag: tagOf('bloodType', '血型'), value: 'B' }]) },
    ]);
    const drafts = toSuggestionDrafts(issues[0] as never);
    assertEqual(drafts.length, 2, '两份都要收到提示 —— 系统并不知道哪一份是对的');
    assertEqual(
      drafts.map((item) => item.docId),
      ['doc-A', 'doc-B'],
      '不能只发给"非基准"的那一份（那等于按顺序假定第一份是对的）',
    );
    assert(String(drafts[0]?.text).includes('doc-B=B'), `提示里应带上对方的值，实际：${drafts[0]?.text}`);
    assertEqual(drafts[0]?.promptId, 'consistency:WST500:bloodType', 'promptId 应可追溯到规则与编码（便于统计哪条规则误报多）');
  });

  process.exit(suite.report());
}

void main();
