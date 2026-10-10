/**
 * Report datasets — the controlled business scenario tests (implementation
 * spec §§7, 10, 12.2).
 *
 * The fixture below is a controlled scenario with EXACT hand-computed
 * expected values. The tests verify the report data layer (the normalized
 * datasets every Excel export renders from): correct rows, correct columns
 * in the exact specified order, item names joined readably, multi-item
 * invoices never duplicated, cancellation and virtual-acquisition
 * exclusions, the Money Register's ledger semantics (movements, reversals,
 * internal transfers), inventory snapshot and acquisition semantics, and
 * the financial-year boundary matrix of §10.1.
 *
 * Expected values are computed INDEPENDENTLY in this file (by hand, next
 * to each assertion) — they never reuse the application's calculation
 * helpers.
 */
import { describe, it, expect } from 'vitest'
import { buildReportDatasets } from '@/features/reports/data'
import type { BuildReportsOptions, ReportDataset, TableBlock, SummaryBlock } from '@/features/reports/data'
import { REPORTS, reportInfo } from '@/features/reports/catalogue'
import { reportFilename, fyFilenameFragment, slug } from '@/features/reports/export'
import {
  EXPORT_PRESETS,
  initialExportState,
  isEmptyExportRange,
  resolveExportPeriod,
} from '@/features/reports/exportPeriod'
import { dateInRange, purchaseTrend, receiptNumber } from '@/features/analytics/metrics'
import { resolvePeriod } from '@/features/analytics/period'
import { makeFold, FULL_FY, FY, STORE, TODAY, GENERATED_AT } from './reportsFixture'

function build(overrides: Partial<BuildReportsOptions> = {}) {
  return buildReportDatasets({
    fold: makeFold(),
    period: FULL_FY,
    store: STORE,
    fy: FY,
    today: TODAY,
    generatedAt: GENERATED_AT,
    ...overrides,
  })
}

/** The first table block of a dataset sheet. */
function table(dataset: ReportDataset, sheetIndex = 0): TableBlock {
  const sheet = dataset.sheets[sheetIndex]
  const block = sheet?.blocks.find((b) => b.kind === 'table')
  if (!block || block.kind !== 'table') throw new Error(`no table block on sheet ${sheetIndex}`)
  return block
}

/** All summary blocks of a dataset sheet. */
function summaries(dataset: ReportDataset, sheetIndex = 0): SummaryBlock[] {
  const sheet = dataset.sheets[sheetIndex]
  return (sheet?.blocks ?? []).filter((b): b is SummaryBlock => b.kind === 'summary')
}

function summaryValue(dataset: ReportDataset, sheetIndex: number, label: string): string | number | Date | null {
  for (const block of summaries(dataset, sheetIndex)) {
    const row = block.rows.find((r) => r.label === label)
    if (row) return row.value
  }
  throw new Error(`no summary row "${label}"`)
}

const headers = (block: TableBlock) => block.columns.map((c) => c.header)
const rowsOf = (block: TableBlock) => block.rows as Array<Record<string, unknown>>

// ── The catalogue ────────────────────────────────────────────────────────────

describe('report catalogue', () => {
  it('defines exactly the five Analytics exports (plus the inventory scope pair)', () => {
    expect(REPORTS.map((r) => r.id)).toEqual([
      'business-summary',
      'sales-register',
      'money-register',
      'inventory-snapshot',
      'inventory-acquisitions',
      'purchase-register',
    ])
    for (const r of REPORTS) expect(r.dialogTitle).toBe(`Export ${r.title}`)
  })

  it('marks only the inventory snapshot as an as-of report', () => {
    expect(reportInfo('inventory-snapshot').dateKind).toBe('as-of')
    for (const r of REPORTS) {
      if (r.id !== 'inventory-snapshot') expect(r.dateKind).toBe('period')
    }
  })
})

// ── Overview — Business Summary ──────────────────────────────────────────────

