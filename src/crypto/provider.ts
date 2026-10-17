/**
 * 密码学后端（CryptoProvider）—— **生产替换点**。
 *
 * 本文件提供：
 *   - `Signer` / `Verifier` 接口：上层（文档签章、OFD 导出、独立验签）只依赖这两个接口；
 *   - `software` 后端：本仓库自研的 **SM2-SM3**（零依赖，便于审计与离线部署）；
 *   - `openssl` 后端：Node 内置 OpenSSL，用于**交叉验证**；
 *   - 能力探测：如实报告当前运行环境支持什么（缺什么就少验什么，绝不假装验过）。
 *
 * ⚠️ 生产部署必须把签名后端换成**经认证的密码模块**（商用密码产品 / HSM / UKey）：
 *    自研实现的正确性有标准向量与交叉验证支撑，但**没有第三方审计**，不满足合规要求；
 *    私钥也绝不能像演示密钥那样可推导。替换方式是实现 `Signer` / `Verifier` 两个接口。
 *
 * ⚠️ **重要实测结论**：Node/OpenSSL 暴露的 API 里没有 SM2 签名算法 ——
 *    `crypto.sign('sm3', data, ecKeyOnSm2Curve)` 实际用的是 **ECDSA 方程**（曲线与摘要才是国密）。
 *    因此 OpenSSL 不能给 SM2 做交叉验证，只能通过 `ecdsa-sm3.ts` 的桥做
 *    "曲线/点运算/DER/SPKI" 层面的交叉，SM2 方程本身由 GB/T 32918 示例向量锁死。
 *    详见 `ecdsa-sm3.ts` 的文件头说明。
 */

import { createHash, createPublicKey, generateKeyPairSync, sign as nodeSign, verify as nodeVerify, type KeyObject } from 'node:crypto';
import { ECDSA_CROSS_ALGORITHM, ecdsaSm3Sign, ecdsaSm3Verify } from './ecdsa-sm3.ts';
import {
  SM2_N,
  decodeDerSignature,
  derivePublicKey,
  encodeDerSignature,
  publicKeyFingerprint,
  publicKeyFromSpki,
  publicKeyToSpki,
  sm2Sign,
  sm2Verify,
  type Sm2Point,
} from './sm2.ts';
import { fromHex, sm3, sm3Hex, toHex, utf8 } from './sm3.ts';

/** 产品签名算法：SM2 公钥 + SM3 杂凑（写进 OFD 的 SignatureMethod 与文档 signatureRefs） */
export const SIGNATURE_ALGORITHM = 'SM2-SM3';

export interface Signer {
  readonly algorithm: string;
  /** 后端名称（'software' / 'openssl' / 未来的 'hsm' / 'ukey'），写进签名元数据便于审计 */
  readonly provider: string;
  readonly publicKey: Sm2Point;
  /** 公钥 SPKI（DER）—— 第三方独立验签只需要它，不需要本项目任何代码 */
  readonly publicKeyDer: Uint8Array;
  readonly fingerprint: string;
  /**
   * 签名。
   *
   * ⚠️ **允许异步**：真实签名后端要么是网络服务（`src/sign/remote-signer.ts`），要么是密码设备 ——
   * "同步就能拿到签名值"是**只有软件实现才成立的假设**。内核里只有 `signTargets()` 一处会 await 它，
   * 其余调用方只需把 async 沿调用链传出去。
   */
  sign(message: Uint8Array): Uint8Array | Promise<Uint8Array>;
}

/**
 * 同步后端（自研软件实现 / 本地密码模块）：签名值立刻可得。
 *
 * 单独标出来，是为了让"我用的确实是同步后端"这件事**由类型保证** ——
 * 否则 `signTargets` 之外的简单用途（自检、交叉验证、测试构造签名值）全都要 `await`，啰嗦且没必要。
 */
export interface SyncSigner extends Signer {
  sign(message: Uint8Array): Uint8Array;
}

