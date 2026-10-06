-- ============================================================
-- FUSIONONE — TEST database rebuild — 0004 Indexes
-- ============================================================
-- Same index set as the reference project (foreign-key + hot-path filters).

CREATE INDEX idx_sales_party_id ON sales(party_id);
CREATE INDEX idx_sales_date ON sales(date);
CREATE INDEX idx_sales_status ON sales(status);
CREATE INDEX idx_sales_fy ON sales(financial_year_id);
CREATE INDEX idx_purchases_party_id ON purchases(party_id);
CREATE INDEX idx_purchases_date ON purchases(date);
CREATE INDEX idx_purchases_status ON purchases(status);
CREATE INDEX idx_purchases_fy ON purchases(financial_year_id);
CREATE INDEX idx_inventory_status ON inventory_items(status);
CREATE INDEX idx_inventory_fy ON inventory_items(financial_year_id);
CREATE INDEX idx_payments_in_sale ON payments_in(sale_id);
CREATE INDEX idx_payments_out_purchase ON payments_out(purchase_id);
CREATE INDEX idx_account_tx_date ON account_transactions(date);
CREATE INDEX idx_account_tx_ref ON account_transactions(reference_type, reference_id);
CREATE INDEX idx_account_tx_account_fy ON account_transactions(bank_account_id, financial_year_id);
CREATE INDEX idx_proforma_status ON proforma_invoices(status);
CREATE INDEX idx_proforma_date ON proforma_invoices(date);
CREATE INDEX idx_proforma_fy ON proforma_invoices(financial_year_id);
CREATE INDEX idx_trade_ins_sale ON trade_ins(sale_id);
CREATE INDEX idx_purchase_items_inventory ON purchase_items(inventory_item_id);
CREATE INDEX idx_sale_items_inventory ON sale_items(inventory_item_id);
