import type { NodeId } from '../model/types.ts';
import type { TranscriptSegment } from '../core/dictation.ts';
import {
  PlacementConfigError,
  placeSegments,
  type CandidateSet,
  type DictationPlacementConfig,
  type PlacementItem,
  type PlacementOutcome,
} from './placement.ts';

export interface PlacementTransportRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
}

export interface PlacementTransportResponse {
  status: number;
  body: string;
}

export type PlacementTransport = (request: PlacementTransportRequest) => Promise<PlacementTransportResponse>;

export type ExternalPlacementErrorCode =
  | 'E_PLACEMENT_HTTP_STATUS'
  | 'E_PLACEMENT_TIMEOUT'
  | 'E_PLACEMENT_BAD_JSON'
  | 'E_PLACEMENT_NO_CONTENT'
  | 'E_PLACEMENT_UNKNOWN_NODE';

export class ExternalPlacementError extends Error {
  code: ExternalPlacementErrorCode;
  status?: number;

  constructor(code: ExternalPlacementErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'ExternalPlacementError';
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

export interface ResolvedExternalConfig {
  endpoint: string;
  timeoutMs: number;
}

export interface ExternalPlacementRequest {
  segments: TranscriptSegment[];
  candidates: CandidateSet;
  traceId?: string;
}

export interface ExternalPlacementResult extends PlacementOutcome {
  modelId: string;
  latencyMs: number;
}

export interface ResolvedPlacement extends PlacementOutcome {
  source: 'local' | 'external';
  modelId?: string;
  latencyMs?: number;
}

const defaultTransport: PlacementTransport = async (request) => {
  const response = await fetch(request.url, {
    method: 'POST',
    headers: request.headers,
    body: request.body,
    ...(request.signal ? { signal: request.signal } : {}),
  });
  return { status: response.status, body: await response.text() };
};

function extractJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) {
      throw new ExternalPlacementError('E_PLACEMENT_BAD_JSON', '落位服务输出里找不到 JSON 对象（响应体未记录：可能含转写文本）');
    }
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch (err) {
      throw new ExternalPlacementError('E_PLACEMENT_BAD_JSON', `落位服务输出的 JSON 无法解析：${(err as Error).message}（响应体未记录）`);
    }
  }
}

export function validatePlacements(raw: unknown, request: ExternalPlacementRequest): PlacementItem[] {
  if (!Array.isArray(raw)) {
    throw new ExternalPlacementError('E_PLACEMENT_NO_CONTENT', `落位服务产出必须是数组，实际 ${typeof raw}（响应体未记录）`);
  }
  const allowed = new Set<string>(request.candidates.nodeIds);
  const known = new Set(request.segments.map((segment) => segment.index));
  const byIndex = new Map<number, NodeId>();
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') {
      throw new ExternalPlacementError('E_PLACEMENT_UNKNOWN_NODE', '落位服务产出里有非对象条目');
    }
    const candidate = entry as Record<string, unknown>;
    const index = Number(candidate.index);
    if (!Number.isInteger(index) || !known.has(index)) {
      throw new ExternalPlacementError(
        'E_PLACEMENT_UNKNOWN_NODE',
        `落位服务给出了不属于本次转写的段号 ${JSON.stringify(candidate.index)}（不得按它落位）`,
      );
    }
    const nodeId = candidate.nodeId;
    if (nodeId === undefined || nodeId === null || nodeId === '') continue;
    if (typeof nodeId !== 'string' || !allowed.has(nodeId)) {
      throw new ExternalPlacementError(
        'E_PLACEMENT_UNKNOWN_NODE',
        `落位服务给出的 nodeId ${JSON.stringify(nodeId)} 不在本次候选集内（不得按它落位）`,
      );
    }
    byIndex.set(index, nodeId as NodeId);
  }
  return request.segments.map((segment) => {
    const nodeId = byIndex.get(segment.index) ?? null;
    return {
      index: segment.index,
      text: segment.text.trim(),
      nodeId,
      reason: nodeId ? '由外部落位服务给出' : '外部落位服务未给出该段落点（未落位，请人工指定）',
    };
  });
}

