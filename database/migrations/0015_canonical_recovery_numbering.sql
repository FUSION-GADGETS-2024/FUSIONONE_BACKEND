-- ─────────────────────────────────────────────────────────────────────────────
-- 0015 — Recovery bills use the ONE canonical purchase numbering.
--
-- create_trade_in_purchase_bill allocates PUR-<full start year>-<two-digit
-- end year>-<counter> through the SAME fy_start_year_full / fy_end_year_2
-- helpers as create_purchase (e.g. PUR-2026-27-0006), replacing the
-- historical two-digit start-year quirk (PUR-26-27-0006). The live TEST
-- database already carries exactly this body (verified: a new recovery
-- bill generated PUR-2027-28-0001; E2E observed PUR-2026-27-0006 through
-- the real UI recovery flow).
--
-- One canonical numbering rule for ALL purchases — no second formatter.
-- Historical bill numbers are untouched; only NEW recovery bills are
-- affected. Everything else in the function is unchanged.
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

-- Re-apply the established execution posture for the replaced RPC
-- (0011 restates it the same way): owner-facing business RPC — only the
-- authenticated app session and service tooling may call it.
REVOKE EXECUTE ON FUNCTION public.create_trade_in_purchase_bill(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_trade_in_purchase_bill(uuid, uuid) TO authenticated, service_role;
