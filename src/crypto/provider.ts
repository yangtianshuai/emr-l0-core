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

export const SIGNATURE_ALGORITHM = 'SM2-SM3';

export interface Signer {
  readonly algorithm: string;
  readonly provider: string;
  readonly publicKey: Sm2Point;
  readonly publicKeyDer: Uint8Array;
  readonly fingerprint: string;
  sign(message: Uint8Array): Uint8Array | Promise<Uint8Array>;
}

export interface SyncSigner extends Signer {
  sign(message: Uint8Array): Uint8Array;
}

export interface Verifier {
  readonly algorithm: string;
  readonly provider: string;
  readonly fingerprint: string;
  verify(message: Uint8Array, signature: Uint8Array): boolean;
}

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

/** SM3 是否可用（OpenSSL 3.x 提供）；不可用时交叉验证必须如实降级说明，不能静默跳过 */
export function opensslSm3Available(): boolean {
  try {
    createHash('sm3').update('abc').digest('hex');
    return true;
  } catch {
    return false;
  }
}

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

export function opensslEcdsaSigner(): OpensslKeyPair | null {
  if (!opensslSm3Available() || !opensslSm2CurveAvailable()) return null;
  const pair = generateKeyPairSync('ec', { namedCurve: 'SM2' });
  const spki = pair.publicKey.export({ format: 'der', type: 'spki' });
  const publicKey = publicKeyFromSpki(spki);
  return { privateKey: pair.privateKey, signer: opensslSignerFromKey(pair.privateKey, publicKey) };
}

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

export function inspectDerImportedKey(spki: Uint8Array): { asymmetricKeyType: string; signatureValid: boolean; usable: boolean } {
  const key = createPublicKey({ key: spki, format: 'der', type: 'spki' });
  const message = utf8('der-imported-key-probe');
  const pair = generateKeyPairSync('ec', { namedCurve: 'SM2' });
  const signature = nodeSign('sm3', message, pair.privateKey);

  const signatureValid = nodeVerify('sm3', message, pair.publicKey, signature);
  let usable = false;
  try {
    usable = nodeVerify('sm3', message, key, signature);
  } catch {
    usable = false;
  }
  return { asymmetricKeyType: key.asymmetricKeyType ?? 'undefined', signatureValid, usable };
}

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

export interface CrossCheckReport {
  available: boolean;
  unavailableReason?: string;
  /** 同算法比对：SM3 摘要逐字节 */
  digestFailures: string[];
  /** 自研签名 → OpenSSL 验签 */
  softwareToOpenssl: string[];
  /** OpenSSL 签名 → 自研验签 */
  opensslToSoftware: string[];
  opensslAlgorithm: 'ecdsa' | 'sm2' | 'unknown';
  derImportedKeyUsable: boolean;
  notes: string[];
}

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

export function demoKeyPair(seed: string): { privateKey: bigint; publicKey: Sm2Point } {
  const digest = BigInt(`0x${sm3Hex(utf8(seed))}`);
  const privateKey = (digest % (SM2_N - 1n)) + 1n;
  return { privateKey, publicKey: derivePublicKey(privateKey) };
}

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
