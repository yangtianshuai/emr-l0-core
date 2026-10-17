/**
 * Signatures.xml 的**读写放在同一个模块**。
 *
 * 为什么不让"导出侧写 XML、导入侧读 XML"各写一套：那是经典的漂移源 ——
 * 写入侧加个字段、读取侧不知道，结果"签得进去、认不出来"，
 * 而现象只是"验签失败"，排查要绕一大圈。放一个模块里，并用**往返用例**锁死：
 *   sign → 写 XML → 读回 → 逐字段相等 → 用读回的 block 再验签通过。
 */

import { attrOf, childOf, findAll, findFirst, parseXml, textOf } from '../import/xml.ts';
import type { ReferenceEntry, SignatureBlock } from './signature.ts';

function esc(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char] as string);
}

/** 生成 Signatures.xml（第三方只需这份文件 + 被覆盖文件即可独立验签） */
export function signaturesXml(block: SignatureBlock): string {
  const refs = block.references
    .map((reference) => `      <ofd:Reference FileRef="${esc(reference.path)}" DigestAlgorithm="SM3" Digest="${esc(reference.digest)}"/>`)
    .join('\n');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<ofd:Signatures xmlns:ofd="http://www.ofd.org/OFD">',
    `  <ofd:Signature ID="${esc(block.meta.signatureRef)}">`,
    '    <ofd:SignedInfo>',
    '      <!-- 被签名内容的规范化规则（第三方复算用）：',
    '           由下列字段按固定顺序、以换行符连接，末尾再补一个换行，UTF-8 编码后即为被签名字节：',
    '           ofd-signature/v1 / algorithm / provider / signatureRef / documentId / signerRole /',
    '           signerId / signedAt / publicKeyFingerprint / 各 reference（按 FileRef 升序，格式 <路径>:<SM3摘要>）。',
    '           规则实现见 src/crypto/signature.ts 的 canonicalSignedInfo。 -->',
    `      <ofd:Provider ProviderName="${esc(block.meta.provider)}" Version="1.0"/>`,
    `      <ofd:SignatureMethod>${esc(block.meta.algorithm)}</ofd:SignatureMethod>`,
    `      <ofd:SignatureDateTime>${esc(block.meta.signedAt)}</ofd:SignatureDateTime>`,
    `      <ofd:Signer Role="${esc(block.meta.signerRole)}" ID="${esc(block.meta.signerId)}"/>`,
    `      <ofd:DocumentID>${esc(block.meta.documentId)}</ofd:DocumentID>`,
    `      <ofd:PublicKey Algorithm="SM2" Encoding="SPKI-BASE64" Fingerprint="${esc(block.publicKeyFingerprint)}">${esc(block.publicKeyBase64)}</ofd:PublicKey>`,
    `      <ofd:SignedInfoDigest Algorithm="SM3">${esc(block.signedInfoDigest)}</ofd:SignedInfoDigest>`,
    '      <ofd:References>',
    refs,
    '      </ofd:References>',
    '    </ofd:SignedInfo>',
    `    <ofd:SignedValue>${esc(block.signatureValue)}</ofd:SignedValue>`,
    '  </ofd:Signature>',
    '</ofd:Signatures>',
    '',
  ].join('\n');
}

/** 解析 Signatures.xml；不是签名文件时返回 null（调用方据此区分"未签名"与"签名坏了"） */
export function parseSignaturesXml(text: string): SignatureBlock | null {
  const root = parseXml(text);
  const signature = findFirst(root, 'Signature');
  if (!signature) return null;
  const info = childOf(signature, 'SignedInfo');
  if (!info) return null;

  const references: ReferenceEntry[] = findAll(info, 'Reference').map((node) => ({
    path: attrOf(node, 'FileRef') ?? '',
    digest: attrOf(node, 'Digest') ?? '',
  }));
  const signer = childOf(info, 'Signer');
  const publicKey = childOf(info, 'PublicKey');

  return {
    meta: {
      signatureRef: attrOf(signature, 'ID') ?? '',
      documentId: textOf(childOf(info, 'DocumentID')).trim(),
      signerRole: attrOf(signer, 'Role') ?? '',
      signerId: attrOf(signer, 'ID') ?? '',
      signedAt: textOf(childOf(info, 'SignatureDateTime')).trim(),
      algorithm: textOf(childOf(info, 'SignatureMethod')).trim(),
      provider: attrOf(childOf(info, 'Provider'), 'ProviderName') ?? '',
    },
    publicKeyBase64: textOf(publicKey).trim(),
    publicKeyFingerprint: attrOf(publicKey, 'Fingerprint') ?? '',
    references,
    signedInfoDigest: textOf(childOf(info, 'SignedInfoDigest')).trim(),
    signatureValue: textOf(childOf(signature, 'SignedValue')).trim(),
  };
}
