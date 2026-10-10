-- ============================================================
-- FUSION ONE — canonical production schema 02: schemas
-- ============================================================
-- Creates the two application schemas and their access posture.
--
-- The public schema exists on every Supabase project; a rebuild
-- recreates it (DROP SCHEMA public CASCADE first — see README),
-- so this file treats it as create-if-missing.
--
-- Schema ACL posture (matches migrations/0004's documented intent;
-- deliberately tightened vs. the historical live states):
--   public : USAGE for postgres + the three Supabase API roles;
--            nothing for PUBLIC; no CREATE for the API roles (the
--            application never creates objects through the API —
--            DDL is migration/tooling-only, run as postgres).
--   private: USAGE for authenticated ONLY. PostgREST never
--            exposes the private schema; its functions are
--            resolved by RLS policies and SECURITY DEFINER
--            helpers under the authenticated role.
--
-- Idempotent: safe to re-run.
-- ============================================================

CREATE SCHEMA IF NOT EXISTS private;

-- The public schema is created by the platform; guard anyway so
-- the file is self-contained for clean-database builds.
CREATE SCHEMA IF NOT EXISTS public;

COMMENT ON SCHEMA public IS 'FUSION ONE application schema — canonical build (database/production/)';
COMMENT ON SCHEMA private IS 'FUSION ONE non-exposed helpers: authorization predicates, validation and provisioning functions';

-- ── Schema privileges ──────────────────────────────────────────────────────
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO postgres, anon, authenticated, service_role;

REVOKE ALL ON SCHEMA private FROM PUBLIC, anon, service_role;
GRANT USAGE ON SCHEMA private TO authenticated;
