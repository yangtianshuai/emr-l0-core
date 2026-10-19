// 留痕的"人话摘要"：一条留痕改了什么，用一句话说出来。
//
// 为什么需要它：留痕本身是给机器回放用的（patch / 快照 / 哈希），
// 但界面与审计报告要回答的是人的问题 —— "这一版到底改了什么"。
// 让人去读 patch 数组，等于把可追溯做成了只有程序员能用的东西。
//
// 三条纪律：
//   1) 摘要只**描述**留痕，不参与任何判定（它不是审计字段，改了不影响验签与验链）；
//   2) 只挑"内容类"路径说（正文 / 字段值），伴随字段（provenance.at、rev、order、
//      humanConfirmed）一律略过 —— 那些每次编辑都会变，说出来是噪音；
//   3) 说不清就老实说"变更 N 处"，绝不编一个像样的说法。

import type { PatchOp, RevisionEntry } from '../model/types.ts';

const TEXT_PATH = /^\/nodes\/([^/]+)\/runs\/\d+\/text$/;
const VALUE_PATH = /^\/nodes\/([^/]+)\/(?:value|valueText|unit)$/;
const NODE_PATH = /^\/nodes\/([^/]+)$/;

/** 摘要里单处片段的字数上限（再长就不是"大概"了；`「旧」→「新」`两片段合计约 36 字） */
const CLIP = 16;

function clip(text: string, max = CLIP): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** 从 patch 的 value / oldValue 里取出可读文本（文本节点取 runs 拼接，字段取 valueText） */
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

/**
 * 挑出这一笔里最值得说的一处改动。
 *
 * 优先正文（runs.*.text），其次字段值（value/valueText/unit），最后整节点增删。
 * 同一笔里改了多处时只说第一处 —— 摘要的职责是"让人认出这是哪一版"，
 * 不是把 diff 复述一遍（要完整 diff 请看 patch 数或导出报告）。
 */
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

/** 把一处改动写成一句：`「旧」→「新」` / `插入「…」` / `删除「…」` */
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

/**
 * 一条留痕的人话摘要。
 *
 * 状态迁移类走各自的说法（它们的内容 patch 是空的，"改了什么"问的其实是"做了什么"）。
 */
export function summarizeRevision(revision: RevisionEntry): string {
  const patch = revision.patch ?? [];
  const change = pickChange(patch);
  const detail = describeChange(change);
  /* 挑不出内容改动时，别急着说"修改内容" —— 多数情况是"只动了确认标记"
     （每次落笔都会带 provenance.at，那是伴随字段，不算内容） */
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
      /* 空 patch 的 update 是真实存在的（重复保存、确认本身没有实质变化）：
         这时候说"修改内容"是在骗人 —— 什么都没改 */
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
