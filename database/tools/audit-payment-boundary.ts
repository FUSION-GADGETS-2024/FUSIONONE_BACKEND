/**
 * FUSIONONE — Payment RPC boundary verification (Item 1 re-audit).
 *
 * Tests the AUTHORITATIVE receive_payment / pay_purchase functions on the
 * LIVE TEST Supabase project for:
 *   - NULL amount        → rejected, zero side effects
 *   - 0 amount           → rejected, zero side effects
 *   - negative amount    → rejected, zero side effects
 *   - overpayment        → rejected (existing upper bound), zero side effects
 *   - valid positive     → succeeds with exactly the expected side effects
 *
 * Uses a dedicated, clearly-named fixture (party + sale + purchase) and
 * removes it completely afterwards, restoring the pre-test state.
 * Read-verify-then-write: nothing runs before the environment check.
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
if (!DB_URL.includes('egdrnhtmclvhsfjvhyam')) {
  throw new Error(`SAFETY ABORT: DB URL does not point at the TEST project. Refusing to run.`)
}
const sql = postgres(DB_URL, { ssl: { rejectUnauthorized: false }, max: 1, prepare: false })

let pass = 0
let fail = 0
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`) }
}

async function callRpc(fn: 'receive_payment' | 'pay_purchase', args: { id: string; amount: number | null; date: string; bank: string; mode: string | null }) {
  try {
    if (fn === 'receive_payment') {
      await sql`SELECT public.receive_payment(${args.id}::uuid, ${args.amount}::numeric, ${args.date}::date, ${args.bank}::uuid, ${args.mode}::uuid)`
    } else {
      await sql`SELECT public.pay_purchase(${args.id}::uuid, ${args.amount}::numeric, ${args.date}::date, ${args.bank}::uuid, ${args.mode}::uuid)`
    }
    return { ok: true, msg: '' }
  } catch (e: any) {
    return { ok: false, msg: String(e.message ?? e) }
  }
}

async function sideEffects(kind: 'in' | 'out', refId: string) {
  const payTable = kind === 'in' ? 'payments_in' : 'payments_out'
  const refType = kind === 'in' ? 'payment_in' : 'payment_out'
  const refCol = kind === 'in' ? 'sale_id' : 'purchase_id'
  const rows = await sql.unsafe(
    `SELECT count(*)::int AS n FROM public.${payTable} WHERE ${refCol} = $1`,
    [refId],
  )
  const txs = await sql.unsafe(
    `SELECT count(*)::int AS n FROM public.account_transactions
      WHERE reference_type = $1
        AND reference_id IN (SELECT id FROM public.${payTable} WHERE ${refCol} = $2)`,
    [refType, refId],
  )
  return { payments: rows[0].n, transactions: txs[0].n }
}

try {
  // ── Environment guard ──
  const proj = await sql`SELECT current_database() AS db, inet_server_addr()::text AS addr`
  console.log(`Connected to: ${proj[0].db} @ ${proj[0].addr}`)
  const mj0 = (await sql`SELECT count(*)::int AS n FROM public.message_jobs`)[0].n
  console.log(`Baseline message_jobs: ${mj0}`)

  // ── Fixture: dedicated test party + sale + purchase in the ACTIVE FY ──
  const fy = await sql`SELECT id FROM public.financial_years WHERE status = 'active' ORDER BY start_date LIMIT 1`
  const fyId = fy[0].id
  const bank = await sql`SELECT id FROM public.bank_accounts WHERE is_cash = false LIMIT 1`
  const bankId = bank[0].id
  const party = await sql`
    INSERT INTO public.parties (name, number) VALUES ('AUDIT-PAYMENT-BOUNDARY-FIXTURE', '+919999999999')
    RETURNING id`
  const partyId = party[0].id
  const sale = await sql.unsafe(`
    INSERT INTO public.sales (bill_number, party_id, total, discount, trade_in_credit, final_total, paid, due, bank_account_id, date, financial_year_id, status)
    VALUES ('AUDIT-FIXTURE-SALE', $1, 1000, 0, 0, 1000, 0, 1000, $2, current_date, $3, 'active')
    RETURNING id`, [partyId, bankId, fyId])
  const saleId = sale[0].id
  const purchase = await sql.unsafe(`
    INSERT INTO public.purchases (bill_number, party_id, total, paid, due, bank_account_id, date, financial_year_id, status)
    VALUES ('AUDIT-FIXTURE-PURCHASE', $1, 1000, 0, 1000, $2, current_date, $3, 'active')
    RETURNING id`, [partyId, bankId, fyId])
  const purchaseId = purchase[0].id
  const today = new Date().toISOString().slice(0, 10)

  // ══════════ receive_payment ══════════
  console.log('\n=== receive_payment — NULL / zero / negative / overpay / valid ===')

  for (const [label, amount] of [['NULL', null], ['zero', 0], ['negative', -50]] as const) {
    const r = await callRpc('receive_payment', { id: saleId, amount, date: today, bank: bankId, mode: null })
    const se = await sideEffects('in', saleId)
    const saleRow = await sql`SELECT paid, due FROM public.sales WHERE id = ${saleId}`
    check(`${label} amount rejected`,
      !r.ok && /greater than zero/i.test(r.msg), `got: ${r.ok ? 'ACCEPTED' : r.msg}`)
    check(`${label} amount → no payment row`, se.payments === 0, `payments=${se.payments}`)
    check(`${label} amount → no ledger row`, se.transactions === 0, `txs=${se.transactions}`)
    check(`${label} amount → sale untouched`,
      Number(saleRow[0].paid) === 0 && Number(saleRow[0].due) === 1000,
      `paid=${saleRow[0].paid} due=${saleRow[0].due}`)
  }

  { // overpayment
    const r = await callRpc('receive_payment', { id: saleId, amount: 1001, date: today, bank: bankId, mode: null })
    const se = await sideEffects('in', saleId)
    const saleRow = await sql`SELECT paid, due FROM public.sales WHERE id = ${saleId}`
    check('overpay rejected (upper bound intact)',
      !r.ok && /exceed due/i.test(r.msg), `got: ${r.ok ? 'ACCEPTED' : r.msg}`)
    check('overpay → no payment row', se.payments === 0)
    check('overpay → no ledger row', se.transactions === 0)
    check('overpay → sale untouched', Number(saleRow[0].paid) === 0 && Number(saleRow[0].due) === 1000)
  }

  { // valid positive
    const r = await callRpc('receive_payment', { id: saleId, amount: 500, date: today, bank: bankId, mode: null })
    check('valid positive accepted', r.ok, r.msg)
    const se = await sideEffects('in', saleId)
    const pay = await sql`SELECT amount, bank_account_id, payment_mode_id, date FROM public.payments_in WHERE sale_id = ${saleId}`
    const tx = await sql`SELECT type, amount, reference_type FROM public.account_transactions WHERE reference_type = 'payment_in' AND reference_id IN (SELECT id FROM public.payments_in WHERE sale_id = ${saleId})`
    const saleRow = await sql`SELECT paid, due FROM public.sales WHERE id = ${saleId}`
    check('valid → exactly one payment row', se.payments === 1 && Number(pay[0].amount) === 500, `n=${se.payments} amt=${pay[0]?.amount}`)
    check('valid → payment row fields correct',
      pay[0].bank_account_id === bankId && pay[0].payment_mode_id === null &&
      (pay[0].date instanceof Date ? pay[0].date.toISOString().slice(0, 10) : String(pay[0].date).slice(0, 10)) === today,
      `date=${JSON.stringify(pay[0]?.date)}`)
    check('valid → exactly one ledger row (credit 500)', se.transactions === 1 && tx[0].type === 'credit' && Number(tx[0].amount) === 500)
    check('valid → sale paid=500 due=500', Number(saleRow[0].paid) === 500 && Number(saleRow[0].due) === 500)
  }

  // ══════════ pay_purchase ══════════
  console.log('\n=== pay_purchase — NULL / zero / negative / overpay / valid ===')

  for (const [label, amount] of [['NULL', null], ['zero', 0], ['negative', -50]] as const) {
    const r = await callRpc('pay_purchase', { id: purchaseId, amount, date: today, bank: bankId, mode: null })
    const se = await sideEffects('out', purchaseId)
    const pRow = await sql`SELECT paid, due FROM public.purchases WHERE id = ${purchaseId}`
    check(`${label} amount rejected`,
      !r.ok && /greater than zero/i.test(r.msg), `got: ${r.ok ? 'ACCEPTED' : r.msg}`)
    check(`${label} amount → no payment row`, se.payments === 0)
    check(`${label} amount → no ledger row`, se.transactions === 0)
    check(`${label} amount → purchase untouched`, Number(pRow[0].paid) === 0 && Number(pRow[0].due) === 1000)
  }

  { // overpayment
    const r = await callRpc('pay_purchase', { id: purchaseId, amount: 1001, date: today, bank: bankId, mode: null })
    const se = await sideEffects('out', purchaseId)
    const pRow = await sql`SELECT paid, due FROM public.purchases WHERE id = ${purchaseId}`
    check('overpay rejected (upper bound intact)',
      !r.ok && /exceed due/i.test(r.msg), `got: ${r.ok ? 'ACCEPTED' : r.msg}`)
    check('overpay → no payment row', se.payments === 0)
    check('overpay → no ledger row', se.transactions === 0)
    check('overpay → purchase untouched', Number(pRow[0].paid) === 0 && Number(pRow[0].due) === 1000)
  }

  { // valid positive
    const r = await callRpc('pay_purchase', { id: purchaseId, amount: 500, date: today, bank: bankId, mode: null })
    check('valid positive accepted', r.ok, r.msg)
    const se = await sideEffects('out', purchaseId)
    const pay = await sql`SELECT amount, bank_account_id FROM public.payments_out WHERE purchase_id = ${purchaseId}`
    const tx = await sql`SELECT type, amount FROM public.account_transactions WHERE reference_type = 'payment_out' AND reference_id IN (SELECT id FROM public.payments_out WHERE purchase_id = ${purchaseId})`
    const pRow = await sql`SELECT paid, due FROM public.purchases WHERE id = ${purchaseId}`
    check('valid → exactly one payment row', se.payments === 1 && Number(pay[0].amount) === 500)
    check('valid → exactly one ledger row (debit 500)', se.transactions === 1 && tx[0].type === 'debit' && Number(tx[0].amount) === 500)
    check('valid → purchase paid=500 due=500', Number(pRow[0].paid) === 500 && Number(pRow[0].due) === 500)
  }

  // ── message_jobs safety during the whole run ──
  const mj1 = (await sql`SELECT count(*)::int AS n FROM public.message_jobs`)[0].n
  check('message_jobs still 0 after valid payments (auto-receipt off)', mj1 === 0, `n=${mj1}`)

  // ── Complete fixture cleanup (reverse FK order) ──
  await sql`DELETE FROM public.account_transactions WHERE reference_id IN (SELECT id FROM public.payments_in WHERE sale_id = ${saleId}) AND reference_type = 'payment_in'`
  await sql`DELETE FROM public.account_transactions WHERE reference_id IN (SELECT id FROM public.payments_out WHERE purchase_id = ${purchaseId}) AND reference_type = 'payment_out'`
  await sql`DELETE FROM public.payments_in WHERE sale_id = ${saleId}`
  await sql`DELETE FROM public.payments_out WHERE purchase_id = ${purchaseId}`
  await sql`DELETE FROM public.sales WHERE id = ${saleId}`
  await sql`DELETE FROM public.purchases WHERE id = ${purchaseId}`
  await sql`DELETE FROM public.parties WHERE id = ${partyId}`

  // ── Post-cleanup state verification ──
  const leftoverSales = await sql`SELECT count(*)::int AS n FROM public.sales WHERE bill_number = 'AUDIT-FIXTURE-SALE'`
  const leftoverPurch = await sql`SELECT count(*)::int AS n FROM public.purchases WHERE bill_number = 'AUDIT-FIXTURE-PURCHASE'`
  const leftoverParty = await sql`SELECT count(*)::int AS n FROM public.parties WHERE name = 'AUDIT-PAYMENT-BOUNDARY-FIXTURE'`
  const leftoverTx = await sql`SELECT count(*)::int AS n FROM public.account_transactions WHERE notes IS NULL AND reference_type IN ('payment_in','payment_out') AND date = current_date AND amount = 500`
  const mj2 = (await sql`SELECT count(*)::int AS n FROM public.message_jobs`)[0].n
  check('cleanup: fixture sale gone', leftoverSales[0].n === 0)
  check('cleanup: fixture purchase gone', leftoverPurch[0].n === 0)
  check('cleanup: fixture party gone', leftoverParty[0].n === 0)
  check('cleanup: no stray 500 ledger rows from fixture', leftoverTx[0].n === 0, `n=${leftoverTx[0].n}`)
  check('cleanup: message_jobs still 0', mj2 === 0)

  console.log(`\n══════ RESULT: ${pass} PASS / ${fail} FAIL ══════`)
} finally {
  await sql.end()
}
process.exit(fail > 0 ? 1 : 0)
