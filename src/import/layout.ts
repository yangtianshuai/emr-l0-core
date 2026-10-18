// T26 · 版式段落重建（几何启发式）。

export interface LayoutLine {
  page: number;
  text: string;
  x?: number;
  y?: number;
  size?: number;
}

export interface RebuiltParagraph {
  page: number;
  text: string;
  /** 合并了多少个版式行 */
  lineCount: number;
  /** 段左边界（pt） */
  left: number;
  /** 平均字号（pt） */
  fontSize: number;
  /** 判定依据（人类可读，供审计与界面展示） */
  evidence: string[];
  /** 段内首行相对段左边界的内缩（pt）：>0 表示"本段以缩进开头"，这也是段落的正向证据 */
  firstLineIndent?: number;
  /**
   * 置信度：
   *   high   —— 至少两条独立线索一致（如"间距变大 + 首行缩进"）
   *   medium —— 只有一条线索
   *   low    —— 未发现任何线索（结果只是"按页合并"），必须人工整理
   */
  confidence: 'high' | 'medium' | 'low';
  kind: 'title' | 'body';
}

export interface RebuildOptions {
  /**
   * 行距阈值倍数：gap > 基准行距 × ratio → 新段落（默认 1.25）。
   * 阈值不能设太高：段前间距通常只有几个 pt（16 → 22 就是 1.375 倍），
   * 设成 1.35 时余量极小，字号稍有不同就会漏切。
   */
  gapRatio?: number;
  /** 缩进阈值倍数：超出段左边界 size × ratio → 新段落（默认 1.5） */
  indentRatio?: number;
  /** 字号变化比例：字号 > 上一行 × (1+ratio) → 标题/新段（默认 0.15） */
  sizeRatio?: number;
  absoluteGapRatio?: number;
  /** 无坐标线索时的降级策略（默认 per-page） */
  fallback?: 'per-page' | 'per-line';
}

export interface RebuildResult {
  paragraphs: RebuiltParagraph[];
  strategy: 'geometry' | 'fallback-per-page' | 'fallback-per-line';
  warnings: string[];
  stats: { inputLines: number; visualLines: number; paragraphs: number; high: number; medium: number; low: number };
}

const ASCII_WORD_END = /[A-Za-z0-9]$/;
const ASCII_WORD_START = /^[A-Za-z0-9]/;

/**
 * 行拼接：中文直接相连，英文折行需补空格。
 * 判据是"上一行末字符与下一行首字符都是 ASCII 字母数字" —— 中文行末是标点或汉字，
 * 补空格会插入不该有的空白（实测：补空格会让"患者3天前"变成"患者 3天前"这类脏数据）。
 */
export function joinLines(previous: string, next: string): string {
  if (previous === '') return next;
  return ASCII_WORD_END.test(previous) && ASCII_WORD_START.test(next) ? `${previous} ${next}` : `${previous}${next}`;
}

/**
 * 估计"基准值"：按 0.5pt 分桶统计出现次数最多的值，并列时取较小值。
 *
 *  不能用中位数（实测踩到两次）：
 *   1) 基准行距：当"段间间距"与"段内行距"次数相当时，中位数会取到段间距本身
 *      （`[22,16,22,16,22,16]` 的中位数是 22），阈值被抬到 29.7，真正的段间距 22 反而不触发
 *      —— 整页被合并成一段；
 *   2) 基准字号：标题与正文各占一半时，中位数落在两者之间，
 *      于是"标题字号 > 基准 × 1.15"永远不成立，标题识别不出来。
 * 取"频次最高且更小"的那个值，这两个场景都能稳定命中正文的行距与字号。
  */
