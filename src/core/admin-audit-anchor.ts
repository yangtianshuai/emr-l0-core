// 审计链头锚定：把"链头是哪一条"钉在链之外。
// - 不防：拿得到签名私钥的人。库里的 `config.system.anchorSeed` 若用默认演示种子，
// 种子是公开的、任何拿到代码的人都能推导出私钥，于是他能重签锚点。

import type { SqliteDatabase } from '../storage/sqlite.ts';
import { GENESIS_HASH, type ChainedAdminAuditRecord } from './admin-audit-store.ts';
import { toBase64, fromBase64 } from '../crypto/signature.ts';
import { utf8 } from '../crypto/sm3.ts';
import type { SyncSigner } from '../crypto/provider.ts';

export const ANCHOR_FORMAT = 'l0-admin-audit-anchor';
export const ANCHOR_VERSION = 1;

/** 链头：第几条 + 它的摘要 */
export interface AuditHead {
  seq: number;
  hash: string;
}

/** 一条锚点 = 链头 + 何时锚的 + （可选）签名 */
export interface AuditAnchor extends AuditHead {
  at: string;
  /** 规范化文本的 SM2 签名（base64 的 DER）。未签名时缺省 */
  signature?: string;
  /** 签名者公钥指纹（`SM3(SPKI)` 完整 64 位，与 recipient-keys / 阅读授权源同一口径） */
  signerFingerprint?: string;
}

export function anchorText(head: AuditHead, at: string): string {
  return `${ANCHOR_FORMAT}/v${ANCHOR_VERSION}\nseq=${head.seq}\nhash=${head.hash}\nat=${at}`;
}

/** 链头（空链返回 null：空链不锚，它的意义只有"什么都没有"）  */
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
  /** 锚点指向的那一条仍在且未变 */
  | 'match'
  /** 已检出：链尾被删、那一条被改、或整链被重写（也可能是锚点自己被动过）  */
  | 'mismatch'
  /** 没有锚点：链内部自洽，但删尾与整链重写无从判断（不是"通过"）  */
  | 'none';

export interface AnchorReport {
  status: AnchorStatus;
  /** 仅 `mismatch` 时非空的错误码 */
  code: string | null;
  message: string;
  /** 锚点是否带签名 */
  signed: boolean;
  /** 当前链头（空链为 null） */
  headSeq: number | null;
  headHash: string | null;
  anchorSeq: number | null;
  anchorAt: string | null;
  /** 锚点之后又追加了多少条（这批尚未被任何锚点覆盖，被删仍检不出）  */
  unanchored: number;
}

export const ANCHOR_ERRORS = {
  /** 锚点指向的记录不见了 / 内容变了 —— 这就是"检出篡改" */
  E_AUDIT_ANCHOR_MISMATCH: 'E_AUDIT_ANCHOR_MISMATCH',
  /** 锚点签名验不过（不是持有该密钥的一方签的） */
  E_AUDIT_ANCHOR_SIGNATURE: 'E_AUDIT_ANCHOR_SIGNATURE',
} as const;

export interface AnchorVerifyOptions {
  /**
   * 验签函数。给了才能验带签名的锚点。
   *
   * 带签名却没给验签能力时，结果是 `mismatch`（fail-closed）而不是"通过"：
   * "有签名但我验不了"与"验过了没问题"是两件事，前者不能当作后者
   * （同 `persistence.ts` 的口径：读不出来绝不当成空数据）。
    */
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

/**
 * 比对链与锚点。纯函数：不做任何 IO，锚点由调用方读出来（便于用用例构造各种篡改形态）。
  */
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
  /** 读到坏行时的说明（不静默跳过：坏行本身就是要报的事）  */
  error: string | null;
}

/** 锚点表名（界面要显示"锚记在哪"） */
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

  /** 全部锚点（追加顺序）。不做验签：验签是 `verifyAnchor` 的事，存储只负责如实读出来  */
  list(): AuditAnchor[] {
    return [...this.anchors];
  }

  count(): number {
    return this.anchors.length;
  }

  /** 最新一条锚点（比对时用最新的那条：它才覆盖到最靠近现在的记录）  */
  latest(): AuditAnchor | null {
    return this.anchors[this.anchors.length - 1] ?? null;
  }

  /**
   * 读库。坏行（缺少必要字段）不静默跳过：坏行本身就是要报的事。
   *
   * 与审计日志不同，锚点不逐条验链（锚点之间没有链关系，它们各自指向某个链头），
   * 所以这里只做形状校验；"这条锚点与当前链一致吗"由 `verifyAnchor` 回答。
    */
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

  /**
   * 追加一条锚点。返回 `true` = 这次真的写进去了；`false` = 这条链头早就锚过
   * （幂等：重复锚定不产生第二行，也不报错 —— 它不是异常，是同一件事做第二遍）。
    */
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

/** 空链的链头（仅用于说明"空链不锚"，避免调用方手写全零常量） */
export const EMPTY_HEAD: AuditHead = { seq: 0, hash: GENESIS_HASH };
