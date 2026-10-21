import { hashValue } from '../model/hash.ts';
import type { JsonValue } from '../model/types.ts';

export type PackKind = 'template' | 'rule' | 'term';

export const PACK_KINDS: readonly PackKind[] = ['template', 'rule', 'term'];

export interface PackItemBase {
  itemId: string;
  enabled?: boolean;
}

export interface PackManifest {
  packId: string;
  kind: PackKind;
  name: string;
  engineApi: string;
  vendor?: string;
  scope?: string;
  createdAt?: string;
  description?: string;
}

export interface Pack<TItem extends PackItemBase = PackItemBase> extends PackManifest {
  items: TItem[];
}

/** 引擎侧声明"我支持哪些契约"。按类别分列：规则包不能声称自己是模板引擎  */
export type SupportedEngineApis = Record<PackKind, readonly string[]>;

export type PackErrorCode =
  | 'E_PACK_NOT_OBJECT'
  | 'E_PACK_FIELD_MISSING'
  | 'E_PACK_FIELD_INVALID'
  | 'E_PACK_KIND_UNKNOWN'
  | 'E_PACK_ITEMS_EMPTY'
  | 'E_PACK_ITEM_ID_DUPLICATE'
  | 'E_PACK_ENGINE_API_UNSUPPORTED'
  | 'E_PACK_DUPLICATE'
  | 'E_PACK_ITEM_CONFLICT'
  | 'E_PACK_NOT_LOADED'
  | 'E_PACK_ITEM_UNKNOWN';

export class KnowledgePackError extends Error {
  code: PackErrorCode;

  constructor(code: PackErrorCode, message: string) {
    super(message);
    this.name = 'KnowledgePackError';
    this.code = code;
  }
}

const PACK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** 清单允许出现的键。未知键一律拒绝：拼错的字段名会被静默忽略，而"改了没生效"最难查  */
const MANIFEST_KEYS = new Set([
  'packId',
  'kind',
  'name',
  'engineApi',
  'vendor',
  'scope',
  'createdAt',
  'description',
  'items',
]);

function asPlainObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function optionalString(source: Record<string, unknown>, key: string, packId: string): string | undefined {
  const value = source[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new KnowledgePackError('E_PACK_FIELD_INVALID', `包「${packId}」的字段 ${key} 必须是非空字符串，实际 ${typeof value}`);
  }
  return value;
}

