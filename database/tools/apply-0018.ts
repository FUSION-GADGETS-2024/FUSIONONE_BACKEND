/**
 * FUSIONONE — Apply migration 0018 (remove the trade-in document
 * relationship) to the LIVE TEST project and verify the resulting state:
 *
 *   1. Safety abort unless connected to the TEST project.
 *   2. Baseline row counts (untouched business data) + message_jobs = 0.
 *   3. Apply database/migrations/0018_remove_trade_in_document.sql.
 *   4. Register '0018_remove_trade_in_document.sql' in schema_migrations
 *      (repo filename — same convention as apply-0016/apply-0017).
 *   5. Verify: trade_ins has NO document column (neither document_id nor
 *      document_url), no FK/index remains, create_sale / cancel_sale no
 *      longer reference any document, party_documents remains intact.
 *   6. Confirm business row counts + message_jobs are unchanged.
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

async function count(table: string): Promise<number> {
  const r = await sql.unsafe(`SELECT count(*)::int AS n FROM public.${table}`)
  return r[0].n
}

const TABLES = ['parties', 'sales', 'purchases', 'inventory_items', 'trade_ins', 'party_documents', 'payments_in', 'payments_out', 'financial_years', 'bank_accounts', 'payment_modes']
const before: Record<string, number> = {}
for (const t of TABLES) before[t] = await count(t)
const mjBefore = await count('message_jobs')
console.log('Baseline counts:', JSON.stringify(before), 'message_jobs:', mjBefore)

// ── Apply ───────────────────────────────────────────────────────────────────
const FILE = '0018_remove_trade_in_document.sql'
const content = readFileSync(join(HERE, '..', 'migrations', FILE), 'utf8')
await sql.unsafe(content)
console.log(`✓ applied ${FILE}`)
const already = await sql`SELECT 1 FROM public.schema_migrations WHERE version = ${FILE}`
if (already.length === 0) {
  await sql`INSERT INTO public.schema_migrations (version) VALUES (${FILE})`
  console.log(`✓ registered ${FILE} in schema_migrations`)
}

// ── Verify structure ────────────────────────────────────────────────────────
let ok = true
const fail = (msg: string) => { ok = false; console.log('✗ ' + msg) }
const pass = (msg: string) => console.log('✓ ' + msg)

const tiCols = await sql`
  SELECT column_name FROM information_schema.columns
   WHERE table_schema='public' AND table_name='trade_ins'`
const tiNames = tiCols.map((c) => c.column_name)
if (!tiNames.includes('document_id') && !tiNames.includes('document_url')) {
  pass(`trade_ins has no document column (columns: ${tiNames.join(', ')})`)
} else {
  fail(`trade_ins still carries a document column: ${tiNames.filter((n) => n.startsWith('document')).join(', ')}`)
}

const tiFk = await sql`
  SELECT tc.constraint_name FROM information_schema.table_constraints tc
   WHERE tc.table_name='trade_ins' AND tc.constraint_type='FOREIGN KEY'`
const docFks = tiFk.filter((c) => c.constraint_name.includes('document'))
if (docFks.length === 0) pass('no document FK remains on trade_ins')
else fail(`document FK remains: ${docFks.map((c) => c.constraint_name).join(', ')}`)

const tiIdx = await sql`SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename='trade_ins'`
const docIdx = tiIdx.filter((i) => i.indexname.includes('document'))
if (docIdx.length === 0) pass('no document index remains on trade_ins')
else fail(`document index remains: ${docIdx.map((i) => i.indexname).join(', ')}`)

// create_sale / cancel_sale must be document-free.
for (const fn of ['create_sale', 'cancel_sale']) {
  const def = await sql`
    SELECT pg_get_functiondef(p.oid) AS def FROM pg_proc p
     WHERE p.pronamespace='public'::regnamespace AND p.proname=${fn}`
  const body = def[0].def
  if (!body.includes('document')) pass(`${fn} contains no document handling`)
  else fail(`${fn} still references documents`)
}

// party_documents remains fully intact.
const pdCols = await sql`
  SELECT column_name FROM information_schema.columns
   WHERE table_schema='public' AND table_name='party_documents' ORDER BY ordinal_position`
const pdNames = pdCols.map((c) => c.column_name)
const expected = ['id', 'party_id', 'file_name', 'mime_type', 'file_size', 'checksum_sha256', 'storage_key',
  'encryption_alg', 'key_version', 'encrypted_dek', 'dek_iv', 'dek_tag', 'file_iv', 'file_tag',
  'status', 'created_at', 'archived_at']
if (JSON.stringify(pdNames) === JSON.stringify(expected)) pass(`party_documents columns intact (${pdNames.length})`)
else fail(`party_documents columns mismatch: ${pdNames.join(',')}`)

const pol = await sql`SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename='party_documents'`
if (pol.length === 1 && pol[0].policyname === 'app_user_access') pass('party_documents RLS policy intact')
else fail('party_documents RLS policy mismatch: ' + JSON.stringify(pol))

// Both RPCs still resolve on the final schema.
for (const fn of ['create_sale', 'cancel_sale']) {
  const exists = await sql`
    SELECT 1 FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname=${fn}`
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
