-- ============================================================
-- FUSIONONE — 0002 Schema (tables, constraints, indexes)
-- ============================================================
-- Clean reconstruction of the CURRENT application schema, derived from
-- a full forensic dump of the live TEST database (source of truth) —
-- NOT from the archived patch history in database/old/.
--
-- Structural decisions (matching the live architecture):
--   * public.users is the application-user table; the role is a single
--     column users.user_type ∈ {owner, user, NULL} (NULL = unprovisioned,
--     fail-closed). There is deliberately NO second role/boolean column.
--   * users.status ∈ {active, blocked} is the account-access state,
--     independent of the role; the owner can never be blocked (CHECK).
--   * Exactly one owner — enforced by the partial unique index
--     users_single_owner (not by application code).
--   * Exactly one store and one whatsapp_settings row — enforced by a
--     fixed singleton key column + CHECK + UNIQUE index (not .limit(1)).
--   * store/whatsapp_settings carry NO owner_user_id: public.users.user_type
--     is the only authorization source (shared store, shared settings).
--   * users.display_name is the profile-completion field: NULL/empty =
--     incomplete; a CHECK enforces 1..80 chars after trimming; no
--     profile_completed boolean, no auto-generation from email.
--   * Email verification stays authoritative in auth.users.email_confirmed_at
--     (read live by the private helpers in 0003) — no duplicate flag.
--   * The production-only drift columns (sales/purchases/proforma_invoices
--     .pdf_path/.pdf_generated_at/.pdf_template_version) and
--     store.invoice_templates are obsolete and intentionally absent.
--   * Every business table is UUID-keyed with gen_random_uuid() defaults;
--     there are no sequences or identity columns to synchronize.

-- ─── Financial years (no two may overlap) ───────────────────────────────────

CREATE TABLE public.financial_years (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'closed')),
  sale_counter INTEGER NOT NULL DEFAULT 0,
  purchase_counter INTEGER NOT NULL DEFAULT 0,
  proforma_counter INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT fy_date_check CHECK (start_date < end_date),
  CONSTRAINT fy_no_overlap EXCLUDE USING gist (
    daterange(start_date, end_date, '[]') WITH &&
  )
);

-- ─── Store profile (single shared store — owner-only mutation via RLS) ─────

CREATE TABLE public.store (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  address TEXT,
  phone TEXT NOT NULL,
  email TEXT,
  website TEXT,
  gstin TEXT,
  logo_url TEXT,
  signature_url TEXT,
  onboarding_complete BOOLEAN DEFAULT false,
  active_financial_year_id UUID REFERENCES public.financial_years(id),
  created_at TIMESTAMPTZ DEFAULT now(),
  singleton SMALLINT NOT NULL DEFAULT 1
    CONSTRAINT store_singleton_key CHECK (singleton = 1)
);

-- At most one store row: every row must hold the singleton key 1 and
-- only one row may hold it.
CREATE UNIQUE INDEX store_singleton ON public.store (singleton);

-- ─── Banking ───────────────────────────────────────────────────────────────

CREATE TABLE public.bank_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  is_cash BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE public.payment_modes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bank_account_id UUID NOT NULL REFERENCES public.bank_accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL
);

-- ─── Parties (customers + suppliers) ───────────────────────────────────────

CREATE TABLE public.parties (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  number TEXT,
  address TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ─── Inventory (IMEI-tracked) ──────────────────────────────────────────────

CREATE TABLE public.inventory_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand TEXT NOT NULL,
  model TEXT NOT NULL,
  imei TEXT NOT NULL,
  ram_rom TEXT,
  color TEXT,
  purchase_price NUMERIC(12, 2) NOT NULL,
  base_selling_price NUMERIC(12, 2) NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('in_stock', 'sold')),
  source TEXT NOT NULL CHECK (source IN ('purchase', 'trade_in')),
  financial_year_id UUID NOT NULL REFERENCES public.financial_years(id),
  created_at TIMESTAMPTZ DEFAULT now(),
  origin_inventory_item_id UUID,
  opening_entry_type TEXT CHECK (opening_entry_type IN ('direct', 'carried_forward'))
);