export interface Verifier {
  readonly algorithm: string;
  readonly provider: string;
  readonly fingerprint: string;
  verify(message: Uint8Array, signature: Uint8Array): boolean;
}

/* ------------------------- 软件后端：SM2-SM3（自研） ------------------------- */

export function softwareSigner(privateKey: bigint): SyncSigner {
  const publicKey = derivePublicKey(privateKey);
  return {
    algorithm: SIGNATURE_ALGORITHM,
    provider: 'software',
    publicKey,
    publicKeyDer: publicKeyToSpki(publicKey),
    fingerprint: publicKeyFingerprint(publicKey),
    sign: (message) => encodeDerSignature(sm2Sign(message, privateKey)),
  };
}

export function softwareVerifier(publicKey: Sm2Point): Verifier {
  return {
    algorithm: SIGNATURE_ALGORITHM,
    provider: 'software',
    fingerprint: publicKeyFingerprint(publicKey),
    verify: (message, signature) => {
      try {
        return sm2Verify(message, publicKey, decodeDerSignature(signature));
      } catch {
        /* DER 结构非法也算验签失败：验签器绝不对"看不懂的签名"抛异常或返回真 */
        return false;
      }
    },
  };
}

/* --------------------- 交叉验证用：ECDSA-SM3（非产品算法） --------------------- */

export function ecdsaSigner(privateKey: bigint): SyncSigner {
  const publicKey = derivePublicKey(privateKey);
  return {
    algorithm: ECDSA_CROSS_ALGORITHM,
    provider: 'software-ecdsa',
    publicKey,
    publicKeyDer: publicKeyToSpki(publicKey),
    fingerprint: publicKeyFingerprint(publicKey),
    sign: (message) => encodeDerSignature(ecdsaSm3Sign(message, privateKey)),
  };
}

export function ecdsaVerifier(publicKey: Sm2Point): Verifier {
  return {
    algorithm: ECDSA_CROSS_ALGORITHM,
    provider: 'software-ecdsa',
    fingerprint: publicKeyFingerprint(publicKey),
    verify: (message, signature) => {
      try {
        return ecdsaSm3Verify(message, publicKey, decodeDerSignature(signature));
      } catch {
        return false;
      }
    },
  };
}

/* --------------------------- OpenSSL 后端（内置） --------------------------- */

/** SM3 是否可用（OpenSSL 3.x 提供）；不可用时交叉验证必须如实降级说明，不能静默跳过 */
export function opensslSm3Available(): boolean {
  try {
    createHash('sm3').update('abc').digest('hex');
    return true;
  } catch {
    return false;
  }
}

/** SM2 曲线是否可用（部分发行版裁剪过曲线集） */
export function opensslSm2CurveAvailable(): boolean {
  try {
    generateKeyPairSync('ec', { namedCurve: 'SM2' });
    return true;
  } catch {
    return false;
  }
}

/** OpenSSL 侧 SM3 摘要（与自研实现做逐字节比对） */
export function opensslSm3(message: Uint8Array): Uint8Array {
  const hash = createHash('sm3');
  hash.update(message);
  return fromHex(hash.digest('hex'));
}

export interface OpensslKeyPair {
  signer: SyncSigner;
  privateKey: KeyObject;
}

/**
 * 用 OpenSSL 生成密钥并签名（算法为 ECDSA-SM3，见文件头说明）。
 * 密钥对由 OpenSSL 自己生成（而不是导入自研私钥）：这样交叉验证的是
 * **两个完全独立的密钥与签名实现**，而不是"同一份私钥换个库"。
 */
export function opensslEcdsaSigner(): OpensslKeyPair | null {
  if (!opensslSm3Available() || !opensslSm2CurveAvailable()) return null;
  const pair = generateKeyPairSync('ec', { namedCurve: 'SM2' });
  const spki = pair.publicKey.export({ format: 'der', type: 'spki' });
  const publicKey = publicKeyFromSpki(spki);
  return { privateKey: pair.privateKey, signer: opensslSignerFromKey(pair.privateKey, publicKey) };
}

