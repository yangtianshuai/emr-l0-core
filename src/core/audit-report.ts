// T28 审计报告：把散落在各处的事实汇总成一份可核对的产物。

import { hashNodes } from '../model/hash.ts';
import { sm3Hex, utf8 } from '../crypto/sm3.ts';
import type { DataElementTag, DocNode, DocumentModel } from '../model/types.ts';

export interface AuditGateRejection {
  at: string;
  code: string;
  action?: string;
}

export interface AuditInput {
  doc: DocumentModel;
  /** 生成时刻（注入以保证"同输入同输出"） */
  generatedAt: string;
  /** 门控拒绝记录（来自服务端日志；不传就注明"未提供"）  */
  gateRejections?: AuditGateRejection[];
  /** 更细致的不变量检查结果（如 `session.verifyInvariants()`）：本模块不重复实现校验器 */
  invariants?: string[];
}

export interface AuditCheck {
  id: string;
  description: string;
  pass: boolean;
  /** 具体证据：哪个节点/哪条留痕/多少条 —— 空字符串表示"无需证据" */
  detail: string;
}

export interface AuditReport {
  generatedAt: string;
  docId: string;
  docType: { system: string; code: string; display: string };
  patient: { patientId: string; nameMasked: string | null };
  status: DocumentModel['status'];
  facts: {
    nodeCount: number;
    contentNodeCount: number;
    revisionCount: number;
    aiNodeCount: number;
    importedNodeCount: number;
    humanNodeCount: number;
    unconfirmedAiCount: number;
    unconfirmedImportedCount: number;
    unconfirmedKeyContentCount: number;
    gateRejectionCount: number;
    gateLogProvided: boolean;
  };
  aiParticipation: Array<{
    nodeId: string;
    nodeType: string;
    tagCode?: string;
    modelId?: string;
    confidence?: number;
    humanConfirmed: boolean;
    /** 确认人（provenance.acceptedBy 优先，缺失时由留痕推导） */
    acceptedBy?: string;
    /** 确认时间（来自留痕：节点 rev 对应的那条 revision） */
    confirmedAt?: string;
  }>;
  signatures: Array<{
    signatureRef: string;
    signerRole?: string;
    signerId?: string;
    signedAt?: string;
    algorithm?: string;
    publicKeyFingerprint?: string;
    covers?: string[];
  }>;
  machineReadable: {
    present: boolean;
    generatedAt: string | null;
    sourceHash: string | null;
    elementCount: number;
    stale: boolean;
  };
  revisions: Array<{
    rev: number;
    at: string;
    actorId: string;
    op: string;
    targetId?: string;
    modelId?: string;
    confidence?: number;
  }>;
  gateRejections: AuditGateRejection[];
  checks: AuditCheck[];
  /** 报告自身指纹（覆盖除本字段外的全部内容） */
  reportDigest: string;
}

const isContentNode = (node: DocNode): boolean => node.type === 'text' || node.type === 'field';

function tagCodeOf(node: DocNode): string | undefined {
  const tag: DataElementTag | undefined = node.tags?.[0];
  return tag?.code;
}

/**
 * 从留痕里定位某节点最后一次变更的记录（按文档级 rev 从后往前找第一条 targetId 匹配的）。
 *
 *  早期版本拿 `node.rev` 去比 `entry.rev`，结果是"所有确认都查不到留痕"（审计报告立刻报出来）。
 * 原因是两者根本不是一回事：
 *   - `revisions[].rev` 是文档级序号（= revisions.length，用于乐观锁）；
 *   - `node.rev` 是节点级版本号（该节点被改过几次）。
 * 这类"看起来同名、实则两个口径"的字段最容易被误用，因此在报告里只按"最后一条针对该节点的留痕"定位。
  */
function lastChangeOf(doc: DocumentModel, node: DocNode): DocumentModel['revisions'][number] | undefined {
  for (let index = doc.revisions.length - 1; index >= 0; index -= 1) {
    const entry = doc.revisions[index]!;
    if (entry.targetId === node.id) return entry;
  }
  return undefined;
}

/**
 * 生成审计报告。
 * `checks` 的每一条都必须能指向具体证据：做不到就不写进报告（避免"看起来专业但无法复核"的结论）。
  */
