# Production Migration Runbook — 0006–0009 (message system, automatic receipts, payment statements)

> **PROMOTION RECORD — 0012 + 0013 (validation / search / strict identity):
> EXECUTED 2026-10-05.** Production (`jzdnesudczqksghosmmx`) migrated
> 0001–0011 → 0001–0013 via the canonical `apply.ts` runner, followed by a
> controlled data correction. The TEST-verified implementation (134/134 DB
> suite + browser E2E) was promoted with:
>
> * **Pre-flight** — read-only production inspection: migrations exactly
>   0001–0011; ZERO pre-existing 0012 objects (functions/triggers/generated
>   columns/indexes/pg_trgm all absent); all 19 inventory IMEIs already valid
>   15-digit values; exactly 2 invalid RAM/ROM rows, both SOLD (Samsung S22
>   Ultra white IMEI 357187981753258 = `"256"`, sold in SAL-2026-27-0003;
>   Apple iPhone 13 Green IMEI 359451184489278 = `"256GB"`, sold in
>   SAL-2026-27-0008); all 11 party phone numbers canonicalizable; store
>   phone already canonical; full logical snapshot of all 23 tables saved
>   outside the repo as the recovery point
>   (`/home/z/prodmig-valsrch/backup-pre-migration/`).
> * **TEST-only fallback identified and NOT promoted as a permanent
>   exception** — 0012's grandfathering guard (`validate only on INSERT or
>   column CHANGE`) existed solely for TEST's intentionally invalid fixture
>   IMEIs and the two production RAM/ROM values above. It was REMOVED for
>   production via a NEW migration `0013_strict_identity_validation.sql`
>   (strict at the boundary: every write touching imei/ram_rom must carry a
>   valid identity, unchanged values included). 0012 itself was applied
>   byte-identical to the TEST-verified artifact.
> * **Dry run** — 0012 + 0013 + the exact two-row correction applied inside
>   ONE always-rolled-back transaction on the live production schema:
>   87/87 checks (structure, grants, backfill, searches against real data,
>   hardened create_purchase incl. server-recomputed totals + no-counter-
>   consumption-on-failure, 0011 sale invariants intact, strict-trigger
>   proof that re-saving the old invalid value is rejected, correction
>   drill with freeze-trigger disable/re-enable, no message jobs created);
>   post-rollback state proven byte-identical.
> * **Execution** — `FUSIONONE_DB_URL=… bun run apply.ts`: 0001–0011
>   skipped, 0012 + 0013 applied cleanly; then the controlled data
>   correction in ONE transaction (identity-freeze trigger temporarily
>   disabled — the only way to touch SOLD-device identity, done as a
>   controlled migration, NOT a rule change; guarded WHERE on id+imei+
>   current value, exactly 1 row each; strict validation trigger left
>   ACTIVE so the corrected values passed the final contract; trigger
>   re-enabled and verified before commit): S22 Ultra `"256"` → `12/256`,
>   iPhone 13 Green `"256GB"` → `4/256`.
> * **Verification** — 50/50 checks on the committed state: schema at
>   0001–0013 with the strict trigger body; both records corrected and
>   still SOLD with every other column byte-identical; inventory shows
>   ONLY the two intended ram_rom changes vs the snapshot; all 8 sales,
>   sale_items, trade_ins, payments, purchases and every other table
>   identical; 10 party numbers canonicalized by the documented backfill
>   (deterministic, loud-guarded); store row and whatsapp_settings flags
>   UNTOUCHED (owner-set `auto_send_sale`/`auto_send_receipt_in` = true
>   preserved as found); message_jobs unchanged (4 rows — nothing created,
>   nothing sent); live searches rank correctly; validation probes
>   (savepointed, rolled back) all behave per the final contract.
> * **TEST cleanup (same final architecture)** — the 10 invalid-IMEI
>   fixture rows corrected (not deleted — they are referenced by
>   historical test sales; TESTSEED000001 + 9 `DBTIME…` rows → deterministic
>   valid 869-series IMEIs, ids/statuses/relationships preserved); 0013
>   applied to TEST; function bodies verified byte-identical between the
>   two projects; a pre-existing message-tests teardown leak fixed
>   (create_purchase-created fixture items now removed + asserted);
>   suites re-run green: 134/134 + 121/121 + 44/44.
> * **Rollback** — reversible via the pre-migration logical snapshot plus
>   DROP of the 0012/0013 objects (see the 0006–0009 rollback pattern;
>   generated columns are dropped with `inventory_items`/`parties` ALTERs).
> * **Deployment note** — the production application deployments (Render
>   backend + Cloudflare Pages frontend) must be redeployed from the
>   current source to use the promoted search RPCs and validation UX. The
>   OLD deployed frontend keeps working against the new schema (its writes
>   now hit the enforced contracts and fail loudly on invalid input, which
>   is the intended behavior during the gap).

> **PROMOTION RECORD — 0010 + 0011 (Trade-In + Proforma architectural
> redesign): EXECUTED 2026-10-05.** Production (`jzdnesudczqksghosmmx`)
> migrated 0001–0009 → 0001–0011 via the canonical `apply.ts` runner.
> The TEST-verified architecture (121/121 DB suite on TEST + browser E2E
> workflows A–E) was promoted with:
>
> * **Pre-flight** — read-only production inspection: migrations exactly
>   0001–0009; `trade_ins` 0 rows (backfill guard trivially safe); the one
>   legacy quotation `PI-2026-27-0001` has a free-text line (qty 1,
>   description preserved, honestly NULL `inventory_item_id`); no duplicate
>   in-stock IMEIs; no orphaned references; no preexisting 0010/0011 objects;
>   no function overloads (all replaced signatures match the 0003 baseline);
>   a full logical snapshot of all 23 tables saved outside the repo as a
>   recovery point.
> * **Dry run** — 0010 + 0011 applied inside ONE always-rolled-back
>   transaction on the live production schema: 68/68 checks (structure,
>   grants, data integrity, and full behavioral probes incl. atomic
>   conversion, duplicate-conversion guard, resold trade-in lifecycle,
>   identity freeze, legacy conversion at quoted value); post-rollback state
>   proven byte-identical.
> * **Execution** — `FUSIONONE_DB_URL=… bun run apply.ts`: 0001–0009
>   skipped, 0010 + 0011 applied cleanly.
> * **Verification** — production post-state structurally EQUAL to the TEST
>   reference for the whole domain (columns, constraints, indexes, triggers,
>   RPC signatures AND byte-identical RPC bodies for all 8 canonical
>   functions); all 23 business tables row-for-row identical to the
>   pre-migration snapshot on their pre-existing columns (new columns
>   `sales.proforma_id` / `proforma_invoice_items.inventory_item_id` honestly
>   NULL on historical rows); 70/70 behavioral probes on the committed state
>   (zero residue); 20/20 security probes (authenticated can execute the new
>   RPCs and read via RLS; anon denied everywhere; job RPCs still
>   service-role-only; untouched payment RPC grants unchanged); browser E2E
>   against production through the current application (login, dashboard,
>   sales list + detail + invoice PDF, proformas + legacy quotation detail +
>   Convert/Edit/Void lifecycle + conversion dialog + stock-picker
>   quotation editor, inventory, exchange) with ZERO console errors.
> * **Known intentional non-difference** — production additionally carries a
>   dashboard-installed event trigger `ensure_rls` (`public.rls_auto_enable`,
>   auto-enables RLS on newly created public tables). It is NOT part of the
>   migration baseline, is unrelated to this redesign (0010/0011 create no
>   tables), is a security IMPROVEMENT, and was deliberately left untouched
>   per the no-unrelated-changes rule.
> * **Rollback** — reversible via `/home/z/prodmig-redesign/rollback.sql`
>   (scratch, outside the repo) plus the pre-migration logical snapshot;
>   valid only before new-architecture rows are created.
> * **Deployment note** — the production application deployments (Render
>   backend `wa.one.fusiongadgets.in` + the Cloudflare Pages frontend) must
>   be redeployed from the current source to match the promoted schema. The
>   old deployed frontend would fail on proforma creation and on displaying
>   trade-in identity (the dropped `trade_ins` identity columns) until
>   redeployed; normal sales/purchases/payments are unaffected.


> **ADDENDUM (0008 + 0009):** the TEST project has since applied
> `0008_messages_overview.sql` (the Messages page summary aggregate) and
> `0009_message_jobs.sql` (the Delivery → Messages domain cutover: the
> `delivery_jobs` table, its indexes/constraints/policy, and the job RPCs
> are RENAMED to message terminology — `message_jobs`,
> `claim_due_message_jobs`, `recover_expired_message_jobs`,
> `complete_message_job` — with data and semantics preserved; 0009 also
> repoints `messages_overview`, `upsert_reminder_config`,
> `trigger_reminder_now`, and `private.create_auto_receipt_job` bodies).
> Production must apply 0006 → 0007 → 0008 → 0009 IN ORDER (the complete
> chain is validated on TEST by `database/tools/message-tests.ts`, 43/43
> green). The final production state is `message_jobs` + the renamed RPCs —
> the 0006/0007 sections below keep their historical names deliberately.
> 0009 is metadata-only (renames + function replaces) — no data rewrite,
> brief locks, safe on a live table.

> **STATUS: PREPARED — NOT EXECUTED.**
> Per the implementation specification (§4 / §54), ALL implementation and
> testing ran against the TEST Supabase project (`egdrnhtmclvhsfjvhyam`).
> The production project (`jzdnesudczqksghosmmx`) must remain untouched
> until the complete system has been validated end-to-end and these
> migrations are executed deliberately, as a separate operation, by the
> owner.

## What these migrations do

`database/migrations/0006_delivery_jobs.sql`:

1. Extends `whatsapp_settings` with three NOT NULL DEFAULT columns:
   `payment_in_message_template`, `payment_out_message_template`,
   `reminder_message_template`.
2. Creates `reminder_settings` (one row per sale; UNIQUE; CASCADE) — the
   per-invoice reminder configuration and durable progress.
3. Creates `delivery_jobs` — the ONE durable delivery job table (typed
   business-object references, lifecycle status, claim lease, retry
   backoff, idempotency partial-unique indexes).
4. RLS: both new tables are SELECT-only for authenticated app users.
5. Five service-role-only RPCs: `claim_due_delivery_jobs`,
   `recover_expired_delivery_jobs`, `complete_delivery_job`,
   `upsert_reminder_config`, `trigger_reminder_now`.

`database/migrations/0007_auto_receipts_statements.sql` (the automatic
payment-receipt + Payment Statement feature set):

1. Extends `whatsapp_settings` with the independent automatic-receipt
   switches `auto_send_receipt_in` / `auto_send_receipt_out` (BOOLEAN NOT
   NULL DEFAULT **FALSE** — automatic receipts are OFF until the owner
   enables them per direction) and the Payment Statement message templates
   `payment_statement_in_message_template` /
   `payment_statement_out_message_template`.
2. Widens `delivery_jobs`: the `statement` job type (ref shape: sale XOR
   purchase) + its two idempotency partial-unique indexes.
3. Creates `private.create_auto_receipt_job(text, uuid)` — the
   transactional SECURITY DEFINER bridge (private schema: never exposed by
   PostgREST; EXECUTE granted to authenticated for the invoker payment
   RPCs, revoked from anon).
4. Replaces `receive_payment` / `pay_purchase` with identical bodies PLUS
   the final `PERFORM private.create_auto_receipt_job(...)` — the payment,
   its accounting updates, and (when the switch is ON) its automatic
   receipt job commit as ONE transaction. `create_sale` / `create_purchase`
   (the initial-payment paths) are deliberately untouched: the initial
   payment NEVER triggers an automatic receipt.

**Risk profile: 0006 purely additive; 0007 additive + two function
replacements (identical semantics plus the transactional job hook) + two
constraint rebuilds (`delivery_jobs_job_type_check`, `delivery_jobs_ref_shape`)
which take a brief ACCESS EXCLUSIVE lock on `delivery_jobs` (empty at first
execution). The `whatsapp_settings` ALTERs only add columns with defaults
(fast, no rewrite).**

## Pre-flight checklist (production)

- [ ] The complete feature has been validated end-to-end on the TEST
      project (DB suite `database/tools/message-tests.ts` green — 43 checks
      incl. the automatic-receipt and statement sections; backend + frontend
      type checks, unit tests, and builds green; E2E flows verified incl.
      browser-closed, backend-restart, double-action, and failure paths).
- [ ] Review `0006_delivery_jobs.sql` and `0007_auto_receipts_statements.sql`
      line by line (functions, policies, indexes, constraints).
- [ ] Verify no test-only data or credentials are embedded in the
      migrations (they are pure schema files — confirmed by review).
- [ ] Take/confirm a backup (Supabase automated backups / PITR window).
- [ ] Confirm the production backend deployment will set
      `SUPABASE_SECRET_KEY` (required for the delivery scheduler; without
      it the scheduler stays disabled and delivery endpoints fail closed)
      and, optionally, `DELIVERY_POLL_INTERVAL_MS` / `DELIVERY_JOB_LEASE_MS`.
- [ ] Confirm the frontend production deployment points
      `VITE_FUSIONONE_BACKEND_BASE` at the hosted backend origin and that the
      SPA origin is listed in the backend's `CLIENT_ORIGIN` (the browser calls
      the backend cross-origin and directly; there is no same-endpoint
      gateway).

## Execution (deliberate, separate from development)

```bash
cd database/tools
FUSIONONE_DB_URL='postgresql://postgres.jzdnesudczqksghosmmx:<PRODUCTION_DB_PASSWORD>@aws-0-ap-south-1.pooler.supabase.com:5432/postgres' \
  bun run apply.ts
