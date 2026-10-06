-- ============================================================
-- FUSIONONE — 0004 Security: RLS, policies, grants, storage
-- ============================================================
-- The shared-data authorization model (mirrors the live TEST database):
--
--   VERIFIED + ACTIVE + OWNER          → authorized (incl. owner-only ops)
--   VERIFIED + ACTIVE + USER           → authorized for shared business data
--   NULL user_type                     → no application access (fail-closed)
--   BLOCKED                            → no application access
--   UNVERIFIED                         → no application access
--   setup-auth context (JWT amr 'otp') → no business access (fail-closed)
--
--   store            SELECT  private.can_access_app()   (shared read)
--                    INSERT/UPDATE  private.is_owner()  (owner-only mutation)
--   18 business      FOR ALL private.can_access_app()   (shared dataset —
--   tables                                        owner and user share data)
--   whatsapp_settings read shared / write owner-only (store-level config)
--   users            self-read + owner-read-all + narrow self display_name
--                    update (column-level grant, no table-level UPDATE)
--   storage.objects  store_assets: read shared, writes owner-only;
--                    documents: shared read/write (business data)
--
-- RLS is the security boundary. Frontend checks are UX only; the backend
-- re-resolves the caller on every request as additional enforcement.
-- anon has no policies anywhere (deny-all). There is deliberately NO
-- DELETE policy on store/whatsapp_settings (never deletable via the API)
-- and NO per-user business-data isolation.

-- ─── Enable RLS on every application table ─────────────────────────────────

ALTER TABLE public.financial_years ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.store ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bank_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_modes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.parties ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purchases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purchase_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sale_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trade_ins ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payments_in ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payments_out ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.account_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.account_fund_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.account_transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.proforma_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.proforma_invoice_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.proforma_trade_ins ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

-- ─── store: shared read, owner-only write ──────────────────────────────────

CREATE POLICY "store_read" ON public.store
  FOR SELECT TO authenticated
  USING (private.can_access_app());

CREATE POLICY "store_insert" ON public.store
  FOR INSERT TO authenticated
  WITH CHECK (private.is_owner());

CREATE POLICY "store_update" ON public.store
  FOR UPDATE TO authenticated
  USING (private.is_owner())
  WITH CHECK (private.is_owner());

-- ─── business tables: all authorized verified app users (shared data) ──────

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'financial_years','bank_accounts','payment_modes','parties',
    'inventory_items','purchases','purchase_items','sales','sale_items',
    'trade_ins','payments_in','payments_out','account_transactions',
    'account_fund_entries','account_transfers','proforma_invoices',
    'proforma_invoice_items','proforma_trade_ins'
  ]
  LOOP
    EXECUTE format(
      'CREATE POLICY "app_user_access" ON public.%I FOR ALL TO authenticated USING (private.can_access_app()) WITH CHECK (private.can_access_app())',
      t
    );
  END LOOP;
END $$;

-- ─── whatsapp_settings: shared read, owner-only write (store-level config) ─

CREATE POLICY "whatsapp_settings_read" ON public.whatsapp_settings
  FOR SELECT TO authenticated
  USING (private.can_access_app());

CREATE POLICY "whatsapp_settings_insert" ON public.whatsapp_settings
  FOR INSERT TO authenticated
  WITH CHECK (private.is_owner());

CREATE POLICY "whatsapp_settings_update" ON public.whatsapp_settings
  FOR UPDATE TO authenticated
  USING (private.is_owner())
  WITH CHECK (private.is_owner());

-- ─── users: self-read, owner-read-all, narrow self display_name update ─────
-- There are deliberately NO INSERT/DELETE policies for the authenticated
-- role: role/status changes happen only through the trusted server-side
-- path (backend owner administration via the service role).

CREATE POLICY "users_self_read" ON public.users
  FOR SELECT TO authenticated
  USING (id = auth.uid());

CREATE POLICY "users_owner_read_all" ON public.users
  FOR SELECT TO authenticated
  USING (private.is_owner());

CREATE POLICY "users_self_update_display_name" ON public.users
  FOR UPDATE TO authenticated
  USING (
    id = auth.uid()
    AND private.can_access_app()
  )
  WITH CHECK (
    id = auth.uid()
    AND private.can_access_app()
  );

-- ─── Privileges ────────────────────────────────────────────────────────────
-- Base grants for the Supabase API roles (RLS keeps the data private; anon
-- has no policies anywhere → deny-all), then the least-privilege
-- restrictions for public.users.

GRANT USAGE ON SCHEMA public TO postgres, anon, authenticated, service_role;

GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated, service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO anon, authenticated, service_role;

-- complete_store_setup stays owner-gated at the API surface: the broad
-- function grant above must not re-expose it to anon/PUBLIC (it has its
-- own explicit owner check, but the least-privilege surface matches the
-- live architecture: authenticated + service_role only).
REVOKE EXECUTE ON FUNCTION public.complete_store_setup(jsonb) FROM PUBLIC, anon;

-- Future objects created by postgres in public get the same grants.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;

-- The private schema is not exposed through PostgREST: only the API
-- runtime role may enter it (the RLS policies evaluate private.* under
-- the authenticated role). service_role bypasses RLS and never resolves
-- these functions, so it deliberately gets no USAGE here.
REVOKE ALL ON SCHEMA private FROM PUBLIC, anon;
GRANT USAGE ON SCHEMA private TO authenticated;

-- public.users: the browser must never mutate roles/status/accounts.
-- anon: nothing. authenticated: table-level SELECT only, plus a
-- column-level UPDATE on display_name (the ONLY writable column — any
-- attempt to touch id/user_type/status/created_at fails with permission
-- denied at the database, regardless of policies). service_role: full
-- (trusted backend owner administration).
REVOKE ALL ON TABLE public.users FROM anon;
REVOKE ALL ON TABLE public.users FROM authenticated;
GRANT SELECT ON TABLE public.users TO authenticated;
GRANT UPDATE (display_name) ON TABLE public.users TO authenticated;

-- The migration-runner bookkeeping table is tooling-only: keep it away
-- from the API roles. (The runner creates this table before applying
-- migrations; this revocation undoes the broad grant above.)
REVOKE ALL ON TABLE public.schema_migrations FROM anon, authenticated, service_role;

-- ─── Storage ───────────────────────────────────────────────────────────────
-- store_assets (logo/signature): shared store branding — authorized users
--   may read, only the owner may modify.
-- documents (trade-in documents): business data — authorized users may
--   read and write as part of business operations.
-- Both buckets are public-read at the CDN level (logo/branding URLs are
-- rendered in invoices); object-level mutation is policy-controlled.

INSERT INTO storage.buckets (id, name, public)
VALUES ('store_assets', 'store_assets', true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO storage.buckets (id, name, public)
VALUES ('documents', 'documents', true)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "store_assets_read" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'store_assets' AND private.can_access_app());

CREATE POLICY "store_assets_insert" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'store_assets' AND private.is_owner());

CREATE POLICY "store_assets_update" ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'store_assets' AND private.is_owner())
  WITH CHECK (bucket_id = 'store_assets' AND private.is_owner());

CREATE POLICY "store_assets_delete" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'store_assets' AND private.is_owner());

CREATE POLICY "documents_read" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'documents' AND private.can_access_app());

CREATE POLICY "documents_write" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'documents' AND private.can_access_app());

CREATE POLICY "documents_update" ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'documents' AND private.can_access_app())
  WITH CHECK (bucket_id = 'documents' AND private.can_access_app());

CREATE POLICY "documents_delete" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'documents' AND private.can_access_app());
