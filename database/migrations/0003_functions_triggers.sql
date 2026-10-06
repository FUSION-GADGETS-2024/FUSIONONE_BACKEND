-- ============================================================
-- FUSIONONE — 0003 Functions and triggers
-- ============================================================
-- Private authorization helpers (SECURITY DEFINER, hardened) + the
-- auth-user provisioning trigger, the display-name trim trigger, and
-- the public business RPC functions (SECURITY INVOKER — every RPC runs
-- under the caller's JWT and RLS; the policies in 0004 are the data
-- boundary).
--
-- Hardening rules applied (mirroring the live TEST architecture):
--   * SECURITY DEFINER functions live in the non-exposed `private`
--     schema, have an explicit empty search_path, and are NOT
--     executable by anon/PUBLIC.
--   * The authorization helpers read auth.users live — Supabase Auth
--     stays the single source of truth for email verification.
--   * Business math stays in the client; these RPCs enforce structure
--     (stock, IMEI uniqueness, atomic counters, multi-table atomicity).

-- ─── Private schema (not exposed through PostgREST) ────────────────────────

CREATE SCHEMA IF NOT EXISTS private;

-- ─── Authorization helpers ─────────────────────────────────────────────────
-- can_access_app: verified (auth.users.email_confirmed_at) + ACTIVE +
--   provisioned (owner | user) + a NORMAL application authentication
--   context (JWT amr[0].method = 'password' — an invitation/recovery
--   email-link session, amr 'otp', must never touch business data).
--   Anything else — NULL role, blocked, unverified, otp context,
--   missing claims — fails closed.
-- is_owner: the same, plus user_type = 'owner'.

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

REVOKE EXECUTE ON FUNCTION private.can_access_app() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION private.is_owner() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.can_access_app() TO authenticated;
GRANT EXECUTE ON FUNCTION private.is_owner() TO authenticated;

-- ─── Auth-user auto-provisioning ───────────────────────────────────────────
-- Every new auth.users row gets a public.users row with user_type = NULL
-- (fail-closed default). Only the trusted server-side invitation path
-- (backend, secret key) may later set 'user' — never 'owner' through
-- the browser.

CREATE OR REPLACE FUNCTION private.handle_new_auth_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.users (id, user_type)
  VALUES (NEW.id, NULL)
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION private.handle_new_auth_user() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION private.handle_new_auth_user();

-- ─── display_name trim normalization ───────────────────────────────────────
-- Whatever writes the column, the stored value is always trimmed.
-- btrim(NULL) is NULL, so unset profiles stay NULL.

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

-- ─── Shared SQL helpers ────────────────────────────────────────────────────

/** Full start year of an FY, e.g. '2026'. */
CREATE OR REPLACE FUNCTION public.fy_start_year_full(fy public.financial_years)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT extract(year from fy.start_date)::int::text
$$;

/** Last two digits of the FY end year, e.g. '27'. */
CREATE OR REPLACE FUNCTION public.fy_end_year_2(fy public.financial_years)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT lpad((extract(year from fy.end_date)::int % 100)::text, 2, '0')
$$;

/** JS `(n).toFixed(2)`-equivalent formatting for error messages. */
CREATE OR REPLACE FUNCTION public.money_text(n numeric)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT to_char(n, 'FM9999999999999990.00')
$$;

-- ─── Bill-number allocation (atomic) ───────────────────────────────────────

/**
 * Atomically allocate the next bill numbers for a financial year.
 * Locks the FY row, computes the next numbers from the CURRENT counters,
 * and increments the counters in the same statement.
 */