-- Only one IN-STOCK item per IMEI per financial year. Deliberately
-- scoped per-FY: the close-year flow COPIES unsold stock into the next
-- FY while the original rows stay in_stock in the closed year.
CREATE UNIQUE INDEX idx_unique_imei_in_stock
  ON public.inventory_items (financial_year_id, imei)
  WHERE status = 'in_stock';

ALTER TABLE public.inventory_items ADD CONSTRAINT fk_origin_item
  FOREIGN KEY (origin_inventory_item_id) REFERENCES public.inventory_items(id);

-- ─── Purchases ─────────────────────────────────────────────────────────────

CREATE TABLE public.purchases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_number TEXT NOT NULL,
  party_id UUID NOT NULL REFERENCES public.parties(id),
  total NUMERIC(12, 2) NOT NULL,
  paid NUMERIC(12, 2) NOT NULL DEFAULT 0,
  due NUMERIC(12, 2) NOT NULL DEFAULT 0,
  bank_account_id UUID NOT NULL REFERENCES public.bank_accounts(id),
  payment_mode_id UUID REFERENCES public.payment_modes(id),
  date DATE NOT NULL,
  financial_year_id UUID NOT NULL REFERENCES public.financial_years(id),
  status TEXT NOT NULL CHECK (status IN ('active', 'cancelled')),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE public.purchase_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_id UUID NOT NULL REFERENCES public.purchases(id) ON DELETE CASCADE,
  inventory_item_id UUID NOT NULL REFERENCES public.inventory_items(id)
);

-- ─── Sales ─────────────────────────────────────────────────────────────────

CREATE TABLE public.sales (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_number TEXT NOT NULL,
  party_id UUID NOT NULL REFERENCES public.parties(id),
  total NUMERIC(12, 2) NOT NULL,
  discount NUMERIC(12, 2) NOT NULL DEFAULT 0,
  trade_in_credit NUMERIC(12, 2) NOT NULL DEFAULT 0,
  final_total NUMERIC(12, 2) NOT NULL,
  paid NUMERIC(12, 2) NOT NULL DEFAULT 0,
  due NUMERIC(12, 2) NOT NULL DEFAULT 0,
  bank_account_id UUID NOT NULL REFERENCES public.bank_accounts(id),
  payment_mode_id UUID REFERENCES public.payment_modes(id),
  date DATE NOT NULL,
  financial_year_id UUID NOT NULL REFERENCES public.financial_years(id),
  status TEXT NOT NULL CHECK (status IN ('active', 'cancelled')),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE public.sale_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id UUID NOT NULL REFERENCES public.sales(id) ON DELETE CASCADE,
  inventory_item_id UUID NOT NULL REFERENCES public.inventory_items(id),
  sold_price NUMERIC(12, 2) NOT NULL
);

-- ─── Trade-ins ─────────────────────────────────────────────────────────────

CREATE TABLE public.trade_ins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id UUID NOT NULL REFERENCES public.sales(id) ON DELETE CASCADE,
  brand TEXT NOT NULL,
  model TEXT NOT NULL,
  imei TEXT NOT NULL,
  ram_rom TEXT,
  color TEXT,
  credit_value NUMERIC(12, 2) NOT NULL,
  mrp NUMERIC(12, 2),
  document_url TEXT,
  new_inventory_item_id UUID REFERENCES public.inventory_items(id)
);

-- ─── Payments ──────────────────────────────────────────────────────────────

