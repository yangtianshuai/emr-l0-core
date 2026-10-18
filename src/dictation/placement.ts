// 落位层：把"一段文本"映射成落点的可配置策略。

import type { DocumentIndex } from '../model/indexes.ts';
import { TAG_SYSTEMS, type DataElementTag, type NodeId } from '../model/types.ts';
import type { TranscriptSegment } from '../core/dictation.ts';

export type PlacementStrategy = 'ordered' | 'section-title' | 'term-table' | 'external';

export const PLACEMENT_STRATEGIES: readonly PlacementStrategy[] = ['ordered', 'section-title', 'term-table', 'external'];

export interface PlacementCandidateConfig {
  /**
   * 只允许文本节点。固定为 `true`，不是开关 ——
   * `WriteSession.dictate` 会硬拒非文本节点，配置层声称能放宽就是"撒了一个内核不认的谎"。
    */
  onlyTextNodes: true;
  /** 限定在这些章节之下（匹配祖先 `sectionCode` / `title`，任一相等即算命中）；空 = 全文文本节点 */
  withinSections?: string[];
}

export interface DictationPlacementConfig {
  strategy: PlacementStrategy;
  candidate: PlacementCandidateConfig;
  /** `section-title` 策略：章节标题 / 别名 → 目标节点 id（key 是该段文本里会出现的词） */
  sectionMap?: Record<string, string>;
  /** `term-table` 策略：关键词 → 目标节点 id（按最长匹配优先） */
  termMap?: Array<{ match: string; nodeId: string }>;
  /**
   * 即时结构化（V4）：词 → 数据元标签（key 是该段文本里会出现的词）。
   *
   * 与 `sectionMap` 共用同一个匹配器（`matchLongest`：最长匹配优先），但结论与表都分开：
   * 落位答"这段放哪一章"（结论是节点），结构化答"这段算什么数据元"（结论是标签）。
   * 两者共用匹配器是为了"最长匹配优先"这类语义只有一处；表分开则是因为它们的真值不同 ——
   * 拿落位规则顶替标签，会把"这一章放对了"读成"这个数据元对了"。
   *
   * 未命中时不打标（`null`）：标签会进机读信息、被导出与下游系统直接消费，
   * 猜错比不打更糟（与落位"未命中落在光标处"的兜底方向相反，那条兜的是"位置"）。
    */
  structureMap?: Record<string, DataElementTag>;
  external?: { endpoint?: string; timeoutMs?: number };
  /** 落位建议的置信度上限，必须 < 关键内容阈值 0.90  */
  confidenceCeiling: number;
}

export const KEY_CONTENT_THRESHOLD = 0.9;
export const DEFAULT_CONFIDENCE_CEILING = 0.85;

export const DEFAULT_PLACEMENT_CONFIG: DictationPlacementConfig = {
  strategy: 'ordered',
  candidate: { onlyTextNodes: true },
  confidenceCeiling: DEFAULT_CONFIDENCE_CEILING,
};

export type PlacementConfigErrorCode =
  | 'E_PLACEMENT_CONFIG_INVALID'
  | 'E_PLACEMENT_CEILING_TOO_HIGH'
  | 'E_PLACEMENT_EXTERNAL_REQUIRES_ASYNC';

export class PlacementConfigError extends Error {
  code: PlacementConfigErrorCode;

  constructor(code: PlacementConfigErrorCode, message: string) {
    super(message);
    this.name = 'PlacementConfigError';
    this.code = code;
  }
}

function isStrategy(value: unknown): value is PlacementStrategy {
  return typeof value === 'string' && (PLACEMENT_STRATEGIES as readonly string[]).includes(value);
}

/**
 * 校验配置。非法值一律报错，不静默取默认 ——
 * "帮你改成默认值"会让运维以为自己配的东西生效了（与 `ai/model-config.ts` 同一个病根）。
  */
