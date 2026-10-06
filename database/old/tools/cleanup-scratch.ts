// Thorough removal of ALL scratch (2028+) artifacts, FK-safe.
import postgres from 'postgres'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const HERE = dirname(fileURLToPath(import.meta.url))
const env = Object.fromEntries(readFileSync(join(HERE, '.env'), 'utf8').split('\n').filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] }))
const sql = postgres(env.TEST_SUPABASE_DB_URL, { max: 1, prepare: false, idle_timeout: 5 })

const scratchFys = await sql`SELECT id FROM financial_years WHERE start_date >= '2028-04-01'`
const ids = scratchFys.map((f) => f.id)
console.log('scratch FYs:', ids)
if (ids.length > 0) {
  const idList = ids.map((i: string) => `'${i}'`).join(',')
  await sql.unsafe(`
    DELETE FROM account_transactions WHERE financial_year_id IN (${idList});
    DELETE FROM account_fund_entries WHERE financial_year_id IN (${idList});
    DELETE FROM account_transfers WHERE financial_year_id IN (${idList});
    DELETE FROM payments_in WHERE financial_year_id IN (${idList});
    DELETE FROM payments_out WHERE financial_year_id IN (${idList});
    DELETE FROM trade_ins WHERE sale_id IN (SELECT id FROM sales WHERE financial_year_id IN (${idList}));
    DELETE FROM sale_items WHERE sale_id IN (SELECT id FROM sales WHERE financial_year_id IN (${idList}));
    DELETE FROM sales WHERE financial_year_id IN (${idList});
    DELETE FROM purchase_items WHERE purchase_id IN (SELECT id FROM purchases WHERE financial_year_id IN (${idList}));
    DELETE FROM purchases WHERE financial_year_id IN (${idList});
    DELETE FROM proforma_invoice_items WHERE proforma_invoice_id IN (SELECT id FROM proforma_invoices WHERE financial_year_id IN (${idList}));
    DELETE FROM proforma_trade_ins WHERE proforma_invoice_id IN (SELECT id FROM proforma_invoices WHERE financial_year_id IN (${idList}));
    DELETE FROM proforma_invoices WHERE financial_year_id IN (${idList});
    DELETE FROM inventory_items WHERE financial_year_id IN (${idList});
    DELETE FROM financial_years WHERE id IN (${idList});
  `)
  console.log('scratch data removed')
}
const remaining = await sql`SELECT count(*)::int AS n FROM financial_years`
console.log('remaining FYs:', remaining[0].n)
await sql.end()
