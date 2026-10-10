/**
 * FUSIONONE — Analytics pre-implementation audit (READ-ONLY).
 *
 * Inspects the LIVE TEST database only (safety abort otherwise):
 *   - public table inventory + business row counts (the analytics baseline)
 *   - financial years + active FY resolution + store pointer
 *   - column-level verification for every column the Analytics fold will
 *     read (business dates, statuses, sources, counters)
 *   - data-shape probes: hidden PUR-TRD bills, cancelled documents,
 *     trade-in inventory sources, payments linkage, proforma statuses,
 *     message_jobs snapshot (notice-relevant state)
 *
 * SELECT-only: no writes, no deletes, no migrations.
 */
import postgres from 'postgres'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

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

// ── 1. Business baseline ────────────────────────────────────────────────────
const counts = await sql`
  SELECT
    (SELECT count(*)::int FROM public.sales) AS sales,
    (SELECT count(*)::int FROM public.sales WHERE status='active') AS sales_active,
    (SELECT count(*)::int FROM public.sales WHERE status='cancelled') AS sales_cancelled,
    (SELECT count(*)::int FROM public.purchases) AS purchases,
    (SELECT count(*)::int FROM public.purchases WHERE bill_number LIKE 'PUR-TRD-%') AS purchases_tradein_hidden,
    (SELECT count(*)::int FROM public.sale_items) AS sale_items,
    (SELECT count(*)::int FROM public.purchase_items) AS purchase_items,
    (SELECT count(*)::int FROM public.inventory_items) AS inventory,
    (SELECT count(*)::int FROM public.inventory_items WHERE status='in_stock') AS inventory_in_stock,
    (SELECT count(*)::int FROM public.inventory_items WHERE source='trade_in') AS inventory_trade_in,
    (SELECT count(*)::int FROM public.trade_ins) AS trade_ins,
    (SELECT count(*)::int FROM public.payments_in) AS payments_in,
    (SELECT count(*)::int FROM public.payments_out) AS payments_out,
    (SELECT count(*)::int FROM public.proforma_invoices) AS proformas,
    (SELECT count(*)::int FROM public.parties) AS parties,
    (SELECT count(*)::int FROM public.bank_accounts) AS bank_accounts,
    (SELECT count(*)::int FROM public.payment_modes) AS payment_modes,
    (SELECT count(*)::int FROM public.account_transactions) AS account_transactions,
    (SELECT count(*)::int FROM public.message_jobs) AS message_jobs,
    (SELECT count(*)::int FROM public.reminder_settings) AS reminder_settings
`
console.log('BUSINESS BASELINE:', JSON.stringify(counts[0], null, 2))

// ── 2. Financial years + store ──────────────────────────────────────────────
const fys = await sql`
  SELECT id, start_date, end_date, status, sale_counter, purchase_counter, proforma_counter
    FROM public.financial_years ORDER BY start_date`
console.log('FINANCIAL YEARS:')
for (const fy of fys) console.log('  ', JSON.stringify(fy))
const store = await sql`
  SELECT name, active_financial_year_id, onboarding_complete, address, phone, email, website, gstin
    FROM public.store`
console.log('STORE:', JSON.stringify(store[0]))

// ── 3. Column verification for analytics reads ─────────────────────────────
const probes: Array<[string, string]> = [
  ['sales', `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='sales' ORDER BY ordinal_position`],
  ['purchases', `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='purchases' ORDER BY ordinal_position`],
  ['inventory_items', `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='inventory_items' AND column_name NOT IN ('brand_n','model_n','tokens_n','search_n') ORDER BY ordinal_position`],
  ['message_jobs', `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='message_jobs' ORDER BY ordinal_position`],
]
for (const [label, q] of probes) {
  const cols = await sql.unsafe(q)
  console.log(`COLUMNS ${label}:`, cols.map((c: any) => `${c.column_name}:${c.data_type}`).join(', '))
}

