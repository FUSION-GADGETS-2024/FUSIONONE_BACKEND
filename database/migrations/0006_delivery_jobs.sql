-- ============================================================
-- FUSIONONE — 0006 Durable delivery system (payment receipts,
-- invoice payment reminders, server-owned invoice auto-send)
-- ============================================================
-- ONE durable delivery-job system for ALL server-side delivery work:
--
--   delivery_jobs   the single job table (invoice auto-send, scheduled
--                   reminders, manual receipt delivery, retryable
--                   failures). Jobs REFERENCE business objects by typed
--                   foreign keys — never a copied business payload — so
--                   execution always composes from CURRENT authoritative
--                   data (sales.paid/due, payment rows, templates).
--   reminder_settings  per-invoice reminder configuration + persistent
--                   reminder state (one row per sale, UNIQUE).
--
-- Lifecycle: pending → processing → succeeded | failed | cancelled.
--   A retryable failure returns to pending with a backed-off run_at.
--   A claimed job whose lease (claim_expires_at) expired is recovered
--   automatically (retry, or fail once attempts reach max_attempts).
--
-- Ownership / security model:
--   * Business data stays RLS-protected (can_access_app) — unchanged.
--   * reminder_settings + delivery_jobs are READ-ONLY for authenticated
--     app users (the UI observes delivery state); there are deliberately
--     NO write policies and NO write grants for the API roles.
--   * Job/config WRITES happen exclusively through the trusted backend
--     via the service role (system-owned job state): user-requested
--     operations are authorized per-request by the backend first, then
--     the RPCs below run atomically as the system.
--   * The RPCs are revoked from anon/authenticated and granted to
--     service_role ONLY.
--
-- Idempotency (partial unique indexes): at most ONE pending/processing
-- job per business object per job type — duplicate triggers (double
-- clicks, retries, restarts) can never create duplicate future work.

-- ─── 1. WhatsApp settings: receipt + reminder message templates ────────────
-- Extends the EXISTING singleton (partial-upsert pattern unchanged).
-- Receipts are MANUAL ONLY: there are deliberately NO auto_send flags for
-- payments. Reminder POLICY is per-invoice (reminder_settings), not global.

ALTER TABLE public.whatsapp_settings
  ADD COLUMN payment_in_message_template TEXT NOT NULL DEFAULT
    'Hello {{customer_name}},

We have received a payment of ₹{{payment_amount}} on {{payment_date}} against invoice {{invoice_number}}.

Remaining balance: ₹{{balance_due}}

Thank you for your business.',
  ADD COLUMN payment_out_message_template TEXT NOT NULL DEFAULT
    'Hello {{customer_name}},

This is a confirmation of the payment of ₹{{payment_amount}} made to you on {{payment_date}} against bill {{invoice_number}}.

Remaining balance: ₹{{balance_due}}',
  ADD COLUMN reminder_message_template TEXT NOT NULL DEFAULT
    'Hello {{customer_name}},

This is a friendly reminder for invoice {{invoice_number}} dated {{invoice_date}}.

Balance due: ₹{{balance_due}}

Please complete the payment at your earliest convenience.

Thank you for your business.';

-- ─── 2. Per-invoice reminder configuration + persistent state ──────────────

