// 发布前隐私与密钥排查（患者信息 / 私钥 / 证书）。
// 开源或交付前必须回答一个问题：仓库里有没有真实患者数据、生产私钥或证书？

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { demoKeyPair } from '../crypto/provider.ts';
import { utf8 } from '../crypto/sm3.ts';
import { DEMO_SIGNING_SEED } from '../core/session.ts';
import { maskPersonName, sha256Hex } from '../import/import-types.ts';
import { readZip } from '../import/zip-read.ts';

/* 从本文件位置推仓库根：`<root>/src/security/phi-scan.ts` → 三层 `..`（文件 → security → src → 根）。
   不依赖 cwd，于是从任何目录调用都会扫同一个仓库；三层写错时表现为"扫不到文件"而不是扫错地方。 */
const REPO = resolve(fileURLToPath(import.meta.url), '..', '..', '..');

const DEFAULT_ROOTS = ['articles', 'artifacts', 'docs', 'logs', 'schema', 'src', 'tools'];

const SKIP_DIRS = new Set(['node_modules', '.git', '.playwright-cli', '.codebuddy', '.vscode']);

/** 超过这个大小的文件不做文本规则匹配（只记一行"跳过"，不假装看过） */
const MAX_TEXT_BYTES = 8 * 1024 * 1024;

/**
 * 扫描器自身的规则表必然包含这些字样（否则它没法查），把它排除掉。
 *
 * 代价要说清：真把患者数据误加进这个文件就查不出来。
 * 所以它只应包含"规则与说明"，任何具体数据都不该写进来。
  */
const SCANNER_REL = 'src/security/phi-scan.ts';

/**
 * 演示环境惯用的虚构值 —— 只用于在报告里加标注，不做免检。
 * "我以为它是假的"正是漏检的起点：真实数据里出现"张三"的概率不为零。
  */
const FICTIONAL_NAMES = new Set(['张三', '李四', '王五', '赵六', '张三丰', '某某', '患者甲', '患者乙', '测试', '测试患者']);

/** 示例域名：同样只标注 */
const FICTIONAL_MAIL = /@(example\.(com|org|net)|test|localhost|[\w-]+\.local)$/i;

/**
 * 汉名里不会出现的字：命中它们说明抓到的是提示文案而不是姓名
 * （`患者：门诊号`、`姓名必须已脱敏` 这类措辞在自测标题与文档里到处都是）。
 * 按"宁可不报，不可误报"放过 —— 报告里每一条都得值得看，否则它就会被跳读。
  */
const NON_NAME_CHARS = /[号码别龄期址值科]/;

const KEY_FILE_EXT = new Set(['.pem', '.key', '.p12', '.pfx', '.jks', '.keystore', '.crt', '.cer']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);

export function keyFileVerdict(ext: string, bytes: number): { level: Level; detail: string } {
  if (bytes === 0) {
    return {
      level: 'review',
      detail: `${ext} 文件是**空的**（0 字节，不含任何材料）—— 通常是"清除密钥"留下的空壳；`
        + '若它本该有内容（比如刚设过密钥），说明落盘失败了，请查',
    };
  }
  return {
    level: 'must',
    detail: `仓库里存在 ${ext} 文件（${bytes} 字节）—— 内容不自动判定，必须人工确认它是不是生产密钥或证书`,
  };
}

/**
 * 四档结论。
 *
 * `reviewed` 是人已经复核过的那些：它仍然出现在报告里（连同复核理由与复核人），
 * 只是不再计入退出码 —— 一份永远为红的门禁等于没有门禁，而它的价值恰恰在于"新出现的能拦住"。
  */
type Level = 'must' | 'review' | 'reviewed' | 'public';

export interface Finding {
  level: Level;
  /** 规则名（用于分组计数） */
  rule: string;
  /** 位置：`相对路径:行号`，容器内为 `路径!条目` */
  where: string;
  /** 打码后的片段 + 判定依据（可以给人看）  */
  detail: string;
  fingerprint: string;
  /**
   * 未打码的原值，只用于白名单归因，绝不打印、绝不写入报告文件。
   *
   * 这是本脚本唯一一处同时持有明文的地方：既要在报告里打码，又要把"这把私钥推得出来吗"
   * 判成可断言的结论 —— 两件事必须分开对待，靠"打印时记得打码"是迟早会出错的。
    */
  secret?: string;
}

