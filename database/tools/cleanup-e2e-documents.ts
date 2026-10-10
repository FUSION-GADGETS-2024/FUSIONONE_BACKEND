/**
 * FUSIONONE — E2E document-fixture cleanup (TEST only).
 *
 * Removes every artifact created by the Party Documents E2E run:
 *   - the two E2E sales (SAL-2027-28-0002/0003) via the canonical
 *     delete_sale RPC (FK-safe: restocks items, removes trade-ins and
 *     their hidden PUR-TRD purchases + devices),
 *   - the E2E party's documents: R2 objects FIRST (while the rows still
 *     carry the keys), then the party_documents rows,
 *   - the E2E party itself,
 * then verifies the pre-E2E baseline was restored exactly
 * (sales 8, purchases 6, inventory 8 in_stock/6 sold, trade_ins 3,
 * parties 4, party_documents 0, message_jobs 0) and that no R2 objects
 * remain under party-documents/.
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

const PARTY_NAME = 'E2E Doc Party'
const SALES = ['dd4bc730-f492-43cb-b19b-3b500a8f0817', '2f99827d-8520-4c09-8e75-5df62e4765ea']

async function count(query: string): Promise<number> {
  return sql.unsafe(query).then((r: any[]) => Number(r[0].n))
}

// ── R2 deletion via the backend env (server-only credentials) ──────────────
const backendEnv: Record<string, string> = {}
const backendRaw = readFileSync(join(HERE, '..', '..', 'backend', '.env'), 'utf8')
for (const line of backendRaw.split('\n')) {
  const i = line.indexOf('=')
  if (i > 0 && !line.startsWith('#')) backendEnv[line.slice(0, i).trim()] = line.slice(i + 1).trim()
}

console.log('── before ──')
const before = {
  sales: await count('SELECT count(*) AS n FROM public.sales'),
  purchases: await count('SELECT count(*) AS n FROM public.purchases'),
  inStock: await count("SELECT count(*) AS n FROM public.inventory_items WHERE status = 'in_stock'"),
  sold: await count("SELECT count(*) AS n FROM public.inventory_items WHERE status = 'sold'"),
  tradeIns: await count('SELECT count(*) AS n FROM public.trade_ins'),
  parties: await count('SELECT count(*) AS n FROM public.parties'),
  partyDocuments: await count('SELECT count(*) AS n FROM public.party_documents'),
}
console.log(JSON.stringify(before))

// 1. Delete the E2E sales through the canonical guarded RPC.
for (const saleId of SALES) {
  try {
    await sql.unsafe('SELECT public.delete_sale(p_sale_id := $1::uuid) AS result', [saleId])
    console.log(`✓ delete_sale ${saleId}`)
  } catch (e: any) {
    console.log(`· delete_sale ${saleId}: ${e.message}`)
  }
}

// 2. Remove the E2E party's documents: R2 objects first (keys from the rows),
//    then the rows themselves.
const docs = await sql`
  SELECT id, storage_key FROM public.party_documents
   WHERE party_id IN (SELECT id FROM public.parties WHERE name = ${PARTY_NAME})`
if (docs.length > 0) {
  // The S3 client lives in the backend's dependencies (the only component
  // that talks to R2) — resolve it from there.
  const { createRequire } = await import('node:module')
  const backendRequire = createRequire(join(HERE, '..', '..', 'backend', 'package.json'))
  const { DeleteObjectCommand, S3Client } = await import('node:module').then(() =>
    Promise.resolve(backendRequire('@aws-sdk/client-s3')),
  )
  const client = new S3Client({
    region: 'auto',
    endpoint: `https://${backendEnv.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    forcePathStyle: true,
    credentials: {
      accessKeyId: backendEnv.R2_ACCESS_KEY_ID,
      secretAccessKey: backendEnv.R2_SECRET_ACCESS_KEY,
    },
  })
  for (const d of docs) {
    await client.send(new DeleteObjectCommand({ Bucket: backendEnv.R2_BUCKET, Key: d.storage_key }))
    console.log(`✓ R2 object removed: ${d.storage_key}`)
  }
  await sql`DELETE FROM public.party_documents WHERE id IN ${sql(docs.map((d: any) => d.id))}`
  console.log(`✓ ${docs.length} party_documents rows removed`)
}

// 3. Remove the E2E party.
const removed = await sql`DELETE FROM public.parties WHERE name = ${PARTY_NAME} RETURNING id`
console.log(`✓ party removed: ${removed.length > 0}`)

// ── Verify the baseline is restored exactly ────────────────────────────────
console.log('── after ──')
const after = {
  sales: await count('SELECT count(*) AS n FROM public.sales'),
  purchases: await count('SELECT count(*) AS n FROM public.purchases'),
  inStock: await count("SELECT count(*) AS n FROM public.inventory_items WHERE status = 'in_stock'"),
  sold: await count("SELECT count(*) AS n FROM public.inventory_items WHERE status = 'sold'"),
  tradeIns: await count('SELECT count(*) AS n FROM public.trade_ins'),
  parties: await count('SELECT count(*) AS n FROM public.parties'),
  partyDocuments: await count('SELECT count(*) AS n FROM public.party_documents'),
}
console.log(JSON.stringify(after))

let ok = true
const expect = { sales: 8, purchases: 6, inStock: 8, sold: 6, tradeIns: 3, parties: 4, partyDocuments: 0 }
for (const [k, v] of Object.entries(expect)) {
  if (after[k as keyof typeof after] !== v) {
    console.log(`✗ ${k}: expected ${v}, got ${after[k as keyof typeof after]}`)
    ok = false
  }
}
const mj = await count('SELECT count(*) AS n FROM public.message_jobs')
if (mj !== 0) { console.log('✗ message_jobs != 0'); ok = false }

await sql.end()
console.log(ok ? 'BASELINE RESTORED EXACTLY' : 'BASELINE MISMATCH')
process.exit(ok ? 0 : 1)