/**
 * 把 OpenSSL 原生密钥做成签名器/验签器。**只接受原生 KeyObject，不接受从 DER 导入的公钥** ——
 * 因为从 DER 导入的 SM2 公钥是个**静默陷阱**（实测）：
 *   `createPublicKey({ key: sm2Spki, format: 'der', type: 'spki' })` 会成功、
 *   回读出的 SPKI 与原字节完全一致，但该 key 的 `asymmetricKeyType` 是 `undefined`，
 *   且 `verify()` **恒返回 false 且不报错**。
 * 如果拿它做验签，现象会是"所有签名都验不过"，而排查方向会被完全带偏
 * （会怀疑签名算法、摘要、编码，唯独不会怀疑"key 是废的"）。
 * 所以这里只暴露"从原生 key 构造"这一条路，并把陷阱写成可测试的探针。
 */
export function opensslSignerFromKey(privateKey: KeyObject, publicKey: Sm2Point): SyncSigner {
  return {
    algorithm: ECDSA_CROSS_ALGORITHM,
    provider: 'openssl',
    publicKey,
    publicKeyDer: publicKeyToSpki(publicKey),
    fingerprint: publicKeyFingerprint(publicKey),
    sign: (message) => nodeSign('sm3', message, privateKey),
  };
}

export function opensslVerifierFromKey(publicKeyObject: KeyObject, publicKey: Sm2Point): Verifier {
  return {
    algorithm: ECDSA_CROSS_ALGORITHM,
    provider: 'openssl',
    fingerprint: publicKeyFingerprint(publicKey),
    verify: (message, signature) => {
      try {
        return nodeVerify('sm3', message, publicKeyObject, signature);
      } catch {
        return false;
      }
    },
  };
}

/**
 * 探针：把"从 DER 导入 SM2 公钥"这一陷阱变成可断言的实测结论。
 * 返回 `usable: false` 时表示**这条路不能用**（不是调用方的错），用来防止后来人踩同一个坑。
 */
export function inspectDerImportedKey(spki: Uint8Array): { asymmetricKeyType: string; signatureValid: boolean; usable: boolean } {
  const key = createPublicKey({ key: spki, format: 'der', type: 'spki' });
  const message = utf8('der-imported-key-probe');
  const pair = generateKeyPairSync('ec', { namedCurve: 'SM2' });
  const signature = nodeSign('sm3', message, pair.privateKey);

  /* 先自证"这份签名本身是有效的"（用能正常工作的 key 验一次）。
     少了这一步，usable=false 就有两种解释：key 不可用，或者签名/消息本身有问题 ——
     那样这条探针就得不出结论。 */
  const signatureValid = nodeVerify('sm3', message, pair.publicKey, signature);
  let usable = false;
  try {
    usable = nodeVerify('sm3', message, key, signature);
  } catch {
    usable = false;
  }
  return { asymmetricKeyType: key.asymmetricKeyType ?? 'undefined', signatureValid, usable };
}

/**
 * 从 PKCS8 私钥中提取标量 d（**仅交叉验证用**）。
 * 提取后必须校验"由 d 推导的公钥 == SPKI 里的公钥"，否则宁可报错也不要拿错密钥去签 ——
 * 用错密钥的表现是"验签失败"，而人会往算法上找原因。
 */
export function extractPrivateScalar(privateKey: KeyObject, publicKey: Sm2Point): bigint {
  const hex = toHex(privateKey.export({ format: 'der', type: 'pkcs8' }));
  const at = hex.indexOf('0420');
  if (at < 0) throw new Error('无法从 PKCS8 中定位私钥标量（结构不符合预期）');
  const scalar = BigInt(`0x${hex.slice(at + 4, at + 4 + 64)}`);
  const derived = derivePublicKey(scalar);
  if (derived.x !== publicKey.x || derived.y !== publicKey.y) {
    throw new Error('提取出的私钥与目标公钥不匹配（交叉验证会得出错误结论，故直接失败）');
  }
  return scalar;
}