CREATE TABLE public.reminder_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- ONE configuration per invoice (product model) — UNIQUE.
  sale_id UUID NOT NULL UNIQUE REFERENCES public.sales(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT true,
  frequency_days INT NOT NULL CHECK (frequency_days BETWEEN 1 AND 365),
  max_reminders INT NOT NULL CHECK (max_reminders BETWEEN 1 AND 50),
  -- Persistent reminder state: successfully DELIVERED reminders only
  -- (failed attempts are modeled by delivery_jobs.attempts, never counted
  -- here). Enforces the configured maximum durably — not by UI state.
  reminders_sent INT NOT NULL DEFAULT 0 CHECK (reminders_sent >= 0),
  last_reminder_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.reminder_settings IS
  'Per-sale-invoice payment-reminder configuration and durable reminder progress (one row per sale).';

-- ─── 3. The ONE durable delivery-job table ─────────────────────────────────

CREATE TABLE public.delivery_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_type TEXT NOT NULL CHECK (job_type IN ('invoice_send', 'reminder', 'receipt')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'succeeded', 'failed', 'cancelled')),
  -- Typed business-object reference (exactly one shape per job_type —
  -- enforced by delivery_jobs_ref_shape). The job never copies business
  -- payload; execution loads CURRENT authoritative data by these keys.
  sale_id UUID REFERENCES public.sales(id) ON DELETE CASCADE,
  purchase_id UUID REFERENCES public.purchases(id) ON DELETE CASCADE,
  proforma_id UUID REFERENCES public.proforma_invoices(id) ON DELETE CASCADE,
  payment_in_id UUID REFERENCES public.payments_in(id) ON DELETE CASCADE,
  payment_out_id UUID REFERENCES public.payments_out(id) ON DELETE CASCADE,
  -- When to execute. A job scheduled for tomorrow simply stays here until
  -- run_at becomes due — the database IS the schedule. Retries push this
  -- forward with exponential backoff.
  run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- attempts increments on every claim; max_attempts bounds retries.
  attempts INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 20),
  -- Claim/lease: claimed_by identifies the executing worker process;
  -- claim_expires_at is the lease. An expired lease on a 'processing' job
  -- means the worker died mid-execution → recover_expired_delivery_jobs()
  -- makes it retryable again (or fails it at max_attempts).
  claimed_by TEXT,
  claimed_at TIMESTAMPTZ,
  claim_expires_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  message_id TEXT,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT delivery_jobs_ref_shape CHECK (
    (
      job_type = 'invoice_send' AND (
        (sale_id IS NOT NULL AND purchase_id IS NULL AND proforma_id IS NULL AND payment_in_id IS NULL AND payment_out_id IS NULL)
        OR (sale_id IS NULL AND purchase_id IS NOT NULL AND proforma_id IS NULL AND payment_in_id IS NULL AND payment_out_id IS NULL)
        OR (sale_id IS NULL AND purchase_id IS NULL AND proforma_id IS NOT NULL AND payment_in_id IS NULL AND payment_out_id IS NULL)
      )
    ) OR (
      job_type = 'reminder'
      AND sale_id IS NOT NULL AND purchase_id IS NULL AND proforma_id IS NULL
      AND payment_in_id IS NULL AND payment_out_id IS NULL
    ) OR (
      job_type = 'receipt'
      AND sale_id IS NULL AND purchase_id IS NULL AND proforma_id IS NULL
      AND (
        (payment_in_id IS NOT NULL AND payment_out_id IS NULL)
        OR (payment_in_id IS NULL AND payment_out_id IS NOT NULL)
      )
    )
  )
);

COMMENT ON TABLE public.delivery_jobs IS
  'Durable server-side delivery jobs (invoice auto-send, invoice payment reminders, payment receipts). System-owned state: written only by the backend (service role).';

-- ─── 4. Indexes ─────────────────────────────────────────────────────────────

-- Scheduler scans (claim + recovery).
CREATE INDEX idx_delivery_jobs_due ON public.delivery_jobs (status, run_at);
CREATE INDEX idx_delivery_jobs_claim_expiry ON public.delivery_jobs (claim_expires_at)
  WHERE status = 'processing';
-- UI status queries (latest jobs per business object).
CREATE INDEX idx_delivery_jobs_sale ON public.delivery_jobs (sale_id, created_at DESC);
CREATE INDEX idx_delivery_jobs_purchase ON public.delivery_jobs (purchase_id, created_at DESC);
CREATE INDEX idx_delivery_jobs_proforma ON public.delivery_jobs (proforma_id, created_at DESC);
CREATE INDEX idx_delivery_jobs_payment_in ON public.delivery_jobs (payment_in_id, created_at DESC);
CREATE INDEX idx_delivery_jobs_payment_out ON public.delivery_jobs (payment_out_id, created_at DESC);

-- Idempotency: ONE pending/processing job per business object per job type.
CREATE UNIQUE INDEX uq_delivery_jobs_invoice_send_sale ON public.delivery_jobs (sale_id)
  WHERE job_type = 'invoice_send' AND status IN ('pending', 'processing');
CREATE UNIQUE INDEX uq_delivery_jobs_invoice_send_purchase ON public.delivery_jobs (purchase_id)
  WHERE job_type = 'invoice_send' AND status IN ('pending', 'processing');
