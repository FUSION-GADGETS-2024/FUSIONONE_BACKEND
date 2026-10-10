-- ============================================================
-- FUSION ONE — canonical production schema 01: extensions
-- ============================================================
-- The application-required extensions. Both live in the public
-- schema and are therefore dropped whenever the public schema is
-- rebuilt — this file recreates them first so the tables, indexes
-- and generated columns that follow can resolve their operators.
--
--   btree_gist  — declared dependency of the financial-year
--                 no-overlap architecture (GiST exclusion
--                 constraints; historically used for scalar
--                 GiST ops).
--   pg_trgm     — trigram operator classes for the normalized
--                 search columns' GIN indexes (0012 search
--                 architecture).
--
-- Platform-managed extensions (pg_stat_statements, pgcrypto,
-- plpgsql, supabase_vault, uuid-ossp) live in platform schemas
-- (extensions/pg_catalog/vault), survive a public-schema rebuild,
-- and are intentionally NOT recreated here. The application uses
-- no pgcrypto/uuid-ossp function (gen_random_uuid() is core
-- PostgreSQL since 13).
--
-- Idempotent: safe to re-run.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;
