// 数据库结构（DDL）与迁移清单。

import type { Migration } from './sqlite.ts';

/** 本程序要求的结构版本。改结构必须同时加一条迁移并把它加一  */
export const STORAGE_SCHEMA_VERSION = 8;

/**
 * 迁移清单。只追加，不改历史条目 ——
 * 已发布过的迁移一旦被改，不同机器上的库就会走到不同的结构上，而版本号还一样。
  */
export const MIGRATIONS: readonly Migration[] = [
  {
    id: '0001-init',
    note: '建库：患者 / 就诊 / 文书（含加密载荷）/ 留痕 / 旁挂数据 / 阅读授权',
    sql: [
      /* `sort`：呈现顺序是数据的一部分（同一患者就诊列表、同一就诊的文书列表都按它排）。
         不存它、改用时间/ID 排，界面上同一个人的两次就诊就会莫名其妙换位置。  */
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
      /* 文书：列回答"谁的、哪次的、什么类型、什么时候改的"，载荷放加密后的内容 */
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
      /* 留痕：与载荷冗余，为的是"不问内容就能答审计" */
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
      /* 旁挂数据（建议 + 注解）：整块加密存一份，与文书同一种处置 */
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
      /* 一次性动作的记账（如"从旧的文件存储导入过"）：同一件事不能做两遍 */
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
      /*
       * 包内容不加密（与文书、旁挂数据相反）：包是知识资产 —— 规则、模板、术语，
       * 里面没有患者数据，加密只会让它无法被核对、无法被 diff、也无法被人工审查。
       * 这条差异是有意的，不是漏做。
       *
       * `(pack_id, version)` 是主键：同版本不能有两份内容（原先靠"拒绝覆盖同名文件"保证，
       * 现在由主键来保证 —— 比文件系统的检查更硬）。多版本并存因此是天然的：
       * 历史版本就是普通行，回退 = 改指针那一行。
        */
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
      /* 生效指针：一包一行。`disabled` 是运行时策略（条目开关），刻意不写进包内容 ——
         与文件时代"开关不进包文件"同一个口径：把"载的是哪一版"与"实际在跑什么"分开。  */
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
      /*
       * 内容要用 `json_remove` 剥掉旧的 `version` 字段：新模型的 `validatePack`
       * 对未知字段是拒绝的，带着 `version` 的行迁移完就装不上了 ——
       * 那等于"升级一次，把能用的包变成装载失败"（实测：迁移后的库直接报
       * `包里出现未知字段「version」`）。
       * 本机 SQLite 带 JSON1（`json_remove` 可用），所以这件事能在迁移里做干净。
        */
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
      // 1) 只存哈希，不存口令（`scrypt` 的盐与参数都写在字符串里，自描述格式
// 2) 口令不加密而是哈希：加密需要一把口令，而"打开后台需要的那把口令"再去

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
      /* 两张表都不进 `clearWorkData()`（「重置工作区」）：审计不是病历。
        "谁在什么时候清空了这台机器"恰恰是重置之后唯一还查得到的东西 ——
        重置时把审计一起清掉，等于让破坏性动作不留痕。  */
    ],
  },
  {
    id: '0006-recipient-keys',
    note: '接收方公钥目录入库：原先是一个明文 JSON 文件，一个接收方一行；指纹唯一改由库保证',
    sql: [
      // 1) 备份带不走：目录是"加密交付能交给谁"的唯一记录（私钥从不进本系统）。

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
      /* 撤销状态要能筛：界面上"哪些授权还生效"是最常问的一句 */
      `create index reading_grants_by_revoked on reading_grants (revoked)`,
    ],
  },
  {
    id: '0008-revision-ledger',
    note: '留痕账改链式（只追加）：每条留痕带 prev_hash / hash 与完整载荷 payload',
    sql: [
      /*
       * 旧行不搬：它们没有 `prev_hash`/`hash`，搬过去就是"看起来有账其实没有链" ——
       * 那比没有账更糟，因为它会被当成证据用。
       *
       * 也不需要从旧行重建：留痕的权威来源一直是文书载荷（`revisions`），
       * 账只是它的可查询副本。下次保存时 `appendRevisions` 会把缺的那些条按链式补回去，
       * 链是**重建**的，不是继承的 —— 继承一条没链的账，等于继承一个说不清的过去。
       */
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
