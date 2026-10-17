/**
 * 工作数据仓储：患者 / 就诊 / 文书（含留痕）/ 旁挂数据 / 小体量数据集。
 *
 * ## 这一层存在的意义
 *
 * 它是**唯一**写 SQL 的地方（除了 `sqlite.ts` 的元数据表）。上层只面对"存一份文书"
 * "读一次就诊的全部文书"这样的说法，不必知道表名、列名与 JSON 之间的映射 ——
 * 于是换成 PostgreSQL 时，改的是这一层与 `schema.ts`，而不是散落各处的调用点。
 *
 * ## 三条约束
 *
 * 1) **一份文书 + 它的留痕在一个事务里写**。分开写会出现"文书写进去了、新的那条留痕没有"
 *    这种谁也没设计过的状态，而它会以"审计少了一条"的形式安静地活着。
 * 2) **读不出来就是读不出来**：解密失败、摘要不符一律返回错误码，绝不返回"空文书" ——
 *    把"解不开"当成"没有"，是最容易把数据丢失伪装成正常的方式。
 * 3) **结构先于内容**：正文行必须先有对应的文书元数据（外键会拒）。这不是限制，
 *    而是把"孤儿正文"这类问题挡在写入那一刻。
 */

import type { DocumentModel } from '../model/types.ts';
import { inTransaction, countOf, type OpenDatabaseResult, type SqliteDatabase } from './sqlite.ts';
import { sealFor, sealValue, unsealValue, type SealedContent, type SealOptions } from './sealed.ts';
import { DOCUMENT_FORMAT, SIDECARS_FORMAT, KV_FORMAT } from './formats.ts';

/** 一份文书在库里的**可查询**元数据（不含内容） */
export interface DocumentMeta {
  docId: string;
  patientId: string;
  visitId: string | null;
  title: string;
  kind: string | null;
  docTypeCode: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  rev: number;
}

export interface StoredDoc {
  docId: string;
  title: string;
  kind?: string;
}

export interface StoredVisit {
  visitId: string;
  visitType: string;
  dept?: string;
  date?: string;
  admittedAt?: string;
  dischargedAt?: string;
  docs: StoredDoc[];
}

export interface StoredPatient {
  patientId: string;
  nameMasked: string;
  gender: string;
  age?: number;
  visits: StoredVisit[];
}

export interface WorkspaceStructure {
  patients: StoredPatient[];
}

/**
 * 落盘冲突：盘上那一版不是我认的那一版。
 * 与文件时代的 `SnapshotConflictError` **同一个错误码**（`E_CONCURRENT_MODIFICATION`）——
 * 上层的处置没变（重新载入 / 拒绝覆盖），变的只是拦点从"文件比较"挪到了"数据库条件写入"。
 */
export class StorageConflictError extends Error {
  readonly code = 'E_CONCURRENT_MODIFICATION';

  readonly docId: string;

  readonly expected: string | null;

  /* ⚠️ 不用**构造函数参数属性**（`constructor(readonly docId: string)`）：
     本仓库的 .ts 是按 Node 的 strip-only 模式直接运行的，那种写法会在运行时报
     `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`（实测踩到：服务无法启动，而 tsc 全绿）。 */
  constructor(docId: string, expected: string | null, reason: string) {
    super(`旁挂数据落盘冲突（${docId}）：${reason}。本次未写入 —— 请重新载入后再改。`);
    this.name = 'StorageConflictError';
    this.docId = docId;
    this.expected = expected;
  }
}

export type LoadSidecarsResult<T> =
  | { ok: true; found: false }
  | { ok: true; found: true; data: T; digest: string }
  | { ok: false; code: string; message: string };

export interface WorkStoreOptions {
  salt?: string;
  iterations?: number;
  /** 写入时刻（测试可注入） */
  at?: () => string;
}

interface SealedRow {
  payload_format: string;
  payload_digest: string;
  payload_sealed: string;
}

export class WorkStore {
  private readonly db: SqliteDatabase;

  private readonly passphrase: string;

  private readonly options: WorkStoreOptions;