function estimateBaseline(values: number[]): number {
  const positive = values.filter((value) => value > 0.01);
  if (positive.length === 0) return 0;
  const buckets = new Map<number, number>();
  for (const value of positive) {
    const key = Math.round(value * 2) / 2;
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  let best = Number.POSITIVE_INFINITY;
  let bestCount = 0;
  for (const [value, count] of buckets) {
    if (count > bestCount || (count === bestCount && value < best)) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

const estimateLineGap = estimateBaseline;
const estimateBaseSize = estimateBaseline;

interface VisualLine {
  page: number;
  y: number;
  x: number;
  size: number;
  text: string;
  /** 该视觉行由几个原始文本片段合成（用于证据展示） */
  fragments: number;
}

/**
 * 把同一页里 y 接近的文本片段合成"视觉行"（左标签 + 右数值这类同行多片段很常见）。
 * 阈值取 0.6 × 字号：小于半行的偏移属于排版抖动，大于则视为不同行。
 */
function buildVisualLines(lines: LayoutLine[]): VisualLine[] {
  const withCoords = lines.filter((line) => line.x !== undefined && line.y !== undefined && line.size !== undefined);
  const withoutCoords = lines.filter((line) => !(line.x !== undefined && line.y !== undefined && line.size !== undefined));

  const byPage = new Map<number, LayoutLine[]>();
  for (const line of withCoords) {
    const bucket = byPage.get(line.page) ?? [];
    bucket.push(line);
    byPage.set(line.page, bucket);
  }

  const out: VisualLine[] = [];
  for (const [page, bucket] of [...byPage.entries()].sort((a, b) => a[0] - b[0])) {
    const sorted = [...bucket].sort((a, b) => (a.y! - b.y!) || (a.x! - b.x!));
    let current: VisualLine | null = null;
    for (const line of sorted) {
      const size = line.size!;
      const tolerance = size * 0.6;
      if (current && Math.abs(line.y! - current.y) <= tolerance && Math.abs(size - current.size) <= size * 0.35) {
        /* 同一视觉行：按 x 顺序拼接 */
        const ordered = [{ x: current.x, text: current.text }];
        ordered.push({ x: line.x!, text: line.text });
        ordered.sort((a, b) => a.x - b.x);
        current.text = ordered.map((item) => item.text).join(' ');
        current.fragments += 1;
      } else {
        if (current) out.push(current);
        current = { page, y: line.y!, x: line.x!, size, text: line.text, fragments: 1 };
      }
    }
    if (current) out.push(current);
  }

  /* 缺坐标的行无法参与几何聚类：追加到同页末尾（并保持"无坐标"的诚实标注） */
  for (const line of withoutCoords) {
    out.push({ page: line.page, y: Number.NaN, x: Number.NaN, size: 0, text: line.text, fragments: 1 });
  }
  return out;
}

export function rebuildParagraphs(lines: LayoutLine[], options: RebuildOptions = {}): RebuildResult {
  const gapRatio = options.gapRatio ?? 1.25;
  const indentRatio = options.indentRatio ?? 1.5;
  const sizeRatio = options.sizeRatio ?? 0.15;
  const absoluteGapRatio = options.absoluteGapRatio ?? 1.5;
  const fallback = options.fallback ?? 'per-page';
  const warnings: string[] = [];

  const usable = lines.filter((line) => line.text.trim() !== '');
  const coordinateCount = usable.filter((line) => line.x !== undefined && line.y !== undefined && line.size !== undefined).length;

  /* ---- 降级：坐标信息不足（少于 2 条有坐标的行，或全部无坐标） ---- */
  if (coordinateCount < 2) {
    if (fallback === 'per-line') {
      const perLine: RebuiltParagraph[] = usable.map((line) => ({
        page: line.page,
        text: line.text,
        lineCount: 1,
        left: line.x ?? 0,
        fontSize: line.size ?? 0,
        evidence: ['无坐标信息，按行成段'],
        confidence: 'low',
        kind: 'body',
      }));
      warnings.push('版式文件缺少坐标信息，无法重建段落：已按"每行一段"降级，段落需人工合并');
      return { paragraphs: perLine, strategy: 'fallback-per-line', warnings, stats: { inputLines: usable.length, visualLines: usable.length, paragraphs: perLine.length, high: 0, medium: 0, low: perLine.length } };
    }
    const pages = [...new Set(usable.map((line) => line.page))].sort((a, b) => a - b);
    const perPage: RebuiltParagraph[] = pages.map((page) => {
      const pageLines = usable.filter((line) => line.page === page);
      return {
        page,
        text: pageLines.reduce((acc, line) => joinLines(acc, line.text), ''),
        lineCount: pageLines.length,
        left: 0,
        fontSize: 0,
        evidence: ['无坐标信息，按页合并'],
        confidence: 'low',
        kind: 'body',
      };
    });
    warnings.push('版式文件缺少坐标信息，无法重建段落：已按"每页一段"降级，段落切分需人工整理');
    return { paragraphs: perPage, strategy: 'fallback-per-page', warnings, stats: { inputLines: usable.length, visualLines: usable.length, paragraphs: perPage.length, high: 0, medium: 0, low: perPage.length } };
  }

  const visualLines = buildVisualLines(usable);
  const paragraphs: RebuiltParagraph[] = [];

  const pageGroups = new Map<number, VisualLine[]>();
  for (const line of visualLines) {
    const bucket = pageGroups.get(line.page) ?? [];
    bucket.push(line);
    pageGroups.set(line.page, bucket);
  }

  let paragraphBreaks = 0;
  let titleCount = 0;

  for (const [page, bucket] of [...pageGroups.entries()].sort((a, b) => a[0] - b[0])) {
    /* 排序必须显式处理 NaN：缺坐标的行（y 为 NaN）要稳定排在页末，
       否则 `a.y - b.y` 会返回 NaN，排序结果未定义（文本顺序会随机漂移）。 */
    const ordered = [...bucket].sort(
      (a, b) => (Number.isFinite(a.y) ? a.y : Number.POSITIVE_INFINITY) - (Number.isFinite(b.y) ? b.y : Number.POSITIVE_INFINITY),
    );
    const withY = ordered.filter((line) => Number.isFinite(line.y));
    const gaps: number[] = [];
    for (let i = 1; i < withY.length; i += 1) gaps.push(withY[i]!.y - withY[i - 1]!.y);
    const baselineGap = estimateLineGap(gaps);
    const baselineSize = estimateBaseSize(withY.map((line) => line.size));
    const absoluteGap = baselineSize * absoluteGapRatio;
    const referenceGap = baselineGap > 0 && baselineGap <= absoluteGap ? baselineGap : absoluteGap;
    const usingAbsolute = !(baselineGap > 0 && baselineGap <= absoluteGap);

    let current: RebuiltParagraph | null = null;
    let currentLeft = withY[0]?.x ?? 0;
    /** 当前段首行的 x：用于计算"段内首行缩进"这一正向证据 */
    let currentFirstX = withY[0]?.x ?? 0;
    let previousLine: VisualLine | null = null;

    for (const line of ordered) {
      const evidence: string[] = [];
      let isTitle = false;

      /* 缺坐标的行无法参与几何判定：独立成段保留文本（丢弃会让正文凭空少一段，
         而"少了一段"在病历里意味着漏数据，远比"多切一段"严重）。  */
      if (!Number.isFinite(line.y)) {
        if (current) {
          paragraphs.push(current);
          current = null;
        }
        paragraphs.push({
          page,
          text: line.text,
          lineCount: 1,
          left: 0,
          fontSize: 0,
          evidence: ['该行缺少坐标信息，无法参与几何判定，按整段保留'],
          confidence: 'low',
          kind: 'body',
        });
        continue;
      }

      if (!current) {
        /* 页/文档的第一段没有"切分依据"（它就是开头），但字号大本身是正向证据：
           标题应当至少记为 medium，否则"第一段标题"永远显示低置信，low 比例失去提示意义。  */
        const looksTitle = line.size >= baselineSize * (1 + sizeRatio) && line.fragments === 1;
        current = {
          page,
          text: line.text,
          lineCount: 1,
          left: line.x,
          fontSize: line.size,
          evidence: looksTitle
            ? [`字号 ${line.size.toFixed(1)}pt ＞ 基准 ${baselineSize.toFixed(1)}pt × ${(1 + sizeRatio).toFixed(2)}（标题特征）`]
            : [],
          firstLineIndent: 0,
          confidence: looksTitle ? 'medium' : 'low',
          kind: looksTitle ? 'title' : 'body',
        };
        if (current.kind === 'title') titleCount += 1;
        currentLeft = line.x;
        currentFirstX = line.x;
        previousLine = line;
        continue;
      }

      const gap = previousLine ? line.y - previousLine.y : 0;
      const indent = line.x - currentLeft;
      const sizeBump = previousLine ? line.size - previousLine.size : 0;

      /* 线索 1：行距明显变大 */
      let gapBreak = false;
      if (referenceGap > 0 && gap > referenceGap * gapRatio) {
        gapBreak = true;
        evidence.push(
          usingAbsolute
            ? `段前间距 ${gap.toFixed(1)}pt ＞ 绝对判据 字号 ${baselineSize.toFixed(1)}pt × ${absoluteGapRatio} × ${gapRatio}（无段内行距可作基准）`
            : `段前间距 ${gap.toFixed(1)}pt ＞ 行距 ${referenceGap.toFixed(1)}pt × ${gapRatio}`,
        );
      }
      /* 线索 2：首行缩进（相对当前段左边界） */
      let indentBreak = false;
      if (indent >= line.size * indentRatio) {
        indentBreak = true;
        evidence.push(`首行缩进 ${indent.toFixed(1)}pt ≥ 字号 ${line.size.toFixed(1)}pt × ${indentRatio}`);
      }
      /* 线索 3：字号变大 → 标题（同时也意味着新块） */
      let sizeBreak = false;
      if (sizeBump >= line.size * sizeRatio && line.size >= baselineSize * (1 + sizeRatio)) {
        sizeBreak = true;
        isTitle = true;
        evidence.push(`字号放大 ${(sizeBump).toFixed(1)}pt（${previousLine?.size.toFixed(1)} → ${line.size.toFixed(1)}）`);
      }

      const shouldBreak = gapBreak || indentBreak || sizeBreak;
      if (shouldBreak) {
        paragraphs.push(current);
        paragraphBreaks += 1;
        /*  置信度属于新切出的段（它带着刚收集到的 evidence）。
           早期实现把 `current.confidence = ...` 写在 push 之后，结果设到了被切开的旧段上，
           新旧两段的置信度完全错位（实测：有两条证据的段显示 low，无证据的段显示 high）。  */
        current = {
          page,
          text: line.text,
          lineCount: 1,
          left: line.x,
          fontSize: line.size,
          evidence,
          confidence: evidence.length >= 2 ? 'high' : evidence.length === 1 ? 'medium' : 'low',
          firstLineIndent: 0,
          kind: isTitle ? 'title' : 'body',
        };
        if (isTitle) titleCount += 1;
        currentLeft = line.x;
        currentFirstX = line.x;
      } else {
        current.text = joinLines(current.text, line.text);
        current.lineCount += 1;
        current.fontSize = (current.fontSize * (current.lineCount - 1) + line.size) / current.lineCount;
      }
      /* 段左边界取段内最靠左的位置：正文段首行缩进时，若以首行为界，续行会变成"负缩进"，
         而下一段的首行相对它反而没有缩进 —— 缩进线索就此失效（实测踩到）。  */
      currentLeft = Math.min(currentLeft, line.x);
      current.left = currentLeft;
      /* 段内首行相对段左边界的内缩：> 0 说明"本段以缩进开头"，
         这是对本段成立的正向证据（与"凭什么切在这里"是两件事）。  */
      current.firstLineIndent = Math.max(0, currentFirstX - currentLeft);
      previousLine = line;
    }
    if (current) paragraphs.push(current);
  }

  /* 收尾：给没有"切分依据"的段补上正向证据，并如实定级。
     "本段以缩进开头"本身就是一条正向线索（medium）——
     否则每页的第一段都会因为"没有前文可依据"而被判成 low，low 比例虚高就失去提示价值。 */
  for (const paragraph of paragraphs) {
    const indentEvidence =
      paragraph.firstLineIndent !== undefined && paragraph.fontSize > 0 && paragraph.firstLineIndent >= paragraph.fontSize * indentRatio
        ? `本段首行缩进 ${paragraph.firstLineIndent.toFixed(1)}pt（段内特征）`
        : null;
    if (indentEvidence && !paragraph.evidence.some((item) => item.includes('段内特征'))) {
      paragraph.evidence.push(indentEvidence);
      if (paragraph.confidence === 'low') paragraph.confidence = 'medium';
    }
    if (paragraph.confidence === 'low' && paragraph.evidence.length === 0) {
      paragraph.evidence.push(paragraph.lineCount > 1 ? `未发现段落线索（${paragraph.lineCount} 行等距同缩进），仅为兜底合并` : '单行成段');
    }
  }

  if (paragraphBreaks === 0 && paragraphs.length === 1 && (paragraphs[0]?.lineCount ?? 0) > 1) {
    warnings.push(
      '版式文件未提供可辨的段落线索（行距均匀、无首行缩进）：已按页合并，段落边界需人工整理（导出端应写入段前间距与首行缩进）',
    );
  }
  warnings.push('段落为按几何线索的**启发式重建**，章节归属仍需人工整理');

  const stats = {
    inputLines: usable.length,
    visualLines: visualLines.length,
    paragraphs: paragraphs.length,
    high: paragraphs.filter((paragraph) => paragraph.confidence === 'high').length,
    medium: paragraphs.filter((paragraph) => paragraph.confidence === 'medium').length,
    low: paragraphs.filter((paragraph) => paragraph.confidence === 'low').length,
  };
  void titleCount;
  return { paragraphs, strategy: 'geometry', warnings, stats };
}
