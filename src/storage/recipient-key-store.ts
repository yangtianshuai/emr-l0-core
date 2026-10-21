import { EMPTY_KEY_STORE, type RecipientKey, type RecipientKeyStore } from '../core/recipient-keys.ts';
import { inTransaction, type SqliteDatabase } from './sqlite.ts';

export const RECIPIENT_KEY_TABLE = 'recipient_keys';

function rowToKey(row: Record<string, unknown>): RecipientKey {
  const keyId = row.key_id;
  const label = row.label;
  const spkiBase64 = row.spki_base64;
  const fingerprint = row.fingerprint;
  const algorithm = row.algorithm;
  const createdAt = row.created_at;
  for (const [name, value] of [
    ['key_id', keyId],
    ['label', label],
    ['spki_base64', spkiBase64],
    ['fingerprint', fingerprint],
    ['created_at', createdAt],
  ] as const) {
    if (typeof value !== 'string' || value === '') {
      throw new Error(`接收方公钥目录有一行不完整（${name} 为空）：拒绝把它当成一个可用目录继续`);
    }
  }
  if (algorithm !== 'SM2') {
    throw new Error(`接收方公钥目录里出现了本系统不认的算法「${String(algorithm)}」：拒绝按它加密（加密是不可逆的动作）`);
  }
  const key: RecipientKey = {
    keyId: keyId as string,
    label: label as string,
    spkiBase64: spkiBase64 as string,
    fingerprint: fingerprint as string,
    algorithm: 'SM2',
    createdAt: createdAt as string,
  };
  if (typeof row.note === 'string' && row.note !== '') key.note = row.note;
  return key;
}

export function loadRecipientKeyStore(db: SqliteDatabase): RecipientKeyStore {
  const rows = db
    .prepare(
      `select key_id, label, spki_base64, fingerprint, algorithm, note, created_at
         from ${RECIPIENT_KEY_TABLE} order by sort, key_id`,
    )
    .all();
  if (rows.length === 0) return EMPTY_KEY_STORE;
  return { version: 1, keys: rows.map(rowToKey) };
}

export function saveRecipientKeyStore(db: SqliteDatabase, store: RecipientKeyStore): void {
  inTransaction(db, () => {
    db.prepare(`delete from ${RECIPIENT_KEY_TABLE}`).run();
    store.keys.forEach((key, index) => {
      db.prepare(
        `insert into ${RECIPIENT_KEY_TABLE} (key_id, label, spki_base64, fingerprint, algorithm, note, created_at, sort)
           values (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(key.keyId, key.label, key.spkiBase64, key.fingerprint, key.algorithm, key.note ?? null, key.createdAt, index);
    });
  });
}
