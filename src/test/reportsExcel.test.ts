/**
 * The Excel workbooks — structural verification of the shared renderer and
 * the five report definitions (implementation spec §§7–§9, 12.3).
 *
 * The tests generate ACTUAL workbooks from the controlled scenario and
 * verify them as workbooks: sheet names and order, the store-branding
 * masthead (the configured store — never the application name as business
 * heading), the exact column orders, Item Name immediately after the
 * document number, the absence of quantity columns, real numeric ₹ cells,
 * real date cells with TIMEZONE-EXACT integer serials (the 31-Mar-2027-in-
 * FY-2027-28 defect regression), the single NORMAL worksheet view with no
 * pane and no AutoFilter anywhere, hidden background gridlines, print setup
 * with repeated header rows, totals that reconcile with the data rows
 * (internal ledger movements excluded), honest empty states, and the
 * specified filenames.
 *
 * Structural checks read the generated files BOTH through ExcelJS (values,
 * formats, structure) and through the raw OOXML zip (views, gridlines,
 * print titles, absence of filters/panes/charts/drawings) — belt and
 * braces.
 */
import { describe, it, expect } from 'vitest'
import { unzipSync, strFromU8 } from 'fflate'
import ExcelJS from 'exceljs'
import { buildReportDatasets } from '@/features/reports/data'
import type { ReportDataset, TableBlock } from '@/features/reports/data'
import { buildReportWorkbook } from '@/features/reports/excel/workbook'
import { FMT_MONEY, FMT_DATE } from '@/features/reports/excel/theme'
import { makeFold, FULL_FY, FY, STORE, TODAY, GENERATED_AT } from './reportsFixture'

const bundle = buildReportDatasets({
  fold: makeFold(),
  period: FULL_FY,
  store: STORE,
  fy: FY,
  today: TODAY,
  generatedAt: GENERATED_AT,
})

const META = bundle.meta

async function workbookOf(id: keyof typeof bundle.reports): Promise<{ wb: ExcelJS.Workbook; bytes: Uint8Array }> {
  const bytes = await buildReportWorkbook(META, bundle.reports[id] as ReportDataset)
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(bytes.slice().buffer as ArrayBuffer)
  return { wb, bytes }
}

// ── Raw OOXML helpers ────────────────────────────────────────────────────────

function sheetXml(bytes: Uint8Array, wsName: string): string {
  const zip = unzipSync(bytes)
  const wbXml = strFromU8(zip['xl/workbook.xml'])
  const relsXml = strFromU8(zip['xl/_rels/workbook.xml.rels'])
  if (!wbXml.includes(wsName)) throw new Error(`worksheet "${wsName}" not in workbook`)
  // Map the sheet name → rId → target file via the relationship entries.
  const sheetTag = wbXml.match(new RegExp(`<sheet[^>]*name="${wsName}"[^>]*/>`))?.[0] ?? ''
  const rid = sheetTag.match(/r:id="([^"]+)"/)?.[1] ?? ''
  const relTag = relsXml.match(new RegExp(`<Relationship[^>]*Id="${rid}"[^>]*/>`))?.[0] ?? ''
  const target = relTag.match(/Target="([^"]+)"/)?.[1] ?? ''
  const path = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\.\//, '')}`
  const xml = zip[path]
  if (!xml) throw new Error(`sheet part "${path}" not found`)
  return strFromU8(xml)
}

function zipEntries(bytes: Uint8Array): string[] {
  return Object.keys(unzipSync(bytes))
}
void zipEntries

/** The header row of the first table block on a sheet (row = first row
 *  whose first cell matches a known column header of the dataset). */
function headerRowOf(ws: ExcelJS.Worksheet, dataset: ReportDataset, sheetIndex: number): number {
  const block = dataset.sheets[sheetIndex].blocks.find((b) => b.kind === 'table') as TableBlock
  const firstHeader = block.columns[0].header
  for (let r = 1; r <= 12; r++) {
    if (ws.getCell(r, 1).value === firstHeader) return r
  }
  throw new Error('header row not found')
}

