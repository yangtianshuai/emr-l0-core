/**
 * 离线适配器：**不做任何外部调用**，用确定性模板产出建议。
 *
 * 它的职责有三个，都不是"占位"：
 *
 *   1) 让自测与演示**默认不外呼**（默认配置就是 offline，见 `model-config.ts`）——
 *      病历内容不该因为跑一次测试就被发到某个地址；
 *   2) 让"通路是否通"在没有模型的环境里可被验证：门控、分组、留痕、批量部分成功
 *      这些性质与"文本从哪来"无关，但至今只被模板验证过。**如果模板本身被删掉，
 *      这些性质就再没有回归保护**——这正是它该留在仓库里的理由；
 *   3) 产出的 `modelId` 带 `offline:` 前缀，进留痕后一眼能看出"这不是真模型写的"。
 *
 * ## ⚠️ 它不是"模型接入的降级方案"
 *
 * 配了 `openai-compatible` 却连不上时，正确行为是**报错**（见 `http-adapter.ts`），
 * 而**不是**悄悄换成模板。那会让医生以为在用真模型，实际看的是一段预写文本 ——
 * 与"没注入盐却以为注入了""配置错却用派生盐写出去"是同一类错误。
 *
 * ## 置信度为什么是 0.95
 *
 * 先说明它**不是**什么：它不是"离线产出更可信"。模板没有可信度可言，0.95 是模拟值。
 *
 * 选 0.95 的唯一理由是**让全部路径在离线环境里都能走通**：它同时高于一般内容（0.75）
 * 与关键内容（0.9）的阈值，于是"采纳→落笔→确认→签章→机读信息变新鲜"这条链路
 * 在没有模型的环境里可以被完整验证。若压到 0.8，**关键内容这条路在离线环境下永远走不通**，
 * 那一段就再没有回归保护（自测 B3/B4/B5/B7 正是这样断掉的）。
 *
 * "低于阈值会被拦"这条规则由**别的路径**覆盖，不必靠这里压低收入：
 *   - 语音：听写置信度被压到 0.85，关键内容上必然被拦（"听清了"不等于"内容对"）；
 *   - 人工：医生可以改后采纳，而"改后采纳"本身就是关键内容的正常路径。
 */

import type { AiContextItem } from '../core/ai-context.ts';
import type {
  AiAdapter,
  AiSkipDeclaration,
  AiSuggestRequest,
  AiSuggestResponse,
  AiSuggestionDraft,
  AiSuggestionMode,
} from './adapter.ts';
import { modelIdOf, type AiModelConfig } from './model-config.ts';

/** 模板产出的置信度：见文件头"置信度为什么是 0.95" */
const OFFLINE_CONFIDENCE = 0.95;

const MARK: Record<AiSuggestionMode, string> = {
  complete: '（离线模板续写）',
  draft: '（离线模板草稿）',
  polish: '（离线模板润色）',
};

/**
 * 按节点文本生成一条模板建议。
 *
 * 刻意保持**确定性**（同输入同输出）：这样自测可以断言具体文本，
 * 而"建议通道"的行为一旦被改坏会直接暴露，而不是被随机内容掩盖。
 */
function draftFor(item: AiContextItem, mode: AiSuggestionMode): string {
  const base = item.text.trim();
  if (mode === 'polish') {
    /* 润色：只做可验证的规范化（多余空白 + 结尾标点），不编造内容 */
    const normalized = base.replace(/\s+/g, ' ').replace(/([。；，,;])\1+/g, '$1');
    return normalized === '' ? '（本段为空，无可润色内容）' : normalized;
  }
  if (mode === 'draft') {
    return `${base}${base === '' ? '' : '\n'}${MARK.draft}本段为自动生成的草稿框架，请核对内容后修改：建议补充起病时间、主要症状、伴随症状与既往诊疗经过。`;
  }
  return `${base}${base === '' ? '' : ' '}${MARK.complete}建议结合既往史与已有检查结果，补充本段的病程变化与疗效评价。`;
}

export function createOfflineAdapter(config: AiModelConfig): AiAdapter {
  const modelId = modelIdOf(config);
  return {
    id: 'offline',
    async suggest(request: AiSuggestRequest): Promise<AiSuggestResponse> {
      const started = Date.now();
      const targets = request.context.items.filter((item) => item.role === 'target');
      /* 没有目标节点 = 没有可落笔的地方。返回空 items 而不是抛错：
         这不是"模型坏了"，而是"这次范围里没有要写的东西"（上游可据此跳过）。 */
      const items: AiSuggestionDraft[] = [];
      /* 产出方**如实说明它没写哪些**（见 `AiSilenceReport`）：
         空段没有可续写的文本，对它产出只会得到一句纯模板话术 ——
         而那正是医生最反感的那种"看起来有用、实际什么都没说"的建议。
         于是这里跳过并给出理由，让"没写"变成一条可复核的记录，而不是静默消失。 */
      const skipped: AiSkipDeclaration[] = [];
      for (const item of targets.slice(0, request.maxItems)) {
        if (item.text.trim() === '') {
          skipped.push({
            nodeId: item.nodeId,
            code: 'insufficient-context',
            reason: '该段没有可续写的文本（空段），模板不产出',
          });
          continue;
        }
        items.push({ nodeId: item.nodeId, text: draftFor(item, request.mode), confidence: OFFLINE_CONFIDENCE });
      }
      const inputChars = request.context.items.reduce((sum, item) => sum + item.text.length, 0);
      const response: AiSuggestResponse = {
        items,
        modelId,
        promptId: `offline-${request.mode}`,
        usage: { latencyMs: Date.now() - started, inputChars, outputChars: items.reduce((sum, item) => sum + item.text.length, 0) },
      };
      if (skipped.length > 0) response.skipped = skipped;
      return response;
    },
  };
}
