-- ============================================================
-- FUSION ONE — canonical production schema 04: tables
-- ============================================================
-- All 25 public tables with their full column definitions,
-- defaults, generated search columns, CHECK constraints,
-- PRIMARY/UNIQUE keys, EXCLUDE constraints and FOREIGN KEYS.
--
-- Statement order (already dependency-safe):
--   1. CREATE TABLE statements (25) — inline CHECK constraints
--      and generated columns (private.search_norm/search_tokens
--      from 03 must already exist);
--   2. ADD CONSTRAINT statements — primary keys, unique keys,
--      the financial-year EXCLUDE constraint, then foreign keys.
--
-- The final document architecture is enforced here:
--   * party_documents is the ONE document entity (owned by
--     parties, envelope-encryption metadata, active/archived
--     lifecycle);
--   * trade_ins carries ONLY transactional facts — NO
--     document_url and NO document_id (both removed by the
--     final architecture; sales/proformas/exchanges carry no
--     document concept at all).
--
-- Requires: 01 (extensions), 02 (schemas), 03 (helper functions).
-- Fresh-build semantics: tables are created, never altered here.
-- ============================================================

-- TABLE: message_jobs
CREATE TABLE public.message_jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    job_type text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    sale_id uuid,
    purchase_id uuid,
    proforma_id uuid,
    payment_in_id uuid,
    payment_out_id uuid,
    run_at timestamp with time zone DEFAULT now() NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    max_attempts integer DEFAULT 5 NOT NULL,
    claimed_by text,
    claimed_at timestamp with time zone,
    claim_expires_at timestamp with time zone,
    started_at timestamp with time zone,
    finished_at timestamp with time zone,
    message_id text,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT message_jobs_job_type_check CHECK ((job_type = ANY (ARRAY['invoice_send'::text, 'reminder'::text, 'receipt'::text, 'statement'::text]))),
    CONSTRAINT message_jobs_max_attempts_check CHECK (((max_attempts >= 1) AND (max_attempts <= 20))),
    CONSTRAINT message_jobs_ref_shape CHECK ((((job_type = 'invoice_send'::text) AND (((sale_id IS NOT NULL) AND (purchase_id IS NULL) AND (proforma_id IS NULL) AND (payment_in_id IS NULL) AND (payment_out_id IS NULL)) OR ((sale_id IS NULL) AND (purchase_id IS NOT NULL) AND (proforma_id IS NULL) AND (payment_in_id IS NULL) AND (payment_out_id IS NULL)) OR ((sale_id IS NULL) AND (purchase_id IS NULL) AND (proforma_id IS NOT NULL) AND (payment_in_id IS NULL) AND (payment_out_id IS NULL)))) OR ((job_type = 'reminder'::text) AND (sale_id IS NOT NULL) AND (purchase_id IS NULL) AND (proforma_id IS NULL) AND (payment_in_id IS NULL) AND (payment_out_id IS NULL)) OR ((job_type = 'receipt'::text) AND (sale_id IS NULL) AND (purchase_id IS NULL) AND (proforma_id IS NULL) AND (((payment_in_id IS NOT NULL) AND (payment_out_id IS NULL)) OR ((payment_in_id IS NULL) AND (payment_out_id IS NOT NULL)))) OR ((job_type = 'statement'::text) AND (proforma_id IS NULL) AND (payment_in_id IS NULL) AND (payment_out_id IS NULL) AND (((sale_id IS NOT NULL) AND (purchase_id IS NULL)) OR ((sale_id IS NULL) AND (purchase_id IS NOT NULL)))))),
    CONSTRAINT message_jobs_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'processing'::text, 'succeeded'::text, 'failed'::text, 'cancelled'::text])))
);

-- TABLE: financial_years
CREATE TABLE public.financial_years (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    start_date date NOT NULL,
    end_date date NOT NULL,
    status text NOT NULL,
    sale_counter integer DEFAULT 0 NOT NULL,
    purchase_counter integer DEFAULT 0 NOT NULL,
    proforma_counter integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT financial_years_status_check CHECK ((status = ANY (ARRAY['active'::text, 'closed'::text]))),
    CONSTRAINT fy_date_check CHECK ((start_date < end_date))
);

-- TABLE: account_fund_entries
CREATE TABLE public.account_fund_entries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    bank_account_id uuid NOT NULL,
    amount numeric(12,2) NOT NULL,
    date date NOT NULL,
    notes text,
    financial_year_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT account_fund_entries_amount_check CHECK ((amount > (0)::numeric))
);