const headersOf = (ws: ExcelJS.Worksheet, row: number, count: number) =>
  Array.from({ length: count }, (_, i) => String(ws.getCell(row, i + 1).value ?? ''))

// ── Shared structural expectations ───────────────────────────────────────────

describe('every workbook: masthead and metadata', () => {
  it('brands the heading with the configured store, never the application name', async () => {
    for (const id of ['business-summary', 'sales-register', 'money-register', 'inventory-snapshot', 'inventory-acquisitions', 'purchase-register'] as const) {
      const { wb } = await workbookOf(id)
      const ws = wb.worksheets[0]
      const a1 = String(ws.getCell(1, 1).value ?? '')
      expect(a1).toBe('ABC MOBILE STORE')
      expect(a1.includes('FUSION ONE')).toBe(false)
      expect(String(ws.getCell(2, 1).value ?? '')).toContain('12 Market Road')
      expect(String(ws.getCell(2, 1).value ?? '')).toContain('+919900112233')
    }
  })

  it('carries the report title and the period or As-of meta line', async () => {
    const sales = await workbookOf('sales-register')
    const salesTitle = String(sales.wb.worksheets[0].getCell(3, 1).value ?? '')
    expect(salesTitle).toBe('Sales Register')
    const salesMeta = String(sales.wb.worksheets[0].getCell(4, 1).value ?? '')
    expect(salesMeta).toContain('Period: 1 Apr 2026 – 31 Mar 2027')
    expect(salesMeta).toContain('FY 2026–2027')

    const snapshot = await workbookOf('inventory-snapshot')
    const snapshotMeta = String(snapshot.wb.worksheets[0].getCell(4, 1).value ?? '')
    expect(snapshotMeta).toContain('As of: 6 Dec 2026')
    expect(snapshotMeta).not.toContain('Period:')
  })

  it('sets the workbook file metadata to the configured store', async () => {
    const { wb } = await workbookOf('money-register')
    expect(wb.creator).toBe('ABC Mobile Store')
  })
})

// ── Business Summary ─────────────────────────────────────────────────────────

describe('Business Summary workbook', () => {
  it('has exactly one Summary worksheet with the six metrics as real numbers', async () => {
    const { wb } = await workbookOf('business-summary')
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Summary'])
    const ws = wb.worksheets[0]
    const text = (r: number) => String(ws.getCell(r, 1).value ?? '')
    // Period Activity block (rows found by label).
    const findRow = (label: string) => {
      for (let r = 1; r <= 30; r++) if (text(r) === label) return r
      throw new Error(`label ${label} not found`)
    }
    const valueOf = (label: string) => ws.getCell(findRow(label), 4).value
    expect(valueOf('Sales Value')).toBe(172998)
    expect(valueOf('Purchase Value')).toBe(228500)
    expect(valueOf('Payments Received')).toBe(125998)
    expect(valueOf('Payments Made')).toBe(113500)
    expect(valueOf('Customer Outstanding')).toBe(56999)
    expect(valueOf('Supplier Outstanding')).toBe(75000)
    expect(valueOf('In-stock inventory records')).toBe(4)
    expect(valueOf('Recorded acquisition cost of in-stock inventory')).toBe(35000)
    // ₹ numeric formatting on the money values.
    expect(ws.getCell(findRow('Sales Value'), 4).numFmt).toBe(FMT_MONEY)
    expect(ws.getCell(findRow('In-stock inventory records'), 4).numFmt).toBe('#,##0')
  })
})

// ── Sales Register ───────────────────────────────────────────────────────────

