// L0 可交互 Demo 服务（零依赖，仅用 node:http）。
// 但它们未经第三方审计，不得用于合规声明。

import { spawnSync } from 'node:child_process';
/* 管理后台会话 id：必须是不可猜的随机值（它等同于一次登录凭证） */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { IMAGE_EXTENSION, MAX_IMAGE_BYTES, mimeOfExtension, probeImage } from '../media/image-probe.ts';

/* 本环境的 node:fs 类型声明不完整（缺 unlink 等同步 API），局部断言（同 core/persistence.ts） */
const fsx = (await import('node:fs')) as unknown as { unlinkSync: (path: string) => void };
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WriteError, WriteSession, type Actor } from '../core/session.ts';
import { summarizeRevision } from '../core/revision-summary.ts';
import { applyWritingTiming } from '../core/writing-timing.ts';
import { demoTranscript, normalizeSegments, type DictationInput, type TranscriptSegment } from '../core/dictation.ts';
import { collectCandidates, placedNodeIds, placePastedParagraphs } from '../dictation/placement.ts';
import { resolvePlacements, type ResolvedPlacement } from '../dictation/external-placement.ts';
import { PLACEMENT_CONFIG_FILE, describePlacementConfig, loadPlacementConfig, savePlacementConfig, type LoadedPlacementConfig } from '../dictation/placement-store.ts';
import {
  CAPTURE_CONFIG_FILE,
  describeCaptureConfig,
  loadCaptureConfig,
  saveCaptureConfig,
  type LoadedCaptureConfig,
} from '../dictation/capture-store.ts';
import {
  ASR_NO_CONFIDENCE_NOTE,
  CaptureError,
  createAsrClient,
  validateSubmittedSegments,
  type CaptureFailure,
} from '../dictation/capture.ts';
import { createSampleCaptureSource, CaptureSourceError, type CaptureSource } from '../dictation/capture-source.ts';
import { runDictationCapture, type CaptureOutcome, type CapturePhase } from '../dictation/capture-client.ts';
import { parseMultipartAudio } from '../dictation/capture-upload.ts';
import { SIGN_CONFIG_FILE, describeSignConfig, loadSignConfig, saveSignConfig, type LoadedSignConfig } from '../sign/sign-config-store.ts';
import {
  READING_AUTHORITY_FILE,
  describeReadingAuthority,
  loadReadingAuthority,
  saveReadingAuthority,
  type LoadedReadingAuthorityConfig,
} from '../reading/reading-authority-store.ts';
import { checkIssuerTrust, parseCredential } from '../reading/reading-authority.ts';
import { createRemoteSigner, testSign } from '../sign/remote-signer.ts';
import type { SignConfigInput } from '../sign/sign-config.ts';
import type { Signer } from '../crypto/provider.ts';
import { loadSidecarsSealed, saveSidecarsSealed } from '../core/store.ts';
import { SNAPSHOT_CONFLICT_CODE } from '../core/persistence.ts';
import { AdminAuditLog } from '../core/admin-audit-store.ts';
import { importAuditOnce } from '../storage/audit-files-import.ts';
import {
  legacyLayoutInRepo,
  planLegacyArchive,
  planRuntimeMigration,
  realMigrationProbe,
  resolveRuntimeLayout,
  runLegacyArchive,
  runRuntimeMigration,
} from '../core/runtime-dir.ts';
import { openDatabase, type OpenDatabaseResult } from '../storage/sqlite.ts';
import { MIGRATIONS, STORAGE_SCHEMA_VERSION } from '../storage/schema.ts';
import { WorkStore, type WorkspaceStructure } from '../storage/work-store.ts';
import { createConfigKv } from '../storage/config-kv.ts';
import { importLegacyConfigOnce } from '../storage/config-files-import.ts';
import { AuditAnchorStore, signAnchor, verifyAnchor } from '../core/admin-audit-anchor.ts';
import { SessionStore } from '../auth/session-store.ts';
import { PASSWORD_MIN_LENGTH, UserError, UserStore } from '../auth/user-store.ts';
import {
  ACTION_LABELS,
  ALL_ACTIONS,
  AUTH_ERRORS,
  ROLE_LABELS,
  authorize,
  can,
  rolesFor,
  type Action,
  type Principal,
  type Role,
} from '../auth/principal.ts';
import { SlidingWindowLimiter, type RateRule } from '../auth/rate-limit.ts';
import { softwareSigner, softwareVerifier } from '../crypto/provider.ts';
import { AI_SILENCE_LABELS, resolveSilenceReport, targetNodeIdsOf, type AiAdapter, type AiSilenceReport, type AiSuggestRequest } from '../ai/adapter.ts';
import { createHttpAdapter } from '../ai/http-adapter.ts';
import { createOfflineAdapter } from '../ai/offline-adapter.ts';
import { buildAiContext, type AiContextPackage } from '../core/ai-context.ts';
import { MODEL_CONFIG_FILE, MODEL_KEY_FILE, describeModelConfig, loadModelConfig, saveModelConfig, type LoadedModelConfig } from '../ai/model-config-store.ts';
import { listFormRules, qcContextOf, runFormRules } from '../qc/form-rules.ts';
/* 就诊时间轴：把跨文书结论摆回"一条线"上（判定仍由已编译的规则给出，见该模块文件头） */
import { buildVisitTimeline, crossDocRulesOf, type VisitTimeline } from '../qc/visit-timeline.ts';
import { qcPredicateCatalog } from '../qc/predicates.ts';
/* 自定义条件的构造器规格：只在上游写一处，界面照下发的那份渲染 */
import { conditionCatalog } from '../qc/condition.ts';
import {
  conditionSummaryOf,
  resolvedConditionsOf,
  ruleItemsOf,
  rulesFromRegistry,
  validateRulePack,
  type ConditionLibrary,
} from '../qc/rule-pack.ts';
/* 出厂种子判定方式：首次启动写进判定方式库一次，此后归本院维护（可改可删，不会再回来）  */
import { SEED_CONDITIONS } from '../qc/seed-conditions.ts';
/* 判定方式库的落库（库级资产：全院一份、不属于任何包，见该模块文件头） */
import {
  assertLibraryChangeIsSafe,
  CONDITION_MIGRATION_KEY,
  conditionsSeeded,
  describeConditions,
  loadConditions,
  markConditionsSeeded,
  saveConditions,
  type LoadedConditions,
} from '../qc/condition-store.ts';
/* 算子插件（T3）：部署方安装的签名组件 —— 包是数据，插件是代码，两件事的信任门槛不同  */
import { loadQcPlugins, readPluginKey, type QcPluginLoadReport } from '../qc/plugin.ts';
/* 规则条目的编辑（新建 / 修改 / 删除）：与"整包载入"改的是同一件东西（包内容） */
import {
  addRule,
  CUSTOM_RULE_PACK_ID,
  customRulePackBase,
  patchRuleDescriptor,
  predicateLabelOf,
  removeRule,
} from '../qc/rule-edit.ts';
import {
  addCondition,
  conditionCatalogOf,
  conditionLibraryOf,
  patchCondition,
  removeCondition,
  type QcConditionCatalogEntry,
} from '../qc/condition-library.ts';
import type { AnnotationSeverity } from '../core/annotations.ts';
/* 改动幅度的分档也读内核那一处（`editBandOf`）：前端与这里都不自己定阈值 ——
   否则"调一次边界"会变成一次前后端联动发布，而漏改的那一侧只表现为
   "同一批数据在界面上分档与报表对不上"  */
import { editBandOf } from '../core/suggestions.ts';
import type { QcConditionDefinition, QcRuleDescriptor, QcRulePack, QcUnevaluated, QcVisitDoc } from '../qc/types.ts';
import {
  CONTENT_ENGINE_API,
  buildContentRequest,
  createHttpContentEngine,
  createUnavailableEngine,
  describeContentContract,
  parseContentRules,
  validateEngineOutput,
  type ContentQcEngine,
  type ContentQcRuleBrief,
} from '../qc/content-engine.ts';
/* 模型形态的传输层：与 http 同契约、同安全边界（接的是管理后台「能力配置」里那一个模型） */
import { createModelContentEngine } from '../qc/content-engine-model.ts';
import {
  SUPPORTED_PACK_ENGINE_APIS,
  createEmptyPackRegistry,
  packValidatorFor,
} from '../knowledge/default-registry.ts';
import type { Pack, PackKind } from '../knowledge/pack.ts';
import { deletePack, openPackStore, saveDisabledItems, writePack, type PackStoreReport } from '../knowledge/pack-store.ts';
import {
  departmentNameOf,
  departmentsSeeded,
  describeDepartments,
  isDepartmentSelectable,
  loadDepartments,
  markDepartmentsSeeded,
  normalizeDepartmentCode,
  saveDepartments,
  type LoadedDepartments,
} from '../storage/department-store.ts';
import {
  describeDocTypes,
  docTypeKeyOf,
  docTypesSeeded,
  loadDocTypes,
  markDocTypesSeeded,
  saveDocTypes,
  type DocTypeItem,
  type LoadedDocTypes,
} from '../storage/doc-type-store.ts';
import type { ControlKind, DocTypeRef, JsonValue } from '../model/types.ts';
import type { ControlDefinition, ControlFieldDef, ControlShape, ExprNode, ExpressionDefinition, TemplateDefinition, TemplatePack, TemplateSection } from '../template/types.ts';
import { CONTEXT_FIELDS, instantiateTemplate } from '../template/engine.ts';
import { describeExpression, EXPR_FUNCTIONS } from '../template/expression.ts';
import { planRecompute } from '../template/recompute.ts';
import {
  addControl,
  addExpression,
  addFragment,
  addTemplate,
  copyTemplateIntoPack,
  CUSTOM_TEMPLATE_PACK_ID,
  deptAllowsTemplate,
  findTemplate,
  listExpressionControls,
  listFragments,
  listTemplates,
  patchControl,
  patchExpression,
  patchFragment,
  patchTemplateMeta,
  removeControl,
  removeExpression,
  removeFragment,
  removeTemplate,
  templateCatalogOf,
  type ControlPatch,
  type SectionMetaPatch,
  type SlotMetaPatch,
} from '../template/template-pack.ts';
/* 生效配置指纹：与文件指纹同一口径（SHA-256），便于相互核对 */
import { sha256Hex } from '../import/import-types.ts';
import { utf8 } from '../crypto/sm3.ts';
/* 服务端文件配置：口令 / 盐 / 装机凭据 —— 打开数据库之前就必须知道的东西（见该模块文件头）  */
import {
  bootstrapOf,
  describeServerConfig,
  envNameOf,
  importsOf,
  loadServerConfig,
  serverConfigPath,
  stateKeyOf,
  stateSaltHexOf,
} from '../core/server-config.ts';
/* 系统策略（鉴权模式 / 会话寿命 / 限流 / 锚定节奏）：落库，不再由环境变量给  */
import {
  describeSystemConfig,
  loadSystemConfig,
  saveSystemConfig,
  type AuthMode,
  type LoadedSystemConfig,
  type RateConfig,
} from '../storage/system-config.ts';
/* 接收方公钥目录：落库（`recipient_keys` 表），不再是一个 JSON 文件  */
import { loadRecipientKeyStore as loadRecipientKeyTable, saveRecipientKeyStore as saveRecipientKeyTable } from '../storage/recipient-key-store.ts';
/* 受控阅读的授权登记：落库（`reading_grants` 表），不再是一个整体式密封文件  */
import {
  countReadingGrants,
  loadAllReadingGrants,
  syncReadingGrants,
  type ReadingGrantRecord,
} from '../storage/reading-grant-store.ts';
import { importReadingGrantsOnce } from '../storage/reading-grants-import.ts';
/* 内涵质控配置（规则清单 / 引擎 / 引擎凭据）：落库，不再由环境变量给  */
import {
  describeQcContentConfig,
  importQcRulesOnce,
  loadQcContentConfig,
  saveQcContentConfig,
  type LoadedQcContentConfig,
  type QcContentEngineKind,
} from '../qc/qc-content-store.ts';

/**
 * 运行时目录：先于一切文件读取解析出来（服务端配置文件就放在它下面）。
 *
 * 这里只做纯计算；迁移/归档的副作用仍留在下面原来那一段（它们必须在打开任何库与文件之前，
 * 且在顺序上更靠后）。拆成两处是为了让"目录在哪"与"目录怎么搬"各自只有一处答案。
  */
const RUNTIME = resolveRuntimeLayout(process.env);

const SERVER_CONFIG = loadServerConfig(serverConfigPath(RUNTIME.dir));
const STATE_KEY_INFO = stateKeyOf(SERVER_CONFIG);
/** 旁挂快照与库内密文的口令（只报来源，绝不回显值）  */
const STATE_PASSPHRASE = STATE_KEY_INFO.key;
const STATE_SALT_HEX = stateSaltHexOf(SERVER_CONFIG);
/** 环境标识（原先的 `L0_ENV`）：只是界面上的标注，不改变任何行为 */
const ENV_NAME = envNameOf(SERVER_CONFIG);
const IMPORTS = importsOf(SERVER_CONFIG);
function statePassphrase(): string {
  return STATE_PASSPHRASE;
}
import { buildMachineReadable, machineToExpectation, orderedNodeIds } from '../model/machine.ts';
/* 控件里的格怎么算（键 / 类型 / 名字）：界面渲染与写路径都从这一处取，
   两处各拼一遍的结果是"填进去的值在导出里不见" */
import { controlCellByKey, controlCellsOf } from '../model/control.ts';
import { checkConsistency, toSuggestionDrafts, type ConsistencyIssue } from '../model/consistency.ts';
import { TAG_SYSTEMS, type DataElementTag, type DocNode, type DocumentModel, type EvidenceRef, type NodeId, type TextRun } from '../model/types.ts';
/* 即时结构化（V4）：与落位并列的一层（内核之外），只产"数据元提议"，落笔在下面的 `/api/structure-apply` */
import { proposeStructurings } from '../ai/structuring.ts';
import {
  planDischargeSummary,
  dischargeSummaryApplicability,
  type DischargeSummaryPlan,
  type SummaryDoc,
} from '../summary/discharge-summary.ts';
import {
  parsePrevisitIntake,
  planPrevisitDrafts,
  PREVISIT_SECTION,
  type PrevisitRecord,
  type SectionAnchor,
} from '../previsit/previsit.ts';
/* 预问诊接入凭据：机对机密钥（只存哈希），管理端「预问诊接入」配置读写 */
import {
  PREVISIT_KEY_HEADER,
  checkAccess,
  describeAccess,
  loadAccess,
  saveAccess,
} from '../previsit/previsit-access.ts';
import { minimalEditSpan } from '../core/text-runs.ts';
import type { OfdExportPlan } from '../export/ofd.ts';
import { buildWorkspace, DEPARTMENTS, DOC_TYPES, type DemoWorkspace, type WorkspacePatient, type WorkspaceVisit } from './demo-doc.ts';
/* 跨次对比：只做编码级与原文级对照（不判断语义是否等价），纯函数、无 I/O */
import { compareVisits, type VisitCompare } from '../compare/visit-compare.ts';

interface VisitCompareState {
  patientId: string;
  patientName: string;
  candidates: Array<{
    docId: string;
    title: string;
    createdAt: string;
    status: string;
    visitType: string;
    visitDate: string;
    sameDiagnosis: boolean;
    sharedDiagnosis: string[];
    changedSections: number;
  }>;
  chosenDocId: string | null;
  compare: VisitCompare | null;
  medicationTarget: { nodeId: string; title: string } | null;
}
import { buildDraftFromAny, describeAnyImport, importAnyDocument, type AnyImported } from '../import/import-any.ts';
import {
  documentFingerprint,
  openForReading,
  verifyCredential,
  type ReadingContext,
  type ReadingCredential,
  type ReadingView,
} from '../core/controlled-reading.ts';
import { openSealedForReading } from '../core/encrypted-reading.ts';
import { buildAuditReport, renderAuditReportMarkdown } from '../core/audit-report.ts';
import { demoKeyPair } from '../crypto/provider.ts';
import { publicKeyFingerprint } from '../crypto/sm2.ts';
import type { Envelope } from '../crypto/envelope.ts';
import {
  EMPTY_KEY_STORE,
  addRecipientKey,
  removeRecipientKey,
  type RecipientKeyStore,
} from '../core/recipient-keys.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const UI_FILE = fileURLToPath(new URL('./ui.html', import.meta.url));
/* 结构 / 样式 / 脚本三件套：ui.html 通过 <link> 与 <script src> 引用后两者 */
const UI_CSS_FILE = fileURLToPath(new URL('./ui.css', import.meta.url));
const UI_JS_FILE = fileURLToPath(new URL('./ui.js', import.meta.url));
/* 命令面板（Ctrl+K）：纯界面件，与 ui.js 同样 no-store —— 它没有自己的业务规则，
   改的是"候选怎么排、按键怎么走"，而这类改动必须立刻看得见。 */
const COMMAND_PALETTE_JS_FILE = fileURLToPath(new URL('./command-palette.js', import.meta.url));
const CAPTURE_WEB_JS_FILE = fileURLToPath(new URL('./capture-web.js', import.meta.url));
/* 自定义弹框（确认 / 提示 / 一句话）：医生端与管理后台共用的一份经典脚本，
   两页都 `<script src="/dialog.js">`。它的存在就是为了不出现系统弹框，
   所以它自己也必须由本服务提供（不能走 CDN）。  */
const DIALOG_JS_FILE = fileURLToPath(new URL('./dialog.js', import.meta.url));
/* 管理后台：独立页面（页面/路由 + 登录）。配置是部署参数（模型地址决定病历内容发往哪台服务器），
   不该摆在医生端，理由与边界写在 admin.html 的文件头。 */
const ADMIN_FILE = fileURLToPath(new URL('./admin.html', import.meta.url));
const ADMIN_JS_FILE = fileURLToPath(new URL('./admin.js', import.meta.url));
/* 正文渲染（逐节点的那套 HTML）：医生端与管理后台的模板预览共用这一份经典脚本。
   两页都 `<script src="/doc-view.js">`，于是"预览与正文长得一样"由结构保证，
   而不是靠两处各自照着对方小心翼翼地改 —— 那种一致迟早会漂，且漂了没人报错。  */
const DOC_VIEW_JS_FILE = fileURLToPath(new URL('./doc-view.js', import.meta.url));
/* 自由流式视图（整页连续书写）：与 doc-view.js 并列的第二套正文画法。
   两者共用同一批视图项与同一条写路径，差别只在"怎么落笔"（见 flow-view.js 文件头）。  */
const FLOW_VIEW_JS_FILE = fileURLToPath(new URL('./flow-view.js', import.meta.url));
/* 宿主接入桥（被嵌进医生工作站时的那一层）：与 ui.js 同样 no-store。
   它是"嵌不进去"这一类问题的第一现场 —— 改一行协议却跑着旧脚本，
   表现是宿主那边永远等不到 init，而排查方向会跑到服务端去。 */
const HOST_BRIDGE_JS_FILE = fileURLToPath(new URL('./host-bridge.js', import.meta.url));
/* 管理后台的独立登录页：未登录访问 `/admin` 会被 302 到这里（见下方路由）。
   登录控件不再与配置体同页，`hidden` 只挡住"看得见"，字段名与占位符照样进响应体。 */
const LOGIN_FILE = fileURLToPath(new URL('./login.html', import.meta.url));
const LOGIN_JS_FILE = fileURLToPath(new URL('./login.js', import.meta.url));
/* 公众号二维码：放在仓库根（它是素材，不属于任何一层代码）。
   服务端只为它开一个具体路径，不做通用静态目录，通用目录会把整个仓库暴露出去，
   而这里只需要一张图。 */
const QR_FILE = join(ROOT, 'hongyi-ai-qr.jpg');

/* --------------------------- 部署前缀（挂在工作站某个路径下） ---------------------------
 *
 * 被医生工作站反向代理时，本实例不再占据域名的根：`https://ws/emr/` → 本机 8787。
 * 于是一切**根绝对路径**（页面里的 `/ui.css`、脚本里的 `/api/state`、302 的 `/admin`）
 * 都会打到工作站自己的根上 —— 症状是"页面能开、脚本与接口全 404"，而排查方向
 * 通常跑到"是不是没部署"，想不到前缀这一层。
 *
 * 处理只做两处，且都收口在这一段：
 *   ① 进站剥掉前缀 —— 下面几十条路由仍按"自己就是根"写（漏一条就是一个 404）；
 *   ② 出站补上前缀 —— 页面 HTML 与跳转地址，前端所需的那一份挂在 `<html data-l0-base>`。
 *
 * 不给前缀时（默认）行为与引入它之前逐字节一致。
 */
const BASE_PATH = normalizeBasePath(process.env.L0_BASE_PATH ?? '');

function normalizeBasePath(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (trimmed === '' || trimmed === '/') return '';
  const withSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  /* `//` 必须挡掉：拼出来的是协议相对 URL（`//evil.example` 会被浏览器当成站外域名），
     而它出现在跳转地址里就是一个现成的开放重定向。 */
  return withSlash.startsWith('//') ? '' : withSlash;
}

/**
 * 页面 HTML 的出站处理：资源地址补前缀 + 把前缀交给前端。
 *
 * `<base href>` 在这里不管用：它影响文档内的相对 URL，但 `fetch('/api/state')` 是
 * 绝对路径，不参与 base 解析。所以前缀只能显式传一份给脚本（`<html data-l0-base>`）。
 */
function withBase(html: string): string {
  const out = BASE_PATH === ''
    ? html
    : html.replace(/(href|src)="\//g, `$1="${BASE_PATH}/`);
  return out.replace('<html lang="zh-CN">', `<html lang="zh-CN" data-l0-base="${BASE_PATH}">`);
}

/** HTML 转义（本文件里只此一处往页面里拼服务端字符串，故不引公共工具） */
function escapeForHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch);
}

// - 已初始化：这是"你是谁"，要的是用户名 + 口令。
// 口令永不出现在页面上（无论它来自环境变量还是数据库）：内置演示口令已经取消，

function renderLoginPage(): string {
  const initialized = userStore.count() > 0;
  const note = initialized
    ? '<div class="login-note">忘记口令请用 <code>npm run user -- passwd &lt;用户名&gt;</code> 重设。</div>'
    : `<div class="login-note login-demo">这台机器<b>还没有任何账号</b>（首次运行）。<br>`
      + `创建第一个管理员后，本页就只剩登录表单；该账号存在数据库里，不再由环境变量注入。</div>`;
  const deployNote = DEPLOY_TOKEN
    ? '<label class="cfg-admin">装机凭据（服务端配置文件里的 <code>bootstrap.token</code>）'
      + '<input id="bootDeployToken" type="password" required placeholder="必填：本机已配置装机凭据，它用于证明是运维本人在初始化" autocomplete="off" /></label>'
    : '';
  /* 已初始化时把初始化表单整段裁掉（连同它的字段名与提示），
     它若留在响应体里，等于给每个访问者留一条"也许还能再初始化一次"的猜想。 */
  const trimBlock = (html: string, name: string): string =>
    html.replace(new RegExp(`<!--FORM:${name}-->[\\s\\S]*?<!--/FORM:${name}-->`), '');
  let html = readFileSync(LOGIN_FILE, 'utf8');
  html = trimBlock(html, initialized ? 'BOOTSTRAP' : 'LOGIN');
  html = html.replace('<!--BOOTSTRAP_DEPLOY-->', initialized ? '' : deployNote);
  html = html.replace('<!--ADMIN_TOKEN_NOTE-->', note);
  return html;
}

const BOOTSTRAP = bootstrapOf(SERVER_CONFIG);
const DEPLOY_TOKEN = BOOTSTRAP.token;
/** 播种用的用户名（与 `bootstrap.token` 成对出现才播种） */
const DEPLOY_USER = BOOTSTRAP.user;

/** 会话 cookie。名字是 `session` 而不是 `admin`：它现在承载任意角色的会话 */
const SESSION_COOKIE = 'l0_session';

/**
 * 鉴权失败：带 `code` 抛出，由路由（或顶层兜底）转成 `{ok:false, code, message}`。
 * 不在这里直接写响应，是因为它要在同步的写路径里也能被抛出来（`act()` 的 catch 会接住）。
 */
class AuthError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'AuthError';
  }
}

/**
 * 路由 → 所需动作（两种模式下都生效）。
 *
 * 集中成一张表：分散到各路由里写判断容易漏，而漏掉的方向是"放行"。
 * 表中未列出的路由不需要动作级授权（读视图、登录、医生端只读动作等）。
 * 新增写路由时必须在这里加一行，否则默认"谁都能调"。
 */
const ROUTE_ACTIONS: Record<string, Action> = {
  /* 部署参数：改错会整体不可用或泄数据 */
  '/api/model-config': 'config.write',
  '/api/placement-config': 'config.write',
  /* 采集配置在两种模式下都收口：`asr.endpoint` 是数据流向变更
     （音频将离开本系统），与落位 `external` 同类 —— 它比"改个显示偏好"重得多。  */
  '/api/capture-config': 'config.write',
  /* 预问诊接入：它决定"谁可以往病历里塞患者自述"，改错等于把写入端打开。
     两种模式都收口（演示模式下"从没配过"仍放行 —— 那条判断在 `checkAccess` 里，
     不在这张表上：这张表只管"改配置"这件事本身）。 */
  '/api/previsit-config': 'config.write',
  '/api/sign-backend-config': 'config.write',
  '/api/reading-authority': 'config.write',
  /* 系统策略：`authMode` 决定"医生端写病历要不要鉴权"，改错等于把门打开；
     内涵质控配置决定"病历内容发往哪台引擎"，与采集地址同类（数据流向）。两者都按部署参数收口。 */
  '/api/system-config': 'config.write',
  '/api/qc-content-config': 'config.write',
  '/api/recipient-keys/import': 'config.write',
  '/api/recipient-keys/remove': 'config.write',
  /* 外呼：会把配置发到外部地址、会花钱。这两条同类同权，
     此前"测试连接"不要求登录而"测试签名"要求，那条不一致在这里收口。 */
  '/api/model-config/test': 'model.test',
  '/api/sign-backend/test': 'sign.test',
  /* 知识资产：改的是判定标准，不动病历 */
  '/api/knowledge-pack-toggle': 'pack.toggle',
  '/api/rule-item-update': 'pack.toggle',
  '/api/rule-item-create': 'pack.toggle',
  '/api/rule-item-delete': 'pack.toggle',
  /* 具名条件（条件库）：与规则条目改的是同一份包内容，所以权限同级、写路径同一条。
     它们仍各占一条路径，而不是复用规则那三条：改一条条件会影响所有引用它的规则，
     审计里必须一眼分得出"这次动的是共用资产"还是"这次动的是某一条规则"。  */
  '/api/qc-condition-create': 'pack.toggle',
  '/api/qc-condition-update': 'pack.toggle',
  '/api/qc-condition-delete': 'pack.toggle',
  /* 重置工作区：唯一一个破坏性动作，两种模式都收口。
     此前它只在严格模式生效（列在 `DOCTOR_ROUTE_ACTIONS` 里），于是演示模式下
     "任何能访问本端口的人都能清空全部病历"，这是本仓库最实的一个洞。
     收口它不影响"打开就能用"：写病历仍然不需要登录，只有"擦掉一切"需要管理员身份。 */
  '/api/reset': 'workspace.reset',
  /* 包唯一的入口：载入（新增或覆盖）。它与"开关条目"是同一类判定标准的变更，
     所以同一权限（`pack.toggle`：质控员与管理员都能做）。 */
  '/api/knowledge-pack-load': 'pack.toggle',
  /* 科室字典：院内主数据（改的是"有哪些科"），按配置写权限判定 */
  '/api/departments': 'config.write',
  '/api/doc-types': 'config.write',
  '/api/template-item-update': 'pack.toggle',
  '/api/expression-item-create': 'pack.toggle',
  '/api/expression-item-update': 'pack.toggle',
  '/api/expression-item-delete': 'pack.toggle',
  '/api/control-item-create': 'pack.toggle',
  '/api/control-item-update': 'pack.toggle',
  '/api/control-item-delete': 'pack.toggle',
  '/api/template-item-create': 'pack.toggle',
  '/api/template-item-delete': 'pack.toggle',
  '/api/template-item-duplicate': 'pack.toggle',
  '/api/fragment-item-create': 'pack.toggle',
  '/api/fragment-item-update': 'pack.toggle',
  '/api/fragment-item-delete': 'pack.toggle',
  '/api/admin/users': 'user.write',
  '/api/admin/users/password': 'user.write',
  '/api/admin/users/role': 'user.write',
  '/api/admin/users/disabled': 'user.write',
  '/api/admin/users/remove': 'user.write',

};

/**
 * 文书状态的中文名（只用于提示语与审计）。
 * 判定永远是 `status === 'draft'`，不靠这张表 —— 表漏了一项只会让提示难看，
 * 不会让不该删的病历被删。医生端有同一份 `STATUS_LABEL`（ui.js），两处都只做展示。
  */
const DOC_STATUS_TEXT: Record<string, string> = {
  draft: '草稿',
  reviewing: '审核中',
  signed: '已签章',
  archived: '已归档',
  void: '作废',
};

const DOCTOR_ROUTE_ACTIONS: Record<string, Action> = {
  '/api/set-field': 'doc.write',
  /* 控件里的一格：与 `/api/set-field` 同级（都是往病历里填值，只是目标是一个控件节点） */
  '/api/set-control-field': 'doc.write',
  '/api/edit': 'doc.write',
  '/api/insert-paragraph': 'doc.write',
  /* 贴图两步都算写：上传会往本机磁盘落字节（不然就是任人往磁盘上写文件的入口），
     插入会改病历（与 `/api/insert-paragraph` 同级） */
  '/api/image-upload': 'doc.write',
  '/api/insert-image': 'doc.write',
  /* 空槽贴图 / 换图：改的是已有的那个图片节点  */
  '/api/set-image': 'doc.write',
  '/api/delete-image': 'doc.write',
  '/api/paste-text': 'doc.write',
  '/api/delete-node': 'doc.write',
  '/api/move-node': 'doc.write',
  '/api/undo': 'doc.write',
  '/api/refresh-machine': 'doc.write',
  '/api/reload-sidecars': 'doc.write',
  '/api/template-create': 'doc.write',
  /* 删除草稿：删的是病历本身（正文 + 留痕 + 旁挂），与"写病历"同级；
     但判据在路由里（只有 draft 能删），权限放行不等于什么都能删 */
  '/api/delete-document': 'doc.write',
  '/api/template-recompute': 'doc.write',
  '/api/confirm': 'doc.write',
  '/api/confirm-subtree': 'doc.write',
  '/api/confirm-anchor-lost': 'doc.write',
  /* 语音与 AI 产出（会花钱、会产生建议，但不落笔） */
  '/api/dictate': 'doc.write',
  '/api/dictate-commit': 'doc.write',
  /* 演示采集与"按停"同样只需要写病历的权限：它会产生建议，但不落笔 */
  '/api/dictation/capture/demo-run': 'doc.write',
  '/api/dictation/capture/demo-stop': 'doc.write',
  /* 采集转发：与 `/api/dictate` 同级（会产生识别文本，随后成为建议，但不落笔）。
     注意它与 `/api/capture-config` 不是一类：这条只是"用已经配好的服务转一次"，
     而改地址是数据流向变更（那条在两种模式下都要求管理员）。 */
  '/api/dictation/capture/segment': 'doc.write',
  /* 采集结束时记一笔元数据：它挂在这份病历上，和"写这份病历"同级 */
  '/api/dictation/capture/session': 'doc.write',
  /* 清空当前病历的采集记录：与"记一笔"同级。它只删自己这份病历的线索，
     不动管理审计（那条"开始一次采集"仍在链上），所以不需要管理员。 */
  '/api/dictation/capture/records/clear': 'doc.write',
  '/api/suggest': 'doc.write',
  '/api/suggest-batch': 'doc.write',
  '/api/suggest-low': 'doc.write',
  /* 即时结构化：propose 会把正文逐段读出来产出一份可落笔的提议（与 `/api/suggest` 同级），
     apply 是真正落笔那一步（绑数据元 + 把该段打回待确认）—— 两者都按"写病历"要求权限。  */
  '/api/structure-propose': 'doc.write',
  '/api/structure-apply': 'doc.write',
  '/api/import': 'doc.write',
  '/api/accept': 'suggestion.review',
  '/api/reject': 'suggestion.review',
  '/api/accept-group': 'suggestion.review',
  '/api/reject-group': 'suggestion.review',
  '/api/annotate': 'annotation.resolve',
  '/api/resolve-annotation': 'annotation.resolve',
  '/api/sign': 'doc.sign',
  '/api/unlock': 'doc.sign',
  '/api/export': 'doc.export',
  '/api/export-json': 'doc.export',
  '/api/export-wst500': 'doc.export',
  /* 质控与一致性：医生端的动作（它们产出的是旁挂提示，不是部署参数）。
     放在这条"仅 strict 模式生效"的表里，是因为演示模式下医生端没有会话，
     把它们放进两种模式都生效的表里，会让医生点「跑一次质控」直接被拒。
     （实测：实机点按钮才发现，而用例全绿，因为用例一直带着管理后台的 cookie 发请求。） */
  '/api/qc-form-check': 'qc.run',
  '/api/visit-timeline': 'qc.run',
  /* 跨次对比：读的是同一患者的其他文书（不跨患者）。
     这里没有单独的"读病历"能力：能写这一份，就能读同一患者的病史；
     跨患者仍走受控阅读授权（`reading.grant`），两条路不合并。
     沿用用药只生成建议、不落笔，因此与 `/api/suggest` 同级。  */
  '/api/visit-compare': 'doc.write',
  '/api/compare/carry-over': 'doc.write',
  '/api/qc-content-check': 'qc.run',
  '/api/check-consistency': 'consistency.run',
  '/api/apply-consistency': 'consistency.run',
  /* 受控阅读授权：放行的是"谁能读患者数据"，最敏感的一类 */
  '/api/reading/grant': 'reading.grant',
  '/api/reading/revoke': 'reading.grant',
  '/api/reading/import-credential': 'reading.grant',
};
const ARTIFACTS = join(ROOT, 'artifacts');
const PROBE = join(ROOT, 'tools', 'ofd-check', 'ofd-roundtrip-check.mjs');

/* `RUNTIME` 已在文件上方解析（服务端配置文件要用它），这里不再重复解析 —— 两处解析迟早会分叉 */
const RUNTIME_MIGRATION_PLAN = planRuntimeMigration(
  RUNTIME,
  legacyLayoutInRepo(ROOT),
  realMigrationProbe(),
  new Date().toISOString(),
);
const RUNTIME_MIGRATION = runRuntimeMigration(RUNTIME_MIGRATION_PLAN);
if (RUNTIME_MIGRATION.failed.length > 0) {
  console.error(
    `[运行时] 旧数据迁移失败（业务继续，旧位置仍可读）：${RUNTIME_MIGRATION.failed.map((item) => `${item.path}：${item.message}`).join('；')}`,
  );
}

const RUNTIME_ARCHIVE_PLAN = planLegacyArchive(RUNTIME, legacyLayoutInRepo(ROOT), realMigrationProbe(), new Date().toISOString());
const RUNTIME_ARCHIVE = runLegacyArchive(RUNTIME_ARCHIVE_PLAN);
if (RUNTIME_ARCHIVE.failed.length > 0) {
  console.error(
    `[运行时] 旧数据归档失败（原处保留，未丢）：${RUNTIME_ARCHIVE.failed.map((item) => `${item.path}：${item.message}`).join('；')}`,
  );
}

const AI: Actor = { id: 'ai-demo-pipeline', kind: 'ai' };
const SYSTEM: Actor = { id: 'rule-engine', kind: 'system' };
const MODEL_ID = 'rule:consistency-mapping-v1';
/**
 * 出院汇总的产出方标识。
 *
 * 它写的是 `rule:` 而不是模型名：内容是原文搬运，不是模型生成。
 * 混成模型名会让"这份小结是 AI 写的"变成一句假话，也会把修改率归因到错误的来源上。
  */
const DISCHARGE_SUMMARY_MODEL = 'rule:discharge-summary-v1';
/**
 * 预问诊的产出方标识。
 *
 * 同样是 `rule:` 而不是模型名：这里一个字都没生成，只是把患者写的原文
 * 登记下来再原样交出去。写成模型名会让"这段是 AI 写的"变成假话。
 */
const PREVISIT_MODEL = 'rule:previsit-intake-v1';
const WEAK_SIM_CONFIDENCE = 0.6;
const WEAK_SIM_MODEL_ID = 'weak-sim:demo-v1';
/**
 * 模型接入配置：存在库里（`config.ai-model` 与 `config.ai-model.apiKey`），由管理后台「能力配置」页写入
 * （`/api/model-config`）。本轮取消了 `L0_AI_*` 那一档环境变量：一处配置才有一处答案。
 *
 * 每次取用都重新读，不做缓存，管理员改完配置点"测试连接"就该立刻看到结果，
 * 而"改了要重启才生效"是运维最容易踩空的一类问题。重建适配器很便宜（它无状态），
 * 所以这里用重新读取代了缓存。
  */
function modelConfigNow(): LoadedModelConfig {
  return loadModelConfig(CONFIG_KV);
}

/**
 * 落位配置：与模型配置同一纪律，每次取用都重新读，不做缓存，
 * 管理员改完立即生效（"改了要重启才生效"是运维最容易踩空的坑）。
 */
function placementConfigNow(): LoadedPlacementConfig {
  return loadPlacementConfig(CONFIG_KV);
}

function captureConfigNow(): LoadedCaptureConfig {
  return loadCaptureConfig(CONFIG_KV);
}

function dictationCeilingNow(): number {
  return Math.min(placementConfigNow().config.confidenceCeiling, captureConfigNow().config.confidenceCeiling);
}

/**
 * 授权源配置：与模型/落位/签名配置同一纪律，每次取用都重新读，不做缓存。
 * 管理员改完立即生效（"改了要重启才生效"是运维最容易踩空的坑）。
 */
function readingAuthorityNow(): LoadedReadingAuthorityConfig {
  return loadReadingAuthority(CONFIG_KV);
}

/** 签名后端配置：同样每次取用都重新读，管理员改完立即生效（适配器无状态，重建很便宜） */
function signConfigNow(): LoadedSignConfig {
  return loadSignConfig(CONFIG_KV);
}

/**
 * 当前生效的签名后端（内核可用的 `Signer`）。
 *
 * 未配置就抛错（`E_SIGN_NOT_CONFIGURED`），本系统没有"内置软件签名"可回退：
 * 回退的现场表现是"界面显示签章成功，签的却是演示密钥"，那是这块最危险的一种假象。
 */
function signerNow(): Signer {
  const loaded = signConfigNow();
  return createRemoteSigner(loaded.config, loaded.apiKey === undefined ? {} : { apiKey: loaded.apiKey });
}

/** 每次签章前注入当前配置：管理员改完配置立即生效，不必重启进程 */
function applySignerNow(entry: DocEntry): void {
  entry.session.setSigner(signerNow());
}

/**
 * 导出前按需注入：已签章的文档在导出时要带容器签名，而容器签名必须与文档签章
 * 用同一个后端（两处各签各的会出现两套互不相认的签名）。未签章的文档不需要签名服务，
 * 导出照旧可用，把"导出"整体绑死在签名服务上，会让没配签名服务的环境连导出都做不了。
 */
function applySignerIfSigned(entry: DocEntry): void {
  if ((entry.session.document.signatureRefs ?? []).length > 0) applySignerNow(entry);
}

function adapterNow(): AiAdapter {
  const loaded = modelConfigNow();
  if (loaded.config.format === 'offline') return createOfflineAdapter(loaded.config);
  return createHttpAdapter(loaded.config, loaded.apiKey ? { apiKey: loaded.apiKey } : {});
}

/** 读请求头（同名多值时取第一个；外部系统发的凭据不会重复） */
function headerOf(req: IncomingMessage, name: string): string {
  const headers = (req as unknown as { headers?: Record<string, string | string[] | undefined> }).headers ?? {};
  const raw = headers[name.toLowerCase()];
  if (Array.isArray(raw)) return String(raw[0] ?? '').trim();
  return String(raw ?? '').trim();
}

/** 读 cookie。本仓库对 node:http 的类型声明是精简版，按用到的形状局部断言 */
function cookieOf(req: IncomingMessage, name: string): string {
  const raw = (req as unknown as { headers?: Record<string, string | undefined> }).headers?.cookie ?? '';
  for (const part of raw.split(';')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return '';
}

/**
 * 请求来源（用于限流的"按来源"那个桶）。
 *
 * 本环境 `node:http` 的类型声明里没有 `socket`，按用到的形状局部断言。
 * 只用 `remoteAddress`，不采信 `X-Forwarded-For`，那个头是调用方自己写的，
 * 采信它等于让攻击者自选桶（每个请求换一个来源，限流就形同虚设）。
 */
function requestSourceOf(req: IncomingMessage): string {
  const socket = (req as unknown as { socket?: { remoteAddress?: string } }).socket;
  return socket?.remoteAddress ?? 'unknown';
}

/**
 * "谁在调这个动作"的展示标签（进日志与审计）。
 * 有会话就报会话里的身份与角色；没有就写"（未登录调用）"，
 * 而不是把这件事掩盖成某个默认身份。
 */
function actorLabelOf(req: IncomingMessage): string {
  const resolved = resolvePrincipal(req);
  return resolved.ok ? `${resolved.principal.actorId}（${ROLE_LABELS[resolved.principal.role]}）` : '（未登录调用）';
}

type PrincipalResult =
  | { ok: true; principal: Principal; source: 'session' }
  | { ok: false; code: typeof AUTH_ERRORS.E_AUTH_REQUIRED | typeof AUTH_ERRORS.E_SESSION_EXPIRED };

/**
 * 从请求解析身份：只有会话一条来源。
 *
 * 不从请求头、不从请求体、不从 URL，这是本模块唯一需要守住的规矩。
 * "删除/请求参数决定身份或租户"是这类系统最常见的漏洞形态，而防它的成本在这里恰好是零：
 * 不写那几行就行。
 *
 * 解不开时不抛错（调用方决定是拒绝、还是走演示路径），并区分"没登录"与"已过期"。
 */
function resolvePrincipal(req: IncomingMessage): PrincipalResult {
  const resolved = sessions.resolve(cookieOf(req, SESSION_COOKIE));
  if (resolved.ok) {
    const { actorId, kind, role, tenant } = resolved.record;
    return { ok: true, principal: { actorId, kind, role, tenant }, source: 'session' };
  }
  return { ok: false, code: resolved.code };
}

/** 当前会话的展示信息（管理后台/医生端显示"我是谁、什么角色、还有多久要重登"） */
function sessionInfoOf(req: IncomingMessage): {
  authenticated: boolean;
  actorId: string | null;
  role: Role | null;
  tenant: string | null;
  expiresAt: string | null;
} {
  const resolved = sessions.resolve(cookieOf(req, SESSION_COOKIE));
  if (!resolved.ok) {
    return { authenticated: false, actorId: null, role: null, tenant: null, expiresAt: null };
  }
  return {
    authenticated: true,
    actorId: resolved.record.actorId,
    role: resolved.record.role,
    tenant: resolved.record.tenant,
    expiresAt: new Date(resolved.record.expiresAt).toISOString(),
  };
}

/** 会话失败时的提示：能照着做，且把"过期"与"没登录"分开 */
function authMessage(code: string, action: Action): string {
  return `要${ACTION_LABELS[action]}需要先登录（允许的角色：${rolesFor(action).map((role) => ROLE_LABELS[role]).join(' / ')}）；` +
    `管理后台入口 /admin${code === AUTH_ERRORS.E_SESSION_EXPIRED ? `；上一会话已过期（寿命 ${SESSION_TTL_MINUTES} 分钟），请重新登录` : ''}`;
}

function guard(req: IncomingMessage, action: Action): Principal {
  const resolved = resolvePrincipal(req);
  if (!resolved.ok) throw new AuthError(resolved.code, authMessage(resolved.code, action));
  const decision = authorize(resolved.principal, action);
  if (!decision.ok) throw new AuthError(decision.code, decision.message);
  return resolved.principal;
}

function requireAdminSession(
  req: IncomingMessage,
  entry: DocEntry,
  subject = '模型接入配置',
  action?: string,
  permission: Action = 'config.write',
): string {
  const principal = guard(req, permission);
  /* 日志带上 subject：谁改了什么要能一眼分辨（模型配置 vs 落位配置），
     否则事后追溯只会看到一串分不清对象的"配置变更"。
     `action` 用于不是变更的管理动作（如"测试签名"，它是外呼，没改任何配置）。 */
  entry.log.push({
    at: new Date().toISOString(),
    action: `${action ?? `${subject}变更`}（操作者 ${principal.actorId} · ${ROLE_LABELS[principal.role]}）`,
    ok: true,
  });
  return principal.actorId;
}

/**
 * 一次管理动作的审计记录。
 *
 * 与病历留痕分开存：管理动作与"当前打开的是哪份病历"无关，
 * 配置变更若只写进病历留痕，换一份病历就看不见了，因此管理动作有独立的系统级账本。
 * 它不随"重置工作区"清空。
 *
 * 记录内容：字段与前后取值（`changes`）。
 * 不记录密钥值：可审计字段是白名单（`AUDIT_FIELDS`），新加字段默认不进审计。
 *
 * 已知边界（页面上同样注明）：进程重启即丢；能改库的人就能改历史。两者都属 T23 范围。
 */
interface AdminAuditChange {
  field: string;
  before: string;
  after: string;
}

interface AdminAuditEntry {
  seq: number;
  at: string;
  actor: string;
  subject: string;
  /** 变更 = 改了配置；动作 = 没改配置的管理操作（测试签名、登录/退出） */
  kind: '变更' | '动作';
  changes: AdminAuditChange[];
  note?: string;
}

const AUDIT_FILE = RUNTIME.auditFile;
/** 单次下发多少条（只是展示窗口，库里是全量） */
const ADMIN_AUDIT_WINDOW = 500;
/** 写失败必须能看见：审计没写上，不能变成"没人知道" */
let AUDIT_WRITE_ERROR: string | null = null;

const ANCHOR_FILE = RUNTIME.anchorFile;
/* 锚点签名者与锚定节奏的定义在打开数据库之后（"系统策略"那一段）：
   种子与 `anchorEvery` 都从库里的 `config.system` 读 —— 种子是机密，它单独占一行且永不回显。  */
/**
 * 锚定/读锚失败也要看得见（同 `AUDIT_WRITE_ERROR`）：以为锚上了其实没锚，删尾就重新变得不可检出。
 *
 * 初值留空、等读到锚点之后再填（读锚要库句柄，而库在后面才开 —— 见"管理审计与链头锚点"那一段）。
 */
let ANCHOR_WRITE_ERROR: string | null = null;

/**
 * 可审计字段白名单：字段名与各 `describeXxxConfig()` 的输出逐字对应。
 *
 * 写错名字的后果是静默的（审计里永远显示"无变化"），所以有用例守着
 * "改一个字段，审计里就必须出现这条变化"，静默失效是本项目最忌讳的失败形态。
 */
const AUDIT_FIELDS: Record<string, string[]> = {
  '模型接入配置': ['format', 'modelId', 'endpoint', 'timeoutMs', 'maxItems', 'apiKeyPresent'],
  '落位配置': [
    'strategy',
    'confidenceCeiling',
    'candidate.withinSections',
    'external.endpoint',
    'external.timeoutMs',
    /* 密钥只记"有没有"，不记值 —— 指纹与审计都不该跟着密钥变（有用例守着）  */
    'apiKeyPresent',
    'sectionMap',
    'termMap',
  ],
  '签名后端配置': [
    'configured',
    'missing',
    'expectedFingerprint',
    'publicKeyPresent',
    'publicKeyFingerprint',
    /* 认证密钥只记"有没有"（不记值）：改了值不该让指纹与审计跟着变，但那一步动作要看得见  */
    'apiKeyPresent',
    'http.endpoint',
    'http.timeoutMs',
    'http.keyId',
    'http.request.toSignField',
    'http.request.toSignEncoding',
    'http.response.signaturePath',
    'http.response.signatureEncoding',
  ],
  '授权平台配置': ['configured', 'endpoint', 'trustedIssuerFingerprint', 'trustedIssuerPublicKeyPresent'],
  /* 包条目（规则条目与模板条目共用）：审计要回答的是"哪一条、原来开着还是关着、谁动过"，
     只记"改过质控配置"等于没记（下次没人说得清上一次关的是哪一条）。
     名字随"规则条目/模板条目走同一个开关接口"改成「包条目」——
     写错这个键的后果是静默的（审计里永远显示"无变化"），所以改名字必须同时改这里。 */
  '包条目': ['packId', 'itemId', 'enabled'],
  /* 载入/覆盖内容包：前后指纹必须成对出现 —— 判定标准换了却只留一句"载入过"，
     事后没法回答"上一版跑到哪一版为止"。 */
  '内容包': ['包指纹'],
  /* 后台账号：发钥匙这件事必须留得下"从什么变成什么"，
     "把谁的角色改了"与"把谁停用了"正是权限事件里最该被事后核对的两条。
     注意口令不在白名单里，也永远不进 `before`/`after`：白名单漏一个字段的后果是
     "审计里永远显示无变化"（静默失效），而把口令加进来则是另一类事故。 */
  '后台账号': ['账号', '角色', '状态'],
  /* 两份院内主数据（科室字典 / 文书类型）：审计要回答的是"清单从什么变成什么"。
     只记"谁改过"答不出"产科是什么时候没的""出院记录是什么时候没的"，
     而模板的适用科室、质控规则定位文书的依据正挂在它们身上。
      这两条的 subject 与保存接口里 `recordAdminAudit` 传的逐字相同，
     写错一个字的后果是静默的（审计里永远显示"无变化"，且不会有任何地方报错）。  */
  '科室字典': ['items'],
  '文书类型': ['items'],
};

interface AuditValue {
  /** 比较用：完整值（不截断）。截断过的值拿去比较，会把"只差尾部"的两份规则表误判成没变 */
  key: string;
  /** 展示用：超长则截断，并给出总长度 */
  show: string;
}

const AUDIT_SHOW_LIMIT = 160;

function auditValueOf(value: unknown): AuditValue {
  if (value === undefined || value === null) return { key: '', show: '（无）' };
  if (typeof value === 'boolean') return { key: value ? '1' : '0', show: value ? '是' : '否' };
  if (typeof value === 'number') return { key: String(value), show: String(value) };
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return {
    key: text,
    show: text.length > AUDIT_SHOW_LIMIT ? `${text.slice(0, AUDIT_SHOW_LIMIT)}…（共 ${text.length} 字符）` : text,
  };
}

/** 按 `a.b` 点路径取值（配置视图是嵌套对象，扁平成一行才看得懂"改的是哪一格"） */
function pickAuditPath(view: Record<string, unknown>, path: string): AuditValue {
  let node: unknown = view;
  for (const part of path.split('.')) {
    if (node === null || typeof node !== 'object') return auditValueOf(undefined);
    node = (node as Record<string, unknown>)[part];
  }
  return auditValueOf(node);
}

function auditSnapshot(subject: string, view: Record<string, unknown>): Map<string, AuditValue> {
  const out = new Map<string, AuditValue>();
  for (const field of AUDIT_FIELDS[subject] ?? []) out.set(field, pickAuditPath(view, field));
  return out;
}

/** 记一条审计。只走这一个入口，免得有的地方记了、有的地方忘了 */
function recordAdminAudit(input: {
  actor: string;
  subject: string;
  kind: '变更' | '动作';
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  note?: string;
}): void {
  const changes: AdminAuditChange[] = [];
  if (input.before && input.after) {
    const before = auditSnapshot(input.subject, input.before);
    const after = auditSnapshot(input.subject, input.after);
    for (const [field, value] of after) {
      const old = before.get(field);
      if (!old || old.key !== value.key) changes.push({ field, before: old ? old.show : '（无）', after: value.show });
    }
  }
  /* 写失败必须看得见：审计没写上不能变成"没人知道"。但也不回滚已经完成的配置变更，
     两件事的处置不同：那次变更已经生效（事实），这次审计缺失（需要处置）。 */
  try {
    adminAudit.append({
      at: new Date().toISOString(),
      actor: input.actor,
      subject: input.subject,
      kind: input.kind,
      changes,
      ...(input.note ? { note: input.note } : {}),
    });
    AUDIT_WRITE_ERROR = null;
  } catch (err) {
    AUDIT_WRITE_ERROR = `审计写入失败（${AUDIT_FILE}）：${(err as Error).message}`;
    console.error(`[管理审计] ${AUDIT_WRITE_ERROR}`);
  }
  anchorIfDue();
}

/**
 * 按节奏给链头打锚。锚定失败不阻断业务（与审计写失败同一处置）：记下来、继续跑。
 * 但绝不静默，"以为锚上了其实没锚"会让删尾重新变成不可检出。
 */
function anchorIfDue(): void {
  const entries = adminAudit.entries();
  if (entries.length === 0 || entries.length % ANCHOR_EVERY !== 0) return;
  const head = entries[entries.length - 1];
  if (!head) return;
  try {
    auditAnchors.append(signAnchor({ seq: head.seq, hash: head.hash }, new Date().toISOString(), anchorSigner));
    ANCHOR_WRITE_ERROR = null;
  } catch (err) {
    ANCHOR_WRITE_ERROR = `锚定失败（${ANCHOR_FILE}）：${(err as Error).message}`;
    console.error(`[管理审计] ${ANCHOR_WRITE_ERROR}`);
  }
}

/**
 * 生效配置指纹：对同一套白名单字段取值后取哈希。
 *
 * 它不是"校验和"（不用于验证完整性），而是用来回答一句具体的话：
 * "这台机器现在跑的，是评审时那一份配置吗"，把指纹贴给对方比对即可，
 * 而密钥值不进白名单，所以换密钥不会改变指纹、配没配密钥会。
 */
function configFingerprint(subject: string, view: Record<string, unknown>): string {
  const snapshot = auditSnapshot(subject, view);
  const canonical = [...snapshot.entries()].map(([field, value]) => `${field}=${value.key}`).join('\n');
  return sha256Hex(utf8(canonical)).slice(0, 16);
}

interface ProbeResult {
  at: string;
  ok: boolean;
  latencyMs?: number;
  detail: string;
}

/**
 * 外呼类探测的留档：这两件事（模型能不能连、签名服务能不能签）是本系统里
 * 唯二"服务一挂就整体不可用"的依赖，而它们的现状是"只有医生点下去才知道"。
 *
 * 只留最近一次 + 成功/失败计数：计数能看出"偶尔失败"这种最该被发现的形态，
 * 而保留全部历史没有意义，探测是人类手动触发的，不是监控采样。
 */
const HEALTH = {
  startedAt: new Date().toISOString(),
  sign: { ok: 0, fail: 0, last: null as ProbeResult | null },
  model: { ok: 0, fail: 0, last: null as ProbeResult | null },
};

/**
 * 测试签名结果压成一行。界面与审计共用同一份措辞，两处各写一遍，
 * 迟早会出现"界面说成功、审计说失败"这种没法查的分歧。
 */
function describeSignTest(report: Awaited<ReturnType<typeof testSign>>): string {
  const verify = report.selfVerified === true
    ? '自验通过'
    : (report.selfVerified === false ? '自验未通过' : '无法自验（缺公钥）');
  const match = report.fingerprintMatches === true
    ? '指纹一致'
    : (report.fingerprintMatches === false ? '指纹不一致' : '指纹尚未固定');
  const extra = [
    report.certificateCount > 0 ? `证书 ${report.certificateCount} 张` : '',
    ...(Array.isArray(report.notes) ? report.notes : []),
  ].filter((item) => item !== '');
  return `签名成功（${report.latencyMs}ms / ${report.signatureBytes} 字节）· ${verify} · ${match}`
    + (extra.length > 0 ? ` · ${extra.join('；')}` : '');
}

function buildHealthView(): Record<string, unknown> {
  const sign = describeSignConfig(signConfigNow());
  const model = describeModelConfig(modelConfigNow());
  return {
    ok: true,
    startedAt: HEALTH.startedAt,
    sign: { ...HEALTH.sign, configured: sign.configured === true, missing: sign.missing ?? [] },
    model: { ...HEALTH.model, format: model.format ?? 'offline', modelId: model.modelId ?? null, endpoint: model.endpoint ?? null },
    /* 数量与容量：一眼能看出"这台机器上现在有多少东西" */
    counts: {
      documents: state.entries.size,
      recipientKeys: (state.recipientKeys.keys ?? []).length,
      /* 只数活跃会话（过期的不计入）：运维据此看"现在有几个人在用" */
      activeSessions: sessions.size,
      auditEntries: adminAudit.total(),
      /* 账号数（含已停用）：它与"可用管理员"是两个数，只有前者看不出"门里还有没有人" */
      adminAccounts: accountStatus().total,
    },
  };
}

/** package.json 的版本：读一次并缓存（进程内它不会变） */
let packageVersion: string | null = null;
function versionNow(): string {
  if (packageVersion === null) {
    try {
      const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8') as unknown as string) as { version?: string };
      packageVersion = pkg.version ?? '（未标注）';
    } catch {
      packageVersion = '（读不到 package.json）';
    }
  }
  return packageVersion;
}

/**
 * 系统信息：回答"这台机器上跑的是什么"。
 *
 * 现场排查最费时间的往往不是"哪坏了"，而是"你那边到底是哪一版、哪份配置"，
 * 这几项（版本 / 数据目录 / 环境标识 / 生效配置指纹 / 口令来源）就是用来把这句话问清楚的。
 */
function buildSystemView(): Record<string, unknown> {
  const model = describeModelConfig(modelConfigNow());
  const placement = describePlacementConfig(placementConfigNow());
  const capture = describeCaptureConfig(captureConfigNow());
  const sign = describeSignConfig(signConfigNow());
  const authority = describeReadingAuthority(readingAuthorityNow());
  return {
    ok: true,
    version: versionNow(),
    node: process.version,
    /* 本环境的 node:process 类型声明不完整（缺 pid），局部断言（同 core/persistence.ts 对 fs 的处置） */
    pid: (process as unknown as { pid?: number }).pid ?? null,
    startedAt: HEALTH.startedAt,
    uptimeMs: Date.now() - Date.parse(HEALTH.startedAt),
    /* 环境标识：没有它，"我改的是哪套环境"只能靠记忆（本项目此前没有这个概念） */
    env: ENV_NAME,
    stateDir: STATE_DIR,
    artifactsDir: ARTIFACTS,
    /* 工作数据落在哪个库、里面有多少条，让"数据在哪"是一句可以直接回答的话 */
    database: {
      file: DB_FILE,
      schemaVersion: STORAGE_SCHEMA_VERSION,
      appliedMigrations: STORAGE.applied,
      ...workStore.stats(),
    },
    /* 账号来源：它回答"口令到底存在哪、有几个账号"（原先那一栏叫「管理口令来源」，
       答的是"环境变量注没注"，口令搬进数据库之后，那个问题已经不再是问题）。 */
    accounts: accountStatus(),
    configFingerprints: {
      '模型接入配置': configFingerprint('模型接入配置', model),
      '落位配置': configFingerprint('落位配置', placement),
      /* 采集配置进指纹：它决定音频发往哪台服务器，而"两边配得一样不一样"正是要比的东西 */
      '采集配置': configFingerprint('采集配置', capture),
      '签名后端配置': configFingerprint('签名后端配置', sign),
      '授权平台配置': configFingerprint('授权平台配置', authority),
    },
  };
}

function buildAdminAuditView(): Record<string, unknown> {
  return {
    ok: true,
    /* 新的在前：审计是拿来"看最近发生了什么"的（窗口内） */
    entries: adminAudit.recent(ADMIN_AUDIT_WINDOW),
    counts: {
      total: adminAudit.total(),
      /* "dropped" 的含义变了：不再是被丢弃的历史，而是"这次没下发的、更早的记录条数" */
      dropped: Math.max(0, AUDIT_LOAD.totalInStore - adminAudit.total()),
      limit: ADMIN_AUDIT_WINDOW,
    },
    /* 链校验结果：改过历史就指认断在第几条，绝不"跳过继续读" */
    chain: {
      /* 库为唯一来源。`legacyFile` 是旧文件还在哪（搬家之后它不再被读，只作凭据）——
         分开报，是因为"账记在哪"与"旧文件在哪"是两个问题，混成一个字段就答不准任一。  */
      table: adminAudit.table,
      legacyFile: AUDIT_FILE,
      intact: AUDIT_LOAD.problem === null,
      problem: AUDIT_LOAD.problem,
      discarded: AUDIT_LOAD.discarded,
    },
    /* 链头锚定：链内校验结构上查不出的两类（删尾 / 整链重写）靠它查。
       把结论、锚点文件、以及"锚点之后还有几条没被锚定"一并给出，
       后者是关键：锚点之后的尾部被删，用这个锚点仍然查不出来。 */
    anchor: {
      table: auditAnchors.table,
      legacyFile: ANCHOR_FILE,
      count: auditAnchors.count(),
      ...(ANCHOR_WRITE_ERROR ? { error: ANCHOR_WRITE_ERROR } : {}),
      ...verifyAnchor(adminAudit.entries(), auditAnchors.latest(), {
        verify: (text: string, signature: Uint8Array) => anchorVerifier.verify(utf8(text), signature),
      }),
    },
    ...(AUDIT_WRITE_ERROR ? { writeError: AUDIT_WRITE_ERROR } : {}),
    boundary: [
      '已入库（表 admin_audit）：进程重启不再清空历史；备份一次数据库就带走"谁改了什么"',
      '链式摘要：改动任何一条历史都会让之后的对不上，可指认断在第几条',
      '校验不过时只展示断点之前，但断点之后的行留在库里（审计系统不销毁证据）',
      '链头锚定：删掉尾部若干条、或把整条链重写时，链内自洽但锚点对不上，这两类可由此检出',
      '锚点与链在同一个库里：同机另一处挡不住同一个有权限的人；真正要靠的是把锚点带出这台机器',
      '锚点之后尚未锚定的几条被删，仍然检不出来；锚定需周期性进行，且最好由审计查看方保存锚点',
      '锚点签名使用公开演示种子时，拿到代码的人也能重签锚点（见 test:audit-anchor 的 A8）',
      '只记白名单里的配置字段，密钥值一律不入审计',
      '不随「重置工作区」清空：能顺手清掉的审计等于没有审计',
    ],
  };
}

/** 连接测试用的最小脱敏上下文：测试连接不该把真实病历发出去 */
function probeContext(): AiContextPackage {
  const at = new Date().toISOString();
  return {
    docId: 'config-probe',
    docType: { system: 'WST500', code: 'A01', display: '连接测试' },
    items: [{ nodeId: 'probe_1', type: 'text', text: '这是一次连接测试，请忽略。', origin: 'human', role: 'target' }],
    policy: { includePatient: false, includeDataElements: false, maskStrategy: 'mask-person-name' },
    stats: { items: 1, chars: 14, tokenBudget: 2000, droppedByBudget: 0 },
    audit: {
      actorId: 'admin',
      actorKind: 'human',
      at,
      requestedNodeIds: ['probe_1'],
      tokenBudget: 2000,
      droppedByBudget: 0,
      missingNodeIds: [],
      droppedTargets: [],
    },
  };
}
const PLAN: OfdExportPlan = { layout: { textAsPath: false }, machineReadable: { signed: true, carrier: 'separate-xml' } };
const THRESHOLDS = { general: 0.75, key: 0.9 };

interface LogEntry {
  at: string;
  action: string;
  ok: boolean;
  code?: string;
  message?: string;
}

interface ProbeCheck {
  id: string;
  name: string;
  pass: boolean;
  critical: boolean;
  detail: string;
  hint?: string;
}

interface ProbeReport {
  verdict: string;
  stats: { textChars: number; textCodeCount: number; pathObjectCount: number; pageCount: number };
  machineReadable: { customPrefixes: Array<{ prefix: string; count: number }>; keywordHits: Array<{ keyword: string }> };
  signatures: { files: string[]; signedRefs: string[] };
  roundTrip: { total: number; found: number; completeness: number; missing: unknown[] } | null;
  checks: ProbeCheck[];
}

interface ExportRecord {
  file: string;
  pages: number;
  stats: { textObjects: number; textChars: number; dataElements: number; bytes: number };
  probe: ProbeReport | null;
  probeExit: number;
  exportedAt: string;
  /**
   * 导出过程中"归档件比病历少了一块"的问题（图片取不到 / 格式认不出）。
   * 界面上必须能看见：这类问题的现场表现是"导出成功了"，而缺的那块要等审计才发现。
   */
  warnings: string[];
}

/** 每份病历一个独立会话：留痕、建议、日志、导出记录互不干扰 */
/** 共享文档（WS/T 500）导出记录：与 OFD 导出分开记，两者用途不同（归档 vs 交换） */
interface Wst500Record {
  file: string;
  bytes: number;
  sections: number;
  fields: number;
  paragraphs: number;
  exportedAt: string;
}

/**
 * 受控阅读记录：阅读次数在服务端集中记账（这是本模块唯一正确的记账点）。
 * 若把次数交给客户端自己数，换个不记账的调用方就绕过了，那样"次数控制"只是装饰。
 */
interface ReadingRecord {
  credential: ReadingCredential;
  readCount: number;
  revoked: boolean;
  reads: Array<{ at: string; environmentId: string; actorId: string; allowed: boolean; code?: string; reason?: string }>;
  /**
   * 加密交付：该授权对应的密文信封 + 接收方种子。
   *  种子派生私钥仅用于演示（生产由密码设备生成并保管私钥，服务端不该持有它）。
    */
  sealed?: { envelope: Envelope; recipientSeed: string; recipientLabel: string };
}

interface JsonRecord {
  file: string;
  bytes: number;
  nodes: number;
  exportedAt: string;
}

interface CaptureRunRecord {
  sessionId: string;
  phase: CapturePhase;
  /** 从开始采集算起的累计时长（秒）—— 录音态的计时（S1：暂停恢复不重置） */
  elapsedSec: number;
  /** 当前那一段已录时长（秒）；没有正在录的段时为 0 */
  currentChunkSec: number;
  finalized: number;
  transcribed: number;
  failures: CaptureFailure[];
  sourceId: string;
  startedAt: string;
  finishedAt: string | null;
  /** 采完之后的完整结果（含提交结果）；还在跑时为 `null` */
  outcome: CaptureOutcome | null;
  /** 失败时的"怎么办"（第六节纪律：只给错误码等于让人去搜） */
  howTo?: string;
  error?: { code: string; message: string };
}

/**
 * 最近一次语音转写（演示用：留转写段与规范化提示，供界面复显）。
 *
 * 名字不能叫 `DictationRecord`：文件后面另有一个同名的"采集过程记录"
 * （一次采集的时长 / 段数 / 结果，要落盘留存）。两个同名 `interface` 会被 TS 声明合并
 * 成一个"两份字段都要有"的类型 —— 于是两处构造都编译不过，而运行时其实一直是分开的。
  */
interface DictationResult {
  transcriptionId: string;
  /**
   * 文本从哪来：`capture` = 采集端提交的真实转写；`demo` = 服务端内置的模拟转写。
   *
   * 必须如实带出去：两者在界面上长得一模一样（都是"一段文本 + 时间区间"），
   * 而"这是真识别出来的"与"这是我们写死在仓库里的一段话"信任程度完全不同
   * （与建议卡上标"产出方"同一条理由）。
    */
  source: 'capture' | 'demo';
  /** 医生指定落点后重新提交时，要用它重建 `dictate` 参数（内核要求 asrModelId 必填） */
  asrModelId: string;
  refineModelId?: string;
  /** 有段落未落位时不提交，此时为 null（内核不接受"半落位"） */
  groupId: string | null;
  warnings: string[];
  segments: Array<{ index: number; text: string; startSec?: number; endSec?: number; confidence: number }>;
  /** 每段的落位结果（策略给出的初始落点 / 未落位），供界面区分"系统猜的"与"人工指定的" */
  placements: Array<{ index: number; text: string; nodeId: string | null; reason: string }>;
  /** 本次未落位的段数（> 0 即未提交建议） */
  unplaced: number;
  /** 是否已生成建议 */
  submitted: boolean;
}

interface DocEntry {
  docId: string;
  session: WriteSession;
  log: LogEntry[];
  lastExport: ExportRecord | null;
  lastWst500: Wst500Record | null;
  /** 最近一次导出的文档 JSON（独立探针的输入） */
  lastJson: JsonRecord | null;
  /** 最近一次语音转写（把转写段与规范化提示留在服务端，供界面复显） */
  lastDictation: DictationResult | null;
  /**
   * 最近一次采集的过程（演示采集用：录音指示、计时、逐段进度）。
   *
   * 与 `lastDictation` 分开：那个是"结果"（转写段 + 一组建议），这个是"过程"
   * （正在录第几段、已经完成几段）。界面要能显示「转写中 3 段 / 已完成 1 段」，
   * 而这个过程在服务端驱动采集时只存在服务端 —— 于是它必须随 state 下发。
    */
  lastCapture: CaptureRunRecord | null;
  /** 最近一次跨文书一致性检查结果（避免重跑：纯函数虽便宜，但问题列表要能被"生成待办"引用） */
  lastConsistency: { issues: ConsistencyIssue[]; scanned: number } | null;
  lastVisitTimeline: VisitTimeline | null;
  /** 最近一次跨次对比（属于这份文档） */
  lastVisitCompare: VisitCompareState | null;
  lastDischargeSummary: DischargeSummaryPlan | null;
  /** 最近一次受控阅读视图（属于这份文档） */
  lastReadingView: ReadingView | null;
  /** 视图来源：明文阅读 还是 解封后的加密阅读（界面要能一眼看出） */
  lastReadingSource: 'plaintext' | 'unsealed' | null;
  /** 最近一次审计报告（只存摘要：完整报告在卡片里给，state 不必背着它） */
  lastAudit: AuditSummary | null;
  lastQcUnevaluated: QcUnevaluated[];
  /**
   * 最近一次内涵类质控的结果摘要（`null` = 还没跑过）。
   *
   * 与 `lastQcUnevaluated`（形式类）分开存：两者"没判"的原因完全不同，
   * 混在一起时界面只能说一句含糊的"有未判定项"。
   */
  lastContentQc: {
    configured: boolean;
    reason: string | null;
    rules: number;
    judged: string[];
    findings: number;
    created: number;
    unevaluated: Array<{ ruleId: string; reason: string }>;
    silentRules: string[];
    rejected: Array<{ index: number; code: string; message: string }>;
  } | null;
  /**
   * 最近一次 AI 调用没产出的目标节点与原因（`null` = 还没调过）。
   *
   * 与上面两个"没判"并列，是同一件事在 AI 侧的第三次修：
   * 质控说"没判"会被读成"没问题"，AI 说"没提示"会被读成"查过了没问题" ——
   * 医生对 AI 的信任崩塌，多半不是因为写错，而是因为它不知道它没写。
    */
  lastAiSilence: AiSilenceReport | null;
  /**
   * 已落库的文书 rev。`persist` 据此判断"正文有没有变"，
   * 旁挂操作（处置提示、采纳建议）不改 rev，没有它就每次都要重存一遍正文。
   */
  storedRev: number;
  /** 旁挂数据是否已尝试从磁盘恢复过（懒加载一次） */
  restored?: boolean;
  /**
   * 落盘基线：上次读到/写到的旁挂快照摘要。
   *   - `string`：那一版的摘要，下次落盘必须仍与盘上一致（否则拒写）
   *   - `null`：读的时候文件确实不存在（首次落盘）
   *   - `'unknown'`：读过但没读懂，禁止覆盖（那份可能是唯一的一份）
   */
  sidecarBaseline?: string | null | 'unknown';
  /**
   * 最近一次落盘是否因被别处改过而失败。
   *
   * 单独留一个标志，是因为界面上要给出出路：提示里写着"需先重新载入"，
   * 却没有可点的入口，等于让医生照着一句做不到的话操作（最后往往只能去点"重置工作区"）。
   */
  sidecarConflict?: boolean;
}

/** `persist` 的结果：写内存成功了不等于落盘成功了，两件事要能分开报 */
interface PersistStatus {
  ok: boolean;
  code?: string;
  message?: string;
  /** 是否是"盘上已被别处改过"这一类冲突（界面据此说清是人改了还是坏了） */
  conflict?: boolean;
}

interface AuditSummary {
  jsonPath: string;
  mdPath: string;
  generatedAt: string;
  passed: number;
  total: number;
  reportDigest: string;
  failed: Array<{ id: string; description: string; detail: string }>;
}

const state: {
  workspace: DemoWorkspace | undefined;
  entries: Map<string, DocEntry>;
  activeDocId: string;
  /**
   * 阅读授权按授权编号全局索引，而不是挂在"当时打开的那份文档"上。
   * 理由（实测踩到）：授权是独立实体，用户切到别的病历再拿旧凭证来读时，
   * 系统应当回答"这份授权不是给这份文档签的"（E_DOCUMENT_CHANGED），
   * 而不是"没有这个授权"（E_NOT_FOUND）。后者会让"越权/串档"看起来像"记录丢了"。
   */
  readingGrants: Map<string, ReadingRecord>;
  /**
   * 接收方公钥目录（落盘 artifacts/recipient-keys.json）。
   * 只存公钥：私钥的生成与保管属于密码设备职责，服务端不应持有，这也是本模块的边界。
   */
  recipientKeys: RecipientKeyStore;
  /** 公钥目录读取失败的原因（不静默：读坏了要说出来，否则"我导入的接收方不见了"无从排查） */
  recipientKeyStoreError?: string;
} = {
  workspace: undefined,
  entries: new Map(),
  activeDocId: '',
  readingGrants: new Map(),
  recipientKeys: EMPTY_KEY_STORE,
};

function humanActor(id: string): Actor {
  return { id, kind: 'human' };
}

/** 启动时加载公钥目录：读坏了要显式记录下来，而不是当成"没有接收方" */
function reloadRecipientKeys(): void {
  try {
    state.recipientKeys = loadRecipientKeyTable(STORAGE.db);
    state.recipientKeyStoreError = undefined;
  } catch (err) {
    state.recipientKeys = EMPTY_KEY_STORE;
    state.recipientKeyStoreError = (err as Error).message;
    console.error(`[公钥目录] 读取失败：${(err as Error).message}`);
  }
}

function persistRecipientKeys(): { ok: boolean; message?: string } {
  try {
    saveRecipientKeyTable(STORAGE.db, state.recipientKeys);
    return { ok: true };
  } catch (err) {
    /* 保存失败必须回传：否则用户以为"导入成功了"，重启后却不见了 */
    return { ok: false, message: (err as Error).message };
  }
}

/**
 * 受控阅读的授权登记（凭据 + 阅读计数 + 阅读流水）落库（`reading_grants` 表）。
 *
 * 它与旁挂数据同属"过程性、不进签名"的一类：授权用途、允许的章节范围、接收方种子、
 * 以及"谁在什么时候读了这份病历"的流水，都在里面 —— 因此载荷加密存
 * （`storage/sealed.ts` 的同一条信封链路），列上只留 `doc_id` / `revoked` / `read_count`
 * 这几件"不解密就要能答"的事（列表、统计、次数门控）。
 *
 * 不落盘的后果很具体：重启后授权全部消失，而"没有授权"与"授权被清了"在界面上一模一样。
 *
 *  加载动作必须挪到开库之后（原先那个整体式文件可以在开库前读）：
 * 这是本次改造里第二处被迫挪位的启动动作，与公钥目录同一个原因 —— 库句柄与口令就位才能读它。
  */
const READING_GRANTS_FILE = RUNTIME.readingGrantsFile;
let READING_GRANTS_ERROR: string | null = null;

function toGrantRecords(): ReadingGrantRecord[] {
  return [...state.readingGrants.values()].map((record) => ({
    grantId: record.credential.grant.grantId,
    docId: record.credential.grant.docId,
    revoked: record.revoked,
    readCount: record.readCount,
    payload: record,
  }));
}

function persistReadingGrants(): { ok: boolean; message?: string } {
  try {
    syncReadingGrants(STORAGE.db, statePassphrase(), toGrantRecords());
    return { ok: true };
  } catch (err) {
    /* 保存失败必须回传（同公钥目录）：否则"授权登记好了"在重启后变成一句假话 */
    return { ok: false, message: (err as Error).message };
  }
}

/** 启动时把库里的登记读回内存索引；读坏了要显式记录下来，而不是当成"没有授权" */
function restoreReadingGrants(): void {
  const loaded = loadAllReadingGrants(STORAGE.db, statePassphrase());
  if (!loaded.ok) {
    /* 读不出来不能当成"没有授权"：那会把"数据丢了"伪装成"本来就没有" */
    READING_GRANTS_ERROR = `${loaded.code}：${loaded.message}`;
    console.error(`[受控阅读] 授权登记读取失败（reading_grants 表）：${READING_GRANTS_ERROR}`);
    return;
  }
  for (const record of loaded.records) {
    state.readingGrants.set(record.grantId, record.payload as ReadingRecord);
  }
  if (state.readingGrants.size > 0) {
    console.log(`[受控阅读] 已从数据库恢复授权登记 ${state.readingGrants.size} 条`);
  }
}

/* ===================== 工作数据的落盘：数据库（唯一权威） ===================== */

const STATE_DIR = RUNTIME.stateDir;
const DB_FILE = RUNTIME.dbFile;
const stateFileOf = (docId: string): string => join(STATE_DIR, `${docId}.json`);

function openStorageOrExit(): OpenDatabaseResult {
  try {
    return openDatabase(DB_FILE, { schemaVersion: STORAGE_SCHEMA_VERSION, migrations: MIGRATIONS });
  } catch (err) {
    const code = String((err as { code?: string }).code ?? 'E_STORAGE_OPEN_FAILED');
    failFast(`数据库不可用（${code}）：${(err as Error).message}`, `工作数据必须落库、不回落文件存储。请修好它，或用 L0_DB_FILE 指定另一个库（当前：${DB_FILE}）`);
  }
}

function failFast(what: string, advice: string): never {
  console.error(`[存储] ${what}`);
  console.error(`[存储] ${advice}`);
  process.exit(1);
  throw new Error(`[存储] ${what}`); /* 让类型上也是 never（`process.exit` 在本环境的声明里不是 never） */
}

const STORAGE = openStorageOrExit();
/* 盐跟着口令一起从服务端文件配置来：库里的密文要解得开，两者必须同时正确（见 core/store.ts） */
const workStore = new WorkStore(STORAGE.db, STATE_PASSPHRASE, STATE_SALT_HEX === undefined ? {} : { salt: STATE_SALT_HEX });
if (STORAGE.applied.length > 0) {
  console.log(`[存储] 已把数据库推进到结构版本 ${STORAGE_SCHEMA_VERSION}：执行迁移 ${STORAGE.applied.join('、')}`);
}

const CONFIG_KV = createConfigKv(workStore);

/**
 * 系统策略：鉴权模式、会话寿命、限流阈值、锚定节奏、锚点种子 —— 全在 `config.system`。
 *
 * 启动时读一次，与模型/采集/落位配置（每次请求都重读）刻意不同：这四项落在
 * 内存结构的构造上（会话表、限流器、签名者），改了要重建它们才生效；
 * 而"改完立即生效"在这里的代价是每次请求都重建会话表 —— 那会把正在登录的人踢出去。
 *
 * 所以：改这四项需要重启服务，这一点在管理后台与启动日志里都要写清楚。
 * 不说清的话，它的现场表现是"我改了策略、什么都没发生"，而人只会怀疑自己没保存成功。
  */
function systemConfigNow(): LoadedSystemConfig {
  return loadSystemConfig(CONFIG_KV);
}

/**
 * 科室字典：院内有哪些科、编码与显示名。
 *
 * 它不像系统策略那样启动时读一次：字典是随时可读的数据，
 * 改完就该立刻生效（模板上的科室、就诊科室名的显示都靠它）。
  */
function departmentsNow(): LoadedDepartments {
  return loadDepartments(CONFIG_KV);
}

/** 读科室字典；读不出来时不当作"没有科室"：把原因带出来，界面才能区分"没配"与"读不出"  */
function departmentsSafe(): { loaded: LoadedDepartments; error: string | null } {
  try {
    return { loaded: departmentsNow(), error: null };
  } catch (err) {
    return { loaded: { items: [], source: 'empty' }, error: (err as Error).message };
  }
}

/**
 * 文书类型：院内有哪些类型、各自的体系 / 编码 / 显示名。
 *
 * 与科室字典同一处置：不像系统策略那样启动时读一次 —— 改完就该立刻生效
 * （「新建文书」的类型下拉与模板列表的展示都读它）。
  */
function docTypesNow(): LoadedDocTypes {
  return loadDocTypes(CONFIG_KV);
}

/** 读文书类型；读不出来时不当作"没有类型"：把原因带出来，界面才能区分"没配"与"读不出"  */
function docTypesSafe(): { loaded: LoadedDocTypes; error: string | null } {
  try {
    return { loaded: docTypesNow(), error: null };
  } catch (err) {
    return { loaded: { items: [], source: 'empty' }, error: (err as Error).message };
  }
}

function validateTemplateDepartments(codes: string[]): { code: string; message: string } | null {
  if (codes.length === 0) return null;
  const { loaded, error } = departmentsSafe();
  if (error) return { code: 'E_DEPT_INVALID', message: `科室字典读不出来，无法核对适用科室：${error}` };
  if (loaded.source === 'empty') {
    return {
      code: 'E_TPL_DEPT_UNKNOWN',
      message:
        '科室字典还是空的：先在管理后台「基础数据」里建科室 —— 否则"限某个科"没有可判定的依据，这份文书现在只能配成通用',
    };
  }
  const unknown = codes.filter((code) => !isDepartmentSelectable(loaded, code));
  if (unknown.length > 0) {
    return {
      code: 'E_TPL_DEPT_UNKNOWN',
      message:
        `科室字典里没有（或已停用）：${unknown.join('、')}。先在「基础数据」里加上它`
        + ' —— 一个对不上任何人的科室编码，会让这份文书谁都开不出',
    };
  }
  return null;
}

const SYSTEM_CONFIG = systemConfigNow();
const AUTH_MODE: 'open' | 'strict' = SYSTEM_CONFIG.config.authMode;
const SESSION_TTL_MINUTES = SYSTEM_CONFIG.config.sessionTtlMinutes;

const sessions = new SessionStore({ ttlMs: SESSION_TTL_MINUTES * 60_000 });

/**
 * 限流规则：登录尝试（最刚需的一条）、AI 外呼（花钱的动作）、导出（重操作）。
 *
 * 在这之前管理员登录没有任何失败次数限制，而口令是单一共享口令，
 * "猜一万次"与"猜一次"的成本一样。审计能留下失败记录，但审计是事后看的。
 */
const RATE_RULES = {
  'login:actor': { limit: SYSTEM_CONFIG.config.rate.loginPerActor, windowMs: 5 * 60_000, label: '登录尝试（同一身份）' },
  'login:source': { limit: SYSTEM_CONFIG.config.rate.loginPerSource, windowMs: 5 * 60_000, label: '登录尝试（同一来源）' },
  'ai:suggest': { limit: SYSTEM_CONFIG.config.rate.aiPerMinute, windowMs: 60_000, label: 'AI 调用' },
  export: { limit: SYSTEM_CONFIG.config.rate.exportPerMinute, windowMs: 60_000, label: '导出' },
} satisfies Record<string, RateRule>;
const limiter = new SlidingWindowLimiter();

/**
 * 锚点签名者：种子来自库里的 `config.system.anchorSeed`（未配时是内置演示种子）。
 * 它是机密，只在这一处解出来用，不进日志、不进任何返回值。
  */
const anchorSigner = softwareSigner(demoKeyPair(SYSTEM_CONFIG.anchorSeed).privateKey);
const anchorVerifier = softwareVerifier(anchorSigner.publicKey);
/**
 * 每追加几条记录锚一次。默认 1（每条都锚）：锚点比记录小得多，代价可以忽略，
 * 换来的是"未锚定的尾部"始终为空，而那一段被删是检不出来的。
 */
const ANCHOR_EVERY = SYSTEM_CONFIG.config.anchorEvery;

/* 公钥目录落库（`recipient_keys` 表）：读它要库句柄，所以启动加载只能在这里
   （原先那个 JSON 文件可以在开库前读，这是本次改造里唯一被迫挪位的启动动作）。  */
reloadRecipientKeys();

/* 授权登记：先搬家、再加载（顺序反了的话，导进来的授权要等下次启动才生效 ——
   而"我搬完之后界面里还是空的"最容易被当成"搬家没成功"）。  */
const READING_GRANTS_IMPORT = importReadingGrantsOnce({
  workStore,
  db: STORAGE.db,
  passphrase: statePassphrase(),
  file: READING_GRANTS_FILE,
});
console.log(`[受控阅读] ${READING_GRANTS_IMPORT.reason}${
  READING_GRANTS_IMPORT.problem === null ? '' : `；⚠️ ${READING_GRANTS_IMPORT.problem}`
}`);
restoreReadingGrants();

const CONFIG_IMPORT = importLegacyConfigOnce({
  workStore,
  kv: CONFIG_KV,
  dir: STATE_DIR,
  passphrase: STATE_PASSPHRASE,
});
if (CONFIG_IMPORT.failed.length > 0) {
  console.error(
    `[部署参数] 旧文件搬家失败（原文件保留未动，库里也没动）：${CONFIG_IMPORT.failed
      .map((item) => `${item.key}：${item.message}`)
      .join('；')}`,
  );
} else if (CONFIG_IMPORT.imported.length > 0) {
  console.log(
    `[部署参数] 已把旧的部署参数文件搬进库 ${CONFIG_IMPORT.imported.length} 条：${CONFIG_IMPORT.imported.join('、')}（旧文件保留，作回滚凭据）`,
  );
} else {
  /* 没事也要说一句：不打印的话，启动日志里就答不出"这几份配置是从哪来的" ——
     而"我改了旧文件却没生效"（或反过来"旧文件还在，会不会被读"）正是这里最常被问的一句。
     代价是一行日志，收益是这个系统少一处"什么都没发生"。  */
  console.log(`[部署参数] ${CONFIG_IMPORT.reason}（来源：sealed_kv）`);
}

const QC_RULES_IMPORT = importQcRulesOnce({ workStore, kv: CONFIG_KV, file: IMPORTS.qcRulesFile });
console.log(`[质控规则] ${QC_RULES_IMPORT.reason}`);

/* ------------------------------ 管理审计与链头锚点（库里） ------------------------------ */

const adminAudit = new AdminAuditLog(STORAGE.db);
const auditAnchors = new AuditAnchorStore(STORAGE.db);

const AUDIT_IMPORT = importAuditOnce({
  workStore,
  db: STORAGE.db,
  auditFile: AUDIT_FILE,
  anchorFile: ANCHOR_FILE,
});
if (!AUDIT_IMPORT.ran) {
  console.log(`[管理审计] ${AUDIT_IMPORT.reason}`);
} else if (AUDIT_IMPORT.records > 0 || AUDIT_IMPORT.anchors > 0 || AUDIT_IMPORT.problem !== null) {
  console.log(
    `[管理审计] 已把旧文件搬进库：${AUDIT_IMPORT.records} 条记录、${AUDIT_IMPORT.anchors} 条锚点` +
      `${AUDIT_IMPORT.droppedAnchors > 0 ? `（丢弃 ${AUDIT_IMPORT.droppedAnchors} 条指向链外的锚）` : ''}` +
      `${AUDIT_IMPORT.problem ? `；旧文件有问题：${AUDIT_IMPORT.problem}` : ''}（旧文件保留原处）`,
  );
}

const AUDIT_LOAD = adminAudit.load();
const ANCHOR_LOAD = auditAnchors.load();
if (AUDIT_LOAD.problem) {
  console.error(
    `[管理审计] 链校验未通过（${AUDIT_LOAD.problem.kind} 在第 ${AUDIT_LOAD.problem.atLine} 条）` +
      `${
        AUDIT_LOAD.problem.kind === 'broken'
          ? `：${AUDIT_LOAD.problem.reason}`
          : AUDIT_LOAD.problem.kind === 'seqGap'
            ? `（期望序号 ${AUDIT_LOAD.problem.expected}，实际 ${AUDIT_LOAD.problem.actual}）`
            : '（尾行不完整，通常是导入旧文件时的残行）'
      }` +
      `；只展示已验证的 ${AUDIT_LOAD.loaded} 条，未展示 ${AUDIT_LOAD.discarded} 条（**留在库里，不删**）`,
  );
}
if (ANCHOR_LOAD.error) console.error(`[管理审计] 锚点读取有问题：${ANCHOR_LOAD.error}`);
/* 读锚的结果要接到那条"看得见的失败"上（它是模块级变量，初值在文件顶部留空） */
ANCHOR_WRITE_ERROR = ANCHOR_LOAD.error;

/**
 * 账号仓储（唯一读写 `admin_users` 的地方，工作数据同一个库）。
 *
 * 落同一个库而不是另起一份：备份一次就带走"这台机器上有谁能进来"，
 * 而"数据恢复了但没人能登录"是灾难恢复里最容易漏掉的一幕。
 */
const userStore = new UserStore(STORAGE.db);

// 而它一次性把口令写进数据库，从此账目清楚：口令的真实来源只有一处（库），
// 于是他会继续拿旧口令去登录、失败、然后去怀疑整套东西，那是一次本可以不发生的排查。

function seedAccountsFromConfig(): void {
  if (userStore.count() > 0) return;
  if (!DEPLOY_USER || !DEPLOY_TOKEN) return;
  try {
    const created = userStore.create({
      username: DEPLOY_USER,
      password: DEPLOY_TOKEN,
      role: 'admin',
      by: '装机凭据播种（server-config.json 的 bootstrap.user）',
    });
    console.log(`[账号] 空库 + 已给出 bootstrap.user / bootstrap.token：已播种管理员「${created.username}」`);
    console.log('[账号] 口令是从服务端配置文件读了一次、写进数据库的：此后改口令请改在数据库里');
    console.log('[账号]   （管理后台「账号管理」，或 npm run user -- passwd <用户名>）。那份文件不再参与登录。');
  } catch (err) {
    if (err instanceof UserError) {
      failFast(
        `播种初始管理员失败（${err.code}）：${err.message}`,
        `口令至少 ${PASSWORD_MIN_LENGTH} 位，用户名只能由字母、数字与 . _ @ - 组成。` +
          `改好后重启；或清空 ${SERVER_CONFIG.path} 里的 bootstrap.user，改为打开 /login 由页面上初始化。`,
      );
    }
    throw err;
  }
}
seedAccountsFromConfig();

/** 账号现状（启动日志与「系统信息」共用一处口径） */
function accountStatus(): { initialized: boolean; total: number; admins: number; source: string } {
  const total = userStore.count();
  return {
    initialized: total > 0,
    total,
    admins: userStore.enabledAdminCount(),
    source: total > 0 ? `数据库 admin_users（${total} 个账号）` : '尚未创建任何账号（首次访问 /login 可初始化）',
  };
}

function entryFor(doc: DocumentModel, fromStore = false): DocEntry {
  /* 真实时钟：编辑器是给人用的，留痕时间必须是真时间（否则书写时长不可信、痕迹也排不出先后）。
     自测与回放走默认逻辑时钟 —— 确定性那条路留给机器。 */
  const session = fromStore ? WriteSession.openPersisted(doc, { clock: 'wall' }) : WriteSession.open(doc, { clock: 'wall' });
  /* 豁免装载 ≠ 当没看见：库里那份的机读信息确实有待重算，就得在启动日志里说出来 ——
     不吭一声的话，"导出怎么被拦了"会成一件没有前因的事。
     只在有机读块且确实陈旧时报（没有块 = 还没派生过，那是另一件事，不必每次都喊）。  */
  if (fromStore && doc.machineReadable) {
    const status = session.machineReadableStatus();
    if (status.stale) {
      console.log(`[存储] ${doc.docId}：机读信息有待重算（${status.reasons.join('；')}）—— 已装载，导出前需「重算机读信息」`);
    }
  }
  return {
    docId: doc.docId,
    session,
    log: [],
    lastExport: null,
    lastWst500: null,
    lastJson: null,
    lastDictation: null,
    lastCapture: null,
    lastConsistency: null,
    lastVisitTimeline: null,
    lastVisitCompare: null,
    lastDischargeSummary: null,
    lastReadingView: null,
    lastReadingSource: null,
    lastAudit: null,
    lastQcUnevaluated: [],
  lastContentQc: null,
    lastAiSilence: null,
    /* 已落库的 rev：`persist` 据此判断"正文有没有变"，旁挂操作不改 rev，
       没有它就会每次处置提示都重存一遍正文（几 KB 的加密，白做）。 */
    storedRev: doc.revisions.length,
  };
}

/**
 * 装载工作区：库里有就从库里装，库是空的才播种。
 *
 * 这是"数据库是唯一权威"的落点：出厂演示数据只在空库时进入一次，
 * 之后无论怎么重启、怎么改，读到的都是库里的那一份。
 */
function restoreOrSeedWorkspace(): void {
  const structure = workStore.loadStructure();
  if (structure.patients.length > 0) {
    const loaded = workStore.loadAllDocuments();
    if (!loaded.ok) {
      failFast(
        `文书读取失败（${loaded.code}）：${loaded.message}`,
        '拒绝以空工作区启动，避免把"读不出来"当成"本来就没有"。数据仍在库里，修好口令或库文件后再启动。',
      );
    }
    state.workspace = structure as unknown as DemoWorkspace;
    state.entries = new Map();
    for (const doc of loaded.docs) state.entries.set(doc.docId, entryFor(doc, true));
    state.activeDocId = loaded.docs[0]?.docId ?? '';
    importLegacySidecarsOnce();
    console.log(`[存储] 已从数据库装载：${structure.patients.length} 位患者 / ${loaded.docs.length} 份文书（${DB_FILE}）`);
    return;
  }

  /* 空库：把出厂演示工作区播种进去，让"落库"从第一天就是真的 */
  const workspace = buildWorkspace();
  state.workspace = workspace;
  state.entries = new Map();
  for (const doc of workspace.docs) state.entries.set(doc.docId, entryFor(doc));
  state.activeDocId = workspace.defaultDocId;

  workStore.saveStructure({ patients: workspace.patients });
  for (const patient of workspace.patients) {
    for (const visit of patient.visits) {
      visit.docs.forEach((item, index) => {
        const doc = workspace.docs.find((candidate) => candidate.docId === item.docId);
        if (doc) {
          workStore.saveDocument(doc, {
            title: item.title,
            ...(item.kind ? { kind: item.kind } : {}),
            sort: index,
          });
        }
      });
    }
  }
  importLegacySidecarsOnce();
  console.log(`[存储] 空库：已把出厂工作区播种进去（${workspace.patients.length} 位患者 / ${workspace.docs.length} 份文书 → ${DB_FILE}）`);
}

/**
 * 一次性导入：库是新的、磁盘上还留着旧的"每份文书一个密封文件" → 读进库。
 *
 * 记账（`import_ledger`）保证只做一次：否则每次启动都会把已经过期的旧文件
 * 重新盖回库里（那会把"重置之后再启动"变成"旧数据偷偷复活"）。
 * 旧文件不删：它此刻是唯一的回滚凭据，删掉就没有退路了。
 */
function importLegacySidecarsOnce(): void {
  const ledgerId = 'imported-sidecars-from-files';
  if (workStore.ledgerHas(ledgerId)) return;
  let imported = 0;
  let failed = 0;
  for (const docId of state.entries.keys()) {
    const file = stateFileOf(docId);
    if (!existsSync(file)) continue;
    const loaded = loadSidecarsSealed(file, statePassphrase());
    if (!loaded.ok || loaded.firstRun || !loaded.data) {
      failed += 1;
      continue;
    }
    try {
      workStore.saveSidecars(docId, loaded.data);
      imported += 1;
    } catch {
      failed += 1;
    }
  }
  workStore.ledgerMark(ledgerId, `从旧文件存储导入旁挂数据：成功 ${imported}，失败 ${failed}`);
  if (imported > 0 || failed > 0) {
    console.log(`[存储] 旧文件存储导入：成功 ${imported} 份${failed > 0 ? `，失败 ${failed} 份（原文件保留）` : ''}`);
  }
}

/** 「重置工作区」= 清库 + 重新播种。重置必须真的把库清掉，否则下一次读回来就是"重置是假的" */
function resetWorkspace(): void {
  workStore.clearWorkData();
  restoreOrSeedWorkspace();
}

function current(): DocEntry {
  const entry = state.entries.get(state.activeDocId);
  if (!entry) throw new Error(`活动病历不存在：${state.activeDocId}`);
  return entry;
}

function humanOf(entry: DocEntry): Actor {
  return humanActor(entry.session.document.createdBy);
}

function writeActor(req: IncomingMessage, entry: DocEntry): Actor {
  if (AUTH_MODE === 'strict') {
    const resolved = resolvePrincipal(req);
    if (resolved.ok) return { id: resolved.principal.actorId, kind: 'human' };
  }
  /* 这一行是兜底（open 模式、或会话缺失时的归属）：它必须调 `humanOf` 而不是自己，
     `replace_all` 改这一批调用点时最容易把新函数自己的兜底也改掉，那就是无限递归。 */
  return humanOf(entry);
}

restoreOrSeedWorkspace();

/**
 * 科室字典：只播一次。
 *
 * 与工作区的播种口径刻意不同：工作区是"空库就播种"，而科室可以被有意删光 ——
 * 用一条标记记住"播过"，于是"我们把科室清了"与"这个库还没建过科室"分得开，
 * 删掉之后重启也不会自己长回来（长回来又没人知道是谁加的，比没有更糟）。
  */
function seedDepartmentsOnce(): void {
  if (departmentsSafe().loaded.source !== 'empty') return;
  if (departmentsSeeded(CONFIG_KV)) return;
  saveDepartments(CONFIG_KV, DEPARTMENTS, 'demo-seed');
  markDepartmentsSeeded(CONFIG_KV);
  console.log(`[科室字典] 已播种 ${DEPARTMENTS.length} 个科室（管理后台「基础数据」可维护；删掉后不会自己回来）`);
}

function seedDocTypesOnce(): void {
  if (docTypesSafe().loaded.source !== 'empty') return;
  if (docTypesSeeded(CONFIG_KV)) return;
  saveDocTypes(CONFIG_KV, DOC_TYPES, 'demo-seed');
  markDocTypesSeeded(CONFIG_KV);
  console.log(`[文书类型] 已播种 ${DOC_TYPES.length} 个类型（管理后台「基础数据」可维护；删掉后不会自己回来）`);
}

/**
 * 老库迁移：就诊科室从名称迁到编码。
 *
 * 科室字典上线前，`visits.dept` 存的是"呼吸内科"这样的名称；现在它必须存编码 ——
 * 判定是拿就诊科室编码与模板上的科室编码对齐的，两边不同源就永远对不上。
 *
 * 幂等：编码不会再匹配到任何名称，跑多少次结果都一样（所以不需要记账闸门）。
 * 字典里查不到的旧名称（历史数据、导入数据）原样保留：猜一个编码比留着更糟。
  */
function migrateVisitDeptCodes(): void {
  if (!state.workspace) return;
  const { loaded } = departmentsSafe();
  if (loaded.source === 'empty') return;
  let changed = 0;
  for (const patient of state.workspace.patients) {
    for (const visit of patient.visits) {
      if (!visit.dept) continue;
      if (loaded.items.some((item) => item.code === visit.dept)) continue;
      const matched = loaded.items.find((item) => item.name === visit.dept);
      if (!matched) continue;
      visit.dept = matched.code;
      changed += 1;
    }
  }
  if (changed > 0) {
    persistStructure();
    console.log(`[科室字典] 已把 ${changed} 个就诊的科室从名称迁成编码（"限科室"的判定按编码对齐）`);
  }
}

seedDepartmentsOnce();
seedDocTypesOnce();
migrateVisitDeptCodes();

const TEMPLATES: Array<{ name: string; match: (node: DocNode) => boolean; text: string }> = [
  { name: '主诉规范化', match: (node) => hasTag(node, (tag) => tag.code.endsWith('2.001')), text: '发热3天，伴咳嗽、咳痰。' },
  { name: '诊断建议', match: (node) => hasTag(node, (tag) => tag.system === 'ICD10'), text: '结合症状、体征与辅助检查，建议明确诊断并按指南规范治疗，定期随访。' },
  { name: '病史归纳', match: (node) => node.type === 'text', text: '（AI 归纳）患者急性起病，病程明确，主要症状与体征相符，既往史无特殊，否认药物过敏史。' },
];

function hasTag(node: DocNode, predicate: (tag: DataElementTag) => boolean): boolean {
  return Array.isArray(node.tags) && node.tags.some(predicate);
}

function templateFor(node: DocNode): { name: string; text: string } {
  return TEMPLATES.find((template) => template.match(node)) ?? {
    name: '通用补充',
    text: '（AI 草稿）建议结合既往史与检查结果进一步完善本段记录。',
  };
}

function textOf(node: Extract<DocNode, { type: 'text' }>): string {
  return node.runs.map((run) => run.text).join('');
}

function templateRefOf(node: DocNode): string | undefined {
  return (node.provenance.evidence ?? []).find((evidence) => evidence.kind === 'template')?.ref;
}

function fromRefOf(node: DocNode): string | undefined {
  const ref = (node.provenance.evidence ?? []).find((evidence) => evidence.kind === 'his')?.ref;
  return ref && ref.startsWith('ctx:') ? ref.slice('ctx:'.length) : undefined;
}

/** 上下文路径 → 人话名称（界面显示"系统带入（患者姓名）"；查不到就按路径原样显示） */
function contextLabelOf(path: string): string {
  return CONTEXT_FIELDS.find((field) => field.path === path)?.label ?? path;
}

/** 表格里的一个格子：带 `nodeId` 的格子是可编辑的（那是一个字段/填写项节点） */
interface ViewTableCell {
  nodeId?: NodeId;
  text: string;
  unit?: string;
}

/**
 * 专科控件里的一格。
 *
 * 键由服务端算好下发（`model/control.ts` 的 `controlCellsOf`）：界面只负责画。
 * 让浏览器自己拼键等于把"哪一格"这条规则复制到第二处，而它一旦漂移，
 * 症状是"医生填进去的值在导出里不见" —— 两端都不报错。
  */
interface ViewControlCell {
  key: string;
  label: string;
  dataType: string;
  unit?: string;
  valueSet?: Array<{ code: string; display?: string }>;
  required?: boolean;
  /** 这一格是第几条记录（`series` 才有，1 起） */
  row?: number;
  rowKey?: string;
  rowLabel?: string;
  columnKey?: string;
  columnLabel?: string;
  /** 已填的值；空字符串 = 没填过（控件里没有 null：没填就是没有这个键） */
  value: string;
}

interface ViewItem {
  kind: 'section' | 'listItem' | 'text' | 'field' | 'table' | 'control' | 'image';
  id: NodeId;
  title?: string;
  text?: string;
  /**
   * 图片地址（只有 `kind === 'image'` 才有）。
   *
   * 它不是病历内容，只是一条引用：图的字节在 `state/resources` 下，
   * 服务端按 `/res/<sha256>.<ext>` 下发。这样做的直接后果是——没有那个文件，
   * 这张图就不存在（不是"显示不出来"），所以导出时会明确报"图片取不到"，
   * 而不是画一张空框。
    */
  resRef?: string;
  /** 图片的替代文字（无障碍 + 纸面上的说明） */
  altText?: string;
  /** 图注（排在图下方） */
  caption?: string;
  paragraphId?: NodeId;
  runs?: TextRun[];
  /** 专科控件的形状（只有 `kind === 'control'` 才有）：渲染器按它分派  */
  shape?: string;
  /** 专科控件的语义类型（质控与机读分类按它问） */
  controlKind?: string;
  cells?: ViewControlCell[];
  /** 表格表头（只有 `kind === 'table'` 才有） */
  columns?: string[];
  /** 表格数据行；格子带 `nodeId` 的才可编辑（表头格子是只读文本） */
  rows?: ViewTableCell[][];
  label?: string;
  value?: string;
  unit?: string;
  tags: DataElementTag[];
  origin: string;
  modelId?: string;
  confidence?: number;
  acceptedBy?: string;
  keyContent: boolean;
  humanConfirmed: boolean;
  rev: number;
  /** 段落在本节的第一个 / 最后一个（只对内容节点有意义；界面据此禁用"上移/下移"） */
  paragraphFirst?: boolean;
  paragraphLast?: boolean;
  /** 由模板实例化而来时的出处（`<包>#<模板>@<版本>`）：界面据此把"系统带入"改写成"模板带入" */
  templateRef?: string;
  marker?: string;
  /** 列表项里那个文本节点的 id：界面用它走 `data-edit`（与正文同一写路径） */
  textId?: NodeId;
  /** 列表项里那个填写项的 id：界面用它走 `data-field`（与表格格子同一写路径） */
  fieldId?: NodeId;
}

function buildItems(session: WriteSession): ViewItem[] {
  return buildItemsOfDocument(session.document);
}

function decoratedRunsOf(node: Extract<DocNode, { type: 'text' }>): TextRun[] | undefined {
  return node.runs.some((run) => (run.marks ?? []).length > 0 || run.provenance !== undefined) ? node.runs : undefined;
}

function tableDescendantIds(doc: DocumentModel, kidsOf: (id: NodeId) => DocNode[]): Set<NodeId> {
  const consumed = new Set<NodeId>();
  for (const node of Object.values(doc.nodes)) {
    if (!node || node.type !== 'table') continue;
    const stack: NodeId[] = kidsOf(node.id).map((child) => child.id);
    while (stack.length > 0) {
      const current = stack.pop() as NodeId;
      if (consumed.has(current)) continue;
      consumed.add(current);
      for (const child of kidsOf(current)) stack.push(child.id);
    }
  }
  return consumed;
}

function listItemMetaOf(
  doc: DocumentModel,
  kidsOf: (id: NodeId) => DocNode[],
): { marker: Map<NodeId, string>; consumed: Set<NodeId> } {
  const marker = new Map<NodeId, string>();
  const consumed = new Set<NodeId>();
  for (const node of Object.values(doc.nodes)) {
    if (!node || node.type !== 'listGroup') continue;
    const items = kidsOf(node.id).filter((child) => child.type === 'listItem');
    items.forEach((item, index) => {
      marker.set(item.id, node.ordered === true ? `${index + 1}. ` : '· ');
      for (const child of kidsOf(item.id)) consumed.add(child.id);
    });
  }
  return { marker, consumed };
}

/**
 * 表头各列的列名：取第一条表头行里每个格子的文本。
 *
 * 多行表头（合并单元格那种）目前没有来源，所以不去猜 ——
 * 猜错的表头会把数据画到错误的列下面，而那是看表的人唯一能依凭的东西。
  */
function tableColumnsOf(table: Extract<DocNode, { type: 'table' }>, kidsOf: (id: NodeId) => DocNode[]): string[] {
  const header = kidsOf(table.id).filter((node) => node.type === 'tableRow')[0];
  if (!header) return [];
  return kidsOf(header.id)
    .filter((node) => node.type === 'tableCell')
    .map((cell) => cellViewOf(cell, kidsOf).text);
}

/** 数据行（表头之外的行），每格一个 `ViewTableCell` */
function tableRowsOf(table: Extract<DocNode, { type: 'table' }>, kidsOf: (id: NodeId) => DocNode[]): ViewTableCell[][] {
  const headerRowCount = Math.max(1, table.headerRows ?? 1);
  return kidsOf(table.id)
    .filter((node) => node.type === 'tableRow')
    .slice(headerRowCount)
    .map((row) => kidsOf(row.id).filter((node) => node.type === 'tableCell').map((cell) => cellViewOf(cell, kidsOf)));
}

/**
 * 一个格子怎么画。
 *
 * 只取第一个子节点：一格放两样东西（一句话 + 一个填写项）在表格里没有意义，
 * 而"把所有子节点拼成一句只读文本"会把填写项吞掉 —— 那才是真正的数据丢失。
 * 文本 → 只读文字；填写项 → 可编辑的格子（带 nodeId，界面按 `data-field` 走
 * 与正文填写项完全相同的那条写路径：留痕、索引同步、乐观锁都一样）。
  */
function cellViewOf(cell: Extract<DocNode, { type: 'tableCell' }>, kidsOf: (id: NodeId) => DocNode[]): ViewTableCell {
  const first = kidsOf(cell.id)[0];
  if (!first) return { text: '' };
  if (first.type === 'text') return { text: textOf(first) };
  if (first.type === 'field') {
    return {
      nodeId: first.id,
      text: first.valueText ?? (first.value === null || first.value === undefined ? '' : String(first.value)),
      ...(first.unit ? { unit: first.unit } : {}),
    };
  }
  return { text: '' };
}

function buildItemsOfDocument(doc: DocumentModel): ViewItem[] {
  const items: ViewItem[] = [];
  /* 直接子节点索引：表格要按"行 → 格子 → 格子里那一个填写项"取内容，
     而 `orderedNodeIds` 给的是一份整篇平铺的顺序，取不到"谁是谁的孩子" */
  const childMap: Record<NodeId, DocNode[]> = {};
  for (const node of Object.values(doc.nodes)) {
    if (!node || node.parentId === null || node.parentId === undefined) continue;
    const bucket = childMap[node.parentId] ?? (childMap[node.parentId] = []);
    bucket.push(node);
  }
  for (const bucket of Object.values(childMap)) {
    bucket.sort((a, b) => (a.order === b.order ? a.id.localeCompare(b.id) : a.order - b.order));
  }
  const kidsOf = (id: NodeId): DocNode[] => childMap[id] ?? [];
  const inTable = tableDescendantIds(doc, kidsOf);
  const listInfo = listItemMetaOf(doc, kidsOf);

  for (const id of orderedNodeIds({ nodes: doc.nodes, rootId: doc.rootId })) {
    const node = doc.nodes[id];
    if (!node) continue;
    /* 表格的后代已经画进表格里了：再画一遍就是"一张表 + 一堆散落在下面的格子"，
       而格子里的填写项甚至会以独立填写项的样子再出现一次（同一份数据出现两遍） */
    if (inTable.has(id) || listInfo.consumed.has(id)) continue;
    if (node.type === 'table') {
      items.push({
        kind: 'table',
        id: node.id,
        columns: tableColumnsOf(node, kidsOf),
        rows: tableRowsOf(node, kidsOf),
        tags: [],
        origin: node.provenance.origin,
        ...(templateRefOf(node) ? { templateRef: templateRefOf(node) } : {}),
        keyContent: node.keyContent === true,
        humanConfirmed: node.humanConfirmed === true,
        rev: node.rev,
      });
      continue;
    }
    if (node.type === 'section') {
      items.push({
        kind: 'section',
        id: node.id,
        title: node.title ?? node.sectionCode ?? '（未命名章节）',
        tags: [],
        origin: node.provenance.origin,
        keyContent: false,
        humanConfirmed: true,
        rev: node.rev,
      });
      continue;
    }
    if (node.type === 'listItem') {
      /* 一项列表画成一条：行首标记 + 那句话 + 夹在里面的那一个填写项。
         只取各类型的第一子节点（与表格格子同一取舍）：一项里塞两句话在临床上没有意义，
         而"把所有子节点拼成一句只读文本"会把填写项吞掉 —— 那才是真的数据丢失。  */
      const kids = kidsOf(node.id);
      const textNode = kids.find((child): child is Extract<DocNode, { type: 'text' }> => child.type === 'text');
      const fieldNode = kids.find((child): child is Extract<DocNode, { type: 'field' }> => child.type === 'field');
      const decorated = textNode ? decoratedRunsOf(textNode) : undefined;
      items.push({
        kind: 'listItem',
        id: node.id,
        marker: listInfo.marker.get(node.id) ?? '· ',
        ...(textNode
          ? { text: textOf(textNode), textId: textNode.id, ...(decorated ? { runs: decorated } : {}) }
          : {}),
        ...(fieldNode
          ? {
            fieldId: fieldNode.id,
            /* 格子的名字不是必填的：列表项那一行的文字往往已经说清"这是体温"
               （"体温 ____ ℃"），再挂一个兜底名"字段"只会让医生看见两个标签。  */
            ...(fieldNode.tags?.[0]?.display || fieldNode.sourceKey
              ? { label: fieldNode.tags?.[0]?.display ?? fieldNode.sourceKey }
              : {}),
            value: fieldNode.valueText ?? String(fieldNode.value ?? ''),
            ...(fieldNode.unit ? { unit: fieldNode.unit } : {}),
          }
          : {}),
        tags: textNode?.tags ?? fieldNode?.tags ?? [],
        origin: node.provenance.origin,
        ...(templateRefOf(node) ? { templateRef: templateRefOf(node) } : {}),
        keyContent: node.keyContent === true,
        humanConfirmed: node.humanConfirmed === true,
        rev: node.rev,
      });
      continue;
    }
    if (node.type === 'text') {
      const decorated = decoratedRunsOf(node);
      items.push({
        kind: 'text',
        id: node.id,
        text: textOf(node),
        ...(node.parentId ? { paragraphId: node.parentId } : {}),
        ...(decorated ? { runs: decorated } : {}),
        tags: node.tags ?? [],
        origin: node.provenance.origin,
        ...(templateRefOf(node) ? { templateRef: templateRefOf(node) } : {}),
        ...(node.provenance.modelId ? { modelId: node.provenance.modelId } : {}),
        ...(typeof node.provenance.confidence === 'number' ? { confidence: node.provenance.confidence } : {}),
        ...(node.provenance.acceptedBy ? { acceptedBy: node.provenance.acceptedBy } : {}),
        keyContent: node.keyContent === true,
        humanConfirmed: node.humanConfirmed === true,
        /* 机器绑上、待人确认的标签：界面据此显示"标签待确认"，医生点确认后它消失 */
        ...((node.unconfirmedTags ?? []).length > 0 ? { unconfirmedTags: node.unconfirmedTags } : {}),
        rev: node.rev,
      });
      continue;
    }
    if (node.type === 'control') {
      const controlName = (node.provenance.evidence ?? []).find((evidence) => evidence.field === 'control')?.valueText;
      items.push({
        kind: 'control',
        id: node.id,
        label: controlName ?? node.definitionId ?? '专科控件',
        shape: node.shape,
        controlKind: node.controlKind,
        cells: controlCellsOf(node).map((cell) => ({
          key: cell.key,
          label: cell.label,
          dataType: cell.dataType,
          ...(cell.unit ? { unit: cell.unit } : {}),
          ...(cell.valueSet ? { valueSet: cell.valueSet } : {}),
          ...(cell.required ? { required: true } : {}),
          ...(cell.row !== undefined ? { row: cell.row } : {}),
          ...(cell.rowKey ? { rowKey: cell.rowKey, rowLabel: cell.rowLabel ?? cell.rowKey } : {}),
          ...(cell.columnKey ? { columnKey: cell.columnKey, columnLabel: cell.columnLabel ?? cell.columnKey } : {}),
          value: node.payload[cell.key] === undefined || node.payload[cell.key] === null
            ? ''
            : String(node.payload[cell.key]),
        })),
        tags: [],
        origin: node.provenance.origin,
        ...(templateRefOf(node) ? { templateRef: templateRefOf(node) } : {}),
        keyContent: node.keyContent === true,
        humanConfirmed: node.humanConfirmed === true,
        rev: node.rev,
      });
      continue;
    }
    if (node.type === 'image') {
      /* 图挂在段落里（`parentId` 就是那个段落），所以带 `paragraphId`：
         流式视图要靠它把图放回"这句话后面"的位置。少了它，图会全被挪到篇末，
         而"图紧跟哪句话"恰恰是检查报告里最要紧的信息之一。  */
      items.push({
        kind: 'image',
        id: node.id,
        ...(node.parentId ? { paragraphId: node.parentId } : {}),
        resRef: node.resRef,
        ...(node.altText ? { altText: node.altText } : {}),
        ...(node.caption ? { caption: node.caption } : {}),
        tags: node.tags ?? [],
        origin: node.provenance.origin,
        keyContent: node.keyContent === true,
        humanConfirmed: node.humanConfirmed === true,
        rev: node.rev,
      });
      continue;
    }
    if (node.type === 'field') {
      items.push({
        kind: 'field',
        id: node.id,
        ...(node.parentId ? { paragraphId: node.parentId } : {}),
        label: node.tags?.[0]?.display ?? node.sourceKey ?? '字段',
        value: node.valueText ?? String(node.value ?? ''),
        ...(node.unit ? { unit: node.unit } : {}),
        tags: node.tags ?? [],
        origin: node.provenance.origin,
        ...(templateRefOf(node) ? { templateRef: templateRefOf(node) } : {}),
        /* 从系统带入的那一格：把"从哪儿带进来的"给人话名称（界面据此显示"系统带入（患者姓名）"） */
        ...(fromRefOf(node) ? { fromRef: fromRefOf(node), fromLabel: contextLabelOf(String(fromRefOf(node))) } : {}),
        ...(typeof node.provenance.confidence === 'number' ? { confidence: node.provenance.confidence } : {}),
        keyContent: node.keyContent === true,
        humanConfirmed: node.humanConfirmed === true,
        rev: node.rev,
      });
    }
  }
  return items.map((item) => (item.kind === 'section' ? item : { ...item, ...paragraphPositionOf(doc, item.id) }));
}

/**
 * 内容节点所属的段落（文本/字段挂在段落下面）。
 *
 * 段落级操作（插入 / 上移下移 / 删除）的操作单位是段落而不是文本节点：
 * 只删文本会在结构里留下一个空段落，只移文本会把它的字段落下。
 * 已经是段落或章节的节点原样返回。
 */
function contentOwnerOf(session: WriteSession, nodeId: string): DocNode | undefined {
  const node = session.document.nodes[nodeId];
  if (!node) return undefined;
  if (node.type === 'text' || node.type === 'field') {
    const parent = node.parentId ? session.document.nodes[node.parentId] : undefined;
    return parent?.type === 'paragraph' ? parent : node;
  }
  return node;
}

/** 章节的人话名（标题优先，退回编码，再退回 id）—— 界面要能说清"放到了「现病史」" */
function sectionLabelOf(session: WriteSession, sectionId: string): string {
  const node = session.document.nodes[sectionId];
  if (!node || node.type !== 'section') return sectionId;
  return node.title ?? node.sectionCode ?? sectionId;
}

/** 下一段该用哪个 order：取"紧跟在后面的兄弟"与自己的中间值（没有后面的兄弟则 +10） */
function nextOrderAfter(session: WriteSession, parentId: NodeId, order: number): number {
  let next = Number.POSITIVE_INFINITY;
  for (const child of session.indexes.childrenOf(parentId)) {
    const value = session.document.nodes[child]?.order ?? 0;
    if (value > order && value < next) next = value;
  }
  return Number.isFinite(next) ? (order + next) / 2 : order + 10;
}

function orderForMove(
  session: WriteSession,
  parentId: NodeId,
  current: number,
  direction: 'up' | 'down',
): number | null {
  const orders = session.indexes
    .childrenOf(parentId)
    .map((id) => session.document.nodes[id]?.order ?? 0)
    .sort((a, b) => a - b);
  if (direction === 'up') {
    const previous = [...orders].reverse().find((value) => value < current);
    if (previous === undefined) return null;
    const beforePrevious = [...orders].reverse().find((value) => value < previous);
    return beforePrevious === undefined ? previous - 10 : (beforePrevious + previous) / 2;
  }
  const next = orders.find((value) => value > current);
  if (next === undefined) return null;
  const afterNext = orders.find((value) => value > next);
  return afterNext === undefined ? next + 10 : (next + afterNext) / 2;
}

function applyFlowOp(
  kind: string,
  op: Record<string, unknown>,
  ctx: { entry: DocEntry; actor: Actor; lastCreated: NodeId | null },
): { ok: true; data: Record<string, unknown> } | { ok: false; code: string; message: string } {
  const session = ctx.entry.session;
  const nodeId = typeof op.nodeId === 'string' ? op.nodeId : '';

  if (kind === 'edit') {
    const node = session.document.nodes[nodeId];
    if (!node || node.type !== 'text') {
      return { ok: false, code: 'E_TYPE_MISMATCH', message: `节点 ${nodeId} 不是文本节点` };
    }
    const span = minimalEditSpan(textOf(node), String(op.text ?? ''));
    /* 没变就整条不发：点进点出、或者把字打错又改回来，都不该留痕（更不该触发"编辑即确认"） */
    if (!span) return { ok: true, data: { skipped: true } };
    session.replaceRange({ nodeId, start: span.start, end: span.end, payload: { text: span.text } }, ctx.actor);
    return { ok: true, data: { span } };
  }

  if (kind === 'runs') {
    const node = session.document.nodes[nodeId];
    if (!node || node.type !== 'text') {
      return { ok: false, code: 'E_TYPE_MISMATCH', message: `节点 ${nodeId} 不是文本节点` };
    }
    if (!Array.isArray(op.runs)) {
      return { ok: false, code: 'E_TYPE_MISMATCH', message: 'runs 必须是数组' };
    }
    const current = textOf(node);
    session.replaceRange({ nodeId, start: 0, end: current.length, payload: { runs: op.runs as TextRun[] } }, ctx.actor);
    return { ok: true, data: {} };
  }

  if (kind === 'insert') {
    const origin = String(op.origin ?? 'human');
    /* 原则 1（AI 不得直接写）不能因为多了一个批量入口就出现旁路 */
    if (origin === 'ai') {
      return {
        ok: false,
        code: 'E_AI_DIRECT_WRITE_FORBIDDEN',
        message: 'AI 内容不得经此入口落笔（必须走建议通道并由人采纳）',
      };
    }
    if (origin !== 'human' && origin !== 'imported') {
      return { ok: false, code: 'E_TYPE_MISMATCH', message: `不支持的来源标记：${origin}` };
    }
    const afterNodeId = typeof op.afterNodeId === 'string' && op.afterNodeId !== '' ? op.afterNodeId : '';
    const anchor = afterNodeId !== ''
      ? contentOwnerOf(session, afterNodeId)
      : (ctx.lastCreated ? session.document.nodes[ctx.lastCreated] : undefined);
    const sectionId = anchor?.parentId ?? null;
    if (!anchor || !sectionId) {
      return { ok: false, code: 'E_NODE_NOT_FOUND', message: `找不到 ${afterNodeId || '（本批新建的上一段）'} 所属的段落/章节` };
    }
    const order = nextOrderAfter(session, sectionId, anchor.order);
    const paragraph = session.createNode({ parentId: sectionId, type: 'paragraph', order }, ctx.actor);
    const paragraphId = paragraph.targetId as NodeId;
    const textNode = session.createNode(
      {
        parentId: paragraphId,
        type: 'text',
        props: {
          runs: [{ text: String(op.text ?? '') }],
          /* 外来内容（粘贴）如实标 `imported` 且未确认：剪贴板不提供来源，
             而"未核对的外部内容进了签名"是不可接受的失败方向。
             与 `/api/paste-text` 的口径完全一致 —— 同一件事不能因为走了哪个入口而标记不同。 */
          ...(origin === 'imported'
            ? {
                provenance: { origin: 'imported' as const, actorId: ctx.actor.id, at: new Date().toISOString() },
                humanConfirmed: false,
              }
            : {}),
        } as Partial<DocNode>,
      },
      ctx.actor,
    );
    return { ok: true, data: { paragraphId, textNodeId: textNode.targetId as NodeId } };
  }

  if (kind === 'delete') {
    const target = contentOwnerOf(session, nodeId);
    if (!target || !target.parentId) {
      return { ok: false, code: 'E_NODE_NOT_FOUND', message: `找不到 ${nodeId} 所属的段落` };
    }
    /* 删除单位是段落（只删文本会在结构里留下看不见的空段落），
       关键内容禁删由内核查整棵子树 —— 这里不做二次判断，两处各判一套必然分叉 */
    session.deleteNode({ nodeId: target.id, mode: 'subtree' }, ctx.actor);
    return { ok: true, data: {} };
  }

  return { ok: false, code: 'E_UNKNOWN_OP', message: `不认识的流式操作：${kind || '（空）'}` };
}

/** 段落在其所属章节里的位置（界面据此决定"上移/下移"能不能点） */
function paragraphPositionOf(doc: DocumentModel, nodeId: NodeId): { paragraphFirst: boolean; paragraphLast: boolean } {
  const paragraphId = doc.nodes[nodeId]?.parentId;
  const paragraph = paragraphId ? doc.nodes[paragraphId] : undefined;
  const sectionId = paragraph?.parentId;
  if (!paragraph || !sectionId) return { paragraphFirst: true, paragraphLast: true };
  const siblings = Object.values(doc.nodes).filter((node) => node.parentId === sectionId && node.type === 'paragraph');
  if (siblings.length <= 1) return { paragraphFirst: true, paragraphLast: true };
  const orders = siblings.map((node) => node.order);
  return { paragraphFirst: paragraph.order <= Math.min(...orders), paragraphLast: paragraph.order >= Math.max(...orders) };
}

/**
 * 章节摘要：标出该章节子树内是否还有未确认的关键内容。
 * 注意必须遍历整棵子树：关键内容节点通常是"章节 → 段落 → 文本"的孙节点，
 * 只看直接子节点会永远显示为已确认（这是实测踩出来的坑）。
 *
 * 顺序按文档层级深度优先（父章节紧跟其子章节），并给出 depth 供界面缩进：
 * WS/T 500 这类结构化文档天然带嵌套章节，若按 order 扁平排序，
 * 子章节会跑到父章节前面（实测："诊断明细"排到了"初步诊断"之前），看起来像章节乱了。
 */
function blocksSigning(node: DocNode): boolean {
  if ((node.unconfirmedTags ?? []).length > 0) return true;
  if (node.humanConfirmed === true) return false;
  if (node.keyContent === true) return true;
  if (node.provenance?.origin === 'ai') return true;
  if (node.provenance?.origin === 'imported' && (node.type === 'text' || node.type === 'field')) return true;
  return false;
}

function modeOf(promptId: string | undefined): string {
  if (!promptId) return 'unknown';
  if (promptId.startsWith('dictation:')) return 'voice';
  if (promptId.startsWith('consistency:')) return 'consistency';
  const matched = /^demo-(complete|draft|polish)$/.exec(promptId);
  return matched ? (matched[1] as string) : 'other';
}

/**
 * 章节摘要（左栏导航的那一行）。
 *
 * `requiredEmpty` = 必备章节还没有内容。它不进签章门控 —— 口径见
 * `template/types.ts` 的 `TemplateSection.required`：必备管"这一章在不在"，
 * 不管"写得够不够"（刚开出来的草稿必然还是空的，把它算成"不能签"会让门控变成噪声）。
 * 但必须看得见：否则"这一章是必备的"这句话在医生面前从头到尾不出现。
  */
interface SectionSummaryItem {
  id: string;
  title: string;
  sectionCode: string;
  keyContent: boolean;
  hasUnconfirmed: boolean;
  depth: number;
  required: boolean;
  requiredEmpty: boolean;
  /**
   * 章节说明（模板里写的"这一章要写清什么"）。
   *
   * 它不来自文档，而是每次现查当前那一份模板 —— 因为它是提示，不是病历内容：
   * 提示的权威版本永远是"现在这份模板怎么说的"。这一点与 `required` / `keyContent`
   * 刚好相反（那两个在开文书那一刻就抄进文档、之后与模板再无联系）：责任与结构不能事后被改，
   * 而"该写清什么"改了就该立刻照新的写。
    */
  description?: string;
}

function sectionHintsOf(doc: DocumentModel): Map<string, string> {
  const hints = new Map<string, string>();
  const sectionNode = Object.values(doc.nodes).find((node) => node.type === 'section');
  const ref = sectionNode?.provenance?.evidence?.find((one) => one.kind === 'template')?.ref ?? '';
  const itemId = ref.split('#')[1]?.split('@')[0] ?? '';
  if (itemId === '') return hints;
  const found = findTemplate(packRegistry, itemId);
  for (const section of found?.definition.sections ?? []) {
    if (typeof section.description === 'string' && section.description !== '') {
      hints.set(section.sectionCode, section.description);
    }
  }
  return hints;
}

function sectionSummary(doc: DocumentModel, hints: Map<string, string> = new Map()): SectionSummaryItem[] {
  const childrenOf = new Map<string, DocNode[]>();
  for (const node of Object.values(doc.nodes)) {
    const key = node.parentId ?? '';
    const bucket = childrenOf.get(key);
    if (bucket) bucket.push(node);
    else childrenOf.set(key, [node]);
  }
  const subtree = (id: string): DocNode[] => {
    const out: DocNode[] = [];
    const stack = [...(childrenOf.get(id) ?? [])];
    while (stack.length > 0) {
      const node = stack.pop() as DocNode;
      out.push(node);
      stack.push(...(childrenOf.get(node.id) ?? []));
    }
    return out;
  };
  const out: SectionSummaryItem[] = [];
  const walk = (parentId: string, depth: number): void => {
    const children = (childrenOf.get(parentId) ?? []).filter((node) => node.type === 'section').sort((a, b) => a.order - b.order);
    for (const node of children) {
      const inner = subtree(node.id);
      /* "这一章有没有内容"只看承载内容的节点（text/field）：段落、嵌套章节一个都不算 ——
         看结构的话，一个空章节会因为"里面有个段落"而显得像写了东西。  */
      const hasContent = inner.some((item) => {
        if (item.type === 'text') return (item.runs ?? []).some((run) => run.text.trim() !== '');
        if (item.type === 'field') return item.value !== null && item.value !== undefined && item.value !== '';
        return false;
      });
      const sectionCode = node.sectionCode ?? '';
      const description = hints.get(sectionCode);
      out.push({
        id: node.id,
        title: node.title ?? '',
        sectionCode,
        ...(description === undefined ? {} : { description }),
        keyContent: node.keyContent === true,
        /* 统一判定（含关键内容 / AI / 导入内容）：原先只统计关键内容，
           左栏会显示"没有待确认"，而点签章却被拒，那是最让人失去信任的一类不一致 */
        hasUnconfirmed: blocksSigning(node) || inner.some(blocksSigning),
        depth,
        required: node.required === true,
        requiredEmpty: node.required === true && !hasContent,
      });
      walk(node.id, depth + 1);
    }
  };
  walk(doc.rootId, 0);
  return out;
}

function controlLookupAcrossPacks(): (controlId: string) => ExpressionDefinition | ControlDefinition | undefined {
  return (controlId) => {
    for (const summary of packRegistry.list('template')) {
      const pack = packRegistry.get(summary.packId) as TemplatePack | undefined;
      const found = pack?.items.find(
        (item) => (item.itemType === 'expression' || item.itemType === 'control') && item.itemId === controlId,
      );
      if (found) return found as ExpressionDefinition | ControlDefinition;
    }
    return undefined;
  };
}

/** 病历树：患者 → 就诊 → 病历（附状态徽标）；活动病历额外展开章节叶子 */
function buildTree(): unknown[] {
  if (!state.workspace) return [];
  const { loaded } = departmentsSafe();
  return state.workspace.patients.map((patient) => ({
    patientId: patient.patientId,
    nameMasked: patient.nameMasked,
    gender: patient.gender,
    age: patient.age,
    visits: patient.visits.map((visit) => ({
      visitId: visit.visitId,
      visitType: visit.visitType,
      dept: departmentNameOf(loaded, visit.dept) ?? visit.dept,
      deptCode: visit.dept,
      date: visit.date,
      docs: visit.docs.map((doc) => {
        const entry = state.entries.get(doc.docId);
        const session = entry?.session;
        const status = session?.machineReadableStatus();
        const docModel = session?.document;
        /* 与内核签章门控同一口径（blocksSigning）：原先只数关键内容，
           导致左栏"待确认 0"但签章被拒 */
        const unconfirmed = docModel ? Object.values(docModel.nodes).filter(blocksSigning).length : 0;
        const pending = session ? session.listSuggestions({ status: 'pending' }).length : 0;
        return {
          docId: doc.docId,
          title: doc.title,
          kind: doc.kind,
          docType: docModel?.docType.display ?? doc.title,
          status: docModel?.status ?? 'draft',
          rev: session?.docRev ?? 0,
          machineStale: status?.stale ?? true,
          machineCount: docModel?.machineReadable?.dataElements.length ?? 0,
          unconfirmed,
          pending,
          active: doc.docId === state.activeDocId,
          sections:
            doc.docId === state.activeDocId && docModel
              ? sectionSummary(docModel, sectionHintsOf(docModel))
              : [],
        };
      }),
    })),
  }));
}

/**
 * 落位候选节点（供语音页签让医生为每段指定落点）。
 *
 * 与落位策略共用同一套候选集（`collectCandidates`），否则会出现
 * "界面能选、策略/内核不认"的错位，而那类问题只在点下去的一刻才暴露。
 * 条数设上限：`state` 是每个请求都下发的，把几百个节点全带上会让所有接口一起变慢。
 */
function placementCandidatesOf(session: WriteSession, limit = 200): Array<{ nodeId: string; label: string }> {
  const doc = session.document;
  return collectCandidates(session.indexes, placementConfigNow().config).nodeIds.slice(0, limit).map((nodeId) => {
    const node = doc.nodes[nodeId];
    const text = node && node.type === 'text' ? node.runs.map((run) => run.text).join('').trim() : '';
    return { nodeId, label: text === '' ? nodeId : `${text.slice(0, 14)}${text.length > 14 ? '…' : ''}` };
  });
}

/**
 * 把请求里的"数据元标签"解析成内核认的标签（合法则返回，否则 `null`）。
 *
 * 与配置层（`validatePlacementConfig` 里 structureMap 的校验）用同一份清单（`TAG_SYSTEMS`）：
 * 两处各写一份，就会出现"配置存得进去、采纳时却被拒"或反过来的分歧，
 * 而那种分歧只有医生点到那一条时才会暴露。
  */
function dataElementTagOf(value: unknown): DataElementTag | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const tag = value as { system?: unknown; code?: unknown; display?: unknown };
  if (typeof tag.system !== 'string' || !(TAG_SYSTEMS as readonly string[]).includes(tag.system)) return null;
  if (typeof tag.code !== 'string' || tag.code.trim() === '') return null;
  if (tag.display !== undefined && (typeof tag.display !== 'string' || tag.display.trim() === '')) return null;
  return {
    system: tag.system as DataElementTag['system'],
    code: tag.code.trim(),
    ...(tag.display === undefined ? {} : { display: (tag.display as string).trim() }),
  };
}

/** 数据元标签的"同一性"：体系 + 编码（显示名可以不同，那两个是不同的数据元） */
function sameDataElement(a: DataElementTag, b: DataElementTag): boolean {
  return a.system === b.system && a.code === b.code;
}

const DOCTOR_HIDDEN_STATE_KEYS = [
  'templateCatalog', 'contextFields', 'expressionFunctions', 'departments', 'docTypes',
  'expressionControls', 'database', 'invariants',
  'placement', 'signBackend',
  /* `activeDocId` 曾经也在这一列里，被用例挡了回来（B1 断言"默认打开第一份病历"，
     它读到 undefined）。这条纠正值得留在这里：`activeDocId` 是工作区当前打开哪份
     文书，属共用口径 —— 医生端只是恰好从 `doc.docId` 读它，不代表它不是医生端的事。
     投影表的判据是"这一格是谁的事"，不是"今天有没有人读它"。  */
] as const;

/**
 * 响应体里的状态：按调用者身份给投影。
 *
 * 判据只有一条：这个身份能不能读部署参数（`config.read`：管理员与质控员可以）。
 * "你看见什么取决于你是谁"与本仓库 `authorize()` 的取舍一致；不按路由判，是因为
 * `/api/reset`（管理端权限、医生端触发）这类路由会立刻把按路由判的口径打破。
  */
function stateFor(req: IncomingMessage): Record<string, unknown> {
  const resolved = resolvePrincipal(req);
  const admin = resolved.ok && can(resolved.principal.role, 'config.read');
  return buildState(admin ? 'admin' : 'doctor');
}

function buildState(scope: 'doctor' | 'admin' = 'doctor'): Record<string, unknown> {
  const wantAdmin = scope === 'admin';
  const entry = current();
  /* 打开页面（GET /api/state）不经过 act，这里也必须触发恢复，
     否则"重启后第一次看到的是空列表"，而磁盘上明明有数据 */
  ensureRestored(entry as DocEntry & { restored?: boolean });
  const session = entry.session;
  const doc = session.document;
  const status = session.machineReadableStatus();
  const block = doc.machineReadable;
  const metrics = session.getMetrics();
  const visit = state.workspace?.patients
    .flatMap((patient) => patient.visits.map((item) => ({ patient, visit: item })))
    .find((item) => item.visit.docs.some((candidate) => candidate.docId === doc.docId));
  /* 科室字典读一次，整份状态共用：模板上的科室要显示名称、就诊科室要显示名称、
     模板名单要按科室过滤 —— 三处各自读一次库既慢又可能出现"同一次响应里两个口径"。 */
  const departments = departmentsSafe();
  /* 文书类型同理读一次：「新建文书」的类型下拉要用它，模板列表将来也要显示类型名 */
  const docTypes = docTypesSafe();
  /* 四个配置视图各算一次：同一个字段在一次响应里出现两个口径，是"同一份配置读两遍"
     最常见的后果。管理端拿全量，医生端只拿其中的可用性（见下面各字段处的说明）。  */
  const modelView = describeModelConfig(modelConfigNow());
  const captureView = describeCaptureConfig(captureConfigNow());
  const signView = describeSignConfig(signConfigNow());
  const readingView = describeReadingAuthority(readingAuthorityNow());
  const placementView = describePlacementConfig(placementConfigNow());
  /* 预问诊接入视图：解不开时给 `error` 而不是伪装成"未配置"——
     前者要排查数据，后者什么都不用做，两件事不能长得一样。 */
  let previsitAccessView: unknown = null;
  try {
    previsitAccessView = describeAccess(loadAccess(CONFIG_KV), AUTH_MODE);
  } catch (err) {
    previsitAccessView = { error: (err as Error).message };
  }

  const full: Record<string, unknown> = {
    activeDocId: doc.docId,
    patient: {
      patientId: doc.patient.patientId,
      nameMasked: doc.patient.nameMasked ?? '',
      gender: doc.patient.gender ?? 'U',
      birthDate: doc.patient.birthDate ?? '',
      age: visit?.patient.age ?? null,
    },
    encounter: {
      visitId: doc.encounter?.visitId ?? '',
      visitType: doc.encounter?.visitType ?? '',
      /* 就诊科室：编码给判定、名称给人看。
         这里要归一：字典上线前病历里存的可能是名称（"呼吸内科"），而那些病历
         不会因为写法改了就被回写（改病历要留 rev 与审计）。归一只发生在读取时。
         字典里查不到的值按原样给：不拿别的名称顶上 —— "字典里没这个科室"必须看得见。  */
      dept: normalizeDepartmentCode(departments.loaded, doc.encounter?.deptCode) ?? '',
      deptName: departmentNameOf(departments.loaded, normalizeDepartmentCode(departments.loaded, doc.encounter?.deptCode))
        ?? doc.encounter?.deptCode
        ?? '',
      admittedAt: doc.encounter?.admittedAt ?? '',
      visitDate: visit?.visit.date ?? '',
      /* 出院汇总能不能用：判据只在服务端算一次，前端不复制"什么算住院"这套规则。
         非住院时界面直接不摆这一栏 —— 摆一个永远算不出来的入口，等于让人点进去再被拒一次。 */
      dischargeSummaryAvailable: dischargeSummaryApplicability({
        visitType: doc.encounter?.visitType ?? '',
        imported: String(doc.encounter?.visitId ?? '').startsWith('V_IMPORT_'),
      }).applicable,
    },
    /* 预问诊（患者候诊时自填）：只下发"有没有、几条、每条有没有落点"。
       原文不进 state 的理由不是省流量，而是口径：state 只装"当前这一屏要渲染的东西"；
       而且预问诊不属于这份文书，把它挂进文书的 state 会让人以为它已经是病历的一部分。  */
    previsit: (() => {
      const read = previsitOfPatient(doc.patient.patientId);
      if (!read.ok) return { ok: false, code: read.code, message: read.message, record: null, items: [] };
      const record = read.record;
      if (!record) return { ok: true, record: null, items: [], readAt: read.readAt, cached: read.cached };
      const anchors = sectionAnchorsOf(doc);
      return {
        ok: true,
        /* `readAt` / `cached` 如实下发：界面上"读取于 16:33"是可核对的事实，
           而不是"看起来是最新的"。 */
        readAt: read.readAt,
        cached: read.cached,
        record: { submittedAt: record.submittedAt, source: record.source, visitId: record.visitId ?? '' },
        items: record.items.map((item) => {
          const sectionCode = PREVISIT_SECTION[item.key] ?? '';
          const anchor = anchors.find((candidate) => candidate.code === sectionCode);
          return {
            key: item.key,
            label: item.label,
            text: item.text,
            reportedAt: item.reportedAt,
            sectionCode,
            /* 提前算好"有没有落点"：让医生在点之前就知道哪条落不下去，
               而不是点了之后收到一句"3 条未生成" */
            hasTarget: sectionCode !== '' && (anchor?.nodeId ?? null) !== null,
          };
        }),
      };
    })(),
    doc: {
      docId: doc.docId,
      docType: doc.docType.display,
      status: doc.status,
      rev: session.docRev,
      updatedAt: doc.updatedAt,
      createdBy: doc.createdBy,
    },
    tree: buildTree(),
    thresholds: THRESHOLDS,
    items: buildItems(session),
    suggestions: session.listSuggestions().map((suggestion) => ({
      id: suggestion.id,
      targetNodeId: suggestion.targetNodeId,
      text: suggestion.text,
      confidence: suggestion.confidence,
      modelId: suggestion.modelId,
      promptId: suggestion.promptId ?? null,
      /* 产出方式：界面据此标注"这条建议是怎么来的"（续写 / 草稿 / 润色 / 语音） */
      mode: modeOf(suggestion.promptId),
      status: suggestion.status,
      modified: suggestion.modified === true,
      editRatio: suggestion.editRatio ?? null,
      editBand: suggestion.editRatio === undefined ? null : editBandOf(suggestion.editRatio),
      threshold: session.document.nodes[suggestion.targetNodeId]?.keyContent === true ? THRESHOLDS.key : THRESHOLDS.general,
      keyContent: session.document.nodes[suggestion.targetNodeId]?.keyContent === true,
    })),
    /* 旁挂注解：不是文档内容（不改 rev、不进文档留痕），单独下发。
       `anchorState` 是查询时派生的（节点被删改后即时反映），不是存储字段。 */
    annotations: session.listAnnotations().map((item) => ({
      id: item.id,
      nodeId: item.anchor.nodeId,
      kind: item.kind,
      severity: item.severity,
      title: item.title,
      detail: item.detail ?? null,
      suggestion: item.suggestion ?? null,
      status: item.status,
      anchorState: item.anchorState,
      ruleId: item.source.ruleId ?? null,
      modelId: item.source.modelId ?? null,
      createdAt: item.createdAt,
    })),
    annotationCounts: session.annotationCounts(),
    formRules: listFormRules(rulesFromRegistry(packRegistry, conditionLibrary())),
    /* 知识资产包：载的是哪一版（内容指纹）、实际生效的是什么（生效指纹）。
       两个指纹分开报，否则"换了包"与"只是关了条规则"在界面上长得一样。
       它不进文档、不进签名：与任何一份病历无关，是部署参数。 */
    knowledgePacks: {
      packs: packRegistry.list(),
      rules: qcRuleCatalog(),
      /* 本院自建包：界面上新建的规则与判定方式都落这一份（`addRule` 的 `?? customRulePackBase()`）。
         界面需要它才能回答"这条规则能引用哪几条判定方式" —— 引用只在本包内解析，
         而下拉必须只列本包的那几条，否则会摆出一堆"选了存不下"的选项。
         由服务端下发（界面不写死包 id：那是部署事实，不是界面约定）。  */
      customPackId: CUSTOM_RULE_PACK_ID,
      contentFingerprint: packRegistry.contentFingerprint(),
      effectiveFingerprint: packRegistry.effectiveFingerprint(),
      /* 落库现状：载的是库里的哪一份内容、还是压根没有包，这一格不显示，
         "包有没有真的落库"就只能靠猜；而"空库"更必须显示（它会以"质控跑了但 0 命中"的形式误导）。 */
      store: {
        tables: packStoreReport?.tables ?? [],
        source: packStoreReport?.source ?? null,
        packs: packStoreReport?.packs ?? [],
        error: packStoreError,
      },
    },
    qcPredicates: qcPredicateCatalog(),
    /* 自定义条件（`field-condition`）的构造器规格：可用的字段、算子与取值形态。
       与 `qcPredicates` 同一条纪律 —— 前端不手抄一份字段表或算子表，
       抄来的那份与内核不一致时，表现是"界面能拼、引擎不认"，而它只会在有人真的点了它的时候才暴露。  */
    qcCondition: conditionCatalog(),
    /* 判定方式（具名条件）：哪几条、各自判什么、被哪几条规则引用（跨包）。
       引用面必须在保存前就摆在人面前 —— 改一条判定方式会让所有引用它的规则一起变，
       而"一起变"这件事只能在事后从规则的行为上被发现的话，它就成了一次静默改动。  */
    qcConditions: qcConditionCatalog(),
    /* 库那一侧的状态（库里有没有、最近谁改的）：界面据此说"空就是空"还是"读不出来" ——
       两件事长得一样、但一件要人去建、另一件要人去查。 */
    qcConditionLibrary: describeConditions(conditionState),
    qcPlugins: {
      root: QC_PLUGIN_ROOT,
      loaded: QC_PLUGIN_REPORT.loaded,
      failures: QC_PLUGIN_REPORT.failures,
      dirPresent: QC_PLUGIN_REPORT.dirPresent,
    },
    /* 模板体系（K4）：能开哪几种文书、有没有医学表达式控件。
       模板同样是部署参数（装在同一个注册表里）：换模板不改任何已有病历。 */
    templates: listTemplates(packRegistry, { deptCode: doc.encounter?.deptCode ?? '' }),
    expressionControls: listExpressionControls(packRegistry),
    /* 模板条目目录（含已停用的）：管理后台「模板」页据此管控哪份文书能开，
       与 `knowledgePacks.rules` 是同一口径 —— 只列启用中的话，"没装"与"被停用"分不开。  */
    templateCatalog: templateCatalogOf(packRegistry).map((item) => ({
      ...item,
      /* 科室同时给编码与名称：界面显示名称、保存传编码，两件事都不需要前端再查一次字典 */
      departmentNames: item.departments.map((code) => departmentNameOf(departments.loaded, code) ?? code),
    })),
    /* 章节片段的"能插哪几段"清单（只列启用中的：这是给"插进一份新文书"用的，
       与 `templateCatalog` 那份管控视图的分工一样 —— 管控要看得见被停用的，使用侧只看能用的）  */
    fragments: listFragments(packRegistry),
    /* 科室字典：模板配科室、就诊科室名的显示都靠它；`source: 'empty'` 要如实显示
       —— "还没建科室"与"建了但没有产科"在界面上必须长得不一样 */
    departments: { ...describeDepartments(departments.loaded), error: departments.error },
    /* 文书类型：「新建文书」的类型下拉读它（选项只来自这里，与科室下拉同一纪律）。
       医生端不读，已列进 `DOCTOR_HIDDEN_STATE_KEYS`（否则每次响应都白带一份）。 */
    docTypes: { ...describeDocTypes(docTypes.loaded), error: docTypes.error },
    /* 模板能"从系统带入"哪些字段：填写项取值路径的下拉与表达式构造器的 `ctx` 选项
       共用这一份（只有一处，三处各写一份中文名迟早对不上）  */
    contextFields: CONTEXT_FIELDS.map((field) => ({ path: field.path, label: field.label, group: field.group })),
    /* 表达式构造器的"积木"：封闭函数表（含参数个数与人话说明）。
       函数表在核心里只有一份，界面据此生成参数槽 —— 前端不再手抄一份函数清单，
       否则"界面能选、引擎不认"这类错误会一直潜伏到有人点了它 */
    expressionFunctions: Object.values(EXPR_FUNCTIONS).map((fn) => ({
      name: fn.name,
      minArgs: fn.minArgs,
      /* `Infinity` 过不了 JSON：变长参数报 `null`，界面据此显示"可加参数" */
      maxArgs: Number.isFinite(fn.maxArgs) ? fn.maxArgs : null,
      doc: fn.doc,
    })),
    /* 派生值字段数：界面据此决定「重算派生值」按钮出不出现，一份没有派生值的病历上
       摆一个按下去只会说"没有需要重算的"的按钮，属于噪声。 */
    derivedCount: Object.values(doc.nodes).filter((node) => node.type === 'field' && node.dataType === 'expression').length,
    /* 模型接入现状。
       管理端：全量（脱敏后的配置视图，密钥只报"是否就位"，见 ai/model-config.ts）。
       医生端：只留产出方 —— `modelId` 要写进留痕、`format` 决定显示"离线模板"
       还是"在线模型"，两者都属于"这条建议是谁产的"。服务地址与配置来源属部署参数：
       画在医生页面上没有任何用途，却扩大了暴露面（原实现就把 `endpoint` 打印在
       AI 助手面板的"产出方"那一行上）。  */
    model: wantAdmin
      ? modelView
      : { modelId: modelView.modelId, format: modelView.format },
    /* 落位接入现状（仅管理端）：策略、候选范围、规则表与上限  */
    placement: placementView,
    capture: wantAdmin
      ? captureView
      : {
        configured: captureView.configured,
        missing: captureView.missing,
        retainAudio: captureView.retainAudio,
        segment: captureView.segment,
      },
    /* 落位候选节点：语音页签据此为每段渲染"落点"下拉 */
    placementCandidates: placementCandidatesOf(session),
    /* 电子签名后端配置视图（仅管理端，不含密钥值）。
       与 `sign`（签名状态：算法/指纹/验签结论）区分：那个是"这份病历签了没有"，
       这个是"用谁来签"。医生端不需要它 —— 签章能不能用，由内核在按下那一刻判
       （`E_SIGN_NOT_CONFIGURED`），不靠前端预告。  */
    signBackend: signView,
    /* 预问诊接入（机对机密钥）：只给管理端。
       医生端不需要它 —— 密钥对不对得上与"看这份表单"无关，而"有没有配密钥"
       本身是攻击面信息（知道没配，就知道可以随便写）。  */
    previsitAccess: wantAdmin ? previsitAccessView : null,
    /* 受控阅读的授权源（demo 替身 / 院内平台公钥）。
       管理端：全量（授权源地址 / 公钥是否已配 / 期望指纹 / 配置来源）。
       医生端：`configured`（区分"未配置 = 拒绝一切凭据"与"配了但不匹配"，两者排查
       方向完全不同）+ `trustedFingerprints`（当前生效的信任集，核对凭据身份要用）。
       与 `reading`（授权清单与阅读记录）分开：那是"有哪些授权、读了什么"，这是"谁有权发授权"。  */
    readingAuthority: wantAdmin
      ? readingView
      : { configured: readingView.configured, trustedFingerprints: readingView.trustedFingerprints },
    /* 语音转写：只留"最近一次"用于界面复显；转写本身不是文档内容 */
    dictation: entry.lastDictation,
    /* 采集的过程（录音指示 / 计时 / 逐段进度）：演示采集由服务端驱动，过程只存在服务端  */
    captureRun: entry.lastCapture,
    /* 跨文书一致性：只留最近一次结果（纯函数可随时重算，但"生成待办"要引用同一批问题） */
    consistency: entry.lastConsistency,
    /* 就诊时间轴：与一致性检查同一处置 —— 只留"最近一次"，因为它是读出来的结论，
       重算只是再算一遍同一件事（数据没变结果不会变）  */
    visitTimeline: entry.lastVisitTimeline,
    visitCompare: entry.lastVisitCompare,
    /* 出院汇总：最近一次读出来的派生计划（含缺口）。界面据此渲染，生成建议时也按它提交 */
    dischargeSummary: entry.lastDischargeSummary,
    /* 组的派生视图：组不存状态，计数全由条状态推导（见 core/suggestions.ts 的 SuggestionGroup）。
       界面据此渲染"接受本组"，而组级采纳仍逐条过门控。 */
    groups: session.listSuggestionGroups().map((group) => ({
      groupId: group.groupId,
      traceId: group.traceId ?? null,
      total: group.total,
      pending: group.pending,
      accepted: group.accepted,
      rejected: group.rejected,
    })),
    metrics,
    /* 三级归因（原样 / 微改 / 大改）与 `metrics` 并列下发，界面不自己算：
       "改了多少"的口径只在内核一处（`editRatioOf`）——
       前端另算一份的表现是"同一份数据在两张报表上不一样"，而报表正是拿来比版本好坏的。
       它单独一栏而不是并进 `metrics`：两者回答不同问题（有没有被采纳 / 采纳后改了多少）。  */
    attribution: session.getSuggestionAttribution(),
    machine: {
      stale: status.stale,
      reasons: status.reasons,
      generatedAt: block?.generatedAt ?? null,
      sourceHash: block?.sourceHash ?? null,
      count: block?.dataElements.length ?? 0,
      /* 不截断：机读数据元全量下发（截断会让用户以为"机读信息不全"） */
      elements: (block?.dataElements ?? []).map((element) => ({
        code: element.tag.code,
        system: element.tag.system,
        display: element.tag.display ?? '',
        value: element.valueText ?? String(element.value ?? ''),
        unit: element.unit ?? '',
        origin: element.origin,
        confidence: element.confidence ?? null,
        nodeId: element.nodeId,
      })),
    },
    /* 留痕全量下发（新的在前）：留痕是审计证据，不能只给最近几条。
       `summary` 是给人看的一句话（"这一版改了什么"）—— 界面靠它做历史版本列表；
       它不是审计字段，改它不影响验签与验链（那是 hash/patch 的事）。 */
    audit: [...session.auditLog()].reverse().map((revision) => ({
      rev: revision.rev,
      op: revision.op,
      actorId: revision.actorId,
      at: revision.at,
      targetId: revision.targetId ?? null,
      patchOps: revision.patch?.length ?? 0,
      summary: summarizeRevision(revision),
      modelId: revision.modelId ?? null,
      confidence: revision.confidence ?? null,
    })),
    /* 导入件：把来源与核对提示一并给界面（导入内容必须让人看见"它从哪来、要核对什么"） */
    importSource: (doc.extensions?.['import.source'] ?? null) as Record<string, unknown> | null,
    /* 签名（T18）：算法/后端/公钥指纹 + 独立验签结论。
       界面必须同时看到这两件事，只显示"已签章"而看不到"验签是否通过"，
       等于把"文件可能被改过"藏起来。 */
    sign: session.signatureInfo(),
    signatureVerified: session.signatureInfo() ? session.verifySignature() : null,
    /* 签章状态（T19c）：必须单独下发，不能让界面从"验签失败"去反推。
       解锁后 `signatureRefs` 不删、`status` 回到 draft，于是 `signatureVerified.ok` 必然是 false，
       而"已被有理由的解锁作废"与"内容被篡改"在这个信号上完全同形。
       把内核的判定（含解锁理由与被作废的那次签章）下发，界面才有依据把两者分开呈现。 */
    signatureState: session.signatureState(),
    /* 门控日志全量下发（新的在前） */
    log: [...entry.log].reverse(),
    /* 最近一次扫描里"适用但判不了"的条目：界面必须在命中数旁边说出来 */
    qcUnevaluated: entry.lastQcUnevaluated,
    /* 内涵类质控现状：没接上就要看得见，否则"质控跑了 0 命中"会把"根本没跑"顶替掉 */
    qcContent: entry.lastContentQc,
    /* 最近一次 AI 调用"看了但没写"的清单与原因：与上面两个"没判"同一条纪律 ——
       "这次没提示"不能被读成"查过了没问题"，`null` = 还没调过（与"调过、无跳过"是两回事） */
    aiSilence: entry.lastAiSilence
      ? {
          ...entry.lastAiSilence,
          /* 档位的人话名由内核给（`AI_SILENCE_LABELS`）：界面自己编一份，
             就会出现"日志里叫'未说明'、界面上叫另一个名"这种两处口径 */
          skipped: entry.lastAiSilence.skipped.map((item) => ({ ...item, label: AI_SILENCE_LABELS[item.code] })),
        }
      : null,
    /* 工作数据落在哪个库、里面有多少条：让"数据在哪"是一句可以直接回答的话 */
    database: {
      file: DB_FILE,
      schemaVersion: STORAGE_SCHEMA_VERSION,
      appliedMigrations: STORAGE.applied,
      ...workStore.stats(),
    },
    /* 鉴权现状：下发，界面据此常驻显示"演示模式 / 严格模式"。
       演示模式不设防这件事必须到处都是可见的，靠谁去读源码才能知道，等于没说。 */
    auth: {
      mode: AUTH_MODE,
      ttlMinutes: SESSION_TTL_MINUTES,
      /* 账号来源（取代原先的 `tokens`）：口令的权威只有一处，数据库。
         未初始化这件事必须能被界面看见，否则"设备装好了但还没初始化"与"口令记错了"
         在现场是同一种表现。 */
      accounts: accountStatus(),
      note:
        AUTH_MODE === 'open'
          ? '演示模式：医生端写病历不鉴权（任何能访问本端口的人都能写入）。清空工作区例外：两种模式都要求管理员身份。 服务只监听回环地址；生产必须在管理后台「系统信息」里改成 strict（改完需重启）。'
          : '严格模式：医生端写操作也要求会话并判角色（登录入口在管理后台 /login）。',
      /* 破坏性动作在两种模式下都收口，单独一个字段。医生端已经不摆「重置」按钮了
         （那里没有登录入口，摆了就是个永远点不动的按钮），但这份清单照旧下发：
         "哪些动作在两种模式下都被收口"与"当前角色能不能做"是两件事
         （后者在 `/api/session.actions` 里），外部宿主界面与用例都按它判定。 */
      destructiveGuarded: ['workspace.reset'],
      loginEndpoint: '/api/session',
    },
    sidecar: {
      conflict: entry.sidecarConflict === true,
      persisted: entry.sidecarBaseline !== 'unknown' && entry.sidecarBaseline !== undefined,
    },
    /* 可撤销的最近一次写入（没有则为 null）：界面据此显示/禁用「撤销」并把目标写进 title */
    undo: session.undoTarget(),
    lastExport: entry.lastExport,
    lastWst500: entry.lastWst500,
    lastJson: entry.lastJson,
    /* 受控阅读：授权清单（含已读次数与撤销状态）+ 最近一次阅读视图。
       界面上只列属于当前这份文档的授权；全局索引仍保留全部（跨文档也能正确判"串档"）。 */
    reading: {
      /* 落库现状：授权登记重启后还在不在，是能被验证的事实，不该靠"我以为它会存"。
         `total` 直接问库（而不是数内存 Map）：两者不一致时，界面必须显示库里的数，
         否则"登记没写进去"会被内存里那份索引盖住 —— 那正是这条视图存在的意义。  */
      persistence: (() => {
        const counts = countReadingGrants(STORAGE.db);
        return { table: 'reading_grants', error: READING_GRANTS_ERROR, total: counts.total, revoked: counts.revoked };
      })(),
      grants: [...state.readingGrants.values()]
        .filter((record) => record.credential.grant.docId === doc.docId)
        .map((record) => ({
          grantId: record.credential.grant.grantId,
          purpose: record.credential.grant.purpose,
          notAfter: record.credential.grant.notAfter,
          maxReads: record.credential.grant.maxReads,
          readCount: record.readCount,
          revoked: record.revoked,
          environments: record.credential.grant.allowedEnvironments,
          sections: record.credential.grant.allowedSections,
          concealPatientIdentity: record.credential.grant.concealPatientIdentity,
          publicKeyFingerprint: record.credential.publicKeyFingerprint,
          /* 加密交付的授权在界面上要有独立标记：否则用户分不清"这份授权能不能解开密文" */
          encryptedDelivery: record.sealed !== undefined,
          ...(record.sealed ? { recipientSeed: record.sealed.recipientSeed, recipientLabel: record.sealed.recipientLabel } : {}),
        })),
      /* 文档内容指纹：授权平台签发授权时必须绑定它（"授权的是这一份内容"）。
         本系统不签发授权，所以这个值是要交给平台的输入，界面上必须能看到、能复制，
         否则对接无从谈起（平台不可能猜出这份文档的指纹）。 */
      documentFingerprint: documentFingerprint(session.document),
      lastView: entry.lastReadingView,
      lastViewSource: entry.lastReadingSource,
      reads: [...state.readingGrants.values()]
        .filter((record) => record.credential.grant.docId === doc.docId)
        .flatMap((record) => record.reads)
        .slice(-20),
    },
    /* 接收方公钥目录（只含公钥）：它是全局目录，不属于某份文档的阅读记录，因此放在顶层。
       界面据此让用户"选一个接收方"，而不是手抄种子。 */
    recipientKeys: {
      keys: state.recipientKeys.keys,
      error: state.recipientKeyStoreError ?? null,
    },
    /* 最近一次审计报告摘要（完整报告在卡片里给：state 不必背着整份报告） */
    lastAudit: entry.lastAudit,
    invariants: wantAdmin ? session.verifyInvariants() : null,
  };

  if (wantAdmin) return { ...full, scope: 'admin' };
  const projected: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(full)) {
    if (!(DOCTOR_HIDDEN_STATE_KEYS as readonly string[]).includes(key)) projected[key] = value;
  }
  return { ...projected, scope: 'doctor' };
}

/* ------------------- 旁挂数据的持久化（AI 建议 / 质控注解） ------------------- */

const CONFIG_FILES = new Set<string>([
  MODEL_CONFIG_FILE,
  MODEL_KEY_FILE,
  PLACEMENT_CONFIG_FILE,
  CAPTURE_CONFIG_FILE,
  SIGN_CONFIG_FILE,
  READING_AUTHORITY_FILE,
]);

const packRegistry = createEmptyPackRegistry();
const SAMPLE_PACK_DIR = join(ROOT, 'samples', 'packs');

/**
 * 读样例包目录。排序保证装载顺序确定（跨包冲突的报错内容才不会一次一个样）。
 *
 * 单个文件读不出来时跳过并把这个文件名打到 stderr：不能让一个坏文件挡住其余样例，
 * 但也不能一声不响，界面上只会显示"载入了 2 份"，静默跳过会被读成"样例全都载进来了"。
 */
function readSamplePacks(): unknown[] {
  if (!existsSync(SAMPLE_PACK_DIR)) return [];
  const packs: unknown[] = [];
  for (const name of readdirSync(SAMPLE_PACK_DIR).filter((item) => item.endsWith('.json')).sort()) {
    try {
      packs.push(JSON.parse(readFileSync(join(SAMPLE_PACK_DIR, name), 'utf8').replace(/^\uFEFF/, '')) as unknown);
    } catch (err) {
      console.error(`[知识资产包] 样例包无法解析，已跳过：${name}（${(err as Error).message}）`);
    }
  }
  return packs;
}

/**
 * 包存储目录与落盘结果。
 *
 * 启动顺序是"先出厂装配、再以磁盘为准"：`createDefaultPackRegistry()` 给出厂装配，
 * 随后 `openPackStore` 用磁盘内容替换它（首次运行时反过来，把出厂装配播种到磁盘）。
 *
 * 失败时回落到出厂装配并上报（不静默、也不让演示整体不可用）：
 * `openPackStore` 的契约是"失败 ⇒ 注册表保持打开前的状态"，所以这里什么都不用回滚。
 */
/* ------------------------------ 判定方式库（库级资产） ------------------------------

   判定方式不属于任何包：全院一份，存在 `config.qc-conditions`（`condition-store.ts`）。
   任何包的规则都能引用它，改一处、所有引用它的规则一起变 —— 这是它从"包内容"搬出来的原因
   （早先那个模型里，交付方包里的规则永远用不上具名判定方式）。

   读的顺序有讲究：必须在打开包存储之前。装包时校验规则引用，用的就是这份库
   （`packValidatorForWithConditions`）—— 反过来的话，第一次装载会按"库里一条判定方式都没有"
   判一遍，引用库里的规则会被误拒。  */

/** 库读不起来时它抛错、进程起不来：那比"当成空库继续"安全（后者会让引用它的规则集体悬空） */
let conditionState: LoadedConditions = loadConditions(CONFIG_KV);

/** 当前库里那几条。编译与目录都读它，不再各自 `load` 一遍（两处各读一次的漂移没人看得出来） */
function conditionLibrary(): ConditionLibrary {
  return conditionLibraryOf(conditionState.items);
}

/**
 * 包校验器：带上判定方式库。
 *
 * `packValidatorFor` 是纯函数（只看包自己），而规则可以引用库里任何一条 ——
 * 所以这里把它包一层，把"当前库"带进去。写包、装载、自测走的是同一个内核函数
 * （`validateRulePack`），差别只在这份表。
  */
function packValidatorForWithConditions(kind: PackKind): ((pack: Pack) => void) | undefined {
  const base = packValidatorFor(kind);
  if (!base || kind !== 'rule') return base;
  return (pack: Pack) => validateRulePack(pack as QcRulePack, conditionLibrary());
}

const packStoreOpen = openPackStore({
  registry: packRegistry,
  /* 与文书、旁挂数据同一个库：备份一次就带走这台机器的判定标准 */
  db: STORAGE.db,
  supported: SUPPORTED_PACK_ENGINE_APIS,
  validateFor: packValidatorForWithConditions,
});
/* 可变：载入包（`/api/knowledge-pack-load`）之后要换成新的报告 */
let packStoreReport: PackStoreReport | null = packStoreOpen.ok ? packStoreOpen.report : null;
const packStoreError: string | null = packStoreOpen.ok ? null : `${packStoreOpen.code}：${packStoreOpen.message}`;
if (packStoreError) {
  /* 没有任何"出厂装配"可以回落，装载失败就是一个包都没跑。
     这比"悄悄用内置内容顶上"诚实：后者会让质控看起来在跑，而跑的不是库里的那一份。 */
  console.error(`[知识资产包] 从数据库装载失败，注册表保持为空（当前没有任何规则/模板可用） → ${packStoreError}`);
} else {
  console.log(
    `[知识资产包] ${packStoreReport?.source === 'empty' ? '库里没有包（空就是空，不用任何内置内容顶上）' : '已从数据库装载'}：` +
      `${packStoreReport?.packs.map((pack) => `${pack.packId}（${pack.kind}·${pack.itemCount} 条）`).join('、') || '—'}（表 ${packStoreReport?.tables.join('/')}）`,
  );
  if (packStoreReport?.source === 'empty') {
    console.log('              → 包只有一条进来的路：`POST /api/knowledge-pack-load`（管理后台「质控」页有「载入示例包」按钮）。');
  }
}

function seedConditionsOnce(): void {
  if (conditionsSeeded(CONFIG_KV)) return;
  const present = new Set(conditionState.items.map((item) => String(item.itemId)));
  const missing = SEED_CONDITIONS.filter((item) => !present.has(String(item.itemId)));
  if (missing.length > 0) {
    try {
      conditionState = saveConditions(CONFIG_KV, [...conditionState.items, ...missing], 'demo-seed');
    } catch (err) {
      /* 失败就不落标记：下次启动会再试一次，而原因在这里看得见。
         反过来（先落标记再写库）会让一次失败变成"这几条永远不出现"，且没有任何痕迹。  */
      console.error(`[判定方式] 出厂种子未能写进判定方式库（下次启动会再试）：${(err as Error).message}`);
      return;
    }
  }
  markConditionsSeeded(CONFIG_KV);
  console.log(missing.length === 0
    ? '[判定方式] 库里已有出厂那几条 —— 这一格不再播'
    : `[判定方式] 已把 ${missing.length} 条出厂种子写进判定方式库（管理后台「基础数据 · 判定方式」可改可删；删掉后不会自己回来）`);
}

seedConditionsOnce();

function migratePackConditionsOnce(): void {
  if (CONFIG_KV.read<boolean>(CONDITION_MIGRATION_KEY) === true) return;
  const libraryIds = new Set(conditionState.items.map((item) => String(item.itemId)));
  let moved = 0;
  let dropped = 0;
  const summaries = [...packRegistry.list('rule')].sort((left, right) => left.packId.localeCompare(right.packId));
  for (const summary of summaries) {
    const pack = packRegistry.get(summary.packId) as QcRulePack | null;
    if (!pack) continue;
    const embedded = pack.items.filter(
      (item) => (item as { itemType?: unknown }).itemType === 'condition',
    ) as QcConditionDefinition[];
    if (embedded.length === 0) continue;
    const fresh: QcConditionDefinition[] = [];
    for (const item of embedded) {
      const itemId = String(item.itemId);
      if (libraryIds.has(itemId)) { dropped += 1; continue; }
      fresh.push(item);
      libraryIds.add(itemId);
    }
    if (fresh.length > 0) {
      try {
        conditionState = saveConditions(CONFIG_KV, [...conditionState.items, ...fresh], 'demo-migrate');
      } catch (err) {
        /* 搬不进库就不动包：定义至少要留下一份（包内那份继续生效，库优先不会遮住它）  */
        console.error(`[判定方式] 包「${pack.packId}」里的判定方式搬进库失败（这次不删包里那份）：${(err as Error).message}`);
        continue;
      }
      moved += fresh.length;
    }
    const rest = pack.items.filter((item) => (item as { itemType?: unknown }).itemType !== 'condition');
    if (rest.length === 0) {
      /* 这个包里只有判定方式（方案 B 时代自建包就是这样）：摘完之后它没有条目了。
         空包过不了校验（`E_PACK_STORE_BAD_CONTENT`：空包几乎总是导出/拼装出错），
         所以这里不是"写一个空包"，而是把空包删掉 —— 与界面上删掉最后一条时同一处置。  */
      const removed = deletePack({ registry: packRegistry, db: STORAGE.db, packId: pack.packId });
      packStoreReport = removed.report;
      if (!removed.ok) {
        console.error(`[判定方式] 包「${pack.packId}」里只剩判定方式，但删掉这个空包失败：${removed.code ?? 'E_PACK_STORE_UNKNOWN'}`);
        continue;
      }
      console.log(`[判定方式] 包「${pack.packId}」里只剩判定方式，摘完后为空 → 整包移除（判定方式归库）`);
      continue;
    }
    const written = writePack({
      registry: packRegistry,
      db: STORAGE.db,
      supported: SUPPORTED_PACK_ENGINE_APIS,
      validateFor: packValidatorForWithConditions,
      input: JSON.parse(JSON.stringify({ ...pack, items: rest })) as unknown,
      by: 'demo-migrate',
    });
    if (!written.ok) {
      console.error(`[判定方式] 从包「${pack.packId}」里摘掉判定方式失败（库里已有一份，包里那份还在）：${written.code} ${written.message}`);
      continue;
    }
    packStoreReport = written.result.report;
  }
  CONFIG_KV.write(CONDITION_MIGRATION_KEY, true);
  if (moved > 0 || dropped > 0) {
    console.log(
      `[判定方式] 已迁移：从包里搬进库 ${moved} 条`
        + `${dropped > 0 ? `，丢弃"库里已有同码"的包内拷贝 ${dropped} 条` : ''}`
        + '（判定方式现在是库级资产，不在包里）',
    );
  }
}

migratePackConditionsOnce();

/* ---------------- 内涵类质控：规则清单与引擎（都在库里） ---------------- */

/**
 * 规则清单与引擎配置落库（`config.qc-content.rules` / `.engine` / `.token`），
 * 不再由环境变量给（原先：`L0_QC_CONTENT_RULES_FILE` 指向一个库外的 JSON 文件，
 * 以及 `L0_QC_CONTENT_ENGINE` / `_URL` / `_TOKEN` / `_ID`）。
 *
 * 前三条坏处与其它部署参数相同（备份带不走、改了没重启看不出来、凭据漏进进程环境），
 * 这里另有一条只有它有的：判定标准原先在库外的某个路径上，于是
 * "质控在跑、库里一条规则都没有"与"质控跑了、0 命中"在界面上长得一模一样。
 * 落库之后，规则清单成了备份的一部分 —— 恢复一份数据库就是恢复一整套质控能力。
 *
 * 规则清单不放在代码里、也不给默认清单：它们来自临床标准 / 专科共识，本程序一条都不发明。
 * 清单为空是合法状态，那时接口报"无规则/未接入"，而不是假装跑过。
  */
function qcContentNow(): LoadedQcContentConfig {
  return loadQcContentConfig(CONFIG_KV);
}

/** 读质控配置；读不出来时不当作"未接入"：把原因带出来，界面才能区分"没配"与"读不出"  */
function qcContentSafe(): { content: LoadedQcContentConfig | null; error: string | null } {
  try {
    return { content: qcContentNow(), error: null };
  } catch (err) {
    return { content: null, error: (err as Error).message };
  }
}

/**
 * 按库里的配置组装引擎。构造失败不算启动失败：
 * 引擎配错（地址非法、明文发外部、类型没实现）时记下原因并保持"不可用"，
 * 质控引擎配错不该把病历编辑器一起拖垮。
 */
function contentEngineOf(content: LoadedQcContentConfig): { engine: ContentQcEngine; problem: string | null } {
  const kind = content.engine.kind;
  if (kind === 'none') {
    return {
      engine: createUnavailableEngine(
        `内涵类质控引擎未接入（契约 ${CONTENT_ENGINE_API} 已定义；在管理后台「质控」页把引擎设为 model —— 用本机已接入的模型，` +
          '或设为 http 并填地址 —— 接外部引擎）',
      ),
      problem: null,
    };
  }
  if (kind === 'model') {
    /* 模型形态：接的就是管理后台「能力配置」里那一个模型 —— 不需要第二份凭据、第二个地址。
       代价是同一份配置既用于写病历、也用于内涵质控，所以在状态里两者分开显示
       （引擎自报的 id 是 `qc-content-model`，与写病历那条路区分得开）。

       模型没接入（offline / 无地址）时不构造它，而是明确报"不可用"：
       构造一个跑起来什么都不判的引擎，会让"内涵质控 0 命中"把"根本没接"顶替掉。  */
    const loaded = modelConfigNow();
    if (loaded.config.format !== 'openai-compatible' || !loaded.config.endpoint) {
      return {
        engine: createUnavailableEngine(`模型未接入（当前来源：${loaded.source}），model 引擎不可用`),
        problem: `质控引擎形态是 model，但模型还没接入（当前来源：${loaded.source}）：请先在管理后台「能力配置」里接上模型`,
      };
    }
    return { engine: createModelContentEngine({ loadConfig: modelConfigNow }), problem: null };
  }
  const url = content.engine.url;
  if (url === undefined || url === '') {
    return {
      engine: createUnavailableEngine('质控引擎形态是 http 但没给地址'),
      problem: '质控引擎形态是 http，但库里没有地址（保存时本不该允许这种状态）',
    };
  }
  try {
    return {
      engine: createHttpContentEngine({
        endpoint: url,
        ...(content.token ? { token: content.token } : {}),
        ...(content.engine.expectEngineId ? { expectEngineId: content.engine.expectEngineId } : {}),
      }),
      problem: null,
    };
  } catch (err) {
    const message = (err as Error).message;
    return { engine: createUnavailableEngine(`内涵类质控引擎配置被拒：${message}`), problem: `引擎配置被拒：${message}` };
  }
}

function visitDocsOf(docId: string): QcVisitDoc[] | undefined {
  const workspace = state.workspace;
  if (!workspace) return undefined;
  for (const patient of workspace.patients) {
    for (const visit of patient.visits) {
      if (!visit.docs.some((doc) => doc.docId === docId)) continue;
      const out: QcVisitDoc[] = [];
      for (const item of visit.docs) {
        const loaded = state.entries.get(item.docId)?.session.document;
        const docTypeCode = loaded?.docType?.code ?? '';
        const createdAt = loaded?.createdAt ?? '';
        /* 有一份读不到（未加载 / 缺类型码 / 缺成文时间）→ 整份清单都不给。
           给一份"少了几条的清单"会让间隔规则把"没加载"算成"没写"，那是假阳性，
           而假阳性会让医生从此不再相信这条提示。宁可让规则走"未判定"并说出来。 */
        if (docTypeCode === '' || createdAt === '') return undefined;
        out.push({ docId: item.docId, docTypeCode, createdAt, title: item.title });
      }
      return out;
    }
  }
  /* 不在任何就诊下（如孤立文书）：清单为空是事实，不是"取不到" */
  return [];
}

/**
 * 某份文书所在就诊的整条线：就诊本身（就诊号 / 类型）+ 该就诊下的全部文书。
 *
 * 与 `visitDocsOf` 的差别在"缺东西时怎么办"：
 *   · `visitDocsOf` 服务的是判定，缺一份就整份清单都不给（否则会把"没加载"算成"没写"）；
 *   · 这里服务的是呈现，读不到的那一份仍要出现在轴上（标成"时间无法解析"），
 *     否则轴上会凭空少一个点 —— 而"少一个点"看上去就是"这条线本来就是连的"。
  */
function patientLineOf(docId: string): { patientId: string; patient: WorkspacePatient } | undefined {
  for (const patient of state.workspace?.patients ?? []) {
    for (const visit of patient.visits) {
      if (visit.docs.some((doc) => doc.docId === docId)) return { patientId: patient.patientId, patient };
    }
  }
  return undefined;
}

function visitLineOf(docId: string): { visitId: string; visitType: string; docs: WorkspaceVisit['docs'] } | undefined {
  for (const patient of state.workspace?.patients ?? []) {
    for (const visit of patient.visits) {
      if (visit.docs.some((doc) => doc.docId === docId)) {
        return { visitId: visit.visitId, visitType: visit.visitType, docs: visit.docs };
      }
    }
  }
  return undefined;
}

/** 文本节点所在的最近一层章节（与跨次对比同一口径：沿 parentId 向上找，带环保护） */
function sectionIdOf(doc: DocumentModel, nodeId: NodeId): string | null {
  let cursor: NodeId | null = doc.nodes[nodeId]?.parentId ?? null;
  const guard = new Set<string>();
  while (cursor && !guard.has(cursor)) {
    guard.add(cursor);
    const node = doc.nodes[cursor];
    if (!node) return null;
    if (node.type === 'section') return node.id;
    cursor = node.parentId ?? null;
  }
  return null;
}

function summaryDocOf(docId: string, fallbackTitle: string): SummaryDoc | undefined {
  const entry = state.entries.get(docId);
  if (!entry) return undefined;
  const doc = entry.session.document;
  const sections = Object.values(doc.nodes)
    .filter((node): node is Extract<DocNode, { type: 'section' }> => node.type === 'section')
    .sort((left, right) => ((left.order ?? 0) - (right.order ?? 0)) || left.id.localeCompare(right.id))
    .map((section) => {
      const paragraphs = Object.values(doc.nodes)
        .filter((node): node is Extract<DocNode, { type: 'text' }> => node.type === 'text' && sectionIdOf(doc, node.id) === section.id)
        .sort((left, right) => ((left.order ?? 0) - (right.order ?? 0)) || left.id.localeCompare(right.id))
        .map((node) => ({ nodeId: node.id, text: node.runs.map((run) => run.text).join('') }));
      return {
        code: String(section.sectionCode ?? ''),
        title: section.title ?? section.sectionCode ?? '',
        paragraphs,
      };
    });
  return {
    docId,
    title: fallbackTitle || doc.docType?.display || docId,
    docTypeCode: String(doc.docType?.code ?? ''),
    createdAt: doc.createdAt,
    sections,
  };
}

/** 一位患者一行 */
const PREVISIT_KEY_PREFIX = 'previsit.rec:';

/** 升级前的总表键名（只读一次做迁移，之后不再写它） */
const PREVISIT_LEGACY_KEY = 'previsit.records';

interface PrevisitStore {
  version: 2;
  records: PrevisitRecord[];
}

/**
 * 本次接诊的预问诊缓存。
 *
 * 只留一条：同一时刻只有一个人在接诊。留一张 Map 的话，长期运行会把每位患者的
 * 主诉（敏感信息）攒在进程里 —— 而它们早就没有用处了。
  */
let previsitCache: { patientId: string; record: PrevisitRecord | null; readAt: string } | null = null;

interface PrevisitRead {
  ok: true;
  record: PrevisitRecord | null;
  readAt: string;
  cached: boolean;
}

/**
 * 按患者读一次（接诊时读、之后走缓存）。
 *
 * `force = true` 绕过缓存：医生点「读取预问诊」时用，因为候诊到接诊之间患者可能刚提交。
 *
 * 解不开不等于没有：把"解不开"当成"没提交过"，现场表现是"患者填的东西不见了"，
 * 而两件事的处置完全不同（一个要排查数据，一个什么都不用做）。
  */
function previsitOfPatient(patientId: string, force = false): PrevisitRead | { ok: false; code: string; message: string } {
  if (!force && previsitCache !== null && previsitCache.patientId === patientId) {
    return { ok: true, record: previsitCache.record, readAt: previsitCache.readAt, cached: true };
  }

  const key = `${PREVISIT_KEY_PREFIX}${patientId}`;
  const got = workStore.getSealed<PrevisitStore>(key);
  if (!got.ok) {
    return { ok: false, code: got.code, message: `预问诊记录在库里但解不开（口令换过或那一行被改动）：${got.message}` };
  }

  let records: PrevisitRecord[] = got.found && Array.isArray(got.data.records) ? got.data.records : [];
  if (!got.found) {
    /* 旧总表里可能还躺着这位患者的表单：搬过来一次，之后只写新键。
       不搬的话，升级那一刻正好在旧表里的表单会凭空消失。 */
    const legacy = workStore.getSealed<{ records?: PrevisitRecord[] }>(PREVISIT_LEGACY_KEY);
    if (legacy.ok && legacy.found && Array.isArray(legacy.data.records)) {
      const mine = legacy.data.records.filter((item) => item.patientId === patientId);
      if (mine.length > 0) {
        records = mine;
        workStore.putSealed<PrevisitStore>(key, { version: 2, records: mine });
      }
    }
  }

  const latest = records.slice().sort((left, right) => right.submittedAt.localeCompare(left.submittedAt))[0] ?? null;
  const readAt = new Date().toISOString();
  previsitCache = { patientId, record: latest, readAt };
  return { ok: true, record: latest, readAt, cached: false };
}

/**
 * 写一位患者的表单（整行替换）。
 *
 * 这一行解不开时拒绝写入：否则就是把这一位患者唯一的一份记录，用一份新表单盖掉 ——
 * 而现场只会看到"数据变了"。宁可这次写不进去（接口如实报错），也不能悄悄覆盖。
  */
function savePrevisitOfPatient(patientId: string, record: PrevisitRecord): { ok: true } | { ok: false; code: string; message: string } {
  const key = `${PREVISIT_KEY_PREFIX}${patientId}`;
  const got = workStore.getSealed<PrevisitStore>(key);
  if (!got.ok) {
    return { ok: false, code: got.code, message: `这位患者已有的预问诊记录解不开，拒绝覆盖：${got.message}` };
  }
  const existing = got.found && Array.isArray(got.data.records) ? got.data.records : [];
  /* 同一患者 + 同一就诊只留最新一份：预问诊是"这次候诊填的表"，
     攒成多份会让接诊时面对"哪份算数"的问题（旧的那份还得给个作废理由）。 */
  const kept = existing.filter((item) => (item.visitId ?? '') !== (record.visitId ?? ''));
  workStore.putSealed<PrevisitStore>(key, { version: 2, records: [...kept, record] });
  /* 写入即失效：下一位打开这份病历的人必须看到新的，而不是缓存里的旧表 */
  previsitCache = null;
  return { ok: true };
}

/** 本次文书里每个章节的第一个文本节点：预问诊的落点只认这个位置 */
function sectionAnchorsOf(doc: DocumentModel): SectionAnchor[] {
  const anchors: SectionAnchor[] = [];
  for (const section of Object.values(doc.nodes)) {
    if (section.type !== 'section') continue;
    const texts = Object.values(doc.nodes)
      .filter((node) => node.type === 'text' && sectionIdOf(doc, node.id) === section.id)
      .sort((left, right) => ((left.order ?? 0) - (right.order ?? 0)) || left.id.localeCompare(right.id));
    anchors.push({ code: String(section.sectionCode ?? ''), nodeId: texts[0]?.id ?? null });
  }
  return anchors;
}

/**
 * 规则目录的一项（含未启用的）。
 *
 * 下发的字段分两类，两类都要带全：
 *   - "跑不跑"：`enabled` —— 它落在库里的 `disabled` 列，不在包内容里；
 *   - "按什么判"：`predicate` / `params` / `detail` / `suggestion` ——
 *     编辑抽屉要把当前这一条原样回显出来。编辑是一条"读回 → 改 → 写回"的回路，
 *     读不全就等于写不全：少回显一个字段，那一次保存就会把它静默清掉，
 *     而且没有任何地方会报错（包写得进去、校验也过得去）。
  */
interface QcRuleCatalogEntry {
  packId: string;
  itemId: string;
  title: string;
  severity: string;
  enabled: boolean;
  predicate: string | null;
  params: Record<string, unknown>;
  detail: string | null;
  suggestion: string | null;
  conditionSummary: string | null;
}

/**
 * 规则目录：给界面看的（哪一条、叫什么、按什么判、开着没有）。
 *
 * 通用层（`knowledge/pack.ts`）只知道 `itemId / enabled`，它不该认识 `title / severity`
 * 这类规则专有字段。所以这份目录在这里补上，而不是把规则字段硬塞进通用层的清单结构里。
 *
 * 只列规则条目：判定方式有自己的目录（`qcConditionCatalog`），
 * 混进这张表会让判定方式以"没有判定方式的规则"的样子出现。
  */
function qcRuleCatalog(): QcRuleCatalogEntry[] {
  const out: QcRuleCatalogEntry[] = [];
  for (const summary of packRegistry.list('rule')) {
    const pack = packRegistry.get(summary.packId) as QcRulePack | null;
    if (!pack) continue;
    /* 带上"这个包能引用到的判定方式"（库里的 + 包自带的）：
       "这条规则按什么判"的人话回读必须把引用解开（否则界面只会显示一个孤零零的编码）  */
    const conditions = resolvedConditionsOf(pack, conditionLibrary());
    for (const descriptor of ruleItemsOf(pack)) {
      out.push({
        packId: summary.packId,
        itemId: descriptor.itemId,
        title: descriptor.title ?? descriptor.itemId,
        severity: descriptor.severity ?? 'warn',
        enabled: descriptor.enabled !== false,
        predicate: descriptor.predicate?.kind ?? null,
        params: (descriptor.predicate?.params ?? {}) as Record<string, unknown>,
        detail: descriptor.detail ?? null,
        suggestion: descriptor.suggestion ?? null,
        conditionSummary: conditionSummaryOf(descriptor, conditions),
      });
    }
  }
  return out;
}

/**
 * 判定方式目录：给界面看的（哪一条、叫什么、判什么、谁在用它）。
 *
 * 判定方式是库级资产（`condition-store.ts`）：全院一份、不属于任何包，
 * 所以这份目录就是库里的那一份，不按包拉平 —— 引用它的规则可能分布在好几个包里，
 * 那些在 `usedBy[].packId` 上（界面照它说"会影响哪个包的哪几条"）。
 *
 * `usedBy` 由内核的 `conditionCatalogOf` 算出，删除保护读的是同一个函数 ——
 * 两处各算一遍的后果不是多打几个字，而是"界面说没人用、删除却被拒"这种对不上的话。
  */
function qcConditionCatalog(): QcConditionCatalogEntry[] {
  return conditionCatalogOf(conditionState.items, packRegistry);
}

function writeConditions(nextItems: QcConditionDefinition[], actor: string, note: string): LoadedConditions {
  assertLibraryChangeIsSafe(packRegistry, nextItems);
  const beforeIds = conditionState.items.map((item) => String(item.itemId));
  const saved = saveConditions(CONFIG_KV, nextItems, actor);
  conditionState = saved;
  recordAdminAudit({
    actor,
    subject: '判定方式库',
    kind: '变更',
    before: { 判定方式: beforeIds.length === 0 ? '（原先一条都没有）' : `${beforeIds.length} 条` },
    after: { 判定方式: `${saved.items.length} 条` },
    note,
  });
  return saved;
}

/**
 * 取规则包（顺带确认它确实是规则包）。
 *
 * 规则类内容有两类条目（规则与具名条件），它们改的都是同一份包内容、走同一条写路径，
 * 所以"这是不是一个规则包"这个判断也只该有一处 —— 否则两条入口迟早对同一个包给出不同结论。
 */
function rulePackOf(packId: string): { pack: QcRulePack } | { code: string; message: string } {
  const pack = packRegistry.get(packId) as QcRulePack | null;
  if (!pack) return { code: 'E_PACK_NOT_FOUND', message: `库里没有包「${packId}」` };
  if (pack.kind !== 'rule') return { code: 'E_PACK_NOT_FOUND', message: `包「${packId}」是 ${pack.kind} 类，不是规则包` };
  return { pack };
}

/**
 * 保存一份病历的旁挂数据。
 *
 * 失败只记录、不抛出：持久化不该打断临床操作，磁盘满了不该让"采纳建议"
 * 这种动作失败。但也不能吞掉（日志里留一条），否则"数据没存上"会静默累积。
 */
function persist(entry: DocEntry): PersistStatus {
  /* 基线必须先建立（懒加载一次），否则"带条件的写"没有条件可比 */
  ensureRestored(entry);

  const baseline = entry.sidecarBaseline;
  /* 基线未知（`'unknown'` 或压根没建立）→ 拒绝覆盖。这不是保守，是因为两种可能都很糟：
     "库里那份读不出来"（它可能是唯一的一份）与"从来没读到过"（写入会凭空覆盖别处的内容）。 */
  if (baseline === undefined || baseline === 'unknown') {
    const message = '库里的旁挂数据读过但没读懂，本次拒绝覆盖它（避免把一份读不出来的数据抹掉）';
    entry.log.push({ at: new Date().toISOString(), action: '未落盘：库里的旁挂数据状态未知', ok: false, code: 'E_PERSIST_BASELINE_UNKNOWN', message });
    return { ok: false, code: 'E_PERSIST_BASELINE_UNKNOWN', message };
  }

  try {
    const rev = entry.session.docRev;
    if (entry.storedRev !== rev) {
      /* 时长随正文一起落盘：它是派生数据，单独存一份迟早与正文对不上 */
      workStore.saveDocument(applyWritingTiming(entry.session.document, entry.session.timing()), metaFromTreeOf(entry.docId));
      entry.storedRev = rev;
    }

    const snapshot = entry.session.sidecarSnapshot();
    const meta = workStore.saveSidecars(entry.docId, snapshot, { expectDigest: baseline });
    entry.sidecarBaseline = meta.digest;
    entry.sidecarConflict = false;
    return { ok: true };
  } catch (err) {
    const code = (err as { code?: string }).code ?? 'E_PERSIST_FAILED';
    const message = (err as Error).message;
    if (code === SNAPSHOT_CONFLICT_CODE) {
      entry.sidecarConflict = true;
      entry.log.push({
        at: new Date().toISOString(),
        action: '未落盘：库里已不是本终端认的那一版（另一处改过这份病历）',
        ok: false,
        code,
        message,
      });
      return { ok: false, code, message, conflict: true };
    }
    entry.log.push({ at: new Date().toISOString(), action: '旁挂数据落库失败', ok: false, code: 'E_PERSIST_FAILED', message });
    return { ok: false, code: 'E_PERSIST_FAILED', message };
  }
}

/** 从工作区树里取这份文书的标题/分类/顺序（库里存的是"结构"，正文另存） */
function metaFromTreeOf(docId: string): { title?: string; kind?: string; sort?: number } {
  for (const patient of state.workspace?.patients ?? []) {
    for (const visit of patient.visits) {
      const index = visit.docs.findIndex((doc) => doc.docId === docId);
      if (index >= 0) {
        const item = visit.docs[index] as { docId: string; title: string; kind?: string };
        return { title: item.title, ...(item.kind ? { kind: item.kind } : {}), sort: index };
      }
    }
  }
  return {};
}

/** 把当前工作区结构写进库。导入 / 新建文书之后必须调用，它们会新增患者/就诊/文书条目 */
function persistStructure(): void {
  if (!state.workspace) return;
  workStore.saveStructure({ patients: state.workspace.patients });
}

/**
 * 会话首次被使用时，从数据库恢复旁挂数据（懒加载，不必改启动流程）。
 *
 * 只有"库里确实没有"才沉默通过；其余失败一律写进日志，
 * 因为"读不出来"与"本来没有"在界面上长得一模一样，不说出来就会被当成正常。
 */
function ensureRestored(entry: DocEntry): void {
  if (entry.restored) return;
  entry.restored = true;
  const loaded = workStore.loadSidecars(entry.docId);
  if (loaded.ok && !loaded.found) {
    /* 库里确实没有这一份 → 首次落盘带 `expectDigest: null`：
       两个终端同时开一份新病历，也只有一个能建成，另一个必须重新载入，
       而不是把先建的那份悄悄盖掉。 */
    entry.sidecarBaseline = null;
    return;
  }
  if (!loaded.ok) {
    /* 读不出来 → 基线"未知"：`persist` 据此拒绝覆盖（见那里的注释） */
    entry.sidecarBaseline = 'unknown';
    entry.log.push({ at: new Date().toISOString(), action: '恢复旁挂数据失败（可能是数据损坏）', ok: false, code: loaded.code, message: loaded.message });
    return;
  }
  try {
    entry.session.restoreSidecars(loaded.data as never);
    /* 基线只在内容确实进到内存之后才被接受。
       顺序反过来的话：装载被拒（版本不兼容 / 结构不认识）时，内存里并没有库里那份内容，
       而基线却已经"认"了它，下一次落盘就会用我们手里的（可能是空的）覆盖库里那份，
       等于把"读不出来"变成"被抹掉了"。 */
    entry.sidecarBaseline = loaded.digest;
    entry.log.push({ at: new Date().toISOString(), action: `已从数据库恢复旁挂数据（建议 ${entry.session.listSuggestions().length} 条）`, ok: true });
  } catch (err) {
    entry.sidecarBaseline = 'unknown';
    entry.log.push({ at: new Date().toISOString(), action: '恢复旁挂数据被拒绝（库里那一版没有被接受，落盘将保持关闭）', ok: false, code: 'E_RESTORE_REJECTED', message: (err as Error).message });
  }
}

/**
 * 清空全部落盘的旁挂数据。重置工作区时必须调用，否则重置是假的。
 *
 * 清理失败不阻断重置：内存已经清空、后续写入会覆盖，但失败也不能当没发生，
 * 所以这里把异常吞掉的同时不做"假装清过了"的返回（调用方只看行为结果）。
 */
function clearPersistedState(): void {
  try {
    if (!existsSync(STATE_DIR)) return;
    for (const name of readdirSync(STATE_DIR)) {
      /* 配置文件不清：模型地址与落位映射是"部署参数"，不是工作区数据。
         清掉它们的现场表现是"重置之后模型悄悄变回离线模板 / 落位退回默认"，
         而没人会想到是"重置"干的（理由详见 ai/model-config-store.ts 文件头）。 */
      if (CONFIG_FILES.has(name)) continue;
      if (name.endsWith('.json') || name.endsWith('.tmp')) fsx.unlinkSync(join(STATE_DIR, name));
    }
  } catch {
    /* 忽略：重置本身不应因为清理失败而失败 */
  }
}

function noteReuse(entry: DocEntry, label: string, reusedIds: string[]): void {
  if (reusedIds.length === 0) return;
  entry.log.push({
    at: new Date().toISOString(),
    action:
      reusedIds.length === 1
        ? `${label}：与待处理建议 ${reusedIds[0]} 内容相同，未重复生成`
        : `${label}：其中 ${reusedIds.length} 条与待处理建议内容相同（${reusedIds.join('/')}），未重复生成`,
    ok: true,
  });
}

function act<T>(
  entry: DocEntry,
  action: string,
  fn: () => T,
): { ok: true; data: T; persisted?: PersistStatus } | { ok: false; code: string; message: string } {
  try {
    ensureRestored(entry);
    const data = fn();
    entry.log.push({ at: new Date().toISOString(), action, ok: true });
    /* 所有写操作都经这里，一处接入即可覆盖建议与注解的全部变更 */
    const persisted = persist(entry);
    /* 落盘失败不能只躺在日志里：这次写入在内存里成功了，
       但盘上没变，医生必须当场知道，否则"改动不见了"会在下次打开时才暴露。 */
    return { ok: true, data, ...(persisted.ok ? {} : { persisted }) };
  } catch (err) {
    const error = err as WriteError & { message: string };
    const code = error.code ?? 'UNEXPECTED';
    const message = error.message;
    entry.log.push({ at: new Date().toISOString(), action, ok: false, code, message });
    return { ok: false, code, message };
  }
}

async function actAsync<T>(
  entry: DocEntry,
  action: string,
  fn: () => Promise<T>,
): Promise<{ ok: true; data: T; persisted?: PersistStatus } | { ok: false; code: string; message: string }> {
  try {
    ensureRestored(entry);
    const data = await fn();
    entry.log.push({ at: new Date().toISOString(), action, ok: true });
    const persisted = persist(entry);
    return { ok: true, data, ...(persisted.ok ? {} : { persisted }) };
  } catch (err) {
    const error = err as WriteError & { message: string };
    const code = error.code ?? 'UNEXPECTED';
    const message = error.message;
    entry.log.push({ at: new Date().toISOString(), action, ok: false, code, message });
    return { ok: false, code, message };
  }
}

function runProbe(file: string, docId: string): { report: ProbeReport | null; exit: number } {
  const reportFile = `${file}.report.json`;
  const expectFile = join(ARTIFACTS, `${docId}.machine.json`);
  const block = current().session.document.machineReadable;
  if (block) writeFileSync(expectFile, `${JSON.stringify(machineToExpectation(block), null, 2)}\n`, 'utf8');
  const result = spawnSync(process.execPath, [PROBE, file, '--expect', expectFile, '--json', reportFile], { encoding: 'utf8' });
  if (result.error) return { report: null, exit: 2 };
  if (result.status !== 0 && result.status !== 1) return { report: null, exit: result.status ?? 2 };
  try {
    const report = JSON.parse(readFileSync(reportFile, 'utf8').replace(/^\uFEFF/, '')) as ProbeReport;
    return { report, exit: result.status ?? 2 };
  } catch {
    return { report: null, exit: 2 };
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(payload);
}

/**
 * 读原始请求体。
 *
 * 拆成"原始字节"与"按 JSON 解"两步，是因为采集路由收的是 multipart 二进制：
 * 先按 JSON 解一次会把它毁掉（解析失败 → 空对象，音频就没了），
 * 而"顺手两种都试一下"的做法在现场表现为"音频偶尔提交成功、偶尔说没音频"。
  */
async function readRawBody(req: IncomingMessage): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  await new Promise<void>((resolve) => {
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve());
  });
  return concat(chunks);
}

/** JSON 体（绝大多数路由）：解不开就是空对象，缺字段由各 case 自己判并给出明确错误码  */
function jsonBodyOf(raw: Uint8Array): Record<string, unknown> {
  const text = new TextDecoder('utf-8').decode(raw).trim();
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}

const RESOURCE_DIR = join(STATE_DIR, 'resources');
/** 资源文件名白名单：只认内容哈希 + 三种扩展名。不要相信 URL 里的任何其它形状  */
const RESOURCE_NAME = /^[0-9a-f]{64}\.(png|jpg|webp)$/;

function ensureResourceDir(): void {
  if (!existsSync(RESOURCE_DIR)) mkdirSync(RESOURCE_DIR, { recursive: true });
}

/** `/res/<name>` → 本机路径；名字不合规返回 null（防路径穿越：只认白名单形状） */
function resourceFilePathOf(name: string): string | null {
  if (!RESOURCE_NAME.test(name)) return null;
  return join(RESOURCE_DIR, name);
}

/**
 * 按病历里的 `resRef` 读字节。取不到返回 null ——
 * 调用方必须把 null 当成"这张图不存在"，而不是画一张空框。
 */
function readResourceBytes(resRef: string): Uint8Array | null {
  if (!resRef.startsWith('/res/')) return null;
  const file = resourceFilePathOf(resRef.slice('/res/'.length));
  if (!file || !existsSync(file)) return null;
  try {
    return new Uint8Array(readFileSync(file));
  } catch {
    return null;
  }
}

const CAPTURE_SESSIONS = new Set<string>();
const CAPTURE_SESSION_WINDOW = 500;

/** 本会话第一次出现 → 记一笔管理审计（不记音频内容、不记文件名）；返回是否记了  */
function noteCaptureSession(sessionId: string, endpoint: string, actor: string): boolean {
  if (CAPTURE_SESSIONS.has(sessionId)) return false;
  CAPTURE_SESSIONS.add(sessionId);
  if (CAPTURE_SESSIONS.size > CAPTURE_SESSION_WINDOW) {
    const oldest = CAPTURE_SESSIONS.values().next().value as string | undefined;
    if (oldest !== undefined) CAPTURE_SESSIONS.delete(oldest);
  }
  let where = endpoint;
  try {
    where = new URL(endpoint).host;
  } catch {
    /* 配置校验已经挡住非 http(s) 地址，这里只是不让自己因为一个地址崩掉 */
  }
  recordAdminAudit({
    actor,
    subject: '语音采集',
    kind: '动作',
    note: `开始一次采集（会话 ${sessionId}）：音频发往 ${where}。本条不记音频内容`,
  });
  return true;
}

/* ===================== 采集记录：只记元数据，不留音频 ===================== */

const DICTATION_RECORDS_FILE = join(STATE_DIR, 'dictation-records.json');
const DICTATION_RETENTION_DAYS = 7;
const DICTATION_RECORD_LIMIT = 200;

interface DictationRecord {
  id: string;
  at: string;
  endedAt: string;
  docId: string;
  docTitle: string;
  actor: string;
  /** 采集源描述（含实际设备名与采样率，由客户端 `/hello` 如实回报） */
  device: string;
  /** 本机客户端地址（127.0.0.1:8901）：排查"是不是没连上客户端"的第一条线索 */
  client: string;
  elapsedSec: number;
  total: number;
  uploaded: number;
  failed: number;
  shortDropped: number;
  asrConfigured: boolean;
  asrModel: string;
  /** 采集源异常的错误码（设备掉线/被独占时非空） */
  problem: string;
  outcome: 'ok' | 'partial' | 'failed';
}

function dictationRecordsWrite(records: DictationRecord[]): void {
  try {
    mkdirSync(dirname(DICTATION_RECORDS_FILE), { recursive: true });
    writeFileSync(DICTATION_RECORDS_FILE, `${JSON.stringify(records, null, 2)}\n`, 'utf8');
  } catch {
    /* 写不进去不能让采集失败：这一次的记录丢了就丢了，采到音更重要 */
  }
}

/** 读：顺便真的丢掉过期项（不是"看不见"，是移除了，落盘也一并更新）  */
function dictationRecordsLoad(): DictationRecord[] {
  let all: DictationRecord[] = [];
  try {
    if (existsSync(DICTATION_RECORDS_FILE)) {
      const parsed = JSON.parse(readFileSync(DICTATION_RECORDS_FILE, 'utf8').replace(/^\uFEFF/, ''));
      if (Array.isArray(parsed)) all = parsed as DictationRecord[];
    }
  } catch {
    /* 文件坏了不能把采集拖垮：当作没有记录（下一次写入会覆盖掉） */
    return [];
  }
  const cutoff = Date.now() - DICTATION_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const fresh = all.filter((record) => {
    const at = Date.parse(record.endedAt || record.at);
    return Number.isFinite(at) && at >= cutoff;
  });
  if (fresh.length !== all.length) dictationRecordsWrite(fresh);
  return fresh;
}

function dictationRecordsAppend(record: DictationRecord): DictationRecord[] {
  const kept = [record, ...dictationRecordsLoad().filter((item) => item.id !== record.id)]
    .slice(0, DICTATION_RECORD_LIMIT);
  dictationRecordsWrite(kept);
  return kept;
}

function dictationRecordsClear(docId: string): { removed: number; remaining: number } {
  const all = dictationRecordsLoad();
  const before = all.filter((record) => record.docId === docId).length;
  const kept = all.filter((record) => record.docId !== docId);
  if (kept.length !== all.length) dictationRecordsWrite(kept);
  const after = dictationRecordsLoad().filter((record) => record.docId === docId).length;
  return { removed: Math.max(before - after, 0), remaining: after };
}

/** 请求里的数字一律不可信：夹到 0..max 的整数 */
function boundedInt(value: unknown, max: number): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return 0;
  return Math.min(Math.floor(number), max);
}

/** 时长保留一位小数（0.1s 的精度对"录了多久"足够，也不给自己造无意义的尾数） */
function boundedSeconds(value: unknown, max: number): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return 0;
  return Math.min(Math.round(number * 10) / 10, max);
}

function boundedText(value: unknown, max: number): string {
  return String(value ?? '').trim().slice(0, max);
}

/**
 * 一组转写段 → 一组建议。`/api/dictate` 与"演示采集"共用这一份实现。
 *
 * 抽出来的理由与"`suggestBatch` 之后不再造第二套"完全一致：两处各写一遍，
 * "演示里能跑通、真机上跑不通"就是迟早的事 —— 而那正是最贵的一类问题。
 *
 * 失败一律返回而不是抛：调用方要把它连同 `state` 一起回给界面。
  */
async function dictateFromSegments(
  entry: DocEntry,
  input: DictationInput,
  source: 'capture' | 'demo',
): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; code: string; message: string }> {
  const session = entry.session;
  const placement = placementConfigNow();
  /* 上限取两份配置里更小的那个（恒 <0.90）：不由请求指定，也不由调用方选 */
  const ceiling = dictationCeilingNow();
  const transcriptionId = input.transcriptionId;
  /* 落位要按有效段数算（空段会被内核丢掉）：按原始段数分配会与规范化后的段数不一致，
     内核会挡下来（实测发现），那正是它该做的 */
  const normalized = normalizeSegments(input.segments);
  if (normalized.segments.length === 0) {
    return { ok: false, code: 'E_NO_TARGET', message: '这次转写没有任何可用文本（全部是空段）' };
  }
  const candidates = collectCandidates(session.indexes, placement.config);
  if (candidates.nodeIds.length === 0) {
    return { ok: false, code: 'E_NO_TARGET', message: '该病历没有可落位的文本节点（或候选集被"限定章节"收窄到空）' };
  }
  /* external 策略会外呼（唯一会发网络请求的落位路径），其余三种是本地纯函数。
     外呼失败一律 fail-closed：不落笔、不留痕、报错，绝不退回本地策略假装成功。 */
  let outcome: ResolvedPlacement;
  try {
    outcome = await resolvePlacements(
      { segments: normalized.segments, candidates, traceId: transcriptionId },
      placement.config,
    );
  } catch (err) {
    return {
      ok: false,
      code: (err as { code?: string }).code ?? 'E_PLACEMENT_FAILED',
      message: (err as Error).message,
    };
  }
  const warnings: string[] = [];
  if (normalized.dropped > 0) warnings.push(`已丢弃 ${normalized.dropped} 段空文本（未生成建议）`);
  if (normalized.outOfOrder > 0) warnings.push(`转写中有 ${normalized.outOfOrder} 段时间戳倒序，已按时间重排（可能是 ASR 流式输出乱序）`);
  warnings.push(...outcome.warnings);

  let groupId: string | null = null;
  if (outcome.unplaced === 0) {
    const payload = act(entry, `语音转写 → 一组建议（${normalized.segments.length} 段 · ${placement.config.strategy} · ${source === 'demo' ? '模拟转写' : '真实采集'}）`, () =>
      session.dictate(
        { ...input, segments: normalized.segments, targetNodeIds: placedNodeIds(outcome), maxConfidence: ceiling },
        AI,
      ),
    ) as { ok: boolean; data?: { groupId: string; warnings: string[] } };
    if (!payload.ok || !payload.data) {
      return { ok: false, code: (payload as { code?: string }).code ?? 'E_DICTATE_FAILED', message: (payload as { message?: string }).message ?? '生成建议失败' };
    }
    groupId = payload.data.groupId;
    warnings.push(...payload.data.warnings);
  }
  entry.lastDictation = {
    transcriptionId,
    source,
    asrModelId: input.asrModelId,
    ...(input.refineModelId ? { refineModelId: input.refineModelId } : {}),
    groupId,
    warnings,
    segments: normalized.segments.map((segment) => ({
      index: segment.index,
      text: segment.text,
      ...(segment.startSec !== undefined ? { startSec: segment.startSec } : {}),
      ...(segment.endSec !== undefined ? { endSec: segment.endSec } : {}),
      confidence: segment.confidence,
    })),
    placements: outcome.items.map((item) => ({ index: item.index, text: item.text, nodeId: item.nodeId, reason: item.reason })),
    unplaced: outcome.unplaced,
    submitted: outcome.unplaced === 0,
  };
  return {
    ok: true,
    data: {
      ...entry.lastDictation,
      strategy: placement.config.strategy,
      /* 上限回报给界面：建议卡上的"0.85"从哪来要能被回答（两份配置取小者的结果）  */
      confidenceCeiling: ceiling,
    },
  };
}

/**
 * 把一段音频透传给 ASR。C2 路由与"演示采集"共用这一份实现（理由同 `dictateFromSegments`）。
 *
 * 每次现建客户端：配置改完立即生效（不能缓存住地址，否则"我改了却没生效"）。
 * 密钥只在内存里过一次，不进日志、不进响应。
  */
async function transcribeSegmentViaAsr(
  config: LoadedCaptureConfig,
  params: { sessionId: string; index: number; audio: Uint8Array },
): Promise<{ text: string; modelId: string; confidenceNote: string }> {
  const client = createAsrClient(config.config.asr, {
    ...(config.apiKey ? { apiKey: config.apiKey } : {}),
    ...(config.apiSecret ? { apiSecret: config.apiSecret } : {}),
  });
  const { text } = await client.transcribe(params);
  return { text, modelId: config.config.asr.modelId, confidenceNote: ASR_NO_CONFIDENCE_NOTE };
}

/**
 * 演示采集的默认脚本：两段人声各 2s，中间静音 1.2s（> `silenceMs` 默认 800ms）。
 *
 * 于是它会切成 2 段、产出 2 条建议，边界可预期（用例据此断言）。
 * 总时长约 5s：演示要能当场看完，而计时是真的在走（不加速、不假装）。
  */
const DEFAULT_CAPTURE_DEMO_TIMELINE: Array<{ seconds: number; voiced: boolean }> = [
  { seconds: 2, voiced: true },
  { seconds: 1.2, voiced: false },
  { seconds: 2, voiced: true },
];

/** 当前演示采集的"停止"句柄（内存态：采完即清） */
let captureStop: (() => Promise<void>) | null = null;

/**
 * 校验请求体里的演示脚本。
 *
 * 不校验长度就等于开了一个"让服务端录上一整天"的口子：脚本是在服务端
 * 按真实时间一帧帧走完的，`seconds: 1e9` 会让这个请求永远不返回。
  */
function parseDemoTimeline(raw: unknown[]): Array<{ seconds: number; voiced: boolean }> {
  if (raw.length > 50) {
    throw new CaptureError('E_CAPTURE_BAD_TIMELINE', `演示脚本最多 50 段，实际 ${raw.length}`);
  }
  let total = 0;
  return raw.map((entry, position) => {
    const item = (entry ?? {}) as { seconds?: unknown; voiced?: unknown };
    const seconds = Number(item.seconds);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      throw new CaptureError('E_CAPTURE_BAD_TIMELINE', `演示脚本第 ${position + 1} 段的 seconds 必须是正数，实际 ${JSON.stringify(item.seconds)}`);
    }
    if (typeof item.voiced !== 'boolean') {
      throw new CaptureError('E_CAPTURE_BAD_TIMELINE', `演示脚本第 ${position + 1} 段的 voiced 必须是布尔值`);
    }
    total += seconds;
    if (total > 120) {
      throw new CaptureError('E_CAPTURE_BAD_TIMELINE', '演示脚本总时长不得超过 120s（它是在服务端真的按时间走完的）');
    }
    return { seconds, voiced: item.voiced };
  });
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function previewOfTemplate(
  templateId: string,
  createdBy: string,
): { ok: true; data: Record<string, unknown> } | { ok: false; code: string; message: string } {
  const catalogEntry = templateCatalogOf(packRegistry)
    .find((item) => item.itemType === 'template' && item.itemId === templateId);
  if (!catalogEntry) {
    return { ok: false, code: 'E_TPL_TEMPLATE_UNKNOWN', message: `模板库里没有「${templateId}」：它可能已被删除` };
  }
  const pack = packRegistry.get(catalogEntry.packId) as TemplatePack | undefined;
  const definition = pack?.items.find(
    (candidate) => candidate.itemType === 'template' && candidate.itemId === templateId,
  ) as TemplateDefinition | undefined;
  if (!pack || !definition) {
    return { ok: false, code: 'E_TPL_TEMPLATE_UNKNOWN', message: `包「${catalogEntry.packId}」里找不到模板「${templateId}」` };
  }

  const entry = current();
  const source = entry.session.document;
  const deptList = departmentsSafe().loaded;
  /* 科室与开具时同一口径：归一后再判（老病历里的"呼吸内科"与模板上的 `DEPT_RESP` 是同一个科）  */
  const deptCode = normalizeDepartmentCode(deptList, source.encounter?.deptCode);

  let created: ReturnType<typeof instantiateTemplate>;
  try {
    created = instantiateTemplate(pack, {
      templateId,
      /* 这份文档只活在这一次响应里：它不进工作区、不落库，docId 只是个占位  */
      docId: 'doc_preview',
      createdBy,
      patient: source.patient,
      ...(source.encounter ? { encounter: { ...source.encounter, ...(deptCode ? { deptCode } : {}) } } : {}),
      doctor: { actorId: createdBy },
      at: new Date().toISOString(),
      context: { 'encounter.deptName': departmentNameOf(deptList, deptCode) },
    });
  } catch (err) {
    return {
      ok: false,
      code: (err as { code?: string }).code ?? 'E_TPL_PREVIEW_FAILED',
      message: (err as Error).message,
    };
  }

  /* 槽位 key → 试开出来的节点：值从节点上取，界面因此答得出"这一格是空的还是有值" */
  const nodeBySlot = created.result.slots;
  const sections = catalogEntry.sections.map((section) => ({
    title: section.title,
    sectionCode: section.sectionCode,
    slots: section.slots.map((slot) => {
      const nodeId = nodeBySlot[slot.key];
      const node = nodeId === undefined ? undefined : created.doc.nodes[nodeId];
      const value = node === undefined
        ? ''
        : node.type === 'text'
          ? node.runs.map((run) => run.text).join('')
          : node.type === 'field'
            ? (node.valueText ?? '')
            : '';
      return {
        kind: slot.kind,
        key: slot.key,
        /* 一行人话沿用目录里的那份（填写项报类型与单位，表达式报控件与公式）：
           预览与列表说的是同一件事，两处各写一份必然对不上 */
        detail: slot.detail,
        ...(slot.tags ? { tags: slot.tags } : {}),
        ...(slot.required ? { required: true } : {}),
        ...(node && node.type === 'field' && node.unit ? { unit: node.unit } : {}),
        value,
        filled: value !== '',
      };
    }),
  }));

  const departments = Array.isArray(definition.departments) ? definition.departments : [];
  return {
    ok: true,
    data: {
      templateId,
      name: definition.name ?? templateId,
      docType: catalogEntry.docType ?? null,
      status: catalogEntry.status,
      enabled: catalogEntry.enabled,
      /** 现在这份能不能真的开出来（草稿 / 停用为 false）—— 预览不受它限制，但要说清楚 */
      openable: catalogEntry.openable,
      departments,
      departmentNames: departments.map((code) => departmentNameOf(deptList, code) ?? code),
      deptApplicable: deptAllowsTemplate(definition, deptCode),
      visitDeptName: deptCode ? (departmentNameOf(deptList, deptCode) ?? deptCode) : '',
      /* 出处（`包#模板@内容指纹`）：每一格都出自它，摆出来便于与"库里那一版"核对 */
      source: created.result.source,
      warnings: created.result.warnings,
      sections,
      /* 正文视图：与医生端 `/api/state` 的 `items` 同一次组装（`buildItemsOfDocument`）。
         预览要画的正是"医生点开之后那一屏"，各画一份必然分叉：今天差一个 chip、
         明天差一处只读态，而"预览与正文不一样"是最难被发现的错（两边都"看起来对"）。
         字段名、单位、数据元标签、系统带入的出处、待确认状态都在这里，前端只负责画。  */
      items: buildItemsOfDocument(created.doc),
    },
  };
}

function previewOfControl(
  itemId: string,
  createdBy: string,
): { ok: true; data: Record<string, unknown> } | { ok: false; code: string; message: string } {
  const catalogEntry = templateCatalogOf(packRegistry)
    .find((item) => item.itemType === 'control' && item.itemId === itemId);
  if (!catalogEntry) {
    return { ok: false, code: 'E_CTRL_UNKNOWN', message: `专科控件库里没有「${itemId}」：它可能已被删除` };
  }
  const pack = packRegistry.get(catalogEntry.packId) as TemplatePack | undefined;
  const definition = pack?.items.find(
    (candidate) => candidate.itemType === 'control' && candidate.itemId === itemId,
  ) as ControlDefinition | undefined;
  if (!pack || !definition) {
    return { ok: false, code: 'E_CTRL_UNKNOWN', message: `包「${catalogEntry.packId}」里找不到控件「${itemId}」` };
  }

  /* 临时模板：只含这一个控件。它不进注册表，只是给 `instantiateTemplate` 一个入口 ——
     控件槽位那条链（校验 → 实例化 → 快照 → 落位）因此走的是与真实开文书同一段代码。
     章节标题用控件名：预览屏上那行标题就是医生看到的那一行。  */
  const previewTemplate: TemplateDefinition = {
    itemType: 'template',
    itemId: `tpl.preview.${itemId}`,
    name: definition.name ?? itemId,
    /* 文书类型只是占位（这份文书不落库、不入目录）：`system` 用本机构自定义 */
    docType: { system: 'local', code: 'controlPreview', display: '控件预览' },
    enabled: true,
    sections: [
      {
        sectionCode: 'preview',
        title: definition.name ?? itemId,
        slots: [{ slot: 'control', key: 'preview', useControl: itemId }],
      },
    ],
  };

  const source = current().session.document;
  let created: ReturnType<typeof instantiateTemplate>;
  try {
    created = instantiateTemplate(
      { ...pack, items: [...pack.items, previewTemplate] },
      {
        templateId: previewTemplate.itemId,
        /* 这份文档只活在这一次响应里：不进工作区、不落库，docId 只是占位 */
        docId: 'doc_control_preview',
        createdBy,
        patient: source.patient,
        ...(source.encounter ? { encounter: source.encounter } : {}),
        doctor: { actorId: createdBy },
        at: new Date().toISOString(),
        context: {},
      },
    );
  } catch (err) {
    return {
      ok: false,
      code: (err as { code?: string }).code ?? 'E_CTRL_PREVIEW_FAILED',
      message: (err as Error).message,
    };
  }

  return {
    ok: true,
    data: {
      itemId,
      name: definition.name ?? itemId,
      shape: definition.shape,
      controlKind: definition.controlKind,
      controlVersion: definition.version ?? 1,
      /* 现在这一份还能不能被新建的病历选用（停用为 false）—— 预览不受它限制，但要说清楚 */
      enabled: catalogEntry.enabled,
      warnings: created.result.warnings,
      /* 出处（`包#控件@版本`）：与库里那一版核对用 */
      source: created.result.source,
      /* 正文视图：与医生端同一次组装（`buildItemsOfDocument`），理由同模板预览 */
      items: buildItemsOfDocument(created.doc),
    },
  };
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = req.url ?? '/';
  let path = url.split('?')[0] ?? '/';

  /* 部署前缀：剥掉之后，下面所有路由仍按"自己就是根"写（见 BASE_PATH 那段说明）。
     落在前缀之外的请求不属于本实例 —— 明确报出来，而不是让它一路走到下面的路由里
     变成一条莫名其妙的 404（那会让人以为路由写错了）。 */
  if (BASE_PATH !== '') {
    if (path === BASE_PATH) path = '/';
    else if (path.startsWith(`${BASE_PATH}/`)) path = path.slice(BASE_PATH.length);
    else {
      json(res, 404, { ok: false, code: 'E_OUTSIDE_BASE', message: `本实例部署在 ${BASE_PATH} 下` });
      return;
    }
  }

  if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    // 不缓存：改了界面后必须立刻生效，否则浏览器会继续跑旧脚本（排查问题时极易误判）
    res.setHeader('Cache-Control', 'no-store');
    res.end(withBase(readFileSync(UI_FILE, 'utf8')));
    return;
  }

  /* 结构 / 样式 / 脚本三件套的后两件（ui.html 通过 <link> 与 <script src> 引用）。
     与页面同样 no-store：改了界面必须立刻生效，否则浏览器会继续跑旧样式/旧脚本。 */
  if (req.method === 'GET' && path === '/ui.css') {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/css; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(readFileSync(UI_CSS_FILE, 'utf8'));
    return;
  }

  if (req.method === 'GET' && path === '/ui.js') {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(readFileSync(UI_JS_FILE, 'utf8'));
    return;
  }

  if (req.method === 'GET' && path === '/command-palette.js') {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(readFileSync(COMMAND_PALETTE_JS_FILE, 'utf8'));
    return;
  }

  /* 图片字节（`/res/<sha256>.<ext>`）。
     只从 resources 目录读、文件名过白名单 —— 少了这一道，一条 `/res/..%2f..%2fconfig`
     就是任意文件读取；而字符串前缀判断（`startsWith`）挡不住 `..`。
     内容寻址 ⇒ 同一个地址的字节永不改变，所以可以长缓存。  */
  if (req.method === 'GET' && path.startsWith('/res/')) {
    const name = path.slice('/res/'.length);
    const file = resourceFilePathOf(name);
    const mime = mimeOfExtension(name.slice(name.lastIndexOf('.') + 1));
    if (!file || !mime || !existsSync(file)) {
      json(res, 404, {
        ok: false,
        code: 'E_RESOURCE_MISSING',
        message: '这张图不在本机（可能换过机器，或资源目录被清理过）',
      });
      return;
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', mime);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.end(readFileSync(file));
    return;
  }

  /* 自定义弹框：与 ui.js 同样 no-store（改了按钮文案/判定就该立刻生效，
     否则浏览器会继续用旧的那份，而"确认框里还是老词"最容易被当成没改）。 */
  if (req.method === 'GET' && path === '/dialog.js') {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(readFileSync(DIALOG_JS_FILE, 'utf8'));
    return;
  }

  /* 浏览器端采集实现：与 ui.js 同样 no-store（改一行分片规则就该立刻生效，
     否则浏览器会继续用旧规则切段，而那正是"怎么突然切得不对了"的来路）。 */
  /* 正文渲染：与 ui.js 同样 no-store（改一行排版就该立刻生效，
     否则"预览里还是老样子"会被当成没改对，而它其实只是浏览器跑着旧脚本）。 */
  if (req.method === 'GET' && path === '/doc-view.js') {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(readFileSync(DOC_VIEW_JS_FILE, 'utf8'));
    return;
  }

  /* 自由流式视图：同样 no-store（它决定的是"光标能不能跨段流动"这类手感，
     浏览器跑着旧脚本时，表现是"改了没反应"，而排查方向会跑到别处去）。 */
  if (req.method === 'GET' && path === '/flow-view.js') {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(readFileSync(FLOW_VIEW_JS_FILE, 'utf8'));
    return;
  }

  /* 宿主接入桥：必须在 ui.js 之前加载（顺序由 ui.html 的 script 顺序保证），
     所以它也要能被单独取到 —— 取不到的话浏览器只会报一个 404，而页面照常启动，
     于是表现变成"宿主注入没生效"，看不出是脚本没送到。 */
  if (req.method === 'GET' && path === '/host-bridge.js') {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(readFileSync(HOST_BRIDGE_JS_FILE, 'utf8'));
    return;
  }

  if (req.method === 'GET' && path === '/capture-web.js') {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(readFileSync(CAPTURE_WEB_JS_FILE, 'utf8'));
    return;
  }

  /* 公众号二维码：唯一一处允许缓存的静态资源，
     它与 HTML / JS 不同：那些改一行就要立刻生效，而这张图不会因为改代码而变化。
     每次重下 48KB 是白花的（它在管理后台左栏常驻）。 */
  if (req.method === 'GET' && path === '/hongyi-ai-qr.jpg') {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.end(readFileSync(QR_FILE));
    return;
  }

  /* 登录页：管理后台里唯一不需要会话的页面。 */
  if (req.method === 'GET' && path === '/login') {
    /* 已登录的人再打开登录页，直接送去后台，否则他会看到"我已经登录了，还要再登一次" */
    if (resolvePrincipal(req).ok) {
      res.statusCode = 302;
      res.setHeader('Location', `${BASE_PATH}/admin`);
      res.end();
      return;
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(withBase(renderLoginPage()));
    return;
  }

  if (req.method === 'GET' && path === '/login.js') {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(readFileSync(LOGIN_JS_FILE, 'utf8'));
    return;
  }

  /* 管理后台页面与脚本：与医生端同样 no-store（改了必须立刻生效）。
     未登录直接 302 到登录页，而不是把整份 HTML 发下去再让前端藏起来，
     "藏起来"只挡住看得见的东西，配置体的字段名与占位符照样在响应体里。 */
  if (req.method === 'GET' && path === '/admin') {
    if (!resolvePrincipal(req).ok) {
      res.statusCode = 302;
      /* next 用服务端自己生成的常量（不让请求参数参与）；带前缀时 `/admin` 也要带，
         否则登录成功后会被送回宿主根上的 `/admin` */
      res.setHeader('Location', `${BASE_PATH}/login?next=${encodeURIComponent(`${BASE_PATH}/admin`)}`);
      res.end();
      return;
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(withBase(readFileSync(ADMIN_FILE, 'utf8')));
    return;
  }

  if (req.method === 'GET' && path === '/admin.js') {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(readFileSync(ADMIN_JS_FILE, 'utf8'));
    return;
  }

  /* 管理后台会话查询（GET）：页面打开时问一次"我还登录着吗"，避免刷新就退回登录页。
     它与医生端的 `/api/session` 问的是同一件事（同一份会话），只是去处不同。 */
  if (req.method === 'GET' && path === '/api/admin/session') {
    const info = sessionInfoOf(req);
    json(
      res,
      200,
      info.authenticated
        ? {
            ok: true,
            /* `adminId` 是兼容字段：管理后台页面用它显示"已登录："，值等于 `actorId`。
               不删它是因为删了要同步改界面，而这一处的收益只有"少一个字段名"。 */
            adminId: info.actorId,
            actorId: info.actorId,
            role: info.role,
            roleLabel: info.role ? ROLE_LABELS[info.role] : null,
            expiresAt: info.expiresAt,
            /* 顺带把环境标识给出来：左栏顶部要显示它，为了一个字符串单开一次请求不值得 */
            env: ENV_NAME,
          }
        : { ok: false, code: 'E_ADMIN_NO_SESSION', message: '未登录' },
    );
    return;
  }

  /* 通用会话查询：医生端也要能问"我是谁、什么角色、还能做什么"。
     `actions` 是按同一张权限表算出来的，供界面决定按钮的可用性，
     放行判断始终在服务端（`guard`），这一份只用于"别让人点了才知道不行"。 */
  /* 内涵类质控的契约自述：外部实现方照着它写。
     只读、不需要身份（它是规格，不是数据），与 `/api/state` 同类。 */
  if (req.method === 'GET' && path === '/api/qc-content-contract') {
    json(res, 200, {
      ok: true,
      data: {
        ...describeContentContract(),
        /* 契约是通用规格；这台机器的现状才是"能不能用"的答案，两者一起给 */
        local: (() => {
          const qc = qcContentSafe();
          if (qc.content === null) {
            /* 读不出来不报成"未接入"：那会让"配置读坏了"看起来像"还没配"，
               而前者要排查数据、后者什么都不用做  */
            return { engine: null, configured: false, rules: 0, source: 'unreadable', problem: qc.error };
          }
          return {
            engine: qc.content.engine.kind,
            configured: qc.content.engine.kind !== 'none' && qc.content.rules.length > 0,
            rules: qc.content.rules.length,
            source: qc.content.source,
            problem: qc.content.rulesProblem,
          };
        })(),
      },
    });
    return;
  }

  if (req.method === 'GET' && path === '/api/session') {
    const info = sessionInfoOf(req);
    json(res, 200, {
      ok: true,
      data: {
        ...info,
        /* 中文角色名一起给：界面直接显示 `role` 的话，医生会看到 "clinician"，
           界面与实现用的是两套词，而"以什么身份登录"恰恰是医生要认的那一行。
           角色名在服务端只有一处定义（`ROLE_LABELS`），界面不该自己再译一遍。 */
        roleLabel: info.role ? ROLE_LABELS[info.role] : null,
        mode: AUTH_MODE,
        ttlMinutes: SESSION_TTL_MINUTES,
        actions: Object.fromEntries(ALL_ACTIONS.map((action) => [action, info.role ? can(info.role, action) : false])),
      },
    });
    return;
  }

  if (req.method === 'GET' && path === '/api/state') {
    json(res, 200, { ok: true, state: stateFor(req) });
    return;
  }

  if (req.method === 'GET' && path === '/api/download') {
    const entry = current();
    if (!entry.lastExport) {
      json(res, 404, { ok: false, code: 'E_NO_EXPORT', message: '当前病历尚未导出' });
      return;
    }
    const buffer = readFileSync(entry.lastExport.file);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${entry.docId}.ofd"`);
    res.end(buffer);
    return;
  }

  if (req.method === 'GET' && path === '/api/download-wst500') {
    const entry = current();
    const record = entry.lastWst500;
    if (!record) {
      json(res, 404, { ok: false, code: 'E_NO_EXPORT', message: '当前病历尚未导出共享文档' });
      return;
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${entry.docId}.wst500.xml"`);
    res.end(readFileSync(record.file, 'utf8'));
    return;
  }

  /* 配置视图（GET）：四份配置文件各自的"现在是什么"。
     它们原先写在各自 case 里（`if (String(req.method).toUpperCase() === 'GET')`），
     而 case 排在下面那道"非 POST 一律 405"之后，于是那几段永远到不了，
     GET 只会拿到 `E_METHOD`（实测：`fetch('/api/model-config')` → `{"code":"E_METHOD"}`）。
     修法是把 GET 提到 guard 之前，与本文件顶部那些 GET 路由同一位置。 */
  const configViews: Record<string, () => unknown> = {
    '/api/model-config': () => describeModelConfig(modelConfigNow()),
    '/api/placement-config': () => describePlacementConfig(placementConfigNow()),
    '/api/capture-config': () => describeCaptureConfig(captureConfigNow()),
    '/api/sign-backend-config': () => describeSignConfig(signConfigNow()),
    /* 预问诊接入：只报"密钥在不在"，不回显值（它只存哈希，本来也取不回原文）。
       解不开时如实回 error，而不是返回一份默认值 —— 那样界面会显示"未配置"，
       事实上是"配过但解不开"，两者的处置完全不同。  */
    '/api/previsit-config': () => {
      try {
        return describeAccess(loadAccess(CONFIG_KV), AUTH_MODE);
      } catch (err) {
        return { error: (err as Error).message };
      }
    },
    '/api/reading-authority': () => describeReadingAuthority(readingAuthorityNow()),
    /* 系统策略与内涵质控：与上面五份同理，只回传"现在是什么"（凭据只报是否就位） */
    '/api/system-config': () => describeSystemConfig(systemConfigNow()),
    '/api/qc-content-config': () => describeQcContentConfig(qcContentNow()),
    /* 科室字典同理：它不含任何凭据，读视图不设卡（模板配置界面也要用它显示名称） */
    '/api/departments': () => {
      const { loaded, error } = departmentsSafe();
      return { ...describeDepartments(loaded), error };
    },
    /* 文书类型与科室字典同类：不含凭据，读视图不设卡（「新建文书」的类型下拉要读它） */
    '/api/doc-types': () => {
      const { loaded, error } = docTypesSafe();
      return { ...describeDocTypes(loaded), error };
    },
  };
  const configView = req.method === 'GET' ? configViews[path] : undefined;
  if (configView) {
    json(res, 200, { ok: true, data: configView(), state: stateFor(req) });
    return;
  }

  /* 管理后台的只读视图（审计 / 运行状态 / 系统信息）。
     与上面四份配置视图处置不同：那四份读视图不设卡（不含密钥值，且医生端的"产出方"本来
     就要显示同样的信息）；而这三份含管理员姓名、操作历史、运行信息，性质是"谁在用它"，
     所以要登录，审计若是人人可读，"审计"两个字就没有意义了。 */
  const adminViews: Record<string, () => unknown> = {
    '/api/admin/audit': buildAdminAuditView,
    '/api/admin/health': buildHealthView,
    '/api/admin/system': buildSystemView,
  };
  const adminView = req.method === 'GET' ? adminViews[path] : undefined;
  if (adminView) {
    /* 管理视图走同一个授权入口：审计是 `audit.read`（管理员/质控员/只读都能看），
       不再写"有没有会话"这种一次性判断，那样加一个角色就要改一次这里。 */
    try {
      guard(req, 'audit.read');
    } catch (err) {
      json(res, 200, {
        ok: false,
        code: (err as { code?: string }).code ?? 'E_AUTH_REQUIRED',
        message: (err as Error).message,
      });
      return;
    }
    json(res, 200, adminView());
    return;
  }

  /* 采集记录（GET）：只回元数据。必须放在这里——"非 POST 一律 405"就在下面几行，
     写进 switch 的 GET 永远到不了（上面五份配置视图已经踩过这个坑一次）。  */
  if (req.method === 'GET' && path === '/api/dictation/capture/records') {
    /* `docId` 有值时只回该病历的记录：列表长在语音面板里，而"上一份病历录了几段、
       用什么设备录的"不该跟着人走到下一个患者 —— 那既是串档，也是隐私。
       不带它时仍返回全部：文件本身是运维排查用的台账，口径不变。  */
    const query = new URLSearchParams((req.url ?? '').split('?')[1] ?? '');
    const docId = boundedText(query.get('docId'), 80);
    const all = dictationRecordsLoad();
    const records = docId === '' ? all : all.filter((record) => record.docId === docId);
    json(res, 200, {
      ok: true,
      data: { retentionDays: DICTATION_RETENTION_DAYS, docId: docId === '' ? null : docId, total: all.length, records },
      state: stateFor(req),
    });
    return;
  }

  if (req.method === 'GET' && path === '/api/admin/users') {
    try {
      guard(req, 'user.write');
    } catch (err) {
      json(res, 200, {
        ok: false,
        code: (err as { code?: string }).code ?? 'E_AUTH_REQUIRED',
        message: (err as Error).message,
      });
      return;
    }
    json(res, 200, { ok: true, data: { users: userStore.list(), accounts: accountStatus() } });
    return;
  }

  if (req.method !== 'POST') {
    json(res, 405, { ok: false, code: 'E_METHOD', message: '仅支持 GET/POST' });
    return;
  }

  const rawBody = await readRawBody(req);
  const body = jsonBodyOf(rawBody);

  /* -------------------------------------------------------------------------
     授权门（唯一一处）：按路径查"需要什么动作"，然后交给 `guard` 判。
     放在 switch 之前，是为了让"漏掉某个路由的权限检查"这件事不可能悄悄发生：
     要么在表里（有明确要求），要么不在表里（明确地不要求）。
     ------------------------------------------------------------------------- */
  const required = ROUTE_ACTIONS[path] ?? (AUTH_MODE === 'strict' ? DOCTOR_ROUTE_ACTIONS[path] : undefined);
  if (required) {
    try {
      guard(req, required);
    } catch (err) {
      /* 被拒也进审计："谁试图做什么、被谁拦下"是审计最该有的内容之一
         （没有它，事后只能看到"成功的那几次"，看不出有人在试探）。
         口令与凭据一个字都不进审计。 */
      const message = (err as Error).message;
      recordAdminAudit({
        actor: actorLabelOf(req),
        subject: ACTION_LABELS[required],
        kind: '动作',
        note: `被拒绝（${(err as { code?: string }).code ?? 'E_AUTH_REQUIRED'}）：${message}`,
      });
      json(res, 200, {
        ok: false,
        code: (err as { code?: string }).code ?? AUTH_ERRORS.E_AUTH_REQUIRED,
        message,
        state: stateFor(req),
      });
      return;
    }
  }

  switch (path) {
    /* 登录：医生端与管理后台是同一个入口的两个名字。
       会话不分"医生端的"与"管理后台的"，它只回答"这台浏览器上的人是谁"。
       分两个路径只是因为两端界面的用词不同（管理后台习惯 `/api/admin/*`）。
       同一个块、同一个限流桶、同一份审计：不可能出现"从医生端登录就能绕过限流"。 */
    case '/api/session':
    case '/api/admin/session': {
      const username = String(body.username ?? '').trim();
      const password = String(body.password ?? '');
      const source = requestSourceOf(req);

      /* 库还是空的：这里说清该去哪，而不是报一句"用户名或口令不正确"让人对着空库猜。
         未初始化时任何口令都不可能对，所以这条判断不泄露任何东西。 */
      if (userStore.count() === 0) {
        json(res, 200, {
          ok: false,
          code: 'E_NOT_INITIALIZED',
          message: '这台机器还没有任何账号（首次运行）：请在登录页创建第一个管理员',
          initialized: false,
        });
        return;
      }
      if (username === '' || password === '') {
        recordAdminAudit({ actor: username || '（未填账号）', subject: '登录', kind: '动作', note: '登录失败：未填账号或口令' });
        json(res, 200, { ok: false, code: 'E_LOGIN_FIELDS_REQUIRED', message: '请填账号与口令（两者都必填）' });
        return;
      }

      /* 限流在验口令之前：不然爆破者可以一直试（口令对不对是最后一步）。
         两个桶：同一账号（挡住盯着一个账号打）与同一来源（挡住换账号打）。
         被拒的尝试不进入窗口，否则"一直打"会把解封时刻越推越远，等于自我延长封禁。 */
      for (const [key, rule] of [
        [`login:actor:${username.toLowerCase()}`, RATE_RULES['login:actor']],
        [`login:source:${source}`, RATE_RULES['login:source']],
      ] as Array<[string, RateRule]>) {
        const decision = limiter.hit(key, rule);
        if (!decision.ok) {
          recordAdminAudit({ actor: username, subject: '登录', kind: '动作', note: `登录被限流：${decision.message}` });
          json(res, 200, {
            ok: false,
            code: decision.code,
            message: decision.message,
            retryAfterSec: decision.retryAfterSec,
            state: stateFor(req),
          });
          return;
        }
      }

      const verified = userStore.verify(username, password);
      if (!verified.ok) {
        /* 失败也要记："有人在试口令"是审计里最该被看见的一类。
           这里记下的是服务端判定的具体原因（账号不存在 / 口令错），而给用户的文案合并成
           一句，审计是事后给运维看的，两者要的东西正好相反。口令一个字都不进审计。 */
        const why = verified.code === 'E_USER_NOT_FOUND' ? '账号不存在' : '口令不正确';
        recordAdminAudit({ actor: username, subject: '登录', kind: '动作', note: `登录失败：${why}` });
        /* 「已停用」在口令正确之后才报：能走到这里说明口令是对的，
           所以"这个账号被停用了"是一条只该告诉账号主人的信息，而不是给爆破者的反馈。 */
        if (verified.code === 'E_USER_DISABLED') {
          json(res, 200, {
            ok: false,
            code: 'E_USER_DISABLED',
            message: `账号「${username}」已停用，请联系管理员启用（口令本身是对的）`,
          });
          return;
        }
        json(res, 200, { ok: false, code: 'E_LOGIN_FAILED', message: '用户名或口令不正确' });
        return;
      }

      const account = verified.user;
      /* 会话里的 `actorId` 用库里的写法（`Admin` 登录进来就是 `admin`）：
         否则审计里同一个账号会出现两个名字，"谁做的"又要靠人去比对。 */
      const { id: sid, record } = sessions.issue({
        actorId: account.username,
        kind: 'human',
        role: account.role,
        tenant: 'default',
        label: account.roleLabel,
      });
      /* 登录成功 → 把该账号的失败计数清零：成功不该继续背着失败 */
      limiter.reset(`login:actor:${account.username.toLowerCase()}`);
      userStore.touchLogin(account.username);
      /* HttpOnly：脚本读不到它（页面被注入时也偷不走）；SameSite=Strict：同源请求才带 */
      res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${sid}; HttpOnly; SameSite=Strict; Path=/`);
      recordAdminAudit({
        actor: account.username,
        subject: '登录',
        kind: '动作',
        note: `登录成功（角色「${account.roleLabel}」，会话寿命 ${SESSION_TTL_MINUTES} 分钟，只存指纹）`,
      });
      json(res, 200, {
        ok: true,
        /* `adminId` 是兼容字段（管理后台页面用它显示"已登录："），值等于 actorId */
        adminId: record.actorId,
        actorId: record.actorId,
        role: record.role,
        roleLabel: ROLE_LABELS[record.role],
        expiresAt: new Date(record.expiresAt).toISOString(),
        at: new Date(record.createdAt).toISOString(),
      });
      return;
    }

    case '/api/admin/bootstrap': {
      if (userStore.count() > 0) {
        recordAdminAudit({ actor: actorLabelOf(req), subject: '初始化', kind: '动作', note: '拒绝：本机已有账号，初始化入口已关闭' });
        json(res, 200, {
          ok: false,
          code: 'E_ALREADY_INITIALIZED',
          message: '本机已经创建过账号，初始化入口已关闭；请用既有账号登录（忘记口令见 README 的 npm run user）',
        });
        return;
      }
      /* 来源限流照用登录那个桶：初始化也是一次"凭据尝试"，不该成为限流的旁路 */
      const source = requestSourceOf(req);
      const throttled = limiter.hit(`login:source:${source}`, RATE_RULES['login:source']);
      if (!throttled.ok) {
        json(res, 200, { ok: false, code: throttled.code, message: throttled.message, retryAfterSec: throttled.retryAfterSec });
        return;
      }
      /* 已注入部署口令时必须同时给出它：否则"服务起来了但还没初始化"的那个窗口里，
         任何能访问本端口的人都能把自己变成管理员。装机脚本会等我们起好服务再访问，
         所以这个窗口在真实部署里恰恰是最容易被撞上的一个。 */
      if (DEPLOY_TOKEN && String(body.deployToken ?? '') !== DEPLOY_TOKEN) {
        recordAdminAudit({ actor: '（初始化尝试）', subject: '初始化', kind: '动作', note: '拒绝：部署凭据不正确（L0_ADMIN_TOKEN）' });
        json(res, 200, {
          ok: false,
          code: 'E_BOOTSTRAP_DEPLOY_TOKEN',
          message: '本机已注入 L0_ADMIN_TOKEN：初始化需要同时提供它（证明是运维本人在初始化，而不是任意访问者）',
        });
        return;
      }
      try {
        const created = userStore.create({
          username: String(body.username ?? '').trim(),
          password: String(body.password ?? ''),
          role: 'admin',
          by: '首次初始化（/login）',
        });
        recordAdminAudit({
          actor: created.username,
          subject: '初始化',
          kind: '变更',
          before: { 账号数: 0 },
          after: { 账号数: 1 },
          note: `创建了第一个管理员账号「${created.username}」（口令已哈希入库，不入审计、不回显）`,
        });
        /* 不自动登录：让刚设的那条口令当场被用一次，"我记得住它"是这次初始化
           唯一没有别的办法验证的一件事，而自动登录恰好把它跳过去了。 */
        json(res, 200, {
          ok: true,
          data: { username: created.username, loginUrl: `${BASE_PATH}/login` },
          message: '管理员账号已创建，请用该账号与口令登录',
        });
      } catch (err) {
        const code = err instanceof UserError ? err.code : 'E_BOOTSTRAP_FAILED';
        recordAdminAudit({ actor: '（初始化尝试）', subject: '初始化', kind: '动作', note: `失败：${code}` });
        json(res, 200, { ok: false, code, message: (err as Error).message });
      }
      return;
    }

    case '/api/session/logout':
    case '/api/admin/logout': {
      const sid = cookieOf(req, SESSION_COOKIE);
      /* 退出的操作者取自会话（不是请求自报）：否则"谁退出的"这一条可以随便写。
         吊销走 `sessions.revoke`（幂等）：重复点退出、或会话本来就过期，都不该报错。 */
      const who = sid ? sessions.resolve(sid) : null;
      const actor = who && who.ok ? who.record.actorId : null;
      if (sid) sessions.revoke(sid);
      if (actor) recordAdminAudit({ actor, subject: '登录', kind: '动作', note: '退出登录（会话已吊销）' });
      res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
      json(res, 200, { ok: true });
      return;
    }

    case '/api/admin/users':
    case '/api/admin/users/password':
    case '/api/admin/users/role':
    case '/api/admin/users/disabled':
    case '/api/admin/users/remove': {
      /* 读入口（GET `/api/admin/users`）在上面那段，非 POST 到不了这里，
         所以这里只处理五个写入口。 */
      const operator = guard(req, 'user.write');
      const target = String(body.username ?? '').trim();
      const snapshot = (user: { username: string; roleLabel: string; disabled: boolean } | null): Record<string, string> | undefined =>
        user ? { 账号: user.username, 角色: user.roleLabel, 状态: user.disabled ? '已停用' : '可用' } : undefined;

      try {
        const before = userStore.get(target);
        let after: { username: string; roleLabel: string; disabled: boolean };
        let what: string;
        let extra = '';

        if (path === '/api/admin/users') {
          after = userStore.create({
            username: target,
            password: String(body.password ?? ''),
            role: String(body.role ?? '') as Role,
            by: operator.actorId,
          });
          what = `新增账号「${after.username}」（角色：${after.roleLabel}）`;
          extra = '口令已哈希入库（审计与响应体里都不含口令）';
        } else if (path === '/api/admin/users/password') {
          after = userStore.setPassword({ username: target, password: String(body.password ?? ''), by: operator.actorId });
          what = `重设「${after.username}」的口令`;
          if (after.username.toLowerCase() === operator.actorId.toLowerCase()) {
            sessions.revokeAllFor(operator.actorId);
            const fresh = sessions.issue({
              actorId: operator.actorId,
              kind: 'human',
              role: operator.role,
              tenant: 'default',
              label: ROLE_LABELS[operator.role],
            });
            res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${fresh.id}; HttpOnly; SameSite=Strict; Path=/`);
            extra = '已在其它终端吊销该账号会话（当前浏览器已换发新会话，不必重登）';
          } else {
            extra = `已吊销该账号的 ${sessions.revokeAllFor(after.username)} 个会话（需重新登录）`;
          }
        } else if (path === '/api/admin/users/role') {
          after = userStore.setRole({ username: target, role: String(body.role ?? '') as Role, by: operator.actorId });
          what = `改「${after.username}」的角色（${before ? before.roleLabel : '（未知）'} → ${after.roleLabel}）`;
          extra = `已吊销该账号的 ${sessions.revokeAllFor(after.username)} 个会话（权限变了，旧会话不能继续用）`;
        } else if (path === '/api/admin/users/disabled') {
          const disabled = body.disabled === true || body.disabled === 'true';
          after = userStore.setDisabled({ username: target, disabled, by: operator.actorId });
          what = `${disabled ? '停用' : '启用'}账号「${after.username}」`;
          if (disabled) extra = `已吊销该账号的 ${sessions.revokeAllFor(after.username)} 个会话`;
        } else {
          const removed = userStore.remove({ username: target, by: operator.actorId });
          after = removed;
          what = `删除账号「${after.username}」（角色：${after.roleLabel}）`;
          extra = `已吊销该账号的 ${sessions.revokeAllFor(removed.username)} 个会话`;
        }

        recordAdminAudit({
          actor: `${operator.actorId}（${ROLE_LABELS[operator.role]}）`,
          subject: '后台账号',
          kind: '变更',
          ...(snapshot(before) ? { before: snapshot(before) } : {}),
          after: snapshot(after),
          note: `${what}${extra ? `；${extra}` : ''}`,
        });
        json(res, 200, { ok: true, data: { users: userStore.list(), accounts: accountStatus(), action: what } });
        return;
      } catch (err) {
        const code = err instanceof UserError ? err.code : 'E_USER_FAILED';
        /* 被拒的账号变更也要留痕：连点五次"删除最后一个管理员"与一次手滑，
           在事后看是两件事，而只有审计分得出它们。 */
        recordAdminAudit({
          actor: `${operator.actorId}（${ROLE_LABELS[operator.role]}）`,
          subject: '后台账号',
          kind: '动作',
          note: `拒绝（${code}）：${(err as Error).message}`,
        });
        json(res, 200, { ok: false, code, message: (err as Error).message });
        return;
      }
    }

    case '/api/reset': {
      const whoReset = actorLabelOf(req);
      recordAdminAudit({
        actor: whoReset,
        subject: ACTION_LABELS['workspace.reset'],
        kind: '变更',
        before: { 病历数: state.entries.size },
        after: { 病历数: 0 },
        note: '清空工作区、已落盘的旁挂数据与阅读授权登记（破坏性动作，不可撤销）',
      });

      /* 重置必须连磁盘一起清：否则下一次读取会把"刚清掉的数据"原样装回来，
         重置就成了假的（实测发现：B6"重置回初始态"失败）。 */
      clearPersistedState();
      resetWorkspace();
      current().log.push({ at: new Date().toISOString(), action: `工作区已重置（操作者 ${whoReset}）`, ok: true });
      state.readingGrants.clear();
      READING_GRANTS_ERROR = null;
      /* 预问诊缓存同理：`sealed_kv` 已被一起清掉，缓存里那份（同 patientId、同一位患者）
         会在重置后继续被送到界面上 —— 那等于"重置之后再看到已经删掉的东西"。
         种子患者号是固定的，命中缓存不会报错，只会安静地给出旧内容。 */
      previsitCache = null;
      json(res, 200, { ok: true, state: stateFor(req) });
      return;
    }

    case '/api/open': {
      const docId = String(body.docId ?? '');
      if (!state.entries.has(docId)) {
        json(res, 200, { ok: false, code: 'E_DOC_NOT_FOUND', message: `病历不存在：${docId}` });
        return;
      }
      state.activeDocId = docId;
      json(res, 200, { ok: true, data: { docId }, state: stateFor(req) });
      return;
    }

    case '/api/delete-document': {
      const docId = String(body.docId ?? '');
      const entry = state.entries.get(docId);
      if (!entry) {
        json(res, 200, { ok: false, code: 'E_DOC_NOT_FOUND', message: `病历不存在：${docId}`, state: stateFor(req) });
        return;
      }
      const status = entry.session.document.status;
      if (status !== 'draft') {
        json(res, 200, {
          ok: false,
          code: 'E_DOC_NOT_DRAFT',
          message: `只有草稿可以删除：这份病历当前是「${DOC_STATUS_TEXT[status] ?? status}」。已签章或已归档的病历必须保留，要改请走「解锁修改」`,
          state: stateFor(req),
        });
        return;
      }
      if (state.entries.size <= 1) {
        json(res, 200, {
          ok: false,
          code: 'E_DOC_LAST_ONE',
          message: '这是最后一份病历，不能删除（系统默认总有一份活动病历）。要清空全部工作数据请到管理后台「系统信息 → 工作区」重置',
          state: stateFor(req),
        });
        return;
      }

      const beforeCount = state.entries.size;
      const title = entry.session.document.docType.display || docId;
      /* 先从树里摘掉，再决定"删完打开哪一份"：同一次就诊的下一份优先，
         没有就落到第一份 —— 不让人删完之后停在一份已经被删掉的空白上。 */
      let nextId = '';
      for (const patient of state.workspace?.patients ?? []) {
        for (const visit of patient.visits) {
          const index = visit.docs.findIndex((item) => item.docId === docId);
          if (index < 0) continue;
          visit.docs.splice(index, 1);
          nextId = visit.docs[0]?.docId ?? '';
        }
      }
      state.entries.delete(docId);
      if (state.activeDocId === docId) {
        state.activeDocId = nextId !== '' && state.entries.has(nextId)
          ? nextId
          : ([...state.entries.keys()][0] ?? '');
      }

      /* 落库：结构表里那一行必须显式删（`saveStructure` 只增不删，不会替我们带走它）；
         正文、留痕与旁挂数据由仓储在同一个事务里删掉。  */
      const removedFromStore = workStore.deleteDocument(docId);

      /* 阅读授权绑定的是这份文档的内容指纹：文档没了，它们就是一堆必然失败的凭据
         （同「重置工作区」那段注释）。内存索引是权威，清掉后全量同步。 */
      let grantsRemoved = 0;
      for (const [grantId, record] of state.readingGrants) {
        if (record.credential.grant.docId === docId) {
          state.readingGrants.delete(grantId);
          grantsRemoved += 1;
        }
      }
      let grantsPersisted: { ok: boolean; message?: string } = { ok: true };
      if (grantsRemoved > 0) grantsPersisted = persistReadingGrants();

      persistStructure();
      recordAdminAudit({
        actor: actorLabelOf(req),
        subject: '删除病历草稿',
        kind: '变更',
        before: { 病历数: beforeCount },
        after: { 病历数: state.entries.size },
        note: `删除草稿 ${docId}（${title}）${grantsRemoved > 0 ? `，同时清理阅读授权 ${grantsRemoved} 条` : ''}${grantsPersisted.ok ? '' : `（授权同步失败：${grantsPersisted.message ?? ''}）`}`,
      });

      json(res, 200, {
        ok: true,
        data: { docId, removedFromStore, grantsRemoved, activeDocId: state.activeDocId, grantsPersisted },
        state: stateFor(req),
      });
      return;
    }

    case '/api/import': {
      /* 导入病历文件：按内容识别格式（OFD 容器 / WS/T 500 XML），不依赖用户选的后缀，
         医院导出的文件常被改名或干脆没有后缀，让程序认比让人选可靠。
         解析 → 生成导入草稿 → 挂进工作区树并切为活动病历。
         注意导入件是新草稿：不继承源文件的签名状态（法律效力仍在源文件上）。 */
      const fileName = String(body.fileName ?? 'imported');
      const base64 = String(body.base64 ?? '').replace(/^data:[^,]+,/, '');
      if (!base64) {
        json(res, 200, { ok: false, code: 'E_BAD_REQUEST', message: '缺少 base64 内容' });
        return;
      }
      let parsed: AnyImported;
      try {
        parsed = importAnyDocument(Buffer.from(base64, 'base64'), fileName);
      } catch (err) {
        json(res, 200, { ok: false, code: (err as { code?: string }).code ?? 'E_IMPORT_FAILED', message: (err as Error).message });
        return;
      }
      const importedAt = new Date().toISOString();
      const docId = `doc_imported_${state.entries.size + 1}`;
      const { doc, reviewNotes } = buildDraftFromAny(parsed, { docId, actorId: 'DR_DEMO', fileName, importedAt });
      const summary = describeAnyImport(parsed);
      const newEntry: DocEntry = entryFor(doc);
      newEntry.log.push({ at: importedAt, action: `导入 ${fileName}（${summary}）`, ok: true });
      state.entries.set(docId, newEntry);

      /* 挂进工作区树：按源文件里的患者分组（识别不出来就单开一组"导入"） */
      const sourcePatient = parsed.kind === 'ofd' ? parsed.result.sourcePatient : parsed.result.patient;
      const patientId = sourcePatient?.patientId ?? `P_IMPORT_${state.workspace?.patients.length ?? 0}`;
      let patient = state.workspace?.patients.find((item) => item.patientId === patientId);
      if (state.workspace && !patient) {
        patient = {
          patientId,
          nameMasked: sourcePatient?.nameMasked ?? '（导入）',
          gender: parsed.kind === 'wst500' ? (parsed.result.patient?.gender ?? 'U') : 'U',
          age: 0,
          visits: [],
        };
        state.workspace.patients.push(patient);
      }
      if (patient) {
        const visitId = `V_IMPORT_${docId}`;
        patient.visits.push({
          visitId,
          visitType: 'outpatient',
          dept: '导入',
          date: importedAt.slice(0, 10),
          docs: [{ docId, title: `导入：${fileName}`, kind: 'outpatient' }],
        });
      }
      state.activeDocId = docId;
      /* 落库：导入件新增了"患者/就诊/文书条目"（可能还新增了一个患者），
         结构与正文都要写进去，只写正文会因为外键缺条目而被拒（那正是它该拦的）。 */
      persistStructure();
      const importStored = workStore.saveDocument(newEntry.session.document, { title: `导入：${fileName}`, kind: 'outpatient' });
      void importStored;
      json(res, 200, {
        ok: true,
        data: {
          docId,
          kind: parsed.kind,
          format: parsed.kind === 'ofd' ? parsed.result.format : 'wst500',
          summary,
          pages: parsed.kind === 'ofd' ? parsed.result.pages : null,
          textChars: parsed.kind === 'ofd' ? parsed.result.textChars : parsed.result.stats.textChars,
          elements: parsed.kind === 'ofd' ? parsed.result.machine.elements.length : parsed.result.stats.fields,
          sections: parsed.kind === 'wst500' ? parsed.result.stats.sections : null,
          signed: parsed.kind === 'ofd' ? parsed.result.signature.signed : false,
          signaturePlaceholder: parsed.kind === 'ofd' ? parsed.result.signature.placeholder : false,
          fileSha256: parsed.result.fileSha256,
          warnings: parsed.result.warnings,
          reviewNotes,
        },
        state: stateFor(req),
      });
      return;
    }

    case '/api/suggest': {
      const entry = current();
      const session = entry.session;
      const nodeId = String(body.nodeId ?? '');
      const confidence = Number(body.confidence ?? 0.95);
      const node = session.document.nodes[nodeId];
      if (!node) {
        json(res, 200, { ok: false, code: 'E_NODE_NOT_FOUND', message: `节点不存在：${nodeId}` });
        return;
      }
      /* 产出方式只影响提示词，不影响通道：三种方式在内核里都是同一条建议通道 */
      const mode = (['complete', 'draft', 'polish'] as const).find((item) => item === String(body.mode)) ?? 'complete';
      /* 上下文只经 `buildAiContext` 产出（脱敏 + 预算 + 审计回执）：
         适配器拿不到 session，"脱敏"因此是机制而不是自愿遵守的约定。
         `confidence` 不再由请求给出：置信度是产出方的判断，
         让调用方指定它，等于把"这条内容有多可信"交给不产出内容的一方（与"门控档位不由调用方决定"同源）。 */
      let response: Awaited<ReturnType<AiAdapter['suggest']>>;
      let request: AiSuggestRequest;
      try {
        const ctx = buildAiContext(session.document, {
          nodeIds: [nodeId],
          contextBefore: 2,
          contextAfter: 1,
          actor: { id: AI.id, kind: AI.kind },
        });
        request = {
          context: ctx,
          mode,
          allowedNodeIds: targetNodeIdsOf(ctx),
          maxItems: modelConfigNow().config.maxItems,
          traceId: `demo-suggest-${Date.now()}`,
        };
        response = await adapterNow().suggest(request);
      } catch (err) {
        /* 失败不落笔、不留痕：不产生建议，也不写一条"调用失败"的留痕，变更记录里不该出现没发生的事 */
        json(res, 200, {
          ok: false,
          code: (err as { code?: string }).code ?? 'E_AI_CALL_FAILED',
          message: (err as Error).message,
          state: stateFor(req),
        });
        return;
      }
      const silence = resolveSilenceReport({ request, items: response.items, declared: response.skipped });
      entry.lastAiSilence = silence;
      const draft = response.items.find((item) => item.nodeId === nodeId) ?? response.items[0];
      if (!draft) {
        json(res, 200, {
          ok: false,
          code: 'E_AI_NO_SUGGESTION',
          message:
            silence.skipped.length > 0
              ? `产出方对本次 ${silence.targets} 个目标都没有产出建议（逐条原因见沉默报告）`
              : '产出方没有给出针对该节点的建议',
          silence,
          state: stateFor(req),
        });
        return;
      }
      const result = act(entry, `AI 出建议（${mode} · ${response.modelId}）`, () =>
        session.suggestText(
          {
            nodeId: draft.nodeId,
            text: draft.text,
            confidence: draft.confidence,
            modelId: response.modelId,
            ...(response.promptId ? { promptId: response.promptId } : {}),
          },
          AI,
        ),
      );
      /* 幂等命中：没有新增建议（同目标同文本，且那条仍待处理）。告知，别让"没多一条"被当成故障。 */
      if (result.ok === true) {
        noteReuse(entry, `AI 出建议（${mode} · ${response.modelId}）`, result.data.reused ? [result.data.suggestionId] : []);
      }
      json(res, 200, { ...result, usage: response.usage, state: stateFor(req) });
      return;
    }

    case '/api/model-config': {
      const entry = current();
      /* GET 视图已在 handle() 顶部统一处理，写在这里会排在 405 guard 之后，永远到不了 */
      try {
        const by = requireAdminSession(req, entry);
        /* 前后值：写之前先取一份。`modelConfigNow()` 每次重新读盘，所以这里就是磁盘上的旧值，
           只记"谁在何时改了什么"不够用，事后最常问的一句是"它原来是配成什么的"。 */
        const before = describeModelConfig(modelConfigNow());
        const { loaded, apiKeyAction } = saveModelConfig(
          CONFIG_KV,
          {
            format: body.format as never,
            model: body.model as never,
            endpoint: body.endpoint as never,
            timeoutMs: Number(body.timeoutMs),
            maxItems: Number(body.maxItems),
            /* 只有请求里真的出现了 `apiKey` 字段才处理它：
               字段缺失 = 不改（界面没动这一栏），显式 null = 清除。
               把"没传"当成"清空"，会让管理员只改个地址就把密钥弄丢，
               而现场表现是"模型突然 401"，没人会想到是改地址顺手清了密钥。 */
            ...('apiKey' in body ? { apiKey: body.apiKey === null ? null : String(body.apiKey) } : {}),
          },
          by,
        );
        const after = describeModelConfig(loaded);
        recordAdminAudit({ actor: by, subject: '模型接入配置', kind: '变更', before, after });
        json(res, 200, { ok: true, apiKeyAction, data: after, state: stateFor(req) });
      } catch (err) {
        json(res, 200, {
          ok: false,
          code: (err as { code?: string }).code ?? 'E_CONFIG_REJECTED',
          message: (err as Error).message,
          state: stateFor(req),
        });
      }
      return;
    }

    case '/api/placement-config': {
      /* 落位配置：与模型配置同一形态（GET 视图 / POST 保存，需管理员）。
         落库（`config.placement`，外部落位的密钥单独一行 `config.placement.apiKey`），
         不进工作区快照，它是部署参数：混进快照，"重置工作区"会把它清掉，
         "备份工作区"会把落点映射带到另一套环境（那些节点 id 在另一套环境里根本不存在）。  */
      const entry = current();
      /* GET 视图已在 handle() 顶部统一处理，写在这里会排在 405 guard 之后，永远到不了 */
      try {
        const by = requireAdminSession(req, entry, '落位配置');
        const before = describePlacementConfig(placementConfigNow());
        const { loaded, apiKeyAction } = savePlacementConfig(
          CONFIG_KV,
          {
            strategy: body.strategy as never,
            ...(body.confidenceCeiling === undefined ? {} : { confidenceCeiling: Number(body.confidenceCeiling) }),
            candidate: {
              /* 内核只接受文本节点：这一项固定 true，界面不得放宽（传 false 会被校验拒绝） */
              onlyTextNodes: true,
              ...(Array.isArray(body.withinSections) && body.withinSections.length > 0
                ? { withinSections: body.withinSections.map((item) => String(item)) }
                : {}),
            },
            ...(body.sectionMap && typeof body.sectionMap === 'object' && !Array.isArray(body.sectionMap)
              ? { sectionMap: body.sectionMap as Record<string, string> }
              : {}),
            ...(Array.isArray(body.termMap) ? { termMap: body.termMap as Array<{ match: string; nodeId: string }> } : {}),
            /* 即时结构化词表（V4）：形状是"词 → 数据元标签"，逐条校验在 `validatePlacementConfig` 里。
               与落位共用同一张配置行：换一次部署就是一次保存，不出现"落位改了、词表还是旧的"。 */
            ...(body.structureMap && typeof body.structureMap === 'object' && !Array.isArray(body.structureMap)
              ? { structureMap: body.structureMap as Record<string, DataElementTag> }
              : {}),
            /* 外部落位服务：只存地址 / 超时。密钥值单独走 `apiKey`（单独一行加密落库、永不回显）  */
            ...(body.external && typeof body.external === 'object' && !Array.isArray(body.external)
              ? { external: body.external as { endpoint?: string; timeoutMs?: number } }
              : {}),
            /* 密钥三态：不传 = 不改 / null = 清除 / 字符串 = 设新值 */
            ...(body.apiKey === undefined ? {} : { apiKey: body.apiKey === null ? null : String(body.apiKey) }),
          },
          by,
        );
        const after = describePlacementConfig(loaded);
        /* 审计只记"谁把哪一格从什么改成什么" + 密钥动作，不记密钥值  */
        recordAdminAudit({ actor: by, subject: '落位配置', kind: '变更', before, after: { ...after, apiKeyAction } });
        json(res, 200, { ok: true, data: { ...after, apiKeyAction }, state: stateFor(req) });
      } catch (err) {
        json(res, 200, {
          ok: false,
          code: (err as { code?: string }).code ?? 'E_CONFIG_REJECTED',
          message: (err as Error).message,
          state: stateFor(req),
        });
      }
      return;
    }

    case '/api/capture-config': {
      /* 采集配置：与模型/落位配置同一形态（GET 视图 / POST 保存，需管理员）。
         它与落位配置的关键差别：这一项决定音频发往哪台服务器（数据流向变更），
         因此它列在 `ROUTE_ACTIONS` 里 —— 两种模式下都要求管理员，不像医生端写路径那样
         在演示模式下敞开（见 ROUTE_ACTIONS 上方那段"新增写路由必须在这里加一行"）。  */
      const entry = current();
      /* GET 视图已在 handle() 顶部统一处理，写在这里会排在 405 guard 之后，永远到不了 */
      try {
        const by = requireAdminSession(req, entry, '采集配置');
        const before = describeCaptureConfig(captureConfigNow());
        const { loaded, apiKeyAction, apiSecretAction } = saveCaptureConfig(
          CONFIG_KV,
          {
            /* 字段逐个显式转换：`Number(undefined)` 是 NaN，而 NaN 会被校验拒掉 ——
               但那会把"这一格没填"报成"这一格填错了"，现场看不出是哪件事。
               所以缺这一格时不传，让校验去填默认值。  */
            ...(body.kind === undefined ? {} : { kind: String(body.kind) }),
            ...(body.endpoint === undefined ? {} : { endpoint: String(body.endpoint) }),
            ...(body.appKey === undefined ? {} : { appKey: String(body.appKey) }),
            /* 公有云确认：只认真正的 true（`"true"` 也认，因为表单可能给字符串）。
               这一格的语义是"人显式确认过一次"，所以任何"看起来像真"的模糊值都不该通过 ——
               传别的（`"1"` / `"yes"` / `1`）一律当假，让守卫去拒绝，而不是在这里替它放宽。  */
            ...(body.acknowledgePublicCloud === undefined
              ? {}
              : { acknowledgePublicCloud: body.acknowledgePublicCloud === true || body.acknowledgePublicCloud === 'true' }),
            ...(body.modelId === undefined ? {} : { modelId: String(body.modelId) }),
            ...(body.submitTimeoutMs === undefined ? {} : { submitTimeoutMs: Number(body.submitTimeoutMs) }),
            ...(body.pollIntervalMs === undefined ? {} : { pollIntervalMs: Number(body.pollIntervalMs) }),
            ...(body.pollTimeoutMs === undefined ? {} : { pollTimeoutMs: Number(body.pollTimeoutMs) }),
            ...(body.silenceMs === undefined ? {} : { silenceMs: Number(body.silenceMs) }),
            ...(body.maxSeconds === undefined ? {} : { maxSeconds: Number(body.maxSeconds) }),
            ...(body.minSeconds === undefined ? {} : { minSeconds: Number(body.minSeconds) }),
            ...(body.retainAudio === undefined ? {} : { retainAudio: body.retainAudio === true || body.retainAudio === 'true' }),
            ...(body.confidenceCeiling === undefined ? {} : { confidenceCeiling: Number(body.confidenceCeiling) }),
            /* 两格密钥都是三种状态：不传 = 不改 / null = 清除 / 字符串 = 设新值 */
            ...(body.apiKey === undefined ? {} : { apiKey: body.apiKey === null ? null : String(body.apiKey) }),
            ...(body.apiSecret === undefined ? {} : { apiSecret: body.apiSecret === null ? null : String(body.apiSecret) }),
          },
          by,
        );
        const after = describeCaptureConfig(loaded);
        /* 审计只记"谁在何时把哪一格从什么改成什么" + 密钥动作，不记密钥值、不记音频。
           公有云的 `leavesIntranet` 与 `kind` 都在 `after` 里 —— 于是"哪天有人把音频发去院外"
           在审计里是一条可查的记录，而不是只能靠翻代码才知道。  */
        recordAdminAudit({
          actor: by,
          subject: '采集配置',
          kind: '变更',
          before,
          after: { ...after, apiKeyAction, apiSecretAction },
        });
        json(res, 200, { ok: true, data: { ...after, apiKeyAction, apiSecretAction }, state: stateFor(req) });
      } catch (err) {
        json(res, 200, {
          ok: false,
          code: (err as { code?: string }).code ?? 'E_CONFIG_REJECTED',
          message: (err as Error).message,
          state: stateFor(req),
        });
      }
      return;
    }

    case '/api/departments': {
      const entry = current();
      try {
        const by = requireAdminSession(req, entry, '科室字典');
        const before = describeDepartments(departmentsNow());
        const loaded = saveDepartments(CONFIG_KV, body.items, by);
        const after = describeDepartments(loaded);
        recordAdminAudit({ actor: by, subject: '科室字典', kind: '变更', before, after });
        /* 被删掉的科室要如实点名：模板上配着它的文书立刻开不出（编码对不上任何人），
           而这件事只看"保存成功"是看不出来的  */
        const beforeCodes = new Set((before.items as Array<{ code: string }>).map((item) => item.code));
        const afterCodes = new Set((after.items as Array<{ code: string }>).map((item) => item.code));
        const removed = [...beforeCodes].filter((code) => !afterCodes.has(code));
        json(res, 200, {
          ok: true,
          data: { ...after, removedCodes: removed },
          state: stateFor(req),
        });
      } catch (err) {
        json(res, 200, {
          ok: false,
          code: (err as { code?: string }).code ?? 'E_CONFIG_REJECTED',
          message: (err as Error).message,
          state: stateFor(req),
        });
      }
      return;
    }

    case '/api/doc-types': {
      /* 文书类型：院内能建哪几类文书。与上面科室那个 case 同一处置：
         权限归 `config.write`，审计记前后两份清单 —— 只记"谁改过"答不出
         "出院记录是什么时候没的"，而质控规则正按类型编码定位文书。

         删掉一个类型的后果比删科室更隐蔽：模板照样开得出（类型只是文档上的一个字段），
         所以没有一处会报错，表现是"那条规则怎么不报了" —— 于是被删掉的名字必须点名。  */
      const entry = current();
      try {
        const by = requireAdminSession(req, entry, '文书类型');
        const before = describeDocTypes(docTypesNow());
        const loaded = saveDocTypes(CONFIG_KV, body.items, by);
        const after = describeDocTypes(loaded);
        recordAdminAudit({ actor: by, subject: '文书类型', kind: '变更', before, after });
        const beforeKeys = new Set((before.items as DocTypeItem[]).map(docTypeKeyOf));
        const afterKeys = new Set((after.items as DocTypeItem[]).map(docTypeKeyOf));
        const removed = [...beforeKeys].filter((key) => !afterKeys.has(key));
        json(res, 200, {
          ok: true,
          data: { ...after, removedKeys: removed },
          state: stateFor(req),
        });
      } catch (err) {
        json(res, 200, {
          ok: false,
          code: (err as { code?: string }).code ?? 'E_CONFIG_REJECTED',
          message: (err as Error).message,
          state: stateFor(req),
        });
      }
      return;
    }

    case '/api/system-config': {
      /* 系统策略：鉴权模式 / 会话寿命 / 限流阈值 / 锚定节奏 / 锚点种子。
         与其它配置的关键差别：这几项改完要重启服务 —— 它们落在会话表、限流器、
         签名者这三个进程内结构的构造上（见"系统策略（库里）"那一段的说明）。
         因此响应里带 `restartRequired`，界面必须显示它：不带的话，现场的表象是
         "我改了、什么都没发生"，而人只会怀疑自己没保存成功。  */
      const entry = current();
      try {
        const by = requireAdminSession(req, entry, '系统策略');
        const before = describeSystemConfig(systemConfigNow());
        const { loaded, anchorSeedAction } = saveSystemConfig(
          CONFIG_KV,
          {
            /* 非法值不在这里兜底：原样交给校验去抛（静默转成 open 会让"改错了"变成"改成功了"）  */
            ...(body.authMode === undefined ? {} : { authMode: String(body.authMode) as AuthMode }),
            ...(body.sessionTtlMinutes === undefined ? {} : { sessionTtlMinutes: Number(body.sessionTtlMinutes) }),
            ...(body.anchorEvery === undefined ? {} : { anchorEvery: Number(body.anchorEvery) }),
            ...(body.rate && typeof body.rate === 'object' && !Array.isArray(body.rate) ? { rate: body.rate as RateConfig } : {}),
            /* 种子三态：不传 = 不改 / null = 清除（回内置演示种子）/ 字符串 = 设新值 */
            ...(body.anchorSeed === undefined ? {} : { anchorSeed: body.anchorSeed === null ? null : String(body.anchorSeed) }),
          },
          by,
        );
        const after = describeSystemConfig(loaded);
        /* 审计只记"谁把哪一格从什么改成什么" + 种子的动作，不记种子值  */
        recordAdminAudit({ actor: by, subject: '系统策略', kind: '变更', before, after: { ...after, anchorSeedAction } });
        console.log(
          `[系统策略] ${by} 改了策略（鉴权 ${loaded.config.authMode} / 会话 ${loaded.config.sessionTtlMinutes} 分钟）：**重启服务后生效**`,
        );
        json(res, 200, { ok: true, data: { ...after, anchorSeedAction, restartRequired: true }, state: stateFor(req) });
      } catch (err) {
        json(res, 200, {
          ok: false,
          code: (err as { code?: string }).code ?? 'E_CONFIG_REJECTED',
          message: (err as Error).message,
          state: stateFor(req),
        });
      }
      return;
    }

    case '/api/qc-content-config': {
      const entry = current();
      try {
        const by = requireAdminSession(req, entry, '内涵质控配置');
        const content = qcContentNow();
        const before = describeQcContentConfig(content);
        const { loaded, tokenAction, rulesRejected } = saveQcContentConfig(
          CONFIG_KV,
          {
            engine: {
              /* 只改地址时不该把形态归零：没给 kind 就沿用当前形态 */
              kind: body.kind === undefined ? content.engine.kind : (String(body.kind) as QcContentEngineKind),
              ...(body.url === undefined ? {} : { url: body.url === null ? '' : String(body.url) }),
              ...(body.expectEngineId === undefined ? {} : { expectEngineId: body.expectEngineId === null ? '' : String(body.expectEngineId) }),
            },
            ...(body.token === undefined ? {} : { token: body.token === null ? null : String(body.token) }),
            ...(body.rules === undefined ? {} : { rules: body.rules as unknown[] }),
          },
          by,
        );
        const after = describeQcContentConfig(loaded);
        recordAdminAudit({ actor: by, subject: '内涵质控配置', kind: '变更', before, after: { ...after, tokenAction } });
        json(res, 200, { ok: true, data: { ...after, tokenAction, rulesRejected }, state: stateFor(req) });
      } catch (err) {
        json(res, 200, {
          ok: false,
          code: (err as { code?: string }).code ?? 'E_CONFIG_REJECTED',
          message: (err as Error).message,
          state: stateFor(req),
        });
      }
      return;
    }

    case '/api/sign-backend-config': {
      /* 电子签名后端配置：与模型/落位配置同一形态（GET 视图 / POST 保存，需管理员）。
         存独立文件 `sign-backend.json`，不进工作区快照，它是部署参数：
         混进快照，"重置工作区"会把它清掉，"备份工作区"会把一套环境的签名服务地址带到另一套环境。 */
      const entry = current();
      /* GET 视图已在 handle() 顶部统一处理，写在这里会排在 405 guard 之后，永远到不了 */
      try {
        const by = requireAdminSession(req, entry, '签名后端配置');
        const before = describeSignConfig(signConfigNow());
        const { loaded, apiKeyAction } = saveSignConfig(
          CONFIG_KV,
          {
            ...(body.http && typeof body.http === 'object' && !Array.isArray(body.http)
              ? { http: body.http as SignConfigInput['http'] }
              : {}),
            ...(body.expectedFingerprint === undefined ? {} : { expectedFingerprint: body.expectedFingerprint as string }),
            ...(body.publicKeyBase64 === undefined ? {} : { publicKeyBase64: body.publicKeyBase64 as string }),
            /* 密钥三态（同模型/采集/落位）：不传 = 不改 / null = 清除 / 字符串 = 设新值 */
            ...(body.apiKey === undefined ? {} : { apiKey: body.apiKey === null ? null : String(body.apiKey) }),
          },
          by,
        );
        const after = describeSignConfig(loaded);
        /* 审计只记"谁把哪一格从什么改成什么" + 密钥动作，不记密钥值  */
        recordAdminAudit({ actor: by, subject: '签名后端配置', kind: '变更', before, after: { ...after, apiKeyAction } });
        json(res, 200, { ok: true, data: { ...after, apiKeyAction }, state: stateFor(req) });
      } catch (err) {
        json(res, 200, {
          ok: false,
          code: (err as { code?: string }).code ?? 'E_CONFIG_REJECTED',
          message: (err as Error).message,
          state: stateFor(req),
        });
      }
      return;
    }

    case '/api/sign-backend/test': {
      /* 测试签名：签一段与病历无关的测试文本，并尽量自验 + 核对指纹。
         它证明的是"服务能签、我们能验"，而不是"服务返回了 200"。
         需要管理后台会话：它会外呼（与改服务地址同类的操作）。 */
      const entry = current();
      let adminId: string;
      try {
        /* 这条不是"变更"（它没改任何配置），所以日志措辞单独给 */
        adminId = requireAdminSession(req, entry, '测试签名', '测试签名后端', 'sign.test');
      } catch (err) {
        /* 正常情况下授权门（`ROUTE_ACTIONS`）已经先拦了，这里是第二道。
           把它写成"透传真实错误码"而不是写死 `E_ADMIN_REQUIRED`：写死会让这一处
           在角色不足时也报"需要管理员"，把"去换人"与"去登录"混成一句。 */
        json(res, 200, {
          ok: false,
          code: (err as { code?: string }).code ?? 'E_AUTH_REQUIRED',
          message: (err as Error).message,
          state: stateFor(req),
        });
        return;
      }
      try {
        /* 密钥要从库里解出来一起递进去：不递的话，「测试签名」在需要认证的签名服务上必然 401，
           而它恰恰是"签章用不了"时唯一的排查入口（报"认证失败"会被读成"配置错了"） */
        const probe = signConfigNow();
        const report = await testSign(probe.config, probe.apiKey === undefined ? {} : { apiKey: probe.apiKey });
        /* 留档：签名服务是"一挂就整体不可用"的依赖，而现状是"只有医生点下去才知道"。
           连诊断结论一起记，事后要能回答"上次能签是什么时候、当时什么状态"。 */
        const detail = describeSignTest(report);
        HEALTH.sign.ok += 1;
        HEALTH.sign.last = { at: new Date().toISOString(), ok: true, latencyMs: report.latencyMs, detail };
        recordAdminAudit({ actor: adminId, subject: '测试签名', kind: '动作', note: detail });
        json(res, 200, { ok: true, data: report, state: stateFor(req) });
      } catch (err) {
        const code = (err as { code?: string }).code ?? 'E_SIGN_TEST_FAILED';
        HEALTH.sign.fail += 1;
        HEALTH.sign.last = { at: new Date().toISOString(), ok: false, detail: `失败：${(err as Error).message}` };
        recordAdminAudit({ actor: adminId, subject: '测试签名', kind: '动作', note: HEALTH.sign.last.detail });
        entry.log.push({
          at: new Date().toISOString(),
          action: `测试签名后端失败（操作者 ${adminId}）`,
          ok: false,
          code,
          message: (err as Error).message,
        });
        json(res, 200, { ok: false, code, message: (err as Error).message, state: stateFor(req) });
      }
      return;
    }

    case '/api/model-config/test': {
      /* 连接测试：只发一段与病历无关的测试文本。
         测试连接不该把真实病历发出去，那等于为了验证"配得对不对"，先把数据送到了对方。 */
      try {
        const ctx = probeContext();
        const started = Date.now();
        const probe = await adapterNow().suggest({
          context: ctx,
          mode: 'polish',
          allowedNodeIds: targetNodeIdsOf(ctx),
          maxItems: 1,
          traceId: `probe-${Date.now()}`,
        });
        const latencyMs = Date.now() - started;
        const detail = `连接正常：${probe.modelId}，耗时 ${latencyMs}ms，返回 ${probe.items.length} 条`;
        HEALTH.model.ok += 1;
        HEALTH.model.last = { at: new Date().toISOString(), ok: true, latencyMs, detail };
        /* 这条路由当前不要求登录（与"测试签名"不一致）。不在这里顺手改权限模型，
           那是另一件事；但审计里记成"未登录调用"，让这条不一致看得见，
           而不是靠一句话口述。 */
        recordAdminAudit({
          actor: actorLabelOf(req),
          subject: '测试连接',
          kind: '动作',
          note: detail,
        });
        json(res, 200, { ok: true, data: { modelId: probe.modelId, latencyMs, items: probe.items.length }, state: stateFor(req) });
      } catch (err) {
        const failedDetail = `连接失败：${(err as Error).message}`;
        HEALTH.model.fail += 1;
        HEALTH.model.last = { at: new Date().toISOString(), ok: false, detail: failedDetail };
        recordAdminAudit({
          actor: actorLabelOf(req),
          subject: '测试连接',
          kind: '动作',
          note: failedDetail,
        });
        json(res, 200, {
          ok: false,
          code: (err as { code?: string }).code ?? 'E_AI_CALL_FAILED',
          message: (err as Error).message,
          state: stateFor(req),
        });
      }
      return;
    }

    case '/api/suggest-low': {
      const entry = current();
      const session = entry.session;
      const nodeId = String(body.nodeId ?? '');
      const node = session.document.nodes[nodeId];
      if (!node) {
        json(res, 200, { ok: false, code: 'E_NODE_NOT_FOUND', message: `节点不存在：${nodeId}` });
        return;
      }
      let response: Awaited<ReturnType<AiAdapter['suggest']>>;
      try {
        const ctx = buildAiContext(session.document, {
          nodeIds: [nodeId],
          contextBefore: 2,
          contextAfter: 0,
          actor: { id: AI.id, kind: AI.kind },
        });
        response = await adapterNow().suggest({
          context: ctx,
          mode: 'complete',
          allowedNodeIds: targetNodeIdsOf(ctx),
          maxItems: modelConfigNow().config.maxItems,
          traceId: `demo-weak-${Date.now()}`,
        });
      } catch (err) {
        json(res, 200, { ok: false, code: (err as { code?: string }).code ?? 'E_AI_CALL_FAILED', message: (err as Error).message, state: stateFor(req) });
        return;
      }
      const draft = response.items.find((item) => item.nodeId === nodeId) ?? response.items[0];
      if (!draft) {
        json(res, 200, { ok: false, code: 'E_AI_NO_SUGGESTION', message: '产出方没有给出针对该节点的建议', state: stateFor(req) });
        return;
      }
      const result = act(entry, 'AI 出建议（弱产出方模拟 · 0.60）', () =>
        session.suggestText(
          { nodeId: draft.nodeId, text: draft.text, confidence: WEAK_SIM_CONFIDENCE, modelId: WEAK_SIM_MODEL_ID, promptId: 'weak-sim' },
          AI,
        ),
      );
      json(res, 200, { ...result, state: stateFor(req) });
      return;
    }

    case '/api/check-consistency': {
      /* 跨文书一致性：纯函数在算（src/model/consistency.ts），这里只负责凑数据。
         注意取同一患者的全部文书，跨患者比对没有意义（那会把两个人报成矛盾）。 */
      const entry = current();
      const patientDocs: string[] = [];
      for (const patient of state.workspace?.patients ?? []) {
        const docs = patient.visits.flatMap((visit) => visit.docs.map((doc) => doc.docId));
        if (docs.includes(entry.docId)) {
          patientDocs.push(...docs);
          break;
        }
      }
      const refs = patientDocs
        .map((docId) => state.entries.get(docId))
        .filter((item): item is DocEntry => !!item)
        .map((item) => ({
          docId: item.docId,
          /* 没有机读块就现算一份（纯函数，不写文档、不留痕），
             否则"没导出过机读信息的文书"会被静默跳过，检查结果看起来正常却是漏的 */
          block:
            item.session.document.machineReadable ??
            buildMachineReadable({
              nodes: item.session.document.nodes,
              rootId: item.session.document.rootId,
              schemaVersion: item.session.document.schemaVersion,
              generatedAt: new Date().toISOString(),
            }),
        }));
      const issues = checkConsistency(refs);
      entry.lastConsistency = { issues, scanned: refs.length };
      json(res, 200, { ok: true, data: { issues, scanned: refs.length }, state: stateFor(req) });
      return;
    }

    case '/api/apply-consistency': {
      const entry = current();
      const key = String(body.key ?? '');
      const issue = (entry.lastConsistency?.issues ?? []).find((item) => `${item.tag.system}|${item.tag.code}` === key);
      if (!issue) {
        json(res, 200, {
          ok: false,
          code: 'E_CONSISTENCY_STALE',
          message: '该问题已不在最近一次检查结果里（文书可能已被修改），请重新检查',
        });
        return;
      }
      const created: Array<{ docId: string; groupId: string; suggestionIds: string[] }> = [];
      const reused: Array<{ docId: string; suggestionIds: string[] }> = [];
      for (const draft of toSuggestionDrafts(issue)) {
        const target = state.entries.get(draft.docId);
        if (!target || !draft.nodeId) continue;
        const { groupId, suggestionIds, reused: reusedIds } = target.session.suggestBatch(
          {
            items: [{ nodeId: draft.nodeId, text: draft.text, confidence: 0.99 }],
            modelId: MODEL_ID,
            promptId: draft.promptId,
            traceId: `consistency:${key}`,
          },
          AI,
        );
        if (groupId === undefined) reused.push({ docId: draft.docId, suggestionIds: reusedIds });
        else created.push({ docId: draft.docId, groupId, suggestionIds });
      }
      /* 处理过的问题从待办里移除，避免反复生成同一批建议 */
      entry.lastConsistency = {
        issues: (entry.lastConsistency?.issues ?? []).filter((item) => item !== issue),
        scanned: entry.lastConsistency?.scanned ?? 0,
      };
      json(res, 200, {
        ok: true,
        action: `生成跨文书核对待办（新增 ${created.length} 份${
          reused.length > 0 ? `，${reused.length} 份已有同样内容待处理` : ''
        }）`,
        data: { created, reused },
        state: stateFor(req),
      });
      return;
    }

    case '/api/dictate': {
      const entry = current();
      const ceiling = dictationCeilingNow();
      const submitted = body.segments;
      let input: DictationInput;
      if (submitted !== undefined) {
        /* 先校验，再干活：下一步可能外呼落位服务（把这次转写的文本发出去），
           一个连出处都不全的请求不该走到那一步。  */
        const transcriptionId = String(body.transcriptionId ?? '').trim();
        const asrModelId = String(body.asrModelId ?? '').trim();
        if (transcriptionId === '' || asrModelId === '') {
          json(res, 200, {
            ok: false,
            code: 'E_AI_NO_PROVENANCE',
            message: '提交真实转写必须同时给出 transcriptionId 与 asrModelId：缺了它们，建议就答不出"这句话什么时候说的、哪个模型听写的"',
            state: stateFor(req),
          });
          return;
        }
        let segments: TranscriptSegment[];
        try {
          segments = validateSubmittedSegments(submitted, { confidenceCeiling: ceiling });
        } catch (err) {
          /* 形状不合法就到此为止：不代编、不静默忽略（消息里说清是哪一项）  */
          json(res, 200, {
            ok: false,
            code: (err as { code?: string }).code ?? 'E_CAPTURE_BAD_SEGMENTS',
            message: (err as Error).message,
            state: stateFor(req),
          });
          return;
        }
        input = {
          transcriptionId,
          asrModelId,
          ...(typeof body.refineModelId === 'string' && body.refineModelId.trim() !== ''
            ? { refineModelId: body.refineModelId.trim() }
            : {}),
          segments,
          at: new Date().toISOString(),
        };
      } else {
        input = demoTranscript(`audio-demo-${Date.now()}`, new Date().toISOString());
      }
      const source: 'capture' | 'demo' = submitted === undefined ? 'demo' : 'capture';
      /* 落位 → 建议这一段与"演示采集"共用（`dictateFromSegments`）：
         两条来源在内核里完全同构，差别只在文本从哪来。  */
      const payload = await dictateFromSegments(entry, input, source);
      json(res, 200, { ...payload, state: stateFor(req) });
      return;
    }

    case '/api/dictate-commit': {
      const entry = current();
      const session = entry.session;
      const record = entry.lastDictation;
      if (!record) {
        json(res, 200, { ok: false, code: 'E_NO_DICTATION', message: '还没有转写记录：请先"模拟一段录音转写"', state: stateFor(req) });
        return;
      }
      const transcriptionId = String(body.transcriptionId ?? '');
      if (transcriptionId !== record.transcriptionId) {
        json(res, 200, {
          ok: false,
          code: 'E_DICTATION_STALE',
          message: '提交的转写标识与最近一次不一致（可能已重新转写）：请基于当前转写重新指定落点',
          state: stateFor(req),
        });
        return;
      }
      const byIndex = new Map<number, string>();
      for (const item of Array.isArray(body.targets) ? body.targets : []) {
        const index = Number((item as { index?: unknown }).index);
        const nodeId = String((item as { nodeId?: unknown }).nodeId ?? '').trim();
        if (Number.isInteger(index) && nodeId !== '') byIndex.set(index, nodeId);
      }
      const missing = record.segments.filter((segment) => !byIndex.has(segment.index));
      if (missing.length > 0) {
        json(res, 200, {
          ok: false,
          code: 'E_PLACEMENT_INCOMPLETE',
          message: `还有 ${missing.length} 段没指定落点（第 ${missing.map((segment) => segment.index).join('、')} 段）：落位必须明确，内核不接受"半落位"`,
          state: stateFor(req),
        });
        return;
      }
      const segments: TranscriptSegment[] = record.segments.map((segment) => ({
        index: segment.index,
        text: segment.text,
        confidence: segment.confidence,
        ...(segment.startSec !== undefined ? { startSec: segment.startSec } : {}),
        ...(segment.endSec !== undefined ? { endSec: segment.endSec } : {}),
      }));
      const targetNodeIds = segments.map((segment) => byIndex.get(segment.index) as NodeId);
      const payload = act(entry, `按医生指定的落点生成建议（${segments.length} 段）`, () =>
        session.dictate(
          {
            transcriptionId,
            asrModelId: record.asrModelId,
            ...(record.refineModelId ? { refineModelId: record.refineModelId } : {}),
            segments,
            targetNodeIds,
            maxConfidence: dictationCeilingNow(),
          },
          AI,
        ),
      ) as { ok: boolean; data?: { groupId: string; warnings: string[] } };
      if (!payload.ok || !payload.data) {
        json(res, 200, { ...payload, state: stateFor(req) });
        return;
      }
      entry.lastDictation = {
        ...record,
        groupId: payload.data.groupId,
        /* 重复提交会让同一条提示反复出现（如"多段同节点"）：去重，避免界面越点越乱 */
        warnings: [...record.warnings, ...payload.data.warnings].filter((text, position, list) => list.indexOf(text) === position),
        placements: record.placements.map((item) => {
          const nodeId = byIndex.get(item.index);
          return nodeId ? { index: item.index, text: item.text, nodeId, reason: '医生指定' } : item;
        }),
        unplaced: 0,
        submitted: true,
      };
      json(res, 200, { ok: true, data: { ...entry.lastDictation, strategy: placementConfigNow().config.strategy }, state: stateFor(req) });
      return;
    }

    case '/api/dictation/capture/segment': {
      const entry = current();
      const config = captureConfigNow();
      const query = new URLSearchParams((req.url ?? '').split('?')[1] ?? '');
      const sessionId = (query.get('sessionId') ?? '').trim();
      const indexRaw = query.get('index');
      const index = Number(indexRaw);
      try {
        if (sessionId === '') {
          throw new CaptureError('E_CAPTURE_UPLOAD_INVALID', '缺少 sessionId：转写标识要用采集会话本身，服务端不代编一个');
        }
        if (!Number.isInteger(index) || index < 1) {
          throw new CaptureError('E_CAPTURE_UPLOAD_INVALID', `缺少合法的段号 index，实际 ${JSON.stringify(indexRaw)}：段号是时间区间的锚`);
        }
        const contentType = req.headers['content-type'];
        const { filename, bytes } = parseMultipartAudio(Array.isArray(contentType) ? contentType[0] : contentType, rawBody);
        /* `task_id` 不回给前端：它是 ASR 的内部标识，前端拿到它就想自己轮询，
           而"前端看不到 ASR 协议"正是这条路线选同源转发的原因（第二节）。  */
        const { text, modelId, confidenceNote } = await transcribeSegmentViaAsr(config, { index, audio: bytes, sessionId });
        noteCaptureSession(sessionId, config.config.asr.endpoint, actorLabelOf(req));
        json(res, 200, {
          ok: true,
          data: {
            index,
            sessionId,
            filename,
            text,
            audioBytes: bytes.byteLength,
            /* 模型标识由部署声明（该接口不返回模型信息）：前端把它写进 `asrModelId`，
               留痕里那句"哪个模型听写的"才有出处  */
            modelId,
            /* "ASR 未提供置信度"这句标注由服务端给出（界面照抄，不自己编）：
               它是同一条纪律的一部分（未知按上限处理），两处各写一句迟早会不一致。  */
            confidenceNote,
          },
          state: stateFor(req),
        });
      } catch (err) {
        json(res, 200, {
          ok: false,
          code: (err as { code?: string }).code ?? 'E_CAPTURE_FAILED',
          message: (err as Error).message,
          state: stateFor(req),
        });
      }
      return;
    }

    case '/api/dictation/capture/records/clear': {
      const entry = current();
      const docId = boundedText(body.docId, 80);
      if (docId === '' || docId !== entry.docId) {
        json(res, 200, {
          ok: false,
          code: 'E_CAPTURE_RECORD_SCOPE',
          message: '只能清空当前这份病历的采集记录',
          state: stateFor(req),
        });
        return;
      }
      const cleared = dictationRecordsClear(docId);
      /* 写盘失败时 `remaining > 0`：这句话必须如实说，否则医生以为清了、下次刷新它又回来了 */
      if (cleared.remaining > 0) {
        json(res, 200, {
          ok: false,
          code: 'E_CAPTURE_RECORD_CLEAR_FAILED',
          message: `还有 ${cleared.remaining} 条没清掉（记录文件写不进去）`,
          data: { ...cleared, docId },
          state: stateFor(req),
        });
        return;
      }
      json(res, 200, {
        ok: true,
        data: { ...cleared, docId, retentionDays: DICTATION_RETENTION_DAYS },
        state: stateFor(req),
      });
      return;
    }

    case '/api/dictation/capture/session': {
      /* 一次采集结束时的汇总。字段表刻意不收文本、不收音频：
         文本已经作为建议走 `/api/dictate`（有来源、有留痕），再抄一份到这里
         就成了第二份病历内容副本，而它的生命周期与门控和正文完全不是一回事。  */
      const entry = current();
      const total = boundedInt(body.total, 10000);
      const failed = boundedInt(body.failed, 10000);
      const atRaw = boundedText(body.at, 40);
      const endedAt = new Date().toISOString();
      const at = Number.isFinite(Date.parse(atRaw)) ? new Date(atRaw).toISOString() : endedAt;
      const record: DictationRecord = {
        id: `cap-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        at,
        endedAt,
        docId: entry.docId,
        docTitle: boundedText(body.docTitle, 40),
        actor: actorLabelOf(req),
        device: boundedText(body.device, 120),
        client: boundedText(body.client, 40),
        elapsedSec: boundedSeconds(body.elapsedSec, 24 * 3600),
        total,
        uploaded: Math.min(boundedInt(body.uploaded, 10000), total),
        failed: Math.min(failed, total),
        shortDropped: boundedInt(body.shortDropped, 10000),
        asrConfigured: body.asrConfigured === true,
        asrModel: boundedText(body.asrModel, 80),
        problem: boundedText(body.problem, 40),
        /* 结论按段数推，不信请求里自报的"成功"：
           total=0 说明一段都没定稿；failed>=total 说明这次没有任何一段转成 */
        outcome: 'ok',
      };
      record.outcome = record.total === 0 || record.failed >= record.total
        ? 'failed'
        : record.failed > 0 ? 'partial' : 'ok';
      json(res, 200, {
        ok: true,
        data: { record, records: dictationRecordsAppend(record), retentionDays: DICTATION_RETENTION_DAYS },
        state: stateFor(req),
      });
      return;
    }

    case '/api/dictation/capture/demo-run': {
      const entry = current();
      const config = captureConfigNow();
      if (!config.configured) {
        json(res, 200, {
          ok: false,
          code: 'E_CAPTURE_NOT_CONFIGURED',
          /* 文案里不许出现 Markdown 语法：它会原样进 toast（`A14` 的纪律，但那条只扫前端文件，
             扫不到服务端文案 —— 实测就是靠真实渲染发现的）。  */
          message: '未配置语音识别服务：演示采集也要真的走一遍转发，不会退回模拟转写',
          state: stateFor(req),
        });
        return;
      }
      const sessionId = String(body.sessionId ?? '').trim() || `demo-capture-${Date.now()}`;
      let timeline: Array<{ seconds: number; voiced: boolean }>;
      try {
        const raw = Array.isArray(body.timeline) && body.timeline.length > 0 ? body.timeline : null;
        timeline = raw === null ? DEFAULT_CAPTURE_DEMO_TIMELINE : parseDemoTimeline(raw);
      } catch (err) {
        json(res, 200, {
          ok: false,
          code: (err as { code?: string }).code ?? 'E_CAPTURE_BAD_TIMELINE',
          message: (err as Error).message,
          state: stateFor(req),
        });
        return;
      }
      const source = createSampleCaptureSource({ timeline });
      captureStop = () => source.stop();
      const startedAt = new Date().toISOString();
      const progressRecord = (patch: Partial<CaptureRunRecord>): CaptureRunRecord => ({
        sessionId,
        phase: 'recording',
        elapsedSec: 0,
        currentChunkSec: 0,
        finalized: 0,
        transcribed: 0,
        failures: [],
        sourceId: source.id,
        startedAt,
        finishedAt: null,
        outcome: null,
        ...(entry.lastCapture ?? {}),
        ...patch,
      });
      entry.lastCapture = progressRecord({});
      try {
        const outcome = await runDictationCapture(
          {
            sessionId,
            source,
            segment: config.config.segment,
            onProgress: (progress) => {
              /* 逐段进度写进 state：界面据此画录音指示、计时与"转写中 N 段 / 已完成 M 段" */
              entry.lastCapture = progressRecord({
                phase: progress.phase,
                elapsedSec: progress.elapsedSec,
                currentChunkSec: progress.currentChunkSec,
                finalized: progress.finalized,
                transcribed: progress.transcribed,
                failures: progress.failures,
              });
            },
          },
          {
            transcriber: (params) => transcribeSegmentViaAsr(config, params),
            submitter: async (params) => {
              /* 即便这段数据是进程内来的，也走同一份校验：置信度必须由服务端按上限填，
                 而"服务端填置信度"这条规则一旦有两条实现（一条给 HTTP、一条给进程内），
                 它们迟早会不一致 —— 那正是这一层最不该出的事。  */
              let segments: TranscriptSegment[];
              try {
                segments = validateSubmittedSegments(params.segments, { confidenceCeiling: dictationCeilingNow() });
              } catch (err) {
                return {
                  ok: false,
                  code: (err as { code?: string }).code ?? 'E_CAPTURE_BAD_SEGMENTS',
                  message: (err as Error).message,
                };
              }
              return dictateFromSegments(
                entry,
                { transcriptionId: params.transcriptionId, asrModelId: params.asrModelId, segments, at: new Date().toISOString() },
                'capture',
              );
            },
          },
        );
        entry.lastCapture = progressRecord({ phase: 'done', outcome, finishedAt: new Date().toISOString() });
        json(res, 200, { ok: true, data: { outcome }, state: stateFor(req) });
      } catch (err) {
        const code = (err as { code?: string }).code ?? 'E_CAPTURE_FAILED';
        const message = (err as Error).message;
        const howTo = err instanceof CaptureSourceError ? err.howTo : undefined;
        entry.lastCapture = progressRecord({
          phase: 'failed',
          finishedAt: new Date().toISOString(),
          error: { code, message },
          ...(howTo ? { howTo } : {}),
        });
        json(res, 200, { ok: false, code, message, ...(howTo ? { howTo } : {}), state: stateFor(req) });
      } finally {
        captureStop = null;
      }
      return;
    }

    case '/api/dictation/capture/demo-stop': {
      /* 医生按停：采集源立即收尾，当前那一段立刻定稿（设计第四节）。
         停止本身不该失败 —— 它被按停时抛错，只会让人以为出了别的问题。  */
      if (captureStop === null) {
        json(res, 200, { ok: false, code: 'E_NO_CAPTURE_RUN', message: '当前没有正在进行的采集', state: stateFor(req) });
        return;
      }
      await captureStop();
      json(res, 200, { ok: true, data: { stopped: true }, state: stateFor(req) });
      return;
    }

    case '/api/qc-form-check': {
      /* 形式类质控：纯本地、无外部依赖，所以它能被"随时跑一次"。
         产出走旁挂注解（不改 rev、不进文档留痕），且每条都带规则号，
         对应内核"system 来源必须给依据"的要求：医生看到的每句话都要能追到出处。 */
      const entry = current();
      const session = entry.session;
      /* 规则来自已装载并启用的规则包（不是硬编码的默认集）：
         医院关掉哪一条，这里就少跑哪一条，与 `stateFor(req).formRules` 同一口径。
         注：规则集现在是两个包（形式类 + 时限类），这里不用分别处理，
         `rulesFromRegistry` 取的是全部已启用的规则类包，新加一族规则不需要改这里。

         判定上下文里的 `now` 取服务端口时钟：时限判定要"现在几点"，
         而引擎与谓词都必须是可复现的纯函数，所以这个时刻只能由外面给。 */
      const scan = runFormRules(
        session.document.nodes,
        /* 跨文书判定要的事实：同一次就诊的全部文书（类型 + 成文时刻）。
           它只有服务端知道（一份文书自己看不到别的文书），所以由这里补进上下文。
           拿不到就不带这个字段，频次类规则会走"未判定"，而不是当成都写齐了。 */
        { ...qcContextOf(session.document, new Date().toISOString()), visitDocs: visitDocsOf(entry.docId) },
        rulesFromRegistry(packRegistry, conditionLibrary()),
      );
      entry.lastQcUnevaluated = scan.unevaluated;
      let created = 0;
      let already = 0;
      for (const hit of scan.hits) {
        const result = session.annotate(
          {
            nodeId: hit.nodeId,
            kind: 'form',
            severity: hit.severity,
            title: hit.title,
            detail: hit.detail,
            suggestion: hit.suggestion,
            ...(hit.quote ? { quote: hit.quote } : {}),
            source: { kind: 'system', ruleId: hit.ruleId },
            /* 去重：同规则同节点只留一条（已忽略的不复活，但内容改了可重新提） */
            dedupeKey: `${hit.ruleId}:${hit.nodeId}`,
          },
          SYSTEM,
        );
        if (result.created) created += 1;
        else already += 1;
      }
      entry.log.push({
        at: new Date().toISOString(),
        action:
          `质控扫描：扫描 ${scan.scannedNodes} 个节点 / ${scan.rules} 条规则，命中 ${scan.hits.length} 条（新增 ${created}，已在册 ${already}）` +
          /* "没判成"的那部分也要进日志：只说命中数，会把"有一批根本没判"读成"都查过了" */
          (scan.unevaluated.length > 0 ? `；未判定 ${scan.unevaluated.length} 条` : ''),
        ok: true,
      });
      json(res, 200, {
        ok: true,
        data: {
          rules: scan.rules,
          scannedNodes: scan.scannedNodes,
          hits: scan.hits.length,
          created,
          already,
          unevaluated: scan.unevaluated,
        },
        state: stateFor(req),
      });
      return;
    }

    case '/api/visit-timeline': {
      const entry = current();
      const line = visitLineOf(entry.docId);
      /* 不在任何就诊下（如导入的孤立文书）时，它自己就是这条线：轴不能是空的 */
      const items: Array<{ docId: string; title: string }> = line
        ? line.docs.map((item) => ({ docId: item.docId, title: item.title }))
        : [{ docId: entry.docId, title: '' }];
      const axisDocs = items.map((item) => {
        const loaded = state.entries.get(item.docId)?.session.document;
        return {
          docId: item.docId,
          title: item.title || (loaded?.docType?.display ?? item.docId),
          docTypeCode: loaded?.docType?.code ?? '',
          ...(loaded?.docType?.display ? { docTypeDisplay: loaded.docType.display } : {}),
          /* 读不到的文书成文时刻给空串：轴会把它排到最后并标成"时间无法解析"，
             而不是把它丢掉 —— 丢一个点会让这条线看起来是连着的 */
          createdAt: loaded?.createdAt ?? '',
          ...(loaded?.status ? { status: loaded.status } : {}),
          isCurrent: item.docId === entry.docId,
          ...(loaded ? { doc: loaded } : {}),
        };
      });
      const currentDoc = entry.session.document;
      const timeline = buildVisitTimeline({
        /* 判定时刻取服务端口时钟：与 `/api/qc-form-check` 同一处置（引擎与谓词必须是纯函数） */
        now: new Date().toISOString(),
        ...(line ? { visitId: line.visitId } : {}),
        ...(line?.visitType ?? currentDoc.encounter?.visitType
          ? { visitType: line?.visitType ?? currentDoc.encounter?.visitType }
          : {}),
        ...(currentDoc.encounter?.admittedAt ? { admittedAt: currentDoc.encounter.admittedAt } : {}),
        ...(currentDoc.encounter?.dischargedAt ? { dischargedAt: currentDoc.encounter.dischargedAt } : {}),
        visitDocs: axisDocs,
        rules: crossDocRulesOf(packRegistry),
      });
      entry.lastVisitTimeline = timeline;
      entry.log.push({
        at: new Date().toISOString(),
        action:
          `就诊时间轴：${timeline.docs.length} 份文书 / ${timeline.segments.length} 段间隔，缺口 ${timeline.gaps.length} 条` +
          /* 判不了的那部分也要进日志：只说缺口数，会把"有一批根本没判"读成"这条线是连的" */
          (timeline.unevaluated.length > 0 ? `；未判定 ${timeline.unevaluated.length} 条` : ''),
        ok: true,
      });
      json(res, 200, { ok: true, data: timeline, state: stateFor(req) });
      return;
    }

    case '/api/visit-compare': {
      /* 跨次就诊对比：同一患者、按成文时刻倒序列出其他文书，默认挑"同诊断且最近"的一份并排对照。
         边界只到同一位患者：不跨患者、不跨租户 —— 跨患者读数据走受控阅读授权
         （申请—授权—留痕），不能被这里顺手绕过。
         每次读取都进日志：看别人的历史文书是敏感动作，日志要能回答"谁在什么时候看了谁"。  */
      const entry = current();
      const currentDoc = entry.session.document;
      const line = patientLineOf(entry.docId);
      if (!line) {
        json(res, 200, { ok: false, code: 'E_NO_PATIENT', message: '这份文书没有挂在任何患者下，无法跨次对比' });
        return;
      }
      const candidates: Array<{
        docId: string;
        title: string;
        createdAt: string;
        status: string;
        visitType: string;
        visitDate: string;
        sameDiagnosis: boolean;
        sharedDiagnosis: string[];
        changedSections: number;
      }> = [];
      for (const visit of line.patient.visits) {
        for (const item of visit.docs) {
          if (item.docId === entry.docId) continue;
          /* 只在已装载的文书里找：历史文书在启动时整库装载，这里不该再去解密读盘  */
          const other = state.entries.get(item.docId);
          if (!other) continue;
          const doc = other.session.document;
          const probe = compareVisits(doc, currentDoc);
          candidates.push({
            docId: item.docId,
            title: item.title || doc.docType?.display || item.docId,
            createdAt: doc.createdAt,
            status: doc.status,
            visitType: visit.visitType ?? '',
            visitDate: visit.date ?? '',
            sameDiagnosis: probe.sameDiagnosis,
            sharedDiagnosis: probe.diagnosis.shared.map((tag) => tag.display ?? tag.code),
            changedSections: probe.changedSections,
          });
        }
      }
      candidates.sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));

      const requested = String(body.previousDocId ?? '');
      /* 默认基线必须是更早的文书："上次怎么写的"里那个"上次"是时间意义上的。
         后面的文书照样列在候选里（医生可能想对照出院记录），但不做默认 ——
         把"下一次"当成"上一次"，会让"沿用上次医嘱"变成"沿用未来的医嘱"。  */
      const earlier = candidates.filter((item) => String(item.createdAt) < String(currentDoc.createdAt));
      const pool = earlier.length > 0 ? earlier : candidates;
      const chosen = (requested !== '' ? candidates.find((item) => item.docId === requested) : undefined)
        ?? pool.find((item) => item.sameDiagnosis)
        ?? pool[0];
      const previousDoc = chosen ? state.entries.get(chosen.docId)?.session.document : undefined;
      const compare = previousDoc ? compareVisits(previousDoc, currentDoc) : null;

      /* 沿用用药建议要落在本次文书的对应章节上。章节本身不承载文字，
         所以落到它下面的第一个文本节点；本次没有对应章节就如实不给按钮
         —— 让医生先建章节，比把医嘱塞进"主诉"下面要好。  */
      let medicationTarget: { nodeId: string; title: string } | null = null;
      if (compare && compare.medication.paragraphs.length > 0) {
        const sections = Object.values(currentDoc.nodes).filter((node) => node.type === 'section');
        const byCode = compare.medication.code
          ? sections.find((node) => node.sectionCode === compare.medication.code)
          : undefined;
        const target = byCode
          ?? sections.find((node) => /(医嘱|用药|处方|处理|治疗)/.test(String(node.title ?? '')));
        if (target) {
          const paragraph = Object.values(currentDoc.nodes)
            .find((node) => node.type === 'paragraph' && node.parentId === target.id);
          const textNode = paragraph
            ? Object.values(currentDoc.nodes).find((node) => node.type === 'text' && node.parentId === paragraph.id)
            : undefined;
          if (paragraph && textNode) medicationTarget = { nodeId: textNode.id, title: target.title ?? target.id };
        }
      }

      entry.log.push({
        at: new Date().toISOString(),
        action: `跨次对比：${line.patient.nameMasked} 的历史文书 ${candidates.length} 份`
          + (chosen ? `，与 ${chosen.docId} 对照（差异 ${compare?.changedSections ?? 0} 章）` : '，没有可对照的历史文书'),
        ok: true,
      });
      /* 结果存进 entry：界面每次重渲染都从 state 取，否则改一个字就把并排视图刷掉 */
      const payload: VisitCompareState = {
        patientId: line.patientId,
        patientName: line.patient.nameMasked,
        candidates,
        chosenDocId: chosen?.docId ?? null,
        compare,
        medicationTarget,
      };
      entry.lastVisitCompare = payload;
      json(res, 200, { ok: true, data: payload, state: stateFor(req) });
      return;
    }

    case '/api/discharge-summary': {
      const entry = current();
      const line = visitLineOf(entry.docId);
      if (!line) {
        json(res, 200, { ok: false, code: 'E_NO_VISIT', message: '这份文书没有挂在任何就诊下，无法汇总' });
        return;
      }
      /* 非住院不提供：门诊 / 急诊 / 体检没有住院过程可汇总。
         界面已按 state 不摆入口，这里再挡一次 —— "入口看不见"不是安全边界。 */
      const applicability = dischargeSummaryApplicability({
        visitType: entry.session.document.encounter?.visitType ?? line.visitType,
        imported: String(line.visitId).startsWith('V_IMPORT_'),
      });
      if (!applicability.applicable) {
        json(res, 200, { ok: false, code: 'E_NOT_INPATIENT', message: applicability.reason ?? '本次就诊不是住院' });
        return;
      }
      const docs: SummaryDoc[] = [];
      for (const item of line.docs) {
        const summaryDoc = summaryDocOf(item.docId, item.title);
        if (summaryDoc) docs.push(summaryDoc);
      }
      const plan = planDischargeSummary({ currentDocId: entry.docId, docs });
      entry.lastDischargeSummary = plan;
      entry.log.push({
        at: new Date().toISOString(),
        action: `出院汇总：${plan.items.length} 条可派生 / ${plan.gaps.length} 条缺口（只算不写）`,
        ok: true,
      });
      json(res, 200, { ok: true, data: plan, state: stateFor(req) });
      return;
    }

    case '/api/discharge-summary/apply': {
      /* 生成建议 = 把原文送进建议通道，不落笔。
         出院诊断是 `keyContent`，置信度给 0.99 也仍然要人工确认 ——
         门控在落笔这一步，原文搬运不构成例外（与「沿用上次医嘱」同一口径）。  */
      const entry = current();
      const applyLine = visitLineOf(entry.docId);
      const applyApplicability = dischargeSummaryApplicability({
        visitType: entry.session.document.encounter?.visitType ?? applyLine?.visitType ?? '',
        imported: String(applyLine?.visitId ?? '').startsWith('V_IMPORT_'),
      });
      if (!applyApplicability.applicable) {
        json(res, 200, { ok: false, code: 'E_NOT_INPATIENT', message: applyApplicability.reason ?? '本次就诊不是住院' });
        return;
      }
      const plan = entry.lastDischargeSummary;
      if (!plan) {
        json(res, 200, { ok: false, code: 'E_NOT_READ', message: '先点「汇总本次住院」读一次，再生成建议' });
        return;
      }
      const keys = Array.isArray(body.keys) ? body.keys.map((key: unknown) => String(key)) : [];
      const chosen = plan.items.filter((item) => keys.length === 0 || keys.includes(item.key));
      const blocked = chosen
        .filter((item) => item.targetNodeId === null)
        .map((item) => ({
          key: item.key,
          code: 'E_TARGET_SECTION_MISSING',
          message: `本次文书没有「${item.title}」章节：先建章节，再生成建议`,
        }));
      const ready: Array<{ nodeId: NodeId; text: string; confidence: number; evidence: EvidenceRef[] }> = [];
      for (const item of chosen) {
        const nodeId = item.targetNodeId;
        if (nodeId === null || item.text.trim() === '') continue;
        ready.push({
          nodeId,
          text: item.text,
          /* 0.99 是"门控口径"（原文摘录，不是模型推测），不是"我更自信"：
             关键内容（出院诊断）的阈值高于一般内容，给低了会出现"原文搬过来却落不了笔" */
          confidence: 0.99,
          /* 逐段挂来源：哪句话出自哪份文书的哪个节点，采纳后仍可点回去核 */
          evidence: item.sources.map((source) => ({
            kind: 'emr-prior',
            ref: `doc:${source.docId}`,
            nodeId: source.nodeId,
            field: source.sectionTitle,
            valueText: source.text,
            capturedAt: source.createdAt,
          })),
        });
      }
      if (ready.length === 0) {
        json(res, 200, {
          ok: false,
          code: 'E_NOTHING_TO_SUGGEST',
          message: '没有可生成建议的条目',
          blocked,
          state: stateFor(req),
        });
        return;
      }
      const result = entry.session.suggestBatch({
        items: ready,
        modelId: DISCHARGE_SUMMARY_MODEL,
        promptId: 'discharge-summary',
        traceId: `discharge-summary:${entry.docId}`,
      }, SYSTEM);
      entry.log.push({
        at: new Date().toISOString(),
        action: `出院汇总：生成建议 ${result.suggestionIds.length} 条（未落笔，需人工采纳）`
          + (blocked.length > 0 ? `；${blocked.length} 条因缺目标章节未能生成` : ''),
        ok: true,
      });
      json(res, 200, { ok: true, data: result, blocked, state: stateFor(req) });
      return;
    }

    case '/api/previsit-config': {
      /* 预问诊接入配置（GET 视图在 `handle()` 顶部的 `configViews`）。
         只有两格：要不要校验、密钥是什么（三态：不传不改 / null 清除 / 字符串设新值）。
         它决定"谁可以往病历里写患者自述"，所以列进 `ROUTE_ACTIONS`，两种模式都要管理员。 */
      const entry = current();
      try {
        const by = requireAdminSession(req, entry, '预问诊接入');
        let before: Record<string, unknown> = {};
        try {
          before = describeAccess(loadAccess(CONFIG_KV), AUTH_MODE) as unknown as Record<string, unknown>;
        } catch (err) {
          /* 库里那行解不开：前后对照要给出来，但不能因此假装"没配过" */
          before = { error: (err as Error).message };
        }
        const { record, keyAction } = saveAccess(
          CONFIG_KV,
          {
            ...(body.enabled === undefined ? {} : { enabled: body.enabled === true || body.enabled === 'true' }),
            /* 三态与采集配置同一套：不传 = 不改；null = 清除；字符串 = 设新值 */
            ...(body.key === undefined ? {} : { key: body.key === null ? null : String(body.key) }),
          },
          by,
          new Date().toISOString(),
        );
        const after = describeAccess(record, AUTH_MODE);
        /* 审计只记"从什么状态到什么状态"+ 密钥动作。
           不记密钥值，连哈希也不记 —— 哈希在审计里没有用处，只会让人以为能从它反推。  */
        recordAdminAudit({
          actor: by,
          subject: '预问诊接入',
          kind: '变更',
          before,
          after: { ...after, keyAction },
          note: after.note,
        });
        json(res, 200, { ok: true, data: { ...after, keyAction }, state: stateFor(req) });
      } catch (err) {
        json(res, 200, {
          ok: false,
          code: (err as { code?: string }).code ?? 'E_CONFIG_REJECTED',
          message: (err as Error).message,
          state: stateFor(req),
        });
      }
      return;
    }

    case '/api/previsit/read': {
      /* 读一次 = 一次留痕。预问诊是外部写进来的内容，谁在什么时候把它摊开看过、
         看的是哪一份，以后要能查（与"跨次对比"的读取同一处置）。 */
      const entry = current();
      const patientId = entry.session.document.patient.patientId;
      /* `force`：候诊到接诊之间患者可能刚提交，所以"读一次"按钮必须绕过缓存 */
      const read = previsitOfPatient(patientId, true);
      if (!read.ok) {
        json(res, 200, { ok: false, code: read.code, message: read.message });
        return;
      }
      entry.log.push({
        at: new Date().toISOString(),
        action: `预问诊：读取 ${patientId} 的预问诊单（${read.record ? `提交于 ${read.record.submittedAt}` : '没有'}）（只读，不写文书）`,
        ok: true,
      });
      json(res, 200, { ok: true, data: { count: read.record ? 1 : 0, readAt: read.readAt }, state: stateFor(req) });
      return;
    }

    case '/api/previsit/intake': {
      /* 外部写入：候诊时患者自填（或 HIS 预问诊端代传）的内容从这里进来。
         它不碰任何文书：预问诊发生在接诊之前，那时门诊病历可能还不存在；
         更要紧的是，`status:draft` 的文书有 `createdBy`，系统不能替医生预建一份病历。

         这里只登记，不判断：不识别症状、不推断诊断、不给建议。  */
      /* 准入先于解析：未通过的调用方不该拿到"你第 2 条写得不对"这种校验反馈 */
      let accessRecord;
      try {
        accessRecord = loadAccess(CONFIG_KV);
      } catch (err) {
        json(res, 200, {
          ok: false,
          code: 'E_PREVISIT_CONFIG_UNREADABLE',
          message: `预问诊接入配置在库里但解不开，拒绝写入（不会当作"没配过"继续）：${(err as Error).message}`,
        });
        return;
      }
      const access = checkAccess({
        record: accessRecord,
        presentedKey: headerOf(req, PREVISIT_KEY_HEADER),
        /* 演示模式下"从没配过"放行 —— 与系统里 `authMode` 的两档同一把尺子。
           "已启用但没密钥"不在此列：那是配置不完整，一律拒绝。 */
        allowUnconfigured: AUTH_MODE !== 'strict',
      });
      if (!access.ok) {
        /* 被拒也进管理审计：谁在什么时候试图往病历里写预问诊、被哪一条挡下，
           是这类外部写入接口最该留下的记录。 */
        recordAdminAudit({
          actor: actorLabelOf(req),
          subject: '预问诊接入',
          kind: '动作',
          note: `拒绝（${access.code}）：${access.message}`,
        });
        json(res, 200, { ok: false, code: access.code, message: access.message });
        return;
      }

      const now = new Date().toISOString();
      const parsed = parsePrevisitIntake(body, now);
      if (!parsed.ok) {
        json(res, 200, { ok: false, code: parsed.code, message: parsed.message });
        return;
      }
      const known = (state.workspace?.patients ?? []).some((patient) => patient.patientId === parsed.record.patientId);
      if (!known) {
        json(res, 200, {
          ok: false,
          code: 'E_PATIENT_NOT_FOUND',
          message: `患者不存在：${parsed.record.patientId}（预问诊必须挂在已建档的患者上，否则接诊时找不到它）`,
        });
        return;
      }
      /* 只写这一位患者那一行（同患者 + 同就诊覆盖），并让本次接诊的缓存失效 */
      const saved = savePrevisitOfPatient(parsed.record.patientId, parsed.record);
      if (!saved.ok) {
        json(res, 200, { ok: false, code: saved.code, message: saved.message });
        return;
      }
      process.stdout.write(`[预问诊] 收到 ${parsed.record.patientId} 的表单：${parsed.record.items.length} 项，来源 ${parsed.record.source}（准入 ${access.mode}）\n`);
      /* `auth` 如实回给调用方：`unconfigured-demo` 表示"这一次是没校验进来的"，
         对方（或排查的人）能据此判断"到底是我密钥配对了，还是压根没人拦"。 */
      json(res, 200, { ok: true, data: parsed.record, auth: access.mode, state: stateFor(req) });
      return;
    }

    case '/api/previsit/take': {
      /* 生成建议 = 把患者写的原文交进建议通道，不落笔。
         置信度给 0.99 是"门控口径"（内容是他自己写的，不是模型推测），
         但采纳仍必须由医生逐条点 —— 患者自述进入病历这件事本身就要人负责。  */
      const entry = current();
      const patientId = entry.session.document.patient.patientId;
      const read = previsitOfPatient(patientId);
      if (!read.ok) {
        json(res, 200, { ok: false, code: read.code, message: read.message });
        return;
      }
      const record = read.record;
      if (!record) {
        json(res, 200, { ok: false, code: 'E_NO_PREVISIT', message: '这位患者没有预问诊记录：先由 HIS / 患者端经接口写入' });
        return;
      }
      const keys = Array.isArray(body.keys) ? body.keys.map((key: unknown) => String(key)) : [];
      const drafts = planPrevisitDrafts(record, keys, sectionAnchorsOf(entry.session.document));
      const ready = drafts
        .filter((draft): draft is typeof draft & { nodeId: NodeId } => draft.nodeId !== null)
        .map((draft) => ({
          nodeId: draft.nodeId,
          text: draft.text,
          confidence: 0.99,
          evidence: [draft.evidence],
        }));
      const blocked = drafts
        .filter((draft) => draft.nodeId === null)
        .map((draft) => ({ key: draft.key, label: draft.label, sectionCode: draft.sectionCode }));
      if (ready.length === 0) {
        json(res, 200, {
          ok: false,
          code: 'E_NO_TARGET_SECTION',
          message: '本次文书里没有对应的章节：先在文书里建出主诉 / 现病史等章节，再谈落点',
          blocked,
          state: stateFor(req),
        });
        return;
      }
      const result = entry.session.suggestBatch({
        items: ready,
        modelId: PREVISIT_MODEL,
        promptId: 'previsit-intake',
        traceId: `previsit:${patientId}@${record.submittedAt}`,
      }, SYSTEM);
      entry.log.push({
        at: new Date().toISOString(),
        action: `预问诊：为 ${patientId} 生成建议 ${result.suggestionIds.length} 条（患者自填，未落笔，需医生逐条采纳）`
          + (blocked.length > 0 ? `；${blocked.length} 条因缺目标章节未生成` : ''),
        ok: true,
      });
      json(res, 200, { ok: true, data: result, blocked, state: stateFor(req) });
      return;
    }

    case '/api/compare/carry-over': {
      const entry = current();
      const session = entry.session;
      const nodeId = String(body.targetNodeId ?? '');
      const text = typeof body.text === 'string' ? body.text : '';
      const node = session.document.nodes[nodeId];
      if (!node) {
        json(res, 200, { ok: false, code: 'E_NODE_NOT_FOUND', message: `节点不存在：${nodeId}` });
        return;
      }
      if (node.type !== 'text') {
        json(res, 200, { ok: false, code: 'E_TYPE_MISMATCH', message: '沿用只能落在文本段落上' });
        return;
      }
      if (text.trim() === '') {
        json(res, 200, { ok: false, code: 'E_EMPTY_TEXT', message: '没有可沿用的原文' });
        return;
      }
      const { suggestionId } = session.suggestText(
        { nodeId, text, confidence: 0.99, modelId: 'compare.carry-over', promptId: 'visit-compare' },
        AI,
      );
      entry.log.push({
        at: new Date().toISOString(),
        action: `沿用上次医嘱：在 ${nodeId} 生成建议 ${suggestionId}（未落笔，需人工采纳）`,
        ok: true,
      });
      json(res, 200, { ok: true, data: { suggestionId }, state: stateFor(req) });
      return;
    }

    case '/api/qc-content-check': {
      const qc = qcContentSafe();
      const qcContent = qc.content;
      const setup =
        qcContent === null
          ? { engine: createUnavailableEngine(`质控配置读不出来：${qc.error}`), problem: `质控配置读不出来：${qc.error}` }
          : contentEngineOf(qcContent);
      const contentEngine: ContentQcEngine = setup.engine;

      const entry = current();
      const session = entry.session;
      const now = new Date().toISOString();
      const qcContext = qcContextOf(session.document, now);
      const request = buildContentRequest({
        requestId: `qc-content-${entry.docId}-${entry.log.length + 1}`,
        now,
        ...(qcContext.docTypeCode ? { docTypeCode: qcContext.docTypeCode } : {}),
        ...(qcContext.visitType ? { visitType: qcContext.visitType } : {}),
        rules: qcContent?.rules ?? [],
        nodes: Object.values(session.document.nodes)
          .filter((node) => node.type === 'text')
          .map((node) => ({
            nodeId: node.id,
            text: node.runs.map((run) => run.text).join(''),
            keyContent: node.keyContent === true,
          })),
      });

      let produced: unknown;
      let engineCallError: string | null = null;
      const callStartedAt = Date.now();
      try {
        produced = await contentEngine.run(request, { timeoutMs: 8000 });
      } catch (err) {
        engineCallError = (err as Error).message;
        produced = {
          api: CONTENT_ENGINE_API,
          engine: { id: contentEngine.id, kind: contentEngine.kind, version: contentEngine.version },
          judged: [],
          findings: [],
          unevaluated: request.rules.map((rule) => ({ ruleId: rule.ruleId, reason: `引擎调用失败：${engineCallError}` })),
        };
      }
      const callMs = Date.now() - callStartedAt;

      const availability = [
        setup.problem,
        (qcContent?.engine.kind ?? 'none') === 'none' ? '内涵类质控引擎未接入' : null,
        /* 调用失败与"没接入"是两件事：前者要去看引擎，后者要去配，分开说 */
        engineCallError === null ? null : `引擎调用失败：${engineCallError}`,
        qcContent?.rulesProblem ?? null,
        /* 规则清单为空也要说，而且要说清去哪儿给：否则"不可用"只成了一句抱怨 */
        request.rules.length === 0
          ? '规则清单为空（由业务方提供，在管理后台「质控」页写入或一次性导入；示例见 samples/qc/content-rules.example.json）'
          : null,
      ]
        .filter((item): item is string => item !== null)
        .join('；');

      const validated = validateEngineOutput(produced, request);
      if (!validated.ok) {
        /* 整份被拒（契约不符 / 禁用字段 / 形状不对）→ 一条都不落。
           这里不"尽量挑几条能用的"：按错误契约产出的东西，挑出来的部分也没有意义。 */
        entry.lastContentQc = {
          configured: false,
          /* 被拒的原因要给人看：只说"当前不可用"、不说是引擎夹带了字段，
             现场会去查网络、查地址，而真正的问题在引擎的产出上（实测：
             原先把 reason 设成"配置层面的问题"，配置没问题时就是空串，
             界面于是显示成"当前不可用（引擎未接入）"，那是在说谎）。 */
          reason: [availability, `引擎产出被拒：${validated.message}`].filter((item) => item !== '').join('；'),
          rules: request.rules.length,
          judged: [],
          findings: 0,
          created: 0,
          unevaluated: [],
          silentRules: [],
          rejected: [{ index: -1, code: validated.code, message: validated.message }],
        };
        entry.log.push({
          at: now,
          action: `内涵类质控产出被拒（${validated.code}）`,
          ok: false,
          code: validated.code,
          message: validated.message,
        });
        json(res, 200, { ok: false, code: validated.code, message: validated.message, state: stateFor(req) });
        return;
      }

      /* 通过校验的逐条落成旁挂注解（`kind: 'quality'` = 内涵质控）。
         来源取引擎自身的类别：模型引擎 → `ai`（必须带 modelId），规则引擎 → `system`；
         两者都必须给依据（内核会拦 `E_ANNOTATION_NO_EVIDENCE`，这里先给全）。 */
      const engineActor: Actor = { id: contentEngine.id, kind: contentEngine.kind === 'model' ? 'ai' : 'system' };
      let created = 0;
      let already = 0;
      for (const finding of validated.findings) {
        const result = session.annotate(
          {
            nodeId: finding.nodeId as never,
            kind: 'quality',
            severity: finding.severity,
            title: finding.title,
            detail: finding.rationale,
            quote: finding.quote,
            source: {
              kind: engineActor.kind,
              ruleId: finding.ruleId,
              ...(engineActor.kind === 'ai' ? { modelId: engineActor.id } : { actorId: engineActor.id }),
            },
            evidence: [{ kind: 'rule', ref: finding.ruleId, detail: finding.ruleTitle }],
            dedupeKey: `${finding.ruleId}:${finding.nodeId}`,
          },
          engineActor,
        );
        if (result.created) created += 1;
        else already += 1;
      }

      entry.lastContentQc = {
        /* "可用" = 引擎配好了 且 这次调用没失败 且 有规则可判，三者缺一都不能叫可用 */
        configured: setup.problem === null && engineCallError === null && (qcContent?.engine.kind ?? 'none') !== 'none' && request.rules.length > 0,
        reason: availability === '' ? null : availability,
        rules: request.rules.length,
        judged: validated.judged,
        findings: validated.findings.length,
        created,
        unevaluated: validated.unevaluated,
        silentRules: validated.silentRules,
        rejected: validated.rejected.map((item) => ({ index: item.index, code: item.code, message: item.message })),
      };
      entry.log.push({
        at: now,
        action:
          `内涵类质控：规则 ${request.rules.length} 条 / 节点 ${request.nodes.length} 个（未送 ${request.omittedNodes}），` +
          `引擎${(qcContent?.engine.kind ?? 'none') === 'none' ? '未接入' : `=${qcContent?.engine.kind}（${callMs}ms${engineCallError ? '，调用失败' : ''}）`}，` +
          `命中 ${validated.findings.length} 条（新增 ${created}，已在册 ${already}）` +
          /* "没判成"与"没判"都要进日志：只说命中数，会把"有一批根本没判"读成"都查过了" */
          (validated.unevaluated.length > 0 ? `；未判定 ${validated.unevaluated.length} 条` : '') +
          (validated.silentRules.length > 0 ? `；未报告 ${validated.silentRules.length} 条` : '') +
          (validated.rejected.length > 0 ? `；丢弃 ${validated.rejected.length} 条` : ''),
        ok: true,
      });
      json(res, 200, {
        ok: true,
        data: {
          api: CONTENT_ENGINE_API,
          engine: {
            name: qcContent?.engine.kind ?? null,
            id: contentEngine.id,
            configured: setup.problem === null && engineCallError === null && (qcContent?.engine.kind ?? 'none') !== 'none',
            callMs,
            error: engineCallError,
          },
          availability: availability === '' ? null : availability,
          rules: request.rules.length,
          nodes: request.nodes.length,
          omittedNodes: request.omittedNodes,
          judged: validated.judged,
          findings: validated.findings.map((finding) => ({
            ruleId: finding.ruleId,
            nodeId: finding.nodeId,
            severity: finding.severity,
            title: finding.title,
          })),
          created,
          already,
          unevaluated: validated.unevaluated,
          silentRules: validated.silentRules,
          rejected: validated.rejected,
        },
        state: stateFor(req),
      });
      return;
    }

    case '/api/template-preview': {
      /* 预览一份模板（读视图）：与 `/api/template-create` 只差"有没有把结果写进去"这一件事。
         它不写任何东西，所以既不进 `ROUTE_ACTIONS`（读视图不需要动作级授权），也不写审计。 */
      const preview = previewOfTemplate(String(body.templateId ?? ''), writeActor(req, current()).id);
      if (!preview.ok) {
        json(res, 200, { ok: false, code: preview.code, message: preview.message });
        return;
      }
      json(res, 200, { ok: true, data: preview.data });
      return;
    }

    case '/api/control-preview': {
      /* 预览一个专科控件（读视图）：与模板预览同一处置 —— 不写任何东西，
         所以既不进 `ROUTE_ACTIONS`（读视图不需要动作级授权），也不写审计。
         这一步回答的是"医生点开会看到什么"：形状怎么画、有哪几格、哪几格是空的。 */
      const preview = previewOfControl(String(body.itemId ?? ''), writeActor(req, current()).id);
      if (!preview.ok) {
        json(res, 200, { ok: false, code: preview.code, message: preview.message });
        return;
      }
      json(res, 200, { ok: true, data: preview.data });
      return;
    }

    case '/api/template-create': {
      const entry = current();
      const source = entry.session.document;
      const templateId = String(body.templateId ?? '');
      const found = findTemplate(packRegistry, templateId);
      if (!found) {
        json(res, 200, {
          ok: false,
          code: 'E_TPL_TEMPLATE_UNKNOWN',
          message: `没有可用模板「${templateId}」：可能未装载，或已被停用，或尚未发布（草稿开不出）`,
          state: stateFor(req),
        });
        return;
      }

      /* 归一后再判：老病历里的"呼吸内科"与模板上的 `DEPT_RESP` 说的是同一个科 ——
         不归一的话，限科室的文书在这些病历上会被无理由拦下来  */
      const deptCode = normalizeDepartmentCode(departmentsSafe().loaded, source.encounter?.deptCode);
      if (!deptAllowsTemplate(found.definition, deptCode)) {
        const names = found.definition.departments ?? [];
        const { loaded } = departmentsSafe();
        json(res, 200, {
          ok: false,
          code: 'E_TPL_DEPT_MISMATCH',
          message: deptCode
            ? `「${found.definition.name}」限 ${names.map((code) => departmentNameOf(loaded, code) ?? code).join('、')}，本次就诊是 ${departmentNameOf(loaded, deptCode) ?? deptCode}：换一份对应的文书，或由管理员在「模板库」里放开科室`
            : `「${found.definition.name}」限 ${names.map((code) => departmentNameOf(loaded, code) ?? code).join('、')}，而本次就诊没有科室信息：先补就诊科室，或换一份通用文书`,
          state: stateFor(req),
        });
        return;
      }

      const at = new Date().toISOString();
      const docId = `doc_tpl_${state.entries.size + 1}`;
      /* 上下文：患者 / 就诊 / 时间 / 开单医生由引擎从参数派生；
         科室名称由这里补 —— 引擎不认识字典，也不该认识（它只管把给它的值填进去）。  */
      const deptList = departmentsSafe().loaded;
      let created: ReturnType<typeof instantiateTemplate>;
      try {
        created = instantiateTemplate(found.pack, {
          templateId,
          docId,
          createdBy: writeActor(req, entry).id,
          patient: source.patient,
          /* 新开的文书里存归一后的编码（而不是把老病历里的旧写法继续抄下去）：
             否则每开一次就把"名称写法"往后传一代，永远清不干净  */
          ...(source.encounter
            ? { encounter: { ...source.encounter, ...(deptCode ? { deptCode } : {}) } }
            : {}),
          doctor: { actorId: writeActor(req, entry).id },
          at,
          context: { 'encounter.deptName': departmentNameOf(deptList, deptCode) },
        });
      } catch (err) {
        json(res, 200, {
          ok: false,
          code: (err as { code?: string }).code ?? 'E_TPL_CREATE_FAILED',
          message: (err as Error).message,
          state: stateFor(req),
        });
        return;
      }

      const warnings = created.result.warnings;
      const newEntry: DocEntry = entryFor(created.doc);
      newEntry.log.push({
        at,
        action: `从模板「${found.definition.name}」新建病历（${created.result.source}）${warnings.length > 0 ? `：${warnings.length} 处待补` : ''}`,
        ok: true,
      });
      state.entries.set(docId, newEntry);

      /* 挂进当前就诊（同一份文书树里） */
      const visit = state.workspace?.patients
        .flatMap((patient) => patient.visits)
        .find((candidate) => candidate.docs.some((doc) => doc.docId === source.docId));
      visit?.docs.push({ docId, title: found.definition.name, kind: 'template' });
      state.activeDocId = docId;
      /* 落库：新建的文书要先有"结构条目"（患者/就诊/文书），正文才写得进去（外键） */
      persistStructure();
      workStore.saveDocument(newEntry.session.document, { title: found.definition.name, kind: 'template' });

      json(res, 200, {
        ok: true,
        data: { docId, templateId, templateName: found.definition.name, source: created.result.source, warnings },
        state: stateFor(req),
      });
      return;
    }

    case '/api/template-recompute': {
      /* 重算派生值。算与写分开：`planRecompute` 是纯的（只回答"该变成什么"），
         落笔走 `applyExternalData`，那里已经有一套正确语义：system 身份、必填强引用、
         幂等、不覆盖人工内容。于是"医生手改过的派生值"不会被系统算回去，
         而"填入项还没填"会让它停在算不出（不是 0）。 */
      const entry = current();
      const doc = entry.session.document;
      const plan = planRecompute({
        nodes: doc.nodes,
        patient: doc.patient,
        ...(doc.encounter ? { encounter: doc.encounter } : {}),
        at: new Date().toISOString(),
        registry: packRegistry,
      });
      if (plan.changes.length === 0) {
        json(res, 200, {
          ok: true,
          data: { applied: [], pending: plan.pending, unresolved: plan.unresolved, skipped: plan.skipped },
          state: stateFor(req),
        });
        return;
      }
      const result = act(entry, `重算派生值（${plan.changes.map((change) => change.key).join('、')}）`, () =>
        entry.session.applyExternalData(
          {
            items: plan.changes.map((change) => ({
              nodeId: change.nodeId,
              value: change.next,
              /* `valueText` 必须一起给：`applyExternalData` 只在显式提供时才覆盖它，
                 而界面与机读都优先读 valueText，漏了他就会出现"节点值是 4、界面显示空"。 */
              valueText: String(change.next),
              /*  必须传节点原有的证据：`applyExternalData` 会把 `provenance` 整体替换，
                 换成一条临时证据就等于抹掉依赖边与控件出处，表现是"重算一次之后就再也算不出来"。
                 实测踩到过，故在此写明。重算不改变"这个值是怎么来的"，证据也不该变。  */
              evidence: (doc.nodes[change.nodeId]?.provenance.evidence ?? []).map((item) => ({ ...item })),
            })),
          },
          { id: 'template-engine', kind: 'system' },
        ),
      );
      if (!result.ok) {
        json(res, 200, { ...result, state: stateFor(req) });
        return;
      }
      json(res, 200, {
        ok: true,
        data: {
          applied: result.data.applied,
          duplicate: result.data.skipped,
          pending: plan.pending,
          unresolved: plan.unresolved,
          skipped: plan.skipped,
        },
        state: stateFor(req),
      });
      return;
    }

    case '/api/rule-item-update': {
      const entry = current();
      let adminId: string;
      try {
        adminId = requireAdminSession(req, entry, '规则条目', '修改质控规则', 'pack.toggle');
      } catch (err) {
        json(res, 200, {
          ok: false,
          code: (err as { code?: string }).code ?? 'E_AUTH_REQUIRED',
          message: (err as Error).message,
          state: stateFor(req),
        });
        return;
      }

      const packId = typeof body.packId === 'string' ? body.packId : '';
      const itemId = typeof body.itemId === 'string' ? body.itemId : '';
      if (packId === '' || itemId === '') {
        json(res, 200, {
          ok: false,
          code: 'E_PACK_FIELD_MISSING',
          message: '请给出 packId 与 itemId（要改哪一条规则）',
          state: stateFor(req),
        });
        return;
      }
      const patch: {
        title?: string;
        severity?: AnnotationSeverity;
        predicate?: { kind: QcRuleDescriptor['predicate']['kind']; params?: Record<string, JsonValue> };
        detail?: string | null;
        suggestion?: string | null;
      } = {};
      if (body.title !== undefined) patch.title = typeof body.title === 'string' ? body.title : '';
      /* 级别原样交给内核判：只开放 info / warn 这条界线只该有一处（`rule-edit.ts`），
         在这里再写一遍"哪些级别可以"迟早会与它漂移  */
      if (body.severity !== undefined) patch.severity = body.severity as AnnotationSeverity;
      if (body.predicate !== undefined) {
        const raw = body.predicate;
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
          json(res, 200, {
            ok: false,
            code: 'E_RULE_ITEM_INVALID',
            message: '判定方式必须是一个对象：给出 kind（用哪个内置谓词）与可选的 params',
            state: stateFor(req),
          });
          return;
        }
        /* 参数原样透传：它是不是合法（未知参数名、类型不对、取值越界）由谓词自己的
           `normalizeParams()` 判 —— 界面上的参数表单就是照它生成的（同一处来源）。 */
        patch.predicate = {
          kind: (raw as Record<string, unknown>).kind as QcRuleDescriptor['predicate']['kind'],
          ...((raw as Record<string, unknown>).params === undefined
            ? {}
            : { params: (raw as Record<string, unknown>).params as Record<string, JsonValue> }),
        };
      }
      /* 判定依据 / 建议动作：空串或 null = 清掉覆盖（回到谓词内置文案）。
         写成"删字段"而不是"写空串"：空串过不了校验，而且会让"改回原样"
         回不到原来那一版内容指纹。 */
      if (body.detail !== undefined) patch.detail = body.detail === null ? null : String(body.detail);
      if (body.suggestion !== undefined) patch.suggestion = body.suggestion === null ? null : String(body.suggestion);

      const pack = packRegistry.get(packId);
      if (!pack) {
        json(res, 200, {
          ok: false,
          code: 'E_PACK_NOT_FOUND',
          message: `库里没有包「${packId}」`,
          state: stateFor(req),
        });
        return;
      }
      if (pack.kind !== 'rule') {
        json(res, 200, {
          ok: false,
          code: 'E_PACK_NOT_FOUND',
          message: `包「${packId}」是 ${pack.kind} 类，不是规则包`,
          state: stateFor(req),
        });
        return;
      }
      try {
        /* 带上判定方式库：改的可能是"引用库里哪一条判定方式"，校验必须看得见库里那一份 */
        const patched = patchRuleDescriptor(pack as QcRulePack, itemId, patch, conditionLibrary());
        const written = writePack({
          registry: packRegistry,
          db: STORAGE.db,
          supported: SUPPORTED_PACK_ENGINE_APIS,
          validateFor: packValidatorForWithConditions,
          /* 走一遍 JSON：确保写进库的是纯数据（不带 undefined / 原型），与"外部贴进来的包"同一形态 */
          input: JSON.parse(JSON.stringify(patched)) as unknown,
          by: adminId,
        });
        if (!written.ok) {
          json(res, 200, { ok: false, code: written.code, message: written.message, state: stateFor(req) });
          return;
        }
        const { result } = written;
        packStoreReport = result.report;
        if (result.action !== 'unchanged') {
          const after = patched.items.find((item) => item.itemId === itemId) as QcRuleDescriptor | undefined;
          recordAdminAudit({
            actor: adminId,
            subject: '内容包',
            kind: '变更',
            before: { 包指纹: result.fingerprintBefore ?? '（原先没有这个包）' },
            after: { 包指纹: result.fingerprintAfter },
            /* 审计的 `note` 要说清改了哪几项：光有"内容指纹变了"，
               事后只能知道"换过一版"，答不出"换的是判法还是只是个标题"  */
            note: `改规则 ${packId} / ${itemId}：${[
              patch.title !== undefined ? `标题 →「${String(patch.title)}」` : '',
              patch.severity !== undefined ? `级别 → ${String(patch.severity)}` : '',
              patch.predicate !== undefined
                ? `判定方式 → ${predicateLabelOf(String(patch.predicate.kind))}（参数 ${JSON.stringify(patch.predicate.params ?? {})}）`
                : '',
              patch.detail !== undefined ? (after?.detail ? '判定依据 → 改写内置文案' : '判定依据 → 回到内置文案') : '',
              patch.suggestion !== undefined ? (after?.suggestion ? '建议动作 → 改写内置文案' : '建议动作 → 回到内置文案') : '',
            ].filter((part) => part !== '').join('；')}`,
          });
        }
        entry.log.push({
          at: new Date().toISOString(),
          action: `改规则条目 ${packId} / ${itemId}（${result.action === 'unchanged' ? '内容相同，未改动' : `内容指纹 ${result.fingerprintBefore ?? '—'} → ${result.fingerprintAfter}`}）（操作者 ${adminId}）`,
          ok: true,
        });
        json(res, 200, {
          ok: true,
          data: {
            packId,
            itemId,
            action: result.action,
            fingerprintBefore: result.fingerprintBefore,
            fingerprintAfter: result.fingerprintAfter,
          },
          state: stateFor(req),
        });
      } catch (err) {
        json(res, 200, {
          ok: false,
          code: (err as { code?: string }).code ?? 'E_RULE_UPDATE_FAILED',
          message: (err as Error).message,
          state: stateFor(req),
        });
      }
      return;
    }

    case '/api/rule-item-create': {
      /* 新建一条规则（判定方式从封闭的谓词表里挑，参数照其规格填）。
         放进自建包（`doc.rule.custom`）：哪些是本院自己维护的必须一眼分得出来，
         否则下次有人载入一份交付方的包，本院这几条会被整体覆盖而没人知道。

         新建出来先停用 —— 判定标准不该"随保存悄悄上线"。
         模板侧表达同一件事用的是"新建即草稿（医生端开不出）"；规则这里没有那两态，
         条目开关就是它的那一态：库里看得见、下一轮质控不跑它，启用是一次显式动作。  */
      const entry = current();
      let adminId: string;
      try {
        adminId = requireAdminSession(req, entry, '规则条目', '新建质控规则', 'pack.toggle');
      } catch (err) {
        json(res, 200, {
          ok: false,
          code: (err as { code?: string }).code ?? 'E_AUTH_REQUIRED',
          message: (err as Error).message,
          state: stateFor(req),
        });
        return;
      }

      const rawPredicate = body.predicate;
      if (!rawPredicate || typeof rawPredicate !== 'object' || Array.isArray(rawPredicate)) {
        json(res, 200, {
          ok: false,
          code: 'E_RULE_ITEM_INVALID',
          message: '请给判定方式：kind（用哪个内置谓词）与它要的参数 —— 规则不说明"按什么判"就不是规则',
          state: stateFor(req),
        });
        return;
      }
      const existing = packRegistry.get(CUSTOM_RULE_PACK_ID) as QcRulePack | undefined;
      try {
        const created = addRule(existing ?? null, {
          title: typeof body.title === 'string' ? body.title : '',
          severity: body.severity as AnnotationSeverity,
          predicate: {
            kind: (rawPredicate as Record<string, unknown>).kind as QcRuleDescriptor['predicate']['kind'],
            ...((rawPredicate as Record<string, unknown>).params === undefined
              ? {}
              : { params: (rawPredicate as Record<string, unknown>).params as Record<string, JsonValue> }),
          },
          detail: typeof body.detail === 'string' ? body.detail : '',
          suggestion: typeof body.suggestion === 'string' ? body.suggestion : '',
        /* 带上判定方式库：新建的规则可以引用库里那几条（判定方式是库级资产） */
        }, conditionLibrary());
        const written = writePack({
          registry: packRegistry,
          db: STORAGE.db,
          supported: SUPPORTED_PACK_ENGINE_APIS,
          validateFor: packValidatorForWithConditions,
          input: JSON.parse(JSON.stringify(created.pack)) as unknown,
          by: adminId,
        });
        if (!written.ok) {
          json(res, 200, { ok: false, code: written.code, message: written.message, state: stateFor(req) });
          return;
        }
        const { result } = written;
        packStoreReport = result.report;
        /* 落"停用"这一格：条目开关在库里是单独一列（`disabled`），不在包内容里 ——
           写进内容的话，"新建出来先不跑"会连带改变内容指纹。 */
        let persisted = { ok: true as boolean, message: '' };
        try {
          packRegistry.setItemEnabled(created.pack.packId, created.itemId, false);
          saveDisabledItems(packRegistry, STORAGE.db);
        } catch (err) {
          persisted = { ok: false, message: (err as Error).message };
        }
        recordAdminAudit({
          actor: adminId,
          subject: '内容包',
          kind: '变更',
          before: { 包指纹: result.fingerprintBefore ?? '（原先没有自建规则包）' },
          after: { 包指纹: result.fingerprintAfter },
          note: `新建规则 ${created.itemId}「${String(body.title ?? '')}」（判定方式：${predicateLabelOf(String((rawPredicate as Record<string, unknown>).kind ?? ''))}；级别：${String(body.severity ?? '')}）`
            + ` —— 默认停用：启用之后才会进入下一轮质控${persisted.ok ? '' : `（停用状态落盘失败：${persisted.message}）`}`,
        });
        entry.log.push({
          at: new Date().toISOString(),
          action: `新建规则 ${created.itemId}「${String(body.title ?? '')}」（停用中，内容指纹 ${result.fingerprintAfter}）（操作者 ${adminId}）`,
          ok: true,
        });
        json(res, 200, {
          ok: true,
          data: {
            packId: created.pack.packId,
            itemId: created.itemId,
            enabled: false,
            persisted,
            action: result.action,
            fingerprintAfter: result.fingerprintAfter,
          },
          state: stateFor(req),
        });
      } catch (err) {
        json(res, 200, {
          ok: false,
          code: (err as { code?: string }).code ?? 'E_RULE_CREATE_FAILED',
          message: (err as Error).message,
          state: stateFor(req),
        });
      }
      return;
    }

    case '/api/qc-condition-create': {
      const entry = current();
      let adminId: string;
      try {
        adminId = requireAdminSession(req, entry, '条件库', '新建具名条件', 'pack.toggle');
      } catch (err) {
        json(res, 200, {
          ok: false,
          code: (err as { code?: string }).code ?? 'E_AUTH_REQUIRED',
          message: (err as Error).message,
          state: stateFor(req),
        });
        return;
      }
      const name = typeof body.name === 'string' ? body.name : '';
      if (name.trim() === '') {
        json(res, 200, {
          ok: false,
          code: 'E_PACK_FIELD_MISSING',
          message: '请给出判定方式名（界面上要按名字挑它）',
          state: stateFor(req),
        });
        return;
      }
      try {
        const created = addCondition(conditionState.items, {
          name,
          ...(body.description === undefined ? {} : { description: String(body.description) }),
          /* 参数规格原样透传：形状合不合法由 `normalizeConditionParams` 判（与条件树同一段），
             在这里"顺手清掉不合法的那几格"会让使用者以为它配上了 */
          ...(body.params === undefined ? {} : { params: body.params }),
          when: body.when,
        });
        /* 回读在落库前算：落库成功之后 `state` 里也有它，但审计那句话要在写入的同一步里成型 */
        const summary = conditionCatalogOf(created.items, packRegistry)
          .find((item) => item.itemId === created.itemId)?.summary ?? null;
        const saved = writeConditions(
          created.items,
          adminId,
          `新建判定方式 ${created.itemId}「${name.trim()}」：${summary ?? '（条件读不出来）'}`,
        );
        entry.log.push({
          at: new Date().toISOString(),
          action: `新建判定方式 ${created.itemId}「${name.trim()}」（操作者 ${adminId}）`,
          ok: true,
        });
        json(res, 200, {
          ok: true,
          data: { itemId: created.itemId, summary, updatedAt: saved.updatedAt ?? null },
          state: stateFor(req),
        });
      } catch (err) {
        json(res, 200, {
          ok: false,
          code: (err as { code?: string }).code ?? 'E_QC_CONDITION_CREATE_FAILED',
          message: (err as Error).message,
          state: stateFor(req),
        });
      }
      return;
    }

    case '/api/qc-condition-update': {
      const entry = current();
      let adminId: string;
      try {
        adminId = requireAdminSession(req, entry, '判定方式库', '修改判定方式', 'pack.toggle');
      } catch (err) {
        json(res, 200, {
          ok: false,
          code: (err as { code?: string }).code ?? 'E_AUTH_REQUIRED',
          message: (err as Error).message,
          state: stateFor(req),
        });
        return;
      }
      const itemId = typeof body.itemId === 'string' ? body.itemId : '';
      if (itemId === '') {
        json(res, 200, {
          ok: false,
          code: 'E_PACK_FIELD_MISSING',
          message: '请给出 itemId（要改哪一条判定方式）',
          state: stateFor(req),
        });
        return;
      }
      const patch: { name?: string; description?: string | null; params?: unknown; when?: unknown } = {};
      if (body.name !== undefined) patch.name = typeof body.name === 'string' ? body.name : '';
      if (body.description !== undefined) patch.description = body.description === null ? null : String(body.description);
      if (body.params !== undefined) patch.params = body.params;
      if (body.when !== undefined) patch.when = body.when;
      try {
        const before = conditionCatalogOf(conditionState.items, packRegistry).find((item) => item.itemId === itemId);
        const patched = patchCondition(conditionState.items, itemId, patch);
        const after = conditionCatalogOf(patched, packRegistry).find((item) => item.itemId === itemId);
        const impact = after?.usedBy ?? [];
        const saved = writeConditions(
          patched,
          adminId,
          `改判定方式 ${itemId}：${[
            patch.name !== undefined ? `名称 →「${String(patch.name)}」` : '',
            patch.description !== undefined ? (after?.description ? '说明 → 改写' : '说明 → 清空') : '',
            patch.params !== undefined ? '参数表 → 改写' : '',
            patch.when !== undefined ? `条件 → ${after?.summary ?? '（读不出来）'}` : '',
          ].filter((part) => part !== '').join('；')}`
            + `；会影响 ${impact.length} 条引用它的规则（跨包数：`
            + `${impact.map((user) => `「${user.packId} / ${user.title}」`).join('、') || '无'}）`
            /* 条件树改了口径时把"原来那句"也记下来：事后只看"指纹变了"答不出"口径被改成了什么" */
            + (patch.when !== undefined && before?.summary !== undefined && before.summary !== after?.summary
              ? `（原条件：${before.summary}）`
              : ''),
        );
        entry.log.push({
          at: new Date().toISOString(),
          action: `改判定方式 ${itemId}${patch.when !== undefined ? `（条件 → ${after?.summary ?? '（读不出来）'}，影响 ${impact.length} 条规则）` : ''}（操作者 ${adminId}）`,
          ok: true,
        });
        json(res, 200, {
          ok: true,
          data: {
            itemId,
            summary: after?.summary ?? null,
            usedBy: impact,
            updatedAt: saved.updatedAt ?? null,
          },
          state: stateFor(req),
        });
      } catch (err) {
        json(res, 200, {
          ok: false,
          code: (err as { code?: string }).code ?? 'E_QC_CONDITION_UPDATE_FAILED',
          message: (err as Error).message,
          state: stateFor(req),
        });
      }
      return;
    }

    case '/api/qc-condition-delete': {
      const entry = current();
      let adminId: string;
      try {
        adminId = requireAdminSession(req, entry, '判定方式库', '删除判定方式', 'pack.toggle');
      } catch (err) {
        json(res, 200, {
          ok: false,
          code: (err as { code?: string }).code ?? 'E_AUTH_REQUIRED',
          message: (err as Error).message,
          state: stateFor(req),
        });
        return;
      }
      const itemId = typeof body.itemId === 'string' ? body.itemId : '';
      if (itemId === '') {
        json(res, 200, {
          ok: false,
          code: 'E_PACK_FIELD_MISSING',
          message: '请给出 itemId（要删哪一条判定方式）',
          state: stateFor(req),
        });
        return;
      }
      try {
        const before = conditionCatalogOf(conditionState.items, packRegistry).find((item) => item.itemId === itemId);
        /* 被引用时这里抛 `E_RULE_CONDITION_IN_USE`，消息里带着引用它的规则与包 */
        const next = removeCondition(conditionState.items, itemId, packRegistry);
        const saved = writeConditions(
          next,
          adminId,
          `删除判定方式 ${itemId}「${before?.name ?? itemId}」：它没有被任何规则引用`,
        );
        entry.log.push({
          at: new Date().toISOString(),
          action: `删除判定方式 ${itemId}「${before?.name ?? itemId}」（操作者 ${adminId}）`,
          ok: true,
        });
        json(res, 200, {
          ok: true,
          data: { itemId, updatedAt: saved.updatedAt ?? null },
          state: stateFor(req),
        });
      } catch (err) {
        json(res, 200, {
          ok: false,
          code: (err as { code?: string }).code ?? 'E_QC_CONDITION_DELETE_FAILED',
          message: (err as Error).message,
          state: stateFor(req),
        });
      }
      return;
    }

    case '/api/rule-item-delete': {
      /* 删一条规则：包里少一条内容。
         它不动任何病历：质控提示是旁挂注解（带着当时的规则号与依据文案），
         规则不在了，注解还在、还读得出来 —— 只是"出自哪一条规则"再也追不到内容了。
         这句话必须说在界面上，否则"删掉一条规则"听起来像"删掉一批质控结论"。  */
      const entry = current();
      let adminId: string;
      try {
        adminId = requireAdminSession(req, entry, '规则条目', '删除质控规则', 'pack.toggle');
      } catch (err) {
        json(res, 200, {
          ok: false,
          code: (err as { code?: string }).code ?? 'E_AUTH_REQUIRED',
          message: (err as Error).message,
          state: stateFor(req),
        });
        return;
      }
      const packId = typeof body.packId === 'string' ? body.packId : '';
      const itemId = typeof body.itemId === 'string' ? body.itemId : '';
      const pack = packId === '' ? undefined : packRegistry.get(packId);
      if (!pack || itemId === '') {
        json(res, 200, {
          ok: false,
          code: 'E_PACK_FIELD_MISSING',
          message: '请给出 packId 与 itemId（要删哪一条规则）',
          state: stateFor(req),
        });
        return;
      }
      if (pack.kind !== 'rule') {
        json(res, 200, { ok: false, code: 'E_PACK_NOT_FOUND', message: `包「${packId}」不是规则包`, state: stateFor(req) });
        return;
      }
      try {
        /* 只找规则条目：同一个包里还有具名条件（`C-CUSTOM-N`），
           它们没有 title，混进来会让审计里的名字变成一个编码  */
        const descriptor = ruleItemsOf(pack as QcRulePack).find((item) => item.itemId === itemId);
        const title = descriptor?.title ?? itemId;
        const after = removeRule(pack as QcRulePack, itemId);
        if (after.items.length === 0) {
          const removed = deletePack({ registry: packRegistry, db: STORAGE.db, packId });
          packStoreReport = removed.report;
          recordAdminAudit({
            actor: adminId,
            subject: '内容包',
            kind: '变更',
            before: { 包指纹: '（见前后指纹）' },
            after: { 包指纹: '（包已删除）' },
            note: `删除规则 ${packId} / ${itemId}「${title}」：它是这个包里最后一条，包一并移除（已有病历不受影响：质控提示是旁挂注解，仍读得出来）`,
          });
          entry.log.push({
            at: new Date().toISOString(),
            action: `删除规则 ${packId} / ${itemId}「${title}」（包里已空，整包移除）（操作者 ${adminId}）`,
            ok: true,
          });
          json(res, 200, { ok: true, data: { packId, itemId, action: 'deleted' }, state: stateFor(req) });
          return;
        }
        const written = writePack({
          registry: packRegistry,
          db: STORAGE.db,
          supported: SUPPORTED_PACK_ENGINE_APIS,
          validateFor: packValidatorForWithConditions,
          input: JSON.parse(JSON.stringify(after)) as unknown,
          by: adminId,
        });
        if (!written.ok) {
          json(res, 200, { ok: false, code: written.code, message: written.message, state: stateFor(req) });
          return;
        }
        const { result } = written;
        packStoreReport = result.report;
        if (result.action !== 'unchanged') {
          recordAdminAudit({
            actor: adminId,
            subject: '内容包',
            kind: '变更',
            before: { 包指纹: result.fingerprintBefore ?? '（原先没有这个包）' },
            after: { 包指纹: result.fingerprintAfter },
            note: `删除规则 ${packId} / ${itemId}「${title}」（已有病历不受影响：质控提示是旁挂注解，仍读得出来）`,
          });
        }
        entry.log.push({
          at: new Date().toISOString(),
          action: `删除规则 ${packId} / ${itemId}「${title}」（内容指纹 → ${result.fingerprintAfter}）（操作者 ${adminId}）`,
          ok: true,
        });
        json(res, 200, {
          ok: true,
          data: { packId, itemId, action: result.action, fingerprintAfter: result.fingerprintAfter },
          state: stateFor(req),
        });
      } catch (err) {
        json(res, 200, {
          ok: false,
          code: (err as { code?: string }).code ?? 'E_RULE_DELETE_FAILED',
          message: (err as Error).message,
          state: stateFor(req),
        });
      }
      return;
    }

    case '/api/knowledge-pack-toggle': {
      /* 包条目开关 = 部署策略（本专科跑哪些规则、开哪几份文书），与模型地址同类：改它要管理员身份。
         规则条目与模板条目走的是同一个接口（通用层不区分条目形状），
         所以这里的措辞不再写"规则包"，写错会把模板开关记成改了判定标准。
         关键是它不碰任何病历，所以这里不走 `act()`（那是"写文档"的入口，
         会落文档留痕、会改 rev），只记一条系统级审计。
         这条边界正是"包不是文档内容"在代码上的样子。  */
      const entry = current();
      let adminId: string;
      try {
        /* 动作参数必须与路由表（`ROUTE_ACTIONS`）一致：
           它默认是 `config.write`，而这一条实际是 `pack.toggle`（质控员就该能做），
           不传就会把质控员挡在门外，而路由表的用意恰恰相反（实测踩到）。 */
        adminId = requireAdminSession(req, entry, '包条目开关', '调整包条目开关', 'pack.toggle');
      } catch (err) {
        /* 正常情况下授权门（`ROUTE_ACTIONS`）已经先拦了，这里是第二道。
           把它写成"透传真实错误码"而不是写死 `E_ADMIN_REQUIRED`：写死会让这一处
           在角色不足时也报"需要管理员"，把"去换人"与"去登录"混成一句。 */
        json(res, 200, {
          ok: false,
          code: (err as { code?: string }).code ?? 'E_AUTH_REQUIRED',
          message: (err as Error).message,
          state: stateFor(req),
        });
        return;
      }

      const packId = String(body.packId ?? '');
      const itemId = String(body.itemId ?? '');
      const enabled = body.enabled === true;
      const before = packRegistry.get(packId)?.items.find((item) => item.itemId === itemId)?.enabled === true;
      try {
        const summary = packRegistry.setItemEnabled(packId, itemId, enabled);
        /* 立刻落盘：开关是"这台机器实际在跑什么"，重启后必须还在，
           内存态时它一重启就回出厂，而界面上看不出任何异常。 */
        let persisted: { ok: boolean; message?: string };
        try {
          saveDisabledItems(packRegistry, STORAGE.db);
          persisted = { ok: true };
        } catch (err) {
          /* 保存失败必须回传：否则用户以为"改好了"，重启后却发现自己变回去了 */
          persisted = { ok: false, message: (err as Error).message };
        }
        recordAdminAudit({
          actor: adminId,
          subject: '包条目',
          kind: '变更',
          before: { packId, itemId, enabled: before },
          after: { packId, itemId, enabled },
          note: `${packId} / ${itemId} → ${enabled ? '启用' : '停用'}${persisted.ok ? '' : `（落盘失败：${persisted.message}）`}`,
        });
        entry.log.push({
          at: new Date().toISOString(),
          action: `包条目开关：${packId} / ${itemId} → ${enabled ? '启用' : '停用'}（生效指纹 ${packRegistry.effectiveFingerprint()}）${persisted.ok ? '（已落盘）' : `（落盘失败：${persisted.message}）`}`,
          ok: persisted.ok,
        });
        json(res, 200, { ok: true, data: { ...summary, persisted }, state: stateFor(req) });
      } catch (err) {
        json(res, 200, {
          ok: false,
          code: (err as { code?: string }).code ?? 'E_PACK_TOGGLE_FAILED',
          message: (err as Error).message,
          state: stateFor(req),
        });
      }
      return;
    }

    case '/api/template-item-update': {
      /* 改一份文书：名称 / 适用科室 / 状态 / 骨架（仅草稿可改）。
         它走的是 `writePack()` —— 包内容的唯一写路径，于是后果与"换一份新包"同类：
           - 内容指纹会变（这份模板确实换了一版内容），前后指纹进系统审计；
           - 条目开关按 `packId` 保留（关着的文书不会因为改了个名字就被顺手打开）；
           - 校验失败则库与注册表都不动。
         骨架只对草稿开：已发布的文书可能已经开出过病历，改骨架会让"当时按哪一版开的"
         对不上 —— 要先改就先撤稿（撤稿后医生端立刻开不出它），代价由人显式承担。
         它同样不碰任何病历，所以不走 `act()`。  */
      const entry = current();
      let adminId: string;
      try {
        /* 动作与路由表一致（`pack.toggle`）：改的是部署侧的知识内容，与载入包同类 */
        adminId = requireAdminSession(req, entry, '模板条目', '修改文书模板', 'pack.toggle');
      } catch (err) {
        json(res, 200, {
          ok: false,
          code: (err as { code?: string }).code ?? 'E_AUTH_REQUIRED',
          message: (err as Error).message,
          state: stateFor(req),
        });
        return;
      }

      const packId = typeof body.packId === 'string' ? body.packId : '';
      const itemId = typeof body.itemId === 'string' ? body.itemId : '';
      if (packId === '' || itemId === '') {
        json(res, 200, {
          ok: false,
          code: 'E_PACK_FIELD_MISSING',
          message: '请给出 packId 与 itemId（要改哪一份文书）',
          state: stateFor(req),
        });
        return;
      }
      /* 科室在界面上是从字典里勾选（所以这里是编码数组），
         但字符串形式仍然收：脚本与旧页面按"产科、妇科"发过来时，
         切成数组这件事只该有一处，放在界面里会让"多一个空格"变成两个不同科室。  */
      const patch: {
        name?: string;
        departments?: string[];
        status?: 'draft' | 'active';
        sections?: TemplateSection[];
        slotMeta?: SlotMetaPatch[];
        sectionMeta?: SectionMetaPatch[];
      } = {};
      if (body.name !== undefined) patch.name = typeof body.name === 'string' ? body.name : '';
      if (body.departments !== undefined) {
        if (typeof body.departments === 'string') {
          /* 空串要切成空数组而不是 `['']`：后者会被当成"填了一个空科室"而拒绝，
             而界面上留空的意思恰恰是"通用（不限科室）"  */
          patch.departments = body.departments.split(/[,，、;；]/).map((value) => value.trim()).filter((value) => value !== '');
        } else if (Array.isArray(body.departments)) {
          patch.departments = body.departments.map((value) => String(value));
        } else {
          json(res, 200, {
            ok: false,
            code: 'E_TPL_FIELD_INVALID',
            message: '适用科室应为科室编码数组（或逗号分隔的字符串）',
            state: stateFor(req),
          });
          return;
        }
        const unknown = validateTemplateDepartments(patch.departments);
        if (unknown) {
          json(res, 200, { ok: false, code: unknown.code, message: unknown.message, state: stateFor(req) });
          return;
        }
      }
      if (body.status !== undefined) {
        if (body.status === 'draft' || body.status === 'active') patch.status = body.status;
        else {
          json(res, 200, {
            ok: false,
            code: 'E_TPL_FIELD_INVALID',
            message: '状态只能是 draft（草稿）或 active（已发布）',
            state: stateFor(req),
          });
          return;
        }
      }
      if (body.sections !== undefined) {
        if (Array.isArray(body.sections)) patch.sections = body.sections as unknown as TemplateSection[];
        else {
          json(res, 200, {
            ok: false,
            code: 'E_TPL_FIELD_INVALID',
            message: '章节必须是数组（至少一章，否则这份文书产不出任何内容）',
            state: stateFor(req),
          });
          return;
        }
      }
      if (body.slotMeta !== undefined) {
        if (!Array.isArray(body.slotMeta)) {
          json(res, 200, {
            ok: false,
            code: 'E_TPL_FIELD_INVALID',
            message: '槽位元数据必须是数组（每项给出章节编码与槽位名）',
            state: stateFor(req),
          });
          return;
        }
        patch.slotMeta = body.slotMeta as SlotMetaPatch[];
      }
      if (body.sectionMeta !== undefined) {
        if (!Array.isArray(body.sectionMeta)) {
          json(res, 200, {
            ok: false,
            code: 'E_TPL_FIELD_INVALID',
            message: '章节属性必须是数组（每项给出章节编码与要改的项）',
            state: stateFor(req),
          });
          return;
        }
        patch.sectionMeta = body.sectionMeta as SectionMetaPatch[];
      }

      const pack = packRegistry.get(packId);
      if (!pack) {
        json(res, 200, {
          ok: false,
          code: 'E_PACK_NOT_FOUND',
          message: `库里没有包「${packId}」`,
          state: stateFor(req),
        });
        return;
      }
      if (pack.kind !== 'template') {
        json(res, 200, {
          ok: false,
          code: 'E_PACK_NOT_FOUND',
          message: `包「${packId}」是 ${pack.kind} 类，不是模板包`,
          state: stateFor(req),
        });
        return;
      }
      try {
        const patched = patchTemplateMeta(pack as TemplatePack, itemId, patch);
        const written = writePack({
          registry: packRegistry,
          db: STORAGE.db,
          supported: SUPPORTED_PACK_ENGINE_APIS,
          validateFor: packValidatorForWithConditions,
          /* 走一遍 JSON：确保写进库的是纯数据（不带 undefined / 原型），
             与"外部贴进来的包"同一形态 —— 编辑过的包不该是另一种东西 */
          input: JSON.parse(JSON.stringify(patched)) as unknown,
          by: adminId,
        });
        if (!written.ok) {
          json(res, 200, { ok: false, code: written.code, message: written.message, state: stateFor(req) });
          return;
        }
        const { result } = written;
        packStoreReport = result.report;
        if (result.action !== 'unchanged') {
          recordAdminAudit({
            actor: adminId,
            subject: '内容包',
            kind: '变更',
            before: { 包指纹: result.fingerprintBefore ?? '（原先没有这个包）' },
            after: { 包指纹: result.fingerprintAfter },
            /* 审计的 `note` 要说出改了哪几项：光有"内容指纹变了"，
               事后只能知道"换过一版"，答不出"换的是章节还是只是个名字"  */
            note: `改文书 ${packId} / ${itemId}：${[
              patch.name !== undefined ? `名称 →「${String(patch.name)}」` : '',
              patch.departments !== undefined ? `适用科室 → ${patch.departments.length === 0 ? '通用' : patch.departments.join('、')}` : '',
              patch.status !== undefined ? `状态 → ${patch.status === 'draft' ? '草稿' : '已发布'}` : '',
              patch.sections !== undefined ? `章节与槽位 → ${patch.sections.length} 章` : '',
              patch.slotMeta !== undefined ? `槽位元数据 → ${patch.slotMeta.length} 处` : '',
              patch.sectionMeta !== undefined ? `章节属性 → ${patch.sectionMeta.length} 处` : '',
            ].filter((part) => part !== '').join('；')}`,
          });
        }
        entry.log.push({
          at: new Date().toISOString(),
          action: `改模板条目 ${packId} / ${itemId}（${result.action === 'unchanged' ? '内容相同，未改动' : `内容指纹 ${result.fingerprintBefore ?? '—'} → ${result.fingerprintAfter}`}）（操作者 ${adminId}）`,
          ok: true,
        });
        json(res, 200, {
          ok: true,
          data: {
            packId,
            itemId,
            action: result.action,
            fingerprintBefore: result.fingerprintBefore,
            fingerprintAfter: result.fingerprintAfter,
          },
          state: stateFor(req),
        });
      } catch (err) {
        json(res, 200, {
          ok: false,
          code: (err as { code?: string }).code ?? 'E_TPL_UPDATE_FAILED',
          message: (err as Error).message,
          state: stateFor(req),
        });
      }
      return;
    }

    case '/api/template-item-create': {
      const entry = current();
      let adminId: string;
      try {
        adminId = requireAdminSession(req, entry, '模板条目', '新建文书模板', 'pack.toggle');
      } catch (err) {
        json(res, 200, {
          ok: false,
          code: (err as { code?: string }).code ?? 'E_AUTH_REQUIRED',
          message: (err as Error).message,
          state: stateFor(req),
        });
        return;
      }

      const name = typeof body.name === 'string' ? body.name.trim() : '';
      const rawDocType = body.docType as Record<string, unknown> | undefined;
      const docType = {
        system: typeof rawDocType?.system === 'string' ? rawDocType.system : 'local',
        code: String(rawDocType?.code ?? '').trim(),
        display: String(rawDocType?.display ?? '').trim(),
      };
      if (name === '' || docType.code === '' || docType.display === '') {
        json(res, 200, {
          ok: false,
          code: 'E_TPL_FIELD_INVALID',
          message: '请填文书名称与文书类型：前者是「新建」里的那一行，后者决定这份文书算哪一类',
          state: stateFor(req),
        });
        return;
      }
      const departments: string[] = typeof body.departments === 'string'
        ? body.departments.split(/[,，、;；]/).map((value: string) => value.trim()).filter((value: string) => value !== '')
        : Array.isArray(body.departments)
          ? body.departments.map((value: unknown) => String(value))
          : [];
      const deptProblem = validateTemplateDepartments(departments);
      if (deptProblem) {
        json(res, 200, { ok: false, code: deptProblem.code, message: deptProblem.message, state: stateFor(req) });
        return;
      }

      const existing = packRegistry.get(CUSTOM_TEMPLATE_PACK_ID) as TemplatePack | undefined;
      try {
        /* 总是草稿：新建这条路不提供"一步建好就上线"的入口 ——
           那等于把"发布"这个动作藏进"保存"里  */
        const created = addTemplate(existing ?? null, {
          name,
          docType: docType as unknown as DocTypeRef,
          departments,
          status: 'draft',
        });
        const written = writePack({
          registry: packRegistry,
          db: STORAGE.db,
          supported: SUPPORTED_PACK_ENGINE_APIS,
          validateFor: packValidatorForWithConditions,
          input: JSON.parse(JSON.stringify(created.pack)) as unknown,
          by: adminId,
        });
        if (!written.ok) {
          json(res, 200, { ok: false, code: written.code, message: written.message, state: stateFor(req) });
          return;
        }
        const { result } = written;
        packStoreReport = result.report;
        recordAdminAudit({
          actor: adminId,
          subject: '内容包',
          kind: '变更',
          before: { 包指纹: result.fingerprintBefore ?? '（原先没有这个包）' },
          after: { 包指纹: result.fingerprintAfter },
          note: `新建文书 ${created.itemId}「${name}」（${docType.display}；适用科室：${departments.length === 0 ? '通用' : departments.join('、')}）`
            + ' —— 默认是草稿：定稿前医生端开不出它',
        });
        entry.log.push({
          at: new Date().toISOString(),
          action: `新建文书 ${created.itemId}「${name}」（草稿，内容指纹 ${result.fingerprintAfter}）（操作者 ${adminId}）`,
          ok: true,
        });
        json(res, 200, {
          ok: true,
          data: { packId: created.pack.packId, itemId: created.itemId, status: 'draft', action: result.action, fingerprintAfter: result.fingerprintAfter },
          state: stateFor(req),
        });
      } catch (err) {
        json(res, 200, {
          ok: false,
          code: (err as { code?: string }).code ?? 'E_TPL_CREATE_FAILED',
          message: (err as Error).message,
          state: stateFor(req),
        });
      }
      return;
    }

    case '/api/expression-item-create': {
      const entry = current();
      let adminId: string;
      try {
        adminId = requireAdminSession(req, entry, '表达式控件', '新建医学表达式控件', 'pack.toggle');
      } catch (err) {
        json(res, 200, {
          ok: false,
          code: (err as { code?: string }).code ?? 'E_AUTH_REQUIRED',
          message: (err as Error).message,
          state: stateFor(req),
        });
        return;
      }

      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (name === '') {
        json(res, 200, {
          ok: false,
          code: 'E_TPL_FIELD_INVALID',
          message: '请填控件名称（它是模板里选用控件时看到的那一行）',
          state: stateFor(req),
        });
        return;
      }
      const existing = packRegistry.get(CUSTOM_TEMPLATE_PACK_ID) as TemplatePack | undefined;
      try {
        const created = addExpression(existing ?? null, {
          name,
          expression: body.expression as ExprNode,
          unit: typeof body.unit === 'string' ? body.unit : undefined,
          description: typeof body.description === 'string' ? body.description : undefined,
        });
        const written = writePack({
          registry: packRegistry,
          db: STORAGE.db,
          supported: SUPPORTED_PACK_ENGINE_APIS,
          validateFor: packValidatorForWithConditions,
          input: JSON.parse(JSON.stringify(created.pack)) as unknown,
          by: adminId,
        });
        if (!written.ok) {
          json(res, 200, { ok: false, code: written.code, message: written.message, state: stateFor(req) });
          return;
        }
        const { result } = written;
        packStoreReport = result.report;
        const createdItem = created.pack.items.find((item) => item.itemId === created.itemId) as ExpressionDefinition | undefined;
        const formula = describeExpression(createdItem?.expression as ExprNode);
        recordAdminAudit({
          actor: adminId,
          subject: '内容包',
          kind: '变更',
          before: { 包指纹: result.fingerprintBefore ?? '（原先没有这个包）' },
          after: { 包指纹: result.fingerprintAfter },
          note: `新建表达式控件 ${created.itemId}「${name}」= ${formula}`,
        });
        entry.log.push({
          at: new Date().toISOString(),
          action: `新建表达式控件 ${created.itemId}「${name}」= ${formula}（操作者 ${adminId}）`,
          ok: true,
        });
        json(res, 200, {
          ok: true,
          data: { packId: created.pack.packId, itemId: created.itemId, formula, action: result.action, fingerprintAfter: result.fingerprintAfter },
          state: stateFor(req),
        });
      } catch (err) {
        json(res, 200, {
          ok: false,
          code: (err as { code?: string }).code ?? 'E_EXPR_CREATE_FAILED',
          message: (err as Error).message,
          state: stateFor(req),
        });
      }
      return;
    }

    case '/api/expression-item-update': {
      const entry = current();
      let adminId: string;
      try {
        adminId = requireAdminSession(req, entry, '表达式控件', '修改医学表达式控件', 'pack.toggle');
      } catch (err) {
        json(res, 200, {
          ok: false,
          code: (err as { code?: string }).code ?? 'E_AUTH_REQUIRED',
          message: (err as Error).message,
          state: stateFor(req),
        });
        return;
      }
      const packId = typeof body.packId === 'string' ? body.packId : '';
      const itemId = typeof body.itemId === 'string' ? body.itemId : '';
      const pack = packId === '' ? undefined : (packRegistry.get(packId) as TemplatePack | undefined);
      if (!pack || itemId === '') {
        json(res, 200, {
          ok: false,
          code: 'E_PACK_FIELD_MISSING',
          message: '请给出 packId 与 itemId（要改哪个控件）',
          state: stateFor(req),
        });
        return;
      }
      const patch: { name?: string; unit?: string; description?: string; expression?: ExprNode } = {};
      if (body.name !== undefined) patch.name = typeof body.name === 'string' ? body.name : '';
      if (body.unit !== undefined) patch.unit = typeof body.unit === 'string' ? body.unit : '';
      if (body.description !== undefined) patch.description = typeof body.description === 'string' ? body.description : '';
      if (body.expression !== undefined) patch.expression = body.expression as ExprNode;
      try {
        const beforeItem = pack.items.find((item) => item.itemId === itemId);
        const beforeFormula = beforeItem && beforeItem.itemType === 'expression' ? describeExpression(beforeItem.expression) : '';
        const after = patchExpression(pack, itemId, patch);
        const written = writePack({
          registry: packRegistry,
          db: STORAGE.db,
          supported: SUPPORTED_PACK_ENGINE_APIS,
          validateFor: packValidatorForWithConditions,
          input: JSON.parse(JSON.stringify(after)) as unknown,
          by: adminId,
        });
        if (!written.ok) {
          json(res, 200, { ok: false, code: written.code, message: written.message, state: stateFor(req) });
          return;
        }
        const { result } = written;
        packStoreReport = result.report;
        const afterItem = after.items.find((item) => item.itemId === itemId) as ExpressionDefinition | undefined;
        const afterFormula = describeExpression(afterItem?.expression as ExprNode);
        if (result.action !== 'unchanged') {
          recordAdminAudit({
            actor: adminId,
            subject: '内容包',
            kind: '变更',
            before: { 包指纹: result.fingerprintBefore ?? '（原先没有这个包）' },
            after: { 包指纹: result.fingerprintAfter },
            note: `改表达式控件 ${packId} / ${itemId}：${[
              patch.name !== undefined ? `名称 →「${String(patch.name)}」` : '',
              patch.unit !== undefined ? `单位 → ${String(patch.unit) === '' ? '（去掉）' : String(patch.unit)}` : '',
              patch.description !== undefined ? '说明有改动' : '',
              /* 公式要记**原文**：只记"公式改了"，事后没人说得清它以前怎么算的 */
              patch.expression !== undefined ? `公式 → ${beforeFormula} ⇒ ${afterFormula}（已开出的病历不重算，下次重算时按新公式）` : '',
            ].filter((part) => part !== '').join('；')}`,
          });
        }
        entry.log.push({
          at: new Date().toISOString(),
          action: `改表达式控件 ${packId} / ${itemId}：${afterFormula}（内容指纹 → ${result.fingerprintAfter}）（操作者 ${adminId}）`,
          ok: true,
        });
        json(res, 200, {
          ok: true,
          data: { packId, itemId, formula: afterFormula, action: result.action, fingerprintAfter: result.fingerprintAfter },
          state: stateFor(req),
        });
      } catch (err) {
        json(res, 200, {
          ok: false,
          code: (err as { code?: string }).code ?? 'E_EXPR_UPDATE_FAILED',
          message: (err as Error).message,
          state: stateFor(req),
        });
      }
      return;
    }

    case '/api/expression-item-delete': {
      /* 删一个表达式控件：被文书引用时拒绝（并列出是哪些文书在用）。
         理由见内核 `removeExpression`：删掉它，报错会出现在"医生要开那份文书"的时候。  */
      const entry = current();
      let adminId: string;
      try {
        adminId = requireAdminSession(req, entry, '表达式控件', '删除医学表达式控件', 'pack.toggle');
      } catch (err) {
        json(res, 200, {
          ok: false,
          code: (err as { code?: string }).code ?? 'E_AUTH_REQUIRED',
          message: (err as Error).message,
          state: stateFor(req),
        });
        return;
      }
      const packId = typeof body.packId === 'string' ? body.packId : '';
      const itemId = typeof body.itemId === 'string' ? body.itemId : '';
      const pack = packId === '' ? undefined : (packRegistry.get(packId) as TemplatePack | undefined);
      if (!pack || itemId === '') {
        json(res, 200, {
          ok: false,
          code: 'E_PACK_FIELD_MISSING',
          message: '请给出 packId 与 itemId（要删哪个控件）',
          state: stateFor(req),
        });
        return;
      }
      try {
        const beforeItem = pack.items.find((item) => item.itemId === itemId) as ExpressionDefinition | undefined;
        const name = beforeItem?.name ?? itemId;
        const after = removeExpression(pack, itemId);
        if (after.items.length === 0) {
          const removed = deletePack({ registry: packRegistry, db: STORAGE.db, packId });
          packStoreReport = removed.report;
          recordAdminAudit({
            actor: adminId,
            subject: '内容包',
            kind: '变更',
            before: { 包指纹: '（见前后指纹）' },
            after: { 包指纹: '（包已删除）' },
            note: `删除表达式控件 ${packId} / ${itemId}「${name}」：它是这个包里最后一条，包一并移除`,
          });
          entry.log.push({
            at: new Date().toISOString(),
            action: `删除表达式控件 ${packId} / ${itemId}「${name}」（包里已空，整包移除）（操作者 ${adminId}）`,
            ok: true,
          });
          json(res, 200, { ok: true, data: { packId, itemId, action: 'deleted' }, state: stateFor(req) });
          return;
        }
        const written = writePack({
          registry: packRegistry,
          db: STORAGE.db,
          supported: SUPPORTED_PACK_ENGINE_APIS,
          validateFor: packValidatorForWithConditions,
          input: JSON.parse(JSON.stringify(after)) as unknown,
          by: adminId,
        });
        if (!written.ok) {
          json(res, 200, { ok: false, code: written.code, message: written.message, state: stateFor(req) });
          return;
        }
        const { result } = written;
        packStoreReport = result.report;
        if (result.action !== 'unchanged') {
          recordAdminAudit({
            actor: adminId,
            subject: '内容包',
            kind: '变更',
            before: { 包指纹: result.fingerprintBefore ?? '（原先没有这个包）' },
            after: { 包指纹: result.fingerprintAfter },
            note: `删除表达式控件 ${packId} / ${itemId}「${name}」（没有被任何文书引用）`,
          });
        }
        entry.log.push({
          at: new Date().toISOString(),
          action: `删除表达式控件 ${packId} / ${itemId}「${name}」（内容指纹 → ${result.fingerprintAfter}）（操作者 ${adminId}）`,
          ok: true,
        });
        json(res, 200, {
          ok: true,
          data: { packId, itemId, action: result.action, fingerprintAfter: result.fingerprintAfter },
          state: stateFor(req),
        });
      } catch (err) {
        json(res, 200, {
          ok: false,
          code: (err as { code?: string }).code ?? 'E_EXPR_DELETE_FAILED',
          message: (err as Error).message,
          state: stateFor(req),
        });
      }
      return;
    }

    case '/api/control-item-create': {
      const entry = current();
      let adminId: string;
      try {
        adminId = requireAdminSession(req, entry, '专科控件', '新建专科控件', 'pack.toggle');
      } catch (err) {
        json(res, 200, {
          ok: false,
          code: (err as { code?: string }).code ?? 'E_AUTH_REQUIRED',
          message: (err as Error).message,
          state: stateFor(req),
        });
        return;
      }

      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (name === '') {
        json(res, 200, {
          ok: false,
          code: 'E_TPL_FIELD_INVALID',
          message: '请填控件名称（它是这一页表里那一行）',
          state: stateFor(req),
        });
        return;
      }
      const existing = packRegistry.get(CUSTOM_TEMPLATE_PACK_ID) as TemplatePack | undefined;
      try {
        const created = addControl(existing ?? null, {
          name,
          controlKind: body.controlKind as ControlKind,
          shape: body.shape as ControlShape,
          fields: body.fields as ControlFieldDef[],
          rows: Array.isArray(body.rows) ? (body.rows as Array<{ key: string; label: string }>) : undefined,
          columns: Array.isArray(body.columns) ? (body.columns as Array<{ key: string; label: string }>) : undefined,
          description: typeof body.description === 'string' ? body.description : undefined,
        });
        const written = writePack({
          registry: packRegistry,
          db: STORAGE.db,
          supported: SUPPORTED_PACK_ENGINE_APIS,
          validateFor: packValidatorForWithConditions,
          input: JSON.parse(JSON.stringify(created.pack)) as unknown,
          by: adminId,
        });
        if (!written.ok) {
          json(res, 200, { ok: false, code: written.code, message: written.message, state: stateFor(req) });
          return;
        }
        const { result } = written;
        packStoreReport = result.report;
        const createdItem = created.pack.items.find((item) => item.itemId === created.itemId) as ControlDefinition | undefined;
        const summary = `形状 ${String(createdItem?.shape)} / ${createdItem?.fields?.length ?? 0} 个字段`;
        recordAdminAudit({
          actor: adminId,
          subject: '内容包',
          kind: '变更',
          before: { 包指纹: result.fingerprintBefore ?? '（原先没有这个包）' },
          after: { 包指纹: result.fingerprintAfter },
          note: `新建专科控件 ${created.itemId}「${name}」（${summary}）：本系统不预置内置控件，控件由院内按专科自建`,
        });
        entry.log.push({
          at: new Date().toISOString(),
          action: `新建专科控件 ${created.itemId}「${name}」（${summary}；内容指纹 ${result.fingerprintAfter}）（操作者 ${adminId}）`,
          ok: true,
        });
        json(res, 200, {
          ok: true,
          data: {
            packId: created.pack.packId,
            itemId: created.itemId,
            shape: createdItem?.shape ?? null,
            fieldCount: createdItem?.fields?.length ?? 0,
            action: result.action,
            fingerprintAfter: result.fingerprintAfter,
          },
          state: stateFor(req),
        });
      } catch (err) {
        json(res, 200, {
          ok: false,
          code: (err as { code?: string }).code ?? 'E_CONTROL_CREATE_FAILED',
          message: (err as Error).message,
          state: stateFor(req),
        });
      }
      return;
    }

    case '/api/control-item-update': {
      /* 改一个专科控件：名称 / 语义类型 / 形状 / 说明 / 字段 / 行列。
         字段或形状一改，服务端会自动把定义升版（见内核 `patchControl`）：
         已开出的病历里存的是当时那份字段快照，同一版本号两种解读是最难查的一类错。
         所以界面上要说清"这次改动会让定义升到 v2"，而审计里要留改前改后的字段数与版本。  */
      const entry = current();
      let adminId: string;
      try {
        adminId = requireAdminSession(req, entry, '专科控件', '修改专科控件', 'pack.toggle');
      } catch (err) {
        json(res, 200, {
          ok: false,
          code: (err as { code?: string }).code ?? 'E_AUTH_REQUIRED',
          message: (err as Error).message,
          state: stateFor(req),
        });
        return;
      }
      const packId = typeof body.packId === 'string' ? body.packId : '';
      const itemId = typeof body.itemId === 'string' ? body.itemId : '';
      const pack = packId === '' ? undefined : (packRegistry.get(packId) as TemplatePack | undefined);
      if (!pack || itemId === '') {
        json(res, 200, {
          ok: false,
          code: 'E_PACK_FIELD_MISSING',
          message: '请给出 packId 与 itemId（要改哪个控件）',
          state: stateFor(req),
        });
        return;
      }
      const patch: ControlPatch = {};
      if (body.name !== undefined) patch.name = typeof body.name === 'string' ? body.name : '';
      if (body.description !== undefined) patch.description = typeof body.description === 'string' ? body.description : '';
      if (body.controlKind !== undefined) patch.controlKind = body.controlKind as ControlKind;
      if (body.shape !== undefined) patch.shape = body.shape as ControlShape;
      if (body.fields !== undefined) patch.fields = body.fields as ControlFieldDef[];
      /* 行列给 `null` = 清掉（形状从 matrix 改成别的时，那两行不该留在包里） */
      if (body.rows !== undefined) {
        patch.rows = Array.isArray(body.rows) ? (body.rows as Array<{ key: string; label: string }>) : null;
      }
      if (body.columns !== undefined) {
        patch.columns = Array.isArray(body.columns) ? (body.columns as Array<{ key: string; label: string }>) : null;
      }
      try {
        const beforeItem = pack.items.find((item) => item.itemId === itemId) as ControlDefinition | undefined;
        const beforeVersion = beforeItem?.version ?? 1;
        const beforeFieldCount = beforeItem?.fields?.length ?? 0;
        const after = patchControl(pack, itemId, patch);
        const written = writePack({
          registry: packRegistry,
          db: STORAGE.db,
          supported: SUPPORTED_PACK_ENGINE_APIS,
          validateFor: packValidatorForWithConditions,
          input: JSON.parse(JSON.stringify(after)) as unknown,
          by: adminId,
        });
        if (!written.ok) {
          json(res, 200, { ok: false, code: written.code, message: written.message, state: stateFor(req) });
          return;
        }
        const { result } = written;
        packStoreReport = result.report;
        const afterItem = after.items.find((item) => item.itemId === itemId) as ControlDefinition | undefined;
        const afterVersion = afterItem?.version ?? 1;
        const afterFieldCount = afterItem?.fields?.length ?? 0;
        if (result.action !== 'unchanged') {
          recordAdminAudit({
            actor: adminId,
            subject: '内容包',
            kind: '变更',
            before: { 包指纹: result.fingerprintBefore ?? '（原先没有这个包）' },
            after: { 包指纹: result.fingerprintAfter },
            note: `改专科控件 ${packId} / ${itemId}：${[
              patch.name !== undefined ? `名称 →「${String(patch.name)}」` : '',
              patch.description !== undefined ? '说明有改动' : '',
              patch.controlKind !== undefined ? `语义类型 → ${String(patch.controlKind)}` : '',
              patch.shape !== undefined ? `形状 → ${String(patch.shape)}` : '',
              patch.fields !== undefined ? `字段 ${beforeFieldCount} 格 ⇒ ${afterFieldCount} 格` : '',
              patch.rows !== undefined || patch.columns !== undefined ? '行列有改动' : '',
              /* 升版要说清后果：已开出的病历存着当时那份字段快照，它不跟着变 */
              afterVersion !== beforeVersion ? `定义升版 v${beforeVersion} → v${afterVersion}（已开出病历里的字段快照不变）` : '',
            ].filter((part) => part !== '').join('；')}`,
          });
        }
        entry.log.push({
          at: new Date().toISOString(),
          action: `改专科控件 ${packId} / ${itemId}「${String(afterItem?.name ?? itemId)}」（定义 v${afterVersion}；内容指纹 → ${result.fingerprintAfter}）（操作者 ${adminId}）`,
          ok: true,
        });
        json(res, 200, {
          ok: true,
          data: {
            packId,
            itemId,
            version: afterVersion,
            fieldCount: afterFieldCount,
            action: result.action,
            fingerprintAfter: result.fingerprintAfter,
          },
          state: stateFor(req),
        });
      } catch (err) {
        json(res, 200, {
          ok: false,
          code: (err as { code?: string }).code ?? 'E_CONTROL_UPDATE_FAILED',
          message: (err as Error).message,
          state: stateFor(req),
        });
      }
      return;
    }

    case '/api/control-item-delete': {
      /* 删一个专科控件。与表达式控件不同，这里没有"还被谁引用"的拦截：
         文书的槽位今天还没有"控件"这一类，所以没有任何东西会引用它。
         等槽位能引用控件之后，这条检查必须补上（见内核 `removeControl` 的注释）。  */
      const entry = current();
      let adminId: string;
      try {
        adminId = requireAdminSession(req, entry, '专科控件', '删除专科控件', 'pack.toggle');
      } catch (err) {
        json(res, 200, {
          ok: false,
          code: (err as { code?: string }).code ?? 'E_AUTH_REQUIRED',
          message: (err as Error).message,
          state: stateFor(req),
        });
        return;
      }
      const packId = typeof body.packId === 'string' ? body.packId : '';
      const itemId = typeof body.itemId === 'string' ? body.itemId : '';
      const pack = packId === '' ? undefined : (packRegistry.get(packId) as TemplatePack | undefined);
      if (!pack || itemId === '') {
        json(res, 200, {
          ok: false,
          code: 'E_PACK_FIELD_MISSING',
          message: '请给出 packId 与 itemId（要删哪个控件）',
          state: stateFor(req),
        });
        return;
      }
      try {
        const beforeItem = pack.items.find((item) => item.itemId === itemId) as ControlDefinition | undefined;
        const name = beforeItem?.name ?? itemId;
        const after = removeControl(pack, itemId);
        if (after.items.length === 0) {
          const removed = deletePack({ registry: packRegistry, db: STORAGE.db, packId });
          packStoreReport = removed.report;
          recordAdminAudit({
            actor: adminId,
            subject: '内容包',
            kind: '变更',
            before: { 包指纹: '（见前后指纹）' },
            after: { 包指纹: '（包已删除）' },
            note: `删除专科控件 ${packId} / ${itemId}「${name}」：它是这个包里最后一条，包一并移除`,
          });
          entry.log.push({
            at: new Date().toISOString(),
            action: `删除专科控件 ${packId} / ${itemId}「${name}」（包里已空，整包移除）（操作者 ${adminId}）`,
            ok: true,
          });
          json(res, 200, { ok: true, data: { packId, itemId, action: 'deleted' }, state: stateFor(req) });
          return;
        }
        const written = writePack({
          registry: packRegistry,
          db: STORAGE.db,
          supported: SUPPORTED_PACK_ENGINE_APIS,
          validateFor: packValidatorForWithConditions,
          input: JSON.parse(JSON.stringify(after)) as unknown,
          by: adminId,
        });
        if (!written.ok) {
          json(res, 200, { ok: false, code: written.code, message: written.message, state: stateFor(req) });
          return;
        }
        const { result } = written;
        packStoreReport = result.report;
        if (result.action !== 'unchanged') {
          recordAdminAudit({
            actor: adminId,
            subject: '内容包',
            kind: '变更',
            before: { 包指纹: result.fingerprintBefore ?? '（原先没有这个包）' },
            after: { 包指纹: result.fingerprintAfter },
            note: `删除专科控件 ${packId} / ${itemId}「${name}」`,
          });
        }
        entry.log.push({
          at: new Date().toISOString(),
          action: `删除专科控件 ${packId} / ${itemId}「${name}」（内容指纹 → ${result.fingerprintAfter}）（操作者 ${adminId}）`,
          ok: true,
        });
        json(res, 200, {
          ok: true,
          data: { packId, itemId, action: result.action, fingerprintAfter: result.fingerprintAfter },
          state: stateFor(req),
        });
      } catch (err) {
        json(res, 200, {
          ok: false,
          code: (err as { code?: string }).code ?? 'E_CONTROL_DELETE_FAILED',
          message: (err as Error).message,
          state: stateFor(req),
        });
      }
      return;
    }

    case '/api/template-item-delete': {
      /* 删一份文书：包里少一条内容。
         它不动任何已开出的病历（病历里只有模板指纹，模板不在了指纹还在，
         只是"出自哪一份"查不到内容了）—— 这句话必须说在界面上，
         否则"删掉一份文书"听起来像"删掉一批病历"。  */
      const entry = current();
      let adminId: string;
      try {
        adminId = requireAdminSession(req, entry, '模板条目', '删除文书模板', 'pack.toggle');
      } catch (err) {
        json(res, 200, {
          ok: false,
          code: (err as { code?: string }).code ?? 'E_AUTH_REQUIRED',
          message: (err as Error).message,
          state: stateFor(req),
        });
        return;
      }
      const packId = typeof body.packId === 'string' ? body.packId : '';
      const itemId = typeof body.itemId === 'string' ? body.itemId : '';
      const pack = packId === '' ? undefined : packRegistry.get(packId);
      if (!pack || itemId === '') {
        json(res, 200, {
          ok: false,
          code: 'E_PACK_FIELD_MISSING',
          message: '请给出 packId 与 itemId（要删哪一份文书）',
          state: stateFor(req),
        });
        return;
      }
      if (pack.kind !== 'template') {
        json(res, 200, { ok: false, code: 'E_PACK_NOT_FOUND', message: `包「${packId}」不是模板包`, state: stateFor(req) });
        return;
      }
      try {
        const name = (pack as TemplatePack).items.find((item) => item.itemId === itemId)?.name ?? itemId;
        const after = removeTemplate(pack as TemplatePack, itemId);
        if (after.items.length === 0) {
          const removed = deletePack({ registry: packRegistry, db: STORAGE.db, packId });
          packStoreReport = removed.report;
          recordAdminAudit({
            actor: adminId,
            subject: '内容包',
            kind: '变更',
            before: { 包指纹: (packStoreReport.packs ?? []).length === 0 ? '（删完后库里没有包了）' : '（见前后指纹）' },
            after: { 包指纹: '（包已删除）' },
            note: `删除文书 ${packId} / ${itemId}「${name}」：它是这个包里最后一条，包一并移除（已开出的病历不受影响：它们只带着模板指纹）`,
          });
          entry.log.push({
            at: new Date().toISOString(),
            action: `删除文书 ${packId} / ${itemId}「${name}」（包里已空，整包移除）（操作者 ${adminId}）`,
            ok: true,
          });
          json(res, 200, { ok: true, data: { packId, itemId, action: 'deleted' }, state: stateFor(req) });
          return;
        }
        const written = writePack({
          registry: packRegistry,
          db: STORAGE.db,
          supported: SUPPORTED_PACK_ENGINE_APIS,
          validateFor: packValidatorForWithConditions,
          input: JSON.parse(JSON.stringify(after)) as unknown,
          by: adminId,
        });
        if (!written.ok) {
          json(res, 200, { ok: false, code: written.code, message: written.message, state: stateFor(req) });
          return;
        }
        const { result } = written;
        packStoreReport = result.report;
        if (result.action !== 'unchanged') {
          recordAdminAudit({
            actor: adminId,
            subject: '内容包',
            kind: '变更',
            before: { 包指纹: result.fingerprintBefore ?? '（原先没有这个包）' },
            after: { 包指纹: result.fingerprintAfter },
            note: `删除文书 ${packId} / ${itemId}「${name}」（已开出的病历不受影响：它们只带着模板指纹）`,
          });
        }
        entry.log.push({
          at: new Date().toISOString(),
          action: `删除文书 ${packId} / ${itemId}「${name}」（内容指纹 → ${result.fingerprintAfter}）（操作者 ${adminId}）`,
          ok: true,
        });
        json(res, 200, {
          ok: true,
          data: { packId, itemId, action: result.action, fingerprintAfter: result.fingerprintAfter },
          state: stateFor(req),
        });
      } catch (err) {
        json(res, 200, {
          ok: false,
          code: (err as { code?: string }).code ?? 'E_TPL_DELETE_FAILED',
          message: (err as Error).message,
          state: stateFor(req),
          });
          }
          return;
          }

          case '/api/template-item-duplicate': {
          const entry = current();
          let adminId: string;
          try {
          adminId = requireAdminSession(req, entry, '模板条目', '复制文书模板', 'pack.toggle');
          } catch (err) {
          json(res, 200, {
            ok: false,
            code: (err as { code?: string }).code ?? 'E_AUTH_REQUIRED',
            message: (err as Error).message,
            state: stateFor(req),
          });
          return;
          }
          const packId = typeof body.packId === 'string' ? body.packId : '';
          const itemId = typeof body.itemId === 'string' ? body.itemId : '';
          const source = packId === '' ? undefined : packRegistry.get(packId);
          if (!source || itemId === '') {
          json(res, 200, {
            ok: false,
            code: 'E_PACK_FIELD_MISSING',
            message: '请给出 packId 与 itemId（要复制哪一份文书）',
            state: stateFor(req),
          });
          return;
          }
          if (source.kind !== 'template') {
          json(res, 200, { ok: false, code: 'E_PACK_NOT_FOUND', message: `包「${packId}」不是模板包`, state: stateFor(req) });
          return;
          }
          try {
          const target = (packRegistry.get(CUSTOM_TEMPLATE_PACK_ID) as TemplatePack | undefined) ?? null;
          const copied = copyTemplateIntoPack(target, source as TemplatePack, itemId, {
            /* 名称给了就用它（界面"复制"是"复制并改名"一步到位），不给就按「原名（副本）」 */
            ...(typeof body.name === 'string' && body.name.trim() !== '' ? { name: body.name } : {}),
          });
          const written = writePack({
            registry: packRegistry,
            db: STORAGE.db,
            supported: SUPPORTED_PACK_ENGINE_APIS,
            validateFor: packValidatorForWithConditions,
            input: JSON.parse(JSON.stringify(copied.pack)) as unknown,
            by: adminId,
          });
          if (!written.ok) {
            json(res, 200, { ok: false, code: written.code, message: written.message, state: stateFor(req) });
            return;
          }
          const { result } = written;
          packStoreReport = result.report;
          const carryNote = copied.copiedControls.length > 0
            ? `（一并带过来 ${copied.copiedControls.length} 个表达式控件：${copied.copiedControls.map((item) => `${item.from} → ${item.to}`).join('、')}）`
            : '';
          if (result.action !== 'unchanged') {
            recordAdminAudit({
              actor: adminId,
              subject: '内容包',
              kind: '变更',
              before: { 包指纹: result.fingerprintBefore ?? '（原先没有这个包）' },
              after: { 包指纹: result.fingerprintAfter },
              note: `复制文书 ${packId} / ${itemId} → ${CUSTOM_TEMPLATE_PACK_ID} / ${copied.itemId}（副本是草稿，要开它得先发布）${carryNote}`,
            });
          }
          entry.log.push({
            at: new Date().toISOString(),
            action: `复制文书 ${packId} / ${itemId} → ${copied.itemId}（内容指纹 → ${result.fingerprintAfter}）${carryNote}（操作者 ${adminId}）`,
            ok: true,
          });
          json(res, 200, {
            ok: true,
            data: {
              packId: CUSTOM_TEMPLATE_PACK_ID,
              itemId: copied.itemId,
              copiedControls: copied.copiedControls,
              action: result.action,
              fingerprintAfter: result.fingerprintAfter,
            },
            state: stateFor(req),
          });
          } catch (err) {
          json(res, 200, {
            ok: false,
            code: (err as { code?: string }).code ?? 'E_TPL_COPY_FAILED',
            message: (err as Error).message,
            state: stateFor(req),
          });
          }
          return;
          }

          case '/api/fragment-item-create': {
          const entry = current();
          let adminId: string;
          try {
          adminId = requireAdminSession(req, entry, '模板条目', '新建章节片段', 'pack.toggle');
          } catch (err) {
          json(res, 200, {
            ok: false,
            code: (err as { code?: string }).code ?? 'E_AUTH_REQUIRED',
            message: (err as Error).message,
            state: stateFor(req),
          });
          return;
          }
          const name = typeof body.name === 'string' ? body.name : '';
          const sections = Array.isArray(body.sections) ? (body.sections as unknown as TemplateSection[]) : null;
          if (name.trim() === '' || !sections) {
          json(res, 200, {
            ok: false,
            code: 'E_TPL_FIELD_INVALID',
            message: '请给出片段名称与章节内容（片段至少要有一章）',
            state: stateFor(req),
          });
          return;
          }
          try {
          const existing = packRegistry.get(CUSTOM_TEMPLATE_PACK_ID) as TemplatePack | undefined;
          const created = addFragment(
            existing ?? null,
            { name, sections, ...(typeof body.description === 'string' ? { description: body.description } : {}) },
            { lookupControl: controlLookupAcrossPacks() },
          );
          const written = writePack({
            registry: packRegistry,
            db: STORAGE.db,
            supported: SUPPORTED_PACK_ENGINE_APIS,
            validateFor: packValidatorForWithConditions,
            input: JSON.parse(JSON.stringify(created.pack)) as unknown,
            by: adminId,
          });
          if (!written.ok) {
            json(res, 200, { ok: false, code: written.code, message: written.message, state: stateFor(req) });
            return;
          }
          const { result } = written;
          packStoreReport = result.report;
          const carryNote = created.copiedControls.length > 0
            ? `（一并带过来 ${created.copiedControls.length} 个表达式控件：${created.copiedControls.map((item) => `${item.from} → ${item.to}`).join('、')}）`
            : '';
          if (result.action !== 'unchanged') {
            recordAdminAudit({
              actor: adminId,
              subject: '内容包',
              kind: '变更',
              before: { 包指纹: result.fingerprintBefore ?? '（原先没有这个包）' },
              after: { 包指纹: result.fingerprintAfter },
              note: `新建章节片段 ${CUSTOM_TEMPLATE_PACK_ID} / ${created.itemId}「${name.trim()}」（${sections.length} 章）${carryNote}`,
            });
          }
          entry.log.push({
            at: new Date().toISOString(),
            action: `新建章节片段 ${created.itemId}「${name.trim()}」（内容指纹 → ${result.fingerprintAfter}）${carryNote}（操作者 ${adminId}）`,
            ok: true,
          });
          json(res, 200, {
            ok: true,
            data: {
              packId: CUSTOM_TEMPLATE_PACK_ID,
              itemId: created.itemId,
              copiedControls: created.copiedControls,
              action: result.action,
              fingerprintAfter: result.fingerprintAfter,
            },
            state: stateFor(req),
          });
          } catch (err) {
          json(res, 200, {
            ok: false,
            code: (err as { code?: string }).code ?? 'E_FRAGMENT_CREATE_FAILED',
            message: (err as Error).message,
            state: stateFor(req),
          });
          }
          return;
          }

          case '/api/fragment-item-update': {
          const entry = current();
          let adminId: string;
          try {
          adminId = requireAdminSession(req, entry, '模板条目', '修改章节片段', 'pack.toggle');
          } catch (err) {
          json(res, 200, {
            ok: false,
            code: (err as { code?: string }).code ?? 'E_AUTH_REQUIRED',
            message: (err as Error).message,
            state: stateFor(req),
          });
          return;
          }
          const packId = typeof body.packId === 'string' ? body.packId : '';
          const itemId = typeof body.itemId === 'string' ? body.itemId : '';
          const pack = packId === '' ? undefined : packRegistry.get(packId);
          if (!pack || itemId === '') {
          json(res, 200, {
            ok: false,
            code: 'E_PACK_FIELD_MISSING',
            message: '请给出 packId 与 itemId（要改哪一个片段）',
            state: stateFor(req),
          });
          return;
          }
          if (pack.kind !== 'template') {
          json(res, 200, { ok: false, code: 'E_PACK_NOT_FOUND', message: `包「${packId}」不是模板包`, state: stateFor(req) });
          return;
          }
          const changed: string[] = [];
          if (body.name !== undefined) changed.push('名称');
          if (body.description !== undefined) changed.push('说明');
          if (body.sections !== undefined) changed.push('内容');
          try {
          const after = patchFragment(
            pack as TemplatePack,
            itemId,
            {
              ...(body.name !== undefined ? { name: String(body.name) } : {}),
              ...(body.description !== undefined ? { description: String(body.description) } : {}),
              ...(body.sections !== undefined ? { sections: body.sections as unknown as TemplateSection[] } : {}),
            },
            { lookupControl: controlLookupAcrossPacks() },
          );
          const written = writePack({
            registry: packRegistry,
            db: STORAGE.db,
            supported: SUPPORTED_PACK_ENGINE_APIS,
            validateFor: packValidatorForWithConditions,
            input: JSON.parse(JSON.stringify(after)) as unknown,
            by: adminId,
          });
          if (!written.ok) {
            json(res, 200, { ok: false, code: written.code, message: written.message, state: stateFor(req) });
            return;
          }
          const { result } = written;
          packStoreReport = result.report;
          if (result.action !== 'unchanged') {
            recordAdminAudit({
              actor: adminId,
              subject: '内容包',
              kind: '变更',
              before: { 包指纹: result.fingerprintBefore ?? '（原先没有这个包）' },
              after: { 包指纹: result.fingerprintAfter },
              note: `修改章节片段 ${packId} / ${itemId}（改了 ${changed.join(' / ') || '（无）'}；`
                + '已用这个片段拼好的文书与已开出的病历都不受影响）',
            });
          }
          entry.log.push({
            at: new Date().toISOString(),
            action: `修改章节片段 ${packId} / ${itemId}（${changed.join(' / ')}）（内容指纹 → ${result.fingerprintAfter}）（操作者 ${adminId}）`,
            ok: true,
          });
          json(res, 200, {
            ok: true,
            data: { packId, itemId, action: result.action, fingerprintAfter: result.fingerprintAfter },
            state: stateFor(req),
          });
          } catch (err) {
          json(res, 200, {
            ok: false,
            code: (err as { code?: string }).code ?? 'E_FRAGMENT_UPDATE_FAILED',
            message: (err as Error).message,
            state: stateFor(req),
          });
          }
          return;
          }

          case '/api/fragment-item-delete': {
          /* 删一个章节片段：包里少一条素材。
           与删控件不同，这里没有"还被谁用着"要挡：插入片段是把章节复制进那份文书，
           之后两者再无联系 —— 所以删片段不会让任何文书变得开不出。
           反过来那句话说在界面上：已经用这个片段拼好的文书一个字都不会变。  */
          const entry = current();
          let adminId: string;
          try {
          adminId = requireAdminSession(req, entry, '模板条目', '删除章节片段', 'pack.toggle');
          } catch (err) {
          json(res, 200, {
            ok: false,
            code: (err as { code?: string }).code ?? 'E_AUTH_REQUIRED',
            message: (err as Error).message,
            state: stateFor(req),
          });
          return;
          }
          const packId = typeof body.packId === 'string' ? body.packId : '';
          const itemId = typeof body.itemId === 'string' ? body.itemId : '';
          const pack = packId === '' ? undefined : packRegistry.get(packId);
          if (!pack || itemId === '') {
          json(res, 200, {
            ok: false,
            code: 'E_PACK_FIELD_MISSING',
            message: '请给出 packId 与 itemId（要删哪一个片段）',
            state: stateFor(req),
          });
          return;
          }
          if (pack.kind !== 'template') {
          json(res, 200, { ok: false, code: 'E_PACK_NOT_FOUND', message: `包「${packId}」不是模板包`, state: stateFor(req) });
          return;
          }
          try {
          const name = (pack as TemplatePack).items.find((item) => item.itemId === itemId)?.name ?? itemId;
          const after = removeFragment(pack as TemplatePack, itemId);
          /* 删到最后一条：连包一起删（与删文书同一条处理，理由见那条的注释）  */
          if (after.items.length === 0) {
            const removed = deletePack({ registry: packRegistry, db: STORAGE.db, packId });
            packStoreReport = removed.report;
            recordAdminAudit({
              actor: adminId,
              subject: '内容包',
              kind: '变更',
              before: { 包指纹: '（见前后指纹）' },
              after: { 包指纹: '（包已删除）' },
              note: `删除章节片段 ${packId} / ${itemId}「${name}」：它是这个包里最后一条，包一并移除`,
            });
            entry.log.push({
              at: new Date().toISOString(),
              action: `删除章节片段 ${packId} / ${itemId}「${name}」（包里已空，整包移除）（操作者 ${adminId}）`,
              ok: true,
            });
            json(res, 200, { ok: true, data: { packId, itemId, action: 'deleted' }, state: stateFor(req) });
            return;
          }
          const written = writePack({
            registry: packRegistry,
            db: STORAGE.db,
            supported: SUPPORTED_PACK_ENGINE_APIS,
            validateFor: packValidatorForWithConditions,
            input: JSON.parse(JSON.stringify(after)) as unknown,
            by: adminId,
          });
          if (!written.ok) {
            json(res, 200, { ok: false, code: written.code, message: written.message, state: stateFor(req) });
            return;
          }
          const { result } = written;
          packStoreReport = result.report;
          if (result.action !== 'unchanged') {
            recordAdminAudit({
              actor: adminId,
              subject: '内容包',
              kind: '变更',
              before: { 包指纹: result.fingerprintBefore ?? '（原先没有这个包）' },
              after: { 包指纹: result.fingerprintAfter },
              note: `删除章节片段 ${packId} / ${itemId}「${name}」（已用这个片段拼好的文书不受影响：插入是复制，不是引用）`,
            });
          }
          entry.log.push({
            at: new Date().toISOString(),
            action: `删除章节片段 ${packId} / ${itemId}「${name}」（内容指纹 → ${result.fingerprintAfter}）（操作者 ${adminId}）`,
            ok: true,
          });
          json(res, 200, {
            ok: true,
            data: { packId, itemId, action: result.action, fingerprintAfter: result.fingerprintAfter },
            state: stateFor(req),
          });
          } catch (err) {
          json(res, 200, {
            ok: false,
            code: (err as { code?: string }).code ?? 'E_FRAGMENT_DELETE_FAILED',
            message: (err as Error).message,
            state: stateFor(req),
          });
          }
          return;
          }

          case '/api/reload-sidecars': {
      /* 落盘冲突之后唯一的出路：接受盘上那一版（= 放弃本终端尚未落盘的旁挂改动）。
         没有它，"本次未写入，请重新载入后再改"就是一句做不到的承诺，医生照着提示操作，
         却发现无处可点，最后只能"重置工作区"（那会把整个工作区清掉，代价远大于本意）。
         它不动文档、不改 rev、不写文档留痕：动的是旁挂数据（建议 / 注解）。 */
      const entry = current();
      entry.restored = false;
      entry.sidecarBaseline = undefined;
      ensureRestored(entry);
      const baseline: string | null | 'unknown' | undefined = entry.sidecarBaseline;
      const accepted = baseline === null || typeof baseline === 'string';
      if (accepted) entry.sidecarConflict = false;
      json(res, 200, {
        ok: accepted,
        ...(accepted
          ? {}
          : {
              code: 'E_RELOAD_FAILED',
              message: '重新载入失败：磁盘上那一版读不出来（或装载被拒），落盘仍保持关闭',
            }),
        data: {
          baseline: baseline === null ? '（盘上没有这个文件：已按首次落盘处理）' : typeof baseline === 'string' ? baseline : null,
          suggestions: entry.session.listSuggestions().length,
        },
        state: stateFor(req),
      });
      return;
    }

    case '/api/knowledge-pack-load': {
      /* 包唯一的入口（`writePack` 是存储层唯一的写路径）。
         两种用法：`{ pack: <包 JSON> }` 载入一份外部包；`{ sample: 'builtin' }` 载入代码里的示例包，
         后者只为让演示/自测不至于"库是空的、模板与规则全都不能用"，不是自动播种：
         要不要载、载哪一份，是人的动作。

         三条的处置：
           - 覆盖要留痕：`writePack` 报出指纹前后，这里据实写系统审计，
             "判定标准换了"必须查得到（它不进病历留痕，因为与任何一份病历无关）；
           - 关掉的条目不被顺手清掉：仍然存在的开关保留，新版里已没有的报出（`droppedSwitches`）；
           - 校验失败则库与注册表都不动（`writePack` 的契约：校验与冲突判定全部先于写入），
             所以这里不需要回滚任何东西，只把 `code/message` 透传给界面。 */
      const entry = current();
      let adminId: string;
      try {
        adminId = requireAdminSession(req, entry, '内容包', '载入内容包', 'pack.toggle');
      } catch (err) {
        json(res, 200, {
          ok: false,
          code: (err as { code?: string }).code ?? 'E_AUTH_REQUIRED',
          message: (err as Error).message,
          state: stateFor(req),
        });
        return;
      }

      /* `sample` 可以点名要哪一类：`true` = 目录下全部，`'template'` / `'rule'` = 只载那类。
         分得开是因为两个页签各自只管一类包：站在「模板」页点载入，不该顺手把规则包也换了
         （换规则包是改判定标准，是另一件要留痕的事）。 */
      const sampleKind = body.sample === 'template' ? 'template' : body.sample === 'rule' ? 'rule' : null;
      const sampleAll = body.sample === true;
      const inputs: unknown[] = sampleAll || sampleKind !== null
        ? readSamplePacks().filter((pack) => sampleKind === null || (pack as { kind?: unknown } | null)?.kind === sampleKind)
        : body.pack === undefined
          ? []
          : [body.pack];
      if ((sampleAll || sampleKind !== null) && inputs.length === 0) {
        json(res, 200, {
          ok: false,
          code: 'E_PACK_LOAD_SAMPLE_MISSING',
          message: `样例包目录里没有可载入的 .json：${SAMPLE_PACK_DIR}`,
          state: stateFor(req),
        });
        return;
      }
      if (inputs.length === 0) {
        json(res, 200, {
          ok: false,
          code: 'E_PACK_LOAD_INPUT_REQUIRED',
          message: '请给出要载入的包：`{ pack: <包 JSON> }`，或 `{ sample: true }` 载入 samples/packs 下的样例包（sample 取 template / rule 时只载其中一类）',
          state: stateFor(req),
        });
        return;
      }

      const results: Array<Record<string, unknown>> = [];
      let failed = false;
      for (const input of inputs) {
        const written = writePack({
          registry: packRegistry,
          db: STORAGE.db,
          supported: SUPPORTED_PACK_ENGINE_APIS,
          validateFor: packValidatorForWithConditions,
          input,
          by: adminId,
        });
        if (!written.ok) {
          results.push({ ok: false, code: written.code, message: written.message });
          failed = true;
          break;
        }
        const { result } = written;
        packStoreReport = result.report;
        results.push({
          ok: true,
          packId: result.packId,
          action: result.action,
          fingerprintBefore: result.fingerprintBefore,
          fingerprintAfter: result.fingerprintAfter,
          droppedSwitches: result.droppedSwitches,
          itemCount: result.summary.itemCount,
        });
        if (result.action !== 'unchanged') {
          recordAdminAudit({
            actor: adminId,
            subject: '内容包',
            kind: '变更',
            before: { 包指纹: result.fingerprintBefore ?? '（原先没有这个包）' },
            after: { 包指纹: result.fingerprintAfter },
            note:
              `${result.action === 'created' ? '载入' : '覆盖'}内容包 ${result.packId}（${result.summary.itemCount} 条）` +
              `${result.droppedSwitches.length > 0 ? `；新版里已不存在、被丢弃的开关：${result.droppedSwitches.join('、')}` : ''}`,
          });
        }
      }
      const loaded = results.filter((item) => item.ok === true);
      entry.log.push({
        at: new Date().toISOString(),
        action: failed
          ? `载入内容包失败（已成功 ${loaded.length} 份）：${results.find((item) => item.ok === false)?.message ?? ''}（操作者 ${adminId}）`
          : `载入内容包 ${loaded.length} 份：${loaded
              .map((item) => `${item.packId}（${item.action === 'created' ? '新增' : item.action === 'updated' ? '覆盖' : '内容相同，未改动'}）`)
              .join('、')}（操作者 ${adminId}）`,
        ok: !failed,
      });
      json(res, 200, {
        ok: !failed,
        ...(failed ? { code: String(results.find((item) => item.ok === false)?.code ?? 'E_PACK_STORE_WRITE'), message: String(results.find((item) => item.ok === false)?.message ?? '') } : {}),
        data: { results, report: packStoreReport },
        state: stateFor(req),
      });
      return;
    }
    case '/api/annotate': {
      /* 演示事中质控提示：旁挂，不改文档、不改 rev、不进文档留痕，
         因此签章之后仍然可以继续处置它（那正是质控该有的形态）。 */
      const entry = current();
      const nodeId = String(body.nodeId ?? '');
      const result = act(entry, `规则引擎提出质控提示（${nodeId}）`, () =>
        entry.session.annotate(
          {
            nodeId,
            kind: 'form',
            severity: 'warn',
            title: '本段缺少记录时间',
            detail: '形式质控规则 R-FORM-01：病程记录应包含记录时间与记录人。',
            suggestion: '补记"记录时间"，并核对与上一条记录的时间间隔。',
            source: { kind: 'system', ruleId: 'R-FORM-01' },
            dedupeKey: `R-FORM-01:${nodeId}`,
          },
          SYSTEM,
        ),
      );
      json(res, 200, { ...result, state: stateFor(req) });
      return;
    }

    case '/api/resolve-annotation': {
      const entry = current();
      const status = String(body.status ?? 'acknowledged') as 'acknowledged' | 'dismissed' | 'resolved';
      const result = act(entry, `处置质控提示（${status}）`, () =>
        entry.session.resolveAnnotation({ annotationId: String(body.annotationId ?? ''), status }, writeActor(req, entry)),
      );
      json(res, 200, { ...result, state: stateFor(req) });
      return;
    }

    case '/api/confirm-anchor-lost': {
      const entry = current();
      const result = act(entry, '确认质控提示锚点已随内容清除', () =>
        entry.session.confirmAnchorLost({ annotationId: String(body.annotationId ?? ''), note: '内容已按主任意见删除' }, writeActor(req, entry)),
      );
      json(res, 200, { ...result, state: stateFor(req) });
      return;
    }

    case '/api/suggest-batch': {
      /* 演示"一次产出多条"（语音转写 / 整篇草稿 / 批量取数都是这个形态）。
         置信度有意混入一条低值：用来演示组级采纳仍逐条过门控，
         够门槛的落笔、不够的保持待处理并报告（不是整批失败，也不是静默跳过）。 */
      const entry = current();
      const session = entry.session;
      const textNodes = Object.values(session.document.nodes)
        .filter((node) => node.type === 'text')
        .slice(0, 3);
      const mode = (['complete', 'draft', 'polish'] as const).find((item) => item === String(body.mode)) ?? 'draft';
      const nodeIds = textNodes.map((node) => node.id);
      let response: Awaited<ReturnType<AiAdapter['suggest']>>;
      let request: AiSuggestRequest;
      try {
        const ctx = buildAiContext(session.document, {
          nodeIds,
          contextBefore: 1,
          contextAfter: 0,
          actor: { id: AI.id, kind: AI.kind },
        });
        request = {
          context: ctx,
          mode,
          allowedNodeIds: targetNodeIdsOf(ctx),
          maxItems: modelConfigNow().config.maxItems,
          traceId: `demo-batch-${Date.now()}`,
        };
        response = await adapterNow().suggest(request);
      } catch (err) {
        json(res, 200, {
          ok: false,
          code: (err as { code?: string }).code ?? 'E_AI_CALL_FAILED',
          message: (err as Error).message,
          state: stateFor(req),
        });
        return;
      }
      const silence = resolveSilenceReport({ request, items: response.items, declared: response.skipped });
      entry.lastAiSilence = silence;
      if (response.items.length === 0) {
        json(res, 200, {
          ok: false,
          code: 'E_AI_NO_SUGGESTION',
          message: `产出方对本次 ${silence.targets} 个目标都没有产出建议（逐条原因见沉默报告）`,
          silence,
          state: stateFor(req),
        });
        return;
      }
      const result = act(entry, `AI 整批出建议（${mode} · ${response.items.length} 条 · ${response.modelId}）`, () =>
        session.suggestBatch(
          {
            items: response.items.map((item) => ({ nodeId: item.nodeId, text: item.text, confidence: item.confidence })),
            modelId: response.modelId,
            ...(response.promptId ? { promptId: response.promptId } : {}),
            traceId: `demo-trace-${Date.now()}`,
          },
          AI,
        ),
      );
      if (result.ok === true) {
        noteReuse(entry, `AI 整批出建议（${mode} · ${response.items.length} 条产出 · ${response.modelId}）`, result.data.reused);
      }
      json(res, 200, { ...result, usage: response.usage, state: stateFor(req) });
      return;
    }

    case '/api/accept-group': {
      const entry = current();
      const result = act(entry, '按组采纳建议', () => entry.session.acceptSuggestions({ groupId: String(body.groupId ?? '') }, writeActor(req, entry)));
      json(res, 200, { ...result, state: stateFor(req) });
      return;
    }

    case '/api/reject-group': {
      const entry = current();
      const result = act(entry, '按组拒绝建议', () =>
        entry.session.rejectSuggestions({ groupId: String(body.groupId ?? ''), reason: '整批与病史不符' }, writeActor(req, entry)),
      );
      json(res, 200, { ...result, state: stateFor(req) });
      return;
    }

    case '/api/accept': {
      const entry = current();
      const result = act(entry, '人工采纳建议', () =>
        entry.session.acceptSuggestion(
          {
            suggestionId: String(body.suggestionId ?? ''),
            ...(typeof body.editedText === 'string' && body.editedText.length > 0 ? { editedText: body.editedText } : {}),
            /* 逐句采纳时前端给出"哪几段是 AI 写的"；合法性由内核判（越界/重叠/空区间都报 E_OFFSET_RANGE），
               这里只做形状收敛，不做"纠正" —— 服务端替客户端改区间，等于替它编来源。 */
            ...(Array.isArray(body.aiRanges)
              ? {
                  aiRanges: body.aiRanges.map((range) => ({
                    start: Number((range as { start?: unknown } | null)?.start),
                    end: Number((range as { end?: unknown } | null)?.end),
                  })),
                }
              : {}),
          },
          writeActor(req, entry),
        ),
      );
      json(res, 200, { ...result, state: stateFor(req) });
      return;
    }

    case '/api/reject': {
      const entry = current();
      const result = act(entry, '人工拒绝建议', () =>
        entry.session.rejectSuggestion({ suggestionId: String(body.suggestionId ?? ''), reason: String(body.reason ?? '') }, writeActor(req, entry)),
      );
      json(res, 200, { ...result, state: stateFor(req) });
      return;
    }

    case '/api/edit': {
      const entry = current();
      const nodeId = String(body.nodeId ?? '');
      const text = String(body.text ?? '');
      const node = entry.session.document.nodes[nodeId];
      if (!node || node.type !== 'text') {
        json(res, 200, { ok: false, code: 'E_TYPE_MISMATCH', message: `节点 ${nodeId} 不是文本节点`, state: stateFor(req) });
        return;
      }
      const span = minimalEditSpan(node.runs.map((run) => run.text).join(''), text);
      if (!span) {
        json(res, 200, { ok: true, data: { skipped: 'no-change' }, state: stateFor(req) });
        return;
      }
      const result = act(entry, `人工修改文本（${nodeId} · 区间 ${span.start}~${span.end}）`, () =>
        entry.session.replaceRange({ nodeId, start: span.start, end: span.end, payload: { text: span.text } }, writeActor(req, entry)),
      );
      json(res, 200, { ...result, data: { ...(result.ok ? result.data : {}), span }, state: stateFor(req) });
      return;
    }

    case '/api/insert-paragraph': {
      const entry = current();
      const nodeId = String(body.nodeId ?? '');
      const anchor = contentOwnerOf(entry.session, nodeId);
      const sectionId = anchor?.parentId ?? null;
      if (!anchor || !sectionId) {
        json(res, 200, { ok: false, code: 'E_NODE_NOT_FOUND', message: `找不到 ${nodeId} 所属的段落/章节`, state: stateFor(req) });
        return;
      }
      const order = nextOrderAfter(entry.session, sectionId, anchor.order);
      const actor = writeActor(req, entry);
      const result = act(entry, `在下方插入段落（${anchor.id} 之后）`, () => {
        /* 一个段落由"段落节点 + 文本节点"两个节点构成 = 两次提交 → 开撤销组，
           让"撤销"一次撤掉整个新段落（只撤掉文本节点会留下空段落）。 */
        entry.session.beginUndoGroup();
        try {
          const paragraph = entry.session.createNode({ parentId: sectionId, type: 'paragraph', order }, actor);
          const paragraphId = paragraph.targetId as NodeId;
          const textNode = entry.session.createNode(
            { parentId: paragraphId, type: 'text', props: { runs: [{ text: '' }] } as Partial<DocNode> },
            actor,
          );
          return { paragraphId, textNodeId: textNode.targetId as NodeId };
        } finally {
          entry.session.endUndoGroup();
        }
      });
      json(res, 200, { ...result, state: stateFor(req) });
      return;
    }

    case '/api/move-node': {
      const entry = current();
      const nodeId = String(body.nodeId ?? '');
      const direction = body.direction === 'down' ? 'down' : 'up';
      const target = contentOwnerOf(entry.session, nodeId);
      if (!target || !target.parentId) {
        json(res, 200, { ok: false, code: 'E_NODE_NOT_FOUND', message: `找不到 ${nodeId} 所属的段落`, state: stateFor(req) });
        return;
      }
      const order = orderForMove(entry.session, target.parentId, target.order, direction);
      if (order === null) {
        const message = direction === 'up' ? '已经是本节第一段' : '已经是本节最后一段';
        /* 边界不是故障，但也不能"点了没反应"：写一条日志让拒绝横幅把它说清楚 */
        entry.log.push({
          at: new Date().toISOString(),
          action: `段落${direction === 'up' ? '上移' : '下移'}（${target.id}）：${message}`,
          ok: false,
          code: 'E_ALREADY_AT_BOUNDARY',
        });
        json(res, 200, { ok: false, code: 'E_ALREADY_AT_BOUNDARY', message, state: stateFor(req) });
        return;
      }
      const result = act(entry, `段落${direction === 'up' ? '上移' : '下移'}（${target.id}）`, () =>
        entry.session.moveNode({ nodeId: target.id, newParentId: target.parentId as NodeId, order }, writeActor(req, entry)),
      );
      json(res, 200, { ...result, state: stateFor(req) });
      return;
    }

    case '/api/set-image': {
      /* 空槽贴图 / 换图：目标是已经存在的图片节点（模板开出来的那一格）。
         与 `/api/insert-image` 的分工要清楚：那个是"新插一张图"，
         这个只回答"把这一格换成这张图"。  */
      const entry = current();
      const nodeId = String(body.nodeId ?? '');
      const resRef = String(body.resRef ?? '');
      const node = entry.session.document.nodes[nodeId];
      if (!node || node.type !== 'image') {
        json(res, 400, { ok: false, code: 'E_NOT_IMAGE', message: `${nodeId} 不是一张图（空槽贴图只作用于图片槽）` });
        return;
      }
      if (!readResourceBytes(resRef)) {
        json(res, 400, { ok: false, code: 'E_IMAGE_MISSING', message: `这张图不在本机：${resRef}` });
        return;
      }
      const altText = String(body.altText ?? '').trim();
      const result = act(entry, `贴图（${nodeId}）`, () => entry.session.setImageRef(
        { nodeId, resRef, ...(altText ? { altText } : {}) },
        writeActor(req, entry),
      ));
      json(res, 200, { ...result, state: stateFor(req) });
      return;
    }

    case '/api/delete-image': {
      const entry = current();
      const nodeId = String(body.nodeId ?? '');
      const node = entry.session.document.nodes[nodeId];
      if (!node || node.type !== 'image') {
        json(res, 200, { ok: false, code: 'E_NOT_IMAGE', message: `${nodeId} 不是一张图`, state: stateFor(req) });
        return;
      }
      const result = act(entry, `删除图片（${node.altText || node.resRef}）`, () =>
        entry.session.deleteNode({ nodeId, mode: 'subtree' }, writeActor(req, entry)));
      json(res, 200, { ...result, state: stateFor(req) });
      return;
    }

    case '/api/delete-node': {
      /* 删除段落（连同它的文本与字段子节点）。
         删除单位是段落而不是文本节点：只删文本会在结构里留下一个空段落（看不见，却还在）。
         关键内容禁删由内核查整棵子树（它守护的就是这条路径），所以这里不做二次判断。 */
      const entry = current();
      const nodeId = String(body.nodeId ?? '');
      const target = contentOwnerOf(entry.session, nodeId);
      if (!target || !target.parentId) {
        json(res, 200, { ok: false, code: 'E_NODE_NOT_FOUND', message: `找不到 ${nodeId} 所属的段落`, state: stateFor(req) });
        return;
      }
      const result = act(entry, `删除段落（${target.id}）`, () =>
        entry.session.deleteNode({ nodeId: target.id, mode: 'subtree' }, writeActor(req, entry)),
      );
      json(res, 200, { ...result, state: stateFor(req) });
      return;
    }

    case '/api/apply-edits': {
      const entry = current();
      const ops = Array.isArray(body.ops) ? body.ops : [];
      if (ops.length === 0) {
        json(res, 200, { ok: false, code: 'E_NO_OPS', message: '没有要落笔的操作', state: stateFor(req) });
        return;
      }
      const expectedRev = Number.isInteger(body.expectedRev) ? Number(body.expectedRev) : null;
      if (expectedRev !== null && expectedRev !== entry.session.docRev) {
        json(res, 200, {
          ok: false,
          code: 'E_REV_CONFLICT',
          message: `乐观锁冲突：这份病历已经是第 ${entry.session.docRev} 版，你看到的还是第 ${expectedRev} 版（多半是被别处改过）。界面会按最新内容自动重算一次。`,
          state: stateFor(req),
        });
        return;
      }
      const actor = writeActor(req, entry);
      type OpResult =
        | { ok: true; data: Record<string, unknown> }
        | { ok: false; code: string; message: string };
      const applied: string[] = [];
      const created: Array<{ afterNodeId: string | null; paragraphId: NodeId; textNodeId: NodeId; text: string }> = [];
      const failed: Array<{ index: number; op: string; code: string; message: string }> = [];
      let skipped = 0;
      let lastCreated: NodeId | null = null;
      const result = act(entry, `流式编辑批量落笔（${ops.length} 个操作）`, () => {
        entry.session.beginUndoGroup();
        try {
          ops.forEach((rawOp, index) => {
            const op = (rawOp ?? {}) as Record<string, unknown>;
            const kind = String(op.op ?? '');
            let outcome: OpResult;
            try {
              outcome = applyFlowOp(kind, op, { entry, actor, lastCreated });
            } catch (err) {
              const error = err as { code?: string; message?: string };
              outcome = { ok: false, code: error.code ?? 'UNEXPECTED', message: error.message ?? '未知原因' };
            }
            if (outcome.ok === true) {
              applied.push(kind);
              if (kind === 'edit' && outcome.data.skipped === true) skipped += 1;
              if (kind === 'insert') {
                const paragraphId = outcome.data.paragraphId as NodeId;
                lastCreated = paragraphId;
                created.push({
                  afterNodeId: (op.afterNodeId ?? null) as string | null,
                  paragraphId,
                  textNodeId: outcome.data.textNodeId as NodeId,
                  text: String(op.text ?? ''),
                });
              }
              return;
            }
            failed.push({ index, op: kind, code: outcome.code, message: outcome.message });
            entry.log.push({
              at: new Date().toISOString(),
              action: `流式编辑第 ${index + 1} 个操作（${kind}）未落笔：${outcome.message}`,
              ok: false,
              code: outcome.code,
            });
          });
        } finally {
          entry.session.endUndoGroup();
        }
        return { applied: applied.length, skipped, created, failed };
      });
      json(res, 200, { ...result, state: stateFor(req) });
      return;
    }

    case '/api/undo': {
      /* 撤销最近一次写入。标签必须写清"撤的是哪一条"，只写"撤销"，
         医生只能靠猜自己撤掉了什么（尤其在连续点两次之后）。
         内核查"最近一次的快照"，因此这里先问一次目标；没有就明确拒绝（而不是静默成功）。 */
      const entry = current();
      const target = entry.session.undoTarget();
      if (!target) {
        json(res, 200, {
          ok: false,
          code: 'E_NOTHING_TO_UNDO',
          message: '没有可撤销的写入：只支持撤销最近一次，且签章/解锁之后不可撤销',
          state: stateFor(req),
        });
        return;
      }
      const result = act(entry, `撤销第 ${target.rev} 条（${target.op}）`, () => entry.session.undoLast(writeActor(req, entry)));
      json(res, 200, { ...result, state: stateFor(req) });
      return;
    }

    /* 审签状态机（K12）：这四个动作与「签章/解锁」平级，全部经 `act` 留痕。
       界面上它们是四个按钮，内核里是同一套状态门禁 —— 不存在"界面能跳过审核直接签"这条路。 */
    case '/api/submit-review': {
      const entry = current();
      const note = String(body.note ?? '');
      const result = act(entry, '提交审核', () =>
        entry.session.submitForReview(note === '' ? {} : { note }, writeActor(req, entry)),
      );
      json(res, 200, { ...result, state: stateFor(req) });
      return;
    }

    case '/api/review': {
      const entry = current();
      const decision = body.decision === 'reject' ? 'reject' : 'approve';
      const note = String(body.note ?? '');
      const params = {
        decision,
        ...(note === '' ? {} : { note }),
        ...(body.acknowledgeUnconfirmed === true ? { acknowledgeUnconfirmed: true } : {}),
      } as { decision: 'approve' | 'reject'; note?: string; acknowledgeUnconfirmed?: boolean };
      /* 只有"通过"要签章（走签名后端）；**退回不签章** ——
         把两者塞进同一条 actAsync，会让"没配签名后端"变身成"不能退回"，
         而退回本来是审核里最常用的那个动作。 */
      /* `review` 是 async：退回也必须 await 着走，
         否则它抛出的 E_REVIEW_NOTE_REQUIRED 会变成没人接的 rejection（实测直接把服务打挂）。 */
      const result =
        decision === 'approve'
          ? await actAsync(entry, '审核通过（即签章）', () => {
              applySignerNow(entry);
              return entry.session.review(params, writeActor(req, entry));
            })
          : await actAsync(entry, '审核退回', () => entry.session.review(params, writeActor(req, entry)));
      json(res, 200, { ...result, state: stateFor(req) });
      return;
    }

    /* 回到历史版本（K21）：不是"撤销"，是跨过一整段 —— 留痕里会写下回到了哪一版、跨过了哪些。
       与四个状态机动作同一条纪律：它自己也是一条留痕，且同样要过状态门禁。 */
    case '/api/revert-to': {
      const entry = current();
      const rev = Number(body.rev);
      const result = act(entry, `回到第 ${Number.isInteger(rev) ? rev : '（未提供）'} 版`, () =>
        entry.session.revertTo({ rev }, writeActor(req, entry)),
      );
      json(res, 200, { ...result, state: stateFor(req) });
      return;
    }

    case '/api/void-doc': {
      const entry = current();
      const reason = String(body.reason ?? '');
      const result = act(entry, `作废（理由：${reason.trim() === '' ? '（未填）' : reason.trim()}）`, () =>
        entry.session.voidDoc({ reason }, writeActor(req, entry)),
      );
      json(res, 200, { ...result, state: stateFor(req) });
      return;
    }

    case '/api/archive-doc': {
      const entry = current();
      const result = act(entry, '归档', () => entry.session.archiveDoc({}, writeActor(req, entry)));
      json(res, 200, { ...result, state: stateFor(req) });
      return;
    }

    case '/api/unlock': {
      const entry = current();
      const reason = String(body.reason ?? '');
      const result = act(entry, `解锁已签章文档（理由：${reason.trim() === '' ? '（未填）' : reason.trim()}）`, () =>
        entry.session.unlock({ reason }, writeActor(req, entry)),
      );
      json(res, 200, { ...result, state: stateFor(req) });
      return;
    }

    case '/api/paste-text': {
      const entry = current();
      const nodeId = String(body.nodeId ?? '');
      const lines = String(body.text ?? '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line !== '');
      if (lines.length === 0) {
        json(res, 200, { ok: false, code: 'E_PASTE_EMPTY', message: '粘贴内容为空（或全是空白行）', state: stateFor(req) });
        return;
      }
      const anchor = contentOwnerOf(entry.session, nodeId);
      const anchorSectionId = anchor?.parentId ?? null;
      if (!anchor || !anchorSectionId) {
        json(res, 200, { ok: false, code: 'E_NODE_NOT_FOUND', message: `找不到 ${nodeId} 所属的段落/章节`, state: stateFor(req) });
        return;
      }
      /* 粘贴即落位：按落位策略判断每一段该进哪个章节。
         未命中的段落落在你粘贴的位置（不是"未落位"）—— 粘贴与语音唯一的语义差别就在这里：
         光标按下的那一处本身就是医生的意图，所以没有理由把他粘的东西挪去别处。
         `place: false` 可关掉（行为回到"全部落在光标处"）。
         它不改 provenance 判断：落位只决定放在哪，不决定算谁写的。  */
      const placement = body.place === false
        ? null
        : placePastedParagraphs({ texts: lines, anchorSectionId }, entry.session.indexes, placementConfigNow().config);
      const actor = writeActor(req, entry);
      const at = new Date().toISOString();
      /* 每个目标章节各自记一个 order 游标：
         落到锚点章节时插在锚点之后（与原行为一致）；落到别的章节时追加到该章节末尾 ——
         落位只能给到章节粒度，"插在那一章的哪个位置"它答不了，追加末尾是唯一不撒谎的选择。  */
      const cursors = new Map<string, number>();
      const orderFor = (targetSectionId: NodeId): number => {
        const previous = cursors.get(targetSectionId);
        const base = previous !== undefined
          ? previous
          : targetSectionId === anchorSectionId
            ? anchor.order
            : Math.max(0, ...entry.session.indexes.childrenOf(targetSectionId).map((child) => entry.session.document.nodes[child]?.order ?? 0));
        const next = nextOrderAfter(entry.session, targetSectionId, base);
        cursors.set(targetSectionId, next);
        return next;
      };
      const createParagraphs = (): { textNodeIds: string[]; paragraphs: number } => {
        const textNodeIds: string[] = [];
        lines.forEach((line, position) => {
          const targetSectionId = (placement?.items[position]?.sectionId ?? anchorSectionId) as NodeId;
          const paragraph = entry.session.createNode({ parentId: targetSectionId, type: 'paragraph', order: orderFor(targetSectionId) }, actor);
          const textNode = entry.session.createNode(
            {
              parentId: paragraph.targetId as NodeId,
              type: 'text',
              props: {
                runs: [{ text: line }],
                provenance: { origin: 'imported', actorId: actor.id, at },
                humanConfirmed: false,
              } as Partial<DocNode>,
            },
            actor,
          );
          textNodeIds.push(String(textNode.targetId));
        });
        return { textNodeIds, paragraphs: lines.length };
      };
      const moved = placement?.moved ?? 0;
      const result = act(entry, `粘贴文本（${lines.length} 段 · 来源未判定，按外来内容处理${moved > 0 ? ` · ${moved} 段按落位规则落到其他章节` : ''}）`, () => {
        /* 一次粘贴 = 2×N 次提交（每段 2 个节点：段落 + 文本）。开撤销组让"撤销"对齐这次动作，
           否则点一次撤销只拿回最后一段，还会留下一个空段落（看不见的坏结构）。
           `finally` 必须兜住：组开着会把后续无关的提交也吞进同一次撤销。 */
        entry.session.beginUndoGroup();
        try {
          return createParagraphs();
        } finally {
          entry.session.endUndoGroup();
        }
      });
      json(res, 200, {
        ...result,
        /* 落位结果随响应回去，界面据此说明"哪一段被挪到了哪一章、凭什么" ——
           "系统悄悄改了落点"是这条链路上最容易失去信任的一步，所以要能当场讲清楚 */
        placement: placement === null
          ? null
          : {
              enabled: placement.enabled,
              moved: placement.moved,
              warnings: placement.warnings,
              items: placement.items.map((item) => ({
                index: item.index,
                matched: item.matched,
                reason: item.reason,
                sectionId: item.sectionId,
                sectionTitle: item.sectionId ? sectionLabelOf(entry.session, item.sectionId) : null,
                /* 是否真的被挪走。由服务端判定，不让界面从 reason 文案里猜 ——
                   文案会改，而"这一段到底动没动"是事实  */
                moved: item.sectionId !== null && item.sectionId !== anchorSectionId,
              })),
            },
        state: stateFor(req),
      });
      return;
    }

    case '/api/image-upload': {
      /* 收图。body 是 JSON（`dataBase64`）而不是 multipart：
         前端从剪贴板 / 文件拿到的是 Blob，读成 dataURL 后本来就带 base64，
         再包一层 multipart 只是多一道解析、多一处"偶尔没收到"的现场。 */
      const raw = String(body.dataBase64 ?? '');
      const base64 = raw.replace(/^data:[^;]+;base64,/, '');
      if (base64 === '') {
        json(res, 400, { ok: false, code: 'E_IMAGE_EMPTY', message: '没有收到图片内容' });
        return;
      }
      /* 先按字符数挡一道：base64 字符数约为字节数 × 4/3。
         不先挡，一个 100 MB 的请求会先被解进内存再被拒绝。  */
      if (base64.length > Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 8) {
        json(res, 413, {
          ok: false,
          code: 'E_IMAGE_TOO_LARGE',
          message: `图片超过上限（${MAX_IMAGE_BYTES / 1024 / 1024} MB）`,
        });
        return;
      }
      const bytes = new Uint8Array(Buffer.from(base64, 'base64'));
      if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) {
        json(res, 413, {
          ok: false,
          code: 'E_IMAGE_TOO_LARGE',
          message: `图片为空，或超过上限（${MAX_IMAGE_BYTES / 1024 / 1024} MB）`,
        });
        return;
      }
      /* 必须自己认格式：`Content-Type` 与文件名都由发起方随手写，
         改个扩展名就能把任意字节塞进归档件；而写进归档件的东西，
         将来必须能被证明"当初是什么格式"。  */
      const probed = probeImage(bytes);
      if (!probed) {
        json(res, 415, {
          ok: false,
          code: 'E_IMAGE_UNSUPPORTED',
          message: '只接受 PNG / JPEG / WebP（认不出的格式，将来无法证明它是什么）',
        });
        return;
      }
      ensureResourceDir();
      /* 内容寻址：同一张图贴两次只存一份，且"图有没有被换过"退化成一次哈希比对 */
      const name = `${createHash('sha256').update(bytes).digest('hex')}.${IMAGE_EXTENSION[probed.mime]}`;
      const file = join(RESOURCE_DIR, name);
      if (!existsSync(file)) writeFileSync(file, bytes);
      json(res, 200, {
        ok: true,
        data: {
          resRef: `/res/${name}`,
          mime: probed.mime,
          width: probed.width,
          height: probed.height,
          bytes: bytes.length,
        },
        state: stateFor(req),
      });
      return;
    }

    case '/api/insert-image': {
      const entry = current();
      const paragraphId = String(body.paragraphId ?? '');
      const resRef = String(body.resRef ?? '');
      const target = entry.session.document.nodes[paragraphId];
      if (!target || target.type !== 'paragraph') {
        json(res, 400, { ok: false, code: 'E_NO_PARAGRAPH', message: '要贴图的那一段不在了（先刷新，再把图贴到现有段落上）' });
        return;
      }
      /* 只接受本机存在的资源：写进一个外部 URL，归档时就打不进字节，
         于是又回到"纸面有图、归档件没有"的假象 —— 这一轮要消灭的正是那个。  */
      if (!readResourceBytes(resRef)) {
        json(res, 400, { ok: false, code: 'E_IMAGE_MISSING', message: `这张图不在本机：${resRef}` });
        return;
      }
      const altText = String(body.altText ?? '').trim();
      const caption = String(body.caption ?? '').trim();
      const result = act(entry, `贴图（${altText || resRef}）`, () => entry.session.createNode(
        {
          parentId: paragraphId,
          type: 'image',
          props: {
            resRef,
            ...(altText ? { altText } : {}),
            ...(caption ? { caption } : {}),
          } as unknown as Partial<DocNode>,
        },
        writeActor(req, entry),
      ));
      json(res, 200, { ...result, state: stateFor(req) });
      return;
    }

    case '/api/set-field': {
      const entry = current();
      const nodeId = String(body.nodeId ?? '');
      const raw = String(body.value ?? '');
      const numeric = Number(raw);
      const value: string | number = Number.isFinite(numeric) && raw.trim() !== '' ? numeric : raw;
      const result = act(entry, `人工录入字段（${nodeId}）`, () => entry.session.setFieldValue({ nodeId, value, valueText: raw }, writeActor(req, entry)));
      json(res, 200, { ...result, state: stateFor(req) });
      return;
    }

    case '/api/set-control-field': {
      const entry = current();
      const nodeId = String(body.nodeId ?? '');
      const fieldKey = String(body.fieldKey ?? '');
      const raw = String(body.value ?? '');
      const node = entry.session.document.nodes[nodeId];
      const cell = node && node.type === 'control' ? controlCellByKey(node, fieldKey) : undefined;
      const trimmed = raw.trim();
      const value: JsonValue = trimmed === ''
        ? ''
        : cell && cell.dataType === 'boolean'
          ? trimmed === 'true'
          : cell && (cell.dataType === 'number' || cell.dataType === 'expression')
            ? (Number.isFinite(Number(trimmed)) ? Number(trimmed) : raw)
            : raw;
      const result = act(
        entry,
        `人工录入控件「${cell?.label ?? fieldKey}」（${nodeId}）`,
        () => entry.session.setControlValue({ nodeId, fieldKey, value }, writeActor(req, entry)),
      );
      json(res, 200, { ...result, state: stateFor(req) });
      return;
    }

    case '/api/confirm': {
      const entry = current();
      const result = act(entry, '人工确认内容', () => entry.session.confirmNode({ nodeId: String(body.nodeId ?? '') }, writeActor(req, entry)));
      json(res, 200, { ...result, state: stateFor(req) });
      return;
    }

    case '/api/confirm-subtree': {
      const entry = current();
      const nodeId = String(body.nodeId ?? '');
      const result = act(entry, `按章节确认（${nodeId}）`, () => entry.session.confirmSubtree({ nodeId }, writeActor(req, entry)));
      json(res, 200, { ...result, state: stateFor(req) });
      return;
    }

    case '/api/export-wst500': {
      /* 导出共享文档（区域平台/他人系统交换用）。
         与 OFD 导出是两条路：OFD 面向归档定版，共享文档面向跨系统交换。 */
      const entry = current();
      const file = join(ARTIFACTS, `${entry.docId}.wst500.xml`);
      const result = act(entry, '导出共享文档 WS/T 500', () => entry.session.writeWst500File(file));
      if (result.ok) {
        entry.lastWst500 = {
          file,
          bytes: result.data.bytes,
          sections: result.data.stats.sections,
          fields: result.data.stats.fields,
          paragraphs: result.data.stats.paragraphs,
          exportedAt: new Date().toISOString(),
        };
      }
      json(res, 200, { ...result, state: stateFor(req) });
      return;
    }

    case '/api/export-json': {
      /* 导出文档 JSON：独立探针的输入（S2 保真 / S3 留痕回放 / S5 模型校验）。
         现场验证真实数据时，"导入 → 导出 JSON → 跑三个探针"是最短的一条硬结论路径：
         它不经过我们的解析器结论，直接查文档本身是否守规矩。 */
      const entry = current();
      const file = join(ARTIFACTS, `${entry.docId}.doc.json`);
      const text = entry.session.exportJson({ canonical: true, pretty: true });
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, text, 'utf8');
      entry.lastJson = { file, bytes: text.length, nodes: Object.keys(entry.session.document.nodes).length, exportedAt: new Date().toISOString() };
      entry.log.push({ at: entry.lastJson.exportedAt, action: `导出文档 JSON（${file}，${entry.lastJson.nodes} 个节点）`, ok: true });
      json(res, 200, { ok: true, data: entry.lastJson, state: stateFor(req) });
      return;
    }

    case '/api/audit-report': {
      /* 生成审计报告：把留痕、AI 参与度、门控拒绝、签名、机读信息汇总成一份可交出去的产物。
         核查场景要的不是"系统里有这些数据"，而是一份能被复核的纸面。 */
      const entry = current();
      const at = new Date().toISOString();
      const report = buildAuditReport({
        doc: entry.session.document,
        generatedAt: at,
        /* 门控拒绝记录直接取自服务端日志（写路径拦下的操作），不另造一份 */
        gateRejections: entry.log
          .filter((item) => item.ok === false && typeof item.code === 'string')
          .map((item) => ({ at: item.at, code: item.code as string, ...(item.action ? { action: item.action } : {}) })),
        invariants: entry.session.verifyInvariants(),
        /* 书写时长取自当前会话（文档里那份是上次保存时落的，可能已经不是这一版） */
        writing: entry.session.timing(),
      });
      const jsonPath = join(ARTIFACTS, `${entry.docId}.audit.json`);
      const mdPath = join(ARTIFACTS, `${entry.docId}.audit.md`);
      mkdirSync(dirname(jsonPath), { recursive: true });
      writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
      writeFileSync(mdPath, renderAuditReportMarkdown(report), 'utf8');
      const failed = report.checks.filter((check) => !check.pass);
      entry.lastAudit = {
        jsonPath,
        mdPath,
        generatedAt: at,
        passed: report.checks.length - failed.length,
        total: report.checks.length,
        reportDigest: report.reportDigest,
        failed: failed.map((check) => ({ id: check.id, description: check.description, detail: check.detail })),
      };
      entry.log.push({
        at,
        action: `生成审计报告（${jsonPath}；机器可判定项 ${entry.lastAudit.passed}/${entry.lastAudit.total} 通过）`,
        ok: true,
      });
      json(res, 200, { ok: true, data: { lastAudit: entry.lastAudit, report }, state: stateFor(req) });
      return;
    }

    case '/api/recipient-keys/import': {
      /* 导入接收方公钥。必须校验点在曲线上：不在曲线上的点会让加密"成功"却没人解得开。 */
      const text = String(body.text ?? '');
      const label = String(body.label ?? '');
      const result = addRecipientKey(state.recipientKeys, {
        label,
        text,
        ...(body.note ? { note: String(body.note) } : {}),
        now: new Date().toISOString(),
      });
      if (!result.ok) {
        json(res, 200, { ok: false, code: result.code, message: result.reason, state: stateFor(req) });
        return;
      }
      state.recipientKeys = result.store;
      const persisted = persistRecipientKeys();
      current().log.push({
        at: new Date().toISOString(),
        action: `导入接收方公钥（${result.key.label}，指纹 ${result.key.fingerprint}）${persisted.ok ? '' : '；⚠️ 落盘失败：' + (persisted.message ?? '')}`,
        ok: persisted.ok,
      });
      json(res, 200, {
        ok: true,
        ...(persisted.ok ? {} : { code: 'E_KEY_PERSIST_FAILED', message: `导入成功但落盘失败：${persisted.message ?? ''}（重启后会丢失）` }),
        data: { key: result.key },
        state: stateFor(req),
      });
      return;
    }

    case '/api/recipient-keys/remove': {
      const keyId = String(body.keyId ?? '');
      const result = removeRecipientKey(state.recipientKeys, keyId);
      if (!result.ok) {
        json(res, 200, { ok: false, code: 'E_KEY_NOT_FOUND', message: result.reason ?? '没有这个接收方', state: stateFor(req) });
        return;
      }
      state.recipientKeys = result.store;
      const persisted = persistRecipientKeys();
      current().log.push({ at: new Date().toISOString(), action: `移除接收方公钥 ${keyId}`, ok: persisted.ok });
      json(res, 200, { ok: true, state: stateFor(req) });
      return;
    }

    case '/api/reading-authority': {
      /* 授权平台配置：与模型/落位/签名配置同一形态（GET 视图 / POST 保存，需管理员）。
         存独立文件 `reading-authority.json`，不进工作区快照，它是部署参数，
         混进快照，"重置工作区"会把它清掉（现场表现是"重置之后受控阅读整块不能用"）。
         它决定"信任哪个平台签发的阅读授权"，改它等于改谁有权把病历放给外部读，必须管理员动作。
         未配置时受控阅读拒绝一切凭据（fail-closed），而不是放行看看。 */
      const entry = current();
      /* GET 视图已在 handle() 顶部统一处理，写在这里会排在 405 guard 之后，永远到不了 */
      try {
        const by = requireAdminSession(req, entry, '授权平台配置');
        const before = describeReadingAuthority(readingAuthorityNow());
        const { loaded } = saveReadingAuthority(
          CONFIG_KV,
          {
            ...(body.endpoint === undefined ? {} : { endpoint: String(body.endpoint) }),
            ...(body.trustedIssuerPublicKeyBase64 === undefined ? {} : { trustedIssuerPublicKeyBase64: String(body.trustedIssuerPublicKeyBase64) }),
            ...(body.trustedIssuerFingerprint === undefined ? {} : { trustedIssuerFingerprint: String(body.trustedIssuerFingerprint) }),
          },
          by,
        );
        const after = describeReadingAuthority(loaded);
        recordAdminAudit({ actor: by, subject: '授权平台配置', kind: '变更', before, after });
        json(res, 200, { ok: true, data: after, state: stateFor(req) });
      } catch (err) {
        json(res, 200, {
          ok: false,
          code: (err as { code?: string }).code ?? 'E_CONFIG_REJECTED',
          message: (err as Error).message,
          state: stateFor(req),
        });
      }
      return;
    }

    case '/api/reading/grant': {
      /* 本系统不签发阅读授权。
         授权由院内授权平台签发，再经「导入授权凭据」（`/api/reading/import-credential`）进入本系统。

         保留这个路由不是为了兼容旧调用，而是为了给出一句可读的拒绝：删掉它只会得到 404，
         而 404 会被读成"版本不对 / 接口没了"，真相是"这一步在本系统里根本不存在"，
         本系统不持有签发私钥，这不是"没权限"，是没有那把钥匙。 */
      json(res, 410, {
        ok: false,
        code: 'E_AUTHORITY_NOT_ISSUABLE',
        message: '本系统不签发阅读授权：授权由院内授权平台签发，经「配置管理 → 受控阅读 → 导入授权凭据」进入本系统',
        state: stateFor(req),
      });
      return;
    }

    case '/api/reading/open': {
      const entry = current();
      const grantId = String(body.grantId ?? '');
      /* 按授权编号在全局索引里找：这样"拿 A 文档的授权去读 B 文档"会得到
         E_DOCUMENT_CHANGED（正确的语义），而不是 E_NOT_FOUND（看起来像记录丢了） */
      const record = state.readingGrants.get(grantId);
      if (!record) {
        json(res, 200, { ok: false, code: 'E_NOT_FOUND', message: `没有这个授权：${grantId}`, state: stateFor(req) });
        return;
      }
      /* 信任根复检：管理员随时可能把授权源改掉，索引里的旧凭据不能因此"免检"，
         否则"换了信任的钥匙"对已登记的授权毫无作用，那道配置就是假的。 */
      const stillTrusted = checkIssuerTrust(record.credential, readingAuthorityNow().config);
      if (!stillTrusted.ok) {
        json(res, 200, { ok: false, code: stillTrusted.code, message: stillTrusted.reason, state: stateFor(req) });
        return;
      }
      const environmentId = String(body.environmentId ?? 'WS-01');
      const at = String(body.at ?? new Date().toISOString());
      const context: ReadingContext = { environmentId, actorId: 'DR_DEMO', at, readCount: record.readCount };

      /* 加密交付的授权走"解封内容密钥 → 解密 → 再完整校验（有效期/次数/终端/章节/文档指纹）"。
         未勾选加密交付的授权仍是明文阅读（历史行为不变）。 */
      const sealed = record.sealed;
      let allowed: boolean;
      let code: string | undefined;
      let reasons: string[];
      let view: ReadingView | null;

      if (sealed) {
        const recipientKey = demoKeyPair(String(body.recipientSeed || sealed.recipientSeed));
        const result = openSealedForReading({
          envelope: sealed.envelope,
          credential: record.credential,
          recipient: {
            privateKey: recipientKey.privateKey,
            fingerprint: publicKeyFingerprint(recipientKey.publicKey),
          },
          context,
          revokedGrantIds: record.revoked ? [grantId] : [],
        });
        allowed = result.ok;
        code = result.code;
        reasons = result.reasons;
        view = result.view ?? null;
      } else {
        const decision = openForReading(record.credential, entry.session.document, context, {
          revokedGrantIds: record.revoked ? [grantId] : [],
        });
        allowed = decision.allowed;
        code = decision.code;
        reasons = decision.reasons;
        view = decision.view ?? null;
      }

      record.reads.push({
        at,
        environmentId,
        actorId: 'DR_DEMO',
        allowed,
        ...(code ? { code } : {}),
        ...(reasons[0] ? { reason: reasons[0] } : {}),
      });
      if (allowed) {
        /* 服务端集中记账：次数控制的唯一可靠记账点就在这里 */
        record.readCount += 1;
        entry.lastReadingView = view;
        entry.lastReadingSource = sealed ? 'unsealed' : 'plaintext';
      }
      entry.log.push({
        at,
        action: allowed
          ? `受控阅读 ${grantId}${sealed ? '（加密交付：已解封内容密钥）' : ''}（终端 ${environmentId}，剩余 ${view?.remainingReads ?? '不限'} 次）`
          : `受控阅读被拒 ${grantId}${sealed ? '（加密交付）' : ''}：${code}（${reasons[0] ?? ''}）`,
        ok: allowed,
        ...(code ? { code } : {}),
      });
      /* 记账与流水立刻落盘：次数控制的记账点就在这里，重启后计数必须还在，
         否则"次数用尽"会在重启后被重置，而界面上看不出任何异常。 */
      const readPersisted = persistReadingGrants();
      if (!readPersisted.ok) {
        entry.log.push({ at, action: `授权登记落盘失败：${readPersisted.message}`, ok: false });
      }
      json(res, 200, {
        ok: allowed,
        ...(code ? { code } : {}),
        message: reasons.join('；'),
        data: { decision: { allowed, code, reasons, view } },
        state: stateFor(req),
      });
      return;
    }

    case '/api/reading/revoke': {
      const entry = current();
      const grantId = String(body.grantId ?? '');
      const record = state.readingGrants.get(grantId);
      if (!record) {
        json(res, 200, { ok: false, code: 'E_NOT_FOUND', message: `没有这个授权：${grantId}`, state: stateFor(req) });
        return;
      }
      record.revoked = true;
      const revokedPersisted = persistReadingGrants();
      entry.log.push({
        at: new Date().toISOString(),
        action: `停用阅读授权 ${grantId}（本系统不再接纳该凭据）${revokedPersisted.ok ? '' : `（落盘失败：${revokedPersisted.message}）`}`,
        ok: revokedPersisted.ok,
      });
      json(res, 200, { ok: true, data: { persisted: revokedPersisted }, state: stateFor(req) });
      return;
    }

    case '/api/reading/import-credential': {
      const entry = current();
      const parsed = parseCredential(String(body.text ?? ''));
      if (!parsed.ok) {
        json(res, 200, { ok: false, code: parsed.code, message: parsed.reason, state: stateFor(req) });
        return;
      }
      const credential = parsed.credential;
      const selfConsistent = verifyCredential(credential);
      if (!selfConsistent.ok) {
        json(res, 200, {
          ok: false,
          code: 'E_CREDENTIAL_INVALID',
          message: `授权书自洽性校验未通过（内容被改动过）：${selfConsistent.reasons.join('；')}`,
          state: stateFor(req),
        });
        return;
      }
      const trusted = checkIssuerTrust(credential, readingAuthorityNow().config);
      if (!trusted.ok) {
        json(res, 200, { ok: false, code: trusted.code, message: trusted.reason, state: stateFor(req) });
        return;
      }
      if (credential.grant.docId !== entry.docId) {
        /* 授权书是给别的文档签的：在这里就说清，而不是登记进来、等阅读时才报 E_DOCUMENT_CHANGED */
        json(res, 200, {
          ok: false,
          code: 'E_DOCUMENT_CHANGED',
          message: `该授权书是给文档 ${credential.grant.docId} 签发的，当前病历是 ${entry.docId}`,
          state: stateFor(req),
        });
        return;
      }
      if (state.readingGrants.has(credential.grant.grantId)) {
        json(res, 200, { ok: false, code: 'E_GRANT_EXISTS', message: `已有同编号的授权：${credential.grant.grantId}`, state: stateFor(req) });
        return;
      }
      /* 密文信封一并登记：加密交付时，授权书里只有"密钥交付片段"（`keyDelivery`），
         而密文本身是（内容提供方）本系统的产物，不在授权书里，它随凭据一起送进来登记。
         没有它，这份授权即便合法也无从解封；缺它时会在阅读时被拒，
         而不是"悄悄当明文读"（那会让"加密交付"这个标记变成假话）。 */
      const envelopeInput = body.envelope;
      const sealedDelivery = envelopeInput !== null && typeof envelopeInput === 'object' && !Array.isArray(envelopeInput)
        ? {
            envelope: envelopeInput as Envelope,
            /* 演示用：真实形态下接收方私钥在其自己的设备上，服务端不持有 */
            recipientSeed: String(body.recipientSeed ?? ''),
            recipientLabel: String(body.recipientLabel ?? '（未标注）'),
          }
        : undefined;
      state.readingGrants.set(credential.grant.grantId, {
        credential,
        readCount: 0,
        revoked: false,
        reads: [],
        ...(sealedDelivery ? { sealed: sealedDelivery } : {}),
      });
      entry.log.push({
        at: new Date().toISOString(),
        /* 指纹写完整值（A6 纪律：服务端不截断机读数据/留痕） */
        action: `导入外部授权 ${credential.grant.grantId}（签发者指纹 ${credential.publicKeyFingerprint}；用途：${credential.grant.purpose}；${
          credential.grant.maxReads === null ? '不限次' : `${credential.grant.maxReads} 次`
        }）`,
        ok: true,
      });
      const importedPersisted = persistReadingGrants();
      json(res, 200, {
        ok: true,
        data: { grantId: credential.grant.grantId, publicKeyFingerprint: credential.publicKeyFingerprint, persisted: importedPersisted },
        state: stateFor(req),
      });
      return;
    }

    case '/api/structure-propose': {
      const entry = current();
      /* 读路径也要先恢复：否则"重启后第一次提议"会在一份空文档上算出"0 条"，
         而那看起来与"正文里没有可结构化的内容"一模一样（同 `/api/state` 的处置）。 */
      ensureRestored(entry as DocEntry & { restored?: boolean });
      const session = entry.session;
      const requested = Array.isArray(body.nodeIds) ? body.nodeIds.map((item) => String(item)) : [];
      /* 按文档阅读顺序取（同候选集口径）：界面按"第 N 段"呈现，顺序错了医生就对不上号  */
      const textNodes = orderedNodeIds({ nodes: session.document.nodes, rootId: session.document.rootId })
        .map((id) => session.document.nodes[id])
        .filter((node): node is Extract<DocNode, { type: 'text' }> => node?.type === 'text');
      const wanted = new Set(requested);
      const targets = wanted.size === 0 ? textNodes : textNodes.filter((node) => wanted.has(node.id));
      if (wanted.size > 0 && targets.length !== wanted.size) {
        const known = new Set(targets.map((node) => node.id));
        const missing = [...wanted].filter((id) => !known.has(id));
        json(res, 200, {
          ok: false,
          code: 'E_NODE_NOT_FOUND',
          message: `${missing.length} 个节点不在正文里（或不是文本节点）：${missing.join('、')}`,
          state: stateFor(req),
        });
        return;
      }
      const outcome = proposeStructurings({ texts: targets.map((node) => textOf(node)) }, placementConfigNow().config);
      json(res, 200, {
        ok: true,
        /* 挂在顶层（与 `placement` 同类：它描述"这次判定是怎么做的"，不是"产出了什么"内容）  */
        structure: {
          enabled: outcome.enabled,
          proposed: outcome.proposed,
          warnings: outcome.warnings,
          strategy: placementConfigNow().config.strategy,
          items: outcome.items.map((item, position) => {
            const node = targets[position];
            return {
              index: item.index,
              nodeId: node?.id ?? null,
              text: item.text,
              tag: item.tag,
              matched: item.matched,
              confidence: item.confidence,
              reason: item.reason,
              /* 已有的标签要带上：界面据此区分"没标过"与"标过了"（同一个按钮点两次不该出两份一样的东西） */
              existingTags: node?.tags ?? [],
              keyContent: node?.keyContent === true,
            };
          }),
        },
        state: stateFor(req),
      });
      return;
    }

    case '/api/structure-apply': {
      /* 采纳：把医生勾选的数据元绑到节点上（提议到这里才落笔）。
       *
       * 走 `updateNodeProps` 而不是自造写入口：rev +1、留痕、并发校验都是它的既有语义。
       * 同时把该节点打回"待确认"（`humanConfirmed:false`）：标签会进机读信息、被导出与下游
       * 直接消费，机器动过的内容必须由人再确认一次 —— 复用既有签章门控，不新造字段。
       * 对粘贴/AI 产出的段落本来就是未确认，这一步没有额外代价；对医生自己写的段落，
       * 这就是"机器改过的东西我要再看一眼"的代价，也正是它该有的代价。  */
      const entry = current();
      const session = entry.session;
      const rawItems = Array.isArray(body.items) ? body.items : [];
      if (rawItems.length === 0) {
        json(res, 200, {
          ok: false,
          code: 'E_STRUCTURE_NOTHING_TO_APPLY',
          message: '没有要绑定的数据元（这条请求等于什么都没做）',
          state: stateFor(req),
        });
        return;
      }
      const wanted: Array<{ nodeId: string; tag: DataElementTag }> = [];
      for (const [position, raw] of rawItems.entries()) {
        const item = (raw ?? {}) as Record<string, unknown>;
        const nodeId = String(item.nodeId ?? '');
        const tag = dataElementTagOf(item.tag);
        if (nodeId === '' || !tag) {
          json(res, 200, {
            ok: false,
            code: 'E_STRUCTURE_ITEM_INVALID',
            message: `第 ${position + 1} 条要绑定的数据元不合法：需要 nodeId 与 { system, code, display? }`,
            state: stateFor(req),
          });
          return;
        }
        wanted.push({ nodeId, tag });
      }
      const result = act(entry, `绑定数据元（${wanted.length} 条）`, () => {
        const actor = writeActor(req, entry);
        const applied: Array<{ nodeId: string; tag: DataElementTag }> = [];
        const skipped: Array<{ nodeId: string; tag: DataElementTag; reason: string }> = [];
        for (const { nodeId, tag } of wanted) {
          const node = session.document.nodes[nodeId];
          if (!node || node.type !== 'text') {
            skipped.push({ nodeId, tag, reason: '节点不存在或不是文本节点（标签只能绑在文本节点上）' });
            continue;
          }
          const existing = node.tags ?? [];
          if (existing.some((item) => sameDataElement(item, tag))) {
            skipped.push({ nodeId, tag, reason: '这一段已经有同一条数据元（不重复绑）' });
            continue;
          }
          session.updateNodeProps(
            /* 三个字段一次提交：标签生效、同时记为"机器绑的、待确认"、并把内容打回待确认。
               一次写、一条留痕，不出现"标签绑上了、待确认标记还没落"的中间态。 */
            {
              nodeId,
              patch: {
                tags: [...existing, tag],
                unconfirmedTags: [...(node.unconfirmedTags ?? []), tag],
                humanConfirmed: false,
              },
            },
            actor,
            /* 关掉"编辑即确认"：这次提交一个字都没改（只绑了标签），不能被读成
               "医生看过并负责这段内容" —— 否则内核会把上面那个 `false` 改回 `true`，
               机器猜的标签就拿到了人工背书。（关键内容本来就不适用"编辑即确认"。）  */
            { implyConfirm: false },
          );
          applied.push({ nodeId, tag });
        }
        return { applied, skipped };
      });
      json(res, 200, { ...result, state: stateFor(req) });
      return;
    }

    case '/api/refresh-machine': {
      const entry = current();
      const result = act(entry, '重算机读信息', () => entry.session.exportMachineReadable());
      json(res, 200, { ...result, state: stateFor(req) });
      return;
    }

    case '/api/sign': {
      /* 分级签章：关键内容未确认始终拒绝（内核保证，界面传什么都改不了）；
         非关键的 AI/导入内容未确认时，只有医生显式声明"已通读"才放行，
         且该声明连同"未确认清单"会进留痕。界面必须把这个选择明确摆出来，不能默默代勾。 */
      const entry = current();
      /* 签章要经过签名后端（可能是网络服务或密码设备），所以用 actAsync。
         后端未配置或调用失败 → 这次签章就是失败，绝不回退内置软件密钥。 */
      const result = await actAsync(entry, '签章', () => {
        applySignerNow(entry);
        return entry.session.sign({ acknowledgeUnconfirmed: body.acknowledgeUnconfirmed === true }, writeActor(req, entry));
      });
      json(res, 200, { ...result, state: stateFor(req) });
      return;
    }

    case '/api/export': {
      const entry = current();
      const file = join(ARTIFACTS, `${entry.docId}.ofd`);
      const result = await actAsync(entry, '导出 OFD-H', () => {
        applySignerIfSigned(entry);
        /* 图片字节从 `state/resources` 读出后打进容器（Res/MultiMedia）；
           取不到的图会回一条 warning，而不是画一张空框。  */
        return entry.session.writeOfdFile(file, PLAN, { resolveImage: readResourceBytes });
      });
      if (result.ok) {
        const probe = runProbe(file, entry.docId);
        entry.lastExport = {
          file,
          pages: result.data.pages,
          stats: result.data.stats,
          probe: probe.report,
          probeExit: probe.exit,
          exportedAt: new Date().toISOString(),
          warnings: result.data.warnings,
        };
        entry.log.push({
          at: new Date().toISOString(),
          action: `独立探针验收（${probe.report?.verdict ?? 'N/A'}）`,
          ok: probe.exit === 0,
          ...(probe.exit === 0 ? {} : { code: 'PROBE_FAIL' }),
        });
      }
      json(res, 200, { ...result, state: stateFor(req) });
      return;
    }

    default:
      json(res, 404, { ok: false, code: 'E_NOT_FOUND', message: `未知接口：${path}` });
  }
}

/* --------------------------- 算子插件（T3）：启动时装一次 ---------------------------
   插件是部署方安装的签名组件（不是包内容：包是数据，插件是代码，信任门槛不同）。
   它装在运行时目录的 `qc-plugins/` 下，每个插件一个子目录，必须签名验得过才会被装载。

   装不上不阻断启动（内核自带的算子够用），但必须被看见：静默跳过会让
   "插件没生效"表现成"规则没命中"，而界面上一切正常 —— 那是最难查的一类问题。
   `L0_QC_PLUGIN_DIR` 可把它指到别处（自测与联调都靠它）。  */
const QC_PLUGIN_ROOT = process.env.L0_QC_PLUGIN_DIR ?? join(RUNTIME.dir, 'qc-plugins');
const QC_PLUGIN_REPORT: QcPluginLoadReport = await loadQcPlugins({
  dir: QC_PLUGIN_ROOT,
  key: readPluginKey(RUNTIME.dir),
});

const portArgIndex = process.argv.indexOf('--port');
const PORT = portArgIndex >= 0 ? Number(process.argv[portArgIndex + 1]) || 8787 : 8787;
const HOST = '127.0.0.1';

createServer((req, res) => {
  handle(req, res).catch((err: unknown) => {
    json(res, 500, { ok: false, code: 'E_INTERNAL', message: (err as Error).message });
  });
}).listen(PORT, HOST, () => {
  const docs = state.entries.size;
  const patients = state.workspace?.patients.length ?? 0;
  process.stdout.write(`\n  L0 电子病历编辑器 Demo 已启动\n`);
  process.stdout.write(`  → 医生端 http://${HOST}:${PORT}\n`);
  process.stdout.write(`  → 管理后台 http://${HOST}:${PORT}/admin   （四个分区：能力配置 / 运行状态 / 审计与安全 / 系统信息）\n`);
  process.stdout.write(`            未登录会转到登录页 http://${HOST}:${PORT}/login\n`);
  process.stdout.write(`  工作区：${patients} 位患者 / ${docs} 份病历，各自独立会话与留痕  产物目录：artifacts/\n`);
  /* 账号打印现状。口令一律不打印（一个字节都不打）：它现在存在库里，
     而"页面上找不到口令"这件事必须由这里说清，否则第一次部署的人只会去翻源码。 */
  const accounts = accountStatus();
  if (accounts.initialized) {
    process.stdout.write(`  后台账号：${accounts.source}，其中可用管理员 ${accounts.admins} 个（口令已哈希入库，日志与页面都不显示）\n`);
    process.stdout.write(`            忘记口令：npm run user -- passwd <用户名>（见 README）\n`);
  } else {
    process.stdout.write(`  后台账号：尚未创建（${accounts.source}）\n`);
    process.stdout.write(`            → 打开 http://${HOST}:${PORT}/login 创建第一个管理员\n`);
  }
  /* 鉴权模式必须打在启动日志里：演示模式不设防，而"不设防"不能只是一处代码注释 */
  process.stdout.write(
    AUTH_MODE === 'open'
      ? '  ⚠ 鉴权模式：open（演示模式），医生端写病历不鉴权，任何能访问本端口的人都能写入。\n' +
        `     之所以还能接受：只监听 ${HOST}（回环），外部网络访问不到。\n` +
        '     生产部署必须在管理后台「系统信息」里把鉴权模式改成 strict（改完重启生效：它决定会话表怎么建）。\n'
      : '  鉴权模式：strict，医生端写操作也要求会话，并按角色判定\n',
  );
  /* 破坏性动作两种模式都收口，且这件事要在启动日志里说明：
     医生端不摆「重置」入口之后，`/api/reset` 只剩管理面与脚本在用，
     启动日志里说清"它要管理员"，比事后从 403 反推省事 */
  process.stdout.write(
    `  破坏性动作：重置工作区（/api/reset）需管理员身份（两种模式一致；登录在 /login）。\n`,
  );
  process.stdout.write(
    `  审计锚点：${auditAnchors.count()} 条（每 ${ANCHOR_EVERY} 条记录锚一次）` +
      `${ANCHOR_WRITE_ERROR ? `；⚠ ${ANCHOR_WRITE_ERROR}` : ''}\n`,
  );
  /* 服务端文件配置与系统策略的来源必须打出来：这两行回答"这台机器按什么跑、钥匙来自哪儿"。
     尤其"口令用的是内置演示值"这一条，只有在这里能被看见（见 core/server-config.ts 的纪律 3）。  */
  process.stdout.write(`  ${describeServerConfig(SERVER_CONFIG, STATE_KEY_INFO, STATE_SALT_HEX === undefined ? 'derived' : 'file')}\n`);
  process.stdout.write(
    `  系统策略（库 config.system）：鉴权 ${AUTH_MODE} / 会话 ${SESSION_TTL_MINUTES} 分钟 / ` +
      `限流 登录 ${RATE_RULES['login:actor'].limit}·${RATE_RULES['login:source'].limit}、AI ${RATE_RULES['ai:suggest'].limit}/分、导出 ${RATE_RULES.export.limit}/分 / 锚点每 ${ANCHOR_EVERY} 条\n`,
  );
  /* 内涵质控现状：引擎形态与规则条数（0 条规则与"跑了 0 命中"必须能在这里分开）  */
  const qcAtStart = qcContentSafe();
  process.stdout.write(
    `  内涵质控（库 config.qc-content）：引擎 ${qcAtStart.content === null ? `⚠ 配置读不出来（${qcAtStart.error}）` : qcAtStart.content.engine.kind} / ` +
      `规则 ${qcAtStart.content?.rules.length ?? 0} 条${qcAtStart.content?.rulesProblem ? `（⚠ ${qcAtStart.content.rulesProblem}）` : ''}\n`,
  );
  /* 运行时目录必须打出来：这是"数据在哪"的答案，也是"备份该备哪儿"的答案 */
  process.stdout.write(
    `  运行时目录：${RUNTIME.dir}（${RUNTIME.source === 'env-root' ? '来自 L0_RUNTIME_DIR' : '平台默认位置，不在仓库里'}）\n`,
  );
  if (RUNTIME_MIGRATION.copied.length > 0) {
    process.stdout.write(
      `  ⚠ 已把仓库里的旧运行时数据复制过来（${RUNTIME_MIGRATION.copied.length} 项）：${RUNTIME_MIGRATION.copied.join('、')}\n`,
    );
  }
  if (RUNTIME_ARCHIVE.archived.length > 0) {
    process.stdout.write(
      `  ⚠ 已把仓库里的旧运行时数据归档到（原处已清空，回滚从这里取）：${RUNTIME_ARCHIVE.archiveDir}\n` +
        `     归档项：${RUNTIME_ARCHIVE.archived.join('、')}\n`,
    );
  }
  if (RUNTIME_ARCHIVE_PLAN.skipped.length > 0 && RUNTIME_ARCHIVE.archived.length === 0) {
    process.stdout.write(
      `  提示：仓库里还有旧运行时数据未归档，${RUNTIME_ARCHIVE_PLAN.skipped.map((item) => `${item.from}（${item.why}）`).join('；')}\n`,
    );
  }
  /* 算子插件：装上了要打出来（它改变了"这台机器能配出哪些判定"），装不上更要打出来 */
  if (QC_PLUGIN_REPORT.loaded.length > 0) {
    process.stdout.write(
      `  算子插件：已装载 ${QC_PLUGIN_REPORT.loaded.map((item) => `${item.pluginId}@${item.version}（${item.operators.join('、')}）`).join('；')}\n`,
    );
  }
  for (const failure of QC_PLUGIN_REPORT.failures) {
    process.stdout.write(`  ⚠ 算子插件未装载（${failure.code}）：${failure.dir}\n     ${failure.reason}\n`);
  }
  if (!QC_PLUGIN_REPORT.dirPresent) {
    process.stdout.write(`  算子插件：未安装（${QC_PLUGIN_ROOT} 不存在，只用内核自带算子）\n`);
  }
  process.stdout.write(`  Ctrl+C 停止\n\n`);
});
