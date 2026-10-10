-- ============================================================
-- FUSION ONE — canonical production schema 08: row-level security
-- ============================================================
-- RLS is the security boundary of the whole application:
--
--   * every business table: one shared permissive policy
--     app_user_access FOR ALL TO authenticated, gated by
--     private.can_access_app() (verified + active provisioned
--     app user with a password-context sign-in);
--   * message_jobs / reminder_settings: SELECT-only for
--     authenticated (system-owned job state);
--   * store / whatsapp_settings: shared read, owner-only
--     mutation, deliberately NO delete policy;
--   * users: self-read + owner-read-all + narrow self
--     display_name update (column-level grants in 09);
--   * schema_migrations: RLS enabled, NO policies, NO API grants
--     (tooling-only bookkeeping — the owner path is unaffected);
--   * anon has no policies anywhere: deny-all.
--
-- The policies call private.can_access_app()/is_owner() from 06.
-- Idempotent: DROP POLICY IF EXISTS before every CREATE; the
-- ENABLE statements are naturally idempotent.
-- ============================================================

-- ROW SECURITY: account_fund_entries
ALTER TABLE public.account_fund_entries ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: account_transactions
ALTER TABLE public.account_transactions ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: account_transfers
ALTER TABLE public.account_transfers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS app_user_access ON public.account_fund_entries;
-- POLICY: account_fund_entries app_user_access
CREATE POLICY app_user_access ON public.account_fund_entries TO authenticated USING (private.can_access_app()) WITH CHECK (private.can_access_app());

DROP POLICY IF EXISTS app_user_access ON public.account_transactions;
-- POLICY: account_transactions app_user_access
CREATE POLICY app_user_access ON public.account_transactions TO authenticated USING (private.can_access_app()) WITH CHECK (private.can_access_app());

DROP POLICY IF EXISTS app_user_access ON public.account_transfers;
-- POLICY: account_transfers app_user_access
CREATE POLICY app_user_access ON public.account_transfers TO authenticated USING (private.can_access_app()) WITH CHECK (private.can_access_app());

DROP POLICY IF EXISTS app_user_access ON public.bank_accounts;
-- POLICY: bank_accounts app_user_access
CREATE POLICY app_user_access ON public.bank_accounts TO authenticated USING (private.can_access_app()) WITH CHECK (private.can_access_app());

DROP POLICY IF EXISTS app_user_access ON public.financial_years;
-- POLICY: financial_years app_user_access
CREATE POLICY app_user_access ON public.financial_years TO authenticated USING (private.can_access_app()) WITH CHECK (private.can_access_app());

DROP POLICY IF EXISTS app_user_access ON public.inventory_items;
-- POLICY: inventory_items app_user_access
CREATE POLICY app_user_access ON public.inventory_items TO authenticated USING (private.can_access_app()) WITH CHECK (private.can_access_app());

DROP POLICY IF EXISTS app_user_access ON public.parties;
-- POLICY: parties app_user_access
CREATE POLICY app_user_access ON public.parties TO authenticated USING (private.can_access_app()) WITH CHECK (private.can_access_app());

DROP POLICY IF EXISTS app_user_access ON public.party_documents;
-- POLICY: party_documents app_user_access
CREATE POLICY app_user_access ON public.party_documents TO authenticated USING (private.can_access_app()) WITH CHECK (private.can_access_app());

DROP POLICY IF EXISTS app_user_access ON public.payment_modes;
-- POLICY: payment_modes app_user_access
CREATE POLICY app_user_access ON public.payment_modes TO authenticated USING (private.can_access_app()) WITH CHECK (private.can_access_app());

DROP POLICY IF EXISTS app_user_access ON public.payments_in;
-- POLICY: payments_in app_user_access
CREATE POLICY app_user_access ON public.payments_in TO authenticated USING (private.can_access_app()) WITH CHECK (private.can_access_app());

DROP POLICY IF EXISTS app_user_access ON public.payments_out;
-- POLICY: payments_out app_user_access
CREATE POLICY app_user_access ON public.payments_out TO authenticated USING (private.can_access_app()) WITH CHECK (private.can_access_app());

DROP POLICY IF EXISTS app_user_access ON public.proforma_invoice_items;
-- POLICY: proforma_invoice_items app_user_access
CREATE POLICY app_user_access ON public.proforma_invoice_items TO authenticated USING (private.can_access_app()) WITH CHECK (private.can_access_app());

DROP POLICY IF EXISTS app_user_access ON public.proforma_invoices;
-- POLICY: proforma_invoices app_user_access
CREATE POLICY app_user_access ON public.proforma_invoices TO authenticated USING (private.can_access_app()) WITH CHECK (private.can_access_app());

DROP POLICY IF EXISTS app_user_access ON public.proforma_trade_ins;
-- POLICY: proforma_trade_ins app_user_access
CREATE POLICY app_user_access ON public.proforma_trade_ins TO authenticated USING (private.can_access_app()) WITH CHECK (private.can_access_app());

DROP POLICY IF EXISTS app_user_access ON public.purchase_items;
-- POLICY: purchase_items app_user_access
CREATE POLICY app_user_access ON public.purchase_items TO authenticated USING (private.can_access_app()) WITH CHECK (private.can_access_app());

