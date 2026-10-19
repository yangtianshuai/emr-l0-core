// 回到历史版本（revertTo）自测（V1~V8）。
//
// 之前只有 `undoLast`（撤销最近一次）：它能省掉一次误操作，却答不出
// "三小时前的那一版写了什么"。这两件不是一回事 —— 撤销是撤回最近一笔，
// 回到历史版本是跨过一整段，而且**回滚自己也要留痕**：
// 病历里没有"悄悄回到过去"这回事，谁在什么时候把文档退回到哪一版，必须答得出来。
//
// 回滚靠的是"反放留痕"：每条留痕都带着改前的值（`oldValue`），所以不需要额外存快照。
// 代价是"能不能回到那一版"取决于那条链上的 patch 是否完整 ——
// 反不了就整体失败，绝不反到一半（半途回滚造出的是一份从未存在过的病历）。

import { TestSuite, assert, assertEqual } from '../testing/harness.ts';
import { WRITE_ERRORS, WriteSession, type Actor } from './session.ts';
import { buildSyntheticDoc } from '../testing/synthetic.ts';
import type { DocNode, NodeId } from '../model/types.ts';

const HUMAN: Actor = { id: 'DR_A', kind: 'human' };
const REVIEWER: Actor = { id: 'DR_R', kind: 'human' };

const suite = new TestSuite('K21 回到历史版本自测', [
  '回滚只改内容，不改状态；回滚本身是一条留痕（op=revert，载荷 revertedTo）。',
  '反不了就整体失败：E_REVERT_IMPOSSIBLE，不留半成品。',
]);

const test = (name: string, fn: () => void | Promise<void>): Promise<void> => suite.test(name, fn);

/** 会话 + 一个文本节点 id（合成文档自带 1 条"创建根节点"的留痕） */
function open(): { session: WriteSession; textId: NodeId; paragraphId: NodeId } {
  const { doc, ids } = buildSyntheticDoc({ sections: 2, paragraphsPerSection: 2, fieldsPerParagraph: 1, withTables: false });
  return {
    session: WriteSession.open(doc),
    textId: ids.textIds[0] as NodeId,
    paragraphId: ids.paragraphIds[0] as NodeId,
  };
}

function textOf(session: WriteSession, id: NodeId): string {
  const node = session.document.nodes[id] as Extract<DocNode, { type: 'text' }> | undefined;
  return (node?.runs ?? []).map((run) => run.text).join('');
}

