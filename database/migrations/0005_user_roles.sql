-- ============================================================
-- FUSIONONE — 0005 Owner role management
-- ============================================================
-- Replaces the single-owner model with owner role management
-- (owner ⇄ user), keeping every existing guarantee:
--
--   * public.users.user_type stays the ONE role field: owner | user |
--     NULL (NULL = unprovisioned, fail-closed — unchanged).
--   * Role changes happen ONLY through the trusted server-side path
--     (the backend's owner-only /api/users/:id/role endpoint, secret
--     key). The browser keeps no mutation path: the RLS policies and
--     column grants from 0004 are untouched (authenticated can still
--     only SELECT users and UPDATE display_name).
--   * Multiple owners are now allowed (the users_single_owner partial
--     unique index is dropped).
--   * The store can never end up with zero owners: an UPDATE/DELETE
--     that would remove the last ACTIVE owner is rejected by the
--     trigger below — the database-level backstop behind the backend's
--     own owner-invariant check.
--
-- The owner account can still never be blocked (users_owner_never_blocked
-- CHECK from 0002, unchanged).

-- ─── Multiple owners allowed ────────────────────────────────────────────────

DROP INDEX IF EXISTS public.users_single_owner;

-- ─── Never-zero-owners invariant ───────────────────────────────────────────
-- Fires only for rows that are an ACTIVE owner being demoted, deactivated
-- or deleted; display_name and ordinary user updates never reach the body.
-- SECURITY DEFINER + empty search_path (same hardening as the 0003 helpers)
-- so the owner count is independent of the caller's RLS visibility.

CREATE OR REPLACE FUNCTION private.users_owner_invariant()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- Refuse the change when no OTHER active owner would remain.
  IF NOT EXISTS (
    SELECT 1
      FROM public.users u
     WHERE u.user_type = 'owner'
       AND u.status = 'active'
       AND u.id <> OLD.id
  ) THEN
    RAISE EXCEPTION 'FUSION ONE requires at least one active owner'
      USING ERRCODE = 'raise_exception',
            DETAIL = 'This change would leave the store without an active owner.';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

REVOKE EXECUTE ON FUNCTION private.users_owner_invariant() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER users_owner_invariant_update
  BEFORE UPDATE OF user_type, status ON public.users
  FOR EACH ROW
  WHEN (OLD.user_type = 'owner'
        AND (NEW.user_type IS DISTINCT FROM 'owner'
             OR NEW.status IS DISTINCT FROM 'active'))
  EXECUTE FUNCTION private.users_owner_invariant();

CREATE TRIGGER users_owner_invariant_delete
  BEFORE DELETE ON public.users
  FOR EACH ROW
  WHEN (OLD.user_type = 'owner')
  EXECUTE FUNCTION private.users_owner_invariant();