  /* 同上：显式字段赋值，不用参数属性（本仓库按 strip-only 运行 .ts） */
  constructor(db: SqliteDatabase, passphrase: string, options: WorkStoreOptions = {}) {
    if (!passphrase) throw new Error('工作数据仓储必须有口令：不做"没口令就存明文"的兜底（同 core/store.ts）');
    this.db = db;
    this.passphrase = passphrase;
    this.options = options;
  }

  private now(): string {
    return this.options.at ? this.options.at() : new Date().toISOString();
  }

  private sealOptions(): SealOptions {
    return {
      ...(this.options.salt === undefined ? {} : { salt: this.options.salt }),
      ...(this.options.iterations === undefined ? {} : { iterations: this.options.iterations }),
    };
  }

  /* ------------------------------ 结构（患者/就诊/文书元数据） ------------------------------ */

  /**
   * 全量写结构。**幂等**：同一份结构写两遍结果一致（让"启动时对齐一次"这类调用不必判断差异）。
   * 只增不删 —— 删除走显式动作（`clearWorkData`），不在这里顺手做，
   * 否则一次"少传了一个患者"的调用就会静默删掉他的全部就诊。
   */
  saveStructure(structure: WorkspaceStructure): void {
    /* 形状守卫：调用方传错形状（例如把 patients **数组**直接传进来）在这里就该报出来。
       实测踩到：`saveStructure(workspace.patients as unknown as WorkspaceStructure)` 一路编译通过，
       运行到 forEach 才崩 —— 强制转换把类型检查骗过去了，而错误留到了最深的地方。 */
    if (!structure || !Array.isArray(structure.patients)) {
      throw new Error('saveStructure 需要 { patients: [...] } 形状：调用方传进来的不是这个形状（见本处注释）');
    }
    inTransaction(this.db, () => {
      const patientStmt = this.db.prepare(
        `insert into patients (patient_id, name_masked, gender, birth_date, age, sort)
         values (?, ?, ?, ?, ?, ?)
         on conflict(patient_id) do update set name_masked = excluded.name_masked, gender = excluded.gender,
           birth_date = excluded.birth_date, age = excluded.age, sort = excluded.sort`,
      );
      const visitStmt = this.db.prepare(
        `insert into visits (visit_id, patient_id, visit_type, dept, visit_date, admitted_at, discharged_at, sort)
         values (?, ?, ?, ?, ?, ?, ?, ?)
         on conflict(visit_id) do update set patient_id = excluded.patient_id, visit_type = excluded.visit_type,
           dept = excluded.dept, visit_date = excluded.visit_date, admitted_at = excluded.admitted_at,
           discharged_at = excluded.discharged_at, sort = excluded.sort`,
      );
      const docStmt = this.db.prepare(
        `insert into documents (doc_id, patient_id, visit_id, title, kind, doc_type_code, doc_type_system, doc_type_display,
           status, created_at, updated_at, created_by, rev, sort, payload_format, payload_digest, payload_sealed, stored_at)
         values (?, ?, ?, ?, ?, null, null, null, 'draft', ?, ?, '', 0, ?, ?, ?, ?, ?)
         on conflict(doc_id) do update set patient_id = excluded.patient_id, visit_id = excluded.visit_id,
           title = excluded.title, kind = excluded.kind, sort = excluded.sort`,
      );

      /* 占位正文：结构先行时还没有内容。用一段"空文书"的密封载荷占位，
         随后 `saveDocument` 会用真正的正文覆盖它 —— 于是"结构先于内容"这条约束
         不靠"调用顺序正确"来保证，而是**根本不允许出现没有正文的行**。 */
      const placeholder = sealFor(DOCUMENT_FORMAT, null, this.passphrase, this.sealOptions());

      structure.patients.forEach((patient, patientIndex) => {
        patientStmt.run(
          patient.patientId,
          patient.nameMasked,
          patient.gender,
          null,
          patient.age ?? null,
          patientIndex,
        );
        patient.visits.forEach((visit, visitIndex) => {
          visitStmt.run(
            visit.visitId,
            patient.patientId,
            visit.visitType,
            visit.dept ?? null,
            visit.date ?? null,
            visit.admittedAt ?? null,
            visit.dischargedAt ?? null,
            visitIndex,
          );
          visit.docs.forEach((doc, docIndex) => {
            docStmt.run(
              doc.docId,
              patient.patientId,
              visit.visitId,
              doc.title,
              doc.kind ?? null,
              this.now(),
              this.now(),
              docIndex,
              placeholder.format,
              placeholder.digest,
              placeholder.sealed,
              this.now(),
            );
          });
        });
      });
    });
  }

