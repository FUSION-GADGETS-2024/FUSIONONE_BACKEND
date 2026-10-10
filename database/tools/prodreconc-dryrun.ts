/**
 * FUSIONONE — PRODUCTION SCHEMA RECONCILIATION: DRY RUN of migration 0019
 * against the LIVE production database inside ONE always-rolled-back
 * transaction (the discipline used by the 0012/0013 promotion).
 *
 *   1. Safety abort unless connected to the production project.
 *   2. Capture the pre-state: body fingerprints of the two replaced functions,
 *      schema_migrations list, business row counts.
 *   3. BEGIN → apply the exact 0019 file content → verify IN-TRANSACTION:
 *      clamp logic present, grants posture, both RPCs resolve, bookkeeping
 *      row NOT yet inserted (the runner inserts it separately).
 *   4. Behavioral probe with zero residue: call
 *      create_trade_in_purchase_bill with a nonexistent sale id and expect
 *      the documented 'Sale not found' rejection (side-effect free).
 *   5. ROLLBACK — always.
 *   6. Prove ZERO RESIDUE: post-rollback body fingerprints, migrations list,
 *      and row counts are byte-identical to the pre-state.
 *
 * Usage:
 *   FUSIONONE_DB_URL='postgresql://postgres.<ref>:<pw>@<pooler>:5432/postgres' \
 *     bun run prodreconc-dryrun.ts
 */
import postgres from 'postgres'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROD_REF = 'jzdnesudczqksghosmmx'

const DB_URL = process.env.FUSIONONE_DB_URL
if (!DB_URL?.includes(PROD_REF)) throw new Error('SAFETY ABORT: FUSIONONE_DB_URL is not the production project.')

const sql = postgres(DB_URL, { ssl: { rejectUnauthorized: false }, max: 1, prepare: false, idle_timeout: 5 })

const CLAMP = 'GREATEST(fy.start_date, LEAST(current_date'
const FILE = '0019_recovery_and_reversal_date_invariant.sql'
const CONTENT = readFileSync(join(HERE, '..', 'migrations', FILE), 'utf8')

const TABLES = ['parties', 'sales', 'purchases', 'inventory_items', 'trade_ins', 'payments_in', 'payments_out', 'account_transactions', 'message_jobs', 'financial_years']

let ok = true
const pass = (m: string) => console.log('✓ ' + m)
const fail = (m: string) => { ok = false; console.log('✗ ' + m) }

async function fnBodyHashes(): Promise<Record<string, string>> {
  const rows = await sql`
    select p.proname as n, md5(p.prosrc) as h
      from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and p.proname in ('create_trade_in_purchase_bill', 'cancel_sale')`
  return Object.fromEntries(rows.map((r: { n: string; h: string }) => [r.n, r.h]))
}

async function counts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  for (const t of TABLES) out[t] = (await sql.unsafe(`select count(*)::int as n from public.${t}`))[0].n
  return out
}

const preHashes = await fnBodyHashes()
const preMigrations = (await sql`select version from public.schema_migrations order by version`).map((r: { version: string }) => r.version)
const preCounts = await counts()
console.log('Pre-state: migrations = ' + preMigrations.length + ', bodies = ' + JSON.stringify(preHashes))
if (preMigrations.includes(FILE)) throw new Error('SAFETY ABORT: 0019 already recorded — dry run assumes it is NOT applied.')

// ── The dry-run transaction ──────────────────────────────────────────────────
await sql.unsafe('BEGIN')
console.log('→ BEGIN (dry-run transaction on production)')

try {
  await sql.unsafe(CONTENT)
  pass(`applied ${FILE} inside the transaction (NOT committed)`)

  // In-transaction verification
  for (const fn of ['create_trade_in_purchase_bill', 'cancel_sale']) {
    const body = (await sql`
      select p.prosrc as b from pg_proc p
       where p.pronamespace='public'::regnamespace and p.proname=${fn}`)[0].b as string
    if (body.includes(CLAMP)) pass(`${fn}: clamp logic present in-transaction`)
    else fail(`${fn}: clamp logic MISSING in-transaction`)
  }
  const SIGS: Record<string, string> = {
    create_trade_in_purchase_bill: 'public.create_trade_in_purchase_bill(uuid, uuid)',
    cancel_sale: 'public.cancel_sale(uuid)',
  }
  for (const [fn, sig] of Object.entries(SIGS)) {
    const a = (await sql`
      select has_function_privilege('public', ${sig}, 'EXECUTE') as pub,
             has_function_privilege('authenticated', ${sig}, 'EXECUTE') as auth,
             has_function_privilege('service_role', ${sig}, 'EXECUTE') as svc`)[0]
    if (!a.pub && a.auth && a.svc) pass(`${fn}: grants posture correct in-transaction (anon denied, authenticated + service_role allowed)`)
    else fail(`${fn}: grants posture UNEXPECTED in-transaction: ${JSON.stringify(a)}`)
  }
  const bk = (await sql`select count(*)::int as n from public.schema_migrations where version = ${FILE}`)[0].n
  if (bk === 0) pass('bookkeeping row not inserted by the file itself (runner inserts it after commit — as designed)')
  else fail('bookkeeping row unexpectedly inserted inside the transaction')

  // Zero-residue behavioral probe: nonexistent sale → documented rejection,
  // no rows written (the function raises BEFORE any write).
  try {
    await sql.unsafe("select public.create_trade_in_purchase_bill('00000000-0000-0000-0000-000000000000'::uuid, '00000000-0000-0000-0000-000000000000'::uuid)")
    fail('probe: expected the documented Sale-not-found rejection, got success')
  } catch (e) {
    const msg = String((e as Error).message ?? e)
    if (msg.includes('Sale not found')) pass('probe: replaced RPC executes and rejects a nonexistent sale exactly as documented (side-effect free)')
    else fail('probe: unexpected error: ' + msg.slice(0, 200))
  }
} finally {
  await sql.unsafe('ROLLBACK')
  console.log('→ ROLLBACK (always — nothing committed)')
}

// ── Zero-residue proof ───────────────────────────────────────────────────────
const postHashes = await fnBodyHashes()
const postMigrations = (await sql`select version from public.schema_migrations order by version`).map((r: { version: string }) => r.version)
const postCounts = await counts()

const sameHashes = JSON.stringify(preHashes) === JSON.stringify(postHashes)
if (sameHashes) pass('function bodies byte-identical to pre-state after rollback')
else fail(`function bodies CHANGED after rollback: ${JSON.stringify({ pre: preHashes, post: postHashes })}`)
if (JSON.stringify(preMigrations) === JSON.stringify(postMigrations)) pass('schema_migrations unchanged after rollback')
else fail('schema_migrations changed after rollback')
if (JSON.stringify(preCounts) === JSON.stringify(postCounts)) pass(`all ${TABLES.length} business row counts unchanged after rollback`)
else fail('row counts changed after rollback: ' + JSON.stringify({ pre: preCounts, post: postCounts }))

await sql.end()
console.log(ok ? 'DRY RUN PASSED — zero residue, safe to execute for real' : 'DRY RUN FAILED')
process.exit(ok ? 0 : 1)