```

Expected output: `✓ 0006_delivery_jobs.sql` and `✓ 0007_auto_receipts_statements.sql`
(migrations 0001–0005 are already applied in production and will be
skipped). **ORDER MATTERS for the backend deployment**: deploy the backend
build with the statement/auto-receipt code paths only AFTER 0007 has been
applied (the new `whatsapp_settings` columns and the `statement` job type
must exist; the replaced `receive_payment`/`pay_purchase` bodies call
`private.create_auto_receipt_job`, which must exist).

## Post-migration verification (production, read-only)

```sql
-- 23 tables (delivery_jobs + reminder_settings present)
SELECT table_name FROM information_schema.tables
 WHERE table_schema='public' ORDER BY table_name;

-- RPC grants: service_role only
SELECT has_function_privilege('authenticated', 'public.claim_due_delivery_jobs(text, int, int, uuid)', 'EXECUTE') AS auth_can,  -- expect false
       has_function_privilege('service_role',  'public.claim_due_delivery_jobs(text, int, int, uuid)', 'EXECUTE') AS svc_can;  -- expect true

-- Template columns present with defaults on the singleton row
SELECT payment_in_message_template IS NOT NULL,
       payment_out_message_template IS NOT NULL,
       reminder_message_template IS NOT NULL,
       payment_statement_in_message_template IS NOT NULL,
       payment_statement_out_message_template IS NOT NULL,
       auto_send_receipt_in = false,
       auto_send_receipt_out = false
  FROM public.whatsapp_settings;

