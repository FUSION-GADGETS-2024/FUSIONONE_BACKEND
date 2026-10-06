-- ============================================================
-- FUSIONONE — 0011 Transactional store setup
-- ============================================================
-- PHASE I of the auth migration. Replaces the onboarding wizard's multiple
-- independent browser writes with ONE transactional database operation. If
-- any required step fails, EVERYTHING rolls back — no half-created store, no
-- orphan bank accounts / payment modes / financial year.
--
-- SECURITY INVOKER: runs under the caller's identity and RLS (the store
-- INSERT/UPDATE policies are owner-only; business tables require an
-- authorized app user). An explicit owner guard produces a clean error
-- before any write. The singleton constraint is the hard second-store
-- guarantee (concurrent setups: the second transaction fails on the index).

CREATE OR REPLACE FUNCTION complete_store_setup(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_name        TEXT := NULLIF(trim(payload->>'name'), '');
  v_phone       TEXT := NULLIF(trim(payload->>'phone'), '');
  v_address     TEXT := NULLIF(payload->>'address', '');
  v_email       TEXT := NULLIF(payload->>'email', '');
  v_website     TEXT := NULLIF(payload->>'website', '');
  v_gstin       TEXT := NULLIF(payload->>'gstin', '');
  v_logo_url    TEXT := NULLIF(payload->>'logo_url', '');
  v_bank_name   TEXT := NULLIF(trim(payload->>'bank_name'), '');
  v_fy_start    DATE := NULLIF(payload->>'fy_start', '')::date;
  v_fy_end      DATE := NULLIF(payload->>'fy_end', '')::date;
  v_modes       TEXT[] := COALESCE(
                           (SELECT array_agg(DISTINCT m)
                              FROM jsonb_array_elements_text(payload->'payment_modes') AS m
                             WHERE NULLIF(trim(m), '') IS NOT NULL),
                           ARRAY[]::TEXT[]
                         );
  v_store_id    UUID;
  v_bank_id     UUID;
  v_fy_id       UUID;
BEGIN
  -- Fail closed on role: only the (single) owner may set up the store.
  IF NOT private.is_owner() THEN
    RAISE EXCEPTION 'Owner access is required to set up the store';
  END IF;

  -- Validations (the wizard's rules, enforced again server-side).
  IF v_name IS NULL OR v_phone IS NULL THEN
    RAISE EXCEPTION 'Store Name and Phone are required.';
  END IF;
  IF v_bank_name IS NULL THEN
    RAISE EXCEPTION 'First Bank Account Name is required.';
  END IF;
  IF v_fy_start IS NULL OR v_fy_end IS NULL THEN
    RAISE EXCEPTION 'Start Date and End Date are required.';
  END IF;
  IF v_fy_start >= v_fy_end THEN
    RAISE EXCEPTION 'Start Date must be earlier than End Date.';
  END IF;

  -- Repeat setup must never create a second store.
  IF EXISTS (SELECT 1 FROM public.store) THEN
    RAISE EXCEPTION 'Store setup has already been completed.';
  END IF;

  -- 1. The one store row (singleton = 1 by default).
  INSERT INTO public.store (
    name, address, phone, email, website, gstin, logo_url, onboarding_complete
  ) VALUES (
    v_name, v_address, v_phone, v_email, v_website, v_gstin, v_logo_url, true
  )
  RETURNING id INTO v_store_id;

  -- 2. Cash account + the first bank account.
  INSERT INTO public.bank_accounts (name, is_cash) VALUES ('Cash', true);
  INSERT INTO public.bank_accounts (name, is_cash)
    VALUES (v_bank_name, false)
    RETURNING id INTO v_bank_id;

  -- 3. Payment modes for the first bank account.
  IF array_length(v_modes, 1) > 0 THEN
    INSERT INTO public.payment_modes (bank_account_id, name)
    SELECT v_bank_id, m FROM unnest(v_modes) AS m;
  END IF;

  -- 4. First financial year (the exclusion constraint rejects overlaps).
  INSERT INTO public.financial_years (
    start_date, end_date, status, sale_counter, purchase_counter, proforma_counter
  ) VALUES (
    v_fy_start, v_fy_end, 'active', 0, 0, 0
  )
  RETURNING id INTO v_fy_id;

  -- 5. Active financial year + onboarding complete — same transaction.
  UPDATE public.store
     SET active_financial_year_id = v_fy_id,
         onboarding_complete = true
   WHERE id = v_store_id;

  RETURN jsonb_build_object(
    'store_id', v_store_id,
    'financial_year_id', v_fy_id
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.complete_store_setup(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.complete_store_setup(jsonb) TO authenticated;
