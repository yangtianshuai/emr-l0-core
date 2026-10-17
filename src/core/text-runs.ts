/**
 * 文本节点的 **run 级区间替换**（`WriteSession.replaceRange` 的纯函数内核）。
 *
 * ## 为什么要单独一层
 *
 * 区间与 run 的合并规则是这块最容易写错的地方，而它**不依赖会话状态**：
 * 独立成纯函数才能被逐条断言（越界、代理对边界、边界 run 的 marks/tags 保留、run 合并），
 * 也才能让"写入前文档 + patch = 写入后文档"这条不变量在小尺度上先立住。
 *
 * ## 为什么不能继续用"整段覆盖"
 *
 * `updateNodeProps({ patch: { runs: [{ text }] } })` 把该节点的 runs 全部丢掉重造。今天看不出问题
 * （全库没有任何地方产生 run 级 `marks`，`tags` 都挂在节点级/字段级），但它有两个硬伤：
 *   1) 一旦出现 run 级样式或**行内数据元**，"改一个字"就会把整段的样式与标签一起抹掉 ——
 *      而 T19 的验收标准正是"**序列化无信息丢失**"；
 *   2) "整段替换"不是一个编辑器能用的原语：它没有"选区替换"的概念，
 *      于是医生只动一个标点，留痕里也是"整段变了"。
 *
 * ## 语义（三条，都按字面理解）
 *
 * 1) 偏移量是 **UTF-16 码元**（与 JS 字符串一致），区间为 `[start, end)`；
 *    `start === end` 表示**纯插入**；越界 / `start > end` / 非整数 → `E_OFFSET_RANGE`；
 *    **偏移落在代理对中间会被拒绝** —— 病历里的人名、药名有生僻字（CJK 扩展 B 起就是代理对），
 *    把一个字劈成两半会得到半个字符，序列化出去就是乱码，而这种损坏肉眼很难发现。
 * 2) **区间外的内容一个字节都不动**：被切开的首、尾 run 各自保留原有的 `marks` 与 `tags`。
 * 3) 插入内容：给了 `runs` 就按给定的来；只给 `text` 时，新 run **继承"插入点左侧紧邻 run"的
 *    `marks`/`tags`**（"在加粗里打字还是加粗"、"改数据元的值不丢它的标签"），
 *    左侧没有则取右侧，两侧都没有则是无标记的纯文本 run。最后**合并相邻且格式完全相同的 run**——
 *    否则每次编辑都会把 run 切碎，序列化体积与 diff 噪声会一起膨胀。
 */

import type { DataElementTag, RunProvenance, TextMark, TextRun } from '../model/types.ts';

/** 区间非法的错误。`code` 与 `WRITE_ERRORS.E_OFFSET_RANGE` 同值：`commit()` 的 catch 按 `code` 归类 */
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

/**
 * 两段格式是否完全相同（marks / tags / run 级 provenance 逐项相等；顺序也认定为格式的一部分）。
 *
 * **provenance 必须参与比较**：合并两个来源不同的相邻 run，会把"这一句是 AI 起草的"
 * 抹成"整段都是那个来源"。而合并是不可见的（结果里看不出曾经有过两个 run），
 * 所以这个错误不会当场暴露，只会在逐句回溯时表现为"AI 写的多了几句"或"少了"。
 */
function sameFormat(a: TextRun, b: TextRun): boolean {
  return (
    JSON.stringify(a.marks ?? []) === JSON.stringify(b.marks ?? []) &&
    JSON.stringify(a.tags ?? []) === JSON.stringify(b.tags ?? []) &&
    JSON.stringify(a.provenance ?? null) === JSON.stringify(b.provenance ?? null)
  );
}

/**
 * 合并相邻且格式相同的 run，并丢弃空文本 run。
 *
 * 空 run 一律不留：它不承载任何内容，却在序列化里占位、在 diff 里制造噪声；
 * 若合并后一个都不剩（整段被删空），返回一个空文本 run —— 文本节点的 `runs` 不该是空数组
 * （`insertText` 也是这么规范化的）。
 */
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

