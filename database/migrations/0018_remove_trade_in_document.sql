-- ============================================================
-- FUSIONONE — 0018 Remove the trade-in document relationship
--            (documents belong exclusively to Parties)
-- ============================================================
-- Final domain model after this migration:
--
--   PARTIES
--     └── party_documents   (Add / Preview / Download / Replace /
--                            Archive — the ONE document surface)
--
--   trade_ins              — NO document relationship at all.
--
-- The trade_ins.document_id reference added by 0016 is removed
-- completely (column + FK + index). create_sale no longer accepts
-- or validates a per-trade-in document; cancel_sale no longer
-- returns document data in its resold[] payload. Documents are
-- created exclusively through the party-scoped backend routes
-- (including the optional initial document on Add Party).
--
-- party_documents itself is UNTOUCHED — the entity, its RLS
-- policy, its index and every party-scoped backend route remain
-- exactly as implemented. No data migration is required: the
-- reference is nullable metadata only (TEST verified: the seeded
-- trade_ins rows never referenced a document, and any reference
-- is a historical pointer whose removal does not affect the
-- party_documents rows themselves).
-- ============================================================

-- ─── 1. Remove trade_ins.document_id (column + FK + index) ────────────────
-- Dropping the column removes its FK constraint and its index with it;
-- the explicit statements keep the intent readable and re-runnable.

DROP INDEX IF EXISTS public.idx_trade_ins_document;

ALTER TABLE public.trade_ins DROP COLUMN IF EXISTS document_id;

-- ─── 2. create_sale — documents are no longer part of trade-ins ───────────
-- (exact live body, modified ONLY in the trade-in sections: the
-- document_id payload key, the party-ownership validation block and the
-- document column of the trade_ins insert are removed.)

CREATE OR REPLACE FUNCTION public.create_sale(payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
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
$function$;

REVOKE EXECUTE ON FUNCTION public.create_sale(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_sale(jsonb) TO authenticated, service_role;

-- ─── 3. cancel_sale — no document data in the resold[] payload ────────────
-- (exact live body; only the trade-in SELECT + resold[] field change.)

CREATE OR REPLACE FUNCTION public.cancel_sale(p_sale_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
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
$function$;

REVOKE EXECUTE ON FUNCTION public.cancel_sale(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_sale(uuid) TO authenticated, service_role;
