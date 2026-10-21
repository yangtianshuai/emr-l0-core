import type { DocumentIndex } from '../model/indexes.ts';
import { TAG_SYSTEMS, type DataElementTag, type NodeId } from '../model/types.ts';
import type { TranscriptSegment } from '../core/dictation.ts';

export type PlacementStrategy = 'ordered' | 'section-title' | 'term-table' | 'external';

export const PLACEMENT_STRATEGIES: readonly PlacementStrategy[] = ['ordered', 'section-title', 'term-table', 'external'];

export interface PlacementCandidateConfig {
  onlyTextNodes: true;
  withinSections?: string[];
}

export interface DictationPlacementConfig {
  strategy: PlacementStrategy;
  candidate: PlacementCandidateConfig;
  sectionMap?: Record<string, string>;
  termMap?: Array<{ match: string; nodeId: string }>;
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
    const raw = input.structureMap as unknown;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new PlacementConfigError('E_PLACEMENT_CONFIG_INVALID', 'structureMap 必须是"词 → 数据元标签"的对象');
    }
    const structureMap: Record<string, DataElementTag> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      const word = key.trim();
      if (word === '') {
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
  nodeIds: NodeId[];
  total: number;
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
    for (let i = children.length - 1; i >= 0; i -= 1) stack.push(children[i] as NodeId);
  }
  return out;
}

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
  match: string;
  payload: T;
  order: number;
}

export function matchLongest<T>(text: string, rules: ReadonlyArray<MatchCandidate<T>>): { match: string; payload: T } | null {
  const hits = rules
    .filter((rule) => rule.match !== '' && text.includes(rule.match))
    .sort((a, b) => b.match.length - a.match.length || a.order - b.order);
  const best = hits[0];
  return best ? { match: best.match, payload: best.payload } : null;
}

function matchByRules(text: string, rules: MatchRule[]): { nodeId: NodeId; match: string } | null {
  const hit = matchLongest(text, rules.map((rule) => ({ match: rule.match, payload: rule.nodeId, order: rule.order })));
  return hit ? { nodeId: hit.payload as NodeId, match: hit.match } : null;
}

export function placeSegments(
  params: { segments: TranscriptSegment[]; candidates: CandidateSet },
  config: DictationPlacementConfig,
): PlacementOutcome {
  if (config.strategy === 'external') {
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

export function placedNodeIds(outcome: PlacementOutcome): NodeId[] {
  return outcome.items.map((item) => item.nodeId).filter((id): id is NodeId => id !== null);
}

export interface PastePlacementItem {
  /** 段序（从 1 起，与界面上的"第 N 段"一致） */
  index: number;
  text: string;
  sectionId: NodeId | null;
  matched: string | null;
  reason: string;
}

export interface PastePlacementOutcome {
  enabled: boolean;
  items: PastePlacementItem[];
  moved: number;
  warnings: string[];
}

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

function nearestSectionId(indexes: DocumentIndex, nodeId: NodeId): NodeId | null {
  for (const ancestorId of indexes.ancestorsOf(nodeId)) {
    if (indexes.nodeOf(ancestorId)?.type === 'section') return ancestorId;
  }
  return null;
}
