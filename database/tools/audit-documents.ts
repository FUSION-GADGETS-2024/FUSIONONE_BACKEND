/**
 * FUSIONONE — Documents / file-storage current-state audit (READ-ONLY).
 *
 * Inspects the LIVE TEST database only (safety abort otherwise):
 *   - trade_ins.document_url population + URL/path patterns
 *   - storage.buckets + storage.objects for 'documents' and 'store_assets'
 *   - orphan analysis both directions (object without a trade_ins reference,
 *     trade_ins reference without a backing object)
 *   - live storage RLS policies + trade_ins policies
 *   - public tables inventory (any document-related entity)
 *
 * SELECT-only: no writes, no deletes, no migrations.
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

// ── 1. Trade-in document population ─────────────────────────────────────────
const tiStats = await sql`
  SELECT count(*)::int AS total,
         count(document_url)::int AS with_doc,
         count(*) FILTER (WHERE document_url = '')::int AS empty_string_doc
    FROM public.trade_ins`
console.log('TRADE_INS stats:', JSON.stringify(tiStats[0]))

const docUrls = await sql`
  SELECT document_url FROM public.trade_ins WHERE document_url IS NOT NULL ORDER BY id`
console.log('document_url values:')
for (const r of docUrls) console.log('  ', r.document_url)

// ── 2. Buckets + objects ────────────────────────────────────────────────────
const buckets = await sql`SELECT id, name, public, file_size_limit, allowed_mime_types FROM storage.buckets ORDER BY name`
console.log('BUCKETS:', JSON.stringify(buckets))

const docObjects = await sql`
  SELECT name, created_at, metadata->>'size' AS size, metadata->>'mimetype' AS mimetype
    FROM storage.objects WHERE bucket_id = 'documents' ORDER BY created_at`
console.log(`DOCUMENTS bucket objects: ${docObjects.length}`)
for (const o of docObjects) console.log('  ', JSON.stringify(o))

const assetObjects = await sql`
  SELECT name, created_at, metadata->>'size' AS size, metadata->>'mimetype' AS mimetype
    FROM storage.objects WHERE bucket_id = 'store_assets' ORDER BY created_at`
console.log(`STORE_ASSETS bucket objects: ${assetObjects.length}`)
for (const o of assetObjects) console.log('  ', JSON.stringify(o))

const otherBuckets = await sql`
  SELECT bucket_id, count(*)::int AS n FROM storage.objects
   WHERE bucket_id NOT IN ('documents','store_assets') GROUP BY bucket_id`
console.log('OTHER bucket objects:', JSON.stringify(otherBuckets))

// ── 3. Orphan analysis (both directions) ────────────────────────────────────
const orphans = await sql`
  SELECT o.name, o.created_at
    FROM storage.objects o
   WHERE o.bucket_id = 'documents'
     AND NOT EXISTS (
       SELECT 1 FROM public.trade_ins t
        WHERE t.document_url LIKE '%' || o.name
     )
   ORDER BY o.created_at`
console.log(`ORPHANED objects (no trade_ins reference): ${orphans.length}`)
for (const o of orphans) console.log('  ', JSON.stringify(o))

const dangling = await sql`
  SELECT t.id, t.document_url
    FROM public.trade_ins t
   WHERE t.document_url IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM storage.objects o
        WHERE o.bucket_id = 'documents' AND t.document_url LIKE '%' || o.name
     )`
console.log(`DANGLING references (no backing object): ${dangling.length}`)
for (const d of dangling) console.log('  ', JSON.stringify(d))

// ── 4. Live storage policies ────────────────────────────────────────────────
const storagePolicies = await sql`
  SELECT policyname, cmd, roles, qual, with_check
    FROM pg_policies WHERE schemaname = 'storage' ORDER BY policyname`
console.log('STORAGE policies (live):')
for (const p of storagePolicies) console.log('  ', JSON.stringify(p))

const tiPolicies = await sql`
  SELECT policyname, cmd, roles
    FROM pg_policies WHERE schemaname = 'public' AND tablename = 'trade_ins'`
console.log('TRADE_INS policies (live):', JSON.stringify(tiPolicies))

// ── 5. Public tables inventory (document-related entity check) ─────────────
const tables = await sql`
  SELECT table_name FROM information_schema.tables
   WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`
console.log('PUBLIC tables:', tables.map((t: any) => t.table_name).join(', '))

// Any column mentioning document anywhere in public schema
const docColumns = await sql`
  SELECT table_name, column_name, data_type
    FROM information_schema.columns
   WHERE table_schema = 'public' AND (column_name ILIKE '%document%' OR column_name ILIKE '%file%' OR column_name ILIKE '%attachment%')
   ORDER BY table_name`
console.log('DOCUMENT-ish columns in public schema:', JSON.stringify(docColumns))

// ── 6. Duplicate-upload evidence: same trade-in device re-uploaded? ─────────
// The generated names carry timestamps, so identical content is not provable
// from names alone — report object count vs referenced count instead.
console.log(`SUMMARY: objects=${docObjects.length}, referenced=${docUrls.length}, orphans=${orphans.length}, dangling=${dangling.length}`)

await sql.end()
console.log('READ-ONLY audit complete. No data modified.')
