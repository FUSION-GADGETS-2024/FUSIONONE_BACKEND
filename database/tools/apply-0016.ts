/**
 * FUSIONONE — Apply migration 0016 (party_documents foundation) to the LIVE
 * TEST project and verify the resulting state:
 *
 *   1. Safety abort unless connected to the TEST project.
 *   2. Baseline row counts (untouched business data) + message_jobs = 0.
 *   3. Apply database/migrations/0016_party_documents.sql.
 *   4. Register '0016_party_documents.sql' in schema_migrations (repo
 *      filename — the live history carries the pre-reconstruction names,
 *      so the generic runner cannot be used; same convention as
 *      apply-0014-0015.ts).
 *   5. Verify: party_documents table/columns/index/RLS policy, the
 *      trade_ins.document_id column + FK + index, and that create_sale /
 *      cancel_sale now reference document_id (party-ownership invariant).
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

const TABLES = ['parties', 'sales', 'purchases', 'inventory_items', 'trade_ins', 'payments_in', 'payments_out', 'financial_years', 'bank_accounts', 'payment_modes']
const before: Record<string, number> = {}
for (const t of TABLES) before[t] = await count(t)
const mjBefore = await count('message_jobs')
console.log('Baseline counts:', JSON.stringify(before), 'message_jobs:', mjBefore)

// ── Apply ───────────────────────────────────────────────────────────────────
const FILE = '0016_party_documents.sql'
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

const cols = await sql`
  SELECT column_name, data_type FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'party_documents' ORDER BY ordinal_position`
const colNames = cols.map((c) => c.column_name)
const expected = ['id', 'party_id', 'file_name', 'mime_type', 'file_size', 'checksum_sha256', 'storage_key',
  'encryption_alg', 'key_version', 'encrypted_dek', 'dek_iv', 'dek_tag', 'file_iv', 'file_tag',
  'status', 'created_at', 'archived_at']
if (JSON.stringify(colNames) === JSON.stringify(expected)) pass(`party_documents columns (${colNames.length})`)
else fail(`party_documents columns mismatch: ${colNames.join(',')}`)

const idx = await sql`SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename='party_documents'`
if (idx.some((i) => i.indexname === 'idx_party_documents_party')) pass('idx_party_documents_party')
else fail('idx_party_documents_party missing')

const pol = await sql`SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename='party_documents'`
if (pol.length === 1 && pol[0].policyname === 'app_user_access') pass('RLS policy app_user_access')
else fail('RLS policy mismatch: ' + JSON.stringify(pol))

const rls = await sql`SELECT relrowsecurity FROM pg_class WHERE oid = 'public.party_documents'::regclass`
if (rls[0].relrowsecurity === true) pass('RLS enabled')
else fail('RLS not enabled')

const tiCol = await sql`
  SELECT column_name, data_type FROM information_schema.columns
   WHERE table_schema='public' AND table_name='trade_ins' AND column_name IN ('document_id','document_url')`
const tiDocId = tiCol.find((c) => c.column_name === 'document_id')
if (tiDocId && tiDocId.data_type === 'uuid') pass('trade_ins.document_id uuid')
else fail('trade_ins.document_id missing/wrong type')
if (tiCol.some((c) => c.column_name === 'document_url')) pass('trade_ins.document_url still present (dropped by 0017 after verification)')
else console.log('· trade_ins.document_url absent (already dropped)')

const fk = await sql`
  SELECT tc.constraint_type, kcu.column_name, ccu.table_name AS references_table
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
    JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name
   WHERE tc.table_name='trade_ins' AND kcu.column_name='document_id'`
if (fk.length > 0 && fk[0].references_table === 'party_documents') pass('trade_ins.document_id → party_documents FK')
else fail('document_id FK missing')

const tiIdx = await sql`SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename='trade_ins' AND indexname='idx_trade_ins_document'`
if (tiIdx.length === 1) pass('idx_trade_ins_document')
else fail('idx_trade_ins_document missing')

// ── Verify functions now carry the document_id contract ─────────────────────
for (const fn of ['create_sale', 'cancel_sale']) {
  const def = await sql`
    SELECT pg_get_functiondef(p.oid) AS def FROM pg_proc p
     WHERE p.pronamespace='public'::regnamespace AND p.proname=${fn}`
  const body = def[0].def
  if (body.includes('document_id') && !body.includes('document_url')) pass(`${fn} uses document_id (no document_url)`)
  else fail(`${fn} does not use document_id correctly`)
}

// ── Business data untouched ─────────────────────────────────────────────────
for (const t of TABLES) {
  const n = await count(t)
  if (n !== before[t]) fail(`${t} count changed: ${before[t]} → ${n}`)
}
const mjAfter = await count('message_jobs')
if (mjAfter === mjBefore && mjAfter === 0) pass('message_jobs = 0 (WhatsApp untouched)')
else fail('message_jobs changed')

const pdCount = await count('party_documents')
console.log('party_documents rows:', pdCount)

await sql.end()
console.log(ok ? 'ALL CHECKS PASSED' : 'CHECKS FAILED')
process.exit(ok ? 0 : 1)
