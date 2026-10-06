// Re-applies 0006_functions.sql (all functions are CREATE OR REPLACE).
import postgres from 'postgres'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const env = Object.fromEntries(
  readFileSync(join(HERE, '.env'), 'utf8').split('\n').filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] }),
)
const sql = postgres(env.TEST_SUPABASE_DB_URL, { max: 1, prepare: false, idle_timeout: 5 })
await sql.unsafe(readFileSync(join(HERE, '..', 'migrations', '0006_functions.sql'), 'utf8'))
console.log('functions re-applied')
await sql.end()
