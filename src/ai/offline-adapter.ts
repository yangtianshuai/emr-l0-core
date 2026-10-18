// 离线适配器：不做任何外部调用，用确定性模板产出建议。

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

const OFFLINE_CONFIDENCE = 0.95;

const MARK: Record<AiSuggestionMode, string> = {
  complete: '（离线模板续写）',
  draft: '（离线模板草稿）',
  polish: '（离线模板润色）',
};

/**
 * 按节点文本生成一条模板建议。
 *
 * 刻意保持确定性（同输入同输出）：这样自测可以断言具体文本，
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
      const items: AiSuggestionDraft[] = [];
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
