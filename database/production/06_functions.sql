-- ============================================================
-- FUSION ONE — canonical production schema 06: functions
-- ============================================================
-- All 38 remaining application functions (03 created the two
-- pre-table text helpers):
--
--   private (13) — authorization predicates (can_access_app,
--     is_owner: SECURITY DEFINER, search_path='', verified+
--     active+password-context JWT), the auth provisioning hook,
--     validation/canonicalization trigger functions, the
--     transactional auto-receipt bridge, JSON helper.
--
--   public (25) — the canonical business RPCs (create/update/
--     cancel/delete sale, create/void/update proforma,
--     create_purchase with server-computed totals and hardened
--     validation, payments with the amount invariant at the
--     trust boundary, funds/transfer, financial-year lifecycle,
--     store setup, the ranked search RPCs, the message-job
--     service-role RPCs, messages_overview, and the FY label
--     helpers).
--
-- Function bodies are byte-faithful to the verified live schema
-- (the 0014 amount invariant, 0015 canonical recovery
-- numbering, and 0017+0018 document-free trade-in bodies).
--
-- EXECUTE grants are set in 09_grants.sql, not here.
-- Idempotent: CREATE OR REPLACE with identical bodies.
-- ============================================================

-- FUNCTION: can_access_app()
CREATE OR REPLACE FUNCTION private.can_access_app() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
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

-- FUNCTION: create_auto_receipt_job(text, uuid)
CREATE OR REPLACE FUNCTION private.create_auto_receipt_job(p_direction text, p_payment_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'private'
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

-- FUNCTION: freeze_sold_item_identity()
CREATE OR REPLACE FUNCTION private.freeze_sold_item_identity() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
BEGIN
  IF OLD.status = 'sold'
     AND (NEW.brand      IS DISTINCT FROM OLD.brand
       OR NEW.model      IS DISTINCT FROM OLD.model
       OR NEW.imei       IS DISTINCT FROM OLD.imei
       OR NEW.ram_rom    IS DISTINCT FROM OLD.ram_rom
       OR NEW.color      IS DISTINCT FROM OLD.color) THEN
    RAISE EXCEPTION 'Cannot change the identity of a sold device (% %, IMEI %). Identity fields are locked once a device is sold.',
      OLD.brand, OLD.model, OLD.imei;
  END IF;
  RETURN NEW;
END;
$$;

-- FUNCTION: handle_new_auth_user()
CREATE OR REPLACE FUNCTION private.handle_new_auth_user() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
BEGIN
  INSERT INTO public.users (id, user_type)
  VALUES (NEW.id, NULL)
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

-- FUNCTION: inventory_identity_validation()
CREATE OR REPLACE FUNCTION private.inventory_identity_validation() RETURNS trigger
    LANGUAGE plpgsql
    AS $_$
BEGIN
  NEW.imei := btrim(NEW.imei);
  IF NEW.imei IS NULL OR NEW.imei !~ '^[0-9]{15}$' THEN
    RAISE EXCEPTION 'IMEI "%" is invalid: it must be exactly 15 digits (no spaces, +, hyphens or letters)', coalesce(NEW.imei, '')
      USING ERRCODE = '23514';
  END IF;

  IF NEW.ram_rom IS NOT NULL THEN
    NEW.ram_rom := btrim(NEW.ram_rom);
    IF NEW.ram_rom = '' THEN
      NEW.ram_rom := NULL;
    ELSIF NEW.ram_rom !~ '^[0-9]+/[0-9]+$' THEN
      RAISE EXCEPTION 'RAM/ROM "%" is invalid: expected RAM/ROM with numeric values, e.g. 8/128 or 12/256', NEW.ram_rom
          USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$_$;

-- FUNCTION: is_owner()
CREATE OR REPLACE FUNCTION private.is_owner() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
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

-- FUNCTION: jsonb_array_len(jsonb)
CREATE OR REPLACE FUNCTION private.jsonb_array_len(v jsonb) RETURNS integer
    LANGUAGE sql IMMUTABLE
    AS $$
  SELECT CASE WHEN jsonb_typeof(v) = 'array' THEN jsonb_array_length(v) ELSE 0 END
$$;

-- FUNCTION: parties_phone_canonical()
CREATE OR REPLACE FUNCTION private.parties_phone_canonical() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  canon text;
BEGIN
  IF NEW.number IS NULL OR btrim(NEW.number) = '' THEN
    NEW.number := NULL;   -- canonical empty is NULL, never ''
  ELSE
    canon := private.try_normalize_phone_in(NEW.number);
    IF canon IS NULL THEN
      RAISE EXCEPTION 'Invalid phone number "%": expected an Indian mobile number (10 digits, 91-prefixed, or +91-prefixed)', NEW.number
        USING ERRCODE = '23514';
    END IF;
    NEW.number := canon;
  END IF;
  RETURN NEW;
END;
$$;

-- FUNCTION: store_phone_canonical()
CREATE OR REPLACE FUNCTION private.store_phone_canonical() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  canon text;
BEGIN
  IF NEW.phone IS NOT NULL THEN
    NEW.phone := btrim(NEW.phone);
    IF NEW.phone <> '' THEN
      canon := private.try_normalize_phone_in(NEW.phone);
      IF canon IS NOT NULL THEN
        NEW.phone := canon;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- FUNCTION: trim_users_display_name()
CREATE OR REPLACE FUNCTION private.trim_users_display_name() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
BEGIN
  NEW.display_name := btrim(NEW.display_name);
  RETURN NEW;
END;
$$;

-- FUNCTION: try_normalize_phone_in(text)
CREATE OR REPLACE FUNCTION private.try_normalize_phone_in(v text) RETURNS text
    LANGUAGE plpgsql IMMUTABLE
    AS $_$
DECLARE
  digits text;
BEGIN
  IF v IS NULL THEN RETURN NULL; END IF;
  digits := regexp_replace(v, '[^0-9]', '', 'g');
  IF digits ~ '^[6-9][0-9]{9}$' THEN
    RETURN '+91' || digits;
  END IF;
  IF digits ~ '^91[6-9][0-9]{9}$' THEN
    RETURN '+' || digits;
  END IF;
  RETURN NULL;
END;
$_$;

-- FUNCTION: users_owner_invariant()
CREATE OR REPLACE FUNCTION private.users_owner_invariant() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
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

-- FUNCTION: add_funds(uuid, numeric, date, uuid, text)
CREATE OR REPLACE FUNCTION public.add_funds(p_bank_account_id uuid, p_amount numeric, p_date date, p_financial_year_id uuid, p_notes text DEFAULT NULL::text) RETURNS uuid
    LANGUAGE plpgsql
    AS $$
DECLARE
  fy record;
  fund_id uuid;
  trimmed_notes text := NULLIF(btrim(coalesce(p_notes, '')), '');
BEGIN
  SELECT id, start_date, end_date, status INTO fy
    FROM public.financial_years WHERE id = p_financial_year_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Financial year not found';
  END IF;
  IF fy.status = 'closed' THEN
    RAISE EXCEPTION 'Cannot operate on a closed financial year';
  END IF;
  IF p_date < fy.start_date OR p_date > fy.end_date THEN
    RAISE EXCEPTION 'Date must be within financial year range (% to %)', fy.start_date, fy.end_date;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.bank_accounts WHERE id = p_bank_account_id) THEN
    RAISE EXCEPTION 'Bank account not found';
  END IF;

  INSERT INTO public.account_fund_entries (bank_account_id, amount, date, notes, financial_year_id)
  VALUES (p_bank_account_id, p_amount, p_date, trimmed_notes, p_financial_year_id)
  RETURNING id INTO fund_id;

  INSERT INTO public.account_transactions (
    bank_account_id, payment_mode_id, type, amount, date,
    reference_type, reference_id, financial_year_id, notes
  ) VALUES (
    p_bank_account_id, NULL, 'credit', p_amount, p_date,
    'add_funds', fund_id, p_financial_year_id, trimmed_notes
  );

  RETURN fund_id;
END;
$$;

-- FUNCTION: cancel_sale(uuid)
CREATE OR REPLACE FUNCTION public.cancel_sale(p_sale_id uuid) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
DECLARE
  s record;
  ti record;
  v_purchase_id uuid;
  resold jsonb := '[]'::jsonb;
  today date := current_date;
  pi_row record;
