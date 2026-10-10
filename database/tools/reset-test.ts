/**
 * FUSIONONE TEST-environment reset (TEST project ONLY — never production).
 *
 * Treats the TEST Supabase project as a fresh installation:
 *   - wipes ALL application data (business tables + public.users),
 *   - removes ALL auth users (via the Admin API — the supported path that
 *     cleans the auth schema correctly; public.users cascades via FK),
 *   - PRESERVES the schema: migrations history, tables, constraints,
 *     functions, triggers, RLS policies, storage buckets/policies.
 *
 * Verification after reset: every business table is empty, auth.users is
 * empty, object counts (tables/functions/policies) are unchanged, buckets
 * survive. Exit code is non-zero when anything is not clean.
 *
 * Usage (from database/tools):
 *   bun run reset-test.ts   # uses TEST_SUPABASE_DB_URL + TEST_SUPABASE_SECRET_KEY from .env
 */
import postgres from 'postgres'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

function loadEnv(): Record<string, string> {
  const raw = readFileSync(join(HERE, '.env'), 'utf8')
  return Object.fromEntries(
    raw
      .split('\n')
      .filter((l) => l.includes('=') && !l.startsWith('#'))
      .map((l) => {
        const i = l.indexOf('=')
        return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
      }),
  )
}

const env = loadEnv()
const DB_URL = process.env.FUSIONONE_DB_URL || env.TEST_SUPABASE_DB_URL
const SB_URL = env.TEST_SUPABASE_URL
const SECRET = env.TEST_SUPABASE_SECRET_KEY
if (!DB_URL || !SB_URL || !SECRET) {
  throw new Error('TEST_SUPABASE_DB_URL / TEST_SUPABASE_URL / TEST_SUPABASE_SECRET_KEY required in .env')
}

const sql = postgres(DB_URL, { max: 1, prepare: false, idle_timeout: 5 })

async function admin(path: string, method: string, body?: unknown) {
  const res = await fetch(`${SB_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', apikey: SECRET, Authorization: `Bearer ${SECRET}` },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}

// Every public table EXCEPT schema_migrations (migration history is preserved).
const BUSINESS_TABLES = [
  'account_fund_entries',
  'account_transactions',
  'account_transfers',
  'bank_accounts',
  'financial_years',
  'inventory_items',
  'message_jobs',
  'parties',
  'payment_modes',
  'payments_in',
  'payments_out',
  'proforma_invoice_items',
  'proforma_invoices',
  'proforma_trade_ins',
  'purchase_items',
  'purchases',
  'reminder_settings',
  'sale_items',
  'sales',
  'store',
  'trade_ins',
  'users',
  'whatsapp_settings',
]

async function main() {
  // ── 0. Pre-reset snapshot (to prove the schema survives) ──────────────
  const before = {
    tables: await sql`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'`,
    functions: await sql`SELECT count(*)::int AS n FROM pg_proc WHERE pronamespace = 'public'::regnamespace`,
    policies: await sql`SELECT count(*)::int AS n FROM pg_policies WHERE schemaname = 'public'`,
    triggers: await sql`SELECT count(*)::int AS n FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE NOT t.tgisinternal AND c.relnamespace = 'public'::regnamespace`,
    migrations: await sql`SELECT count(*)::int AS n FROM public.schema_migrations`,
  }
  console.log(
    `before: tables=${before.tables[0].n} functions=${before.functions[0].n} policies=${before.policies[0].n} triggers=${before.triggers[0].n} migrations=${before.migrations[0].n}`,
  )

  // ── 1. Remove ALL auth users (Admin API; public.users cascades) ───────
  const { json: list } = await admin('/auth/v1/admin/users?per_page=1000', 'GET')
  const users: Array<{ id: string; email: string }> = list?.users ?? []
  console.log(`auth users to remove: ${users.length}${users.length ? ` (${users.map((u) => u.email).join(', ')})` : ''}`)
  for (const u of users) {
    const { status } = await admin(`/auth/v1/admin/users/${u.id}`, 'DELETE')
    console.log(`  deleted ${u.email} → ${status}`)
  }

  // ── 2. Wipe application data (business tables), preserving schema ─────
  // CASCADE handles FK ordering; RESTART IDENTITY resets sequences.
  const quoted = BUSINESS_TABLES.map((t) => `public."${t}"`).join(', ')
  await sql.unsafe(`TRUNCATE TABLE ${quoted} RESTART IDENTITY CASCADE`)
  console.log(`truncated ${BUSINESS_TABLES.length} business tables`)

  // Storage objects belonging to app data (buckets/policies survive).
  // Supabase protects storage tables from direct SQL deletes — use the
  // Storage API per object when any exist.
  const objs = await sql`SELECT bucket_id, name FROM storage.objects ORDER BY created_at`
  for (const o of objs) {
    const res = await fetch(`${SB_URL}/storage/v1/object/${o.bucket_id}/${o.name}`, {
      method: 'DELETE',
      headers: { apikey: SECRET, Authorization: `Bearer ${SECRET}` },
    })
    console.log(`  deleted storage object ${o.bucket_id}/${o.name} → ${res.status}`)
  }
  console.log(`deleted ${objs.length} storage objects`)

  // ── 3. Post-reset verification ────────────────────────────────────────
  let failures = 0
  for (const t of BUSINESS_TABLES) {
    const n = await sql.unsafe(`SELECT count(*)::int AS n FROM public."${t}"`)
    if (n[0].n !== 0) {
      failures++
      console.error(`  FAIL  table ${t} not empty: ${n[0].n} rows`)
    }
  }
  const authLeft = await sql`SELECT count(*)::int AS n FROM auth.users`
  if (authLeft[0].n !== 0) {
    failures++
    console.error(`  FAIL  auth.users not empty: ${authLeft[0].n}`)
  }
  const after = {
    tables: await sql`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'`,
    functions: await sql`SELECT count(*)::int AS n FROM pg_proc WHERE pronamespace = 'public'::regnamespace`,
    policies: await sql`SELECT count(*)::int AS n FROM pg_policies WHERE schemaname = 'public'`,
    triggers: await sql`SELECT count(*)::int AS n FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE NOT t.tgisinternal AND c.relnamespace = 'public'::regnamespace`,
    migrations: await sql`SELECT count(*)::int AS n FROM public.schema_migrations`,
  }
  console.log(
    `after:  tables=${after.tables[0].n} functions=${after.functions[0].n} policies=${after.policies[0].n} triggers=${after.triggers[0].n} migrations=${after.migrations[0].n}`,
  )
  const same =
    before.tables[0].n === after.tables[0].n &&
    before.functions[0].n === after.functions[0].n &&
    before.policies[0].n === after.policies[0].n &&
    before.triggers[0].n === after.triggers[0].n &&
    before.migrations[0].n === after.migrations[0].n
  if (!same) {
    failures++
    console.error('  FAIL  schema object counts changed')
  }
  const buckets = await sql`SELECT count(*)::int AS n FROM storage.buckets`
  if (buckets[0].n < 2) {
    failures++
    console.error(`  FAIL  storage buckets missing (${buckets[0].n})`)
  }

  console.log(failures === 0 ? '\nRESET OK — TEST environment is a fresh installation (schema preserved).' : `\nRESET FAILED (${failures} problems)`)
  await sql.end()
  if (failures !== 0) process.exit(1)
}

main().catch(async (e) => {
  console.error(e)
  try {
    await sql.end()
  } catch {}
  process.exit(1)
})
