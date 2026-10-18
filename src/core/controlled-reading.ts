// T18 · 受控阅读（归档件的阅读授权控制）。

import { sm3Hex, utf8 } from '../crypto/sm3.ts';
import {
  SIGNATURE_ALGORITHM,
  softwareSigner,
  demoKeyPair,
  type Signer,
} from '../crypto/provider.ts';
import { signTargets, verifyTargets, type ReferenceEntry, type SignatureBlock } from '../crypto/signature.ts';
import { publicKeyFingerprint } from '../crypto/sm2.ts';
import { hashNodes } from '../model/hash.ts';
import type { DocumentModel } from '../model/types.ts';

export interface ReadingGrant {
  grantId: string;
  docId: string;
  /** 文档内容指纹：被授权阅读的就是这一份内容，文档改动后旧凭证立即失效  */
  documentFingerprint: string;
  notBefore: string;
  notAfter: string;
  /** 最大阅读次数；null = 不限次（仅建议用于院内长期授权） */
  maxReads: number | null;
  /** 允许的环境指纹（空 = 不限环境；非空 = 只能在这些终端读） */
  allowedEnvironments: string[];
  /** 允许阅读的章节 id 白名单；包含 '*' 表示全部；空数组 = 什么都不放行（fail-closed）  */
  allowedSections: string[];
  /** 是否隐藏患者身份（姓名/就诊号以外的一切标识不进入视图） */
  concealPatientIdentity: boolean;
  issuedBy: string;
  issuedAt: string;
  purpose: string;
  // ② 把授权书转给第三人 → 他没有对应私钥，解不出内容密钥（换了终端也一样）；

  keyDelivery?: ReadingKeyDelivery;
}

/** 内容密钥的交付片段（放进授权书，随授权书一起被签名） */
export interface ReadingKeyDelivery {
  /** 被授权阅读的那一份明文的 SM3：绑定"授权的是这份内容"  */
  plaintextDigest: string;
  /** SM2 封装的内容密钥（C1C3C2，base64） */
  wrappedKey: string;
  /** 接收方公钥指纹（SM3(SPKI)）：没有对应私钥就解不开 */
  recipientFingerprint: string;
}

export interface ReadingCredential {
  grant: ReadingGrant;
  publicKeyBase64: string;
  publicKeyFingerprint: string;
  signatureValue: string;
  /** 摘要清单（grant 作为"虚拟文件"参与签名，复用文件签名容器） */
  references: ReferenceEntry[];
  signedInfoDigest: string;
}

export interface ReadingContext {
  /** 当前环境指纹（终端号/工作站标识） */
  environmentId: string;
  actorId: string;
  /** 当前时间（ISO） */
  at: string;
  /** 该凭证在此环境已完成的阅读次数（由调用方集中记账）  */
  readCount: number;
}

export interface ReadingField {
  code: string;
  display?: string;
  value: string;
  unit?: string;
}

export interface ReadingSection {
  id: string;
  title: string;
  paragraphs: string[];
  fields: ReadingField[];
}

export interface ReadingView {
  docId: string;
  title: string;
  patientLabel: string;
  reader: string;
  purpose: string;
  validUntil: string;
  remainingReads: number | null;
  sections: ReadingSection[];
  /** 因未授权而被隐藏的章节数（如实告知"有内容你没被授权看"，而不是假装文档就这么点）  */
  concealedSectionCount: number;
  /** 必须随视图展示的告知/水印（受控阅读标识、有效期、用途） */
  notices: string[];
}

export type ReadingDenyCode =
  | 'E_CREDENTIAL_INVALID'
  | 'E_GRANT_REVOKED'
  | 'E_DOCUMENT_CHANGED'
  | 'E_GRANT_NOT_YET_VALID'
  | 'E_GRANT_EXPIRED'
  | 'E_GRANT_EXHAUSTED'
  | 'E_ENVIRONMENT_MISMATCH';

export interface ReadingDecision {
  allowed: boolean;
  code?: ReadingDenyCode;
  reasons: string[];
  view?: ReadingView;
}