export function validatePlacementConfig(input: Partial<DictationPlacementConfig>): DictationPlacementConfig {
  const strategy = input.strategy ?? DEFAULT_PLACEMENT_CONFIG.strategy;
  if (!isStrategy(strategy)) {
    throw new PlacementConfigError(
      'E_PLACEMENT_CONFIG_INVALID',
      `strategy 只能是 ${PLACEMENT_STRATEGIES.join(' / ')}，实际 ${JSON.stringify(input.strategy)}`,
    );
  }

  /* C3：内核只接受文本节点，配置层不得声称能放宽 */
  const onlyTextNodes = input.candidate?.onlyTextNodes ?? true;
  if (onlyTextNodes !== true) {
    throw new PlacementConfigError(
      'E_PLACEMENT_CONFIG_INVALID',
      'candidate.onlyTextNodes 只能是 true：内核的 dictate 会硬拒非文本节点，放开它只会造出一个"内核不认的开关"',
    );
  }

  /* C1：上限必须低于关键内容阈值 */
  const ceiling = input.confidenceCeiling ?? DEFAULT_CONFIDENCE_CEILING;
  if (typeof ceiling !== 'number' || !Number.isFinite(ceiling) || ceiling <= 0) {
    throw new PlacementConfigError(
      'E_PLACEMENT_CONFIG_INVALID',
      `confidenceCeiling 必须是 0~1 的有限正数，实际 ${JSON.stringify(input.confidenceCeiling)}（拒绝静默取默认值）`,
    );
  }
  if (ceiling >= KEY_CONTENT_THRESHOLD) {
    throw new PlacementConfigError(
      'E_PLACEMENT_CEILING_TOO_HIGH',
      `confidenceCeiling 必须小于关键内容阈值 ${KEY_CONTENT_THRESHOLD}，实际 ${ceiling}：` +
        '落位再准也改不了"这是机器猜的落点"，放开它等于让关键内容被自动落笔',
    );
  }

  const withinSectionsRaw = input.candidate?.withinSections;
  const withinSections: string[] = [];
  if (withinSectionsRaw !== undefined) {
    if (!Array.isArray(withinSectionsRaw)) {
      throw new PlacementConfigError('E_PLACEMENT_CONFIG_INVALID', 'candidate.withinSections 必须是字符串数组');
    }
    for (const item of withinSectionsRaw) {
      if (typeof item !== 'string' || item.trim() === '') {
        throw new PlacementConfigError('E_PLACEMENT_CONFIG_INVALID', 'candidate.withinSections 的每一项都必须是非空字符串');
      }
      withinSections.push(item.trim());
    }
  }

  const config: DictationPlacementConfig = {
    strategy,
    candidate: { onlyTextNodes: true, ...(withinSections.length > 0 ? { withinSections } : {}) },
    confidenceCeiling: ceiling,
  };

  if (input.sectionMap !== undefined) {
    if (input.sectionMap === null || typeof input.sectionMap !== 'object' || Array.isArray(input.sectionMap)) {
      throw new PlacementConfigError('E_PLACEMENT_CONFIG_INVALID', 'sectionMap 必须是"章节词 → 节点 id"的对象');
    }
    const sectionMap: Record<string, string> = {};
    for (const [key, value] of Object.entries(input.sectionMap)) {
      if (key.trim() === '' || typeof value !== 'string' || value.trim() === '') {
        throw new PlacementConfigError('E_PLACEMENT_CONFIG_INVALID', `sectionMap 的 "${key}" 必须映射到一个非空节点 id`);
      }
      sectionMap[key.trim()] = value.trim();
    }
    if (Object.keys(sectionMap).length > 0) config.sectionMap = sectionMap;
  }

  if (input.termMap !== undefined) {
    if (!Array.isArray(input.termMap)) {
      throw new PlacementConfigError('E_PLACEMENT_CONFIG_INVALID', 'termMap 必须是数组');
    }
    const termMap: Array<{ match: string; nodeId: string }> = [];
    for (const [position, entry] of input.termMap.entries()) {
      const match = entry?.match;
      const nodeId = entry?.nodeId;
      if (typeof match !== 'string' || match.trim() === '' || typeof nodeId !== 'string' || nodeId.trim() === '') {
        throw new PlacementConfigError('E_PLACEMENT_CONFIG_INVALID', `termMap 第 ${position + 1} 项必须同时给出非空 match 与 nodeId`);
      }
      termMap.push({ match: match.trim(), nodeId: nodeId.trim() });
    }
    if (termMap.length > 0) config.termMap = termMap;
  }

  if (input.structureMap !== undefined) {
    /* 非法值一律报错，不静默取默认（同本文件其余校验）：标签会进机读信息被下游消费，
       "帮你把 system 改成 local"这种兜底会让一台配错的机器看起来正常运行。 */
    const raw = input.structureMap as unknown;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new PlacementConfigError('E_PLACEMENT_CONFIG_INVALID', 'structureMap 必须是"词 → 数据元标签"的对象');
    }
    const structureMap: Record<string, DataElementTag> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      const word = key.trim();
      if (word === '') {
        /* 空词是"命中任何文本"的规则：它会把每段都标成同一个数据元，且看不出是配置写错了 */
        throw new PlacementConfigError('E_PLACEMENT_CONFIG_INVALID', 'structureMap 的词不能为空（空词会命中任何文本）');
      }
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new PlacementConfigError('E_PLACEMENT_CONFIG_INVALID', `structureMap 的 "${word}" 必须映射到一个数据元标签（{ system, code, display? }）`);
      }
      const tag = value as { system?: unknown; code?: unknown; display?: unknown };
      if (typeof tag.system !== 'string' || !(TAG_SYSTEMS as readonly string[]).includes(tag.system)) {
        throw new PlacementConfigError(
          'E_PLACEMENT_CONFIG_INVALID',
          `structureMap 的 "${word}" 的 system 只能是 ${TAG_SYSTEMS.join(' / ')}，实际 ${JSON.stringify(tag.system)}（不静默改成 local）`,
        );
      }
      if (typeof tag.code !== 'string' || tag.code.trim() === '') {
        throw new PlacementConfigError('E_PLACEMENT_CONFIG_INVALID', `structureMap 的 "${word}" 必须给出非空的 code`);
      }
      if (tag.display !== undefined && (typeof tag.display !== 'string' || tag.display.trim() === '')) {
        throw new PlacementConfigError('E_PLACEMENT_CONFIG_INVALID', `structureMap 的 "${word}" 的 display 若提供就必须是非空字符串`);
      }
      structureMap[word] = {
        system: tag.system as DataElementTag['system'],
        code: tag.code.trim(),
        ...(tag.display === undefined ? {} : { display: (tag.display as string).trim() }),
      };
    }
    if (Object.keys(structureMap).length > 0) config.structureMap = structureMap;
  }

  if (input.external !== undefined) {
    if (input.external === null || typeof input.external !== 'object') {
      throw new PlacementConfigError('E_PLACEMENT_CONFIG_INVALID', 'external 必须是对象');
    }
    const external: NonNullable<DictationPlacementConfig['external']> = {};
    if (input.external.endpoint !== undefined) {
      if (typeof input.external.endpoint !== 'string') throw new PlacementConfigError('E_PLACEMENT_CONFIG_INVALID', 'external.endpoint 必须是字符串');
      external.endpoint = input.external.endpoint.trim();
    }
    if (input.external.timeoutMs !== undefined) {
      if (!Number.isInteger(input.external.timeoutMs) || (input.external.timeoutMs as number) <= 0) {
        throw new PlacementConfigError('E_PLACEMENT_CONFIG_INVALID', `external.timeoutMs 必须是正整数，实际 ${JSON.stringify(input.external.timeoutMs)}`);
      }
      external.timeoutMs = input.external.timeoutMs;
    }
    config.external = external;
  }

  if (strategy === 'external') {
    if (!config.external?.endpoint) {
      throw new PlacementConfigError(
        'E_PLACEMENT_CONFIG_INVALID',
        'external 策略必须给出落位服务地址：拒绝保存，也不静默退回 ordered',
      );
    }
    if (!config.external.timeoutMs) config.external.timeoutMs = 20_000;
  }

  return config;
}

