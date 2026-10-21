import type { SqliteDatabase } from '../storage/sqlite.ts';
import { GENESIS_HASH, type ChainedAdminAuditRecord } from './admin-audit-store.ts';
import { toBase64, fromBase64 } from '../crypto/signature.ts';
import { utf8 } from '../crypto/sm3.ts';
import type { SyncSigner } from '../crypto/provider.ts';

export const ANCHOR_FORMAT = 'l0-admin-audit-anchor';
export const ANCHOR_VERSION = 1;

export interface AuditHead {
  seq: number;
  hash: string;
}

/** 一条锚点 = 链头 + 何时锚的 + （可选）签名 */
export interface AuditAnchor extends AuditHead {
  at: string;
  /** 规范化文本的 SM2 签名（base64 的 DER）。未签名时缺省 */
  signature?: string;
  signerFingerprint?: string;
}

export function anchorText(head: AuditHead, at: string): string {
  return `${ANCHOR_FORMAT}/v${ANCHOR_VERSION}\nseq=${head.seq}\nhash=${head.hash}\nat=${at}`;
}

export function headOf(records: ChainedAdminAuditRecord[]): AuditHead | null {
  const last = records[records.length - 1];
  return last ? { seq: last.seq, hash: last.hash } : null;
}

/** 用给定签名者签一条锚点（签的是 `anchorText`，不是 JSON） */
export function signAnchor(head: AuditHead, at: string, signer: SyncSigner): AuditAnchor {
  return {
    ...head,
    at,
    signature: toBase64(signer.sign(utf8(anchorText(head, at)))),
    signerFingerprint: signer.fingerprint,
  };
}

export type AnchorStatus =
  | 'match'
  | 'mismatch'
  | 'none';

export interface AnchorReport {
  status: AnchorStatus;
  code: string | null;
  message: string;
  /** 锚点是否带签名 */
  signed: boolean;
  headSeq: number | null;
  headHash: string | null;
  anchorSeq: number | null;
  anchorAt: string | null;
  unanchored: number;
}

export const ANCHOR_ERRORS = {
  E_AUDIT_ANCHOR_MISMATCH: 'E_AUDIT_ANCHOR_MISMATCH',
  /** 锚点签名验不过（不是持有该密钥的一方签的） */
  E_AUDIT_ANCHOR_SIGNATURE: 'E_AUDIT_ANCHOR_SIGNATURE',
} as const;

export interface AnchorVerifyOptions {
  verify?: (text: string, signature: Uint8Array) => boolean;
}

function report(partial: Partial<AnchorReport> & { status: AnchorStatus; message: string }): AnchorReport {
  return {
    code: null,
    signed: false,
    headSeq: null,
    headHash: null,
    anchorSeq: null,
    anchorAt: null,
    unanchored: 0,
    ...partial,
  };
}

