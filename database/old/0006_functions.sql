-- ============================================================
-- FUSIONONE — TEST database rebuild — 0006 Business RPC functions
-- ============================================================
-- Transactional implementations of the multi-table business operations that
-- the Next.js reference app performed as sequential browser REST calls
-- (audit §12: create sale = up to 10 tables, cancel, FY close, transfers).
--
-- DESIGN RULES (per the rebuild spec):
--   * Each RPC reproduces the reference app's EXACT write sequence, bill
--     number formats, and user-facing error message texts.
--   * Business math (totals/discounts) stays in the client exactly as
--     today — the DB enforces structure (stock, IMEI uniqueness, counters,
--     atomicity), not arithmetic.
--   * Counter allocation is atomic (SELECT ... FOR UPDATE) — eliminates the
--     read→update race the audit documented in 4 places (D10).
--   * SECURITY INVOKER (default): every RPC runs under the caller's JWT and
--     RLS. No security definer, no service role.
-- ============================================================

-- ─── Shared helpers ────────────────────────────────────────────────────────

/** Full start year of an FY, e.g. '2026'. */
CREATE OR REPLACE FUNCTION fy_start_year_full(fy financial_years)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT extract(year from fy.start_date)::int::text
$$;

/** Last two digits of the FY end year, e.g. '27'. */
CREATE OR REPLACE FUNCTION fy_end_year_2(fy financial_years)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT lpad((extract(year from fy.end_date)::int % 100)::text, 2, '0')
$$;

/** JS `(n).toFixed(2)`-equivalent formatting for error messages. */
CREATE OR REPLACE FUNCTION money_text(n numeric)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT to_char(n, 'FM9999999999999990.00')
$$;

-- ─── Bill-number allocation (atomic) ───────────────────────────────────────

/**
 * Atomically allocate the next bill numbers for a financial year.
 * Locks the FY row, computes the next numbers from the CURRENT counters,
 * and increments the counters in the same statement.
 *
 * Returns: { sale_bill, purchase_bill, proforma_bill, sale_no, purchase_no, proforma_no }
 * (the *_bill strings use the reference formats; *_no are the raw next values).
 */
