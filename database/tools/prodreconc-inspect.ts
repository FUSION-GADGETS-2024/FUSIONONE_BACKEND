/**
 * FUSIONONE — PRODUCTION SCHEMA RECONCILIATION: read-only inventory inspector.
 *
 * STRICTLY READ-ONLY: every statement below is a SELECT against catalogs or
 * application tables. Nothing is written to the target database.
 *
 * Captures a machine-readable inventory (JSON) for structural comparison
 * (TEST reference vs production) and for pre/post-migration data-preservation
 * verification:
 *   - identity anchors (server version, migration bookkeeping)
 *   - tables + RLS flags + row counts + full column listings
 *   - indexes, constraints, triggers, policies (public + storage)
 *   - all public/private function signatures + body fingerprints (md5)
 *   - raw ACLs (tables + functions) — the exact grant posture
 *   - event triggers, extensions, storage buckets + object counts
 *   - auth.users anchors (count + id fingerprint, no personal data)
 *   - per-table DATA fingerprints (md5 over ordered row hashes) + financial
 *     totals + FY counters — the data-preservation baseline
 *
 * Usage:
 *   FUSIONONE_DB_URL='postgresql://postgres.<ref>:<pw>@<pooler>:5432/postgres' \
 *     bun run prodreconc-inspect.ts --expect-prod --label pre
 *   (TEST reference: bun run prodreconc-inspect.ts --expect-test --label testref
 *    — uses TEST_SUPABASE_DB_URL from .env when FUSIONONE_DB_URL is unset)
 *
 * Output: /home/z/prodreconc/inspection/<label>.json (OUTSIDE the repo).
 */
import postgres from 'postgres'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

function loadEnv(): Record<string, string> {
  const p = join(HERE, '.env')
  if (!existsSync(p)) return {}
  const raw = readFileSync(p, 'utf8')
  return Object.fromEntries(
    raw.split('\n').filter((l: string) => l.includes('=') && !l.startsWith('#')).map((l: string) => {
      const i = l.indexOf('=')
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
    }),
  )
}

const PROD_REF = 'jzdnesudczqksghosmmx'
const TEST_REF = 'egdrnhtmclvhsfjvhyam'

const args = process.argv.slice(2)
const expectProd = args.includes('--expect-prod')
const expectTest = args.includes('--expect-test')
const LOCAL = args.includes('--local') // local restore-drill DB (no SSL, no ref assertion)
const labelIdx = args.indexOf('--label')
const LABEL = labelIdx >= 0 ? args[labelIdx + 1] : 'unnamed'

const env = loadEnv()
const DB_URL = process.env.FUSIONONE_DB_URL || env.TEST_SUPABASE_DB_URL
if (!DB_URL) throw new Error('Set FUSIONONE_DB_URL (or TEST_SUPABASE_DB_URL in database/tools/.env)')

if (!LOCAL) {
  if (expectProd && !DB_URL.includes(PROD_REF)) {
    throw new Error(`SAFETY ABORT: --expect-prod but the URL does not contain the production ref ${PROD_REF}.`)
  }
  if (expectTest && !DB_URL.includes(TEST_REF)) {
    throw new Error(`SAFETY ABORT: --expect-test but the URL does not contain the TEST ref ${TEST_REF}.`)
  }
  if (DB_URL.includes(PROD_REF) && DB_URL.includes(TEST_REF)) {
    throw new Error('SAFETY ABORT: URL ambiguously matches both project refs.')
  }
}

const sql = LOCAL
  ? postgres(DB_URL, { max: 1, prepare: false, idle_timeout: 5 })
  : postgres(DB_URL, { ssl: { rejectUnauthorized: false }, max: 1, prepare: false, idle_timeout: 5 })

const OUT_DIR = '/home/z/prodreconc/inspection'
mkdirSync(OUT_DIR, { recursive: true })

