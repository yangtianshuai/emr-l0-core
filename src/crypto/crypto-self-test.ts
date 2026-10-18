// T18 验收自测：国密算法（SM3 / SM2）与密码学后端。
// D 密钥与后端契约：演示密钥确定性、私钥越界拒绝、后端元数据完整、环境能力如实上报

import { TestSuite, assert, assertEqual } from '../testing/harness.ts';
import { fromHex, sm3, sm3Hex, toHex, utf8 } from './sm3.ts';
import {
  SM2_GX,
  SM2_GY,
  SM2_N,
  decodeDerSignature,
  derivePublicKey,
  encodeDerSignature,
  generatePrivateKey,
  isOnCurve,
  publicKeyFingerprint,
  publicKeyFromSpki,
  publicKeyToSpki,
  scalarMultiply,
  sm2Digest,
  sm2Sign,
  sm2Verify,
  type Sm2Point,
} from './sm2.ts';
import { ECDSA_CROSS_ALGORITHM, ecdsaSm3Sign, ecdsaSm3Verify } from './ecdsa-sm3.ts';
import {
  SIGNATURE_ALGORITHM,
  crossCheck,
  demoKeyPair,
  ecdsaSigner,
  ecdsaVerifier,
  inspectDerImportedKey,
  opensslCrossCheck,
  opensslEcdsaSigner,
  opensslSm2CurveAvailable,
  opensslSm3,
  opensslSm3Available,
  softwareSigner,
  softwareVerifier,
} from './provider.ts';

const suite = new TestSuite('T18 国密算法（SM3/SM2）自测', [
  '说明：C 组是交叉验证 —— 与 OpenSSL 有关的比对、双向签验、篡改反例都必须通过。',
  '实测结论：Node/OpenSSL 在 SM2 曲线上用的是 ECDSA 方程，不是 GB/T 32918 的 SM2 签名，',
  '因此 SM2 用国标示例向量锁死，曲线/点运算/DER/SPKI 用 ECDSA 桥与 OpenSSL 交叉验证。',
]);

const test = (name: string, fn: () => void | Promise<void>): Promise<void> => suite.test(name, fn);
const BASE: Sm2Point = { x: SM2_GX, y: SM2_GY };
const openssl = opensslSm3Available() && opensslSm2CurveAvailable();

/** 覆盖填充边界：SM3/SHA 系填充对 55/56/63/64 这些长度最敏感（差一字节就全错） */
const BOUNDARY_SIZES = [0, 1, 2, 31, 32, 33, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 1000];

/** GB/T 32918.5 示例向量的输入（私钥、随机数、消息） */
const VECTOR_D = BigInt('0x3945208F7B2144B13F36E38AC6D39F95889393692860B51A42FB81EF4DF7C5B8');
const VECTOR_K = BigInt('0x59276E27D506861A16680F3AD9C02DCCEF3CC1FA3CDBE4CE6D54B80DEAC1BC21');
const VECTOR_MESSAGE = utf8('message digest');
const VECTOR_R = BigInt('0xF5A03B0648D2C4630EEAC513E1BB81A15944DA3827D5B74143AC7EACEEE720B3');
const VECTOR_S = BigInt('0xB1B6AA29DF212FD8763182BC0D421CA1BB9038FD1F7F42D4840B69C485BBC1AA');

function repeat(pattern: string, size: number): Uint8Array {
  const unit = utf8(pattern);
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i += 1) out[i] = unit[i % unit.length]!;
  return out;
}

function messages(): Uint8Array[] {
  return [utf8('abc'), repeat('abcd', 64), new Uint8Array(0), repeat('国密SM2-SM3 ', 200), fromHex('ff00'.repeat(97))];
}

