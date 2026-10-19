// 书写时长与真实时间戳自测（W1~W10）。
//
// 这两件事被做成用例而不是注释，是因为它们都很容易"看起来实现了"：
//   · 时间戳：留痕里本来就有 `at` 字段，长得跟真的一样 —— 但它来自逻辑时钟（每次提交 +1000ms）；
//   · 书写时长：拿 lastEditAt − firstEditAt 一减就有数 —— 但那把挂机三小时也算成工作量。
// 用例里钉死的是口径，不是数字好看。

import { TestSuite, assert, assertEqual } from '../testing/harness.ts';
import { WRITE_ERRORS, WriteSession, type Actor } from './session.ts';
import { applyWritingTiming, readWritingTiming, WRITING_TIMING_KEY, type WritingTiming } from './writing-timing.ts';
import { buildSyntheticDoc } from '../testing/synthetic.ts';
import type { NodeId } from '../model/types.ts';

const HUMAN: Actor = { id: 'DR_T', kind: 'human' };
const OTHER: Actor = { id: 'DR_W', kind: 'human' };
const SYS: Actor = { id: 'system/lis', kind: 'system' };

const suite = new TestSuite('书写时长与真实时间戳自测', [
  '说明：`trusted` 为 false 的时长只能内部看 —— 它来自逻辑时钟，本质是"操作序号 × 1 秒"（G9：无可信时间戳）。',
  '口径：有效编辑时长 = 相邻两次书写之间不超过空闲阈值的那一段，超阈值的整段计入 `idleMs`。',
]);

const test = (name: string, fn: () => void | Promise<void>): Promise<void> => suite.test(name, fn);

interface Fixture {
  session: WriteSession;
  textId: NodeId;
  fieldId: NodeId | null;
}

function fixture(options: Parameters<typeof WriteSession.open>[1] = {}): Fixture {
  const { doc, ids } = buildSyntheticDoc({ sections: 2, paragraphsPerSection: 2, fieldsPerParagraph: 1, withTables: false });
  return {
    session: WriteSession.open(doc, options),
    textId: ids.textIds[0] as NodeId,
    fieldId: (ids.fieldIds[0] as NodeId | undefined) ?? null,
  };
}

/** 注入墙钟写一笔，返回注入的时刻 */
function writeAt(session: WriteSession, textId: NodeId, at: string, actor: Actor = HUMAN): void {
  session.insertText({ nodeId: textId, text: `·${at}` }, actor, { at });
}

