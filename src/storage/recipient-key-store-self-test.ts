// 接收方公钥目录入库自测（`storage/recipient-key-store.ts`）。
// 拿一把来历不明的钥匙去加密，产出的是一份没有私钥能解开的归档件。

import { TestSuite, assert, assertEqual } from '../testing/harness.ts';
import { openDbFixture } from '../testing/db-fixture.ts';
import { addRecipientKey, publicKeyOf, type RecipientKeyStore } from '../core/recipient-keys.ts';
import { RECIPIENT_KEY_TABLE, loadRecipientKeyStore, saveRecipientKeyStore } from './recipient-key-store.ts';
import { demoKeyPair } from '../crypto/provider.ts';
import { publicKeyToSpki } from '../crypto/sm2.ts';

const suite = new TestSuite('接收方公钥目录入库自测', [
  '说明：目录原先是一个明文 JSON 文件（`recipient-keys.json`），现在在 `recipient_keys` 表里，随库一起备份。',
  'RK3/RK4 是防回退关键：同一把钥匙两行会让"选哪一行"随列表顺序变化；不验算法等于拿未知钥匙去加密。',
]);

const test = (name: string, fn: () => void | Promise<void>): Promise<void> => suite.test(name, fn);
const AT = '2026-10-14T09:00:00.000Z';

/** 造一把真公钥（用演示密钥对导出 SPKI，再 base64）——不造假数据：导入路径要真的过曲线校验  */
function spkiBase64(seed: string): string {
  return Buffer.from(publicKeyToSpki(demoKeyPair(seed).publicKey)).toString('base64');
}

async function main(): Promise<void> {
  await test('RK1 空表 = 首次使用（不是错误）', () => {
    const fixture = openDbFixture({ prefix: 'l0-recipient-keys-' });
    try {
      const store = loadRecipientKeyStore(fixture.db);
      assertEqual(store.version, 1, '结构版本应为 1（与文件时代同一形状）');
      assertEqual(store.keys.length, 0, '空表就是"还没有收件方"，不是错误');
    } finally {
      fixture.cleanup();
    }
  });

  await test('RK2 整表往返保真（含顺序与 note）', () => {
    const fixture = openDbFixture({ prefix: 'l0-recipient-keys-' });
    try {
      const first = addRecipientKey({ version: 1, keys: [] }, { label: '张医生', text: spkiBase64('l0-rk-a'), note: '会诊终端A', now: AT });
      assertEqual(first.ok, true, '前置：导入第一把公钥应成功');
      if (!first.ok) return;
      const second = addRecipientKey(first.store, { label: '李医生', text: spkiBase64('l0-rk-b'), now: AT });
      assertEqual(second.ok, true, '前置：导入第二把公钥应成功');
      if (!second.ok) return;

      saveRecipientKeyStore(fixture.db, second.store);
      const loaded = loadRecipientKeyStore(fixture.db);
      assertEqual(loaded.keys.length, 2, '两把都应读回来');
      assertEqual(loaded.keys[0]?.label, '张医生', '顺序是数据的一部分（界面按它排）');
      assertEqual(loaded.keys[1]?.label, '李医生', '顺序不得变');
      assertEqual(loaded.keys[0]?.note, '会诊终端A', 'note 应原样往返');
      assertEqual(loaded.keys[0]?.algorithm, 'SM2', '算法应如实记下');
      assertEqual(
        loaded.keys[0]?.fingerprint,
        second.store.keys[0]?.fingerprint,
        '指纹必须完整存储与展示（截断过的指纹核对不了"是不是同一把"）',
      );
      /* 从库里读回来的条目仍能取出公钥点：说明 SPKI 没有被写坏 */
      const point = publicKeyOf(loaded.keys[0] as (typeof loaded.keys)[number]);
      assertEqual(typeof point.x, 'bigint', '读回来的公钥应能参与点运算（否则加密会产出解不开的密文）');
    } finally {
      fixture.cleanup();
    }
  });

  await test('RK3 指纹唯一**由库保证**：重复指纹必须被拒', () => {
    const fixture = openDbFixture({ prefix: 'l0-recipient-keys-' });
    try {
      const spki = spkiBase64('l0-rk-c');
      const one = addRecipientKey({ version: 1, keys: [] }, { label: '张医生', text: spki, now: AT });
      assertEqual(one.ok, true, '前置：导入应成功');
      if (!one.ok) return;
      saveRecipientKeyStore(fixture.db, one.store);

      /* 绕过产品代码直接插一行同指纹（模拟"有人手改库"）：唯一索引必须拦住 */
      assert(
        (() => {
          try {
            fixture.db
              .prepare(
                `insert into ${RECIPIENT_KEY_TABLE} (key_id, label, spki_base64, fingerprint, algorithm, note, created_at, sort)
                 values (?, ?, ?, ?, ?, ?, ?, ?)`,
              )
              .run('rk-hand', '冒名者', spki, one.key.fingerprint, 'SM2', null, AT, 9);
            return false;
          } catch {
            return true;
          }
        })(),
        '同一指纹出现两行会让"选哪一行"随列表顺序变化 —— 这条必须由库约束保证，不能只靠写入前检查一次',
      );
    } finally {
      fixture.cleanup();
    }
  });

  await test('RK4 形状不对（算法 / 必填列）→ 读的时候报错，不静默丢一行', () => {
    const fixture = openDbFixture({ prefix: 'l0-recipient-keys-' });
    try {
      fixture.db
        .prepare(
          `insert into ${RECIPIENT_KEY_TABLE} (key_id, label, spki_base64, fingerprint, algorithm, note, created_at, sort)
           values (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run('rk-bad', '某终端', spkiBase64('l0-rk-d'), 'ff00', 'RSA', null, AT, 0);
      assert(
        (() => {
          try {
            loadRecipientKeyStore(fixture.db);
            return false;
          } catch (err) {
            return (err as Error).message.includes('不认的算法');
          }
        })(),
        '库里出现本系统不认的算法时**拒绝给出一份"看起来可用"的目录**：用它加密会产出一份没人解得开的归档件',
      );
    } finally {
      fixture.cleanup();
    }
  });

  await test('RK5 整表替换：删掉一条再存，库里就只剩这一份（不是追加）', () => {
    const fixture = openDbFixture({ prefix: 'l0-recipient-keys-' });
    try {
      const one = addRecipientKey({ version: 1, keys: [] }, { label: '张医生', text: spkiBase64('l0-rk-e'), now: AT });
      if (!one.ok) throw new Error('前置失败');
      const two = addRecipientKey(one.store, { label: '李医生', text: spkiBase64('l0-rk-f'), now: AT });
      if (!two.ok) throw new Error('前置失败');
      saveRecipientKeyStore(fixture.db, two.store);
      assertEqual(loadRecipientKeyStore(fixture.db).keys.length, 2, '前置：两条已在库里');

      const only: RecipientKeyStore = { version: 1, keys: [two.store.keys[1] as (typeof two.store.keys)[number]] };
      saveRecipientKeyStore(fixture.db, only);
      const loaded = loadRecipientKeyStore(fixture.db);
      assertEqual(loaded.keys.length, 1, '整表替换：被删的那条不该还在库里');
      assertEqual(loaded.keys[0]?.label, '李医生', '留下的应是没被删的那一条');
    } finally {
      fixture.cleanup();
    }
  });

  process.exit(suite.report());
}

void main();
