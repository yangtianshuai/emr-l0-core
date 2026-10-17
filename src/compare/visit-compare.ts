/**
 * 跨次就诊对比 —— 同一位患者、两次就诊的两份文书并排看。
 *
 * ## 它回答三个问题（且只回答这三个）
 *
 * 1) **是不是同一个诊断**：按 ICD 诊断编码比，编码级相等才算"同诊断"。
 *    正文里写没写"肺炎"不算 —— 那是语义判断，误报率无法在无评测集的前提下声称
 *    （与 `model/consistency.ts`、`qc/visit-timeline.ts` 拒绝语义判定的理由同一个）。
 * 2) **这次和上次差在哪**：按章节编码（`sectionCode`）对齐，逐段比原文，
 *    给出"新增了哪段 / 上次有哪段这次没了"。**不判断语义是否等价**：
 *    "发热 3 天"改成"反复发热三天"在这里是一次改写，不是"同一句"。
 * 3) **上次的用药/医嘱原文是什么**：只把上次"医嘱 / 用药 / 处理 / 治疗"那一章的**原文**
 *    原样交出来，供人决定要不要沿用。系统不抽取药名、不生成方案 ——
 *    这份模型里没有结构化的用药数据元，任何"提取药物清单"都只能是猜。
 *
 * ## 两条不许越界
 *
 * - **不做语义相似度**：没有评测集就报不出准确率，而错报"这两次一样"比不报更危险。
 * - **不替人写**：本模块只产出"对照结论"，落笔一律走建议通道（见 demo 的 carry-over）。
 *
 * ## 一个已知的不对称
 *
 * 两侧诊断都为空时 `sameDiagnosis` 必须是 `false` 且带原因 ——
 * "都是空"看起来相等，但那说明**没有可比的诊断**，不是"同一个诊断"。
 */

import type { DataElementTag, DocumentModel, NodeId, SectionNode } from '../model/types.ts';

/* ------------------------------ 输入 / 输出 ------------------------------ */

export interface CompareTag {
  system: string;
  code: string;
  display?: string;
}

export type SectionState = 'same' | 'changed' | 'added' | 'removed';

export interface SectionRow {
  /** 对齐键：优先 `sectionCode`，没有就用标题（两者都没有就用节点 id，等于只跟自己对上） */
  key: string;
  code: string | null;
  title: string;
  state: SectionState;
  /** 上次的段落原文（按文档顺序） */
  previous: string[];
  /** 这次的段落原文 */
  current: string[];
  /** 这次新增的段落（按这次文档顺序） */
  added: string[];
  /** 上次有、这次没有的段落（按上次文档顺序） */
  removed: string[];
}

export interface MedicationCarry {
  /** 上次"医嘱/用药/处理/治疗"章节的段落原文；给不出时为空数组 */
  paragraphs: string[];
  sectionTitle: string | null;
  code: string | null;
  /** 给不出的原因；能给出时为 null */
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
  /** 有差异的章节数（新增/删除/改写都算） */
  changedSections: number;
  medication: MedicationCarry;
  /** 这次对比的前提，必须显示给人看（否则"没差异"会被读成"没问题"） */
  notes: string[];
}

/* ------------------------------- 小工具 ------------------------------- */

const textOfNode = (node: DocumentModel['nodes'][string]): string => {
  if (node.type !== 'text') return '';
  return node.runs.map((run) => run.text).join('');
};

/** 诊断编码：只认 ICD 族（`ICD10` / `ICD-10` / `ICD9`…），其余数据元不参与"同诊断"判断 */
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

/** 节点所在的最近一层章节（走到根就返回 null：根上没有"章"这个概念） */
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

/** 章节按文档顺序排（`order` 是同级序号；跨级比较时用 id 兜底，保证结果可复现） */
function sectionsOf(doc: DocumentModel): SectionNode[] {
  return Object.values(doc.nodes)
    .filter((node): node is SectionNode => node.type === 'section')
    .sort((left, right) => ((left.order ?? 0) - (right.order ?? 0)) || left.id.localeCompare(right.id));
}

const sectionKeyOf = (section: SectionNode): string =>
  section.sectionCode && section.sectionCode !== '' ? section.sectionCode : (section.title ?? section.id);

/**
 * 段落级 LCS：只用来对齐，不用来算相似度。
 *
 * 字符级 diff 会把"发热 3 天"和"反复发热三天"拆成一地碎块，读起来比原文还慢；
 * 医生判断的是"这一段要不要"，所以对齐单位就是段落。
 */
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

/** 用药/医嘱类章节：按编码或标题认，认不出就不认（宁可说"给不出"） */
const MED_SECTION_CODE = /(order|medic|drug|treatment|plan|prescription)/i;
const MED_SECTION_TITLE = /(医嘱|用药|处方|处理|治疗)/;

function isMedicationSection(section: SectionNode): boolean {
  const code = String(section.sectionCode ?? '');
  const title = String(section.title ?? '');
  /* 编码命中要更严格：`plan` 可能指"诊疗计划"，那也正是用药最常出现的地方，认它 */
  if (code !== '' && MED_SECTION_CODE.test(code)) return true;
  return MED_SECTION_TITLE.test(title);
}

/* ------------------------------- 主函数 ------------------------------- */

export function compareVisits(previous: DocumentModel, current: DocumentModel): VisitCompare {
  const notes: string[] = [];

  /* ① 诊断 */
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

  /* ② 章节对齐 */
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
  /* 顺序：按本次文档的章节顺序，本次没有的（removed）排在后面 —— 人先看"这次有什么" */
  const currentOrder = new Map(currentSections.map((section, index) => [sectionKeyOf(section), index]));
  sections.sort((left, right) => {
    const leftIndex = currentOrder.get(left.key);
    const rightIndex = currentOrder.get(right.key);
    if (leftIndex === undefined && rightIndex === undefined) return left.key.localeCompare(right.key);
    if (leftIndex === undefined) return 1;
    if (rightIndex === undefined) return -1;
    return leftIndex - rightIndex;
  });

  /* ③ 上次的用药/医嘱原文 */
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
