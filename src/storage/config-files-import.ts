// 部署参数从旧文件搬进库的一次性动作（模型接入 / 落位 / 签名后端 / 授权源）。

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MODEL_CONFIG_FILE, MODEL_CONFIG_KEY, MODEL_KEY_FILE, MODEL_KEY_KEY } from '../ai/model-config-store.ts';
import { decryptEnvelope, type Envelope } from '../crypto/envelope.ts';
import { PLACEMENT_CONFIG_FILE, PLACEMENT_CONFIG_KEY } from '../dictation/placement-store.ts';
import { READING_AUTHORITY_FILE, READING_AUTHORITY_KEY } from '../reading/reading-authority-store.ts';
import { SIGN_CONFIG_FILE, SIGN_CONFIG_KEY } from '../sign/sign-config-store.ts';
import type { ConfigKv } from './config-kv.ts';

export const LEGACY_CONFIG_LEDGER_ID = 'config-files-import';

interface LegacyFile {
  key: string;
  file: string;
  /** `json` = 直接读 JSON；`modelKey` = 旧格式的密封信封，要先用旧 salt 解出来  */
  kind: 'json' | 'modelKey';
}

const LEGACY_FILES: readonly LegacyFile[] = [
  { key: MODEL_CONFIG_KEY, file: MODEL_CONFIG_FILE, kind: 'json' },
  { key: MODEL_KEY_KEY, file: MODEL_KEY_FILE, kind: 'modelKey' },
  { key: PLACEMENT_CONFIG_KEY, file: PLACEMENT_CONFIG_FILE, kind: 'json' },
  { key: SIGN_CONFIG_KEY, file: SIGN_CONFIG_FILE, kind: 'json' },
  { key: READING_AUTHORITY_KEY, file: READING_AUTHORITY_FILE, kind: 'json' },
];

export interface LegacyConfigImportPlan {
  needed: boolean;
  reason: string;
  items: LegacyFile[];
  skipped: Array<{ key: string; file: string; why: string }>;
}

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
  ran: boolean;
  imported: string[];
  failed: Array<{ key: string; message: string }>;
  reason: string;
}

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
    return { ran: true, imported: result.imported, failed: result.failed, reason: '有文件没搬成功，不记账（下次启动会再试）' };
  }
  if (result.imported.length > 0) {
    deps.workStore.ledgerMark(LEGACY_CONFIG_LEDGER_ID, `从旧文件搬入 ${result.imported.length} 条部署参数`);
    return { ran: true, imported: result.imported, failed: [], reason: `已搬入 ${result.imported.length} 条，并记账` };
  }
  return { ran: true, imported: [], failed: [], reason: plan.reason };
}

function readLegacyValue(item: LegacyFile, passphrase: string): unknown {
  const raw = readFileSync(item.file, 'utf8').replace(/^\uFEFF/, '');
  if (item.kind === 'json') return JSON.parse(raw) as unknown;
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
