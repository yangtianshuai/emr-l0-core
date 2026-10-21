import { hashValue } from '../model/hash.ts';
import type { JsonValue } from '../model/types.ts';
import { CONFIG_KEY_PREFIX, type ConfigKv } from '../storage/config-kv.ts';

export type ContentKind = 'phrase' | 'content-paragraph';

export type ContentScope = 'personal' | 'dept' | 'hospital';

export const CONTENT_LIMITS = {
  paragraphs: 40,
  /** 单段字符上限 */
  paragraphChars: 2000,
  /** 一条内容段落总字符上限 */
  totalChars: 20000,
  /** 名称上限（它是清单里的那一行） */
  nameChars: 60,
  phraseChars: 500,
  itemsPerScope: 200,
  /** 触发词上限（`fb`、`fbct` 这类短码；再长就不比打名字快了） */
  triggerChars: 12,
} as const;

export const CONTENT_TRIGGER_PREFIX = ';';

export interface ContentItem {
  id: string;
  kind: ContentKind;
  scope: ContentScope;
  owner?: string;
  name: string;
  trigger?: string;
  group?: string;
  paragraphs: string[];
  anchorHint?: string;
  note?: string;
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
}

export interface ContentScopeRef {
  scope: ContentScope;
  owner?: string;
}

export interface LoadedContent {
  items: ContentItem[];
  /** `empty` = 这一行没有（空就是空，不替你编一套默认内容） */
  source: 'store' | 'empty';
  updatedAt?: string;
  updatedBy?: string;
}

export type ContentErrorCode =
  | 'E_CONTENT_INVALID'
  | 'E_CONTENT_ITEM_NOT_FOUND'
  | 'E_CONTENT_LIMIT'
  | 'E_CONTENT_DUPLICATE_NAME'
  | 'E_CONTENT_DUPLICATE_TRIGGER';

export class ContentError extends Error {
  code: ContentErrorCode;

  constructor(code: ContentErrorCode, message: string) {
    super(message);
    this.name = 'ContentError';
    this.code = code;
  }
}

export const CONTENT_KEY_PREFIX = `${CONFIG_KEY_PREFIX}content.`;

export interface ContentUsageEntry {
  count: number;
  lastUsedAt: string;
  pinned?: boolean;
}
export type ContentUsage = Record<string, ContentUsageEntry>;

export const CONTENT_USAGE_KEY_PREFIX = `${CONTENT_KEY_PREFIX}usage.actor.`;

export const CONTENT_USAGE_LIMIT = 600;

export function contentUsageKeyOf(actorId: string): string {
  const actor = String(actorId ?? '').trim();
  if (actor === '') {
    throw new ContentError('E_CONTENT_INVALID', '使用记录必须指明账号：没有账号就没有"我常用哪几条"这件事');
  }
  return `${CONTENT_USAGE_KEY_PREFIX}${actor}`;
}

export function contentUsageItemKeyOf(item: Pick<ContentItem, 'scope' | 'owner' | 'id'>): string {
  return `${item.scope}:${item.owner ?? ''}:${item.id}`;
}

interface StoredUsage {
  version: 1;
  entries: ContentUsage;
}

export interface LoadedUsage {
  usage: ContentUsage;
  error: string | null;
}

export function loadContentUsage(kv: ConfigKv, actorId: string): LoadedUsage {
  const key = contentUsageKeyOf(actorId);
  let parsed: StoredUsage | null;
  try {
    parsed = kv.read<StoredUsage>(key);
  } catch (err) {
    return { usage: {}, error: `使用记录「${key}」读不出来（排序退化成按名字，正文不受影响）：${(err as Error).message}` };
  }
  if (parsed === null) return { usage: {}, error: null };
  if (
    parsed.version !== 1
    || parsed.entries === null
    || typeof parsed.entries !== 'object'
    || Array.isArray(parsed.entries)
  ) {
    return { usage: {}, error: `使用记录「${key}」的结构不认识（排序退化成按名字，正文不受影响）` };
  }
  const usage: ContentUsage = {};
  for (const [itemKey, raw] of Object.entries(parsed.entries as Record<string, unknown>)) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const record = raw as Record<string, unknown>;
    const count = typeof record.count === 'number' && Number.isFinite(record.count) && record.count > 0
      ? Math.trunc(record.count)
      : 0;
    const lastUsedAt = typeof record.lastUsedAt === 'string' ? record.lastUsedAt : '';
    const pinned = record.pinned === true;
    if (!pinned && (count <= 0 || lastUsedAt === '')) continue;
    usage[itemKey] = { count, lastUsedAt, ...(pinned ? { pinned: true } : {}) };
  }
  return { usage, error: null };
}

