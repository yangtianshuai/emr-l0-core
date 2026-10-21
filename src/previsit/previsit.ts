import type { EvidenceRef, NodeId } from '../model/types.ts';

export interface PrevisitItem {
  key: string;
  label: string;
  text: string;
  reportedAt: string;
}

export interface PrevisitRecord {
  patientId: string;
  visitId?: string;
  submittedAt: string;
  source: string;
  items: PrevisitItem[];
}

export const PREVISIT_KEYS = ['chiefComplaint', 'presentIllness', 'pastHistory', 'allergy', 'medication', 'familyHistory'] as const;

export const PREVISIT_LABELS: Record<string, string> = {
  chiefComplaint: '主诉',
  presentIllness: '现病史',
  pastHistory: '既往史',
  allergy: '过敏史',
  medication: '用药',
  familyHistory: '家族史',
};

export const PREVISIT_SECTION: Record<string, string> = {
  chiefComplaint: 'chiefComplaint',
  presentIllness: 'presentIllness',
  pastHistory: 'pastHistory',
  allergy: 'pastHistory',
  medication: 'plan',
  familyHistory: 'pastHistory',
};

/** 单条文本上限：预问诊不是作文，超长输入更可能是误粘贴（如实拒掉，不截断） */
export const MAX_ITEM_CHARS = 2000;
/** 一次提交的条目上限 */
export const MAX_ITEMS = 32;

export interface IntakeRejected {
  ok: false;
  code: string;
  message: string;
}

export interface IntakeAccepted {
  ok: true;
  record: PrevisitRecord;
}

const isTime = (value: string): boolean => !Number.isNaN(Date.parse(value));

export function parsePrevisitIntake(input: unknown, now: string): IntakeAccepted | IntakeRejected {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, code: 'E_PREVISIT_BAD_BODY', message: '请求体必须是对象：{ patientId, visitId?, source?, items: [...] }' };
  }
  const body = input as Record<string, unknown>;
  const patientId = typeof body.patientId === 'string' ? body.patientId.trim() : '';
  if (patientId === '') return { ok: false, code: 'E_PREVISIT_NO_PATIENT', message: 'patientId 必填' };

  const rawItems = body.items;
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    return { ok: false, code: 'E_PREVISIT_NO_ITEMS', message: 'items 必须是非空数组（没有任何内容就没有可写的）' };
  }
  if (rawItems.length > MAX_ITEMS) {
    return { ok: false, code: 'E_PREVISIT_TOO_MANY', message: `items 最多 ${MAX_ITEMS} 条，收到 ${rawItems.length} 条` };
  }

  const allowed = new Set<string>(PREVISIT_KEYS);
  const seen = new Set<string>();
  const items: PrevisitItem[] = [];
  for (let index = 0; index < rawItems.length; index += 1) {
    const raw = rawItems[index];
    const position = index + 1;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, code: 'E_PREVISIT_BAD_ITEM', message: `第 ${position} 条不是对象` };
    }
    const item = raw as Record<string, unknown>;
    const key = typeof item.key === 'string' ? item.key.trim() : '';
    if (!allowed.has(key)) {
      return {
        ok: false,
        code: 'E_PREVISIT_UNKNOWN_KEY',
        message: `第 ${position} 条的 key「${key}」不在允许范围内（${PREVISIT_KEYS.join(' / ')}）`,
      };
    }
    if (seen.has(key)) {
      return { ok: false, code: 'E_PREVISIT_DUPLICATE_KEY', message: `第 ${position} 条的 key「${key}」重复：同一个字段只能有一条` };
    }
    seen.add(key);

    const text = typeof item.text === 'string' ? item.text.trim() : '';
    if (text === '') {
      return { ok: false, code: 'E_PREVISIT_EMPTY_TEXT', message: `第 ${position} 条（${key}）的 text 为空` };
    }
    if (text.length > MAX_ITEM_CHARS) {
      return {
        ok: false,
        code: 'E_PREVISIT_TEXT_TOO_LONG',
        message: `第 ${position} 条（${key}）超过 ${MAX_ITEM_CHARS} 字（收到 ${text.length} 字）：如实拒掉，不替你截断`,
      };
    }

    const reportedAt = typeof item.reportedAt === 'string' && item.reportedAt.trim() !== '' ? item.reportedAt.trim() : now;
    if (!isTime(reportedAt)) {
      return { ok: false, code: 'E_PREVISIT_BAD_TIME', message: `第 ${position} 条的 reportedAt 不是可解析的时间：${reportedAt}` };
    }

    const label = typeof item.label === 'string' && item.label.trim() !== ''
      ? item.label.trim()
      : (PREVISIT_LABELS[key] ?? key);

    items.push({ key, label, text, reportedAt });
  }

  const visitId = typeof body.visitId === 'string' && body.visitId.trim() !== '' ? body.visitId.trim() : undefined;
  const source = typeof body.source === 'string' && body.source.trim() !== '' ? body.source.trim() : 'previsit-api';

  return {
    ok: true,
    record: {
      patientId,
      ...(visitId === undefined ? {} : { visitId }),
      submittedAt: now,
      source,
      items,
    },
  };
}

export interface SectionAnchor {
  code: string;
  nodeId: NodeId | null;
}

export interface PrevisitDraft {
  key: string;
  label: string;
  text: string;
  reportedAt: string;
  nodeId: NodeId | null;
  sectionCode: string;
  evidence: EvidenceRef;
}

export function planPrevisitDrafts(record: PrevisitRecord, keys: string[], anchors: SectionAnchor[]): PrevisitDraft[] {
  const wanted = keys.length === 0 ? record.items.map((item) => item.key) : keys;
  const anchorOf = new Map(anchors.map((anchor) => [anchor.code, anchor.nodeId]));
  const drafts: PrevisitDraft[] = [];
  for (const item of record.items) {
    if (!wanted.includes(item.key)) continue;
    const sectionCode = PREVISIT_SECTION[item.key] ?? '';
    drafts.push({
      key: item.key,
      label: item.label,
      text: item.text,
      reportedAt: item.reportedAt,
      sectionCode,
      nodeId: sectionCode === '' ? null : (anchorOf.get(sectionCode) ?? null),
      evidence: {
        kind: 'patient',
        ref: `previsit:${record.patientId}@${record.submittedAt}`,
        field: item.key,
        valueText: item.text,
        capturedAt: item.reportedAt,
      },
    });
  }
  return drafts;
}
