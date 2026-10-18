// 样例包：`samples/packs/` 下的三个示例（形式类规则 / 时限类规则 / 核心文书模板）。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** 样例包目录（随代码交付，不在运行时目录：它不参与运行，只供自测与灌包）  */
export const SAMPLE_PACK_DIR = 'samples/packs';

export const SAMPLE_PACK_FILES = {
  formRules: 'qc.form.builtin.json',
  timeRules: 'qc.timelimit.builtin.json',
  templates: 'doc.template.builtin.json',
} as const;

/**
 * 读一个样例包（未校验的原始数据）。
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
