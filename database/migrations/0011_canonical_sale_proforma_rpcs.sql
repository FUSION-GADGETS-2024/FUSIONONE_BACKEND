-- ============================================================
-- FUSIONONE — 0011 Canonical Trade-In + Proforma + Sale RPCs
-- ============================================================
-- Replaces the business RPCs affected by the 0010 domain model:
--
--   create_sale     — ONE canonical sale-creation path with two
--                     entry modes:
--                       normal    : full client payload (items,
--                                   trade-ins, payment)
--                       proforma  : payload.proforma_id — the
--                                   commercial content (party, quoted
--                                   items, quoted prices, discount)
--                                   is loaded from the database, the
--                                   client supplies only conversion-
--                                   time decisions (date, ACTUAL
--                                   trade-in devices, payment). The
--                                   proforma is locked, validated,
--                                   linked and marked converted in
--                                   the SAME transaction.
--                     All monetary totals are computed SERVER-SIDE.
--   cancel_sale     — only-active + open-FY guards, row lock,
--                     FK-safe trade-in reversal, resold devices
--                     reported with identity read through Inventory.
--   delete_sale     — only-active + no-payments + all-trade-ins-
--                     in-stock guards, FK-safe deletion order,
--                     originating proforma (if any) reverted to
--                     active because its sale graph no longer exists.
--   update_sale     — the canonical ATOMIC sale edit (prices, date,
--                     discount) with server-computed totals.
--   create_proforma — quotations reference REAL in-stock Inventory;
--                     totals computed server-side.
--   update_proforma — NEW: edit an ACTIVE quotation (replaces its
--                     lines/trade-ins; bill number and counter
--                     preserved).
--   void_proforma   — NEW: void an ACTIVE quotation (no inventory,
--                     payment or accounting side effects — a
--                     quotation never had any).
--   create_trade_in_purchase_bill — adapted to the new trade_ins
--                     shape (credit + inventory reference).
--
--   allocate_bill_numbers is DROPPED: dead code (no caller anywhere
--   in frontend or backend; counters are maintained inside the
--   create RPCs).
--
-- Concurrency & idempotency guarantees for conversion:
--   1. SELECT ... FOR UPDATE on the proforma serializes concurrent
--      conversions; the loser sees status <> 'active' and fails
--      cleanly.
--   2. idx_sales_proforma_unique (0010) makes a duplicate conversion
--      sale physically impossible even across retry windows.
--   3. The whole conversion is ONE transaction — a failure anywhere
--      leaves no partial sale and the proforma stays active.
--
-- Execution posture: business RPCs run as SECURITY INVOKER under the
-- caller's JWT + RLS (unchanged). EXECUTE is restricted to
-- authenticated + service_role (anon never calls business RPCs).
-- ============================================================

-- ─── Shared payload helper ──────────────────────────────────────────────────
-- Array length that treats a missing/JSON-null/scalar value as an empty
-- array — a malformed payload fails validation instead of raising a
-- confusing cast error.
CREATE OR REPLACE FUNCTION private.jsonb_array_len(v jsonb)
RETURNS integer LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN jsonb_typeof(v) = 'array' THEN jsonb_array_length(v) ELSE 0 END
$$;