/**
 * 探明 OpenSSL 在 SM2 曲线上**实际用的签名算法**（ecdsa / sm2 / unknown）。
 * 这是"如实上报环境能力"的机制：判定的依据是**用两套自研验签器去验 OpenSSL 的签名**，
 * 谁验通就是谁 —— 而不是相信文档或命名。
 */
export function probeOpensslSideAlgorithm(): { algorithm: 'ecdsa' | 'sm2' | 'unknown' } {
  const generated = opensslEcdsaSigner();
  if (!generated) return { algorithm: 'unknown' };
  const message = utf8('probe-openssl-side-algorithm');
  const signature = generated.signer.sign(message);

  const asEcdsa = ecdsaVerifier(generated.signer.publicKey).verify(message, signature);
  const asSm2 = softwareVerifier(generated.signer.publicKey).verify(message, signature);
  if (asEcdsa && !asSm2) return { algorithm: 'ecdsa' };
  if (asSm2 && !asEcdsa) return { algorithm: 'sm2' };
  return { algorithm: 'unknown' };
}

/* --------------------------- 完整交叉验证报告 --------------------------- */

export interface CrossCheckReport {
  /** 环境是否具备交叉验证条件（缺什么会写在 unavailableReason 里，绝不静默跳过） */
  available: boolean;
  unavailableReason?: string;
  /** 同算法比对：SM3 摘要逐字节 */
  digestFailures: string[];
  /** 自研签名 → OpenSSL 验签 */
  softwareToOpenssl: string[];
  /** OpenSSL 签名 → 自研验签 */
  opensslToSoftware: string[];
  /** OpenSSL 在 SM2 曲线上实际使用的算法（实测判定，不是推测） */
  opensslAlgorithm: 'ecdsa' | 'sm2' | 'unknown';
  /** DER 导入的 SM2 公钥是否可用（false = 已知陷阱，不该走这条路） */
  derImportedKeyUsable: boolean;
  notes: string[];
}

/**
 * 完整交叉验证：把三条独立证据一次性跑完并如实返回。
 *
 * 为什么自研与 OpenSSL 要**共用同一密钥对**（用 OpenSSL 生成、把私钥标量提取给自研）：
 *   Node 无法从 DER/JWK 导入 SM2 曲线公钥用于验签（`derImportedKeyUsable` 就是这条断路的探针），
 *   所以"自研公钥 → 交给 OpenSSL 验签"这条路走不通。共用密钥对之后，
 *   两个实现的**签名算法、DER 编码、摘要、曲线运算**仍然是各自独立实现 ——
 *   交叉验证要验的正是这些，而不是"私钥从哪来"。
 */
export function opensslCrossCheck(messages: Uint8Array[]): CrossCheckReport {
  if (!opensslSm3Available() || !opensslSm2CurveAvailable()) {
    return {
      available: false,
      unavailableReason: '当前运行环境缺少 OpenSSL SM3 或 SM2 曲线（交叉验证无法进行，必须如实上报）',
      digestFailures: [],
      softwareToOpenssl: [],
      opensslToSoftware: [],
      opensslAlgorithm: 'unknown',
      derImportedKeyUsable: false,
      notes: [],
    };
  }

  const digestFailures: string[] = [];
  for (const [index, message] of messages.entries()) {
    if (sm3Hex(message) !== toHex(opensslSm3(message))) digestFailures.push(`第 ${index} 条：SM3 摘要不一致`);
  }

  const pair = generateKeyPairSync('ec', { namedCurve: 'SM2' });
  const spki = pair.publicKey.export({ format: 'der', type: 'spki' });
  const publicKey = publicKeyFromSpki(spki);
  const scalar = extractPrivateScalar(pair.privateKey, publicKey);

  const softwareToOpenssl = crossCheck(ecdsaSigner(scalar), opensslVerifierFromKey(pair.publicKey, publicKey), messages);
  const opensslToSoftware = crossCheck(opensslSignerFromKey(pair.privateKey, publicKey), ecdsaVerifier(publicKey), messages);

  return {
    available: true,
    digestFailures,
    softwareToOpenssl,
    opensslToSoftware,
    opensslAlgorithm: probeOpensslSideAlgorithm().algorithm,
    derImportedKeyUsable: inspectDerImportedKey(spki).usable,
    notes: [
      '自研与 OpenSSL 共用同一密钥对（Node 无法从 DER/JWK 导入 SM2 公钥用于验签）',
      'OpenSSL 侧算法为 ECDSA-SM3：曲线与摘要都是国密，签名方程不是 GB/T 32918 的 SM2',
    ],
  };
}

