# FUSION ONE Current System Summary

> **STATUS: HISTORICAL SNAPSHOT (2026-10-03, pre-message-system era).**
> This audit predates the durable message system (delivery/message jobs,
> scheduler, automatic receipts, payment statements, reminders, the
> Messages page) and the Documents/Messages/WhatsApp backend domain split.
> Statements like "no server-side automation exists", "delivery state is
> unrepresentable", and the "explicit gaps" lists below describe the system
> AS OF THE AUDIT DATE and are deliberately preserved as history. For the
> CURRENT architecture see `backend/API.md` (routes, events, job system),
> `database/README.md` (schema baseline incl. migrations 0006–0009), and
> `worklog.md` (per-feature implementation records).

**Audit date:** 2026-10-03 · **Method:** direct inspection of frontend + backend source, live production Supabase database (read-only SQL), and sandbox infrastructure. No behavior modified.
**Systems:** Frontend = Vite SPA at repo root (`/home/z/my-project`, commit `2ec7dea`) · Backend = `/home/z/my-project/backend` (deployed at `https://wa.one.fusiongadgets.in`; deployment state UNVERIFIED — no manifest in repo) · Database = Supabase project `jzdnesudczqksghosmmx` (PostgreSQL 17.11, 13 MB, 22 public tables).
**Sources of truth for this document:** actual code + live `pg_catalog` queries. Older prompts/reports were used only for orientation, never as evidence.

---

## 1. Architecture Overview

Three cooperating systems, one browser:

```
┌─────────────────────────┐   ALL business data (publishable key + RLS + RPCs)
│  Browser (Vite SPA)     │ ────────────────────────────────────────────────►  Supabase (Postgres 17.11)
│  React 19 / react-router│
│  7 / TanStack Query 5   │   WhatsApp lifecycle + SSE + invoice send + user mgmt
│                         │ ────────────────────────────────────────────────►  FUSION ONE Backend (Fastify + Baileys)
└─────────────────────────┘        (Bearer Supabase JWT, cross-origin, direct)     wa.one.fusiongadgets.in
                                                                              │
                                                                    Supabase (caller-JWT reads for invoice compose)
                                                                    Redis Cloud (encrypted WhatsApp session backup ONLY)
```

- **Frontend owns all business-data reads/writes**, directly against Supabase from the browser (publishable key, cookie session, RLS, transactional RPCs). Bill numbers are always RPC/DB-generated; the frontend never formats them.
- **Backend owns the WhatsApp runtime, invoice send pipeline (composition + PDF + delivery), and owner-gated user management.** It is not a "WhatsApp invoice sender" as a whole — its surface is 18 routes (health/ping ×4, status/SSE ×2, WhatsApp commands ×4, user management ×8).
- **No server-side automation exists anywhere**: every delivery is browser-initiated; there is no queue, outbox, scheduler, cron, webhook, or Edge Function (verified in code and live DB, §10).
- The local sandbox additionally runs a **dev copy** of the backend on :3001 (browser never uses it; the SPA calls the hosted instance), behind a platform Caddy gateway (:81 → Vite :3000).

---

## 2. Frontend

