// Read-only final-state verification against TEST (no writes).
import postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(join(HERE, '.env'), 'utf8');
const env: Record<string, string> = {};
for (const line of raw.split('\n')) {
  const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const TEST_URL = env['TEST_SUPABASE_DB_URL'];
if (!TEST_URL || !TEST_URL.includes('egdrnhtmclvhsfjvhyam')) {
  console.error('SAFETY ABORT: not the TEST project URL');
  process.exit(1);
}
const sql = postgres(TEST_URL, { ssl: 'require', max: 1 });

const fail = (m: string) => { console.error('FAIL:', m); process.exitCode = 1; };

async function main() {
  // 1. Schema state
  const cols = await sql<{ column_name: string }>`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema='public' AND table_name='trade_ins' ORDER BY ordinal_position`;
  const colNames = cols.map(c => c.column_name);
  console.log('trade_ins columns:', colNames.join(', '));
  if (!colNames.includes('document_id')) fail('trade_ins.document_id missing');
  if (colNames.includes('document_url')) fail('trade_ins.document_url STILL PRESENT (0017 not applied)');

  const tbl = await sql<{ table_name: string }>`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema='public' AND table_name='party_documents'`;
  console.log('party_documents table exists:', tbl.length === 1);
  if (tbl.length !== 1) fail('party_documents missing');

  // 2. Data state (baseline restoration check)
  const counts = await sql<{ table: string; n: string }>`
    SELECT 'party_documents' AS table, count(*)::text AS n FROM public.party_documents
    UNION ALL SELECT 'trade_ins', count(*)::text FROM public.trade_ins
    UNION ALL SELECT 'sales', count(*)::text FROM public.sales
    UNION ALL SELECT 'purchases', count(*)::text FROM public.purchases
    UNION ALL SELECT 'proforma_invoices', count(*)::text FROM public.proforma_invoices
    UNION ALL SELECT 'message_jobs', count(*)::text FROM public.message_jobs`;
  for (const r of counts) console.log(`${r.table}: ${r.n}`);
  const pd = Number(counts.find(c => c.table === 'party_documents')?.n);
  if (pd !== 0) console.log(`NOTE: ${pd} party_documents rows remain (E2E cleanup expected 0)`);

  const mj = Number(counts.find(c => c.table === 'message_jobs')?.n);
  if (mj !== 0) fail(`WhatsApp safety: message_jobs = ${mj} (must be 0)`);

  // 3. Storage policies / bucket state
  const policies = await sql<{ policyname: string }>`
    SELECT policyname FROM pg_policies WHERE schemaname='storage' AND tablename='objects' ORDER BY policyname`;
  console.log('storage.objects policies:', policies.map(p => p.policyname).join(', ') || '(none)');
  const docPolicies = policies.filter(p => p.policyname.startsWith('documents_'));
  if (docPolicies.length > 0) fail(`legacy documents_ policies remain: ${docPolicies.map(p=>p.policyname).join(', ')}`);

  const buckets = await sql<{ id: string; name: string; public: boolean }>`
    SELECT id, name, public FROM storage.buckets ORDER BY name`;
  console.log('buckets:', buckets.map(b => `${b.name}(public=${b.public})`).join(', '));

  // 4. Objects in documents bucket (should be 0 / bucket gone)
  for (const b of buckets) {
    const objs = await sql<{ n: string }>`SELECT count(*)::text AS n FROM storage.objects WHERE bucket_id = ${b.id}`;
    console.log(`  ${b.name}: ${objs[0].n} objects`);
  }

  // 5. create_sale signature sanity: document check present
  const fn = await sql<{ prosrc: string }>`
    SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname='create_sale'`;
  const hasDocId = fn.length === 1 && fn[0].prosrc.includes('document does not belong to this party');
  console.log('create_sale enforces party-ownership invariant:', hasDocId);
  if (!hasDocId) fail('create_sale document invariant missing');
  const hasDocUrl = fn.length === 1 && fn[0].prosrc.includes('document_url');
  if (hasDocUrl) fail('create_sale still references document_url');

  console.log('DONE');
  await sql.end();
}
main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
