// 工作区快照：建议 / 注解 / 主索引三份数据放进同一个文件，避免跨文件不一致。

import { AnnotationBook, type AnnotationBookSnapshot } from './annotations.ts';
import { SuggestionBook, type SuggestionBookSnapshot } from './suggestions.ts';
import { readSnapshot, snapshotExists, writeSnapshot, type SnapshotMeta, type SnapshotOptions, type SnapshotReadError } from './persistence.ts';
import { decryptEnvelope, encryptEnvelope, fromBase64, type Envelope } from '../crypto/envelope.ts';
import { fromHex, sm3, sm3Hex, toHex, utf8 } from '../crypto/sm3.ts';
import { PatientIndex, type PatientIndexSnapshot } from '../model/identity.ts';

export const WORKSPACE_FORMAT = 'l0-workspace';
export const WORKSPACE_VERSION = 1;

export interface WorkspaceData {
  suggestions: SuggestionBookSnapshot;
  annotations: AnnotationBookSnapshot;
  patients: PatientIndexSnapshot;
}

export interface WorkspaceScope {
  suggestions: SuggestionBook;
  annotations: AnnotationBook;
  patients: PatientIndex;
}

export type WorkspaceLoadResult =
  | { ok: true; scope: WorkspaceScope; meta: SnapshotMeta; firstRun: false }
  | { ok: true; scope: WorkspaceScope; meta: null; firstRun: true }
  /** 文件在、但读不出来：必须停手，不能当空工作区继续 */
  | { ok: false; code: SnapshotReadError; message: string; firstRun: false };

export const SIDECAR_FORMAT = 'l0-sidecars';

export type SidecarData = { suggestions: SuggestionBookSnapshot; annotations: AnnotationBookSnapshot };

export type SidecarLoadResult =
  | { ok: true; firstRun: true; data: null }
  | { ok: true; firstRun: false; data: SidecarData; saltFingerprint?: string; digest?: string }
  | { ok: false; code: SnapshotReadError; message: string; firstRun: false };

export function saveSidecars(file: string, data: SidecarData, options: { at?: string } = {}): SnapshotMeta {
  return writeSnapshot(file, data, {
    format: SIDECAR_FORMAT,
    version: WORKSPACE_VERSION,
    ...(options.at ? { at: options.at } : {}),
  });
}

export function loadSidecars(file: string): SidecarLoadResult {
  if (!snapshotExists(file)) return { ok: true, firstRun: true, data: null };
  const read = readSnapshot<SidecarData>(file, { format: SIDECAR_FORMAT, version: WORKSPACE_VERSION });
  if (!read.ok) return { ok: false, code: read.code, message: read.message, firstRun: false };
  const data = read.payload;
  if (!data || !data.suggestions || !data.annotations) {
    return { ok: false, code: 'E_SNAPSHOT_CORRUPT', message: '旁挂快照缺少 suggestions / annotations 分区', firstRun: false };
  }
  return { ok: true, firstRun: false, data };
}

export const SEALED_FORMAT = 'l0-sidecars-sealed';

function deriveStateSalt(passphrase: string): Uint8Array {
  return sm3(utf8(`l0-sidecar-snapshot-salt-v1:${passphrase}`)).subarray(0, 16);
}

export type SaltSource = 'option' | 'derived';

function parseSalt(text: string, where: string): Uint8Array {
  const clean = text.replace(/[\s:_-]+/g, '');
  if (!/^[0-9a-fA-F]{32}$/.test(clean)) {
    throw new Error(
      `${where} 的盐必须是 32 个十六进制字符（16 字节），实际 ${clean.length} 个字符；拒绝静默退回派生盐（那会让"已注入独立盐"变成一句假话）`,
    );
  }
  return fromHex(clean);
}

export function resolveStateSalt(passphrase: string, explicitHex?: string): { salt: Uint8Array; source: SaltSource } {
  if (explicitHex !== undefined) return { salt: parseSalt(explicitHex, '显式参数'), source: 'option' };
  return { salt: deriveStateSalt(passphrase), source: 'derived' };
}

export function saltFingerprint(salt: Uint8Array): string {
  return sm3Hex(salt).slice(0, 16);
}

export function currentSaltFingerprint(passphrase: string, explicitHex?: string): string {
  return saltFingerprint(resolveStateSalt(passphrase, explicitHex).salt);
}

