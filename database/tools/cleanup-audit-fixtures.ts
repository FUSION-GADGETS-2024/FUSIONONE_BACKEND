/**
 * FUSIONONE — Post-audit fixture cleanup (TEST only).
 *
 * Removes ONLY the artifacts this audit created for verification:
 *   1. The "AUDIT Zero-Mode Bank" account (zero payment modes, zero
 *      transactions — created to reproduce the empty-mode UI state).
 *   2. The throwaway FY 2028 + FY 2029 (created/closed to verify the FY
 *      close modal end-to-end; zero business rows reference them).
 *   3. The verification sale SAL-2027-28-0001 (paid 0, no payments, no
 *      accounting rows; its inventory item returns to in_stock).
 *
 * Verifies the final state matches the pre-audit E2E baseline exactly.
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

// ── 1. AUDIT Zero-Mode Bank account ──
const auditBank = await sql`SELECT id FROM public.bank_accounts WHERE name = 'AUDIT Zero-Mode Bank'`
if (auditBank.length > 0) {
  const bankId = auditBank[0].id
  const refs = await sql`
    SELECT
      (SELECT count(*)::int FROM public.payment_modes WHERE bank_account_id = ${bankId}) AS modes,
      (SELECT count(*)::int FROM public.account_transactions WHERE bank_account_id = ${bankId}) AS txs,
      (SELECT count(*)::int FROM public.payments_in WHERE bank_account_id = ${bankId}) AS pin,
      (SELECT count(*)::int FROM public.payments_out WHERE bank_account_id = ${bankId}) AS pout`
  const r = refs[0]
  console.log(`AUDIT account references: modes=${r.modes} txs=${r.txs} payments_in=${r.pin} payments_out=${r.pout}`)
  if (r.modes === 0 && r.txs === 0 && r.pin === 0 && r.pout === 0) {
    await sql`DELETE FROM public.bank_accounts WHERE id = ${bankId}`
    console.log('✓ removed AUDIT Zero-Mode Bank (zero references)')
  } else {
    throw new Error('AUDIT account has references — refusing to delete')
  }
} else {
  console.log('AUDIT account already gone')
}

// ── 2. Throwaway FY 2028 + FY 2029 ──
for (const [start, end] of [['2028-04-01', '2029-03-31'], ['2029-04-01', '2030-03-31']] as const) {
  const fy = await sql`SELECT id, status FROM public.financial_years WHERE start_date = ${start} AND end_date = ${end}`
  if (fy.length === 0) { console.log(`FY ${start} already gone`); continue }
  const fyId = fy[0].id
  const refs = await sql`
    SELECT
      (SELECT count(*)::int FROM public.inventory_items WHERE financial_year_id = ${fyId}) AS inv,
      (SELECT count(*)::int FROM public.sales WHERE financial_year_id = ${fyId}) AS sales,
      (SELECT count(*)::int FROM public.purchases WHERE financial_year_id = ${fyId}) AS purch,
      (SELECT count(*)::int FROM public.account_transactions WHERE financial_year_id = ${fyId}) AS txs,
      (SELECT count(*)::int FROM public.proforma_invoices WHERE financial_year_id = ${fyId}) AS pf`
  const r = refs[0]
  console.log(`FY ${start} references: inv=${r.inv} sales=${r.sales} purch=${r.purch} txs=${r.txs} proformas=${r.pf}`)
  if (r.inv === 0 && r.sales === 0 && r.purch === 0 && r.txs === 0 && r.pf === 0) {
    await sql`DELETE FROM public.financial_years WHERE id = ${fyId}`
    console.log(`✓ removed throwaway FY ${start} (zero references)`)
  } else {
    throw new Error(`FY ${start} has business rows — refusing to delete`)
  }
}

// ── 3. Verification sale SAL-2027-28-0001 ──
const sale = await sql`SELECT id FROM public.sales WHERE bill_number = 'SAL-2027-28-0001'`
if (sale.length > 0) {
  const saleId = sale[0].id
  const pin = (await sql`SELECT count(*)::int AS n FROM public.payments_in WHERE sale_id = ${saleId}`)[0].n
  const ti = (await sql`SELECT count(*)::int AS n FROM public.trade_ins WHERE sale_id = ${saleId}`)[0].n
  if (pin !== 0 || ti !== 0) throw new Error('Verification sale has payments/trade-ins — refusing')
  // Return the sold device to stock, then remove the sale graph.
  await sql`UPDATE public.inventory_items SET status = 'in_stock'
             WHERE id IN (SELECT inventory_item_id FROM public.sale_items WHERE sale_id = ${saleId})`
  await sql`DELETE FROM public.sale_items WHERE sale_id = ${saleId}`
  await sql`DELETE FROM public.sales WHERE id = ${saleId}`
  console.log('✓ removed verification sale SAL-2027-28-0001 (device back in stock)')
} else {
  console.log('Verification sale already gone')
}

// ── Final baseline verification ──
console.log('\n=== FINAL STATE (must match the pre-audit E2E baseline) ===')
const counts = await sql`
  SELECT
    (SELECT count(*)::int FROM public.sales) AS sales,
    (SELECT count(*)::int FROM public.purchases) AS purch,
    (SELECT count(*)::int FROM public.inventory_items WHERE status='in_stock') AS in_stock,
    (SELECT count(*)::int FROM public.inventory_items WHERE status='sold') AS sold,
    (SELECT count(*)::int FROM public.financial_years) AS fys,
    (SELECT count(*)::int FROM public.bank_accounts) AS accounts,
    (SELECT count(*)::int FROM public.payment_modes) AS modes,
    (SELECT count(*)::int FROM public.payments_in) AS pin,
    (SELECT count(*)::int FROM public.payments_out) AS pout,
    (SELECT count(*)::int FROM public.message_jobs) AS jobs`
const c = counts[0]
const expected = { sales: 8, purch: 6, in_stock: 8, sold: 6, fys: 2, accounts: 2, modes: 3, pin: 9, pout: 3, jobs: 0 }
// in_stock 8 = 4 old-FY (frozen history) + 4 carried into FY 2027 — the pre-audit baseline.
console.log('actual  :', JSON.stringify(c))
console.log('expected:', JSON.stringify(expected))
const fyList = await sql`SELECT start_date, end_date, status FROM public.financial_years ORDER BY start_date`
for (const f of fyList) console.log(`  FY ${String(f.start_date).slice(0, 10)} → ${String(f.end_date).slice(0, 10)} [${f.status}]`)
const store = await sql`SELECT active_financial_year_id FROM public.store`
console.log('store default FY = FY 2027:', store[0].active_financial_year_id === (await sql`SELECT id FROM public.financial_years WHERE start_date='2027-04-01'`)[0].id)

const match = Object.entries(expected).every(([k, v]) => (c as any)[k] === v)
console.log(match ? '\n✓ BASELINE RESTORED EXACTLY' : '\n✗ STATE MISMATCH')
await sql.end()
process.exit(match ? 0 : 1)