-- TABLE: account_transactions
CREATE TABLE public.account_transactions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    bank_account_id uuid NOT NULL,
    payment_mode_id uuid,
    type text NOT NULL,
    amount numeric(12,2) NOT NULL,
    date date NOT NULL,
    reference_type text NOT NULL,
    reference_id uuid NOT NULL,
    financial_year_id uuid NOT NULL,
    notes text,
    transfer_group_id uuid,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT account_transactions_reference_type_check CHECK ((reference_type = ANY (ARRAY['sale'::text, 'purchase'::text, 'payment_in'::text, 'payment_out'::text, 'add_funds'::text, 'transfer'::text, 'opening_balance'::text, 'sale_cancelled'::text]))),
    CONSTRAINT account_transactions_type_check CHECK ((type = ANY (ARRAY['credit'::text, 'debit'::text])))
);

-- TABLE: account_transfers
CREATE TABLE public.account_transfers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    from_bank_account_id uuid NOT NULL,
    to_bank_account_id uuid NOT NULL,
    amount numeric(12,2) NOT NULL,
    date date NOT NULL,
    notes text,
    financial_year_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT account_transfers_amount_check CHECK ((amount > (0)::numeric)),
    CONSTRAINT transfer_different_accounts CHECK ((from_bank_account_id <> to_bank_account_id))
);

-- TABLE: bank_accounts
CREATE TABLE public.bank_accounts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    is_cash boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);

-- TABLE: inventory_items
CREATE TABLE public.inventory_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    brand text NOT NULL,
    model text NOT NULL,
    imei text NOT NULL,
    ram_rom text,
    color text,
    purchase_price numeric(12,2) NOT NULL,
    base_selling_price numeric(12,2) NOT NULL,
    status text NOT NULL,
    source text NOT NULL,
    financial_year_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    origin_inventory_item_id uuid,
    opening_entry_type text,
    brand_n text GENERATED ALWAYS AS (private.search_norm(brand)) STORED,
    model_n text GENERATED ALWAYS AS (private.search_norm(model)) STORED,
    tokens_n text GENERATED ALWAYS AS (private.search_tokens(((((((((brand || ' '::text) || model) || ' '::text) || imei) || ' '::text) || COALESCE(ram_rom, ''::text)) || ' '::text) || COALESCE(color, ''::text)))) STORED,
    search_n text GENERATED ALWAYS AS (private.search_norm(((((((((brand || ' '::text) || model) || ' '::text) || imei) || ' '::text) || COALESCE(ram_rom, ''::text)) || ' '::text) || COALESCE(color, ''::text)))) STORED,
    CONSTRAINT inventory_items_opening_entry_type_check CHECK ((opening_entry_type = ANY (ARRAY['direct'::text, 'carried_forward'::text]))),
    CONSTRAINT inventory_items_source_check CHECK ((source = ANY (ARRAY['purchase'::text, 'trade_in'::text]))),
    CONSTRAINT inventory_items_status_check CHECK ((status = ANY (ARRAY['in_stock'::text, 'sold'::text])))
);

-- TABLE: parties
CREATE TABLE public.parties (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    number text,
    address text,
    created_at timestamp with time zone DEFAULT now(),
    name_n text GENERATED ALWAYS AS (private.search_norm(name)) STORED,
    tokens_n text GENERATED ALWAYS AS (private.search_tokens(((name || ' '::text) || COALESCE(address, ''::text)))) STORED,
    search_n text GENERATED ALWAYS AS (private.search_norm(((((name || ' '::text) || COALESCE(number, ''::text)) || ' '::text) || COALESCE(address, ''::text)))) STORED
);

-- TABLE: party_documents
CREATE TABLE public.party_documents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    party_id uuid NOT NULL,
    file_name text NOT NULL,
    mime_type text NOT NULL,
    file_size bigint NOT NULL,
    checksum_sha256 text NOT NULL,
    storage_key text NOT NULL,
    encryption_alg text DEFAULT 'AES-256-GCM'::text NOT NULL,
    key_version integer DEFAULT 1 NOT NULL,
    encrypted_dek text NOT NULL,
    dek_iv text NOT NULL,
    dek_tag text NOT NULL,
    file_iv text NOT NULL,
    file_tag text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    archived_at timestamp with time zone,
    CONSTRAINT party_documents_status_check CHECK ((status = ANY (ARRAY['active'::text, 'archived'::text])))
);

-- COMMENT: TABLE party_documents
COMMENT ON TABLE public.party_documents IS 'Party documents: a reusable document owned by one party (identity/declaration documents used by trade-ins). Files live encrypted in the private R2 bucket; this row carries the metadata + envelope-encryption material.';

-- TABLE: payment_modes
CREATE TABLE public.payment_modes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    bank_account_id uuid NOT NULL,
    name text NOT NULL
);

-- TABLE: payments_in
CREATE TABLE public.payments_in (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    sale_id uuid,
    party_id uuid NOT NULL,
    amount numeric(12,2) NOT NULL,
    bank_account_id uuid NOT NULL,
    payment_mode_id uuid,
    date date NOT NULL,
    financial_year_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);