/**
 * 文档内容指纹：患者身份 + 就诊 + 文书类型 + 节点树 + 机读摘要 + 签章指纹。
 *
 *  患者身份必须进指纹（实测踩到）：早期版本只放了 `patientId`，
 * 于是"姓名掩码/性别/出生日期被改"不会改变指纹 —— 旧凭证继续有效。
 * 反过来说，指纹是授权的绑定对象：它覆盖什么，授权就保护到什么。
 *
 * 刻意不含 `updatedAt`/`revisions`/`status`：这些是流程元数据，
 * 机读信息重算、状态流转不应让一份合法授权失效（否则每次流程动作都要重签授权）。
  */
export function documentFingerprint(doc: DocumentModel): string {
  const patient = doc.patient;
  const encounter = doc.encounter;
  const lines = [
    'ofd-reading-target/v1',
    `docId=${doc.docId}`,
    `docType=${doc.docType.system}|${doc.docType.code}|${doc.docType.display}`,
    `patient=${patient.patientId}|${patient.nameMasked ?? ''}|${patient.gender ?? ''}|${patient.birthDate ?? ''}`,
    `encounter=${encounter?.visitId ?? ''}|${encounter?.visitType ?? ''}|${encounter?.deptCode ?? ''}|${encounter?.admittedAt ?? ''}`,
    `created=${doc.createdAt}|${doc.createdBy}`,
    `nodesHash=${hashNodes(doc.nodes)}`,
    `machineSourceHash=${doc.machineReadable?.sourceHash ?? ''}`,
    `signatureFingerprint=${doc.signatureRefs?.[0]?.publicKeyFingerprint ?? ''}`,
    '',
  ];
  return sm3Hex(utf8(lines.join('\n')));
}

/**
 * 授权书的规范化字节：字段顺序固定、清单排序 —— 任何字段变化都会让签名失效。
 * 与文件签名共用同一套"规范化文本 + SM3 + SM2"的纪律，便于第三方复算。
 */
export function canonicalGrant(grant: ReadingGrant): Uint8Array {
  return utf8(
    [
      'ofd-reading-grant/v1',
      `grantId=${grant.grantId}`,
      `docId=${grant.docId}`,
      `documentFingerprint=${grant.documentFingerprint}`,
      `notBefore=${grant.notBefore}`,
      `notAfter=${grant.notAfter}`,
      `maxReads=${grant.maxReads === null ? 'unlimited' : grant.maxReads}`,
      `environments=${[...grant.allowedEnvironments].sort().join(',')}`,
      `sections=${[...grant.allowedSections].sort().join(',')}`,
      `concealPatientIdentity=${grant.concealPatientIdentity ? 'true' : 'false'}`,
      `issuedBy=${grant.issuedBy}`,
      `issuedAt=${grant.issuedAt}`,
      `purpose=${grant.purpose}`,
      /* 加密交付片段也在签名覆盖范围内：少了这一行，"把内容密钥换成别人的"就不需要重签授权 */
      `keyDelivery=${
        grant.keyDelivery
          ? `${grant.keyDelivery.recipientFingerprint}:${grant.keyDelivery.wrappedKey}:${grant.keyDelivery.plaintextDigest}`
          : 'none'
      }`,
      '',
    ].join('\n'),
  );
}

export async function issueReadingGrant(grant: ReadingGrant, signer: Signer): Promise<ReadingCredential> {
  const block = await signTargets(
    [{ path: `grant/${grant.grantId}`, bytes: canonicalGrant(grant) }],
    {
      signatureRef: grant.grantId,
      documentId: grant.docId,
      signerRole: 'author',
      signerId: grant.issuedBy,
      signedAt: grant.issuedAt,
    },
    signer,
  );
  return {
    grant,
    publicKeyBase64: block.publicKeyBase64,
    publicKeyFingerprint: block.publicKeyFingerprint,
    signatureValue: block.signatureValue,
    references: block.references,
    signedInfoDigest: block.signedInfoDigest,
  };
}

