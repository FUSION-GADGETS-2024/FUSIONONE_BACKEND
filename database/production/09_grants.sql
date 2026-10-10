-- ============================================================
-- FUSION ONE — canonical production schema 09: grants & privileges
-- ============================================================
-- The complete, explicit privilege posture for the Supabase API
-- roles. RLS (08) keeps the data private; these grants define
-- what the API surface can even attempt:
--
--   anon            — table CRUD grants on the shared business
--                     tables (RLS deny-all makes them unreachable
--                     without a policy; the grants match the
--                     verified live posture), read-only grants on
--                     the system-owned job tables, NO grants on
--                     users/schema_migrations, and EXECUTE only
--                     where the live posture keeps it (see below).
--   authenticated   — the application runtime role: business
--                     tables, SELECT-only job tables, SELECT on
--                     users + column-level UPDATE(display_name).
--   service_role    — trusted backend: full tables incl. users;
--                     the five service-role-only job RPCs.
--
-- Deliberate, documented normalizations vs. the historical live
-- states (see README "Deviations"):
--   * table privilege lists are explicit (no MAINTAIN bit for
--     the API roles — the meaningless-on-Supabase 'm' privilege
--     that GRANT ALL would add on PostgreSQL >= 17);
--   * business RPC EXECUTE mirrors the verified live posture
--     exactly: most are revoked from PUBLIC/anon; add_funds,
--     close_financial_year, transfer_funds, fy_end_year_2,
--     fy_start_year_full, money_text, pay_purchase and
--     receive_payment keep the PostgreSQL default PUBLIC EXECUTE
--     (anon can resolve them; RLS denies every row — SECURITY
--     INVOKER under an roleless context fails closed);
--   * DEFAULT PRIVILEGES from migrations/0004 restored (the
--     TEST project lost them to a historical schema reset;
--     production carries them): future objects created by
--     postgres in public keep the same API grants.
--
-- Idempotent: GRANT/REVOKE are naturally so.
-- ============================================================

-- ── Business tables: shared dataset for anon/authenticated/service_role ────
-- (identical explicit privilege lists; RLS is the actual boundary)
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.account_fund_entries TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.account_transactions TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.account_transfers TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.bank_accounts TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.financial_years TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.inventory_items TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.parties TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.party_documents TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.payment_modes TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.payments_in TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.payments_out TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.proforma_invoice_items TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.proforma_invoices TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.proforma_trade_ins TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.purchase_items TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.purchases TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.sale_items TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.sales TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.store TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.trade_ins TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.whatsapp_settings TO anon, authenticated, service_role;

-- ── System-owned job state: SELECT-only for the API roles ──────────────────
-- Written exclusively by the backend through service-role job RPCs.
GRANT SELECT, REFERENCES, TRIGGER
  ON TABLE public.message_jobs TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.message_jobs TO service_role;
GRANT SELECT, REFERENCES, TRIGGER
  ON TABLE public.reminder_settings TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.reminder_settings TO service_role;

-- ── public.users: least-privilege, no anon at all ───────────────────────────
-- The browser can never mutate roles/status/accounts: table-level SELECT
-- only for authenticated, plus the ONE column-level UPDATE (display_name).
-- service_role performs trusted owner administration.
REVOKE ALL ON TABLE public.users FROM anon, authenticated;
GRANT SELECT ON TABLE public.users TO authenticated;
GRANT UPDATE (display_name) ON TABLE public.users TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.users TO service_role;

-- ── schema_migrations: tooling-only, unreachable from the API ──────────────
REVOKE ALL ON TABLE public.schema_migrations FROM anon, authenticated, service_role;

-- ── Private helper functions ────────────────────────────────────────────────
-- Authorization predicates + validation helpers: revoked from
-- PUBLIC/anon; granted exactly where the policies/invoker RPCs
-- resolve them. jsonb_array_len keeps the default PUBLIC EXECUTE
-- (pure helper, no data access) — matching the live posture.
REVOKE ALL ON FUNCTION private.can_access_app() FROM PUBLIC;
GRANT ALL ON FUNCTION private.can_access_app() TO authenticated;

