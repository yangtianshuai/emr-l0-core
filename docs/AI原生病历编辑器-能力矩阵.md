# AI 原生病历编辑器 · 能力矩阵（对齐代码实测）

> 版本：v2.0 ｜ 编制日期：2026-10-17 ｜ 取代 v1.0（2026-10-08，纯规划口径）
> 用途：定 V1 范围、竞品对标、与合作方谈能力边界
> **事实基线：本仓库代码**。每条给出 `文件:行` 证据；给不出证据的一律记 `○ 未实现`，
> 不用"计划中 / 正在做"占位——规划态和实现态混在一张表里，正是 v1.0 失真的原因。
> 外部参照（只作对标依据，**不构成任何符合性声明**）：
> 《电子病历版式文档技术要求》GB/T 48666—2026（俗称 OFD-H，正文未公开，2027 年实施）；
> 《关于促进和规范"人工智能+医疗卫生"应用发展的实施意见》（2025-12，五部门）；
> 《医疗机构人工智能应用与治理专家共识》（2026-03，本地化/私有云优先、严禁未脱敏病历上公有云）；
> 行业共识：AI 生成内容须医生审核确认后方可成为正式病历。

## 一、怎么读这张表

| 状态 | 含义 | 判定门槛 |
|---|---|---|
| ✅ 已实现 | 代码可跑 + 有自测/独立探针覆盖 | 能给出用例名或探针检查项，不是"注释里写了" |
| ◐ 部分实现 | 机制在，边界在代码里明示 | 必须同时给出"做到哪"和"没做到哪" |
| ○ 未实现 | 仓库里没有对应实现 | 允许"刻意不做"，但不得写成"支持" |
| ⛔ 不得宣称 | 实现存在但对外不许这么说 | 见第八节 |

评分沿用 v1.0 两维，便于与旧版逐行对照：**必须性** M / S / O（M＝缺了不能上生产）、
**难度** 1～5（5＝技术壁垒所在）。节奏一维取消——节奏是排期，不是能力，排期见第九节。

## 二、总览（按本次实测计数）

| 层 | 条目 | ✅ | ◐ | ○ |
|---|---|---|---|---|
| L0 文档内核（K） | 19 | 9 | 7 | 3 |
| L1 AI 接入与门控（A） | 8 | 3 | 4 | 1 |
| L2 临床场景能力（I） | 12 | 1 | 7 | 4 |
| L3 治理·安全·合规（G） | 12 | 3 | 7 | 2 |
| L4 工程验收与数据飞轮（D） | 8 | 4 | 2 | 2 |
| **合计** | **59** | **20** | **27** | **12** |

一句话结论：**"内核 + 门控 + 密码学 + 验收链"是真实的（20 条 ✅ 里 16 条在这一侧）；
"排版、打印、评测集、术语/编码、多模态"是空的（12 条 ○ 里 9 条在这一侧）。
v1.0 把这两侧写成了同一张路线图，看起来哪里都有，实际是哪里都能被问穿。**

## 三、L0 文档内核（决定天花板）

