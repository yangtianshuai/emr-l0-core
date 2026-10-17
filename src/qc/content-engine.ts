/**
 * **内涵类质控**：外部引擎契约与产出校验。
 *
 * ## 形式类 vs 内涵类：差别不在"难不难"，在"判定依据在哪儿"
 *
 * 形式类质控（缺项、占位符残留、时限）的依据**都在本地**：文档里没有的东西就是没有，
 * 谓词是封闭的纯函数，所以它能被"随时跑一次"，也能被逐条复算。
 *
 * 内涵类（"这段鉴别诊断写得够不够"）的依据**不在文档里** —— 它要靠外部知识，
 * 所以只能交给外部引擎。而一旦判定逻辑跑到本进程之外，本仓库的几条硬纪律就都要重新落地：
 *
 *   ① **判定标准不能被引擎改写**：引擎只能用请求里给出的规则号，**不许自创规则**；
 *   ② **不许引用不存在的话**：引文必须逐字出现在被判节点的文本里 —— 否则那是幻觉，
 *      而幻觉在质控里比"不判定"危险得多（医生会照着一条不存在的问题去改病历）；
 *   ③ **不许产出建议**：它只能提出"这里可能有问题"，**不能**产出可落笔的内容。
 *      落笔必须由人走采纳通道 —— 这条在类型、在运行时校验、在下游 `annotate` 三处各挡一次；
 *   ④ **没判 ≠ 没问题**：引擎必须**逐条报告它判了哪些**（`judged`）与**哪些判不了**（`unevaluated`），
 *      两者都没提的规则会被算成"未报告"，界面照"未判定"显示 —— 这与本仓库
 *      "读不出来不能说成没有"是同一条纪律。
 *
 * ## 类型级约束与运行时校验是**两件事**，都要有
 *
 * 类型管得住**本地代码**：`NoForbiddenFields<ContentQcFinding>` 一旦有人给类型加上
 * `suggestion` / `patch` 这类字段，编译期就红。
 * 但类型**过不了 JSON**：外部引擎交上来的是字符串，`JSON.parse` 之后类型声明一文不值 ——
 * 真正拦住"偷偷塞一条建议"的是运行时校验：**未知字段一律拒绝**，
 * 且出现禁用字段时给出**专门**的错误码与说明（而不是笼统的"字段不认识"）。
 *
 * ## 本轮**没有**接任何外部引擎，也不假装接了
 *
 * 交付的是**契约 + 校验 + 未接入的如实报告**（`createUnavailableEngine`）。
 * 不写"看起来能跑"的桩：拿假数据填满界面，会让"内涵质控已可用"变成一个没人能反驳的错觉。
 * 同理，**内置规则清单一律为空** —— 那是临床标准，本程序不发明；
 * 规则清单由业务方提供（见 `buildContentRequest` 的 `rules` 入参）。
 */

import type { AnnotationSeverity } from '../core/annotations.ts';
import type { NodeId } from '../model/types.ts';

/** 契约版本：引擎与本地校验必须完全一致，不一致**整份拒绝**（不猜、不做兼容猜测） */
export const CONTENT_ENGINE_API = 'qc.content/1';

/**
 * **禁用字段**：任何能"写进文档"或构成一条 AI 建议的字段名。
 *
 * 逐字写出来而不只写规则：引擎实现方需要的是**可照着改的清单**，
 * 而"字段不认识"这种笼统的报错会让人以为只是拼写问题。
 */
export const FORBIDDEN_CONTENT_FIELDS = [
  'suggestion',
  'suggestedText',
  'suggest',
  'replacement',
  'patch',
  'ops',
  'document',
  'newText',
  'diff',
  'content',
] as const;

export type ForbiddenContentField = (typeof FORBIDDEN_CONTENT_FIELDS)[number];

/**
 * 类型级约束：`NoForbiddenFields<T>` 只有在 T 不含禁用字段时才为 `true`。
 * 自测里用一个 `const _: NoForbiddenFields<ContentQcFinding> = true;` 把它**钉在编译期**。
 */
export type NoForbiddenFields<T> = Extract<keyof T, ForbiddenContentField> extends never ? true : false;

/* ------------------------------- 请求 ------------------------------- */

export interface ContentQcRuleBrief {
  ruleId: string;
  title: string;
  /** 该规则**允许**报出的最高级别：引擎不得自行升级（判定标准由本地控） */
  severity: AnnotationSeverity;
  /** 这条规则在问什么（**给引擎看的原话**，不含改法） */
  requirement: string;
}

