-- ============================================================
-- FUSIONONE — 0008 Messages read model (overview aggregate)
-- ============================================================
-- ONE small read-oriented aggregate for the user-facing Messages
-- page (/delivery — "Messages"): the summary strip's three practical
-- counts (Pending / Sent today / Needs attention) in a SINGLE database
-- call, instead of a collection of independent count queries from the
-- browser.
--
-- Design notes:
--   * Pure read model — no new table, no persistent state, no writes.
--     The page's lists still read delivery_jobs / reminder_settings
--     directly through the existing RLS SELECT policies (paginated);
--     only the summary needed an aggregate path.
--   * SECURITY INVOKER: runs as the CALLING role (authenticated), so
--     the delivery_jobs RLS read policy applies exactly as it does for
--     every other browser read — no privilege escalation.
--   * "Sent today" is bounded by the business timezone (Asia/Kolkata):
--     succeeded jobs with finished_at >= today's IST midnight.
--
-- Grants: EXECUTE for authenticated only (revoked from anon/PUBLIC) —
-- the same narrowing pattern as the rest of the delivery schema.
-- ============================================================

CREATE OR REPLACE FUNCTION public.messages_overview()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'pending',
      count(*) FILTER (WHERE status IN ('pending', 'processing')),
    'sentToday',
      count(*) FILTER (
        WHERE status = 'succeeded'
          AND finished_at >= (
            (date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata'))
              AT TIME ZONE 'Asia/Kolkata'
          )
      ),
    'needsAttention',
      count(*) FILTER (WHERE status = 'failed')
  )
  FROM public.delivery_jobs
$$;

COMMENT ON FUNCTION public.messages_overview() IS
  'Messages page summary counts (pending, sentToday, needsAttention) over delivery_jobs — one-call read model for the UI.';

-- Execute: authenticated app users only.
REVOKE EXECUTE ON FUNCTION public.messages_overview() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.messages_overview() TO authenticated;