| 编号 | 能力 | 现状 | 评分 | 证据 | 缺口与下一步 |
|---|---|---|---|---|---|
| K1 | 结构化文档模型（节点 ID / 类型 / 数据元绑定 / 未确认标签分层） | ✅ | M/5 | `src/model/types.ts:116-150`（14 类节点、7 套标签体系）、`src/model/validate.ts:1-11`（结构校验 + 11 条语义硬规则）、`schema/l0-document-model.schema.json` | 地基无缺口。`unconfirmedTags` 把"机器绑上"与"人工确认"分层，这是后面所有门控的前提 |
| K2 | 视图与数据分离 + 数据集导出 | ◐ | M/3 | `src/export/wst500.ts:16-17`、`src/import/wst500-import.ts:2-21`（导出→导入逐项一致即验收） | 只有 WS/T 500 最小映射；**WS 445 / 医保数据集无任何代码**；OID 后缀待院方核对 |
| K3 | 流式排版（动态重排）与分页预览 | ○ | M/5 | 反向证据：`src/export/ofd.ts:584`（`paginatePages` 只在导出端）、`tools/model-check/perf-check.mjs:21`（P11 输入延迟 **SKIP**） | 编辑器内没有排版引擎，正文是节点流；"插入后重排无错位"无可测对象。做与不做要单独决策，不要写在 V1 |
| K4 | 模板体系与医学表达式控件 | ◐ | M/4 | `src/template/engine.ts:70`（8 类槽位 text/paragraph/field/expression/table/list/control/image）、`src/template/expression.ts:110`（算子仅 add/mul/round/min/max）、`samples/packs/doc.template.builtin.json` | 表达式算子过窄；控件形状/语义是闭集（5 形状 6 语义）；有 3 类内置文书 + 5 个控件，**没有专科包体系** |
| K5 | 留痕修订（op 闭集 / 快照 diff / 重放 / 撤销 / 链式账本 / 回到任意 rev） | ✅ | M/3 | `src/model/types.ts`（17 种 op）、`src/core/session.ts`（before/after 快照自动出 patch、`undoLast`/撤销组、`revertTo`）、`src/core/revision-ledger.ts`（append-only 链式账本，SM3）、`src/core/revert-self-test.ts`（V1–V8）、`src/storage/storage-self-test.ts`（D14/D15）、`tools/model-check/node-diff-check.mjs`（D1–D6 + 5 个 `--inject-*` 反向自证） | 已闭环：留痕=>写：写入内核 => 账本=> storage 链式追加（删一条即断链、验链当场发现）=> 回滚=> `revertTo(rev)` 反放 patch。仍缺：外部时间戳锚定（无 TSA），故"防篡改"只能说到"篡改可发现"；界面没有"历史版本"面板 |
| K6 | OFD-H 原生生成 + 机读信息 | ✅⛔ | M/5 | `src/export/ofd.ts:1-22`（真容器、文本禁路径化）、`src/model/machine.ts:79-156`、`MachineReadable.xml` 命名空间 `urn:cn:ofdh:machine:1.0`、`tools/ofd-check/ofd-roundtrip-check.mjs`（C1–C5） | **不得声称符合 GB/T 48666**：标准正文未公开，`schema/l0-document-model.ts:16` 用 `extensions` 占位；C3 机读检测是启发式 |
| K7 | 签名与国密（SM2/SM3 + 认证加密信封） | ✅ | M/3 | `src/crypto/sm2.ts`、`sm3.ts`、`envelope.ts`（SM4-CTR + HMAC-SM3，Encrypt-then-MAC）、`signature.ts:71-75`（规范化字节序列有用例锁死） | **SM4 由运行时 OpenSSL 提供，不自研**；自研密码学未经第三方审计 → 生产须换经认证模块（内核留替换点） |
| K8 | 打印 / 套打 / 屏幕一致 | ○ | S/3 | 反向证据：`src/` 无 `window.print`、无 `@media print`、无套打实现；只有导出端页面家具（见 K11） | 医院归档绕不开打印；一致性无对照用例 |
| K9 | 信创适配（麒麟/统信、达梦/金仓） | ○ | M/3 | 反向证据：存储走 `node:sqlite`（`src/storage/sqlite.ts`），无国产 OS/DB 适配层，无互认/测试报告 | 需实机验证 + 厂商互认，属资质战不是技术战 |
| K10 | 多端宿主 | ◐ | S/4 | `src/demo/capture-web.js`（浏览器真麦克风 + 重采样 16k）、`tools/voice-client/VoiceCaptureClient.cs`（Windows 单文件 exe/托盘/开机自启）、`src/dictation/local-capture-client.ts`（Node 本机客户端，**无真实麦克风**） | 无 Electron / 桌面控件形态；"同一内核 3 种宿主行为一致"目前只有语音采集这一条链成立 |
| K11 | 导出端分页与页面家具（页眉/页脚/页码/装订边/孤行控制） | ✅ | S/3 | `src/export/ofd.ts:34-111,722-755`（页眉页脚走独立 Layer，占位符 `{docType}{patient}{visitId}{page}{pages}{docId}`）、`src/export/ofd-self-test.ts:496,531`（E4/E5） | 只解决"导出件能散页归位"，不解决"屏幕上怎么排"（K3） |
| K12 | 审签状态机（提交审核 / 裁决 / 作废 / 归档 + 回退拒绝） | ✅ | M/3 | `src/core/session.ts`（`submitForReview`/`review`/`voidDoc`/`archiveDoc`，共用 `performSign` 与状态门禁 `assertMutable`）、`src/core/review-flow-self-test.ts`（R1–R12）、`src/server/http-self-test.ts`（A9/A10）、`src/demo/ui-self-test.ts`（B76） | 状态迁移全部留痕（`submit`/`review`/`void`/`archive` 四个 op 进闭集）；审核中内容冻结；审核通过即签章（签名人 `reviewer`，与自签的 `author` 区分）；**作废/归档是终态**；留痕可还原整条审签流（审计报告「审签流程」小节）。仍缺：撤回提交（submit 之后要撤销只能走退回） |
| K13 | OFD 导入与版式段落重建 | ✅ | M/3 | `src/import/ofd-import.ts:4-20`（识破路径化文本、抽机读块、判原件/副本）、`src/import/layout.ts:2-19`（行距/缩进/字号/左边界四线索，带 confidence） | 导入件一律 `origin:'imported'`、`humanConfirmed:false`、带 sha256 证据；"只有一段且行距均匀时原理上不可恢复"已如实标注 |
| K14 | 患者主索引 EMPI | ◐ | S/4 | `src/model/identity.ts:71-200`（register/resolve/merge/snapshot，三原则：不猜/冲突不覆盖/合并可追溯）、`src/model/identity-self-test.ts` | 模块与自测在，**存储层无标识表、演示服务未接**（`src/core/store.ts:50-55` 自述） |
| K15 | 趋势派生视图 | ✅ | S/3 | `src/model/trend.ts:87-177`（缺采样时刻/单位冲突/未确认点均出 warning，不硬凑） | 不做单位换算、不做"变化是否已写进病程"的语义判断 |
| K16 | 跨次就诊对比 / 沿用上次用药 | ✅ | S/4 | `src/compare/visit-compare.ts:1-60`、`/api/visit-compare`、`/api/compare/carry-over` | 只做编码相等 + 原文级搬运，**明确不做语义相似度** |
| K17 | schema 版本迁移 | ◐ | S/3 | `src/model/migrations.ts:44-73`（链式框架 + 1 条 0.9.0→1.0.0）、`:107-127`（无路径显式抛错） | 框架有、存量迁移库近乎空；上线前必须补"旧数据能开"的实证 |
| K18 | 存储与密钥生命周期 | ✅ | M/4 | `src/storage/sqlite.ts`（WAL / `synchronous=full` / 每迁移一事务 / 库版本高于程序即拒启）、`sealed.ts`（口令为空直接拒）、`rekey.ts` + `src/core/rekey-cli.ts`、`npm run salt:*` | 无增量同步（整文档读写）；无多实例协调 |
| K19 | 并发写与冲突语义 | ◐ | M/4 | `src/storage/work-store.ts:68-74`（内容摘要 CAS）、`persistence.ts:71-113`、`src/core/concurrency-self-test.ts` | **缩小而非消除**竞态窗口；无文件锁；`E_CONCURRENT_MODIFICATION` 有界面出路（`/api/reload-sidecars`） |
| K20 | 真实时间戳 + 书写时长 | ◐ | M/3 | `src/core/writing-timing.ts:69-112`（累计器与口径：有效时长 / 空闲阈值 / 可信标记）、`src/core/session.ts:2115`（`resolveAt`：形状与单调两道门）、`:1920`（一次提交一个时间锚点）、`src/core/writing-timing-self-test.ts`（W1–W11） | 留痕可注入墙钟（`WriteOptions.at`/`SessionOptions.clock:'wall'`），书写时长按"相邻书写间隔 ≤ 空闲阈值"累计、超阈值计入 `idleMs`；**时钟仍为本地 `Date.now()`，无 TSA**，故 `trusted:false` 时不得对外报数（仍受 G9 约束）。书写时长本体落盘只到 `extensions`；留痕账已改为 append-only 链式（见 K5/K21） |
| K21 | 回到历史版本（`revertTo`）+ 留痕账链式存证 | ✅ | M/3 | `src/core/session.ts`（`revertTo`：反放留痕 patch，`E_REVERT_TARGET`/`E_REVERT_IMPOSSIBLE`）、`src/core/revision-ledger.ts`（每份文书一条 SM3 链，`prev_hash`/`hash`/完整 `payload`）、`src/storage/schema.ts`（迁移 `0008-revision-ledger`）、`src/core/revert-self-test.ts`（V1–V8）、`src/storage/storage-self-test.ts`（D13–D15）、`src/server/http-self-test.ts`（A11）、`src/demo/ui-self-test.ts`（B77） | `revertTo(rev)` 只改内容、不改状态，回滚本身占一条留痕（记着回到哪一版、跨过哪些 rev，回滚后来也还能被回滚回去）；**只能回到自己写的那一版**（区间里有他人内容修改则 `E_REVERT_FOREIGN_WRITE`/403，他人送审/退回不挡路）；留痕账只追加，删一条/改一条验链当场发现，保存时发现对不上则**显式失败**（不修补、不覆盖）。迁移 `0008` 会把没有链的旧留痕账清零、下次保存时重建。**边界**：篡改可发现 ≠ 不可抵赖（缺第三方时间戳/存证，见 G9）；界面没有"历史版本"入口 |

