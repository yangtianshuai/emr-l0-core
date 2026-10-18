// 内涵类质控的配置落库层：规则清单 + 引擎形态 + 引擎凭据。

import { existsSync, readFileSync } from 'node:fs';
import { CONFIG_KEY_PREFIX, type ConfigKv } from '../storage/config-kv.ts';
import { parseContentRules, type ContentQcRuleBrief } from './content-engine.ts';

export const QC_CONTENT_ENGINE_KEY = `${CONFIG_KEY_PREFIX}qc-content.engine`;
export const QC_CONTENT_TOKEN_KEY = `${CONFIG_KEY_PREFIX}qc-content.token`;
export const QC_CONTENT_RULES_KEY = `${CONFIG_KEY_PREFIX}qc-content.rules`;

export type QcContentEngineKind = 'none' | 'model' | 'http';

export type QcContentConfigErrorCode = 'E_QC_CONFIG_INVALID' | 'E_QC_CONFIG_NO_URL';

export class QcContentConfigError extends Error {
  code: QcContentConfigErrorCode;

  constructor(code: QcContentConfigErrorCode, message: string) {
    super(message);
    this.name = 'QcContentConfigError';
    this.code = code;
  }
}

export interface QcContentEngineSetting {
  kind: QcContentEngineKind;
  /** `http` 必有；`none` / `model` 不接受（`model` 用的是管理后台「能力配置」里那一个） */
  url?: string;
  /** 期望引擎自报的 id：给定时，产出对不上就整份拒收 */
  expectEngineId?: string;
}

interface StoredQcContentEngine extends QcContentEngineSetting {
  version: 1;
  tokenStored: boolean;
  updatedAt: string;
  updatedBy: string;
}

interface StoredQcContentRules {
  version: 1;
  rules: unknown[];
  updatedAt: string;
  updatedBy: string;
}

export interface LoadedQcContentConfig {
  engine: QcContentEngineSetting;
  /** 已解出的引擎凭据（内存中）。不得进入任何返回值、日志或留痕  */
  token?: string;
  tokenPresent: boolean;
  rules: ContentQcRuleBrief[];
  /**
   * 规则清单的原始数组（原样存下来的那一份）。
   *
   * 界面要能核对它：判定标准是临床共识，不是秘密，而且"现在判的是哪一份"
   * 必须能被逐条看、被 diff（同知识资产包"不加密以便审查"的取舍）。
   * 回显的边界：它不含引擎凭据（那一条单独一行、永不回显）。
    */
  rulesRaw: unknown[] | null;
  rulesRejected: Array<{ index: number; message: string }>;
  /** 清单本身的问题（读不出来 / 结构不符）；`null` = 没问题 */
  rulesProblem: string | null;
  source: 'store' | 'default';
  updatedAt?: string;
  updatedBy?: string;
}

function readEngine(kv: ConfigKv): StoredQcContentEngine | null {
  const parsed = ((): StoredQcContentEngine | null => {
    try {
      return kv.read<StoredQcContentEngine>(QC_CONTENT_ENGINE_KEY);
    } catch (err) {
      throw new QcContentConfigError(
        'E_QC_CONFIG_INVALID',
        `内涵质控引擎配置读不出来，拒绝按"未接入"继续（那会让"引擎配好了"与"从没配过"长得一样）：${(err as Error).message}`,
      );
    }
  })();
  if (parsed === null) return null;
  if (parsed?.version !== 1) return null;
  return parsed;
}

function readToken(kv: ConfigKv): string | undefined {
  const value = ((): string | null => {
    try {
      return kv.read<string>(QC_CONTENT_TOKEN_KEY);
    } catch (err) {
      throw new QcContentConfigError(
        'E_QC_CONFIG_INVALID',
        `质控引擎凭据读不出来（口令已更换，或那一行被改动过）：${(err as Error).message}；不会当作"没有凭据"继续`,
      );
    }
  })();
  if (value === null) return undefined;
  if (typeof value !== 'string' || value === '') {
    throw new QcContentConfigError('E_QC_CONFIG_INVALID', `库里的质控引擎凭据不会是它该有的样子：${JSON.stringify(value)?.slice(0, 40)}`);
  }
  return value;
}

