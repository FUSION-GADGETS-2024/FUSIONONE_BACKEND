/**
 * The shared Excel renderer — ONE generic engine that draws any report
 * dataset as professional worksheets (implementation spec §8–§9).
 *
 * Every worksheet of every export is produced by `renderReportSheet`,
 * driven purely by the normalized report dataset (features/reports/data.ts).
 * There is no per-report rendering code and no business calculation here.
 *
 * Standard worksheet layout (identical on every report sheet):
 *   row 1   the configured STORE name (the business issuing the report)
 *   row 2   store address · phone (when configured)
 *   row 3   the report title
 *   row 4   "Period: … · Financial Year: … · Generated: …"
 *           (snapshot reports: "As of: … · Financial Year: … · Generated: …")
 *   row 6+  the report blocks (tables with headers/rows/totals/notes and
 *           key/value summary blocks), one blank row between blocks
 *
 * Excel-native behavior on every sheet: a SINGLE NORMAL worksheet view —
 * no split panes, no frozen panes, no AutoFilter chrome — with the
 * background gridlines hidden for the clean, printable accounting-register
 * look; real numeric money cells with ₹ formats, real date cells
 * (timezone-exact UTC serials), right-aligned numbers, and fit-to-width
 * print setup with repeated header rows and a page-number footer. Empty
 * datasets keep their title, meta, headers and an explicit empty state —
 * never fake rows.
 */
import type { Worksheet, Workbook, CellValue } from 'exceljs'
import type { ColumnDef, ReportDataset, ReportMeta, ReportRow, SummaryBlock, TableBlock } from '../data'
import type { ReportSheet } from '../data'
import {
  assignCellStyle,
  blockTitleCell,
  bodyCell,
  emptyStateCell,
  FMT_DATE,
  FMT_INT,
  FMT_MONEY,
  formatGeneratedAt,
  headerCell,
  metaLineCell,
  noteCell,
  reportTitleCell,
  ROW_HEIGHT,
  storeContactCell,
  storeNameCell,
  summaryLabelCell,
  summaryValueCell,
  totalLabelCell,
  totalValueCell,
} from './theme'

// ── Column formatting ────────────────────────────────────────────────────────

function numFmtOf(type: ColumnDef['type']): string | undefined {
  switch (type) {
    case 'money':
      return FMT_MONEY
    case 'int':
    case 'days':
      return FMT_INT
    case 'date':
      return FMT_DATE
    default:
      return undefined
  }
}

function alignOf(col: ColumnDef): 'left' | 'right' | 'center' {
  if (col.align) return col.align
  switch (col.type) {
    case 'money':
    case 'int':
    case 'days':
      return 'right'
    case 'date':
    case 'status':
      return 'center'
    default:
      return 'left'
  }
}

/** Renders one cell value with the column's type semantics. */
function writeDataCell(ws: Worksheet, row: number, col: number, value: CellValue, column: ColumnDef): void {
  const isEmpty = value === null || value === undefined || value === ''
  const display: CellValue = isEmpty ? (column.type === 'text' ? '—' : null) : value
  assignCellStyle(
    ws.getCell(row, col),
    bodyCell({
      value: display,
      numFmt: numFmtOf(column.type),
      align: alignOf(column),
      // Text cells wrap so long joined item names never clip; wrapped
      // rows auto-fit because data rows carry no fixed height.
      wrap: column.type === 'text',
    }),
  )
}

// ── Worksheet geometry ───────────────────────────────────────────────────────

/** The number of worksheet columns a sheet spans (its widest table). */
function spanOf(sheet: ReportSheet): number {
  let span = 3
  for (const block of sheet.blocks) {
    if (block.kind === 'table') span = Math.max(span, block.columns.length)
    else span = Math.max(span, 4)
  }
  return span
}

/** Applies the column widths of the widest table to the worksheet. */
function applyWidths(ws: Worksheet, sheet: ReportSheet, span: number): void {
  const widest = sheet.blocks.reduce<TableBlock | null>(
    (best, block) => (block.kind === 'table' && (!best || block.columns.length > best.columns.length) ? block : best),
    null,
  )
  const widths = new Array<number>(span).fill(12)
  if (widest) {
    widest.columns.forEach((col, i) => {
      widths[i] = col.width
    })
  }
  ws.columns = widths.map((w) => ({ width: w }))
}

// ── The masthead ─────────────────────────────────────────────────────────────

/**
 * The standard heading block: store masthead (the business, not the
 * application), report title and the period (or As of) / FY / generated
 * meta line. The lines are NOT merged: each is a single left-aligned cell
 * whose text overflows into the empty cells beside it, so long store
 * names and the meta line never clip regardless of the sheet's column
 * widths. Returns the next free row (1-based).
 */
