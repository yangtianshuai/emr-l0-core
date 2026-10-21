import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const SAMPLE_PACK_DIR = 'samples/packs';

export const SAMPLE_PACK_FILES = {
  formRules: 'qc.form.builtin.json',
  timeRules: 'qc.timelimit.builtin.json',
  templates: 'doc.template.builtin.json',
} as const;

export function readSamplePack(root: string, fileName: string): unknown {
  return JSON.parse(readFileSync(join(root, SAMPLE_PACK_DIR, fileName), 'utf8')) as unknown;
}

export function readSamplePacks(root: string): { formRules: unknown; timeRules: unknown; templates: unknown } {
  return {
    formRules: readSamplePack(root, SAMPLE_PACK_FILES.formRules),
    timeRules: readSamplePack(root, SAMPLE_PACK_FILES.timeRules),
    templates: readSamplePack(root, SAMPLE_PACK_FILES.templates),
  };
}
