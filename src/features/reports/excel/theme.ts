/**
 * The Excel workbook theme — the ONE styling vocabulary for every report
 * sheet (individual exports and the consolidated Report Pack alike).
 *
 * Design intent (implementation spec §15/§16): a minimal, conventional
 * accounting-register layout — the configured STORE is the primary heading
 * (never the application name), a clear title/meta hierarchy, restrained
 * header styling (a single light fill band with hairline rules), subtle
 * hairline row separators, right-aligned money with ₹ number formats, real
 * date cells, and bold totals with an accent rule. The worksheet view is a
 * single normal view with the background gridlines hidden (renderer.ts) —
 * no split or frozen panes, no AutoFilter chrome, no decorative colors, no
 * floating objects, no charts.
 */
import type { CellValue } from 'exceljs'

// ── Palette (slate scale + the app's single indigo accent) ───────────────────

export const C = {
  accent: 'FF4F46E5',
  accentDark: 'FF312E81',
  slate900: 'FF0F172A',
  slate700: 'FF334155',
  slate500: 'FF64748B',
  slate400: 'FF94A3B8',
  slate300: 'FFCBD5E1',
  slate200: 'FFE2E8F0',
  slate100: 'FFF1F5F9',
  slate50: 'FFF8FAFC',
  white: 'FFFFFFFF',
  gridline: 'FFE2E8F0',
} as const

// ── Number formats ───────────────────────────────────────────────────────────

/** Money columns: negative-safe with red negatives. */
export const FMT_MONEY = '"\u20B9"#,##0.00;[Red]-"\u20B9"#,##0.00'
export const FMT_INT = '#,##0'
export const FMT_DAYS = '#,##0'
export const FMT_DATE = 'dd mmm yyyy'

/** ExcelJS partial style objects (structurally valid at runtime). */
export type StyleObject = Record<string, unknown>

// ── Cell styles ──────────────────────────────────────────────────────────────

export interface CellStyle {
  value: CellValue
  font?: StyleObject
  fill?: StyleObject
  border?: StyleObject
  numFmt?: string
  alignment?: StyleObject
}

/** The store masthead — the business issuing the report. */
export function storeNameCell(value: string): CellStyle {
  return {
    value,
    font: { name: 'Calibri', size: 16, bold: true, color: { argb: C.slate900 } },
    alignment: { vertical: 'middle' },
  }
}

/** Store contact line ("address · phone"). */
export function storeContactCell(value: string): CellStyle {
  return {
    value,
    font: { name: 'Calibri', size: 9, color: { argb: C.slate500 } },
    alignment: { vertical: 'middle' },
  }
}

/** The report title (e.g. "Sales Register"). */
export function reportTitleCell(value: string): CellStyle {
  return {
    value,
    font: { name: 'Calibri', size: 13, bold: true, color: { argb: C.accentDark } },
    alignment: { vertical: 'middle' },
  }
}

/** The report meta line (period · FY · generated). */
export function metaLineCell(value: string): CellStyle {
  return {
    value,
    font: { name: 'Calibri', size: 9, color: { argb: C.slate500 } },
    alignment: { vertical: 'middle' },
  }
}

/** A block heading (e.g. "Payment States"). */
export function blockTitleCell(value: string): CellStyle {
  return {
    value,
    font: { name: 'Calibri', size: 10.5, bold: true, color: { argb: C.slate900 } },
    alignment: { vertical: 'middle' },
  }
}

/** A table header cell. */
export function headerCell(value: string, align: 'left' | 'right' | 'center'): CellStyle {
  return {
    value,
    font: { name: 'Calibri', size: 9.5, bold: true, color: { argb: C.slate700 } },
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: C.slate100 } },
    border: {
      top: { style: 'thin', color: { argb: C.slate300 } },
      bottom: { style: 'thin', color: { argb: C.slate300 } },
    },
    alignment: { vertical: 'middle', horizontal: align, wrapText: true },
  }
}