-- TABLE: payments_out
CREATE TABLE public.payments_out (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    purchase_id uuid,
    party_id uuid NOT NULL,
    amount numeric(12,2) NOT NULL,
    bank_account_id uuid NOT NULL,
    payment_mode_id uuid,
    date date NOT NULL,
    financial_year_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);

-- TABLE: proforma_invoice_items
CREATE TABLE public.proforma_invoice_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    proforma_invoice_id uuid NOT NULL,
    description text,
    qty integer DEFAULT 1 NOT NULL,
    rate numeric(12,2) NOT NULL,
    discount numeric(12,2) DEFAULT 0 NOT NULL,
    value numeric(12,2) NOT NULL,
    inventory_item_id uuid,
    CONSTRAINT proforma_item_source_check CHECK ((((inventory_item_id IS NOT NULL) AND (description IS NULL)) OR ((inventory_item_id IS NULL) AND (description IS NOT NULL))))
);

-- TABLE: proforma_invoices
CREATE TABLE public.proforma_invoices (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    bill_number text NOT NULL,
    party_id uuid NOT NULL,
    total numeric(12,2) NOT NULL,
    discount numeric(12,2) DEFAULT 0 NOT NULL,
    trade_in_credit numeric(12,2) DEFAULT 0 NOT NULL,
    final_total numeric(12,2) NOT NULL,
    date date NOT NULL,
    financial_year_id uuid NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT proforma_invoices_status_check CHECK ((status = ANY (ARRAY['active'::text, 'converted'::text, 'void'::text])))
);

-- TABLE: proforma_trade_ins
CREATE TABLE public.proforma_trade_ins (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    proforma_invoice_id uuid,
    description text NOT NULL,
    qty integer,
    rate numeric(12,2) NOT NULL,
    value numeric(12,2) NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);

-- TABLE: purchase_items
CREATE TABLE public.purchase_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    purchase_id uuid NOT NULL,
    inventory_item_id uuid NOT NULL
);

-- TABLE: purchases
CREATE TABLE public.purchases (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    bill_number text NOT NULL,
    party_id uuid NOT NULL,
    total numeric(12,2) NOT NULL,
    paid numeric(12,2) DEFAULT 0 NOT NULL,
    due numeric(12,2) DEFAULT 0 NOT NULL,
    bank_account_id uuid NOT NULL,
    payment_mode_id uuid,
    date date NOT NULL,
    financial_year_id uuid NOT NULL,
    status text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT purchases_status_check CHECK ((status = ANY (ARRAY['active'::text, 'cancelled'::text])))
);

-- TABLE: reminder_settings
CREATE TABLE public.reminder_settings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    sale_id uuid NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    frequency_days integer NOT NULL,
    max_reminders integer NOT NULL,
    reminders_sent integer DEFAULT 0 NOT NULL,
    last_reminder_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT reminder_settings_frequency_days_check CHECK (((frequency_days >= 1) AND (frequency_days <= 365))),
    CONSTRAINT reminder_settings_max_reminders_check CHECK (((max_reminders >= 1) AND (max_reminders <= 50))),
    CONSTRAINT reminder_settings_reminders_sent_check CHECK ((reminders_sent >= 0))
);

-- TABLE: sale_items
CREATE TABLE public.sale_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    sale_id uuid NOT NULL,
    inventory_item_id uuid NOT NULL,
    sold_price numeric(12,2) NOT NULL
);

-- TABLE: sales
CREATE TABLE public.sales (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    bill_number text NOT NULL,
    party_id uuid NOT NULL,
    total numeric(12,2) NOT NULL,
    discount numeric(12,2) DEFAULT 0 NOT NULL,
    trade_in_credit numeric(12,2) DEFAULT 0 NOT NULL,
    final_total numeric(12,2) NOT NULL,
    paid numeric(12,2) DEFAULT 0 NOT NULL,
    due numeric(12,2) DEFAULT 0 NOT NULL,
    bank_account_id uuid NOT NULL,
    payment_mode_id uuid,
    date date NOT NULL,
    financial_year_id uuid NOT NULL,
    status text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    proforma_id uuid,
    CONSTRAINT sales_status_check CHECK ((status = ANY (ARRAY['active'::text, 'cancelled'::text])))
);

-- TABLE: schema_migrations
CREATE TABLE public.schema_migrations (
    version text NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL
);

-- TABLE: store
CREATE TABLE public.store (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    address text,
    phone text NOT NULL,
    email text,
    website text,
    gstin text,
    logo_url text,
    signature_url text,
    onboarding_complete boolean DEFAULT false,
    active_financial_year_id uuid,
    created_at timestamp with time zone DEFAULT now(),
    singleton smallint DEFAULT 1 NOT NULL,
    CONSTRAINT store_singleton_key CHECK ((singleton = 1))
);