CREATE OR REPLACE FUNCTION public.allocate_bill_numbers(
  p_fy_id uuid,
  p_sales integer DEFAULT 1,
  p_purchases integer DEFAULT 0,
  p_proformas integer DEFAULT 0
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  fy public.financial_years;
  sy text;
  ey text;
  next_sale integer;
  next_pur integer;
  next_pro integer;
BEGIN
  SELECT * INTO fy FROM public.financial_years WHERE id = p_fy_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Financial year not found';
  END IF;

  sy := public.fy_start_year_full(fy);
  ey := public.fy_end_year_2(fy);

  next_sale := fy.sale_counter + 1;
  next_pur  := fy.purchase_counter + 1;
  next_pro  := fy.proforma_counter + 1;

  UPDATE public.financial_years
     SET sale_counter = fy.sale_counter + p_sales,
         purchase_counter = fy.purchase_counter + p_purchases,
         proforma_counter = fy.proforma_counter + p_proformas
   WHERE id = p_fy_id;

  RETURN jsonb_build_object(
    'sale_bill', 'SAL-' || sy || '-' || ey || '-' || lpad(next_sale::text, 4, '0'),
    'purchase_bill', 'PUR-' || sy || '-' || ey || '-' || lpad(next_pur::text, 4, '0'),
    'proforma_bill', 'PI-' || sy || '-' || ey || '-' || lpad(next_pro::text, 4, '0'),
    'sale_no', next_sale,
    'purchase_no', next_pur,
    'proforma_no', next_pro
  );
END;
$$;

-- ─── CREATE SALE (transactional) ───────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.create_sale(payload jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  fy public.financial_years;
  sy text;
  ey text;
  item jsonb;
  ti jsonb;
  item_ids uuid[];
  in_stock_count integer;
  dup_imei text;
  sale_id uuid;
  bill_no text;
  pur_bill text;
  purchase_id uuid;
  inv_id uuid;
  n_trade_ins integer;
  i integer;
BEGIN
  SELECT * INTO fy FROM public.financial_years WHERE id = (payload->>'financial_year_id')::uuid FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Financial year not found';
  END IF;

  -- 1. Verify all selected items are still in stock.
  SELECT array_agg((elem->>'inventory_item_id')::uuid) INTO item_ids
    FROM jsonb_array_elements(payload->'items') AS elem;
  IF item_ids IS NULL THEN
    RAISE EXCEPTION 'One or more selected items are no longer available in stock.';
  END IF;

  SELECT count(*) INTO in_stock_count
    FROM public.inventory_items
   WHERE id = ANY(item_ids) AND status = 'in_stock';
  IF in_stock_count <> jsonb_array_length(payload->'items') THEN
    RAISE EXCEPTION 'One or more selected items are no longer available in stock.';
  END IF;

  -- 2. Verify trade-in IMEIs are not globally in stock.
  IF jsonb_array_length(payload->'trade_ins') > 0 THEN
    SELECT imei INTO dup_imei
      FROM public.inventory_items
     WHERE imei IN (SELECT elem->>'imei' FROM jsonb_array_elements(payload->'trade_ins') AS elem)
       AND status = 'in_stock'
     LIMIT 1;
    IF dup_imei IS NOT NULL THEN
      RAISE EXCEPTION 'Trade-In IMEI % already in stock in the system.', dup_imei;
    END IF;
  END IF;

  -- 3. Bill number + counters (atomic; format SAL-2026-27-0001).
  sy := public.fy_start_year_full(fy);
  ey := public.fy_end_year_2(fy);
  bill_no := 'SAL-' || sy || '-' || ey || '-' || lpad((fy.sale_counter + 1)::text, 4, '0');
  n_trade_ins := jsonb_array_length(payload->'trade_ins');

  UPDATE public.financial_years
     SET sale_counter = fy.sale_counter + 1,
         purchase_counter = fy.purchase_counter + n_trade_ins
   WHERE id = fy.id;

  -- 4. Sale record.
  INSERT INTO public.sales (
    bill_number, party_id, total, discount, trade_in_credit, final_total,
    paid, due, bank_account_id, payment_mode_id, date, financial_year_id, status
  ) VALUES (
    bill_no,
    (payload->>'party_id')::uuid,
    (payload->>'total')::numeric,
    (payload->>'discount')::numeric,
    (payload->>'trade_in_credit')::numeric,
    (payload->>'final_total')::numeric,
    (payload->>'paid')::numeric,
    (payload->>'due')::numeric,
    (payload->>'bank_account_id')::uuid,
    NULLIF(payload->>'payment_mode_id', '')::uuid,
    (payload->>'date')::date,
    fy.id,
    'active'
  ) RETURNING id INTO sale_id;

  -- 5. Sale items.
  INSERT INTO public.sale_items (sale_id, inventory_item_id, sold_price)
  SELECT sale_id,
         (elem->>'inventory_item_id')::uuid,
         (elem->>'sold_price')::numeric
    FROM jsonb_array_elements(payload->'items') AS elem;

  -- 6. Mark sold.
  UPDATE public.inventory_items SET status = 'sold' WHERE id = ANY(item_ids);

  -- 7. Trade-ins: hidden purchase + new inventory + link.
  FOR i IN 0 .. (n_trade_ins - 1) LOOP
    ti := payload->'trade_ins'->i;
    -- Trade-in purchase numbers continue from the PRE-update counter.
    pur_bill := 'PUR-TRD-' || sy || '-' || ey || '-' ||
                lpad((fy.purchase_counter + 1 + i)::text, 4, '0');

    INSERT INTO public.purchases (
      bill_number, party_id, total, paid, due, bank_account_id,
      date, financial_year_id, status
    ) VALUES (
      pur_bill,
      (payload->>'party_id')::uuid,
      (ti->>'credit_value')::numeric,
      (ti->>'credit_value')::numeric,
      0,
      (payload->>'bank_account_id')::uuid,
      (payload->>'date')::date,
      fy.id,
      'active'
    ) RETURNING id INTO purchase_id;

    INSERT INTO public.inventory_items (
      brand, model, imei, ram_rom, color, purchase_price, base_selling_price,
      status, source, financial_year_id, opening_entry_type
    ) VALUES (
      ti->>'brand', ti->>'model', ti->>'imei', ti->>'ram_rom', ti->>'color',
      (ti->>'credit_value')::numeric, (ti->>'credit_value')::numeric,
      'in_stock', 'trade_in', fy.id, 'direct'
    ) RETURNING id INTO inv_id;

    INSERT INTO public.purchase_items (purchase_id, inventory_item_id) VALUES (purchase_id, inv_id);

    INSERT INTO public.trade_ins (
      sale_id, brand, model, imei, ram_rom, color, credit_value, mrp,
      document_url, new_inventory_item_id
    ) VALUES (
      sale_id, ti->>'brand', ti->>'model', ti->>'imei', ti->>'ram_rom', ti->>'color',
      (ti->>'credit_value')::numeric,
      (ti->>'mrp')::numeric,
      NULLIF(ti->>'document_url', '')::text,
      inv_id
    );
  END LOOP;

  -- 8. Payment: account transaction + payments_in (only when paid > 0).
  IF (payload->>'paid')::numeric > 0 THEN
    INSERT INTO public.account_transactions (
      bank_account_id, payment_mode_id, type, amount, date,
      reference_type, reference_id, financial_year_id
    ) VALUES (
      (payload->>'bank_account_id')::uuid,
      NULLIF(payload->>'payment_mode_id', '')::uuid,
      'credit',
      (payload->>'paid')::numeric,
      (payload->>'date')::date,
      'sale',
      sale_id,
      fy.id
    );

    INSERT INTO public.payments_in (
      sale_id, party_id, amount, bank_account_id, payment_mode_id, date, financial_year_id
    ) VALUES (
      sale_id,
      (payload->>'party_id')::uuid,
      (payload->>'paid')::numeric,
      (payload->>'bank_account_id')::uuid,
      NULLIF(payload->>'payment_mode_id', '')::uuid,
      (payload->>'date')::date,
      fy.id
    );
  END IF;

  RETURN jsonb_build_object('sale_id', sale_id, 'bill_number', bill_no);
END;
$$;

-- ─── RECEIVE PAYMENT (sales list modal) ────────────────────────────────────

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
END;
$$;

-- ─── CANCEL SALE (incl. resold trade-in handling) ──────────────────────────

CREATE OR REPLACE FUNCTION public.cancel_sale(p_sale_id uuid)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  s record;
  ti record;
  purchase_id uuid;
  device_status text;
  resold jsonb := '[]'::jsonb;
  today date := current_date;
  pi_row record;
BEGIN
  SELECT financial_year_id INTO s FROM public.sales WHERE id = p_sale_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sale not found';
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
  FOR ti IN
    SELECT t.id, t.new_inventory_item_id, t.brand, t.model, t.imei, t.ram_rom,
           t.color, t.credit_value, t.mrp, t.document_url,
           (SELECT status FROM public.inventory_items WHERE id = t.new_inventory_item_id) AS item_status
      FROM public.trade_ins t
     WHERE t.sale_id = p_sale_id
     ORDER BY t.id
  LOOP
    SELECT p.purchase_id INTO purchase_id
      FROM public.purchase_items p
     WHERE p.inventory_item_id = ti.new_inventory_item_id
     LIMIT 1;

    IF ti.item_status = 'in_stock' THEN
      IF purchase_id IS NOT NULL THEN
        DELETE FROM public.purchase_items WHERE purchase_id = purchase_id;
        DELETE FROM public.purchases WHERE id = purchase_id;
      END IF;
      DELETE FROM public.inventory_items WHERE id = ti.new_inventory_item_id;
    ELSE
      IF purchase_id IS NOT NULL THEN
        UPDATE public.purchases SET status = 'cancelled' WHERE id = purchase_id;
      END IF;
      resold := resold || jsonb_build_object(
        'id', ti.id,
        'sale_id', p_sale_id,
        'brand', ti.brand,
        'model', ti.model,
        'imei', ti.imei,
        'ram_rom', ti.ram_rom,
        'color', ti.color,
        'credit_value', ti.credit_value,
        'mrp', ti.mrp,
        'document_url', ti.document_url,
        'new_inventory_item_id', ti.new_inventory_item_id,
        'purchase_id', purchase_id,
        'status', ti.item_status
      );
    END IF;
  END LOOP;

  RETURN jsonb_build_object('resold', resold);
END;
$$;

-- ─── DELETE SALE (guarded hard delete) ─────────────────────────────────────

CREATE OR REPLACE FUNCTION public.delete_sale(p_sale_id uuid)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  s record;
  ti record;
  purchase_id uuid;
BEGIN
  SELECT paid INTO s FROM public.sales WHERE id = p_sale_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sale not found';
  END IF;
  IF s.paid > 0 THEN
    RAISE EXCEPTION 'Cannot delete: payment has already been received.';
  END IF;

  FOR ti IN
    SELECT t.id, t.new_inventory_item_id,
           (SELECT status FROM public.inventory_items WHERE id = t.new_inventory_item_id) AS item_status
      FROM public.trade_ins t
     WHERE t.sale_id = p_sale_id
     ORDER BY t.id
  LOOP
    IF ti.item_status IS DISTINCT FROM 'in_stock' THEN
      RAISE EXCEPTION 'Cannot delete: trade-in device has already been resold.';
    END IF;
  END LOOP;

  FOR ti IN
    SELECT t.id, t.new_inventory_item_id FROM public.trade_ins t WHERE t.sale_id = p_sale_id ORDER BY t.id
  LOOP
    SELECT p.purchase_id INTO purchase_id
      FROM public.purchase_items p
     WHERE p.inventory_item_id = ti.new_inventory_item_id
     LIMIT 1;
    IF purchase_id IS NOT NULL THEN
      DELETE FROM public.purchase_items WHERE purchase_id = purchase_id;
      DELETE FROM public.purchases WHERE id = purchase_id;
    END IF;
    DELETE FROM public.inventory_items WHERE id = ti.new_inventory_item_id;
    DELETE FROM public.trade_ins WHERE id = ti.id;
  END LOOP;

  UPDATE public.inventory_items SET status = 'in_stock'
   WHERE id IN (SELECT inventory_item_id FROM public.sale_items WHERE sale_id = p_sale_id);

  DELETE FROM public.sale_items WHERE sale_id = p_sale_id;
  DELETE FROM public.sales WHERE id = p_sale_id;
END;
$$;

-- ─── CREATE PURCHASE (transactional) ───────────────────────────────────────

CREATE OR REPLACE FUNCTION public.create_purchase(payload jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  fy public.financial_years;
  sy text;
  ey text;
  dup_imei text;
  purchase_id uuid;
  bill_no text;
  added_ids uuid[];
BEGIN
  SELECT * INTO fy FROM public.financial_years WHERE id = (payload->>'financial_year_id')::uuid FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Financial year not found';
  END IF;

  -- 1. Duplicate IMEI check vs in-stock.
  SELECT imei INTO dup_imei
    FROM public.inventory_items
   WHERE imei IN (SELECT elem->>'imei' FROM jsonb_array_elements(payload->'items') AS elem)
     AND status = 'in_stock'
   LIMIT 1;
  IF dup_imei IS NOT NULL THEN
    RAISE EXCEPTION 'IMEI % is already in stock in the database.', dup_imei;
  END IF;

  -- 2. Bill number + counter (format PUR-2026-27-0001).
  sy := public.fy_start_year_full(fy);
  ey := public.fy_end_year_2(fy);
  bill_no := 'PUR-' || sy || '-' || ey || '-' || lpad((fy.purchase_counter + 1)::text, 4, '0');

  UPDATE public.financial_years SET purchase_counter = fy.purchase_counter + 1 WHERE id = fy.id;

  -- 3. Purchase record.
  INSERT INTO public.purchases (
    bill_number, party_id, total, paid, due, bank_account_id, payment_mode_id,
    date, financial_year_id, status
  ) VALUES (
    bill_no,
    (payload->>'party_id')::uuid,
    (payload->>'total')::numeric,
    (payload->>'paid')::numeric,
    (payload->>'due')::numeric,
    (payload->>'bank_account_id')::uuid,
    NULLIF(payload->>'payment_mode_id', '')::uuid,
    (payload->>'date')::date,
    fy.id,
    'active'
  ) RETURNING id INTO purchase_id;

  -- 4. Inventory items (source purchase, opening entry direct).
  WITH ins AS (
    INSERT INTO public.inventory_items (
      brand, model, imei, ram_rom, color, purchase_price, base_selling_price,
      status, source, financial_year_id, opening_entry_type
    )
    SELECT elem->>'brand', elem->>'model', elem->>'imei', elem->>'ram_rom', elem->>'color',
           (elem->>'purchase_price')::numeric, (elem->>'base_selling_price')::numeric,
           'in_stock', 'purchase', fy.id, 'direct'
      FROM jsonb_array_elements(payload->'items') AS elem
    RETURNING id
  )
  SELECT array_agg(id) INTO added_ids FROM ins;

  -- 5. Purchase items mapping.
  INSERT INTO public.purchase_items (purchase_id, inventory_item_id)
  SELECT purchase_id, unnest(added_ids);

  -- 6. Payment: debit transaction + payments_out (only when paid > 0).
  IF (payload->>'paid')::numeric > 0 THEN
    INSERT INTO public.account_transactions (
      bank_account_id, payment_mode_id, type, amount, date,
      reference_type, reference_id, financial_year_id
    ) VALUES (
      (payload->>'bank_account_id')::uuid,
      NULLIF(payload->>'payment_mode_id', '')::uuid,
      'debit',
      (payload->>'paid')::numeric,
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
      (payload->>'paid')::numeric,
      (payload->>'bank_account_id')::uuid,
      NULLIF(payload->>'payment_mode_id', '')::uuid,
      (payload->>'date')::date,
      fy.id
    );
  END IF;

  RETURN jsonb_build_object('purchase_id', purchase_id, 'bill_number', bill_no);
END;
$$;

-- ─── PAY PURCHASE ──────────────────────────────────────────────────────────

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
END;
$$;

-- ─── CREATE PURCHASE BILL FOR RESOLD TRADE-IN (recovery flow) ──────────────
-- Reference quirk preserved: this bill format uses TWO-DIGIT start years
-- (PUR-26-27-0001), unlike regular purchases (PUR-2026-27-0001).

CREATE OR REPLACE FUNCTION public.create_trade_in_purchase_bill(
  p_sale_id uuid,
  p_trade_in_id uuid
) RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  s record;
  ti record;
  fy public.financial_years;
  counter integer;
  sy text;
  ey text;
  bill_no text;
  purchase_id uuid;
BEGIN
  SELECT party_id, bank_account_id, financial_year_id INTO s FROM public.sales WHERE id = p_sale_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sale not found';
  END IF;

  SELECT credit_value, new_inventory_item_id INTO ti FROM public.trade_ins WHERE id = p_trade_in_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Trade-in not found';
  END IF;

  SELECT * INTO fy FROM public.financial_years WHERE id = s.financial_year_id FOR UPDATE;

  counter := fy.purchase_counter + 1;
  sy := lpad((extract(year from fy.start_date)::int % 100)::text, 2, '0');
  ey := public.fy_end_year_2(fy);
  bill_no := 'PUR-' || sy || '-' || ey || '-' || lpad(counter::text, 4, '0');

  INSERT INTO public.purchases (
    bill_number, party_id, total, paid, due, bank_account_id,
    date, financial_year_id, status
  ) VALUES (
    bill_no, s.party_id, ti.credit_value, ti.credit_value, 0, s.bank_account_id,
    current_date, fy.id, 'active'
  ) RETURNING id INTO purchase_id;

  INSERT INTO public.purchase_items (purchase_id, inventory_item_id)
  VALUES (purchase_id, ti.new_inventory_item_id);

  UPDATE public.financial_years SET purchase_counter = counter WHERE id = fy.id;

  RETURN bill_no;
END;
$$;

-- ─── UPDATE SALE (edit page: per-item prices + header) ─────────────────────

CREATE OR REPLACE FUNCTION public.update_sale(payload jsonb)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  s record;
  elem jsonb;
BEGIN
  SELECT paid INTO s FROM public.sales WHERE id = (payload->>'sale_id')::uuid FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sale not found';
  END IF;

  IF (payload->>'final_total')::numeric < s.paid THEN
    RAISE EXCEPTION 'New total (%s Rs.) cannot be less than the already-received payment (%s Rs.).',
      public.money_text((payload->>'final_total')::numeric), public.money_text(s.paid);
  END IF;

  FOR elem IN SELECT * FROM jsonb_array_elements(payload->'items') LOOP
    UPDATE public.sale_items SET sold_price = (elem->>'sold_price')::numeric
     WHERE id = (elem->>'sale_item_id')::uuid;
  END LOOP;

  UPDATE public.sales
     SET date = (payload->>'date')::date,
         discount = (payload->>'discount')::numeric,
         total = (payload->>'total')::numeric,
         final_total = (payload->>'final_total')::numeric,
         due = (payload->>'due')::numeric
   WHERE id = (payload->>'sale_id')::uuid;
END;
$$;

-- ─── CREATE PROFORMA (transactional) ───────────────────────────────────────

CREATE OR REPLACE FUNCTION public.create_proforma(payload jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  fy public.financial_years;
  sy text;
  ey text;
  bill_no text;
  proforma_id uuid;
BEGIN
  SELECT * INTO fy FROM public.financial_years WHERE id = (payload->>'financial_year_id')::uuid FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Financial year not found';
  END IF;

  -- Bill number (format PI-2026-27-0001).
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
    (payload->>'total')::numeric,
    (payload->>'discount')::numeric,
    (payload->>'trade_in_credit')::numeric,
    (payload->>'final_total')::numeric,
    (payload->>'date')::date,
    fy.id,
    'active'
  ) RETURNING id INTO proforma_id;

  INSERT INTO public.proforma_invoice_items (proforma_invoice_id, description, qty, rate, discount, value)
  SELECT proforma_id, elem->>'description',
         (elem->>'qty')::int, (elem->>'rate')::numeric,
         (elem->>'discount')::numeric, (elem->>'value')::numeric
    FROM jsonb_array_elements(payload->'items') AS elem;

  IF payload ? 'trade_ins' AND jsonb_array_length(payload->'trade_ins') > 0 THEN
    INSERT INTO public.proforma_trade_ins (proforma_invoice_id, description, qty, rate, value)
    SELECT proforma_id, elem->>'description',
           (elem->>'qty')::int, (elem->>'rate')::numeric, (elem->>'value')::numeric
      FROM jsonb_array_elements(payload->'trade_ins') AS elem
     WHERE elem->>'description' <> '';
  END IF;

  RETURN jsonb_build_object('proforma_id', proforma_id, 'bill_number', bill_no);
END;
$$;

-- ─── CLOSE FINANCIAL YEAR (copy-based carry-forward) ───────────────────────

CREATE OR REPLACE FUNCTION public.close_financial_year(p_fy_id uuid)
RETURNS jsonb LANGUAGE plpgsql AS $$
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

-- ─── ADD FUNDS ─────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.add_funds(
  p_bank_account_id uuid,
  p_amount numeric,
  p_date date,
  p_financial_year_id uuid,
  p_notes text DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql AS $$
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

-- ─── TRANSFER FUNDS ────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.transfer_funds(
  p_from_bank_account_id uuid,
  p_to_bank_account_id uuid,
  p_amount numeric,
  p_date date,
  p_financial_year_id uuid,
  p_notes text DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql AS $$
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

-- ─── Transactional store setup (owner-only onboarding) ─────────────────────
-- SECURITY INVOKER: runs under the caller's identity and RLS (the store
-- INSERT/UPDATE policies are owner-only; business tables require an
-- authorized app user). An explicit owner guard produces a clean error
-- before any write. The singleton constraint is the hard second-store
-- guarantee.

CREATE OR REPLACE FUNCTION public.complete_store_setup(payload jsonb)
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
GRANT EXECUTE ON FUNCTION public.complete_store_setup(jsonb) TO authenticated, service_role;
