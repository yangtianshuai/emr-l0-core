import type { QcConditionDefinition } from './types.ts';

export const SEED_CONDITIONS_KEY = 'config.qc-conditions-seeded';

const TEXT_ONLY = { kind: 'atom', field: 'nodeType', op: 'in', value: ['text'] };
const DOC_LEVEL = { kind: 'atom', field: 'nodeType', op: 'in', value: ['document'] };

export const SEED_CONDITIONS: readonly QcConditionDefinition[] = [
  {
    itemType: 'condition',
    itemId: 'C-BUILTIN-MISSING-TIME',
    name: '记录类段落缺记录时间',
    description:
      '记录类段落里必须出现时间表述（2026-10-09 / 10月9日 / 14:30 / 14时 等写法之一）。'
      + '短于阈值的段不判 —— 在标题与短标签上要求时间只会造成误报。'
      + '（它还能与别的条件拼在一起，例如"住院 且 本段缺记录时间"。）',
    params: [
      {
        name: 'minLength',
        kind: 'integer',
        label: '最短长度',
        unit: '字',
        required: true,
        doc: '段落短于它就不判（出厂口径取 10 字）。必须是正整数 —— 0 会让每个标题都被要求写时间。',
      },
    ],
    when: {
      kind: 'all',
      children: [
        TEXT_ONLY,
        { kind: 'atom', field: 'text', op: 'missing-pattern', value: 'time' },
        { kind: 'not', child: { kind: 'atom', field: 'text', op: 'length-less-than', value: '$minLength' } },
      ],
    },
  },
  {
    itemType: 'condition',
    itemId: 'C-BUILTIN-TAGGED-EMPTY',
    name: '必填数据元的段落内容为空',
    description:
      '带数据元标签、但正文为空的段落。没有标签的空白段落**不判** —— 它可能本就不必填，报它会误伤。',
    when: {
      kind: 'all',
      children: [
        TEXT_ONLY,
        { kind: 'atom', field: 'tags', op: 'has-tag' },
        { kind: 'atom', field: 'text', op: 'empty' },
      ],
    },
  },
  {
    itemType: 'condition',
    itemId: 'C-BUILTIN-PLACEHOLDER',
    name: '模板占位符未替换',
    description:
      '正文里还留着"待补充 / 待填写 / TODO / XXX"之类的占位文字。它会被下游（打印、导出、机读）'
      + '当成真实内容，所以要在文书里查出来。词表是出厂内置的那几个；本院自己的额外占位词，'
      + '在「自定义条件能拼哪些格」里用文字算子另拼一条条件即可。',
    when: {
      kind: 'all',
      children: [
        TEXT_ONLY,
        { kind: 'atom', field: 'text', op: 'matches-pattern', value: 'placeholder' },
      ],
    },
  },
  {
    itemType: 'condition',
    itemId: 'C-BUILTIN-DOC-TIME-LIMIT',
    name: '文书未在时限内完成',
    description:
      '按系统内写入时刻判：文书应在就诊/入院后 N 小时内完成。外部导入件不判定（按写入时刻判补录件会得出'
      +       '"严重超时"的错误结论）—— 那时走"判不了"通道如实上报。'
      + '（要判哪几类文书在这里写明：不做"不限文书类型"—— 时限在不同文书之间未必通用。）',
    params: [
      {
        name: 'limitHours',
        kind: 'integer',
        label: '时限',
        unit: '小时',
        required: true,
        doc: '超过它才算超时；正好等于不报（要求是"在 N 小时内完成"，压线算完成）。',
      },
      {
        name: 'docTypeCodes',
        kind: 'string-list',
        label: '限定文书类型码',
        required: true,
        doc: '只判这几类文书，如 WST500.1（入院记录）。要判另一类文书就把它的类型码加进来，或另建一条判定方式。',
      },
    ],
    when: {
      kind: 'all',
      children: [
        { kind: 'atom', field: 'nodeType', op: 'in', value: ['document', 'section'] },
        { kind: 'atom', field: 'docType', op: 'in', value: '$docTypeCodes' },
        { kind: 'atom', field: 'recordedAt', op: 'older-than-hours', value: '$limitHours' },
      ],
    },
  },
  {
    itemType: 'condition',
    itemId: 'C-BUILTIN-VISIT-DOC-INTERVAL',
    name: '同类文书之间的间隔超限',
    description:
      '同一次就诊内，同一类文书的成文时刻之间不得超过 N 小时（含最后一份到出院/现在那一段）。'
      +       '一份都没有时不报 —— 那种情况由「应有而缺的文书」负责，两条都报会得到重复提示。',
    params: [
      {
        name: 'docTypeCode',
        kind: 'string',
        label: '文书类型码',
        required: true,
        doc: '按哪一类文书的成文时刻算间隔，如 WST500.3（病程记录）。必填 —— 没有它无从知道在算谁之间的间隔。',
      },
      {
        name: 'maxGapHours',
        kind: 'integer',
        label: '最大间隔',
        unit: '小时',
        required: true,
        doc: '同类文书之间不得超过它。已出院时右端取出院时刻（不把"出院后没再写"算成缺漏）。',
      },
    ],
    when: {
      kind: 'all',
      children: [
        DOC_LEVEL,
        {
          kind: 'atom',
          field: 'visitDocs',
          op: 'gap-exceeds-hours',
          value: { docTypeCode: '$docTypeCode', hours: '$maxGapHours' },
        },
      ],
    },
  },
  {
    itemType: 'condition',
    itemId: 'C-BUILTIN-VISIT-DOC-REQUIRED',
    name: '应有而缺的文书',
    description:
      '就诊/入院后 N 小时内应当有某一类文书（例如入院记录、首次病程记录）。期限未到不报；'
      + '与「文书未在时限内完成」互斥 —— 那条判"有了但写晚了"，这条判"压根没有"。',
    params: [
      {
        name: 'docTypeCode',
        kind: 'string',
        label: '文书类型码',
        required: true,
        doc: '哪一类文书应当有，如 WST500.1（入院记录）。必填。',
      },
      {
        name: 'withinHours',
        kind: 'integer',
        label: '期限内',
        unit: '小时',
        required: true,
        doc: '就诊/入院后多少小时内应当有。期限未到不报 —— 还没到点就说"没有"是催命，不是质控。',
      },
    ],
    when: {
      kind: 'all',
      children: [
        DOC_LEVEL,
        {
          kind: 'atom',
          field: 'visitDocs',
          op: 'missing-within-hours',
          value: { docTypeCode: '$docTypeCode', hours: '$withinHours' },
        },
      ],
    },
  },
];
