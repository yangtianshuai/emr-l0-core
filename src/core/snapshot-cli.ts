/**
 * 快照盐的运维命令：**生成 / 巡检 / 迁移**。
 *
 * 这三条命令合起来才是"盐可以轮换"的完整含义 —— 只有第一条（换配置）是配置问题，
 * 后两条才是让轮换**真的发生过**的东西：
 *
 *   1) 生成新盐：`npm run salt:new` → 打印 32 位十六进制盐
 *   2) 巡检现状：`npm run salt:inspect` → 每个快照是**哪一代盐**写的、是否已迁移
 *   3) 迁移历史：`npm run salt:reseal` → 用当前盐重写（先读通再写，原子覆盖）
 *
 * ## 为什么必须有"巡检"
 *
 * 换掉配置之后，"还有哪些文件没迁移"如果无法回答，轮换就只是纸面上的：
 * 新文件用新盐、旧文件永远用旧盐，而**没有任何人知道这件事**。
 * 巡检只读信封头部、**不解密**，所以它便宜到可以随时跑（不必付每次 7.6 秒的密钥派生）。
 *
 * ## 为什么"旧盐"不需要保留
 *
 * 盐写在每个信封自己的头部，解密用它。所以迁移**不需要知道旧盐**，
 * 也不存在"旧盐登记表"需要维护与回滚 —— 需要同步的登记表必然漏同步，
 * 这正是本设计刻意避开的东西。
 *
 * 用法（目录默认当前运行目录下的 `state`，可用命令行参数覆盖）：
 *   node src/core/snapshot-cli.ts salt:new
 *   node src/core/snapshot-cli.ts inspect [dir]
 *   node src/core/snapshot-cli.ts reseal [dir]
 */

import { randomBytes } from 'node:crypto';
/* 本仓库环境的 node:fs 类型声明不完整（缺 isFile/statSync 的完整声明），
   这里只用 existsSync —— 与 core/store.ts、persistence.ts 同一处理方式。 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { toHex } from '../crypto/sm3.ts';
import { loadServerConfig, serverConfigPath, stateKeyOf, stateSaltHexOf } from './server-config.ts';
import { resolveRuntimeLayout } from './runtime-dir.ts';
import { currentSaltFingerprint, inspectSealedSidecars, resealSidecars, resolveStateSalt } from './store.ts';

/**
 * 口令与盐都从**服务端文件配置**读（`core/server-config.ts`）——
 * 与 demo-server 同一个来源，于是不存在"两个口令该配哪个"这种问题。
 */
const RUNTIME = resolveRuntimeLayout(process.env);
const SERVER_CONFIG = loadServerConfig(serverConfigPath(RUNTIME.dir));
/** 生效口令（**只打印来源，绝不打印值**） */
const passphrase = stateKeyOf(SERVER_CONFIG).key;
/** 生效盐：未配则 `undefined`，由 `resolveStateSalt` 按口令派生 */
const saltHex = stateSaltHexOf(SERVER_CONFIG);

const command = process.argv[2];
const dir = process.argv[3] ?? RUNTIME.stateDir;

/** 目录下所有快照文件（只取一层，与 demo-server 的布局一致） */
function snapshotFiles(root: string): string[] {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith('.json'))
    .map((name) => join(root, name))
    .filter((file) => existsSync(file))
    .sort();
}

/**
 * 打印当前盐的来源。
 *
 * **这是本次改动里最该有的一行输出**：注入写错了（名字打错、值非法、忘了重启），
 * 表现是"一切正常、只是盐还是老的"—— 不打印来源就没有任何办法察觉。
 * 尤其是 `derived`：它意味着**没有独立盐**，"轮换"根本无从谈起，必须显式警告。
 */
