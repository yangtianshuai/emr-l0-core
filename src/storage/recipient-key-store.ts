/**
 * **接收方公钥目录入库**：原先是一个明文 JSON 文件（`<状态目录>/recipient-keys.json`）。
 *
 * ## 为什么它也要落库
 *
 * 三条理由与 `config-kv.ts` 那批参数相同，另加一条**只有它有**的：
 *
 *   ① 备份一次数据库就带走"加密交付能交给谁"。目录丢了的表现是"归档件还在、却没人能收"，
 *      而它是**唯一**记着收件方公钥的地方（私钥从不进本系统）；
 *   ② 目录原先躺在状态目录里，而"重置工作区"要逐文件挑白名单 —— 漏掉它的表现是
 *      "重置后加密交付忽然没有收件方"，没人会想到是重置干的；
 *   ③ **指纹去重由库来保证**（唯一索引），不再只靠写入前的这一次检查：
 *      同一把钥匙出现两行，"选哪一行"就会随列表顺序变化。
 *
 * ## 明文存，不密封（与病历数据、部署参数**相反**，是刻意的）
 *
 * 目录里**只有公钥**：它就用来公开交换。密封它的代价是"无法用 SQL 核对"、
 * "人工审查要解一遍"，而收益是零（公钥本就可公开，且泄漏它不构成任何攻击面）。
 * 这一条与 `docs/` 里"知识资产包不加密"是同一类判断：**加密只加在该加的地方**，
 * 否则每一次新增字段都要重新判断"这行是明文还是密文"。
 *
 * ## 写路径是"整表替换"，不是逐行 diff
 *
 * 增/删一条的**语义**已经在 `core/recipient-keys.ts` 的纯函数里算完了（含"指纹重复就拒绝"
 * 这类规则），落库只需要把那一个结果整体写下去。逐行算差集只会多出"删了但没插成"这种
 * 半截状态，而它没有任何查询收益（这是"一次读全量、一次写全量"的小数据集，同 `sealed_kv` 的定位）。
 */

import { EMPTY_KEY_STORE, type RecipientKey, type RecipientKeyStore } from '../core/recipient-keys.ts';
import { inTransaction, type SqliteDatabase } from './sqlite.ts';

export const RECIPIENT_KEY_TABLE = 'recipient_keys';

/** 库里一行 → 目录条目；形状不对**抛错**（不静默丢一行：那会让"我导入的接收方不见了"无从排查） */
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

/** 读全量目录。空表 = **首次使用**（正常状态），不是错误 */
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

/** 整体写入目录（事务内先清后插：目录的顺序就是界面上的顺序，`sort` 存下来） */
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
