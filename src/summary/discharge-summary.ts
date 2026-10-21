import type { NodeId } from '../model/types.ts';

export interface SummaryParagraph {
  nodeId: NodeId;
  text: string;
}

export interface SummarySection {
  code: string;
  title: string;
  paragraphs: SummaryParagraph[];
}

export interface SummaryDoc {
  docId: string;
  title: string;
  docTypeCode: string;
  createdAt: string;
  sections: SummarySection[];
}

export interface DeriveSource {
  docId: string;
  docTitle: string;
  sectionTitle: string;
  nodeId: NodeId;
  text: string;
  createdAt: string;
}

export type DeriveState = 'new' | 'same' | 'changed';

export interface DeriveItem {
  key: string;
  title: string;
  targetNodeId: NodeId | null;
  text: string;
  sources: DeriveSource[];
  state: DeriveState;
  current: string;
}

export type DeriveGapCode =
  | 'E_NO_SOURCE_DOC'
  | 'E_SOURCE_SECTION_MISSING'
  | 'E_SOURCE_EMPTY'
  | 'E_TARGET_SECTION_MISSING'
  | 'E_TARGET_EMPTY';

export interface DeriveGap {
  code: DeriveGapCode;
  title: string;
  detail: string;
  docId?: string;
}

export interface DischargeSummaryPlan {
  targetDocId: string;
  targetTitle: string;
  items: DeriveItem[];
  gaps: DeriveGap[];
  notes: string[];
}

const TARGETS: Array<{
  target: string;
  title: string;
  picks: Array<{ docTypeCode: string; docTypeLabel: string; sectionCode: string; merge?: boolean }>;
}> = [
  {
    target: 'admissionStatus',
    title: '入院情况',
    picks: [
      { docTypeCode: 'WST500.1', docTypeLabel: '入院记录', sectionCode: 'chiefComplaint', merge: true },
      { docTypeCode: 'WST500.1', docTypeLabel: '入院记录', sectionCode: 'presentIllness', merge: true },
    ],
  },
  {
    target: 'pastHistory',
    title: '既往史',
    picks: [{ docTypeCode: 'WST500.1', docTypeLabel: '入院记录', sectionCode: 'pastHistory' }],
  },
  {
    target: 'hospitalCourse',
    title: '住院经过',
    picks: [{ docTypeCode: 'WST500.3', docTypeLabel: '病程记录', sectionCode: 'conditionChange' }],
  },
  {
    target: 'dischargeDiagnosis',
    title: '出院诊断',
    picks: [
      { docTypeCode: 'WST500.3', docTypeLabel: '病程记录', sectionCode: 'diagnosis' },
      { docTypeCode: 'WST500.1', docTypeLabel: '入院记录', sectionCode: 'diagnosis' },
    ],
  },
  {
    target: 'dischargeAdvice',
    title: '出院医嘱',
    picks: [{ docTypeCode: 'WST500.3', docTypeLabel: '病程记录', sectionCode: 'plan' }],
  },
];

export const PARAGRAPH_JOINER = '；';

function joinTexts(texts: string[]): string {
  let out = '';
  for (const text of texts) {
    if (out === '') out = text;
    else out += /[。！？；]$/.test(out) ? text : `${PARAGRAPH_JOINER}${text}`;
  }
  return out;
}

