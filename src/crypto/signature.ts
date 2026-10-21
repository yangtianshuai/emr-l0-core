import type { DocumentModel } from '../model/types.ts';
import { SIGNATURE_ALGORITHM, softwareVerifier, type Signer, type Verifier } from './provider.ts';
import { fromHex, sm3Hex, toHex, utf8 } from './sm3.ts';
import { publicKeyFingerprint, publicKeyFromSpki, type Sm2Point } from './sm2.ts';

export interface SignatureTarget {
  /** 逻辑文件路径（与 OFD 容器内路径一致，便于第三方按路径复算） */
  path: string;
  bytes: Uint8Array;
}

export interface SignatureMeta {
  signatureRef: string;
  documentId: string;
  signerRole: string;
  signerId: string;
  signedAt: string;
  algorithm: string;
  provider: string;
}

export interface ReferenceEntry {
  path: string;
  digest: string;
}

export interface SignatureBlock {
  meta: SignatureMeta;
  publicKeyBase64: string;
  publicKeyFingerprint: string;
  references: ReferenceEntry[];
  signedInfoDigest: string;
  /** SM2 签名（DER）的 base64 */
  signatureValue: string;
}

export function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

export function fromBase64(text: string): Uint8Array {
  return Buffer.from(text, 'base64');
}

export function canonicalSignedInfo(meta: SignatureMeta, references: ReferenceEntry[], publicKeyFingerprintHex: string): Uint8Array {
  const sorted = [...references].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const lines = [
    'ofd-signature/v1',
    `algorithm=${meta.algorithm}`,
    `provider=${meta.provider}`,
    `signatureRef=${meta.signatureRef}`,
    `documentId=${meta.documentId}`,
    `signerRole=${meta.signerRole}`,
    `signerId=${meta.signerId}`,
    `signedAt=${meta.signedAt}`,
    `publicKeyFingerprint=${publicKeyFingerprintHex}`,
    ...sorted.map((entry) => `reference=${entry.path}:${entry.digest}`),
    '',
  ];
  return utf8(lines.join('\n'));
}

/** 摘要清单：按路径排序后各自 SM3（排序保证"文件顺序无关"，改顺序不会改签名） */
function referencesOf(targets: SignatureTarget[]): ReferenceEntry[] {
  return [...targets]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((target) => ({ path: target.path, digest: sm3Hex(target.bytes) }));
}

export function signedInfoDigestOf(
  targets: SignatureTarget[],
  meta: Omit<SignatureMeta, 'algorithm' | 'provider'>,
  signer: Signer,
): string {
  const fullMeta: SignatureMeta = { ...meta, algorithm: signer.algorithm, provider: signer.provider };
  return sm3Hex(canonicalSignedInfo(fullMeta, referencesOf(targets), signer.fingerprint));
}

export async function signTargets(
  targets: SignatureTarget[],
  meta: Omit<SignatureMeta, 'algorithm' | 'provider'>,
  signer: Signer,
): Promise<SignatureBlock> {
  const references = referencesOf(targets);

  const fullMeta: SignatureMeta = { ...meta, algorithm: signer.algorithm, provider: signer.provider };
  const info = canonicalSignedInfo(fullMeta, references, signer.fingerprint);
  const signature = await signer.sign(info);

  return {
    meta: fullMeta,
    publicKeyBase64: toBase64(signer.publicKeyDer),
    publicKeyFingerprint: signer.fingerprint,
    references,
    signedInfoDigest: sm3Hex(info),
    signatureValue: toBase64(signature),
  };
}

export interface VerifySignatureResult {
  ok: boolean;
  /** 失败原因逐条列出（"改了哪个文件"必须能说清，不能只报"验签失败"） */
  reasons: string[];
  details: { algorithm: string; provider: string; publicKeyFingerprint: string; referenceCount: number };
}

/** 按算法标识选择验签器：验签只依赖算法与公钥，与签名方用什么后端无关  */
export function verifierFor(algorithm: string, publicKey: Sm2Point): Verifier | null {
  if (algorithm === SIGNATURE_ALGORITHM) return softwareVerifier(publicKey);
  return null;
}

