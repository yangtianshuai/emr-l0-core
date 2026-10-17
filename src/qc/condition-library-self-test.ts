/**
 * 具名条件（**判定方式库**）自测。
 *
 *   node src/qc/condition-library-self-test.ts
 *
 * 覆盖四层：
 *   E 库本身：新建的编号 / 编码形状 / 名称必填 / 条件树不合法即拒 / 同码即拒
 *   F 引用面："谁在用它"是**一份**数据（目录与删除保护读同一个函数），而且是**跨包**的
 *   G **改一处处处生效**：改一条条件，引它的规则一起变（无论在哪个包）；没引它的一个字不动
 *   H 引用保护与悬空引用：被引用不许删；引用了库里没有的条件在**装载期**就拒
 *
 * 为什么 G 是这一组的核心：具名条件这件事的价值与代价是同一句话 ——
 * "改一处，引它的规则一起变"。它错了，那就是一次静默的批量改动；
 * 模板公式那边至今**没有**这条用例（照抄它的实现时，这条缺口要补上）。
 *
 * 为什么 F 要跨包：判定方式是**库级资产**（不属于任何包），所以"这条规则按什么判"
 * 不再取决于它在哪个包 —— 引用面也必须跨包数，否则会出现
 * "界面说没人用、删除却被拒"这种对不上的话。
 */

import { TestSuite, assert, assertEqual, assertThrows } from '../testing/harness.ts';
import type { JsonValue, NodeId } from '../model/types.ts';
import { createEmptyPackRegistry } from '../knowledge/default-registry.ts';
import type { PackRegistry } from '../knowledge/pack.ts';
import {
  addCondition,
  conditionCatalogOf,
  conditionUsedByAcrossPacks,
  conditionUsedByInPack,
  conditionLibraryOf,
  patchCondition,
  removeCondition,
  validateConditionItems,
} from './condition-library.ts';
import { normalizeCondition } from './condition.ts';
import {
  compileRulePack,
  conditionSummaryOf,
  resolvedConditionsOf,
  ruleItemsOf,
  validateRulePack,
  type ConditionLibrary,
} from './rule-pack.ts';
import type { QcConditionDefinition, QcContext, QcNodeView, QcRuleItem, QcRulePack } from './types.ts';

const suite = new TestSuite('质控·判定方式库（具名条件被规则引用）', [
  '说明：判定方式是**库级资产**（`config.qc-conditions` 一行，不属于任何包），任何包的规则都能引用它。',
  'G 组是核心：具名条件的价值与代价是同一句话——改一处，引它的规则一起变。',
]);

const test = (name: string, fn: () => void | Promise<void>): Promise<void> => suite.test(name, fn);

/* ------------------------------- 造样本 ------------------------------- */

function view(over: Partial<QcNodeView> = {}): QcNodeView {
  return { nodeId: 'n_1' as NodeId, type: 'text', text: '', tags: [], keyContent: false, ...over };
}

function ctx(over: Partial<QcContext> = {}): QcContext {
  return { now: '2026-10-16T12:00:00.000Z', ...over };
}

/** 一条"正文包含某个词"的条件树（返回值就是库里的 JSON 形状：条件是**未校验的 JSON**） */
function contains(words: string[]): JsonValue {
  const tree = normalizeCondition({ kind: 'atom', field: 'text', op: 'contains', value: words });
  if (!tree) throw new Error(`构造样本失败：contains ${words.join('/')}`);
  return tree as unknown as JsonValue;
}

/** 一个只有规则的包（判定方式在库里） */
function rulePack(packId: string, items: QcRuleItem[]): QcRulePack {
  return {
    packId,
    name: `自测包 ${packId}`,
    kind: 'rule',
    engineApi: 'qc-rule/1',
    items,
  };
}

function ruleOf(itemId: string, conditionId: string, title = '引用判定方式的规则'): QcRuleItem {
  return { itemId, title, severity: 'warn', predicate: { kind: 'field-condition', params: { conditionId } } };
}

/* 用**出厂的空注册表**（`createEmptyPackRegistry()`）：它带着本机实现了哪些引擎这一类信息，
   这里看不出"本机有没有规则引擎"才是对的 —— 引用面要跨包数，所以需要一个真实的注册表 */
