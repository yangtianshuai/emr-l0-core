/**
 * Demo 界面 + 服务的验收自测（这一层最容易"看起来在跑、其实全废"）。
 *
 *   node src/demo/ui-self-test.ts
 *
 * UI 层自测的由来：曾踩到，内联脚本里一处嵌套模板字符串写错 `}`，
 * 整个 `<script>` 无法解析，结果页面正文空白、所有按钮无反应，而服务端全部接口正常、
 * 所有后端用例全绿。只测后端永远发现不了这类问题。
 *
 * 覆盖：
 *   A 静态检查：脚本可解析 / `$('id')` 引用的元素都存在 / `dataset.X` 对应的 `data-x` 属性都存在 /
 *      UI 调用的每个 `/api/*` 在服务端都有对应路由 / 失焦保存不会吞掉点击
 *   B 服务契约：启动真实服务打真实 HTTP，工作区树、切换病历后状态互相独立、
 *      门控行为、陈旧门，以及"导出 + 独立探针 PASS"
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TestSuite, assert, assertEqual } from '../testing/harness.ts';
import type { DataElementTag } from '../model/types.ts';
import { WST500_SAMPLE_XML } from '../import/wst500-fixture.ts';
import { demoKeyPair, softwareSigner } from '../crypto/provider.ts';
import { publicKeyFingerprint, publicKeyToSpki } from '../crypto/sm2.ts';
import { fromBase64, toBase64 } from '../crypto/signature.ts';
import { issueReadingGrant, type ReadingGrant } from '../core/controlled-reading.ts';
import { auditRecordHash } from '../core/admin-audit-store.ts';
import { SNAPSHOT_CONFLICT_CODE } from '../core/persistence.ts';
import { openDatabase } from '../storage/sqlite.ts';
import { MIGRATIONS, STORAGE_SCHEMA_VERSION } from '../storage/schema.ts';
import { WorkStore } from '../storage/work-store.ts';
import { createConfigKv } from '../storage/config-kv.ts';
import { saveSystemConfig } from '../storage/system-config.ts';
import { sealDocumentJson } from '../core/encrypted-reading.ts';
import { verifyAuditReport } from '../core/audit-report.ts';
import { importWst500 } from '../import/wst500-import.ts';
import { ASR_NO_CONFIDENCE_NOTE, encodeCaptureWav, parseCaptureWav } from '../dictation/capture.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
/**
 * 旁挂快照口令：测试进程与服务端必须用同一把。
 *
 * 它现在**写在服务端配置文件里**（`<运行目录>/server-config.json` 的 `stateKey`），
 * 不再是 `L0_STATE_KEY` 环境变量（见 `core/server-config.ts`：口令是解开库内密文的钥匙，
 * 存进它自己要开的库里等于没加密，所以留在进程能读到的文件里）。
 * 为什么测试要自己指定：B36（并发写）需要从测试进程写一份服务端能读的快照
 * （模拟"另一个终端改了同一份病历"），口令不一致就解密不了，而内置演示口令
 * 是 demo-server 兜底用的，测试不该去猜它。
 */
const STATE_KEY = 'selftest-ui-state-key';
/**
 * 测试用的后台账号。
 *
 * 产品侧已经没有任何内置口令（口令存在数据库里，由第一次运行时初始化），
 * 所以测试自己把账号造出来，而不是"去猜产品里那条演示口令"：
 * 后者只有在"产品里真的存在一条硬编码口令"时才成立，而那种设计正是这一轮要去掉的。
 */
const ADMIN_USER = 'ADMIN';
const ADMIN_PASSWORD = 'selftest-admin-password';
const QC_USER = 'qc-selftest';
const CLINICIAN_USER = 'dr-selftest';
const SELFTEST_ROLE_PASSWORD = 'selftest-role-password';
/** B37 用它验"登录失败有代价 + 成功会清零"（不能用 ADMIN 那个桶，否则会把后面要用的桶一起打满） */
const BRUTE_USER = 'brute-selftest';
const BRUTE_PASSWORD = 'selftest-brute-password';
/** 严格模式实例写进 `server-config.json` 的装机凭据（`bootstrap.token`）：用来证明"未初始化 + 已给部署凭据"那一档真的要求它 */
const STRICT_DEPLOY_TOKEN = 'selftest-deploy-token';

/**
 * 登录参数成对给出（用户名 + 口令）。
 *
 * 写成 `[用户名, 口令]` 两个常量而不是"一个角色名 + 一条口令"：后者在共享口令模型下成立，
 * 而现在的登录凭据就是这两样，用例读起来也该是这两样。
 */
const AS_ADMIN: [string, string] = [ADMIN_USER, ADMIN_PASSWORD];
const AS_QC: [string, string] = [QC_USER, SELFTEST_ROLE_PASSWORD];
const AS_CLINICIAN: [string, string] = [CLINICIAN_USER, SELFTEST_ROLE_PASSWORD];
/**
 * 测试专用的状态目录。
 *
 * 提成模块级常量而不是留在 `startServer` 里：B36（并发写）需要直接读写
 * 落盘的那份旁挂快照来模拟"另一个终端"，它拿不到启动函数里的局部变量。
 *
 * **可用环境变量换掉**（`L0_UI_SELFTEST_STATE_DIR`）：两轮自测同时跑时，抢同一个目录
 * 会在启动阶段以 `EPERM ... state-selftest` 收场，而那个报错看起来像"代码把文件写坏了"。
 * 不设变量时逐字节等于原来的行为。
 */
const stateDir = process.env.L0_UI_SELFTEST_STATE_DIR ?? join(ROOT, 'artifacts', 'state-selftest');
/**
 * 测试专用的**运行时根目录**：服务端配置文件（`server-config.json`）落在这里。
 *
 * 密封口令 / 盐 / 装机凭据是"打开数据库之前就要知道的东西"，现在只从这份文件读
 * （见 `core/server-config.ts`），所以每个实例都得有自己的一份，
 * 且与状态目录一样每轮清空重写 —— 否则会读上一轮残留的口令。
 * 同样可用 `L0_UI_SELFTEST_RUNTIME_DIR` 换掉（理由同上）。
 */
const runtimeDir = process.env.L0_UI_SELFTEST_RUNTIME_DIR ?? join(ROOT, 'artifacts', 'runtime-selftest');
const SERVER_CONFIG_FILE = join(runtimeDir, 'server-config.json');
const UI_HTML = join(ROOT, 'src', 'demo', 'ui.html');
const UI_CSS = join(ROOT, 'src', 'demo', 'ui.css');
const UI_JS = join(ROOT, 'src', 'demo', 'ui.js');
/** 正文渲染（逐个节点的那套 HTML）：医生端与管理后台的模板预览**共用这一份** */
const DOC_VIEW_JS = join(ROOT, 'src', 'demo', 'doc-view.js');
/** 自由流式视图（整页连续书写）：与 doc-view.js 并列的第二套正文画法。
 *  它同样**必须在 `script` 整体里** —— 否则"渲染里输出了 data-flow-seg、
 *  脚本里却读不到"这类跨文件断裂会被 A3 漏掉（那正是 A3 存在的理由）。 */
const FLOW_VIEW_JS = join(ROOT, 'src', 'demo', 'flow-view.js');
/** 自定义弹框（确认 / 提示 / 一句话）：医生端与管理后台共用的一份经典脚本。
 *  它**不在 `frontend` 整体里**（那会牵动一批结构断言），涉及它的检查单独读这个文件。 */
const DIALOG_JS = join(ROOT, 'src', 'demo', 'dialog.js');
const SERVER_TS = join(ROOT, 'src', 'demo', 'demo-server.ts');
/* 端口同样可换（`L0_UI_SELFTEST_PORT` 等）：两轮自测并行跑时，撞端口会以
   `EADDRINUSE` 收场，而它看起来像"上一次没退干净"。默认值一律不变。 */
const PORT = Number(process.env.L0_UI_SELFTEST_PORT ?? 8799);
/** 主实例的基地址（`loginAt` / `provisionAccounts` 要按地址打不同实例） */
const BASE = `http://127.0.0.1:${PORT}`;
/** 靶子签名服务的端口（与 demo 服务分开，免得"服务端自己签自己"看不出来） */
const SIGN_PORT = Number(process.env.L0_UI_SELFTEST_SIGN_PORT ?? 8809);
/** 靶子 ASR 服务的端口（同样与服务分开：真连一次，才谈得上"转发走通了"） */
const CAPTURE_PORT = Number(process.env.L0_UI_SELFTEST_CAPTURE_PORT ?? 8829);
const CAPTURE_ASR_URL = `http://127.0.0.1:${CAPTURE_PORT}`;
/** 部署声明的模型标识（该 ASR 不返回模型信息，只能由部署方声明，且必须带版本/日期） */
const CAPTURE_MODEL = 'local/asr-zh-med:0.9@2026-09-selftest';
/** 靶子 ASR 固定回的文本：断言"拿回来的就是服务给的那句" */
const CAPTURE_TEXT = '患者三天前无明显诱因出现咳嗽，咳白色黏痰。';
/** 一段合法的 16k / 单声道 / 16-bit PCM WAV（采集端固定产出这一种格式） */
const CAPTURE_AUDIO = encodeCaptureWav(new Uint8Array(3200));
/** 本地采集客户端的端口（C3b③ 的桥）：与其它靶子服务分开，免得互相踩端口 */
const CAPTURE_CLIENT_PORT = 8931;
/** 桥的一次性令牌（真实部署里由客户端打开页面时带上；这里显式给出，便于断言"错令牌被拒"） */
const CAPTURE_CLIENT_TOKEN = 'selftest-capture-token-1';
const FIRST_DOC = 'doc_001_opd';
const SECOND_DOC = 'doc_001_opd_prev';

const suite = new TestSuite('Demo 界面与服务验收自测', [
  '说明：A 部分是"零成本静态检查"，能在 1 毫秒内发现让整个页面失效的语法/引用错误；',
  'B 部分用真实 HTTP 打真实服务，验证用户点到的每一条链路（含切换病历后状态是否真的独立）。',
]);

const test = (name: string, fn: () => void | Promise<void>): Promise<void> => suite.test(name, fn);

const html = readFileSync(UI_HTML, 'utf8');
const css = readFileSync(UI_CSS, 'utf8');
/** 架构拆分后脚本独立成 ui.js；正文渲染又搬到了 `/doc-view.js`（医生端与管理后台共用）。
    静态检查的"脚本"是**两份合起来**：否则"渲染里输出了 data-x、脚本里却读不到"
    这类断裂会因为跨了文件而漏掉 —— 而那正是 A3 / A28 / B25 / B27 要守的东西。 */
const script = `${readFileSync(UI_JS, 'utf8')}\n;\n${readFileSync(DOC_VIEW_JS, 'utf8')}\n;\n${readFileSync(FLOW_VIEW_JS, 'utf8')}`;
/** 流式视图单独读一份：涉及它的断言要能明确"这条是它的事"，而不是混在 `script` 整体里 */
const flowScript = readFileSync(FLOW_VIEW_JS, 'utf8');
const serverSource = readFileSync(SERVER_TS, 'utf8');
/** ui.html 现在不含内联 <script>/<style>，结构性断言直接看它 */
const markup = html;
/** 前端整体（结构 + 样式 + 脚本）：用于"引用完整性"类检查（dataset 属性、api 路径等跨文件存在） */
const frontend = `${html}\n${css}\n${script}`;
/** 去注释后的 CSS：结构纪律针对的是属性声明（max-height 等），注释里出现这些字样不违规 */
const cssNoComments = css.replace(/\/\*[\s\S]*?\*\//g, '');

function kebab(name: string): string {
  return name.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
}

interface ApiResponse {
  ok: boolean;
  code?: string;
  message?: string;
  state?: DemoState;
  /**
   * 粘贴落位结论（`/api/paste-text`）：哪几段被挪到了哪一章、凭什么。
   *
   * 它在**响应顶层**（与 `state` 同类：描述"这次调用是怎么做的"，不是"产出了什么"），
   * 与前端 `placementNote(r.placement)` 读的是同一处 —— 两个位置读岔了，界面就永远沉默。
   */
  placement?: {
    enabled: boolean;
    moved: number;
    warnings: string[];
    items: Array<{
      index: number;
      matched: string | null;
      reason: string;
      sectionId: string | null;
      sectionTitle: string | null;
      moved: boolean;
    }>;
  } | null;
  /**
   * 即时结构化的提议结果（`/api/structure-propose`）：哪几段提议绑哪个数据元、凭什么。
   *
   * 同样在**顶层**（与 `placement` 同类：它描述"这次判定是怎么做的"）。
   * 它是 `?` 而不是 `| null`：这个接口每次都给一份结果（包括"策略不参与"那一档）。
   */
  structure?: {
    enabled: boolean;
    proposed: number;
    warnings: string[];
    strategy: string;
    items: Array<{
      index: number;
      nodeId: string | null;
      text: string;
      tag: DataElementTag | null;
      matched: string | null;
      confidence: number;
      reason: string;
      existingTags: DataElementTag[];
      keyContent: boolean;
    }>;
  };
  /**
   * 各接口自己的附加数据。
   *
   * 这里**列出的是断言真的会读的字段**（不是全量接口文档）：字段够用就好，
   * 因为它的作用只是让"读了一个不存在的字段"在 typecheck 阶段就暴露 ——
   * 断言读错字段名时，那种错误在运行期表现为 `undefined`，与"接口没返回"分不开。
   */
  data?: {
    suggestionId?: string;
    docId?: string;
    pages?: number;
    /* 模板库 / 科室字典那几个接口的返回 */
    itemId?: string;
    packId?: string;
    status?: string;
    formula?: string;
    action?: string;
    fingerprintAfter?: string;
    removedCodes?: string[];
    /* 科室字典 / 文书类型保存后的回执：被去掉的条目要如实点名 */
    removedKeys?: string[];
    enabledCount?: number;
    /* 多行粘贴（`/api/paste-text`）新建的文本节点：界面据此把光标放进第一段 */
    textNodeIds?: string[];
    /* 即时结构化采纳（`/api/structure-apply`）的回执：真的绑上了哪几条、跳过哪几条及原因 */
    applied?: Array<{ nodeId: string; tag: DataElementTag }>;
    skipped?: Array<{ nodeId: string; tag: DataElementTag; reason: string }>;
  };
}

interface TreeSection {
  id: string;
  title: string;
  hasUnconfirmed: boolean;
}

interface TreeDoc {
  docId: string;
  title: string;
  status: string;
  rev: number;
  active: boolean;
  machineStale: boolean;
  machineCount: number;
  unconfirmed: number;
  pending: number;
  sections: TreeSection[];
}

interface TreePatient {
  patientId: string;
  nameMasked: string;
  gender: string;
  age: number;
  visits: Array<{ visitId: string; visitType: string; dept: string; date: string; docs: TreeDoc[] }>;
}

interface DemoItem {
  kind: string;
  id: string;
  /** 章节的人话名（只有 `kind === 'section'` 有）：正文按文档顺序下发，段落据此归到哪一章 */
  title?: string;
  keyContent: boolean;
  humanConfirmed: boolean;
  /** 来源：human | ai | system | imported */
  origin: string;
  text?: string;
  tags?: Array<{ system?: string; code: string; display?: string }>;
  /** 机器绑上、待人确认的标签（采纳后出现；确认该段内容即消失，未消失则签章被拦） */
  unconfirmedTags?: Array<{ system?: string; code: string; display?: string }>;
  /** 字段/派生值的显示文本（界面据此渲染 input） */
  value?: string;
  unit?: string;
  /** 段落在本节的位置（界面据此禁用"上移/下移"） */
  paragraphFirst?: boolean;
  paragraphLast?: boolean;
  /** 由模板实例化而来时的出处：界面据此把"系统带入"改写成"模板带入" */
  templateRef?: string;
  /** 列表项的行首标记（只有 `kind === 'listItem'` 有）：`· ` 或 `1. `，由服务端算 */
  marker?: string;
  /** 列表项里文本节点的 id：界面用它走 `data-edit` 那条写路径 */
  textId?: string;
  /** 列表项里填写项的 id：界面用它走 `data-field` 那条写路径 */
  fieldId?: string;
}

interface DemoState {
  /** 接收方公钥目录（全局，不属于某份文档的阅读记录；只含公钥） */
  recipientKeys: {
    keys: Array<{ keyId: string; label: string; spkiBase64: string; fingerprint: string }>;
    error: string | null;
  };
  activeDocId: string;
  patient: { patientId: string; nameMasked: string; gender: string; age: number | null };
  encounter: { visitId: string; visitType: string; dept: string; visitDate: string };
  doc: { docId: string; docType: string; status: string; rev: number };
  tree: TreePatient[];
  items: DemoItem[];
  suggestions: Array<{ id: string; status: string; confidence: number; modified: boolean; editRatio: number | null; editBand: string | null }>;
  metrics: { suggested: number; accepted: number; rejected: number; modified: number; editRate: number; rejectRate: number };
  /** 三级归因（原样 / 微改 / 大改 + 未归因）：与 `metrics` 并列下发，界面照它渲染，不自己算 */
  attribution: { accepted: number; asIs: number; light: number; heavy: number; unknown: number; asIsShare: number; lightShare: number; heavyShare: number };
  machine: { stale: boolean; count: number; elements: Array<{ code: string; origin: string }> };
  /** 形式类规则清单：只列启用中的（界面展示与扫描同口径） */
  formRules: Array<{ id: string; title: string; severity: string }>;
  /**
   * 知识资产包（部署参数：不进文档、不进签名、不改任何病历）。
   * 两个指纹分开：内容指纹 = "载的是哪一版"，生效指纹 = "实际在跑什么"。
   */
  knowledgePacks: {
    packs: Array<{
      packId: string;
      kind: string;
      name: string;
      version: string;
      engineApi: string;
      itemCount: number;
      enabledItemCount: number;
      items: Array<{ itemId: string; enabled: boolean }>;
    }>;
    /**
     * 规则条目目录（含停用项）。
     *
     * `predicate / params / detail / suggestion` 四个字段是**编辑抽屉的回显来源**：
     * 编辑是"读回 → 改 → 写回"的回路，读不全就等于写不全 ——
     * 少回显一个字段，那一次保存就会把它静默清掉，而且没有任何地方会报错。
     */
    rules: Array<{
      packId: string;
      itemId: string;
      title: string;
      severity: string;
      enabled: boolean;
      predicate: string | null;
      params: Record<string, unknown>;
      detail: string | null;
      suggestion: string | null;
      /**
       * 判定依据的人话回读（自定义条件专用）：由**服务端**把条件树（含具名条件的引用）解开算好 ——
       * 界面不另编一句：两处各编一句，迟早出现"表里说的"与"提示里说的"不一样。
       */
      conditionSummary?: string | null;
    }>;
    contentFingerprint: string;
    effectiveFingerprint: string;
    /** 落库现状：载进来的是哪几个包、以及库是不是空的（空库会让质控 0 命中） */
    store: {
      tables: string[];
      source: 'empty' | 'database' | null;
      packs: Array<{ packId: string; kind: string; itemCount: number; enabledItemCount: number; fingerprint: string }>;
      error: string | null;
    };
  };
  /**
   * 可编辑的判定方式与它们的参数规格（下发给界面生成"判定方式"下拉与参数表单）。
   * 界面**不自己抄一份谓词清单**：参数名与取值域只在上游写一处，
   * 两边各写一份的后果是"界面能选、引擎不认"，而它只会等有人真的点了它才暴露。
   */
  qcPredicates: Array<{
    kind: string;
    label: string;
    doc: string;
    params: Array<{ name: string; kind: string; label: string; doc: string; required?: boolean; options?: string[] }>;
  }>;
  /**
   * 条件库目录（具名条件）。
   *
   * `when` 与 `summary` 是**编辑抽屉的回显来源**：条件本身要能原样读回（少带一格，
   * 保存一次就把它静默清掉），而那句人话用于表里那一列。`usedBy` 是同一个函数算出来的
   * 引用面 —— 界面在保存前显示它，删除保护也读它（两处各算一遍会得到"界面说没人用、删除却被拒"）。
   */
  /** 判定方式：**库级资产**（全院一份、不属于任何包，所以这里没有 `packId`） */
  qcConditions: Array<{
    itemId: string;
    name: string;
    description: string | null;
    /** 参数规格（T1）：空数组 = 不带参数。界面照它渲染"规则填实参"的那几格 */
    params: Array<{ name: string; kind: string; label: string; required?: boolean; options?: string[]; unit?: string; doc: string }>;
    summary: string | null;
    when: unknown;
    /** 谁在用它：引用方在哪个包（判定方式是库级的，引用方可能分布在多个包里） */
    usedBy: Array<{ packId: string; itemId: string; title: string; enabled: boolean }>;
  }>;
  /** 判定方式库那一侧的状态（库里有没有、最近谁改的） */
  qcConditionLibrary: { source: string; count: number; updatedAt: string | null; updatedBy: string | null };
  /**
   * **算子插件**（T3）的装载结果。
   *
   * 它必须下发：插件带来的是**算子**，而"这台机器上为什么没有那个算子"这个问题的答案
   * 不能只躺在启动日志里（那是没人会去看的地方），装载失败更不能沉默 ——
   * 它会表现成"规则没命中"，而界面上一切正常。
   */
  qcPlugins: {
    root: string;
    loaded: Array<{ pluginId: string; name: string; version: string; dir: string; keyId: string; operators: string[] }>;
    failures: Array<{ dir: string; code: string; reason: string }>;
    dirPresent: boolean;
  };
  /**
   * 自定义条件（条件树）的构造器规格：可用的字段、算子与取值形态。
   *
   * 与 `qcPredicates` 同一条纪律 —— **前端不手抄一份字段表或算子表**。
   * 缺了它，规则编辑里那一块构造器就是个空壳：能选，但没有可选项。
   */
  qcCondition: {
    fields: Array<{
      name: string;
      label: string;
      kind: string;
      scope: string;
      options?: Array<{ value: string; label: string }>;
      doc: string;
    }>;
    operators: Array<{
      name: string;
      label: string;
      fields: string[];
      value: { kind: string; unit?: string; options?: Array<{ value: string; label: string }>; doc: string } | null;
      doc: string;
    }>;
    logic: Array<{ name: string; label: string; doc: string }>;
    limits: { maxDepth: number; maxChildren: number; maxWordLength: number };
  };
  /**
   * 旁挂数据落盘状态。`conflict` 为真时界面必须给出出路（「重新载入旁挂数据」），
   * 所以它不是"内部细节"，而是界面契约的一部分。
   */
  sidecar: { conflict: boolean; persisted: boolean };
  /**
   * 工作数据落在哪个库、里面有多少条，"数据在哪"要能一句话答出来，
   * 而不是靠人去翻源码找路径（B41 用它证明写入真的进了库）。
   */
  database: {
    file: string;
    schemaVersion: number;
    appliedMigrations: string[];
    patients: number;
    documents: number;
    revisions: number;
    sidecars: number;
    kv: number;
  };
  /** 旁挂质控提示（不是文档内容：不改 rev、不进文档留痕），界面「质控提示」面板就是它 */
  annotations: Array<{
    id: string;
    nodeId: string;
    kind: string;
    severity: string;
    title: string;
    detail: string | null;
    suggestion: string | null;
    status: string;
    anchorState: string;
    /** system 来源必带：无依据的提示无法复核（内核要求） */
    ruleId: string | null;
    createdAt: string;
  }>;
  /**
   * 最近一次质控扫描里适用但判不了的条目（缺入院时间、导入件…）。
   *
   * 它与命中数同屏出现：只说"共 N 条提示"，会让"有一批根本没判"被读成"都查过了"。
   */
  qcUnevaluated: Array<{ ruleId: string; title: string; nodeId: string; reason: string }>;
  /**
   * 内涵类质控的现状（`null` = 还没跑过）。没接上必须看得见：
   * `configured=false` 时界面要说明原因，不能让它与"跑了 0 命中"长得一样
   * （这两件事在界面上同形，是内涵类质控最容易撒的谎）。
   */
  qcContent: {
    configured: boolean;
    reason: string | null;
    rules: number;
    judged: string[];
    findings: number;
    created: number;
    unevaluated: Array<{ ruleId: string; reason: string }>;
    silentRules: string[];
    rejected: Array<{ index: number; code: string; message: string }>;
  } | null;
  /**
   * 最近一次就诊时间轴的读数（`null` = 还没读过）。
   *
   * 它随 state 下发，而不是"每次重渲染现算"：算的输入是全就诊的文书正文，
   * 而界面上任何一个无关动作都会触发重渲染 —— 那时若重算一次并重新取 `now`，
   * 同一屏上的时间就会前后不一致。
   */
  visitTimeline: {
    docs: Array<{ docId: string; createdAt: string; isCurrent: boolean }>;
    dischargedAt: string | null;
    endAt: string;
    segments: Array<{ docTypeCode: string; fromDocId: string; toDocId: string | null; hours: number; limitHours: number; exceeds: boolean }>;
    gaps: Array<{ ruleId: string; detail: string; segment: { fromDocId: string } | null }>;
    trend: { changes: Array<{ detail: string }>; skipped: Array<{ reason: string }> };
  } | null;
  /**
   * 最近一次 AI 调用"看了但没写"的清单（`null` = 还没调过）。
   *
   * 与上面两个并列：它们是同一条纪律（"没判"不能被读成"没问题"）在形式类质控、
   * 内涵类质控、AI 上的三次落地。`null` 与"调过、无跳过"必须能区分 ——
   * 否则"没显示"又会同时意味着"没问题"与"没跑过"。
   */
  aiSilence: {
    targets: number;
    produced: number;
    skipped: Array<{ nodeId: string; code: string; source: string; reason: string; label: string }>;
    rejected: Array<{ index: number; code: string; message: string }>;
  } | null;
  /** 模板体系（K4）：能开哪几种文书 */
  templates: Array<{
    packId: string;
    templateId: string;
    name: string;
    docType: { system: string; code: string; display: string };
    sectionCount: number;
    slotCount: number;
    expressionCount: number;
  }>;
  /** 医学表达式控件库（K4 验收口径：≥5 个） */
  expressionControls: Array<{ packId: string; controlId: string; name: string; unit: string; formula: string }>;
  /**
   * 模板条目目录（含草稿与停用的）：管理后台「模板库」据此管控。
   * `departments` 是**编码**（判定用），`departmentNames` 是给人看的名称。
   */
  templateCatalog: Array<{
    packId: string;
    itemId: string;
    itemType: 'template' | 'expression';
    name: string;
    enabled: boolean;
    status: 'draft' | 'active';
    detail: string;
    departments: string[];
    departmentNames: string[];
    openable: boolean;
    sections?: Array<{ sectionCode: string; title: string; slots: Array<Record<string, unknown>> }>;
    /** 这份文书引用了哪些表达式控件（目录要带出来，否则这一行只剩一个名字） */
    controls?: Array<{ controlId: string; name: string; formula: string; unit?: string; enabled: boolean }>;
    /** 控件条目的公式（AST）与说明：编辑控件时构造器要回显它们 */
    expression?: unknown;
    unit?: string;
    description?: string;
  }>;
  /** 科室字典：整个部署共用的主数据（模板的"适用科室"与就诊科室名都读它） */
  departments: {
    items: Array<{ code: string; name: string; enabled: boolean }>;
    source: 'store' | 'empty';
    enabledCount: number;
    updatedAt: string | null;
    updatedBy: string | null;
    error: string | null;
  };
  /**
   * 文书类型（B52b）：整个部署共用的主数据 ——
   * 「新建文书」的类型选项与质控规则定位文书的依据都读它。
   */
  docTypes: {
    items: Array<{ system: string; code: string; display: string; enabled: boolean }>;
    source: 'store' | 'empty';
    enabledCount: number;
    systems: string[];
    updatedAt: string | null;
    updatedBy: string | null;
    error: string | null;
  };
  /** 模板能"从系统带入"哪些字段（填写项取值路径 + 表达式构造器的系统字段） */
  contextFields: Array<{ path: string; label: string; group: string }>;
  /** 表达式构造器的函数表（参数个数 + 人话说明）：前端不手抄一份 */
  expressionFunctions: Array<{ name: string; minArgs: number; maxArgs: number | null; doc: string }>;
  /** 本文书里"由公式算出来"的字段数：界面据此决定「重算派生值」按钮出不出现 */
  derivedCount: number;
  /** 当前病历若为导入件，则带来源与核对提示 */
  importSource: Record<string, unknown> | null;
  /** T27：共享文档（WS/T 500）导出记录（与 OFD 归档导出分开） */
  lastWst500: { file: string; bytes: number; sections: number; fields: number; paragraphs: number; exportedAt: string } | null;
  /** 最近一次导出的文档 JSON（独立探针 S2/S3/S5 的输入） */
  lastJson: { file: string; bytes: number; nodes: number; exportedAt: string } | null;
  /** 最近一次审计报告摘要 */
  lastAudit: {
    jsonPath: string;
    mdPath: string;
    generatedAt: string;
    passed: number;
    total: number;
    reportDigest: string;
    failed: Array<{ id: string; description: string; detail: string }>;
  } | null;
  /** 语音落位（V1）：配置视图 + 候选节点，界面据此为每段指定落点 */
  placement: Record<string, unknown> | null;
  /**
   * 语音采集（C2）：ASR 地址 / 超时预算 / 分片参数 / 留存开关。
   * `configured` 是界面契约的一部分：未配置时采集入口必须置灰并说明原因，
   * 而"未配置"与"配了但不通"在只看字段值时会显得一样。
   */
  capture: {
    endpoint: string;
    modelId: string;
    submitTimeoutMs: number;
    pollIntervalMs: number;
    pollTimeoutMs: number;
    segment: { silenceMs: number; maxSeconds: number; minSeconds: number };
    retainAudio: boolean;
    confidenceCeiling: number;
    apiKeyPresent: boolean;
    configured: boolean;
    missing: string[];
    source: string;
  } | null;
  placementCandidates: Array<{ nodeId: string; label: string }>;
  /** 受控阅读的授权平台：本系统信任哪个平台签发的阅读授权 */
  readingAuthority: {
    endpoint: string | null;
    trustedIssuerFingerprint: string | null;
    trustedIssuerPublicKeyPresent: boolean;
    trustedFingerprints: string[];
    /** 是否已配置信任根，未配置时任何凭据都会被拒（fail-closed） */
    configured: boolean;
    source: string;
  } | null;
  /** T18：受控阅读（授权清单 / 最近受控视图 / 阅读流水 / 文档指纹） */
  reading: {
    /** 授权登记的落盘现状（落在哪张表、读错误、全局条数与已撤销数），"重启后授权还在不在"要能被验证 */
    persistence: { table: string; error: string | null; total: number; revoked: number };
    /** 文档内容指纹：授权平台签发授权时要绑定的就是它（本系统把它交给平台） */
    documentFingerprint: string;
    grants: Array<{
      grantId: string;
      purpose: string;
      notAfter: string;
      maxReads: number | null;
      readCount: number;
      revoked: boolean;
      environments: string[];
      concealPatientIdentity: boolean;
      publicKeyFingerprint: string;
      /** 是否为加密交付（授权书里带密钥交付片段） */
      encryptedDelivery: boolean;
      /** 接收方种子（仅演示：生产由密码设备保管私钥，服务端不应持有） */
      recipientSeed?: string;
      /** 接收方标签（来自公钥目录；用于界面显示"给了谁"） */
      recipientLabel?: string;
    }>;
    /** 最近一次阅读视图的来源：明文 还是 解封后的加密阅读 */
    lastViewSource: 'plaintext' | 'unsealed' | null;
    lastView: {
      patientLabel: string;
      remainingReads: number | null;
      concealedSectionCount: number;
      notices: string[];
      sections: Array<{ title: string; paragraphs: string[]; fields: Array<{ code: string; value: string }> }>;
    } | null;
    reads: Array<{ at: string; environmentId: string; allowed: boolean; code?: string; reason?: string }>;
  };
  /** 电子签名后端（"用谁来签"）：产品侧唯一的后端是医院签名服务；未配置即不可签章 */
  signBackend: {
    configured: boolean;
    missing: string[];
    source: string;
  } | null;
  /** T18：签名元信息（算法/后端/指纹/覆盖范围）与独立验签结论 */
  sign: { algorithm: string; provider: string; publicKeyFingerprint: string; signedAt: string; covers: string[] } | null;
  /**
   * 签章状态（内核判定）：`valid` 当前有效 / `voided` 已被解锁作废 / `none` 无签章。
   * 它单独存在，是因为"已被有理由的解锁作废"与"内容被篡改"在 `signatureVerified` 上完全同形。
   */
  signatureState: {
    kind: 'none' | 'valid' | 'voided';
    voidedBy: { reason: string; at: string; invalidated: Array<{ publicKeyFingerprint: string; signedAt: string }> } | null;
  } | null;
  signatureVerified: { ok: boolean; reasons: string[]; details: { algorithm: string; provider: string; publicKeyFingerprint: string; referenceCount: number } } | null;
  log: Array<{ ok: boolean; code?: string; action?: string }>;
  /**
   * 鉴权现状：模式、口令来源、以及哪些破坏性动作两种模式都收口。
   * 界面据此把「重置」置灰并说明理由（"能不能做"由 `/api/session.actions` 给）。
   */
  auth: {
    mode: 'open' | 'strict';
    ttlMinutes: number;
    /** 账号来源（取代原先的 `tokens`）：口令的权威只有数据库一处 */
    accounts: { initialized: boolean; total: number; admins: number; source: string };
    note: string;
    destructiveGuarded: string[];
    loginEndpoint: string;
  };
  /** 可撤销的最近一次写入（没有则为 null）：界面据此显隐/禁用手柄并把目标写进 title */
  undo: { rev: number; op: string } | null;
  lastExport: null | {
    file: string;
    pages: number;
    probeExit: number;
    probe: { verdict: string; roundTrip: { total: number; found: number; completeness: number } | null; checks: Array<{ id: string; pass: boolean; critical: boolean }> };
  };
}

let child: { kill(signal?: string): boolean } | null = null;
let signService: Server | null = null;
let asrService: Server | null = null;
/** 本地采集客户端（C3b③ 的靶子进程：桥那一侧） */
let captureClient: { kill(signal?: string): boolean } | null = null;

/**
 * 管理后台会话 cookie（登录后由服务端 Set-Cookie 下发）。
 *
 * 为什么由 `post()` 自动带上：配置写入一律要求会话（服务端 `requireAdminSession`），
 * 而用例关心的是"配置写对了没有"，不该每条断言都手写一次登录。
 * 反过来，要断言"未登录不能写"就必须显式不带它，见 `postNoAuth`。
 */
let adminCookie = '';

/** 在指定实例上登录，返回会话 cookie（`name=value` 一段；其余属性由浏览器负责） */
async function loginAt(base: string, username: string, password: string): Promise<string> {
  const res = await fetch(`${base}/api/admin/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const payload = (await res.json()) as ApiResponse;
  if (payload.ok !== true) throw new Error(`登录失败（${username}）：${payload.code ?? ''} ${payload.message ?? ''}`);
  const cookie = String(res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  if (cookie === '') throw new Error('登录响应没有下发会话 cookie');
  return cookie;
}

async function adminLogin(username = ADMIN_USER, password = ADMIN_PASSWORD): Promise<void> {
  try {
    adminCookie = await loginAt(BASE, username, password);
  } catch (err) {
    /* 登录限流（同一来源 300 秒内最多 20 次）在这么长的套件里会被撞到：这时**沿用手里这个会话**，
       而不是让一条与本用例无关的限流把用例判成失败（实测就是这么撞上的）。
       只在"已经握着一个会话"且**确实是限流**时才放过：没有会话时的失败是真失败，必须抛出去。 */
    if (adminCookie !== '' && String((err as Error).message).includes('E_RATE_LIMITED')) return;
    throw err;
  }
}

/**
 * 让一个实例进入"可用"状态：初始化第一个管理员，再用它建出质控员与医生两个账号。
 *
 * 为什么测试要走这一条路而不是"预先塞一个账号进库"：
 * 初始化与建账号本身就是这一轮要交付的东西，走接口把它们一起验了，
 * 比另写一段直接写库的夹具更接近现场（现场正是这么做的）。
 *
 * `E_ALREADY_INITIALIZED` / `E_USER_EXISTS` 视为成功：这条辅助函数是幂等的，
 * 于是"服务重启后再调用一次"（B41 会重启）不需要另写一套分支。
 */
async function provisionAccounts(base: string, deployToken?: string): Promise<string> {
  const boot = await callWith(
    '/api/admin/bootstrap',
    '',
    { username: ADMIN_USER, password: ADMIN_PASSWORD, ...(deployToken ? { deployToken } : {}) },
    base,
  );
  if (!boot.ok && boot.code !== 'E_ALREADY_INITIALIZED') {
    throw new Error(`初始化第一个管理员失败：${boot.code ?? ''} ${boot.message ?? ''}`);
  }
  const cookie = await loginAt(base, ADMIN_USER, ADMIN_PASSWORD);
  for (const [username, role] of [[QC_USER, 'qc'], [CLINICIAN_USER, 'clinician']] as Array<[string, string]>) {
    const created = await callWith('/api/admin/users', cookie, { username, password: SELFTEST_ROLE_PASSWORD, role }, base);
    if (!created.ok && created.code !== 'E_USER_EXISTS') {
      throw new Error(`创建 ${role} 账号失败：${created.code ?? ''} ${created.message ?? ''}`);
    }
  }
  return cookie;
}

async function post(path: string, body: Record<string, unknown> = {}): Promise<ApiResponse> {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(adminCookie ? { Cookie: adminCookie } : {}) },
    body: JSON.stringify(body),
  });
  return (await res.json()) as ApiResponse;
}

/**
 * 重置工作区：必须带管理员会话（`workspace.reset` 只给管理员，两种模式一致）。
 *
 * 单独一个辅助而不是到处写 `post('/api/reset')`：后者依赖"之前刚好有人登录过"这种
 * 顺序巧合，用例的通过与否不该取决于别的用例跑在前面。没会话就现登录一个。
 */
async function resetWorkspace(): Promise<ApiResponse> {
  if (!adminCookie) await adminLogin();
  return post('/api/reset', {});
}

/**
 * 把仓库里的样例包（`samples/packs/*.json`）载进库。
 *
 * 为什么测试必须显式做这一步：包不再自动播种，新库就是空的，没有模板、没有质控规则。
 * 而这套用例（模板创建、质控提示、包开关）都建立在"这台机器装了那几份包"之上。
 * 这句调用就是测试在声明这个前提，与生产里的差异只有"谁去点那个按钮"。
 */
async function loadSamplePacks(): Promise<ApiResponse> {
  if (!adminCookie) await adminLogin();
  return post('/api/knowledge-pack-load', { sample: true });
}

/** 带指定 cookie 的请求：用于"以医生/质控员身份打一次"这类断言 */
async function callWith(
  path: string,
  cookie: string,
  body?: Record<string, unknown>,
  base = `http://127.0.0.1:${PORT}`,
): Promise<ApiResponse> {
  const res = await fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return (await res.json()) as ApiResponse;
}

/** 不带会话的 POST：用来断言"未登录就改不了配置" */
async function postNoAuth(path: string, body: Record<string, unknown> = {}): Promise<ApiResponse> {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (await res.json()) as ApiResponse;
}

async function get(path: string): Promise<ApiResponse> {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`);
  return (await res.json()) as ApiResponse;
}

/**
 * 带会话的 GET：管理后台的只读视图（审计 / 运行状态 / 系统信息）要求登录。
 * 与 `get()` 分开而不是给它加个开关：不加会话与加了会话是两种语义，
 * "这次到底带没带身份"必须在调用处一眼看得出来。
 */
async function getAuth(path: string): Promise<Record<string, unknown>> {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    headers: adminCookie ? { Cookie: adminCookie } : {},
  });
  return (await res.json()) as Record<string, unknown>;
}

/**
 * 模型配置的完整基线：这几格每次都一起传。
 *
 * 踩过的坑：只传 `format/model/apiKey` 时，没传的那几格会被判为非法值，整条保存被拒，
 * 而被拒与保存成功在断言里的差别是致命的：`await post(...)` 然后只看"指纹变没变"，
 * 会在"请求根本没生效"时给出假绿（B31 初版就是这么写出来的，实测抓到）。
 * 所以下面每次保存都显式断言 `ok`，把"没生效"变成一条失败而不是一条沉默。
 */
const MODEL_BASE = {
  format: 'offline',
  model: 'qwen-audit-probe',
  endpoint: 'http://127.0.0.1:11434/v1',
  timeoutMs: 20000,
  maxItems: 20,
};

interface AdminAuditView {
  ok?: boolean;
  entries?: Array<{
    at: string;
    actor: string;
    subject: string;
    kind: string;
    changes: Array<{ field: string; before: string; after: string }>;
    note?: string;
  }>;
  counts?: { total: number; dropped: number; limit: number };
  boundary?: string[];
}

interface AdminSystemView {
  ok?: boolean;
  version?: string;
  node?: string;
  env?: string | null;
  configFingerprints?: Record<string, string>;
}

/**
 * 取工作区状态。
 *
 * **带管理员会话取**：服务端的状态是**按身份投影**的（见 demo-server 的 `stateFor`），
 * 无会话只会拿到医生端投影（不含模板目录 / 科室字典 / 诊断字段）。而本套用例是"以管理
 * 身份检查这台机器"的——它要读的包括模板目录与诊断字段，所以默认走管理端投影。
 * 医生端那一份由 B1b 用**无会话**的裸请求专门验。
 */
async function state(): Promise<DemoState> {
  const res = await fetch(`${BASE}/api/state`, adminCookie === '' ? undefined : { headers: { Cookie: adminCookie } });
  return ((await res.json()) as { state: DemoState }).state;
}

/**
 * 写出服务端配置文件（`<运行目录>/server-config.json`）。
 *
 * 为什么测试要自己写它：密封口令 / 盐 / 装机凭据是"打开数据库之前就要知道的东西"，
 * 现在只从这份文件读（见 `core/server-config.ts`），不再是环境变量。
 * 不写的话 demo-server 会生成模板、用**内置演示口令** —— 那样测试进程与服务端就不是同一把口令，
 * B36 的跨进程快照立刻解不开；而内置值正是这一轮要去掉的那类"藏在实现里的默认"。
 */
function writeServerConfig(options: { bootstrapToken?: string; bootstrapUser?: string; targetRuntimeDir?: string } = {}): void {
  const target = options.targetRuntimeDir ?? runtimeDir;
  const file = target === runtimeDir ? SERVER_CONFIG_FILE : join(target, 'server-config.json');
  mkdirSync(dirname(file), { recursive: true });
  const config = {
    stateKey: STATE_KEY,
    stateSalt: null,
    envName: 'selftest',
    /* 成对给出才播种第一个管理员；只给 token（不给 user）表示"初始化必须提供它"，但**不预播种** */
    bootstrap: { token: options.bootstrapToken ?? null, user: options.bootstrapUser ?? null },
    imports: { qcRulesFile: null },
  };
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

/**
 * 预置库里的**系统策略**（`config.system` 一行）。
 *
 * 鉴权模式 / 会话寿命 / 限流阈值都是**启动期读取**的（见 `storage/system-config.ts`），
 * 所以必须在起服务之前把库准备好 —— 写在这个独立的临时库里，不与主实例混。
 */
function seedSystemConfig(targetStateDir: string, input: Parameters<typeof saveSystemConfig>[1]): void {
  const opened = openDatabase(join(targetStateDir, 'l0.db'), { schemaVersion: STORAGE_SCHEMA_VERSION, migrations: MIGRATIONS });
  try {
    saveSystemConfig(createConfigKv(new WorkStore(opened.db, STATE_KEY)), input, 'uitest-setup');
  } finally {
    opened.db.close();
  }
}

/**
 * 起一个服务进程并等它就绪。
 *
 * 超时给到 30 秒（而不是 15）：首次启动要播种到数据库，那一趟要付一次口令派生
 * （默认 200_000 次，实测约 7.6 秒），本机够用，慢一点的机器上 15 秒会误判成"启动失败"。
 *
 * 起进程之前先写服务端配置文件：那是"打开库之前就要知道"的口令与装机凭据。
 */
async function spawnServer(): Promise<void> {
  writeServerConfig();
  const spawned = spawn(process.execPath, ['src/demo/demo-server.ts', '--port', String(PORT)], {
    cwd: ROOT,
    stdio: 'pipe',
    /* 只保留**路径类**变量（运行时根目录 + 状态目录）：它们决定"东西落在哪儿"。
       账号 / 口令 / 鉴权模式 / 采集配置都已经不在环境变量里（前者在配置文件，后者在库里），
       所以这里不再有那些"显式清空"的行 —— 它们对 demo-server 已经没有任何作用。 */
    env: {
      ...process.env,
      L0_RUNTIME_DIR: runtimeDir,
      L0_STATE_DIR: stateDir,
      L0_ADMIN_AUDIT_FILE: join(stateDir, 'admin-audit.log'),
      L0_READING_GRANTS_FILE: join(stateDir, 'reading-grants.json'),
      L0_PACK_DIR: join(stateDir, 'knowledge'),
    },
  });
  child = spawned;
  spawned.stdout?.on('data', () => {});
  spawned.stderr?.on('data', () => {});
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/state`);
      if (res.ok) return;
    } catch {
      /* 尚未就绪 */
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  spawned.kill();
  throw new Error('Demo 服务启动超时（30s）');
}

async function startServer(): Promise<void> {
  /* 工作数据（文书 + 旁挂）落在数据库里，必须用独立目录；
     清掉它等于"从空库开始"，于是每轮测试都从播种态出发（用例之间互不污染）。
     这不只是测试问题，它同时说明重置必须真的清库（见 demo-server 的 `resetWorkspace`）。
     运行时目录（服务端配置文件所在处）一并清掉：那里有密封口令与装机凭据，
     每轮都从"新目录 + 新配置文件"出发，才不受上一轮残留影响。 */
  const rmRecursive = rmSync as unknown as (path: string, options: { recursive: boolean; force: boolean }) => void;
  for (const dir of [stateDir, runtimeDir]) {
    if (existsSync(dir)) rmRecursive(dir, { recursive: true, force: true });
  }
  await spawnServer();
}

/**
 * 重启服务（不擦库）：杀掉进程，用同一个状态目录再起一个。
 *
 * B41 用它证明"数据真的在库里"，擦掉库再起，证不出任何东西（那等于从播种态开始）。
 */
async function restartServer(): Promise<void> {
  await stopServer();
  await spawnServer();
}

/**
 * 杀掉一个服务进程，并等它**真的退出**、把端口与文件句柄放掉。
 *
 * `kill()` 在 Windows 上只是投递终止请求，进程退出、`l0.db` 的句柄被释放是之后的事：
 *   - 删状态目录紧跟在 `kill()` 后面会撞 `EPERM`（目录还被占着）；
 *   - 复用同一端口再来一次会撞 `EADDRINUSE`（`restartServer` 原来靠"睡 600ms"绕开的就是它）。
 * 两处表现不同，原因却是同一个，所以收敛成一个"等退出"的动作，而不是各自睡各自的。
 * 主实例与 B37 那个 strict 实例都从这一处走（它们原本各自写了一遍同样的时序假设）。
 */
async function killAndWait(target: { kill(signal?: string): boolean } | null): Promise<void> {
  if (!target) return;
  /* 类型是本仓库精简版声明里没有的（同 `rmSync` / `spawnSync` 的处置）：
     按真实运行时的形状局部断言，而不是为了过检查把要用的东西去掉。 */
  const handle = target as unknown as { exitCode: number | null; once: (event: 'exit', listener: () => void) => void };
  const exited =
    handle.exitCode === null
      ? new Promise<void>((resolve) => handle.once('exit', () => resolve()))
      : Promise.resolve();
  target.kill();
  /* 兜底超时：进程万一不退出，也不能把整轮卡死在这里 */
  await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 3000))]);
  /* "进程退出"与"系统真的把句柄/端口还回来"之间还有一小段窗口 */
  await new Promise((resolve) => setTimeout(resolve, 500));
}

/**
 * 停掉主实例（`child` 同时置空，后面的 `spawnServer` 才不会把已死的句柄当成活的）。
 *
 * 它同时是**报告能不能打出来**的前提：收尾删目录一旦抛错，`process.exit(suite.report())`
 * 就执行不到，于是断言明明都跑完了，屏幕上却什么都没有。
 */
async function stopServer(): Promise<void> {
  const dying = child;
  child = null;
  await killAndWait(dying);
}

function allDocs(target: DemoState): TreeDoc[] {
  return target.tree.flatMap((patient) => patient.visits.flatMap((visit) => visit.docs));
}

/* ------------------------------ 靶子签名服务 ------------------------------
   产品侧已经没有内置软件签名：未配置医院签名服务时，签章会被明确拒绝
   （`E_SIGN_NOT_CONFIGURED`）。而 UI 契约里有一批用例要"签章成功才能往下走"
   （导出、受控阅读、审计报告都建立在"已签章"之上），所以测试必须真的接上一台签名服务。

   它是测试的靶子，不是产品里的一条捷径：请求/响应走的是与真实服务同一套声明式映射
   （`data.content` / `data.signature` 点路径），服务端只是用自研 SM2 把收到的数据签一次，
   于是"映射 → 请求构造 → 服务签 → 取签名值 → 内核签章 → 独立验签"整条链路都被真实覆盖。
------------------------------------------------------------------------- */

const SIGN_SERVICE_KEY = softwareSigner(demoKeyPair('l0-ui-sign-service').privateKey);

function startFakeSignService(): Server {
  const server = createServer((req, res) => {
    /* 本仓库的 node:http 类型声明是精简版（同 node:fs，见各套件里 rmSync 的处置）：
       这里按实际用到的形状局部断言，而不是把类型声明补全（那会变成"为了测试改产品依赖"）。 */
    const request = req as unknown as { on: (event: string, listener: (chunk: unknown) => void) => void };
    const response = res as unknown as {
      writeHead: (status: number, headers: Record<string, string>) => void;
      end: (body: string) => void;
    };
    let raw = '';
    request.on('data', (chunk) => {
      raw += String(chunk);
    });
    request.on('end', () => {
      try {
        const body = JSON.parse(raw) as { data?: { content?: string } };
        const toSign = fromBase64(String(body.data?.content ?? ''));
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(
          JSON.stringify({
            data: { signature: toBase64(SIGN_SERVICE_KEY.sign(toSign)), publicKey: toBase64(SIGN_SERVICE_KEY.publicKeyDer) },
          }),
        );
      } catch (err) {
        response.writeHead(400, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: (err as Error).message }));
      }
    });
  });
  server.listen(SIGN_PORT, '127.0.0.1');
  return server;
}

/**
 * 把靶子签名服务配进 demo，走的是界面上同一个接口（`/api/sign-backend-config`），
 * 而不是偷偷塞一个软件签名器进进程。这样"配置 → 可签章"这条判定也被真实覆盖：
 * 若哪天有人把配置链路改坏了，这里会立刻红。
 */
async function configureSignService(): Promise<void> {
  const r = await post('/api/sign-backend-config', {
    adminId: 'ADMIN',
    http: {
      endpoint: `http://127.0.0.1:${SIGN_PORT}/sign`,
      request: { toSignField: 'data.content', toSignEncoding: 'base64' },
      response: { signaturePath: 'data.signature', signatureEncoding: 'base64', publicKeyPath: 'data.publicKey' },
    },
    publicKeyBase64: toBase64(SIGN_SERVICE_KEY.publicKeyDer),
    expectedFingerprint: publicKeyFingerprint(SIGN_SERVICE_KEY.publicKey),
  });
  if (!r.ok) throw new Error(`配置靶子签名服务失败：${r.code ?? ''} ${r.message ?? ''}`);
  const configured = (r.data as { configured?: boolean } | undefined)?.configured;
  if (configured !== true) throw new Error('靶子签名服务配置后应处于"可签章"状态（configured=true）');
}

/* ------------------------------ 靶子 ASR 服务 ------------------------------
   与靶子签名服务同一个理由：采集转发这条链路的"上传 → 轮询 → 取 result"三段
   只有真的连一台服务才谈得上走通。它只实现 ASR 文档写的那两个接口，
   并且**记下收到的原始请求体** —— 于是"转发用的是不是 ASR 要的字段名"可以被断言，
   而不是靠读代码相信。
------------------------------------------------------------------------- */

interface FakeAsrState {
  submits: number;
  polls: number;
  /** 最后一次提交的原始请求体（断言字段名与格式用；音频是二进制，只用于 includes 检查） */
  lastBody: string;
}

const fakeAsrState: FakeAsrState = { submits: 0, polls: 0, lastBody: '' };

function startFakeAsrService(): Server {
  const server = createServer((req, res) => {
    /* 本仓库的 node:http 类型声明是精简版：按实际用到的形状局部断言（同靶子签名服务） */
    const request = req as unknown as {
      method?: string;
      url?: string;
      on: (event: string, listener: (chunk: unknown) => void) => void;
    };
    const response = res as unknown as {
      writeHead: (status: number, headers: Record<string, string>) => void;
      end: (body: string) => void;
    };
    let raw = '';
    request.on('data', (chunk) => {
      raw += String(chunk);
    });
    request.on('end', () => {
      if ((request.method ?? 'GET') === 'POST') {
        fakeAsrState.submits += 1;
        fakeAsrState.lastBody = raw;
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ code: 200, task_id: 'task-fake-1' }));
        return;
      }
      fakeAsrState.polls += 1;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ status: 'done', result: CAPTURE_TEXT }));
    });
  });
  server.listen(CAPTURE_PORT, '127.0.0.1');
  return server;
}

/**
 * 提交一段音频（走同源采集路由，multipart 形状与真实前端一致）。
 *
 * 刻意与 `post()` 分开而不是给它加个开关：这两条请求的**体格式不同**（一个是 JSON、
 * 一个是二进制分段），混成一个函数会让"这次到底发了什么"在读用例时看不出来。
 */
async function postAudio(path: string, filename: string, bytes: Uint8Array, cookie = adminCookie): Promise<ApiResponse> {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const form = new FormData();
  form.append('audio', new Blob([buffer], { type: 'audio/wav' }), filename);
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method: 'POST',
    headers: cookie ? { Cookie: cookie } : {},
    body: form,
  });
  return (await res.json()) as ApiResponse;
}

/* ------------------------------ 本地客户端桥（B49 用） ------------------------------
   桥在**另一个进程**里（`local-capture-client.ts`），所以这里只能按 HTTP 打它 ——
   而这正是页面要走的同一条路：取段、取音频、ack。
------------------------------------------------------------------------------------ */

async function bridgeCall(
  path: string,
  options: { method?: 'GET' | 'POST'; body?: unknown; token?: string } = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const token = options.token ?? CAPTURE_CLIENT_TOKEN;
  const res = await fetch(`http://127.0.0.1:${CAPTURE_CLIENT_PORT}${path}${token === '' ? '' : `?token=${encodeURIComponent(token)}`}`, {
    method: options.method ?? 'GET',
    ...(options.body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(options.body) }),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function bridgeAudio(index: number): Promise<{ status: number; bytes: Uint8Array }> {
  const res = await fetch(`http://127.0.0.1:${CAPTURE_CLIENT_PORT}/dictation-capture/audio/${index}?token=${encodeURIComponent(CAPTURE_CLIENT_TOKEN)}`);
  if (res.status !== 200) return { status: res.status, bytes: new Uint8Array(0) };
  return { status: res.status, bytes: new Uint8Array(await res.arrayBuffer()) };
}

/**
 * 剥掉 JS 里的注释，再看"代码里到底写了什么"。
 *
 * 为什么需要：注释里出现 `127.0.0.1:8901` 只是在举例（`A14` / `A25` 的纪律也只在可见文本上），
 * 不剥注释的静态检查会把注释里的例子当成"写死了地址"—— 那种误报会训练人忽略检查结果。
 */
function stripJsComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/* --------------------------------- 用例 --------------------------------- */

async function main(): Promise<void> {
  /* ============================ A 静态检查 ============================ */

  await test('A1 脚本（ui.js）可正常解析，且页面正确引用拆分后的样式与脚本', () => {
    try {
      // eslint-disable-next-line no-new-func
      new Function(script);
    } catch (err) {
      assert(false, `ui.js 存在语法错误：${(err as Error).message}`);
    }
    assert(script.length > 2000, `脚本长度异常：${script.length}`);
    assert(css.length > 2000, `样式长度异常：${css.length}`);
    assert(/<link[^>]+href="\/ui\.css"/.test(html), 'ui.html 应引用 /ui.css');
    assert(/<script[^>]+src="\/ui\.js"/.test(html), 'ui.html 应引用 /ui.js');
    assert(/<script[^>]+src="\/doc-view\.js"/.test(html), 'ui.html 应引用 /doc-view.js（正文渲染与模板预览共用同一份）');
  });

  /* 命令面板（Ctrl+K）单独占一条：它是**独立脚本 + 独立静态路由**，
     而这两处缺任何一处，症状都一样 —— "按了没反应"，且没有任何后端行为会被别的用例撞见。
     （同样读不到 source 时也无法靠 `script` 整体兜住：它不在 ui.js 里。） */
  await test('A1b 命令面板：脚本被引用、被服务端提供、可解析、被 ui.js 真正调用', () => {
    const file = join(ROOT, 'src', 'demo', 'command-palette.js');
    assert(existsSync(file), '应有 src/demo/command-palette.js（Ctrl+K 的面板实现）');
    const source = existsSync(file) ? readFileSync(file, 'utf8') : '';
    assert(/<script[^>]+src="\/command-palette\.js"/.test(html), 'ui.html 应引用 /command-palette.js');
    assert(/path === '\/command-palette\.js'/.test(serverSource), '服务端应提供 /command-palette.js（no-store）');
    assert(/window\.L0Palette\s*=/.test(source), '面板要把自己挂到 window.L0Palette（ui.js 靠它打开）');
    assert(/L0Palette/.test(script), 'ui.js 要真的调用面板，否则引了也是死代码');
    try {
      new Function(source);
    } catch (err) {
      assert(false, `command-palette.js 存在语法错误：${(err as Error).message}`);
    }
  });

  /* 逐句审阅只有"取舍 → 组合文本 → 带 editedText 落笔"这一条链。
     三条断任何一条，界面都会变成"勾了半天、落笔的还是 AI 原文"—— 而这不会报错，
     只会让修改率偏低，看起来像模型变好了。 */
  await test('A1c 建议卡片：逐句取舍落到草稿文本，采纳时按草稿落笔', () => {
    assert(/data-sugg-pick=/.test(script), '逐句勾选框要带 data-sugg-pick（事件委托靠它找对照表）');
    assert(/function composeReview/.test(script), '要有"按勾选拼出最终文本"的实现');
    assert(/data-sugg-text/.test(script), '草稿文本仍是落笔的唯一来源（data-sugg-text）');
    assert(
      /editedText/.test(script),
      '采纳必须能把草稿文本作为 editedText 传下去，否则取舍形同虚设',
    );
    /* 手改过的文本才允许覆盖 AI 原稿：原样采纳必须保持"未修改"口径 */
    assert(/area\.value !== origin\.text/.test(script), '只有与 AI 原稿不同才算"改后采纳"');
    /* 逐句来源：只传 editedText 的话，内核只能把整段标成 AI，医生保留的原句会被算到 AI 头上 */
    assert(/function aiRangesOf/.test(script), '要有"哪几段是 AI 写的"的区间计算');
    assert(/aiRanges: aiRangesOf/.test(script), '采纳请求要把 aiRanges 传给内核（否则句级来源落不了盘）');
    assert(/reviewRowText\(row\)/.test(script), '拼文本与算区间必须共用同一个"这一行贡献什么"，各算一遍必然错位');
  });

  /* 全景时间轴：四类待办（超时/未签/缺口/未写入病程）必须各有落点。
     这几条一旦被删掉，界面会退回"只报缺口"——而"有一份没签、有一处变化没写进病程"
     恰恰是最容易漏掉的两类，它们不会让任何一次质控扫描报错。 */
  await test('A1d 时间轴：四类待办都在轴上，且带可执行入口', () => {
    assert(/signStateOf/.test(script), '要有"已签/未签/归档作废/状态未知"的四态判定');
    assert(/kind: 'timeout'/.test(script) && /kind: 'unsigned'/.test(script), '超时与未签各自成一类待办');
    assert(/kind: 'gap'/.test(script) && /kind: 'unwritten'/.test(script), '缺口与"变化未写入病程"各自成一类待办');
    assert(/todo-\$\{todo\.kind\}/.test(script), '待办条目要带分类类名（左边缘那条颜色靠它）');
    assert(/data-open-doc/.test(script), '待办要能一键切到该动手的那份文书');
    /* 未知状态绝不能算成未签：那会让清单上永远挂着一份可能已签的文书 */
    assert(/state === 'unknown'/.test(script), '"状态未知"要单列，不能并入未签');
  });

  await test('A2 脚本里 $(\'id\') 引用的元素，页面里都真实存在', () => {
    const ids = new Set<string>();
    for (const match of script.matchAll(/\$\(\s*'([^']+)'\s*\)/g)) ids.add(match[1] as string);
    for (const match of script.matchAll(/getElementById\(\s*'([^']+)'\s*\)/g)) ids.add(match[1] as string);
    assert(ids.size >= 12, `扫描到的元素 id 过少（${ids.size}），检查抽取逻辑`);
    const missing = [...ids].filter((id) => !html.includes(`id="${id}"`));
    assertEqual(missing, [], '脚本引用了页面中不存在的元素，运行时会直接抛错');
  });

  await test('A3 脚本读取的 dataset.X，都对应存在 data-x 属性（事件委托靠它定位节点）', () => {
    const names = new Set<string>();
    for (const match of script.matchAll(/dataset\.([A-Za-z]+)/g)) names.add(match[1] as string);
    assert(names.size >= 5, `扫描到的 dataset 过少（${names.size}）`);
    const missing = [...names].filter((name) => !frontend.includes(`data-${kebab(name)}`));
    assertEqual(missing, [], '存在"脚本读 dataset、模板却从不输出该 data 属性"的断裂');
  });

  await test('A4 UI 调用的每个 /api 路径，服务端都有对应路由', () => {
    const paths = new Set<string>();
    /* 路径里必须允许数字与斜杠：`/api/export-wst500` 会被 `[a-z-]` 截成 `/api/export-wst`、
       `/api/reading/grant` 会被截成 `/api/reading`，于是检查器自己制造假失败；
       更糟的是截断后若恰好命中另一个真实路径，就会漏报真实问题。
       （同一个坑踩了两次：检查器的正则也是被测对象。） */
    for (const match of script.matchAll(/\/api\/[a-z0-9/-]+/g)) paths.add(match[0]);
    assert(paths.size >= 9, `扫描到的接口过少（${paths.size}）`);
    /* GET 分支不走 switch，故需在白名单里列明 */
    const passthrough = new Set(['/api/state', '/api/download', '/api/download-wst500', '/api/qc-content-contract']);
    const missing = [...paths].filter((path) => !passthrough.has(path) && !serverSource.includes(`case '${path}'`));
    assertEqual(missing, [], 'UI 调用了服务端不存在的接口');
  });

  /* 编辑范式（卡片 / 流式）与显示密度（演示 / 临床）是**两个正交维度**。
     合成一个开关的后果不是"少一个下拉"，而是"我到底在切什么"说不清：
     一个是"显示多少内部标识"，一个是"怎么落笔"，两个问题的答案互不替代。
     所以这里守的是"两个开关都在、各自有判断函数、各自持久化"。
     两者的住处与形态都不同（显示密度在顶栏、是个下拉；编辑范式在正文卡标题行右侧、
     是个分段控件），所以这里只按 id / 类名找，不绑位置与标签 —— 挪控件、换形态
     都不该让这条断言失效。 */
  await test("A36 编辑范式：卡片 / 流式是两个独立开关（与显示密度正交，都只是视图偏好）", () => {
    assert(/id="editMode"/.test(html) && /data-mode="flow"/.test(html), '应有编辑范式切换器（卡片 / 流式）');
    assert(
      /role="radiogroup"/.test(html) && /role="radio"/.test(html) && /aria-checked/.test(html),
      '切换器要用单选组语义：只有两个选项，而"当前在哪个"必须是可读出的状态，不能只靠颜色',
    );
    assert(/id="viewMode"/.test(html), '显示密度那个开关不能被顶掉（两者并存）');
    assert(/function isFlow\(\)/.test(script), '应有统一的范式判断函数（散落的 === "flow" 迟早写出半个分支）');
    assert(/l0demo\.editMode/.test(script), '编辑范式应持久化：它只是视图偏好，不该每次打开都重置');
    assert(
      /function syncEditMode\(/.test(script),
      '切换器要有统一的状态同步函数（滑块与 aria-checked 分两处写，重渲染后必然出现"滑块在流式、正文还是卡片"）',
    );
    assert(
      /setEditMode\(/.test(script) && /'\.seg-edit \.seg-item'/.test(script),
      '范式切换要接上点击处理，否则"切了没反应"',
    );
    assert(/mode === 'flow' \? 'flow' : 'card'/.test(script), '切换时取值必须收敛到两个合法值之一');
    assert(/<script[^>]+src="\/flow-view\.js"/.test(html), 'ui.html 应引用 /flow-view.js（否则流式模式渲染函数不存在）');
    /* 顺序：流式视图与卡片视图一样，都必须在本页脚本之前（窗口对象靠 load 顺序） */
    const flowTag = html.indexOf('src="/flow-view.js"');
    const uiTag = html.indexOf('src="/ui.js"');
    assert(flowTag > 0 && uiTag > flowTag, '/flow-view.js 必须在 /ui.js 之前加载');
  });

  /* 流式的落笔方式是"读 DOM → 与状态比对 → 得出一串操作"，一次动作可能对应好几次结构提交。
     因此必须有批量入口：逐条发 HTTP 的后果是"撤销只退掉半个动作"
     （拆段只退回了新段落，尾巴还留在里面）。 */
  await test('A37 流式落笔：批量入口 + 一个撤销单元 + AI 不得旁路（服务端守）', () => {
    assert(/\/api\/apply-edits/.test(script), '流式落笔应走批量入口（不是逐条发 /api/edit）');
    assert(/case '\/api\/apply-edits'/.test(serverSource), '服务端应有批量落笔路由');
    assert(/function applyFlowOp\(/.test(serverSource), '流式操作应有单一执行体（哪种 op 支持什么是产品边界，不能散在路由里）');
    /* 撤销单元：路由里必须成对开闭撤销组。
       只开不闭的后果不是报错，而是"后续无关的提交被吞进同一次撤销"，极难发现。 */
    assert(
      /entry\.session\.beginUndoGroup\(\);[\s\S]*entry\.session\.endUndoGroup\(\);/.test(serverSource),
      '批量落笔必须用一个撤销组包住（否则撤销退不掉整个动作）',
    );
    /* AI 旁路：批量入口必须显式判来源，且 `ai` 一律拒 —— 原则 1（AI 只能经建议通道）。
       漏了它的后果是"AI 内容可以不经过人工采纳直接进正文"，而那是本仓库最不能破的一条。 */
    assert(/const origin = String\(op\.origin \?\? 'human'\)/.test(serverSource), '批量插入必须显式判来源');
    assert(/E_AI_DIRECT_WRITE_FORBIDDEN/.test(serverSource), 'AI 内容不得经批量入口落笔（必须走建议通道）');
    /* 乐观锁：界面传来"画那一屏时的 rev"，服务端**整批判一次**。
       不判的后果是两个端同时改同一段时后写覆盖先写，而且没有任何痕迹说"被覆盖了"；
       逐条判的后果是把一次改动劈成一半（前两条落笔、第三条冲突），而撤回只能整批撤。 */
    assert(/expectedRev/.test(serverSource) && /E_REV_CONFLICT/.test(serverSource), '批量落笔要接乐观锁');
    assert(/expectedRev !== entry\.session\.docRev/.test(serverSource), '乐观锁要在**批前**整批判一次');
    assert(/flowBaselineRev/.test(script), '界面要记住"画那一屏时的 rev"（落笔时现读等于没有锁）');
  });

  /* 两种画法必须是**同一批视图项 + 同一条写路径**的两种表述。
     若流式自己再画一套表格/控件，两处迟早分叉，而分叉的表现是
     "同一个控件在两种模式里少了样东西" —— 没人会同时开两种模式比对。 */
  await test('A38 流式与卡片共用渲染与写路径（防两套分叉）', () => {
    assert(/L0FlowView\.render\(/.test(script), '医生端应调用流式渲染');
    assert(/L0FlowView\.planOf\(/.test(script) && /planOf/.test(flowScript), '渲染与解析必须来自同一份计划（两处各判一次必然分叉）');
    assert(/L0DocView\.nodeHtml\(/.test(flowScript), '表格与专科控件应复用卡片模式的渲染，不另画一份');
    assert(/data-flow-seg/.test(frontend), '可编辑区要有稳定的区标识（落笔时按它找回来）');
    assert(/flowHostOf\(/.test(script), '落笔前要能按区标识找回那片可编辑区');
    /* 光标：流式下一次落笔就会重画整片纸，不还原光标等于"每写完一句就被踢出去" */
    assert(/L0FlowView\.caretOf\(/.test(script) && /L0FlowView\.setCaret\(/.test(script), '落笔前后要存取光标');
    /* 输入法：合成期间不落笔（落笔重画会把候选框打断） */
    assert(/compositionstart/.test(script) && /compositionend/.test(script) && /composing/.test(script), '必须处理输入法合成期');
    /* 填写项的判据**只能有一份**：id 序列。
       这里钉的不是"写法"而是踩过的坑：曾经用"文字被浏览器切成了几段"当判据（`shape`），
       而那个切分方式随输入过程变化（打一个字就可能把一段文字拆成两个节点），
       结果是**每一次正常输入都被误判成"填写项被搬动了"、整批拒绝落笔**。
       现场表现是"打字没反应，只有一句提示" —— 真实浏览器里跑出来的，静态检查看不出来。 */
    assert(!/\.shape\b/.test(flowScript), '不要用文本节点切分方式当填写项判据（它随输入变化，会整批误拒）');
    assert(/base\.fields/.test(flowScript), '填写项的比对要落在基线与 DOM 两侧**同一份**判据上');
    /* 前端与卡片模式共用同一条落笔纪律：点任何按钮之前先落笔 */
    assert(/async function flushEdits\(\)\s*\{\s*[\s\S]{0,200}?await flushFlow\(\);/.test(script), '统一落笔入口必须同时覆盖流式模式');
    /* 段末状态徽标必须**看得见**、且**不被读进正文** —— 这两件事是一对：
       看不见（最初那版就是）：医生要到签章被"待确认"清单拦下才知道有段落没确认；
       看得见但会被读进正文：下一次落笔就把「待确认」三个字写成了病历内容。
       质控徽标与待确认判词都复用卡片模式那一份（两处各写一份必然分叉）。 */
    assert(/paragraphDecoHtml/.test(flowScript), '纸面上要有段末状态徽标（来源 / 关键内容 / 待确认 / 质控）');
    assert(/dataset\.paraDeco\) continue/.test(flowScript), '解析时必须整块跳过段末装饰');
    assert(/L0DocView\.anchorBadge/.test(flowScript), '质控徽标要复用卡片模式那一份');
    assert(/L0DocView\.confirmChip/.test(flowScript), '待确认要用卡片模式同一份判词');
    /* 演示模式的内部标识：用生成内容显示，**不能写进 DOM 文本**（写进去就会被当成正文读回去） */
    assert(/attr\(data-node-id\)/.test(css) && /flow-mode:not\(\.clinical\)/.test(css), '演示模式要在纸面上显示节点 id 与 rev');
    /* Ctrl+Z：不拦就会落到浏览器原生撤销上（只改 DOM、不进模型），而落笔重画会清掉原生撤销栈 */
    assert(/event\.key === 'z'/.test(script) && /undoButton\.click\(\)/.test(script), '流式纸面上要接管 Ctrl+Z 并交给既有撤销路径');
  });

  /* run 级来源（`RunProvenance`）是"逐句可回溯"的载体，它必须**三处同步**：
     模型定义、校验白名单、run 合并规则。少任何一处的后果都不是报错，而是静默错误：
       · 少了白名单 → 文档校验直接判非法（写进去的文档过不了自己的校验）；
       · 少了合并规则 → 格式不同的相邻 run 被合并，"这一句是 AI 写的"标记被抹掉，
         且合并是不可见的（结果里看不出曾经有过两个 run）。 */
  await test('A39 run 级来源：模型 / 校验白名单 / 合并规则三处必须同步', () => {
    const typesSource = readFileSync(join(ROOT, 'src', 'model', 'types.ts'), 'utf8');
    const validateSource = readFileSync(join(ROOT, 'src', 'model', 'validate.ts'), 'utf8');
    const textRunsSource = readFileSync(join(ROOT, 'src', 'core', 'text-runs.ts'), 'utf8');
    assert(/interface RunProvenance/.test(typesSource), 'run 级来源应在模型里定义');
    assert(/provenance\?: RunProvenance/.test(typesSource), 'TextRun 应挂上可选的 provenance（可选 = 旧文档行为不变）');
    assert(/'text', 'marks', 'tags', 'provenance'/.test(validateSource), '校验白名单必须登记 provenance（漏了就是"写进去的文档过不了校验"）');
    assert(/JSON\.stringify\(a\.provenance/.test(textRunsSource), '合并规则必须比较 provenance（漏了就会把来源标错且看不出来）');
    /* 不继承：医生在 AI 句子里插字，插进去的必须是"人写的" */
    assert(/provenance` \*\*刻意不继承\*\*/.test(textRunsSource), '"新插入的 run 不继承来源"这条规则必须写明（否则下一个人会顺手补上继承，方向就反了）');
    /* AI 落笔的来源构造属于内核（单条采纳与批量采纳共用一份），
       不能由上层各写一遍 —— 那样"同一份数据在两张报表上不一样" */
    const sessionSource = readFileSync(join(ROOT, 'src', 'core', 'session.ts'), 'utf8');
    assert(/function aiRunProvenance/.test(sessionSource), 'AI 落笔的 run 级来源应由内核统一构造');
  });

  await test('A14 界面可见文本不得出现 Markdown 语法（`粗体` 会被原样显示）', () => {
    /* 拆分后可见文本可能在 HTML 标记、CSS、以及 JS 里渲染出的模板字符串（含确认弹框的文案）。
       注释（块注释 / 行注释 / HTML 注释）里的不受影响，先剥掉，剥完还剩 ``，就是会被人看到的那种。 */
    const stripComments = (text: string) => text
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/<!--[\s\S]*?-->/g, '');
    const visible = stripComments(frontend);
    const offenders = (visible.match(/[^\n]*\*\*[^\n]*/g) || []).slice(0, 3);
    assertEqual(offenders, [], `界面可见文本不应出现 Markdown 语法（会被原样显示）：${offenders.join(' | ')}`);
  });

  await test('A5 页面不会把编辑器的失焦保存做成"点击丢失"（必须取消防抖后再执行动作）', () => {
    assert(/clearTimeout\(blurTimer\)/.test(script), 'click 处理必须先取消失焦防抖，否则保存重绘会把被点的按钮替换掉');
    assert(/setTimeout\(\(\) => \{ void flushEdits\(\); \}, 250\)/.test(script), '失焦保存应延迟 250ms，让 click 先完成');
    assert(/pendingEdits/.test(script), '应有脏值追踪（避免每次失焦都写库产生无意义留痕）');
  });

  await test('A6 右侧工作栏：一次只显示一个页签 + 面板内不出现滚动条（内容全展开）', () => {
    assertEqual((markup.match(/data-panel="/g) || []).length, 11, '应有 11 个面板：AI / 语音 / 质控 / 时间轴 / 跨次对比 / 预问诊 / 出院汇总 / 机读 / 定稿 / 日志 / 指标（配置管理是抽屉，不是页签）');
    assertEqual((html.match(/class="panel active"/g) || []).length, 1, '默认只显示一个面板（紧凑）');
    assert(/\.panel\s*\{[^}]*display:\s*none/.test(css), '未选中的面板应隐藏');
    assert(/\.panel\.active\s*\{[^}]*display:\s*flex/.test(css), '当前面板应显示（flex 竖排：标题行高度不参与正文高度计算）');
    assert(!/\.panel\.active > \.pb\s*\{[^}]*overflow/.test(css), '面板体不应有内部滚动条（内容要全部显示）');
    /* 正文段的高度不能按"标题行 = 42px"这类常量算：标题里的状态胶囊一折行，
       标题就变高，正文按常量算出来的高度会顶出面板底部被裁掉（实测门控日志少一截）。
       这一条和 A12 同类：它不"好看"，但它决定内容看不看得全，所以要防回退。 */
    assert(!/\.pb\s*\{[^}]*height:\s*calc\(/.test(css), '面板正文段不得按常量算高度（标题行高度是内容算出来的）');

    assert(/\.col\.rail\s*\{[^}]*position: sticky/.test(css), '右栏应贴壁（内容短时吸附在右侧）');
    assert(!/\.col\.rail\s*\{[^}]*max-height/.test(css), '右栏不应限高（限高就会逼出滚动条）');
    assert(/\.col\.rail\s*\{[^}]*align-self: start/.test(css), 'grid 子项必须 align-self:start，否则 sticky 失效');
    assert(/\.tabbar\s*\{[^}]*flex-wrap: wrap/.test(css), '页签应可换行，避免标签被裁');
    assert(!/\.tabbar\s*\{[^}]*overflow-x: auto/.test(css), '页签栏不应横向滚动（否则标签会被裁掉）');

    assert(/l0demo\.activeTab/.test(script), '页签选择应持久化');
    assert(/applyPanelState\(\)/.test(script), '应有统一的"显示当前面板"函数');
    /* 标签配平：错配会被浏览器容错（页面看着正常、结构已经错），人工极难发现，
       实测踩到过：把某个 `</div>` 写成了 `</h2>`，页面照常显示。 */
    for (const tag of ['div', 'h2', 'section']) {
      const open = (markup.match(new RegExp(`<${tag}[\\s>]`, 'g')) || []).length;
      const close = (markup.match(new RegExp(`</${tag}>`, 'g')) || []).length;
      assertEqual(open, close, `<${tag}> 标签必须配平（开 ${open} / 闭 ${close}）`);
    }
    assert(/switchTab\(tab\.dataset\.tab\)/.test(script), '点页签应切换显示的面板');

    /* 配置管理是抽屉浮层（不是右栏页签）：
       它若混进页签体系，就会出现"抽屉开着、页签却高亮在别处"这种自相矛盾的状态；
       而且它是"离开写病历去做的事"，与右栏那些"随时瞄一眼"的页签不同类。 */
    /* 配置抽屉已搬到管理后台独立页面（/admin）：这里不再断言它的交互细节
       （showModal / 遮罩 / 焦点归还），医生端已经没有这条路径了。
       标记本身还在（惰性的，见 ui.html 的说明），下面两条是过渡期断言：
       删标记时要连同本用例一起改（L0 进度条目里列为"未做完"）。 */
    assert(/id="btnAdmin"/.test(html), '医生端应只剩一个通往管理后台的入口（配置不再摆在医生端）');
    assert(/id="modelDrawer"/.test(html), '（过渡期）抽屉标记仍在但已惰性：删它要同步改本用例与 A2/A20/B28');
    /* 抽屉必须真正铺满视口高度，且内部滚动不带动背景页：
       Chrome 给 top-layer dialog 默认加了 max-height（约 calc(100% - 6px - 2em)），
       不显式 max-height:none 就会在底部露出约 38px 主界面（实测踩到）。 */
    assert(/dialog\.drawer\s*\{[^}]*max-height:\s*none/.test(css), '抽屉应解除 UA 的 max-height 上限，否则铺不到视口底部');
    assert(/dialog\.drawer\s*\{[^}]*overscroll-behavior:\s*contain/.test(css), '抽屉内滚动不应把背景页一起带着滚');
    assert(/html\.drawer-open\s*\{[^}]*overflow:\s*hidden/.test(css), '抽屉打开期间应锁住背景页滚动');
    /* 背景滚动锁与"按坐标判定的遮罩点击"随抽屉一起移除：配置搬到管理后台后那里是整页，
       没有浮层，也就不需要遮罩、Esc 兜底与滚动锁。CSS 侧的 .drawer 规则暂留（标记还在，属惰性），
       删标记时一并清理。 */
    /* 抽屉必须有显式视口高度：Chrome UA 给 dialog 的默认 height 是 fit-content，
       内容比视口高时元素会长出去、overflow-y:auto 反而不生效（内容滚不动）。 */
    assert(/dialog\.drawer\s*\{[^}]*height:\s*100dvh/.test(css), '抽屉应显式给视口高度，否则内部内容滚不动');
    /* 抽屉四角必须是直角（尤其下边左右两角）：仅靠简写可能被内核兜底样式局部覆盖，
       故要求逻辑四角的 border-end-*-radius 显式归零。 */
    assert(/border-end-start-radius:\s*0/.test(css) && /border-end-end-radius:\s*0/.test(css), '抽屉四角应为直角（含下边左右两角）');

    assert(!/slice\(0, 12\)|slice\(-8\)|slice\(-30\)/.test(serverSource), '服务端不应截断机读数据元 / 留痕 / 日志');
    for (const dot of ['tabDotAi', 'tabDotQc', 'tabDotTimeline', 'tabDotVoice', 'tabDotMachine', 'tabDotExport', 'tabDotLog', 'tabDotMetrics']) {
      assert(html.includes(`id="${dot}"`) && script.includes(dot), `未显示的页签也要有状态点：${dot}`);
    }
  });

  await test('A8 「更多」菜单：低频页签默认收起但可展开、不丢失；每个页签都必须真的能切换', () => {
    /* ① 收起 ≠ 删除：五项在菜单里，随时可打开。
       配置管理不在菜单里：它在顶栏（属管理员操作，与"医生偶尔要用"的低频页签不同类）。 */
    assertEqual((html.match(/data-optional=/g) || []).length, 6, '应有 6 个低频页签（跨次对比 / 预问诊 / 出院汇总 / 定稿 / 日志 / 指标）');
    assert(/id="moreMenu"[^>]*hidden/.test(html), '菜单应默认收起');
    assert(/\.more-menu\[hidden\]\s*\{[^}]*display:\s*none/.test(css), '菜单收起时应真正隐藏');
    assert(/id="btnMoreTabs"/.test(html) && /btnMoreTabs/.test(script), '必须有「更多」图标按钮');
    /* 图标形态：不应再有"更多"这个文字页签 */
    assert(!/>\s*更多\s*</.test(html), '「更多」应是图标按钮，不是文字页签');
    /* 菜单里用全称：页签栏用简称是为省地方，菜单空间充足，没有理由让人猜 */
    const menuBlock = /<div class="more-menu"[\s\S]*?<\/div>/.exec(html)?.[0] ?? '';
    assertEqual(
      ['定稿与导出', '门控日志', '指标与留痕'].filter((label) => menuBlock.includes(label)),
      ['定稿与导出', '门控日志', '指标与留痕'],
      '菜单项应用全称（简称是页签栏的妥协，不该带进菜单）',
    );

    /* 四个常驻页签同样用全称，且顺序按使用频次：
       AI 助手 → 语音转写 → 质控提示 → 机读信息 */
    const navBlock = /<div class="tabbar" id="tabbar"[\s\S]*?<div class="more-menu"/.exec(html)?.[0] ?? '';
    const navLabels = ['AI 助手', '语音转写', '质控提示', '机读信息'];
    assertEqual(navLabels.filter((label) => navBlock.includes(label)), navLabels, '常驻页签应用全称');
    const positions = navLabels.map((label) => navBlock.indexOf(label));
    assertEqual(
      positions.every((position, index) => index === 0 || position > (positions[index - 1] as number)),
      true,
      '常驻页签顺序应为 AI 助手 → 语音转写 → 质控提示 → 机读信息（语音紧跟 AI 助手）',
    );

    /* ② 菜单项也是页签，必须一同高亮，否则停在"定稿"时，界面上没有任何地方
       显示"你现在在哪一栏"（页签栏里已经没有它的位置了） */
    assert(/querySelectorAll\('\.tab, \.more-item'\)/.test(script), '菜单项必须与页签一同高亮');
    assert(/OPTIONAL_TABS\.includes\(activeTab\)/.test(script), '图标按钮应知道"当前面板在菜单里"');
    assert(/function setMoreMenu\(/.test(script), '应有统一的菜单开关函数');
    /* 顺序很关键：图标按钮也带 .tab 类，必须先于页签分支处理，否则会被 switchTab 截住 */
    assert(
      script.indexOf("closest('#btnMoreTabs')") < script.indexOf("closest('.tab')"),
      '「更多」按钮必须比页签分支先处理，否则菜单打不开',
    );

    /* ③ 最隐蔽的一类界面断裂：页签在 HTML 里、但脚本的 TABS 白名单里没有，
       点它不报错、不崩溃，就是没反应。
       本轮撞到过两次：新增"质控"页签时漏了 TABS（`switchTab` 被白名单拦下）；
       以及菜单项不带 `.tab` 就收不到高亮。 */
    const declared = [...html.matchAll(/data-tab="([^"]+)"/g)].map((match) => String(match[1]));
    assert(declared.length >= 7, `扫描到的页签过少（${declared.length}）`);
    const tabsMatch = /const TABS = \[([^\]]+)\]/.exec(script);
    assert(tabsMatch !== null, '应能读到脚本里的 TABS 白名单');
    const allowed = String(tabsMatch?.[1])
      .split(',')
      .map((item) => item.trim().replace(/['"]/g, ''));
    assertEqual(
      declared.filter((key) => !allowed.includes(key)),
      [],
      '这些页签点了不会有任何反应（不在脚本 TABS 白名单里）',
    );
    assertEqual(
      allowed.filter((key) => !declared.includes(key)),
      [],
      'TABS 里有、HTML 里没有的页签（切过去会是空白面板）',
    );
  });

  /* A32：能力开关（宿主按部署形态收窄界面）。
     它靠 HTML 上的 `data-capability` 与脚本里的 `CAPABILITIES` 白名单两处配合，
     而两处对不上的表现**都不报错**：一个能力名拼错 = 那个入口永远不显示；
     白名单里多一个没人用的名字 = 这个错永远查不出来。所以只能静态钉住。
     另有一条界面断裂必须一起守：摘掉面板却还在渲染它 —— 渲染函数摸到 null 会直接抛。 */
  await test('A32 能力开关：data-capability 与脚本白名单必须一一对得上，且页签与面板成对、不得与 data-optional 混用', () => {
    const capsMatch = /const CAPABILITIES = \[([^\]]+)\]/.exec(script);
    assert(capsMatch !== null, '应能读到脚本里的 CAPABILITIES 白名单（否则能力开关名无据可依）');
    const allowed = String(capsMatch?.[1])
      .split(',')
      .map((item) => item.trim().replace(/['"]/g, ''))
      .filter((item) => item !== '');
    const declared = [...html.matchAll(/data-capability="([^"]+)"/g)].map((match) => String(match[1]));

    /* ① 页面上标的每个能力，脚本里都得认识 */
    assertEqual(
      declared.filter((name) => !allowed.includes(name)),
      [],
      'HTML 上有脚本不认识的 data-capability（该入口会永远不显示，且不报错）',
    );
    /* ② 反证：白名单里不得有没人用的名字，否则"拼错"这个错永远暴露不出来 */
    assertEqual(
      allowed.filter((name) => !declared.includes(name)),
      [],
      'CAPABILITIES 里有 HTML 没用到的能力名（说明有名字拼错了，或漏了标记）',
    );
    /* ③ 页签与面板成对：只摘页签会留下一个再也切不回去的面板；
          只摘面板会留下一个点下去变空白的页签 */
    const markedTabs = [...html.matchAll(/data-tab="([^"]+)"[^>]*data-capability="([^"]+)"/g)].map((match) => String(match[1]));
    const markedPanels = [...html.matchAll(/data-panel="([^"]+)"[^>]*data-capability="([^"]+)"/g)].map((match) => String(match[1]));
    assert(markedTabs.length >= 3, `带能力开关的页签过少（${markedTabs.length}）`);
    assertEqual(
      markedTabs.filter((name) => !markedPanels.includes(name)),
      [],
      '这些页签带能力开关，但对应面板没带（能力缺席时点它会是空白）',
    );
    /* ④ 摘掉面板就必须停掉它的渲染 */
    for (const name of ['export', 'log', 'metrics']) {
      assert(
        new RegExp(`panelAlive\\('${name}'\\)`).test(script),
        `能力缺席摘掉 panel-${name} 后，renderAll 里必须有对应的渲染守卫（否则渲染函数摸到 null 会抛）`,
      );
    }
    assert(/applyCapabilities\(\);\s*\n/.test(script), 'applyCapabilities() 必须在启动路径上被调用');
    /* ⑤ 两类开关不许混：`data-optional` 的语义是"低频、收进「更多」菜单"，数量由 A8 钉着 3 个。
          能力开关若复用它，A8 就变成在数两个语义的和，两边都会失去意义 */
    assertEqual((html.match(/data-optional=/g) || []).length, 6, 'data-optional 仍应恰好 6 个（能力开关不得复用它）');
  });

  await test('A9 被拒原因必须就地可见：不能只藏在收起的「门控日志」里', () => {
    /* 背景：门控日志收进「⋯」菜单后，被拒时页签栏没有任何提示，
       错误反馈等于被藏进一个默认看不见的地方。而"看不到为什么被拒"
       会把医生的行为引向"再点一次"，那是最该避免的排查方向。 */
    assert(/id="rejectBanner"/.test(html), '应有"最近一次被拒"横幅');
    assert(/function renderRejectBanner\(/.test(script), '横幅应由统一函数渲染');
    assert(/\.tab\.more\.alert/.test(css), '「⋯」图标应在有被拒时变色报警');
    /* 数据必须来自真实门控日志：另造一份"失败状态"必然与它不同步 */
    assert(/S\.log/.test(script) && /ok === false/.test(script), '横幅应读门控日志');
    /* 必须有"查看日志"出口：横幅只给结论，完整原因在日志里 */
    assert(/id="btnOpenLog"/.test(script) && /switchTab\('log'\)/.test(script), '横幅应能一键打开门控日志');
    /* 收起只针对"那一次"被拒，否则按一次 × 就把报警永久关掉了 */
    assert(
      /dismissedRejectAt/.test(script) && /latest\.at !== dismissedRejectAt/.test(script),
      '收起只针对那一次被拒，再次被拒必须重新出现',
    );
  });

  await test('A10 演示 / 临床模式：临床模式必须真的少显示内部标识，而不只是改个名字', () => {
    assert(/id="viewMode"/.test(html) && /value="clinical"/.test(html), '应有模式开关');
    assert(/function isClinical\(\)/.test(script), '应有统一的模式判断函数');
    /* 必须条件渲染而不是渲染后隐藏：后者会把内容留在 DOM 里，
       复制、读屏、审查时仍会出现，等于没做 */
    const guarded = (script.match(/isClinical\(\)/g) || []).length;
    assert(guarded >= 6, `临床模式的条件渲染点过少（${guarded} 处），只换名字不算产品化`);
    /* 这几处是最容易被漏掉的内部标识 */
    /* 节点行的渲染在共用的 `/doc-view.js` 里：模式由调用方以 `clinical` 选项传入 ——
       管理后台的模板预览走同一条路，于是"预览里同样收起内部标识"不必再单独验一遍 */
    assert(/opts\.clinical === true \? '' : `<span class="rev">/.test(script), '节点行上的「id · rev」应受模式控制');
    assert(/isClinical\(\) \? '' : `<span class="chip ai">/.test(script), '建议卡片上的 modelId 应受模式控制');
    assert(/isClinical\(\) \? '' : `<span class="chip danger">/.test(script), '被拒横幅上的错误码应受模式控制');
    /* 切模式必须重渲染，否则界面会停在上一个模式的形态（那比不做模式更糟） */
    assert(/addEventListener\('change'/.test(script) && /el\.id !== 'viewMode'/.test(script), '切换模式后必须整体重渲染');
  });

  await test('A11 键盘体系：输入态绝不能触发单键，且不可逆操作必须二次确认', () => {
    /* ① 最要命的一条：在 textarea 里打字时按 a 会采纳建议，那是事故，不是便利。
       所以 keydown 第一步就必须是输入态判断。 */
    assert(/function isTyping\(\)/.test(script), '应有输入态判断函数');
    assert(/tag === 'TEXTAREA'/.test(script) && /tag === 'INPUT'/.test(script), '输入态应覆盖 TEXTAREA 与 INPUT');
    const keydownAt = script.indexOf("addEventListener('keydown'");
    const typingGuardAt = script.indexOf('if (isTyping())', keydownAt);
    assert(keydownAt >= 0 && typingGuardAt > keydownAt, 'keydown 的第一个分支必须是输入态判断');
    /* 该分支在单键处理之前，否则等于没拦 */
    const acceptAt = script.indexOf("event.key === 'a'", keydownAt);
    assert(acceptAt > typingGuardAt, '输入态判断必须排在单键处理之前');

    /* ② 不可逆操作二次确认：拒绝一旦发生就回不到待处理 */
    assert(/pendingRejectId/.test(script) && /再按一次/.test(script), '拒绝应二次确认（不可逆操作不能单键直做）');

    /* ③ 必须有可见选中态，否则 j/k 移动后不知道焦点在哪 */
    assert(/\.sugg\.focused/.test(css), '选中项必须有可见样式');
    assert(/function syncFocus\(/.test(script) && /scrollIntoView/.test(script), '移动后应滚动到可见区');

    /* ④ 发现性：没有帮助说明，等于没做快捷键 */
    assert(/id="keysHelp"/.test(html) && /toggleKeysHelp/.test(script), '应有快捷键帮助表');

    /* ⑤ 不抢浏览器快捷键；页签切换用组合键而非单键 */
    assert(/event\.ctrlKey \|\| event\.metaKey/.test(script), '不应拦截浏览器快捷键');
    assert(/event\.altKey/.test(script) && /Alt\+1/.test(html), '页签切换应用 Alt+数字组合键');
  });

  await test('A12 可读性基线：正文不小于 14px、次要色足够深、说明默认折叠、操作有回执', () => {
    /* 这类"不好看但决定医生愿不愿意一直看"的基线，最容易被后续改动顺手改回去，
       所以它和门控一样需要被锁住。 */
    assert(/--fs-md:\s*14px/.test(css), '正文字号令牌应为 14px（医生真正要看的是它，不能更小）');
    assert(/textarea\.editor[^{]*\{[^}]*font-size:\s*var\(--fs-md\)/.test(css), '正文编辑区应使用该字号令牌');
    assert(/--muted:\s*#5a6472/.test(css), '次要文字色应加深到足够对比度');
    /* 面板内不再摆折叠说明（2026-10-17 起由用户要求删除）：判断标准不是"有没有说明"，
       而是**首屏只留能动手的东西** —— 说明退到按钮 title 与文档里。 */
    assert(!/class="note"/.test(html), '面板内不再摆放折叠说明块（说明改挂 title）');
    assert(/id="toast"/.test(html) && /function toast\(/.test(script), '操作必须有全局回执');
    /* 回执必须挂在统一的响应处理上，而不是散落各处手动调用，散着写一定会漏 */
    assert(/result\.ok === false\) toast\(/.test(script), '回执应由统一的响应处理触发');
  });

  await test('A13 面板标题只说"这是什么"：不该出现设计内部词汇，也不该丢掉演示声明', () => {
    /* "旁挂""-H 载体"是我们的设计语言，不是医生的语言，出现在标题行只是噪音。
       该说的机制改由按钮 title 承担（面板内的折叠说明已按用户要求删除，见 A12）。 */
    assert(!/旁挂 · 不是文档内容/.test(html), '标题行不该出现"旁挂 · 不是文档内容"这类设计内部词汇');
    assert(!/"-H" 载体/.test(html), '标题行不该出现内部缩写');
    /* 但演示声明必须保留：删掉它会让人误以为这里接了真实模型 / 真实 ASR */
    assert(/本地规则模拟/.test(html), '演示声明不能被删掉（否则会被误认为真实模型）');
    assert(/模拟 ASR/.test(html), '演示声明不能被删掉（语音同理）');
    assert(
      /demo-only/.test(html) && /body\.clinical \.demo-only/.test(css),
      '演示声明应只在演示模式显示（对医生是噪声，对评审是必要的诚实声明）',
    );
  });

  await test('A7 导航：左栏树状病历（可折叠）为唯一入口，切换走 /api/open', () => {
    assert(/id="tree"/.test(html) && /患者病历/.test(html), '左栏应有病历树');
    assert(!/id="docSelect"/.test(html) && !/id="patientSelect"/.test(html), '顶栏下拉应已移除（导航收敛到左栏树）');
    assert(!/optgroup/.test(script), '不应残留下拉分组逻辑（避免两条导航路径各自演化）');
    assert(/data-toggle/.test(script) && /collapsedTree/.test(script) && /l0demo\.collapsedTree/.test(script), '树节点应可折叠且折叠状态持久化');
    assert(/data-doc=/.test(script) && /dataset\.doc/.test(script), '病历行应可点击切换');
    assert(/switchDoc\(/.test(script) && /'\/api\/open'/.test(script), '切换病历必须调用 /api/open（而不是只改前端状态）');
  });

  await test('A8 布局：三栏（树 / 正文 / 页签）+ 正文随中栏拉宽', () => {
    assert(/grid-template-columns:\s*238px/.test(css), '主区应为三栏网格，左栏固定宽');
    /* 正文不再限宽（2026-10-17 起按用户要求自动拉宽）：中栏多宽正文就多宽。
       限宽会在宽屏上留下大块空白，看上去像"正文被压窄了"。 */
    assert(!/\.doc-wrap\s*\{[^}]*max-width/.test(css), '正文应随中栏拉宽，不应再设限宽');
    assert(/align-items: start/.test(css), 'grid 子项不应被拉伸等高，各栏按内容自然撑高');
  });

  await test('A9 内容必须显示全：正文与树整页铺开（唯一例外是贴壁栏本身限高）', () => {
    assert(!/body\s*\{[^}]*overflow: hidden/.test(css), 'body 不应锁死滚动');
    assert(!/\.col\s*\{[^}]*overflow/.test(css), '列不应内部滚动（内容要能整页铺开）');
    assert(!/\.tree\s*\{[^}]*overflow/.test(css), '树不应内部滚动');
    assert(!/\.doc\s*\{[^}]*max-height/.test(css), '正文不应限高');
    /* cssNoComments 已在模块顶部统一生成（对 ui.css 剥掉注释）。
       唯一例外是 `max-height: none`，它解除浏览器对 top-layer dialog 的默认上限，
       与"限高逼出滚动条/截断内容"方向相反；其余任何带长度的 max-height 仍然禁止。 */
    const limiting = (cssNoComments.match(/max-height\s*:[^;]+/g) || []).filter((decl) => !/max-height\s*:\s*none\b/.test(decl));
    assertEqual(limiting, [], `除抽屉的 max-height:none（解除 UA 上限）外不应出现任何限高声明（限高会逼出滚动条/截断内容），实际：${limiting.join(' | ')}`);
    assert(!/text-overflow: ellipsis/.test(css), '不应以省略号截断文本（导航项也要显示全）');
    assert(/autosizeAll/.test(script) && /scrollHeight/.test(script), '编辑框应随内容自增高度，不能在框内滚动');
    assert(/renderPanelBadges\(\);\s*updateDirtyBadge\(\);\s*autosizeAll\(\);/.test(script), '每次重渲染后都应重新自适应高度');
    assert(/el\.style\.height = `\$\{el\.scrollHeight \+ 2\}px`/.test(script), '输入时应即时增高（边打字边变高）');
  });

  await test('A10 建议调用：必须用当次 suggest 返回的 id（取错会静默失败，且没有报错提示）', () => {
    assert(!/find\(\(s\) => s\.status === 'pending'\)/.test(script), '不应再用 find(pending) 取建议：上一条被拒的建议仍是 pending，会被取到');
    /* 判据是"每一处产出都保存了返回值"，不是"恰好几处"：
       裸调用 = 丢掉 id，只能靠 find(pending) 找回来，而那正是本用例要禁止的。
       原先是拿一键演示那三次产出（`first/second/third`）钉住这条不变量；
       那段自动演示脚本已从页面移除，不变量不变，盯的改成页面上真人在点的建议入口。 */
    assertEqual(
      script.match(/^\s*await api\('\/api\/suggest(-low)?'/gm) || [],
      [],
      '不应出现未保存返回值的建议调用（丢了 id 就只能靠 find(pending) 找回来）',
    );
    assert(
      (script.match(/= await api\('\/api\/suggest(-low)?'/g) || []).length >= 1,
      '页面上的建议入口应保存返回值并复用其 id',
    );
  });

  await test('A11 导入入口：顶栏有"导入 OFD-H"按钮与文件选择，界面有导入来源卡片', () => {
    assert(/id="btnImport"/.test(markup), '顶栏应有导入按钮');
    assert(/id="fileInput"[^>]*type="file"/.test(markup) || /type="file"[^>]*id="fileInput"/.test(markup), '应有文件选择控件');
    assert(/id="importCard"/.test(markup) && /renderImport/.test(script), '应有导入来源与核对提示卡片');
    assert(/'\/api\/import'/.test(script), '导入应走 /api/import');
    assert(/btoa\(binary\)/.test(script), '文件应以 base64 提交（避免 multipart 解析依赖）');
  });

  await test('A15 设计令牌与暗色模式：颜色/间距/字号/动效令牌化，主题可切换且尊重系统偏好', () => {
    assert(/--muted:\s*#5a6472/.test(css), '浅色主题次要文字色应保持对比度基线');
    assert(/:root\[data-theme="dark"\]\s*\{/.test(css), '暗色主题必须成套定义令牌（不是散落覆盖）');
    assert(/color-scheme:\s*dark/.test(css) && /color-scheme:\s*light/.test(css), '原生控件应随主题切换（color-scheme）');
    assert(/--s1:/.test(css) && /--radius:/.test(css) && /--fs-xs:/.test(css), '间距/圆角/字号应令牌化');
    assert(/--t:\s*\d+ms/.test(css), '动效时长应令牌化');
    assert(/id="btnTheme"/.test(html), '顶栏应有主题切换按钮');
    assert(/l0demo\.theme/.test(script), '主题选择应持久化');
    assert(/prefers-color-scheme/.test(script), '未手动选择时应尊重系统偏好');
    assert(!/style="/.test(html), 'ui.html 不应残留内联 style（统一走令牌与类）');
  });

  await test('A16 动效降级：提供 reduced-motion，用户要求减少动效时动画立即到终态', () => {
    assert(/@media \(prefers-reduced-motion: reduce\)/.test(css), '必须提供 reduced-motion 降级');
    assert(/@keyframes/.test(css), '动效应集中用 @keyframes 定义（便于统一降级）');
  });

  await test('A17 可访问性：页签/面板/回执有正确 ARIA 角色，图标按钮有可访问名', () => {
    assert(/role="tablist"/.test(html), '页签栏应有 tablist 容器');
    assert((html.match(/role="tab"/g) || []).length >= 7, '每个页签应有 tab 角色');
    /* 只数右栏的 7 个面板：配置抽屉里的子页签也是 tabpanel，不该被算进来 */
    /* 不要求 `data-panel` 紧跟 `role`：两者之间还可能隔着 `data-visit-scope` 之类的开关属性，
       把属性顺序写进断言，改一次顺序就会得到一条看起来像"面板丢了"的失败 */
    assertEqual((html.match(/data-panel="[^"]+"[^>]*role="tabpanel"/g) || []).length, 11, '右栏应有 11 个面板且都带 tabpanel 角色（新增页签时连同本用例一起改）');
    assert(/aria-selected/.test(script), '当前页签应同步 aria-selected（读屏感知切换）');
    assert(/role="status"/.test(html), '回执类浮层应有 status 角色');
    assert(/role="alert"/.test(html), '被拒横幅应以 alert 呈现（即时可达）');
    assert(/aria-live/.test(script), 'toast 的紧急程度应反映到 aria-live');
    assert(/aria-expanded/.test(script), '「更多」按钮应向读屏暴露展开状态');
    assert(/aria-label="切换深色 \/ 浅色主题"/.test(html), '主题按钮应有可访问名');
    assert(/aria-label="键盘快捷键帮助"/.test(html), '键盘按钮应有可访问名');
    assert(/<html lang="zh-CN">/.test(html), '应声明页面语言');
  });

  await test('A18 回执与空态：任何请求都有进行中指示，空态用统一组件，按钮动作有 busy 态', () => {
    assert(/id="busyBar"/.test(html) && /busyBar/.test(script), '应有全局进行中指示（请求有回执，医生才不会重复点）');
    assert((script.match(/class="empty"/g) || []).length >= 3, '空态应用统一 .empty 组件而不是散落的 muted 文本');
    assert(/aria-busy/.test(script), '按钮动作期间应有 aria-busy 状态（读屏可感知、连续点击被挡）');
  });

  await test('A19 拖拽指定落点：靠 data 属性定位，且只接受候选集内的节点', () => {
    /* 拖拽是"指定落点"的另一种输入方式，不新增通道：拖完只改写那个下拉框的值，
       提交仍走「按这些落点生成建议」→ `/api/dictate-commit`。 */
    assert(/data-drag-segment/.test(frontend), '段落卡片应有 data-drag-segment（事件委托靠它定位拖源）');
    assert(/data-node-id/.test(frontend), '正文文本节点应有 data-node-id（它是拖放落点目标）');
    assert(
      /placementCandidateIds\.has/.test(script),
      '拖放只接受候选集内的节点：不是任何节点都能接收落点（内核只认文本节点，落点还必须在候选范围内）',
    );
  });

  await test('A20 配置子页签：页签与面板一一对应，且每个面板只装一组配置', () => {
    /* 这条检查是踩坑之后加的：子页签容器一旦少一个闭合 `</div>`，后面的面板会整体嵌进第一个里，
       表现是"切到别的页签，内容区一片空白"，而所有 id 都在（A2 照样通过），静态检查完全看不出来。 */
    const tabs = [...html.matchAll(/data-cfg-tab="([^"]+)"/g)].map((match) => match[1]);
    const panes = [...html.matchAll(/data-cfg-pane="([^"]+)"/g)].map((match) => match[1]);
    assert(tabs.length >= 3, `应有配置子页签，实际 ${tabs.length}`);
    assertEqual(tabs.slice().sort(), panes.slice().sort(), '每个子页签都应有对应面板（且没有多余面板）');
    for (const match of html.matchAll(/data-cfg-pane="([^"]+)"/g)) {
      const start = match.index ?? 0;
      const next = html.indexOf('data-cfg-pane="', start + 1);
      const block = html.slice(start, next === -1 ? html.length : next);
      assertEqual(
        (block.match(/class="cfg-group"/g) || []).length,
        1,
        `面板 ${match[1]} 里应恰好一组配置：多了说明上一个面板少了闭合标签，后面的被嵌进去了`,
      );
    }
  });

  /* 管理后台的页签是**另一份文件**（`admin.html`）：A20 守的是医生端那份配置抽屉。
     管理员页签是"分区内的分类"，插错一个闭合 `</div>` 会让后面的面板整体嵌进前一个里，
     表现是"切到别的页签，内容区一片空白"，而所有 id 都在（A2 照样通过）。
     与医生端那条有一处**刻意的不同**：管理后台的「质控」面板放两张卡是有意的
     （形式类 / 内涵类各一件事），所以这里不照搬"恰好一组"，只要求一一对应、且面板不空。 */
  await test('A23 管理后台子页签：页签与面板一一对应，且每个面板都有内容', () => {
    const adminMarkup = readFileSync(join(ROOT, 'src', 'demo', 'admin.html'), 'utf8');
    const tabs = [...adminMarkup.matchAll(/data-cfg-tab="([^"]+)"/g)].map((match) => match[1]);
    const panes = [...adminMarkup.matchAll(/data-cfg-pane="([^"]+)"/g)].map((match) => match[1]);
    assert(tabs.length >= 5, `管理后台应有配置子页签，实际 ${tabs.length}`);
    assertEqual(tabs.slice().sort(), panes.slice().sort(), '每个子页签都应有对应面板（且没有多余面板）');
    for (const match of adminMarkup.matchAll(/data-cfg-pane="([^"]+)"/g)) {
      const start = match.index ?? 0;
      const next = adminMarkup.indexOf('data-cfg-pane="', start + 1);
      const block = adminMarkup.slice(start, next === -1 ? adminMarkup.length : next);
      assert(/class="cfg-group"/.test(block), `面板 ${match[1]} 里一张卡都没有：加了页签却忘了把内容搬进来`);
    }
  });

  /* id 唯一：在面板之间搬动元素（知识资产包从「质控」拆出独立页签正是如此）最容易留下的
     就是"旧位置那一行忘了删"。重复 id 不会让页面报任何错，`$('x')` 只是静静地拿到 DOM 里
     靠前的那一个 —— 于是状态行写到另一个页签的角落，而谁也不觉得这是 bug。 */
  await test('A24 管理后台 id 唯一：搬动面板不得留下重复 id', () => {
    const adminMarkup = readFileSync(join(ROOT, 'src', 'demo', 'admin.html'), 'utf8');
    const seen = new Set();
    const dup = new Set();
    for (const match of adminMarkup.matchAll(/id="([^"]+)"/g)) {
      if (seen.has(match[1])) dup.add(match[1]);
      seen.add(match[1]);
    }
    assertEqual([...dup], [], `以下 id 在 admin.html 里出现了多次：${[...dup].join(' / ')}`);
  });

  /* "界面上能改的字段"与"保存时读回来的字段"是两份清单，它们必须对得上。
     对不上的表现是"改了、保存之后面貌依旧"—— 看起来像没保存成功，实际是被丢掉了；
     而且它不会让任何东西报错（包写得进去、校验也过得去），只能在这里钉住。 */
  await test('A27 模板编辑器：界面上能改的每一类字段，保存时都必须被读回来', () => {
    const adminScript = readFileSync(join(ROOT, 'src', 'demo', 'admin.js'), 'utf8');
    const rendered = new Set([...adminScript.matchAll(/data-tpl-input="slot:([a-zA-Z]+):/g)].map((match) => match[1]));
    const readForm = adminScript.slice(
      adminScript.indexOf('function readTplEditForm'),
      adminScript.indexOf('function renderTplCreateForm'),
    );
    const handled = new Set([...readForm.matchAll(/field === '([a-zA-Z]+)'/g)].map((match) => match[1]));
    assert(rendered.size >= 6, `渲染侧应有多类可编辑字段，实际：${[...rendered].join(' / ')}`);
    for (const field of rendered) {
      assert(handled.has(field), `界面上能改的「${field}」在 readTplEditForm 里没有分支：那会表现成"改了、保存后没变"`);
    }
    /* 章节标题与编码走的是另一条分支（`path.startsWith('sec:')` 之后按 field 分），
       它们不在上面那份 `slot:` 清单里，必须单独看一眼：漏读的表现是"改了章节名，
       保存后又变回原样"，而这一页的所有东西都还在，看起来像没保存成功。 */
    assert(
      /field === 'title'/.test(readForm) && /field === 'code'/.test(readForm),
      '章节标题与编码也要读回（章节编码是跨文书比对的锚点）',
    );
  });

  await test('A28 医生端徽标：从系统带入的值要说清"从哪儿带的"，与"模板带入"分得开', () => {
    /* 这两档徽标的渲染在共用的 `/doc-view.js` 里：管理后台的模板预览画的是同一个函数，
       所以读它 —— 只读医生端那一份的话，这里的断言就守不住预览了 */
    const uiScript = readFileSync(DOC_VIEW_JS, 'utf8');
    /* 三档必须分开写：`origin` 都是 system，但一件事是"这一格已经把系统里的值填进去了"，
       另一件是"模板只给了一个空骨架"。合成一个名字，医生要么以为姓名没带进来，
       要么以为骨架就是内容 —— 这是口径问题，不是措辞问题。 */
    assert(/item\.fromRef/.test(uiScript), '界面要读服务端下发的来源（fromRef）');
    assert(/fromLabel/.test(uiScript), '显示的是人话名称（fromLabel），而不是 patient.nameMasked 这类路径');
    assert(/模板带入/.test(uiScript), '"模板带入"这一档仍然在（三档要分得开）');
  });

  /* 文书的新建 / 编辑是**弹层**（抽屉）。它必须是原生 `<dialog>` + `showModal()`：
     遮罩、Esc、焦点困在框内、top layer 都由内核给。自造的那套浮层总会漏掉其中一条
     （最常见的是 Esc 与焦点归还），而"看起来能用"会一直用到有人被它卡住。
     还有一条更实际的原因：抽屉打开期间要锁住背景页滚动，不锁就表现为
     "在抽屉里滚，后面的页面跟着动"。 */
  await test('A26 文书新建/编辑是原生 <dialog> 弹层：遮罩·Esc·滚动锁·焦点归还都到位', () => {
    const adminMarkup = readFileSync(join(ROOT, 'src', 'demo', 'admin.html'), 'utf8');
    const adminScript = readFileSync(join(ROOT, 'src', 'demo', 'admin.js'), 'utf8');
    const adminCss = readFileSync(join(ROOT, 'src', 'demo', 'ui.css'), 'utf8');
    assert(/<dialog[^>]*id="tplDrawer"/.test(adminMarkup), '管理后台应有文书抽屉 <dialog id="tplDrawer">');
    /* 模板预览画的是医生端那一套正文（同一份渲染、同一份样式）：脚本没引上就只剩空壳 */
    assert(/<script[^>]+src="\/doc-view\.js"/.test(adminMarkup), '管理后台应引用 /doc-view.js（预览与正文共用同一份渲染）');
    assert(/showModal\(\)/.test(adminScript), '抽屉必须用 showModal()（top layer，才自带遮罩与 Esc）');
    assert(/id="tplDrawerClose"/.test(adminMarkup), '抽屉应有可见的关闭入口（不能只靠 Esc）');
    /* 滚动锁必须有、也必须在关闭时解开：只加不解，关掉抽屉后整页都滚不动 */
    assert(/classList\.add\('drawer-open'\)/.test(adminScript), '打开抽屉要锁住背景页滚动');
    assert(/classList\.remove\('drawer-open'\)/.test(adminScript), '关闭抽屉要解开背景页滚动锁');
    /* 焦点归还：关闭后焦点应回到打开它的那个按钮，否则键盘用户要从头 tab 一遍 */
    assert(/TPL_DRAWER_OPENER\.focus/.test(adminScript), '关闭抽屉后焦点要还给触发按钮');
    /* 关闭清理统一挂在 close 事件上：Esc 关的与点按钮关的都该走同一处 */
    assert(/addEventListener\('close'/.test(adminScript), '关闭后的清理应挂在 dialog 的 close 事件上');
    /* 点遮罩（抽屉外那层阴影）要能关掉当前这一层：内核的 <dialog> 不提供这个行为，
       不自己接上就是"点阴影什么都不会发生"。判定必须按坐标（框外才算遮罩），
       只判 target 会把"点在抽屉自己的内边距上"也一起关掉。 */
    assert(
      /getBoundingClientRect\(\)/.test(adminScript) && /addEventListener\('click'/.test(adminScript),
      '点遮罩关闭要自己接（并按坐标判定"点在框外"）',
    );
    /* 两级抽屉与方向：**默认在右**（一级），二级 `.from-left` 在**左**。
       两级对开是"从表格点进某一条"这件事的排布方式 —— 两级贴同一边会互相盖住，
       而"我在哪张表里"和"我在改哪一条"必须同时看得见。 */
    assert(
      /<dialog class="drawer from-left" id="tplDrawer2"/.test(adminMarkup),
      '管理后台应有二级抽屉 <dialog class="drawer from-left" id="tplDrawer2">（从左侧滑入）',
    );
    assert(
      /dialog\.drawer\s*\{\s*position:\s*fixed;\s*right:\s*0;[^}]*left:\s*auto;/.test(adminCss),
      '抽屉默认应从右侧弹出（一级）',
    );
    assert(
      /@keyframes drawer-in \{ from \{ transform: translateX\(100%\); \}/.test(adminCss)
      && /@keyframes drawer-in-left \{ from \{ transform: translateX\(-100%\); \}/.test(adminCss),
      '一级从右滑入、二级从左滑入（两级动画各一条）',
    );
  });

  /* 「模板库」是管理后台里唯一一张"会一直长"的表（文书只会越建越多），
     所以它三件事一起验：表格展示、按名称查询、分页。
     这三件都是**纯前端**的：目录本来就在 `/api/state` 下发的 `templateCatalog` 里，
     查询与翻页只重画这一页的表，不产生任何请求 —— 断言因此落在"状态 + 标记 + 样式"上。 */
  await test('A27 模板库：表格展示 · 按名称查询 · 分页（查询与翻页都在前端，不产生请求）', () => {
    const adminMarkup = readFileSync(join(ROOT, 'src', 'demo', 'admin.html'), 'utf8');
    const adminScript = readFileSync(join(ROOT, 'src', 'demo', 'admin.js'), 'utf8');
    const adminCss = readFileSync(join(ROOT, 'src', 'demo', 'ui.css'), 'utf8');
    /* 面板切片：查询条要落在「模板库」那一页里，摆到别的页签上等于没有 */
    const pane = adminMarkup.slice(
      adminMarkup.indexOf('data-cfg-pane="templates"'),
      adminMarkup.indexOf('data-cfg-pane="packs"'),
    );
    assert(pane.includes('id="tplSearchName"'), '「模板库」面板里应有按模板名称查询的输入框');
    assert(pane.includes('id="btnCreateTemplate"'), '「模板库」面板里应有新建文书入口');
    /* 表达式的入口**不**在这一页：2026-10-16 起它是「基础数据 → 表达式控件」子页签（见下面那条）。
       留一个按钮在这里就出现两个入口，而两处迟早会只改到其中一处。 */
    assert(!pane.includes('id="btnOpenExpressions"'), '「模板库」面板里不应再有表达式控件入口（它已是「基础数据」的子页签）');
    assert(
      adminMarkup.slice(
        adminMarkup.indexOf('data-admin-view-pane="master"'),
        adminMarkup.indexOf('data-admin-view-pane="accounts"'),
      ).includes('data-cfg-tab="expressions"'),
      '表达式控件应作为「基础数据」的一个子页签',
    );
    assert(/<table class="mini tpl-table">/.test(adminScript), '模板库应以表格渲染');
    assert(/<th>模板名称<\/th>/.test(adminScript), '表里应有「模板名称」这一列');
    assert(/function tplRowHtml\(item\)/.test(adminScript) && /<tr class="tpl-row/.test(adminScript), '一行一份文书（表格行）');
    /* 查询：状态 + 边打边筛 + 筛空要单独说清"是筛没了" */
    assert(/let TPL_NAME_FILTER = ''/.test(adminScript), '查询条件要有状态（切走再回来不丢）');
    assert(/el\.id === 'tplSearchName'/.test(adminScript), '查询框要接上输入事件');
    assert(/没有名称含/.test(adminScript), '筛空了要说清"是筛没了"而不是"库里没有"');
    /* 分页：页码 + 每页条数 + 上一页/下一页 + 越界夹回 */
    assert(/let TPL_PAGE = 1/.test(adminScript) && /const TPL_PAGE_SIZE = \d+/.test(adminScript), '分页要有页码与每页条数（模块级状态）');
    assert(/data-tpl-page=/.test(adminScript), '分页要有上一页 / 下一页按钮');
    assert(/el\.dataset\.tplPage/.test(adminScript), '翻页按钮要接上事件');
    assert(/TPL_PAGE = pageCount/.test(adminScript), '页码越界要夹回来（删掉本页最后一份不该显示空表）');
    assert(
      /function tplGotoItemPage\(itemId\)/.test(adminScript) && /tplGotoItemPage\(String\(r\.data\.itemId\)\)/.test(adminScript),
      '新建之后页码要挪到新增的那一份上（否则超过一页就是"建完了、列表里看不见它"）',
    );
    assert(/\.tpl-pager\s*\{/.test(adminCss), '分页条要有样式');
    /* 查询条件一改就回第 1 页：留在第 3 页上看"筛出来的第 3 页"，多数时候是一片空白 */
    const searchAt = adminScript.indexOf("el.id === 'tplSearchName'");
    assert(
      adminScript.slice(searchAt, searchAt + 300).includes('TPL_PAGE = 1'),
      '改查询条件应回到第 1 页',
    );
    /* 查询框要放得下整句提示语（"按名称筛选（不区分大小写）"）：窄了会被截成
       "按名称筛选（不区分大…"，提示语被截等于这一格没说明白自己要什么。 */
    const searchWidth = /\.tpl-toolbar input\[type="search"\]\s*\{\s*width:\s*(\d+)px/.exec(adminCss);
    assert(
      searchWidth !== null && Number(searchWidth[1]) >= 240,
      `查询框宽度要放得下整句提示语（≥240px），实际：${searchWidth ? `${searchWidth[1]}px` : '未设定宽度'}`,
    );
  });

  /* 医学表达式控件表格页（「基础数据 → 表达式控件」子页签）与模板库那张表是同一件事的两份：
     两边都是"会一直长"的清单，所以查询（控件名称）与分页必须一起有，
     做法也要一样 —— 缺一边会让人以为那一边"少了什么"。
     它挂在基础数据那一组里（与科室字典 / 文书类型 / 判定方式并列），而不是模板页上的一个弹层：
     控件**比模板更基础**（先有控件，才谈得上一份文书去引用它）。 */
  await test('A28 表达式控件表格页（基础数据子页签）：按控件名称查询 + 分页（与模板库同一套做法）', () => {
    const adminMarkup = readFileSync(join(ROOT, 'src', 'demo', 'admin.html'), 'utf8');
    const adminScript = readFileSync(join(ROOT, 'src', 'demo', 'admin.js'), 'utf8');
    /* 面板切片：新建入口与表格容器要落在「表达式控件」那一页里，摆到别的页签上等于没有 */
    const pane = adminMarkup.slice(
      adminMarkup.indexOf('data-cfg-pane="expressions"'),
      adminMarkup.indexOf('data-cfg-pane="predicates"'),
    );
    assert(pane.includes('id="btnNewExpression"'), '「表达式控件」面板里应有新建入口');
    assert(pane.includes('id="exprCatalogBody"'), '「表达式控件」面板里应有控件表挂载的容器');
    assert(/let EXPR_NAME_FILTER = ''/.test(adminScript), '控件表格页要有查询状态');
    assert(/let EXPR_PAGE = 1/.test(adminScript) && /const EXPR_PAGE_SIZE = \d+/.test(adminScript), '控件表格页要有页码与每页条数');
    assert(/id="exprSearchName"/.test(adminScript), '控件表格页要有按控件名称查询的输入框');
    assert(/el\.id === 'exprSearchName'/.test(adminScript), '查询框要接上输入事件');
    assert(/data-expr-page=/.test(adminScript) && /el\.dataset\.exprPage/.test(adminScript), '控件表格页要有上一页 / 下一页并能翻');
    assert(/EXPR_PAGE = pageCount/.test(adminScript), '控件表页码越界要夹回来');
    assert(
      /function exprGotoItemPage\(itemId\)/.test(adminScript) && /exprGotoItemPage\(String\(r\.data\.itemId\)\)/.test(adminScript),
      '新建控件后页码要挪到它那一页',
    );
    /* 查询条必须是**常驻的壳**、表在它下面单独一块：输入框若跟着表一起重画，
       打一个字就丢焦点、光标跳回开头，"边打边筛"当场失效。 */
    assert(
      /function renderExprCatalogShell\(\)/.test(adminScript)
      && /id="exprCatalogTable"/.test(adminScript)
      && /const box = \$\('exprCatalogTable'\)/.test(adminScript),
      '查询条是常驻的壳，只有下面那张表被重画（否则边打边筛会丢焦点）',
    );
    assert(/没有名称含/.test(adminScript), '控件表筛空了要说清"是筛没了"而不是"控件没了"');
  });

  /* 专科控件（「基础数据 → 专科控件」）紧挨着「表达式控件」摆，正因为两者最容易混：
     那一页是**公式**（这个值怎么算 —— 标量、无界面），这一页是**控件**（长什么样、填什么 ——
     有结构、有界面）；控件里若有一格要算，那一格引用的是表达式控件里的那一份。
     这一页**不预置内置控件**（随产品发版的是形状），所以它的空态必须说清"空是正常的" ——
     否则看起来像少装了一个包。查询与分页与模板库 / 表达式控件同一套。 */
  await test('A35 基础数据·专科控件：页签紧随表达式控件；清单按形状展示；不预置内置控件（空态要说清）', () => {
    const adminMarkup = readFileSync(join(ROOT, 'src', 'demo', 'admin.html'), 'utf8');
    const adminScript = readFileSync(join(ROOT, 'src', 'demo', 'admin.js'), 'utf8');
    /* 位置：页签就在「表达式控件」与「判定方式」之间 —— 两页的分工要摆在眼前，藏到别处就等于没写 */
    const tabs = [...adminMarkup.matchAll(/data-cfg-tab="([^"]+)"/g)].map((match) => match[1]);
    assertEqual(
      tabs.indexOf('ctrlDefs'),
      tabs.indexOf('expressions') + 1,
      '「专科控件」页签要紧随「表达式控件」之后',
    );
    const pane = adminMarkup.slice(
      adminMarkup.indexOf('data-cfg-pane="ctrlDefs"'),
      adminMarkup.indexOf('data-cfg-pane="predicates"'),
    );
    assert(pane.includes('id="ctrlCatalogBody"'), '「专科控件」面板里应有清单挂载的容器');
    assert(
      pane.includes('id="ctrlCatalogStatus"'),
      '「专科控件」面板里应有自己的状态行（写在别的页签上等于写在看不见的地方）',
    );
    /* 清单一律按条目类别取：它与表达式控件同在一份 `templateCatalog` 里，混了就会把公式当控件列出来 */
    assert(
      /function ctrlCatalogItems\(\)/.test(adminScript) && /item\.itemType === 'control'/.test(adminScript),
      '清单要按 `itemType === control` 取（与表达式控件同在一个目录里）',
    );
    /* 形状要说人话：`scale` / `series` 这种词读不出来"这一条会被画成什么" */
    assert(/const CTRL_SHAPE_LABELS = \{/.test(adminScript), '形状要有中文名（形态是这一页的主要信息）');
    assert(/<th>形态<\/th>/.test(adminScript), '表里应有「形态」这一列');
    /* 影像（`image`）这一档：形状是**闭集**，加一档就必须同时在两处落地 ——
       管理端要认得它的中文名与"这一格只收地址"，正文要有一支渲染器把它画成图。
       只改一处的结果是"配得出来、填不进去"或"填得进去、纸面上只剩一串 URL"，两头都不报错。 */
    assert(/'影像'/.test(adminScript), '形状要有「影像」这一档（否则它在界面上选不出来）');
    assert(
      /text（地址）/.test(adminScript),
      '影像格的类型要锁成 text（地址）：配成数值格时写路径会当场拒，而医生只看到"填不进去"',
    );
    assert(
      /item\.shape === 'image'/.test(script),
      '正文里影像要有自己的画法（形状决定渲染器：没有这一支，画出来与量表长得一样）',
    );
    /* 地址是**病历内容**（外部数据），会被放进 `img[src]` 与 `a[href]`：
       `javascript:` 一类的地址写进 href 就是一处"点一下病历就执行"的脚本 */
    assert(
      /function safeImageUrl\(/.test(script),
      '影像地址要过协议白名单（只认 http(s) 与站内路径）',
    );
    /* 查询与分页：与模板库 / 表达式控件同一套（同一套状态命名、同一个 `.tpl-pager`） */
    assert(/let CTRL_NAME_FILTER = ''/.test(adminScript), '专科控件表要有查询状态');
    assert(
      /let CTRL_PAGE = 1/.test(adminScript) && /const CTRL_PAGE_SIZE = \d+/.test(adminScript),
      '专科控件表要有页码与每页条数',
    );
    assert(/el\.id === 'ctrlSearchName'/.test(adminScript), '查询框要接上输入事件');
    assert(
      /data-ctrl-page=/.test(adminScript) && /el\.dataset\.ctrlPage/.test(adminScript),
      '专科控件表要有上一页 / 下一页并能翻',
    );
    assert(/CTRL_PAGE = pageCount/.test(adminScript), '专科控件表页码越界要夹回来（删掉本页最后一条不该显示空表）');
    /* 空态：这一页**天然**是空的（不预置内置控件），话要说清"为什么空"，而不是像别的表那样写"去建一个" */
    assert(/不预置内置控件/.test(adminScript), '空态要说清"本系统不预置专科控件"');
    assert(
      /setCtrlCatalogStatus/.test(adminScript),
      '专科控件的开关回话要落在这一页的状态行上（与模板 / 表达式各回各页同一条规则）',
    );
    /* 编辑器：页头要有新建入口（不预置内置控件，就只能自建），表单走二级抽屉（与表达式控件同一层），
       增删改各走自己的接口 —— 控件与表达式控件不是同一件事，借用对面的接口会让两件事迟早混成一件。 */
    assert(pane.includes('id="btnNewControl"'), '「专科控件」面板里应有新建入口（不预置内置控件，就只能自建）');
    assert(/function renderCtrlForm\(\)/.test(adminScript), '要有控件表单（新建与编辑共用一份）');
    assert(/function readCtrlForm\(\)/.test(adminScript), '表单要能被读回（少读一格，一保存就把它清掉了）');
    assert(/data-ctrl-submit/.test(adminScript) && /data-ctrl-addfield/.test(adminScript), '表单要能提交、能加格');
    assert(
      /'\/api\/control-item-create'/.test(adminScript) && /'\/api\/control-item-update'/.test(adminScript)
      && /'\/api\/control-item-delete'/.test(adminScript),
      '增删改各走自己的接口（控件与表达式控件不是同一件事）',
    );
    /* 改到字段或形状要**问一次**：服务端会把定义升版，而升版的后果要说在人眼前 */
    assert(/ctrlSemanticSignature/.test(adminScript), '字段语义有改动时要问一次（升版是显式后果）');
  });

  /* 「规则库」也是"会一直长"的表（本院会一条条往上加），所以与模板库同一套口径：
     表格展示、查询、分页都**在界面上完成**（目录本来就在 `/api/state` 里）。
     这里额外钉三件与规则有关的事：
     ① 参数表单由**服务端下发的规格**生成，前端不许写死谓词名与参数表；
     ② 级别只有 info / warn（block 意味着卡住流程，不由界面给这一档）；
     ③ 读回表单要读全 —— 少读一格，点一次保存就把它静默清掉了。 */
  await test('A33 规则库：表格 · 按标题或规则号查询 · 分页 · 条目编辑抽屉（参数表单照服务端下发的规格生成）', () => {
    const adminMarkup = readFileSync(join(ROOT, 'src', 'demo', 'admin.html'), 'utf8');
    const adminScript = readFileSync(join(ROOT, 'src', 'demo', 'admin.js'), 'utf8');
    /* 面板切片：查询条与新建入口要落在「规则库」那一页里，摆到别的页签上等于没有 */
    const paneStart = adminMarkup.indexOf('data-cfg-pane="packs"');
    const pane = adminMarkup.slice(paneStart, adminMarkup.indexOf('data-cfg-pane="qc"'));
    assert(pane.includes('id="ruleSearchKeyword"'), '「规则库」面板里应有查询框');
    assert(pane.includes('id="btnCreateRule"'), '「规则库」面板里应有新建规则入口');
    assert(!pane.includes('id="qcPackLoad"'), '不应再有整包载入入口（规则只在库里新建与修改，不从别处贴 JSON 搬进来）');
    assert(!adminScript.includes('btnLoadPack') && !adminScript.includes('qcPackJson'),
      '「贴 JSON 载入包」这条路要彻底撤掉（按钮、输入框、处理分支都不留）');
    /* 表格：一行一条规则，且"按什么判、参数多少"要单独成列 */
    assert(/<table class="mini tpl-table">/.test(adminScript), '规则库应以表格渲染');
    assert(/<th>判定方式 \/ 参数<\/th>/.test(adminScript), '表里应有「判定方式 / 参数」这一列（否则两行标题一样、参数不同就分不清）');
    assert(/function ruleRowHtml\(rule\)/.test(adminScript) && /<tr class="tpl-row/.test(adminScript), '一行一条规则（表格行）');
    /* 查询：状态 + 边打边筛 + 筛空单独说清 */
    assert(/let RULE_KEYWORD_FILTER = ''/.test(adminScript), '查询条件要有状态（切走再回来不丢）');
    assert(/el\.id === 'ruleSearchKeyword'/.test(adminScript), '查询框要接上输入事件');
    assert(/没有标题或规则号含/.test(adminScript), '筛空了要说清"是筛没了"而不是"库里没有"');
    /* 分页：与模板库同一套（页码 + 每页条数 + 翻页 + 越界夹回 + 新建后挪到它那一页） */
    assert(/let RULE_PAGE = 1/.test(adminScript) && /const RULE_PAGE_SIZE = \d+/.test(adminScript), '分页要有页码与每页条数（模块级状态）');
    assert(/data-rule-page=/.test(adminScript) && /el\.dataset\.rulePage/.test(adminScript), '分页要有上一页 / 下一页并接上事件');
    assert(/RULE_PAGE = pageCount/.test(adminScript), '页码越界要夹回来（删掉本页最后一条不该显示空表）');
    assert(
      /function ruleGotoItemPage\(itemId\)/.test(adminScript) && /ruleGotoItemPage\(String\(r\.data\.itemId\)\)/.test(adminScript),
      '新建之后页码要挪到新增的那一条上（否则超过一页就是"建完了、列表里看不见它"）',
    );
    /* 条目编辑：一级抽屉 + 四类操作都真的接了事件 */
    assert(/id="ruleDrawer"/.test(adminMarkup), '条目编辑走抽屉（与模板库同一套做法）');
    assert(/el\.id === 'ruleDrawerClose'/.test(adminScript) && /el\.dataset\.ruleCancel/.test(adminScript), '抽屉要能关（关闭按钮与取消）');
    assert(/el\.dataset\.ruleEdit/.test(adminScript), '行尾要有「编辑」并接上事件');
    assert(/el\.dataset\.ruleDelete/.test(adminScript), '行尾要有「删除」并接上事件');
    assert(/el\.dataset\.ruleSubmit/.test(adminScript), '抽屉里要有保存 / 新建并接上事件');
    assert(
      /\/api\/rule-item-create/.test(adminScript) && /\/api\/rule-item-update/.test(adminScript) && /\/api\/rule-item-delete/.test(adminScript),
      '三个条目接口都要真的被界面调用（否则按钮点了没反应）',
    );
    /* 参数表单照**服务端下发的规格**生成：前端不许自己抄一份谓词清单与参数表 */
    assert(/S\.qcPredicates/.test(adminScript), '判定方式与参数规格要读服务端下发的那一份');
    assert(
      /function ruleParamsHtml\(conditionId, params\)/.test(adminScript) && /data-rule-arg/.test(adminScript),
      '参数区要按规格生成控件并接上读回（要填哪几格由**被引用的那条判定方式**的参数表决定）',
    );
    /* 自定义条件（条件树）：构造器的字段与算子**一个都不许写死在界面里** ——
       写死的那份与内核不一致时，表现是"界面能拼、引擎不认"，而它只会在有人真的拼了一条之后才暴露。
       这里只点几档最容易手滑写死的算子名：字段名（如 `docType` / `sectionCode`）在别的功能里
       本来就是正当的关键字（模板编辑、文书类型字典），按字符串断言会把它们一起误伤。 */
    for (const op of ['older-than-hours', 'missing-pattern', 'empty-with-tag', 'length-less-than', 'not-contains']) {
      assert(
        !adminScript.includes(`'${op}'`) && !adminScript.includes(`"${op}"`),
        `界面脚本里不许写死算子 ${op}（写死的那份与引擎不一致时，界面能拼、引擎不认）`,
      );
    }
    assert(/S\.qcCondition/.test(adminScript), '字段表与算子表要读服务端下发的那一份');
    assert(
      /function conditionDraftFromCondition\(condition\)/.test(adminScript)
      && /dataset\.condField/.test(adminScript)
      && /dataset\.condOp/.test(adminScript),
      '条件构造器要照规格长成「字段 · 算子 · 取值」三格并接上读回',
    );
    assert(
      /function readConditionDraft\(\)/.test(adminScript) && /data-cond-logic/.test(adminScript),
      '构造器要能整体读回（含"满足全部 / 满足任一"那一格）',
    );
    assert(/data-cond-add/.test(adminScript) && /data-cond-del/.test(adminScript), '构造器要能加一条 / 删一条条件');
    assert(
      /conditionPending/.test(adminScript) && /至少要有一条/.test(adminScript),
      '一条条件都没填满时要在提交前拦一次（否则会存下一条"永远不命中"的规则，而它看起来一切正常）',
    );
    assert(
      /conditionLocked/.test(adminScript) && /嵌套/.test(adminScript),
      '树里已有嵌套条件时要锁住并说清原因（重画会把它摊平，而摊平会静默改变这条规则的含义）',
    );
    assert(
      !/'document-time-limit'/.test(adminScript) && !/'text-missing-time'/.test(adminScript),
      '前端不得写死任何谓词名 —— 写死的表现是"界面能选、引擎不认"，而那要等有人真的点了它才暴露',
    );
    /* 级别只有 info / warn：block 是"卡住流程"，界面不许给这一档 */
    assert(/<option value="warn"/.test(adminScript), '级别下拉要有 warn');
    assert(!/value="block"[^>]*>block/.test(adminScript), '级别下拉不许出现 block');
    /* 读回表单：能改的每一格都要读回来（少读一格，保存一次就把它清掉了） */
    assert(/function readRuleForm\(\)/.test(adminScript) && /dataset\.ruleInput/.test(adminScript), '表单要整体读回（含判定方式、参数与文案）');
    assert(
      /function renderRuleConditionSwitch/.test(adminScript) && /dataset\.ruleInput === 'conditionId'/.test(adminScript),
      '换判定方式要重画参数区（只重画参数区：重画整屏会把刚填的标题与文案一起清掉）',
    );
  });

  /* 「判定方式」现在是**一张表两组**：内置判定方式（随应用交付、只读）/ 本院自建（可增删改）。
     原先还有一组"内核判法（6 种只读卡片）"：它与"内置判定方式"是同一件事的两处摆法
     （6 条逐条对应），已经并进那张表 —— 规则库引用的是**判定方式**，
     界面上再单摆一层"内核判法"，人会以为造规则要经过"先选判法、再选引用谁"两个选择。

     规则库那边是同一件事：抽屉里的"判定方式"下拉直接选一条判定方式（或"就地拼一条"），
     承载它的那**一种判法**由参数类型结构性认出来（`condition-ref`），界面不写判法名。

     这条用例守五件最容易做歪的事：
     ① 撤掉"内核判法"这一组，但**别把它的价值一起撤掉**：有哪几条、各要什么参数、有没有人在用；
     ② 不许把"内核判法"这一层再以别的名字摆回来（文案里、下拉里、说明里）；
     ③ 界面不许把判定方式清单、字段表、算子表抄一份（抄的那份与引擎不一致时，表现是"界面能选、引擎不认"）；
     ④ 这一页的说明文字已撤掉（2026-10-17）：表的列与抽屉里的话够用，不再摆那一大段；
     ⑤ 两张表都要列出来：它们是"能拼什么"的全部答案，不列就只能靠猜。 */
  await test('A34 基础数据·判定方式：内置只读 + 本院自建（一张表两组，列出字段表与算子表），规则库按判定方式造规则', () => {
    const adminMarkup = readFileSync(join(ROOT, 'src', 'demo', 'admin.html'), 'utf8');
    const adminScript = readFileSync(join(ROOT, 'src', 'demo', 'admin.js'), 'utf8');
    const adminCss = readFileSync(join(ROOT, 'src', 'demo', 'ui.css'), 'utf8');
    /* 面板切片：它要落在「基础数据」那个分区里，与另外两个子页签并列 */
    const master = adminMarkup.slice(
      adminMarkup.indexOf('data-admin-view-pane="master"'),
      adminMarkup.indexOf('data-admin-view-pane="accounts"'),
    );
    /* 页面上的字才作数：注释里叙述"这一组原来叫什么"是正常的（同 A29 对 JS 注释的处置） */
    const masterText = master.replace(/<!--[\s\S]*?-->/g, '');
    assert(master.includes('data-cfg-tab="predicates"'), '「基础数据」里应有「判定方式」子页签');
    assert(master.includes('data-cfg-pane="predicates"'), '子页签要有对应的面板');
    /* 一张表两组：容器、计数格、刷新按钮（"谁在用它"会随规则库变化，得能刷） */
    assert(master.includes('id="conditionLibraryBody"'), '面板里要有判定方式那张表的容器');
    assert(master.includes('id="conditionLibChip"'), '要有一格显示"几条判定方式 · 分布在几个包"');
    assert(master.includes('id="conditionLibRefresh"'), '面板里要有刷新按钮（"谁在用它"会随规则库变化）');
    /* 撤掉的是"内核判法"这一层，不是它的价值：页面上仍要说清"哪一类改得了" */
    assert(
      !/内核判法/.test(masterText) && !/id="predicateBody"/.test(master) && !/id="predicateRefresh"/.test(master)
      && !/id="predicateChip"/.test(master) && !/id="predicateSummary"/.test(master),
      '页面上不该再有"内核判法"这一组（它与内置判定方式是同一件事的两处摆法），它的容器 / 计数 / 刷新按钮一并撤掉',
    );
    assert(!/id="predicate(Save|Add|New)"/.test(master), '判定方式页不许再有"内核判法"那一层的新增入口（判定方式本身在下面那张表里建）');
    assert(
      !/库级资产/.test(masterText) && !/一律可改可删/.test(masterText) && !/复制用于改口径前先留一份/.test(masterText),
      '这一页不再摆那一大段说明文字（判定方式的交付形态与"复制用来干什么"由表的列与抽屉里的话承担）',
    );
    /* 自定义条件的两张表：字段决定"读什么"、算子决定"怎么算"。
       它们是"能拼什么"的全部答案 —— 不列出来，使用者只能在抽屉里一个个试，
       而"这里没有我要的选项"与"这件事做不了"看起来一模一样。 */
    assert(master.includes('id="conditionBody"'), '面板里要有字段 / 算子清单的容器');
    assert(master.includes('id="conditionChip"'), '要有一格显示"几个字段 · 几个算子"');
    assert(/function renderConditionCatalog\(\)/.test(adminScript), '要有字段表与算子表的渲染');
    assert(
      /function conditionCatalogOf\(\)/.test(adminScript) && /S\.qcCondition/.test(adminScript),
      '两张表要读服务端下发的 `qcCondition`，不在前端另抄一份',
    );
    /* 渲染：数据来自服务端下发的那一份，"谁在用它"来自规则目录（不另开接口） */
    assert(/function renderPredicates\(\)/.test(adminScript), '要有这一页的整页渲染');
    assert(
      /function renderPredicates\(\)[\s\S]{0,300}renderConditionLibrary\(\)/.test(adminScript),
      '整页渲染要把那张表画出来（表落在 `conditionLibraryBody` 里）',
    );
    assert(
      /function renderConditionLibrary\(\)[\s\S]{0,2400}<th>编码<\/th>/.test(adminScript)
      && !/item\.builtin/.test(adminScript) && !/conditionItemsOfPackOfState/.test(adminScript),
      '表要**一张**、不按包分栏：判定方式是库级资产（不属于任何包），所以脚本里既不该有"是不是内置"、'
        + '也不该有按包过滤判定方式这种判断（引用方在哪个包由"谁在用它"那一列说）',
    );
    assert(/S\.qcPredicates/.test(adminScript), '判法与参数规格要读服务端下发的清单（承载判定方式的那种判法也要从这里认出来）');
    assert(
      /knowledgePacks \|\| \{\}\)\.rules/.test(adminScript) && /条规则引用/.test(adminScript),
      '"谁在用它"要来自规则目录（不另开一个接口去问）',
    );
    assert(/function conditionParamRange\(spec\)/.test(adminScript), '参数的取值域要按规格渲染（下拉列取值、数字写清必填与否）');
    /* 界面不写死任何判法：七种都不许出现在界面脚本里。
       （第七种是条件树：界面要在参数区认出它来，认的是**参数类型** `condition`，
       不是判法名本身 —— 前者是"控件长什么样"，后者才是"按什么判"。） */
    for (const kind of [
      'text-missing-time', 'tagged-empty-text', 'placeholder-residue',
      'document-time-limit', 'visit-doc-interval', 'visit-doc-required', 'field-condition',
    ]) {
      assert(
        !adminScript.includes(`'${kind}'`) && !adminScript.includes(`"${kind}"`),
        `界面脚本里不许写死判法 ${kind}（写死的那份与引擎不一致时，界面能选、引擎不认）`,
      );
    }
    /* 切页签要按当前状态重画（计数跟着规则库走）；刷新按钮与同页另外两个按钮走同一条路径 */
    assert(/tab\.dataset\.cfgTab === 'predicates'[\s\S]{0,80}renderPredicates\(\)/.test(adminScript), '切到该页签要重画');
    assert(/el\.id === 'conditionLibRefresh'/.test(adminScript), '刷新按钮要接上事件');
    assert(/\.predicate-card\s*\{/.test(adminCss), '清单条目要有样式（每一组一块）');
    /* 本院自建那一组：同页上**可维护**的那一类 —— "多条规则共用同一套口径"的唯一出口。
       它得真的接上三条接口，否则界面只是一张好看的只读表。 */
    assert(
      master.includes('id="conditionLibraryBody"') && master.includes('id="btnCreateCondition"'),
      '「判定方式」页要有那张表与新建入口',
    );
    assert(/id="conditionDrawer"/.test(adminMarkup), '判定方式的新建 / 编辑同样走抽屉（单开一个，不与规则抽屉复用）');
    assert(
      /\/api\/qc-condition-create/.test(adminScript)
      && /\/api\/qc-condition-update/.test(adminScript)
      && /\/api\/qc-condition-delete/.test(adminScript),
      '本院自建的三个接口都要真的被界面调用（否则按钮点了没反应）',
    );
    assert(
      /function renderConditionLibrary\(\)/.test(adminScript) && /S\.qcConditions/.test(adminScript),
      '那张表要读服务端下发的判定方式目录（含"谁在用它"），不在前端另算一份',
    );
    assert(
      /function conditionUsedByHtml\(/.test(adminScript) && /function ruleConditionOptionsHtml\(/.test(adminScript),
      '引用面要渲染出来（选的那一刻就要看得见"改一处会影响哪几条"），规则里也要能挑到它',
    );
    /* 规则库按判定方式重建（这一段守的就是"不再经过内核判法这一层"）：
       ① 下拉里列的是**本包里的**判定方式，外加"就地拼一条"；
       ② 承载它的那一种判法**结构性**认出来（认的是参数类型 `condition-ref`），不写判法名；
       ③ 表里那一列显示判定方式的名字 + 实参，而不是判法名。 */
    assert(
      /function ruleConditionOptionsHtml\(selected\)/.test(adminScript)
      && /就地拼一条/.test(adminScript),
      '规则抽屉的"判定方式"下拉要列**库里那几条**与"就地拼一条"：'
        + '判定方式是库级资产、任何包的规则都能引用它，所以这里不按包过滤',
    );
    assert(
      /function conditionKindOf\(\)[\s\S]{0,400}condition-ref/.test(adminScript),
      '承载判定方式的那一种判法要**结构性**认出来（参数类型 `condition-ref`），不写判法名',
    );
    assert(
      /function ruleConditionCellHtml\(rule\)/.test(adminScript) && /目录里已经没有这条判定方式/.test(adminScript),
      '规则表那一列要显示判定方式的名字与实参；目录里找不到时照实说，不悄悄显示一个裸编码',
    );
    assert(
      /legacyKind/.test(adminScript) && /不再作为可选/.test(adminScript),
      '旧的"内核判法 + 参数"规则打开时要说明白为什么上面那一格是空的（否则看起来像"参数丢了"）',
    );
    /* 判定方式的**参数与实参**（T1）：参数表在条件抽屉里维护，实参在规则抽屉里按它渲染。
       三处都要钉住，否则"参数配了但不生效"会以"界面看着一切正常"的样子留下来。 */
    assert(
      /data-cond-param-add/.test(adminScript) && /function readConditionParams\(/.test(adminScript)
      && /function conditionParamRowsHtml\(/.test(adminScript),
      '条件抽屉里要有参数表（加 / 删 / 逐格改），并且**能读回**（读不回 = 保存一次就把它清掉）',
    );
    assert(
      /function ruleParamsHtml\(conditionId, params\)/.test(adminScript) && /function conditionArgsHtml\(/.test(adminScript)
      && /data-rule-arg/.test(adminScript),
      '规则抽屉里要有"判定方式的实参"那一块：控件按**被引用的那条**的参数表生成，并单独读回',
    );
    assert(
      /dataset\.ruleInput === 'conditionId'[\s\S]{0,220}renderRuleConditionSwitch\(/.test(adminScript),
      '换了判定方式要**整块重画参数区**：不重画就会把"按上一条的参数表填的值"当成下一条的实参交上去',
    );
    assert(
      /dataset\.condlibEdit/.test(adminScript) && /dataset\.condlibCopy/.test(adminScript)
      && /dataset\.condlibDelete/.test(adminScript) && /\/api\/qc-condition-create/.test(adminScript),
      '判定方式一律可改可删：每行都要给"编辑 / 复制 / 删除"三个动作'
        + '（复制走的是新建接口：改口径前留一份，或把它带到另一个包里用）',
    );
    assert(
      /function pluginCardHtml\(/.test(adminScript) && /S\.qcPlugins/.test(adminScript),
      '算子插件那一块要读服务端下发的装载结果（插件装不上必须看得见，不能只留在启动日志里）',
    );
  });

  /* 系统的 `confirm` / `alert` / `prompt` 一律不用（两页 + 登录页）。
     它们不受本页样式控制，也不与触发它的按钮发生任何视觉联系；按钮还只有
     "确定 / 取消"两个词，而这里要确认的动作是删除 / 撤稿 / 清除 ——
     按钮上就该写动作本身。替换物是 dialog.js（原生 <dialog> + showModal()，
     与抽屉同源：遮罩与 Esc 交给内核）。 */
  await test('A29 弹框一律用自定义的（dialog.js）：页面脚本里不出现系统弹框', () => {
    const adminScript = readFileSync(join(ROOT, 'src', 'demo', 'admin.js'), 'utf8');
    const loginScript = readFileSync(join(ROOT, 'src', 'demo', 'login.js'), 'utf8');
    const adminMarkup = readFileSync(join(ROOT, 'src', 'demo', 'admin.html'), 'utf8');
    const dialogScript = readFileSync(DIALOG_JS, 'utf8');
    /* 剥掉注释再找（注释里叙述"原来用的是 window.confirm"是正常的）。 */
    const native = /(?<![\w.$])(confirm|alert|prompt)\s*\(/;
    for (const [name, src] of [['ui.js', script], ['admin.js', adminScript], ['login.js', loginScript]] as Array<[string, string]>) {
      assert(!native.test(stripJsComments(src)), `${name} 里不应再出现系统弹框（confirm / alert / prompt）`);
    }
    /* 三个入口都在、都在页面脚本里真的被用到了 */
    assert(/window\.askConfirm =/.test(dialogScript), 'askConfirm 应挂在 window 上（两页共用的经典脚本）');
    assert(/window\.askAlert =/.test(dialogScript) && /window\.askText =/.test(dialogScript), 'askAlert / askText 也应挂在 window 上');
    assert((script.match(/await ask(Confirm|Alert|Text)\(/g) || []).length >= 8, '医生端的确认 / 提示 / 问理由都走自定义弹框');
    assert((adminScript.match(/await askConfirm\(/g) || []).length >= 15, '管理后台的确认都走自定义弹框');
    /* 与抽屉同一套内核机制 + 同一套补丁（点遮罩关闭要自己接、按坐标判"点在框外"） */
    assert(/showModal\(\)/.test(dialogScript), '弹框必须是原生 <dialog> + showModal()');
    assert(/getBoundingClientRect\(\)/.test(dialogScript), '点遮罩关闭要自己接（并按坐标判"点在框外"）');
    assert(/dialog\.app-dialog\s*\{/.test(css), '弹框要有自己的样式（不受系统弹框那套外观支配）');
    /* 危险动作仍然要问，且问的措辞还在（替换掉的是弹框，不是"问不问"） */
    assert(/askConfirm\([\s\S]{0,220}内容不可恢复/.test(script), '删除本段仍要二次确认（不可恢复）');
    assert(
      /askConfirm\([\s\S]{0,220}整套质控会失效/.test(script),
      '「标记为误报」仍要二次确认（它会让同一条规则在内容未变时不再提示）',
    );
    /* 两页都要加载它，服务端也要真的提供（静态资源缺一个，弹框就会 undefined 崩在点击里） */
    assert(/src="\/dialog\.js"/.test(markup), '医生端应加载 /dialog.js');
    assert(/src="\/dialog\.js"/.test(adminMarkup), '管理后台应加载 /dialog.js');
    assert(/path === '\/dialog\.js'/.test(serverSource), '服务端应提供 /dialog.js（no-store）');
  });

  /* 「从系统带入」是**对接标记**，不是"本系统生成的值"：外部采集 / 同步程序按
     「模板名称 + 槽位名」找到标了它的那一格，把值同步进来。
     界面上必须说清三件事 —— 它是给谁的标记、配对键是什么、改了名字会怎样。
     这三处是配置方的唯一线索（对接文档不在这个界面上），漏了就只能靠口头约定。 */
  await test('A30 「从系统带入」是给采集 / 同步程序的对接标记：标记·配对键·改名后果都说清了', () => {
    const adminScript = readFileSync(join(ROOT, 'src', 'demo', 'admin.js'), 'utf8');
    assert(
      /title="这是给采集 \/ 同步程序看的对接标记/.test(adminScript),
      '「从系统带入」要说清它是给采集 / 同步程序看的标记',
    );
    assert(/模板名称 \+ 槽位名/.test(adminScript), '要说清配对键是「模板名称 + 槽位名」');
    assert(/留空 = 这一格不参与同步/.test(adminScript), '留空要能读成"这一格不参与同步"');
    assert(
      /不标记（留空待填，也不参与同步）/.test(adminScript),
      '下拉的空选项要说的是"这一格不带系统带入标记"，而不是"这一格不用填"',
    );
    assert(
      /采集 \/ 同步程序也按「模板名称 \+ 槽位名」对接/.test(adminScript),
      '槽位名那一格要写明：改名会让同步对不上',
    );
    assert(/改了名称要让同步程序跟着改/.test(adminScript), '模板名称那一格要写明：改名会让同步对不上');
  });

  await test('A21 采集：ASR 协议与地址只出现在服务端，前端产物里一处都没有', () => {
    /* 这条守的是采集路线本身的选择（设计文档第二节）：前端只与同源通信。
       如果有人图省事把 ASR 地址或它的协议细节写进前端，两种现场都很晚才被发现：
       页面在 HTTPS 下拿不到麦克风（混合内容被浏览器拦，前端无法绕过），
       或者地址被写死后换一台 ASR 就要改前端。 */
    /* 管理后台页与登录页也在"前端产物"里，一并检查：协议细节对它们同样没有意义，
       而它们是最容易被顺手写上"服务端那几句"的地方（两边都在 UI 目录下）。 */
    const adminMarkup = readFileSync(join(ROOT, 'src', 'demo', 'admin.html'), 'utf8');
    const adminScript = readFileSync(join(ROOT, 'src', 'demo', 'admin.js'), 'utf8');
    for (const [name, artifact] of [
      ['医生端', frontend],
      ['管理后台', `${adminMarkup}\n${adminScript}`],
    ] as Array<[string, string]>) {
      assert(!/inference-realtime/.test(artifact), `${name}产物里不得出现 ASR 接口路径（它属 ASR 协议，换厂商不该改前端）`);
      assert(!/task_id/.test(artifact), `${name}产物里不得出现 \`task_id\`：前端拿到它就想自己轮询，而轮询在服务端完成`);
      assert(!/L0_CAPTURE_/.test(artifact), `${name}产物里不得出现采集的环境变量名（配置一律由服务端下发）`);
    }
    /* 地址分两档看，而不是一律禁止：
         - **医生端一个都不该有**：它没有配地址的职责；
         - 管理后台**允许 placeholder 里写示例地址**（那一格本来就是要人填地址的地方，
           写"示例"比写"http://"更能让人填对），但**脚本里不得写死**：地址只能来自服务端下发的 state。 */
    assert(!/10\.\d+\.\d+\.\d+/.test(frontend), '医生端产物里不得出现内网地址（它没有配地址的职责）');
    assert(!/10\.\d+\.\d+\.\d+/.test(adminScript), '管理后台**脚本**里不得写死内网地址：它必须来自 state（写死的地址换一家医院就改不动）');
    assert(
      /\$\('cfgCaptureEndpoint'\)\.value\s*=/.test(adminScript),
      '管理后台应把采集地址从服务端状态回填（而不是在源码里钉一个）',
    );
    /* 反证：协议在**服务端模块**里（`capture.ts` 是服务端采集层，不进前端产物）——
       否则上一条会变成"哪儿都没有"的空检查。 */
    const captureSource = readFileSync(join(ROOT, 'src', 'dictation', 'capture.ts'), 'utf8');
    assert(/api\/audio\/inference-realtime/.test(captureSource), '反证：ASR 协议应在服务端采集层里（capture.ts）');
    /* 医生端要能看见采集可用性：未配置时说明原因，而不是让人点了没反应 */
    assert(/id="dictationCapture"/.test(html), '医生端应有采集可用性的显示位（id="dictationCapture"）');
    assert(/dictationCapture/.test(script), '医生端脚本应渲染采集可用性');
  });

  await test('A22 采集界面：录音态有指示与计时；没有"自动开始采集"的路径；来源只有本机客户端', () => {
    /* "录音必须可见"是本设计里**唯一一条不讨论取舍的界面要求**（第八节第 1 条：
       病房里的人有权知道自己在被录）。这条是它的机器证明。
       来源已收敛成**只有本机客户端**：下拉里的脚本音频（演示）与浏览器麦克风都撤了 ——
       把演示源与真源并排摆着，现场只能靠猜"哪个才是真的"。 */
    assert(/id="captureLocalStatus"/.test(html), '界面要有本机客户端采集的状态渲染位（过程由客户端与页面共同产生）');
    assert(!/id="captureSource"/.test(html), '不再提供"音频来源"选项：来源只有本机客户端一条');
    assert(!/value="mic"/.test(html) && !/value="client"/.test(html), '来源下拉的三档都该撤掉（留着就是让人以为还能换来源）');
    assert(/id="btnCaptureStop"/.test(html), '必须有"停止"（医生中途停止要能把当前那一段立刻定稿）');
    assert(/id="btnCaptureStart"/.test(html), '必须有"开始"（采集只能由人按）');
    assert(/● 录音中/.test(script), '录音态必须有可见的指示（一个正在录的记号）');
    assert(/elapsedSec/.test(script), '录音态必须有计时：只有指示没有计时，看不出它走到哪一步了');
    assert(/currentChunkSec/.test(script), '还要能看出"当前这一段已录多久"（分片是静音判停做的）');
    /* 采集源改成状态卡里的一行（`采集源 | tone（…）`）：值仍原样呈现 /hello 给的标识。
       断线时也保留最近一次的源，不能跟着探测结果一起消失。 */
    assert(
      /capRow\('采集源', esc\(clientSource\)\)/.test(script),
      '采集源标识要如实呈现（客户端在 /hello 里回报；断线时也保留最近一次的源，不能跟着探测结果一起消失）',
    );
    /* 页面不碰设备：浏览器麦克风那一档撤掉之后，页面脚本里更不该出现任何打开设备的调用 */
    assert(
      !/getUserMedia\s*\(/.test(stripJsComments(script)),
      '页面脚本里不得直接调 getUserMedia：那是"打开页面就碰设备"的来路',
    );
    /* 本机客户端采集（C3b③）：页面只做"取段 → 上传"，**不做分片** */
    const code = stripJsComments(script);
    for (const endpoint of ['/hello', '/start', '/next', '/audio/', '/ack', '/stop']) {
      assert(code.includes(endpoint), `页面侧要真的调桥端点 ${endpoint}（写了没人调等于没接）`);
    }
    assert(/captureClient/.test(code) && /captureToken/.test(code), '仍要接受客户端注入的地址与令牌（有令牌时优先，不能被默认值盖掉）');
    assert(/DEFAULT_CAPTURE_CLIENT = '127\.0\.0\.1:8901'/.test(code), '本机客户端地址是固定约定（本机回环 + 8901）：裸地址也能直接检测');
    assert(!/10\.\d+\.\d+\.\d+/.test(code), '页面里不得出现内网地址（固定约定只限本机回环）');
    assert(/E_BRIDGE_BAD_TOKEN/.test(code), '客户端启用令牌时要能说清"令牌不匹配"（不能静默失败）');
    assert(/同源/.test(script) || /\/api\/dictation\/capture\/segment/.test(code), '段仍要上传给**同源**采集路由（不把 ASR 端点告诉页面）');
    assert(/未检测到/.test(script), '没检测到客户端时必须说明"怎么办"（不能只显示一句"不可用"）');
    assert(/npm run dictation-client/.test(script), '没检测到客户端时要给出启动方式（否则医生只能去猜）');
    /* 采集**只能由人按**：触发点必须唯一，且挂在按钮上。
       来源收敛成一条之后，分派只剩 `startCapture → runLocalCapture` 这一段。 */
    assert(!/demo-run/.test(script), '页面不再挂"服务端脚本音频"这条演示采集（来源只有本机客户端）');
    assert(/el\.id === 'btnCaptureStart'[\s\S]{0,60}startCapture/.test(script), '那个触发点必须挂在按钮上（不许任何自动路径）');
    assert(
      /function startCapture[\s\S]{0,200}runLocalCapture/.test(script),
      '按钮要真的分派到采集实现（分派写漏了就会出现"按了没反应"）',
    );
    assert(
      /const clientReady = clientProbe !== null && clientProbe\.ok === true;/.test(script),
      '开始采集只按客户端可用性置灰：录音与转写是两件事，没配 ASR 也该能录',
    );
    /* 状态卡里主语在标签列（`语音识别 | 未配置（…）`），值那一格只留结论 */
    assert(
      /capRow\('语音识别', asrReady \? '已配置' : '未配置（可录，转写会失败）'/.test(script),
      '未配 ASR 要明确"能录、转写会失败"，而不是把录音入口一起关掉（那会把它变成转写按钮）',
    );
    /* 录音状态监测：设备被拔掉/被独占时客户端只是"不再送帧"，页面上会表现成秒数停住。
       必须把 /hello 的 sourceProblem 在**采集期间**也读回来并显示，否则那看起来像卡死。 */
    assert(
      /hello\.sourceProblem/.test(script) && /state\.problem/.test(script),
      '采集期间的采集源异常（设备掉线/被独占）要能从 /hello 的 sourceProblem 看到并显示，不能只让秒数停住',
    );
    assert(
      /采集源异常/.test(script) && /怎么办/.test(script),
      '采集源异常要带"怎么办"，只说"异常了"等于让人去猜',
    );
    assert(
      /progress\.state/.test(script),
      '客户端提前收尾时要能看出来（只看页面自己的 running，会一直显示"录音中"）',
    );
    /* 定时状态检测：**不看当前是否已连上** —— 只在"已连上"时复检，等于"断了就再也不看了"，
       而客户端后启动也永远不会被接上。这条守的是心跳的存在与它不带那个前提。 */
    const heartbeat = /setInterval\(\(\) => \{([\s\S]*?)\}, CLIENT_HEARTBEAT_MS\)/.exec(script);
    const beatBody = heartbeat === null ? '' : heartbeat[1];
    assert(heartbeat !== null, '页面要按固定周期检测本机客户端（不是只在打开时探一次）');
    assert(/probeCaptureClient\(\)/.test(beatBody), '心跳里必须真的调探测（写了常量没人用等于没有）');
    assert(!/clientProbe/.test(beatBody), '心跳不得以"已连上"为前提：客户端后启动接不上，中途退出也看不见');
    /* 采集记录（只记元数据）：有显示位、有提交、有读取，且**提交体里没有音频/文本** ——
       这条记录一旦带上它们，就成了第二份病历内容副本，生命周期与门控都和正文不是一回事。 */
    assert(/id="captureHistory"/.test(html), '采集记录要有显示位（id="captureHistory"）');
    assert(/\/api\/dictation\/capture\/session/.test(code), '采集结束要提交一笔元数据（不提交 = 界面上永远没有记录）');
    assert(/\/api\/dictation\/capture\/records/.test(code), '界面要能读回采集记录（只写不读等于没做）');
    assert(
      /\/api\/dictation\/capture\/records\?docId=/.test(code),
      '采集记录要按当前病历读取（不按病历读，切文书后看到的仍是上一个患者的记录）',
    );
    assert(
      /\/api\/dictation\/capture\/records\/clear/.test(code),
      '采集记录要能清空（否则失败记录只能删文件或等 7 天）',
    );
    assert(/音频不留存，无法回放/.test(script), '记录区必须写明"音频不留存"：否则看的人只会问"为什么不能播放"');
    const recordBody = /api\('\/api\/dictation\/capture\/session'[\s\S]{0,700}?\}\);/.exec(script);
    assert(recordBody !== null, '提交采集记录的代码要能被静态定位（定位不到说明写法变了，这条守卫会失效）');
    if (recordBody !== null) {
      assert(
        !/\baudio\b|\btext\b|\bblob\b/i.test(recordBody[0]),
        '采集记录里不得带音频或文本（只记元数据：音频按设计不留存，文本走建议通道）',
      );
    }
  });

  await test('A25 服务端文案同样不得出现 Markdown 语法（它会被 toast 与状态行原样显示）', () => {
    /* `A14` 只扫前端文件，于是服务端吐出的文案是它的盲区 —— 实测就是靠真实渲染发现的：
       一句 `**不静默退回模拟转写**` 原样出现在 toast 上。文案里带 Markdown，在这套界面里
       只会变成几个碍眼的星号（医生看到的是"系统在打字时心不在焉"，而不是强调）。
       扫描前先剥掉注释：注释里的 `**` 不会被任何人看到。 */
    const stripComments = stripJsComments;
    const sources: Array<[string, string]> = [
      ['demo-server.ts', readFileSync(join(ROOT, 'src', 'demo', 'demo-server.ts'), 'utf8')],
      ['capture.ts', readFileSync(join(ROOT, 'src', 'dictation', 'capture.ts'), 'utf8')],
      ['capture-client.ts', readFileSync(join(ROOT, 'src', 'dictation', 'capture-client.ts'), 'utf8')],
      ['capture-source.ts', readFileSync(join(ROOT, 'src', 'dictation', 'capture-source.ts'), 'utf8')],
    ];
    const offenders = sources.flatMap(([name, text]) =>
      (stripComments(text).match(/[^\n]*'[^'\n]*\*\*[^'\n]*'[^\n]*/g) ?? []).map((line) => `${name}: ${line.trim().slice(0, 80)}`),
    );
    assertEqual(offenders, [], `服务端文案里不得出现 Markdown 语法（会原样显示）：${offenders.join(' | ')}`);
  });

  /* ============================ B 服务契约 ============================ */

  await startServer();
  /* 配置写入一律要求管理后台会话（服务端 `requireAdminSession`，身份由服务端决定、不接受自报）。
     这里先初始化出账号再登录：产品侧已经没有任何内置口令，账号是第一次运行时建出来的，
     于是这一步同时把"初始化 → 建账号 → 登录"整条链走了一遍。
     登录后，后续所有 `post()` 自动带上会话 cookie。 */
  adminCookie = await provisionAccounts(BASE);
  /* 新库是空的（包不再播种）：把样例包载进来，后面那些"模板能开、质控有规则"的用例才有前提 */
  const seeded = await loadSamplePacks();
  if (seeded.ok !== true) throw new Error(`载入样例包失败：${seeded.code ?? ''} ${seeded.message ?? ''}`);
  /* 签章是后面一批用例的前提（导出/受控阅读/审计都建立在"已签章"之上），
     所以先把靶子签名服务接上，未配置就签不了章，这是产品侧有意的 fail-closed。 */
  signService = startFakeSignService();
  await configureSignService();
  /* 靶子 ASR：默认**不配置**（采集入口应处于"未配置"这一 fail-closed 状态），
     B45 会先用它证明"未配置时明确拒绝"，再配上去证明"配好后走通"。 */
  asrService = startFakeAsrService();

  await test('B1 工作区视图：3 位患者 / 6 份病历，含患者与就诊信息，活动病历展开章节', async () => {
    const current = await state();
    assertEqual(current.activeDocId, FIRST_DOC, '默认应打开第一份病历');
    assertEqual(current.tree.length, 3, '应有 3 位患者');
    const docs = allDocs(current);
    assertEqual(docs.length, 6, `应有 6 份病历，实际 ${docs.length}`);
    assertEqual(docs.filter((doc) => doc.active).length, 1, '有且只有一份病历处于活动态');
    assert(!!current.patient.nameMasked && current.patient.age !== null, '应带患者信息（姓名掩码与年龄）');
    assert(!!current.encounter.visitId && !!current.encounter.dept, '应带就诊信息（就诊号与科室）');
    const active = docs.find((doc) => doc.active) as TreeDoc;
    assert(active.sections.length >= 5, `活动病历应展开章节叶子，实际 ${active.sections.length}`);
    assert(active.sections.some((section) => section.hasUnconfirmed), '有关键内容章节应标记待确认');
    assert(current.items.length >= 12, `正文节点过少：${current.items.length}`);
  });

  /* 状态是**按身份投影**的（见 demo-server 的 `stateFor`）：这条用例是它的机器证明。
     为什么值得单独钉一条：两个页面共用 `/api/state`，而"顺手下发了一批不该发的字段"
     不会报任何错 —— 它只会悄悄扩大暴露面。这类改动必须由断言守，而不是靠人记得。 */
  await test('B1b 状态投影：无会话拿医生端投影（不含管理端字段），管理员拿管理端投影（含）', async () => {
    /* 医生端投影里不该出现的：管理端专有 + 只用于诊断的字段。
       `activeDocId` **不在这张表里** —— 它是"工作区当前打开哪份文书"，属共用口径
       （这条最初划错过，被 B1 挡了回来，见 demo-server 里那段注释）。 */
    const hidden = ['templateCatalog', 'contextFields', 'expressionFunctions', 'departments', 'expressionControls', 'database', 'invariants', 'placement', 'signBackend'];

    /* ① 医生端投影：**不带会话**直取（不能用 `state()`：它按管理身份取全量视图） */
    const anonRes = await fetch(`${BASE}/api/state`);
    const anon = ((await anonRes.json()) as { state: Record<string, unknown> }).state;
    assertEqual(anon.scope, 'doctor', '无会话时应下发医生端投影');
    for (const key of hidden) {
      assert(!(key in anon), `医生端投影不应含 ${key}（它属管理端，或只用于诊断）`);
    }
    /* 反证：医生端投影不能是"什么都没发" —— 否则上面那一条会因为空对象而通过 */
    assert(Array.isArray(anon.items) && anon.items.length >= 12, '医生端投影必须仍带正文节点（否则上一条是空检查）');
    assert(anon.doc !== undefined && anon.tree !== undefined, '医生端投影必须仍带文书与患者树');
    assert('activeDocId' in anon, '`activeDocId` 属共用口径，医生端投影必须有它');

    /* ③ 配置镜像在医生端只剩"可用性"：地址、厂商协议、凭据就位状态都不该下发。
       这条守的是一处真实泄漏 —— 原实现把模型服务地址与语音服务地址直接打印在
       医生端页面上（AI 助手面板的"产出方"、语音页签的服务状态行）。 */
    const mirrors = (value: unknown): Record<string, unknown> => (value ?? {}) as Record<string, unknown>;
    const anonCapture = mirrors(anon.capture);
    assert(typeof anonCapture.configured === 'boolean', '医生端应拿到可用性（configured 必须是个明确的布尔）');
    assert(Array.isArray(anonCapture.missing), '医生端应拿到"缺哪几格"（否则入口为什么不能用说不出来）');
    assert('retainAudio' in anonCapture && 'segment' in anonCapture, '医生端应保留告知义务与分片参数');
    for (const key of ['endpoint', 'modelId', 'appKey', 'vendors', 'protocol', 'apiKeyPresent', 'apiSecretPresent', 'submitTimeoutMs', 'pollIntervalMs']) {
      assert(!(key in anonCapture), `医生端 capture 不应含 ${key}（部署参数/厂商协议/凭据状态）`);
    }
    const anonModel = mirrors(anon.model);
    assert('modelId' in anonModel && 'format' in anonModel, '医生端 model 应保留产出方（modelId 要写进留痕）');
    assert(!('endpoint' in anonModel), '医生端 model 不应含服务地址');
    assert(!('source' in anonModel) && !('apiKeyPresent' in anonModel), '医生端 model 不应含配置来源与凭据状态');
    const anonTrust = mirrors(anon.readingAuthority);
    assert(Array.isArray(anonTrust.trustedFingerprints), '医生端 readingAuthority 应保留生效中的信任集（核对凭据身份要用）');
    assert(!('endpoint' in anonTrust), '医生端 readingAuthority 不应含授权平台地址');


    /* ② 管理端投影：同一批字段必须都在。用裸 fetch 而不是 `call()`：那个辅助函数
       定义在本套用例更靠后的位置（`const` 声明，此处取不到）。 */
    assert(adminCookie !== '', '前置：管理员会话应已建立（本用例需要一个管理端身份）');
    const adminRes = await fetch(`${BASE}/api/state`, { headers: { Cookie: adminCookie } });
    const admin = ((await adminRes.json()) as { state: Record<string, unknown> }).state;
    assertEqual(admin.scope, 'admin', '管理员拿到的应是管理端投影');
    for (const key of hidden) {
      assert(key in admin, `管理端投影应含 ${key}`);
    }
  });

  await test('B2 低置信建议：采纳被门控拒绝，且错误码进入门控日志（界面可见）', async () => {
    const target = (await state()).items.find((item) => item.kind === 'text');
    /* 低置信建议的来源是产出方（这里模拟一个自知不可靠的产出方），
       不是"让界面把置信度调低"，界面能选的是谁来产出，不是这条内容有多可信 */
    const suggested = await post('/api/suggest-low', { nodeId: target?.id });
    assertEqual(suggested.ok, true, 'AI 出建议应成功（生成不落笔）');
    const accepted = await post('/api/accept', { suggestionId: suggested.data?.suggestionId });
    assertEqual(accepted.ok, false, '低置信采纳必须被拒');
    assertEqual(accepted.code, 'E_AI_LOW_CONFIDENCE', '错误码应为 E_AI_LOW_CONFIDENCE');
    const after = await state();
    assert(after.log.some((entry) => entry.code === 'E_AI_LOW_CONFIDENCE'), '门控日志应记录被拒原因');
    assert(after.suggestions.some((item) => item.status === 'pending'), '被拒的建议仍应保留为待处理');
  });

  await test('B3 未确认即签章被拒；确认后签章成功且机读信息自动新鲜', async () => {
    const current = await state();
    const keyItem = current.items.find((item) => item.kind === 'text' && item.keyContent) as DemoItem;
    const suggested = await post('/api/suggest', { nodeId: keyItem.id, confidence: 0.96 });
    const accepted = await post('/api/accept', {
      suggestionId: suggested.data?.suggestionId,
      editedText: `${keyItem.text ?? ''} 无药物及食物过敏史。`,
    });
    assertEqual(accepted.ok, true, '高置信采纳应成功');
    assertEqual(accepted.state?.metrics.modified, 1, '改后采纳应计入修改率');

    const denied = await post('/api/sign');
    assertEqual(denied.ok, false, '未确认就签章必须被拒');
    assert(
      denied.code === 'E_KEY_CONTENT_UNCONFIRMED' || denied.code === 'E_SIGNED_WITH_UNCONFIRMED_AI',
      `错误码应指向未确认，实际 ${denied.code}`,
    );

    const beforeConfirm = await state();
    for (const item of beforeConfirm.items.filter((entry) => entry.kind !== 'section' && !entry.humanConfirmed)) {
      const confirmed = await post('/api/confirm', { nodeId: item.id });
      assertEqual(confirmed.ok, true, `确认节点 ${item.id} 应成功`);
    }
    const signed = await post('/api/sign');
    assertEqual(signed.ok, true, `全部确认后应可签章，实际 ${signed.code ?? ''}`);
    assertEqual(signed.state?.doc.status, 'signed', '状态应为已签章');
    assertEqual(signed.state?.machine.stale, false, '签章应强制重算机读信息');
    assert((signed.state?.machine.count ?? 0) > 0, '机读数据元应已派生');
  });

  await test('B4 切换病历：状态互相独立（签章、建议、机读信息都不串）', async () => {
    const onFirst = await state();
    assertEqual(onFirst.activeDocId, FIRST_DOC, '前置：仍在第一份病历');
    assertEqual(onFirst.doc.status, 'signed', '前置：第一份已签章');
    const pendingOnFirst = onFirst.suggestions.filter((item) => item.status === 'pending').length;

    const opened = await post('/api/open', { docId: SECOND_DOC });
    assertEqual(opened.ok, true, '切换病历应成功');
    const onSecond = await state();
    assertEqual(onSecond.activeDocId, SECOND_DOC, '活动病历应已切换');
    assertEqual(onSecond.doc.status, 'draft', '另一份病历不应继承签章状态');
    assertEqual(onSecond.suggestions.length, 0, '另一份病历不应继承建议');
    assertEqual(onSecond.machine.count, 0, '另一份病历不应继承机读信息');
    assertEqual(onSecond.metrics.suggested, 0, '指标应各自独立');
    assertEqual(onSecond.log.length, 0, '日志应各自独立');
    assert(allDocs(onSecond).find((doc) => doc.docId === FIRST_DOC)?.status === 'signed', '树里第一份病历仍应显示已签章');
    assertEqual(allDocs(onSecond).find((doc) => doc.docId === FIRST_DOC)?.machineStale, false, '树里第一份病历机读应为最新');
    assertEqual(allDocs(onSecond).find((doc) => doc.docId === SECOND_DOC)?.active, true, '树里活动病历标记应切换');

    const back = await post('/api/open', { docId: FIRST_DOC });
    const onBack = await state();
    assertEqual(back.ok, true, '切回应成功');
    assertEqual(onBack.doc.status, 'signed', '切回后签章状态应保留');
    assertEqual(onBack.suggestions.filter((item) => item.status === 'pending').length, pendingOnFirst, '切回后建议应保留');
    assert((onBack.machine.count ?? 0) > 0, '切回后机读信息应保留');

    const bad = await post('/api/open', { docId: 'doc_not_exist' });
    assertEqual(bad.ok, false, '不存在的病历应被拒');
    assertEqual(bad.code, 'E_DOC_NOT_FOUND', '错误码应为 E_DOC_NOT_FOUND');
  });

  await test('B5 全链路导出（含独立探针验收与按病历产物隔离）', async () => {
    await post('/api/open', { docId: FIRST_DOC });
    const exported = await post('/api/export');
    assertEqual(exported.ok, true, `导出应成功，实际 ${exported.code ?? ''}`);
    const record = exported.state?.lastExport;
    assert(!!record, '应产生导出记录');
    assertEqual(record?.probeExit, 0, `探针退出码应为 0，实际 ${record?.probeExit}`);
    assertEqual(record?.probe.verdict, 'PASS', '探针结论应为 PASS');
    assertEqual((record?.probe.checks ?? []).filter((check) => check.critical && !check.pass).map((check) => check.id), [], '不应有失败的关键检查');
    assertEqual(record?.probe.roundTrip?.completeness, 1, 'round-trip 完整率应为 100%');
    assertEqual(record?.probe.roundTrip?.found, record?.probe.roundTrip?.total, '期望元素应全部命中');
    assertEqual(record?.file.endsWith(`${FIRST_DOC}.ofd`), true, `产物应按病历命名，实际 ${record?.file}`);

    // 切到另一份病历：不应看到上一份的导出记录（产物与记录都隔离）
    await post('/api/open', { docId: SECOND_DOC });
    assertEqual((await state()).lastExport, null, '另一份病历不应看到上一份的导出记录');
    await post('/api/open', { docId: FIRST_DOC });
    assert(!!(await state()).lastExport, '切回后导出记录应保留');
  });

  await test('B6 重置：整工作区回到初始态，且被拒记录仍可在日志中追溯', async () => {
    await resetWorkspace();
    const reset = await state();
    assertEqual(reset.activeDocId, FIRST_DOC, '重置后回到默认病历');
    assertEqual(reset.doc.status, 'draft', '重置后应为草稿');
    assertEqual(reset.suggestions.length, 0, '重置后不应有建议');
    assertEqual(reset.machine.count, 0, '重置后应无机读数据元');
    assertEqual(reset.lastExport, null, '重置后不应有导出记录');
    assert(allDocs(reset).every((doc) => doc.status === 'draft'), '所有病历都应回到草稿');

    const denied = await post('/api/accept', { suggestionId: 'sg_9999' });
    assertEqual(denied.ok, false, '不存在的建议应被拒');
    assertEqual(denied.code, 'E_SUGGESTION_NOT_FOUND', '错误码应为 E_SUGGESTION_NOT_FOUND');
    const logged = await state();
    assert(logged.log.some((entry) => entry.ok === false && entry.code === 'E_SUGGESTION_NOT_FOUND'), '门控日志应记录该错误（界面要能看见）');
  });

  await test('B7 采纳链路：按当次 id 采纳后正文确实被改写；旧的低置信建议仍为 pending（取错 id 的陷阱）', async () => {
    await resetWorkspace();
    const before = await state();
    const target = before.items.find((item) => item.kind === 'text' && item.keyContent) as DemoItem;

    const low = await post('/api/suggest-low', { nodeId: target.id });
    const denied = await post('/api/accept', { suggestionId: low.data?.suggestionId });
    assertEqual(denied.code, 'E_AI_LOW_CONFIDENCE', '低置信不得落笔');
    assertEqual((await state()).items.find((item) => item.id === target.id)?.text, target.text, '被拒后正文不应改变');

    const high = await post('/api/suggest', { nodeId: target.id, confidence: 0.96 });
    const accepted = await post('/api/accept', { suggestionId: high.data?.suggestionId, editedText: '改后文本（人工改过）' });
    assertEqual(accepted.ok, true, `高置信采纳应成功，实际 ${accepted.code ?? ''}`);

    const after = await state();
    assertEqual(after.items.find((item) => item.id === target.id)?.text, '改后文本（人工改过）', '正文应被改写（这是"采纳真的生效"的唯一证据）');
    assertEqual(after.metrics.modified, 1, '改后采纳应计入修改率');
    const stillPending = after.suggestions.filter((item) => item.status === 'pending');
    assertEqual(stillPending.length, 1, '被拒的低置信建议应仍为待处理');
    assertEqual(stillPending[0]?.id, low.data?.suggestionId, '仍是同一条低置信建议，这正是"用 find(pending) 会取错"的场景');

    /* 三级归因走完整 HTTP 链路（服务端算、界面照渲染）：
       这里不断言具体落在哪一档（那取决于服务端产出的建议文本），
       而是断言**恒等式**与"归因条数与改写事实对得上" —— 断死档位会让用例
       随产出方文案变化而碎，而它要守的是"归因不重不漏"这条纪律。 */
    const attribution = after.attribution;
    assertEqual(
      attribution.asIs + attribution.light + attribution.heavy + attribution.unknown,
      attribution.accepted,
      '四级归因之和必须等于采纳数（否则界面上的自查恒等式失效）',
    );
    assertEqual(attribution.accepted, after.metrics.accepted, '归因的采纳数必须与 metrics 同一份数据');
    assertEqual(attribution.light + attribution.heavy, 1, '这条是"改后采纳"，应落在微改或大改里');
    assertEqual(attribution.asIs, 0, '改过就不能算原样采纳');
    const acceptedItem = after.suggestions.find((item) => item.status === 'accepted');
    assert(
      acceptedItem?.editBand === 'light' || acceptedItem?.editBand === 'heavy',
      `已采纳的条目应带服务端算好的分档，实际 ${acceptedItem?.editBand}`,
    );
  });

  await test('B8 导入 OFD-H：识别格式/页数/数据元，导入件是新草稿且不继承签名', async () => {
    await post('/api/open', { docId: FIRST_DOC });
    /* 前置：先把这份病历确认并签章，这样导出的才是"已签章原件"，
       导入后正好验证"导入件不继承签名"这条纪律 */
    for (const item of (await state()).items.filter((entry) => entry.kind !== 'section' && !entry.humanConfirmed)) {
      await post('/api/confirm', { nodeId: item.id });
    }
    const signed = await post('/api/sign');
    assertEqual(signed.ok, true, `前置：应能签章（${signed.code ?? ''}）`);
    const exported = await post('/api/export');
    assertEqual(exported.ok, true, `前置：先导出一份待导入的文件（${exported.code ?? ''}）`);
    const file = String(exported.state?.lastExport?.file ?? '');
    const sourceElements = exported.state?.machine.count ?? 0;
    assert(file.endsWith('.ofd') && sourceElements > 0, `前置：应产出 OFD 且含机读数据元（${file}）`);

    const base64 = Buffer.from(readFileSync(file)).toString('base64');
    const imported = await post('/api/import', { fileName: 'imported.ofd', base64 });
    assertEqual(imported.ok, true, `导入应成功，实际 ${imported.code ?? ''} ${imported.message ?? ''}`);

    const report = imported.data as unknown as {
      docId: string;
      format: string;
      pages: number;
      textChars: number;
      elements: number;
      signed: boolean;
      signaturePlaceholder: boolean;
      fileSha256: string;
      warnings: string[];
      reviewNotes: string[];
    };
    assertEqual(report.format, 'ofd-h', '应识别为 OFD-H');
    assertEqual(report.elements, sourceElements, `识别到的机读数据元应与源文件一致（${report.elements} vs ${sourceElements}）`);
    assert(report.pages >= 1 && report.textChars > 50, `应识别出页数与文本（${report.pages} 页 / ${report.textChars} 字）`);
    assertEqual(report.signed, true, '应识别到源文件已签章');
    /* T18 起签名是真实的国密签名：占位符必须为假 */
    assertEqual(report.signaturePlaceholder, false, 'T18 起源签名是真签名而非占位符');
    assert(report.warnings.some((item) => /已签章副本/.test(item)), `应警告"已签章副本"，实际：${report.warnings.join(' | ')}`);
    assert(report.warnings.some((item) => /段落语义/.test(item)), '应警告版式文件不含段落语义');
    assert(report.reviewNotes.length > 0, '应给出人工核对提示');

    const after = await state();
    assertEqual(after.activeDocId, report.docId, '导入后应切换到导入件');
    assertEqual(after.doc.status, 'draft', '导入件必须是草稿（不继承源文件签章状态）');
    const items = (await state()).items.filter((item) => item.kind !== 'section');
    assert(items.length > 0, '导入件应有内容节点');
    assert(items.every((item) => item.origin === 'imported'), '导入内容全部应标为 imported 来源');
    assert(items.some((item) => item.kind === 'field'), '机读数据元应落成字段节点');
    assert(items.every((item) => !item.humanConfirmed), '导入内容一律标为未确认');
    const importSource = (await state()).importSource as Record<string, unknown> | null;
    assert(!!importSource, '状态里应带导入来源信息（供界面显示核对提示）');
    assertEqual(importSource?.sha256, report.fileSha256, '来源信息应含源文件指纹');
    assertEqual(importSource?.signed, true, '来源信息应记录源文件已签章');
    /* 关键：来源档案必须同时记录"验签结论"，否则界面只能显示"已签章"（等于藏起"可能被改过"） */
    assertEqual(importSource?.signatureAlgorithm, 'SM2-SM3', '来源信息应记录签名算法');
    assertEqual(importSource?.signatureVerified, true, '来源信息应记录独立验签结论');
    /* T26：段落重建的统计必须下发（界面要显示"有多少段是猜的"） */
    assert(Number(importSource?.layoutParagraphs ?? 0) > 0, '来源信息应记录重建段落数');
    assertEqual(importSource?.layoutStrategy, 'geometry', '自家导出的文件应走几何重建策略');
    assert(
      Number(importSource?.layoutHigh ?? 0) + Number(importSource?.layoutMedium ?? 0) + Number(importSource?.layoutLow ?? 0) ===
        Number(importSource?.layoutParagraphs ?? 0),
      '高/中/低置信度之和应等于段落总数',
    );
    const treeDocs = allDocs(await state());
    assert(treeDocs.some((doc) => doc.docId === report.docId), '导入件应出现在病历树里');
    assertEqual(treeDocs.find((doc) => doc.docId === report.docId)?.status, 'draft', '树里导入件应显示为草稿');
  });

  await test('B9 导入负例：非 OFD 内容被拒且给出错误码（不静默产生空病历）', async () => {
    const garbage = Buffer.from('这不是 OFD 文件').toString('base64');
    const rejected = await post('/api/import', { fileName: 'bad.ofd', base64: garbage });
    assertEqual(rejected.ok, false, '非 OFD 内容应被拒');
    assertEqual(rejected.code, 'E_IMPORT_FAILED', `错误码应为 E_IMPORT_FAILED，实际 ${rejected.code}`);

    const empty = await post('/api/import', { fileName: 'empty.ofd', base64: '' });
    assertEqual(empty.ok, false, '空内容应被拒');
    assertEqual(empty.code, 'E_BAD_REQUEST', '错误码应为 E_BAD_REQUEST');
  });

  await test('B10 导入件必须逐项确认后才能签章（与 AI 内容同一条纪律）', async () => {
    const beforeSign = await state();
    assert(!!beforeSign.importSource, '前置：当前应为导入件（B8 导入并已切换）');

    const denied = await post('/api/sign');
    assertEqual(denied.ok, false, '未确认的导入内容必须拦住签章');
    assertEqual(denied.code, 'E_IMPORTED_UNCONFIRMED', `错误码应为 E_IMPORTED_UNCONFIRMED，实际 ${denied.code}`);
    assert((await state()).log.some((entry) => entry.code === 'E_IMPORTED_UNCONFIRMED'), '门控日志应记录该拒绝（界面要能看见）');
    assertEqual((await state()).doc.status, 'draft', '被拒后状态应仍为草稿');

    /* 逐项确认：界面上每个内容节点都有自己的"确认内容"按钮 */
    for (const item of (await state()).items.filter((entry) => entry.kind === 'text' || entry.kind === 'field')) {
      const confirmed = await post('/api/confirm', { nodeId: item.id });
      assertEqual(confirmed.ok, true, `确认节点 ${item.id} 应成功`);
    }
    const signed = await post('/api/sign');
    assertEqual(signed.ok, true, `逐项确认后应可签章（${signed.code ?? ''}）`);
    assertEqual(signed.state?.doc.status, 'signed', '状态应为已签章');
    assertEqual(
      signed.state?.items.filter((entry) => entry.kind !== 'section' && !entry.humanConfirmed).length,
      0,
      '签章后不应残留未确认的内容节点',
    );
  });

  await test('B11 导入 WS/T 500 XML：按内容识别、章节与数据元落地、未确认、门控生效', async () => {
    /* 直接内联黄金样例，避免依赖其它套件先产出文件（用例之间不允许隐式依赖） */
    const base64 = Buffer.from(WST500_SAMPLE_XML, 'utf8').toString('base64');
    const imported = await post('/api/import', { fileName: 'wst500-sample.xml', base64 });
    assertEqual(imported.ok, true, `导入应成功（${imported.code ?? ''} ${imported.message ?? ''}）`);

    const report = imported.data as unknown as {
      docId: string;
      kind: string;
      summary: string;
      sections: number | null;
      elements: number;
      textChars: number;
      warnings: string[];
      reviewNotes: string[];
    };
    assertEqual(report.kind, 'wst500', '应按内容识别为 WS/T 500（不看后缀）');
    assertEqual(report.sections, 6, '应识别出 6 个章节（含 1 个嵌套子章节）');
    assertEqual(report.elements, 4, '应识别出 4 条结构化数据元');
    assert(report.summary.includes('章节'), `摘要应体现章节数，实际：${report.summary}`);
    assert(report.reviewNotes.length > 0, '必须给出人工核对提示');

    const after = await state();
    assertEqual(after.activeDocId, report.docId, '导入后应切到该病历');
    assertEqual(after.doc.status, 'draft', '导入件必须是草稿');
    const content = after.items.filter((item) => item.kind !== 'section');
    assert(content.length > 0, '导入件应有内容节点');
    assert(
      content.every((item) => item.origin === 'imported' && !item.humanConfirmed),
      '导入内容必须全部标为 imported 且未确认',
    );
    assertEqual(after.items.filter((item) => item.kind === 'section').length, 6, '6 个章节都应落地（含嵌套）');
    assert(JSON.stringify(after.items).includes('诊断明细'), '嵌套子章节标题应落地');
    /* 树里的章节必须按文档层级顺序（子章节紧跟父章节）：
       按 order 扁平排序会让子章节跑到父章节前面，看起来像"章节乱了"（实测踩到过） */
    const treeDoc = allDocs(after).find((doc) => doc.docId === report.docId);
    assertEqual(
      (treeDoc?.sections ?? []).map((section) => section.title),
      ['主诉', '现病史', '体格检查', '辅助检查', '初步诊断', '诊断明细'],
      '树里章节应按文档层级顺序展示',
    );
    assert(after.items.some((item) => item.kind === 'text' && (item.text ?? '').includes('发热3天')), '叙述正文应落成文本节点');
    assert(after.machine.elements.some((element) => element.code === 'DE04.01.068'), '体温数据元应进入机读信息');
    assertEqual((after.importSource as Record<string, unknown> | null)?.format, 'wst500', '来源档案应记录 wst500');

    const denied = await post('/api/sign');
    assertEqual(denied.code, 'E_IMPORTED_UNCONFIRMED', '未确认的 WS/T 500 导入内容必须拦住签章');
    for (const item of (await state()).items.filter((entry) => entry.kind === 'text' || entry.kind === 'field')) {
      const confirmed = await post('/api/confirm', { nodeId: item.id });
      assertEqual(confirmed.ok, true, `确认节点 ${item.id} 应成功`);
    }
    const signed = await post('/api/sign');
    assertEqual(signed.ok, true, `逐项确认后应可签章（${signed.code ?? ''}）`);
  });

  await test('B12 签名信息下发：算法/后端/指纹/覆盖范围 + 实时验签结论（界面据此展示）', async () => {
    /* B11 已把当前导入件签章，故此刻应当是"已签章且验签通过"的状态 */
    const now = await state();
    assertEqual(now.doc.status, 'signed', '前置：当前病历应已签章');
    assert(!!now.sign, '状态里应带签名元信息（否则界面只能显示"已签章"而看不到算法与验签结论）');
    assertEqual(now.sign!.algorithm, 'SM2-SM3', '签名算法应为 SM2-SM3');
    /* 后端必须是 `http`：产品侧唯一的签名后端就是医院签名服务（本用例里是靶子服务）。
       若这里又变成 software，说明有人把"内置软件签名"放了回来，那正是本轮要去掉的东西。 */
    assertEqual(now.sign!.provider, 'http', '签名后端应标注为 http（医院签名服务）');
    assertEqual(now.sign!.publicKeyFingerprint.length, 64, '应给出公钥指纹（SM3/SPKI）');
    assertEqual(now.sign!.covers.some((item) => item.includes('MachineReadable')), true, '签名必须覆盖机读文件');
    assertEqual(now.signatureVerified?.ok, true, `已签章文档应验签通过，实际：${JSON.stringify(now.signatureVerified?.reasons ?? [])}`);
    assertEqual(now.signatureVerified?.details.referenceCount, 3, '验签结论应包含被覆盖文件数');
  });

  await test('B14 导出共享文档：统计正确，且导出的 XML 能被独立解析（交换链路可用）', async () => {
    const exported = await post('/api/export-wst500');
    assertEqual(exported.ok, true, `导出共享文档应成功（${exported.code ?? ''}）`);
    const record = exported.state?.lastWst500;
    assert(!!record, '状态里应带共享文档导出记录（界面据此显示"导出过了"）');
    assert(record!.sections > 0, '应导出至少一个章节');
    assert(record!.bytes > 500, `产物不应过小：${record!.bytes} 字节`);

    /* 用独立解析器读回（等价于"对方系统读这份文件"）：数量对不上就说明交换失败 */
    const xml = readFileSync(record!.file, 'utf8');
    const parsed = importWst500(new TextEncoder().encode(xml));
    assertEqual(parsed.stats.sections, record!.sections, '独立解析出的章节数应与导出统计一致');
    assertEqual(parsed.stats.fields, record!.fields, '独立解析出的数据元数应与导出统计一致');
    assertEqual(parsed.patient?.patientId, (await state()).patient.patientId, '患者 id 应能回导（身份不丢）');

    /* 下载接口：界面点"下载 XML"必须能拿到文件 */
    const download = await fetch(`http://127.0.0.1:${PORT}/api/download-wst500`);
    assertEqual(download.status, 200, '下载共享文档应返回 200');
    const body = await download.text();
    assert(body.includes('<ClinicalDocument'), '下载内容应是临床文档 XML');
  });

  await test('B15 受控阅读（HTTP 全链路）：平台签发 → 导入 → 记账阅读 → 次数用尽/终端不符/停用/换文档都被拦', async () => {
    /* 前置：B11/B14 之后当前病历已签章。
       注意本系统不签发授权，凭据由"授权平台"（测试自建钥匙）签发，经导入进入本系统。 */
    const current = await state();
    const fingerprint = current.reading.documentFingerprint;
    assert(fingerprint.length === 64, 'state 应下发文档内容指纹（授权平台要绑定的就是它）');

    const platform = demoKeyPair('dept-authz-platform-b15');
    const platformSigner = softwareSigner(platform.privateKey);
    const configured = await post('/api/reading-authority', {
      adminId: 'ADMIN',
      trustedIssuerFingerprint: publicKeyFingerprint(platform.publicKey),
    });
    assertEqual(configured.ok, true, `授权平台应可配置（${configured.code ?? ''} ${configured.message ?? ''}）`);

    const grantOf = (overrides: Partial<ReadingGrant>): ReadingGrant => ({
      grantId: 'grant_b15_main',
      docId: current.activeDocId,
      documentFingerprint: fingerprint,
      notBefore: new Date(Date.now() - 3_600_000).toISOString(),
      notAfter: new Date(Date.now() + 3_600_000).toISOString(),
      maxReads: 2,
      allowedEnvironments: ['WS-01'],
      allowedSections: ['*'],
      concealPatientIdentity: false,
      issuedBy: 'AUTHZ_PLATFORM',
      issuedAt: new Date().toISOString(),
      purpose: '院内会诊',
      ...overrides,
    });
    const importOf = async (grant: ReadingGrant): Promise<{ ok: boolean; code?: string; message?: string }> =>
      post('/api/reading/import-credential', { text: JSON.stringify(await issueReadingGrant(grant, platformSigner)) });

    const imported = await importOf(grantOf({}));
    assertEqual(imported.ok, true, `平台签发的凭据应可导入（${imported.code ?? ''} ${imported.message ?? ''}）`);
    const grantId = 'grant_b15_main';

    /* ① 正常阅读：放行、给出受控视图、服务端记账 */
    const first = await post('/api/reading/open', { grantId, environmentId: 'WS-01' });
    assertEqual(first.ok, true, `授权范围内应放行（${first.code ?? ''} ${first.message ?? ''}）`);
    const view = first.state!.reading.lastView!;
    assert(view, '应给出受控视图');
    assert(view.notices.some((text) => text.includes('受控阅读')), '视图必须带受控阅读告知（水印是控制的一部分）');
    assert(view.sections.length > 0, '授权内章节应有内容');
    assertEqual(view.remainingReads, 1, '读一次后剩余 1 次（maxReads=2）');
    const record = first.state!.reading.grants.find((item) => item.grantId === grantId)!;
    assertEqual(record.readCount, 1, '服务端必须记账 +1');

    /* ② 次数用尽：第 3 次必须被拦（次数记账在服务端，客户端改不了） */
    assertEqual((await post('/api/reading/open', { grantId, environmentId: 'WS-01' })).ok, true, '第 2 次应放行');
    const exhausted = await post('/api/reading/open', { grantId, environmentId: 'WS-01' });
    assertEqual(exhausted.code, 'E_GRANT_EXHAUSTED', '次数用尽必须拒绝');
    assert((await state()).log.some((entry) => entry.code === 'E_GRANT_EXHAUSTED'), '拒绝必须留痕（日志要能看见）');

    /* ③ 终端不符：凭证不可转让（平台签发的第二份，限定终端） */
    const boundId = 'grant_b15_bound';
    assertEqual((await importOf(grantOf({ grantId: boundId, purpose: '限制终端', maxReads: 5 }))).ok, true, '第二条授权应可导入');
    const wrongEnv = await post('/api/reading/open', { grantId: boundId, environmentId: 'WS-99' });
    assertEqual(wrongEnv.code, 'E_ENVIRONMENT_MISMATCH', '换终端必须拒绝');
    assert(String(wrongEnv.message ?? '').includes('不可转让'), '拒绝原因应说明"凭证不可转让"');
    assertEqual((await post('/api/reading/open', { grantId: boundId, environmentId: 'WS-01' })).ok, true, '回到授权终端应可读');

    /* ④ 本系统停用（只作用于本系统：真实撤销应由授权平台发起） */
    assertEqual((await post('/api/reading/revoke', { grantId: boundId })).ok, true, '停用应成功');
    assertEqual((await post('/api/reading/open', { grantId: boundId, environmentId: 'WS-01' })).code, 'E_GRANT_REVOKED', '停用后必须拒绝');

    /* ⑤ 文档不匹配：授权绑定的是那一份内容，换一份病历读不了 */
    const activeBefore = (await state()).activeDocId;
    const otherDoc = (await state()).tree.flatMap((patient) => patient.visits.flatMap((visit) => visit.docs)).find((doc) => doc.docId !== activeBefore);
    assert(!!otherDoc, '前置：工作区里应有另一份病历');
    assertEqual((await post('/api/open', { docId: otherDoc!.docId })).ok, true, '应能切换到另一份病历');
    const wrongDoc = await post('/api/reading/open', { grantId, environmentId: 'WS-01' });
    assertEqual(wrongDoc.code, 'E_DOCUMENT_CHANGED', '授权与文档不匹配必须拒绝');
    assertEqual((await post('/api/open', { docId: activeBefore })).ok, true, '切回原病历');
  });

  await test('B16 界面导出的文档 JSON 能被独立探针（S5 模型校验）直接接受', async () => {
    /* 这条用例的意义：把"界面导出的产物"与"第三方校验器"接起来。
       现场做真实数据验证时走的就是这条路，导出 JSON 后直接喂给独立探针，
       结论不经过我们的解析器，避免"自说自话"。 */
    const exported = await post('/api/export-json', {});
    assertEqual(exported.ok, true, `导出应成功（${exported.code ?? ''} ${exported.message ?? ''}）`);
    const record = exported.state!.lastJson!;
    assert(!!record, '应记录最近一次导出');
    assert(record.nodes > 0, `应导出真实节点数，实际 ${record.nodes}`);
    assert(existsSync(record.file), `JSON 文件应落盘：${record.file}`);

    const probe = spawnSync(process.execPath, ['tools/model-check/schema-validate.mjs', record.file], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    assertEqual(probe.status, 0, `S5 独立校验应通过：\n${probe.stdout}\n${probe.stderr}`);
    assert((probe.stdout ?? '').includes('通过：1'), `S5 应报告 1 份通过，实际输出：\n${probe.stdout ?? ''}`);
  });

  await test('B17 加密交付（HTTP 全链路）：授权即密钥交付，换接收方连密钥都解不开', async () => {
    /* 本系统不签发授权：这里由"授权平台"（测试自建钥匙）签发。
       注意分工，密钥交付片段（keyDelivery）进授权书（要被签名覆盖，所以由平台签的那份承载），
       而密文信封是（内容提供方）本系统的产物，不在授权书里，随凭据一起登记。 */
    const current = await state();
    const exported = await post('/api/export-json', {});
    assertEqual(exported.ok, true, `导出文档 JSON 应成功：${exported.code ?? ''}`);
    const docJson = readFileSync(exported.state!.lastJson!.file, 'utf8');

    const platform = demoKeyPair('dept-authz-platform-b17');
    const platformSigner = softwareSigner(platform.privateKey);
    assertEqual(
      (await post('/api/reading-authority', { adminId: 'ADMIN', trustedIssuerFingerprint: publicKeyFingerprint(platform.publicKey) })).ok,
      true,
      '授权平台应可配置',
    );

    /* 用接收方公钥封装内容密钥：两处封装（信封 / 授权书片段）必须解出同一把密钥 */
    const recipient = demoKeyPair('dept-a-2026');
    const sealed = sealDocumentJson(docJson, {
      publicKey: recipient.publicKey,
      fingerprint: publicKeyFingerprint(recipient.publicKey),
    });
    const grant: ReadingGrant = {
      grantId: 'grant_b17_enc',
      docId: current.activeDocId,
      documentFingerprint: current.reading.documentFingerprint,
      notBefore: new Date(Date.now() - 3_600_000).toISOString(),
      notAfter: new Date(Date.now() + 3_600_000).toISOString(),
      maxReads: 3,
      allowedEnvironments: ['WS-01'],
      allowedSections: ['*'],
      concealPatientIdentity: false,
      issuedBy: 'AUTHZ_PLATFORM',
      issuedAt: new Date().toISOString(),
      purpose: '加密交付会诊',
      keyDelivery: sealed.keyDelivery,
    };
    const imported = await post('/api/reading/import-credential', {
      text: JSON.stringify(await issueReadingGrant(grant, platformSigner)),
      envelope: sealed.envelope,
      recipientSeed: 'dept-a-2026',
      recipientLabel: '张医生（演示种子）',
    });
    assertEqual(imported.ok, true, `加密交付凭据应可导入（${imported.code ?? ''} ${imported.message ?? ''}）`);
    const record = imported.state!.reading.grants.find((item) => item.grantId === 'grant_b17_enc')!;
    assertEqual(record.encryptedDelivery, true, '授权应标记为加密交付');

    /* ① 持钥方阅读：解封成功，视图来源必须标注为"解封"（否则用户分不清读的是明文还是密文） */
    const ok = await post('/api/reading/open', { grantId: 'grant_b17_enc', environmentId: 'WS-01', recipientSeed: 'dept-a-2026' });
    assertEqual(ok.ok, true, `持钥方应能阅读（${ok.code ?? ''} ${ok.message ?? ''}）`);
    assertEqual(ok.state!.reading.lastViewSource, 'unsealed', '视图来源应标注为解封后的加密阅读');
    assert((ok.state!.reading.lastView?.sections.length ?? 0) > 0, '视图应含章节');
    assert(
      (await state()).log.some((entry) => String((entry as unknown as { action?: string }).action ?? '').includes('已解封内容密钥')),
      '日志应记录"已解封内容密钥"（可审计）',
    );

    /* ② 换接收方（另一把私钥）→ 连内容密钥都解不出来（这是密码学事实，不是界面开关） */
    const wrong = await post('/api/reading/open', { grantId: 'grant_b17_enc', environmentId: 'WS-01', recipientSeed: 'dept-b-2026' });
    assertEqual(wrong.code, 'E_RECIPIENT_MISMATCH', '换接收方必须拒绝');
    assert(String(wrong.message ?? '').includes('不可转让'), '拒绝原因应说明"凭证不可转让"');

    /* ③ 明文授权仍走明文路径：两种模式并存但互不污染 */
    const plainGrant: ReadingGrant = { ...grant, grantId: 'grant_b17_plain', purpose: '明文会诊' };
    delete (plainGrant as { keyDelivery?: unknown }).keyDelivery;
    assertEqual(
      (await post('/api/reading/import-credential', { text: JSON.stringify(await issueReadingGrant(plainGrant, platformSigner)) })).ok,
      true,
      '明文授权应可导入',
    );
    const plainRecord = (await state()).reading.grants.find((item) => item.grantId === 'grant_b17_plain')!;
    assertEqual(plainRecord.encryptedDelivery, false, '没有密钥交付片段时应标记为明文阅读');
    const plainOpen = await post('/api/reading/open', { grantId: 'grant_b17_plain', environmentId: 'WS-01' });
    assertEqual(plainOpen.ok, true, `明文授权应能阅读（${plainOpen.code ?? ''} ${plainOpen.message ?? ''}）`);
    assertEqual(plainOpen.state!.reading.lastViewSource, 'plaintext', '明文阅读来源应标注为明文');
  });

  await test('B18 接收方公钥目录：非法公钥被拒 → 导入 → 重复被拒 → 公钥保真 → 移除（它是"交付目标"的登记处）', async () => {
    /* 目录的用途是登记交付目标：授权平台签发"加密交付"授权时，需要用接收方公钥封装内容密钥。
       本系统只保存与核对公钥（可导出交给平台），不持有任何私钥。
       演示里接收方公钥由种子派生（生产由对方密码设备生成，只把公钥交出来）。 */
    const recipient = demoKeyPair('dept-c-2026');
    const spkiBase64 = Buffer.from(publicKeyToSpki(recipient.publicKey)).toString('base64');
    const pem = `-----BEGIN PUBLIC KEY-----\n${spkiBase64.match(/.{1,64}/g)!.join('\n')}\n-----END PUBLIC KEY-----`;

    /* ① 非法公钥（改动 X 一字节 → 点不在曲线上）必须被拒，且错误码要归因准确 */
    const der = new Uint8Array(Buffer.from(spkiBase64, 'base64'));
    const flipAt = der.length - 33; // X 坐标的最后一个字节
    const tampered = new Uint8Array(der);
    tampered.set([((tampered[flipAt] ?? 0) ^ 0x01) & 0xff], flipAt);
    const bad = await post('/api/recipient-keys/import', { label: '坏公钥', text: Buffer.from(tampered).toString('base64') });
    assertEqual(bad.ok, false, '非法公钥必须被拒');
    assertEqual(bad.code, 'E_KEY_NOT_ON_CURVE', `应归因为"点不在曲线上"（而不是结构问题），实际 ${bad.code}`);
    assert(String(bad.message ?? '').includes('没有任何私钥能解开'), '拒绝原因要说明后果，否则用户以为只是格式挑剔');

    /* ② 合法公钥（PEM）导入成功 */
    const imported = await post('/api/recipient-keys/import', { label: '张医生', text: pem });
    assertEqual(imported.ok, true, `导入应成功（${imported.code ?? ''} ${imported.message ?? ''}）`);
    const keyId = String((imported.data as unknown as { key?: { keyId?: string } } | undefined)?.key?.keyId ?? '');
    assert(keyId.startsWith('rk_'), '应返回 keyId');
    const listed = (await state()).recipientKeys.keys.find((key) => key.keyId === keyId);
    assert(!!listed, '目录里应能查到该接收方');
    assertEqual(listed.label, '张医生', '标签应保真（中文）');
    assertEqual(String(listed.fingerprint).length, 64, '指纹应为完整 64 位（A6 纪律：服务端不截断）');

    /* ③ 同一把公钥重复导入必须被拒（否则"选哪一行"会随列表顺序变化） */
    const duplicate = await post('/api/recipient-keys/import', { label: '张医生（副本）', text: pem });
    assertEqual(duplicate.code, 'E_KEY_DUPLICATE', '重复公钥应被拒');

    /* ④ 公钥必须逐字节保真：它是交给授权平台去封装内容密钥的东西，
       转码出错等于"封给另一个人"，而且不会有任何报错，只会在对方那里解不开 */
    assertEqual(listed.spkiBase64, spkiBase64, 'SPKI 公钥应原样保存（交给平台的那一份，必须保真）');

    /* ⑤ 移除条目：它只是"交付目标的登记"，不是密钥本身（移除不影响任何已登记的授权） */
    assertEqual((await post('/api/recipient-keys/remove', { keyId })).ok, true, '移除应成功');
    assertEqual((await state()).recipientKeys.keys.some((key) => key.keyId === keyId), false, '目录里应已移除');
  });

  await test('B19 审计报告：与实际状态一致、带自身指纹、可复核、JSON+MD 双份落盘', async () => {
    const generated = await post('/api/audit-report', {});
    assertEqual(generated.ok, true, `生成应成功（${generated.code ?? ''} ${generated.message ?? ''}）`);
    const audit = generated.state!.lastAudit!;
    assert(!!audit, 'state 应记录最近一次审计报告摘要');
    assertEqual(audit.total, 7, '应有 7 项机器可判定检查');
    assertEqual(audit.passed + audit.failed.length, audit.total, '通过数 + 失败数应等于总数');
    assertEqual(String(audit.reportDigest).length, 64, '报告应带 64 位指纹');
    assert(existsSync(audit.jsonPath), `JSON 应落盘：${audit.jsonPath}`);
    assert(existsSync(audit.mdPath), `Markdown 应落盘：${audit.mdPath}`);

    const report = (generated.data as unknown as { report: Parameters<typeof verifyAuditReport>[0] }).report;
    const current = await state();
    assertEqual(report.docId, current.activeDocId, '报告应对应当前病历');
    assertEqual(report.status, current.doc.status, '报告状态应与文档一致');
    assertEqual(report.facts.gateLogProvided, true, 'Demo 必须把门控日志传进报告（否则这一节会缺失）');
    assert(
      report.facts.gateRejectionCount >= 1,
      `前面用例制造过门控拒绝，报告应统计到：实际 ${report.facts.gateRejectionCount}`,
    );
    /* 已签章且内容全部确认过 → "已签章不含未确认内容"应为通过 */
    const signedCheck = report.checks.find((check) => check.id === 'SIGNED_WITHOUT_UNCONFIRMED')!;
    assertEqual(signedCheck.pass, true, `已签章文档不应有未确认内容：${signedCheck.detail}`);

    /* 报告指纹可复核；改一个数字必须对不上（否则"审计报告"本身可被编辑） */
    assertEqual(verifyAuditReport(report).ok, true, '未改动的报告应通过复核');
    const tampered = { ...report, facts: { ...report.facts, revisionCount: report.facts.revisionCount + 1 } };
    assertEqual(verifyAuditReport(tampered).ok, false, '改过数字的报告必须复核失败');

    /* Markdown 必须带"不构成合规结论"的说明（避免被当成合规文件外发） */
    const markdown = readFileSync(audit.mdPath, 'utf8');
    assert(markdown.includes('不构成合规结论'), 'Markdown 应包含免责说明');
    assert(markdown.includes(report.reportDigest), 'Markdown 应写出报告指纹，便于与 JSON 对照');
  });

  await test('B17 确认减负（HTTP 全链路）：按章节确认 + 待确认口径必须含 AI 内容', async () => {
    /* 前面的用例已经把当前病历签章了，已签章文档不能再改（E_SIGNED_IMMUTABLE）。
       这不是缺陷，正是"签后不可改"在工作，所以本用例先切到一份未签章的病历。 */
    const s0 = await state();
    const docs = s0.tree.flatMap((patient) => patient.visits).flatMap((visit) => visit.docs);
    const fresh = docs.find((doc) => !doc.active && doc.status !== 'signed');
    assert(!!fresh, '前置：演示数据里应有一份未签章的病历（否则覆盖不到确认流程）');
    assertEqual((await post('/api/open', { docId: fresh!.docId })).ok, true, '切换到未签章病历');

    const s0b = await state();
    const textItem = s0b.items.find((item) => item.kind === 'text');
    assert(!!textItem, '前置：应有文本节点');

    /* 造一条未确认的 AI 内容：AI 出建议 → 人工采纳（采纳 ≠ 确认责任） */
    const sug = await post('/api/suggest', { nodeId: textItem!.id, confidence: 0.9 });
    assertEqual(sug.ok, true, `出建议应成功：${sug.message ?? ''}`);
    await post('/api/accept', { suggestionId: String((sug.data as { suggestionId?: string } | undefined)?.suggestionId ?? '') });

    /* ① 采纳后仍待确认；且左栏"待确认"计数必须把 AI 内容算进去，
       原先只数关键内容，会出现"左栏显示 0 待确认、点签章却被拒"，
       那是最让人失去信任的一类不一致（本轮修掉的正是它） */
    const s1 = await state();
    assertEqual(s1.items.find((item) => item.id === textItem!.id)?.humanConfirmed, false, '采纳 ≠ 确认责任');
    const active1 = s1.tree.flatMap((p) => p.visits).flatMap((v) => v.docs).find((doc) => doc.active);
    assert(!!active1, '应能找到当前活动病历');
    assert(active1!.unconfirmed > 0, '左栏待确认计数必须反映"会挡住签章的内容"（含 AI 内容）');

    /* ② 按章节确认：整章子树内的内容节点一次确认完 */
    const dirty = active1!.sections.filter((section) => section.hasUnconfirmed);
    assert(dirty.length > 0, '前置：应有待确认的章节');
    for (const section of dirty) {
      const r = await post('/api/confirm-subtree', { nodeId: section.id });
      assertEqual(r.ok, true, `按章节确认应成功：${r.message ?? ''}`);
    }
    const s2 = await state();
    const active2 = s2.tree.flatMap((p) => p.visits).flatMap((v) => v.docs).find((doc) => doc.active);
    assertEqual(active2?.unconfirmed, 0, '按章节确认后应无待确认内容');
    assertEqual(
      active2?.sections.every((section) => !section.hasUnconfirmed),
      true,
      '章节的待确认标记应全部清除（否则左栏会一直提示）',
    );

    /* ③ 确认完应可签章（默认不声明也能签，因为确实没有未确认内容了） */
    const sign = await post('/api/sign', {});
    assertEqual(sign.ok, true, `确认后应可签章：${sign.code ?? ''} ${sign.message ?? ''}`);
  });

  await test('B20 语音落点确认：未落位不生成建议，医生指定落点后才提交（门控不松）', async () => {
    /* 把落位策略切到"按章节词"且规则故意不命中，制造"全部未落位"的场景。
       这条闭环的意义：落位是"建议的初始落点"，猜不中时必须能交回人工，而不是静默兜底。 */
    const candidates = (await state()).placementCandidates;
    assert(candidates.length > 0, 'state 应下发落位候选节点（界面据此渲染落点下拉）');
    const saved = await post('/api/placement-config', {
      adminId: 'ADMIN',
      strategy: 'section-title',
      candidate: { onlyTextNodes: true },
      sectionMap: { '绝不出现的词': candidates[0]?.nodeId },
      confidenceCeiling: 0.85,
    });
    assertEqual(saved.ok, true, `落位配置应可保存：${saved.code ?? ''}`);

    const dictated = await post('/api/dictate', {});
    const record = dictated.data as unknown as {
      transcriptionId: string;
      segments: Array<{ index: number }>;
      submitted: boolean;
      unplaced: number;
    } | undefined;
    assert(!!record && record.segments.length > 0, '应返回转写记录');
    assertEqual(record!.submitted, false, '全部未落位时不得生成建议（内核不接受"半落位"）');
    assert(record!.unplaced > 0, '应回报未落位段数');

    /* 缺段提交必须被拒 */
    const incomplete = await post('/api/dictate-commit', {
      transcriptionId: record!.transcriptionId,
      targets: [{ index: record!.segments[0]!.index, nodeId: candidates[0]!.nodeId }],
    });
    assertEqual(incomplete.code, 'E_PLACEMENT_INCOMPLETE', '缺段提交应被拒（E_PLACEMENT_INCOMPLETE）');

    /* 转写标识对不上必须被拒：否则会把落点装到另一次录音上 */
    const stale = await post('/api/dictate-commit', { transcriptionId: 'audio-not-current', targets: [] });
    assertEqual(stale.code, 'E_DICTATION_STALE', '转写标识不一致应被拒（E_DICTATION_STALE）');

    /* 逐段指定后提交 → 生成建议；门控不松：仍是待处理，必须人工采纳 */
    const commit = await post('/api/dictate-commit', {
      transcriptionId: record!.transcriptionId,
      targets: record!.segments.map((segment, index) => ({ index: segment.index, nodeId: candidates[index % candidates.length]!.nodeId })),
    });
    assertEqual(commit.ok, true, `落点确认后应提交成功：${commit.code ?? ''} ${commit.message ?? ''}`);
    const after = await state();
    assert(
      after.suggestions.filter((item) => item.status === 'pending').length >= record!.segments.length,
      `应生成至少 ${record!.segments.length} 条待处理建议（落点由医生给，内容来源仍是 ASR，门控不松）`,
    );

    /* 复位策略：本用例排在最后，但"改过就复原"是好习惯 */
    await post('/api/placement-config', { adminId: 'ADMIN', strategy: 'ordered', candidate: { onlyTextNodes: true }, confidenceCeiling: 0.85 });
  });

  await test('B21 授权平台：未配置时拒绝一切凭据；自洽但来源不可信的凭据必须被拒', async () => {
    /* 三件事要同时证明：
       ① 未配置信任根时，一份完全自洽的凭据也必须被拒（fail-closed，宁可暂时不可用）；
       ② 配了平台之后，别的钥匙签的自洽凭据仍被拒（信任根是唯一判定点）；
       ③ 本系统不签发授权：那个入口要明确说明，而不是 404（404 会被读成"版本不对"）。 */
    const current = await state();

    /* 先清空授权平台配置，制造"未配置"现场 */
    assertEqual((await post('/api/reading-authority', { adminId: 'ADMIN' })).ok, true, '应可清空授权平台配置');
    assertEqual((await state()).readingAuthority?.configured, false, '清空后应为"未配置"');

    const platform = demoKeyPair('dept-authz-platform-b21');
    const other = demoKeyPair('not-the-platform-b21');
    const grant: ReadingGrant = {
      grantId: 'grant_b21',
      docId: current.activeDocId,
      documentFingerprint: current.reading.documentFingerprint,
      notBefore: new Date(Date.now() - 3_600_000).toISOString(),
      notAfter: new Date(Date.now() + 3_600_000).toISOString(),
      maxReads: 2,
      allowedEnvironments: [],
      allowedSections: ['*'],
      concealPatientIdentity: false,
      issuedBy: 'AUTHZ_PLATFORM',
      issuedAt: new Date().toISOString(),
      purpose: '院内会诊',
    };

    /* ① 未配置 → 拒绝一切（这份凭据本身完全自洽） */
    const credential = await issueReadingGrant(grant, softwareSigner(platform.privateKey));
    const notConfigured = await post('/api/reading/import-credential', { text: JSON.stringify(credential) });
    assertEqual(notConfigured.code, 'E_UNTRUSTED_ISSUER', '未配置授权平台时必须拒绝');
    assert(String(notConfigured.message ?? '').includes('尚未配置'), '理由要说清"尚未配置"，而不是含糊的"无权"');

    /* ② 配上平台，但用另一把钥匙签的凭据仍必须被拒 */
    assertEqual(
      (await post('/api/reading-authority', { adminId: 'ADMIN', trustedIssuerFingerprint: publicKeyFingerprint(platform.publicKey) })).ok,
      true,
      '应可配置授权平台',
    );
    const wrongIssuer = await issueReadingGrant({ ...grant, grantId: 'grant_b21_wrong' }, softwareSigner(other.privateKey));
    const untrusted = await post('/api/reading/import-credential', { text: JSON.stringify(wrongIssuer) });
    assertEqual(untrusted.code, 'E_UNTRUSTED_ISSUER', '不在信任集内的签发者必须被拒');

    /* 形状不对：要报"内容不对"，而不是抛内部错误 */
    const malformed = await post('/api/reading/import-credential', { text: '{ 不是 JSON' });
    assertEqual(malformed.code, 'E_CREDENTIAL_MALFORMED', '畸形凭据应报形状错误');

    /* 平台签的那一份可以导入 */
    assertEqual((await post('/api/reading/import-credential', { text: JSON.stringify(credential) })).ok, true, '平台签发的凭据应可导入');

    /* ③ 本系统不签发：入口要明确说明，而不是 404 */
    const denied = await post('/api/reading/grant', { purpose: '试试看' });
    assertEqual(denied.ok, false, '本系统不得签发授权');
    assertEqual(denied.code, 'E_AUTHORITY_NOT_ISSUABLE', '应给出"本系统不签发"的明确错误码');
    assert(String(denied.message ?? '').includes('院内授权平台'), '说明里要指出授权该从哪来（否则用户不知道下一步做什么）');

    /* 复位：本用例排在最后，但"改过就复原"是好习惯 */
    await post('/api/reading-authority', { adminId: 'ADMIN' });
  });

  await test('B22 未配置签名服务：签章被明确拒绝（本系统不提供"内置软件签名"）', async () => {
    /* 这条是本轮改动的机器证明：去掉内置软件签名之后，没接上医院签名服务的环境签不了章，
       而不是悄悄用演示密钥签一份"看起来成功"的章（那是最危险的一种假象）。 */
    const cleared = await post('/api/sign-backend-config', { adminId: 'ADMIN' });
    assertEqual(cleared.ok, true, '清空签名配置应成功');
    assertEqual((cleared.data as { configured?: boolean } | undefined)?.configured, false, '清空后应处于"不可签章"状态');

    const denied = await post('/api/sign', { acknowledgeUnconfirmed: true });
    assertEqual(denied.code, 'E_SIGN_NOT_CONFIGURED', `未配置签名服务时签章必须被拒，实际：${denied.code ?? ''} ${denied.message ?? ''}`);
    assert(
      String(denied.message ?? '').includes('内置软件签名'),
      '拒绝理由要说清"没有内置软件签名可回退"，否则会被读成一次普通的配置错误',
    );

    /* 复原：把靶子签名服务配回去（`configureSignService` 自身已断言 `configured=true`），
       并复核状态视图回到"可签章"，"管理员改完立即生效、无需重启"这条承诺也顺带被验证。

       这里不重签：已签章文档要重签须走"解锁 → 留痕 → 重新签章"，那是内核的另一条纪律
       （`E_SIGNED_IMMUTABLE`）。把它混进来只会让失败原因含混，与本用例要证的事无关。 */
    await configureSignService();
    const restored = await state();
    assertEqual(restored.signBackend?.configured, true, '配回签名服务后应恢复"可签章"状态');
  });

  await test('B23 生成幂等：连点不再堆重复，且界面必须说清"未重复生成"并默认只看待处理', async () => {
    /* 从干净起点开始：建议是旁挂数据，随"重置工作区"一起清。
       （本用例放在最后，重置不影响其它用例；这也顺带验证了"重置连旁挂数据一起清"。） */
    await resetWorkspace();
    const start = await state();
    const target = start.items.find((item) => item.kind === 'text');
    assert(!!target, '用例前提：应有一个文本节点可产出建议');
    assertEqual(start.suggestions.length, 0, '重置后应没有建议（旁挂数据也随重置清掉）');

    /* ① 同节点、同产出方式，连点两次：第二次复用并回报 */
    const first = await post('/api/suggest', { nodeId: target!.id, mode: 'complete' });
    assertEqual(first.ok, true, `首次产出应成功：${first.code ?? ''} ${first.message ?? ''}`);
    assertEqual((first.data as { reused?: boolean }).reused, false, '首次产出不应是复用');
    const second = await post('/api/suggest', { nodeId: target!.id, mode: 'complete' });
    assertEqual((second.data as { reused?: boolean }).reused, true, '同节点 + 同产出方 + 同内容且仍待处理 → 应复用');
    assertEqual(
      (second.data as { suggestionId?: string }).suggestionId,
      (first.data as { suggestionId?: string }).suggestionId,
      '复用的应是同一条建议',
    );

    const afterRepeat = await state();
    assertEqual(afterRepeat.suggestions.filter((item) => item.status === 'pending').length, 1, '建议数不应随点击次数膨胀');
    assertEqual(afterRepeat.metrics.suggested, 1, '指标同样不应膨胀（否则采纳率/拒绝率被点击次数稀释）');
    assert(
      afterRepeat.log.some((item) => (item.action ?? '').includes('未重复生成')),
      '活动日志要说明"为什么没多出一条"，否则医生会以为点了没反应（系统坏了）',
    );

    /* ② 换一种产出方式 → 内容不同，就是新建议 */
    const polished = await post('/api/suggest', { nodeId: target!.id, mode: 'polish' });
    assertEqual((polished.data as { reused?: boolean }).reused, false, '内容不同不应复用');
    assertEqual((await state()).suggestions.filter((item) => item.status === 'pending').length, 2, '内容不同应新增一条');

    /* ③ 整批：再点一次"生成整批"应当一条都不新增，且不建空组 */
    const batchFirst = await post('/api/suggest-batch', { mode: 'draft' });
    assertEqual((batchFirst.data as { suggestionIds?: string[] }).suggestionIds?.length, 3, '首次整批应产出三条');
    const batchAgain = await post('/api/suggest-batch', { mode: 'draft' });
    assertEqual((batchAgain.data as { suggestionIds?: string[] }).suggestionIds?.length, 0, '重复整批不应新增');
    assertEqual((batchAgain.data as { reused?: string[] }).reused?.length, 3, '三条都应回报复用');
    assertEqual(
      (batchAgain.data as { groupId?: string }).groupId,
      undefined,
      '全重复时不应建组（空组会让界面的"接受本组"落在一个不存在的范围上）',
    );

    /* ④ 界面契约：默认只渲染待处理、有切换入口、幂等要显式提示，数据一条不删 */
    assert(/id="btnToggleProcessed"/.test(markup), '应有"显示已处理（含拒绝）"开关');
    assert(/id="suggCounts"/.test(markup) && /id="suggNotice"/.test(markup), '应有计数行与幂等提示位');
    assert(/showProcessedSuggestions \? all : pending/.test(script), '默认只渲染待处理（过滤只在显示层）');
    assert(/reused === true/.test(script), '界面必须识别 reused 并提示');
  });

  await test('B24 导出区：一个「导出」主按钮 + 产物清单（两种产物各自成卡、下载随产物出现）', async () => {
    /* ① 静态契约：顶栏只剩「签章」与「导出」；下载入口不再钉在顶栏，而是随产物渲染 */
    assert(/id="btnExport"[^>]*>导出</.test(markup), '顶栏主按钮应叫「导出」');
    assert(!/id="downloadLink"/.test(markup) && !/id="downloadWst500"/.test(markup), '下载入口应随产物渲染，不再钉在顶栏');
    assert(/id="btnExportWst500"/.test(script), '共享文档的导出入口应移进产物清单');
    assert(/OFD-H 归档定版/.test(script) && /WS\/T 500 共享文档/.test(script), '产物清单应始终给出两张卡（没有导过也要能看出两种产物的分工）');

    /* ② HTTP 契约：两种产物是两条分开的路，导出其中一个不会顺带产出另一个 */
    await resetWorkspace();
    const clean = await state();
    assertEqual(clean.lastExport, null, '重置后不应有归档产物记录');
    assertEqual(clean.lastWst500, null, '重置后不应有共享文档记录');

    /* 归档导出唯一的运行时门就是机读信息新鲜度：重置后还没派生 → 应当被挡（不导出半成品）。
       界面卡上写的就是这句"可能被拦的只有两种情况"，这里逐条对上。 */
    const blocked = await post('/api/export');
    assertEqual(blocked.code, 'E_MACHINE_READABLE_STALE', '机读信息未派生时，归档导出应被挡');
    assertEqual((await post('/api/refresh-machine', {})).ok, true, '重算机读信息应成功（界面上是「机读信息 → 重算」）');

    const exported = await post('/api/export');
    assertEqual(exported.ok, true, `导出 OFD-H 应成功：${exported.code ?? ''} ${exported.message ?? ''}`);
    const afterArchive = await state();
    assert(!!afterArchive.lastExport, '应记录归档产物');
    assertEqual(afterArchive.lastWst500, null, '导归档产物不应顺带产出共享文档（两者是分开的动作）');

    const shared = await post('/api/export-wst500');
    assertEqual(shared.ok, true, `导出共享文档应成功：${shared.code ?? ''} ${shared.message ?? ''}`);
    const afterBoth = await state();
    assert(!!afterBoth.lastExport && !!afterBoth.lastWst500, '两份产物应同时在案（同一份病历两者都留）');

    /* ③ 两条下载链路都要通（界面按产物渲染链接，链接背后得真能取到文件） */
    assertEqual((await fetch(`http://127.0.0.1:${PORT}/api/download`)).status, 200, '归档产物下载应可用');
    assertEqual((await fetch(`http://127.0.0.1:${PORT}/api/download-wst500`)).status, 200, '共享文档下载应可用');
  });

  await test('B25 段落级编辑：编辑是区间替换、增删移一路到底、关键内容禁删连父节点也绕不过', async () => {
    await resetWorkspace();
    const start = await state();

    /* ① 编辑 = 区间替换（不是整段覆盖）：响应带最小改动区间，留痕写明区间 */
    const target = start.items.find((item) => item.kind === 'text' && (item.text ?? '').length > 4);
    assert(!!target, '用例前提：应有一个可用文本节点');
    const original = target!.text as string;
    const edited = `${original.slice(0, 2)}改了${original.slice(2)}`;
    const edit = await post('/api/edit', { nodeId: target!.id, text: edited });
    assertEqual(edit.ok, true, `编辑应成功：${edit.code ?? ''} ${edit.message ?? ''}`);
    const span = (edit.data as { span?: { start: number; end: number; text: string } }).span;
    assertEqual(span?.start, 2, '最小改动区间应从第 2 个字符开始');
    assertEqual(span?.end, 2, '纯插入不该把后面的内容算进区间');
    assertEqual(span?.text, '改了', '区间内容应是新插入的那几个字');
    assertEqual((await state()).items.find((item) => item.id === target!.id)?.text, edited, '正文应为编辑后的内容');
    assert(
      ((await state()).log[0]?.action ?? '').includes('区间 2~2'),
      '留痕要写明改动区间，否则"改了一个标点"会表现成"整段重写"',
    );
    /* 文本没变 → 不提交、不留痕：点进点出编辑框不该留下记录 */
    const logBefore = (await state()).log.length;
    const noop = await post('/api/edit', { nodeId: target!.id, text: edited });
    assertEqual(noop.ok, true, '无改动应正常返回');
    assertEqual((await state()).log.length, logBefore, '无改动不应产生留痕');

    /* ② 插入段落：新段落排在锚点之后，且立刻可写 */
    const anchorIndex = (await state()).items.findIndex((item) => item.id === target!.id);
    const inserted = await post('/api/insert-paragraph', { nodeId: target!.id });
    assertEqual(inserted.ok, true, `插入段落应成功：${inserted.code ?? ''} ${inserted.message ?? ''}`);
    const newTextId = (inserted.data as { textNodeId?: string }).textNodeId as string;
    assert(!!newTextId, '应返回新段落的文本节点 id（界面用它把光标放进去）');
    const afterInsert = await state();
    assert(afterInsert.items.findIndex((item) => item.id === newTextId) > anchorIndex, '新段落应排在锚点之后');
    assertEqual((await post('/api/edit', { nodeId: newTextId, text: '新段落内容' })).ok, true, '新段落应能直接写入');

    /* ③ 上移：一次提交把整段挪上去（连带它的字段，而不是把字段落在原地） */
    const moved = await post('/api/move-node', { nodeId: newTextId, direction: 'up' });
    assertEqual(moved.ok, true, `上移应成功：${moved.code ?? ''} ${moved.message ?? ''}`);
    const afterMove = await state();
    assert(
      afterMove.items.findIndex((item) => item.id === newTextId) <
        afterMove.items.findIndex((item) => item.id === target!.id),
      '上移后新段落应排在锚点之前',
    );
    const first = afterMove.items.find((item) => item.kind === 'text' && item.paragraphFirst === true);
    assert(!!first, '应能识别出本节第一段（界面据此禁用「↑」）');
    const boundary = await post('/api/move-node', { nodeId: first!.id, direction: 'up' });
    assertEqual(boundary.code, 'E_ALREADY_AT_BOUNDARY', '已在边界必须明确报出，而不是静默不动');

    /* ④ 删除段落：连同它的文本与字段一起删（不留一个看不见的空段落） */
    const removed = await post('/api/delete-node', { nodeId: newTextId });
    assertEqual(removed.ok, true, `删除段落应成功：${removed.code ?? ''} ${removed.message ?? ''}`);
    assertEqual((await state()).items.some((item) => item.id === newTextId), false, '段落应被删除');

    /* ⑤ 关键内容禁删：删父节点（段落子树）也不能绕过，演示病历里"主诉"就是关键内容。
       这一条是本轮修掉的漏洞：原先禁删只看目标节点，而 keyContent 标在文本节点上，
       于是"删段落"可以把它连带删掉。 */
    const keyItem = (await state()).items.find((item) => item.kind === 'text' && item.keyContent === true);
    assert(!!keyItem, '用例前提：演示病历里应有标为关键内容的段落');
    const keyDelete = await post('/api/delete-node', { nodeId: keyItem!.id });
    assertEqual(keyDelete.code, 'E_KEY_CONTENT_PROTECTED', '关键内容必须禁止删除，删父节点也不行');
    assertEqual((await state()).items.some((item) => item.id === keyItem!.id), true, '被拒后内容必须原样还在');

    /* ⑥ 界面契约：段落按钮存在；关键内容的「删段」在渲染时就是禁用的；
       首/末段的「↑」「↓」同理，界面上不该摆按下去必然失败的按钮；插入后要聚焦新段落 */
    assert(
      /data-para-insert=/.test(script) && /data-para-up=/.test(script) && /data-para-down=/.test(script) && /data-para-delete=/.test(script),
      '应有段落级增 / 移 / 删按钮',
    );
    assert(/attr\(!locked && !item\.keyContent, deleteHint\)/.test(script), '关键内容的「删段」必须渲染成禁用');
    assert(
      /attr\(!locked && !item\.paragraphFirst, /.test(script) && /attr\(!locked && !item\.paragraphLast, /.test(script),
      '首/末段应禁用「↑」「↓」（locked = 已签章/已归档，同样要锁）',
    );
    assert(/focusEdit\(/.test(script), '插入段落后应把光标放进新段落');
  });

  await test('B26 解锁 / 撤销 / 多行粘贴：让"改完还能签"闭环', async () => {
    await resetWorkspace();
    const start = await state();
    const anchor = start.items.find((item) => item.kind === 'text');
    assert(!!anchor, '用例前提：应有文本节点');
    const anchorId = anchor!.id;

    /* ① 多行粘贴：拆成段落、按外来内容处理、且阻断签章 */
    const pasted = await post('/api/paste-text', { nodeId: anchorId, text: '第一行\n   \n第二行\n第三行' });
    assertEqual(pasted.ok, true, `粘贴应成功：${pasted.code ?? ''} ${pasted.message ?? ''}`);
    const pastedIds = (pasted.data as { textNodeIds?: string[] }).textNodeIds ?? [];
    assertEqual(pastedIds.length, 3, '三行应拆成三段（空白行丢弃）');
    const afterPaste = await state();
    const pastedItems = pastedIds.map((id) => afterPaste.items.find((item) => item.id === id));
    assertEqual(pastedItems.every((item) => item?.origin === 'imported'), true, '粘贴内容必须标为外来内容');
    assertEqual(pastedItems.every((item) => item?.humanConfirmed === false), true, '外来内容必须待确认（搬运不等于核对）');
    assertEqual(pastedItems[0]?.text, '第一行', '内容应逐段落入');
    assertEqual(pastedItems[2]?.text, '第三行', '最后一行也要落进去（漏掉末行是最常见的边界错误）');
    /* 界面契约：只拦多行，单行粘贴保持原生（它是"编辑这一段"，不是"新增段落"） */
    assert(/if \(!\/\[\\r\\n\]\/\.test\(text\)\) return;/.test(script), '单行粘贴应保持原生行为');

    /* ② 撤销：撤掉刚才那次粘贴（三段一并收回），且撤销本身进留痕 */
    assert(!!(await state()).undo, '刚粘贴完应存在可撤销项');
    const undo = await post('/api/undo', {});
    assertEqual(undo.ok, true, `撤销应成功：${undo.code ?? ''} ${undo.message ?? ''}`);
    assertEqual((await state()).items.some((item) => pastedIds.includes(item.id)), false, '撤销应把新建的段落一并收回');
    assert(((await state()).log[0]?.action ?? '').includes('撤销第'), '留痕要写清撤的是哪一条（只写"撤销"只能靠猜）');

    /* ③ 解锁闭环：签章 → 改不了 → 解锁（理由必填）→ 可改 → 重新签章 */
    for (const item of (await state()).items.filter((entry) => entry.kind === 'text' || entry.kind === 'field')) {
      await post('/api/confirm', { nodeId: item.id });
    }
    const signed = await post('/api/sign', { acknowledgeUnconfirmed: true });
    assertEqual(signed.ok, true, `签章应成功：${signed.code ?? ''} ${signed.message ?? ''}`);
    assertEqual((await state()).doc.status, 'signed', '签章后状态应为 signed');

    const blocked = await post('/api/edit', { nodeId: anchorId, text: '改一下试试' });
    assertEqual(blocked.code, 'E_SIGNED_IMMUTABLE', '签章后必须改不了');
    assert(String(blocked.message ?? '').includes('解锁'), '拒绝理由要指出"先解锁"这条路，而不是只说"不可改"');

    assertEqual((await post('/api/unlock', { reason: '   ' })).code, 'E_UNLOCK_REASON_REQUIRED', '不给理由的解锁必须被拒（等于静默作废一次签章）');
    const unlocked = await post('/api/unlock', { reason: '纠正诊断笔误' });
    assertEqual(unlocked.ok, true, `解锁应成功：${unlocked.code ?? ''} ${unlocked.message ?? ''}`);
    const afterUnlock = await state();
    assertEqual(afterUnlock.doc.status, 'draft', '解锁后应回到 draft（可改）');
    assert(!!afterUnlock.sign, '原签名材料不删（"签过"是历史事实，不能悄悄变成没签过）');
    assert(
      afterUnlock.log.some((item) => (item.action ?? '').includes('纠正诊断笔误')),
      '解锁必须留下理由（事后追责看的就是它）',
    );
    assertEqual((await post('/api/edit', { nodeId: anchorId, text: '解锁后的修改' })).ok, true, '解锁后应能改内容');

    /* ④ 重新签章：解锁 + 修改之后必须能再次签章（否则"改完"就断在了这里） */
    await post('/api/confirm', { nodeId: anchorId });
    const resigned = await post('/api/sign', { acknowledgeUnconfirmed: true });
    assertEqual(resigned.ok, true, `解锁改完后应能重新签章：${resigned.code ?? ''} ${resigned.message ?? ''}`);
    assertEqual((await state()).doc.status, 'signed', '重新签章后应回到 signed');

    /* ⑤ 撤销槽位在签章后清空：撤销不能变成"绕过签章去改内容"的旁路 */
    assertEqual((await state()).undo, null, '签章之后必须没有可撤销项');
    assertEqual((await post('/api/undo', {})).code, 'E_NOTHING_TO_UNDO', '签章后撤销应被明确拒绝');

    /* ⑥ 界面契约 */
    assert(/id="btnUndo"/.test(markup) && /id="btnUnlock"/.test(markup) && /id="docNotice"/.test(markup), '应有撤销/解锁按钮与正文提示位');
    /* 解锁理由在界面上问出来（自定义弹框的输入态），并要求非空：
       空的理由不许解锁，也不许"先关掉再说一句必须填"（那样理由已经没了） */
    assert(/askText\(\s*'解锁理由/.test(script), '解锁必须在界面就问理由');
    assert(/requiredHint: '必须填写解锁理由。'/.test(script), '解锁理由为空要当场拦住并说明');
    assert(/classList\.toggle\('hide', S\.doc\.status !== 'signed'\)/.test(script), '「解锁修改」只在已签章时出现');
    assert(/本文档已签章：内容不可修改/.test(script), '已签章时正文要写明"为什么改不了、该怎么改"');
  });

  await test('B27 已签章只读 + 解锁后区分"原签章已作废"（不与"被篡改"混为一谈）', async () => {
    /* ① 只读门禁必须与内核那道门同判据（signed / archived），且禁用控件要说明原因，
       不给原因的只读只会被当成"界面卡了"。 */
    assert(/const immutable = signed \|\| S\.doc\.status === 'archived'/.test(script), '只读判据应与内核 commit() 的门一致（signed/archived）');
    /* 只读形态由共用的 `/doc-view.js` 画（参数名是 `readonly`，医生端把 `immutable` 传进去）：
       管理后台的模板预览走的就是这一条只读路径，所以"预览"与"已签章"长得一样是结构决定的 */
    assert(/data-edit="\$\{esc\(item\.id\)\}"\$\{readonly \? ' readonly' : ''\}/.test(script), '已签章/已归档时正文 textarea 应 readonly');
    assert(/data-field="\$\{esc\(item\.id\)\}" value="\$\{esc\(item\.value\)\}"\$\{readonly \? ' readonly' : ''\}/.test(script), '字段输入框同样应 readonly');
    assert(/immutableHint/.test(script) && /已签章：需先「解锁修改」才能改动/.test(script), '只读必须给出原因');
    assert(/attr\(!locked && !item\.keyContent, deleteHint\)/.test(script), '段落级操作同样要锁（否则按下去只会被内核拒）');

    /* ② 已签章时状态应为"当前有效" */
    const signedState = await state();
    assertEqual(signedState.doc.status, 'signed', '前置：B26 结束时本文档已重新签章');
    assertEqual(signedState.signatureState?.kind, 'valid', '已签章时签章状态应为 valid');

    /* ③ 解锁后再看：这是作废，不是被篡改。
       有个容易被写错的细节（本用例第一版就写错了）：解锁本身不改内容，
       所以此刻独立验签仍然通过，于是"看验签"得出的结论是"签章还在"，而它其实已经作废。
       这正是必须由内核给出 `kind` 的理由。 */
    const reason = 'B27 用例：验证作废呈现';
    assertEqual((await post('/api/unlock', { reason })).ok, true, '解锁应成功');
    const after = await state();
    assertEqual(after.doc.status, 'draft', '解锁后回到 draft');
    assertEqual(after.signatureState?.kind, 'voided', '解锁后签章状态应为"已作废"（而不是消失）');
    assertEqual(after.signatureState?.voidedBy?.reason, reason, '解锁理由必须能读到，界面要回答"为什么作废"');
    assert(!!after.signatureState?.voidedBy?.invalidated?.[0]?.publicKeyFingerprint, '被作废的那次签章（指纹）必须留痕可查');
    assertEqual(after.sign?.publicKeyFingerprint, signedState.sign?.publicKeyFingerprint, '原签名材料不删（历史保留，界面要能显示"原签章是什么"）');
    assertEqual(
      after.signatureVerified?.ok,
      true,
      '解锁没改内容 → 验签此刻仍能通过：所以"签章还在"这个结论是错的，只能看 kind（这条断言就是那个反例）',
    );

    /* ④ 改一个字符：现在验签必然失败，而失败的原因是"已作废 + 内容改过"，不是被篡改。
       两个信号（验签失败 / 已作废）必须能分开读，只看验签的话，这一步会被读成"有人动了手脚"。 */
    const editable = after.items.find((item) => item.kind === 'text');
    assert(!!editable, '前置：应有可编辑的正文段落');
    if (editable) {
      const edited = await post('/api/edit', { nodeId: editable.id, text: `${editable.text}（B27 修改）` });
      assertEqual(edited.ok, true, `解锁后应能改内容：${edited.code ?? ''} ${edited.message ?? ''}`);
      const changed = await state();
      assertEqual(changed.signatureVerified?.ok, false, '改了内容之后验签必然不通过');
      assertEqual(changed.signatureState?.kind, 'voided', '失败的只是验签；"已作废"这个判定不变，两者必须分得开');
    }

    /* ⑤ 界面契约：三态分开呈现；作废时不列"验签失败"的理由
       （解锁后一旦改过内容，那些理由必然出现，照列会把人推向"被篡改"的结论） */
    assert(/state\.kind === 'voided'/.test(script), '界面必须按内核的 kind 判断，而不是自己从 verified.ok 反推');
    assert(/原签章已作废（已解锁）/.test(script), '作废要用与"验签失败"不同的呈现');
    assert(/不是被篡改/.test(script), '要写明"验签不通过是作废的应有结果，不是被篡改"');
    assert(/voided \? state\.voidedBy/.test(script), '作废时取解锁理由、时间与被作废签章');
    assert(/const reasons = \(!voided && verify && !verify\.ok/.test(script), '作废时不得再列"验签失败"的理由');

    /* ⑥ 复原：把改过的段落确认后重新签章，回到"当前有效"（不影响其它用例） */
    if (editable) await post('/api/confirm', { nodeId: editable.id });
    const restored = await post('/api/sign', { acknowledgeUnconfirmed: true });
    assertEqual(restored.ok, true, `复原重新签章应成功：${restored.code ?? ''} ${restored.message ?? ''}`);
    assertEqual((await state()).signatureState?.kind, 'valid', '复原后应回到"当前有效"');
  });

  await test('B28 配置视图的 GET 真的能读 + 必填「管理员身份」不该在别的子页签里隐身', async () => {
    /* ① 四份配置各有"现在是什么"的 GET 视图。它们原先写在 switch 的 case 里，
          而 case 排在"非 POST 一律 405"之后，于是那几段永远到不了，
          GET 只会拿到 E_METHOD（真实缺陷，实测 `fetch('/api/model-config')` → `{"code":"E_METHOD"}`）。
          这条用例是它的机器证明：四个端点都必须真的能读。 */
    for (const path of [
      '/api/model-config',
      '/api/placement-config',
      '/api/capture-config',
      '/api/sign-backend-config',
      '/api/reading-authority',
    ]) {
      const r = await get(path);
      assertEqual(r.ok, true, `${path} 的 GET 视图必须能读（此前被 405 guard 挡住，返回 ${r.code ?? ''}）`);
      assert(!!r.data, `${path} 应返回配置视图`);
    }

    /* ② 「管理员身份」是五个子页签共同的前提，界面必须把它放在始终可见处并标必填。
          原先它只长在「AI 模型接入」那一格里：站在「电子签名」子页签点保存时，
          这个必填项在别的页签里根本看不见，报错只说"需要管理员身份"，
          现场表现就是"我填了、点了保存、什么也没变"（曾实测复现）。 */
    /* ② 配置整体搬到管理后台：医生端不再有配置控件，只剩一个入口；
          必填身份与前置校验跟着搬到 `admin.html` / `admin.js`。 */
    const adminMarkup = readFileSync(join(ROOT, 'src', 'demo', 'admin.html'), 'utf8');
    const adminScript = readFileSync(join(ROOT, 'src', 'demo', 'admin.js'), 'utf8');
    /* 登录搬到独立登录页（`/login`）之后，这两份才是"登录字段该在的地方" */
    const loginMarkup = readFileSync(join(ROOT, 'src', 'demo', 'login.html'), 'utf8');
    const loginScript = readFileSync(join(ROOT, 'src', 'demo', 'login.js'), 'utf8');
    /* 注意：这里不能断言"医生端没有 cfg* 控件"，那份标记还在（惰性，见 A6 的过渡期说明），
       删它要同步改本用例。现在能断言的是"入口已经换成管理后台"。 */
    assert(/id="btnAdmin"/.test(html), '医生端应只剩通往管理后台的入口');
    assert(
      /id="loginUsername"[^>]*required/.test(loginMarkup) && /id="loginPassword"[^>]*required/.test(loginMarkup),
      '登录页字段（账号与口令）应标必填',
    );
    /* 两种形态都在源文件里，由服务端在响应时裁掉不需要的那个（见 `renderLoginPage`），
       所以这里断言的是"标记与两种表单都在"，而"实际下发哪一个"由 B32 / B37 打真实服务验。 */
    assert(/id="bootstrapForm"/.test(loginMarkup), '登录页源文件里应有首次初始化表单');
    assert(
      /<!--FORM:LOGIN-->[\s\S]*<!--\/FORM:LOGIN-->/.test(loginMarkup) && /<!--FORM:BOOTSTRAP-->[\s\S]*<!--\/FORM:BOOTSTRAP-->/.test(loginMarkup),
      '两种形态要有成对的裁切标记（没有标记，服务端就只能把两个都发下去）',
    );
    /* ③ 登录控件不该再出现在后台页：这不是排版偏好，而是"下不下发"的分界线 */
    assert(!/id="login(Username|Password)"/.test(adminMarkup), '后台页里不该再有登录控件（未登录时它整页都不会被下发）');
    /* ④ 账号管理分区：它是这一轮的交付物，且必须真的接上服务端路由（页面写了没人服务，等于没有） */
    assert(/data-admin-view="accounts"/.test(adminMarkup) && /data-admin-view-pane="accounts"/.test(adminMarkup), '后台应有「账号管理」分区');
    assert(/\/api\/admin\/users/.test(adminScript), '账号管理要真的调服务端接口');
    for (const path of ['/api/admin/users', '/api/admin/users/password', '/api/admin/users/role', '/api/admin/users/disabled', '/api/admin/users/remove']) {
      assert(serverSource.includes(`'${path}'`), `服务端应提供 ${path}（页面调了它就必须真的有人服务）`);
    }
    assert(/CFG_ADMIN_ACTIONS/.test(adminScript) && /requireSession\(\)/.test(adminScript), '保存前应有统一的会话前置检查（一处拦住，而不是六个函数各写一遍）');
    assert(/请填「账号」与「口令」/.test(loginScript), '缺字段时要指出缺哪一格，而不是让服务端回一句错误码');
    assert(/\.focus\(\)/.test(loginScript), '缺字段时应把焦点送过去');
    assert(/classList\.toggle\('bad'/.test(loginScript), '状态行失败要标红（与"已保存"同色时会被当成提示扫过去）');
    /* `?next=` 是可以被手改的：不校验就等于把登录页做成开放重定向的跳板，
       而它长得就像"我们医院的登录页"，一条 `/login?next=https://evil.example` 足够用来钓口令 */
    assert(
      /isSafeNext/.test(loginScript) && /startsWith\('\/\/'\)/.test(loginScript),
      'next 必须做站内校验（`//evil.example` 是协议相对 URL，浏览器会当成站外域名）',
    );
    assert(/path === '\/admin'/.test(serverSource), '服务端应真的提供 /admin 路由（页面写了但没人服务，等于没有）');
    assert(/path === '\/login'/.test(serverSource), '服务端应真的提供 /login 路由');
  });

  await test('B29 配置写入要管理后台会话：未登录改不动、登录后可写、退出后立刻不可写', async () => {
    /* 这条是"配置搬到管理后台"的机器证明。为什么值得单独一条：
       旧版读的是请求自报的 `adminId`，谁都能声称自己是管理员，
       而写进审计的那个名字也就没有意义；现在操作者来自服务端会话。 */
    const placementBody = { strategy: 'ordered', confidenceCeiling: 0.85, candidate: { onlyTextNodes: true } };
    const spoofed = await postNoAuth('/api/placement-config', { ...placementBody, adminId: '自称的管理员' });
    assertEqual(spoofed.ok, false, '未登录时不应改得动配置（自报的 adminId 不再被采信，这正是本条要证的事）');
    assert(String(spoofed.message ?? '').includes('管理后台'), `拒绝理由要指向登录入口，实际：${spoofed.message ?? ''}`);

    /* 登录后可写（`post()` 自动带上会话 cookie） */
    const logged = await post('/api/placement-config', placementBody);
    assertEqual(logged.ok, true, `登录后应能保存：${logged.code ?? ''} ${logged.message ?? ''}`);

    /* 操作者来自会话：留痕里是登录身份与角色，不是请求里写的那个。
       角色也进了留痕：同一个人可能持有不同角色的会话，"谁改的"要能看出"他以什么身份改的"。 */
    const actions = (await state()).log.map((item) => String(item.action ?? ''));
    assert(
      actions.some((text) => text.includes('落位配置变更（操作者 ADMIN · 管理员）')),
      `留痕应记录会话里的操作者与角色，实际最近几条：${JSON.stringify(actions.slice(0, 3))}`,
    );
    assert(!actions.some((text) => text.includes('自称的管理员')), '请求自报的名字一个字都不该进留痕');

    /* 退出后立刻不可写：会话是服务端的事，前端藏什么按钮都影响不了它 */
    assertEqual((await post('/api/admin/logout', {})).ok, true, '退出应成功');
    const afterLogout = await postNoAuth('/api/placement-config', placementBody);
    assertEqual(afterLogout.ok, false, '退出后不应再改得动配置');
    await adminLogin(); /* 复原：后续用例与静态检查都依赖这个会话 */
  });

  await test('B30 管理动作审计：记下"从什么改成什么"，而密钥值一个字都进不去', async () => {
    /* 这条守的是方向相反的两件事，所以值得单独一条：
       ① 该记的必须记，只写"谁改了配置"不够用，事后最常问的一句是"它原来是什么"；
       ② 不该记的决不能记，审计是"能贴出来讨论"的东西，密钥进去等于换个地方再泄露一次。
       ②尤其需要机器守着：它靠的是"白名单之外默认不进"，而白名单是人手写的。 */

    /* 未登录不得读审计：审计若人人可读，"审计"两个字就没有意义了 */
    const unauth = (await (await fetch(`http://127.0.0.1:${PORT}/api/admin/audit`)).json()) as {
      ok?: boolean;
      code?: string;
    };
    assertEqual(unauth.ok, false, '未登录不应读到审计');
    /* 拒绝码在这里分成了两档：`E_AUTH_REQUIRED` = 没有会话；
       `E_PERMISSION_DENIED` = 有会话但这个角色不能做。
       原先只有 `E_ADMIN_REQUIRED` 一档，表达不了后者，而两者的处置完全不同
       （去登录 vs 去换人），运维不该只能看到同一句话。 */
    assertEqual(unauth.code, 'E_AUTH_REQUIRED', '未登录读审计应报"需要登录"');

    /* 前置：清掉密钥，并把 endpoint 设成一个别的值。
       两个目的都为了"变化必然出现"：密钥从无到有、地址从旧到新。
       实测踩到过：前置与保存用了同一个地址，于是审计里只剩一条 apiKeyPresent 变化，
       而"审计应记下 endpoint 的变化"落空，断言是对的，是前置没把差异造出来。 */
    const clearedFirst = await post('/api/model-config', {
      ...MODEL_BASE,
      endpoint: 'http://127.0.0.1:9999/v1',
      apiKey: null,
    });
    assertEqual(clearedFirst.ok, true, `前置清密钥应成功：${clearedFirst.code ?? ''} ${clearedFirst.message ?? ''}`);

    const secret = 'sk-live-must-never-appear-90716';
    const saved = await post('/api/model-config', { ...MODEL_BASE, apiKey: secret });
    assertEqual(saved.ok, true, `保存应成功：${saved.code ?? ''} ${saved.message ?? ''}`);

    const audit = (await getAuth('/api/admin/audit')) as unknown as AdminAuditView;
    assertEqual(audit.ok, true, '登录后应能读到审计');
    const latest = (audit.entries ?? []).find((item) => item.subject === '模型接入配置');
    assert(!!latest, `审计里应出现这次模型配置变更，实际条目：${JSON.stringify((audit.entries ?? []).map((item) => item.subject))}`);
    const changes = latest?.changes ?? [];

    /* ① 前后值：必须能看出"从什么改成什么" */
    const endpoint = changes.find((item) => item.field === 'endpoint');
    assert(!!endpoint, `审计应记下 endpoint 这一格的变化，实际：${JSON.stringify(changes)}`);
    assertEqual(endpoint?.after, 'http://127.0.0.1:11434/v1', '新值应写进审计');
    assert(endpoint?.before !== endpoint?.after, `前值应与后值不同（前值是 ${endpoint?.before}）`);

    /* ② 密钥：整份审计 JSON 里搜一遍，而不是只看某几个字段，
       "换个角落漏出去"正是这类问题最常见的形态 */
    const dump = JSON.stringify(audit);
    assert(!dump.includes(secret), '密钥值绝不能出现在审计里');
    assert(!dump.includes('must-never-appear'), '连密钥值的片段也不该出现');

    /* 但"密钥配没配"要能看出来：否则审计少了一条关键事实（这条走的是白名单里的 apiKeyPresent） */
    const keyChange = changes.find((item) => item.field === 'apiKeyPresent');
    assert(!!keyChange, `审计应记下"密钥从无到有"，实际：${JSON.stringify(changes)}`);
    assertEqual(keyChange?.after, '是', '密钥的存在性要能看出来（值不能）');
  });

  await test('B31 系统信息与生效配置指纹：指纹可当"同一份配置"的凭据，且与密钥无关', async () => {
    const sys = (await getAuth('/api/admin/system')) as unknown as AdminSystemView;
    assertEqual(sys.ok, true, '登录后应能读到系统信息');
    assertEqual(typeof sys.version, 'string', '应给出程序版本');
    const fingerprints = sys.configFingerprints ?? {};
    const subjects = ['模型接入配置', '落位配置', '签名后端配置', '授权平台配置'];
    for (const subject of subjects) {
      const value = fingerprints[subject];
      assert(typeof value === 'string' && value.length === 16, `${subject} 应有一枚 16 位指纹，实际：${value ?? '（无）'}`);
    }

    const before = fingerprints['模型接入配置'];
    /* 换一把密钥：指纹必须不变。否则把指纹贴给对方比对时，
       会把"我们换了密钥"透露出去，也可能被误读成"配置变了"。 */
    const rotated = await post('/api/model-config', { ...MODEL_BASE, apiKey: 'sk-live-another-secret-31415926' });
    assertEqual(rotated.ok, true, `换密钥应保存成功：${rotated.code ?? ''} ${rotated.message ?? ''}`);
    const afterKey = (await getAuth('/api/admin/system') as unknown as AdminSystemView).configFingerprints?.['模型接入配置'];
    assertEqual(afterKey, before, '同一份配置换密钥后，生效配置指纹必须不变');

    /* 反过来：清掉密钥时指纹必须变，"配没配密钥"确实是一项配置事实，
       若这里也不变，说明 apiKeyPresent 漏出了白名单（那审计里也会跟着少一条）。 */
    const cleared = await post('/api/model-config', { ...MODEL_BASE, apiKey: null });
    assertEqual(cleared.ok, true, `清密钥应保存成功：${cleared.code ?? ''} ${cleared.message ?? ''}`);
    const afterClear = (await getAuth('/api/admin/system') as unknown as AdminSystemView).configFingerprints?.['模型接入配置'];
    assert(afterClear !== afterKey, '「密钥配没配」变化时，指纹应随之变化');
  });

  await test('B32 未登录访问 /admin：服务端直接重定向，响应体里没有配置体', async () => {
    /* 这条守的是"独立登录页"唯一值钱的地方：未登录者拿不到配置体的 DOM。
       原先登录控件与配置体同页，`hidden` 只挡住"看得见"，五个子页签、字段名、
       签名字段映射的占位符仍躺在响应体里。它不含密钥值，
       但"这家医院接了签名服务、映射写到哪一格"本身就是信息。 */
    const res = await fetch(`http://127.0.0.1:${PORT}/admin`, { redirect: 'manual' });
    assertEqual(res.status, 302, '未登录访问 /admin 应重定向，而不是把页面发下来');
    assertEqual(res.headers.get('location'), '/login?next=%2Fadmin', '重定向要带 next，登录后能回到后台');
    const body = await res.text();
    /* 判据用 `data-admin-view`（分区按钮的特征属性）而不是某个 class 名：
       布局改过一轮（横排导航 → 左栏），class 跟着变过；这个属性才是"后台结构在不在"的稳定标记 */
    assert(!body.includes('cfg-tabs') && !body.includes('data-admin-view'), '重定向的响应体里不得出现配置体或分区标记（哪怕只是片段）');

    /* 登录页自己也不该泄露后台结构，否则"独立"就白做了 */
    const login = await (await fetch(`http://127.0.0.1:${PORT}/login`)).text();
    assert(login.includes('id="loginUsername"') && login.includes('id="loginPassword"'), '登录页应有账号 + 口令两个字段');
    assert(!login.includes('cfg-tabs') && !login.includes('data-admin-view'), '登录页不得含后台结构标记');
    /* 口令绝不出现在页面上。这一条取代了原先的"口令分档显示"：
       内置演示口令已经取消，而"演示时找不到口令"现在由启动日志与初始化流程解决，不由页面解决。
       写成"不含任何口令字样"太宽（提示文案里会有"口令"两字），所以钉的是值。 */
    assert(!login.includes('demo-admin-token'), '页面上不得出现任何内置口令值（产品里已经没有了）');
    assert(!/demo-(admin|qc|clinician)-token/.test(serverSource), '服务端源码里也不得再有内置口令兜底，那正是这一轮要去掉的东西');
    /* 已初始化 → 不下发初始化表单：下发什么就等于承认什么，
       把初始化表单发给一台已经有账号的机器，就是在告诉每个访问者"也许还有一次机会"。 */
    assert(!login.includes('id="bootstrapForm"'), '已有账号时不得下发初始化表单（入口是一次性的）');
    assert(!login.includes('admin_users'), '登录页不再出现账号所在的库表名');
    assert(!login.includes('<!--ADMIN_TOKEN_NOTE-->'), '服务端必须把占位注释替换掉（留着它就等于漏了实现细节）');

    /* 登录后，同一个地址直接给页面 */
    const authed = await fetch(`http://127.0.0.1:${PORT}/admin`, { headers: { Cookie: adminCookie }, redirect: 'manual' });
    assertEqual(authed.status, 200, '登录后 /admin 应直接返回后台页面');
    assert((await authed.text()).includes('data-admin-view'), '后台页面应含分区导航（登录后才拿得到）');

    /* 已登录再打开登录页 → 直接送去后台，而不是让人"再登一次" */
    const again = await fetch(`http://127.0.0.1:${PORT}/login`, { headers: { Cookie: adminCookie }, redirect: 'manual' });
    assertEqual(again.status, 302, '已登录访问 /login 应重定向到后台');
    assertEqual(again.headers.get('location'), '/admin', '应指向 /admin');
  });

  await test('B33 内容包（规则库 / 模板）：规则可开关、开关只影响质控，且一个字都不改病历（两个指纹分得开）', async () => {
    /* 这条要把"包是数据、不是文档内容"从注释变成机器证明：
       ① 未登录改不动（部署策略）；② 停用后界面与扫描同时少一条；
       ③ 内容指纹不变、生效指纹变，否则"换了包"与"关了条规则"分不开；
       ④ 整个过程病历 rev 不变；⑤ 审计要知道动的是哪一条；⑥ 未知条目必须显式报错。 */
    await adminLogin();

    const before = await state();
    const packs = before.knowledgePacks.packs;
    assert(packs.length >= 3, '载入样例后应有三个包（形式类规则 + 时限类规则 + 模板）');
    assertEqual([...new Set(packs.map((pack) => pack.kind))].sort(), ['rule', 'template'], '两类包都要在（术语包尚无引擎，会被明确拒绝）');
    const rulePack = packs.find((pack) => pack.kind === 'rule');
    assert(!!rulePack, '应装载规则包');
    assertEqual(before.formRules.length, 7, '前置：七条规则全部启用（形式类 3 + 时限类 4）');
    const contentFp = before.knowledgePacks.contentFingerprint;
    const effectiveFp = before.knowledgePacks.effectiveFingerprint;
    const docRevBefore = before.doc.rev;
    const packId = String(rulePack?.packId ?? '');

    /* ① 未登录不得改 */
    const unauth = await postNoAuth('/api/knowledge-pack-toggle', { packId, itemId: 'R-FORM-02', enabled: false });
    assertEqual(unauth.ok, false, '未登录不得改规则包开关（服务端是唯一拦点）');

    /* ② 登录后停用一条 */
    const off = await post('/api/knowledge-pack-toggle', { packId, itemId: 'R-FORM-02', enabled: false });
    assertEqual(off.ok, true, `停用应成功：${off.code ?? ''} ${off.message ?? ''}`);

    const offState = await state();
    assertEqual(
      offState.formRules.map((rule) => rule.id),
      ['R-FORM-01', 'R-FORM-03', 'R-TIME-01', 'R-TIME-02', 'R-TIME-03', 'R-TIME-04'],
      '界面列出的规则必须与启用状态同口径，"列着但没跑"是最不该出现的形态（关掉一条形式类的，两条时限类不受牵连）',
    );
    assertEqual(offState.knowledgePacks.contentFingerprint, contentFp, '内容指纹不变：关一条不是换一版');
    assert(offState.knowledgePacks.effectiveFingerprint !== effectiveFp, '生效指纹必须变');
    assertEqual(offState.doc.rev, docRevBefore, '开关规则包不得改动病历（rev 不变）');

    /* ③ 扫描真的少跑一条：回报的规则条数是可数出来的证据，不是"看着像没跑" */
    const scanOff = await post('/api/qc-form-check', {});
    assertEqual(scanOff.ok, true, '质控扫描应可执行');
    assertEqual((scanOff.data as { rules: number }).rules, 6, '被停用的规则不得参与扫描');
    assertEqual((await state()).doc.rev, docRevBefore, '扫描只产旁挂注解，同样不改 rev');

    /* ④ 开回来：状态与两个指纹都要复原（可逆） */
    const on = await post('/api/knowledge-pack-toggle', { packId, itemId: 'R-FORM-02', enabled: true });
    assertEqual(on.ok, true, '启用应成功');
    const onState = await state();
    assertEqual(onState.formRules.length, 7, '开回后七条都在');
    assertEqual(onState.knowledgePacks.effectiveFingerprint, effectiveFp, '开回原状应回到原生效指纹（可复现）');
    assertEqual(onState.knowledgePacks.contentFingerprint, contentFp, '内容指纹自始至终不变');
    assertEqual(onState.doc.rev, docRevBefore, '整个过程病历一个字都没动');

    /* ⑤ 审计要能回答"哪一条、从什么改成什么"，而不是只记一句"改过质控配置"。
       取停用那一条而不是最新一条：最新是"开回来"，那一条里 itemId 前后相同（都是 R-FORM-02），
       按"变化即记录"的口径它不该出现，拿它去断言等于在考审计工具，而不是考这次改动。 */
    const audit = (await getAuth('/api/admin/audit')) as unknown as AdminAuditView;
    /* 审计主体是「包条目」而不是「规则包」：规则条目与模板条目走同一个开关接口，
       写成"规则包"会把"停了一份文书"记成"改了判定标准"。 */
    const packEntries = (audit.entries ?? []).filter((item) => item.subject === '包条目');
    assert(packEntries.length >= 2, `审计里应有包条目开关记录，实际 ${packEntries.length} 条`);
    const disableEntry = packEntries.find((item) => item.changes.some((change) => change.field === 'enabled' && change.after === '否'));
    assert(!!disableEntry, `审计里应有"停用"那一条，实际：${JSON.stringify(packEntries.map((item) => item.changes))}`);
    const enabledChange = (disableEntry?.changes ?? []).find((change) => change.field === 'enabled');
    assert(!!enabledChange && enabledChange.before === '是' && enabledChange.after === '否', '审计要记下"从什么改成什么"');
    /* "动的是哪一条"由 `note` 承担，而不是出现在 `changes` 里，
       因为 itemId 前后相同（都是 R-FORM-02），按"变化即记录"的口径它本就不该出现。
       这条差异是口径，不是遗漏：把没变的东西记成"变化"，会让审计里全是噪声。 */
    assert(String(disableEntry?.note ?? '').includes('R-FORM-02'), `审计要记下动的是哪一条，实际：${disableEntry?.note ?? '（无）'}`);

    /* ⑥ 未知条目必须显式报错（不静默无动作） */
    const bogus = await post('/api/knowledge-pack-toggle', { packId, itemId: 'R-NOT-EXIST', enabled: false });
    assertEqual(bogus.ok, false, '未知条目标识应被拒');
    assertEqual(bogus.code, 'E_PACK_ITEM_UNKNOWN', '应给出可定位的错误码');
  });

  await test('B34 模板体系（K4）：按模板新建 → 产物过独立探针 → 派生值"算不出"就为空', async () => {
    /* 把 K4 的三件事串成一条真实链路：
       ① 模板清单与控件库来自同一个包注册表（界面列出的就是内核真的认的）；
       ② 实例化产物不仅要过自己的校验，还要被独立探针（tools/model-check）接受，
          结论不经过我们的解析器，避免"自说自话"；
       ③ 派生值缺输入时是"算不出"，不是 0，这条在 HTTP 层再验一次。 */
    const before = await state();
    assertEqual(before.templates.length, 3, '应列出 3 份模板（K4：覆盖 3 类核心文书）');
    assertEqual(before.expressionControls.length, 5, '应列出 5 个医学表达式控件（K4 验收口径）');
    assert(before.expressionControls.some((control) => control.controlId === 'expr.gestationalWeeks'), '应含专科控件（孕周）');
    assert(before.expressionControls.every((control) => control.formula.length > 0), '控件要能给出人类可读公式');

    const docCountOf = (snapshot: DemoState): number =>
      snapshot.tree.reduce((sum, patient) => sum + patient.visits.reduce((n, visit) => n + visit.docs.length, 0), 0);
    const visitOf = (snapshot: DemoState, docId: string) =>
      snapshot.tree.flatMap((patient) => patient.visits).find((visit) => visit.docs.some((doc) => doc.docId === docId));
    const countBefore = docCountOf(before);
    const visitBefore = visitOf(before, before.activeDocId);
    assert(!!visitBefore, '前置：活动病历应挂在某个就诊下');

    /* ① 新建：挂在当前患者 / 当前就诊下，并自动切过去 */
    const created = await post('/api/template-create', { templateId: 'tpl.obstetric.outpatient' });
    assertEqual(created.ok, true, `新建应成功：${created.code ?? ''} ${created.message ?? ''}`);
    const createdData = (created.data ?? {}) as { docId?: string; templateName?: string; warnings?: string[] };
    assert(typeof createdData.docId === 'string' && createdData.docId !== '', '应回传新文书 id');

    const after = await state();
    assertEqual(after.activeDocId, createdData.docId, '新建后应自动切到新文书');
    assertEqual(after.doc.docType, '门（急）诊病历', '文书类型来自模板声明的 docType');
    assertEqual(docCountOf(after), countBefore + 1, '树里应多一份病历');
    assertEqual(visitOf(after, String(createdData.docId))?.visitId, visitBefore?.visitId, '新文书必须挂在同一个就诊下（不做凭空造患者）');

    /* ② 骨架：正文为空、关键内容已标记、派生值节点在但没有值 */
    const texts = after.items.filter((item) => item.kind === 'text');
    assert(texts.length > 0, '前置：模板应产出文本节点');
    assert(texts.every((item) => (item.text ?? '') === ''), '模板不产生正文内容（"看起来写完的病历"比空白危险得多）');
    assert(texts.some((item) => item.keyContent), '模板标了关键内容的节点要带上标记（签章前须人工确认）');
    assert(
      texts.every((item) => typeof item.templateRef === 'string' && item.templateRef.includes('doc.template.builtin#')),
      '模板产出的节点必须带模板出处（界面据此把"系统带入"改写成"模板带入"，否则空文书上写着"系统带入"会让人以为内容已进来）',
    );
    const gestational = after.items.find((item) => item.kind === 'field' && item.tags?.[0]?.display === '孕周');
    assert(!!gestational, '产科模板应有「孕周」派生值节点（专科控件）');
    assertEqual(gestational?.value, '', '缺末次月经时孕周是"算不出"（空），不是 0');
    /* 告警必须用医生看得懂的名字（"还缺 末次月经"），而不是模板内部的 slot key
       （`lmpDate`），界面在临床模式下收起内部标识，告警里漏出去等于绕过那条纪律。 */
    assert(
      (createdData.warnings ?? []).some((warning) => warning.includes('孕周') && warning.includes('末次月经')),
      `告警要指出"缺哪一格"并说清这是自动计算，实际：${JSON.stringify(createdData.warnings ?? [])}`,
    );
    assert(
      (createdData.warnings ?? []).every((warning) => !warning.includes('lmpDate')),
      `告警不得把模板内部 slot key 直接给医生，实际：${JSON.stringify(createdData.warnings ?? [])}`,
    );

    /* ③ 独立探针：模板产物必须被第三方校验器接受 */
    const exported = await post('/api/export-json', {});
    assertEqual(exported.ok, true, '导出应成功');
    const record = exported.state!.lastJson!;
    assert(existsSync(record.file), `JSON 应落盘：${record.file}`);
    const probe = spawnSync(process.execPath, ['tools/model-check/schema-validate.mjs', record.file], { cwd: ROOT, encoding: 'utf8' });
    assertEqual(probe.status, 0, `模板产物的独立校验应通过：\n${probe.stdout}\n${probe.stderr}`);

    /* ④ 派生值重算（HTTP 全链路）：这一步让"表达式控件"从"创建时算一次"变成真的能用，
       否则创建时输入项必然是空的，那个格子就是永远填不上的死格子。 */
    assertEqual(after.derivedCount, 2, '产科模板有 2 个派生值（孕周、体质指数），界面据此显示「重算派生值」');
    const lmp = after.items.find((item) => item.kind === 'field' && item.tags?.[0]?.display === '末次月经');
    assert(!!lmp, '产科模板应有「末次月经」填写项');
    const revBeforeRecompute = after.doc.rev;

    /* 让孕周正好 4 周：末次月经取"就诊时间往前 28 天" */
    assertEqual((await post('/api/set-field', { nodeId: lmp!.id, value: '2026-09-10T01:00:00Z' })).ok, true, '填写末次月经应成功');
    const recomputed = await post('/api/template-recompute', {});
    assertEqual(recomputed.ok, true, `重算应成功：${recomputed.code ?? ''} ${recomputed.message ?? ''}`);
    const recomputeData = (recomputed.data ?? {}) as { applied?: string[]; pending?: unknown[]; skipped?: unknown[] };
    assertEqual(recomputeData.applied?.length, 1, '应重算出 1 个（孕周）');
    assertEqual(recomputeData.pending?.length, 1, '另一个（体质指数）缺身高体重：报"算不出来"，不编值');
    assertEqual((await state()).items.find((item) => item.id === gestational?.id)?.value, '4', '28 天 → 孕周 4 周');
    assert((recomputed.state?.doc.rev ?? 0) > revBeforeRecompute, '重算是一次真实写入（进留痕，可追溯）');

    /* 同值再算：幂等，不产生多余留痕（留痕是审计证据，不能被噪声淹没） */
    const revAfterFirst = (await state()).doc.rev;
    assertEqual((await post('/api/template-recompute', {})).state?.doc.rev, revAfterFirst, '同值重算不应再写一条留痕');

    /* 医生确认了这个派生值 → 之后输入变了也不再自动改它
       （"确认"的含义是"我看过并认可"，系统不该背着他改掉） */
    assertEqual((await post('/api/confirm', { nodeId: gestational!.id })).ok, true, '确认孕周应成功');
    assertEqual((await post('/api/set-field', { nodeId: lmp!.id, value: '2026-09-24T01:00:00Z' })).ok, true, '改末次月经（14 天前 → 本该是 2 周）');
    const third = await post('/api/template-recompute', {});
    assertEqual(((third.data ?? {}) as { applied?: string[] }).applied?.length, 0, '已确认的派生值不该被算回去');
    assertEqual(((third.data ?? {}) as { skipped?: unknown[] }).skipped?.length, 1, '应报"被跳过"，而不是静默不动');
    assertEqual((await state()).items.find((item) => item.id === gestational?.id)?.value, '4', '已确认的值必须原样保留（没有被算成 2）');

    /* ⑤ 未知模板 / 已停用的模板：都要明确报错，而不是开出一份空文书 */
    assertEqual((await post('/api/template-create', { templateId: 'tpl.not-exist' })).code, 'E_TPL_TEMPLATE_UNKNOWN', '未知模板');
    await adminLogin();
    const off = await post('/api/knowledge-pack-toggle', { packId: 'doc.template.builtin', itemId: 'tpl.obstetric.outpatient', enabled: false });
    assertEqual(off.ok, true, `停用模板应成功：${off.code ?? ''} ${off.message ?? ''}`);
    assertEqual((await state()).templates.length, 2, '停用后清单少一条（界面与内核同口径）');
    assertEqual((await post('/api/template-create', { templateId: 'tpl.obstetric.outpatient' })).code, 'E_TPL_TEMPLATE_UNKNOWN', '停用的模板开不出来');
    assertEqual((await post('/api/knowledge-pack-toggle', { packId: 'doc.template.builtin', itemId: 'tpl.obstetric.outpatient', enabled: true })).ok, true, '复原：重新启用');

    /* ⑥ 复位（后面没有用例了，但不把状态留给下一次运行） */
    assertEqual((await resetWorkspace()).ok, true, '复位应成功');
    assertEqual(docCountOf(await state()), countBefore, '复位后回到初始份数');
  });

  await test('B35 落盘收口：审计可外部复算、包开关落盘、授权登记落盘且随重置一起清', async () => {
    /* 这三件都是"重启之后还对不对"这条线上的。ui-self-test 只起一个进程，
       所以这里验的是落到盘上的形态（重启一致性由各模块单测覆盖）：
         ① 审计：文件在、测试自己复算一遍链（比只看服务端自报强）；
         ② 知识资产包：包文件与指针都在，且改开关会写进指针；
         ③ 授权登记：导入授权后文件出现、重启后会被读回；`/api/reset` 连它一起清。 */
    await adminLogin();

    /* ① 审计链：**独立复算**，而且要从**库里**读（不信服务端自报）。
       审计与工作数据在同一个库 —— 这里直接打开那个库来核。 */
    const dbFile = join(stateDir, 'l0.db');
    const audit = (await getAuth('/api/admin/audit')) as unknown as AdminAuditView & {
      chain?: { table: string; legacyFile: string; intact: boolean; problem: unknown; discarded: number };
    };
    assertEqual(audit.ok, true, '应能读到审计');
    const chain = audit.chain;
    assert(!!chain, '审计视图必须给出链校验结果（否则"被改过没有"只能靠猜）');
    assertEqual(chain?.intact, true, '整条链应完好');
    assertEqual(chain?.table, 'admin_audit', '审计应记在库里的 admin_audit 表（不是文件）');
    assert(existsSync(dbFile), `工作数据库应在盘上：${dbFile}`);
    const auditDb = openDatabase(dbFile, { schemaVersion: STORAGE_SCHEMA_VERSION, migrations: MIGRATIONS });
    try {
      const rows = auditDb.db.prepare('select * from admin_audit order by seq asc').all() as unknown as Array<{
        seq: number;
        at: string;
        actor: string;
        subject: string;
        kind: string;
        changes: string;
        note: string | null;
        prev_hash: string;
        hash: string;
      }>;
      assert(rows.length >= 1, '库里应有记录（本次会话已产生管理动作）');
      let previousHash = '0'.repeat(64);
      for (const row of rows) {
        assertEqual(String(row.prev_hash), previousHash, '每条记录的 prev_hash 必须指向上一条（测试独立复算，不信服务端自报）');
        const recomputed = auditRecordHash(previousHash, {
          seq: Number(row.seq),
          at: String(row.at),
          actor: String(row.actor),
          subject: String(row.subject),
          kind: String(row.kind) as '变更' | '动作',
          changes: JSON.parse(String(row.changes)) as Array<{ field: string; before: string; after: string }>,
          ...(row.note === null || row.note === undefined ? {} : { note: String(row.note) }),
        });
        assertEqual(recomputed, String(row.hash), '每条记录的 hash 必须可复算');
        previousHash = String(row.hash);
      }
    } finally {
      auditDb.db.close();
    }

    /* ② 知识资产包：落在数据库里（一个包一行），以及"改开关会写进那一行的 disabled 列"。
       这里直接从测试进程打开同一个库来核对，不信服务端自报的"已落库"。 */
    const packsBefore = (await state()).knowledgePacks.store;
    assertEqual(packsBefore.source, 'database', `包应已从库装载，实际：${String(packsBefore.source)}`);
    assertEqual(packsBefore.error, null, `包不应读库失败：${String(packsBefore.error)}`);
    assertEqual(packsBefore.tables, ['knowledge_packs'], '包落在库里的一张表上（一个包一行）');
    /* `dbFile` 已在 ① 里定义（同一个库） */
    const opened = openDatabase(dbFile, { schemaVersion: STORAGE_SCHEMA_VERSION, migrations: MIGRATIONS });
    try {
      const rows = opened.db.prepare('select pack_id, fingerprint from knowledge_packs order by pack_id').all();
      assert(rows.length >= 3, `库里应有三份样例包，实际：${JSON.stringify(rows)}`);
      assert(rows.some((row) => String(row.pack_id) === 'qc.form.builtin'), '库里应有 qc.form.builtin（样例形式类规则包）');
      assertEqual(rows.length, packsBefore.packs.length, '一个包一行：库里的行数应与报告里列出的包数一致');
      assert(
        rows.every((row) => String(row.fingerprint).length === 64),
        '每行都要有内容指纹，版本号删掉之后，它是"载的是哪份内容"唯一的答案',
      );
    } finally {
      opened.db.close();
    }

    const rulePackId = 'qc.form.builtin';
    const readDisabled = (): string[] => {
      const live = openDatabase(dbFile, { schemaVersion: STORAGE_SCHEMA_VERSION, migrations: MIGRATIONS });
      try {
        const row = live.db.prepare('select disabled from knowledge_packs where pack_id = ?').get(rulePackId) as
          | { disabled?: string }
          | undefined;
        return JSON.parse(String(row?.disabled ?? '[]')) as string[];
      } finally {
        live.db.close();
      }
    };

    const off = await post('/api/knowledge-pack-toggle', { packId: rulePackId, itemId: 'R-FORM-03', enabled: false });
    assertEqual(off.ok, true, `停用应成功：${off.code ?? ''} ${off.message ?? ''}`);
    assertEqual(readDisabled(), ['R-FORM-03'], '开关必须立刻写进库里那一行（否则重启就回到全启用，而界面上看不出异常）');
    assertEqual((await post('/api/knowledge-pack-toggle', { packId: rulePackId, itemId: 'R-FORM-03', enabled: true })).ok, true, '复原：重新启用');
    assertEqual(readDisabled(), [], '启用后那一列里不该再留着它');

    /* ③ 授权登记：导入后写盘；重置连它一起清 */
    const platform = demoKeyPair('b35-platform');
    assertEqual(
      (await post('/api/reading-authority', { adminId: 'ADMIN', trustedIssuerFingerprint: publicKeyFingerprint(platform.publicKey) })).ok,
      true,
      '配置信任根',
    );
    const grantState = await state();
    const grant: ReadingGrant = {
      grantId: 'grant_b35',
      docId: grantState.activeDocId,
      /* 授权必须绑定文档内容指纹：它与 docId 一起决定了"这份授权是给这份内容的" */
      documentFingerprint: grantState.reading.documentFingerprint,
      notBefore: new Date(Date.now() - 60_000).toISOString(),
      notAfter: new Date(Date.now() + 3_600_000).toISOString(),
      maxReads: 1,
      allowedEnvironments: ['WS-01'],
      allowedSections: ['*'],
      concealPatientIdentity: false,
      issuedBy: 'AUTHZ_PLATFORM',
      issuedAt: new Date().toISOString(),
      purpose: '落盘验证',
    };
    assertEqual(
      (await post('/api/reading/import-credential', { text: JSON.stringify(await issueReadingGrant(grant, softwareSigner(platform.privateKey))) })).ok,
      true,
      '导入平台签发的凭据',
    );
    /* 授权登记与包、审计同一条路：**一条授权一行**（`persistence.table`），
       不再是"整份密封文件"—— 所以"落盘"验的是库里那张表，而不是找一个已经不存在的文件。 */
    const grantsTable = (await state()).reading.persistence.table;
    assertEqual(grantsTable, 'reading_grants', '授权登记应落在库里的一张表上（一条授权一行）');
    assert((await state()).reading.persistence.total >= 1, '全局授权条数应 >= 1');
    assertEqual((await state()).reading.persistence.error, null, '授权登记不应有读错误');
    const countGrants = (): number => {
      const opened = openDatabase(dbFile, { schemaVersion: STORAGE_SCHEMA_VERSION, migrations: MIGRATIONS });
      try {
        return Number((opened.db.prepare('select count(*) as n from reading_grants').get() as { n?: number } | undefined)?.n ?? 0);
      } finally {
        opened.db.close();
      }
    };
    assert(countGrants() >= 1, '库里应真有刚导入的那条授权（不信服务端自报）');

    assertEqual((await resetWorkspace()).ok, true, '重置应成功');
    const afterReset = await state();
    assertEqual(afterReset.reading.persistence.total, 0, '重置要连授权登记一起清（重置后旧授权只会得到 E_DOCUMENT_CHANGED，留着就是一堆必然失败的凭据）');
    assertEqual(countGrants(), 0, '库里那张授权表也要被清干净（否则重启后又读回来一批必然失败的凭据）');

    /* 复位信任根（后面没有用例了，但"改过就复原"是好习惯） */
    await post('/api/reading-authority', { adminId: 'ADMIN' });
  });

  await test('B36 并发写：外部改动被检出、不覆盖，且冲突当场可见', async () => {
    /* 进程内的乐观锁（expectedRev）拦不住"两个终端各自打开同一份病历"：
       两边内存里都自洽，而落盘是全量覆盖，后写的静默抹掉前一个。
       这条用例从测试进程直接写一份服务端能读的快照来模拟"另一个终端"，
       验证落盘前置条件把它变成了显式拒绝（跨进程的对照实验见 `test:concurrency`）。 */
    const before = await state();
    const docId = before.activeDocId;
    const dbFile = join(stateDir, 'l0.db');
    const field = before.items.find((item) => item.kind === 'field');
    assert(!!field, '前置：当前文书应有可填写的字段（否则这条用例在测别的东西）');

    /**
     * 从测试进程打开同一个库文件（服务端读的就是它）。
     * 这与"另一个实例在写"同构：跨进程、同一个库，而不是往库里塞一份服务端读不到的东西。
     */
    const withStore = <T,>(fn: (store: WorkStore) => T): T => {
      const opened = openDatabase(dbFile, { schemaVersion: STORAGE_SCHEMA_VERSION, migrations: MIGRATIONS });
      const store = new WorkStore(opened.db, STATE_KEY);
      try {
        return fn(store);
      } finally {
        store.close();
      }
    };

    /* ① 正常写入 → 落库成功，服务端据此建立基线 */
    const first = await post('/api/set-field', { nodeId: field!.id, value: '36.6' });
    assertEqual(first.ok, true, `写入应成功：${first.code ?? ''} ${first.message ?? ''}`);
    assert(existsSync(dbFile), `工作数据应落在数据库文件上：${dbFile}`);
    assertEqual((first as { persisted?: unknown }).persisted, undefined, '正常写入不该带 persisted 字段');

    /* ② 模拟"另一个终端改了同一份病历"。
       写的是同一份内容的另一次加密：信封含随机 IV，所以密文与摘要都变了，
       这正是"库里那一版不是本终端认的那一版"的最小可复现形态；
       同时它仍是可装载的合法内容，后面才检验得出"重新载入能走出死路"。 */
    const own = withStore((store) => store.loadSidecars<unknown>(docId));
    assert(own.ok && own.found, '前置：能读出服务端刚写进去的那一份');
    const ownDigest = own.ok && own.found ? own.digest : '';
    const foreignDigest = withStore((store) => store.saveSidecars(docId, own.ok && own.found ? own.data : null).digest);
    assert(foreignDigest !== ownDigest, '前置：外部写入后摘要必须变了（否则"陈旧"检测不出来）');

    /* ③ 再写一次 → 落盘被拒，但内存里的写入仍然成功（不能因为落盘冲突就阻断临床操作） */
    const second = await post('/api/set-field', { nodeId: field!.id, value: '37.0' });
    assertEqual(second.ok, true, '临床操作本身仍应成功：落盘失败不该让"录入"这件已发生的事变没发生');
    const persisted = (second as { persisted?: { ok: boolean; code?: string; conflict?: boolean; message?: string } }).persisted;
    assert(!!persisted && persisted.ok === false, `落盘应被拒并回传，实际：${JSON.stringify(persisted)}`);
    assertEqual(persisted?.code, SNAPSHOT_CONFLICT_CODE, '应给出可定位的错误码');
    assertEqual(persisted?.conflict, true, '应标明这是"被别处改过"这一类冲突（与"磁盘坏了"分开）');

    const stillForeign = withStore((store) => store.loadSidecars<unknown>(docId));
    assert(stillForeign.ok && stillForeign.found, '外部那一版应仍可读');
    assertEqual(stillForeign.ok && stillForeign.found ? stillForeign.digest : '', foreignDigest, '被拒时一个字节都不许写：库里仍是外部那一版');

    /* ④ 冲突必须当场看得见：只在某处躺一条日志不算"被发现" */
    const logAfter = await state();
    assert(
      logAfter.log.some((item) => String(item.action ?? '').includes('未落盘')),
      `操作日志里要有"未落盘"这一条，实际最近几条：${JSON.stringify(logAfter.log.slice(0, 3).map((item) => item.action))}`,
    );

    /* ⑤ 冲突不该被"洗白"：基线保持不动，下一次陈旧写入仍然被拒 */
    const third = await post('/api/set-field', { nodeId: field!.id, value: '37.1' });
    assertEqual((third as { persisted?: { ok: boolean } }).persisted?.ok, false, '冲突过后再写仍要拒（改了基线就等于放行陈旧写入）');
    assertEqual((await state()).sidecar.conflict, true, '冲突状态要下发到界面，否则「重新载入旁挂数据」这个出路永远不会出现');

    /* ⑥ 死路必须能走出来：重新载入 = 接受盘上那一版（放弃本终端尚未落盘的旁挂改动）。
       没有这一步，"请重新载入后再改"就是一句做不到的承诺。 */
    const reload = await post('/api/reload-sidecars', {});
    assertEqual(reload.ok, true, `重新载入应成功：${reload.code ?? ''} ${reload.message ?? ''}`);
    const forth = await post('/api/set-field', { nodeId: field!.id, value: '37.2' });
    assertEqual(forth.ok, true, '重新载入后写入应成功');
    assertEqual(
      (forth as { persisted?: unknown }).persisted,
      undefined,
      `重新载入之后落盘应恢复正常，实际：${JSON.stringify((forth as { persisted?: unknown }).persisted)}`,
    );
    const finalSide = withStore((store) => store.loadSidecars<unknown>(docId));
    assert(finalSide.ok && finalSide.found, '最终库里应有一份可读的旁挂数据');
    assert(finalSide.ok && finalSide.found ? finalSide.digest !== foreignDigest : false, '恢复之后确实写进去了（换成了本终端这一版）');
    assertEqual((await state()).sidecar.conflict, false, '重新载入后冲突状态应清除（界面上的出路随之收起）');

    /* 收尾：复位工作区（连库一起清），把状态留给下一轮 */
    assertEqual((await resetWorkspace()).ok, true, '复位应成功');
    const afterResetSidecars = withStore((store) => store.loadSidecars(docId));
    assertEqual(afterResetSidecars.ok && afterResetSidecars.found, false, '复位应把库里的旁挂数据一并清掉（重置必须真的清库）');
  });

  await test('B37 严格模式（库里的 config.system.authMode=strict）：写路径按角色判、"没登录"与"角色不够"分开报、归属取自会话、登录可被限流', async () => {
    /* 默认的 `open` 是演示模式：医生端写操作不鉴权。这条用例起一个 strict 实例，
       证明"安全形态真的存在、而且真的能用"，否则"默认不设防"就只是一个没有替代方案的洞。
       它与 open 实例并存（另起端口、状态目录与运行时目录），因此不影响前面 60 条用例。

       鉴权模式 / 会话寿命 / 限流阈值**都不再来自环境变量**，而在库里的 `config.system` 一行
       （见 `storage/system-config.ts`），且它们是**启动期读取**的。所以这个实例的启动顺序是：
         ① 写自己的 `server-config.json`（密封口令 + 装机凭据 —— 打开库之前就要知道）；
         ② 预置自己那份独立库里的系统策略；
         ③ 起进程。三步都不能反。 */
    /* 这个实例是"另一台机器"：状态目录与运行时目录各一套，用完就删（下面 finally 与结尾清理各兜一层），
       免得含合成手机号的落盘快照、以及带密封口令的配置文件留在工作区。 */
    const strictDir = process.env.L0_UI_SELFTEST_STRICT_STATE_DIR ?? join(ROOT, 'artifacts', 'state-selftest-strict');
    const strictRuntimeDir = process.env.L0_UI_SELFTEST_STRICT_RUNTIME_DIR ?? join(ROOT, 'artifacts', 'runtime-selftest-strict');
    const strictPort = Number(process.env.L0_UI_SELFTEST_STRICT_PORT ?? 8801);
    const rmRecursive = rmSync as unknown as (path: string, options: { recursive: boolean; force: boolean }) => void;
    for (const dir of [strictDir, strictRuntimeDir]) {
      if (existsSync(dir)) rmRecursive(dir, { recursive: true, force: true });
    }

    /* ① 装机凭据：它让这个实例的初始化必须同时给出它，
         本用例据此证明"未初始化 + 配置文件给了 bootstrap.token"那一档真的拦住了任意访问者。
         只给 token、不给 user：**不预播种**账号，仍走"打开 /login 由页面上初始化"这条路
         （角色口令一个都不给：角色现在来自账号，不是来自环境变量）。 */
    writeServerConfig({ bootstrapToken: STRICT_DEPLOY_TOKEN, targetRuntimeDir: strictRuntimeDir });
    /* ② 预置策略（写进这个实例自己的库；启动期读取，故必须先于起进程）：
         - authMode=strict：写操作要求会话并按角色判；
         - sessionTtlMinutes=1：会话寿命的**最小正整数**（校验只收正整数，小数会被拒）。
           原先靠 0.05 分钟（3 秒）让会话 3 秒过期，那条路随环境变量一起没了，
           见 §⑨：改成按登录响应给出的 `expiresAt` 等到真正过期再断言；
         - rate.loginPerActor=2：不压的话要试六次才看得到限流（见 §⑩）；
         - rate.loginPerSource=200：「按来源」那个桶放宽 —— 本用例只钉"按账号"的规则，
           而它自己要走十几次登录 + 两次初始化，默认的 20/5 分钟会变成一个与本用例无关的
           隐式天花板（红起来看着像鉴权坏了）。 */
    seedSystemConfig(strictDir, {
      authMode: 'strict',
      sessionTtlMinutes: 1,
      rate: { loginPerActor: 2, loginPerSource: 200, aiPerMinute: 120, exportPerMinute: 30 },
    });

    const strict = spawn(process.execPath, ['src/demo/demo-server.ts', '--port', String(strictPort)], {
      cwd: ROOT,
      stdio: 'pipe',
      env: {
        ...process.env,
        L0_RUNTIME_DIR: strictRuntimeDir,
        L0_STATE_DIR: strictDir,
        L0_ADMIN_AUDIT_FILE: join(strictDir, 'admin-audit.log'),
        L0_AUDIT_ANCHOR_FILE: join(strictDir, 'anchors.ndjson'),
        L0_READING_GRANTS_FILE: join(strictDir, 'reading-grants.json'),
        L0_PACK_DIR: join(strictDir, 'knowledge'),
      },
    });
    strict.stdout?.on('data', () => {});
    strict.stderr?.on('data', () => {});

    const base = `http://127.0.0.1:${strictPort}`;
    type Json = Record<string, unknown>;
    const call = async (path: string, cookie: string, body?: unknown): Promise<Json> => {
      const res = await fetch(`${base}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return (await res.json()) as Json;
    };
    const login = async (username: string, password: string): Promise<string> => {
      const res = await fetch(`${base}/api/admin/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const payload = (await res.json()) as { ok?: boolean; message?: string; role?: string };
      assertEqual(payload.ok, true, `登录应成功（${username}）：${payload.message ?? ''}`);
      return String(res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    };
    /**
     * 与 `login` 同一条路，但把登录响应里的 `expiresAt` 一并取回来。
     *
     * §⑨ 要验"到点即失效"，而会话寿命现在是库里配的（最小 1 分钟），
     * 所以必须知道"该等到什么时候"，不能再像原来那样等一个固定的 3.3 秒。
     */
    const loginWithExpiry = async (username: string, password: string): Promise<{ cookie: string; expiresAt: number }> => {
      const res = await fetch(`${base}/api/admin/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const payload = (await res.json()) as { ok?: boolean; message?: string; expiresAt?: string };
      assertEqual(payload.ok, true, `登录应成功（${username}）：${payload.message ?? ''}`);
      const expiresAt = Date.parse(String(payload.expiresAt ?? ''));
      assert(Number.isFinite(expiresAt), `登录响应应给出会话失效时刻（expiresAt），实际：${String(payload.expiresAt)}`);
      return { cookie: String(res.headers.get('set-cookie') ?? '').split(';')[0] ?? '', expiresAt };
    };
    const stateOf = async (cookie: string): Promise<Json> => {
      const payload = await call('/api/state', cookie);
      return payload.state as Json;
    };

    try {
      /* 窗口给到 60 秒：空库启动要跑一次密钥派生，纯 JS 的 PBKDF2-HMAC-SM3（20 万次）
         在这台机器上实测 12.5 秒（`node -e` 直接量过），加上播种与迁移约 15 秒。
         窗口放宽不是因为它慢就放它过，这条用例要验的是"角色判定对不对"，
         不是"启动快不快"；而原来那个 15 秒窗口是照当时的实测值定的，刚好卡在边界上
         （实测 15.1 秒，红过一次）。真出问题时会以超时的形式报出来，
         所以把它量出来并写进失败信息里，比调大数字更有用。 */
      const started = Date.now();
      const deadline = started + 60000;
      let ready = false;
      while (Date.now() < deadline && !ready) {
        try {
          ready = (await fetch(`${base}/api/state`)).ok;
        } catch {
          /* 尚未就绪 */
        }
      }
      const startupSeconds = ((Date.now() - started) / 1000).toFixed(1);
      assert(ready, `严格模式实例应在 60 秒内就绪（实测已等 ${startupSeconds} 秒；空库启动含一次密钥派生约 12.5 秒）`);

      /* ①′ 首次初始化：本实例的配置文件给出了 `bootstrap.token`，缺它不许初始化，
          否则"服务起来了但还没初始化"的那个窗口里，任何能访问本端口的人都能把自己变成管理员，
          而装机脚本恰好是在这个窗口里访问它的。三半都断言：缺凭据被拒 / 有凭据可建 / 建完即关闭。 */
      /* 初始化之前，登录页应当是"首次初始化"形态，这是服务端二选一的另一半，
         在主实例上验不到（它那时已经有账号了）。 */
      const freshLogin = await (await fetch(`${base}/login`)).text();
      assert(freshLogin.includes('id="bootstrapForm"'), '空库时登录页应下发初始化表单');
      assert(!freshLogin.includes('id="loginForm"'), '空库时不该下发登录表单（还没有账号可登）');
      const noToken = await call('/api/admin/bootstrap', '', { username: ADMIN_USER, password: ADMIN_PASSWORD });
      assertEqual(noToken.code, 'E_BOOTSTRAP_DEPLOY_TOKEN', '配置文件给出了 bootstrap.token 时，初始化必须同时给出它');
      const strictAdmin = await provisionAccounts(base, STRICT_DEPLOY_TOKEN);
      /* 严格模式实例是另一台机器（另一个库）：包是部署产物，新库就是空的，
         而 §⑤ 要验"质控员能开关规则包"，前提是这台机器上真的装了包。
         这一步就是测试在声明这个前提（与主实例开头那次 `loadSamplePacks()` 同一件事）。
         漏了它，§⑤ 会以"包尚未装载"失败，那看起来像权限判错了，实际只是夹具缺了一半。 */
      const strictSeeded = await call('/api/knowledge-pack-load', strictAdmin, { sample: true });
      assertEqual(strictSeeded.ok, true, `严格模式实例应能载入样例包：${String(strictSeeded.message ?? '')}`);
      const madeViewer = await call('/api/admin/users', strictAdmin, { username: BRUTE_USER, password: BRUTE_PASSWORD, role: 'viewer' });
      assertEqual(madeViewer.ok, true, `管理员应能新增账号：${String(madeViewer.message ?? '')}`);
      const bootAgain = await call('/api/admin/bootstrap', '', { username: 'nobody', password: 'nobody-nobody-1', deployToken: STRICT_DEPLOY_TOKEN });
      assertEqual(bootAgain.code, 'E_ALREADY_INITIALIZED', '初始化入口是一次性的（留着它就是"谁先来谁当管理员"的后门）');

      /* ① 收口的是写路径，不是整个服务：读视图仍然开放（否则界面打开就是空白） */
      assertEqual((await call('/api/state', '')).ok, true, '读视图不该被一起收口');

      /* ② 无会话写病历 → 拒，且理由指向"去登录" */
      const anon = await call('/api/set-field', '', { nodeId: 'n_s3_p1_f1', value: '36.6' });
      assertEqual(anon.ok, false, '严格模式下无会话不得写病历');
      assertEqual(anon.code, 'E_AUTH_REQUIRED', '应报"需要登录"');
      assert(String(anon.message ?? '').includes('登录'), `理由要指向登录，实际：${String(anon.message)}`);

      /* ③ 医生会话可以写（这一步还会把落盘口令的派生算一次，之后都走缓存） */
      const clinician = await login(...AS_CLINICIAN);
      const wrote = await call('/api/set-field', clinician, { nodeId: 'n_s3_p1_f1', value: '36.6' });
      assertEqual(wrote.ok, true, `医生会话应能写：${String(wrote.message ?? '')}`);

      /* ④ 同样"登录了"，质控员就不能写病历，授权看的是角色，不是"登录了没有" */
      const qcWrite = await call('/api/set-field', await login(...AS_QC), { nodeId: 'n_s3_p1_f1', value: '37.0' });
      assertEqual(qcWrite.ok, false, '质控员不得写病历');
      assertEqual(qcWrite.code, 'E_PERMISSION_DENIED', '应报"角色不够"（与"没登录"分开的另一种码）');
      assert(String(qcWrite.message ?? '').includes('医生'), `理由要说清哪些角色可以，实际：${String(qcWrite.message)}`);

      /* ⑤ 权限表不是"全有或全无"：质控员能开关规则包，但改不了模型接入配置 */
      const qc = await login(...AS_QC);
      const qcToggle = await call('/api/knowledge-pack-toggle', qc, { packId: 'qc.form.builtin', itemId: 'R-FORM-03', enabled: false });
      assertEqual(qcToggle.ok, true, `质控员应能开关规则包：${String(qcToggle.message ?? '')}`);
      const qcConfig = await call('/api/model-config', qc, {});
      assertEqual(qcConfig.ok, false, '质控员不得改模型接入配置');
      assertEqual(qcConfig.code, 'E_PERMISSION_DENIED', '同上：角色不够');

      /* ⑥ 医生不得触发外呼（会花钱、会把配置发到外部地址） */
      const doctorCall = await call('/api/model-config/test', await login(...AS_CLINICIAN), {});
      assertEqual(doctorCall.ok, false, '医生不得触发模型外呼');
      assertEqual(doctorCall.code, 'E_PERMISSION_DENIED', '同上');

      /* ⑦ 身份与租户只能来自会话：请求体里带 actorId / tenant 一律被忽略。
         这不是"顺手加的防护"，而是这类系统最常见漏洞的入口，从请求决定身份或租户。 */
      const clinician2 = await login(...AS_CLINICIAN);
      const spoofed = await call('/api/set-field', clinician2, {
        nodeId: 'n_s3_p1_f1',
        value: '36.7',
        actorId: ADMIN_USER,
        tenant: 'other-tenant',
        role: 'admin',
      });
      assertEqual(spoofed.ok, true, '带伪造字段的请求仍按会话身份执行（不是被拒，是被忽略）');
      const info = (await call('/api/session', clinician2)).data as { actorId?: string; role?: string; tenant?: string; mode?: string };
      assertEqual(info.actorId, CLINICIAN_USER, '身份来自会话，不是请求体');
      assertEqual(info.role, 'clinician', '角色来自会话，不是请求体');
      assertEqual(info.mode, 'strict', '会话接口要报出鉴权模式');
      assertEqual(info.tenant, 'default', '租户来自会话（当前恒为 default），绝不由 URL / 请求体决定');

      /* ⑧ 归属也取自会话：只做门禁不改归属，"谁写的"就还是假的。
         做法：医生会话产出并采纳一条建议，看节点上的 acceptedBy 记的是谁。
         目标节点从状态里取（不写死 id）：节点标识随模板变过，写死会让用例在下一次
         改模板时以"节点不存在"的形式失败，那看起来像鉴权坏了，实际只是夹具过期了。 */
      const clinician3 = await login(...AS_CLINICIAN);
      const textNodeId = String(
        ((await stateOf(clinician3)).items as Array<{ id: string; kind: string }>).find((item) => item.kind === 'text')?.id ?? '',
      );
      assert(textNodeId !== '', '前置：能找到可产出建议的文本节点');
      const suggested = await call('/api/suggest', clinician3, { nodeId: textNodeId, mode: 'polish' });
      assertEqual(suggested.ok, true, `医生会话应能产出建议：${String(suggested.message ?? '')}`);
      const pendingList = (await stateOf(clinician3)).suggestions as Array<{ id: string; status: string }>;
      const pending = pendingList.find((item) => item.status === 'pending');
      assert(!!pending, `应有一条待处理建议，实际：${JSON.stringify(pendingList.slice(0, 3))}`);
      const accepted = await call('/api/accept', clinician3, { suggestionId: pending?.id });
      assertEqual(accepted.ok, true, `采纳应成功：${String(accepted.message ?? '')}`);
      const items = (await stateOf(clinician3)).items as Array<{ id: string; acceptedBy?: string }>;
      const acceptedBy = String(items.find((item) => item.acceptedBy)?.acceptedBy ?? '');
      assert(acceptedBy.includes(CLINICIAN_USER), `采纳者应记会话身份（${CLINICIAN_USER}），实际：${acceptedBy || '（无）'}`);
      assert(!acceptedBy.includes('DR_DEMO'), '不得记成病历创建人，那正是"鉴权只做了一半"的形态');

      /* ⑨ 会话到点即失效，且与"没登录"分开报（医生刚登录不该被说成没登录）。
         会话寿命来自库里的 `config.system.sessionTtlMinutes`（本实例设成 1 分钟，
         即校验允许的**最小正整数**），所以这条要**真的等到它过期**：
         先确认登录响应给出的失效时刻确实按 1 分钟算（证明寿命真的来自库里的配置），
         再等到那一刻之后断言拒绝。
         （原先用 `L0_SESSION_TTL_MINUTES=0.05` 让会话 3 秒就过期；那条路随环境变量一起删掉了 ——
           库里的寿命只收正整数，秒级的过期现在表达不了，所以这里改成等真正的到点时刻。） */
      const expiring = await loginWithExpiry(...AS_CLINICIAN);
      const minutesAway = (expiring.expiresAt - Date.now()) / 60000;
      assert(
        minutesAway > 0 && minutesAway <= 1,
        `会话寿命应来自库里的 sessionTtlMinutes=1（登录后约 1 分钟内失效），实际 ${minutesAway.toFixed(2)} 分钟`,
      );
      assertEqual((await call('/api/set-field', expiring.cookie, { nodeId: 'n_s3_p1_f1', value: '36.8' })).ok, true, '前置：会话有效时可写');
      /* `/api/session` 会滑动续期并回显**新的**失效时刻：以它为准算"还要等多久"，
         这样无论前面几次续期把到期时刻推到了哪里，等到它之后都必然已过期。 */
      const live = (await call('/api/session', expiring.cookie)).data as { expiresAt?: string } | undefined;
      const liveExpiresAt = Date.parse(String(live?.expiresAt ?? ''));
      assert(Number.isFinite(liveExpiresAt), `会话接口应回显失效时刻（否则无从知道该等到何时），实际：${String(live?.expiresAt)}`);
      const waitMs = liveExpiresAt + 2000 - Date.now();
      if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
      const expired = await call('/api/set-field', expiring.cookie, { nodeId: 'n_s3_p1_f1', value: '36.9' });
      assertEqual(expired.ok, false, '过期之后不得再写');
      assertEqual(expired.code, 'E_SESSION_EXPIRED', '应报"已过期"而不是"需要登录"');
      assert(String(expired.message ?? '').includes('过期'), `理由要说清是过期，实际：${String(expired.message)}`);

      /* ⑩ 登录失败有代价（原先可以无限猜口令），且成功会清零该账号的失败计数。
         用独立账号打（BRUTE_USER，①′ 里刚建的那个）：否则会把后面要用的 ADMIN 桶一起打满。
         顺带把"新建的账号真的能登录"也证了。 */
      const wrong = async (): Promise<Json> => {
        const res = await fetch(`${base}/api/admin/session`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: BRUTE_USER, password: 'wrong-password' }),
        });
        return (await res.json()) as Json;
      };
      /* 先证"成功会清零"：失败一次 → 正确口令登录成功（清零）→ 紧接着的失败应重新从 1 数起。
         不证这一条的话，手滑两次的正常用户会被关在门外五分钟。 */
      const firstWrong = await wrong();
      assertEqual(firstWrong.ok, false, '第 1 次失败');
      /* 失败码与文案都不区分"账号不存在"与"口令错"：分开说就是给爆破者一个"这个账号存在"的反馈 */
      assertEqual(firstWrong.code, 'E_LOGIN_FAILED', '口令错应报统一的 E_LOGIN_FAILED');
      assert(!String(firstWrong.message ?? '').includes('不存在'), '文案不得透露账号是否存在');
      assert((await login(BRUTE_USER, BRUTE_PASSWORD)) !== '', '此时还没到上限，正确口令应能登录');
      assertEqual((await wrong()).code, 'E_LOGIN_FAILED', '成功之后计数已清零：紧接着的失败应报"口令不正确"，而不是"被限流"');

      assertEqual((await wrong()).ok, false, '第 2 次失败（上限设成 2）');
      const blocked = await wrong();
      assertEqual(blocked.code, 'E_RATE_LIMITED', '第 3 次应被限流');
      assert(Number(blocked.retryAfterSec ?? 0) >= 1, `应给出可执行的重试间隔，实际：${String(blocked.retryAfterSec)}`);

      /* 限流窗口内连正确口令也要等。这是有意的：限流发生在验口令之前，
         否则攻击者只要每几次混入一个正确口令就能把窗口重置掉，限额也就白设了。
         代价是手滑的正常用户要等一个窗口，这个代价摆在这里，不假装不存在。 */
      const duringWindow = await fetch(`${base}/api/admin/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: BRUTE_USER, password: BRUTE_PASSWORD }),
      });
      const duringPayload = (await duringWindow.json()) as Json;
      assertEqual(duringPayload.code, 'E_RATE_LIMITED', '窗口内正确口令同样先等待（有意的取舍）');

      /* ⑪ 破坏性动作按角色判：医生"能写病历"却不能清空工作区（`workspace.reset` 只给管理员）。
         与 ③/④ 的区别在这里：③ 是"角色不能写病历"，这条是"角色能写病历、却不能擦掉一切"，
         权限表不是"全有或全无"，这是它在破坏性动作上的体现。
         两半都断言：只证明"医生被拒"，也可能只是这个路由坏了；管理员那一半证明它真的可用。 */
      const clinicianReset = await call('/api/reset', await login(...AS_CLINICIAN), {});
      assertEqual(clinicianReset.ok, false, '医生不得清空工作区');
      assertEqual(clinicianReset.code, 'E_PERMISSION_DENIED', '应报"角色不够"（不是"没登录"）');
      assertEqual(
        (await call('/api/reset', await login(...AS_ADMIN), {})).ok,
        true,
        '管理员应能重置，否则"只给管理员"就成了一句没有任何人满足的话',
      );

      /* ⑫ 管理视图的收口在两种模式下一致：未登录读不到审计 */
      assertEqual((await call('/api/admin/audit', '')).ok, false, '未登录不得读审计');

      /* ⑬ 被拒的动作进审计："谁试图做什么被拦下"是审计最该有的内容之一 */
      const auditRes = await call('/api/admin/audit', await login(...AS_ADMIN));
      const auditEntries = (auditRes.entries ?? []) as Array<{ subject?: string; note?: string }>;
      assert(
        auditEntries.some((item) => String(item.note ?? '').includes('被拒绝')),
        `审计里应有被拒绝的记录，实际最近几条：${JSON.stringify(auditEntries.slice(0, 3).map((item) => item.subject))}`,
      );
    } finally {
      /* 先等进程真的退出再删：`kill()` 之后立刻删会撞 EPERM（库文件还被占着），
         而这个 EPERM 会把"上面那些断言全过了"变成一个 FAIL —— 收尾的意外不该改写结论。 */
      await killAndWait(strict);
      /* 用完就删：状态目录里会留下含合成手机号的落盘快照，运行时目录里则是带密封口令的配置文件，
         留在仓库里会让隐私排查多出几条"需人工确认"（实测发现：排查因此多报 3 处命中、
         还要人去复核一堆每次运行都会变的行号）。测试造的产物不该让排查反复审。 */
      for (const dir of [strictDir, strictRuntimeDir]) {
        if (!existsSync(dir)) continue;
        try {
          rmRecursive(dir, { recursive: true, force: true });
        } catch (err) {
          /* 同上：删不掉只记一笔（结尾的清理还会再兜一次），不改写这条用例的结论 */
          console.warn(`[收尾] strict 实例的目录没清掉：${dir} —— ${(err as Error).message}`);
        }
      }
    }
  });

  await test('B38 时限类质控：按文书类型与入院时刻判定；不适用 ≠ 未判定（三态分清楚）', async () => {
    /* 形式类只看"这一段文字自己"，时限类还要看文书级事实（入院时刻、文书类型、就诊类型）。
       这条走真实 HTTP 把整条链串起来：
         ① 住院文书上新建一份入院记录（模板建的，写入时间=现在；入院时间=7 天前）→ 应判超时；
         ② 判超时的依据里必须写出两个时间（医生要知道你是拿哪两个时间比的）；
         ③ 门诊文书上这两条规则不适用，它既不是命中，也不该堆进"未判定"
            （把不适用报成未判定，那个列表很快就没人看了）。 */
    /* 先切到一份住院文书：新建的文书会挂在它的就诊下（入院时间 2026-10-05） */
    const inpatient = (await state()).tree
      .flatMap((patient) => patient.visits)
      .find((visit) => visit.visitType === 'inpatient');
    assert(!!inpatient, '前置：工作区里应有住院就诊');
    const inpatientDoc = inpatient?.docs[0]?.docId;
    assert(!!inpatientDoc, '前置：住院就诊下应有文书');
    assertEqual((await post('/api/open', { docId: inpatientDoc })).ok, true, '应能切到住院文书');

    /* ① 在住院就诊下新建一份入院记录（模板实例化的写入时间是"现在"） */
    const created = await post('/api/template-create', { templateId: 'tpl.admission.general' });
    assertEqual(created.ok, true, `新建入院记录应成功：${created.code ?? ''} ${created.message ?? ''}`);

    const scan = await post('/api/qc-form-check', {});
    assertEqual(scan.ok, true, '质控扫描应可执行');
    const data = scan.data as {
      rules: number;
      unevaluated: Array<{ ruleId: string; reason: string }>;
    };
    assertEqual(data.rules, 7, '两族规则都应参与（形式类 3 + 时限类 4）');

    const stateAfter = await state();
    const timeHit = stateAfter.annotations.find((item) => item.ruleId === 'R-TIME-01' || item.ruleId === 'R-TIME-02');
    assert(!!timeHit, `入院记录写在入院 7 天后应命中时限规则，实际提示：${JSON.stringify(stateAfter.annotations.map((a) => a.ruleId))}`);

    /* ①′ 每条时限要求只报一次：文书级规则若逐章节判，一份 7 章节的入院记录会得到 8 条
       一模一样的提示，实测踩到过（实机上跑出来的），而"提示变噪声"的后果是医生全部忽略。 */
    const timeHits = stateAfter.annotations.filter((item) => String(item.ruleId ?? '').startsWith('R-TIME-'));
    const timeRuleIds = timeHits.map((item) => String(item.ruleId));
    assertEqual(
      [...new Set(timeRuleIds)].every((id) => timeRuleIds.filter((each) => each === id).length === 1),
      true,
      `同一条时限要求在一份文书上只应报一次，实际：${JSON.stringify(timeRuleIds)}`,
    );

    /* ② 依据要能自己解释：两个时间都在里面，"超时"才不是一句无法核对的话 */
    const detail = String(timeHit?.detail ?? '');
    assert(detail.includes('2026-10-05T03:00:00Z'), `依据里要写出入院时间，实际：${detail}`);
    assert(/实际间隔 \d/.test(detail), `依据里要写出实际间隔，实际：${detail}`);

    /* ③ 住院文书上规则判了（不是未判定）：这条路径必须真的走通，否则"命中"无从谈起 */
    assert(
      data.unevaluated.every((item) => !item.ruleId.startsWith('R-TIME-')),
      `住院入院记录上时限规则应已判定，实际未判定：${JSON.stringify(data.unevaluated.map((i) => i.ruleId))}`,
    );

    /* ④ 门诊文书：时限规则不适用，既不该命中，也不该混进"未判定" */
    const outpatient = (await state()).tree
      .flatMap((patient) => patient.visits)
      .find((visit) => visit.visitType === 'outpatient')
      ?.docs[0]?.docId;
    assert(!!outpatient, '前置：工作区里应有门诊文书');
    assertEqual((await post('/api/open', { docId: outpatient })).ok, true, '应能切到门诊文书');

    const opdScan = await post('/api/qc-form-check', {});
    const opdData = opdScan.data as { unevaluated: Array<{ ruleId: string }> };
    const opdState = await state();
    assert(
      opdState.annotations.every((item) => !String(item.ruleId ?? '').startsWith('R-TIME-')),
      '门诊文书上不该出现时限类命中（切文书后提示是跟着文书走的）',
    );
    assertEqual(
      opdData.unevaluated.filter((item) => item.ruleId.startsWith('R-TIME-')).length,
      0,
      '"不适用"不得被报成"未判定"：那个列表一旦堆满无关条目，就没人会再看它',
    );
  });

  await test('B39 演示模式（open）：医生端动作不带会话也必须能用（这是"打开就能用"的定义）', async () => {
    /* 这条是 B29/B33 的镜像：那两条证明"改配置要登录"，这条证明"医生干活不用登录"。
       它守的是一个真实的坑：把某个医生端路由误放进"两种模式都要鉴权"的表里，
       浏览器上没有会话 → 按钮点了没用，而带 cookie 的用例照样全绿（实测踩到）。
       所以这里一律用 `postNoAuth`，与浏览器里的医生处境一致。 */
    for (const [label, path, body] of [
      ['质控扫描', '/api/qc-form-check', {}],
      ['一致性检查', '/api/check-consistency', {}],
      ['字段录入', '/api/set-field', { nodeId: 'n_s3_p1_f1', value: '36.6' }],
    ] as Array<[string, string, Record<string, unknown>]>) {
      const result = await postNoAuth(path, body);
      assertEqual(result.ok, true, `演示模式下「${label}」不带会话也应可用，实际：${result.code ?? ''} ${result.message ?? ''}`);
    }

    /* 而"改部署参数"与"清空工作区"这两件事，即使在演示模式下也要登录，
       边界在同一条用例里对照着看。后者是破坏性动作（清空全部病历、已落盘的旁挂数据、
       阅读授权登记），此前它只在严格模式收口，等于演示模式下任何能访问本端口的人
       都能一键清空这台机器。那是本仓库最实的一个洞，这条就是它的封口。 */
    for (const [label, path, body] of [
      ['改部署参数', '/api/placement-config', { strategy: 'ordered', confidenceCeiling: 0.85 }],
      ['重置工作区', '/api/reset', {}],
    ] as Array<[string, string, Record<string, unknown>]>) {
      const withoutSession = await postNoAuth(path, body);
      assertEqual(withoutSession.ok, false, `演示模式下「${label}」不带会话应被拒（与上面三条形成对照）`);
      assertEqual(withoutSession.code, 'E_AUTH_REQUIRED', `「${label}」应给出"需要登录"的错误码`);
    }
    /* 拒绝理由必须指向可执行的一步（去登录），"照着提示做却发现无处可做"是本仓库
       反复踩过的一类缺陷（见 `SnapshotConflictError` 那条"请重新载入"的教训）。 */
    const resetDenied = await postNoAuth('/api/reset', {});
    assert(
      String(resetDenied.message ?? '').includes('登录'),
      `重置被拒时理由要指向登录，实际：${String(resetDenied.message)}`,
    );
  });

  await test('B40 跨文书时限：间隔看的是这一次就诊的文书时间线，不是当前这一份', async () => {
    /* 证明"跨文书"真的跨了：当前打开的是一份成文于入院当时的入院记录，
       而报出来的间隔是"另一份文书（病程记录）之后一直没写"，结论里的时间与文书 id
       都不是当前这一份的。若引擎只看当前文书，这条永远报不出来。 */
    const inpatient = (await state()).tree
      .flatMap((patient) => patient.visits)
      .find((visit) => visit.visitType === 'inpatient');
    assert(!!inpatient, '前置：应有住院就诊');
    const admDoc = inpatient?.docs.find((doc) => doc.docId === 'doc_002_adm')?.docId;
    assert(!!admDoc, '前置：住院就诊下应有一份入院记录');
    assertEqual((await post('/api/open', { docId: admDoc })).ok, true, '应能切到该入院记录');

    const scan = await post('/api/qc-form-check', {});
    assertEqual(scan.ok, true, '质控扫描应可执行');
    const after = await state();
    const gap = after.annotations.find((item) => item.ruleId === 'R-TIME-03');
    assert(!!gap, `住院期间病程记录间隔超限应命中，实际：${JSON.stringify(after.annotations.map((a) => a.ruleId))}`);

    const detail = String(gap?.detail ?? '');
    /* 依据里点名的必须是另一份文书，这正是"跨文书"的可验证标志 */
    assert(detail.includes('doc_002_prog'), `依据里应点名间隔涉及的那份文书，实际：${detail}`);
    assert(/最长间隔 \d/.test(detail), `依据里要写出实际间隔，实际：${detail}`);
    /* 锚点落在当前文书的根节点上：跨文书结论必须有归属地，否则它在界面上无处可看 */
    assertEqual(gap?.nodeId, 'n_root', '跨文书提示应挂在当前文书的根节点上');

    /* 判得了就不该混进"未判定"：这条路径拿到了就诊文书清单 */
    const data = scan.data as { unevaluated: Array<{ ruleId: string }> };
    assert(
      data.unevaluated.every((item) => item.ruleId !== 'R-TIME-03'),
      `拿到了文书清单就不该报"未判定"，实际：${JSON.stringify(data.unevaluated)}`,
    );
  });

  await test('B40b 就诊时间轴：摊开的是这次就诊的全部文书，缺口与注解说同一句话', async () => {
    /* 这条要证明三件事，缺一件都不算成立：
       ① 轴上摊开的是**整个就诊**（三份文书各有成文时刻，而不是"当前这一份"）；
       ② 缺口落在**线上**（能说出是哪一份到哪一份、多少小时），且右端是出院时刻；
       ③ 判定没另起一套 —— 时间轴里的依据与「质控提示」里那条注解**逐字相同**。 */
    assertEqual((await post('/api/open', { docId: 'doc_002_prog' })).ok, true, '应能切到该住院就诊的病程记录');

    const timeline = await post('/api/visit-timeline', {});
    assertEqual(timeline.ok, true, '时间轴应可读取');
    const data = timeline.data as {
      docs: Array<{ docId: string; createdAt: string; isCurrent: boolean }>;
      dischargedAt: string | null;
      endAt: string;
      segments: Array<{ docTypeCode: string; fromDocId: string; toDocId: string | null; hours: number; limitHours: number; exceeds: boolean }>;
      gaps: Array<{ ruleId: string; detail: string; segment: { fromDocId: string } | null }>;
      trend: { changes: Array<{ detail: string }>; skipped: Array<{ reason: string }> };
    };

    /* 不断言"轴上只有这三份"：别的用例会往同一次就诊里再开文书（`doc_tpl_*`），
       那样断言会把这条用例变成"考测试执行顺序"，而不是考这条轴 */
    const order = data.docs.map((doc) => doc.docId);
    const seeded = ['doc_002_adm', 'doc_002_prog', 'doc_002_dis'];
    const positions = seeded.map((docId) => order.indexOf(docId));
    assert(positions.every((index) => index >= 0), `轴上应摊开这次就诊的种子文书，实际：${JSON.stringify(order)}`);
    assert(positions[0] < positions[1] && positions[1] < positions[2], '轴必须按成文时刻升序');
    assertEqual(data.docs.filter((doc) => doc.isCurrent).map((doc) => doc.docId), ['doc_002_prog'], '当前文书要标出来');
    assertEqual(data.dischargedAt !== null && data.endAt === data.dischargedAt, true, '已出院的就诊，间隔的右端应是出院时刻');

    /* 病程记录之后到出院那一段：54 小时（> 24 小时时限）—— 这正是"线上看出来的缺口" */
    const tail = data.segments.find((segment) => segment.docTypeCode === 'WST500.3' && segment.fromDocId === 'doc_002_prog');
    assert(!!tail, `应有"第一份病程记录之后"那一段，实际：${JSON.stringify(data.segments)}`);
    assert(tail !== undefined && tail.hours >= 54, `出院前至少 54 小时没有病程记录（后续用例可能再加文书，只会更长），实际 ${tail?.hours ?? 0}`);
    assertEqual(tail?.limitHours, 24, '时限来自规则包（不是代码里写死的 24）');
    assertEqual(tail?.exceeds, true, '超过时限的那一段要标出来');

    const gap = data.gaps.find((item) => item.ruleId === 'R-TIME-03');
    assert(!!gap, `轴上应有 R-TIME-03 的缺口，实际：${JSON.stringify(data.gaps.map((item) => item.ruleId))}`);
    assert(!!gap?.segment, '缺口必须落到轴上某一段：说不出"断在哪两份之间"的缺口，界面画不出来');

    /* ③ 与注解逐字比对：**同一份文书、同一次就诊**上，质控扫描给出的依据与轴上的缺口必须一模一样。
       先扫一次：切文书之后 `state.annotations` 换成这一份的（各文书状态互相独立），
       拿上一份的注解来比，比的就成了"两份不同文书的结论"。 */
    assertEqual((await post('/api/qc-form-check', {})).ok, true, '质控扫描应可执行');
    const after = await state();
    const annotation = after.annotations.find((item) => item.ruleId === 'R-TIME-03');
    assert(!!annotation, '前置：B40 跑过质控，注解应在册');
    assertEqual(gap?.detail, annotation?.detail, '时间轴的依据必须与质控注解逐字相同（措辞只该有一处）');

    /* 趋势对照：异常点要带上"后面有没有再记录"的依据；判不了的必须列出原因 */
    assert(data.trend.changes.length > 0, '住院期间有参考范围外的体征，应进入对照');
    assert(data.trend.changes.every((change) => String(change.detail).length > 0), '每条对照都要写清依据');
    assert(data.trend.skipped.every((item) => String(item.reason).length > 0), '判不了的那部分也要写明原因');

    /* 读数随 state 下发：否则任何一次无关动作触发重渲染，这一栏就空了 */
    const snapshot = await state();
    assert(!!snapshot.visitTimeline, 'state 里应带上时间轴读数（重渲染不丢）');
  });

  await test('B41 落库实证：重启服务之后写入仍在，而且是从库里读回来的', async () => {
    /* 这是"存储落到数据库"这件事的唯一硬证据：进程重启之后数据还在。
       关键是重启不擦库（`restartServer` 与开头那次不同），
       擦掉库再起只能证明"出厂播种还在"，证明不了任何东西。 */
    const beforeState = await state();
    assert(beforeState.database.file.endsWith('l0.db'), `工作数据应落在数据库文件上，实际：${beforeState.database.file}`);
    assert(beforeState.database.documents > 0, `库里应有文书，实际 ${beforeState.database.documents} 份`);
    assert(beforeState.database.revisions > 0, '留痕也应落库（界面上的 rev 与它一致）');

    const docId = beforeState.activeDocId;
    const field = beforeState.items.find((item) => item.kind === 'field');
    assert(!!field, '前置：当前文书应有可填写的字段');
    const marker = '36.9';
    assertEqual((await post('/api/set-field', { nodeId: field!.id, value: marker })).ok, true, '写入应成功');

    await restartServer();

    /* 重启后当前打开的文书会回到库里第一份，这一条是不落库的：
       "打开的是哪一份"是视图状态，多用户系统里它属于会话而不是全局数据。
       所以这里显式打开刚才那一份，再验"数据还在不在"。 */
    assertEqual((await post('/api/open', { docId })).ok, true, `重启后应能打开 ${docId}`);
    const afterState = await state();
    assertEqual(afterState.activeDocId, docId, '显式打开后应是那一份');
    assertEqual(
      String(afterState.items.find((item) => item.id === field!.id)?.value ?? ''),
      marker,
      '重启后写入的值必须还在，否则"落库"是假的',
    );
    assertEqual(afterState.doc.rev > 1, true, `留痕也应一并回来（rev 是从库里读的），实际 ${afterState.doc.rev}`);
  });

  await test('B73 重启装载：库里文书的机读信息陈旧不该拦住启动（导出照旧被拦）', async () => {
    /* 这条守的是一个**真发生过的故障**（2026-10-17）：
       在浏览器里改了一段字（机读信息随之变旧），随后重启服务 —— 装载路径走的是
       `WriteSession.open`，它把「机读信息陈旧」判成"文档不合法"，于是**整台服务退出**
       （实测：doc_001_opd 的 sourceHash 与当前内容指纹不一致，进程起不来）。
       而机读信息新鲜度是**导出**的门，不是"能不能装载"的门 —— 两件事必须分开。
       这条把它钉住：装载必须放行，且**不许偷偷重算**（陈旧这个事实要留着，界面才说得出"需重算"），
       导出的门一分钟都不能松。 */
    await adminLogin();
    assertEqual((await post('/api/reset', {})).ok, true, '前置：复位工作区（从播种态出发）');
    const before = await state();
    const docId = before.activeDocId;
    const field = before.items.find((item) => item.kind === 'field');
    assert(!!field, '前置：当前文书应有可填写的字段');

    /* ① 先派生一份机读信息，再改内容 —— 造出"内容改过、还没重算"这个中间态。
          必须先派生：**没有**机读块的文书本来就不会被校验拦（缺失 ≠ 陈旧），
          少了这一步，这条用例会在"其实没构造出那种文书"的情况下变绿。 */
    assertEqual((await post('/api/refresh-machine')).ok, true, '前置：先派生机读信息');
    assertEqual((await state()).machine.stale, false, '刚重算过应是新鲜的');
    assertEqual((await post('/api/set-field', { nodeId: field!.id, value: '37.2' })).ok, true, '写入应成功');
    assertEqual((await state()).machine.stale, true, '改过内容、没重算 → 机读信息应是陈旧的');

    /* ② 重启：装载不能被它拦住（这是本用例的核心 —— 此前这里会让进程直接退出，
          `spawnServer` 等不到端口，整套用例跟着一起红） */
    await restartServer();
    assertEqual((await post('/api/open', { docId })).ok, true, `重启后服务应在，且能打开 ${docId}`);
    const after = await state();
    assertEqual(after.machine.stale, true, '豁免装载 ≠ 偷偷重算：重启后仍应是"待重算"');
    assertEqual(
      String(after.items.find((item) => item.id === field!.id)?.value ?? ''),
      '37.2',
      '写入仍在（顺带证明这次重启没擦库）',
    );

    /* ③ 真正的门在导出那一侧，且不能被上面的豁免连带放松 */
    const blocked = await post('/api/export');
    assertEqual(blocked.ok, false, '机读信息陈旧时不得导出');
    assertEqual(blocked.code, 'E_MACHINE_READABLE_STALE', '应报"机读信息陈旧"（不是别的错）');

    /* ④ 重算之后立刻能导出：证明拦它的确实只是"陈旧"，而不是装载留下了别的坏状态 */
    assertEqual((await post('/api/refresh-machine')).ok, true, '重算机读信息应成功');
    assertEqual((await state()).machine.stale, false, '重算后应为新鲜');
    assertEqual((await post('/api/export')).ok, true, '重算后导出应成功');
  });

  await test('B42 医生端登录：入口就在医生端（/api/session），身份决定"能做什么"，可退出；重置的留痕跨重置留存', async () => {
    /* 为什么要有这条：此前医生端没有任何登录入口，严格模式下的医生只能去 /admin 登录，
       而那是"能力配置"的地方（位置本身就是错的）。这条证明医生端自己就能登录/退出，
       并且登录之后"能做什么"真的由服务端权限表决定，而不是"登录了就什么都能做"。 */
    /* ⓪ 先复位：本用例要断言"医生写病历成功"，而工作区此刻可能是已签章的
       （签章之后写入会被拒，那是另一条用例在管的事）。不先复位的话，这条断言会
       因为前面用例留下的状态而变红，那看起来像鉴权坏了，实际只是夹具过期了。 */
    await adminLogin();
    assertEqual((await post('/api/reset', {})).ok, true, '前置：复位工作区');

    /* ① 医生从医生端登录（同一个会话存储，不是"医生专用的另一套"） */
    const clinician = await loginAt(BASE, ...AS_CLINICIAN);
    const info = (await callWith('/api/session', clinician)).data as {
      authenticated?: boolean;
      actorId?: string;
      role?: string;
      mode?: string;
      actions?: Record<string, boolean>;
    };
    assertEqual(info.authenticated, true, '登录后会话接口应报已登录');
    assertEqual(info.actorId, CLINICIAN_USER, '身份取自会话里的账号名，不是请求体');
    assertEqual(info.role, 'clinician', '角色是账号自己的属性（不再由"匹配到哪条口令"决定）');
    assertEqual(info.mode, 'open', '要报出鉴权模式（界面据此才敢说"写病历不需要登录"）');
    assertEqual(info.actions?.['doc.write'], true, '医生能写病历');
    assertEqual(info.actions?.['workspace.reset'], false, '医生不能重置工作区（破坏性动作只给管理员）');

    /* ② 医生写病历：这条在两种模式下都成立（open 不鉴权、strict 判角色），所以是稳定的边界 */
    assertEqual(
      (await callWith('/api/set-field', clinician, { nodeId: 'n_s3_p1_f1', value: '36.6' })).ok,
      true,
      '医生会话应能写病历',
    );

    /* ③ 界面要能据此把「重置」置灰：状态里必须明确说出哪些动作在两种模式下都被收口 */
    assertEqual(
      (await state()).auth.destructiveGuarded,
      ['workspace.reset'],
      '破坏性动作清单要下发（界面据此置灰并说明理由）',
    );

    /* ④ 医生点重置 → 被拒，理由指向管理员（不是笼统的"无权限"） */
    const denied = await callWith('/api/reset', clinician, {});
    assertEqual(denied.ok, false, '医生不得清空工作区');
    assertEqual(denied.code, 'E_PERMISSION_DENIED', '应报"角色不够"（与"没登录"分开：两者下一步动作不同）');
    assert(
      String(denied.message ?? '').includes('管理员'),
      `理由要说清需要什么身份，实际：${String(denied.message)}`,
    );

    /* ⑤ 退出：会话被吊销，同一个 cookie 立刻失效 */
    assertEqual((await callWith('/api/session/logout', clinician, {})).ok, true, '退出应成功');
    const after = (await callWith('/api/session', clinician)).data as { authenticated?: boolean };
    assertEqual(after.authenticated, false, '退出之后同一个 cookie 不该还能用');

    /* ⑥ 管理员重置 → 成功；而且留痕留在管理审计里。
       这一条是这条用例的重点：工作区被清空之后，门控日志也跟着被清掉了，
       只有管理审计还答得出"谁在什么时候清空了这台机器"。 */
    await adminLogin();
    assertEqual((await post('/api/reset', {})).ok, true, '管理员应能重置');
    const audit = await getAuth('/api/admin/audit');
    const entries = (audit.entries ?? []) as Array<{ subject?: string; note?: string; actor?: string }>;
    assert(
      entries.some((item) => String(item.subject ?? '').includes('重置工作区')),
      `管理审计里应有重置记录（工作区被清空后它是唯一还查得到的地方），实际最近几条：${JSON.stringify(
        entries.slice(0, 3).map((item) => item.subject),
      )}`,
    );
    assert(
      entries.some((item) => String(item.note ?? '').includes('被拒绝')),
      '被拒绝的尝试也要进审计，"谁试图做什么被拦下"是审计最该有的内容之一',
    );
    /* 新工作区的第一行日志要说明它为什么是空的（否则医生打开看到空工作区会以为数据丢了） */
    const fresh = await state();
    assert(
      String(fresh.log[0]?.action ?? '').includes('重置'),
      `重置后的第一条日志应说明工作区为什么是空的，实际：${JSON.stringify(fresh.log.slice(0, 2).map((item) => item.action))}`,
    );
  });

  await test('B43 后台账号：用户名+口令入库、可增删改停用、改完即踢会话、清单只给管理员', async () => {
    /* 这一轮的交付物：口令从环境变量搬进数据库。要证的五件事，
       ① 账号在库里（不是进程内的常量），清单只下发白名单字段；
       ② 非管理员连清单都读不到（账号清单回答的是"谁能进来"，属于管理面）；
       ③ 改角色 / 停用 / 重设口令都会立刻吊销该账号的会话，
          否则"我已经把他停用了"只是库里的一句话，而他的浏览器里那张票还活着；
       ④ 三条红线里可在 HTTP 上验到的那条：不许把自己关在门外；
       ⑤ 审计记下"谁对哪个账号做了什么"，且口令一个字都不进审计。
       为什么值得独立一条：它是"发钥匙"这条链路，出错的方式不是"功能不可用"，
       而是"某个人进不来"或"某个人本该进不来却还进得来"，两者都不会自己冒出来。

       「最后一个可用管理员」那条红线在 HTTP 上验不到：只有管理员能调这些接口，
       而当库里只剩一个管理员时，他对自己动手会先撞上"不许操作自己"（那条更早）。
       它真正起作用的地方是命令行工具（`npm run user`，操作者记作 `cli`，永远不等于任何用户名），
       规则本身由 `test:users` 的 U7 在数据层钉住。 */

    const tmpUser = 'acct-b43';
    const tmpPass1 = 'selftest-tmp-password-1';
    const tmpPass2 = 'selftest-tmp-password-2';

    /* ① 账号在库里：来源读的是服务端事实，不是界面文案 */
    const sys = (await getAuth('/api/admin/system')) as unknown as {
      accounts?: { initialized?: boolean; total?: number; admins?: number; source?: string };
    };
    assertEqual(sys.accounts?.initialized, true, '账号应当已经在库里（初始化过）');
    assert((sys.accounts?.total ?? 0) >= 3, `初始化 + 两个角色账号，至少 3 个，实际 ${String(sys.accounts?.total)}`);
    assert(String(sys.accounts?.source ?? '').includes('admin_users'), `来源要说清是哪个表，实际：${String(sys.accounts?.source)}`);

    const listUsers = async (): Promise<Array<Record<string, unknown>>> => {
      const r = (await getAuth('/api/admin/users')) as unknown as { ok?: boolean; data?: { users?: Array<Record<string, unknown>> } };
      assertEqual(r.ok, true, '管理员应能读账号清单');
      return r.data?.users ?? [];
    };
    const before = await listUsers();
    assert(before.some((u) => u.username === ADMIN_USER && u.role === 'admin'), '清单里应有管理员账号');
    assertEqual('password_hash' in (before[0] ?? {}), false, '字段白名单里不得有 password_hash');
    assert(!JSON.stringify(before).includes('scrypt$'), '清单里不得带出哈希串（只带算法名）');

    /* ② 非管理员读不到清单，也建不了账号 */
    const qcCookie = await loginAt(BASE, ...AS_QC);
    const qcRead = await callWith('/api/admin/users', qcCookie);
    assertEqual(qcRead.ok, false, '质控员不得读账号清单');
    assertEqual(qcRead.code, 'E_PERMISSION_DENIED', '应报"角色不够"（不是"没登录"）');
    const qcCreate = await callWith('/api/admin/users', qcCookie, { username: 'sneaky', password: 'sneaky-password-1', role: 'admin' });
    assertEqual(qcCreate.ok, false, '质控员不得新增账号');
    assert(!(await listUsers()).some((u) => u.username === 'sneaky'), '被拒的新增不得留下任何账号');

    /* ③ 新增 → 登录 → 改角色 → 会话立刻失效 */
    const created = await post('/api/admin/users', { username: tmpUser, password: tmpPass1, role: 'viewer' });
    assertEqual(created.ok, true, `新增账号应成功：${created.code ?? ''} ${created.message ?? ''}`);
    assert(!JSON.stringify(created).includes(tmpPass1), '响应体里不得回显刚设的口令');
    assertEqual(
      (await post('/api/admin/users', { username: tmpUser, password: tmpPass1, role: 'viewer' })).code,
      'E_USER_EXISTS',
      '同名再建一次应被拒（用户名不区分大小写）',
    );

    const tmpCookie = await loginAt(BASE, tmpUser, tmpPass1);
    const asViewer = (await callWith('/api/session', tmpCookie)).data as { authenticated?: boolean; role?: string };
    assertEqual(asViewer.authenticated, true, '新建的账号应当能登录');
    assertEqual(asViewer.role, 'viewer', '角色是账号自己的属性');

    const reroled = await post('/api/admin/users/role', { username: tmpUser, role: 'clinician' });
    assertEqual(reroled.ok, true, `改角色应成功：${reroled.code ?? ''} ${reroled.message ?? ''}`);
    assertEqual(
      ((await callWith('/api/session', tmpCookie)).data as { authenticated?: boolean }).authenticated,
      false,
      '改角色后旧会话必须立刻失效（否则权限变了而旧票还活着）',
    );
    const asClinician = (await callWith('/api/session', await loginAt(BASE, tmpUser, tmpPass1))).data as { role?: string };
    assertEqual(asClinician.role, 'clinician', '重新登录后应当是新角色');

    /* ④ 停用 → 登不进来；启用 → 又能进来 */
    const disabled = await post('/api/admin/users/disabled', { username: tmpUser, disabled: true });
    assertEqual(disabled.ok, true, `停用应成功：${disabled.code ?? ''} ${disabled.message ?? ''}`);
    const blocked = await callWith('/api/admin/session', '', { username: tmpUser, password: tmpPass1 });
    assertEqual(blocked.ok, false, '停用后不得登录');
    assertEqual(blocked.code, 'E_USER_DISABLED', '应明确说"已停用"（口令是对的，所以这条只告诉账号主人本人）');
    assert(
      ((await listUsers()).find((u) => u.username === tmpUser)?.disabled) === true,
      '清单要显示"已停用"（否则界面上看不出这个人为什么进不来）',
    );
    assertEqual((await post('/api/admin/users/disabled', { username: tmpUser, disabled: false })).ok, true, '启用应成功');
    assertEqual((await loginAt(BASE, tmpUser, tmpPass1)).length > 0, true, '启用后应能重新登录');

    /* ⑤ 重设口令 → 旧的失效、新的可用；升级为管理员再删掉，确认删除真的落库 */
    assertEqual((await post('/api/admin/users/password', { username: tmpUser, password: tmpPass2 })).ok, true, '重设口令应成功');
    assertEqual(
      (await callWith('/api/admin/session', '', { username: tmpUser, password: tmpPass1 })).code,
      'E_LOGIN_FAILED',
      '旧口令必须立刻失效',
    );
    assertEqual((await loginAt(BASE, tmpUser, tmpPass2)).length > 0, true, '新口令应可用');

    /* ⑥ 红线（HTTP 上能验到的那条）：不许把自己关在门外，
       停用自己、删除自己、改自己的角色都不行（改自己的口令可以，那是该让人自己做的事） */
    assertEqual((await post('/api/admin/users/disabled', { username: ADMIN_USER, disabled: true })).code, 'E_USER_SELF_LOCKOUT', '不得停用自己');
    assertEqual((await post('/api/admin/users/remove', { username: ADMIN_USER })).code, 'E_USER_SELF_LOCKOUT', '不得删除自己');
    assertEqual((await post('/api/admin/users/role', { username: ADMIN_USER, role: 'viewer' })).code, 'E_USER_SELF_LOCKOUT', '不得改自己的角色');

    const removed = await post('/api/admin/users/remove', { username: tmpUser });
    assertEqual(removed.ok, true, `删除应成功：${removed.code ?? ''} ${removed.message ?? ''}`);
    assert(!(await listUsers()).some((u) => u.username === tmpUser), '删除后清单里不该还有它');
    assertEqual(
      (await callWith('/api/admin/session', '', { username: tmpUser, password: tmpPass2 })).code,
      'E_LOGIN_FAILED',
      '删除后不得登录（且不区分"账号不存在"与"口令错"）',
    );

    /* ⑦ 审计：谁对哪个账号做了什么；口令一个字都不进审计 */
    const audit = (await getAuth('/api/admin/audit')) as unknown as AdminAuditView;
    const accountEntries = (audit.entries ?? []).filter((item) => item.subject === '后台账号');
    assert(accountEntries.length >= 5, `审计里应有账号变更记录，实际 ${accountEntries.length} 条`);
    assert(
      accountEntries.some((item) => item.changes.some((change) => change.field === '角色')),
      `审计要能答出"哪个账号的角色从什么变成什么"，实际：${JSON.stringify(accountEntries.slice(0, 3).map((item) => item.changes))}`,
    );
    assert(
      accountEntries.some((item) => String(item.actor ?? '').includes(ADMIN_USER)),
      '操作者要取自会话（谁做的这件事）',
    );
    const auditText = JSON.stringify(audit.entries ?? []);
    for (const secret of [tmpPass1, tmpPass2, ADMIN_PASSWORD]) {
      assert(!auditText.includes(secret), '审计里不得出现任何口令值（审计会被导出、会被贴进工单）');
    }
  });

  await test('B43 内涵类质控：契约可查、未接入报告、且绝不静默成"0 命中"', async () => {
    /* 这条守的是内涵类质控最容易撒的谎：把"引擎没接上"显示成"查过了没问题"。
       这两件事在数据与界面上都必须分得开，前者要人去配引擎，后者是"确实干净"。 */
    /* ① 契约可查（实现方照着它写） */
    const contract = (await get('/api/qc-content-contract')).data as {
      api?: string;
      constraints?: string[];
      local?: { configured?: boolean; engine?: string; rules?: number };
    };
    assertEqual(contract.api, 'qc.content/1', '契约要报出版本');
    assert(
      (contract.constraints ?? []).some((line) => line.includes('禁用字段')),
      '契约要写清禁用字段（不得产出建议是这一条的落点）',
    );
    assertEqual(contract.local?.configured, false, '本机默认未接入（不写桩）');

    /* ② 跑一次：明确报未接入，而不是"0 命中" */
    const before = await state();
    const run = await post('/api/qc-content-check', {});
    assertEqual(run.ok, true, `跑内涵类质控应返回可解释的结果：${run.code ?? ''} ${run.message ?? ''}`);
    const data = run.data as {
      engine?: { configured?: boolean; name?: string };
      availability?: string | null;
      rules?: number;
      judged?: string[];
      findings?: unknown[];
    };
    assertEqual(data.engine?.configured, false, '引擎未接入要报');
    assert(
      String(data.availability ?? '').includes('未接入'),
      `要说明为什么不可用，实际：${String(data.availability)}`,
    );
    assertEqual(data.rules, 0, '规则清单为空，本程序不发明临床标准（清单由业务方给）');
    assertEqual(data.judged, [], '未接入时没有任何规则被"判过"');

    /* ③ 产出一条注解都不该多：未接入 = 没判定，不是"发现为零" */
    const after = await state();
    assertEqual(after.annotations.length, before.annotations.length, '未接入时不该产生任何质控提示');

    /* ④ 但这件事必须留在界面上：状态里带着"当前不可用 + 原因"，界面才能说清 */
    assertEqual(after.qcContent?.configured, false, '状态里要带"当前不可用"');
    assert(
      String(after.qcContent?.reason ?? '').includes('未接入'),
      `原因要能直接显示给人看，实际：${String(after.qcContent?.reason)}`,
    );

    /* ⑤ 门控日志里也要有一条：只说"跑完了"，会把"根本没判"读成"查过了" */
    assert(
      after.log.some((item) => String(item.action ?? '').includes('内涵类质控')),
      `日志要记这一次的结果，实际最近几条：${JSON.stringify(after.log.slice(0, 3).map((item) => item.action))}`,
    );
  });

  await test('B44 部署参数落库：能在库里查到，且**重置工作区不会顺手清掉它**', async () => {
    /* 这条守的是"部署参数与工作区数据必须分开"的**新载体**：
       它们原先靠"重置时跳过一张文件名白名单"存活；现在它们连文件都没有了 ——
       靠的是"重置只清工作数据"（`clearWorkData` 不碰 `sealed_kv`）。
       白名单会漏（漏一个就是"重置顺手清了配置"，而现场只会看到配置悄悄变了），"不同的表"不会。 */
    await adminLogin();
    const saved = await post('/api/placement-config', { strategy: 'section-title', confidenceCeiling: 0.8 });
    assertEqual(saved.ok, true, `保存落位配置应成功：${saved.code ?? ''} ${saved.message ?? ''}`);
    assertEqual((await state()).placement?.source, 'store', '来源应变成"配置界面"');

    /* 直接查库里的行（**不听服务端自报**） */
    const dbFile = join(stateDir, 'l0.db');
    const opened = openDatabase(dbFile, { schemaVersion: STORAGE_SCHEMA_VERSION, migrations: MIGRATIONS });
    try {
      const row = opened.db.prepare("select payload_sealed from sealed_kv where key = 'config.placement'").get() as
        | { payload_sealed?: string }
        | undefined;
      assert(!!row, '落位配置应落在 sealed_kv 里（键名 config.placement）');
      const blob = String(row?.payload_sealed ?? '');
      assertEqual(blob.includes('section-title'), false, '库里是密封的：明文不该躺着');
      assertEqual(blob.includes('"header"'), true, '存的应当是信封');
    } finally {
      opened.db.close();
    }

    assertEqual((await resetWorkspace()).ok, true, '重置应成功');
    const afterReset = await state();
    assert(afterReset.placement !== null, '重置之后落位配置仍应存在');
    assertEqual(afterReset.placement?.source, 'store', '**重置之后配置仍在** —— 它不是工作区数据');
    assertEqual(
      afterReset.placement?.strategy,
      'section-title',
      '重置不该改动配置内容（原先靠 CONFIG_FILES 白名单，现在靠"不同的表"）',
    );
  });

  await test('B45 语音采集：未配置时明确拒绝；配置后走通"提交 → 文本"，且不落笔、不外泄 ASR 协议', async () => {
    /* 三件事要同时证明：
       ① 未配置端点时**入口不可用且明确报错**（不是 500、不是静默成功，也绝不退回"模拟转写"）；
       ② 配好之后整条链路真的通：同一份音频提交 → 拿回文本（并带上**部署声明**的模型标识）；
       ③ 采集**不落笔**：拿回文本这件事本身不改文档、不产生建议，也不把 ASR 协议泄给前端。 */
    const before = await state();
    assert(!!before.capture, 'state 应下发采集配置视图（界面据此置灰入口并说明原因）');

    /* 未登录改不动：端点决定音频发去哪，属数据流向变更（与落位 external 同类） */
    const spoofed = await postNoAuth('/api/capture-config', { endpoint: CAPTURE_ASR_URL, modelId: CAPTURE_MODEL });
    assertEqual(spoofed.ok, false, '未登录不应改得动采集配置（自报身份不再被采信）');

    /* ① 清空配置 → 入口不可用 */
    const cleared = await post('/api/capture-config', { endpoint: '', modelId: '' });
    assertEqual(cleared.ok, true, `清空采集配置应成功：${cleared.code ?? ''} ${cleared.message ?? ''}`);
    assertEqual((await state()).capture?.configured, false, '清空后应为"未配置"');
    const submitsBefore = fakeAsrState.submits;
    const refused = await postAudio('/api/dictation/capture/segment?sessionId=sess-b45&index=1', 'sess-b45#1.wav', CAPTURE_AUDIO);
    assertEqual(refused.ok, false, '未配置时不得静默成功');
    assertEqual(refused.code, 'E_CAPTURE_NOT_CONFIGURED', '未配置应给出明确错误码（不是 500，也不是一句笼统的失败）');
    assertEqual(fakeAsrState.submits, submitsBefore, '**一个字节都不该发出去**：外部服务不可用时，"看起来还在正常工作"更危险');

    /* 体不是 multipart（例如默认的 JSON）→ 明确拒绝，而不是当成"这段没说话" */
    const badBody = await post('/api/dictation/capture/segment?sessionId=sess-b45&index=1', { audio: 'x' });
    assertEqual(badBody.code, 'E_CAPTURE_UPLOAD_INVALID', '非 multipart 体应被明确拒绝（E_CAPTURE_UPLOAD_INVALID）');
    /* 缺段号：段号是时间区间的锚，服务端不代编 */
    const noIndex = await postAudio('/api/dictation/capture/segment?sessionId=sess-b45', 'sess-b45#1.wav', CAPTURE_AUDIO);
    assertEqual(noIndex.code, 'E_CAPTURE_UPLOAD_INVALID', '缺 index 应被拒绝（不代编一个段号）');

    /* ② 配一台真服务（靶子 ASR）→ 走通 */
    const saved = await post('/api/capture-config', {
      endpoint: CAPTURE_ASR_URL,
      modelId: CAPTURE_MODEL,
      submitTimeoutMs: 5_000,
      pollIntervalMs: 200,
      pollTimeoutMs: 20_000,
      silenceMs: 800,
      maxSeconds: 30,
      minSeconds: 1,
      retainAudio: false,
      apiKey: 'selftest-asr-token',
    });
    assertEqual(saved.ok, true, `保存采集配置应成功：${saved.code ?? ''} ${saved.message ?? ''}`);
    const configuredState = await state();
    assertEqual(configuredState.capture?.configured, true, '配全之后采集入口应可用');
    assertEqual(configuredState.capture?.apiKeyPresent, true, '密钥应报"已就位"');
    assertEqual(
      JSON.stringify(configuredState.capture).includes('selftest-asr-token'),
      false,
      '**密钥值不得出现在任何视图里**（回显一次就收不回来了）',
    );
    assertEqual(configuredState.capture?.source, 'store', '来源应变成"配置界面"');

    const submitted = await postAudio('/api/dictation/capture/segment?sessionId=sess-b45&index=1', 'sess-b45#1.wav', CAPTURE_AUDIO);
    assertEqual(submitted.ok, true, `提交音频应成功：${submitted.code ?? ''} ${submitted.message ?? ''}`);
    const data = submitted.data as { text?: string; modelId?: string; confidenceNote?: string; audioBytes?: number } | undefined;
    assertEqual(data?.text, CAPTURE_TEXT, '应拿回靶子 ASR 识别出的文本');
    assertEqual(data?.modelId, CAPTURE_MODEL, '模型标识应来自**部署声明**（该接口不返回模型信息）');
    assertEqual(data?.confidenceNote, ASR_NO_CONFIDENCE_NOTE, '应标明"ASR 未提供置信度"（界面照抄这句、按上限处理）');
    assertEqual(data?.audioBytes, CAPTURE_AUDIO.byteLength, '转发出去的应当是取出来的那一段音频');
    assertEqual(fakeAsrState.submits, submitsBefore + 1, '靶子 ASR 应真的收到了一次提交');
    assert(
      fakeAsrState.lastBody.includes('name="audio"'),
      `转发必须用 ASR 要的字段名 audio，实际请求体片段：${fakeAsrState.lastBody.slice(0, 160)}`,
    );
    assert(fakeAsrState.polls >= 1, '轮询应在服务端内部完成');
    assertEqual(JSON.stringify(submitted).includes('task_id'), false, '`task_id` 不得回给前端（否则前端会想自己轮询）');

    /* ③ 采集不落笔：不改文档、不产生建议（要产生建议得走 `/api/dictate`） */
    const after = await state();
    assertEqual(after.doc.rev, before.doc.rev, '采集不得改动文档 rev');
    assertEqual(after.suggestions.length, before.suggestions.length, '采集本身不产生建议');

    /* 审计：改端点与"开始一次采集"都要留痕，且都不含音频内容 */
    const audit = (await getAuth('/api/admin/audit')) as AdminAuditView;
    const entries = audit.entries ?? [];
    assert(entries.some((item) => item.subject === '采集配置'), '改采集配置应进管理审计');
    assert(entries.some((item) => item.subject === '语音采集'), '"开了采集"应有一笔（谁、何时、音频发往哪里）');
    assertEqual(JSON.stringify(audit).includes(CAPTURE_TEXT), false, '审计里不得出现识别文本（更不得有音频内容）');
  });

  await test('B46 真实转写 → 建议：采集端给文本与时间区间，服务端只校验不代编；带 confidence 一律拒', async () => {
    /* 这条补上的是"落地使用"里最后一处断链：C2 拿回了文本，但在此之前**没有任何路径**
       能把真实文本变成建议（`/api/dictate` 只认服务端内置的模拟转写 ——
       "能采到文本"与"文本能进病历"是两件事，中间那一跳一直没有）。
       它同时是唯一一处**调用方能把置信度塞进建议**的入口，所以这里逐条挡死。 */
    /* 落位策略固定成 ordered：前面几条用例改过它，不固定的话这条会因为"未落位"而变红，
       那看起来像链路断了，实际只是夹具过期（同 B42 开头复位工作区的理由）。 */
    assertEqual(
      (await post('/api/placement-config', { strategy: 'ordered', confidenceCeiling: 0.85 })).ok,
      true,
      '前置：落位策略固定为 ordered',
    );
    const captured = await postAudio('/api/dictation/capture/segment?sessionId=sess-b46&index=1', 'sess-b46#1.wav', CAPTURE_AUDIO);
    assertEqual(captured.ok, true, `前置：应能从靶子 ASR 采到一段文本：${captured.code ?? ''} ${captured.message ?? ''}`);
    const text = (captured.data as { text?: string } | undefined)?.text ?? '';
    const before = await state();

    const submitted = await post('/api/dictate', {
      transcriptionId: 'sess-b46',
      asrModelId: CAPTURE_MODEL,
      segments: [{ index: 1, text, startSec: 0, endSec: 4.2 }],
    });
    assertEqual(submitted.ok, true, `提交真实转写应成功：${submitted.code ?? ''} ${submitted.message ?? ''}`);
    const data = submitted.data as
      | { source?: string; confidenceCeiling?: number; segments?: Array<{ confidence?: number; startSec?: number }>; groupId?: string | null; submitted?: boolean }
      | undefined;
    assertEqual(data?.source, 'capture', '文本来源应如实标明是真实采集（与内置模拟转写区分开）');
    assertEqual(data?.confidenceCeiling, 0.85, '上限应是两份配置里更小的那个（两个都 <0.90）');
    assertEqual(data?.confidenceCeiling !== undefined && data.confidenceCeiling < 0.9, true, '上限必须低于关键内容阈值');
    assertEqual(data?.segments?.[0]?.confidence, 0.85, '置信度由服务端按上限填：这份 ASR 根本不回置信度');
    assertEqual(data?.segments?.[0]?.startSec, 0, '时间区间原样带出（服务端不代编、不"顺手修正"）');
    assertEqual(data?.submitted, true, 'ordered 策略下应能落位并真的生成建议');

    const after = await state();
    assertEqual(after.doc.rev, before.doc.rev, '生成建议**不落笔**：rev 不应变化');
    assert(
      after.suggestions.length > before.suggestions.length,
      `应多出一条待处理建议，实际 ${before.suggestions.length} → ${after.suggestions.length}`,
    );
    const fresh = (after.suggestions as unknown as Array<{ promptId?: string; mode?: string; status?: string }>).find(
      (item) => String(item.promptId ?? '').includes('sess-b46'),
    );
    assert(!!fresh, '这次提交产生的建议应指向采集会话（promptId 里带会话 ID）');
    assertEqual(fresh?.mode, 'voice', '建议卡应标成语音来源');
    assertEqual(fresh?.status, 'pending', '建议一出现都是待处理（采纳时才逐条过门控）');

    /* 拒绝项：这几处是"能把内容或置信度塞进建议"的全部入口，逐条挡死 */
    const rejects: Array<[string, Record<string, unknown>, string]> = [
      [
        '带 confidence（想让建议直接过关键内容阈值）',
        { transcriptionId: 'sess-b46', asrModelId: CAPTURE_MODEL, segments: [{ index: 1, text, startSec: 0, endSec: 1, confidence: 1 }] },
        'E_CAPTURE_BAD_SEGMENTS',
      ],
      [
        '段号重复',
        {
          transcriptionId: 'sess-b46',
          asrModelId: CAPTURE_MODEL,
          segments: [{ index: 1, text, startSec: 0, endSec: 1 }, { index: 1, text, startSec: 1, endSec: 2 }],
        },
        'E_CAPTURE_BAD_SEGMENTS',
      ],
      [
        '区间倒置',
        { transcriptionId: 'sess-b46', asrModelId: CAPTURE_MODEL, segments: [{ index: 1, text, startSec: 4, endSec: 1 }] },
        'E_CAPTURE_BAD_SEGMENTS',
      ],
      ['空数组（不把"没有产出"当成"没有建议"）', { transcriptionId: 'sess-b46', asrModelId: CAPTURE_MODEL, segments: [] }, 'E_CAPTURE_BAD_SEGMENTS'],
      [
        '缺 asrModelId',
        { transcriptionId: 'sess-b46', segments: [{ index: 1, text, startSec: 0, endSec: 1 }] },
        'E_AI_NO_PROVENANCE',
      ],
      [
        '缺 transcriptionId',
        { asrModelId: CAPTURE_MODEL, segments: [{ index: 1, text, startSec: 0, endSec: 1 }] },
        'E_AI_NO_PROVENANCE',
      ],
    ];
    for (const [name, payload, expected] of rejects) {
      const r = await post('/api/dictate', payload);
      assertEqual(r.code, expected, `${name} 应报 ${expected}`);
    }
    assertEqual((await state()).doc.rev, after.doc.rev, '被拒的提交更不该留下任何痕迹');

    /* 模拟路径不能被顺手弄丢：它是离线演示与回归的唯一入口 */
    const demo = await post('/api/dictate', {});
    assertEqual(demo.ok, true, '不带 segments 时应仍走内置模拟转写（演示路径）');
    assertEqual((demo.data as { source?: string } | undefined)?.source, 'demo', '模拟转写必须如实标成 demo');
  });

  await test('B47 演示采集：脚本音频走完"采集 → 分片 → 逐段转发 → 建议"，不落笔且如实标注来源', async () => {
    /* 这条是"整条链真的能跑"的机器证明：C1/C2/C3a 三层此前只在离线用例里各自被验过，
       而这里让它们**在真实 HTTP + 真实时间**里连起来走一遍（约 3 秒，逐帧真的在走）。
       两条最要紧的断言：① 建议里的文本来自靶子 ASR（证明音频真的走完了转发）；
       ② 采集源标识如实下发（`sample` = 脚本音频，不是麦克风）。 */
    assertEqual(
      (await post('/api/placement-config', { strategy: 'ordered', confidenceCeiling: 0.85 })).ok,
      true,
      '前置：落位策略固定为 ordered',
    );
    /* ① 未配置 ASR 时：**一个字节都不该发出去**，也不静默退回模拟转写 */
    assertEqual((await post('/api/capture-config', { endpoint: '', modelId: '' })).ok, true, '前置：清空采集配置');
    const submitsBefore = fakeAsrState.submits;
    const refused = await post('/api/dictation/capture/demo-run', {});
    assertEqual(refused.code, 'E_CAPTURE_NOT_CONFIGURED', '未配置时演示采集也必须明确拒绝');
    assertEqual(fakeAsrState.submits, submitsBefore, '未配置时不该有请求打到 ASR');

    /* ② 配上靶子 ASR，走一遍完整链路 */
    assertEqual(
      (await post('/api/capture-config', {
        endpoint: CAPTURE_ASR_URL,
        modelId: CAPTURE_MODEL,
        submitTimeoutMs: 5_000,
        pollIntervalMs: 200,
        pollTimeoutMs: 20_000,
        silenceMs: 800,
        maxSeconds: 30,
        minSeconds: 1,
        retainAudio: false,
      })).ok,
      true,
      '前置：配置靶子 ASR',
    );
    const before = await state();
    const run = await post('/api/dictation/capture/demo-run', {
      /* 脚本：1s 人声 + 1s 静音 + 1s 人声 → `silenceMs` 800 会把它切成 2 段。
         刻意用短脚本：这条用例是**按真实时间**跑的（每帧 0.5s）。 */
      timeline: [
        { seconds: 1, voiced: true },
        { seconds: 1, voiced: false },
        { seconds: 1, voiced: true },
      ],
    });
    assertEqual(run.ok, true, `演示采集应成功：${run.code ?? ''} ${run.message ?? ''}`);
    const data = run.data as
      | {
          outcome?: {
            chunks: Array<{ index: number; text: string; startSec: number; endSec: number }>;
            failures: unknown[];
            submit?: { ok?: boolean; unplaced?: number; groupId?: string | null; message?: string };
          };
          segments?: Array<{ index: number; text: string }>;
          submitted?: boolean;
          groupId?: string | null;
          confidenceCeiling?: number;
        }
      | undefined;
    const outcome = data?.outcome;
    assertEqual(outcome?.chunks.length, 2, `两段人声被静音切开 → 2 段；实际 ${JSON.stringify(data?.outcome)}`);
    assertEqual(outcome?.chunks.map((chunk) => [chunk.startSec, chunk.endSec]), [[0, 2], [2, 3]], '时间区间由脚本与分片规则定死（可预期）');
    assertEqual(outcome?.failures.length, 0, '靶子 ASR 不会失败');
    assertEqual(
      outcome?.chunks.every((chunk) => chunk.text === CAPTURE_TEXT),
      true,
      '段文本应来自靶子 ASR —— 这一条才证明音频真的走完了"分片 → 转发"',
    );
    assertEqual(outcome?.submit?.ok, true, '采完应自动提交成建议');
    assertEqual(outcome?.submit?.unplaced, 0, 'ordered 策略下两段都该落位（否则内核不接受"半落位"）');
    assertEqual(typeof outcome?.submit?.groupId, 'string', '应生成一组建议（groupId 是界面"整组操作"的依据）');
    assertEqual(fakeAsrState.submits >= submitsBefore + 1, true, '靶子 ASR 应真的收到了提交');

    const after = await state();
    assertEqual(after.doc.rev, before.doc.rev, '采集**不落笔**：rev 不应变化');
    assert(
      after.suggestions.length > before.suggestions.length,
      `应出现新的待处理建议，实际 ${before.suggestions.length} → ${after.suggestions.length}`,
    );
    const runRecord = (after as unknown as { captureRun?: { phase?: string; sourceId?: string; finalized?: number; transcribed?: number; outcome?: { chunks: unknown[] } } }).captureRun;
    assertEqual(runRecord?.phase, 'done', '过程记录应停在"已完成"');
    assertEqual(runRecord?.sourceId, 'sample', '**采集源标识必须如实下发**：sample = 脚本音频（不是麦克风）');
    assertEqual(runRecord?.finalized, 2, '已定稿段数应如实记录（界面据此显示"已定稿 N 段"）');
    assertEqual(runRecord?.transcribed, 2, '已转写段数应如实记录');

    const dictation = (after as unknown as { dictation?: { source?: string; segments?: Array<{ text: string; confidence: number }> } }).dictation;
    assertEqual(dictation?.source, 'capture', '文本来源应标成真实采集（不是内置模拟转写）');
    assertEqual(dictation?.segments?.length, 2, '两段有效文本都应进建议（最后一段由"停止"定稿，同样要有人转）');
    assertEqual(dictation?.segments?.[0]?.confidence, 0.85, '置信度由服务端按上限填（客户端不塞）');

    /* ③ 没有正在进行的采集时，"停止"要明确回答，而不是静默成功 */
    const stop = await post('/api/dictation/capture/demo-stop', {});
    assertEqual(stop.code, 'E_NO_CAPTURE_RUN', '没有正在跑的采集时，停止应明确报"没有正在进行的采集"');
  });

  await test('B48 医生按停：当前那一段立刻定稿（已经说出口的话不丢），已完成的段不受影响', async () => {
    /* 设计第四节的"手动停止"：医生按停 = **立即定稿当前分片**。
       这一条要证明的是"按停不是丢弃"：段被人为截断，但它照样被转写、照样进建议。 */
    assertEqual(
      (await post('/api/placement-config', { strategy: 'ordered', confidenceCeiling: 0.85 })).ok,
      true,
      '前置：落位策略固定为 ordered',
    );
    const before = await state();
    /* 一段 6s 人声：不停的话要 6s 才走完；这里约 1.8s 后按停 */
    const pending = post('/api/dictation/capture/demo-run', { timeline: [{ seconds: 6, voiced: true }] });
    await new Promise((resolve) => setTimeout(resolve, 1800));
    const stopped = await post('/api/dictation/capture/demo-stop', {});
    assertEqual(stopped.ok, true, `按停应成功：${stopped.code ?? ''} ${stopped.message ?? ''}`);
    const run = await pending;
    assertEqual(run.ok, true, '按停后整次采集应正常收尾（按停不是失败）');
    const outcome = (run.data as { outcome?: { chunks: Array<{ index: number; startSec: number; endSec: number }>; failures: unknown[] } } | undefined)?.outcome;
    assertEqual(outcome?.chunks.length, 1, '按停时应把当前那一段定稿并转写（不丢掉医生已经说出口的话）');
    assertEqual(outcome?.failures.length, 0, '按停不该产生失败段');
    const endSec = outcome?.chunks[0]?.endSec ?? 99;
    assert(endSec < 6, `按停应切在 6s 之前，实际 ${endSec}s`);
    assert(endSec - (outcome?.chunks[0]?.startSec ?? 0) >= 1, '被按停的那一段仍是正长度且不低于 minSeconds（否则会被当成误触丢掉）');
    const after = await state();
    assertEqual(after.doc.rev, before.doc.rev, '按停同样不落笔（内容仍走建议通道）');
    assertEqual(
      (after as unknown as { captureRun?: { phase?: string } }).captureRun?.phase,
      'done',
      '按停之后过程记录应停在"已完成"，而不是一直显示"正在采集"',
    );
  });

  await test('B49 本地客户端桥：页面"取段 → 取音频 → ack"的交接契约（含令牌与乱序拒绝）', async () => {
    /* C3b③ 的形态是"麦克风由本机客户端采、页面只做转交与上传"。这条用例把**桥这一侧**
       真的跑一遍（起一个客户端进程）：页面拿到的段必须是客户端给的段号与时间区间，
       而且**只有 ack 才推进队列** —— 否则页面一次抖动就会让一句"我说了但没进病历"。
       真实采集（麦克风）属宿主形态（K10），这里用的是客户端内置的脚本音频源。 */
    const spawned = spawn(process.execPath, ['src/dictation/local-capture-client.ts', '--port', String(CAPTURE_CLIENT_PORT), '--token', CAPTURE_CLIENT_TOKEN], {
      cwd: ROOT,
      stdio: 'pipe',
      env: { ...process.env },
    });
    captureClient = spawned;
    spawned.stdout?.on('data', () => {});
    spawned.stderr?.on('data', () => {});

    const ready = await (async (): Promise<boolean> => {
      for (let i = 0; i < 40; i += 1) {
        try {
          const hello = await bridgeCall('/dictation-capture/hello');
          if (hello.status === 200 && hello.json.ok === true) return true;
        } catch {
          /* 还没起来 */
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return false;
    })();
    assert(ready, '本地采集客户端应在数秒内就绪（它只绑 127.0.0.1）');
    const hello = await bridgeCall('/dictation-capture/hello');
    assertEqual(hello.json.client, 'l0-dictation-client', 'hello 要说清"我是谁"');
    assert(
      String(hello.json.source ?? '').includes('脚本音频'),
      `必须如实标明用的是脚本音频（不是麦克风），实际：${String(hello.json.source)}`,
    );

    /* ① 令牌：没带 → 401（页面据此分辨"客户端不在"与"令牌不对"）；带错 → 401 */
    const noToken = await bridgeCall('/dictation-capture/hello', { token: '' });
    assertEqual(noToken.status, 401, '没带令牌应回 401');
    const badToken = await bridgeCall('/dictation-capture/hello', { token: 'wrong-token' });
    assertEqual(badToken.status, 401, '令牌不对应回 401');
    assertEqual(badToken.json.code, 'E_BRIDGE_BAD_TOKEN', '要有专门错误码');

    /* ② 还没开始就取段：明确报"没开始"，不是"没有段" */
    const beforeStart = await bridgeCall('/dictation-capture/next');
    assertEqual(beforeStart.json.code, 'E_BRIDGE_NOT_STARTED', '未开始时 next 应明确报错');

    /* ③ 分片参数由页面转交：非法值一律拒（同一份校验，不取默认） */
    const badParams = await bridgeCall('/dictation-capture/start', { method: 'POST', body: { silenceMs: 5000, maxSeconds: 5, minSeconds: 6 } });
    assertEqual(badParams.json.code, 'E_CAPTURE_CONFIG_INVALID', '非法分片参数应被拒（与配置层同一份校验）');

    /* ④ 正常一轮：取段 → 取音频 → ack → … → done */
    const started = await bridgeCall('/dictation-capture/start', { method: 'POST', body: { silenceMs: 800, maxSeconds: 30, minSeconds: 1 } });
    assertEqual(started.json.ok, true, `开始采集应成功：${String(started.json.message ?? '')}`);
    const again = await bridgeCall('/dictation-capture/start', { method: 'POST', body: { silenceMs: 800, maxSeconds: 30, minSeconds: 1 } });
    assertEqual(again.json.code, 'E_BRIDGE_ALREADY_RUNNING', '正在采集时再开始应被拒（不重复打开设备）');

    const seen: Array<{ index: number; startSec: number; endSec: number }> = [];
    let done: Record<string, unknown> | null = null;
    for (let i = 0; i < 40 && done === null; i += 1) {
      const next = await bridgeCall('/dictation-capture/next');
      const payload = next.json.next as
        | { kind: string; segment?: { index: number; startSec: number; endSec: number }; total?: number; delivered?: number; failures?: unknown[]; shortDropped?: number }
        | undefined;
      if (payload?.kind === 'segment' && payload.segment) {
        const meta = payload.segment;
        seen.push(meta);
        /* 音频：**元数据与二进制分开**（省掉 base64 那一趟编解码），且必须是 16k/单声道/16-bit */
        const audio = await bridgeAudio(meta.index);
        assertEqual(audio.status, 200, `第 ${meta.index} 段的音频应可取`);
        const parsed = parseCaptureWav(audio.bytes);
        assertEqual([parsed.sampleRate, parsed.channels, parsed.bitsPerSample], [16_000, 1, 16], '桥给的音频必须是 16k/单声道/16-bit');
        /* 页面在这一步会把它 POST 给同源采集路由（那条链由 B45 守着），这里只确认 ack 语义 */
        const acked = await bridgeCall('/dictation-capture/ack', { method: 'POST', body: { index: meta.index, ok: true } });
        assertEqual(acked.json.ok, true, `第 ${meta.index} 段应能确认`);
        assertEqual((await bridgeAudio(meta.index)).status, 404, 'ack 之后音频应释放（否则一次门诊录音会在内存里堆几十 MB）');
        continue;
      }
      if (payload?.kind === 'done') done = payload as Record<string, unknown>;
      else await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert(done !== null, '采集走完后 next 应回 done');
    assertEqual(seen.length, 2, `默认脚本（2s 人声 / 1.2s 静音 / 2s 人声）应切成 2 段，实际 ${JSON.stringify(seen)}`);
    assertEqual(seen.map((item) => [item.startSec, item.endSec]), [[0, 3.2], [3.2, 5.2]], '段号与时间区间由客户端给出（页面不得代编）');
    assertEqual(done?.delivered, 2, 'done 应如实回报已交付段数');
    assertEqual(done?.shortDropped, 0, '没有过短的片');
    assertEqual(done?.failures, [], '本次没有失败段');

    /* ⑤ 医生按停：当前那一段立刻定稿（已说出口的话不丢）—— 这是页面上「停止采集」走的路径 */
    const started2 = await bridgeCall('/dictation-capture/start', { method: 'POST', body: { silenceMs: 800, maxSeconds: 30, minSeconds: 1 } });
    assertEqual(started2.json.ok, true, '第二轮应能开始');
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const stopped = await bridgeCall('/dictation-capture/stop', { method: 'POST', body: {} });
    assertEqual(stopped.json.ok, true, '按停应成功');
    let stoppedChunks = 0;
    let stoppedDone = false;
    for (let i = 0; i < 30 && !stoppedDone; i += 1) {
      const next = await bridgeCall('/dictation-capture/next');
      const payload = next.json.next as { kind: string; segment?: { index: number } } | undefined;
      if (payload?.kind === 'segment' && payload.segment) {
        stoppedChunks += 1;
        await bridgeCall('/dictation-capture/ack', { method: 'POST', body: { index: payload.segment.index, ok: true } });
        continue;
      }
      if (payload?.kind === 'done') stoppedDone = true;
      else await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert(stoppedDone, '按停后整次交接应能收尾');
    assertEqual(stoppedChunks, 1, '按停时应把当前那一段定稿（不丢掉医生已经说出口的话）');

    /* ⑥ 乱序 ack：拒绝，且不从队列里"顺手删一个" */
    const started3 = await bridgeCall('/dictation-capture/start', { method: 'POST', body: { silenceMs: 800, maxSeconds: 30, minSeconds: 1 } });
    assertEqual(started3.json.ok, true, '第三轮应能开始');
    await new Promise((resolve) => setTimeout(resolve, 3600));
    const wrongAck = await bridgeCall('/dictation-capture/ack', { method: 'POST', body: { index: 99, ok: true } });
    assertEqual(wrongAck.json.code, 'E_BRIDGE_ACK_OUT_OF_ORDER', '乱序/陌生的段号应被拒（顺手删一个的现场表现是"某一句不见了"）');
    await bridgeCall('/dictation-capture/stop', { method: 'POST', body: {} });
  });

  await test('B50 模板库：名称与适用科室可改，改的是"换一版内容"（内容指纹变、审计留痕、开关与骨架不被动）', async () => {
    /* 这条要钉住三件事，缺一件这条编辑口子就会变成隐患：
       ① 改的是**包内容**（内容指纹必变、前后指纹进审计），不是"改个显示标签"；
       ② 只开放名称与适用科室 —— 章节 / 槽位 / 引用哪个控件是骨架，动不得；
       ③ 已停用的文书不会因改个名字被顺手打开（否则"停用"就不是停用了）。 */
    await adminLogin();

    /* 科室字典先保底建好：下面要配"限某个科"，而科室**只能从字典里选**
       （编码打错一个字母，这份文书就谁都开不出）。字典本身的完整验证在 B52。 */
    const seededDepts = await post('/api/departments', {
      items: [
        { code: 'DEPT_RESP', name: '呼吸内科', enabled: true },
        { code: 'DEPT_CARD', name: '心血管内科', enabled: true },
        { code: 'DEPT_GI', name: '消化内科', enabled: true },
        { code: 'DEPT_OB', name: '产科', enabled: true },
      ],
    });
    assertEqual(seededDepts.ok, true, `科室字典应能建立：${seededDepts.code ?? ''} ${seededDepts.message ?? ''}`);

    const id = 'tpl.obstetric.outpatient';
    const before = await state();
    const template = (before.templateCatalog ?? []).find((item) => item.itemId === id);
    assert(!!template, '模板库应逐份列出文书（含停用项）');
    const packId = String(template?.packId ?? '');
    const originalName = String(template?.name ?? '');
    const contentBefore = before.knowledgePacks.contentFingerprint;
    const sectionsBefore = JSON.stringify(template?.sections ?? []);
    assert((template?.sections ?? []).length > 0, '目录要带出章节与槽位（否则这一页只剩一个名字）');
    assert((template?.controls ?? []).length > 0, '目录要带出它引用了哪些医学表达式控件');

    /* ① 未登录改不动（部署参数，与开关包同一道门） */
    const unauth = await postNoAuth('/api/template-item-update', { packId, itemId: id, name: '随便改' });
    assertEqual(unauth.ok, false, '未登录不得改模板');

    /* 科室编码必须在字典里（见 B52 建立的那份）：一个对不上任何人的编码，
       后果是这份文书**谁都开不出**，所以保存时就拦，而不是等医生开的时候才发现 */
    const badDept = await post('/api/template-item-update', { packId, itemId: id, departments: ['DEPT_NOT_EXIST'] });
    assertEqual(badDept.ok, false, '字典里没有的科室编码应被拒');
    assertEqual(String(badDept.code ?? ''), 'E_TPL_DEPT_UNKNOWN', '错误码要能定位到"科室对不上"');

    /* ② 先停用，再改名 —— 这两件事互相独立，顺序反过来就验不出"顺手打开" */
    const off = await post('/api/knowledge-pack-toggle', { packId, itemId: id, enabled: false });
    assertEqual(off.ok, true, '停用应成功');

    const renamed = await post('/api/template-item-update', { packId, itemId: id, name: '产科门诊病历（2026 版）', departments: 'DEPT_OB、DEPT_GI' });
    assertEqual(renamed.ok, true, `改名应成功：${renamed.code ?? ''} ${renamed.message ?? ''}`);
    const afterState = await state();
    const after = (afterState.templateCatalog ?? []).find((item) => item.itemId === id);
    assertEqual(after?.name, '产科门诊病历（2026 版）', '目录里的名称应是改后的');
    assertEqual(JSON.stringify(after?.departments ?? []), JSON.stringify(['DEPT_OB', 'DEPT_GI']), '科室按分隔符切成两条（切分规则只该有一处：服务端）');
    /* 列表显示**名称**（服务端按字典翻译好下发）：编码是给判定用的，
       摆进列表只会让人去猜 DEPT_OB 是哪个科 */
    assertEqual(JSON.stringify(after?.departmentNames ?? []), JSON.stringify(['产科', '消化内科']), '科室显示的是字典里的名称，不是编码');
    assert(afterState.knowledgePacks.contentFingerprint !== contentBefore, '改的是包内容：内容指纹必须变（否则"换了一版"没人看得出来）');
    assertEqual(after?.enabled, false, '停用的文书不会因为改了个名字被顺手打开');
    assertEqual(JSON.stringify(after?.sections ?? []), sectionsBefore, '章节与槽位一个字都不动（骨架不在这条编辑口子里）');
    assertEqual((afterState.templates ?? []).some((item) => item.templateId === id), false, '仍停用：医生端开不出它');

    /* ③ 审计要答得出"换了哪一版"（内容包 + 前后指纹），而不只是一句"改过模板" */
    const audit = (await getAuth('/api/admin/audit')) as unknown as AdminAuditView;
    const contentEntries = (audit.entries ?? []).filter(
      (item) => item.subject === '内容包' && String(item.note ?? '').includes(id),
    );
    assert(contentEntries.length >= 1, `审计里应有这次改名的记录，实际 ${contentEntries.length} 条`);
    assert((contentEntries[0]?.changes ?? []).some((change) => change.field === '包指纹'), '内容前后指纹要进审计');

    /* ④ 复原：名称改回、科室留空（= 不限）、重新启用 */
    const restored = await post('/api/template-item-update', { packId, itemId: id, name: originalName, departments: '' });
    assertEqual(restored.ok, true, '复原应成功');
    await post('/api/knowledge-pack-toggle', { packId, itemId: id, enabled: true });
    const finalState = await state();
    const finalItem = (finalState.templateCatalog ?? []).find((item) => item.itemId === id);
    assertEqual(finalItem?.name, originalName, '名称应复原');
    assertEqual(JSON.stringify(finalItem?.departments ?? []), JSON.stringify([]), '留空 = 不限科室');
    assertEqual((finalState.templates ?? []).some((item) => item.templateId === id), true, '启用后医生端又能开它');
    assertEqual(finalState.knowledgePacks.contentFingerprint, contentBefore, '改回原样应回到原内容指纹（可复现）');

    /* ⑤ 边界：控件条目不许走这条路；名称不能为空 */
    const onControl = await post('/api/template-item-update', { packId, itemId: 'expr.bmi', name: '改个名' });
    assertEqual(onControl.ok, false, '医学表达式控件不在这条编辑口子里（它的名字与公式就是它本身）');
    assertEqual(String(onControl.code ?? ''), 'E_TPL_ITEM_NOT_TEMPLATE', '错误码要说清是哪一类问题');
    const emptyName = await post('/api/template-item-update', { packId, itemId: id, name: '   ' });
    assertEqual(emptyName.ok, false, '名称不能为空（它是「新建」里的那一行）');
  });

  await test('B51 模板库：新建的文书是**草稿**（医生端开不出），改完骨架发布才能开，删除不动病历', async () => {
    /* 这条钉住"草稿"不是个标签：
       ① 新建出来开不出（否则医生会照着残缺骨架开病历）；
       ② 草稿能改骨架、已发布的改不了（改不了的理由是它可能已经开出过病历）；
       ③ 发布后进入"能开";④ 删除不动任何病历。 */
    await adminLogin();
    const before = await state();
    const revBefore = before.doc.rev;

    /* ① 新建 → 草稿 */
    const created = await post('/api/template-item-create', {
      name: '自测临时文书',
      docType: { system: 'local', code: 'selftest', display: '自测临时文书' },
      departments: 'DEPT_OB',
    });
    assertEqual(created.ok, true, `新建应成功：${created.code ?? ''} ${created.message ?? ''}`);
    const itemId = String(created.data?.itemId ?? '');
    const packId = String(created.data?.packId ?? '');
    assertEqual(created.data?.status, 'draft', '新建出来必须是草稿');
    const afterCreate = await state();
    const inCatalog = (afterCreate.templateCatalog ?? []).find((item) => item.itemId === itemId);
    assertEqual(inCatalog?.status, 'draft', '目录里标着草稿');
    assertEqual(JSON.stringify(inCatalog?.departments ?? []), JSON.stringify(['DEPT_OB']), '适用科室存下来了（存的是编码）');
    assertEqual(JSON.stringify(inCatalog?.departmentNames ?? []), JSON.stringify(['产科']), '显示名由字典翻译（界面上看到的是"产科"，不是 DEPT_OB）');
    assertEqual((inCatalog?.sections ?? []).length > 0, true, '新建也给了一份能过校验的最小骨架');
    assertEqual((afterCreate.templates ?? []).some((item) => item.templateId === itemId), false, '**草稿：医生端开不出它**');
    assertEqual(afterCreate.doc.rev, revBefore, '新建文书不动任何病历');

    /* ② 草稿能改骨架；改坏了要当场被拒 */
    const edited = await post('/api/template-item-update', {
      packId,
      itemId,
      sections: [{ sectionCode: 'cc', title: '主诉', slots: [{ slot: 'field', key: 'cc', dataType: 'text' }] }],
    });
    assertEqual(edited.ok, true, `草稿应能改章节与槽位：${edited.code ?? ''} ${edited.message ?? ''}`);
    const afterEdit = await state();
    const editedItem = (afterEdit.templateCatalog ?? []).find((item) => item.itemId === itemId);
    assertEqual(editedItem?.sections?.[0]?.title, '主诉', '骨架变成了刚提交的那一版');
    assertEqual(editedItem?.sections?.[0]?.slots?.[0]?.key, 'cc', '槽位也存下来了');
    const bad = await post('/api/template-item-update', {
      packId,
      itemId,
      sections: [{ sectionCode: 'cc', title: '主诉', slots: [{ slot: 'text', key: 'cc', text: '' }, { slot: 'text', key: 'cc', text: '' }] }],
    });
    assertEqual(bad.ok, false, '槽位重名要被拒（表达式按 key 引用填写项，重名会指到别人身上）');

    /* ③ 发布之后**还要过科室这一关**：发布只是"定稿了"，不是"谁都能开"。
       这份限产科，而当前就诊是呼吸内科 —— 所以它仍然不在「新建」名单里。 */
    const published = await post('/api/template-item-update', { packId, itemId, status: 'active' });
    assertEqual(published.ok, true, '发布应成功');
    const afterPublish = await state();
    assertEqual(
      (afterPublish.templates ?? []).some((item) => item.templateId === itemId),
      false,
      '限产科的文书在呼吸内科的就诊下开不出（发布 ≠ 谁都能开）',
    );
    /* 改成通用（不配科室）之后它才真的进入名单 —— 科室随时可改，它不进任何已开出的病历 */
    const generic = await post('/api/template-item-update', { packId, itemId, departments: [] });
    assertEqual(generic.ok, true, '已发布的文书可以改科室');
    const afterGeneric = await state();
    assertEqual((afterGeneric.templates ?? []).some((item) => item.templateId === itemId), true, '改成通用后医生端能开它');
    const blocked = await post('/api/template-item-update', {
      packId,
      itemId,
      sections: [{ sectionCode: 'x', title: 'X', slots: [{ slot: 'text', key: 'x', text: '' }] }],
    });
    assertEqual(blocked.ok, false, '已发布的文书改不了骨架');
    assertEqual(String(blocked.code ?? ''), 'E_TPL_STATUS_PUBLISHED', '错误码要说得清是哪一类问题（可能已经开出过病历）');

    /* ③b **槽位元数据是例外**：显示名 / 从系统带入 / 必填 / 单位，以及关键内容 / 默认值 /
       参考范围 / 另起一段 —— 这一族都在开文书那一刻才起作用，不进任何已开出的病历。
       而"体温这一格到底叫什么、从哪儿带、多少算正常"恰恰是上线后最常要调的东西：
       逼人为此撤稿（医生端立刻开不出这份文书），是拿一个不存在的风险换一个真实的代价。 */
    const meta = await post('/api/template-item-update', {
      packId,
      itemId,
      slotMeta: [{
        sectionCode: 'cc',
        key: 'cc',
        display: '体温',
        from: 'patient.nameMasked',
        required: true,
        unit: '℃',
        keyContent: true,
        value: '正常',
        referenceRange: { text: '阴性' },
        newParagraph: true,
      }],
    });
    assertEqual(meta.ok, true, `已发布的文书应能改槽位元数据：${meta.code ?? ''} ${meta.message ?? ''}`);
    const afterMeta = await state();
    const metaSlot = (((afterMeta.templateCatalog ?? []).find((item) => item.itemId === itemId)
      ?.sections?.[0]?.slots ?? [])[0] ?? {}) as {
      tags?: Array<{ system: string; code: string; display?: string }>;
      from?: string;
      unit?: string;
      required?: boolean;
      keyContent?: boolean;
      value?: unknown;
      referenceRange?: { text?: string };
      newParagraph?: boolean;
    };
    assertEqual(metaSlot.tags?.[0]?.display, '体温', '显示名落在数据元标签上（医生端就按它显示字段名）');
    assertEqual(metaSlot.tags?.[0]?.system, 'local', '原来没绑数据元的槽位按本机构自定义（local）记一条');
    assertEqual(metaSlot.tags?.[0]?.code, 'cc', '编码用槽位名：跨文书比对认的是 system + code，不能只剩一个中文名');
    /* 目录要把**编辑抽屉要回显的字段**一起带出来（单位 / 从系统带入 / 必填 / 数据类型）：
       少给一个，界面就显示成空的，而人一保存就把库里那份覆盖没了 —— 没有任何地方会报错 */
    assertEqual(metaSlot.from, 'patient.nameMasked', '"从系统带入"要能回显，否则界面显示成空的、一保存就覆盖没了');
    assertEqual(metaSlot.unit, '℃', '单位同样要能回显（同一条理由）');
    assertEqual(metaSlot.required, true, '必填也要能回显');
    /* 关键内容 / 默认值 / 参考范围 / 另起一段走的是**同一条回显纪律**：
       目录少给一项，编辑框里就是空的，而人一保存就把库里那份覆盖没了 —— 全程不报错 */
    assertEqual(metaSlot.keyContent, true, '关键内容要能回显（"未人工确认就签不出去"那道门控按它判）');
    assertEqual(metaSlot.value, '正常', '默认值要能回显（它是模板预设的机器真值，不是展示文本）');
    assertEqual(metaSlot.referenceRange?.text, '阴性', '参考范围要能回显（趋势按它标偏高 / 偏低；判不了数的用 text）');
    assertEqual(metaSlot.newParagraph, true, '「强制另起一段」也要能回显');

    /* ③c 预览与正文**同源**：`/api/template-preview` 返回的 `items` 就是医生端 `/api/state`
       的那份视图（服务端同一个组装函数），前端两页也由同一个渲染函数画（`/doc-view.js`）——
       "所见即所得"靠的是这条链路，而不是两处照着对方调。
       这里钉住服务端这一半：形状必须与 `/api/state` 的 items 一致 —— 少一样就是
       "医生端画得出来、预览画不出来"（或反过来），而两边都看起来对。 */
    const preview = await post('/api/template-preview', { templateId: itemId });
    assertEqual(preview.ok, true, `预览应成功：${preview.code ?? ''} ${preview.message ?? ''}`);
    const previewData = (preview.data ?? {}) as { items?: Array<Record<string, unknown>> };
    const previewItems = previewData.items ?? [];
    assert(previewItems.length > 0, '预览要返回正文视图（items），否则界面画不出"医生点开之后那一屏"');
    const previewField = previewItems.find((item) => item.kind === 'field') ?? {};
    assert(Object.keys(previewField).length > 0, '预览的正文视图里应有字段节点');
    for (const key of ['id', 'label', 'value', 'origin', 'humanConfirmed', 'rev']) {
      assert(key in previewField, `预览的字段视图应带 ${key}（与 /api/state 的 items 同形）`);
    }
    assertEqual(previewField.label, '体温', '字段名来自数据元标签：预览与医生端读的是同一个名字');
    /* 默认值要真的**落进那一格**：只写进包、开文书时不用它，等于界面配了个寂寞 */
    assertEqual(previewField.value, '正常', '模板预设的默认值要落进正文视图（这一格不再是空待填）');
    /* 连 `rev` 这种"只读态渲染才会用到"的字段也要在：形状缺一块，渲染里那条分支在预览里就走不到 */
    assert(typeof previewField.rev === 'number', '预览的节点也要带 rev（只读态渲染要用它）');

    /* ④ 删除：库里没有它，病历一个字不动 */
    const deleted = await post('/api/template-item-delete', { packId, itemId });
    assertEqual(deleted.ok, true, `删除应成功：${deleted.code ?? ''} ${deleted.message ?? ''}`);
    const afterDelete = await state();
    assertEqual((afterDelete.templateCatalog ?? []).some((item) => item.itemId === itemId), false, '删完模板库里没有它');
    assertEqual((afterDelete.templates ?? []).some((item) => item.templateId === itemId), false, '医生端也没有它');
    assertEqual(afterDelete.doc.rev, revBefore, '整个过程病历一个字都没动');

    /* ⑤ 未登录建不了 / 删不了 */
    assertEqual((await postNoAuth('/api/template-item-create', { name: 'x', docType: { system: 'local', code: 'x', display: 'X' } })).ok, false, '未登录建不了文书');
    assertEqual((await postNoAuth('/api/template-item-delete', { packId, itemId })).ok, false, '未登录删不了文书');
  });

  await test('B51b 列表槽位：模板能配列表，开出来的病历里每项带编号、可编辑、且不重复出现', async () => {
    /* 把"列表"从纸面（C9）接到屏幕上：模板 → 实例化 → `/api/state` 的 items。钉三件事：
         ① 一项列表是**一条**视图项（带 `marker`），不是"组 + 一堆散落的 text"；
         ② 编号由服务端算：有序 `1.` / `2.`、无序圆点（前端按顺序自己数，删一项之后就会与纸面分叉）；
         ③ 列表项里的 text **不再**作为独立文本项出现（否则同一句话在屏幕上出现两遍）。 */
    await adminLogin();
    const created = await post('/api/template-item-create', {
      name: '自测列表文书',
      docType: { system: 'local', code: 'listtest', display: '自测列表文书' },
      departments: [],
    });
    assertEqual(created.ok, true, `新建应成功：${created.code ?? ''} ${created.message ?? ''}`);
    const itemId = String(created.data?.itemId ?? '');
    const packId = String(created.data?.packId ?? '');

    const edited = await post('/api/template-item-update', {
      packId,
      itemId,
      sections: [{
        sectionCode: 'hpi',
        title: '现病史',
        slots: [
          {
            slot: 'list',
            key: 'allergy',
            ordered: true,
            items: [{ text: '否认药物过敏史' }, { text: '否认食物过敏史' }],
          },
          {
            slot: 'list',
            key: 'habits',
            items: [
              {
                text: '吸烟量',
                field: {
                  dataType: 'number',
                  unit: '支/日',
                  tags: [{ system: 'local', code: 'habits.smoke', display: '吸烟量' }],
                },
              },
              { text: '偶饮酒' },
            ],
          },
        ],
      }],
    });
    assertEqual(edited.ok, true, `列表骨架应能存进草稿：${edited.code ?? ''} ${edited.message ?? ''}`);

    /* 目录：编辑抽屉靠它回显（项 / 有序性 / 一行人话），少一样就是"一保存就清掉" */
    const catalogSlot = ((await state()).templateCatalog ?? [])
      .find((item) => item.itemId === itemId)?.sections?.[0]?.slots?.[0] as
      { kind?: string; items?: Array<{ text?: string }>; ordered?: boolean; detail?: string } | undefined;
    assertEqual(catalogSlot?.kind, 'list', '目录要认列表这一类（不认识时那一格在界面上是空白）');
    assertEqual(
      (catalogSlot?.items ?? []).map((item) => item.text).join('|'),
      '否认药物过敏史|否认食物过敏史',
      '项要原样带出',
    );
    assertEqual(catalogSlot?.ordered, true, '有序性要带出（抽屉勾选框要回显）');
    assertEqual(catalogSlot?.detail, '列表：2 项（编号）', '一行人话要说清几项、编号还是圆点');

    assertEqual((await post('/api/template-item-update', { packId, itemId, status: 'active' })).ok, true, '发布应成功');
    const opened = await post('/api/template-create', { templateId: itemId });
    assertEqual(opened.ok, true, `开文书应成功：${opened.code ?? ''} ${opened.message ?? ''}`);

    const items = (await state()).items;
    const listItems = items.filter((item) => item.kind === 'listItem');
    assertEqual(listItems.length, 4, '两个列表各两项 = 4 条列表视图项');
    assertEqual(
      listItems.map((item) => item.marker).join('|'),
      '1. |2. |· |· ',
      '编号由服务端算：有序 1./2.、无序圆点',
    );
    assertEqual(listItems[0]?.text, '否认药物过敏史', '项里的文字要进视图（否则界面上是一条空行）');
    assert(
      typeof listItems[0]?.textId === 'string' && listItems[0].textId !== '',
      '文本节点 id 要下发：界面用它走 data-edit 那条写路径（不另开一条写路径）',
    );
    /* 带格子的项：格子要作为这一条的一部分下发，医生在列表里就能填（不是"只能看"） */
    assert(
      typeof listItems[2]?.fieldId === 'string' && listItems[2].fieldId !== '',
      '带格子的项要下发 fieldId（界面用它走 data-field，与正文填写项同一条写路径）',
    );
    assertEqual(listItems[2]?.unit, '支/日', '格子的单位要进视图（医生才知道该按什么单位填）');
    assertEqual(listItems[3]?.fieldId, undefined, '没配格子的项不带 fieldId（界面画成纯文字）');
    const duplicated = items.filter(
      (item) => item.kind === 'text' && ['否认药物过敏史', '不吸烟'].includes(String(item.text ?? '')),
    );
    assertEqual(duplicated.length, 0, '列表项里的文字不得再作为独立文本项出现（否则屏幕上一句话出现两遍）');

    /* 清理：删模板 + 复位工作区，不把这份自测文书留给后面的用例 */
    assertEqual((await post('/api/template-item-delete', { packId, itemId })).ok, true, '删除应成功');
    assertEqual((await resetWorkspace()).ok, true, '复位应成功');
  });

  await test('B52 科室字典与"限科室"判定：可选科室来自字典，模板按就诊科室真的开得出 / 开不出', async () => {
    /* 这条把"科室只作标注"那套说法彻底改掉：以前界面上写着"限产科"，而谁都开得出 ——
       那是一句假话。现在：
       ① 科室是一份**主数据**（本用例就是它的读写口子），编码是判定用的、名称是给人看的；
       ② 模板上的科室**只能从字典里选**（未知编码保存即被拒，否则那份文书谁都开不出）；
       ③ 医生端「新建」名单与开具动作**同一条判定**：不匹配就不列、硬开也拒，且说明原因。 */
    await adminLogin();
    const deptState = await state();
    const readable = deptState.departments as { source?: string; items?: Array<{ code: string; name: string }> } | undefined;
    assertEqual(readable?.source, 'store', '科室字典应已落库（B50 已建立）');
    assert(deptState.encounter.dept === 'DEPT_RESP', `当前就诊科室应是编码（实际 ${deptState.encounter.dept}）`);
    assertEqual((deptState.encounter as { deptName?: string }).deptName, '呼吸内科', '就诊科室另给一份**名称**给人看（编码只用于判定）');
    /* 工作区树：**名称给人看、编码给判定**，两个字段都给（界面用前者，判定用后者）。
       只给编码会让树上显示一串 DEPT_RESP，只给名称则判定无处取数。 */
    const treeVisits = (deptState.tree ?? []).flatMap((patient) => (patient.visits ?? []).map((visit) => ({
      dept: visit.dept,
      deptCode: (visit as { deptCode?: string }).deptCode,
    })));
    assert(
      treeVisits.some((visit) => visit.dept === '呼吸内科' && visit.deptCode === 'DEPT_RESP'),
      `树里应同时给出科室名称与编码，实际：${JSON.stringify(treeVisits.slice(0, 3))}`,
    );

    /* ① 读写口子：未登录改不动；非法清单当场被拒（错误要能定位到第几项） */
    assertEqual((await postNoAuth('/api/departments', { items: [] })).ok, false, '未登录不得改科室字典');
    const dup = await post('/api/departments', {
      items: [{ code: 'DEPT_RESP', name: '呼吸内科' }, { code: 'DEPT_RESP', name: '另一个呼吸内科' }],
    });
    assertEqual(dup.ok, false, '编码重复应被拒（重复时"这份文书限哪个科"就没有确定答案）');
    assert(String(dup.message ?? '').includes('DEPT_RESP'), `错误消息要点出是哪个编码，实际：${dup.message ?? ''}`);

    /* ② 模板配一个字典里没有的编码 → 保存即被拒（一个对不上任何人的编码 = 谁都开不出） */
    const id = 'tpl.obstetric.outpatient';
    const before = await state();
    const target = (before.templateCatalog ?? []).find((item) => item.itemId === id);
    const packId = String(target?.packId ?? '');
    const unknown = await post('/api/template-item-update', { packId, itemId: id, departments: ['DEPT_NOPE'] });
    assertEqual(unknown.ok, false, '字典里没有的科室编码不得写进模板');
    assertEqual(String(unknown.code ?? ''), 'E_TPL_DEPT_UNKNOWN', '错误码要能定位到"科室对不上"');

    /* ③ 限产科：当前就诊是呼吸内科 → 名单里没有它，硬开被拒且**用人话说明** */
    const limiting = await post('/api/template-item-update', { packId, itemId: id, departments: ['DEPT_OB'] });
    assertEqual(limiting.ok, true, `限科室应能保存：${limiting.code ?? ''} ${limiting.message ?? ''}`);
    const limited = await state();
    assertEqual(
      (limited.templates ?? []).some((item) => item.templateId === id),
      false,
      '「新建」名单里只列开得出的文书（列出再拒是让人白点一次）',
    );
    const refused = await post('/api/template-create', { templateId: id });
    assertEqual(refused.ok, false, '硬开一份科室不匹配的文书应被拒');
    assertEqual(String(refused.code ?? ''), 'E_TPL_DEPT_MISMATCH', '错误码要说清是科室不匹配，而不是"模板不存在"');
    assert(
      String(refused.message ?? '').includes('产科') && String(refused.message ?? '').includes('呼吸内科'),
      `拒绝理由要用**科室名称**说清"它限哪个科、本次是哪个科"，实际：${refused.message ?? ''}`,
    );

    /* ④ 改成当前就诊的科室 → 名单里有它，且真的开得出一份 */
    const matching = await post('/api/template-item-update', { packId, itemId: id, departments: ['DEPT_RESP', 'DEPT_OB'] });
    assertEqual(matching.ok, true, '改成限呼吸内科 / 产科应能保存');
    const matched = await state();
    assertEqual((matched.templates ?? []).some((item) => item.templateId === id), true, '科室匹配时它进入「新建」名单');
    const opened = await post('/api/template-create', { templateId: id });
    assertEqual(opened.ok, true, `科室匹配时应能开出文书：${opened.code ?? ''} ${opened.message ?? ''}`);

    /* ⑤ 停用一个科室：它从"可选"里消失，但**既有模板不受影响**（这里是"配了就停用"的边界） */
    const disabled = await post('/api/departments', {
      items: [
        { code: 'DEPT_RESP', name: '呼吸内科', enabled: true },
        { code: 'DEPT_CARD', name: '心血管内科', enabled: true },
        { code: 'DEPT_GI', name: '消化内科', enabled: true },
        { code: 'DEPT_OB', name: '产科', enabled: false },
      ],
    });
    assertEqual(disabled.ok, true, '停用一个科室应能保存');
    const afterDisable = await state();
    assertEqual((afterDisable.departments as { enabledCount?: number }).enabledCount, 3, '启用数应少一个');
    assertEqual(
      (afterDisable.templates ?? []).some((item) => item.templateId === id),
      true,
      '停用科室不动既有模板：这份文书限呼吸内科 / 产科，当前就诊是呼吸内科，仍然开得出',
    );

    /* ⑥ 复原：科室清单恢复全启用，模板回到"通用"（不留痕给后面的排查添噪声） */
    const restoredDepts = await post('/api/departments', {
      items: [
        { code: 'DEPT_RESP', name: '呼吸内科', enabled: true },
        { code: 'DEPT_CARD', name: '心血管内科', enabled: true },
        { code: 'DEPT_GI', name: '消化内科', enabled: true },
        { code: 'DEPT_OB', name: '产科', enabled: true },
      ],
    });
    assertEqual(restoredDepts.ok, true, '科室清单应能复原');
    const restoredTemplate = await post('/api/template-item-update', { packId, itemId: id, departments: [] });
    assertEqual(restoredTemplate.ok, true, '模板科室应能复原为通用');
    const final = await state();
    assertEqual((final.templates ?? []).some((item) => item.templateId === id), true, '复原后它照旧可开');
  });

  await test('B52b 文书类型：可选项来自字典（判重看"体系 + 编码"），未登录改不动、非法清单当场被拒', async () => {
    /* ① 读口子：出厂就播了四种类型（与出厂模板声明的 docType 对齐）。
       读视图不设卡 —— 「新建文书」的类型下拉要用它（模板配置界面同理）。 */
    const view = (await get('/api/doc-types')).data as {
      items?: Array<{ system: string; code: string; display: string; enabled: boolean }>;
      source?: string;
      systems?: string[];
      enabledCount?: number;
    };
    assertEqual(view.source, 'store', '空库时应已播种（与科室字典同一次），这里读到的应当是库里那一份');
    assertEqual((view.items ?? []).length, 4, '出厂四种类型：入院记录 / 门（急）诊病历 / 病程记录 / 出院记录');
    assertEqual((view.systems ?? []).length, 4, '体系白名单随视图下发（界面的下拉与后端校验取同一处，不各写一份）');
    assert(
      (view.items ?? []).some((item) => item.system === 'WST500' && item.code === 'WST500.1'),
      '入院记录（WST500.1）必须在字典里 —— 它是时限类质控规则定位文书的依据',
    );

    /* ② 未登录改不动（院内主数据，与科室字典同一道门） */
    assertEqual((await postNoAuth('/api/doc-types', { items: [] })).ok, false, '未登录不得改文书类型');

    /* ③ 非法清单当场被拒：错误要能定位到"哪个键 / 哪一格"，而不是一句"格式不对" */
    await adminLogin();
    const dup = await post('/api/doc-types', {
      items: [
        { system: 'WST500', code: 'X1', display: '国标甲' },
        { system: 'WST500', code: 'X1', display: '另一个国标甲' },
      ],
    });
    assertEqual(dup.ok, false, '同一体系内编码重复应被拒（重复时"这条规则盯的是哪一类文书"就没有确定答案）');
    assert(String(dup.message ?? '').includes('WST500/X1'), `错误消息要点出是哪个键，实际：${dup.message ?? ''}`);
    assertEqual(
      (await post('/api/doc-types', { items: [{ system: 'HL7', code: 'X1', display: '甲' }] })).ok,
      false,
      '不认识的体系应被拒（它写不进文档模型的 docType.system）',
    );
    assertEqual(
      (await post('/api/doc-types', { items: [{ system: 'local', code: 'X1', display: '  ' }] })).ok,
      false,
      '缺显示名应被拒（人在界面上看到的是它）',
    );

    /* ④ **与科室字典的关键差别**：同一编码在不同体系下可以并存 ——
       照抄科室那条"code 唯一"会把 `local/X1` 与 `WST500/X1` 误判成重复，那是合法配置 */
    const both = await post('/api/doc-types', {
      items: [
        { system: 'WST500', code: 'X1', display: '国标甲' },
        { system: 'local', code: 'X1', display: '院内甲' },
      ],
    });
    assertEqual(both.ok, true, `跨体系同码应能保存：${both.code ?? ''} ${both.message ?? ''}`);
    assertEqual(both.data?.enabledCount, 2, '两个都应启用（缺省即启用）');

    /* ⑤ 停用：新建时选不到它，但**既有内容一个字都不改**（字典只管"能不能选"，不管"已经开出来的"） */
    const disabled = await post('/api/doc-types', {
      items: [
        { system: 'WST500', code: 'X1', display: '国标甲', enabled: false },
        { system: 'local', code: 'X1', display: '院内甲' },
      ],
    });
    assertEqual(disabled.ok, true, '停用应能保存（停用 ≠ 删除）');
    assertEqual(disabled.data?.enabledCount, 1, '启用数只数启用中的那一个');
    assertEqual((await state()).docTypes?.enabledCount, 1, '状态投影里的字典要与写入结果同口径');

    /* ⑥ 复原：回到出厂那四种类型（不留痕给后面的排查添噪声） */
    const restored = await post('/api/doc-types', {
      items: [
        { system: 'WST500', code: 'WST500.1', display: '入院记录', enabled: true },
        { system: 'WST500', code: 'WST500.2', display: '门（急）诊病历', enabled: true },
        { system: 'WST500', code: 'WST500.3', display: '病程记录', enabled: true },
        { system: 'WST500', code: 'WST500.4', display: '出院记录', enabled: true },
      ],
    });
    assertEqual(restored.ok, true, '类型清单应能复原');
    assertEqual((restored.data?.removedKeys ?? []).length, 2, '被去掉的是刚才那两个 X1，响应要如实点名（否则"保存成功"看不出丢了什么）');
  });

  await test('B53 表达式控件可新建：公式是结构（不是文本），建好就能被文书引用并算出值', async () => {
    /* ① 构造器的"积木"由服务端下发：函数表与上下文路径都来自内核的**同一份**清单。
       前端不手抄一份函数清单 —— 否则"界面能选、引擎不认"会潜伏到有人点了它那天。 */
    await adminLogin();
    const snapshot = await state();
    const fns = (snapshot.expressionFunctions ?? []);
    assert(fns.length >= 8, `函数表应下发给界面（实际 ${fns.length} 个）`);
    const div = fns.find((fn) => fn.name === 'div');
    assert(!!div && div.minArgs === 2 && div.maxArgs === 2, '函数要带参数个数：界面据此生成参数槽（div 恰好 2 个）');
    const mul = fns.find((fn) => fn.name === 'mul');
    assertEqual(mul?.maxArgs, null, '变长参数的函数报 null（Infinity 过不了 JSON），界面据此显示"＋参数"');
    const ctxFields = (snapshot.contextFields ?? []);
    assert(ctxFields.some((field) => field.path === 'patient.nameMasked'), '上下文路径清单也要下发（表达式里的"系统字段"用它）');

    /* ② 非法公式当场被拒：报的是"哪一层哪一格不对"，而不是一句"公式无效" */
    assertEqual((await postNoAuth('/api/expression-item-create', { name: 'x', expression: { kind: 'num', value: 1 } })).ok, false, '未登录不得新建控件');
    const bad = await post('/api/expression-item-create', {
      name: '坏公式',
      expression: { kind: 'fn', name: 'div', args: [{ kind: 'num', value: 1 }] },
    });
    assertEqual(bad.ok, false, '参数个数不对的公式应被拒');
    assert(String(bad.message ?? '').includes('div'), `错误消息要点出是哪个函数，实际：${bad.message ?? ''}`);

    /* ③ 新建一个 BMI 控件：mul(div(weight, pow(div(height,100),2))) —— 结构由构造器搭出来 */
    const created = await post('/api/expression-item-create', {
      name: '自测 BMI',
      unit: 'kg/m²',
      description: '体重 ÷ 身高(m)²',
      expression: {
        kind: 'fn',
        name: 'div',
        args: [
          { kind: 'slot', key: 'weight' },
          { kind: 'fn', name: 'pow', args: [{ kind: 'fn', name: 'div', args: [{ kind: 'slot', key: 'height' }, { kind: 'num', value: 100 }] }, { kind: 'num', value: 2 }] },
        ],
      },
    });
    assertEqual(created.ok, true, `新建控件应成功：${created.code ?? ''} ${created.message ?? ''}`);
    const exprId = String(created.data?.itemId ?? '');
    assertEqual(created.data?.formula, 'div(weight, pow(div(height, 100), 2))', '服务端要回一份人话公式（那是人在列表里唯一看得懂的东西）');
    const afterCreate = await state();
    const inCatalog = (afterCreate.templateCatalog ?? []).find((item) => item.itemId === exprId);
    assertEqual(inCatalog?.itemType, 'expression', '它作为**控件**进目录，而不是"一份没有章节的文书"');
    assertEqual(inCatalog?.enabled, true, '新建的控件是启用的');

    /* ④ 闭环：把它引用进一份文书 → 发布 → 开出来，派生值节点就在产物里
       （控件不绑文书，引用对不对在**用到它的那份文书**里校验） */
    const tmpl = await post('/api/template-item-create', {
      name: '自测引用控件的文书',
      docType: { system: 'local', code: 'exprUse', display: '自测引用控件的文书' },
    });
    const packId = String(tmpl.data?.packId ?? '');
    const tplId = String(tmpl.data?.itemId ?? '');
    const edited = await post('/api/template-item-update', {
      packId,
      itemId: tplId,
      sections: [{
        sectionCode: 'body',
        title: '正文',
        slots: [
          /* 从系统带入：患者姓名由系统填进来（模板只声明"从哪儿取"） */
          { slot: 'field', key: 'pname', dataType: 'text', from: 'patient.nameMasked' },
          { slot: 'field', key: 'weight', dataType: 'number', unit: 'kg' },
          { slot: 'field', key: 'height', dataType: 'number', unit: 'cm' },
          /* 派生值是**自己的槽位类别**（`slot: 'expression'`），不是"带公式的填写项"：
             它不可手填（手填会让"这个数怎么来的"没有答案），所以它与填写项是两类节点 */
          { slot: 'expression', key: 'bmi', useExpression: exprId, unit: 'kg/m²' },
        ],
      }],
    });
    assertEqual(edited.ok, true, `草稿应能引用新建的控件：${edited.code ?? ''} ${edited.message ?? ''}`);
    const published = await post('/api/template-item-update', { packId, itemId: tplId, status: 'active' });
    assertEqual(published.ok, true, '应能发布');
    const opened = await post('/api/template-create', { templateId: tplId });
    assertEqual(opened.ok, true, `应能开出这份文书：${opened.code ?? ''} ${opened.message ?? ''}`);
    const openedState = await state();
    assertEqual(openedState.activeDocId, String(opened.data?.docId ?? ''), '新建后应自动切到新文书');
    assertEqual(openedState.doc.docType, '自测引用控件的文书', '文书类型来自模板声明的 docType');
    /* 闭环的关键一条：这份文书里"由公式算出来"的字段应有**恰好一个** ——
       它证明我新建的那个控件真的被引擎当成了派生值（不是一串躺在包里的 JSON）。 */
    assertEqual(openedState.derivedCount, 1, '新建的控件应被引擎认作派生值（否则它只是躺在包里的一条数据）');
    /* 输入项还空着：派生值这时是"算不出"，不是 0 */
    const derived = openedState.items.filter((item) => item.kind === 'field');
    assert(derived.length >= 2, '前置：这份文书应有填写项');
    /* 从系统带入的那一格：界面上必须能说清"这个值是从哪儿来的" ——
       它和"模板给了个空骨架"共用 `origin: system`，不分开写，医生就会以为姓名没带进来 */
    const broughtIn = openedState.items.find((item) => (item as { fromRef?: string }).fromRef === 'patient.nameMasked');
    assert(!!broughtIn, '从系统带入的格子要能指认出"从哪儿带进来的"');
    assertEqual(
      (broughtIn as { fromLabel?: string }).fromLabel,
      '患者姓名（掩码）',
      '界面显示的是人话名称（不是 patient.nameMasked 这种路径）',
    );
    assert(
      String((broughtIn as { value?: string }).value ?? '') !== '',
      '带进来的是**真的患者姓名**（空串会与"没带进来"长得一模一样）',
    );

    /* ⑤ 收拾干净：删掉自测文书，控件留着无妨（它是"本院自建"的正常产物） */
    const cleaned = await post('/api/template-item-delete', { packId, itemId: tplId });
    assertEqual(cleaned.ok, true, '自测文书应能删除');
  });

  await test('B54 控件可改可删：改公式只换「怎么算」，被文书引用的控件删不掉（并指出是谁在用）', async () => {
    await adminLogin();
    /* ① 建一个控件：MAP = (收缩压 + 2×舒张压) / 3 */
    const created = await post('/api/expression-item-create', {
      name: '自测 MAP',
      unit: 'mmHg',
      description: '平均动脉压',
      expression: {
        kind: 'fn',
        name: 'div',
        args: [
          {
            kind: 'fn',
            name: 'add',
            args: [
              { kind: 'slot', key: 'sbp' },
              { kind: 'fn', name: 'mul', args: [{ kind: 'slot', key: 'dbp' }, { kind: 'num', value: 2 }] },
            ],
          },
          { kind: 'num', value: 3 },
        ],
      },
    });
    assertEqual(created.ok, true, `新建控件应成功：${created.code ?? ''} ${created.message ?? ''}`);
    const packId = String(created.data?.packId ?? '');
    const exprId = String(created.data?.itemId ?? '');

    /* ② 改名与单位：它们不进任何已开出的病历，改起来没有代价 */
    const renamed = await post('/api/expression-item-update', { packId, itemId: exprId, name: '自测平均动脉压', unit: 'mmHg' });
    assertEqual(renamed.ok, true, `改控件应成功：${renamed.code ?? ''} ${renamed.message ?? ''}`);
    const afterRename = await state();
    const renamedItem = (afterRename.templateCatalog ?? []).find((item) => item.itemId === exprId);
    assertEqual(renamedItem?.name, '自测平均动脉压', '改名生效');
    assertEqual(renamedItem?.unit, 'mmHg', '没动的字段保持不变');
    assert(typeof renamedItem?.expression === 'object', '公式要能回显给构造器（否则「编辑」只能从头搭一遍）');

    /* ③ 改公式：服务端回一份新的人话公式，审计里记"改前 ⇒ 改后" */
    const patched = await post('/api/expression-item-update', {
      packId,
      itemId: exprId,
      expression: {
        kind: 'fn',
        name: 'div',
        args: [{ kind: 'fn', name: 'add', args: [{ kind: 'slot', key: 'sbp' }, { kind: 'slot', key: 'dbp' }] }, { kind: 'num', value: 2 }],
      },
    });
    assertEqual(patched.ok, true, `改公式应成功：${patched.code ?? ''} ${patched.message ?? ''}`);
    assertEqual(patched.data?.formula, 'div(add(sbp, dbp), 2)', '服务端要回新公式的人话形式（列表里唯一看得懂的东西）');
    const badFormula = await post('/api/expression-item-update', {
      packId,
      itemId: exprId,
      expression: { kind: 'fn', name: 'pow', args: [{ kind: 'num', value: 2 }] },
    });
    assertEqual(badFormula.ok, false, '参数个数不对的公式要被拒');
    assertEqual(String(badFormula.code ?? ''), 'E_TPL_PACK_INVALID', '错误码要能定位到公式本身');

    /* ④ 让一份文书用上它 → 删除被拒，且**指出是谁在用** */
    const tmpl = await post('/api/template-item-create', {
      name: '自测用控件的文书',
      docType: { system: 'local', code: 'exprDelete', display: '自测用控件的文书' },
    });
    const tplPackId = String(tmpl.data?.packId ?? '');
    const tplId = String(tmpl.data?.itemId ?? '');
    const edited = await post('/api/template-item-update', {
      packId: tplPackId,
      itemId: tplId,
      sections: [{
        sectionCode: 'body',
        title: '正文',
        slots: [
          { slot: 'field', key: 'sbp', dataType: 'number', unit: 'mmHg' },
          { slot: 'field', key: 'dbp', dataType: 'number', unit: 'mmHg' },
          { slot: 'expression', key: 'map', useExpression: exprId, unit: 'mmHg' },
        ],
      }],
    });
    assertEqual(edited.ok, true, `草稿应能引用它：${edited.code ?? ''} ${edited.message ?? ''}`);
    const blocked = await post('/api/expression-item-delete', { packId, itemId: exprId });
    assertEqual(blocked.ok, false, '被文书引用的控件删不掉');
    assertEqual(String(blocked.code ?? ''), 'E_TPL_EXPR_IN_USE', '错误码要说清是"还在被引用"');
    assert(
      String(blocked.message ?? '').includes('自测用控件的文书'),
      `拒绝理由要点出是哪份文书在用，实际：${blocked.message ?? ''}`,
    );

    /* ⑤ 删掉那份文书之后就能删控件 —— 这条路必须走得通，否则"拦住"就变成了"卡死" */
    assertEqual((await post('/api/template-item-delete', { packId: tplPackId, itemId: tplId })).ok, true, '应能删掉那份文书');
    const deleted = await post('/api/expression-item-delete', { packId, itemId: exprId });
    assertEqual(deleted.ok, true, `没人用之后应能删：${deleted.code ?? ''} ${deleted.message ?? ''}`);
    assertEqual(
      ((await state()).templateCatalog ?? []).some((item) => item.itemId === exprId),
      false,
      '删完模板库里没有它',
    );

    /* ⑥ 未登录改不动 / 删不动 */
    assertEqual((await postNoAuth('/api/expression-item-update', { packId, itemId: exprId, name: 'x' })).ok, false, '未登录改不了控件');
    assertEqual((await postNoAuth('/api/expression-item-delete', { packId, itemId: exprId })).ok, false, '未登录删不了控件');
  });

  /* 专科控件与表达式控件**不是同一件事**（一个是"这个值怎么算"，一个是"长什么样、填什么"），
     所以它有自己的一页、自己的增删改；而它在包里同样只是一条**声明** ——
     要算的格子引用表达式控件，控件自身不带任何可执行内容。
     **本系统不预置内置控件**：所以这条"从零建起来"的路必须真的走得通，
     否则「基础数据 → 专科控件」这一页永远是空表，等于没做。 */
  await test('B70 专科控件：可新建 / 可改（字段语义一变自动升版）/ 可删；形状与引用当场校验', async () => {
    await adminLogin();

    /* ① 未登录不得新建 */
    assertEqual(
      (await postNoAuth('/api/control-item-create', {
        name: 'x', controlKind: 'custom', shape: 'scale', fields: [{ key: 'a', label: 'A', dataType: 'number' }],
      })).ok,
      false,
      '未登录不得新建专科控件',
    );

    /* ② 新建一个**时序**控件（住院最需要的那一类形状：一组数值按时间轴排开） */
    const created = await post('/api/control-item-create', {
      name: '自测体温单',
      description: '住院体温单',
      controlKind: 'vitalSignsChart',
      shape: 'series',
      fields: [
        { key: 'measuredAt', label: '测量时间', dataType: 'date', axis: 'time' },
        { key: 'temper', label: '体温', dataType: 'number', unit: '℃', referenceRange: { low: 36, high: 37.3 } },
      ],
    });
    assertEqual(created.ok, true, `新建专科控件应成功：${created.code ?? ''} ${created.message ?? ''}`);
    const ctrlId = String(created.data?.itemId ?? '');
    assert(/^ctrl\.custom\.\d+$/.test(ctrlId), `控件 id 应是 ctrl.custom.N，实际 ${ctrlId}`);

    /* ③ 目录里看得见它：形状 / 语义类型 / **完整字段**（编辑那一屏要原样回显）与定义版本都在 */
    const catalog = (await state()).templateCatalog ?? [];
    /* 目录条目是**联合**：控件条目才带 shape / controlKind / fields / controlVersion，
       模板条目没有。取之前先落到控件那一支，否则这几格在类型上"不存在"。 */
    const entry = catalog.find((item) => item.itemId === ctrlId) as
      | { itemId: string; itemType?: string; shape?: string; controlKind?: string; fields?: unknown[]; controlVersion?: number }
      | undefined;
    assertEqual(entry?.itemType, 'control', '控件作为 control 条目进目录（不是"一份没有章节的文书"）');
    assertEqual(entry?.shape, 'series', '目录要带形状（界面按它显示"这一条会被画成什么"）');
    assertEqual(entry?.controlKind, 'vitalSignsChart', '目录要带语义类型');
    assertEqual((entry?.fields ?? []).length, 2, '目录要带**完整字段**：少一格，编辑时那一格就没了');
    assertEqual(entry?.controlVersion, 1, '新建的定义是 v1');

    /* ④ 形状是**闭集**：写一个不存在的形状当场被拒（认不出的形状画不出来，晚了只能看到一片空白） */
    const badShape = await post('/api/control-item-create', {
      name: '坏形状', controlKind: 'custom', shape: 'heatmap', fields: [{ key: 'a', label: 'A', dataType: 'number' }],
    });
    assertEqual(badShape.ok, false, '形状不在闭集里应被拒');
    assert(String(badShape.message ?? '').includes('shape'), `错误消息要点出是 shape，实际：${badShape.message ?? ''}`);

    /* ⑤ 要算的那一格必须指向**本包内**的表达式控件：指向不存在的东西当场被拒 */
    const badRef = await post('/api/control-item-create', {
      name: '坏引用', controlKind: 'custom', shape: 'scale',
      fields: [{ key: 'bmi', label: 'BMI', dataType: 'expression', useExpression: 'expr.nope' }],
    });
    assertEqual(badRef.ok, false, 'useExpression 指向本包里不存在的表达式控件应被拒');

    /* ⑥ 只改名称与说明：**定义版本不动**（版本回答的是"改到第几版"，不是"改过几次"） */
    const renamed = await post('/api/control-item-update', {
      packId: String(created.data?.packId ?? ''), itemId: ctrlId, name: '自测体温记录', description: '改了说明',
    });
    assertEqual(renamed.ok, true, `改名应成功：${renamed.code ?? ''} ${renamed.message ?? ''}`);
    assertEqual((renamed.data as { version?: number } | undefined)?.version, 1, '只改名称与说明不该升版');

    /* ⑦ 改字段：定义**自动升一版** —— 已开出的病历存着当时那份字段快照，
       原地改会让同一份 payload 在两次导出里被解读成两种意思 */
    const packId = String(created.data?.packId ?? '');
    const patched = await post('/api/control-item-update', {
      packId, itemId: ctrlId,
      fields: [
        { key: 'measuredAt', label: '测量时间', dataType: 'date', axis: 'time' },
        { key: 'temper', label: '体温', dataType: 'number', unit: '℃', referenceRange: { low: 36, high: 37.3 } },
        { key: 'pulse', label: '脉搏', dataType: 'number', unit: '次/分' },
      ],
    });
    assertEqual(patched.ok, true, `改字段应成功：${patched.code ?? ''} ${patched.message ?? ''}`);
    assertEqual((patched.data as { version?: number } | undefined)?.version, 2, '字段一变，定义应自动升到 v2');
    const afterPatch = ((await state()).templateCatalog ?? []).find((item) => item.itemId === ctrlId) as
      | { itemId: string; fields?: unknown[] }
      | undefined;
    assertEqual((afterPatch?.fields ?? []).length, 3, '字段改动要落进目录（编辑时按它回显）');

    /* ⑧ matrix 少了行列当场被拒：否则渲染出来是一张空表，而人只会以为"控件配错了" */
    const badMatrix = await post('/api/control-item-update', { packId, itemId: ctrlId, shape: 'matrix', rows: [], columns: [] });
    assertEqual(badMatrix.ok, false, 'matrix 形状缺行列应被拒');

    /* ⑨ 未登录改不动 / 删不动 */
    assertEqual(
      (await postNoAuth('/api/control-item-update', { packId, itemId: ctrlId, name: 'x' })).ok,
      false,
      '未登录改不了控件',
    );
    assertEqual(
      (await postNoAuth('/api/control-item-delete', { packId, itemId: ctrlId })).ok,
      false,
      '未登录删不了控件',
    );

    /* ⑩ 删除：从目录里消失（今天没有任何东西引用控件，所以不拦；等槽位能引用它之后要补这条检查） */
    const deleted = await post('/api/control-item-delete', { packId, itemId: ctrlId });
    assertEqual(deleted.ok, true, `删除应成功：${deleted.code ?? ''} ${deleted.message ?? ''}`);
    assertEqual(
      ((await state()).templateCatalog ?? []).some((item) => item.itemId === ctrlId),
      false,
      '删掉的控件不该再出现在目录里',
    );
  });

  await test('B55 规则库：条目可逐条修改（改的是包内容：内容指纹变、审计留痕），而判定机制与级别上限不放开', async () => {
    /* 这条钉住五件事，少一件这条编辑口子就会变成隐患：
       ① 改的是**包内容**（内容指纹必变、前后指纹进审计），不是"改个显示标签"；
       ② 只开放标题 / 级别 / 判定方式与参数 / 文案 —— **判定机制（谓词表）不跟着放开**，
          级别上限是 warn（block 意味着卡住流程，不随一次保存被带进部署）；
       ③ 停用着的规则不会因为改个标题被顺手打开；
       ④ 目录必须把"按什么判、参数是多少"带出来：编辑是"读回 → 改 → 写回"的回路，
          读不全就等于写不全（少回显一个字段，那一次保存就把它静默清掉）；
       ⑤ 改回原样要能回到**原内容指纹** —— 可逆是这条口子唯一的安全感。 */
    await adminLogin();

    const before = await state();
    const rule = (before.knowledgePacks.rules ?? []).find((item) => item.itemId === 'R-TIME-01');
    assert(!!rule, '规则库应逐条列出规则（含停用项）');
    assert(typeof rule?.predicate === 'string', '目录要带出判定方式（否则编辑抽屉回显不出来）');
    assert(typeof rule?.params === 'object', '目录要带出参数（否则编辑一次就把参数清掉了）');

    const packId = String(rule?.packId ?? '');
    const itemId = String(rule?.itemId ?? '');
    const originalTitle = String(rule?.title ?? '');
    const originalSeverity = String(rule?.severity ?? '');
    const contentBefore = before.knowledgePacks.contentFingerprint;
    const rulesBefore = (before.knowledgePacks.rules ?? []).length;

    /* 判定方式是**包内容**：这条规则要换成"引用一条判定方式"，那条判定方式就得在**它所在的包里**
       （引用只在本包内解析，见 R13）。所以先在本包建一条自测用的（收尾删掉）——
       这一步顺带就是"包内的判定方式能被本包规则引用"的正面证据。 */
    const tempCondition = await post('/api/qc-condition-create', {
      packId,
      name: '自测：记录写入时刻超时限',
      description: '自测用（本用例收尾会删掉）',
      params: [{ name: 'limitHours', kind: 'integer', label: '时限', unit: '小时', required: true, doc: '超过它才算超时。' }],
      when: { kind: 'atom', field: 'recordedAt', op: 'older-than-hours', value: '$limitHours' },
    });
    assertEqual(tempCondition.ok, true, `在规则所在的包里建一条判定方式应成功：${tempCondition.code ?? ''} ${tempCondition.message ?? ''}`);
    const tempConditionId = String((tempCondition.data as { itemId?: string } | undefined)?.itemId ?? '');

    /* "能配哪些参数"只该有一处（谓词注册表）：界面照下发的规格生成参数表单，
       所以下发的那份必须带人话名、说明与参数规格 —— 否则前端只能自己抄一份，
       而抄出来的那份与引擎不一致时，表现是"界面能配、引擎不认" */
    const catalog = before.qcPredicates ?? [];
    assertEqual(catalog.length, 7, '要下发全部判定方式（界面不许自己抄一份谓词清单）');
    assert(
      catalog.every((item) => typeof item.label === 'string' && typeof item.doc === 'string' && Array.isArray(item.params)),
      '每种判定方式都要带人话名、说明与参数规格',
    );
    const timeLimit = catalog.find((item) => item.kind === 'document-time-limit');
    assert(
      (timeLimit?.params ?? []).some((spec) => spec.name === 'limitHours' && spec.required === true),
      '必填参数要标出来（界面据此在提交前先拦一次）',
    );
    /* 第七种（条件树）：它的参数是**条件**，所以除了规格本身，还要下发字段表与算子表 ——
       没有那两张表，界面上的构造器是个空壳（能选，但没有可选项） */
    const condition = catalog.find((item) => item.params.some((spec) => spec.kind === 'condition'));
    assert(!!condition, '要下发"自定义条件"那一种判法（否则规则库里拼不出条件）');
    /* "必须给一个条件"这件事，**`required` 这个旗标表达不了**：`conditionId`（引用一条判定方式）
       与 `when`（就地拼一条）是**两选一**，把任一格标成必填，另一条正当路径就会被界面判成"没填"。
       所以这里钉的是它的真实形态：两格都不标必填，而"一个条件都没有"由**引擎**当场拒 ——
       没有任何一条路能存下"永远不命中"的规则（它在界面上看起来一切正常）。 */
    const choiceParams = (condition?.params ?? []).filter(
      (spec) => spec.kind === 'condition' || spec.kind === 'condition-ref',
    );
    assertEqual(choiceParams.length, 2, '两选一的两格（引用判定方式 / 就地拼一条）都要下发');
    assert(
      choiceParams.every((spec) => spec.required !== true),
      '两选一的两格都不该标必填：标了任一格，另一条正当路径会被界面判成"没填"',
    );
    const noCondition = await post('/api/rule-item-create', {
      title: '一条没有条件的自定义条件规则',
      severity: 'warn',
      predicate: { kind: 'field-condition', params: {} },
    });
    assertEqual(noCondition.ok, false, '一个条件都不给的"自定义条件"规则必须被拒（否则它永远不命中，而界面上看不出异常）');
    const conditionCatalog = before.qcCondition;
    assert(conditionCatalog.fields.length > 0, '要下发可用的字段（构造器靠它长出"字段"那一格）');
    assert(conditionCatalog.operators.length > 0, '要下发可用的算子（构造器靠它长出"算子"与"取值"两格）');
    assert(conditionCatalog.logic.length >= 2, '要下发「满足全部 / 满足任一」（界面不写死这两个词）');
    assert(
      conditionCatalog.operators.every((item) => Array.isArray(item.fields) && item.fields.length > 0 && String(item.doc ?? '').trim() !== ''),
      '每个算子都要写清"能用在哪些字段上"与"怎么算"',
    );
    assert(
      !JSON.stringify(conditionCatalog).includes('**'),
      '界面可见文案不许带 Markdown 记号（它会被原样显示成一串星号）',
    );

    /* ① 未登录改不动（改的是判定标准，与开关包同一道门） */
    assertEqual((await postNoAuth('/api/rule-item-update', { packId, itemId, title: '随便改' })).ok, false, '未登录不得改规则');

    /* ② 先停用，再改 —— 两件事互相独立，顺序反过来就验不出"顺手打开" */
    assertEqual((await post('/api/knowledge-pack-toggle', { packId, itemId, enabled: false })).ok, true, '停用应成功');

    /* 改的是"**引用哪一条判定方式、实参是多少**" —— 规则库这一层不再有"内核判法"可选，
       所以这一改也顺带钉住：界面/接口交上去的形态就是 `field-condition` + `conditionId` + `args`。 */
    const edited = await post('/api/rule-item-update', {
      packId,
      itemId,
      title: '入院记录未在时限内完成（病案室口径）',
      severity: 'info',
      predicate: {
        kind: 'field-condition',
        params: { conditionId: tempConditionId, args: { limitHours: 48 } },
      },
      detail: '按系统内写入时刻算：入院记录应在 48 小时内完成。',
      suggestion: '核对入院记录完成时刻，补写说明。',
    });
    assertEqual(edited.ok, true, `改规则应成功：${edited.code ?? ''} ${edited.message ?? ''}`);

    const afterState = await state();
    const after = (afterState.knowledgePacks.rules ?? []).find((item) => item.itemId === itemId);
    assertEqual(after?.title, '入院记录未在时限内完成（病案室口径）', '目录里的标题应是改后的');
    assertEqual(after?.severity, 'info', '级别可改（在 info / warn 之内）');
    assertEqual(String(after?.predicate ?? ''), 'field-condition', '判定方式可换（换的是"引用哪一条判定方式"）');
    assertEqual(
      JSON.stringify(after?.params ?? {}),
      JSON.stringify({ conditionId: tempConditionId, args: { limitHours: 48 } }),
      '实参按原样写回（时限是数字，不是字符串）',
    );
    assertEqual(after?.detail, '按系统内写入时刻算：入院记录应在 48 小时内完成。', '判定依据可覆盖内置文案');
    assertEqual(after?.enabled, false, '停用着的规则不会因为改了个标题被顺手打开');
    assert(afterState.knowledgePacks.contentFingerprint !== contentBefore, '改的是包内容：内容指纹必须变（否则"换了一版"没人看得出来）');
    assert(
      afterState.knowledgePacks.effectiveFingerprint !== before.knowledgePacks.effectiveFingerprint,
      '生效指纹是"内容 + 开关"的合成：内容换了它必换（只动生效指纹是**开关**那一侧的特权）',
    );
    /* ② 刚把它停用了，所以这一轮质控要**少跑它一条**（这条断言原来写成"条数不变"，
       与它自己的名字（停用中：它不进入下一轮质控）自相矛盾：实测会把 7 当期望、6 当实际，
       任何时候都失败。守着"停用"这件事的，是下面这两句。） */
    assertEqual((afterState.formRules ?? []).some((item) => item.id === itemId), false, '停用中：它不进入下一轮质控');
    assertEqual(
      (afterState.formRules ?? []).length,
      (before.formRules ?? []).length - 1,
      '停用中：这一轮质控少跑它一条（别的规则不受牵连）',
    );
    assertEqual((afterState.doc ?? {}).rev, (before.doc ?? {}).rev, '改判定标准不改病历一个字');

    /* ③ 边界：机制、级别与包类别都不放开 */
    const block = await post('/api/rule-item-update', { packId, itemId, severity: 'block' });
    assertEqual(block.ok, false, 'block 意味着卡住流程，不由一次保存带进部署');
    assertEqual(String(block.code ?? ''), 'E_RULE_SEVERITY_EDIT_LIMIT', '错误码要说清是"级别上限"');
    const unknownKind = await post('/api/rule-item-update', { packId, itemId, predicate: { kind: 'write-document' } });
    assertEqual(unknownKind.ok, false, '判定机制不放开：没有这种判法');
    assertEqual(String(unknownKind.code ?? ''), 'E_RULE_PREDICATE_UNKNOWN', '错误码要说清是"没有这种判定方式"');
    const badParam = await post('/api/rule-item-update', {
      packId,
      itemId,
      predicate: { kind: 'text-missing-time', params: { minLength: 0 } },
    });
    assertEqual(String(badParam.code ?? ''), 'E_RULE_PARAM_INVALID', '参数不合法要当场拒（与装载期走同一段校验）');
    const onTemplate = await post('/api/rule-item-update', { packId: 'tpl.obstetric.outpatient', itemId, title: 'x' });
    assertEqual(onTemplate.ok, false, '非规则包不能从这个口子改');
    assertEqual(String(onTemplate.code ?? ''), 'E_PACK_NOT_FOUND', '错误码要说清是"包类别不对"');
    assertEqual((await post('/api/rule-item-update', { packId, itemId })).ok, false, '没有要改的字段要拒');

    /* ④ 审计要答得出"改了哪几项"与"换了哪一版"，而不只是一句"改过规则" */
    const audit = (await getAuth('/api/admin/audit')) as unknown as AdminAuditView;
    const entries = (audit.entries ?? []).filter(
      (item) => item.subject === '内容包' && String(item.note ?? '').includes(itemId),
    );
    assert(entries.length >= 1, `审计里应有这次改规则的记录，实际 ${entries.length} 条`);
    assert((entries[0]?.changes ?? []).some((change) => change.field === '包指纹'), '内容前后指纹要进审计');

    /* ⑤ 复原：标题 / 级别 / 判定方式与参数 / 文案都按目录里的原值写回，
       内容指纹应**逐字回到原值**（顺带证明"清掉覆盖"是删字段而不是写空串） */
    const restored = await post('/api/rule-item-update', {
      packId,
      itemId,
      title: originalTitle,
      severity: originalSeverity,
      predicate: { kind: String(rule?.predicate ?? ''), params: (rule?.params ?? {}) as Record<string, unknown> },
      detail: String(rule?.detail ?? ''),
      suggestion: String(rule?.suggestion ?? ''),
    });
    assertEqual(restored.ok, true, `复原应成功：${restored.code ?? ''} ${restored.message ?? ''}`);
    /* 自测那条判定方式要收尾删掉（它是这一步临时建进样例包里的）。
       删得掉的**前提**是"没人引用它了"：上一步刚把规则复原成原来的判法 ——
       这正好把删除保护与引用面串了一遍。 */
    const dropTemp = await post('/api/qc-condition-delete', { packId, itemId: tempConditionId });
    assertEqual(dropTemp.ok, true, `收尾删掉自测判定方式应成功：${dropTemp.code ?? ''} ${dropTemp.message ?? ''}`);
    const finalState = await state();
    /* 指纹要逐字回来：临时建的那条已经删掉，包内容与最开始是同一份 */
    assertEqual(finalState.knowledgePacks.contentFingerprint, contentBefore, '改回原样应回到原内容指纹（可复现）');
    assertEqual((finalState.knowledgePacks.rules ?? []).length, rulesBefore, '编辑不加不减：规则条数不变');
    /* 这条规则本来是启用着的：把它留在停用态会污染后面的用例（B33 那一类要数规则） */
    assertEqual((await post('/api/knowledge-pack-toggle', { packId, itemId, enabled: true })).ok, true, '复原后应能重新启用');
  });

  await test('B56 规则库：新建的规则先停用（下一轮质控不跑它），启用后才上线，删除不动病历', async () => {
    /* 这条钉住"新建先停用"不是个礼貌说法：
       ① 建出来医生端与扫描**都用不上** —— 判定标准不该随保存悄悄上线；
       ② 启用是一次显式动作，启用后真的进入质控；
       ③ 删除只让"下一轮不跑它"：已经产生的质控提示一个字都不动（它们是旁挂注解）。 */
    await adminLogin();
    const before = await state();
    const revBefore = (before.doc ?? {}).rev;
    const formBefore = (before.formRules ?? []).length;
    /* 判据要在**动手之前**取：自建包里除了本院的规则，还有出厂种子的那几条判定方式 ——
       删掉最后一条规则不该把它们一起带走（下面那两句断言的就是这件事） */
    const conditionsBefore = (before.qcConditions ?? []).length;

    const created = await post('/api/rule-item-create', {
      title: '自测自建规则',
      severity: 'warn',
      predicate: { kind: 'text-missing-time', params: { minLength: 6 } },
    });
    assertEqual(created.ok, true, `新建规则应成功：${created.code ?? ''} ${created.message ?? ''}`);
    /* 响应里要点明"它是停用的"：界面靠这一句告诉人"下一步去点启用" */
    const createdData = created.data as { packId?: string; itemId?: string; enabled?: boolean } | undefined;
    assertEqual(createdData?.enabled, false, '新建出来必须是停用的');
    const packId = String(createdData?.packId ?? '');
    const itemId = String(createdData?.itemId ?? '');
    assert(/^R-CUSTOM-\d+$/.test(itemId), `规则号应由服务端按序号生成，实际：${itemId}`);
    assertEqual(packId, 'doc.rule.custom', '新建的规则进**自建包**（哪些是本院自己维护的一眼分得出来）');

    const afterCreate = await state();
    const mine = (afterCreate.knowledgePacks.rules ?? []).find((item) => item.itemId === itemId);
    assertEqual(mine?.enabled, false, '库里看得见、但不跑');
    assertEqual((afterCreate.formRules ?? []).length, formBefore, '停用中：不进入下一轮质控');
    assertEqual((afterCreate.doc ?? {}).rev, revBefore, '新建规则不改病历');

    /* 非法输入当场拒：判定方式与级别走的是与装载同一段校验 */
    assertEqual(
      (await post('/api/rule-item-create', { title: '   ', severity: 'warn', predicate: { kind: 'text-missing-time' } })).ok,
      false,
      '标题不能为空（它是清单与提示里显示的那一行）',
    );
    assertEqual(
      String((await post('/api/rule-item-create', { title: 'x', severity: 'block', predicate: { kind: 'text-missing-time' } })).code ?? ''),
      'E_RULE_SEVERITY_EDIT_LIMIT',
      '新建也不放开 block',
    );
    assertEqual((await post('/api/rule-item-create', { title: 'x', severity: 'warn' })).ok, false, '不说明"按什么判"的规则不成立');
    assertEqual(
      (await postNoAuth('/api/rule-item-create', { title: 'x', severity: 'warn', predicate: { kind: 'text-missing-time' } })).ok,
      false,
      '未登录不得新建规则',
    );

    /* 启用 → 真的进入质控；开关本身仍然不动病历（与 B33 同一条纪律） */
    assertEqual((await post('/api/knowledge-pack-toggle', { packId, itemId, enabled: true })).ok, true, '启用应成功');
    const onState = await state();
    assert((onState.formRules ?? []).some((item) => String(item.id ?? '') === itemId), '启用后进入下一轮质控');
    assertEqual((onState.doc ?? {}).rev, revBefore, '开关规则不改病历');

    /* 删除：规则库里没有它了，而病历一个字不动 */
    const removed = await post('/api/rule-item-delete', { packId, itemId });
    assertEqual(removed.ok, true, `删除应成功：${removed.code ?? ''} ${removed.message ?? ''}`);
    const afterDelete = await state();
    assertEqual((afterDelete.knowledgePacks.rules ?? []).some((item) => item.itemId === itemId), false, '删完规则库里没有它');
    assertEqual((afterDelete.formRules ?? []).length, formBefore, '下一轮质控回到原样');
    assertEqual((afterDelete.doc ?? {}).rev, revBefore, '删规则不动病历：已经产生的质控提示是旁挂注解，仍读得出来');
    assertEqual((await post('/api/rule-item-delete', { packId, itemId })).ok, false, '删不存在的条目要明确报出（不是静默成功）');
    /* 自建包里还有判定方式（出厂种子的那几条），所以"删掉最后一条规则"**不会**把包一起带走。
       早先这里断言的是"包随最后一条移除"—— 那是"包里只有规则"的时代。
       现在真正要守的是：包还在、判定方式一条不少，而规则库里那条规则确实没了。 */
    assert(
      (afterDelete.knowledgePacks.packs ?? []).some((pack) => pack.packId === packId),
      '自建包不随最后一条规则消失：它里面还有判定方式（判定方式也是包内容）',
    );
    assertEqual(
      (afterDelete.qcConditions ?? []).length,
      conditionsBefore,
      '删规则不动判定方式：这个包里的判定方式一条都不该少',
    );
  });

  await test('B57 规则库：自定义条件（条件树）能建成规则并真的跑起来；条件不合法当场拒', async () => {
    /* 这条钉住"判定条件可配"这件事真的通了，而不是界面上多了一块构造器：
       ① 拼出来的条件能存进包、能被引擎编译成可运行规则（不合法的一条都存不进去）；
       ② 目录把条件原样带回（编辑是"读回 → 改 → 写回"，少带一格，保存一次就把它静默清掉），
          并且**带一句人话**（服务端算好）—— 表里那一列不能显示 `[object Object]`；
       ③ 条件里的边界照内核那一套走：读不到数据的字段**不命中**（不是"命中"也不是"判不了"）。 */
    await adminLogin();
    const before = await state();
    const revBefore = (before.doc ?? {}).rev;

    /* 条件写错的四种，全部当场拒 —— 兜底会让"我配的条件没生效"变成没人能发现的事 */
    const badConditions: Array<[string, unknown]> = [
      ['完全没给条件', undefined],
      ['未知字段', { kind: 'atom', field: 'patientName', op: 'contains', value: ['x'] }],
      ['字段×算子不匹配', { kind: 'atom', field: 'docType', op: 'length-less-than', value: 3 }],
      ['取值不合法', { kind: 'atom', field: 'text', op: 'missing-pattern', value: 'phone' }],
    ];
    for (const [name, when] of badConditions) {
      const rejected = await post('/api/rule-item-create', {
        title: '自测自定义条件',
        severity: 'warn',
        predicate: { kind: 'field-condition', params: when === undefined ? {} : { when } },
      });
      assertEqual(rejected.ok, false, `${name}：应被拒`);
      assertEqual(String(rejected.code ?? ''), 'E_RULE_PARAM_INVALID', `${name}：错误码要说清是"参数不合法"`);
    }

    const created = await post('/api/rule-item-create', {
      title: '自测自定义条件（占位文字未替换）',
      severity: 'warn',
      predicate: {
        kind: 'field-condition',
        params: {
          when: {
            kind: 'all',
            children: [
              { kind: 'atom', field: 'nodeType', op: 'in', value: ['text'] },
              { kind: 'atom', field: 'text', op: 'contains', value: ['待补充', 'TODO'] },
            ],
          },
        },
      },
    });
    assertEqual(created.ok, true, `新建自定义条件规则应成功：${created.code ?? ''} ${created.message ?? ''}`);
    const createdData = created.data as { packId?: string; itemId?: string } | undefined;
    const packId = String(createdData?.packId ?? '');
    const itemId = String(createdData?.itemId ?? '');

    const after = await state();
    const mine = (after.knowledgePacks.rules ?? []).find((item) => item.itemId === itemId);
    assert(!!mine, '库里应看得见它');
    assertEqual(mine?.predicate, 'field-condition', '目录要带出判定方式');
    assertEqual(
      (mine?.params as { when?: unknown } | undefined)?.when,
      {
        kind: 'all',
        children: [
          { kind: 'atom', field: 'nodeType', op: 'in', value: ['text'] },
          { kind: 'atom', field: 'text', op: 'contains', value: ['待补充', 'TODO'] },
        ],
      },
      '条件必须原样带回（编辑抽屉要回显它；少带一格，保存一次就把它静默清掉）',
    );
    assertEqual(
      String((mine as unknown as { conditionSummary?: string })?.conditionSummary ?? ''),
      '节点类型 属于（任一） 「文本段」 且 段落正文 包含（任一） 「待补充、TODO」',
      '人话回读由服务端算好下发（表里那一列不能显示 [object Object]；枚举类的取值要用它的人话名）',
    );
    assertEqual((after.doc ?? {}).rev, revBefore, '新建规则不改病历一个字');

    assertEqual((await post('/api/knowledge-pack-toggle', { packId, itemId, enabled: true })).ok, true, '启用应成功');
    const onState = await state();
    assert(
      (onState.formRules ?? []).some((item) => item.id === itemId),
      '启用后它要真的进扫描清单 —— 这才是"判定条件可配"的落点，不只是界面上多了一块构造器',
    );
    const scan = await post('/api/qc-form-check', {});
    assertEqual(scan.ok, true, `质控应能跑：${scan.code ?? ''} ${scan.message ?? ''}`);

    assertEqual((await post('/api/rule-item-delete', { packId, itemId })).ok, true, '收尾：删掉这条自测规则');
  });

  await test('B58 条件库：具名条件可新建 / 改 / 删，被规则引用时删不掉（并指出是谁在用）', async () => {
    /* 具名条件是一份**被多条规则引用的资产**，这条钉住"改一处、引它的规则一起变"真的通了，
       以及它的代价被摆在明面上（四处）：
       ① 新建：编码由服务端按序号生成，条件树与名称 / 说明原样存下、原样带回
          （编辑是"读回 → 改 → 写回"，少带回一格，保存一次就把它静默清掉）；
       ② 引用面：规则引上它之后，目录里的 `usedBy` 立刻指出来 —— 界面在保存前显示的就是这一份；
       ③ 删除保护：被引用时拒绝，并说清是哪几条规则在用；
       ④ 改条件：引用它的规则跟着变，而不引它的那条一个字不动。 */
    await adminLogin();
    const before = await state();
    const conditionsBefore = (before.qcConditions ?? []).length;
    const revBefore = (before.doc ?? {}).rev;

    /* 不合法的条件树当场拒，且一个字都不入库（兜底会让"我配的条件没生效"变成没人能发现的事） */
    const bad = await post('/api/qc-condition-create', {
      name: '自测条件（不合法）',
      when: { kind: 'atom', field: 'text', op: 'missing-pattern', value: 'phone' },
    });
    assertEqual(bad.ok, false, '不合法的条件树要被拒');
    assertEqual((await state()).qcConditions.length, conditionsBefore, '被拒之后库里不应多出任何东西');

    const created = await post('/api/qc-condition-create', {
      name: '自测条件：正文含占位文字',
      description: '自测用（本用例收尾会删掉）',
      when: { kind: 'atom', field: 'text', op: 'contains', value: ['待补充'] },
    });
    assertEqual(created.ok, true, `新建条件应成功：${created.code ?? ''} ${created.message ?? ''}`);
    const createdData = created.data as { packId?: string; itemId?: string } | undefined;
    const packId = String(createdData?.packId ?? '');
    const conditionId = String(createdData?.itemId ?? '');
    assert(/^C-CUSTOM-\d+$/.test(conditionId), '编码由服务端按序号生成（形如 C-CUSTOM-1，不由界面填）');

    const afterCreate = await state();
    const mine = (afterCreate.qcConditions ?? []).find((item) => item.itemId === conditionId);
    assert(!!mine, '条件库里应看得见它');
    assertEqual(mine?.name, '自测条件：正文含占位文字', '名称要原样带回');
    assertEqual(mine?.description, '自测用（本用例收尾会删掉）', '说明要原样带回（编辑抽屉要回显它）');
    assertEqual(
      mine?.when,
      { kind: 'atom', field: 'text', op: 'contains', value: ['待补充'] },
      '条件树要原样带回（编辑是"读回 → 改 → 写回"，少带回一格，保存一次就把它静默清掉）',
    );
    assert(String(mine?.summary ?? '') !== '', '要带一句人话回读（表里那一列不能显示 [object Object]）');
    assertEqual((mine?.usedBy ?? []).length, 0, '刚建的条件还没有规则引用');
    assertEqual((afterCreate.doc ?? {}).rev, revBefore, '建条件不改病历一个字');

    /* 引它的规则：改一处会影响的就是这几条 */
    const rule = await post('/api/rule-item-create', {
      title: '自测：引用具名条件',
      severity: 'warn',
      predicate: { kind: 'field-condition', params: { conditionId } },
    });
    assertEqual(rule.ok, true, `引用具名条件的规则应能建：${rule.code ?? ''} ${rule.message ?? ''}`);
    const ruleData = rule.data as { packId?: string; itemId?: string } | undefined;
    const rulePackId = String(ruleData?.packId ?? '');
    const ruleItemId = String(ruleData?.itemId ?? '');

    const afterRef = await state();
    const used = (afterRef.qcConditions ?? []).find((item) => item.itemId === conditionId)?.usedBy ?? [];
    assertEqual(used.length, 1, '"谁在用它"要立刻反映出来（界面在保存前显示的就是这一份，与删除保护同源）');
    assertEqual(used[0]?.itemId, ruleItemId, '要指出是哪一条规则在用');
    const summaryAfterRef = String((afterRef.knowledgePacks.rules ?? []).find((item) => item.itemId === ruleItemId)?.conditionSummary ?? '');
    assert(
      summaryAfterRef.includes(conditionId)
      && summaryAfterRef.includes('段落正文 包含（任一） 「待补充」'),
      `引用条件的规则要能回读成人话，并带上条件编码（引用必须被解开，否则表里只有一个孤零零的编码）：实际「${summaryAfterRef}」`,
    );

    /* 删除保护：拒绝，并说清是谁在用（不让一次"删条件"悄悄决定一批规则的存亡） */
    const blocked = await post('/api/qc-condition-delete', { packId, itemId: conditionId });
    assertEqual(blocked.ok, false, '被规则引用的条件不许删');
    assertEqual(String(blocked.code ?? ''), 'E_RULE_CONDITION_IN_USE', '错误码要说清"还有人用"');
    assert(String(blocked.message ?? '').includes('自测：引用具名条件'), '拒绝时要点出引用它的那几条规则');

    /* 改条件：引用它的规则跟着变 —— 这正是具名条件的价值，也是它的代价 */
    const edited = await post('/api/qc-condition-update', {
      packId,
      itemId: conditionId,
      name: '自测条件：正文含占位文字（改过）',
      when: { kind: 'atom', field: 'text', op: 'contains', value: ['待补充', 'TODO'] },
    });
    assertEqual(edited.ok, true, `改条件应成功：${edited.code ?? ''} ${edited.message ?? ''}`);
    assertEqual(
      ((edited.data as { usedBy?: unknown[] } | undefined)?.usedBy ?? []).length,
      1,
      '回执里要带上影响面（事后只看"指纹变了"答不出"坏了哪几条规则"）',
    );
    const afterEdit = await state();
    const summaryAfterEdit = String((afterEdit.knowledgePacks.rules ?? []).find((item) => item.itemId === ruleItemId)?.conditionSummary ?? '');
    assert(
      summaryAfterEdit.includes('段落正文 包含（任一） 「待补充、TODO」'),
      `改一处、引它的规则一起变：实际「${summaryAfterEdit}」`,
    );

    /* 收尾：先删引用它的规则，再删条件 */
    assertEqual((await post('/api/rule-item-delete', { packId: rulePackId, itemId: ruleItemId })).ok, true, '收尾：删掉引用它的规则');
    const removed = await post('/api/qc-condition-delete', { packId, itemId: conditionId });
    assertEqual(removed.ok, true, `没人引用之后可以删：${removed.code ?? ''} ${removed.message ?? ''}`);
    assert(
      !(await state()).qcConditions.some((item) => item.itemId === conditionId),
      '删掉之后目录里不应再有它',
    );
  });

  await test('B59 判定方式的参数与实参：实参照参数表校验，改了实参判定结论就跟着变（出厂那几条也是包内容、也改得）', async () => {
    /* 这条钉住 T1 的**全部价值**：一条判定方式被多条规则以不同阈值复用。
       正例必须证明"实参真的生效"（不是被兜底吃掉），反例必须证明"填了不生效"会被当场拒。
       另外钉住交付形态：**判定方式一律是包内容** —— 出厂那 6 条在首次启动时写进自建包，
       此后与本院自己建的完全同级（可改、可删、被引用时拒删），不再有"只读"那一档。 */
    await adminLogin();
    /* 出厂种子写进自建包之后就是普通包内容：断言的正是它带 `packId` 且等于自建包 */
    const seeded = (await state()).qcConditions.find((item) => item.itemId === 'C-BUILTIN-MISSING-TIME') as
      | { itemId: string; name?: string; packId?: string; params?: unknown[]; summary?: string }
      | undefined;
    assert(!!seeded, '出厂种子判定方式要出现在目录里（首次启动时被写进自建包）');
    assertEqual(seeded?.packId, 'doc.rule.custom', '它落在**自建包**里：与本院自己建的那几条是同一份内容、同一条写路径');
    assert((seeded?.params ?? []).length >= 1, '判定方式要带参数表（否则规则里填不了阈值）');
    assert(
      String(seeded?.summary ?? '').includes('⟨minLength⟩'),
      `带参数的判定方式在没有实参时，回读要明写占位符而不是编一个数字：实际「${String(seeded?.summary ?? '')}」`,
    );
    /* 可改：改的就是包内容（内容指纹变、前后指纹进审计）—— 这正是"改为自建"的全部意义 */
    const renamed = await post('/api/qc-condition-update', {
      packId: seeded?.packId ?? '',
      itemId: 'C-BUILTIN-MISSING-TIME',
      name: '记录类段落缺记录时间（本院口径）',
    });
    assertEqual(renamed.ok, true, `判定方式应能就地改：${renamed.code ?? ''} ${renamed.message ?? ''}`);
    assertEqual(
      String((await state()).qcConditions.find((item) => item.itemId === 'C-BUILTIN-MISSING-TIME')?.name ?? ''),
      '记录类段落缺记录时间（本院口径）',
      '改完目录里就是新名字（不是"保存成功、读回来还是旧的"）',
    );
    /* 改回原样：它可能被别的用例引用，别把上下文改了 */
    const restoredSeed = await post('/api/qc-condition-update', {
      packId: seeded?.packId ?? '',
      itemId: 'C-BUILTIN-MISSING-TIME',
      name: String(seeded?.name ?? ''),
    });
    assertEqual(restoredSeed.ok, true, '名称应能改回原样');
    assertEqual(
      String((await state()).qcConditions.find((item) => item.itemId === 'C-BUILTIN-MISSING-TIME')?.name ?? ''),
      String(seeded?.name ?? ''),
      '改回原样要真的回到原值',
    );

    /* 带参数的判定方式：树里写 `$minLength`，规则里填实参 */
    const created = await post('/api/qc-condition-create', {
      name: '自测判定方式：段落少于 N 字',
      description: '自测用（本用例收尾会删掉）',
      params: [{ name: 'minLength', kind: 'integer', label: '最少字数', unit: '字', required: true, doc: '少于它就报。' }],
      when: { kind: 'atom', field: 'text', op: 'length-less-than', value: '$minLength' },
    });
    assertEqual(created.ok, true, `带参数的判定方式应能建：${created.code ?? ''} ${created.message ?? ''}`);
    const createdData = created.data as { packId?: string; itemId?: string } | undefined;
    const packId = String(createdData?.packId ?? '');
    const conditionId = String(createdData?.itemId ?? '');

    const mine = (await state()).qcConditions.find((item) => item.itemId === conditionId);
    assertEqual((mine?.params ?? []).length, 1, '参数表要原样带回（编辑抽屉要回显它）');
    assertEqual(mine?.params?.[0]?.name, 'minLength', '参数名原样带回');
    assertEqual(mine?.params?.[0]?.required, true, '必填位原样带回');

    /* 参数表与条件树对不上要拒：声明了没用到的参数 = 规则表单上多一个"填了也不生效"的格 */
    const unused = await post('/api/qc-condition-update', {
      packId,
      itemId: conditionId,
      params: [
        { name: 'minLength', kind: 'integer', label: '最少字数', required: true, doc: 'x' },
        { name: 'unusedOne', kind: 'string', label: '没用到', required: false, doc: 'x' },
      ],
    });
    assertEqual(unused.ok, false, '声明了却没在条件树里用到的参数要拒');
    assertEqual(String(unused.code ?? ''), 'E_RULE_CONDITION_PLACEHOLDER', '错误码要说清是"参数表与条件树对不上"');

    /* 两条规则、同一棵树、不同实参 —— 这就是"复用"的全部意义 */
    const loose = await post('/api/rule-item-create', {
      title: '自测：段落少于 5 字',
      severity: 'warn',
      predicate: { kind: 'field-condition', params: { conditionId, args: { minLength: 5 } } },
    });
    assertEqual(loose.ok, true, `引用带参数的判定方式应能建：${loose.code ?? ''} ${loose.message ?? ''}`);
    const strict = await post('/api/rule-item-create', {
      title: '自测：段落少于 2 字',
      severity: 'warn',
      predicate: { kind: 'field-condition', params: { conditionId, args: { minLength: 2 } } },
    });
    assertEqual(strict.ok, true, `同一条判定方式换个实参也应能建：${strict.code ?? ''} ${strict.message ?? ''}`);

    const rules = (await state()).knowledgePacks.rules ?? [];
    const looseSummary = String(rules.find((item) => item.itemId === String((loose.data as { itemId?: string })?.itemId ?? ''))?.conditionSummary ?? '');
    const strictSummary = String(rules.find((item) => item.itemId === String((strict.data as { itemId?: string })?.itemId ?? ''))?.conditionSummary ?? '');
    assert(
      looseSummary.includes('5') && strictSummary.includes('2') && looseSummary !== strictSummary,
      `两条规则的回读要显示**各自的实参**（界面看的是"这条规则实际按什么判"）：实际「${looseSummary}」/「${strictSummary}」`,
    );

    /* 反例：必填缺失 / 未知参数名 —— 一律当场拒（"我填的没生效"必须报在保存那一刻） */
    const missing = await post('/api/rule-item-create', {
      title: '自测：漏填实参',
      severity: 'warn',
      predicate: { kind: 'field-condition', params: { conditionId } },
    });
    assertEqual(missing.ok, false, '必填实参缺了要拒');
    assertEqual(String(missing.code ?? ''), 'E_RULE_CONDITION_PARAM_INVALID', '报"实参不合法"');
    const unknownArg = await post('/api/rule-item-create', {
      title: '自测：多填实参',
      severity: 'warn',
      predicate: { kind: 'field-condition', params: { conditionId, args: { minLength: 5, nope: 1 } } },
    });
    assertEqual(unknownArg.ok, false, '未知实参名要拒（多填一格意味着界面按另一份规格在填）');

    /* 收尾：先删两条规则，再删判定方式 */
    let after = await state();
    for (const itemId of [
      String((loose.data as { itemId?: string })?.itemId ?? ''),
      String((strict.data as { itemId?: string })?.itemId ?? ''),
    ]) {
      const rulePackId = String(after.knowledgePacks.rules?.find((item) => item.itemId === itemId)?.packId ?? '');
      assertEqual((await post('/api/rule-item-delete', { packId: rulePackId, itemId })).ok, true, `收尾：删掉规则 ${itemId}`);
    }
    assertEqual((await post('/api/qc-condition-delete', { packId, itemId: conditionId })).ok, true, '收尾：删掉判定方式');
    after = await state();
    assert(!after.qcConditions.some((item) => item.itemId === conditionId), '删掉之后目录里不应再有它');
  });

  await test('B60 算子插件：状态如实下发（没装就写"没装"，不是静默）', async () => {
    /* 插件是可执行的代码，装不上必须被看见 —— 它会表现成"规则没命中"，而界面上一切正常。
       这里只钉住"状态被如实下发"，装载本身由 `test:plugin` 在真实文件系统上验。 */
    const plugins = (await state()).qcPlugins;
    assert(!!plugins, '要下发算子插件的装载结果（界面据此回答"这台机器上为什么没有那个算子"）');
    assert(typeof plugins?.root === 'string' && plugins.root !== '', '要说清插件目录在哪（这份答案不能只躺在启动日志里）');
    assertEqual(Array.isArray(plugins?.loaded), true, '已装载的插件要是一个列表');
    assertEqual(Array.isArray(plugins?.failures), true, '装载失败的也要是一个列表（不静默跳过）');
  });

  await test('B61 沉默报告：AI 没写的那几段要说得出为什么（不是一句"暂无建议"）', async () => {
    await resetWorkspace();
    /* 未调用前必须是 `null` —— 不能与"调过、无跳过"同形：
       否则"没显示"就又同时意味着"没问题"与"没跑过"（这正是本仓库反复修的那个毛病） */
    assertEqual((await state()).aiSilence, null, '还没调过 AI 时应为 null');

    const before = await state();
    const texts = before.items.filter((item) => item.kind === 'text');
    assert(texts.length >= 3, `前置：应有至少三个正文段落，实际 ${texts.length}`);
    /* 把正文全部清空：医生新开一份文书、还没落笔时的样子。
       这些段落进了请求范围，却被上下文丢掉（空段没有可写的文本）——
       模型**根本不知道**有过它们，所以只能由内核说出来。 */
    for (const item of texts) {
      const cleared = await post('/api/edit', { nodeId: item.id, text: '  ' });
      assertEqual(cleared.ok, true, `清空段落应成功：${cleared.code ?? ''} ${cleared.message ?? ''}`);
    }

    const batch = await post('/api/suggest-batch', { mode: 'draft' });
    assertEqual(batch.ok, false, '一条都产不出时，这一次调用不该报成功');
    assertEqual(batch.code, 'E_AI_NO_SUGGESTION', '错误码要说清是"产出方没给建议"，而不是别的失败');

    const silence = (await state()).aiSilence;
    assert(!!silence, '一条都没产出时报告更要存在 —— 那正是最需要解释的情形');
    assertEqual(silence?.targets, 3, '范围是请求的三个目标（被上下文裁掉的也算在范围内）');
    assertEqual(silence?.produced, 0, '产出 0 条');
    assertEqual(silence?.skipped.length, 3, '三个目标都要有说法，一个都不能少');
    assertEqual(
      silence?.skipped.every((item) => item.code === 'empty-target'),
      true,
      `原因都应是"该段没有可写文本"，实际 ${JSON.stringify(silence?.skipped.map((item) => item.code))}`,
    );
    assertEqual(
      silence?.skipped.every((item) => item.source === 'kernel'),
      true,
      '这一档只有内核能说：产出方不可能自述它没见过的东西',
    );
    assert(
      silence?.skipped.every((item) => typeof item.label === 'string' && item.label !== '') === true,
      '档位的人话名应由服务端下发（界面不自己编一份，否则日志与界面迟早对不上）',
    );
    assertEqual(silence?.rejected.length, 0, '没有不合规的自述');
  });

/**
 * 正文各项各属于哪一章节。
 *
 * `items` 按**文档顺序**下发且**含章节节点**（`kind === 'section'`，带 `title`），
 * 所以扫一遍就能把每个段落归到它当时所在的那一章。
 *
 * 为什么用例要自己算一遍：服务端回的 `placement.items[].sectionTitle` 正是**被验对象**，
 * 断言若拿它自证就成了"服务端说什么就是什么"。这里从下发的正文顺序独立推出一份，
 * 两份对得上，才说明"那一段真的在那一章里"。
 */
function sectionTitlesOf(demo: DemoState): Record<string, string> {
  const titles: Record<string, string> = {};
  let current = '';
  for (const item of demo.items) {
    if (item.kind === 'section') current = item.title ?? '';
    else titles[item.id] = current;
  }
  return titles;
}

/**
 * 配一处即时结构化词表（每个用例自己配一次，不依赖前一条用例留下的状态）。
 *
 * 顺带把策略固定为"按章节词"：结构化的参与与否由**策略**决定（与落位共用同一个开关位），
 * 不固定的话，用例会在"改动了前一条用例的配置"这件事上互相影响。
 */
async function configureStructuring(structureMap: Record<string, DataElementTag>): Promise<void> {
  const saved = await post('/api/placement-config', {
    strategy: 'section-title',
    candidate: { onlyTextNodes: true },
    structureMap,
    confidenceCeiling: 0.85,
  });
  assertEqual(saved.ok, true, `前置：保存结构化词表应成功：${saved.code ?? ''} ${saved.message ?? ''}`);
}

/**
 * 从一段正文里取一个**必然命中**的规则词（前两个字）。
 *
 * 不把演示病历的内容写死在断言里：那样改一次演示数据就要顺着修一批用例，
 * 而"用例挂了却不知道这行该改什么"正是这套自测最该避免的成本。
 */
function ruleWordOf(item: DemoItem): string {
  const text = (item.text ?? '').trim();
  assert(text.length >= 2, `用例前提：这一段应有至少两个字的文本，实际：${JSON.stringify(text)}`);
  return text.slice(0, 2);
}

await test('B62 粘贴落位：默认策略不参与，但要说清"为什么没参与"', async () => {
  /* 默认策略是"按顺序"（`ordered`），它的语义是"转写段与候选段落一一对着放"，
     前提是段数 ≈ 候选数（医生在一份文书里连续口述）。粘贴不满足这个前提 ——
     往光标处粘两段，不该被散落到两个章节里。所以它**不参与**粘贴落位。
     这条用例钉的就是这个"不参与"，两件事都要成立：
       ① 落点原样留在光标处（内容不能自己跑 —— 医生刚粘的东西找不到是最伤信任的失败）；
       ② 必须给出一句人话说明（沉默的"没生效"会被医生读成"规则坏了"，而它其实是设计如此）。
     这一档最难自证的地方在于：不参与 = 与"没配规则"的结果一模一样，
     所以"说得出理由"不是修饰，而是这条链路上唯一能区分两者的东西。 */
  assertEqual((await resetWorkspace()).ok, true, '前置：复位工作区（B61 清空过全部正文）');
  assertEqual(
    (await post('/api/placement-config', {
      strategy: 'ordered',
      candidate: { onlyTextNodes: true },
      confidenceCeiling: 0.85,
    })).ok,
    true,
    '前置：把策略固定为默认的"按顺序"（本用例要验的就是它）',
  );
  const before = await state();
  assertEqual(before.placement?.strategy, 'ordered', '前置：此刻生效的策略应是"按顺序"');

  const anchor = before.items.find((item) => item.kind === 'text');
  assert(!!anchor, '用例前提：正文里应有文本段落');
  const anchorIndex = before.items.findIndex((item) => item.id === anchor!.id);
  const anchorTitle = sectionTitlesOf(before)[anchor!.id] ?? '';
  assert(anchorTitle !== '', '用例前提：锚点应处在某个章节里');

  const pasted = await post('/api/paste-text', {
    nodeId: anchor!.id,
    text: '第一段粘贴内容\n第二段粘贴内容',
  });
  assertEqual(pasted.ok, true, `粘贴应成功：${pasted.code ?? ''} ${pasted.message ?? ''}`);
  const placement = pasted.placement;
  assert(!!placement, '"按顺序"下同样要回一份落位结论 —— "不参与"不等于"没这回事"（否则界面无从解释）');
  assertEqual(placement?.enabled, false, '"按顺序"策略不参与粘贴落位');
  assertEqual(placement?.moved, 0, '一段都不该被挪走');
  assertEqual(placement?.items.length, 2, '粘了两段，就该有两段各自的说法');
  assertEqual(
    placement?.items.every((item) => item.sectionId === null && item.moved === false),
    true,
    '每一段的落点都应是"你粘贴的位置"，而不是被塞进某个章节',
  );
  assertEqual(
    placement?.items.every((item) => (item.reason ?? '').trim() !== ''),
    true,
    '每一段都要说得出理由（留空 = 又一次沉默）',
  );
  assertEqual((placement?.warnings ?? []).length > 0, true, '要有一句解释：为什么不参与');
  assert(
    String((placement?.warnings ?? []).join('')).includes('按顺序'),
    `说明要点出策略名（医生据此去管理后台改），实际：${JSON.stringify(placement?.warnings)}`,
  );

  /* 结构断言：不听落位结论自报，直接从正文顺序看那两段到底落在哪 */
  const pastedIds = pasted.data?.textNodeIds ?? [];
  assertEqual(pastedIds.length, 2, '两行应拆成两段');
  const after = await state();
  const afterTitles = sectionTitlesOf(after);
  assertEqual(
    after.items.findIndex((item) => item.id === pastedIds[0]),
    anchorIndex + 1,
    '未落位的第一段应紧跟在锚点之后（落点保持在光标位置）',
  );
  assertEqual(
    after.items.findIndex((item) => item.id === pastedIds[1]),
    anchorIndex + 2,
    '第二段同理：顺序不能被落位搅乱',
  );
  assertEqual(afterTitles[pastedIds[0]], anchorTitle, '新段落仍在锚点所在章节（没被挪到别处）');
  assertEqual(afterTitles[pastedIds[1]], anchorTitle, '两段都在锚点那一章');

  /* 界面契约：这一档必须"说得出原因"而不是静默。
     响应里的落位结论读**顶层** `r.placement`（与 `state` 同类：它描述"这次调用是怎么做的"），
     读成 `r.data.placement` 的话界面会永远拿不到它 —— 而那会表现成"功能没生效"。 */
  assert(/placementNote\(r\.placement\)/.test(script), '粘贴响应里的落位结论要喂给界面说明（读顶层 `r.placement`）');
  assert(/placement\.enabled !== true/.test(script), '"策略不参与"这一档必须说清原因：医生会以为规则坏了');
  assert(/placement\.warnings/.test(script), '那句话取自服务端下发的 warnings，而不是前端自己编一句');
});

await test('B63 粘贴落位：命中规则词就真的换章节，并回报依据', async () => {
  /* B62 证明"默认策略不越界"，这条证明"配了规则、命中之后真的动结构"：
     一段粘进来的文字被搬到**另一个章节**、**追加在那一章末尾**，而且说的清凭什么
     （命中哪个词、落到哪一章）。落位是猜的，"能当场自证"是它唯一能被信任的方式。
     断言分三层：结论字段（命中词 / 是否移动 / 章节名）→ 正文结构（独立推一遍两段各归哪章）
     → 界面契约（这三件事要在粘贴后那句话里说全）。 */
  assertEqual((await resetWorkspace()).ok, true, '前置：复位工作区');

  const before = await state();
  const titles = sectionTitlesOf(before);
  const anchor = before.items.find((item) => item.kind === 'text');
  assert(!!anchor, '用例前提：正文里应有文本段落');
  const anchorTitle = titles[anchor!.id] ?? '';
  assert(anchorTitle !== '', '用例前提：锚点应处在某个章节里（否则"换章节"无从谈起）');
  /* 规则表填的是**节点 id**（落位把它换算成"这个节点所在的章节"），所以目标章节里得有一个真实节点。
     挑"第一个不在锚点章节里的段落"：这样"命中之后有没有真的换章"一眼能分辨。 */
  const target = before.items.find((item) => item.kind === 'text' && item.id !== anchor!.id && titles[item.id] !== anchorTitle);
  assert(!!target, '用例前提：演示病历里应至少有两个章节的正文');
  const targetTitle = titles[target!.id] ?? '';
  assert(targetTitle !== '', '用例前提：目标段落应处在某个章节里');
  assert(targetTitle !== anchorTitle, '用例前提：目标章节必须与锚点章节不同（否则断言证明不了"挪走了"）');

  /* 规则词取正文里真会出现的词（"病史" → 现病史），而不是编一个不可能出现的词：
     后者通过的只是"没命中时不动"这条，证明不了命中路径。 */
  const keyword = '病史';
  assertEqual(
    (await post('/api/placement-config', {
      strategy: 'section-title',
      candidate: { onlyTextNodes: true },
      sectionMap: { [keyword]: target!.id },
      confidenceCeiling: 0.85,
    })).ok,
    true,
    '保存落位规则应成功（规则：文本里出现"病史"的段落落到目标章节）',
  );
  const savedView = await state();
  assertEqual(savedView.placement?.strategy, 'section-title', '策略应真的换成"按章节词"');
  assert(
    JSON.stringify(savedView.placement?.sectionMap ?? {}).includes(keyword),
    '规则表要能回读（界面靠它回显"这次按什么词判"，读不回来就等于配置没生效）',
  );

  const pasted = await post('/api/paste-text', {
    nodeId: anchor!.id,
    /* 第一行含规则词 → 应被挪走；第二行不含 → 应留在粘贴的位置 */
    text: '既往有高血压病史2年。\n建议复查血常规。',
  });
  assertEqual(pasted.ok, true, `粘贴应成功：${pasted.code ?? ''} ${pasted.message ?? ''}`);
  const placement = pasted.placement;
  assert(!!placement, '要回一份落位结论');
  assertEqual(placement?.enabled, true, '"按章节词"策略参与粘贴落位');
  assertEqual(placement?.moved, 1, '命中规则的那一段被挪走，没命中的那段留在原处（只挪一段）');

  const hit = placement?.items[0];
  assertEqual(hit?.matched, keyword, '要回报命中的是哪个词（医生据此判断这条规则该不该改）');
  assertEqual(hit?.moved, true, '"这一段动没动"由服务端判，不让界面从文案里猜');
  assertEqual(hit?.sectionTitle, targetTitle, `要落到目标章节：期望「${targetTitle}」`);
  assert(
    String(hit?.reason ?? '').includes(keyword),
    `理由要带上命中的词（"凭什么这么放"的答案），实际：${hit?.reason ?? ''}`,
  );
  const miss = placement?.items[1];
  assertEqual(miss?.matched, null, '没命中规则的那段如实报"没命中"，不假装猜到了');
  assertEqual(miss?.sectionId, null, '没命中的段落落在你粘贴的位置');
  assertEqual(miss?.moved, false, '没命中的那段不该被挪走');
  assertEqual(placement?.warnings.length, 1, '挪了别人粘的内容就要有一句提示（"落位是猜的，请核对"）');

  /* 结构断言：从正文顺序独立推一遍，验证这件事真的发生在文档结构里 */
  const pastedIds = pasted.data?.textNodeIds ?? [];
  assertEqual(pastedIds.length, 2, '两行应拆成两段');
  const after = await state();
  const afterTitles = sectionTitlesOf(after);
  assertEqual(afterTitles[pastedIds[0]], targetTitle, '被挪走的那一段应真的落在目标章节里');
  assertEqual(afterTitles[pastedIds[1]], anchorTitle, '没命中的那一段应仍留在锚点章节（没被牵连）');
  assertEqual(
    after.items.find((item) => item.id === pastedIds[0])?.paragraphLast,
    true,
    '追加在目标章节末尾 —— 落位只答得到章节粒度，"插在那一章的哪儿"它答不了，追加末尾是唯一不撒谎的选择',
  );
  assertEqual(
    after.items.findIndex((item) => item.id === pastedIds[1]),
    after.items.findIndex((item) => item.id === anchor!.id) + 1,
    '没命中的那一段应紧跟在锚点之后',
  );

  /* 界面契约：粘贴后那句话要把"哪几段被挪到了哪一章、凭什么"说全。
     这是"系统悄悄改了落点"唯一能被当场发现的地方。 */
  assert(/item\.moved === true/.test(script), '"哪几段真的被挪了"要读服务端给的 moved 字段，不从文案里猜');
  assert(
    /item\.sectionTitle/.test(script) && /item\.matched/.test(script) && /命中/.test(script),
    '要逐段列出去向：命中哪个词、落到哪一章',
  );
  assert(/落在你粘贴的位置/.test(script), '两边都要有话说：没被挪的那几段也要交代清楚');

  /* 复位：本用例改的是部署配置（不随工作区重置恢复，见 B「重置之后配置仍在」那条），
     跑完必须放回默认策略，否则后面的运行会带着"按章节词"的规则表跑 */
  assertEqual(
    (await post('/api/placement-config', {
      strategy: 'ordered',
      candidate: { onlyTextNodes: true },
      confidenceCeiling: 0.85,
    })).ok,
    true,
    '收尾：把落位策略放回默认的"按顺序"',
  );
});

await test('B64 即时结构化：没配词表时一条都不产，且说得出"词表为空"', async () => {
  /* "没标"有三种样子，这条钉住最容易被静默掉的一种：策略参与了、但词表没配。
     它与"没命中"长得一样（都是空列表），处置却完全不同 —— 一个是去管理后台配词表，
     一个是这段内容确实没有可结构化的东西。 */
  await resetWorkspace();
  assertEqual(
    (await post('/api/placement-config', {
      strategy: 'section-title',
      candidate: { onlyTextNodes: true },
      confidenceCeiling: 0.85,
    })).ok,
    true,
    '前置：策略为"按章节词"，且不填结构化词表',
  );
  const empty = await post('/api/structure-propose', {});
  assertEqual(empty.ok, true, `提议应成功：${empty.code ?? ''} ${empty.message ?? ''}`);
  assert(!!empty.structure, '要回一份结构化提议结果（不是空响应）');
  assertEqual(empty.structure?.enabled, true, '策略参与了（与"策略不参与"分开）');
  assertEqual(empty.structure?.proposed, 0, '没配词表 → 一条都不产');
  assertEqual((empty.structure?.items.length ?? 0) > 0, true, '逐段仍要有说法，不能给个空列表就完事');
  assertEqual(
    empty.structure?.warnings.some((item) => item.includes('词表为空')) === true,
    true,
    `要说清是"词表为空"，实际：${JSON.stringify(empty.structure?.warnings)}`,
  );

  assertEqual(
    (await post('/api/placement-config', { strategy: 'ordered', candidate: { onlyTextNodes: true }, confidenceCeiling: 0.85 })).ok,
    true,
    '前置：策略改回"按顺序"',
  );
  const disabled = await post('/api/structure-propose', {});
  assertEqual(disabled.structure?.enabled, false, '"按顺序"不参与结构化（它只管落点）');
  assertEqual(disabled.structure?.items.every((item) => item.tag === null), true, '不参与时不打标');
  assert(
    (disabled.structure?.warnings ?? []).join('').includes('按顺序'),
    `要指出是哪个策略不参与（医生据此去改配置），实际：${JSON.stringify(disabled.structure?.warnings)}`,
  );
});

await test('B65 即时结构化：提议 ≠ 落笔（未采纳前文档一个字节都不变）', async () => {
  /* 这条是整条链的信任基础：提议只是"看法"。若提议顺手把标签写进去，
     "机器猜的标签"就绕过了医生那道确认，而标签会进机读信息、被下游直接消费。 */
  await resetWorkspace();
  const before = await state();
  const target = before.items.find((item) => item.kind === 'text' && item.keyContent !== true && (item.text ?? '').trim().length >= 4);
  assert(!!target, '用例前提：正文里应有一段普通文本');
  const word = ruleWordOf(target!);
  await configureStructuring({ [word]: { system: 'local', code: 'LOCAL.SEGMENT.1', display: '段落数据元' } });

  const proposed = await post('/api/structure-propose', { nodeIds: [target!.id] });
  assertEqual(proposed.ok, true, `提议应成功：${proposed.code ?? ''} ${proposed.message ?? ''}`);
  const item = proposed.structure?.items[0];
  assertEqual(item?.matched, word, '命中词要如实回报');
  assertEqual(item?.tag?.code, 'LOCAL.SEGMENT.1', '提议要给出数据元');
  assertEqual(item?.nodeId, target!.id, '提议要带上它针对哪一段');
  assert((item?.confidence ?? 1) < 0.9, '置信度必须低于关键内容阈值（标签不能"确定到"可以自动落）');

  const after = await state();
  assertEqual(after.doc.rev, before.doc.rev, '提议不产生 rev ——"提议 ≠ 落笔"最直接的一条');
  assertEqual(after.machine.count, before.machine.count, '只提议不改文档：机读数据元不该变多');
  assertEqual(after.machine.stale, before.machine.stale, '机读信息的新鲜度也不该被提议改动');
  assertEqual((after.items.find((entry) => entry.id === target!.id)?.tags ?? []).length, 0, '未采纳前节点上不该有标签');
  assertEqual(
    after.log.some((entry) => String(entry.action ?? '').includes('绑定数据元')),
    false,
    '提议不该留下"绑定数据元"的留痕（留痕是给落笔那一步的）',
  );
});

await test('B66 即时结构化：采纳才落笔（标签生效 · 机读转陈旧 · 重算后进入数据元）', async () => {
  await resetWorkspace();
  const before = await state();
  const target = before.items.find((item) => item.kind === 'text' && item.keyContent !== true && (item.text ?? '').trim().length >= 4);
  assert(!!target, '用例前提：正文里应有一段普通文本');
  const word = ruleWordOf(target!);
  const tag: DataElementTag = { system: 'local', code: 'LOCAL.SEGMENT.2', display: '段落数据元' };
  await configureStructuring({ [word]: tag });

  const proposed = await post('/api/structure-propose', { nodeIds: [target!.id] });
  const hit = proposed.structure?.items[0];
  assertEqual(hit?.matched, word, '前置：该段应被提议');
  assertEqual((hit?.existingTags ?? []).length, 0, '前置：该段原本没有标签');

  const applied = await post('/api/structure-apply', { items: [{ nodeId: target!.id, tag: hit!.tag }] });
  assertEqual(applied.ok, true, `采纳应成功：${applied.code ?? ''} ${applied.message ?? ''}`);
  assertEqual(applied.data?.applied?.length, 1, '一条被绑上');
  assertEqual(applied.data?.skipped?.length, 0, '没有跳过');

  const after = await state();
  const node = after.items.find((entry) => entry.id === target!.id);
  assertEqual(node?.tags?.some((entry) => entry.code === tag.code) === true, true, '标签要真的落在节点上');
  assertEqual(node?.humanConfirmed, false, '机器动过的段落要回到"待确认"（人得再看一眼）');
  assertEqual(after.machine.stale, true, '打标改了内容 → 机读信息必须转陈旧（不能假装还新鲜）');
  assertEqual(
    after.log.some((entry) => String(entry.action ?? '').includes('绑定数据元')),
    true,
    '采纳要留痕（谁在什么时候给哪一段绑了哪条数据元）',
  );
  assertEqual(
    after.log.some((entry) => String(entry.action ?? '').includes('1 条')),
    true,
    '留痕要写清绑了几条（只写"绑定数据元"看不出做了多少事）',
  );

  const again = await post('/api/structure-apply', { items: [{ nodeId: target!.id, tag }] });
  assertEqual(again.data?.applied?.length, 0, '同一条不重复绑（点两次不该出两条一样的）');
  assertEqual(again.data?.skipped?.length, 1, '要如实报"跳过"');
  assert(
    (again.data?.skipped?.[0]?.reason ?? '').includes('已经有同一条'),
    `跳过要说清原因，实际：${again.data?.skipped?.[0]?.reason ?? ''}`,
  );

  const refreshed = await post('/api/refresh-machine', {});
  assertEqual(refreshed.ok, true, '重算应成功');
  const fresh = await state();
  assertEqual(fresh.machine.stale, false, '重算后不再陈旧');
  assert(
    fresh.machine.elements.some((element) => element.code === tag.code),
    `重算后该数据元要进入机读信息，实际：${JSON.stringify(fresh.machine.elements.map((element) => element.code))}`,
  );
});

await test('B67 即时结构化：机器绑的标签必须人再确认（关键内容上采纳会把门关上）', async () => {
  /* 这条钉住代价：标签会进机读信息、被导出与下游直接消费 ——
     所以"机器动过的内容必须由人再确认一次"。门控**不在提议层新造**，
     复用的就是既有的签章门控（关键内容未确认即拦）。 */
  await resetWorkspace();
  const before = await state();
  const keyNode = before.items.find((item) => item.kind === 'text' && item.keyContent === true && (item.text ?? '').trim().length >= 4);
  assert(!!keyNode, '用例前提：演示病历里应有一段标为关键内容的正文');
  const word = ruleWordOf(keyNode!);
  const tag: DataElementTag = { system: 'local', code: 'LOCAL.KEY.1', display: '关键数据元' };
  await configureStructuring({ [word]: tag });

  /* 前置：先把全文确认干净，这样后面"签不了"只可能是本次采纳造成的 */
  for (const item of (await state()).items.filter((entry) => entry.kind === 'text' || entry.kind === 'field')) {
    if (item.humanConfirmed === true) continue;
    assertEqual((await post('/api/confirm', { nodeId: item.id })).ok, true, `前置：确认 ${item.id}`);
  }
  assertEqual((await state()).items.find((entry) => entry.id === keyNode!.id)?.humanConfirmed, true, '前置：关键内容段已确认');

  const proposed = await post('/api/structure-propose', { nodeIds: [keyNode!.id] });
  const hit = proposed.structure?.items[0];
  assertEqual(hit?.matched, word, '前置：该段应被提议');
  assertEqual(hit?.keyContent, true, '提议要如实标注"这一段是关键内容"（界面据此提示代价）');

  const applied = await post('/api/structure-apply', { items: [{ nodeId: keyNode!.id, tag }] });
  assertEqual(applied.ok, true, '采纳本身允许（是医生点的），但门控要因此收紧');
  assertEqual(
    (await state()).items.find((entry) => entry.id === keyNode!.id)?.humanConfirmed,
    false,
    '采纳后该段回到"待确认"',
  );

  const blocked = await post('/api/sign', {});
  assertEqual(blocked.ok, false, '关键内容被机器动过且未再确认 → 必须签不了');
  assertEqual(
    blocked.code,
    'E_KEY_CONTENT_UNCONFIRMED',
    `拒的理由要指向"关键内容未确认"，实际 ${blocked.code ?? ''}：${blocked.message ?? ''}`,
  );

  assertEqual((await post('/api/confirm', { nodeId: keyNode!.id })).ok, true, '医生看完标签后再确认一次');
  const signed = await post('/api/sign', {});
  assertEqual(signed.ok, true, `再确认之后应能签章（这条路不能是死路）：${signed.code ?? ''} ${signed.message ?? ''}`);

  /* 收尾：复位工作区与策略（本用例改了部署参数，不随工作区重置恢复） */
  await resetWorkspace();
  assertEqual(
    (await post('/api/placement-config', { strategy: 'ordered', candidate: { onlyTextNodes: true }, confidenceCeiling: 0.85 })).ok,
    true,
    '收尾：把落位策略放回默认的"按顺序"',
  );
});

await test('B68 即时结构化：逐条采纳（只绑勾选的那一条，其余保持原样）', async () => {
  /* 界面上的"采纳所选"就是这一条：它**不是**"一键全绑"。若服务端按"整篇重算"落笔，
     医生明确没勾的那几条也会被绑上 —— 而勾选恰恰是他表达"这条我不接受"的唯一方式。 */
  await resetWorkspace();
  const before = await state();
  const texts = before.items.filter((item) => item.kind === 'text' && (item.text ?? '').trim().length >= 4);
  assert(texts.length >= 2, '用例前提：正文里应至少有两段可提议的文本');
  const first = texts[0]!;
  const second = texts[1]!;
  const tagA: DataElementTag = { system: 'local', code: 'LOCAL.PICK.A', display: '甲' };
  const tagB: DataElementTag = { system: 'local', code: 'LOCAL.PICK.B', display: '乙' };
  await configureStructuring({ [ruleWordOf(first)]: tagA, [ruleWordOf(second)]: tagB });

  const proposed = await post('/api/structure-propose', { nodeIds: [first.id, second.id] });
  assertEqual(proposed.structure?.items.length, 2, '限定两段就只算这两段');
  assertEqual(proposed.structure?.proposed, 2, '两段都该被提议（词表按段各配了一条）');

  const applied = await post('/api/structure-apply', { items: [{ nodeId: first.id, tag: tagA }] });
  assertEqual(applied.ok, true, `采纳应成功：${applied.code ?? ''} ${applied.message ?? ''}`);
  assertEqual(applied.data?.applied?.length, 1, '只落勾选的那一条');

  const after = await state();
  assertEqual(
    after.items.find((item) => item.id === first.id)?.tags?.some((entry) => entry.code === tagA.code) === true,
    true,
    '勾选的那一段要绑上',
  );
  assertEqual(
    (after.items.find((item) => item.id === second.id)?.tags ?? []).length,
    0,
    '没勾选的那一段不该被顺手绑上（"逐条确认"的最小含义）',
  );

  /* 收尾：把策略放回默认（本用例改了部署参数） */
  assertEqual(
    (await post('/api/placement-config', { strategy: 'ordered', candidate: { onlyTextNodes: true }, confidenceCeiling: 0.85 })).ok,
    true,
    '收尾：把落位策略放回默认的"按顺序"',
  );
});

await test('B70 机器绑的标签必须人确认：不受"我已通读"声明影响，确认该段即放行', async () => {
  /* 这条钉住"标签是元数据、不是内容"带来的处置差异：
     AI 写的**文字**可以靠一句"我已通读并认可"放行（那些内容医生看得见），
     机器标的**数据元**不行 —— 它在正文里看不见，却会被下游系统直接消费。
     所以它跟关键内容同档：永远拦；而解开它的动作是现成的（确认那一段）。 */
  await resetWorkspace();
  const before = await state();
  const target = before.items.find((item) => item.kind === 'text' && item.keyContent !== true && (item.text ?? '').trim().length >= 4);
  assert(!!target, '用例前提：正文里应有一段普通文本');
  const word = ruleWordOf(target!);
  const tag: DataElementTag = { system: 'local', code: 'LOCAL.STRICT.1', display: '普通数据元' };
  await configureStructuring({ [word]: tag });

  /* 前置：先把全文确认干净，这样后面"签不了"只可能是本次采纳造成的 */
  for (const item of before.items.filter((entry) => entry.kind === 'text' || entry.kind === 'field')) {
    if (item.humanConfirmed === true) continue;
    assertEqual((await post('/api/confirm', { nodeId: item.id })).ok, true, `前置：确认 ${item.id}`);
  }

  const proposed = await post('/api/structure-propose', { nodeIds: [target!.id] });
  const hit = proposed.structure?.items[0];
  assertEqual(hit?.matched, word, '前置：该段应被提议');
  const applied = await post('/api/structure-apply', { items: [{ nodeId: target!.id, tag: hit!.tag }] });
  assertEqual(applied.ok, true, `采纳应成功：${applied.code ?? ''} ${applied.message ?? ''}`);

  const after = await state();
  const node = after.items.find((entry) => entry.id === target!.id);
  assertEqual((node?.tags ?? []).some((entry) => entry.code === tag.code), true, '标签要生效（进机读信息）');
  assertEqual((node?.unconfirmedTags ?? []).length, 1, '同时记为"机器绑的、待确认"');
  assertEqual(node?.humanConfirmed, false, '内容也一并回到待确认');

  const blocked = await post('/api/sign', {});
  assertEqual(blocked.ok, false, '有未确认的机器标签 → 签不了');
  assertEqual(
    blocked.code,
    'E_TAG_UNCONFIRMED',
    `理由要指向未确认标签，实际 ${blocked.code ?? ''}：${blocked.message ?? ''}`,
  );

  /* **声明也不行**：这正是它与"AI 内容"那一档的区别 */
  const stillBlocked = await post('/api/sign', { acknowledgeUnconfirmed: true });
  assertEqual(stillBlocked.ok, false, '一句"我已通读并认可"放不过它 —— 标签不在正文里，医生看不见它');
  assertEqual(stillBlocked.code, 'E_TAG_UNCONFIRMED', '被拒的理由仍要指向未确认标签');

  assertEqual((await post('/api/confirm', { nodeId: target!.id })).ok, true, '确认这一段（连带认可它的标签）');
  const confirmedState = await state();
  assertEqual(
    (confirmedState.items.find((entry) => entry.id === target!.id)?.unconfirmedTags ?? []).length,
    0,
    '确认后待确认标记要消失（否则医生会卡在"确认了还是签不了"的死结里）',
  );
  assertEqual((await post('/api/sign', {})).ok, true, '确认之后应能签章（这条路不能是死路）');

  /* 收尾：复位工作区与策略（本用例改了部署参数，不随工作区重置恢复） */
  await resetWorkspace();
  assertEqual(
    (await post('/api/placement-config', { strategy: 'ordered', candidate: { onlyTextNodes: true }, confidenceCeiling: 0.85 })).ok,
    true,
    '收尾：把落位策略放回默认的"按顺序"',
  );
});

  await test('B72 流式落笔（/api/apply-edits）：一次动作一个撤销单元 · 外来内容照标 · AI 不得旁路 · 部分成功', async () => {
    /* 这条钉住自由流式编辑的**落笔契约**。流式与卡片最大的不同是：
       一次用户动作（拆段、合段、粘一整块）在模型里是好几次结构提交，
       所以真正要守的不是"某一次写对不对"，而是这三件事：
         ① 整批是**一个撤销单元** —— 否则"撤销"退成半个动作
            （拆段只退回了新段落，原段的尾巴还留在新段里，现场看是"撤销把内容搬走了"）；
         ② 没变就**整条不发** —— 否则点进点出都会留痕、都会触发"编辑即确认"；
         ③ 批量入口不能变成**绕过门控的旁路** —— AI 直写、关键内容禁删必须照样拦住。

       放在 B 块**最后**：本用例自己会 `resetWorkspace()` 换一份工作区，
       夹在别的用例中间会把它们的状态前置弄断（试过：插在 B26 与 B27 之间，B27 立刻报
       "前置：B26 结束时本文档已重新签章：期望 signed，实际 draft"）。
       用例之间不靠顺序，是这套自测明确写下的纪律（见 `resetWorkspace` 的说明）。 */
    await resetWorkspace();
    const start = await state();
    const anchor = start.items.find((item) => item.kind === 'text');
    assert(!!anchor, '用例前提：应有文本节点');
    const anchorId = anchor!.id;

    /* ① 拆段：改本段文本 + 新建一段，一批落笔 */
    const split = await post('/api/apply-edits', {
      ops: [
        { op: 'edit', nodeId: anchorId, text: '前半句' },
        { op: 'insert', afterNodeId: anchorId, text: '后半句' },
      ],
    });
    assertEqual(split.ok, true, `批量落笔应成功：${split.code ?? ''} ${split.message ?? ''}`);
    const created = ((split.data as { created?: Array<{ textNodeId: string }> }).created ?? []);
    assertEqual(created.length, 1, '应新建一段并回报它的 id（界面靠它把光标放回去）');
    const splitState = await state();
    assertEqual(splitState.items.find((item) => item.id === anchorId)?.text, '前半句', '本段应只留下前半句');
    assertEqual(splitState.items.find((item) => item.id === created[0].textNodeId)?.text, '后半句', '新段应拿到后半句');

    /* ② 撤销：整批一起退 —— 这是本用例真正要拦的失败（退一半比不退更糟） */
    const undo = await post('/api/undo', {});
    assertEqual(undo.ok, true, `撤销应成功：${undo.code ?? ''} ${undo.message ?? ''}`);
    const restored = await state();
    assertEqual(restored.items.find((item) => item.id === anchorId)?.text, anchor!.text, '撤销应把本段文本一起退回');
    assertEqual(
      restored.items.some((item) => item.id === created[0].textNodeId),
      false,
      '撤销应把新建的那段一并收回（一个撤销单元）',
    );

    /* ③ 没变就整条不发 */
    const revBeforeNoop = restored.doc.rev;
    const noop = await post('/api/apply-edits', { ops: [{ op: 'edit', nodeId: anchorId, text: anchor!.text }] });
    assertEqual(noop.ok, true, '空操作不应报错');
    assertEqual(
      ((noop.data as { skipped?: number }).skipped) ?? 0,
      1,
      '内容没变要如实回报"跳过"，而不是写一次留痕（更不该触发"编辑即确认"）',
    );
    assertEqual((await state()).doc.rev, revBeforeNoop, '没变就不该动 rev');

    /* ④ 外来内容：批量插入同样要标 imported 且待确认（与 /api/paste-text 同一口径） */
    const imported = await post('/api/apply-edits', {
      ops: [{ op: 'insert', afterNodeId: anchorId, text: '从别的系统粘来的一句', origin: 'imported' }],
    });
    const importedId = (((imported.data as { created?: Array<{ textNodeId: string }> }).created ?? [])[0]?.textNodeId) ?? '';
    const importedItem = (await state()).items.find((item) => item.id === importedId);
    assertEqual(importedItem?.origin, 'imported', '批量插入的外来内容必须标 imported');
    assertEqual(importedItem?.humanConfirmed, false, '外来内容必须待确认（搬运不等于核对）');

    /* ⑤ 原则 1：AI 不得经这个入口落笔 —— 多一个写入口就多一条要守的旁路 */
    const ai = await post('/api/apply-edits', {
      ops: [{ op: 'insert', afterNodeId: anchorId, text: 'AI 想直接写进去的一句', origin: 'ai' }],
    });
    const aiFailed = ((ai.data as { failed?: Array<{ code: string }> }).failed ?? []);
    assertEqual(aiFailed[0]?.code, 'E_AI_DIRECT_WRITE_FORBIDDEN', 'AI 内容必须被这条入口拒掉（只能走建议通道并由人采纳）');

    /* ⑥ 部分成功：一条被门控拒掉时，其余照常落笔并如实回报（不是全或无） */
    const keyItem = (await state()).items.find((item) => item.kind === 'text' && item.keyContent === true);
    assert(!!keyItem, '用例前提：演示病历里应有标为关键内容的段落');
    const partial = await post('/api/apply-edits', {
      ops: [
        { op: 'delete', nodeId: keyItem!.id },
        { op: 'edit', nodeId: anchorId, text: '这一句应该照常落笔' },
      ],
    });
    const partialFailed = ((partial.data as { failed?: unknown[] }).failed ?? []);
    assertEqual(partialFailed.length, 1, '被拒的那条要如实回报（否则"哪一句没删成"没有人知道）');
    assertEqual(
      (await state()).items.find((item) => item.id === anchorId)?.text,
      '这一句应该照常落笔',
      '被拒的一条不应连坐其余操作',
    );
    assertEqual((await state()).items.some((item) => item.id === keyItem!.id), true, '关键内容仍应原样在');

    /* ⑦ 乐观锁：带着过期 rev 的整批**一个字节都不落**（而不是落一半） */
    const revNow = (await state()).doc.rev;
    const stale = await post('/api/apply-edits', {
      expectedRev: revNow + 5,
      ops: [{ op: 'edit', nodeId: anchorId, text: '这条不该落笔' }],
    });
    assertEqual(stale.code, 'E_REV_CONFLICT', '带过期 rev 的落笔必须被拒（否则两个端会互相覆盖且没有痕迹）');
    assertEqual(
      (await state()).items.find((item) => item.id === anchorId)?.text,
      '这一句应该照常落笔',
      '被乐观锁拒掉时批里其它内容也不能落笔（整批一个判据）',
    );
    const freshRev = (await state()).doc.rev;
    const fresh = await post('/api/apply-edits', {
      expectedRev: freshRev,
      ops: [{ op: 'edit', nodeId: anchorId, text: '按最新版本落笔' }],
    });
    assertEqual(fresh.ok, true, `带上最新 rev 之后应能落笔：${fresh.code ?? ''} ${fresh.message ?? ''}`);
    assertEqual((await state()).doc.rev > freshRev, true, '落笔之后 rev 要往前走');
  });

  await test('B74 删除病历：只有草稿能删，删掉的病历不复活，活动指针与最后一份都有交代', async () => {
    /* 这条钉住删除草稿的四件事：
       ① 只删这一份：同患者其它病历一份都不动（删除是显式动作，不是"结构少传了一项"）；
       ② **结构行与正文行都真删了**：重启之后不复活 —— `saveStructure` 只增不删，
          漏掉 `deleteDocument` 的话这里会立刻"删完还在"；
       ③ 删掉活动病历时指针必须落到另一份：停在一份已被删除的空白上，下一个请求就 500；
       ④ 最后一份不删：整个服务有一批路径默认"总有一份活动病历"，清空走「重置工作区」。 */
    await resetWorkspace();
    const before = await state();
    const docs = allDocs(before);
    assertEqual(docs.length, 6, `前置：重置后应有 6 份病历，实际 ${docs.length}`);

    /* ① 删一份非活动的草稿 */
    const target = docs.find((doc) => doc.status === 'draft' && doc.docId !== before.activeDocId);
    assert(!!target, '前置：应有非活动的草稿');
    const docId = String(target!.docId);
    const removed = await post('/api/delete-document', { docId });
    assertEqual(removed.ok, true, `删除草稿应成功：${removed.code ?? ''} ${removed.message ?? ''}`);
    const after = await state();
    assertEqual(allDocs(after).some((doc) => doc.docId === docId), false, '树里不应再有它');
    assertEqual(after.activeDocId, before.activeDocId, '删的不是活动病历，活动病历不该变');
    assertEqual(allDocs(after).length, docs.length - 1, '只少一份，别的病历一份都不动');

    /* ② 重启后不复活 */
    await restartServer();
    assertEqual(
      allDocs(await state()).some((doc) => doc.docId === docId),
      false,
      '重启后被删的病历不该回来（结构行与正文行都必须在库里真删掉）',
    );

    /* ③ 再删同一份：明确报"不存在"，不是静默成功 */
    const again = await post('/api/delete-document', { docId });
    assertEqual(again.ok, false, '删不存在的病历要拒');
    assertEqual(again.code, 'E_DOC_NOT_FOUND', `错误码应为 E_DOC_NOT_FOUND，实际 ${again.code}`);

    /* ④ 删活动病历：指针必须落到另一份，且那一份读得出来 */
    const activeNow = String((await state()).activeDocId);
    assertEqual((await post('/api/delete-document', { docId: activeNow })).ok, true, '活动病历若是草稿也应能删');
    const moved = await state();
    assert(moved.activeDocId !== activeNow, '删掉活动病历后必须切到另一份');
    assertEqual(moved.doc.docId, moved.activeDocId, '/api/state 的 doc 必须就是新的活动病历');
    assertEqual(moved.doc.status, 'draft', '切过去的那份应能正常读出来');

    /* ⑤ 删到只剩一份：最后一份不许删 */
    for (let guard = 0; guard < 10; guard += 1) {
      const now = await state();
      const rest = allDocs(now);
      if (rest.length <= 1) break;
      const candidate = rest.find((doc) => doc.docId !== now.activeDocId) ?? rest[0]!;
      const dropped = await post('/api/delete-document', { docId: candidate.docId });
      assertEqual(dropped.ok, true, `删到只剩一份应一路成功：${dropped.code ?? ''} ${dropped.message ?? ''}`);
    }
    const lastOne = allDocs(await state());
    assertEqual(lastOne.length, 1, '应只剩一份');
    const refused = await post('/api/delete-document', { docId: lastOne[0]!.docId });
    assertEqual(refused.ok, false, '最后一份不能删');
    assertEqual(refused.code, 'E_DOC_LAST_ONE', `错误码应为 E_DOC_LAST_ONE，实际 ${refused.code}`);
  });

  await stopServer();
  if (signService) signService.close();
  if (asrService) asrService.close();
  if (captureClient) captureClient.kill();
  /* 收尾把自测状态目录与运行时目录整个清掉（前者含审计日志与锚点，后者含带密封口令的配置文件）：
     它们只在"这一轮跑的过程中"有意义，留着只会让隐私排查多出几条每次运行都会变的命中，
     以及一条永远"已失效"的复核记录（实测发现：排查因此变红，而红的原因与代码无关）。
     清理放在最后（前面所有用例都已经跑完）。
    清理**尽力而为、且失败绝不外抛**：它的结果不是这一轮的结论，而报告才是。
    （实测踩过：另一轮自测还占着状态目录时删不掉，`rmSync` 抛 EPERM，
    `process.exit(suite.report())` 于是执行不到 —— 屏幕上什么都没有，看起来像"整轮没跑"。） */
  const rmRecursive = rmSync as unknown as (path: string, options: { recursive: boolean; force: boolean }) => void;
  for (const dir of [stateDir, runtimeDir]) {
    if (!existsSync(dir)) continue;
    try {
      rmRecursive(dir, { recursive: true, force: true });
    } catch (err) {
      console.warn(`[收尾] 状态目录没清掉（不影响上面的用例结论）：${dir} —— ${(err as Error).message}`);
    }
  }
  /* B35 生成的审计报告（`doc_imported_*.audit.json/md`）同样要清：
     报告里带患者标识（合成手机号），而 `artifacts/` 下的审计报告不在 .gitignore 的忽略清单里，
     测试自己造的东西留在工作区，会让"仓库里到底有没有患者标识"这个问题永远答不清楚。
     生产使用中由后台按钮生成的报告当然要留下（那是产物），清掉的只是本轮自测造的这一批。 */
  const artifactsDir = join(ROOT, 'artifacts');
  if (existsSync(artifactsDir)) {
    const readdir = (await import('node:fs')).readdirSync as unknown as (path: string) => string[];
    for (const name of readdir(artifactsDir)) {
      if (name.startsWith('doc_imported_')) rmSync(join(artifactsDir, name), { force: true });
    }
  }
  process.exit(suite.report());
}

void main();
