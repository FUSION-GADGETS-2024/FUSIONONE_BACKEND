/**
 * FUSIONONE — Analytics Purchase-tab & Excel-export controlled TEST
 * reconciliation (implementation spec §§12.2, 12.5).
 *
 * Verifies the mandatory chain against the LIVE TEST database (read-only;
 * safety abort unless the TEST project):
 *
 *   SQL truth (computed independently, straight from the tables)
 *     == report dataset truth (buildReportDatasets from the real code)
 *     == Excel workbook truth (cell values in the generated workbooks)
 *
 * for all five exports (Business Summary, Sales Register, Money Register,
 * Inventory Snapshot, Inventory Acquisitions, Purchase Register) over the
 * FULL FY 2026-27, plus a boundary-window check (the 31 March 2027 cut)
 * and the financial-year boundary matrix of §10.1 against the live data.
 *
 * Presentation gates: EVERY generated worksheet must carry exactly ONE
 * normal sheetView with hidden gridlines, ZERO panes and ZERO AutoFilter;
 * every register date cell must be the EXACT integer Excel serial of its
 * SQL business date (timezone-immune — run under TZ=Asia/Kolkata to
 * reproduce the generating browser's timezone). The FY 2027-28 SALES
 * Register (the reported defect's report) is generated and boundary-checked.
 *
 * Writes the REAL generated workbooks to download/ for visual inspection.
 * SELECT-only: no writes, no mutations, no message paths.
 */
import postgres from 'postgres'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import ExcelJS from 'exceljs'
import { unzipSync, strFromU8 } from 'fflate'

import { isVirtualAcquisition } from '../../src/features/analytics/metrics'
import { purchasesMetrics } from '../../src/features/analytics/metrics'
import { buildReportDatasets } from '../../src/features/reports/data'
import { buildReportWorkbook } from '../../src/features/reports/excel/workbook'
import type { AnalyticsFold, AnalyticsPeriod } from '../../src/features/analytics/types'

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

const FY2627 = 'c2ff174d-2801-42a1-a83e-5f3737911a51'
const FY2728 = '878833cd-3794-4c68-bf10-acd4222f5d8e'
const FULL_FY: AnalyticsPeriod = { preset: 'custom', from: '2026-04-01', to: '2027-03-31' }
const FULL_FY_2728: AnalyticsPeriod = { preset: 'custom', from: '2027-04-01', to: '2028-03-31' }
const GENERATED_AT = new Date().toISOString()
const TODAY = GENERATED_AT.slice(0, 10)

// ── Assertion harness ────────────────────────────────────────────────────────

let checks = 0
let failures = 0
function check(label: string, actual: unknown, expected: unknown): void {
  checks += 1
  const a = typeof actual === 'number' ? Math.round(actual * 100) / 100 : actual
  const e = typeof expected === 'number' ? Math.round(expected * 100) / 100 : expected
  if (a !== e) {
    failures += 1
    console.error(`  ✗ ${label}: expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`)
  } else {
    console.log(`  ✓ ${label} = ${JSON.stringify(a)}`)
  }
}

// ── Fold construction (the fold's exact FY-scoped semantics) ────────────────

const d = (v: Date | string | null) => (v == null ? null : (typeof v === 'string' ? v.slice(0, 10) : v.toISOString().slice(0, 10)))
const ts = (v: Date | string | null) => (v == null ? null : (typeof v === 'string' ? v : v.toISOString()))