BEGIN
  SELECT status, financial_year_id INTO s
    FROM public.sales WHERE id = p_sale_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sale not found';
  END IF;
  IF s.status <> 'active' THEN
    RAISE EXCEPTION 'Only an active sale can be cancelled';
  END IF;
  IF (SELECT status FROM public.financial_years WHERE id = s.financial_year_id) <> 'active' THEN
    RAISE EXCEPTION 'Cannot cancel a sale in a closed financial year';
  END IF;

  -- 1. Mark cancelled.
  UPDATE public.sales SET status = 'cancelled' WHERE id = p_sale_id;

  -- 2. Return sold inventory to stock.
  UPDATE public.inventory_items SET status = 'in_stock'
   WHERE id IN (SELECT inventory_item_id FROM public.sale_items WHERE sale_id = p_sale_id);

  -- 3. Reverse payment_in entries (debit, dated today, reference the sale).
  FOR pi_row IN
    SELECT amount, bank_account_id FROM public.payments_in WHERE sale_id = p_sale_id
  LOOP
    INSERT INTO public.account_transactions (
      bank_account_id, type, amount, date, reference_type, reference_id, financial_year_id
    ) VALUES (
      pi_row.bank_account_id, 'debit', pi_row.amount, today, 'sale_cancelled', p_sale_id, s.financial_year_id
    );
  END LOOP;

  -- 4. Trade-ins: reverse the linked hidden purchase when the device is
  --    still in stock; otherwise cancel the purchase (resold case).
  --    Device identity is read through the Inventory relationship.
  FOR ti IN
    SELECT t.id, t.inventory_item_id, t.credit_value, t.mrp,
           i.brand, i.model, i.imei, i.ram_rom, i.color, i.status AS item_status
      FROM public.trade_ins t
      JOIN public.inventory_items i ON i.id = t.inventory_item_id
     WHERE t.sale_id = p_sale_id
     ORDER BY t.id
  LOOP
    SELECT p.purchase_id INTO v_purchase_id
      FROM public.purchase_items p
     WHERE p.inventory_item_id = ti.inventory_item_id
     ORDER BY p.purchase_id
     LIMIT 1;

    IF ti.item_status = 'in_stock' THEN
      -- Full reversal: trade_in row first (it references the inventory
      -- item), then the acquisition mapping/purchase, then the device.
      DELETE FROM public.trade_ins WHERE id = ti.id;
      IF v_purchase_id IS NOT NULL THEN
        DELETE FROM public.purchase_items WHERE purchase_id = v_purchase_id;
        DELETE FROM public.purchases WHERE id = v_purchase_id;
      END IF;
      DELETE FROM public.inventory_items WHERE id = ti.inventory_item_id;
    ELSE
      IF v_purchase_id IS NOT NULL THEN
        UPDATE public.purchases SET status = 'cancelled' WHERE id = v_purchase_id;
      END IF;
      resold := resold || jsonb_build_object(
        'id', ti.id,
        'sale_id', p_sale_id,
        'inventory_item_id', ti.inventory_item_id,
        'brand', ti.brand,
        'model', ti.model,
        'imei', ti.imei,
        'ram_rom', ti.ram_rom,
        'color', ti.color,
        'credit_value', ti.credit_value,
        'mrp', ti.mrp,
        'purchase_id', v_purchase_id,
        'status', ti.item_status
      );
    END IF;
  END LOOP;

  RETURN jsonb_build_object('resold', resold);
END;
$$;



SET default_tablespace = '';

SET default_table_access_method = heap;

-- FUNCTION: claim_due_message_jobs(text, integer, integer, uuid)
CREATE OR REPLACE FUNCTION public.claim_due_message_jobs(p_worker text, p_batch_size integer DEFAULT 5, p_lease_seconds integer DEFAULT 300, p_job_id uuid DEFAULT NULL::uuid) RETURNS SETOF public.message_jobs
    LANGUAGE sql
    AS $$
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

-- FUNCTION: close_financial_year(uuid)
CREATE OR REPLACE FUNCTION public.close_financial_year(p_fy_id uuid) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
DECLARE
  fy public.financial_years;
  next_start date;
  next_end date;
  next_fy_id uuid;
  carried_count integer := 0;
  accounts_cf integer := 0;
  has_opening boolean;
  bal record;
  fy_lbl text;
BEGIN
  SELECT * INTO fy FROM public.financial_years WHERE id = p_fy_id AND status = 'active' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Financial year not found or already closed';
  END IF;

  -- 1. Mark closed.
  UPDATE public.financial_years SET status = 'closed' WHERE id = fy.id;

  -- 2. Find or create the next FY (start = end + 1 day; end = +1 year - 1 day).
  next_start := fy.end_date + 1;
  SELECT id INTO next_fy_id FROM public.financial_years WHERE start_date = next_start LIMIT 1;
  IF next_fy_id IS NULL THEN
    next_end := (next_start + interval '1 year')::date - 1;
    INSERT INTO public.financial_years (start_date, end_date, status)
      VALUES (next_start, next_end, 'active')
      RETURNING id INTO next_fy_id;
  END IF;

  -- 3. Carry forward unsold stock as NEW inventory rows (copy, not move).
  WITH ins AS (
    INSERT INTO public.inventory_items (
      brand, model, imei, ram_rom, color, purchase_price, base_selling_price,
      status, source, financial_year_id, origin_inventory_item_id, opening_entry_type
    )
    SELECT i.brand, i.model, i.imei, i.ram_rom, i.color,
           i.purchase_price, i.base_selling_price,
           'in_stock', i.source, next_fy_id, i.id, 'carried_forward'
      FROM public.inventory_items i
     WHERE i.financial_year_id = fy.id AND i.status = 'in_stock'
    RETURNING 1
  )
  SELECT count(*) INTO carried_count FROM ins;

  -- 4. Opening balances (idempotent: only when none exist for the next FY).
  SELECT EXISTS (
    SELECT 1 FROM public.account_transactions
     WHERE financial_year_id = next_fy_id AND reference_type = 'opening_balance'
  ) INTO has_opening;

  IF NOT has_opening THEN
    fy_lbl := 'FY ' || public.fy_start_year_full(fy) || '–' || public.fy_end_year_2(fy);

    WITH balances AS (
      SELECT bank_account_id, sum(CASE WHEN type = 'credit' THEN amount ELSE -amount END) AS bal
        FROM public.account_transactions
       WHERE financial_year_id = fy.id
       GROUP BY bank_account_id
    ), ins AS (
      INSERT INTO public.account_transactions (
        bank_account_id, payment_mode_id, type, amount, date,
        reference_type, reference_id, financial_year_id, notes
      )
      SELECT b.bank_account_id, NULL,
             CASE WHEN b.bal > 0 THEN 'credit' ELSE 'debit' END,
             abs(b.bal), next_start, 'opening_balance', fy.id, next_fy_id,
             'Opening balance carried forward from ' || fy_lbl
        FROM balances b
       WHERE b.bal <> 0
      RETURNING 1
    )
    SELECT count(*) INTO accounts_cf FROM ins;
  END IF;

  RETURN jsonb_build_object('items_carried', carried_count, 'accounts_carried', accounts_cf);
END;
$$;