describe('Sales Register workbook', () => {
  const DATASET = bundle.reports['sales-register']

  it('has the two worksheets in the specified order', async () => {
    const { wb } = await workbookOf('sales-register')
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Sales Register', 'Sale Items'])
  })

  it('renders the exact column order with Item Name immediately after Invoice No.', async () => {
    const { wb } = await workbookOf('sales-register')
    const ws = wb.worksheets[0]
    const headerRow = headerRowOf(ws, DATASET, 0)
    expect(headersOf(ws, headerRow, 8)).toEqual([
      'Date', 'Invoice No.', 'Item Name', 'Customer', 'Total Amount', 'Received', 'Balance', 'Status',
    ])
  })

  it('writes real date cells with TIMEZONE-EXACT integer Excel serials', async () => {
    const { wb, bytes } = await workbookOf('sales-register')
    const ws = wb.worksheets[0]
    const headerRow = headerRowOf(ws, DATASET, 0)
    const firstDataRow = headerRow + 1
    // The first row is the 1 Apr 2026 boundary sale.
    expect(ws.getCell(firstDataRow, 1).value instanceof Date).toBe(true)
    const d = ws.getCell(firstDataRow, 1).value as Date
    expect(d.getUTCFullYear()).toBe(2026)
    expect(d.getUTCMonth()).toBe(3)
    expect(d.getUTCDate()).toBe(1)
    expect(ws.getCell(firstDataRow, 5).value).toBe(15999)
    expect(ws.getCell(firstDataRow, 5).numFmt).toBe(FMT_MONEY)
    expect(ws.getCell(firstDataRow, 1).numFmt).toBe(FMT_DATE)

    // THE REGRESSION (the "31 March 2027 invoice inside the FY 2027-28
    // register" defect): ExcelJS serializes a Date from its raw UTC
    // milliseconds, so the serial MUST be the exact integer day. The raw
    // XML value proves it with no library normalization in between — a
    // local-midnight Date (the old form) would serialize as a fractional
    // previous-day serial in any timezone ahead of UTC (IST: 18:30).
    const xml = sheetXml(bytes, 'Sales Register')
    const serialOf = (cellRef: string) => {
      const m = xml.match(new RegExp(`<c r="${cellRef}"[^>]*><v>([^<]+)</v>`))
      if (!m) throw new Error(`cell ${cellRef} not found in sheet XML`)
      return m[1]
    }
    const excelDay = (y: number, m0: number, day: number) =>
      25569 + Date.UTC(y, m0, day) / 86_400_000
    const first = serialOf(`A${firstDataRow}`)
    expect(Number(first)).toBe(excelDay(2026, 3, 1))
    expect(first).not.toContain('.') // an integer day — no hidden time part
    // The FY-END boundary sale (31 March 2027) keeps its exact day too.
    const last = serialOf(`A${headerRow + 7}`)
    expect(Number(last)).toBe(excelDay(2027, 2, 31))
    expect(last).not.toContain('.')
  })

  it('places the reconciled totals row directly below the transaction rows', async () => {
    const { wb } = await workbookOf('sales-register')
    const ws = wb.worksheets[0]
    // 7 data rows below the header, then the totals row.
    const headerRow = headerRowOf(ws, DATASET, 0)
    const totalsRow = headerRow + 8
    expect(String(ws.getCell(totalsRow, 1).value ?? '')).toContain('Total')
    expect(ws.getCell(totalsRow, 5).value).toBe(172998)
    expect(ws.getCell(totalsRow, 6).value).toBe(115999)
    expect(ws.getCell(totalsRow, 7).value).toBe(56999)
  })

  it('keeps print titles and page footer with no charts or drawings', async () => {
    const { bytes } = await workbookOf('sales-register')
    // Repeated header rows on printed pages live in the WORKBOOK part
    // (_xlnm.Print_Titles), the page footer on the sheet.
    const zip = unzipSync(bytes)
    const wbXml = strFromU8(zip['xl/workbook.xml'])
    expect(wbXml).toMatch(/_xlnm\.Print_Titles/)
    const xml = sheetXml(bytes, 'Sales Register')
    expect(xml).toMatch(/&amp;P of &amp;N|&P of &N/)
    const entries = Object.keys(zip)
    expect(entries.some((e) => e.includes('charts/'))).toBe(false)
    expect(entries.some((e) => e.includes('drawings/'))).toBe(false)
  })

  it('keeps item-level values distinct on the Sale Items sheet', async () => {
    const { wb } = await workbookOf('sales-register')
    const ws = wb.worksheets[1]
    const headerRow = headerRowOf(ws, DATASET, 1)
    expect(headersOf(ws, headerRow, 6)).toEqual([
      'Invoice No.', 'Item Name', 'IMEI', 'RAM/Storage', 'Color', 'Sale Value',
    ])
    // 8 item rows + totals; no invoice-level amount ever appears.
    const values: unknown[] = []
    for (let r = headerRow + 1; r <= headerRow + 8; r++) values.push(ws.getCell(r, 6).value)
    expect(values).not.toContain(60000)
    expect(values.reduce((a: number, v) => a + Number(v), 0)).toBe(175998)
  })
})

