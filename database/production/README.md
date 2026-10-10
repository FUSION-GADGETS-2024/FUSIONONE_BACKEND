# FUSION ONE — Canonical Production Database

The clean, reproducible definition of the **final FUSION ONE production
database**, buildable from a clean state. This directory is the canonical
fresh-database build; `database/migrations/` remains the historical
implementation chain (0001–0018) and is deliberately untouched.

The canonical build and the historical chain produce the same final
schema — the equivalence was verified live (the canonical files were
derived from the verified live schema of the TEST project, which is at
migrations 0001–0018, then normalized; see **Deviations** below).

## File structure (dependency-safe order)

```
database/production/
  01_extensions.sql            # btree_gist + pg_trgm (public schema)
  02_schemas.sql               # private schema + schema ACL posture
  03_helper_functions.sql      # search_norm / search_tokens (pre-table:
                               #   generated-column dependencies)
  04_tables.sql                # 25 tables: columns, defaults, generated
                               #   columns, CHECKs, PK/UNIQUE/EXCLUDE, FKs
  05_indexes.sql               # 49 secondary indexes (trigram GINs etc.)
  06_functions.sql             # 38 functions: private helpers + business RPCs
  07_triggers.sql              # 7 public triggers + auth.users provisioning
  08_rls_policies.sql          # RLS everywhere + 29 public policies
  09_grants.sql                # complete explicit API-role privilege posture
                               #   + default privileges (0004 posture)
  10_storage.sql               # store_assets bucket + policies; NO documents bucket
  11_event_triggers.sql        # rls_auto_enable + ensure_rls (RLS safety net)
  12_migration_bookkeeping.sql # marks migration chain 0001–0018 applied
  restore-data.sh              # guarded, dependency-ordered data restore
  README.md                    # this runbook
```

Order matters: 01 → 12. Files 03–08 are ordered by object dependency
(text helpers before the tables whose generated columns call them;
tables before the functions/RPCs that reference them; functions before
the policies/triggers/grants that resolve them). Every file except
`04_tables.sql` is idempotent (re-runnable); `04` uses fresh-build
semantics for tables (the reset step removes them first).

## What the final architecture enforces

- **Documents belong exclusively to parties**: `public.party_documents`
  is the ONE document entity. `trade_ins` has **no** document column of
  any kind (neither the legacy `document_url` nor the interim
  `document_id`); sales, proformas, exchanges and invoices carry no
  document concept. There is **no Supabase `documents` bucket** — party
  document files live in the private Cloudflare R2 bucket behind the
  Fastify backend (AES-256-GCM envelope encryption).
- **RLS everywhere**: every public table including `schema_migrations`;
  anon has no policies (deny-all); the single shared business dataset is
  reachable only through `private.can_access_app()` (verified + active +
  password-context sign-in). The `ensure_rls` event trigger auto-enables
  RLS on any future public table.
- **The money path is server-computed and invariant-checked**: canonical
  RPCs with server-computed totals, payment amount invariants at the
  trust boundary (0014), canonical recovery numbering (0015).
- **Auth identities live only in `auth.users`** — the canonical build
  never touches them. `public.users` rows are application data restored
  verbatim with their original UUIDs and their FK relationship to the
  existing auth identities.

## Clean rebuild (full reset + build)

> DESTRUCTIVE. This removes the public + private schemas (all
> application objects). `auth.users`, `storage.objects` bytes, the
> `store_assets` bucket and platform schemas are untouched. Take and
> verify a backup first — see `restore-data.sh` and the workflow below.

```bash
export DB_URL='postgresql://postgres.<ref>:<password>@<pooler-host>:5432/postgres?sslmode=require'

# 0) Preconditions (each refuses to proceed when unmet):
#    - a verified pg_dump -Fc application backup exists (see Backups)
#    - auth.users identities are recorded (they must NOT change)
#    - any legacy `documents` bucket is EMPTY or already removed
psql "$DB_URL" -c "SELECT id, email FROM auth.users;"

# 1) Reset — drop the event trigger FIRST (it references
#    public.rls_auto_enable and would break mid-drop), then the schemas.
#    The auth provisioning trigger is dropped with the schemas (07 recreates it).
psql "$DB_URL" <<'SQL'
DROP EVENT TRIGGER IF EXISTS ensure_rls;
DROP SCHEMA public CASCADE;
DROP SCHEMA private CASCADE;
CREATE SCHEMA public;
CREATE SCHEMA private;
SQL

# 2) Build the canonical schema (ordered, stops on first error).
for f in database/production/[0-9]*.sql; do
  echo "→ applying $f"
  psql "$DB_URL" -v ON_ERROR_STOP=1 -X -f "$f"
done

# 3) Restore the application data (guarded; refuses non-empty tables
#    and unanchored public.users rows).
database/production/restore-data.sh "$DB_URL" <app-backup.dump>

# 4) If the project still carries the legacy `documents` bucket
#    (pre-0017 state), remove it via the Storage API (SQL deletion is
#    blocked by Supabase's protect_delete trigger):
curl -X DELETE \
  -H "apikey: $SUPABASE_SECRET_KEY" \
  -H "Authorization: Bearer $SUPABASE_SECRET_KEY" \
  "$SUPABASE_URL/storage/v1/bucket/documents"
```