-- FUNCTION: complete_message_job(uuid, text, text, text)
CREATE OR REPLACE FUNCTION public.complete_message_job(p_job_id uuid, p_outcome text, p_message_id text DEFAULT NULL::text, p_error text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
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

-- FUNCTION: complete_store_setup(jsonb)
CREATE OR REPLACE FUNCTION public.complete_store_setup(payload jsonb) RETURNS jsonb
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

-- FUNCTION: create_proforma(jsonb)
CREATE OR REPLACE FUNCTION public.create_proforma(payload jsonb) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
DECLARE
  fy public.financial_years;
  sy text;
  ey text;
  bill_no text;
  proforma_id uuid;
  v_count integer;
  v_total numeric := 0;
  v_credit numeric := 0;
  v_final numeric;
  ti jsonb;
BEGIN
  SELECT * INTO fy FROM public.financial_years
   WHERE id = (payload->>'financial_year_id')::uuid FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Financial year not found';
  END IF;
  IF fy.status <> 'active' THEN
    RAISE EXCEPTION 'Cannot operate on a closed financial year';
  END IF;

  IF (payload->>'date')::date IS NULL
     OR (payload->>'date')::date < fy.start_date
     OR (payload->>'date')::date > fy.end_date THEN
    RAISE EXCEPTION 'Date must be within the financial year (% to %)', fy.start_date, fy.end_date;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.parties WHERE id = (payload->>'party_id')::uuid) THEN
    RAISE EXCEPTION 'Customer not found';
  END IF;

  IF COALESCE((payload->>'discount')::numeric, 0) < 0 THEN
    RAISE EXCEPTION 'Discount cannot be negative';
  END IF;

  IF private.jsonb_array_len(payload->'items') = 0 THEN
    RAISE EXCEPTION 'A quotation needs at least one item';
  END IF;

  SELECT count(*) INTO v_count
    FROM jsonb_array_elements(payload->'items') AS elem
     WHERE (elem->>'inventory_item_id')::uuid IS NULL
        OR (elem->>'rate')::numeric < 0;
  IF v_count > 0 THEN
    RAISE EXCEPTION 'Each quoted item needs an inventory item and a non-negative rate';
  END IF;

  SELECT count(*) INTO v_count
    FROM jsonb_array_elements(payload->'items') AS elem
     WHERE NOT EXISTS (
       SELECT 1 FROM public.inventory_items i
        WHERE i.id = (elem->>'inventory_item_id')::uuid
          AND i.status = 'in_stock'
          AND i.financial_year_id = fy.id
     );
  IF v_count > 0 THEN
    RAISE EXCEPTION 'One or more quoted items are no longer available in stock.';
  END IF;

  SELECT count(DISTINCT (elem->>'inventory_item_id')::uuid) INTO v_count
    FROM jsonb_array_elements(payload->'items') AS elem;
  IF v_count <> private.jsonb_array_len(payload->'items') THEN
    RAISE EXCEPTION 'The same device cannot be quoted twice';
  END IF;

  IF private.jsonb_array_len(payload->'trade_ins') > 0 THEN
    FOR ti IN SELECT * FROM jsonb_array_elements(payload->'trade_ins') LOOP
      IF btrim(COALESCE(ti->>'description', '')) = '' THEN
        RAISE EXCEPTION 'Trade-in description is required';
      END IF;
      IF (ti->>'rate')::numeric < 0 THEN
        RAISE EXCEPTION 'Trade-in rate cannot be negative';
      END IF;
      IF ti ? 'qty' AND NULLIF(ti->>'qty', '') IS NOT NULL
         AND (NULLIF(ti->>'qty', ''))::int < 1 THEN
        RAISE EXCEPTION 'Trade-in quantity must be a whole number of at least 1';
      END IF;
    END LOOP;
  END IF;

  sy := public.fy_start_year_full(fy);
  ey := public.fy_end_year_2(fy);
  bill_no := 'PI-' || sy || '-' || ey || '-' || lpad((fy.proforma_counter + 1)::text, 4, '0');

  UPDATE public.financial_years SET proforma_counter = fy.proforma_counter + 1 WHERE id = fy.id;

  INSERT INTO public.proforma_invoices (
    bill_number, party_id, total, discount, trade_in_credit, final_total,
    date, financial_year_id, status
  ) VALUES (
    bill_no,
    (payload->>'party_id')::uuid,
    0, 0, 0, 0,   -- placeholder, recomputed below in the same transaction
    (payload->>'date')::date,
    fy.id,
    'active'
  ) RETURNING id INTO proforma_id;

  INSERT INTO public.proforma_invoice_items (
    proforma_invoice_id, inventory_item_id, description, qty, rate, discount, value
  )
  SELECT proforma_id, (elem->>'inventory_item_id')::uuid, NULL, 1,
         (elem->>'rate')::numeric, 0, (elem->>'rate')::numeric
    FROM jsonb_array_elements(payload->'items') AS elem;

  IF jsonb_array_length(payload->'items') > 0 THEN
    SELECT sum(value) INTO v_total FROM public.proforma_invoice_items
     WHERE proforma_invoice_id = proforma_id;
  ELSE
    v_total := 0;
  END IF;

  IF private.jsonb_array_len(payload->'trade_ins') > 0 THEN
    INSERT INTO public.proforma_trade_ins (proforma_invoice_id, description, qty, rate, value)
    SELECT proforma_id, elem->>'description',
           COALESCE(NULLIF(elem->>'qty', '')::int, 1),
           (elem->>'rate')::numeric,
           COALESCE(NULLIF(elem->>'qty', '')::int, 1) * (elem->>'rate')::numeric
      FROM jsonb_array_elements(payload->'trade_ins') AS elem;
    SELECT sum(value) INTO v_credit FROM public.proforma_trade_ins
     WHERE proforma_invoice_id = proforma_id;
  END IF;

  v_final := GREATEST(0, v_total - COALESCE((payload->>'discount')::numeric, 0) - COALESCE(v_credit, 0));

  UPDATE public.proforma_invoices
     SET total = v_total,
         discount = COALESCE((payload->>'discount')::numeric, 0),
         trade_in_credit = COALESCE(v_credit, 0),
         final_total = v_final
   WHERE id = proforma_id;

  RETURN jsonb_build_object('proforma_id', proforma_id, 'bill_number', bill_no);
END;
$$;

-- FUNCTION: create_purchase(jsonb)
CREATE OR REPLACE FUNCTION public.create_purchase(payload jsonb) RETURNS jsonb
    LANGUAGE plpgsql
    AS $_$
DECLARE
  fy public.financial_years;
  sy text;
  ey text;
  elem jsonb;
  i integer;
  n integer;
  dup_imei text;
  purchase_id uuid;
  bill_no text;
  added_ids uuid[];
  v_total numeric;
  v_paid numeric;
