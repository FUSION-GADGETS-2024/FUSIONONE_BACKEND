-- ============================================================
-- FUSIONONE — 0007 Automatic payment receipts + Payment Statement
-- ============================================================
-- Extends the ESTABLISHED 0006 delivery system (do not rebuild it):
--
--   1. whatsapp_settings: independent automatic-receipt switches for
--      Payment In / Payment Out (default OFF) + Payment Statement
--      message templates (In / Out). Receipts are no longer manual-only:
--      a SUBSEQUENT payment (receive_payment / pay_purchase RPC) can
--      automatically create ONE durable receipt job.
--
--   2. delivery_jobs: new job_type 'statement' (manual-only Payment
--      Statement delivery, referenced by sale_id / purchase_id) with its
--      ref-shape arm and idempotency partial unique indexes.
--
--   3. private.create_auto_receipt_job: the transactional bridge called
--      INSIDE receive_payment / pay_purchase — the payment record, the
--      accounting updates, and (when enabled) its automatic receipt job
--      commit as ONE database transaction. A browser closing after the
--      payment can never lose the receipt job.
--
-- INITIAL vs SUBSEQUENT payments (the core product rule):
--   create_sale / create_purchase record the initial payment with their
--   OWN payments_in/payments_out INSERT and never call the auto-receipt
--   helper → the initial payment NEVER creates an automatic receipt.
--   receive_payment / pay_purchase are the subsequent-payment operations
--   → they are the only auto-receipt trigger sites.

-- ─── 1. WhatsApp settings: automatic-receipt switches + statement templates ──

ALTER TABLE public.whatsapp_settings
  ADD COLUMN auto_send_receipt_in BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN auto_send_receipt_out BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN payment_statement_in_message_template TEXT NOT NULL DEFAULT
    'Hello {{customer_name}},

Please find attached the payment statement for invoice {{invoice_number}}.

Total paid: ₹{{total_paid}}
Balance due: ₹{{balance_due}}

Thank you for your business.',
  ADD COLUMN payment_statement_out_message_template TEXT NOT NULL DEFAULT
    'Hello {{customer_name}},

Please find attached the payment statement for bill {{invoice_number}}.

Total paid: ₹{{total_paid}}
Balance due: ₹{{balance_due}}';

-- ─── 2. delivery_jobs: the 'statement' job type ─────────────────────────────
-- Payment Statements are manual-only (§20): they are created exclusively by
-- the backend from the Payments dialog action, never by a payment operation.

-- 2a. Widen the job_type domain.
ALTER TABLE public.delivery_jobs
  DROP CONSTRAINT delivery_jobs_job_type_check;
ALTER TABLE public.delivery_jobs
  ADD CONSTRAINT delivery_jobs_job_type_check
    CHECK (job_type IN ('invoice_send', 'reminder', 'receipt', 'statement'));

-- 2b. Widen the ref-shape constraint with the statement arm (sale XOR
--     purchase; never a payment or proforma reference).
ALTER TABLE public.delivery_jobs
  DROP CONSTRAINT delivery_jobs_ref_shape;
ALTER TABLE public.delivery_jobs
  ADD CONSTRAINT delivery_jobs_ref_shape CHECK (
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
    ) OR (
      job_type = 'statement'
      AND proforma_id IS NULL AND payment_in_id IS NULL AND payment_out_id IS NULL
      AND (
        (sale_id IS NOT NULL AND purchase_id IS NULL)
        OR (sale_id IS NULL AND purchase_id IS NOT NULL)
      )
    )
  );

COMMENT ON COLUMN public.delivery_jobs.job_type IS
  'invoice_send | reminder | receipt (manual + automatic) | statement (manual only)';

-- 2c. Statement idempotency: ONE pending/processing statement per invoice/bill.
CREATE UNIQUE INDEX uq_delivery_jobs_statement_sale ON public.delivery_jobs (sale_id)
  WHERE job_type = 'statement' AND status IN ('pending', 'processing');
CREATE UNIQUE INDEX uq_delivery_jobs_statement_purchase ON public.delivery_jobs (purchase_id)
  WHERE job_type = 'statement' AND status IN ('pending', 'processing');

-- ─── 3. The transactional auto-receipt bridge ───────────────────────────────
-- SECURITY DEFINER, pinned search_path, owned by the migration executor
-- (postgres): the delivery_jobs table has deliberately NO write policies for
-- the API roles — job state is system-owned. The helper lives in the PRIVATE
-- schema (never exposed by PostgREST), so the browser cannot call it
-- directly; it is invoked only from inside receive_payment / pay_purchase,
-- where it runs in the CALLER's payment transaction (SECURITY INVOKER RPC
-- bodies need EXECUTE, granted to authenticated below, revoked from anon).
--
-- The helper decides NOTHING about payment validity — the RPCs own that. It
-- only reads the store-level switch and (when enabled) inserts ONE receipt
-- job referencing the exact payment record, idempotent via the 0006 partial
-- unique index.

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
      INSERT INTO public.delivery_jobs (job_type, run_at, payment_in_id)
      VALUES ('receipt', now(), p_payment_id)
      ON CONFLICT (payment_in_id) WHERE job_type = 'receipt' AND status IN ('pending', 'processing')
        DO NOTHING;
    ELSE
      INSERT INTO public.delivery_jobs (job_type, run_at, payment_out_id)
      VALUES ('receipt', now(), p_payment_id)
      ON CONFLICT (payment_out_id) WHERE job_type = 'receipt' AND status IN ('pending', 'processing')
        DO NOTHING;
    END IF;
  END IF;