export interface ContentQcNodeBrief {
  nodeId: string;
  sectionCode?: string;
  keyContent: boolean;
  /** 节点全文（**不截断**：截断的文本会让引擎得出"这里没写"的错误结论） */
  text: string;
}

export interface ContentQcRequest {
  api: typeof CONTENT_ENGINE_API;
  requestId: string;
  now: string;
  docTypeCode?: string;
  visitType?: string;
  /** 允许使用的规则清单。引擎**只能用这里的 ruleId** */
  rules: ContentQcRuleBrief[];
  /** 允许查看的节点。引用这些之外的节点一律拒绝 */
  nodes: ContentQcNodeBrief[];
  /** 因上限**没能送进去**的节点数（如实计数：否则引擎会把"没给我"当成"没写"） */
  omittedNodes: number;
}

/* ------------------------------- 产出 ------------------------------- */

/**
 * 一条发现。
 *
 * 注意它**没有任何**可以落笔的字段：`title` / `rationale` 是给人看的话，
 * `quote` 是**已被引用**的原文（只能等于文档里的既有内容，不能是新内容）。
 */
export interface ContentQcFinding {
  ruleId: string;
  nodeId: string;
  severity: AnnotationSeverity;
  title: string;
  /** 凭什么这么判：医生据此复核 */
  rationale: string;
  /** 被引用的原文片段：必须逐字出现在该节点文本里 */
  quote: string;
  /** 0~1；可选（内容类判定常给不出有意义的置信度，编一个反而误导） */
  confidence?: number;
}

export interface ContentQcUnevaluated {
  ruleId: string;
  reason: string;
}

export interface ContentQcResponse {
  api: typeof CONTENT_ENGINE_API;
  engine: { id: string; kind: 'rules' | 'model'; version: string; modelId?: string };
  /**
   * **它实际判过哪些规则**。必填，且不能省 ——
   * 少了它，"没有发现"与"根本没跑"在数据上完全同形（这正是内涵质控最容易撒的谎）。
   */
  judged: string[];
  findings: ContentQcFinding[];
  /** 判不了的：与"没命中"分开（同 `QcPredicateUncertain` 的处置） */
  unevaluated?: ContentQcUnevaluated[];
}

/* ------------------------------ 错误码 ------------------------------ */

export const CONTENT_ENGINE_ERRORS = {
  /** 契约版本不符 */
  E_QC_ENGINE_API_MISMATCH: 'E_QC_ENGINE_API_MISMATCH',
  /** 顶层形状不对（不是对象 / 缺必填字段 / 未知字段） */
  E_QC_ENGINE_SHAPE: 'E_QC_ENGINE_SHAPE',
  /** 出现禁用字段（能写进文档的那种）—— 与"字段不认识"分开报 */
  E_QC_ENGINE_FORBIDDEN_FIELD: 'E_QC_ENGINE_FORBIDDEN_FIELD',
  /** 产出规模越界 */
  E_QC_ENGINE_TOO_LARGE: 'E_QC_ENGINE_TOO_LARGE',
  /** 引擎未接入（明确不可用，不是"没有发现"） */
  E_QC_ENGINE_NOT_CONFIGURED: 'E_QC_ENGINE_NOT_CONFIGURED',
  /* 以下为**逐条**丢弃的理由（不废掉整份） */
  E_QC_FINDING_UNKNOWN_RULE: 'E_QC_FINDING_UNKNOWN_RULE',
  E_QC_FINDING_OUT_OF_SCOPE: 'E_QC_FINDING_OUT_OF_SCOPE',
  E_QC_FINDING_BAD_CITATION: 'E_QC_FINDING_BAD_CITATION',
  E_QC_FINDING_BAD_FIELD: 'E_QC_FINDING_BAD_FIELD',
  E_QC_FINDING_DUPLICATE: 'E_QC_FINDING_DUPLICATE',
} as const;

export type ContentEngineErrorCode =
  | (typeof CONTENT_ENGINE_ERRORS)[keyof typeof CONTENT_ENGINE_ERRORS]
  | 'E_QC_UNEVALUATED_UNKNOWN_RULE';

/* ------------------------------ 上限 ------------------------------ */

export const CONTENT_ENGINE_LIMITS = {
  /** 一次请求最多送多少个节点（超出的按"未送"计数，不截断文本） */
  maxNodes: 400,
  /** 请求总字符上限（超了就少送节点：宁可少问，也不给半截文本） */
  maxTotalChars: 120_000,
  /** 一次最多接受多少条发现 */
  maxFindings: 200,
  maxTitle: 120,
  maxRationale: 600,
  /** 引文上限：引一整段不是"引用"，是转述 */
  maxQuote: 200,
} as const;

