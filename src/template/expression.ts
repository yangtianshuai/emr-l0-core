import type { ExprNode, ExprValue, TemplateContext } from './types.ts';

export const MAX_EXPR_DEPTH = 8;

export interface ExprFunction {
  name: string;
  minArgs: number;
  maxArgs: number;
  doc: string;
  apply(args: Array<ExprValue | null>): ExprValue | null;
}

function nums(args: Array<ExprValue | null>): number[] | null {
  const out: number[] = [];
  for (const arg of args) {
    if (typeof arg !== 'number' || !Number.isFinite(arg)) return null;
    out.push(arg);
  }
  return out;
}

function timeOf(value: ExprValue | null): number | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function binary(name: string, doc: string, fn: (a: number, b: number) => number | null): ExprFunction {
  return {
    name,
    minArgs: 2,
    maxArgs: 2,
    doc,
    apply(args) {
      const values = nums(args);
      if (!values) return null;
      const [a, b] = values as [number, number];
      const result = fn(a, b);
      return result === null || !Number.isFinite(result) ? null : result;
    },
  };
}

function binaryRaw(name: string, doc: string, fn: (a: ExprValue, b: ExprValue) => number | null): ExprFunction {
  return {
    name,
    minArgs: 2,
    maxArgs: 2,
    doc,
    apply(args) {
      const [a, b] = args as [ExprValue | null, ExprValue | null];
      if (a === null || b === null) return null;
      const result = fn(a, b);
      return result === null || !Number.isFinite(result) ? null : result;
    },
  };
}

export const EXPR_FUNCTIONS: Record<string, ExprFunction> = {
  add: {
    name: 'add',
    minArgs: 1,
    maxArgs: Number.POSITIVE_INFINITY,
    doc: '求和（≥1 个数字）',
    apply(args) {
      const values = nums(args);
      return values ? values.reduce((sum, value) => sum + value, 0) : null;
    },
  },
  sub: binary('sub', '相减（a - b）', (a, b) => a - b),
  mul: {
    name: 'mul',
    minArgs: 1,
    maxArgs: Number.POSITIVE_INFINITY,
    doc: '求积（≥1 个数字）',
    apply(args) {
      const values = nums(args);
      return values ? values.reduce((product, value) => product * value, 1) : null;
    },
  },
  div: binary('div', '相除（a ÷ b）；除数为 0 返回"算不出"', (a, b) => (b === 0 ? null : a / b)),
  pow: binary('pow', '幂（a 的 b 次方）', (a, b) => a ** b),
  round: {
    name: 'round',
    minArgs: 2,
    maxArgs: 2,
    doc: '四舍五入到指定小数位（0~6）',
    apply(args) {
      const values = nums(args);
      if (!values) return null;
      const [value, digits] = values as [number, number];
      if (!Number.isInteger(digits) || digits < 0 || digits > 6) return null;
      const factor = 10 ** digits;
      return Math.round(value * factor) / factor;
    },
  },
  min: {
    name: 'min',
    minArgs: 1,
    maxArgs: Number.POSITIVE_INFINITY,
    doc: '最小值',
    apply(args) {
      const values = nums(args);
      return values ? Math.min(...values) : null;
    },
  },
  max: {
    name: 'max',
    minArgs: 1,
    maxArgs: Number.POSITIVE_INFINITY,
    doc: '最大值',
    apply(args) {
      const values = nums(args);
      return values ? Math.max(...values) : null;
    },
  },
  daysBetween: binaryRaw('daysBetween', '两个时间的间隔天数（后 - 前，向下取整）', (a, b) => {
    const from = timeOf(a);
    const to = timeOf(b);
    if (from === null || to === null) return null;
    return Math.floor((to - from) / DAY_MS);
  }),
  weeksBetween: binaryRaw('weeksBetween', '两个时间的间隔周数（向下取整）；孕周 / 病程周数用它', (a, b) => {
    const from = timeOf(a);
    const to = timeOf(b);
    if (from === null || to === null) return null;
    return Math.floor((to - from) / DAY_MS / 7);
  }),
  ageYears: binaryRaw('ageYears', '按出生日期与指定时刻计算周岁（用 UTC，避免时区把生日算错一天）', (birth, at) => {
    const from = timeOf(birth);
    const to = timeOf(at);
    if (from === null || to === null) return null;
    const birthDate = new Date(from);
    const atDate = new Date(to);
    let years = atDate.getUTCFullYear() - birthDate.getUTCFullYear();
    const monthDiff = atDate.getUTCMonth() - birthDate.getUTCMonth();
    if (monthDiff < 0 || (monthDiff === 0 && atDate.getUTCDate() < birthDate.getUTCDate())) years -= 1;
    return years >= 0 ? years : null;
  }),
};