// ── Money Register ───────────────────────────────────────────────────────────

describe('Money Register workbook', () => {
  const DATASET = bundle.reports['money-register']

  it('renders the exact nine-column order with split Money In / Money Out columns', async () => {
    const { wb } = await workbookOf('money-register')
    const ws = wb.worksheets[0]
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Money Register'])
    const headerRow = headerRowOf(ws, DATASET, 0)
    expect(headersOf(ws, headerRow, 9)).toEqual([
      'Date', 'Transaction Type', 'Party', 'Reference No.', 'Related Bill', 'Account', 'Payment Mode', 'Money In', 'Money Out',
    ])
  })

  it('totals business movements only — internal transfers appear but stay out of the totals', async () => {
    const { wb } = await workbookOf('money-register')
    const ws = wb.worksheets[0]
    const headerRow = headerRowOf(ws, DATASET, 0)
    // 11 ledger rows, then the totals row.
    const totalsRow = headerRow + 12
    expect(String(ws.getCell(totalsRow, 1).value ?? '')).toContain('business movements')
    expect(ws.getCell(totalsRow, 8).value).toBe(125998)
    expect(ws.getCell(totalsRow, 9).value).toBe(123499)
    // The internal rows are present in the register with their amounts…
    let transferRows = 0
    let openingRows = 0
    for (let r = headerRow + 1; r < totalsRow; r++) {
      const type = String(ws.getCell(r, 2).value ?? '')
      if (type === 'Account Transfer') transferRows += 1
      if (type === 'Opening Balance') openingRows += 1
    }
    expect(transferRows).toBe(2)
    expect(openingRows).toBe(1)
    // …and the totals exclude them (raw credit sum would be 160998).
    expect(ws.getCell(totalsRow, 8).value).not.toBe(160998)
  })

  it('writes real receipt references and honest blanks', async () => {
    const { wb } = await workbookOf('money-register')
    const ws = wb.worksheets[0]
    const headerRow = headerRowOf(ws, DATASET, 0)
    const refs: string[] = []
    for (let r = headerRow + 1; r <= headerRow + 11; r++) refs.push(String(ws.getCell(r, 4).value ?? ''))
    expect(refs).toContain('RCP-IN-20261007-PI1')
    expect(refs).toContain('RCP-OUT-20261005-PO1')
    // Non-payment movements (the sale payment, the reversal, BOTH transfer
    // legs and the opening balance) keep the honest dash.
    expect(refs.filter((v) => v === '—')).toHaveLength(5)
  })
})

// ── Inventory workbooks ──────────────────────────────────────────────────────

