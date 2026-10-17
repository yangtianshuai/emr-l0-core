/**
 * 电子签名后端（配置 + 远程适配器）自测。
 *
 *   node src/sign/sign-self-test.ts
 *
 * 锁死六件事：
 *   S1 配置校验：fail-closed（选了 http 没地址必须报错）、非法数值不取默认、指纹格式；
 *   S2 请求构造：**声明式映射**真的生效（字段名 / 编码 / 附加字段 / 认证头）；
 *   S3 响应解析：JSON 路径（含数组）、编码、公钥/证书；
 *   S4 失败一律 fail-closed：非 2xx / 超时 / 非法 JSON / 缺签名值；
 *   S5 测试签名：**自验** + 指纹核对（匹配 / 不匹配 / 尚未固定）；
 *   S6 配置存储：落库、**密钥单独一行加密入库且永不回显**、undefined 不改 / null 清除（真删行）、损坏不静默。
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TestSuite, assert, assertEqual } from '../testing/harness.ts';
import { softwareSigner, softwareVerifier, demoKeyPair } from '../crypto/provider.ts';
import { toBase64, fromBase64 } from '../crypto/signature.ts';
import { utf8 } from '../crypto/sm3.ts';
import { publicKeyFingerprint, publicKeyFromSpki } from '../crypto/sm2.ts';
import {
  SignConfigError,
  isFingerprint,
  isSignConfigured,
  missingSignConfig,
  validateSignConfig,
  type HttpSignConfig,
  type SignBackendConfig,
  type SignConfigInput,
} from './sign-config.ts';
import {
  RemoteSignError,
  TEST_SIGN_MESSAGE,
  createHttpSigner,
  createRemoteSigner,
  readJsonPath,
  testSign,
  type SignTransport,
} from './remote-signer.ts';
import { SIGN_API_KEY_KEY, SIGN_CONFIG_KEY, loadSignConfig, saveSignConfig } from './sign-config-store.ts';
import { openConfigFixture, sealedBlobOf, writeCorruptRow } from '../testing/config-fixture.ts';

/* 本环境的 node:fs 类型声明不完整（缺 mkdtempSync / rmSync 的 recursive），局部断言（同 demo-server） */
const fsx = (await import('node:fs')) as unknown as {
  mkdtempSync: (prefix: string) => string;
  rmSync: (path: string, options?: { recursive?: boolean; force?: boolean }) => void;
};
const osx = (await import('node:os')) as unknown as { tmpdir: () => string };

const suite = new TestSuite('电子签名后端（配置 + 远程适配器）自测', [
  '说明：签名后端是**部署参数**。换医院只应"填映射"，不应改代码；而"接不上"必须报错，绝不能悄悄退回软件签名。',
  'S1/S4 是防回退关键：静默降级与"没有产出当成签好了"，是这块最危险的两类失败。',
]);

const test = (name: string, fn: () => void | Promise<void>): Promise<void> => suite.test(name, fn);

function codeOf(fn: () => unknown): string {
  try {
    fn();
    return 'OK';
  } catch (err) {
    return (err as { code?: string }).code ?? `UNEXPECTED:${(err as Error).message}`;
  }
}

async function asyncCodeOf(fn: () => unknown | Promise<unknown>): Promise<string> {
  try {
    await fn();
    return 'OK';
  } catch (err) {
    return (err as { code?: string }).code ?? `UNEXPECTED:${(err as Error).message}`;
  }
}

/** 默认给一份"自洽可跑"的签名服务配置，各用例只覆盖自己关心的那几项 */
function httpConfig(patch: SignConfigInput = {}, httpPatch: Partial<HttpSignConfig> = {}): SignBackendConfig {
  return validateSignConfig({
    http: {
      endpoint: 'http://sign.test/sign',
      request: { toSignField: 'toSign', toSignEncoding: 'base64' },
      response: { signaturePath: 'signature', signatureEncoding: 'base64', publicKeyPath: 'publicKey' },
      ...httpPatch,
    },
    ...patch,
  });
}

/* 一台"假签名服务"：用自研 SM2 签一次 —— 这样自验才有意义（能验过，才是真的对） */
const realSigner = softwareSigner(demoKeyPair('l0-sign-self-test').privateKey);
const realPublicKeyBase64 = toBase64(realSigner.publicKeyDer);
const realFingerprint = publicKeyFingerprint(publicKeyFromSpki(fromBase64(realPublicKeyBase64)));
const realSignatureBase64 = toBase64(realSigner.sign(utf8(TEST_SIGN_MESSAGE)));

