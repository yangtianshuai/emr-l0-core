/**
 * 出院汇总（出院小结派生 + 缺口核对）。
 *
 * ## 它做什么
 *
 * 医生写出院小结时，真正花时间的不是判断，是**把已经写在别处的事实再抄一遍**：
 * 入院情况来自入院记录、住院经过来自历次病程记录、出院医嘱来自诊治调整。
 * 这里把这些源文书的**原文**搬过来，并按目标章节组织好；同时逐条回答
 * "这一章为什么派生不出来"——缺哪份文书、缺哪一章、还是那一章本身是空的。
 *
 * ## 三条不许越界
 *
 * 1. **不改写**：搬运的是原文，不是摘要。摘要错了医生看不出来，原文错了他一眼能看出来。
 *    多个段落之间用「；」连接（换行在文档模型里是段落边界，不是段内字符）。
 * 2. **不落笔**：产出是 `DeriveItem`，交给调用方走建议通道；采纳与否是临床判断。
 * 3. **不猜**：源文书没有 / 源章节没有 / 源章节是空的，一律落成 `gap` 并说明原因，
 *    绝不"根据上下文补一句"。缺口核对的价值就在于**缺口本身**，补一句等于把缺口抹掉。
 *
 * ## 为什么缺口与条目分两栏
 *
 * "派生出了什么"和"缺什么"是两个问题。混在一起时，医生看到的是一堆条目，
 * 而"这次为什么没有出院医嘱"会藏在某条的空字段里 —— 那正是最容易被忽略的地方。
 */

import type { NodeId } from '../model/types.ts';

/* ------------------------------ 输入 ------------------------------ */

export interface SummaryParagraph {
  nodeId: NodeId;
  text: string;
}

export interface SummarySection {
  code: string;
  title: string;
  paragraphs: SummaryParagraph[];
}

/** 一份参与汇总的文书（调用方从文档模型摊平后传入，本模块不认识文档结构） */
export interface SummaryDoc {
  docId: string;
  title: string;
  /** WS/T 500 文档类型码，如 `WST500.1`（入院记录）/ `WST500.3`（病程记录） */
  docTypeCode: string;
  createdAt: string;
  sections: SummarySection[];
}

/* ------------------------------ 输出 ------------------------------ */

/** 来源：这一句原文出自哪份文书的哪个节点（界面据此跳回去） */
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
  /** 目标章节 code（也是批量生成建议时的勾选键） */
  key: string;
  title: string;
  /** 目标章节下的文本节点；没有这一章时为 null —— 此时**不能**生成建议 */
  targetNodeId: NodeId | null;
  text: string;
  sources: DeriveSource[];
  state: DeriveState;
  /** 本次文书这一章现有的文本（供界面并排看） */
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

/* ------------------------------ 规则表 ------------------------------ */

/**
 * 目标章节 ← 来源章节。
 *
 * `merge: true` 表示"无条件一并取"（入院情况要同时要主诉与现病史）；
 * 缺省表示"按顺序取第一个有内容的"（出院诊断先看病程记录，没有再退回入院记录的初步诊断）。
 *
 * 这张表是**临床口径**，不是技术口径：哪一章该复述哪一章，只有写病历的人能定。
 * 因此它放在一处、写得直白，改口径不改算法。
 */
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

/** 多段合并用的连接符（理由见文件头：换行是段落边界，不是段内字符） */
export const PARAGRAPH_JOINER = '；';

/**
 * 合并多段原文。
 *
 * 前一段已经以句末/分号收尾时**不再插入连接符**：否则会出现「……3天。；患者1年前……」这种
 * 一句话里带两个终止符的样子。插入与省略的判据只看原文最后一个字符 —— 不改动任何原有字符。
 */
function joinTexts(texts: string[]): string {
  let out = '';
  for (const text of texts) {
    if (out === '') out = text;
    else out += /[。！？；]$/.test(out) ? text : `${PARAGRAPH_JOINER}${text}`;
  }
  return out;
}

/* ------------------------------ 主函数 ------------------------------ */

/**
 * 生成派生计划。**纯函数**：不读库、不写文档、不看时钟。
 */
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
    /* 先记账、后判定：优先级更高的来源缺失时，**只有最终一条都没取到**才算缺口。
       否则会出现"出院诊断既有内容、又被报缺病程记录诊断章"的自相矛盾 ——
       那句提示会让医生以为还得去补一份病程诊断，而实际上他已经有可用的原文。 */
    const pending: DeriveGap[] = [];
    /**
     * 同一句缺口只说一次。
     *
     * 「入院情况」由主诉 + 现病史两个槽位组成，两者都指向入院记录；
     * 不去重时会连报两遍"本次就诊没有入院记录" —— 看起来像缺了两份文书。
     */
    const pushPending = (gap: DeriveGap): void => {
      if (pending.some((item) => item.code === gap.code && item.detail === gap.detail)) return;
      pending.push(gap);
    };
    let collected = false;
    for (const pick of rule.picks) {
      /* merge 的槽位无论前面有没有内容都要取；非 merge 的只在"还没有内容"时取，
         这样"病程记录有诊断就用病程的，没有才退回入院记录的初步诊断"是规则本身说清的，
         而不是靠遍历顺序碰巧成立 */
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

  /* 目标章存在但一个字都没有，同时也没有任何来源 —— 这是两个缺口叠在一起，
     分开说清：既没有原文可搬，也没有人写过。 */
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

/* --------------------------- 适用性（摆不摆这一栏） --------------------------- */

export interface ApplicabilityInput {
  /** 就诊类型（`outpatient` / `inpatient` / `emergency` / `physical-exam`；未知传空串） */
  visitType?: string | null;
  /**
   * 这份文书是否来自导入。
   *
   * 导入件没有可信的就诊类型：导入时只给了一条 `outpatient` 的占位记录
   * （见 demo 的 `V_IMPORT_*`）。按它判"门诊"会把一份真实的出院记录挡在门外，
   * 所以导入件一律**视为未知**，不做限制。
   */
  imported?: boolean;
}

export interface Applicability {
  applicable: boolean;
  /** 不可用时给人看的原因；可用时为 null */
  reason: string | null;
}

const VISIT_LABEL: Record<string, string> = { outpatient: '门诊', emergency: '急诊', 'physical-exam': '体检' };

/**
 * 「出院汇总」这一栏该不该出现在本次就诊上。
 *
 * 判据只有一条：**是不是住院**。理由不是"门诊没有出院小结"这种常识，
 * 而是这一栏的全部内容都来自住院过程（入院记录 / 病程记录 / 出院记录）——
 * 在门诊接诊上摆一个永远算不出来的入口，等于让人点进去再被拒一次。
 *
 * 两条"不限制"的边界（与模板的 `templateFitsVisit` 同口径：认不出就不挡）：
 *   · 就诊类型为空 —— 认不出，不能替人断言"这不是住院"；
 *   · 导入件 —— 类型是占位值，不可信。
 */
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
