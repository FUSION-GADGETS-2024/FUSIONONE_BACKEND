-- ═══════════════════════════════════════════════════════════════════════════
-- 0013 — STRICT IDENTITY VALIDATION (remove the legacy grandfathering)
--
-- 0012 introduced trg_inventory_identity_validation with a deliberate
-- transition-period guard: legacy rows kept their pre-0012 values and
-- were validated only on INSERT or when the imei / ram_rom column
-- actually CHANGED (NEW IS DISTINCT FROM OLD). That guard existed
-- solely to accommodate non-conforming legacy data:
--
--   * the TEST project's intentionally invalid fixture rows (fake
--     "DBTIME…" / "TESTSEED…" IMEIs), and
--   * the two production RAM/ROM values ("256", "256GB") that the
--     controlled data migration accompanying this change corrects to
--     12/256 and 4/256.
--
-- Both databases now hold fully conforming inventory data, so the
-- guard is dead weight — a permanent exception production does not
-- need. This migration replaces the function with the intended FINAL
-- contract:
--
--   every write that touches the identity columns (any INSERT, any
--   UPDATE whose SET list includes imei or ram_rom) must carry a
--   VALID identity — unchanged values must be valid too. Nothing is
--   grandfathered.
--
-- Behavior is identical to 0012 for every conforming row (new values
-- were always validated); the only difference is that re-saving a
-- non-conforming value through an identity-touching write now fails
-- loudly instead of silently passing. Updates that do not list
-- imei/ram_rom never fire the trigger at all (prices, status
-- transitions and restocks are unaffected).
-- ═══════════════════════════════════════════════════════════════════════════

-- IMEI: exactly 15 digits — no spaces, no +, no hyphens, no letters.
-- (Luhn deliberately NOT enforced: existing legitimate FUSION ONE data
--  contains valid 15-digit non-Luhn device IDs — audited before
--  migration 0012 — so a Luhn rule would conflict with the real
--  business model.)
-- RAM/ROM: "RAM/ROM" with numeric components, exactly one "/", no
-- letters, no spaces, neither side empty — "8/128", "12/256" valid;
-- "12 GB/256 GB", "12 / 256", "12-256", "/256", "12/" invalid.
CREATE OR REPLACE FUNCTION private.inventory_identity_validation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.imei := btrim(NEW.imei);
  IF NEW.imei IS NULL OR NEW.imei !~ '^[0-9]{15}$' THEN
    RAISE EXCEPTION 'IMEI "%" is invalid: it must be exactly 15 digits (no spaces, +, hyphens or letters)', coalesce(NEW.imei, '')
      USING ERRCODE = '23514';
  END IF;

  IF NEW.ram_rom IS NOT NULL THEN
    NEW.ram_rom := btrim(NEW.ram_rom);
    IF NEW.ram_rom = '' THEN
      NEW.ram_rom := NULL;
    ELSIF NEW.ram_rom !~ '^[0-9]+/[0-9]+$' THEN
      RAISE EXCEPTION 'RAM/ROM "%" is invalid: expected RAM/ROM with numeric values, e.g. 8/128 or 12/256', NEW.ram_rom
          USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- ACL restated for self-documentation (CREATE OR REPLACE preserves it).
REVOKE EXECUTE ON FUNCTION private.inventory_identity_validation() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.inventory_identity_validation() TO authenticated, service_role;
