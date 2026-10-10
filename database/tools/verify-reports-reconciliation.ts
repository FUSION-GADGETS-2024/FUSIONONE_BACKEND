/**
 * FUSIONONE — Reports controlled TEST reconciliation (implementation spec
 * §§24–27).
 *
 * Verifies the mandatory chain against the LIVE TEST database (read-only;
 * safety abort unless the TEST project):
 *
 *   SQL truth (computed independently, straight from the tables)
 *     == report dataset truth (buildReportDatasets from the real code)
 *     == Excel workbook truth (cell values in the generated workbooks)
 *
 * and writes the REAL generated workbooks (individual reports + the
 * consolidated Report Pack for FY 2026-27 and the pack for FY 2027-28) to
 * download/ for visual inspection. SELECT-only: no writes, no mutations.
 */
import postgres from 'postgres'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import ExcelJS from 'exceljs'

import { isVirtualAcquisition } from '../../src/features/analytics/metrics'
import { buildReportDatasets } from '../../src/features/reports/data'
import { buildReportWorkbook, buildReportPackWorkbook } from '../../src/features/reports/excel/workbook'
import { REPORT_PACK_IDS } from '../../src/features/reports/catalogue'
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

/** postgres.js delivers DATE/timestamptz as Date objects; the app fold uses ISO strings. */
function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString()
  return String(value ?? '')
}