describe('Business Summary', () => {
  const bundle = build()
  const ds = bundle.reports['business-summary']

  it('has exactly one worksheet named Summary', () => {
    expect(ds.sheets.map((s) => s.name)).toEqual(['Summary'])
  })

  it('reports the six specified metrics with hand-computed values', () => {
    // Hand computation (see the fixture):
    //   Sales Value        = final_total of active sales dated in FY:
    //     35000 + 31999 + 19500 + 60000 + 8000 + 15999 + 2500 = 172998
    //   Purchase Value     = real purchases: 100000 + 91000 + 13500 + 24000 = 228500
    //   Payments Received  = payments_in dated in FY: 35000+5000+15999+60000+9999 = 125998
    //   Payments Made      = payments_out dated in FY: 100000 + 13500 = 113500
    //   Customer Outstanding = active dues now: 31999 + 14500 + 8000 + 2500 = 56999
    //   Supplier Outstanding = active purchase dues now: 51000 + 24000 = 75000
    expect(summaryValue(ds, 0, 'Sales Value')).toBe(172998)
    expect(summaryValue(ds, 0, 'Purchase Value')).toBe(228500)
    expect(summaryValue(ds, 0, 'Payments Received')).toBe(125998)
    expect(summaryValue(ds, 0, 'Payments Made')).toBe(113500)
    expect(summaryValue(ds, 0, 'Customer Outstanding')).toBe(56999)
    expect(summaryValue(ds, 0, 'Supplier Outstanding')).toBe(75000)
  })

  it('clearly distinguishes period activity from current positions', () => {
    const titles = summaries(ds, 0).map((b) => b.title)
    expect(titles).toEqual(['Period Activity', 'Current Position', 'Current Inventory Summary'])
  })

  it('labels inventory counts as record counts and values only in-stock cost', () => {
    // In-stock records: i4 (3000), i7 (8000), i11 (9500), i12 (14500)
    expect(summaryValue(ds, 0, 'In-stock inventory records')).toBe(4)
    expect(summaryValue(ds, 0, 'Recorded acquisition cost of in-stock inventory')).toBe(35000)
  })

  it('includes the purchase-value exclusion note (virtual acquisitions)', () => {
    const notes = summaries(ds, 0)[0].notes ?? []
    expect(notes.join(' ')).toContain('trade-in acquisition')
  })
})

// ── Sales — Sales Register ───────────────────────────────────────────────────

describe('Sales Register', () => {
  const bundle = build()
  const ds = bundle.reports['sales-register']

  it('has two worksheets in the specified order', () => {
    expect(ds.sheets.map((s) => s.name)).toEqual(['Sales Register', 'Sale Items'])
  })

  it('uses the exact column order, with Item Name immediately after Invoice No.', () => {
    expect(headers(table(ds, 0))).toEqual([
      'Date', 'Invoice No.', 'Item Name', 'Customer', 'Total Amount', 'Received', 'Balance', 'Status',
    ])
  })

  it('renders one row per qualifying invoice with hand-computed totals', () => {
    const rows = rowsOf(table(ds, 0))
    // Active sales dated within FY 2026-27 (cancelled s4 and the
    // out-of-window s9 excluded): s1, s2, s3, s5, s6, s7, s8.
    expect(rows).toHaveLength(7)
    const total = rows.reduce((a, r) => a + (r.total as number), 0)
    const received = rows.reduce((a, r) => a + (r.received as number), 0)
    const balance = rows.reduce((a, r) => a + (r.balance as number), 0)
    expect(total).toBe(172998)
    expect(received).toBe(115999)
    expect(balance).toBe(56999)
    // The register reconciles: received + balance == total.
    expect(received + balance).toBe(total)
  })

  it('joins multi-item invoices readably into the Item Name cell', () => {
    const rows = rowsOf(table(ds, 0))
    const s5 = rows.find((r) => r.billNumber === 'SAL-2026-27-0005')
    expect(s5?.itemName).toBe('Samsung Galaxy S23, Google Pixel 8')
    // The multi-item invoice's total appears exactly once.
    expect(rows.filter((r) => r.total === 60000)).toHaveLength(1)
  })

  it('excludes cancelled invoices and out-of-window records', () => {
    const rows = rowsOf(table(ds, 0))
    expect(rows.some((r) => r.billNumber === 'SAL-2026-27-0004')).toBe(false)
    expect(rows.some((r) => r.billNumber === 'SAL-2027-28-0001')).toBe(false)
  })

  it('orders rows by business date, then bill number', () => {
    const rows = rowsOf(table(ds, 0))
    expect(rows.map((r) => r.billNumber)).toEqual([
      'SAL-2026-27-0007', // 2026-04-01
      'SAL-2026-27-0006', // 2026-06-20
      'SAL-2026-27-0003', // 2026-09-15
      'SAL-2026-27-0001', // 2026-10-07 (before 0002, same date)
      'SAL-2026-27-0002',
      'SAL-2026-27-0005', // 2026-11-20
      'SAL-2026-27-0008', // 2027-03-31
    ])
  })

  it('carries item-level values only on the Sale Items sheet (no invoice totals)', () => {
    expect(headers(table(ds, 1))).toEqual([
      'Invoice No.', 'Item Name', 'IMEI', 'RAM/Storage', 'Color', 'Sale Value',
    ])
    const rows = rowsOf(table(ds, 1))
    // One row per item of the qualifying invoices: 8 devices (s5 has two).
    expect(rows).toHaveLength(8)
    const value = rows.reduce((a, r) => a + (r.saleValue as number), 0)
    // 35000 + 34999 + 19500 + 35000 + 25000 + 8000 + 15999 + 2500
    expect(value).toBe(175998)
    // No invoice-level amount (e.g. 60000) ever appears on item rows.
    expect(rows.some((r) => r.saleValue === 60000)).toBe(false)
    // Identifiers are the actual device fields.
    const g84 = rows.find((r) => r.itemName === 'Motorola Moto G84 5G')
    expect(g84?.imei).toBe('X9')
    expect(g84?.ramRom).toBe('12/256')
    expect(g84?.color).toBe('Viva Magenta')
    // The cancelled sale's device never appears.
    expect(rows.some((r) => r.itemName === 'Vivo V29 5G')).toBe(false)
  })
})

