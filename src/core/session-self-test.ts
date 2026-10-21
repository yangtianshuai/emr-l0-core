import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WriteError, WriteSession, type Actor } from './session.ts';
import { applyPatch, deepEqual } from './patch.ts';
import { buildSyntheticDoc } from '../testing/synthetic.ts';
import { TestSuite, assert, assertEqual, makeRng, pick } from '../testing/harness.ts';
import { DocumentIndex } from '../model/indexes.ts';
import type { DocNode, DocumentModel, NodeId, TextRun } from '../model/types.ts';

const SAMPLES = join(fileURLToPath(new URL('../../', import.meta.url)), 'tools', 'model-check', 'samples');

const HUMAN: Actor = { id: 'DR_T', kind: 'human' };
const SYS: Actor = { id: 'system/lis', kind: 'system' };
const AI: Actor = { id: 'ai-pipeline', kind: 'ai' };

const suite = new TestSuite('T05/T06/T07 写路径·patch·留痕自测', [
  '说明：每条写入都会校验「patch 精确还原」「文档仍合法」「索引未漂移」三项不变量。',
  '交叉验收（交给工具链复核）：',
  '  node tools/model-check/schema-validate.mjs .\\tools\\model-check\\samples\\ts-session-output.json',
  '  node tools/model-check/model-fidelity-check.mjs .\\tools\\model-check\\samples\\ts-session-output.json',
]);

const test = (name: string, fn: () => void | Promise<void>): Promise<void> => suite.test(name, fn);

function fixture(): ReturnType<typeof buildSyntheticDoc> {
  return buildSyntheticDoc({ sections: 3, paragraphsPerSection: 3, fieldsPerParagraph: 1, withTables: true });
}

function open(overrides: Partial<Parameters<typeof WriteSession.open>[1]> = {}): { session: WriteSession; ids: ReturnType<typeof fixture>['ids'] } {
  const { doc, ids } = fixture();
  return { session: WriteSession.open(doc, overrides), ids };
}

function applyRandomOp(session: WriteSession, rng: () => number, step: number): void {
  const nodes = Object.values(session.document.nodes);
  const texts = nodes.filter((n) => n.type === 'text');
  const fields = nodes.filter((n) => n.type === 'field');
  const paragraphs = nodes.filter((n) => n.type === 'paragraph');
  const sections = nodes.filter((n) => n.type === 'section');
  const leaves = nodes.filter((n) => n.type === 'text' && !nodes.some((m) => m.parentId === n.id) && n.keyContent !== true);
  const roll = rng();

  if (roll < 0.16) {
    const node = pick(rng, texts) as DocNode | null;
    if (node) session.insertText({ nodeId: node.id, text: `·${step}` }, HUMAN);
  } else if (roll < 0.32) {
    const node = pick(rng, texts) as DocNode | null;
    if (node && node.type === 'text') {
      const length = node.runs.reduce((sum, run) => sum + run.text.length, 0);
      const start = Math.floor(rng() * (length + 1));
      const end = start + Math.floor(rng() * (length - start + 1));
      session.replaceRange({ nodeId: node.id, start, end, payload: { text: `改${step}` } }, HUMAN);
    }
  } else if (roll < 0.44) {
    const node = pick(rng, fields) as DocNode | null;
    if (node) session.setFieldValue({ nodeId: node.id, value: 37 + (step % 3), valueText: String(37 + (step % 3)) }, SYS);
  } else if (roll < 0.54) {
    const node = pick(rng, paragraphs) as DocNode | null;
    if (node) session.updateNodeProps({ nodeId: node.id, patch: { semantic: `body_${step}` } }, HUMAN);
  } else if (roll < 0.7) {
    const node = pick(rng, paragraphs) as DocNode | null;
    if (node) session.createNode({ parentId: node.id, type: 'text', props: { runs: [{ text: `新增 ${step}` }] } as Partial<DocNode> }, HUMAN);
  } else if (roll < 0.83) {
    const node = pick(rng, nodes.filter((n) => n.parentId !== null && n.type !== 'section')) as DocNode | null;
    const target = pick(rng, sections.filter((s) => s.id !== node?.parentId)) as DocNode | null;
    if (node && target) session.moveNode({ nodeId: node.id, newParentId: target.id }, HUMAN);
  } else if (roll < 0.95) {
    const node = pick(rng, leaves) as DocNode | null;
    if (node) session.deleteNode({ nodeId: node.id }, HUMAN);
  } else {
    const node = pick(rng, paragraphs) as DocNode | null;
    if (node) session.deleteNode({ nodeId: node.id, mode: 'subtree' }, HUMAN);
  }
}

