-- ============================================================
-- FUSION ONE — canonical production schema 05: indexes
-- ============================================================
-- All 49 secondary indexes: foreign-key support indexes, the
-- partial unique idempotency indexes of the message-job system,
-- the duplicate-conversion guard on sales.proforma_id, the
-- in-stock IMEI uniqueness index, and the trigram GIN indexes
-- over the generated search columns (pg_trgm from 01 required).
--
-- Idempotent: IF NOT EXISTS guards every statement.
-- ============================================================

-- INDEX: idx_account_tx_account_fy
CREATE INDEX IF NOT EXISTS idx_account_tx_account_fy ON public.account_transactions USING btree (bank_account_id, financial_year_id);

-- INDEX: idx_account_tx_date
CREATE INDEX IF NOT EXISTS idx_account_tx_date ON public.account_transactions USING btree (date);

-- INDEX: idx_account_tx_ref
CREATE INDEX IF NOT EXISTS idx_account_tx_ref ON public.account_transactions USING btree (reference_type, reference_id);

-- INDEX: idx_inventory_brand_n_trgm
CREATE INDEX IF NOT EXISTS idx_inventory_brand_n_trgm ON public.inventory_items USING gin (brand_n public.gin_trgm_ops);

-- INDEX: idx_inventory_fy
CREATE INDEX IF NOT EXISTS idx_inventory_fy ON public.inventory_items USING btree (financial_year_id);

-- INDEX: idx_inventory_fy_status
CREATE INDEX IF NOT EXISTS idx_inventory_fy_status ON public.inventory_items USING btree (financial_year_id, status);

-- INDEX: idx_inventory_model_n_trgm
CREATE INDEX IF NOT EXISTS idx_inventory_model_n_trgm ON public.inventory_items USING gin (model_n public.gin_trgm_ops);

-- INDEX: idx_inventory_search_n_trgm
CREATE INDEX IF NOT EXISTS idx_inventory_search_n_trgm ON public.inventory_items USING gin (search_n public.gin_trgm_ops);

-- INDEX: idx_inventory_status
CREATE INDEX IF NOT EXISTS idx_inventory_status ON public.inventory_items USING btree (status);

-- INDEX: idx_message_jobs_claim_expiry
CREATE INDEX IF NOT EXISTS idx_message_jobs_claim_expiry ON public.message_jobs USING btree (claim_expires_at) WHERE (status = 'processing'::text);

-- INDEX: idx_message_jobs_due
CREATE INDEX IF NOT EXISTS idx_message_jobs_due ON public.message_jobs USING btree (status, run_at);

-- INDEX: idx_message_jobs_payment_in
CREATE INDEX IF NOT EXISTS idx_message_jobs_payment_in ON public.message_jobs USING btree (payment_in_id, created_at DESC);

-- INDEX: idx_message_jobs_payment_out
CREATE INDEX IF NOT EXISTS idx_message_jobs_payment_out ON public.message_jobs USING btree (payment_out_id, created_at DESC);

-- INDEX: idx_message_jobs_proforma
CREATE INDEX IF NOT EXISTS idx_message_jobs_proforma ON public.message_jobs USING btree (proforma_id, created_at DESC);

-- INDEX: idx_message_jobs_purchase
CREATE INDEX IF NOT EXISTS idx_message_jobs_purchase ON public.message_jobs USING btree (purchase_id, created_at DESC);

-- INDEX: idx_message_jobs_sale
CREATE INDEX IF NOT EXISTS idx_message_jobs_sale ON public.message_jobs USING btree (sale_id, created_at DESC);

-- INDEX: idx_parties_name_n_trgm
CREATE INDEX IF NOT EXISTS idx_parties_name_n_trgm ON public.parties USING gin (name_n public.gin_trgm_ops);

-- INDEX: idx_parties_search_n_trgm
CREATE INDEX IF NOT EXISTS idx_parties_search_n_trgm ON public.parties USING gin (search_n public.gin_trgm_ops);

-- INDEX: idx_party_documents_party
CREATE INDEX IF NOT EXISTS idx_party_documents_party ON public.party_documents USING btree (party_id);

-- INDEX: idx_payments_in_sale
CREATE INDEX IF NOT EXISTS idx_payments_in_sale ON public.payments_in USING btree (sale_id);

-- INDEX: idx_payments_out_purchase
CREATE INDEX IF NOT EXISTS idx_payments_out_purchase ON public.payments_out USING btree (purchase_id);

-- INDEX: idx_proforma_date
CREATE INDEX IF NOT EXISTS idx_proforma_date ON public.proforma_invoices USING btree (date);

-- INDEX: idx_proforma_fy
CREATE INDEX IF NOT EXISTS idx_proforma_fy ON public.proforma_invoices USING btree (financial_year_id);

-- INDEX: idx_proforma_items_inventory
CREATE INDEX IF NOT EXISTS idx_proforma_items_inventory ON public.proforma_invoice_items USING btree (inventory_item_id);

-- INDEX: idx_proforma_status
CREATE INDEX IF NOT EXISTS idx_proforma_status ON public.proforma_invoices USING btree (status);