BEGIN
  SELECT * INTO fy FROM public.financial_years WHERE id = (payload->>'financial_year_id')::uuid FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Financial year not found';
  END IF;
  IF fy.status <> 'active' THEN
    RAISE EXCEPTION 'Cannot operate on a closed financial year';
  END IF;

  IF (payload->>'date')::date IS NULL
     OR (payload->>'date')::date < fy.start_date
     OR (payload->>'date')::date > fy.end_date THEN
    RAISE EXCEPTION 'Date must be within the financial year (% to %)', fy.start_date, fy.end_date;
  END IF;

  n := private.jsonb_array_len(payload->'items');
  IF n = 0 THEN
    RAISE EXCEPTION 'A purchase requires at least one item';
  END IF;

  -- Per-item identity + price validation (fail BEFORE any write).
  FOR i IN 1 .. n LOOP
    elem := payload->'items'->(i - 1);
    IF btrim(coalesce(elem->>'brand', '')) = '' THEN
      RAISE EXCEPTION 'Brand is required on item %', i;
    END IF;
    IF btrim(coalesce(elem->>'model', '')) = '' THEN
      RAISE EXCEPTION 'Model is required on item %', i;
    END IF;
    IF btrim(coalesce(elem->>'imei', '')) = '' OR btrim(elem->>'imei') !~ '^[0-9]{15}$' THEN
      RAISE EXCEPTION 'IMEI on item % is invalid: it must be exactly 15 digits', i;
    END IF;
    IF btrim(coalesce(elem->>'ram_rom', '')) = '' THEN
      RAISE EXCEPTION 'RAM/ROM is required on item %', i;
    END IF;
    IF btrim(coalesce(elem->>'color', '')) = '' THEN
      RAISE EXCEPTION 'Color is required on item %', i;
    END IF;
    IF (elem->>'purchase_price')::numeric IS NULL OR (elem->>'purchase_price')::numeric < 0 THEN
      RAISE EXCEPTION 'Purchase price on item % must be a non-negative amount', i;
    END IF;
    IF (elem->>'base_selling_price')::numeric IS NULL OR (elem->>'base_selling_price')::numeric < 0 THEN
      RAISE EXCEPTION 'Base selling price on item % must be a non-negative amount', i;
    END IF;
  END LOOP;

  -- No duplicate IMEI within the payload itself.
  SELECT t.value->>'imei' INTO dup_imei
    FROM jsonb_array_elements(payload->'items') WITH ORDINALITY AS t(value, tord),
         jsonb_array_elements(payload->'items') WITH ORDINALITY AS u(value, uord)
   WHERE tord <> uord AND t.value->>'imei' = u.value->>'imei'
   LIMIT 1;
  IF dup_imei IS NOT NULL THEN
    RAISE EXCEPTION 'Duplicate IMEI % in the request', dup_imei;
  END IF;

  -- No IMEI already in stock (kept from the original RPC).
  -- (alias 'e' — the plpgsql variable 'elem' would shadow/collide)
  SELECT imei INTO dup_imei
    FROM public.inventory_items
   WHERE imei IN (SELECT btrim(e->>'imei') FROM jsonb_array_elements(payload->'items') AS e)
     AND status = 'in_stock'
   LIMIT 1;
  IF dup_imei IS NOT NULL THEN
    RAISE EXCEPTION 'IMEI % is already in stock in the database.', dup_imei;
  END IF;

  -- Server-authoritative totals (same values the form computes; the
  -- client's arithmetic is simply no longer trusted for storage).
  SELECT sum((e->>'purchase_price')::numeric) INTO v_total
    FROM jsonb_array_elements(payload->'items') AS e;
  v_paid := COALESCE(NULLIF(payload->>'paid', '')::numeric, 0);
  IF v_paid < 0 THEN
    RAISE EXCEPTION 'Paid amount cannot be negative';
  END IF;
  IF v_paid > v_total THEN
    RAISE EXCEPTION 'Paid amount cannot exceed the purchase total';
  END IF;

  -- Bill number + counter (format PUR-2026-27-0001).
  sy := public.fy_start_year_full(fy);
  ey := public.fy_end_year_2(fy);
  bill_no := 'PUR-' || sy || '-' || ey || '-' || lpad((fy.purchase_counter + 1)::text, 4, '0');

  UPDATE public.financial_years SET purchase_counter = fy.purchase_counter + 1 WHERE id = fy.id;

  INSERT INTO public.purchases (
    bill_number, party_id, total, paid, due, bank_account_id, payment_mode_id,
    date, financial_year_id, status
  ) VALUES (
    bill_no,
    (payload->>'party_id')::uuid,
    v_total,
    v_paid,
    v_total - v_paid,
    (payload->>'bank_account_id')::uuid,
    NULLIF(payload->>'payment_mode_id', '')::uuid,
    (payload->>'date')::date,
    fy.id,
    'active'
  ) RETURNING id INTO purchase_id;

  WITH ins AS (
    INSERT INTO public.inventory_items (
      brand, model, imei, ram_rom, color, purchase_price, base_selling_price,
      status, source, financial_year_id, opening_entry_type
    )
    SELECT btrim(e->>'brand'), btrim(e->>'model'), btrim(e->>'imei'),
           btrim(e->>'ram_rom'), btrim(e->>'color'),
           (e->>'purchase_price')::numeric, (e->>'base_selling_price')::numeric,
           'in_stock', 'purchase', fy.id, 'direct'
      FROM jsonb_array_elements(payload->'items') AS e
    RETURNING id
  )
  SELECT array_agg(id) INTO added_ids FROM ins;

  INSERT INTO public.purchase_items (purchase_id, inventory_item_id)
  SELECT purchase_id, unnest(added_ids);

  IF v_paid > 0 THEN
    INSERT INTO public.account_transactions (
      bank_account_id, payment_mode_id, type, amount, date,
      reference_type, reference_id, financial_year_id
    ) VALUES (
      (payload->>'bank_account_id')::uuid,
      NULLIF(payload->>'payment_mode_id', '')::uuid,
      'debit',
      v_paid,
      (payload->>'date')::date,
      'purchase',
      purchase_id,
      fy.id
    );

    INSERT INTO public.payments_out (
      purchase_id, party_id, amount, bank_account_id, payment_mode_id, date, financial_year_id
    ) VALUES (
      purchase_id,
      (payload->>'party_id')::uuid,
      v_paid,
      (payload->>'bank_account_id')::uuid,
      NULLIF(payload->>'payment_mode_id', '')::uuid,
      (payload->>'date')::date,
      fy.id
    );
  END IF;

  RETURN jsonb_build_object('purchase_id', purchase_id, 'bill_number', bill_no);
END;
$_$;

-- FUNCTION: create_sale(jsonb)
CREATE OR REPLACE FUNCTION public.create_sale(payload jsonb) RETURNS jsonb
    LANGUAGE plpgsql
    AS $_$
DECLARE
  v_fy public.financial_years;
  v_fy_id uuid;
  v_sy text;
  v_ey text;
  v_proforma public.proforma_invoices%ROWTYPE;
  v_party_id uuid;
  v_date date;
  v_discount numeric;
  v_paid numeric;
  v_bank uuid;
  v_mode uuid;
  v_item jsonb;
  v_ti jsonb;
  v_item_ids uuid[];
  v_in_stock_count integer;
  v_dup_imei text;
  v_bad_imei text;
  v_missing_required text;
  v_sale_id uuid;
  v_bill_no text;
  v_pur_bill text;
  v_purchase_id uuid;
  v_inv_id uuid;
  v_n_trade_ins integer;
  v_n_items integer;
  v_n_payload_items integer;
  v_total numeric := 0;
  v_trade_in_credit numeric := 0;
  v_final_total numeric;
  v_due numeric;
  v_i integer;
  v_line record;
  v_line_value numeric;
  v_count integer;
  v_resolved_items jsonb := '[]'::jsonb;  -- [{inventory_item_id, sold_price}]
BEGIN
  -- ════════════════════════════════════════════════════════════════
  -- MODE RESOLUTION: proforma conversion loads the commercial content
  -- from the database; normal mode takes it from the payload.
  -- ════════════════════════════════════════════════════════════════
  IF payload ? 'proforma_id' THEN
    SELECT * INTO v_proforma
      FROM public.proforma_invoices
     WHERE id = (payload->>'proforma_id')::uuid
     FOR UPDATE;                                   -- conversion lock
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Proforma not found';
    END IF;
    IF v_proforma.status <> 'active' THEN
      RAISE EXCEPTION 'Only an active proforma can be converted (current status: %)', v_proforma.status;
    END IF;

    v_fy_id := v_proforma.financial_year_id;
    v_party_id := v_proforma.party_id;
    v_discount := v_proforma.discount;

    -- Every quoted line must be fulfilled exactly once, by the right
    -- device, at the QUOTED value (server-enforced price snapshot).
    SELECT count(*) INTO v_n_items
      FROM public.proforma_invoice_items
     WHERE proforma_invoice_id = v_proforma.id;

    IF v_n_items = 0 THEN
      RAISE EXCEPTION 'Proforma has no items to convert';
    END IF;

    v_n_payload_items := private.jsonb_array_len(payload->'items');
    IF v_n_payload_items <> v_n_items THEN
      RAISE EXCEPTION 'Every quoted item must be fulfilled to convert the proforma (expected %, got %)',
        v_n_items, v_n_payload_items;
    END IF;

    -- Coverage must be one-to-one: each quoted line fulfilled exactly once.
    SELECT count(DISTINCT (elem->>'proforma_item_id')::uuid) INTO v_count
      FROM jsonb_array_elements(payload->'items') AS elem;
    IF v_count <> v_n_items THEN
      RAISE EXCEPTION 'Each quoted item must be fulfilled exactly once';
    END IF;

    -- Validate each fulfillment against its quoted line.
    FOR v_i IN 1 .. v_n_items LOOP
      v_item := payload->'items'->(v_i - 1);
      SELECT * INTO v_line
        FROM public.proforma_invoice_items
       WHERE id = (v_item->>'proforma_item_id')::uuid
         AND proforma_invoice_id = v_proforma.id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Quoted item % does not belong to this proforma', v_item->>'proforma_item_id';
      END IF;
      IF v_line.qty <> 1 THEN
        RAISE EXCEPTION 'Quoted lines with a quantity other than 1 cannot be converted — edit the quotation first';
      END IF;
      IF v_line.inventory_item_id IS NOT NULL
         AND v_line.inventory_item_id <> (v_item->>'inventory_item_id')::uuid THEN
        RAISE EXCEPTION 'Quoted device cannot be substituted with another inventory item';
      END IF;
      -- Quoted value = the preserved price snapshot.
      v_line_value := v_line.value;
      v_resolved_items := v_resolved_items || jsonb_build_object(
        'inventory_item_id', (v_item->>'inventory_item_id')::uuid,
        'sold_price', v_line_value
      );
      v_total := v_total + v_line_value;
    END LOOP;
  ELSE
    v_fy_id := (payload->>'financial_year_id')::uuid;
    v_party_id := (payload->>'party_id')::uuid;
    v_discount := COALESCE(NULLIF(payload->>'discount', '')::numeric, 0);
    v_n_items := private.jsonb_array_len(payload->'items');
    IF v_n_items = 0 THEN
      RAISE EXCEPTION 'A sale requires at least one item';
    END IF;
    FOR v_i IN 1 .. v_n_items LOOP
      v_item := payload->'items'->(v_i - 1);
      IF (v_item->>'sold_price')::numeric < 0 THEN
        RAISE EXCEPTION 'Sold price cannot be negative';
      END IF;
      v_total := v_total + (v_item->>'sold_price')::numeric;
      v_resolved_items := v_resolved_items || jsonb_build_object(
        'inventory_item_id', (v_item->>'inventory_item_id')::uuid,
        'sold_price', (v_item->>'sold_price')::numeric
      );
    END LOOP;
  END IF;

  -- ════════════════════════════════════════════════════════════════
  -- Common invariants (both modes).
  -- ════════════════════════════════════════════════════════════════
  SELECT * INTO v_fy FROM public.financial_years WHERE id = v_fy_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Financial year not found';
  END IF;
  IF v_fy.status <> 'active' THEN
    RAISE EXCEPTION 'Cannot operate on a closed financial year';
  END IF;

  v_date := (payload->>'date')::date;
  IF v_date IS NULL OR v_date < v_fy.start_date OR v_date > v_fy.end_date THEN
    RAISE EXCEPTION 'Date must be within the financial year (% to %)', v_fy.start_date, v_fy.end_date;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.parties WHERE id = v_party_id) THEN
    RAISE EXCEPTION 'Customer not found';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.bank_accounts WHERE id = (payload->>'bank_account_id')::uuid) THEN
    RAISE EXCEPTION 'Bank account not found';
  END IF;
  v_bank := (payload->>'bank_account_id')::uuid;
  v_mode := NULLIF(payload->>'payment_mode_id', '')::uuid;
  IF v_mode IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.payment_modes WHERE id = v_mode) THEN
    RAISE EXCEPTION 'Payment mode not found';
  END IF;

  IF v_discount < 0 THEN
    RAISE EXCEPTION 'Discount cannot be negative';
  END IF;

  -- Each device can only be sold once (checked before availability so the
  -- error names the actual problem).
  SELECT count(DISTINCT (elem->>'inventory_item_id')::uuid) INTO v_count
    FROM jsonb_array_elements(v_resolved_items) AS elem;
  IF v_count <> v_n_items THEN
    RAISE EXCEPTION 'The same device cannot be sold twice';
  END IF;

  -- All devices to sell must currently be in stock.
  SELECT array_agg((elem->>'inventory_item_id')::uuid) INTO v_item_ids
    FROM jsonb_array_elements(v_resolved_items) AS elem;
  SELECT count(DISTINCT x) INTO v_in_stock_count
    FROM unnest(v_item_ids) AS x
   JOIN public.inventory_items i ON i.id = x AND i.status = 'in_stock';
  IF v_in_stock_count <> v_n_items THEN
    RAISE EXCEPTION 'One or more selected items are no longer available in stock.';
  END IF;

  -- Trade-in devices: real identity, valid IMEI, no duplicates.
  v_n_trade_ins := private.jsonb_array_len(payload->'trade_ins');
  IF v_n_trade_ins > 0 THEN
    FOR v_i IN 1 .. v_n_trade_ins LOOP
      v_ti := payload->'trade_ins'->(v_i - 1);
      v_missing_required := NULL;
      IF btrim(COALESCE(v_ti->>'brand', '')) = '' THEN v_missing_required := 'brand';
      ELSIF btrim(COALESCE(v_ti->>'model', '')) = '' THEN v_missing_required := 'model';
      ELSIF btrim(COALESCE(v_ti->>'imei', '')) = '' THEN v_missing_required := 'IMEI';
      ELSIF btrim(COALESCE(v_ti->>'ram_rom', '')) = '' THEN v_missing_required := 'RAM/ROM';
      ELSIF btrim(COALESCE(v_ti->>'color', '')) = '' THEN v_missing_required := 'color';
      END IF;
      IF v_missing_required IS NOT NULL THEN
        RAISE EXCEPTION 'Trade-in % is required', v_missing_required;
      END IF;
      IF v_ti->>'imei' !~ '^[0-9]{15}$' THEN
        RAISE EXCEPTION 'Trade-in IMEI % is invalid: it must be exactly 15 digits', v_ti->>'imei';
      END IF;
      IF (v_ti->>'credit_value')::numeric < 0 THEN
        RAISE EXCEPTION 'Trade-in credit value cannot be negative';
      END IF;
      IF v_ti ? 'mrp' AND v_ti->>'mrp' <> '' AND (v_ti->>'mrp')::numeric < 0 THEN
        RAISE EXCEPTION 'Trade-in MRP cannot be negative';
      END IF;
    END LOOP;

    -- No duplicate IMEI within the payload.
    SELECT t.value->>'imei' INTO v_bad_imei
      FROM jsonb_array_elements(payload->'trade_ins') WITH ORDINALITY AS t(value, tord),
           jsonb_array_elements(payload->'trade_ins') WITH ORDINALITY AS u(value, uord)
     WHERE tord <> uord AND t.value->>'imei' = u.value->>'imei'
     LIMIT 1;
    IF v_bad_imei IS NOT NULL THEN
      RAISE EXCEPTION 'Duplicate trade-in IMEI in the request: %', v_bad_imei;
    END IF;

    -- No trade-in IMEI already in stock anywhere.
    SELECT imei INTO v_dup_imei
      FROM public.inventory_items
     WHERE imei IN (SELECT elem->>'imei' FROM jsonb_array_elements(payload->'trade_ins') AS elem)
       AND status = 'in_stock'
     LIMIT 1;
    IF v_dup_imei IS NOT NULL THEN
      RAISE EXCEPTION 'Trade-In IMEI % already in stock in the system.', v_dup_imei;
    END IF;
  END IF;

  -- Server-computed money (never client arithmetic).
  FOR v_i IN 1 .. v_n_trade_ins LOOP
    v_trade_in_credit := v_trade_in_credit + ((payload->'trade_ins'->(v_i - 1)->>'credit_value')::numeric);
  END LOOP;

  v_final_total := GREATEST(0, v_total - v_discount - v_trade_in_credit);
  v_paid := COALESCE(NULLIF(payload->>'paid', '')::numeric, 0);
  IF v_paid < 0 THEN
    RAISE EXCEPTION 'Paid amount cannot be negative';
  END IF;
  IF v_paid > v_final_total THEN
    RAISE EXCEPTION 'Paid amount cannot exceed the final total';
  END IF;
  v_due := GREATEST(0, v_final_total - v_paid);

  -- ════════════════════════════════════════════════════════════════
  -- Write path (one transaction — identical for both modes).
  -- ════════════════════════════════════════════════════════════════
  v_sy := public.fy_start_year_full(v_fy);
  v_ey := public.fy_end_year_2(v_fy);
  v_bill_no := 'SAL-' || v_sy || '-' || v_ey || '-' || lpad((v_fy.sale_counter + 1)::text, 4, '0');

  UPDATE public.financial_years
     SET sale_counter = v_fy.sale_counter + 1,
         purchase_counter = v_fy.purchase_counter + v_n_trade_ins
   WHERE id = v_fy.id;

  INSERT INTO public.sales (
    bill_number, party_id, total, discount, trade_in_credit, final_total,
    paid, due, bank_account_id, payment_mode_id, date, financial_year_id,
    status, proforma_id
  ) VALUES (
    v_bill_no, v_party_id, v_total, v_discount, v_trade_in_credit, v_final_total,
    v_paid, v_due, v_bank, v_mode, v_date, v_fy.id,
    'active', CASE WHEN payload ? 'proforma_id' THEN (payload->>'proforma_id')::uuid ELSE NULL END
  ) RETURNING id INTO v_sale_id;

  INSERT INTO public.sale_items (sale_id, inventory_item_id, sold_price)
  SELECT v_sale_id,
         (elem->>'inventory_item_id')::uuid,
         (elem->>'sold_price')::numeric
    FROM jsonb_array_elements(v_resolved_items) AS elem;

  UPDATE public.inventory_items SET status = 'sold' WHERE id = ANY(v_item_ids);

  -- Trade-ins: ONE inventory identity per physical device; the trade_in
  -- row records the transactional relationship only.
  FOR v_i IN 1 .. v_n_trade_ins LOOP
    v_ti := payload->'trade_ins'->(v_i - 1);
    -- Hidden acquisition purchase numbers continue from the PRE-update
    -- counter (preserved behavior: first bill = counter + 1).
    v_pur_bill := 'PUR-TRD-' || v_sy || '-' || v_ey || '-' ||
                  lpad((v_fy.purchase_counter + v_i)::text, 4, '0');

    INSERT INTO public.purchases (
      bill_number, party_id, total, paid, due, bank_account_id,
      date, financial_year_id, status
    ) VALUES (
      v_pur_bill, v_party_id,
      (v_ti->>'credit_value')::numeric,
      (v_ti->>'credit_value')::numeric,
      0, v_bank, v_date, v_fy.id, 'active'
    ) RETURNING id INTO v_purchase_id;

    -- The physical device: its identity lives HERE (inventory), nowhere else.
    INSERT INTO public.inventory_items (
      brand, model, imei, ram_rom, color, purchase_price, base_selling_price,
      status, source, financial_year_id, opening_entry_type
    ) VALUES (
      btrim(v_ti->>'brand'), btrim(v_ti->>'model'), v_ti->>'imei',
      btrim(v_ti->>'ram_rom'), btrim(v_ti->>'color'),
      (v_ti->>'credit_value')::numeric, (v_ti->>'credit_value')::numeric,
      'in_stock', 'trade_in', v_fy.id, 'direct'
    ) RETURNING id INTO v_inv_id;

    INSERT INTO public.purchase_items (purchase_id, inventory_item_id)
    VALUES (v_purchase_id, v_inv_id);

    INSERT INTO public.trade_ins (
      sale_id, inventory_item_id, credit_value, mrp
    ) VALUES (
      v_sale_id, v_inv_id,
      (v_ti->>'credit_value')::numeric,
      NULLIF(v_ti->>'mrp', '')::numeric
    );
  END LOOP;

  -- Payment-at-creation (canonical accounting path, unchanged).
  IF v_paid > 0 THEN
    INSERT INTO public.account_transactions (
      bank_account_id, payment_mode_id, type, amount, date,
      reference_type, reference_id, financial_year_id
    ) VALUES (
      v_bank, v_mode, 'credit', v_paid, v_date, 'sale', v_sale_id, v_fy.id
    );
    INSERT INTO public.payments_in (
      sale_id, party_id, amount, bank_account_id, payment_mode_id, date, financial_year_id
    ) VALUES (
      v_sale_id, v_party_id, v_paid, v_bank, v_mode, v_date, v_fy.id
    );
  END IF;

  -- Proforma conversion completes atomically with the sale.
  IF payload ? 'proforma_id' THEN
    UPDATE public.proforma_invoices
       SET status = 'converted'
     WHERE id = v_proforma.id;
  END IF;

  RETURN jsonb_build_object('sale_id', v_sale_id, 'bill_number', v_bill_no);
