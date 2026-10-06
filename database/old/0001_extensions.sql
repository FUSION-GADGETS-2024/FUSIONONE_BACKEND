-- ============================================================
-- FUSIONONE — TEST database rebuild — 0001 Extensions
-- ============================================================
-- btree_gist is required by the financial-year no-overlap GiST
-- exclusion constraint (fy_no_overlap).
CREATE EXTENSION IF NOT EXISTS btree_gist;