-- INDEX: idx_purchase_items_inventory
CREATE INDEX IF NOT EXISTS idx_purchase_items_inventory ON public.purchase_items USING btree (inventory_item_id);

-- INDEX: idx_purchases_date
CREATE INDEX IF NOT EXISTS idx_purchases_date ON public.purchases USING btree (date);

-- INDEX: idx_purchases_fy
CREATE INDEX IF NOT EXISTS idx_purchases_fy ON public.purchases USING btree (financial_year_id);

-- INDEX: idx_purchases_party_id
CREATE INDEX IF NOT EXISTS idx_purchases_party_id ON public.purchases USING btree (party_id);

-- INDEX: idx_purchases_status
CREATE INDEX IF NOT EXISTS idx_purchases_status ON public.purchases USING btree (status);

-- INDEX: idx_sale_items_inventory
CREATE INDEX IF NOT EXISTS idx_sale_items_inventory ON public.sale_items USING btree (inventory_item_id);

-- INDEX: idx_sales_date
CREATE INDEX IF NOT EXISTS idx_sales_date ON public.sales USING btree (date);

-- INDEX: idx_sales_fy
CREATE INDEX IF NOT EXISTS idx_sales_fy ON public.sales USING btree (financial_year_id);

-- INDEX: idx_sales_party_id
CREATE INDEX IF NOT EXISTS idx_sales_party_id ON public.sales USING btree (party_id);

-- INDEX: idx_sales_proforma_unique
CREATE UNIQUE INDEX idx_sales_proforma_unique ON public.sales USING btree (proforma_id) WHERE (proforma_id IS NOT NULL);

-- INDEX: idx_sales_status
CREATE INDEX IF NOT EXISTS idx_sales_status ON public.sales USING btree (status);

-- INDEX: idx_trade_ins_inventory
CREATE INDEX IF NOT EXISTS idx_trade_ins_inventory ON public.trade_ins USING btree (inventory_item_id);

-- INDEX: idx_trade_ins_sale
CREATE INDEX IF NOT EXISTS idx_trade_ins_sale ON public.trade_ins USING btree (sale_id);

-- INDEX: idx_unique_imei_in_stock
CREATE UNIQUE INDEX idx_unique_imei_in_stock ON public.inventory_items USING btree (financial_year_id, imei) WHERE (status = 'in_stock'::text);

-- INDEX: store_singleton
CREATE UNIQUE INDEX store_singleton ON public.store USING btree (singleton);

-- INDEX: uq_message_jobs_invoice_send_proforma
CREATE UNIQUE INDEX uq_message_jobs_invoice_send_proforma ON public.message_jobs USING btree (proforma_id) WHERE ((job_type = 'invoice_send'::text) AND (status = ANY (ARRAY['pending'::text, 'processing'::text])));

-- INDEX: uq_message_jobs_invoice_send_purchase
CREATE UNIQUE INDEX uq_message_jobs_invoice_send_purchase ON public.message_jobs USING btree (purchase_id) WHERE ((job_type = 'invoice_send'::text) AND (status = ANY (ARRAY['pending'::text, 'processing'::text])));

-- INDEX: uq_message_jobs_invoice_send_sale
CREATE UNIQUE INDEX uq_message_jobs_invoice_send_sale ON public.message_jobs USING btree (sale_id) WHERE ((job_type = 'invoice_send'::text) AND (status = ANY (ARRAY['pending'::text, 'processing'::text])));

-- INDEX: uq_message_jobs_receipt_in
CREATE UNIQUE INDEX uq_message_jobs_receipt_in ON public.message_jobs USING btree (payment_in_id) WHERE ((job_type = 'receipt'::text) AND (status = ANY (ARRAY['pending'::text, 'processing'::text])));

-- INDEX: uq_message_jobs_receipt_out
CREATE UNIQUE INDEX uq_message_jobs_receipt_out ON public.message_jobs USING btree (payment_out_id) WHERE ((job_type = 'receipt'::text) AND (status = ANY (ARRAY['pending'::text, 'processing'::text])));

-- INDEX: uq_message_jobs_reminder_sale
CREATE UNIQUE INDEX uq_message_jobs_reminder_sale ON public.message_jobs USING btree (sale_id) WHERE ((job_type = 'reminder'::text) AND (status = ANY (ARRAY['pending'::text, 'processing'::text])));

-- INDEX: uq_message_jobs_statement_purchase
CREATE UNIQUE INDEX uq_message_jobs_statement_purchase ON public.message_jobs USING btree (purchase_id) WHERE ((job_type = 'statement'::text) AND (status = ANY (ARRAY['pending'::text, 'processing'::text])));

-- INDEX: uq_message_jobs_statement_sale
CREATE UNIQUE INDEX uq_message_jobs_statement_sale ON public.message_jobs USING btree (sale_id) WHERE ((job_type = 'statement'::text) AND (status = ANY (ARRAY['pending'::text, 'processing'::text])));

-- INDEX: whatsapp_settings_singleton
CREATE UNIQUE INDEX whatsapp_settings_singleton ON public.whatsapp_settings USING btree (singleton);