## 四、L1 AI 接入与门控（决定能否换模型、能否过合规）

| 编号 | 能力 | 现状 | 评分 | 证据 | 缺口与下一步 |
|---|---|---|---|---|---|
| A1 | 模型网关（可替换 / 本地推理 / 超时 / fail-closed） | ◐ | M/3 | `src/ai/adapter.ts:78-81`（`suggest()` 只吃脱敏上下文包，**拿不到写会话**）、`http-adapter.ts:198-320`（OpenAI 兼容 + AbortController/Promise.race 双保险）、`model-config.ts:30-51` | 无重试、无建议缓存；**本地推理只到协议层**（vLLM/Ollama 可接，仓库无推理进程）；无成本配额 |
| A2 | 上下文供给（HIS/LIS/PACS/CDR 取数） | ◐ | M/4 | `src/core/ai-context.ts:113-288`（`AiContextPackage`、预算如实上报、`droppedTargets`）、`src/core/session.ts:1883-1985`（系统推送落地：幂等、不覆盖人工、evidence 必填） | **无拉取式取数器**；`EvidenceKind` 11 类里只有 dictation / patient / system 三类有真实产出 |
| A3 | 术语 / 指南 / 模板知识库 | ◐ | M/3 | `src/knowledge/pack.ts:48-117`（template/rule/term 三类包 + 11 个错误码）、`src/knowledge/default-registry.ts:35-40`（**term 引擎留空，术语包载入即拒**） | 术语包引擎未实现；指南/语料无；包无导出、无版本号（用内容指纹替代） |
| A4 | 成本与性能配额 | ○ | S/3 | 只有 `maxItems` 与 `tokenBudget`（字符预算，`ai-context.ts:124,169-171`）；限流仅 demo 服务端四桶（`demo-server.ts:1982-1994`），契约服务端无 | 无 token 计量、无成本核算、无月度用量；上线谈价时会立刻被问 |
| A5 | 数据不出院 + 审计 | ◐ | M/2 | `http-adapter.ts:213-218`（选了远端却无 endpoint 直接拒，不退化成离线模板）、`asr-adapters.ts:174-187`（**音频出院守卫**：未显式确认即拒绝）、`model-config-store.ts:14-41`（密钥单独加密行、只报 `apiKeyPresent`、清除即真删） | 无出站网络守卫/可验证"零外呼"证据；无租户边界 |
| A6 | AI 沉默报告（没产出的原因要能说清） | ✅ | S/3 | `src/ai/adapter.ts:182-444`（9 档原因码，含 empty-target / context-budget / missing-target / max-items / unexplained）、界面 `src/demo/ui.js:2957-2959` | 同类产品普遍只说"生成成功"，这一条是差异化，值得在对标里单列 |
| A7 | 建议通道（幂等 / 分组 / 三级归因 / 批量采纳逐条过门控） | ✅ | M/4 | `src/core/suggestions.ts:99-207,289-373`（原样/微改/大改 + unknown 单列，恒等式有用例守）、`session.ts:1108-1172`（一条没落笔就不提交） | 归因口径已固定一处，改动需同步指标 |
| A8 | 即时结构化（写作当下打标 → 未确认标签） | ✅ | S/3 | `src/ai/structuring.ts:1-139`（只产提议、未命中不打标）、`session.ts:1494-1536` | 与"落位"共用匹配器但不共用结论，两者混用会互相污染 |