-- TABLE: trade_ins
CREATE TABLE public.trade_ins (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    sale_id uuid NOT NULL,
    credit_value numeric(12,2) NOT NULL,
    mrp numeric(12,2),
    inventory_item_id uuid NOT NULL
);

-- TABLE: users
CREATE TABLE public.users (
    id uuid NOT NULL,
    user_type text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    display_name text,
    CONSTRAINT users_display_name_check CHECK (((display_name IS NULL) OR ((length(btrim(display_name)) > 0) AND (length(btrim(display_name)) <= 80)))),
    CONSTRAINT users_owner_never_blocked CHECK (((user_type IS DISTINCT FROM 'owner'::text) OR (status = 'active'::text))),
    CONSTRAINT users_status_check CHECK ((status = ANY (ARRAY['active'::text, 'blocked'::text]))),
    CONSTRAINT users_user_type_check CHECK ((user_type = ANY (ARRAY['owner'::text, 'user'::text])))
);

-- TABLE: whatsapp_settings
CREATE TABLE public.whatsapp_settings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    auto_send_sale boolean DEFAULT false NOT NULL,
    auto_send_purchase boolean DEFAULT false NOT NULL,
    auto_send_proforma boolean DEFAULT false NOT NULL,
    sale_message_template text DEFAULT 'Hello {{customer_name}},

Please find your invoice {{invoice_number}} from {{company_name}} attached.

Total: ₹{{grand_total}}

Thank you for your business.'::text NOT NULL,
    purchase_message_template text DEFAULT 'Hello {{customer_name}},

Please find your purchase bill {{invoice_number}} from {{company_name}} attached.

Total: ₹{{grand_total}}'::text NOT NULL,
    proforma_message_template text DEFAULT 'Hello {{customer_name}},

Please find your quotation {{invoice_number}} from {{company_name}} attached.

Estimated Total: ₹{{grand_total}}'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    singleton smallint DEFAULT 1 NOT NULL,
    payment_in_message_template text DEFAULT 'Hello {{customer_name}},

We have received a payment of ₹{{payment_amount}} on {{payment_date}} against invoice {{invoice_number}}.

Remaining balance: ₹{{balance_due}}

Thank you for your business.'::text NOT NULL,
    payment_out_message_template text DEFAULT 'Hello {{customer_name}},

This is a confirmation of the payment of ₹{{payment_amount}} made to you on {{payment_date}} against bill {{invoice_number}}.

Remaining balance: ₹{{balance_due}}'::text NOT NULL,
    reminder_message_template text DEFAULT 'Hello {{customer_name}},

This is a friendly reminder for invoice {{invoice_number}} dated {{invoice_date}}.

Balance due: ₹{{balance_due}}

Please complete the payment at your earliest convenience.

Thank you for your business.'::text NOT NULL,
    auto_send_receipt_in boolean DEFAULT false NOT NULL,
    auto_send_receipt_out boolean DEFAULT false NOT NULL,
    payment_statement_in_message_template text DEFAULT 'Hello {{customer_name}},

Please find attached the payment statement for invoice {{invoice_number}}.

Total paid: ₹{{total_paid}}
Balance due: ₹{{balance_due}}

Thank you for your business.'::text NOT NULL,
    payment_statement_out_message_template text DEFAULT 'Hello {{customer_name}},

Please find attached the payment statement for bill {{invoice_number}}.

Total paid: ₹{{total_paid}}
Balance due: ₹{{balance_due}}'::text NOT NULL,
    CONSTRAINT whatsapp_settings_singleton_key CHECK ((singleton = 1))
);

-- CONSTRAINT: account_fund_entries account_fund_entries_pkey
ALTER TABLE ONLY public.account_fund_entries
    ADD CONSTRAINT account_fund_entries_pkey PRIMARY KEY (id);

-- CONSTRAINT: account_transactions account_transactions_pkey
ALTER TABLE ONLY public.account_transactions
    ADD CONSTRAINT account_transactions_pkey PRIMARY KEY (id);

-- CONSTRAINT: account_transfers account_transfers_pkey
ALTER TABLE ONLY public.account_transfers
    ADD CONSTRAINT account_transfers_pkey PRIMARY KEY (id);

-- CONSTRAINT: bank_accounts bank_accounts_pkey
ALTER TABLE ONLY public.bank_accounts
    ADD CONSTRAINT bank_accounts_pkey PRIMARY KEY (id);

-- CONSTRAINT: financial_years financial_years_pkey
ALTER TABLE ONLY public.financial_years
    ADD CONSTRAINT financial_years_pkey PRIMARY KEY (id);