export function buildAuditReport(input: AuditInput): AuditReport {
  const { doc, generatedAt } = input;
  const nodes = Object.values(doc.nodes) as DocNode[];
  const contentNodes = nodes.filter(isContentNode);

  const aiNodes = contentNodes.filter((node) => node.provenance?.origin === 'ai');
  const importedNodes = contentNodes.filter((node) => node.provenance?.origin === 'imported');
  const unconfirmedAi = aiNodes.filter((node) => node.humanConfirmed !== true);
  const unconfirmedImported = importedNodes.filter((node) => node.humanConfirmed !== true);
  const unconfirmedKeyContent = contentNodes.filter((node) => node.keyContent === true && node.humanConfirmed !== true);

  const machine = doc.machineReadable;
  const machineStale = machine === undefined || machine.sourceHash !== hashNodes(doc.nodes);

  const gateRejections = input.gateRejections ?? [];
  const gateLogProvided = input.gateRejections !== undefined;

  const checks: AuditCheck[] = [
    {
      id: 'AI_PROVENANCE_COMPLETE',
      description: '每条 AI 内容都带模型标识与置信度（否则"这条是谁生成的"无法回答）',
      pass: aiNodes.every((node) => typeof node.provenance?.modelId === 'string' && node.provenance.modelId !== ''
        && typeof node.provenance?.confidence === 'number'),
      detail: aiNodes
        .filter((node) => !node.provenance?.modelId || typeof node.provenance?.confidence !== 'number')
        .map((node) => node.id)
        .join(', '),
    },
    {
      id: 'IMPORT_EVIDENCE_PRESENT',
      description: '每条导入内容都带来源证据（文件名 + 指纹），可回溯到外部文件',
      pass: importedNodes.every((node) => (node.provenance?.evidence ?? []).length > 0),
      detail: importedNodes
        .filter((node) => (node.provenance?.evidence ?? []).length === 0)
        .map((node) => node.id)
        .join(', '),
    },
    {
      id: 'SIGNED_WITHOUT_UNCONFIRMED',
      description: '已签章文档中不存在未确认的 AI / 导入 / 关键内容',
      pass:
        doc.status !== 'signed' ||
        (unconfirmedAi.length === 0 && unconfirmedImported.length === 0 && unconfirmedKeyContent.length === 0),
      detail:
        [...unconfirmedAi, ...unconfirmedImported, ...unconfirmedKeyContent].map((node) => node.id).join(', ') ||
        '无未确认内容',
    },
    {
      id: 'HUMAN_CONFIRMATION_RECORDED',
      description: '每条被确认的内容都能从留痕定位到"谁在何时确认"（节点 rev 对应的那条 revision）',
      pass: contentNodes
        .filter((node) => node.humanConfirmed === true)
        .every((node) => {
          const record = lastChangeOf(doc, node);
          return record !== undefined && typeof record.actorId === 'string' && record.actorId !== '' && typeof record.at === 'string';
        }),
      detail:
        contentNodes
          .filter((node) => {
            if (node.humanConfirmed !== true) return false;
            const record = lastChangeOf(doc, node);
            return record === undefined || !record.actorId || !record.at;
          })
          .map((node) => node.id)
          .join(', ') || '全部可追溯',
    },
    {
      id: 'MACHINE_READABLE_FRESH',
      description: '机读信息存在且与当前内容一致（不陈旧）',
      pass: machine !== undefined && !machineStale,
      detail:
        machine === undefined
          ? '缺失'
          : machineStale
            ? 'sourceHash 与内容不一致（陈旧）'
            : `sourceHash ${(machine.sourceHash ?? '（无）').slice(0, 16)}…`,
    },
    {
      id: 'SIGNATURE_COVERS_MACHINE_READABLE',
      description: '机读信息载体在签名覆盖范围内（否则结构化数据可被替换而不破坏签名）',
      /*  covers 记的是容器内文件路径（如 `MachineReadable.xml`），不是逻辑段名 ——
         早期按字符串 `machineReadable` 去匹配，结果"明明覆盖了却报未覆盖"（由审计报告实测发现）。  */
      pass:
        machine === undefined ||
        (doc.signatureRefs ?? []).every((reference) => (reference.covers ?? []).some((path) => /machine/i.test(path))),
      detail: (doc.signatureRefs ?? [])
        .filter((reference) => !(reference.covers ?? []).some((path) => /machine/i.test(path)))
        .map((reference) => `${reference.signatureRef}（covers=${(reference.covers ?? []).join('|') || '空'}）`)
        .join(', '),
    },
    {
      id: 'NO_BROKEN_INVARIANTS',
      description: '文档结构与索引不变量自检通过',
      pass: (input.invariants ?? []).length === 0,
      detail: input.invariants === undefined ? '未提供不变量检查结果' : input.invariants.join('；'),
    },
  ];

  const report: AuditReport = {
    generatedAt,
    docId: doc.docId,
    docType: { system: doc.docType.system, code: doc.docType.code, display: doc.docType.display },
    patient: { patientId: doc.patient.patientId, nameMasked: doc.patient.nameMasked ?? null },
    status: doc.status,
    facts: {
      nodeCount: nodes.length,
      contentNodeCount: contentNodes.length,
      revisionCount: doc.revisions.length,
      aiNodeCount: aiNodes.length,
      importedNodeCount: importedNodes.length,
      humanNodeCount: contentNodes.filter((node) => node.provenance?.origin === 'human').length,
      unconfirmedAiCount: unconfirmedAi.length,
      unconfirmedImportedCount: unconfirmedImported.length,
      unconfirmedKeyContentCount: unconfirmedKeyContent.length,
      gateRejectionCount: gateRejections.length,
      gateLogProvided,
    },
    aiParticipation: aiNodes.map((node) => {
      const record = lastChangeOf(doc, node);
      /* 确认人优先取 provenance.acceptedBy（AI 建议被采纳时写入），缺失则从留痕推导 ——
         两个来源都写进报告，便于核对它们是否一致 */
      const confirmedBy = node.provenance?.acceptedBy ?? record?.actorId;
      return {
        nodeId: node.id,
        nodeType: node.type,
        ...(tagCodeOf(node) ? { tagCode: tagCodeOf(node)! } : {}),
        ...(node.provenance?.modelId ? { modelId: node.provenance.modelId } : {}),
        ...(typeof node.provenance?.confidence === 'number' ? { confidence: node.provenance.confidence } : {}),
        humanConfirmed: node.humanConfirmed === true,
        ...(confirmedBy ? { acceptedBy: confirmedBy } : {}),
        ...(record?.at ? { confirmedAt: record.at } : {}),
      };
    }),
    signatures: (doc.signatureRefs ?? []).map((reference) => ({
      signatureRef: reference.signatureRef,
      ...(reference.signerRole ? { signerRole: reference.signerRole } : {}),
      ...(reference.signerId ? { signerId: reference.signerId } : {}),
      ...(reference.signedAt ? { signedAt: reference.signedAt } : {}),
      ...(reference.algorithm ? { algorithm: reference.algorithm } : {}),
      ...(reference.publicKeyFingerprint ? { publicKeyFingerprint: reference.publicKeyFingerprint } : {}),
      ...(reference.covers ? { covers: reference.covers } : {}),
    })),
    machineReadable: {
      present: machine !== undefined,
      generatedAt: machine?.generatedAt ?? null,
      sourceHash: machine?.sourceHash ?? null,
      elementCount: machine?.dataElements.length ?? 0,
      stale: machineStale,
    },
    revisions: doc.revisions.map((entry) => ({
      rev: entry.rev,
      at: entry.at,
      actorId: entry.actorId,
      op: entry.op,
      ...(entry.targetId ? { targetId: entry.targetId } : {}),
      ...(entry.modelId ? { modelId: entry.modelId } : {}),
      ...(typeof entry.confidence === 'number' ? { confidence: entry.confidence } : {}),
    })),
    gateRejections: gateRejections.map((entry) => ({ at: entry.at, code: entry.code, ...(entry.action ? { action: entry.action } : {}) })),
    checks,
    reportDigest: '',
  };

  /* 指纹覆盖"除自身外的全部内容"：任何一个数字被改都会对不上 */
  const withoutDigest = { ...report, reportDigest: '' };
  report.reportDigest = sm3Hex(utf8(JSON.stringify(withoutDigest)));
  return report;
}

