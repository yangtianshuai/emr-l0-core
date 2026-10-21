import { TestSuite, assert, assertEqual, assertThrows } from '../testing/harness.ts';
import type { JsonValue, NodeId } from '../model/types.ts';
import {
  conditionCatalog,
  describeCondition,
  evaluateCondition,
  normalizeCondition,
  QC_CONDITION_FIELDS,
  QC_CONDITION_FIELD_ORDER,
  QC_CONDITION_LIMITS,
  QC_CONDITION_OPERATORS,
  QC_CONDITION_OPERATOR_ORDER,
  type QcConditionNode,
} from './condition.ts';
import { compileRuleDescriptor, compileRulePack, validateRulePack } from './rule-pack.ts';
import type { QcContext, QcNodeView, QcRulePack } from './types.ts';

const suite = new TestSuite('质控·自定义条件（条件树）', [
  '说明：条件树让"判什么"变成数据，但"怎么算"仍是代码（字段表与算子表在 condition.ts 里封闭）。',
  'C4/C5/C6/C7 是防误报关键：读不到数据、非文本段、导入件都必须走"不命中"或"判不了"，不能编出一个结论。',
]);

const test = (name: string, fn: () => void | Promise<void>): Promise<void> => suite.test(name, fn);

function view(over: Partial<QcNodeView> = {}): QcNodeView {
  return { nodeId: 'n_1' as NodeId, type: 'text', text: '', tags: [], keyContent: false, ...over };
}

function ctx(over: Partial<QcContext> = {}): QcContext {
  return { now: '2026-10-16T12:00:00.000Z', ...over };
}

function atom(field: string, op: string, value?: unknown): QcConditionNode {
  const node: Record<string, unknown> = { kind: 'atom', field, op };
  if (value !== undefined) node.value = value;
  return node as unknown as QcConditionNode;
}

