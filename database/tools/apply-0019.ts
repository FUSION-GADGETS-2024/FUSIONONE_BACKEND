/**
 * FUSIONONE — Apply migration 0019 (recovery bills + cancellation reversals
 * keep the date-in-FY invariant) to the LIVE TEST project and verify:
 *
 *   1. Safety abort unless connected to the TEST project.
 *   2. Baseline business row counts + message_jobs = 0 (nothing may change).
 *   3. Apply database/migrations/0019_recovery_and_reversal_date_invariant.sql.
 *   4. Register the migration in schema_migrations (repo filename convention).
 *   5. Verify both function bodies contain the clamped-date logic and no
 *      unguarded current_date write; verify grants posture.
 *   6. Confirm business row counts + message_jobs unchanged.
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

async function count(table: string): Promise<number> {
  const r = await sql.unsafe(`SELECT count(*)::int AS n FROM public.${table}`)
  return r[0].n
}

const TABLES = ['parties', 'sales', 'purchases', 'inventory_items', 'trade_ins', 'payments_in', 'payments_out', 'account_transactions', 'financial_years', 'bank_accounts', 'payment_modes', 'proforma_invoices']
const before: Record<string, number> = {}
for (const t of TABLES) before[t] = await count(t)
const mjBefore = await count('message_jobs')
console.log('Baseline counts:', JSON.stringify(before), 'message_jobs:', mjBefore)

// ── Apply ───────────────────────────────────────────────────────────────────
const FILE = '0019_recovery_and_reversal_date_invariant.sql'
const content = readFileSync(join(HERE, '..', 'migrations', FILE), 'utf8')
await sql.unsafe(content)
console.log(`✓ applied ${FILE}`)
const already = await sql`SELECT 1 FROM public.schema_migrations WHERE version = ${FILE}`
if (already.length === 0) {
  await sql`INSERT INTO public.schema_migrations (version) VALUES (${FILE})`
  console.log(`✓ registered ${FILE} in schema_migrations`)
}

// ── Verify function bodies ──────────────────────────────────────────────────
let ok = true
const fail = (msg: string) => { ok = false; console.log('✗ ' + msg) }
const pass = (msg: string) => console.log('✓ ' + msg)

for (const fn of ['create_trade_in_purchase_bill', 'cancel_sale']) {
  const def = await sql`
    SELECT pg_get_functiondef(p.oid) AS def FROM pg_proc p
     WHERE p.pronamespace='public'::regnamespace AND p.proname=${fn}`
  const body = def[0]?.def ?? ''
  if (body.includes('GREATEST(fy.start_date, LEAST(current_date')) pass(`${fn} clamps the derived date into the financial year`)
  else fail(`${fn} does not contain the clamped-date logic`)
  if (fn === 'create_trade_in_purchase_bill') {
    if (!body.includes('current_date, fy.id')) pass('recovery bill no longer writes a raw current_date next to fy.id')
    else fail('recovery bill still writes a raw current_date')
  } else {
    if (body.includes("v_reversal_date, 'sale_cancelled'")) pass('cancellation reversals use the clamped date')
    else fail('cancellation reversal insert does not use the clamped date')
    if (!body.includes('today date := current_date')) pass('cancel_sale no longer declares a raw today variable')
    else fail('cancel_sale still declares today := current_date')
  }
}

// Grants posture: PUBLIC/anon revoked, authenticated+service_role granted.
const SIGS: Record<string, string> = {
  create_trade_in_purchase_bill: 'public.create_trade_in_purchase_bill(uuid, uuid)',
  cancel_sale: 'public.cancel_sale(uuid)',
}
for (const [fn, sig] of Object.entries(SIGS)) {
  const acl = await sql`
    SELECT has_function_privilege('public', ${sig}, 'EXECUTE') AS pub,
           has_function_privilege('authenticated', ${sig}, 'EXECUTE') AS auth,
           has_function_privilege('service_role', ${sig}, 'EXECUTE') AS svc`
  if (!acl[0].pub && acl[0].auth && acl[0].svc) pass(`${fn} grants posture preserved (anon denied, authenticated + service_role allowed)`)
  else fail(`${fn} grants posture unexpected: ${JSON.stringify(acl[0])}`)
}

// Both RPCs still resolve.
for (const fn of ['create_trade_in_purchase_bill', 'cancel_sale']) {
  const exists = await sql`SELECT 1 FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname=${fn}`
  if (exists.length === 1) pass(`${fn} resolves`)
  else fail(`${fn} missing`)
}

// ── Business data untouched ─────────────────────────────────────────────────
for (const t of TABLES) {
  const n = await count(t)
  if (n !== before[t]) fail(`${t} count changed: ${before[t]} → ${n}`)
}
const mjAfter = await count('message_jobs')
if (mjAfter === mjBefore && mjAfter === 0) pass('message_jobs = 0 (WhatsApp untouched)')
else fail('message_jobs changed')

await sql.end()
console.log(ok ? 'ALL CHECKS PASSED' : 'CHECKS FAILED')
process.exit(ok ? 0 : 1)
