-- ============================================================
-- FUSION ONE — canonical production schema 03: helper functions
-- ============================================================
-- Pure text-normalization helpers with NO table dependencies.
--
-- These MUST be created before the tables: the search
-- architecture's GENERATED ALWAYS AS columns on
-- public.inventory_items and public.parties call them directly,
-- and PostgreSQL validates the function reference at CREATE
-- TABLE time.
--
-- Language SQL, IMMUTABLE (a generated-column requirement),
-- SECURITY INVOKER, no side effects.
--
-- Idempotent: CREATE OR REPLACE with the identical body.
-- ============================================================

-- Normalized identity for exact/prefix matching: lowercase,
-- alphanumeric only.
CREATE OR REPLACE FUNCTION private.search_norm(v text) RETURNS text
    LANGUAGE sql IMMUTABLE
    AS $$
  SELECT lower(regexp_replace(coalesce(v, ''), '[^a-zA-Z0-9]', '', 'g'))
$$;

-- Tokenized identity for trigram fuzzy matching: lowercase,
-- non-alphanumeric runs collapsed to single spaces, trimmed.
CREATE OR REPLACE FUNCTION private.search_tokens(v text) RETURNS text
    LANGUAGE sql IMMUTABLE
    AS $$
  SELECT btrim(lower(regexp_replace(coalesce(v, ''), '[^a-zA-Z0-9]+', ' ', 'g')))
$$;