## 五、L2 临床场景能力（用户可见）

| 编号 | 能力 | 现状 | 评分 | 证据 | 缺口与下一步 |
|---|---|---|---|---|---|
| I1 | 语音转写 + 段落落位 | ◐ | M/4 | `src/dictation/asr-adapters.ts:13-40`（对账表：院内靶子 ASR 走通、真实服务不可达；百度/阿里**未对真实服务调过**）、`placement.ts:42-93`（ordered/section-title/term-table/external 四策略，置信度上限强制 <0.90）、`src/dictation/capture-bridge.ts`（ack 语义：取走≠处理完） | **无可用真实 ASR 端点**（未配即 `E_CAPTURE_NOT_CONFIGURED`，不静默退回模拟转写）；**术语规范化未实现**（无术语表/术语包）；音频默认不留存 |
| I2 | 草稿生成 / 续写 / 润色 | ◐ | M/4 | `src/ai/adapter.ts:32-33`（complete/draft/polish 三 mode 同一条建议通道）、`http-adapter.ts:75-109`、`offline-adapter.ts:44-70`（确定性模板） | 通道齐，真实产出取决于所配模型；**无采纳率实测**（见 G5） |
| I3 | 数据找人（检验/监护 → 语句 + 趋势） | ◐ | S/3 | `session.ts:1873-1985`（`applyExternalData`：幂等、`E_EXTERNAL_CONFLICT` 防覆盖人工）、`model/trend.ts` | 数据落地与派生视图有，"**自动生成语句**"刻意不做；无单位换算 |
| I4 | 术语规范化 → ICD / DRG-DIP 预编码 | ○ | S/4 | 反向证据：无编码引擎；只有 A8 的即时打标与标签体系闭集 | 全部待做。厂商宣称 95%+ Top1，必须自测 |
| I5 | 事中质控（形式 + 时限 + 内涵） | ◐ | M/5 | `src/qc/form-rules.ts:115-148`（7 种封闭谓词、判不了与没命中分离）、`src/qc/seed-conditions.ts:48-217`（6 条种子判定方式）、`samples/packs/qc.form.builtin.json` + `qc.timelimit.builtin.json`、`src/qc/content-engine.ts:29-130`（内涵类引擎**未接入且如实上报**） | 形式类 3 条 + 时限类 4 条样例；内涵类只有契约与校验；规则条数=包里声明多少跑多少，**空库即"质控不可用"** |
| I6 | 跨文书一致性检查 | ◐ | S/5 | `src/model/consistency.ts:107-160`（只比 `system|code` 编码）、`src/qc/visit-timeline.ts`（缺口画在轴上，与谓词同口径）、`src/compare/visit-compare.ts` | **明示不查语义矛盾**；`severity` 只影响呈现、不参与门控 → 不能称"一致性拦截" |
| I7 | 后结构化（历史文书 → 结构化） | ◐ | S/4 | `src/import/import-any.ts:1-50`（按魔数嗅探 OFD-ZIP / ClinicalDocument，认不出即报错，**无 PDF/OCR 分支**）、`layout.ts` | PDF/扫描件不支持；`test:external` 9 条因无真实样例长期红灯 |
| I8 | 院内病历检索问答（RAG） | ○ | O/4 | 反向证据：无检索/向量/权限裁剪模块 | 权限 + 脱敏 + 越权零访问是硬门槛，不建议早做 |
| I9 | 多模态（心电/影像结论入文书） | ○ | O/5 | `src/media/image-probe.ts:1-52`（只读 PNG/JPEG/WebP 头得格式/宽高/DPI，**明确拒绝 DICOM**） | 只有图片探测，无理解能力；DICOM 直接不支持 |
| I10 | 患者版通俗解释 | ○ | O/2 | 反向证据：全仓仅本文档 v1.0 提到过 | 无任何实现 |
| I11 | 预问诊（患者自填 → 医生勾选 → 只出建议） | ◐ | M/3 | `src/previsit/previsit.ts:1-242`（六项白名单、**诊断章永不在映射表**、缺章如实报）、`previsit-access.ts`（机对机 sha256 鉴权）、`demo-server.ts:7697-7780`（准入先于解析） | **无患者端表单界面**（只有医生端读取侧）；预问诊内容不进 AI 上下文包 |
| I12 | 出院小结（原文搬运 + 缺口核对） | ✅ | M/3 | `src/summary/discharge-summary.ts:1-356`（五章映射、缺口 5 档码、每条带 `DeriveSource` 可跳回源文书） | 定位是"搬运 + 核对"，不是"生成"——对外别混为一谈 |