-- CONSTRAINT: financial_years fy_no_overlap
ALTER TABLE ONLY public.financial_years
    ADD CONSTRAINT fy_no_overlap EXCLUDE USING gist (daterange(start_date, end_date, '[]'::text) WITH &&);

-- CONSTRAINT: inventory_items inventory_items_pkey
ALTER TABLE ONLY public.inventory_items
    ADD CONSTRAINT inventory_items_pkey PRIMARY KEY (id);

-- CONSTRAINT: message_jobs message_jobs_pkey
ALTER TABLE ONLY public.message_jobs
    ADD CONSTRAINT message_jobs_pkey PRIMARY KEY (id);

-- CONSTRAINT: parties parties_pkey
ALTER TABLE ONLY public.parties
    ADD CONSTRAINT parties_pkey PRIMARY KEY (id);

-- CONSTRAINT: party_documents party_documents_pkey
ALTER TABLE ONLY public.party_documents
    ADD CONSTRAINT party_documents_pkey PRIMARY KEY (id);

-- CONSTRAINT: party_documents party_documents_storage_key_key
ALTER TABLE ONLY public.party_documents
    ADD CONSTRAINT party_documents_storage_key_key UNIQUE (storage_key);

-- CONSTRAINT: payment_modes payment_modes_pkey
ALTER TABLE ONLY public.payment_modes
    ADD CONSTRAINT payment_modes_pkey PRIMARY KEY (id);

-- CONSTRAINT: payments_in payments_in_pkey
ALTER TABLE ONLY public.payments_in
    ADD CONSTRAINT payments_in_pkey PRIMARY KEY (id);

-- CONSTRAINT: payments_out payments_out_pkey
ALTER TABLE ONLY public.payments_out
    ADD CONSTRAINT payments_out_pkey PRIMARY KEY (id);

-- CONSTRAINT: proforma_invoice_items proforma_invoice_items_pkey
ALTER TABLE ONLY public.proforma_invoice_items
    ADD CONSTRAINT proforma_invoice_items_pkey PRIMARY KEY (id);

-- CONSTRAINT: proforma_invoices proforma_invoices_pkey
ALTER TABLE ONLY public.proforma_invoices
    ADD CONSTRAINT proforma_invoices_pkey PRIMARY KEY (id);

-- CONSTRAINT: proforma_trade_ins proforma_trade_ins_pkey
ALTER TABLE ONLY public.proforma_trade_ins
    ADD CONSTRAINT proforma_trade_ins_pkey PRIMARY KEY (id);

-- CONSTRAINT: purchase_items purchase_items_pkey
ALTER TABLE ONLY public.purchase_items
    ADD CONSTRAINT purchase_items_pkey PRIMARY KEY (id);

-- CONSTRAINT: purchases purchases_pkey
ALTER TABLE ONLY public.purchases
    ADD CONSTRAINT purchases_pkey PRIMARY KEY (id);

-- CONSTRAINT: reminder_settings reminder_settings_pkey
ALTER TABLE ONLY public.reminder_settings
    ADD CONSTRAINT reminder_settings_pkey PRIMARY KEY (id);

-- CONSTRAINT: reminder_settings reminder_settings_sale_id_key
ALTER TABLE ONLY public.reminder_settings
    ADD CONSTRAINT reminder_settings_sale_id_key UNIQUE (sale_id);

-- CONSTRAINT: sale_items sale_items_pkey
ALTER TABLE ONLY public.sale_items
    ADD CONSTRAINT sale_items_pkey PRIMARY KEY (id);

-- CONSTRAINT: sales sales_pkey
ALTER TABLE ONLY public.sales
    ADD CONSTRAINT sales_pkey PRIMARY KEY (id);

-- CONSTRAINT: schema_migrations schema_migrations_pkey
ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (version);

-- CONSTRAINT: store store_pkey
ALTER TABLE ONLY public.store
    ADD CONSTRAINT store_pkey PRIMARY KEY (id);

-- CONSTRAINT: trade_ins trade_ins_pkey
ALTER TABLE ONLY public.trade_ins
    ADD CONSTRAINT trade_ins_pkey PRIMARY KEY (id);

-- CONSTRAINT: users users_pkey
ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);

-- CONSTRAINT: whatsapp_settings whatsapp_settings_pkey
ALTER TABLE ONLY public.whatsapp_settings
    ADD CONSTRAINT whatsapp_settings_pkey PRIMARY KEY (id);

-- FK CONSTRAINT: account_fund_entries account_fund_entries_bank_account_id_fkey
ALTER TABLE ONLY public.account_fund_entries
    ADD CONSTRAINT account_fund_entries_bank_account_id_fkey FOREIGN KEY (bank_account_id) REFERENCES public.bank_accounts(id);

