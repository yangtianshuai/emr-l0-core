import { spawnSync } from 'node:child_process';
/* 管理后台会话 id：必须是不可猜的随机值（它等同于一次登录凭证） */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { IMAGE_EXTENSION, MAX_IMAGE_BYTES, mimeOfExtension, probeImage } from '../media/image-probe.ts';

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
import { buildVisitTimeline, crossDocRulesOf, type VisitTimeline } from '../qc/visit-timeline.ts';
import { qcPredicateCatalog } from '../qc/predicates.ts';
import { conditionCatalog } from '../qc/condition.ts';
import {
  conditionSummaryOf,
  resolvedConditionsOf,
  ruleItemsOf,
  rulesFromRegistry,
  validateRulePack,
  type ConditionLibrary,
} from '../qc/rule-pack.ts';
import { SEED_CONDITIONS } from '../qc/seed-conditions.ts';
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
import { loadQcPlugins, readPluginKey, type QcPluginLoadReport } from '../qc/plugin.ts';
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
  addContent,
  CONTENT_KIND_LABELS,
  CONTENT_LIMITS,
  CONTENT_SCOPE_LABELS,
  ContentError,
  contentRefOf,
  describeContent,
  describeContentList,
  findSimilarContent,
  isContentScope,
  listContentFor,
  loadContent,
  markContentUsed,
  patchContent,
  placeholdersOf,
  removeContent,
  setContentPinned,
  type ContentItem,
  type ContentScopeRef,
} from '../content/content-store.ts';
import { scanText, type Finding as PhiFinding } from '../security/phi-scan.ts';
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
import { buildContext, CONTEXT_FIELDS, instantiateTemplate, substituteContext } from '../template/engine.ts';
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
import {
  describeSystemConfig,
  loadSystemConfig,
  saveSystemConfig,
  type AuthMode,
  type LoadedSystemConfig,
  type RateConfig,
} from '../storage/system-config.ts';
import { loadRecipientKeyStore as loadRecipientKeyTable, saveRecipientKeyStore as saveRecipientKeyTable } from '../storage/recipient-key-store.ts';
import {
  countReadingGrants,
  loadAllReadingGrants,
  syncReadingGrants,
  type ReadingGrantRecord,
} from '../storage/reading-grant-store.ts';
import { importReadingGrantsOnce } from '../storage/reading-grants-import.ts';
import {
  describeQcContentConfig,
  importQcRulesOnce,
  loadQcContentConfig,
  saveQcContentConfig,
  type LoadedQcContentConfig,
  type QcContentEngineKind,
} from '../qc/qc-content-store.ts';

const RUNTIME = resolveRuntimeLayout(process.env);

const SERVER_CONFIG = loadServerConfig(serverConfigPath(RUNTIME.dir));
const STATE_KEY_INFO = stateKeyOf(SERVER_CONFIG);
const STATE_PASSPHRASE = STATE_KEY_INFO.key;
const STATE_SALT_HEX = stateSaltHexOf(SERVER_CONFIG);
const ENV_NAME = envNameOf(SERVER_CONFIG);
const IMPORTS = importsOf(SERVER_CONFIG);
function statePassphrase(): string {
  return STATE_PASSPHRASE;
}
import { buildMachineReadable, machineToExpectation, orderedNodeIds } from '../model/machine.ts';
import { controlCellByKey, controlCellsOf } from '../model/control.ts';
import { checkConsistency, toSuggestionDrafts, type ConsistencyIssue } from '../model/consistency.ts';
import { TAG_SYSTEMS, type DataElementTag, type DocNode, type DocumentModel, type EvidenceRef, type NodeId, type TextRun } from '../model/types.ts';
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
import {
  PREVISIT_KEY_HEADER,
  checkAccess,
  describeAccess,
  loadAccess,
  saveAccess,
} from '../previsit/previsit-access.ts';
import { minimalEditSpan } from '../core/text-runs.ts';
import { DEFAULT_FURNITURE, DEFAULT_LAYOUT, type OfdExportPlan } from '../export/ofd.ts';
import { contentArea, imageBoxResolver, layoutDocument } from '../layout/page-layout.ts';
import { buildWorkspace, DEPARTMENTS, DOC_TYPES, type DemoWorkspace, type WorkspacePatient, type WorkspaceVisit } from './demo-doc.ts';
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
const UI_CSS_FILE = fileURLToPath(new URL('./ui.css', import.meta.url));
const UI_JS_FILE = fileURLToPath(new URL('./ui.js', import.meta.url));
const COMMAND_PALETTE_JS_FILE = fileURLToPath(new URL('./command-palette.js', import.meta.url));
const CAPTURE_WEB_JS_FILE = fileURLToPath(new URL('./capture-web.js', import.meta.url));
const DIALOG_JS_FILE = fileURLToPath(new URL('./dialog.js', import.meta.url));
const ADMIN_FILE = fileURLToPath(new URL('./admin.html', import.meta.url));
const ADMIN_JS_FILE = fileURLToPath(new URL('./admin.js', import.meta.url));
const DOC_VIEW_JS_FILE = fileURLToPath(new URL('./doc-view.js', import.meta.url));
const PATCH_PLAN_JS_FILE = fileURLToPath(new URL('./patch-plan.js', import.meta.url));
const FLOW_VIEW_JS_FILE = fileURLToPath(new URL('./flow-view.js', import.meta.url));
const HOST_BRIDGE_JS_FILE = fileURLToPath(new URL('./host-bridge.js', import.meta.url));
const LOGIN_FILE = fileURLToPath(new URL('./login.html', import.meta.url));
const LOGIN_JS_FILE = fileURLToPath(new URL('./login.js', import.meta.url));
const QR_FILE = join(ROOT, 'hongyi-ai-qr.jpg');

const BASE_PATH = normalizeBasePath(process.env.L0_BASE_PATH ?? '');

function normalizeBasePath(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (trimmed === '' || trimmed === '/') return '';
  const withSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return withSlash.startsWith('//') ? '' : withSlash;
}

