-- ============================================================
-- FUSIONONE — 0009 Delivery → Messages domain cutover
-- ============================================================
-- Renames the durable-job system to its correct domain terminology
-- (message jobs) while preserving ALL data, indexes, constraints, RLS
-- behavior, idempotency guarantees, and RPC semantics:
--
--   delivery_jobs          → message_jobs      (table rename — data kept)
--   claim_due_delivery_jobs    → claim_due_message_jobs
--   recover_expired_delivery_jobs → recover_expired_message_jobs
--   complete_delivery_job      → complete_message_job
--   upsert_reminder_config     (kept; body repointed to message_jobs)
--   trigger_reminder_now       (kept; body repointed to message_jobs)
--   public.messages_overview   (kept; body repointed to message_jobs)
--   private.create_auto_receipt_job (kept; body repointed to message_jobs)
--
-- Grants survive ALTER FUNCTION ... RENAME and CREATE OR REPLACE with the
-- same signature, so the service-role-only execution model is unchanged.
-- Historical migrations 0001-0008 are NOT rewritten; this migration IS the
-- architectural cutover.

-- ─── 1. Table rename (data, indexes, constraints, RLS all follow) ──────────

ALTER TABLE public.delivery_jobs RENAME TO message_jobs;

COMMENT ON TABLE public.message_jobs IS
  'Durable server-side message jobs (invoice auto-send, invoice payment reminders, payment receipts, payment statements). System-owned state: written only by the backend (service role).';

-- Constraint renames (the objects themselves are unchanged).
ALTER TABLE public.message_jobs RENAME CONSTRAINT delivery_jobs_pkey TO message_jobs_pkey;
ALTER TABLE public.message_jobs RENAME CONSTRAINT delivery_jobs_job_type_check TO message_jobs_job_type_check;
ALTER TABLE public.message_jobs RENAME CONSTRAINT delivery_jobs_ref_shape TO message_jobs_ref_shape;

-- Index renames (the indexes themselves are unchanged).
ALTER INDEX public.idx_delivery_jobs_due RENAME TO idx_message_jobs_due;
ALTER INDEX public.idx_delivery_jobs_claim_expiry RENAME TO idx_message_jobs_claim_expiry;
ALTER INDEX public.idx_delivery_jobs_sale RENAME TO idx_message_jobs_sale;
ALTER INDEX public.idx_delivery_jobs_purchase RENAME TO idx_message_jobs_purchase;
ALTER INDEX public.idx_delivery_jobs_proforma RENAME TO idx_message_jobs_proforma;
ALTER INDEX public.idx_delivery_jobs_payment_in RENAME TO idx_message_jobs_payment_in;
ALTER INDEX public.idx_delivery_jobs_payment_out RENAME TO idx_message_jobs_payment_out;
ALTER INDEX public.uq_delivery_jobs_invoice_send_sale RENAME TO uq_message_jobs_invoice_send_sale;
ALTER INDEX public.uq_delivery_jobs_invoice_send_purchase RENAME TO uq_message_jobs_invoice_send_purchase;
ALTER INDEX public.uq_delivery_jobs_invoice_send_proforma RENAME TO uq_message_jobs_invoice_send_proforma;
ALTER INDEX public.uq_delivery_jobs_reminder_sale RENAME TO uq_message_jobs_reminder_sale;
ALTER INDEX public.uq_delivery_jobs_receipt_in RENAME TO uq_message_jobs_receipt_in;
ALTER INDEX public.uq_delivery_jobs_receipt_out RENAME TO uq_message_jobs_receipt_out;
ALTER INDEX public.uq_delivery_jobs_statement_sale RENAME TO uq_message_jobs_statement_sale;
ALTER INDEX public.uq_delivery_jobs_statement_purchase RENAME TO uq_message_jobs_statement_purchase;

-- Policy rename (the SELECT-only policy for authenticated app users).
ALTER POLICY "delivery_jobs_read" ON public.message_jobs RENAME TO "message_jobs_read";

-- ─── 2. RPC renames + body repoints ────────────────────────────────────────
-- Rename first (preserves grants), then CREATE OR REPLACE with the same
-- signature and the message_jobs body.

