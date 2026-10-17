/**
 * 医学表达式求值（K4 的"表达式"那一半）。
 *
 * ## 三条硬约束
 *
 * 1) **没有 `eval`、没有 `new Function`、没有解析器**。表达式是一棵 JSON 树，
 *    求值就是递归地查表调用。理由很直接：模板包来自外部（专科包要能独立交付），
 *    一旦它能带来可执行代码，"包是数据不是代码"这条纪律就整个失效了。
 * 2) **函数表是封闭的**。包里只能调用这里登记的函数；未知函数在**装载期**就被拒
 *    （`E_TPL_EXPR_UNKNOWN_FN`），不会等到某次求值才失败。
 * 3) **输入不足就返回 `null`，绝不编值**。身高没填，BMI 就是"算不出来"，
 *    不是 0、不是"用上一次的值"。给一个假的数远比给一个空更危险 ——
 *    假数会被当成测量结果，进而进机读信息、进签名范围。
 *
 * ## 为什么返回 `null` 而不是抛错
 *
 * 求值发生在**实例化**过程中，而"缺一个输入"是完全正常的中间状态（医生还没填完）。
 * 用异常表达它，会逼着调用方到处 try/catch，最后必然有人写成"catch 到就给 0"。
 * 用 `null` 表达，语义在类型里，忘了处理会编译不过。
 */

import type { ExprNode, ExprValue, TemplateContext } from './types.ts';

export const MAX_EXPR_DEPTH = 8;

export interface ExprFunction {
  name: string;
  minArgs: number;
  /** 变参用 `Number.POSITIVE_INFINITY` */
  maxArgs: number;
  /** 给人读的说明（界面与文档里展示"这个函数干什么"） */
  doc: string;
  /**
   * 计算。**输入不足或类型不符一律返回 `null`**，不抛错、不兜底。
   * 参数里的 `null` 表示"上游算不出来" —— 实现可以直接短路返回 null。
   */
  apply(args: Array<ExprValue | null>): ExprValue | null;
}

/* ------------------------------ 基础工具 ------------------------------ */

/** 把参数收敛成数字表；任何一个不是数字就返回 null（**不求助于隐式转换**） */
function nums(args: Array<ExprValue | null>): number[] | null {
  const out: number[] = [];
  for (const arg of args) {
    if (typeof arg !== 'number' || !Number.isFinite(arg)) return null;
    out.push(arg);
  }
  return out;
}

/** ISO8601 → 毫秒；解析不出来返回 null（**不用"当前时间"兜底**） */
function timeOf(value: ExprValue | null): number | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** 两元**数字**函数（算术类） */
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

/**
 * 两元**原值**函数（日期类）。
 *
 * 为什么必须与 `binary` 分开：日期在表达式里是**字符串**，套用 `nums`（只收数字）
 * 会让它们**永远**算不出来 —— 而表现是"这个派生值一直是空的"，和"还没填"长得一模一样。
 * 这一条是本项目实测踩到的：`weeksBetween` 最初走了 `nums`，孕周与年龄两个控件全部恒为 null，
 * 而"产物能通过校验"这一点完全看不出来（空值本身是合法的 field 值）。值域必须显式处理，不能靠隐式转换。
 */
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

/* ------------------------------- 函数表 ------------------------------- */

/**
 * 封闭函数表。新增函数必须同时：① 在这里登记；② 补用例。
 *
 * 刻意**不给**这些函数：`if`/`case`（会变成一门语言）、字符串拼接（不是计量）、
 * 任何带医学判断的成品（如 `egfrCkdEpi`）—— 后者看着省事，实际把"用哪条公式、
 * 哪一版"埋进代码里，而临床要的恰恰是"公式写在模板上、看得见、可替换"。
 */
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

/* ------------------------------- 求值 ------------------------------- */

export interface EvalScope {
  /** 同模板内**填写项**槽位 key → 值（未填为 null） */
  slots: Record<string, ExprValue | null>;
  /** 上下文（患者/就诊/时间） */
  context: TemplateContext;
}

/** 参数位置上的求值结果：`null` 表示"上游算不出来" */
function evaluateArgs(args: ExprNode[], scope: EvalScope, depth: number): Array<ExprValue | null> | null {
  if (depth > MAX_EXPR_DEPTH) return null;
  const out: Array<ExprValue | null> = [];
  for (const arg of args) out.push(evaluate(arg, scope, depth + 1));
  return out;
}

/**
 * 求值。任何一处算不出来（缺输入、类型不符、除零、日期非法）**整体返回 `null`**。
 *
 * 这条"一处算不出就整体算不出"是刻意的：表达式是复合量（BMI = 体重 ÷ 身高²），
 * 缺任何一项都不存在"部分正确"的答案。返回半成品会被误读成完整结果。
 */
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

/* ---------------------------- 依赖与描述 ---------------------------- */

/** 收集引用（用于回答"这个派生值依赖哪些填写项"，以及装载期校验引用是否真实存在） */
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

/**
 * 公式的人类可读形式（写进节点的派生依据）。
 *
 * 为什么要这一手：派生值最怕的是"结果在、公式不见了" —— 事后没人说得清这个 22.5
 * 是怎么来的。把公式连同"用了哪些填写项"一起写进证据链，才能复核。
 */
export function describeExpression(expr: ExprNode): string {
  if (expr.kind === 'num') return String(expr.value);
  if (expr.kind === 'slot' || expr.kind === 'ctx') return expr.key;
  return `${expr.name}(${expr.args.map(describeExpression).join(', ')})`;
}

/* ------------------------------ 校验 ------------------------------ */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 结构校验：返回问题清单（空数组 = 合法）。
 *
 * 返回清单而不是抛错，是因为装载期要把**同一份包里的多处错误一次报全** ——
 * 报一条改一条的体验会让写模板的人放弃。
 */
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
