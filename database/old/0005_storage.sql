-- ============================================================
-- FUSIONONE — TEST database rebuild — 0005 Storage
-- ============================================================
-- store_assets: logo + signature images (public read, authenticated write)
-- documents:    trade-in documents      (public read, authenticated write)

INSERT INTO storage.buckets (id, name, public)
VALUES ('store_assets', 'store_assets', true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO storage.buckets (id, name, public)
VALUES ('documents', 'documents', true)
ON CONFLICT (id) DO NOTHING;

-- store_assets policies
CREATE POLICY "store_assets_read" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'store_assets');

CREATE POLICY "store_assets_write" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'store_assets');

CREATE POLICY "store_assets_update" ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'store_assets');

CREATE POLICY "store_assets_delete" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'store_assets');

-- documents policies
CREATE POLICY "documents_read" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'documents');

CREATE POLICY "documents_write" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'documents');

CREATE POLICY "documents_update" ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'documents');

CREATE POLICY "documents_delete" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'documents');
