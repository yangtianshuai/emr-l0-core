import { createHash, createHmac, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerConditionOperator, unregisterConditionOperator, type QcConditionValueSpec } from './condition.ts';

/** 插件契约版本：清单必须精确声明它（与规则包的 `engineApi` 同一条纪律） */
export const QC_PLUGIN_API = 'qc-operator/1';
export const SUPPORTED_QC_PLUGIN_APIS: readonly string[] = [QC_PLUGIN_API];

export const QC_PLUGIN_MANIFEST_FILE = 'qc-plugin.json';
export const QC_PLUGIN_SIGNATURE_FILE = 'qc-plugin.sig.json';
export const QC_PLUGIN_KEY_FILE = 'qc-plugin-key.txt';

export const E_PLUGIN_NOT_FOUND = 'E_PLUGIN_NOT_FOUND';
export const E_PLUGIN_KEY_MISSING = 'E_PLUGIN_KEY_MISSING';
export const E_PLUGIN_SIGNATURE_INVALID = 'E_PLUGIN_SIGNATURE_INVALID';
export const E_PLUGIN_FILE_MISMATCH = 'E_PLUGIN_FILE_MISMATCH';
export const E_PLUGIN_API_UNSUPPORTED = 'E_PLUGIN_API_UNSUPPORTED';
export const E_PLUGIN_MANIFEST_INVALID = 'E_PLUGIN_MANIFEST_INVALID';
export const E_PLUGIN_IMPORT_FAILED = 'E_PLUGIN_IMPORT_FAILED';
export const E_PLUGIN_OPERATOR_MISMATCH = 'E_PLUGIN_OPERATOR_MISMATCH';

export class QcPluginError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface QcPluginOperatorDecl {
  name: string;
  label: string;
  fields: string[];
  value: QcConditionValueSpec | null;
  doc: string;
}

export interface QcPluginFileEntry {
  path: string;
  sha256: string;
}

export interface QcPluginManifest {
  pluginId: string;
  name: string;
  version: string;
  api: string;
  /** 入口文件（相对插件目录），必须出现在 `files` 里 */
  entry: string;
  files: QcPluginFileEntry[];
  operators: QcPluginOperatorDecl[];
}

export interface QcPluginSignature {
  algorithm: 'hmac-sha256';
  /** 密钥标识（只用于留痕与轮换：签名里不含密钥本身） */
  keyId: string;
  manifestSha256: string;
  hmac: string;
}

export function sha256OfText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function sha256OfFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
}

export function manifestDigestOf(manifest: QcPluginManifest): string {
  return sha256OfText(canonicalJson(manifest));
}

function parseJsonText(text: string): unknown {
  const trimmed = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
  return JSON.parse(trimmed);
}

export function hmacOf(digest: string, key: string): string {
  return createHmac('sha256', key).update(digest, 'utf8').digest('hex');
}

export function generatePluginKey(): string {
  return randomBytes(32).toString('hex');
}

export function readPluginKey(dir: string): string | null {
  const path = join(dir, QC_PLUGIN_KEY_FILE);
  if (!existsSync(path)) return null;
  const value = readFileSync(path, 'utf8').trim();
  return value === '' ? null : value;
}

export function writePluginKey(dir: string, key: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, QC_PLUGIN_KEY_FILE);
  writeFileSync(path, `${key}\n`, 'utf8');
  return path;
}

