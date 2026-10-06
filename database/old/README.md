# Archived historical SQL (patch history — DO NOT apply to fresh projects)

This directory preserves the original patch-heavy migration sequence that was
iteratively applied to the TEST project (`egdrnhtmclvhsfjvhyam`) while the
current FUSION ONE architecture was being developed. It is kept for
reference/history only.

**Do not replay these files.** They contain intermediate states that were
later superseded (e.g. `0003` creates the obsolete `public.is_owner()`
store-ownership model that `0009` drops; `0002` creates
`store.owner_user_id` / `whatsapp_settings.owner_user_id` that `0010`
removes). The authoritative clean baseline for fresh projects is
`database/migrations/`.

## Files

| File | What it did (historical) |
|---|---|
| `0001_extensions.sql` | btree_gist extension |
| `0002_tables.sql` | initial 20 business tables (old per-owner store model) |
| `0003_rls.sql` | initial per-owner RLS (store.owner_user_id semantics) |
| `0004_indexes.sql` | FK/hot-path indexes |
| `0005_storage.sql` | store_assets + documents buckets and policies |
| `0006_functions.sql` | business RPC functions (create_sale, close_financial_year, …) |
| `0007_grants.sql` | API role grants + default privileges |
| `0008_application_users.sql` | public.users + private authorization helpers + provisioning trigger |
| `0009_rls_shared_authorization.sql` | shared-data RLS rewrite (owner/user roles) |
| `0010_singletons_and_shared_settings.sql` | store/whatsapp_settings singletons; dropped owner_user_id columns |
| `0011_store_setup_rpc.sql` | transactional complete_store_setup() |
| `0012_user_status.sql` | users.status (active/blocked) + hardened helpers |
| `0013_auth_context_rls.sql` | amr 'password' authentication-context boundary |
| `0014_display_name.sql` | display_name + narrow self-update privilege |
| `tools/` | one-off TEST-phase tooling (seed, auth-matrix tests, cleanups, …) |

The live TEST database state produced by this sequence was forensically
dumped and served as the source of truth for the clean baseline in
`database/migrations/`.
