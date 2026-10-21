// T22 · 契约 HTTP 服务端（零依赖，仅用 node:http）。

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { DEMO_SIGNING_SEED, WriteError, WriteSession, type Actor, type WriteOptions } from '../core/session.ts';
import { demoKeyPair, softwareSigner, type Signer } from '../crypto/provider.ts';
import { errorsOf, validateDocument, type DocumentModel, type NodeId, type RevisionOp } from '../model/index.ts';
import { buildMachineReadable } from '../model/machine.ts';
import type { OfdExportPlan } from '../export/ofd.ts';
import { AiContextError, buildAiContext } from '../core/ai-context.ts';
import { ActorDirectory, tokenFingerprint, type ActorKind } from './actor-directory.ts';

type HttpStatus = 400 | 401 | 403 | 404 | 409 | 422 | 500;

const STATUS_BY_CODE: Record<string, HttpStatus> = {
  /* 与参考实现完全一致的部分 */
  E_AI_DIRECT_WRITE_FORBIDDEN: 403,
  E_AI_NOT_ALLOWED: 403,
  E_REV_CONFLICT: 409,
  E_SIGNED_IMMUTABLE: 409,
  E_SUGGESTION_STATE: 409,
  E_SUGGESTION_SCOPE_REQUIRED: 400,
  E_ANNOTATION_NOT_FOUND: 404,
  E_ANNOTATION_STATE: 409,
  E_ANNOTATION_NO_EVIDENCE: 422,
  E_AI_LOW_CONFIDENCE: 422,
  E_KEY_CONTENT_UNCONFIRMED: 422,
  /* 机器绑的标签未确认：与关键内容同类（内容合规问题，不是请求本身不对） */
  E_TAG_UNCONFIRMED: 422,
  E_KEY_CONTENT_PROTECTED: 422,
  /* 必备章节禁删：与关键内容禁删同类（内容合规问题，不是请求本身不对） */
  E_REQUIRED_SECTION_PROTECTED: 422,
  E_SIGNED_WITH_UNCONFIRMED_AI: 422,
  E_IMPORTED_UNCONFIRMED: 422,
  E_MACHINE_READABLE_STALE: 422,
  E_EXPORT_INVALID_PLAN: 422,
  E_AI_NO_PROVENANCE: 422,
  E_NODE_NOT_FOUND: 404,
  E_SUGGESTION_NOT_FOUND: 404,
  E_TYPE_MISMATCH: 400,
  E_OFFSET_RANGE: 400,
  E_ACTOR_REQUIRED: 400,
  E_ACTOR_INVALID: 400,
  E_ACTOR_UNVERIFIED: 401,
  E_AI_CONTEXT_SCOPE_REQUIRED: 400,
  E_AI_CONTEXT_EMPTY: 404,
  E_CONFIRM_SCOPE_REQUIRED: 400,
  E_EXTERNAL_SCOPE_REQUIRED: 400,
  E_EXTERNAL_ACTOR_INVALID: 403,
  E_EXTERNAL_EVIDENCE_REQUIRED: 422,
  E_EXTERNAL_CONFLICT: 409,
  E_DOC_NOT_FOUND: 404,
  E_ROUTE_NOT_FOUND: 404,
  E_UNKNOWN_OP: 400,
  E_BAD_DOC: 400,
  E_BAD_REQUEST: 400,
  E_INVALID_PATCH: 400,
  E_PARENT_NOT_FOUND: 400,
  E_NODE_TYPE_UNKNOWN: 400,
  E_HAS_CHILDREN: 422,
  E_CYCLE_DETECTED: 422,
  /* 解锁与撤销：理由缺失是内容合规问题（422），状态不允许是冲突（409） */
  E_UNLOCK_REASON_REQUIRED: 422,
  E_UNLOCK_NOT_ALLOWED: 409,
  E_NOTHING_TO_UNDO: 409,
  /* 审签状态机（K12）：状态冲突 409；缺理由/空文档是内容合规问题 422 */
  E_REVIEWING_IMMUTABLE: 409,
  E_DOC_VOID: 409,
  E_DOC_STATUS: 409,
  E_REVIEW_NOTE_REQUIRED: 422,
  E_VOID_REASON_REQUIRED: 422,
  E_SUBMIT_EMPTY: 422,
  E_REVERT_TARGET: 422,
  E_REVERT_IMPOSSIBLE: 422,
  E_REVERT_FOREIGN_WRITE: 403,
};