/** 校验引擎设置：口径只有这一处（读、写两条路径共用） */
export function validateQcEngineSetting(input: Partial<QcContentEngineSetting>): QcContentEngineSetting {
  const kind = input.kind;
  if (kind !== 'none' && kind !== 'model' && kind !== 'http') {
    throw new QcContentConfigError('E_QC_CONFIG_INVALID', `引擎形态只能是 none / model / http，实际 ${JSON.stringify(kind)}`);
  }
  const url = typeof input.url === 'string' ? input.url.trim() : '';
  const expectEngineId = typeof input.expectEngineId === 'string' ? input.expectEngineId.trim() : '';
  if (kind === 'http' && url === '') {
    throw new QcContentConfigError(
      'E_QC_CONFIG_NO_URL',
      '选了 http 引擎却没填地址：拒绝保存（存下去就等于"看起来接上了外部引擎"，而每次质控只会报调用失败）',
    );
  }
  if (kind !== 'http' && url !== '') {
    /* `model` 用的是管理后台「能力配置」里那一个模型（同一个地址、同一份凭据），
       再存一个地址就等于有两处"病历发往哪儿"的答案。 */
    throw new QcContentConfigError('E_QC_CONFIG_INVALID', `引擎形态是 ${kind} 时不该再给地址（实际 ${JSON.stringify(url)}）：地址只在 http 形态下有意义`);
  }
  const setting: QcContentEngineSetting = { kind };
  if (kind === 'http') setting.url = url;
  if (expectEngineId !== '') setting.expectEngineId = expectEngineId;
  return setting;
}

/** 读规则清单（原始数组 → 逐条校验）。空清单是合法状态，不是错误  */
function readRules(kv: ConfigKv): { raw: unknown[] | null; rules: ContentQcRuleBrief[]; rejected: Array<{ index: number; message: string }>; problem: string | null } {
  let stored: StoredQcContentRules | null;
  try {
    stored = kv.read<StoredQcContentRules>(QC_CONTENT_RULES_KEY);
  } catch (err) {
    throw new QcContentConfigError('E_QC_CONFIG_INVALID', `质控规则清单读不出来，拒绝按"没有规则"继续：${(err as Error).message}`);
  }
  if (stored === null) return { raw: null, rules: [], rejected: [], problem: null };
  const parsed = parseContentRules(stored.rules);
  if (!parsed.ok) return { raw: null, rules: [], rejected: [], problem: `规则清单结构不符：${parsed.message}` };
  return { raw: stored.rules, rules: parsed.rules, rejected: parsed.rejected, problem: null };
}

/** 读取生效中的质控配置（库里有就用库里的，没有就是"未接入 + 无规则"） */
export function loadQcContentConfig(kv: ConfigKv): LoadedQcContentConfig {
  const storedEngine = readEngine(kv);
  const rules = readRules(kv);
  if (!storedEngine) {
    return {
      engine: { kind: 'none' },
      tokenPresent: false,
      rules: rules.rules,
      rulesRaw: rules.raw,
      rulesRejected: rules.rejected,
      rulesProblem: rules.problem,
      source: 'default',
    };
  }
  const engine = validateQcEngineSetting(storedEngine);
  const token = storedEngine.tokenStored ? readToken(kv) : undefined;
  return {
    engine,
    ...(token !== undefined ? { token } : {}),
    tokenPresent: token !== undefined && token !== '',
    rules: rules.rules,
    rulesRaw: rules.raw,
    rulesRejected: rules.rejected,
    rulesProblem: rules.problem,
    source: 'store',
    updatedAt: storedEngine.updatedAt,
    updatedBy: storedEngine.updatedBy,
  };
}

export interface QcContentConfigInput {
  engine: Partial<QcContentEngineSetting>;
  /** `undefined` 不改 / `null` 清除 / 字符串 设新值（同模型密钥的三态） */
  token?: string | null;
  /** 给了就整体替换规则清单（原始数组）；不给则不动 */
  rules?: unknown[];
}

export interface SaveQcContentConfigResult {
  loaded: LoadedQcContentConfig;
  tokenAction: 'set' | 'cleared' | 'unchanged';
  /** 本次写入的清单里被丢弃的条目（如实回报，不静默丢）  */
  rulesRejected: Array<{ index: number; message: string }>;
}

/**
 * 保存质控配置。顺序与 `saveModelConfig` 一致：先写非敏感的（引擎形态、规则），
 * 最后动凭据那一行 —— 凭据失败时不会留下"凭据换了但配置还是旧的"这种半截状态。
 */
