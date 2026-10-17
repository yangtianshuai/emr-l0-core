/**
 * T18 签名容器：SignedInfo 构造、签名与**独立验签**。
 *
 * 设计要点（都是为了"第三方不看我们代码也能验"）：
 *   1) **SignedInfo 是规范化文本**：行式、固定字段顺序、reference 按路径排序 ——
 *      人类可读、可手工复算，任何字段变化都会改变摘要；
 *   2) **摘要用 SM3**：每个被覆盖文件各算一份，签名不直接签"文件拼接"，而是签"摘要清单"，
 *      这样能精确定位"哪个文件被改了"，而不是只报"验签失败"；
 *   3) **公钥随签名走**（SPKI base64）：验签只需要文件本身 + 算法（SM2-SM3），
 *      不需要接触签名方的任何代码或数据库；
 *   4) **签名覆盖范围显式列出**，并明确不含 status / revisions / signatureRefs ——
 *      否则"签章动作本身"（改状态、追加留痕）会把签名弄失效（自引用问题）。
 *
 * ⚠️ 与算法层同样的边界：本容器用于原型与演示；生产须换成经认证的密码模块，
 *    并且私钥必须由设备保管（本仓库的演示私钥可由种子推导，**绝不可用于生产**）。
 */

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
  /** SM3（十六进制小写） */
  digest: string;
}

export interface SignatureBlock {
  meta: SignatureMeta;
  /** 公钥 SPKI 的 base64（第三方验签只需它） */
  publicKeyBase64: string;
  publicKeyFingerprint: string;
  /** 按 path 排序的摘要清单 */
  references: ReferenceEntry[];
  /** SM3(SignedInfo) —— 签名实际签的是它 */
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

/**
 * 规范化 SignedInfo。
 * **字段顺序、分隔符、排序规则都是协议的一部分**：改动其中任何一项，
 * 都会让"旧签名验不过、而双方都觉得自己没改"——所以有专门用例锁死这个字节序列。
 */
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

/**
 * 对一组文件签名（文件内容先各自 SM3，再签摘要清单）。
 *
 * ⚠️ **异步**：签名后端可能是网络服务或密码设备（`Signer.sign` 允许返回 Promise）。
 * 这里是内核里**唯一** await 签名值的地方 —— 其余调用方只需把 async 沿调用链传出去。
 * 先算 references 与 SignedInfo（同步、纯函数），再 await 签名值：这样"待签什么"与"谁来签"
 * 两件事保持分离，第三方也能用 `canonicalSignedInfo()` 独立复算。
 */
/** 摘要清单：按路径排序后各自 SM3（排序保证"文件顺序无关"，改顺序不会改签名） */
function referencesOf(targets: SignatureTarget[]): ReferenceEntry[] {
  return [...targets]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((target) => ({ path: target.path, digest: sm3Hex(target.bytes) }));
}

/**
 * **只算 SignedInfo 摘要，不签名**。
 *
 * 用途：签名值可能与"提交"分离 —— 签名后端是网络服务 / 密码设备时，必须先 `await` 拿到签名值，
 * 再进入同步的提交路径。那时提交时就要能回答"现在这份内容，与刚才送去签的是不是同一份"，
 * 比对的就是这个摘要（见 `WriteSession.sign()` 的复算校验）。
 *
 * 它与 `signTargets()` **共用同一段规范化逻辑**（`referencesOf`），因此两者永不漂移。
 */
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
  /** 诊断信息，便于审计与排错 */
  details: { algorithm: string; provider: string; publicKeyFingerprint: string; referenceCount: number };
}

/** 按算法标识选择验签器：**验签只依赖算法与公钥，与签名方用什么后端无关** */
export function verifierFor(algorithm: string, publicKey: Sm2Point): Verifier | null {
  if (algorithm === SIGNATURE_ALGORITHM) return softwareVerifier(publicKey);
  return null;
}

/**
 * 独立验签：重新计算文件摘要 → 重建 SignedInfo → 用公钥验签名。
 *
 * `requireAllCovered`（默认 true）：是否要求"传入的文件必须全部被签名覆盖"。
 *   - 文档级验签（内存文档）用 true：多出的内容必须报出来；
 *   - **容器级验签（OFD 容器）必须用 false**：容器里天然有大量未被签名覆盖的文件
 *     （OFD.xml、DocumentRes.xml…），要求全覆盖会把正常文件判成失败。
 */
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

  /* ① 文件摘要：逐个比对，明确指出被改动的文件 */
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

  /* ② SignedInfo 摘要：元数据或摘要清单被改动都能检出 */
  const info = canonicalSignedInfo(block.meta, block.references, block.publicKeyFingerprint);
  if (sm3Hex(info) !== block.signedInfoDigest) reasons.push('SignedInfo 已被改动（元数据或摘要清单不一致）');

  /* ③ 公钥自洽：指纹必须与公钥匹配，否则"换了把钥匙"也能假装通过 */
  let publicKey: Sm2Point;
  try {
    publicKey = publicKeyFromSpki(fromBase64(block.publicKeyBase64));
  } catch (err) {
    reasons.push(`公钥格式非法：${(err as Error).message}`);
    return { ok: false, reasons, details };
  }
  if (publicKeyFingerprint(publicKey) !== block.publicKeyFingerprint) reasons.push('公钥与其指纹不一致');

  /* ④ 验签 */
  const verifier = verifierFor(block.meta.algorithm, publicKey);
  if (!verifier) {
    reasons.push(`不支持的签名算法：${block.meta.algorithm}（本版本仅支持 ${SIGNATURE_ALGORITHM}）`);
  } else if (!verifier.verify(info, fromBase64(block.signatureValue))) {
    reasons.push('签名验证失败（签名值与 SignedInfo 不匹配）');
  }

  return { ok: reasons.length === 0, reasons, details };
}

/* ------------------------- 文档级目标（内存态签章用） ------------------------- */

/** 文档快照：**只包含"内容"，不含签章动作自身会改动的字段**（status/revisions/signatureRefs/updatedAt） */
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

/** 由文档构造"待签名文件"（文档元数据快照 → Document.xml；节点树摘要 → Content.xml；机读块 → MachineReadable.xml） */
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