CREATE TABLE public.payments_in (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id UUID REFERENCES public.sales(id),
  party_id UUID NOT NULL REFERENCES public.parties(id),
  amount NUMERIC(12, 2) NOT NULL,
  bank_account_id UUID NOT NULL REFERENCES public.bank_accounts(id),
  payment_mode_id UUID REFERENCES public.payment_modes(id),
  date DATE NOT NULL,
  financial_year_id UUID NOT NULL REFERENCES public.financial_years(id),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE public.payments_out (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_id UUID REFERENCES public.purchases(id),
  party_id UUID NOT NULL REFERENCES public.parties(id),
  amount NUMERIC(12, 2) NOT NULL,
  bank_account_id UUID NOT NULL REFERENCES public.bank_accounts(id),
  payment_mode_id UUID REFERENCES public.payment_modes(id),
  date DATE NOT NULL,
  financial_year_id UUID NOT NULL REFERENCES public.financial_years(id),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ─── Account ledger ────────────────────────────────────────────────────────

CREATE TABLE public.account_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bank_account_id UUID NOT NULL REFERENCES public.bank_accounts(id),
  payment_mode_id UUID REFERENCES public.payment_modes(id),
  type TEXT NOT NULL CHECK (type IN ('credit', 'debit')),
  amount NUMERIC(12, 2) NOT NULL,
  date DATE NOT NULL,
  reference_type TEXT NOT NULL CHECK (reference_type IN (
    'sale', 'purchase', 'payment_in', 'payment_out',
    'add_funds', 'transfer', 'opening_balance', 'sale_cancelled'
  )),
  reference_id UUID NOT NULL,
  financial_year_id UUID NOT NULL REFERENCES public.financial_years(id),
  notes TEXT,
  transfer_group_id UUID,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE public.account_fund_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bank_account_id UUID NOT NULL REFERENCES public.bank_accounts(id),
  amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  date DATE NOT NULL,
  notes TEXT,
  financial_year_id UUID NOT NULL REFERENCES public.financial_years(id),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE public.account_transfers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_bank_account_id UUID NOT NULL REFERENCES public.bank_accounts(id),
  to_bank_account_id UUID NOT NULL REFERENCES public.bank_accounts(id),
  amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  date DATE NOT NULL,
  notes TEXT,
  financial_year_id UUID NOT NULL REFERENCES public.financial_years(id),
  created_at TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT transfer_different_accounts CHECK (from_bank_account_id != to_bank_account_id)
);

-- ─── Proformas (quotations) ────────────────────────────────────────────────

CREATE TABLE public.proforma_invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_number TEXT NOT NULL,
  party_id UUID NOT NULL REFERENCES public.parties(id),
  total NUMERIC(12, 2) NOT NULL,
  discount NUMERIC(12, 2) NOT NULL DEFAULT 0,
  trade_in_credit NUMERIC(12, 2) NOT NULL DEFAULT 0,
  final_total NUMERIC(12, 2) NOT NULL,
  date DATE NOT NULL,
  financial_year_id UUID NOT NULL REFERENCES public.financial_years(id),
  status TEXT NOT NULL CHECK (status IN ('active', 'converted', 'void')) DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE public.proforma_invoice_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  proforma_invoice_id UUID NOT NULL REFERENCES public.proforma_invoices(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  qty INTEGER NOT NULL DEFAULT 1,
  rate NUMERIC(12, 2) NOT NULL,
  discount NUMERIC(12, 2) NOT NULL DEFAULT 0,
  value NUMERIC(12, 2) NOT NULL
);

CREATE TABLE public.proforma_trade_ins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  proforma_invoice_id UUID REFERENCES public.proforma_invoices(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  qty INTEGER,
  rate NUMERIC(12, 2) NOT NULL,
  value NUMERIC(12, 2) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ─── WhatsApp delivery settings (single shared row for the one store) ──────

CREATE TABLE public.whatsapp_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  auto_send_sale BOOLEAN NOT NULL DEFAULT false,
  auto_send_purchase BOOLEAN NOT NULL DEFAULT false,
  auto_send_proforma BOOLEAN NOT NULL DEFAULT false,
  sale_message_template TEXT NOT NULL DEFAULT
    'Hello {{customer_name}},

Please find your invoice {{invoice_number}} from {{company_name}} attached.

Total: ₹{{grand_total}}

Thank you for your business.',
  purchase_message_template TEXT NOT NULL DEFAULT
    'Hello {{customer_name}},

Please find your purchase bill {{invoice_number}} from {{company_name}} attached.

Total: ₹{{grand_total}}',
  proforma_message_template TEXT NOT NULL DEFAULT
    'Hello {{customer_name}},

Please find your quotation {{invoice_number}} from {{company_name}} attached.

Estimated Total: ₹{{grand_total}}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  singleton SMALLINT NOT NULL DEFAULT 1
    CONSTRAINT whatsapp_settings_singleton_key CHECK (singleton = 1)
);

CREATE UNIQUE INDEX whatsapp_settings_singleton ON public.whatsapp_settings (singleton);

-- ─── Application users (public.users mirrors auth.users) ───────────────────
-- id references auth.users (Supabase-managed schema): one row per Auth user,
-- provisioned automatically with user_type = NULL (fail-closed) by the
-- trigger in 0003. Role management happens ONLY through the trusted
-- server-side path (backend owner administration) — the browser has no
-- INSERT/UPDATE/DELETE path (see the policies and column grants in 0004).

CREATE TABLE public.users (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  -- The one application role field. NULL = unprovisioned (no access).
  user_type TEXT CHECK (user_type IN ('owner', 'user')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Account access state, independent of the role. Blocked = locked out
  -- (enforced by the authorization helpers, the backend and the frontend).
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'blocked')),
  -- Profile display name. NULL/whitespace = profile incomplete. Never an
  -- authorization field; trimmed by the trigger in 0003.
  display_name TEXT
);