interface Unchecked {
  path: string;
  reason: string;
}

interface FileRef {
  rel: string;
  abs: string;
}

/** 手写扩展名提取：本项目对 node:path 的自有类型声明未覆盖 extname */
function extOf(name: string): string {
  const index = name.lastIndexOf('.');
  return index <= 0 ? '' : name.slice(index).toLowerCase();
}

function isText(bytes: Uint8Array): boolean {
  /* 前 8KB 里出现 NUL 就按二进制处理：文本文件不该有它 */
  const head = bytes.subarray(0, 8192);
  for (const byte of head) if (byte === 0) return false;
  return true;
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes);
}

/** 号码打码：留前 2 后 1，并给出位数（位数本身不是隐私，且是核对"是不是这一类"的关键） */
function maskDigits(value: string): string {
  const chars = [...value];
  if (chars.length <= 3) return `${'*'.repeat(chars.length)}（${chars.length} 位）`;
  return `${chars[0]}${chars[1]}${'*'.repeat(chars.length - 3)}${chars[chars.length - 1]}（${chars.length} 位）`;
}

/** 值打码：按形态分派 —— 号码走位数打码，姓名复用内核的脱敏（保留姓氏便于人工核对） */
function maskValue(value: string): string {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return maskDigits(trimmed);
  if (trimmed.includes('@')) {
    const [local = '', domain = ''] = trimmed.split('@');
    return `${local.slice(0, 1)}***@${domain}`;
  }
  if (/^[\u4e00-\u9fa5·]+$/.test(trimmed)) return maskPersonName(trimmed) ?? '**';
  const chars = [...trimmed];
  return `${chars.slice(0, 2).join('')}***（${chars.length} 字符）`;
}

interface Rule {
  name: string;
  level: Level;
  pattern: RegExp;
  /** 返回附加说明；返回 null 表示不报（用于"宁可不报"的保守判定） */
  detail?: (match: RegExpExecArray) => string | null;
  /** 需要拿去归因（比对白名单）的捕获组：给下标，不给就表示这条规则不需要原值 */
  secretGroup?: number;
}

const ID_CARD_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
const ID_CARD_CHECK = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2'];

function idCardDetail(value: string): string | null {
  const upper = value.toUpperCase();
  const birthday = upper.slice(6, 14);
  const year = Number(birthday.slice(0, 4));
  const month = Number(birthday.slice(4, 6));
  const day = Number(birthday.slice(6, 8));
  if (year < 1900 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) {
    return null; /* 生日段不是日期：多半是别的编号，按"宁可不报"放过 */
  }
  const sum = [...upper.slice(0, 17)].reduce((acc, char, index) => acc + Number(char) * (ID_CARD_WEIGHTS[index] as number), 0);
  const valid = ID_CARD_CHECK[sum % 11] === upper[17];
  return valid
    ? `身份证号 ${maskDigits(upper)}：**校验位通过**，必须人工确认它是不是真实号（或确系虚构）`
    : `形似身份证号 ${maskDigits(upper)}：校验位不通过（疑似虚构编号，仍需人工确认）`;
}

