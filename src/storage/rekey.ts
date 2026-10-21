import { inTransaction, type SqliteDatabase } from './sqlite.ts';
import { sealValue, unsealValue } from './sealed.ts';

export const REKEY_SAME_KEY_CODE = 'E_REKEY_SAME_KEY';
export const REKEY_UNREADABLE_CODE = 'E_REKEY_UNREADABLE';
export const REKEY_NO_KEY_CODE = 'E_REKEY_NO_KEY';

export interface RekeyScope {
  documents: number;
  sidecars: number;
  kv: number;
}

export interface RekeyPlan {
  scope: RekeyScope;
  total: number;
}

export type RekeyOutcome =
  | { ok: true; plan: RekeyPlan; applied: boolean }
  | { ok: false; code: string; message: string };

export interface RekeyOptions {
  newSalt?: string;
  at?: string;
  iterations?: number;
}

interface SealedRow {
  table: 'documents' | 'sidecars' | 'sealed_kv';
  id: string;
  digest: string;
  sealed: string;
}

function rowOf(raw: unknown, table: SealedRow['table'], idField: string): SealedRow {
  const row = raw as Record<string, unknown>;
  return {
    table,
    id: String(row[idField]),
    digest: String(row.payload_digest),
    sealed: String(row.payload_sealed),
  };
}

function readSealedRows(db: SqliteDatabase): SealedRow[] {
  const rows: SealedRow[] = [];
  for (const raw of db.prepare('select doc_id, payload_digest, payload_sealed from documents').all()) {
    rows.push(rowOf(raw, 'documents', 'doc_id'));
  }
  for (const raw of db.prepare('select doc_id, payload_digest, payload_sealed from sidecars').all()) {
    rows.push(rowOf(raw, 'sidecars', 'doc_id'));
  }
  for (const raw of db.prepare('select key, payload_digest, payload_sealed from sealed_kv').all()) {
    rows.push(rowOf(raw, 'sealed_kv', 'key'));
  }
  return rows;
}

function scopeOf(rows: readonly SealedRow[]): RekeyScope {
  return {
    documents: rows.filter((row) => row.table === 'documents').length,
    sidecars: rows.filter((row) => row.table === 'sidecars').length,
    kv: rows.filter((row) => row.table === 'sealed_kv').length,
  };
}

function decodeAll(
  rows: readonly SealedRow[],
  key: string,
  options: { iterations?: number },
): { ok: true; values: unknown[] } | { ok: false; code: string; message: string } {
  void options;
  const values: unknown[] = [];
  for (const [index, row] of rows.entries()) {
    const unsealed = unsealValue<unknown>({ digest: row.digest, sealed: row.sealed }, key);
    if (!unsealed.ok) {
      return {
        ok: false,
        code: REKEY_UNREADABLE_CODE,
        message:
          `第 ${index + 1}/${rows.length} 行（${row.table} · ${row.id}）读不通：${unsealed.message}。` +
          '**未改动任何数据**。若每一行都这样，是旧口令给错了；只有个别行这样，是那一行的数据坏了 —— 两者的处置不同，先别急着换口令',
      };
    }
    values.push(unsealed.data);
  }
  return { ok: true, values };
}

export function planRekey(db: SqliteDatabase, oldKey: string): RekeyOutcome {
  if (!oldKey) {
    return { ok: false, code: REKEY_NO_KEY_CODE, message: '缺少旧口令：没有口令就没有"读通"可言（拒绝按明文处理）' };
  }
  const rows = readSealedRows(db);
  const decoded = decodeAll(rows, oldKey, {});
  if (!decoded.ok) return { ok: false, code: decoded.code, message: decoded.message };
  return { ok: true, plan: { scope: scopeOf(rows), total: rows.length }, applied: false };
}

export function applyRekey(
  db: SqliteDatabase,
  oldKey: string,
  newKey: string,
  options: RekeyOptions = {},
): RekeyOutcome {
  if (!oldKey) {
    return { ok: false, code: REKEY_NO_KEY_CODE, message: '缺少旧口令：拒绝在没有"能读通"的前提下重写库' };
  }
  if (!newKey) {
    return { ok: false, code: REKEY_NO_KEY_CODE, message: '缺少新口令：拒绝用空口令重写（那等于把数据交给任何能读到库文件的人）' };
  }
  if (newKey === oldKey && options.newSalt === undefined) {
    return {
      ok: false,
      code: REKEY_SAME_KEY_CODE,
      message: '新旧口令相同、且没有指定新盐：这次轮换不会改变任何东西，拒绝执行（它只会让日志上多一条"已完成"）',
    };
  }

  const rows = readSealedRows(db);
  const decoded = decodeAll(rows, oldKey, options);
  if (!decoded.ok) return { ok: false, code: decoded.code, message: decoded.message };

  const values = decoded.values;
  try {
    inTransaction(db, () => {
      rows.forEach((row, index) => {
        const sealed = sealValue(values[index], newKey, {
          ...(options.newSalt === undefined ? {} : { salt: options.newSalt }),
          ...(options.iterations === undefined ? {} : { iterations: options.iterations }),
        });
        if (row.table === 'documents') {
          db.prepare('update documents set payload_digest = ?, payload_sealed = ? where doc_id = ?')
            .run(sealed.digest, sealed.sealed, row.id);
        } else if (row.table === 'sidecars') {
          db.prepare('update sidecars set payload_digest = ?, payload_sealed = ? where doc_id = ?')
            .run(sealed.digest, sealed.sealed, row.id);
        } else {
          db.prepare('update sealed_kv set payload_digest = ?, payload_sealed = ? where key = ?')
            .run(sealed.digest, sealed.sealed, row.id);
        }
      });
    });
  } catch (err) {
    return {
      ok: false,
      code: 'E_REKEY_WRITE_FAILED',
      message: `重写失败，已整体回滚（库仍是旧口令，可继续用）：${(err as Error).message}`,
    };
  }
  void options.at;
  return { ok: true, plan: { scope: scopeOf(rows), total: rows.length }, applied: true };
}

export function describeRekeyPlan(plan: RekeyPlan): string {
  if (plan.total === 0) return '库里没有任何密封行（空库：轮换无事可做）';
  return `文档 ${plan.scope.documents} 行 / 旁挂数据 ${plan.scope.sidecars} 行 / 配置与整体式数据 ${plan.scope.kv} 行，合计 ${plan.total} 行`;
}