export const DEMO_READING_ISSUER_SEED = 'l0-demo-reading-issuer';

export function demoReadingIssuer(seed = DEMO_READING_ISSUER_SEED): Signer {
  return softwareSigner(demoKeyPair(seed).privateKey);
}

/**
 * 演示替身授权源的公钥指纹 = `demo` 模式下的信任根。
 *
 * 单独导出它，是为了让"信任的是哪把钥匙"只有一处定义：界面显示的、
 * 配置校验比对的、凭据登记时核对的，必须是同一个值。
  */
export function demoReadingIssuerFingerprint(): string {
  return publicKeyFingerprint(demoKeyPair(DEMO_READING_ISSUER_SEED).publicKey);
}

function blockOf(credential: ReadingCredential): SignatureBlock {
  return {
    meta: {
      signatureRef: credential.grant.grantId,
      documentId: credential.grant.docId,
      signerRole: 'author',
      signerId: credential.grant.issuedBy,
      signedAt: credential.grant.issuedAt,
      algorithm: SIGNATURE_ALGORITHM,
      provider: 'software',
    },
    publicKeyBase64: credential.publicKeyBase64,
    publicKeyFingerprint: credential.publicKeyFingerprint,
    references: credential.references,
    signedInfoDigest: credential.signedInfoDigest,
    signatureValue: credential.signatureValue,
  };
}

/** 校验凭证本身（签名、公钥指纹、授权书内容是否被改）—— 与文档、时间、次数无关 */
export function verifyCredential(credential: ReadingCredential): { ok: boolean; reasons: string[] } {
  const block = blockOf(credential);
  const result = verifyTargets(block, [{ path: `grant/${credential.grant.grantId}`, bytes: canonicalGrant(credential.grant) }]);
  return { ok: result.ok, reasons: result.reasons };
}

function allowedSection(grant: ReadingGrant, sectionId: string): boolean {
  if (grant.allowedSections.includes('*')) return true;
  return grant.allowedSections.includes(sectionId);
}

function buildView(grant: ReadingGrant, doc: DocumentModel, remainingReads: number | null): ReadingView {
  const nodes = doc.nodes;
  const childrenOf = (parentId: string): typeof nodes[string][] =>
    Object.values(nodes)
      .filter((node) => node.parentId === parentId)
      .sort((a, b) => a.order - b.order);

  const sections: ReadingSection[] = [];
  let concealed = 0;

  for (const node of Object.values(nodes)) {
    if (node.type !== 'section') continue;
    let authorised = allowedSection(grant, node.id);
    /* 白名单可以按章节编码授权：临床场景里"给他看检验，不给看精神科记录"是按章节语义说的 */
    if (!authorised && node.sectionCode && allowedSection(grant, node.sectionCode)) authorised = true;
    if (!authorised) {
      concealed += 1;
      continue;
    }

    const paragraphs: string[] = [];
    const fields: ReadingField[] = [];
    const collect = (parentId: string): void => {
      for (const child of childrenOf(parentId)) {
        if (child.type === 'paragraph' || child.type === 'listItem') {
          const text = childrenOf(child.id)
            .filter((item) => item.type === 'text')
            .flatMap((item) => (item.type === 'text' ? item.runs.map((run) => run.text) : []))
            .join('')
            .trim();
          if (text !== '') paragraphs.push(text);
        }
        if (child.type === 'field') {
          const tag = child.tags?.[0];
          fields.push({
            code: tag?.code ?? '（无编码）',
            ...(tag?.display ? { display: tag.display } : {}),
            value: child.valueText ?? String(child.value ?? ''),
            ...(child.unit ? { unit: child.unit } : {}),
          });
        }
        collect(child.id);
      }
    };
    collect(node.id);
    sections.push({ id: node.id, title: node.title ?? '', paragraphs, fields });
  }

  return {
    docId: doc.docId,
    title: doc.docType.display,
    patientLabel: grant.concealPatientIdentity ? '（患者身份已隐藏）' : doc.patient.nameMasked ?? doc.patient.patientId,
    reader: grant.issuedBy,
    purpose: grant.purpose,
    validUntil: grant.notAfter,
    remainingReads,
    sections,
    concealedSectionCount: concealed,
    notices: [
      `受控阅读：本视图按授权 ${grant.grantId} 生成，仅限 ${grant.purpose}`,
      `有效期至 ${grant.notAfter}${remainingReads === null ? '' : `，剩余阅读次数 ${remainingReads}`}`,
      grant.concealPatientIdentity ? '患者身份已隐藏（授权要求）' : '请在授权范围内使用，阅后按规保存',
    ],
  };
}