export function markContentUsed(
  kv: ConfigKv,
  actorId: string,
  item: Pick<ContentItem, 'scope' | 'owner' | 'id'>,
  at: string = new Date().toISOString(),
): ContentUsage {
  const key = contentUsageKeyOf(actorId);
  const { usage } = loadContentUsage(kv, actorId);
  const itemKey = contentUsageItemKeyOf(item);
  const previous = usage[itemKey];
  usage[itemKey] = {
    count: (previous?.count ?? 0) + 1,
    lastUsedAt: at,
    ...(previous?.pinned === true ? { pinned: true } : {}),
  };
  persistUsage(kv, key, usage);
  return usage;
}

export function setContentPinned(
  kv: ConfigKv,
  actorId: string,
  item: Pick<ContentItem, 'scope' | 'owner' | 'id'>,
  pinned: boolean,
  at: string = new Date().toISOString(),
): ContentUsage {
  const key = contentUsageKeyOf(actorId);
  const { usage } = loadContentUsage(kv, actorId);
  const itemKey = contentUsageItemKeyOf(item);
  const previous = usage[itemKey];
  if (pinned) {
    usage[itemKey] = {
      count: previous?.count ?? 0,
      lastUsedAt: previous?.lastUsedAt ?? at,
      pinned: true,
    };
  } else if (previous) {
    const next = { count: previous.count, lastUsedAt: previous.lastUsedAt };
    if (next.count <= 0 && next.lastUsedAt === '') delete usage[itemKey];
    else usage[itemKey] = next;
  }
  persistUsage(kv, key, usage);
  return usage;
}

/** 落盘 + 上限收敛：置顶的那些不能被"最久未用"挤掉 */
function persistUsage(kv: ConfigKv, key: string, usage: ContentUsage): void {
  const keys = Object.keys(usage);
  if (keys.length > CONTENT_USAGE_LIMIT) {
    keys.sort((left, right) => {
      const leftPin = usage[left].pinned === true ? 1 : 0;
      const rightPin = usage[right].pinned === true ? 1 : 0;
      if (leftPin !== rightPin) return leftPin - rightPin;
      return usage[left].lastUsedAt < usage[right].lastUsedAt ? -1 : 1;
    });
    for (const stale of keys.slice(0, keys.length - CONTENT_USAGE_LIMIT)) delete usage[stale];
  }
  const stored: StoredUsage = { version: 1, entries: usage };
  kv.write(key, stored);
}

interface StoredContent {
  version: 1;
  items: ContentItem[];
  updatedAt: string;
  updatedBy: string;
}

const SCOPE_ORDER: Record<ContentScope, number> = { personal: 0, dept: 1, hospital: 2 };

export function isContentScope(value: unknown): value is ContentScope {
  return value === 'personal' || value === 'dept' || value === 'hospital';
}

export function contentKeyOf(target: ContentScopeRef): string {
  if (!isContentScope(target.scope)) {
    throw new ContentError('E_CONTENT_INVALID', `作用域只能是 personal / dept / hospital，收到：${String(target.scope)}`);
  }
  const owner = typeof target.owner === 'string' ? target.owner.trim() : '';
  if (target.scope === 'personal') {
    if (owner === '') {
      throw new ContentError('E_CONTENT_INVALID', '个人内容库必须指明是谁的（owner = 账号）：没有账号就没有"我的常用语"这件事');
    }
    return `${CONTENT_KEY_PREFIX}actor.${owner}`;
  }
  if (target.scope === 'dept') {
    if (owner === '') {
      throw new ContentError('E_CONTENT_INVALID', '科室内容库必须指明科室编码（owner = 科室编码）；编码为空时"限本科"是句无法判定的话');
    }
    return `${CONTENT_KEY_PREFIX}dept.${owner}`;
  }
  return `${CONTENT_KEY_PREFIX}hospital`;
}

const PLACEHOLDER_PATTERN = /\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g;

