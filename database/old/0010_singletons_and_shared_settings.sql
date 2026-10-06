-- ============================================================
-- FUSIONONE — 0010 Single-store invariant + shared whatsapp settings
-- ============================================================
-- PHASES E + G of the auth migration.
--
--   E. The DATABASE guarantees at most ONE store row (fixed singleton key +
--      CHECK + UNIQUE). 0 stores valid before setup, 1 store valid, 2 stores
--      structurally impossible — even for privileged application code.
--   G. whatsapp_settings becomes store-level shared configuration: exactly
--      one settings row for the one store (same singleton mechanism). The
--      per-user owner_user_id semantics are removed after every consumer is
--      migrated (frontend query/upsert, backend repository, RLS — all move
--      in this migration set).
--
-- store.owner_user_id is dropped as well: public.users.user_type is the only
-- authorization source and no code references it after this migration set.

-- ─── PHASE E: store singleton ──────────────────────────────────────────────

ALTER TABLE public.store
  ADD COLUMN singleton SMALLINT NOT NULL DEFAULT 1
  CONSTRAINT store_singleton_key CHECK (singleton = 1);

-- The live store (exactly one row — verified pre-migration) is pinned to the
-- singleton key. A second row is now impossible: every row must have
-- singleton = 1 and only one row may hold it.
CREATE UNIQUE INDEX store_singleton ON public.store (singleton);

-- ─── PHASE G: whatsapp_settings as shared store configuration ──────────────
-- One row for the one store, values preserved (templates, auto-send flags).

ALTER TABLE public.whatsapp_settings
  ADD COLUMN singleton SMALLINT NOT NULL DEFAULT 1
  CONSTRAINT whatsapp_settings_singleton_key CHECK (singleton = 1);

CREATE UNIQUE INDEX whatsapp_settings_singleton ON public.whatsapp_settings (singleton);

-- Per-user ownership removed: the settings row belongs to the STORE.
ALTER TABLE public.whatsapp_settings DROP COLUMN owner_user_id;

-- ─── store.owner_user_id: authorization source replaced by public.users ────

ALTER TABLE public.store DROP COLUMN owner_user_id;
