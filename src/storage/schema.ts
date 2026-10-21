import type { Migration } from './sqlite.ts';

/** 本程序要求的结构版本。改结构必须同时加一条迁移并把它加一  */
export const STORAGE_SCHEMA_VERSION = 8;

export const MIGRATIONS: readonly Migration[] = [
  {
    id: '0001-init',
    note: '建库：患者 / 就诊 / 文书（含加密载荷）/ 留痕 / 旁挂数据 / 阅读授权',
    sql: [
      `create table patients (
         patient_id text primary key,
         name_masked text not null,
         gender text not null,
         birth_date text,
         age integer,
         sort integer not null default 0
       )`,
      `create table visits (
         visit_id text primary key,
         patient_id text not null references patients(patient_id) on delete cascade,
         visit_type text not null,
         dept text,
         visit_date text,
         admitted_at text,
         discharged_at text,
         sort integer not null default 0
       )`,
      `create table documents (
         doc_id text primary key,
         patient_id text not null references patients(patient_id),
         visit_id text references visits(visit_id),
         title text not null default '',
         kind text,
         doc_type_code text,
         doc_type_system text,
         doc_type_display text,
         status text not null,
         created_at text not null,
         updated_at text not null,
         created_by text not null,
         rev integer not null,
         sort integer not null default 0,
         payload_format text not null,
         payload_digest text not null,
         payload_sealed blob not null,
         stored_at text not null
       )`,
      `create index documents_by_visit on documents (visit_id)`,
      `create index documents_by_status on documents (status)`,
      `create index documents_by_patient on documents (patient_id)`,
      `create table document_revisions (
         doc_id text not null references documents(doc_id) on delete cascade,
         rev integer not null,
         at text not null,
         actor_id text not null,
         op text not null,
         target_id text,
         primary key (doc_id, rev)
       )`,
      `create index revisions_by_time on document_revisions (at)`,
      `create index revisions_by_actor on document_revisions (actor_id)`,
      `create table sidecars (
         doc_id text primary key references documents(doc_id) on delete cascade,
         payload_format text not null,
         payload_digest text not null,
         payload_sealed blob not null,
         updated_at text not null
       )`,
      `create table sealed_kv (
         key text primary key,
         payload_format text not null,
         payload_digest text not null,
         payload_sealed blob not null,
         updated_at text not null
       )`,
      `create table import_ledger (
         id text primary key,
         applied_at text not null,
         note text not null
       )`,
    ],
  },
  {
    id: '0002-knowledge-packs',
    note: '知识资产包入库：一个版本一行（原先是一个版本一个文件）；生效指针与条目开关各一张表',
    sql: [
      `create table knowledge_packs (
         pack_id text not null,
         version text not null,
         kind text not null,
         content_format text not null,
         content text not null,
         fingerprint text not null,
         origin text not null,
         stored_at text not null,
         primary key (pack_id, version)
       )`,
      `create index knowledge_packs_by_kind on knowledge_packs (kind)`,
      `create table knowledge_pack_active (
         pack_id text primary key,
         version text not null,
         disabled text not null,
         updated_at text not null,
         foreign key (pack_id, version) references knowledge_packs(pack_id, version)
       )`,
    ],
  },
  {
    id: '0003-pack-without-version',
    note: '包去掉版本：两张表并成一张（一个包一行，内容 + 条目开关 + 指纹）',
    sql: [
      `create table knowledge_packs_v2 (
         pack_id text primary key,
         kind text not null,
         content_format text not null,
         content text not null,
         fingerprint text not null,
         disabled text not null,
         updated_at text not null
       )`,
      `insert into knowledge_packs_v2 (pack_id, kind, content_format, content, fingerprint, disabled, updated_at)
         select k.pack_id, k.kind, k.content_format, json_remove(k.content, '$.version'), k.fingerprint, a.disabled, max(k.stored_at, a.updated_at)
           from knowledge_packs k
           join knowledge_pack_active a on a.pack_id = k.pack_id and a.version = k.version`,
      `drop table knowledge_pack_active`,
      `drop table knowledge_packs`,
      `alter table knowledge_packs_v2 rename to knowledge_packs`,
      `create index knowledge_packs_by_kind on knowledge_packs (kind)`,
    ],
  },
  {
    id: '0004-admin-users',
    note: '后台账号入库：用户名 + 口令哈希 + 角色（口令不再由环境变量注入）',
    sql: [

      `create table admin_users (
         username text primary key,
         role text not null,
         password_hash text not null,
         disabled integer not null default 0,
         created_at text not null,
         updated_at text not null,
         updated_by text not null,
         last_login_at text
       )`,
      `create index admin_users_by_role on admin_users (role)`,
    ],
  },
  {
    id: '0005-admin-audit',
    note: '管理审计与链头锚点入库：序号成为主键，重复锚定由主键拦住',
    sql: [
      `create table admin_audit (
         seq integer primary key,
         at text not null,
         actor text not null,
         subject text not null,
         kind text not null,
         changes text not null,
         note text,
         prev_hash text not null,
         hash text not null
       )`,
      `create index admin_audit_by_at on admin_audit (at)`,
      `create table admin_audit_anchor (
         head_seq integer not null,
         head_hash text not null,
         at text not null,
         signature text,
         signer_fingerprint text,
         primary key (head_seq, head_hash)
       )`,
    ],
  },
  {
    id: '0006-recipient-keys',
    note: '接收方公钥目录入库：原先是一个明文 JSON 文件，一个接收方一行；指纹唯一改由库保证',
    sql: [

      `create table recipient_keys (
         key_id text primary key,
         label text not null,
         spki_base64 text not null,
         fingerprint text not null,
         algorithm text not null,
         note text,
         created_at text not null,
         sort integer not null default 0
       )`,
      `create unique index recipient_keys_by_fingerprint on recipient_keys (fingerprint)`,
    ],
  },
  {
    id: '0007-reading-grants',
    note: '受控阅读的授权登记入库：一条授权一行（可查的进列，凭据与阅读流水加密进载荷）',
    sql: [
      `create table reading_grants (
         grant_id text primary key,
         doc_id text not null,
         revoked integer not null default 0,
         read_count integer not null default 0,
         payload_format text not null,
         payload_digest text not null,
         payload_sealed blob not null,
         updated_at text not null
       )`,
      `create index reading_grants_by_doc on reading_grants (doc_id)`,
      `create index reading_grants_by_revoked on reading_grants (revoked)`,
    ],
  },
  {
    id: '0008-revision-ledger',
    note: '留痕账改链式（只追加）：每条留痕带 prev_hash / hash 与完整载荷 payload',
    sql: [
      `drop table document_revisions`,
      `create table document_revisions (
         doc_id text not null references documents(doc_id) on delete cascade,
         rev integer not null,
         at text not null,
         actor_id text not null,
         op text not null,
         target_id text,
         payload text not null,
         prev_hash text not null,
         hash text not null,
         primary key (doc_id, rev)
       )`,
      `create index revisions_by_time on document_revisions (at)`,
      `create index revisions_by_actor on document_revisions (actor_id)`,
    ],
  },
];