-- 0007: the auto-receipt bridge posture (authenticated yes for the invoker
-- payment RPCs, anon no; private schema — not PostgREST-exposed)
SELECT has_function_privilege('authenticated', 'private.create_auto_receipt_job(text, uuid)', 'EXECUTE') AS auth_can,  -- expect true
       has_function_privilege('anon', 'private.create_auto_receipt_job(text, uuid)', 'EXECUTE') AS anon_can;             -- expect false

-- 0007: the statement job type is accepted by the ref-shape CHECK
SELECT COUNT(*) FROM public.delivery_jobs WHERE job_type = 'statement'; -- 0 rows, no error
```

Then deploy the backend (which starts the scheduler) and the frontend, and
exercise one manual receipt + one reminder configuration + one Payment
Statement against production. Automatic receipts stay OFF until the owner
enables them per direction in Settings → WhatsApp.

## Rollback (only if required)

```sql
-- 0007
DROP FUNCTION IF EXISTS private.create_auto_receipt_job(text, uuid);
-- (receive_payment / pay_purchase revert to their prior 0003 bodies;
--  re-apply those function definitions from the 0003 baseline.)
ALTER TABLE public.delivery_jobs
  DROP CONSTRAINT IF EXISTS delivery_jobs_ref_shape,
  DROP CONSTRAINT IF EXISTS delivery_jobs_job_type_check;