export function placeholdersOf(paragraphs: string[]): string[] {
  const out: string[] = [];
  for (const paragraph of paragraphs) {
    PLACEHOLDER_PATTERN.lastIndex = 0;
    let matched = PLACEHOLDER_PATTERN.exec(paragraph);
    while (matched) {
      const path = matched[1];
      if (!out.includes(path)) out.push(path);
      matched = PLACEHOLDER_PATTERN.exec(paragraph);
    }
  }
  return out;
}

export function contentFingerprintOf(item: Pick<ContentItem, 'kind' | 'name' | 'paragraphs' | 'group' | 'anchorHint'>): string {
  const projection = {
    kind: item.kind,
    name: item.name,
    group: item.group ?? null,
    anchorHint: item.anchorHint ?? null,
    paragraphs: item.paragraphs,
  };
  return hashValue(projection as unknown as JsonValue).slice(0, 12);
}

export function contentRefOf(item: ContentItem): string {
  return `content:${item.id}@${contentFingerprintOf(item)}`;
}

export function normalizeForCompare(text: string): string {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，。；、,.;:!?！？（）()【】\[\]《》<>“”"'’‘—\-]/g, '');
}

export function contentNameKeyOf(name: string): string {
  return normalizeForCompare(name);
}

function bigramsOf(text: string): string[] {
  const chars = Array.from(normalizeForCompare(text));
  if (chars.length < 2) return chars;
  const out: string[] = [];
  for (let index = 0; index + 1 < chars.length; index += 1) out.push(`${chars[index]}${chars[index + 1]}`);
  return out;
}

export function similarityOf(left: string, right: string): number {
  const a = bigramsOf(left);
  const b = bigramsOf(right);
  if (a.length === 0 || b.length === 0) return 0;
  if (a.length === 1 || b.length === 1) {
    return normalizeForCompare(left) === normalizeForCompare(right) ? 1 : 0;
  }
  const counts = new Map<string, number>();
  for (const gram of a) counts.set(gram, (counts.get(gram) ?? 0) + 1);
  let shared = 0;
  for (const gram of b) {
    const left = counts.get(gram) ?? 0;
    if (left > 0) {
      shared += 1;
      counts.set(gram, left - 1);
    }
  }
  return (2 * shared) / (a.length + b.length);
}

export interface SimilarContentHit {
  item: ContentItem;
  score: number;
}

export interface SimilarContentResult {
  exact: ContentItem | null;
  similar: SimilarContentHit[];
}

export function findSimilarContent(
  items: ContentItem[],
  candidate: { name: string; paragraphs: string[] },
  options: { threshold?: number; limit?: number } = {},
): SimilarContentResult {
  const threshold = options.threshold ?? 0.6;
  const limit = options.limit ?? 3;
  const nameKey = contentNameKeyOf(candidate.name);
  const text = (candidate.paragraphs || []).join('\n');
  const exact = nameKey === '' ? null : (items.find((item) => contentNameKeyOf(item.name) === nameKey) ?? null);
  const similar: SimilarContentHit[] = [];
  for (const item of items) {
    if (exact !== null && item.id === exact.id) continue;
    const score = Math.max(similarityOf(text, item.paragraphs.join('\n')), similarityOf(candidate.name, item.name));
    if (score >= threshold) similar.push({ item, score: Math.round(score * 100) / 100 });
  }
  similar.sort((left, right) => right.score - left.score);
  return { exact, similar: similar.slice(0, limit) };
}

function assertNameFree(items: ContentItem[], name: string, exceptId?: string): void {
  const key = contentNameKeyOf(name);
  const clash = items.find((item) => item.id !== exceptId && contentNameKeyOf(item.name) === key);
  if (clash) {
    throw new ContentError(
      'E_CONTENT_DUPLICATE_NAME',
      `这个内容库里已经有「${clash.name}」（${clash.id}）：清单靠名字区分，重名就说不清该带入哪一条 —— 改个名字，或者直接改那一条`,
    );
  }
}

