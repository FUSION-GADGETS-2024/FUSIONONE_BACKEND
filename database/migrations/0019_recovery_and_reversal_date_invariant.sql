-- ─────────────────────────────────────────────────────────────────────────────
-- 0019 — Recovery bills and cancellation reversals keep the date-in-FY invariant.
--
-- Every purchase/ledger row carries (date, financial_year_id) and every
-- creation RPC must keep the invariant: date ∈ [FY.start_date, FY.end_date]
-- of the row's own financial_year_id.
--
--   create_sale / create_purchase already ENFORCE it by rejecting payloads
--   whose date falls outside the chosen year ("Date must be within the
--   financial year").
--
--   create_trade_in_purchase_bill derived its date from current_date while
--   assigning the SALE's financial year — the one purchase-creating RPC
--   without any date guard. When the caller's clock sits outside the sale's
--   year (observed in TEST: sale dated 2027-04-05, sandbox clock 2026-10-09)
--   it produced a bill whose date contradicts its year and numbering
--   (PUR-2027-28-0006 dated 9 Oct 2026).
--
--   cancel_sale stamped its payment-reversal ledger rows with today + the
--   sale's financial year — the same latent gap for account_transactions.
--
-- Fix (bounded, same business meaning):
--   * The recovery bill is dated the cancellation date CLAMPED into the
--     sale's year: GREATEST(start, LEAST(current_date, end)). With a normal
--     clock (inside the year) the date is exactly current_date, unchanged.
--   * The cancellation reversal rows use the same clamped date.
--
-- Nothing else changes: numbering, counters, trade-in semantics, closed-year
-- guards, grants — all preserved from the live bodies.
-- ─────────────────────────────────────────────────────────────────────────────

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
  v_bill_date date;
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

  -- The recovery bill belongs to the sale's financial year, so its date
  -- must lie within that year. The business date is the cancellation date
  -- (today) clamped into the year's inclusive bounds — with a normal clock
  -- (inside the year) this is exactly current_date. create_purchase /
  -- create_sale enforce the same invariant by REJECTING out-of-year dates;
  -- this RPC derives the date itself, so it clamps instead of rejecting.
  v_bill_date := GREATEST(fy.start_date, LEAST(current_date, fy.end_date));

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
    v_bill_date, fy.id, 'active'
  ) RETURNING id INTO v_purchase_id;

  INSERT INTO public.purchase_items (purchase_id, inventory_item_id)
  VALUES (v_purchase_id, ti.inventory_item_id);

  UPDATE public.financial_years SET purchase_counter = counter WHERE id = fy.id;

  RETURN bill_no;
END;
$$;

-- Execution posture restated for the replaced RPC (0015 convention):
-- owner-facing business RPC — only the authenticated app session and
-- service tooling may call it.
REVOKE EXECUTE ON FUNCTION public.create_trade_in_purchase_bill(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_trade_in_purchase_bill(uuid, uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.cancel_sale(p_sale_id uuid)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  s record;
  ti record;
  v_purchase_id uuid;
  resold jsonb := '[]'::jsonb;
  v_reversal_date date;
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

  -- The payment-reversal ledger rows belong to the sale's financial year,
  -- so their date must lie within that year: the cancellation date (today)
  -- clamped into the year's inclusive bounds. With a normal clock (inside
  -- the year) this is exactly current_date, unchanged.
  SELECT GREATEST(fy.start_date, LEAST(current_date, fy.end_date)) INTO v_reversal_date
    FROM public.financial_years fy WHERE fy.id = s.financial_year_id;

  -- 1. Mark cancelled.
  UPDATE public.sales SET status = 'cancelled' WHERE id = p_sale_id;

  -- 2. Return sold inventory to stock.
  UPDATE public.inventory_items SET status = 'in_stock'
   WHERE id IN (SELECT inventory_item_id FROM public.sale_items WHERE sale_id = p_sale_id);

  -- 3. Reverse payment_in entries (debit, dated the clamped cancellation
  --    date, referencing the sale).
  FOR pi_row IN
    SELECT amount, bank_account_id FROM public.payments_in WHERE sale_id = p_sale_id
  LOOP
    INSERT INTO public.account_transactions (
      bank_account_id, type, amount, date, reference_type, reference_id, financial_year_id
    ) VALUES (
      pi_row.bank_account_id, 'debit', pi_row.amount, v_reversal_date, 'sale_cancelled', p_sale_id, s.financial_year_id
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

REVOKE EXECUTE ON FUNCTION public.cancel_sale(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_sale(uuid) TO authenticated, service_role;
