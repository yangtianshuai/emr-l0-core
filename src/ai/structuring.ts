/**
 * 即时结构化（V4）：把**一段文本**映射成**数据元标签**的**提议**。
 *
 * ## 它是什么 / 不是什么
 *
 * 它是：写作当下（提交 / 粘贴 / 采纳）判断"这段话算什么数据元"，把结论作为**提议**交出去，
 * 医生点头之后才由调用方落笔。
 * 它不是：自动落笔；不是后结构化（存量 PDF / 扫描件的抽取是另一条链，别混进来）；
 * 不改门控档位；不自动纠正已有标签。
 *
 * ## 三条不可让步的规则
 *
 * 1) **未命中即"不打标"**：返回 `tag: null`，绝不"顺手给个默认标签"。标签会进机读信息、
 *    被导出与下游系统直接消费 —— 猜错比不打更糟。这与落位"未命中落在光标处"的兜底方向**相反**：
 *    那条兜的是"位置"，位置错了医生看得见；标签错了，下游拿到的是一个错误的数据元；
 * 2) **只产提议，不落笔**：本模块不碰 `WriteSession`，不产生 rev、不留痕。
 *    采纳是调用方的事（对已有节点写 `tags` 走 `updateNodeProps`，自然进留痕）；
 * 3) **置信度受上限压制**：词表命中是确定的，但"这段真属于这个数据元"仍是猜的，
 *    所以配置里的上限（`confidenceCeiling`，必须 < 关键内容阈值 0.90）继续生效 ——
 *    关键内容上仍要医生改后采纳。
 *
 * ## 与落位的关系：共用匹配器，不共用结论
 *
 * 匹配（"哪条规则词命中"、最长匹配优先）只有一份实现（`matchLongest`，见 `dictation/placement.ts`）；
 * 但**结论类型**（节点 id vs 数据元标签）与**规则表**（`sectionMap` / `termMap` vs `structureMap`）
 * 分开：拿落位规则顶替标签，会把"这一章放对了"读成"这个数据元对了"。
 *
 * 本模块与 `dictation/placement.ts` 并列，同样**在内核之外、单向依赖内核**：
 * 它可以整个换掉、整个拿掉，门控与留痕不受任何影响。
 */

import { matchLongest, type DictationPlacementConfig } from '../dictation/placement.ts';
import type { DataElementTag } from '../model/types.ts';

/**
 * 词表命中的**基准置信度**。
 *
 * 为什么不是 1.0：命中只证明"这段话里出现了那个词"，不证明"它就是这个数据元"
 * （"否认高血压病史"里也有"病史"）。0.8 是"按词匹配"这一档的确定性，
 * 且必须低于关键内容阈值 0.90 —— 关键内容上仍要医生改后采纳。
 */
export const TERM_MATCH_CONFIDENCE = 0.8;

export interface StructureProposalItem {
  /** 段序（从 1 起，与界面上的"第 N 段"一致） */
  index: number;
  text: string;
  /** 提议绑定的数据元；`null` = 未命中（**不打标**） */
  tag: DataElementTag | null;
  /** 命中的规则词；`null` = 未命中 */
  matched: string | null;
  /** 置信度（已被 `confidenceCeiling` 压制；未命中恒为 0） */
  confidence: number;
  /** 为什么标这个 / 为什么不标（要能回答"系统凭什么"） */
  reason: string;
}

export interface StructureProposalOutcome {
  /** 本次是否参与（策略不适用时为 `false`，并在 `warnings` 里说明原因） */
  enabled: boolean;
  items: StructureProposalItem[];
  /** 真的产出标签的条数（"提了几条"不等于"标了几条"） */
  proposed: number;
  warnings: string[];
}

/**
 * 按配置把若干段文本映射成数据元提议。
 *
 * 与粘贴落位同一档纪律：**"不参与"也要说得出原因**。策略是"按顺序"或"外部服务"时返回
 * `enabled: false` 并给一句人话 —— 否则医生会把"没标"读成"这段本来就没有可结构化的内容"，
 * 而这两件事的处置完全不同（一个是去改配置，一个是内容确实如此）。
 */
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
    /* 外部落位服务只答"放哪"，不答"是什么"。不拿本地词表冒充它 —— 同粘贴落位的处置：
       假装配上了，比"这次没参与"更坏。 */
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
