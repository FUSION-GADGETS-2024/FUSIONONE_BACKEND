-- ============================================================
-- FUSION ONE — canonical production schema 10: storage configuration
-- ============================================================
-- Supabase Storage posture of the final architecture:
--
--   store_assets (public-read CDN) — the store logo/signature
--     used on invoices. Read for authorized app users, mutated
--     owner-only. Object bytes are browser-direct uploads; the
--     bucket row and policies are owned by the database build.
--
--   NO documents bucket. The legacy public trade-in document
--     bucket was REMOVED by the final architecture (0017):
--     party documents live exclusively in the private Cloudflare
--     R2 bucket behind the Fastify backend (envelope-encrypted,
--     party-scoped routes), with public.party_documents as the
--     metadata entity. Nothing in this schema references a
--     Supabase `documents` bucket.
--
-- Requires: private.can_access_app()/is_owner() (06).
-- Idempotent: guarded inserts and policy drops.
--
-- NOTE: if a legacy `documents` bucket still exists on a target
-- project (pre-0017 state), remove it via the Storage API
-- (DELETE /storage/v1/bucket/documents with the server secret
-- key) — Supabase's protect_delete trigger forbids SQL deletion.
-- ============================================================

-- store_assets bucket (idempotent; normally already present).
INSERT INTO storage.buckets (id, name, public)
VALUES ('store_assets', 'store_assets', true)
ON CONFLICT (id) DO NOTHING;

-- Object-level policies on the platform storage.objects table.
DROP POLICY IF EXISTS "store_assets_read" ON storage.objects;
CREATE POLICY "store_assets_read" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'store_assets' AND private.can_access_app());

DROP POLICY IF EXISTS "store_assets_insert" ON storage.objects;
CREATE POLICY "store_assets_insert" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'store_assets' AND private.is_owner());

DROP POLICY IF EXISTS "store_assets_update" ON storage.objects;
CREATE POLICY "store_assets_update" ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'store_assets' AND private.is_owner())
  WITH CHECK (bucket_id = 'store_assets' AND private.is_owner());

DROP POLICY IF EXISTS "store_assets_delete" ON storage.objects;
CREATE POLICY "store_assets_delete" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'store_assets' AND private.is_owner());

-- Defensive: remove any legacy documents-bucket policies left by a
-- pre-0017 state (the bucket itself is removed via the Storage API).
DROP POLICY IF EXISTS "documents_read" ON storage.objects;
DROP POLICY IF EXISTS "documents_write" ON storage.objects;
DROP POLICY IF EXISTS "documents_update" ON storage.objects;
DROP POLICY IF EXISTS "documents_delete" ON storage.objects;