function withBase(html: string): string {
  const out = BASE_PATH === ''
    ? html
    : html.replace(/(href|src)="\//g, `$1="${BASE_PATH}/`);
  return out.replace('<html lang="zh-CN">', `<html lang="zh-CN" data-l0-base="${BASE_PATH}">`);
}

function escapeForHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch);
}

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
const DEPLOY_USER = BOOTSTRAP.user;

const SESSION_COOKIE = 'l0_session';

class AuthError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'AuthError';
  }
}

const ROUTE_ACTIONS: Record<string, Action> = {
  /* 部署参数：改错会整体不可用或泄数据 */
  '/api/model-config': 'config.write',
  '/api/placement-config': 'config.write',
  '/api/capture-config': 'config.write',
  '/api/previsit-config': 'config.write',
  '/api/sign-backend-config': 'config.write',
  '/api/reading-authority': 'config.write',
  '/api/system-config': 'config.write',
  '/api/qc-content-config': 'config.write',
  '/api/recipient-keys/import': 'config.write',
  '/api/recipient-keys/remove': 'config.write',
  '/api/model-config/test': 'model.test',
  '/api/sign-backend/test': 'sign.test',
  /* 知识资产：改的是判定标准，不动病历 */
  '/api/knowledge-pack-toggle': 'pack.toggle',
  '/api/rule-item-update': 'pack.toggle',
  '/api/rule-item-create': 'pack.toggle',
  '/api/rule-item-delete': 'pack.toggle',
  '/api/qc-condition-create': 'pack.toggle',
  '/api/qc-condition-update': 'pack.toggle',
  '/api/qc-condition-delete': 'pack.toggle',
  '/api/content-library-list': 'pack.toggle',
  '/api/content-library-create': 'pack.toggle',
  '/api/content-library-update': 'pack.toggle',
  '/api/content-library-delete': 'pack.toggle',
  '/api/reset': 'workspace.reset',
  '/api/knowledge-pack-load': 'pack.toggle',
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

const DOC_STATUS_TEXT: Record<string, string> = {
  draft: '草稿',
  reviewing: '审核中',
  signed: '已签章',
  archived: '已归档',
  void: '作废',
};

const DOCTOR_ROUTE_ACTIONS: Record<string, Action> = {
  '/api/set-field': 'doc.write',
  '/api/set-control-field': 'doc.write',
  '/api/edit': 'doc.write',
  '/api/insert-paragraph': 'doc.write',
  '/api/image-upload': 'doc.write',
  '/api/insert-image': 'doc.write',
  '/api/set-image': 'doc.write',
  '/api/delete-image': 'doc.write',
  '/api/paste-text': 'doc.write',
  '/api/content-list': 'doc.write',
  '/api/content-pin': 'doc.write',
  '/api/content-similar': 'doc.write',
  '/api/content-create': 'doc.write',
  '/api/content-update': 'doc.write',
  '/api/content-delete': 'doc.write',
  '/api/content-insert': 'doc.write',
  '/api/content-save-from-doc': 'doc.write',
  '/api/delete-node': 'doc.write',
  '/api/move-node': 'doc.write',
  '/api/undo': 'doc.write',
  '/api/refresh-machine': 'doc.write',
  '/api/reload-sidecars': 'doc.write',
  '/api/template-create': 'doc.write',
  '/api/delete-document': 'doc.write',
  '/api/template-recompute': 'doc.write',
  '/api/confirm': 'doc.write',
  '/api/confirm-subtree': 'doc.write',
  '/api/confirm-anchor-lost': 'doc.write',
  '/api/dictate': 'doc.write',
  '/api/dictate-commit': 'doc.write',
  '/api/dictation/capture/demo-run': 'doc.write',
  '/api/dictation/capture/demo-stop': 'doc.write',
  '/api/dictation/capture/segment': 'doc.write',
  '/api/dictation/capture/session': 'doc.write',
  '/api/dictation/capture/records/clear': 'doc.write',
  '/api/suggest': 'doc.write',
  '/api/suggest-batch': 'doc.write',
  '/api/polish-selection': 'doc.write',
  '/api/compare-selection': 'doc.write',
  '/api/suggest-low': 'doc.write',
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
  '/api/layout': 'doc.export',
  '/api/export-json': 'doc.export',
  '/api/export-wst500': 'doc.export',
  '/api/qc-form-check': 'qc.run',
  '/api/visit-timeline': 'qc.run',
  '/api/visit-compare': 'doc.write',
  '/api/compare/carry-over': 'doc.write',
  '/api/qc-content-check': 'qc.run',
  '/api/check-consistency': 'consistency.run',
  '/api/apply-consistency': 'consistency.run',
  '/api/reading/grant': 'reading.grant',
  '/api/reading/revoke': 'reading.grant',
  '/api/reading/import-credential': 'reading.grant',
};
const ARTIFACTS = join(ROOT, 'artifacts');
const PROBE = join(ROOT, 'tools', 'ofd-check', 'ofd-roundtrip-check.mjs');

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
const DISCHARGE_SUMMARY_MODEL = 'rule:discharge-summary-v1';
const PREVISIT_MODEL = 'rule:previsit-intake-v1';
const WEAK_SIM_CONFIDENCE = 0.6;
const WEAK_SIM_MODEL_ID = 'weak-sim:demo-v1';
function modelConfigNow(): LoadedModelConfig {
  return loadModelConfig(CONFIG_KV);
}

function placementConfigNow(): LoadedPlacementConfig {
  return loadPlacementConfig(CONFIG_KV);
}

function captureConfigNow(): LoadedCaptureConfig {
  return loadCaptureConfig(CONFIG_KV);
}

function dictationCeilingNow(): number {
  return Math.min(placementConfigNow().config.confidenceCeiling, captureConfigNow().config.confidenceCeiling);
}

function readingAuthorityNow(): LoadedReadingAuthorityConfig {
  return loadReadingAuthority(CONFIG_KV);
}

/** 签名后端配置：同样每次取用都重新读，管理员改完立即生效（适配器无状态，重建很便宜） */
function signConfigNow(): LoadedSignConfig {
  return loadSignConfig(CONFIG_KV);
}

function signerNow(): Signer {
  const loaded = signConfigNow();
  return createRemoteSigner(loaded.config, loaded.apiKey === undefined ? {} : { apiKey: loaded.apiKey });
}

function applySignerNow(entry: DocEntry): void {
  entry.session.setSigner(signerNow());
}

function applySignerIfSigned(entry: DocEntry): void {
  if ((entry.session.document.signatureRefs ?? []).length > 0) applySignerNow(entry);
}

function adapterNow(): AiAdapter {
  const loaded = modelConfigNow();
  if (loaded.config.format === 'offline') return createOfflineAdapter(loaded.config);
  return createHttpAdapter(loaded.config, loaded.apiKey ? { apiKey: loaded.apiKey } : {});
}

function headerOf(req: IncomingMessage, name: string): string {
  const headers = (req as unknown as { headers?: Record<string, string | string[] | undefined> }).headers ?? {};
  const raw = headers[name.toLowerCase()];
  if (Array.isArray(raw)) return String(raw[0] ?? '').trim();
  return String(raw ?? '').trim();
}

function cookieOf(req: IncomingMessage, name: string): string {
  const raw = (req as unknown as { headers?: Record<string, string | undefined> }).headers?.cookie ?? '';
  for (const part of raw.split(';')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return '';
}

function requestSourceOf(req: IncomingMessage): string {
  const socket = (req as unknown as { socket?: { remoteAddress?: string } }).socket;
  return socket?.remoteAddress ?? 'unknown';
}

function actorLabelOf(req: IncomingMessage): string {
  const resolved = resolvePrincipal(req);
  return resolved.ok ? `${resolved.principal.actorId}（${ROLE_LABELS[resolved.principal.role]}）` : '（未登录调用）';
}

type PrincipalResult =
  | { ok: true; principal: Principal; source: 'session' }
  | { ok: false; code: typeof AUTH_ERRORS.E_AUTH_REQUIRED | typeof AUTH_ERRORS.E_SESSION_EXPIRED };

function resolvePrincipal(req: IncomingMessage): PrincipalResult {
  const resolved = sessions.resolve(cookieOf(req, SESSION_COOKIE));
  if (resolved.ok) {
    const { actorId, kind, role, tenant } = resolved.record;
    return { ok: true, principal: { actorId, kind, role, tenant }, source: 'session' };
  }
  return { ok: false, code: resolved.code };
}

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
  entry.log.push({
    at: new Date().toISOString(),
    action: `${action ?? `${subject}变更`}（操作者 ${principal.actorId} · ${ROLE_LABELS[principal.role]}）`,
    ok: true,
  });
  return principal.actorId;
}

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
const ADMIN_AUDIT_WINDOW = 500;
/** 写失败必须能看见：审计没写上，不能变成"没人知道" */
let AUDIT_WRITE_ERROR: string | null = null;

const ANCHOR_FILE = RUNTIME.anchorFile;
let ANCHOR_WRITE_ERROR: string | null = null;

const AUDIT_FIELDS: Record<string, string[]> = {
  '模型接入配置': ['format', 'modelId', 'endpoint', 'timeoutMs', 'maxItems', 'apiKeyPresent'],
  '落位配置': [
    'strategy',
    'confidenceCeiling',
    'candidate.withinSections',
    'external.endpoint',
    'external.timeoutMs',
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
  '包条目': ['packId', 'itemId', 'enabled'],
  '内容包': ['包指纹'],
  '后台账号': ['账号', '角色', '状态'],
  '科室字典': ['items'],
  '文书类型': ['items'],
};

interface AuditValue {
  key: string;
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

const HEALTH = {
  startedAt: new Date().toISOString(),
  sign: { ok: 0, fail: 0, last: null as ProbeResult | null },
  model: { ok: 0, fail: 0, last: null as ProbeResult | null },
};

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
    counts: {
      documents: state.entries.size,
      recipientKeys: (state.recipientKeys.keys ?? []).length,
      activeSessions: sessions.size,
      auditEntries: adminAudit.total(),
      adminAccounts: accountStatus().total,
    },
  };
}

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
    pid: (process as unknown as { pid?: number }).pid ?? null,
    startedAt: HEALTH.startedAt,
    uptimeMs: Date.now() - Date.parse(HEALTH.startedAt),
    /* 环境标识：没有它，"我改的是哪套环境"只能靠记忆（本项目此前没有这个概念） */
    env: ENV_NAME,
    stateDir: STATE_DIR,
    artifactsDir: ARTIFACTS,
    database: {
      file: DB_FILE,
      schemaVersion: STORAGE_SCHEMA_VERSION,
      appliedMigrations: STORAGE.applied,
      ...workStore.stats(),
    },
    accounts: accountStatus(),
    configFingerprints: {
      '模型接入配置': configFingerprint('模型接入配置', model),
      '落位配置': configFingerprint('落位配置', placement),
      '采集配置': configFingerprint('采集配置', capture),
      '签名后端配置': configFingerprint('签名后端配置', sign),
      '授权平台配置': configFingerprint('授权平台配置', authority),
    },
  };
}

function buildAdminAuditView(): Record<string, unknown> {
  return {
    ok: true,
    entries: adminAudit.recent(ADMIN_AUDIT_WINDOW),
    counts: {
      total: adminAudit.total(),
      dropped: Math.max(0, AUDIT_LOAD.totalInStore - adminAudit.total()),
      limit: ADMIN_AUDIT_WINDOW,
    },
    chain: {
      table: adminAudit.table,
      legacyFile: AUDIT_FILE,
      intact: AUDIT_LOAD.problem === null,
      problem: AUDIT_LOAD.problem,
      discarded: AUDIT_LOAD.discarded,
    },
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
  warnings: string[];
}

interface Wst500Record {
  file: string;
  bytes: number;
  sections: number;
  fields: number;
  paragraphs: number;
  exportedAt: string;
}

interface ReadingRecord {
  credential: ReadingCredential;
  readCount: number;
  revoked: boolean;
  reads: Array<{ at: string; environmentId: string; actorId: string; allowed: boolean; code?: string; reason?: string }>;
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
  elapsedSec: number;
  currentChunkSec: number;
  finalized: number;
  transcribed: number;
  failures: CaptureFailure[];
  sourceId: string;
  startedAt: string;
  finishedAt: string | null;
  outcome: CaptureOutcome | null;
  howTo?: string;
  error?: { code: string; message: string };
}

interface DictationResult {
  transcriptionId: string;
  source: 'capture' | 'demo';
  asrModelId: string;
  refineModelId?: string;
  groupId: string | null;
  warnings: string[];
  segments: Array<{ index: number; text: string; startSec?: number; endSec?: number; confidence: number }>;
  placements: Array<{ index: number; text: string; nodeId: string | null; reason: string }>;
  unplaced: number;
  submitted: boolean;
}

interface DocEntry {
  docId: string;
  session: WriteSession;
  log: LogEntry[];
  lastExport: ExportRecord | null;
  lastWst500: Wst500Record | null;
  lastJson: JsonRecord | null;
  lastDictation: DictationResult | null;
  lastCapture: CaptureRunRecord | null;
  /** 最近一次跨文书一致性检查结果（避免重跑：纯函数虽便宜，但问题列表要能被"生成待办"引用） */
  lastConsistency: { issues: ConsistencyIssue[]; scanned: number } | null;
  lastVisitTimeline: VisitTimeline | null;
  lastVisitCompare: VisitCompareState | null;
  lastDischargeSummary: DischargeSummaryPlan | null;
  lastReadingView: ReadingView | null;
  lastReadingSource: 'plaintext' | 'unsealed' | null;
  lastAudit: AuditSummary | null;
  lastQcUnevaluated: QcUnevaluated[];
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
  lastAiSilence: AiSilenceReport | null;
  storedRev: number;
  restored?: boolean;
  sidecarBaseline?: string | null | 'unknown';
  sidecarConflict?: boolean;
}

interface PersistStatus {
  ok: boolean;
  code?: string;
  message?: string;
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
  readingGrants: Map<string, ReadingRecord>;
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

function restoreReadingGrants(): void {
  const loaded = loadAllReadingGrants(STORAGE.db, statePassphrase());
  if (!loaded.ok) {
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
  throw new Error(`[存储] ${what}`);
}

const STORAGE = openStorageOrExit();
/* 盐跟着口令一起从服务端文件配置来：库里的密文要解得开，两者必须同时正确（见 core/store.ts） */
const workStore = new WorkStore(STORAGE.db, STATE_PASSPHRASE, STATE_SALT_HEX === undefined ? {} : { salt: STATE_SALT_HEX });
if (STORAGE.applied.length > 0) {
  console.log(`[存储] 已把数据库推进到结构版本 ${STORAGE_SCHEMA_VERSION}：执行迁移 ${STORAGE.applied.join('、')}`);
}

const CONFIG_KV = createConfigKv(workStore);

function systemConfigNow(): LoadedSystemConfig {
  return loadSystemConfig(CONFIG_KV);
}

function departmentsNow(): LoadedDepartments {
  return loadDepartments(CONFIG_KV);
}

function departmentsSafe(): { loaded: LoadedDepartments; error: string | null } {
  try {
    return { loaded: departmentsNow(), error: null };
  } catch (err) {
    return { loaded: { items: [], source: 'empty' }, error: (err as Error).message };
  }
}

function contentActorId(req: IncomingMessage, entry: DocEntry): string {
  if (AUTH_MODE === 'strict') {
    const resolved = resolvePrincipal(req);
    if (resolved.ok) return resolved.principal.actorId;
  }
  return entry.session.document.createdBy;
}

function noteContentUsed(req: IncomingMessage, entry: DocEntry, item: ContentItem): void {
  try {
    markContentUsed(CONFIG_KV, contentActorId(req, entry), item);
  } catch {
  }
}

/** 共享内容库（科室 / 全院）的定位：医生端的写入与管理端的维护共用这一份校验 */
function sharedContentTarget(body: Record<string, unknown>): ContentScopeRef {
  const scope = String(body.scope ?? '');
  if (scope !== 'dept' && scope !== 'hospital') {
    throw new ContentError('E_CONTENT_INVALID', `共享内容库只有 dept / hospital 两层，收到：${scope === '' ? '（空）' : scope}`);
  }
  if (scope === 'hospital') return { scope };
  const deptCode = String(body.deptCode ?? '').trim();
  if (deptCode === '') {
    throw new ContentError('E_CONTENT_INVALID', '科室级内容要指明科室编码（deptCode）：编码为空时"限本科"是句无法判定的话');
  }
  if (!isDepartmentSelectable(departmentsNow(), deptCode)) {
    throw new ContentError(
      'E_CONTENT_INVALID',
      `科室「${deptCode}」不在科室字典里或已停用：请先去「科室字典」补上（否则这一条谁也看不到）`,
    );
  }
  return { scope, owner: deptCode };
}

function contentScopeOf(req: IncomingMessage, entry: DocEntry, body: Record<string, unknown>): ContentScopeRef {
  const scope = body.scope === undefined ? 'personal' : String(body.scope);
  if (!isContentScope(scope)) {
    throw new ContentError('E_CONTENT_INVALID', `作用域只能是 personal / dept / hospital，收到：${scope}`);
  }
  if (scope === 'personal') return { scope, owner: contentActorId(req, entry) };
  guard(req, 'pack.toggle');
  return sharedContentTarget(body);
}

function docTypesNow(): LoadedDocTypes {
  return loadDocTypes(CONFIG_KV);
}

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

const RATE_RULES = {
  'login:actor': { limit: SYSTEM_CONFIG.config.rate.loginPerActor, windowMs: 5 * 60_000, label: '登录尝试（同一身份）' },
  'login:source': { limit: SYSTEM_CONFIG.config.rate.loginPerSource, windowMs: 5 * 60_000, label: '登录尝试（同一来源）' },
  'ai:suggest': { limit: SYSTEM_CONFIG.config.rate.aiPerMinute, windowMs: 60_000, label: 'AI 调用' },
  export: { limit: SYSTEM_CONFIG.config.rate.exportPerMinute, windowMs: 60_000, label: '导出' },
} satisfies Record<string, RateRule>;
const limiter = new SlidingWindowLimiter();

const anchorSigner = softwareSigner(demoKeyPair(SYSTEM_CONFIG.anchorSeed).privateKey);
const anchorVerifier = softwareVerifier(anchorSigner.publicKey);
const ANCHOR_EVERY = SYSTEM_CONFIG.config.anchorEvery;

reloadRecipientKeys();

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
  console.log(`[部署参数] ${CONFIG_IMPORT.reason}（来源：sealed_kv）`);
}

const QC_RULES_IMPORT = importQcRulesOnce({ workStore, kv: CONFIG_KV, file: IMPORTS.qcRulesFile });
console.log(`[质控规则] ${QC_RULES_IMPORT.reason}`);

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
ANCHOR_WRITE_ERROR = ANCHOR_LOAD.error;

const userStore = new UserStore(STORAGE.db);

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
  const session = fromStore ? WriteSession.openPersisted(doc, { clock: 'wall' }) : WriteSession.open(doc, { clock: 'wall' });
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
    storedRev: doc.revisions.length,
  };
}

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
  return humanOf(entry);
}

restoreOrSeedWorkspace();

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

function contextLabelOf(path: string): string {
  return CONTEXT_FIELDS.find((field) => field.path === path)?.label ?? path;
}

interface ViewTableCell {
  nodeId?: NodeId;
  text: string;
  unit?: string;
}

interface ViewControlCell {
  key: string;
  label: string;
  dataType: string;
  unit?: string;
  valueSet?: Array<{ code: string; display?: string }>;
  required?: boolean;
  row?: number;
  rowKey?: string;
  rowLabel?: string;
  columnKey?: string;
  columnLabel?: string;
  value: string;
}

interface ViewItem {
  kind: 'section' | 'listItem' | 'text' | 'field' | 'table' | 'control' | 'image';
  id: NodeId;
  title?: string;
  text?: string;
  resRef?: string;
  altText?: string;
  caption?: string;
  paragraphId?: NodeId;
  runs?: TextRun[];
  shape?: string;
  controlKind?: string;
  cells?: ViewControlCell[];
  columns?: string[];
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
  paragraphFirst?: boolean;
  paragraphLast?: boolean;
  templateRef?: string;
  evidence?: EvidenceRef[];
  suggestionId?: string;
  pageBreakBefore?: boolean;
  marker?: string;
  textId?: NodeId;
  fieldId?: NodeId;
}

function sourceOf(node: DocNode): { evidence?: EvidenceRef[]; suggestionId?: string } {
  const evidence = node.provenance.evidence;
  const suggestionId = node.provenance.suggestionId;
  return {
    ...(Array.isArray(evidence) && evidence.length > 0 ? { evidence } : {}),
    ...(suggestionId ? { suggestionId } : {}),
  };
}

function presentationOf(doc: DocumentModel, node: DocNode): { pageBreakBefore?: boolean } {
  const parent = node.parentId ? doc.nodes[node.parentId] : null;
  const self = node.presentation?.pageBreakBefore === true;
  const fromParent = parent != null && parent.presentation?.pageBreakBefore === true;
  return self || fromParent ? { pageBreakBefore: true } : {};
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

function tableColumnsOf(table: Extract<DocNode, { type: 'table' }>, kidsOf: (id: NodeId) => DocNode[]): string[] {
  const header = kidsOf(table.id).filter((node) => node.type === 'tableRow')[0];
  if (!header) return [];
  return kidsOf(header.id)
    .filter((node) => node.type === 'tableCell')
    .map((cell) => cellViewOf(cell, kidsOf).text);
}

function tableRowsOf(table: Extract<DocNode, { type: 'table' }>, kidsOf: (id: NodeId) => DocNode[]): ViewTableCell[][] {
  const headerRowCount = Math.max(1, table.headerRows ?? 1);
  return kidsOf(table.id)
    .filter((node) => node.type === 'tableRow')
    .slice(headerRowCount)
    .map((row) => kidsOf(row.id).filter((node) => node.type === 'tableCell').map((cell) => cellViewOf(cell, kidsOf)));
}

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
        ...sourceOf(node),
        ...presentationOf(doc, node),
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
        ...sourceOf(node),
        ...presentationOf(doc, node),
        keyContent: node.keyContent === true,
        humanConfirmed: node.humanConfirmed === true,
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
      items.push({
        kind: 'image',
        id: node.id,
        ...(node.parentId ? { paragraphId: node.parentId } : {}),
        resRef: node.resRef,
        ...(node.altText ? { altText: node.altText } : {}),
        ...(node.caption ? { caption: node.caption } : {}),
        ...sourceOf(node),
        ...presentationOf(doc, node),
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
        ...(fromRefOf(node) ? { fromRef: fromRefOf(node), fromLabel: contextLabelOf(String(fromRefOf(node))) } : {}),
        ...(typeof node.provenance.confidence === 'number' ? { confidence: node.provenance.confidence } : {}),
        ...sourceOf(node),
        ...presentationOf(doc, node),
        keyContent: node.keyContent === true,
        humanConfirmed: node.humanConfirmed === true,
        rev: node.rev,
      });
    }
  }
  return items.map((item) => (item.kind === 'section' ? item : { ...item, ...paragraphPositionOf(doc, item.id) }));
}

function contentOwnerOf(session: WriteSession, nodeId: string): DocNode | undefined {
  const node = session.document.nodes[nodeId];
  if (!node) return undefined;
  if (node.type === 'text' || node.type === 'field') {
    const parent = node.parentId ? session.document.nodes[node.parentId] : undefined;
    return parent?.type === 'paragraph' ? parent : node;
  }
  return node;
}

function sectionLabelOf(session: WriteSession, sectionId: string): string {
  const node = session.document.nodes[sectionId];
  if (!node || node.type !== 'section') return sectionId;
  return node.title ?? node.sectionCode ?? sectionId;
}

function nextOrderAfter(session: WriteSession, parentId: NodeId, order: number): number {
  let next = Number.POSITIVE_INFINITY;
  for (const child of session.indexes.childrenOf(parentId)) {
    const value = session.document.nodes[child]?.order ?? 0;
    if (value > order && value < next) next = value;
  }
  return Number.isFinite(next) ? (order + next) / 2 : order + 10;
}

function textChildOf(session: WriteSession, paragraphId: string): DocNode | undefined {
  for (const id of session.indexes.childrenOf(paragraphId)) {
    const node = session.document.nodes[id];
    if (node?.type === 'text') return node;
  }
  return undefined;
}

function runsTextOf(node: DocNode): string {
  return node.type === 'text' ? node.runs.map((run) => run.text).join('') : '';
}

function sectionOfText(session: WriteSession, textNodeId: string): Extract<DocNode, { type: 'section' }> | undefined {
  const holder = contentOwnerOf(session, textNodeId);
  if (!holder) return undefined;
  if (holder.type === 'section') return holder;
  const parent = holder.parentId ? session.document.nodes[holder.parentId] : undefined;
  return parent?.type === 'section' ? parent : undefined;
}

function paragraphTextsOfSection(session: WriteSession, sectionId: string): string[] {
  return session.indexes
    .childrenOf(sectionId)
    .map((id) => session.document.nodes[id])
    .filter((node): node is DocNode => node !== undefined && node.type === 'paragraph')
    .sort((left, right) => left.order - right.order)
    .map((paragraph) => {
      const own = textChildOf(session, paragraph.id);
      return own ? runsTextOf(own).trim() : '';
    })
    .filter((text) => text !== '');
}

function allParagraphTexts(session: WriteSession): string[] {
  return Object.values(session.document.nodes)
    .filter((node): node is DocNode => node !== undefined && node.type === 'paragraph')
    .sort((left, right) => left.order - right.order)
    .map((paragraph) => {
      const own = textChildOf(session, paragraph.id);
      return own ? runsTextOf(own).trim() : '';
    })
    .filter((text) => text !== '');
}

function charBigrams(text: string): Set<string> {
  const clean = text.replace(/[\s，。；：、,.!?！？;:()（）[\]【】"'“”‘’…—-]/g, '');
  const grams = new Set<string>();
  for (let index = 0; index + 1 < clean.length; index += 1) grams.add(clean.slice(index, index + 2));
  if (grams.size === 0 && clean !== '') grams.add(clean);
  return grams;
}

function selectionOverlap(selected: string, candidate: string): number {
  const picked = charBigrams(selected);
  if (picked.size === 0) return 0;
  const pool = charBigrams(candidate);
  let hit = 0;
  for (const gram of picked) if (pool.has(gram)) hit += 1;
  return hit / picked.size;
}

function fillContentParagraphs(
  session: WriteSession,
  anchorId: string,
  texts: string[],
  evidenceRef: string,
  actor: Actor,
): { filled: string[]; created: string[] } {
  const anchor = contentOwnerOf(session, anchorId);
  if (!anchor) throw new ContentError('E_CONTENT_INVALID', `找不到 ${anchorId} 所在的段落（光标那一处可能已经不在正文里了）`);
  const sectionId = anchor.parentId;
  if (!sectionId) throw new ContentError('E_CONTENT_INVALID', `${anchorId} 不在任何章节里：内容只能落进某一章的正文`);

  const targets: string[] = [];
  if (anchor.type === 'paragraph') {
    const own = textChildOf(session, anchor.id);
    if (own && runsTextOf(own).trim() === '') targets.push(own.id);
  }
  if (targets.length > 0) {
    const siblings = session.indexes
      .childrenOf(sectionId)
      .map((id) => session.document.nodes[id])
      .filter((node): node is DocNode => node !== undefined && node.type === 'paragraph' && node.order > anchor.order)
      .sort((left, right) => left.order - right.order);
    for (const sibling of siblings) {
      if (targets.length >= texts.length) break;
      const own = textChildOf(session, sibling.id);
      if (!own || runsTextOf(own).trim() !== '') break;
      targets.push(own.id);
    }
  }

  targets.forEach((nodeId, index) => {
    session.replaceRange({ nodeId: nodeId as NodeId, start: 0, end: 0, payload: { text: texts[index] } }, actor);
  });

  const created: string[] = [];
  let order = anchor.order;
  for (let index = targets.length; index < texts.length; index += 1) {
    order = nextOrderAfter(session, sectionId, order);
    const paragraph = session.createNode({ parentId: sectionId, type: 'paragraph', order }, actor);
    const textNode = session.createNode(
      {
        parentId: paragraph.targetId as NodeId,
        type: 'text',
        props: {
          runs: [{ text: texts[index] }],
          provenance: {
            origin: 'human',
            actorId: actor.id,
            at: new Date().toISOString(),
            evidence: [{ kind: 'template', ref: evidenceRef }],
          },
          humanConfirmed: true,
        } as Partial<DocNode>,
      },
      actor,
    );
    created.push(String(textNode.targetId));
  }
  return { filled: targets, created };
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
    session.deleteNode({ nodeId: target.id, mode: 'subtree' }, ctx.actor);
    return { ok: true, data: {} };
  }

  return { ok: false, code: 'E_UNKNOWN_OP', message: `不认识的流式操作：${kind || '（空）'}` };
}

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

interface SectionSummaryItem {
  id: string;
  title: string;
  sectionCode: string;
  keyContent: boolean;
  hasUnconfirmed: boolean;
  depth: number;
  required: boolean;
  requiredEmpty: boolean;
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

function placementCandidatesOf(session: WriteSession, limit = 200): Array<{ nodeId: string; label: string }> {
  const doc = session.document;
  return collectCandidates(session.indexes, placementConfigNow().config).nodeIds.slice(0, limit).map((nodeId) => {
    const node = doc.nodes[nodeId];
    const text = node && node.type === 'text' ? node.runs.map((run) => run.text).join('').trim() : '';
    return { nodeId, label: text === '' ? nodeId : `${text.slice(0, 14)}${text.length > 14 ? '…' : ''}` };
  });
}

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

function sameDataElement(a: DataElementTag, b: DataElementTag): boolean {
  return a.system === b.system && a.code === b.code;
}

const DOCTOR_HIDDEN_STATE_KEYS = [
  'templateCatalog', 'contextFields', 'expressionFunctions', 'departments', 'docTypes',
  'expressionControls', 'database', 'invariants',
  'placement', 'signBackend',
] as const;

function stateFor(req: IncomingMessage): Record<string, unknown> {
  const resolved = resolvePrincipal(req);
  const admin = resolved.ok && can(resolved.principal.role, 'config.read');
  return buildState(admin ? 'admin' : 'doctor');
}

function buildState(scope: 'doctor' | 'admin' = 'doctor'): Record<string, unknown> {
  const wantAdmin = scope === 'admin';
  const entry = current();
  ensureRestored(entry as DocEntry & { restored?: boolean });
  const session = entry.session;
  const doc = session.document;
  const status = session.machineReadableStatus();
  const block = doc.machineReadable;
  const metrics = session.getMetrics();
  const visit = state.workspace?.patients
    .flatMap((patient) => patient.visits.map((item) => ({ patient, visit: item })))
    .find((item) => item.visit.docs.some((candidate) => candidate.docId === doc.docId));
  const departments = departmentsSafe();
  const docTypes = docTypesSafe();
  const modelView = describeModelConfig(modelConfigNow());
  const captureView = describeCaptureConfig(captureConfigNow());
  const signView = describeSignConfig(signConfigNow());
  const readingView = describeReadingAuthority(readingAuthorityNow());
  const placementView = describePlacementConfig(placementConfigNow());
  let previsitAccessView: unknown = null;
  try {
    previsitAccessView = describeAccess(loadAccess(CONFIG_KV), AUTH_MODE);
  } catch (err) {
    previsitAccessView = { error: (err as Error).message };
  }

  const full: Record<string, unknown> = {
    activeDocId: doc.docId,
    paper: {
      widthPt: DEFAULT_LAYOUT.pageWidthPt,
      heightPt: DEFAULT_LAYOUT.pageHeightPt,
      marginPt: DEFAULT_LAYOUT.marginPt,
      bindingMarginPt: DEFAULT_LAYOUT.bindingMarginPt,
      lineHeightPt: DEFAULT_LAYOUT.lineHeightPt,
      fontSizePt: DEFAULT_LAYOUT.fontSizePt,
      headerTemplate: DEFAULT_FURNITURE.header,
      footerTemplate: DEFAULT_FURNITURE.footer,
    },
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
      dept: normalizeDepartmentCode(departments.loaded, doc.encounter?.deptCode) ?? '',
      deptName: departmentNameOf(departments.loaded, normalizeDepartmentCode(departments.loaded, doc.encounter?.deptCode))
        ?? doc.encounter?.deptCode
        ?? '',
      admittedAt: doc.encounter?.admittedAt ?? '',
      visitDate: visit?.visit.date ?? '',
      dischargeSummaryAvailable: dischargeSummaryApplicability({
        visitType: doc.encounter?.visitType ?? '',
        imported: String(doc.encounter?.visitId ?? '').startsWith('V_IMPORT_'),
      }).applicable,
    },
    previsit: (() => {
      const read = previsitOfPatient(doc.patient.patientId);
      if (!read.ok) return { ok: false, code: read.code, message: read.message, record: null, items: [] };
      const record = read.record;
      if (!record) return { ok: true, record: null, items: [], readAt: read.readAt, cached: read.cached };
      const anchors = sectionAnchorsOf(doc);
      return {
        ok: true,
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
      mode: modeOf(suggestion.promptId),
      status: suggestion.status,
      modified: suggestion.modified === true,
      editRatio: suggestion.editRatio ?? null,
      editBand: suggestion.editRatio === undefined ? null : editBandOf(suggestion.editRatio),
      threshold: session.document.nodes[suggestion.targetNodeId]?.keyContent === true ? THRESHOLDS.key : THRESHOLDS.general,
      keyContent: session.document.nodes[suggestion.targetNodeId]?.keyContent === true,
    })),
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
    knowledgePacks: {
      packs: packRegistry.list(),
      rules: qcRuleCatalog(),
      customPackId: CUSTOM_RULE_PACK_ID,
      contentFingerprint: packRegistry.contentFingerprint(),
      effectiveFingerprint: packRegistry.effectiveFingerprint(),
      store: {
        tables: packStoreReport?.tables ?? [],
        source: packStoreReport?.source ?? null,
        packs: packStoreReport?.packs ?? [],
        error: packStoreError,
      },
    },
    qcPredicates: qcPredicateCatalog(),
    qcCondition: conditionCatalog(),
    qcConditions: qcConditionCatalog(),
    qcConditionLibrary: describeConditions(conditionState),
    qcPlugins: {
      root: QC_PLUGIN_ROOT,
      loaded: QC_PLUGIN_REPORT.loaded,
      failures: QC_PLUGIN_REPORT.failures,
      dirPresent: QC_PLUGIN_REPORT.dirPresent,
    },
    templates: listTemplates(packRegistry, { deptCode: doc.encounter?.deptCode ?? '' }),
    expressionControls: listExpressionControls(packRegistry),
    templateCatalog: templateCatalogOf(packRegistry).map((item) => ({
      ...item,
      departmentNames: item.departments.map((code) => departmentNameOf(departments.loaded, code) ?? code),
    })),
    fragments: listFragments(packRegistry),
    departments: { ...describeDepartments(departments.loaded), error: departments.error },
    docTypes: { ...describeDocTypes(docTypes.loaded), error: docTypes.error },
    contextFields: CONTEXT_FIELDS.map((field) => ({ path: field.path, label: field.label, group: field.group })),
    expressionFunctions: Object.values(EXPR_FUNCTIONS).map((fn) => ({
      name: fn.name,
      minArgs: fn.minArgs,
      maxArgs: Number.isFinite(fn.maxArgs) ? fn.maxArgs : null,
      doc: fn.doc,
    })),
    derivedCount: Object.values(doc.nodes).filter((node) => node.type === 'field' && node.dataType === 'expression').length,
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
    placementCandidates: placementCandidatesOf(session),
    signBackend: signView,
    previsitAccess: wantAdmin ? previsitAccessView : null,
    readingAuthority: wantAdmin
      ? readingView
      : { configured: readingView.configured, trustedFingerprints: readingView.trustedFingerprints },
    dictation: entry.lastDictation,
    captureRun: entry.lastCapture,
    /* 跨文书一致性：只留最近一次结果（纯函数可随时重算，但"生成待办"要引用同一批问题） */
    consistency: entry.lastConsistency,
    visitTimeline: entry.lastVisitTimeline,
    visitCompare: entry.lastVisitCompare,
    dischargeSummary: entry.lastDischargeSummary,
    groups: session.listSuggestionGroups().map((group) => ({
      groupId: group.groupId,
      traceId: group.traceId ?? null,
      total: group.total,
      pending: group.pending,
      accepted: group.accepted,
      rejected: group.rejected,
    })),
    metrics,
    attribution: session.getSuggestionAttribution(),
    machine: {
      stale: status.stale,
      reasons: status.reasons,
      generatedAt: block?.generatedAt ?? null,
      sourceHash: block?.sourceHash ?? null,
      count: block?.dataElements.length ?? 0,
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
    sign: session.signatureInfo(),
    signatureVerified: session.signatureInfo() ? session.verifySignature() : null,
    signatureState: session.signatureState(),
    log: [...entry.log].reverse(),
    /* 最近一次扫描里"适用但判不了"的条目：界面必须在命中数旁边说出来 */
    qcUnevaluated: entry.lastQcUnevaluated,
    /* 内涵类质控现状：没接上就要看得见，否则"质控跑了 0 命中"会把"根本没跑"顶替掉 */
    qcContent: entry.lastContentQc,
    aiSilence: entry.lastAiSilence
      ? {
          ...entry.lastAiSilence,
          skipped: entry.lastAiSilence.skipped.map((item) => ({ ...item, label: AI_SILENCE_LABELS[item.code] })),
        }
      : null,
    database: {
      file: DB_FILE,
      schemaVersion: STORAGE_SCHEMA_VERSION,
      appliedMigrations: STORAGE.applied,
      ...workStore.stats(),
    },
    auth: {
      mode: AUTH_MODE,
      ttlMinutes: SESSION_TTL_MINUTES,
      accounts: accountStatus(),
      note:
        AUTH_MODE === 'open'
          ? '演示模式：医生端写病历不鉴权（任何能访问本端口的人都能写入）。清空工作区例外：两种模式都要求管理员身份。 服务只监听回环地址；生产必须在管理后台「系统信息」里改成 strict（改完需重启）。'
          : '严格模式：医生端写操作也要求会话并判角色（登录入口在管理后台 /login）。',
      destructiveGuarded: ['workspace.reset'],
      loginEndpoint: '/api/session',
    },
    sidecar: {
      conflict: entry.sidecarConflict === true,
      persisted: entry.sidecarBaseline !== 'unknown' && entry.sidecarBaseline !== undefined,
    },
    undo: session.undoTarget(),
    lastExport: entry.lastExport,
    lastWst500: entry.lastWst500,
    lastJson: entry.lastJson,
    reading: {
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
      documentFingerprint: documentFingerprint(session.document),
      lastView: entry.lastReadingView,
      lastViewSource: entry.lastReadingSource,
      reads: [...state.readingGrants.values()]
        .filter((record) => record.credential.grant.docId === doc.docId)
        .flatMap((record) => record.reads)
        .slice(-20),
    },
    recipientKeys: {
      keys: state.recipientKeys.keys,
      error: state.recipientKeyStoreError ?? null,
    },
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

let conditionState: LoadedConditions = loadConditions(CONFIG_KV);

function conditionLibrary(): ConditionLibrary {
  return conditionLibraryOf(conditionState.items);
}

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
let packStoreReport: PackStoreReport | null = packStoreOpen.ok ? packStoreOpen.report : null;
const packStoreError: string | null = packStoreOpen.ok ? null : `${packStoreOpen.code}：${packStoreOpen.message}`;
if (packStoreError) {
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
        console.error(`[判定方式] 包「${pack.packId}」里的判定方式搬进库失败（这次不删包里那份）：${(err as Error).message}`);
        continue;
      }
      moved += fresh.length;
    }
    const rest = pack.items.filter((item) => (item as { itemType?: unknown }).itemType !== 'condition');
    if (rest.length === 0) {
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

function qcContentNow(): LoadedQcContentConfig {
  return loadQcContentConfig(CONFIG_KV);
}

function qcContentSafe(): { content: LoadedQcContentConfig | null; error: string | null } {
  try {
    return { content: qcContentNow(), error: null };
  } catch (err) {
    return { content: null, error: (err as Error).message };
  }
}

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
        if (docTypeCode === '' || createdAt === '') return undefined;
        out.push({ docId: item.docId, docTypeCode, createdAt, title: item.title });
      }
      return out;
    }
  }
  return [];
}

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

const PREVISIT_KEY_PREFIX = 'previsit.rec:';

const PREVISIT_LEGACY_KEY = 'previsit.records';

interface PrevisitStore {
  version: 2;
  records: PrevisitRecord[];
}

let previsitCache: { patientId: string; record: PrevisitRecord | null; readAt: string } | null = null;

interface PrevisitRead {
  ok: true;
  record: PrevisitRecord | null;
  readAt: string;
  cached: boolean;
}

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

function savePrevisitOfPatient(patientId: string, record: PrevisitRecord): { ok: true } | { ok: false; code: string; message: string } {
  const key = `${PREVISIT_KEY_PREFIX}${patientId}`;
  const got = workStore.getSealed<PrevisitStore>(key);
  if (!got.ok) {
    return { ok: false, code: got.code, message: `这位患者已有的预问诊记录解不开，拒绝覆盖：${got.message}` };
  }
  const existing = got.found && Array.isArray(got.data.records) ? got.data.records : [];
  const kept = existing.filter((item) => (item.visitId ?? '') !== (record.visitId ?? ''));
  workStore.putSealed<PrevisitStore>(key, { version: 2, records: [...kept, record] });
  /* 写入即失效：下一位打开这份病历的人必须看到新的，而不是缓存里的旧表 */
  previsitCache = null;
  return { ok: true };
}

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

function qcRuleCatalog(): QcRuleCatalogEntry[] {
  const out: QcRuleCatalogEntry[] = [];
  for (const summary of packRegistry.list('rule')) {
    const pack = packRegistry.get(summary.packId) as QcRulePack | null;
    if (!pack) continue;
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

function rulePackOf(packId: string): { pack: QcRulePack } | { code: string; message: string } {
  const pack = packRegistry.get(packId) as QcRulePack | null;
  if (!pack) return { code: 'E_PACK_NOT_FOUND', message: `库里没有包「${packId}」` };
  if (pack.kind !== 'rule') return { code: 'E_PACK_NOT_FOUND', message: `包「${packId}」是 ${pack.kind} 类，不是规则包` };
  return { pack };
}

function persist(entry: DocEntry): PersistStatus {
  /* 基线必须先建立（懒加载一次），否则"带条件的写"没有条件可比 */
  ensureRestored(entry);

  const baseline = entry.sidecarBaseline;
  if (baseline === undefined || baseline === 'unknown') {
    const message = '库里的旁挂数据读过但没读懂，本次拒绝覆盖它（避免把一份读不出来的数据抹掉）';
    entry.log.push({ at: new Date().toISOString(), action: '未落盘：库里的旁挂数据状态未知', ok: false, code: 'E_PERSIST_BASELINE_UNKNOWN', message });
    return { ok: false, code: 'E_PERSIST_BASELINE_UNKNOWN', message };
  }

  try {
    const rev = entry.session.docRev;
    if (entry.storedRev !== rev) {
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

function ensureRestored(entry: DocEntry): void {
  if (entry.restored) return;
  entry.restored = true;
  const loaded = workStore.loadSidecars(entry.docId);
  if (loaded.ok && !loaded.found) {
    entry.sidecarBaseline = null;
    return;
  }
  if (!loaded.ok) {
    entry.sidecarBaseline = 'unknown';
    entry.log.push({ at: new Date().toISOString(), action: '恢复旁挂数据失败（可能是数据损坏）', ok: false, code: loaded.code, message: loaded.message });
    return;
  }
  try {
    entry.session.restoreSidecars(loaded.data as never);
    entry.sidecarBaseline = loaded.digest;
    entry.log.push({ at: new Date().toISOString(), action: `已从数据库恢复旁挂数据（建议 ${entry.session.listSuggestions().length} 条）`, ok: true });
  } catch (err) {
    entry.sidecarBaseline = 'unknown';
    entry.log.push({ at: new Date().toISOString(), action: '恢复旁挂数据被拒绝（库里那一版没有被接受，落盘将保持关闭）', ok: false, code: 'E_RESTORE_REJECTED', message: (err as Error).message });
  }
}

function clearPersistedState(): void {
  try {
    if (!existsSync(STATE_DIR)) return;
    for (const name of readdirSync(STATE_DIR)) {
      if (CONFIG_FILES.has(name)) continue;
      if (name.endsWith('.json') || name.endsWith('.tmp')) fsx.unlinkSync(join(STATE_DIR, name));
    }
  } catch {
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

async function readRawBody(req: IncomingMessage): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  await new Promise<void>((resolve) => {
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve());
  });
  return concat(chunks);
}

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
const RESOURCE_NAME = /^[0-9a-f]{64}\.(png|jpg|webp)$/;

function ensureResourceDir(): void {
  if (!existsSync(RESOURCE_DIR)) mkdirSync(RESOURCE_DIR, { recursive: true });
}

/** `/res/<name>` → 本机路径；名字不合规返回 null（防路径穿越：只认白名单形状） */
function resourceFilePathOf(name: string): string | null {
  if (!RESOURCE_NAME.test(name)) return null;
  return join(RESOURCE_DIR, name);
}

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
  }
  recordAdminAudit({
    actor,
    subject: '语音采集',
    kind: '动作',
    note: `开始一次采集（会话 ${sessionId}）：音频发往 ${where}。本条不记音频内容`,
  });
  return true;
}

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
  device: string;
  client: string;
  elapsedSec: number;
  total: number;
  uploaded: number;
  failed: number;
  shortDropped: number;
  asrConfigured: boolean;
  asrModel: string;
  problem: string;
  outcome: 'ok' | 'partial' | 'failed';
}

function dictationRecordsWrite(records: DictationRecord[]): void {
  try {
    mkdirSync(dirname(DICTATION_RECORDS_FILE), { recursive: true });
    writeFileSync(DICTATION_RECORDS_FILE, `${JSON.stringify(records, null, 2)}\n`, 'utf8');
  } catch {
  }
}

function dictationRecordsLoad(): DictationRecord[] {
  let all: DictationRecord[] = [];
  try {
    if (existsSync(DICTATION_RECORDS_FILE)) {
      const parsed = JSON.parse(readFileSync(DICTATION_RECORDS_FILE, 'utf8').replace(/^\uFEFF/, ''));
      if (Array.isArray(parsed)) all = parsed as DictationRecord[];
    }
  } catch {
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

function boundedSeconds(value: unknown, max: number): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return 0;
  return Math.min(Math.round(number * 10) / 10, max);
}

function boundedText(value: unknown, max: number): string {
  return String(value ?? '').trim().slice(0, max);
}

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
  const normalized = normalizeSegments(input.segments);
  if (normalized.segments.length === 0) {
    return { ok: false, code: 'E_NO_TARGET', message: '这次转写没有任何可用文本（全部是空段）' };
  }
  const candidates = collectCandidates(session.indexes, placement.config);
  if (candidates.nodeIds.length === 0) {
    return { ok: false, code: 'E_NO_TARGET', message: '该病历没有可落位的文本节点（或候选集被"限定章节"收窄到空）' };
  }
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

const DEFAULT_CAPTURE_DEMO_TIMELINE: Array<{ seconds: number; voiced: boolean }> = [
  { seconds: 2, voiced: true },
  { seconds: 1.2, voiced: false },
  { seconds: 2, voiced: true },
];

let captureStop: (() => Promise<void>) | null = null;

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
      openable: catalogEntry.openable,
      departments,
      departmentNames: departments.map((code) => departmentNameOf(deptList, code) ?? code),
      deptApplicable: deptAllowsTemplate(definition, deptCode),
      visitDeptName: deptCode ? (departmentNameOf(deptList, deptCode) ?? deptCode) : '',
      source: created.result.source,
      warnings: created.result.warnings,
      sections,
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

  const previewTemplate: TemplateDefinition = {
    itemType: 'template',
    itemId: `tpl.preview.${itemId}`,
    name: definition.name ?? itemId,
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
      enabled: catalogEntry.enabled,
      warnings: created.result.warnings,
      source: created.result.source,
      items: buildItemsOfDocument(created.doc),
    },
  };
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = req.url ?? '/';
  let path = url.split('?')[0] ?? '/';

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

  if (req.method === 'GET' && path === '/dialog.js') {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(readFileSync(DIALOG_JS_FILE, 'utf8'));
    return;
  }

  if (req.method === 'GET' && path === '/patch-plan.js') {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(readFileSync(PATCH_PLAN_JS_FILE, 'utf8'));
    return;
  }

  if (req.method === 'GET' && path === '/doc-view.js') {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(readFileSync(DOC_VIEW_JS_FILE, 'utf8'));
    return;
  }

  if (req.method === 'GET' && path === '/flow-view.js') {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(readFileSync(FLOW_VIEW_JS_FILE, 'utf8'));
    return;
  }

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

  if (req.method === 'GET' && path === '/hongyi-ai-qr.jpg') {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.end(readFileSync(QR_FILE));
    return;
  }

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

  if (req.method === 'GET' && path === '/admin') {
    if (!resolvePrincipal(req).ok) {
      res.statusCode = 302;
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

  if (req.method === 'GET' && path === '/api/admin/session') {
    const info = sessionInfoOf(req);
    json(
      res,
      200,
      info.authenticated
        ? {
            ok: true,
            adminId: info.actorId,
            actorId: info.actorId,
            role: info.role,
            roleLabel: info.role ? ROLE_LABELS[info.role] : null,
            expiresAt: info.expiresAt,
            env: ENV_NAME,
          }
        : { ok: false, code: 'E_ADMIN_NO_SESSION', message: '未登录' },
    );
    return;
  }

  if (req.method === 'GET' && path === '/api/qc-content-contract') {
    json(res, 200, {
      ok: true,
      data: {
        ...describeContentContract(),
        /* 契约是通用规格；这台机器的现状才是"能不能用"的答案，两者一起给 */
        local: (() => {
          const qc = qcContentSafe();
          if (qc.content === null) {
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

  if (req.method === 'GET' && path === '/api/layout') {
    try {
      guard(req, 'doc.export');
    } catch (err) {
      json(res, 200, {
        ok: false,
        code: (err as { code?: string }).code ?? 'E_AUTH_REQUIRED',
        message: (err as Error).message,
      });
      return;
    }
    const entry = current();
    const plan = { furniture: { header: DEFAULT_FURNITURE.header, footer: DEFAULT_FURNITURE.footer } };
    const layout = layoutDocument(entry.session.document, {
      ...plan,
      imageBoxOf: imageBoxResolver(contentArea(plan), readResourceBytes),
    });
    json(res, 200, {
      ok: true,
      data: {
        ...layout,
        docId: entry.docId,
        status: entry.session.document.status,
        rev: entry.session.document.revisions.length,
      },
    });
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

  const configViews: Record<string, () => unknown> = {
    '/api/model-config': () => describeModelConfig(modelConfigNow()),
    '/api/placement-config': () => describePlacementConfig(placementConfigNow()),
    '/api/capture-config': () => describeCaptureConfig(captureConfigNow()),
    '/api/sign-backend-config': () => describeSignConfig(signConfigNow()),
    '/api/previsit-config': () => {
      try {
        return describeAccess(loadAccess(CONFIG_KV), AUTH_MODE);
      } catch (err) {
        return { error: (err as Error).message };
      }
    },
    '/api/reading-authority': () => describeReadingAuthority(readingAuthorityNow()),
    '/api/system-config': () => describeSystemConfig(systemConfigNow()),
    '/api/qc-content-config': () => describeQcContentConfig(qcContentNow()),
    '/api/departments': () => {
      const { loaded, error } = departmentsSafe();
      return { ...describeDepartments(loaded), error };
    },
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

  const adminViews: Record<string, () => unknown> = {
    '/api/admin/audit': buildAdminAuditView,
    '/api/admin/health': buildHealthView,
    '/api/admin/system': buildSystemView,
  };
  const adminView = req.method === 'GET' ? adminViews[path] : undefined;
  if (adminView) {
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

  if (req.method === 'GET' && path === '/api/dictation/capture/records') {
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

  const required = ROUTE_ACTIONS[path] ?? (AUTH_MODE === 'strict' ? DOCTOR_ROUTE_ACTIONS[path] : undefined);
  if (required) {
    try {
      guard(req, required);
    } catch (err) {
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
    case '/api/session':
    case '/api/admin/session': {
      const username = String(body.username ?? '').trim();
      const password = String(body.password ?? '');
      const source = requestSourceOf(req);

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
        const why = verified.code === 'E_USER_NOT_FOUND' ? '账号不存在' : '口令不正确';
        recordAdminAudit({ actor: username, subject: '登录', kind: '动作', note: `登录失败：${why}` });
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
      const { id: sid, record } = sessions.issue({
        actorId: account.username,
        kind: 'human',
        role: account.role,
        tenant: 'default',
        label: account.roleLabel,
      });
      limiter.reset(`login:actor:${account.username.toLowerCase()}`);
      userStore.touchLogin(account.username);
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
      const source = requestSourceOf(req);
      const throttled = limiter.hit(`login:source:${source}`, RATE_RULES['login:source']);
      if (!throttled.ok) {
        json(res, 200, { ok: false, code: throttled.code, message: throttled.message, retryAfterSec: throttled.retryAfterSec });
        return;
      }
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

      clearPersistedState();
      resetWorkspace();
      current().log.push({ at: new Date().toISOString(), action: `工作区已重置（操作者 ${whoReset}）`, ok: true });
      state.readingGrants.clear();
      READING_GRANTS_ERROR = null;
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

      const removedFromStore = workStore.deleteDocument(docId);

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
      const mode = (['complete', 'draft', 'polish'] as const).find((item) => item === String(body.mode)) ?? 'complete';
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
      if (result.ok === true) {
        noteReuse(entry, `AI 出建议（${mode} · ${response.modelId}）`, result.data.reused ? [result.data.suggestionId] : []);
      }
      json(res, 200, { ...result, usage: response.usage, state: stateFor(req) });
      return;
    }

    case '/api/polish-selection': {
      const entry = current();
      const session = entry.session;
      const nodeId = String(body.nodeId ?? '');
      const node = session.document.nodes[nodeId];
      if (!node || node.type !== 'text') {
        json(res, 200, { ok: false, code: 'E_TYPE_MISMATCH', message: `节点 ${nodeId} 不是文本节点`, state: stateFor(req) });
        return;
      }
      const raw = runsTextOf(node);
      const start = Math.trunc(Number(body.start ?? -1));
      const end = Math.trunc(Number(body.end ?? -1));
      if (!(start >= 0 && end > start && end <= raw.length)) {
        json(res, 200, {
          ok: false,
          code: 'E_AI_SELECTION_INVALID',
          message: `选区不合法：start / end 必须落在这一段的 0~${raw.length} 之间，且 end > start`,
          state: stateFor(req),
        });
        return;
      }
      const picked = raw.slice(start, end).trim();
      if (picked === '') {
        json(res, 200, { ok: false, code: 'E_AI_SELECTION_INVALID', message: '选中的是空白：先选一段有字的再润色', state: stateFor(req) });
        return;
      }

      let response: Awaited<ReturnType<AiAdapter['suggest']>>;
      try {
        const ctx = buildAiContext(session.document, {
          nodeIds: [nodeId],
          contextBefore: 2,
          contextAfter: 1,
          actor: { id: AI.id, kind: AI.kind },
        });
        response = await adapterNow().suggest({
          context: ctx,
          mode: 'polish',
          allowedNodeIds: targetNodeIdsOf(ctx),
          selection: { nodeId, text: picked },
          maxItems: 1,
          traceId: `demo-polish-${Date.now()}`,
        });
      } catch (err) {
        json(res, 200, {
          ok: false,
          code: (err as { code?: string }).code ?? 'E_AI_CALL_FAILED',
          message: (err as Error).message,
          state: stateFor(req),
        });
        return;
      }
      const draft = response.items.find((item) => item.nodeId === nodeId) ?? response.items[0];
      const after = draft ? draft.text.trim() : '';
      if (!draft || after === '') {
        json(res, 200, {
          ok: false,
          code: 'E_AI_NO_SUGGESTION',
          message: '产出方没有给出可用的润色结果',
          state: stateFor(req),
        });
        return;
      }
      json(res, 200, {
        ok: true,
        data: {
          nodeId,
          start,
          end,
          before: raw.slice(start, end),
          after,
          fullText: raw.slice(0, start) + after + raw.slice(end),
          modelId: response.modelId,
          ...(response.promptId ? { promptId: response.promptId } : {}),
          confidence: draft.confidence,
          traceId: `demo-polish-${Date.now()}`,
          usage: response.usage,
        },
        state: stateFor(req),
      });
      return;
    }

    case '/api/compare-selection': {
      const entry = current();
      const session = entry.session;
      const nodeId = String(body.nodeId ?? '');
      const node = session.document.nodes[nodeId];
      if (!node || node.type !== 'text') {
        json(res, 200, { ok: false, code: 'E_TYPE_MISMATCH', message: `节点 ${nodeId} 不是文本节点`, state: stateFor(req) });
        return;
      }
      const raw = runsTextOf(node);
      const start = Math.trunc(Number(body.start ?? -1));
      const end = Math.trunc(Number(body.end ?? -1));
      if (!(start >= 0 && end > start && end <= raw.length)) {
        json(res, 200, {
          ok: false,
          code: 'E_AI_SELECTION_INVALID',
          message: `选区不合法：start / end 必须落在这一段的 0~${raw.length} 之间，且 end > start`,
          state: stateFor(req),
        });
        return;
      }
      const selected = raw.slice(start, end).trim();
      if (selected === '') {
        json(res, 200, { ok: false, code: 'E_AI_SELECTION_INVALID', message: '选中的是空白：先选一段有字的再对比', state: stateFor(req) });
        return;
      }

      const line = patientLineOf(entry.docId);
      if (!line) {
        json(res, 200, { ok: false, code: 'E_NO_PATIENT', message: '这份文书没有挂在任何患者下，无法找"上一次"', state: stateFor(req) });
        return;
      }
      const currentDoc = session.document;
      const currentSection = sectionOfText(session, nodeId);
      const sectionTitle = String(currentSection?.title ?? '').trim();
      const sectionCode = String(currentSection?.sectionCode ?? '').trim();

      const pool: Array<{ entry: DocEntry; createdAt: string; title: string; sameType: boolean }> = [];
      for (const visit of line.patient.visits) {
        for (const item of visit.docs) {
          if (item.docId === entry.docId) continue;
          const other = state.entries.get(item.docId);
          if (!other) continue;
          const doc = other.session.document;
          pool.push({
            entry: other,
            createdAt: String(doc.createdAt),
            title: item.title || doc.docType?.display || item.docId,
            sameType: doc.docType?.code === currentDoc.docType?.code,
          });
        }
      }
      const earlier = pool.filter((item) => item.createdAt < String(currentDoc.createdAt));
      const usable = (earlier.length > 0 ? earlier : pool).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      const chosen = usable.find((item) => item.sameType) ?? usable[0];
      if (!chosen) {
        json(res, 200, { ok: false, code: 'E_COMPARE_NO_PREVIOUS', message: '这位患者没有其它文书可以对照', state: stateFor(req) });
        return;
      }

      const previousSession = chosen.entry.session;
      const previousSections = Object.values(previousSession.document.nodes).filter((item) => item.type === 'section');
      const matched = (sectionCode !== '' ? previousSections.find((item) => String(item.sectionCode ?? '') === sectionCode) : undefined)
        ?? (sectionTitle !== '' ? previousSections.find((item) => String(item.title ?? '').trim() === sectionTitle) : undefined);
      const paragraphs = matched ? paragraphTextsOfSection(previousSession, matched.id) : [];
      const fallback = paragraphs.length === 0 ? allParagraphTexts(previousSession) : [];
      const source = paragraphs.length > 0 ? paragraphs : fallback;
      if (source.length === 0) {
        json(res, 200, { ok: false, code: 'E_COMPARE_EMPTY', message: '上一份文书里没有可对照的正文', state: stateFor(req) });
        return;
      }
      const scored = source
        .map((text) => ({ text, score: selectionOverlap(selected, text) }))
        .sort((left, right) => right.score - left.score);
      const best = scored[0];
      json(res, 200, {
        ok: true,
        data: {
          docId: chosen.entry.docId,
          title: chosen.title,
          createdAt: chosen.createdAt,
          sameDocType: chosen.sameType,
          sectionTitle: matched ? String(matched.title ?? '') : '',
          aligned: paragraphs.length > 0,
          previousText: best.text,
          score: Number(best.score.toFixed(3)),
          alternatives: scored.slice(1, 3).map((item) => ({ text: item.text, score: Number(item.score.toFixed(3)) })),
        },
        state: stateFor(req),
      });
      return;
    }

    case '/api/model-config': {
      const entry = current();
      try {
        const by = requireAdminSession(req, entry);
        const before = describeModelConfig(modelConfigNow());
        const { loaded, apiKeyAction } = saveModelConfig(
          CONFIG_KV,
          {
            format: body.format as never,
            model: body.model as never,
            endpoint: body.endpoint as never,
            timeoutMs: Number(body.timeoutMs),
            maxItems: Number(body.maxItems),
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
      const entry = current();
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
            ...(body.structureMap && typeof body.structureMap === 'object' && !Array.isArray(body.structureMap)
              ? { structureMap: body.structureMap as Record<string, DataElementTag> }
              : {}),
            ...(body.external && typeof body.external === 'object' && !Array.isArray(body.external)
              ? { external: body.external as { endpoint?: string; timeoutMs?: number } }
              : {}),
            ...(body.apiKey === undefined ? {} : { apiKey: body.apiKey === null ? null : String(body.apiKey) }),
          },
          by,
        );
        const after = describePlacementConfig(loaded);
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
      const entry = current();
      try {
        const by = requireAdminSession(req, entry, '采集配置');
        const before = describeCaptureConfig(captureConfigNow());
        const { loaded, apiKeyAction, apiSecretAction } = saveCaptureConfig(
          CONFIG_KV,
          {
            ...(body.kind === undefined ? {} : { kind: String(body.kind) }),
            ...(body.endpoint === undefined ? {} : { endpoint: String(body.endpoint) }),
            ...(body.appKey === undefined ? {} : { appKey: String(body.appKey) }),
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
            ...(body.apiKey === undefined ? {} : { apiKey: body.apiKey === null ? null : String(body.apiKey) }),
            ...(body.apiSecret === undefined ? {} : { apiSecret: body.apiSecret === null ? null : String(body.apiSecret) }),
          },
          by,
        );
        const after = describeCaptureConfig(loaded);
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
      const entry = current();
      try {
        const by = requireAdminSession(req, entry, '系统策略');
        const before = describeSystemConfig(systemConfigNow());
        const { loaded, anchorSeedAction } = saveSystemConfig(
          CONFIG_KV,
          {
            ...(body.authMode === undefined ? {} : { authMode: String(body.authMode) as AuthMode }),
            ...(body.sessionTtlMinutes === undefined ? {} : { sessionTtlMinutes: Number(body.sessionTtlMinutes) }),
            ...(body.anchorEvery === undefined ? {} : { anchorEvery: Number(body.anchorEvery) }),
            ...(body.rate && typeof body.rate === 'object' && !Array.isArray(body.rate) ? { rate: body.rate as RateConfig } : {}),
            ...(body.anchorSeed === undefined ? {} : { anchorSeed: body.anchorSeed === null ? null : String(body.anchorSeed) }),
          },
          by,
        );
        const after = describeSystemConfig(loaded);
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
      const entry = current();
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
            ...(body.apiKey === undefined ? {} : { apiKey: body.apiKey === null ? null : String(body.apiKey) }),
          },
          by,
        );
        const after = describeSignConfig(loaded);
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
      const entry = current();
      let adminId: string;
      try {
        adminId = requireAdminSession(req, entry, '测试签名', '测试签名后端', 'sign.test');
      } catch (err) {
        json(res, 200, {
          ok: false,
          code: (err as { code?: string }).code ?? 'E_AUTH_REQUIRED',
          message: (err as Error).message,
          state: stateFor(req),
        });
        return;
      }
      try {
        const probe = signConfigNow();
        const report = await testSign(probe.config, probe.apiKey === undefined ? {} : { apiKey: probe.apiKey });
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
            modelId,
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
      if (captureStop === null) {
        json(res, 200, { ok: false, code: 'E_NO_CAPTURE_RUN', message: '当前没有正在进行的采集', state: stateFor(req) });
        return;
      }
      await captureStop();
      json(res, 200, { ok: true, data: { stopped: true }, state: stateFor(req) });
      return;
    }

    case '/api/qc-form-check': {
      const entry = current();
      const session = entry.session;
      const scan = runFormRules(
        session.document.nodes,
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
          (timeline.unevaluated.length > 0 ? `；未判定 ${timeline.unevaluated.length} 条` : ''),
        ok: true,
      });
      json(res, 200, { ok: true, data: timeline, state: stateFor(req) });
      return;
    }

    case '/api/visit-compare': {
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
      const earlier = candidates.filter((item) => String(item.createdAt) < String(currentDoc.createdAt));
      const pool = earlier.length > 0 ? earlier : candidates;
      const chosen = (requested !== '' ? candidates.find((item) => item.docId === requested) : undefined)
        ?? pool.find((item) => item.sameDiagnosis)
        ?? pool[0];
      const previousDoc = chosen ? state.entries.get(chosen.docId)?.session.document : undefined;
      const compare = previousDoc ? compareVisits(previousDoc, currentDoc) : null;

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
          confidence: 0.99,
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
      const entry = current();
      try {
        const by = requireAdminSession(req, entry, '预问诊接入');
        let before: Record<string, unknown> = {};
        try {
          before = describeAccess(loadAccess(CONFIG_KV), AUTH_MODE) as unknown as Record<string, unknown>;
        } catch (err) {
          before = { error: (err as Error).message };
        }
        const { record, keyAction } = saveAccess(
          CONFIG_KV,
          {
            ...(body.enabled === undefined ? {} : { enabled: body.enabled === true || body.enabled === 'true' }),
            ...(body.key === undefined ? {} : { key: body.key === null ? null : String(body.key) }),
          },
          by,
          new Date().toISOString(),
        );
        const after = describeAccess(record, AUTH_MODE);
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
      const entry = current();
      const patientId = entry.session.document.patient.patientId;
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
        allowUnconfigured: AUTH_MODE !== 'strict',
      });
      if (!access.ok) {
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
      const saved = savePrevisitOfPatient(parsed.record.patientId, parsed.record);
      if (!saved.ok) {
        json(res, 200, { ok: false, code: saved.code, message: saved.message });
        return;
      }
      process.stdout.write(`[预问诊] 收到 ${parsed.record.patientId} 的表单：${parsed.record.items.length} 项，来源 ${parsed.record.source}（准入 ${access.mode}）\n`);
      json(res, 200, { ok: true, data: parsed.record, auth: access.mode, state: stateFor(req) });
      return;
    }

    case '/api/previsit/take': {
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
        entry.lastContentQc = {
          configured: false,
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
      const preview = previewOfTemplate(String(body.templateId ?? ''), writeActor(req, current()).id);
      if (!preview.ok) {
        json(res, 200, { ok: false, code: preview.code, message: preview.message });
        return;
      }
      json(res, 200, { ok: true, data: preview.data });
      return;
    }

    case '/api/control-preview': {
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
      const deptList = departmentsSafe().loaded;
      let created: ReturnType<typeof instantiateTemplate>;
      try {
        created = instantiateTemplate(found.pack, {
          templateId,
          docId,
          createdBy: writeActor(req, entry).id,
          patient: source.patient,
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

      const visit = state.workspace?.patients
        .flatMap((patient) => patient.visits)
        .find((candidate) => candidate.docs.some((doc) => doc.docId === source.docId));
      visit?.docs.push({ docId, title: found.definition.name, kind: 'template' });
      state.activeDocId = docId;
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
              valueText: String(change.next),
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
        patch.predicate = {
          kind: (raw as Record<string, unknown>).kind as QcRuleDescriptor['predicate']['kind'],
          ...((raw as Record<string, unknown>).params === undefined
            ? {}
            : { params: (raw as Record<string, unknown>).params as Record<string, JsonValue> }),
        };
      }
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
      const placement = body.place === false
        ? null
        : placePastedParagraphs({ texts: lines, anchorSectionId }, entry.session.indexes, placementConfigNow().config);
      const actor = writeActor(req, entry);
      const at = new Date().toISOString();
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
        entry.session.beginUndoGroup();
        try {
          return createParagraphs();
        } finally {
          entry.session.endUndoGroup();
        }
      });
      json(res, 200, {
        ...result,
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
                moved: item.sectionId !== null && item.sectionId !== anchorSectionId,
              })),
            },
        state: stateFor(req),
      });
      return;
    }

    case '/api/content-pin': {
      const entry = current();
      const itemId = String(body.itemId ?? '').trim();
      if (itemId === '' || typeof body.pinned !== 'boolean') {
        json(res, 200, {
          ok: false,
          code: 'E_CONTENT_INVALID',
          message: '要说明置顶哪一条（itemId）以及是置顶还是取消（pinned: true / false）',
          state: stateFor(req),
        });
        return;
      }
      const actorId = contentActorId(req, entry);
      const deptCode = entry.session.document.encounter?.deptCode;
      /* 与带入同一条可见性判定：只能排自己的、本科的、全院的，别人的私稿够不到 */
      const visible = listContentFor(CONFIG_KV, { actorId, ...(deptCode ? { deptCode } : {}) });
      const item = visible.items.find((candidate) => candidate.id === itemId);
      if (!item) {
        json(res, 200, {
          ok: false,
          code: 'E_CONTENT_ITEM_NOT_FOUND',
          message: `内容「${itemId}」不在你的内容库里（只有"我的 / 本科室 / 全院"这三层能被置顶）`,
          state: stateFor(req),
        });
        return;
      }
      try {
        setContentPinned(CONFIG_KV, actorId, item, body.pinned);
      } catch (err) {
        if (err instanceof ContentError) {
          json(res, 200, { ok: false, code: err.code, message: err.message, state: stateFor(req) });
          return;
        }
        throw err;
      }
      json(res, 200, {
        ok: true,
        data: { itemId: item.id, pinned: body.pinned },
        state: stateFor(req),
      });
      return;
    }

    case '/api/content-list': {
      const entry = current();
      const actorId = contentActorId(req, entry);
      const deptCode = entry.session.document.encounter?.deptCode;
      const result = listContentFor(CONFIG_KV, { actorId, ...(deptCode ? { deptCode } : {}) });
      json(res, 200, {
        ok: true,
        data: { ...describeContentList(result), viewer: { actorId, deptCode: deptCode ?? null } },
        state: stateFor(req),
      });
      return;
    }

    case '/api/content-similar': {
      const entry = current();
      const actorId = contentActorId(req, entry);
      const deptCode = entry.session.document.encounter?.deptCode;
      const visible = listContentFor(CONFIG_KV, { actorId, ...(deptCode ? { deptCode } : {}) });
      const rawParagraphs = body.paragraphs;
      const paragraphs = Array.isArray(rawParagraphs)
        ? rawParagraphs.map((value) => String(value ?? ''))
        : String(rawParagraphs ?? '').split(/\r?\n/);
      const found = findSimilarContent(visible.items, { name: String(body.name ?? ''), paragraphs });
      json(res, 200, {
        ok: true,
        data: {
          exact: found.exact ? describeContent(found.exact) : null,
          similar: found.similar.map((hit) => ({ score: hit.score, item: describeContent(hit.item) })),
          checked: visible.items.length,
        },
        state: stateFor(req),
      });
      return;
    }

    case '/api/content-create': {
      const entry = current();
      let target: ContentScopeRef;
      try {
        target = contentScopeOf(req, entry, body);
      } catch (err) {
        json(res, 200, {
          ok: false,
          code: (err as { code?: string }).code ?? 'E_AUTH_REQUIRED',
          message: (err as Error).message,
          state: stateFor(req),
        });
        return;
      }
      const kind = body.kind ?? 'content-paragraph';
      if (kind !== 'phrase' && kind !== 'content-paragraph') {
        json(res, 200, {
          ok: false,
          code: 'E_CONTENT_INVALID',
          message: 'kind 只能是 phrase（常用语，插进当前这一句）或 content-paragraph（内容段落，另起段落）',
          state: stateFor(req),
        });
        return;
      }
      try {
        const actor = contentActorId(req, entry);
        const { item } = addContent(
          CONFIG_KV,
          target,
          {
            kind,
            name: String(body.name ?? ''),
            paragraphs: (body.paragraphs ?? '') as string[] | string,
            ...(body.trigger !== undefined ? { trigger: String(body.trigger) } : {}),
            ...(body.group !== undefined ? { group: String(body.group) } : {}),
            ...(body.anchorHint !== undefined ? { anchorHint: String(body.anchorHint) } : {}),
            ...(body.note !== undefined ? { note: String(body.note) } : {}),
          },
          actor,
        );
        if (target.scope !== 'personal') {
          recordAdminAudit({
            actor,
            subject: `${CONTENT_SCOPE_LABELS[target.scope]}内容库`,
            kind: '变更',
            note: `新增${CONTENT_KIND_LABELS[item.kind]}「${item.name}」（${item.id}${target.owner ? ` · ${target.owner}` : ''}）`,
          });
        }
        json(res, 200, {
          ok: true,
          data: { item: describeContent(item), scope: target.scope, owner: target.owner ?? null },
          state: stateFor(req),
        });
      } catch (err) {
        json(res, 200, {
          ok: false,
          code: (err as { code?: string }).code ?? 'E_CONTENT_INVALID',
          message: (err as Error).message,
          state: stateFor(req),
        });
      }
      return;
    }

    case '/api/content-update': {
      const entry = current();
      let target: ContentScopeRef;
      try {
        target = contentScopeOf(req, entry, body);
      } catch (err) {
        json(res, 200, {
          ok: false,
          code: (err as { code?: string }).code ?? 'E_AUTH_REQUIRED',
          message: (err as Error).message,
          state: stateFor(req),
        });
        return;
      }
      const itemId = String(body.itemId ?? '');
      const patch: Record<string, unknown> = {};
      for (const key of ['name', 'paragraphs', 'trigger', 'group', 'anchorHint', 'note']) {
        if (body[key] !== undefined) patch[key] = body[key];
      }
      try {
        const actor = contentActorId(req, entry);
        const { item } = patchContent(CONFIG_KV, target, itemId, patch as never, actor);
        if (target.scope !== 'personal') {
          recordAdminAudit({
            actor,
            subject: `${CONTENT_SCOPE_LABELS[target.scope]}内容库`,
            kind: '变更',
            note: `修改${CONTENT_KIND_LABELS[item.kind]}「${item.name}」（${item.id}）：${Object.keys(patch).join(' / ')}`,
          });
        }
        json(res, 200, {
          ok: true,
          data: { item: describeContent(item), scope: target.scope, owner: target.owner ?? null },
          state: stateFor(req),
        });
      } catch (err) {
        json(res, 200, {
          ok: false,
          code: (err as { code?: string }).code ?? 'E_CONTENT_INVALID',
          message: (err as Error).message,
          state: stateFor(req),
        });
      }
      return;
    }

    case '/api/content-delete': {
      const entry = current();
      let target: ContentScopeRef;
      try {
        target = contentScopeOf(req, entry, body);
      } catch (err) {
        json(res, 200, {
          ok: false,
          code: (err as { code?: string }).code ?? 'E_AUTH_REQUIRED',
          message: (err as Error).message,
          state: stateFor(req),
        });
        return;
      }
      const itemId = String(body.itemId ?? '');
      try {
        const actor = contentActorId(req, entry);
        const before = loadContent(CONFIG_KV, target).items.find((candidate) => candidate.id === itemId);
        const loaded = removeContent(CONFIG_KV, target, itemId, actor);
        if (target.scope !== 'personal') {
          recordAdminAudit({
            actor,
            subject: `${CONTENT_SCOPE_LABELS[target.scope]}内容库`,
            kind: '变更',
            note: `删除${CONTENT_KIND_LABELS[before?.kind ?? 'content-paragraph']}「${before?.name ?? itemId}」（${itemId}${target.owner ? ` · ${target.owner}` : ''}）`,
          });
        }
        json(res, 200, {
          ok: true,
          data: { itemId, remaining: loaded.items.length, scope: target.scope, owner: target.owner ?? null },
          state: stateFor(req),
        });
      } catch (err) {
        json(res, 200, {
          ok: false,
          code: (err as { code?: string }).code ?? 'E_CONTENT_INVALID',
          message: (err as Error).message,
          state: stateFor(req),
        });
      }
      return;
    }

    /* 管理端的共享内容库（科室 / 全院）。个人作用域不走这里：
       那是医生自己攒的清单，管理员对它只有"删与改"两种动作，两种都是负收益 */
    case '/api/content-library-list': {
      try {
        guard(req, 'pack.toggle');
        const target = sharedContentTarget(body);
        const loaded = loadContent(CONFIG_KV, target);
        json(res, 200, {
          ok: true,
          data: {
            scope: target.scope,
            owner: target.owner ?? null,
            label: CONTENT_SCOPE_LABELS[target.scope],
            items: loaded.items.map((item) => describeContent(item)),
            count: loaded.items.length,
            limit: CONTENT_LIMITS.itemsPerScope,
            source: loaded.source,
            updatedAt: loaded.updatedAt ?? null,
            updatedBy: loaded.updatedBy ?? null,
          },
          state: stateFor(req),
        });
      } catch (err) {
        json(res, 200, {
          ok: false,
          code: (err as { code?: string }).code ?? 'E_CONTENT_INVALID',
          message: (err as Error).message,
          state: stateFor(req),
        });
      }
      return;
    }

    case '/api/content-library-create': {
      try {
        const actor = guard(req, 'pack.toggle').actorId;
        const target = sharedContentTarget(body);
        const kind = body.kind ?? 'content-paragraph';
        if (kind !== 'phrase' && kind !== 'content-paragraph') {
          throw new ContentError('E_CONTENT_INVALID', 'kind 只能是 phrase（常用语，插进当前这一句）或 content-paragraph（内容段落，另起段落）');
        }
        const { item, loaded } = addContent(
          CONFIG_KV,
          target,
          {
            kind,
            name: String(body.name ?? ''),
            paragraphs: (body.paragraphs ?? '') as string[] | string,
            ...(body.trigger !== undefined ? { trigger: String(body.trigger) } : {}),
            ...(body.group !== undefined ? { group: String(body.group) } : {}),
          },
          actor,
        );
        recordAdminAudit({
          actor,
          subject: `${CONTENT_SCOPE_LABELS[target.scope]}内容库`,
          kind: '变更',
          note: `新增${CONTENT_KIND_LABELS[item.kind]}「${item.name}」（${item.id}${target.owner ? ` · ${target.owner}` : ''}）`,
        });
        json(res, 200, {
          ok: true,
          data: { item: describeContent(item), count: loaded.items.length, limit: CONTENT_LIMITS.itemsPerScope },
          state: stateFor(req),
        });
      } catch (err) {
        json(res, 200, {
          ok: false,
          code: (err as { code?: string }).code ?? 'E_CONTENT_INVALID',
          message: (err as Error).message,
          state: stateFor(req),
        });
      }
      return;
    }

    case '/api/content-library-update': {
      try {
        const actor = guard(req, 'pack.toggle').actorId;
        const target = sharedContentTarget(body);
        const itemId = String(body.itemId ?? '');
        const patch: Record<string, unknown> = {};
        /* 类型不给改：换类型等于换一条内容（落笔方式不同），改名换不来这个语义 */
        for (const key of ['name', 'paragraphs', 'trigger', 'group']) {
          if (body[key] !== undefined) patch[key] = body[key];
        }
        const { item, loaded } = patchContent(CONFIG_KV, target, itemId, patch as never, actor);
        recordAdminAudit({
          actor,
          subject: `${CONTENT_SCOPE_LABELS[target.scope]}内容库`,
          kind: '变更',
          note: `修改${CONTENT_KIND_LABELS[item.kind]}「${item.name}」（${item.id}）：${Object.keys(patch).join(' / ')}`,
        });
        json(res, 200, {
          ok: true,
          data: { item: describeContent(item), count: loaded.items.length, limit: CONTENT_LIMITS.itemsPerScope },
          state: stateFor(req),
        });
      } catch (err) {
        json(res, 200, {
          ok: false,
          code: (err as { code?: string }).code ?? 'E_CONTENT_INVALID',
          message: (err as Error).message,
          state: stateFor(req),
        });
      }
      return;
    }

    case '/api/content-library-delete': {
      try {
        const actor = guard(req, 'pack.toggle').actorId;
        const target = sharedContentTarget(body);
        const itemId = String(body.itemId ?? '');
        const before = loadContent(CONFIG_KV, target).items.find((candidate) => candidate.id === itemId);
        const loaded = removeContent(CONFIG_KV, target, itemId, actor);
        recordAdminAudit({
          actor,
          subject: `${CONTENT_SCOPE_LABELS[target.scope]}内容库`,
          kind: '变更',
          note: `删除${CONTENT_KIND_LABELS[before?.kind ?? 'content-paragraph']}「${before?.name ?? itemId}」（${itemId}${target.owner ? ` · ${target.owner}` : ''}）`,
        });
        json(res, 200, {
          ok: true,
          data: { itemId, count: loaded.items.length, limit: CONTENT_LIMITS.itemsPerScope },
          state: stateFor(req),
        });
      } catch (err) {
        json(res, 200, {
          ok: false,
          code: (err as { code?: string }).code ?? 'E_CONTENT_INVALID',
          message: (err as Error).message,
          state: stateFor(req),
        });
      }
      return;
    }

    case '/api/content-insert': {
      const entry = current();
      const itemId = String(body.itemId ?? '');
      const nodeId = String(body.nodeId ?? '');
      if (itemId === '' || nodeId === '') {
        json(res, 200, {
          ok: false,
          code: 'E_CONTENT_INVALID',
          message: '要给出内容条目（itemId）与落点（nodeId = 光标所在的那一段）',
          state: stateFor(req),
        });
        return;
      }
      const actorId = contentActorId(req, entry);
      const deptCode = entry.session.document.encounter?.deptCode;
      const visible = listContentFor(CONFIG_KV, { actorId, ...(deptCode ? { deptCode } : {}) });
      const item = visible.items.find((candidate) => candidate.id === itemId);
      if (!item) {
        json(res, 200, {
          ok: false,
          code: 'E_CONTENT_ITEM_NOT_FOUND',
          message: `内容「${itemId}」不在你的内容库里（只有"我的 / 本科室 / 全院"这三层能被带入）`,
          state: stateFor(req),
        });
        return;
      }

      const doc = entry.session.document;
      const at = new Date().toISOString();
      const warnings: string[] = [];
      const deptName = deptCode ? departmentNameOf(departmentsNow(), deptCode) : undefined;
      const context = buildContext({
        templateId: '',
        docId: doc.docId,
        createdBy: doc.createdBy,
        patient: doc.patient,
        ...(doc.encounter ? { encounter: doc.encounter } : {}),
        doctor: { actorId },
        at,
        ...(deptName !== undefined ? { context: { 'encounter.deptName': deptName } } : {}),
      });
      const texts = item.paragraphs.map((paragraph) => substituteContext(paragraph, context, warnings));
      const ref = contentRefOf(item);
      const actor = writeActor(req, entry);
      const label = `${CONTENT_SCOPE_LABELS[item.scope]}${CONTENT_KIND_LABELS[item.kind]}「${item.name}」`;

      if (item.kind === 'phrase' && typeof body.start !== 'number') {
        json(res, 200, {
          ok: false,
          code: 'E_CONTENT_INVALID',
          message: '常用语要给出光标位置（start，可带 end）：它插进当前这一句，不另起段落。整段带入请用内容段落',
          state: stateFor(req),
        });
        return;
      }

      if (item.kind === 'phrase') {
        const node = entry.session.document.nodes[nodeId];
        if (!node || node.type !== 'text') {
          json(res, 200, {
            ok: false,
            code: 'E_CONTENT_INVALID',
            message: `常用语只能落在文本段落里（${nodeId} 是 ${node?.type ?? '不存在的节点'}）`,
            state: stateFor(req),
          });
          return;
        }
        const current = runsTextOf(node);
        const clamp = (value: number): number => Math.max(0, Math.min(Math.trunc(value), current.length));
        const start = clamp(body.start as number);
        const end = typeof body.end === 'number' ? clamp(body.end) : start;
        const before = current.slice(0, start);
        const lead = before !== '' && !/[；;，,。、\s]$/.test(before) ? '；' : '';
        const payload = `${lead}${texts[0]}`;
        const result = act(entry, `按${label}带入常用语（${ref}）`, () =>
          entry.session.replaceRange(
            { nodeId: nodeId as NodeId, start: Math.min(start, end), end: Math.max(start, end), payload: { text: payload } },
            actor,
          ),
        );
        if (!result.ok) {
          json(res, 200, { ...result, state: stateFor(req) });
          return;
        }
        noteContentUsed(req, entry, item);
        json(res, 200, {
          ...result,
          data: {
            item: describeContent(item),
            source: ref,
            scope: item.scope,
            placeholders: placeholdersOf(item.paragraphs),
            warnings,
            inline: { nodeId, start, length: payload.length },
            summary: `插进当前段落（光标之后 ${payload.length} 字）`,
          },
          state: stateFor(req),
        });
        return;
      }

      let replaceRange: { start: number; end: number } | null = null;
      if (typeof body.replaceStart === 'number' || typeof body.replaceEnd === 'number') {
        const node = entry.session.document.nodes[nodeId];
        const rawStart = Math.trunc(Number(body.replaceStart ?? 0));
        const rawEnd = Math.trunc(Number(body.replaceEnd ?? rawStart));
        if (!node || node.type !== 'text' || rawStart < 0 || rawEnd < rawStart) {
          json(res, 200, {
            ok: false,
            code: 'E_CONTENT_INVALID',
            message: '触发词区间不合法：replaceStart / replaceEnd 必须落在同一个文本节点里，且 end ≥ start ≥ 0',
            state: stateFor(req),
          });
          return;
        }
        const length = runsTextOf(node).length;
        replaceRange = { start: Math.min(rawStart, length), end: Math.min(rawEnd, length) };
      }

      const result = act(entry, `按${label}带入内容（${ref}）`, () => {
        entry.session.beginUndoGroup();
        try {
          if (replaceRange) {
            entry.session.replaceRange(
              { nodeId: nodeId as NodeId, start: replaceRange.start, end: replaceRange.end, payload: { text: '' } },
              actor,
            );
          }
          return fillContentParagraphs(entry.session, nodeId, texts, ref, actor);
        } finally {
          entry.session.endUndoGroup();
        }
      });
      if (!result.ok) {
        json(res, 200, { ...result, state: stateFor(req) });
        return;
      }
      noteContentUsed(req, entry, item);
      json(res, 200, {
        ...result,
        data: {
          ...result.data,
          item: describeContent(item),
          source: ref,
          scope: item.scope,
          placeholders: placeholdersOf(item.paragraphs),
          warnings,
          triggerExpanded: replaceRange !== null,
          summary: `填进 ${result.data.filled.length} 个空段，新起 ${result.data.created.length} 段`,
        },
        state: stateFor(req),
      });
      return;
    }

    case '/api/content-save-from-doc': {
      const entry = current();
      const nodeId = String(body.nodeId ?? '');
      const kind = body.kind ?? 'content-paragraph';
      if (kind !== 'phrase' && kind !== 'content-paragraph') {
        json(res, 200, {
          ok: false,
          code: 'E_CONTENT_INVALID',
          message: 'kind 只能是 phrase（常用语）或 content-paragraph（内容段落）',
          state: stateFor(req),
        });
        return;
      }
      const session = entry.session;
      const direct = session.document.nodes[nodeId];
      const holder = contentOwnerOf(session, nodeId);
      const textNode = direct?.type === 'text'
        ? direct
        : holder && holder.type === 'paragraph'
          ? textChildOf(session, holder.id)
          : undefined;
      if (!textNode) {
        json(res, 200, {
          ok: false,
          code: 'E_CONTENT_INVALID',
          message: `找不到 ${nodeId} 所在的那一段正文（先点进某一段再存）`,
          state: stateFor(req),
        });
        return;
      }
      const source = body.source === 'section' ? 'section' : 'paragraph';
      let rows: string[] = [];
      let sectionTitle = '';
      let selectedRange: { start: number; end: number } | null = null;
      if (source === 'section' && (typeof body.start === 'number' || typeof body.end === 'number')) {
        json(res, 200, {
          ok: false,
          code: 'E_CONTENT_INVALID',
          message: '整章另存不接受选区：要存一段就选"存为常用语"，要存整章就去掉 start / end',
          state: stateFor(req),
        });
        return;
      }
      if (source === 'section') {
        const holder = contentOwnerOf(session, textNode.id);
        const sectionId = holder?.parentId;
        const section = sectionId ? session.document.nodes[sectionId] : undefined;
        if (!sectionId || !section || section.type !== 'section') {
          json(res, 200, {
            ok: false,
            code: 'E_CONTENT_INVALID',
            message: `${nodeId} 不在任何章节里：整章另存要先点进某一章的正文`,
            state: stateFor(req),
          });
          return;
        }
        sectionTitle = typeof section.title === 'string' ? section.title : '';
        rows = session.indexes
          .childrenOf(sectionId)
          .map((id) => session.document.nodes[id])
          .filter((node): node is DocNode => node !== undefined && node.type === 'paragraph')
          .sort((left, right) => left.order - right.order)
          .map((paragraph) => {
            const own = textChildOf(session, paragraph.id);
            return own ? runsTextOf(own).trim() : '';
          })
          .filter((text) => text !== '');
        if (rows.length === 0) {
          json(res, 200, {
            ok: false,
            code: 'E_CONTENT_INVALID',
            message: `「${sectionTitle || sectionId}」这一章还没有内容：先写几段再存`,
            state: stateFor(req),
          });
          return;
        }
        if (rows.length > CONTENT_LIMITS.paragraphs) {
          json(res, 200, {
            ok: false,
            code: 'E_CONTENT_LIMIT',
            message: `这一章有 ${rows.length} 段，超过一条内容的上限 ${CONTENT_LIMITS.paragraphs} 段：分两次存`,
            state: stateFor(req),
          });
          return;
        }
      } else {
        const whole = runsTextOf(textNode);
        if (typeof body.start === 'number' || typeof body.end === 'number') {
          const start = Math.trunc(Number(body.start ?? 0));
          const end = Math.trunc(Number(body.end ?? start));
          if (start < 0 || end < start || end > whole.length) {
            json(res, 200, {
              ok: false,
              code: 'E_CONTENT_INVALID',
              message: `选区不合法：start / end 必须落在这一段的 0~${whole.length} 之间，且 end ≥ start`,
              state: stateFor(req),
            });
            return;
          }
          const selected = whole.slice(start, end).trim();
          if (selected === '') {
            json(res, 200, { ok: false, code: 'E_CONTENT_INVALID', message: '选中的是空白：先选一段有字的再存', state: stateFor(req) });
            return;
          }
          selectedRange = { start, end };
          rows = [selected];
        } else {
          const raw = whole.trim();
          if (raw === '') {
            json(res, 200, { ok: false, code: 'E_CONTENT_INVALID', message: '这一段还是空的：先写下要存的内容', state: stateFor(req) });
            return;
          }
          rows = [raw];
        }
      }

      const doc = session.document;
      const actorId = contentActorId(req, entry);
      const at = new Date().toISOString();
      const deptName = doc.encounter?.deptCode ? departmentNameOf(departmentsNow(), doc.encounter.deptCode) : undefined;
      const context = buildContext({
        templateId: '',
        docId: doc.docId,
        createdBy: doc.createdBy,
        patient: doc.patient,
        ...(doc.encounter ? { encounter: doc.encounter } : {}),
        doctor: { actorId },
        at,
        ...(deptName !== undefined ? { context: { 'encounter.deptName': deptName } } : {}),
      });

      const identityKeys = [
        'patient.nameMasked',
        'patient.patientId',
        'patient.birthDate',
        'encounter.visitId',
        'encounter.admittedAt',
        'encounter.dischargedAt',
        'encounter.deptName',
        'doctor.actorId',
      ];
      const replaced: string[] = [];
      const texts = rows.map((row) => {
        let text = row;
        for (const key of identityKeys) {
          const value = context[key];
          if (typeof value !== 'string') continue;
          const trimmed = value.trim();
          /* 太短的值（一两个字）替换会误伤正常词句；姓名脱敏后通常是"张*"这种两字以上，仍能命中 */
          if (trimmed.length < 2 || !text.includes(trimmed)) continue;
          text = text.split(trimmed).join(`{{${key}}}`);
          if (!replaced.includes(key)) replaced.push(key);
        }
        return text;
      });

      const findings: PhiFinding[] = [];
      texts.forEach((text, index) => {
        const local: PhiFinding[] = [];
        scanText(text, '内容层', local);
        for (const finding of local) {
          findings.push(texts.length > 1 ? { ...finding, detail: `第 ${index + 1} 段：${finding.detail}` } : finding);
        }
      });
      const blocking = findings.filter((finding) => finding.level === 'must' || finding.level === 'review');
      if (blocking.length > 0) {
        json(res, 200, {
          ok: false,
          code: 'E_CONTENT_PHI',
          message: `${source === 'section' ? '这一章里' : '这一段里'}还有可识别个人的内容，存成模板会把它带进下一份病历：\n- ${blocking
            .map((finding) => `${finding.rule}：${finding.detail}`)
            .join('\n- ')}\n改成 {{patient.nameMasked}} 这类占位符，或删掉后再存`,
          state: stateFor(req),
        });
        return;
      }

      try {
        const { item } = addContent(
          CONFIG_KV,
          { scope: 'personal', owner: actorId },
          {
            kind,
            name: String(body.name ?? ''),
            paragraphs: source === 'section' ? texts : texts[0],
            ...(sectionTitle !== '' ? { anchorHint: sectionTitle } : {}),
            ...(body.trigger !== undefined ? { trigger: String(body.trigger) } : {}),
            ...(body.group !== undefined ? { group: String(body.group) } : {}),
          },
          actorId,
        );
        json(res, 200, {
          ok: true,
          data: {
            item: describeContent(item),
            replaced,
            scope: 'personal',
            source,
            paragraphs: texts.length,
            ...(selectedRange ? { selection: selectedRange } : {}),
          },
          state: stateFor(req),
        });
      } catch (err) {
        json(res, 200, {
          ok: false,
          code: (err as { code?: string }).code ?? 'E_CONTENT_INVALID',
          message: (err as Error).message,
          state: stateFor(req),
        });
      }
      return;
    }

    case '/api/image-upload': {
      const raw = String(body.dataBase64 ?? '');
      const base64 = raw.replace(/^data:[^;]+;base64,/, '');
      if (base64 === '') {
        json(res, 400, { ok: false, code: 'E_IMAGE_EMPTY', message: '没有收到图片内容' });
        return;
      }
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
      const entry = current();
      const at = new Date().toISOString();
      const report = buildAuditReport({
        doc: entry.session.document,
        generatedAt: at,
        gateRejections: entry.log
          .filter((item) => item.ok === false && typeof item.code === 'string')
          .map((item) => ({ at: item.at, code: item.code as string, ...(item.action ? { action: item.action } : {}) })),
        invariants: entry.session.verifyInvariants(),
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
      const entry = current();
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
      const record = state.readingGrants.get(grantId);
      if (!record) {
        json(res, 200, { ok: false, code: 'E_NOT_FOUND', message: `没有这个授权：${grantId}`, state: stateFor(req) });
        return;
      }
      const stillTrusted = checkIssuerTrust(record.credential, readingAuthorityNow().config);
      if (!stillTrusted.ok) {
        json(res, 200, { ok: false, code: stillTrusted.code, message: stillTrusted.reason, state: stateFor(req) });
        return;
      }
      const environmentId = String(body.environmentId ?? 'WS-01');
      const at = String(body.at ?? new Date().toISOString());
      const context: ReadingContext = { environmentId, actorId: 'DR_DEMO', at, readCount: record.readCount };

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
      const envelopeInput = body.envelope;
      const sealedDelivery = envelopeInput !== null && typeof envelopeInput === 'object' && !Array.isArray(envelopeInput)
        ? {
            envelope: envelopeInput as Envelope,
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
            {
              nodeId,
              patch: {
                tags: [...existing, tag],
                unconfirmedTags: [...(node.unconfirmedTags ?? []), tag],
                humanConfirmed: false,
              },
            },
            actor,
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
      const entry = current();
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
  process.stdout.write(
    `  破坏性动作：重置工作区（/api/reset）需管理员身份（两种模式一致；登录在 /login）。\n`,
  );
  process.stdout.write(
    `  审计锚点：${auditAnchors.count()} 条（每 ${ANCHOR_EVERY} 条记录锚一次）` +
      `${ANCHOR_WRITE_ERROR ? `；⚠ ${ANCHOR_WRITE_ERROR}` : ''}\n`,
  );
  process.stdout.write(`  ${describeServerConfig(SERVER_CONFIG, STATE_KEY_INFO, STATE_SALT_HEX === undefined ? 'derived' : 'file')}\n`);
  process.stdout.write(
    `  系统策略（库 config.system）：鉴权 ${AUTH_MODE} / 会话 ${SESSION_TTL_MINUTES} 分钟 / ` +
      `限流 登录 ${RATE_RULES['login:actor'].limit}·${RATE_RULES['login:source'].limit}、AI ${RATE_RULES['ai:suggest'].limit}/分、导出 ${RATE_RULES.export.limit}/分 / 锚点每 ${ANCHOR_EVERY} 条\n`,
  );
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