export interface CandidateSet {
  /** 按文档阅读顺序排列的候选文本节点 id  */
  nodeIds: NodeId[];
  /** 收窄前的文本节点总数 */
  total: number;
  /** 被 `withinSections` 排除的数量 */
  excluded: number;
}

function textIdsInDocumentOrder(indexes: DocumentIndex, rootId: NodeId): NodeId[] {
  const out: NodeId[] = [];
  const stack: NodeId[] = [rootId];
  while (stack.length > 0) {
    const id = stack.pop() as NodeId;
    const node = indexes.nodeOf(id);
    if (node?.type === 'text') out.push(id);
    const children = indexes.childrenOf(id);
    /* 反向入栈：保证出栈顺序 = children 的 order 升序 */
    for (let i = children.length - 1; i >= 0; i -= 1) stack.push(children[i] as NodeId);
  }
  return out;
}

/** 节点的全部章节标签（祖先中所有 section 的 `sectionCode` 与 `title`） */
function sectionLabelsOf(indexes: DocumentIndex, nodeId: NodeId): string[] {
  const labels: string[] = [];
  for (const ancestorId of indexes.ancestorsOf(nodeId)) {
    const node = indexes.nodeOf(ancestorId);
    if (node?.type === 'section') {
      if (node.sectionCode) labels.push(node.sectionCode);
      if (node.title) labels.push(node.title);
    }
  }
  return labels;
}