## 六、L3 治理·安全·合规（最不能省）

| 编号 | 能力 | 现状 | 评分 | 证据 | 缺口与下一步 |
|---|---|---|---|---|---|
| G1 | 置信度门控（AI 只出建议，落笔必过人工） | ✅ | M/3 | `session.ts:2207-2211`（`E_AI_DIRECT_WRITE_FORBIDDEN` 内核级硬拦）、`:879-935`（采纳必须自然人 + 过阈值，落笔后仍 `humanConfirmed=false`）、`:1799-1836`（签章三类门控） | 阈值内核可配（0.75 / 关键内容 0.90）但**界面只读、无配置入口**；强制确认靠通用 `keyContent`，**不是诊断/剂量/过敏/术式专用名单** |
| G2 | 来源可追溯（逐句回溯） | ◐ | M/4 | `model/types.ts:61-94`（`EvidenceRef` / `EvidenceKind` 11 类）、`:160-170`（run 级 provenance，按 `aiRanges` 切分）、`core/text-runs.ts:221-230` | **界面没有"点这句话跳回来源"**（`ui.js` 全文检索 `evidence` 零命中）；`rationale` 被明示"不是 evidence"。数据齐、出口缺 |
| G3 | AI 参与度标记 | ◐ | M/2 | origin 四类 human/ai/system/imported（`session.ts:914-924,1974-1982`）、`machine.ts:10-18`（参与度进机读块）、`audit-report.ts:57-81`（参与度统计与明细表） | **无独立参与度摘要字段**，靠节点摘要间接进签名；不能对外说"参与度单独入签名链" |
| G4 | 权限分级 / 脱敏 / 受控阅读 | ◐ | M/3 | `src/auth/principal.ts:28-45`（四角色 × 15 动作，漏配即谁都不能做）、`core/controlled-reading.ts:38-67`（内容指纹 + 时效 + 次数 + 环境 + 章节白名单 + 遮蔽身份 + 用途）、`storage/reading-grant-store.ts` | **无租户隔离**（`tenant` 恒 `'default'`）；脱敏只有姓名掩码，无字段级规则引擎；无 TLS/MFA/CA/SSO |
| G5 | 评测与回放（含修改率曲线） | ◐ | M/3 | `suggestions.ts:452-512`（采纳率/修改率/拒绝率 + 三级归因）、五条可跑可退码的验收链（见 D5） | **无 200~500 份效果评测集、无版本对跑回放报告** → 不得对外报采纳率/修改率数字 |
| G6 | 责任边界与告知设计 | ◐ | M/2 | 界面标注"低于阈值/待确认"（`ui.js:2957-3017`）、签章门控、审计报告签名主体为人 | 无院内制度模板/知情同意材料；无一处统一的"AI 建议、医生确认"告知页 |
| G7 | 生成式 AI 合规材料（备案路径） | ○ | M/2 | 反向证据：仓库无相关材料 | 需法务与备案口径，产品侧无法自证 |
| G8 | 签名服务接入（声明式映射 + 失败码闭集） | ✅ | M/3 | `src/sign/sign-config.ts:22-74`（三条红线：fail-closed / 密钥单独入库 / 指纹固定；**不支持从证书提取公钥**）、12 个失败码闭集、`E_SIGN_NOT_CONFIGURED`（**无内置软件签名可回退**） | 依赖医院签名服务；未配置即整块不可用 |
| G9 | 可信时间戳 | ○ | M/3 | 反向证据：`src/crypto/` 无 TSA/时间戳令牌模块；全仓"时间戳"命中均为记录时间字段 | 无时间戳、无第三方存证；与院内 CA 一起谈才划算 |
| G10 | 审计与防篡改 | ◐ | M/3 | `src/core/admin-audit-store.ts:23-36`（SM3 链式摘要，断点后不展示但不删）、`admin-audit-anchor.ts:1-35`（链头 SM2 签名，可检出删尾/整链重写）、`audit-report.ts`（`reportDigest` 覆盖全内容） | **不防拿到私钥的人**；锚点私钥可用演示种子推导；非合规级存证。README"没有审计防篡改"一句已过时 |
| G11 | 鉴权与会话 | ✅ | M/3 | `src/auth/user-store.ts`（scrypt 独立盐、最后一个管理员保护、改口令即踢会话）、`session-store.ts`（只存 SM3 指纹、TTL、滑动过期、`revokeAllFor`）、`rate-limit.ts`（四桶） | 会话在内存，进程重启即失效；无 MFA |
| G12 | 受控阅读授权闭环 | ◐ | M/4 | `src/core/encrypted-reading.ts:9-14`（**授权即密钥交付**：DEK 被接收方公钥封装进被签名的授权书）、`src/reading/reading-authority.ts:38-41`（无信任根即拒一切）、`:23-26`（`endpoint` 仅登记，**签发/同步协议未实现**） | 本系统**不签发**授权（不持有签发私钥），只验签/登记/执行；诚实边界：先解密后校验授权 |