function registryWith(library: ConditionLibrary, ...packs: QcRulePack[]): PackRegistry {
  const registry = createEmptyPackRegistry();
  for (const pack of packs) {
    registry.load(pack, { validate: (loaded) => validateRulePack(loaded as QcRulePack, library) });
  }
  return registry;
}

/** 命中与否（把"判不了"单独标出来，免得把两者混成一个 false） */
function verdictOf(pack: QcRulePack, library: ConditionLibrary, ruleId: string, text: string): 'hit' | 'miss' | 'uncertain' {
  const rule = compileRulePack(pack, library).find((item) => item.id === ruleId);
  if (!rule) throw new Error(`样本里没有规则 ${ruleId}`);
  const result = rule.check(view({ text }), ctx());
  if (!result) return 'miss';
  return 'uncertain' in result ? 'uncertain' : 'hit';
}

/** 库里那一条（用界面同一条路：新建 → 拿到清单与编码） */
function libraryWith(input: { name: string; when: unknown; params?: unknown }): {
  items: QcConditionDefinition[];
  itemId: string;
} {
  const created = addCondition([], input);
  return { items: created.items, itemId: created.itemId };
}

async function main(): Promise<void> {
  /* ============================ E 库本身 ============================ */

  await test('E1 新建：编码按 C-CUSTOM-N 递增、名称必填、条件树不合法即拒、同码即拒', () => {
    const first = addCondition([], { name: '占位文字未替换', when: contains(['待补充']) });
    assertEqual(first.itemId, 'C-CUSTOM-1', '第一条编码按序号生成');
    assertEqual(first.items.length, 1, '库里多出一条判定方式');
    assertEqual(first.items[0]?.itemType, 'condition', '库里存的是 condition 条目（库里不该出现规则）');

    const second = addCondition(first.items, { name: '第二条', when: contains(['TODO']) });
    assertEqual(second.itemId, 'C-CUSTOM-2', '编码递增');
    /* 删掉中间一条之后再建：不能撞上已用过的编码 —— 编码是引用键，撞了等于把引用指到别处 */
    const trimmed = second.items.filter((item) => item.itemId !== 'C-CUSTOM-1');
    assertEqual(addCondition(trimmed, { name: '第三条', when: contains(['X']) }).itemId, 'C-CUSTOM-3', '编码不回收');

    assertThrows(
      () => addCondition([], { name: '   ', when: contains(['待补充']) }),
      (err) => (err as { code?: string }).code === 'E_RULE_CONDITION_INVALID',
      '空名称要拒（界面上要按名字挑它）',
    );
    assertThrows(
      () => addCondition([], { name: '条件树写错', when: { kind: 'atom', field: 'text', op: 'matches', value: 'x' } }),
      (err) => (err as { code?: string }).code === 'E_RULE_CONDITION_INVALID',
      '未知算子要拒（条件树本身必须先站得住，才谈得上被别人引用）',
    );
    assertThrows(
      () => addCondition([], { name: '条件树缺一块', when: { kind: 'all', children: [] } }),
      (err) => (err as { code?: string }).code === 'E_RULE_CONDITION_INVALID',
      '空条件树要拒',
    );
    assertThrows(
      () => validateConditionItems([first.items[0], first.items[0]]),
      (err) => (err as { code?: string }).code === 'E_RULE_CONDITION_INVALID',
      '清单里两条同码必须拒（编码是引用键）',
    );
  });

  /* ============================ F 引用面 ============================ */

  await test('F2 "谁在用它"只有一份数据，而且是**跨包**的：目录与删除保护读同一个函数', () => {
    const { items, itemId } = libraryWith({ name: '占位文字未替换', when: contains(['待补充']) });
    const library = conditionLibraryOf(items);
    const packA = rulePack('qc.a', [ruleOf('R-A-1', itemId, '主诉里还留着占位文字')]);
    const packB = rulePack('qc.b', [ruleOf('R-B-1', itemId, '既往史里还留着占位文字'), ruleOf('R-B-2', itemId)]);
    const registry = registryWith(library, packA, packB);

    const inPackA = conditionUsedByInPack(packA, itemId);
    assertEqual(inPackA.map((user) => user.itemId), ['R-A-1'], '单包引用面只数本包');
    const users = conditionUsedByAcrossPacks(registry, itemId);
    assertEqual(
      users.map((user) => `${user.packId}/${user.itemId}`),
      ['qc.a/R-A-1', 'qc.b/R-B-1', 'qc.b/R-B-2'],
      '跨包引用面要按包排序列全（判定方式是库级的，引用方可能在多个包里）',
    );
    assertEqual(users.map((user) => user.title)[0], '主诉里还留着占位文字', '要带标题：界面照它说"会影响哪几条"');

    const entry = conditionCatalogOf(items, registry).find((item) => item.itemId === itemId);
    assertEqual(entry?.name, '占位文字未替换', '目录要带条件名');
    assertEqual(entry?.summary, '段落正文 包含（任一） 「待补充」', '目录要带人话回读（界面那一列照它显示）');
    assertEqual(
      entry?.usedBy.map((user) => user.itemId),
      users.map((user) => user.itemId),
      '目录里的引用面与 conditionUsedByAcrossPacks 必须一致 —— 否则界面说没人用、删除却被拒',
    );
    assertEqual(conditionCatalogOf(items, registry).length, 1, '目录只列判定方式，不列规则');

    /* 停用着的引用方也要列出来：它会因为这条条件的改动而改变行为（只是暂时没跑） */
    const disabled = rulePack('qc.a', [{ ...ruleOf('R-A-1', itemId), enabled: false } as QcRuleItem]);
    const registry2 = registryWith(library, disabled);
    assertEqual(
      conditionUsedByAcrossPacks(registry2, itemId).map((user) => user.enabled),
      [false],
      '启用状态如实带出',
    );
  });

  /* ======================= G 改一处，处处生效 ======================= */

  await test('G3 改一条判别方式：引它的规则（跨包）一起变，没引它的一个字不动', () => {
    const { items, itemId } = libraryWith({ name: '占位文字未替换', when: contains(['待补充']) });
    const library = conditionLibraryOf(items);
    const packA = rulePack('qc.a', [ruleOf('R-USE-1', itemId)]);
    const packB = rulePack('qc.b', [ruleOf('R-USE-2', itemId)]);
    const inline = rulePack('qc.c', [{
      itemId: 'R-INLINE',
      title: '就地拼的那一条',
      severity: 'warn',
      predicate: { kind: 'field-condition', params: { when: contains(['TODO']) } },
    }]);

    assertEqual(verdictOf(packA, library, 'R-USE-1', '主诉：待补充'), 'hit', '前置：引用方按原条件命中');
    assertEqual(verdictOf(packB, library, 'R-USE-2', '既往史：待补充'), 'hit', '前置：另一个包的引用方同样命中');
    assertEqual(verdictOf(inline, library, 'R-INLINE', '既往史：待补充'), 'miss', '前置：内联那条与这条判定方式无关');
    assertEqual(verdictOf(inline, library, 'R-INLINE', '既往史：TODO'), 'hit', '前置：内联那条按自己的条件命中');

    const patched = patchCondition(items, itemId, { when: contains(['待补充', '未填写']) });
    const patchedLibrary = conditionLibraryOf(patched);
    /* ① 规则条目**一个字节都没动**：改的是共用资产，不是批量改写规则 ——
       这一点很重要，"一起变"如果是靠改写那几条规则实现的，就会出现"保存一次改了五条规则" */
    assertEqual(
      JSON.stringify(ruleItemsOf(packA)),
      JSON.stringify([ruleOf('R-USE-1', itemId)]),
      '规则条目必须原样（一起变是引用解析的结果，不是把规则抄改一遍）',
    );
    assertEqual(verdictOf(packA, patchedLibrary, 'R-USE-1', '主诉：待补充'), 'hit', '旧词仍然命中（这次是加了一个词）');
    assertEqual(verdictOf(packA, patchedLibrary, 'R-USE-1', '主诉：未填写'), 'hit', '**新词对引用方立刻生效**');
    assertEqual(verdictOf(packB, patchedLibrary, 'R-USE-2', '既往史：未填写'), 'hit', '**另一个包的引用方也跟着变**（这才叫改一处、处处生效）');
    assertEqual(verdictOf(inline, patchedLibrary, 'R-INLINE', '既往史：未填写'), 'miss', '没引它的规则一个字不动');

    /* ② 人名话回读也跟着变：界面上那句"这条规则按什么判"不能停留在旧口径 */
    const summary = conditionSummaryOf(ruleOf('R-USE-1', itemId) as never, resolvedConditionsOf(packA, patchedLibrary));
    assertEqual(
      summary,
      `引用条件「${itemId} 占位文字未替换」：段落正文 包含（任一） 「待补充、未填写」`,
      '引用写法的人话回读要带条件名与条件本身（否则界面只显示一个孤零零的编码）',
    );

    /* ③ 内联写法的人话回读：不带"引用条件"，就事论事 */
    assertEqual(
      conditionSummaryOf(ruleItemsOf(inline)[0] as never, resolvedConditionsOf(inline, patchedLibrary)),
      '段落正文 包含（任一） 「TODO」',
      '内联写法照旧',
    );
  });

  /* ======================= H 引用保护与悬空引用 ======================= */

  await test('H4 被规则引用的判定方式不许删（跨包数）：拒绝时要说清是哪几条规则在用、在哪个包', () => {
    const { items, itemId } = libraryWith({ name: '占位文字未替换', when: contains(['待补充']) });
    const library = conditionLibraryOf(items);
    const registry = registryWith(
      library,
      rulePack('qc.a', [ruleOf('R-A-1', itemId, '主诉里还留着占位文字')]),
      rulePack('qc.b', [ruleOf('R-B-1', itemId, '既往史里还留着占位文字')]),
    );
    assertThrows(
      () => removeCondition(items, itemId, registry),
      (err) => {
        const typed = err as { code?: string; message?: string };
        assertEqual(typed.code, 'E_RULE_CONDITION_IN_USE', '错误码要说清"还有人用"');
        assert(!!typed.message?.includes('主诉里还留着占位文字'), '要说清是哪一条规则在用');
        assert(!!typed.message?.includes('既往史里还留着占位文字'), '另一个包里的那条也要列出来');
        assert(!!typed.message?.includes('qc.a') && !!typed.message?.includes('qc.b'), '还要说清它在哪个包（库级资产的引用方可能分布在多个包里）');
        return true;
      },
      '被引用的判定方式删除必须被拒',
    );

    /* 把引用改成别的写法（这里直接改指到另一条判定方式），就能删了 —— 拦住之后必须有出路 */
    const another = addCondition(items, { name: '另一条', when: contains(['X']) });
    const repointed = registryWith(
      conditionLibraryOf(another.items),
      rulePack('qc.a', [ruleOf('R-A-1', another.itemId)]),
      rulePack('qc.b', [ruleOf('R-B-1', another.itemId)]),
    );
    assertEqual(conditionUsedByAcrossPacks(repointed, itemId).length, 0, '前置：改指之后没人再用它');
    const removed = removeCondition(another.items, itemId, repointed);
    assertEqual(removed.map((item) => item.itemId), [another.itemId], '没人用之后可以删');
  });

  await test('H5 悬空引用在装载期就拒：引用了库里没有的判定方式', () => {
    const { items, itemId } = libraryWith({ name: '占位文字未替换', when: contains(['待补充']) });
    const library = conditionLibraryOf(items);
    const dangling = rulePack('qc.dangling', [ruleOf('R-DANGLING', 'C-NOT-EXIST')]);
    assertThrows(
      () => validateRulePack(dangling, library),
      (err) => {
        const typed = err as { code?: string; message?: string };
        assertEqual(typed.code, 'E_RULE_CONDITION_UNKNOWN', '错误码要说清"引用的判定方式不存在"');
        assert(!!typed.message?.includes('C-NOT-EXIST'), '要指出是哪一个引用');
        assert(!!typed.message?.includes(itemId), '要把库里可用的判定方式列出来（否则只能靠猜）');
        return true;
      },
      '悬空引用必须在装载期被拒（等到扫描时，"少跑一条"没人看得出来）',
    );
    /* 装载走注册表时同样拒：两条路走的是同一段校验 */
    assertThrows(
      () => registryWith(library, dangling),
      (err) => (err as { code?: string }).code === 'E_RULE_CONDITION_UNKNOWN',
      '装包那一刻同样拒',
    );
  });

  await test('H6 两选一：conditionId 与 when 同时给、或都不给，都要拒', () => {
    const { items, itemId } = libraryWith({ name: '占位文字未替换', when: contains(['待补充']) });
    const library = conditionLibraryOf(items);
    const pack = rulePack('qc.choice', [ruleOf('R-OK', itemId)]);

    const both = rulePack('qc.choice', [
      ...ruleItemsOf(pack),
      {
        itemId: 'R-BOTH',
        title: '两个都填了',
        severity: 'warn',
        predicate: { kind: 'field-condition', params: { conditionId: itemId, when: contains(['X']) } },
      },
    ]);
    assertThrows(
      () => validateRulePack(both, library),
      (err) => (err as { code?: string }).code === 'E_RULE_CONDITION_CHOICE',
      '两格都填要拒，且错误码要说清是"二选一"（不是笼统的"参数不合法"）',
    );

    const neither = rulePack('qc.choice', [
      ...ruleItemsOf(pack),
      { itemId: 'R-NONE', title: '两个都没填', severity: 'warn', predicate: { kind: 'field-condition', params: {} } },
    ]);
    assertThrows(
      () => validateRulePack(neither, library),
      (err) => (err as { code?: string }).code === 'E_RULE_PARAM_INVALID',
      '两格都不填要拒（否则会存下一条永远不命中的规则，而界面上一切正常）',
    );

    const badId = rulePack('qc.choice', [
      ...ruleItemsOf(pack),
      {
        itemId: 'R-BADID',
        title: '编码形状不对',
        severity: 'warn',
        predicate: { kind: 'field-condition', params: { conditionId: 'C 001' } },
      },
    ]);
    assertThrows(
      () => validateRulePack(badId, library),
      (err) => (err as { code?: string }).code === 'E_RULE_PARAM_INVALID',
      '编码形状不对要在参数校验那一层就拒（引用键不许出现"看起来一样、其实多个空格"的写法）',
    );
  });

  await test('H7 编译只编规则：库里那份不会被当成规则（包里也不该出现条件条目）', () => {
    const { items, itemId } = libraryWith({ name: '占位文字未替换', when: contains(['待补充']) });
    const library = conditionLibraryOf(items);
    const pack = rulePack('qc.compile', [ruleOf('R-USE-1', itemId), ruleOf('R-USE-2', itemId), {
      itemId: 'R-INLINE',
      title: '就地拼的那一条',
      severity: 'warn',
      predicate: { kind: 'field-condition', params: { when: contains(['TODO']) } },
    }]);
    assertEqual(
      compileRulePack(pack, library).map((rule) => rule.id),
      ['R-USE-1', 'R-USE-2', 'R-INLINE'],
      '只编规则，顺序照包内顺序',
    );
  });

  await test('H8 读不出来时不猜：目录与回读都如实说"库里没有这一条"', () => {
    const { items, itemId } = libraryWith({ name: '占位文字未替换', when: contains(['待补充']) });
    const library = conditionLibraryOf(items);
    const registry = registryWith(library, rulePack('qc.a', [ruleOf('R-USE-1', itemId)]));

    /* 规则引用了一条库里已经没有的判定方式：回读如实说，不编一句话 */
    const gone = ruleOf('R-GONE', 'C-GONE');
    assertEqual(
      conditionSummaryOf(gone as never, resolvedConditionsOf(rulePack('qc.a', [gone]), library)),
      '引用条件「C-GONE」：库里没有这一条（它被删掉了，或这次没把判定方式库带上）',
      '读不出来就说读不出来，不编一句话',
    );
    /* 判定方式本身的条件树坏掉时：目录那一列回 null，让界面退回显示参数原文 */
    const brokenTree = { kind: 'atom', field: 'text', op: 'matches', value: 'x' } as unknown as JsonValue;
    const degraded = items.map((item) => ({ ...item, when: brokenTree }));
    assertEqual(conditionCatalogOf(degraded, registry)[0]?.summary, null, '读不出来的条件：那一列回 null，不编一句人话');
    assertEqual(conditionCatalogOf(degraded, registry)[0]?.usedBy.length, 1, '但"谁在用它"照旧要读出来（那是结构，不是措辞）');
  });

  process.exit(suite.report());
}

void main();
