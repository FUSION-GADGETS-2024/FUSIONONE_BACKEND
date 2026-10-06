-- ============================================================
-- FUSIONONE — TEST database rebuild — 0007 Privileges
-- ============================================================
-- Explicit table/function/sequence grants for the Supabase API roles.
-- anon gets table privileges but RLS deny-all (no anon policies) keeps the
-- data private; authenticated is the app's runtime role.

GRANT USAGE ON SCHEMA public TO postgres, anon, authenticated, service_role;

GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated, service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO anon, authenticated, service_role;

-- Future objects created by postgres in public get the same grants.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;

-- schema_migrations is tooling-only: keep it away from the API roles.
REVOKE ALL ON TABLE public.schema_migrations FROM anon, authenticated, service_role;