### 2.1 Application architecture
- **Stack:** Vite 7.1 + React 19.2.7 + TypeScript ~6.0 strict, react-router 7.1 (`createBrowserRouter`), TanStack Query 5.101 (`staleTime 5min, gcTime 30min, retry 1`), Tailwind 4.3, pdfjs-dist 6.3 (viewer), pdfkit 0.20 (generation), @supabase/supabase-js 2.112 + @supabase/ssr. No Zustand/Redux (grep-verified). No ESLint config exists (pre-existing). Vitest 5 + jsdom + Testing Library (138 tests).
- **Providers:** `RootProviders` = ToastProvider → QueryProvider → SessionProvider; inside auth: `AppShell` = FinancialYearProvider → WhatsAppPlatformProvider (+ app-level WhatsAppPairingDialog). No theme provider (light only).
- **Routing:** 30+ routes, statically imported (no route-level code splitting). App routes (`/home`, `/sales*`, `/purchases*`, `/proformas*`, `/payments`, `/parties*`, `/accounts`, `/exchange`, `/inventory`, `/financial-year`, `/settings`, `/profile`) behind `RequireAppAccess`; public: `/login`, `/forgot-password`, `/set-password`, `/verify-email`, `/no-access`, `/blocked`, `/profile-setup`, `/setup-store`.
- **Client storage:** zero `localStorage`. sessionStorage keys: `fusion-one.whatsapp-auto-send` (= `"{type}:{invoiceId}"`, auto-send intent) and `convert_proforma` (proforma→sale prefill). Supabase session = cookies via `@supabase/ssr`.
- **API clients:** `platform/supabase/client.ts` (single browser client, publishable key, `detectSessionInUrl:false`); `platform/supabase/setup-client.ts` (isolated per-page client for /set-password: verifyOtp + updateUser + local signOut — never adopts the session); `platform/whatsapp/{url,http,sse,backend,state,types}.ts` — the ONLY backend HTTP layer, base = `VITE_FUSIONONE_BACKEND_BASE` via `waUrl()`; SSE implemented as fetch-streaming with stall watchdogs (45s idle / 10s pairing / 15s connect) and one-shot 401→refresh retry.
- **Env:** `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `VITE_FUSIONONE_BACKEND_BASE` (https://wa.one.fusiongadgets.in). No secrets in the browser bundle.
- **Invalidation:** centralized `features/invalidate.ts` (semantic helpers per module).

### 2.2 Authentication (actual flow)
1. **Session init:** `SessionProvider` — `getSession()` + `onAuthStateChange`; only sessions with `amr[0].method === 'password'` count as app sessions (email-link/OTP sessions are signed out locally once — hygiene).
2. **Access-state machine:** LLOADING → UNAUTHENTICATED / EMAIL_UNVERIFIED (`email_confirmed_at` null) → self-read `public.users (user_type, status, display_name)` under RLS → NO_ACCESS (no provisioned role) / BLOCKED (status≠active) / OWNER_SETUP_REQUIRED (owner + store missing or `onboarding_complete ≠ true`) / READY. `profileComplete` = non-blank `display_name` (no stored flag).
3. **Login:** `signInWithPassword` → redirect by access state; unconfirmed-email errors → `/verify-email`.
4. **Logout:** `auth.signOut()` **global scope** (one-operator-per-browser product decision) + full query-cache + invoice-PDF-cache clear.
5. **Password reset / invitation:** email link → `/set-password?token_hash&type={invite|recovery}` → isolated client `verifyOtp` → `updateUser({password})` → setup session terminated → **always a fresh password login** afterwards.
6. **Profile setup:** READY users with null display_name are redirected to `/profile-setup` (guard-enforced), writing ONLY `users.display_name` (column-level RLS grant).
7. **Owner/user:** `user_type` from the self-read; UI gates (Settings save, WhatsApp delivery panel, Users section, FY set-default) are **UX-only** — enforcement is backend routes + RLS (assumption documented in `features/users/api.ts`).
8. **Guards:** `RequireAppAccess`, `RedirectIfAuthed`, `RequireEmailUnverified`, `RequireNoAccess`, `RequireBlocked`, `RequireOwnerSetup`, `RequireProfileSetup` (guards.tsx).

### 2.3 Business modules (pages / queries / mutations)

| Module | Pages | Queries (keys) | Writes | Notes |
|---|---|---|---|---|
| **Sales** | list, new, detail, edit | `['sales-page',fy]`, `['sale-detail',id]` (4-way parallel) | RPCs `create_sale`, `receive_payment`, `cancel_sale`, `delete_sale`, `create_trade_in_purchase_bill`; dead RPC wrapper `updateSale` (never called) | Edit page does **direct non-atomic** `sale_items`/`sales` updates; trade-in docs → storage bucket `documents` |
| **Purchases** | list, new, detail | `['purchases-page',fy]`, `['purchase-detail',id]` | RPCs `create_purchase`, `pay_purchase` | No cancel/edit/delete UI for purchases |
| **Proformas** | list, new, detail | `['proformas-page',fy]`, `['proforma-detail',id]` | RPC `create_proforma`; direct `proforma_invoices.update({status:'converted'})` on conversion; sessionStorage handoff to /sales/new | No void action (status value exists, unused) |
| **Parties** | list, detail | `['parties']`, `['parties-ledger',fy]`, `['party-detail',id]`, infinite `['party-sales'/'party-purchases']` (DB-paginated, 10/page) | direct `parties.insert/update` | Party balances derived client-side from sales/purchases due; no stored balance |
| **Payments** | single page (In/Out tabs, read-only listing) | `['payments-page',fy]` (parallel payments_in + payments_out) | none on this page — recording happens via PaymentDialog from sales/purchases | See §5 |
| **Financial Years** | list | `['financial-years']`, `['store','current']` | direct `financial_years.insert`; direct `store.update(active_financial_year_id)` (owner); RPC `close_financial_year` (carry-forward) | Closed FY = read-only badge gating all write UIs |
| **Store/Settings** | tabs #profile/#whatsapp | `['store','current']`, `['whatsapp-settings']` | direct `store.update` (+ storage uploads `store_assets`); **partial upserts** on `whatsapp_settings` (singleton) | Template editor = 9-token vocabulary, mirrors backend renderer |
| **Profile/Users** | /profile | `['users']` → backend HTTP; `['app-user',id]` | all user mgmt via backend `/api/users*` (owner) | Manage dialog: role draft dropdown, per-action confirms |
| **WhatsApp** | context + hook + dialog | snapshot `GET /api/status` + SSE `/api/events` | `POST /api/whatsapp/{login,logout,cancelPairing}` | Reconnect backoff 1s→30s; QR only in the dialog |
| **Invoice domain** | (shared) | routes through the same cached detail queries | — | builders → `InvoiceData`; IndexedDB PDF cache `fusionone-invoice-pdfs` (LRU 50, content-hash keys) |
| **Dashboard** | /home | `['dashboard',fy]` fold (4 parallel selects, client-side compute) | — | Dues = Σ stored `sales.due` / `purchases.due` |
| **Accounts/Exchange/Inventory** | pages | `['accounts-page',fy]`, `['account-history',…]`, `['exchange-page',fy]`, `['inventory-page',fy]`, `['in-stock-items',fy]` | direct `bank_accounts`/`payment_modes`/`inventory_items` writes; RPCs `add_funds`, `transfer_funds` | — |

### 2.4 Known frontend facts (factual, not fixed)
- No React Error Boundary anywhere (uncaught render error = white screen).
- No payment receipt PDF/WhatsApp of any kind (grep-verified both repos).
- Dead code: `updateSale`, `features/types/sales.ts` + `purchases.ts` interfaces, `BankAccount`/`PaymentMode` in types/common, `view-model.ts` exports (test-only), `WhatsAppService` interface, `'use client'` directives (Next.js remnant), root `.env` `DATABASE_URL` (no consumer).
- EditSalePage invalidates a non-existent key `['parties-page',fy]` and omits several keys that `invalidateSales` covers.
- A PDF opened right after an edit can be composed from 5-min-stale cached detail unless invalidated/forced.

---

## 3. Backend

### 3.1 Architecture
- Single-process Fastify service. Dev `bun --hot src/index.ts`; prod `tsc → dist → node dist/index.js` (hosted instance's build pipeline UNVERIFIED — no Dockerfile/manifest in repo).
- **Startup order** (app.ts): config (zod, fail-fast) → logger (pino, 30+ redaction paths) → StateMachine (initial `STARTING`) → SessionManager → WhatsAppManager (+ClientPresence) → SecurityManager → SendController → createServer (CORS, auth hook, empty-body JSON parser, error handler, 18 routes) → listen → `SERVER_STATE_CHANGED running` → Watchdog (10s) → Redis prewarm (fire-and-forget) → thumbnail-worker warmup → session-dimension resync (creds.json → PRESENT/NONE) → `STARTING→IDLE` → signal handlers → "Application started".
- **Shutdown** (idempotent): markShuttingDown (+blockSends) → STOPPING + state lock → cancelActive sends (5s bound) → SIGKILL thumbnail worker → stop WhatsApp runtime (listeners removed before `socket.end`; **session PRESERVED**; backup flushed 3s) → SSE closeAll → watchdog stop → server.close → Redis quit → exit 0. Session destruction happens ONLY via logout/security/corruption paths (wipes auth dir + invalidates Redis backup).
- **Config:** 21 env vars (see API.md table): PORT/HOST, SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, SUPABASE_SECRET_KEY (empty ⇒ user-mgmt fails closed), APP_BASE_URL, CLIENT_ORIGIN, WHATSAPP_AUTH_DIR, EXPECTED_WHATSAPP_JID, RECONNECT_BASE/MAX_MS, WHATSAPP_CLIENT_DISCONNECT_GRACE_MS (300s), WHATSAPP_WAKE_TIMEOUT_MS (20s), REDIS_URL (+encryption key ≥16 chars required together), SEND_TIMEOUT_MS (30s), SEND_MAX_RETRIES (3), SEND_RETRY_BASE_MS, MAX_REQUEST_BODY_BYTES (10MB), LOG_LEVEL, PING_TOKEN.
- **Errors:** closed registry, 41 codes (API 8, authorization 10, WhatsApp 7, invoice 8, security 4, server 4); `AppError{code,statusCode,publicMessage,internalDetails(never serialized)}`; Fastify handler maps native 404/413/400/415/405 to canonical codes; unknowns → `SERVER_INTERNAL_ERROR`. 9 codes are documented-but-reserved (never thrown).
- **Routes (18):** `/`, `/health/live`, `/health/ready`, `/ping` (X-Ping-Token, fail-closed) — public; `/api/status`, `/api/events` (SSE) — authorized user; `/api/whatsapp/{login,logout}` — **owner**; `/api/whatsapp/{cancelPairing,sendInvoice}` — authorized user; `/api/users*` (list/invite/:id/role/resend-invite/block/unblock/reset-password/delete) — **owner**.
- **Auth chain (api/auth.ts + authorize.ts):** Bearer JWT → JWKS verify (issuer/aud/ES256|RS256, cached remote key set) → `amr[0].method === 'password'` (else `AUTH_CONTEXT_INVALID`) → email verified live via Supabase `/auth/v1/user` (5s cache, fail-closed) → `public.users` self-read via **user-context client** (RLS) → user_type owner|user + status active. `requireOwner` adds user_type='owner'.
- **User management** (service-role client only): invite (native email → `APP_BASE_URL/set-password`, then upsert users row to 'user' — the only NULL-role resolution path), resend = delete-pending-account + fresh invite, block/unblock (status; enforced per-request at 3 layers, NOT session revocation), reset (native recovery email), role change (full chain incl. never-zero-owners: backend count-check + DB trigger + requester≠target), remove (admin delete; FK cascade).

### 3.2 Supabase integration (the ONE boundary: `src/supabase/clients.ts`)
- `getUserClient(accessToken)` — publishable key + caller JWT, **LRU-bounded Map (16)**, `persistSession:false`. Used by authorize.ts (users self-read) + invoice/repository.ts (ALL business reads). RLS is the boundary.
- `getAdminClient()` — lazy singleton, **SUPABASE_SECRET_KEY**; null when unset ⇒ user-mgmt fails closed (`SERVER_NOT_READY`). Used ONLY in api/user-management.ts.
- `getMailClient()` — publishable-key singleton for native auth emails (reset). No other Supabase clients exist (grep-verified).
- Backend table access (complete): sales, sale_items, trade_ins, purchases, purchase_items, proforma_invoices, proforma_invoice_items, proforma_trade_ins, store, whatsapp_settings, users (+ Auth admin API). **No payments_in/payments_out access anywhere in the backend.**

### 3.3 Invoice pipeline (`src/invoice/`)
`sendInvoiceById` (send.ts): dispatch by type → repository loads under **caller's JWT** (RLS; deterministic store resolution: 0 rows=`STORE_NOT_CONFIGURED`, >1=`STORE_CONFIGURATION_AMBIGUOUS`) → builders map rows → canonical `InvoiceData` (numeric coercion; sale: rate=base_selling_price||sold_price, item_discount folding, displayed subtotal=Σrate) → recipient = `party.number` → Indian-JID normalize (missing=`PARTY_PHONE_MISSING`, invalid=`WHATSAPP_RECIPIENT_INVALID`) → template = `whatsapp_settings.{type}_message_template` (missing/empty=`WHATSAPP_TEMPLATE_MISSING`, **no fallback**) → 9-token renderer (unknown tokens → '') → **PDF + thumbnail generated concurrently** from the same data → SendController → returns `{success, requestId, messageId?}`.

### 3.4 Ownership boundaries
- Fastify/HTTP/auth/user-mgmt/SSE/watchdog = backend-level. Baileys socket, QR, session material, reconnect, security = WhatsApp subsystem (`src/whatsapp/` + session/state machinery). Redis = session-backup only. PDF/thumbnail = invoice pipeline. No cross-contamination: WhatsAppManager is the only socket owner; SessionBackup the only Redis consumer; repository the only business-data reader.

---

## 4. Supabase (live production DB)

### 4.1 Schema
- **Extensions:** btree_gist 1.7 (+ platform defaults: pg_stat_statements, pgcrypto, plpgsql, supabase_vault, uuid-osss). **No pg_cron, pg_net, pgmq.**
- **Schemas:** public (22 tables), private (5 functions only), platform schemas (auth/storage/realtime/graphql/extensions/vault/pgbouncer).
- **Public tables (22):** `account_fund_entries, account_transactions, account_transfers, bank_accounts, financial_years, inventory_items, parties, payment_modes, payments_in, payments_out, proforma_invoice_items, proforma_invoices, proforma_trade_ins, purchase_items, purchases, sale_items, sales, schema_migrations, store, trade_ins, users, whatsapp_settings`.
- **No views, no sequences, no identity/generated columns anywhere.** Key constraints: `financial_years` EXCLUDE GiST `fy_no_overlap` (daterange &&); partial unique `idx_unique_imei_in_stock (fy, imei) WHERE status='in_stock'`; `store.singleton SMALLINT=1 + UNIQUE`; `whatsapp_settings.singleton` same; `users` CHECKs (user_type ∈ {owner,user}, status ∈ {active,blocked}, owner never blocked, display_name NULL-or-trimmed-1..80). FKs: users.id→auth.users CASCADE; sale_items.sale_id, purchase_items.purchase_id, trade_ins.sale_id, proforma_* CASCADE; all others NO ACTION. **payments_in.sale_id / payments_out.purchase_id are nullable FKs** (unlinked payments representable, but live data is 100% linked).
- **Functions:** 17 public SECURITY INVOKER RPCs (`add_funds, allocate_bill_numbers, cancel_sale, close_financial_year, complete_store_setup, create_proforma, create_purchase, create_sale, create_trade_in_purchase_bill, delete_sale, pay_purchase, receive_payment, transfer_funds, update_sale` + FY label helpers) + 5 private SECURITY DEFINER functions **all with `SET search_path=''`**: `can_access_app`, `is_owner` (both: provisioned role + active status + verified email + **JWT amr password-context**), `handle_new_auth_user` (provisions NULL user_type, fail-closed), `trim_users_display_name`, `users_owner_invariant` (never-zero-active-owners).
- **Triggers:** 3 on public.users (display-name trim; owner-invariant UPDATE OF user_type,status / DELETE, WHEN-scoped) + 1 on auth.users (provisioning). **No triggers on financial_years or any business table.**
- **Live data volume:** sales 4, purchases 5 (incl. hidden trade-in bills), payments_in 5, payments_out 5, proformas 1, parties 8, inventory 18, bank_accounts 2, payment_modes 3, FYs 2 (2026-27 active+used; 2027-28 pre-created empty), trade_ins 0.

### 4.2 Security
- **RLS enabled on all 22 public tables** (+ storage.objects). 27 public policies: 18 business tables = single `app_user_access FOR ALL TO authenticated USING/WITH CHECK private.can_access_app()`; `store` + `whatsapp_settings` = shared read (can_access_app) + owner-only insert/update (is_owner), no delete; `users` = self-read + owner-read-all + **self-update display_name only** (column-level GRANT enforced); schema_migrations = no grants to API roles. 8 storage policies (store_assets: read all/write owner; documents: read+write all app users). anon = deny-all.
- **Private schema:** USAGE to authenticated only (not anon/public/service_role).
- **Drift vs migrations 0001–0005:** none except platform-injected `public.rls_auto_enable()` + `ensure_rls` event trigger (auto-enables RLS on new public tables; benign). `users_single_owner` index correctly absent (dropped by 0005 for multi-owner).
- **Buckets:** `documents`, `store_assets` — both **public-read CDN, no size/MIME limits** (factual risk note). Objects: only store logo (65KB jpeg) + signature (7.6KB png); documents bucket empty.

### 4.3 Auth relationship (verified live)
`auth.users` (2 rows) → provisioning trigger → `public.users` (2 rows: 1 owner active `h***@fusiongadgets.in` display "Wamiq"; 1 user active `s***@gmail.com`). Zero orphans. Application access = `can_access_app()` = provisioned role + active + **email_confirmed_at** + **JWT amr password context**. Role changes only via service-role (backend) or DB trigger guard.

### 4.4 Store
Singleton row: FUSION GADGETS (Bahraich address, phone, email, website, gstin stored as empty string), `onboarding_complete=true`, `active_financial_year_id` → FY 2026-27, logo/signature on public CDN URLs. **No `invoice_templates` column live** (removal confirmed). No delivery-related fields on store.

### 4.5 Payments (live structures)
- `payments_in`: id, **sale_id (nullable FK)**, party_id, amount NUMERIC(12,2), bank_account_id, payment_mode_id (nullable — NULL for cash), date, financial_year_id, created_at. **No notes/reference/created_by; no updated_at (immutable).** Index on sale_id.
- `payments_out`: mirror with purchase_id.
- `account_transactions` (16 rows): bank_account_id, payment_mode_id, type CHECK(credit/debit), amount, date, **reference_type CHECK(sale|purchase|payment_in|payment_out|add_funds|transfer|opening_balance|sale_cancelled)**, reference_id (polymorphic, no FK), financial_year_id, notes (all NULL), transfer_group_id, created_at.
- **Dual ledger-reference pattern (verified per row):** payment-at-creation → ledger row references the *document* (`sale`/`purchase`); later payment → ledger row references the *payment row* (`payment_in`/`payment_out`). Live data: 4+1 / 4+1 split; **every payment covered exactly once, 0 orphans** — but any ledger aggregation must handle both patterns.
- **No delivery-tracking columns anywhere** (no sent_at/receipt/whatsapp/pdf fields; searched all columns).

### 4.6 Invoice balance — actual source of truth
**Stored columns `sales.paid`/`sales.due` and `purchases.paid`/`purchases.due`, maintained transactionally by the RPCs** (create_* writes client-computed values; receive_payment/pay_purchase do `paid += amt, due -= amt` under `FOR UPDATE` lock with a `> due` guard). No view/function computes balances; parties carry no balance column (derived client-side). **Live consistency verified: 0 mismatches** between stored paid and Σpayments for all sales/purchases; `paid + due = final_total` holds everywhere; all live documents fully settled. `payments_*` tables are a transaction log, read only by the Payments listing page.

### 4.7 Financial years + numbering
FY counters (`sale_counter`, `purchase_counter`, `proforma_counter`) incremented **inside the create RPCs under FY row lock** (formats: `SAL-2026-27-0001`, `PUR-…`, hidden trade-in `PUR-TRD-…`, recovery `PUR-<yy>-…`, `PI-…`). `allocate_bill_numbers` RPC exists but is **unused by app code**. Live counters match documents except **proforma_counter=2 vs 1 surviving proforma** (one number consumed by a since-deleted document). Two FYs may both be status='active' simultaneously (no constraint prevents it).

### 4.8 whatsapp_settings (live)
Singleton: `auto_send_sale=true`, `auto_send_purchase=false`, `auto_send_proforma=false`; 3 NOT-NULL templates with defaults (purchase/proforma contain `\r\n` line endings — data-quality note); never updated since import. Auto-send flags are read ONLY by the frontend arming logic; the backend reads templates at send time and ignores the auto_send booleans.

---

## 5. Payment Flows

### 5.1 Payment In (complete trace)
1. **Entry (invoice-bound only — no free-standing payment creation):** sales list row ⋮ "Receive Payment" or sale-detail sidebar → `PaymentDialog invoiceType="sale"`. Visibility: `!FYclosed && !cancelled && due > 0`. The Payments page itself is **read-only**.
2. **Dialog fields:** amount (prefilled = due), date (today, FY-clamped), bank account (required), payment mode (required iff non-cash account). **No notes/reference field.**
3. **Client validation** (toasts): date in FY; bank required; mode for non-cash; 0 < amount ≤ due.
4. **Mutation:** `receivePayment` → `supabase.rpc('receive_payment', {p_sale_id, p_amount, p_date, p_bank_account_id, p_payment_mode_id})`.
5. **RPC `receive_payment` (migrations/0003, single atomic transaction):** ① `SELECT … FOR UPDATE` on the sale (locks; `'Sale not found'`) ② guard `amount ≤ due` ③ `UPDATE sales SET paid += , due -=` ④ `INSERT payments_in (sale_id, party_id, amount, bank_account_id, payment_mode_id, date, financial_year_id)` ⑤ `INSERT account_transactions (type='credit', reference_type='payment_in', reference_id=payment_id, …)`.
6. **After creation (frontend):** success toast; dialog closes; semantic invalidation (`invalidateSales`: sales-page, sale-detail, party-sales, parties-ledger, payments-page, exchange-page, accounts-page, account-history, dashboard). **No navigation, no backend call, no PDF, no WhatsApp — nothing else happens.**
7. **Server-side gaps (factual):** RPC does not re-validate amount > 0, FY date range, or sale status — client-side only.

### 5.2 Payment Out
Identical shape via `payPurchase` → RPC `pay_purchase` (locks purchase; updates purchases.paid/due; inserts payments_out; inserts account_transactions `debit/payment_out`). UI labels: "Pay Party" / "Record Payment". Payment-at-creation (`create_purchase`, `paid>0`) additionally writes the `purchase`-referenced ledger row + payments_out row.
**Trade-in quirk:** hidden trade-in purchases and recovery bills are created with `paid=credit_value, due=0` and **no** payments_out/account_transactions rows (credit is a virtual payment; no money moves).

### 5.3 Delivery matrix (verified)

| Document | Auto-send | Manual send | PDF (FE) | PDF (BE) | Caption template | Recipient |
|---|---|---|---|---|---|---|
| Sale invoice | YES (if `auto_send_sale`) | YES | YES | YES | `sale_message_template` | party.number→JID |
| Purchase bill | YES (if `auto_send_purchase`; live=false) | YES | YES | YES | `purchase_message_template` | same |
| Proforma | YES (if `auto_send_proforma`; live=false) | YES | YES | YES | `proforma_message_template` | same |
| Payment In | **NO** | **NO** | **NO** | **NO** | — | — |
| Payment Out | **NO** | **NO** | **NO** | **NO** | — | — |

---

## 6. Invoice Flows

### 6.1 Sale invoice lifecycle
1. **Create** (`NewSalePage` → `createSale` → RPC `create_sale`, atomic): FY lock → stock check (items must be in_stock) → trade-in IMEI uniqueness vs in-stock → bill number from `sale_counter+1` (+`purchase_counter += n_trade_ins`) → INSERT `sales` (status active; **paid/due are client-computed**) → INSERT `sale_items` → mark items sold → per trade-in: hidden `purchases` (PUR-TRD-…, paid=credit, due=0) + `inventory_items` (in_stock, source=trade_in) + `purchase_items` + `trade_ins` → if paid>0: `account_transactions` (credit/sale) + `payments_in`. Trade-in documents uploaded beforehand to storage `documents` (failure non-fatal).
2. **Post-create (frontend):** toast; **auto-send arming** — `sessionStorage['fusion-one.whatsapp-auto-send'] = "sale:{id}"` iff `whatsapp_settings.auto_send_sale`; proforma-conversion completion (separate direct update `status='converted'`, errors silently ignored); invalidations; navigate to `/sales/{id}`.
3. **Auto-send consumption** (detail page mount, `InvoiceWhatsAppShare`): key must equal `{type}:{id}` → **removed BEFORE sending** (no double-send, and **no retry if the send fails**) → `postSendInvoice({invoiceId, invoiceType})`.
4. **Manual send:** detail-sidebar button or list ⋮ Share → same call. Body is only `{invoiceId, invoiceType, requestId?}` — **backend owns data, recipient, caption, PDF, delivery** (§3.3, §8).
5. **Detail-page PDF:** frontend pdfkit render (§7.1) through shared query cache + IndexedDB content-hash cache; "Regenerate" bypasses cache.
6. **Edit:** direct non-atomic writes (per-item sold_price loop + sales update; items/trade-ins locked; due recomputed client-side). The transactional `update_sale` RPC exists but is dead code.
7. **Cancel** (RPC `cancel_sale`, atomic): status→cancelled (number preserved) → restock items → **per payments_in row: compensating `account_transactions` debit (`reference_type='sale_cancelled'`, dated today, references the sale id)**; payments_in rows retained; sales.paid/due NOT reset → trade-in handling (delete if still in stock; cancel its purchase if resold; returns `resold` list driving a recovery banner → `create_trade_in_purchase_bill`).
8. **Delete** (RPC `delete_sale`): only when paid=0 and all trade-ins still in stock; hard-deletes the graph and restocks.

### 6.2 Purchase bill
`create_purchase` (atomic; PUR- numbering; creates inventory_items in_stock; payment-at-creation pattern) → auto-send arm (`purchase:{id}`) → detail page (PDF + Pay + Send; **no cancel/edit/delete UI**).

### 6.3 Proforma
`create_proforma` (atomic; PI- numbering; free-text items + trade-in credit lines; **no payment fields at all**; paid=0/due=final_total by construction) → auto-send arm → detail page (PDF + Send + **Convert to Sale** via sessionStorage handoff; conversion marked inside the sale-create flow). No void action exists.

### 6.4 Frontend-triggered vs backend-owned
- **Frontend-triggered:** every create/edit/cancel/payment (Supabase RPCs), PDF view/download/print, send initiation (manual + auto-send intent), delivery-settings editing.
- **Backend-owned (once triggered):** invoice data load (caller-JWT/RLS), recipient normalization, template resolution, PDF composition, thumbnail, transport (queueing=mutex serialization, retries, timeout), delivery result events, entire WhatsApp runtime.

---

## 7. PDF Generation

### 7.1 Frontend PDF (`src/features/invoice/renderers/pdfkit.ts`)
- **Library:** browser pdfkit 0.20 (dynamic import + `registerStdFonts` Helvetica AFMs), output validated by `%PDF-` magic.
- **Entry points:** detail-page render (`useInvoicePdf` → `buildInvoicePdf`), download (`downloadInvoicePdf` → `{bill_number}.pdf`), print (hidden-iframe), list quick-actions.
- **Data source:** `loadInvoiceData(id, type)` through the **shared TanStack cache** (same fetchers as detail pages) → builders → `InvoiceData`.
- **Design:** ONE template (Prestige). Layout constants + colors + SVG icons + fonts duplicated from (calibrated against) the backend spec; own `fmt`/`numberToWords` (Indian Lakh/Crore).
- **Output handling:** Blob; **cache:** module Map + IndexedDB `fusionone-invoice-pdfs` (content-hash keys `v{1}:{type}:{id}:{digest}`, LRU 50, cleared on sign-out).
- **Used by:** sale/purchase/proforma detail view, Save PDF, Print, list row actions. **No payment document support** (InvoiceType union is sale|purchase|proforma).

### 7.2 Backend PDF (`backend/src/invoice/pdf.ts` + `prestige.ts` + `thumbnail.ts`)
- **Library:** Node pdfkit; `prestige.ts` is the shared visual spec (colors, full pt-geometry, icons, table headers, title/billing labels, fmt) — serialized into the thumbnail worker so the two cannot drift.
- **Entry point:** `sendInvoiceById` only (WhatsApp leg). No download endpoint.
- **Features:** A4 margin-0, buffered pages, pagination with repeated table headers + "Continued on next page…" + `Page i of N` footers, trade-in sections, 'Product Discount' conditional row, font-metric-centered grand-total bar, signature-image centering, logo/signature fetch with magic-byte sniffing (8s abort, imageless fallback), en/em-dash substitution (U+2212 not WinAnsi-safe).
- **Thumbnail (`thumbnail.ts`):** NOT derived from the PDF — parallel canvas render in a persistent plain-Node child (Bun segfaults @napi-rs/canvas), same spec, 444×≤250px JPEG, quality ladder 100/90/80, 64KB soft cap, complete-row cropping, 10s job timeout, crash-isolated respawn, **failure never blocks the send** (PDF-only).
- **Parity:** frontend and backend renderers produce content-identical PDFs (verified in pdf-align-1; only document /ID differs).

### 7.3 Reusable for a future payment document (inventory, not design)
Both renderers are driven by the single `InvoiceData` model + per-type builders; `prestige.ts` centralizes geometry; the thumbnail worker and the cache key scheme are type-parameterized. Adding a payment document type would mean: new builder, new template tokens, route/schema extension — the layout/render/transport layers are type-agnostic. **Nothing payment-specific exists today.**

---

## 8. WhatsApp / Delivery

### 8.1 The WhatsApp subsystem (inside the backend)
- **WhatsAppManager** (sole Baileys socket owner): multi-file auth state; socket config (qrTimeout 60s = the only QR rotation; keepAlive 30s; browser label 'FUSION ONE Backend'); single-flight startup (one socket at a time; wake never pairs, login escalates); candidate resolution local→Redis (QR-during-CONNECTING or security-code = candidate rejected; exhaustion → one deterministic destroy); close-handler classification (security codes {401,403,411,440,500} fail-closed from authenticated states; transient {428,408,515,503} → reconnect backoff 1s→60s +jitter; PAIRING never goes RECONNECTING); `sendDocumentMessage` = **one message: `{document, mimetype:application/pdf, fileName, caption?, jpegThumbnail?, thumbnailWidth/Height}`**.
- **Lifecycle states (9):** STARTING, IDLE, PAIRING, CONNECTING, CONNECTED, RECONNECTING, LOGGING_OUT, SECURITY_INVALIDATED, STOPPING + session dimension NONE|PRESENT|RESTORING (PRESENT only after validated connection). Only LOGGING_OUT→IDLE and SECURITY_INVALIDATED→IDLE destroy material.
- **Demand-driven runtime (ClientPresence):** first authenticated SSE client → wake (session-preserving, never pairs); last client → 5-min grace → intentional stop (session preserved). Sends also count as demand.
- **Session persistence:** primary = local auth dir; secondary = **Redis Cloud, AES-256-GCM (scrypt key), single key `fusionone:whatsapp:session:backup`**, file whitelist, debounced saves (2s/10s), recovery only when local material missing, generation-guarded invalidation.
- **Security:** SecurityManager + 10s Watchdog (identity pin `EXPECTED_WHATSAPP_JID`, auth-dir isolation, sendsBlocked invariants); any security failure → SECURITY_INVALIDATED → session destroyed → Baileys OFF until explicit owner login (fail-closed, never self-heals).
- **SSE:** every event broadcast to all authenticated clients; 30s keepalives; observer-only (disconnects never change backend state). 6 event types: SERVER_STATE_CHANGED, WHATSAPP_STATE_CHANGED, WHATSAPP_QR_AVAILABLE, WHATSAPP_QR_COUNTDOWN, SEND_INVOICE_RESULT, SECURITY_EVENT.
- **Send pipeline (SendController):** AsyncMutex (concurrency 1) → operational gate → wake-on-demand (bounded 20s) → per-attempt timeout 30s → retries **only** `WHATSAPP_SEND_FAILED`, ≤3 attempts, exponential backoff + jitter, abort checks between retries. Result via SEND_INVOICE_RESULT event.
- **Request contract (strict zod):** `{invoiceId: uuid, invoiceType: string, requestId?}` — `.strict()`, legacy image-payload keys explicitly rejected with a removal message.

### 8.2 What the delivery flow does NOT have
No server-side triggers (all sends browser-initiated), no delivery-status persistence (nothing is written back to the DB after a send; the result exists only as an event + HTTP response), no per-invoice send history, no retry of failed auto-sends, no delivery dedup beyond the single-flight mutex + browser sessionStorage key consumption.

---

## 9. Infrastructure / Sandbox

- **Container entrypoint `/start.sh`:** platform bootstrap → restores workspace → invokes `.zscripts/dev.sh` as user `z` (the workspace's own idempotent script; falls back to platform default scaffold logic only if absent).
- **`.zscripts/dev.sh` (idempotent, port-guarded):** installs node_modules only when missing; starts backend (`bun run dev` = `bun --hot`, :3001) and Vite (:3000) only if their ports are free; health checks; mini-services loop (directory currently **empty** — `.gitkeep` only); logs to `.zscripts/{dev,frontend,backend}.log`. Restart-safe (re-run converges; verified in prior sessions).
- **Gateway (platform Caddy, immutable /app):** `:81 → localhost:3000` (preview root = the SPA). The root `Caddyfile` is a reference doc of this topology. No local proxying to the backend — **the browser calls `https://wa.one.fusiongadgets.in` directly, cross-origin** (CORS: hosted instance currently allows the preview origins; repo guidance documents exact-origin for production).
- **Local backend (:3001):** development instance only; the SPA does not use it (env points at the hosted instance).
- **Redis:** external Redis Cloud (`*.db.redis.io:14213`) — **no local Redis**; used solely by SessionBackup (§8.1). Known free-tier client-cap noise during hot-reload cycles (pre-existing, degrades gracefully).
- **Currently running:** caddy (:81), Vite (:3000), backend bun --hot (:3001). systemd: none (processes are shell-spawned by dev.sh).
- **Env files:** root `.env.local` (3 VITE_* keys), `backend/.env` (21 keys incl. REDIS_URL + encryption key), `database/tools/.env` (TEST project DB URL — tooling only). All force-committed to the sandbox root git (never pushed).
- **Deploy of the hosted backend:** UNVERIFIED (worklog says Render; no manifest in either repo).

