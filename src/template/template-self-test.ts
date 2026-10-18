// 模板体系自测（K1~K9）。

import { TestSuite, assert, assertEqual, assertThrows } from '../testing/harness.ts';
import { fileURLToPath } from 'node:url';
import { errorsOf, validateDocument } from '../model/validate.ts';
import { buildMachineReadable } from '../model/machine.ts';
/* 格键怎么算只有一处（`model/control.ts`）：断言"影像的格键就是字段 key"必须问它，
   而不是在这里再拼一次 —— 两处各拼一遍，漂移的后果是"填的值在导出里不见"。 */
import { controlCellsOf } from '../model/control.ts';
/* 纸面那一份在 `export/ofd.ts`。这里顺手断言控件的纸面形态，是因为 K17 手上已经有一份
   填过值的文档；另起一份"只为了导出"的夹具，反而要在这里重造一个控件节点。 */
import { renderLines } from '../export/ofd.ts';
import type { JsonValue, NodeId } from '../model/types.ts';
import { WriteSession } from '../core/session.ts';
import { PackRegistry, packFingerprintOf } from '../knowledge/pack.ts';
import { createEmptyPackRegistry } from '../knowledge/default-registry.ts';
import { readSamplePack, SAMPLE_PACK_FILES } from '../knowledge/sample-packs.ts';
import { planRecompute } from './recompute.ts';
import { describeExpression, evaluate, validateExpression } from './expression.ts';
import { instantiateTemplate, type InstantiateOutput } from './engine.ts';
import {
  addExpression,
  addFragment,
  addTemplate,
  copyTemplateIntoPack,
  deptAllowsTemplate,
  expressionUsedBy,
  findTemplate,
  listExpressionControls,
  listFragments,
  listTemplates,
  patchExpression,
  patchFragment,
  patchTemplateMeta,
  removeExpression,
  removeFragment,
  removeTemplate,
  templateCatalogOf,
  templateItemsOf,
  validateTemplatePack,
} from './template-pack.ts';
import { validateRulePack } from '../qc/rule-pack.ts';
import type { QcRulePack } from '../qc/types.ts';
import type {
  ExpressionDefinition,
  InstantiateInput,
  TemplateDefinition,
  TemplatePack,
  TemplatePackItem,
  TemplateSection,
  TemplateSlot,
} from './types.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/**
 * 样例模板包（`samples/packs/doc.template.builtin.json`）：外部数据。
 * 装载时一样过 `validateTemplatePack` —— 没有"因为它是仓库里自带的就跳过校验"这回事。
  */
const SAMPLE_PACK = readSamplePack(ROOT, SAMPLE_PACK_FILES.templates) as TemplatePack;
const SAMPLE_FORM_PACK = readSamplePack(ROOT, SAMPLE_PACK_FILES.formRules) as QcRulePack;
const SAMPLE_TIME_PACK = readSamplePack(ROOT, SAMPLE_PACK_FILES.timeRules) as QcRulePack;

const sampleTemplateIds = (): string[] => templateItemsOf(SAMPLE_PACK).map((item) => item.itemId);

/**
 * 装上三个样例包的注册表：空装配 + 显式装载（不再有自动顶上的出厂包）。
 *
 * 三个都装，是为了让"两类包并存互不干扰"这条（K9）仍然成立 —— 那一条关心的是
 * 跨类别的指纹与开关不会互相污染，而不是"出厂装了什么"。
  */
function registryWithSamples(): PackRegistry {
  const registry = createEmptyPackRegistry();
  registry.load(SAMPLE_FORM_PACK, { validate: (pack) => validateRulePack(pack as QcRulePack) });
  registry.load(SAMPLE_TIME_PACK, { validate: (pack) => validateRulePack(pack as QcRulePack) });
  registry.load(SAMPLE_PACK, { validate: (pack) => validateTemplatePack(pack as TemplatePack) });
  return registry;
}

const suite = new TestSuite('模板体系自测（K4）', [
  '说明：模板是数据、实例化是代码；产物必须通过 validateDocument 才算通过。',
  'K2/K4 是防回退关键：模板不得产出非法文档，派生值不得在缺输入时编数。',
]);

const test = (name: string, fn: () => void | Promise<void>): Promise<void> => suite.test(name, fn);

const AT = '2026-10-08T01:00:00Z';
const LMP = '2026-01-01T00:00:00Z';
const LATER = '2026-01-29T00:00:00Z';

function inputOf(templateId: string, overrides: Partial<InstantiateInput> = {}): InstantiateInput {
  return {
    templateId,
    docId: 'doc_tpl_test',
    createdBy: 'DR_TEST',
    patient: { patientId: 'P_T', nameMasked: '王**', gender: 'M', birthDate: '1981-03-12' },
    encounter: { visitId: 'V_T', visitType: 'outpatient', deptCode: '呼吸内科', admittedAt: AT },
    at: AT,
    ...overrides,
  };
}

/** 按槽位名取节点（`slots` 就是给这件事用的） */
function nodeAt(output: InstantiateOutput, key: string): Record<string, unknown> {
  const nodeId = output.result.slots[key];
  assert(typeof nodeId === 'string', `槽位「${key}」应生成节点`);
  const node = output.doc.nodes[nodeId as NodeId] as unknown as Record<string, unknown> | undefined;
  assert(!!node, `槽位「${key}」指向的节点应存在`);
  return node as Record<string, unknown>;
}

const textAt = (output: InstantiateOutput, key: string): string => {
  const node = nodeAt(output, key);
  return ((node.runs as Array<{ text: string }>) ?? []).map((run) => run.text).join('');
};

const codeOf = (fn: () => unknown): string => {
  try {
    fn();
    return 'OK';
  } catch (err) {
    return (err as { code?: string }).code ?? `UNEXPECTED:${(err as Error).message}`;
  }
};

/**
 * 一份最小测试包：既能验算，也能造"缺输入"与"除零"这两种边界。
 *
 * `weightFilled: false` 表示体重槽位在、但医生还没填（没有默认值）。
 * 这与"把体重槽位删掉"是两回事：后者会让控件引用一个不存在的填写项，
 * 属于模板本身不合法（装载期就该拒）—— 实测踩到过，故在注释里写清。
  */
function testPack(options: { weightFilled?: boolean; divisor?: number } = {}): TemplatePack {
  const weightFilled = options.weightFilled ?? true;
  /* 默认除 3（平均动脉压的真实公式）；测试"除零"时显式传 0 */
  const divisor = options.divisor ?? 3;
  return {
    packId: 'doc.template.test',
    kind: 'template',
    name: '测试模板包',
    engineApi: 'doc-template/1',
    items: [
      {
        itemType: 'expression',
        itemId: 't.bmi',
        name: '体质指数',
        unit: 'kg/m²',
        enabled: true,
        expression: {
          kind: 'fn',
          name: 'round',
          args: [
            {
              kind: 'fn',
              name: 'div',
              args: [
                { kind: 'slot', key: 'weightKg' },
                { kind: 'fn', name: 'pow', args: [{ kind: 'fn', name: 'div', args: [{ kind: 'slot', key: 'heightCm' }, { kind: 'num', value: 100 }] }, { kind: 'num', value: 2 }] },
              ],
            },
            { kind: 'num', value: 1 },
          ],
        },
      },
      {
        itemType: 'expression',
        itemId: 't.map',
        name: '平均动脉压',
        unit: 'mmHg',
        enabled: true,
        expression: {
          kind: 'fn',
          name: 'div',
          args: [
            {
              kind: 'fn',
              name: 'add',
              args: [
                { kind: 'slot', key: 'sbp' },
                { kind: 'fn', name: 'mul', args: [{ kind: 'num', value: 2 }, { kind: 'slot', key: 'dbp' }] },
              ],
            },
            { kind: 'num', value: divisor },
          ],
        },
      },
      {
        itemType: 'template',
        itemId: 't.demo',
        name: '测试模板',
        enabled: true,
        docType: { system: 'local', code: 'T.DEMO', display: '测试文书' },
        sections: [
          {
            sectionCode: 'vitals',
            title: '一、生命体征',
            slots: [
              { slot: 'text', key: 'vitals' },
              { slot: 'field', key: 'heightCm', dataType: 'number', value: 170, unit: 'cm' },
              {
                slot: 'field',
                key: 'weightKg',
                dataType: 'number',
                ...(weightFilled ? { value: 65 } : {}),
                unit: 'kg',
              } as unknown as TemplatePackItem,
              { slot: 'field', key: 'sbp', dataType: 'number', value: 120 },
              { slot: 'field', key: 'dbp', dataType: 'number', value: 80 },
              { slot: 'expression', key: 'bmi', useExpression: 't.bmi' },
              { slot: 'expression', key: 'map', useExpression: 't.map' },
            ],
          },
        ],
      } as unknown as TemplatePackItem,
      {
        itemType: 'template',
        itemId: 't.dates',
        name: '日期控件模板',
        enabled: true,
        docType: { system: 'local', code: 'T.DATES', display: '日期测试' },
        sections: [
          {
            sectionCode: 'ob',
            title: '一、月经史',
            slots: [
              { slot: 'field', key: 'lmpDate', dataType: 'date', value: LMP },
              { slot: 'expression', key: 'weeks', useExpression: 't.weeks', tags: [{ system: 'local', code: 'OB.GA', display: '孕周' }] },
            ],
          },
        ],
      } as unknown as TemplatePackItem,
      {
        itemType: 'expression',
        itemId: 't.weeks',
        name: '孕周',
        unit: '周',
        enabled: true,
        /* 后半段取上下文：证明"只依赖上下文、不依赖填写项"的控件也能成立  */
        expression: { kind: 'fn', name: 'weeksBetween', args: [{ kind: 'slot', key: 'lmpDate' }, { kind: 'ctx', key: 'now' }] },
      },
    ],
  };
}

