/**
 * 确认与签章分级自测（T29）。
 *
 *   node src/core/confirm-self-test.ts
 *
 * 背景：原来的设计里 `humanConfirmed` 是节点级的、`confirmNode` 一次只能确认一个节点，
 * 而签名前所有 AI/导入/关键内容都必须确认 —— 导入一份文档要点几十上百次。
 * 在真实诊室里，这会退化成"不看就全点一遍"：**门控形式还在、实质已失效**。
 *
 * 本套锁死"便利与责任"的边界，重点是**防回退**：
 *   A1~A3 批量/子树确认（范围必须进留痕）
 *   A4    编辑即确认（医生动过的节点视为已看过）
 *   A5    **采纳 ≠ 确认责任**（这条最容易在改代码时被顺手破坏）
 *   A6    **关键内容不适用"编辑即确认"**（改一个字不等于核对过全部）
 *   A7    签名分级：声明后放行，但未确认清单进留痕
 *   A8    **声明不豁免关键内容**（"关键"二字的定义）
 */

import { TestSuite, assert, assertEqual, codeOfAsync } from '../testing/harness.ts';
import { WriteSession } from './session.ts';
import type { DocumentModel, DocNode, RevisionEntry } from '../model/types.ts';

const suite = new TestSuite('确认与签章分级自测', [
  '说明：本套同时锁死"医生少点几下"与"责任一点不能少"两侧，A5/A6/A8 是防回退的关键。',
]);

const test = (name: string, fn: () => void | Promise<void>): Promise<void> => suite.test(name, fn);

const HUMAN = { id: 'DR_WANG', kind: 'human' as const };
const AI = { id: 'ai-pipeline', kind: 'ai' as const };

function codeOf(fn: () => unknown): string {
  try {
    fn();
    return 'OK';
  } catch (err) {
    return (err as { code?: string }).code ?? '(无错误码)';
  }
}

type AnyNode = DocNode & { humanConfirmed?: boolean };

function fixture(): DocumentModel {
  const at = '2026-10-08T01:00:00Z';
  const prov = (origin: 'human' | 'system', actorId: string) => ({ origin, actorId, at });
  return {
    schemaVersion: '1.0.0',
    docId: 'doc_confirm_1',
    docType: { system: 'WST500', code: 'WST500.2', display: '门（急）诊病历' },
    patient: { patientId: 'P9001', nameMasked: '张**', gender: 'M' },
    status: 'draft',
    createdAt: at,
    updatedAt: at,
    createdBy: 'DR_WANG',
    rootId: 'n_root',
    nodes: {
      n_root: { id: 'n_root', type: 'document', parentId: null, order: 0, rev: 1, provenance: prov('system', 'seed') },
      n_sec: {
        id: 'n_sec',
        type: 'section',
        parentId: 'n_root',
        order: 10,
        rev: 1,
        title: '现病史',
        sectionCode: 'WST500.2.002',
        provenance: prov('human', 'DR_WANG'),
      },
      n_p: { id: 'n_p', type: 'paragraph', parentId: 'n_sec', order: 10, rev: 1, provenance: prov('human', 'DR_WANG') },
      /* 空段落：用来验证"子树里没有可确认内容"时明确拒绝，而不是静默成功 */
      n_empty: { id: 'n_empty', type: 'paragraph', parentId: 'n_sec', order: 20, rev: 1, provenance: prov('human', 'DR_WANG') },
      n_t: {
        id: 'n_t',
        type: 'text',
        parentId: 'n_p',
        order: 10,
        rev: 1,
        runs: [{ text: '患者3天前出现咳嗽。' }],
        provenance: prov('human', 'DR_WANG'),
      },
      n_k: {
        id: 'n_k',
        type: 'text',
        parentId: 'n_p',
        order: 20,
        rev: 1,
        keyContent: true,
        runs: [{ text: '初步诊断：急性支气管炎。' }],
        provenance: prov('human', 'DR_WANG'),
      },
      n_f: {
        id: 'n_f',
        type: 'field',
        parentId: 'n_p',
        order: 30,
        rev: 1,
        dataType: 'number',
        value: 37,
        valueText: '37',
        unit: '℃',
        tags: [{ system: 'WS445', code: 'DE05.01.001', display: '体温' }],
        provenance: prov('system', 'system/lis'),
      },
    },
    revisions: [],
  } as unknown as DocumentModel;
}