---

## 10. Event / Background Infrastructure

**Nothing durable exists.** Verified in code and live DB:

| Mechanism | Status |
|---|---|
| DB triggers on business tables | NONE (only users-display-trim, owner-invariant, auth provisioning) |
| Outbox/event/jobs/schedules tables | NONE in any schema |
| pg_cron | NOT installed |
| pg_net / DB webhooks / supabase_functions | NOT installed / no triggers reference them |
| pgmq / queues | NONE |
| Supabase Realtime | publication exists but **empty** — zero application tables published; realtime.messages=0 |
| Edge Functions | no `supabase/functions` dir in either repo; not checkable from DB (deployment state UNVERIFIED, but nothing in the repos) |
| Backend schedulers/cron | NONE (no node-cron etc.); `/ping` exists **for** an external cron/keepalive — whether one is configured in production is UNVERIFIED |
| Background workers | thumbnail worker (in-process child, send-time only); Watchdog (10s invariants); QR countdown (1s, pairing only); SSE keepalives (30s); reconnect/backoff timers; Redis backup debounce — **all in-process, all die with the process, nothing persists or resumes work** |
| Durable retry | NONE (SendController retries live only within the HTTP request lifetime) |

The **only** "automation" state that exists is: `whatsapp_settings.auto_send_*` booleans (read exclusively by the **frontend** arming logic) + the browser sessionStorage intent key. Auto-send therefore requires: the creating browser to still be open, navigation to the detail page, and WhatsApp connected at that moment.