class HttpError extends Error {
  code: string;

  extra?: unknown;

  constructor(code: string, message: string, extra?: unknown) {
    super(message);
    this.name = 'HttpError';
    this.code = code;
    this.extra = extra;
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8');

function send(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded) return;
  const text = JSON.stringify(body ?? {});
  const bytes = encoder.encode(text);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('content-length', bytes.length);
  res.end(bytes);
}

function readRaw(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    req.on('data', (chunk: Uint8Array) => {
      size += chunk.length;
      if (size > 10_000_000) reject(new HttpError('E_BAD_REQUEST', '请求体过大'));
      chunks.push(chunk);
    });
    req.on('end', () => {
      const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      const merged = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.length;
      }
      resolve(decoder.decode(merged));
    });
    req.on('error', (err: Error) => reject(err));
  });
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readRaw(req);
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new HttpError('E_BAD_REQUEST', '请求体必须是 JSON 对象');
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError('E_BAD_REQUEST', `请求体不是合法 JSON：${(err as Error).message}`);
  }
}

export type AuthMode = 'trusted' | 'verified';

export interface ImpersonationAttempt {
  at: string;
  path: string;
  claimedKind: string;
  actualKind: string;
  actualId: string;
  tokenFingerprint: string;
}

function actorFrom(
  req: IncomingMessage,
  mode: AuthMode,
  directory: ActorDirectory,
  noteAttempt: (attempt: ImpersonationAttempt) => void,
): Actor {
  if (mode === 'verified') {
    const raw = req.headers['authorization'];
    const header = typeof raw === 'string' ? raw : '';
    const token = /^Bearer\s+/i.test(header) ? header.replace(/^Bearer\s+/i, '').trim() : '';
    if (token === '') {
      throw new HttpError('E_ACTOR_UNVERIFIED', 'verified 模式必须提供 Authorization: Bearer <凭证>（身份不得自报）');
    }
    const actor = directory.resolve(token);
    if (!actor) throw new HttpError('E_ACTOR_UNVERIFIED', '凭证无效或已撤销');

    const claimed = req.headers['x-actor-kind'];
    if (typeof claimed === 'string' && claimed !== '' && claimed !== actor.kind) {
      noteAttempt({
        at: new Date().toISOString(),
        path: req.url ?? '',
        claimedKind: claimed,
        actualKind: actor.kind,
        actualId: actor.id,
        tokenFingerprint: tokenFingerprint(token),
      });
    }
    return { id: actor.id, kind: actor.kind };
  }

  const id = req.headers['x-actor-id'];
  const kind = req.headers['x-actor-kind'];
  if (!id || !kind) throw new HttpError('E_ACTOR_REQUIRED', '缺少 X-Actor-Id / X-Actor-Kind 请求头');
  return { id: String(id), kind: String(kind) as Actor['kind'] };
}

function normalizeIncoming(raw: unknown, docId: string): DocumentModel {
  const doc = structuredClone(raw) as DocumentModel;
  doc.docId = docId;
  doc.status = 'draft';
  doc.signatureRefs = [];
  doc.updatedAt = doc.updatedAt || doc.createdAt;
  doc.revisions = [
    { rev: 1, at: doc.updatedAt, actorId: doc.createdBy ?? 'seed', op: 'create', targetId: doc.rootId },
  ];
  doc.machineReadable = buildMachineReadable({
    nodes: doc.nodes,
    rootId: doc.rootId,
    schemaVersion: doc.schemaVersion,
    generatedAt: doc.updatedAt,
  });
  return doc;
}

const COMMANDS = new Set([
  'createNode',
  'insertText',
  'updateNodeProps',
  'replaceRange',
  'setFieldValue',
  'moveNode',
  'deleteNode',
  'confirmNode',
  'confirmNodes',
  'sign',
  'unlock',
  'submitForReview',
  'review',
  'voidDoc',
  'archiveDoc',
  'revertTo',
]);

type CommandParams = Record<string, unknown>;

export interface ContractServerOptions {
  /** 建文档时是否强制跑模型校验（默认 true；关掉仅用于对照实验） */
  validateOnCreate?: boolean;
  authMode?: AuthMode;
  actors?: ActorDirectory;
  signer?: Signer;
}

