// 专科控件的格：键怎么算、一共有哪些格、每格是什么。

import type { ControlFieldSnapshot, ControlNode, FieldDataType, JsonValue } from './types.ts';

export const SERIES_DEFAULT_ROWS = 3;

/** `series` 的格键：`字段key.rN`（N 从 1 起） */
export function seriesCellKey(fieldKey: string, row: number): string {
  return `${fieldKey}.r${row}`;
}

/** `matrix` 的格键：`r行key.c列key`（与表格槽位的 `key.r1c1` 同一读取习惯） */
export function matrixCellKey(rowKey: string, columnKey: string): string {
  return `r${rowKey}.c${columnKey}`;
}

/**
 * 一格：键 + 它是什么。
 *
 * 界面上的每一格都从这里生成（含 label / 单位 / 取值域），于是
 * "医生看到的格子"与"写路径认的键"必然是同一份 —— 这正是要收在一处的原因。
  */
export interface ControlCell {
  /** payload 的键 */
  key: string;
  /** 它在定义里对应哪一格字段（matrix 没有：那一格是行×列的交点，字段只提供类型） */
  fieldKey?: string;
  /** 给人看的名字（series / matrix 已把行号或行列名并进去） */
  label: string;
  dataType: FieldDataType;
  unit?: string;
  /** 有取值域就是"从这几项里挑一个"，而不是自由填写 */
  valueSet?: Array<{ code: string; display?: string }>;
  required?: boolean;
  /** 机读摊平用（`model/machine.ts`）：带 tag 的格才产数据元 */
  tag?: ControlFieldSnapshot['tag'];
  /** series：这是第几条记录（1 起） */
  row?: number;
  rowKey?: string;
  rowLabel?: string;
  columnKey?: string;
  columnLabel?: string;
}

/** 控件里可填的格（顺序即界面上的顺序：字段序 → 行序） */
export type ControlGridNode = Pick<ControlNode, 'shape' | 'fields' | 'rows' | 'columns' | 'rowCount'>;

/** `series` 这份控件有几条记录行 */
export function seriesRowCount(node: Pick<ControlNode, 'rowCount'>): number {
  const count = node.rowCount;
  return typeof count === 'number' && Number.isFinite(count) && count > 0 ? Math.floor(count) : SERIES_DEFAULT_ROWS;
}

/** 一个字段 → 一格 */
function cellOfField(field: ControlFieldSnapshot, label: string): ControlCell {
  return {
    key: field.key,
    fieldKey: field.key,
    label,
    dataType: field.dataType,
    ...(field.unit ? { unit: field.unit } : {}),
    ...(field.valueSet && field.valueSet.length > 0 ? { valueSet: field.valueSet } : {}),
    ...(field.required ? { required: true } : {}),
    ...(field.tag ? { tag: field.tag } : {}),
  };
}

/**
 * 这个控件按形状一共有哪些格。
 *
 * 四种形状各走一条：
 *   - `scale` / `checklist` / `image`：字段即格（影像那一种，一格的值是资源引用）；
 *   - `series`：字段 × 行（每条记录各有一份同样的字段）；
 *   - `matrix`：行 × 列（取值类型取第一个字段的声明；没有字段就按布尔 —— 矩阵的
 *     常见用法正是"打点"：龋 / 充填 / 缺失各是一个布尔位）。
 */
export function controlCellsOf(node: ControlGridNode): ControlCell[] {
  const fields = node.fields ?? [];
  if (node.shape === 'matrix') {
    const rows = node.rows ?? [];
    const columns = node.columns ?? [];
    const type: FieldDataType = fields[0]?.dataType ?? 'boolean';
    const cells: ControlCell[] = [];
    for (const row of rows) {
      for (const column of columns) {
        cells.push({
          key: matrixCellKey(row.key, column.key),
          label: `${row.label} · ${column.label}`,
          dataType: type,
          ...(fields[0]?.unit ? { unit: fields[0].unit } : {}),
          ...(fields[0]?.valueSet && fields[0].valueSet.length > 0 ? { valueSet: fields[0].valueSet } : {}),
          rowKey: row.key,
          rowLabel: row.label,
          columnKey: column.key,
          columnLabel: column.label,
        });
      }
    }
    return cells;
  }
  if (node.shape === 'series') {
    const cells: ControlCell[] = [];
    const rowCount = seriesRowCount(node);
    for (let row = 1; row <= rowCount; row += 1) {
      for (const field of fields) {
        cells.push({ ...cellOfField(field, field.label), key: seriesCellKey(field.key, row), row });
      }
    }
    return cells;
  }
  /* `scale` / `checklist` / `image`：一格一个字段。
     影像与量表在这里是同一条规则不是巧合 —— "一格一张图"与"一格一个评分"在键上
     没有差别（都是字段 `key`），差别只在渲染器把它画成图还是画成输入框。  */
  return fields.map((field) => cellOfField(field, field.label));
}

/** 按 key 找一格（写路径的准入判定：认不出来的键一律拒） */
export function controlCellByKey(node: ControlGridNode, key: string): ControlCell | undefined {
  return controlCellsOf(node).find((cell) => cell.key === key);
}

/**
 * 某一格的值是否与它的 `dataType` 相符。
 *
 * 与 `template/engine.ts` 的 `matchesFieldType` 同一口径（数字给数字、是/否给布尔、
 * 其余给字符串），差别只有一处：`null` 在这里不合法 ——
 * 控件的"没填"是"没有这个键"（见本文件头），所以清空一格是删键，不是写 null。
 *
 * 它同时服务写路径（`core/session.ts` 的 `setControlValue`）与产物校验
 * （`model/validate.ts`）：两处各写一份的结果是"写得进去、校验不过"。
  */
export function matchesControlCellType(dataType: FieldDataType, value: JsonValue): boolean {
  if (value === null) return false;
  switch (dataType) {
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'expression':
      return typeof value === 'number' || typeof value === 'string';
    default:
      return typeof value === 'string';
  }
}