describe('Inventory workbooks', () => {
  it('Snapshot: eleven supported fields, real dates, no quantity columns', async () => {
    const { wb } = await workbookOf('inventory-snapshot')
    const DATASET = bundle.reports['inventory-snapshot']
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Inventory Register'])
    const ws = wb.worksheets[0]
    const headerRow = headerRowOf(ws, DATASET, 0)
    expect(headersOf(ws, headerRow, 11)).toEqual([
      'Brand', 'Model', 'IMEI', 'RAM/Storage', 'Color', 'Acquisition Date', 'Acquisition Cost', 'Source', 'Current Status', 'Sale Invoice No.', 'Sale Date',
    ])
    const allHeaders = headersOf(ws, headerRow, 11).join(' ').toLowerCase()
    expect(allHeaders).not.toContain('qty')
    expect(allHeaders).not.toContain('quantity')
    expect(allHeaders).not.toContain('units')
    // Real acquisition-date cells.
    expect(ws.getCell(headerRow + 1, 6).value instanceof Date).toBe(true)
  })

  it('Acquisitions: the period acquisitions with current statuses', async () => {
    const { wb } = await workbookOf('inventory-acquisitions')
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Inventory Acquisitions'])
    const ws = wb.worksheets[0]
    // 8 acquisition rows; the summary block carries the record counts.
    const summary = Array.from({ length: 40 }, (_, i) => String(ws.getCell(i + 1, 1).value ?? ''))
    expect(summary).toContain('Acquisitions in Period')
    expect(summary).toContain('Acquired records')
  })
})

// ── Purchase Register ────────────────────────────────────────────────────────

describe('Purchase Register workbook', () => {
  const DATASET = bundle.reports['purchase-register']

  it('has the two worksheets in the specified order', async () => {
    const { wb } = await workbookOf('purchase-register')
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Purchase Register', 'Purchase Items'])
  })

  it('renders the exact column order with Item Name immediately after Purchase Bill No.', async () => {
    const { wb } = await workbookOf('purchase-register')
    const ws = wb.worksheets[0]
    const headerRow = headerRowOf(ws, DATASET, 0)
    expect(headersOf(ws, headerRow, 8)).toEqual([
      'Date', 'Purchase Bill No.', 'Item Name', 'Supplier', 'Total Amount', 'Paid', 'Balance', 'Status',
    ])
    // Multi-device bill totals appear exactly once.
    const totals: number[] = []
    for (let r = headerRow + 1; r <= headerRow + 4; r++) totals.push(Number(ws.getCell(r, 5).value))
    expect(totals.filter((v) => v === 24000)).toHaveLength(1)
  })

  it('reconciles the totals row with the included bills', async () => {
    const { wb } = await workbookOf('purchase-register')
    const ws = wb.worksheets[0]
    const headerRow = headerRowOf(ws, DATASET, 0)
    const totalsRow = headerRow + 5
    expect(ws.getCell(totalsRow, 5).value).toBe(228500)
    expect(ws.getCell(totalsRow, 6).value).toBe(153500)
    expect(ws.getCell(totalsRow, 7).value).toBe(75000)
  })

  it('keeps item-level costs distinct on the Purchase Items sheet', async () => {
    const { wb } = await workbookOf('purchase-register')
    const ws = wb.worksheets[1]
    const headerRow = headerRowOf(ws, DATASET, 1)
    expect(headersOf(ws, headerRow, 6)).toEqual([
      'Purchase Bill No.', 'Item Name', 'IMEI', 'RAM/Storage', 'Color', 'Acquisition Cost',
    ])
    const costs: number[] = []
    for (let r = headerRow + 1; r <= headerRow + 5; r++) costs.push(Number(ws.getCell(r, 6).value))
    expect(costs.reduce((a, b) => a + b, 0)).toBe(96000)
    expect(costs).not.toContain(100000)
    expect(costs).not.toContain(91000)
    expect(costs).not.toContain(24000)
  })
})

// ── Empty states ─────────────────────────────────────────────────────────────