export function createContractServer(options: ContractServerOptions = {}) {
  const validateOnCreate = options.validateOnCreate ?? true;
  const authMode: AuthMode = options.authMode ?? 'trusted';
  const directory = options.actors ?? new ActorDirectory();
  const signer = options.signer ?? softwareSigner(demoKeyPair(DEMO_SIGNING_SEED).privateKey);
  const sessions = new Map<string, WriteSession>();
  const impersonationAttempts: ImpersonationAttempt[] = [];
  let seq = 0;

  const noteAttempt = (attempt: ImpersonationAttempt): void => {
    impersonationAttempts.push(attempt);
    if (impersonationAttempts.length > 50) impersonationAttempts.shift();
  };

  const actorOf = (req: IncomingMessage): Actor => actorFrom(req, authMode, directory, noteAttempt);

  const requireSession = (docId: string): WriteSession => {
    const session = sessions.get(docId);
    if (!session) throw new HttpError('E_DOC_NOT_FOUND', `文档不存在：${docId}`);
    return session;
  };

  const optsOf = (body: Record<string, unknown>): WriteOptions => {
    const opts: WriteOptions = {};
    if (typeof body.clientOpId === 'string' && body.clientOpId) opts.clientOpId = body.clientOpId;
    if (typeof body.expectedRev === 'number') opts.expectedRev = body.expectedRev;
    return opts;
  };

  interface RouteResult {
    status?: number;
    payload: unknown;
  }

  type Handler = (match: RegExpExecArray, url: URL, req: IncomingMessage) => Promise<RouteResult>;

  const routes: Array<{ method: string; pattern: RegExp; handler: Handler }> = [
    {
      method: 'GET',
      pattern: /^\/health$/,
      handler: async () => ({
        payload: {
          ok: true,
          service: 'l0-contract-server',
          authMode,
          actorVerified: authMode === 'verified',
          registeredActors: directory.size(),
          impersonationCount: impersonationAttempts.length,
          /* 自称身份的尝试：最近 5 条。只给证据，不给凭证（tokenFingerprint 不可反推）  */
          impersonationAttempts: impersonationAttempts.slice(-5),
          ...(authMode === 'trusted'
            ? {
                warning:
                  '身份未验证：本模式信任请求头 X-Actor-Kind，任何调用方都可以自称 human/ai/system，AI 门控在协议层可被绕过。仅限开发与契约测试；生产必须使用 authMode=verified',
              }
            : {}),
        },
      }),
    },
    {
      method: 'GET',
      pattern: /^\/documents\/([^/]+)\/ai-context$/,
      handler: async (match, url, req) => {
        const session = requireSession(decodeURIComponent(match[1] as string));
        const actor = actorOf(req);
        const nodeIds = url.searchParams
          .getAll('nodeId')
          .flatMap((value) => value.split(','))
          .map((value) => value.trim())
          .filter((value) => value !== '');
        const before = Number(url.searchParams.get('contextBefore') ?? '');
        const after = Number(url.searchParams.get('contextAfter') ?? '');
        const budget = Number(url.searchParams.get('tokenBudget') ?? '');
        try {
          return {
            payload: buildAiContext(session.document, {
              nodeIds,
              ...(Number.isFinite(before) && before > 0 ? { contextBefore: Math.floor(before) } : {}),
              ...(Number.isFinite(after) && after > 0 ? { contextAfter: Math.floor(after) } : {}),
              ...(Number.isFinite(budget) && budget > 0 ? { tokenBudget: Math.floor(budget) } : {}),
              includePatient: url.searchParams.get('includePatient') === 'true',
              includeDataElements: url.searchParams.get('includeDataElements') === 'true',
              actor,
            }),
          };
        } catch (err) {
          if (err instanceof AiContextError) throw new HttpError(err.code, err.message);
          throw err;
        }
      },
    },
    {
      method: 'POST',
      pattern: /^\/documents\/([^/]+)\/external-data$/,
      handler: async (match, _url, req) => {
        const session = requireSession(decodeURIComponent(match[1] as string));
        const actor = actorOf(req);
        const body = await readJson(req);
        return { payload: session.applyExternalData({ items: (body.items ?? []) as never }, actor) };
      },
    },
    {
      method: 'POST',
      pattern: /^\/documents$/,
      handler: async (_m, _url, req) => {
        if (authMode === 'verified') actorOf(req);
        const body = await readJson(req);
        const doc = body.doc;
        if (!doc || typeof doc !== 'object' || !(doc as DocumentModel).nodes) {
          throw new HttpError('E_BAD_DOC', '请求体必须包含完整 doc（含 nodes）');
        }
        seq += 1;
        const incoming = doc as DocumentModel;
        const docId = incoming.docId && !sessions.has(incoming.docId) ? incoming.docId : `doc_srv_${seq}`;
        const normalized = normalizeIncoming(incoming, docId);
        if (validateOnCreate) {
          const issues = errorsOf(validateDocument(normalized));
          if (issues.length > 0) {
            throw new HttpError('E_BAD_DOC', `初始文档未通过校验（${issues.length} 个错误）：${issues.slice(0, 3).map((issue) => `${issue.code}@${issue.path}`).join(', ')}`, { issues });
          }
        }
        sessions.set(docId, WriteSession.open(normalized, { signer, clock: 'wall' }));
        return { status: 201, payload: { docId } };
      },
    },
    {
      method: 'GET',
      pattern: /^\/documents\/([^/]+)$/,
      handler: async (match) => ({ payload: { doc: requireSession(decodeURIComponent(match[1] as string)).snapshot() } }),
    },
    {
      method: 'GET',
      pattern: /^\/documents\/([^/]+)\/nodes\/([^/]+)$/,
      handler: async (match) => {
        const session = requireSession(decodeURIComponent(match[1] as string));
        const nodeId = decodeURIComponent(match[2] as string);
        const node = session.getNode(nodeId);
        if (!node) throw new HttpError('E_NODE_NOT_FOUND', `节点不存在：${nodeId}`);
        return { payload: { node: structuredClone(node) } };
      },
    },
    {
      method: 'GET',
      pattern: /^\/documents\/([^/]+)\/audit$/,
      handler: async (match, url) => {
        const session = requireSession(decodeURIComponent(match[1] as string));
        const actorId = url.searchParams.get('actorId');
        const op = url.searchParams.get('op');
        const targetId = url.searchParams.get('targetId');
        const items = session
          .auditQuery({
            ...(url.searchParams.get('from') ? { from: url.searchParams.get('from') as string } : {}),
            ...(url.searchParams.get('to') ? { to: url.searchParams.get('to') as string } : {}),
            ...(actorId ? { actorId } : {}),
            ...(op ? { op: op as RevisionOp } : {}),
          })
          .filter((revision) => !targetId || revision.targetId === targetId);
        return { payload: { items: structuredClone(items) } };
      },
    },
    {
      method: 'GET',
      pattern: /^\/documents\/([^/]+)\/timing$/,
      handler: async (match) => {
        const timing = requireSession(decodeURIComponent(match[1] as string)).timing();
        /* `trusted:false` 要随数字一起给出：调用方拿到的如果不是可信值，必须当场看得见 */
        return { payload: { timing } };
      },
    },
    {
      method: 'GET',
      pattern: /^\/documents\/([^/]+)\/metrics$/,
      handler: async (match) => ({ payload: { metrics: requireSession(decodeURIComponent(match[1] as string)).getMetrics() } }),
    },
    {
      method: 'GET',
      pattern: /^\/documents\/([^/]+)\/suggestions$/,
      handler: async (match, url) => {
        const session = requireSession(decodeURIComponent(match[1] as string));
        const status = url.searchParams.get('status');
        const targetNodeId = url.searchParams.get('targetNodeId');
        const groupId = url.searchParams.get('groupId');
        const items = session.listSuggestions({
          ...(status ? { status: status as 'pending' | 'accepted' | 'rejected' } : {}),
          ...(targetNodeId ? { targetNodeId } : {}),
          ...(groupId ? { groupId } : {}),
        });
        return { payload: { items } };
      },
    },
    {
      method: 'POST',
      pattern: /^\/documents\/([^/]+)\/suggestions$/,
      handler: async (match, _url, req) => {
        const session = requireSession(decodeURIComponent(match[1] as string));
        const actor = actorOf(req);
        const body = await readJson(req);
        return { status: 201, payload: session.suggestText(body as never, actor) };
      },
    },
    {
      method: 'POST',
      pattern: /^\/documents\/([^/]+)\/suggestions\/batch$/,
      handler: async (match, _url, req) => {
        const session = requireSession(decodeURIComponent(match[1] as string));
        const actor = actorOf(req);
        const body = await readJson(req);
        return { status: 201, payload: session.suggestBatch(body as never, actor) };
      },
    },
    {
      method: 'POST',
      pattern: /^\/documents\/([^/]+)\/suggestions\/(accept|reject)$/,
      handler: async (match, _url, req) => {
        const session = requireSession(decodeURIComponent(match[1] as string));
        const action = match[2] as 'accept' | 'reject';
        const actor = actorOf(req);
        const body = await readJson(req);
        const opts = optsOf(body);
        const scope = {
          ...(typeof body.groupId === 'string' ? { groupId: body.groupId } : {}),
          ...(Array.isArray(body.suggestionIds) ? { suggestionIds: body.suggestionIds as string[] } : {}),
        };
        if (action === 'accept') {
          const editedTexts =
            body.editedTexts && typeof body.editedTexts === 'object' ? { editedTexts: body.editedTexts as Record<string, string> } : {};
          return { payload: session.acceptSuggestions({ ...scope, ...editedTexts }, actor, opts) };
        }
        const reason = typeof body.reason === 'string' ? { reason: body.reason } : {};
        return { payload: session.rejectSuggestions({ ...scope, ...reason }, actor, opts) };
      },
    },
    {
      method: 'GET',
      pattern: /^\/documents\/([^/]+)\/suggestion-groups$/,
      handler: async (match) => ({ payload: { groups: requireSession(decodeURIComponent(match[1] as string)).listSuggestionGroups() } }),
    },
    {
      method: 'GET',
      pattern: /^\/documents\/([^/]+)\/annotations$/,
      handler: async (match, url) => {
        const session = requireSession(decodeURIComponent(match[1] as string));
        const status = url.searchParams.get('status');
        const kind = url.searchParams.get('kind');
        const nodeId = url.searchParams.get('nodeId');
        const anchorState = url.searchParams.get('anchorState');
        const items = session.listAnnotations({
          ...(status ? { status: status as 'open' | 'acknowledged' | 'dismissed' | 'resolved' } : {}),
          ...(kind ? { kind: kind as 'quality' | 'form' | 'note' } : {}),
          ...(nodeId ? { nodeId } : {}),
          ...(anchorState ? { anchorState: anchorState as 'valid' | 'relocated' | 'lost' } : {}),
        });
        return { payload: { items, counts: session.annotationCounts() } };
      },
    },
    {
      method: 'POST',
      pattern: /^\/documents\/([^/]+)\/annotations$/,
      handler: async (match, _url, req) => {
        const session = requireSession(decodeURIComponent(match[1] as string));
        const actor = actorOf(req);
        const body = await readJson(req);
        return { status: 201, payload: session.annotate(body as never, actor) };
      },
    },
    {
      method: 'POST',
      pattern: /^\/documents\/([^/]+)\/annotations\/([^/]+)\/(acknowledge|dismiss|resolve)$/,
      handler: async (match, _url, req) => {
        const session = requireSession(decodeURIComponent(match[1] as string));
        const annotationId = decodeURIComponent(match[2] as string);
        const body = await readJson(req);
        const statusMap: Record<string, 'acknowledged' | 'dismissed' | 'resolved'> = {
          acknowledge: 'acknowledged',
          dismiss: 'dismissed',
          resolve: 'resolved',
        };
        const status = statusMap[String(match[3])] as 'acknowledged' | 'dismissed' | 'resolved';
        const note = typeof body.note === 'string' ? { note: body.note } : {};
        return { payload: session.resolveAnnotation({ annotationId, status, ...note }, actorOf(req)) };
      },
    },
    {
      method: 'POST',
      pattern: /^\/documents\/([^/]+)\/annotations\/([^/]+)\/anchor-lost$/,
      handler: async (match, _url, req) => {
        const session = requireSession(decodeURIComponent(match[1] as string));
        const body = await readJson(req);
        const note = typeof body.note === 'string' ? { note: body.note } : {};
        return { payload: session.confirmAnchorLost({ annotationId: decodeURIComponent(match[2] as string), ...note }, actorOf(req)) };
      },
    },
    {
      method: 'POST',
      pattern: /^\/documents\/([^/]+)\/suggestions\/([^/]+)\/(accept|reject)$/,
      handler: async (match, _url, req) => {
        const session = requireSession(decodeURIComponent(match[1] as string));
        const suggestionId = decodeURIComponent(match[2] as string);
        const action = match[3];
        const actor = actorOf(req);
        const body = await readJson(req);
        const opts = optsOf(body);
        const result =
          action === 'accept'
            ? session.acceptSuggestion(
                {
                  suggestionId,
                  ...(typeof body.editedText === 'string' && body.editedText.length > 0 ? { editedText: body.editedText } : {}),
                  ...(Array.isArray(body.aiRanges)
                    ? {
                        aiRanges: body.aiRanges.map((range) => ({
                          start: Number((range as { start?: unknown } | null)?.start),
                          end: Number((range as { end?: unknown } | null)?.end),
                        })),
                      }
                    : {}),
                },
                actor,
                opts,
              )
            : session.rejectSuggestion(
                { suggestionId, ...(typeof body.reason === 'string' ? { reason: body.reason } : {}) },
                actor,
                opts,
              );
        return { payload: result };
      },
    },
    {
      method: 'GET',
      pattern: /^\/documents\/([^/]+)\/machine-readable$/,
      handler: async (match) => ({
        payload: { machineReadable: requireSession(decodeURIComponent(match[1] as string)).exportMachineReadable() },
      }),
    },
    {
      method: 'POST',
      pattern: /^\/documents\/([^/]+)\/export\/ofd$/,
      handler: async (match, _url, req) => {
        const docId = decodeURIComponent(match[1] as string);
        const session = requireSession(docId);
        const body = await readJson(req);
        const plan = body.plan as OfdExportPlan;
        const pkg = await session.exportOfd(plan);
        return {
          payload: {
            ok: true,
            file: `memory://ofd/${docId}.ofd`,
            carrier: plan?.machineReadable?.carrier ?? 'separate-xml',
            signed: plan?.machineReadable?.signed === true,
            pages: pkg.pages,
            stats: pkg.stats,
            entries: pkg.entries.map((entry) => entry.path),
          },
        };
      },
    },
    {
      method: 'POST',
      pattern: /^\/documents\/([^/]+)\/commands$/,
      handler: async (match, _url, req) => {
        const session = requireSession(decodeURIComponent(match[1] as string));
        const actor = actorOf(req);
        const body = await readJson(req);
        const op = String(body.op ?? '');
        const params = (body.params ?? {}) as CommandParams;
        const opts = optsOf(body);
        if (!COMMANDS.has(op)) throw new HttpError('E_UNKNOWN_OP', `未知操作：${op}`);
        return { payload: await dispatch(session, op, params, actor, opts) };
      },
    },
  ];

  async function dispatch(session: WriteSession, op: string, params: CommandParams, actor: Actor, opts: WriteOptions): Promise<unknown> {
    switch (op) {
      case 'createNode':
        return session.createNode(params as never, actor, opts);
      case 'insertText':
        return session.insertText(params as never, actor, opts);
      case 'updateNodeProps':
        return session.updateNodeProps(params as never, actor, opts);
      case 'replaceRange':
        return session.replaceRange(params as never, actor, opts);
      case 'setFieldValue':
        return session.setFieldValue(params as never, actor, opts);
      case 'moveNode':
        return session.moveNode(params as never, actor, opts);
      case 'deleteNode':
        return session.deleteNode(params as never, actor, opts);
      case 'confirmNode':
        return session.confirmNode(params as never, actor, opts);
      case 'confirmNodes':
        return session.confirmNodes(params as never, actor, opts);
      case 'sign':
        return await session.sign({}, actor, opts);
      case 'unlock':
        return session.unlock(params as never, actor, opts);
      case 'submitForReview':
        return session.submitForReview(params as never, actor, opts);
      case 'review':
        return await session.review(params as never, actor, opts);
      case 'voidDoc':
        return session.voidDoc(params as never, actor, opts);
      case 'archiveDoc':
        return session.archiveDoc(params as never, actor, opts);
      case 'revertTo':
        return session.revertTo(params as never, actor, opts);
      default:
        throw new HttpError('E_UNKNOWN_OP', `未知操作：${op}`);
    }
  }

  const server = createServer((req, res) => {
    res.setHeader('x-l0-auth-mode', authMode);
    res.setHeader('x-l0-actor-verified', authMode === 'verified' ? 'true' : 'false');
    void (async () => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
      for (const route of routes) {
        if (route.method !== req.method) continue;
        const match = route.pattern.exec(url.pathname);
        if (!match) continue;
        try {
          const result = await route.handler(match, url, req);
          send(res, result.status ?? 200, result.payload);
        } catch (err) {
          const code = (err as { code?: string }).code;
          if (err instanceof WriteError || err instanceof HttpError) {
            send(res, STATUS_BY_CODE[code ?? ''] ?? 400, {
              code,
              message: (err as Error).message,
              ...((err as HttpError).extra ? { extra: (err as HttpError).extra } : {}),
            });
          } else {
            send(res, 500, { code: 'E_INTERNAL', message: (err as Error).message });
          }
        }
        return;
      }
      send(res, 404, { code: 'E_ROUTE_NOT_FOUND', message: `未找到路由：${req.method} ${url.pathname}` });
    })();
  });

  return {
    server,
    async listen(port = 8801, host = '127.0.0.1'): Promise<string> {
      await new Promise<void>((resolve) => {
        server.listen(port, host, resolve);
      });
      return `http://${host}:${port}`;
    },
    async close(): Promise<void> {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
    size: () => sessions.size,
    sessionOf: (docId: string): WriteSession | undefined => sessions.get(docId),
    nodeIdOf: (docId: string, nodeId: NodeId) => sessions.get(docId)?.getNode(nodeId) ?? null,
  };
}

