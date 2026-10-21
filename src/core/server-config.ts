import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const SERVER_CONFIG_FILE = 'server-config.json';

export const DEMO_STATE_KEY = 'demo-state-passphrase-生产必须替换';

export interface ServerBootstrap {
  token?: string;
  user?: string;
}

export interface ServerImports {
  qcRulesFile?: string;
}

export interface ServerConfig {
  stateKey?: string;
  stateSalt?: string;
  envName?: string;
  bootstrap?: ServerBootstrap;
  imports?: ServerImports;
  _note?: string;
}

export type ServerConfigSource = 'file' | 'generated' | 'missing';

export interface LoadedServerConfig {
  path: string;
  config: ServerConfig;
  source: ServerConfigSource;
  problem: string | null;
}

export function serverConfigPath(runtimeDir: string): string {
  return join(runtimeDir, SERVER_CONFIG_FILE);
}

function templateText(): string {
  const template = {
    stateKey: null,
    stateSalt: null,
    envName: null,
    bootstrap: { token: null, user: null },
    imports: { qcRulesFile: null },
    _note:
      '这是服务端文件配置：打开数据库之前就要知道的东西（密封口令、盐、装机凭据）。'
      + 'stateKey 留空 = 使用内置演示口令（演示可用；生产必须填成密钥管理给出的高熵口令）。'
      + '换口令后已入库的密文需要用同一口令重新密封（本轮无轮换工具，见 README）。'
      + 'stateSalt 留空表示按口令派生；要独立盐就填 32 位十六进制。'
      + 'envName 只是界面上的环境标注，不改变任何行为。'
      + 'bootstrap.token / bootstrap.user 成对填写时，启动即在空库里播种第一个管理员。'
      + 'imports.qcRulesFile 只用于把旧的质控规则文件搬进库（一次性，搬完就不再读）。',
  };
  return `${JSON.stringify(template, null, 2)}\n`;
}

function fail(path: string, what: string): never {
  throw new Error(`服务端配置文件 ${path} ${what}；修好它再启动（拒绝退回内置演示口令：那会让"我配了口令"变成一句假话，且整库密文会一起解不开）`);
}

function parse(text: string, path: string): ServerConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    fail(path, `不是合法 JSON：${(err as Error).message}`);
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) fail(path, '结构不符：应为对象');
  const obj = raw as Record<string, unknown>;
  const config: ServerConfig = {};
  for (const field of ['stateKey', 'stateSalt', 'envName', '_note'] as const) {
    const value = obj[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string') fail(path, `的 ${field} 必须是字符串`);
    config[field] = value;
  }
  const bootstrap = obj.bootstrap;
  if (bootstrap !== undefined && bootstrap !== null) {
    if (typeof bootstrap !== 'object' || Array.isArray(bootstrap)) fail(path, '的 bootstrap 应为对象');
    const record = bootstrap as Record<string, unknown>;
    const parsedBootstrap: ServerBootstrap = {};
    for (const field of ['token', 'user'] as const) {
      const value = record[field];
      if (value === undefined || value === null) continue;
      if (typeof value !== 'string') fail(path, `的 bootstrap.${field} 必须是字符串`);
      parsedBootstrap[field] = value;
    }
    if (parsedBootstrap.token !== undefined || parsedBootstrap.user !== undefined) config.bootstrap = parsedBootstrap;
  }
  const imports = obj.imports;
  if (imports !== undefined && imports !== null) {
    if (typeof imports !== 'object' || Array.isArray(imports)) fail(path, '的 imports 应为对象');
    const record = imports as Record<string, unknown>;
    const parsedImports: ServerImports = {};
    for (const field of ['qcRulesFile'] as const) {
      const value = record[field];
      if (value === undefined || value === null) continue;
      if (typeof value !== 'string') fail(path, `的 imports.${field} 必须是字符串`);
      parsedImports[field] = value;
    }
    if (parsedImports.qcRulesFile !== undefined) config.imports = parsedImports;
  }
  return config;
}

export function loadServerConfig(path: string): LoadedServerConfig {
  if (existsSync(path)) {
    const text = readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
    return { path, config: parse(text, path), source: 'file', problem: null };
  }
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, templateText(), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    return { path, config: parse(templateText(), path), source: 'generated', problem: null };
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'EEXIST') {
      const text = readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
      return { path, config: parse(text, path), source: 'file', problem: null };
    }
    return { path, config: {}, source: 'missing', problem: (err as Error).message };
  }
}

export function stateKeyOf(loaded: LoadedServerConfig): { key: string; source: 'file' | 'demo' } {
  const value = loaded.config.stateKey?.trim();
  if (value === undefined || value === '') return { key: DEMO_STATE_KEY, source: 'demo' };
  if (value === DEMO_STATE_KEY) return { key: value, source: 'demo' };
  return { key: value, source: 'file' };
}

export function stateSaltHexOf(loaded: LoadedServerConfig): string | undefined {
  const value = loaded.config.stateSalt?.trim();
  return value !== undefined && value !== '' ? value : undefined;
}

export function bootstrapOf(loaded: LoadedServerConfig): { token: string | undefined; user: string | undefined; configured: boolean } {
  const token = loaded.config.bootstrap?.token?.trim() || undefined;
  const user = loaded.config.bootstrap?.user?.trim() || undefined;
  return { token, user, configured: token !== undefined };
}

export function importsOf(loaded: LoadedServerConfig): { qcRulesFile: string } {
  return { qcRulesFile: loaded.config.imports?.qcRulesFile?.trim() ?? '' };
}

export function envNameOf(loaded: LoadedServerConfig): string | null {
  const value = loaded.config.envName?.trim();
  return value !== undefined && value !== '' ? value : null;
}

export function describeServerConfig(loaded: LoadedServerConfig, key: ReturnType<typeof stateKeyOf>, saltSource: 'file' | 'derived'): string {
  const where =
    loaded.source === 'file'
      ? `文件 ${loaded.path}`
      : loaded.source === 'generated'
        ? `已生成模板 ${loaded.path}（请填 stateKey）`
        : `没有配置文件（${loaded.path}，${loaded.problem ?? '未知原因'}）`;
  const keyPart =
    key.source === 'file'
      ? '口令来自文件'
      : `⚠️ 口令用的是**内置演示值**（生产必须替换：在 ${loaded.path} 里填 stateKey）`;
  const saltPart = saltSource === 'file' ? '盐来自文件' : '盐按口令派生（⚠️ 无独立盐，盐轮换无从谈起）';
  return `[服务端配置] ${where}；${keyPart}；${saltPart}`;
}