  loadStructure(): WorkspaceStructure {
    const patients = this.db.prepare('select * from patients order by sort, patient_id').all();
    const visits = this.db.prepare('select * from visits order by sort, visit_id').all();
    const docs = this.db.prepare('select * from documents order by sort, doc_id').all();
    const text = (value: unknown): string => (typeof value === 'string' ? value : '');
    const optional = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

    return {
      patients: patients.map((row) => {
        const patientId = text(row.patient_id);
        return {
          patientId,
          nameMasked: text(row.name_masked),
          gender: text(row.gender),
          ...(typeof row.age === 'number' ? { age: row.age } : {}),
          visits: visits
            .filter((visit) => text(visit.patient_id) === patientId)
            .map((visit) => {
              const visitId = text(visit.visit_id);
              return {
                visitId,
                visitType: text(visit.visit_type),
                ...(optional(visit.dept) ? { dept: text(visit.dept) } : {}),
                ...(optional(visit.visit_date) ? { date: text(visit.visit_date) } : {}),
                ...(optional(visit.admitted_at) ? { admittedAt: text(visit.admitted_at) } : {}),
                ...(optional(visit.discharged_at) ? { dischargedAt: text(visit.discharged_at) } : {}),
                docs: docs
                  .filter((doc) => text(doc.visit_id) === visitId)
                  .map((doc) => ({
                    docId: text(doc.doc_id),
                    title: text(doc.title),
                    ...(optional(doc.kind) ? { kind: text(doc.kind) } : {}),
                  })),
              };
            }),
        };
      }),
    };
  }

  /* --------------------------------- 文书正文 --------------------------------- */

  /**
   * 写一份文书（正文 + 留痕，**同一个事务**）。
   *
   * `meta` 只在**新建**时有意义（文书类型标题/分类/顺序）—— 已在库里的行不因为这次写而改这些，
   * 免得一次正文保存顺手把标题改空。
   */
  saveDocument(doc: DocumentModel, meta: { title?: string; kind?: string; sort?: number } = {}): void {
    const sealed = sealFor(DOCUMENT_FORMAT, doc, this.passphrase, this.sealOptions());
    inTransaction(this.db, () => {
      this.db
        .prepare(
          `insert into documents (doc_id, patient_id, visit_id, title, kind, doc_type_code, doc_type_system, doc_type_display,
             status, created_at, updated_at, created_by, rev, sort, payload_format, payload_digest, payload_sealed, stored_at)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           on conflict(doc_id) do update set
             visit_id = excluded.visit_id,
             doc_type_code = excluded.doc_type_code,
             doc_type_system = excluded.doc_type_system,
             doc_type_display = excluded.doc_type_display,
             status = excluded.status,
             updated_at = excluded.updated_at,
             rev = excluded.rev,
             payload_format = excluded.payload_format,
             payload_digest = excluded.payload_digest,
             payload_sealed = excluded.payload_sealed,
             stored_at = excluded.stored_at`,
        )
        .run(
          doc.docId,
          doc.patient.patientId,
          doc.encounter?.visitId ?? null,
          meta.title ?? '',
          meta.kind ?? null,
          doc.docType?.code ?? null,
          doc.docType?.system ?? null,
          doc.docType?.display ?? null,
          doc.status,
          doc.createdAt,
          doc.updatedAt,
          doc.createdBy,
          doc.revisions.length,
          meta.sort ?? 0,
          sealed.format,
          sealed.digest,
          sealed.sealed,
          this.now(),
        );

      /* 留痕：**替换**而不是追加。撤销会让 rev 变化，逐条追加会留下"已经不存在的那条"；
         整批重建的代价是可忽略的（一份文书的留痕是几十到几千条），换来的是"库里的留痕
         与文书里的留痕永远一致"。 */
      this.db.prepare('delete from document_revisions where doc_id = ?').run(doc.docId);
      const stmt = this.db.prepare(
        'insert into document_revisions (doc_id, rev, at, actor_id, op, target_id) values (?, ?, ?, ?, ?, ?)',
      );
      for (const revision of doc.revisions) {
        stmt.run(doc.docId, revision.rev, revision.at, revision.actorId, revision.op, revision.targetId ?? null);
      }
    });
  }