async function main(): Promise<void> {
  await test('W1 逻辑时钟下：时长不可信，且等于"操作序号 × 1 秒"', () => {
    const { session, textId } = fixture();
    session.insertText({ nodeId: textId, text: '一' }, HUMAN);
    session.insertText({ nodeId: textId, text: '二' }, HUMAN);
    session.insertText({ nodeId: textId, text: '三' }, HUMAN);

    const t = session.timing();
    assertEqual(t.clock, 'logical', '没注入墙钟就必须如实标成 logical');
    assertEqual(t.trusted, false, '逻辑时钟算出来的时长不能对外报数');
    assertEqual(t.editCount, 3, '三次书写都要计数');
    assertEqual(t.activeMs, 2000, '3 次书写 = 2 段间隔 × 逻辑时钟的 1000ms —— 这就是"序号 × 1 秒"的实证');
  });

  await test('W2 注入墙钟后：留痕时刻就是真实时刻（内容时间与留痕时间同一个）', () => {
    const { session, textId } = fixture();
    writeAt(session, textId, '2026-10-18T09:00:00Z');
    writeAt(session, textId, '2026-10-18T09:00:30Z');

    const log = session.auditLog();
    assertEqual(log[log.length - 1]?.at, '2026-10-18T09:00:30Z', '留痕的 at 必须是注入的墙钟');
    assertEqual(session.document.updatedAt, '2026-10-18T09:00:30Z', '文档 updatedAt 跟着墙钟走');
    /* 一次提交内部有多处落时间（节点 provenance / 留痕），它们必须是同一个时刻：
       否则"改了内容"和"留痕"会各说各话，提交就不再是原子的。 */
    const node = session.getNode(textId);
    assertEqual(node?.provenance.at, '2026-10-18T09:00:30Z', '节点 provenance 的时间必须与留痕一致');
    assertEqual(session.timing().clock, 'wall', '全程注入墙钟 → wall');
    assertEqual(session.timing().trusted, true, '全程墙钟才可信');
  });

  await test('W3 时刻要过形状与单调两道门（E_TIME_INVALID / E_TIME_REGRESS）', () => {
    const { session, textId } = fixture();
    writeAt(session, textId, '2026-10-18T09:00:00Z');

    let code = 'OK';
    try {
      session.insertText({ nodeId: textId, text: 'x' }, HUMAN, { at: '2026-10-18 09:30:00' });
    } catch (err) {
      code = (err as { code?: string }).code ?? 'UNKNOWN';
    }
    assertEqual(code, WRITE_ERRORS.E_TIME_INVALID, '非 UTC ISO 串（本地时间格式）不得进留痕');

    code = 'OK';
    try {
      session.insertText({ nodeId: textId, text: 'x' }, HUMAN, { at: '2026-10-18T08:00:00Z' });
    } catch (err) {
      code = (err as { code?: string }).code ?? 'UNKNOWN';
    }
    assertEqual(code, WRITE_ERRORS.E_TIME_REGRESS, '时间往回写必须拒绝：留痕一旦能倒流，"谁先谁后"就没法判了');

    /* 被拒的两次都不该留下痕迹 —— 拒绝要拒绝得干净。
       夹具自带 1 条"创建根节点"的初始留痕（`testing/synthetic.ts`），所以比的是增量。 */
    assertEqual(session.auditLog().length, 2, '校验失败不得产生留痕（开局的 1 条 + 成功那 1 条）');
  });

  await test('W4 有效编辑时长：挂机三小时不算三小时工作量', () => {
    const { session, textId } = fixture();
    /* 09:00 → 09:00:30 → 09:01:00 连着写；然后去查房，09:41 回来写第四笔 */
    writeAt(session, textId, '2026-10-18T09:00:00Z');
    writeAt(session, textId, '2026-10-18T09:00:30Z');
    writeAt(session, textId, '2026-10-18T09:01:00Z');
    writeAt(session, textId, '2026-10-18T09:41:00Z');

    const t = session.timing();
    assertEqual(t.editCount, 4, '四笔都算书写次数');
    assertEqual(t.activeMs, 60_000, '有效时长只有 30s + 30s；中间那段 40 分钟不是"在写"');
    assertEqual(t.idleMs, 2_400_000, '被剔掉的时长要如实报出来，而不是悄悄不算');
    assertEqual(t.idleThresholdMs, 120_000, '默认阈值要写进结果里，免得拿到数字的人不知道口径');
    assertEqual(t.firstEditAt, '2026-10-18T09:00:00Z', '首次书写时刻');
    assertEqual(t.lastEditAt, '2026-10-18T09:41:00Z', '末次书写时刻');
    assert(t.lastEditAt !== null && Date.parse(t.lastEditAt) - Date.parse(t.firstEditAt as string) === t.activeMs + t.idleMs,
      '跨度 = 有效 + 空闲：这两个数之间的关系要能对上账');
  });

  await test('W5 阈值可调：同一段间隔，阈值放宽后就被计入', () => {
    const { session, textId } = fixture({ idleThresholdMs: 3_600_000 });
    writeAt(session, textId, '2026-10-18T09:00:00Z');
    writeAt(session, textId, '2026-10-18T09:41:00Z');

    const t = session.timing();
    assertEqual(t.activeMs, 2_460_000, '阈值放宽到 1 小时后，这 41 分钟被当作"在写"');
    assertEqual(t.idleMs, 0, '没有超过阈值的间隔');
    assertEqual(t.idleThresholdMs, 3_600_000, '阈值要跟着结果一起给出（口径随数字走）');
  });

  await test('W6 混用时钟即不可信：中途才想起来传 at 也不能报数', () => {
    const { session, textId } = fixture();
    session.insertText({ nodeId: textId, text: '先不传' }, HUMAN);
    writeAt(session, textId, '2026-10-18T10:00:00Z');

    const t = session.timing();
    assertEqual(t.clock, 'mixed', '两种时钟混用过 → mixed');
    assertEqual(t.trusted, false, '混用不可信：一半真一半假，比全假更容易骗人（数字看起来像真的）');
  });

  await test('W7 系统取数不算医生的书写时间（byActor 要拆得开）', () => {
    const { session, textId, fieldId } = fixture();
    assert(fieldId !== null, '夹具要给出 field 节点');
    writeAt(session, textId, '2026-10-18T09:00:00Z');
    session.applyExternalData(
      {
        items: [
          {
            nodeId: fieldId as NodeId,
            value: 6.2,
            unit: 'mmol/L',
            evidence: [{ kind: 'lis', ref: 'LIS-2026-1018-01', capturedAt: '2026-10-18T08:50:00Z' }],
          },
        ],
      },
      SYS,
      { at: '2026-10-18T09:00:20Z' },
    );
    writeAt(session, textId, '2026-10-18T09:00:50Z');

    const t = session.timing();
    assertEqual(t.editCount, 2, '系统搬运数据不是"书写"，不计次数');
    assertEqual(t.activeMs, 50_000, '有效时长只由两笔人工书写构成（20s + 30s），不含取数那一笔');
    assertEqual(t.byActor.system, 0, '系统取数不计入任何一方的书写时长');
    assertEqual(t.byActor.human, 50_000, '人工那两笔全归 human');
    assertEqual(t.byActor.human + t.byActor.ai + t.byActor.system, t.activeMs, '拆分之和必须等于总有效时长');
  });

  await test('W8 留痕检索：时间窗闭区间 + 按人 + 按 op 过滤', () => {
    const { session, textId } = fixture();
    writeAt(session, textId, '2026-10-18T09:00:00Z', HUMAN);
    writeAt(session, textId, '2026-10-18T09:10:00Z', OTHER);
    writeAt(session, textId, '2026-10-18T09:20:00Z', HUMAN);

    const all = session.auditQuery();
    assertEqual(all.length, 4, '不带条件 = 全部（含夹具自带的 1 条初始留痕）');

    const window = session.auditQuery({ from: '2026-10-18T09:10:00Z', to: '2026-10-18T09:20:00Z' });
    assertEqual(window.length, 2, '时间窗是闭区间：两端都要包含（含糊的半开区间会漏掉边界那一笔）');

    const mine = session.auditQuery({ actorId: 'DR_W' });
    assertEqual(mine.length, 1, '按操作人过滤');
    assertEqual(mine[0]?.at, '2026-10-18T09:10:00Z', '过滤结果要带得出时刻');

    assertEqual(session.auditQuery({ op: 'sign' }).length, 0, '没签过就没有签章留痕（空结果而不是报错）');
  });

  await test('W9 落盘往返：时长随文档存得下、读得回', () => {
    const { session, textId } = fixture();
    writeAt(session, textId, '2026-10-18T09:00:00Z');
    writeAt(session, textId, '2026-10-18T09:00:30Z');

    const timing: WritingTiming = session.timing();
    const doc = applyWritingTiming(session.snapshot(), timing);
    assertEqual(doc.extensions?.[WRITING_TIMING_KEY] !== undefined, true, '时长要写进 extensions 才能跟着文档落盘');

    const back = readWritingTiming(doc);
    assert(back !== null, '读得回来');
    assertEqual(back?.activeMs, 30_000, '往返后有效时长不变');
    assertEqual(back?.clock, 'wall', '可信标记要一起存：读的人得知道自己能不能报这个数');

    /* 写入不得影响正文与留痕（时长是派生数据） */
    assertEqual(doc.revisions.length, session.snapshot().revisions.length, '写时长不得产生新的留痕');
    assertEqual(doc.updatedAt, session.snapshot().updatedAt, '写时长不得改 updatedAt');
  });

  await test('W10 会话级墙钟：一次打开就不用逐笔注入（服务端场景）', () => {
    const { session, textId } = fixture({ clock: 'wall' });
    const before = Date.now();
    session.insertText({ nodeId: textId, text: '一' }, HUMAN);
    session.insertText({ nodeId: textId, text: '二' }, HUMAN);

    const t = session.timing();
    assertEqual(t.clock, 'wall', '会话级墙钟 → wall');
    assertEqual(t.trusted, true, '可以这样拿到可信时长，不必逐笔传 at');
    const last = Date.parse(session.auditLog()[session.auditLog().length - 1]?.at ?? '');
    assert(last >= before, '留痕时刻不早于调用前（真实时间进留痕）');
    assert(last <= Date.now(), '留痕时刻不晚于现在（不许凭空跑到未来）');
  });

  await test('W11 老文档没有时长字段时读回 null（而不是 0 这种假数字）', () => {
    const { doc } = buildSyntheticDoc({ sections: 1, paragraphsPerSection: 1 });
    assertEqual(readWritingTiming(doc), null, '没有就是没有；给 0 会让"从没写过"和"写了 0 毫秒"混成一件事');
  });

  process.exit(suite.report());
}

void main();
