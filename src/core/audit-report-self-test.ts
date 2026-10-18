// T28 验收自测：审计报告。

import { TestSuite, assert, assertEqual } from '../testing/harness.ts';
import { buildSyntheticDoc } from '../testing/synthetic.ts';
import { WriteSession } from './session.ts';
import { cloneDoc } from '../model/serialize.ts';
import { hashNodes } from '../model/hash.ts';
import type { DocNode, DocumentModel, Provenance, ProvenanceOrigin } from '../model/types.ts';
import { buildAuditReport, renderAuditReportMarkdown, verifyAuditReport, type AuditReport } from './audit-report.ts';

const suite = new TestSuite('T28 审计报告自测', [
  '说明：报告只汇总"本系统能证明的事实"，不判断是否符合病历书写规范 —— 后者不是机器能判定的。',
  '每条 check 都必须给出具体证据；报告自身带指纹，防止被编辑。',
]);

const test = (name: string, fn: () => void | Promise<void>): Promise<void> => suite.test(name, fn);

const AT = '2026-10-08T12:00:00Z';

const prov = (origin: ProvenanceOrigin, extra: Partial<Provenance> = {}): Provenance => ({ origin, at: AT, ...extra });

function baseDoc(): DocumentModel {
  const { doc } = buildSyntheticDoc({ sections: 2, paragraphsPerSection: 2, fieldsPerParagraph: 1 });
  doc.patient = { patientId: 'P_AUDIT', nameMasked: '钱**', gender: 'F', birthDate: '1975-03-03' };
  const session = WriteSession.open(doc);
  session.exportMachineReadable();
  /* 取 session 的文档副本：写会话内部是克隆的，改原对象不会反映进去 */
  return session.document;
}

/**
 * 造一份文档并改造内容节点（审计只读文档，因此夹具可以直接改 provenance）。
 *
 * 注意这里刻意不再走 `WriteSession.open` 重算机读信息，原因有两条（都是实测踩出来的）：
 *   1) 写会话会克隆文档，改了原对象等于白改；
 *   2) 写会话打开时会校验文档，而夹具故意造的就是"未确认的 AI 内容 / 缺 provenance"这类非法状态，
 *      一旦走写路径就直接抛错，测的就不是审计而是写路径了。
 * 审计只比较 `sourceHash` 与内容哈希，直接把快照对齐即可。
  */
function withNodes(mutate: (nodes: Record<string, DocNode>, doc: DocumentModel) => void): DocumentModel {
  const doc = baseDoc();
  mutate(doc.nodes as Record<string, DocNode>, doc);
  if (doc.machineReadable) {
    doc.machineReadable = { ...doc.machineReadable, sourceHash: hashNodes(doc.nodes) };
  }
  return doc;
}

function contentNodesOf(doc: DocumentModel): DocNode[] {
  return (Object.values(doc.nodes) as DocNode[]).filter((node) => node.type === 'text' || node.type === 'field');
}

function checkOf(report: AuditReport, id: string): { pass: boolean; detail: string } {
  const found = report.checks.find((check) => check.id === id);
  assert(!!found, `报告里应有 check：${id}`);
  return { pass: found.pass, detail: found.detail };
}