// ── Money — Money Register ───────────────────────────────────────────────────

describe('Money Register', () => {
  const bundle = build()
  const ds = bundle.reports['money-register']

  it('has one worksheet named Money Register with the exact column order', () => {
    expect(ds.sheets.map((s) => s.name)).toEqual(['Money Register'])
    expect(headers(table(ds, 0))).toEqual([
      'Date', 'Transaction Type', 'Party', 'Reference No.', 'Related Bill', 'Account', 'Payment Mode', 'Money In', 'Money Out',
    ])
  })

  it('represents the authoritative account movements (one row per ledger entry)', () => {
    const rows = rowsOf(table(ds, 0))
    // All 11 ledger rows fall inside FY 2026-27.
    expect(rows).toHaveLength(11)
  })

  it('resolves parties, related bills, modes and receipt references from real relationships', () => {
    const rows = rowsOf(table(ds, 0))
    const byRef = (ref: string) => rows.find((r) => r.referenceNo === ref)

    // A later payment_in: party from the payment, bill from the sale.
    const pi1 = byRef('RCP-IN-20261007-PI1')
    expect(pi1).toBeDefined()
    expect(pi1?.transactionType).toBe('Payment In')
    expect(pi1?.party).toBe('Aditya Singh')
    expect(pi1?.relatedBill).toBe('SAL-2026-27-0001')
    expect(pi1?.account).toBe('HDFC Current Account')
    expect(pi1?.paymentMode).toBe('UPI')
    expect(pi1?.moneyIn).toBe(35000)
    expect(pi1?.moneyOut).toBeNull()

    // A payment made at sale creation ('sale' reference): the party and
    // bill resolve through the SALE, the reference stays honest.
    const salePay = rows.find((r) => r.transactionType === 'Sale Payment')
    expect(salePay?.party).toBe('Priya Verma')
    expect(salePay?.relatedBill).toBe('SAL-2026-27-0005')
    expect(salePay?.moneyIn).toBe(60000)
    expect(salePay?.referenceNo).toBe('—')

    // The retained payment of the cancelled sale AND its compensating
    // reversal — both present, netting to zero.
    const retained = byRef('RCP-IN-20261009-PI5')
    expect(retained?.transactionType).toBe('Payment In')
    expect(retained?.moneyIn).toBe(9999)
    const reversal = rows.find((r) => r.transactionType === 'Cancellation Reversal')
    expect(reversal?.party).toBe('Aditya Singh')
    expect(reversal?.relatedBill).toBe('SAL-2026-27-0004')
    expect(reversal?.moneyOut).toBe(9999)
    expect((retained?.moneyIn as number) - (reversal?.moneyOut as number)).toBe(0)

    // Modeless payment on the cash account is labelled Cash.
    const cash = byRef('RCP-IN-20261103-PI2')
    expect(cash?.paymentMode).toBe('Cash')

    // Payment out with its receipt reference.
    const po1 = byRef('RCP-OUT-20261005-PO1')
    expect(po1?.transactionType).toBe('Payment Out')
    expect(po1?.relatedBill).toBe('PUR-2026-27-0001')
    expect(po1?.moneyOut).toBe(100000)
  })

  it('classifies internal transfers and opening balances separately', () => {
    const rows = rowsOf(table(ds, 0))
    const transfers = rows.filter((r) => r.transactionType === 'Account Transfer')
    expect(transfers).toHaveLength(2)
    // Both legs appear — the out leg on the HDFC account, the in leg on Cash.
    const out = transfers.find((r) => r.account === 'HDFC Current Account')
    const inn = transfers.find((r) => r.account === 'Cash')
    expect(out?.moneyOut).toBe(15000)
    expect(inn?.moneyIn).toBe(15000)
    expect(out?.internal).toBe(1)
    expect(inn?.internal).toBe(1)
    expect(out?.party).toBe('—')

    const opening = rows.find((r) => r.transactionType === 'Opening Balance')
    expect(opening?.moneyIn).toBe(20000)
    expect(opening?.internal).toBe(1)
  })

  it('totals business movements only (transfers and opening balances excluded)', () => {
    const rows = rowsOf(table(ds, 0)) as Array<Record<string, number | string | Date | null>>
    const business = rows.filter((r) => !r.internal)
    const moneyIn = business.reduce((a, r) => a + (r.moneyIn as number | null ?? 0), 0)
    const moneyOut = business.reduce((a, r) => a + (r.moneyOut as number | null ?? 0), 0)
    // Business credits: 35000 + 5000 + 15999 + 60000 + 9999 = 125998
    // Business debits:  9999 + 100000 + 13500 = 123499
    expect(moneyIn).toBe(125998)
    expect(moneyOut).toBe(123499)

    // The Period Totals summary block carries the same reconciled numbers.
    expect(summaryValue(ds, 0, 'Money In (business movements)')).toBe(125998)
    expect(summaryValue(ds, 0, 'Money Out (business movements)')).toBe(123499)
    expect(summaryValue(ds, 0, 'Net Movement')).toBe(2499)
  })

  it('sorts rows chronologically', () => {
    const rows = rowsOf(table(ds, 0))
    const keys = rows.map((r) => {
      const d = r.date as Date
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    })
    expect([...keys].sort()).toEqual(keys)
  })

  it('filters by the actual transaction date (payment dates, not bill dates)', () => {
    // The later payment pi2 (2026-11-03, for a September sale) and the
    // December transfer fall OUTSIDE a June–October window.
    const windowed = build({ period: { preset: 'custom', from: '2026-06-01', to: '2026-10-31' } })
    const rows = rowsOf(table(windowed.reports['money-register'], 0))
    expect(rows.some((r) => r.referenceNo === 'RCP-IN-20261103-PI2')).toBe(false)
    expect(rows.some((r) => r.transactionType === 'Account Transfer')).toBe(false)
    // The September sale-payment? No — but the October movements stay.
    expect(rows.some((r) => r.referenceNo === 'RCP-IN-20261007-PI1')).toBe(true)
  })
})

