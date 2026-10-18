// 预问诊接入凭据自测（A1~A6）。

import { TestSuite, assert, assertEqual } from '../testing/harness.ts';
import type { ConfigKv } from '../storage/config-kv.ts';
import {
  MIN_KEY_LENGTH,
  checkAccess,
  describeAccess,
  hashAccessKey,
  loadAccess,
  saveAccess,
  validateAccessKey,
  verifyAccessKey,
  type PrevisitAccessRecord,
} from './previsit-access.ts';

const suite = new TestSuite('预问诊接入凭据自测', [
  '说明：密钥只存哈希（连管理员也取不回原文）；"从没配过"与"已启用但没密钥"是两种状态，处置不同。',
]);

const test = (name: string, fn: () => void | Promise<void>): Promise<void> => suite.test(name, fn);

const NOW = '2026-10-17T03:00:00.000Z';
const KEY = 'Zx7Qp2Lm9Rt4Vb8Nc3Hf6Jd1Kw5Ys0Ag'; // 32 个字符：够长、无空白

/** 内存版配置层：`read` 与真实实现一样，没有就是 null  */
function memoryKv(): ConfigKv & { dump(): Record<string, unknown> } {
  const store = new Map<string, unknown>();
  return {
    read<T>(key: string): T | null {
      return store.has(key) ? (structuredClone(store.get(key)) as T) : null;
    },
    write(key: string, value: unknown): void {
      store.set(key, structuredClone(value));
    },
    remove(key: string): void {
      store.delete(key);
    },
    has(key: string): boolean {
      return store.has(key);
    },
    dump(): Record<string, unknown> {
      return Object.fromEntries(store);
    },
  };
}

