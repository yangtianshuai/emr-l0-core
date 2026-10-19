// T28 审计报告：把散落在各处的事实汇总成一份可核对的产物。

import { hashNodes } from '../model/hash.ts';
import { sm3Hex, utf8 } from '../crypto/sm3.ts';
import type { DataElementTag, DocNode, DocumentModel } from '../model/types.ts';
import { readWritingTiming, type WritingTiming } from './writing-timing.ts';

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
  /**
   * 书写时长。通常由调用方传 `session.timing()`（会话里的才是当下这一版）；
   * 不传则从文档的 `extensions` 里读（落盘时写进去的那一份）。
   * 两者都没有就如实记为"未提供"。
   */
  writing?: WritingTiming | null;
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
  /**
   * 书写时长（来自 `doc.extensions` 里的时长记录；没有就如实记为"未提供"）。
   *
   * `trusted:false` 的数字照样给出 —— 但报告里必须写明它不可信：
   * 藏着"有个数字"而只在不显眼处说不可信，比没有这个数字更容易被人拿去用。
   */
  writing: {
    present: boolean;
    trusted: boolean;
    /** 有效编辑时长（毫秒）：相邻书写间隔不超过空闲阈值的那部分 */
    activeMs: number | null;
    /** 被判为空闲、未计入的时长（毫秒） */
    idleMs: number | null;
    editCount: number | null;
    firstEditAt: string | null;
    lastEditAt: string | null;
    /** 一句话说清这份时长能不能用 */
    note: string;
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
  /**
   * 审签流程：这份病历是怎么走到当前这一态的。
   *
   * 与"留痕（操作轨迹）"是两件事：那条列的是"每一次写入"，
   * 这条只列状态迁移 —— 问"这份是怎么到归档的"时，答案在这里，不用去几百条写入里翻。
   */
  reviewFlow: Array<{
    rev: number;
    at: string;
    actorId: string;
    op: 'submit' | 'review' | 'void' | 'archive';
    decision?: 'submit' | 'approve' | 'reject';
    note?: string;
    /** 作废理由（与退回理由分开：两者含义不同，合成一列会让"为什么没了"说不清） */
    reason?: string;
  }>;
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

  /* 书写时长优先用调用方给的（会话里的才是当下这一版），没有再从文档里读（落盘时写的那一份）。
     这里绝不重算：报告是"事后看"，审计要的是当时记下的那个数，不是此刻算出来的数。 */
  const writing = input.writing ?? readWritingTiming(doc);

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
    {
      id: 'WRITING_DURATION_TRUSTED',
      description: '书写时长有记录且来自真实时钟（逻辑时钟下算出的时长不可用于对外结论）',
      pass: writing !== null && writing.trusted,
      detail:
        writing === null
          ? '未提供（文档未记录书写时长）'
          : writing.trusted
            ? `有效 ${Math.round(writing.activeMs / 1000)} 秒（另有 ${Math.round(writing.idleMs / 1000)} 秒空闲未计入）`
            : '不可信：留痕时间含逻辑时钟（每次提交 +1000ms），时长不可作为结论依据',
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
    writing: {
      present: writing !== null,
      trusted: writing?.trusted === true,
      activeMs: writing?.activeMs ?? null,
      idleMs: writing?.idleMs ?? null,
      editCount: writing?.editCount ?? null,
      firstEditAt: writing?.firstEditAt ?? null,
      lastEditAt: writing?.lastEditAt ?? null,
      note:
        writing === null
          ? '未提供：这份文档没有记录书写时长'
          : writing.trusted
            ? '可信：留痕时间来自真实时钟，可用于质控与管理统计'
            : '不可信：留痕时间含逻辑时钟（每次提交 +1000ms），不得作为对外结论依据',
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
    reviewFlow: doc.revisions
      .filter((entry) => entry.op === 'submit' || entry.op === 'review' || entry.op === 'void' || entry.op === 'archive')
      .map((entry) => ({
        rev: entry.rev,
        at: entry.at,
        actorId: entry.actorId,
        op: entry.op as 'submit' | 'review' | 'void' | 'archive',
        ...(entry.review?.decision ? { decision: entry.review.decision } : {}),
        ...(entry.review?.note ? { note: entry.review.note } : {}),
        ...(entry.voided?.reason ? { reason: entry.voided.reason } : {}),
      })),
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
    `| 书写时长 | ${
      report.writing.present
        ? `${Math.round((report.writing.activeMs ?? 0) / 1000)} 秒（${report.writing.editCount ?? 0} 次书写，剔空闲 ${Math.round((report.writing.idleMs ?? 0) / 1000)} 秒）${report.writing.trusted ? '' : ' —— **不可信**'}`
        : '未提供'
    } |`,
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

  if (report.reviewFlow.length > 0) {
    lines.push('## 六、审签流程（这份病历是怎么走到当前这一态的）', '', '| rev | 时间 | 操作人 | 动作 | 结论与说明 |', '|---|---|---|---|---|');
    for (const item of report.reviewFlow) {
      const action =
        item.op === 'submit'
          ? '提交审核'
          : item.op === 'review'
            ? item.decision === 'approve'
              ? '审核通过（即签章）'
              : '审核退回'
            : item.op === 'void'
              ? '作废'
              : '归档';
      const detail = item.op === 'void' ? `理由：${item.reason ?? '—'}` : (item.note ?? (item.decision ? `结论：${item.decision}` : '—'));
      lines.push(`| ${item.rev} | ${item.at} | ${item.actorId} | ${action} | ${detail} |`);
    }
    lines.push('');
  }

  if (report.facts.gateLogProvided) {
    lines.push('## 七、门控拒绝记录（写路径拦下的操作）', '');
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