// ── Inventory — Snapshot and Acquisitions ────────────────────────────────────

describe('Current Inventory Snapshot', () => {
  const bundle = build()
  const ds = bundle.reports['inventory-snapshot']

  it('has one worksheet named Inventory Register with the supported fields', () => {
    expect(ds.sheets.map((s) => s.name)).toEqual(['Inventory Register'])
    expect(headers(table(ds, 0))).toEqual([
      'Brand', 'Model', 'IMEI', 'RAM/Storage', 'Color', 'Acquisition Date', 'Acquisition Cost', 'Source', 'Current Status', 'Sale Invoice No.', 'Sale Date',
    ])
  })

  it('lists every inventory record with its current status and sale references', () => {
    const rows = rowsOf(table(ds, 0))
    expect(rows).toHaveLength(8)
    const inStock = rows.filter((r) => r.status === 'In Stock')
    const sold = rows.filter((r) => r.status === 'Sold')
    expect(inStock).toHaveLength(4)
    expect(sold).toHaveLength(4)

    // A sold record carries its sale reference and sale date.
    const g84 = sold.find((r) => r.model === 'Moto G84 5G')
    expect(g84?.saleBill).toBe('SAL-2026-27-0007')
    const g84Date = g84?.saleDate as Date
    expect(`${g84Date.getFullYear()}-${String(g84Date.getMonth() + 1).padStart(2, '0')}-${String(g84Date.getDate()).padStart(2, '0')}`).toBe('2026-04-01')
    expect(g84?.source).toBe('Purchase')

    // The trade-in device is labelled Trade-In.
    const c55 = sold.find((r) => r.model === 'C55')
    expect(c55?.source).toBe('Trade-In')

    // In-stock records have no sale references (honest blanks).
    for (const r of inStock) {
      expect(r.saleBill).toBe('—')
      expect(r.saleDate).toBeNull()
    }
  })

  it('values only the in-stock records and labels counts as records', () => {
    expect(summaryValue(ds, 0, 'In-stock inventory records')).toBe(4)
    expect(summaryValue(ds, 0, 'Recorded acquisition cost of in-stock inventory')).toBe(35000)
    // The register's own total covers ALL records.
    const rows = rowsOf(table(ds, 0))
    expect(rows.reduce((a, r) => a + (r.cost as number), 0)).toBe(100500)
  })
})

