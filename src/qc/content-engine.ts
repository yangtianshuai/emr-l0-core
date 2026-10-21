// 内涵类质控：外部引擎契约与产出校验。

import type { AnnotationSeverity } from '../core/annotations.ts';
import type { NodeId } from '../model/types.ts';

/** 契约版本：引擎与本地校验必须完全一致，不一致整份拒绝（不猜、不做兼容猜测）  */
export const CONTENT_ENGINE_API = 'qc.content/1';

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

export type NoForbiddenFields<T> = Extract<keyof T, ForbiddenContentField> extends never ? true : false;

export interface ContentQcRuleBrief {
  ruleId: string;
  title: string;
  /** 该规则允许报出的最高级别：引擎不得自行升级（判定标准由本地控）  */
  severity: AnnotationSeverity;
  requirement: string;
}

export interface ContentQcNodeBrief {
  nodeId: string;
  sectionCode?: string;
  keyContent: boolean;
  text: string;
}

export interface ContentQcRequest {
  api: typeof CONTENT_ENGINE_API;
  requestId: string;
  now: string;
  docTypeCode?: string;
  visitType?: string;
  rules: ContentQcRuleBrief[];
  /** 允许查看的节点。引用这些之外的节点一律拒绝 */
  nodes: ContentQcNodeBrief[];
  /** 因上限没能送进去的节点数（如实计数：否则引擎会把"没给我"当成"没写"）  */
  omittedNodes: number;
}

export interface ContentQcFinding {
  ruleId: string;
  nodeId: string;
  severity: AnnotationSeverity;
  title: string;
  rationale: string;
  /** 被引用的原文片段：必须逐字出现在该节点文本里 */
  quote: string;
  confidence?: number;
}

export interface ContentQcUnevaluated {
  ruleId: string;
  reason: string;
}

export interface ContentQcResponse {
  api: typeof CONTENT_ENGINE_API;
  engine: { id: string; kind: 'rules' | 'model'; version: string; modelId?: string };
  judged: string[];
  findings: ContentQcFinding[];
  unevaluated?: ContentQcUnevaluated[];
}

export const CONTENT_ENGINE_ERRORS = {
  /** 契约版本不符 */
  E_QC_ENGINE_API_MISMATCH: 'E_QC_ENGINE_API_MISMATCH',
  E_QC_ENGINE_SHAPE: 'E_QC_ENGINE_SHAPE',
  E_QC_ENGINE_FORBIDDEN_FIELD: 'E_QC_ENGINE_FORBIDDEN_FIELD',
  E_QC_ENGINE_TOO_LARGE: 'E_QC_ENGINE_TOO_LARGE',
  /** 引擎未接入（明确不可用，不是"没有发现"） */
  E_QC_ENGINE_NOT_CONFIGURED: 'E_QC_ENGINE_NOT_CONFIGURED',
  E_QC_FINDING_UNKNOWN_RULE: 'E_QC_FINDING_UNKNOWN_RULE',
  E_QC_FINDING_OUT_OF_SCOPE: 'E_QC_FINDING_OUT_OF_SCOPE',
  E_QC_FINDING_BAD_CITATION: 'E_QC_FINDING_BAD_CITATION',
  E_QC_FINDING_BAD_FIELD: 'E_QC_FINDING_BAD_FIELD',
  E_QC_FINDING_DUPLICATE: 'E_QC_FINDING_DUPLICATE',
} as const;

export type ContentEngineErrorCode =
  | (typeof CONTENT_ENGINE_ERRORS)[keyof typeof CONTENT_ENGINE_ERRORS]
  | 'E_QC_UNEVALUATED_UNKNOWN_RULE';

export const CONTENT_ENGINE_LIMITS = {
  maxNodes: 400,
  /** 请求总字符上限（超了就少送节点：宁可少问，也不给半截文本） */
  maxTotalChars: 120_000,
  maxFindings: 200,
  maxTitle: 120,
  maxRationale: 600,
  /** 引文上限：引一整段不是"引用"，是转述 */
  maxQuote: 200,
} as const;

export interface ValidatedFinding extends ContentQcFinding {
  ruleTitle: string;
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
  judged: string[];
  /** 逐条丢弃的（必须报出来：静默丢一条等于替引擎美化产出）  */
  rejected: RejectedFinding[];
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
      reject(CONTENT_ENGINE_ERRORS.E_QC_FINDING_BAD_CITATION, `引文在节点 ${node.nodeId} 的文本里找不到："${quote}"`);
      return;
    }
    if (item.confidence !== undefined) {
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

export interface ContentQcEngine {
  readonly id: string;
  readonly kind: 'rules' | 'model';
  readonly version: string;
  run(request: ContentQcRequest, signal?: { timeoutMs: number }): Promise<unknown>;
}

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
  endpoint: string;
  token?: string;
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

export interface BuildRequestInput {
  requestId: string;
  now: string;
  docTypeCode?: string;
  visitType?: string;
  rules: ContentQcRuleBrief[];
  nodes: Array<{ nodeId: NodeId; text: string; keyContent: boolean; sectionCode?: string }>;
}

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