function reportSaltSource(): string {
  let resolved: ReturnType<typeof resolveStateSalt>;
  let fingerprint: string;
  try {
    resolved = resolveStateSalt(passphrase, saltHex);
    fingerprint = currentSaltFingerprint(passphrase, saltHex);
  } catch (err) {
    /* 配置错不是程序崩：直接抛堆栈会让运维去翻代码，而问题其实在他自己那份配置文件里。
       同时**必须**以失败退出 —— 若"配置错"也返回 0，脚本里就没人会发现盐没生效。 */
    console.error(`配置错误：${(err as Error).message}`);
    console.error(`处理方式：用 \`npm run salt:new\` 生成合法盐并写入 ${SERVER_CONFIG.path} 的 stateSalt，或清空它退回按口令派生。`);
    process.exit(2);
    return '';
  }
  const label =
    resolved.source === 'option'
      ? `服务端文件配置的 stateSalt（${SERVER_CONFIG.path}）`
      : '按口令派生（⚠️ 未配独立盐，轮换无从谈起）';
  console.log(`当前盐来源：${label}`);
  console.log(`当前盐指纹：${fingerprint}`);
  /* 口令来源必须报（不报值）：用了演示口令这件事，现场只能从这里看见 */
  const keySource = stateKeyOf(SERVER_CONFIG).source;
  console.log(
    keySource === 'file'
      ? `当前口令来源：服务端文件配置（${SERVER_CONFIG.path}）`
      : `当前口令来源：⚠️ **内置演示口令**（生产必须替换：在 ${SERVER_CONFIG.path} 里填 stateKey）`,
  );
  return fingerprint;
}

if (command === 'salt:new') {
  /* 生成的是**盐**，不是口令：盐不是秘密（它写在每个信封头部），
     所以可以直接打印到终端、可以进工单。口令必须走密钥管理，绝不这样输出。 */
  console.log(`新的快照盐（32 位十六进制，写入 ${SERVER_CONFIG.path} 的 stateSalt）：`);
  console.log(toHex(new Uint8Array(randomBytes(16))));
  console.log('\n注意：盐不是秘密 —— 它写在每个信封头部，公开无妨；');
  console.log('      口令才是秘密，它必须来自密钥管理，不要用这条命令生成。');
} else if (command === 'inspect') {
  const current = reportSaltSource();
  const files = snapshotFiles(dir);
  console.log(`\n目录：${dir}（${files.length} 个快照）`);
  if (files.length === 0) {
    console.log('没有找到快照文件。');
  }
  let migrated = 0;
  let pending = 0;
  let other = 0;
  for (const file of files) {
    const info = inspectSealedSidecars(file);
    if (!info.ok) {
      other += 1;
      console.log(`  [不适用] ${file} —— ${info.message}`);
      continue;
    }
    const state = info.saltFingerprint === current ? '已迁移' : '待迁移';
    if (state === '已迁移') migrated += 1;
    else pending += 1;
    console.log(`  [${state}] ${file}  盐指纹=${info.saltFingerprint}  迭代=${info.iterations}`);
  }
  console.log(`\n汇总：已迁移 ${migrated} / 待迁移 ${pending} / 不适用 ${other}`);
  if (pending > 0) console.log('待迁移的文件用 `npm run salt:reseal` 重写（会先读通再写，读不通绝不覆盖）。');
} else if (command === 'reseal') {
  const current = reportSaltSource();
  const files = snapshotFiles(dir);
  console.log(`\n目录：${dir}（${files.length} 个快照）`);
  let migrated = 0;
  let skipped = 0;
  let failed = 0;
  for (const file of files) {
    const result = resealSidecars(file, passphrase);
    if (!result.ok) {
      failed += 1;
      /* 失败**必须逐条报出来**并让退出码非零：静默跳过会让"迁移完成"变成一句假话，
         而这份数据可能正是唯一一份（解不开的原因通常需要人来处理）。 */
      console.log(`  [失败] ${file} —— ${result.message}`);
      continue;
    }
    if (result.changed) {
      migrated += 1;
      console.log(`  [已重写] ${file}  ${result.before} → ${result.after}`);
    } else {
      skipped += 1;
    }
  }
  console.log(`\n汇总：重写 ${migrated} / 跳过（已是当前盐） ${skipped} / 失败 ${failed}`);
  if (failed > 0) {
    console.log('存在失败项：**不要**认为轮换已完成。失败文件保持原样（未被覆盖），逐个排查后再跑。');
    /* 用非零退出码：只有在脚本与 CI 眼里"失败就是失败"，这条命令才可能被正确使用 */
    process.exit(1);
  }
} else {
  console.log('用法：');
  console.log('  node src/core/snapshot-cli.ts salt:new              生成新盐（打印 32 位十六进制）');
  console.log('  node src/core/snapshot-cli.ts inspect [dir]         巡检：每个快照是哪一代盐写的');
  console.log('  node src/core/snapshot-cli.ts reseal  [dir]         迁移：用当前盐重写（原子、先读通再写）');
  console.log(`\n配置来源：${SERVER_CONFIG.path}（stateKey = 口令，stateSalt = 盐，32 位十六进制）；目录可用命令行参数覆盖`);
  process.exit(2);
}