---

## 11. End-to-End Flow Maps (current reality)

### Invoice sending (manual or auto-armed)
```
[auto] create RPC returns → NewSalePage sets sessionStorage intent (only if auto_send_*=true)
[manual] user clicks Send via WhatsApp (detail sidebar / list ⋮)
   → POST https://wa.one.fusiongadgets.in/api/whatsapp/sendInvoice  {invoiceId, invoiceType}  + Bearer JWT
   → backend: JWKS verify → amr=password → email-verified → users row → (owner|user)
   → repository: sales/sale_items/trade_ins/store/whatsapp_settings under CALLER's JWT (RLS)
   → builders → InvoiceData
   → recipient: party.number → 91XXXXXXXXXX@s.whatsapp.net   (missing/invalid → 400)
   → caption: whatsapp_settings.{type}_message_template → 9-token render (missing → 503)
   → PDF (pdfkit, Prestige) ∥ thumbnail (canvas worker)  — both from InvoiceData
   → SendController: mutex → wake-if-needed → sendDocumentMessage (1 PDF + caption + jpeg preview)
   → WhatsApp delivers; SEND_INVOICE_RESULT event on SSE; frontend toasts success/failure
   → NOTHING is written back to the database (no delivery record)
```

### Payment creation (In shown; Out is the mirror)
```
user (sales list/detail) → PaymentDialog (amount ≤ due, date, bank, mode)
   → supabase.rpc('receive_payment')  [single atomic transaction]
        UPDATE sales (paid+=, due-=)  →  INSERT payments_in  →  INSERT account_transactions (credit/payment_in)
   → toast + React-Query invalidations.  END.
   (no backend call, no PDF, no WhatsApp, no delivery record — verified)
```

