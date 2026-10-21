import { TestSuite, assert, assertEqual } from '../testing/harness.ts';
import { openConfigFixture, sealedBlobOf, writeCorruptRow } from '../testing/config-fixture.ts';
import {
  CONTENT_LIMITS,
  ContentError,
  addContent,
  contentKeyOf,
  contentRefOf,
  contentUsageItemKeyOf,
  contentUsageKeyOf,
  describeContent,
  describeContentList,
  findSimilarContent,
  listContentFor,
  loadContent,
  loadContentUsage,
  markContentUsed,
  setContentPinned,
  patchContent,
  placeholdersOf,
  removeContent,
  saveContent,
  similarityOf,
  validateContentItems,
  type ContentScopeRef,
} from './content-store.ts';

const suite = new TestSuite('内容层自测（内容段落 / 常用语：作用域隔离、落库、指纹）', [
  '说明：内容层回答"这一段写什么"，与文书模板（结构层）、知识包（全院资产）是两件事。',
  'C1/C3 是防回退关键：私稿不能出现在别人的读路径上，读不出来不能当成"没存过"。',
]);

const test = (name: string, fn: () => void | Promise<void>): Promise<void> => suite.test(name, fn);

const codeOf = (fn: () => unknown): string => {
  try {
    fn();
    return 'OK';
  } catch (err) {
    return String((err as { code?: string }).code ?? `UNEXPECTED:${(err as Error).message}`);
  }
};

const PERSONAL_A: ContentScopeRef = { scope: 'personal', owner: 'DR_A' };
const PERSONAL_B: ContentScopeRef = { scope: 'personal', owner: 'DR_B' };
const DEPT: ContentScopeRef = { scope: 'dept', owner: 'DEPT_RESP' };
const HOSPITAL: ContentScopeRef = { scope: 'hospital' };

const ABDOMEN = {
  kind: 'content-paragraph' as const,
  name: '腹部查体（正常）',
  group: '查体/腹部',
  paragraphs: [
    '腹平软，无压痛、无反跳痛，未触及包块。',
    '肝脾肋下未及，Murphy 征阴性。',
    '肠鸣音 4 次/分，未闻及血管杂音。',
  ],
  anchorHint: '体格检查',
};

