// 极简测试框架（零依赖）。

export interface TestResult {
  name: string;
  ok: boolean;
  message: string;
  ms: number;
}

export class TestSuite {
  readonly results: TestResult[] = [];

  private readonly title: string;

  private readonly footers: string[];

  constructor(title: string, footers: string[] = []) {
    this.title = title;
    this.footers = footers;
  }

  async test(name: string, fn: () => void | Promise<void>): Promise<void> {
    const started = performance.now();
    try {
      await fn();
      this.results.push({ name, ok: true, message: '', ms: performance.now() - started });
    } catch (err) {
      this.results.push({ name, ok: false, message: (err as Error).message, ms: performance.now() - started });
    }
  }

  /** 打印报告并返回退出码（0 = 全部通过） */
  report(): number {
    const failed = this.results.filter((r) => !r.ok);
    const lines: string[] = [];
    lines.push('');
    lines.push(`${this.title}  |  Node ${process.version}`);
    lines.push('─'.repeat(78));
    for (const r of this.results) {
      lines.push(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  (${r.ms.toFixed(1)}ms)`);
      if (!r.ok) lines.push(`      ${r.message}`);
    }
    lines.push('─'.repeat(78));
    lines.push(`用例：${this.results.length}    通过：${this.results.length - failed.length}    失败：${failed.length}`);
    lines.push(`结论：${failed.length === 0 ? 'PASS' : 'FAIL'}`);
    if (this.footers.length > 0) {
      lines.push('');
      lines.push(...this.footers);
    }
    lines.push('');
    process.stdout.write(lines.join('\n'));
    return failed.length === 0 ? 0 : 1;
  }
}

export function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

function serialize(value: unknown): string {
  try {
    const text = JSON.stringify(value, (_key, item: unknown) => (typeof item === 'bigint' ? `${item.toString()}n` : item));
    return text ?? 'undefined';
  } catch (err) {
    return `<无法序列化：${(err as Error).message}>`;
  }
}

export function assertEqual(actual: unknown, expected: unknown, message: string): void {
  const a = serialize(actual);
  const b = serialize(expected);
  if (a !== b) throw new Error(`${message}：期望 ${b}，实际 ${a}`);
}

export async function codeOfAsync(fn: () => unknown | Promise<unknown>): Promise<string> {
  try {
    await fn();
    return 'OK';
  } catch (err) {
    return (err as { code?: string }).code ?? 'UNKNOWN';
  }
}

export function assertThrows(fn: () => unknown, predicate: (err: unknown) => boolean, message: string): void {
  let threw = false;
  try {
    fn();
  } catch (err) {
    if (predicate(err)) {
      threw = true;
    } else {
      throw new Error(`${message}：抛出的错误不符合预期（${(err as Error).message}）`);
    }
  }
  if (!threw) throw new Error(`${message}：期望抛出错误，但调用成功`);
}

/** 确定性随机数（保证回归可复现） */
export function makeRng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(rng: () => number, list: readonly T[]): T | null {
  if (list.length === 0) return null;
  return list[Math.floor(rng() * list.length) % list.length] as T;
}
