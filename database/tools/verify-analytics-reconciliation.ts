/**
 * FUSIONONE — Analytics/Notice/Excel controlled TEST reconciliation.
 *
 * Verifies the specification's mandatory chain against the LIVE TEST
 * database (read-only; safety abort unless the TEST project):
 *
 *   SQL truth (computed directly in Postgres)
 *     == report data truth (buildBusinessReportData from the real code)
 *     == Excel workbook truth (cell values in the generated workbook)
 *
 * and writes the real TEST Business Report workbook to download/ for
 * visual inspection. SELECT-only: no writes, no mutations.
 */
import postgres from 'postgres'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeFileSync } from 'node:fs'
import { unzipSync, strFromU8 } from 'fflate'

import { isVirtualAcquisition, timelineMap } from '../../src/features/analytics/metrics'
import { buildBusinessReportData } from '../../src/features/reports/data'
import { buildBusinessReportWorkbook } from '../../src/features/reports/excel/workbook'
import type { AnalyticsFold } from '../../src/features/analytics/types'

const HERE = dirname(fileURLToPath(import.meta.url))
const raw = readFileSync(join(HERE, '.env'), 'utf8')
const env: Record<string, string> = Object.fromEntries(
  raw.split('\n').filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => {
    const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
  }),
)
const DB_URL = env.TEST_SUPABASE_DB_URL
if (!DB_URL.includes('egdrnhtmclvhsfjvhyam')) throw new Error('SAFETY ABORT: not the TEST project.')
const sql = postgres(DB_URL, { ssl: { rejectUnauthorized: false }, max: 1, prepare: false })

const FY_START = '2026-04-01'
const FY_END = '2027-03-31'
const TODAY = '2026-12-06'
const GENERATED_AT = '2026-12-06T12:00:00.000Z'
const PERIOD = { preset: 'custom' as const, from: FY_START, to: FY_END }

// ── 1. SQL truth (independent computation, straight from the tables) ─────────

const fy = await sql`SELECT id FROM public.financial_years WHERE start_date = ${FY_START}::date`
if (fy.length === 0) throw new Error('FY 2026-27 not found')
const fyId = fy[0].id as string

const sqlTruth = await sql`
  SELECT
    (SELECT COALESCE(SUM(final_total),0) FROM public.sales WHERE financial_year_id = ${fyId} AND status='active' AND date BETWEEN ${FY_START}::date AND ${FY_END}::date) AS total_sales,
    (SELECT COUNT(*)::int FROM public.sales WHERE financial_year_id = ${fyId} AND status='active' AND date BETWEEN ${FY_START}::date AND ${FY_END}::date) AS invoice_count,
    (SELECT COALESCE(SUM(due),0) FROM public.sales WHERE financial_year_id = ${fyId} AND status='active') AS receivables,
    (SELECT COALESCE(SUM(trade_in_credit),0) FROM public.sales WHERE financial_year_id = ${fyId} AND status='active' AND date BETWEEN ${FY_START}::date AND ${FY_END}::date) AS trade_in_credit,
    (SELECT COALESCE(SUM(total),0) FROM public.purchases WHERE financial_year_id = ${fyId} AND status='active' AND NOT (bill_number LIKE 'PUR-TRD-%')
       AND id NOT IN (SELECT pi.purchase_id FROM public.purchase_items pi JOIN public.inventory_items ii ON ii.id = pi.inventory_item_id WHERE ii.source = 'trade_in')
       AND date BETWEEN ${FY_START}::date AND ${FY_END}::date) AS total_purchases,
    (SELECT COALESCE(SUM(due),0) FROM public.purchases WHERE financial_year_id = ${fyId} AND status='active' AND NOT (bill_number LIKE 'PUR-TRD-%')
       AND id NOT IN (SELECT pi.purchase_id FROM public.purchase_items pi JOIN public.inventory_items ii ON ii.id = pi.inventory_item_id WHERE ii.source = 'trade_in')) AS payables,
    (SELECT COALESCE(SUM(amount),0) FROM public.payments_in WHERE financial_year_id = ${fyId} AND date BETWEEN ${FY_START}::date AND ${FY_END}::date) AS money_in,
    (SELECT COALESCE(SUM(amount),0) FROM public.payments_out WHERE financial_year_id = ${fyId} AND date BETWEEN ${FY_START}::date AND ${FY_END}::date) AS money_out,
    (SELECT COUNT(*)::int FROM public.inventory_items WHERE financial_year_id = ${fyId} AND status='in_stock') AS stock_units,
    (SELECT COALESCE(SUM(purchase_price),0) FROM public.inventory_items WHERE financial_year_id = ${fyId} AND status='in_stock') AS stock_cost,
    (SELECT COALESCE(SUM(credit_value),0) FROM public.trade_ins ti JOIN public.sales s ON s.id = ti.sale_id WHERE s.financial_year_id = ${fyId} AND s.status='active' AND s.date BETWEEN ${FY_START}::date AND ${FY_END}::date) AS trade_in_value,
    (SELECT COUNT(*)::int FROM public.trade_ins ti JOIN public.sales s ON s.id = ti.sale_id WHERE s.financial_year_id = ${fyId} AND s.status='active' AND s.date BETWEEN ${FY_START}::date AND ${FY_END}::date) AS trade_in_count
`
const truth = sqlTruth[0]
console.log('SQL TRUTH (FY 2026-27):', JSON.stringify(truth, null, 2))

