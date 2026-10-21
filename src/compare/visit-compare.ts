import type { DataElementTag, DocumentModel, NodeId, SectionNode } from '../model/types.ts';

export interface CompareTag {
  system: string;
  code: string;
  display?: string;
}

export type SectionState = 'same' | 'changed' | 'added' | 'removed';

export interface SectionRow {
  key: string;
  code: string | null;
  title: string;
  state: SectionState;
  previous: string[];
  current: string[];
  added: string[];
  removed: string[];
}

export interface MedicationCarry {
  paragraphs: string[];
  sectionTitle: string | null;
  code: string | null;
  reason: string | null;
}

export interface VisitCompare {
  sameDiagnosis: boolean;
  diagnosis: {
    shared: CompareTag[];
    onlyPrevious: CompareTag[];
    onlyCurrent: CompareTag[];
    previousEmpty: boolean;
    currentEmpty: boolean;
  };
  sections: SectionRow[];
  changedSections: number;
  medication: MedicationCarry;
  /** 这次对比的前提，必须显示给人看（否则"没差异"会被读成"没问题"） */
  notes: string[];
}

const textOfNode = (node: DocumentModel['nodes'][string]): string => {
  if (node.type !== 'text') return '';
  return node.runs.map((run) => run.text).join('');
};

const isIcdTag = (tag: DataElementTag): boolean => /^icd/i.test(String(tag.system ?? ''));

function diagnosisOf(doc: DocumentModel): CompareTag[] {
  const out = new Map<string, CompareTag>();
  for (const node of Object.values(doc.nodes)) {
    const tags = node.type === 'text' || node.type === 'field' ? node.tags ?? [] : [];
    for (const tag of tags) {
      if (!isIcdTag(tag) || !tag.code) continue;
      const key = `${tag.system}|${tag.code}`;
      if (out.has(key)) continue;
      out.set(key, {
        system: tag.system,
        code: tag.code,
        ...(tag.display ? { display: tag.display } : {}),
      });
    }
  }
  return [...out.values()].sort((left, right) => `${left.system}|${left.code}`.localeCompare(`${right.system}|${right.code}`));
}

const keyOfTag = (tag: CompareTag): string => `${tag.system}|${tag.code}`;

function sectionOf(doc: DocumentModel, nodeId: NodeId): SectionNode | null {
  let cursor: NodeId | null = doc.nodes[nodeId]?.parentId ?? null;
  const guard = new Set<string>();
  while (cursor && !guard.has(cursor)) {
    guard.add(cursor);
    const node = doc.nodes[cursor];
    if (!node) return null;
    if (node.type === 'section') return node;
    cursor = node.parentId ?? null;
  }
  return null;
}

function sectionsOf(doc: DocumentModel): SectionNode[] {
  return Object.values(doc.nodes)
    .filter((node): node is SectionNode => node.type === 'section')
    .sort((left, right) => ((left.order ?? 0) - (right.order ?? 0)) || left.id.localeCompare(right.id));
}

const sectionKeyOf = (section: SectionNode): string =>
  section.sectionCode && section.sectionCode !== '' ? section.sectionCode : (section.title ?? section.id);

function diffParagraphs(previous: string[], current: string[]): { added: string[]; removed: string[] } {
  const rows = previous.length;
  const cols = current.length;
  const dp = Array.from({ length: rows + 1 }, () => new Array<number>(cols + 1).fill(0));
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      dp[i][j] = previous[i] === current[j]
        ? (dp[i + 1]?.[j + 1] ?? 0) + 1
        : Math.max(dp[i + 1]?.[j] ?? 0, dp[i]?.[j + 1] ?? 0);
    }
  }
  const added: string[] = [];
  const removed: string[] = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (previous[i] === current[j]) {
      i += 1;
      j += 1;
    } else if ((dp[i + 1]?.[j] ?? 0) >= (dp[i]?.[j + 1] ?? 0)) {
      removed.push(previous[i] as string);
      i += 1;
    } else {
      added.push(current[j] as string);
      j += 1;
    }
  }
  while (i < rows) { removed.push(previous[i] as string); i += 1; }
  while (j < cols) { added.push(current[j] as string); j += 1; }
  return { added, removed };
}

const MED_SECTION_CODE = /(order|medic|drug|treatment|plan|prescription)/i;
const MED_SECTION_TITLE = /(医嘱|用药|处方|处理|治疗)/;

function isMedicationSection(section: SectionNode): boolean {
  const code = String(section.sectionCode ?? '');
  const title = String(section.title ?? '');
  if (code !== '' && MED_SECTION_CODE.test(code)) return true;
  return MED_SECTION_TITLE.test(title);
}

