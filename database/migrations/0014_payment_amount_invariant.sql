-- ─────────────────────────────────────────────────────────────────────────────
-- 0014 — Payment amount invariant at the RPC trust boundary.
--
-- The authoritative receive_payment / pay_purchase must never accept a
-- NULL, zero or negative amount: the invariant is enforced BEFORE any row
-- is locked or written, so a refused call can leave no payment, ledger or
-- account side effect. The live TEST database already carries exactly
-- these bodies (verified by direct RPC boundary tests: NULL / zero /
-- negative rejected with zero side effects; overpayment still rejected by
-- the unchanged upper bound; valid positive amounts succeed with exactly
-- one payment row + one ledger row + the paid/due mutation).
--
-- This migration brings the migration chain to the same canonical state
-- so a fresh install matches the verified runtime. It follows the repo's
-- established redefinition convention (0007 redefines 0003's payment RPCs
-- the same way): no accounting semantics, upper-bound validation
-- ('Cannot exceed due amount') or locking change — only the invariant
-- block is added, and the automatic-receipt hook is preserved.
-- ─────────────────────────────────────────────────────────────────────────────

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
  -- Payment-amount invariant at the trust boundary: a payment must be a
  -- positive amount. Rejected before any row is locked or written, so a
  -- refused call can leave no payment, ledger or account side effects.
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Enter a payment amount greater than zero';
  END IF;

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
  -- Payment-amount invariant at the trust boundary (see receive_payment).
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Enter a payment amount greater than zero';
  END IF;

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
-- (0007 restates it the same way; CREATE OR REPLACE resets nothing, the
-- posture is repeated so the migration is self-describing).
GRANT EXECUTE ON FUNCTION public.receive_payment(uuid, numeric, date, uuid, uuid) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION public.pay_purchase(uuid, numeric, date, uuid, uuid) TO authenticated, anon;