## 七、L4 工程验收与数据飞轮

| 编号 | 能力 | 现状 | 评分 | 证据 | 缺口与下一步 |
|---|---|---|---|---|---|
| D1 | 修改行为回流（模板/提示词迭代） | ◐ | S/4 | `src/core/suggestions.ts:90-207`（`SUGGESTION_EDIT_BANDS` / `editRatioOf` / `attribution()`） | 指标有了，**回流迭代（自动改模板与提示词）没有**；不要写成"数据飞轮已转" |
| D2 | 专科知识资产（模板包/规则包/术语包） | ◐ | S/3 | `src/knowledge/pack.ts`（三类包 + 内容指纹）、`src/qc/plugin.ts:1-55`（包=数据不签也收，插件=代码必须验签）、`samples/packs/`（3 个包 / 7 条规则 / 5 个控件）、`src/content/content-store.ts`（内容层：内容段落 / 常用语，三档作用域，一作用域一行） | 无专科包体系、无包导出、无版本号；术语包引擎空（A3）；内容层已通到医生端（Ctrl+K 两组 + 抽屉 + 从当前段另存，含 PHI 关卡），但**条目不能上收**（个人 → 科室 / 全院的"提交为片段"未做），也无"从整份文书取一段以上"的选择器 |
| D3 | 评测集与标注流程 | ○ | M/3 | 反向证据：无评测集目录/标注文件；`samples/` 是契约样本与性能基线，不是效果评测 | 每季度 +100 份、标注一致性 κ≥0.8 全部是纸面目标 |
| D4 | 训练数据合规（伦理/去标识/联邦） | ○ | S/4 | 反向证据：无伦理审批流程代码、无联邦学习 | 现有 `phi-scan` 只是发布前扫描，不是训练数据合规 |
| D5 | 三条独立验收链 + 独立探针 | ✅ | M/4 | `tools/ofd-check`（C1–C5，含 `--require-signature`）、`tools/model-check`（schema 对拍 / node-diff / perf / **ai-path 26 条门控契约 + `--noncompliant` 鉴别力自证**）、`npm run test:http`（契约直打真服务端） | "自己说导出了不算数"这条纪律是资产，对标时可直接当证据链出示 |
| D6 | 性能基线 | ✅ | S/3 | `tools/model-check/perf-check.mjs`（P1–P10）、`perf-baseline.json`（100 页 / 3201 节点 / 0.93MB，P1 加载 6.2ms）、`npm run perf:1000p`（千页线性度） | P11 输入延迟 SKIP（与 K3 缺排版引擎同源） |
| D7 | 发布前隐私与密钥扫描 | ✅ | M/2 | `src/security/phi-scan.ts`（四档结论、`.ofd` 解包逐条目扫、命中打码、`phi-scan.reviewed.json` 人工复核） | 模式匹配不是合规审计；未检查项（截图/加密产物）仍需人看 |
| D8 | 自测规模与红灯登记 | ✅ | M/3 | `package.json`（76 个 `test:*` / 1022 条用例）、`README.md`「已知红灯」逐条列明（外部样例 9 / Chromium 2 / exe 1 / UI 漂移 6） | 红灯不删不改口径是可复现的前提；`test:ui` 6 条属产品侧判断，未收敛 |