describe('Inventory Acquisitions', () => {
  it('shows the acquisitions recorded in the period with their current status', () => {
    const bundle = build()
    const ds = bundle.reports['inventory-acquisitions']
    expect(ds.sheets.map((s) => s.name)).toEqual(['Inventory Acquisitions'])
    expect(headers(table(ds, 0))).toContain('Acquisition Date')
    expect(headers(table(ds, 0))).not.toContain('Quantity')

    const rows = rowsOf(table(ds, 0))
    expect(rows).toHaveLength(8)
    // An item acquired in the period may already have been sold — the
    // status says so honestly.
    expect(rows.filter((r) => r.status === 'Sold')).toHaveLength(4)
    expect(summaryValue(ds, 0, 'Acquired records')).toBe(8)
    expect(summaryValue(ds, 0, 'Still in stock')).toBe(4)
    expect(summaryValue(ds, 0, 'Already sold')).toBe(4)
    expect(summaryValue(ds, 0, 'Recorded acquisition cost')).toBe(100500)
  })

  it('filters by the qualifying acquisition date', () => {
    const bundle = build({ period: { preset: 'custom', from: '2027-01-01', to: '2027-03-31' } })
    const rows = rowsOf(table(bundle.reports['inventory-acquisitions'], 0))
    // Only the two devices acquired on 2027-01-15.
    expect(rows.map((r) => r.model).sort()).toEqual(['Galaxy M14', 'X6 5G'])
    expect(rows.every((r) => r.status === 'In Stock')).toBe(true)
  })
})

// ── Purchase — Purchase Register ─────────────────────────────────────────────

describe('Purchase Register', () => {
  const bundle = build()
  const ds = bundle.reports['purchase-register']

  it('has two worksheets in the specified order', () => {
    expect(ds.sheets.map((s) => s.name)).toEqual(['Purchase Register', 'Purchase Items'])
  })

  it('uses the exact column order, with Item Name immediately after Purchase Bill No.', () => {
    expect(headers(table(ds, 0))).toEqual([
      'Date', 'Purchase Bill No.', 'Item Name', 'Supplier', 'Total Amount', 'Paid', 'Balance', 'Status',
    ])
  })

  it('renders one row per qualifying bill with hand-computed totals', () => {
    const rows = rowsOf(table(ds, 0))
    // Real supplier bills: p3 (1 Apr 2026), p1, p2, p4 — the cancelled
    // PUR-TRD bill and the recovery bill are excluded.
    expect(rows).toHaveLength(4)
    const total = rows.reduce((a, r) => a + (r.total as number), 0)
    const paid = rows.reduce((a, r) => a + (r.paid as number), 0)
    const balance = rows.reduce((a, r) => a + (r.balance as number), 0)
    expect(total).toBe(228500)
    expect(paid).toBe(153500)
    expect(balance).toBe(75000)
    // Reconciliation: paid + balance == total for the included bills.
    expect(paid + balance).toBe(total)
  })

  it('covers the full payment-state spectrum and never duplicates multi-device totals', () => {
    const rows = rowsOf(table(ds, 0))
    const byState = (s: string) => rows.filter((r) => r.status === s).length
    expect(byState('Paid')).toBe(2) // p1, p3
    expect(byState('Partial')).toBe(1) // p2 (40000 of 91000)
    expect(byState('Unpaid')).toBe(1) // p4 (0 of 24000)

    // The multi-device unpaid bill contributes its total exactly once.
    const p4 = rows.find((r) => r.billNumber === 'PUR-2026-27-0004')
    expect(p4?.itemName).toBe('Samsung Galaxy M14, Poco X6 5G')
    expect(p4?.total).toBe(24000)
    expect(rows.filter((r) => r.total === 24000)).toHaveLength(1)
  })

  it('excludes internal trade-in acquisition and recovery records by relationship, not just prefix', () => {
    const rows = rowsOf(table(ds, 0)) as Array<Record<string, unknown>>
    expect(rows.some((r) => String(r.billNumber ?? '').startsWith('PUR-TRD-'))).toBe(false)
    // The recovery bill uses PLAIN numbering but all its items are
    // trade-in-sourced — excluded by the relationship rule.
    expect(rows.some((r) => r.billNumber === 'PUR-26-27-0006')).toBe(false)
  })

  it('carries item-level costs only on the Purchase Items sheet (no bill totals)', () => {
    expect(headers(table(ds, 1))).toEqual([
      'Purchase Bill No.', 'Item Name', 'IMEI', 'RAM/Storage', 'Color', 'Acquisition Cost',
    ])
    const rows = rowsOf(table(ds, 1))
    // Devices of the qualifying bills: p1×1, p2×1, p3×1, p4×2 = 5 rows.
    expect(rows).toHaveLength(5)
    const cost = rows.reduce((a, r) => a + (r.cost as number), 0)
    // 30000 + 28500 + 13500 + 9500 + 14500
    expect(cost).toBe(96000)
    // No bill-level amount (100000, 91000, 24000) appears on item rows.
    expect(rows.some((r) => r.cost === 100000 || r.cost === 91000 || r.cost === 24000)).toBe(false)
    // Virtual-bill devices never appear.
    expect(rows.some((r) => r.itemName === 'Vivo V25')).toBe(false)
    const m14 = rows.find((r) => r.itemName === 'Samsung Galaxy M14')
    expect(m14?.imei).toBe('X11')
    expect(m14?.ramRom).toBe('6/128')
  })
})