async function loadFold(fyId: string): Promise<AnalyticsFold> {
  const [salesRows, purchaseRows, payInRows, payOutRows, ledgerRows, invRows, trdRows, accounts, modes, parties, timeline] =
    await Promise.all([
      sql`select s.id, s.bill_number, s.date, s.party_id, s.total, s.discount, s.trade_in_credit, s.final_total, s.paid, s.due, s.status, s.created_at,
                 (select name from parties where id = s.party_id) as party_name,
                 (select coalesce(json_agg(json_build_object('sale_id', si.sale_id, 'sold_price', si.sold_price, 'inventory_items',
                    (select json_build_object('id', ii.id, 'brand', ii.brand, 'model', ii.model, 'imei', ii.imei, 'ram_rom', ii.ram_rom, 'color', ii.color,
                       'base_selling_price', ii.base_selling_price, 'purchase_price', ii.purchase_price, 'status', ii.status, 'source', ii.source)
                     from inventory_items ii where ii.id = si.inventory_item_id))), '[]'::json)
                  from sale_items si where si.sale_id = s.id) as sale_items,
                 (select coalesce(json_agg(json_build_object('id', t.id, 'sale_id', t.sale_id, 'inventory_item_id', t.inventory_item_id, 'credit_value', t.credit_value, 'mrp', t.mrp, 'inventory_items',
                    (select json_build_object('brand', ii.brand, 'model', ii.model, 'imei', ii.imei, 'status', ii.status, 'source', ii.source)
                     from inventory_items ii where ii.id = t.inventory_item_id))), '[]'::json)
                  from trade_ins t where t.sale_id = s.id) as trade_ins
          from sales s where s.financial_year_id = ${fyId} order by s.date, s.bill_number`,
      sql`select p.id, p.bill_number, p.date, p.party_id, p.total, p.paid, p.due, p.status, p.created_at,
                 (select name from parties where id = p.party_id) as party_name,
                 (select coalesce(json_agg(json_build_object('purchase_id', pi.purchase_id, 'inventory_items',
                    (select json_build_object('id', ii.id, 'brand', ii.brand, 'model', ii.model, 'imei', ii.imei, 'ram_rom', ii.ram_rom, 'color', ii.color,
                       'purchase_price', ii.purchase_price, 'source', ii.source)
                     from inventory_items ii where ii.id = pi.inventory_item_id))), '[]'::json)
                  from purchase_items pi where pi.purchase_id = p.id) as purchase_items
          from purchases p where p.financial_year_id = ${fyId} order by p.date, p.bill_number`,
      sql`select pi.id, pi.sale_id, pi.party_id, pi.amount, pi.date, pi.created_at, pi.bank_account_id, pi.payment_mode_id,
                 (select name from parties where id = pi.party_id) as party_name,
                 (select bill_number from sales where id = pi.sale_id) as sale_bill_number,
                 (select name from bank_accounts where id = pi.bank_account_id) as bank_name,
                 (select is_cash from bank_accounts where id = pi.bank_account_id) as bank_is_cash,
                 (select name from payment_modes where id = pi.payment_mode_id) as mode_name
          from payments_in pi where pi.financial_year_id = ${fyId} order by pi.date`,
      sql`select po.id, po.purchase_id, po.party_id, po.amount, po.date, po.created_at, po.bank_account_id, po.payment_mode_id,
                 (select name from parties where id = po.party_id) as party_name,
                 (select bill_number from purchases where id = po.purchase_id) as purchase_bill_number,
                 (select name from bank_accounts where id = po.bank_account_id) as bank_name,
                 (select is_cash from bank_accounts where id = po.bank_account_id) as bank_is_cash,
                 (select name from payment_modes where id = po.payment_mode_id) as mode_name
          from payments_out po where po.financial_year_id = ${fyId} order by po.date`,
      sql`select * from account_transactions where financial_year_id = ${fyId} order by date, created_at`,
      sql`select id, brand, model, imei, ram_rom, color, purchase_price, base_selling_price, status, source, created_at, origin_inventory_item_id, opening_entry_type
          from inventory_items where financial_year_id = ${fyId} order by created_at`,
      sql`select * from trade_ins`,
      sql`select id, name, is_cash from bank_accounts order by name`,
      sql`select id, name, bank_account_id from payment_modes order by name`,
      sql`select id, name, number from parties order by name`,
      sql`select id, created_at, origin_inventory_item_id from inventory_items order by created_at`,
    ])

  const sales = salesRows.map((s: any) => ({
    id: s.id, bill_number: s.bill_number, date: d(s.date), party_id: s.party_id, party_name: s.party_name,
    total: s.total, discount: s.discount, trade_in_credit: s.trade_in_credit, final_total: s.final_total,
    paid: s.paid, due: s.due, status: s.status, created_at: ts(s.created_at), proforma_id: null,
  }))
  const saleItems = salesRows.flatMap((s: any) => s.sale_items ?? [])
  const tradeIns = salesRows.flatMap((s: any) => s.trade_ins ?? [])
  const purchases = purchaseRows.map((p: any) => {
    const items = (p.purchase_items ?? []) as Array<{ inventory_items: { source: string | null } | null }>
    return {
      id: p.id, bill_number: p.bill_number, date: d(p.date), party_id: p.party_id, party_name: p.party_name,
      total: p.total, paid: p.paid, due: p.due, status: p.status, created_at: ts(p.created_at),
      is_virtual: isVirtualAcquisition(p.bill_number, items),
    }
  })
  const purchaseItems = purchaseRows.flatMap((p: any) => p.purchase_items ?? [])

  return {
    fyId,
    sales,
    purchases,
    saleItems,
    purchaseItems,
    paymentsIn: payInRows.map((p: any) => ({ ...p, date: d(p.date) })),
    paymentsOut: payOutRows.map((p: any) => ({ ...p, date: d(p.date) })),
    accountTransactions: ledgerRows.map((t: any) => ({
      id: t.id, bank_account_id: t.bank_account_id, payment_mode_id: t.payment_mode_id, type: t.type,
      amount: t.amount, date: d(t.date), reference_type: t.reference_type, reference_id: t.reference_id,
      notes: t.notes, transfer_group_id: t.transfer_group_id, created_at: ts(t.created_at),
    })),
    inventory: invRows.map((i: any) => ({ ...i, created_at: ts(i.created_at) })),
    tradeIns: trdRows.map((t: any) => ({ ...t, inventory_items: (t.inventory_items as any) ?? null })),
    proformas: [],
    timeline: timeline.map((t: any) => ({ id: t.id, created_at: ts(t.created_at), origin_inventory_item_id: t.origin_inventory_item_id })),
    bankAccounts: accounts as AnalyticsFold['bankAccounts'],
    paymentModes: modes as AnalyticsFold['paymentModes'],
    parties: parties as AnalyticsFold['parties'],
  }
}

// ── Workbook value extraction ────────────────────────────────────────────────

/** Finds a row (1-based) in column 1 whose value equals `label`. */
function rowOf(ws: ExcelJS.Worksheet, label: string, max = 60): number {
  for (let r = 1; r <= max; r++) if (String(ws.getCell(r, 1).value ?? '') === label) return r
  throw new Error(`label "${label}" not found on ${ws.name}`)
}