// ── 2. Build the fold from the same TEST tables (the fold's exact semantics) ─

const [salesRows, purchaseRows, saleItemRows, purchaseItemRows, payInRows, payOutRows, inventoryRows, tradeInRows, proformaRows, timelineRows] = await Promise.all([
  sql`SELECT s.id, s.bill_number, s.date, s.party_id, p.name AS party_name, s.total, s.discount, s.trade_in_credit, s.final_total, s.paid, s.due, s.status, s.created_at, s.proforma_id
      FROM public.sales s LEFT JOIN public.parties p ON p.id = s.party_id
      WHERE s.financial_year_id = ${fyId} ORDER BY s.date, s.bill_number`,
  sql`SELECT pu.id, pu.bill_number, pu.date, pu.party_id, p.name AS party_name, pu.total, pu.paid, pu.due, pu.status, pu.created_at
      FROM public.purchases pu LEFT JOIN public.parties p ON p.id = pu.party_id
      WHERE pu.financial_year_id = ${fyId} ORDER BY pu.date, pu.bill_number`,
  sql`SELECT si.sale_id, si.sold_price, si.inventory_item_id,
        ii.id AS inv_id, ii.brand, ii.model, ii.imei, ii.ram_rom, ii.color, ii.base_selling_price, ii.purchase_price, ii.status AS inv_status, ii.source
      FROM public.sale_items si LEFT JOIN public.inventory_items ii ON ii.id = si.inventory_item_id`,
  sql`SELECT pi.purchase_id, pi.inventory_item_id, ii.source
      FROM public.purchase_items pi LEFT JOIN public.inventory_items ii ON ii.id = pi.inventory_item_id`,
  sql`SELECT pin.id, pin.sale_id, pin.party_id, p.name AS party_name, pin.amount, pin.date, pin.bank_account_id, pin.payment_mode_id,
        s.bill_number AS sale_bill_number, ba.name AS bank_name, ba.is_cash AS bank_is_cash, pm.name AS mode_name
      FROM public.payments_in pin
      LEFT JOIN public.parties p ON p.id = pin.party_id
      LEFT JOIN public.sales s ON s.id = pin.sale_id
      LEFT JOIN public.bank_accounts ba ON ba.id = pin.bank_account_id
      LEFT JOIN public.payment_modes pm ON pm.id = pin.payment_mode_id
      WHERE pin.financial_year_id = ${fyId} ORDER BY pin.date`,
  sql`SELECT pout.id, pout.purchase_id, pout.party_id, p.name AS party_name, pout.amount, pout.date, pout.bank_account_id, pout.payment_mode_id,
        pu.bill_number AS purchase_bill_number, ba.name AS bank_name, ba.is_cash AS bank_is_cash, pm.name AS mode_name
      FROM public.payments_out pout
      LEFT JOIN public.parties p ON p.id = pout.party_id
      LEFT JOIN public.purchases pu ON pu.id = pout.purchase_id
      LEFT JOIN public.bank_accounts ba ON ba.id = pout.bank_account_id
      LEFT JOIN public.payment_modes pm ON pm.id = pout.payment_mode_id
      WHERE pout.financial_year_id = ${fyId} ORDER BY pout.date`,
  sql`SELECT id, brand, model, imei, ram_rom, color, purchase_price, base_selling_price, status, source, created_at, origin_inventory_item_id, opening_entry_type
      FROM public.inventory_items WHERE financial_year_id = ${fyId} ORDER BY created_at`,
  sql`SELECT ti.id, ti.sale_id, ti.inventory_item_id, ti.credit_value, ti.mrp,
        ii.brand, ii.model, ii.imei, ii.status AS inv_status, ii.source
      FROM public.trade_ins ti LEFT JOIN public.inventory_items ii ON ii.id = ti.inventory_item_id`,
  sql`SELECT pr.id, pr.bill_number, pr.date, pr.status, pr.final_total, pr.party_id, p.name AS party_name
      FROM public.proforma_invoices pr LEFT JOIN public.parties p ON p.id = pr.party_id
      WHERE pr.financial_year_id = ${fyId} ORDER BY pr.date`,
  sql`SELECT id, created_at, origin_inventory_item_id FROM public.inventory_items ORDER BY created_at`,
])