-- FK CONSTRAINT: account_fund_entries account_fund_entries_financial_year_id_fkey
ALTER TABLE ONLY public.account_fund_entries
    ADD CONSTRAINT account_fund_entries_financial_year_id_fkey FOREIGN KEY (financial_year_id) REFERENCES public.financial_years(id);

-- FK CONSTRAINT: account_transactions account_transactions_bank_account_id_fkey
ALTER TABLE ONLY public.account_transactions
    ADD CONSTRAINT account_transactions_bank_account_id_fkey FOREIGN KEY (bank_account_id) REFERENCES public.bank_accounts(id);

-- FK CONSTRAINT: account_transactions account_transactions_financial_year_id_fkey
ALTER TABLE ONLY public.account_transactions
    ADD CONSTRAINT account_transactions_financial_year_id_fkey FOREIGN KEY (financial_year_id) REFERENCES public.financial_years(id);

-- FK CONSTRAINT: account_transactions account_transactions_payment_mode_id_fkey
ALTER TABLE ONLY public.account_transactions
    ADD CONSTRAINT account_transactions_payment_mode_id_fkey FOREIGN KEY (payment_mode_id) REFERENCES public.payment_modes(id);

-- FK CONSTRAINT: account_transfers account_transfers_financial_year_id_fkey
ALTER TABLE ONLY public.account_transfers
    ADD CONSTRAINT account_transfers_financial_year_id_fkey FOREIGN KEY (financial_year_id) REFERENCES public.financial_years(id);

-- FK CONSTRAINT: account_transfers account_transfers_from_bank_account_id_fkey
ALTER TABLE ONLY public.account_transfers
    ADD CONSTRAINT account_transfers_from_bank_account_id_fkey FOREIGN KEY (from_bank_account_id) REFERENCES public.bank_accounts(id);

-- FK CONSTRAINT: account_transfers account_transfers_to_bank_account_id_fkey
ALTER TABLE ONLY public.account_transfers
    ADD CONSTRAINT account_transfers_to_bank_account_id_fkey FOREIGN KEY (to_bank_account_id) REFERENCES public.bank_accounts(id);

-- FK CONSTRAINT: inventory_items inventory_items_financial_year_id_fkey
ALTER TABLE ONLY public.inventory_items
    ADD CONSTRAINT inventory_items_financial_year_id_fkey FOREIGN KEY (financial_year_id) REFERENCES public.financial_years(id);

-- FK CONSTRAINT: inventory_items inventory_items_origin_inventory_item_id_fkey
ALTER TABLE ONLY public.inventory_items
    ADD CONSTRAINT inventory_items_origin_inventory_item_id_fkey FOREIGN KEY (origin_inventory_item_id) REFERENCES public.inventory_items(id);

-- FK CONSTRAINT: message_jobs message_jobs_payment_in_id_fkey
ALTER TABLE ONLY public.message_jobs
    ADD CONSTRAINT message_jobs_payment_in_id_fkey FOREIGN KEY (payment_in_id) REFERENCES public.payments_in(id) ON DELETE CASCADE;

-- FK CONSTRAINT: message_jobs message_jobs_payment_out_id_fkey
ALTER TABLE ONLY public.message_jobs
    ADD CONSTRAINT message_jobs_payment_out_id_fkey FOREIGN KEY (payment_out_id) REFERENCES public.payments_out(id) ON DELETE CASCADE;

-- FK CONSTRAINT: message_jobs message_jobs_proforma_id_fkey
ALTER TABLE ONLY public.message_jobs
    ADD CONSTRAINT message_jobs_proforma_id_fkey FOREIGN KEY (proforma_id) REFERENCES public.proforma_invoices(id) ON DELETE CASCADE;

-- FK CONSTRAINT: message_jobs message_jobs_purchase_id_fkey
ALTER TABLE ONLY public.message_jobs
    ADD CONSTRAINT message_jobs_purchase_id_fkey FOREIGN KEY (purchase_id) REFERENCES public.purchases(id) ON DELETE CASCADE;

-- FK CONSTRAINT: message_jobs message_jobs_sale_id_fkey
ALTER TABLE ONLY public.message_jobs
    ADD CONSTRAINT message_jobs_sale_id_fkey FOREIGN KEY (sale_id) REFERENCES public.sales(id) ON DELETE CASCADE;

-- FK CONSTRAINT: party_documents party_documents_party_id_fkey
ALTER TABLE ONLY public.party_documents
    ADD CONSTRAINT party_documents_party_id_fkey FOREIGN KEY (party_id) REFERENCES public.parties(id) ON DELETE CASCADE;