CREATE UNIQUE INDEX uq_delivery_jobs_invoice_send_proforma ON public.delivery_jobs (proforma_id)
  WHERE job_type = 'invoice_send' AND status IN ('pending', 'processing');
CREATE UNIQUE INDEX uq_delivery_jobs_reminder_sale ON public.delivery_jobs (sale_id)
  WHERE job_type = 'reminder' AND status IN ('pending', 'processing');
CREATE UNIQUE INDEX uq_delivery_jobs_receipt_in ON public.delivery_jobs (payment_in_id)
  WHERE job_type = 'receipt' AND status IN ('pending', 'processing');
CREATE UNIQUE INDEX uq_delivery_jobs_receipt_out ON public.delivery_jobs (payment_out_id)
  WHERE job_type = 'receipt' AND status IN ('pending', 'processing');

-- ─── 5. RLS: read-only for app users, writes are system-only ────────────────

ALTER TABLE public.reminder_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.delivery_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "reminder_settings_read" ON public.reminder_settings
  FOR SELECT TO authenticated
  USING (private.can_access_app());

-- delivery_jobs: SELECT only (status display). No INSERT/UPDATE/DELETE
-- policies: job state is SYSTEM-owned (the backend service role bypasses
-- RLS; the browser can never mutate delivery state).
CREATE POLICY "delivery_jobs_read" ON public.delivery_jobs
  FOR SELECT TO authenticated
  USING (private.can_access_app());

-- Table privileges: the broad default grants are narrowed to SELECT for
-- the API roles (writes remain possible only for postgres/service_role).
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.reminder_settings FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.delivery_jobs FROM anon, authenticated;

-- ─── 6. Job-system RPCs (service-role only) ─────────────────────────────────

-- 6a. Atomically claim due jobs (FOR UPDATE SKIP LOCKED: two scheduler
--     executions can never claim/execute the same job). Optionally claims
--     ONE specific pending job (manual trigger path).
CREATE OR REPLACE FUNCTION public.claim_due_delivery_jobs(
  p_worker text,
  p_batch_size int DEFAULT 5,
  p_lease_seconds int DEFAULT 300,
  p_job_id uuid DEFAULT NULL
) RETURNS SETOF public.delivery_jobs
LANGUAGE sql AS $$
  UPDATE public.delivery_jobs AS j SET
    status = 'processing',
    claimed_by = p_worker,
    claimed_at = now(),
    claim_expires_at = now() + make_interval(secs => GREATEST(30, p_lease_seconds)),
    started_at = now(),
    attempts = j.attempts + 1,
    updated_at = now()
  WHERE j.id IN (
    SELECT c.id FROM public.delivery_jobs c
     WHERE c.status = 'pending'
       AND c.run_at <= now()
       AND (p_job_id IS NULL OR c.id = p_job_id)
     ORDER BY c.run_at
     LIMIT GREATEST(1, LEAST(p_batch_size, 25))
     FOR UPDATE SKIP LOCKED
  )
  RETURNING j.*;
$$;

-- 6b. Recover abandoned jobs: a 'processing' job whose lease expired (the
--     worker crashed or stalled) becomes retryable again — or terminally
--     'failed' once attempts reached max_attempts. Runs on every scheduler
--     scan (not only at startup), so recovery is continuous.
CREATE OR REPLACE FUNCTION public.recover_expired_delivery_jobs()
RETURNS TABLE (id uuid, status text, attempts int)
LANGUAGE sql AS $$
  UPDATE public.delivery_jobs AS j SET
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
    SELECT e.id FROM public.delivery_jobs e
     WHERE e.status = 'processing' AND e.claim_expires_at < now()
     FOR UPDATE SKIP LOCKED
  ) ex
  WHERE j.id = ex.id
  RETURNING j.id, j.status, j.attempts;
$$;