function confirmAll(session: WriteSession): void {
  const ids = Object.values(session.document.nodes)
    .filter((node) => node.type === 'text' || node.type === 'field')
    .map((node) => node.id);
  session.confirmNodes({ nodeIds: ids }, HUMAN);
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
  await test('V1 回到某一版：内容就是那一版的样子，且历史一条不少', () => {
    const { session, textId } = open();
    const snapshots = [textOf(session, textId)];
    session.insertText({ nodeId: textId, text: `${textOf(session, textId)}·一改` }, HUMAN);
    snapshots.push(textOf(session, textId));
    session.insertText({ nodeId: textId, text: `${textOf(session, textId)}·二改` }, HUMAN);
    snapshots.push(textOf(session, textId));
    const revBefore = session.docRev;

    const result = session.revertTo({ rev: 1 }, HUMAN);
    assertEqual(textOf(session, textId), snapshots[0], '回到 rev 1：内容应是第一次改之前的样子');
    assertEqual(session.docRev, revBefore + 1, '回滚自己也要占一个新 rev（历史只能追加）');
    assertEqual(session.auditLog().length, revBefore + 1, '被回滚的那些留痕不许被删掉（留痕是账，不是草稿）');
    assertEqual(
      session.auditLog().map((entry) => entry.rev).join(','),
      Array.from({ length: revBefore + 1 }, (_, index) => index + 1).join(','),
      'rev 必须连续：一旦出现断层，"这一版"就指不清了',
    );
    assertEqual(result.revision, revBefore + 1, '返回值里的 rev 应与新留痕一致');
  });

  await test('V2 回滚自己要留痕：说得出"谁在何时回到哪一版、跨过了哪些"', () => {
    const { session, textId } = open();
    session.insertText({ nodeId: textId, text: `${textOf(session, textId)}·1` }, HUMAN);
    session.insertText({ nodeId: textId, text: `${textOf(session, textId)}·2` }, HUMAN);

    session.revertTo({ rev: 1 }, HUMAN, { at: '2026-10-19T10:00:00.000Z' });
    const entry = session.auditLog().at(-1);
    assertEqual(entry?.op, 'revert', '回滚要单独记一条（混在 update 里就答不出"文档被动过朝代"）');
    assertEqual(entry?.actorId, 'DR_A', '回滚人跑不掉');
    assertEqual(entry?.at, '2026-10-19T10:00:00.000Z', '回滚时刻要能注入真实时间');
    assertEqual(entry?.revertedTo?.toRev, 1, '回到哪一版要写得出来');
    assertEqual(
      JSON.stringify(entry?.revertedTo?.revertedRevs ?? []),
      JSON.stringify([2, 3]),
      '被跨过的那些留痕要逐条记下来（否则"这次回滚动了什么"只能靠猜）',
    );
    assert(session.auditLog().at(-1)?.patch !== undefined, '回滚的 patch 也要带上（回滚本身也进得了再回滚）');
  });

  await test('V3 目标 rev 不合法：E_REVERT_TARGET（不存在 / 就是最新一条 / 负数）', () => {
    const { session, textId } = open();
    session.insertText({ nodeId: textId, text: `${textOf(session, textId)}·1` }, HUMAN);
    const latest = session.docRev;

    for (const rev of [0, -1, latest, latest + 5, 1.5]) {
      assertEqual(codeOf(() => session.revertTo({ rev }, HUMAN)), WRITE_ERRORS.E_REVERT_TARGET, `rev=${rev} 应被拒`);
    }
    assertEqual(session.docRev, latest, '被拒的回滚不得留下任何痕迹');
  });

  await test('V4 跨过"新建节点"的回滚：节点要消失，索引也要跟着失联', () => {
    const { session, paragraphId } = open();
    const beforeCount = session.indexes.childrenOf(paragraphId).length;
    const created = session.createNode(
      { parentId: paragraphId, type: 'text', props: { runs: [{ text: '后加的一段' }] } as Partial<DocNode> },
      HUMAN,
    );
    const newId = created.targetId as NodeId;
    assert(!!session.document.nodes[newId], '前置：节点已建出来');
    assertEqual(session.indexes.childrenOf(paragraphId).length, beforeCount + 1, '前置：索引里也要有它');

    session.revertTo({ rev: 1 }, HUMAN);
    assertEqual(session.document.nodes[newId], undefined, '回滚应把后加的那个节点收回去');
    assertEqual(
      session.indexes.childrenOf(paragraphId).length,
      beforeCount,
      '索引必须同步：节点没了而索引还在，检索会返回一堆打不开的结果',
    );
  });

  await test('V5 状态门禁：已签章不可回滚，审核中不可回滚；解锁之后可以', async () => {
    const { session, textId } = open();
    confirmAll(session);
    await session.sign({}, HUMAN);
    assertEqual(codeOf(() => session.revertTo({ rev: 1 }, HUMAN)), WRITE_ERRORS.E_SIGNED_IMMUTABLE, '已签章的文档不能悄悄回到过去');

    session.unlock({ reason: '补既往史' }, HUMAN);
    const before = session.docRev;
    session.revertTo({ rev: 1 }, HUMAN);
    assertEqual(session.docRev, before + 1, '解锁之后可以回滚（解锁本身就留了痕）');
    assertEqual(session.verifySignature().ok, false, '回滚改了内容，原签名自然验不过');

    /* 审核中：不许回滚（那样"审核人看的"与"要签的"就不是同一份） */
    const second = open();
    second.session.submitForReview({}, HUMAN);
    assertEqual(codeOf(() => second.session.revertTo({ rev: 1 }, HUMAN)), WRITE_ERRORS.E_REVIEWING_IMMUTABLE, '审核中不得回滚');
    second.session.review({ decision: 'reject', note: '先改完再审' }, REVIEWER);
    assertEqual(codeOf(() => second.session.revertTo({ rev: 1 }, HUMAN)), 'OK', '退回草稿后就能回滚了');
  });

  await test('V6 回滚之后还能继续写：回到过去不是终点', () => {
    const { session, textId } = open();
    session.insertText({ nodeId: textId, text: `${textOf(session, textId)}·1` }, HUMAN);
    session.revertTo({ rev: 1 }, HUMAN);
    const afterRevert = textOf(session, textId);

    /* `insertText` 是追加到末尾：这里只给新增的那几个字 */
    session.insertText({ nodeId: textId, text: '·重新写' }, HUMAN);
    assertEqual(textOf(session, textId), `${afterRevert}·重新写`, '回滚之后仍可正常书写');
    session.undoLast(HUMAN);
    assertEqual(textOf(session, textId), afterRevert, '回滚之后的写入也能被撤销');
  });

  await test('V7 连续两次回滚：回滚那条留痕自己也反得回去', () => {
    const { session, textId } = open();
    const snapshots = [textOf(session, textId)];
    session.insertText({ nodeId: textId, text: `${textOf(session, textId)}·1` }, HUMAN);
    snapshots.push(textOf(session, textId));
    session.insertText({ nodeId: textId, text: `${textOf(session, textId)}·2` }, HUMAN);
    snapshots.push(textOf(session, textId));

    session.revertTo({ rev: 1 }, HUMAN);
    assertEqual(textOf(session, textId), snapshots[0], '第一次回滚');
    /* 第二次回到 rev 3（即"二改之后"）：这次要跨过的是刚才那条回滚留痕本身 */
    session.revertTo({ rev: 3 }, HUMAN);
    assertEqual(textOf(session, textId), snapshots[2], '回滚不是单程票：回滚本身也要能被回滚回去');
    session.revertTo({ rev: 2 }, HUMAN);
    assertEqual(textOf(session, textId), snapshots[1], '再退一版也要准');
  });

  await test('V8 回滚不影响文档状态与建议通道：状态迁移由各自的动作负责', async () => {
    const { session, textId } = open();
    confirmAll(session);
    session.submitForReview({}, HUMAN);
    await session.review({ decision: 'approve' }, REVIEWER);
    session.archiveDoc({}, HUMAN);

    /* 归档是终态：连回滚也不行（回滚改的是内容，归档件的内容不许再动） */
    assertEqual(codeOf(() => session.revertTo({ rev: 1 }, HUMAN)), WRITE_ERRORS.E_SIGNED_IMMUTABLE, '归档件不得回滚');
    assertEqual(session.document.status, 'archived', '被拒后状态不变');
    assertEqual(session.document.nodes[textId] !== undefined, true, '内容当然也不能变');
  });

  process.exit(suite.report());
}

void main();