const itemsBySale = new Map<string, Array<{ inventory_items: { source: string | null } | null }>>()
for (const row of saleItemRows as any[]) {
  const list = itemsBySale.get(row.sale_id) ?? []
  list.push({ inventory_items: row.source === null ? null : { source: row.source } })
  itemsBySale.set(row.sale_id, list)
}

// The browser fold receives PostgREST wire shapes: DATE columns as
// 'YYYY-MM-DD' strings and timestamptz as ISO strings. Normalize the
// postgres-js Date objects to the SAME shapes the app code consumes.
const dstr = (v: unknown): string => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? ''))
const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v ?? ''))

const fold: AnalyticsFold = {
  fyId,
  sales: (salesRows as any[]).map((s) => ({ ...s, date: dstr(s.date), created_at: iso(s.created_at) })),
  purchases: (purchaseRows as any[]).map((pu) => ({
    ...pu,
    date: dstr(pu.date),
    created_at: iso(pu.created_at),
    is_virtual: isVirtualAcquisition(
      pu.bill_number,
      (purchaseItemRows as any[]).filter((pi) => pi.purchase_id === pu.id).map((pi) => ({ inventory_items: pi.source === null ? null : { source: pi.source } })),
    ),
  })),
  saleItems: (saleItemRows as any[]).map((si) => ({
    sale_id: si.sale_id,
    sold_price: si.sold_price,
    inventory_items: si.inv_id === null ? null : {
      id: si.inv_id, brand: si.brand, model: si.model, imei: si.imei, ram_rom: si.ram_rom, color: si.color,
      base_selling_price: si.base_selling_price, purchase_price: si.purchase_price, status: si.inv_status, source: si.source,
    },
  })),
  purchaseItems: (purchaseItemRows as any[]).map((pi) => ({
    purchase_id: pi.purchase_id,
    inventory_items: pi.inventory_item_id === null ? null : { id: pi.inventory_item_id, source: pi.source },
  })),
  paymentsIn: (payInRows as any[]).map((p) => ({ ...p, date: dstr(p.date), created_at: iso(p.created_at) })),
  paymentsOut: (payOutRows as any[]).map((p) => ({ ...p, date: dstr(p.date), created_at: iso(p.created_at) })),
  inventory: (inventoryRows as any[]).map((i) => ({ ...i, created_at: iso(i.created_at) })),
  tradeIns: (tradeInRows as any[]).map((ti) => ({
    id: ti.id, sale_id: ti.sale_id, inventory_item_id: ti.inventory_item_id, credit_value: ti.credit_value, mrp: ti.mrp,
    inventory_items: ti.brand === null && ti.imei === null ? null : { brand: ti.brand, model: ti.model, imei: ti.imei, status: ti.inv_status, source: ti.source },
  })),
  proformas: (proformaRows as any[]).map((pr) => ({ ...pr, date: dstr(pr.date) })),
  timeline: (timelineRows as any[]).map((t) => ({ ...t, created_at: iso(t.created_at) })),
  bankAccounts: (await sql`SELECT id, name, is_cash FROM public.bank_accounts ORDER BY name`) as any[],
  paymentModes: (await sql`SELECT id, name, bank_account_id FROM public.payment_modes ORDER BY name`) as any[],
  parties: (await sql`SELECT id, name, number FROM public.parties ORDER BY name`) as any[],
}