/** 校验报告是否被改动过（把 reportDigest 重算一遍比对） */
export function verifyAuditReport(report: AuditReport): { ok: boolean; reason?: string } {
  const expected = sm3Hex(utf8(JSON.stringify({ ...report, reportDigest: '' })));
  return expected === report.reportDigest
    ? { ok: true }
    : { ok: false, reason: `报告指纹不符：期望 ${expected.slice(0, 16)}…，实际 ${report.reportDigest.slice(0, 16)}…` };
}

const yn = (value: boolean): string => (value ? '✅' : '❌');

/**
 * 渲染为人可读的 Markdown。
 * 结论文本必须与 checks 一致：报告里既要有"通过/未通过"的摘要，也要能逐条看到证据。
  */
export function renderAuditReportMarkdown(report: AuditReport): string {
  const passed = report.checks.filter((check) => check.pass).length;
  const lines: string[] = [
    `# 病历审计报告`,
    '',
    `- 文档：\`${report.docId}\`（${report.docType.display} / ${report.docType.code}）`,
    `- 患者：${report.patient.nameMasked ?? '（无姓名）'}（${report.patient.patientId}）`,
    `- 状态：**${report.status}**`,
    `- 生成时间：${report.generatedAt}`,
    `- 报告指纹：\`${report.reportDigest}\``,
    '',
    `## 一、事实统计`,
    '',
    '| 项 | 值 |',
    '|---|---|',
    `| 节点总数 / 内容节点 | ${report.facts.nodeCount} / ${report.facts.contentNodeCount} |`,
    `| 留痕条数 | ${report.facts.revisionCount} |`,
    `| AI 内容 / 导入内容 / 人工内容 | ${report.facts.aiNodeCount} / ${report.facts.importedNodeCount} / ${report.facts.humanNodeCount} |`,
    `| 未确认：AI / 导入 / 关键内容 | ${report.facts.unconfirmedAiCount} / ${report.facts.unconfirmedImportedCount} / ${report.facts.unconfirmedKeyContentCount} |`,
    `| 门控拒绝记录 | ${report.facts.gateLogProvided ? `${report.facts.gateRejectionCount} 条` : '未提供（本次未传入日志）'} |`,
    `| 机读信息 | ${report.machineReadable.present ? `${report.machineReadable.elementCount} 条${report.machineReadable.stale ? '（**陈旧**）' : ''}` : '缺失'} |`,
    `| 签名 | ${report.signatures.length} 个 |`,
    '',
    `## 二、机器可判定项（${passed}/${report.checks.length} 通过）`,
    '',
    '| 项 | 结论 | 证据 |',
    '|---|---|---|',
    ...report.checks.map((check) => `| ${check.description} | ${yn(check.pass)} | ${check.detail || '—'} |`),
    '',
  ];

  if (report.aiParticipation.length > 0) {
    lines.push('## 三、AI 参与度明细', '', '| 节点 | 类型 | 标签 | 模型 | 置信度 | 已确认 | 确认人 |', '|---|---|---|---|---|---|---|');
    for (const item of report.aiParticipation) {
      lines.push(
        `| \`${item.nodeId}\` | ${item.nodeType} | ${item.tagCode ?? '—'} | ${item.modelId ?? '—'} | ${
          item.confidence === undefined ? '—' : item.confidence.toFixed(2)
        } | ${yn(item.humanConfirmed)} | ${item.acceptedBy ?? '—'} |`,
      );
    }
    lines.push('');
  }

  if (report.signatures.length > 0) {
    lines.push('## 四、签名', '', '| 引用 | 角色 | 签署人 | 时间 | 算法 | 公钥指纹 | 覆盖 |', '|---|---|---|---|---|---|---|');
    for (const item of report.signatures) {
      lines.push(
        `| \`${item.signatureRef}\` | ${item.signerRole ?? '—'} | ${item.signerId ?? '—'} | ${item.signedAt ?? '—'} | ${
          item.algorithm ?? '—'
        } | ${item.publicKeyFingerprint ? `${item.publicKeyFingerprint.slice(0, 16)}…` : '—'} | ${(item.covers ?? []).join(', ') || '—'} |`,
      );
    }
    lines.push('');
  }

  lines.push('## 五、留痕（操作轨迹）', '', '| rev | 时间 | 操作人 | 操作 | 目标 | 模型 | 置信度 |', '|---|---|---|---|---|---|---|');
  for (const item of report.revisions) {
    lines.push(
      `| ${item.rev} | ${item.at} | ${item.actorId} | ${item.op} | ${item.targetId ?? '—'} | ${item.modelId ?? '—'} | ${
        item.confidence === undefined ? '—' : item.confidence.toFixed(2)
      } |`,
    );
  }
  lines.push('');

  if (report.facts.gateLogProvided) {
    lines.push('## 六、门控拒绝记录（写路径拦下的操作）', '');
    if (report.gateRejections.length === 0) {
      lines.push('本次未记录到拒绝。', '');
    } else {
      lines.push('| 时间 | 错误码 | 动作 |', '|---|---|---|');
      for (const item of report.gateRejections) lines.push(`| ${item.at} | \`${item.code}\` | ${item.action ?? '—'} |`);
      lines.push('');
    }
  }

  lines.push(
    '---',
    '',
    '> **本报告不构成合规结论**：它只汇总本系统能证明的事实（谁写的、AI 参与多少、是否签章、是否加密交付），',
    '> 不判断是否符合病历书写规范或评级标准。报告指纹用于确认"这份报告本身没有被改动"。',
    '',
  );
  return lines.join('\n');
}