export function saveQcContentConfig(kv: ConfigKv, input: QcContentConfigInput, by: string, options: { at?: string } = {}): SaveQcContentConfigResult {
  const engine = validateQcEngineSetting(input.engine);
  const at = options.at ?? new Date().toISOString();

  if (input.rules !== undefined) {
    const parsed = parseContentRules(input.rules);
    if (!parsed.ok) {
      throw new QcContentConfigError('E_QC_CONFIG_INVALID', `规则清单被拒：${parsed.message}`);
    }
    const stored: StoredQcContentRules = { version: 1, rules: input.rules, updatedAt: at, updatedBy: by };
    kv.write(QC_CONTENT_RULES_KEY, stored);
  }

  let tokenStored = Boolean(readEngine(kv)?.tokenStored);
  let tokenAction: SaveQcContentConfigResult['tokenAction'] = 'unchanged';
  if (input.token === null) {
    tokenStored = false;
    tokenAction = 'cleared';
  } else if (typeof input.token === 'string' && input.token !== '') {
    kv.write(QC_CONTENT_TOKEN_KEY, input.token);
    tokenStored = true;
    tokenAction = 'set';
  } else if (input.token !== undefined && typeof input.token !== 'string') {
    throw new QcContentConfigError('E_QC_CONFIG_INVALID', 'token 必须是字符串、null（清除）或不传（不改）');
  }

  const storedEngine: StoredQcContentEngine = { version: 1, ...engine, tokenStored, updatedAt: at, updatedBy: by };
  kv.write(QC_CONTENT_ENGINE_KEY, storedEngine);
  /* 清除要真删那一行（同 `saveModelConfig`）：留着密文而报"已清除"，这句话是假的  */
  if (tokenAction === 'cleared') kv.remove(QC_CONTENT_TOKEN_KEY);

  const loaded = loadQcContentConfig(kv);
  return { loaded, tokenAction, rulesRejected: loaded.rulesRejected };
}

export function describeQcContentConfig(loaded: LoadedQcContentConfig): Record<string, unknown> {
  return {
    engine: loaded.engine,
    tokenPresent: loaded.tokenPresent,
    rulesCount: loaded.rules.length,
    rules: loaded.rulesRaw ?? [],
    rulesRejected: loaded.rulesRejected,
    rulesProblem: loaded.rulesProblem,
    source: loaded.source,
    updatedAt: loaded.updatedAt ?? null,
    updatedBy: loaded.updatedBy ?? null,
  };
}

/** `import_ledger` 里的记账 id：记了它，就再也不看旧规则文件 */
export const QC_RULES_LEDGER_ID = 'qc-rules-file-import';

export interface QcRulesImportResult {
  ran: boolean;
  imported: number;
  reason: string;
}

/**
 * 把旧规则文件搬进库（一次性，带记账闸门）。
 *
 * 三条与 `config-files-import.ts` 完全相同的规则：
 *   - 库里已有（`has`，不解内容）→ 不覆盖；
 *   - 真导入了才记账；有失败不记账（下次启动再试）；
 *   - 旧文件不删（回滚凭据）。
  */
export function importQcRulesOnce(deps: {
  workStore: { ledgerHas(id: string): boolean; ledgerMark(id: string, note: string): void };
  kv: ConfigKv;
  file: string;
  at?: string;
}): QcRulesImportResult {
  if (deps.workStore.ledgerHas(QC_RULES_LEDGER_ID)) {
    return { ran: false, imported: 0, reason: '已经搬过一次（记账在库里）：不再看旧规则文件' };
  }
  if (deps.file === '' || !existsSync(deps.file)) {
    /* 没有旧文件 → 不记账：部署时把旧文件放进来是常见动作，记早了就把那条路堵死了  */
    return { ran: true, imported: 0, reason: deps.file === '' ? '未指定旧规则文件（服务端配置 imports.qcRulesFile）' : `旧规则文件不存在：${deps.file}` };
  }
  if (deps.kv.has(QC_CONTENT_RULES_KEY)) {
    return { ran: true, imported: 0, reason: `库里已有规则清单（${deps.file} 不再读，也不记账）` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(deps.file, 'utf8').replace(/^\uFEFF/, '')) as unknown;
  } catch (err) {
    return { ran: true, imported: 0, reason: `旧规则文件无法解析，不记账（下次启动会再试）：${(err as Error).message}` };
  }
  const parsed = parseContentRules(raw);
  if (!parsed.ok) {
    return { ran: true, imported: 0, reason: `旧规则文件结构不符，不记账（下次启动会再试）：${parsed.message}` };
  }
  /* `parseContentRules` 已确认它是数组（`parsed.ok`），这里断言回数组是安全的 */
  deps.kv.write(QC_CONTENT_RULES_KEY, {
    version: 1,
    rules: raw as unknown[],
    updatedAt: deps.at ?? new Date().toISOString(),
    updatedBy: `旧文件导入（${deps.file}）`,
  } satisfies StoredQcContentRules);
  deps.workStore.ledgerMark(QC_RULES_LEDGER_ID, `从 ${deps.file} 搬入 ${parsed.rules.length} 条内涵质控规则`);
  const dropped = parsed.rejected.length > 0 ? `（其中 ${parsed.rejected.length} 条被丢弃，原因见界面"质控"页）` : '';
  return { ran: true, imported: parsed.rules.length, reason: `已从旧文件搬入 ${parsed.rules.length} 条规则${dropped}，并记账` };
}
