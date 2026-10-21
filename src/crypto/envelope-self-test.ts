import { createCipheriv, createHmac } from 'node:crypto';
import { TestSuite, assert, assertEqual } from '../testing/harness.ts';
import { fromHex, sm3, toHex, utf8 } from './sm3.ts';
import { SM4_IV_LENGTH, assertSm4, sm4Availability, sm4Ctr, sm4EcbEncryptBlock, sm4SelfCheck } from './sm4.ts';
import { DEFAULT_PBKDF2_ITERATIONS, hmacSm3, passphraseBytes, pbkdf2HmacSm3, sm3Kdf } from './kdf.ts';
import { encryptEnvelope, decryptEnvelope, ENVELOPE_SUITE, type DecryptResult, type Envelope } from './envelope.ts';

const suite = new TestSuite('T18b 认证加密信封（SM4-CTR + HMAC-SM3）自测', [
  '说明：SM4 由运行时 OpenSSL 提供（自研尝试已失败并记录在 sm4.ts），因此第一条用例就是国标向量自检。',
  '信封采用 Encrypt-then-MAC，且头部进 MAC —— 篡改 IV/套件/KDF 参数同样会被拦住。',
]);

const test = (name: string, fn: () => void | Promise<void>): Promise<void> => suite.test(name, fn);

const ITER = 1_000; // 测试用小迭代数；默认值由 C13 守住
const PHRASE = '归档口令-2026#门诊';

const codeOf = (result: DecryptResult): string => (result.ok ? 'OK' : result.code);
const reasonOf = (result: DecryptResult): string => (result.ok ? '' : result.reason);

const bytesOf = (base64: string): Uint8Array => new Uint8Array(Buffer.from(base64, 'base64'));
const base64Of = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

/** 翻转某字节的第 0 位：用于篡改检测的用例（写成函数，避免散落的位运算写法） */
function flipByte(bytes: Uint8Array, index: number, mask = 0x01): Uint8Array {
  const copy = new Uint8Array(bytes);
  const value = copy[index] ?? 0;
  copy.set([(value ^ mask) & 0xff], index);
  return copy;
}

function clone(envelope: Envelope): Envelope {
  return JSON.parse(JSON.stringify(envelope)) as Envelope;
}

function expectError(run: () => unknown, keyword: string): void {
  let message = '';
  try {
    run();
  } catch (err) {
    message = (err as Error).message;
  }
  assert(message.includes(keyword), `应报错并提到"${keyword}"，实际：${message}`);
}