-- FK CONSTRAINT: payment_modes payment_modes_bank_account_id_fkey
ALTER TABLE ONLY public.payment_modes
    ADD CONSTRAINT payment_modes_bank_account_id_fkey FOREIGN KEY (bank_account_id) REFERENCES public.bank_accounts(id) ON DELETE CASCADE;

-- FK CONSTRAINT: payments_in payments_in_bank_account_id_fkey
ALTER TABLE ONLY public.payments_in
    ADD CONSTRAINT payments_in_bank_account_id_fkey FOREIGN KEY (bank_account_id) REFERENCES public.bank_accounts(id);

-- FK CONSTRAINT: payments_in payments_in_financial_year_id_fkey
ALTER TABLE ONLY public.payments_in
    ADD CONSTRAINT payments_in_financial_year_id_fkey FOREIGN KEY (financial_year_id) REFERENCES public.financial_years(id);

-- FK CONSTRAINT: payments_in payments_in_party_id_fkey
ALTER TABLE ONLY public.payments_in
    ADD CONSTRAINT payments_in_party_id_fkey FOREIGN KEY (party_id) REFERENCES public.parties(id);

-- FK CONSTRAINT: payments_in payments_in_payment_mode_id_fkey
ALTER TABLE ONLY public.payments_in
    ADD CONSTRAINT payments_in_payment_mode_id_fkey FOREIGN KEY (payment_mode_id) REFERENCES public.payment_modes(id);

-- FK CONSTRAINT: payments_in payments_in_sale_id_fkey
ALTER TABLE ONLY public.payments_in
    ADD CONSTRAINT payments_in_sale_id_fkey FOREIGN KEY (sale_id) REFERENCES public.sales(id);

-- FK CONSTRAINT: payments_out payments_out_bank_account_id_fkey
ALTER TABLE ONLY public.payments_out
    ADD CONSTRAINT payments_out_bank_account_id_fkey FOREIGN KEY (bank_account_id) REFERENCES public.bank_accounts(id);

-- FK CONSTRAINT: payments_out payments_out_financial_year_id_fkey
ALTER TABLE ONLY public.payments_out
    ADD CONSTRAINT payments_out_financial_year_id_fkey FOREIGN KEY (financial_year_id) REFERENCES public.financial_years(id);

-- FK CONSTRAINT: payments_out payments_out_party_id_fkey
ALTER TABLE ONLY public.payments_out
    ADD CONSTRAINT payments_out_party_id_fkey FOREIGN KEY (party_id) REFERENCES public.parties(id);

-- FK CONSTRAINT: payments_out payments_out_payment_mode_id_fkey
ALTER TABLE ONLY public.payments_out
    ADD CONSTRAINT payments_out_payment_mode_id_fkey FOREIGN KEY (payment_mode_id) REFERENCES public.payment_modes(id);

-- FK CONSTRAINT: payments_out payments_out_purchase_id_fkey
ALTER TABLE ONLY public.payments_out
    ADD CONSTRAINT payments_out_purchase_id_fkey FOREIGN KEY (purchase_id) REFERENCES public.purchases(id);

-- FK CONSTRAINT: proforma_invoice_items proforma_invoice_items_inventory_item_id_fkey
ALTER TABLE ONLY public.proforma_invoice_items
    ADD CONSTRAINT proforma_invoice_items_inventory_item_id_fkey FOREIGN KEY (inventory_item_id) REFERENCES public.inventory_items(id);

-- FK CONSTRAINT: proforma_invoice_items proforma_invoice_items_proforma_invoice_id_fkey
ALTER TABLE ONLY public.proforma_invoice_items
    ADD CONSTRAINT proforma_invoice_items_proforma_invoice_id_fkey FOREIGN KEY (proforma_invoice_id) REFERENCES public.proforma_invoices(id) ON DELETE CASCADE;

-- FK CONSTRAINT: proforma_invoices proforma_invoices_financial_year_id_fkey
ALTER TABLE ONLY public.proforma_invoices
    ADD CONSTRAINT proforma_invoices_financial_year_id_fkey FOREIGN KEY (financial_year_id) REFERENCES public.financial_years(id);

-- FK CONSTRAINT: proforma_invoices proforma_invoices_party_id_fkey
ALTER TABLE ONLY public.proforma_invoices
    ADD CONSTRAINT proforma_invoices_party_id_fkey FOREIGN KEY (party_id) REFERENCES public.parties(id);

-- FK CONSTRAINT: proforma_trade_ins proforma_trade_ins_proforma_invoice_id_fkey
ALTER TABLE ONLY public.proforma_trade_ins
    ADD CONSTRAINT proforma_trade_ins_proforma_invoice_id_fkey FOREIGN KEY (proforma_invoice_id) REFERENCES public.proforma_invoices(id) ON DELETE CASCADE;