export interface EvalScope {
  slots: Record<string, ExprValue | null>;
  context: TemplateContext;
}

function evaluateArgs(args: ExprNode[], scope: EvalScope, depth: number): Array<ExprValue | null> | null {
  if (depth > MAX_EXPR_DEPTH) return null;
  const out: Array<ExprValue | null> = [];
  for (const arg of args) out.push(evaluate(arg, scope, depth + 1));
  return out;
}

export function evaluate(expr: ExprNode, scope: EvalScope, depth = 0): ExprValue | null {
  if (depth > MAX_EXPR_DEPTH) return null;
  if (expr.kind === 'num') return Number.isFinite(expr.value) ? expr.value : null;
  if (expr.kind === 'slot') {
    const value = scope.slots[expr.key];
    return value === undefined ? null : value;
  }
  if (expr.kind === 'ctx') {
    const value = scope.context[expr.key];
    return value === undefined ? null : value;
  }
  const fn = EXPR_FUNCTIONS[expr.name];
  if (!fn) return null;
  const args = evaluateArgs(expr.args, scope, depth);
  if (!args) return null;
  return fn.apply(args);
}

export function collectExpressionRefs(expr: ExprNode): { slots: string[]; context: string[] } {
  const slots = new Set<string>();
  const context = new Set<string>();
  const walk = (node: ExprNode): void => {
    if (node.kind === 'slot') slots.add(node.key);
    else if (node.kind === 'ctx') context.add(node.key);
    else if (node.kind === 'fn') for (const arg of node.args) walk(arg);
  };
  walk(expr);
  return { slots: [...slots].sort(), context: [...context].sort() };
}

export function describeExpression(expr: ExprNode): string {
  if (expr.kind === 'num') return String(expr.value);
  if (expr.kind === 'slot' || expr.kind === 'ctx') return expr.key;
  return `${expr.name}(${expr.args.map(describeExpression).join(', ')})`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function validateExpression(expr: unknown, path: string, depth = 0): string[] {
  if (depth > MAX_EXPR_DEPTH) return [`${path}: 表达式嵌套超过 ${MAX_EXPR_DEPTH} 层`];
  if (!isPlainObject(expr)) return [`${path}: 表达式必须是对象`];

  const kind = expr.kind;
  if (kind === 'num') {
    return typeof expr.value === 'number' && Number.isFinite(expr.value) ? [] : [`${path}.value: 必须是有限数字`];
  }
  if (kind === 'slot' || kind === 'ctx') {
    return typeof expr.key === 'string' && expr.key.trim() !== '' ? [] : [`${path}.key: 必须是非空字符串`];
  }
  if (kind === 'fn') {
    if (typeof expr.name !== 'string' || !EXPR_FUNCTIONS[expr.name]) {
      return [`${path}.name: 未知函数「${String(expr.name)}」（可用：${Object.keys(EXPR_FUNCTIONS).join(' / ')}）`];
    }
    if (!Array.isArray(expr.args)) return [`${path}.args: 必须是数组`];
    const fn = EXPR_FUNCTIONS[expr.name];
    const issues: string[] = [];
    if (expr.args.length < fn.minArgs || expr.args.length > fn.maxArgs) {
      const max = fn.maxArgs === Number.POSITIVE_INFINITY ? '不限' : String(fn.maxArgs);
      issues.push(`${path}.args: ${expr.name} 需要 ${fn.minArgs}~${max} 个参数，实际 ${expr.args.length} 个（${fn.doc}）`);
    }
    expr.args.forEach((arg, index) => issues.push(...validateExpression(arg, `${path}.args[${index}]`, depth + 1)));
    return issues;
  }
  return [`${path}.kind: 未知节点类型「${String(kind)}」（只支持 num / slot / ctx / fn）`];
}