CREATE OR REPLACE FUNCTION allocate_bill_numbers(
  p_fy_id uuid,
  p_sales integer DEFAULT 1,
  p_purchases integer DEFAULT 0,
  p_proformas integer DEFAULT 0
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  fy financial_years;
  sy text;
  ey text;
  next_sale integer;
  next_pur integer;
  next_pro integer;
BEGIN
  SELECT * INTO fy FROM financial_years WHERE id = p_fy_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Financial year not found';
  END IF;

  sy := fy_start_year_full(fy);
  ey := fy_end_year_2(fy);

  next_sale := fy.sale_counter + 1;
  next_pur  := fy.purchase_counter + 1;
  next_pro  := fy.proforma_counter + 1;

  UPDATE financial_years
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

-- ─── CREATE SALE (transactional; reference: domains/sales/mutations.ts) ────

CREATE OR REPLACE FUNCTION create_sale(payload jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  fy financial_years;
  sy text;
  ey text;
  item jsonb;
  ti jsonb;
  item_ids uuid[];
  in_stock_count integer;
  dup_imei text;
  dup record;
  sale_id uuid;
  bill_no text;
  pur_bill text;
  purchase_id uuid;
  inv_id uuid;
  n_trade_ins integer;
  i integer;
BEGIN
  SELECT * INTO fy FROM financial_years WHERE id = (payload->>'financial_year_id')::uuid FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Financial year not found';
  END IF;

  -- 1. Verify all selected items are still in stock (message parity).
  SELECT array_agg((elem->>'inventory_item_id')::uuid) INTO item_ids
    FROM jsonb_array_elements(payload->'items') AS elem;
  IF item_ids IS NULL THEN
    RAISE EXCEPTION 'One or more selected items are no longer available in stock.';
  END IF;

  SELECT count(*) INTO in_stock_count
    FROM inventory_items
   WHERE id = ANY(item_ids) AND status = 'in_stock';
  IF in_stock_count <> jsonb_array_length(payload->'items') THEN
    RAISE EXCEPTION 'One or more selected items are no longer available in stock.';
  END IF;

  -- 2. Verify trade-in IMEIs are not globally in stock (message parity).
  IF jsonb_array_length(payload->'trade_ins') > 0 THEN
    SELECT imei INTO dup_imei
      FROM inventory_items
     WHERE imei IN (SELECT elem->>'imei' FROM jsonb_array_elements(payload->'trade_ins') AS elem)
       AND status = 'in_stock'
     LIMIT 1;
    IF dup_imei IS NOT NULL THEN
      RAISE EXCEPTION 'Trade-In IMEI % already in stock in the system.', dup_imei;
    END IF;
  END IF;

  -- 3. Bill number + counters (atomic; reference format SAL-2026-27-0001).
  sy := fy_start_year_full(fy);
  ey := fy_end_year_2(fy);
  bill_no := 'SAL-' || sy || '-' || ey || '-' || lpad((fy.sale_counter + 1)::text, 4, '0');
  n_trade_ins := jsonb_array_length(payload->'trade_ins');

  UPDATE financial_years
     SET sale_counter = fy.sale_counter + 1,
         purchase_counter = fy.purchase_counter + n_trade_ins
   WHERE id = fy.id;

  -- 4. Sale record.
  INSERT INTO sales (
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
  INSERT INTO sale_items (sale_id, inventory_item_id, sold_price)
  SELECT sale_id,
         (elem->>'inventory_item_id')::uuid,
         (elem->>'sold_price')::numeric
    FROM jsonb_array_elements(payload->'items') AS elem;

  -- 6. Mark sold.
  UPDATE inventory_items SET status = 'sold' WHERE id = ANY(item_ids);

  -- 7. Trade-ins: hidden purchase + new inventory + link (reference loop).
  FOR i IN 0 .. (n_trade_ins - 1) LOOP
    ti := payload->'trade_ins'->i;
    -- Trade-in purchase numbers continue from the PRE-update counter.
    pur_bill := 'PUR-TRD-' || sy || '-' || ey || '-' ||
                lpad((fy.purchase_counter + 1 + i)::text, 4, '0');

    INSERT INTO purchases (
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

    INSERT INTO inventory_items (
      brand, model, imei, ram_rom, color, purchase_price, base_selling_price,
      status, source, financial_year_id, opening_entry_type
    ) VALUES (
      ti->>'brand', ti->>'model', ti->>'imei', ti->>'ram_rom', ti->>'color',
      (ti->>'credit_value')::numeric, (ti->>'credit_value')::numeric,
      'in_stock', 'trade_in', fy.id, 'direct'
    ) RETURNING id INTO inv_id;

    INSERT INTO purchase_items (purchase_id, inventory_item_id) VALUES (purchase_id, inv_id);

    INSERT INTO trade_ins (
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
    INSERT INTO account_transactions (
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

    INSERT INTO payments_in (
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

CREATE OR REPLACE FUNCTION receive_payment(
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
    FROM sales WHERE id = p_sale_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sale not found';
  END IF;
  IF p_amount > s.due THEN
    RAISE EXCEPTION 'Cannot exceed due amount';
  END IF;

  UPDATE sales SET paid = s.paid + p_amount, due = s.due - p_amount
   WHERE id = p_sale_id;

  INSERT INTO payments_in (
    sale_id, party_id, amount, bank_account_id, payment_mode_id, date, financial_year_id
  ) VALUES (
    p_sale_id, s.party_id, p_amount, p_bank_account_id, p_payment_mode_id, p_date, s.financial_year_id
  ) RETURNING id INTO pi_id;

  INSERT INTO account_transactions (
    bank_account_id, payment_mode_id, type, amount, date,
    reference_type, reference_id, financial_year_id
  ) VALUES (
    p_bank_account_id, p_payment_mode_id, 'credit', p_amount, p_date,
    'payment_in', pi_id, s.financial_year_id
  );
END;
$$;

-- ─── CANCEL SALE (page semantics, incl. resold handling) ───────────────────

CREATE OR REPLACE FUNCTION cancel_sale(p_sale_id uuid)
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
  SELECT financial_year_id INTO s FROM sales WHERE id = p_sale_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sale not found';
  END IF;

  -- 1. Mark cancelled.
  UPDATE sales SET status = 'cancelled' WHERE id = p_sale_id;

  -- 2. Return sold inventory to stock.
  UPDATE inventory_items SET status = 'in_stock'
   WHERE id IN (SELECT inventory_item_id FROM sale_items WHERE sale_id = p_sale_id);

  -- 3. Reverse payment_in entries (debit, dated today, reference the sale).
  FOR pi_row IN
    SELECT amount, bank_account_id FROM payments_in WHERE sale_id = p_sale_id
  LOOP
    INSERT INTO account_transactions (
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
           (SELECT status FROM inventory_items WHERE id = t.new_inventory_item_id) AS item_status
      FROM trade_ins t
     WHERE t.sale_id = p_sale_id
     ORDER BY t.id
  LOOP
    SELECT p.purchase_id INTO purchase_id
      FROM purchase_items p
     WHERE p.inventory_item_id = ti.new_inventory_item_id
     LIMIT 1;

    IF ti.item_status = 'in_stock' THEN
      IF purchase_id IS NOT NULL THEN
        DELETE FROM purchase_items WHERE purchase_id = purchase_id;
        DELETE FROM purchases WHERE id = purchase_id;
      END IF;
      DELETE FROM inventory_items WHERE id = ti.new_inventory_item_id;
    ELSE
      IF purchase_id IS NOT NULL THEN
        UPDATE purchases SET status = 'cancelled' WHERE id = purchase_id;
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

-- ─── DELETE SALE (guarded hard delete — page semantics) ────────────────────

CREATE OR REPLACE FUNCTION delete_sale(p_sale_id uuid)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  s record;
  ti record;
  purchase_id uuid;
BEGIN
  SELECT paid INTO s FROM sales WHERE id = p_sale_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sale not found';
  END IF;
  IF s.paid > 0 THEN
    RAISE EXCEPTION 'Cannot delete: payment has already been received.';
  END IF;

  FOR ti IN
    SELECT t.id, t.new_inventory_item_id,
           (SELECT status FROM inventory_items WHERE id = t.new_inventory_item_id) AS item_status
      FROM trade_ins t
     WHERE t.sale_id = p_sale_id
     ORDER BY t.id
  LOOP
    IF ti.item_status IS DISTINCT FROM 'in_stock' THEN
      RAISE EXCEPTION 'Cannot delete: trade-in device has already been resold.';
    END IF;
  END LOOP;

  FOR ti IN
    SELECT t.id, t.new_inventory_item_id FROM trade_ins t WHERE t.sale_id = p_sale_id ORDER BY t.id
  LOOP
    SELECT p.purchase_id INTO purchase_id
      FROM purchase_items p
     WHERE p.inventory_item_id = ti.new_inventory_item_id
     LIMIT 1;
    IF purchase_id IS NOT NULL THEN
      DELETE FROM purchase_items WHERE purchase_id = purchase_id;
      DELETE FROM purchases WHERE id = purchase_id;
    END IF;
    DELETE FROM inventory_items WHERE id = ti.new_inventory_item_id;
    DELETE FROM trade_ins WHERE id = ti.id;
  END LOOP;

  UPDATE inventory_items SET status = 'in_stock'
   WHERE id IN (SELECT inventory_item_id FROM sale_items WHERE sale_id = p_sale_id);

  DELETE FROM sale_items WHERE sale_id = p_sale_id;
  DELETE FROM sales WHERE id = p_sale_id;
END;
$$;

-- ─── CREATE PURCHASE (transactional) ───────────────────────────────────────

CREATE OR REPLACE FUNCTION create_purchase(payload jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  fy financial_years;
  sy text;
  ey text;
  dup_imei text;
  purchase_id uuid;
  bill_no text;
  added_ids uuid[];
BEGIN
  SELECT * INTO fy FROM financial_years WHERE id = (payload->>'financial_year_id')::uuid FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Financial year not found';
  END IF;

  -- 1. Duplicate IMEI check vs in-stock (message parity).
  SELECT imei INTO dup_imei
    FROM inventory_items
   WHERE imei IN (SELECT elem->>'imei' FROM jsonb_array_elements(payload->'items') AS elem)
     AND status = 'in_stock'
   LIMIT 1;
  IF dup_imei IS NOT NULL THEN
    RAISE EXCEPTION 'IMEI % is already in stock in the database.', dup_imei;
  END IF;

  -- 2. Bill number + counter (reference format PUR-2026-27-0001).
  sy := fy_start_year_full(fy);
  ey := fy_end_year_2(fy);
  bill_no := 'PUR-' || sy || '-' || ey || '-' || lpad((fy.purchase_counter + 1)::text, 4, '0');

  UPDATE financial_years SET purchase_counter = fy.purchase_counter + 1 WHERE id = fy.id;

  -- 3. Purchase record.
  INSERT INTO purchases (
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
    INSERT INTO inventory_items (
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
  INSERT INTO purchase_items (purchase_id, inventory_item_id)
  SELECT purchase_id, unnest(added_ids);

  -- 6. Payment: debit transaction + payments_out (only when paid > 0).
  IF (payload->>'paid')::numeric > 0 THEN
    INSERT INTO account_transactions (
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

    INSERT INTO payments_out (
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

CREATE OR REPLACE FUNCTION pay_purchase(
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
    FROM purchases WHERE id = p_purchase_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Purchase not found';
  END IF;
  IF p_amount > p.due THEN
    RAISE EXCEPTION 'Cannot exceed due amount';
  END IF;

  UPDATE purchases SET paid = p.paid + p_amount, due = p.due - p_amount
   WHERE id = p_purchase_id;

  INSERT INTO payments_out (
    purchase_id, party_id, amount, bank_account_id, payment_mode_id, date, financial_year_id
  ) VALUES (
    p_purchase_id, p.party_id, p_amount, p_bank_account_id, p_payment_mode_id, p_date, p.financial_year_id
  ) RETURNING id INTO po_id;

  INSERT INTO account_transactions (
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

CREATE OR REPLACE FUNCTION create_trade_in_purchase_bill(
  p_sale_id uuid,
  p_trade_in_id uuid
) RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  s record;
  ti record;
  fy financial_years;
  counter integer;
  sy text;
  ey text;
  bill_no text;
  purchase_id uuid;
BEGIN
  SELECT party_id, bank_account_id, financial_year_id INTO s FROM sales WHERE id = p_sale_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sale not found';
  END IF;

  SELECT credit_value, new_inventory_item_id INTO ti FROM trade_ins WHERE id = p_trade_in_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Trade-in not found';
  END IF;

  SELECT * INTO fy FROM financial_years WHERE id = s.financial_year_id FOR UPDATE;

  counter := fy.purchase_counter + 1;
  sy := lpad((extract(year from fy.start_date)::int % 100)::text, 2, '0');
  ey := fy_end_year_2(fy);
  bill_no := 'PUR-' || sy || '-' || ey || '-' || lpad(counter::text, 4, '0');

  INSERT INTO purchases (
    bill_number, party_id, total, paid, due, bank_account_id,
    date, financial_year_id, status
  ) VALUES (
    bill_no, s.party_id, ti.credit_value, ti.credit_value, 0, s.bank_account_id,
    current_date, fy.id, 'active'
  ) RETURNING id INTO purchase_id;

  INSERT INTO purchase_items (purchase_id, inventory_item_id)
  VALUES (purchase_id, ti.new_inventory_item_id);

  UPDATE financial_years SET purchase_counter = counter WHERE id = fy.id;

  RETURN bill_no;
END;
$$;

-- ─── UPDATE SALE (edit page: per-item prices + header) ─────────────────────

CREATE OR REPLACE FUNCTION update_sale(payload jsonb)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  s record;
  elem jsonb;
BEGIN
  SELECT paid INTO s FROM sales WHERE id = (payload->>'sale_id')::uuid FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sale not found';
  END IF;

  IF (payload->>'final_total')::numeric < s.paid THEN
    RAISE EXCEPTION 'New total (%s Rs.) cannot be less than the already-received payment (%s Rs.).',
      money_text((payload->>'final_total')::numeric), money_text(s.paid);
  END IF;

  FOR elem IN SELECT * FROM jsonb_array_elements(payload->'items') LOOP
    UPDATE sale_items SET sold_price = (elem->>'sold_price')::numeric
     WHERE id = (elem->>'sale_item_id')::uuid;
  END LOOP;

  UPDATE sales
     SET date = (payload->>'date')::date,
         discount = (payload->>'discount')::numeric,
         total = (payload->>'total')::numeric,
         final_total = (payload->>'final_total')::numeric,
         due = (payload->>'due')::numeric
   WHERE id = (payload->>'sale_id')::uuid;
END;
$$;

-- ─── CREATE PROFORMA (transactional) ───────────────────────────────────────

CREATE OR REPLACE FUNCTION create_proforma(payload jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  fy financial_years;
  sy text;
  ey text;
  bill_no text;
  proforma_id uuid;
BEGIN
  SELECT * INTO fy FROM financial_years WHERE id = (payload->>'financial_year_id')::uuid FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Financial year not found';
  END IF;

  -- Bill number (reference format PI-2026-27-0001).
  sy := fy_start_year_full(fy);
  ey := fy_end_year_2(fy);
  bill_no := 'PI-' || sy || '-' || ey || '-' || lpad((fy.proforma_counter + 1)::text, 4, '0');

  UPDATE financial_years SET proforma_counter = fy.proforma_counter + 1 WHERE id = fy.id;

  INSERT INTO proforma_invoices (
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

  INSERT INTO proforma_invoice_items (proforma_invoice_id, description, qty, rate, discount, value)
  SELECT proforma_id, elem->>'description',
         (elem->>'qty')::int, (elem->>'rate')::numeric,
         (elem->>'discount')::numeric, (elem->>'value')::numeric
    FROM jsonb_array_elements(payload->'items') AS elem;

  IF payload ? 'trade_ins' AND jsonb_array_length(payload->'trade_ins') > 0 THEN
    INSERT INTO proforma_trade_ins (proforma_invoice_id, description, qty, rate, value)
    SELECT proforma_id, elem->>'description',
           (elem->>'qty')::int, (elem->>'rate')::numeric, (elem->>'value')::numeric
      FROM jsonb_array_elements(payload->'trade_ins') AS elem
     WHERE elem->>'description' <> '';
  END IF;

  RETURN jsonb_build_object('proforma_id', proforma_id, 'bill_number', bill_no);
END;
$$;

-- ─── CLOSE FINANCIAL YEAR (page semantics: copy-based carry-forward) ───────

CREATE OR REPLACE FUNCTION close_financial_year(p_fy_id uuid)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  fy financial_years;
  next_start date;
  next_end date;
  next_fy_id uuid;
  carried_count integer := 0;
  accounts_cf integer := 0;
  has_opening boolean;
  bal record;
  fy_lbl text;
BEGIN
  SELECT * INTO fy FROM financial_years WHERE id = p_fy_id AND status = 'active' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Financial year not found or already closed';
  END IF;

  -- 1. Mark closed.
  UPDATE financial_years SET status = 'closed' WHERE id = fy.id;

  -- 2. Find or create the next FY (start = end + 1 day; end = +1 year - 1 day).
  next_start := fy.end_date + 1;
  SELECT id INTO next_fy_id FROM financial_years WHERE start_date = next_start LIMIT 1;
  IF next_fy_id IS NULL THEN
    next_end := (next_start + interval '1 year')::date - 1;
    INSERT INTO financial_years (start_date, end_date, status)
      VALUES (next_start, next_end, 'active')
      RETURNING id INTO next_fy_id;
  END IF;

  -- 3. Carry forward unsold stock as NEW inventory rows (copy, not move).
  WITH ins AS (
    INSERT INTO inventory_items (
      brand, model, imei, ram_rom, color, purchase_price, base_selling_price,
      status, source, financial_year_id, origin_inventory_item_id, opening_entry_type
    )
    SELECT i.brand, i.model, i.imei, i.ram_rom, i.color,
           i.purchase_price, i.base_selling_price,
           'in_stock', i.source, next_fy_id, i.id, 'carried_forward'
      FROM inventory_items i
     WHERE i.financial_year_id = fy.id AND i.status = 'in_stock'
    RETURNING 1
  )
  SELECT count(*) INTO carried_count FROM ins;

  -- 4. Opening balances (idempotent: only when none exist for the next FY).
  SELECT EXISTS (
    SELECT 1 FROM account_transactions
     WHERE financial_year_id = next_fy_id AND reference_type = 'opening_balance'
  ) INTO has_opening;

  IF NOT has_opening THEN
    fy_lbl := 'FY ' || fy_start_year_full(fy) || '–' || fy_end_year_2(fy);

    WITH balances AS (
      SELECT bank_account_id, sum(CASE WHEN type = 'credit' THEN amount ELSE -amount END) AS bal
        FROM account_transactions
       WHERE financial_year_id = fy.id
       GROUP BY bank_account_id
    ), ins AS (
      INSERT INTO account_transactions (
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

-- ─── ADD FUNDS (former admin API route semantics) ──────────────────────────

CREATE OR REPLACE FUNCTION add_funds(
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
    FROM financial_years WHERE id = p_financial_year_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Financial year not found';
  END IF;
  IF fy.status = 'closed' THEN
    RAISE EXCEPTION 'Cannot operate on a closed financial year';
  END IF;
  IF p_date < fy.start_date OR p_date > fy.end_date THEN
    RAISE EXCEPTION 'Date must be within financial year range (% to %)', fy.start_date, fy.end_date;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM bank_accounts WHERE id = p_bank_account_id) THEN
    RAISE EXCEPTION 'Bank account not found';
  END IF;

  INSERT INTO account_fund_entries (bank_account_id, amount, date, notes, financial_year_id)
  VALUES (p_bank_account_id, p_amount, p_date, trimmed_notes, p_financial_year_id)
  RETURNING id INTO fund_id;

  INSERT INTO account_transactions (
    bank_account_id, payment_mode_id, type, amount, date,
    reference_type, reference_id, financial_year_id, notes
  ) VALUES (
    p_bank_account_id, NULL, 'credit', p_amount, p_date,
    'add_funds', fund_id, p_financial_year_id, trimmed_notes
  );

  RETURN fund_id;
END;
$$;

-- ─── TRANSFER FUNDS (former admin API route semantics) ─────────────────────

CREATE OR REPLACE FUNCTION transfer_funds(
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
    FROM financial_years WHERE id = p_financial_year_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Financial year not found';
  END IF;
  IF fy.status = 'closed' THEN
    RAISE EXCEPTION 'Cannot operate on a closed financial year';
  END IF;
  IF p_date < fy.start_date OR p_date > fy.end_date THEN
    RAISE EXCEPTION 'Date must be within financial year range (% to %)', fy.start_date, fy.end_date;
  END IF;

  IF (SELECT count(*) FROM bank_accounts WHERE id IN (p_from_bank_account_id, p_to_bank_account_id)) <> 2 THEN
    RAISE EXCEPTION 'One or both bank accounts not found';
  END IF;

  SELECT sum(CASE WHEN type = 'credit' THEN amount ELSE -amount END) INTO source_balance
    FROM account_transactions
   WHERE bank_account_id = p_from_bank_account_id AND financial_year_id = p_financial_year_id;

  IF coalesce(source_balance, 0) < p_amount THEN
    RAISE EXCEPTION 'Insufficient balance. Source account has %s Rs. available.',
      money_text(coalesce(source_balance, 0));
  END IF;

  INSERT INTO account_transfers (
    from_bank_account_id, to_bank_account_id, amount, date, notes, financial_year_id
  ) VALUES (
    p_from_bank_account_id, p_to_bank_account_id, p_amount, p_date, trimmed_notes, p_financial_year_id
  ) RETURNING id INTO transfer_id;

  group_id := gen_random_uuid();

  INSERT INTO account_transactions (
    bank_account_id, payment_mode_id, type, amount, date,
    reference_type, reference_id, financial_year_id, notes, transfer_group_id
  ) VALUES (
    p_from_bank_account_id, NULL, 'debit', p_amount, p_date,
    'transfer', transfer_id, p_financial_year_id, trimmed_notes, group_id
  );

  INSERT INTO account_transactions (
    bank_account_id, payment_mode_id, type, amount, date,
    reference_type, reference_id, financial_year_id, notes, transfer_group_id
  ) VALUES (
    p_to_bank_account_id, NULL, 'credit', p_amount, p_date,
    'transfer', transfer_id, p_financial_year_id, trimmed_notes, group_id
  );

  RETURN transfer_id;
END;
$$;