// ── 4. FY-scoped business snapshot for the ACTIVE store FY ──────────────────
const activeFy = fys.find((f) => f.status === 'active')
if (activeFy) {
  const fyId = activeFy.id
  const sales = await sql`
    SELECT bill_number, date, total, discount, trade_in_credit, final_total, paid, due, status, party_id, created_at
      FROM public.sales WHERE financial_year_id = ${fyId} ORDER BY date, bill_number`
  console.log(`ACTIVE FY (${activeFy.start_date}..${activeFy.end_date}) SALES (${sales.length}):`)
  for (const s of sales) console.log('  ', JSON.stringify(s))
  const purchases = await sql`
    SELECT bill_number, date, total, paid, due, status, party_id
      FROM public.purchases WHERE financial_year_id = ${fyId} ORDER BY date, bill_number`
  console.log(`ACTIVE FY PURCHASES (${purchases.length}):`)
  for (const p of purchases) console.log('  ', JSON.stringify(p))
  const inv = await sql`
    SELECT brand, model, imei, status, source, purchase_price, base_selling_price, created_at, opening_entry_type
      FROM public.inventory_items WHERE financial_year_id = ${fyId} ORDER BY created_at`
  console.log(`ACTIVE FY INVENTORY (${inv.length}):`)
  for (const i of inv) console.log('  ', JSON.stringify(i))
}

// ── 5. Notice-relevant state probes ──────────────────────────────────────────
const unpaidSales = await sql`
  SELECT bill_number, date, due, party_id FROM public.sales
   WHERE status='active' AND due > 0 ORDER BY date`
console.log(`ACTIVE SALES WITH DUE>0 (${unpaidSales.length}):`)
for (const s of unpaidSales) {
  const age = Math.floor((Date.now() - new Date(s.date).getTime()) / 86400000)
  console.log('  ', s.bill_number, 'due', s.due, 'date', s.date, `age ${age}d`)
}
const oldStock = await sql`
  SELECT brand, model, imei, source, purchase_price, created_at FROM public.inventory_items
   WHERE status='in_stock' ORDER BY created_at`
console.log(`IN-STOCK ITEMS (${oldStock.length}):`)
for (const i of oldStock) {
  const age = Math.floor((Date.now() - new Date(i.created_at).getTime()) / 86400000)
  console.log('  ', i.brand, i.model, i.source, `age ${age}d`, i.purchase_price)
}
const proformas = await sql`
  SELECT bill_number, date, status, final_total, created_at FROM public.proforma_invoices ORDER BY date`
console.log('PROFORMAS:')
for (const p of proformas) {
  const age = Math.floor((Date.now() - new Date(p.date).getTime()) / 86400000)
  console.log('  ', p.bill_number, p.status, `age ${age}d`, p.final_total)
}
const jobs = await sql`
  SELECT job_type, status, count(*)::int AS n FROM public.message_jobs GROUP BY job_type, status`
console.log('MESSAGE_JOBS:', JSON.stringify(jobs))
const partiesList = await sql`SELECT id, name, number FROM public.parties ORDER BY name`
console.log(`PARTIES (${partiesList.length}):`, partiesList.map((p) => `${p.name}`).join(', '))
const accounts = await sql`SELECT name, is_cash FROM public.bank_accounts ORDER BY name`
console.log('BANK ACCOUNTS:', JSON.stringify(accounts))
const modes = await sql`SELECT m.name, b.name AS bank FROM public.payment_modes m JOIN public.bank_accounts b ON b.id = m.bank_account_id ORDER BY m.name`
console.log('PAYMENT MODES:', JSON.stringify(modes))

// ── 6. Payment linkage + ledger reconciliation sample ───────────────────────
const pin = await sql`
  SELECT date, amount, sale_id, party_id, bank_account_id, payment_mode_id FROM public.payments_in ORDER BY date`
console.log(`PAYMENTS_IN (${pin.length}):`)
for (const p of pin) console.log('  ', JSON.stringify(p))
const pout = await sql`
  SELECT date, amount, purchase_id, party_id, bank_account_id, payment_mode_id FROM public.payments_out ORDER BY date`
console.log(`PAYMENTS_OUT (${pout.length}):`)
for (const p of pout) console.log('  ', JSON.stringify(p))

await sql.end()
console.log('AUDIT COMPLETE (read-only).')
