import { matchLongest, type DictationPlacementConfig } from '../dictation/placement.ts';
import type { DataElementTag } from '../model/types.ts';

export const TERM_MATCH_CONFIDENCE = 0.8;

export interface StructureProposalItem {
  index: number;
  text: string;
  tag: DataElementTag | null;
  matched: string | null;
  confidence: number;
  reason: string;
}

export interface StructureProposalOutcome {
  enabled: boolean;
  items: StructureProposalItem[];
  proposed: number;
  warnings: string[];
}

export function proposeStructurings(
  params: { texts: readonly string[] },
  config: DictationPlacementConfig,
): StructureProposalOutcome {
  const { texts } = params;
  const untouched = (reason: string): StructureProposalItem[] =>
    texts.map((text, position) => ({ index: position + 1, text: text.trim(), tag: null, matched: null, confidence: 0, reason }));

  if (config.strategy === 'ordered') {
    return {
      enabled: false,
      items: untouched('当前策略是"按顺序"：它只管落点、不参与结构化（这一段不打标）'),
      proposed: 0,
      warnings: ['落位策略为"按顺序"，本次不产出数据元提议（改成"按章节词"或"按关键词表"才会参与）'],
    };
  }
  if (config.strategy === 'external') {
    return {
      enabled: false,
      items: untouched('当前策略是外部落位服务：结构化未接入，这一段不打标'),
      proposed: 0,
      warnings: ['落位策略为"外部服务"，结构化未接入（不拿本地词表冒充外部服务）'],
    };
  }

  const rules = Object.entries(config.structureMap ?? {}).map(([match, tag], order) => ({ match, payload: tag, order }));
  const ceiling = config.confidenceCeiling;
  const items: StructureProposalItem[] = texts.map((raw, position) => {
    const text = raw.trim();
    const index = position + 1;
    const hit = matchLongest(text, rules);
    if (!hit) {
      return {
        index,
        text,
        tag: null,
        matched: null,
        confidence: 0,
        reason: '没有命中任何结构化规则（不打标：标签会被下游直接消费，猜错比不打更糟）',
      };
    }
    const label = hit.payload.display ? `${hit.payload.system}:${hit.payload.code}（${hit.payload.display}）` : `${hit.payload.system}:${hit.payload.code}`;
    return {
      index,
      text,
      tag: hit.payload,
      matched: hit.match,
      confidence: Math.min(ceiling, TERM_MATCH_CONFIDENCE),
      reason: `命中结构化规则"${hit.match}"，标为 ${label}`,
    };
  });

  const proposed = items.filter((item) => item.tag !== null).length;
  const warnings: string[] = [];
  if (rules.length === 0) {
    warnings.push('结构化词表为空：没有任何段落会被打标（词表在管理后台「能力配置 → 语音接入」里配置）');
  } else if (proposed === 0) {
    warnings.push('本次没有任何段落命中结构化规则（不打标：请检查词表，或改用手工绑定数据元）');
  }
  if (proposed > 0) {
    warnings.push(`${proposed} 段被提议绑定数据元：标签是猜的，且会进机读信息 —— 请核对后再确认`);
  }
  return { enabled: true, items, proposed, warnings };
}
