/**
 * FUSIONONE — Surgical TEST-data correction for the FY 2027-28 recovery
 * scenario seeded by seed-reports-fixtures.ts.
 *
 * The seed executed the REAL cancel_sale + create_trade_in_purchase_bill
 * RPCs while the sandbox clock (2026-10-09) sat OUTSIDE the sale's FY
 * 2027-28, producing exactly two rows whose date contradicts their
 * financial year (the RPCs pre-0019 derived dates from current_date):
 *
 *   1. purchases PUR-2027-28-0006 — the recovery bill — dated 2026-10-09.
 *   2. account_transactions — the sale_cancelled reversal debit (₹3,000) —
 *      dated 2026-10-09.
 *
 * The scenario's own chronology is: sale 2027-04-05 → trade-in device
 * resold 2027-04-10 → cancellation + recovery afterwards. This script
 * re-dates BOTH rows to the scenario-consistent date 2027-04-12 (inside
 * FY 2027-28, after the resale). No other column, row or relationship is
 * touched: the recovery bill has NO payments_out and NO ledger rows
 * (verified), the reversal references only its sale.
 *
 * Safety: TEST project only; verifies exactly two rows are affected;
 * idempotent (re-running detects the corrected dates); message_jobs stays 0.
 */
import postgres from 'postgres'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const raw = readFileSync(join(HERE, '.env'), 'utf8')
const env: Record<string, string> = Object.fromEntries(
  raw.split('\n').filter((l: string) => l.includes('=') && !l.startsWith('#')).map((l: string) => {
    const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
  }),
)
const DB_URL = env.TEST_SUPABASE_DB_URL
if (!DB_URL.includes('egdrnhtmclvhsfjvhyam')) throw new Error('SAFETY ABORT: not the TEST project.')
const sql = postgres(DB_URL, { ssl: { rejectUnauthorized: false }, max: 1, prepare: false })

const SCENARIO_DATE = '2027-04-12'
const FY2728 = '878833cd-3794-4c68-bf10-acd4222f5d8e'
const RECOVERY_BILL = 'PUR-2027-28-0006'
const OLD_DATE = '2026-10-09'

let ok = true
const fail = (m: string) => { ok = false; console.log('✗ ' + m) }
const pass = (m: string) => console.log('✓ ' + m)

// ── Pre-state ────────────────────────────────────────────────────────────────
const mjBefore = (await sql`SELECT count(*)::int AS n FROM public.message_jobs`)[0].n
const countsBefore = {
  purchases: (await sql`SELECT count(*)::int AS n FROM public.purchases`)[0].n,
  ledger: (await sql`SELECT count(*)::int AS n FROM public.account_transactions`)[0].n,
}

const recovery = await sql`
  SELECT id, date::text AS date, total::float8 AS total, paid::float8 AS paid, due::float8 AS due,
         status, financial_year_id
    FROM public.purchases WHERE bill_number = ${RECOVERY_BILL} AND financial_year_id = ${FY2728}`
if (recovery.length !== 1) fail(`expected exactly one ${RECOVERY_BILL} in FY 2027-28, found ${recovery.length}`)
else console.log(`recovery bill before: date=${recovery[0].date} total=${recovery[0].total} paid=${recovery[0].paid} due=${recovery[0].due} status=${recovery[0].status}`)

const reversal = await sql`
  SELECT id, date::text AS date, amount::float8 AS amount, reference_type
    FROM public.account_transactions
   WHERE reference_type = 'sale_cancelled' AND date::text = ${OLD_DATE} AND financial_year_id = ${FY2728}`
if (reversal.length !== 1) fail(`expected exactly one sale_cancelled reversal dated ${OLD_DATE} in FY 2027-28, found ${reversal.length}`)
else console.log(`reversal before: date=${reversal[0].date} amount=${reversal[0].amount}`)