export function signPluginDir(dir: string, key: string, keyId = 'default'): { manifest: QcPluginManifest; manifestPath: string; signaturePath: string } {
  const manifestPath = join(dir, QC_PLUGIN_MANIFEST_FILE);
  if (!existsSync(manifestPath)) {
    throw new QcPluginError(E_PLUGIN_NOT_FOUND, `插件目录「${dir}」里没有 ${QC_PLUGIN_MANIFEST_FILE}`);
  }
  const draft = parseJsonText(readFileSync(manifestPath, 'utf8')) as Partial<QcPluginManifest>;
  const entry = typeof draft.entry === 'string' && draft.entry.trim() !== '' ? draft.entry : 'index.mjs';

  const files: QcPluginFileEntry[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (name === QC_PLUGIN_MANIFEST_FILE || name === QC_PLUGIN_SIGNATURE_FILE || name === QC_PLUGIN_KEY_FILE) continue;
    files.push({ path: name, sha256: sha256OfFile(join(dir, name)) });
  }
  if (!files.some((item) => item.path === entry)) {
    throw new QcPluginError(E_PLUGIN_MANIFEST_INVALID, `清单里写的入口「${entry}」不在插件目录里`);
  }

  const manifest: QcPluginManifest = {
    pluginId: String(draft.pluginId ?? ''),
    name: String(draft.name ?? ''),
    version: String(draft.version ?? ''),
    api: String(draft.api ?? QC_PLUGIN_API),
    entry,
    files,
    operators: (draft.operators ?? []) as QcPluginOperatorDecl[],
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const digest = manifestDigestOf(manifest);
  const signature: QcPluginSignature = { algorithm: 'hmac-sha256', keyId, manifestSha256: digest, hmac: hmacOf(digest, key) };
  const signaturePath = join(dir, QC_PLUGIN_SIGNATURE_FILE);
  writeFileSync(signaturePath, `${JSON.stringify(signature, null, 2)}\n`, 'utf8');
  return { manifest, manifestPath, signaturePath };
}

export interface VerifiedPlugin {
  dir: string;
  manifest: QcPluginManifest;
  signature: QcPluginSignature;
  entryPath: string;
}

export function verifyPluginDir(dir: string, key: string): VerifiedPlugin {
  const manifestPath = join(dir, QC_PLUGIN_MANIFEST_FILE);
  const signaturePath = join(dir, QC_PLUGIN_SIGNATURE_FILE);
  if (!existsSync(manifestPath)) throw new QcPluginError(E_PLUGIN_NOT_FOUND, `插件目录「${dir}」里没有 ${QC_PLUGIN_MANIFEST_FILE}`);
  if (!existsSync(signaturePath)) {
    throw new QcPluginError(
      E_PLUGIN_SIGNATURE_INVALID,
      `插件目录「${dir}」没有签名文件 ${QC_PLUGIN_SIGNATURE_FILE}：未签名的插件一律不装`
        + '（包可以不带签名，因为它带不来代码；插件带来的是可执行的东西）',
    );
  }
  if (key.trim() === '') throw new QcPluginError(E_PLUGIN_KEY_MISSING, '没有部署密钥：无法验签，因此不装任何插件');

  const manifest = parseJsonText(readFileSync(manifestPath, 'utf8')) as QcPluginManifest;
  const signature = parseJsonText(readFileSync(signaturePath, 'utf8')) as QcPluginSignature;

  if (manifest.api !== undefined && !SUPPORTED_QC_PLUGIN_APIS.includes(String(manifest.api))) {
    throw new QcPluginError(E_PLUGIN_API_UNSUPPORTED, `插件「${String(manifest.pluginId)}」声明的契约是「${String(manifest.api)}」：本机支持 ${SUPPORTED_QC_PLUGIN_APIS.join(' / ')}`);
  }
  if (typeof manifest.pluginId !== 'string' || manifest.pluginId.trim() === '' || typeof manifest.name !== 'string' || manifest.name.trim() === '') {
    throw new QcPluginError(E_PLUGIN_MANIFEST_INVALID, `${QC_PLUGIN_MANIFEST_FILE} 必须有 pluginId 与 name`);
  }

  const digest = manifestDigestOf(manifest);
  if (signature.algorithm !== 'hmac-sha256' || signature.manifestSha256 !== digest) {
    throw new QcPluginError(
      E_PLUGIN_SIGNATURE_INVALID,
      `插件「${manifest.pluginId}」的清单与签名不符：清单被改过（或签名是给另一版做的）。`
        + '改过清单就要重新签名 —— 否则签名的内容与跑起来的内容不是同一份',
    );
  }
  if (signature.hmac !== hmacOf(digest, key)) {
    throw new QcPluginError(E_PLUGIN_SIGNATURE_INVALID, `插件「${manifest.pluginId}」的签名验不过：密钥不对，或清单被动过`);
  }

  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new QcPluginError(E_PLUGIN_MANIFEST_INVALID, `插件「${manifest.pluginId}」的清单里没有 files：那就等于没有覆盖任何实现文件`);
  }
  for (const file of manifest.files) {
    const path = join(dir, file.path);
    if (!existsSync(path)) {
      throw new QcPluginError(E_PLUGIN_FILE_MISMATCH, `插件「${manifest.pluginId}」清单里的文件「${file.path}」不存在`);
    }
    if (sha256OfFile(path) !== file.sha256) {
      throw new QcPluginError(
        E_PLUGIN_FILE_MISMATCH,
        `插件「${manifest.pluginId}」的文件「${file.path}」与清单里的摘要不符：实现被改过。`
          + '签名覆盖清单、清单覆盖文件 —— 所以"改了实现没重签"会在这里被拒',
      );
    }
  }

  const entryPath = join(dir, manifest.entry);
  if (!existsSync(entryPath)) {
    throw new QcPluginError(E_PLUGIN_MANIFEST_INVALID, `插件「${manifest.pluginId}」的入口「${manifest.entry}」不存在`);
  }
  return { dir, manifest, signature, entryPath };
}

/** 模块通过 `register(api)` 拿到的东西：只能注册算子，没有别的能力  */
export interface QcPluginApi {
  api: string;
  pluginId: string;
  defineOperator(name: string, impl: {
    evaluate(node: unknown, atom: unknown, ctx: unknown): unknown;
    explain?(node: unknown, atom: unknown, ctx: unknown): { detail: string; suggestion: string } | null;
  }): void;
}

export interface QcPluginLoadSuccess {
  pluginId: string;
  name: string;
  version: string;
  dir: string;
  keyId: string;
  operators: string[];
}

