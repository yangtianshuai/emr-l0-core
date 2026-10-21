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
  anchorNodeIds: string[];
  tag: DataElementTag;
  severity: 'warn' | 'block';
  message: string;
  hint: string;
}

export interface ConsistencyOptions {
  identityKeywords?: string[];
  stableKeywords?: string[];
  ignoreCodes?: string[];
}

const IDENTITY_KEYWORDS = ['sex', 'gender', 'birth', 'dob', 'patientid', 'patientno', 'mrn', 'idcard', '性别', '出生', '身份证'];

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

export function checkConsistency(docs: ConsistencyDocRef[], options: ConsistencyOptions = {}): ConsistencyIssue[] {
  if (docs.length < 2) return [];
  const ignore = new Set(options.ignoreCodes ?? []);
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

  return issues.sort((a, b) => (a.severity === 'block' ? -1 : 1) - (b.severity === 'block' ? -1 : 1));
}

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
