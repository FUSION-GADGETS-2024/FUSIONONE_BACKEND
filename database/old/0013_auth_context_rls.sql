-- ============================================================
-- FUSIONONE — 0013 Authentication-context boundary (RLS)
-- ============================================================
-- Normal business access now additionally requires a NORMAL APPLICATION
-- AUTHENTICATION CONTEXT: the request's JWT must have been established by
-- an explicit password sign-in (amr[0].method = 'password').
--
-- Why: an invitation/recovery email-link session (verifyOtp, amr method
-- 'otp') is cryptographically valid, may belong to a verified, provisioned,
-- ACTIVE user — and must still never touch business data. It exists ONLY
-- to set a password inside /set-password's isolated setup client.
--
-- Verified live against the TEST project (egdrnhtmclvhsfjvhyam):
--   * password login        → amr = [{"method":"password",…}]
--   * invite verifyOtp     → amr = [{"method":"otp",…}]
--   * recovery verifyOtp   → amr = [{"method":"otp",…}]
--   * refreshed tokens preserve the original amr method (stable claim)
-- The standard JWT amr claim therefore reliably distinguishes the two
-- authentication lifecycles — NO Custom Access Token Hook is required.
--
-- Fail-closed semantics: anything that is not exactly 'password'
-- (including a missing/absent amr claim) is NOT a normal application
-- authentication context and receives no business access.
--
-- Invariants preserved:
--   * user_type owner/user/NULL and status active/blocked semantics — unchanged
--   * NULL role / blocked status remain fail-closed — unchanged
--   * public.users self-read + owner-read-all policies — unchanged (the
--     caller's own row stays readable for controlled state resolution;
--     NO business policy is weakened by this migration)
--   * the provisioning trigger and single-owner index — unchanged
--   * service_role (backend admin client) bypasses RLS entirely — unaffected

-- ─── Hardened authorization helpers ────────────────────────────────────────
-- Both helpers now require the JWT amr method to be exactly 'password' in
-- addition to the existing role/status/verification checks. auth.jwt() is
-- evaluated in the caller's request context (STABLE), so every RLS policy
-- built on these helpers enforces the boundary for authenticated requests.
-- COALESCE(..., false) keeps the expression strictly boolean and fail-closed
-- when the claim is absent or malformed.

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
       AND COALESCE(
            (auth.jwt() -> 'amr' -> 0 ->> 'method') = 'password',
            false
          )
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
       AND COALESCE(
            (auth.jwt() -> 'amr' -> 0 ->> 'method') = 'password',
            false
          )
  )
$$;