function normalizeParagraphs(raw: unknown, kind: ContentKind): string[] {
  let list: string[];
  if (typeof raw === 'string') {
    list = raw.split(/\r?\n/);
  } else if (Array.isArray(raw)) {
    list = raw.map((value) => String(value ?? ''));
  } else {
    throw new ContentError('E_CONTENT_INVALID', '内容必须是字符串或字符串数组（段落顺序即落笔顺序）');
  }
  if (kind === 'phrase' && (typeof raw === 'string' ? /\r?\n/.test(raw.trim()) : list.length > 1)) {
    throw new ContentError(
      'E_CONTENT_INVALID',
      '常用语是一行话：要存多段内容请建"内容段落"（两者落笔方式不同 —— 常用语插进当前这一句，内容段落另起段落）',
    );
  }
  const paragraphs = list.map((value) => value.trim()).filter((value) => value !== '');
  if (paragraphs.length === 0) {
    throw new ContentError('E_CONTENT_INVALID', '内容是空的（或全是空白行）：空条目插进去什么都不会发生');
  }
  if (paragraphs.length > CONTENT_LIMITS.paragraphs) {
    throw new ContentError(
      'E_CONTENT_LIMIT',
      `最多 ${CONTENT_LIMITS.paragraphs} 段（收到 ${paragraphs.length} 段）：一次插进去半份病历，人不会逐段核对它`,
    );
  }
  let total = 0;
  paragraphs.forEach((paragraph, index) => {
    if (paragraph.length > CONTENT_LIMITS.paragraphChars) {
      throw new ContentError(
        'E_CONTENT_LIMIT',
        `第 ${index + 1} 段 ${paragraph.length} 字，超过上限 ${CONTENT_LIMITS.paragraphChars}`,
      );
    }
    total += paragraph.length;
  });
  if (kind === 'phrase' && paragraphs[0].length > CONTENT_LIMITS.phraseChars) {
    throw new ContentError(
      'E_CONTENT_LIMIT',
      `常用语 ${paragraphs[0].length} 字，超过上限 ${CONTENT_LIMITS.phraseChars}：这么长的一段应该建成"内容段落"`,
    );
  }
  if (total > CONTENT_LIMITS.totalChars) {
    throw new ContentError('E_CONTENT_LIMIT', `总字数 ${total} 超过上限 ${CONTENT_LIMITS.totalChars}`);
  }
  return paragraphs;
}

function normalizeName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (name === '') {
    throw new ContentError('E_CONTENT_INVALID', '名称必须是非空字符串（它是清单里那一行）');
  }
  if (name.length > CONTENT_LIMITS.nameChars) {
    throw new ContentError('E_CONTENT_LIMIT', `名称 ${name.length} 字，超过上限 ${CONTENT_LIMITS.nameChars}`);
  }
  return name;
}

const TRIGGER_PATTERN = /^[a-z0-9\u4e00-\u9fa5_-]{1,12}$/;

function normalizeTrigger(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') throw new ContentError('E_CONTENT_INVALID', '触发词必须是字符串');
  const value = raw.trim().toLowerCase();
  if (value === '') return undefined;
  if (!TRIGGER_PATTERN.test(value)) {
    throw new ContentError(
      'E_CONTENT_INVALID',
      `触发词「${value}」只能用字母 / 数字 / 汉字 / 下划线 / 横线，最多 ${CONTENT_LIMITS.triggerChars} 个字符（空格与标点是"打完了"的判据，不能进触发词）`,
    );
  }
  return value;
}

/** 同一行内不许两个条目共用一个触发词：打出来只能说清一条 */
function assertTriggerFree(items: ContentItem[], trigger: string, exceptId?: string): void {
  const clash = items.find((item) => item.id !== exceptId && item.trigger === trigger);
  if (clash) {
    throw new ContentError(
      'E_CONTENT_DUPLICATE_TRIGGER',
      `触发词「${CONTENT_TRIGGER_PREFIX}${trigger}」已经属于「${clash.name}」（${clash.id}）：正文里打出来只能说清一条 —— 换一个，或者改那一条`,
    );
  }
}

function normalizeOptionalText(raw: unknown, label: string, limit: number): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') throw new ContentError('E_CONTENT_INVALID', `${label}必须是字符串`);
  const value = raw.trim();
  if (value === '') return undefined;
  if (value.length > limit) throw new ContentError('E_CONTENT_LIMIT', `${label} ${value.length} 字，超过上限 ${limit}`);
  return value;
}

