/**
 * FUSIONONE database migration runner.
 *
 * Applies database/migrations/*.sql in filename order, tracking applied
 * migrations in the public.schema_migrations table. NEVER part of app
 * runtime — this is a DB-admin tool for baselining/maintaining Supabase
 * projects.
 *
 * Usage:
 *   FUSIONONE_DB_URL='postgresql://postgres.<ref>:<pw>@<pooler-host>:5432/postgres' \
 *     bun run apply.ts            # apply pending migrations to the target
 *   bun run apply.ts --fresh     # drop public schema first (DANGEROUS — empty/test projects only)
 *
 * The DB URL comes from the FUSIONONE_DB_URL environment variable, or
 * TEST_SUPABASE_DB_URL in database/tools/.env as a fallback. NEVER commit
 * credentials.
 */
import postgres from 'postgres'
import { readFileSync, readdirSync, existsSync, rmSync } from 'node:fs'
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
if (!DB_URL) throw new Error('Set FUSIONONE_DB_URL (or TEST_SUPABASE_DB_URL in database/tools/.env)')

const sql = postgres(DB_URL, { max: 1, prepare: false, idle_timeout: 5 })

const FRESH = process.argv.includes('--fresh')

async function main() {
  if (FRESH) {
    console.log('[fresh] Dropping existing public-schema objects...')
    // Drop everything the app owns in public (tables, functions, policies)
    // plus the storage policies we created. Buckets are recreated by 0005.
    await sql.unsafe(`
      DROP SCHEMA public CASCADE;
      DROP SCHEMA IF EXISTS private CASCADE;
      DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
      CREATE SCHEMA public;
      GRANT USAGE ON SCHEMA public TO postgres, anon, authenticated, service_role;
      GRANT ALL ON SCHEMA public TO postgres, anon, authenticated, service_role;
      COMMENT ON SCHEMA public IS 'FUSIONONE test database (rebuilt from actual application requirements)';
      DROP POLICY IF EXISTS "store_assets_read" ON storage.objects;
      DROP POLICY IF EXISTS "store_assets_write" ON storage.objects;
      DROP POLICY IF EXISTS "store_assets_update" ON storage.objects;
      DROP POLICY IF EXISTS "store_assets_delete" ON storage.objects;
      DROP POLICY IF EXISTS "documents_read" ON storage.objects;
      DROP POLICY IF EXISTS "documents_write" ON storage.objects;
      DROP POLICY IF EXISTS "documents_update" ON storage.objects;
      DROP POLICY IF EXISTS "documents_delete" ON storage.objects;
    `)
    console.log('[fresh] public schema reset.')
  }

  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS public.schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)

  const applied = new Set(
    (await sql`SELECT version FROM public.schema_migrations`).map((r) => r.version),
  )

  const files = readdirSync(join(HERE, '..', 'migrations'))
    .filter((f) => f.endsWith('.sql'))
    .sort()

  for (const file of files) {
    if (applied.has(file)) {
      console.log(`= skip ${file} (already applied)`)
      continue
    }
    console.log(`→ applying ${file} ...`)
    const content = readFileSync(join(HERE, '..', 'migrations', file), 'utf8')
    try {
      await sql.unsafe(content)
      await sql`INSERT INTO public.schema_migrations (version) VALUES (${file})`
      console.log(`✓ ${file}`)
    } catch (err) {
      console.error(`✗ ${file} FAILED:`)
      console.error(String(err))
      process.exit(1)
    }
  }

  const tables = await sql`
    SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name <> 'schema_migrations'
     ORDER BY table_name`
  console.log(`\nPublic tables (${tables.length}): ${tables.map((t) => t.table_name).join(', ')}`)
  const funcs = await sql`
    SELECT proname FROM pg_proc
     WHERE pronamespace = 'public'::regnamespace AND prokind = 'f'
     ORDER BY proname`
  console.log(`Public functions (${funcs.length}): ${funcs.map((f) => f.proname).join(', ')}`)
  await sql.end()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