/** L1：按 `candidate.withinSections` 把候选集收窄到"可落点" */
export function collectCandidates(indexes: DocumentIndex, config: DictationPlacementConfig): CandidateSet {
  const all = textIdsInDocumentOrder(indexes, indexes.rootId);
  const within = config.candidate.withinSections;
  const allowed = within && within.length > 0
    ? all.filter((id) => sectionLabelsOf(indexes, id).some((label) => within.includes(label)))
    : all;
  return { nodeIds: allowed, total: all.length, excluded: all.length - allowed.length };
}

export interface PlacementItem {
  /** 段号（与转写段一致，便于与证据链对齐） */
  index: number;
  text: string;
  /** 目标节点；`null` = 未落位（交人工指定，不兜底）  */
  nodeId: NodeId | null;
  reason: string;
}

export interface PlacementOutcome {
  items: PlacementItem[];
  placed: number;
  unplaced: number;
  warnings: string[];
}

interface MatchRule {
  match: string;
  nodeId: string;
  order: number;
}

export interface MatchCandidate<T> {
  /** 规则词：出现在文本里即算命中 */
  match: string;
  /** 命中后的结论（落位是节点 id，结构化是数据元标签） */
  payload: T;
  /** 声明顺序：同长度时按它决胜 */
  order: number;
}

export function matchLongest<T>(text: string, rules: ReadonlyArray<MatchCandidate<T>>): { match: string; payload: T } | null {
  const hits = rules
    .filter((rule) => rule.match !== '' && text.includes(rule.match))
    .sort((a, b) => b.match.length - a.match.length || a.order - b.order);
  const best = hits[0];
  return best ? { match: best.match, payload: best.payload } : null;
}

/** 落位用的一份薄封装：结论是节点 id（`matchLongest` 是唯一的命中判定） */
function matchByRules(text: string, rules: MatchRule[]): { nodeId: NodeId; match: string } | null {
  const hit = matchLongest(text, rules.map((rule) => ({ match: rule.match, payload: rule.nodeId, order: rule.order })));
  return hit ? { nodeId: hit.payload as NodeId, match: hit.match } : null;
}

