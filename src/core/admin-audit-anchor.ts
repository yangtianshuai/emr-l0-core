/**
 * 审计链头锚定：把"链头是哪一条"钉在链**之外**。
 *
 * ## 它补的是链式摘要**结构上补不了**的两类
 *
 * 链内校验（`admin-audit-store.ts`）只保证"内部自洽"。于是有两类改动它查不出来：
 *   ① **删掉尾部若干条** —— 前缀仍然是一条完好的链，`load()` 报 `loaded === totalInFile`、无问题；
 *   ② **整条链重写** —— 把某条内容改掉之后把所有 `hash`/`prevHash` 重算一遍，同样自洽。
 * 这两类恰好是**最值得做的**篡改（把不利于自己的最近几条抹掉）。要检出它们，
 * 必须有链外的参照点：这就是锚点。
 *
 * ## 语义是"检查点"，不是"链头必须相等"
 *
 * 锚点锚的是**签发那一刻的链头**。之后继续追加记录是**正常**的，所以
 * "当前链头 ≠ 锚点"不是问题。真正要比的是：
 * **锚点指向的第 N 条记录，现在还在不在、内容有没有变**。
 * 于是：
 *   - 当前链长度 < N ⇒ 尾部被删（**检出**）；
 *   - 第 N 条的 hash 与锚点不符 ⇒ 那一条被改、或整链被重写（**检出**）；
 *   - 当前链更长 ⇒ 正常追加；但**锚点之后那批还没有锚点**，必须如实报出来
 *     （否则"最近几条被删"在下一次锚定之前依然检不出来 —— 这正是要**周期性**锚定的原因）。
 *
 * ## 签名防什么、不防什么（这一条最容易被说错）
 *
 * 锚点用既有的 SM2 原语签名（`crypto/provider.ts`，不新增密码学代码）。
 *   - **防**：只改审计文件的人 —— 他能重算链，但签不出锚点；
 *   - **不防**：拿得到签名私钥的人。库里的 `config.system.anchorSeed` 若用默认演示种子，
 *     种子是公开的、任何拿到代码的人都能推导出私钥，**于是他能重签锚点**。
 *     `audit-anchor-self-test` 里有一条用例把这个边界**做成可执行的事实**（而不是一句注释）。
 *   - 真正要防"能改文件的人"，需要两件事同时成立：私钥在受控设备里；
 *     **公钥钉在审计查看方**（不在被审的这台机器上）—— 这台机器上的验签只能自证。
 *
 * 也就是说：这一层把"局部改一条"抬到"删尾/重写也能被发现"，但它**不是合规级存证**。
 * 合规级存证需要外部时间戳/独立审计服务（把锚点发出去、由对方保存），本模块不做。
 */

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

/**
 * 被签名的规范化文本：**字段固定、顺序固定、分隔固定**。
 * 与签名链的 `SignedInfo`、信封的 `canonicalHeader` 同一纪律 ——
 * 协议字节不能随对象属性顺序或实现细节漂移，否则"换个序列化实现就验不过"。
 */
export function anchorText(head: AuditHead, at: string): string {
  return `${ANCHOR_FORMAT}/v${ANCHOR_VERSION}\nseq=${head.seq}\nhash=${head.hash}\nat=${at}`;
}

/** 链头（空链返回 null：**空链不锚**，它的意义只有"什么都没有"） */
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
  /** **已检出**：链尾被删、那一条被改、或整链被重写（也可能是锚点自己被动过） */
  | 'mismatch'
  /** 没有锚点：链内部自洽，但删尾与整链重写**无从判断**（不是"通过"） */
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
  /** 锚点之后又追加了多少条（**这批尚未被任何锚点覆盖**，被删仍检不出） */
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
   * 验签函数。**给了才能验带签名的锚点**。
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
 * 比对链与锚点。**纯函数**：不做任何 IO，锚点由调用方读出来（便于用用例构造各种篡改形态）。
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

  /* ① 签名先验：锚点自己不可信时，拿它比对链是没有意义的（先报更根本的那个问题） */
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

  /* ② 锚点指向的那一条必须还在 */
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
  /** 读到坏行时的说明（**不静默跳过**：坏行本身就是要报的事） */
  error: string | null;
}

/** 锚点表名（界面要显示"锚记在哪"） */
export const ADMIN_AUDIT_ANCHOR_TABLE = 'admin_audit_anchor';

/**
 * 锚点存储：入库（原先是一个 NDJSON 文件）。
 *
 * 入库带来的两条**语义**变化，都写在这里而不是留给读者去猜：
 *
 *   ① **同一条链头锚两次 = 同一条**（主键 `(head_seq, head_hash)`，`append` 是幂等的）。
 *      文件时代每次"再锚一次"都会多一行（实测堆到 286 条互相污染的锚）——
 *      而"锚了多少次"与"链被锚到了哪里"是两件事，混在一起之后谁也看不懂。
 *   ② **多进程不再互相污染**：文件是各自追加，库是同一份数据 ——
 *      "两条链的锚混在一个文件里"这个根不存在了。
 *
 * 仍然**不做验签**：验签是 `verifyAnchor` 的事，存储只负责如实读出来
 * （把"读到了什么"与"它可不可信"分开，是这两个模块能各自被单独审的原因）。
 */
export class AuditAnchorStore {
  private anchors: AuditAnchor[] = [];

  private readonly db: SqliteDatabase;

  constructor(db: SqliteDatabase) {
    this.db = db;
  }

  get table(): string {
    return ADMIN_AUDIT_ANCHOR_TABLE;
  }

  /** 全部锚点（追加顺序）。**不做验签**：验签是 `verifyAnchor` 的事，存储只负责如实读出来 */
  list(): AuditAnchor[] {
    return [...this.anchors];
  }

  count(): number {
    return this.anchors.length;
  }

  /** 最新一条锚点（比对时用**最新**的那条：它才覆盖到最靠近现在的记录） */
  latest(): AuditAnchor | null {
    return this.anchors[this.anchors.length - 1] ?? null;
  }

  /**
   * 读库。坏行（缺少必要字段）**不静默跳过**：坏行本身就是要报的事。
   *
   * 与审计日志不同，锚点**不逐条验链**（锚点之间没有链关系，它们各自指向某个链头），
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
   * 追加一条锚点。返回 `true` = 这次真的写进去了；`false` = 这条链头**早就锚过**
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