/* ------------------------------ 校验 ------------------------------ */

export interface ValidatedFinding extends ContentQcFinding {
  ruleTitle: string;
  /** 引文在该节点文本里的位置（下游锚点定位用；-1 表示只在"仅引文"模式下命中的情况，不会出现） */
  quoteAt: number;
}

export interface RejectedFinding {
  index: number;
  code: ContentEngineErrorCode;
  message: string;
}

export interface EngineValidationOk {
  ok: true;
  findings: ValidatedFinding[];
  unevaluated: ContentQcUnevaluated[];
  /** 引擎自报**实际判过**哪些规则（原样带出来：界面/日志要能区分"判过没命中"与"没判"） */
  judged: string[];
  /** 逐条丢弃的（**必须报出来**：静默丢一条等于替引擎美化产出） */
  rejected: RejectedFinding[];
  /** 引擎既没说判了、也没说没判的规则 —— 界面按"未判定"显示，不能算干净 */
  silentRules: string[];
}

export type EngineValidation =
  | EngineValidationOk
  | { ok: false; code: ContentEngineErrorCode; message: string };

const SEVERITY_ORDER: Record<AnnotationSeverity, number> = { info: 0, warn: 1, block: 2 };
const SEVERITIES: AnnotationSeverity[] = ['info', 'warn', 'block'];

const TOP_KEYS = new Set(['api', 'engine', 'judged', 'findings', 'unevaluated']);
const ENGINE_KEYS = new Set(['id', 'kind', 'version', 'modelId']);
const FINDING_KEYS = new Set(['ruleId', 'nodeId', 'severity', 'title', 'rationale', 'quote', 'confidence']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 递归找禁用字段（未知字段本来就会被拒，但禁用字段要给**专门**的理由） */
function findForbidden(value: unknown, path = '$'): string | null {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const hit = findForbidden(value[index], `${path}[${index}]`);
      if (hit) return hit;
    }
    return null;
  }
  if (!isPlainObject(value)) return null;
  for (const [key, item] of Object.entries(value)) {
    if ((FORBIDDEN_CONTENT_FIELDS as readonly string[]).includes(key)) return `${path}.${key}`;
    const hit = findForbidden(item, `${path}.${key}`);
    if (hit) return hit;
  }
  return null;
}

function nonEmptyString(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > max) return null;
  return trimmed;
}

/**
 * 校验引擎产出。**两步处置**（刻意分开）：
 *   - **整份拒绝**：契约版本不符、顶层形状不对、出现禁用字段、规模越界、缺 `judged`。
 *     这些说明"这份东西不是按契约产出的"，逐条挑拣只会掩盖问题；
 *   - **逐条丢弃**：单条发现的规则号不认识 / 越界 / 引文对不上 / 字段非法 / 重复。
 *     质控是提示性的，一条坏的不该废掉整份 —— 但**丢弃必须逐条报出来**。
 */
