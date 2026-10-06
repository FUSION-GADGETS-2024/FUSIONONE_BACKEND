-- ============================================================
-- FUSIONONE — TEST database rebuild — 0002 Tables
-- ============================================================
-- Reconstructed from the actual application + backend usage (the 20-table
-- contract verified by the FRONTEND_ARCHITECTURE_AUDIT query/mutation
-- inventories) and the reference bootstrap SQL.
--
-- Deliberate decisions:
--  * The production-only drift columns (pdf_path, pdf_generated_at,
--    pdf_template_version on sales/purchases/proforma_invoices) are NOT
--    recreated: they are written by an unknown external process in the
--    PRODUCTION project only, are read by neither the frontend nor the
--    FUSION ONE backend, and the rebuild spec forbids migrating stale
--    material blindly. (Documented in MIGRATION_REPORT.md.)
--  * created_at columns are kept wherever the reference bootstrap defined
--    them (the app orders inventory_items by created_at).
-- ============================================================

-- ─── Financial years (one active at a time) ────────────────────────────────

CREATE TABLE financial_years (
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

-- ─── Store profile (one per owner user) ────────────────────────────────────

CREATE TABLE store (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id UUID NOT NULL,
  name TEXT NOT NULL,
  address TEXT,
  phone TEXT NOT NULL,
  email TEXT,
  website TEXT,
  gstin TEXT,
  logo_url TEXT,
  signature_url TEXT,
  onboarding_complete BOOLEAN DEFAULT false,
  active_financial_year_id UUID REFERENCES financial_years(id),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ─── Banking ───────────────────────────────────────────────────────────────

CREATE TABLE bank_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  is_cash BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE payment_modes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bank_account_id UUID NOT NULL REFERENCES bank_accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL
);

-- ─── Parties (customers + suppliers) ───────────────────────────────────────

CREATE TABLE parties (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  number TEXT,
  address TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ─── Inventory (IMEI-tracked) ──────────────────────────────────────────────

CREATE TABLE inventory_items (
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
  financial_year_id UUID NOT NULL REFERENCES financial_years(id),
  created_at TIMESTAMPTZ DEFAULT now(),
  origin_inventory_item_id UUID,
  opening_entry_type TEXT CHECK (opening_entry_type IN ('direct', 'carried_forward'))
);

-- Only one IN-STOCK item per IMEI per financial year (duplicate-IMEI
-- protection). Deliberately scoped per-FY: the close-year flow COPIES unsold
-- stock into the next FY while the original rows stay in_stock in the closed
-- year — the reference app's GLOBAL partial index made that flow impossible
-- (latent contradiction in the original schema; the app-level duplicate
-- checks query in-stock IMEIs globally, so real protection is unchanged).
CREATE UNIQUE INDEX idx_unique_imei_in_stock ON inventory_items(financial_year_id, imei) WHERE status = 'in_stock';
ALTER TABLE inventory_items ADD CONSTRAINT fk_origin_item
  FOREIGN KEY (origin_inventory_item_id) REFERENCES inventory_items(id);

-- ─── Purchases ─────────────────────────────────────────────────────────────

CREATE TABLE purchases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_number TEXT NOT NULL,
  party_id UUID NOT NULL REFERENCES parties(id),
  total NUMERIC(12, 2) NOT NULL,
  paid NUMERIC(12, 2) NOT NULL DEFAULT 0,
  due NUMERIC(12, 2) NOT NULL DEFAULT 0,
  bank_account_id UUID NOT NULL REFERENCES bank_accounts(id),
  payment_mode_id UUID REFERENCES payment_modes(id),
  date DATE NOT NULL,
  financial_year_id UUID NOT NULL REFERENCES financial_years(id),
  status TEXT NOT NULL CHECK (status IN ('active', 'cancelled')),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE purchase_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_id UUID NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  inventory_item_id UUID NOT NULL REFERENCES inventory_items(id)
);

-- ─── Sales ─────────────────────────────────────────────────────────────────

CREATE TABLE sales (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_number TEXT NOT NULL,
  party_id UUID NOT NULL REFERENCES parties(id),
  total NUMERIC(12, 2) NOT NULL,
  discount NUMERIC(12, 2) NOT NULL DEFAULT 0,
  trade_in_credit NUMERIC(12, 2) NOT NULL DEFAULT 0,
  final_total NUMERIC(12, 2) NOT NULL,
  paid NUMERIC(12, 2) NOT NULL DEFAULT 0,
  due NUMERIC(12, 2) NOT NULL DEFAULT 0,
  bank_account_id UUID NOT NULL REFERENCES bank_accounts(id),
  payment_mode_id UUID REFERENCES payment_modes(id),
  date DATE NOT NULL,
  financial_year_id UUID NOT NULL REFERENCES financial_years(id),
  status TEXT NOT NULL CHECK (status IN ('active', 'cancelled')),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE sale_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id UUID NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  inventory_item_id UUID NOT NULL REFERENCES inventory_items(id),
  sold_price NUMERIC(12, 2) NOT NULL
);

-- ─── Trade-ins ─────────────────────────────────────────────────────────────

CREATE TABLE trade_ins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id UUID NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  brand TEXT NOT NULL,
  model TEXT NOT NULL,
  imei TEXT NOT NULL,
  ram_rom TEXT,
  color TEXT,
  credit_value NUMERIC(12, 2) NOT NULL,
  mrp NUMERIC(12, 2),
  document_url TEXT,
  new_inventory_item_id UUID REFERENCES inventory_items(id)
);

