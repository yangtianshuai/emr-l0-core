/**
 * 极简测试框架（零依赖）。
 *
 * 设计取向：
 *   - 断言失败必须给出"期望 vs 实际"，否则排错成本高；
 *   - 每条用例记录耗时（性能回归常先在单测里露头）；
 *   - report() 直接返回退出码，便于 CI 与 npm scripts 串联。
 */

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

/**
 * BigInt 安全的序列化。
 * 直接 `JSON.stringify` 遇到 BigInt 会抛 "Do not know how to serialize a BigInt" ——
 * 密码学用例里到处都是大数（私钥、签名 r/s、模数），断言工具必须先能表示它们，
 * 否则失败信息会变成"工具报错"而不是"期望 vs 实际"，排错方向立刻被带偏。
 */
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

/**
 * 异步版"取错误码"。
 *
 * 为什么必须单独有一个：签章链路改成可异步之后（签名后端可能是网络服务或密码设备），
 * `codeOf(() => session.sign(...))` 会**静默失效** —— async 函数抛错表现为 rejected Promise，
 * 而不是同步抛出，于是断言拿到 `undefined`，"签章应当被拒"这条用例**假装通过了**。
 * 这类失效连类型检查都抓不到（返回值被丢弃），只能靠显式的异步版本避免。
 */
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
