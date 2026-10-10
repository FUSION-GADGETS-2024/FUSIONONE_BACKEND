-- ============================================================
-- FUSION ONE — canonical production schema 11: RLS safety net
-- ============================================================
-- The `ensure_rls` event trigger: auto-enables row-level security
-- on every table later created in the public schema. Originally
-- installed on production through the Supabase dashboard
-- (platform hardening), deliberately adopted into the canonical
-- build so the posture is reproducible and survives rebuilds.
--
-- Created LAST (after 08 explicitly set every table's RLS state)
-- so the event trigger guards only FUTURE tables — the canonical
-- state itself is defined by the explicit statements in 08, never
-- by trigger side effects.
--
-- SECURITY DEFINER with search_path pinned to pg_catalog; failures
-- to enable RLS are logged, never raised (best-effort hardening).
--
-- Idempotent: guarded drop + create.
-- ============================================================

CREATE OR REPLACE FUNCTION public.rls_auto_enable()
 RETURNS event_trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$function$;

DROP EVENT TRIGGER IF EXISTS ensure_rls;
CREATE EVENT TRIGGER ensure_rls
  ON ddl_command_end
  EXECUTE FUNCTION public.rls_auto_enable();