export function validateContentItems(raw: unknown, target: ContentScopeRef): ContentItem[] {
  if (!Array.isArray(raw)) {
    throw new ContentError('E_CONTENT_INVALID', '内容清单必须是数组');
  }
  const items: ContentItem[] = [];
  const seen = new Set<string>();
  raw.forEach((entry, index) => {
    const position = `第 ${index + 1} 项`;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new ContentError('E_CONTENT_INVALID', `${position}不是一个内容条目`);
    }
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    if (id === '') throw new ContentError('E_CONTENT_INVALID', `${position}缺 id（改与删都靠它定位）`);
    if (seen.has(id)) throw new ContentError('E_CONTENT_INVALID', `id「${id}」出现了两次：改与删就没有确定目标`);
    seen.add(id);
    if (record.kind !== 'phrase' && record.kind !== 'content-paragraph') {
      throw new ContentError('E_CONTENT_INVALID', `${position}（${id}）的 kind 只能是 phrase / content-paragraph`);
    }
    const kind = record.kind as ContentKind;
    if (!isContentScope(record.scope)) {
      throw new ContentError('E_CONTENT_INVALID', `${position}（${id}）的 scope 只能是 personal / dept / hospital`);
    }
    const scope = record.scope as ContentScope;
    if (scope !== target.scope) {
      throw new ContentError(
        'E_CONTENT_INVALID',
        `${position}（${id}）标着「${scope}」，却存在「${target.scope}」这一行里：私稿与共用资产不能混行`,
      );
    }
    const owner = typeof record.owner === 'string' ? record.owner.trim() : '';
    if (scope !== 'hospital' && owner === '') {
      throw new ContentError('E_CONTENT_INVALID', `${position}（${id}）缺 owner（个人 = 账号，科室 = 科室编码）`);
    }
    if (scope !== 'hospital' && target.owner !== undefined && owner !== target.owner.trim()) {
      throw new ContentError(
        'E_CONTENT_INVALID',
        `${position}（${id}）标着属于「${owner}」，却存在「${target.owner}」那一行里：内容库一行只装一个人的 / 一个科的`,
      );
    }
    const paragraphs = normalizeParagraphs(record.paragraphs, kind);
    if (kind === 'phrase' && paragraphs.length !== 1) {
      throw new ContentError('E_CONTENT_INVALID', `${position}（${id}）是常用语，只能有一段`);
    }
    const trigger = normalizeTrigger(record.trigger);
    if (trigger !== undefined) assertTriggerFree(items, trigger);
    const item: ContentItem = {
      id,
      kind,
      scope,
      ...(scope === 'hospital' ? {} : { owner }),
      name: normalizeName(record.name),
      ...(trigger !== undefined ? { trigger } : {}),
      ...(normalizeOptionalText(record.group, '分组', CONTENT_LIMITS.nameChars) !== undefined
        ? { group: normalizeOptionalText(record.group, '分组', CONTENT_LIMITS.nameChars) as string }
        : {}),
      paragraphs,
      ...(normalizeOptionalText(record.anchorHint, '建议落点', CONTENT_LIMITS.nameChars) !== undefined
        ? { anchorHint: normalizeOptionalText(record.anchorHint, '建议落点', CONTENT_LIMITS.nameChars) as string }
        : {}),
      ...(normalizeOptionalText(record.note, '说明', CONTENT_LIMITS.paragraphChars) !== undefined
        ? { note: normalizeOptionalText(record.note, '说明', CONTENT_LIMITS.paragraphChars) as string }
        : {}),
      createdAt: typeof record.createdAt === 'string' && record.createdAt !== '' ? record.createdAt : '',
      updatedAt: typeof record.updatedAt === 'string' && record.updatedAt !== '' ? record.updatedAt : '',
      updatedBy: typeof record.updatedBy === 'string' ? record.updatedBy : '',
    };
    items.push(item);
  });
  if (items.length > CONTENT_LIMITS.itemsPerScope) {
    throw new ContentError(
      'E_CONTENT_LIMIT',
      `一个作用域最多 ${CONTENT_LIMITS.itemsPerScope} 条（收到 ${items.length}）：再多清单本身就没法用了`,
    );
  }
  return items;
}