/**
 * L2：按策略把转写段映射成目标节点。
 *
 * 三种本地策略共用一个"关键词 → 节点"匹配器，但规则来源不同：
 *   - `ordered`：不匹配，按顺序取候选（无规则）；
 *   - `section-title`：规则来自文档章节（`sectionMap`）；
 *   - `term-table`：规则来自配置的术语表（`termMap`）。
 * 共用实现是为了"最长匹配优先"这类语义只有一处；来源不同则保证了两种策略各自可解释。
  */
export function placeSegments(
  params: { segments: TranscriptSegment[]; candidates: CandidateSet },
  config: DictationPlacementConfig,
): PlacementOutcome {
  if (config.strategy === 'external') {
    /* 同步入口不处理 external：它必须走 `resolvePlacements()`（唯一会发网络请求的入口）。
       这里抛错而不是"退回本地策略"，是为了让"配了外部服务却走到本地"这种错配立刻暴露。 */
    throw new PlacementConfigError(
      'E_PLACEMENT_EXTERNAL_REQUIRES_ASYNC',
      'external 策略必须走 resolvePlacements()；placeSegments() 只处理本地策略（不静默退回本地落位）',
    );
  }

  const { segments, candidates } = params;
  const rules: MatchRule[] = config.strategy === 'term-table'
    ? (config.termMap ?? []).map((item, order) => ({ match: item.match, nodeId: item.nodeId, order }))
    : Object.entries(config.sectionMap ?? {}).map(([match, nodeId], order) => ({ match, nodeId, order }));

  const items: PlacementItem[] = segments.map((segment, position) => {
    const text = segment.text.trim();
    if (config.strategy === 'ordered') {
      const nodeId = candidates.nodeIds[position];
      return nodeId
        ? { index: segment.index, text, nodeId, reason: `按顺序落位到第 ${position + 1} 个候选节点` }
        : {
            index: segment.index,
            text,
            nodeId: null,
            reason: `候选节点不足：需要第 ${position + 1} 个，实际只有 ${candidates.nodeIds.length} 个`,
          };
    }
    const hit = matchByRules(text, rules);
    return hit
      ? { index: segment.index, text, nodeId: hit.nodeId, reason: `命中规则"${hit.match}"` }
      : { index: segment.index, text, nodeId: null, reason: '没有命中任何落位规则（未落位，请人工指定）' };
  });

  const placed = items.filter((item) => item.nodeId !== null).length;
  const unplaced = items.length - placed;
  const warnings: string[] = [];
  if (unplaced > 0) {
    warnings.push(`${unplaced} 段未落位：不兜底到第一个节点（未落位交人工指定 —— 错误落位比不落位更危险）`);
  }
  if (config.strategy !== 'ordered' && items.length > 0 && placed === 0) {
    warnings.push('本次没有任何段落命中落位规则：请检查规则表，或改用手工指定落点');
  }
  return { items, placed, unplaced, warnings };
}

/** 已落位的目标节点（按段序）。只在 `unplaced === 0` 时才可用于 `dictate`  */
export function placedNodeIds(outcome: PlacementOutcome): NodeId[] {
  return outcome.items.map((item) => item.nodeId).filter((id): id is NodeId => id !== null);
}

export interface PastePlacementItem {
  /** 段序（从 1 起，与界面上的"第 N 段"一致） */
  index: number;
  text: string;
  /** 目标章节；`null` = 未命中规则（调用方落到锚点） */
  sectionId: NodeId | null;
  /** 命中的规则词 */
  matched: string | null;
  reason: string;
}

export interface PastePlacementOutcome {
  /**
   * 本次是否真的按规则改了落点。
   *
   * `ordered` 下为 `false`：那个策略的语义是"转写段与候选段落一一对着放"，
   * 前提是段数 ≈ 候选数（医生在一份文书里连续口述）。粘贴不满足这个前提 ——
   * 往光标处粘三行，不该被散落到三个章节里。所以它不参与粘贴落位。
    */
  enabled: boolean;
  items: PastePlacementItem[];
  /** 落到锚点之外（真的被挪走了）的段数  */
  moved: number;
  warnings: string[];
}