-- ─── Payments ──────────────────────────────────────────────────────────────

CREATE TABLE payments_in (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id UUID REFERENCES sales(id),
  party_id UUID NOT NULL REFERENCES parties(id),
  amount NUMERIC(12, 2) NOT NULL,
  bank_account_id UUID NOT NULL REFERENCES bank_accounts(id),
  payment_mode_id UUID REFERENCES payment_modes(id),
  date DATE NOT NULL,
  financial_year_id UUID NOT NULL REFERENCES financial_years(id),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE payments_out (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_id UUID REFERENCES purchases(id),
  party_id UUID NOT NULL REFERENCES parties(id),
  amount NUMERIC(12, 2) NOT NULL,
  bank_account_id UUID NOT NULL REFERENCES bank_accounts(id),
  payment_mode_id UUID REFERENCES payment_modes(id),
  date DATE NOT NULL,
  financial_year_id UUID NOT NULL REFERENCES financial_years(id),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ─── Account ledger ────────────────────────────────────────────────────────

CREATE TABLE account_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bank_account_id UUID NOT NULL REFERENCES bank_accounts(id),
  payment_mode_id UUID REFERENCES payment_modes(id),
  type TEXT NOT NULL CHECK (type IN ('credit', 'debit')),
  amount NUMERIC(12, 2) NOT NULL,
  date DATE NOT NULL,
  reference_type TEXT NOT NULL CHECK (reference_type IN (
    'sale', 'purchase', 'payment_in', 'payment_out',
    'add_funds', 'transfer', 'opening_balance', 'sale_cancelled'
  )),
  reference_id UUID NOT NULL,
  financial_year_id UUID NOT NULL REFERENCES financial_years(id),
  notes TEXT,
  transfer_group_id UUID,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE account_fund_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bank_account_id UUID NOT NULL REFERENCES bank_accounts(id),
  amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  date DATE NOT NULL,
  notes TEXT,
  financial_year_id UUID NOT NULL REFERENCES financial_years(id),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE account_transfers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_bank_account_id UUID NOT NULL REFERENCES bank_accounts(id),
  to_bank_account_id UUID NOT NULL REFERENCES bank_accounts(id),
  amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  date DATE NOT NULL,
  notes TEXT,
  financial_year_id UUID NOT NULL REFERENCES financial_years(id),
  created_at TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT transfer_different_accounts CHECK (from_bank_account_id != to_bank_account_id)
);

-- ─── Proformas (quotations) ────────────────────────────────────────────────

CREATE TABLE proforma_invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_number TEXT NOT NULL,
  party_id UUID NOT NULL REFERENCES parties(id),
  total NUMERIC(12, 2) NOT NULL,
  discount NUMERIC(12, 2) NOT NULL DEFAULT 0,
  trade_in_credit NUMERIC(12, 2) NOT NULL DEFAULT 0,
  final_total NUMERIC(12, 2) NOT NULL,
  date DATE NOT NULL,
  financial_year_id UUID NOT NULL REFERENCES financial_years(id),
  status TEXT NOT NULL CHECK (status IN ('active', 'converted', 'void')) DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE proforma_invoice_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  proforma_invoice_id UUID NOT NULL REFERENCES proforma_invoices(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  qty INTEGER NOT NULL DEFAULT 1,
  rate NUMERIC(12, 2) NOT NULL,
  discount NUMERIC(12, 2) NOT NULL DEFAULT 0,
  value NUMERIC(12, 2) NOT NULL
);

CREATE TABLE proforma_trade_ins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  proforma_invoice_id UUID REFERENCES proforma_invoices(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  qty INTEGER,
  rate NUMERIC(12, 2) NOT NULL,
  value NUMERIC(12, 2) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ─── WhatsApp delivery settings (per owner) ────────────────────────────────

CREATE TABLE whatsapp_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id UUID NOT NULL REFERENCES auth.users(id) UNIQUE,
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
  updated_at TIMESTAMPTZ DEFAULT now()
);