export function planDischargeSummary(input: {
  currentDocId: string;
  docs: SummaryDoc[];
}): DischargeSummaryPlan {
  const docs = [...input.docs].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const targetDoc = docs.find((doc) => doc.docId === input.currentDocId);
  const items: DeriveItem[] = [];
  const gaps: DeriveGap[] = [];

  for (const rule of TARGETS) {
    const targetSection = targetDoc?.sections.find((section) => section.code === rule.target);
    const targetNodeId = targetSection?.paragraphs[0]?.nodeId ?? null;
    const current = (targetSection?.paragraphs ?? []).map((paragraph) => paragraph.text).join(PARAGRAPH_JOINER);

    if (!targetSection) {
      gaps.push({
        code: 'E_TARGET_SECTION_MISSING',
        title: rule.title,
        detail: `本次文书里没有「${rule.title}」这一章：派生内容无处可放，先在文书里建出这一章。`,
      });
    }

    const sources: DeriveSource[] = [];
    const pending: DeriveGap[] = [];
    const pushPending = (gap: DeriveGap): void => {
      if (pending.some((item) => item.code === gap.code && item.detail === gap.detail)) return;
      pending.push(gap);
    };
    let collected = false;
    for (const pick of rule.picks) {
      if (!pick.merge && collected) continue;

      const matchedDocs = docs.filter((doc) => doc.docTypeCode === pick.docTypeCode);
      if (matchedDocs.length === 0) {
        pushPending({
          code: 'E_NO_SOURCE_DOC',
          title: rule.title,
          detail: `本次就诊没有「${pick.docTypeLabel}」：无法派生「${rule.title}」。`,
        });
        continue;
      }

      let sectionSeen = false;
      let found = 0;
      for (const doc of matchedDocs) {
        const section = doc.sections.find((item) => item.code === pick.sectionCode);
        if (!section) continue;
        sectionSeen = true;
        for (const paragraph of section.paragraphs) {
          if (paragraph.text.trim() === '') continue;
          sources.push({
            docId: doc.docId,
            docTitle: doc.title,
            sectionTitle: section.title,
            nodeId: paragraph.nodeId,
            text: paragraph.text,
            createdAt: doc.createdAt,
          });
          found += 1;
          collected = true;
        }
      }
      if (!sectionSeen) {
        pushPending({
          code: 'E_SOURCE_SECTION_MISSING',
          title: rule.title,
          detail: `「${pick.docTypeLabel}」里没有可对应的章节（${pick.sectionCode}）：无法派生「${rule.title}」。`,
        });
      } else if (found === 0) {
        pushPending({
          code: 'E_SOURCE_EMPTY',
          title: rule.title,
          detail: `「${pick.docTypeLabel}」的对应章节是空的：没有原文可搬，不是"没有这个事实"。`,
        });
      }
    }

    if (sources.length === 0) {
      gaps.push(...pending);
      continue;
    }

    const text = joinTexts(sources.map((source) => source.text));
    const state: DeriveState = current.trim() === ''
      ? 'new'
      : current.trim() === text.trim() ? 'same' : 'changed';
    items.push({
      key: rule.target,
      title: rule.title,
      targetNodeId,
      text,
      sources,
      state,
      current,
    });
  }

  for (const item of items) {
    if (item.targetNodeId === null) continue;
    if (item.current.trim() === '' && item.text.trim() === '') {
      gaps.push({
        code: 'E_TARGET_EMPTY',
        title: item.title,
        detail: `「${item.title}」本次还是空的，也没有可派生的原文。`,
      });
    }
  }

  const notes: string[] = [
    '只做原文搬运：不改写、不摘要、不补全 —— 那些是医生的判断。',
    '生成的是建议，采纳后才写入正文；关键内容仍需人工确认。',
  ];
  if (items.some((item) => item.sources.length > 1)) {
    notes.push(`同一章有多个来源段落时以「${PARAGRAPH_JOINER}」连接（换行在文档里是段落边界，不是段内字符）。`);
  }
  if (items.some((item) => item.state === 'changed')) {
    notes.push('标为「有差异」的章节：本次已有内容与原文不一致，采纳会覆盖现有文字，请逐条核对。');
  }

  return {
    targetDocId: input.currentDocId,
    targetTitle: targetDoc?.title ?? input.currentDocId,
    items,
    gaps,
    notes,
  };
}

export interface ApplicabilityInput {
  visitType?: string | null;
  imported?: boolean;
}

export interface Applicability {
  applicable: boolean;
  /** 不可用时给人看的原因；可用时为 null */
  reason: string | null;
}

const VISIT_LABEL: Record<string, string> = { outpatient: '门诊', emergency: '急诊', 'physical-exam': '体检' };

export function dischargeSummaryApplicability(input: ApplicabilityInput): Applicability {
  const type = String(input.visitType ?? '');
  if (input.imported === true || type === '') return { applicable: true, reason: null };
  if (type === 'inpatient') return { applicable: true, reason: null };
  const label = VISIT_LABEL[type] ?? type;
  return {
    applicable: false,
    reason: `本次就诊是${label}，没有住院过程可汇总 —— 出院汇总只在住院病历上可用。`,
  };
}