const portIndex = process.argv.indexOf('--port');
const isMain = process.argv[1]?.includes('contract-server');

function valuesOf(flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < process.argv.length; i += 1) {
    if (process.argv[i] === flag && process.argv[i + 1] !== undefined) out.push(process.argv[i + 1] as string);
  }
  return out;
}

if (isMain) {
  const port = portIndex >= 0 ? Number(process.argv[portIndex + 1]) || 8801 : 8801;
  const authMode = (valuesOf('--auth-mode')[0] ?? 'trusted') as AuthMode;
  if (authMode !== 'trusted' && authMode !== 'verified') {
    process.stderr.write(`未知身份模式：${authMode}（可选 trusted | verified）\n`);
    process.exit(2);
  }

  const actors = new ActorDirectory();
  for (const spec of valuesOf('--actor')) {
    /* 格式：<凭证>:<actorId>:<human|ai|system>[:<展示名>]，凭证内不得含冒号 */
    const [token, id, kindRaw, label] = spec.split(':');
    const kind = kindRaw as ActorKind | undefined;
    if (!token || !id) {
      process.stderr.write(`--actor 格式应为 <凭证>:<actorId>:<human|ai|system>[:<展示名>]，实际：${spec}\n`);
      process.exit(2);
    }
    if (kind !== 'human' && kind !== 'ai' && kind !== 'system') {
      process.stderr.write(`--actor 的 kind 必须是 human | ai | system，实际：${spec}\n`);
      process.exit(2);
    }
    actors.register(token, { id, kind: kind as ActorKind, ...(label ? { label } : {}) });
  }

  if (authMode === 'verified' && actors.size() === 0) {
    process.stderr.write('verified 模式必须至少注册一个凭证（--actor <凭证>:<id>:<kind>），否则所有请求都会 401\n');
    process.exit(2);
  }

  const instance = createContractServer({ authMode, actors });
  const url = await instance.listen(port);
  process.stdout.write(`L0 契约服务端已启动：${url}\n`);
  process.stdout.write(`身份模式：${authMode}（${authMode === 'verified' ? '凭证定身份，请求头不采信' : '信任请求头，身份未验证'}）\n`);
  for (const record of actors.list()) {
    process.stdout.write(`  已注册：${record.id}（${record.kind}${record.label ? `，${record.label}` : ''}）凭证指纹 ${record.tokenFingerprint}\n`);
  }
  if (authMode === 'trusted') {
    process.stdout.write(
      '警告：trusted 模式下任何调用方都可以自称 human，AI 门控在协议层可被绕过，仅限开发与契约测试。\n' +
        '  现场/生产启动示例：node src/server/contract-server.ts --port 8801 --auth-mode verified --actor <凭证>:DR_WANG:human\n',
    );
  }
  process.stdout.write(
    '签名后端：内置软件实现 + 演示种子（仅契约验证与演示用；生产必须换经认证的密码模块）。\n' +
      '  产品入口（npm run demo）不提供内置软件签名：未配置医院签名服务时签章会被拒绝。\n',
  );
  process.stdout.write(`验收：node tools/model-check/ai-path-check.mjs --adapter .\\tools\\model-check\\lib\\http-store-adapter.mjs --base-url ${url}\n`);
}