// ── Financial-year boundary correctness (spec §10.1) ─────────────────────────

describe('financial-year boundary matrix (FY 2026-2027)', () => {
  const FY_RANGE = { from: '2026-04-01', to: '2027-03-31' }

  it('resolves the financial year inclusively from 1 April 2026 through 31 March 2027', () => {
    expect(resolveExportPeriod('financial-year', FY, {}, TODAY)).toEqual(FY_RANGE)
    expect(resolvePeriod('fy', FY)).toEqual({ preset: 'fy', ...FY_RANGE })
  })

  it('applies the exact §10.1 inclusion matrix', () => {
    // 31 March 2026 → Excluded
    expect(dateInRange('2026-03-31', FY_RANGE)).toBe(false)
    // 1 April 2026 → Included
    expect(dateInRange('2026-04-01', FY_RANGE)).toBe(true)
    // 31 March 2027 → Included
    expect(dateInRange('2027-03-31', FY_RANGE)).toBe(true)
    // 1 April 2027 → Excluded
    expect(dateInRange('2027-04-01', FY_RANGE)).toBe(false)
  })

  it('includes the FY-start and FY-end records in every FY period report', () => {
    const bundle = build()
    const sales = rowsOf(table(bundle.reports['sales-register'], 0))
    expect(sales.some((r) => r.billNumber === 'SAL-2026-27-0007')).toBe(true) // 1 Apr 2026
    expect(sales.some((r) => r.billNumber === 'SAL-2026-27-0008')).toBe(true) // 31 Mar 2027
    const purchases = rowsOf(table(bundle.reports['purchase-register'], 0))
    expect(purchases.some((r) => r.billNumber === 'PUR-2026-27-0005')).toBe(true) // 1 Apr 2026
    const money = rowsOf(table(bundle.reports['money-register'], 0))
    expect(money.some((r) => r.referenceNo === 'RCP-IN-20260401-PI3')).toBe(true)
    expect(money.some((r) => r.referenceNo === 'RCP-OUT-20260401-PO2')).toBe(true)
  })

  it('never leaks a 1 April 2027 record into an FY 2026-27 report — even via a wider custom range', () => {
    // A custom range nominally spanning past the FY end clamps to the FY.
    const clamped = resolveExportPeriod('custom', FY, { from: '2026-03-01', to: '2027-04-15' }, TODAY)
    expect(clamped).toEqual(FY_RANGE)
    const bundle = build({ period: { preset: 'custom', from: clamped.from, to: clamped.to } })
    const sales = rowsOf(table(bundle.reports['sales-register'], 0))
    expect(sales.some((r) => r.billNumber === 'SAL-2027-28-0001')).toBe(false)
    const items = rowsOf(table(bundle.reports['sales-register'], 1))
    expect(items).toHaveLength(8)
  })

  it('exports one side of a boundary date exactly once per financial year', () => {
    // The 1 April 2027 record DOES appear when the NEXT financial year is
    // selected — proving the boundary cut is the period, not the data.
    const FY2728 = { start_date: '2027-04-01', end_date: '2028-03-31' }
    const range = resolveExportPeriod('financial-year', FY2728, {}, TODAY)
    expect(dateInRange('2027-04-01', range)).toBe(true)
    expect(dateInRange('2027-03-31', range)).toBe(false)
  })

  it('an FY 2027-28 Sales Register contains the 1 Apr 2027 invoice and NEVER the 31 Mar 2027 invoice', () => {
    // THE REGRESSION (the reported FY-filtering defect): with the NEXT
    // financial year selected, the register must carry the 1 April 2027
    // boundary invoice (SAL-2027-28-0001) — and must never carry the
    // 31 March 2027 invoice of the PREVIOUS year (SAL-2026-27-0008).
    const FY2728 = { start_date: '2027-04-01', end_date: '2028-03-31' }
    const range = resolveExportPeriod('financial-year', FY2728, {}, TODAY)
    expect(range).toEqual({ from: '2027-04-01', to: '2028-03-31' })
    const bundle = build({
      period: { preset: 'custom', from: range.from, to: range.to },
      fy: FY2728,
    })
    const sales = rowsOf(table(bundle.reports['sales-register'], 0))
    expect(sales.some((r) => r.billNumber === 'SAL-2027-28-0001')).toBe(true)
    expect(sales.some((r) => r.billNumber === 'SAL-2026-27-0008')).toBe(false)
    // Every rendered register date is a UTC-midnight Date carrying its
    // EXACT business day (no timezone shift at the boundary).
    const first = sales.find((r) => r.billNumber === 'SAL-2027-28-0001')?.date as Date
    expect(first instanceof Date).toBe(true)
    expect(first.getUTCFullYear()).toBe(2027)
    expect(first.getUTCMonth()).toBe(3)
    expect(first.getUTCDate()).toBe(1)
  })
})

