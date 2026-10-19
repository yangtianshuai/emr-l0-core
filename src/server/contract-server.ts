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
  /* 批量建议操作的范围问题：属"请求不合法"（400），与"状态冲突"（409）不同 */
  E_SUGGESTION_SCOPE_REQUIRED: 400,
  /* 旁挂注解：不存在 404 / 状态冲突 409 / 缺依据 422 */
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
  /* 区间非法与参数类错误同属"请求本身不对"（规格第 9.4 节把 E_OFFSET_RANGE 归在 400） */
  E_OFFSET_RANGE: 400,
  /* 本实现补齐的显式错误码 */
  E_ACTOR_REQUIRED: 400,
  E_ACTOR_INVALID: 400,
  /* 身份未验证：verified 模式下缺少/无效凭证。401 而不是 403 ——
     403 是"身份可信但无权"，401 是"身份根本不可信"，两者运维含义完全不同 */
  E_ACTOR_UNVERIFIED: 401,
  /* AI 上下文取数：范围缺失是调用方错误（400），目标不存在是资源问题（404） */
  E_AI_CONTEXT_SCOPE_REQUIRED: 400,
  E_AI_CONTEXT_EMPTY: 404,
  /* 批量确认与系统取数：缺范围是调用方错误；身份不符 403；覆盖人工内容算冲突 409 */
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
  /* 回到历史版本：目标不合法与"那一版回不去"都是 422 —— 它们是内容/不可逆性问题，不是请求格式问题 */
  E_REVERT_TARGET: 422,
  E_REVERT_IMPOSSIBLE: 422,
  /* 区间里有别人的内容：这是"不许做"，不是"做不了" —— 403 让对接方分得清 */
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

/** "自称身份"的尝试记录（内存，供 /health 查询） */
export interface ImpersonationAttempt {
  at: string;
  path: string;
  claimedKind: string;
  actualKind: string;
  actualId: string;
  tokenFingerprint: string;
}

/**
 * 解析调用者身份。
 *
 * `verified` 模式：身份只来自凭证，id 与 kind 由服务端目录决定；
 * 请求头 `X-Actor-Kind` 一律忽略。若请求头与目录不一致，说明有人在试图自称身份
 * （典型场景：AI 服务自称 human 以便直接写病历），必须留下可查询的证据，
 * 而不是静默忽略 —— 静默忽略等于假装没发生过。
 *
 * `trusted` 模式：信任请求头。这不是"简化版"，而是明确的降级：
 * 该模式下任何调用方都能自称 human，AI 门控在协议层可被绕过。
 * 因此本模式的状态会出现在每一次响应头与 `/health` 里，绝不静默（见 sendHeaders）。
  */
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

/**
 * 建文档时的归一化：与参考实现语义一致 ——
 * 无论客户端提交的初始文档是什么状态，一律视为新草稿：
 * 状态置 draft、清空签名、留痕重置为一条 create、并按当前节点树重新派生机读块。
 * （机读块必须先建：否则"机读重算/陈旧拒绝"这类用例在 HTTP 侧无从触发。）
  */
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

