# FUSIONONE Database

The clean, current database baseline for FUSION ONE production
(Supabase project `jzdnesudczqksghosmmx`).

## Layout

```
database/
  migrations/          # THE clean baseline — describes the target state directly
    0001_extensions.sql        # btree_gist (only app-required extension)
    0002_schema.sql            # 21 tables, all constraints, indexes (incl. singletons)
    0003_functions_triggers.sql# private authorization helpers + 17 business RPCs + 2 triggers
    0004_security_storage.sql  # RLS + 27 policies + grants + storage buckets/policies
    0005_user_roles.sql        # multi-owner role model + never-zero-owners invariant
    0006_delivery_jobs.sql     # durable message system (historically named delivery):
                               #   delivery_jobs + reminder_settings + receipt/reminder
                               #   message templates + service-role RPCs
    0007_auto_receipts_statements.sql
                               #   automatic payment receipts (subsequent payments only) +
                               #   Payment Statement job type + transactional
                               #   private.create_auto_receipt_job bridge in the payment RPCs
    0008_messages_overview.sql # Messages page summary aggregate (messages_overview)
    0009_message_jobs.sql      # Delivery → Messages domain cutover: renames the 0006/0007
                               #   job system to message terminology (table, indexes,
                               #   RPCs) — data and semantics preserved
  0010_trade_in_proforma_schema.sql
                             # Trade-In + Proforma architectural redesign (schema):
                             #   trade_ins → pure transactional relationship (sale_id,
                             #   inventory_item_id NOT NULL, credit_value, mrp,
                             #   document_url) — device identity lives ONLY in
                             #   inventory_items; sales.proforma_id + partial UNIQUE
                             #   index (hard duplicate-conversion guard);
                             #   proforma_invoice_items.inventory_item_id (real
                             #   Inventory quotations, legacy free-text preserved);
                             #   identity-freeze trigger for sold devices
  0011_canonical_sale_proforma_rpcs.sql
                             # Canonical RPCs: ONE create_sale (normal + proforma-
                             #   conversion modes, server-computed totals, atomic
                             #   convert-and-link), guarded cancel/delete (FK-safe
                             #   trade-in reversal), atomic update_sale edit,
                             #   inventory-referenced create_proforma, NEW
                             #   update_proforma + void_proforma, adapted
                             #   create_trade_in_purchase_bill; dead
                             #   allocate_bill_numbers dropped
  legacy-data/
    README.md          # what was migrated from OLD production, transformations, exclusions
    verification.sql   # re-runnable reconciliation checks (read-only)
  old/                 # ARCHIVED patch history (database/old/README.md) — never replay
  tools/
    apply.ts           # migration runner (FUSIONONE_DB_URL env var; never commit credentials)
    message-tests.ts   # durable-message DB test suite — TEST project only
```

## Architecture (enforced by the database)

* **Identity**: Supabase Auth is authoritative. Email verification is read
  live from `auth.users.email_confirmed_at` — no duplicate flag.
* **Application roles**: `public.users.user_type ∈ {owner, user, NULL}`.
  NULL = unprovisioned = zero access (fail-closed). Exactly one owner —
  database-enforced (`users_single_owner` partial unique index). New Auth
  users are auto-provisioned with NULL by the `on_auth_user_created`
  trigger.
* **Account status**: `public.users.status ∈ {active, blocked}` — blocked
  means locked out everywhere (RLS helpers, backend, frontend resolver);
  the owner can never be blocked (CHECK constraint).
* **Authentication context**: business access additionally requires a
  normal password sign-in (JWT `amr[0].method = 'password'`);
  invitation/recovery (`otp`) sessions are confined to `/set-password`.
  Enforced by `private.can_access_app()` / `private.is_owner()`
  (SECURITY DEFINER, `search_path = ''`, not exposed to anon).
* **Shared data**: all authorized users (owner + user) share the same
  business dataset. There is no per-user business-data tenancy.
* **Singleton store / settings**: at most one `store` row and one
  `whatsapp_settings` row (fixed singleton key + CHECK + UNIQUE index).
  Store/settings mutation is owner-only (RLS). The old
  `owner_user_id`-based authorization model is gone.
* **Profile**: `public.users.display_name` (NULL = incomplete). Users may
  update ONLY their own `display_name` (column-level grant + narrow
  policy) — roles/status are never writable from the browser.
* **RLS everywhere**: enabled on all 21 application tables; anon has no
  policies (deny-all). Frontend checks are UX only; the backend
  re-resolves the caller on every request.

## Durable message system (0006 + 0009)

One durable job table for ALL server-side message work — invoice auto-send
(server-owned, replacing the old browser sessionStorage intent), scheduled
invoice payment reminders, and payment receipts (manual always; automatic
for subsequent payments since 0007):

* **`message_jobs`** (renamed from delivery_jobs by 0009) — jobs reference business objects by typed FKs
  (sale/purchase/proforma/payment_in/payment_out, exactly one shape per
  `job_type` enforced by CHECK + CASCADE). Lifecycle:
  `pending → processing → succeeded | failed | cancelled`; retryable
  failures return to `pending` with exponential backoff; abandoned claims
  (expired lease) are recovered continuously. Partial unique indexes make
  job creation idempotent (ONE pending/processing job per object per type).
* **`reminder_settings`** — ONE row per sale (UNIQUE): enabled, frequency
  (days), max reminders, and durable progress (`reminders_sent` counts
  DELIVERED reminders only; attempts live on the job row). The maximum is
  enforced by this persistent state — never by UI state.