// ── The export period model (spec §6.1) ──────────────────────────────────────

describe('export period model', () => {
  it('offers This Month, Last Month, Financial Year and Custom Period', () => {
    expect(EXPORT_PRESETS.map((p) => p.value)).toEqual(['this-month', 'last-month', 'financial-year', 'custom'])
  })

  it('resolves this-month and last-month against the selected financial year', () => {
    expect(resolveExportPeriod('this-month', FY, {}, '2026-12-06')).toEqual({ from: '2026-12-01', to: '2026-12-31' })
    expect(resolveExportPeriod('last-month', FY, {}, '2026-12-06')).toEqual({ from: '2026-11-01', to: '2026-11-30' })
    // January looks back into the previous calendar YEAR.
    expect(resolveExportPeriod('last-month', FY, {}, '2027-01-15')).toEqual({ from: '2026-12-01', to: '2026-12-31' })
  })

  it('intersects presets with the financial year (an empty window is representable)', () => {
    // December 2026 does not intersect FY 2027-28 at all.
    const empty = resolveExportPeriod('this-month', { start_date: '2027-04-01', end_date: '2028-03-31' }, {}, '2026-12-06')
    expect(isEmptyExportRange(empty)).toBe(true)
    // A custom range overlapping the FY start intersects into it.
    expect(resolveExportPeriod('custom', FY, { from: '2026-01-01', to: '2026-06-30' }, TODAY)).toEqual({
      from: '2026-04-01',
      to: '2026-06-30',
    })
    // A custom range entirely before the FY intersects to empty — it never
    // silently widens to the full year.
    const outside = resolveExportPeriod('custom', FY, { from: '2026-01-01', to: '2026-03-31' }, TODAY)
    expect(isEmptyExportRange(outside)).toBe(true)
  })

  it('auto-orders inverted custom ranges', () => {
    expect(resolveExportPeriod('custom', FY, { from: '2026-10-31', to: '2026-10-01' }, TODAY)).toEqual({
      from: '2026-10-01',
      to: '2026-10-31',
    })
  })

  it('opens on the workspace\u2019s current period (never a silently different range)', () => {
    expect(initialExportState({ preset: 'fy', from: FULL_FY.from, to: FULL_FY.to })).toEqual({
      preset: 'financial-year',
      custom: { from: FULL_FY.from, to: FULL_FY.to },
    })
    expect(initialExportState({ preset: 'month', from: '2026-12-01', to: '2026-12-31' })).toEqual({
      preset: 'this-month',
      custom: { from: '2026-12-01', to: '2026-12-31' },
    })
    expect(initialExportState({ preset: 'custom', from: '2026-10-01', to: '2026-10-31' })).toEqual({
      preset: 'custom',
      custom: { from: '2026-10-01', to: '2026-10-31' },
    })
  })
})

