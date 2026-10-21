import { DEFAULT_AI_MODEL_CONFIG } from './model-config.ts';
import { createOfflineAdapter } from './offline-adapter.ts';
import type { AiContextAudit, AiContextDrop, AiContextItem, AiContextPackage } from '../core/ai-context.ts';
import {
  AI_SILENCE_LABELS,
  AI_SKIP_CODES,
  resolveSilenceReport,
  type AiSilenceCode,
  type AiSkipCode,
  type AiSuggestRequest,
  type AiSuggestionDraft,
} from './adapter.ts';
import { TestSuite, assert, assertEqual } from '../testing/harness.ts';

const suite = new TestSuite('沉默的可解释性自测', [
  '说明：验证"AI 看了但没写"这份清单的完整性与可信度 —— 校验自述、补记未说明、排序确定。',
  '全部离线：不连任何模型服务。',
]);

const test = (name: string, fn: () => void | Promise<void>): Promise<void> => suite.test(name, fn);

const AT = '2026-10-16T10:00:00.000Z';

function targetItem(nodeId: string, text: string): AiContextItem {
  return { nodeId, type: 'text', text, origin: 'human', role: 'target' };
}

function context(items: AiContextItem[] = [], overrides: Partial<AiContextAudit> = {}): AiContextPackage {
  return {
    docId: 'doc-1',
    docType: { system: 'WST500', code: 'A01', display: '入院记录' },
    items,
    policy: { includePatient: false, includeDataElements: false, maskStrategy: 'mask-person-name' },
    stats: { items: items.length, chars: 0, tokenBudget: 2000, droppedByBudget: 0 },
    audit: {
      actorId: 'ai-1',
      actorKind: 'ai',
      at: AT,
      requestedNodeIds: items.map((item) => item.nodeId),
      tokenBudget: 2000,
      droppedByBudget: 0,
      missingNodeIds: [],
      droppedTargets: [],
      ...overrides,
    },
  };
}

function request(allowedNodeIds: string[], maxItems = 5): AiSuggestRequest {
  return { context: context(allowedNodeIds.map((id) => targetItem(id, '现病史：'))), mode: 'complete', allowedNodeIds, maxItems };
}

function requestWithDrops(input: {
  allowedNodeIds: string[];
  requestedNodeIds: string[];
  droppedTargets: AiContextDrop[];
  missingNodeIds?: string[];
  maxItems?: number;
}): AiSuggestRequest {
  return {
    context: context(input.allowedNodeIds.map((id) => targetItem(id, '现病史：')), {
      requestedNodeIds: input.requestedNodeIds,
      droppedTargets: input.droppedTargets,
      missingNodeIds: input.missingNodeIds ?? [],
    }),
    mode: 'complete',
    allowedNodeIds: input.allowedNodeIds,
    maxItems: input.maxItems ?? 5,
  };
}

function draft(nodeId: string, text = '建议内容'): AiSuggestionDraft {
  return { nodeId, text, confidence: 0.9 };
}

const rejectCodes = (report: ReturnType<typeof resolveSilenceReport>): string[] => report.rejected.map((item) => item.code);