async function main(): Promise<void> {

  await test('A1 事实统计：节点/留痕/AI/导入/人工 计数与文档一致', () => {
    const doc = withNodes((nodes) => {
      const content = (Object.values(nodes) as DocNode[]).filter((node) => node.type === 'text' || node.type === 'field');
      content[0]!.provenance = prov('ai', { modelId: 'm1', confidence: 0.4, evidence: [] });
      content[1]!.provenance = prov('imported', { evidence: [{ kind: 'external-doc', ref: 'a.ofd#h', capturedAt: AT }] });
    });
    const report = buildAuditReport({ doc, generatedAt: AT });
    const content = contentNodesOf(doc);
    assertEqual(report.facts.nodeCount, Object.keys(doc.nodes).length, '节点总数应一致');
    assertEqual(report.facts.contentNodeCount, content.length, '内容节点数应一致');
    assertEqual(report.facts.revisionCount, doc.revisions.length, '留痕条数应一致');
    assertEqual(report.facts.aiNodeCount, 1, 'AI 节点计数');
    assertEqual(report.facts.importedNodeCount, 1, '导入节点计数');
    assertEqual(report.facts.humanNodeCount, content.filter((node) => node.provenance.origin === 'human').length, '人工节点计数');
    assertEqual(report.docId, doc.docId, '文档 id 应一致');
    assertEqual(report.generatedAt, AT, '生成时刻应来自注入');
  });

  await test('A2 未确认计数：AI / 导入 / 关键内容 三类分开统计', () => {
    const doc = withNodes((nodes) => {
      const content = (Object.values(nodes) as DocNode[]).filter((node) => node.type === 'text' || node.type === 'field');
      content[0]!.provenance = prov('ai', { modelId: 'm1', confidence: 0.4, evidence: [] });
      content[0]!.humanConfirmed = false;
      content[1]!.keyContent = true;
      content[1]!.humanConfirmed = false;
    });
    const report = buildAuditReport({ doc, generatedAt: AT });
    assertEqual(report.facts.unconfirmedAiCount, 1, '未确认 AI 应计 1');
    assertEqual(report.facts.unconfirmedKeyContentCount, 1, '未确认关键内容应计 1');
  });

  await test('A3 门控日志：不传必须**如实标注"未提供"**，不能假装"没有拒绝记录"', () => {
    const doc = withNodes(() => {});
    const without = buildAuditReport({ doc, generatedAt: AT });
    assertEqual(without.facts.gateLogProvided, false, '未传日志应标记为未提供');
    const markdownWithout = renderAuditReportMarkdown(without);
    assert(!markdownWithout.includes('## 六、门控拒绝记录'), '未提供时不应渲染该小节（避免被读成"没有拒绝"）');
    assert(markdownWithout.includes('未提供'), '但要显式写出"未提供"');

    const withLog = buildAuditReport({
      doc,
      generatedAt: AT,
      gateRejections: [{ at: AT, code: 'E_IMPORTED_UNCONFIRMED', action: '签章被拒' }],
    });
    assertEqual(withLog.facts.gateLogProvided, true, '传了日志应标记为已提供');
    assertEqual(withLog.facts.gateRejectionCount, 1, '拒绝条数应一致');
    assertEqual(withLog.gateRejections[0]?.code, 'E_IMPORTED_UNCONFIRMED', '错误码应保留');
    assert(renderAuditReportMarkdown(withLog).includes('## 六、门控拒绝记录'), '提供时应渲染该小节');
  });

  await test('B1 AI 来源不完整 → 失败并给出**具体节点**（否则无法复核）', () => {
    const doc = withNodes((nodes) => {
      const node = (Object.values(nodes) as DocNode[]).find((item) => item.type === 'text')!;
      node.provenance = prov('ai', { evidence: [] }); // 缺 modelId / confidence
    });
    const check = checkOf(buildAuditReport({ doc, generatedAt: AT }), 'AI_PROVENANCE_COMPLETE');
    assertEqual(check.pass, false, '缺模型标识必须不通过');
    assert(check.detail.length > 0, '必须给出节点 id 作为证据');
  });

  await test('B2 导入内容缺来源证据 → 失败并指出节点', () => {
    const doc = withNodes((nodes) => {
      const node = (Object.values(nodes) as DocNode[]).find((item) => item.type === 'text')!;
      node.provenance = prov('imported', { evidence: [] });
    });
    const check = checkOf(buildAuditReport({ doc, generatedAt: AT }), 'IMPORT_EVIDENCE_PRESENT');
    assertEqual(check.pass, false, '导入内容无证据必须不通过');
    assert(check.detail.length > 0, '应指出具体节点');
  });

  await test('B3 已签章 + 有未确认内容 → 失败；草稿状态不受此约束（门控只在签章时要求）', () => {
    const draft = withNodes((nodes) => {
      const node = (Object.values(nodes) as DocNode[]).find((item) => item.type === 'text')!;
      node.provenance = prov('ai', { modelId: 'm', confidence: 0.3, evidence: [] });
      node.humanConfirmed = false;
    });
    assertEqual(checkOf(buildAuditReport({ doc: draft, generatedAt: AT }), 'SIGNED_WITHOUT_UNCONFIRMED').pass, true, '草稿不受此约束');

    const signed = cloneDoc(draft);
    signed.status = 'signed';
    const check = checkOf(buildAuditReport({ doc: signed, generatedAt: AT }), 'SIGNED_WITHOUT_UNCONFIRMED');
    assertEqual(check.pass, false, '已签章却有未确认内容 → 必须不通过');
    assert(check.detail.length > 0, '应给出未确认节点 id');
  });

  await test('B4 真实确认路径可追溯：从留痕推出确认人与时间（不必给节点加字段）', () => {
    const doc = baseDoc();
    const session = WriteSession.open(doc);
    session.exportMachineReadable();
    const node = contentNodesOf(session.document)[0]!;
    session.confirmNode({ nodeId: node.id }, { id: 'DR_CONFIRM', kind: 'human' });

    const report = buildAuditReport({ doc: session.document, generatedAt: AT });
    const check = checkOf(report, 'HUMAN_CONFIRMATION_RECORDED');
    assertEqual(check.pass, true, `真实确认路径应可追溯：${check.detail}`);
  });

  await test('B4b 确认标记存在但留痕里查不到该节点 → 失败（"谁确认的"答不上来）', () => {
    const doc = withNodes((nodes) => {
      const node = (Object.values(nodes) as DocNode[]).find((item) => item.type === 'text')!;
      node.humanConfirmed = true;
      /* 换一个留痕里不会出现的节点 id：模拟"标记被写上了，但没有任何操作记录" */
      node.id = `n_ghost_${node.id}`;
    });
    const check = checkOf(buildAuditReport({ doc, generatedAt: AT }), 'HUMAN_CONFIRMATION_RECORDED');
    assertEqual(check.pass, false, '查不到留痕必须不通过');
    assert(check.detail.length > 0, '应指出节点 id');
  });

  await test('B5 机读信息：缺失与陈旧都要失败，且证据要说明是哪一种', () => {
    const doc = withNodes(() => {});
    assertEqual(checkOf(buildAuditReport({ doc, generatedAt: AT }), 'MACHINE_READABLE_FRESH').pass, true, '刚算过应通过');

    const missing = cloneDoc(doc);
    delete (missing as { machineReadable?: unknown }).machineReadable;
    const missingCheck = checkOf(buildAuditReport({ doc: missing, generatedAt: AT }), 'MACHINE_READABLE_FRESH');
    assertEqual(missingCheck.pass, false, '缺失应不通过');
    assertEqual(missingCheck.detail, '缺失', '证据要说清是缺失');

    const stale = cloneDoc(doc);
    stale.machineReadable = { ...stale.machineReadable!, sourceHash: 'deadbeef' };
    const staleCheck = checkOf(buildAuditReport({ doc: stale, generatedAt: AT }), 'MACHINE_READABLE_FRESH');
    assertEqual(staleCheck.pass, false, '陈旧应不通过');
    assert(staleCheck.detail.includes('陈旧'), '证据要说清是陈旧');
  });

  await test('B6 机读信息未纳入签名覆盖 → 失败；covers 记的是**文件路径**（按路径判定）', () => {
    const doc = withNodes(() => {});
    doc.signatureRefs = [
      {
        signatureRef: 'sig_1',
        signerRole: 'author',
        signerId: 'DR_1',
        signedAt: AT,
        algorithm: 'SM2-SM3',
        covers: ['Document.xml', 'Pages/Page_0/Content.xml'],
      },
    ];
    const check = checkOf(buildAuditReport({ doc, generatedAt: AT }), 'SIGNATURE_COVERS_MACHINE_READABLE');
    assertEqual(check.pass, false, '未覆盖机读信息必须不通过');
    assert(check.detail.includes('sig_1'), '应指出哪个签名');
    assert(check.detail.includes('Document.xml'), '证据里应带实际 covers（便于核对口径）');

    /* covers 是容器内文件路径：机读信息载体形如 MachineReadable.xml */
    doc.signatureRefs[0]!.covers = ['Document.xml', 'MachineReadable.xml'];
    assertEqual(checkOf(buildAuditReport({ doc, generatedAt: AT }), 'SIGNATURE_COVERS_MACHINE_READABLE').pass, true, '覆盖机读文件则应通过');
  });

  await test('B7 不变量：不传注明"未提供"，传了非空结果则失败并带原因', () => {
    const doc = withNodes(() => {});
    const notProvided = checkOf(buildAuditReport({ doc, generatedAt: AT }), 'NO_BROKEN_INVARIANTS');
    assertEqual(notProvided.pass, true, '未提供时不判失败（但证据里要写明）');
    assert(notProvided.detail.includes('未提供'), '证据应写明未提供');

    const broken = checkOf(buildAuditReport({ doc, generatedAt: AT, invariants: ['索引漂移：n_1'] }), 'NO_BROKEN_INVARIANTS');
    assertEqual(broken.pass, false, '有漂移必须不通过');
    assert(broken.detail.includes('索引漂移'), '原因应写进证据');
  });

  await test('C1 报告指纹：同输入稳定；改任一字段即变（否则报告本身可被随意编辑）', () => {
    const doc = withNodes((nodes) => {
      const node = (Object.values(nodes) as DocNode[]).find((item) => item.type === 'text')!;
      node.provenance = prov('ai', { modelId: 'm1', confidence: 0.2, evidence: [] });
    });
    const first = buildAuditReport({ doc, generatedAt: AT });
    const second = buildAuditReport({ doc, generatedAt: AT });
    assertEqual(first.reportDigest, second.reportDigest, '同输入应得到同一指纹');
    assertEqual(first.reportDigest.length, 64, '指纹应为 64 位十六进制');

    const tampered = { ...first, facts: { ...first.facts, aiNodeCount: first.facts.aiNodeCount + 1 } };
    assertEqual(verifyAuditReport(tampered).ok, false, '改一个数字后指纹必须对不上');
    assertEqual(verifyAuditReport(first).ok, true, '未改动应通过');
  });

  await test('D1 Markdown 含关键小节，AI 明细条数与事实一致，且标明"不构成合规结论"', () => {
    const doc = withNodes((nodes) => {
      const content = (Object.values(nodes) as DocNode[]).filter((node) => node.type === 'text' || node.type === 'field');
      for (const node of content.slice(0, 2)) node.provenance = prov('ai', { modelId: 'm1', confidence: 0.5, evidence: [] });
    });
    const report = buildAuditReport({ doc, generatedAt: AT });
    const markdown = renderAuditReportMarkdown(report);
    for (const section of ['## 一、事实统计', '## 二、机器可判定项', '## 三、AI 参与度明细', '## 五、留痕']) {
      assert(markdown.includes(section), `Markdown 应含小节：${section}`);
    }
    assertEqual(report.aiParticipation.length, report.facts.aiNodeCount, 'AI 明细条数应等于事实统计');
    assert(markdown.includes(report.reportDigest), 'Markdown 应写出报告指纹');
    assert(markdown.includes('不构成合规结论'), '必须附上"不构成合规结论"的说明');
  });

  await test('D2 结论摘要与 checks 一致（通过的条数不能与实际不符）', () => {
    const doc = withNodes((nodes) => {
      const node = (Object.values(nodes) as DocNode[]).find((item) => item.type === 'text')!;
      node.provenance = prov('ai', { evidence: [] }); // 故意让一条失败
    });
    const report = buildAuditReport({ doc, generatedAt: AT });
    const passed = report.checks.filter((check) => check.pass).length;
    assert(renderAuditReportMarkdown(report).includes(`（${passed}/${report.checks.length} 通过）`), '摘要应反映实际通过数');
  });

  await test('E1 无 AI / 无导入 / 无签名 / 无门控日志的文档：报告可生成且不崩', () => {
    const doc = withNodes(() => {});
    const report = buildAuditReport({ doc, generatedAt: AT });
    assertEqual(report.facts.aiNodeCount, 0, 'AI 计数为 0');
    assertEqual(report.signatures.length, 0, '无签名');
    assertEqual(report.gateRejections.length, 0, '无门控记录');
    const markdown = renderAuditReportMarkdown(report);
    assert(!markdown.includes('## 三、AI 参与度明细'), '没有 AI 内容时不应出现空小节');
    assert(!markdown.includes('## 四、签名'), '没有签名时不应出现空小节');
    assertEqual(verifyAuditReport(report).ok, true, '报告指纹应自洽');
  });

  await test('E2 患者姓名为空时报告仍可生成（不得出现 undefined）', () => {
    const doc = withNodes(() => {});
    delete (doc.patient as { nameMasked?: string }).nameMasked;
    const report = buildAuditReport({ doc, generatedAt: AT });
    assertEqual(report.patient.nameMasked, null, '缺失应记为 null');
    assert(renderAuditReportMarkdown(report).includes('（无姓名）'), '渲染应显示"（无姓名）"而不是 undefined');
  });

  process.exit(suite.report());
}

await main();