function renderMasthead(ws: Worksheet, meta: ReportMeta, title: string, asOf: string | undefined, span: number): number {
  let row = 1

  if (meta.storeName) {
    assignCellStyle(ws.getCell(row, 1), storeNameCell(meta.storeName.toUpperCase()))
    ws.getRow(row).height = ROW_HEIGHT.storeName
    row += 1

    if (meta.storeAddress || meta.storePhone) {
      const contact = [meta.storeAddress, meta.storePhone].filter(Boolean).join('  ·  ')
      assignCellStyle(ws.getCell(row, 1), storeContactCell(contact))
      ws.getRow(row).height = ROW_HEIGHT.storeContact
      row += 1
    }
  }

  assignCellStyle(ws.getCell(row, 1), reportTitleCell(title))
  ws.getRow(row).height = ROW_HEIGHT.reportTitle
  row += 1

  const when = asOf ? `As of: ${formatDateLabelText(asOf)}` : `Period: ${meta.periodLabel}`
  const metaLine = `${when}   ·   Financial Year: ${meta.fyLabel}   ·   Generated: ${formatGeneratedAt(meta.generatedAt)}`
  assignCellStyle(ws.getCell(row, 1), metaLineCell(metaLine))
  ws.getRow(row).height = ROW_HEIGHT.metaLine
  row += 2 // one blank spacer row after the masthead

  void span
  return row
}

// ── Blocks ───────────────────────────────────────────────────────────────────

/** Renders one summary block; returns the next free row. */
function renderSummaryBlock(ws: Worksheet, block: SummaryBlock, span: number, startRow: number): number {
  let row = startRow
  if (block.title) {
    assignCellStyle(ws.getCell(row, 1), blockTitleCell(block.title))
    ws.getRow(row).height = ROW_HEIGHT.blockTitle
    row += 1
  }
  for (const entry of block.rows) {
    assignCellStyle(ws.getCell(row, 1), summaryLabelCell(entry.label))
    const valueStyle = summaryValueCell(entry.value ?? '—', numFmtOf(entry.type))
    assignCellStyle(ws.getCell(row, span), valueStyle)
    ws.getRow(row).height = ROW_HEIGHT.data
    row += 1
  }
  for (const note of block.notes ?? []) {
    assignCellStyle(ws.getCell(row, 1), noteCell(note))
    ws.getRow(row).height = ROW_HEIGHT.note
    row += 1
  }
  return row
}

interface PrimaryTableInfo {
  headerRow: number
  lastDataRow: number
  columnCount: number
  hasRows: boolean
}

/** Renders one table block; returns the next free row + primary info. */
function renderTableBlock(
  ws: Worksheet,
  block: TableBlock,
  startRow: number,
): { nextRow: number; info: PrimaryTableInfo } {
  let row = startRow
  if (block.title) {
    assignCellStyle(ws.getCell(row, 1), blockTitleCell(block.title))
    ws.getRow(row).height = ROW_HEIGHT.blockTitle
    row += 1
  }

  // Header row
  const headerRow = row
  block.columns.forEach((col, i) => {
    assignCellStyle(ws.getCell(row, i + 1), headerCell(col.header, alignOf(col)))
  })
  ws.getRow(row).height = ROW_HEIGHT.header
  row += 1

  // Data rows (or the explicit empty state). No fixed height: wrapped
  // cells auto-fit their rows.
  const hasRows = block.rows.length > 0
  if (!hasRows) {
    ws.mergeCells(row, 1, row, block.columns.length)
    assignCellStyle(ws.getCell(row, 1), emptyStateCell('No records in this reporting period.'))
    ws.getRow(row).height = ROW_HEIGHT.data
    row += 1
  } else {
    for (const dataRow of block.rows) {
      block.columns.forEach((col, i) => {
        writeDataCell(ws, row, i + 1, (dataRow as ReportRow)[col.key] ?? null, col)
      })
      row += 1
    }
  }
  const lastDataRow = row - 1

  // Totals row (only when there is data to total and at least one
  // totalizable column exists). Rows flagged by `internalRowKey` are
  // INTERNAL movements — listed in the register but excluded from the
  // totals (the Money Register's transfers / opening balances).
  if (hasRows && block.totalsLabel) {
    const totalizable = block.columns.filter((col) => col.total)
    if (totalizable.length > 0) {
      const isInternal = block.internalRowKey
        ? (r: ReportRow) => Boolean(r[block.internalRowKey as string])
        : () => false
      // The label sits in the first column; totals render in their columns.
      assignCellStyle(ws.getCell(row, 1), totalLabelCell(block.totalsLabel))
      block.columns.forEach((col, i) => {
        if (i === 0) return
        if (col.total) {
          const sum = block.rows.reduce<number>((acc, r) => {
            if (isInternal(r)) return acc
            const v = (r as ReportRow)[col.key]
            return typeof v === 'number' ? acc + v : acc
          }, 0)
          assignCellStyle(ws.getCell(row, i + 1), totalValueCell(sum, numFmtOf(col.type)))
        } else {
          assignCellStyle(ws.getCell(row, i + 1), totalValueCell(null))
        }
      })
      ws.getRow(row).height = ROW_HEIGHT.data
      row += 1
    }
  }

  // Notes (single overflowing cells — never merged, never clipped)
  for (const note of block.notes ?? []) {
    assignCellStyle(ws.getCell(row, 1), noteCell(note))
    ws.getRow(row).height = ROW_HEIGHT.note
    row += 1
  }

  return { nextRow: row, info: { headerRow, lastDataRow, columnCount: block.columns.length, hasRows } }
}