/* 命令集对齐 `docs/L0-节点操作API清单.md` 第 9.3 节。
   `replaceRange` 是本轮补齐的（规格第 22 行早已列出，内核此前没有实现）；
   `moveNode` 是顺手补的 —— 它同样在规格第二节里，而契约服务端此前漏了它，
   于是"移动节点"在本服务端会落到 `E_UNKNOWN_OP`（协议实现与规格不一致）。 */
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
  /* 审签状态机（K12）：四个动作与内容写入共用同一条命令通道，
     这样"审核"不是一条独立的旁路，任何对接方都走同一套身份与留痕。 */
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
  /** 凭证目录（verified 模式必需） */
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

  /** 记录"自称身份"的尝试：供 /health 查询。内存即可（重启清零），但绝不静默丢弃 */
  const noteAttempt = (attempt: ImpersonationAttempt): void => {
    impersonationAttempts.push(attempt);
    if (impersonationAttempts.length > 50) impersonationAttempts.shift();
  };

  /** 本实例的身份解析：绑定模式与目录，避免每个 handler 重复传参 */
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
          /* 这两个字段是给"接入自助诊断"用的：只看到 401 不知道是凭证错还是模式配置错 */
          actorVerified: authMode === 'verified',
          registeredActors: directory.size(),
          impersonationCount: impersonationAttempts.length,
          /* 自称身份的尝试：最近 5 条。只给证据，不给凭证（tokenFingerprint 不可反推）  */
          impersonationAttempts: impersonationAttempts.slice(-5),
          /* 刻意不返回 actor 清单：id 本身也是敏感信息（人名/系统名），
             需要核对时用启动日志或 CLI 查看  */
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
        /* 取数接口同样要求身份：它把（脱敏后的）病历内容交给外部模型。
           规则与写操作一致：trusted 看请求头，verified 看凭证。
           注意：AI 身份来取上下文是合法用途（这就是它的工作），被禁的是落笔。  */
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
          /* 领域的 fail-closed 错误（范围缺失/目标不存在）转成协议错误，保留原错误码 ——
             错误码是对接方唯一的定位依据，合并成一句"请求错误"等于让人无从下手  */
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
        /* 系统取数：真实场景是 HIS/LIS 推送（一份报告携带若干字段值）。
           身份同样必须可信（verified 模式看凭证），且只有 system 身份能调 ——
           内核会拒绝 AI 与人类：AI 走建议通道（会编），人类走 commands。
           返回体含 applied / skipped（重复到达）与 revision，便于推送方对账。  */
        return { payload: session.applyExternalData({ items: (body.items ?? []) as never }, actor) };
      },
    },
    {
      method: 'POST',
      pattern: /^\/documents$/,
      handler: async (_m, _url, req) => {
        /* verified 模式下"建文档"同样是写操作，必须先过身份 —— 否则可以匿名往系统里灌文档。
           trusted 模式保持原样：现有 26 条契约与 Demo 都按请求头发身份，改成强制会集体失效。
           边界（已知）：verified 模式下读接口目前仍不要求凭证，属于下一步收口范围。  */
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
        /* 时间窗交给内核的 `auditQuery`（闭区间口径只有一处），这里只负责把参数传进去 */
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
        /* 一批 = 一组：组 ID 由服务端生成，请求里给什么 groupId 都不采信 */
        return { status: 201, payload: session.suggestBatch(body as never, actor) };
      },
    },
    {
      /**
       * 批量 / 组级采纳或拒绝。范围由 `groupId` 或 `suggestionIds` 二选一给出。
       *
       * 采纳返回 200 而不是 4xx，是有意的：这是"部分成功"语义 ——
       * 够门槛的落笔、不够的在 `blocked` 里如实列出并保持待处理。
       * 若用错误码表达，调用方会以为整批失败并整批重试（而重试也没用，
       * 因为拦下它的是置信度而非临时故障）。
        */
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
        /* counts 一并下发：`anchorLost` 是需要人去处理的一项，不能只给列表不给计数 */
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
        /* 旁挂层：这条路由不改 rev、不进文档留痕（见 src/core/annotations.ts 文件头）  */
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
                  /* 与 demo 服务端同一条口径：形状收敛在这里，合法性判定在内核 */
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
        /* 不回传二进制（Uint8Array 进 JSON 会变成巨大的数字对象）：
           只给可判定的摘要 + 文件清单；取二进制走 GET /documents/:id/export/ofd/:name */
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

  /* 异步：`sign` 要经过签名后端（可能是网络服务或密码设备）。
     这里返回 Promise 而不 await 的话，它会被当成普通值塞进响应（序列化成 `{}`），
     而且拒约会变成 unhandled rejection 直接把服务打挂 —— 实测踩到。  */
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
    /* 每一次响应都携带身份模式与是否已验证 —— 让"降级"无法被忽略：
       对接方与运维可以在不改代码的前提下自查自己连的是哪种模式。
       若只把这件事写进文档，实际部署时没人会看。  */
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
    /** 供测试直接注入节点、断言内部状态（不经过 HTTP） */
    sessionOf: (docId: string): WriteSession | undefined => sessions.get(docId),
    nodeIdOf: (docId: string, nodeId: NodeId) => sessions.get(docId)?.getNode(nodeId) ?? null,
  };
}

const portIndex = process.argv.indexOf('--port');
const isMain = process.argv[1]?.includes('contract-server');

/** 取 `--flag value` 形式的参数（允许重复出现） */
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
    /* kind 的合法性必须单独判断：把判断结果存进变量再合并成一个 if，
       TS 无法据此收窄 `kind` 的类型（收窄只在直接判断时生效）  */
    if (kind !== 'human' && kind !== 'ai' && kind !== 'system') {
      process.stderr.write(`--actor 的 kind 必须是 human | ai | system，实际：${spec}\n`);
      process.exit(2);
    }
    /* 这里需要显式断言：本仓库手写的 Node 类型声明把 `process.exit` 标成 `void`
       （不是 `never`），因此上面的合法性检查无法让 TS 收窄 `kind` 的类型。
       断言在此处安全 —— 非法取值已在上一行被拦掉并退出。 */
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
  /* 签名后端必须如实打印：本服务端默认用演示密钥签（它是验证靶子），
     但若不说，"启动成功"很容易被读成"已经接上了密码设备"。  */
  process.stdout.write(
    '签名后端：内置软件实现 + 演示种子（仅契约验证与演示用；生产必须换经认证的密码模块）。\n' +
      '  产品入口（npm run demo）不提供内置软件签名：未配置医院签名服务时签章会被拒绝。\n',
  );
  process.stdout.write(`验收：node tools/model-check/ai-path-check.mjs --adapter .\\tools\\model-check\\lib\\http-store-adapter.mjs --base-url ${url}\n`);
}
