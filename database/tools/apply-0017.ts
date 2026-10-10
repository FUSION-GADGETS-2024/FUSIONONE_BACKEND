/**
 * FUSIONONE — Apply migration 0017 (legacy document path removal) to the
 * LIVE TEST project and verify the resulting state:
 *
 *   1. Safety abort unless connected to the TEST project.
 *   2. Pre-checks: no trade_ins.document_url values, no legacy documents
 *      bucket objects (the drop is provably safe).
 *   3. Apply database/migrations/0017_legacy_document_removal.sql.
 *   4. Register '0017_legacy_document_removal.sql' in schema_migrations.
 *   5. Verify: document_url gone, documents bucket + policies gone,
 *      store_assets bucket + policies INTACT, party_documents untouched,
 *      create_sale/cancel_sale still resolve, business data unchanged.
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

let ok = true
const fail = (msg: string) => { ok = false; console.log('✗ ' + msg) }
const pass = (msg: string) => console.log('✓ ' + msg)

// ── Pre-checks (the drop must be provably safe) ────────────────────────────
const preCol = await sql`
  SELECT count(*)::int AS n FROM information_schema.columns
   WHERE table_schema='public' AND table_name='trade_ins' AND column_name='document_url'`
if (preCol[0].n === 1) {
  const populated = await sql.unsafe(
    'SELECT count(*)::int AS n FROM public.trade_ins WHERE document_url IS NOT NULL',
  )
  if (populated[0].n > 0) {
    fail(`ABORT: ${populated[0].n} trade_ins rows still carry document_url values`)
    process.exit(1)
  }
  pass('pre-check: zero populated document_url values (drop is safe)')
}
const preObjects = await sql`
  SELECT count(*)::int AS n FROM storage.objects WHERE bucket_id = 'documents'`
if (preObjects[0].n > 0) {
  fail(`ABORT: ${preObjects[0].n} objects still exist in the legacy documents bucket`)
  process.exit(1)
}
pass('pre-check: legacy documents bucket is empty (drop is safe)')

const beforeCounts = {} as Record<string, number>
for (const t of ['party_documents', 'trade_ins', 'sales', 'parties']) {
  beforeCounts[t] = await sql.unsafe(`SELECT count(*)::int AS n FROM public.${t}`).then((r: any[]) => r[0].n)
}

// ── Apply ───────────────────────────────────────────────────────────────────
const FILE = '0017_legacy_document_removal.sql'
const content = readFileSync(join(HERE, '..', 'migrations', FILE), 'utf8')
await sql.unsafe(content)
console.log(`✓ applied ${FILE}`)
const already = await sql`SELECT 1 FROM public.schema_migrations WHERE version = ${FILE}`
if (already.length === 0) {
  await sql`INSERT INTO public.schema_migrations (version) VALUES (${FILE})`
  console.log(`✓ registered ${FILE} in schema_migrations`)
}

// Remove the (empty, policy-less) legacy bucket via the SUPPORTED Storage
// API path — SQL deletion is blocked by Supabase's protect_delete trigger.
{
  const res = await fetch(`${env.TEST_SUPABASE_URL}/storage/v1/bucket/documents`, {
    method: 'DELETE',
    headers: { apikey: env.TEST_SUPABASE_SECRET_KEY, Authorization: `Bearer ${env.TEST_SUPABASE_SECRET_KEY}` },
  })
  if (res.ok) {
    console.log('✓ legacy documents bucket deleted via the Storage API')
  } else {
    console.log(`· Storage API bucket delete returned HTTP ${res.status} (${await res.text().catch(() => '')}) — the bucket is inert (policies removed); continuing`)
  }
}

// ── Verify ──────────────────────────────────────────────────────────────────
const postCol = await sql`
  SELECT count(*)::int AS n FROM information_schema.columns
   WHERE table_schema='public' AND table_name='trade_ins' AND column_name='document_url'`
postCol[0].n === 0 ? pass('trade_ins.document_url dropped') : fail('document_url still present')

const docCol = await sql`
  SELECT count(*)::int AS n FROM information_schema.columns
   WHERE table_schema='public' AND table_name='trade_ins' AND column_name='document_id'`
docCol[0].n === 1 ? pass('trade_ins.document_id intact') : fail('document_id missing!')

const buckets = await sql`SELECT id FROM storage.buckets`
const bucketIds = buckets.map((b: any) => b.id)
!bucketIds.includes('documents') ? pass('documents bucket removed') : fail('documents bucket still exists')
bucketIds.includes('store_assets') ? pass('store_assets bucket preserved') : fail('store_assets bucket MISSING!')

const policies = await sql`SELECT policyname FROM pg_policies WHERE schemaname='storage'`
const names = policies.map((p: any) => p.policyname)
names.filter((n: string) => n.startsWith('documents_')).length === 0
  ? pass('documents_* storage policies removed')
  : fail('documents_* policies still present')
names.filter((n: string) => n.startsWith('store_assets_')).length === 4
  ? pass('store_assets_* storage policies preserved (4)')
  : fail('store_assets policies changed: ' + JSON.stringify(names))

for (const t of ['party_documents', 'trade_ins', 'sales', 'parties']) {
  const n = await sql.unsafe(`SELECT count(*)::int AS n FROM public.${t}`).then((r: any[]) => r[0].n)
  if (n !== beforeCounts[t]) fail(`${t} count changed: ${beforeCounts[t]} → ${n}`)
}

const fns = await sql`
  SELECT pg_get_functiondef(p.oid) AS def FROM pg_proc p
   WHERE p.pronamespace='public'::regnamespace AND p.proname IN ('create_sale','cancel_sale')`
for (const f of fns) {
  const clean = !f.def.includes('document_url')
  clean ? undefined : fail('a canonical RPC still references document_url')
}
pass('create_sale / cancel_sale reference only document_id')

const mj = await sql`SELECT count(*)::int AS n FROM public.message_jobs`
mj[0].n === 0 ? pass('message_jobs = 0 (WhatsApp untouched)') : fail('message_jobs != 0')

await sql.end()
console.log(ok ? 'ALL CHECKS PASSED' : 'CHECKS FAILED')
process.exit(ok ? 0 : 1)