export function validateEngineOutput(raw: unknown, request: ContentQcRequest): EngineValidation {
  if (!isPlainObject(raw)) {
    return { ok: false, code: CONTENT_ENGINE_ERRORS.E_QC_ENGINE_SHAPE, message: '引擎产出不是 JSON 对象' };
  }
  const forbidden = findForbidden(raw);
  if (forbidden) {
    return {
      ok: false,
      code: CONTENT_ENGINE_ERRORS.E_QC_ENGINE_FORBIDDEN_FIELD,
      message:
        `引擎产出里出现了禁用字段 ${forbidden} —— 内涵类引擎**只能提出质控提示，不得产出可落笔的内容**。` +
        `禁用清单：${FORBIDDEN_CONTENT_FIELDS.join('、')}`,
    };
  }
  const unknownTop = Object.keys(raw).filter((key) => !TOP_KEYS.has(key));
  if (unknownTop.length > 0) {
    return {
      ok: false,
      code: CONTENT_ENGINE_ERRORS.E_QC_ENGINE_SHAPE,
      message: `引擎产出里有契约之外的顶层字段：${unknownTop.join('、')}（契约字段：${[...TOP_KEYS].join('、')}）`,
    };
  }
  if (raw.api !== CONTENT_ENGINE_API) {
    return {
      ok: false,
      code: CONTENT_ENGINE_ERRORS.E_QC_ENGINE_API_MISMATCH,
      message: `契约版本不符：引擎报 ${String(raw.api)}，本地要求 ${CONTENT_ENGINE_API}（不做兼容猜测）`,
    };
  }
  if (!isPlainObject(raw.engine)) {
    return { ok: false, code: CONTENT_ENGINE_ERRORS.E_QC_ENGINE_SHAPE, message: '缺少 engine 描述（谁产出的必须可查）' };
  }
  const unknownEngine = Object.keys(raw.engine).filter((key) => !ENGINE_KEYS.has(key));
  if (unknownEngine.length > 0) {
    return { ok: false, code: CONTENT_ENGINE_ERRORS.E_QC_ENGINE_SHAPE, message: `engine 里有契约之外的字段：${unknownEngine.join('、')}` };
  }
  const engineKind = raw.engine.kind;
  if (engineKind !== 'rules' && engineKind !== 'model') {
    return { ok: false, code: CONTENT_ENGINE_ERRORS.E_QC_ENGINE_SHAPE, message: `engine.kind 只能是 rules / model，实际：${String(engineKind)}` };
  }
  if (nonEmptyString(raw.engine.id, 120) === null || nonEmptyString(raw.engine.version, 60) === null) {
    return { ok: false, code: CONTENT_ENGINE_ERRORS.E_QC_ENGINE_SHAPE, message: 'engine.id 与 engine.version 都必须是非空字符串' };
  }
  if (engineKind === 'model' && nonEmptyString(raw.engine.modelId, 120) === null) {
    /* 与建议通道同一纪律：模型来源必须给 modelId，否则无法回放与追责 */
    return { ok: false, code: CONTENT_ENGINE_ERRORS.E_QC_ENGINE_SHAPE, message: 'engine.kind=model 时必须给 modelId（否则无法回放与追责）' };
  }
  if (!Array.isArray(raw.findings)) {
    return { ok: false, code: CONTENT_ENGINE_ERRORS.E_QC_ENGINE_SHAPE, message: '缺少 findings 数组' };
  }
  if (!Array.isArray(raw.judged)) {
    return {
      ok: false,
      code: CONTENT_ENGINE_ERRORS.E_QC_ENGINE_SHAPE,
      message: '缺少 judged（实际判过哪些规则）—— 少了它，"没有发现"与"根本没跑"在数据上完全同形',
    };
  }
  if (raw.findings.length > CONTENT_ENGINE_LIMITS.maxFindings) {
    return {
      ok: false,
      code: CONTENT_ENGINE_ERRORS.E_QC_ENGINE_TOO_LARGE,
      message: `发现条数 ${raw.findings.length} 超过上限 ${CONTENT_ENGINE_LIMITS.maxFindings}`,
    };
  }

  const ruleById = new Map(request.rules.map((rule) => [rule.ruleId, rule]));
  const nodeById = new Map(request.nodes.map((node) => [node.nodeId, node]));
  const rejected: RejectedFinding[] = [];
  const findings: ValidatedFinding[] = [];
  const seen = new Set<string>();

  raw.findings.forEach((item, index) => {
    const reject = (code: ContentEngineErrorCode, message: string): void => {
      rejected.push({ index, code, message });
    };
    if (!isPlainObject(item)) {
      reject(CONTENT_ENGINE_ERRORS.E_QC_FINDING_BAD_FIELD, '发现不是对象');
      return;
    }
    const unknown = Object.keys(item).filter((key) => !FINDING_KEYS.has(key));
    if (unknown.length > 0) {
      reject(CONTENT_ENGINE_ERRORS.E_QC_FINDING_BAD_FIELD, `契约之外的字段：${unknown.join('、')}`);
      return;
    }
    const ruleId = nonEmptyString(item.ruleId, 60);
    const rule = ruleId ? ruleById.get(ruleId) : undefined;
    if (!rule) {
      reject(CONTENT_ENGINE_ERRORS.E_QC_FINDING_UNKNOWN_RULE, `规则号 ${String(item.ruleId)} 不在本次允许的清单里（引擎不得自创规则）`);
      return;
    }
    const nodeId = nonEmptyString(item.nodeId, 120);
    const node = nodeId ? nodeById.get(nodeId) : undefined;
    if (!node) {
      reject(CONTENT_ENGINE_ERRORS.E_QC_FINDING_OUT_OF_SCOPE, `节点 ${String(item.nodeId)} 不在本次给出的节点里（越界即拒）`);
      return;
    }
    const severity = item.severity as AnnotationSeverity;
    if (!SEVERITIES.includes(severity)) {
      reject(CONTENT_ENGINE_ERRORS.E_QC_FINDING_BAD_FIELD, `severity 只能是 ${SEVERITIES.join(' / ')}，实际：${String(item.severity)}`);
      return;
    }
    if (SEVERITY_ORDER[severity] > SEVERITY_ORDER[rule.severity]) {
      /* 判定标准由本地控：规则声明是 warn，引擎不能自行升级成 block */
      reject(
        CONTENT_ENGINE_ERRORS.E_QC_FINDING_BAD_FIELD,
        `级别不得高于规则声明的上限（规则 ${rule.ruleId} 最高 ${rule.severity}，本次报 ${severity}）`,
      );
      return;
    }
    const title = nonEmptyString(item.title, CONTENT_ENGINE_LIMITS.maxTitle);
    if (title === null) {
      reject(CONTENT_ENGINE_ERRORS.E_QC_FINDING_BAD_FIELD, `title 必须是非空字符串且不超过 ${CONTENT_ENGINE_LIMITS.maxTitle} 字`);
      return;
    }
    const rationale = nonEmptyString(item.rationale, CONTENT_ENGINE_LIMITS.maxRationale);
    if (rationale === null) {
      reject(CONTENT_ENGINE_ERRORS.E_QC_FINDING_BAD_FIELD, `rationale（判定依据）必须给且不超过 ${CONTENT_ENGINE_LIMITS.maxRationale} 字`);
      return;
    }
    const quote = nonEmptyString(item.quote, CONTENT_ENGINE_LIMITS.maxQuote);
    if (quote === null) {
      reject(CONTENT_ENGINE_ERRORS.E_QC_FINDING_BAD_FIELD, `quote 必须是非空字符串且不超过 ${CONTENT_ENGINE_LIMITS.maxQuote} 字`);
      return;
    }
    const quoteAt = node.text.indexOf(quote);
    if (quoteAt < 0) {
      /* 引文对不上 = 幻觉。这条是本契约里最要紧的一道闸：
         医生会照着一条**不存在**的问题去改病历，那比"不判定"危险得多。 */
      reject(CONTENT_ENGINE_ERRORS.E_QC_FINDING_BAD_CITATION, `引文在节点 ${node.nodeId} 的文本里找不到："${quote}"`);
      return;
    }
    if (item.confidence !== undefined) {
      /* 有限性必须显式判：只判 typeof === 'number' 会让 NaN 通过（本仓库在建议通道踩过同一个坑） */
      if (typeof item.confidence !== 'number' || !Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1) {
        reject(CONTENT_ENGINE_ERRORS.E_QC_FINDING_BAD_FIELD, `confidence 必须是 0~1 的有限数，实际：${String(item.confidence)}`);
        return;
      }
    }
    const dedupeKey = `${ruleId}:${nodeId}`;
    if (seen.has(dedupeKey)) {
      reject(CONTENT_ENGINE_ERRORS.E_QC_FINDING_DUPLICATE, `同规则同节点重复上报：${dedupeKey}`);
      return;
    }
    seen.add(dedupeKey);
    findings.push({
      /* 用规则清单 / 节点清单里的那个 id（与入参同值，但类型上确定非空 ——
         `nonEmptyString` 的返回值是可空的，控制流分析跟不到 `rule`/`node` 判断上去） */
      ruleId: rule.ruleId,
      nodeId: node.nodeId,
      severity,
      title,
      rationale,
      quote,
      ...(item.confidence === undefined ? {} : { confidence: item.confidence as number }),
      ruleTitle: rule.title,
      quoteAt,
    });
  });

  const unevaluated: ContentQcUnevaluated[] = [];
  if (raw.unevaluated !== undefined) {
    if (!Array.isArray(raw.unevaluated)) {
      return { ok: false, code: CONTENT_ENGINE_ERRORS.E_QC_ENGINE_SHAPE, message: 'unevaluated 必须是数组' };
    }
    for (const item of raw.unevaluated) {
      if (!isPlainObject(item)) continue;
      const ruleId = nonEmptyString(item.ruleId, 60);
      const reason = nonEmptyString(item.reason, CONTENT_ENGINE_LIMITS.maxRationale);
      if (!ruleId || !ruleById.has(ruleId) || reason === null) {
        /* 未判定条目本身不可信 → 丢弃（它只是"没判"，丢了不会误导医生；但会落到 silentRules 里被点名） */
        continue;
      }
      unevaluated.push({ ruleId, reason });
    }
  }

  const judged = raw.judged.filter((item): item is string => typeof item === 'string');
  const covered = new Set<string>([...judged, ...unevaluated.map((item) => item.ruleId)]);
  const silentRules = request.rules.map((rule) => rule.ruleId).filter((ruleId) => !covered.has(ruleId));

  return { ok: true, findings, unevaluated, judged, rejected, silentRules };
}

