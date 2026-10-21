import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TestSuite, assert, assertEqual } from '../testing/harness.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

const suite = new TestSuite('内容层落笔自测（带入 / 空段优先填 / 常用语行内插 / 脱敏关卡）', [
  '说明：起一份真服务跑，因为落点取决于正文当时的段落结构。',
  'I2（空的段落优先填）与 I5（另存必须脱敏）是防回退关键。',
]);

const PORT = Number(process.env.L0_CONTENT_TEST_PORT ?? 8912);
const BASE = `http://127.0.0.1:${PORT}`;
const runtimeDir = mkdtempSync(join(tmpdir(), 'l0-content-insert-'));
let child: ReturnType<typeof spawn> | null = null;

interface ApiResponse {
  ok?: boolean;
  code?: string;
  message?: string;
  data?: Record<string, unknown>;
  state?: Record<string, unknown>;
  items?: Array<Record<string, unknown>>;
}

async function post(path: string, body: Record<string, unknown> = {}): Promise<ApiResponse> {
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (await response.json()) as ApiResponse;
}

async function stateOf(): Promise<Record<string, unknown>> {
  const response = await fetch(`${BASE}/api/state`);
  const payload = (await response.json()) as { state?: Record<string, unknown> };
  return payload.state ?? {};
}

function itemsOf(state: Record<string, unknown>): Array<Record<string, unknown>> {
  const items = state.items;
  return Array.isArray(items) ? (items as Array<Record<string, unknown>>) : [];
}