// ── 3. Report data from the REAL code ─────────────────────────────────────────

const report = buildBusinessReportData(fold, PERIOD, {
  storeName: 'Fusion Gadgets E2E',
  fy: { start_date: FY_START, end_date: FY_END },
  today: TODAY,
  generatedAt: GENERATED_AT,
})

console.log('\nRECONCILIATION (SQL truth == report data):')
const checks: Array<[string, unknown, unknown]> = [
  ['Total Sales', Number(truth.total_sales), report.overview.sales],
  ['Invoice Count', Number(truth.invoice_count), report.overview.invoiceCount],
  ['Receivables', Number(truth.receivables), report.overview.receivables],
  ['Trade-In Credit', Number(truth.trade_in_credit), report.overview.tradeInValue],
  ['Total Purchases (virtual excluded)', Number(truth.total_purchases), report.overview.purchases],
  ['Payables', Number(truth.payables), report.overview.payables],
  ['Money In', Number(truth.money_in), report.overview.paymentsIn],
  ['Money Out', Number(truth.money_out), report.overview.paymentsOut],
  ['Stock Units', Number(truth.stock_units), report.valuation.units],
  ['Stock Cost', Number(truth.stock_cost), report.valuation.costValue],
  ['Trade-In Devices', Number(truth.trade_in_count), report.tradeInMetrics.received],
  ['Trade-In Value', Number(truth.trade_in_value), report.tradeInMetrics.value],
]
let failures = 0
for (const [label, expected, actual] of checks) {
  const ok = Math.abs(Number(expected) - Number(actual)) < 0.005
  if (!ok) failures++
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}: SQL=${expected} report=${actual}`)
}

// Register-level reconciliation: every register sums to its metric.
const registerSales = report.salesRegister.reduce((a, r) => a + r.total, 0)
const registerDue = report.salesRegister.reduce((a, r) => a + r.due, 0)
const registerPaid = report.salesRegister.reduce((a, r) => a + r.paid, 0)
const payIn = report.paymentRegister.filter((p) => p.direction === 'In').reduce((a, p) => a + p.amount, 0)
const payOut = report.paymentRegister.filter((p) => p.direction === 'Out').reduce((a, p) => a + p.amount, 0)
const invUnits = report.inventoryRegister.length
const tiValue = report.tradeInRegister.reduce((a, r) => a + r.creditValue, 0)
const extra: Array<[string, unknown, unknown]> = [
  ['Register Σtotal == sales', report.overview.sales, registerSales],
  ['Register Σdue == paid+due check', report.salesMetrics.outstandingSales, registerDue],
  ['Register Σpaid == paid sales', report.salesMetrics.paidSales, registerPaid],
  ['Register Σ money in == moneyIn', report.overview.paymentsIn, payIn],
  ['Register Σ money out == moneyOut', report.overview.paymentsOut, payOut],
  ['Register inventory units', report.valuation.units, invUnits],
  ['Register trade-in value', report.tradeInMetrics.value, tiValue],
  ['paid + due == total (invariant)', report.salesMetrics.totalSales, registerPaid + registerDue],
]
for (const [label, expected, actual] of extra) {
  const ok = Math.abs(Number(expected) - Number(actual)) < 0.005
  if (!ok) failures++
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}: ${expected} == ${actual}`)
}

