import type { PatchOp, RevisionEntry } from '../model/types.ts';

const TEXT_PATH = /^\/nodes\/([^/]+)\/runs\/\d+\/text$/;
const VALUE_PATH = /^\/nodes\/([^/]+)\/(?:value|valueText|unit)$/;
const NODE_PATH = /^\/nodes\/([^/]+)$/;

const CLIP = 16;

function clip(text: string, max = CLIP): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function textOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (!value || typeof value !== 'object') return undefined;
  const node = value as { runs?: Array<{ text?: string }>; valueText?: string };
  if (Array.isArray(node.runs)) return node.runs.map((run) => run.text ?? '').join('');
  if (typeof node.valueText === 'string') return node.valueText;
  return undefined;
}

interface Change {
  before?: string;
  after?: string;
}

function pickChange(patch: readonly PatchOp[]): Change | null {
  for (const item of patch) {
    if (TEXT_PATH.test(item.path)) return { before: textOf(item.oldValue), after: textOf(item.value) };
  }
  for (const item of patch) {
    if (VALUE_PATH.test(item.path)) return { before: textOf(item.oldValue), after: textOf(item.value) };
  }
  for (const item of patch) {
    if (!NODE_PATH.test(item.path)) continue;
    if (item.op === 'add') return { after: textOf(item.value) };
    if (item.op === 'remove') return { before: textOf(item.oldValue) };
  }
  return null;
}

function describeChange(change: Change | null): string | null {
  if (!change) return null;
  const before = change.before === undefined ? undefined : clip(change.before);
  const after = change.after === undefined ? undefined : clip(change.after);
  if (before && after && before !== after) return `「${before}」→「${after}」`;
  if (before && after) return `「${after}」`;
  if (after) return `「${after}」`;
  if (before) return `「${before}」`;
  return null;
}

export function summarizeRevision(revision: RevisionEntry): string {
  const patch = revision.patch ?? [];
  const change = pickChange(patch);
  const detail = describeChange(change);
  const onlyConfirmed =
    !detail &&
    patch.length > 0 &&
    patch.every((item) => /\/humanConfirmed$/.test(item.path) || /\/(provenance|rev|updatedAt|updatedBy|order)(\/|$)/.test(item.path)) &&
    patch.some((item) => /\/humanConfirmed$/.test(item.path));
  const note = revision.review?.note;
  const reason = revision.voided?.reason;
  const patchCount = revision.patch?.length ?? 0;

  switch (revision.op) {
    case 'insert':
      return detail ? `插入${detail}` : '插入内容';
    case 'create':
      return detail ? `新增${detail}` : '新增节点';
    case 'update':
      if (detail) return detail;
      if (onlyConfirmed) return '标记为已确认';
      return patchCount === 0 ? '无内容变化（仅推进版本）' : '修改内容';
    case 'delete':
      return detail ? `删除${detail}` : '删除节点';
    case 'move':
      return '调整段落顺序';
    case 'accept-ai':
      return detail ? `采纳 AI ${detail}` : '采纳一条 AI 建议';
    case 'reject-ai':
      return '拒绝一条 AI 建议';
    case 'sign':
      return '签章';
    case 'import':
      return '导入外部病历';
    case 'migrate':
      return '升级文档结构';
    case 'external':
      return '外部系统写入';
    case 'unlock':
      return '解锁（原签章作废）';
    case 'submit':
      return note ? `提交审核：${clip(note)}` : '提交审核';
    case 'review':
      if (revision.review?.decision === 'reject') return note ? `审核退回：${clip(note)}` : '审核退回';
      if (revision.review?.decision === 'submit') return '提交审核';
      return '审核通过（即签章）';
    case 'void':
      return reason ? `作废：${clip(reason)}` : '作废';
    case 'archive':
      return '归档';
    case 'revert':
      if (revision.revertedTo) return `回到第 ${revision.revertedTo.toRev} 版`;
      if (revision.revert) return `撤销第 ${revision.revert.revertedRev} 条`;
      return '回滚';
    default:
      return patchCount > 0 ? `变更 ${patchCount} 处` : '记录一笔';
  }
}
