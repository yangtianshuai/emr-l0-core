import type { DocumentModel, RevisionEntry } from '../model/types.ts';
import { inTransaction, countOf, type OpenDatabaseResult, type SqliteDatabase } from './sqlite.ts';
import {
  appendRevisions,
  loadRevisionChain,
  readRevisionLedger,
  type RevisionLedgerReport,
} from '../core/revision-ledger.ts';
import { sealFor, sealValue, unsealValue, type SealedContent, type SealOptions } from './sealed.ts';
import { DOCUMENT_FORMAT, SIDECARS_FORMAT, KV_FORMAT } from './formats.ts';

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

export class StorageConflictError extends Error {
  readonly code = 'E_CONCURRENT_MODIFICATION';

  readonly docId: string;

  readonly expected: string | null;

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

  saveStructure(structure: WorkspaceStructure): void {
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

      appendRevisions(this.db, doc.docId, doc.revisions);
    });
  }

  deleteDocument(docId: string): boolean {
    return inTransaction(this.db, () => {
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
    if (unsealed.data === null) return { ok: false, code: 'E_STORAGE_DOC_EMPTY', message: `文书 ${String((row as unknown as { doc_id?: string }).doc_id)} 只有结构没有正文` };
    return { ok: true, found: true, doc: unsealed.data };
  }

  hasDocument(docId: string): boolean {
    return countOf(this.db, 'select count(*) as n from documents where doc_id = ?', docId) > 0;
  }

  countDocuments(): number {
    return countOf(this.db, 'select count(*) as n from documents');
  }

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

  hasSealed(key: string): boolean {
    return countOf(this.db, 'select count(*) as n from sealed_kv where key = ?', key) > 0;
  }

  /** 真删一行（不是写空壳）："我清掉了"必须与库里一致（同模型密钥那条教训） */
  removeSealed(key: string): boolean {
    return Number(this.db.prepare('delete from sealed_kv where key = ?').run(key).changes) > 0;
  }

  clearWorkData(): void {
    inTransaction(this.db, () => {
      this.db.exec('delete from document_revisions');
      this.db.exec('delete from sidecars');
      this.db.exec('delete from documents');
      this.db.exec('delete from visits');
      this.db.exec('delete from patients');
      this.db.exec('delete from reading_grants');
    });
  }

  ledgerHas(id: string): boolean {
    return countOf(this.db, 'select count(*) as n from import_ledger where id = ?', id) > 0;
  }

  ledgerMark(id: string, note: string): void {
    this.db.prepare('insert or ignore into import_ledger (id, applied_at, note) values (?, ?, ?)').run(id, this.now(), note);
  }

  documentRevisionLedger(docId: string): { report: RevisionLedgerReport; entries: RevisionEntry[] } {
    return readRevisionLedger(this.db, docId);
  }

  revisionChainReport(docId: string): RevisionLedgerReport {
    return loadRevisionChain(this.db, docId);
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