// ── Print setup ──────────────────────────────────────────────────────────────

/** Standard print setup: fit-to-width, repeated header rows, footer. */
function applyPrintSetup(ws: Worksheet, primary: PrimaryTableInfo | null): void {
  const orientation = primary && primary.columnCount >= 7 ? 'landscape' : 'portrait'
  ws.pageSetup = {
    ...ws.pageSetup,
    orientation,
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    paperSize: 9, // A4
    horizontalCentered: false,
    margins: { left: 0.4, right: 0.4, top: 0.55, bottom: 0.55, header: 0.2, footer: 0.25 },
  }
  // Repeat the register header row (and the masthead above it) on every
  // printed page.
  if (primary && primary.headerRow > 1) {
    ws.pageSetup.printTitlesRow = `1:${primary.headerRow}`
  }
  ws.headerFooter = { oddFooter: 'Page &P of &N' }
}

// ── The renderer ─────────────────────────────────────────────────────────────

/** "12 Oct 2026" from a YYYY-MM-DD value (no timezone math). */
function formatDateLabelText(value: string): string {
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const [y, m, d] = (value ?? '').slice(0, 10).split('-')
  const mi = Number(m) - 1
  if (!y || Number.isNaN(mi) || !d) return (value ?? '').slice(0, 10)
  return `${Number(d)} ${MONTHS[mi]} ${y}`
}

/**
 * Renders ONE report sheet onto the given workbook using the standard
 * professional layout. `title` is the sheet's heading (the report title);
 * `asOf` (snapshot reports) switches the masthead to the As-of line.
 * Returns the worksheet.
 */
export function renderReportSheet(
  wb: Workbook,
  meta: ReportMeta,
  title: string,
  sheet: ReportSheet,
  asOf?: string,
): Worksheet {
  const ws = wb.addWorksheet(sheet.name)

  // The worksheet VIEW — assigned once, in the simplest possible
  // conventional form: ONE normal view with the background gridlines
  // hidden. Deliberately NO pane element (no split, no frozen region, no
  // second view of the sheet in any viewer) and NO AutoFilter (no dropdown
  // arrows on the header row) — the clean, printable business-register
  // presentation. ExcelJS emits exactly
  //   <sheetViews><sheetView showGridLines="0" workbookViewId="0"/></sheetViews>
  // for this configuration.
  ws.views = [{ showGridLines: false }]

  const span = spanOf(sheet)
  applyWidths(ws, sheet, span)

  let row = renderMasthead(ws, meta, title, asOf, span)

  // The primary register: the FIRST table block (drives print setup).
  let primary: PrimaryTableInfo | null = null

  for (const block of sheet.blocks) {
    if (block.kind === 'table') {
      const { nextRow, info } = renderTableBlock(ws, block, row)
      if (!primary) primary = info
      row = nextRow + 1 // one blank row between blocks
    } else {
      row = renderSummaryBlock(ws, block, span, row) + 1
    }
  }

  applyPrintSetup(ws, primary)
  return ws
}

/**
 * Renders EVERY sheet of one report dataset (in declared order) onto the
 * given workbook — the multi-sheet composition used by every export.
 * Snapshot reports carry their As-of date; period reports show the
 * validated period. Returns the worksheets in order.
 */
export function renderReportSheets(
  wb: Workbook,
  meta: ReportMeta,
  dataset: ReportDataset,
): Worksheet[] {
  return dataset.sheets.map((sheet) => renderReportSheet(wb, meta, dataset.title, sheet, dataset.asOf))
}