async function loadFold(fyId: string): Promise<AnalyticsFold> {
  const [salesRows, purchaseRows, saleItemRows, purchaseItemRows, payInRows, payOutRows, inventoryRows, tradeInRows, proformaRows, timelineRows, accounts, modes, parties] = await Promise.all([
    sql`SELECT s.id, s.bill_number, s.date, s.party_id, p.name AS party_name, s.total, s.discount, s.trade_in_credit, s.final_total, s.paid, s.due, s.status, s.created_at, s.proforma_id
        FROM public.sales s LEFT JOIN public.parties p ON p.id = s.party_id
        WHERE s.financial_year_id = ${fyId} ORDER BY s.date, s.bill_number`,
    sql`SELECT pu.id, pu.bill_number, pu.date, pu.party_id, p.name AS party_name, pu.total, pu.paid, pu.due, pu.status, pu.created_at
        FROM public.purchases pu LEFT JOIN public.parties p ON p.id = pu.party_id
        WHERE pu.financial_year_id = ${fyId} ORDER BY pu.date, pu.bill_number`,
    sql`SELECT si.sale_id, si.sold_price, ii.id AS inv_id, ii.brand, ii.model, ii.imei, ii.ram_rom, ii.color, ii.base_selling_price, ii.purchase_price, ii.status AS inv_status, ii.source
        FROM public.sale_items si LEFT JOIN public.inventory_items ii ON ii.id = si.inventory_item_id`,
    sql`SELECT pi.purchase_id, ii.id AS inv_id, ii.brand, ii.model, ii.source
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
    sql`SELECT pf.id, pf.bill_number, pf.date, pf.status, pf.final_total, pf.party_id, p.name AS party_name
        FROM public.proforma_invoices pf LEFT JOIN public.parties p ON p.id = pf.party_id
        WHERE pf.financial_year_id = ${fyId} ORDER BY pf.date`,
    sql`SELECT id, created_at, origin_inventory_item_id FROM public.inventory_items ORDER BY created_at`,
    sql`SELECT id, name, is_cash FROM public.bank_accounts ORDER BY name`,
    sql`SELECT id, name, bank_account_id FROM public.payment_modes ORDER BY name`,
    sql`SELECT id, name, number FROM public.parties ORDER BY name`,
  ])

  return {
    fyId,
    sales: salesRows.map((r: Record<string, unknown>) => ({
      id: r.id, bill_number: r.bill_number, date: iso(r.date).slice(0, 10), party_id: r.party_id, party_name: r.party_name as string | null,
      total: r.total, discount: r.discount, trade_in_credit: r.trade_in_credit, final_total: r.final_total,
      paid: r.paid, due: r.due, status: r.status, created_at: iso(r.created_at), proforma_id: (r.proforma_id as string | null) ?? null,
    })),
    purchases: purchaseRows.map((r: Record<string, unknown>) => {
      const items = purchaseItemRows
        .filter((pi: Record<string, unknown>) => pi.purchase_id === r.id)
        .map((pi: Record<string, unknown>) => ({
          purchase_id: pi.purchase_id,
          inventory_items: pi.inv_id ? { id: pi.inv_id, brand: pi.brand as string | null, model: pi.model as string | null, source: pi.source as string | null } : null,
        }))
      return {
        id: r.id, bill_number: r.bill_number, date: iso(r.date).slice(0, 10), party_id: r.party_id, party_name: r.party_name as string | null,
        total: r.total, paid: r.paid, due: r.due, status: r.status, created_at: iso(r.created_at),
        is_virtual: isVirtualAcquisition(r.bill_number as string, items),
      }
    }),
    saleItems: saleItemRows.map((r: Record<string, unknown>) => ({
      sale_id: r.sale_id, sold_price: r.sold_price,
      inventory_items: r.inv_id ? {
        id: r.inv_id, brand: r.brand as string | null, model: r.model as string | null, imei: r.imei as string | null,
        ram_rom: r.ram_rom as string | null, color: r.color as string | null, base_selling_price: r.base_selling_price as number | string | null,
        purchase_price: r.purchase_price as number | string | null, status: r.inv_status as string | null, source: r.source as string | null,
      } : null,
    })),
    purchaseItems: purchaseItemRows.map((r: Record<string, unknown>) => ({
      purchase_id: r.purchase_id,
      inventory_items: r.inv_id ? { id: r.inv_id, brand: r.brand as string | null, model: r.model as string | null, source: r.source as string | null } : null,
    })),
    paymentsIn: payInRows.map((r: Record<string, unknown>) => ({ ...r, date: iso(r.date).slice(0, 10), created_at: iso(r.created_at) })),
    paymentsOut: payOutRows.map((r: Record<string, unknown>) => ({ ...r, date: iso(r.date).slice(0, 10), created_at: iso(r.created_at) })),
    inventory: (inventoryRows as Array<Record<string, unknown>>).map((r) => ({ ...r, created_at: iso(r.created_at) })) as unknown as AnalyticsFold['inventory'],
    tradeIns: tradeInRows.map((r: Record<string, unknown>) => ({
      id: r.id, sale_id: r.sale_id, inventory_item_id: r.inventory_item_id, credit_value: r.credit_value, mrp: r.mrp,
      inventory_items: {
        brand: r.brand as string | null, model: r.model as string | null, imei: r.imei as string | null,
        status: r.inv_status as string | null, source: r.source as string | null,
      },
    })),
    proformas: (proformaRows as Array<Record<string, unknown>>).map((r) => ({ ...r, date: iso(r.date).slice(0, 10), created_at: iso(r.created_at) })) as unknown as AnalyticsFold['proformas'],
    timeline: (timelineRows as Array<Record<string, unknown>>).map((r) => ({ ...r, created_at: iso(r.created_at) })) as unknown as AnalyticsFold['timeline'],
    bankAccounts: accounts as unknown as AnalyticsFold['bankAccounts'],
    paymentModes: modes as unknown as AnalyticsFold['paymentModes'],
    parties: parties as unknown as AnalyticsFold['parties'],
  }
}

// ── Excel cell access helpers ────────────────────────────────────────────────

async function sheetOf(bytes: Uint8Array, sheetName: string): Promise<ExcelJS.Worksheet> {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(bytes as unknown as ArrayBuffer)
  const ws = wb.getWorksheet(sheetName)
  if (!ws) throw new Error(`sheet ${sheetName} missing`)
  return ws
}

/** Reads a table's data rows (below the header matching firstHeader) as objects. */
function readTable(ws: ExcelJS.Worksheet, firstHeader: string): { headerRow: number; headers: string[]; rows: Array<Record<string, unknown>> } {
  let headerRow = -1
  for (let r = 1; r <= 80; r++) {
    if (ws.getCell(r, 1).value === firstHeader) { headerRow = r; break }
  }
  if (headerRow < 0) throw new Error(`header ${firstHeader} not found`)
  const headers: string[] = []
  for (let c = 1; c <= 20; c++) {
    const v = ws.getCell(headerRow, c).value
    if (v === null || v === undefined) break
    headers.push(String(v))
  }
  const rows: Array<Record<string, unknown>> = []
  for (let r = headerRow + 1; r <= headerRow + 2000; r++) {
    const first = ws.getCell(r, 1).value
    if (first === null || first === undefined) break // end of table
    if (typeof first === 'string' && first.startsWith('No records')) break // empty state
    if (typeof first === 'string' && /^Total(\s|$)/.test(first)) break // totals row
    if (ws.getCell(r, 1).font?.italic) break // notes row
    const row: Record<string, unknown> = {}
    let any = false
    headers.forEach((h, i) => {
      const v = ws.getCell(r, i + 1).value
      row[h] = v instanceof Date ? v.toISOString().slice(0, 10) : v
      if (v !== null && v !== undefined) any = true
    })
    if (!any) break
    rows.push(row)
  }
  return { headerRow, headers, rows }
}

// ── Per-FY verification ──────────────────────────────────────────────────────

const OUT = join(HERE, '..', '..', 'download')
mkdirSync(OUT, { recursive: true })

async function verifyFy(fyId: string, fySlug: string, fyStart: string, fyEnd: string): Promise<void> {
  console.log(`\n=== FY ${fySlug} (period ${fyStart}..${fyEnd}, today ${TODAY}) ===`)
  const fold = await loadFold(fyId)
  const period = { preset: 'custom' as const, from: fyStart, to: fyEnd }

  // ── 1. SQL truth (independent) ────────────────────────────────────────────
  const truthRows = await sql`
    SELECT
      (SELECT COUNT(*)::int FROM public.sales WHERE financial_year_id = ${fyId} AND status='active') AS invoice_count,
      (SELECT COALESCE(SUM(final_total),0) FROM public.sales WHERE financial_year_id = ${fyId} AND status='active') AS net_sales,
      (SELECT COALESCE(SUM(paid),0) FROM public.sales WHERE financial_year_id = ${fyId} AND status='active') AS received,
      (SELECT COALESCE(SUM(due),0) FROM public.sales WHERE financial_year_id = ${fyId} AND status='active') AS receivables,
      (SELECT COUNT(*)::int FROM public.purchases pu WHERE pu.financial_year_id = ${fyId} AND pu.status='active'
         AND NOT (pu.bill_number LIKE 'PUR-TRD-%')
         AND NOT EXISTS (SELECT 1 FROM public.purchase_items pi JOIN public.inventory_items ii ON ii.id = pi.inventory_item_id
                          WHERE pi.purchase_id = pu.id AND ii.source = 'trade_in'
                          HAVING COUNT(*) = (SELECT COUNT(*) FROM public.purchase_items pi2 WHERE pi2.purchase_id = pu.id))) AS bill_count,
      (SELECT COALESCE(SUM(pu.total),0) FROM public.purchases pu WHERE pu.financial_year_id = ${fyId} AND pu.status='active'
         AND NOT (pu.bill_number LIKE 'PUR-TRD-%')
         AND NOT EXISTS (SELECT 1 FROM public.purchase_items pi JOIN public.inventory_items ii ON ii.id = pi.inventory_item_id
                          WHERE pi.purchase_id = pu.id AND ii.source = 'trade_in'
                          HAVING COUNT(*) = (SELECT COUNT(*) FROM public.purchase_items pi2 WHERE pi2.purchase_id = pu.id))) AS total_purchases,
      (SELECT COALESCE(SUM(pu.due),0) FROM public.purchases pu WHERE pu.financial_year_id = ${fyId} AND pu.status='active'
         AND NOT (pu.bill_number LIKE 'PUR-TRD-%')
         AND NOT EXISTS (SELECT 1 FROM public.purchase_items pi JOIN public.inventory_items ii ON ii.id = pi.inventory_item_id
                          WHERE pi.purchase_id = pu.id AND ii.source = 'trade_in'
                          HAVING COUNT(*) = (SELECT COUNT(*) FROM public.purchase_items pi2 WHERE pi2.purchase_id = pu.id))) AS payables,
      (SELECT COALESCE(SUM(amount),0) FROM public.payments_in WHERE financial_year_id = ${fyId}) AS money_in,
      (SELECT COALESCE(SUM(amount),0) FROM public.payments_out WHERE financial_year_id = ${fyId}) AS money_out,
      (SELECT COUNT(*)::int FROM public.inventory_items WHERE financial_year_id = ${fyId} AND status='in_stock') AS stock_records,
      (SELECT COALESCE(SUM(purchase_price),0) FROM public.inventory_items WHERE financial_year_id = ${fyId} AND status='in_stock') AS stock_cost,
      (SELECT COALESCE(SUM(base_selling_price),0) FROM public.inventory_items WHERE financial_year_id = ${fyId} AND status='in_stock') AS stock_selling,
      (SELECT COUNT(*)::int FROM public.trade_ins ti JOIN public.sales s ON s.id = ti.sale_id WHERE s.financial_year_id = ${fyId} AND s.status='active') AS tradeins,
      (SELECT COALESCE(SUM(ti.credit_value),0) FROM public.trade_ins ti JOIN public.sales s ON s.id = ti.sale_id WHERE s.financial_year_id = ${fyId} AND s.status='active') AS tradein_value,
      (SELECT COUNT(*)::int FROM public.proforma_invoices WHERE financial_year_id = ${fyId}) AS proformas
  `
  const truth = truthRows[0] as Record<string, number>
  console.log('SQL truth:', JSON.stringify(truth))

  // The multi-item invoice's joined item name, straight from the tables.
  const multiItem = await sql`
    SELECT s.bill_number, string_agg(ii.brand || ' ' || ii.model, ', ' ORDER BY ii.brand) AS names
    FROM public.sales s
    JOIN public.sale_items si ON si.sale_id = s.id
    JOIN public.inventory_items ii ON ii.id = si.inventory_item_id
    WHERE s.financial_year_id = ${fyId} AND s.status = 'active'
    GROUP BY s.bill_number HAVING COUNT(*) > 1 LIMIT 1`

  // ── 2. Report datasets (the real code) ────────────────────────────────────
  const storeRow = await sql`SELECT name, address, phone FROM public.store LIMIT 1`
  const store = (storeRow[0] ?? {}) as { name?: string; address?: string; phone?: string }
  const bundle = buildReportDatasets({
    fold,
    period,
    store,
    fy: { start_date: fyStart, end_date: fyEnd },
    today: TODAY,
    generatedAt: GENERATED_AT,
  })

  const salesTable = bundle.reports['sales-register'].blocks[0]
  if (salesTable.kind !== 'table') throw new Error('sales register shape')
  const salesRows = salesTable.rows as Array<{ total: number; received: number; balance: number; itemName: string; billNumber: string }>
  const purchaseTable = bundle.reports['purchase-register'].blocks[0]
  if (purchaseTable.kind !== 'table') throw new Error('purchase register shape')
  const purchaseRows = purchaseTable.rows as Array<{ total: number; paid: number; balance: number }>
  const paymentsTable = bundle.reports['payments-register'].blocks[0]
  if (paymentsTable.kind !== 'table') throw new Error('payments register shape')
  const paymentRows = paymentsTable.rows as Array<{ amount: number; direction: string }>
  const outstandingTable = bundle.reports['customer-outstanding'].blocks[0]
  if (outstandingTable.kind !== 'table') throw new Error('outstanding shape')
  const outstandingRows = outstandingTable.rows as Array<{ outstanding: number }>
  const ageingTable = bundle.reports['receivables-ageing'].blocks[0]
  if (ageingTable.kind !== 'table') throw new Error('ageing shape')
  const ageingRows = ageingTable.rows as Array<{ bucket: string; invoices: number; outstanding: number }>
  const invTable = bundle.reports['inventory-register'].blocks[0]
  if (invTable.kind !== 'table') throw new Error('inventory shape')
  const invRows = invTable.rows as Array<{ cost: number; selling: number }>
  const tradeInTable = bundle.reports['trade-in-register'].blocks[0]
  if (tradeInTable.kind !== 'table') throw new Error('trade-in shape')
  const tradeInRows = tradeInTable.rows as Array<{ creditValue: number }>
  const proformaTable = bundle.reports['proforma-register'].blocks[0]
  if (proformaTable.kind !== 'table') throw new Error('proforma shape')
  const proformaRows = proformaTable.rows as Array<{ total: number }>

  console.log('\n-- SQL truth == report data --')
  check('sales register invoice count', salesRows.length, truth.invoice_count)
  check('sales register net sales', salesRows.reduce((a, r) => a + r.total, 0), Number(truth.net_sales))
  check('sales register received', salesRows.reduce((a, r) => a + r.received, 0), Number(truth.received))
  check('sales register balance', salesRows.reduce((a, r) => a + r.balance, 0), Number(truth.receivables))
  if (multiItem.length > 0) {
    const inReport = salesRows.find((r) => r.billNumber === multiItem[0].bill_number)
    const norm = (s: unknown) => String(s ?? '').split(', ').sort().join(', ')
    check('multi-item invoice joined item names', norm(inReport?.itemName), norm(multiItem[0].names))
  }
  check('purchase register bill count', purchaseRows.length, truth.bill_count)
  check('purchase register total', purchaseRows.reduce((a, r) => a + r.total, 0), Number(truth.total_purchases))
  check('purchase register paid', purchaseRows.reduce((a, r) => a + r.paid, 0), Number(truth.total_purchases) - Number(truth.payables))
  check('purchase register balance', purchaseRows.reduce((a, r) => a + r.balance, 0), Number(truth.payables))
  check('payments register money in', paymentRows.filter((r) => r.direction === 'In').reduce((a, r) => a + r.amount, 0), Number(truth.money_in))
  check('payments register money out', paymentRows.filter((r) => r.direction === 'Out').reduce((a, r) => a + r.amount, 0), Number(truth.money_out))
  check('customer outstanding total', outstandingRows.reduce((a, r) => a + r.outstanding, 0), Number(truth.receivables))
  check('receivables ageing total', ageingRows.reduce((a, r) => a + r.outstanding, 0), Number(truth.receivables))
  check('inventory register records', invRows.length, truth.stock_records)
  check('inventory register cost', invRows.reduce((a, r) => a + r.cost, 0), Number(truth.stock_cost))
  check('inventory register selling', invRows.reduce((a, r) => a + r.selling, 0), Number(truth.stock_selling))
  check('trade-in register count', tradeInRows.length, truth.tradeins)
  check('trade-in register credit', tradeInRows.reduce((a, r) => a + r.creditValue, 0), Number(truth.tradein_value))
  check('proforma register count', proformaRows.length, truth.proformas)

  // Ageing buckets against an independent SQL computation (same boundaries).
  const bucketsSql = await sql`
    SELECT CASE WHEN (${TODAY}::date - s.date) <= 30 THEN '0–30 days'
                WHEN (${TODAY}::date - s.date) <= 60 THEN '31–60 days'
                WHEN (${TODAY}::date - s.date) <= 90 THEN '61–90 days'
                ELSE '90+ days' END AS bucket,
           COUNT(*)::int AS invoices, COALESCE(SUM(s.due),0) AS outstanding
    FROM public.sales s
    WHERE s.financial_year_id = ${fyId} AND s.status = 'active' AND s.due > 0
    GROUP BY 1`
  const bucketMap = new Map(bucketsSql.map((b: { bucket: string; invoices: number; outstanding: string }) => [b.bucket, { n: b.invoices, v: Number(b.outstanding) }]))
  for (const row of ageingRows) {
    const expected = bucketMap.get(row.bucket) ?? { n: 0, v: 0 }
    check(`ageing bucket ${row.bucket} invoices`, row.invoices, expected.n)
    check(`ageing bucket ${row.bucket} outstanding`, row.outstanding, expected.v)
  }

  // ── 3. Excel workbooks (the real renderer) ────────────────────────────────
  console.log('\n-- report data == Excel cells --')
  const salesBytes = await buildReportWorkbook(bundle.meta, bundle.reports['sales-register'])
  const salesWs = await sheetOf(salesBytes, 'Sales Register')
  const excelSales = readTable(salesWs, 'Date')
  check('Excel sales register row count', excelSales.rows.length, truth.invoice_count)
  check('Excel sales register net sales', excelSales.rows.reduce((a, r) => a + Number(r['Total Amount'] ?? 0), 0), Number(truth.net_sales))
  check('Excel sales register received', excelSales.rows.reduce((a, r) => a + Number(r['Received'] ?? 0), 0), Number(truth.received))
  check('Excel sales register balance', excelSales.rows.reduce((a, r) => a + Number(r['Balance'] ?? 0), 0), Number(truth.receivables))
  check('Excel store masthead', String(salesWs.getCell(1, 1).value), (store.name ?? '').toUpperCase())
  const headerRow = excelSales.headerRow
  check('Excel Item Name column follows Invoice No.', String(salesWs.getCell(headerRow, 3).value), 'Item Name')
  if (multiItem.length > 0) {
    const excelMulti = excelSales.rows.find((r) => r['Invoice No.'] === multiItem[0].bill_number)
    const norm = (s: unknown) => String(s ?? '').split(', ').sort().join(', ')
    check('Excel multi-item joined names', norm(excelMulti?.['Item Name']), norm(multiItem[0].names))
  }

  const outstandingBytes = await buildReportWorkbook(bundle.meta, bundle.reports['customer-outstanding'])
  const outstandingWs = await sheetOf(outstandingBytes, 'Customer Outstanding')
  const excelOutstanding = readTable(outstandingWs, 'Customer')
  check('Excel customer outstanding total', excelOutstanding.rows.reduce((a, r) => a + Number(r['Outstanding'] ?? 0), 0), Number(truth.receivables))

  const valuationBytes = await buildReportWorkbook(bundle.meta, bundle.reports['inventory-valuation'])
  const valuationWs = await sheetOf(valuationBytes, 'Inventory Valuation')
  // Summary values live under their labels in column A/B.
  let excelCost: number | null = null
  for (let r = 1; r <= 30; r++) {
    if (valuationWs.getCell(r, 1).value === 'Cost Value') excelCost = Number(valuationWs.getCell(r, 4).value)
  }
  check('Excel inventory cost value', excelCost, Number(truth.stock_cost))

  // ── 4. The consolidated Report Pack ───────────────────────────────────────
  const packBytes = await buildReportPackWorkbook(
    bundle.meta,
    REPORT_PACK_IDS.map((id) => bundle.reports[id]),
    bundle.index,
  )
  const packWb = new ExcelJS.Workbook()
  await packWb.xlsx.load(packBytes as unknown as ArrayBuffer)
  check('pack sheet count', packWb.worksheets.length, 1 + REPORT_PACK_IDS.length)
  check('pack first sheet', packWb.worksheets[0].name, 'Report Index')
  const packSales = await sheetOf(packBytes, 'Sales Register')
  const packSalesTable = readTable(packSales, 'Date')
  check('pack sales register reconciles', packSalesTable.rows.reduce((a, r) => a + Number(r['Total Amount'] ?? 0), 0), Number(truth.net_sales))

  // ── 5. Persist the REAL workbooks for visual inspection ───────────────────
  const fyFile = fySlug.replace(' ', '-')
  writeFileSync(join(OUT, `Fusion-Gadgets-E2E-Sales-Register-${fyFile}.xlsx`), salesBytes)
  writeFileSync(join(OUT, `Fusion-Gadgets-E2E-Purchase-Register-${fyFile}.xlsx`), await buildReportWorkbook(bundle.meta, bundle.reports['purchase-register']))
  writeFileSync(join(OUT, `Fusion-Gadgets-E2E-Payments-Register-${fyFile}.xlsx`), await buildReportWorkbook(bundle.meta, bundle.reports['payments-register']))
  writeFileSync(join(OUT, `Fusion-Gadgets-E2E-Customer-Outstanding-${fyFile}.xlsx`), outstandingBytes)
  writeFileSync(join(OUT, `Fusion-Gadgets-E2E-Receivables-Ageing-${fyFile}.xlsx`), await buildReportWorkbook(bundle.meta, bundle.reports['receivables-ageing']))
  writeFileSync(join(OUT, `Fusion-Gadgets-E2E-Inventory-Register-${fyFile}.xlsx`), await buildReportWorkbook(bundle.meta, bundle.reports['inventory-register']))
  writeFileSync(join(OUT, `Fusion-Gadgets-E2E-Inventory-Valuation-${fyFile}.xlsx`), valuationBytes)
  writeFileSync(join(OUT, `Fusion-Gadgets-E2E-Trade-In-Register-${fyFile}.xlsx`), await buildReportWorkbook(bundle.meta, bundle.reports['trade-in-register']))
  writeFileSync(join(OUT, `Fusion-Gadgets-E2E-Proforma-Register-${fyFile}.xlsx`), await buildReportWorkbook(bundle.meta, bundle.reports['proforma-register']))
  writeFileSync(join(OUT, `Fusion-Gadgets-E2E-Complete-Report-Pack-${fyFile}.xlsx`), packBytes)
}

// ── Run ──────────────────────────────────────────────────────────────────────

await verifyFy('c2ff174d-2801-42a1-a83e-5f3737911a51', 'FY 2026-27', '2026-04-01', '2027-03-31')
await verifyFy('878833cd-3794-4c68-bf10-acd4222f5d8e', 'FY 2027-28', '2027-04-01', '2028-03-31')

// A September-only window exercises Financial Year boundary period filtering.
console.log('\n=== Period window: FY 2026-27, September 2026 only ===')
{
  const fold = await loadFold('c2ff174d-2801-42a1-a83e-5f3737911a51')
  const storeRow = await sql`SELECT name, address, phone FROM public.store LIMIT 1`
  const store = (storeRow[0] ?? {}) as { name?: string; address?: string; phone?: string }
  const bundle = buildReportDatasets({
    fold,
    period: { preset: 'custom', from: '2026-09-01', to: '2026-09-30' },
    store,
    fy: { start_date: '2026-04-01', end_date: '2027-03-31' },
    today: TODAY,
    generatedAt: GENERATED_AT,
  })
  const sept = await sql`
    SELECT COUNT(*)::int AS n, COALESCE(SUM(final_total),0) AS total FROM public.sales
    WHERE financial_year_id = 'c2ff174d-2801-42a1-a83e-5f3737911a51' AND status='active'
      AND date BETWEEN '2026-09-01'::date AND '2026-09-30'::date`
  const salesTable = bundle.reports['sales-register'].blocks[0]
  if (salesTable.kind !== 'table') throw new Error('sales register shape')
  const rows = salesTable.rows as Array<{ total: number }>
  check('September sales count', rows.length, sept[0].n)
  check('September sales total', rows.reduce((a, r) => a + r.total, 0), Number(sept[0].total))
}

console.log(`\n${checks - failures}/${checks} checks OK`)
if (failures > 0) {
  console.error(`${failures} CHECK(S) FAILED`)
  process.exit(1)
}
await sql.end()
console.log('DONE (read-only; real workbooks written to download/)')