-- FK CONSTRAINT: purchase_items purchase_items_inventory_item_id_fkey
ALTER TABLE ONLY public.purchase_items
    ADD CONSTRAINT purchase_items_inventory_item_id_fkey FOREIGN KEY (inventory_item_id) REFERENCES public.inventory_items(id);

-- FK CONSTRAINT: purchase_items purchase_items_purchase_id_fkey
ALTER TABLE ONLY public.purchase_items
    ADD CONSTRAINT purchase_items_purchase_id_fkey FOREIGN KEY (purchase_id) REFERENCES public.purchases(id) ON DELETE CASCADE;

-- FK CONSTRAINT: purchases purchases_bank_account_id_fkey
ALTER TABLE ONLY public.purchases
    ADD CONSTRAINT purchases_bank_account_id_fkey FOREIGN KEY (bank_account_id) REFERENCES public.bank_accounts(id);

-- FK CONSTRAINT: purchases purchases_financial_year_id_fkey
ALTER TABLE ONLY public.purchases
    ADD CONSTRAINT purchases_financial_year_id_fkey FOREIGN KEY (financial_year_id) REFERENCES public.financial_years(id);

-- FK CONSTRAINT: purchases purchases_party_id_fkey
ALTER TABLE ONLY public.purchases
    ADD CONSTRAINT purchases_party_id_fkey FOREIGN KEY (party_id) REFERENCES public.parties(id);

-- FK CONSTRAINT: purchases purchases_payment_mode_id_fkey
ALTER TABLE ONLY public.purchases
    ADD CONSTRAINT purchases_payment_mode_id_fkey FOREIGN KEY (payment_mode_id) REFERENCES public.payment_modes(id);

-- FK CONSTRAINT: reminder_settings reminder_settings_sale_id_fkey
ALTER TABLE ONLY public.reminder_settings
    ADD CONSTRAINT reminder_settings_sale_id_fkey FOREIGN KEY (sale_id) REFERENCES public.sales(id) ON DELETE CASCADE;

-- FK CONSTRAINT: sale_items sale_items_inventory_item_id_fkey
ALTER TABLE ONLY public.sale_items
    ADD CONSTRAINT sale_items_inventory_item_id_fkey FOREIGN KEY (inventory_item_id) REFERENCES public.inventory_items(id);

-- FK CONSTRAINT: sale_items sale_items_sale_id_fkey
ALTER TABLE ONLY public.sale_items
    ADD CONSTRAINT sale_items_sale_id_fkey FOREIGN KEY (sale_id) REFERENCES public.sales(id) ON DELETE CASCADE;

-- FK CONSTRAINT: sales sales_bank_account_id_fkey
ALTER TABLE ONLY public.sales
    ADD CONSTRAINT sales_bank_account_id_fkey FOREIGN KEY (bank_account_id) REFERENCES public.bank_accounts(id);

-- FK CONSTRAINT: sales sales_financial_year_id_fkey
ALTER TABLE ONLY public.sales
    ADD CONSTRAINT sales_financial_year_id_fkey FOREIGN KEY (financial_year_id) REFERENCES public.financial_years(id);

-- FK CONSTRAINT: sales sales_party_id_fkey
ALTER TABLE ONLY public.sales
    ADD CONSTRAINT sales_party_id_fkey FOREIGN KEY (party_id) REFERENCES public.parties(id);

-- FK CONSTRAINT: sales sales_payment_mode_id_fkey
ALTER TABLE ONLY public.sales
    ADD CONSTRAINT sales_payment_mode_id_fkey FOREIGN KEY (payment_mode_id) REFERENCES public.payment_modes(id);

-- FK CONSTRAINT: sales sales_proforma_id_fkey
ALTER TABLE ONLY public.sales
    ADD CONSTRAINT sales_proforma_id_fkey FOREIGN KEY (proforma_id) REFERENCES public.proforma_invoices(id);

-- FK CONSTRAINT: store store_active_financial_year_id_fkey
ALTER TABLE ONLY public.store
    ADD CONSTRAINT store_active_financial_year_id_fkey FOREIGN KEY (active_financial_year_id) REFERENCES public.financial_years(id);

-- FK CONSTRAINT: trade_ins trade_ins_inventory_item_id_fkey
ALTER TABLE ONLY public.trade_ins
    ADD CONSTRAINT trade_ins_inventory_item_id_fkey FOREIGN KEY (inventory_item_id) REFERENCES public.inventory_items(id);

-- FK CONSTRAINT: trade_ins trade_ins_sale_id_fkey
ALTER TABLE ONLY public.trade_ins
    ADD CONSTRAINT trade_ins_sale_id_fkey FOREIGN KEY (sale_id) REFERENCES public.sales(id) ON DELETE CASCADE;

-- FK CONSTRAINT: users users_id_fkey
ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;