export function saveSealedPayload<T>(
  file: string,
  payload: T,
  passphrase: string,
  options: {
    at?: string;
    salt?: string;
    /** 仅测试用：显式指定派生迭代数（默认 200_000） */
    iterations?: number;
    expect?: SnapshotOptions['expect'];
  } = {},
): SnapshotMeta {
  if (!passphrase) throw new Error('拒绝以明文写入密封快照：必须提供口令（生产从密钥管理注入）');
  const { salt } = resolveStateSalt(passphrase, options.salt);
  const envelope = encryptEnvelope(new TextEncoder().encode(JSON.stringify(payload)), {
    passphrase,
    salt,
    ...(options.iterations === undefined ? {} : { iterations: options.iterations }),
  });
  return writeSnapshot(
    file,
    { envelope },
    {
      format: SEALED_FORMAT,
      version: WORKSPACE_VERSION,
      ...(options.at ? { at: options.at } : {}),
      ...(options.expect ? { expect: options.expect } : {}),
    },
  );
}

export type SealedPayloadResult<T> =
  | { ok: true; firstRun: true; data: null }
  | { ok: true; firstRun: false; data: T; saltFingerprint?: string; digest: string }
  | { ok: false; code: SnapshotReadError; message: string; firstRun: false };

export function loadSealedPayload<T>(file: string, passphrase: string): SealedPayloadResult<T> {
  if (!snapshotExists(file)) return { ok: true, firstRun: true, data: null };
  if (!passphrase) {
    return { ok: false, code: 'E_SNAPSHOT_CORRUPT', message: '缺少口令：无法解密快照（不会退回按明文读取）', firstRun: false };
  }
  const read = readSnapshot<{ envelope: Envelope }>(file, { format: SEALED_FORMAT, version: WORKSPACE_VERSION });
  if (!read.ok) return { ok: false, code: read.code, message: read.message, firstRun: false };
  const envelope = read.payload?.envelope;
  if (!envelope) return { ok: false, code: 'E_SNAPSHOT_CORRUPT', message: '加密封装缺少 envelope 字段', firstRun: false };
  const decrypted = decryptEnvelope(envelope, passphrase);
  if (!decrypted.ok) {
    return {
      ok: false,
      code: 'E_SNAPSHOT_CORRUPT',
      message: `解密失败（${String((decrypted as { code?: string }).code ?? '未知原因')}）：口令错误或文件被改动`,
      firstRun: false,
    };
  }
  let data: T;
  try {
    data = JSON.parse(new TextDecoder().decode(decrypted.plaintext)) as T;
  } catch {
    return { ok: false, code: 'E_SNAPSHOT_CORRUPT', message: '解密后的内容不是合法 JSON', firstRun: false };
  }
  const fingerprint = saltFingerprintOfEnvelope(envelope);
  return { ok: true, firstRun: false, data, digest: read.meta.digest, ...(fingerprint ? { saltFingerprint: fingerprint } : {}) };
}

export function saveSidecarsSealed(
  file: string,
  data: SidecarData,
  passphrase: string,
  options: {
    at?: string;
    salt?: string;
    /** 仅测试用：显式指定派生迭代数（默认 200_000） */
    iterations?: number;
    expect?: SnapshotOptions['expect'];
  } = {},
): SnapshotMeta {
  if (!passphrase) throw new Error('拒绝以明文写入旁挂快照：必须提供口令（生产从密钥管理注入）');
  return saveSealedPayload(file, data, passphrase, options);
}

function saltFingerprintOfEnvelope(envelope: Envelope | undefined): string | null {
  const kdf = envelope?.header?.kdf;
  if (!kdf || kdf.algorithm !== 'PBKDF2-HMAC-SM3') return null;
  return saltFingerprint(fromBase64(kdf.salt));
}

export type SealedInspectResult =
  | { ok: true; saltFingerprint: string; iterations: number; usesCurrentSalt?: boolean }
  | { ok: false; code: SnapshotReadError | 'E_SEALED_NOT_PASSPHRASE'; message: string };

export function inspectSealedSidecars(file: string, currentSalt?: Uint8Array): SealedInspectResult {
  if (!snapshotExists(file)) return { ok: false, code: 'E_SNAPSHOT_MISSING', message: `快照不存在：${file}` };
  const read = readSnapshot<{ envelope: Envelope }>(file, { format: SEALED_FORMAT, version: WORKSPACE_VERSION });
  if (!read.ok) return { ok: false, code: read.code, message: read.message };
  const kdf = read.payload?.envelope?.header?.kdf;
  if (!kdf || kdf.algorithm !== 'PBKDF2-HMAC-SM3') {
    return { ok: false, code: 'E_SEALED_NOT_PASSPHRASE', message: '该文件不是口令模式的密封快照（不适用盐轮换）' };
  }
  const fingerprint = saltFingerprint(fromBase64(kdf.salt));
  return {
    ok: true,
    saltFingerprint: fingerprint,
    iterations: kdf.iterations,
    ...(currentSalt ? { usesCurrentSalt: fingerprint === saltFingerprint(currentSalt) } : {}),
  };
}