END;
$_$;

-- FUNCTION: create_trade_in_purchase_bill(uuid, uuid)
CREATE OR REPLACE FUNCTION public.create_trade_in_purchase_bill(p_sale_id uuid, p_trade_in_id uuid) RETURNS text
    LANGUAGE plpgsql
    AS $$
DECLARE
  s record;
  ti record;
  fy public.financial_years;
  counter integer;
  sy text;
  ey text;
  bill_no text;
  v_purchase_id uuid;
BEGIN
  SELECT party_id, bank_account_id, financial_year_id INTO s FROM public.sales WHERE id = p_sale_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sale not found';
  END IF;

  SELECT credit_value, inventory_item_id INTO ti FROM public.trade_ins WHERE id = p_trade_in_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Trade-in not found';
  END IF;

  SELECT * INTO fy FROM public.financial_years WHERE id = s.financial_year_id FOR UPDATE;

  counter := fy.purchase_counter + 1;
  -- Canonical purchase bill format (identical to create_purchase):
  -- PUR-<full start year>-<two-digit end year>-<counter>.
  sy := public.fy_start_year_full(fy);
  ey := public.fy_end_year_2(fy);
  bill_no := 'PUR-' || sy || '-' || ey || '-' || lpad(counter::text, 4, '0');

  INSERT INTO public.purchases (
    bill_number, party_id, total, paid, due, bank_account_id,
    date, financial_year_id, status
  ) VALUES (
    bill_no, s.party_id, ti.credit_value, ti.credit_value, 0, s.bank_account_id,
    current_date, fy.id, 'active'
  ) RETURNING id INTO v_purchase_id;

  INSERT INTO public.purchase_items (purchase_id, inventory_item_id)
  VALUES (v_purchase_id, ti.inventory_item_id);

  UPDATE public.financial_years SET purchase_counter = counter WHERE id = fy.id;

  RETURN bill_no;
