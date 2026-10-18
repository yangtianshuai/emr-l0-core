// 真实数据批量扫描：把一个目录里的外来样本逐个跑一遍导入，出人类可读的报告。

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describeAnyImport, importAnyDocument, type AnyImported } from './import-any.ts';

interface ScanRow {
  file: string;
  bytes: number;
  ok: boolean;
  kind?: string;
  summary?: string;
  error?: { code: string; message: string };
  /** 从导入结果里抽出的关键统计（不同格式的键不同，故用通用记录） */
  stats?: Record<string, number | string | null>;
  warnings: string[];
  signed?: boolean;
}

const SKIP_EXT = new Set(['.md', '.json', '.png', '.log']);

/** 手写扩展名提取：本项目对 node:path 的自有类型声明未覆盖 extname，避免为此扩大共享声明面 */
function extOf(name: string): string {
  const index = name.lastIndexOf('.');
  return index <= 0 ? '' : name.slice(index).toLowerCase();
}

function collect(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...collect(full));
      continue;
    }
    if (SKIP_EXT.has(extOf(name))) continue;
    out.push(full);
  }
  return out;
}

function picked(result: AnyImported): Record<string, number | string | null> {
  if (result.kind === 'ofd') {
    const item = result.result;
    return {
      format: item.format,
      pages: item.pages,
      textChars: item.textChars,
      machineElements: item.machine.elements.length,
      hasMachine: item.machine.found ? 'yes' : 'no',
      pathObjects: item.pathObjects ?? 0,
    };
  }
  const item = result.result;
  return {
    format: 'wst500',
    sections: item.stats.sections,
    paragraphs: item.stats.paragraphs,
    fields: item.stats.fields,
    textChars: item.stats.textChars,
    nestedFields: item.stats.nestedFields,
    codedValues: item.stats.codedValues,
    skippedEntries: item.stats.skippedEntries,
  };
}

function scanFile(file: string): ScanRow {
  const bytes = readFileSync(file);
  const base = { file: file.split(/[\\/]/).slice(-2).join('/'), bytes: bytes.length, warnings: [] as string[] };
  try {
    const result = importAnyDocument(bytes, file.split(/[\\/]/).pop() ?? file);
    const warnings = result.kind === 'ofd' ? result.result.warnings : result.result.warnings;
    return {
      ...base,
      ok: true,
      kind: result.kind,
      summary: describeAnyImport(result),
      stats: picked(result),
      warnings,
      signed: result.kind === 'ofd' ? result.result.signature.signed : false,
    };
  } catch (err) {
    return {
      ...base,
      ok: false,
      error: { code: (err as { code?: string }).code ?? 'UNKNOWN', message: (err as Error).message },
      warnings: [],
    };
  }
}

function main(): void {
  const args = process.argv.slice(2);
  const dir = resolve(args.find((item) => !item.startsWith('--')) ?? 'artifacts/external');
  const jsonIndex = args.indexOf('--json');
  const jsonPath = jsonIndex >= 0 ? args[jsonIndex + 1] : undefined;

  const files = collect(dir);
  if (files.length === 0) {
    console.log(`目录里没有可扫描的样本：${dir}`);
    console.log('把真实文件放进去（原样字节，不要用编辑器打开再保存），再运行本命令。');
    process.exit(1);
  }

  const rows = files.map(scanFile);
  const failed = rows.filter((row) => !row.ok);
  const withWarnings = rows.filter((row) => row.ok && row.warnings.length > 0);

  const succeeded = rows.filter((row) => row.ok);
  console.log(`扫描目录：${dir}`);
  /* 注意口径：导入件按纪律一律需要人工核对，所以"带警告"不是异常状态，
     而是"待核对清单"。这里不把它算作"不正常"，否则报告会天天显示"全部异常"。  */
  console.log(
    `样本 ${rows.length} 份 | 导入成功 ${succeeded.length}（其中 ${withWarnings.length} 份带警告 = 待核对清单） | 导入失败 ${failed.length}\n`,
  );

  for (const row of rows) {
    const head = row.ok ? `✅ ${row.file}` : `❌ ${row.file}`;
    console.log(head);
    if (!row.ok) {
      console.log(`   错误码：${row.error?.code}`);
      console.log(`   原因：${row.error?.message}`);
      continue;
    }
    console.log(`   ${row.summary}`);
    if (row.stats) {
      console.log(`   统计：${Object.entries(row.stats).map(([key, value]) => `${key}=${value}`).join('  ')}`);
    }
    if (row.warnings.length === 0) console.log('   警告：无');
    for (const warning of row.warnings) console.log(`   ⚠️ ${warning}`);
  }

  if (jsonPath) {
    writeFileSync(jsonPath, `${JSON.stringify({ dir, scannedAt: new Date().toISOString(), rows }, null, 2)}\n`, 'utf8');
    console.log(`\n报告已写入：${jsonPath}`);
  }

  console.log('\n判读提示：');
  console.log('  · ⚠️ 里的每一条都是"必须有人核对"的具体事项，不是噪声；');
  console.log('  · 「entry 缺少编码或取值，未导入」和「嵌套超过上限」要**回到源文件逐条查**：');
  console.log('    可能确实是空值，也可能是我们的解析缺口 —— 两者处理方式完全不同；');
  console.log('  · ❌ 里若错误码是 E_IMPORT_FAILED 且说"既不是 OFD 容器也不是 ClinicalDocument"，');
  console.log('    先确认文件真实格式（ZIP 魔数 504B0304 / 根元素），别急着改解析器。');

  process.exit(failed.length > 0 ? 1 : 0);
}

main();