## Backups (before ANY destructive step)

```bash
# Application-scoped backup (the restore source)
pg_dump "$DB_URL" --schema public --schema private -Fc -f app-backup.dump
# Whole-database backup (recovery insurance only — auth is NEVER
# restored from it)
pg_dump "$DB_URL" -Fc -f full-backup.dump
sha256sum app-backup.dump full-backup.dump
```

A backup is a hypothesis until restored: verify by restoring
`app-backup.dump` into an isolated PostgreSQL instance (create stubs
first: roles `authenticated`/`anon`/`service_role`, schema `auth` with
a `users` table containing the same identity UUIDs, `auth.uid()` /
`auth.jwt()` stub functions, extensions `btree_gist` + `pg_trgm` in
`public`, schema `private`; then `pg_restore` with a TOC filtered to
skip the pre-created schemas) and comparing row counts, financial
totals and entity checksums against the source.

## Post-rebuild verification (minimum)

```sql
-- tables: 25 incl. party_documents and schema_migrations
SELECT count(*) FROM information_schema.tables
 WHERE table_schema='public' AND table_type='BASE TABLE';
-- no document columns on trade_ins
SELECT count(*) FROM information_schema.columns
 WHERE table_schema='public' AND table_name='trade_ins'
   AND column_name LIKE 'document%';                -- expect 0
-- RLS on every public table (25)
SELECT count(*) FROM pg_class c JOIN pg_namespace n ON c.relnamespace=n.oid
 WHERE c.relkind='r' AND n.nspname='public' AND c.relrowsecurity;  -- expect 25
-- auth identities unchanged, every public.users row anchored
SELECT count(*) FROM public.users u
 WHERE NOT EXISTS (SELECT 1 FROM auth.users a WHERE a.id=u.id);    -- expect 0
-- migration chain marked complete
SELECT count(*) FROM public.schema_migrations;                      -- expect 18
```

Plus row counts / financial totals / entity checksums compared against
the pre-reset inventory, `has_function_privilege` spot checks for the
service-role-only job RPCs, an `anon` denial probe, and the
application's test suites.

## Deviations from the historical live states (all deliberate)

The canonical SQL was derived from the verified TEST live schema and
normalized. These are the intentional differences from the historical
TEST/production states, with reasons:

1. **`schema_migrations` RLS enabled** — production already had this
   (auto-enabled by `ensure_rls`); TEST did not. The canonical build
   enables it explicitly with no policies and no API grants.
2. **No MAINTAIN privilege for API roles** — table grants use explicit
   privilege lists instead of `GRANT ALL` (which would include the
   PostgreSQL 17 `MAINTAIN` bit: `party_documents` carried it on TEST,
   everything carried it on production). Functionally meaningless on
   Supabase; normalized for a uniform, least-privilege posture.
3. **Schema ACLs tightened to the 0004-documented intent** — `public`:
   USAGE only for the API roles (no CREATE — the API never creates
   objects), revoked from PUBLIC; `private`: USAGE for `authenticated`
   only (TEST had drifted to also grant anon/service_role; production
   matched 0004).
4. **Default privileges restored** — production carries 0004's
   `ALTER DEFAULT PRIVILEGES` entries; TEST lost them to a historical
   schema reset. The canonical build includes them (with explicit
   privilege lists) so future migrations' objects keep the API grants.
5. **`ensure_rls` + `rls_auto_enable` canonized** — dashboard-installed
   on production only; now part of the reproducible build (security
   improvement, guards future tables).
6. **Constraint names use the clean final naming** —
   `message_jobs_{status,max_attempts}_check`, `message_jobs_*_fkey`,
   `inventory_items_origin_inventory_item_id_fkey` (TEST's live names;
   production carried the older `delivery_jobs_*` / `fk_origin_item`
   names — same semantics).
7. **Production's accumulated grant drift removed** — explicit `anon`
   EXECUTE grants on `add_funds`/`close_financial_year`/
   `transfer_funds`/`fy_*`/`rls_auto_enable` (functionally equivalent
   to the PUBLIC default that remains) and the `anon` column-level
   artifacts are not reproduced; the verified live posture from TEST
   is canonical instead.
8. **Legacy objects not recreated** — no `documents` bucket, no
   `documents_*` storage policies, no `trade_ins.document_url`.

## What is NOT in this directory

- Business data (lives only in verified backups outside the repo).
- Any Supabase Auth content — `auth.users` is never dumped, restored,
  or modified by the canonical build.
- The historical migration chain — see `database/migrations/` (kept
  as project history; `apply.ts` is a no-op on a canonically built
  database because of `12_migration_bookkeeping.sql`).