END;
$$;

-- FUNCTION: delete_sale(uuid)
CREATE OR REPLACE FUNCTION public.delete_sale(p_sale_id uuid) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
  s record;
  ti record;
  v_purchase_id uuid;
BEGIN
  SELECT status, financial_year_id, paid, proforma_id INTO s
    FROM public.sales WHERE id = p_sale_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sale not found';
  END IF;
  IF s.status <> 'active' THEN
    RAISE EXCEPTION 'Only an active sale can be deleted';
  END IF;
  IF (SELECT status FROM public.financial_years WHERE id = s.financial_year_id) <> 'active' THEN
    RAISE EXCEPTION 'Cannot delete a sale in a closed financial year';
  END IF;
  IF s.paid > 0 THEN
    RAISE EXCEPTION 'Cannot delete: payment has already been received.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.payments_in WHERE sale_id = p_sale_id) THEN
    RAISE EXCEPTION 'Cannot delete: payment records exist for this sale.';
  END IF;

  FOR ti IN
    SELECT t.id, t.inventory_item_id, i.status AS item_status
      FROM public.trade_ins t
      JOIN public.inventory_items i ON i.id = t.inventory_item_id
     WHERE t.sale_id = p_sale_id
     ORDER BY t.id
  LOOP
    IF ti.item_status IS DISTINCT FROM 'in_stock' THEN
      RAISE EXCEPTION 'Cannot delete: trade-in device has already been resold.';
    END IF;
  END LOOP;

  -- FK-safe deletion order: relationship rows before the rows they
  -- reference. No lucky ordering required.
  FOR ti IN
    SELECT t.id, t.inventory_item_id FROM public.trade_ins t
     WHERE t.sale_id = p_sale_id ORDER BY t.id
  LOOP
    SELECT p.purchase_id INTO v_purchase_id
      FROM public.purchase_items p
     WHERE p.inventory_item_id = ti.inventory_item_id
     ORDER BY p.purchase_id
     LIMIT 1;
    DELETE FROM public.trade_ins WHERE id = ti.id;
    IF v_purchase_id IS NOT NULL THEN
      DELETE FROM public.purchase_items WHERE purchase_id = v_purchase_id;
      DELETE FROM public.purchases WHERE id = v_purchase_id;
    END IF;
    DELETE FROM public.inventory_items WHERE id = ti.inventory_item_id;
  END LOOP;

  UPDATE public.inventory_items SET status = 'in_stock'
   WHERE id IN (SELECT inventory_item_id FROM public.sale_items WHERE sale_id = p_sale_id);

  DELETE FROM public.sale_items WHERE sale_id = p_sale_id;
  DELETE FROM public.sales WHERE id = p_sale_id;

  -- The originating proforma (if any) becomes convertible again: its
  -- sale graph no longer exists, so 'converted' would be a lie.
  IF s.proforma_id IS NOT NULL THEN
    UPDATE public.proforma_invoices
       SET status = 'active'
     WHERE id = s.proforma_id
       AND status = 'converted';
  END IF;
END;
$$;

-- FUNCTION: fy_end_year_2(public.financial_years)
CREATE OR REPLACE FUNCTION public.fy_end_year_2(fy public.financial_years) RETURNS text
    LANGUAGE sql IMMUTABLE
    AS $$
  SELECT lpad((extract(year from fy.end_date)::int % 100)::text, 2, '0')
$$;

-- FUNCTION: fy_start_year_full(public.financial_years)
CREATE OR REPLACE FUNCTION public.fy_start_year_full(fy public.financial_years) RETURNS text
    LANGUAGE sql IMMUTABLE
    AS $$
  SELECT extract(year from fy.start_date)::int::text
$$;

-- FUNCTION: messages_overview()
CREATE OR REPLACE FUNCTION public.messages_overview() RETURNS jsonb
    LANGUAGE sql STABLE
    SET search_path TO 'public'
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

-- FUNCTION: money_text(numeric)
CREATE OR REPLACE FUNCTION public.money_text(n numeric) RETURNS text
    LANGUAGE sql IMMUTABLE
    AS $$
  SELECT to_char(n, 'FM9999999999999990.00')
$$;

-- FUNCTION: pay_purchase(uuid, numeric, date, uuid, uuid)
CREATE OR REPLACE FUNCTION public.pay_purchase(p_purchase_id uuid, p_amount numeric, p_date date, p_bank_account_id uuid, p_payment_mode_id uuid DEFAULT NULL::uuid) RETURNS void
    LANGUAGE plpgsql
    AS $$
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

-- FUNCTION: receive_payment(uuid, numeric, date, uuid, uuid)
CREATE OR REPLACE FUNCTION public.receive_payment(p_sale_id uuid, p_amount numeric, p_date date, p_bank_account_id uuid, p_payment_mode_id uuid DEFAULT NULL::uuid) RETURNS void
    LANGUAGE plpgsql
    AS $$
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

-- FUNCTION: recover_expired_message_jobs()
CREATE OR REPLACE FUNCTION public.recover_expired_message_jobs() RETURNS TABLE(id uuid, status text, attempts integer)
    LANGUAGE sql
    AS $$
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