/**
 * 受控阅读：先验凭证，再逐项判定（撤销 → 文档是否被改 → 有效期 → 次数 → 环境），
 * 全部通过才返回受控视图。任何一项不满足都拒绝，并给出可读原因。
 *
 * 拒绝原因用独立错误码而不是一句"无权访问"：运维要能区分"过期"和"环境不对"，
 * 否则只能把所有情况都当"系统坏了"处理。
  */
export function openForReading(
  credential: ReadingCredential,
  doc: DocumentModel,
  context: ReadingContext,
  options: { revokedGrantIds?: string[] } = {},
): ReadingDecision {
  const credentialCheck = verifyCredential(credential);
  if (!credentialCheck.ok) {
    return {
      allowed: false,
      code: 'E_CREDENTIAL_INVALID',
      reasons: [`授权凭证无效（已被篡改或不是本签发者签发）：${credentialCheck.reasons.join('；')}`],
    };
  }

  const grant = credential.grant;
  if ((options.revokedGrantIds ?? []).includes(grant.grantId)) {
    return { allowed: false, code: 'E_GRANT_REVOKED', reasons: [`授权 ${grant.grantId} 已被撤销`] };
  }

  if (grant.docId !== doc.docId) {
    return { allowed: false, code: 'E_DOCUMENT_CHANGED', reasons: [`凭证是为了文档 ${grant.docId} 签发的，当前文档是 ${doc.docId}`] };
  }
  const current = documentFingerprint(doc);
  if (current !== grant.documentFingerprint) {
    return {
      allowed: false,
      code: 'E_DOCUMENT_CHANGED',
      reasons: ['文档内容与授权时不一致（内容被改动过）：旧凭证不再适用，需重新签发'],
    };
  }

  const at = Date.parse(context.at);
  if (Number.isNaN(at)) return { allowed: false, code: 'E_CREDENTIAL_INVALID', reasons: [`阅读时间非法：${context.at}`] };
  if (at < Date.parse(grant.notBefore)) {
    return { allowed: false, code: 'E_GRANT_NOT_YET_VALID', reasons: [`授权自 ${grant.notBefore} 起生效，当前 ${context.at}`] };
  }
  if (at > Date.parse(grant.notAfter)) {
    return { allowed: false, code: 'E_GRANT_EXPIRED', reasons: [`授权已于 ${grant.notAfter} 过期，当前 ${context.at}`] };
  }

  if (grant.maxReads !== null && context.readCount >= grant.maxReads) {
    return {
      allowed: false,
      code: 'E_GRANT_EXHAUSTED',
      reasons: [`授权允许阅读 ${grant.maxReads} 次，已用完（当前已读 ${context.readCount} 次）`],
    };
  }

  if (grant.allowedEnvironments.length > 0 && !grant.allowedEnvironments.includes(context.environmentId)) {
    return {
      allowed: false,
      code: 'E_ENVIRONMENT_MISMATCH',
      reasons: [
        `授权限定在指定终端阅读（${grant.allowedEnvironments.join('、')}），当前终端 ${context.environmentId}`,
        '凭证不可转让：换终端需要重新签发',
      ],
    };
  }

  const remainingReads = grant.maxReads === null ? null : Math.max(0, grant.maxReads - context.readCount - 1);
  return { allowed: true, reasons: [], view: buildView(grant, doc, remainingReads) };
}
