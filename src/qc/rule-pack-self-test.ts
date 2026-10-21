import { TestSuite, assert, assertEqual } from '../testing/harness.ts';
import { buildSyntheticDoc } from '../testing/synthetic.ts';
import { WriteSession, type Actor } from '../core/session.ts';
import type { JsonValue, NodeId } from '../model/types.ts';
import { fileURLToPath } from 'node:url';
import { PackRegistry, type Pack, type SupportedEngineApis } from '../knowledge/pack.ts';
import { runFormRules, type QcContext, type QcNodeView, type QcRule } from './form-rules.ts';

/** 判定上下文：时刻写死（判定结果不该随运行时刻变化，否则复核无从谈起）  */
const CTX: QcContext = { now: '2026-10-12T00:00:00Z' };

function hitOrNull(rule: QcRule, view: QcNodeView): { detail: string; suggestion: string; quote?: string } | null {
  const result = rule.check(view, CTX);
  assert(!(result && 'uncertain' in result), `本文件不涉及"判不了"：${result && 'uncertain' in result ? result.uncertain : ''}`);
  return result as { detail: string; suggestion: string; quote?: string } | null;
}
import {
  RULE_ENGINE_API,
  SUPPORTED_RULE_ENGINE_APIS,
  compileRuleDescriptor,
  compileRulePack,
  resolveConditionLibrary,
  rulesFromRegistry,
  validateRulePack,
  type ConditionLibrary,
} from './rule-pack.ts';
import { addRule, CUSTOM_RULE_PACK_ID, patchRuleDescriptor, removeRule } from './rule-edit.ts';
import { qcPredicateCatalog, QC_PREDICATES } from './predicates.ts';
import { createEmptyPackRegistry } from '../knowledge/default-registry.ts';
import { readSamplePack, SAMPLE_PACK_FILES } from '../knowledge/sample-packs.ts';
import { validateTemplatePack } from '../template/template-pack.ts';
import type { TemplatePack } from '../template/types.ts';
import type { QcConditionDefinition, QcRuleDescriptor, QcRulePack } from './types.ts';
import { SEED_CONDITIONS } from './seed-conditions.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const FORM_PACK = readSamplePack(ROOT, SAMPLE_PACK_FILES.formRules) as QcRulePack;
const TIME_PACK = readSamplePack(ROOT, SAMPLE_PACK_FILES.timeRules) as QcRulePack;
const TEMPLATE_PACK = readSamplePack(ROOT, SAMPLE_PACK_FILES.templates) as TemplatePack;

const suite = new TestSuite('规则包自测', [
  '说明：包只提供"怎么写规则"（标题/级别/参数/建议），判定机制在封闭的谓词注册表里。',
  'R6 是防回退关键：装载与开关规则包**绝不能**改动文档字节、rev 或文档留痕。',
]);

const test = (name: string, fn: () => void | Promise<void>): Promise<void> => suite.test(name, fn);

const HUMAN: Actor = { id: 'DR_WANG', kind: 'human' };
const SYSTEM: Actor = { id: 'rule-engine', kind: 'system' };

const SUPPORTED: SupportedEngineApis = { rule: SUPPORTED_RULE_ENGINE_APIS, template: [], term: [] };

function descriptor(overrides: Partial<QcRuleDescriptor> = {}): QcRuleDescriptor {
  return {
    itemId: 'R-DEMO-01',
    title: '演示规则',
    severity: 'warn',
    predicate: { kind: 'text-missing-time' },
    ...overrides,
  };
}

function packOf(items: QcRuleDescriptor[], overrides: Partial<QcRulePack> = {}): QcRulePack {
  return {
    packId: 'qc.demo.rule',
    kind: 'rule',
    name: '演示规则包',
    engineApi: RULE_ENGINE_API,
    items,
    ...overrides,
  };
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
    return 'OK';
  } catch (err) {
    return (err as { code?: string }).code ?? `UNEXPECTED:${(err as Error).message}`;
  }
}

const nodesOf = (spec: Record<string, unknown>): Record<NodeId, never> => spec as Record<NodeId, never>;

