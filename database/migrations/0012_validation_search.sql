-- ═══════════════════════════════════════════════════════════════════════════
-- 0012 — GLOBAL FIELD VALIDATION, NORMALIZATION, SEARCH & SALE INVARIANTS
--
-- Workstream 1 (validation):
--   * Canonical Indian-phone normalization for parties.number (strict:
--     valid input is REQUIRED, stored as +91XXXXXXXXXX) with a loud,
--     deterministic backfill guard.
--   * Soft canonicalization for store.phone (normalize when recognizable,
--     never reject — the business's own contact number is a display field).
--   * Strict IMEI (exactly 15 digits, nothing else) and RAM/ROM
--     (N/M numeric) validation on inventory_items, enforced at the ONE
--     boundary every write path crosses (direct insert, create_purchase,
--     create_sale trade-ins, FY carry-forward): a BEFORE INSERT OR UPDATE
--     OF <column> trigger. Legacy rows keep their historical values
--     (grandfathered) but any NEW imei/ram_rom value must conform — the
--     invariant fails loudly instead of rewriting history.
--
-- Workstream 2 (search):
--   * pg_trgm + normalized generated columns (brand_n/model_n/tokens_n/
--     search_n) + trigram GIN indexes.
--   * ONE canonical ranked inventory search RPC (search_inventory) and ONE
--     party search RPC (search_parties) — deterministic tiered relevance
--     (exact > prefix > token > contiguous > multi-token > fuzzy), never
--     letting weak fuzzy similarity outrank an obvious brand/model match.
--     Search normalization is a RETRIEVAL mechanism: canonical stored /
--     displayed values are never modified.
--
-- Workstream 3 (sale invariants):
--   * create_sale already enforces "at least one sale item" in BOTH modes
--     (0011); this migration hardens the remaining numeric holes:
--     purchase item/price/date validation (create_purchase previously
--     trusted the client for ALL of it) and proforma trade-in qty >= 1.
--
-- All changes additive or CREATE OR REPLACE; no data is rewritten except
-- the deterministic, audited phone canonicalization backfill.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── Extensions ────────────────────────────────────────────────────────────
-- pg_trgm: similarity() for the fuzzy tiers + gin_trgm_ops indexes that
-- keep LIKE '%q%' and similarity scans fast as inventory grows.
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;

-- ─── Canonical normalization helpers (IMMUTABLE — generated columns) ───────

-- Search normalization: lowercase + strip every non-alphanumeric char.
-- "OnePlus 12R" -> "oneplus12r"; "i phone 15" -> "iphone15"; "12/256" -> "12256".
-- Retrieval ONLY — the canonical displayed value is untouched.
CREATE OR REPLACE FUNCTION private.search_norm(v text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT lower(regexp_replace(coalesce(v, ''), '[^a-zA-Z0-9]', '', 'g'))
$$;

-- Token normalization: lowercase + collapse every non-alphanumeric run to a
-- single space. "OnePlus 12R 12/256 Black" -> "oneplus 12r 12 256 black".
-- Token boundaries survive so "every query token must prefix-match a device
-- token" is expressible.
CREATE OR REPLACE FUNCTION private.search_tokens(v text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT btrim(lower(regexp_replace(coalesce(v, ''), '[^a-zA-Z0-9]+', ' ', 'g')))
$$;

-- ─── Indian phone canonicalization ─────────────────────────────────────────
-- Recognized inputs (spaces, dashes, dots, parentheses are ignored):
--   9876543210            -> +919876543210   (10 digits, mobile 6-9)
--   91 9876543210         -> +919876543210   (91-prefixed, 12 digits)
--   +91 98765 43210       -> +919876543210
--   +919876543210         -> +919876543210
-- Anything else (letters mixed in, wrong length, non-Indian-mobile shape)
-- returns NULL — the caller decides whether NULL means REJECT (parties) or
-- PASS-THROUGH (store display field).
CREATE OR REPLACE FUNCTION private.try_normalize_phone_in(v text)
RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  digits text;
BEGIN
  IF v IS NULL THEN RETURN NULL; END IF;
  digits := regexp_replace(v, '[^0-9]', '', 'g');
  IF digits ~ '^[6-9][0-9]{9}$' THEN
    RETURN '+91' || digits;
  END IF;
  IF digits ~ '^91[6-9][0-9]{9}$' THEN
    RETURN '+' || digits;
  END IF;
  RETURN NULL;
END;
$$;

REVOKE EXECUTE ON FUNCTION private.search_norm(text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION private.search_tokens(text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION private.try_normalize_phone_in(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.search_norm(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.search_tokens(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.try_normalize_phone_in(text) TO authenticated, service_role;

-- ─── Parties: canonical phone (strict) ─────────────────────────────────────
-- DATA SAFETY: backfill FIRST, failing loudly if any existing non-empty
-- number cannot be canonically resolved — never silently rewriting or
-- dropping an unresolvable contact. On TEST every party number resolves.
DO $$
DECLARE
  unresolvable text;
BEGIN
  SELECT string_agg(number, ', ' ORDER BY created_at)
    INTO unresolvable
    FROM public.parties
   WHERE number IS NOT NULL
     AND btrim(number) <> ''
     AND private.try_normalize_phone_in(number) IS NULL;
  IF unresolvable IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot canonicalize party phone number(s): % — resolve or clear them before applying 0012', unresolvable;
  END IF;

  UPDATE public.parties
     SET number = private.try_normalize_phone_in(number)
   WHERE number IS NOT NULL
     AND btrim(number) <> ''
     AND number IS DISTINCT FROM private.try_normalize_phone_in(number);
END;
$$;

CREATE OR REPLACE FUNCTION private.parties_phone_canonical()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  canon text;
BEGIN
  IF NEW.number IS NULL OR btrim(NEW.number) = '' THEN
    NEW.number := NULL;   -- canonical empty is NULL, never ''
  ELSE
    canon := private.try_normalize_phone_in(NEW.number);
    IF canon IS NULL THEN
      RAISE EXCEPTION 'Invalid phone number "%": expected an Indian mobile number (10 digits, 91-prefixed, or +91-prefixed)', NEW.number
        USING ERRCODE = '23514';
    END IF;
    NEW.number := canon;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_parties_phone_canonical
BEFORE INSERT OR UPDATE OF number ON public.parties
FOR EACH ROW EXECUTE FUNCTION private.parties_phone_canonical();

-- ─── Store: phone soft canonicalization (display field) ────────────────────
-- The business's own number appears on documents; it may legitimately be a
-- landline or similar. Normalize the recognized Indian-mobile forms, keep
-- everything else verbatim (trimmed) — never block a settings save.
CREATE OR REPLACE FUNCTION private.store_phone_canonical()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  canon text;
BEGIN
  IF NEW.phone IS NOT NULL THEN
    NEW.phone := btrim(NEW.phone);
    IF NEW.phone <> '' THEN
      canon := private.try_normalize_phone_in(NEW.phone);
      IF canon IS NOT NULL THEN
        NEW.phone := canon;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_store_phone_canonical
BEFORE INSERT OR UPDATE OF phone ON public.store
FOR EACH ROW EXECUTE FUNCTION private.store_phone_canonical();

-- ─── Inventory: strict IMEI + RAM/ROM validation ───────────────────────────
-- Enforced at the ONE boundary every write path crosses. Grandfathering:
-- the trigger validates imei only on INSERT or when imei CHANGES, ram_rom
-- only on INSERT or when ram_rom CHANGES — legacy rows with pre-0012 values
-- remain editable (price/status/…) and are never silently rewritten; any
-- NEW value must conform and fails loudly otherwise.
--
-- IMEI: exactly 15 digits — no spaces, no +, no hyphens, no letters.
-- (Luhn deliberately NOT enforced: existing legitimate FUSION ONE data
--  contains valid 15-digit non-Luhn device IDs — audited before this
--  migration — so a Luhn rule would conflict with the real business model.)
-- RAM/ROM: "RAM/ROM" with numeric components, exactly one "/", no letters,
-- no spaces, neither side empty — "8/128", "12/256" valid;
-- "12 GB/256 GB", "12 / 256", "12-256", "/256", "12/" invalid.
CREATE OR REPLACE FUNCTION private.inventory_identity_validation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.imei IS DISTINCT FROM OLD.imei THEN
    NEW.imei := btrim(NEW.imei);
    IF NEW.imei IS NULL OR NEW.imei !~ '^[0-9]{15}$' THEN
      RAISE EXCEPTION 'IMEI "%" is invalid: it must be exactly 15 digits (no spaces, +, hyphens or letters)', coalesce(NEW.imei, '')
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF TG_OP = 'INSERT' OR NEW.ram_rom IS DISTINCT FROM OLD.ram_rom THEN
    IF NEW.ram_rom IS NOT NULL THEN
      NEW.ram_rom := btrim(NEW.ram_rom);
      IF NEW.ram_rom = '' THEN
        NEW.ram_rom := NULL;
      ELSIF NEW.ram_rom !~ '^[0-9]+/[0-9]+$' THEN
        RAISE EXCEPTION 'RAM/ROM "%" is invalid: expected RAM/ROM with numeric values, e.g. 8/128 or 12/256', NEW.ram_rom
          USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_inventory_identity_validation
BEFORE INSERT OR UPDATE OF imei, ram_rom ON public.inventory_items
FOR EACH ROW EXECUTE FUNCTION private.inventory_identity_validation();

REVOKE EXECUTE ON FUNCTION private.parties_phone_canonical() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION private.store_phone_canonical() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION private.inventory_identity_validation() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.parties_phone_canonical() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.store_phone_canonical() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.inventory_identity_validation() TO authenticated, service_role;

-- ─── Search normalization columns (generated, STORED) ──────────────────────
-- Retrieval-only projections of the canonical values; they never modify the
-- displayed/stored data and are maintained by Postgres itself.

ALTER TABLE public.inventory_items
  ADD COLUMN brand_n text GENERATED ALWAYS AS (private.search_norm(brand)) STORED,
  ADD COLUMN model_n text GENERATED ALWAYS AS (private.search_norm(model)) STORED,
  ADD COLUMN tokens_n text GENERATED ALWAYS AS (
    private.search_tokens(
      brand || ' ' || model || ' ' || imei || ' ' ||
      coalesce(ram_rom, '') || ' ' || coalesce(color, '')
    )
  ) STORED,
  ADD COLUMN search_n text GENERATED ALWAYS AS (
    private.search_norm(
      brand || ' ' || model || ' ' || imei || ' ' ||
      coalesce(ram_rom, '') || ' ' || coalesce(color, '')
    )
  ) STORED;

ALTER TABLE public.parties
  ADD COLUMN name_n text GENERATED ALWAYS AS (private.search_norm(name)) STORED,
  ADD COLUMN tokens_n text GENERATED ALWAYS AS (
    private.search_tokens(name || ' ' || coalesce(address, ''))
  ) STORED,
  ADD COLUMN search_n text GENERATED ALWAYS AS (
    private.search_norm(name || ' ' || coalesce(number, '') || ' ' || coalesce(address, ''))
  ) STORED;

-- ─── Search indexes ────────────────────────────────────────────────────────
-- Trigram GIN: serves prefix LIKE 'q%', contains LIKE '%q%' and similarity()
-- scans as inventory grows; composite FY+status btree serves the base scope.
CREATE INDEX idx_inventory_brand_n_trgm ON public.inventory_items USING gin (brand_n gin_trgm_ops);
CREATE INDEX idx_inventory_model_n_trgm ON public.inventory_items USING gin (model_n gin_trgm_ops);
CREATE INDEX idx_inventory_search_n_trgm ON public.inventory_items USING gin (search_n gin_trgm_ops);
CREATE INDEX idx_inventory_fy_status ON public.inventory_items (financial_year_id, status);

CREATE INDEX idx_parties_name_n_trgm ON public.parties USING gin (name_n gin_trgm_ops);
CREATE INDEX idx_parties_search_n_trgm ON public.parties USING gin (search_n gin_trgm_ops);

-- ─── Canonical inventory search (the ONE ranked search) ────────────────────
-- Deterministic tiered relevance; weak fuzzy can NEVER outrank an obvious
-- brand/model match because tiers are evaluated highest-first and the
-- trigram tiers only fire below 400:
--   1000 exact IMEI (query is a 15-digit IMEI)
--    950 IMEI prefix (>= 4 digits typed)
--    900 exact normalized field (brand or model)
--    800 field prefix            ("onep" -> OnePlus)
--    700 combined-field prefix
--    600 every query token prefix-matches a device token ("galaxy s24")
--    500 normalized contiguous substring ("oneplus12r" in "oneplus12r…")
--    400 every query token contained ("15 pro max" style multi-token)
--    300 strong trigram similarity (>= 0.45)
--    200 weak trigram similarity  (>= 0.22)
--    else excluded
-- Space-insensitive by construction: "one plus 12r" -> "oneplus12r".
-- SECURITY INVOKER: the caller's RLS applies (same posture as every
-- business RPC in this database).
CREATE OR REPLACE FUNCTION public.search_inventory(
  p_query text,
  p_financial_year_id uuid,
  p_status text DEFAULT 'in_stock',
  p_limit int DEFAULT 20,
  p_offset int DEFAULT 0,
  p_exclude_ids uuid[] DEFAULT '{}'
)
RETURNS TABLE (
  id uuid, brand text, model text, imei text, ram_rom text, color text,
  purchase_price numeric, base_selling_price numeric,
  status text, created_at timestamptz, rank int
)
LANGUAGE plpgsql STABLE AS $$
DECLARE
  q text := private.search_norm(p_query);
  qdigits text := regexp_replace(coalesce(p_query, ''), '[^0-9]', '', 'g');
  qtokens text[];
  has_tokens boolean;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 200 THEN
    RAISE EXCEPTION 'p_limit must be between 1 and 200';
  END IF;
  IF p_offset IS NULL OR p_offset < 0 THEN
    RAISE EXCEPTION 'p_offset must be >= 0';
  END IF;

  -- Browse mode (empty query): recent-first, scoped, no ranking.
  IF q = '' THEN
    RETURN QUERY
    SELECT i.id, i.brand, i.model, i.imei, i.ram_rom, i.color,
           i.purchase_price, i.base_selling_price, i.status, i.created_at, 0
      FROM public.inventory_items i
     WHERE i.financial_year_id = p_financial_year_id
       AND (p_status IS NULL OR p_status = '' OR p_status = 'all' OR i.status = p_status)
       AND NOT (i.id = ANY(p_exclude_ids))
     ORDER BY i.created_at DESC, i.id
     LIMIT p_limit OFFSET p_offset;
    RETURN;
  END IF;

  qtokens := ARRAY(
    SELECT private.search_norm(t)
      FROM unnest(string_to_array(private.search_tokens(p_query), ' ')) AS t
     WHERE private.search_norm(t) <> ''
  );
  has_tokens := coalesce(array_length(qtokens, 1), 0) > 0;

  RETURN QUERY
  WITH cand AS (
    SELECT i.*,
           CASE
             WHEN length(qdigits) = 15 AND i.imei = qdigits THEN 1000
             WHEN length(qdigits) >= 4 AND i.imei LIKE qdigits || '%' THEN 950
             WHEN i.brand_n = q OR i.model_n = q THEN 900
             WHEN i.brand_n LIKE q || '%' OR i.model_n LIKE q || '%' THEN 800
             WHEN i.search_n LIKE q || '%' THEN 700
             WHEN has_tokens AND (
                    SELECT bool_and(i.tokens_n ~ ('(^| )' || t))
                      FROM unnest(qtokens) AS t
                  ) THEN 600
             WHEN i.search_n LIKE '%' || q || '%' THEN 500
             WHEN has_tokens AND (
                    SELECT bool_and(i.search_n LIKE '%' || t || '%')
                      FROM unnest(qtokens) AS t
                  ) THEN 400
             WHEN greatest(similarity(i.brand_n, q), similarity(i.model_n, q),
                           similarity(i.search_n, q)) >= 0.45 THEN 300
             WHEN greatest(similarity(i.brand_n, q), similarity(i.model_n, q),
                           similarity(i.search_n, q)) >= 0.22 THEN 200
             ELSE 0
           END AS match_rank
      FROM public.inventory_items i
     WHERE i.financial_year_id = p_financial_year_id
       AND (p_status IS NULL OR p_status = '' OR p_status = 'all' OR i.status = p_status)
       AND NOT (i.id = ANY(p_exclude_ids))
  )
  SELECT c.id, c.brand, c.model, c.imei, c.ram_rom, c.color,
         c.purchase_price, c.base_selling_price, c.status, c.created_at, c.match_rank
    FROM cand c
   WHERE c.match_rank > 0
   ORDER BY c.match_rank DESC,
            greatest(similarity(c.brand_n, q), similarity(c.model_n, q),
                     similarity(c.search_n, q)) DESC,
            c.brand, c.model, c.imei
   LIMIT p_limit OFFSET p_offset;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.search_inventory(text, uuid, text, int, int, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.search_inventory(text, uuid, text, int, int, uuid[]) TO authenticated, service_role;

-- ─── Canonical party search (the ONE ranked party search) ──────────────────
-- Party semantics — NOT a copy of inventory ranking:
--   1000 exact phone (any supported input form matches the canonical store)
--    900 exact normalized name
--    800 name prefix
--    750 phone substring (>= 4 digits typed)
--    700 combined prefix
--    600 every token prefix-matches a name/address token
--    500 combined contiguous substring
--    400 every token contained
--    300 / 200 trigram similarity tiers
-- total_count = exact number of ranked matches (drives the combobox's
-- scroll pagination without a second round trip).
CREATE OR REPLACE FUNCTION public.search_parties(
  p_query text,
  p_limit int DEFAULT 20,
  p_offset int DEFAULT 0
)
RETURNS TABLE (
  id uuid, name text, number text, address text, rank int, total_count int
)
LANGUAGE plpgsql STABLE AS $$
DECLARE
  q text := private.search_norm(p_query);
  qdigits text := regexp_replace(coalesce(p_query, ''), '[^0-9]', '', 'g');
  qcanon text := private.try_normalize_phone_in(p_query);
  qtokens text[];
  has_tokens boolean;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 200 THEN
    RAISE EXCEPTION 'p_limit must be between 1 and 200';
  END IF;
  IF p_offset IS NULL OR p_offset < 0 THEN
    RAISE EXCEPTION 'p_offset must be >= 0';
  END IF;

  -- Browse mode (empty query): the plain name-ordered directory.
  IF q = '' AND qdigits = '' THEN
    RETURN QUERY
    SELECT p.id, p.name, p.number, p.address, 0,
           (SELECT count(*)::int FROM public.parties)
      FROM public.parties p
     ORDER BY p.name, p.id
     LIMIT p_limit OFFSET p_offset;
    RETURN;
  END IF;

  qtokens := ARRAY(
    SELECT private.search_norm(t)
      FROM unnest(string_to_array(private.search_tokens(p_query), ' ')) AS t
     WHERE private.search_norm(t) <> ''
  );
  has_tokens := coalesce(array_length(qtokens, 1), 0) > 0;

  RETURN QUERY
  WITH cand AS (
    SELECT p.*,
           CASE
             WHEN qcanon IS NOT NULL AND p.number = qcanon THEN 1000
             WHEN p.number = btrim(p_query) THEN 1000
             WHEN p.name_n = q THEN 900
             WHEN p.name_n LIKE q || '%' THEN 800
             WHEN length(qdigits) >= 4 AND p.number LIKE '%' || qdigits || '%' THEN 750
             WHEN p.search_n LIKE q || '%' THEN 700
             WHEN has_tokens AND (
                    SELECT bool_and(p.tokens_n ~ ('(^| )' || t))
                      FROM unnest(qtokens) AS t
                  ) THEN 600
             WHEN p.search_n LIKE '%' || q || '%' THEN 500
             WHEN has_tokens AND (
                    SELECT bool_and(p.search_n LIKE '%' || t || '%')
                      FROM unnest(qtokens) AS t
                  ) THEN 400
             WHEN greatest(similarity(p.name_n, q), similarity(p.search_n, q)) >= 0.45 THEN 300
             WHEN greatest(similarity(p.name_n, q), similarity(p.search_n, q)) >= 0.22 THEN 200
             ELSE 0
           END AS match_rank
      FROM public.parties p
  ), ranked AS (
    SELECT * FROM cand WHERE match_rank > 0
  )
  SELECT r.id, r.name, r.number, r.address, r.match_rank,
         count(*) OVER ()::int          -- total ranked matches (pre-LIMIT)
    FROM ranked r
   ORDER BY r.match_rank DESC,
            greatest(similarity(r.name_n, q), similarity(r.search_n, q)) DESC,
            r.name, r.id
   LIMIT p_limit OFFSET p_offset;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.search_parties(text, int, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.search_parties(text, int, int) TO authenticated, service_role;

-- ─── create_purchase: server-side field + money validation ─────────────────
-- Previously the RPC trusted the client for EVERYTHING: item identity,
-- prices, dates, totals. The frontend validated, the database did not.
-- Now (mirroring create_sale's posture, business behavior unchanged for
-- every legitimate request):
--   * the financial year must be ACTIVE and the date within it;
--   * every item needs brand/model/IMEI/RAM/ROM/color + valid IMEI format;
--   * no duplicate IMEI within the payload (previously only checked vs
--     in-stock, so a duplicated row died on the unique index with a
--     cryptic error);
--   * prices must be non-negative;
--   * total is recomputed server-side (sum of item purchase prices) and
--     due is derived (total - paid) — the client's copies are no longer
--     authoritative for stored data.
CREATE OR REPLACE FUNCTION public.create_purchase(payload jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  fy public.financial_years;
  sy text;
  ey text;
  elem jsonb;
  i integer;
  n integer;
  dup_imei text;
  purchase_id uuid;
  bill_no text;
  added_ids uuid[];
  v_total numeric;
  v_paid numeric;
BEGIN
  SELECT * INTO fy FROM public.financial_years WHERE id = (payload->>'financial_year_id')::uuid FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Financial year not found';
  END IF;
  IF fy.status <> 'active' THEN
    RAISE EXCEPTION 'Cannot operate on a closed financial year';
  END IF;

  IF (payload->>'date')::date IS NULL
     OR (payload->>'date')::date < fy.start_date
     OR (payload->>'date')::date > fy.end_date THEN
    RAISE EXCEPTION 'Date must be within the financial year (% to %)', fy.start_date, fy.end_date;
  END IF;

  n := private.jsonb_array_len(payload->'items');
  IF n = 0 THEN
    RAISE EXCEPTION 'A purchase requires at least one item';
  END IF;

  -- Per-item identity + price validation (fail BEFORE any write).
  FOR i IN 1 .. n LOOP
    elem := payload->'items'->(i - 1);
    IF btrim(coalesce(elem->>'brand', '')) = '' THEN
      RAISE EXCEPTION 'Brand is required on item %', i;
    END IF;
    IF btrim(coalesce(elem->>'model', '')) = '' THEN
      RAISE EXCEPTION 'Model is required on item %', i;
    END IF;
    IF btrim(coalesce(elem->>'imei', '')) = '' OR btrim(elem->>'imei') !~ '^[0-9]{15}$' THEN
      RAISE EXCEPTION 'IMEI on item % is invalid: it must be exactly 15 digits', i;
    END IF;
    IF btrim(coalesce(elem->>'ram_rom', '')) = '' THEN
      RAISE EXCEPTION 'RAM/ROM is required on item %', i;
    END IF;
    IF btrim(coalesce(elem->>'color', '')) = '' THEN
      RAISE EXCEPTION 'Color is required on item %', i;
    END IF;
    IF (elem->>'purchase_price')::numeric IS NULL OR (elem->>'purchase_price')::numeric < 0 THEN
      RAISE EXCEPTION 'Purchase price on item % must be a non-negative amount', i;
    END IF;
    IF (elem->>'base_selling_price')::numeric IS NULL OR (elem->>'base_selling_price')::numeric < 0 THEN
      RAISE EXCEPTION 'Base selling price on item % must be a non-negative amount', i;
    END IF;
  END LOOP;

  -- No duplicate IMEI within the payload itself.
  SELECT t.value->>'imei' INTO dup_imei
    FROM jsonb_array_elements(payload->'items') WITH ORDINALITY AS t(value, tord),
         jsonb_array_elements(payload->'items') WITH ORDINALITY AS u(value, uord)
   WHERE tord <> uord AND t.value->>'imei' = u.value->>'imei'
   LIMIT 1;
  IF dup_imei IS NOT NULL THEN
    RAISE EXCEPTION 'Duplicate IMEI % in the request', dup_imei;
  END IF;

  -- No IMEI already in stock (kept from the original RPC).
  -- (alias 'e' — the plpgsql variable 'elem' would shadow/collide)
  SELECT imei INTO dup_imei
    FROM public.inventory_items
   WHERE imei IN (SELECT btrim(e->>'imei') FROM jsonb_array_elements(payload->'items') AS e)
     AND status = 'in_stock'
   LIMIT 1;
  IF dup_imei IS NOT NULL THEN
    RAISE EXCEPTION 'IMEI % is already in stock in the database.', dup_imei;
  END IF;

  -- Server-authoritative totals (same values the form computes; the
  -- client's arithmetic is simply no longer trusted for storage).
  SELECT sum((e->>'purchase_price')::numeric) INTO v_total
    FROM jsonb_array_elements(payload->'items') AS e;
  v_paid := COALESCE(NULLIF(payload->>'paid', '')::numeric, 0);
  IF v_paid < 0 THEN
    RAISE EXCEPTION 'Paid amount cannot be negative';
  END IF;
  IF v_paid > v_total THEN
    RAISE EXCEPTION 'Paid amount cannot exceed the purchase total';
  END IF;

  -- Bill number + counter (format PUR-2026-27-0001).
  sy := public.fy_start_year_full(fy);
  ey := public.fy_end_year_2(fy);
  bill_no := 'PUR-' || sy || '-' || ey || '-' || lpad((fy.purchase_counter + 1)::text, 4, '0');

  UPDATE public.financial_years SET purchase_counter = fy.purchase_counter + 1 WHERE id = fy.id;

  INSERT INTO public.purchases (
    bill_number, party_id, total, paid, due, bank_account_id, payment_mode_id,
    date, financial_year_id, status
  ) VALUES (
    bill_no,
    (payload->>'party_id')::uuid,
    v_total,
    v_paid,
    v_total - v_paid,
    (payload->>'bank_account_id')::uuid,
    NULLIF(payload->>'payment_mode_id', '')::uuid,
    (payload->>'date')::date,
    fy.id,
    'active'
  ) RETURNING id INTO purchase_id;

  WITH ins AS (
    INSERT INTO public.inventory_items (
      brand, model, imei, ram_rom, color, purchase_price, base_selling_price,
      status, source, financial_year_id, opening_entry_type
    )
    SELECT btrim(e->>'brand'), btrim(e->>'model'), btrim(e->>'imei'),
           btrim(e->>'ram_rom'), btrim(e->>'color'),
           (e->>'purchase_price')::numeric, (e->>'base_selling_price')::numeric,
           'in_stock', 'purchase', fy.id, 'direct'
      FROM jsonb_array_elements(payload->'items') AS e
    RETURNING id
  )
  SELECT array_agg(id) INTO added_ids FROM ins;

  INSERT INTO public.purchase_items (purchase_id, inventory_item_id)
  SELECT purchase_id, unnest(added_ids);

  IF v_paid > 0 THEN
    INSERT INTO public.account_transactions (
      bank_account_id, payment_mode_id, type, amount, date,
      reference_type, reference_id, financial_year_id
    ) VALUES (
      (payload->>'bank_account_id')::uuid,
      NULLIF(payload->>'payment_mode_id', '')::uuid,
      'debit',
      v_paid,
      (payload->>'date')::date,
      'purchase',
      purchase_id,
      fy.id
    );

    INSERT INTO public.payments_out (
      purchase_id, party_id, amount, bank_account_id, payment_mode_id, date, financial_year_id
    ) VALUES (
      purchase_id,
      (payload->>'party_id')::uuid,
      v_paid,
      (payload->>'bank_account_id')::uuid,
      NULLIF(payload->>'payment_mode_id', '')::uuid,
      (payload->>'date')::date,
      fy.id
    );
  END IF;

  RETURN jsonb_build_object('purchase_id', purchase_id, 'bill_number', bill_no);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.create_purchase(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_purchase(jsonb) TO authenticated, service_role;

-- ─── Proforma proposed trade-ins: qty must be a positive integer ────────────
-- create_proforma / update_proforma previously accepted qty = 0 or negative
-- values (value = qty * rate flowed straight into the totals). One shared
-- check, applied to both — not a second implementation.
CREATE OR REPLACE FUNCTION public.create_proforma(payload jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  fy public.financial_years;
  sy text;
  ey text;
  bill_no text;
  proforma_id uuid;
  v_count integer;
  v_total numeric := 0;
  v_credit numeric := 0;
  v_final numeric;
  ti jsonb;
BEGIN
  SELECT * INTO fy FROM public.financial_years
   WHERE id = (payload->>'financial_year_id')::uuid FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Financial year not found';
  END IF;
  IF fy.status <> 'active' THEN
    RAISE EXCEPTION 'Cannot operate on a closed financial year';
  END IF;

  IF (payload->>'date')::date IS NULL
     OR (payload->>'date')::date < fy.start_date
     OR (payload->>'date')::date > fy.end_date THEN
    RAISE EXCEPTION 'Date must be within the financial year (% to %)', fy.start_date, fy.end_date;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.parties WHERE id = (payload->>'party_id')::uuid) THEN
    RAISE EXCEPTION 'Customer not found';
  END IF;

  IF COALESCE((payload->>'discount')::numeric, 0) < 0 THEN
    RAISE EXCEPTION 'Discount cannot be negative';
  END IF;

  IF private.jsonb_array_len(payload->'items') = 0 THEN
    RAISE EXCEPTION 'A quotation needs at least one item';
  END IF;

  SELECT count(*) INTO v_count
    FROM jsonb_array_elements(payload->'items') AS elem
     WHERE (elem->>'inventory_item_id')::uuid IS NULL
        OR (elem->>'rate')::numeric < 0;
  IF v_count > 0 THEN
    RAISE EXCEPTION 'Each quoted item needs an inventory item and a non-negative rate';
  END IF;

  SELECT count(*) INTO v_count
    FROM jsonb_array_elements(payload->'items') AS elem
     WHERE NOT EXISTS (
       SELECT 1 FROM public.inventory_items i
        WHERE i.id = (elem->>'inventory_item_id')::uuid
          AND i.status = 'in_stock'
          AND i.financial_year_id = fy.id
     );
  IF v_count > 0 THEN
    RAISE EXCEPTION 'One or more quoted items are no longer available in stock.';
  END IF;

  SELECT count(DISTINCT (elem->>'inventory_item_id')::uuid) INTO v_count
    FROM jsonb_array_elements(payload->'items') AS elem;
  IF v_count <> private.jsonb_array_len(payload->'items') THEN
    RAISE EXCEPTION 'The same device cannot be quoted twice';
  END IF;

  IF private.jsonb_array_len(payload->'trade_ins') > 0 THEN
    FOR ti IN SELECT * FROM jsonb_array_elements(payload->'trade_ins') LOOP
      IF btrim(COALESCE(ti->>'description', '')) = '' THEN
        RAISE EXCEPTION 'Trade-in description is required';
      END IF;
      IF (ti->>'rate')::numeric < 0 THEN
        RAISE EXCEPTION 'Trade-in rate cannot be negative';
      END IF;
      IF ti ? 'qty' AND NULLIF(ti->>'qty', '') IS NOT NULL
         AND (NULLIF(ti->>'qty', ''))::int < 1 THEN
        RAISE EXCEPTION 'Trade-in quantity must be a whole number of at least 1';
      END IF;
    END LOOP;
  END IF;

  sy := public.fy_start_year_full(fy);
  ey := public.fy_end_year_2(fy);
  bill_no := 'PI-' || sy || '-' || ey || '-' || lpad((fy.proforma_counter + 1)::text, 4, '0');

  UPDATE public.financial_years SET proforma_counter = fy.proforma_counter + 1 WHERE id = fy.id;

  INSERT INTO public.proforma_invoices (
    bill_number, party_id, total, discount, trade_in_credit, final_total,
    date, financial_year_id, status
  ) VALUES (
    bill_no,
    (payload->>'party_id')::uuid,
    0, 0, 0, 0,   -- placeholder, recomputed below in the same transaction
    (payload->>'date')::date,
    fy.id,
    'active'
  ) RETURNING id INTO proforma_id;

  INSERT INTO public.proforma_invoice_items (
    proforma_invoice_id, inventory_item_id, description, qty, rate, discount, value
  )
  SELECT proforma_id, (elem->>'inventory_item_id')::uuid, NULL, 1,
         (elem->>'rate')::numeric, 0, (elem->>'rate')::numeric
    FROM jsonb_array_elements(payload->'items') AS elem;

  IF jsonb_array_length(payload->'items') > 0 THEN
    SELECT sum(value) INTO v_total FROM public.proforma_invoice_items
     WHERE proforma_invoice_id = proforma_id;
  ELSE
    v_total := 0;
  END IF;

  IF private.jsonb_array_len(payload->'trade_ins') > 0 THEN
    INSERT INTO public.proforma_trade_ins (proforma_invoice_id, description, qty, rate, value)
    SELECT proforma_id, elem->>'description',
           COALESCE(NULLIF(elem->>'qty', '')::int, 1),
           (elem->>'rate')::numeric,
           COALESCE(NULLIF(elem->>'qty', '')::int, 1) * (elem->>'rate')::numeric
      FROM jsonb_array_elements(payload->'trade_ins') AS elem;
    SELECT sum(value) INTO v_credit FROM public.proforma_trade_ins
     WHERE proforma_invoice_id = proforma_id;
  END IF;

  v_final := GREATEST(0, v_total - COALESCE((payload->>'discount')::numeric, 0) - COALESCE(v_credit, 0));

  UPDATE public.proforma_invoices
     SET total = v_total,
         discount = COALESCE((payload->>'discount')::numeric, 0),
         trade_in_credit = COALESCE(v_credit, 0),
         final_total = v_final
   WHERE id = proforma_id;

  RETURN jsonb_build_object('proforma_id', proforma_id, 'bill_number', bill_no);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.create_proforma(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_proforma(jsonb) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.update_proforma(payload jsonb)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  p record;
  fy record;
  v_count integer;
  v_total numeric;
  v_credit numeric := 0;
  v_final numeric;
  ti jsonb;
BEGIN
  SELECT * INTO p FROM public.proforma_invoices
   WHERE id = (payload->>'proforma_id')::uuid FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Proforma not found';
  END IF;
  IF p.status <> 'active' THEN
    RAISE EXCEPTION 'Only an active proforma can be edited (current status: %)', p.status;
  END IF;

  SELECT * INTO fy FROM public.financial_years WHERE id = p.financial_year_id FOR UPDATE;
  IF fy.status <> 'active' THEN
    RAISE EXCEPTION 'Cannot edit a proforma in a closed financial year';
  END IF;

  IF (payload->>'date')::date IS NULL
     OR (payload->>'date')::date < fy.start_date
     OR (payload->>'date')::date > fy.end_date THEN
    RAISE EXCEPTION 'Date must be within the financial year (% to %)', fy.start_date, fy.end_date;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.parties WHERE id = (payload->>'party_id')::uuid) THEN
    RAISE EXCEPTION 'Customer not found';
  END IF;

  IF COALESCE((payload->>'discount')::numeric, 0) < 0 THEN
    RAISE EXCEPTION 'Discount cannot be negative';
  END IF;

  SELECT count(*) INTO v_count
    FROM jsonb_array_elements(payload->'items') AS elem
     WHERE (elem->>'inventory_item_id')::uuid IS NULL
        OR (elem->>'rate')::numeric < 0
        OR NOT EXISTS (
          SELECT 1 FROM public.inventory_items i
           WHERE i.id = (elem->>'inventory_item_id')::uuid
             AND i.status = 'in_stock'
             AND i.financial_year_id = fy.id
        );
  IF v_count > 0 THEN
    RAISE EXCEPTION 'One or more quoted items are no longer available in stock.';
  END IF;

  SELECT count(DISTINCT (elem->>'inventory_item_id')::uuid) INTO v_count
    FROM jsonb_array_elements(payload->'items') AS elem;
  IF v_count <> private.jsonb_array_len(payload->'items') THEN
    RAISE EXCEPTION 'The same device cannot be quoted twice';
  END IF;

  IF private.jsonb_array_len(payload->'items') = 0 THEN
    RAISE EXCEPTION 'A quotation needs at least one item';
  END IF;

  IF private.jsonb_array_len(payload->'trade_ins') > 0 THEN
    FOR ti IN SELECT * FROM jsonb_array_elements(payload->'trade_ins') LOOP
      IF btrim(COALESCE(ti->>'description', '')) = '' THEN
        RAISE EXCEPTION 'Trade-in description is required';
      END IF;
      IF (ti->>'rate')::numeric < 0 THEN
        RAISE EXCEPTION 'Trade-in rate cannot be negative';
      END IF;
      IF ti ? 'qty' AND NULLIF(ti->>'qty', '') IS NOT NULL
         AND (NULLIF(ti->>'qty', ''))::int < 1 THEN
        RAISE EXCEPTION 'Trade-in quantity must be a whole number of at least 1';
      END IF;
    END LOOP;
  END IF;

  DELETE FROM public.proforma_invoice_items WHERE proforma_invoice_id = p.id;
  DELETE FROM public.proforma_trade_ins WHERE proforma_invoice_id = p.id;

  INSERT INTO public.proforma_invoice_items (
    proforma_invoice_id, inventory_item_id, description, qty, rate, discount, value
  )
  SELECT p.id, (elem->>'inventory_item_id')::uuid, NULL, 1,
         (elem->>'rate')::numeric, 0, (elem->>'rate')::numeric
    FROM jsonb_array_elements(payload->'items') AS elem;

  SELECT sum(value) INTO v_total FROM public.proforma_invoice_items
   WHERE proforma_invoice_id = p.id;

  IF private.jsonb_array_len(payload->'trade_ins') > 0 THEN
    INSERT INTO public.proforma_trade_ins (proforma_invoice_id, description, qty, rate, value)
    SELECT p.id, elem->>'description',
           COALESCE(NULLIF(elem->>'qty', '')::int, 1),
           (elem->>'rate')::numeric,
           COALESCE(NULLIF(elem->>'qty', '')::int, 1) * (elem->>'rate')::numeric
      FROM jsonb_array_elements(payload->'trade_ins') AS elem;
    SELECT sum(value) INTO v_credit FROM public.proforma_trade_ins
     WHERE proforma_invoice_id = p.id;
  END IF;

  v_final := GREATEST(0, v_total - COALESCE((payload->>'discount')::numeric, 0) - COALESCE(v_credit, 0));

  UPDATE public.proforma_invoices
     SET party_id = (payload->>'party_id')::uuid,
         date = (payload->>'date')::date,
         discount = COALESCE((payload->>'discount')::numeric, 0),
         total = v_total,
         trade_in_credit = COALESCE(v_credit, 0),
         final_total = v_final
   WHERE id = p.id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.update_proforma(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_proforma(jsonb) TO authenticated, service_role;