export function compareVisits(previous: DocumentModel, current: DocumentModel): VisitCompare {
  const notes: string[] = [];

  const previousDiagnosis = diagnosisOf(previous);
  const currentDiagnosis = diagnosisOf(current);
  const currentKeys = new Set(currentDiagnosis.map(keyOfTag));
  const previousKeys = new Set(previousDiagnosis.map(keyOfTag));
  const shared = previousDiagnosis.filter((tag) => currentKeys.has(keyOfTag(tag)));
  const onlyPrevious = previousDiagnosis.filter((tag) => !currentKeys.has(keyOfTag(tag)));
  const onlyCurrent = currentDiagnosis.filter((tag) => !previousKeys.has(keyOfTag(tag)));
  const previousEmpty = previousDiagnosis.length === 0;
  const currentEmpty = currentDiagnosis.length === 0;
  /* 两侧都空 ⇒ 不是"同诊断"，是"没有可比的东西"。这条不对称必须显式表达 */
  const sameDiagnosis = shared.length > 0;
  if (previousEmpty) notes.push('上次文书里没有 ICD 诊断编码：无法判断是否同诊断。');
  if (currentEmpty) notes.push('本次文书里还没有 ICD 诊断编码：先把诊断写上，对比才有意义。');
  if (!previousEmpty && !currentEmpty && !sameDiagnosis) {
    notes.push('两次就诊的诊断编码没有交集：下面的对照仅供参考，不构成"同诊断复诊"。');
  }

  const previousSections = sectionsOf(previous);
  const currentSections = sectionsOf(current);
  const previousByKey = new Map<string, { section: SectionNode; paragraphs: string[] }>();
  for (const section of previousSections) {
    const paragraphs = Object.values(previous.nodes)
      .filter((node) => node.type === 'text' && sectionOf(previous, node.id)?.id === section.id)
      .sort((left, right) => ((left.order ?? 0) - (right.order ?? 0)) || left.id.localeCompare(right.id))
      .map((node) => textOfNode(node))
      .filter((text) => text !== '');
    previousByKey.set(sectionKeyOf(section), { section, paragraphs });
  }
  const currentByKey = new Map<string, { section: SectionNode; paragraphs: string[] }>();
  for (const section of currentSections) {
    const paragraphs = Object.values(current.nodes)
      .filter((node) => node.type === 'text' && sectionOf(current, node.id)?.id === section.id)
      .sort((left, right) => ((left.order ?? 0) - (right.order ?? 0)) || left.id.localeCompare(right.id))
      .map((node) => textOfNode(node))
      .filter((text) => text !== '');
    currentByKey.set(sectionKeyOf(section), { section, paragraphs });
  }

  const sections: SectionRow[] = [];
  const keys = new Set<string>([...previousByKey.keys(), ...currentByKey.keys()]);
  for (const key of keys) {
    const before = previousByKey.get(key);
    const after = currentByKey.get(key);
    const previousParagraphs = before?.paragraphs ?? [];
    const currentParagraphs = after?.paragraphs ?? [];
    const { added, removed } = diffParagraphs(previousParagraphs, currentParagraphs);
    const state: SectionState = !before
      ? 'added'
      : !after
        ? 'removed'
        : added.length === 0 && removed.length === 0
          ? 'same'
          : 'changed';
    sections.push({
      key,
      code: (after ?? before)?.section.sectionCode ?? null,
      title: (after ?? before)?.section.title ?? key,
      state,
      previous: previousParagraphs,
      current: currentParagraphs,
      added,
      removed,
    });
  }
  const currentOrder = new Map(currentSections.map((section, index) => [sectionKeyOf(section), index]));
  sections.sort((left, right) => {
    const leftIndex = currentOrder.get(left.key);
    const rightIndex = currentOrder.get(right.key);
    if (leftIndex === undefined && rightIndex === undefined) return left.key.localeCompare(right.key);
    if (leftIndex === undefined) return 1;
    if (rightIndex === undefined) return -1;
    return leftIndex - rightIndex;
  });

  let medication: MedicationCarry = { paragraphs: [], sectionTitle: null, code: null, reason: null };
  const medSection = previousSections.find(isMedicationSection);
  if (!medSection) {
    medication = {
      paragraphs: [],
      sectionTitle: null,
      code: null,
      reason: '上次就诊的文书里没有「医嘱 / 用药 / 处方 / 处理 / 治疗」这类章节：沿用什么、从哪一段沿用，都无从谈起。',
    };
  } else {
    const paragraphs = previousByKey.get(sectionKeyOf(medSection))?.paragraphs ?? [];
    if (paragraphs.length === 0) {
      medication = {
        paragraphs: [],
        sectionTitle: medSection.title ?? null,
        code: medSection.sectionCode ?? null,
        reason: '上次的用药/医嘱章节是空的。',
      };
    } else {
      medication = {
        paragraphs,
        sectionTitle: medSection.title ?? null,
        code: medSection.sectionCode ?? null,
        reason: null,
      };
    }
  }

  if (sections.every((row) => row.state === 'same')) {
    notes.push('两次文书的章节与段落逐字相同 —— 这是"没改动"，不是"没问题"。');
  }
  notes.push('对照只按章节编码与段落原文对齐：同义改写会被算作"改写"，不会被算作"相同"。');

  return {
    sameDiagnosis,
    diagnosis: { shared, onlyPrevious, onlyCurrent, previousEmpty, currentEmpty },
    sections,
    changedSections: sections.filter((row) => row.state !== 'same').length,
    medication,
    notes,
  };
}