### Manual send (any deliverable document)
Identical to the invoice-sending path above — there is exactly ONE delivery pipeline, entered only via `POST /api/whatsapp/sendInvoice`.

---

## 12. Reusable Infrastructure (for future receipt/reminder work — inventory only)

| Component | Current responsibility | Reusable as-is? | Already exposes |
|---|---|---|---|
| Backend send pipeline (`invoice/send.ts` + SendController + WhatsAppManager) | compose + deliver one document message | Yes — transport stage is document-agnostic once a builder/template exist | `{requestId, recipient, pdfBuffer, fileName, caption, thumbnail}` input contract; result events; retry/timeout/mutex |
| Backend PDF renderer (`pdf.ts` + `prestige.ts`) | Prestige invoice PDF from `InvoiceData` | Yes — type-parameterized builders; layout spec is data-driven | pagination, asset embedding, magic-byte validation; deterministic output |
| Thumbnail worker | send-time JPEG preview | Yes (any document data with row geometry) | isolated worker, spec serialization, never-blocks-send |
| Invoice repository (user-JWT Supabase reads) | load sale/purchase/proforma + store + settings | Pattern yes; **payments are not readable by the backend today** (no code, no route) | RLS-scoped loaders, store resolution, error codes |
| `whatsapp_settings` + partial-upsert UI | 3 templates + 3 auto-send flags | Yes — singleton upsert pattern, token editor vocabulary (9 tokens), per-card owner gate | storage format, editor UX; adding fields is additive |
| SSE event system | 6 event types, closed registry | Yes — zod-validated envelopes; adding a type is additive | broadcast to all authed clients, keepalives |
| Supabase transactional RPC pattern | all business writes | Yes — proven atomic pattern incl. ledger + counter updates | FOR UPDATE locking, multi-table atomicity, error strings surfaced to UI |
| ClientPresence + wake/grace | keep Baileys alive while clients watch | Yes (runtime availability for any server-side send) | demand tracking, 5-min grace |
| Redis client infra (SessionBackup) | encrypted session backup ONLY | Pattern only — no queue/pubsub usage exists; Redis is available and connected | bounded-command retry, encryption, singleton client |
| Frontend invoice PDF cache + viewer | view/download/print invoices | Yes — content-hash keys are type-parameterized | LRU IDB cache, pdf.js viewer, print/download actions |
| `InvoiceWhatsAppShare` + auto-send intent | manual send button + one-shot auto-send on detail mount | Pattern only — payment UI does not exist | intent-key protocol `{type}:{id}`, consume-before-send |