/** The header row of a sheet (first row whose first cell is a known header). */
function headerRow(ws: ExcelJS.Worksheet, firstHeader: string): number {
  for (let r = 1; r <= 12; r++) if (String(ws.getCell(r, 1).value ?? '') === firstHeader) return r
  throw new Error(`header "${firstHeader}" not found on ${ws.name}`)
}

/** Sums a worksheet column over the data rows (between header and totals). */
function sumColumn(ws: ExcelJS.Worksheet, headerRowNumber: number, col: number): number {
  let sum = 0
  for (let r = headerRowNumber + 1; r <= ws.rowCount; r++) {
    const label = String(ws.getCell(r, 1).value ?? '')
    if (label === '—' || label.startsWith('Total') || label.includes('business movements')) continue
    const v = ws.getCell(r, col).value
    if (typeof v === 'number') sum += v
  }
  return sum
}

// ── Structural OOXML gates (view / filter / date-serial) ───────────────────

/** Maps a worksheet NAME → its worksheet XML through the workbook rels. */
function sheetXmlOf(bytes: Uint8Array, wsName: string): string {
  const zip = unzipSync(bytes)
  const wbXml = strFromU8(zip['xl/workbook.xml'])
  const relsXml = strFromU8(zip['xl/_rels/workbook.xml.rels'])
  const sheetTag = wbXml.match(new RegExp(`<sheet[^>]*name="${wsName}"[^>]*/>`))?.[0] ?? ''
  const rid = sheetTag.match(/r:id="([^"]+)"/)?.[1] ?? ''
  const relTag = relsXml.match(new RegExp(`<Relationship[^>]*Id="${rid}"[^>]*/>`))?.[0] ?? ''
  const target = relTag.match(/Target="([^"]+)"/)?.[1] ?? ''
  const path = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\.\//, '')}`
  const xml = zip[path]
  if (!xml) throw new Error(`sheet part "${path}" not found`)
  return strFromU8(xml)
}

/** Every worksheet of one workbook must carry the presentation contract:
 * exactly ONE normal sheetView with hidden gridlines, ZERO panes, ZERO
 * autoFilter, and no Excel-table filter parts. */
function structuralViewGate(label: string, bytes: Uint8Array): void {
  const zip = unzipSync(bytes)
  const wbXml = strFromU8(zip['xl/workbook.xml'])
  const relsXml = strFromU8(zip['xl/_rels/workbook.xml.rels'])
  const sheetTags = wbXml.match(/<sheet[^>]*name="([^"]+)"[^>]*\/>/g) ?? []
  for (const tag of sheetTags) {
    const name = tag.match(/name="([^"]+)"/)?.[1] ?? ''
    const rid = tag.match(/r:id="([^"]+)"/)?.[1] ?? ''
    const target = relsXml.match(new RegExp(`<Relationship[^>]*Id="${rid}"[^>]*/>`))?.[0]?.match(/Target="([^"]+)"/)?.[1] ?? ''
    const path = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\.\//, '')}`
    const xml = strFromU8(zip[path] ?? new Uint8Array())
    check(`${label} · “${name}”: exactly ONE sheetView`, (xml.match(/<sheetView[\s>]/g) ?? []).length, 1)
    check(`${label} · “${name}”: gridlines hidden`, /<sheetView[^>]*showGridLines="0"/.test(xml), true)
    check(`${label} · “${name}”: ZERO pane elements`, (xml.match(/<pane[\s>]/g) ?? []).length, 0)
    check(`${label} · “${name}”: no frozen/split state`, /state="(frozen|split)"/.test(xml), false)
    check(`${label} · “${name}”: NO autoFilter`, /<autoFilter/.test(xml), false)
    check(`${label} · "${name}": no Excel-table parts`, /<tableParts/.test(xml), false)
  }
  check(`${label}: no xl/tables/ parts in the zip`, Object.keys(zip).some((e) => e.includes('xl/tables/')), false)
}

/** An Excel serial → its YYYY-MM-DD day (the serial's integer meaning). */
function serialToDay(serial: number): string {
  return new Date(Math.round((serial - 25569) * 86_400_000)).toISOString().slice(0, 10)
}

/** Every date cell of a register sheet (column A, after the header row)
 * must be the EXACT integer day of its business date — never a fractional
 * previous-day serial (the timezone defect). */