-- FUNCTION: search_inventory(text, uuid, text, integer, integer, uuid[])
CREATE OR REPLACE FUNCTION public.search_inventory(p_query text, p_financial_year_id uuid, p_status text DEFAULT 'in_stock'::text, p_limit integer DEFAULT 20, p_offset integer DEFAULT 0, p_exclude_ids uuid[] DEFAULT '{}'::uuid[]) RETURNS TABLE(id uuid, brand text, model text, imei text, ram_rom text, color text, purchase_price numeric, base_selling_price numeric, status text, created_at timestamp with time zone, rank integer)
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
  q text := private.search_norm(p_query);
  qdigits text := regexp_replace(coalesce(p_query, ''), '[^0-9]', '', 'g');
  qtokens text[];
  has_tokens boolean;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 200 THEN
    RAISE EXCEPTION 'p_limit must be between 1 and 200';
  END IF;
  IF p_offset IS NULL OR p_offset < 0 THEN
    RAISE EXCEPTION 'p_offset must be >= 0';
  END IF;

  -- Browse mode (empty query): recent-first, scoped, no ranking.
  IF q = '' THEN
    RETURN QUERY
    SELECT i.id, i.brand, i.model, i.imei, i.ram_rom, i.color,
           i.purchase_price, i.base_selling_price, i.status, i.created_at, 0
      FROM public.inventory_items i
     WHERE i.financial_year_id = p_financial_year_id
       AND (p_status IS NULL OR p_status = '' OR p_status = 'all' OR i.status = p_status)
       AND NOT (i.id = ANY(p_exclude_ids))
     ORDER BY i.created_at DESC, i.id
     LIMIT p_limit OFFSET p_offset;
    RETURN;
  END IF;

  qtokens := ARRAY(
    SELECT private.search_norm(t)
      FROM unnest(string_to_array(private.search_tokens(p_query), ' ')) AS t
     WHERE private.search_norm(t) <> ''
  );
  has_tokens := coalesce(array_length(qtokens, 1), 0) > 0;

  RETURN QUERY
  WITH cand AS (
    SELECT i.*,
           CASE
             WHEN length(qdigits) = 15 AND i.imei = qdigits THEN 1000
             WHEN length(qdigits) >= 4 AND i.imei LIKE qdigits || '%' THEN 950
             WHEN i.brand_n = q OR i.model_n = q THEN 900
             WHEN i.brand_n LIKE q || '%' OR i.model_n LIKE q || '%' THEN 800
             WHEN i.search_n LIKE q || '%' THEN 700
             WHEN has_tokens AND (
                    SELECT bool_and(i.tokens_n ~ ('(^| )' || t))
                      FROM unnest(qtokens) AS t
                  ) THEN 600
             WHEN i.search_n LIKE '%' || q || '%' THEN 500
             WHEN has_tokens AND (
                    SELECT bool_and(i.search_n LIKE '%' || t || '%')
                      FROM unnest(qtokens) AS t
                  ) THEN 400
             WHEN greatest(similarity(i.brand_n, q), similarity(i.model_n, q),
                           similarity(i.search_n, q)) >= 0.45 THEN 300
             WHEN greatest(similarity(i.brand_n, q), similarity(i.model_n, q),
                           similarity(i.search_n, q)) >= 0.22 THEN 200
             ELSE 0
           END AS match_rank
      FROM public.inventory_items i
     WHERE i.financial_year_id = p_financial_year_id
       AND (p_status IS NULL OR p_status = '' OR p_status = 'all' OR i.status = p_status)
       AND NOT (i.id = ANY(p_exclude_ids))
  )
  SELECT c.id, c.brand, c.model, c.imei, c.ram_rom, c.color,
         c.purchase_price, c.base_selling_price, c.status, c.created_at, c.match_rank
    FROM cand c
   WHERE c.match_rank > 0
   ORDER BY c.match_rank DESC,
            greatest(similarity(c.brand_n, q), similarity(c.model_n, q),
                     similarity(c.search_n, q)) DESC,
            c.brand, c.model, c.imei
   LIMIT p_limit OFFSET p_offset;
END;
$$;

-- FUNCTION: search_parties(text, integer, integer)
CREATE OR REPLACE FUNCTION public.search_parties(p_query text, p_limit integer DEFAULT 20, p_offset integer DEFAULT 0) RETURNS TABLE(id uuid, name text, number text, address text, rank integer, total_count integer)
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
  q text := private.search_norm(p_query);
  qdigits text := regexp_replace(coalesce(p_query, ''), '[^0-9]', '', 'g');
  qcanon text := private.try_normalize_phone_in(p_query);
  qtokens text[];
  has_tokens boolean;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 200 THEN
    RAISE EXCEPTION 'p_limit must be between 1 and 200';
  END IF;
  IF p_offset IS NULL OR p_offset < 0 THEN
    RAISE EXCEPTION 'p_offset must be >= 0';
  END IF;

  -- Browse mode (empty query): the plain name-ordered directory.
  IF q = '' AND qdigits = '' THEN
    RETURN QUERY
    SELECT p.id, p.name, p.number, p.address, 0,
           (SELECT count(*)::int FROM public.parties)
      FROM public.parties p
     ORDER BY p.name, p.id
     LIMIT p_limit OFFSET p_offset;
    RETURN;
  END IF;

  qtokens := ARRAY(
    SELECT private.search_norm(t)
      FROM unnest(string_to_array(private.search_tokens(p_query), ' ')) AS t
     WHERE private.search_norm(t) <> ''
  );
  has_tokens := coalesce(array_length(qtokens, 1), 0) > 0;

  RETURN QUERY
  WITH cand AS (
    SELECT p.*,
           CASE
             WHEN qcanon IS NOT NULL AND p.number = qcanon THEN 1000
             WHEN p.number = btrim(p_query) THEN 1000
             WHEN p.name_n = q THEN 900
             WHEN p.name_n LIKE q || '%' THEN 800
             WHEN length(qdigits) >= 4 AND p.number LIKE '%' || qdigits || '%' THEN 750
             WHEN p.search_n LIKE q || '%' THEN 700
             WHEN has_tokens AND (
                    SELECT bool_and(p.tokens_n ~ ('(^| )' || t))
                      FROM unnest(qtokens) AS t
                  ) THEN 600
             WHEN p.search_n LIKE '%' || q || '%' THEN 500
             WHEN has_tokens AND (
                    SELECT bool_and(p.search_n LIKE '%' || t || '%')
                      FROM unnest(qtokens) AS t
                  ) THEN 400
             WHEN greatest(similarity(p.name_n, q), similarity(p.search_n, q)) >= 0.45 THEN 300
             WHEN greatest(similarity(p.name_n, q), similarity(p.search_n, q)) >= 0.22 THEN 200
             ELSE 0
           END AS match_rank
      FROM public.parties p
  ), ranked AS (
    SELECT * FROM cand WHERE match_rank > 0
  )
  SELECT r.id, r.name, r.number, r.address, r.match_rank,
         count(*) OVER ()::int          -- total ranked matches (pre-LIMIT)
    FROM ranked r
   ORDER BY r.match_rank DESC,
            greatest(similarity(r.name_n, q), similarity(r.search_n, q)) DESC,
            r.name, r.id
   LIMIT p_limit OFFSET p_offset;
END;
$$;

-- FUNCTION: transfer_funds(uuid, uuid, numeric, date, uuid, text)
CREATE OR REPLACE FUNCTION public.transfer_funds(p_from_bank_account_id uuid, p_to_bank_account_id uuid, p_amount numeric, p_date date, p_financial_year_id uuid, p_notes text DEFAULT NULL::text) RETURNS uuid
    LANGUAGE plpgsql
    AS $$
DECLARE
  fy record;
  transfer_id uuid;
  group_id uuid;
  source_balance numeric;
  trimmed_notes text := NULLIF(btrim(coalesce(p_notes, '')), '');
BEGIN
  IF p_from_bank_account_id = p_to_bank_account_id THEN
    RAISE EXCEPTION 'Source and destination accounts must be different';
  END IF;

  SELECT id, start_date, end_date, status INTO fy
    FROM public.financial_years WHERE id = p_financial_year_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Financial year not found';
  END IF;
  IF fy.status = 'closed' THEN
    RAISE EXCEPTION 'Cannot operate on a closed financial year';
  END IF;
  IF p_date < fy.start_date OR p_date > fy.end_date THEN
    RAISE EXCEPTION 'Date must be within financial year range (% to %)', fy.start_date, fy.end_date;
  END IF;

  IF (SELECT count(*) FROM public.bank_accounts WHERE id IN (p_from_bank_account_id, p_to_bank_account_id)) <> 2 THEN
    RAISE EXCEPTION 'One or both bank accounts not found';
  END IF;

  SELECT sum(CASE WHEN type = 'credit' THEN amount ELSE -amount END) INTO source_balance
    FROM public.account_transactions
   WHERE bank_account_id = p_from_bank_account_id AND financial_year_id = p_financial_year_id;

  IF coalesce(source_balance, 0) < p_amount THEN
    RAISE EXCEPTION 'Insufficient balance. Source account has %s Rs. available.',
      public.money_text(coalesce(source_balance, 0));
  END IF;

  INSERT INTO public.account_transfers (
    from_bank_account_id, to_bank_account_id, amount, date, notes, financial_year_id
  ) VALUES (
    p_from_bank_account_id, p_to_bank_account_id, p_amount, p_date, trimmed_notes, p_financial_year_id
  ) RETURNING id INTO transfer_id;

  group_id := gen_random_uuid();

  INSERT INTO public.account_transactions (
    bank_account_id, payment_mode_id, type, amount, date,
    reference_type, reference_id, financial_year_id, notes, transfer_group_id
  ) VALUES (
    p_from_bank_account_id, NULL, 'debit', p_amount, p_date,
    'transfer', transfer_id, p_financial_year_id, trimmed_notes, group_id
  );

  INSERT INTO public.account_transactions (
    bank_account_id, payment_mode_id, type, amount, date,
    reference_type, reference_id, financial_year_id, notes, transfer_group_id
  ) VALUES (
    p_to_bank_account_id, NULL, 'credit', p_amount, p_date,
    'transfer', transfer_id, p_financial_year_id, trimmed_notes, group_id
  );

  RETURN transfer_id;
END;
$$;

-- FUNCTION: trigger_reminder_now(uuid)
CREATE OR REPLACE FUNCTION public.trigger_reminder_now(p_sale_id uuid) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
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

-- FUNCTION: update_proforma(jsonb)
CREATE OR REPLACE FUNCTION public.update_proforma(payload jsonb) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
  p record;
  fy record;
  v_count integer;
  v_total numeric;
  v_credit numeric := 0;
  v_final numeric;
  ti jsonb;