ALTER FUNCTION public.claim_due_delivery_jobs(text, int, int, uuid) RENAME TO claim_due_message_jobs;
ALTER FUNCTION public.recover_expired_delivery_jobs() RENAME TO recover_expired_message_jobs;
ALTER FUNCTION public.complete_delivery_job(uuid, text, text, text) RENAME TO complete_message_job;

CREATE OR REPLACE FUNCTION public.claim_due_message_jobs(
  p_worker text,
  p_batch_size int DEFAULT 5,
  p_lease_seconds int DEFAULT 300,
  p_job_id uuid DEFAULT NULL
) RETURNS SETOF public.message_jobs
LANGUAGE sql AS $$
  UPDATE public.message_jobs AS j SET
    status = 'processing',
    claimed_by = p_worker,
    claimed_at = now(),
    claim_expires_at = now() + make_interval(secs => GREATEST(30, p_lease_seconds)),
    started_at = now(),
    attempts = j.attempts + 1,
    updated_at = now()
  WHERE j.id IN (
    SELECT c.id FROM public.message_jobs c
     WHERE c.status = 'pending'
       AND c.run_at <= now()
       AND (p_job_id IS NULL OR c.id = p_job_id)
     ORDER BY c.run_at
     LIMIT GREATEST(1, LEAST(p_batch_size, 25))
     FOR UPDATE SKIP LOCKED
  )
  RETURNING j.*;
$$;

CREATE OR REPLACE FUNCTION public.recover_expired_message_jobs()
RETURNS TABLE (id uuid, status text, attempts int)
LANGUAGE sql AS $$
  UPDATE public.message_jobs AS j SET
    status = CASE WHEN j.attempts >= j.max_attempts THEN 'failed' ELSE 'pending' END,
    run_at = CASE
      WHEN j.attempts >= j.max_attempts THEN j.run_at
      ELSE now() + make_interval(secs => LEAST(3600::double precision, 60 * power(2, GREATEST(j.attempts - 1, 0))))
    END,
    claimed_by = NULL,
    claimed_at = NULL,
    claim_expires_at = NULL,
    last_error = 'claim expired before completion (worker crash or stall) — recovered',
    updated_at = now()
  FROM (
    SELECT e.id FROM public.message_jobs e
     WHERE e.status = 'processing' AND e.claim_expires_at < now()
     FOR UPDATE SKIP LOCKED
  ) ex
  WHERE j.id = ex.id
  RETURNING j.id, j.status, j.attempts;
$$;

CREATE OR REPLACE FUNCTION public.complete_message_job(
  p_job_id uuid,
  p_outcome text,
  p_message_id text DEFAULT NULL,
  p_error text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  j public.message_jobs;
  cfg record;
  sale_active boolean;
  sale_due numeric;
  next_job_id uuid;
BEGIN
  IF p_outcome NOT IN ('success', 'retry', 'fail', 'cancel') THEN
    RAISE EXCEPTION 'Invalid message job outcome: %', p_outcome;
  END IF;

  SELECT * INTO j FROM public.message_jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('updated', false, 'reason', 'job_not_found');
  END IF;
  IF j.status <> 'processing' THEN
    -- Completed/recovered/re-claimed elsewhere: never overwrite newer state.
    RETURN jsonb_build_object('updated', false, 'reason', 'not_processing', 'status', j.status);
  END IF;

  IF p_outcome = 'success' THEN
    UPDATE public.message_jobs SET
      status = 'succeeded', finished_at = now(), message_id = p_message_id,
      last_error = NULL, updated_at = now()
    WHERE id = p_job_id;
  ELSIF p_outcome = 'retry' THEN
    UPDATE public.message_jobs SET
      status = 'pending',
      run_at = now() + make_interval(secs => LEAST(3600::double precision, 60 * power(2, GREATEST(j.attempts - 1, 0)))),
      claimed_by = NULL, claimed_at = NULL, claim_expires_at = NULL,
      last_error = p_error, updated_at = now()
    WHERE id = p_job_id;
  ELSE
    UPDATE public.message_jobs SET
      status = CASE p_outcome WHEN 'fail' THEN 'failed' ELSE 'cancelled' END,
      finished_at = now(),
      claimed_by = NULL, claimed_at = NULL, claim_expires_at = NULL,
      last_error = p_error, updated_at = now()
    WHERE id = p_job_id;
  END IF;

  -- Reminder chain advance (successful delivery ONLY — attempts are never
  -- counted as delivered reminders).
  IF p_outcome = 'success' AND j.job_type = 'reminder' THEN
    UPDATE public.reminder_settings
       SET reminders_sent = reminders_sent + 1, last_reminder_at = now(), updated_at = now()
     WHERE sale_id = j.sale_id
    RETURNING * INTO cfg;

    IF cfg IS NOT NULL AND cfg.enabled THEN
      -- Re-read the CURRENT sale state (never trust anything stale).
      SELECT (status = 'active'), due INTO sale_active, sale_due
        FROM public.sales WHERE id = j.sale_id;
      IF COALESCE(sale_active, false) AND COALESCE(sale_due, 0) > 0
         AND cfg.reminders_sent < cfg.max_reminders THEN
        INSERT INTO public.message_jobs (job_type, sale_id, run_at)
        VALUES ('reminder', j.sale_id, now() + make_interval(days => cfg.frequency_days))
        ON CONFLICT (sale_id) WHERE job_type = 'reminder' AND status IN ('pending', 'processing')
          DO NOTHING
        RETURNING id INTO next_job_id;
      END IF;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'updated', true,
    'status', CASE p_outcome WHEN 'success' THEN 'succeeded' WHEN 'retry' THEN 'pending'
                             WHEN 'fail' THEN 'failed' ELSE 'cancelled' END,
    'next_job_created', next_job_id IS NOT NULL
  );
