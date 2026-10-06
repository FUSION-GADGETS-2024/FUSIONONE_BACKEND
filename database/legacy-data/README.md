# Legacy Business Data Migration (OLD production → NEW production)

Executed 2026-10-02. This directory documents exactly what real business
data was migrated from the OLD production project
(`kegtzbebjdkiowvwhtha.supabase.co`) into the NEW production project
(`jzdnesudczqksghosmmx.supabase.co`), how it was transformed, and what was
intentionally excluded. `verification.sql` contains re-runnable
reconciliation checks against the NEW database.

The migration was executed through direct PostgreSQL connections
(read-only SELECTs against OLD; a single transaction against NEW) plus the
Supabase Storage API for the two retained store assets. All UUIDs were
preserved — no ID remapping was needed because the NEW database was empty
and both schemas use the same UUID keys.

## What was migrated (row counts)

| Table | Rows | Notes |
|---|---|---|
| `financial_years` | 2 | FY 2026-27 (active, counters 4/5/2) + FY 2027-28 (active, 0/0/0) |
| `store` | 1 | FUSION GADGETS — see transformations below |
| `bank_accounts` | 2 | Cash, YES Bank |
| `payment_modes` | 3 | Bank Transfer, Card, UPI (all on YES Bank) |
| `parties` | 8 | real customers/suppliers |
| `inventory_items` | 18 | 14 in stock, 4 sold |
| `purchases` | 5 | PUR-2026-27-0001..0005 |
| `purchase_items` | 18 | |
| `sales` | 4 | SAL-2026-27-0001..0004 |
| `sale_items` | 4 | |
| `trade_ins` | 0 | (no rows in OLD) |
| `proforma_invoices` | 1 | PI-2026-27-0001 |
| `proforma_invoice_items` | 1 | |
| `proforma_trade_ins` | 1 | |
| `payments_in` | 5 | |
| `payments_out` | 5 | |
| `account_transactions` | 16 | |
| `account_fund_entries` | 4 | |
| `account_transfers` | 1 | |
| `whatsapp_settings` | 1 | auto_send_sale=true + the three message templates |

**Storage objects (2 of 3)** — uploaded to the NEW `store_assets` bucket:

| OLD object | NEW object | Why |
|---|---|---|
| `418168bb-…_logo_1781111124039.jpeg` (64,916 B) | `store-logo.jpeg` | referenced by `store.logo_url` |
| `418168bb-…_signature_1781111124569.png` (7,594 B) | `store-signature.png` | referenced by `store.signature_url` |
| `418168bb-…_logo_1781090940536.png` (111,687 B) | **excluded** | superseded earlier logo — referenced by nothing |

**Owner identity** — `hello@fusiongadgets.in` (the main production
account) was created fresh in NEW Supabase Auth (verified email carried
over, owner's existing password kept so the owner logs in unchanged) and
provisioned as the single `public.users.user_type = 'owner'` row. The
auth-user auto-provisioning trigger created the row with `NULL` first
(fail-closed default), then the role was set through the privileged path.
`display_name` stays NULL: the owner completes the profile on first login
(`/profile-setup`), matching the three-stage account model.

## Transformations (OLD → NEW canonical schema)

| OLD (obsolete) | Disposition |
|---|---|
| `store.owner_user_id` | dropped — authorization now lives in `public.users.user_type` (RLS); no business table references user ids |
| `store.invoice_templates` (jsonb) | dropped — not in the current schema, referenced by no code |
| `whatsapp_settings.owner_user_id` (UNIQUE) | dropped — settings are the single shared store-level row (`singleton`) |
| `sales/purchases/proforma_invoices.pdf_path`, `.pdf_generated_at`, `.pdf_template_version` | dropped — production-only drift columns, referenced by no code (documented in the archived rebuild notes) |
| `store.logo_url` / `store.signature_url` | rewritten to the NEW storage object URLs (`…jzdnesudczqksghosmmx.supabase.co/storage/v1/object/public/store_assets/store-logo.jpeg` / `store-signature.png`) |
| missing `created_at` (financial_years, store, sales, purchases, payments_in/out in OLD) | column absent in OLD → NEW default (`now()`) applied at insert |
| `store.singleton`, `whatsapp_settings.singleton` | NEW-only columns → default `1` (singleton invariant) |

## Intentionally excluded

* **ALL data from the TEST project** (`egdrnhtmclvhsfjvhyam`) — mock data
  and mock users (incl. its deterministic `aa000000-…` ids). Verified: no
  TEST id appears anywhere in NEW, and every NEW business-row id exists in
  OLD.
* **OLD auth users** — only the single main production account
  (`hello@fusiongadgets.in`) was recreated (fresh identity, new UUID
  `e8de297e-dd76-403e-9830-7d94cec7eef3`). The OLD owner UUID
  (`418168bb-…`) intentionally does **not** exist in NEW; no business row
  references it (verified — no user-id columns exist in the NEW schema and
  no UUID column contains it).
* **Unused OLD storage object** (the superseded first logo PNG).
* Obsolete columns listed above.

## Sequences / identity generators

There are none to synchronize: every table uses UUID primary keys with
`gen_random_uuid()` defaults (verified on both databases). Bill-number
counters live in `financial_years.*_counter` and were migrated verbatim.

## Reproducing / re-checking

`verification.sql` runs the reconciliation queries against NEW (counts,
bill numbers, monetary sums, FK integrity, singleton/owner invariants,
URL rewrites, no-old-auth-id scan). It requires only read access.
