-- ============================================================
-- FUSIONONE — 0012 User account status (active | blocked)
-- ============================================================
-- Owner-controlled ACCOUNT ACCESS state, deliberately independent
-- of the application role:
--
--   user_type : owner | user | NULL   (role — UNCHANGED)
--   status    : active | blocked      (account access — NEW)
--
-- Invariants (all database-enforced):
--   * status is NOT NULL; every existing row backfills to 'active'
--     (the column default) — the migration removes nobody's access.
--   * NULL user_type remains fail-closed (zero access) — unchanged.
--   * status = 'blocked' means NO application access: the private
--     authorization helpers below are hardened so RLS, the backend
--     authorization layer and the frontend resolver all treat a
--     blocked account as locked out (blocked is never onboarding,
--     never a store-setup problem).
--   * The (single) owner account can never be blocked — an owner
--     lockout would orphan the store. Enforced by a CHECK constraint.
--   * Exactly one owner (0008's partial unique index) — unchanged.
--
-- Security model (unchanged): the browser still CANNOT mutate
-- user_type or status — public.users keeps its SELECT-only policies
-- for the authenticated role (self-read + owner-read-all) and has NO
-- INSERT/UPDATE/DELETE policies. Owner user management goes through
-- the trusted backend (service role), which re-resolves the caller
-- on every request.

-- ─── 1. status column ───────────────────────────────────────────────────────
-- Existing rows (inspected before writing this migration: one owner +
-- four 'user' rows + one NULL row) all receive 'active' via the NOT NULL
-- DEFAULT — nobody loses access, nothing else changes.

ALTER TABLE public.users
  ADD COLUMN status TEXT NOT NULL DEFAULT 'active';

ALTER TABLE public.users
  ADD CONSTRAINT users_status_check CHECK (status IN ('active', 'blocked'));

-- ─── 2. the owner account can never be blocked ─────────────────────────────

ALTER TABLE public.users
  ADD CONSTRAINT users_owner_never_blocked
  CHECK (user_type IS DISTINCT FROM 'owner' OR status = 'active');

-- ─── 3. hardened authorization helpers ─────────────────────────────────────
-- Blocked = no application access. Both helpers now additionally require
-- status = 'active', so every RLS policy built on them (all 18 business
-- tables, store, whatsapp_settings, storage objects) rejects blocked
-- accounts regardless of any still-valid Supabase access token.
-- (SECURITY DEFINER, owner = postgres, empty search_path — same hardening
-- as 0008; Supabase Auth remains the source of truth for verification.)

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
       AND u.status = 'active'
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
       AND u.status = 'active'
       AND a.email_confirmed_at IS NOT NULL
  )
$$;