// ── 4. Excel workbook from the REAL code ──────────────────────────────────────

const bytes = await buildBusinessReportWorkbook(report)
const files = unzipSync(bytes)
const ExcelJS = (await import('exceljs')) as any
const wb = new ExcelJS.Workbook()
await wb.xlsx.load(bytes.slice().buffer as ArrayBuffer)
const dashboard = wb.getWorksheet('Dashboard')!

console.log('\nEXCEL TRUTH (workbook cells == report data):')
const cellChecks: Array<[string, number, number]> = [
  ['Dashboard Sales KPI (A11)', report.overview.sales, Number(dashboard.getCell('A11').value)],
  ['Dashboard Purchases KPI (C11)', report.overview.purchases, Number(dashboard.getCell('C11').value)],
  ['Dashboard Payments In KPI (E11)', report.overview.paymentsIn, Number(dashboard.getCell('E11').value)],
  ['Dashboard Payments Out KPI (G11)', report.overview.paymentsOut, Number(dashboard.getCell('G11').value)],
  ['Dashboard Receivables KPI (A14)', report.overview.receivables, Number(dashboard.getCell('A14').value)],
  ['Dashboard Inventory Value KPI (C14)', report.overview.inventoryValue, Number(dashboard.getCell('C14').value)],
  ['Dashboard Invoice Count KPI (E14)', report.overview.invoiceCount, Number(dashboard.getCell('E14').value)],
  ['Dashboard Trade-In Value KPI (G14)', report.overview.tradeInValue, Number(dashboard.getCell('G14').value)],
]
for (const [label, expected, actual] of cellChecks) {
  const ok = Math.abs(expected - actual) < 0.005
  if (!ok) failures++
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}: ${expected} == ${actual}`)
}

// Register totals on the sheets reconcile to the same numbers.
function registerTotal(sheetName: string, col: number): number {
  const ws = wb.getWorksheet(sheetName)!
  for (let row = ws.rowCount; row >= 1; row--) {
    if (ws.getCell(row, 1).value === 'Total') return Number(ws.getCell(row, col).value)
  }
  throw new Error(`No Total row on ${sheetName}`)
}
const sheetChecks: Array<[string, number, number]> = [
  ['Sales Register total', report.overview.sales, registerTotal('Sales Register', 5)],
  ['Purchases total', report.overview.purchases, registerTotal('Purchases', 5)],
  ['Inventory cost total', report.valuation.costValue, registerTotal('Inventory', 7)],
  ['Trade-Ins value total', report.tradeInMetrics.value, registerTotal('Trade-Ins', 6)],
]
for (const [label, expected, actual] of sheetChecks) {
  const ok = Math.abs(expected - actual) < 0.005
  if (!ok) failures++
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}: ${expected} == ${actual}`)
}

// Chart parts present with live caches.
const chartCount = Object.keys(files).filter((n) => /^xl\/charts\/chart\d+\.xml$/.test(n)).length
console.log(`  ${chartCount === 6 ? 'OK  ' : 'FAIL'} Native chart parts: ${chartCount}/6`)
if (chartCount !== 6) failures++

// ── 5. Persist the workbook for visual inspection ────────────────────────────

const outPath = join(HERE, '..', '..', 'download', 'FUSION-ONE-Business-Report-TEST-FY2026-27.xlsx')
writeFileSync(outPath, bytes)
console.log(`\nWorkbook written for visual inspection: ${outPath} (${(bytes.length / 1024).toFixed(1)} KB)`)

await sql.end()
if (failures > 0) {
  console.error(`\nRECONCILIATION FAILED: ${failures} mismatch(es).`)
  process.exit(1)
}
console.log('\nRECONCILIATION COMPLETE: SQL truth == report data == Excel truth. (read-only; TEST project only)')