// The recovery bill must have no dependent payments/ledger rows (re-dating
// cannot desynchronize any other record).
const dep1 = await sql`SELECT count(*)::int AS n FROM public.payments_out WHERE purchase_id = ${recovery[0]?.id ?? '00000000-0000-0000-0000-000000000000'}`
const dep2 = await sql`SELECT count(*)::int AS n FROM public.account_transactions WHERE reference_id = ${recovery[0]?.id ?? '00000000-0000-0000-0000-000000000000'}`
if (dep1[0].n === 0 && dep2[0].n === 0) pass('recovery bill has no payment/ledger dependants')
else fail(`recovery bill has dependants: payments_out=${dep1[0].n} ledger=${dep2[0].n}`)

// ── Correct (idempotent) ─────────────────────────────────────────────────────
if (ok) {
  if (recovery[0].date === SCENARIO_DATE && reversal[0].date === SCENARIO_DATE) {
    pass('already corrected — nothing to do')
  } else {
    await sql.begin(async (tx) => {
      await tx`UPDATE public.purchases SET date = ${SCENARIO_DATE}
                WHERE bill_number = ${RECOVERY_BILL} AND financial_year_id = ${FY2728} AND date::text = ${OLD_DATE}`
      await tx`UPDATE public.account_transactions SET date = ${SCENARIO_DATE}
                WHERE reference_type = 'sale_cancelled' AND date::text = ${OLD_DATE} AND financial_year_id = ${FY2728}`
    })
    pass(`re-dated the recovery bill + reversal to ${SCENARIO_DATE}`)
  }
}

// ── Post-state verification ──────────────────────────────────────────────────
const recAfter = await sql`SELECT date::text AS date FROM public.purchases WHERE bill_number = ${RECOVERY_BILL} AND financial_year_id = ${FY2728}`
const revAfter = await sql`SELECT date::text AS date FROM public.account_transactions WHERE reference_type = 'sale_cancelled' AND financial_year_id = ${FY2728}`
if (recAfter[0]?.date === SCENARIO_DATE) pass(`recovery bill date = ${SCENARIO_DATE}`)
else fail(`recovery bill date = ${recAfter[0]?.date}`)
if (revAfter[0]?.date === SCENARIO_DATE) pass(`reversal date = ${SCENARIO_DATE}`)
else fail(`reversal date = ${revAfter[0]?.date}`)

// Whole-database invariant: ZERO remaining date/FY mismatches in the dated
// business tables.
let mism = 0
for (const [table, refCol] of [['purchases', 'bill_number'], ['sales', 'bill_number'], ['payments_in', 'id'], ['payments_out', 'id'], ['account_transactions', 'id'], ['proforma_invoices', 'bill_number']] as const) {
  const bad = await sql.unsafe(`
    SELECT t.${refCol} AS ref FROM public.${table} t
     WHERE t.financial_year_id IS NOT NULL
       AND (t.date < (SELECT f.start_date FROM public.financial_years f WHERE f.id = t.financial_year_id)
         OR t.date > (SELECT f.end_date FROM public.financial_years f WHERE f.id = t.financial_year_id))`)
  if (bad.length === 0) pass(`${table}: every date lies inside its financial year`)
  else { mism += bad.length; fail(`${table}: ${bad.length} date/FY mismatches remain: ${bad.map((b: any) => b.ref).join(', ')}`) }
}

const countsAfter = {
  purchases: (await sql`SELECT count(*)::int AS n FROM public.purchases`)[0].n,
  ledger: (await sql`SELECT count(*)::int AS n FROM public.account_transactions`)[0].n,
}
if (countsAfter.purchases === countsBefore.purchases && countsAfter.ledger === countsBefore.ledger) pass('row counts unchanged (no rows added or removed)')
else fail('row counts changed')

const mjAfter = (await sql`SELECT count(*)::int AS n FROM public.message_jobs`)[0].n
if (mjAfter === mjBefore && mjAfter === 0) pass('message_jobs = 0 (no WhatsApp activity)')
else fail('message_jobs changed')

await sql.end()
console.log(ok ? 'ALL CHECKS PASSED' : 'CHECKS FAILED')
process.exit(ok ? 0 : 1)
