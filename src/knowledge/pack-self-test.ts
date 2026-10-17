/**
 * 知识资产包 · 通用层自测（P1~P8）。
 *
 *   node src/knowledge/pack-self-test.ts
 *
 * 这一层是"模板包 / 规则包 / 术语包"的公共地基，因此本套的重点全在**失败路径**：
 *   P1 校验：缺字段、未知字段、未知类别、非法版本、空条目、条目重名 —— 各有独立错误码；
 *   P2 **契约精确匹配**：版本号更大不算兼容；未实现的类别一律拒绝（不摆假路径）；
 *   P3 包级冲突与显式替换（不允许"悄悄覆盖"，那会让人以为载的还是原来那一版）；
 *   P4 **条目级冲突**：两条同名条目"谁生效"不该由装载顺序决定；
 *   P5 开关：只动"生效指纹"，不动"内容指纹"——两者必须分得开；
 *   P6 指纹与键序/装载顺序无关（否则跨端比对会退化成"比装载风格"）；
 *   P7 归一化与深拷贝：`enabled` 补缺省、外部对象改动不得影响已装载的包；
 *   P8 装载是**原子**的：类别专有校验失败时，包一个字都不该进注册表。
 */

import { TestSuite, assert, assertEqual } from '../testing/harness.ts';
import {
  PackRegistry,
  PACK_NOT_IN_DOCUMENT,
  validatePack,
  type Pack,
  type SupportedEngineApis,
} from './pack.ts';

const suite = new TestSuite('知识资产包 · 通用层自测', [
  '说明：全部离线，不读文件、不碰文档 —— 包只是一份数据。',
  'P7 的"JSON 往返等价"是结构级证明：包里塞不进函数，因此它不可能带来可执行代码。',
]);

const test = (name: string, fn: () => void | Promise<void>): Promise<void> => suite.test(name, fn);

/** 与真实装配一致的口径：rule 已实现；template / term 尚无引擎 */
const SUPPORTED: SupportedEngineApis = { rule: ['qc-rule/1'], template: [], term: [] };

/* 包**不再有版本字段**（见 `pack-store.ts` 文件头：一个包一行，"现在跑的是哪一份内容"由指纹回答）。
   夹具里刻意不再放 `version` —— 它现在会被当成未知字段拒绝。 */
function rawPack(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    packId: 'qc.demo.a',
    kind: 'rule',
    name: '演示规则包',
    engineApi: 'qc-rule/1',
    items: [{ itemId: 'X-1' }],
    ...overrides,
  };
}

function registry(): PackRegistry {
  return new PackRegistry(SUPPORTED);
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
    return 'OK';
  } catch (err) {
    return (err as { code?: string }).code ?? `UNEXPECTED:${(err as Error).message}`;
  }
}