function readStored(kv: ConfigKv, key: string): StoredContent | null {
  let parsed: StoredContent | null;
  try {
    parsed = kv.read<StoredContent>(key);
  } catch (err) {
    throw new ContentError(
      'E_CONTENT_INVALID',
      `内容库「${key}」读不出来，拒绝按"没有内容"继续（那会让"我的常用语没了"看起来像从没存过）：${(err as Error).message}`,
    );
  }
  if (parsed === null) return null;
  if (parsed.version !== 1) {
    throw new ContentError('E_CONTENT_INVALID', `内容库「${key}」的结构版本是 ${String(parsed.version)}，本版本只认 1`);
  }
  return parsed;
}

export function loadContent(kv: ConfigKv, target: ContentScopeRef): LoadedContent {
  const key = contentKeyOf(target);
  const stored = readStored(kv, key);
  if (!stored) return { items: [], source: 'empty' };
  return {
    items: validateContentItems(stored.items, target),
    source: 'store',
    updatedAt: stored.updatedAt,
    updatedBy: stored.updatedBy,
  };
}

export interface SaveContentOptions {
  at?: string;
}

export function saveContent(
  kv: ConfigKv,
  target: ContentScopeRef,
  rawItems: unknown,
  by: string,
  options: SaveContentOptions = {},
): LoadedContent {
  const key = contentKeyOf(target);
  const items = validateContentItems(rawItems, target);
  const stored: StoredContent = {
    version: 1,
    items,
    updatedAt: options.at ?? new Date().toISOString(),
    updatedBy: by,
  };
  kv.write(key, stored);
  return loadContent(kv, target);
}

export interface ContentListRow {
  scope: ContentScope;
  owner?: string;
  count: number;
  error: string | null;
}

export interface ContentListResult {
  items: ContentItem[];
  rows: ContentListRow[];
  errors: string[];
  usageError?: string;
  pinnedKeys: string[];
}

export function listContentFor(
  kv: ConfigKv,
  viewer: { actorId: string; deptCode?: string },
): ContentListResult {
  const targets: ContentScopeRef[] = [{ scope: 'personal', owner: viewer.actorId }];
  if (viewer.deptCode !== undefined && viewer.deptCode !== '') {
    targets.push({ scope: 'dept', owner: viewer.deptCode });
  }
  targets.push({ scope: 'hospital' });

  const items: ContentItem[] = [];
  const rows: ContentListRow[] = [];
  const errors: string[] = [];
  for (const target of targets) {
    try {
      const loaded = loadContent(kv, target);
      items.push(...loaded.items);
      rows.push({ scope: target.scope, ...(target.owner ? { owner: target.owner } : {}), count: loaded.items.length, error: null });
    } catch (err) {
      const message = (err as Error).message;
      errors.push(message);
      rows.push({ scope: target.scope, ...(target.owner ? { owner: target.owner } : {}), count: 0, error: message });
    }
  }
  const actor = String(viewer.actorId ?? '').trim();
  const usage = actor === '' ? { usage: {}, error: null } : loadContentUsage(kv, actor);

  items.sort((a, b) => {
    const scopeGap = SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope];
    if (scopeGap !== 0) return scopeGap;
    const leftEntry = usage.usage[contentUsageItemKeyOf(a)];
    const rightEntry = usage.usage[contentUsageItemKeyOf(b)];
    const leftPin = leftEntry?.pinned === true ? 1 : 0;
    const rightPin = rightEntry?.pinned === true ? 1 : 0;
    if (leftPin !== rightPin) return rightPin - leftPin;
    const leftUsed = leftEntry?.lastUsedAt ?? '';
    const rightUsed = rightEntry?.lastUsedAt ?? '';
    if (leftUsed !== rightUsed) return leftUsed < rightUsed ? 1 : -1;
    const groupGap = (a.group ?? '').localeCompare(b.group ?? '', 'zh-Hans-CN');
    return groupGap !== 0 ? groupGap : a.name.localeCompare(b.name, 'zh-Hans-CN');
  });
  const pinnedKeys = Object.keys(usage.usage).filter((key) => usage.usage[key].pinned === true);
  return {
    items,
    rows,
    errors,
    pinnedKeys,
    ...(usage.error !== null ? { usageError: usage.error } : {}),
  };
}

export function findContentItem(kv: ConfigKv, target: ContentScopeRef, itemId: string): ContentItem | undefined {
  return loadContent(kv, target).items.find((item) => item.id === itemId);
}

