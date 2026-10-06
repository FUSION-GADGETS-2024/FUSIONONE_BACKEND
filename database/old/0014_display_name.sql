-- ============================================================
-- FUSIONONE — 0014 Profile display name + narrow self-update
-- ============================================================
-- PHASE 1 (display name):
--   public.users.display_name TEXT NULL — personal profile data.
--
--     * nullable — NULL IS the "profile incomplete" state (there is
--       deliberately NO profile_completed / name_required column;
--       the field itself is the single source of truth)
--     * normalized by trimming (database trigger) — a stored value is
--       always btrim()-ed
--     * semantic CHECK: NULL OR (trimmed length > 0 AND <= 80)
--     * NO fake value is generated from email (existing rows keep NULL)
--     * NO authorization semantics — display_name never affects RLS,
--       owner access, blocked state, onboarding or business data
--
-- PHASE 2 (security-safe self update):
--   A normal authorized user may update their OWN display_name and
--   NOTHING else. Implemented with the narrowest mechanism available:
--
--     * column-level privilege: GRANT UPDATE (display_name) — the
--       authenticated role's ONLY update path on public.users; any
--       attempt to touch id / user_type / status / created_at fails
--       with permission denied at the database, regardless of policy
--     * a narrowly scoped UPDATE policy confined to the caller's own
--       row AND a normal application authentication context
--       (private.can_access_app(): verified + ACTIVE + owner/user +
--       amr 'password' — the same helper every business policy uses),
--       with both USING and WITH CHECK
--
--   The setup-auth client (invitation/recovery, amr 'otp') can never
--   write display_name — the profile is completed only through the
--   NORMAL application session, after a normal login.
--
-- Everything else is unchanged: SELECT-only self-read + owner-read
-- policies stay; the backend service_role path (owner user management)
-- is untouched; the provisioning trigger and single-owner index are
-- untouched; no existing policy is weakened.

-- ─── 1. display_name column ────────────────────────────────────────────────

ALTER TABLE public.users
  ADD COLUMN display_name TEXT;

-- Semantic constraint: NULL (not set) OR a real, human-entered name of
-- 1..80 characters after trimming. Whitespace-only values are rejected
-- (trimmed length 0); over-long values are rejected.
ALTER TABLE public.users
  ADD CONSTRAINT users_display_name_check CHECK (
    display_name IS NULL
    OR (
      length(btrim(display_name)) > 0
      AND length(btrim(display_name)) <= 80
    )
  );

-- ─── 2. trim normalization (storage guarantee) ─────────────────────────────
-- Whatever writes the column (browser self-update, backend admin write,
-- future tooling), the stored value is always trimmed. btrim(NULL) is
-- NULL, so unset profiles stay NULL. Fires only when display_name is
-- actually being written (INSERT, or UPDATE OF display_name).

CREATE OR REPLACE FUNCTION private.trim_users_display_name()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  NEW.display_name := btrim(NEW.display_name);
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION private.trim_users_display_name() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER users_display_name_trim
  BEFORE INSERT OR UPDATE OF display_name ON public.users
  FOR EACH ROW EXECUTE FUNCTION private.trim_users_display_name();

-- ─── 3. narrow self-update privilege (column-level) ────────────────────────
-- authenticated holds ONLY SELECT on public.users (table level, from
-- 0008; verified live — no table-level UPDATE/INSERT/DELETE exists for
-- the role). Granting UPDATE on exactly one column keeps every other
-- column (id, user_type, status, created_at) unwritable by any
-- authenticated request, even before RLS is considered.

GRANT UPDATE (display_name) ON public.users TO authenticated;

-- ─── 4. narrow self-update policy ──────────────────────────────────────────
-- Row scope: the caller's own row only (id = auth.uid()).
-- Context scope: a NORMAL application authentication context —
-- private.can_access_app() requires the caller to be a verified,
-- ACTIVE, provisioned (owner | user) account whose session was
-- established by a password sign-in (amr 'password'). Blocked,
-- unverified, NULL-role and setup-auth (otp) contexts are all denied.
-- Both USING and WITH CHECK are specified (the row must stay the
-- caller's own before and after the update).

CREATE POLICY "users_self_update_display_name" ON public.users
  FOR UPDATE TO authenticated
  USING (
    id = auth.uid()
    AND private.can_access_app()
  )
  WITH CHECK (
    id = auth.uid()
    AND private.can_access_app()
  );
