/**
 * 部署参数**从旧文件搬进库**的一次性动作（模型接入 / 落位 / 签名后端 / 授权源）。
 *
 * ## 为什么必须记账（这一步最要紧的一条）
 *
 * 不记账的话，"库里没有这条 → 从旧文件导进来"会在**每一次启动**重新发生。而下面这条路径
 * 一定会有人走：管理员在界面上**清除**模型密钥 → 库里那一行被删 → 下次启动，
 * 旧的 `ai-model.key` 还在状态目录里 → **密钥被悄悄导回来**。
 * 表现是"我明明清掉了，它自己又回来了"，而这是最不该发生的一类事（清除是安全动作）。
 *
 * 所以规则是：**只有真导入了东西才记账**，记了账就再也不看旧文件一眼。
 * 反过来，"没有旧文件就不记账"也同样是刻意的 —— 部署时把旧文件放进状态目录是常见动作，
 * 记早了就把那条路堵死了（同 `core/runtime-dir.ts` 里那条教训）。
 *
 * ## 不覆盖已有的（哪怕已有那一条解不开）
 *
 * 判"库里有没有"用的是 `kv.has`（**只看行在不在，不解内容**）。拿 `read` 去判的话，
 * 一行解不开的旧数据会被当成"没有"，于是旧文件"顺手"把它覆盖掉 ——
 * 那等于用一份文件覆盖掉唯一的一份数据，而现场只会看到"配置变了"。
 *
 * ## 旧文件**不删**
 *
 * 它们是回滚凭据：搬进库之后，旧的 `.json` / `.key` 原地留着。
 * 想退回去（旧程序 + 旧文件）仍有据可依；代价是"两处可能不一致"，
 * 而这条不一致是**单向**的：以库为准（旧文件不再被读，除非 `import_ledger` 里那条被删掉）。
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MODEL_CONFIG_FILE, MODEL_CONFIG_KEY, MODEL_KEY_FILE, MODEL_KEY_KEY } from '../ai/model-config-store.ts';
import { decryptEnvelope, type Envelope } from '../crypto/envelope.ts';
import { PLACEMENT_CONFIG_FILE, PLACEMENT_CONFIG_KEY } from '../dictation/placement-store.ts';
import { READING_AUTHORITY_FILE, READING_AUTHORITY_KEY } from '../reading/reading-authority-store.ts';
import { SIGN_CONFIG_FILE, SIGN_CONFIG_KEY } from '../sign/sign-config-store.ts';
import type { ConfigKv } from './config-kv.ts';

/** `import_ledger` 里的记账 id：记了它，就再也不看旧文件 */
export const LEGACY_CONFIG_LEDGER_ID = 'config-files-import';

interface LegacyFile {
  key: string;
  file: string;
  /** `json` = 直接读 JSON；`modelKey` = 旧格式的密封信封，要先用**旧 salt** 解出来 */
  kind: 'json' | 'modelKey';
}

/** 五份旧文件。顺序固定：日志与报告因此可复现（不随目录遍历顺序变） */
const LEGACY_FILES: readonly LegacyFile[] = [
  { key: MODEL_CONFIG_KEY, file: MODEL_CONFIG_FILE, kind: 'json' },
  { key: MODEL_KEY_KEY, file: MODEL_KEY_FILE, kind: 'modelKey' },
  { key: PLACEMENT_CONFIG_KEY, file: PLACEMENT_CONFIG_FILE, kind: 'json' },
  { key: SIGN_CONFIG_KEY, file: SIGN_CONFIG_FILE, kind: 'json' },
  { key: READING_AUTHORITY_KEY, file: READING_AUTHORITY_FILE, kind: 'json' },
];

export interface LegacyConfigImportPlan {
  needed: boolean;
  /** 不做迁移的原因（要能一眼看懂，而不是"什么都没发生"） */
  reason: string;
  items: LegacyFile[];
  skipped: Array<{ key: string; file: string; why: string }>;
}

/**
 * 决定要不要搬、搬哪几份。**纯函数**：探测函数从参数进来（同 `core/runtime-dir.ts`）。
 */
export function planLegacyConfigImport(
  kv: Pick<ConfigKv, 'has'>,
  dir: string,
  options: { exists?: (path: string) => boolean } = {},
): LegacyConfigImportPlan {
  const exists = options.exists ?? existsSync;
  const items: LegacyFile[] = [];
  const skipped: LegacyConfigImportPlan['skipped'] = [];
  let present = 0;
  for (const entry of LEGACY_FILES) {
    const path = join(dir, entry.file);
    if (!exists(path)) continue;
    present += 1;
    if (kv.has(entry.key)) {
      /* 库里已经有：**看一眼就跳过**（不解内容，也绝不覆盖） */
      skipped.push({ key: entry.key, file: path, why: '库里已经有这一条（不解内容，也不覆盖）' });
      continue;
    }
    items.push({ ...entry, file: path });
  }
  if (present === 0) {
    return { needed: false, reason: `状态目录里没有旧的部署参数文件：${dir}`, items, skipped };
  }
  if (items.length === 0) {
    return { needed: false, reason: `${present} 份旧文件在库里都已有对应的一条，无需搬运`, items, skipped };
  }
  return { needed: true, reason: `把 ${items.length} 份旧的部署参数文件搬进库（旧文件保留，作回滚凭据）`, items, skipped };
}