## 八、不得宣称（对外口径红线）

1. **不得声称符合 GB/T 48666**：正文未公开，命名空间用 `extensions` 占位，`tools/ofd-check` 明确不做符合性判定。
2. **不得声称符合 WS/T 500**：只有最小可用映射与双向闭环验收，OID 与数据元待院方核对。
3. **不得声称"国密三件套全自研"**：SM2/SM3 自研，**SM4 由运行时 OpenSSL 提供**；且自研密码学未经第三方审计。
4. **不得作为合规证据**：生产必须换成经认证的密码模块（内核留了替换点，注入后上层零改动）。
5. **演示私钥可由公开种子推导**（`DEMO_SIGNING_SEED` 在源码里），只用于演示与可复现验收。
6. **未配置医院签名服务时签章整块不可用**：系统没有"内置软件签名"可回退。
7. **受控阅读需院内授权平台**：本系统只验签、登记与执行，**不签发授权**。
8. **内涵类质控未接入**（形式类与时限类是本地纯函数，可用）；外部落位服务未接入，未配置即拒。
9. **无租户隔离、无 TLS/MFA/CA/SSO**；`contract-server` 默认 `trusted` 模式（任何调用方可自称 human，只在响应头标注），**不可直接暴露到网络**；`verified` 模式下读接口仍不要求凭证。
10. **无排版引擎、无分页预览、无打印/套打**；大文档整文档读写，无增量同步；并发用 CAS 缩小竞态窗口而非消除。
11. **无时间戳、无第三方存证**：管理审计链与文书留痕账都是**局部**链式结构 —— 删一条、改一条当场可发现，
    但持有库文件的一方仍能整条链重算（无第三方见证、无外部锚定），
    所以**不得对外称"不可抵赖""已存证""证据保全"**，只能说"内部篡改可被发现"。
12. **不得对外报采纳率/修改率数字**：有指标口径，无效果评测集。
13. **书写时长只在 `trusted:true` 时可报数**：`clock:'wall'` 只是本地 `Date.now()`，无 TSA、无签名时间戳，
    故不可用于举证；且它是质控线索，**不是绩效考核口径**（挂机刷时长是必然反应）。