  /**
   * 真删一份文书（正文 + 留痕 + 旁挂数据），返回是否删到了那一行。
   *
   * 为什么不靠"传一份少了它的结构给 `saveStructure`"：那个口子明确**只增不删**
   * （见 `saveStructure` 的注释），删除必须是一个显式的决定 —— 否则一次漏传就会
   * 静默带走一份病历。这里也只删指定这一份，同一患者的其它文书一个字不动。
   *
   * **状态判定不在这里**："只有草稿能删"是业务流程（见 `demo-server` 的
   * `/api/delete-document`）。仓储层若自己判，第二个调用方就绕过去了。
   * 阅读授权表没有外键（它绑定的是内容指纹，不是这一行），由调用方一并清理。
   */
  deleteDocument(docId: string): boolean {
    return inTransaction(this.db, () => {
      /* 顺序与 `clearWorkData()` 一致：先子表、后主表。外键已开（cascade），
         这两条显式删除是"不依赖 pragma 也成立"的第二道保险。 */
      this.db.prepare('delete from document_revisions where doc_id = ?').run(docId);
      this.db.prepare('delete from sidecars where doc_id = ?').run(docId);
      return Number(this.db.prepare('delete from documents where doc_id = ?').run(docId).changes) > 0;
    });
  }

  loadDocument(docId: string): { ok: true; found: false } | { ok: true; found: true; doc: DocumentModel } | { ok: false; code: string; message: string } {
    const row = this.db.prepare('select * from documents where doc_id = ?').get(docId) as SealedRow | undefined;
    if (!row) return { ok: true, found: false };
    return this.decodeDocument(row);
  }

  /** 读全部文书（演示规模够用；真系统的惰性加载是下一步，见交付说明） */
  loadAllDocuments(): { ok: true; docs: DocumentModel[] } | { ok: false; code: string; message: string } {
    const rows = this.db.prepare('select * from documents order by sort, doc_id').all() as unknown as SealedRow[];
    const docs: DocumentModel[] = [];
    for (const row of rows) {
      const decoded = this.decodeDocument(row);
      if (!decoded.ok) return { ok: false, code: decoded.code, message: decoded.message };
      if (decoded.found) docs.push(decoded.doc);
    }
    return { ok: true, docs };
  }

  private decodeDocument(row: SealedRow): { ok: true; found: true; doc: DocumentModel } | { ok: false; code: string; message: string } {
    const unsealed = unsealValue<DocumentModel | null>(this.toSealed(row), this.passphrase);
    if (!unsealed.ok) return { ok: false, code: unsealed.code, message: unsealed.message };
    /* 占位行（只有结构、还没有正文）：**如实报"没有"**，而不是返回一个空文书 ——
       空文书会被上层当成"一份没有内容的病历"照常打开。 */
    if (unsealed.data === null) return { ok: false, code: 'E_STORAGE_DOC_EMPTY', message: `文书 ${String((row as unknown as { doc_id?: string }).doc_id)} 只有结构没有正文` };
    return { ok: true, found: true, doc: unsealed.data };
  }

  hasDocument(docId: string): boolean {
    return countOf(this.db, 'select count(*) as n from documents where doc_id = ?', docId) > 0;
  }

  countDocuments(): number {
    return countOf(this.db, 'select count(*) as n from documents');
  }

  /** 可查询的元数据（内容在加密载荷里，这里只给"谁的、哪次的、什么类型、什么时候改的"） */
  documentMeta(): DocumentMeta[] {
    const rows = this.db.prepare('select * from documents order by sort, doc_id').all();
    const text = (value: unknown): string => (typeof value === 'string' ? value : '');
    return rows.map((row) => ({
      docId: text(row.doc_id),
      patientId: text(row.patient_id),
      visitId: typeof row.visit_id === 'string' ? row.visit_id : null,
      title: text(row.title),
      kind: typeof row.kind === 'string' ? row.kind : null,
      docTypeCode: typeof row.doc_type_code === 'string' ? row.doc_type_code : null,
      status: text(row.status),
      createdAt: text(row.created_at),
      updatedAt: text(row.updated_at),
      createdBy: text(row.created_by),
      rev: Number(row.rev ?? 0),
    }));
  }