/**
 * 把粘贴进来的若干段映射到目标章节。
 *
 * 复用语音落位那同一张规则表（`sectionMap` / `termMap`）与同一个匹配器
 * （`matchByRules`，最长匹配优先）—— 落位规则只该有一处：两处各有一份，
 * 就会出现"语音放对了、粘贴放错了"这种只有医生才会撞见的分歧。
  */
export function placePastedParagraphs(
  params: { texts: readonly string[]; anchorSectionId: NodeId },
  indexes: DocumentIndex,
  config: DictationPlacementConfig,
): PastePlacementOutcome {
  const { texts, anchorSectionId } = params;
  const untouched = (reason: string): PastePlacementItem[] =>
    texts.map((text, position) => ({ index: position + 1, text: text.trim(), sectionId: null, matched: null, reason }));

  if (config.strategy === 'ordered') {
    return {
      enabled: false,
      items: untouched('当前策略是"按顺序"：它要求段数与候选段落一一对应，粘贴没有这个前提，落点保持你粘贴的位置'),
      moved: 0,
      warnings: ['落位策略为"按顺序"，本次粘贴不参与落位（全部落在你粘贴的位置）'],
    };
  }
  if (config.strategy === 'external') {
    /* 外部落位服务是异步的，而粘贴在同一个事务里建段落。不假装配上了 ——
       退回本地规则去冒充外部服务，比"这次没参与落位"更坏（同 ai/model-config 的 no-endpoint 纪律）。 */
    return {
      enabled: false,
      items: untouched('当前策略是外部落位服务，粘贴落位未接入，落点保持你粘贴的位置'),
      moved: 0,
      warnings: ['落位策略为"外部服务"，粘贴落位未接入（不退回本地规则冒充）'],
    };
  }

  const rules: MatchRule[] = config.strategy === 'term-table'
    ? (config.termMap ?? []).map((item, order) => ({ match: item.match, nodeId: item.nodeId, order }))
    : Object.entries(config.sectionMap ?? {}).map(([match, nodeId], order) => ({ match, nodeId, order }));

  const items: PastePlacementItem[] = texts.map((raw, position) => {
    const text = raw.trim();
    const index = position + 1;
    const hit = matchByRules(text, rules);
    if (!hit) {
      return { index, text, sectionId: null, matched: null, reason: '没有命中任何落位规则（落在你粘贴的位置）' };
    }
    const sectionId = nearestSectionId(indexes, hit.nodeId as NodeId);
    if (!sectionId) {
      /* 规则指向的节点可能已被删除/移到章外。如实说"规则可能过期"，不硬塞到别处 */
      return {
        index,
        text,
        sectionId: null,
        matched: hit.match,
        reason: `命中规则"${hit.match}"，但它指向的节点已不在任何章节下（规则可能过期，落在你粘贴的位置）`,
      };
    }
    if (sectionId === anchorSectionId) {
      return { index, text, sectionId, matched: hit.match, reason: `命中规则"${hit.match}"，本来就在这个章节` };
    }
    return { index, text, sectionId, matched: hit.match, reason: `命中规则"${hit.match}"，落到它所在的章节` };
  });

  const moved = items.filter((item) => item.sectionId !== null && item.sectionId !== anchorSectionId).length;
  const warnings: string[] = [];
  if (moved > 0) {
    warnings.push(`${moved} 段按落位规则放到了别的章节（追加到该章节末尾）：落位是猜的，请核对后再确认`);
  }
  return { enabled: true, items, moved, warnings };
}

/** 节点所属的最近章节（`ancestorsOf` 由近到远，取第一个 section）  */
function nearestSectionId(indexes: DocumentIndex, nodeId: NodeId): NodeId | null {
  for (const ancestorId of indexes.ancestorsOf(nodeId)) {
    if (indexes.nodeOf(ancestorId)?.type === 'section') return ancestorId;
  }
  return null;
}