function dateSerialGate(label: string, bytes: Uint8Array, wsName: string, expectedDays: string[]): void {
  const xml = sheetXmlOf(bytes, wsName)
  const serials: number[] = []
  // Only NUMERIC cells (no t="s"/"str" attribute) in column A are date
  // serials — masthead/header/label/note cells are strings and are skipped.
  for (const m of xml.matchAll(/<c r="A(\d+)"(?![^>]*\st=")[^>]*><v>([\d.]+)<\/v>/g)) {
    serials.push(Number(m[2]))
  }
  check(`${label} · ${wsName}: date-cell count == business rows`, serials.length, expectedDays.length)
  const rendered = serials.map(serialToDay)
  check(`${label} · ${wsName}: rendered days == the actual business dates`, rendered.join(','), expectedDays.join(','))
  check(`${label} · ${wsName}: every date serial is an exact integer day`, serials.every((s) => Number.isInteger(s)), true)
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const [store] = await sql`select name, address, phone from store`
  const fold = await loadFold(FY2627)
  const bundle = buildReportDatasets({
    fold,
    period: FULL_FY,
    store: store as { name: string; address: string | null; phone: string },
    fy: { start_date: '2026-04-01', end_date: '2027-03-31' },
    today: TODAY,
    generatedAt: GENERATED_AT,
  })

  console.log(`Store: ${store.name} · FY 2026-27 · generated ${GENERATED_AT}`)

  // ── 1. Independent SQL truth ──────────────────────────────────────────────
  const [truth] = await sql`
    select
      (select coalesce(sum(final_total), 0) from sales where financial_year_id = ${FY2627} and status = 'active' and date between '2026-04-01' and '2027-03-31') as sales_value,
      (select coalesce(sum(total), 0) from purchases p where p.financial_year_id = ${FY2627} and p.status = 'active'
         and not (p.bill_number like 'PUR-TRD-%')
         and not exists (select 1 from purchase_items pi join inventory_items ii on ii.id = pi.inventory_item_id
                          where pi.purchase_id = p.id and ii.source = 'trade_in'
                          having count(*) = (select count(*) from purchase_items pi2 where pi2.purchase_id = p.id))
         and p.date between '2026-04-01' and '2027-03-31') as purchase_value,
      (select coalesce(sum(amount), 0) from payments_in where financial_year_id = ${FY2627} and date between '2026-04-01' and '2027-03-31') as payments_in,
      (select coalesce(sum(amount), 0) from payments_out where financial_year_id = ${FY2627} and date between '2026-04-01' and '2027-03-31') as payments_out,
      (select coalesce(sum(due), 0) from sales where financial_year_id = ${FY2627} and status = 'active') as customer_outstanding,
      (select coalesce(sum(due), 0) from purchases where financial_year_id = ${FY2627} and status = 'active') as supplier_outstanding,
      (select count(*) from inventory_items where financial_year_id = ${FY2627} and status = 'in_stock') as in_stock_records,
      (select coalesce(sum(purchase_price), 0) from inventory_items where financial_year_id = ${FY2627} and status = 'in_stock') as in_stock_cost,
      (select count(*) from inventory_items where financial_year_id = ${FY2627}) as inventory_records,
      (select coalesce(sum(purchase_price), 0) from inventory_items where financial_year_id = ${FY2627}) as inventory_cost,
      (select count(*) from account_transactions where financial_year_id = ${FY2627} and date between '2026-04-01' and '2027-03-31') as ledger_rows,
      (select coalesce(sum(case when type = 'credit' and reference_type not in ('transfer', 'opening_balance') then amount end), 0)
         from account_transactions where financial_year_id = ${FY2627} and date between '2026-04-01' and '2027-03-31') as money_in_business,
      (select coalesce(sum(case when type = 'debit' and reference_type not in ('transfer', 'opening_balance') then amount end), 0)
         from account_transactions where financial_year_id = ${FY2627} and date between '2026-04-01' and '2027-03-31') as money_out_business`

  console.log('\n── Business Summary: SQL truth == dataset == workbook ──')
  const ds = bundle.reports['business-summary']
  const summaryValue = (label: string): unknown => {
    for (const block of ds.sheets[0].blocks) {
      if (block.kind !== 'summary') continue
      const row = block.rows.find((r) => r.label === label)
      if (row) return row.value
    }
    throw new Error(`summary row ${label} missing`)
  }
  check('SQL sales value == dataset Sales Value', summaryValue('Sales Value'), Number(truth.sales_value))
  check('SQL purchase value == dataset Purchase Value', summaryValue('Purchase Value'), Number(truth.purchase_value))
  check('SQL payments in == dataset Payments Received', summaryValue('Payments Received'), Number(truth.payments_in))
  check('SQL payments out == dataset Payments Made', summaryValue('Payments Made'), Number(truth.payments_out))
  check('SQL receivables == dataset Customer Outstanding', summaryValue('Customer Outstanding'), Number(truth.customer_outstanding))
  check('SQL payables == dataset Supplier Outstanding', summaryValue('Supplier Outstanding'), Number(truth.supplier_outstanding))
  check('SQL in-stock records == dataset count', summaryValue('In-stock inventory records'), Number(truth.in_stock_records))
  check('SQL in-stock cost == dataset valuation', summaryValue('Recorded acquisition cost of in-stock inventory'), Number(truth.in_stock_cost))

  // ── 2. The Sales / Purchase registers ─────────────────────────────────────
  console.log('\n── Registers: SQL truth == dataset rows == workbook totals ──')
  const [reg] = await sql`
    select
      (select coalesce(sum(final_total), 0) from sales where financial_year_id = ${FY2627} and status = 'active' and date between '2026-04-01' and '2027-03-31') as sales_total,
      (select coalesce(sum(paid), 0) from sales where financial_year_id = ${FY2627} and status = 'active' and date between '2026-04-01' and '2027-03-31') as sales_received,
      (select coalesce(sum(due), 0) from sales where financial_year_id = ${FY2627} and status = 'active' and date between '2026-04-01' and '2027-03-31') as sales_balance,
      (select count(*) from sales where financial_year_id = ${FY2627} and status = 'active' and date between '2026-04-01' and '2027-03-31') as sales_count,
      (select coalesce(sum(total), 0) from purchases p where p.financial_year_id = ${FY2627} and p.status = 'active'
         and not (p.bill_number like 'PUR-TRD-%')
         and not exists (select 1 from purchase_items pi join inventory_items ii on ii.id = pi.inventory_item_id
                          where pi.purchase_id = p.id and ii.source = 'trade_in'
                          having count(*) = (select count(*) from purchase_items pi2 where pi2.purchase_id = p.id))
         and p.date between '2026-04-01' and '2027-03-31') as purchases_total,
      (select coalesce(sum(paid), 0) from purchases p where p.financial_year_id = ${FY2627} and p.status = 'active'
         and not (p.bill_number like 'PUR-TRD-%')
         and not exists (select 1 from purchase_items pi join inventory_items ii on ii.id = pi.inventory_item_id
                          where pi.purchase_id = p.id and ii.source = 'trade_in'
                          having count(*) = (select count(*) from purchase_items pi2 where pi2.purchase_id = p.id))
         and p.date between '2026-04-01' and '2027-03-31') as purchases_paid,
      (select count(*) from purchases p where p.financial_year_id = ${FY2627} and p.status = 'active'
         and not (p.bill_number like 'PUR-TRD-%')
         and not exists (select 1 from purchase_items pi join inventory_items ii on ii.id = pi.inventory_item_id
                          where pi.purchase_id = p.id and ii.source = 'trade_in'
                          having count(*) = (select count(*) from purchase_items pi2 where pi2.purchase_id = p.id))
         and p.date between '2026-04-01' and '2027-03-31') as purchases_count,
      (select count(*) from sale_items si join sales s on s.id = si.sale_id
         where s.financial_year_id = ${FY2627} and s.status = 'active' and s.date between '2026-04-01' and '2027-03-31') as sale_item_rows,
      (select coalesce(sum(si.sold_price), 0) from sale_items si join sales s on s.id = si.sale_id
         where s.financial_year_id = ${FY2627} and s.status = 'active' and s.date between '2026-04-01' and '2027-03-31') as sale_item_value`

  const salesDs = bundle.reports['sales-register']
  const salesRows = (salesDs.sheets[0].blocks.find((b) => b.kind === 'table') as any).rows
  check('SQL sales count == dataset rows', salesRows.length, Number(reg.sales_count))
  check('SQL sales total == dataset Σ total', salesRows.reduce((a: number, r: any) => a + r.total, 0), Number(reg.sales_total))
  check('SQL sales received == dataset Σ received', salesRows.reduce((a: number, r: any) => a + r.received, 0), Number(reg.sales_received))
  check('SQL sales balance == dataset Σ balance', salesRows.reduce((a: number, r: any) => a + r.balance, 0), Number(reg.sales_balance))

  const purchaseDs = bundle.reports['purchase-register']
  const purchaseRows = (purchaseDs.sheets[0].blocks.find((b) => b.kind === 'table') as any).rows
  check('SQL purchase count == dataset rows', purchaseRows.length, Number(reg.purchases_count))
  check('SQL purchase total == dataset Σ total', purchaseRows.reduce((a: number, r: any) => a + r.total, 0), Number(reg.purchases_total))
  check('SQL purchase paid == dataset Σ paid', purchaseRows.reduce((a: number, r: any) => a + r.paid, 0), Number(reg.purchases_paid))

  const saleItemsRows = (salesDs.sheets[1].blocks.find((b) => b.kind === 'table') as any).rows
  check('SQL sale-item rows == dataset item rows', saleItemsRows.length, Number(reg.sale_item_rows))
  check('SQL sale-item value == dataset Σ sale value', saleItemsRows.reduce((a: number, r: any) => a + r.saleValue, 0), Number(reg.sale_item_value))

  // ── 3. The Money Register ─────────────────────────────────────────────────
  console.log('\n── Money Register: SQL ledger truth == dataset == workbook ──')
  const moneyDs = bundle.reports['money-register']
  const moneyRows = (moneyDs.sheets[0].blocks.find((b) => b.kind === 'table') as any).rows
  check('SQL ledger rows == dataset rows', moneyRows.length, Number(truth.ledger_rows))
  const dsMoneyIn = moneyRows.reduce((a: number, r: any) => a + (r.moneyIn ?? 0) * (r.internal ? 0 : 1), 0)
  const dsMoneyOut = moneyRows.reduce((a: number, r: any) => a + (r.moneyOut ?? 0) * (r.internal ? 0 : 1), 0)
  check('SQL business money-in == dataset business Σ moneyIn', dsMoneyIn, Number(truth.money_in_business))
  check('SQL business money-out == dataset business Σ moneyOut', dsMoneyOut, Number(truth.money_out_business))

  // ── 4. Inventory snapshot / acquisitions ──────────────────────────────────
  console.log('\n── Inventory: SQL truth == datasets ──')
  const snapDs = bundle.reports['inventory-snapshot']
  const snapRows = (snapDs.sheets[0].blocks.find((b) => b.kind === 'table') as any).rows
  check('SQL inventory records == snapshot rows', snapRows.length, Number(truth.inventory_records))
  check('SQL inventory cost == snapshot Σ cost', snapRows.reduce((a: number, r: any) => a + r.cost, 0), Number(truth.inventory_cost))

  // Acquisitions: every FY 26-27 inventory row acquired (created) in the
  // FY window — via the origin chain, carried-forward rows resolve to their
  // original acquisition (all FY 26-27 rows here are originals).
  const [acq] = await sql`
    select count(*) as n, coalesce(sum(purchase_price), 0) as cost
    from inventory_items
    where financial_year_id = ${FY2627} and created_at::date between '2026-04-01' and '2027-03-31'`
  const acqDs = bundle.reports['inventory-acquisitions']
  const acqRows = (acqDs.sheets[0].blocks.find((b) => b.kind === 'table') as any).rows
  check('SQL acquisition rows == dataset rows', acqRows.length, Number(acq.n))
  check('SQL acquisition cost == dataset Σ cost', acqRows.reduce((a: number, r: any) => a + r.cost, 0), Number(acq.cost))

  // ── 5. The FY boundary matrix against live data (§10.1) ──────────────────
  console.log('\n── FY boundary matrix on live data (§10.1) ──')
  const [edges] = await sql`
    select
      (select count(*) from sales where financial_year_id = ${FY2627} and date = '2027-03-31' and status = 'active') as fy_end_sales,
      (select count(*) from sales where financial_year_id = ${FY2627} and date = '2026-04-01' and status = 'active') as fy_start_sales,
      (select count(*) from purchases where financial_year_id = ${FY2627} and date = '2026-04-01' and status = 'active') as fy_start_purchases`
const dateKeyOf = (v: unknown) => {
    const dt = v as Date
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`
  }
  check('31 Mar 2027 sales INCLUDED in the FY period', salesRows.filter((r: any) => dateKeyOf(r.date) === '2027-03-31').length, Number(edges.fy_end_sales))
  check('1 Apr 2026 sales INCLUDED in the FY period', salesRows.filter((r: any) => dateKeyOf(r.date) === '2026-04-01').length, Number(edges.fy_start_sales))
  check('1 Apr 2026 purchases INCLUDED in the FY period', purchaseRows.filter((r: any) => dateKeyOf(r.date) === '2026-04-01').length, Number(edges.fy_start_purchases))
  // No record dated outside the FY window appears in any FY-period report.
  const [outside] = await sql`select count(*) as n from sales where financial_year_id = ${FY2627} and (date < '2026-04-01' or date > '2027-03-31')`
  check('No out-of-window sale leaks into the register', salesRows.filter((r: any) => {
    const key = dateKeyOf(r.date)
    return key < '2026-04-01' || key > '2027-03-31'
  }).length, Number(outside.n))

  // ── 6. Generate the REAL workbooks and verify their cells ─────────────────
  console.log('\n── The five REAL workbooks (written to download/) ──')
  const outDir = join(HERE, '..', '..', 'download')
  mkdirSync(outDir, { recursive: true })
  const storeSlug = String(store.name).replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '')

  // The SQL business dates of the FY 2026-27 active sales — the expected
  // register days for the date-serial gate (register order: date, bill).
  const salesDays2627 = (
    await sql`select to_char(date, 'YYYY-MM-DD') as day from sales
      where financial_year_id = ${FY2627} and status = 'active' and date between '2026-04-01' and '2027-03-31'
      order by date, bill_number`
  ).map((r: { day: string }) => r.day)

  const specs: Array<{ id: keyof typeof bundle.reports; file: string }> = [
    { id: 'business-summary', file: `${storeSlug}_Business_Summary_FY2026-2027.xlsx` },
    { id: 'sales-register', file: `${storeSlug}_Sales_Register_FY2026-2027.xlsx` },
    { id: 'money-register', file: `${storeSlug}_Money_Register_FY2026-2027.xlsx` },
    { id: 'inventory-snapshot', file: `${storeSlug}_Inventory_Snapshot_${TODAY}.xlsx` },
    { id: 'inventory-acquisitions', file: `${storeSlug}_Inventory_Acquisitions_FY2026-2027.xlsx` },
    { id: 'purchase-register', file: `${storeSlug}_Purchase_Register_FY2026-2027.xlsx` },
  ]
  for (const spec of specs) {
    const bytes = await buildReportWorkbook(bundle.meta, bundle.reports[spec.id])
    writeFileSync(join(outDir, spec.file), bytes)
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(bytes.slice().buffer as ArrayBuffer)

    // The presentation contract on EVERY worksheet of EVERY workbook.
    structuralViewGate(spec.file, bytes)

    if (spec.id === 'business-summary') {
      const ws = wb.worksheets[0]
      check('workbook Sales Value cell', ws.getCell(rowOf(ws, 'Sales Value'), 4).value, Number(truth.sales_value))
      check('workbook Purchase Value cell', ws.getCell(rowOf(ws, 'Purchase Value'), 4).value, Number(truth.purchase_value))
      check('workbook Customer Outstanding cell', ws.getCell(rowOf(ws, 'Customer Outstanding'), 4).value, Number(truth.customer_outstanding))
      check('workbook masthead store', String(ws.getCell(1, 1).value), String(store.name).toUpperCase())
    }
    if (spec.id === 'sales-register') {
      const ws = wb.worksheets[0]
      const hr = headerRow(ws, 'Date')
      const totalRow = rowOf(ws, 'Total')
      check('workbook sales total cell', ws.getCell(totalRow, 5).value, Number(reg.sales_total))
      check('workbook sales received cell', ws.getCell(totalRow, 6).value, Number(reg.sales_received))
      check('workbook sales balance cell', ws.getCell(totalRow, 7).value, Number(reg.sales_balance))
      check('workbook column sum == totals row (Total Amount)', sumColumn(ws, hr, 5), Number(reg.sales_total))
      const items = wb.worksheets[1]
      const ihr = headerRow(items, 'Invoice No.')
      check('workbook sale-items value sum', sumColumn(items, ihr, 6), Number(reg.sale_item_value))
      // The date-serial gate: every register date cell must be the EXACT
      // integer day of the SQL business date (no timezone shift).
      dateSerialGate('Sales_Register_FY2026-2027', bytes, 'Sales Register', salesDays2627)
    }
    if (spec.id === 'purchase-register') {
      const ws = wb.worksheets[0]
      const totalRow = rowOf(ws, 'Total')
      check('workbook purchase total cell', ws.getCell(totalRow, 5).value, Number(reg.purchases_total))
      check('workbook purchase paid cell', ws.getCell(totalRow, 6).value, Number(reg.purchases_paid))
    }
    if (spec.id === 'money-register') {
      const ws = wb.worksheets[0]
      const totalRow = rowOf(ws, 'Total (business movements)')
      check('workbook money-in total cell', ws.getCell(totalRow, 8).value, Number(truth.money_in_business))
      check('workbook money-out total cell', ws.getCell(totalRow, 9).value, Number(truth.money_out_business))
    }
    if (spec.id === 'inventory-snapshot') {
      const ws = wb.worksheets[0]
      check('workbook snapshot As-of meta', String(ws.getCell(4, 1).value).includes(`As of: `), true)
      // Summary values render in the sheet's SPAN column (11 for the
      // eleven-field register).
      const valuationRow = rowOf(ws, 'Recorded acquisition cost of in-stock inventory')
      const valuationCol = ws.columnCount
      check('workbook snapshot valuation', ws.getCell(valuationRow, valuationCol).value, Number(truth.in_stock_cost))
    }
    console.log(`  ✓ wrote ${spec.file} (${wb.worksheets.length} sheet${wb.worksheets.length === 1 ? '' : 's'}, ${(bytes.length / 1024).toFixed(1)} KB)`)
  }

  // ── 7. FY 2027-28 purchase-analytics reconciliation (the reported defect) ──
  console.log('\n── FY 2027-28: purchase analytics + footer count + workbook ──')
  const fold2728 = await loadFold(FY2728)
  const store2728 = store
  const bundle2728 = buildReportDatasets({
    fold: fold2728,
    period: FULL_FY_2728,
    store: store2728,
    fy: { start_date: '2027-04-01', end_date: '2028-03-31' } as any,
    today: TODAY,
    generatedAt: GENERATED_AT,
  })

  // INDEPENDENT SQL truth for FY 2027-28 ordinary supplier purchases. The
  // internal-acquisition classification mirrors the app's canon EXACTLY but
  // is computed directly in SQL: PUR-TRD prefix OR (has items AND every
  // item sourced trade_in). Real bills = active + in-period + NOT internal.
  const [reg2728] = await sql`
    with classified as (
      select p.id, p.total, p.paid, p.due, p.status, p.date,
             (p.bill_number like 'PUR-TRD-%'
              or (exists (select 1 from purchase_items pi where pi.purchase_id = p.id)
                  and not exists (select 1 from purchase_items pi
                                    join inventory_items ii on ii.id = pi.inventory_item_id
                                   where pi.purchase_id = p.id and coalesce(ii.source, '') <> 'trade_in'))
             ) as is_internal
        from purchases p where p.financial_year_id = ${FY2728}
    )
    select
      (select coalesce(sum(total), 0) from classified
        where status = 'active' and date between '2027-04-01' and '2028-03-31' and not is_internal) as purchases_total,
      (select coalesce(sum(paid), 0) from classified
        where status = 'active' and date between '2027-04-01' and '2028-03-31' and not is_internal) as purchases_paid,
      (select coalesce(sum(due), 0) from classified
        where status = 'active' and date between '2027-04-01' and '2028-03-31' and not is_internal) as purchases_due,
      (select count(*) from classified
        where status = 'active' and date between '2027-04-01' and '2028-03-31' and not is_internal) as purchases_count,
      (select count(*) from classified
        where date between '2027-04-01' and '2028-03-31' and is_internal) as internal_in_period`

  const metrics2728 = purchasesMetrics(fold2728.purchases, FULL_FY_2728)
  check('FY2728 SQL real bill count == purchasesMetrics.billCount', metrics2728.billCount, Number(reg2728.purchases_count))
  check('FY2728 SQL purchase value == purchasesMetrics.totalPurchases', metrics2728.totalPurchases, Number(reg2728.purchases_total))
  check('FY2728 SQL paid == purchasesMetrics.paidPurchases', metrics2728.paidPurchases, Number(reg2728.purchases_paid))
  check('FY2728 SQL outstanding == purchasesMetrics.outstandingPurchases', metrics2728.outstandingPurchases, Number(reg2728.purchases_due))
  check('FY2728 SQL internal-acquisition records == purchasesMetrics.virtualBillCount (footer)', metrics2728.virtualBillCount, Number(reg2728.internal_in_period))

  const prDs2728 = bundle2728.reports['purchase-register']
  const prRows2728 = ((prDs2728.sheets[0].blocks.find((b) => b.kind === 'table') as any).rows) as Array<Record<string, unknown>>
  check('FY2728 dataset register rows == SQL real bills', prRows2728.length, Number(reg2728.purchases_count))
  check('FY2728 dataset Σ total == SQL truth', prRows2728.reduce((a, r) => a + Number(r.total), 0), Number(reg2728.purchases_total))
  check('FY2728 dataset Σ paid == SQL truth', prRows2728.reduce((a, r) => a + Number(r.paid), 0), Number(reg2728.purchases_paid))
  check('FY2728 dataset Σ balance == SQL truth', prRows2728.reduce((a, r) => a + Number(r.balance), 0), Number(reg2728.purchases_due))
  check('FY2728 the recovery bill (plain PUR numbering) is classified internal and excluded',
    prRows2728.some((r) => String(r.billNumber) === 'PUR-2027-28-0006'), false)

  // The freshly generated FY 2027-28 Purchase Register workbook.
  const bytes2728 = await buildReportWorkbook(bundle2728.meta, prDs2728)
  const file2728 = `${storeSlug}_Purchase_Register_FY2027-2028.xlsx`
  writeFileSync(join(outDir, file2728), bytes2728)
  structuralViewGate(file2728, bytes2728)
  const wb2728 = new ExcelJS.Workbook()
  await wb2728.xlsx.load(bytes2728.slice().buffer as ArrayBuffer)
  const ws2728 = wb2728.worksheets[0]
  const totalRow2728 = rowOf(ws2728, 'Total')
  check('FY2728 workbook purchase total cell', ws2728.getCell(totalRow2728, 5).value, Number(reg2728.purchases_total))
  check('FY2728 workbook purchase paid cell', ws2728.getCell(totalRow2728, 6).value, Number(reg2728.purchases_paid))
  console.log(`  ✓ wrote ${file2728} (${wb2728.worksheets.length} sheets, ${(bytes2728.length / 1024).toFixed(1)} KB)`)

  // ── 7b. THE FY 2027-28 SALES REGISTER (the reported defect's report) ────
  console.log('\n── FY 2027-28: Sales Register workbook (boundary + date serial) ──')
  const srDs2728 = bundle2728.reports['sales-register']
  const srRows2728 = ((srDs2728.sheets[0].blocks.find((b) => b.kind === 'table') as any).rows) as Array<Record<string, unknown>>

  // SQL truth: the active FY 2027-28 sales in period (register order).
  const sales2728Sql = await sql`select bill_number, to_char(date, 'YYYY-MM-DD') as day, final_total
    from sales where financial_year_id = ${FY2728} and status = 'active' and date between '2027-04-01' and '2028-03-31'
    order by date, bill_number`
  check('FY2728 dataset register rows == SQL active sales', srRows2728.length, sales2728Sql.length)
  check('FY2728 dataset register bills == SQL bills',
    srRows2728.map((r) => r.billNumber).join(','),
    sales2728Sql.map((s: any) => s.bill_number).join(','))
  check('FY2728 the cancelled invoice is excluded',
    srRows2728.some((r) => String(r.billNumber) === 'SAL-2027-28-0005'), false)

  const bytesSr2728 = await buildReportWorkbook(bundle2728.meta, srDs2728)
  const fileSr2728 = `${storeSlug}_Sales_Register_FY2027-2028.xlsx`
  writeFileSync(join(outDir, fileSr2728), bytesSr2728)
  structuralViewGate(fileSr2728, bytesSr2728)
  dateSerialGate('Sales_Register_FY2027-2028', bytesSr2728, 'Sales Register',
    sales2728Sql.map((s: any) => s.day))
  const wbSr2728 = new ExcelJS.Workbook()
  await wbSr2728.xlsx.load(bytesSr2728.slice().buffer as ArrayBuffer)
  const wsSr2728 = wbSr2728.worksheets[0]
  const hrSr2728 = headerRow(wsSr2728, 'Date')
  // THE boundary assertion: the register carries exactly the SQL bills …
  const billsSr2728: string[] = []
  for (let r = hrSr2728 + 1; r <= wsSr2728.rowCount; r++) {
    const v = String(wsSr2728.getCell(r, 2).value ?? '')
    if (v.startsWith('SAL-')) billsSr2728.push(v)
  }
  check('FY2728 workbook register bills', billsSr2728.join(','), sales2728Sql.map((s: any) => s.bill_number).join(','))
  // … and the first (1 April 2027 boundary) invoice renders exactly on its
  // business day — never as 31 March 2027.
  const firstDate = wsSr2728.getCell(hrSr2728 + 1, 1).value
  check('FY2728 first register date is a real Date cell', firstDate instanceof Date, true)
  if (firstDate instanceof Date) {
    const day = `${firstDate.getUTCFullYear()}-${String(firstDate.getUTCMonth() + 1).padStart(2, '0')}-${String(firstDate.getUTCDate()).padStart(2, '0')}`
    check('FY2728 the 1 Apr 2027 boundary invoice renders on 2027-04-01 (never 31 Mar 2027)', day, String(sales2728Sql[0].day))
  }
  console.log(`  ✓ wrote ${fileSr2728} (${wbSr2728.worksheets.length} sheets, ${(bytesSr2728.length / 1024).toFixed(1)} KB)`)

  // ── 8. The date-in-FY integrity gate (the corrected invariant) ─────────────
  console.log('\n── Date-in-FY integrity gate (every dated business table) ──')
  for (const table of ['purchases', 'sales', 'payments_in', 'payments_out', 'account_transactions', 'proforma_invoices']) {
    const bad = await sql.unsafe(`
      SELECT count(*)::int AS n FROM public.${table} t
       WHERE t.financial_year_id IS NOT NULL
         AND (t.date < (SELECT f.start_date FROM public.financial_years f WHERE f.id = t.financial_year_id)
           OR t.date > (SELECT f.end_date FROM public.financial_years f WHERE f.id = t.financial_year_id))`)
    check(`${table}: every date lies inside its financial year`, bad[0].n, 0)
  }

  console.log(`\n${checks} checks, ${failures} failures`)
  await sql.end()
  if (failures > 0) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