async function main(): Promise<void> {

  await test('C1 字段与算子的封闭清单：下发的规格与注册表逐项一致，且每个字段都有算子可用', () => {
    const catalog = conditionCatalog();
    assertEqual(
      [...catalog.fields.map((item) => item.name)].sort().join(','),
      Object.keys(QC_CONDITION_FIELDS).sort().join(','),
      '字段清单要覆盖全部字段（界面不另排一份）',
    );
    assertEqual(
      catalog.fields.map((item) => item.name).join(','),
      QC_CONDITION_FIELD_ORDER.join(','),
      '字段顺序照注册表（界面看到的就是这个顺序）',
    );
    assertEqual(
      [...catalog.operators.map((item) => item.name)].sort().join(','),
      Object.keys(QC_CONDITION_OPERATORS).sort().join(','),
      '算子清单要覆盖全部算子（界面不另排一份）',
    );
    assertEqual(
      catalog.operators.map((item) => item.name).join(','),
      QC_CONDITION_OPERATOR_ORDER.join(','),
      '算子顺序照注册表',
    );
    assert(catalog.logic.length >= 2, '「满足全部 / 满足任一」这一格也要下发（界面不写死这两个词）');

    for (const field of catalog.fields) {
      assertEqual(String(QC_CONDITION_FIELDS[field.name].label), String(field.label), `${field.name} 的人话名要与注册表一致`);
      assert(String(field.doc ?? '').trim().length > 0, `${field.name} 要带说明（界面上那一格的小字）`);
      assert(field.scope === 'document' || field.scope === 'node', `${field.name} 要说清归在「适用范围」还是「判定条件」`);
      const usable = catalog.operators.filter((item) => item.fields.includes(field.name));
      assert(usable.length > 0, `${field.name} 至少要有一个可用算子（否则构造器里是死格）`);
    }

    for (const op of catalog.operators) {
      assert(op.fields.length > 0, `${op.name} 要写清能用在哪些字段上`);
      for (const field of op.fields) {
        assert(!!QC_CONDITION_FIELDS[field], `${op.name} 引用了不存在的字段 ${field}`);
      }
      assert(String(op.doc ?? '').trim().length > 0, `${op.name} 要带说明（拼条件时唯一能读到"它怎么算"的地方）`);
      if (op.value !== null) assert(String(op.value.doc ?? '').trim().length > 0, `${op.name} 的取值那一格要带说明`);
      for (const text of [op.label, op.doc, op.value?.doc]) {
        assert(!String(text ?? '').includes('**'), `${op.name} 的文案里不得出现 Markdown 记号`);
      }
    }
    for (const field of catalog.fields) {
      for (const text of [field.label, field.doc]) {
        assert(!String(text ?? '').includes('**'), `${field.name} 的文案里不得出现 Markdown 记号`);
      }
    }
  });

  await test('C2 合法条件：往返后结构不变，且能读成一句人话', () => {
    const raw = {
      kind: 'all',
      children: [
        atom('docType', 'in', ['WST500.1']),
        { kind: 'any', children: [atom('text', 'contains', ['待补充', 'TODO']), atom('text', 'empty')] },
      ],
    };
    const normalized = normalizeCondition(raw);
    assert(!!normalized, '合法条件不应被拒');
    assertEqual(normalized, raw, '归一化不该改内容（界面回显的就是它）');
    /* 两次归一化结果相同：装包校验、编辑校验、编译期校验用的是同一段代码，必须幂等 */
    assertEqual(normalizeCondition(normalized), normalized, '归一化要幂等');
    assertEqual(
      describeCondition(normalized as QcConditionNode),
      '文书类型码 属于（任一） 「WST500.1」 且 （段落正文 包含（任一） 「待补充、TODO」 或 段落正文 为空（去空白后））',
      '人话回读要说清判什么，混用「且」「或」时必须加括号',
    );
  });

  await test('C3 不合法一律拒：未知字段 / 未知算子 / 组合不匹配 / 取值不合法 / 结构越界', () => {
    const rejected: Array<[string, unknown]> = [
      ['空对象', {}],
      ['未知 kind', { kind: 'xor', children: [atom('text', 'empty')] }],
      ['未知字段', atom('patientName', 'contains', ['x'])],
      ['未知算子', atom('text', 'matches', ['x'])],
      ['字段×算子不匹配', atom('docType', 'length-less-than', 3)],
      ['缺取值', atom('text', 'contains')],
      ['词表为空', atom('text', 'contains', [])],
      ['词表含空串', atom('text', 'contains', ['待补充', '  '])],
      ['词表项过长', atom('text', 'contains', ['x'.repeat(QC_CONDITION_LIMITS.maxWordLength + 1)])],
      ['整数为 0', atom('text', 'length-less-than', 0)],
      ['整数为小数', atom('text', 'length-less-than', 1.5)],
      ['整数是字符串', atom('text', 'length-less-than', '6')],
      ['布尔给了字符串', atom('keyContent', 'is', 'true')],
      ['枚举不在取值域', atom('text', 'missing-pattern', 'phone')],
      ['没取值的算子却给了取值', atom('text', 'empty', ['x'])],
      ['未知键', { kind: 'atom', field: 'text', op: 'empty', extra: 1 }],
      ['all 的 children 为空', { kind: 'all', children: [] }],
      ['all 的 children 超上限', { kind: 'all', children: Array.from({ length: QC_CONDITION_LIMITS.maxChildren + 1 }, () => atom('text', 'empty')) }],
      ['嵌套超过深度上限', (() => {
        let node: unknown = atom('text', 'empty');
        for (let index = 0; index <= QC_CONDITION_LIMITS.maxDepth; index += 1) node = { kind: 'not', child: node };
        return node;
      })()],
      ['空词（含全空白）', atom('text', 'contains', ['   '])],
    ];
    for (const [name, raw] of rejected) {
      assertEqual(normalizeCondition(raw), null, `应拒绝：${name}`);
    }
    assert(!!normalizeCondition(atom('text', 'contains', ['待补充'])), '合法词表应通过');
    assert(!!normalizeCondition(atom('keyContent', 'is', true)), '布尔取值应通过');
    assert(!!normalizeCondition(atom('text', 'missing-pattern', 'time')), '枚举取值应通过');
    assert(!!normalizeCondition(atom('text', 'empty')), '无取值的算子应通过');
  });

  await test('C4 正文类算子只对文本段判定：章节与文书根的正文是空的，对它们判"包含"必然错', () => {
    const condition = normalizeCondition(atom('text', 'contains', ['待补充'])) as QcConditionNode;
    const hitText = evaluateCondition(view({ type: 'text', text: '现病史：待补充' }), condition, ctx());
    assert('hit' in hitText && hitText.hit, '文本段命中');
    assertEqual('quote' in hitText ? hitText.quote : undefined, '待补充', '命中片段要原样给出来（不是整段）');
    assertEqual(evaluateCondition(view({ type: 'text', text: '现病史无殊' }), condition, ctx()), { hit: false }, '文本段不命中');
    assertEqual(evaluateCondition(view({ type: 'section', text: '' }), condition, ctx()), { hit: false }, '章节不判正文类条件');
    assertEqual(evaluateCondition(view({ type: 'document', text: '' }), condition, ctx()), { hit: false }, '文书根不判正文类条件');

    const empty = normalizeCondition(atom('text', 'empty')) as QcConditionNode;
    assertEqual(evaluateCondition(view({ type: 'section', text: '' }), empty, ctx()), { hit: false }, '"正文为空"同样不判非文本段');
    assertEqual(evaluateCondition(view({ type: 'text', text: '   ' }), empty, ctx()), { hit: true }, '去空白后为空即命中');
  });

  await test('C5 带标签但正文为空：没有标签的空白段落不算（它可能本就不必填）', () => {
    const condition = normalizeCondition(atom('tags', 'empty-with-tag', ['主诉'])) as QcConditionNode;
    assertEqual(
      evaluateCondition(view({ type: 'text', text: '', tags: ['主诉'] }), condition, ctx()),
      { hit: true },
      '带指定标签且正文为空应命中',
    );
    assertEqual(
      evaluateCondition(view({ type: 'text', text: '', tags: ['既往史'] }), condition, ctx()),
      { hit: false },
      '标签不在词表里不命中',
    );
    assertEqual(
      evaluateCondition(view({ type: 'text', text: '', tags: [] }), condition, ctx()),
      { hit: false },
      '没有标签的空白段落不算 —— 报它会误伤',
    );
    assertEqual(
      evaluateCondition(view({ type: 'text', text: '有内容', tags: ['主诉'] }), condition, ctx()),
      { hit: false },
      '正文非空不命中',
    );
  });

  await test('C6 字段读不到时 in / not-in 都不命中：拿"读不到"当"不属于"会把缺数据变成质控结论', () => {
    const inSection = normalizeCondition(atom('sectionCode', 'in', ['CC01'])) as QcConditionNode;
    const notInSection = normalizeCondition(atom('sectionCode', 'not-in', ['CC01'])) as QcConditionNode;
    const unknownSection = view({ type: 'text', text: 'x' });
    assertEqual(evaluateCondition(unknownSection, inSection, ctx()), { hit: false }, '读不到章节码：in 不命中');
    assertEqual(evaluateCondition(unknownSection, notInSection, ctx()), { hit: false }, '读不到章节码：not-in 也不命中（关键一条）');

    const known = view({ type: 'section', sectionCode: 'CC02' });
    assertEqual(evaluateCondition(known, inSection, ctx()), { hit: false }, '章节码不在清单里');
    assertEqual(evaluateCondition(known, notInSection, ctx()), { hit: true }, '章节码不在清单里：not-in 命中');

    const inDocType = normalizeCondition(atom('docType', 'in', ['WST500.1'])) as QcConditionNode;
    assertEqual(evaluateCondition(view(), inDocType, ctx({ docTypeCode: 'WST500.1' })), { hit: true }, '文书类型码命中');
    assertEqual(evaluateCondition(view(), inDocType, ctx()), { hit: false }, '没有文书类型码 → 不命中');
  });

  await test('C7 时限类：缺基线 / 导入件走"判不了"；正好等于时限不报（压线算完成）', () => {
    const condition = normalizeCondition(atom('recordedAt', 'older-than-hours', 8)) as QcConditionNode;
    const base = { admittedAt: '2026-10-16T00:00:00.000Z' };

    assertEqual(
      evaluateCondition(view({ type: 'document', recordedAt: '2026-10-16T03:00:00.000Z' }), condition, ctx(base)),
      { hit: false },
      '3 小时未超 8 小时',
    );
    assertEqual(
      evaluateCondition(view({ type: 'document', recordedAt: '2026-10-16T08:00:00.000Z' }), condition, ctx(base)),
      { hit: false },
      '**正好等于**时限不报：要求是"在 N 小时内完成"，压线算完成',
    );
    assertEqual(
      evaluateCondition(view({ type: 'document', recordedAt: '2026-10-16T08:00:01.000Z' }), condition, ctx(base)),
      { hit: true },
      '超过时限即命中',
    );

    /* 判不了的三条路：每一条都必须说出来，而不是混进"没问题" */
    const noAdmit = evaluateCondition(view({ type: 'document', recordedAt: '2026-10-16T03:00:00.000Z' }), condition, ctx());
    assert('uncertain' in noAdmit && noAdmit.uncertain.includes('入院时间'), '缺入院时刻要说清为什么判不了');
    const imported = evaluateCondition(
      view({ type: 'document', recordedAt: '2026-10-16T03:00:00.000Z', origin: 'imported' }),
      condition,
      ctx(base),
    );
    assert('uncertain' in imported && imported.uncertain.includes('导入'), '导入件按写入时刻判会得出错误结论，必须走"判不了"');
    const noRecorded = evaluateCondition(view({ type: 'document' }), condition, ctx(base));
    assert('uncertain' in noRecorded && noRecorded.uncertain.includes('记录时间'), '没有记录时间要说出来');

    assertEqual(
      evaluateCondition(view({ type: 'text', text: 'x', recordedAt: '2026-10-16T20:00:00.000Z' }), condition, ctx(base)),
      { hit: false },
      '时限是文书级要求：文本段不判',
    );
  });

  await test('C8 组合：假优先短路、not 取反、判不了如实上传', () => {
    const hit = atom('text', 'contains', ['待补充']);
    const miss = atom('text', 'contains', ['绝不可能出现的词']);
    const uncertain = atom('recordedAt', 'older-than-hours', 8);

    const allWithMiss = normalizeCondition({ kind: 'all', children: [miss, uncertain] }) as QcConditionNode;
    assertEqual(
      evaluateCondition(view({ type: 'document' }), allWithMiss, ctx()),
      { hit: false },
      '「且」里有一个明确不成立，整条就不成立 —— 不该因为另一分支缺数据而降级成"判不了"',
    );

    const hitOnDocument = atom('nodeType', 'in', ['document']);
    const anyWithHit = normalizeCondition({ kind: 'any', children: [hitOnDocument, uncertain] }) as QcConditionNode;
    assertEqual(
      evaluateCondition(view({ type: 'document' }), anyWithHit, ctx()),
      { hit: true },
      '「或」里有一个成立就成立（判不了的分支不参与结论）',
    );

    const anyAllUncertain = normalizeCondition({ kind: 'any', children: [miss, uncertain] }) as QcConditionNode;
    const verdict = evaluateCondition(view({ type: 'document' }), anyAllUncertain, ctx());
    assert('uncertain' in verdict, '「或」里没有成立的、但有判不了的 → 如实上传，不当作"不命中"');

    const negated = normalizeCondition({ kind: 'not', child: hit }) as QcConditionNode;
    assertEqual(evaluateCondition(view({ type: 'text', text: '无殊' }), negated, ctx()), { hit: true }, 'not 取反');
    assertEqual(evaluateCondition(view({ type: 'text', text: '待补充' }), negated, ctx()), { hit: false }, 'not 取反（命中变不命中）');
    const negatedUncertain = normalizeCondition({ kind: 'not', child: uncertain }) as QcConditionNode;
    const negatedVerdict = evaluateCondition(view({ type: 'document' }), negatedUncertain, ctx());
    assert('uncertain' in negatedVerdict, '把一个未知取反，还是未知');
  });

  await test('C9 条件谓词能编译成可运行规则：规则号由引擎注入，依据里写清命中条件', () => {
    const rule = compileRuleDescriptor('doc.rule.test', {
      itemId: 'R-COND-1',
      title: '段落里还留着占位文字',
      severity: 'warn',
      predicate: { kind: 'field-condition', params: { when: { kind: 'atom', field: 'text', op: 'contains', value: ['待补充'] } } },
    });
    assertEqual(rule.id, 'R-COND-1', '规则号照描述符');
    assertEqual(rule.check(view({ type: 'text', text: '既往史无殊' }), ctx()), null, '不命中');

    const hit = rule.check(view({ type: 'text', text: '现病史：待补充' }), ctx());
    if (!hit || 'uncertain' in hit) throw new Error('应命中而不是"判不了"');
    assert(String(hit.detail).includes('规则 R-COND-1：'), '规则号由引擎注入（包不得自带）');
    assert(String(hit.detail).includes('本段正文包含「待补充」'), '依据里要写清命中处（含命中的那一段话）');
    assert(String(hit.suggestion).trim() !== '', '建议动作不能是空的');
    assertEqual(String(hit.quote ?? ''), '待补充', '命中片段要随判定结果带出来');
  });

  await test('C10 条件写错在装载那一刻就被拒：不合法即拒，不做"看不懂就当没配"的兜底', () => {
    const pack = (when: unknown): QcRulePack => {
      const params: Record<string, JsonValue> = when === undefined ? {} : { when: when as JsonValue };
      return {
        packId: 'doc.rule.test',
        name: '自测规则包',
        kind: 'rule',
        engineApi: 'qc-rule/1',
        items: [{
          itemId: 'R-COND-2',
          title: 'x',
          severity: 'warn',
          predicate: { kind: 'field-condition', params },
        }],
      };
    };
    const bad: Array<[string, unknown]> = [
      ['完全没给条件', undefined],
      ['条件树形状不对', { kind: 'atom', field: 'text' }],
      ['字段×算子不匹配', { kind: 'atom', field: 'keyContent', op: 'contains', value: ['x'] }],
      ['取值不合法', { kind: 'atom', field: 'text', op: 'less-than' }],
    ];
    for (const [name, when] of bad) {
      assertThrows(
        () => validateRulePack(pack(when)),
        (err) => (err as { code?: string }).code === 'E_RULE_PARAM_INVALID',
        `${name}：装载期应报参数不合法`,
      );
    }
    validateRulePack(pack(atom('text', 'empty')));
  });

  const paramCondition = {
    itemType: 'condition',
    itemId: 'C-CUSTOM-1',
    name: '主诉少于 N 字',
    params: [{ name: 'minLength', kind: 'integer', label: '最少字数', unit: '字', required: true, doc: '少于它就报。' }],
    when: { kind: 'atom', field: 'text', op: 'length-less-than', value: '$minLength' },
  };

  const refPack = (condition: unknown, params: Record<string, JsonValue>): QcRulePack => ({
    packId: 'doc.rule.test',
    name: '自测规则包',
    kind: 'rule',
    engineApi: 'qc-rule/1',
    items: [
      condition as never,
      { itemId: 'R-1', title: '主诉过短', severity: 'warn', predicate: { kind: 'field-condition', params } } as never,
    ],
  });

  await test('C11 带参数的判定方式：同一棵树、两组实参，各判各的', () => {
    const loose = compileRulePack(refPack(paramCondition, { conditionId: 'C-CUSTOM-1', args: { minLength: 5 } }))[0];
    const strict = compileRulePack(refPack(paramCondition, { conditionId: 'C-CUSTOM-1', args: { minLength: 2 } }))[0];
    if (!loose || !strict) throw new Error('两条规则都该编译出来');

    assert(loose.check(view({ type: 'text', text: '腹痛' }), ctx()) !== null, '3 字 < 5 字 → 命中');
    assertEqual(strict.check(view({ type: 'text', text: '腹痛' }), ctx()), null, '同一段文字在阈值 2 下不报 —— 实参真的生效');

    const hit = loose.check(view({ type: 'text', text: '腹痛' }), ctx());
    if (!hit || 'uncertain' in hit) throw new Error('应命中');
    assert(String(hit.detail).includes('3 字') || String(hit.detail).includes('5'), '依据里要能看出这条是按什么阈值判的');
  });

  await test('C12 实参不合法一律拒：未知参数名 / 必填缺失 / 类型不符 / 枚举越域', () => {
    const bad: Array<[string, Record<string, JsonValue>]> = [
      ['未知参数名', { conditionId: 'C-CUSTOM-1', args: { nimLength: 5 } }],
      ['必填缺失', { conditionId: 'C-CUSTOM-1', args: {} }],
      ['类型不符', { conditionId: 'C-CUSTOM-1', args: { minLength: '5' } }],
      ['取值越界（0）', { conditionId: 'C-CUSTOM-1', args: { minLength: 0 } }],
    ];
    for (const [name, params] of bad) {
      assertThrows(
        () => validateRulePack(refPack(paramCondition, params)),
        (err) => (err as { code?: string }).code === 'E_RULE_CONDITION_PARAM_INVALID',
        `${name}：装载期应报实参不合法`,
      );
    }
    validateRulePack(refPack(paramCondition, { conditionId: 'C-CUSTOM-1', args: { minLength: 5 } }));
  });

  await test('C13 占位符只允许出现在取值位置，且必须与参数表对上', () => {
    const noParams = { ...paramCondition, params: undefined };
    assertThrows(
      () => validateRulePack(refPack(noParams, { conditionId: 'C-CUSTOM-1' })),
      (err) => (err as { code?: string }).code === 'E_RULE_CONDITION_PLACEHOLDER',
      '用了没声明的占位符：实参来了也没处校验，必须拒',
    );

    const unusedParam = {
      ...paramCondition,
      when: { kind: 'atom', field: 'text', op: 'empty' },
    };
    assertThrows(
      () => validateRulePack(refPack(unusedParam, { conditionId: 'C-CUSTOM-1' })),
      (err) => (err as { code?: string }).code === 'E_RULE_CONDITION_PLACEHOLDER',
      '声明了参数却没用上：界面上会多一个"填了也不生效"的格，必须拒',
    );

    assertThrows(
      () => validateRulePack(refPack({ ...paramCondition, when: { kind: 'atom', field: '$f', op: 'empty' } }, { conditionId: 'C-CUSTOM-1' })),
      (err) => (err as { code?: string }).code === 'E_RULE_CONDITION_INVALID',
      '字段位置写占位符：不是字段名，树本身不合法',
    );
  });

  await test('C14 代入之后仍走同一段校验：实参形态与它落的那一格不匹配就拒', () => {
    const misshaped = {
      itemType: 'condition',
      itemId: 'C-CUSTOM-2',
      name: '含某个词',
      params: [{ name: 'word', kind: 'string', label: '词', required: true, doc: '一个词。' }],
      when: { kind: 'atom', field: 'text', op: 'contains', value: '$word' },
    };
    assertThrows(
      () => validateRulePack(refPack(misshaped, { conditionId: 'C-CUSTOM-2', args: { word: '待补充' } })),
      (err) => (err as { code?: string }).code === 'E_RULE_CONDITION_INVALID',
      '代入后才非法的取值必须在这里被拒，而不是等到扫描时"少一条规则"',
    );
  });

  await test('C15 不带参数的判定方式（老包形态）：行为与落地前逐字一致', () => {
    const plain = {
      itemType: 'condition',
      itemId: 'C-CUSTOM-3',
      name: '占位文字残留',
      when: { kind: 'atom', field: 'text', op: 'contains', value: ['待补充'] },
    };
    const rule = compileRulePack(refPack(plain, { conditionId: 'C-CUSTOM-3' }))[0];
    if (!rule) throw new Error('应编译出规则');
    assert(rule.check(view({ type: 'text', text: '现病史：待补充' }), ctx()) !== null, '命中照旧');
    assertEqual(rule.check(view({ type: 'text', text: '现病史：无殊' }), ctx()), null, '不命中照旧');
    assertThrows(
      () => validateRulePack(refPack(plain, { conditionId: 'C-CUSTOM-3', args: { anything: 1 } })),
      (err) => (err as { code?: string }).code === 'E_RULE_CONDITION_PARAM_INVALID',
      '不带参数的判定方式给了实参：那是"填了不生效"，必须拒',
    );
  });

  await test('C16 跨文书聚合：间隔超限与应有而缺（右端取出院时刻、期限未到不报）', () => {
    const gap = normalizeCondition({
      kind: 'all',
      children: [
        atom('nodeType', 'in', ['document']),
        atom('visitDocs', 'gap-exceeds-hours', { docTypeCode: 'WST500.3', hours: 72 }),
      ],
    }) as QcConditionNode;
    const base = '2026-10-01T00:00:00.000Z';
    const at = (dayOffset: number): string => new Date(Date.parse(base) + dayOffset * 86_400_000).toISOString();
    const docs = [
      { docId: 'd1', docTypeCode: 'WST500.3', createdAt: base },
      { docId: 'd2', docTypeCode: 'WST500.3', createdAt: at(4) },
    ];
    const later = at(4.2);
    assertEqual(
      evaluateCondition(view({ type: 'document' }), gap, ctx({ now: later, visitDocs: docs })),
      { hit: true },
      '两份相隔 96 小时 > 72 小时 → 命中',
    );
    assertEqual(
      evaluateCondition(
        view({ type: 'document' }),
        gap,
        ctx({ now: later, visitDocs: [{ docId: 'd0', docTypeCode: 'WST500.1', createdAt: base }] }),
      ),
      { hit: false },
      '该类文书一份都没有时本档不报（由「应有而缺」负责，两条都报会得到重复提示）',
    );
    const closeDocs = [
      { docId: 'd1', docTypeCode: 'WST500.3', createdAt: base },
      { docId: 'd2', docTypeCode: 'WST500.3', createdAt: at(1) },
    ];
    assertEqual(
      evaluateCondition(view({ type: 'document' }), gap, ctx({ now: at(4.2), visitDocs: closeDocs })),
      { hit: true },
      '没有出院时刻时右端取"现在"：最后一份之后 3.2 天没写 → 命中',
    );
    assertEqual(
      evaluateCondition(view({ type: 'document' }), gap, ctx({ now: at(4.2), visitDocs: closeDocs, dischargedAt: at(2) })),
      { hit: false },
      '出院时刻更早时右端取它：出院后没再写不该算成缺漏',
    );
    const noList = evaluateCondition(view({ type: 'document' }), gap, ctx({ now: later }));
    assert('uncertain' in noList, '拿不到就诊文书清单 → 判不了，不猜');
    const broken = evaluateCondition(
      view({ type: 'document' }),
      gap,
      ctx({ now: later, visitDocs: [{ docId: 'd9', docTypeCode: 'WST500.3', createdAt: '不是时间' }] }),
    );
    assert('uncertain' in broken, '成文时间解析不出来 → 判不了（静默跳过会把"时间坏了"变成"那段时间没文书"）');
    assertEqual(
      evaluateCondition(view({ type: 'text' }), gap, ctx({ now: later, visitDocs: docs })),
      { hit: false },
      '非文书节点不适用',
    );

    const required = normalizeCondition({
      kind: 'all',
      children: [
        atom('nodeType', 'in', ['document']),
        atom('visitDocs', 'missing-within-hours', { docTypeCode: 'WST500.1', hours: 24 }),
      ],
    }) as QcConditionNode;
    const admitted = { admittedAt: base };
    assertEqual(
      evaluateCondition(view({ type: 'document' }), required, ctx({ ...admitted, now: at(30), visitDocs: [] })),
      { hit: true },
      '入院 30 小时后仍没有该类文书 → 命中',
    );
    assertEqual(
      evaluateCondition(
        view({ type: 'document' }),
        required,
        ctx({ ...admitted, now: new Date(Date.parse(base) + 10 * 3_600_000).toISOString(), visitDocs: [] }),
      ),
      { hit: false },
      '期限未到不报 —— 还没到点就说"没有"是催命，不是质控',
    );
    assertEqual(
      evaluateCondition(
        view({ type: 'document' }),
        required,
        ctx({
          ...admitted,
          now: at(30),
          visitDocs: [{
            docId: 'd1',
            docTypeCode: 'WST500.1',
            createdAt: new Date(Date.parse(base) + 3 * 3_600_000).toISOString(),
          }],
        }),
      ),
      { hit: false },
      '期限内已经有那一类文书 → 不报',
    );
    const noBaseline = evaluateCondition(view({ type: 'document' }), required, ctx({ now: at(30), visitDocs: [] }));
    assert('uncertain' in noBaseline, '缺入院时刻 → 判不了');
  });

  await test('C17 新算子：带任意标签、含内置模式（补上"必填为空"少了的那一格）', () => {
    const hasTag = normalizeCondition(atom('tags', 'has-tag')) as QcConditionNode;
    assertEqual(evaluateCondition(view({ tags: ['主诉'] }), hasTag, ctx()), { hit: true }, '带标签即成立');
    assertEqual(evaluateCondition(view({ tags: [] }), hasTag, ctx()), { hit: false }, '没有标签不成立');

    const placeholder = normalizeCondition(atom('text', 'matches-pattern', 'placeholder')) as QcConditionNode;
    const hitPlaceholder = evaluateCondition(view({ text: '现病史：待补充' }), placeholder, ctx());
    assert('hit' in hitPlaceholder && hitPlaceholder.hit, '内置占位词命中');
    assertEqual(
      'quote' in hitPlaceholder ? hitPlaceholder.quote : undefined,
      '待补充',
      '命中片段本身（与谓词 `placeholder-residue` 同一口径）',
    );
    assertEqual(evaluateCondition(view({ text: '现病史：无殊' }), placeholder, ctx()), { hit: false }, '正常正文不命中');
    assertEqual(
      evaluateCondition(view({ type: 'section', sectionCode: 'x', text: '' }), placeholder, ctx()),
      { hit: false },
      '只判文本段：章节与文书根的正文是空的',
    );
    const taggedEmpty = normalizeCondition({
      kind: 'all',
      children: [atom('nodeType', 'in', ['text']), atom('tags', 'has-tag'), atom('text', 'empty')],
    }) as QcConditionNode;
    assertEqual(
      evaluateCondition(view({ text: '   ', tags: ['主诉'] }), taggedEmpty, ctx()),
      { hit: true },
      '带标签且正文为空 → 命中',
    );
    assertEqual(
      evaluateCondition(view({ text: '   ', tags: [] }), taggedEmpty, ctx()),
      { hit: false },
      '没有标签的空白段不报（它可能本就不必填）',
    );
  });

  process.exit(suite.report());
}

void main();