DROP POLICY IF EXISTS app_user_access ON public.purchases;
-- POLICY: purchases app_user_access
CREATE POLICY app_user_access ON public.purchases TO authenticated USING (private.can_access_app()) WITH CHECK (private.can_access_app());

DROP POLICY IF EXISTS app_user_access ON public.sale_items;
-- POLICY: sale_items app_user_access
CREATE POLICY app_user_access ON public.sale_items TO authenticated USING (private.can_access_app()) WITH CHECK (private.can_access_app());

DROP POLICY IF EXISTS app_user_access ON public.sales;
-- POLICY: sales app_user_access
CREATE POLICY app_user_access ON public.sales TO authenticated USING (private.can_access_app()) WITH CHECK (private.can_access_app());

DROP POLICY IF EXISTS app_user_access ON public.trade_ins;
-- POLICY: trade_ins app_user_access
CREATE POLICY app_user_access ON public.trade_ins TO authenticated USING (private.can_access_app()) WITH CHECK (private.can_access_app());

-- ROW SECURITY: bank_accounts
ALTER TABLE public.bank_accounts ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: financial_years
ALTER TABLE public.financial_years ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: inventory_items
ALTER TABLE public.inventory_items ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: message_jobs
ALTER TABLE public.message_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS message_jobs_read ON public.message_jobs;
-- POLICY: message_jobs message_jobs_read
CREATE POLICY message_jobs_read ON public.message_jobs FOR SELECT TO authenticated USING (private.can_access_app());

-- ROW SECURITY: parties
ALTER TABLE public.parties ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: party_documents
ALTER TABLE public.party_documents ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: payment_modes
ALTER TABLE public.payment_modes ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: payments_in
ALTER TABLE public.payments_in ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: payments_out
ALTER TABLE public.payments_out ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: proforma_invoice_items
ALTER TABLE public.proforma_invoice_items ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: proforma_invoices
ALTER TABLE public.proforma_invoices ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: proforma_trade_ins
ALTER TABLE public.proforma_trade_ins ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: purchase_items
ALTER TABLE public.purchase_items ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: purchases
ALTER TABLE public.purchases ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: reminder_settings
ALTER TABLE public.reminder_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS reminder_settings_read ON public.reminder_settings;
-- POLICY: reminder_settings reminder_settings_read
CREATE POLICY reminder_settings_read ON public.reminder_settings FOR SELECT TO authenticated USING (private.can_access_app());

-- ROW SECURITY: sale_items
ALTER TABLE public.sale_items ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: sales
ALTER TABLE public.sales ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: store
ALTER TABLE public.store ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS store_insert ON public.store;
-- POLICY: store store_insert
CREATE POLICY store_insert ON public.store FOR INSERT TO authenticated WITH CHECK (private.is_owner());

DROP POLICY IF EXISTS store_read ON public.store;
-- POLICY: store store_read
CREATE POLICY store_read ON public.store FOR SELECT TO authenticated USING (private.can_access_app());

DROP POLICY IF EXISTS store_update ON public.store;
-- POLICY: store store_update
CREATE POLICY store_update ON public.store FOR UPDATE TO authenticated USING (private.is_owner()) WITH CHECK (private.is_owner());

-- ROW SECURITY: trade_ins
ALTER TABLE public.trade_ins ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: users
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS users_owner_read_all ON public.users;
-- POLICY: users users_owner_read_all
CREATE POLICY users_owner_read_all ON public.users FOR SELECT TO authenticated USING (private.is_owner());

DROP POLICY IF EXISTS users_self_read ON public.users;
-- POLICY: users users_self_read
CREATE POLICY users_self_read ON public.users FOR SELECT TO authenticated USING ((id = auth.uid()));

DROP POLICY IF EXISTS users_self_update_display_name ON public.users;
-- POLICY: users users_self_update_display_name
CREATE POLICY users_self_update_display_name ON public.users FOR UPDATE TO authenticated USING (((id = auth.uid()) AND private.can_access_app())) WITH CHECK (((id = auth.uid()) AND private.can_access_app()));

-- ROW SECURITY: whatsapp_settings
ALTER TABLE public.whatsapp_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS whatsapp_settings_insert ON public.whatsapp_settings;
-- POLICY: whatsapp_settings whatsapp_settings_insert
CREATE POLICY whatsapp_settings_insert ON public.whatsapp_settings FOR INSERT TO authenticated WITH CHECK (private.is_owner());

DROP POLICY IF EXISTS whatsapp_settings_read ON public.whatsapp_settings;
-- POLICY: whatsapp_settings whatsapp_settings_read
CREATE POLICY whatsapp_settings_read ON public.whatsapp_settings FOR SELECT TO authenticated USING (private.can_access_app());

DROP POLICY IF EXISTS whatsapp_settings_update ON public.whatsapp_settings;
-- POLICY: whatsapp_settings whatsapp_settings_update
CREATE POLICY whatsapp_settings_update ON public.whatsapp_settings FOR UPDATE TO authenticated USING (private.is_owner()) WITH CHECK (private.is_owner());

-- schema_migrations: migration-runner bookkeeping. RLS enabled with
-- zero policies + zero API grants (09) = unreachable from the API
-- surface; the postgres owner/tooling path is unaffected (the
-- postgres role carries BYPASSRLS on Supabase).
ALTER TABLE public.schema_migrations ENABLE ROW LEVEL SECURITY;