* **`whatsapp_settings`** (existing singleton) — extended with
  `payment_in_message_template`, `payment_out_message_template`, and
  `reminder_message_template` (NOT NULL DEFAULT).
* **Service-role RPCs** — `claim_due_message_jobs` (FOR UPDATE SKIP
  LOCKED), `recover_expired_message_jobs`, `complete_message_job`
  (advances the reminder chain atomically), `upsert_reminder_config`
  (config + job reconciliation), `trigger_reminder_now`. Granted to
  `service_role` ONLY (revoked from anon/authenticated): job state is
  system-owned; the browser reads it (SELECT-only RLS) but can never write
  it.
* Balance authority is unchanged: reminders check the CURRENT
  `sales.due`/`status` at execution time; jobs never freeze amounts.

## Automatic payment receipts + Payment Statements (0007)

The 0007 extension of the message system (pre-0009 names):

* **Automatic receipts are OPTIONAL and independent per direction** —
  `whatsapp_settings.auto_send_receipt_in` / `auto_send_receipt_out`
  (NOT NULL DEFAULT FALSE). They apply to SUBSEQUENT payments ONLY
  (`receive_payment` / `pay_purchase`); the INITIAL payment recorded inside
  `create_sale` / `create_purchase` NEVER triggers one (the invoice/bill
  message already carries it). Manual receipting remains available for
  EVERY payment regardless of the switches.
* **Transactional job creation** — the payment RPCs call the private
  `create_auto_receipt_job(direction, payment_id)` SECURITY DEFINER bridge
  (pinned search_path; private schema so PostgREST never exposes it;
  EXECUTE for authenticated — the invoker RPC bodies — revoked from anon).
  Payment + accounting + job commit as ONE transaction: a closed browser or
  restarted backend can never lose the job.
* **The `statement` job type** — manual-only Payment Statements (ONE job
  per invoice/bill while pending/processing; a later request after a
  terminal outcome is a fresh job). Statements compose from CURRENT
  authoritative data at execution: the full payment list (initial payment
  included) + `sales.paid/due` / `purchases.paid/due` aggregates.
* **Statement templates** — `payment_statement_in_message_template` /
  `payment_statement_out_message_template` (NOT NULL DEFAULT) in the same
  singleton, using the same token system (`total_paid` and `payment_count`
  tokens added to the shared vocabulary).

## Applying to a fresh Supabase project

```bash
cd database/tools
FUSIONONE_DB_URL='postgresql://postgres.<ref>:<password>@<region-pooler>.pooler.supabase.com:5432/postgres' \
  bun run apply.ts
```

The runner applies `migrations/*.sql` in order and records them in
`public.schema_migrations`. After the baseline, restore business data per
`legacy-data/README.md` (if migrating an existing business), then run
`legacy-data/verification.sql`.

## History

The baseline was reconstructed (2026-10-02) from a full forensic dump of
the live TEST database — the authoritative current architecture — NOT by
replaying the archived patch history in `old/`. See `old/README.md` for
what each historical file did.
  0012_validation_search.sql
                             # Global field validation + normalization + search
                             #   + numeric hardening: strict IMEI (15 digits) and
                             #   RAM/ROM (N/M) validation trigger on
                             #   inventory_items; parties.number strict
                             #   Indian-phone canonicalization (+91XXXXXXXXXX)
                             #   with deterministic backfill; store.phone soft
                             #   canonicalization; pg_trgm + normalized generated
                             #   search columns + trigram GIN indexes; ONE ranked
                             #   search_inventory RPC (tiered relevance: exact >
                             #   prefix > token > substring > fuzzy) + ONE
                             #   search_parties RPC (phone-canonical); hardened
                             #   create_purchase (item/date/price validation,
                             #   server-computed totals); proforma trade-in
                             #   qty >= 1. Sale min-product invariants were
                             #   already enforced by 0011's create_sale
                             #   (both modes).
  0013_strict_identity_validation.sql
                             # Strict identity validation — removes 0012's
                             #   transition-period grandfathering (validate
                             #   only when the column CHANGES): every write
                             #   touching imei/ram_rom must carry a VALID
                             #   identity, unchanged values included. Applied
                             #   to BOTH projects after their legacy data was
                             #   corrected (production: two historical RAM/ROM
                             #   values fixed by controlled migration; TEST:
                             #   ten invalid fixture IMEIs replaced with valid
                             #   ones). Nothing is grandfathered anymore.
  0014_payment_amount_invariant.sql
                             # Payment amount invariant at the RPC trust
                             #   boundary: receive_payment / pay_purchase
                             #   reject NULL / zero / negative amounts BEFORE
                             #   any row is locked or written (rejected calls
                             #   are side-effect free); upper bound and
                             #   accounting semantics unchanged. Brings the
                             #   migration chain to the verified live-TEST
                             #   bodies.
  0015_canonical_recovery_numbering.sql
                             # Recovery bills use the ONE canonical purchase
                             #   numbering: create_trade_in_purchase_bill
                             #   allocates PUR-<full start year>-<2-digit end
                             #   year>-<counter> via the same
                             #   fy_start_year_full/fy_end_year_2 helpers as
                             #   create_purchase (PUR-2026-27-0006), replacing
                             #   the historical two-digit start-year quirk
                             #   (PUR-26-27-0006). Historical bills untouched.
