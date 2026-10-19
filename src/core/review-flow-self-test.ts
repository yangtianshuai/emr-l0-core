// 审签状态机自测（R1~R11）。
//
// 这条链以前是这样的：`draft ↔ signed` 一跳 —— "提交审核 / 审核退回 / 作废 / 归档"
// 四个动作在类型里声明了，却没有迁移代码。结果是"AI 建议→医生确认→正式病历"这条链
// 在状态层面是断的：文档要么没签，要么已经签了，中间没有"正在被审"这一态。
//
// 用例里钉死的是三件事：
//   1. 状态迁移本身要留痕（谁、何时、什么结论、什么理由）；
//   2. 审核中内容必须冻结 —— 否则"审核人看的"与"最终签的"不是同一份；
//   3. 终态（作废/归档）必须有出路说明，而不是"反正改不了"。

import { TestSuite, assert, assertEqual } from '../testing/harness.ts';
import { WRITE_ERRORS, WriteSession, type Actor } from './session.ts';
import { buildSyntheticDoc } from '../testing/synthetic.ts';
import type { DocNode, DocumentModel, NodeId } from '../model/types.ts';

const AUTHOR: Actor = { id: 'DR_A', kind: 'human' };
const REVIEWER: Actor = { id: 'DR_R', kind: 'human' };

const suite = new TestSuite('K12 审签状态机自测', [
  '状态机：`draft → reviewing → signed`，另有 `void` 与 `archived` 两个终态。',
  '审核中内容冻结：要改就先退回，不设"边审边改"这种两头都不算数的中间态。',
]);

const test = (name: string, fn: () => void | Promise<void>): Promise<void> => suite.test(name, fn);

function open(): { session: WriteSession; textId: NodeId } {
  const { doc, ids } = buildSyntheticDoc({ sections: 2, paragraphsPerSection: 2, fieldsPerParagraph: 1, withTables: false });
  return { session: WriteSession.open(doc), textId: ids.textIds[0] as NodeId };
}