function requiredString(source: Record<string, unknown>, key: string, label: string): string {
  const value = source[key];
  if (value === undefined || value === null) {
    throw new KnowledgePackError('E_PACK_FIELD_MISSING', `包缺少必填字段 ${key}（${label}）`);
  }
  if (typeof value !== 'string' || value.trim() === '') {
    throw new KnowledgePackError('E_PACK_FIELD_INVALID', `包的字段 ${key} 必须是非空字符串，实际 ${typeof value}`);
  }
  return value;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function validatePack(input: unknown, supported: SupportedEngineApis): Pack {
  const source = asPlainObject(input);
  if (!source) {
    throw new KnowledgePackError('E_PACK_NOT_OBJECT', `包必须是对象，实际 ${Array.isArray(input) ? 'array' : typeof input}`);
  }

  for (const key of Object.keys(source)) {
    if (!MANIFEST_KEYS.has(key)) {
      throw new KnowledgePackError('E_PACK_FIELD_INVALID', `包里出现未知字段「${key}」：拼错的字段名会被静默忽略，而"改了没生效"最难查`);
    }
  }

  const packId = requiredString(source, 'packId', '全局唯一标识');
  if (!PACK_ID_PATTERN.test(packId)) {
    throw new KnowledgePackError('E_PACK_FIELD_INVALID', `包标识「${packId}」不合规：只允许字母/数字开头，后续为字母、数字、点、下划线、短横`);
  }

  const kindValue = requiredString(source, 'kind', '包类别');
  if (!(PACK_KINDS as readonly string[]).includes(kindValue)) {
    throw new KnowledgePackError('E_PACK_KIND_UNKNOWN', `包「${packId}」的类别「${kindValue}」未知：只支持 ${PACK_KINDS.join(' / ')}`);
  }
  const kind = kindValue as PackKind;

  const name = requiredString(source, 'name', '人读名称');

  const engineApi = requiredString(source, 'engineApi', '引擎契约版本');
  const allowed = supported[kind] ?? [];
  if (!allowed.includes(engineApi)) {
    throw new KnowledgePackError(
      'E_PACK_ENGINE_API_UNSUPPORTED',
      allowed.length === 0
        ? `包「${packId}」声明契约 ${engineApi}，但本机**尚未实现**该类别的引擎（${kind}）：装进去也没有任何东西会用它，因此拒绝装载`
        : `包「${packId}」声明契约 ${engineApi}，本机 ${kind} 支持的是 ${allowed.join(' / ')}：契约不匹配时按新契约解释旧包会"成功但读错"，故拒绝装载`,
    );
  }

  const itemsValue = source.items;
  if (!Array.isArray(itemsValue)) {
    throw new KnowledgePackError('E_PACK_FIELD_MISSING', `包「${packId}」缺少条目数组 items`);
  }
  if (itemsValue.length === 0) {
    throw new KnowledgePackError('E_PACK_ITEMS_EMPTY', `包「${packId}」没有任何条目：空包几乎总是导出/拼装出错，而不是"故意为空"`);
  }

  const seen = new Set<string>();
  const items: PackItemBase[] = [];
  for (const raw of itemsValue) {
    const item = asPlainObject(raw);
    if (!item) {
      throw new KnowledgePackError('E_PACK_FIELD_INVALID', `包「${packId}」的条目必须是对象`);
    }
    const itemId = requiredString(item, 'itemId', '包内唯一标识');
    if (seen.has(itemId)) {
      throw new KnowledgePackError('E_PACK_ITEM_ID_DUPLICATE', `包「${packId}」内条目标识「${itemId}」重复：同一条规则出现两次，界面与开关都会分不清是哪一条`);
    }
    seen.add(itemId);

    const enabledValue = item.enabled;
    if (enabledValue !== undefined && typeof enabledValue !== 'boolean') {
      throw new KnowledgePackError('E_PACK_FIELD_INVALID', `包「${packId}」条目「${itemId}」的 enabled 必须是布尔，实际 ${typeof enabledValue}`);
    }

    items.push({ ...item, enabled: enabledValue === undefined ? true : enabledValue } as unknown as PackItemBase);
  }

  return {
    packId,
    kind,
    name,
    engineApi,
    ...(source.vendor !== undefined ? { vendor: optionalString(source, 'vendor', packId) } : {}),
    ...(source.scope !== undefined ? { scope: optionalString(source, 'scope', packId) } : {}),
    ...(source.createdAt !== undefined ? { createdAt: optionalString(source, 'createdAt', packId) } : {}),
    ...(source.description !== undefined ? { description: optionalString(source, 'description', packId) } : {}),
    items,
  };
}

export function packContentProjection(pack: Pack): Record<string, unknown> {
  return {
    packId: pack.packId,
    kind: pack.kind,
    name: pack.name,
    engineApi: pack.engineApi,
    ...(pack.vendor !== undefined ? { vendor: pack.vendor } : {}),
    ...(pack.scope !== undefined ? { scope: pack.scope } : {}),
    ...(pack.createdAt !== undefined ? { createdAt: pack.createdAt } : {}),
    ...(pack.description !== undefined ? { description: pack.description } : {}),
    items: pack.items.map((item) => {
      const { enabled, ...rest } = item as unknown as Record<string, unknown>;
      void enabled;
      return rest;
    }),
  };
}

export function packFingerprintOf(pack: Pack, length = 12): string {
  return hashValue(packContentProjection(pack) as unknown as JsonValue).slice(0, length);
}

export interface PackItemSummary {
  itemId: string;
  enabled: boolean;
}

export interface PackSummary {
  packId: string;
  kind: PackKind;
  name: string;
  engineApi: string;
  vendor: string | null;
  scope: string | null;
  description: string | null;
  itemCount: number;
  enabledItemCount: number;
  items: PackItemSummary[];
  loadedAt: string;
}

function summarize(pack: Pack, loadedAt: string): PackSummary {
  const items = pack.items.map((item) => ({ itemId: item.itemId, enabled: item.enabled !== false }));
  return {
    packId: pack.packId,
    kind: pack.kind,
    name: pack.name,
    engineApi: pack.engineApi,
    vendor: pack.vendor ?? null,
    scope: pack.scope ?? null,
    description: pack.description ?? null,
    itemCount: items.length,
    enabledItemCount: items.filter((item) => item.enabled).length,
    items,
    loadedAt,
  };
}

export class PackRegistry {
  private readonly packs = new Map<string, { pack: Pack; loadedAt: string }>();

  private readonly supported: SupportedEngineApis;

  constructor(supported: SupportedEngineApis) {
    this.supported = supported;
  }

  load(input: unknown, options: { replace?: boolean; validate?: (pack: Pack) => void } = {}): PackSummary {
    const pack = validatePack(input, this.supported);
    options.validate?.(pack);

    const existing = this.packs.get(pack.packId);
    if (existing && !options.replace) {
      const same = JSON.stringify(existing.pack) === JSON.stringify(pack);
      throw new KnowledgePackError(
        'E_PACK_DUPLICATE',
        `包「${pack.packId}」已装载（${same ? '两份内容逐字节相同' : '两份内容不同'}）：同一个 packId 只对应一份内容，要换掉它必须显式声明 replace`,
      );
    }

    for (const [otherId, other] of this.packs) {
      if (otherId === pack.packId) continue;
      if (other.pack.kind !== pack.kind) continue;
      for (const item of pack.items) {
        if (other.pack.items.some((candidate) => candidate.itemId === item.itemId)) {
          throw new KnowledgePackError(
            'E_PACK_ITEM_CONFLICT',
            `条目「${item.itemId}」已被包「${otherId}」占用（同属 ${pack.kind} 类）：两条同名条目"谁生效"只能靠装载顺序，而顺序不该决定判定结果`,
          );
        }
      }
    }

    const loadedAt = new Date().toISOString();
    const stored = { pack: cloneJson(pack), loadedAt };
    this.packs.set(pack.packId, stored);
    return summarize(stored.pack, loadedAt);
  }

  unload(packId: string): boolean {
    return this.packs.delete(packId);
  }

  clear(): void {
    this.packs.clear();
  }

  /** 已装载的包（只读：返回的是内部对象，调用方不得修改）  */
  get(packId: string): Pack | undefined {
    return this.packs.get(packId)?.pack;
  }

  list(kind?: PackKind): PackSummary[] {
    return [...this.packs.entries()]
      .filter(([, entry]) => !kind || entry.pack.kind === kind)
      .map(([, entry]) => summarize(entry.pack, entry.loadedAt))
      .sort((left, right) => left.packId.localeCompare(right.packId));
  }

  setItemEnabled(packId: string, itemId: string, enabled: boolean): PackSummary {
    const entry = this.packs.get(packId);
    if (!entry) {
      throw new KnowledgePackError('E_PACK_NOT_LOADED', `包「${packId}」尚未装载，无法设置开关`);
    }
    const item = entry.pack.items.find((candidate) => candidate.itemId === itemId);
    if (!item) {
      throw new KnowledgePackError('E_PACK_ITEM_UNKNOWN', `包「${packId}」里没有条目「${itemId}」`);
    }
    item.enabled = enabled;
    return summarize(entry.pack, entry.loadedAt);
  }

  activeItemsOf(kind: PackKind): Array<{ packId: string; item: PackItemBase }> {
    const result: Array<{ packId: string; item: PackItemBase }> = [];
    for (const [packId, entry] of [...this.packs.entries()].sort((left, right) => left[0].localeCompare(right[0]))) {
      if (entry.pack.kind !== kind) continue;
      for (const item of entry.pack.items) {
        if (item.enabled !== false) result.push({ packId, item });
      }
    }
    return result;
  }

  contentFingerprint(): string {
    const payload = this.sortedPacks().map(([, entry]) => packContentProjection(entry.pack)) as unknown as JsonValue;
    return hashValue(payload);
  }

  effectiveFingerprint(): string {
    const payload = this.sortedPacks().map(([, entry]) => ({
      content: packContentProjection(entry.pack),
      disabled: entry.pack.items.filter((item) => item.enabled === false).map((item) => item.itemId),
    })) as unknown as JsonValue;
    return hashValue(payload);
  }

  private sortedPacks(): Array<[string, { pack: Pack; loadedAt: string }]> {
    return [...this.packs.entries()].sort((left, right) => left[0].localeCompare(right[0]));
  }
}

/** 供上层与界面引用的一条硬事实：包不是文档内容，不进签名  */
export const PACK_NOT_IN_DOCUMENT = true;