async function main(): Promise<void> {

  await test('A1 国标测试向量：SM3("abc") 与 SM3("abcd"×16)', () => {
    assertEqual(
      sm3Hex(utf8('abc')),
      '66c7f0f462eeedd9d1f2d46bdc10e4e24167c4875cf2f7a2297da02b8f4ba8e0',
      'SM3("abc") 必须等于 GB/T 32905 附录向量',
    );
    assertEqual(
      sm3Hex(repeat('abcd', 64)),
      'debe9ff92275b8a138604889c18e5a4d6fdb70e5387e5765293dcba39c0c5732',
      'SM3("abcd"×16) 必须等于 GB/T 32905 附录向量',
    );
  });

  await test('A2 摘要格式：固定 32 字节 / 64 位十六进制 / hex 往返', () => {
    assertEqual(sm3(utf8('任意内容')).length, 32, 'SM3 摘要应为 32 字节');
    assertEqual(sm3Hex(utf8('任意内容')).length, 64, '十六进制摘要应为 64 字符');
    assertEqual(toHex(fromHex(sm3Hex(utf8('x')))), sm3Hex(utf8('x')), 'hex 编解码应往返一致');
  });

  await test('A3 与 OpenSSL 逐字节比对：含全部填充边界长度', () => {
    if (!opensslSm3Available()) {
      throw new Error('运行环境缺少 OpenSSL SM3，无法完成交叉验证（这不是"跳过"，必须显式失败）');
    }
    for (const size of BOUNDARY_SIZES) {
      const message = repeat('填充边界-abc', size);
      assertEqual(sm3Hex(message), toHex(opensslSm3(message)), `长度 ${size} 的摘要应与 OpenSSL 一致`);
    }
  });

  await test('A4 与 OpenSSL 比对：长消息（100KB）与长度编码字节序', () => {
    if (!opensslSm3Available()) throw new Error('运行环境缺少 OpenSSL SM3');
    const big = repeat('电子病历跨实现交叉验证数据块', 100 * 1024);
    assertEqual(sm3Hex(big), toHex(opensslSm3(big)), '100KB 消息的摘要应与 OpenSSL 一致');
    const odd = repeat('x', 65537);
    assertEqual(sm3Hex(odd), toHex(opensslSm3(odd)), '65537 字节（跨多块 + 奇数长度）应与 OpenSSL 一致');
  });

  await test('B1 曲线参数自检：基点在曲线上且 nG 为无穷远点（抄错任一参数都过不了）', () => {
    assertEqual(isOnCurve(BASE), true, '基点 G 必须在曲线上');
    assertEqual(isOnCurve({ x: SM2_GX, y: SM2_GY ^ 1n }), false, '被改动的点不应在曲线上（反例）');
    assertEqual(scalarMultiply(SM2_N, BASE), null, 'nG 必须是无穷远点');
    assertEqual(scalarMultiply(1n, BASE)?.x, SM2_GX, '1G 应等于基点');
  });

  await test('B2 GB/T 32918 示例向量：固定私钥与 k 时，r/s 必须与标准示例逐字节一致', () => {
    const publicKey = derivePublicKey(VECTOR_D);
    const signature = sm2Sign(VECTOR_MESSAGE, VECTOR_D, { k: VECTOR_K });
    assertEqual(signature.r, VECTOR_R, 'r 必须等于 GB/T 32918.5 示例输出');
    assertEqual(signature.s, VECTOR_S, 's 必须等于 GB/T 32918.5 示例输出');
    assertEqual(sm2Verify(VECTOR_MESSAGE, publicKey, signature), true, '示例签名必须自验通过');
    /* r = (e + x₁) mod n：r 对上意味着 e 与点运算都对上，故 Z 值计算也正确 */
    assert(sm2Digest(VECTOR_MESSAGE, publicKey) > 0n, 'Z 值摘要应可计算');
    assertEqual(sm2Verify(VECTOR_MESSAGE, publicKey, { r: VECTOR_R, s: VECTOR_S }), true, '直接代入示例 r/s 也应验签通过');
  });

  await test('B3 密钥：同私钥必然导出同公钥，且公钥在曲线上', () => {
    const pair = demoKeyPair('demo-key-derivation');
    assertEqual(pair.publicKey.x, derivePublicKey(pair.privateKey).x, '公钥推导应可复现');
    assertEqual(isOnCurve(pair.publicKey), true, '导出的公钥应在曲线上');
    assertEqual(publicKeyFingerprint(pair.publicKey).length, 64, '公钥指纹应为 64 位十六进制');
  });

  await test('B4 自签自验：签名可验证，且固定 k 时结果可复现', () => {
    const pair = demoKeyPair('self-sign');
    const message = utf8('签名内容：初步诊断 社区获得性肺炎');
    const signature = sm2Sign(message, pair.privateKey, { k: 0x1234567890abcdefn });
    assertEqual(sm2Verify(message, pair.publicKey, signature), true, '签名应验签通过');
    const again = sm2Sign(message, pair.privateKey, { k: 0x1234567890abcdefn });
    assertEqual(again.r, signature.r, '固定 k 时 r 应可复现（验收要求产物可复现）');
    assertEqual(again.s, signature.s, '固定 k 时 s 应可复现');
  });

  await test('B5 验签反例：改消息 / 改签名 / 换公钥 / 越界 r,s 都必须失败（且不抛异常）', () => {
    const pair = demoKeyPair('verify-negative');
    const other = demoKeyPair('verify-negative-other');
    const message = utf8('原始内容');
    const signature = sm2Sign(message, pair.privateKey);

    assertEqual(sm2Verify(utf8('原始内容 '), pair.publicKey, signature), false, '消息多一个空格应验签失败');
    assertEqual(sm2Verify(message, other.publicKey, signature), false, '换一把公钥应验签失败');
    assertEqual(sm2Verify(message, pair.publicKey, { r: signature.r, s: signature.s + 1n }), false, '改 s 应验签失败');
    assertEqual(sm2Verify(message, pair.publicKey, { r: 0n, s: signature.s }), false, 'r = 0 应验签失败');
    assertEqual(sm2Verify(message, pair.publicKey, { r: signature.r, s: SM2_N }), false, 's = n 应验签失败');

    const verifier = softwareVerifier(pair.publicKey);
    const der = encodeDerSignature(signature);
    assertEqual(verifier.verify(message, der), true, '软件验签器应通过');
    assertEqual(verifier.verify(message, der.subarray(0, der.length - 2)), false, '截断 DER 应返回 false 而不是抛异常');
    assertEqual(verifier.verify(message, fromHex('00')), false, '非法 DER 应返回 false');
  });

  await test('B6 DER 编解码往返：含奇数十六进制与最高位为 1 的边界（都是实测踩过的坑）', () => {
    const cases = [
      { r: 1n, s: 2n },
      /* 奇数位十六进制：padStart(2,'0') 补不成偶数，早期实现直接抛"长度必须为偶数" */
      { r: 0x123n, s: 0x4567n },
      { r: 0x7fn, s: 0x80n },
      { r: 0xffn, s: 0x100n },
      { r: SM2_N - 1n, s: SM2_N - 2n },
    ];
    for (const item of cases) {
      const decoded = decodeDerSignature(encodeDerSignature(item));
      assertEqual(decoded.r, item.r, `r 往返应一致（${item.r}）`);
      assertEqual(decoded.s, item.s, `s 往返应一致（${item.s}）`);
    }
    const der = encodeDerSignature({ r: 0xffn, s: 0x80n });
    assertEqual(der[4], 0x00, 'INTEGER 最高位为 1 时必须补 0x00（否则被解析成负数）');
  });

  await test('B7 SPKI：公钥编解码一致（91 字节），非法输入明确报错', () => {
    const pair = demoKeyPair('spki-roundtrip');
    const spki = publicKeyToSpki(pair.publicKey);
    assertEqual(spki.length, 91, 'SM2 公钥 SPKI 应为 91 字节');
    assertEqual(spki[spki.length - 65], 0x04, '末尾应为未压缩点标志 0x04');
    assertEqual(publicKeyFromSpki(spki).x, pair.publicKey.x, '解析出的 X 应一致');
    assertEqual(publicKeyFromSpki(spki).y, pair.publicKey.y, '解析出的 Y 应一致');

    const failOf = (fn: () => unknown): string => {
      try {
        fn();
        return 'OK';
      } catch {
        return 'E';
      }
    };
    assertEqual(failOf(() => publicKeyFromSpki(spki.subarray(0, 40))), 'E', '长度不足的 SPKI 应报错');
    const broken = new Uint8Array(spki);
    broken[broken.length - 65] = 0x03;
    assertEqual(failOf(() => publicKeyFromSpki(broken)), 'E', '非未压缩点标志应报错');
  });

  await test('C1 SPKI 与 OpenSSL 导出的 DER 逐字节一致（魔法常量不是抄错没人发现）', () => {
    if (!openssl) throw new Error('运行环境缺少 OpenSSL SM2 曲线，无法完成交叉验证');
    const generated = opensslEcdsaSigner();
    assert(!!generated, '应能生成 OpenSSL 密钥');
    assertEqual(generated!.signer.publicKeyDer.length, 91, 'OpenSSL 导出的 SPKI 也应是 91 字节');
    assertEqual(
      toHex(publicKeyToSpki(generated!.signer.publicKey)),
      toHex(generated!.signer.publicKeyDer),
      '自研构造的 SPKI 必须与 OpenSSL 导出的完全相同（前缀、长度、字节序）',
    );
    assertEqual(
      publicKeyFingerprint(generated!.signer.publicKey),
      sm3Hex(generated!.signer.publicKeyDer),
      '公钥指纹口径 = SPKI 的 SM3 摘要',
    );
  });

  await test('C2 完整交叉验证：SM3 逐字节 + 自研↔OpenSSL 双向签验 + 篡改反例，一次跑完', () => {
    if (!openssl) throw new Error('运行环境缺少 OpenSSL SM2 曲线，无法完成交叉验证');
    const report = opensslCrossCheck(messages());
    assertEqual(report.available, true, '交叉验证应可用（不可用时必须如实上报原因）');
    assertEqual(report.digestFailures, [], `SM3 摘要比对应全通过，实际：${report.digestFailures.join('；')}`);
    assertEqual(report.softwareToOpenssl, [], `自研签名 → OpenSSL 验签应全通过，实际：${report.softwareToOpenssl.join('；')}`);
    assertEqual(report.opensslToSoftware, [], `OpenSSL 签名 → 自研验签应全通过，实际：${report.opensslToSoftware.join('；')}`);
    assertEqual(report.opensslAlgorithm, 'ecdsa', 'OpenSSL 在 SM2 曲线上用的是 ECDSA 方程（实测判定，非推测）');
    assert(report.notes.length >= 2, '交叉验证必须留下"用了什么、限制是什么"的说明');
  });

  await test('C3 陷阱记录：从 DER 导入的 SM2 公钥在 Node 里**构造成功但验签恒失败**', () => {
    if (!openssl) throw new Error('运行环境缺少 OpenSSL SM2 曲线');
    const generated = opensslEcdsaSigner();
    assert(!!generated, '应能生成 OpenSSL 密钥');
    const probe = inspectDerImportedKey(generated!.signer.publicKeyDer);
    assertEqual(probe.asymmetricKeyType, 'undefined', 'DER 导入的 SM2 公钥类型识别失败（原生 key 是 ec）');
    assertEqual(probe.signatureValid, true, '前置：这份签名本身必须有效（否则 usable=false 的结论不成立）');
    assertEqual(probe.usable, false, '该 key 不可用于验签：这是静默陷阱，产品代码绝不能走这条路');
  });

  await test('C4 对照实验：SM2 与 ECDSA 确实互不通用（不是"验签器一直返回 false"）', () => {
    if (!openssl) throw new Error('运行环境缺少 OpenSSL SM2 曲线，无法完成交叉验证');
    const generated = opensslEcdsaSigner();
    assert(!!generated, '应能生成 OpenSSL 密钥');
    const message = utf8('对照实验');
    const opensslSignature = generated!.signer.sign(message);

    /* 同一把公钥、同一个签名：ECDSA 验通、SM2 验不通 */
    assertEqual(ecdsaVerifier(generated!.signer.publicKey).verify(message, opensslSignature), true, 'ECDSA 验签器应认它');
    assertEqual(softwareVerifier(generated!.signer.publicKey).verify(message, opensslSignature), false, 'SM2 验签器不应认它');
    /* 而 SM2 验签器对自己的签名是认的（证明它不是坏掉了一直返回 false） */
    const pair = demoKeyPair('cross-reference');
    assertEqual(softwareVerifier(pair.publicKey).verify(message, softwareSigner(pair.privateKey).sign(message)), true, 'SM2 自签自验应通过');
    /* 反向：SM2 签名交给 ECDSA 验签器，也必须不认 */
    const sm2Signature = encodeDerSignature(sm2Sign(message, pair.privateKey));
    assertEqual(ecdsaVerifier(pair.publicKey).verify(message, sm2Signature), false, 'SM2 签名不得被 ECDSA 验签器接受');
  });

  await test('C5 Z 值（签名者标识）确实参与签名：换 ID 不能互验', () => {
    const pair = demoKeyPair('z-value');
    const message = utf8('Z 值必须参与签名');
    const signature = sm2Sign(message, pair.privateKey, { id: '1234567812345678' });
    assertEqual(sm2Verify(message, pair.publicKey, signature, '1234567812345678'), true, '同 ID 应验签通过');
    assertEqual(sm2Verify(message, pair.publicKey, signature, '8765432187654321'), false, '换 ID 必须验签失败');
    assertEqual(ecdsaSm3Verify(message, pair.publicKey, ecdsaSm3Sign(message, pair.privateKey)), true, 'ECDSA 桥也应可用');
  });

  await test('D1 演示密钥确定性：同种子同密钥，异种子异密钥（产物可复现的前提）', () => {
    const a = demoKeyPair('seed-a');
    const b = demoKeyPair('seed-a');
    const c = demoKeyPair('seed-b');
    assertEqual(a.privateKey, b.privateKey, '同种子的私钥必须相同');
    assertEqual(a.publicKey.x, b.publicKey.x, '同种子的公钥必须相同');
    assert(a.privateKey !== c.privateKey, '不同种子应产生不同私钥');
    assert(a.privateKey > 0n && a.privateKey < SM2_N, '私钥应在 [1, n-1] 内');
  });

  await test('D2 私钥越界必须明确拒绝（0 / n / n+1 都是非法私钥）', () => {
    const codes = [0n, SM2_N, SM2_N + 1n].map((value) => {
      try {
        generatePrivateKey(value);
        return 'OK';
      } catch {
        return 'E';
      }
    });
    assertEqual(codes, ['E', 'E', 'E'], '越界私钥必须报错，不能"当成合法值继续算"');
    assertEqual(generatePrivateKey(1n), 1n, '合法私钥应原样返回（便于固定向量测试）');
  });

  await test('D3 后端元数据：算法标识、后端名、公钥 DER 必须齐全且不混用', () => {
    const pair = demoKeyPair('metadata');
    const signer = softwareSigner(pair.privateKey);
    assertEqual(signer.algorithm, SIGNATURE_ALGORITHM, '产品算法标识应为 SM2-SM3');
    assertEqual(signer.algorithm, 'SM2-SM3', '算法标识字面量必须稳定（会写进 OFD 产物）');
    assertEqual(signer.provider, 'software', '软件后端应如实标注 provider');
    assertEqual(signer.publicKeyDer.length, 91, '签名者必须能给出公钥 DER 供第三方验签');
    assertEqual(ecdsaSigner(pair.privateKey).algorithm, ECDSA_CROSS_ALGORITHM, '交叉验证桥必须标明自己是 ECDSA-SM3');
    /* 放宽为 string 再比较：TS 会把两个字面量类型的比较判为"恒真/无重叠"，那是编译期闲话，不是运行时保证 */
    const crossAlgorithm: string = ECDSA_CROSS_ALGORITHM;
    assert(crossAlgorithm !== SIGNATURE_ALGORITHM, '交叉验证算法标识绝不能与产品算法相同（否则等于谎报）');
    if (openssl) {
      const generated = opensslEcdsaSigner();
      assertEqual(generated?.signer.provider, 'openssl', 'OpenSSL 后端应如实标注');
    }
    assertEqual(typeof opensslSm3Available(), 'boolean', 'SM3 能力探测应返回布尔值');
    assertEqual(typeof opensslSm2CurveAvailable(), 'boolean', 'SM2 曲线能力探测应返回布尔值');
  });

  process.exit(suite.report());
}

await main();