describe('empty periods keep honest workbooks', () => {
  it('renders an explicit empty state instead of fake rows', async () => {
    const empty = buildReportDatasets({
      fold: makeFold(),
      period: { preset: 'custom', from: '2027-02-01', to: '2027-02-28' },
      store: STORE,
      fy: FY,
      today: TODAY,
      generatedAt: GENERATED_AT,
    })
    const bytes = await buildReportWorkbook(empty.meta, empty.reports['sales-register'])
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(bytes.slice().buffer as ArrayBuffer)
    const ws = wb.worksheets[0]
    const values = Array.from({ length: 14 }, (_, i) => String(ws.getCell(i + 1, 1).value ?? ''))
    expect(values).toContain('Sales Register')
    expect(values.some((v) => v.includes('No records'))).toBe(true)
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Sales Register', 'Sale Items'])
  })
})

// ── The renderer contract across all workbooks ───────────────────────────────

describe('the shared renderer contract', () => {
  const ALL = ['business-summary', 'sales-register', 'money-register', 'inventory-snapshot', 'inventory-acquisitions', 'purchase-register'] as const

  it('produces valid, reloadable .xlsx files with unique sheet names', async () => {
    for (const id of ALL) {
      const { wb, bytes } = await workbookOf(id)
      expect(bytes.length).toBeGreaterThan(4000)
      expect(wb.worksheets.length).toBeGreaterThanOrEqual(1)
      const names = wb.worksheets.map((w) => w.name)
      expect(new Set(names).size).toBe(names.length)
      for (const n of names) expect(n.length).toBeLessThanOrEqual(31)
      for (const ws of wb.worksheets) {
        for (let r = 1; r <= Math.min(ws.rowCount, 40); r++) {
          for (let c = 1; c <= Math.min(ws.columnCount, 12); c++) {
            expect(ws.getCell(r, c).value).toBeDefined()
          }
        }
      }
    }
  })

  it('uses a consistent, restrained style: a single normal view, hidden gridlines and print setup on every sheet', async () => {
    for (const id of ALL) {
      const { bytes, wb } = await workbookOf(id)
      wb.worksheets.forEach((ws) => {
        const xml = sheetXml(bytes, ws.name)
        // EVERY sheet — register and summary alike — carries exactly ONE
        // normal view with the background gridlines hidden, and never a
        // pane, a filter or a second view of the sheet.
        expect((xml.match(/<sheetView[\s>]/g) ?? []).length).toBe(1)
        expect(xml).toMatch(/<sheetView[^>]*showGridLines="0"/)
        expect(xml).not.toMatch(/<pane[\s>]/)
        expect(xml).not.toMatch(/<autoFilter/)
        expect(xml).toMatch(/fitToWidth="1"|fitToPage/)
      })
    }
  })
})

// ── Worksheet views (the two-view / pane defect regression) ─────────────

