/**
 * 样例包：`samples/packs/` 下的三个示例（形式类规则 / 时限类规则 / 核心文书模板）。
 *
 * ## 程序**不读它**
 *
 * 它不参与装配、不会被自动装载 —— **库是唯一来源**（见 `pack-store.ts` 文件头）。
 * 这几个 JSON 只有两个用途：
 *   1. 自测的夹具：用例需要一个真实、合法的包，且走**与生产完全相同**的校验路径；
 *   2. 部署时把包灌进一个空库（演示服务里是 `POST /api/knowledge-pack-load`）。
 *
 * 它们**曾经是 TS 常量**（`qc/rule-pack.ts` 里的 `BUILTIN_RULE_PACK` 等）。改成纯数据，
 * 是因为常量形态会同时存在"代码里那份"与"库里那份"两份内容互相追着跑，
 * 而现场真正的问题（"我改了代码里的规则怎么没生效"）永远只能回答"库是权威" ——
 * 也就是"你改的那份不算"。变成数据之后，改包就是写库，**写库即生效**。
 *
 * ## 三个样例各自的性质
 *
 * - `qc.form.builtin` **形式类三条**：缺记录时间 / 必填为空 / 占位符未替换。
 *   只有三条是刻意的：三条都能逐条说明判定依据、误报率极低。凑到二十条不难，
 *   但医生对噪声的处置是**全部忽略**，那时连这三条有效的也没人看了。
 * - `qc.timelimit.builtin` **时限类四条**：入院记录 24h / 首次病程 8h / 病程间隔 24h /
 *   入院后须有入院记录。与形式类分成两个包，是为了让"医院改时限"只换这一个包。
 *   后两条是**跨文书**判定：需要调用方给出该就诊的文书清单，拿不到就如实报"未判定"。
 * - `doc.template.builtin` **核心文书模板**：门（急）诊 / 入院记录 / 产科门诊，
 *   外加 5 个医学表达式控件（BMI、体表面积、平均动脉压、年龄、孕周）。
 *
 * ## 阈值在这些 JSON 里，不在引擎里
 *
 * 时限（24h / 8h）、必填判定用到的数据元标签、模板章节与槽位，全部是数据。
 * 引擎只认识"有哪些谓词、公式怎么算"，改判据不需要改引擎 —— 这正是当初做"包"的目的。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** 样例包目录（随代码交付，**不在运行时目录**：它不参与运行，只供自测与灌包） */
export const SAMPLE_PACK_DIR = 'samples/packs';

export const SAMPLE_PACK_FILES = {
  formRules: 'qc.form.builtin.json',
  timeRules: 'qc.timelimit.builtin.json',
  templates: 'doc.template.builtin.json',
} as const;

/**
 * 读一个样例包（**未校验的原始数据**）。
 *
 * 返回 `unknown` 而不是某个包类型：它本来就是"外部数据"，与从接口灌进来的那份同级。
 * 直接读成 `QcRulePack` 会让类型断言替校验说话，而校验正是要跑的那一步。
 */
export function readSamplePack(root: string, fileName: string): unknown {
  return JSON.parse(readFileSync(join(root, SAMPLE_PACK_DIR, fileName), 'utf8')) as unknown;
}

/** 三个样例包的类型化读取：自测里按需取用，避免每处都写一遍文件名 */
export function readSamplePacks(root: string): { formRules: unknown; timeRules: unknown; templates: unknown } {
  return {
    formRules: readSamplePack(root, SAMPLE_PACK_FILES.formRules),
    timeRules: readSamplePack(root, SAMPLE_PACK_FILES.timeRules),
    templates: readSamplePack(root, SAMPLE_PACK_FILES.templates),
  };
}