/** 逐条确认全部内容节点（签章的三道门要求这个） */
function confirmAll(session: WriteSession): void {
  const ids = Object.values(session.document.nodes)
    .filter((node) => node.type === 'text' || node.type === 'field')
    .map((node) => node.id);
  session.confirmNodes({ nodeIds: ids }, AUTHOR);
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
  await test('R1 提交审核：draft → reviewing，且这一跳本身就是一条留痕', () => {
    const { session } = open();
    const result = session.submitForReview({ note: '请主任审核' }, AUTHOR);
    assertEqual(session.document.status, 'reviewing', '提交后应进入审核中');
    const entry = session.auditLog().at(-1);
    assertEqual(entry?.op, 'submit', '提交审核必须自己留一条痕（与"改了一个字"区分开）');
    assertEqual(entry?.actorId, 'DR_A', '留痕要答得出是谁送审的');
    assertEqual(entry?.review?.decision, 'submit', '留痕带的是"提交"这个动作');
    assertEqual(entry?.review?.note, '请主任审核', '送审说明要留得下');
    assertEqual(result.revision, entry?.rev, '返回值里的 rev 应与留痕一致');
  });

  await test('R2 审核中内容冻结：改内容 / 再提交 / 直接签章一律拒绝', async () => {
    const { session, textId } = open();
    session.submitForReview({}, AUTHOR);

    const frozen = 'E_REVIEWING_IMMUTABLE';
    assertEqual(codeOf(() => session.insertText({ nodeId: textId, text: 'X' }, AUTHOR)), frozen, '审核中改正文必须拒');
    assertEqual(
      codeOf(() => session.confirmNodes({ nodeIds: [textId] }, AUTHOR)),
      frozen,
      '审核中"确认内容"也要拒：它同样会把"审核人看的"与"最终签的"岔开',
    );
    assertEqual(codeOf(() => session.submitForReview({}, AUTHOR)), frozen, '重复提交不应静默成功');

    /* 直接签章也拒：审核流程里的签章只能由审核裁决给出（否则审核就绕过去了） */
    let signed = 'OK';
    try {
      await session.sign({}, AUTHOR);
    } catch (err) {
      signed = (err as { code?: string }).code ?? 'UNKNOWN';
    }
    assertEqual(signed, frozen, '审核中的文档不能绕过审核直接签章');
    assertEqual(session.document.status, 'reviewing', '被拒的动作不得改变状态');
  });

  await test('R3 审核通过 = 签章（状态与签名一起落地，签名人是审核人）', async () => {
    const { session } = open();
    confirmAll(session);
    session.submitForReview({}, AUTHOR);

    await session.review({ decision: 'approve' }, REVIEWER);
    assertEqual(session.document.status, 'signed', '审核通过后应为已签章');
    const info = session.signatureInfo();
    assert(!!info, '必须有签名 —— 只把状态改成 signed 而没有签名，验签就答不出"谁签的"');
    assertEqual(info?.signedAt !== '', true, '签名要有时间');

    const entry = session.auditLog().at(-1);
    assertEqual(entry?.op, 'review', '审核通过留在痕里');
    assertEqual(entry?.review?.decision, 'approve', '结论要写得出来');
    assertEqual(entry?.actorId, 'DR_R', '留痕记的是审核人，不是作者');
    assertEqual(
      session.document.signatureRefs?.[0]?.signerRole,
      'reviewer',
      '审核通过签的是 reviewer 角色（与作者自签的 author 区分）',
    );
    assertEqual(session.verifySignature().ok, true, '签完当下验签应通过');
  });

  await test('R4 退回：理由必填，退回后可改，留痕记下理由', async () => {
    const { session, textId } = open();
    session.submitForReview({}, AUTHOR);

    let rejected = 'OK';
    try {
      await session.review({ decision: 'reject' }, REVIEWER);
    } catch (err) {
      rejected = (err as { code?: string }).code ?? 'UNKNOWN';
    }
    assertEqual(rejected, WRITE_ERRORS.E_REVIEW_NOTE_REQUIRED, '不给理由的退回必须拒（否则医生改什么全靠猜）');

    await session.review({ decision: 'reject', note: '主诉缺持续时间' }, REVIEWER);
    assertEqual(session.document.status, 'draft', '退回后回到草稿');
    assertEqual(
      session.auditLog().at(-1)?.review?.note,
      '主诉缺持续时间',
      '理由要进留痕：事后问"为什么被退回"，答案只能在这里',
    );

    /* 退回的意义就是能改 —— 改完还能再送审 */
    session.insertText({ nodeId: textId, text: '；持续三天' }, AUTHOR);
    confirmAll(session);
    session.submitForReview({}, AUTHOR);
    assertEqual(session.document.status, 'reviewing', '改完可再次送审');
  });

  await test('R5 不在审核中做裁决：E_DOC_STATUS（草稿直接审核没有意义）', async () => {
    const { session } = open();
    for (const decision of ['approve', 'reject'] as const) {
      const code = await (async () => {
        try {
          await session.review({ decision, note: 'x' }, REVIEWER);
          return 'OK';
        } catch (err) {
          return (err as { code?: string }).code ?? 'UNKNOWN';
        }
      })();
      assertEqual(code, WRITE_ERRORS.E_DOC_STATUS, `草稿状态下直接裁决（${decision}）应拒`);
    }
    assertEqual(session.document.status, 'draft', '被拒的裁决不得动状态');
  });

  await test('R6 作废：草稿可作废，理由必填，作废是终态', async () => {
    const { session, textId } = open();
    assertEqual(
      codeOf(() => session.voidDoc({ reason: '   ' }, AUTHOR)),
      WRITE_ERRORS.E_VOID_REASON_REQUIRED,
      '不给理由的作废必须拒',
    );
    session.voidDoc({ reason: '患者未到诊，误开' }, AUTHOR);
    assertEqual(session.document.status, 'void', '作废后进入 void');
    assertEqual(session.auditLog().at(-1)?.voided?.reason, '患者未到诊，误开', '作废理由要进留痕');
    assertEqual(session.auditLog().at(-1)?.op, 'void', '作废自己是一条留痕');

    /* 终态：什么都做不了，且提示要说清出路 */
    assertEqual(codeOf(() => session.insertText({ nodeId: textId, text: 'X' }, AUTHOR)), WRITE_ERRORS.E_DOC_VOID, '作废后不得再改');
    assertEqual(codeOf(() => session.submitForReview({}, AUTHOR)), WRITE_ERRORS.E_DOC_VOID, '作废后不得送审');
    assertEqual(codeOf(() => session.unlock({ reason: '再开一次' }, AUTHOR)), WRITE_ERRORS.E_DOC_VOID, '作废后不得解锁');

    /* 审核中的文书也能作废（送审了才发现开错） */
    const second = open().session;
    second.submitForReview({}, AUTHOR);
    second.voidDoc({ reason: '开错患者' }, AUTHOR);
    assertEqual(second.document.status, 'void', '审核中也可作废');
  });

  await test('R7 归档：只有已签章能归档，归档后是终态', async () => {
    const { session, textId } = open();
    assertEqual(
      codeOf(() => session.archiveDoc({}, AUTHOR)),
      WRITE_ERRORS.E_DOC_STATUS,
      '草稿不能归档（没签过的东西不配进档案）',
    );

    confirmAll(session);
    await session.sign({}, AUTHOR);
    session.archiveDoc({}, AUTHOR);
    assertEqual(session.document.status, 'archived', '已签章可归档');
    assertEqual(session.auditLog().at(-1)?.op, 'archive', '归档自己是一条留痕');
    assertEqual(codeOf(() => session.insertText({ nodeId: textId, text: 'X' }, AUTHOR)), WRITE_ERRORS.E_SIGNED_IMMUTABLE, '归档后不得再改');
    assertEqual(
      codeOf(() => session.unlock({ reason: '还想改' }, AUTHOR)),
      WRITE_ERRORS.E_UNLOCK_NOT_ALLOWED,
      '归档件连解锁也不行（终态就是终态）',
    );
    assertEqual(session.verifySignature().ok, true, '归档不破坏签名');
  });

  await test('R8 空文档不得提交审核：没写内容的东西不值得占用一次审核', () => {
    const { doc } = buildSyntheticDoc({ sections: 1, paragraphsPerSection: 1, fieldsPerParagraph: 0, withTables: false });
    const empty = {
      ...doc,
      nodes: Object.fromEntries(
        Object.entries(doc.nodes).filter(([, node]) => (node as DocNode).type !== 'text' && (node as DocNode).type !== 'field'),
      ) as DocumentModel['nodes'],
    };
    const session = WriteSession.open(empty);
    assertEqual(
      codeOf(() => session.submitForReview({}, AUTHOR)),
      WRITE_ERRORS.E_SUBMIT_EMPTY,
      '空文档提交审核应被拒',
    );
    assertEqual(session.document.status, 'draft', '被拒后仍是草稿');
  });

  await test('R9 状态迁移不可撤销：撤销槽位清空，而不是留一个撤不动的槽位', () => {
    const { session, textId } = open();
    session.insertText({ nodeId: textId, text: '·1' }, AUTHOR);
    assert(!!session.undoTarget(), '前置：先攒一个可撤销的槽位');

    session.submitForReview({}, AUTHOR);
    assertEqual(session.undoTarget(), null, '状态迁移之后不应再主张"能撤销上一次写入"');
    assertEqual(codeOf(() => session.undoLast(AUTHOR)), WRITE_ERRORS.E_NOTHING_TO_UNDO, '此时撤销应明确拒绝');
  });

  await test('R10 完整链路：送审 → 退回 → 改 → 再送审 → 通过 → 归档，留痕与验签都站得住', async () => {
    const { session, textId } = open();
    confirmAll(session);

    session.submitForReview({ note: '初稿' }, AUTHOR);
    await session.review({ decision: 'reject', note: '主诉缺持续时间' }, REVIEWER);
    session.insertText({ nodeId: textId, text: '；持续三天' }, AUTHOR);
    /* 改过的内容是新的未确认内容：不逐条确认就送审，审核通过这一关会被门控拦下 */
    confirmAll(session);
    session.submitForReview({ note: '已补' }, AUTHOR);
    await session.review({ decision: 'approve' }, REVIEWER);
    session.archiveDoc({}, AUTHOR);

    assertEqual(session.document.status, 'archived', '走完链路应为已归档');
    assertEqual(session.verifySignature().ok, true, '归档后验签仍通过');

    const ops = session.auditLog().map((entry) => entry.op);
    assertEqual(ops.includes('submit'), true, '留痕里要有送审');
    assertEqual(ops.includes('review'), true, '留痕里要有裁决');
    assertEqual(ops.includes('archive'), true, '留痕里要有归档');
    assertEqual(
      session.auditQuery({ op: 'submit' }).length,
      2,
      '两次送审都要留痕（第二次送审不能因为没有"内容变化"就消失）',
    );

    /* 状态流必须单调：这条顺序本身就是"病历怎么走到归档的"的答案 */
    const flow = session.auditLog().filter((entry) => ['submit', 'review', 'archive'].includes(entry.op));
    const decisions = flow.map((entry) => entry.review?.decision ?? 'archive');
    assertEqual(decisions.join('>'), 'submit>reject>submit>approve>archive', '留痕应能还原整条审签流');
    assertEqual(flow[1]?.actorId, 'DR_R', '退回的人是审核人');
    assertEqual(flow[3]?.actorId, 'DR_R', '通过的人是审核人');
  });

  await test('R11 未确认的 AI 内容：送审放行，审核通过这一关才拦下', async () => {
    const { doc, ids } = buildSyntheticDoc({ sections: 2, paragraphsPerSection: 2, fieldsPerParagraph: 1, withTables: false });
    const aiId = ids.textIds[0] as NodeId;
    /* 造一条"AI 写的、还没人逐条确认"的内容 —— 门控唯一认的那一类 */
    const node = doc.nodes[aiId] as Extract<DocNode, { type: 'text' }>;
    node.provenance = { origin: 'ai', modelId: 'local/qwen-med:7b', confidence: 0.9, at: doc.updatedAt };
    node.humanConfirmed = false;
    const session = WriteSession.open(doc);

    /* 送审不是放行，它只是"交给下一个人看"：门控不在这一关 */
    session.submitForReview({}, AUTHOR);
    assertEqual(session.document.status, 'reviewing', '有未确认内容也允许送审');

    let code = 'OK';
    try {
      await session.review({ decision: 'approve' }, REVIEWER);
    } catch (err) {
      code = (err as { code?: string }).code ?? 'UNKNOWN';
    }
    assertEqual(code, WRITE_ERRORS.E_SIGNED_WITH_UNCONFIRMED_AI, '未逐条确认的 AI 内容不得被审核通过');
    assertEqual(session.document.status, 'reviewing', '被拦下后仍停在审核中（不是悄悄退回草稿）');

    /* 审核人通读认可后可以显式声明放行 —— 但"放过了哪一条"必须一并留下 */
    await session.review({ decision: 'approve', acknowledgeUnconfirmed: true }, REVIEWER);
    assertEqual(session.document.status, 'signed', '声明放行后可审核通过');
    const entry = session.auditLog().at(-1);
    assertEqual(entry?.review?.decision, 'approve', '结论要写得出来');
    assert(
      (entry?.acknowledgedUnconfirmed?.ai ?? []).includes(aiId),
      '声明放行的清单必须记下放过了哪一条内容（否则"分级放行"就退化成静默放行）',
    );
  });

  await test('R12 逐条确认过的路径：不应再留下"声明放行"这条记录', async () => {
    const { session } = open();
    confirmAll(session);
    session.submitForReview({}, AUTHOR);
    await session.review({ decision: 'approve' }, REVIEWER);
    assertEqual(session.document.status, 'signed', '逐条确认过就能直接通过');
    assertEqual(
      session.auditLog().at(-1)?.acknowledgedUnconfirmed,
      undefined,
      '内容已经逐条确认过，就不该再出现"我声明通读认可了"这条记录 —— 它只在确实有未确认内容时才存在',
    );
  });

  process.exit(suite.report());
}

void main();