**Explicit gaps (would need to be built, nothing exists):** payment data access in the backend; a payment/receipt document builder + template tokens; any scheduling/queue/outbox mechanism; any delivery-status persistence; any reminder concept.

---

## 13. Current Architectural Observations (facts only)

1. **All delivery is browser-initiated.** Auto-send = sessionStorage intent consumed on the detail page; there is no server-side trigger of any kind. A closed browser = no auto-send. A failed auto-send is never retried (key removed before send).
2. **Payment creation triggers nothing** beyond the atomic Supabase RPC + cache invalidation — no receipt PDF, no WhatsApp message, no backend call, no delivery record. Payment receipts/reminders are greenfield.
3. **PDF generation exists twice, intentionally:** frontend (view/download/print, IDB-cached) and backend (send pipeline only), calibrated to content parity, both single-template Prestige, both data-driven from `InvoiceData`.
4. **WhatsApp delivery is backend-owned once triggered** (data, recipient, template, PDF, transport, retries) — but the backend receives only `{invoiceId, invoiceType}` and writes nothing back; delivery results are ephemeral events.
5. **No durable event/outbox/scheduler exists anywhere** (DB, backend, Supabase platform features unused: realtime empty, no pg_cron/pg_net/Edge Functions). All timers are in-process and die with the process.
6. **The DB's only delivery-adjacent state** is `whatsapp_settings` (3 flags + 3 templates). There are no per-document sent/delivered columns — delivery state is currently unrepresentable in the schema.
7. **Invoice balance source of truth = stored `sales.paid/due` + `purchases.paid/due` columns**, maintained by transactional RPCs; live data verified 0-mismatch. Payments tables are a log. Party balances are client-side derived. Integrity depends on callers using RPCs — RLS permits direct authenticated writes to payments tables, which could desync balances (currently zero drift).
8. **The backend cannot read payments today** (no code path, no route) — any future automatic receipt delivery needs new backend data access.
9. `receive_payment`/`pay_purchase` re-validate only the due-ceiling server-side; amount>0, FY-date-range, and document-status checks are client-side only.
10. **Known dead/drifted code (not fixed, per audit scope):** `update_sale` RPC + wrapper (unused; edit page does non-atomic direct writes and invalidates a non-existent key); `allocate_bill_numbers` unused; API.md drift (undocumented `/api/users/:id/role`, stale `GET /api/users` description, no §4 section for cancelPairing, `session` field missing from command-response examples, CORS header list understated); `view-model.ts` exports test-only; no React Error Boundary; proforma counter gap (2 allocated / 1 document); both storage buckets public-read with no size/MIME limits.
11. **The hosted backend's deployment/version parity is UNVERIFIED** (no manifest in the repo) — all backend facts in this document are from the repo source; the local :3001 instance matches the repo by construction.
12. The infrastructure can support server-side background processing **architecturally** (a persistent Node process + Redis + Supabase service access all exist), but **no such machinery exists today** — it would be new build, not a reuse.

