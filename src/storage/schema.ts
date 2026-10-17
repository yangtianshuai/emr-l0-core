/**
 * 数据库结构（DDL）与迁移清单。
 *
 * ## 表怎么分：**能查的进列，内容加密进载荷**
 *
 * 病历内容（节点、留痕补丁、建议与注解）是**患者数据**，本仓库既有口径是"落盘要密封"
 * （见 `core/store.ts` 文件头）。所以库里分两层：
 *   - **列**：只放回答"这是谁的、哪一次就诊的、什么类型的、什么时候改的、谁改的"所需的字段
 *     （都是标识与时间，不是内容）；
 *   - **载荷**：内容按既有信封加密后存 BLOB（**复用同一条密码学链路**，不另起一套）。
 * 这样"按患者/就诊/类型/状态查"能走索引，而把库文件拷走并不直接得到病历内容。
 *
 * ⚠️ 边界要说清：**已加密的载荷无法用 SQL 查内容**（如"找出所有含'胸痛'的病历"）。
 * 真要做内容检索，得走"结构化到列 + 列级加密策略"，那是下一步，不是本轮假装做到了的事。
 *
 * ## 留痕单独成表
 *
 * `document_revisions` 与文书载荷**冗余**存一份（载荷里也有）。冗余是刻意的：
 * 审计要能不问内容就回答"谁在什么时候改了哪一份文书的哪一条"，
 * 而载荷是加密的、查不动。代价是"两处必须一致"——由仓储层在**同一个事务**里写入来保证。
 */

import type { Migration } from './sqlite.ts';

/** 本程序要求的结构版本。**改结构必须同时加一条迁移并把它加一** */
export const STORAGE_SCHEMA_VERSION = 7;

