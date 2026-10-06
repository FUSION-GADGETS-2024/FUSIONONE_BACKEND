-- ============================================================
-- FUSIONONE — TEST database rebuild — 0003 Row Level Security
-- ============================================================
-- RLS-first security model (identical to the reference project):
--   * store + whatsapp_settings — owner check via auth.uid() directly
--   * the other 18 business tables — owner check via is_owner()
--     (SECURITY DEFINER EXISTS on store)
--   * anon role — deny-all (no policies for anon anywhere)

-- ─── Security function ─────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION is_owner()
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM store WHERE owner_user_id = auth.uid()
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ─── Enable RLS on every table ─────────────────────────────────────────────

ALTER TABLE financial_years ENABLE ROW LEVEL SECURITY;
ALTER TABLE store ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_modes ENABLE ROW LEVEL SECURITY;
ALTER TABLE parties ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchases ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales ENABLE ROW LEVEL SECURITY;
ALTER TABLE sale_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE trade_ins ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments_in ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments_out ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_fund_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE proforma_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE proforma_invoice_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE proforma_trade_ins ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_settings ENABLE ROW LEVEL SECURITY;

-- ─── Policies ──────────────────────────────────────────────────────────────

-- Store: owner check via auth.uid() directly
CREATE POLICY "Store Owner Access" ON store
  FOR ALL TO authenticated
  USING (owner_user_id = auth.uid())
  WITH CHECK (owner_user_id = auth.uid());

-- All business tables: owner check via is_owner()
CREATE POLICY "Owner Access" ON financial_years
  FOR ALL TO authenticated USING (is_owner()) WITH CHECK (is_owner());
CREATE POLICY "Owner Access" ON bank_accounts
  FOR ALL TO authenticated USING (is_owner()) WITH CHECK (is_owner());
CREATE POLICY "Owner Access" ON payment_modes
  FOR ALL TO authenticated USING (is_owner()) WITH CHECK (is_owner());
CREATE POLICY "Owner Access" ON parties
  FOR ALL TO authenticated USING (is_owner()) WITH CHECK (is_owner());
CREATE POLICY "Owner Access" ON inventory_items
  FOR ALL TO authenticated USING (is_owner()) WITH CHECK (is_owner());
CREATE POLICY "Owner Access" ON purchases
  FOR ALL TO authenticated USING (is_owner()) WITH CHECK (is_owner());
CREATE POLICY "Owner Access" ON purchase_items
  FOR ALL TO authenticated USING (is_owner()) WITH CHECK (is_owner());
CREATE POLICY "Owner Access" ON sales
  FOR ALL TO authenticated USING (is_owner()) WITH CHECK (is_owner());
CREATE POLICY "Owner Access" ON sale_items
  FOR ALL TO authenticated USING (is_owner()) WITH CHECK (is_owner());
CREATE POLICY "Owner Access" ON trade_ins
  FOR ALL TO authenticated USING (is_owner()) WITH CHECK (is_owner());
CREATE POLICY "Owner Access" ON payments_in
  FOR ALL TO authenticated USING (is_owner()) WITH CHECK (is_owner());
CREATE POLICY "Owner Access" ON payments_out
  FOR ALL TO authenticated USING (is_owner()) WITH CHECK (is_owner());
CREATE POLICY "Owner Access" ON account_transactions
  FOR ALL TO authenticated USING (is_owner()) WITH CHECK (is_owner());
CREATE POLICY "Owner Access" ON account_fund_entries
  FOR ALL TO authenticated USING (is_owner()) WITH CHECK (is_owner());
CREATE POLICY "Owner Access" ON account_transfers
  FOR ALL TO authenticated USING (is_owner()) WITH CHECK (is_owner());
CREATE POLICY "Owner Access" ON proforma_invoices
  FOR ALL TO authenticated USING (is_owner()) WITH CHECK (is_owner());
CREATE POLICY "Owner Access" ON proforma_invoice_items
  FOR ALL TO authenticated USING (is_owner()) WITH CHECK (is_owner());
CREATE POLICY "Owner Access" ON proforma_trade_ins
  FOR ALL TO authenticated USING (is_owner()) WITH CHECK (is_owner());

-- WhatsApp settings: owner check via auth.uid() directly
CREATE POLICY "whatsapp_settings_owner" ON whatsapp_settings
  FOR ALL TO authenticated
  USING (owner_user_id = auth.uid())
  WITH CHECK (owner_user_id = auth.uid());

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE whatsapp_settings TO authenticated;
