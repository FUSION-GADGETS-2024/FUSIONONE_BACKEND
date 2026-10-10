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
const d = (v: any) => (v == null ? null : String(v).slice(0, 10))

const fys = await sql`select id, start_date::text as s, end_date::text as e, status from financial_years`
const fyOf = (id: string) => (fys as any[]).find((f) => f.id === id)

async function auditTable(table: string, label: string) {
  const rows = await sql.unsafe(`select id, date::text as date, financial_year_id from ${table} where financial_year_id is not null`)
  let bad = 0
  for (const r of rows as any[]) {
    const fy = fyOf(r.financial_year_id)
    if (!fy) { console.log(`${label} ${r.id}: UNKNOWN FY`); continue }
    if (r.date < fy.s || r.date > fy.e) {
      bad++
      console.log(`${label} MISMATCH: date=${r.date} outside FY ${fy.s}..${fy.e}  id=${r.id}`)
    }
  }
  console.log(`${label}: ${rows.length} rows, ${bad} mismatches`)
  return bad
}

let total = 0
total += await auditTable('purchases', 'purchases')
total += await auditTable('sales', 'sales')
total += await auditTable('payments_in', 'payments_in')
total += await auditTable('payments_out', 'payments_out')
total += await auditTable('account_transactions', 'ledger')
total += await auditTable('proforma_invoices', 'proforma')
console.log(`\nTOTAL mismatches: ${total}`)

console.log('\n=== The seed recovery chain ledger rows (FY 2027-28, sale_cancelled / around Oct 9) ===')
const fy2728 = (fys as any[]).find((f) => f.s === '2027-04-01')
const ledger = await sql`
  select id, date::text as date, type, amount::float8, reference_type, notes
  from account_transactions where financial_year_id = ${fy2728.id} order by date`
for (const l of ledger) console.log(`${l.date} ${l.type} ${l.amount} ${l.reference_type} ${l.notes ?? ''}`)

console.log('\n=== payments_in/out in FY 2027-28 ===')
const pi = await sql`select id, date::text as date, amount::float8 from payments_in where financial_year_id = ${fy2728.id} order by date`
const po = await sql`select id, date::text as date, amount::float8 from payments_out where financial_year_id = ${fy2728.id} order by date`
for (const p of pi) console.log(`payments_in ${p.date} ${p.amount}`)
for (const p of po) console.log(`payments_out ${p.date} ${p.amount}`)

await sql.end()