async function main(): Promise<void> {

  await test('S1 合法自述进入报告：来源标"产出方"，理由去空白', () => {
    const report = resolveSilenceReport({
      request: request(['n_1', 'n_2']),
      items: [draft('n_1')],
      declared: [{ nodeId: 'n_2', code: 'insufficient-context', reason: '  缺检验结果，不猜测  ' }],
    });
    assertEqual(report.targets, 2, '范围是 2 个目标');
    assertEqual(report.produced, 1, '产出 1 条');
    assertEqual(report.skipped.length, 1, '未产出 1 个');
    assertEqual(report.skipped[0]?.nodeId, 'n_2', '是 n_2');
    assertEqual(report.skipped[0]?.code, 'insufficient-context', '原因码照自述');
    assertEqual(report.skipped[0]?.reason, '缺检验结果，不猜测', '理由应去掉首尾空白');
    assertEqual(report.skipped[0]?.source, 'adapter', '来源应标为产出方');
    assertEqual(report.rejected.length, 0, '没有需要丢弃的');
  });

  await test('S2 幻觉 nodeId 的自述被拒：不在本次范围里，说了也不算', () => {
    const report = resolveSilenceReport({
      request: request(['n_1', 'n_2']),
      items: [],
      declared: [{ nodeId: 'n_9', code: 'insufficient-context', reason: '没写' }],
    });
    assertEqual(rejectCodes(report).includes('E_AI_SILENCE_UNKNOWN_NODE'), true, '应记为幻觉 nodeId');
    assertEqual(report.skipped.length, 2, 'n_1 / n_2 仍由内核补记');
    assertEqual(
      report.skipped.every((item) => item.source === 'kernel'),
      true,
      '两条都应是内核补记 —— 产出方那条幻觉声明不得占用任何一档',
    );
  });

  await test('S3 自相矛盾被拒：说"没写"又出现在产出里', () => {
    const report = resolveSilenceReport({
      request: request(['n_1']),
      items: [draft('n_1')],
      declared: [{ nodeId: 'n_1', code: 'not-applicable', reason: '不需要建议' }],
    });
    assertEqual(rejectCodes(report).includes('E_AI_SILENCE_CONTRADICTION'), true, '应记为自相矛盾');
    assertEqual(report.skipped.length, 0, '它确实产出了，不该出现在沉默清单里');
  });

  await test('S4 自创原因码被拒：码是封闭清单，否则聚合失去意义', () => {
    const report = resolveSilenceReport({
      request: request(['n_1']),
      items: [],
      declared: [{ nodeId: 'n_1', code: '模型自己想的理由', reason: '随便写' }],
    });
    assertEqual(rejectCodes(report).includes('E_AI_SILENCE_UNKNOWN_CODE'), true, '应记为未知原因码');
    assertEqual(report.skipped[0]?.code, 'unexplained', '被拒后由内核补记，而不是保留一个未知码');
    assertEqual(report.skipped[0]?.source, 'kernel', '补记的来源是内核');
  });

  await test('S5 说不出理由 / 理由过长都被拒：无法复核的沉默等于没报', () => {
    const blank = resolveSilenceReport({
      request: request(['n_1']),
      items: [],
      declared: [{ nodeId: 'n_1', code: 'other', reason: '   ' }],
    });
    assertEqual(rejectCodes(blank).includes('E_AI_SILENCE_BAD_REASON'), true, '空白理由应被拒');

    const tooLong = resolveSilenceReport({
      request: request(['n_1']),
      items: [],
      declared: [{ nodeId: 'n_1', code: 'other', reason: 'x'.repeat(500) }],
    });
    assertEqual(rejectCodes(tooLong).includes('E_AI_SILENCE_BAD_REASON'), true, '超长理由应被拒');
  });

  await test('S6 产出方没说的目标由内核补记：沉默不会因为没人解释就消失', () => {
    /* 范围 3 个、产出 1 条、自述 1 条 → 剩下那 1 个没有任何说法，必须被点名 */
    const report = resolveSilenceReport({
      request: request(['n_1', 'n_2', 'n_3']),
      items: [draft('n_1')],
      declared: [{ nodeId: 'n_2', code: 'existing-content', reason: '已有人工内容' }],
    });
    assertEqual(report.skipped.length, 2, '未产出 2 个');
    const undescribed = report.skipped.find((item) => item.nodeId === 'n_3');
    assertEqual(undescribed?.code, 'unexplained', '没有说法的那条应记为"产出方未说明"');
    assertEqual(undescribed?.source, 'kernel', '来源是内核');
    assert(/没有说明/.test(undescribed?.reason ?? ''), `措辞要说清是"没说"，实际 ${undescribed?.reason}`);
  });

  await test('S7 已达产出上限时，补记要指出这个可能：它比"未说明"更有用', () => {
    const report = resolveSilenceReport({
      request: request(['n_1', 'n_2'], 1),
      items: [draft('n_1')],
      declared: [],
    });
    assertEqual(report.skipped.length, 1, 'n_2 未产出');
    assertEqual(report.skipped[0]?.code, 'max-items', '满额时应用更具体的那一档');
    assert(/maxItems=1/.test(report.skipped[0]?.reason ?? ''), '理由里要带上限值');
  });

  await test('S8 全部产出时清单为空：这是要说出来的事实，不是无话可说', () => {
    const report = resolveSilenceReport({
      request: request(['n_1', 'n_2']),
      items: [draft('n_1'), draft('n_2')],
      declared: [],
    });
    assertEqual(report.targets, 2, '范围 2 个');
    assertEqual(report.produced, 2, '产出 2 条');
    assertEqual(report.skipped.length, 0, '没有跳过');
    assertEqual(report.rejected.length, 0, '也没有被丢弃的自述');
  });

  await test('S9 输出按范围顺序排：报告是给人看的，且要跨次可比对', () => {
    const report = resolveSilenceReport({
      request: request(['n_1', 'n_2', 'n_3']),
      items: [],
      declared: [
        { nodeId: 'n_3', code: 'other', reason: '丙' },
        { nodeId: 'n_1', code: 'other', reason: '甲' },
      ],
    });
    assertEqual(report.skipped.map((item) => item.nodeId), ['n_1', 'n_2', 'n_3'], '应按范围顺序输出，而不是自述顺序');
    assertEqual(report.skipped[1]?.source, 'kernel', '中间那条是内核补记');
  });

  await test('S10 自述整体不成形时不抛错：退化成"未说明"是安全方向', () => {
    const notArray = resolveSilenceReport({ request: request(['n_1']), items: [], declared: '不是数组' });
    assertEqual(notArray.skipped[0]?.code, 'unexplained', '应退化为未说明');
    assertEqual(notArray.rejected.length, 0, '整体不成形时不逐条报错（没有"条目"可报）');

    const mixedShapes = resolveSilenceReport({
      request: request(['n_1', 'n_2', 'n_3']),
      items: [],
      declared: [null, 'x', { nodeId: 'n_2', code: 'other', reason: '乙' }, { nodeId: 'n_2', code: 'other', reason: '重复' }],
    });
    assertEqual(rejectCodes(mixedShapes).includes('E_AI_SILENCE_MALFORMED'), true, '非对象条目应被记为不成形');
    assertEqual(rejectCodes(mixedShapes).includes('E_AI_SILENCE_DUPLICATE'), true, '同一节点重复自述应被记为重复');
    assertEqual(mixedShapes.skipped.find((item) => item.nodeId === 'n_2')?.reason, '乙', '保留第一条');
  });

  await test('S11 离线适配器：空段跳过并说明理由，而不是产出一句模板废话', async () => {
    const adapter = createOfflineAdapter(DEFAULT_AI_MODEL_CONFIG);
    const req: AiSuggestRequest = {
      context: context([targetItem('n_empty', '   '), targetItem('n_ok', '现病史：')]),
      mode: 'complete',
      allowedNodeIds: ['n_empty', 'n_ok'],
      maxItems: 5,
    };
    const response = await adapter.suggest(req);
    assertEqual(response.items.length, 1, '只对非空段产出');
    assertEqual(response.items[0]?.nodeId, 'n_ok', '产出的是非空的那一段');

    const report = resolveSilenceReport({ request: req, items: response.items, declared: response.skipped });
    assertEqual(report.skipped.length, 1, '空段要出现在沉默报告里');
    assertEqual(report.skipped[0]?.nodeId, 'n_empty', '是空的那一段');
    assertEqual(report.skipped[0]?.code, 'insufficient-context', '原因码应是"现有信息不足"');
    assertEqual(report.skipped[0]?.source, 'adapter', '来源是产出方自述，不是内核补记');
    assertEqual(report.rejected.length, 0, '它给的是合法自述，不该被拒');
  });

  await test('S12 九档原因都有人话名：界面与日志不许各编一套', () => {
    const all: AiSilenceCode[] = [...AI_SKIP_CODES, 'empty-target', 'context-budget', 'missing-target', 'max-items', 'unexplained'];
    assertEqual(all.length, 9, '档位数应为 9（产出方 4 + 内核 5）');
    for (const code of all) {
      const label = AI_SILENCE_LABELS[code];
      assert(typeof label === 'string' && label !== '', `档位 ${code} 缺人话名`);
    }
    /* 产出方那一档的集合必须与封闭清单一致：多一个少一个都意味着两边漂移 */
    assertEqual(
      (AI_SKIP_CODES as readonly string[]).every((code) => AI_SILENCE_LABELS[code as AiSkipCode] !== undefined),
      true,
      '封闭清单里的每个码都要有名字',
    );
    /* 内核那几档更不能重名：它们要能分开聚合，否则报表上看不出"没看到"与"看到了没写" */
    const kernelLabels = ['empty-target', 'context-budget', 'missing-target', 'max-items', 'unexplained'].map(
      (code) => AI_SILENCE_LABELS[code as AiSilenceCode],
    );
    assertEqual(new Set(kernelLabels).size, kernelLabels.length, '内核各档的人话名不得重复');
  });

  await test('S13 被上下文裁掉的目标也要报：模型自己都不知道有过这一段', () => {
    const report = resolveSilenceReport({
      request: requestWithDrops({
        allowedNodeIds: ['n_1'],
        requestedNodeIds: ['n_1', 'n_2'],
        droppedTargets: [{ nodeId: 'n_2', code: 'empty-target', reason: '该节点没有可写的文本（空段），未进入上下文' }],
      }),
      items: [draft('n_1')],
      declared: [],
    });
    assertEqual(report.targets, 2, '范围是"请求的"2 个，而不是"能落笔的"1 个');
    assertEqual(report.produced, 1, '产出 1 条');
    assertEqual(report.skipped.length, 1, '被裁掉的那个必须在清单里');
    assertEqual(report.skipped[0]?.nodeId, 'n_2', '正是被裁掉的那一个');
    assertEqual(report.skipped[0]?.code, 'empty-target', '原因取自上下文回执，不是凭空给一个');
    assertEqual(report.skipped[0]?.source, 'kernel', '来源是内核 —— 产出方不可能自述它没见过的东西');
  });

  await test('S14 三种"没进上下文"分属三档，不塌缩成同一句话', () => {
    const report = resolveSilenceReport({
      request: requestWithDrops({
        allowedNodeIds: [],
        requestedNodeIds: ['n_1', 'n_2', 'n_3'],
        droppedTargets: [{ nodeId: 'n_1', code: 'context-budget', reason: '本次上下文预算（10 字符）已满' }],
        missingNodeIds: ['n_2'],
      }),
      items: [],
      declared: [],
    });
    const byNode = new Map(report.skipped.map((item) => [item.nodeId, item]));
    assertEqual(report.skipped.length, 3, '三个目标各有各的说法');
    assertEqual(byNode.get('n_1')?.code, 'context-budget', '被预算挤掉的记它自己那一档');
    assertEqual(byNode.get('n_2')?.code, 'missing-target', '文档里已不存在的节点记"已不存在"');
    assertEqual(byNode.get('n_3')?.code, 'unexplained', '既不在上下文、也没记原因的，如实说"没记原因"');
    assertEqual(
      new Set([...byNode.values()].map((item) => item.reason)).size,
      3,
      '三条理由不得雷同：理由一样就等于没有区分',
    );
  });

  process.exit(suite.report());
}

void main();
