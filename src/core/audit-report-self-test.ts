import { TestSuite, assert, assertEqual } from '../testing/harness.ts';
import { buildSyntheticDoc } from '../testing/synthetic.ts';
import { WriteSession } from './session.ts';
import { cloneDoc } from '../model/serialize.ts';
import { hashNodes } from '../model/hash.ts';
import type { DocNode, DocumentModel, Provenance, ProvenanceOrigin } from '../model/types.ts';
import { buildAuditReport, renderAuditReportMarkdown, verifyAuditReport, type AuditReport } from './audit-report.ts';
import { applyWritingTiming } from './writing-timing.ts';

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
  return session.document;
}

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
    assert(!markdownWithout.includes('## 七、门控拒绝记录'), '未提供时不应渲染该小节（避免被读成"没有拒绝"）');
    assert(markdownWithout.includes('未提供'), '但要显式写出"未提供"');

    const withLog = buildAuditReport({
      doc,
      generatedAt: AT,
      gateRejections: [{ at: AT, code: 'E_IMPORTED_UNCONFIRMED', action: '签章被拒' }],
    });
    assertEqual(withLog.facts.gateLogProvided, true, '传了日志应标记为已提供');
    assertEqual(withLog.facts.gateRejectionCount, 1, '拒绝条数应一致');
    assertEqual(withLog.gateRejections[0]?.code, 'E_IMPORTED_UNCONFIRMED', '错误码应保留');
    assert(renderAuditReportMarkdown(withLog).includes('## 七、门控拒绝记录'), '提供时应渲染该小节');
  });

  await test('B1 AI 来源不完整 → 失败并给出**具体节点**（否则无法复核）', () => {
    const doc = withNodes((nodes) => {
      const node = (Object.values(nodes) as DocNode[]).find((item) => item.type === 'text')!;
      node.provenance = prov('ai', { evidence: [] });
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
      node.provenance = prov('ai', { evidence: [] });
    });
    const report = buildAuditReport({ doc, generatedAt: AT });
    const passed = report.checks.filter((check) => check.pass).length;
    assert(renderAuditReportMarkdown(report).includes(`（${passed}/${report.checks.length} 通过）`), '摘要应反映实际通过数');
  });

  await test('F1 没有书写时长记录：报告要写明"未提供"，而不是给个 0', () => {
    const doc = withNodes(() => {});
    const report = buildAuditReport({ doc, generatedAt: AT });
    assertEqual(report.writing.present, false, '没有记录就是没有');
    assertEqual(report.writing.activeMs, null, '没记录时长必须是 null，不能是 0（0 会被当成"写了 0 秒"）');
    assertEqual(checkOf(report, 'WRITING_DURATION_TRUSTED').pass, false, '答不出来的检查项应判未通过');
    assert(report.writing.note.includes('没有记录书写时长'), '要说明为什么没有');
    assert(renderAuditReportMarkdown(report).includes('| 书写时长 | 未提供 |'), 'Markdown 里要看得见"未提供"');
  });

  await test('F2 时长不可信时：数字照给，但报告必须当场标不可信', () => {
    const doc = applyWritingTiming(withNodes(() => {}), {
      clock: 'logical',
      trusted: false,
      firstEditAt: AT,
      lastEditAt: AT,
      activeMs: 2000,
      idleMs: 0,
      editCount: 3,
      idleThresholdMs: 120_000,
      byActor: { human: 2000, ai: 0, system: 0 },
    });
    const report = buildAuditReport({ doc, generatedAt: AT });
    assertEqual(report.writing.present, true, '有记录');
    assertEqual(report.writing.activeMs, 2000, '数字照给（藏着反而更容易被误用）');
    assertEqual(checkOf(report, 'WRITING_DURATION_TRUSTED').pass, false, '不可信的时长不得算通过');
    const markdown = renderAuditReportMarkdown(report);
    assert(markdown.includes('不可信'), 'Markdown 里必须出现"不可信"三个字');
    assert(report.writing.note.includes('不得作为对外结论依据'), 'note 要写清不能怎么用');
  });

  await test('F3 可信时长：检查项通过，且写进事实统计', () => {
    const doc = applyWritingTiming(withNodes(() => {}), {
      clock: 'wall',
      trusted: true,
      firstEditAt: '2026-10-18T09:00:00Z',
      lastEditAt: '2026-10-18T09:08:00Z',
      activeMs: 480_000,
      idleMs: 60_000,
      editCount: 12,
      idleThresholdMs: 120_000,
      byActor: { human: 480_000, ai: 0, system: 0 },
    });
    const report = buildAuditReport({ doc, generatedAt: AT });
    assertEqual(report.writing.trusted, true, '墙钟时长可信');
    assertEqual(checkOf(report, 'WRITING_DURATION_TRUSTED').pass, true, '可信就该判通过');
    const markdown = renderAuditReportMarkdown(report);
    assert(markdown.includes('480 秒'), '事实统计里要写出有效时长');
    assert(markdown.includes('剔空闲 60 秒'), '剔掉了多少也要看得见');
  });

  await test('F4 审签流程：还原"谁在何时把这份病历推到哪一态"，没有迁移就不渲染该节', () => {
    const doc = withNodes(() => {});
    doc.revisions.push(
      { rev: 2, at: AT, actorId: 'DR_A', op: 'submit', targetId: 'n_root', review: { decision: 'submit' } },
      { rev: 3, at: AT, actorId: 'DR_R', op: 'review', targetId: 'n_root', review: { decision: 'reject', note: '主诉缺时间' } },
      { rev: 4, at: AT, actorId: 'DR_A', op: 'submit', targetId: 'n_root' },
      { rev: 5, at: AT, actorId: 'DR_R', op: 'review', targetId: 'n_root', review: { decision: 'approve' } },
    );
    const report = buildAuditReport({ doc, generatedAt: AT });
    assertEqual(report.reviewFlow.length, 4, '四步状态迁移都要进审签流');
    assertEqual(report.reviewFlow.map((item) => item.decision ?? '').join('>'), 'submit>reject>>approve', '没有结论的那一条（第二次送审）要原样留着，不补默认值');
    assertEqual(report.reviewFlow[1]?.note, '主诉缺时间', '退回理由要读得到');
    assertEqual(report.reviewFlow[1]?.actorId, 'DR_R', '退回的人是审核人，不是作者');

    const markdown = renderAuditReportMarkdown(report);
    assert(markdown.includes('## 六、审签流程'), '应有审签流程小节');
    assert(markdown.includes('审核退回'), '动作要说人话（不是把 op 原样丢出去）');
    assert(markdown.includes('主诉缺时间'), '理由要在报告里看得见');

    const plain = buildAuditReport({ doc: withNodes(() => {}), generatedAt: AT });
    assertEqual(plain.reviewFlow.length, 0, '没有迁移就没有审签流');
    assert(!renderAuditReportMarkdown(plain).includes('## 六、审签流程'), '不应渲染空的审签流小节');
  });

  await test('F5 作废理由单独成列：与退回理由不是一回事', () => {
    const doc = withNodes(() => {});
    doc.revisions.push({ rev: 2, at: AT, actorId: 'DR_A', op: 'void', targetId: 'n_root', voided: { reason: '患者未到诊' } });
    const report = buildAuditReport({ doc, generatedAt: AT });
    assertEqual(report.reviewFlow.length, 1, '作废也要进审签流');
    assertEqual(report.reviewFlow[0]?.reason, '患者未到诊', '作废理由要读得到');
    assert(renderAuditReportMarkdown(report).includes('患者未到诊'), 'Markdown 里也要看得见');
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
