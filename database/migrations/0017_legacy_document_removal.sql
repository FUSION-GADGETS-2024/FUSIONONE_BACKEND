-- ============================================================
-- FUSIONONE — 0017 Legacy document path removal
--            (the Party Documents architecture is live)
-- ============================================================
-- 0016 built and verified the new architecture end-to-end:
--   party_documents (metadata + envelope-encryption material),
--   trade_ins.document_id → party_documents.id with the
--   database-enforced party-ownership invariant in create_sale,
--   backend-mediated R2 storage (private bucket, application-level
--   AES-256-GCM), the Party Detail Documents tab, trade-in document
--   selection/upload, Exchange backend-secured preview, and the full
--   test matrix (backend / database / frontend / E2E on TEST).
--
-- This migration removes the OBSOLETE legacy path:
--   * trade_ins.document_url — the public Supabase-Storage URL string
--     (TEST verified: zero populated rows at migration time — the
--     documents audit found 0/3 rows with documents and 0 objects).
--   * the 'documents' Supabase bucket + its storage policies — unused
--     since the refactor (trade-in documents live in private R2 now;
--     TEST verified 0 objects / 0 references before this drop).
--     store_assets (logo/signature) is deliberately UNTOUCHED.
--
-- NOTE for a future PRODUCTION promotion: verify the production
-- documents bucket is empty (or migrate its objects into R2 first)
-- before running the bucket drop — that migration is a separate,
-- explicitly authorized operation and is NOT part of this task.
-- ============================================================

-- ─── 1. Remove the obsolete trade-in document column ──────────────────────

ALTER TABLE public.trade_ins DROP COLUMN IF EXISTS document_url;

-- ─── 2. Remove the obsolete Supabase 'documents' storage policies ─────────
-- Party documents live in the private Cloudflare R2 bucket
-- (fusionone-documents) behind the backend; the public Supabase bucket is
-- dead weight (and a public-read surface) once nothing references it.
--
-- The BUCKET ROW itself cannot be dropped via SQL: Supabase guards
-- storage.buckets with the protect_delete() trigger (the supported removal
-- path is the Storage API — DELETE /storage/v1/bucket/documents with the
-- server secret key, performed by database/tools/apply-0017.ts). With its
-- policies gone the bucket is inert: no authenticated role can list, read,
-- write or manage objects in it, and the application contains zero
-- references to it.

DROP POLICY IF EXISTS "documents_read" ON storage.objects;
DROP POLICY IF EXISTS "documents_write" ON storage.objects;
DROP POLICY IF EXISTS "documents_update" ON storage.objects;
DROP POLICY IF EXISTS "documents_delete" ON storage.objects;