---

## Verification Appendix

- **Frontend:** ~60 source files read (all of src/pages, src/features, src/platform, src/components, configs). Grep-verified negatives: no localStorage, no Zustand, no ErrorBoundary, no payment-PDF/WhatsApp, no receipt code.
- **Backend:** all 35 src files (8,557 lines) + package.json/tsconfig/.env.example/API.md read; grep-verified negatives: no cron/queue/outbox/webhook/Edge-Function/payments access/email-transporter; Redis importers = 1 file.
- **Database:** read-only SQL against pg_catalog + business data on the live project (extensions, schemas, tables, columns, constraints, indexes, functions incl. bodies, triggers, RLS/policies, grants, column privileges, buckets/objects, auth.users/public.users, store, whatsapp_settings, payments/ledger reconciliation, FY counters, realtime publication, schema_migrations). Migration-vs-live drift table: all MATCH except one benign platform-injected object.
- **Infrastructure:** /start.sh, .zscripts/{dev.sh,start.sh}, Caddyfile (+ platform /app/Caddyfile behavior), running processes, port map, env files (key names), mini-services (empty).
- **Could NOT be verified:** hosted backend deployment/version (no manifest, external service); whether an external cron pings `/ping` in production; Supabase dashboard-level Auth config (SMTP, redirect allow-lists, applied email templates); Edge Function deployment state (nothing in repos, not SQL-visible); runtime behavior of the hosted instance (all live-DB facts are catalog/data facts).