interface StepReport {
  step: number;
  patchOps: number;
  nodesRestored: boolean;
  /** 未被 patch 覆盖的文档级字段（按约定只允许 updatedAt 与 revisions） */
  docLevelKeys: string[];
}

function topLevelDiffKeys(rebuilt: DocumentModel, after: DocumentModel): string[] {
  const keys = new Set([...Object.keys(rebuilt), ...Object.keys(after)]);
  const diffs: string[] = [];
  for (const key of keys) {
    if (key === 'nodes') continue;
    if (!deepEqual((rebuilt as unknown as Record<string, unknown>)[key], (after as unknown as Record<string, unknown>)[key])) diffs.push(key);
  }
  return diffs;
}

function runScript(session: WriteSession, seed: number, steps: number): StepReport[] {
  const rng = makeRng(seed);
  const reports: StepReport[] = [];
  for (let step = 1; step <= steps; step += 1) {
    const before = structuredClone(session.document);
    const revBefore = session.auditLog().length;
    try {
      applyRandomOp(session, rng, step);
    } catch (err) {
      if (!(err instanceof WriteError)) throw err;
      continue;
    }
    const revisions = session.auditLog();
    if (revisions.length === revBefore) continue;
    const revision = revisions[revisions.length - 1];
    const rebuilt = applyPatch(before, revision.patch ?? []);
    reports.push({
      step,
      patchOps: (revision.patch ?? []).length,
      nodesRestored: deepEqual(rebuilt.nodes, session.document.nodes),
      docLevelKeys: topLevelDiffKeys(rebuilt, session.document),
    });
    if (step % 10 === 0) {
      const problems = session.verifyInvariants();
      assert(problems.length === 0, `第 ${step} 步不变量被破坏：${problems.slice(0, 3).join(' | ')}`);
    }
  }
  return reports;
}