async function waitReady(): Promise<boolean> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(`${BASE}/api/state`);
      if (response.ok) return true;
    } catch {
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function main(): Promise<void> {
  child = spawn(process.execPath, ['src/demo/demo-server.ts', '--port', String(PORT)], {
    cwd: ROOT,
    env: { ...process.env, L0_RUNTIME_DIR: runtimeDir },
    stdio: 'pipe',
  });
  /* 输出必须有人接：管道缓冲写满之后子进程会卡在 write 上，症状是"服务起来了但一会儿就不动了" */
  child.stdout?.on('data', () => {});
  child.stderr?.on('data', () => {});

  try {
    assert(await waitReady(), `演示服务没有在 ${PORT} 端口起来`);

    const initial = await stateOf();
    const anchor = itemsOf(initial).find((item) => item.kind === 'text' && String(item.text ?? '').trim() !== '');
    assert(Boolean(anchor), '演示病历里应有一段有字的正文（后续落点都靠它）');
    const anchorId = String(anchor?.id ?? '');
    const patient = (initial.patient ?? {}) as Record<string, unknown>;
    const nameMasked = String(patient.nameMasked ?? '');

    await suite.test('I1 内容段落：锚点有字 → 在它之后新起段落，来源是"人工"而不是"导入"', async () => {
      const created = await post('/api/content-create', {
        kind: 'content-paragraph',
        name: '腹部查体（正常）',
        group: '查体/腹部',
        paragraphs: ['腹平软，无压痛、无反跳痛。', '肝脾肋下未及，Murphy 征阴性。'],
        anchorHint: '体格检查',
      });
      assertEqual(created.ok, true, `创建内容段落：${created.message ?? ''}`);
      assertEqual(created.data?.scope, 'personal', '医生自己建的就是"我的"那一档');

      const inserted = await post('/api/content-insert', { itemId: 'cp.1', nodeId: anchorId });
      assertEqual(inserted.ok, true, `带入内容段落：${inserted.message ?? ''}`);
      const createdIds = (inserted.data?.created ?? []) as string[];
      assertEqual(createdIds.length, 2, '两段内容就新起两段');
      assertEqual(((inserted.data?.filled ?? []) as string[]).length, 0, '锚点有字，不填空段');

      const nodes = itemsOf(await stateOf()).filter((item) => createdIds.includes(String(item.id)));
      assertEqual(nodes.length, 2, '两段都真的落进了正文');
      assertEqual(String(nodes[0]?.text ?? ''), '腹平软，无压痛、无反跳痛。', '第一段文字对得上');
      assertEqual(nodes.every((node) => node.origin === 'human'), true, '来源必须是"人工"：标 imported 会被签章门拦住，标 ai 是把人的字算成模型产出');
      assertEqual(nodes.every((node) => node.humanConfirmed === true), true, '套用即认可（医生亲手选的，没有第二个人要它再确认）');
      assert(nodes.every((node) => node.keyContent !== true), '内容层不产关键内容标记（不能靠自带标记绕过核对门）');
    });

    await suite.test('I2 空段优先填：光标停在空段里就填它，不另起一张白纸', async () => {
      const blank = await post('/api/insert-paragraph', { nodeId: anchorId });
      assertEqual(blank.ok, true, '前置：能插出一个空段落');
      const blankId = String(blank.data?.textNodeId ?? '');
      assert(blankId !== '', '空段落的文本节点 id 要能拿到');

      await post('/api/content-create', { kind: 'content-paragraph', name: '一句话', paragraphs: ['双肺呼吸音清，未闻及干湿性啰音。'] });
      const filled = await post('/api/content-insert', { itemId: 'cp.2', nodeId: blankId });
      assertEqual(filled.ok, true, `带入：${filled.message ?? ''}`);
      assertEqual(((filled.data?.filled ?? []) as string[]).length, 1, '空的段落优先填');
      assertEqual(((filled.data?.created ?? []) as string[]).length, 0, '还够填，就不新起段落');

      const blankNode = itemsOf(await stateOf()).find((item) => item.id === blankId);
      assert(Boolean(blankNode), '原来那个空段落的节点还在（没有删了重建：节点 id 一变，回填与引用就断了）');
      assertEqual(String(blankNode?.text ?? ''), '双肺呼吸音清，未闻及干湿性啰音。', '文字填进了原来那一格');
    });

    await suite.test('I3 常用语：插进当前这一句、不新增段落；不给光标就拒', async () => {
      await post('/api/content-create', { kind: 'phrase', name: '我这里正常', paragraphs: '未诉特殊不适。' });
      const refused = await post('/api/content-insert', { itemId: 'phr.1', nodeId: anchorId });
      assertEqual(refused.ok, false, '常用语不给光标必须拒（否则它会变成新的一段，而那不是常用语）');
      assertEqual(refused.code, 'E_CONTENT_INVALID', '拒绝的理由要能分辨：是参数问题，不是权限问题');

      const before = itemsOf(await stateOf()).length;
      const original = String(anchor?.text ?? '');
      const inline = await post('/api/content-insert', { itemId: 'phr.1', nodeId: anchorId, start: 2 });
      assertEqual(inline.ok, true, `行内插入：${inline.message ?? ''}`);
      assertEqual(((inline.data?.inline ?? {}) as Record<string, unknown>).nodeId, anchorId, '就落在光标那个文本节点里');

      const after = itemsOf(await stateOf());
      assertEqual(after.length, before, '常用语不新增任何节点（新起段落就不是"插一句"了）');
      const anchorNode = after.find((item) => item.id === anchorId);
      const merged = String(anchorNode?.text ?? '');
      assertEqual(merged, `${original.slice(0, 2)}；未诉特殊不适。${original.slice(2)}`, '字插在光标处，且与原文之间有分隔号');
    });

    await suite.test('I4 占位符：能取值的由上下文填上，取不到的原样保留并告警', async () => {
      await post('/api/content-create', {
        kind: 'content-paragraph',
        name: '带占位符',
        paragraphs: ['患者{{patient.nameMasked}}，{{unknown.path}}。'],
      });
      const inserted = await post('/api/content-insert', { itemId: 'cp.3', nodeId: anchorId });
      assertEqual(inserted.ok, true, `带入：${inserted.message ?? ''}`);
      const warnings = (inserted.data?.warnings ?? []) as string[];
      assert(warnings.length >= 1, '取不到的占位符必须告警（不告警就等于悄悄改了内容）');
      const createdId = String(((inserted.data?.created ?? []) as string[])[0] ?? '');
      const node = itemsOf(await stateOf()).find((item) => item.id === createdId);
      const text = String(node?.text ?? '');
      assert(text.includes('{{unknown.path}}'), '取不到的原样保留（不猜空串，否则"没填"会变成"病人没有"）');
      if (nameMasked !== '') assert(text.includes(nameMasked), '能取值的占位符由上下文填上（姓名换成本次就诊的姓名）');
    });

    await suite.test('I5 从病历另存：患者标识换成占位符；残余身份信息一律拦住', async () => {
      const phiParagraph = await post('/api/insert-paragraph', { nodeId: anchorId });
      const phiId = String(phiParagraph.data?.textNodeId ?? '');
      await post('/api/edit', { nodeId: phiId, text: '患者本人身份证 11010119900307123X 已核对。' });
      const blocked = await post('/api/content-save-from-doc', { nodeId: phiId, kind: 'content-paragraph', name: '核对话术' });
      assertEqual(blocked.ok, false, '带身份证号的一段不能存成模板（存了就会带进下一个病人）');
      assertEqual(blocked.code, 'E_CONTENT_PHI', '码要能分辨：这是脱敏关卡，不是格式错误');
      assert(String(blocked.message ?? '').includes('占位符'), '要告诉人怎么办（改成占位符），而不只是"不行"');

      assert(nameMasked !== '', '演示病历应有脱敏后的患者姓名（否则这条测不出替换）');
      const nameParagraph = await post('/api/insert-paragraph', { nodeId: anchorId });
      const nameId = String(nameParagraph.data?.textNodeId ?? '');
      await post('/api/edit', { nodeId: nameId, text: `患者${nameMasked}今日神清，精神可。` });
      const saved = await post('/api/content-save-from-doc', { nodeId: nameId, kind: 'content-paragraph', name: '神志描述' });
      assertEqual(saved.ok, true, `另存：${saved.message ?? ''}`);
      const replaced = (saved.data?.replaced ?? []) as string[];
      assert(replaced.includes('patient.nameMasked'), '要说明哪几处换成了占位符');
      const item = (saved.data?.item ?? {}) as Record<string, unknown>;
      const paragraphs = (item.paragraphs ?? []) as string[];
      assertEqual(item.scope, 'personal', '另存进去的是"我的"');
      assert(String(paragraphs[0] ?? '').includes('{{patient.nameMasked}}'), '姓名换成了占位符（否则下一个病人会看到这一个病人的名字）');
      assert(!String(paragraphs[0] ?? '').includes(nameMasked), '原文里的姓名不得留在模板里');
    });

    await suite.test('I6 作用域与归属：科室级要共用资产权限；引用不存在或已删的条目要报', async () => {
      const deptAttempt = await post('/api/content-create', {
        scope: 'dept',
        deptCode: 'DEPT_RESP',
        kind: 'phrase',
        name: '科室级',
        paragraphs: '一句话。',
      });
      assertEqual(deptAttempt.ok, false, '科室级 / 全院级是共用资产：没有那份权限就建不了（否则一条能改全科的病历）');

      const removed = await post('/api/content-delete', { itemId: 'phr.1' });
      assertEqual(removed.ok, true, '删自己的条目');
      const missing = await post('/api/content-insert', { itemId: 'phr.1', nodeId: anchorId, start: 0 });
      assertEqual(missing.ok, false, '删掉之后不能再被引用');
      assertEqual(missing.code, 'E_CONTENT_ITEM_NOT_FOUND', '码要能分辨：条目没了，不是参数错');

      const dup = await post('/api/content-similar', { name: '腹部查体（正常）', paragraphs: ['随便一段。'] });
      assertEqual(dup.ok, true, '相似查询要能跑');
      assertEqual(((dup.data?.exact ?? null) as Record<string, unknown> | null)?.name, '腹部查体（正常）', '同名要被认出来（保存会被拒）');
      const near = await post('/api/content-similar', {
        name: '腹部查体（成人正常）',
        paragraphs: ['腹平软，无压痛、无反跳痛，未触及包块。'],
      });
      assert((((near.data?.similar ?? []) as unknown[]).length) >= 1, '内容相近要给提示');
      const far = await post('/api/content-similar', { name: '出院指导', paragraphs: ['出院后注意休息，一周后复查。'] });
      assertEqual(((far.data?.similar ?? []) as unknown[]).length, 0, '不相似的不凑数');

      const listed = await post('/api/content-list', {});
      assertEqual(listed.ok, true, '清单照常可读');
      assert(!((listed.data?.items ?? []) as Array<Record<string, unknown>>).some((item) => item.id === 'phr.1'), '删掉的不在清单里');
      assertEqual(((listed.data?.errors ?? []) as string[]).length, 0, '没有读失败的行');
    });

    await suite.test('I7 用过的排前面：清单顺序跟着"刚带入过"走，排序只在服务端', async () => {
      const createdA = await post('/api/content-create', { kind: 'phrase', name: 'A 常用语', paragraphs: '甲。' });
      const createdB = await post('/api/content-create', { kind: 'phrase', name: 'B 常用语', paragraphs: '乙。' });
      const idA = String(((createdA.data?.item ?? {}) as Record<string, unknown>).id ?? '');
      const idB = String(((createdB.data?.item ?? {}) as Record<string, unknown>).id ?? '');
      assert(idA !== '' && idB !== '', '两条常用语都建成了（id 由服务端给，不在这里假设编号）');

      const ids = async (): Promise<string[]> => {
        const listed = await post('/api/content-list', {});
        return ((listed.data?.items ?? []) as Array<Record<string, unknown>>).map((item) => String(item.id));
      };
      const before = await ids();
      assert(before.includes(idA) && before.includes(idB), '两条都在清单里');
      assert(before.indexOf(idA) < before.indexOf(idB), '两条都没用过时按名字排（A 在 B 前）');

      const inserted = await post('/api/content-insert', { itemId: idB, nodeId: anchorId, start: 0 });
      assertEqual(inserted.ok, true, `插入 B：${inserted.message ?? ''}`);

      const after = await ids();
      assert(after.indexOf(idB) < after.indexOf(idA), '刚带入过的那条要排到前面（下次 Ctrl+K 第一条就是它）');
    });

    await suite.test('I8 触发词展开：`;fb` 整段换掉，且不留下空段落', async () => {
      const created = await post('/api/content-create', {
        kind: 'content-paragraph',
        name: '触发词内容',
        paragraphs: ['第一段由触发词带入。', '第二段同样带入。'],
        trigger: 'fb',
      });
      assertEqual(created.ok, true, `建带触发词的条目：${created.message ?? ''}`);
      const itemId = String(((created.data?.item ?? {}) as Record<string, unknown>).id ?? '');
      assert(itemId !== '', '条目 id 由服务端给');

      const blank = await post('/api/insert-paragraph', { nodeId: anchorId });
      const textId = String(blank.data?.textNodeId ?? '');
      await post('/api/edit', { nodeId: textId, text: ';fb' });

      const expanded = await post('/api/content-insert', {
        itemId,
        nodeId: textId,
        replaceStart: 0,
        replaceEnd: 3,
      });
      assertEqual(expanded.ok, true, `触发词展开：${expanded.message ?? ''}`);
      assertEqual(expanded.data?.triggerExpanded, true, '响应要说明这是触发词展开（界面据此改回执）');
      const filled = (expanded.data?.filled ?? []) as string[];
      assertEqual(filled[0], textId, '原来那一格被填上（不另起一个空段）');

      const nodes = itemsOf(await stateOf());
      const first = nodes.find((node) => node.id === textId);
      assertEqual(String(first?.text ?? ''), '第一段由触发词带入。', '`;fb` 被整段换掉，原文不留');
      assertEqual(
        nodes.some((node) => String(node.text ?? '').includes('第二段同样带入。')),
        true,
        '第二段也落进来了',
      );

      const bad = await post('/api/content-insert', {
        itemId,
        nodeId: textId,
        replaceStart: 5,
        replaceEnd: 2,
      });
      assertEqual(bad.ok, false, 'end < start 的区间要拒');
      assertEqual(bad.code, 'E_CONTENT_INVALID', '拒绝理由要能分辨（是区间问题）');
    });

    await suite.test('I9 整章另存：一次收齐一章的每一段，PHI 仍拦在库外', async () => {
      const dirty = itemsOf(await stateOf()).filter((node) => String(node.text ?? '').includes('11010119900307123X'));
      for (const node of dirty) {
        await post('/api/edit', { nodeId: String(node.id), text: '身份证号已核对。' });
      }

      const first = await post('/api/insert-paragraph', { nodeId: anchorId });
      const firstId = String(first.data?.textNodeId ?? '');
      await post('/api/edit', { nodeId: firstId, text: '甲段：一般情况可。' });
      const second = await post('/api/insert-paragraph', { nodeId: anchorId });
      const secondId = String(second.data?.textNodeId ?? '');
      await post('/api/edit', { nodeId: secondId, text: '乙段：双肺呼吸音清。' });

      const saved = await post('/api/content-save-from-doc', {
        nodeId: anchorId,
        kind: 'content-paragraph',
        name: '整章另存（甲）',
        source: 'section',
      });
      assertEqual(saved.ok, true, `整章另存：${saved.message ?? ''}`);
      const item = (saved.data?.item ?? {}) as Record<string, unknown>;
      const paragraphs = (item.paragraphs ?? []) as string[];
      assert(paragraphs.length >= 2, `整章应收下多段，实际 ${paragraphs.length}`);
      assert(paragraphs.some((text) => text.includes('甲段')), '甲段落进来了');
      assert(paragraphs.some((text) => text.includes('乙段')), '乙段落进来了');
      assertEqual(saved.data?.source, 'section', '响应要说明这是整章另存');
      assert(String(item.anchorHint ?? '') !== '', '建议落点记成章名（插入时提示"通常写在哪儿"）');

      await post('/api/edit', { nodeId: firstId, text: '患者本人身份证 11010119900307123X 已核对。' });
      const blocked = await post('/api/content-save-from-doc', {
        nodeId: anchorId,
        kind: 'content-paragraph',
        name: '整章另存（乙）',
        source: 'section',
      });
      assertEqual(blocked.ok, false, '带身份证号的一章不能存成模板');
      assertEqual(blocked.code, 'E_CONTENT_PHI', '码要能分辨：这是脱敏关卡，不是格式错误');
      assert(String(blocked.message ?? '').includes('第'), '多段时提示要带段号（不然得整章重读）');
    });

    await suite.test('I10 置顶：只改自己的顺序，取消后回到"最近用过"', async () => {
      const createdA = await post('/api/content-create', { kind: 'phrase', name: 'A 置顶甲', paragraphs: '甲。' });
      const createdB = await post('/api/content-create', { kind: 'phrase', name: 'B 置顶乙', paragraphs: '乙。' });
      const idA = String(((createdA.data?.item ?? {}) as Record<string, unknown>).id ?? '');
      const idB = String(((createdB.data?.item ?? {}) as Record<string, unknown>).id ?? '');
      assert(idA !== '' && idB !== '', '两条都建成了');

      const listed = async (): Promise<Array<Record<string, unknown>>> => {
        const result = await post('/api/content-list', {});
        return (result.data?.items ?? []) as Array<Record<string, unknown>>;
      };

      await post('/api/content-insert', { itemId: idB, nodeId: anchorId, start: 0 });
      const before = await listed();
      assert(
        before.findIndex((item) => item.id === idB) < before.findIndex((item) => item.id === idA),
        '前置：刚带入过的 B 排在 A 前',
      );

      const pinned = await post('/api/content-pin', { itemId: idA, pinned: true });
      assertEqual(pinned.ok, true, `置顶：${pinned.message ?? ''}`);
      const afterPin = await listed();
      assert(
        afterPin.findIndex((item) => item.id === idA) < afterPin.findIndex((item) => item.id === idB),
        '置顶要压过"最近用过"（每天必用不能因为昨天带了别的就被挤下去）',
      );
      assertEqual(afterPin.find((item) => item.id === idA)?.pinned, true, '清单视图带 pinned');

      const unpinned = await post('/api/content-pin', { itemId: idA, pinned: false });
      assertEqual(unpinned.ok, true, '取消置顶');
      const afterUnpin = await listed();
      assert(
        afterUnpin.findIndex((item) => item.id === idB) < afterUnpin.findIndex((item) => item.id === idA),
        '取消后回到"最近用过"的顺序',
      );

      const missing = await post('/api/content-pin', { itemId: 'phr.999', pinned: true });
      assertEqual(missing.code, 'E_CONTENT_ITEM_NOT_FOUND', '不在可见范围里的条目不能被置顶');

      const bad = await post('/api/content-pin', { itemId: idA });
      assertEqual(bad.code, 'E_CONTENT_INVALID', 'pinned 必须是布尔值（不猜"没给就是要置顶"）');
    });

    await suite.test('I11 只存选中那一截：区间必须落在同一段，脱敏与 PHI 关卡照旧', async () => {
      const created = await post('/api/insert-paragraph', { nodeId: anchorId });
      const textId = String(created.data?.textNodeId ?? '');
      const sentence = '甲段：腹平软，无压痛。乙段：双肺呼吸音清。';
      await post('/api/edit', { nodeId: textId, text: sentence });
      const start = sentence.indexOf('腹');
      const end = sentence.indexOf('。', start) + 1;

      const saved = await post('/api/content-save-from-doc', {
        nodeId: textId,
        kind: 'phrase',
        name: '选区片段',
        start,
        end,
      });
      assertEqual(saved.ok, true, `存选区：${saved.message ?? ''}`);
      const item = (saved.data?.item ?? {}) as Record<string, unknown>;
      const paragraphs = (item.paragraphs ?? []) as string[];
      assertEqual(paragraphs[0], '腹平软，无压痛。', '只存选中的那一截，前后文不跟着进库');
      assertEqual(
        (((saved.data?.selection ?? {}) as Record<string, unknown>).start),
        start,
        '回执要带区间（留痕里能说清存的是哪一截）',
      );

      const reversed = await post('/api/content-save-from-doc', { nodeId: textId, kind: 'phrase', name: 'x', start: 8, end: 3 });
      assertEqual(reversed.code, 'E_CONTENT_INVALID', 'end < start 要拒');

      const beyond = await post('/api/content-save-from-doc', { nodeId: textId, kind: 'phrase', name: 'y', start: 0, end: sentence.length + 5 });
      assertEqual(beyond.code, 'E_CONTENT_INVALID', '越过段尾要拒（不悄悄截断）');

      const empty = await post('/api/content-save-from-doc', { nodeId: textId, kind: 'phrase', name: 'z', start: 3, end: 3 });
      assertEqual(empty.code, 'E_CONTENT_INVALID', '空选区要拒');

      /* 只选身份证号也要被拦：选区不是"合法脱敏通道" */
      const dirty = '身份证 11010119900307123X 已核。';
      await post('/api/edit', { nodeId: textId, text: dirty });
      const phi = await post('/api/content-save-from-doc', {
        nodeId: textId,
        kind: 'phrase',
        name: '选区身份',
        start: dirty.indexOf('1101'),
        end: dirty.indexOf('1101') + 18,
      });
      assertEqual(phi.code, 'E_CONTENT_PHI', '选中的是身份信息就要拦');

      const mixed = await post('/api/content-save-from-doc', {
        nodeId: textId,
        kind: 'content-paragraph',
        name: '整章带选区',
        source: 'section',
        start: 0,
        end: 2,
      });
      assertEqual(mixed.code, 'E_CONTENT_INVALID', '整章另存不接受选区');
    });

    await suite.test('I12 选区润色：只返回选中那一截的候选，不落笔', async () => {
      const created = await post('/api/insert-paragraph', { nodeId: anchorId });
      const textId = String(created.data?.textNodeId ?? '');
      const sentence = '甲  乙  丙。';
      await post('/api/edit', { nodeId: textId, text: sentence });

      const polished = await post('/api/polish-selection', { nodeId: textId, start: 0, end: sentence.length });
      assertEqual(polished.ok, true, `润色：${polished.message ?? ''}`);
      const data = (polished.data ?? {}) as Record<string, unknown>;
      assertEqual(data.before, sentence, '回执带原文选区');
      assertEqual(data.after, '甲 乙 丙。', '只规范化选中那一截（多余空白收成一个）');
      assertEqual(data.fullText, '甲 乙 丙。', '整段新文本由服务端拼回（前后文原样）');
      assertEqual(typeof data.confidence, 'number', '回执带置信度（界面要显示）');

      const afterPolish = itemsOf(await stateOf()).find((node) => node.id === textId);
      assertEqual(String(afterPolish?.text ?? ''), sentence, '润色只出候选，正文不动');

      const bad = await post('/api/polish-selection', { nodeId: textId, start: 5, end: 2 });
      assertEqual(bad.code, 'E_AI_SELECTION_INVALID', '倒置区间要拒（不猜）');
    });

    await suite.test('I13 上次对照：找上一份同章段落，只读不写', async () => {
      const created = await post('/api/insert-paragraph', { nodeId: anchorId });
      const textId = String(created.data?.textNodeId ?? '');
      const sentence = '患者一般情况可，饮食睡眠正常。';
      await post('/api/edit', { nodeId: textId, text: sentence });

      const currentDocId = String((((await stateOf()).doc ?? {}) as Record<string, unknown>).docId ?? '');
      const compared = await post('/api/compare-selection', {
        nodeId: textId,
        start: 0,
        end: sentence.length,
      });
      assertEqual(compared.ok, true, `对照：${compared.message ?? ''}（演示里这位患者有上一份）`);
      const data = (compared.data ?? {}) as Record<string, unknown>;
      assert(String(data.previousText ?? '') !== '', '要给出上次那一段');
      assert(String(data.docId ?? '') !== currentDocId, '对照的是另一份文书（不能把本份当"上次"）');
      assertEqual(typeof data.score, 'number', '带重合度（界面要显示"像不像"）');
      const afterCompare = itemsOf(await stateOf()).find((node) => node.id === textId);
      assertEqual(String(afterCompare?.text ?? ''), sentence, '对照只读，不改当前文书');

      /* 没有上一份时必须明说，而不是给一段空对照：演示里赵**名下只有这一份文书 */
      const opened = await post('/api/open', { docId: 'doc_003_opd' });
      assertEqual(opened.ok, true, '前置：切到只有一份文书的患者');
      const lonelyItems = itemsOf(await stateOf()).filter((item) => item.kind === 'text' && String(item.text ?? '').trim() !== '');
      const lonely = lonelyItems.sort((left, right) => String(right.text ?? '').length - String(left.text ?? '').length)[0];
      const lonelyId = String(lonely?.id ?? '');
      assert(lonelyId !== '' && String(lonely?.text ?? '').length >= 2, '前置：那份文书里有一段能选的字');
      const none = await post('/api/compare-selection', {
        nodeId: lonelyId,
        start: 0,
        end: Math.min(4, String(lonely?.text ?? '').length),
      });
      assertEqual(none.ok, false, '没有上一份就不能凑一份对照出来');
      assertEqual(none.code, 'E_COMPARE_NO_PREVIOUS', '要明说"没有上一份"，而不是空对照');
      await post('/api/open', { docId: currentDocId });
    });
  } finally {
    if (child) child.kill();
    try {
      rmSync(runtimeDir, { recursive: true, force: true });
    } catch {
    }
  }

  process.exit(suite.report());
}

void main();
