import type { ControlFieldSnapshot, ControlNode, FieldDataType, JsonValue } from './types.ts';

export const SERIES_DEFAULT_ROWS = 3;

export function seriesCellKey(fieldKey: string, row: number): string {
  return `${fieldKey}.r${row}`;
}

export function matrixCellKey(rowKey: string, columnKey: string): string {
  return `r${rowKey}.c${columnKey}`;
}

export interface ControlCell {
  key: string;
  fieldKey?: string;
  label: string;
  dataType: FieldDataType;
  unit?: string;
  valueSet?: Array<{ code: string; display?: string }>;
  required?: boolean;
  tag?: ControlFieldSnapshot['tag'];
  row?: number;
  rowKey?: string;
  rowLabel?: string;
  columnKey?: string;
  columnLabel?: string;
}

export type ControlGridNode = Pick<ControlNode, 'shape' | 'fields' | 'rows' | 'columns' | 'rowCount'>;

export function seriesRowCount(node: Pick<ControlNode, 'rowCount'>): number {
  const count = node.rowCount;
  return typeof count === 'number' && Number.isFinite(count) && count > 0 ? Math.floor(count) : SERIES_DEFAULT_ROWS;
}

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
  return fields.map((field) => cellOfField(field, field.label));
}

/** 按 key 找一格（写路径的准入判定：认不出来的键一律拒） */
export function controlCellByKey(node: ControlGridNode, key: string): ControlCell | undefined {
  return controlCellsOf(node).find((cell) => cell.key === key);
}

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
