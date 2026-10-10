/**
 * FUSIONONE — Financial-year date-integrity invariant test suite.
 *
 * Regression coverage for the reconciliation defects:
 *
 *   A. create_trade_in_purchase_bill must never produce a purchase whose
 *      date lies outside its own financial year (the reported defect:
 *      PUR-2027-28-0006 dated 9 Oct 2026 in FY 2027-28). The RPC derives
 *      the date from current_date CLAMPED into the sale's year — this suite
 *      runs with the sandbox clock OUTSIDE the scratch year (the exact
 *      condition that produced the defect) and asserts the invariant.
 *   B. cancel_sale's payment-reversal ledger rows keep the same invariant
 *      (date within the sale's financial year).
 *   C. The authoritative creation RPCs REJECT out-of-year dates:
 *      create_purchase / create_sale raise "Date must be within the
 *      financial year" (the guard that already exists live — asserted here
 *      so no future change silently removes it).
 *   D. Recovery-bill semantics stay intact: canonical PUR-YYYY-YY-NNNN
 *      numbering, the sale's FY, total=paid=credit value, due=0, active,
 *      one purchase_items row referencing the trade-in device.
 *   E. No financial year is closed or activated as a side effect, and no
 *      message jobs are created (WhatsApp untouched).
 *
 * Runs against the TEST Supabase project ONLY (never production). Creates
 * an isolated scratch financial year far in the future (FY 2033-34, which
 * the live clock does not intersect) plus its own party/bank/devices, and
 * removes everything at the end. Exit code is non-zero on any failure.
 *
 * Usage (from database/tools):
 *   bun run recovery-date-invariant-tests.ts
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
const sql = postgres(DB_URL, { ssl: { rejectUnauthorized: false }, max: 4, prepare: false, idle_timeout: 5 })

let failures = 0
let passes = 0
function ok(condition: boolean, label: string, detail?: unknown): void {
  if (condition) {
    passes++
    console.log(`  PASS  ${label}`)
  } else {
    failures++
    console.log(`  FAIL  ${label}${detail !== undefined ? ` → ${JSON.stringify(detail)}` : ''}`)
  }
}

async function rpc(fn: string, params: Record<string, unknown>): Promise<any> {
  const entries = Object.entries(params)
  if (entries.length === 0) throw new Error('rpc helper expects at least one named parameter')
  const args = entries.map(([name], i) => `${name} := $${i + 1}`).join(', ')
  const rows = await sql.unsafe(`SELECT public.${fn}(${args}) AS result`, entries.map(([, v]) => v) as any)
  return (rows as any[])[0]?.result
}

async function rpcFails(fn: string, params: Record<string, unknown>, expectText: string, label: string): Promise<void> {
  try {
    await rpc(fn, params)
    ok(false, `${label} (expected failure containing "${expectText}")`)
  } catch (e: any) {
    ok(String(e.message).includes(expectText), label, e.message)
  }
}

let imeiSeq = 710000000000010
const nextImei = () => String(imeiSeq++)

const FY_START = '2033-04-01'
const FY_END = '2034-03-31'

// ── FK-safe teardown scoped to this suite's scratch fixtures ─────────────────
async function cleanupFixtures(fyIds: string[]): Promise<void> {
  if (fyIds.length === 0) return
  await sql`DELETE FROM public.inventory_items WHERE origin_inventory_item_id IN (
    SELECT id FROM public.inventory_items WHERE financial_year_id IN ${sql(fyIds)})`
  const sales = await sql`SELECT id FROM public.sales WHERE financial_year_id IN ${sql(fyIds)}`
  for (const s of sales) {
    await sql`DELETE FROM public.account_transactions WHERE reference_id = ${s.id} AND reference_type IN ('sale', 'sale_cancelled')`
    await sql`DELETE FROM public.payments_in WHERE sale_id = ${s.id}`
    await sql`DELETE FROM public.trade_ins WHERE sale_id = ${s.id}`
    await sql`DELETE FROM public.sale_items WHERE sale_id = ${s.id}`
    await sql`DELETE FROM public.sales WHERE id = ${s.id}`
  }
  await sql`DELETE FROM public.account_transactions WHERE financial_year_id IN ${sql(fyIds)}`
  await sql`DELETE FROM public.payments_in WHERE financial_year_id IN ${sql(fyIds)}`
  await sql`DELETE FROM public.payments_out WHERE financial_year_id IN ${sql(fyIds)}`
  await sql`DELETE FROM public.purchase_items WHERE purchase_id IN (SELECT id FROM public.purchases WHERE financial_year_id IN ${sql(fyIds)})`
  await sql`DELETE FROM public.purchases WHERE financial_year_id IN ${sql(fyIds)}`
  await sql`DELETE FROM public.inventory_items WHERE financial_year_id IN ${sql(fyIds)}`
  await sql`DELETE FROM public.financial_years WHERE id IN ${sql(fyIds)}`
  await sql`DELETE FROM public.bank_accounts WHERE name = 'RDIV Cash'`
  await sql`DELETE FROM public.parties WHERE name LIKE 'RDIV Test Party%'`
}

async function main() {
  console.log('\n═══ FUSIONONE Financial-year date-integrity invariant suite ═══\n')

  // Pre-cleanup of any stale fixtures from a previously crashed run.
  const stale = await sql`SELECT id FROM public.financial_years WHERE start_date IN ('2033-04-01')`
  if (stale.length > 0) {
    console.log(`  (pre-cleanup: removing ${stale.length} stale fixture FYs)`)
    await cleanupFixtures(stale.map((r: any) => r.id))
  }

  // The FY-status snapshot: nothing this suite does may close or activate
  // any financial year (including the real TEST years).
  const fyStatusBefore = await sql`SELECT id, status FROM public.financial_years ORDER BY start_date`
  const mjBefore = (await sql`SELECT count(*)::int AS n FROM public.message_jobs`)[0].n

  // ── Fixtures ────────────────────────────────────────────────────────────
  const fy = await sql`INSERT INTO public.financial_years (start_date, end_date, status)
    VALUES (${FY_START}, ${FY_END}, 'active') RETURNING id`.then((r) => r[0].id as string)
  const partyA = await sql`INSERT INTO public.parties (name, number)
    VALUES ('RDIV Test Party A', '919999000201') RETURNING id`.then((r) => r[0].id as string)
  const partyB = await sql`INSERT INTO public.parties (name, number)
    VALUES ('RDIV Test Party B', '919999000202') RETURNING id`.then((r) => r[0].id as string)
  const bank = await sql`INSERT INTO public.bank_accounts (name, is_cash)
    VALUES ('RDIV Cash', true) RETURNING id`.then((r) => r[0].id as string)

  const mkItem = (rate: number) =>
    sql`INSERT INTO public.inventory_items
          (brand, model, imei, ram_rom, color, purchase_price, base_selling_price, status, source, financial_year_id, opening_entry_type)
        VALUES ('RDIVBrand', 'RModel', ${nextImei()}, '8/128', 'Black', ${rate - 1000}, ${rate}, 'in_stock', 'purchase', ${fy}, 'direct')
        RETURNING id`.then((r) => r[0].id as string)
  const device1 = await mkItem(20000) // sold in the cancelled sale

  const clockDate = (await sql`SELECT current_date::text AS d`)[0].d
  console.log(`  scratch FY ${FY_START}..${FY_END} (active) | live clock ${clockDate} (outside the year — the defect condition)\n`)

  // ═══════════════════════════════════════════════════════════════════════
  console.log('── A. Sale with trade-in + resale (the recovery scenario setup) ──')
  // ═══════════════════════════════════════════════════════════════════════

  const sale1 = await rpc('create_sale', { payload: {
    financial_year_id: fy, party_id: partyA, date: '2033-05-10',
    items: [{ inventory_item_id: device1, sold_price: 19500 }],
    trade_ins: [{ brand: 'RDIV OldPhone', model: 'X1', imei: nextImei(), ram_rom: '6/64', color: 'White', credit_value: 5000, mrp: 9000 }],
    discount: 0, paid: 8000, due: 0, bank_account_id: bank, payment_mode_id: null,
  }})
  ok(!!sale1?.sale_id, 'create_sale (with trade-in, partially paid)', sale1)

  const ti = await sql`SELECT id, inventory_item_id, credit_value FROM public.trade_ins WHERE sale_id = ${sale1.sale_id}`.then((r) => r[0] as any)
  ok(!!ti?.id, 'trade_ins row created')
  const hiddenBill = await sql`
    SELECT p.bill_number, p.date::text AS date, p.status FROM public.purchases p
     JOIN public.purchase_items pi ON pi.purchase_id = p.id
     WHERE pi.inventory_item_id = ${ti.inventory_item_id}`.then((r) => r[0] as any)
  ok(/^PUR-TRD-2033-34-\d{4}$/.test(hiddenBill?.bill_number), 'hidden PUR-TRD acquisition bill created', hiddenBill)
  ok(hiddenBill?.date === '2033-05-10', 'hidden acquisition bill dated the sale date (inside the FY)', hiddenBill?.date)

  // Resell the trade-in device to a second customer.
  const sale2 = await rpc('create_sale', { payload: {
    financial_year_id: fy, party_id: partyB, date: '2033-06-01',
    items: [{ inventory_item_id: ti.inventory_item_id, sold_price: 7000 }],
    trade_ins: [], discount: 0, paid: 7000, due: 0, bank_account_id: bank, payment_mode_id: null,
  }})
  ok(!!sale2?.sale_id, 'trade-in device resold (second sale)')
  ok((await sql`SELECT status FROM public.inventory_items WHERE id = ${ti.inventory_item_id}`)[0].status === 'sold',
    'trade-in device is sold at cancellation time (the resold branch)')

  // ═══════════════════════════════════════════════════════════════════════
  console.log('── B. cancel_sale keeps the reversal ledger date inside the FY ──')
  // ═══════════════════════════════════════════════════════════════════════

  const cancelled = await rpc('cancel_sale', { p_sale_id: sale1.sale_id })
  ok(Array.isArray(cancelled?.resold) && cancelled.resold.length === 1, 'cancel_sale reports the resold trade-in', cancelled)

  const reversal = await sql`
    SELECT date::text AS date, amount::float8 AS amount, type, financial_year_id
      FROM public.account_transactions
     WHERE reference_type = 'sale_cancelled' AND reference_id = ${sale1.sale_id}`.then((r) => r[0] as any)
  ok(!!reversal, 'sale_cancelled reversal ledger row created')
  ok(reversal?.date >= FY_START && reversal?.date <= FY_END,
    'reversal ledger date lies INSIDE the sale\'s financial year (clamped, not the raw clock)', reversal?.date)
  ok(reversal?.amount === 8000 && reversal?.type === 'debit', 'reversal is a debit of the retained payment (8000)')

  ok((await sql`SELECT status FROM public.sales WHERE id = ${sale1.sale_id}`)[0].status === 'cancelled', 'sale marked cancelled')
  ok((await sql`SELECT status FROM public.purchases WHERE id = (SELECT purchase_id FROM public.purchase_items WHERE inventory_item_id = ${ti.inventory_item_id} LIMIT 1)`)[0].status === 'cancelled',
    'the resold trade-in\'s hidden acquisition bill is cancelled')

  // ═══════════════════════════════════════════════════════════════════════
  console.log('── C. The recovery bill keeps the date-in-FY invariant ──')
  // ═══════════════════════════════════════════════════════════════════════

  const billNo = await rpc('create_trade_in_purchase_bill', { p_sale_id: sale1.sale_id, p_trade_in_id: ti.id })
  ok(typeof billNo === 'string' && /^PUR-2033-34-\d{4}$/.test(billNo), 'recovery bill uses the canonical purchase numbering', billNo)

  const recovery = await sql`
    SELECT p.id, p.bill_number, p.date::text AS date, p.total::float8 AS total, p.paid::float8 AS paid,
           p.due::float8 AS due, p.status, p.financial_year_id
      FROM public.purchases p WHERE p.bill_number = ${billNo} AND p.financial_year_id = ${fy}`.then((r) => r[0] as any)
  ok(!!recovery, 'recovery bill row exists in the sale\'s FY')
  ok(recovery?.date >= FY_START && recovery?.date <= FY_END,
    'recovery bill date lies INSIDE its financial year (the reported defect: 9 Oct 2026 in FY 2027-28)', recovery?.date)
  ok(recovery?.total === 5000 && recovery?.paid === 5000 && recovery?.due === 0, 'recovery bill settles at the credit value (paid=total, due=0)')
  ok(recovery?.status === 'active', 'recovery bill is active')
  const rItem = await sql`SELECT inventory_item_id FROM public.purchase_items WHERE purchase_id = ${recovery.id}`
  ok(rItem.length === 1 && rItem[0].inventory_item_id === ti.inventory_item_id, 'recovery bill references the trade-in device')

  // Whole-scratch-year invariant: EVERY dated row of the scratch FY lies
  // inside it (purchases, sales, payments, ledger).
  for (const [table, label] of [['purchases', 'purchases'], ['sales', 'sales'], ['payments_in', 'payments_in'], ['account_transactions', 'ledger']] as const) {
    const bad = await sql.unsafe(`
      SELECT count(*)::int AS n FROM public.${table} t
       WHERE t.financial_year_id = $1
         AND (t.date < $2 OR t.date > $3)`, [fy, FY_START, FY_END])
    ok(bad[0].n === 0, `scratch ${label}: zero rows dated outside the financial year`, bad[0].n)
  }

  // ═══════════════════════════════════════════════════════════════════════
  console.log('── D. Authoritative creation RPCs reject out-of-year dates ──')
  // ═══════════════════════════════════════════════════════════════════════

  await rpcFails('create_purchase', { payload: {
    financial_year_id: fy, party_id: partyB, date: '2033-03-31',
    items: [{ brand: 'RDIVBrand', model: 'RejectA', imei: nextImei(), ram_rom: '8/128', color: 'Black', purchase_price: 1000, base_selling_price: 1500 }],
    paid: 0, bank_account_id: bank, payment_mode_id: null,
  }}, 'within the financial year', 'create_purchase rejects a date before the FY start')

  await rpcFails('create_purchase', { payload: {
    financial_year_id: fy, party_id: partyB, date: '2034-04-01',
    items: [{ brand: 'RDIVBrand', model: 'RejectB', imei: nextImei(), ram_rom: '8/128', color: 'Black', purchase_price: 1000, base_selling_price: 1500 }],
    paid: 0, bank_account_id: bank, payment_mode_id: null,
  }}, 'within the financial year', 'create_purchase rejects a date after the FY end')

  await rpcFails('create_sale', { payload: {
    financial_year_id: fy, party_id: partyB, date: '2033-03-31',
    items: [{ inventory_item_id: device1, sold_price: 1000 }],
    trade_ins: [], discount: 0, paid: 0, due: 0, bank_account_id: bank, payment_mode_id: null,
  }}, 'within the financial year', 'create_sale rejects a date before the FY start')

  // Rejected creations must not consume bill numbers (counters unchanged
  // since the recovery bill).
  const ctrAfter = await sql`SELECT sale_counter, purchase_counter FROM public.financial_years WHERE id = ${fy}`.then((r) => r[0])
  const salesInFy = (await sql`SELECT count(*)::int AS n FROM public.sales WHERE financial_year_id = ${fy}`)[0].n
  const purchInFy = (await sql`SELECT count(*)::int AS n FROM public.purchases WHERE financial_year_id = ${fy}`)[0].n
  ok(ctrAfter.sale_counter === salesInFy, 'sale counter equals the number of created sales (no wasted numbers)', ctrAfter)
  // purchases in the scratch FY: hidden TRD + recovery + resale-none = 2
  ok(ctrAfter.purchase_counter === purchInFy, 'purchase counter equals the number of created purchase bills (no wasted numbers)', { ctrAfter, purchInFy })

  // ═══════════════════════════════════════════════════════════════════════
  console.log('── E. No unintended financial-year state changes / messages ──')
  // ═══════════════════════════════════════════════════════════════════════

  const fyStatusAfter = await sql`SELECT id, status FROM public.financial_years WHERE start_date <> '2033-04-01' ORDER BY start_date`
  const beforeMap = new Map((fyStatusBefore as any[]).filter((f) => f.id !== fy).map((f) => [f.id, f.status]))
  const unchanged = (fyStatusAfter as any[]).every((f) => beforeMap.get(f.id) === f.status)
  ok(unchanged, 'no financial year was closed or activated as a side effect', { before: [...beforeMap], after: fyStatusAfter })

  const mjAfter = (await sql`SELECT count(*)::int AS n FROM public.message_jobs`)[0].n
  ok(mjAfter === mjBefore && mjAfter === 0, 'message_jobs stays 0 (no WhatsApp activity)')

  // ── Teardown ────────────────────────────────────────────────────────────
  await cleanupFixtures([fy])
  const remaining = await sql`SELECT count(*)::int AS n FROM public.financial_years WHERE start_date = '2033-04-01'`
  ok(remaining[0].n === 0, 'scratch fixtures fully removed')
  const mjFinal = (await sql`SELECT count(*)::int AS n FROM public.message_jobs`)[0].n
  ok(mjFinal === 0, 'message_jobs still 0 after teardown')

  await sql.end()
  console.log(`\n═══ ${passes} passed, ${failures} failed ═══\n`)
  process.exit(failures > 0 ? 1 : 0)
}

main().catch(async (e) => {
  console.error(e)
  const stale = await sql`SELECT id FROM public.financial_years WHERE start_date IN ('2033-04-01')`
  await cleanupFixtures(stale.map((r: any) => r.id))
  await sql.end()
  process.exit(1)
})
