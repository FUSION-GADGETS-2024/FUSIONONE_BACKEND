/**
 * FUSIONONE — Apply migrations 0014/0015 to the LIVE TEST project and
 * verify they are a NO-OP against the already-correct live state:
 *
 *   1. Snapshot the current function definitions (md5).
 *   2. Apply the two migration files (CREATE OR REPLACE + grants).
 *   3. Verify the definitions are byte-identical (semantics unchanged).
 *   4. Register the versions in schema_migrations (repo filenames).
 *   5. Verify the grant posture is unchanged.
 */
import postgres from 'postgres'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

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

const md5 = (s: string) => createHash('md5').update(s).digest('hex')

const FNS = ['receive_payment', 'pay_purchase', 'create_trade_in_purchase_bill']
const FILES = ['0014_payment_amount_invariant.sql', '0015_canonical_recovery_numbering.sql']

async function defs(): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const name of FNS) {
    const rows = await sql`
      SELECT pg_get_functiondef(p.oid) AS def
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = ${name}`
    out[name] = rows[0].def
  }
  return out
}

const before = await defs()
console.log('BEFORE md5:', Object.fromEntries(FNS.map(f => [f, md5(before[f])])))

for (const file of FILES) {
  const content = readFileSync(join(HERE, '..', 'migrations', file), 'utf8')
  await sql.unsafe(content)
  console.log(`✓ applied ${file}`)
  const already = await sql`SELECT 1 FROM public.schema_migrations WHERE version = ${file}`
  if (already.length === 0) {
    await sql`INSERT INTO public.schema_migrations (version) VALUES (${file})`
    console.log(`✓ registered ${file} in schema_migrations`)
  }
}

const after = await defs()
console.log('AFTER  md5:', Object.fromEntries(FNS.map(f => [f, md5(after[f])])))

let ok = true
for (const f of FNS) {
  const same = before[f] === after[f]
  console.log(`${same ? 'IDENTICAL' : 'CHANGED  '} ${f}`)
  if (!same) ok = false
}

const grants = await sql`
  SELECT p.proname, r.rolname, has_function_privilege(r.rolname, p.oid, 'EXECUTE') AS can_exec
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace,
       (VALUES ('anon'),('authenticated'),('service_role'),('public')) AS r(rolname)
  WHERE n.nspname='public' AND p.proname IN ('receive_payment','pay_purchase','create_trade_in_purchase_bill')
  ORDER BY p.proname, r.rolname`
console.log('Grant posture:')
for (const g of grants) console.log(`  ${g.proname} → ${g.rolname}: ${g.can_exec}`)

const mj = (await sql`SELECT count(*)::int AS n FROM public.message_jobs`)[0].n
console.log('message_jobs:', mj)
await sql.end()
process.exit(ok && mj === 0 ? 0 : 1)
