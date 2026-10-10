/**
 * FUSIONONE — Recovery bill numbering verification (Item 4 re-audit).
 *
 * Calls the LIVE create_trade_in_purchase_bill inside a transaction that is
 * ALWAYS rolled back: the generated bill number is captured, and no rows,
 * counters or side effects persist. Also snapshots historical bill numbers
 * before/after to prove they are untouched.
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

// Historical bill numbers before the test
const before = await sql`SELECT bill_number FROM public.purchases ORDER BY bill_number`
console.log('Purchases BEFORE:', before.map((b: any) => b.bill_number).join(', '))

const fyBefore = await sql`SELECT start_date, end_date, purchase_counter FROM public.financial_years WHERE status = 'active' ORDER BY start_date LIMIT 1`
console.log('Active FY:', JSON.stringify(fyBefore[0]))

let generated = '(none)'
let err: string | null = null
try {
  await sql.begin(async (tx) => {
    // Fixture: party + inventory item + sale + trade_in (all inside the txn)
    const fy = await tx`SELECT id, start_date, end_date, purchase_counter FROM public.financial_years WHERE status = 'active' ORDER BY start_date LIMIT 1`
    const fyId = fy[0].id
    const counterBefore = fy[0].purchase_counter
    console.log('FY counter before call:', counterBefore)
    const bank = await tx`SELECT id FROM public.bank_accounts LIMIT 1`
    const bankId = bank[0].id
    const party = await tx`
      INSERT INTO public.parties (name, number) VALUES ('AUDIT-RECOVERY-NUMBERING-FIXTURE', '+919999999998')
      RETURNING id`
    const partyId = party[0].id
    const inv = await tx.unsafe(`
      INSERT INTO public.inventory_items (brand, model, imei, ram_rom, color, purchase_price, base_selling_price, status, source, financial_year_id)
      VALUES ('AUDIT-Brand', 'AUDIT-Model', '111111111111111', '8/128', 'Black', 500, 700, 'sold', 'purchase', $1)
      RETURNING id`, [fyId])
    const invId = inv[0].id
    const sale = await tx.unsafe(`
      INSERT INTO public.sales (bill_number, party_id, total, discount, trade_in_credit, final_total, paid, due, bank_account_id, date, financial_year_id, status)
      VALUES ('AUDIT-FIXTURE-SALE-RB', $1, 1000, 0, 400, 600, 600, 0, $2, current_date, $3, 'active')
      RETURNING id`, [partyId, bankId, fyId])
    const saleId = sale[0].id
    const ti = await tx.unsafe(`
      INSERT INTO public.trade_ins (sale_id, inventory_item_id, credit_value)
      VALUES ($1, $2, 400) RETURNING id`, [saleId, invId])
    const tiId = ti[0].id

    // ── THE AUTHORITATIVE CALL ──
    const r = await tx.unsafe('SELECT public.create_trade_in_purchase_bill($1::uuid, $2::uuid) AS bill_no', [saleId, tiId])
    generated = r[0].bill_no
    console.log('\n>>> GENERATED RECOVERY BILL NUMBER:', generated)

    const fyAfter = await tx.unsafe('SELECT purchase_counter FROM public.financial_years WHERE id = $1', [fyId])
    console.log('>>> FY counter after call (inside txn):', fyAfter[0].purchase_counter)

    // Deliberate rollback: throw to abort the transaction
    throw new Error('DELIBERATE-ROLLBACK')
  })
} catch (e: any) {
  if (String(e.message) !== 'DELIBERATE-ROLLBACK') err = String(e.message)
}

console.log('\nRolled back:', err ? 'ERROR: ' + err : 'yes (deliberate)')

// Verify NOTHING persisted
const after = await sql`SELECT bill_number FROM public.purchases ORDER BY bill_number`
const same = JSON.stringify(before) === JSON.stringify(after)
console.log('Purchases AFTER:', after.map((b: any) => b.bill_number).join(', '))
console.log('Historical bill numbers unchanged:', same)
const fyAfter2 = await sql`SELECT purchase_counter FROM public.financial_years WHERE status = 'active' ORDER BY start_date LIMIT 1`
console.log('FY counter after rollback (persistent):', fyAfter2[0].purchase_counter)
const leftover = await sql`SELECT count(*)::int AS n FROM public.parties WHERE name = 'AUDIT-RECOVERY-NUMBERING-FIXTURE'`
console.log('Fixture party gone:', leftover[0].n === 0)
const mj = await sql`SELECT count(*)::int AS n FROM public.message_jobs`
console.log('message_jobs:', mj[0].n)

// Format check
const canonical = /^PUR-\d{4}-\d{2}-\d{4}$/.test(generated)
console.log('\nFormat matches canonical PUR-YYYY-YY-NNNN:', canonical, '→', generated)
await sql.end()
process.exit(canonical && same && leftover[0].n === 0 ? 0 : 1)