export function createExternalPlacement(
  config: ResolvedExternalConfig,
  options: {
    transport?: PlacementTransport;
    fetchImpl?: typeof fetch;
    apiKey?: string;
  } = {},
): { id: string; place(request: ExternalPlacementRequest): Promise<ExternalPlacementResult> } {
  const transport = options.transport ?? (options.fetchImpl ? undefined : defaultTransport);
  const apiKey = options.apiKey?.trim();

  return {
    id: 'external-placement',
    async place(request: ExternalPlacementRequest): Promise<ExternalPlacementResult> {
      const started = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.timeoutMs);
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      const body = JSON.stringify({
        ...(request.traceId ? { traceId: request.traceId } : {}),
        segments: request.segments.map((segment) => ({ index: segment.index, text: segment.text })),
        candidates: request.candidates.nodeIds,
      });

      const timedOut = new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () =>
          reject(new ExternalPlacementError('E_PLACEMENT_TIMEOUT', `落位服务调用超时（${config.timeoutMs}ms）已中止，未产生任何落点`)),
        );
      });
      let response: PlacementTransportResponse;
      try {
        const doRequest: PlacementTransport =
          transport ??
          (async (req) => {
            const res = await (options.fetchImpl as typeof fetch)(req.url, {
              method: 'POST',
              headers: req.headers,
              body: req.body,
              ...(req.signal ? { signal: req.signal } : {}),
            });
            return { status: res.status, body: await res.text() };
          });
        response = await Promise.race([doRequest({ url: config.endpoint, headers, body }), timedOut]);
      } catch (err) {
        if (err instanceof ExternalPlacementError) throw err;
        if (controller.signal.aborted) {
          throw new ExternalPlacementError('E_PLACEMENT_TIMEOUT', `落位服务调用超时（${config.timeoutMs}ms）已中止，未产生任何落点`);
        }
        throw new ExternalPlacementError('E_PLACEMENT_HTTP_STATUS', `落位服务调用失败：${(err as Error).message}（未产生任何落点）`);
      } finally {
        clearTimeout(timer);
      }

      if (response.status < 200 || response.status >= 300) {
        throw new ExternalPlacementError(
          'E_PLACEMENT_HTTP_STATUS',
          `落位服务返回 ${response.status}；响应体未记录（错误响应常回显请求内容，抄进日志等于把转写文本又存了一份）`,
          response.status,
        );
      }

      const parsed = extractJson(response.body) as Record<string, unknown> | null;
      const rawItems = parsed && typeof parsed === 'object' ? parsed.placements : undefined;
      if (rawItems === undefined) {
        throw new ExternalPlacementError('E_PLACEMENT_NO_CONTENT', '落位服务输出里没有 placements 字段（响应体未记录）');
      }
      const items = validatePlacements(rawItems, request);
      const placed = items.filter((item) => item.nodeId !== null).length;
      const unplaced = items.length - placed;
      const warnings: string[] = [];
      if (unplaced > 0) warnings.push(`外部落位服务对 ${unplaced} 段未给出落点：这些段未落位，请人工指定`);
      const modelId = typeof parsed?.modelId === 'string' && parsed.modelId.trim() !== '' ? parsed.modelId.trim() : 'external-placement';
      return { items, placed, unplaced, warnings, modelId, latencyMs: Date.now() - started };
    },
  };
}

export async function resolvePlacements(
  params: { segments: TranscriptSegment[]; candidates: CandidateSet; traceId?: string },
  config: DictationPlacementConfig,
  options: Parameters<typeof createExternalPlacement>[1] = {},
): Promise<ResolvedPlacement> {
  if (config.strategy !== 'external') {
    return { ...placeSegments(params, config), source: 'local' };
  }
  const external = config.external;
  if (!external?.endpoint) {
    throw new PlacementConfigError(
      'E_PLACEMENT_CONFIG_INVALID',
      'external 策略必须给出服务地址：拒绝在缺地址的情况下"退回按顺序落位"（那会让"已接入外部落位"变成假话）',
    );
  }
  const adapter = createExternalPlacement({ endpoint: external.endpoint, timeoutMs: external.timeoutMs ?? 20_000 }, options);
  const result = await adapter.place(params);
  return {
    items: result.items,
    placed: result.placed,
    unplaced: result.unplaced,
    warnings: result.warnings,
    source: 'external',
    modelId: result.modelId,
    latencyMs: result.latencyMs,
  };
}