async function main(): Promise<void> {
  await test('P1 校验：合法包通过；缺字段 / 未知字段 / 未知类别 / 非法版本 / 空条目 / 条目重名各有独立错误码', () => {
    const valid = validatePack(rawPack(), SUPPORTED);
    assertEqual(valid.packId, 'qc.demo.a', '合法包应通过校验');
    assertEqual(valid.items.length, 1, '条目应保留');

    assertEqual(codeOf(() => validatePack('not-an-object', SUPPORTED)), 'E_PACK_NOT_OBJECT', '非对象');
    assertEqual(codeOf(() => validatePack(rawPack({ packId: undefined }), SUPPORTED)), 'E_PACK_FIELD_MISSING', '缺 packId');
    assertEqual(
      codeOf(() => validatePack(rawPack({ verison: '1.1.0' }), SUPPORTED)),
      'E_PACK_FIELD_INVALID',
      '未知字段必须拒绝 —— 拼错的字段名会让"改了没生效"无声无息',
    );
    assertEqual(codeOf(() => validatePack(rawPack({ kind: 'widget' }), SUPPORTED)), 'E_PACK_KIND_UNKNOWN', '未知类别');
    assertEqual(codeOf(() => validatePack(rawPack({ items: [] }), SUPPORTED)), 'E_PACK_ITEMS_EMPTY', '空包');
    assertEqual(
      codeOf(() => validatePack(rawPack({ items: [{ itemId: 'X-1' }, { itemId: 'X-1' }] }), SUPPORTED)),
      'E_PACK_ITEM_ID_DUPLICATE',
      '包内条目重名',
    );
    /* 版本概念已删（见 `pack-store.ts` 文件头）—— 这里改成钉住"它真的不再是字段"：
       带着 `version` 的旧包会被**未知字段**拒绝，而不是被静默忽略。 */
    assertEqual(
      codeOf(() => validatePack(rawPack({ version: '1.0.0' }), SUPPORTED)),
      'E_PACK_FIELD_INVALID',
      '旧的 version 字段现在应被当作未知字段拒绝（迁移会把它剥掉，见 schema 的 0003）',
    );
  });

  await test('P2 契约精确匹配：版本号更大不算兼容；未实现的类别一律拒绝', () => {
    assertEqual(
      codeOf(() => validatePack(rawPack({ engineApi: 'qc-rule/2' }), SUPPORTED)),
      'E_PACK_ENGINE_API_UNSUPPORTED',
      '契约不同即拒绝：按新契约解释旧包会"成功但读错"，报错远比装错安全',
    );

    const templateAttempt = codeOf(() =>
      validatePack(rawPack({ packId: 'tpl.demo', kind: 'template', engineApi: 'doc-template/1', items: [{ itemId: 'T-1' }] }), SUPPORTED),
    );
    assertEqual(templateAttempt, 'E_PACK_ENGINE_API_UNSUPPORTED', '模板包尚无引擎，必须明确拒绝');
    /* 提示必须说清"是没有引擎"，而不是"契约版本不对" —— 否则排查方向会被带偏到改版本号上 */
    try {
      validatePack(rawPack({ packId: 'tpl.demo', kind: 'template', engineApi: 'doc-template/1', items: [{ itemId: 'T-1' }] }), SUPPORTED);
    } catch (err) {
      assert(String((err as Error).message).includes('尚未实现'), `未实现类别的提示应说清原因，实际：${(err as Error).message}`);
    }
  });

  await test('P3 包级冲突：同 ID 不覆盖（除非显式 replace）；卸载后 ID 可再用', () => {
    const store = registry();
    store.load(rawPack());
    assertEqual(store.list().length, 1, '首次装载');

    assertEqual(
      codeOf(() => store.load(rawPack({ name: '演示规则包（第二次）' }))),
      'E_PACK_DUPLICATE',
      '同 packId 再次装载必须拒绝 —— 悄悄覆盖会让人以为载的还是原来那一版',
    );
    /* 错误信息要能回答"是新包更高还是更低"，否则运维只能猜 */
    try {
      store.load(rawPack({ name: '演示规则包（换一份内容）' }));
    } catch (err) {
      /* 新模型里没有版本可比，要说清的是"**同一个 packId 只对应一份内容**"，
         并且把出路写出来（显式 replace）—— 让人知道下一步能做什么。 */
      assert(
        String((err as Error).message).includes('两份内容不同') && String((err as Error).message).includes('replace'),
        `冲突提示要说清"两份内容不同"并给出出路，实际：${(err as Error).message}`,
      );
    }

    const replaced = store.load(rawPack({ name: '演示规则包（修订）' }), { replace: true });
    assertEqual(replaced.name, '演示规则包（修订）', '显式 replace 应成功');
    assertEqual(store.list().length, 1, '替换而不是并存');

    assertEqual(store.unload('qc.demo.a'), true, '卸载');
    assertEqual(store.list().length, 0, '卸载后清空');
    store.load(rawPack());
    assertEqual(store.list().length, 1, '卸载后 ID 可以再用');
  });

  await test('P4 条目级冲突：同类别下同 itemId 被两个包占用 → 拒绝装载', () => {
    const store = registry();
    store.load(rawPack());
    assertEqual(
      codeOf(() => store.load(rawPack({ packId: 'qc.demo.b', items: [{ itemId: 'X-1' }, { itemId: 'X-2' }] }))),
      'E_PACK_ITEM_CONFLICT',
      '两条同名条目"谁生效"只能靠装载顺序 —— 而顺序不该决定判定结果',
    );

    /* 不同类别之间不该误伤：模板包与规则包各有各的 X-1 是正常的 */
    const other = new PackRegistry({ rule: ['qc-rule/1'], template: ['doc-template/1'], term: [] });
    other.load(rawPack());
    other.load(rawPack({ packId: 'tpl.demo', kind: 'template', engineApi: 'doc-template/1', items: [{ itemId: 'X-1' }] }));
    assertEqual(other.list().length, 2, '不同类别的同名条目不算冲突');

    /* 失败的那次不得留下半个包 */
    const store2 = registry();
    store2.load(rawPack());
    codeOf(() => store2.load(rawPack({ packId: 'qc.demo.b', items: [{ itemId: 'X-1' }] })));
    assertEqual(store2.list().map((item) => item.packId), ['qc.demo.a'], '冲突包不得进入注册表');
  });

  await test('P5 开关：只动"生效指纹"，不动"内容指纹"；未知条目/未装载包各自报错', () => {
    const store = registry();
    store.load(rawPack({ items: [{ itemId: 'X-1' }, { itemId: 'X-2' }] }));
    const content = store.contentFingerprint();
    const effective = store.effectiveFingerprint();

    const summary = store.setItemEnabled('qc.demo.a', 'X-1', false);
    assertEqual(summary.enabledItemCount, 1, '关掉一条后启用数应减一');
    assertEqual(store.activeItemsOf('rule').map((entry) => entry.item.itemId), ['X-2'], '未启用的条目不应出现在生效集合里');
    assertEqual(store.contentFingerprint(), content, '开关**不属于包内容**：内容指纹必须不变');
    assert(store.effectiveFingerprint() !== effective, '生效指纹必须变 —— 否则"只是关了条规则"与"换了包"分不开');

    assertEqual(codeOf(() => store.setItemEnabled('qc.demo.a', 'X-9', false)), 'E_PACK_ITEM_UNKNOWN', '未知条目');
    assertEqual(codeOf(() => store.setItemEnabled('qc.missing', 'X-1', false)), 'E_PACK_NOT_LOADED', '未装载的包');

    store.setItemEnabled('qc.demo.a', 'X-1', true);
    assertEqual(store.effectiveFingerprint(), effective, '开回原状应回到原指纹（可复现）');
  });

  await test('P6 指纹与键序 / 装载顺序无关：同内容必得同指纹', () => {
    const first = registry();
    first.load(rawPack({ items: [{ itemId: 'X-1' }, { itemId: 'X-2' }] }));
    first.load(rawPack({ packId: 'qc.demo.b', items: [{ itemId: 'Y-1' }] }));

    const second = registry();
    /* 装载顺序相反、且包内元数据键序被打乱 */
    second.load({
      items: [{ itemId: 'Y-1' }],
      engineApi: 'qc-rule/1',
      name: '演示规则包',
      kind: 'rule',
      packId: 'qc.demo.b',
    });
    second.load(rawPack({ items: [{ itemId: 'X-1' }, { itemId: 'X-2' }] }));

    assertEqual(second.contentFingerprint(), first.contentFingerprint(), '同内容不同写入顺序应得同一指纹');
    assertEqual(second.list().map((item) => item.packId), ['qc.demo.a', 'qc.demo.b'], '列表按 packId 排序，顺序稳定');
  });

  await test('P7 归一化与深拷贝：enabled 补 true；外部对象改动不影响已装载的包；JSON 往返等价', () => {
    const store = registry();
    const source = rawPack({ items: [{ itemId: 'X-1' }] }) as { items: Array<Record<string, unknown>> };
    store.load(source);

    const loaded = store.get('qc.demo.a') as Pack;
    assertEqual(loaded.items[0]?.enabled, true, 'enabled 缺省应补成 true（运行时的包结构要确定）');

    /* 装载方事后改传入的对象，不得影响已装载的包 —— 否则"载的是哪一版"失去意义 */
    source.items[0]!.itemId = '被改掉了';
    assertEqual(store.get('qc.demo.a')?.items[0]?.itemId, 'X-1', '装载后应持有副本，不受外部对象影响');

    /* **结构级证明"包是数据不是代码"**：包里若含函数，JSON 往返会丢掉它，两者就不再相等 */
    const stored = store.get('qc.demo.a') as Pack;
    assertEqual(JSON.parse(JSON.stringify(stored)), stored, '包必须能被 JSON 无损往返（函数/类实例都会在这里暴露）');
    assertEqual(PACK_NOT_IN_DOCUMENT, true, '包不是文档内容，不进签名覆盖范围');
  });

  await test('P8 装载是原子的：类别专有校验失败时包一个字都不进注册表', () => {
    const store = registry();
    assertEqual(
      codeOf(() =>
        store.load(rawPack({ packId: 'qc.bad', items: [{ itemId: 'X-1' }] }), {
          validate: () => {
            throw Object.assign(new Error('谓词参数不合法'), { code: 'E_RULE_PARAM_INVALID' });
          },
        }),
      ),
      'E_RULE_PARAM_INVALID',
      '钩子抛错应原样透出（错误码是上层定位问题的唯一依据）',
    );
    assertEqual(store.list().length, 0, '校验失败后注册表必须是空的 —— 半个包比没有包更危险');
    assertEqual(store.contentFingerprint(), new PackRegistry(SUPPORTED).contentFingerprint(), '空注册表指纹应等于初始态');
  });

  process.exit(suite.report());
}

void main();