14. 演示数据全部为虚构（姓名掩码、身份类号码合成），`artifacts/` 不入库。

## 九、V1 范围建议（按现状重排，不再按愿望排）

**已经能对外讲的（拉清单时可直接出示证据）**：
K1、K5、K6、K7、K11、K12、K13、K18、K21、A6、A7、A8、G1、G8、G10、G11、D5、D6、D7、D8。

**V1 必须补的短板（按"缺了就上不了生产"排序）**：

| 序 | 短板 | 最小可用口径 | 为什么排这个位次 |
|---|---|---|---|
| 1 | 逐句回溯出口（G2） | 建议与节点上"查看来源"可点，跳到 evidence 指向的节点/字段 | 数据结构齐，只缺界面；这是共识文件里"可追溯"最容易被验的一条 |
| 2 | 打印链路（K8） | 屏幕/导出/打印三处页面家具一致 + 静默打印参数 | 医院归档绕不开；现在只有导出件带页面家具 |
| 3 | 真实 ASR 端点 + 术语包（I1/A3） | 一家可用的院内 ASR + 一张能加载的术语表 | 语音是最高频卖点，却是全表最"演示态"的一格 |
| 4 | 界面补上审签/回滚的入口（K12/K21 后半） | 「提交审核 / 通过 / 退回 / 作废 / 归档」五个按钮 + 一个"历史版本"面板（点一条回到那一版） | 内核、契约层、demo 接口都已通（`ui-self-test` B76/B77 是 HTTP 全链路证据），只差界面；没有界面，"回到历史版本"就只对程序员可用 |
| 5 | 效果评测集（G5/D3） | 首版 100~200 份、固定口径、可一键回放 | 没有它，其余几项都只能证明"能跑"，不能证明"有用" |

> 变化（2026-10-19）：K12 审签状态机、K5 的留痕账 append-only、K21 回到历史版本三项完成，从本表移出（见第三节 K5/K12/K21 行）。

**明确延后（写在这里是为了以后有人问起时说"是决策不是遗漏"）**：
流式排版（K3）、内涵类质控接入（I5 后半）、院内 RAG（I8）、多模态/DICOM（I9）、患者版解释（I10）、ICD/DRG 预编码（I4）、EMPI 接库（K14）、租户隔离与信创互认（G4/K9）。

**范围纪律**：V1 只允许 1 个专科 + 1 类文书。当前 demo 横跨门急诊/入院/产科/出院，
那是**演示广度**，不是交付范围——把它当范围谈，第一批工单就会来自四个专科。

## 十、对标用法（验别人家产品）

拿本表逐项打钩，这四个问题能筛掉大部分"AI 病历"：

1. **审签**：状态机有几个状态、几个动作？能不能当场演示"提交审核 → 审核通过（即签章）→ 退回 → 作废 → 归档"？只有 `draft/signed` 一跳的，答不出"这份谁审的、凭什么签的"。
2. **门控**：有没有"关闭门控"的开关？AI 建议落笔后 `humanConfirmed` 是 true 还是 false？关键内容是靠通用标记还是靠诊断/剂量/过敏/术式专用名单？
3. **可追溯**：界面能不能点一句话跳回来源？跳不回去的，逐句回溯多半只存在于 PPT。
4. **证据链**：导出的 OFD 是否交给**独立探针**验过（不是自己解自己的包）？契约测试有没有"故意不合规实现必须被识别出来"的鉴别力自证？（D5 那套东西）
5. **留痕账**：直接问"我把库里的一条留痕删掉/改掉，你们的系统会发现吗？" —— 每次保存都整批重写留痕表的实现发现不了（库里答"从来没有过"）；链式只追加的实现会当场指出断在哪一条，并拒绝继续保存。

补充四个常用陷阱：

- **K6 + K2**：只看"支持 OFD"不算通过，要问"机读信息是不是独立文件、是否纳入签名覆盖、能否 round-trip 反抽"。
- **G3 + G10**：问"AI 参与度有没有单独入签名链"、"审计链锚点私钥谁保管"——答不出保管方式的，等于没有。
- **A5 + G4**：真私有化就问"怎么证明零外呼"，并要求现场断网演示；2026-03 共识要求本地化优先、严禁未脱敏数据上公有云。
- **G5 + D3**：问"评测集多少份、谁标注、κ 多少、上一版到这一版修改率变化多少"——只有"效果很好"没有数字的，就是没测过。