async function main(): Promise<void> {

  await test('A1 国标示例向量：判定运行时给的是不是 SM4（key=明文=0123…3210 → 681edf34…）', () => {
    const check = sm4SelfCheck();
    assertEqual(check.ok, true, `国标向量必须一致：${check.detail}`);
    assert(check.detail.includes('681edf34d206965e86b3e94f536e4246'), '应给出向量值便于核对');
  });

  await test('A2 能力探测：可用时列出算法，缺失时必须显式失败（不允许静默降级成不加密）', () => {
    const availability = sm4Availability();
    assertEqual(availability.ok, true, `本环境应具备 SM4：${availability.reason ?? ''}`);
    assert(availability.ciphers.includes('sm4-ctr'), `应列出 sm4-ctr，实际 ${availability.ciphers.join(',')}`);
    assertSm4();
  });

  await test('A3 ECB 单块与 OpenSSL 逐字节一致（验证封装参数：免填充、块长）', () => {
    let same = 0;
    for (let i = 0; i < 24; i += 1) {
      const key = fromHex(toHex(new Uint8Array(16).map((_, j) => (i * 7 + j * 13) % 256)));
      const block = fromHex(toHex(new Uint8Array(16).map((_, j) => (i * 31 + j * 17) % 256)));
      const cipher = createCipheriv('sm4-ecb', key, null);
      cipher.setAutoPadding(false);
      const reference = Buffer.concat([cipher.update(block), cipher.final()]).toString('hex');
      if (toHex(sm4EcbEncryptBlock(key, block)) === reference) same += 1;
    }
    assertEqual(same, 24, 'ECB 单块应与 OpenSSL 完全一致');
  });

  await test('A4 CTR 与 OpenSSL 逐字节一致（含非整块长度：验证"关填充"确实生效）', () => {
    const lengths = [1, 15, 16, 17, 33, 256, 1000];
    let same = 0;
    let total = 0;
    for (const length of lengths) {
      for (let i = 0; i < 3; i += 1) {
        const key = fromHex(toHex(new Uint8Array(16).map((_, j) => (i * 11 + j * 3) % 256)));
        const iv = fromHex(toHex(new Uint8Array(16).map((_, j) => (i * 5 + j * 29) % 256)));
        const data = new Uint8Array(length).map((_, j) => (i * 41 + j * 7) % 256);
        const cipher = createCipheriv('sm4-ctr', key, iv);
        cipher.setAutoPadding(false);
        const reference = Buffer.concat([cipher.update(data), cipher.final()]).toString('hex');
        total += 1;
        if (toHex(sm4Ctr(key, iv, data)) === reference) same += 1;
      }
    }
    assertEqual(same, total, `CTR 应与 OpenSSL 完全一致（${same}/${total}）`);
  });

  await test('A5 参数非法必须报错：密钥/IV/分组长度不对时不得"补零继续算"', () => {
    expectError(() => sm4EcbEncryptBlock(new Uint8Array(15), new Uint8Array(16)), '16 字节');
    expectError(() => sm4EcbEncryptBlock(new Uint8Array(16), new Uint8Array(8)), '16 字节');
    expectError(() => sm4Ctr(new Uint8Array(16), new Uint8Array(8), new Uint8Array(4)), 'IV');
  });

  await test('B1 HMAC-SM3 与 OpenSSL 一致（多组密钥/数据）', () => {
    let same = 0;
    for (let i = 0; i < 16; i += 1) {
      const key = utf8(`key-${i}`);
      const data = utf8(`data-${i}-${'x'.repeat(i * 7)}`);
      const reference = toHex(new Uint8Array(createHmac('sm3', key).update(data).digest()));
      if (toHex(hmacSm3(key, data)) === reference) same += 1;
    }
    assertEqual(same, 16, 'HMAC-SM3 应与 OpenSSL 完全一致');
  });

  await test('B2 PBKDF2 确定性 + 长度语义（前 N 字节应是长结果的前缀）', () => {
    const salt = utf8('salt-固定值');
    const a = pbkdf2HmacSm3(utf8('pw'), salt, ITER, 48);
    const b = pbkdf2HmacSm3(utf8('pw'), salt, ITER, 48);
    const c = pbkdf2HmacSm3(utf8('pw'), salt, ITER, 32);
    assertEqual(toHex(a), toHex(b), '同参数必须同结果（否则加密不可复现）');
    assertEqual(toHex(c), toHex(a.subarray(0, 32)), '短长度的结果应是长结果的前缀（PBKDF2 的块结构）');
    assertEqual(a.length, 48, '输出长度应按要求');
  });

  await test('B3 改一个参数结果必变：salt / 迭代次数 / 口令', () => {
    const base = toHex(pbkdf2HmacSm3(utf8('pw'), utf8('salt'), ITER, 32));
    assert(base !== toHex(pbkdf2HmacSm3(utf8('pw'), utf8('salt2'), ITER, 32)), 'salt 变化必须改变结果');
    assert(base !== toHex(pbkdf2HmacSm3(utf8('pw'), utf8('salt'), ITER + 1, 32)), '迭代次数变化必须改变结果');
    assert(base !== toHex(pbkdf2HmacSm3(utf8('pw2'), utf8('salt'), ITER, 32)), '口令变化必须改变结果');
  });

  await test('B4 KDF 参数非法必须报错（迭代 0 / 长度 0 / 空口令）', () => {
    expectError(() => pbkdf2HmacSm3(utf8('pw'), utf8('salt'), 0, 32), '迭代次数');
    expectError(() => pbkdf2HmacSm3(utf8('pw'), utf8('salt'), ITER, 0), '输出长度');
    expectError(() => passphraseBytes(''), '口令不能为空');
    expectError(() => sm3Kdf(utf8('z'), 0), '输出长度');
  });

  await test('B5 SM3-KDF：确定性 + 长度语义（无公开向量，靠性质验证并如实说明）', () => {
    const z = utf8('共享秘密');
    const long = sm3Kdf(z, 64);
    assertEqual(toHex(sm3Kdf(z, 64)), toHex(long), '同输入必须同结果');
    assertEqual(toHex(sm3Kdf(z, 32)), toHex(long.subarray(0, 32)), '32 字节结果应是 64 字节结果的前缀');
    assert(toHex(sm3Kdf(z, 32)) !== toHex(sm3Kdf(utf8('另一个'), 32)), '不同输入必须不同结果');
  });

  await test('C1 往返：中文 / 空 / 二进制都能原样还原', () => {
    const cases: Uint8Array[] = [
      utf8('病历归档件内容：SM4-CTR + HMAC-SM3 认证加密。'),
      new Uint8Array(0),
      new Uint8Array(Array.from({ length: 1000 }, (_, i) => i % 256)),
    ];
    for (const plaintext of cases) {
      const envelope = encryptEnvelope(plaintext, { passphrase: PHRASE, iterations: ITER });
      const result = decryptEnvelope(envelope, PHRASE);
      assertEqual(result.ok, true, `解密应成功：${reasonOf(result)}`);
      assertEqual(toHex(result.ok ? result.plaintext : new Uint8Array(0)), toHex(plaintext), '明文应逐字节一致');
    }
  });

  await test('C2 确实是密文：密文不含明文，头部套件与长度正确', () => {
    const plaintext = utf8('这段明文绝不应该出现在密文里：胸痛3天');
    const envelope = encryptEnvelope(plaintext, { passphrase: PHRASE, iterations: ITER });
    assertEqual(envelope.header.suite, ENVELOPE_SUITE, '套件应写死为 SM4-CTR-HMAC-SM3');
    assertEqual(envelope.header.plaintextLength, plaintext.length, '应记录明文长度');
    const cipherHex = toHex(bytesOf(envelope.ciphertext));
    assert(!cipherHex.includes(toHex(plaintext)), '密文不得原样包含明文');
    assert(!envelope.ciphertext.includes(base64Of(plaintext).slice(0, 12)), '密文不得包含明文片段');
  });

  await test('C3 篡改密文 1 字节 → MAC 失败（必须拒绝，且不解密）', () => {
    const envelope = encryptEnvelope(utf8('内容'), { passphrase: PHRASE, iterations: ITER });
    const tampered = clone(envelope);
    tampered.ciphertext = base64Of(flipByte(bytesOf(envelope.ciphertext), 0));
    const result = decryptEnvelope(tampered, PHRASE);
    assertEqual(codeOf(result), 'E_ENVELOPE_MAC_MISMATCH', '被篡改的密文必须拒绝');
  });

  await test('C4 篡改 IV（在头部）→ 同样被 MAC 拦住（头部进 MAC 的意义）', () => {
    const envelope = encryptEnvelope(utf8('内容'), { passphrase: PHRASE, iterations: ITER });
    const tampered = clone(envelope);
    tampered.header.iv = base64Of(flipByte(bytesOf(envelope.header.iv), 0, 0x80));
    assertEqual(codeOf(decryptEnvelope(tampered, PHRASE)), 'E_ENVELOPE_MAC_MISMATCH', '改 IV 必须被拦');
  });

  await test('C5 篡改 KDF 参数（迭代次数/salt）→ 被 MAC 拦住', () => {
    const envelope = encryptEnvelope(utf8('内容'), { passphrase: PHRASE, iterations: ITER });
    const lowerIterations = clone(envelope);
    const lowerKdf = lowerIterations.header.kdf;
    if (lowerKdf.algorithm !== 'PBKDF2-HMAC-SM3') throw new Error('前置：应为口令信封');
    lowerKdf.iterations = 1;
    assertEqual(codeOf(decryptEnvelope(lowerIterations, PHRASE)), 'E_ENVELOPE_MAC_MISMATCH', '降低迭代次数必须被拦');

    const otherSalt = clone(envelope);
    const saltKdf = otherSalt.header.kdf;
    if (saltKdf.algorithm !== 'PBKDF2-HMAC-SM3') throw new Error('前置：应为口令信封');
    saltKdf.salt = base64Of(new Uint8Array(16).fill(7));
    assertEqual(codeOf(decryptEnvelope(otherSalt, PHRASE)), 'E_ENVELOPE_MAC_MISMATCH', '改 salt 必须被拦');
  });

  await test('C6 篡改明文摘要/长度 → 被 MAC 拦住（摘要本身也是被保护字段）', () => {
    const envelope = encryptEnvelope(utf8('内容'), { passphrase: PHRASE, iterations: ITER });
    const digest = clone(envelope);
    digest.header.plaintextDigest = '0'.repeat(64);
    assertEqual(codeOf(decryptEnvelope(digest, PHRASE)), 'E_ENVELOPE_MAC_MISMATCH', '改摘要必须被拦');

    const length = clone(envelope);
    length.header.plaintextLength = 9999;
    assertEqual(codeOf(decryptEnvelope(length, PHRASE)), 'E_ENVELOPE_MAC_MISMATCH', '改长度必须被拦');
  });

  await test('C7 套件/版本不支持 → 明确拒绝（防"降级成不加密"类攻击）', () => {
    const envelope = encryptEnvelope(utf8('内容'), { passphrase: PHRASE, iterations: ITER });
    const downgraded = clone(envelope) as unknown as Envelope;
    (downgraded.header as unknown as { suite: string }).suite = 'PLAINTEXT';
    const result = decryptEnvelope(downgraded, PHRASE);
    assertEqual(codeOf(result), 'E_ENVELOPE_UNSUPPORTED', '不认识的套件必须明确拒绝，而不是当成明文放行');
    assert(reasonOf(result).includes('PLAINTEXT'), '拒绝原因应包含被拒绝的套件名');
  });

  await test('C8 错误口令 → MAC 失败；提示需如实说明"口令错与篡改不可区分"', () => {
    const envelope = encryptEnvelope(utf8('内容'), { passphrase: PHRASE, iterations: ITER });
    const result = decryptEnvelope(envelope, '错误口令');
    assertEqual(codeOf(result), 'E_ENVELOPE_MAC_MISMATCH', '错误口令应走同一条拒绝路径');
    assert(reasonOf(result).includes('无法区分'), '应如实说明两者在密码学上不可区分');
  });

  await test('C9 截断密文 → 被 MAC 拦住（长度变化也属于篡改）', () => {
    const envelope = encryptEnvelope(utf8('这是一段足够长的内容，用于测试截断'), { passphrase: PHRASE, iterations: ITER });
    const truncated = clone(envelope);
    const bytes = bytesOf(envelope.ciphertext);
    truncated.ciphertext = base64Of(bytes.subarray(0, bytes.length - 4));
    assertEqual(codeOf(decryptEnvelope(truncated, PHRASE)), 'E_ENVELOPE_MAC_MISMATCH', '截断必须被拦');
  });

  await test('C10 随机 IV：同一明文两次加密的 IV 与密文都不同（IV 复用是 CTR 的死穴）', () => {
    const plaintext = utf8('同一段内容');
    const first = encryptEnvelope(plaintext, { passphrase: PHRASE, iterations: ITER });
    const second = encryptEnvelope(plaintext, { passphrase: PHRASE, iterations: ITER });
    assert(first.header.iv !== second.header.iv, '两次加密的 IV 必须不同');
    assert(first.ciphertext !== second.ciphertext, '两次加密的密文必须不同');
    assertEqual(bytesOf(first.header.iv).length, SM4_IV_LENGTH, 'IV 长度应为 16 字节');
  });

  await test('C11 指定 salt/IV 时结果可复现（供审计复算与测试）', () => {
    const options = { passphrase: PHRASE, iterations: ITER, salt: utf8('0123456789abcdef'), iv: utf8('fedcba9876543210') };
    assertEqual(
      JSON.stringify(encryptEnvelope(utf8('可复现'), options)),
      JSON.stringify(encryptEnvelope(utf8('可复现'), options)),
      '同 salt/IV/口令 → 同信封',
    );
  });

  await test('C12 大输入往返（512KB）不改内容', () => {
    const plaintext = new Uint8Array(512 * 1024).map((_, i) => (i * 31) % 256);
    const result = decryptEnvelope(encryptEnvelope(plaintext, { passphrase: PHRASE, iterations: ITER }), PHRASE);
    assertEqual(result.ok, true, `大输入解密应成功：${reasonOf(result)}`);
    assertEqual(toHex(sm3(result.ok ? result.plaintext : new Uint8Array(0))), toHex(sm3(plaintext)), '摘要应一致');
  });

  await test('C13 默认迭代次数不得低于 10 万（守住"为了跑得快把默认调低"）', () => {
    assert(DEFAULT_PBKDF2_ITERATIONS >= 100_000, `默认迭代次数过低：${DEFAULT_PBKDF2_ITERATIONS}`);
    const envelope = encryptEnvelope(utf8('x'), { passphrase: PHRASE, iterations: ITER });
    const kdf = envelope.header.kdf;
    assertEqual(kdf.algorithm === 'PBKDF2-HMAC-SM3' ? kdf.iterations : -1, ITER, '显式传入的迭代次数应写进头部（否则无法复算）');
  });

  await test('C14 结构不完整 → 明确报错（缺 ciphertext / 缺 header）', () => {
    const envelope = encryptEnvelope(utf8('内容'), { passphrase: PHRASE, iterations: ITER });
    const noCipher = { header: envelope.header } as unknown as Envelope;
    const noHeader = { ciphertext: envelope.ciphertext } as unknown as Envelope;
    assertEqual(codeOf(decryptEnvelope(noCipher, PHRASE)), 'E_ENVELOPE_MALFORMED', '缺 ciphertext 应报结构错误');
    assertEqual(codeOf(decryptEnvelope(noHeader, PHRASE)), 'E_ENVELOPE_MALFORMED', '缺 header 应报结构错误');
  });

  process.exit(suite.report());
}

await main();