async function main(): Promise<void> {
  await test('A1 哈希：盐独立（同密钥两次不同）、都能验过、错一位就验不过', () => {
    const first = hashAccessKey(KEY);
    const second = hashAccessKey(KEY);
    assert(first !== second, '同一条密钥两次哈希必须不同（盐独立）');
    assertEqual(verifyAccessKey(KEY, first), true, '第一条应验过');
    assertEqual(verifyAccessKey(KEY, second), true, '第二条也应验过（差异来自盐，不是存错了）');
    assertEqual(verifyAccessKey(`${KEY}x`, first), false, '错一位就验不过');
    assertEqual(verifyAccessKey(KEY, 'sha256$bad'), false, '格式坏的不猜，直接 false');
    assertEqual(verifyAccessKey(KEY, 'md5$xxxx$yyyy'), false, '算法不认识就不认');
  });

  await test('A2 密钥门槛：太短 / 太长 / 带空白都明说是哪一条', () => {
    const short = validateAccessKey('his123');
    assertEqual(short.ok, false, '太短应被拒');
    assertEqual((short as { code: string }).code, 'E_PREVISIT_KEY_TOO_SHORT', '要给专门的码');
    assert(
      (short as { message: string }).message.includes(String(MIN_KEY_LENGTH)),
      '错误里要写明下限是多少（否则对方只能猜）',
    );
    assertEqual((validateAccessKey(`${KEY} `.repeat(40)) as { ok: boolean }).ok, false, '太长应被拒');
    assertEqual((validateAccessKey(`${KEY} x`) as { ok: boolean }).ok, false, '带空白应被拒（请求头里会被截断）');
    assertEqual((validateAccessKey(KEY) as { ok: boolean }).ok, true, '合规的应通过');
  });

  await test('A3 保存三态：不传不改 / null 清除 / 字符串替换；enabled 缺省沿用', () => {
    const kv = memoryKv();
    const created = saveAccess(kv, { key: KEY }, 'admin', NOW);
    assertEqual(created.keyAction, 'set', '第一次是设新值');
    assertEqual(created.record.enabled, false, '没给 enabled 时默认关闭（默认开启但没有密钥＝装完就写不进来）');
    assertEqual(created.record.updatedBy, 'admin', '要记下谁改的');

    const untouched = saveAccess(kv, { enabled: true }, 'admin2', NOW);
    assertEqual(untouched.keyAction, 'unchanged', '不传 key 就保持原样');
    assert(untouched.record.keyHash !== null, '原密钥哈希还在');
    assertEqual(untouched.record.enabled, true, 'enabled 能单独改');

    const cleared = saveAccess(kv, { key: null }, 'admin3', NOW);
    assertEqual(cleared.keyAction, 'cleared', 'null 是清除');
    assertEqual(cleared.record.keyHash, null, '清掉之后没有哈希');
    assertEqual(cleared.record.enabled, true, '清除密钥不影响 enabled（由人显式改）');

    const again = saveAccess(kv, { key: null }, 'admin3', NOW);
    assertEqual(again.keyAction, 'unchanged', '本来就是空，再清一次不算"清除了什么"');
    /* 读回来的必须是最后一次写进去的那份（不是内存里留着的引用） */
    assertEqual(loadAccess(kv)?.updatedBy, 'admin3', '以库里的为准');
  });

  await test('A4 库里不得出现密钥原文（只存哈希）', () => {
    const kv = memoryKv();
    saveAccess(kv, { key: KEY, enabled: true }, 'admin', NOW);
    const dumped = JSON.stringify(kv.dump());
    assertEqual(dumped.includes(KEY), false, '配置行里不该有密钥原文');
    assertEqual(dumped.includes('sha256$'), true, '应有自描述的哈希串');
  });

  await test('A5 四种状态的措辞：不能把"没配过"说成"已经安全了"', () => {
    const never = describeAccess(null, 'open');
    assertEqual(never.effective, false, '从没配过当然不生效');
    assertEqual(never.note, '', '演示模式下不摆提示语（状态由徽标表达）');

    const strictNever = describeAccess(null, 'strict');
    assert(strictNever.note.includes('一律被拒'), '严格模式下要说清写入会被拒');

    const broken: PrevisitAccessRecord = { version: 1, enabled: true, keyHash: null, updatedAt: NOW, updatedBy: 'a' };
    assertEqual(describeAccess(broken, 'open').effective, false, '启用但没密钥不算生效');
    assert(describeAccess(broken, 'open').note.includes('配置不完整'), '要说清是配置不完整');

    const off: PrevisitAccessRecord = { version: 1, enabled: false, keyHash: hashAccessKey(KEY), updatedAt: NOW, updatedBy: 'a' };
    assert(describeAccess(off, 'open').note.includes('已关闭校验'), '显式关闭要说明白');

    const on: PrevisitAccessRecord = { version: 1, enabled: true, keyHash: hashAccessKey(KEY), updatedAt: NOW, updatedBy: 'a' };
    assertEqual(describeAccess(on, 'open').effective, true, '启用且有密钥才生效');
    assert(describeAccess(on, 'open').note.includes('X-Previsit-Key'), '要告诉对方该带哪个头');
  });

  await test('A6 准入判定：未配置看模式、关闭放行、启用后缺头/错钥都拒', () => {
    /* 从没配过：演示放行（并标注），严格拒绝 */
    assertEqual(checkAccess({ record: null, presentedKey: '', allowUnconfigured: true }).ok, true, '演示模式放行');
    assertEqual(
      (checkAccess({ record: null, presentedKey: '', allowUnconfigured: true }) as { mode: string }).mode,
      'unconfigured-demo',
      '放行时要标明"这是未配置"',
    );
    assertEqual(checkAccess({ record: null, presentedKey: '', allowUnconfigured: false }).ok, false, '严格模式拒绝');

    /* 显式关闭校验 */
    const off: PrevisitAccessRecord = { version: 1, enabled: false, keyHash: hashAccessKey(KEY), updatedAt: NOW, updatedBy: 'a' };
    assertEqual(checkAccess({ record: off, presentedKey: '', allowUnconfigured: false }).ok, true, '关闭校验时严格模式也放行（这是管理员的选择）');

    /* 启用 + 有密钥 */
    const on: PrevisitAccessRecord = { version: 1, enabled: true, keyHash: hashAccessKey(KEY), updatedAt: NOW, updatedBy: 'a' };
    assertEqual(checkAccess({ record: on, presentedKey: KEY, allowUnconfigured: false }).ok, true, '对得上就放行');
    const missing = checkAccess({ record: on, presentedKey: '', allowUnconfigured: true });
    assertEqual(missing.ok, false, '没带口令必须拒（连演示模式也不放）');
    assertEqual((missing as { code: string }).code, 'E_PREVISIT_AUTH_REQUIRED', '要报"缺少口令"，而不是笼统的"无权限"');
    const wrong = checkAccess({ record: on, presentedKey: 'not-the-key-at-all-000000', allowUnconfigured: true });
    assertEqual(wrong.ok, false, '错钥必须拒');
    assertEqual((wrong as { code: string }).code, 'E_PREVISIT_AUTH_BAD_KEY', '要说"不对"');

    /* 启用 + 没密钥：这是配置不完整，不是"没上锁" */
    const broken: PrevisitAccessRecord = { version: 1, enabled: true, keyHash: null, updatedAt: NOW, updatedBy: 'a' };
    const brokenCheck = checkAccess({ record: broken, presentedKey: '', allowUnconfigured: true });
    assertEqual(brokenCheck.ok, false, '启用但没密钥：演示模式也不放行');
    assertEqual((brokenCheck as { code: string }).code, 'E_PREVISIT_AUTH_UNCONFIGURED', '要报"配置不完整"');
  });

  process.exit(suite.report());
}

void main();