/** `offset` 落在哪个 run 上（`offset` 等于总长度时取最后一个 run） */
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

/**
 * 区间替换的纯函数实现：返回**新的** run 序列，不修改入参。
 *
 * 不变量（由 `session-self-test` 守着）：
 *   - `textOfRuns(结果)` === 原文删掉 `[start,end)` 再插入 payload 后的文本；
 *   - 区间外的 run 文本与其 marks/tags 逐项不变；
 *   - 结果里不存在相邻且格式相同的 run（已合并），也没有空文本 run。
 */
/**
 * 两段文本的**最小改动区间**：返回 `{ start, end, text }`，语义是"把 `[start,end)` 换成 `text`"；
 * 完全相同则返回 `null`。
 *
 * 为什么需要它：浏览器里的编辑控件（`textarea` / contenteditable）只会交回**整段文本**，
 * 而内核只认区间。在服务端算一次最小差异，等于让**每一种客户端**都自动获得区间替换 ——
 * 不必要求每套前端各实现一遍 diff，也不必让"改了一个标点"变成"整段重写"。
 *
 * 代理对的处理与 `applyTextRange` 同一理由：差异边界若落在生僻字的两个码元之间，
 * **向外扩到整个字**。否则 `replaceRange` 会以 `E_OFFSET_RANGE` 拒绝，
 * 而用户只是在改一个生僻字 —— 那种"保存失败"看不出原因。
 */
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
  /* 只有可能向左扩（公共前缀/后缀的字符在两段文本里完全相同，所以扩到哪里都仍然成立） */
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
    /* ⚠️ `provenance` **刻意不继承**，这与 marks / tags 相反，且是这里最要紧的一条：
       医生在 AI 起草的那句话中间打字，新插入的字符是**医生写的**（没有 provenance = 继承节点级，
       而节点级会随这次写入变成 human/derivedFrom）。若把来源一起继承，
       医生写的字会被标成 AI 写的 —— 逐句回溯会反着骗人，而这正是它要防的失败方向。
       反过来，AI 落笔走的是 `payload.kind === 'runs'`（来源由调用方显式给出），不经过这里。 */
    inserted = [{ ...inherited, text: payload.text }];
  }

  return mergeAdjacentRuns([...before, ...inserted, ...after]);
}

/* --------------------------- 按区间标"这句是谁写的" --------------------------- */

/**
 * 一段文本里"由 AI 写出"的字符区间（`[start, end)`，UTF-16 码元）。
 *
 * 为什么要它存在：采纳建议时医生往往只用了其中几句（见界面上的逐句勾选），
 * 若整段都标成 AI，逐句回溯（G2）与 AI 参与度标记（G3）就会把**医生保留的原句**算成 AI 写的 ——
 * 这正是 `RunProvenance` 当初被加进来的理由（"把医生写的算成 AI 写的"是失真的一个方向）。
 */
export interface AiRange {
  readonly start: number;
  readonly end: number;
}

/**
 * 把"最终文本 + 哪些区间是 AI 写的"落成 run 序列：区间内带来源，区间外不带。
 *
 * 三条纪律：
 * 1) **区间外的 run 一律没有 `provenance`**（= 继承节点级来源）。不给它补一个占位来源：
 *    没有来源就是"这段不是 AI 逐字写的"，补一个 `human` 反而是在替医生背书。
 * 2) **越界 / 重叠 / 空区间 / 落在代理对中间**一律拒绝（复用 `assertRange`）：
 *    这类输入只会来自有 bug 的调用方，静默纠正会产出一份"看起来分得很细"的假归属。
 * 3) 结果仍走 `mergeAdjacentRuns`：相邻且来源相同的 run 要合并，否则每次采纳都会把段落切碎。
 *
 * 空数组是合法的，含义是"医生一句都没用"：整段没有任何字符标 AI。
 */
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
