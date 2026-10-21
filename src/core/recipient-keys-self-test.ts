import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TestSuite, assert, assertEqual } from '../testing/harness.ts';
import { demoKeyPair } from '../crypto/provider.ts';
import { publicKeyToSpki } from '../crypto/sm2.ts';
import { decryptEnvelopeWith, encryptEnvelopeFor } from '../crypto/envelope.ts';
import { sealDocumentJson } from './encrypted-reading.ts';
import {
  EMPTY_KEY_STORE,
  addRecipientKey,
  exportRecipientPublicKey,
  findRecipientKey,
  loadRecipientKeys,
  parseRecipientPublicKey,
  publicKeyOf,
  removeRecipientKey,
  saveRecipientKeys,
  type RecipientKeyStore,
} from './recipient-keys.ts';

const suite = new TestSuite('T18d 接收方公钥目录自测', [
  '说明：本模块只管公钥目录；私钥的生成与保管属于密码设备职责，本系统不承担。',
  '最要紧的用例是 A5：不在曲线上的公钥必须被拒（否则加密会成功但没人解得开）。',
]);

const test = (name: string, fn: () => void | Promise<void>): Promise<void> => suite.test(name, fn);

const NOW = '2026-10-08T00:00:00Z';
const pairA = demoKeyPair('recipient-dir-a');
const pairB = demoKeyPair('recipient-dir-b');
const spkiOf = (publicKey: typeof pairA.publicKey): string => Buffer.from(publicKeyToSpki(publicKey)).toString('base64');

function expectError(run: () => unknown, keyword: string): string {
  let message = '';
  try {
    run();
  } catch (err) {
    message = (err as Error).message;
  }
  assert(message.includes(keyword), `应报错并提到"${keyword}"，实际：${message}`);
  return message;
}

