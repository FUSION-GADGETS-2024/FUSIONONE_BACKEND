import postgres from 'postgres'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const HERE = dirname(fileURLToPath(import.meta.url))
const env = Object.fromEntries(readFileSync(join(HERE, '.env'), 'utf8').split('\n').filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] }))
const sql = postgres(env.TEST_SUPABASE_DB_URL, { max: 1, prepare: false, idle_timeout: 5 })
const fys = await sql`SELECT id, start_date, end_date, status FROM financial_years ORDER BY start_date`
console.log(JSON.stringify(fys, null, 1))
await sql.end()