export function verifyTargets(
  block: SignatureBlock,
  targets: SignatureTarget[],
  options: { requireAllCovered?: boolean } = {},
): VerifySignatureResult {
  const requireAllCovered = options.requireAllCovered ?? true;
  const reasons: string[] = [];
  const details = {
    algorithm: block.meta.algorithm,
    provider: block.meta.provider,
    publicKeyFingerprint: block.publicKeyFingerprint,
    referenceCount: block.references.length,
  };

  const byPath = new Map(targets.map((target) => [target.path, target.bytes]));
  for (const reference of block.references) {
    const bytes = byPath.get(reference.path);
    if (!bytes) {
      reasons.push(`缺少被签名文件：${reference.path}`);
      continue;
    }
    if (sm3Hex(bytes) !== reference.digest) reasons.push(`文件内容已被改动：${reference.path}`);
  }
  /* 反向：多出来的文件不算"签名坏了"，但必须让调用方知道它没被签名覆盖 */
  if (requireAllCovered) {
    const covered = new Set(block.references.map((reference) => reference.path));
    for (const target of targets) {
      if (!covered.has(target.path)) reasons.push(`存在未被签名覆盖的文件：${target.path}`);
    }
  }

  const info = canonicalSignedInfo(block.meta, block.references, block.publicKeyFingerprint);
  if (sm3Hex(info) !== block.signedInfoDigest) reasons.push('SignedInfo 已被改动（元数据或摘要清单不一致）');

  let publicKey: Sm2Point;
  try {
    publicKey = publicKeyFromSpki(fromBase64(block.publicKeyBase64));
  } catch (err) {
    reasons.push(`公钥格式非法：${(err as Error).message}`);
    return { ok: false, reasons, details };
  }
  if (publicKeyFingerprint(publicKey) !== block.publicKeyFingerprint) reasons.push('公钥与其指纹不一致');

  const verifier = verifierFor(block.meta.algorithm, publicKey);
  if (!verifier) {
    reasons.push(`不支持的签名算法：${block.meta.algorithm}（本版本仅支持 ${SIGNATURE_ALGORITHM}）`);
  } else if (!verifier.verify(info, fromBase64(block.signatureValue))) {
    reasons.push('签名验证失败（签名值与 SignedInfo 不匹配）');
  }

  return { ok: reasons.length === 0, reasons, details };
}

export function documentSnapshot(doc: DocumentModel): Uint8Array {
  const patient = doc.patient;
  const encounter = doc.encounter;
  const machine = doc.machineReadable;
  const lines = [
    'ofd-document/v1',
    `documentId=${doc.docId}`,
    `schemaVersion=${doc.schemaVersion}`,
    `docType=${doc.docType.system}|${doc.docType.code}|${doc.docType.display}`,
    `patient=${patient.patientId}|${patient.nameMasked ?? ''}|${patient.gender ?? ''}|${patient.birthDate ?? ''}`,
    `encounter=${encounter?.visitId ?? ''}|${encounter?.visitType ?? ''}|${encounter?.deptCode ?? ''}|${encounter?.admittedAt ?? ''}`,
    `createdAt=${doc.createdAt}`,
    `createdBy=${doc.createdBy}`,
    `rootId=${doc.rootId}`,
    `machine.sourceHash=${machine?.sourceHash ?? ''}`,
    `machine.dataElements=${machine?.dataElements.length ?? 0}`,
    `machine.keyContentRefs=${machine?.keyContentRefs?.length ?? 0}`,
    '',
  ];
  return utf8(lines.join('\n'));
}

/** 文档级签名的覆盖清单：文件名沿用 OFD 容器内路径，导出时一一对应 */
export const DOCUMENT_COVERS = ['Document.xml', 'Pages/Page_0/Content.xml', 'MachineReadable.xml'] as const;

export function documentSignatureTargets(doc: DocumentModel, nodesDigest: string): SignatureTarget[] {
  return [
    { path: 'Document.xml', bytes: documentSnapshot(doc) },
    { path: 'Pages/Page_0/Content.xml', bytes: utf8(`ofd-content/v1\nnodesDigest=${nodesDigest}\n`) },
    {
      path: 'MachineReadable.xml',
      bytes: utf8(
        [
          'ofd-machine/v1',
          `sourceHash=${doc.machineReadable?.sourceHash ?? ''}`,
          `dataElements=${doc.machineReadable?.dataElements.length ?? 0}`,
          `keyContentRefs=${doc.machineReadable?.keyContentRefs?.length ?? 0}`,
          '',
        ].join('\n'),
      ),
    },
  ];
}

export { fromHex, toHex };