async function main(): Promise<void> {

  await test('A1 PEM 导入：接受带头尾与换行的文本，指纹为 SM3(SPKI)', () => {
    const pem = exportRecipientPublicKey(spkiOf(pairA.publicKey), 'pem');
    assert(pem.startsWith('-----BEGIN PUBLIC KEY-----'), '导出应为标准 PEM 头');
    const parsed = parseRecipientPublicKey(pem);
    assertEqual(parsed.ok, true, `PEM 应能解析：${parsed.ok ? '' : parsed.reason}`);
    if (parsed.ok) {
      assertEqual(parsed.fingerprint.length, 64, '指纹应为 64 位十六进制（完整值，不截断）');
      assertEqual(parsed.spkiBase64, spkiOf(pairA.publicKey), '归一化后的 SPKI 应与原始一致');
    }
  });

  await test('A2 纯 base64（无 PEM 头）与带空格换行的 base64 同样可导入', () => {
    const base64 = spkiOf(pairA.publicKey);
    const plain = parseRecipientPublicKey(base64);
    assertEqual(plain.ok, true, `纯 base64 应能解析：${plain.ok ? '' : plain.reason}`);
    const spaced = parseRecipientPublicKey(base64.replace(/(.{20})/g, '$1\n  '));
    assertEqual(spaced.ok, true, '带换行与空格的 base64 应能解析（从聊天工具复制常见）');
    if (plain.ok && spaced.ok) assertEqual(plain.fingerprint, spaced.fingerprint, '两种写法应得到同一指纹');
  });

  await test('A3 空文本 / 非法 base64 → 各自独立错误码与可读原因', () => {
    assertEqual((parseRecipientPublicKey('   ') as { code?: string }).code, 'E_KEY_TEXT_EMPTY', '空文本');
    assertEqual((parseRecipientPublicKey('这不是base64!!!') as { code?: string }).code, 'E_KEY_BASE64_INVALID', '非 base64');
    assertEqual((parseRecipientPublicKey('QUJD') as { code?: string }).code, 'E_KEY_SPKI_INVALID', '长度不足应报 SPKI 结构问题');
  });

  await test('A4/A5 非法公钥必须被拒：不在曲线上的点要单独报码（否则加密成功却没人解得开）', () => {
    const der = new Uint8Array(Buffer.from(spkiOf(pairA.publicKey), 'base64'));
    const tampered = new Uint8Array(der);
    /* 改动 X 坐标的最后一个字节：结构仍然合法，但点已不在曲线上 */
    tampered[tampered.length - 33] = (tampered[tampered.length - 33]! ^ 0x01) & 0xff;
    const result = parseRecipientPublicKey(Buffer.from(tampered).toString('base64'));
    assertEqual(result.ok, false, '被改动的公钥不能通过');
    if (!result.ok) {
      assertEqual(result.code, 'E_KEY_NOT_ON_CURVE', '应单独报"不在曲线上"（与"结构非法"区分开）');
      assert(result.reason.includes('没有任何私钥能解开'), '原因要说明后果，否则用户会以为是格式挑剔');
    }

    /* 对照：未改动的同一份数据必须通过（证明拒绝的是"点不对"，不是"数据被改过"） */
    assertEqual(parseRecipientPublicKey(spkiOf(pairA.publicKey)).ok, true, '未改动时应通过');
  });

  await test('A6 不是 SM2 SPKI 结构 → E_KEY_SPKI_INVALID（不猜、不兜底）', () => {
    const der = new Uint8Array(Buffer.from(spkiOf(pairA.publicKey), 'base64'));
    const wrongMarker = new Uint8Array(der);
    wrongMarker[wrongMarker.length - 65] = 0x02;
    const result = parseRecipientPublicKey(Buffer.from(wrongMarker).toString('base64'));
    assertEqual(result.ok, false, '压缩点标记不应被接受（本实现只接受未压缩点）');
  });

  await test('B1 加入目录：keyId/指纹/label 正确；同一把钥匙重复导入被拒（指纹去重）', () => {
    const added = addRecipientKey(EMPTY_KEY_STORE, { label: '张医生', text: spkiOf(pairA.publicKey), now: NOW });
    assertEqual(added.ok, true, `应加入成功：${added.ok ? '' : added.reason}`);
    if (!added.ok) return;
    assert(added.key.keyId.startsWith('rk_'), 'keyId 应有可识别前缀');
    assertEqual(added.key.label, '张医生', '标签应保留');

    const again = addRecipientKey(added.store, { label: '张医生（副本）', text: spkiOf(pairA.publicKey), now: NOW });
    assertEqual(again.ok, false, '同一把钥匙不得重复');
    if (!again.ok) assertEqual(again.code, 'E_KEY_DUPLICATE', '应报重复（否则"选哪一行"会随顺序变化）');

    const other = addRecipientKey(added.store, { label: '会诊终端A', text: spkiOf(pairB.publicKey), now: NOW });
    assertEqual(other.ok, true, '不同的钥匙应能加入');
    if (other.ok) assertEqual(other.store.keys.length, 2, '目录应有两个接收方');
  });

  await test('B2 标签为空 / 删除不存在 / 查找：各自给明确结果', () => {
    const blank = addRecipientKey(EMPTY_KEY_STORE, { label: '  ', text: spkiOf(pairA.publicKey), now: NOW });
    assertEqual(blank.ok, false, '标签为空应被拒');
    if (!blank.ok) assertEqual(blank.code, 'E_KEY_LABEL_EMPTY', '应报标签为空');

    const added = addRecipientKey(EMPTY_KEY_STORE, { label: '李医生', text: spkiOf(pairA.publicKey), now: NOW });
    if (!added.ok) throw new Error('前置失败');
    assert(!!findRecipientKey(added.store, added.key.keyId), '应能按 keyId 找到');
    assertEqual(findRecipientKey(added.store, 'rk_not_exist'), undefined, '不存在应返回 undefined');

    const removed = removeRecipientKey(added.store, added.key.keyId);
    assertEqual(removed.ok, true, '删除应成功');
    assertEqual(removed.store.keys.length, 0, '删除后目录应空');
    const missing = removeRecipientKey(added.store, 'rk_not_exist');
    assertEqual(missing.ok, false, '删除不存在应失败');
    assert((missing.reason ?? '').includes('没有这个接收方'), '应说明原因');
  });

  await test('B3 条目被篡改（公钥与指纹对不上）→ 取公钥时必须抛错，不得拿来历不明的钥匙去加密', () => {
    const added = addRecipientKey(EMPTY_KEY_STORE, { label: '张医生', text: spkiOf(pairA.publicKey), now: NOW });
    if (!added.ok) throw new Error('前置失败');
    const forged = { ...added.key, spkiBase64: spkiOf(pairB.publicKey) };
    expectError(() => publicKeyOf(forged), '已被篡改');
  });

  await test('B4 导出 ↔ 再导入往返：指纹不变（线下交换的关键性质）', () => {
    const added = addRecipientKey(EMPTY_KEY_STORE, { label: '张医生', text: spkiOf(pairA.publicKey), now: NOW });
    if (!added.ok) throw new Error('前置失败');
    for (const format of ['pem', 'base64'] as const) {
      const exported = exportRecipientPublicKey(added.key.spkiBase64, format);
      const back = parseRecipientPublicKey(exported);
      assertEqual(back.ok, true, `${format} 导出应能再导入`);
      if (back.ok) assertEqual(back.fingerprint, added.key.fingerprint, `${format} 往返后指纹应不变`);
    }
  });

  const storePath = fileURLToPath(new URL('../../artifacts/recipient-keys-test.json', import.meta.url));

  await test('C1 保存 → 加载：内容一致（含中文标签与备注）', () => {
    const added = addRecipientKey(EMPTY_KEY_STORE, { label: '张医生', text: spkiOf(pairA.publicKey), note: '内科会诊', now: NOW });
    if (!added.ok) throw new Error('前置失败');
    saveRecipientKeys(storePath, added.store);
    const loaded = loadRecipientKeys(storePath);
    assertEqual(JSON.stringify(loaded), JSON.stringify(added.store), '落盘后再加载应完全一致');
    assertEqual(loaded.keys[0]?.label, '张医生', '中文标签应保真');
    assertEqual(loaded.keys[0]?.note, '内科会诊', '备注应保真');
    rmSync(storePath, { force: true });
  });

  await test('C2 文件不存在 = 空目录（首次使用是正常状态）；结构损坏 = 报错（不静默返回空）', () => {
    assertEqual(JSON.stringify(loadRecipientKeys(storePath)), JSON.stringify(EMPTY_KEY_STORE), '不存在的文件应返回空目录');

    saveRecipientKeys(storePath, EMPTY_KEY_STORE);
    const brokenPath = `${storePath}.broken.json`;
    saveRecipientKeys(brokenPath, EMPTY_KEY_STORE);
    writeFileSync(brokenPath, '{"version":2,"keys":[]}\n', 'utf8');
    expectError(() => loadRecipientKeys(brokenPath), '结构不符');
    rmSync(storePath, { force: true });
    rmSync(brokenPath, { force: true });
    assert(!existsSync(storePath), '测试文件应已清理');
  });

  await test('C3 **只存公钥**：落盘 JSON 里不得出现任何私钥相关键', () => {
    const added = addRecipientKey(EMPTY_KEY_STORE, { label: '张医生', text: spkiOf(pairA.publicKey), now: NOW });
    if (!added.ok) throw new Error('前置失败');
    const text = JSON.stringify(added.store);
    for (const forbidden of ['private', 'privateKey', 'pkcs8', 'scalar', '"d"']) {
      assert(!text.includes(forbidden), `落盘内容不得包含私钥相关键：${forbidden}`);
    }
    assert(text.includes('spkiBase64'), '应只存 SPKI 公钥');
  });

  await test('C4 闭环：用**目录里的公钥**加密交付 → 对应私钥解开（这才是真实用法）', () => {
    const added = addRecipientKey(EMPTY_KEY_STORE, { label: '张医生', text: spkiOf(pairA.publicKey), now: NOW });
    if (!added.ok) throw new Error('前置失败');
    const sealed = sealDocumentJson('{"docId":"doc_dir_test"}', {
      publicKey: publicKeyOf(added.key),
      fingerprint: added.key.fingerprint,
    });
    const opened = decryptEnvelopeWith(sealed.envelope, { privateKey: pairA.privateKey, fingerprint: added.key.fingerprint });
    assertEqual(opened.ok, true, `目录公钥加密后应能用对应私钥解开：${opened.ok ? '' : opened.reason}`);

    /* 反例：另一把私钥（指纹也不匹配）必须被拦 */
    const wrong = decryptEnvelopeWith(sealed.envelope, { privateKey: pairB.privateKey, fingerprint: added.key.fingerprint });
    assertEqual(wrong.ok, false, '别人的私钥不得解开');

    const direct = encryptEnvelopeFor(new Uint8Array([1, 2, 3]), { publicKey: publicKeyOf(added.key) });
    assertEqual(decryptEnvelopeWith(direct, { privateKey: pairA.privateKey, fingerprint: added.key.fingerprint }).ok, true, '直接加密也应可解');
  });

  process.exit(suite.report());
}

await main();