async function main(): Promise<void> {
  await test('打开会话：合法文档可进入写路径', () => {
    const { session } = open();
    assert(session.docRev === 1, `初始 rev 应为 1，实际 ${session.docRev}`);
    assertEqual(session.verifyInvariants(), [], '初始不变量应成立');
    assert(session.indexes instanceof DocumentIndex, '应持有索引实例');
  });

  await test('createNode：新节点落位、order 递增、索引同步、留痕 create', () => {
    const { session, ids } = open();
    const paragraph = ids.paragraphIds[0] as NodeId;
    const before = session.indexes.childrenOf(paragraph).length;
    const result = session.createNode({ parentId: paragraph, type: 'text', props: { runs: [{ text: '新节点' }] } as Partial<DocNode> }, HUMAN);
    const node = session.document.nodes[result.targetId as NodeId] as DocNode;
    assert(!!node, '新节点应存在');
    assertEqual(node.parentId, paragraph, '父节点应为指定段落');
    assertEqual(session.indexes.childrenOf(paragraph).length, before + 1, '索引应同步新增子节点');
    const rev = session.auditLog().at(-1);
    assertEqual(rev?.op, 'create', '留痕 op 应为 create');
    assertEqual(rev?.targetId, result.targetId, '留痕 targetId 应为新节点');
    assert((rev?.patch?.length ?? 0) > 0, 'create 必须带 patch');
  });

  await test('insertText / setFieldValue / updateNodeProps：内容与值变更生效', () => {
    const { session, ids } = open();
    const textId = ids.textIds[0] as NodeId;
    session.insertText({ nodeId: textId, text: '（追加）' }, HUMAN);
    const text = session.document.nodes[textId] as Extract<DocNode, { type: 'text' }>;
    assert(text.runs[0]?.text.endsWith('（追加）') === true, '文本应被追加');
    assertEqual(text.rev, 2, '节点 rev 应递增');

    const fieldId = ids.fieldIds[0] as NodeId;
    session.setFieldValue({ nodeId: fieldId, value: 39.2, valueText: '39.2', unit: '℃' }, SYS);
    const field = session.document.nodes[fieldId] as Extract<DocNode, { type: 'field' }>;
    assertEqual(field.value, 39.2, '字段值应更新');
    assertEqual(field.valueText, '39.2', '字段展示文本应更新');

    const paragraphId = ids.paragraphIds[0] as NodeId;
    session.updateNodeProps({ nodeId: paragraphId, patch: { semantic: 'revised' } }, HUMAN);
    const paragraph = session.document.nodes[paragraphId] as { type: string; semantic?: string };
    assertEqual(paragraph.semantic, 'revised', '属性应更新');
  });

  await test('updateNodeProps 拒绝结构类字段（避免绕过校验）', () => {
    const { session, ids } = open();
    let code = '';
    try {
      session.updateNodeProps({ nodeId: ids.textIds[0] as NodeId, patch: { parentId: 'n_x' } }, HUMAN);
    } catch (err) {
      code = (err as WriteError).code;
    }
    assertEqual(code, 'E_INVALID_PATCH', '改 parentId 应被拒（须走 moveNode）');
  });

  await test('moveNode：父子关系变更且索引顺序正确；成环被拒', () => {
    const { session, ids } = open();
    const textId = ids.textIds[0] as NodeId;
    const from = session.document.nodes[textId]?.parentId as NodeId;
    const targetSection = ids.sectionIds[1] as NodeId;
    session.moveNode({ nodeId: textId, newParentId: targetSection }, HUMAN);
    assertEqual(session.document.nodes[textId]?.parentId, targetSection, '父节点应变更');
    assert(session.indexes.childrenOf(from).includes(textId) === false, '旧父节点子列表应移除');
    assert(session.indexes.childrenOf(targetSection).includes(textId), '新父节点子列表应包含');
    assertEqual(session.verifyInvariants(), [], '移动后不变量应成立');

    const sectionId = ids.sectionIds[0] as NodeId;
    const descendant = (ids.textIds[1] as NodeId) ?? '';
    assertEqual(session.document.nodes[descendant]?.parentId !== null, true, '目标节点应存在');
    assert(session.indexes.ancestorsOf(descendant).includes(sectionId), '目标节点必须是该 section 的后代（否则测不到环）');
    let code = '';
    try {
      session.moveNode({ nodeId: sectionId, newParentId: descendant }, HUMAN);
    } catch (err) {
      code = (err as WriteError).code;
    }
    assertEqual(code, 'E_CYCLE_DETECTED', '把祖先移到后代下应被拒');
  });

  await test('deleteNode：single 模式拒绝有子节点；subtree 模式级联且索引清空', () => {
    const { session, ids } = open();
    const paragraphId = ids.paragraphIds[0] as NodeId;
    let code = '';
    try {
      session.deleteNode({ nodeId: paragraphId }, HUMAN);
    } catch (err) {
      code = (err as WriteError).code;
    }
    assertEqual(code, 'E_HAS_CHILDREN', 'single 删除有子节点应被拒（防隐式级联）');

    const victims = session.indexes.subtreeIds(paragraphId);
    session.deleteNode({ nodeId: paragraphId, mode: 'subtree' }, HUMAN);
    for (const victim of victims) assert(session.document.nodes[victim] === undefined, `节点 ${victim} 应被删除`);
    assertEqual(session.indexes.subtreeIds(paragraphId), [], '索引中该子树应消失');
    assertEqual(session.verifyInvariants(), [], '级联删除后不变量应成立');
  });

  await test('安全门：必备章节禁删（子树连带也拦），但不禁内容编辑，也不许把标记改掉', () => {
    const { doc, ids } = fixture();
    const outerId = ids.sectionIds[0] as NodeId;
    const innerId = ids.sectionIds[1] as NodeId;
    (doc.nodes[innerId] as unknown as { parentId: NodeId | null }).parentId = outerId;
    (doc.nodes[innerId] as unknown as { required?: boolean }).required = true;
    const session = WriteSession.open(doc);

    let cascade = '';
    let cascadeMessage = '';
    try {
      session.deleteNode({ nodeId: outerId, mode: 'subtree' }, HUMAN);
    } catch (err) {
      cascade = (err as WriteError).code;
      cascadeMessage = (err as Error).message;
    }
    assertEqual(cascade, 'E_REQUIRED_SECTION_PROTECTED', '删外层章节不得连带删掉必备章节');
    assert(cascadeMessage.includes((doc.nodes[innerId] as unknown as { title?: string })?.title ?? ''), '报错里要点出章节标题');

    const paragraphInInner = session.indexes.childrenOf(innerId).find((id) => session.document.nodes[id]?.type === 'paragraph') as NodeId;
    assert(!!paragraphInInner, '用例前提：必备章节里应有段落');
    session.deleteNode({ nodeId: paragraphInInner, mode: 'subtree' }, HUMAN);
    assertEqual((session.document.nodes[innerId] as unknown as { required?: boolean })?.required, true, '删掉章内内容之后，这一章仍是必备');
    assertEqual(session.verifyInvariants(), [], '删除章内内容后不变量应成立');

    for (const childId of [...session.indexes.childrenOf(innerId)]) {
      session.deleteNode({ nodeId: childId, mode: 'subtree' }, HUMAN);
    }
    assertEqual(session.indexes.childrenOf(innerId).length, 0, '用例前提：这一章应已被清空');
    let cleared = '';
    try {
      session.deleteNode({ nodeId: innerId }, HUMAN);
    } catch (err) {
      cleared = (err as WriteError).code;
    }
    assertEqual(cleared, 'E_REQUIRED_SECTION_PROTECTED', '清空之后仍然删不掉（否则"清空再删"就是绕过禁删的路）');

    let patch = '';
    try {
      session.updateNodeProps({ nodeId: innerId, patch: { required: false } }, HUMAN);
    } catch (err) {
      patch = (err as WriteError).code;
    }
    assertEqual(patch, 'E_INVALID_PATCH', 'required 是结构类字段，不得经 updateNodeProps 改写');
  });

  await test('安全门：关键内容禁删、AI 不得直接写、签名后不可改', () => {
    const { session, ids } = open();
    const fieldId = ids.fieldIds[0] as NodeId;
    session.updateNodeProps({ nodeId: fieldId, patch: { keyContent: true, humanConfirmed: true } }, HUMAN);
    let code = '';
    try {
      session.deleteNode({ nodeId: fieldId }, HUMAN);
    } catch (err) {
      code = (err as WriteError).code;
    }
    assertEqual(code, 'E_KEY_CONTENT_PROTECTED', '关键内容应禁止删除');

    const otherParagraph = ids.paragraphIds[1] as NodeId;
    const textChild = session.indexes
      .childrenOf(otherParagraph)
      .find((id) => session.document.nodes[id]?.type === 'text') as NodeId;
    assert(!!textChild, '用例前提：该段落应有文本子节点');
    session.updateNodeProps({ nodeId: textChild, patch: { keyContent: true } }, HUMAN);
    let subtreeCode = '';
    try {
      session.deleteNode({ nodeId: otherParagraph, mode: 'subtree' }, HUMAN);
    } catch (err) {
      subtreeCode = (err as WriteError).code;
    }
    assertEqual(subtreeCode, 'E_KEY_CONTENT_PROTECTED', '删父节点不得绕过关键内容禁删');

    let aiCode = '';
    try {
      session.insertText({ nodeId: ids.textIds[0] as NodeId, text: 'AI 直写' }, AI);
    } catch (err) {
      aiCode = (err as WriteError).code;
    }
    assertEqual(aiCode, 'E_AI_DIRECT_WRITE_FORBIDDEN', 'AI 直接写应被拒');

    session.document.status = 'signed';
    let signedCode = '';
    try {
      session.insertText({ nodeId: ids.textIds[0] as NodeId, text: '改已签名文档' }, HUMAN);
    } catch (err) {
      signedCode = (err as WriteError).code;
    }
    assertEqual(signedCode, 'E_SIGNED_IMMUTABLE', '签名后写入应被拒');
  });

  await test('replaceRange：区间替换保真 —— 区间外的 marks/tags 逐项不变、run 不被切碎', () => {
    const { session, ids } = open();
    const nodeId = ids.textIds[0] as NodeId;
    const runsOf = (): TextRun[] => (session.document.nodes[nodeId] as Extract<DocNode, { type: 'text' }>).runs;
    const textOf = (): string => runsOf().map((run) => run.text).join('');

    session.updateNodeProps(
      {
        nodeId,
        patch: {
          runs: [
            { text: '体温', marks: ['bold'], tags: [{ system: 'WS445', code: 'DE05.01.001', display: '体温' }] },
            { text: '37.2', marks: ['underline'] },
            { text: '℃，精神可。' },
          ],
        },
      },
      HUMAN,
    );
    assertEqual(textOf(), '体温37.2℃，精神可。', '用例前提：三段 run 拼接');

    const revisionBefore = session.docRev;
    session.replaceRange({ nodeId, start: 2, end: 6, payload: { text: '38.5' } }, HUMAN);
    assertEqual(textOf(), '体温38.5℃，精神可。', '文本应为替换后的内容');
    assertEqual(JSON.stringify(runsOf().map((run) => run.marks ?? null)), JSON.stringify([['bold'], ['underline'], null]), '只有中间那段被改动');
    assertEqual(runsOf()[0]?.tags?.[0]?.code, 'DE05.01.001', '左边界 run 的 tags 必须保留');
    assertEqual(session.docRev, revisionBefore + 1, '一次替换 = 一条留痕');
    const lastRevision = session.auditLog().at(-1);
    assertEqual(lastRevision?.op, 'update', '区间替换的留痕 op 应为 update（规格第二节）');
    assertEqual(lastRevision?.targetId, nodeId, '留痕应指向被改的节点');

    /* 纯插入（start===end）：继承左侧 run 的格式，并与同格式的相邻 run 合并（不许切碎）  */
    session.replaceRange({ nodeId, start: 2, end: 2, payload: { text: '约' } }, HUMAN);
    assertEqual(textOf(), '体温约38.5℃，精神可。', '纯插入应只增加字符');
    assertEqual(runsOf().length, 3, '插入后 run 数不应增加（相邻同格式必须合并，否则每次编辑都留碎片）');
    assertEqual(runsOf()[0]?.text, '体温约', '插入内容应与左侧同格式 run 合并');
    assertEqual(runsOf()[0]?.tags?.[0]?.code, 'DE05.01.001', '合并后 tags 仍在该 run 上');
    assertEqual(session.verifyInvariants(), [], '区间替换后不变量应成立');
  });

  await test('replaceRange：非法区间一律拒绝且**不夹带修改**（越界/逆序/非整数/劈开生僻字/非文本）', () => {
    const { session, ids } = open();
    const nodeId = ids.textIds[0] as NodeId;
    session.updateNodeProps({ nodeId, patch: { runs: [{ text: '患者发热' }] } }, HUMAN);
    const snapshot = JSON.stringify(session.document.nodes[nodeId]);
    const revBefore = session.docRev;

    const cases: Array<[number, number, string]> = [
      [0, 99, '越界'],
      [4, 2, '逆序'],
      [1.5, 3, '非整数'],
    ];
    for (const [start, end, why] of cases) {
      let code = '';
      try {
        session.replaceRange({ nodeId, start, end, payload: { text: 'X' } }, HUMAN);
      } catch (err) {
        code = (err as WriteError).code;
      }
      assertEqual(code, 'E_OFFSET_RANGE', `${why}应报 E_OFFSET_RANGE`);
      assertEqual(JSON.stringify(session.document.nodes[nodeId]), snapshot, `${why}被拒后节点必须原样（不夹带半成品修改）`);
      assertEqual(session.docRev, revBefore, `${why}被拒后不应产生留痕`);
    }

    /* 生僻字（CJK 扩展 B ⇒ 代理对）不得被劈开：'𠀀' 占两个码元 */
    const rare = '患者𠀀发热';
    session.updateNodeProps({ nodeId, patch: { runs: [{ text: rare }] } }, HUMAN);
    let surrogateCode = '';
    try {
      session.replaceRange({ nodeId, start: 3, end: 4, payload: { text: 'X' } }, HUMAN);
    } catch (err) {
      surrogateCode = (err as WriteError).code;
    }
    assertEqual(surrogateCode, 'E_OFFSET_RANGE', '偏移落在代理对中间必须被拒（劈开的生僻字序列化出去就是乱码）');
    session.replaceRange({ nodeId, start: 2, end: 4, payload: { text: '某' } }, HUMAN);
    assertEqual(
      (session.document.nodes[nodeId] as Extract<DocNode, { type: 'text' }>).runs.map((run) => run.text).join(''),
      '患者某发热',
      '整个生僻字一起替换应成功',
    );

    let typeCode = '';
    try {
      session.replaceRange({ nodeId: ids.fieldIds[0] as NodeId, start: 0, end: 0, payload: { text: 'X' } }, HUMAN);
    } catch (err) {
      typeCode = (err as WriteError).code;
    }
    assertEqual(typeCode, 'E_TYPE_MISMATCH', '字段节点不接受区间替换（区间只作用于文本）');
  });

  await test('解锁与撤销：签章后先解锁才能改；撤销以新 rev 回滚且不篡改历史', async () => {
    const { session, ids } = open();
    const textId = ids.textIds[0] as NodeId;
    const textOf = (): string =>
      (session.document.nodes[textId] as Extract<DocNode, { type: 'text' }>).runs.map((run) => run.text).join('');
    const codeOf = (fn: () => unknown): string => {
      try {
        fn();
        return 'OK';
      } catch (err) {
        return (err as WriteError).code ?? `UNEXPECTED:${(err as Error).message}`;
      }
    };

    /* 先签章（关键内容必须逐条确认，否则三道门会拦） */
    const contentIds = Object.values(session.document.nodes)
      .filter((node) => node.type === 'text' || node.type === 'field')
      .map((node) => node.id);
    session.confirmNodes({ nodeIds: contentIds }, HUMAN);
    await session.sign({ acknowledgeUnconfirmed: true }, HUMAN);
    assertEqual(session.document.status, 'signed', '用例前提：应已签章');
    const signedFingerprint = session.signatureInfo()?.publicKeyFingerprint ?? '';
    assertEqual(signedFingerprint.length, 64, '应拿到签章指纹');

    assertEqual(codeOf(() => session.insertText({ nodeId: textId, text: 'X' }, HUMAN)), 'E_SIGNED_IMMUTABLE', '签章后写入应被拒');

    assertEqual(codeOf(() => session.unlock({ reason: '   ' }, HUMAN)), 'E_UNLOCK_REASON_REQUIRED', '不给理由的解锁等于静默作废一次签章，必须拒');
    const unlocked = session.unlock({ reason: '入院记录漏了既往用药' }, HUMAN);
    assertEqual(session.document.status, 'draft', '解锁后应回到 draft');
    assertEqual(session.signatureInfo()?.publicKeyFingerprint, signedFingerprint, '原签名材料不删（历史事实）');
    const unlockRevision = session.auditLog().at(-1);
    assertEqual(unlockRevision?.op, 'unlock', '解锁必须自己是一条留痕');
    assertEqual(unlockRevision?.unlock?.reason, '入院记录漏了既往用药', '留痕里要能读到理由（事后追责看的就是它）');
    assertEqual(
      unlockRevision?.unlock?.invalidated?.[0]?.publicKeyFingerprint,
      signedFingerprint,
      '留痕要记下被作废的是哪一次签章 —— 否则"验签失败"没人解释得清',
    );
    assertEqual(unlocked.revision, unlockRevision?.rev, '解锁返回的 rev 应与留痕一致');
    assertEqual(codeOf(() => session.unlock({ reason: '再解一次' }, HUMAN)), 'E_UNLOCK_NOT_ALLOWED', '未签章状态无需解锁，应明确拒绝而不是静默成功');

    const before = textOf();
    session.replaceRange({ nodeId: textId, start: 0, end: 0, payload: { text: '【补】' } }, HUMAN);
    assertEqual(textOf(), `【补】${before}`, '解锁后应能改内容');
    assertEqual(session.verifySignature().ok, false, '改过内容后验签必须失败（签名覆盖的就是内容）');

    const revBeforeUndo = session.docRev;
    session.undoLast(HUMAN);
    assertEqual(textOf(), before, '撤销应恢复成改动前的内容');
    assertEqual(session.docRev, revBeforeUndo + 1, '撤销自己也要占一个新 rev（历史只能追加）');
    const revertRevision = session.auditLog().at(-1);
    assertEqual(revertRevision?.op, 'revert', '撤销的 op 应为 revert');
    assertEqual(revertRevision?.revert?.revertedRev, revBeforeUndo, '撤销留痕要指回被撤销的那条');
    assertEqual(session.auditLog().length, revertRevision?.rev ?? 0, '被撤销的那条留痕仍在（历史不许被删）');

    assertEqual(session.undoTarget()?.rev, revBeforeUndo + 1, '刚撤销完，槽位应指向这次撤销本身（再点即重做）');

    const created = session.createNode(
      { parentId: ids.paragraphIds[0] as NodeId, type: 'text', props: { runs: [{ text: '新建段落' }] } as Partial<DocNode> },
      HUMAN,
    );
    const newId = created.targetId as NodeId;
    assert(!!session.document.nodes[newId], '用例前提：新节点应存在');
    session.undoLast(HUMAN);
    assertEqual(session.document.nodes[newId], undefined, '撤销"新建"应把节点收回');

    const victimId = ids.textIds[1] as NodeId;
    const victimBefore = JSON.stringify(session.document.nodes[victimId]);
    session.deleteNode({ nodeId: victimId }, HUMAN);
    assertEqual(session.document.nodes[victimId], undefined, '用例前提：节点应被删除');
    session.undoLast(HUMAN);
    assertEqual(JSON.stringify(session.document.nodes[victimId]), victimBefore, '撤销"删除"应把节点原样恢复（含 rev 与 provenance）');

    await session.sign({ acknowledgeUnconfirmed: true }, HUMAN);
    assertEqual(session.undoTarget(), null, '签章之后必须没有可撤销项');
    assertEqual(codeOf(() => session.undoLast(HUMAN)), 'E_NOTHING_TO_UNDO', '签章后撤销应被明确拒绝，而不是撤出个半截状态');
    assertEqual(session.verifyInvariants(), [], '解锁/撤销之后不变量应成立');
  });

  await test('留痕链：rev 连续、时间戳单调、变更类 op 必须带 patch，且改动前是什么可查', () => {
    const { session } = open();
    runScript(session, 99, 40);
    const revisions = session.auditLog();
    assert(revisions.length > 20, `留痕数量偏少：${revisions.length}`);
    const mutating = new Set(['create', 'insert', 'update', 'delete', 'move', 'accept-ai', 'import', 'migrate']);
    revisions.forEach((rev, index) => {
      assertEqual(rev.rev, index + 1, `第 ${index + 1} 条 rev 应为 ${index + 1}`);
      assert(!!rev.targetId || rev.op === 'sign', `第 ${index + 1} 条缺少 targetId`);
      if (mutating.has(rev.op)) assert((rev.patch?.length ?? 0) > 0, `第 ${index + 1} 条（${rev.op}）必须带 patch`);
      if (index > 0) assert(Date.parse(rev.at) > Date.parse(revisions[index - 1]?.at ?? rev.at), `第 ${index + 1} 条时间戳应递增`);
    });
  });

  await test('不变量（核心）：150 步随机写入后 patch 精确还原、文档合法、索引未漂移', () => {
    const { session } = open();
    const reports = runScript(session, 20261008, 150);
    assert(reports.length > 100, `有效写入偏少：${reports.length}`);
    const broken = reports.filter((r) => !r.nodesRestored).slice(0, 3);
    assertEqual(broken, [], '存在无法用 patch 精确还原节点表的写入');
    const illegalDocLevel = reports
      .flatMap((r) => r.docLevelKeys.map((key) => ({ step: r.step, key })))
      .filter(({ key }) => key !== 'updatedAt' && key !== 'revisions' && key !== 'machineReadable')
      .slice(0, 5);
    assertEqual(illegalDocLevel, [], 'patch 之外的文档级差异只允许 updatedAt / revisions');
    assertEqual(session.verifyInvariants(), [], '150 步后不变量被破坏');
    const totalOps = reports.reduce((sum, r) => sum + r.patchOps, 0);
    assert(totalOps > 200, `patch 总量偏少：${totalOps}`);
  });

  await test('patch 策略等价（T06）：local 与 full 在同序列下产出完全一致的文档与留痕', () => {
    const a = open({ patchStrategy: 'local' }).session;
    const b = open({ patchStrategy: 'full' }).session;
    runScript(a, 7, 80);
    runScript(b, 7, 80);
    assertEqual(b.auditLog().length, a.auditLog().length, '两种策略的留痕条数应一致');
    assert(deepEqual(b.document.nodes, a.document.nodes), '两种策略的节点表应完全一致');
    const len = Math.max(b.auditLog().length, a.auditLog().length);
    for (let i = 0; i < len; i += 1) {
      const left = a.auditLog()[i];
      const right = b.auditLog()[i];
      if (!deepEqual(left, right)) {
        throw new Error(`第 ${i + 1} 条留痕不一致：local=${JSON.stringify(left)} / full=${JSON.stringify(right)}`);
      }
    }
    assertEqual(b.verifyInvariants(), [], 'full 策略下不变量也应成立');
  });

  await test('patch 归一化：op 按路径有序（跨策略、跨实现可比对）', () => {
    const session = open().session;
    runScript(session, 5, 60);
    for (const revision of session.auditLog()) {
      const paths = (revision.patch ?? []).map((op) => op.path);
      assertEqual([...paths].sort(), paths, `第 ${revision.rev} 条留痕的 patch 未按路径排序：${paths.slice(0, 4).join(' , ')}`);
    }
  });

  await test('乐观锁：expectedRev 过期报 E_REV_CONFLICT', () => {
    const { session, ids } = open();
    session.insertText({ nodeId: ids.textIds[0] as NodeId, text: 'x' }, HUMAN);
    let code = '';
    try {
      session.insertText({ nodeId: ids.textIds[0] as NodeId, text: 'y' }, HUMAN, { expectedRev: 1 });
    } catch (err) {
      code = (err as WriteError).code;
    }
    assertEqual(code, 'E_REV_CONFLICT', '过期 rev 应报冲突');
    session.insertText({ nodeId: ids.textIds[0] as NodeId, text: 'z' }, HUMAN, { expectedRev: session.docRev });
  });

  await test('幂等：同 clientOpId 重复提交返回首次结果且不产生重复留痕', () => {
    const { session, ids } = open();
    const textId = ids.textIds[0] as NodeId;
    const before = session.auditLog().length;
    const r1 = session.insertText({ nodeId: textId, text: '一次' }, HUMAN, { clientOpId: 'op-1' });
    const afterFirst = session.auditLog().length;
    const r2 = session.insertText({ nodeId: textId, text: '一次' }, HUMAN, { clientOpId: 'op-1' });
    const afterSecond = session.auditLog().length;
    assertEqual(afterFirst, before + 1, '首次应新增 1 条留痕');
    assertEqual(afterSecond, afterFirst, '重复提交不应新增留痕');
    assertEqual(r2.revision, r1.revision, '重复提交应返回首次结果');
    assertEqual(r2.replayed, true, '应标记为幂等重放');
    assertEqual((session.document.nodes[textId] as Extract<DocNode, { type: 'text' }>).runs[0]?.text.endsWith('一次一次'), false, '文本不应被追加两次');
  });

  await test('AI 来源链：人工续改 AI 内容后仍可追溯模型（derivedFrom）', () => {
    const { doc, ids } = fixture();
    const textId = ids.textIds[0] as NodeId;
    const node = doc.nodes[textId] as Extract<DocNode, { type: 'text' }>;
    node.provenance = { origin: 'ai', modelId: 'local/qwen-med:7b@2026-09', confidence: 0.96, acceptedBy: 'DR_SYN', acceptedAt: doc.updatedAt, at: doc.updatedAt };
    node.humanConfirmed = true;
    const session = WriteSession.open(doc);
    session.insertText({ nodeId: textId, text: '（医生补充）' }, HUMAN);
    const after = session.document.nodes[textId] as Extract<DocNode, { type: 'text' }>;
    assertEqual(after.provenance.origin, 'human', 'origin 应变为 human');
    assertEqual(after.provenance.derivedFrom?.modelId, 'local/qwen-med:7b@2026-09', 'derivedFrom 应保留模型标识');
    assertEqual(after.provenance.derivedFrom?.editedBy, HUMAN.id, 'derivedFrom 应记录编辑人');
  });

  await test('序列化：写入后的文档可往返且仍然合法（写路径不产出坏数据）', () => {
    const { session } = open();
    runScript(session, 31, 60);
    const json = session.exportJson();
    const parsed = JSON.parse(json) as DocumentModel;
    assertEqual(session.verifyInvariants(), [], '导出前不变量应成立');
    const reopened = WriteSession.open(parsed);
    assertEqual(reopened.verifyInvariants(), [], '重新打开后不变量应成立');
    assertEqual(reopened.docRev, session.docRev, 'rev 应保持一致');
    const indexAgain = DocumentIndex.build(parsed.nodes, parsed.rootId);
    assertEqual(indexAgain.fingerprint(), session.indexes.fingerprint(), '重建索引指纹应与增量索引一致');
  });

  await test('产出交叉验收文件（写路径产物必须过得了工具链 S2/S5）', () => {
    const { session } = open();
    runScript(session, 20261008, 150);
    if (!existsSync(SAMPLES)) mkdirSync(SAMPLES, { recursive: true });
    const file = join(SAMPLES, 'ts-session-output.json');
    writeFileSync(file, `${session.exportJson({ pretty: true })}\n`, 'utf8');
    assert(existsSync(file), '应写出 ts-session-output.json');
  });

  process.exit(suite.report());
}

void main();