async function main(): Promise<void> {
  await test('R1 样例包编译结果与既有默认规则逐项一致（包化不得改变判定）', () => {
    const compiled = compileRulePack(FORM_PACK);
    assertEqual(
      compiled.map((rule) => rule.id),
      ['R-FORM-01', 'R-FORM-02', 'R-FORM-03'],
      '样例包的规则号与顺序',
    );
    assertEqual(
      compiled.map((rule) => rule.title),
      ['本段缺少记录时间', '必填数据元的段落内容为空', '模板占位符未替换'],
      '标题',
    );
    assertEqual(compiled.every((rule) => rule.severity === 'warn'), true, '形式类一律 warn（不是 block）');

    /* 行为的等价：同一批节点跑出来的命中必须逐字对得上 */
    const nodes = nodesOf({
      n_1: { id: 'n_1', type: 'text', runs: [{ text: '患者三天前出现咳嗽，咳白色黏痰。' }], rev: 1, provenance: { origin: 'human', at: '2026-10-09T10:00:00Z' } },
      n_2: { id: 'n_2', type: 'text', runs: [{ text: '' }], tags: ['DE-002'], rev: 1, provenance: { origin: 'human', at: '2026-10-09T10:00:00Z' } },
      n_3: { id: 'n_3', type: 'text', runs: [{ text: '既往史：待补充。' }], rev: 1, provenance: { origin: 'human', at: '2026-10-09T10:00:00Z' } },
    });
    const result = runFormRules(nodes as never, CTX, compiled);
    assertEqual(result.hits.map((hit) => hit.ruleId), ['R-FORM-01', 'R-FORM-02', 'R-FORM-03'], '三段各命中一条，顺序稳定');
    assert(result.hits.every((hit) => hit.detail.startsWith(`规则 ${hit.ruleId}：`)), '每条依据都应由引擎注入规则号前缀');

    const placeholder = result.hits[2];
    assertEqual(placeholder?.quote, '待补充', '占位符规则的 quote 必须仍是命中片段本身（锚点重定位依赖它）');
    assert(String(placeholder?.suggestion).includes('待补充'), '建议动作里应含命中片段（可执行，而不是只说"有问题"）');
  });

  await test('R2 规则号由引擎注入：包不得自带规则号，也不得漏标题', () => {
    assertEqual(
      codeOf(() => compileRuleDescriptor('qc.demo.rule', descriptor({ detail: '规则 R-DEMO-01：记录类段落应包含记录时间。' }))),
      'E_RULE_DETAIL_INVALID',
      '包自带规则号必须拒绝 —— 否则会出现双重编号，且等于允许包自证身份',
    );

    const rule = compileRuleDescriptor(
      'qc.demo.rule',
      descriptor({ detail: '本专科要求病程记录带记录时间。', suggestion: '补记记录时间。' }),
    );
    const hit = hitOrNull(rule, { nodeId: 'n_1' as NodeId, type: 'text', text: '患者三天前出现咳嗽，咳白色黏痰。', tags: [], keyContent: false });
    assert(hit !== null, '前置：该文本应命中');
    assertEqual(hit?.detail, '规则 R-DEMO-01：本专科要求病程记录带记录时间。', '包覆盖的是"依据本身"，规则号仍由引擎补上');
    assertEqual(hit?.suggestion, '补记记录时间。', '包可覆盖建议动作');

    assertEqual(codeOf(() => compileRuleDescriptor('qc.demo.rule', descriptor({ title: '' }))), 'E_RULE_ITEM_INVALID', '标题必填');
    assertEqual(
      codeOf(() => compileRuleDescriptor('qc.demo.rule', { itemId: 'X', severity: 'warn', title: 't' })),
      'E_RULE_ITEM_INVALID',
      '缺 predicate 必须拒绝（规则必须说明"用哪个内置谓词判"）',
    );
  });

  await test('R3 未知谓词 / 未知参数名 / 非法取值 / 非法级别：全部显式拒绝，不静默跳过', () => {
    assertEqual(
      codeOf(() => compileRuleDescriptor('qc.demo.rule', descriptor({ predicate: { kind: 'write-document' } as never }))),
      'E_RULE_PREDICATE_UNKNOWN',
      '未知谓词必须拒绝 —— 包只能组合既有谓词，不能带来新判定逻辑',
    );
    assertEqual(
      codeOf(() => compileRuleDescriptor('qc.demo.rule', descriptor({ predicate: { kind: 'text-missing-time', params: { minLenght: 10 } } }))),
      'E_RULE_PARAM_INVALID',
      '参数名拼错必须拒绝，否则"我配的阈值没生效"永远查不出来',
    );
    for (const bad of [0, -1, 1.5, '10', true]) {
      assertEqual(
        codeOf(() => compileRuleDescriptor('qc.demo.rule', descriptor({ predicate: { kind: 'text-missing-time', params: { minLength: bad } } }))),
        'E_RULE_PARAM_INVALID',
        `minLength=${String(bad)} 应判非法`,
      );
    }
    for (const bad of [[1, 2], ['']]) {
      assertEqual(
        codeOf(() => compileRuleDescriptor('qc.demo.rule', descriptor({ predicate: { kind: 'placeholder-residue', params: { extraWords: bad } } }))),
        'E_RULE_PARAM_INVALID',
        `extraWords=${JSON.stringify(bad)} 应判非法（空串会让规则对任何文本都命中）`,
      );
    }
    assertEqual(
      codeOf(() => compileRuleDescriptor('qc.demo.rule', descriptor({ predicate: { kind: 'tagged-empty-text', params: { anything: 1 } } }))),
      'E_RULE_PARAM_INVALID',
      '不接受参数的谓词带上参数也应拒绝',
    );
    assertEqual(codeOf(() => compileRuleDescriptor('qc.demo.rule', descriptor({ severity: 'fatal' as never }))), 'E_RULE_SEVERITY_INVALID', '非法级别');
  });

  await test('R4 开关生效：关掉的规则不参与扫描，开回即恢复', () => {
    const registry = new PackRegistry(SUPPORTED);
    registry.load(packOf([descriptor({ itemId: 'R-DEMO-01' }), descriptor({ itemId: 'R-DEMO-02', predicate: { kind: 'placeholder-residue' } })]), {
      validate: (pack) => validateRulePack(pack as QcRulePack),
    });
    assertEqual(rulesFromRegistry(registry).length, 2, '默认全部启用');

    registry.setItemEnabled('qc.demo.rule', 'R-DEMO-02', false);
    const active = rulesFromRegistry(registry);
    assertEqual(active.map((rule) => rule.id), ['R-DEMO-01'], '未启用的规则不得进入可运行集合');

    const nodes = nodesOf({
      n_1: { id: 'n_1', type: 'text', runs: [{ text: '患者三天前出现咳嗽，咳白色黏痰。' }], rev: 1, provenance: { origin: 'human', at: '2026-10-09T10:00:00Z' } },
      n_2: { id: 'n_2', type: 'text', runs: [{ text: '既往史：待补充。' }], rev: 1, provenance: { origin: 'human', at: '2026-10-09T10:00:00Z' } },
    });
    assertEqual(runFormRules(nodes as never, CTX, active).hits.map((hit) => hit.ruleId), ['R-DEMO-01'], '被关掉的占位符规则不应命中');

    registry.setItemEnabled('qc.demo.rule', 'R-DEMO-02', true);
    assertEqual(rulesFromRegistry(registry).length, 2, '开回应恢复');
  });

  await test('R5 参数可调：阈值由包提供，并真的改变判定范围', () => {
    const nodes = nodesOf({
      n_1: { id: 'n_1', type: 'text', runs: [{ text: '患者咳嗽咳痰。' }], rev: 1, provenance: { origin: 'human', at: '2026-10-09T10:00:00Z' } },
    });
    const shortText = '患者咳嗽咳痰。'; // 7 字，短于默认阈值 10

    const byDefault = compileRuleDescriptor('qc.demo.rule', descriptor());
    assertEqual(byDefault.check({ nodeId: 'n_1' as NodeId, type: 'text', text: shortText, tags: [], keyContent: false }, CTX), null, '默认阈值下短文本不报');

    const strict = compileRuleDescriptor('qc.demo.rule', descriptor({ predicate: { kind: 'text-missing-time', params: { minLength: 3 } } }));
    assert(strict.check({ nodeId: 'n_1' as NodeId, type: 'text', text: shortText, tags: [], keyContent: false }, CTX) !== null, '阈值调小后应命中');

    assertEqual(runFormRules(nodes as never, CTX, [byDefault]).hits.length, 0, '引擎侧同样不报');
  });

  await test('R6 包不进文档、不进签名：装载与开关前后，文档字节 / rev / 文档留痕一律不变', () => {
    const { doc, ids } = buildSyntheticDoc({ sections: 2, paragraphsPerSection: 2, fieldsPerParagraph: 1 });
    const session = WriteSession.open(doc);
    const textId = ids.textIds[0] as NodeId;
    session.insertText({ nodeId: textId, text: '患者无明显诱因出现咳嗽，咳白色黏痰，伴发热。' }, HUMAN);

    const nodesBefore = JSON.stringify(session.document.nodes);
    const revBefore = session.docRev;
    const logBefore = session.auditLog().length;

    const registry = new PackRegistry(SUPPORTED);
    registry.load(FORM_PACK, { validate: (pack) => validateRulePack(pack as QcRulePack) });
    registry.setItemEnabled(FORM_PACK.packId, 'R-FORM-02', false);
    registry.setItemEnabled(FORM_PACK.packId, 'R-FORM-02', true);
    registry.load(packOf([descriptor({ itemId: 'R-EXTRA-01', predicate: { kind: 'placeholder-residue' } })], { packId: 'qc.demo.extra' }));

    assertEqual(JSON.stringify(session.document.nodes), nodesBefore, '装载与开关规则包**不得**改动文档节点');
    assertEqual(session.docRev, revBefore, '不得改 rev —— 否则"rev 变化 ⇒ 文档变了"这个前提会失效');
    assertEqual(session.auditLog().length, logBefore, '不得写进文档留痕（包是部署参数，不是文档内容）');
    assertEqual(
      JSON.stringify(session.document).includes(FORM_PACK.packId),
      false,
      '包标识不得出现在文档序列化结果里（否则它会被带进签名与机读信息）',
    );

    const rules = rulesFromRegistry(registry);
    const scan = runFormRules(session.document.nodes, CTX, rules);
    assert(scan.hits.length > 0, '前置：该内容应被规则命中');
    for (const hit of scan.hits) {
      session.annotate(
        {
          nodeId: hit.nodeId,
          kind: 'form',
          severity: hit.severity,
          title: hit.title,
          detail: hit.detail,
          suggestion: hit.suggestion,
          ...(hit.quote ? { quote: hit.quote } : {}),
          source: { kind: 'system', ruleId: hit.ruleId },
          dedupeKey: `${hit.ruleId}:${hit.nodeId}`,
        },
        SYSTEM,
      );
    }
    assertEqual(session.listAnnotations().length > 0, true, '命中的载体是**旁挂注解**（质控意见不是文档内容）');
    assertEqual(session.docRev, revBefore, '挂注解后 rev 仍不得变');
    assertEqual(session.auditLog().length, logBefore, '挂注解不写文档留痕');

    const stored = registry.get('qc.demo.extra') as Pack;
    assertEqual(stored.items[0]?.itemId, 'R-EXTRA-01', '注册表内容正确');
  });

  await test('R7 装载期校验：参数写错的包在装载那一刻就报错，且一个字都不入库', () => {
    const registry = new PackRegistry(SUPPORTED);
    const bad = packOf([descriptor({ predicate: { kind: 'text-missing-time', params: { minLength: 0 } } })], { packId: 'qc.bad' });
    assertEqual(
      codeOf(() => registry.load(bad, { validate: (pack) => validateRulePack(pack as QcRulePack) })),
      'E_RULE_PARAM_INVALID',
      '装包那一刻就报错，而不是等医生点了"跑质控"才发现少了一条',
    );
    assertEqual(registry.list().length, 0, '校验失败不得留下半个包');

    registry.load(packOf([descriptor()]), { validate: (pack) => validateRulePack(pack as QcRulePack) });
    assertEqual(registry.list().map((item) => item.packId), ['qc.demo.rule'], '同一个注册表里合法包照常装入');
  });

  await test('R8 装配：空注册表就是"没有包"；显式载入样例包后才跑规则，且指纹可复现', () => {
    const empty = createEmptyPackRegistry();
    assertEqual(empty.list().length, 0, '空装配：没有任何包');
    assertEqual(rulesFromRegistry(empty).length, 0, '没有包 → 没有任何规则在跑（界面据此显示"质控当前不可用"）');

    const withSamples = (registry: PackRegistry): PackRegistry => {
      registry.load(FORM_PACK, { validate: (pack) => validateRulePack(pack as QcRulePack) });
      registry.load(TIME_PACK, { validate: (pack) => validateRulePack(pack as QcRulePack) });
      registry.load(TEMPLATE_PACK, { validate: (pack) => validateTemplatePack(pack as TemplatePack) });
      return registry;
    };
    const first = withSamples(createEmptyPackRegistry());
    const second = withSamples(createEmptyPackRegistry());
    const rulePacks = first.list('rule');
    assertEqual(
      rulePacks.map((pack) => pack.packId),
      [FORM_PACK.packId, TIME_PACK.packId],
      '装进来的是：形式类规则包 + 时限类规则包',
    );
    assertEqual(rulePacks[0]?.enabledItemCount, 3, '形式类三条默认全启用');
    assertEqual(rulePacks[1]?.enabledItemCount, 4, '时限类四条默认全启用（含两条跨文书）');
    assertEqual(first.list('template').length, 1, '另装一个模板包（K4）：两类包互不干扰');
    assertEqual(first.contentFingerprint(), second.contentFingerprint(), '两次装配应得到同一内容指纹（可复现）');
    assertEqual(first.effectiveFingerprint(), second.effectiveFingerprint(), '生效指纹同样可复现');
    assertEqual(rulesFromRegistry(first).length, 7, '七条规则可用（形式类 3 + 时限类 4）');
    assertEqual(rulePacks[1]?.engineApi, rulePacks[0]?.engineApi, '两族规则用的是同一个引擎契约（包格式没变）');
  });

  await test('R9 条目级编辑：改的是包内容（原包不动、改回原样能回到原内容），机制与级别边界都不放开', () => {
    const pack = packOf([descriptor({ itemId: 'R-DEMO-01' })]);
    const before = JSON.stringify(pack);

    const patched = patchRuleDescriptor(pack, 'R-DEMO-01', {
      title: '本段缺少记录时间（专科版）',
      predicate: { kind: 'text-missing-time', params: { minLength: 3 } },
    });
    assertEqual(JSON.stringify(pack), before, '原包不得被就地改动');
    const item = patched.items[0] as QcRuleDescriptor;
    assertEqual(item.title, '本段缺少记录时间（专科版）', '标题应改掉');
    assertEqual(
      JSON.stringify(item.predicate),
      JSON.stringify({ kind: 'text-missing-time', params: { minLength: 3 } }),
      '判定方式与参数一起换（换谓词时参数必须整套换）',
    );

    const restored = patchRuleDescriptor(patched, 'R-DEMO-01', {
      title: '演示规则',
      predicate: { kind: 'text-missing-time' },
    });
    assertEqual(JSON.stringify(restored), JSON.stringify(pack), '改回原样应回到原内容（否则"我把它改回去了"与"它还是另一版"分不开）');

    const withDetail = patchRuleDescriptor(pack, 'R-DEMO-01', { detail: '本专科要求病程记录带记录时间。' });
    assertEqual((withDetail.items[0] as QcRuleDescriptor).detail, '本专科要求病程记录带记录时间。', '应能覆盖谓词内置的判定依据');
    const cleared = patchRuleDescriptor(withDetail, 'R-DEMO-01', { detail: null });
    assertEqual(JSON.stringify(cleared), JSON.stringify(pack), '清掉覆盖 = 回到内置文案（并且回到原内容指纹）');

    assertEqual(codeOf(() => patchRuleDescriptor(pack, 'R-DEMO-01', { severity: 'block' })), 'E_RULE_SEVERITY_EDIT_LIMIT', 'block 不得由条目编辑打开');
    assertEqual(codeOf(() => patchRuleDescriptor(pack, 'R-DEMO-01', { severity: 'fatal' as never })), 'E_RULE_SEVERITY_EDIT_LIMIT', '非法级别同样拒');
    assertEqual((patchRuleDescriptor(pack, 'R-DEMO-01', { severity: 'info' }).items[0] as QcRuleDescriptor).severity, 'info', 'info / warn 可改');

    assertEqual(codeOf(() => patchRuleDescriptor(pack, 'R-DEMO-01', { predicate: { kind: 'write-document' } as never })), 'E_RULE_PREDICATE_UNKNOWN', '未知谓词拒');
    assertEqual(codeOf(() => patchRuleDescriptor(pack, 'R-DEMO-01', { predicate: { kind: 'text-missing-time', params: { minLength: 0 } } })), 'E_RULE_PARAM_INVALID', '非法参数拒');
    assertEqual(codeOf(() => patchRuleDescriptor(pack, 'R-DEMO-01', { detail: '规则 R-DEMO-01：自带规则号' })), 'E_RULE_DETAIL_INVALID', '判定依据里不得出现自身规则号');
    assertEqual(codeOf(() => patchRuleDescriptor(pack, 'R-NOPE', { title: 'x' })), 'E_RULE_ITEM_NOT_FOUND', '改不存在的条目要明确报出');
    assertEqual(codeOf(() => patchRuleDescriptor(pack, 'R-DEMO-01', {})), 'E_RULE_ITEM_INVALID', '没有要改的字段要拒');

    /* ⑥ 改标题不得把停用着的规则顺手打开：开关在库里是单独一列，不在包内容里 */
    const disabled = { ...pack, items: [{ ...(pack.items[0] as QcRuleDescriptor), enabled: false }] } as QcRulePack;
    const renamed = patchRuleDescriptor(disabled, 'R-DEMO-01', { title: '换个标题' });
    assertEqual((renamed.items[0] as QcRuleDescriptor).enabled, false, '改标题不得把停用着的规则打开');
  });

  await test('R10 条目级新增与删除：进自建包、规则号按序号生成、出处不动', () => {
    const created = addRule(null, { title: '本院自建规则', severity: 'warn', predicate: { kind: 'placeholder-residue' } });
    assertEqual(created.pack.packId, CUSTOM_RULE_PACK_ID, '新建的规则进自建包（哪些是本院自己维护的必须一眼分得出来）');
    assertEqual(created.itemId, 'R-CUSTOM-1', '规则号按序号生成（可读、稳定，不依赖时间）');
    assertEqual(created.pack.items.length, 1, '包里多了一条');

    const second = addRule(created.pack, { title: '第二条', severity: 'info', predicate: { kind: 'tagged-empty-text' } });
    assertEqual(second.itemId, 'R-CUSTOM-2', '序号递增（同一秒建两条也不会撞）');
    assertEqual(second.pack.items.length, 2, '新包里两条');
    assertEqual(created.pack.items.length, 1, '上一步那份包仍是一条（原包不动）');

    assertEqual('enabled' in (second.pack.items[1] as object), false, '新建的条目不得把开关写进包内容');

    assertEqual(codeOf(() => addRule(null, { title: '', severity: 'warn', predicate: { kind: 'text-missing-time' } })), 'E_RULE_ITEM_INVALID', '标题必填');
    assertEqual(codeOf(() => addRule(null, { title: 'x', severity: 'block', predicate: { kind: 'text-missing-time' } })), 'E_RULE_SEVERITY_EDIT_LIMIT', '新建也不放开 block');
    assertEqual(codeOf(() => addRule(null, { title: 'x', severity: 'warn', predicate: { kind: 'nope' } as never })), 'E_RULE_PREDICATE_UNKNOWN', '未知谓词拒');

    const removed = removeRule(second.pack, 'R-CUSTOM-1');
    assertEqual(removed.items.map((entry) => entry.itemId), ['R-CUSTOM-2'], '删掉的是点名的这一条');
    assertEqual(second.pack.items.length, 2, '原包仍然不动');
    assertEqual(codeOf(() => removeRule(second.pack, 'R-NOPE')), 'E_RULE_ITEM_NOT_FOUND', '删不存在的条目要明确报出');

    /* 编辑过的包必须仍能编译成可运行规则：否则表现是"保存成功、质控却少一条"  */
    assertEqual(compileRulePack(removed).map((rule) => rule.id), ['R-CUSTOM-2'], '改完的包仍能编译');
  });

  await test('R11 下发给界面的谓词规格与谓词注册表逐项一致（界面照它生成参数表单，引擎照它校验参数）', () => {
    const catalog = qcPredicateCatalog();
    assertEqual(
      catalog.map((entry) => entry.kind).join(','),
      Object.keys(QC_PREDICATES).join(','),
      '清单要覆盖全部谓词，顺序也照注册表（界面不另排一份顺序）',
    );
    for (const entry of catalog) {
      const predicate = QC_PREDICATES[entry.kind];
      assert(!!predicate, `${entry.kind} 必须存在于谓词注册表里`);
      assertEqual(String(entry.label), String(predicate.label), `${entry.kind} 的人话名要与注册表一致`);
      assert(String(entry.doc ?? '').trim().length > 0, `${entry.kind} 要带说明（界面上那一段提示）`);
      assertEqual(
        entry.params.map((spec) => spec.name).join(','),
        (predicate.params ?? []).join(','),
        `${entry.kind} 的参数名要与注册表里那一份一致`,
      );
      for (const spec of entry.params) {
        assert(
          ['integer', 'number', 'string', 'enum', 'string-list', 'condition', 'condition-ref', 'condition-args'].includes(spec.kind),
          `${entry.kind}.${spec.name} 的控件类型要在允许集合里（否则界面不知道生成哪种格）`,
        );
        assert(String(spec.label ?? '').trim().length > 0, `${entry.kind}.${spec.name} 要有字段名`);
        assert(String(spec.doc ?? '').trim().length > 0, `${entry.kind}.${spec.name} 要带说明`);
        if (spec.kind === 'enum') assert((spec.options ?? []).length > 0, `${entry.kind}.${spec.name} 是下拉：取值域不能为空`);
        for (const text of [entry.label, entry.doc, spec.label, spec.doc]) {
          assert(!String(text).includes('**'), `${entry.kind}.${spec.name} 的文案里不得出现 Markdown 记号`);
        }
      }
    }
    const conditionUsers = catalog.filter((entry) => entry.params.some((spec) => spec.kind === 'condition'));
    assertEqual(conditionUsers.length, 1, '条件树参数只该有一个谓词在用');
    assert(
      String(conditionUsers[0]?.doc ?? '').includes('自己拼'),
      '那一种谓词的说明里要说清"这是自己拼出来的判法"，否则使用者不知道它和别的有什么不同',
    );

    const timeLimit = catalog.find((entry) => entry.kind === 'document-time-limit');
    assert(
      (timeLimit?.params ?? []).some((spec) => spec.name === 'limitHours' && spec.required === true),
      '必填参数要标出来：界面据此在提交前先拦一次',
    );
  });

  const seedOf = (itemId: string): QcConditionDefinition => {
    const found = SEED_CONDITIONS.find((item) => item.itemId === itemId);
    if (!found) throw new Error(`出厂种子里没有「${itemId}」`);
    return JSON.parse(JSON.stringify(found)) as QcConditionDefinition;
  };
  const libraryOf = (...itemIds: string[]): ConditionLibrary =>
    resolveConditionLibrary(itemIds.map(seedOf), '判定方式库（自测）');

  const conditionRefPack = (params: Record<string, JsonValue>): QcRulePack => ({
    packId: 'qc.condition-ref-test',
    name: '引用库里判定方式的包',
    kind: 'rule',
    engineApi: 'qc-rule/1',
    items: [{
      itemId: 'R-COND-1',
      title: '记录类段落缺记录时间',
      severity: 'warn',
      predicate: { kind: 'field-condition', params },
    }],
  });

  await test('R12 判定方式是库级资产：任何包的规则都能引用它，实参照它的参数表校验', () => {
    const library = libraryOf('C-BUILTIN-MISSING-TIME');
    const pack = conditionRefPack({ conditionId: 'C-BUILTIN-MISSING-TIME', args: { minLength: 5 } });
    validateRulePack(pack, library);
    const [rule] = compileRulePack(pack, library);
    if (!rule) throw new Error('应编译出一条规则');

    const long = { nodeId: 'n_1' as NodeId, type: 'text', text: '患者一般情况可，无特殊不适', tags: [], keyContent: false };
    const hit = hitOrNull(rule, long);
    assert(hit !== null, '没有任何时间表述的长段落 → 命中');
    assert(String(hit?.detail ?? '').includes('C-BUILTIN-MISSING-TIME'), '依据里要写出是引用哪一条判定方式（复核要用它去后台找）');

    const withTime = { nodeId: 'n_2' as NodeId, type: 'text', text: '2026-10-09 患者一般情况可', tags: [], keyContent: false };
    assertEqual(hitOrNull(rule, withTime), null, '含时间表述 → 不命中');
    const short = { nodeId: 'n_3' as NodeId, type: 'text', text: '腹痛', tags: [], keyContent: false };
    assertEqual(hitOrNull(rule, short), null, '短于阈值不判 —— 在标题与短标签上要求时间只会造成误报');

    assertEqual(
      codeOf(() => validateRulePack(conditionRefPack({ conditionId: 'C-BUILTIN-MISSING-TIME' }), library)),
      'E_RULE_CONDITION_PARAM_INVALID',
      '判定方式的必填参数缺了要拒（"我填的没生效"必须当场报）',
    );
    assertEqual(
      codeOf(() => validateRulePack(conditionRefPack({ conditionId: 'C-BUILTIN-NOPE' }), library)),
      'E_RULE_CONDITION_UNKNOWN',
      '引用库里不存在的那一条要拒',
    );
    assertEqual(
      codeOf(() => validateRulePack(conditionRefPack({ conditionId: 'C-BUILTIN-MISSING-TIME', args: { minLength: 5 } }))),
      'E_RULE_CONDITION_UNKNOWN',
      '校验时没把判定方式库带上也要拒（那是调用方漏了参数，不能猜一个空表当成"没有"）',
    );
  });

  await test('R13 引用面跨包：库里有就能引用；库里没有就拒；库优先于包内同码', () => {
    const library = libraryOf('C-BUILTIN-MISSING-TIME');

    validateRulePack(conditionRefPack({ conditionId: 'C-BUILTIN-MISSING-TIME', args: { minLength: 4 } }), library);

    assertEqual(
      codeOf(() => validateRulePack(conditionRefPack({ conditionId: 'C-NOT-IN-LIBRARY' }), library)),
      'E_RULE_CONDITION_UNKNOWN',
      '库里没有那一条就必须拒：悬空引用会让这条规则什么都判不了，而它在界面上仍然列着',
    );

    const placeholderLibrary = libraryOf('C-BUILTIN-PLACEHOLDER');
    const staleCopy = {
      ...seedOf('C-BUILTIN-PLACEHOLDER'),
      name: '包里的旧拷贝（判「包含 旧口径」）',
      when: { kind: 'atom', field: 'text', op: 'contains', value: ['旧口径'] } as JsonValue,
    };
    const withStaleCopy: QcRulePack = {
      ...conditionRefPack({ conditionId: 'C-BUILTIN-PLACEHOLDER' }),
      items: [staleCopy, ...conditionRefPack({ conditionId: 'C-BUILTIN-PLACEHOLDER' }).items],
    };
    const [stale] = compileRulePack(withStaleCopy, placeholderLibrary);
    if (!stale) throw new Error('应编译出一条规则');
    const staleOwner = { nodeId: 'n_x' as NodeId, type: 'text', text: '旧口径', tags: [], keyContent: false };
    assertEqual(hitOrNull(stale, staleOwner), null, '库里那份说了算：包里那份"包含旧口径"不该生效');
    const [legacy] = compileRulePack(withStaleCopy);
    if (!legacy) throw new Error('应编译出一条规则');
    assert(hitOrNull(legacy, staleOwner) !== null, '库里还没有这一条时，包内那份是唯一的定义，照常生效');

    assertEqual(
      codeOf(() => resolveConditionLibrary([seedOf('C-BUILTIN-MISSING-TIME'), seedOf('C-BUILTIN-MISSING-TIME')])),
      'E_RULE_CONDITION_INVALID',
      '库里两条同码必须拒',
    );
  });

  await test('R14 两条路径同一结论：数据化的跨文书判定要与内核谓词逐条对齐', () => {
    const base = '2026-10-01T00:00:00.000Z';
    const at = (hours: number): string => new Date(Date.parse(base) + hours * 3_600_000).toISOString();
    const docView: QcNodeView = { nodeId: 'n_doc' as NodeId, type: 'document', text: '', tags: [], keyContent: false };
    const doc = { docId: 'd1', docTypeCode: 'WST500.3', createdAt: base };
    const far = { docId: 'd2', docTypeCode: 'WST500.3', createdAt: at(96) };
    const near = { docId: 'd3', docTypeCode: 'WST500.3', createdAt: at(12) };
    const ctxOf = (visitDocs: QcContext['visitDocs']): QcContext => ({ now: at(100), admittedAt: base, visitDocs });

    const [viaTree] = compileRulePack({
      packId: 'qc.condition-interval',
      name: 'x',
      kind: 'rule',
      engineApi: 'qc-rule/1',
      items: [
        {
          itemId: 'R-TREE',
          title: '同类文书间隔超限',
          severity: 'warn',
          predicate: {
            kind: 'field-condition',
            params: { conditionId: 'C-BUILTIN-VISIT-DOC-INTERVAL', args: { docTypeCode: 'WST500.3', maxGapHours: 72 } },
          },
        },
      ],
    }, libraryOf('C-BUILTIN-VISIT-DOC-INTERVAL'));
    const viaPredicate = compileRuleDescriptor('qc.pred', {
      itemId: 'R-PRED',
      title: '同类文书间隔超限',
      severity: 'warn',
      predicate: { kind: 'visit-doc-interval', params: { docTypeCode: 'WST500.3', maxGapHours: 72 } },
    });

    const cases: Array<[string, QcContext['visitDocs']]> = [
      ['间隔超过阈值（两份隔 96 小时）', [doc, far]],
      ['间隔未超（两份隔 12 小时）', [doc, near]],
      ['该类一份都没有（由"应有而缺"负责）', [{ docId: 'd0', docTypeCode: 'WST500.1', createdAt: base }]],
      ['拿不到清单 —— 两条都该走"判不了"', undefined],
    ];
    for (const [name, visitDocs] of cases) {
      const treeResult = viaTree?.check(docView, ctxOf(visitDocs)) ?? null;
      const predResult = viaPredicate.check(docView, ctxOf(visitDocs));
      const kindOf = (result: { uncertain?: string } | { detail?: string } | null): string => {
        if (!result) return 'none';
        return 'uncertain' in result ? 'uncertain' : 'hit';
      };
      assertEqual(kindOf(treeResult as never), kindOf(predResult as never), `${name}：两条路径的结论必须一致`);
    }
  });

  process.exit(suite.report());
}

void main();