END;
$$;

-- upsert_reminder_config / trigger_reminder_now: same names, bodies repointed.
CREATE OR REPLACE FUNCTION public.upsert_reminder_config(
  p_sale_id uuid,
  p_enabled boolean,
  p_frequency_days int,
  p_max_reminders int
) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  s record;
  cfg record;
  next_job_id uuid;
  cancelled_count int;
BEGIN
  IF p_frequency_days IS NULL OR p_frequency_days < 1 OR p_frequency_days > 365 THEN
    RAISE EXCEPTION 'frequency_days must be between 1 and 365';
  END IF;
  IF p_max_reminders IS NULL OR p_max_reminders < 1 OR p_max_reminders > 50 THEN
    RAISE EXCEPTION 'max_reminders must be between 1 and 50';
  END IF;

  SELECT status, due INTO s FROM public.sales WHERE id = p_sale_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sale not found';
  END IF;

  INSERT INTO public.reminder_settings (sale_id, enabled, frequency_days, max_reminders)
  VALUES (p_sale_id, p_enabled, p_frequency_days, p_max_reminders)
  ON CONFLICT (sale_id) DO UPDATE SET
    enabled = EXCLUDED.enabled,
    frequency_days = EXCLUDED.frequency_days,
    max_reminders = EXCLUDED.max_reminders,
    updated_at = now()
  RETURNING * INTO cfg;

  next_job_id := NULL;
  IF cfg.enabled AND s.status = 'active' AND s.due > 0 AND cfg.reminders_sent < cfg.max_reminders THEN
    INSERT INTO public.message_jobs (job_type, sale_id, run_at)
    VALUES ('reminder', p_sale_id, now() + make_interval(days => cfg.frequency_days))
    ON CONFLICT (sale_id) WHERE job_type = 'reminder' AND status IN ('pending', 'processing')
      DO NOTHING
    RETURNING id INTO next_job_id;
  ELSE
    -- Disabled or no longer eligible: stop the chain. Pending jobs are
    -- cancelled; an in-flight (processing) job is left to finish — its
    -- completion step re-checks the config before scheduling the next.
    UPDATE public.message_jobs
       SET status = 'cancelled', finished_at = now(),
           last_error = 'reminders disabled or invoice no longer eligible',
           updated_at = now()
     WHERE sale_id = p_sale_id AND job_type = 'reminder' AND status = 'pending';
    GET DIAGNOSTICS cancelled_count = ROW_COUNT;
  END IF;

  RETURN jsonb_build_object(
    'config', cfg,
    'job_created', next_job_id IS NOT NULL,
    'jobs_cancelled', COALESCE(cancelled_count, 0),
    'sale_status', s.status,
    'sale_due', s.due
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.trigger_reminder_now(
  p_sale_id uuid
) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  s record;
  j public.message_jobs;
BEGIN
  SELECT status, due INTO s FROM public.sales WHERE id = p_sale_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sale not found';
  END IF;
  IF s.status <> 'active' OR s.due <= 0 THEN
    RAISE EXCEPTION 'Invoice is not eligible for a reminder';
  END IF;

  INSERT INTO public.message_jobs (job_type, sale_id, run_at)
  VALUES ('reminder', p_sale_id, now())
  ON CONFLICT (sale_id) WHERE job_type = 'reminder' AND status IN ('pending', 'processing')
    DO UPDATE SET run_at = now(), updated_at = now()
  RETURNING * INTO j;

  RETURN jsonb_build_object('job', j);
END;
$$;

-- public.messages_overview (0008): the Messages page summary aggregate.
-- Same single-scan FILTER shape as 0008; only the table name follows the
-- rename.
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
  FROM public.message_jobs
$$;

COMMENT ON FUNCTION public.messages_overview() IS
  'Messages page summary counts (pending, sentToday, needsAttention) over message_jobs — one-call read model for the UI.';

-- private.create_auto_receipt_job (0007): the transactional bridge called
-- inside receive_payment / pay_purchase. SECURITY DEFINER, pinned
-- search_path — unchanged semantics (same signature, same grants), only
-- the target table name follows the rename.
CREATE OR REPLACE FUNCTION private.create_auto_receipt_job(
  p_direction text,
  p_payment_id uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private
AS $$
DECLARE
  v_enabled boolean;
BEGIN
  IF p_direction NOT IN ('in', 'out') OR p_payment_id IS NULL THEN
    RAISE EXCEPTION 'create_auto_receipt_job: invalid arguments (direction=%, payment_id=%)', p_direction, p_payment_id;
  END IF;

  -- The store-level automatic-receipt switch (singleton row).
  SELECT CASE p_direction
           WHEN 'in' THEN auto_send_receipt_in
           ELSE auto_send_receipt_out
         END
    INTO v_enabled
    FROM public.whatsapp_settings
    LIMIT 1;

  IF COALESCE(v_enabled, false) THEN
    -- One INSERT per direction (an INSERT carries a single ON CONFLICT
    -- clause, and each arm's partial unique index is its own conflict
    -- target). Idempotent: a pending/processing receipt job for the SAME
    -- payment can never be duplicated.
    IF p_direction = 'in' THEN
      INSERT INTO public.message_jobs (job_type, run_at, payment_in_id)
      VALUES ('receipt', now(), p_payment_id)
      ON CONFLICT (payment_in_id) WHERE job_type = 'receipt' AND status IN ('pending', 'processing')
        DO NOTHING;
    ELSE
      INSERT INTO public.message_jobs (job_type, run_at, payment_out_id)
      VALUES ('receipt', now(), p_payment_id)
      ON CONFLICT (payment_out_id) WHERE job_type = 'receipt' AND status IN ('pending', 'processing')
        DO NOTHING;
    END IF;
  END IF;
END;
$$;

-- Grants re-issued idempotently (unchanged narrowing pattern).
REVOKE EXECUTE ON FUNCTION public.claim_due_message_jobs(text, int, int, uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.recover_expired_message_jobs() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.complete_message_job(uuid, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.upsert_reminder_config(uuid, boolean, int, int) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.trigger_reminder_now(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_due_message_jobs(text, int, int, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.recover_expired_message_jobs() TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_message_job(uuid, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.upsert_reminder_config(uuid, boolean, int, int) TO service_role;
GRANT EXECUTE ON FUNCTION public.trigger_reminder_now(uuid) TO service_role;
REVOKE EXECUTE ON FUNCTION public.messages_overview() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.messages_overview() TO authenticated;
REVOKE EXECUTE ON FUNCTION private.create_auto_receipt_job(text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.create_auto_receipt_job(text, uuid) TO authenticated;