const RULES: Rule[] = [
  {
    name: '私钥 PEM 块',
    level: 'must',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY[A-Z ]*-----/g,
  },
  {
    name: '证书 PEM 块',
    level: 'must',
    pattern: /-----BEGIN CERTIFICATE-----/g,
  },
  {
    name: 'JSON 里的密钥字段',
    level: 'must',
    pattern: /"(?:privateKey|privateKeyHex|privKey|secretKey)"\s*:\s*"([0-9a-fA-F]{32,}|[A-Za-z0-9+/=]{40,})"/g,
    detail: (match) => `密钥字段 ${maskValue(match[1] as string)} —— 必须确认它是不是生产密钥（能推出演示私钥的会自动降级）`,
    secretGroup: 1,
  },
  {
    name: '身份证号',
    level: 'review',
    pattern: /(?<!\d)\d{17}[\dXx](?!\d)/g,
    detail: (match) => idCardDetail(match[0]),
  },
  {
    name: '手机号',
    level: 'review',
    pattern: /(?<!\d)1[3-9]\d{9}(?!\d)/g,
    detail: (match) => `手机号 ${maskDigits(match[0])}`,
  },
  {
    /*
     * 冒号是必需的（`[:：=]`，不是可选）。
     *
     * 试探过"允许无冒号"（`住院号 ZY001` 这种写法），结果立刻被误报淹没：
     * 代码注释里的「姓名/就诊号以外」「住址替换为等长假值」全被当成了数据 ——
     * 命中的是措辞不是数据。误报的代价不只是噪声：它会让人开始跳读这份报告，
     * 而这份报告的全部价值就在于"每一条都值得看"。代价认下来：无冒号的写法会被漏掉。
      */
    name: '带标签的身份信息',
    level: 'review',
    pattern:
      /(?:住院号|门诊号|病案号|就诊号|医保卡号|社保号|身份证号|证件号|联系电话|电话|手机号|手机|住址|家庭住址|联系地址|工作单位)\s*[:：=]\s*([A-Za-z0-9\u4e00-\u9fa5*·\-]{4,32})/g,
    detail: (match) => `${maskValue(match[1] as string)}（标签：${match[0].slice(0, 4)}…）`,
  },
  {
    name: '带标签的姓名',
    level: 'review',
    pattern: /(?:患者姓名|患者|姓名|联系人|监护人|家属|委托人)\s*[:：=]\s*([\u4e00-\u9fa5·]{2,6})/g,
    detail: (match) => {
      const name = match[1] as string;
      if (NON_NAME_CHARS.test(name)) return null;
      const masked = maskPersonName(name) ?? '**';
      return FICTIONAL_NAMES.has(name)
        ? `姓名 ${masked}（属演示常见虚构名，仍需人工确认只出现在演示数据里）`
        : `姓名 ${masked}`;
    },
  },
  {
    name: 'JSON 里的姓名 / 标签字段',
    level: 'review',
    pattern: /"(?:patientName|realName|doctorName|signerName|label)"\s*:\s*"([\u4e00-\u9fa5·]{2,12})[^"\n]*"/g,
    detail: (match) => `字段值 ${maskPersonName(match[1] as string) ?? '**'}（中文人名形态的字段值）`,
  },
  {
    name: '邮箱',
    level: 'review',
    pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    detail: (match) =>
      FICTIONAL_MAIL.test(match[0]) ? `${maskValue(match[0])}（示例域名，疑似虚构）` : maskValue(match[0]),
  },
  {
    // 硬编码口令 / 令牌：开源前最该查的一类（它不像私钥有 PEM 那种显眼形态）。
// 定为"需人工确认"而不是"必须处置"：自测夹具里本来就会写死口令（那是测试数据，不是密钥），

    name: '硬编码口令 / 令牌',
    level: 'review',
    pattern: /(?:passphrase|password|passwd|apiKey|api_key|accessToken|access_token|secretKey|token)\s*[:=]\s*['"`]([^'"`\n]{6,64})['"`]/gi,
    detail: (match) => `${maskValue(match[1] as string)}（自测夹具里的固定口令属正常，需逐条确认来源）`,
  },
];

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) if (text[i] === '\n') line += 1;
  return line;
}

/**
 * 命中指纹：只对"规则名 + 原值"取哈希。
 *
 * 刻意不含路径与行号 —— 复核记录不该因为"文件挪了目录"或"上面加了一行注释"就失效：
 * 那种失效会训练人直接重跑一遍复核，而复核的全部意义就是"这一条我看过了"。
 * 同一段合成数据出现在多个自测文件里，指纹也只有一个，复核记录因此很紧凑。
  */
export function fingerprintOf(rule: string, rawValue: string): string {
  return sha256Hex(utf8(`${rule}\u0000${rawValue}`)).slice(0, 16);
}

export function scanText(text: string, where: string, into: Finding[]): void {
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    let match = rule.pattern.exec(text);
    while (match !== null) {
      const detail = rule.detail ? rule.detail(match) : maskValue(match[0]);
      if (detail !== null) {
        const finding: Finding = {
          level: rule.level,
          rule: rule.name,
          where: `${where}:${lineOf(text, match.index)}`,
          detail,
          fingerprint: fingerprintOf(rule.name, match[0]),
        };
        if (rule.secretGroup !== undefined) finding.secret = match[rule.secretGroup];
        into.push(finding);
      }
      if (match.index === rule.pattern.lastIndex) rule.pattern.lastIndex += 1;
      match = rule.pattern.exec(text);
    }
  }
}

/**
 * 收集代码里公开字面量的演示种子。
 *
 * 判据很硬：种子就写在源码里（`demoKeyPair('xxx')` / `DEMO_SIGNING_SEED`），
 * 任何人 clone 下来都能推出同一把私钥 —— 所以它构造上就不可能保密，
 * 发现它不构成泄漏。反过来，推不出来的私钥一律按"必须处置"处理，不做任何猜测。
  */
function collectDemoSeeds(texts: Map<string, string>): string[] {
  const seeds = new Set<string>([DEMO_SIGNING_SEED]);
  const pattern = /demoKeyPair\(\s*'([^']+)'/g;
  for (const [rel, text] of texts) {
    if (rel === SCANNER_REL) continue;
    pattern.lastIndex = 0;
    let match = pattern.exec(text);
    while (match !== null) {
      seeds.add(match[1] as string);
      match = pattern.exec(text);
    }
  }
  return [...seeds].sort();
}

export function demoPrivateHexes(seeds: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const seed of seeds) {
    const hex = demoKeyPair(seed).privateKey.toString(16).padStart(64, '0');
    out.set(hex, seed);
  }
  return out;
}

function collect(relRoot: string, out: FileRef[]): void {
  const abs = resolve(REPO, relRoot);
  if (!existsSync(abs)) return;
  if (!statSync(abs).isDirectory()) {
    out.push({ rel: relRoot, abs });
    return;
  }
  for (const name of readdirSync(abs).sort()) {
    if (name.startsWith('.') || SKIP_DIRS.has(name)) continue;
    const childRel = `${relRoot}/${name}`;
    const childAbs = join(abs, name);
    if (statSync(childAbs).isDirectory()) collect(childRel, out);
    else out.push({ rel: childRel, abs: childAbs });
  }
}

const REVIEW_FILE = 'phi-scan.reviewed.json';

export interface ReviewEntry {
  fingerprint: string;
  /** 复核时的位置与规则，仅供人读 */
  where?: string;
  rule?: string;
  note: string;
  reviewedBy: string;
  reviewedAt: string;
}

export function loadReview(): ReviewEntry[] {
  const path = resolve(REPO, REVIEW_FILE);
  if (!existsSync(path)) return [];
  const parsed = JSON.parse(readFileSync(path, 'utf8') as unknown as string) as { reviewed?: ReviewEntry[] };
  return parsed.reviewed ?? [];
}

/**
 * 应用复核记录：命中的降级为 `reviewed` 并附上理由；返回已失效的记录
 * （清单里记着、仓库里却已无对应命中 —— 内容被删或改过了，记录该清理，否则它会悄悄烂掉）。
  */
export function applyReview(findings: Finding[], entries: ReviewEntry[]): ReviewEntry[] {
  const byFingerprint = new Map(entries.map((entry) => [entry.fingerprint, entry]));
  const used = new Set<string>();
  for (const finding of findings) {
    const entry = byFingerprint.get(finding.fingerprint);
    if (!entry || finding.level === 'public') continue;
    finding.level = 'reviewed';
    finding.detail = `${finding.detail}｜已复核：${entry.note}（${entry.reviewedBy} ${entry.reviewedAt}）`;
    used.add(entry.fingerprint);
  }
  return entries.filter((entry) => !used.has(entry.fingerprint));
}

/**
 * 私钥归因：能由公开种子推导的降级为"已知可公开"，其余留作"必须处置"并返回位置清单。
 *
 * 单独成一个函数不是为了好看：这是全脚本唯一一处会把告警降级的地方 ——
 * 降级错了就等于亲手放过一把真私钥，所以它必须能被用例守住（见 P5）。
  */
export function attributeKnownKeys(findings: Finding[], known: Map<string, string>): string[] {
  const unknownKeys: string[] = [];
  for (const finding of findings) {
    if (finding.secret === undefined) continue;
    /* 十六进制大小写不敏感：私钥可能被写成大写 */
    const hex = [...known.keys()].find((item) => item.toLowerCase() === finding.secret?.toLowerCase());
    if (hex) {
      finding.level = 'public';
      finding.detail = `演示私钥（可由公开种子 '${known.get(hex)}' 推导，故不构成泄漏）`;
    } else {
      unknownKeys.push(finding.where);
    }
  }
  return unknownKeys;
}

interface ScanOutput {
  scannedAt: string;
  roots: string[];
  counts: Record<string, number>;
  findings: Finding[];
  unchecked: Unchecked[];
  unknownKeys: string[];
  /** 复核记录里已无对应命中的条目（内容删了或改过了） */
  staleReviews: ReviewEntry[];
  release: string[];
  demoSeeds: string[];
}

function main(): void {
  const args = process.argv.slice(2);
  const rootsArg = args.find((item) => item.startsWith('--roots'));
  const roots = rootsArg
    ? (args[args.indexOf(rootsArg) + 1] ?? '').split(',').map((item) => item.trim()).filter((item) => item !== '')
    : DEFAULT_ROOTS;
  const jsonIndex = args.indexOf('--json');
  const jsonPath = jsonIndex >= 0 ? args[jsonIndex + 1] : undefined;
  /* 打印命中指纹：写复核记录时要用（指纹是哈希，不落明文，可以随手贴进 issue 或提交记录） */
  const showFingerprints = args.includes('--fingerprints');

  const files: FileRef[] = [];
  for (const root of roots) collect(root, files);
  /* 仓库根下的散文件（package.json / 各 md）同样要看 —— 泄漏不挑目录 */
  for (const name of readdirSync(REPO).sort()) {
    if (name.startsWith('.') || SKIP_DIRS.has(name)) continue;
    const abs = join(REPO, name);
    if (!statSync(abs).isDirectory()) files.push({ rel: name, abs });
  }

  if (files.length === 0) {
    console.log(`没有可扫描的文件（扫描根：${roots.join(', ')}）`);
    process.exit(1);
  }

  /* 第一遍：读进内存（仓库很小），顺便收集演示种子 */
  const texts = new Map<string, string>();
  const blobs = new Map<string, Uint8Array>();
  const findings: Finding[] = [];
  const unchecked: Unchecked[] = [];
  let skippedLarge = 0;

  for (const file of files) {
    if (file.rel === SCANNER_REL) continue;
    if (jsonPath && resolve(REPO, file.rel) === resolve(REPO, jsonPath)) continue; /* 不扫自己刚写的报告 */
    const bytes = readFileSync(file.abs) as unknown as Uint8Array;
    const ext = extOf(file.rel);

    if (KEY_FILE_EXT.has(ext)) {
      const verdict = keyFileVerdict(ext, bytes.length);
      findings.push({
        level: verdict.level,
        rule: '密钥 / 证书文件',
        where: file.rel,
        detail: verdict.detail,
        /* 这条没有"命中值"，用路径做指纹：文件一旦改名或删除，复核记录会如实失效而不是悄悄继续生效 */
        fingerprint: fingerprintOf('密钥 / 证书文件', file.rel),
      });
    }

    if (ext === '.ofd') {
      blobs.set(file.rel, bytes);
      continue;
    }
    if (ext === '.l0enc') {
      unchecked.push({ path: file.rel, reason: '加密产物：口令未落盘，内容读不了（这正是它该有的性质，但仍属"未检查"）' });
      continue;
    }
    if (IMAGE_EXT.has(ext)) {
      unchecked.push({
        path: file.rel,
        reason: '图像：脚本查不了像素内容。界面截图可能显示患者姓名与正文，必须人工看一遍',
      });
      continue;
    }
    if (!isText(bytes)) {
      unchecked.push({ path: file.rel, reason: '二进制：非文本格式，未做内容检查' });
      continue;
    }
    if (bytes.length > MAX_TEXT_BYTES) {
      skippedLarge += 1;
      unchecked.push({ path: file.rel, reason: `超过 ${MAX_TEXT_BYTES} 字节，未做文本规则匹配` });
      continue;
    }
    const text = decode(bytes);
    texts.set(file.rel, text);
    scanText(text, file.rel, findings);
  }

  /* 第二遍：OFD 容器解包后扫 —— 纯文本扫描对 ZIP 会给出假清白。
     这里同时统计"解出了多少条目、其中多少按文本扫过"：覆盖范围必须是看得见的数字，
     否则"解包后没报问题"和"根本没解出东西"在报告上长得一模一样，正是假清白的来源。  */
  let containerEntries = 0;
  let containerTexts = 0;
  for (const [rel, bytes] of blobs) {
    try {
      const entries = readZip(bytes);
      containerEntries += entries.length;
      for (const entry of entries) {
        if (!isText(entry.data)) continue;
        containerTexts += 1;
        scanText(decode(entry.data), `${rel}!${entry.path}`, findings);
      }
      if (entries.length === 0) unchecked.push({ path: rel, reason: '容器里没有任何条目（空包）' });
    } catch (err) {
      unchecked.push({ path: rel, reason: `容器解包失败，未检查内容：${(err as Error).message}` });
    }
  }

  /* 演示密钥归因：命中白名单的降级为"已知可公开"，其余保持"必须处置" */
  const seeds = collectDemoSeeds(texts);
  const known = demoPrivateHexes(seeds);
  const unknownKeys = attributeKnownKeys(findings, known);
  /* 复核记录在归因之后应用：演示私钥已降级为"已知可公开"，不该被复核记录再盖一层  */
  const staleReview = applyReview(findings, loadReview());

  const must = findings.filter((item) => item.level === 'must');
  const review = findings.filter((item) => item.level === 'review');
  const reviewedOnes = findings.filter((item) => item.level === 'reviewed');
  const publicOnes = findings.filter((item) => item.level === 'public');

  const release = releaseState(roots);

  console.log('发布前隐私与密钥排查（模式匹配，不是合规审计）');
  console.log(`仓库根：${REPO}`);
  console.log(`扫描根：${roots.join(', ')}\n`);
  console.log(
    `文件 ${files.length} 个 | 文本已扫 ${texts.size} | OFD 容器 ${blobs.size} 个（条目 ${containerEntries}，` +
      `其中文本已扫 ${containerTexts}） | 未检查 ${unchecked.length}` +
      (skippedLarge > 0 ? ` | 超大跳过 ${skippedLarge}` : ''),
  );

  console.log(`\n⛔ 必须处置（${must.length}）`);
  if (must.length === 0) console.log('   无');
  for (const item of must) console.log(`   · [${item.rule}] ${item.where}\n     ${item.detail}`);

  console.log(`\n⚠️ 需人工确认（${review.length}）`);
  if (review.length === 0) console.log('   无');
  const grouped = new Map<string, Finding[]>();
  for (const item of review) {
    const list = grouped.get(item.rule) ?? [];
    list.push(item);
    grouped.set(item.rule, list);
  }
  for (const [rule, items] of [...grouped].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`   · ${rule}：${items.length} 处`);
    for (const item of items.slice(0, 8)) {
      console.log(`       ${item.where} → ${item.detail}${showFingerprints ? ` [fp:${item.fingerprint}]` : ''}`);
    }
    if (items.length > 8) console.log(`       …另有 ${items.length - 8} 处（见 --json 报告）`);
  }

  console.log(`\n✓ 已复核（${reviewedOnes.length} 处命中；不计入退出码，但仍在报告里）`);
  if (reviewedOnes.length === 0) console.log('   无');
  /* 按"规则 + 理由"合并：同一个合成号可能出现在 7 个文件里，逐行打印会把报告尾巴变成噪声，
     而噪声的代价是整份报告被跳读。合并后每个理由只出现一次，并列出命中位置（逐条清单见 --json）。 */
  const byReason = new Map<string, Finding[]>();
  for (const item of reviewedOnes) {
    const key = `${item.rule}\u0000${item.detail}`;
    byReason.set(key, [...(byReason.get(key) ?? []), item]);
  }
  for (const [key, items] of byReason) {
    const [rule = '', detail = ''] = key.split('\u0000');
    const sites = items.map((item) => item.where).join('、');
    console.log(`   · [${rule}] ${items.length} 处 → ${sites.length > 100 ? `${sites.slice(0, 100)}…` : sites}`);
    console.log(`     ${detail}`);
  }
  if (staleReview.length > 0) {
    console.log(`   ⚠️ 复核记录已失效 ${staleReview.length} 条（记录里还写着，仓库里已无对应命中 —— 内容删了或改了，记录该清理）：`);
    for (const entry of staleReview) console.log(`       ${entry.where ?? entry.fingerprint}：${entry.note}`);
  }

  console.log(`\n○ 已知可公开（${publicOnes.length}）`);
  console.log(`   白名单私钥 ${known.size} 把（种子写明在源码里，任何人可推导）：`);
  console.log(`     ${seeds.slice(0, 8).map((seed) => `'${seed}'`).join('、')}${seeds.length > 8 ? ` …另有 ${seeds.length - 8} 个` : ''}`);
  console.log(`   仓库中命中白名单并已归因：${publicOnes.length} 处`);
  if (unknownKeys.length > 0) console.log(`   ⚠️ 另有 ${unknownKeys.length} 处私钥**不在**白名单内：${unknownKeys.join('、')}`);

  console.log(`\n未检查（必须由人看，脚本不假装看过）（${unchecked.length}）`);
  if (unchecked.length === 0) console.log('   无');
  for (const item of unchecked) console.log(`   · ${item.path}\n     ${item.reason}`);

  console.log('\n发布态（不计入退出码）');
  for (const line of release) console.log(`   · ${line}`);

  console.log('\n判读提示：');
  console.log('  · 「需人工确认」里每一条都要**回到源头看一眼**：虚构数据就把它坐实为演示数据');
  console.log('    （用 `--fingerprints` 取指纹，写进 phi-scan.reviewed.json，并写清理由与复核人）；');
  console.log('    真数据则必须删除并追查它怎么进来的（同时检查备份与历史快照）；');
  console.log('  · 「已复核」不是"没问题"，而是"有人看过并留下了理由"—— 它仍然逐条列在上面，');
  console.log('    新出现的命中不会自动获得这个身份（这正是退出码能变绿、又拦得住新东西的原因）；');
  console.log('  · 「已知可公开」只保证"这把私钥推得出来"，不保证"用它签的东西可以公开"；');
  console.log('  · 「未检查」是这份报告的边界：**没查 ≠ 干净**。图像与加密产物要靠人工。');

  if (jsonPath) {
    const output: ScanOutput = {
      scannedAt: new Date().toISOString(),
      roots,
      counts: {
        files: files.length,
        texts: texts.size,
        containers: blobs.size,
        containerEntries,
        containerTexts,
        unchecked: unchecked.length,
        must: must.length,
        review: review.length,
        reviewed: reviewedOnes.length,
        reviewStale: staleReview.length,
        publicKnown: publicOnes.length,
      },
      findings,
      unchecked,
      unknownKeys,
      staleReviews: staleReview,
      release,
      demoSeeds: seeds,
    };
    writeFileSync(resolve(REPO, jsonPath), `${JSON.stringify(output, null, 2)}\n`, 'utf8');
    console.log(`\n报告已写入：${jsonPath}`);
  }

  process.exit(must.length + review.length > 0 ? 1 : 0);
}

/**
 * 发布态检查：这些是"能不能公开"的另一半（文章发布备注里已列过）。
 *
 * 它们不计入退出码 —— 缺 LICENSE 与"仓库里有生产私钥"是两类事：
 * 前者是流程进度，后者必须立刻处置。混在一个门禁里，结果就是这个检查天天红、然后就没人看了。
  */
function releaseState(_roots: string[]): string[] {
  const lines: string[] = [];
  if (existsSync(resolve(REPO, 'LICENSE'))) lines.push('LICENSE：已存在');
  else lines.push('LICENSE：**缺失** —— 未定协议前不得对外发布');

  if (existsSync(resolve(REPO, 'README.md'))) lines.push('README.md：已存在');
  else lines.push('README.md：**缺失**');

  const pkg = JSON.parse(readFileSync(resolve(REPO, 'package.json'), 'utf8')) as { private?: boolean; version?: string };
  lines.push(
    pkg.private === true
      ? 'package.json：`private: true` —— 本仓库是**应用**（分发靠 git，不靠 npm），保持它能防止误 `npm publish`；'
        + '若将来要作为**库**发布到 npm 才需要改掉'
      : 'package.json：`private` 已置为可发布（前提是它确实要作为库发到 npm）',
  );

  const ignorePath = resolve(REPO, '.gitignore');
  if (!existsSync(ignorePath)) {
    lines.push(
      '.gitignore：**缺失** —— 此刻 `git init && git add .` 会把 `artifacts/state/`（快照 salt 与密文）' +
        `与 \`logs/\`（运行日志可能含正文）**一起入库**。这是本报告里最该先修的一条。`,
    );
    return lines;
  }

  /* 判据是具体风险路径，不是"整个扫描根被忽略"。
     两者的区别很实际：`.gitignore` 若一刀切忽略整个 `artifacts/`，
     `verify:ofd` / `test:wst500` / `scan:external` 在全新 clone 上会直接失败 ——
     那是假干净。所以这里只要求真正危险的那几处被挡住。  */
  const risky: Array<{ path: string; why: string }> = [
    { path: 'artifacts/state', why: '快照 salt 与密文同时在库，等于给离线爆破留一份样本' },
    { path: 'artifacts/state-selftest', why: '同上（自测状态目录）' },
    { path: 'logs', why: '运行日志可能含正文片段' },
    { path: 'artifacts/recipient-keys.json', why: '运行期生成的接收方公钥目录（Demo 会重建）' },
  ];
  const text = readFileSync(ignorePath, 'utf8');
  const uncovered = risky.filter((item) => !isIgnored(text, item.path));
  lines.push(
    uncovered.length === 0
      ? `.gitignore：风险路径已全部覆盖（${risky.map((item) => item.path).join('、')}）`
      : `.gitignore：**未覆盖** ${uncovered.map((item) => `${item.path}（${item.why}）`).join('；')}`,
  );
  return lines;
}

/** 判断某路径是否被 .gitignore 覆盖：命中自身、或命中它的任一层父目录都算 */
export function isIgnored(ignoreText: string, path: string): boolean {
  for (const raw of ignoreText.split('\n')) {
    const line = raw.trim().replace(/^\//, '').replace(/\/$/, '');
    if (line === '' || line.startsWith('#') || line.startsWith('!')) continue;
    if (line === path || path.startsWith(`${line}/`)) return true;
  }
  return false;
}

/* 直接运行才执行扫描：本模块被自测 import 时不能跑（那会在自测里把整个仓库再扫一遍）。
   判据用文件名而不是"是否被 import"，因为自测文件名（phi-scan-self-test.ts）不以 phi-scan.ts 结尾。 */
const invokedAs = process.argv[1] ?? '';
if (invokedAs.endsWith('phi-scan.ts')) main();