export interface LegacyConfigImportResult {
  imported: string[];
  failed: Array<{ key: string; message: string }>;
}

/**
 * 执行搬运。**逐项独立**：一份失败不影响其余（四份配置之间没有依赖），
 * 但调用方**不能**因为"大部分成功"就记账 —— 见文件头那条规则。
 */
export function runLegacyConfigImport(
  plan: LegacyConfigImportPlan,
  deps: { kv: ConfigKv; passphrase: string },
): LegacyConfigImportResult {
  if (!plan.needed) return { imported: [], failed: [] };
  const imported: string[] = [];
  const failed: LegacyConfigImportResult['failed'] = [];
  for (const item of plan.items) {
    try {
      const value = readLegacyValue(item, deps.passphrase);
      deps.kv.write(item.key, value);
      imported.push(item.key);
    } catch (err) {
      failed.push({ key: item.key, message: (err as Error).message });
    }
  }
  return { imported, failed };
}

export interface LegacyConfigOnceResult {
  /** 这次有没有真的搬家（被记账拦住时为 false —— 那是**正常**结果，不是错误） */
  ran: boolean;
  imported: string[];
  failed: Array<{ key: string; message: string }>;
  /** 为什么没搬（日志与报告直接用它，省得调用方各说一套） */
  reason: string;
}

/**
 * **带着记账闸门**的搬家 —— 启动时该调用的就是它。
 *
 * 闸门收在这里而不是留在调用方，是因为它是**这条纪律的全部**：
 * "记了账就不再碰旧文件"。放在接口层（demo-server）意味着"每个调用点都得记得判断"，
 * 而漏一个判断的后果是"被清除的密钥自己回来了"。用例也因此能验到真逻辑，而不是重写一遍规则。
 */
export function importLegacyConfigOnce(deps: {
  workStore: { ledgerHas(id: string): boolean; ledgerMark(id: string, note: string): void };
  kv: ConfigKv;
  dir: string;
  passphrase: string;
  at?: string;
}): LegacyConfigOnceResult {
  if (deps.workStore.ledgerHas(LEGACY_CONFIG_LEDGER_ID)) {
    return { ran: false, imported: [], failed: [], reason: '已经搬过一次（记账在库里）：不再看旧文件' };
  }
  const plan = planLegacyConfigImport(deps.kv, deps.dir);
  const result = runLegacyConfigImport(plan, { kv: deps.kv, passphrase: deps.passphrase });
  if (result.failed.length > 0) {
    /* **有失败就不记账**：记了账，失败的那份就永远搬不过来了（下次启动还得再试） */
    return { ran: true, imported: result.imported, failed: result.failed, reason: '有文件没搬成功，不记账（下次启动会再试）' };
  }
  if (result.imported.length > 0) {
    deps.workStore.ledgerMark(LEGACY_CONFIG_LEDGER_ID, `从旧文件搬入 ${result.imported.length} 条部署参数`);
    return { ran: true, imported: result.imported, failed: [], reason: `已搬入 ${result.imported.length} 条，并记账` };
  }
  /* 没有旧文件（或库里都已有）→ **不记账**：以后放进来的旧文件仍然该被搬一次 */
  return { ran: true, imported: [], failed: [], reason: plan.reason };
}

function readLegacyValue(item: LegacyFile, passphrase: string): unknown {
  const raw = readFileSync(item.file, 'utf8').replace(/^\uFEFF/, '');
  if (item.kind === 'json') return JSON.parse(raw) as unknown;
  /* 旧的模型密钥是一个密封信封。**salt 在信封自己的头里**，所以只需要口令。
     解不开就**如实失败**，不要"导个空值进去" —— 那会让"密钥已就位"变成一句假话。 */
  const envelope = JSON.parse(raw) as Envelope;
  const decrypted = decryptEnvelope(envelope, passphrase);
  if (!decrypted.ok) {
    throw new Error(
      `旧密钥文件解不开（口令已更换，或文件被改动过）：${decrypted.reason}；` +
        '不会当作"没有密钥"继续 —— 那会表现成"模型突然 401"',
    );
  }
  return new TextDecoder().decode(decrypted.plaintext);
}