/** A data cell. */
export function bodyCell(opts: {
  value: CellValue
  numFmt?: string
  bold?: boolean
  color?: string
  align?: 'left' | 'right' | 'center'
  /** Wrap long text (rows auto-fit their height). */
  wrap?: boolean
}): CellStyle {
  const style: CellStyle = {
    value: opts.value,
    font: { name: 'Calibri', size: 10, bold: opts.bold ?? false, color: { argb: opts.color ?? C.slate700 } },
    border: { bottom: { style: 'hair', color: { argb: C.gridline } } },
    alignment: { vertical: 'middle', horizontal: opts.align ?? 'left', wrapText: opts.wrap ?? false },
  }
  if (opts.numFmt) style.numFmt = opts.numFmt
  return style
}

/** The totals row label cell. */
export function totalLabelCell(value: string): CellStyle {
  return {
    value,
    font: { name: 'Calibri', size: 10, bold: true, color: { argb: C.slate900 } },
    border: { top: { style: 'thin', color: { argb: C.accent } } },
    alignment: { vertical: 'middle' },
  }
}

/** The totals row value cell. */
export function totalValueCell(value: CellValue, numFmt?: string): CellStyle {
  return {
    value,
    numFmt,
    font: { name: 'Calibri', size: 10, bold: true, color: { argb: C.slate900 } },
    border: { top: { style: 'thin', color: { argb: C.accent } } },
    alignment: { vertical: 'middle', horizontal: 'right' },
  }
}

/** A summary-block label cell. */
export function summaryLabelCell(value: string): CellStyle {
  return {
    value,
    font: { name: 'Calibri', size: 10, color: { argb: C.slate500 } },
    border: { bottom: { style: 'hair', color: { argb: C.gridline } } },
    alignment: { vertical: 'middle' },
  }
}

/** A summary-block value cell. */
export function summaryValueCell(value: CellValue, numFmt?: string): CellStyle {
  return {
    value,
    numFmt,
    font: { name: 'Calibri', size: 10, bold: true, color: { argb: C.slate900 } },
    border: { bottom: { style: 'hair', color: { argb: C.gridline } } },
    alignment: { vertical: 'middle', horizontal: 'right' },
  }
}

/** An exclusion/semantics note cell. */
export function noteCell(value: string): CellStyle {
  return {
    value,
    font: { name: 'Calibri', size: 8, italic: true, color: { argb: C.slate400 } },
    alignment: { vertical: 'middle', wrapText: false },
  }
}

/** The empty-state cell. */
export function emptyStateCell(value: string): CellStyle {
  return {
    value,
    font: { name: 'Calibri', size: 10, italic: true, color: { argb: C.slate400 } },
    alignment: { vertical: 'middle', horizontal: 'center' },
    border: { top: { style: 'hair', color: { argb: C.gridline } }, bottom: { style: 'hair', color: { argb: C.gridline } } },
  }
}

// ── Layout constants ─────────────────────────────────────────────────────────

/** Standard row heights (points). */
export const ROW_HEIGHT = {
  storeName: 24,
  storeContact: 13,
  reportTitle: 19,
  metaLine: 13,
  blockTitle: 16,
  header: 20,
  data: 15,
  note: 12,
}

/**
 * Assigns a partial style object onto an ExcelJS cell. ExcelJS's own types
 * mark every style member required while accepting partials at runtime;
 * this is the single cast boundary for all theme styles.
 */
export function assignCellStyle(cell: object, style: CellStyle): void {
  const target = cell as {
    value: CellValue
    font?: unknown
    fill?: unknown
    border?: unknown
    numFmt?: string
    alignment?: unknown
  }
  target.value = style.value
  if (style.font) target.font = style.font
  if (style.fill) target.fill = style.fill
  if (style.border) target.border = style.border
  if (style.numFmt) target.numFmt = style.numFmt
  if (style.alignment) target.alignment = style.alignment
}

/** Formats an ISO timestamp for the "Generated" meta line. */
export function formatGeneratedAt(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}