async function main() {
  const inv: Record<string, unknown> = {}
  inv.label = LABEL
  inv.captured_at = new Date().toISOString()
  inv.url_project_ref = LOCAL ? 'local-drill' : DB_URL.includes(PROD_REF) ? PROD_REF : DB_URL.includes(TEST_REF) ? TEST_REF : 'unknown'

  // ── Identity anchors ──────────────────────────────────────────────────────
  const ver = await sql`select version() as v`
  inv.server_version = ver[0].v
  inv.current_database = (await sql`select current_database() as d`)[0].d

  inv.schema_migrations = (await sql`
    select version, applied_at::text from public.schema_migrations order by version
  `).map((r: { version: string; applied_at: string }) => r.version)

  // ── Tables, RLS, row counts, columns ──────────────────────────────────────
  const tables = await sql`
    select c.relname as name, c.relrowsecurity as rls
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r'
     order by c.relname`
  const tableInv: Record<string, unknown>[] = []
  for (const t of tables) {
    const n = (await sql.unsafe(`select count(*)::int as n from public."${t.name}"`))[0].n
    const cols = await sql`
      select column_name, data_type, is_nullable, column_default, is_generated, generation_expression
        from information_schema.columns
       where table_schema = 'public' and table_name = ${t.name}
       order by ordinal_position`
    tableInv.push({
      name: t.name,
      rls: t.rls,
      row_count: n,
      columns: cols.map((c: Record<string, unknown>) => ({
        column_name: c.column_name,
        data_type: c.data_type,
        is_nullable: c.is_nullable,
        column_default: c.column_default ?? null,
        is_generated: c.is_generated ?? null,
        generation_expression: c.generation_expression ?? null,
      })),
    })
  }
  inv.tables = tableInv

  // ── Indexes / constraints / triggers / policies ───────────────────────────
  inv.indexes = (await sql`
    select indexname, indexdef from pg_indexes where schemaname = 'public' order by indexname
  `).map((r: { indexname: string; indexdef: string }) => `${r.indexname} :: ${r.indexdef}`)

  inv.constraints = (await sql`
    select conname, conrelid::regclass::text as rel, contype, pg_get_constraintdef(oid) as def
      from pg_constraint where connamespace = 'public'::regnamespace
     order by conname
  `).map((r: { conname: string; rel: string; contype: string; def: string }) => `${r.conname}|${r.rel}|${r.contype}|${r.def}`)

  inv.triggers = (await sql`
    select pg_get_triggerdef(t.oid) as def
      from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and not t.tgisinternal
     order by t.tgname
  `).map((r: { def: string }) => r.def)

  inv.policies = (await sql`
    select schemaname, tablename, policyname, permissive, roles::text, cmd, qual, with_check
      from pg_policies where schemaname in ('public', 'storage')
     order by schemaname, tablename, policyname
  `).map((r: Record<string, unknown>) => JSON.stringify(r))

  // ── Functions: signatures + body fingerprints ─────────────────────────────
  inv.functions = await sql`
    select n.nspname as schema, p.proname as name,
           pg_get_function_identity_arguments(p.oid) as args,
           p.prokind, md5(p.prosrc) as body_md5
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname in ('public', 'private') and p.prokind = 'f'
     order by n.nspname, p.proname, args`

  // ── Raw ACLs (exact grant posture) ────────────────────────────────────────
  inv.table_acls = (await sql`
    select c.relname, c.relacl::text from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r'
     order by c.relname
  `).map((r: { relname: string; relacl: string | null }) => `${r.relname}|${r.relacl ?? 'NULL'}`)

  inv.function_acls = (await sql`
    select n.nspname as schema, p.proname, pg_get_function_identity_arguments(p.oid) as args,
           p.proacl::text as acl
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname in ('public', 'private') and p.prokind = 'f'
     order by n.nspname, p.proname, args
  `).map((r: { schema: string; proname: string; args: string; acl: string | null }) =>
    `${r.schema}.${r.proname}(${r.args})|${r.acl ?? 'NULL'}`)

  // ── Event triggers + extensions (public schema only) ──────────────────────
  inv.event_triggers = (await sql`
    select evtname, evtevent, evtenabled from pg_event_trigger order by evtname
  `).map((r: Record<string, unknown>) => JSON.stringify(r))
  inv.public_extensions = (await sql`
    select extname, extversion from pg_extension
     where extnamespace = 'public'::regnamespace order by extname
  `)

  // ── Storage buckets + object counts (read-only; optional for local drills) ─
  try {
    inv.buckets = (await sql`
      select id, name, public from storage.buckets order by name
    `)
    inv.storage_objects = (await sql`
      select bucket_id, count(*)::int as n from storage.objects group by bucket_id order by bucket_id
    `)
  } catch {
    inv.buckets = 'unavailable (local drill: storage schema not restored)'
    inv.storage_objects = 'unavailable (local drill: storage schema not restored)'
  }

  // ── Auth anchors (counts + fingerprints only — no personal data) ──────────
  try {
    inv.auth_users_count = (await sql`select count(*)::int as n from auth.users`)[0].n
    inv.auth_ids_md5 = (await sql`
      select md5(coalesce(string_agg(id::text, ',' order by id::text), '')) as h from auth.users
    `)[0].h
  } catch {
    inv.auth_users_count = 'unavailable'
    inv.auth_ids_md5 = 'unavailable'
  }
  inv.public_users_shape = (await sql`
    select user_type, status, count(*)::int as n from public.users group by user_type, status order by user_type, status
  `)

  // ── DATA fingerprints: per-table md5 over ordered row hashes ──────────────
  const dataFingerprints: Record<string, string> = {}
  const rowCounts: Record<string, number> = {}
  for (const t of tables) {
    if (t.name === 'schema_migrations') continue // bookkeeping, expected to change by design
    const r = (await sql.unsafe(
      `select md5(coalesce(string_agg(md5(t::text), '' order by md5(t::text)), '')) as h, count(*)::int as n from public."${t.name}" t`,
    ))[0]
    dataFingerprints[t.name] = r.h
    rowCounts[t.name] = r.n
  }
  inv.data_fingerprints = dataFingerprints
  inv.row_counts = rowCounts

  // ── Financial totals + FY counters (business invariants) ──────────────────
  inv.financial_totals = {
    sales_total: (await sql`select coalesce(sum(final_total), 0)::text as v from public.sales where status <> 'cancelled'`)[0].v,
    sales_paid: (await sql`select coalesce(sum(paid), 0)::text as v from public.sales where status <> 'cancelled'`)[0].v,
    sales_due: (await sql`select coalesce(sum(due), 0)::text as v from public.sales where status <> 'cancelled'`)[0].v,
    purchases_total: (await sql`select coalesce(sum(total), 0)::text as v from public.purchases where status <> 'cancelled'`)[0].v,
    purchases_paid: (await sql`select coalesce(sum(paid), 0)::text as v from public.purchases where status <> 'cancelled'`)[0].v,
    payments_in_total: (await sql`select coalesce(sum(amount), 0)::text as v from public.payments_in`)[0].v,
    payments_out_total: (await sql`select coalesce(sum(amount), 0)::text as v from public.payments_out`)[0].v,
    ledger_credit: (await sql`select coalesce(sum(amount), 0)::text as v from public.account_transactions where type = 'credit'`)[0].v,
    ledger_debit: (await sql`select coalesce(sum(amount), 0)::text as v from public.account_transactions where type = 'debit'`)[0].v,
  }
  inv.fy_counters = (await sql`
    select start_date::text, end_date::text, status, sale_counter, purchase_counter, proforma_counter
      from public.financial_years order by start_date
  `)
  inv.message_jobs_by_status = (await sql`
    select status, count(*)::int as n from public.message_jobs group by status order by status
  `)

  // ── 0019 target-function state (quick classification) ─────────────────────
  const tgt = await sql`
    select p.proname,
           (p.prosrc like '%GREATEST(fy.start_date, LEAST(current_date%') as has_clamp,
           (p.prosrc like '%v_bill_date%') as has_bill_date_var,
           (p.prosrc like '%v_reversal_date%') as has_reversal_date_var
      from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and p.proname in ('create_trade_in_purchase_bill', 'cancel_sale')
     order by p.proname`
  inv.target_functions_0019 = tgt

  const out = join(OUT_DIR, `${LABEL}.json`)
  writeFileSync(out, JSON.stringify(inv, null, 2))
  console.log(`✓ inventory written: ${out}`)
  console.log(`  project ref      : ${inv.url_project_ref}`)
  console.log(`  server           : ${String(inv.server_version).split(',')[0]}`)
  console.log(`  migrations       : ${JSON.stringify(inv.schema_migrations)}`)
  console.log(`  tables           : ${tableInv.length} (RLS on ${tableInv.filter((t) => (t as { rls: boolean }).rls).length})`)
  console.log(`  0019 targets     : ${JSON.stringify(tgt)}`)
  await sql.end()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