END;
$$;

COMMENT ON FUNCTION private.create_auto_receipt_job(text, uuid) IS
  'Transactional automatic-receipt job creation, called only from receive_payment/pay_purchase (private schema: not PostgREST-exposed).';

-- Grants: authenticated may EXECUTE (the SECURITY INVOKER payment RPCs call
-- it on their callers'' behalf); anon may not. No table writes are granted —
-- the DEFINER context performs the single system-owned INSERT.
REVOKE EXECUTE ON FUNCTION private.create_auto_receipt_job(text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.create_auto_receipt_job(text, uuid) TO authenticated;

-- ─── 4. receive_payment: attach the automatic receipt to the payment tx ─────
-- The ONLY functional change is the final PERFORM: payment + ledger updates +
-- (optional) receipt job now commit atomically. No accounting semantics,
-- validations, or locking change.

CREATE OR REPLACE FUNCTION public.receive_payment(
  p_sale_id uuid,
  p_amount numeric,
  p_date date,
  p_bank_account_id uuid,
  p_payment_mode_id uuid DEFAULT NULL
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  s record;
  pi_id uuid;
BEGIN
  SELECT paid, due, party_id, financial_year_id INTO s
    FROM public.sales WHERE id = p_sale_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sale not found';
  END IF;
  IF p_amount > s.due THEN
    RAISE EXCEPTION 'Cannot exceed due amount';
  END IF;

  UPDATE public.sales SET paid = s.paid + p_amount, due = s.due - p_amount
   WHERE id = p_sale_id;

  INSERT INTO public.payments_in (
    sale_id, party_id, amount, bank_account_id, payment_mode_id, date, financial_year_id
  ) VALUES (
    p_sale_id, s.party_id, p_amount, p_bank_account_id, p_payment_mode_id, p_date, s.financial_year_id
  ) RETURNING id INTO pi_id;

  INSERT INTO public.account_transactions (
    bank_account_id, payment_mode_id, type, amount, date,
    reference_type, reference_id, financial_year_id
  ) VALUES (
    p_bank_account_id, p_payment_mode_id, 'credit', p_amount, p_date,
    'payment_in', pi_id, s.financial_year_id
  );

  -- Automatic receipt for a SUBSEQUENT payment (when the store switch is
  -- ON): same transaction as the payment itself — atomic durability.
  PERFORM private.create_auto_receipt_job('in', pi_id);
END;
$$;

-- ─── 5. pay_purchase: the Payment Out twin ──────────────────────────────────

CREATE OR REPLACE FUNCTION public.pay_purchase(
  p_purchase_id uuid,
  p_amount numeric,
  p_date date,
  p_bank_account_id uuid,
  p_payment_mode_id uuid DEFAULT NULL
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  p record;
  po_id uuid;
BEGIN
  SELECT paid, due, party_id, financial_year_id INTO p
    FROM public.purchases WHERE id = p_purchase_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Purchase not found';
  END IF;
  IF p_amount > p.due THEN
    RAISE EXCEPTION 'Cannot exceed due amount';
  END IF;

  UPDATE public.purchases SET paid = p.paid + p_amount, due = p.due - p_amount
   WHERE id = p_purchase_id;

  INSERT INTO public.payments_out (
    purchase_id, party_id, amount, bank_account_id, payment_mode_id, date, financial_year_id
  ) VALUES (
    p_purchase_id, p.party_id, p_amount, p_bank_account_id, p_payment_mode_id, p_date, p.financial_year_id
  ) RETURNING id INTO po_id;

  INSERT INTO public.account_transactions (
    bank_account_id, payment_mode_id, type, amount, date,
    reference_type, reference_id, financial_year_id
  ) VALUES (
    p_bank_account_id, p_payment_mode_id, 'debit', p_amount, p_date,
    'payment_out', po_id, p.financial_year_id
  );

  -- Automatic receipt for a SUBSEQUENT payment (Payment Out switch).
  PERFORM private.create_auto_receipt_job('out', po_id);
END;
$$;

-- Re-apply the established grant posture for the two replaced public RPCs
-- (CREATE OR REPLACE resets nothing, but the posture is restated explicitly
-- so the migration is self-describing; default privileges already grant
-- EXECUTE to the API roles for public functions).
GRANT EXECUTE ON FUNCTION public.receive_payment(uuid, numeric, date, uuid, uuid) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION public.pay_purchase(uuid, numeric, date, uuid, uuid) TO authenticated, anon;