function nextContentId(items: ContentItem[], kind: ContentKind): string {
  const prefix = kind === 'phrase' ? 'phr.' : 'cp.';
  const pattern = new RegExp(`^${prefix.replace('.', '\\.')}(\\d+)$`);
  let seq = 1;
  for (const item of items) {
    const matched = pattern.exec(item.id);
    if (matched) seq = Math.max(seq, Number(matched[1]) + 1);
  }
  return `${prefix}${seq}`;
}

export interface ContentDraftInput {
  kind: ContentKind;
  name: string;
  paragraphs: string[] | string;
  trigger?: string;
  group?: string;
  anchorHint?: string;
  note?: string;
}

export interface ContentPatchInput {
  name?: string;
  paragraphs?: string[] | string;
  trigger?: string | null;
  group?: string | null;
  anchorHint?: string | null;
  note?: string | null;
}

export function addContent(
  kv: ConfigKv,
  target: ContentScopeRef,
  input: ContentDraftInput,
  by: string,
  options: SaveContentOptions = {},
): { item: ContentItem; loaded: LoadedContent } {
  const loaded = loadContent(kv, target);
  if (loaded.items.length >= CONTENT_LIMITS.itemsPerScope) {
    throw new ContentError(
      'E_CONTENT_LIMIT',
      `这个作用域已经有 ${loaded.items.length} 条，达到上限 ${CONTENT_LIMITS.itemsPerScope}：先删掉不再用的`,
    );
  }
  if (input.kind !== 'phrase' && input.kind !== 'content-paragraph') {
    throw new ContentError('E_CONTENT_INVALID', 'kind 只能是 phrase（常用语）或 content-paragraph（内容段落）');
  }
  const at = options.at ?? new Date().toISOString();
  const itemName = normalizeName(input.name);
  assertNameFree(loaded.items, itemName);
  const itemTrigger = normalizeTrigger(input.trigger);
  if (itemTrigger !== undefined) assertTriggerFree(loaded.items, itemTrigger);
  const item: ContentItem = {
    id: nextContentId(loaded.items, input.kind),
    kind: input.kind,
    scope: target.scope,
    ...(target.scope === 'hospital' ? {} : { owner: String(target.owner).trim() }),
    name: itemName,
    ...(itemTrigger !== undefined ? { trigger: itemTrigger } : {}),
    paragraphs: normalizeParagraphs(input.paragraphs, input.kind),
    ...(normalizeOptionalText(input.group, '分组', CONTENT_LIMITS.nameChars) !== undefined
      ? { group: normalizeOptionalText(input.group, '分组', CONTENT_LIMITS.nameChars) as string }
      : {}),
    ...(normalizeOptionalText(input.anchorHint, '建议落点', CONTENT_LIMITS.nameChars) !== undefined
      ? { anchorHint: normalizeOptionalText(input.anchorHint, '建议落点', CONTENT_LIMITS.nameChars) as string }
      : {}),
    ...(normalizeOptionalText(input.note, '说明', CONTENT_LIMITS.paragraphChars) !== undefined
      ? { note: normalizeOptionalText(input.note, '说明', CONTENT_LIMITS.paragraphChars) as string }
      : {}),
    createdAt: at,
    updatedAt: at,
    updatedBy: by,
  };
  return { item, loaded: saveContent(kv, target, [...loaded.items, item], by, options) };
}

