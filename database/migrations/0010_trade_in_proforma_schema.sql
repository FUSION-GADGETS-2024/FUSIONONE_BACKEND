-- ============================================================
-- FUSIONONE — 0010 Trade-In + Proforma architectural redesign
--            (schema layer)
-- ============================================================
-- Domain model after this migration (see 0011 for the RPCs):
--
--   INVENTORY OWNS THE PHYSICAL DEVICE.
--   TRADE_IN OWNS THE TRANSACTIONAL RELATIONSHIP.
--
--   * trade_ins no longer stores a second copy of device identity
--     (brand/model/imei/ram_rom/color). It references the received
--     Inventory Item (inventory_item_id, NOT NULL) and stores only
--     the transaction facts: originating sale, credit value, quoted
--     MRP, supporting document.
--   * One physical device → one inventory identity. A trade-in
--     device received during a sale is created as an inventory_items
--     row (source='trade_in') exactly as before; trade_ins points at
--     it. The hidden PUR-TRD acquisition purchase + purchase_items
--     mapping are unchanged.
--   * proforma_invoice_items gains a nullable inventory_item_id: a
--     Proforma line either quotes a REAL in-stock Inventory Item
--     (new rows) or carries its historical free-text description
--     (legacy rows — never fabricated into inventory references).
--   * proforma_trade_ins is the honest PROPOSED trade-in model
--     (description/qty/rate/value) — no inventory identity until the
--     device is actually received at conversion.
--   * sales.proforma_id links a Sale to the Proforma it was converted
--     from. The partial UNIQUE index is the hard, database-enforced
--     duplicate-conversion guard (one Proforma → at most one Sale,
--     ever).
--   * inventory_items identity fields (brand/model/imei/ram_rom/
--     color) are frozen once the device is sold — enforced by
--     trigger, not by the frontend.
--
-- Deterministic + safe on an existing database:
--   * trade_ins rows (if any) are backfilled from
--     new_inventory_item_id before the old columns are dropped; rows
--     that cannot be mapped fail the migration LOUDLY (reviewable)
--     instead of fabricating data.
--   * No data is dropped except columns that are proven duplicates
--     (device identity) — and only after the authoritative copy
--     (inventory_items) is confirmed to exist for every row.
-- ============================================================

-- ─── 1. trade_ins: reference the received Inventory Item ───────────────────

-- 1a. Backfill guard: every legacy trade-in row must already point at
--     the inventory item that was created for it. A row without that
--     link cannot be migrated truthfully — stop loudly.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.trade_ins WHERE new_inventory_item_id IS NULL) THEN
    RAISE EXCEPTION 'trade_ins rows without new_inventory_item_id cannot be migrated (cannot fabricate inventory identity)';
  END IF;
END
$$;

-- 1b. New column + backfill + NOT NULL.
ALTER TABLE public.trade_ins
  ADD COLUMN inventory_item_id UUID REFERENCES public.inventory_items(id);

UPDATE public.trade_ins
   SET inventory_item_id = new_inventory_item_id;

ALTER TABLE public.trade_ins
  ALTER COLUMN inventory_item_id SET NOT NULL;

-- 1c. Drop the duplicated device identity + the legacy link column.
ALTER TABLE public.trade_ins
  DROP COLUMN brand,
  DROP COLUMN model,
  DROP COLUMN imei,
  DROP COLUMN ram_rom,
  DROP COLUMN color,
  DROP COLUMN new_inventory_item_id;

CREATE INDEX idx_trade_ins_inventory ON public.trade_ins(inventory_item_id);

-- ─── 2. sales: link to the originating Proforma ─────────────────────────────

ALTER TABLE public.sales
  ADD COLUMN proforma_id UUID REFERENCES public.proforma_invoices(id);

-- One Proforma can produce at most one Sale — ever. This is the
-- database-level idempotency/concurrency guarantee for conversion:
-- even two perfectly racing transactions cannot both insert.
CREATE UNIQUE INDEX idx_sales_proforma_unique
  ON public.sales (proforma_id)
  WHERE proforma_id IS NOT NULL;

-- ─── 3. proforma_invoice_items: quote real Inventory, keep legacy text ─────

ALTER TABLE public.proforma_invoice_items
  ADD COLUMN inventory_item_id UUID REFERENCES public.inventory_items(id);

ALTER TABLE public.proforma_invoice_items
  ALTER COLUMN description DROP NOT NULL;

-- A line is either an Inventory-backed quotation or a legacy free-text
-- line — never neither, never both.
ALTER TABLE public.proforma_invoice_items
  ADD CONSTRAINT proforma_item_source_check
  CHECK (
    (inventory_item_id IS NOT NULL AND description IS NULL)
    OR
    (inventory_item_id IS NULL AND description IS NOT NULL)
  );

CREATE INDEX idx_proforma_items_inventory
  ON public.proforma_invoice_items(inventory_item_id);

-- ─── 4. inventory_items: freeze identity once the device is sold ────────────
-- A sold device has participated in a completed transaction; its
-- identity is historical fact. Prices remain editable (they are
-- commercial, not physical). Status transitions (restock on cancel)
-- are unaffected — the trigger only fires when a sold device's
-- identity fields are modified.

CREATE OR REPLACE FUNCTION private.freeze_sold_item_identity()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF OLD.status = 'sold'
     AND (NEW.brand      IS DISTINCT FROM OLD.brand
       OR NEW.model      IS DISTINCT FROM OLD.model
       OR NEW.imei       IS DISTINCT FROM OLD.imei
       OR NEW.ram_rom    IS DISTINCT FROM OLD.ram_rom
       OR NEW.color      IS DISTINCT FROM OLD.color) THEN
    RAISE EXCEPTION 'Cannot change the identity of a sold device (% %, IMEI %). Identity fields are locked once a device is sold.',
      OLD.brand, OLD.model, OLD.imei;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_freeze_sold_item_identity
  BEFORE UPDATE ON public.inventory_items
  FOR EACH ROW
  EXECUTE FUNCTION private.freeze_sold_item_identity();