export type ResealResult =
  | { ok: true; changed: boolean; before: string; after: string }
  | { ok: false; code: SnapshotReadError | 'E_SEALED_NOT_PASSPHRASE'; message: string };

export function resealSidecars(
  file: string,
  passphrase: string,
  options: { at?: string; salt?: string } = {},
): ResealResult {
  if (!passphrase) return { ok: false, code: 'E_SNAPSHOT_CORRUPT', message: '缺少口令：拒绝重写（没有口令就没有"读通"可言）' };
  const current = resolveStateSalt(passphrase, options.salt).salt;
  const inspect = inspectSealedSidecars(file, current);
  if (!inspect.ok) return { ok: false, code: inspect.code, message: inspect.message };
  if (inspect.usesCurrentSalt === true) {
    return { ok: true, changed: false, before: inspect.saltFingerprint, after: inspect.saltFingerprint };
  }
  const load = loadSealedPayload<unknown>(file, passphrase);
  if (!load.ok) return { ok: false, code: load.code, message: `重写前无法读通，未做任何改动：${load.message}` };
  if (load.firstRun) return { ok: false, code: 'E_SNAPSHOT_MISSING', message: `快照不存在：${file}` };
  saveSealedPayload(file, load.data, passphrase, { ...(options.at ? { at: options.at } : {}), salt: toHex(current) });
  return { ok: true, changed: true, before: inspect.saltFingerprint, after: saltFingerprint(current) };
}

export function loadSidecarsSealed(file: string, passphrase: string): SidecarLoadResult {
  const loaded = loadSealedPayload<SidecarData>(file, passphrase);
  if (!loaded.ok) return { ok: false, code: loaded.code, message: loaded.message, firstRun: false };
  if (loaded.firstRun) return { ok: true, firstRun: true, data: null };
  const data = loaded.data;
  if (!data || !data.suggestions || !data.annotations) {
    return { ok: false, code: 'E_SNAPSHOT_CORRUPT', message: '旁挂快照缺少 suggestions / annotations 分区', firstRun: false };
  }
  return {
    ok: true,
    firstRun: false,
    data,
    digest: loaded.digest,
    ...(loaded.saltFingerprint ? { saltFingerprint: loaded.saltFingerprint } : {}),
  };
}

export function saveWorkspace(file: string, scope: WorkspaceScope, options: { at?: string } = {}): SnapshotMeta {
  const data: WorkspaceData = {
    suggestions: scope.suggestions.snapshot(),
    annotations: scope.annotations.snapshot(),
    patients: scope.patients.snapshot(),
  };
  return writeSnapshot(file, data, {
    format: WORKSPACE_FORMAT,
    version: WORKSPACE_VERSION,
    ...(options.at ? { at: options.at } : {}),
  });
}

export function loadWorkspace(file: string): WorkspaceLoadResult {
  if (!snapshotExists(file)) {
    return {
      ok: true,
      firstRun: true,
      meta: null,
      scope: { suggestions: new SuggestionBook(), annotations: new AnnotationBook(), patients: new PatientIndex() },
    };
  }
  const read = readSnapshot<WorkspaceData>(file, { format: WORKSPACE_FORMAT, version: WORKSPACE_VERSION });
  if (!read.ok) {
    return { ok: false, code: read.code, message: read.message, firstRun: false };
  }
  const data = read.payload;
  if (!data || !data.suggestions || !data.annotations || !data.patients) {
    return {
      ok: false,
      code: 'E_SNAPSHOT_CORRUPT',
      message: '工作区快照缺少必备分区（suggestions / annotations / patients）',
      firstRun: false,
    };
  }
  try {
    return {
      ok: true,
      firstRun: false,
      meta: read.meta,
      scope: {
        suggestions: SuggestionBook.restore(data.suggestions),
        annotations: AnnotationBook.restore(data.annotations),
        patients: PatientIndex.restore(data.patients),
      },
    };
  } catch (err) {
    return { ok: false, code: 'E_SNAPSHOT_CORRUPT', message: (err as Error).message, firstRun: false };
  }
}
