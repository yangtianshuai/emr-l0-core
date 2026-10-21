import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { demoKeyPair } from '../crypto/provider.ts';
import { utf8 } from '../crypto/sm3.ts';
import { DEMO_SIGNING_SEED } from '../core/session.ts';
import { maskPersonName, sha256Hex } from '../import/import-types.ts';
import { readZip } from '../import/zip-read.ts';

const REPO = resolve(fileURLToPath(import.meta.url), '..', '..', '..');

const DEFAULT_ROOTS = ['articles', 'artifacts', 'docs', 'logs', 'schema', 'src', 'tools'];

const SKIP_DIRS = new Set(['node_modules', '.git', '.playwright-cli', '.codebuddy', '.vscode']);

const MAX_TEXT_BYTES = 8 * 1024 * 1024;

const SCANNER_REL = 'src/security/phi-scan.ts';

const FICTIONAL_NAMES = new Set(['张三', '李四', '王五', '赵六', '张三丰', '某某', '患者甲', '患者乙', '测试', '测试患者']);

const FICTIONAL_MAIL = /@(example\.(com|org|net)|test|localhost|[\w-]+\.local)$/i;

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

type Level = 'must' | 'review' | 'reviewed' | 'public';

export interface Finding {
  level: Level;
  rule: string;
  where: string;
  detail: string;
  fingerprint: string;
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

function extOf(name: string): string {
  const index = name.lastIndexOf('.');
  return index <= 0 ? '' : name.slice(index).toLowerCase();
}

function isText(bytes: Uint8Array): boolean {
  const head = bytes.subarray(0, 8192);
  for (const byte of head) if (byte === 0) return false;
  return true;
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes);
}

function maskDigits(value: string): string {
  const chars = [...value];
  if (chars.length <= 3) return `${'*'.repeat(chars.length)}（${chars.length} 位）`;
  return `${chars[0]}${chars[1]}${'*'.repeat(chars.length - 3)}${chars[chars.length - 1]}（${chars.length} 位）`;
}

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
  detail?: (match: RegExpExecArray) => string | null;
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
    return null;
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

export function attributeKnownKeys(findings: Finding[], known: Map<string, string>): string[] {
  const unknownKeys: string[] = [];
  for (const finding of findings) {
    if (finding.secret === undefined) continue;
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
  const showFingerprints = args.includes('--fingerprints');

  const files: FileRef[] = [];
  for (const root of roots) collect(root, files);
  for (const name of readdirSync(REPO).sort()) {
    if (name.startsWith('.') || SKIP_DIRS.has(name)) continue;
    const abs = join(REPO, name);
    if (!statSync(abs).isDirectory()) files.push({ rel: name, abs });
  }

  if (files.length === 0) {
    console.log(`没有可扫描的文件（扫描根：${roots.join(', ')}）`);
    process.exit(1);
  }

  const texts = new Map<string, string>();
  const blobs = new Map<string, Uint8Array>();
  const findings: Finding[] = [];
  const unchecked: Unchecked[] = [];
  let skippedLarge = 0;

  for (const file of files) {
    if (file.rel === SCANNER_REL) continue;
    if (jsonPath && resolve(REPO, file.rel) === resolve(REPO, jsonPath)) continue;
    const bytes = readFileSync(file.abs) as unknown as Uint8Array;
    const ext = extOf(file.rel);

    if (KEY_FILE_EXT.has(ext)) {
      const verdict = keyFileVerdict(ext, bytes.length);
      findings.push({
        level: verdict.level,
        rule: '密钥 / 证书文件',
        where: file.rel,
        detail: verdict.detail,
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

export function isIgnored(ignoreText: string, path: string): boolean {
  for (const raw of ignoreText.split('\n')) {
    const line = raw.trim().replace(/^\//, '').replace(/\/$/, '');
    if (line === '' || line.startsWith('#') || line.startsWith('!')) continue;
    if (line === path || path.startsWith(`${line}/`)) return true;
  }
  return false;
}

const invokedAs = process.argv[1] ?? '';
if (invokedAs.endsWith('phi-scan.ts')) main();
