-- ============================================================
-- FUSIONONE — 0009 RLS rewrite: shared-data authorization
-- ============================================================
-- PHASES F + H of the auth migration. Replaces the per-owner authorization
-- model with the application-role model:
--
--   store            SELECT  private.can_access_app()  (shared application data)
--                    INSERT  private.is_owner()        (initial owner setup)
--                    UPDATE  private.is_owner()        (store configuration)
--                    DELETE  (no policy — never deletable via the API)
--   18 business      FOR ALL private.can_access_app()  (owner AND user share
--   tables                                                 the same data)
--   whatsapp_settings SELECT  can_access_app / writes is_owner (store-level
--                    configuration — 0010 makes the row singleton)
--   storage.objects  store branding writes owner-only; business document
--                    bucket accessible to authorized app users.
--
-- RLS answers "is this verified FUSION ONE user authorized?", never "does
-- this row belong to this user?". The old public.is_owner() (store-row
-- ownership semantics, PUBLIC executable) is dropped entirely.

-- ─── Drop the old policies ─────────────────────────────────────────────────

DROP POLICY "Store Owner Access" ON public.store;
DROP POLICY "whatsapp_settings_owner" ON public.whatsapp_settings;

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
    EXECUTE format('DROP POLICY IF EXISTS "Owner Access" ON public.%I', t);
  END LOOP;
END $$;

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

-- ─── Old authorization function: gone ──────────────────────────────────────
-- Its "owns at least one store row" semantics must not survive as an
-- authorization source, and its PUBLIC execute grant was unsafe.

DROP FUNCTION IF EXISTS public.is_owner();

-- ─── Storage: app-authorization instead of any-authenticated ───────────────
-- store_assets (logo/signature) = shared store branding: authorized users
-- may read, only the owner may modify. documents (trade-in documents) =
-- business data: authorized users may read/write (business operations).

DROP POLICY IF EXISTS "store_assets_read" ON storage.objects;
DROP POLICY IF EXISTS "store_assets_write" ON storage.objects;
DROP POLICY IF EXISTS "store_assets_update" ON storage.objects;
DROP POLICY IF EXISTS "store_assets_delete" ON storage.objects;
DROP POLICY IF EXISTS "documents_read" ON storage.objects;
DROP POLICY IF EXISTS "documents_write" ON storage.objects;
DROP POLICY IF EXISTS "documents_update" ON storage.objects;
DROP POLICY IF EXISTS "documents_delete" ON storage.objects;

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