/* ------------------------------ 引擎接口 ------------------------------ */

/**
 * 外部引擎的调用面。**只有这一个方法**：判定，且只能产出 `ContentQcResponse`。
 *
 * 调用方必须把"抛错/超时"当成**未判定**处理，绝不能当成"没问题" ——
 * 一个静默失败的外部引擎会让整批规则看起来是干净的。
 */
export interface ContentQcEngine {
  readonly id: string;
  readonly kind: 'rules' | 'model';
  readonly version: string;
  /**
   * 判定一次。返回**未经校验的原始产出**（`unknown`）——
   * 校验是调用方的事（`validateEngineOutput`），传输层不该顺手"修一修"再交出去：
   * 那会让"引擎按错误契约产出"变成一件看不出来的事。
   *
   * 调用方必须把**抛错/超时**当成"未判定"，绝不能当成"没问题"。
   */
  run(request: ContentQcRequest, signal?: { timeoutMs: number }): Promise<unknown>;
}

/**
 * **未接入**的引擎。
 *
 * 它不是"桩"：它不产出任何发现，而是把**全部规则**逐条报成"未判定（引擎未接入）"。
 * 这样"没接"这件事会走既有的未判定通道显示出来 —— 而不是让界面看起来"跑了、没问题"。
 */
export function createUnavailableEngine(reason: string): ContentQcEngine {
  return {
    id: 'qc-content-none',
    kind: 'rules',
    version: '0',
    run: async (request) => ({
      api: CONTENT_ENGINE_API,
      engine: { id: 'qc-content-none', kind: 'rules', version: '0' },
      judged: [],
      findings: [],
      unevaluated: request.rules.map((rule) => ({ ruleId: rule.ruleId, reason })),
    }),
  };
}