ALTER TABLE public.delivery_jobs
  ADD CONSTRAINT delivery_jobs_job_type_check
    CHECK (job_type IN ('invoice_send', 'reminder', 'receipt'));
-- (then re-add the 0006 ref-shape constraint verbatim from 0006_delivery_jobs.sql)
DROP INDEX IF EXISTS public.uq_delivery_jobs_statement_sale;
DROP INDEX IF EXISTS public.uq_delivery_jobs_statement_purchase;
ALTER TABLE public.whatsapp_settings
  DROP COLUMN IF EXISTS auto_send_receipt_in,
  DROP COLUMN IF EXISTS auto_send_receipt_out,
  DROP COLUMN IF EXISTS payment_statement_in_message_template,
  DROP COLUMN IF EXISTS payment_statement_out_message_template;
DELETE FROM public.schema_migrations WHERE version = '0007_auto_receipts_statements.sql';

-- 0006
DROP TABLE IF EXISTS public.delivery_jobs CASCADE;
DROP TABLE IF EXISTS public.reminder_settings CASCADE;
ALTER TABLE public.whatsapp_settings
  DROP COLUMN IF EXISTS payment_in_message_template,
  DROP COLUMN IF EXISTS payment_out_message_template,
  DROP COLUMN IF EXISTS reminder_message_template;
DELETE FROM public.schema_migrations WHERE version = '0006_delivery_jobs.sql';
```
