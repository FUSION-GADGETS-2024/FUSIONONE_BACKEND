/**
 * Read-only investigation of the FY 2027-28 Sales Register defect:
 * actual transaction dates vs stored financial-year association, and the
 * boundary records around 1 Apr 2027 / 31 Mar 2027.
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

/** postgres.js returns DATE columns as Date objects — normalize to YYYY-MM-DD. */
const day = (v: Date | string | null) => (v == null ? 'null' : (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10)))

const fys = await sql`select id, start_date, end_date, status
  from financial_years order by start_date`
console.log('FINANCIAL YEARS:')
for (const fy of fys) {
  console.log(`  ${fy.id}  ${day(fy.start_date)} → ${day(fy.end_date)}  status=${fy.status}`)
}

const FY2728 = fys.find((f) => day(f.start_date) === '2027-04-01')
const FY2627 = fys.find((f) => day(f.start_date) === '2026-04-01')

console.log('\nSALES WITH financial_year_id = FY 2027-28:')
for (const s of await sql`select bill_number, date, status, final_total, paid, due, created_at
  from sales where financial_year_id = ${FY2728.id} order by date, bill_number`) {
  console.log(`  ${s.bill_number}  date=${day(s.date)}  status=${s.status}  total=${s.final_total}`)
}

console.log('\nSALES WITH financial_year_id = FY 2026-27 (tail, boundary window):')
for (const s of await sql`select bill_number, date, status, final_total
  from sales where financial_year_id = ${FY2627.id} and date >= '2027-03-01' order by date, bill_number`) {
  console.log(`  ${s.bill_number}  date=${day(s.date)}  status=${s.status}  total=${s.final_total}`)
}

console.log('\nCROSS-CHECK — sales whose date is OUTSIDE their stored FY window:')
for (const s of await sql`select s.bill_number, s.date, s.financial_year_id, fy.start_date, fy.end_date
  from sales s join financial_years fy on fy.id = s.financial_year_id
  where s.date < fy.start_date or s.date > fy.end_date order by s.date`) {
  console.log(`  ${s.bill_number}  date=${day(s.date)}  FY=${day(s.start_date)}→${day(s.end_date)}`)
}
console.log('(none listed above = every sale date lies inside its stored FY)')

console.log('\nCROSS-CHECK — sales dated 2027-03-31 or 2027-04-01 (either FY):')
for (const s of await sql`select s.bill_number, s.date, s.financial_year_id, fy.start_date as fy_start
  from sales s join financial_years fy on fy.id = s.financial_year_id
  where s.date in ('2027-03-31','2027-04-01') order by s.date`) {
  console.log(`  ${s.bill_number}  date=${day(s.date)}  stored-FY-start=${day(s.fy_start)}`)
}

console.log('\nColumn types:')
for (const c of await sql`select column_name, data_type from information_schema.columns
  where table_name in ('sales','financial_years') and column_name in ('date','start_date','end_date') order by table_name, column_name`) {
  console.log(`  ${c.column_name}: ${c.data_type}`)
}

await sql.end()