/* ------------------------------- 演示密钥 ------------------------------- */

/**
 * 确定性演示密钥：d = SM3(seed) mod (n-1) + 1。
 *
 * ⚠️ **只用于演示与测试**：种子公开、私钥可被任何人推导。
 *    真实部署必须由密码设备生成并保管私钥（L0 永不落盘私钥）。
 *    之所以要确定性：验收要求"同样输入 → 同样字节"，随机密钥会让 OFD 产物不可复现。
 */
export function demoKeyPair(seed: string): { privateKey: bigint; publicKey: Sm2Point } {
  const digest = BigInt(`0x${sm3Hex(utf8(seed))}`);
  const privateKey = (digest % (SM2_N - 1n)) + 1n;
  return { privateKey, publicKey: derivePublicKey(privateKey) };
}

/* ------------------------------ 交叉验证 ------------------------------ */

/**
 * 让 A 签名、让 B 验签，并逐一验证"篡改必须失败"。
 * 返回失败描述（空数组 = 全部通过）。
 *
 * 刻意**同时验证正例与反例**：只验正例时，一个"永远返回 true"的验签器也能全绿。
 */
export function crossCheck(signer: SyncSigner, verifier: Verifier, messages: Uint8Array[]): string[] {
  const failures: string[] = [];
  if (signer.algorithm !== verifier.algorithm) {
    failures.push(`算法标识不一致：${signer.algorithm} vs ${verifier.algorithm}`);
  }
  if (signer.fingerprint !== verifier.fingerprint) {
    failures.push(`公钥指纹不一致：${signer.fingerprint.slice(0, 16)}… vs ${verifier.fingerprint.slice(0, 16)}…`);
  }
  for (const [index, message] of messages.entries()) {
    const signature = signer.sign(message);
    if (!verifier.verify(message, signature)) failures.push(`第 ${index} 条：对端验签失败`);

    /* 空消息也要能构造出"被篡改的版本"：否则反例会退化成"验同一个东西"，永远通过（实测踩到） */
    const tampered = message.length > 0 ? new Uint8Array(message) : new Uint8Array([0x01]);
    if (message.length > 0) tampered[0] = (tampered[0]! ^ 0x01) & 0xff;
    if (verifier.verify(tampered, signature)) failures.push(`第 ${index} 条：篡改后的消息竟然验签通过`);

    const badSignature = new Uint8Array(signature);
    badSignature[badSignature.length - 1] = (badSignature[badSignature.length - 1]! ^ 0x01) & 0xff;
    if (verifier.verify(message, badSignature)) failures.push(`第 ${index} 条：篡改后的签名竟然验签通过`);

    if (verifier.verify(message, signature.subarray(0, Math.max(1, signature.length - 3)))) {
      failures.push(`第 ${index} 条：残缺签名竟然验签通过`);
    }
  }
  return failures;
}

export { ECDSA_CROSS_ALGORITHM, sm3, sm3Hex, toHex, utf8 };