BEGIN
  SELECT * INTO p FROM public.proforma_invoices
   WHERE id = (payload->>'proforma_id')::uuid FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Proforma not found';
  END IF;
  IF p.status <> 'active' THEN
    RAISE EXCEPTION 'Only an active proforma can be edited (current status: %)', p.status;
  END IF;

  SELECT * INTO fy FROM public.financial_years WHERE id = p.financial_year_id FOR UPDATE;
  IF fy.status <> 'active' THEN
    RAISE EXCEPTION 'Cannot edit a proforma in a closed financial year';
  END IF;

  IF (payload->>'date')::date IS NULL
     OR (payload->>'date')::date < fy.start_date
     OR (payload->>'date')::date > fy.end_date THEN
    RAISE EXCEPTION 'Date must be within the financial year (% to %)', fy.start_date, fy.end_date;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.parties WHERE id = (payload->>'party_id')::uuid) THEN
    RAISE EXCEPTION 'Customer not found';
  END IF;

  IF COALESCE((payload->>'discount')::numeric, 0) < 0 THEN
    RAISE EXCEPTION 'Discount cannot be negative';
  END IF;

  SELECT count(*) INTO v_count
    FROM jsonb_array_elements(payload->'items') AS elem
     WHERE (elem->>'inventory_item_id')::uuid IS NULL
        OR (elem->>'rate')::numeric < 0
        OR NOT EXISTS (
          SELECT 1 FROM public.inventory_items i
           WHERE i.id = (elem->>'inventory_item_id')::uuid
             AND i.status = 'in_stock'
             AND i.financial_year_id = fy.id
        );
  IF v_count > 0 THEN
    RAISE EXCEPTION 'One or more quoted items are no longer available in stock.';
  END IF;

  SELECT count(DISTINCT (elem->>'inventory_item_id')::uuid) INTO v_count
    FROM jsonb_array_elements(payload->'items') AS elem;
  IF v_count <> private.jsonb_array_len(payload->'items') THEN
    RAISE EXCEPTION 'The same device cannot be quoted twice';
  END IF;

  IF private.jsonb_array_len(payload->'items') = 0 THEN
    RAISE EXCEPTION 'A quotation needs at least one item';
  END IF;

  IF private.jsonb_array_len(payload->'trade_ins') > 0 THEN
    FOR ti IN SELECT * FROM jsonb_array_elements(payload->'trade_ins') LOOP
      IF btrim(COALESCE(ti->>'description', '')) = '' THEN
        RAISE EXCEPTION 'Trade-in description is required';
      END IF;
      IF (ti->>'rate')::numeric < 0 THEN
        RAISE EXCEPTION 'Trade-in rate cannot be negative';
      END IF;
      IF ti ? 'qty' AND NULLIF(ti->>'qty', '') IS NOT NULL
         AND (NULLIF(ti->>'qty', ''))::int < 1 THEN
        RAISE EXCEPTION 'Trade-in quantity must be a whole number of at least 1';
      END IF;
    END LOOP;
  END IF;

  DELETE FROM public.proforma_invoice_items WHERE proforma_invoice_id = p.id;
  DELETE FROM public.proforma_trade_ins WHERE proforma_invoice_id = p.id;

  INSERT INTO public.proforma_invoice_items (
    proforma_invoice_id, inventory_item_id, description, qty, rate, discount, value
  )
  SELECT p.id, (elem->>'inventory_item_id')::uuid, NULL, 1,
         (elem->>'rate')::numeric, 0, (elem->>'rate')::numeric
    FROM jsonb_array_elements(payload->'items') AS elem;

  SELECT sum(value) INTO v_total FROM public.proforma_invoice_items
   WHERE proforma_invoice_id = p.id;

  IF private.jsonb_array_len(payload->'trade_ins') > 0 THEN
    INSERT INTO public.proforma_trade_ins (proforma_invoice_id, description, qty, rate, value)
    SELECT p.id, elem->>'description',
           COALESCE(NULLIF(elem->>'qty', '')::int, 1),
           (elem->>'rate')::numeric,
           COALESCE(NULLIF(elem->>'qty', '')::int, 1) * (elem->>'rate')::numeric
      FROM jsonb_array_elements(payload->'trade_ins') AS elem;
    SELECT sum(value) INTO v_credit FROM public.proforma_trade_ins
     WHERE proforma_invoice_id = p.id;
  END IF;

  v_final := GREATEST(0, v_total - COALESCE((payload->>'discount')::numeric, 0) - COALESCE(v_credit, 0));

  UPDATE public.proforma_invoices
     SET party_id = (payload->>'party_id')::uuid,
         date = (payload->>'date')::date,
         discount = COALESCE((payload->>'discount')::numeric, 0),
         total = v_total,
         trade_in_credit = COALESCE(v_credit, 0),
         final_total = v_final
   WHERE id = p.id;
END;
$$;

-- FUNCTION: update_sale(jsonb)
CREATE OR REPLACE FUNCTION public.update_sale(payload jsonb) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
  s record;
  fy record;
  elem jsonb;
  v_total numeric := 0;
  v_final numeric;
  v_due numeric;
  v_count integer;
BEGIN
  SELECT status, financial_year_id, paid, trade_in_credit INTO s
    FROM public.sales WHERE id = (payload->>'sale_id')::uuid FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sale not found';
  END IF;
  IF s.status <> 'active' THEN
    RAISE EXCEPTION 'Only an active sale can be edited';
  END IF;

  SELECT * INTO fy FROM public.financial_years WHERE id = s.financial_year_id;
  IF fy.status <> 'active' THEN
    RAISE EXCEPTION 'Cannot edit a sale in a closed financial year';
  END IF;

  IF (payload->>'date')::date IS NULL
     OR (payload->>'date')::date < fy.start_date
     OR (payload->>'date')::date > fy.end_date THEN
    RAISE EXCEPTION 'Date must be within the financial year (% to %)', fy.start_date, fy.end_date;
  END IF;
  IF COALESCE((payload->>'discount')::numeric, 0) < 0 THEN
    RAISE EXCEPTION 'Discount cannot be negative';
  END IF;

  SELECT count(*) INTO v_count FROM public.sale_items WHERE sale_id = (payload->>'sale_id')::uuid;
  IF private.jsonb_array_len(payload->'items') <> v_count THEN
    RAISE EXCEPTION 'The sale items cannot be added or removed here — every item must be priced';
  END IF;

  FOR elem IN SELECT * FROM jsonb_array_elements(payload->'items') LOOP
    IF NOT EXISTS (SELECT 1 FROM public.sale_items
                    WHERE id = (elem->>'sale_item_id')::uuid
                      AND sale_id = (payload->>'sale_id')::uuid) THEN
      RAISE EXCEPTION 'Sale item % does not belong to this sale', elem->>'sale_item_id';
    END IF;
    IF (elem->>'sold_price')::numeric < 0 THEN
      RAISE EXCEPTION 'Sold price cannot be negative';
    END IF;
    v_total := v_total + (elem->>'sold_price')::numeric;
  END LOOP;

  v_final := GREATEST(0, v_total - COALESCE((payload->>'discount')::numeric, 0) - s.trade_in_credit);
  IF v_final < s.paid THEN
    RAISE EXCEPTION 'New total (%s Rs.) cannot be less than the already-received payment (%s Rs.).',
      public.money_text(v_final), public.money_text(s.paid);
  END IF;
  v_due := GREATEST(0, v_final - s.paid);

  FOR elem IN SELECT * FROM jsonb_array_elements(payload->'items') LOOP
    UPDATE public.sale_items SET sold_price = (elem->>'sold_price')::numeric
     WHERE id = (elem->>'sale_item_id')::uuid;
  END LOOP;

  UPDATE public.sales
     SET date = (payload->>'date')::date,
         discount = COALESCE((payload->>'discount')::numeric, 0),
         total = v_total,
         final_total = v_final,
         due = v_due
   WHERE id = (payload->>'sale_id')::uuid;
END;
$$;

-- FUNCTION: upsert_reminder_config(uuid, boolean, integer, integer)
CREATE OR REPLACE FUNCTION public.upsert_reminder_config(p_sale_id uuid, p_enabled boolean, p_frequency_days integer, p_max_reminders integer) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
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

-- FUNCTION: void_proforma(uuid)
CREATE OR REPLACE FUNCTION public.void_proforma(p_proforma_id uuid) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
  p record;
BEGIN
  SELECT status, financial_year_id INTO p
    FROM public.proforma_invoices WHERE id = p_proforma_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Proforma not found';
  END IF;
  IF p.status <> 'active' THEN
    RAISE EXCEPTION 'Only an active proforma can be voided (current status: %)', p.status;
  END IF;
  IF (SELECT status FROM public.financial_years WHERE id = p.financial_year_id) <> 'active' THEN
    RAISE EXCEPTION 'Cannot void a proforma in a closed financial year';
  END IF;

  UPDATE public.proforma_invoices SET status = 'void' WHERE id = p_proforma_id;
END;
$$;
