/**
 * FUSION ONE — read-only investigation of the FY 2027-28 purchase-analytics
 * figures, financial-year integrity, and classification consistency.
 * SELECT-only. Safety abort unless the TEST project.
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

const d = (v: any) => (v == null ? null : String(v).slice(0, 10))

async function main() {
  console.log('DB current_date =', d((await sql`select current_date as x`)[0].x))

  const fys = await sql`select id, start_date::text as start_date, end_date::text as end_date, status, sale_counter, purchase_counter from financial_years order by start_date`
  for (const fy of fys) console.log(`FY ${d(fy.start_date)}..${d(fy.end_date)} status=${fy.status} saleCtr=${fy.sale_counter} purCtr=${fy.purchase_counter} id=${fy.id}`)
  const fy2728 = (fys as any[]).find((f) => d(f.start_date) === '2027-04-01')
  const fy2627 = (fys as any[]).find((f) => d(f.start_date) === '2026-04-01')

  const stores = await sql`select id, name, active_financial_year_id from store`
  for (const s of stores) console.log(`STORE ${s.name} activeFY=${s.active_financial_year_id === fy2728.id ? 'FY2728' : s.active_financial_year_id === fy2627.id ? 'FY2627' : s.active_financial_year_id}`)

  const purchases = await sql`
    select p.id, p.bill_number, p.date::text as date, p.status, p.total::float8 as total, p.paid::float8 as paid, p.due::float8 as due, p.financial_year_id,
           (select name from parties where id = p.party_id) as party_name,
           (select coalesce(json_agg(json_build_object('inv_id', pi.inventory_item_id, 'source', ii.source)), '[]'::json)
              from purchase_items pi join inventory_items ii on ii.id = pi.inventory_item_id
             where pi.purchase_id = p.id) as items
    from purchases p order by p.financial_year_id, p.date, p.bill_number`

  console.log('\n=== FY 2027-28 purchases (full detail) ===')
  for (const p of (purchases as any[]).filter((p) => p.financial_year_id === fy2728.id)) {
    const isVirtual = String(p.bill_number).startsWith('PUR-TRD-') || (p.items.length > 0 && p.items.every((i: any) => (i.source ?? '') === 'trade_in'))
    console.log(`${p.bill_number} | date=${d(p.date)} | ${p.status} | virtual=${isVirtual} | total=${p.total} paid=${p.paid} due=${p.due} | ${p.party_name} | items=${p.items.length}`)
  }

  console.log('\n=== FY 2027-28 analytics recomputation (period 2027-04-01..2028-03-31) ===')
  let realCount = 0, realTotal = 0, realPaid = 0, realDue = 0
  let virtActive = 0, virtAny = 0
  for (const p of (purchases as any[]).filter((p) => p.financial_year_id === fy2728.id)) {
    const isVirtual = String(p.bill_number).startsWith('PUR-TRD-') || (p.items.length > 0 && p.items.every((i: any) => (i.source ?? '') === 'trade_in'))
    const inPeriod = d(p.date)! >= '2027-04-01' && d(p.date)! <= '2028-03-31'
    if (p.status === 'active' && !isVirtual && inPeriod) { realCount++; realTotal += p.total; realPaid += p.paid; realDue += p.due }
    if (isVirtual && inPeriod) { virtAny++; if (p.status === 'active') virtActive++ }
  }
  console.log(`REAL: bills=${realCount} value=${realTotal} paid=${realPaid} outstanding=${realDue}`)
  console.log(`Virtual in-period: active-only=${virtActive} | any-status=${virtAny}`)

  console.log('\n=== Purchase date/FY mismatches (correct normalization) ===')
  let mism = 0
  for (const p of purchases as any[]) {
    const fy = (fys as any[]).find((f) => f.id === p.financial_year_id)
    const pd = d(p.date)!
    if (pd < d(fy.start_date)! || pd > d(fy.end_date)!) { mism++; console.log(`MISMATCH ${p.bill_number}: date=${pd} outside FY ${d(fy.start_date)}..${d(fy.end_date)}`) }
  }
  console.log(`purchase mismatches: ${mism}`)

  console.log('\n=== Sales date/FY mismatches ===')
  const sales = await sql`select bill_number, date::text as date, status, financial_year_id from sales order by date`
  let sm = 0
  for (const s of sales as any[]) {
    const fy = (fys as any[]).find((f) => f.id === s.financial_year_id)
    const sd = d(s.date)!
    if (sd < d(fy.start_date)! || sd > d(fy.end_date)!) { sm++; console.log(`MISMATCH ${s.bill_number}: date=${sd} outside FY ${d(fy.start_date)}..${d(fy.end_date)}`) }
  }
  console.log(`sales mismatches: ${sm}`)

  console.log('\n=== FY 2027-28 sales + trade-ins (recovery chain) ===')
  const s2728 = await sql`
    select s.id, s.bill_number, s.date::text as date, s.status, s.trade_in_credit::float8 as tic,
           (select name from parties where id = s.party_id) as party,
           (select coalesce(json_agg(json_build_object('id', t.id, 'credit', t.credit_value, 'inv', t.inventory_item_id, 'inv_item', t.inventory_item_id, 'status', (select status from inventory_items where id = t.inventory_item_id))), '[]'::json)
              from trade_ins t where t.sale_id = s.id) as trade_ins
    from sales s where s.financial_year_id = ${fy2728.id} order by s.date`
  for (const s of s2728) console.log(`${s.bill_number} ${d(s.date)} ${s.status} tic=${s.tic} ${s.party} tradeIns=${JSON.stringify(s.trade_ins)}`)

  console.log('\n=== FY 2027-28 payments/ledger referencing the recovery bill ===')
  const rec = (purchases as any[]).find((p) => p.bill_number === 'PUR-2027-28-0006')
  if (rec) {
    const po = await sql`select id, amount::float8, date::text as date from payments_out where purchase_id = ${rec.id}`
    const at = await sql`select id, type, amount::float8, date::text as date, reference_type from account_transactions where reference_id = ${rec.id}`
    console.log('payments_out:', po.length, 'account_transactions:', JSON.stringify(at))
  }

  console.log('\n=== FY 2026-27 boundary records (1 Apr 2026 / 31 Mar 2027) ===')
  const b1 = await sql`select bill_number, date::text as date from purchases where date in ('2026-04-01','2027-03-31')`
  const b2 = await sql`select bill_number, date::text as date from sales where date in ('2026-04-01','2027-03-31','2027-04-01')`
  console.log('purchases at boundaries:', JSON.stringify(b1.map((r: any) => [r.bill_number, d(r.date)])))
  console.log('sales at boundaries:', JSON.stringify(b2.map((r: any) => [r.bill_number, d(r.date)])))

  await sql.end()
}
main().catch((e) => { console.error(e); process.exit(1) })