-- 6c. Persist a job outcome. For a successful reminder this ALSO advances
--     the durable reminder state and (when still eligible) creates the
--     NEXT reminder job — the next-job chain. All state changes are ONE
--     transaction: a crash between send and persistence is bounded by the
--     lease → recovery (at-least-once delivery; see backend docs).
CREATE OR REPLACE FUNCTION public.complete_delivery_job(
  p_job_id uuid,
  p_outcome text,
  p_message_id text DEFAULT NULL,
  p_error text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  j public.delivery_jobs;
  cfg record;
  sale_active boolean;
  sale_due numeric;
  next_job_id uuid;
BEGIN
  IF p_outcome NOT IN ('success', 'retry', 'fail', 'cancel') THEN
    RAISE EXCEPTION 'Invalid delivery job outcome: %', p_outcome;
  END IF;

  SELECT * INTO j FROM public.delivery_jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('updated', false, 'reason', 'job_not_found');
  END IF;
  IF j.status <> 'processing' THEN
    -- Completed/recovered/re-claimed elsewhere: never overwrite newer state.
    RETURN jsonb_build_object('updated', false, 'reason', 'not_processing', 'status', j.status);
  END IF;

  IF p_outcome = 'success' THEN
    UPDATE public.delivery_jobs SET
      status = 'succeeded', finished_at = now(), message_id = p_message_id,
      last_error = NULL, updated_at = now()
    WHERE id = p_job_id;
  ELSIF p_outcome = 'retry' THEN
    UPDATE public.delivery_jobs SET
      status = 'pending',
      run_at = now() + make_interval(secs => LEAST(3600::double precision, 60 * power(2, GREATEST(j.attempts - 1, 0)))),
      claimed_by = NULL, claimed_at = NULL, claim_expires_at = NULL,
      last_error = p_error, updated_at = now()
    WHERE id = p_job_id;
  ELSE
    UPDATE public.delivery_jobs SET
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
        INSERT INTO public.delivery_jobs (job_type, sale_id, run_at)
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

-- 6d. Create/update the per-invoice reminder configuration AND reconcile
--     the pending job atomically: enabling (re)starts the chain only when
--     the invoice is currently eligible; disabling cancels pending jobs.
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
    INSERT INTO public.delivery_jobs (job_type, sale_id, run_at)
    VALUES ('reminder', p_sale_id, now() + make_interval(days => cfg.frequency_days))
    ON CONFLICT (sale_id) WHERE job_type = 'reminder' AND status IN ('pending', 'processing')
      DO NOTHING
    RETURNING id INTO next_job_id;
  ELSE
    -- Disabled or no longer eligible: stop the chain. Pending jobs are
    -- cancelled; an in-flight (processing) job is left to finish — its
    -- completion step re-checks the config before scheduling the next.
    UPDATE public.delivery_jobs
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

-- 6e. Manual "send a reminder NOW": pulls the scheduled reminder job
--     forward to run immediately (or creates a one-off job when no chain
--     is configured). Idempotent via the pending/processing unique index.
CREATE OR REPLACE FUNCTION public.trigger_reminder_now(
  p_sale_id uuid
) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  s record;
  j public.delivery_jobs;
BEGIN
  SELECT status, due INTO s FROM public.sales WHERE id = p_sale_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sale not found';
  END IF;
  IF s.status <> 'active' OR s.due <= 0 THEN
    RAISE EXCEPTION 'Invoice is not eligible for a reminder';
  END IF;

  INSERT INTO public.delivery_jobs (job_type, sale_id, run_at)
  VALUES ('reminder', p_sale_id, now())
  ON CONFLICT (sale_id) WHERE job_type = 'reminder' AND status IN ('pending', 'processing')
    DO UPDATE SET run_at = now(), updated_at = now()
  RETURNING * INTO j;

  RETURN jsonb_build_object('job', j);
END;
$$;

-- ─── 7. RPC grants: service_role ONLY ───────────────────────────────────────
-- The default privileges grant EXECUTE to the API roles; job-state mutation
-- must be impossible from the browser. (The backend authorizes the USER per
-- request, then executes these as the system.)

REVOKE EXECUTE ON FUNCTION public.claim_due_delivery_jobs(text, int, int, uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.recover_expired_delivery_jobs() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.complete_delivery_job(uuid, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.upsert_reminder_config(uuid, boolean, int, int) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.trigger_reminder_now(uuid) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.claim_due_delivery_jobs(text, int, int, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.recover_expired_delivery_jobs() TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_delivery_job(uuid, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.upsert_reminder_config(uuid, boolean, int, int) TO service_role;
GRANT EXECUTE ON FUNCTION public.trigger_reminder_now(uuid) TO service_role;
