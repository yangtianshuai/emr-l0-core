// 知识资产包 · 通用层（模板包 / 规则包 / 术语包共用）。

import { hashValue } from '../model/hash.ts';
import type { JsonValue } from '../model/types.ts';

/**
 * 包的三类。刻意只有三类：模板（怎么写）、规则（怎么判）、术语（怎么叫）。
 * 加第四类之前必须先回答"它的产出归属哪一层" —— 否则这一层会退化成"什么都能往里塞"。
  */
export type PackKind = 'template' | 'rule' | 'term';

export const PACK_KINDS: readonly PackKind[] = ['template', 'rule', 'term'];

/** 包内条目的公共字段（各类别自己再加字段） */
export interface PackItemBase {
  itemId: string;
  /**
   * 包内开关。它是运行时策略，不属于包内容：
   * 改它不改变 `contentFingerprint()`（"载的是哪一版"），只改变 `effectiveFingerprint()`
   * （"实际生效的是什么"）。两者分开报，才能回答"是包换了还是只是关了条规则"。
    */
  enabled?: boolean;
}

/**
 * 包清单。全部字段都是可直接随文件交付的元数据，没有任何可执行内容。
  */
export interface PackManifest {
  /** 全局唯一标识（如 `qc.form.builtin`）。它就是这份内容的名字：同 ID 即同一个包  */
  packId: string;
  kind: PackKind;
  /** 人读名称（界面展示用） */
  name: string;
  engineApi: string;
  /** 交付方（专科包要能独立交付，也要能追责） */
  vendor?: string;
  /** 专科 / 场景标签（如 `respiratory`），用于回答"这台机器该载哪些包" */
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

/**
 * 校验并归一化一个包。
 *
 * 归一化的含义：只保留清单允许的字段，`enabled` 一律补成布尔（缺省 `true`）。
 * 于是运行时的包结构是确定的，上层不必到处写 `enabled !== false`。
  */
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

    /* 通用层不认识类别专有字段（如规则包的 predicate），但必须原样保留：
       它们随后由上层校验并编译。这里只补 `enabled` 的缺省值。
       （`as unknown as` 是因为条目在本层只有 `itemId/enabled` 两个已知字段，
       而实际形状更宽 —— 类型上收窄不等于运行时截断字段。）  */
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
  /** 装载时间：回答"这份内容是什么时候进来的"，与配置指纹同类用途 */
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

/**
 * 包注册表：装载 / 卸载 / 开关 / 冲突判定 / 指纹。
 *
 * 一次装载是原子的：要么整包进入注册表，要么一个字都不进。
 * 不做"部分装载"——半个包在界面上看起来同样是"装好了"。
  */
export class PackRegistry {
  private readonly packs = new Map<string, { pack: Pack; loadedAt: string }>();

  private readonly supported: SupportedEngineApis;

  constructor(supported: SupportedEngineApis) {
    this.supported = supported;
  }

  /**
   * 装载一个包（`input` 是外部数据，必须先校验）。
   *
   * 两类冲突都在这里判定：
   *   - 包级：同 `packId` 已在册 → `E_PACK_DUPLICATE`（除非显式 `replace`）。
   *     不允许"悄悄覆盖"：覆盖会让人以为"装的还是原来那份内容"，而实际判定已经换了。
   *     报错里会说明两份内容是否逐字节相同 —— 这决定了"我重复灌了同一个包"
   *     与"我改内容却没声明 replace"该往哪个方向查。
   *   - 条目级：同类别下 `itemId` 已被别的包占用 → `E_PACK_ITEM_CONFLICT`。
   *     两条规则同名时，"哪一条赢"只能靠顺序 —— 而顺序是最不该决定判定结果的东西。
   *
   * `validate` 是类别专有校验的钩子（通用层不认识 `predicate` 这类字段）：
   * 规则包在这里把自己的描述符过一遍，于是"参数写错"在装包那一刻就报错，
   * 而不是等医生点了"跑质控"才发现少了一条。它先于冲突判定执行 ——
   * 包自身的缺陷比环境冲突更该被先报出来。
    */
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

  /** 打开/关闭包内某一条目。开关是运行时策略，不写回包、不改变内容指纹  */
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

  /** 某类别下启用中的条目（保持包内顺序；跨包按 packId 排序）  */
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

  /**
   * 内容指纹：回答"现在跑的是哪一份内容"。只由包内容决定，与条目开关无关。
   *
   * 必须覆盖完整内容（每条规则的谓词与参数都在内）。早先这一层只取 `itemId`，
   * 于是"改了规则参数"指纹不变 —— 那时还能拿版本号兜底；版本号删掉之后，
   * 指纹是唯一能回答"判定标准变没变"的东西，一个不随内容变的指纹会把
   * "改了没生效"与"生效了但没人知道"混成同一件事。
    */
  contentFingerprint(): string {
    const payload = this.sortedPacks().map(([, entry]) => packContentProjection(entry.pack)) as unknown as JsonValue;
    return hashValue(payload);
  }

  /** 生效指纹：回答"实际在跑的是什么"。在内容之上再纳入被停用的条目  */
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