/* ------------------------------ 传输层 ------------------------------ */

/**
 * 解析并**守住**引擎地址：明文 HTTP 只允许本机。
 *
 * 这一下会把病历内容发出去，而配置里写错一个字符（`http://` 而非 `https://`、写错主机名）
 * 就会把患者数据明文发到外部。宁可在**构造时**抛错，也不"先跑起来再说"。
 *
 * **导出**而不是留在 HTTP 工厂里：模型形态的引擎（`content-engine-model.ts`）走的是
 * 同一类外呼，必须守同一套规矩。安全规则有两份实现，迟早有一份被漏改。
 */
export function resolveEngineEndpoint(endpoint: string): URL {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error(`内涵类质控引擎地址不是合法 URL：${endpoint}`);
  }
  const loopback = ['127.0.0.1', '::1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !loopback) {
    throw new Error(
      `拒绝把病历内容发往明文 HTTP 的非本机地址（${endpoint}）：` +
        '这一下会把文书内容发到外部，而明文 HTTP 在链路上可被读取与篡改。' +
        '请改用 https://，或把引擎部署在本机（127.0.0.1 / localhost）。',
    );
  }
  return url;
}

export interface HttpEngineOptions {
  /** 引擎地址。**明文 HTTP 只允许本机**（见工厂里的拒绝逻辑） */
  endpoint: string;
  /** 鉴权令牌：放 `Authorization: Bearer …`。**不进日志、不进审计、不回显** */
  token?: string;
  /**
   * 期望的引擎标识。设了它，响应里的 `engine.id` 必须一致 ——
   * 否则"换了一个引擎"这件事会**看不出来**（而判定标准换了，是必须看得出来的）。
   */
  expectEngineId?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  /** 测试可注入（默认用全局 fetch） */
  fetchImpl?: (input: string, init: Record<string, unknown>) => Promise<{
    ok: boolean;
    status: number;
    text: () => Promise<string>;
  }>;
}

/**
 * HTTP 传输层：把请求 POST 给外部引擎，把它的**原始产出**交回来。
 *
 * ## 它只做传输，不做判定，也不做"修补"
 *
 * 校验在调用方（`validateEngineOutput`）：传输层若顺手修字段，就会出现
 * "引擎按错误契约产出、而系统看起来正常" —— 那是最坏的一种兼容。
 *
 * ## 三条安全边界（都在这里，而不是靠调用方记得）
 *
 *   ① **明文 HTTP 只允许本机**：这一下会把病历内容发出去，默认又是不接的 ——
 *      配置里写错一个字符（`http://` 而非 `https://`、或写错主机名）就会把患者数据
 *      明文发到外部。宁可在**构造时**就抛错，也不"先跑起来再说"。
 *   ② **响应大小上限**：读完即判（不做流式截断 —— 截断的 JSON 解析失败反而更难查），
 *      但要有个上限，免得一个失控的引擎把内存吃光。
 *   ③ **令牌不进日志**：错误信息里只说状态码，把响应体**截断后**才带上（且不含请求体）。
 *
 * ## 它不做重试
 *
 * 质控是"跑一次给人看"的动作：失败就当"未判定"如实上报（见调用方）。
 * 自动重试会让"同一个请求发了几遍"这件事看不见，而对**外呼**来说那是要留痕的事实。
 */