  /* --------------------------------- 旁挂数据 --------------------------------- */

  /**
   * 写旁挂数据。
   *
   * `expectDigest` 是**落盘前置条件**（与文件时代的 CAS 同一用意，但这里是真的原子）：
   *   - 省略：无条件写；
   *   - `null`：要求**此前没有**这份旁挂数据（首次落盘，只允许一个赢家）；
   *   - 一个摘要：要求盘上**正好是这一版**。
   * 不满足 → 抛 `StorageConflictError`，一个字节都不写。
   *
   * 为什么搬到数据库之后反而更强：文件时代是"读摘要 → 比较 → 写"，中间有窗口；
   * 这里是**一条带条件的写入语句**，比较与写在同一个语句里完成 —— 真正的原子 ✓。
   */
  saveSidecars<T>(docId: string, value: T, options: { expectDigest?: string | null } = {}): { digest: string } {
    const sealed = sealFor(SIDECARS_FORMAT, value, this.passphrase, this.sealOptions());
    const now = this.now();
    if (options.expectDigest === null) {
      const result = this.db
        .prepare(
          `insert into sidecars (doc_id, payload_format, payload_digest, payload_sealed, updated_at)
           select ?, ?, ?, ?, ? where not exists (select 1 from sidecars where doc_id = ?)`,
        )
        .run(docId, sealed.format, sealed.digest, sealed.sealed, now, docId);
      if (Number(result.changes) === 0) {
        throw new StorageConflictError(docId, null, '已经存在（另一处先写了这一份）');
      }
    } else if (typeof options.expectDigest === 'string') {
      const result = this.db
        .prepare(
          `update sidecars set payload_format = ?, payload_digest = ?, payload_sealed = ?, updated_at = ?
           where doc_id = ? and payload_digest = ?`,
        )
        .run(sealed.format, sealed.digest, sealed.sealed, now, docId, options.expectDigest);
      if (Number(result.changes) === 0) {
        throw new StorageConflictError(docId, options.expectDigest, '盘上不是这一版（被另一处改过，或已被删除）');
      }
    } else {
      this.db
        .prepare(
          `insert into sidecars (doc_id, payload_format, payload_digest, payload_sealed, updated_at)
           values (?, ?, ?, ?, ?)
           on conflict(doc_id) do update set payload_format = excluded.payload_format,
             payload_digest = excluded.payload_digest, payload_sealed = excluded.payload_sealed, updated_at = excluded.updated_at`,
        )
        .run(docId, sealed.format, sealed.digest, sealed.sealed, now);
    }
    return { digest: sealed.digest };
  }

  loadSidecars<T>(docId: string): LoadSidecarsResult<T> {
    const row = this.db.prepare('select * from sidecars where doc_id = ?').get(docId) as SealedRow | undefined;
    if (!row) return { ok: true, found: false };
    const unsealed = unsealValue<T>(this.toSealed(row), this.passphrase);
    if (!unsealed.ok) return { ok: false, code: unsealed.code, message: unsealed.message };
    return { ok: true, found: true, data: unsealed.data, digest: row.payload_digest };
  }

  /* --------------------------- 小体量整体式数据集 --------------------------- */

  putSealed<T>(key: string, value: T): void {
    const sealed = sealFor(KV_FORMAT, value, this.passphrase, this.sealOptions());
    this.db
      .prepare(
        `insert into sealed_kv (key, payload_format, payload_digest, payload_sealed, updated_at)
         values (?, ?, ?, ?, ?)
         on conflict(key) do update set payload_format = excluded.payload_format,
           payload_digest = excluded.payload_digest, payload_sealed = excluded.payload_sealed, updated_at = excluded.updated_at`,
      )
      .run(key, sealed.format, sealed.digest, sealed.sealed, this.now());
  }