/**
 * 迁移清单。**只追加，不改历史条目** ——
 * 已发布过的迁移一旦被改，不同机器上的库就会走到不同的结构上，而版本号还一样。
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    id: '0001-init',
    note: '建库：患者 / 就诊 / 文书（含加密载荷）/ 留痕 / 旁挂数据 / 阅读授权',
    sql: [
      /* `sort`：**呈现顺序是数据的一部分**（同一患者就诊列表、同一就诊的文书列表都按它排）。
         不存它、改用时间/ID 排，界面上同一个人的两次就诊就会莫名其妙换位置。 */
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
      /* 小体量的**整体式**数据集（阅读授权登记这类）：整份加密存一行，键是它的用途名。
         为什么不给它单独设计几张表：它们是"一次读全量、一次写全量"的数据，
         拆成行只会多出一堆"部分写成功"的可能，而它本身没有按行查询的需求。
         哪天真需要按行查（如"某个授权被谁撤回了"），再升版本拆表 —— 那才是显式迁移该做的事。 */
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
       * 包内容**不加密**（与文书、旁挂数据相反）：包是知识资产 —— 规则、模板、术语，
       * 里面没有患者数据，加密只会让它无法被核对、无法被 diff、也无法被人工审查。
       * 这条差异是有意的，不是漏做。
       *
       * `(pack_id, version)` 是主键：**同版本不能有两份内容**（原先靠"拒绝覆盖同名文件"保证，
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
      /* 生效指针：一包一行。`disabled` 是**运行时策略**（条目开关），刻意不写进包内容 ——
         与文件时代"开关不进包文件"同一个口径：把"载的是哪一版"与"实际在跑什么"分开。 */
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
      /*
       * 为什么并成一张表：**一个包就是一份内容**。留着 `(pack_id, version)` 的主键
       * 与"生效指针"，就有了多版本并存 → 就得有人回答"该切哪一版"，
       * 而现场真正需要回答的只有一句"现在跑的是什么"。合并之后：
       * 写包 = 按 `pack_id` 覆盖（改了就改了），条目开关仍单独一列（不混进内容）。
       *
       * 迁移里**只保留指针指着的那一份**：历史版本行在"没有版本"的模型里无处安放，
       * 留着只会造成"库里有、但没有任何路径能读到它"的死数据。
       * 这一步会丢历史版本 —— 这是删掉版本的代价，代码里如实记在这里，不悄悄做。
       *
       * SQLite 的外键约束是 on 且**不能在一个事务里关掉**（`pragma` 在事务内是空操作），
       * 所以顺序必须是"先删子表、再删父表" —— 反过来会因外键而失败。
       */
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
       * 内容要用 `json_remove` **剥掉旧的 `version` 字段**：新模型的 `validatePack`
       * 对未知字段是**拒绝**的，带着 `version` 的行迁移完就装不上了 ——
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
      /*
       * 为什么账号要进这张（**工作数据**）库，而不是像模型配置那样单独一个文件：
       * 它必须与"谁能做什么"一起被备份、被恢复、被审计 —— 账号丢了的现场表现是
       * "所有人都进不了管理后台"，那时再去找一个旁挂文件才是真正的手忙脚乱。
       *
       * 三处刻意的选择：
       *
       * 1) **只存哈希，不存口令**（`scrypt` 的盐与参数都写在字符串里，自描述格式
       *    `scrypt$N$r$p$<salt-b64>$<hash-b64>`）。盐写进同一列而不是单独一列，
       *    是为了让"换算法/换参数"只改这一列 —— 旧的哈希仍能按它自称的参数被验证。
       * 2) **口令不加密而是哈希**：加密需要一把口令，而"打开后台需要的那把口令"再去
       *    依赖另一把口令，就是又一个说不清要先有谁的圈。哈希不可逆，也就不需要。
       * 3) `disabled` 与角色分开存：停用是"这个人不能登录了"，降级是"这个人还能登录、
       *    但能做的事变少"。混成一个字段，事后就答不出"他当时是被停用还是被降权"。
       *
       * `clearWorkData()`（「重置工作区」）**不碰这张表**：账号是部署参数，
       * 不是任何一份病历。清空病历把管理员一起清掉，等于把门锁在屋子里。
       */
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
      /*
       * 审计与锚点原先各是一个 NDJSON 文件（`admin-audit.log` 与 `.anchors.ndjson`）。
       * 搬进库的理由与部署参数那条不完全相同，更硬：
       *
       * 1) **审计必须与它审计的数据待在同一个可恢复单元里**。原先是"数据在库、账在文件" ——
       *    恢复一份数据库时，账不会跟着回来；而"谁在什么时候改了这一格"恰恰是恢复之后
       *    最需要回答的问题。备份一次带走，这条才算落地。
       * 2) **多进程互相污染锚点**：文件是"各自追加"，两个进程各有各的内存链，
       *    于是同一份文件里会混进两条互不相容的链的锚（实测撞到：286 条互相污染的锚）。
       *    库里只有**一份**链，两个进程读到的就是同一条 —— 这个根不存在了。
       * 3) `seq` 成为**主键**：序号重复/乱序在库层面就不可能（文件时代只能靠读的时候发现）。
       *
       * 同时如实记下**失去了什么**：文件时代的"尾行被撕断"（崩溃留下的半行）能靠
       * "最后一行 JSON 解析失败"识别出来；库的一行要么在、要么不在，这类损坏**不再可能出现**。
       * 不是变安全了，而是这一类失败换成了别的一类（写到一半的写事务会被回滚）。
       * 链式摘要仍然管它一直管的那件事：**有人改过其中某一行**。
       */
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
      /*
       * 锚点：`(head_seq, head_hash)` 做主键 —— **同一条链头锚两次就是同一条**（幂等）。
       * 文件时代这里会堆成一串重复锚（每次启动"再锚一次"就多一行），
       * 而"锚了多少次"与"链被锚到了哪里"是两件事，混在一起之后谁也看不懂。
       *
       * 签名与指纹可空：未签名的锚点仍然有意义（它能证明"某时刻链头是什么"），
       * 只是**不能**用来指认"是谁锚的" —— 这一点在报告里必须如实说（见 `verifyAnchor`）。
       */
      `create table admin_audit_anchor (
         head_seq integer not null,
         head_hash text not null,
         at text not null,
         signature text,
         signer_fingerprint text,
         primary key (head_seq, head_hash)
       )`,
      /* 两张表都**不进** `clearWorkData()`（「重置工作区」）：审计不是病历。
        "谁在什么时候清空了这台机器"恰恰是重置之后唯一还查得到的东西 ——
        重置时把审计一起清掉，等于让破坏性动作不留痕。 */
    ],
  },
  {
    id: '0006-recipient-keys',
    note: '接收方公钥目录入库：原先是一个明文 JSON 文件，一个接收方一行；指纹唯一改由库保证',
    sql: [
      /*
       * 目录原先是一个文件（`<状态目录>/recipient-keys.json`），搬进库的理由有三条，
       * 其中一条是这里才有的：
       *
       * 1) **备份带不走**：目录是"加密交付能交给谁"的唯一记录（私钥从不进本系统）。
       *    备份一份数据库却把收件方留在磁盘上，恢复后的现场是"归档件还在、却没人能收"；
       * 2) **"重置工作区"原先要逐文件挑白名单**，漏掉它的表现是"重置后加密交付忽然没有收件方"，
       *    而没人会想到是重置干的；
       * 3) **指纹去重从"写入前检查一次"变成库层面的唯一索引**：同一把钥匙出现两行，
       *    "选哪一行"就会随列表顺序变化 —— 文件时代这条只能靠代码纪律，现在靠约束。
       *
       * **不加密**（与 `documents` / `sealed_kv` 相反，是刻意的）：目录里只有公钥，
       * 它存在的意义就是公开交换；密封它只会让"核对指纹"和"人工审查"都要先解一遍，
       * 收益为零。同判断见知识包那张表（知识资产同样不加密）。
       *
       * `sort`：呈现顺序是数据的一部分（界面上的接收方列表按它排），与 `patients` / `documents` 同一处置。
       */
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
      /*
       * 原先是一个**整体式**的密封文件（`<状态目录>/reading-grants.json`：整份记录加密后一次全写）。
       * 搬进库的理由两条：
       *
       * 1) **备份带不走**（同其它几处）：授权登记绑定的是某一份文档的内容指纹与阅读次数，
       *    它与病历属于同一批备份 —— 恢复出病历却没有授权登记，现场是"文书在、却没人说得清它被谁看过"；
       * 2) **它本来就有按行查询的需求**，而整体式存储只能整体读进内存再筛：
       *    "这份文书被谁授权过"、"哪些授权已被撤销"都是界面上的常规动作。
       *
       * ## 列与载荷为什么冗余
       *
       * - **列**：`doc_id` / `revoked` / `read_count` —— 回答"哪份文书的授权、撤没撤、读了几次"，
       *   这些**不解密就要能答**（列表、统计、次数门控都在这里读）；
       * - **载荷**：整条记录（授权书 + 公钥 + 阅读流水 + 加密交付片段）**加密存**。
       *   阅读流水里有"谁在什么时候读了哪个患者的病历"，凭据里有授权范围与用途说明 ——
       *   与文书同一处置（落盘要密封），于是把库文件拷走也读不出内容。
       *
       * 冗余是有代价的（"两处必须一致"），由写入侧在**同一个事务**里保证；
       * **读取以载荷为准**，列只用于筛选与统计。这与 `documents` / `document_revisions` 的取舍同源，
       * 区别是这里两边落在同一行、同一条语句里，不一致的可能性比跨表冗余更小。
       *
       * ⚠️ 边界照实说：**已加密的载荷无法用 SQL 查内容**（如"找出所有授权给心内科的记录"）。
       * 那需要把 `purpose` 之类的字段提到列上、并接受它明文可读 —— 这是要显式权衡的一步，不是顺手加的。
       *
       * 这张表**进** `clearWorkData()`（「重置工作区」会清它）：授权绑定的是内容指纹，
       * 重置之后旧授权只会得到 `E_DOCUMENT_CHANGED`，留着它们不是"保留配置"，而是留一堆必然失败的凭据。
       */
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
];