export function createHttpContentEngine(options: HttpEngineOptions): ContentQcEngine {
  const url = resolveEngineEndpoint(options.endpoint);
  const timeoutMs = options.timeoutMs ?? 8000;
  const maxBytes = options.maxResponseBytes ?? 512 * 1024;
  const doFetch = options.fetchImpl ?? ((input, init) => fetch(input, init as RequestInit) as never);

  return {
    id: options.expectEngineId ?? `http:${url.host}`,
    kind: 'model',
    version: '1',
    async run(request, signal): Promise<unknown> {
      const budget = signal?.timeoutMs ?? timeoutMs;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), budget);
      try {
        const response = await doFetch(url.toString(), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
          },
          body: JSON.stringify(request),
          signal: controller.signal,
        });
        if (!response.ok) {
          /* 失败也要把**响应体的一小段**带回来：否则现场只有"HTTP 500"，无从排查。
             只截断、不回显整个响应（它可能很大，也可能含引擎的内部信息）。 */
          const body = await response.text().catch(() => '');
          throw new Error(`引擎返回 HTTP ${response.status}${body ? `：${body.slice(0, 200)}` : ''}`);
        }
        const text = await response.text();
        if (text.length > maxBytes) {
          throw new Error(`引擎响应过大（${text.length} 字节 > 上限 ${maxBytes}）：拒绝解析`);
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch (err) {
          throw new Error(`引擎响应不是合法 JSON：${(err as Error).message}`);
        }
        if (options.expectEngineId) {
          const id = (parsed as { engine?: { id?: unknown } } | null)?.engine?.id;
          if (id !== options.expectEngineId) {
            throw new Error(
              `引擎自称 ${String(id)}，与配置期望的 ${options.expectEngineId} 不一致 —— ` +
                '判定标准换了必须看得出来，所以这里直接拒绝（不做"就当是同一个"的猜测）',
            );
          }
        }
        return parsed;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/* ------------------------------ 规则清单 ------------------------------ */

/**
 * 解析**业务方给的**内涵类规则清单（JSON 数组）。
 *
 * 为什么是文件而不是代码里的常量：这些规则来自临床标准 / 专科共识，
 * 要有出处、要能被替换、要能版本化 —— 本程序**一条都不发明**。
 * 清单为空是**合法状态**，也是当前的默认：那时引擎无可判定之规则，
 * 接口如实报告"未接入/无规则"，而不是假装跑过。
 *
 * 逐条校验而不是整份拒绝：一份 20 条的清单里有一条写错了，
 * 不该让其余 19 条都不能用 —— 但错的那条**必须报出来**（静默丢弃等于替它美化）。
 */
export function parseContentRules(
  raw: unknown,
): { ok: true; rules: ContentQcRuleBrief[]; rejected: Array<{ index: number; message: string }> } | { ok: false; message: string } {
  if (!Array.isArray(raw)) return { ok: false, message: '规则清单必须是 JSON 数组' };
  const rules: ContentQcRuleBrief[] = [];
  const rejected: Array<{ index: number; message: string }> = [];
  const seen = new Set<string>();
  raw.forEach((item, index) => {
    if (!isPlainObject(item)) {
      rejected.push({ index, message: '不是对象' });
      return;
    }
    const unknown = Object.keys(item).filter((key) => !['ruleId', 'title', 'severity', 'requirement'].includes(key));
    const ruleId = nonEmptyString(item.ruleId, 60);
    const title = nonEmptyString(item.title, CONTENT_ENGINE_LIMITS.maxTitle);
    const requirement = nonEmptyString(item.requirement, CONTENT_ENGINE_LIMITS.maxRationale);
    const severity = item.severity as AnnotationSeverity;
    if (unknown.length > 0) rejected.push({ index, message: `契约之外的字段：${unknown.join('、')}` });
    else if (!ruleId) rejected.push({ index, message: 'ruleId 必须是非空字符串' });
    else if (seen.has(ruleId)) rejected.push({ index, message: `规则号重复：${ruleId}` });
    else if (!SEVERITIES.includes(severity)) rejected.push({ index, message: `severity 只能是 ${SEVERITIES.join(' / ')}` });
    else if (title === null || requirement === null) rejected.push({ index, message: 'title 与 requirement 都必须给（引擎要照着 requirement 判）' });
    else {
      seen.add(ruleId);
      rules.push({ ruleId, title, severity, requirement });
    }
  });
  return { ok: true, rules, rejected };
}

/* ------------------------------ 请求构造 ------------------------------ */

export interface BuildRequestInput {
  requestId: string;
  now: string;
  docTypeCode?: string;
  visitType?: string;
  rules: ContentQcRuleBrief[];
  nodes: Array<{ nodeId: NodeId; text: string; keyContent: boolean; sectionCode?: string }>;
}

/**
 * 构造请求：**按重要度挑节点、不截断文本**。
 *
 * 优先送关键内容节点；超上限的节点只计数（`omittedNodes`）——
 * 让引擎知道"还有 N 个节点没收到"，而不是把"没给我"当成"没写"（那正是假阳性之源）。
 */
export function buildContentRequest(input: BuildRequestInput): ContentQcRequest {
  const ordered = [...input.nodes].sort((a, b) => Number(b.keyContent) - Number(a.keyContent));
  const picked: ContentQcNodeBrief[] = [];
  let chars = 0;
  for (const node of ordered) {
    if (picked.length >= CONTENT_ENGINE_LIMITS.maxNodes) break;
    if (chars + node.text.length > CONTENT_ENGINE_LIMITS.maxTotalChars && picked.length > 0) break;
    chars += node.text.length;
    picked.push({
      nodeId: node.nodeId,
      ...(node.sectionCode ? { sectionCode: node.sectionCode } : {}),
      keyContent: node.keyContent,
      text: node.text,
    });
  }
  return {
    api: CONTENT_ENGINE_API,
    requestId: input.requestId,
    now: input.now,
    ...(input.docTypeCode ? { docTypeCode: input.docTypeCode } : {}),
    ...(input.visitType ? { visitType: input.visitType } : {}),
    rules: input.rules.map((rule) => ({ ...rule })),
    nodes: picked,
    omittedNodes: input.nodes.length - picked.length,
  };
}

/* ------------------------------ 契约自述 ------------------------------ */

/**
 * 契约的**可读形态**：外部实现方要照着它写，所以它得能被查（`GET /api/qc-content-contract`）。
 *
 * 例子里的规则号刻意写成 `R-CONTENT-示例` 并注明"占位"：本程序**不发明临床标准**，
 * 拿一条编出来的规则当样例，读的人会以为那就是内置规则。
 */
export function describeContentContract(): Record<string, unknown> {
  return {
    api: CONTENT_ENGINE_API,
    summary: '内涵类质控：外部引擎只能提出质控提示（旁挂注解），不得产出可落笔的内容。',
    request: {
      fields: ['api', 'requestId', 'now', 'docTypeCode?', 'visitType?', 'rules', 'nodes', 'omittedNodes'],
      rules: '本次**允许使用**的规则清单；引擎只能用这里的 ruleId（不得自创规则）',
      nodes: '本次**允许查看**的节点；引用这些之外的节点会被逐条拒绝',
      omittedNodes: '因上限没能送进去的节点数（引擎不得把"没收到"当成"没写"）',
    },
    response: {
      fields: ['api', 'engine', 'judged', 'findings', 'unevaluated?'],
      judged: '**必填**：实际判过哪些规则。少了它，"没有发现"与"根本没跑"在数据上同形',
      findings: '每条含 ruleId / nodeId / severity / title / rationale / quote / confidence?',
      unevaluated: '判不了的规则与原因（与"没命中"分开）',
    },
    constraints: [
      `契约版本必须等于 ${CONTENT_ENGINE_API}，否则整份拒绝`,
      '顶层与各层出现契约之外的字段 → 拒绝（未知字段不会被静默忽略）',
      `禁用字段（出现即整份拒绝，它们是"能写进文档"的字段）：${FORBIDDEN_CONTENT_FIELDS.join('、')}`,
      '引文（quote）必须**逐字出现在**被判节点的文本里，否则该条被丢弃（幻觉比不判定更危险）',
      'severity 不得高于规则声明的上限（判定标准由本地控）',
      'confidence 若给，必须是 0~1 的有限数（NaN 会被拒）',
      '同规则同节点只接受一条（重复的逐条丢弃）',
    ],
    limits: CONTENT_ENGINE_LIMITS,
    exampleFinding: {
      ruleId: 'R-CONTENT-示例（占位，不是内置规则）',
      nodeId: '（必须是请求 nodes 里的 id）',
      severity: 'warn',
      title: '一句话结论',
      rationale: '凭什么这么判（医生据此复核）',
      quote: '必须逐字出现在该节点文本里的原文片段',
      confidence: 0.6,
    },
  };
}