function lastRevision(session: WriteSession): RevisionEntry {
  const log = session.auditLog();
  return log[log.length - 1] as RevisionEntry;
}

function nodeOf(session: WriteSession, id: string): AnyNode {
  return session.getNode(id) as unknown as AnyNode;
}

async function main(): Promise<void> {
  await test('A1 批量确认：一次确认多条，且**确认范围必须进留痕**', async () => {
    const session = WriteSession.open(fixture());
    session.confirmNodes({ nodeIds: ['n_t', 'n_f'] }, HUMAN);

    assertEqual(nodeOf(session, 'n_t').humanConfirmed, true, '批量范围内的节点应被确认');
    assertEqual(nodeOf(session, 'n_f').humanConfirmed, true, '批量范围内的节点应被确认');
    assertEqual(nodeOf(session, 'n_k').humanConfirmed, undefined, '不在范围内的节点不受影响');

    /* 这条是本设计的立身之本：批量把"点 N 次"变成"点 1 次"，
       但"确认了哪些"必须仍能逐条回答 —— 否则就是用可追溯性换便利性 */
    assertEqual(lastRevision(session).confirmedNodeIds, ['n_t', 'n_f'], '留痕必须记录确认范围');

    /* 重复确认不应推高 rev：嵌套章节会让同一节点落在两个子树里，
       按章节逐个确认时同一节点会被确认多次（实测：9 个内容节点的门诊病历被确认 10 次） */
    const revBefore = nodeOf(session, 'n_t').rev;
    session.confirmNodes({ nodeIds: ['n_t'] }, HUMAN);
    assertEqual(nodeOf(session, 'n_t').rev, revBefore, '已确认的节点重复确认不应推高 rev');
  });

  await test('A2 空范围确认必须被拒（不静默成功）', async () => {
    const session = WriteSession.open(fixture());
    assertEqual(
      codeOf(() => session.confirmNodes({ nodeIds: [] }, HUMAN)),
      'E_CONFIRM_SCOPE_REQUIRED',
      '空范围确认等于什么都没做，必须拒绝',
    );
  });

  await test('A3 子树确认：只收内容节点（text/field），结构节点不要求确认', async () => {
    const session = WriteSession.open(fixture());
    session.confirmSubtree({ nodeId: 'n_sec' }, HUMAN);
    assertEqual(nodeOf(session, 'n_t').humanConfirmed, true, '子树内的文本节点应被确认');
    assertEqual(nodeOf(session, 'n_k').humanConfirmed, true, '子树内的关键内容节点也应被确认（显式确认）');
    assertEqual(nodeOf(session, 'n_f').humanConfirmed, true, '子树内的字段节点应被确认');
    /* 若把结构节点也算进范围，导入件将永远确认不完（界面上没有"确认章节标题"的按钮） */
    assertEqual(nodeOf(session, 'n_sec').humanConfirmed, undefined, '结构节点不在确认范围内');

    assertEqual(
      codeOf(() => session.confirmSubtree({ nodeId: 'n_empty' }, HUMAN)),
      'E_CONFIRM_SCOPE_REQUIRED',
      '子树内没有可确认内容时应明确拒绝，而不是假装成功',
    );
  });

  await test('A4 编辑即确认：医生动过的节点视为已看过（省掉一次点击）', async () => {
    const session = WriteSession.open(fixture());
    assertEqual(nodeOf(session, 'n_t').humanConfirmed, undefined, '起始应为未确认');
    session.insertText({ nodeId: 'n_t', text: '夜间加重。' }, HUMAN);
    assertEqual(nodeOf(session, 'n_t').humanConfirmed, true, '医生编辑过的节点应视为已确认');
  });

  await test('A5 采纳 ≠ 确认责任：acceptSuggestion 后仍必须显式确认（防回退）', async () => {
    const session = WriteSession.open(fixture());
    const suggestion = session.suggestText(
      { nodeId: 'n_t', text: '患者3天前出现咳嗽，伴发热。', confidence: 0.82, modelId: 'demo-model' },
      AI,
    );
    session.acceptSuggestion({ suggestionId: suggestion.suggestionId }, HUMAN);
    /* 先确认关键内容，才走得到 ② 那道门 —— 否则会被 ① 先挡住，
       测到的就不是 AI 门控，而是关键内容门控（这一条自己也是用例：A6/A8） */
    session.confirmNodes({ nodeIds: ['n_k'] }, HUMAN);

    const node = nodeOf(session, 'n_t');
    assertEqual(node.provenance.origin, 'ai', '落笔后来源应为 ai');
    /* 这条纪律最容易在改代码时被"顺手优化掉"（例如为了减少点击而让采纳自动确认），
       所以必须有用例守着：采纳只表示"同意用这段文字"，不表示"核对了它的正确性" */
    assertEqual(node.humanConfirmed, false, '采纳后 humanConfirmed 必须仍为 false');
    assertEqual(await codeOfAsync(() => session.sign({}, HUMAN)), 'E_SIGNED_WITH_UNCONFIRMED_AI', '未确认的 AI 内容必须挡住签章');
  });

  await test('A6 关键内容不适用"编辑即确认"：改一个字不等于核对过全部（防回退）', async () => {
    const session = WriteSession.open(fixture());
    session.insertText({ nodeId: 'n_k', text: '（略作修改）' }, HUMAN);
    assertEqual(
      nodeOf(session, 'n_k').humanConfirmed,
      undefined,
      '关键内容（诊断/剂量/过敏/术式）即使被编辑过，也仍需显式确认',
    );
    assertEqual(await codeOfAsync(() => session.sign({}, HUMAN)), 'E_KEY_CONTENT_UNCONFIRMED', '关键内容未确认必须阻断签章');
  });

  await test('A7 签名分级：非关键 AI 内容未确认时，声明后放行且清单进留痕', async () => {
    const session = WriteSession.open(fixture());
    const suggestion = session.suggestText(
      { nodeId: 'n_t', text: '患者3天前出现咳嗽，伴发热。', confidence: 0.82, modelId: 'demo-model' },
      AI,
    );
    session.acceptSuggestion({ suggestionId: suggestion.suggestionId }, HUMAN);
    /* 先把关键内容确认掉，才能走到 ② 这道门（否则被 ① 挡住，测不到分级行为） */
    session.confirmNodes({ nodeIds: ['n_k'] }, HUMAN);

    assertEqual(
      await codeOfAsync(() => session.sign({}, HUMAN)),
      'E_SIGNED_WITH_UNCONFIRMED_AI',
      '未声明时仍应阻断（默认 fail-safe，行为与改造前一致）',
    );

    const result = await session.sign({ acknowledgeUnconfirmed: true }, HUMAN);
    assertEqual(result.ok, true, '显式声明"已通读"后应放行');
    assertEqual(session.document.status, 'signed', '应完成签章');

    const revision = lastRevision(session);
    assertEqual(revision.op, 'sign', '最后一条留痕应为签章');
    assertEqual(
      revision.acknowledgedUnconfirmed?.ai,
      ['n_t'],
      '留痕必须记录"未逐条确认的 AI 内容清单" —— 分级放行的代价必须可查',
    );
  });

  await test('A8 声明不豁免关键内容：acknowledgeUnconfirmed 挡不住 ①（防回退）', async () => {
    const session = WriteSession.open(fixture());
    assertEqual(
      await codeOfAsync(() => session.sign({ acknowledgeUnconfirmed: true }, HUMAN)),
      'E_KEY_CONTENT_UNCONFIRMED',
      '关键内容未确认时，即使声明也不能签章 —— 这是"关键"二字的定义',
    );
  });

  process.exit(suite.report());
}

void main();
