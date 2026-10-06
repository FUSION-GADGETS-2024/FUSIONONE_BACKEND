-- ============================================================
-- FUSIONONE — 0008 Application users + private authorization
-- ============================================================
-- PHASES A–D of the auth migration:
--   A. public.users (application-user table) + hardened private
--      authorization helpers (can_access_app / is_owner).
--   B. Provision the CURRENT main account as the one owner.
--   C. Automatic provisioning: every future auth.users INSERT gets a
--      public.users row with user_type = NULL (fail-closed default).
--   D. Single-owner invariant (partial unique index).
--
-- user_type is the ONLY application role field (owner | user | NULL).
-- NULL/missing/invalid user_type grants zero application access.
-- Supabase Auth stays authoritative for identity + email verification
-- (the helpers read auth.users.email_confirmed_at live — no duplication).

-- ─── PHASE A: public.users (the application-user table) ────────────────────

CREATE TABLE public.users (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  -- The one application role field. NULL = unprovisioned (no access).
  user_type TEXT CHECK (user_type IN ('owner', 'user')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

-- Least-privilege grants. 0007's default privileges granted ALL to anon for
-- future tables — undo that for this table (RLS has no anon policies either).
REVOKE ALL ON TABLE public.users FROM anon;
GRANT SELECT ON TABLE public.users TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.users TO service_role;

-- ─── PHASE A: private schema (not exposed through PostgREST) ───────────────

CREATE SCHEMA IF NOT EXISTS private;

-- Only the API runtime role may enter the schema; anon must not.
REVOKE ALL ON SCHEMA private FROM PUBLIC, anon;
GRANT USAGE ON SCHEMA private TO authenticated;

-- ─── PHASE A: hardened authorization helpers ───────────────────────────────
-- SECURITY DEFINER (owner = postgres, which bypasses RLS on these tables —
-- no FORCE ROW LEVEL SECURITY is set), empty search_path, no public EXECUTE.
-- They read auth.users live: Supabase Auth remains the source of truth for
-- email verification (never duplicated into public.users).
-- (SQL-language bodies are validated against relations at CREATE time, so
-- these functions must come after public.users exists.)

CREATE OR REPLACE FUNCTION private.can_access_app()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.users u
      JOIN auth.users a ON a.id = u.id
     WHERE u.id = auth.uid()
       AND u.user_type IN ('owner', 'user')
       AND a.email_confirmed_at IS NOT NULL
  )
$$;

CREATE OR REPLACE FUNCTION private.is_owner()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.users u
      JOIN auth.users a ON a.id = u.id
     WHERE u.id = auth.uid()
       AND u.user_type = 'owner'
       AND a.email_confirmed_at IS NOT NULL
  )
$$;

REVOKE EXECUTE ON FUNCTION private.can_access_app() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION private.is_owner() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.can_access_app() TO authenticated;
GRANT EXECUTE ON FUNCTION private.is_owner() TO authenticated;

-- Users may read their own row; the owner may read all rows. There are
-- deliberately NO INSERT/UPDATE/DELETE policies for the authenticated role:
-- role changes happen only through the server-side controlled path.
CREATE POLICY "users_self_read" ON public.users
  FOR SELECT TO authenticated
  USING (id = auth.uid());

CREATE POLICY "users_owner_read_all" ON public.users
  FOR SELECT TO authenticated
  USING (private.is_owner());

-- ─── PHASE B: provision the existing owner (controlled migration) ──────────
-- The CURRENT/MAIN account (owner@fusionone.test, id b56dbf8a-…) is the only
-- initial owner. Every other pre-existing auth user (none today) would be
-- backfilled as NULL — fail-closed.

INSERT INTO public.users (id, user_type)
SELECT a.id,
       CASE WHEN a.id = 'b56dbf8a-0d67-4f26-8fa1-e615f04f4291'::uuid
            THEN 'owner' ELSE NULL END
  FROM auth.users a
 WHERE NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = a.id);

-- ─── PHASE D: single-owner invariant (database-enforced) ───────────────────

CREATE UNIQUE INDEX users_single_owner
  ON public.users (user_type)
  WHERE user_type = 'owner';

-- ─── PHASE C: automatic provisioning for future Auth users ─────────────────
-- auth.users INSERT -> public.users row with user_type = NULL. The default is
-- fail-closed; only the controlled server-side invitation path (backend,
-- secret key) may later set 'user'. Never owner. Idempotent via ON CONFLICT.

CREATE OR REPLACE FUNCTION private.handle_new_auth_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.users (id, user_type)
  VALUES (NEW.id, NULL)
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION private.handle_new_auth_user() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION private.handle_new_auth_user();
