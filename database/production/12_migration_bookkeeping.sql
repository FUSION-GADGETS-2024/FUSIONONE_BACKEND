-- ============================================================
-- FUSION ONE — canonical production schema 12: migration bookkeeping
-- ============================================================
-- Marks the historical migration chain as fully applied so the
-- canonical build and the migration runner (database/tools/apply.ts)
-- agree on the database's state: the runner becomes a no-op instead
-- of trying to re-create existing objects.
--
-- The canonical SQL in this directory and the historical chain in
-- database/migrations/0001..0018 produce the same final schema
-- (proven on the TEST project); these rows record that equivalence.
--
-- MUST run last: the chain is only marked complete when the whole
-- canonical build has succeeded.
--
-- Idempotent: ON CONFLICT DO NOTHING.
-- ============================================================

INSERT INTO public.schema_migrations (version) VALUES
  ('0001_extensions.sql'),
  ('0002_schema.sql'),
  ('0003_functions_triggers.sql'),
  ('0004_security_storage.sql'),
  ('0005_user_roles.sql'),
  ('0006_delivery_jobs.sql'),
  ('0007_auto_receipts_statements.sql'),
  ('0008_messages_overview.sql'),
  ('0009_message_jobs.sql'),
  ('0010_trade_in_proforma_schema.sql'),
  ('0011_canonical_sale_proforma_rpcs.sql'),
  ('0012_validation_search.sql'),
  ('0013_strict_identity_validation.sql'),
  ('0014_payment_amount_invariant.sql'),
  ('0015_canonical_recovery_numbering.sql'),
  ('0016_party_documents.sql'),
  ('0017_legacy_document_removal.sql'),
  ('0018_remove_trade_in_document.sql')
ON CONFLICT (version) DO NOTHING;
