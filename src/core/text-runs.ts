import type { DataElementTag, RunProvenance, TextMark, TextRun } from '../model/types.ts';

export class TextRangeError extends Error {
  readonly code = 'E_OFFSET_RANGE';

  constructor(message: string) {
    super(message);
    this.name = 'TextRangeError';
  }
}

export type RangePayload = { kind: 'text'; text: string } | { kind: 'runs'; runs: TextRun[] };

/** run 序列的可见文本（偏移量的度量基准与它一致） */
export function textOfRuns(runs: TextRun[]): string {
  return runs.map((run) => run.text).join('');
}

function sameFormat(a: TextRun, b: TextRun): boolean {
  return (
    JSON.stringify(a.marks ?? []) === JSON.stringify(b.marks ?? []) &&
    JSON.stringify(a.tags ?? []) === JSON.stringify(b.tags ?? []) &&
    JSON.stringify(a.provenance ?? null) === JSON.stringify(b.provenance ?? null)
  );
}

export function mergeAdjacentRuns(runs: TextRun[]): TextRun[] {
  const merged: TextRun[] = [];
  for (const run of runs) {
    const last = merged[merged.length - 1];
    if (last && last.text !== '' && sameFormat(last, run)) {
      last.text += run.text;
      continue;
    }
    merged.push({ ...run });
  }
  const nonEmpty = merged.filter((run) => run.text !== '');
  return nonEmpty.length > 0 ? nonEmpty : [{ text: '' }];
}

/** 在 `offset` 处把 run 序列切成"左半 + 右半"，两侧都保留各自 run 的格式 */
export function splitRunsAt(runs: TextRun[], offset: number): { before: TextRun[]; after: TextRun[] } {
  const before: TextRun[] = [];
  const after: TextRun[] = [];
  let cursor = 0;
  for (const run of runs) {
    const next = cursor + run.text.length;
    if (next <= offset) {
      before.push({ ...run });
    } else if (cursor >= offset) {
      after.push({ ...run });
    } else {
      const cut = offset - cursor;
      before.push({ ...run, text: run.text.slice(0, cut) });
      after.push({ ...run, text: run.text.slice(cut) });
    }
    cursor = next;
  }
  return { before, after };
}

function runIndexAt(runs: TextRun[], offset: number): number {
  let cursor = 0;
  for (let index = 0; index < runs.length; index += 1) {
    const next = cursor + (runs[index] as TextRun).text.length;
    if (offset < next) return index;
    cursor = next;
  }
  return runs.length - 1;
}

/** 插入点"左侧紧邻"的 run（用于继承格式）；左侧没有则取右侧；都没有返回 undefined */
function contextRunOf(runs: TextRun[], start: number, end: number): TextRun | undefined {
  if (runs.length === 0) return undefined;
  const anchor = start === end && start > 0 ? start - 1 : start;
  const left = anchor >= 0 ? runs[runIndexAt(runs, anchor)] : undefined;
  /* 左侧没有（在段首插入）时取右侧：在段落开头打字理应沿用本段格式，而不是变成"无格式" */
  const right = runs[Math.min(start, runs.length - 1)];
  return left ?? right;
}

function assertRange(text: string, start: number, end: number): void {
  if (!Number.isInteger(start) || !Number.isInteger(end)) {
    throw new TextRangeError(`区间偏移必须是整数：start=${start}, end=${end}`);
  }
  if (start < 0 || end < start) {
    throw new TextRangeError(`区间非法：start=${start}, end=${end}（要求 0 ≤ start ≤ end）`);
  }
  if (end > text.length) {
    throw new TextRangeError(`区间越界：end=${end} 超过文本长度 ${text.length}`);
  }
  for (const offset of [start, end]) {
    if (offset <= 0 || offset >= text.length) continue;
    const previous = text.charCodeAt(offset - 1);
    const current = text.charCodeAt(offset);
    const highSurrogate = previous >= 0xd800 && previous <= 0xdbff;
    const lowSurrogate = current >= 0xdc00 && current <= 0xdfff;
    if (highSurrogate && lowSurrogate) {
      throw new TextRangeError(`偏移 ${offset} 落在代理对中间：会把一个生僻字劈成半个字符（序列化后是乱码）`);
    }
  }
}

export function minimalEditSpan(before: string, after: string): { start: number; end: number; text: string } | null {
  if (before === after) return null;
  const max = Math.min(before.length, after.length);
  let start = 0;
  while (start < max && before[start] === after[start]) start += 1;
  let suffix = 0;
  while (suffix < max - start && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix += 1;
  let end = before.length - suffix;

  const splitsPair = (text: string, offset: number): boolean => {
    if (offset <= 0 || offset >= text.length) return false;
    const previous = text.charCodeAt(offset - 1);
    const current = text.charCodeAt(offset);
    return previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff;
  };
  while (start > 0 && splitsPair(before, start)) start -= 1;
  while (end > start && splitsPair(before, end)) end -= 1;

  return { start, end, text: after.slice(start, after.length - (before.length - end)) };
}

export function applyTextRange(runs: TextRun[], start: number, end: number, payload: RangePayload): TextRun[] {
  const text = textOfRuns(runs);
  assertRange(text, start, end);
  const { before } = splitRunsAt(runs, start);
  const { after } = splitRunsAt(runs, end);

  let inserted: TextRun[];
  if (payload.kind === 'runs') {
    inserted = payload.runs.map((run) => ({ ...run }));
  } else {
    const context = contextRunOf(runs, start, end);
    const inherited: Partial<TextRun> = {};
    if (context?.marks && context.marks.length > 0) inherited.marks = [...context.marks] as TextMark[];
    if (context?.tags && context.tags.length > 0) inherited.tags = [...context.tags] as DataElementTag[];
    // `provenance` 刻意不继承：医生在 AI 起草的句子里插字，插进去的必须算人写
    inserted = [{ ...inherited, text: payload.text }];
  }

  return mergeAdjacentRuns([...before, ...inserted, ...after]);
}

export interface AiRange {
  readonly start: number;
  readonly end: number;
}

export function runsFromAiRanges(text: string, ranges: readonly AiRange[], provenance: RunProvenance): TextRun[] {
  const sorted = ranges.map((range, index) => {
    if (!range || typeof range !== 'object') throw new TextRangeError(`aiRanges[${index}] 应是 { start, end }`);
    assertRange(text, range.start, range.end);
    if (range.start === range.end) {
      throw new TextRangeError(`aiRanges[${index}] 是空区间：没有字符就不该标来源（空数组表示一句都没用）`);
    }
    return { start: range.start, end: range.end };
  }).sort((left, right) => left.start - right.start);

  for (let index = 1; index < sorted.length; index += 1) {
    if ((sorted[index] as AiRange).start < (sorted[index - 1] as AiRange).end) {
      throw new TextRangeError(`aiRanges 有重叠区间：第 ${index} 段起点落在上一段之内`);
    }
  }

  const runs: TextRun[] = [];
  let cursor = 0;
  for (const range of sorted) {
    if (range.start > cursor) runs.push({ text: text.slice(cursor, range.start) });
    runs.push({ text: text.slice(range.start, range.end), provenance: { ...provenance } });
    cursor = range.end;
  }
  if (cursor < text.length) runs.push({ text: text.slice(cursor) });
  return mergeAdjacentRuns(runs);
}