export interface QcPluginLoadFailure {
  dir: string;
  code: string;
  reason: string;
}

export interface QcPluginLoadReport {
  loaded: QcPluginLoadSuccess[];
  failures: QcPluginLoadFailure[];
  dirPresent: boolean;
}

export type PluginModuleImporter = (entryPath: string, cacheKey: string) => Promise<Record<string, unknown>>;

const defaultImporter: PluginModuleImporter = async (entryPath, cacheKey) =>
  import(`${pathToFileURL(entryPath).href}?v=${encodeURIComponent(cacheKey)}`) as Promise<Record<string, unknown>>;

export async function loadVerifiedPlugin(
  verified: VerifiedPlugin,
  importer: PluginModuleImporter = defaultImporter,
): Promise<QcPluginLoadSuccess> {
  const { manifest, entryPath, signature, dir } = verified;
  const declared = manifest.operators.map((item) => item.name);
  if (new Set(declared).size !== declared.length) {
    throw new QcPluginError(E_PLUGIN_OPERATOR_MISMATCH, `插件「${manifest.pluginId}」的清单里算子名重复`);
  }

  let module: Record<string, unknown>;
  try {
    module = await importer(entryPath, signature.manifestSha256);
  } catch (error) {
    throw new QcPluginError(E_PLUGIN_IMPORT_FAILED, `插件「${manifest.pluginId}」的入口无法装载：${(error as Error).message}`);
  }
  const register = module.register;
  if (typeof register !== 'function') {
    throw new QcPluginError(E_PLUGIN_IMPORT_FAILED, `插件「${manifest.pluginId}」的入口必须导出一个 register(api) 函数`);
  }

  const byName = new Map(manifest.operators.map((item) => [item.name, item]));
  const registered: string[] = [];
  const registeredSpecs = new Map<string, Parameters<typeof registerConditionOperator>[0]>();
  const api: QcPluginApi = {
    api: QC_PLUGIN_API,
    pluginId: manifest.pluginId,
    defineOperator(name, impl) {
      const decl = byName.get(name);
      if (!decl) {
        throw new QcPluginError(
          E_PLUGIN_OPERATOR_MISMATCH,
          `插件「${manifest.pluginId}」注册了清单里没有的算子「${name}」：`
            + '清单是审批时看的东西，跑起来的东西必须与它一致',
        );
      }
      if (registered.includes(name)) throw new QcPluginError(E_PLUGIN_OPERATOR_MISMATCH, `插件「${manifest.pluginId}」重复注册算子「${name}」`);
      const spec = {
        name: decl.name,
        label: decl.label,
        fields: decl.fields as never,
        value: decl.value,
        doc: decl.doc,
        evaluate: impl.evaluate as never,
        ...(impl.explain ? { explain: impl.explain as never } : {}),
      };
      registeredSpecs.set(name, spec);
      registered.push(name);
    },
  };

  try {
    await (register as (value: QcPluginApi) => unknown)(api);
  } catch (error) {
    if (error instanceof QcPluginError) throw error;
    throw new QcPluginError(E_PLUGIN_IMPORT_FAILED, `插件「${manifest.pluginId}」的 register 报错：${(error as Error).message}`);
  }

  const missing = declared.filter((name) => !registered.includes(name));
  if (missing.length > 0) {
    throw new QcPluginError(
      E_PLUGIN_OPERATOR_MISMATCH,
      `插件「${manifest.pluginId}」清单里声明了 ${missing.join(' / ')}，但模块没有注册它们：`
        + '少了实现的算子会让引用它的规则永远不命中，而界面上一切正常',
    );
  }

  for (const name of registered) registerConditionOperator(registeredSpecs.get(name) as never);

  return {
    pluginId: manifest.pluginId,
    name: manifest.name,
    version: manifest.version,
    dir,
    keyId: signature.keyId,
    operators: registered,
  };
}

export function unloadPluginOperators(names: readonly string[]): void {
  for (const name of names) unregisterConditionOperator(name);
}

export async function loadQcPlugins(options: {
  dir: string;
  key: string | null;
  importer?: PluginModuleImporter;
}): Promise<QcPluginLoadReport> {
  const report: QcPluginLoadReport = { loaded: [], failures: [], dirPresent: existsSync(options.dir) };
  if (!report.dirPresent) return report;
  if (options.key === null || options.key.trim() === '') {
    report.failures.push({ dir: options.dir, code: E_PLUGIN_KEY_MISSING, reason: '没有部署密钥（qc-plugin-key.txt）：无法验签，因此一个插件都不装' });
    return report;
  }

  for (const entry of readdirSync(options.dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(options.dir, entry.name);
    try {
      const verified = verifyPluginDir(dir, options.key);
      report.loaded.push(await loadVerifiedPlugin(verified, options.importer));
    } catch (error) {
      const code = (error as { code?: string }).code ?? E_PLUGIN_IMPORT_FAILED;
      report.failures.push({ dir, code, reason: (error as Error).message });
    }
  }
  return report;
}