export function verifyAnchor(
  records: ChainedAdminAuditRecord[],
  anchor: AuditAnchor | null,
  options: AnchorVerifyOptions = {},
): AnchorReport {
  const head = headOf(records);
  const base: Partial<AnchorReport> = {
    headSeq: head?.seq ?? null,
    headHash: head?.hash ?? null,
  };

  if (!anchor) {
    return report({
      ...base,
      status: 'none',
      message:
        '未锚定：链本身自洽，但"删掉尾部若干条"与"整条链重写"**无法检出**' +
        '（链内校验只看内部一致性）——需要有链外的参照点',
    });
  }

  const anchored: Partial<AnchorReport> = { ...base, signed: anchor.signature !== undefined, anchorSeq: anchor.seq, anchorAt: anchor.at };

  if (anchor.signature !== undefined) {
    if (!options.verify) {
      return report({
        ...anchored,
        status: 'mismatch',
        code: ANCHOR_ERRORS.E_AUDIT_ANCHOR_SIGNATURE,
        message: '锚点带签名，但本次没有提供验签能力：**验不了不能算通过**（fail-closed）——' +
          '请用审计查看方钉住的公钥来验',
      });
    }
    const okSignature = options.verify(anchorText({ seq: anchor.seq, hash: anchor.hash }, anchor.at), fromBase64(anchor.signature));
    if (!okSignature) {
      return report({
        ...anchored,
        status: 'mismatch',
        code: ANCHOR_ERRORS.E_AUDIT_ANCHOR_SIGNATURE,
        message: '锚点签名验不过：这份锚点不是持有该密钥的一方签的（**锚点本身被动过**，或其私钥已泄露）',
      });
    }
  }

  if (!head) {
    return report({
      ...anchored,
      status: 'mismatch',
      code: ANCHOR_ERRORS.E_AUDIT_ANCHOR_MISMATCH,
      message: `锚点指向第 ${anchor.seq} 条，但当前记录为空 —— **尾部被删光**（或审计表被清空）`,
    });
  }
  if (records.length < anchor.seq) {
    return report({
      ...anchored,
      status: 'mismatch',
      code: ANCHOR_ERRORS.E_AUDIT_ANCHOR_MISMATCH,
      message: `锚点指向第 ${anchor.seq} 条，当前只有 ${records.length} 条 —— **尾部被删**（链内校验发现不了这类改动）`,
    });
  }
  const anchoredRecord = records[anchor.seq - 1];
  if (!anchoredRecord || anchoredRecord.hash !== anchor.hash) {
    return report({
      ...anchored,
      status: 'mismatch',
      code: ANCHOR_ERRORS.E_AUDIT_ANCHOR_MISMATCH,
      message:
        `第 ${anchor.seq} 条与锚点不符（锚点 ${anchor.hash.slice(0, 12)}…，` +
        `当前 ${(anchoredRecord?.hash ?? '(不存在)').slice(0, 12)}…）—— 该条被改，或**整条链被重写**`,
    });
  }

  const unanchored = records.length - anchor.seq;
  return report({
    ...anchored,
    status: 'match',
    unanchored,
    message:
      unanchored === 0
        ? `已锚定到链头（第 ${anchor.seq} 条），且${anchor.signature ? '带签名' : '未签名'}`
        : `锚点（第 ${anchor.seq} 条）与当前链一致；其后的 ${unanchored} 条**尚无锚点** —— 这批被删仍检不出来，` +
          '需再次锚定（锚定应当周期性做，且最好由审计查看方保存）',
  });
}

export interface AnchorLoadReport {
  firstRun: boolean;
  anchors: AuditAnchor[];
  error: string | null;
}

export const ADMIN_AUDIT_ANCHOR_TABLE = 'admin_audit_anchor';

export class AuditAnchorStore {
  private anchors: AuditAnchor[] = [];

  private readonly db: SqliteDatabase;

  constructor(db: SqliteDatabase) {
    this.db = db;
  }

  get table(): string {
    return ADMIN_AUDIT_ANCHOR_TABLE;
  }

  list(): AuditAnchor[] {
    return [...this.anchors];
  }

  count(): number {
    return this.anchors.length;
  }

  latest(): AuditAnchor | null {
    return this.anchors[this.anchors.length - 1] ?? null;
  }

  load(): AnchorLoadReport {
    const rows = this.db
      .prepare('select head_seq, head_hash, at, signature, signer_fingerprint from admin_audit_anchor order by head_seq asc, at asc')
      .all() as unknown as Array<{
      head_seq?: number;
      head_hash?: string;
      at?: string;
      signature?: string | null;
      signer_fingerprint?: string | null;
    }>;
    if (rows.length === 0) {
      this.anchors = [];
      return { firstRun: true, anchors: [], error: null };
    }

    const parsed: AuditAnchor[] = [];
    let error: string | null = null;
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index] as (typeof rows)[number];
      if (!Number.isInteger(Number(row.head_seq)) || typeof row.head_hash !== 'string' || typeof row.at !== 'string') {
        error = `锚点第 ${index + 1} 行缺少必要字段（head_seq/head_hash/at），疑似被改动`;
        break;
      }
      parsed.push({
        seq: Number(row.head_seq),
        hash: String(row.head_hash),
        at: String(row.at),
        ...(row.signature === null || row.signature === undefined ? {} : { signature: String(row.signature) }),
        ...(row.signer_fingerprint === null || row.signer_fingerprint === undefined
          ? {}
          : { signerFingerprint: String(row.signer_fingerprint) }),
      });
    }
    this.anchors = parsed;
    return { firstRun: false, anchors: [...parsed], error };
  }

  append(anchor: AuditAnchor): boolean {
    const result = this.db
      .prepare(
        `insert or ignore into admin_audit_anchor (head_seq, head_hash, at, signature, signer_fingerprint)
         values (?, ?, ?, ?, ?)`,
      )
      .run(anchor.seq, anchor.hash, anchor.at, anchor.signature ?? null, anchor.signerFingerprint ?? null);
    const inserted = Number(result.changes) > 0;
    if (inserted) this.anchors.push(anchor);
    return inserted;
  }
}

export const EMPTY_HEAD: AuditHead = { seq: 0, hash: GENESIS_HASH };