-- Exactly one owner — database-enforced.
CREATE UNIQUE INDEX users_single_owner
  ON public.users (user_type)
  WHERE user_type = 'owner';

-- The owner account can never be blocked (an owner lockout would orphan
-- the store).
ALTER TABLE public.users ADD CONSTRAINT users_owner_never_blocked
  CHECK (user_type IS DISTINCT FROM 'owner' OR status = 'active');

-- Stored display_name must be NULL or a real 1..80 char name after trim.
ALTER TABLE public.users ADD CONSTRAINT users_display_name_check CHECK (
  display_name IS NULL
  OR (
    length(btrim(display_name)) > 0
    AND length(btrim(display_name)) <= 80
  )
);

-- ─── Hot-path indexes (foreign keys + list filters) ────────────────────────

CREATE INDEX idx_sales_party_id ON public.sales(party_id);
CREATE INDEX idx_sales_date ON public.sales(date);
CREATE INDEX idx_sales_status ON public.sales(status);
CREATE INDEX idx_sales_fy ON public.sales(financial_year_id);
CREATE INDEX idx_purchases_party_id ON public.purchases(party_id);
CREATE INDEX idx_purchases_date ON public.purchases(date);
CREATE INDEX idx_purchases_status ON public.purchases(status);
CREATE INDEX idx_purchases_fy ON public.purchases(financial_year_id);
CREATE INDEX idx_inventory_status ON public.inventory_items(status);
CREATE INDEX idx_inventory_fy ON public.inventory_items(financial_year_id);
CREATE INDEX idx_payments_in_sale ON public.payments_in(sale_id);
CREATE INDEX idx_payments_out_purchase ON public.payments_out(purchase_id);
CREATE INDEX idx_account_tx_date ON public.account_transactions(date);
CREATE INDEX idx_account_tx_ref ON public.account_transactions(reference_type, reference_id);
CREATE INDEX idx_account_tx_account_fy ON public.account_transactions(bank_account_id, financial_year_id);
CREATE INDEX idx_proforma_status ON public.proforma_invoices(status);
CREATE INDEX idx_proforma_date ON public.proforma_invoices(date);
CREATE INDEX idx_proforma_fy ON public.proforma_invoices(financial_year_id);
CREATE INDEX idx_trade_ins_sale ON public.trade_ins(sale_id);
CREATE INDEX idx_purchase_items_inventory ON public.purchase_items(inventory_item_id);
CREATE INDEX idx_sale_items_inventory ON public.sale_items(inventory_item_id);