async function main(): Promise<void> {
  await test('S1 配置校验：默认"未配置"、非法值不取默认、指纹格式', () => {
    /* **没有"内置软件签名"这一档**：默认就是"未配置"，而未配置 = 签不了章 */
    assertEqual(validateSignConfig({}).http, undefined, '默认没有签名服务');
    assertEqual(isSignConfigured(validateSignConfig({})), false, '默认不足以签章');
    assert(missingSignConfig(validateSignConfig({})).includes('服务地址'), '应指出缺服务地址');

    /* 给了 http 段却没地址 / 地址是空白：都必须报错（不能存下一份"配了个空的"） */
    assertEqual(
      codeOf(() => validateSignConfig({ http: { endpoint: '  ' } })),
      'E_SIGN_CONFIG_NO_ENDPOINT',
      '地址为空应报错',
    );
    assertEqual(
      codeOf(() => validateSignConfig({ http: { endpoint: 'http://x/sign', timeoutMs: -1 } })),
      'E_SIGN_CONFIG_INVALID',
      '非法超时应报错（不静默取默认）',
    );
    assertEqual(
      codeOf(() => validateSignConfig({ expectedFingerprint: 'abc' })),
      'E_SIGN_CONFIG_BAD_FINGERPRINT',
      '指纹必须是 64 位十六进制',
    );
    assert(isFingerprint(realFingerprint), '真实指纹应通过格式校验');
    assertEqual(
      codeOf(() => validateSignConfig({ publicKeyBase64: 'not-a-key' })),
      'E_SIGN_CONFIG_INVALID',
      '预置公钥解不开应在**保存时**就报错（而不是等到签章那一刻）',
    );
    /* 既无预置公钥、又无响应公钥路径：拿不到身份，构造不出 SignedInfo */
    assertEqual(
      codeOf(() => httpConfig({}, { response: { signaturePath: 'signature', signatureEncoding: 'base64' } })),
      'E_SIGN_CONFIG_INVALID',
      '配了服务就必须能拿到公钥（预置或响应路径）',
    );
    assertEqual(httpConfig().http?.endpoint, 'http://sign.test/sign', '合法配置应通过并保留地址');
  });

  await test('S2 请求构造：声明式映射生效（字段名 / 编码 / 附加字段 / 认证头）', async () => {
    const seen: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
    const config = httpConfig(
      {},
      {
        auth: { headerName: 'Authorization', scheme: 'Bearer ' },
        keyId: 'seal-01',
        request: {
          toSignField: 'data.content',
          toSignEncoding: 'hex',
          digestField: 'data.digest',
          algorithmField: 'data.alg',
          keyIdField: 'data.keyId',
          extra: { appId: 'emr' },
        },
      },
    );
    const signer = createHttpSigner(config.http as HttpSignConfig, {
      /* 密钥**只从参数来**（真实链路里由调用方从库中解出后递进来，见 S6） */
      apiKey: 'secret-value',
      transport: async (request) => {
        seen.push({ url: request.url, headers: request.headers, body: JSON.parse(request.body) as Record<string, unknown> });
        return { status: 200, body: JSON.stringify({ signature: realSignatureBase64, publicKey: realPublicKeyBase64 }) };
      },
    });
    await signer.signMessage(utf8('abc'));

    assertEqual(seen.length, 1, '应发出一次请求');
    const sent = seen[0] as { url: string; headers: Record<string, string>; body: Record<string, unknown> };
    assertEqual(sent.url, 'http://sign.test/sign', '应打到配置的服务地址');
    assertEqual(sent.headers.Authorization, 'Bearer secret-value', '认证头应按 scheme + 传入的密钥拼出');
    assertEqual(sent.body.appId, 'emr', '附加字段应带上');
    assertEqual((sent.body.data as Record<string, unknown>).content, '616263', 'toSign 应按 hex 编码（abc → 616263）');
    assertEqual((sent.body.data as Record<string, unknown>).alg, 'SM2-SM3', '算法字段应填上');
    assertEqual((sent.body.data as Record<string, unknown>).keyId, 'seal-01', 'keyId 应填上');
    assert(
      typeof (sent.body.data as Record<string, unknown>).digest === 'string',
      '配了 digestField 时应带摘要',
    );
  });

  await test('S3 响应解析：JSON 路径（含数组）、编码、公钥与证书', async () => {
    assertEqual(readJsonPath({ a: { b: 1 } }, 'a.b'), 1, '点路径');
    assertEqual(readJsonPath({ a: [{ b: 2 }] }, 'a[0].b'), 2, '数组下标');
    assertEqual(readJsonPath({ a: 1 }, 'a.b.c'), undefined, '取不到返回 undefined（不抛错）');

    const config = httpConfig(
      {},
      {
        response: {
          signaturePath: 'result.list[0].sigValue',
          signatureEncoding: 'hex',
          publicKeyPath: 'result.pub',
          certificateChainPath: 'result.chain',
        },
      },
    );
    const hexSignature = realSignatureBase64 === '' ? '' : Buffer.from(fromBase64(realSignatureBase64)).toString('hex');
    const signer = createHttpSigner(config.http as HttpSignConfig, {
      transport: async () => ({
        status: 200,
        body: JSON.stringify({
          result: {
            list: [{ sigValue: hexSignature }],
            pub: realPublicKeyBase64,
            chain: ['cert-a', 'cert-b'],
          },
        }),
      }),
    });
    const result = await signer.signMessage(utf8(TEST_SIGN_MESSAGE));
    assertEqual(toBase64(result.signature), realSignatureBase64, 'hex 签名值应被解回同样的字节');
    assertEqual(result.publicKeyBase64, realPublicKeyBase64, '公钥应被取出');
    assertEqual(result.certificates, ['cert-a', 'cert-b'], '证书链应被取出');
  });

  await test('S4 失败一律 fail-closed：非 2xx / 超时 / 非法 JSON / 缺签名值', async () => {
    const call = (options: { transport: SignTransport }) =>
      createHttpSigner(httpConfig().http as HttpSignConfig, options).signMessage(utf8('probe'));

    assertEqual(
      await asyncCodeOf(() => call({ transport: async () => ({ status: 503, body: 'busy' }) })),
      'E_SIGN_HTTP_STATUS',
      '非 2xx 应报错（错误信息不带响应体）',
    );
    assertEqual(
      await asyncCodeOf(() => call({ transport: async () => ({ status: 200, body: '不是 JSON' }) })),
      'E_SIGN_BAD_JSON',
      '非法 JSON 应报错',
    );
    assertEqual(
      await asyncCodeOf(() => call({ transport: async () => ({ status: 200, body: '{"ok":true}' }) })),
      'E_SIGN_NO_SIGNATURE',
      '取不到签名值应报错 —— 不把"没有产出"当成"签好了"',
    );
    /* 超时：transport 永不返回且不理会 abort，必须靠 race 兜住 */
    const timeout = httpConfig({}, { timeoutMs: 30 });
    assertEqual(
      await asyncCodeOf(() =>
        createHttpSigner(timeout.http as HttpSignConfig, { transport: () => new Promise<never>(() => {}) }).signMessage(utf8('probe')),
      ),
      'E_SIGN_TIMEOUT',
      '超时必须被中止',
    );
  });

  await test('S5 测试签名：自验通过 + 指纹核对（匹配 / 不匹配 / 未固定）', async () => {
    const transport = async () => ({
      status: 200,
      body: JSON.stringify({ signature: realSignatureBase64, publicKey: realPublicKeyBase64 }),
    });

    /* ① 未固定指纹：允许测试，但必须提示"尚未固定" */
    const unfixed = await testSign(httpConfig(), { transport });
    assertEqual(unfixed.selfVerified, true, '自验应通过（这把钥确实能验这条签名）');
    assertEqual(unfixed.fingerprintMatches, null, '未固定指纹时应为 null');
    assertEqual(unfixed.actualFingerprint, realFingerprint, '应报出实际指纹，供管理员固定');
    assert(unfixed.notes.some((note) => note.includes('尚未固定')), `应提示指纹尚未固定，实际：${unfixed.notes.join(' | ')}`);
    assertEqual(unfixed.certificateCount, 0, '未配证书路径时证书张数为 0');

    /* ② 期望指纹与实际的相符：核对通过 */
    const matched = await testSign(httpConfig({ expectedFingerprint: realFingerprint }), { transport });
    assertEqual(matched.fingerprintMatches, true, '指纹一致应通过核对');

    /* ③ 指纹不符：必须报出**不一致**（这是"连错环境 / 换了把钥"的唯一线索） */
    const other = softwareSigner(demoKeyPair('another-key').privateKey);
    const mismatch = await testSign(httpConfig({ expectedFingerprint: publicKeyFingerprint(other.publicKey) }), { transport });
    assertEqual(mismatch.fingerprintMatches, false, '指纹不符应判为 false');
    assert(mismatch.notes.some((note) => note.includes('不一致')), `应说明指纹不一致，实际：${mismatch.notes.join(' | ')}`);

    /* ④ 服务返回的签名值验不过：必须说出来，而不是只报"服务返回 200" */
    const bogus = await testSign(httpConfig(), {
      transport: async () => ({
        status: 200,
        body: JSON.stringify({ signature: toBase64(utf8('not-a-signature')), publicKey: realPublicKeyBase64 }),
      }),
    });
    assertEqual(bogus.selfVerified, false, '签名值验不过应判为 false');
    assert(bogus.notes.some((note) => note.includes('未能用该公钥验过')), '应指出签名值验不过');
  });

  await test('S6 配置存储：落库、密钥单独一行加密入库且永不回显、undefined 不改 / null 清除（真删行）', () => {
    const fixture = openConfigFixture({ prefix: 'l0-sign-' });
    const kv = fixture.kv;
    const signInput = (endpoint: string, patch: SignConfigInput = {}): SignConfigInput => ({
      ...httpConfig({ expectedFingerprint: realFingerprint, ...patch }, { endpoint }),
    });
    try {
      assertEqual(loadSignConfig(kv).source, 'default', '没配过应为 default');
      assertEqual(isSignConfigured(loadSignConfig(kv).config), false, '没配过 = 不足以签章（不是"默认用软件签名"）');
      assertEqual(loadSignConfig(kv).apiKeyPresent, false, '没配过时密钥不就位');

      /* ① 设置密钥：配置与密钥**分两行**落库，密钥在内存里可取到供适配器用，界面只据此显示"是否就位" */
      const saved = saveSignConfig(
        kv,
        { ...signInput('http://emr-sign.test/api/sign'), apiKey: 'sk-sign-secret-1' },
        'ADMIN',
      );
      assertEqual(saved.loaded.source, 'store', '保存后来源应为配置界面');
      assertEqual(saved.apiKeyAction, 'set', '给了密钥应记为 set（只记动作，不记值）');
      const reloaded = loadSignConfig(kv);
      assertEqual(reloaded.config.http?.endpoint, 'http://emr-sign.test/api/sign', '地址应持久化');
      assertEqual(reloaded.config.expectedFingerprint, realFingerprint, '期望指纹应持久化');
      assertEqual(reloaded.apiKey, 'sk-sign-secret-1', '内存里应能取到密钥（供适配器使用，绝不回显）');
      assertEqual(reloaded.apiKeyPresent, true, '界面只据此判断"密钥是否就位"');
      /* 直接看库里那一行的密文：明文不得落库（不听服务端自报"已加密"） */
      const sealed = sealedBlobOf(fixture, SIGN_API_KEY_KEY);
      assert(sealed !== null, '密钥应单独占一行落库');
      assert(!String(sealed).includes('sk-sign-secret-1'), '密钥明文字面量不得出现在库里那一行');

      /* ② undefined 不改：只改地址不该顺手把密钥弄丢 */
      const unchanged = saveSignConfig(kv, signInput('http://emr-sign.test/api/sign'), 'ADMIN');
      assertEqual(unchanged.apiKeyAction, 'unchanged', '没动密钥字段应记为 unchanged');
      assertEqual(loadSignConfig(kv).apiKey, 'sk-sign-secret-1', 'undefined 不得清掉已存的密钥');
      assertEqual(loadSignConfig(kv).apiKeyPresent, true, '密钥应仍然就位');

      /* ③ null 清除：**真删那一行**（只置 apiKeyStored=false 而留着密文，等于"我清掉了"是假话） */
      const cleared = saveSignConfig(kv, { ...signInput('http://emr-sign.test/api/sign'), apiKey: null }, 'ADMIN');
      assertEqual(cleared.apiKeyAction, 'cleared', 'null 应记为 cleared');
      assertEqual(loadSignConfig(kv).apiKeyPresent, false, '清除后密钥不就位');
      assertEqual(loadSignConfig(kv).apiKey, undefined, '清除后内存里不得再取到密钥');
      assertEqual(sealedBlobOf(fixture, SIGN_API_KEY_KEY), null, '清除应真删那一行（不是留个空壳）');

      /* ④ 密钥那一行解不开（口令换过 / 被改动过）→ **不许当作"没有密钥"** */
      saveSignConfig(kv, { ...signInput('http://emr-sign.test/api/sign'), apiKey: 'sk-recover' }, 'ADMIN');
      writeCorruptRow(fixture, SIGN_API_KEY_KEY);
      assertEqual(codeOf(() => loadSignConfig(kv)), 'E_SIGN_CONFIG_INVALID', '密钥读不出来不得当作"没有密钥"');

      assertEqual(
        codeOf(() => saveSignConfig(kv, { http: { endpoint: '   ' } }, 'ADMIN')),
        'E_SIGN_CONFIG_NO_ENDPOINT',
        '非法配置不得落库',
      );

      /* ⑤ 配置那一行读不出来（口令换过 / 那一行被改过）→ **不许当作"没配过"**：
         那会让"我配的签名服务没了"表现成"退回了软件签名"。 */
      writeCorruptRow(fixture, SIGN_CONFIG_KEY);
      assertEqual(codeOf(() => loadSignConfig(kv)), 'E_SIGN_CONFIG_INVALID', '读不出来的配置不得当作"没配过"');
    } finally {
      fixture.cleanup();
    }
  });

  await test('S7 错误类型可判别：配置错误与调用错误各有错误码', () => {
    assert(new SignConfigError('E_SIGN_CONFIG_INVALID', 'x') instanceof Error, '配置错误应是 Error');
    assert(new RemoteSignError('E_SIGN_NO_SIGNATURE', 'x') instanceof Error, '调用错误应是 Error');
  });

  /* ========================= S7 接入内核（配置 → Signer） ========================= */

  await test('S7 接入内核：配置 → Signer；未配置一律拒绝，签出的值可被独立验签', async () => {
    /* ① 未配置 / 缺预置公钥：都必须**拒绝构造**，而不是给一个"能签但身份不明"的东西 */
    assertEqual(
      codeOf(() => createRemoteSigner(validateSignConfig({}))),
      'E_SIGN_NOT_CONFIGURED',
      '未配置签名服务时不得构造出可用的签名器',
    );
    assertEqual(
      codeOf(() =>
        createRemoteSigner(
          validateSignConfig({
            http: {
              endpoint: 'http://sign.test/sign',
              request: { toSignField: 'toSign' },
              response: { signaturePath: 'signature', publicKeyPath: 'publicKey' },
            },
          }),
        ),
      ),
      'E_SIGN_NOT_CONFIGURED',
      '缺预置公钥就签不了（SignedInfo 里含公钥指纹，没有预置公钥就没有指纹）',
    );

    /* ② 一台会**真的签**的假服务：从请求体取出待签数据，用自研 SM2 签一次再回包。
       这样"请求构造 → 服务签 → 取签名值 → 独立验签"整条链路才是真的走通了。 */
    const sign = (key: typeof realSigner): SignTransport => async (request) => {
      const body = JSON.parse(request.body) as Record<string, unknown>;
      const toSign = fromBase64(String(readJsonPath(body, 'toSign')));
      return {
        status: 200,
        body: JSON.stringify({ signature: toBase64(key.sign(toSign)), publicKey: toBase64(key.publicKeyDer) }),
      };
    };

    const signer = createRemoteSigner(
      httpConfig({ publicKeyBase64: realPublicKeyBase64, expectedFingerprint: realFingerprint }),
      { transport: sign(realSigner) },
    );
    assertEqual(signer.provider, 'http', 'provider 应如实标注为 http（不是 software）');
    assertEqual(signer.fingerprint, realFingerprint, '指纹应来自预置公钥');
    const message = utf8('接入内核的往返验证');
    const signature = await signer.sign(message);
    assertEqual(softwareVerifier(realSigner.publicKey).verify(message, signature), true, '服务签出的值应能被独立验签器验过');

    /* ③ 服务回了**另一把**公钥：必须拒绝这次签名值（否则"签名"与"身份"对不上） */
    const alien = softwareSigner(demoKeyPair('alien-key').privateKey);
    const alienSigner = createRemoteSigner(httpConfig({ publicKeyBase64: realPublicKeyBase64 }), { transport: sign(alien) });
    assertEqual(
      await asyncCodeOf(() => alienSigner.sign(message)),
      'E_SIGN_FINGERPRINT_MISMATCH',
      '服务换了把钥匙时必须拒绝（不能"换了钥匙还认账"）',
    );

    /* ④ 期望指纹与预置公钥不一致：配置自相矛盾，构造时就报，而不是签完才发现 */
    assertEqual(
      codeOf(() =>
        createRemoteSigner(
          httpConfig({
            publicKeyBase64: realPublicKeyBase64,
            expectedFingerprint: publicKeyFingerprint(softwareSigner(demoKeyPair('nope-key').privateKey).publicKey),
          }),
        ),
      ),
      'E_SIGN_CONFIG_BAD_FINGERPRINT',
      '期望指纹与预置公钥不一致应在构造时拒绝',
    );
  });

  process.exit(suite.report());
}

void main();