async function main(): Promise<void> {
  await test('C1 作用域隔离：一个人的私稿**不可能**出现在另一个人的读路径上', () => {
    const fixture = openConfigFixture({ prefix: 'l0-content-' });
    try {
      assertEqual(loadContent(fixture.kv, PERSONAL_A).source, 'empty', '没存过就是空（不编一套默认内容）');
      addContent(fixture.kv, PERSONAL_A, ABDOMEN, 'DR_A', { at: '2026-10-20T08:00:00.000Z' });

      const a = loadContent(fixture.kv, PERSONAL_A);
      assertEqual(a.source, 'store', '存过之后是 store');
      assertEqual(a.items.length, 1, '自己看得到');
      assertEqual(a.items[0].scope, 'personal', '作用域跟着行走');
      assertEqual(a.items[0].owner, 'DR_A', '归属记在条目上（审计要答"这是谁的"）');

      assertEqual(loadContent(fixture.kv, PERSONAL_B).items.length, 0, '别人的个人库里没有你的东西');
      assert(contentKeyOf(PERSONAL_A) !== contentKeyOf(PERSONAL_B), '两个人的键必须不同（同键就等于共用一份私稿）');
      assert(contentKeyOf(PERSONAL_A) !== contentKeyOf(HOSPITAL), '个人行与全院行必须是两行（不能混存）');
      assertEqual(codeOf(() => contentKeyOf({ scope: 'personal' })), 'E_CONTENT_INVALID', '个人库缺 owner 要当场报，不退回公共行');

      const blob = sealedBlobOf(fixture, contentKeyOf(PERSONAL_A));
      assertEqual(blob !== null && !blob.includes('腹平软'), true, '内容不得以明文落在库里');
    } finally {
      fixture.cleanup();
    }
  });

  await test('C2 校验：作用域混行、常用语多段、空内容、超长都要当场报', () => {
    const fixture = openConfigFixture({ prefix: 'l0-content-' });
    try {
      addContent(fixture.kv, PERSONAL_A, ABDOMEN, 'DR_A');
      const items = loadContent(fixture.kv, PERSONAL_A).items;

      assertEqual(
        codeOf(() => saveContent(fixture.kv, PERSONAL_A, [{ ...items[0], scope: 'hospital' }], 'DR_A')),
        'E_CONTENT_INVALID',
        '条目作用域与所在行不一致必须拒绝',
      );
      assertEqual(
        codeOf(() => addContent(fixture.kv, PERSONAL_A, { kind: 'phrase', name: '多行', paragraphs: '第一行\n第二行' }, 'DR_A')),
        'E_CONTENT_INVALID',
        '常用语是一行话：多行要建"内容段落"（两者落笔方式不同）',
      );
      assertEqual(
        codeOf(() => addContent(fixture.kv, PERSONAL_A, { kind: 'content-paragraph', name: '空的', paragraphs: ['   ', ''] }, 'DR_A')),
        'E_CONTENT_INVALID',
        '全空白的内容要报（插进去什么都不会发生）',
      );
      assertEqual(
        codeOf(() => addContent(fixture.kv, PERSONAL_A, { kind: 'phrase', name: '', paragraphs: '一句话' }, 'DR_A')),
        'E_CONTENT_INVALID',
        '名称空要报：它是清单里那一行',
      );
      assertEqual(
        codeOf(() => addContent(fixture.kv, PERSONAL_A, { kind: 'phrase', name: '太长', paragraphs: '字'.repeat(CONTENT_LIMITS.phraseChars + 1) }, 'DR_A')),
        'E_CONTENT_LIMIT',
        '常用语超过上限要报（这么长应该建成内容段落）',
      );
      assertEqual(
        codeOf(() => addContent(fixture.kv, PERSONAL_A, { kind: 'content-paragraph', name: '太多段', paragraphs: Array.from({ length: CONTENT_LIMITS.paragraphs + 1 }, (_v, i) => `第${i + 1}段`) }, 'DR_A')),
        'E_CONTENT_LIMIT',
        '段数超上限要报：一次插进去半份病历，人不会逐段核对',
      );

      const longOne = '患者一般情况可，'.repeat(200).slice(0, 1500);
      const longSaved = addContent(
        fixture.kv,
        PERSONAL_B,
        { kind: 'content-paragraph', name: '出院指导', paragraphs: [longOne] },
        'DR_B',
      );
      assertEqual(longSaved.item.paragraphs[0].length, 1500, '单段 1500 字要存得下（内容会很长）');
      const manyRows = addContent(
        fixture.kv,
        PERSONAL_B,
        { kind: 'content-paragraph', name: '查体全套', paragraphs: Array.from({ length: 30 }, (_v, i) => `第${i + 1}条查体所见。`) },
        'DR_B',
      );
      assertEqual(manyRows.item.paragraphs.length, 30, '30 段的一整套查体也要存得下');

      /* 常用语仍然是一行话：超过上限要提示改走"多段落"，而不是默默截断 */
      assertEqual(
        codeOf(() => addContent(fixture.kv, PERSONAL_B, { kind: 'phrase', name: '太长', paragraphs: '字'.repeat(CONTENT_LIMITS.phraseChars + 1) }, 'DR_B')),
        'E_CONTENT_LIMIT',
        '常用语超过一行话的上限要报（提示它按换行改成多段落）',
      );

      assertEqual(
        codeOf(() => saveContent(fixture.kv, PERSONAL_A, [items[0], { ...items[0] }], 'DR_A')),
        'E_CONTENT_INVALID',
        'id 重复要报',
      );
    } finally {
      fixture.cleanup();
    }
  });

  await test('C3 读不出来 ≠ 没存过：坏行与陌生版本都必须报错', () => {
    const fixture = openConfigFixture({ prefix: 'l0-content-' });
    try {
      addContent(fixture.kv, PERSONAL_A, ABDOMEN, 'DR_A');
      writeCorruptRow(fixture, contentKeyOf(PERSONAL_A));
      assertEqual(codeOf(() => loadContent(fixture.kv, PERSONAL_A)), 'E_CONTENT_INVALID', '解不开必须报，不许静默降级成"我的内容没了"');

      const fixture2 = openConfigFixture({ prefix: 'l0-content-' });
      try {
        fixture2.kv.write(contentKeyOf(PERSONAL_A), { version: 2, items: [], updatedAt: 'x', updatedBy: 'DR_A' });
        assertEqual(codeOf(() => loadContent(fixture2.kv, PERSONAL_A)), 'E_CONTENT_INVALID', '结构版本对不上要报');
      } finally {
        fixture2.cleanup();
      }
    } finally {
      fixture.cleanup();
    }
  });

  await test('C4 合并视图：个人 → 本科 → 全院；没有科室就只给两层；一行坏掉不连累其余', () => {
    const fixture = openConfigFixture({ prefix: 'l0-content-' });
    try {
      addContent(fixture.kv, PERSONAL_A, { kind: 'phrase', name: '我这里正常', paragraphs: '未诉特殊不适。' }, 'DR_A');
      addContent(fixture.kv, DEPT, { kind: 'content-paragraph', name: '呼吸科查体', paragraphs: ['双肺呼吸音清，未闻及干湿性啰音。'] }, 'admin');
      addContent(fixture.kv, HOSPITAL, { kind: 'content-paragraph', name: '通用告知', paragraphs: ['已向患者及家属交代病情，表示理解。'] }, 'admin');

      const all = listContentFor(fixture.kv, { actorId: 'DR_A', deptCode: 'DEPT_RESP' });
      assertEqual(all.items.length, 3, '三层都合并进来');
      assertEqual(all.items.map((item) => item.scope).join(','), 'personal,dept,hospital', '顺序：个人 → 本科 → 全院（先看到自己的）');
      assertEqual(all.errors.length, 0, '没有读失败的行');
      assertEqual(all.rows.length, 3, '三行各报一次（界面要说清"哪一层没读到"）');

      const noDept = listContentFor(fixture.kv, { actorId: 'DR_A' });
      assertEqual(noDept.items.length, 2, '就诊没有科室时不给科室那一层（不拿"没有科室"去匹配任何科室行）');
      assert(noDept.rows.every((row) => row.scope !== 'dept'), '连"科室行"都不出现，界面才不会以为本科室是空的');

      writeCorruptRow(fixture, contentKeyOf(HOSPITAL));
      const degraded = listContentFor(fixture.kv, { actorId: 'DR_A', deptCode: 'DEPT_RESP' });
      assertEqual(degraded.items.length, 2, '坏掉的只是全院那一行，个人与本科照旧');
      assertEqual(degraded.errors.length, 1, '错误必须上报（不吞）');
      const brokenRow = degraded.rows.find((row) => row.scope === 'hospital');
      assertEqual(brokenRow?.error === null ? 'null' : 'has-error', 'has-error', '行状态里要能看出是哪一层读坏了');

      const view = describeContentList(degraded) as { items: Array<{ ref: string }>; errors: string[] };
      assert(view.items[0].ref.startsWith('content:'), '视图带出处标识（插进病历后 evidence 用它）');
    } finally {
      fixture.cleanup();
    }
  });

  await test('C5 增改删：编号按类别各自走、kind 不给改、指纹随内容变', () => {
    const fixture = openConfigFixture({ prefix: 'l0-content-' });
    try {
      const first = addContent(fixture.kv, PERSONAL_A, ABDOMEN, 'DR_A', { at: '2026-10-20T08:00:00.000Z' });
      assertEqual(first.item.id, 'cp.1', '内容段落按 cp.N 编号');
      const second = addContent(fixture.kv, PERSONAL_A, { kind: 'phrase', name: '我这里正常', paragraphs: '未诉特殊不适。' }, 'DR_A');
      assertEqual(second.item.id, 'phr.1', '常用语按 phr.N 编号（两类各走各的，不抢号）');

      const refBefore = contentRefOf(second.loaded.items[0]);
      const patched = patchContent(fixture.kv, PERSONAL_A, 'cp.1', { paragraphs: ['腹平软，无压痛。'] }, 'DR_A', { at: '2026-10-20T09:00:00.000Z' });
      const refAfter = contentRefOf(patched.item);
      assert(refBefore !== refAfter, '改一个字，指纹就要变（"当时插进去的是哪一版"要答得出来）');
      assertEqual(patched.item.createdAt, '2026-10-20T08:00:00.000Z', '创建时间不动');
      assertEqual(patched.item.updatedAt, '2026-10-20T09:00:00.000Z', '修改时间要更新');
      assertEqual(patched.loaded.items.length, 2, '改一条不影响条数');

      assertEqual(
        codeOf(() => patchContent(fixture.kv, PERSONAL_A, 'cp.1', { kind: 'phrase' } as never, 'DR_A')),
        'E_CONTENT_INVALID',
        'kind 不在可改字段里（送来只会得到"没有要改的字段"）',
      );
      assertEqual(
        codeOf(() => patchContent(fixture.kv, PERSONAL_A, 'cp.999', { name: '不存在' }, 'DR_A')),
        'E_CONTENT_ITEM_NOT_FOUND',
        '改不存在的条目要报，而不是悄悄新建一条',
      );

      const afterRemove = removeContent(fixture.kv, PERSONAL_A, 'cp.1', 'DR_A');
      assertEqual(afterRemove.items.length, 1, '删掉就少一条');
      assertEqual(afterRemove.items[0].id, 'phr.1', '剩下的是另一条');
      assertEqual(
        codeOf(() => removeContent(fixture.kv, PERSONAL_A, 'cp.1', 'DR_A')),
        'E_CONTENT_ITEM_NOT_FOUND',
        '删两次要报（第二次什么也没删，不能算成功）',
      );
    } finally {
      fixture.cleanup();
    }
  });

  await test('C6 占位符与视图：方言与模板引擎一致，预览与段数现算', () => {
    const fixture = openConfigFixture({ prefix: 'l0-content-' });
    try {
      const created = addContent(
        fixture.kv,
        PERSONAL_A,
        {
          kind: 'content-paragraph',
          name: '入院记录开头',
          paragraphs: [
            '患者{{patient.nameMasked}}，{{patient.gender}}，因{{主诉}}入院。',
            '再次确认：{{patient.nameMasked}}。',
          ],
        },
        'DR_A',
      );
      assertEqual(
        placeholdersOf(created.item.paragraphs).join(','),
        'patient.nameMasked,patient.gender',
        '占位符去重保序，且只认与模板引擎同一套路径',
      );
      const view = describeContent(created.item);
      assertEqual(view.paragraphCount, 2, '段数现算');
      assert(view.preview.startsWith('患者'), '预览取第一段开头');
      assertEqual(view.placeholders.length, 2, '视图带占位符清单（界面据此提示"这一条要病人上下文"）');

      const patched = patchContent(fixture.kv, PERSONAL_A, created.item.id, { paragraphs: ['没有占位符的一段。'] }, 'DR_A');
      assertEqual(describeContent(patched.item).placeholders.length, 0, '占位符不落库，改完自然归零');
    } finally {
      fixture.cleanup();
    }
  });

  await test('C7 条数上限：一个作用域到顶就报，不静默丢新的', () => {
    const fixture = openConfigFixture({ prefix: 'l0-content-' });
    try {
      const full = Array.from({ length: CONTENT_LIMITS.itemsPerScope }, (_value, index) => ({
        id: `cp.${index + 1}`,
        kind: 'phrase' as const,
        scope: 'personal' as const,
        owner: 'DR_A',
        name: `第${index + 1}条`,
        paragraphs: ['一句话。'],
        createdAt: '2026-10-20T08:00:00.000Z',
        updatedAt: '2026-10-20T08:00:00.000Z',
        updatedBy: 'DR_A',
      }));
      saveContent(fixture.kv, PERSONAL_A, full, 'DR_A');
      assertEqual(loadContent(fixture.kv, PERSONAL_A).items.length, CONTENT_LIMITS.itemsPerScope, '到顶的这一份存得进');
      assertEqual(
        codeOf(() => addContent(fixture.kv, PERSONAL_A, { kind: 'phrase', name: '再多一条', paragraphs: '一句话。' }, 'DR_A')),
        'E_CONTENT_LIMIT',
        '到顶再加要报（静默丢新的比报错糟得多）',
      );
    } finally {
      fixture.cleanup();
    }
  });

  await test('C8 未知名错误码自检：内容层的错误都带 code', () => {
    assert(new ContentError('E_CONTENT_INVALID', 'x') instanceof Error, 'ContentError 是 Error 的子类');
    assertEqual(codeOf(() => validateContentItems({}, PERSONAL_A)), 'E_CONTENT_INVALID', '清单不是数组要报');
  });

  await test('C9 重名与相似：同名一律拒（清单靠名字认），内容相近给提示', () => {
    const fixture = openConfigFixture({ prefix: 'l0-content-' });
    try {
      addContent(
        fixture.kv,
        PERSONAL_A,
        { kind: 'content-paragraph', name: '腹部查体（正常）', paragraphs: ['腹平软，无压痛、无反跳痛，未触及包块。'] },
        'DR_A',
      );
      assertEqual(
        codeOf(() => addContent(fixture.kv, PERSONAL_A, { kind: 'content-paragraph', name: '腹部查体 (正常)', paragraphs: ['另一段。'] }, 'DR_A')),
        'E_CONTENT_DUPLICATE_NAME',
        '同名（只差标点/空格）要拒：清单里两条同名就说不清该带哪一条',
      );

      const second = addContent(fixture.kv, PERSONAL_A, { kind: 'content-paragraph', name: '胸部查体（正常）', paragraphs: ['双肺呼吸音清。'] }, 'DR_A');
      assertEqual(
        codeOf(() => patchContent(fixture.kv, PERSONAL_A, second.item.id, { name: '腹部查体（正常）' }, 'DR_A')),
        'E_CONTENT_DUPLICATE_NAME',
        '改名撞上已有名字也要拒',
      );
      assertEqual(
        codeOf(() => patchContent(fixture.kv, PERSONAL_A, 'cp.1', { name: '腹部查体（正常）' }, 'DR_A')),
        'OK',
        '把名字改成它原来的名字不算撞车（否则保存一次就得先改名）',
      );

      const items = loadContent(fixture.kv, PERSONAL_A).items;
      const close = findSimilarContent(items, {
        name: '腹部查体（成人）',
        paragraphs: ['腹平软，无压痛、无压痛，未触及包块。'],
      });
      assertEqual(close.exact, null, '名字不同就没有同名冲突');
      assert(close.similar.length >= 1, '内容相近要给提示（存两份一样的，之后自己也分不清）');
      assertEqual(close.similar[0].item.id, 'cp.1', '提示指向最像的那一条');
      assert(close.similar[0].score >= 0.6, `相似度应不低于阈值，实际 ${close.similar[0].score}`);

      const far = findSimilarContent(items, { name: '出院指导', paragraphs: ['出院后注意休息，一周后门诊复查血常规。'] });
      assertEqual(far.similar.length, 0, '不相似的不要凑数（提示宁少勿多，多了就成了噪音）');
      assertEqual(similarityOf('腹平软，无压痛', '腹平软 无压痛'), 1, '标点与空格不该影响比较');
      assertEqual(similarityOf('', '任何内容'), 0, '空串与任何内容的相似度是 0（不是 1）');
    } finally {
      fixture.cleanup();
    }
  });

  await test('C10 使用记录：最近用过的排前面，不改条目、不跨人、不串作用域', () => {
    const fixture = openConfigFixture({ prefix: 'l0-content-' });
    try {
      const first = addContent(
        fixture.kv,
        PERSONAL_A,
        { kind: 'phrase', name: 'A 腹部查体', paragraphs: '腹平软。' },
        'DR_A',
        { at: '2026-10-20T08:00:00.000Z' },
      );
      const second = addContent(
        fixture.kv,
        PERSONAL_A,
        { kind: 'phrase', name: 'B 胸部查体', paragraphs: '双肺呼吸音清。' },
        'DR_A',
        { at: '2026-10-20T08:01:00.000Z' },
      );
      assertEqual(first.item.id, 'phr.1', '前置：第一条是 phr.1');
      assertEqual(second.item.id, 'phr.2', '前置：第二条是 phr.2');
      assertEqual(
        listContentFor(fixture.kv, { actorId: 'DR_A' }).items.map((item) => item.id).join(','),
        'phr.1,phr.2',
        '没用过时按名字排（不是按存进去的顺序）',
      );

      markContentUsed(fixture.kv, 'DR_A', second.item, '2026-10-20T09:00:00.000Z');
      assertEqual(
        listContentFor(fixture.kv, { actorId: 'DR_A' }).items.map((item) => item.id).join(','),
        'phr.2,phr.1',
        '刚用过的排到最前（下次打开清单第一条就是它）',
      );

      const stored = loadContent(fixture.kv, PERSONAL_A).items.find((item) => item.id === 'phr.2');
      assertEqual(stored?.updatedAt, second.item.updatedAt, '使用不改条目的修改时间');
      assertEqual(
        stored ? contentRefOf(stored) : 'MISSING',
        contentRefOf(second.item),
        '使用不改内容指纹（留痕里的出处仍指同一版）',
      );

      addContent(fixture.kv, PERSONAL_B, { kind: 'phrase', name: 'A 腹部查体', paragraphs: '腹平软。' }, 'DR_B');
      addContent(fixture.kv, PERSONAL_B, { kind: 'phrase', name: 'B 胸部查体', paragraphs: '双肺呼吸音清。' }, 'DR_B');
      assertEqual(
        listContentFor(fixture.kv, { actorId: 'DR_B' }).items.map((item) => item.id).join(','),
        'phr.1,phr.2',
        '别人的使用记录不影响我的顺序',
      );

      addContent(fixture.kv, DEPT, { kind: 'phrase', name: 'A 科室常用', paragraphs: '科室一句。' }, 'admin');
      addContent(fixture.kv, DEPT, { kind: 'phrase', name: 'B 科室常用', paragraphs: '科室二句。' }, 'admin');
      const merged = listContentFor(fixture.kv, { actorId: 'DR_A', deptCode: 'DEPT_RESP' });
      assertEqual(
        merged.items.map((item) => `${item.scope}:${item.id}`).join(','),
        'personal:phr.2,personal:phr.1,dept:phr.1,dept:phr.2',
        '使用记录按"作用域 + owner + id"区分，不串作用域',
      );

      writeCorruptRow(fixture, contentUsageKeyOf('DR_A'));
      const degraded = listContentFor(fixture.kv, { actorId: 'DR_A' });
      assertEqual(degraded.items.length, 2, '使用记录坏了不影响清单本身');
      assert(typeof degraded.usageError === 'string', '要能说清"排序为什么退化了"');
      assertEqual(degraded.items.map((item) => item.id).join(','), 'phr.1,phr.2', '退化后回到按名字排');
    } finally {
      fixture.cleanup();
    }
  });

  await test('C11 触发词：同层唯一、只认短码字符、能改能清', () => {
    const fixture = openConfigFixture({ prefix: 'l0-content-' });
    try {
      const created = addContent(
        fixture.kv,
        PERSONAL_A,
        { kind: 'phrase', name: '腹部查体', paragraphs: '腹平软。', trigger: ' FB ' },
        'DR_A',
      );
      assertEqual(created.item.trigger, 'fb', '统一小写、去掉首尾空白');
      assertEqual(describeContent(created.item).trigger, 'fb', '视图带触发词（界面显示成 ;fb）');

      assertEqual(
        codeOf(() => addContent(fixture.kv, PERSONAL_A, { kind: 'phrase', name: '另一条', paragraphs: '另一句。', trigger: 'Fb' }, 'DR_A')),
        'E_CONTENT_DUPLICATE_TRIGGER',
        '同层重复要拒：打出来只能说清一条（大小写不算区分）',
      );
      assertEqual(
        codeOf(() => addContent(fixture.kv, PERSONAL_A, { kind: 'phrase', name: '带空格', paragraphs: '一句。', trigger: 'a b' }, 'DR_A')),
        'E_CONTENT_INVALID',
        '触发词里不能有空格：空格正是"打完了"的判据',
      );
      assertEqual(
        codeOf(() => addContent(fixture.kv, PERSONAL_A, { kind: 'phrase', name: '太长', paragraphs: '一句。', trigger: 'a'.repeat(CONTENT_LIMITS.triggerChars + 1) }, 'DR_A')),
        'E_CONTENT_INVALID',
        '触发词超过上限要报（再长就不比打名字快了）',
      );

      const dept = addContent(
        fixture.kv,
        DEPT,
        { kind: 'phrase', name: '科室腹部查体', paragraphs: '腹软。', trigger: 'fb' },
        'admin',
      );
      assertEqual(dept.item.trigger, 'fb', '另一层可以有同名触发词');
      const merged = listContentFor(fixture.kv, { actorId: 'DR_A', deptCode: 'DEPT_RESP' });
      assertEqual(merged.items.find((item) => item.trigger === 'fb')?.scope, 'personal', '同名时个人那条排在最前（触发展开取它）');

      const second = addContent(fixture.kv, PERSONAL_A, { kind: 'phrase', name: '胸部查体', paragraphs: '双肺清。' }, 'DR_A');
      assertEqual(
        codeOf(() => patchContent(fixture.kv, PERSONAL_A, second.item.id, { trigger: 'fb' }, 'DR_A')),
        'E_CONTENT_DUPLICATE_TRIGGER',
        '改成一个已被占用的触发词也要拒',
      );
      const patched = patchContent(fixture.kv, PERSONAL_A, second.item.id, { trigger: 'xb' }, 'DR_A');
      assertEqual(patched.item.trigger, 'xb', '能改成另一个短码');
      const cleared = patchContent(fixture.kv, PERSONAL_A, second.item.id, { trigger: null }, 'DR_A');
      assertEqual(cleared.item.trigger, undefined, '能给清空（不是每条都需要触发词）');

      const items = loadContent(fixture.kv, PERSONAL_A).items;
      assertEqual(
        codeOf(() => saveContent(fixture.kv, PERSONAL_A, items.map((item) => ({ ...item, trigger: 'dup' })), 'DR_A')),
        'E_CONTENT_DUPLICATE_TRIGGER',
        '落库里两条同一个触发词，读取时就要报',
      );
    } finally {
      fixture.cleanup();
    }
  });

  await test('C12 置顶：钉在最前、不改条目、用过不摘、取消后回到按最近', () => {
    const fixture = openConfigFixture({ prefix: 'l0-content-' });
    try {
      const first = addContent(fixture.kv, PERSONAL_A, { kind: 'phrase', name: 'A 腹部查体', paragraphs: '腹平软。' }, 'DR_A');
      const second = addContent(fixture.kv, PERSONAL_A, { kind: 'phrase', name: 'B 胸部查体', paragraphs: '双肺清。' }, 'DR_A');
      markContentUsed(fixture.kv, 'DR_A', second.item, '2026-10-20T10:00:00.000Z');
      assertEqual(
        listContentFor(fixture.kv, { actorId: 'DR_A' }).items.map((item) => item.id).join(','),
        'phr.2,phr.1',
        '前置：刚用过的在前',
      );

      setContentPinned(fixture.kv, 'DR_A', first.item, true);
      const pinnedList = listContentFor(fixture.kv, { actorId: 'DR_A' });
      assertEqual(pinnedList.items.map((item) => item.id).join(','), 'phr.1,phr.2', '置顶要压过"刚用过"');
      assertEqual(pinnedList.pinnedKeys.length, 1, '视图要能标出哪一条被钉住');
      const view = (describeContentList(pinnedList).items as Array<Record<string, unknown>>)[0];
      assertEqual(view.pinned, true, '条目视图带 pinned（只读字段）');

      markContentUsed(fixture.kv, 'DR_A', first.item, '2026-10-20T11:00:00.000Z');
      assertEqual(
        loadContentUsage(fixture.kv, 'DR_A').usage[contentUsageItemKeyOf(first.item)].pinned,
        true,
        '带入一次后仍是置顶',
      );
      const stored = loadContent(fixture.kv, PERSONAL_A).items.find((item) => item.id === first.item.id);
      assertEqual(stored?.updatedAt, first.item.updatedAt, '置顶与使用都不改条目的修改时间');
      assertEqual(
        stored ? contentRefOf(stored) : 'MISSING',
        contentRefOf(first.item),
        '置顶与使用都不改内容指纹',
      );

      assertEqual(listContentFor(fixture.kv, { actorId: 'DR_B' }).pinnedKeys.length, 0, '置顶不跨人');

      setContentPinned(fixture.kv, 'DR_A', first.item, false);
      assertEqual(
        listContentFor(fixture.kv, { actorId: 'DR_A' }).items.map((item) => item.id).join(','),
        'phr.1,phr.2',
        '取消置顶后回到"最近用过"的顺序（A 刚用过 11:00）',
      );

      const third = addContent(fixture.kv, PERSONAL_A, { kind: 'phrase', name: 'C 腹部包块', paragraphs: '未触及。' }, 'DR_A');
      setContentPinned(fixture.kv, 'DR_A', third.item, true);
      assertEqual(
        listContentFor(fixture.kv, { actorId: 'DR_A' }).items.map((item) => item.id).join(','),
        'phr.3,phr.1,phr.2',
        '只置顶、没用过的条目同样钉在最前',
      );
      setContentPinned(fixture.kv, 'DR_A', third.item, false);
      assertEqual(
        loadContentUsage(fixture.kv, 'DR_A').usage[contentUsageItemKeyOf(third.item)],
        undefined,
        '取消置顶后不留空壳记录',
      );
      assertEqual(
        listContentFor(fixture.kv, { actorId: 'DR_A' }).items.map((item) => item.id).join(','),
        'phr.1,phr.2,phr.3',
        '撤下后回到"最近用过 → 分组 / 名字"的顺序',
      );
    } finally {
      fixture.cleanup();
    }
  });

  process.exit(suite.report());
}

void main();