async function main(): Promise<void> {
  await test('K1 装载期校验：把问题**一次报全**（不是报一条改一条）', () => {
    validateTemplatePack(SAMPLE_PACK);
    assertEqual(sampleTemplateIds().length, 3, '样例包应有 3 类核心文书');

    const broken: TemplatePack = {
      packId: 'doc.template.broken',
      kind: 'template',
      name: '坏包',
      engineApi: 'doc-template/1',
      items: [
        {
          itemType: 'expression',
          itemId: 't.bmi',
          name: '体质指数',
          enabled: true,
          expression: { kind: 'fn', name: 'div', args: [{ kind: 'slot', key: 'weightKg' }, { kind: 'num', value: 1 }] },
        } as unknown as TemplatePackItem,
        {
          itemType: 'template',
          itemId: 't.broken',
          name: '坏模板',
          docType: { system: 'WST500', code: '', display: '' },
          sections: [
            {
              sectionCode: 's1',
              title: '一节',
              slots: [
                { slot: 'text', key: 'dup' },
                { slot: 'text', key: 'dup' },
                { slot: 'expression', key: 'x1', useExpression: 't.not-exist' },
                { slot: 'expression', key: 'x2', useExpression: 't.bmi' },
                { slot: 'field', key: 'y', dataType: 'nope' },
              ],
            },
          ],
        } as unknown as TemplatePackItem,
      ],
    };

    let issues: string[] = [];
    try {
      validateTemplatePack(broken);
    } catch (err) {
      issues = (err as Error).message.split('\n').filter((line) => line.trim().startsWith('- '));
    }
    assert(issues.length >= 4, `一次应报出多条问题，实际 ${issues.length} 条：${issues.join(' | ')}`);
    assert(issues.some((line) => line.includes('E_TPL_SLOT_KEY_DUPLICATE')), '槽位重名要报（表达式按 key 引用填写项）');
    assert(issues.some((line) => line.includes('useExpression')), '引用不存在的控件要报');
    assert(issues.some((line) => line.includes('docType')), 'docType 缺字段要报');
    assert(issues.some((line) => line.includes('dataType')), '非法 dataType 要报（否则产物过不了文档校验）');

    /* 一级派生边界：派生值不得依赖另一个派生值 */
    const chained: TemplatePack = {
      ...testPack(),
      packId: 'doc.template.chained',
      items: [
        ...(testPack().items as TemplatePackItem[]),
        {
          itemType: 'template',
          itemId: 't.chained',
          name: '派生依赖派生',
          docType: { system: 'local', code: 'T', display: 'T' },
          sections: [
            {
              sectionCode: 's',
              title: 'S',
              slots: [{ slot: 'field', key: 'weightKg', dataType: 'number' }, { slot: 'expression', key: 'a', useExpression: 't.bmi' }],
            },
          ],
        } as unknown as TemplatePackItem,
      ],
    };
    let chainedIssues: string[] = [];
    try {
      validateTemplatePack(chained);
    } catch (err) {
      chainedIssues = (err as Error).message.split('\n');
    }
    assert(
      chainedIssues.some((line) => line.includes('不存在') || line.includes('不是填写项')),
      `派生值依赖另一个派生值 / 缺失填写项必须被拒，实际：${chainedIssues.join(' | ')}`,
    );

    /* 未登记的上下文路径 */
    const badCtx: TemplatePack = {
      ...testPack(),
      packId: 'doc.template.ctx',
      items: [
        { itemType: 'expression', itemId: 't.phone', name: '手机号', enabled: true, expression: { kind: 'ctx', key: 'patient.phone' } } as unknown as TemplatePackItem,
        {
          itemType: 'template',
          itemId: 't.ctx',
          name: '未知上下文',
          docType: { system: 'local', code: 'T', display: 'T' },
          sections: [{ sectionCode: 's', title: 'S', slots: [{ slot: 'expression', key: 'p', useExpression: 't.phone' }] }],
        } as unknown as TemplatePackItem,
      ],
    };
    assertEqual(codeOf(() => validateTemplatePack(badCtx)), 'E_TPL_PACK_INVALID', '未登记的上下文路径要报（否则"取不到值"会和"还没填"长得一样）');
  });

  await test('K2 实例化产物**必然通过 validateDocument**（3 类核心文书各跑一遍）', () => {
    for (const templateId of sampleTemplateIds()) {
      const output = instantiateTemplate(SAMPLE_PACK, inputOf(templateId));
      assertEqual(errorsOf(validateDocument(output.doc)), [], `模板 ${templateId} 的产物必须通过校验`);
      assertEqual(output.doc.status, 'draft', '产物是**待填写的草稿**，不是已完成的病历');
      assertEqual(output.doc.revisions.length, 1, '只有一条 create 留痕（与 demo / 合成夹具同一约定）');
      assert(Object.keys(output.doc.nodes).length > 5, `产物应有实质内容，实际 ${Object.keys(output.doc.nodes).length} 个节点`);
    }
  });

  await test('K3 结构：槽位可定位、段落归属正确、关键内容随模板走', () => {
    const output = instantiateTemplate(SAMPLE_PACK, inputOf('tpl.outpatient.general'));
    const doc = output.doc;

    /* 槽位 → 节点 id：这是"按槽位把外部数据填回去"的前提 */
    assertEqual(nodeAt(output, 'bmi').parentId, nodeAt(output, 'weightKg').parentId, '派生值与它的填写项应在同一段落（读起来才是"身高 170cm 体重 65kg，体质指数 22.5"）');
    assertEqual(nodeAt(output, 'bmi').parentId, nodeAt(output, 'physicalExam').parentId, '字段/派生值默认并入前面那段文字');

    const sections = Object.values(doc.nodes).filter((node) => node.type === 'section');
    assertEqual(sections.length, 5, '门诊模板 5 个章节');

    /* 关键内容：主诉与初步诊断必须带 keyContent —— 模板赋予的是责任标记，不是样式  */
    assertEqual(nodeAt(output, 'chiefComplaint').keyContent, true, '主诉是关键内容');
    assertEqual(nodeAt(output, 'diagnosis').keyContent, true, '初步诊断是关键内容');
    assertEqual(nodeAt(output, 'presentIllness').keyContent, undefined, '模板没标就不该有');
    assertEqual(nodeAt(output, 'heightCm').required, true, '模板标了必填的填写项要带上 required');
  });

  await test('K4 表达式：五个控件可判定；**缺输入不编值**；除零也不编值', () => {
    const output = instantiateTemplate(testPack(), inputOf('t.demo'));
    assertEqual(nodeAt(output, 'bmi').value, 22.5, '体质指数 65 ÷ 1.7² = 22.5（可复现）');
    const map = nodeAt(output, 'map').value as number;
    assert(Math.abs(map - 280 / 3) < 1e-9, `平均动脉压应为 (120 + 2×80) ÷ 3，实际 ${String(map)}`);

    /* 缺一个输入：整体算不出，给 null 而不是 0  */
    const missing = instantiateTemplate(testPack({ weightFilled: false }), inputOf('t.demo'));
    assertEqual(nodeAt(missing, 'bmi').value, null, '缺体重时 BMI 必须是"算不出"，不是 0、不是上一次的值');
    assertEqual(nodeAt(missing, 'bmi').valueText, '', '算不出就不要给一个看起来像结果的值文本');
    assert(
      missing.result.warnings.some((text) => text.includes('weightKg')),
      `告警要点名缺了什么，实际：${JSON.stringify(missing.result.warnings)}`,
    );

    /* 除零：返回 null，不返回 Infinity（Infinity 进机读信息会变成"一个合法的数字"） */
    const zero = instantiateTemplate(testPack({ divisor: 0 }), inputOf('t.demo'));
    assertEqual(nodeAt(zero, 'map').value, null, '除零必须算不出来');

    /* 日期类控件：由两个时间相减（4 周整） */
    const dates = instantiateTemplate(testPack(), inputOf('t.dates', { context: { now: LATER } }));
    assertEqual(nodeAt(dates, 'weeks').value, 4, '2026-01-01 → 2026-01-29 应为 4 周');

    /* 日期类控件在样例包里也必须真的算得出来：曾经因为走了"只收数字"的通道而恒为 null，
       而"产物能通过校验"完全看不出来（空值本身是合法的 field 值）—— 故这里直接断言值。  */
    const admission = instantiateTemplate(SAMPLE_PACK, inputOf('tpl.admission.general'));
    assertEqual(nodeAt(admission, 'age').value, 45, '1981-03-12 出生、2026-10-08 就诊应为 45 周岁');

    assertEqual(evaluate({ kind: 'fn', name: 'div', args: [{ kind: 'num', value: 1 }, { kind: 'num', value: 0 }] }, { slots: {}, context: {} }), null, '除零 → null');
    assertEqual(evaluate({ kind: 'fn', name: 'add', args: [{ kind: 'num', value: 1 }, { kind: 'slot', key: 'absent' }] }, { slots: {}, context: {} }), null, '缺输入 → null');
    assertEqual(evaluate({ kind: 'slot', key: 'x' }, { slots: { x: 'abc' }, context: {} }), 'abc', '字符串（日期）可作为中间值');
    assertEqual(evaluate({ kind: 'fn', name: 'add', args: [{ kind: 'slot', key: 'x' }, { kind: 'num', value: 1 }] }, { slots: { x: 'abc' }, context: {} }), null, '类型不符 → null（不做隐式转换）');
    assert(validateExpression({ kind: 'fn', name: 'no-such-fn', args: [] }, 'x').length > 0, '未知函数在校验期就要报');
    assert(validateExpression({ kind: 'fn', name: 'sub', args: [{ kind: 'num', value: 1 }] }, 'x').length > 0, '参数个数不符要报');
    assert(validateExpression({ kind: 'weird' }, 'x').length > 0, '未知节点类型要报');
  });

  await test('K5 上下文：文本占位符可替换；取不到就**原样保留并告警**', () => {
    const output = instantiateTemplate(SAMPLE_PACK, inputOf('tpl.admission.general'));
    const content = textAt(output, 'generalInfo');
    assert(content.includes('王**'), `患者掩码应被替换进去，实际：${content}`);
    assert(content.includes('呼吸内科'), '就诊科室应被替换进去');
    assert(!content.includes('{{'), '都取得到时不应留下占位符');

    /* 取不到：原样保留 + 告警（把取不到的悄悄换成空串，医生看到的是一句读不通的话） */
    const noDept = instantiateTemplate(SAMPLE_PACK, inputOf('tpl.admission.general', { encounter: { visitId: 'V_T' } }));
    assertEqual(textAt(noDept, 'generalInfo').includes('{{encounter.deptCode}}'), true, '取不到的值原样保留，不猜、不清空');
    assert(
      noDept.result.warnings.some((text) => text.includes('encounter.deptCode')),
      `缺上下文要告警，实际：${JSON.stringify(noDept.result.warnings)}`,
    );
  });

  await test('K6 模板只是骨架：不带正文内容；派生值带**出处与公式**，但不带可执行的表达式树', () => {
    const output = instantiateTemplate(testPack(), inputOf('t.demo'));
    const json = JSON.stringify(output.doc);

    /* 模板定义、表达式 AST 都是包的内容，不得混进文档  */
    assert(!json.includes('"kind":"fn"'), '表达式 AST 不得进入文档（进文档的只能是可读的公式文本）');
    assert(!json.includes('useExpression'), '模板定义字段不得进入文档');
    assert(json.includes('round(div(weightKg'), '派生值必须把**公式原文**写进证据链 —— 否则事后没人说得清那个 22.5 怎么来的');
    /* 出处的尾部是内容指纹（包不再有版本号）：它由内容算出，改了内容必然变 ——
       而版本号靠人记得改，改漏了这句"出自哪一份模板"就成了假话。  */
    assert(
      json.includes(`doc.template.test#t.demo@${packFingerprintOf(testPack())}`),
      '每个节点都要能追到"出自哪份模板的哪一份内容"（指纹，不是版本号）',
    );

    const refs = ((nodeAt(output, 'bmi').provenance as { evidence?: Array<{ ref: string }> }).evidence ?? []).map((evidence) => evidence.ref);
    assert(refs.some((ref) => ref.startsWith('doc.template.test#t.demo@')), '模板出处');
    assert(refs.some((ref) => ref === 'expr:doc.template.test/t.bmi'), '控件出处（带包 id：同一公式被多份模板、多个包复用时，这一条才答得出"用的哪一版"）');

    assertEqual(textAt(output, 'vitals'), '', '模板不产生正文内容（"看起来写完的病历"比空白危险得多）');
  });

  await test('K7 纯函数与失败路径：同输入同输出；未知模板/非法包各自报错', () => {
    const first = instantiateTemplate(testPack(), inputOf('t.demo'));
    const second = instantiateTemplate(testPack(), inputOf('t.demo'));
    assertEqual(JSON.stringify(second.doc), JSON.stringify(first.doc), '同输入必须得到逐字节相同的文档（否则"回放"无从谈起）');

    assertEqual(codeOf(() => instantiateTemplate(testPack(), inputOf('t.not-exist'))), 'E_TPL_TEMPLATE_UNKNOWN', '未知模板 id');
    const broken = {
      ...testPack(),
      packId: 'doc.template.bad',
      items: [...(testPack().items as TemplatePackItem[]), { itemType: 'weird', itemId: 'w' } as unknown as TemplatePackItem],
    };
    assertEqual(codeOf(() => instantiateTemplate(broken, inputOf('t.demo'))), 'E_TPL_PACK_INVALID', '非法包必须在实例化前被拦住（fail-closed）');
  });

  await test('K8 从注册表取用：模板清单 / 控件清单 / 按 id 找包；停用即同时消失', () => {
    const registry = registryWithSamples();
    const templates = listTemplates(registry);
    assertEqual(templates.length, 3, '应列出 3 类核心文书');
    assertEqual(templates.every((item) => item.sectionCount > 0 && item.slotCount > 0), true, '模板摘要应带章节与槽位计数（界面上要能看出"这份模板有多厚"）');
    assert(templates.some((item) => item.expressionCount > 0), '至少一份模板用到派生值');

    const controls = listExpressionControls(registry);
    assertEqual(controls.length, 5, '医学表达式控件库应有 5 个控件（K4 验收口径）');
    assertEqual(controls.every((item) => item.formula.length > 0), true, '每个控件都要能给出人类可读公式');
    assertEqual(controls.some((item) => item.controlId === 'expr.gestationalWeeks'), true, '应含一个明确的专科控件（孕周）');

    const found = findTemplate(registry, 'tpl.obstetric.outpatient');
    assert(!!found && found.pack.packId === SAMPLE_PACK.packId, '应能按模板 id 找到它所属的包（跨包引用会让"依赖哪几个包在线"变成隐式条件）');

    /* 开关沿用的是上一步那套机制：停用一份模板，它就从"能开"里消失  */
    registry.setItemEnabled(SAMPLE_PACK.packId, 'tpl.obstetric.outpatient', false);
    assertEqual(listTemplates(registry).length, 2, '停用一份模板后清单少一条');
    assertEqual(findTemplate(registry, 'tpl.obstetric.outpatient'), null, '停用的模板找不到（否则界面列出、实际开不出来）');
    assertEqual(listExpressionControls(registry).length, 5, '控件库不受单个模板开关影响');
  });

  await test('K9 两类包并存互不干扰：内容指纹与生效指纹各自成立', () => {
    const registry = registryWithSamples();
    assertEqual(
      [...new Set(registry.list().map((pack) => pack.kind))].sort(),
      ['rule', 'template'],
      '装进来的是规则类包与模板包（规则类不止一个：形式类 + 时限类）',
    );

    const before = registry.contentFingerprint();
    const effectiveBefore = registry.effectiveFingerprint();
    registry.setItemEnabled(SAMPLE_PACK.packId, 'tpl.outpatient.general', false);
    assertEqual(registry.contentFingerprint(), before, '开关不属于包内容：内容指纹不变（否则"载的是哪一版"答不准）');
    assert(registry.effectiveFingerprint() !== effectiveBefore, '生效指纹应变 —— 否则"换了包"与"关了个模板"分不开');
  });

  await test('K10 派生值重算：依赖从**文档本身**还原；缺输入不编值、手改过的不动、重算幂等', () => {
    /* 重算要回到包里取公式，所以测试包必须先装载 —— 否则会走成 unresolved
       （"控件在当前包里找不到就不算"），而那条路径另有覆盖  */
    const registry = registryWithSamples();
    registry.load(testPack(), { validate: (pack) => validateTemplatePack(pack as TemplatePack) });
    const instantiated = instantiateTemplate(testPack({ weightFilled: false }), inputOf('t.demo'));
    const doc = instantiated.doc;
    const weightId = instantiated.result.slots.weightKg as NodeId;
    const bmiId = instantiated.result.slots.bmi as NodeId;

    const evidence = (doc.nodes[bmiId]?.provenance.evidence ?? []) as Array<{ ref: string; field?: string; nodeId?: string }>;
    assert(evidence.some((item) => item.field === 'bmi'), '派生值的主出处要带槽位名（重算要按它回填）');
    assert(
      evidence.some((item) => item.ref.startsWith('expr:') && !item.ref.startsWith('expr-dep:')),
      '控件出处要能回到包里取公式',
    );
    assert(
      evidence.some((item) => item.ref.startsWith('expr-dep:') && item.nodeId === weightId),
      '输入边要指向**具体的填写项节点**（否则重启之后这个派生值就再也算不出来了）',
    );

    let plan = planRecompute({ nodes: doc.nodes, patient: doc.patient, at: AT, registry });
    assertEqual(plan.changes.length, 0, '缺输入时不应产生变更');
    assertEqual(plan.pending.length, 1, '应如实报"算不出来"');
    assertEqual(plan.pending[0]?.missing, ['weightKg'], 'pending 要点名缺哪一格（测试包的字段没打标签，故回落为 key）');

    const weightNode = doc.nodes[weightId] as { value: JsonValue; valueText?: string };
    weightNode.value = 65;
    weightNode.valueText = '65';
    plan = planRecompute({ nodes: doc.nodes, patient: doc.patient, at: AT, registry });
    assertEqual(plan.changes.length, 1, '此时应产生一条变更');
    assertEqual(plan.changes[0]?.key, 'bmi', '变的是 bmi 这一格');
    assertEqual(plan.changes[0]?.next, 22.5, '65 ÷ 1.7² = 22.5');

    const session = WriteSession.open(doc);
    const keepEvidence = () => (session.document.nodes[bmiId]?.provenance.evidence ?? []).map((item) => ({ ...item }));
    const applied = session.applyExternalData({ items: [{ nodeId: bmiId, value: 22.5, evidence: keepEvidence() }] }, { id: 'template-engine', kind: 'system' });
    assertEqual(applied.applied, [bmiId], '应落笔到派生值节点');
    assertEqual(session.document.revisions.at(-1)?.op, 'external', '留痕要如实记成 external（不是"医生编辑"）');
    /* 落笔会把 provenance 整体替换，所以必须把原有证据带过去 ——
       否则依赖边被抹掉，下一次重算就再也找不到输入（实测踩到过）  */
    assert(
      (session.document.nodes[bmiId]?.provenance.evidence ?? []).some((item) => item.ref.startsWith('expr-dep:')),
      '重算落笔**不得抹掉依赖边**，否则"重算一次之后就再也算不出来"',
    );
    const again = planRecompute({ nodes: session.document.nodes, patient: session.document.patient, at: AT, registry });
    assertEqual(again.changes.length, 0, '同值再算不应产生变更（否则每次重算都写一条无意义留痕）');

    /* ⑤ 医生确认过的派生值：输入变了也不动它，如实报 skipped
       （"确认"的含义是"我看过并认可"，系统之后不该背着他改掉）  */
    /*  必须改 `session.document` 里的节点而不是外层那个 doc：`WriteSession.open` 会拷贝文档，
       改错对象的表现是"输入其实没变"，于是这条断言会静默失去意义  */
    (session.document.nodes[weightId] as { value: JsonValue }).value = 70; // 体重改了 → 公式值应为 24.2
    const bmiNode = session.document.nodes[bmiId] as { value: JsonValue; humanConfirmed?: boolean; provenance: { origin: string } };
    bmiNode.humanConfirmed = true;
    const afterConfirm = planRecompute({ nodes: session.document.nodes, patient: session.document.patient, at: AT, registry });
    assertEqual(afterConfirm.changes.length, 0, '已确认的派生值不该进变更清单');
    assertEqual(afterConfirm.skipped.map((item) => item.key), ['bmi'], '应如实报"被跳过"，而不是静默不动');
    assertEqual(bmiNode.value, 22.5, '已确认的值必须原样保留');

    /* ⑥ 两道防线都成立：即使硬塞，写路径也拒（人工内容不可被系统覆盖） */
    assertThrows(
      () =>
        session.applyExternalData(
          { items: [{ nodeId: bmiId, value: 22.5, evidence: [{ kind: 'template', ref: 'expr:recompute/t.bmi', field: 'bmi' }] }] },
          { id: 'template-engine', kind: 'system' },
        ),
      (err) => (err as { code?: string }).code === 'E_EXTERNAL_CONFLICT',
      '写路径必须自己拦住"覆盖人工内容"（不能只靠上游不发起）',
    );
  });

  await test('K11 改名称 / 适用科室 / 槽位元数据：返回新包、原包不动；内容指纹必变；控件与骨架不在开放之列', () => {
    const targetId = 'tpl.obstetric.outpatient';
    const original = SAMPLE_PACK.items.find((item) => item.itemId === targetId) as { name: string };
    const before = packFingerprintOf(SAMPLE_PACK);

    const patched = patchTemplateMeta(SAMPLE_PACK, targetId, {
      name: '产科门诊病历（2026 版）',
      departments: ['产科', '产科', '妇科'],
    });
    assertEqual(
      (patched.items.find((item) => item.itemId === targetId) as { name: string; departments?: string[] }).name,
      '产科门诊病历（2026 版）',
      '改后的名称要生效',
    );
    assertEqual(
      JSON.stringify((patched.items.find((item) => item.itemId === targetId) as { departments?: string[] }).departments),
      JSON.stringify(['产科', '妇科']),
      '科室去重但保序（"产科, 产科"不该变成两条一样的科室）',
    );
    assertEqual(
      original.name,
      (SAMPLE_PACK.items.find((item) => item.itemId === targetId) as { name: string }).name,
      '**原包一个字都不动**：改内容必须是"换一份新包"，就地改会让"现在跑的是哪一版"没法回答',
    );
    assert(packFingerprintOf(patched) !== before, '改了包内容，内容指纹就必须变（否则"改了没生效"与"生效了没人知道"混为一谈）');

    /* 停用的文书不会因为改了个名字被顺手打开：patch 只碰这两个字段 */
    const registry = registryWithSamples();
    registry.setItemEnabled(SAMPLE_PACK.packId, targetId, false);
    const loaded = registry.get(SAMPLE_PACK.packId) as TemplatePack;
    const patchedOff = patchTemplateMeta(loaded, targetId, { departments: [] });
    assertEqual(
      (patchedOff.items.find((item) => item.itemId === targetId) as { enabled?: boolean }).enabled,
      false,
      '开关状态必须带过去（改名字不等于重新启用）',
    );
    assertEqual(
      (patchedOff.items.find((item) => item.itemId === targetId) as { departments?: string[] }).departments,
      undefined,
      '留空 = 不限科室：字段整个不写（于是改回原样能回到原内容指纹，改动可逆）',
    );

    /* 槽位元数据（显示名 / 从系统带入 / 必填 / 单位）：已发布的文书也改得动。
       它与"改章节与槽位"不是一回事 —— 这几项在开文书那一刻才起作用，不进任何已开出的病历，
       所以不该逼人为了把"体温"显示成中文名而撤稿（撤稿后医生端立刻开不出这份文书）。  */
    const definition = SAMPLE_PACK.items.find((item) => item.itemId === targetId) as unknown as {
      sections: Array<{ sectionCode: string; slots: Array<Record<string, unknown>> }>;
    };
    const sectionIndex = definition.sections.findIndex((section) => section.slots.some((slot) => slot.slot === 'field'));
    assert(sectionIndex >= 0, '样例模板里应有至少一个填写项槽位（这条用例要拿它验槽位元数据）');
    const targetSection = definition.sections[sectionIndex];
    const fieldSlot = targetSection.slots.find((slot) => slot.slot === 'field') as { key: string; tags?: Array<{ display?: string }> };

    const withMeta = patchTemplateMeta(SAMPLE_PACK, targetId, {
      slotMeta: [
        { sectionCode: targetSection.sectionCode, key: fieldSlot.key, display: '体温（腋下）', required: true, unit: '℃' },
      ],
    });
    const metaSlot = ((withMeta.items.find((item) => item.itemId === targetId) as unknown as {
      sections: Array<{ sectionCode: string; slots: Array<Record<string, unknown>> }>;
    }).sections.find((section) => section.sectionCode === targetSection.sectionCode)
      ?.slots.find((slot) => slot.key === fieldSlot.key)) as {
      tags?: Array<{ system: string; code: string; display?: string }>;
      required?: boolean;
      unit?: string;
    };
    assertEqual(metaSlot?.required, true, '必填在已发布的文书上也改得动');
    assertEqual(metaSlot?.unit, '℃', '单位也改得动');
    assertEqual(metaSlot?.tags?.[0]?.display, '体温（腋下）', '显示名写在数据元标签上（医生端就是按它显示字段名）');
    assert(
      typeof metaSlot?.tags?.[0]?.code === 'string' && String(metaSlot.tags[0].code).length > 0
        && typeof metaSlot?.tags?.[0]?.system === 'string',
      '改显示名不能把数据元的体系与编码挤掉（跨文书比对认的是 system + code，只剩一个中文名就认不出它了）',
    );
    assert(
      (fieldSlot.tags?.[0]?.display ?? '') !== '体温（腋下）',
      '改的是**新包**：原包里那一格的显示名一个字都不该动',
    );

    /* 定位不到要报错，不能静默改到别的格上 */
    assertThrows(
      () => patchTemplateMeta(SAMPLE_PACK, targetId, {
        slotMeta: [{ sectionCode: targetSection.sectionCode, key: 'nope', display: 'x' }],
      }),
      (err) => (err as { code?: string }).code === 'E_TPL_SLOT_NOT_FOUND',
      '按"章节编码 + 槽位名"定位不到时要明说（静默改到别的格上是这类改动最坏的形态）',
    );
    /* 这条口子不是绕过校验的后门：写错的取值路径照旧被拒 */
    assertThrows(
      () => patchTemplateMeta(SAMPLE_PACK, targetId, {
        slotMeta: [{ sectionCode: targetSection.sectionCode, key: fieldSlot.key, from: 'patient.nickname' }],
      }),
      (err) => (err as { code?: string }).code === 'E_TPL_PACK_INVALID',
      '槽位元数据也要过同一套校验（未登记的取值路径照旧被拒）',
    );

    assertThrows(
      () => patchTemplateMeta(SAMPLE_PACK, 'expr.bmi', { name: '改个名' }),
      (err) => (err as { code?: string }).code === 'E_TPL_ITEM_NOT_TEMPLATE',
      '医学表达式控件不在这条路上：它的名字与公式就是它本身，改它属于换内容，只能重新载包',
    );
    assertThrows(
      () => patchTemplateMeta(SAMPLE_PACK, 'tpl.none', { name: 'x' }),
      (err) => (err as { code?: string }).code === 'E_TPL_ITEM_NOT_FOUND',
      '条目不存在要报"没有"，而不是静默什么都没改',
    );
    assertThrows(
      () => patchTemplateMeta(SAMPLE_PACK, targetId, { name: '   ' }),
      (err) => (err as { code?: string }).code === 'E_TPL_FIELD_INVALID',
      '名称不能为空（它是「新建」里的那一行）',
    );
    assertThrows(
      () => patchTemplateMeta(SAMPLE_PACK, targetId, {}),
      (err) => (err as { code?: string }).code === 'E_TPL_FIELD_INVALID',
      '什么都不给要报错（否则"点了保存什么都没发生"）',
    );
    /* 章节 / 槽位 / 引用哪个控件是文书骨架：这条路上改不到它们 ——
       改骨架会让已开出的病历与模板对不上，只能重新载入一份包  */
    assertEqual(
      JSON.stringify((patched.items.find((item) => item.itemId === targetId) as { sections: unknown }).sections),
      JSON.stringify((SAMPLE_PACK.items.find((item) => item.itemId === targetId) as { sections: unknown }).sections),
      '章节与槽位一个字都不变：骨架不在这条编辑口子里',
    );
  });

  await test('K11b 关键内容 / 默认值 / 参考范围 / 另起一段：已发布的文书上也改得动；进得了节点；写错当场被拒', () => {
    const targetId = 'tpl.obstetric.outpatient';
    const definition = SAMPLE_PACK.items.find((item) => item.itemId === targetId) as unknown as {
      sections: Array<{ sectionCode: string; slots: Array<Record<string, unknown>> }>;
    };
    const section = definition.sections.find((candidate) => candidate.slots.some((slot) => slot.slot === 'field')) as {
      sectionCode: string;
      slots: Array<Record<string, unknown>>;
    };
    const fieldSlot = section.slots.find((slot) => slot.slot === 'field') as { key: string; dataType: string };
    const fieldKey = String(fieldSlot.key);
    const numeric = fieldSlot.dataType === 'number';
    assert(section !== undefined && fieldKey !== '', '样例模板里应有填写项槽位（这条用例拿它验元数据）');

    const slotIn = (pack: TemplatePack): Record<string, unknown> => {
      const item = pack.items.find((candidate) => candidate.itemId === targetId) as unknown as {
        sections: Array<{ sectionCode: string; slots: Array<Record<string, unknown>> }>;
      };
      const found = item.sections.find((candidate) => candidate.sectionCode === section.sectionCode)
        ?.slots.find((candidate) => candidate.key === fieldKey);
      assert(!!found, '改完之后那一格应该还在（定位按"章节编码 + 槽位名"）');
      return found as Record<string, unknown>;
    };

    const withMeta = patchTemplateMeta(SAMPLE_PACK, targetId, {
      slotMeta: [{
        sectionCode: section.sectionCode,
        key: fieldKey,
        keyContent: true,
        value: numeric ? 165 : '165',
        referenceRange: { low: 150, high: 180, unit: numeric ? 'cm' : '文本' },
        newParagraph: true,
      }],
    });
    const afterSet = slotIn(withMeta);
    assertEqual(afterSet.keyContent, true, '关键内容标得上（"未人工确认就签不出去"那道门控就是按它判的）');
    assertEqual(afterSet.value, numeric ? 165 : '165', '默认值按数据类型存（数字型存数字，不是字符串）');
    assertEqual((afterSet.referenceRange as { high?: number })?.high, 180, '参考范围落进包（趋势按它标偏高 / 偏低）');
    assertEqual(afterSet.newParagraph, true, '强制另起一段落进包');
    assertEqual(
      slotIn(SAMPLE_PACK).keyContent,
      undefined,
      '改的是**新包**：原包那一格一个字都不该动',
    );

    const registry = registryWithSamples();
    registry.load(withMeta, { validate: (pack) => validateTemplatePack(pack as TemplatePack), replace: true });
    const catalogSlot = (((templateCatalogOf(registry).find((entry) => entry.itemId === targetId) as unknown as {
      sections: Array<{ sectionCode: string; slots: Array<Record<string, unknown>> }>;
    }).sections.find((candidate) => candidate.sectionCode === section.sectionCode)
      ?.slots.find((candidate) => candidate.key === fieldKey)) ?? {}) as Record<string, unknown>;
    assertEqual(catalogSlot.keyContent, true, '目录要把"关键内容"带出来（否则编辑框里是空的，一保存就清掉）');
    assertEqual(catalogSlot.value, numeric ? 165 : '165', '目录要把默认值带出来');
    assertEqual((catalogSlot.referenceRange as { high?: number })?.high, 180, '目录要把参考范围带出来');
    assertEqual(catalogSlot.newParagraph, true, '目录要把"另起一段"带出来');

    const output = instantiateTemplate(withMeta, inputOf(targetId));
    assertEqual(errorsOf(validateDocument(output.doc)), [], '带参考范围 / 默认值的模板，产物必须照旧合法');
    const node = nodeAt(output, fieldKey);
    assertEqual(node.keyContent, true, '关键内容要抄进节点（机读块的关键内容清单也按它派生）');
    assertEqual(node.value, numeric ? 165 : '165', '默认值落进节点（这一格不再是空待填）');
    assertEqual((node.referenceRange as { low?: number })?.low, 150, '参考范围落进节点');
    assert(
      node.referenceRange !== slotIn(withMeta).referenceRange,
      '参考范围要**深拷贝**进节点：同一份模板开出的多份文书不能共用同一个对象（改一份悄悄改到另一份）',
    );

    const cleared = patchTemplateMeta(withMeta, targetId, {
      slotMeta: [{
        sectionCode: section.sectionCode,
        key: fieldKey,
        keyContent: false,
        value: null,
        referenceRange: null,
        newParagraph: false,
      }],
    });
    const afterClear = slotIn(cleared);
    assertEqual('value' in afterClear, false, '默认值能清掉（清掉是**删字段**，不是留一个 null）');
    assertEqual('referenceRange' in afterClear, false, '参考范围能清掉');
    assertEqual(afterClear.keyContent, undefined, '关键内容能取消');
    assertEqual(afterClear.newParagraph, undefined, '另起一段能取消');
    assertEqual(
      packFingerprintOf(cleared),
      packFingerprintOf(SAMPLE_PACK),
      '全部改回去必须回到**原内容指纹**（否则"改回原样"这件事就说不清了）',
    );

    const badMeta = (slotMeta: unknown[]): string =>
      codeOf(() => patchTemplateMeta(SAMPLE_PACK, targetId, { slotMeta: slotMeta as never }));
    assertEqual(
      badMeta([{ sectionCode: section.sectionCode, key: fieldKey, referenceRange: { low: 10, high: 5 } }]),
      'E_TPL_PACK_INVALID',
      '上下限颠倒要拒（那会让趋势上的"偏高 / 偏低"整个反过来）',
    );
    assertEqual(
      badMeta([{ sectionCode: section.sectionCode, key: fieldKey, referenceRange: { unit: 'cm' } }]),
      'E_TPL_PACK_INVALID',
      '只写单位等于什么都没说（界面上却会显示成"这一格配了参考范围"）',
    );
    assertEqual(
      badMeta([{ sectionCode: section.sectionCode, key: fieldKey, referenceRange: { low: '10' } }]),
      'E_TPL_PACK_INVALID',
      '下限必须是数字（给不出数字的范围用 text，如"阴性"）',
    );
    assertEqual(
      badMeta([{ sectionCode: section.sectionCode, key: fieldKey, referenceRange: { low: 1, high: 2, weird: 1 } }]),
      'E_TPL_PACK_INVALID',
      '不认识的键要拒（认了的键才是能被消费的键）',
    );
    assertEqual(
      badMeta([{ sectionCode: section.sectionCode, key: fieldKey, value: numeric ? '165' : 165 }]),
      'E_TPL_PACK_INVALID',
      '默认值与数据类型对不上要拒（"165" 与 165 在界面上一模一样，到了文档里却是两种东西）',
    );
    /* 「另起一段」对结构文本没有意义：那一档本来就另起一段，写进去只会多一个说不清的设置 */
    const textSection = definition.sections.find((candidate) => candidate.slots.some((slot) => slot.slot === 'text')) as {
      sectionCode: string;
      slots: Array<Record<string, unknown>>;
    };
    const textKey = String((textSection.slots.find((slot) => slot.slot === 'text') as { key: string }).key);
    assertEqual(
      badMeta([{ sectionCode: textSection.sectionCode, key: textKey, newParagraph: true }]),
      'E_TPL_FIELD_INVALID',
      '结构文本不给「强制另起一段」（它本来就会另起一段）',
    );
  });

  await test('K12 新建的文书是**草稿**：开不出、改得动；发布是显式动作；删除不影响已开出的病历', () => {
    const registry = registryWithSamples();
    const pack = registry.get(SAMPLE_PACK.packId) as TemplatePack;

    const created = addTemplate(pack, {
      name: '产科入院记录',
      docType: { system: 'local', code: 'obAdmission', display: '产科入院记录' },
      departments: ['产科'],
    });
    const draft = created.pack.items.find((item) => item.itemId === created.itemId) as TemplateDefinition;
    assertEqual(draft.status, 'draft', '新建出来必须是**草稿**（建好就能开会让人照着残缺骨架开病历）');
    assertEqual((draft.sections ?? []).length > 0, true, '新建也要给一份能过校验的最小骨架（空模板产不出任何东西）');
    assertEqual(
      (created.pack.items.find((item) => item.itemId === created.itemId) as { departments?: string[] }).departments,
      JSON.parse(JSON.stringify(['产科'])),
      '科室按给的顺序留下',
    );
    assertEqual(
      (pack.items.find((item) => item.itemId === created.itemId) as unknown) === undefined,
      true,
      '原包不动：新建是"换一份新包"',
    );

    /* 同 packId 重新装载要显式声明 `replace`：否则"两份内容顶着同一个 id"会被拒绝，
       而这也正是"换一版内容"必须被看见的意思 */
    registry.load(created.pack, { validate: (p) => validateTemplatePack(p as TemplatePack), replace: true });
    assertEqual(
      listTemplates(registry).some((item) => item.templateId === created.itemId),
      false,
      '草稿不得出现在"能开哪几种文书"里',
    );
    assertEqual(findTemplate(registry, created.itemId), null, '草稿按 id 也找不到（否则界面列着、实际开不出）');

    const withSections = patchTemplateMeta(created.pack, created.itemId, {
      sections: [{ sectionCode: 'cc', title: '主诉', slots: [{ slot: 'text', key: 'cc', text: '' }] }],
    });
    assertEqual(
      (withSections.items.find((item) => item.itemId === created.itemId) as TemplateDefinition).sections.length,
      1,
      '草稿的章节可以改',
    );

    const published = patchTemplateMeta(withSections, created.itemId, { status: 'active' });
    registry.load(published, { validate: (p) => validateTemplatePack(p as TemplatePack), replace: true });
    assertEqual(
      listTemplates(registry).some((item) => item.templateId === created.itemId),
      true,
      '发布后它才进入"能开"',
    );
    assertThrows(
      () => patchTemplateMeta(published, created.itemId, { sections: [{ sectionCode: 'x', title: 'X', slots: [{ slot: 'text', key: 'x', text: '' }] }] }),
      (err) => (err as { code?: string }).code === 'E_TPL_STATUS_PUBLISHED',
      '已发布的文书不许改骨架（改它会让"当时按哪一版开的"对不上）',
    );
    /* 但名称与科室随时可改：它们不进任何已开出的文档 */
    assertEqual(
      (patchTemplateMeta(published, created.itemId, { name: '产科入院记录（2026 版）' }).items
        .find((item) => item.itemId === created.itemId) as TemplateDefinition).name,
      '产科入院记录（2026 版）',
      '已发布的文书改名可以',
    );

    /* ⑤ 校验不过的骨架当场被拒：报的是"第几章第几个槽位"，不是一句"整包不通过" */
    assertThrows(
      () => patchTemplateMeta(created.pack, created.itemId, {
        sections: [{ sectionCode: 'cc', title: '主诉', slots: [{ slot: 'text', key: 'cc', text: '' }, { slot: 'text', key: 'cc', text: '' }] }],
      }),
      (err) => (err as { code?: string }).code === 'E_TPL_PACK_INVALID'
        && String((err as Error).message).includes('重复'),
      '槽位 key 重复要被拦住（表达式按 key 引用填写项，重名会指到别人身上）',
    );
    assertThrows(
      () => addTemplate(null, { name: '', docType: { system: 'local', code: 'x', display: 'X' } }),
      (err) => (err as { code?: string }).code === 'E_TPL_FIELD_INVALID',
      '没有名字的文书要被拒（它是「新建」里的那一行）',
    );

    /* ⑥ 删除：包里少一条 */
    const removed = removeTemplate(published, created.itemId);
    assertEqual(
      removed.items.some((item) => item.itemId === created.itemId),
      false,
      '删除后包里没有它',
    );
    assertEqual(
      (published.items.find((item) => item.itemId === created.itemId) as unknown) !== undefined,
      true,
      '删除同样不动原包（已开出的病历只带指纹，不受影响）',
    );
    assertThrows(
      () => removeTemplate(removed, created.itemId),
      (err) => (err as { code?: string }).code === 'E_TPL_ITEM_NOT_FOUND',
      '删一个不存在的条目要报错，而不是静默什么都没做',
    );
  });

  await test('K13 系统带入与科室判定：字段按上下文取值（取不到不编值），"限科室"真的拦得住', () => {
    const custom = addTemplate(null, {
      name: '带入测试文书',
      docType: { system: 'local', code: 'bringIn', display: '带入测试文书' },
      sections: [
        {
          sectionCode: 'head',
          title: '抬头',
          slots: [
            { slot: 'field', key: 'name', dataType: 'text', from: 'patient.nameMasked' },
            { slot: 'field', key: 'dept', dataType: 'text', from: 'encounter.deptName' },
            { slot: 'field', key: 'doctor', dataType: 'text', from: 'doctor.actorId' },
            { slot: 'field', key: 'outAt', dataType: 'date', from: 'encounter.dischargedAt' },
            { slot: 'text', key: 'line', text: '患者 {{patient.nameMasked}}，就诊科室 {{encounter.deptName}}，开单 {{doctor.actorId}}' },
          ],
        },
      ],
      status: 'active',
    });
    const output = instantiateTemplate(custom.pack, inputOf(custom.itemId, {
      doctor: { actorId: 'DR_9' },
      /* 科室名称由调用方补进上下文：引擎不认识科室字典，也不该认识  */
      context: { 'encounter.deptName': '呼吸内科' },
    }));
    assertEqual(nodeAt(output, 'name').value, '王**', '患者姓名按上下文带入');
    assertEqual(nodeAt(output, 'dept').value, '呼吸内科', '科室名称按调用方给的上下文带入');
    assertEqual(nodeAt(output, 'doctor').value, 'DR_9', '开单医生带入的是**账号**（账号体系里没有姓名字段）');
    assertEqual(nodeAt(output, 'outAt').value, null, '上下文中没有的值（未出院）**保持未填**，绝不编一个出来');
    assertEqual(textAt(output, 'line'), '患者 王**，就诊科室 呼吸内科，开单 DR_9', '文本里的占位符同样按上下文替换');
    assertEqual(errorsOf(validateDocument(output.doc)), [], '带入的值也要产出合法文档（带入不是绕过校验的通道）');
    /* 证据链要留下"从哪个系统字段带进来的"：只记模板出处的话，
       界面只能把它显示成"模板带入"，而那个名字是错的（值来自患者信息，不是模板编的内容） */
    const deptNode = output.doc.nodes[output.result.slots.dept as NodeId];
    assert(
      (deptNode.provenance.evidence ?? []).some((evidence) => evidence.kind === 'his' && evidence.ref === 'ctx:encounter.deptName'),
      `从系统带入的值要在证据链里留下来源，实际：${JSON.stringify(deptNode.provenance.evidence)}`,
    );
    /* 取不到必须告警说出缺哪一格：否则"没带入"与"医生还没填"长得一模一样  */
    assert(
      output.result.warnings.some((warning) => warning.includes('outAt') && warning.includes('encounter.dischargedAt')),
      `取不到值时要有告警，实际：${JSON.stringify(output.result.warnings)}`,
    );

    const badPath = JSON.parse(JSON.stringify(custom.pack)) as TemplatePack;
    (badPath.items[0] as unknown as { sections: Array<{ slots: Array<Record<string, unknown>> }> }).sections[0].slots[0].from = 'patient.nickname';
    assertThrows(
      () => validateTemplatePack(badPath),
      (err) => String((err as Error).message).includes('patient.nickname'),
      '未登记的取值路径要报，并点出错的那个路径',
    );

    const generic = addTemplate(null, {
      name: '通用文书',
      docType: { system: 'local', code: 'anyDept', display: '通用文书' },
      status: 'active',
    });
    const limited = addTemplate(null, {
      name: '限产科文书',
      docType: { system: 'local', code: 'obOnly', display: '限产科文书' },
      departments: ['DEPT_OB'],
      status: 'active',
    });
    const genericDef = generic.pack.items[0] as TemplateDefinition;
    const limitedDef = limited.pack.items[0] as TemplateDefinition;
    assertEqual(deptAllowsTemplate(genericDef, undefined), true, '通用文书在"没有科室信息"的就诊上也开得出');
    assertEqual(deptAllowsTemplate(limitedDef, 'DEPT_OB'), true, '科室匹配时可开');
    assertEqual(deptAllowsTemplate(limitedDef, 'DEPT_RESP'), false, '科室不匹配时开不出');
    assertEqual(deptAllowsTemplate(limitedDef, undefined), false, '就诊没有科室信息时，限科室的开不出');

    const registry = createEmptyPackRegistry();
    registry.load(limited.pack, { validate: (pack) => validateTemplatePack(pack as TemplatePack) });
    assertEqual(listTemplates(registry, { deptCode: 'DEPT_OB' }).length, 1, '科室匹配时列入名单');
    assertEqual(listTemplates(registry, { deptCode: 'DEPT_RESP' }).length, 0, '不匹配就不列（列出再拒是让人白点一次）');
    assertEqual(listTemplates(registry, { deptCode: '' }).length, 0, '就诊没有科室时同样不列');
    assertEqual(listTemplates(registry).length, 1, '不传 deptCode = 不过滤');
  });

  await test('K14 控件可改可删：改公式换的是"怎么算"，被文书引用的控件删不掉（并指出是谁在用）', () => {
    const created = addExpression(null, {
      name: '自测 BMI',
      unit: 'kg/m²',
      expression: { kind: 'fn', name: 'div', args: [{ kind: 'slot', key: 'weight' }, { kind: 'num', value: 1 }] },
    });
    const controlId = created.itemId;
    const controlOf = (pack: TemplatePack): ExpressionDefinition => pack.items.find((item) => item.itemId === controlId) as ExpressionDefinition;

    const renamed = patchExpression(created.pack, controlId, { name: '体质量指数', unit: 'kg/m²' });
    assertEqual(controlOf(renamed).name, '体质量指数', '改名生效');
    assertEqual(controlOf(created.pack).name, '自测 BMI', '原包一个字不动（改的是"换一版内容"）');

    const repatched = patchExpression(renamed, controlId, {
      expression: {
        kind: 'fn',
        name: 'div',
        args: [
          { kind: 'slot', key: 'weight' },
          { kind: 'fn', name: 'pow', args: [{ kind: 'slot', key: 'height' }, { kind: 'num', value: 2 }] },
        ],
      },
    });
    assert(
      describeExpression(controlOf(repatched).expression).includes('pow'),
      `公式应换成新那一版，实际：${describeExpression(controlOf(repatched).expression)}`,
    );
    assertThrows(
      () => patchExpression(repatched, controlId, { expression: { kind: 'fn', name: 'div', args: [{ kind: 'num', value: 1 }] } }),
      (err) => (err as { code?: string }).code === 'E_TPL_PACK_INVALID',
      '参数个数不对的公式要被拒（报的是"哪一层哪一格不对"）',
    );
    assertThrows(
      () => patchExpression(repatched, controlId, {}),
      (err) => (err as { code?: string }).code === 'E_TPL_FIELD_INVALID',
      '没有要改的字段要报错，不能静默返回原包',
    );
    /* 单位清空 = 去掉这个字段（而不是留一个空串）：否则"改回原样"回不到原内容指纹  */
    assertEqual('unit' in (patchExpression(repatched, controlId, { unit: '' }).items[0] as object), false, '单位留空 = 去掉这个字段');

    const withTemplate = addTemplate(repatched, {
      name: '用控件的文书',
      docType: { system: 'local', code: 'usesExpr', display: '用控件的文书' },
      sections: [
        {
          sectionCode: 'body',
          title: '正文',
          slots: [
            { slot: 'field', key: 'weight', dataType: 'number' },
            { slot: 'field', key: 'height', dataType: 'number' },
            { slot: 'expression', key: 'bmi', useExpression: controlId },
          ],
        },
      ],
      status: 'active',
    });
    assertEqual(expressionUsedBy(withTemplate.pack, controlId).length, 1, '影响面要算得出来（界面据此提示、服务端据此拒绝）');
    assertThrows(
      () => removeExpression(withTemplate.pack, controlId),
      (err) => (err as { code?: string }).code === 'E_TPL_EXPR_IN_USE'
        && String((err as Error).message).includes('用控件的文书'),
      '被引用时删不掉，且消息里要点出是哪份文书在用',
    );
    /* 删掉那份文书之后就能删控件了（这条路走得通，所以拦住它是合理的） */
    const withoutTemplate = removeTemplate(withTemplate.pack, withTemplate.itemId);
    assertEqual(
      removeExpression(withoutTemplate, controlId).items.some((item) => item.itemId === controlId),
      false,
      '没人用之后可以删',
    );
    /* 品类拿错要报清楚：拿文书 id 去删控件，说的是"它不是控件"，而不是"找不到" */
    assertThrows(
      () => removeExpression(withTemplate.pack, withTemplate.itemId),
      (err) => (err as { code?: string }).code === 'E_TPL_ITEM_NOT_TEMPLATE',
      '拿文书 id 删控件要报品类不对',
    );
  });

  /* ------------------- L：章节属性 / 排序 / 从已有内容出发（复制与片段） -------------------
     这一组盯的是三件会被静默破坏的事：
       · 章节属性（必备 / 整章算关键内容）抄漏了不会当场报错，只会让"必备"变成一句空话；
       · 顺序若被当成包里一个字段去维护，就会出现"界面看到的顺序与库里那份不一致"；
       · 复制与片段若丢了控件引用，要等医生开那份文书的时候才发现（那时早已想不起复制过什么）。
     每一条都用产物说话（实例化出来的文档、写回包里那一份），不看中间变量。  */

  /** 章节标题按 order 排出来的那一串（顺序是这一组要证的东西） */
  const sectionTitlesOf = (output: InstantiateOutput): string => Object.values(output.doc.nodes)
    .filter((node) => node.type === 'section')
    .sort((a, b) => a.order - b.order)
    .map((node) => node.title ?? '')
    .join('');

  await test('L1 章节属性：必备 / 整章算关键内容抄进文档；不写 false；章节说明不进病历', () => {
    const created = addTemplate(testPack(), {
      name: '带章节属性',
      docType: { system: 'local', code: 'attrs', display: '带章节属性' },
      sections: [
        {
          sectionCode: 'vital',
          title: '生命体征',
          required: true,
          keyContent: true,
          description: '写清体温 / 脉搏 / 呼吸 / 血压',
          slots: [
            { slot: 'field', key: 'weightKg', dataType: 'number', value: 60 },
            { slot: 'field', key: 'heightCm', dataType: 'number', value: 170 },
          ],
        },
        { sectionCode: 'note', title: '备注', slots: [{ slot: 'text', key: 'note', text: '' }] },
      ],
    });
    const output = instantiateTemplate(created.pack, inputOf(created.itemId));
    const sections = Object.values(output.doc.nodes).filter((node) => node.type === 'section') as unknown as Array<Record<string, unknown>>;
    const vital = sections.find((node) => node.sectionCode === 'vital') as Record<string, unknown>;
    const note = sections.find((node) => node.sectionCode === 'note') as Record<string, unknown>;
    assertEqual(vital.required, true, '必备章节要抄进文档（只留在模板里就管不住已开出的病历）');
    assertEqual(vital.keyContent, true, '整章算关键内容要抄进文档（签名门控按节点判它）');
    assertEqual('required' in note, false, '没标必备的章节不得写 required:false（那会凭空多出一份指纹差异）');
    assertEqual('keyContent' in note, false, '没标关键内容的章节同理');
    assertEqual('description' in vital, false, '章节说明是给医生的提示、不是病历内容：不得进文档模型');
    /* 这一条是 `model/validate.ts` 白名单的回归闸：漏登记 `required` 会让全部文档以
       E_UNKNOWN_FIELD 报错，而那份报错会指向"节点字段不认"，很难联想到"加了章节属性"  */
    assertEqual(errorsOf(validateDocument(output.doc)).length, 0, '带章节属性的产物必须通过文档校验');
  });

  await test('L2 排序：顺序就是数组顺序 —— 重排 sections 后开出来的章节顺序随之变（order = 序号 × 10）', () => {
    const created = addTemplate(testPack(), {
      name: '三章',
      docType: { system: 'local', code: 'three', display: '三章' },
      sections: [
        { sectionCode: 'a', title: '甲', slots: [{ slot: 'text', key: 'a1', text: 'A' }] },
        { sectionCode: 'b', title: '乙', slots: [{ slot: 'text', key: 'b1', text: 'B' }] },
        { sectionCode: 'c', title: '丙', slots: [{ slot: 'text', key: 'c1', text: 'C' }] },
      ],
    });
    const before = instantiateTemplate(created.pack, inputOf(created.itemId));
    assertEqual(sectionTitlesOf(before), '甲乙丙', '初始顺序按数组顺序');

    /* 排序 = 数组重排（界面上就是把两个元素换个位置）：不改包格式、不改内核、
       不需要在包里多一个 order 字段 —— 多一个字段就多一处"它和数组顺序不一致"的可能  */
    const items: TemplatePackItem[] = created.pack.items.map((item) => (item.itemType === 'template' && item.itemId === created.itemId
      ? { ...item, sections: [item.sections[2], item.sections[0], item.sections[1]] }
      : item));
    const reordered: TemplatePack = { ...created.pack, items };
    assertEqual(codeOf(() => validateTemplatePack(reordered)), 'OK', '重排之后整包照样合法');
    const after = instantiateTemplate(reordered, inputOf(created.itemId));
    assertEqual(sectionTitlesOf(after), '丙甲乙', '重排后开出来的章节顺序随之变');
    const orders = Object.values(after.doc.nodes)
      .filter((node) => node.type === 'section')
      .map((node) => node.order)
      .sort((a, b) => a - b);
    assertEqual(orders.join(','), '10,20,30', 'order 由序号算出来（留出插入余量，界面的排序不碰它）');
  });

  await test('L3 复制一份文书：引用的控件一起带过来（改名 + useExpression 同步），副本恒为草稿，原包不动', () => {
    const source = addTemplate(testPack(), {
      name: '带控件的文书',
      docType: { system: 'local', code: 'usesExpr', display: '带控件的文书' },
      sections: [{
        sectionCode: 'body',
        title: '正文',
        slots: [
          { slot: 'field', key: 'weightKg', dataType: 'number' },
          { slot: 'field', key: 'heightCm', dataType: 'number' },
          { slot: 'expression', key: 'bmi', useExpression: 't.bmi' },
        ],
      }],
      status: 'active',
    });
    const sourceItemCount = source.pack.items.length;
    const copied = copyTemplateIntoPack(null, source.pack, source.itemId);
    assertEqual(copied.copiedControls.length, 1, '跨包复制时，引用的控件要一起带过来（模板只允许同包引用控件）');
    const copy = copied.pack.items.find((item) => item.itemId === copied.itemId) as TemplateDefinition;
    assertEqual(copy.status, 'draft', '副本恒为草稿（复制多半是为了改它，当场可开会让人照着它开出残缺病历）');
    assertEqual(copy.sections[0].slots[2].slot, 'expression', '用例前提：第三个槽位是表达式槽位');
    assertEqual(
      (copy.sections[0].slots[2] as { useExpression: string }).useExpression,
      copied.copiedControls[0].to,
      '副本里的 useExpression 要指向改名后的控件（漏这一步的报错完全指不到真正的原因）',
    );
    assertEqual(copied.copiedControls[0].from, 't.bmi', '记住它是从哪个控件来的（界面要说清带过来了什么）');
    assertEqual(codeOf(() => validateTemplatePack(copied.pack)), 'OK', '复制出来的整包必须通过校验');
    /* 原包一个字不动：复制不能把源模板就地改掉（那会让"我复制了一份"变成"我改了原件"） */
    const stillSource = source.pack.items.find((item) => item.itemId === source.itemId) as TemplateDefinition;
    assertEqual((stillSource.sections[0].slots[2] as { useExpression: string }).useExpression, 't.bmi', '原模板的引用不得被改写');
    assertEqual(source.pack.items.length, sourceItemCount, '原包条目数不变（复制不往源包里加东西）');

    /* 目标包里已经有同名控件 → 复用，不再复制一份（否则"改公式改哪一份"就变成猜谜）  */
    const again = copyTemplateIntoPack(copied.pack, copied.pack, copied.itemId);
    assertEqual(again.copiedControls.length, 0, '同包已有同名控件时复用');

    assertEqual(codeOf(() => copyTemplateIntoPack(null, source.pack, 't.bmi')), 'E_TPL_ITEM_NOT_TEMPLATE', '控件不能当"一份文书"复制');
  });

  await test('L4 章节片段：建 / 改 / 删都拒绝半成品，且它不会被当成一份能开的文书', () => {
    const created = addFragment(null, {
      name: '门诊查体',
      description: '门诊常规',
      sections: [{ sectionCode: 'pe', title: '体格检查', slots: [{ slot: 'text', key: 'pe1', text: '一般情况可' }] }],
    });
    assertEqual(created.itemId, 'frag.custom.1', '片段走 `frag.custom.N`，与文书 / 控件同一套可读编号');

    const registry = createEmptyPackRegistry();
    registry.load(created.pack, { validate: (pack) => validateTemplatePack(pack as TemplatePack) });
    assertEqual(listTemplates(registry).length, 0, '片段不得出现在医生端「新建」的清单里（它开不出病历）');
    assertEqual(listFragments(registry).length, 1, '片段清单里应有一条');
    assertEqual(listFragments(registry)[0].sectionCount, 1, '片段清单要带规模（只看名字选不出该插哪一段）');

    assertEqual(codeOf(() => addFragment(created.pack, { name: '空片段', sections: [] })), 'E_TPL_FIELD_INVALID', '空片段要拒（插进去什么都不会发生）');
    assertEqual(codeOf(() => addFragment(created.pack, { name: '  ', sections: [{ sectionCode: 'x', title: 'X', slots: [{ slot: 'text', key: 'x1', text: '' }] }] })), 'E_TPL_FIELD_INVALID', '没名字要拒');

    const patched = patchFragment(created.pack, created.itemId, {
      name: '查体（门诊）',
      description: '',
      sections: [
        { sectionCode: 'pe', title: '体格检查', required: true, slots: [{ slot: 'text', key: 'pe1', text: '一般情况可' }] },
        { sectionCode: 'pe2', title: '专科检查', slots: [{ slot: 'text', key: 'pe2', text: '' }] },
      ],
    });
    const fragment = patched.items.find((item) => item.itemId === created.itemId) as unknown as Record<string, unknown>;
    assertEqual(fragment.name, '查体（门诊）', '片段可改名');
    assertEqual('description' in fragment, false, '说明清空 = 删掉这个键（不是留一句空说明）');
    assertEqual((fragment.sections as Array<{ required?: boolean }>)[0].required, true, '章节属性在片段里同样能配');
    assert(!!created.pack.items.find((item) => item.itemId === created.itemId), '原包仍在（补丁返回的是新包）');
    assertEqual(removeFragment(patched, created.itemId).items.length, 0, '片段可删：插入是复制，不存在"还被谁用着"');
    assertEqual(codeOf(() => removeFragment(patched, 'frag.nope')), 'E_TPL_ITEM_NOT_FOUND', '删不存在的片段要说清是找不到');
    assertEqual(codeOf(() => patchFragment(patched, created.itemId, {})), 'E_TPL_FIELD_INVALID', '没有要改的字段要报错，不静默返回原包');
  });

  await test('L5 片段引用的控件：能从别处取到就一起带过来，取不到就明说（不许存一条引用不存在控件的素材）', () => {
    /* 显式标注：字面量里的 `slot: 'field'` 会被推成 string，而 TemplateSlot 是判别联合 ——
       不标注就不是"写错了被校验拦住"，而是"编译期就过不去"，用例反而跑不到它想验的那条路径。 */
    const sections: TemplateSection[] = [{
      sectionCode: 'body',
      title: '正文',
      slots: [
        { slot: 'field', key: 'weightKg', dataType: 'number' },
        { slot: 'field', key: 'heightCm', dataType: 'number' },
        { slot: 'expression', key: 'bmi', useExpression: 't.bmi' },
      ],
    }];
    const carried = addFragment(null, { name: '带控件的片段', sections }, {
      lookupControl: (controlId) => testPack().items.find((item) => item.itemType === 'expression' && item.itemId === controlId) as
        | ExpressionDefinition
        | undefined,
    });
    assertEqual(carried.copiedControls.length, 1, '控件定义能取到就带进目标包（片段必须自足）');
    assertEqual(codeOf(() => validateTemplatePack(carried.pack)), 'OK', '带控件的片段包必须通过校验');
    /* 取不到定义（本机任何包里都没有这个控件）：明说，而不是存一条永远插不进去的素材  */
    assertEqual(codeOf(() => addFragment(null, { name: '引用缺失控件', sections })), 'E_TPL_EXPR_UNKNOWN', '找不到控件定义要报 E_TPL_EXPR_UNKNOWN');
  });

  await test('L6 章节属性补丁（sectionMeta）：能定位、重码拒绝、已发布也能改、原包不动', () => {
    const created = addTemplate(testPack(), {
      name: '已发布的文书',
      docType: { system: 'local', code: 'meta', display: '已发布的文书' },
      sections: [
        { sectionCode: 'a', title: '甲', slots: [{ slot: 'text', key: 'a1', text: '' }] },
        { sectionCode: 'b', title: '乙', slots: [{ slot: 'text', key: 'b1', text: '' }] },
      ],
      status: 'active',
    });
    const patched = patchTemplateMeta(created.pack, created.itemId, {
      sectionMeta: [
        { sectionCode: 'a', required: true, keyContent: true, description: '写清三要素' },
        { sectionCode: 'b', description: null },
      ],
    });
    const definition = patched.items.find((item) => item.itemId === created.itemId) as TemplateDefinition;
    assertEqual(definition.status, 'active', '已发布的文书也能改章节属性（它在开文书那一刻才起作用，不进已开出的病历）');
    assertEqual(definition.sections[0].required, true, '必备能标上');
    assertEqual(definition.sections[0].keyContent, true, '整章算关键内容能标上');
    assertEqual(definition.sections[0].description, '写清三要素', '说明能写上');
    const original = created.pack.items.find((item) => item.itemId === created.itemId) as TemplateDefinition;
    assertEqual(original.sections[0].required, undefined, '原包不得被就地改动（补丁改的是复制出来的一份）');

    assertEqual(
      codeOf(() => patchTemplateMeta(patched, created.itemId, { sectionMeta: [{ sectionCode: 'nope', required: true }] })),
      'E_TPL_SECTION_INVALID',
      '定位不到那一章要报错，不静默什么都不做',
    );
    assertEqual(
      codeOf(() => patchTemplateMeta(patched, created.itemId, {
        sections: original.sections,
        sectionMeta: [{ sectionCode: 'a', required: false }],
      })),
      'E_TPL_FIELD_INVALID',
      '整份骨架与元数据补丁不能一起交（该照哪一份算没有共识）',
    );

    /* 章节编码在模板内重复时拒绝：按编码定位的补丁不能悄悄改到"第一个同码的章节"上  */
    const dup = addTemplate(testPack(), {
      name: '重码',
      docType: { system: 'local', code: 'dup', display: '重码' },
      sections: [
        { sectionCode: 'x', title: '一', slots: [{ slot: 'text', key: 'x1', text: '' }] },
        { sectionCode: 'x', title: '二', slots: [{ slot: 'text', key: 'x2', text: '' }] },
      ],
    });
    assertEqual(
      codeOf(() => patchTemplateMeta(dup.pack, dup.itemId, { sectionMeta: [{ sectionCode: 'x', required: true }] })),
      'E_TPL_SECTION_INVALID',
      '编码重复时要拒绝定位，而不是猜一章',
    );
  });

  await test('K16 表格槽位：产出一张能填的表（每格一个填写项）、列定义进得了目录、写不对当场被拒', () => {
    const created = addTemplate(null, {
      name: '带表格的文书',
      docType: { system: 'local', code: 'vitals', display: '带表格的文书' },
      sections: [{
        sectionCode: 'vitals',
        title: '生命体征',
        slots: [
          { slot: 'text', key: 'peText', text: '生命体征见下表。' },
          {
            slot: 'table',
            key: 'vitalsTable',
            columns: [
              { title: '时间', dataType: 'date' },
              {
                title: '体温',
                dataType: 'number',
                unit: '℃',
                tags: [{ system: 'local', code: 'vitals.temp', display: '体温' }],
              },
              { title: '备注' },
            ],
            rows: 2,
          },
        ],
      }],
    });
    const withTable = created.pack;
    const templateId = created.itemId;
    const output = instantiateTemplate(withTable, inputOf(templateId));

    assertEqual(errorsOf(validateDocument(output.doc)), [], '带表格的模板产出的文档必须通过 validateDocument');

    const kids = (id: string): Array<Record<string, unknown>> => Object.values(output.doc.nodes)
      .filter((node) => (node as unknown as { parentId?: string }).parentId === id)
      .sort((a, b) => ((a as unknown as { order: number }).order - (b as unknown as { order: number }).order)) as unknown as Array<Record<string, unknown>>;
    const inlineText = (id: string): string => {
      const runs = (kids(id)[0] as { runs?: Array<{ text: string }> }).runs ?? [];
      return runs.map((run) => run.text).join('');
    };

    const tableId = output.result.slots.vitalsTable as string;
    const table = output.doc.nodes[tableId] as unknown as Record<string, unknown>;
    assertEqual(table.type, 'table', '槽位名指向表格节点');
    assertEqual(table.colCount, 3, '列数 = 表头列数');
    assertEqual(table.headerRows, 1, '表头一行');
    const rows = kids(tableId);
    assertEqual(rows.length, 3, '1 行表头 + 2 行数据');
    assertEqual(rows[0].type, 'tableRow', '行是 tableRow');
    assertEqual(kids(String(rows[0].id)).length, 3, '表头三格');
    assertEqual(
      kids(String(rows[0].id)).map((cell) => inlineText(String(cell.id))).join('/'),
      '时间/体温/备注',
      '表头文字就是列名（列名写错的表现就是表头写错，所以这一条要钉住）',
    );

    const dataRowCells = kids(String(rows[1].id));
    const cellField = (cell: Record<string, unknown>): Record<string, unknown> => kids(String(cell.id))[0];
    assertEqual(cellField(dataRowCells[0]).type, 'field', '数据格里是填写项（不是只读文本）');
    assertEqual(cellField(dataRowCells[0]).dataType, 'date', '列上的类型落进格子');
    assertEqual(cellField(dataRowCells[1]).dataType, 'number', '数值列才画得出趋势');
    assertEqual(cellField(dataRowCells[1]).unit, '℃', '列上的单位要落进格子（"32 是什么"必须有答案）');
    assertEqual(cellField(dataRowCells[2]).dataType, 'text', '不写 dataType 的列默认 text');
    /* 列上绑的数据元必须落到每一格上：机器读的是一格一格的值，表格只是容器。
       同一列的多行共用同一条标签（`code` 一致），跨文书比对才认得出"这是同一个体温"。  */
    assertEqual(
      JSON.stringify(cellField(dataRowCells[1]).tags),
      JSON.stringify([{ system: 'local', code: 'vitals.temp', display: '体温' }]),
      '列上的数据元要落进每一格（落在表格上等于机器永远读不到）',
    );
    assertEqual(
      cellField(dataRowCells[0]).tags,
      undefined,
      '没绑数据元的列不带标签（空数组会被文档校验拒掉）',
    );
    assertEqual(
      JSON.stringify(cellField(kids(String(rows[2].id))[1]).tags),
      JSON.stringify([{ system: 'local', code: 'vitals.temp', display: '体温' }]),
      '第 2 行同列也要带（标签属于列，不属于某一格）',
    );
    assertEqual(cellField(dataRowCells[0]).value, null, '格子默认空待填：模板不编值');

    const secondRowFirstCell = output.result.slots['vitalsTable.r2c3'] as string;
    assert(typeof secondRowFirstCell === 'string', '第 2 行第 3 列应能按名字定位');
    assertEqual((output.doc.nodes[secondRowFirstCell] as unknown as { type: string }).type, 'field', '定位到的是填写项');
    assertEqual(
      (output.doc.nodes[secondRowFirstCell] as unknown as { provenance: { evidence?: Array<{ field?: string }> } })
        .provenance.evidence?.[0]?.field,
      'vitalsTable.r2c3',
      '证据链要写清是哪个格子（否则"这个数从哪一格来的"事后没人答得出）',
    );

    /* ⑤ 表格自己占一段：跟在一句话后面（同一个段落里）会让段落操作把整张表当成那句话的一部分搬走  */
    const tableParagraphId = String(table.parentId);
    assertEqual(
      (output.doc.nodes[tableParagraphId] as unknown as { type: string }).type,
      'paragraph',
      '表格挂在段落下面（与文本 / 填写项同一种归属：段落级操作才有意义）',
    );
    assert(
      (output.doc.nodes[output.result.slots.peText as string] as unknown as { parentId: string }).parentId !== tableParagraphId,
      '表格不与前面那句结构文本共用段落',
    );

    /* ⑥ 目录投影：列与行数要读得回来 —— 抽屉是"读回 → 改 → 写回"，少一项就静默清掉一项 */
    const registry = createEmptyPackRegistry();
    registry.load(withTable, { validate: (pack) => validateTemplatePack(pack as TemplatePack) });

    const catalogSlot = templateCatalogOf(registry).find((entry) => entry.itemId === templateId)?.sections[0].slots[1];
    assert(!!catalogSlot, '目录里能找到这一格');
    assertEqual(catalogSlot?.kind, 'table', '目录里认得表格');
    assertEqual(catalogSlot?.columns?.length, 3, '列定义要完整带出来（少一列就是少一个能填的地方）');
    assertEqual(catalogSlot?.columns?.[1]?.unit, '℃', '列上的单位也要带出来');
    assertEqual(catalogSlot?.columns?.[2]?.dataType, undefined, '没写类型的列不要凭空补一个');
    /* 列上的数据元也要带出来：抽屉是"读回 → 改 → 写回"，少这一项就是"列还在、数据元没了"，
       而机读从此对不上 —— 且不会有任何一步报错。 */
    assertEqual(catalogSlot?.columns?.[1]?.tags?.length, 1, '列上绑的数据元要原样带进目录');
    assertEqual(catalogSlot?.columns?.[1]?.tags?.[0]?.code, 'vitals.temp', '编码必须原样带出（跨文书比对按它认）');
    assertEqual(catalogSlot?.columns?.[0]?.tags, undefined, '没绑数据元的列不要凭空补一条');
    assertEqual(catalogSlot?.rows, 2, '行数要带出来');
    assert(String(catalogSlot?.detail ?? '').includes('3 列 × 2 行'), '目录那一行要让人一眼看出这是一张多大的表');

    /* ⑦ 机读：格子上的标签要真的被读出来 —— 否则"列上配了数据元"只是抽屉里好看 */
    const machine = buildMachineReadable({
      nodes: output.doc.nodes,
      rootId: output.doc.rootId,
      schemaVersion: output.doc.schemaVersion,
      generatedAt: output.doc.updatedAt,
    });
    const temps = machine.dataElements.filter((element) => element.tag.code === 'vitals.temp');
    assertEqual(temps.length, 2, '每一行的体温格子各产一条数据元（标签属于列，值属于格）');
    assertEqual(temps[0]?.unit, '℃', '机读要带上单位（否则外部系统不知道 37.2 是摄氏度还是华氏度）');

    /* ⑧ 表格没有元数据档：往它身上打元数据要明说，而不是逐项静默忽略（忽略会让调用方以为改成功了）  */
    assertEqual(
      codeOf(() => patchTemplateMeta(withTable, templateId, {
        slotMeta: [{ sectionCode: 'vitals', key: 'vitalsTable', display: '生命体征表' }],
      })),
      'E_TPL_FIELD_INVALID',
      '表格不接受"显示名"这类元数据（列定义与行数属于骨架，只有草稿能改）',
    );

    /* ⑧ 形状写错当场被拒：这几处界面上都看得见，但后果都在别处  */
    const badTable = (slot: Record<string, unknown>): string => codeOf(() => addTemplate(null, {
      name: '坏表格',
      docType: { system: 'local', code: 'bad', display: '坏表格' },
      /* 故意构造坏形状，所以这里就是要用 `as`：类型系统正确的部分由 validate 兜 */
      sections: [{ sectionCode: 's', title: 'S', slots: [slot as TemplateSlot] }],
    }));
    assertEqual(badTable({ slot: 'table', key: 't1', columns: [] }), 'E_TPL_PACK_INVALID', '没有列的表要拒（它产不出任何格子）');
    assertEqual(badTable({ slot: 'table', key: 't2', columns: [{ title: '  ' }] }), 'E_TPL_PACK_INVALID', '空列名要拒（界面上就是一个空白格子）');
    assertEqual(badTable({ slot: 'table', key: 't3', columns: [{ title: 'X' }], rows: 0 }), 'E_TPL_PACK_INVALID', '行数 0 要拒');
    assertEqual(badTable({ slot: 'table', key: 't4', columns: [{ title: 'X' }], rows: 30 }), 'E_TPL_PACK_INVALID', '行数超过上限要拒（窄屏与打印页上读不了）');
    assertEqual(badTable({ slot: 'table', key: 't5', columns: [{ title: 'X', unit: '' }] }), 'E_TPL_PACK_INVALID', '给了单位却是空的要拒（要么给值，要么删掉这个键）');
    assertEqual(
      badTable({ slot: 'table', key: 't7', columns: [{ title: 'X', tags: [] }] }),
      'E_TPL_PACK_INVALID',
      '列上给空标签数组要拒（不绑就删掉这个键）',
    );
    assertEqual(
      badTable({ slot: 'table', key: 't8', columns: [{ title: 'X', tags: [{ system: 'local', code: '', display: '体温' }] }] }),
      'E_TPL_PACK_INVALID',
      '列上的标签缺编码要拒（跨文书比对会把空的认成同一个数据元）',
    );
    assertEqual(
      badTable({
        slot: 'table',
        key: 't9',
        columns: [{ title: 'X' }],
        tags: [{ system: 'local', code: 'whole_table', display: '整张表' }],
      }),
      'E_TPL_PACK_INVALID',
      '表格整体不绑数据元（标签配在列上；收下它只会"配了却永远读不到"）',
    );
    assertEqual(
      badTable({ slot: 'table', key: 't6', columns: [{ title: 'X', dataType: 'expression' }] }),
      'E_TPL_PACK_INVALID',
      '派生值列要拒（公式引用不了会随行数增减的格子）',
    );
    assertEqual(
      badTable({ slot: 'table', key: 't7', columns: [{ title: 'X' }], keyContent: true }),
      'E_TPL_PACK_INVALID',
      '表格不给关键内容（没有"确认这张表"这个动作，标上就是造一份签不出去的病历）',
    );
    assertEqual(
      badTable({ slot: 'table', key: 't8', columns: Array.from({ length: 9 }, (_, index) => ({ title: `C${index}` })) }),
      'E_TPL_PACK_INVALID',
      '列数超过上限要拒',
    );
    assertEqual(
      codeOf(() => validateTemplatePack(withTable)),
      'OK',
      '好表格那一份照旧通过（上下八条拒的都是真的写错了）',
    );
  });

  await test('K17 专科控件槽位：五种形状都能落地、格键只有一处算得出来、写不对当场被拒', () => {
    const controlDefs = [
      {
        itemType: 'control',
        itemId: 'ctrl.scale',
        name: '疼痛数字量表',
        controlKind: 'scaleScore',
        shape: 'scale',
        enabled: true,
        version: 2,
        fields: [
          { key: 'score', label: '疼痛评分', dataType: 'number', unit: '分', tag: { system: 'local', code: 'painScore', display: '疼痛评分' } },
          { key: 'note', label: '备注', dataType: 'text' },
        ],
        layout: { columns: 2, maxPoints: 10 },
      },
      {
        itemType: 'control',
        itemId: 'ctrl.series',
        name: '体温趋势',
        controlKind: 'vitalSignsChart',
        shape: 'series',
        enabled: true,
        fields: [
          { key: 'measuredAt', label: '时间', dataType: 'date', axis: 'time' },
          { key: 'temper', label: '体温', dataType: 'number', unit: '℃', tag: { system: 'local', code: 'temper', display: '体温' } },
        ],
      },
      {
        itemType: 'control',
        itemId: 'ctrl.matrix',
        name: '牙位图',
        controlKind: 'odontogram',
        shape: 'matrix',
        enabled: true,
        rows: [{ key: 'r11', label: '11' }, { key: 'r12', label: '12' }],
        columns: [{ key: 'caries', label: '龋' }, { key: 'filled', label: '充填' }],
        fields: [{ key: 'mark', label: '标记', dataType: 'boolean' }],
      },
      {
        itemType: 'control',
        itemId: 'ctrl.checklist',
        name: '知情同意',
        controlKind: 'custom',
        shape: 'checklist',
        enabled: true,
        fields: [
          { key: 'read', label: '已告知风险', dataType: 'boolean', required: true },
          { key: 'signed', label: '已签字', dataType: 'boolean', defaultValue: true },
        ],
      },
      {
        itemType: 'control',
        itemId: 'ctrl.image',
        name: '影像',
        controlKind: 'custom',
        shape: 'image',
        enabled: true,
        fields: [
          { key: 'cxr', label: '胸片正位', dataType: 'text', tag: { system: 'local', code: 'cxrRef', display: '胸片正位' } },
          { key: 'ct', label: '胸部 CT', dataType: 'text' },
        ],
      },
    ];
    const pack: TemplatePack = {
      packId: 'doc.template.controltest',
      kind: 'template',
      name: '控件测试包',
      engineApi: 'doc-template/1',
      items: [
        ...controlDefs,
        {
          itemType: 'template',
          itemId: 't.control',
          name: '带控件的文书',
          docType: { system: 'local', code: 'ctl', display: '带控件的文书' },
          sections: [{
            sectionCode: 'ctls',
            title: '专科控件',
            slots: [
              { slot: 'control', key: 'pain', useControl: 'ctrl.scale' },
              { slot: 'control', key: 'temper', useControl: 'ctrl.series', rows: 2 },
              { slot: 'control', key: 'teeth', useControl: 'ctrl.matrix' },
              { slot: 'control', key: 'consent', useControl: 'ctrl.checklist', keyContent: true },
              { slot: 'control', key: 'films', useControl: 'ctrl.image' },
            ],
          }],
        },
      ],
    } as unknown as TemplatePack;

    assertEqual(codeOf(() => validateTemplatePack(pack)), 'OK', '好的一份包要通过装载校验（控件槽是新增的一类，装不进去就什么都别谈）');
    const output = instantiateTemplate(pack, inputOf('t.control'));
    assertEqual(
      errorsOf(validateDocument(output.doc)),
      [],
      '产出的文档必须通过 validateDocument：控件是新增的一类节点，最容易出的问题是"模板存得进去、产出的病历校验不过"',
    );

    const scale = nodeAt(output, 'pain');
    assertEqual(scale.type, 'control', '控件是独立的一类节点');
    assertEqual(scale.shape, 'scale', '形状要随节点走（渲染器按它分派）');
    assertEqual(scale.definitionId, 'ctrl.scale', '写清按哪份定义开的');
    assertEqual(scale.payloadVersion, 2, '写清按定义的**哪一版**开的（定义改过语义之后靠它解释"为什么后来多了一格"）');
    assertEqual((scale.fields as unknown[]).length, 2, '字段快照要带上：界面上的名字、单位、取值域都从它来');
    assertEqual((scale.layout as { maxPoints?: number }).maxPoints, 10, '量表排布要带上');
    assertEqual(
      ((scale.fields as Array<Record<string, unknown>>)[0].referenceRange),
      undefined,
      '没声明的东西不要凭空补',
    );

    const series = nodeAt(output, 'temper');
    assertEqual(series.rowCount, 2, '行数由**模板**给（同一个体温单门诊两条、住院一页）');
    assertEqual(
      (series.fields as Array<{ key: string; axis?: string }>).find((field) => field.key === 'measuredAt')?.axis,
      'time',
      '时间轴那一格要标出来（趋势按它排，渲染时不回查包）',
    );
    const matrix = nodeAt(output, 'teeth');
    assertEqual((matrix.rows as unknown[]).length, 2, '矩阵的行来自控件定义');
    assertEqual((matrix.columns as unknown[]).length, 2, '矩阵的列来自控件定义');
    assertEqual(matrix.rowCount, undefined, '矩阵不吃模板给的行数（32 颗牙不该由这份文书改）');

    /* 影像：与量表共用"字段即格"这一条键规则 —— 差别只在渲染器把它画成图还是画成输入框。
       断言格键正是要守住这一点：一旦有人给影像另立一套键，写进去的地址就会在导出里不见。 */
    const films = nodeAt(output, 'films');
    assertEqual(films.shape, 'image', '影像形状随节点走（渲染器拿不到包，画法只能靠节点上这一项）');
    assertEqual(
      controlCellsOf(films as unknown as Parameters<typeof controlCellsOf>[0]).map((cell) => cell.key),
      ['cxr', 'ct'],
      '影像的格键就是字段 key（与量表 / 勾选清单同一条规则）',
    );
    assertEqual(
      (films.fields as Array<{ dataType?: string }>).map((field) => field.dataType),
      ['text', 'text'],
      '影像格的值是**资源地址**：字段类型只能是 text',
    );

    const consentPayload = nodeAt(output, 'consent').payload as Record<string, unknown>;
    assertEqual(consentPayload.signed, true, '定义给了默认值的格要填上');
    assertEqual(consentPayload.read, undefined, '没给默认值的格不写键（"空着"与"填了个空"是两件事）');

    const registry = createEmptyPackRegistry();
    registry.load(pack, { validate: (candidate) => validateTemplatePack(candidate as TemplatePack) });
    const catalogSlots = templateCatalogOf(registry).find((entry) => entry.itemId === 't.control')?.sections[0].slots ?? [];
    const painSlot = catalogSlots.find((slot) => slot.key === 'pain');
    assertEqual(painSlot?.kind, 'control', '目录里认得控件槽');
    assertEqual(painSlot?.useControl, 'ctrl.scale', '引用哪份控件要回显得出来');
    assert(String(painSlot?.detail ?? '').includes('疼痛数字量表'), '目录那一行要说清用的是哪份控件');
    assertEqual(catalogSlots.find((slot) => slot.key === 'temper')?.rows, 2, '行数要带出来（少回显一项 = 一保存就把行数改回去）');

    const session = WriteSession.open(output.doc);
    const human = { kind: 'human', id: 'DR_TEST', name: '测试医生' } as const;
    const seriesId = String(output.result.slots.temper);
    const payloadOf = (): Record<string, unknown> =>
      (session.document.nodes[seriesId] as unknown as { payload: Record<string, unknown> }).payload;

    session.setControlValue({ nodeId: seriesId, fieldKey: 'temper.r2', value: 38.5 }, human);
    assertEqual(payloadOf()['temper.r2'], 38.5, '写在"第 2 条体温"那一格上');
    assertEqual(
      codeOf(() => session.setControlValue({ nodeId: seriesId, fieldKey: 'temper.r9', value: 37 }, human)),
      'E_CELL_UNKNOWN',
      '第 9 条不存在（模板只给了 2 行）→ 当场拒：拼错的键写进去不会报错，只会让值在导出里凭空不见',
    );
    assertEqual(
      codeOf(() => session.setControlValue({ nodeId: seriesId, fieldKey: 'temper.r1', value: '36.8' }, human)),
      'E_CONTROL_VALUE_INVALID',
      '数值格塞字符串要拒（payload 是机器真值："36.8" 与 36.8 在机器读的时候不是一回事）',
    );
    session.setControlValue({ nodeId: seriesId, fieldKey: 'temper.r2', value: '' }, human);
    assertEqual('temper.r2' in payloadOf(), false, '清空 = **删掉这个键**（不是写 null）');

    /* 影像格写进去的是一条地址（一个字符串），它没有"数值"这个概念 ——
       但"清空 = 删键"这条纪律与其余形状完全一样。  */
    const filmsId = String(output.result.slots.films);
    const filmPayloadOf = (): Record<string, unknown> =>
      (session.document.nodes[filmsId] as unknown as { payload: Record<string, unknown> }).payload;
    session.setControlValue({ nodeId: filmsId, fieldKey: 'cxr', value: 'https://pacs.local/film/1024' }, human);
    assertEqual(filmPayloadOf().cxr, 'https://pacs.local/film/1024', '写在「胸片正位」那一格上');
    session.setControlValue({ nodeId: filmsId, fieldKey: 'cxr', value: '' }, human);
    assertEqual('cxr' in filmPayloadOf(), false, '清空地址 = 删键（不是写 null）');

    /* ⑤ 机读：带 tag 的格摊成数据元，没填的格不产
       （"还没填"与"查过、结果为空"混起来，外部系统就再也分不清） */
    const machineOf = () => buildMachineReadable({
      nodes: session.document.nodes,
      rootId: session.document.rootId,
      schemaVersion: output.doc.schemaVersion,
      generatedAt: AT,
    });
    assertEqual(
      machineOf().dataElements.filter((element) => element.tag.code === 'temper').length,
      0,
      '整列都空着时不该产数据元',
    );
    session.setControlValue({ nodeId: seriesId, fieldKey: 'temper.r1', value: 36.5 }, human);
    const temperElements = machineOf().dataElements.filter((element) => element.tag.code === 'temper');
    assertEqual(temperElements.length, 1, '填了一格就产一条');
    assertEqual(temperElements[0].value, 36.5, '值是**那一格**的值');
    assertEqual(temperElements[0].unit, '℃', '单位取那一格声明的单位');

    /* 带 tag 的影像格同样摊成数据元：机读不看图，看的是"这张片在不在、去哪儿取它"。 */
    session.setControlValue({ nodeId: filmsId, fieldKey: 'cxr', value: 'https://pacs.local/film/2' }, human);
    assertEqual(
      machineOf().dataElements.filter((element) => element.tag.code === 'cxrRef').map((element) => element.value),
      ['https://pacs.local/film/2'],
      '影像格的地址就是它的数据元值（没填的格不产数据元：与其余形状同一条纪律）',
    );

    /* 纸面：影像格读成 `[影像：地址]`，而不是让一长串 URL 直接当正文 ——
       归档件里第一个要回答的是"这里本来有什么"，地址只是"去哪儿把它找回来"。 */
    const paperTexts = renderLines(session.document).map((line) => line.text);
    assert(
      paperTexts.some((text) => text === '胸片正位：[影像：https://pacs.local/film/2]'),
      `影像格在纸面上要带 [影像：…] 前缀（实际行：${paperTexts.join(' ⏎ ')}）`,
    );

    /* ⑥ 引用一个包里没有的控件：装载期就拒，而不是等到有人点开这份文书  */
    const orphan: TemplatePack = {
      packId: 'doc.template.orphan',
      kind: 'template',
      name: '孤儿包',
      engineApi: 'doc-template/1',
      items: [{
        itemType: 'template',
        itemId: 't.orphan',
        name: '引用不存在的控件',
        docType: { system: 'local', code: 'orphan', display: '孤儿' },
        sections: [{ sectionCode: 's', title: 'S', slots: [{ slot: 'control', key: 'c', useControl: 'ctrl.nope' }] }],
      }],
    } as unknown as TemplatePack;
    assertEqual(
      codeOf(() => validateTemplatePack(orphan)),
      'E_TPL_PACK_INVALID',
      '引用包里没有的控件要拒（跨包引用会让"这份文书依赖哪几个包同时在线"变成隐式条件）',
    );

    /* ⑦ 控件槽不绑数据元：机器读的是控件里带 tag 的字段，整体绑一个只会造出值为空的数据元 */
    const badSlot = (slot: Record<string, unknown>): string => codeOf(() => validateTemplatePack({
      ...pack,
      items: [
        ...controlDefs,
        {
          itemType: 'template',
          itemId: 't.bad',
          name: '坏控件槽',
          docType: { system: 'local', code: 'bad', display: '坏' },
          sections: [{ sectionCode: 's', title: 'S', slots: [slot] }],
        },
      ],
    } as unknown as TemplatePack));
    assertEqual(badSlot({ slot: 'control', key: 'c1', useControl: '' }), 'E_TPL_PACK_INVALID', '没指明用哪个控件要拒');
    assertEqual(badSlot({ slot: 'control', key: 'c2', useControl: 'ctrl.scale', rows: 0 }), 'E_TPL_PACK_INVALID', '行数 0 要拒');
    assertEqual(
      badSlot({ slot: 'control', key: 'c3', useControl: 'ctrl.scale', tags: [{ system: 'local', code: 'x' }] }),
      'E_TPL_PACK_INVALID',
      '控件槽绑数据元要拒（要绑就绑到控件里的字段上）',
    );

    /* ⑧ 影像格只能是 text：配成数值 / 日期 / 布尔时，写路径会当场拒（`matchesControlCellType`），
       而医生看到的只是"这一格填不进去" —— 症状与原因隔着整条渲染链，所以必须在装包那一刻拦下。 */
    const imageFieldsOf = (fields: Array<Record<string, unknown>>): string => codeOf(() => validateTemplatePack({
      ...pack,
      items: (pack.items as unknown as Array<Record<string, unknown>>).map((item) => (
        item.itemId === 'ctrl.image' ? { ...item, fields } : item
      )),
    } as unknown as TemplatePack));
    assertEqual(
      imageFieldsOf([{ key: 'cxr', label: '胸片正位', dataType: 'number' }]),
      'E_TPL_PACK_INVALID',
      '影像格配成数值格要拒（地址写不进数值格）',
    );
    assertEqual(
      imageFieldsOf([{ key: 'cxr', label: '胸片正位', dataType: 'text' }]),
      'OK',
      '影像格是 text 才通过（这是它唯一说得通的类型）',
    );
  });

  await test('K18 空段落与图片槽：段落产出空 text、图片产出待贴空槽（空 resRef 也过校验）、纸面写「待贴图」', () => {
    /* 这两类槽位产出的是已有的节点类型（text / image），考验的不是"新节点"，
       而是"它们在最空的状态下仍然合法"：空段落 runs 为空、图片槽 resRef 为空。
       后者尤其容易被旧校验（"resRef 必须是非空字符串"）拦下，而表现是
       "模板存得进去、开文书时校验不过"。  */
    const pack: TemplatePack = {
      packId: 'doc.template.blanktest',
      kind: 'template',
      name: '空段落与图片槽',
      engineApi: 'doc-template/1',
      items: [
        {
          itemType: 'template',
          itemId: 't.blank',
          name: '空段落与图片',
          docType: { system: 'local', code: 'blank', display: '空段落与图片' },
          sections: [{
            sectionCode: 'blank',
            title: '留白',
            slots: [
              { slot: 'paragraph', key: 'free' },
              { slot: 'paragraph', key: 'keyNote', keyContent: true },
              { slot: 'image', key: 'cxr', altText: '胸部 CT 正位', caption: '图1 {{patient.nameMasked}} 术前' },
              { slot: 'text', key: 'after', text: '以上由本人确认。' },
            ],
          }],
        },
      ],
    } as unknown as TemplatePack;

    assertEqual(codeOf(() => validateTemplatePack(pack)), 'OK', '空段落与图片槽要能装进包');
    const output = instantiateTemplate(pack, inputOf('t.blank'));
    assertEqual(
      errorsOf(validateDocument(output.doc)),
      [],
      '产出的文档必须过校验：图片槽的 resRef 是空串，而旧校验要求"非空字符串"——这条不改，图片槽根本开不出来',
    );

    assertEqual(nodeAt(output, 'free').type, 'text', '空段落产出 text 节点，不是另一种新节点');
    assertEqual(textAt(output, 'free'), '', '空段落没有文字');
    assertEqual(nodeAt(output, 'keyNote').keyContent, true, '空段落可以标关键内容（医生端有确认动作，标了才可达）');

    const cxr = nodeAt(output, 'cxr');
    assertEqual(cxr.type, 'image', '图片槽产出 image 节点');
    assertEqual(cxr.resRef, '', '图片槽开出来是**空地址**：意思是"待贴"，不是"填过了"');
    assertEqual(cxr.altText, '胸部 CT 正位', '说明要进节点：空槽上得有一行字告诉医生这格该放什么');
    assertEqual(cxr.caption, '图1 王** 术前', '图注支持上下文替换');

    /* 段落归属：图是块级，必须自成一段 —— 否则"删这一段"会把图和上面那句话一起搬走 */
    const cxrId = String(cxr.id);
    const cxrParent = output.doc.nodes[cxrId as NodeId]?.parentId;
    assertEqual(output.doc.nodes[cxrParent as NodeId]?.type, 'paragraph', '图挂在段落下面（与医生端贴图的挂法一致）');

    const paper = renderLines(output.doc).map((line) => line.text);
    assert(
      paper.some((text) => text === '[待贴图：胸部 CT 正位]'),
      `空槽在纸面上要写成「[待贴图：…]」（实际：${paper.join(' ⏎ ')}）`,
    );
    assert(
      !paper.some((text) => text.includes('图片缺失')),
      '空槽不是"图丢了"：写成「图片缺失」会让审计去追一起根本没发生过的资源事故',
    );

    const session = WriteSession.open(output.doc);
    const human = { kind: 'human', id: 'DR_TEST', name: '测试医生' } as const;
    session.setImageRef({ nodeId: cxrId as NodeId, resRef: '/res/a1b2.png', altText: '医生起的名字' }, human);
    const filled = session.document.nodes[cxrId as NodeId] as unknown as { resRef: string; altText?: string };
    assertEqual(filled.resRef, '/res/a1b2.png', '空槽贴上了地址');
    assertEqual(
      filled.altText,
      '胸部 CT 正位',
      '贴图**不覆盖**原有的说明：换一张图不该把"这一格是什么"一起改掉',
    );

    let rejected = '';
    try {
      session.setImageRef({ nodeId: cxrId as NodeId, resRef: '   ' }, human);
    } catch (error) {
      rejected = String((error as { code?: string }).code ?? '');
    }
    assertEqual(
      rejected,
      'E_IMAGE_REF_INVALID',
      '空地址要拒：空 resRef 的意思是"还没贴"，清图请删节点（两者混在一起，事后分不清"一直空着"还是"被删了"）',
    );

    /* ⑤ 目录投影：编辑抽屉与模板预览都读它。少认一个类别，症状就是
       "包里明明有、界面上那一格空白"，而没有任何一步会报错。 */
    const registry = createEmptyPackRegistry();
    registry.load(pack, { validate: (candidate) => validateTemplatePack(candidate as TemplatePack) });
    const catalogSlots = templateCatalogOf(registry).find((item) => item.itemId === 't.blank')?.sections[0].slots ?? [];
    assertEqual(
      catalogSlots.map((slot) => slot.kind).join(','),
      'paragraph,paragraph,image,text',
      '四种槽位都要按类别列出来（漏掉新类别时，界面上那一格是空白）',
    );
    assertEqual(
      catalogSlots[0]?.detail,
      '空段落（留白，由医生写）',
      '空段落要说明"留白是有意的"（写成"文本（结构提示）"会让人以为漏填了）',
    );
    assertEqual(catalogSlots[2]?.altText, '胸部 CT 正位', '图片说明要原样带出来（抽屉要回显、回写）');
    assertEqual(
      catalogSlots[2]?.caption,
      '图1 {{patient.nameMasked}} 术前',
      '图注要原样带出来（模板里的写法，不是替换后的值）',
    );
    assertEqual(catalogSlots[2]?.resRef, undefined, '空地址不写进目录（缺省 = 待贴图）');
    assert(
      String(catalogSlots[2]?.detail ?? '').includes('待贴图'),
      '目录那一行要写"待贴图"，不是"图片缺失"',
    );
    assertEqual(
      catalogSlots[2]?.keyContent,
      undefined,
      '图片不出关键内容（医生端没有"确认这一张图"这个动作）',
    );

    /* ⑥ 槽位元数据补丁：图片与空段落那几条否定规则要在改的那一刻就说清楚 ——
       留到医生端才发现，等于一份签不出去、也不知道去哪儿确认的病历。  */
    const badMeta = (slotMeta: unknown[]): string =>
      codeOf(() => patchTemplateMeta(pack, 't.blank', { slotMeta: slotMeta as never }));
    assertEqual(
      badMeta([{ sectionCode: 'blank', key: 'cxr', keyContent: true }]),
      'E_TPL_FIELD_INVALID',
      '图片不能标关键内容（医生端没有"确认这一张图"）',
    );
    assertEqual(badMeta([{ sectionCode: 'blank', key: 'cxr', unit: 'mm' }]), 'E_TPL_FIELD_INVALID', '图片没有单位');
    assertEqual(
      badMeta([{ sectionCode: 'blank', key: 'cxr', display: '胸片' }]),
      'E_TPL_FIELD_INVALID',
      '图片不绑数据元（机器读的是填写项）',
    );
    assertEqual(badMeta([{ sectionCode: 'blank', key: 'free', unit: 'cm' }]), 'E_TPL_FIELD_INVALID', '空段落没有单位');
    assertEqual(
      badMeta([{ sectionCode: 'blank', key: 'free', newParagraph: true }]),
      'E_TPL_FIELD_INVALID',
      '空段落本来就另起一段（这一项对它没有意义）',
    );
    /* 但空段落可以标关键内容：它产出文本节点，医生端有「确认内容」这个动作  */
    const withKey = patchTemplateMeta(pack, 't.blank', {
      slotMeta: [{ sectionCode: 'blank', key: 'free', keyContent: true }],
    });
    const patchedSlot = (withKey.items.find((item) => item.itemId === 't.blank') as unknown as {
      sections: Array<{ slots: Array<Record<string, unknown>> }>;
    }).sections[0].slots[0];
    assertEqual(patchedSlot.keyContent, true, '空段落能标关键内容（有确认动作，标了才可达）');
  });

  await test('K19 列表槽位：产出 listGroup → listItem → text、目录带项与有序性、空项与非法元数据当场被拒', () => {
    /* 列表与表格同一族（块级、不产数据元、不标关键内容），差别在"它有一个组"：
       项不是段落 —— 段落级操作会以"段"为单位搬东西，那样删掉一项就把列表拆散了。 */
    const pack: TemplatePack = {
      packId: 'doc.template.listtest',
      kind: 'template',
      name: '列表',
      engineApi: 'doc-template/1',
      items: [
        {
          itemType: 'template',
          itemId: 't.list',
          name: '列表',
          docType: { system: 'local', code: 'list', display: '列表' },
          sections: [{
            sectionCode: 'hpi',
            title: '现病史',
            slots: [
              {
                slot: 'list',
                key: 'allergy',
                ordered: true,
                items: [
                  { text: '否认药物过敏史' },
                  { text: '否认食物过敏史 {{patient.nameMasked}}' },
                ],
              },
              { slot: 'list', key: 'habits', items: [{ text: '不吸烟' }, { text: '偶饮酒' }] },
              /* 带格子的项（"体温 ____ ℃"）：格子才是数据元的来源，列表本身不产 */
              {
                slot: 'list',
                key: 'vitals',
                items: [{
                  text: '体温',
                  field: {
                    dataType: 'number',
                    unit: '℃',
                    tags: [{ system: 'local', code: 'list.temp', display: '体温' }],
                  },
                }],
              },
              { slot: 'paragraph', key: 'tail' },
            ],
          }],
        },
      ],
    } as unknown as TemplatePack;

    assertEqual(codeOf(() => validateTemplatePack(pack)), 'OK', '列表槽要能装进包');
    const output = instantiateTemplate(pack, inputOf('t.list'));
    assertEqual(errorsOf(validateDocument(output.doc)), [], '列表产出的文档必须过校验');

    const group = nodeAt(output, 'allergy');
    assertEqual(group.type, 'listGroup', '列表槽位产出一个 listGroup（不是一堆散落的段落）');
    assertEqual(group.ordered, true, '有序性要抄进节点（纸面与屏幕都按它编号）');
    assertEqual(nodeAt(output, 'habits').ordered, undefined, '无序列表不写 `ordered`（`false` 只会多一份指纹差异）');

    const kidsOf = (parentId: unknown): Array<Record<string, unknown>> =>
      Object.values(output.doc.nodes).filter((node) => node.parentId === parentId) as unknown as Array<Record<string, unknown>>;
    const items = kidsOf(group.id);
    assertEqual(items.length, 2, '两项就是两个 listItem');
    assertEqual(items.every((node) => node.type === 'listItem'), true, '组里挂的是 listItem');
    const itemTexts = items.map((item) => {
      const text = kidsOf(item.id)[0] as { runs?: Array<{ text: string }> };
      return (text.runs ?? []).map((run) => run.text).join('');
    });
    assertEqual(
      itemTexts.join(' | '),
      '否认药物过敏史 | 否认食物过敏史 王**',
      '项里的文字挂在 listItem 下，上下文替换照旧生效',
    );

    /* 带格子的项：格子是 `listItem` 下的 `field` 节点，且能被槽位名定位（`key.i<项序>`） */
    const vitalField = nodeAt(output, 'vitals.i1');
    assertEqual(vitalField.type, 'field', '带格子的项要产出 field（否则"体温 ____℃"就只是一个词）');
    assertEqual(vitalField.dataType, 'number', '格子类型从模板抄进来');
    assertEqual(vitalField.unit, '℃', '单位要落进格子（"37.2 是什么"必须有答案）');
    assertEqual(vitalField.value, null, '格子空待填：模板不编值');
    assertEqual(
      JSON.stringify(vitalField.tags),
      JSON.stringify([{ system: 'local', code: 'list.temp', display: '体温' }]),
      '数据元落在**格子**上（列表本身不产数据元）',
    );
    const vitalItem = output.doc.nodes[String(vitalField.parentId)] as unknown as { type: string };
    assertEqual(vitalItem.type, 'listItem', '格子挂在列表项下面（不是段落里），项内顺序才稳定');
    const pureItem = kidsOf(nodeAt(output, 'allergy').id)[0];
    assertEqual(
      kidsOf(pureItem.id).filter((node) => node.type === 'field').length,
      0,
      '没配格子的项不产 field（空着没人填的格子一旦绑了数据元就会进机读）',
    );

    /* 机读：格子的标签要真的被读出来 */
    const machine = buildMachineReadable({
      nodes: output.doc.nodes,
      rootId: output.doc.rootId,
      schemaVersion: output.doc.schemaVersion,
      generatedAt: output.doc.updatedAt,
    });
    const listElements = machine.dataElements.filter((element) => element.tag.code === 'list.temp');
    assertEqual(listElements.length, 1, '带数据元的列表格子产一条数据元');
    assertEqual(listElements[0]?.unit, '℃', '机读要带单位');

    /* 目录投影：编辑抽屉按它回显"几项、编号还是圆点、每一项是什么" */
    const registry = createEmptyPackRegistry();
    registry.load(pack, { validate: (candidate) => validateTemplatePack(candidate as TemplatePack) });
    const view = templateCatalogOf(registry).find((item) => item.itemId === 't.list')?.sections[0].slots[0];
    assertEqual(view?.kind, 'list', '目录要认这个类别（不认识时那一格在界面上是空白）');
    assertEqual(view?.detail, '列表：2 项（编号）', '一行人话要说清几项、编号还是圆点');
    assertEqual(
      (view?.items ?? []).map((item) => item.text).join('|'),
      '否认药物过敏史|否认食物过敏史 {{patient.nameMasked}}',
      '项要**原样**带出（模板里的写法，不是替换后的值）：抽屉要回显、回写',
    );
    assertEqual(view?.ordered, true, '有序性要带出（抽屉的勾选框要回显）');
    /* 带格子的项：格子三项（类型 / 单位 / 数据元）一个都不能少 ——
       少一个，抽屉里那一项就会被画成"纯文字"，一保存格子和机读一起没了。 */
    const vitalView = templateCatalogOf(registry).find((item) => item.itemId === 't.list')?.sections[0].slots[2];
    assertEqual(vitalView?.items?.[0]?.field?.dataType, 'number', '格子类型要带进目录');
    assertEqual(vitalView?.items?.[0]?.field?.unit, '℃', '格子单位要带进目录');
    assertEqual(vitalView?.items?.[0]?.field?.tags?.[0]?.code, 'list.temp', '格子绑的数据元要带进目录（编码原样）');
    assertEqual(vitalView?.items?.[0]?.text, '体温', '格子那一项的文字也在');

    /* 否定规则：空列表 / 空项 / 数据元 / 关键内容，都要在装包那一刻说清楚  */
    const badPack = (slots: unknown[]): string => codeOf(() => validateTemplatePack({
      ...pack,
      items: [{
        ...(pack.items[0] as unknown as Record<string, unknown>),
        sections: [{ sectionCode: 'x', title: 'x', slots }],
      }],
    } as unknown as TemplatePack));
    assertEqual(badPack([{ slot: 'list', key: 'k', items: [] }]), 'E_TPL_PACK_INVALID', '空列表要拒（没有项就什么都不产出）');
    assertEqual(
      badPack([{ slot: 'list', key: 'k', items: [{ text: '有' }, { text: '  ' }] }]),
      'E_TPL_PACK_INVALID',
      '空项要拒：纸面会把空行丢掉，于是屏幕上有两项、归档件里只有一项',
    );
    assertEqual(
      badPack([{ slot: 'list', key: 'k', items: ['旧写法'] }]),
      'E_TPL_PACK_INVALID',
      '字符串项要拒：形状换了要**明说**（报"没有文字"会让人以为标点写错了）',
    );
    assertEqual(
      badPack([{ slot: 'list', key: 'k', items: [{ text: 'a' }], tags: [{ system: 'local', code: 'x' }] }]),
      'E_TPL_PACK_INVALID',
      '列表不绑数据元（机器读的是填写项）',
    );
    assertEqual(
      badPack([{ slot: 'list', key: 'k', items: [{ text: 'a' }], keyContent: true }]),
      'E_TPL_PACK_INVALID',
      '列表不支持关键内容（医生端没有"确认这一整条列表"的动作）',
    );
    assertEqual(
      badPack([{ slot: 'list', key: 'k', items: [{ text: 'a', field: { dataType: 'expression' } }] }]),
      'E_TPL_PACK_INVALID',
      '项里的格子不支持派生值（公式要引用具体格子，而行会增删）',
    );
    assertEqual(
      badPack([{ slot: 'list', key: 'k', items: [{ text: 'a', field: { dataType: 'text', tags: [] } }] }]),
      'E_TPL_PACK_INVALID',
      '格子给空标签数组要拒（不绑就删掉这个键）',
    );
  });

  process.exit(suite.report());
}

void main();
