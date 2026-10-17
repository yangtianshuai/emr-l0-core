/**
 * **算子插件**（T3）：让"新增一种算子"不必与应用同版本发版。
 *
 * ## 它与"包是数据"那条线的关系
 *
 * 包（规则包、判定方式）**永远不能带代码** —— 这条线不动。插件不是包：
 * 它是**部署方安装的签名组件**，装在运行时目录里，与应用同机、由实施方维护。
 * 分界因此是：
 *
 *   - 包 = 数据，"判什么"由它决定，**不签也能收**（因为它带不来代码）；
 *   - 插件 = 代码，"怎么算"由它决定，**必须验签**（因为它带来的是可执行的东西）。
 *
 * ## 三道门，缺一不可
 *
 * 1) **验签**：`qc-plugin.sig.json` 用部署密钥（运行时目录里的 `qc-plugin-key.txt`）
 *    对 `qc-plugin.json` 的**规范化摘要**做 HMAC；签名不符 = 一个字节都不 import。
 * 2) **验文件**：清单里每个文件都有 sha256，逐个比对 —— 签名覆盖清单，清单覆盖文件，
 *    于是"改了实现没改清单"会被拒。
 * 3) **验算子**：清单声明的算子必须与模块注册的**完全一致**（不多不少）。
 *    这条防的是"清单里写 3 个、实际装上 5 个"—— 那种插件审批时看的东西与跑起来的东西不是同一份。
 *
 * ## 为什么清单里写算子声明、模块里写实现
 *
 * 声明（名字 / 字段 / 取值形态 / 说明）是**可审阅的**：审批的人不需要读代码就能看出
 * "这个算子读什么、怎么填、用在哪"。实现放在模块里，只由 `defineOperator` 收下。
 *
 * ## 失败不是"跳过"
 *
 * 加载失败一律**记进 `failures` 并原样上报**（含目录与原因），不静默跳过 ——
 * 跳过会让"插件没生效"表现成"规则没命中"，而界面上一切正常。
 */

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

/* ------------------------------ 清单 ------------------------------ */

/** 清单里的算子声明（**可序列化**：审批的人读的就是它） */
export interface QcPluginOperatorDecl {
  name: string;
  label: string;
  /** 能用在哪些字段上（字段名来自内核的封闭字段表） */
  fields: string[];
  value: QcConditionValueSpec | null;
  doc: string;
}

export interface QcPluginFileEntry {
  path: string;
  sha256: string;
}

export interface QcPluginManifest {
  /** 插件标识（如 `qc.plugin.demo`）。重名会让"装的是哪一个"说不清 */
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

/* ------------------------------ 摘要与签名 ------------------------------ */

export function sha256OfText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function sha256OfFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * 规范化 JSON：**键按字典序排列、递归**。
 *
 * 为什么必须规范化：签名覆盖的是这份文本，而 `JSON.stringify` 的键序取决于写法。
 * 不规范化的话"原样重写一份清单"就会让签名失效 —— 那时人们只会去重签，而不是去问为什么。
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
}

export function manifestDigestOf(manifest: QcPluginManifest): string {
  return sha256OfText(canonicalJson(manifest));
}

/**
 * 读一份 JSON 文件文本。
 *
 * **必须容忍开头的 BOM**：Windows 上的记事本、PowerShell 的 `Set-Content -Encoding utf8`
 * 都会给它加一个 `\uFEFF`，而 `JSON.parse` 遇到它直接抛。插件清单是**人工维护**的文件，
 * 在这上面"格式敏感"只会得到"照抄示例却装不上"，而错误信息还指向 JSON 语法（看起来像写错了）。
 */
function parseJsonText(text: string): unknown {
  const trimmed = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
  return JSON.parse(trimmed);
}

export function hmacOf(digest: string, key: string): string {
  return createHmac('sha256', key).update(digest, 'utf8').digest('hex');
}

/** 生成一把部署密钥（写入 `qc-plugin-key.txt`；**不给它就不验签，宁可不装**） */
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

/* --------------------------- 签名（给 CLI 用） --------------------------- */