// ── Filenames (spec §7 / §9) ─────────────────────────────────────────────────

describe('report filenames', () => {
  const input = {
    fold: makeFold(),
    period: FULL_FY,
    store: STORE,
    fy: FY,
  }

  it('composes the specified StoreName_Report_FY pattern', () => {
    expect(reportFilename(input, 'sales-register')).toBe('ABC-Mobile-Store_Sales_Register_FY2026-2027.xlsx')
    expect(reportFilename(input, 'money-register')).toBe('ABC-Mobile-Store_Money_Register_FY2026-2027.xlsx')
    expect(reportFilename(input, 'business-summary')).toBe('ABC-Mobile-Store_Business_Summary_FY2026-2027.xlsx')
    expect(reportFilename(input, 'purchase-register')).toBe('ABC-Mobile-Store_Purchase_Register_FY2026-2027.xlsx')
    expect(reportFilename(input, 'inventory-acquisitions')).toBe('ABC-Mobile-Store_Inventory_Acquisitions_FY2026-2027.xlsx')
    expect(reportFilename(input, 'inventory-snapshot', '2026-12-06')).toBe('ABC-Mobile-Store_Inventory_Snapshot_2026-12-06.xlsx')
  })

  it('stays clean (never fictional) when no store is configured', () => {
    expect(reportFilename({ ...input, store: null }, 'sales-register')).toBe('Sales_Register_FY2026-2027.xlsx')
  })

  it('sanitizes unsafe store names while staying recognizable', () => {
    const messy = { ...input, store: { name: 'ACME/Phones: Pvt "Ltd"', address: null, phone: null } }
    expect(reportFilename(messy, 'money-register')).toBe('ACME-Phones-Pvt-Ltd_Money_Register_FY2026-2027.xlsx')
    expect(slug('ACME/Phones: Pvt "Ltd"')).toBe('ACME-Phones-Pvt-Ltd')
  })

  it('derives the FY fragment from the financial year, falling back to the period', () => {
    expect(fyFilenameFragment(FY, FULL_FY)).toBe('FY2026-2027')
    expect(fyFilenameFragment(null, { from: '2026-04-01', to: '2027-03-31' })).toBe('FY2026-2027')
  })
})

// ── The purchase trend (spec §5.3) ───────────────────────────────────────────

describe('purchase trend', () => {
  const fold = makeFold()

  it('buckets a full financial year by month over the same qualifying rules', () => {
    const points = purchaseTrend(fold.purchases, FULL_FY)
    expect(points).toHaveLength(12)
    expect(points.map((p) => p.label)).toEqual([
      'Apr 2026', 'May 2026', 'Jun 2026', 'Jul 2026', 'Aug 2026', 'Sep 2026',
      'Oct 2026', 'Nov 2026', 'Dec 2026', 'Jan 2027', 'Feb 2027', 'Mar 2027',
    ])
    // Apr 2026 → p3 (13500); Oct 2026 → p1 (100000); Nov 2026 → p2 (91000);
    // Jan 2027 → p4 (24000). The December recovery bill (3000) is EXCLUDED.
    const byLabel = new Map(points.map((p) => [p.label, p.value]))
    expect(byLabel.get('Apr 2026')).toBe(13500)
    expect(byLabel.get('Oct 2026')).toBe(100000)
    expect(byLabel.get('Nov 2026')).toBe(91000)
    expect(byLabel.get('Jan 2027')).toBe(24000)
    expect(byLabel.get('Dec 2026')).toBe(0)
    expect(points.reduce((a, p) => a + p.value, 0)).toBe(228500)
  })

  it('buckets short periods by day', () => {
    const points = purchaseTrend(fold.purchases, { from: '2026-10-05', to: '2026-10-07' })
    expect(points.map((p) => p.label)).toEqual(['5 Oct 2026', '6 Oct 2026', '7 Oct 2026'])
    expect(points.find((p) => p.label === '5 Oct 2026')?.value).toBe(100000)
    expect(points.reduce((a, p) => a + p.value, 0)).toBe(100000)
  })
})

// ── Shared helpers ───────────────────────────────────────────────────────────

describe('receipt numbers', () => {
  it('follow the deterministic RCP convention of the receipt documents', () => {
    expect(receiptNumber('pi1', 'in', '2026-10-07')).toBe('RCP-IN-20261007-PI1')
    expect(receiptNumber('1b100000-0000-4000-8000-000000000012', 'out', '2026-04-01')).toBe('RCP-OUT-20260401-1B100000')
  })
})
