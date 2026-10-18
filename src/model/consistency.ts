// 跨文书一致性检查（L2 · I6）。

import type { DataElementTag, MachineReadableBlock } from './types.ts';

export type ConsistencyKind = 'identity' | 'stable';

export interface ConsistencyDocRef {
  docId: string;
  block: MachineReadableBlock;
}

export interface ConsistencyIssue {
  kind: ConsistencyKind;
  /** 涉及的文书（与 `values` 一一对应，顺序一致） */
  docIds: string[];
  values: string[];
  /** 每条值所在节点（与 docIds 一一对应）：没有它，后续建议就落不到正确的位置  */
  anchorNodeIds: string[];
  tag: DataElementTag;
  /**
   * 展示级别。与旁挂注解同一约定：仅影响呈现，不参与任何门控 ——
   * 不阻塞签章、不拦截写操作。身份不一致很严重，但"严重"不等于
   * "让规则库拥有流程控制权"（一条误报就会让病历签不出去，而临床不会等规则）。
    */
  severity: 'warn' | 'block';
  message: string;
  /** 建议核对方向（给人话，不给模型话术） */
  hint: string;
}

export interface ConsistencyOptions {
  /** 追加"身份类"关键词（小写匹配 `code` 与 `display`） */
  identityKeywords?: string[];
  /** 追加"稳定事实类"关键词 */
  stableKeywords?: string[];
  /** 忽略这些 code（例如已知的历史遗留差异） */
  ignoreCodes?: string[];
}

/** 身份类：同一患者身上绝不该不同的项  */
const IDENTITY_KEYWORDS = ['sex', 'gender', 'birth', 'dob', 'patientid', 'patientno', 'mrn', 'idcard', '性别', '出生', '身份证'];

/**
 * 稳定事实类：医学上不该在同一患者身上变化的项。
 *
 *  只收"不该变"的；会变的（血压、体温、检验值、评分）一律不入列 ——
 * 把正常波动报成矛盾，是这类工具最常见的死法。
  */
const STABLE_KEYWORDS = ['allergy', 'allergen', 'bloodtype', 'abo', 'rh', 'pasthistory', 'past-history', '过敏', '血型', '既往'];

function normalized(value: unknown, valueText?: string): string {
  if (typeof valueText === 'string' && valueText.trim() !== '') return valueText.trim();
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function matches(tag: DataElementTag, keyword: string): boolean {
  const haystack = `${tag.code ?? ''} ${tag.display ?? ''}`.toLowerCase();
  return haystack.includes(keyword);
}

function classify(tag: DataElementTag, options: ConsistencyOptions): ConsistencyKind | null {
  const identity = [...IDENTITY_KEYWORDS, ...(options.identityKeywords ?? [])];
  const stable = [...STABLE_KEYWORDS, ...(options.stableKeywords ?? [])];
  if (identity.some((keyword) => matches(tag, keyword))) return 'identity';
  if (stable.some((keyword) => matches(tag, keyword))) return 'stable';
  return null;
}

/**
 * 比对多份文书（同一患者）的机读数据元。
 *
 * 只在同一编码出现不同值时报告；值相同、只有一份有、或不属于上述两类，
 * 一律不报。返回空数组是完全正常的结果（多数情况下就该是空的）。
  */
export function checkConsistency(docs: ConsistencyDocRef[], options: ConsistencyOptions = {}): ConsistencyIssue[] {
  /*  前置条件（由调用方保证）：`docs` 必须是已归一化为同一患者的文书组。
     真实环境里"同一个患者"要由患者主索引（`src/model/identity.ts`）判定 ——
     不同系统的文书各带各的号（门诊号 / 住院号 / 医保号 / 身份证），
     若在这里按 `patientId` 直接比较，要么永远不匹配，要么把两个患者报成矛盾。
     本函数不做任何患者判定：它假定"进来的就是一个人"，这个假定必须由调用方成立。  */
  if (docs.length < 2) return [];
  const ignore = new Set(options.ignoreCodes ?? []);
  /* 按 system + code 聚合：同一编码在不同文书里的取值 */
  const buckets = new Map<string, { tag: DataElementTag; byDoc: Map<string, { value: string; nodeId: string }> }>();

  for (const doc of docs) {
    for (const element of doc.block.dataElements ?? []) {
      const tag = element.tag;
      if (!tag || ignore.has(tag.code)) continue;
      const kind = classify(tag, options);
      if (!kind) continue;
      const key = `${tag.system}|${tag.code}`;
      const bucket = buckets.get(key) ?? { tag, byDoc: new Map<string, { value: string; nodeId: string }>() };
      const value = normalized(element.value, element.valueText);
      if (value === '') continue;
      /* 同一文书内重复取同一编码：保留第一个非空值（重复记录属于另一类问题） */
      if (!bucket.byDoc.has(doc.docId)) bucket.byDoc.set(doc.docId, { value, nodeId: element.nodeId ?? '' });
      buckets.set(key, bucket);
    }
  }

  const issues: ConsistencyIssue[] = [];
  for (const bucket of buckets.values()) {
    if (bucket.byDoc.size < 2) continue;
    const docIds = [...bucket.byDoc.keys()];
    const entries = docIds.map((id) => bucket.byDoc.get(id) as { value: string; nodeId: string });
    const values = entries.map((item) => item.value);
    if (new Set(values).size < 2) continue;
    const kind = classify(bucket.tag, options) as ConsistencyKind;
    const label = bucket.tag.display || bucket.tag.code;
    issues.push({
      kind,
      docIds,
      values,
      anchorNodeIds: entries.map((item) => item.nodeId),
      tag: bucket.tag,
      severity: kind === 'identity' ? 'block' : 'warn',
      message: `${label} 在不同文书中不一致：${docIds.map((id, index) => `${id}=${values[index]}`).join('，')}`,
      hint:
        kind === 'identity'
          ? '身份类信息在同一患者身上不该变化，请核对是否拿错了患者或文书'
          : '该事实项通常不该变化，请核对以哪一份为准，并修正另一份',
    });
  }

  /* 稳定问题（身份类）排在前面，便于界面按顺序处理 */
  return issues.sort((a, b) => (a.severity === 'block' ? -1 : 1) - (b.severity === 'block' ? -1 : 1));
}

/**
 * 把问题转成提示草稿（供上层落到涉及的每一份文书上）。
 *
 * 关键：每一份都收到提示，而不是只发给"非基准"的那几份 ——
 * 因为系统并不知道哪一份是对的。两份都"看起来对"时，自动挑一份当作基准来纠正另一份，
 * 等于系统替医生做了医学判断（而且判断依据只是"谁在前面"）。
 * 所以这里只陈述"它们不一致"，把"以哪一份为准"留给人和临床事实。
 *
 * 本函数只产出输入，不写任何文档：跨文书修正必须由人逐份决定。
  */
export function toSuggestionDrafts(issue: ConsistencyIssue): Array<{ docId: string; nodeId: string; text: string; promptId: string }> {
  const promptId = `consistency:${issue.tag.system}:${issue.tag.code}`;
  const label = issue.tag.display || issue.tag.code;
  return issue.docIds.map((docId, index) => {
    const others = issue.docIds
      .map((otherId, otherIndex) => (otherId === docId ? null : `${otherId}=${issue.values[otherIndex]}`))
      .filter((item): item is string => item !== null);
    return {
      docId,
      nodeId: issue.anchorNodeIds[index] as string,
      text: `${label} 与本患者其他文书的记录不一致（${others.join('，')}），请核对以哪一份为准`,
      promptId,
    };
  });
}