/**
 * 给一个插件目录签名：算出 `files` 的 sha256、写入清单、再写签名文件。
 *
 * 它**同时**做两件事（列文件 + 签名）是刻意的：分两步的话，"加了文件忘了更新清单"
 * 会得到一份签名有效但清单不全的插件 —— 那种插件跑起来缺东西，而验签一路通过。
 *
 * `manifest` 里已有的 `pluginId / name / version / operators` 原样保留（人工写的部分）；
 * `files` / `entry` 由这里补齐。
 */
export function signPluginDir(dir: string, key: string, keyId = 'default'): { manifest: QcPluginManifest; manifestPath: string; signaturePath: string } {
  const manifestPath = join(dir, QC_PLUGIN_MANIFEST_FILE);
  if (!existsSync(manifestPath)) {
    throw new QcPluginError(E_PLUGIN_NOT_FOUND, `插件目录「${dir}」里没有 ${QC_PLUGIN_MANIFEST_FILE}`);
  }
  const draft = parseJsonText(readFileSync(manifestPath, 'utf8')) as Partial<QcPluginManifest>;
  const entry = typeof draft.entry === 'string' && draft.entry.trim() !== '' ? draft.entry : 'index.mjs';

  /* 列文件：插件目录下的全部文件（除清单与签名自己）—— 漏掉一个就等于留一个不受校验的入口 */
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

/* ------------------------------ 验签 ------------------------------ */

export interface VerifiedPlugin {
  dir: string;
  manifest: QcPluginManifest;
  signature: QcPluginSignature;
  entryPath: string;
}

/** 校验一个插件目录（不 import：验签与"执行"分开）。不合法即抛 */
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

/* ------------------------------ 装载 ------------------------------ */

/** 模块通过 `register(api)` 拿到的东西：**只能注册算子**，没有别的能力 */
export interface QcPluginApi {
  api: string;
  pluginId: string;
  /** 注册一个算子：声明来自清单（可审阅），实现来自模块 */
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
  /** 插件根目录不存在 = 这台机器没装插件（不是错误） */
  dirPresent: boolean;
}

/**
 * 动态 import 的可替换实现（用例用它换来一份可复现的装载过程；生产用真的 import）。
 *
 * `cacheKey` 必须参与 URL：ESM 的模块缓存按 **URL** 命中，同一个路径第二次 import 拿到的是
 * 上一次的模块对象。装了新版本的插件、或自测里同名目录换了内容时，那会得到**旧代码**在新清单下跑 -
 * 而验签一路通过（清单与文件的摘要都是新的）。用清单摘要当版本标识，恰好是"这份签名的内容"。
 */
export type PluginModuleImporter = (entryPath: string, cacheKey: string) => Promise<Record<string, unknown>>;

const defaultImporter: PluginModuleImporter = async (entryPath, cacheKey) =>
  import(`${pathToFileURL(entryPath).href}?v=${encodeURIComponent(cacheKey)}`) as Promise<Record<string, unknown>>;

/**
 * 装载一个插件（**已验签的目录**）：import 模块 → 调 `register(api)` → 注册算子。
 *
 * 校验清单与模块的一致性：清单声明的算子必须**恰好**等于模块注册的那些。
 * 多一个 = 审批时看的东西与跑起来的东西不是同一份；少一个 = 引用它的规则永远不命中。
 */
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

  /* 全部校验通过之后**才**真正写进算子表：中途失败不留半个插件在场 */
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

/** 上次装载注册进来的算子（卸载用：目录被移除时要能回到干净状态） */
export function unloadPluginOperators(names: readonly string[]): void {
  for (const name of names) unregisterConditionOperator(name);
}

/**
 * 从插件根目录装载**全部**插件。
 *
 * 逐个目录独立：一个装不上不影响其它（但**它会被记进 failures**，不会被跳过）。
 * 目录不存在 = 本机没装插件 —— 这不是错误，`dirPresent: false` 如实说出来。
 */
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
      /* 算子注册失败（重名等）也要把自己的码带出来：报成"装载失败"会让人去查文件，
         而实际是"这个算子名已经被占了" */
      const code = (error as { code?: string }).code ?? E_PLUGIN_IMPORT_FAILED;
      report.failures.push({ dir, code, reason: (error as Error).message });
    }
  }
  return report;
}