describe('worksheet views: ONE normal view per sheet — never a pane, a split or a second view', () => {
  const ALL = ['business-summary', 'sales-register', 'money-register', 'inventory-snapshot', 'inventory-acquisitions', 'purchase-register'] as const

  it('every sheet of every workbook carries EXACTLY ONE plain sheetView and NO pane element', async () => {
    for (const id of ALL) {
      const { bytes, wb } = await workbookOf(id)
      wb.worksheets.forEach((ws) => {
        const xml = sheetXml(bytes, ws.name)
        // ONE <sheetView> — never a duplicated view configuration.
        expect((xml.match(/<sheetView[\s>]/g) ?? []).length).toBe(1)
        // ZERO <pane> elements — no split, no frozen region, no second
        // viewport that any viewer could render as a repeated view of
        // rows 1–6 (the reported two-view defect).
        expect((xml.match(/<pane[\s>]/g) ?? []).length).toBe(0)
        expect(xml).not.toMatch(/state="frozen"/)
        expect(xml).not.toMatch(/state="split"/)
        // No pane-scoped selection either.
        expect(xml).not.toMatch(/<selection[^>]*pane=/)
        // The single view is a NORMAL view: workbookViewId only, plus the
        // hidden gridlines — no topLeftCell/activeCell view state.
        expect(xml).toMatch(/<sheetView[^>]*workbookViewId="0"[^>]*\/>/)
      })
    }
  })

  it('hides the background gridlines on every sheet for the clean register presentation', async () => {
    for (const id of ALL) {
      const { bytes, wb } = await workbookOf(id)
      wb.worksheets.forEach((ws) => {
        const xml = sheetXml(bytes, ws.name)
        expect(xml).toMatch(/<sheetView[^>]*showGridLines="0"/)
      })
    }
  })

  it('carries NO AutoFilter or Excel-table filter configuration anywhere', async () => {
    for (const id of ALL) {
      const { bytes, wb } = await workbookOf(id)
      wb.worksheets.forEach((ws) => {
        const xml = sheetXml(bytes, ws.name)
        // No worksheet-level autoFilter (the dropdown arrows) …
        expect(xml).not.toMatch(/<autoFilter/)
        // … and no Excel table parts that would carry their own filters.
        expect(xml).not.toMatch(/<tableParts/)
        expect(xml).not.toMatch(/<table[\s>]/)
      })
      const zip = unzipSync(bytes)
      const entries = Object.keys(zip)
      expect(entries.some((e) => e.includes('xl/tables/'))).toBe(false)
    }
  })

  it('the Business Summary sheet carries the SAME single normal view as the registers', async () => {
    const { bytes } = await workbookOf('business-summary')
    const xml = sheetXml(bytes, 'Summary')
    expect((xml.match(/<sheetView[\s>]/g) ?? []).length).toBe(1)
    expect(xml).toMatch(/<sheetView[^>]*showGridLines="0"/)
    expect(xml).not.toMatch(/<pane[\s>]/)
  })

  it('the same transaction rows never appear as duplicated independent views (single sheetData)', async () => {
    // A duplicated view of the sheet would require either a second
    // sheetView/pane (asserted above) or duplicated row content — assert
    // the sheet carries each register row exactly once, by document
    // number, both in the rendered cells and in the shared-strings part.
    const { wb, bytes } = await workbookOf('sales-register')
    const ws = wb.worksheets[0]
    const dataset = bundle.reports['sales-register']
    const headerRow = headerRowOf(ws, dataset, 0)
    const inRegister = ['SAL-2026-27-0001', 'SAL-2026-27-0002', 'SAL-2026-27-0003', 'SAL-2026-27-0005', 'SAL-2026-27-0006', 'SAL-2026-27-0007', 'SAL-2026-27-0008']
    const columnValues: string[] = []
    for (let r = headerRow + 1; r <= ws.rowCount; r++) {
      const v = String(ws.getCell(r, 2).value ?? '')
      if (v.startsWith('SAL-')) columnValues.push(v)
    }
    expect(columnValues.sort()).toEqual([...inRegister].sort())
    for (const bill of inRegister) {
      expect(columnValues.filter((v) => v === bill)).toHaveLength(1)
    }
    // The shared-strings part carries each document number exactly once
    // (deduplicated storage — no duplicated content anywhere in the file).
    const zip = unzipSync(bytes)
    const shared = strFromU8(zip['xl/sharedStrings.xml'])
    for (const bill of inRegister) {
      expect((shared.match(new RegExp(`>${bill}<`, 'g')) ?? []).length).toBe(1)
    }
  })
})

// ── Meta plumbing ────────────────────────────────────────────────────────────

describe('report metadata', () => {
  it('carries the validated period and the generation timestamp', () => {
    expect(META.storeName).toBe('ABC Mobile Store')
    expect(META.from).toBe('2026-04-01')
    expect(META.to).toBe('2027-03-31')
    expect(META.generatedAt).toBe(GENERATED_AT)
    expect(META.fyLabel).toBe('FY 2026–2027')
    // The As-of date lives on the SNAPSHOT dataset only.
    expect(bundle.reports['inventory-snapshot'].asOf).toBe(TODAY)
    expect(bundle.reports['sales-register'].asOf).toBeUndefined()
  })
})