export function patchContent(
  kv: ConfigKv,
  target: ContentScopeRef,
  itemId: string,
  patch: ContentPatchInput,
  by: string,
  options: SaveContentOptions = {},
): { item: ContentItem; loaded: LoadedContent } {
  const loaded = loadContent(kv, target);
  const index = loaded.items.findIndex((item) => item.id === itemId);
  if (index < 0) {
    throw new ContentError('E_CONTENT_ITEM_NOT_FOUND', `这个内容库里没有「${itemId}」（改与删都按 id 定位）`);
  }
  if (
    patch.name === undefined && patch.paragraphs === undefined && patch.trigger === undefined
    && patch.group === undefined && patch.anchorHint === undefined && patch.note === undefined
  ) {
    throw new ContentError('E_CONTENT_INVALID', '没有要改的字段（这里开放名称 / 内容 / 触发词 / 分组 / 建议落点 / 说明）');
  }
  const current = loaded.items[index];
  const next: ContentItem = { ...current, updatedAt: options.at ?? new Date().toISOString(), updatedBy: by };
  if (patch.name !== undefined) {
    next.name = normalizeName(patch.name);
    assertNameFree(loaded.items, next.name, current.id);
  }
  if (patch.trigger !== undefined) {
    if (patch.trigger === null) delete next.trigger;
    else {
      const trigger = normalizeTrigger(patch.trigger);
      if (trigger === undefined) delete next.trigger;
      else {
        assertTriggerFree(loaded.items, trigger, current.id);
        next.trigger = trigger;
      }
    }
  }
  if (patch.paragraphs !== undefined) next.paragraphs = normalizeParagraphs(patch.paragraphs, current.kind);
  if (patch.group !== undefined) {
    if (patch.group === null) delete next.group;
    else {
      const group = normalizeOptionalText(patch.group, '分组', CONTENT_LIMITS.nameChars);
      if (group === undefined) delete next.group;
      else next.group = group;
    }
  }
  if (patch.anchorHint !== undefined) {
    if (patch.anchorHint === null) delete next.anchorHint;
    else {
      const hint = normalizeOptionalText(patch.anchorHint, '建议落点', CONTENT_LIMITS.nameChars);
      if (hint === undefined) delete next.anchorHint;
      else next.anchorHint = hint;
    }
  }
  if (patch.note !== undefined) {
    if (patch.note === null) delete next.note;
    else {
      const note = normalizeOptionalText(patch.note, '说明', CONTENT_LIMITS.paragraphChars);
      if (note === undefined) delete next.note;
      else next.note = note;
    }
  }
  const items = loaded.items.slice();
  items[index] = next;
  return { item: next, loaded: saveContent(kv, target, items, by, options) };
}

export function removeContent(
  kv: ConfigKv,
  target: ContentScopeRef,
  itemId: string,
  by: string,
  options: SaveContentOptions = {},
): LoadedContent {
  const loaded = loadContent(kv, target);
  if (!loaded.items.some((item) => item.id === itemId)) {
    throw new ContentError('E_CONTENT_ITEM_NOT_FOUND', `这个内容库里没有「${itemId}」（删按 id 定位）`);
  }
  return saveContent(kv, target, loaded.items.filter((item) => item.id !== itemId), by, options);
}

export interface ContentView {
  id: string;
  kind: ContentKind;
  scope: ContentScope;
  owner?: string;
  name: string;
  trigger?: string;
  pinned?: boolean;
  group?: string;
  paragraphs: string[];
  paragraphCount: number;
  preview: string;
  placeholders: string[];
  anchorHint?: string;
  note?: string;
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
  ref: string;
}

export function describeContent(item: ContentItem): ContentView {
  const first = item.paragraphs[0] ?? '';
  return {
    id: item.id,
    kind: item.kind,
    scope: item.scope,
    ...(item.owner !== undefined ? { owner: item.owner } : {}),
    name: item.name,
    ...(item.trigger !== undefined ? { trigger: item.trigger } : {}),
    ...(item.group !== undefined ? { group: item.group } : {}),
    paragraphs: [...item.paragraphs],
    paragraphCount: item.paragraphs.length,
    preview: first.length > 48 ? `${first.slice(0, 48)}…` : first,
    placeholders: placeholdersOf(item.paragraphs),
    ...(item.anchorHint !== undefined ? { anchorHint: item.anchorHint } : {}),
    ...(item.note !== undefined ? { note: item.note } : {}),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    updatedBy: item.updatedBy,
    ref: contentRefOf(item),
  };
}

export function describeContentList(result: ContentListResult): Record<string, unknown> {
  return {
    items: result.items.map((item) => {
      const view = describeContent(item);
      return result.pinnedKeys.includes(contentUsageItemKeyOf(item)) ? { ...view, pinned: true } : view;
    }),
    rows: result.rows,
    errors: result.errors,
  };
}

export const CONTENT_SCOPE_LABELS: Record<ContentScope, string> = {
  personal: '我的',
  dept: '本科室',
  hospital: '全院',
};

export const CONTENT_KIND_LABELS: Record<ContentKind, string> = {
  phrase: '常用语',
  'content-paragraph': '内容段落',
};