REVOKE ALL ON FUNCTION private.create_auto_receipt_job(text, uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION private.create_auto_receipt_job(text, uuid) TO authenticated;

REVOKE ALL ON FUNCTION private.handle_new_auth_user() FROM PUBLIC;

REVOKE ALL ON FUNCTION private.inventory_identity_validation() FROM PUBLIC;
GRANT ALL ON FUNCTION private.inventory_identity_validation() TO authenticated, service_role;

REVOKE ALL ON FUNCTION private.is_owner() FROM PUBLIC;
GRANT ALL ON FUNCTION private.is_owner() TO authenticated;

REVOKE ALL ON FUNCTION private.parties_phone_canonical() FROM PUBLIC;
GRANT ALL ON FUNCTION private.parties_phone_canonical() TO authenticated, service_role;

REVOKE ALL ON FUNCTION private.search_norm(text) FROM PUBLIC;
GRANT ALL ON FUNCTION private.search_norm(text) TO authenticated, service_role;

REVOKE ALL ON FUNCTION private.search_tokens(text) FROM PUBLIC;
GRANT ALL ON FUNCTION private.search_tokens(text) TO authenticated, service_role;

REVOKE ALL ON FUNCTION private.store_phone_canonical() FROM PUBLIC;
GRANT ALL ON FUNCTION private.store_phone_canonical() TO authenticated, service_role;

REVOKE ALL ON FUNCTION private.trim_users_display_name() FROM PUBLIC;

REVOKE ALL ON FUNCTION private.try_normalize_phone_in(text) FROM PUBLIC;
GRANT ALL ON FUNCTION private.try_normalize_phone_in(text) TO authenticated, service_role;

REVOKE ALL ON FUNCTION private.users_owner_invariant() FROM PUBLIC;

-- ── Public business RPCs ────────────────────────────────────────────────────
-- Application RPCs for the authenticated runtime + trusted backend.
-- (receive_payment / pay_purchase additionally keep the historical
-- anon grant — see the file header; both are RLS-protected.)
GRANT ALL ON FUNCTION public.add_funds(uuid, numeric, date, uuid, text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.cancel_sale(uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.cancel_sale(uuid) TO authenticated, service_role;
GRANT ALL ON FUNCTION public.close_financial_year(uuid) TO authenticated, service_role;
GRANT ALL ON FUNCTION public.complete_store_setup(jsonb) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.create_proforma(jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.create_proforma(jsonb) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.create_purchase(jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.create_purchase(jsonb) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.create_sale(jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.create_sale(jsonb) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.create_trade_in_purchase_bill(uuid, uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.create_trade_in_purchase_bill(uuid, uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.delete_sale(uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.delete_sale(uuid) TO authenticated, service_role;
GRANT ALL ON FUNCTION public.fy_end_year_2(public.financial_years) TO authenticated, service_role;
GRANT ALL ON FUNCTION public.fy_start_year_full(public.financial_years) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.messages_overview() FROM PUBLIC;
GRANT ALL ON FUNCTION public.messages_overview() TO authenticated, service_role;
GRANT ALL ON FUNCTION public.money_text(numeric) TO authenticated, service_role;
GRANT ALL ON FUNCTION public.pay_purchase(uuid, numeric, date, uuid, uuid) TO authenticated, service_role, anon;
GRANT ALL ON FUNCTION public.receive_payment(uuid, numeric, date, uuid, uuid) TO authenticated, service_role, anon;
GRANT ALL ON FUNCTION public.transfer_funds(uuid, uuid, numeric, date, uuid, text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.update_proforma(jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.update_proforma(jsonb) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.update_sale(jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.update_sale(jsonb) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.void_proforma(uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.void_proforma(uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.search_inventory(text, uuid, text, integer, integer, uuid[]) FROM PUBLIC;
GRANT ALL ON FUNCTION public.search_inventory(text, uuid, text, integer, integer, uuid[]) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.search_parties(text, integer, integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.search_parties(text, integer, integer) TO authenticated, service_role;

-- ── Message-job service RPCs: service_role ONLY ────────────────────────────
-- Job state is system-owned; the browser reads it (SELECT RLS)
-- but can never write it.
REVOKE ALL ON FUNCTION public.claim_due_message_jobs(text, integer, integer, uuid) FROM PUBLIC, anon, authenticated;
GRANT ALL ON FUNCTION public.claim_due_message_jobs(text, integer, integer, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.recover_expired_message_jobs() FROM PUBLIC, anon, authenticated;
GRANT ALL ON FUNCTION public.recover_expired_message_jobs() TO service_role;
REVOKE ALL ON FUNCTION public.complete_message_job(uuid, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT ALL ON FUNCTION public.complete_message_job(uuid, text, text, text) TO service_role;
REVOKE ALL ON FUNCTION public.upsert_reminder_config(uuid, boolean, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT ALL ON FUNCTION public.upsert_reminder_config(uuid, boolean, integer, integer) TO service_role;
REVOKE ALL ON FUNCTION public.trigger_reminder_now(uuid) FROM PUBLIC, anon, authenticated;
GRANT ALL ON FUNCTION public.trigger_reminder_now(uuid) TO service_role;

-- ── Default privileges for future objects (0004 posture restored) ──────────
-- Objects created later by the postgres role (future migrations)
-- in the public schema keep the same API grants automatically.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLES
  TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT SELECT, UPDATE, USAGE ON SEQUENCES
  TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS
  TO anon, authenticated, service_role;
