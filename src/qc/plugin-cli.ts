#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveRuntimeLayout } from '../core/runtime-dir.ts';
import {
  generatePluginKey,
  QC_PLUGIN_KEY_FILE,
  QC_PLUGIN_MANIFEST_FILE,
  readPluginKey,
  signPluginDir,
  verifyPluginDir,
  writePluginKey,
  type QcPluginManifest,
} from './plugin.ts';

interface Flags {
  root: string | null;
  dir: string | null;
  key: string | null;
  keyFile: string | null;
  keyId: string;
  force: boolean;
  rest: string[];
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = { root: null, dir: null, key: null, keyFile: null, keyId: 'default', force: false, rest: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index] as string;
    if (item === '--root') { flags.root = argv[index + 1] ?? null; index += 1; continue; }
    if (item === '--dir') { flags.dir = argv[index + 1] ?? null; index += 1; continue; }
    if (item === '--key') { flags.key = argv[index + 1] ?? null; index += 1; continue; }
    if (item === '--key-file') { flags.keyFile = argv[index + 1] ?? null; index += 1; continue; }
    if (item === '--key-id') { flags.keyId = argv[index + 1] ?? 'default'; index += 1; continue; }
    if (item === '--force') { flags.force = true; continue; }
    flags.rest.push(item);
  }
  return flags;
}

function runtimeDirOf(flags: Flags): string {
  const layout = resolveRuntimeLayout(process.env, flags.root === null ? {} : { root: flags.root });
  return layout.dir;
}

function keyOf(flags: Flags): string | null {
  if (flags.key !== null && flags.key.trim() !== '') return flags.key.trim();
  if (flags.keyFile !== null) {
    if (!existsSync(flags.keyFile)) return null;
    const value = readFileSync(flags.keyFile, 'utf8').trim();
    return value === '' ? null : value;
  }
  return readPluginKey(runtimeDirOf(flags));
}

function printPluginManifest(manifest: QcPluginManifest, keyId: string): void {
  console.log(`  插件：${manifest.pluginId}  ${manifest.name}  v${manifest.version}`);
  console.log(`  契约：${manifest.api}    入口：${manifest.entry}    密钥标识：${keyId}`);
  console.log(`  算子：${manifest.operators.map((item) => item.name).join(' / ') || '（一个都没有）'}`);
  console.log('  文件摘要：');
  for (const file of manifest.files) console.log(`    ${file.sha256.slice(0, 16)}…  ${file.path}`);
}

function main(argv: string[]): number {
  const command = argv[0] ?? '';
  const flags = parseFlags(argv.slice(1));

  if (command === 'keygen') {
    const dir = runtimeDirOf(flags);
    const path = join(dir, QC_PLUGIN_KEY_FILE);
    if (existsSync(path) && !flags.force) {
      console.error(`密钥已存在：${path}`);
      console.error('不覆盖它 —— 换了密钥，已签名的插件全部要重签（--force 才覆盖）');
      return 1;
    }
    writePluginKey(dir, generatePluginKey());
    console.log(`已生成部署密钥：${path}`);
    console.log('它不进代码库、不进规则包：只有它签过的插件才会被装载');
    return 0;
  }

  if (command === 'sign') {
    const dir = flags.rest[0];
    if (dir === undefined) {
      console.error('用法：plugin-cli.ts sign <插件目录> [--key ... --key-file ... --key-id ...]');
      return 1;
    }
    const key = keyOf(flags);
    if (key === null) {
      console.error(`没有密钥：先运行 keygen，或用 --key / --key-file 给一把（要找的是运行时目录里的 ${QC_PLUGIN_KEY_FILE}）`);
      return 1;
    }
    const { manifest, signaturePath } = signPluginDir(dir, key, flags.keyId);
    console.log(`已签名：${signaturePath}`);
    printPluginManifest(manifest, flags.keyId);
    console.log('  注意：签名把**清单与文件的摘要**一起固定下来 —— 改实现或改清单都要重新签名。');
    return 0;
  }

  if (command === 'verify') {
    const dir = flags.rest[0];
    if (dir === undefined) {
      console.error('用法：plugin-cli.ts verify <插件目录> [--key ... --key-file ...]');
      return 1;
    }
    const key = keyOf(flags);
    if (key === null) {
      console.error('没有密钥：无法验签，因此不装任何插件');
      return 1;
    }
    try {
      const verified = verifyPluginDir(dir, key);
      console.log(`验签通过：${dir}`);
      printPluginManifest(verified.manifest, verified.signature.keyId);
      return 0;
    } catch (error) {
      console.error(`验签失败：${(error as Error).message}`);
      console.error(`错误码：${String((error as { code?: string }).code ?? '(unknown)')}`);
      return 1;
    }
  }

  if (command === 'list') {
    const dir = flags.dir ?? join(runtimeDirOf(flags), 'qc-plugins');
    if (!existsSync(dir)) {
      console.log(`插件目录不存在：${dir}`);
      console.log('这台机器没有装插件（不是错误：本机只用内核算子）');
      return 0;
    }
    const key = keyOf(flags);
    if (key === null) {
      console.error('插件目录在，但没有密钥：一个插件都不会被装载');
      console.error(`找过的地方：--key / --key-file，以及运行时目录「${runtimeDirOf(flags)}」里的 ${QC_PLUGIN_KEY_FILE}`);
      return 1;
    }
    let failed = 0;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const pluginDir = join(dir, entry.name);
      if (!existsSync(join(pluginDir, QC_PLUGIN_MANIFEST_FILE))) {
        console.log(`跳过 ${entry.name}：没有 ${QC_PLUGIN_MANIFEST_FILE}`);
        continue;
      }
      try {
        const verified = verifyPluginDir(pluginDir, key);
        console.log(`✔ ${entry.name}`);
        printPluginManifest(verified.manifest, verified.signature.keyId);
      } catch (error) {
        failed += 1;
        console.log(`✘ ${entry.name}  ${String((error as { code?: string }).code ?? '(unknown)')}`);
        console.log(`  ${(error as Error).message}`);
      }
    }
    return failed === 0 ? 0 : 1;
  }

  console.log('用法：');
  console.log('  plugin-cli.ts keygen [--root <运行时根目录>] [--force]');
  console.log('  plugin-cli.ts sign <插件目录> [--key <密钥> | --key-file <文件>] [--key-id <标识>]');
  console.log('  plugin-cli.ts verify <插件目录> [--key ... | --key-file ...]');
  console.log('  plugin-cli.ts list [--root <运行时根目录> | --dir <插件根目录>]');
  return command === '' ? 0 : 1;
}

process.exit(main(process.argv.slice(2)));