-- ─── CREATE SALE (canonical: normal + proforma-conversion modes) ───────────
--
-- payload (normal mode):
--   financial_year_id uuid   -- FY of the sale
--   party_id uuid
--   date date
--   items [{inventory_item_id uuid, sold_price numeric}]
--   trade_ins [{brand, model, imei, ram_rom, color, credit_value,
--               mrp, document_url}]
--   discount numeric
--   paid numeric, bank_account_id uuid, payment_mode_id uuid|null
--
-- payload (proforma mode — payload ? 'proforma_id'):
--   proforma_id uuid         -- ACTIVE proforma (locked + validated)
--   date date                -- conversion date (within proforma's FY)
--   items [{proforma_item_id uuid, inventory_item_id uuid}]
--                               -- one fulfillment per quoted line:
--                               inventory-backed lines MUST map to
--                               their own device (no substitution);
--                               legacy free-text lines are mapped by
--                               the user at conversion time
--   trade_ins [...]          -- ACTUAL received devices (validated)
--   paid numeric, bank_account_id uuid, payment_mode_id uuid|null
--
-- In BOTH modes the server computes: total, trade_in_credit,
-- final_total, due — never trusting client arithmetic.

CREATE OR REPLACE FUNCTION public.create_sale(payload jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $$
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
      sale_id, inventory_item_id, credit_value, mrp, document_url
    ) VALUES (
      v_sale_id, v_inv_id,
      (v_ti->>'credit_value')::numeric,
      NULLIF(v_ti->>'mrp', '')::numeric,
      NULLIF(v_ti->>'document_url', '')::text
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
$$;

REVOKE EXECUTE ON FUNCTION public.create_sale(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_sale(jsonb) TO authenticated, service_role;

-- ─── CANCEL SALE (transactional, FK-safe, guarded) ─────────────────────────

CREATE OR REPLACE FUNCTION public.cancel_sale(p_sale_id uuid)
RETURNS jsonb LANGUAGE plpgsql AS $$
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
    SELECT t.id, t.inventory_item_id, t.credit_value, t.mrp, t.document_url,
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
        'document_url', ti.document_url,
        'purchase_id', v_purchase_id,
        'status', ti.item_status
      );
    END IF;
  END LOOP;

  RETURN jsonb_build_object('resold', resold);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.cancel_sale(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_sale(uuid) TO authenticated, service_role;

-- ─── DELETE SALE (guarded hard delete, FK-safe order) ──────────────────────

CREATE OR REPLACE FUNCTION public.delete_sale(p_sale_id uuid)
RETURNS void LANGUAGE plpgsql AS $$
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

REVOKE EXECUTE ON FUNCTION public.delete_sale(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_sale(uuid) TO authenticated, service_role;

-- ─── UPDATE SALE (canonical atomic edit) ───────────────────────────────────
-- payload: {sale_id, date, discount, items: [{sale_item_id, sold_price}]}
-- The item set must cover EXACTLY the sale's items (prices are edited;
-- composition is not). Totals are recomputed server-side.

CREATE OR REPLACE FUNCTION public.update_sale(payload jsonb)
RETURNS void LANGUAGE plpgsql AS $$
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

REVOKE EXECUTE ON FUNCTION public.update_sale(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_sale(jsonb) TO authenticated, service_role;

-- ─── CREATE PROFORMA (inventory-referenced quotation) ──────────────────────
-- payload: {financial_year_id, party_id, date, discount,
--           items: [{inventory_item_id, rate}],
--           trade_ins: [{description, qty, rate}]}
-- Items quote REAL in-stock devices of the same FY at a quoted rate
-- (the price snapshot). Proposed trade-ins stay free-text proposals.

CREATE OR REPLACE FUNCTION public.create_proforma(payload jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $$
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

  -- Every quoted line references a distinct in-stock device of THIS FY.
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

  -- Proposed trade-ins: free-text commercial proposals (no inventory
  -- identity is fabricated — the device is only received at conversion).
  IF private.jsonb_array_len(payload->'trade_ins') > 0 THEN
    FOR ti IN SELECT * FROM jsonb_array_elements(payload->'trade_ins') LOOP
      IF btrim(COALESCE(ti->>'description', '')) = '' THEN
        RAISE EXCEPTION 'Trade-in description is required';
      END IF;
      IF (ti->>'rate')::numeric < 0 THEN
        RAISE EXCEPTION 'Trade-in rate cannot be negative';
      END IF;
    END LOOP;
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

REVOKE EXECUTE ON FUNCTION public.create_proforma(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_proforma(jsonb) TO authenticated, service_role;

-- ─── UPDATE PROFORMA (edit an ACTIVE quotation) ─────────────────────────────
-- Same shape and invariants as create_proforma, applied to an existing
-- ACTIVE quotation. The bill number and the FY counter are preserved
-- (this is a revision, not a new document). Lines and proposed
-- trade-ins are replaced wholesale.

CREATE OR REPLACE FUNCTION public.update_proforma(payload jsonb)
RETURNS void LANGUAGE plpgsql AS $$
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
    END LOOP;
  END IF;

  -- Replace lines + proposed trade-ins wholesale (same transaction).
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

REVOKE EXECUTE ON FUNCTION public.update_proforma(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_proforma(jsonb) TO authenticated, service_role;

-- ─── VOID PROFORMA (terminate an ACTIVE quotation) ─────────────────────────

CREATE OR REPLACE FUNCTION public.void_proforma(p_proforma_id uuid)
RETURNS void LANGUAGE plpgsql AS $$
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

REVOKE EXECUTE ON FUNCTION public.void_proforma(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.void_proforma(uuid) TO authenticated, service_role;

-- ─── CREATE PURCHASE BILL FOR RESOLD TRADE-IN (recovery flow) ──────────────
-- Reference quirk preserved: this bill format uses TWO-DIGIT start
-- years (PUR-26-27-0001), unlike regular purchases (PUR-2026-27-0001).

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
  sy := lpad((extract(year from fy.start_date)::int % 100)::text, 2, '0');
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

REVOKE EXECUTE ON FUNCTION public.create_trade_in_purchase_bill(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_trade_in_purchase_bill(uuid, uuid) TO authenticated, service_role;

-- ─── Drop dead code ─────────────────────────────────────────────────────────
-- allocate_bill_numbers has no caller in the frontend or backend; the
-- create RPCs maintain the counters transactionally themselves.
DROP FUNCTION IF EXISTS public.allocate_bill_numbers(uuid, integer, integer, integer);