  getSealed<T>(key: string): { ok: true; found: false } | { ok: true; found: true; data: T } | { ok: false; code: string; message: string } {
    const row = this.db.prepare('select * from sealed_kv where key = ?').get(key) as SealedRow | undefined;
    if (!row) return { ok: true, found: false };
    const unsealed = unsealValue<T>(this.toSealed(row), this.passphrase);
    if (!unsealed.ok) return { ok: false, code: unsealed.code, message: unsealed.message };
    return { ok: true, found: true, data: unsealed.data };
  }

  /**
   * 只问"库里有没有这一行"，**不解内容**。
   *
   * 与 `getSealed` 的差别是实质性的：**一次性导入必须靠它**。
   * 若拿 `getSealed` 判"有没有"，一行解不开的旧数据（口令换过 / 被人改过）
   * 会被当成"没有"，于是旧文件"顺手"把它覆盖掉 —— 那等于**用一份文件覆盖掉唯一的一份数据**，
   * 而现场只会看到"配置变了"。宁可挡住不导，也不能悄悄覆盖。
   */
  hasSealed(key: string): boolean {
    return countOf(this.db, 'select count(*) as n from sealed_kv where key = ?', key) > 0;
  }

  /** 真删一行（不是写空壳）："我清掉了"必须与库里一致（同模型密钥那条教训） */
  removeSealed(key: string): boolean {
    return Number(this.db.prepare('delete from sealed_kv where key = ?').run(key).changes) > 0;
  }

  /* ---------------------------------- 维护 ---------------------------------- */

  /**
   * 清空**工作数据**（不碰患者主索引之外的任何东西；`schema_migrations` 与账本保留）。
   * 「重置工作区」用它 —— 重置必须真的把库清掉，否则下一次读回来就是"重置是假的"。
   */
  clearWorkData(): void {
    inTransaction(this.db, () => {
      /* 顺序按外键依赖：留痕 → 旁挂 → 文书 → 就诊 → 患者 */
      this.db.exec('delete from document_revisions');
      this.db.exec('delete from sidecars');
      this.db.exec('delete from documents');
      this.db.exec('delete from visits');
      this.db.exec('delete from patients');
      /* 授权登记也算**工作数据**：它绑定的是某一份文档的**内容指纹**，
         重置之后文档被重建，旧授权只会得到 `E_DOCUMENT_CHANGED` ——
         留着它们不是"保留配置"，而是留一堆必然失败的凭据（同 `demo-server` 里重置那一段的说明）。
         注意它与 `admin_users` / `admin_audit` / `knowledge_packs` / `recipient_keys` 的区别：
         那几张是"这台机器怎么配、谁在用它"，重置工作区不该动。 */
      this.db.exec('delete from reading_grants');
    });
  }

  /** 一次性动作的记账：同一件事不能做两遍（如"从旧的文件存储导入过"） */
  ledgerHas(id: string): boolean {
    return countOf(this.db, 'select count(*) as n from import_ledger where id = ?', id) > 0;
  }

  ledgerMark(id: string, note: string): void {
    this.db.prepare('insert or ignore into import_ledger (id, applied_at, note) values (?, ?, ?)').run(id, this.now(), note);
  }

  stats(): { documents: number; revisions: number; sidecars: number; kv: number; patients: number } {
    return {
      patients: countOf(this.db, 'select count(*) as n from patients'),
      documents: this.countDocuments(),
      revisions: countOf(this.db, 'select count(*) as n from document_revisions'),
      sidecars: countOf(this.db, 'select count(*) as n from sidecars'),
      kv: countOf(this.db, 'select count(*) as n from sealed_kv'),
    };
  }

  close(): void {
    this.db.close();
  }

  private toSealed(row: SealedRow): SealedContent {
    return { digest: row.payload_digest, sealed: String(row.payload_sealed) };
  }
}

export function openWorkStore(options: {
  opened: OpenDatabaseResult;
  passphrase: string;
  salt?: string;
  iterations?: number;
  at?: () => string;
}): { store: WorkStore; applied: string[]; fresh: boolean } {
  const store = new WorkStore(options.opened.db, options.passphrase, {
    ...(options.salt === undefined ? {} : { salt: options.salt }),
    ...(options.iterations === undefined ? {} : { iterations: options.iterations }),
    ...(options.at === undefined ? {} : { at: options.at }),
  });
  return { store, applied: options.opened.applied, fresh: options.opened.fresh };
}
