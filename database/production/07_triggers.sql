-- ============================================================
-- FUSION ONE — canonical production schema 07: triggers
-- ============================================================
-- The seven public-table triggers plus the auth provisioning
-- trigger:
--
--   inventory_items — sold-device identity freeze; strict IMEI/
--                     RAM-ROM validation on every touching write
--   parties         — phone canonicalization (+91, 10-digit)
--   store           — phone canonicalization (soft)
--   users           — display_name trim; never-zero-active-owners
--                     invariant (update + delete, WHEN-scoped)
--   auth.users      — on_auth_user_created: provisions
--                     public.users with NULL user_type
--                     (fail-closed — no access until the owner
--                     assigns a role)
--
-- Idempotent: DROP TRIGGER IF EXISTS before every CREATE.
-- ============================================================

DROP TRIGGER IF EXISTS trg_freeze_sold_item_identity ON public.inventory_items;
-- TRIGGER: inventory_items trg_freeze_sold_item_identity
CREATE TRIGGER trg_freeze_sold_item_identity BEFORE UPDATE ON public.inventory_items FOR EACH ROW EXECUTE FUNCTION private.freeze_sold_item_identity();

DROP TRIGGER IF EXISTS trg_inventory_identity_validation ON public.inventory_items;
-- TRIGGER: inventory_items trg_inventory_identity_validation
CREATE TRIGGER trg_inventory_identity_validation BEFORE INSERT OR UPDATE OF imei, ram_rom ON public.inventory_items FOR EACH ROW EXECUTE FUNCTION private.inventory_identity_validation();

DROP TRIGGER IF EXISTS trg_parties_phone_canonical ON public.parties;
-- TRIGGER: parties trg_parties_phone_canonical
CREATE TRIGGER trg_parties_phone_canonical BEFORE INSERT OR UPDATE OF number ON public.parties FOR EACH ROW EXECUTE FUNCTION private.parties_phone_canonical();

DROP TRIGGER IF EXISTS trg_store_phone_canonical ON public.store;
-- TRIGGER: store trg_store_phone_canonical
CREATE TRIGGER trg_store_phone_canonical BEFORE INSERT OR UPDATE OF phone ON public.store FOR EACH ROW EXECUTE FUNCTION private.store_phone_canonical();

DROP TRIGGER IF EXISTS users_display_name_trim ON public.users;
-- TRIGGER: users users_display_name_trim
CREATE TRIGGER users_display_name_trim BEFORE INSERT OR UPDATE OF display_name ON public.users FOR EACH ROW EXECUTE FUNCTION private.trim_users_display_name();

DROP TRIGGER IF EXISTS users_owner_invariant_delete ON public.users;
-- TRIGGER: users users_owner_invariant_delete
CREATE TRIGGER users_owner_invariant_delete BEFORE DELETE ON public.users FOR EACH ROW WHEN ((old.user_type = 'owner'::text)) EXECUTE FUNCTION private.users_owner_invariant();

DROP TRIGGER IF EXISTS users_owner_invariant_update ON public.users;
-- TRIGGER: users users_owner_invariant_update
CREATE TRIGGER users_owner_invariant_update BEFORE UPDATE OF user_type, status ON public.users FOR EACH ROW WHEN (((old.user_type = 'owner'::text) AND ((new.user_type IS DISTINCT FROM 'owner'::text) OR (new.status IS DISTINCT FROM 'active'::text)))) EXECUTE FUNCTION private.users_owner_invariant();

-- The auth provisioning trigger: lives on the platform-managed
-- auth.users table, executes the private helper. Part of the
-- application architecture (fail-closed provisioning); recreated
-- here because a public/private schema rebuild drops it with the
-- function it depends on. auth.users itself is NEVER modified.
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION private.handle_new_auth_user();
