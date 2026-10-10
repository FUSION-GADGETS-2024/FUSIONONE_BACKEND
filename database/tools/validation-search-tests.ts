/**
 * FUSION ONE — Global Field Validation, Normalization, Search & Transaction
 * Integrity: database integration test suite (migration 0012).
 *
 * Runs against the TEST Supabase project ONLY (never production).
 * Creates its own isolated fixtures (FY/party/bank/inventory) far in the
 * future (FY 2032-33) so real business data is never touched, and removes
 * them at the end. Exit code is non-zero when any check fails.
 *
 * Coverage:
 *   A. Field validation at the DB boundary — IMEI (strict 15 digits),
 *      RAM/ROM (N/M), Indian phone canonicalization (parties strict,
 *      store soft), create_purchase hardening, proforma qty >= 1.
 *   B. Search — deterministic tiered ranking, space normalization,
 *      domain-aware fields (brand/model/IMEI/RAM-ROM), status scope,
 *      exclusions, pagination, party phone/name/address search.
 *   C. Sale/invoice invariants — at-least-one-product in both create_sale
 *      modes (incl. Proforma conversion), ₹0 final-total validity,
 *      trade-in ≠ product, atomic rejection (no partial state, no
 *      counter consumption).
 *   D. Security posture + no-touch verification of pre-existing data.
 *
 * Usage (from database/tools):
 *   bun run validation-search-tests.ts   # uses TEST_SUPABASE_DB_URL from .env
 */
import postgres from 'postgres'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

function loadEnv(): Record<string, string> {
  const raw = readFileSync(join(HERE, '.env'), 'utf8')
  return Object.fromEntries(
    raw.split('\n')
      .filter((l) => l.includes('=') && !l.startsWith('#'))
      .map((l) => {
        const i = l.indexOf('=')
        return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
      }),
  )
}

const env = loadEnv()
const DB_URL = process.env.FUSIONONE_DB_URL || env.TEST_SUPABASE_DB_URL
if (!DB_URL) throw new Error('Set FUSIONONE_DB_URL (or TEST_SUPABASE_DB_URL in database/tools/.env)')

const sql = postgres(DB_URL, { max: 4, prepare: false, idle_timeout: 5 })

let failures = 0
let passes = 0
function ok(condition: boolean, label: string, detail?: unknown): void {
  if (condition) {
    passes++
    console.log(`  PASS  ${label}`)
  } else {
    failures++
    console.log(`  FAIL  ${label}${detail !== undefined ? ` → ${JSON.stringify(detail)}` : ''}`)
  }
}

async function rpc(fn: string, params: Record<string, unknown>): Promise<any> {
  const entries = Object.entries(params)
  if (entries.length === 0) throw new Error('rpc helper expects at least one named parameter')
  const args = entries.map(([name], i) => `${name} := $${i + 1}`).join(', ')
  const rows = await sql.unsafe(
    `SELECT public.${fn}(${args}) AS result`, entries.map(([, v]) => v) as any,
  )
  return (rows as any[])[0]?.result
}

/** For SETOF/TABLE-returning RPCs: every row as JSON (the shape PostgREST
 *  returns to the app), aggregated in one round trip. */
async function rpcSetof(fn: string, params: Record<string, unknown>): Promise<any[]> {
  const entries = Object.entries(params)
  if (entries.length === 0) throw new Error('rpcSetof helper expects at least one named parameter')
  const args = entries.map(([name], i) => `${name} := $${i + 1}`).join(', ')
  const rows = await sql.unsafe(
    `SELECT coalesce(jsonb_agg(t), '[]'::jsonb) AS result FROM public.${fn}(${args}) AS t`,
    entries.map(([, v]) => v) as any,
  )
  return (rows as any[])[0]?.result ?? []
}

async function rpcFails(fn: string, params: Record<string, unknown>, expectText: string, label: string): Promise<void> {
  try {
    await rpc(fn, params)
    ok(false, `${label} (expected failure containing "${expectText}")`)
  } catch (e: any) {
    ok(String(e.message).includes(expectText), label, e.message)
  }
}

async function dbFails(label: string, expectText: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn()
    ok(false, `${label} (expected failure containing "${expectText}")`)
  } catch (e: any) {
    ok(String(e.message).includes(expectText), label, e.message)
  }
}

// Deterministic 15-digit IMEIs for fixtures (Luhn intentionally NOT required
// by the business contract — audited before 0012).
let imeiSeq = 710000000000010
const nextImei = () => String(imeiSeq++)

const FY_START = '2032-04-01'
const FY_END = '2033-03-31'
const CLOSED_FY_START = '2029-04-01'
const CLOSED_FY_END = '2030-03-31'

async function cleanupFixtures(fyIds: string[]): Promise<void> {
  if (fyIds.length === 0) return
  await sql`DELETE FROM public.inventory_items WHERE origin_inventory_item_id IN (
    SELECT id FROM public.inventory_items WHERE financial_year_id IN ${sql(fyIds)})`
  const sales = await sql`SELECT id FROM public.sales WHERE financial_year_id IN ${sql(fyIds)}`
  for (const s of sales) {
    await sql`DELETE FROM public.account_transactions WHERE reference_id = ${s.id} AND reference_type IN ('sale', 'sale_cancelled')`
    await sql`DELETE FROM public.payments_in WHERE sale_id = ${s.id}`
    await sql`DELETE FROM public.trade_ins WHERE sale_id = ${s.id}`
    await sql`DELETE FROM public.sale_items WHERE sale_id = ${s.id}`
  }
  await sql`DELETE FROM public.sales WHERE financial_year_id IN ${sql(fyIds)}`
  const purchases = await sql`SELECT id FROM public.purchases WHERE financial_year_id IN ${sql(fyIds)}`
  for (const p of purchases) {
    await sql`DELETE FROM public.account_transactions WHERE reference_id = ${p.id} AND reference_type IN ('purchase', 'purchase_cancelled')`
    await sql`DELETE FROM public.payments_out WHERE purchase_id = ${p.id}`
    await sql`DELETE FROM public.purchase_items WHERE purchase_id = ${p.id}`
  }
  await sql`DELETE FROM public.purchases WHERE financial_year_id IN ${sql(fyIds)}`
  const proformas = await sql`SELECT id FROM public.proforma_invoices WHERE financial_year_id IN ${sql(fyIds)}`
  for (const p of proformas) {
    await sql`DELETE FROM public.proforma_invoice_items WHERE proforma_invoice_id = ${p.id}`
    await sql`DELETE FROM public.proforma_trade_ins WHERE proforma_invoice_id = ${p.id}`
  }
  await sql`DELETE FROM public.proforma_invoices WHERE financial_year_id IN ${sql(fyIds)}`
  await sql`DELETE FROM public.inventory_items WHERE financial_year_id IN ${sql(fyIds)}`
  await sql`DELETE FROM public.financial_years WHERE id IN ${sql(fyIds)}`
}

async function main(): Promise<void> {
  console.log('FUSION ONE — validation / search / sale-invariant DB suite (TEST project only)\n')

  // ── Pre-clean any stale fixtures from prior runs ─────────────────────────
  const stale = await sql`SELECT id FROM public.financial_years
     WHERE start_date::text IN (${FY_START}, ${CLOSED_FY_START})`
  if (stale.length > 0) {
    console.log(`  (pre-cleanup: removing ${stale.length} stale fixture FYs from a prior run)`)
    await cleanupFixtures(stale.map((r: any) => r.id))
  }
  // Fixture parties are tagged by name prefix; remove leftovers FK-safely.
  await sql`DELETE FROM public.parties WHERE name LIKE 'VALSRCH %'`
  // Stale fixture bank accounts from prior runs (teardown leak fixed
  // 2026-10-07: each run used to leave one 'VALSRCH Cash' behind).
  await sql`DELETE FROM public.bank_accounts WHERE name = 'VALSRCH Cash'`

  // ══════════════════════════════════════════════════════════════════════
  console.log('── A. Field validation at the DB boundary ──────────────────────')
  // ══════════════════════════════════════════════════════════════════════

  const fy = await sql`INSERT INTO public.financial_years (start_date, end_date, status)
    VALUES (${FY_START}, ${FY_END}, 'active') RETURNING id`
  const fyId = fy[0].id as string
  const closedFy = await sql`INSERT INTO public.financial_years (start_date, end_date, status)
    VALUES (${CLOSED_FY_START}, ${CLOSED_FY_END}, 'closed') RETURNING id`
  const closedFyId = closedFy[0].id as string

  const bank = await sql`INSERT INTO public.bank_accounts (name, is_cash) VALUES ('VALSRCH Cash', true) RETURNING id`
  const bankId = bank[0].id as string
  const party = await sql`INSERT INTO public.parties (name, number, address)
    VALUES ('VALSRCH Main Customer', '9876543210', '12 Test Lane') RETURNING id, number`
  const partyId = party[0].id as string
  ok(party[0].number === '+919876543210', 'party insert canonicalizes 9876543210 → +919876543210', party[0].number)

  // ── A1. IMEI: strict 15-digit invariant ─────────────────────────────────
  const goodImei = nextImei()
  const ins = await sql`INSERT INTO public.inventory_items
    (brand, model, imei, ram_rom, color, purchase_price, base_selling_price, status, source, financial_year_id, opening_entry_type)
    VALUES ('OnePlus', '12R', ${goodImei}, '8/256', 'Black', 30000, 35000, 'in_stock', 'purchase', ${fyId}, 'direct')
    RETURNING imei, ram_rom`
  ok(ins[0].imei === goodImei, 'valid 15-digit IMEI accepted')

  const imeiBad: Array<[string, string]> = [
    ['12345678901234', '14 digits'],
    ['1234567890123456', '16 digits'],
    ['12345 6789012345', 'IMEI with spaces'],
    ['12345-6789012345', 'IMEI with hyphens'],
    ['+911234567890123', 'IMEI with +'],
    ['abc123456789012', 'IMEI with letters'],
    ['1234567890123a5', 'IMEI with a letter inside'],
    ['123456789012_45', 'IMEI with underscore'],
  ]
  for (const [bad, label] of imeiBad) {
    await dbFails(`reject ${label}`, 'exactly 15 digits', () =>
      sql`INSERT INTO public.inventory_items
        (brand, model, imei, ram_rom, color, purchase_price, base_selling_price, status, source, financial_year_id, opening_entry_type)
        VALUES ('X', 'Y', ${bad}, '8/128', 'Black', 1, 1, 'in_stock', 'purchase', ${fyId}, 'direct')`)
  }
  // Whitespace-only padding is trimmed, then validated.
  const trimmed = await sql`INSERT INTO public.inventory_items
    (brand, model, imei, ram_rom, color, purchase_price, base_selling_price, status, source, financial_year_id, opening_entry_type)
    VALUES ('X', 'TrimTest', ${'  ' + goodImei.slice(0, 14) + '7  '}, '8/128', 'Black', 1, 1, 'in_stock', 'purchase', ${fyId}, 'direct')
    RETURNING imei`
  ok(trimmed[0].imei === goodImei.slice(0, 14) + '7', 'IMEI is trimmed before validation/storage')
  await sql`DELETE FROM public.inventory_items WHERE brand = 'X' AND model = 'TrimTest'`

  // UPDATE paths: changing imei validates; other-column updates do not
  // (legacy grandfathering).
  await dbFails('reject UPDATE to invalid IMEI', 'exactly 15 digits', () =>
    sql`UPDATE public.inventory_items SET imei = '12345' WHERE imei = ${goodImei}`)
  const newImei = nextImei()
  await sql`UPDATE public.inventory_items SET imei = ${newImei} WHERE imei = ${goodImei}`
  ok(true, 'accept UPDATE to another valid IMEI')
  await sql`UPDATE public.inventory_items SET base_selling_price = 35500 WHERE imei = ${newImei}`
  ok(true, 'price update does not re-validate unchanged IMEI')

  // ── A2. RAM/ROM: N/M numeric invariant ──────────────────────────────────
  const rrGood = ['4/64', '6/128', '8/256', '12/256', '16/512']
  for (const rr of rrGood) {
    const r = await sql`INSERT INTO public.inventory_items
      (brand, model, imei, ram_rom, color, purchase_price, base_selling_price, status, source, financial_year_id, opening_entry_type)
      VALUES ('RR', ${rr.replace('/', '-')}, ${nextImei()}, ${rr}, 'Black', 1, 1, 'in_stock', 'purchase', ${fyId}, 'direct')
      RETURNING ram_rom`
    ok(r[0].ram_rom === rr, `accept RAM/ROM ${rr}`)
  }
  const rrBad = ['12 GB/256 GB', '12 / 256', '12-256', '12\\256', '12/256GB', '/256', '12/', 'abc/256', '12//256', '12/256/512']
  for (const rr of rrBad) {
    await dbFails(`reject RAM/ROM "${rr}"`, 'RAM/ROM', () =>
      sql`INSERT INTO public.inventory_items
        (brand, model, imei, ram_rom, color, purchase_price, base_selling_price, status, source, financial_year_id, opening_entry_type)
        VALUES ('RR', 'Bad', ${nextImei()}, ${rr}, 'Black', 1, 1, 'in_stock', 'purchase', ${fyId}, 'direct')`)
  }
  const rrTrim = await sql`INSERT INTO public.inventory_items
    (brand, model, imei, ram_rom, color, purchase_price, base_selling_price, status, source, financial_year_id, opening_entry_type)
    VALUES ('RR', 'Trim', ${nextImei()}, ${'  8/128  '}, 'Black', 1, 1, 'in_stock', 'purchase', ${fyId}, 'direct')
    RETURNING ram_rom`
  ok(rrTrim[0].ram_rom === '8/128', 'RAM/ROM trimmed to canonical form')
  const rrNull = await sql`INSERT INTO public.inventory_items
    (brand, model, imei, ram_rom, color, purchase_price, base_selling_price, status, source, financial_year_id, opening_entry_type)
    VALUES ('RR', 'NullRR', ${nextImei()}, NULL, 'Black', 1, 1, 'in_stock', 'purchase', ${fyId}, 'direct')
    RETURNING ram_rom`
  ok(rrNull[0].ram_rom === null, 'RAM/ROM NULL allowed (column is nullable)')

  // ── A3. Phone: canonical Indian normalization ───────────────────────────
  const phoneGood: Array<[string, string]> = [
    ['9876543211', 'bare 10-digit'],
    ['919876543211', '91-prefixed'],
    ['+919876543211', '+91-prefixed'],
    ['91 9876543211', 'spaced 91'],
    ['+91 9876543211', 'spaced +91'],
    ['+91 98765 43211', 'fully spaced +91'],
    ['98765 43211', 'spaced 10-digit'],
  ]
  for (const [input, label] of phoneGood) {
    const r = await sql`INSERT INTO public.parties (name, number) VALUES (${'VALSRCH ' + label}, ${input}) RETURNING number`
    ok(r[0].number === '+919876543211', `phone ${label} → +919876543211`, r[0].number)
  }
  const phoneBad = ['+1 555 1234', 'abcdefghij', '12345', '09876543210', '987654321123456', '910123456789', '+91 0123456789']
  for (const input of phoneBad) {
    await dbFails(`reject phone "${input}"`, 'Invalid phone number', () =>
      sql`INSERT INTO public.parties (name, number) VALUES ('VALSRCH badphone', ${input})`)
  }
  const emptyPhone = await sql`INSERT INTO public.parties (name, number) VALUES ('VALSRCH empty phone', '   ') RETURNING number`
  ok(emptyPhone[0].number === null, 'blank phone stored as NULL')
  const updPhone = await sql`UPDATE public.parties SET number = '91 90000 00001' WHERE name = 'VALSRCH empty phone' RETURNING number`
  ok(updPhone[0].number === '+919000000001', 'phone UPDATE canonicalizes too')
  // Duplicate numbers remain allowed (no unique constraint — deliberate).
  const dup = await sql`INSERT INTO public.parties (name, number) VALUES ('VALSRCH dup phone', '9000000001') RETURNING number`
  ok(dup[0].number === '+919000000001', 'duplicate number allowed (no uniqueness rule)')
  // Store phone: soft canonicalization (recognized → canonical, else kept).
  const origStorePhone = (await sql`SELECT phone FROM public.store WHERE singleton = 1`)[0].phone as string
  await sql`UPDATE public.store SET phone = '98765 43210' WHERE singleton = 1`
  let storePhone = (await sql`SELECT phone FROM public.store WHERE singleton = 1`)[0].phone as string
  ok(storePhone === '+919876543210', 'store phone soft-canonicalized when recognizable', storePhone)
  await sql`UPDATE public.store SET phone = '0551 223 3445' WHERE singleton = 1`
  storePhone = (await sql`SELECT phone FROM public.store WHERE singleton = 1`)[0].phone as string
  ok(storePhone === '0551 223 3445', 'store landline-style number kept verbatim (display field)', storePhone)
  await sql`UPDATE public.store SET phone = ${origStorePhone} WHERE singleton = 1`
  storePhone = (await sql`SELECT phone FROM public.store WHERE singleton = 1`)[0].phone as string
  ok(true, `store phone restored (${storePhone})`)

  const idByImei = async (imei: string): Promise<string> =>
    (await sql`SELECT id FROM public.inventory_items WHERE imei = ${imei} AND financial_year_id = ${fyId}`)[0].id as string

  // ── A4. create_purchase: server-side validation + totals ────────────────
  const p1 = nextImei()
  const p2 = nextImei()
  const created = await rpc('create_purchase', {
    payload: {
      financial_year_id: fyId, party_id: partyId, date: '2032-06-15',
      items: [
        { brand: 'ValSrc', model: 'P1', imei: p1, ram_rom: '8/128', color: 'Black', purchase_price: 1000, base_selling_price: 1200 },
        { brand: 'ValSrc', model: 'P2', imei: p2, ram_rom: '8/256', color: 'White', purchase_price: 2000, base_selling_price: 2400 },
      ],
      total: 9999, paid: 1500, due: 8499,   // wrong client totals on purpose
      bank_account_id: bankId, payment_mode_id: '',
    },
  })
  const createdRow = await sql`SELECT total, paid, due FROM public.purchases WHERE id = ${created.purchase_id}`
  ok(Number(createdRow[0].total) === 3000, 'purchase total is SERVER-recomputed (3000, not client 9999)', createdRow[0].total)
  ok(Number(createdRow[0].due) === 1500, 'purchase due derived server-side (total - paid)')
  const payTx = await sql`SELECT count(*)::int AS n FROM public.account_transactions WHERE reference_id = ${created.purchase_id} AND reference_type = 'purchase'`
  ok(payTx[0].n === 1, 'purchase payment recorded when paid > 0')

  await rpcFails('create_purchase', {
    payload: { financial_year_id: fyId, party_id: partyId, date: '2032-06-15', items: [], total: 0, paid: 0, due: 0, bank_account_id: bankId, payment_mode_id: '' },
  }, 'at least one item', 'create_purchase rejects zero items')

  await rpcFails('create_purchase', {
    payload: {
      financial_year_id: fyId, party_id: partyId, date: '2032-06-15',
      items: [{ brand: 'B', model: 'M', imei: '12345', ram_rom: '8/128', color: 'C', purchase_price: 1, base_selling_price: 1 }],
      total: 1, paid: 0, due: 1, bank_account_id: bankId, payment_mode_id: '',
    },
  }, 'exactly 15 digits', 'create_purchase rejects malformed IMEI')

  const dupPayloadImei = nextImei()
  await rpcFails('create_purchase', {
    payload: {
      financial_year_id: fyId, party_id: partyId, date: '2032-06-15',
      items: [
        { brand: 'B', model: 'M', imei: dupPayloadImei, ram_rom: '8/128', color: 'C', purchase_price: 1, base_selling_price: 1 },
        { brand: 'B', model: 'M2', imei: dupPayloadImei, ram_rom: '8/128', color: 'C', purchase_price: 1, base_selling_price: 1 },
      ],
      total: 2, paid: 0, due: 2, bank_account_id: bankId, payment_mode_id: '',
    },
  }, 'Duplicate IMEI', 'create_purchase rejects duplicate IMEI within payload')

  await rpcFails('create_purchase', {
    payload: {
      financial_year_id: fyId, party_id: partyId, date: '2032-06-15',
      items: [{ brand: 'B', model: 'M', imei: p1, ram_rom: '8/128', color: 'C', purchase_price: 1, base_selling_price: 1 }],
      total: 1, paid: 0, due: 1, bank_account_id: bankId, payment_mode_id: '',
    },
  }, 'already in stock', 'create_purchase rejects IMEI already in stock')

  await rpcFails('create_purchase', {
    payload: {
      financial_year_id: fyId, party_id: partyId, date: '2032-06-15',
      items: [{ brand: 'B', model: 'M', imei: nextImei(), ram_rom: '8/128', color: 'C', purchase_price: -5, base_selling_price: 1 }],
      total: -5, paid: 0, due: -5, bank_account_id: bankId, payment_mode_id: '',
    },
  }, 'non-negative', 'create_purchase rejects negative price')

  await rpcFails('create_purchase', {
    payload: {
      financial_year_id: fyId, party_id: partyId, date: '2032-06-15',
      items: [{ brand: 'B', model: 'M', imei: nextImei(), ram_rom: '8/128', color: 'C', purchase_price: 100, base_selling_price: 120 }],
      total: 100, paid: 500, due: -400, bank_account_id: bankId, payment_mode_id: '',
    },
  }, 'cannot exceed', 'create_purchase rejects paid > total')

  await rpcFails('create_purchase', {
    payload: {
      financial_year_id: fyId, party_id: partyId, date: '2031-02-01',
      items: [{ brand: 'B', model: 'M', imei: nextImei(), ram_rom: '8/128', color: 'C', purchase_price: 100, base_selling_price: 120 }],
      total: 100, paid: 0, due: 100, bank_account_id: bankId, payment_mode_id: '',
    },
  }, 'within the financial year', 'create_purchase rejects out-of-FY date')

  await rpcFails('create_purchase', {
    payload: {
      financial_year_id: closedFyId, party_id: partyId, date: '2029-06-15',
      items: [{ brand: 'B', model: 'M', imei: nextImei(), ram_rom: '8/128', color: 'C', purchase_price: 100, base_selling_price: 120 }],
      total: 100, paid: 0, due: 100, bank_account_id: bankId, payment_mode_id: '',
    },
  }, 'closed financial year', 'create_purchase rejects closed FY')

  const fyCountersAfter = await sql`SELECT purchase_counter, sale_counter, proforma_counter FROM public.financial_years WHERE id = ${fyId}`
  ok(Number(fyCountersAfter[0].purchase_counter) === 1, 'failed purchases consumed no counters (only the 1 successful one)')

  // ── A5. Proforma proposed trade-in qty >= 1 ─────────────────────────────
  const quoteImei = nextImei()
  await sql`INSERT INTO public.inventory_items
    (brand, model, imei, ram_rom, color, purchase_price, base_selling_price, status, source, financial_year_id, opening_entry_type)
    VALUES ('OnePlus', '13', ${quoteImei}, '12/256', 'Black', 40000, 45000, 'in_stock', 'purchase', ${fyId}, 'direct')`
  await rpcFails('create_proforma', {
    payload: {
      financial_year_id: fyId, party_id: partyId, date: '2032-06-15', discount: 0,
      items: [{ inventory_item_id: await idByImei(quoteImei), rate: 100 }],
      trade_ins: [{ description: 'Old phone', qty: 0, rate: 500 }],
    },
  }, 'whole number of at least 1', 'create_proforma rejects qty 0')
  await rpcFails('create_proforma', {
    payload: {
      financial_year_id: fyId, party_id: partyId, date: '2032-06-15', discount: 0,
      items: [{ inventory_item_id: await idByImei(quoteImei), rate: 100 }],
      trade_ins: [{ description: 'Old phone', qty: -2, rate: 500 }],
    },
  }, 'whole number of at least 1', 'create_proforma rejects negative qty')

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n── B. Search: ranking, normalization, domain awareness ─────────')
  // ══════════════════════════════════════════════════════════════════════

  // Controlled device fixture set (all in_stock unless noted).
  interface Dev { brand: string; model: string; imei: string; ram: string; color: string }
  const devs: Dev[] = [
    { brand: 'OnePlus', model: '12R', imei: nextImei(), ram: '8/256', color: 'Black' },
    { brand: 'OnePlus', model: '13', imei: nextImei(), ram: '12/256', color: 'Silver' },
    { brand: 'OnePlus', model: 'Nord CE4', imei: nextImei(), ram: '8/128', color: 'Blue' },
    { brand: 'Apple', model: 'iPhone 15 Pro Max', imei: nextImei(), ram: '8/256', color: 'Titanium' },
    { brand: 'Apple', model: 'iPhone 14', imei: nextImei(), ram: '6/128', color: 'Blue' },
    { brand: 'Samsung', model: 'Galaxy S24', imei: nextImei(), ram: '8/256', color: 'Violet' },
    { brand: 'Xiaomi', model: 'Redmi Note 13', imei: nextImei(), ram: '6/128', color: 'Phantom Black' },
  ]
  const devIds: Record<string, string> = {}
  for (const d of devs) {
    const r = await sql`INSERT INTO public.inventory_items
      (brand, model, imei, ram_rom, color, purchase_price, base_selling_price, status, source, financial_year_id, opening_entry_type)
      VALUES (${d.brand}, ${d.model}, ${d.imei}, ${d.ram}, ${d.color}, 1000, 1500, 'in_stock', 'purchase', ${fyId}, 'direct')
      RETURNING id`
    devIds[d.model] = r[0].id as string
  }
  // A SOLD OnePlus 12 — search must respect the status scope.
  const sold12 = await sql`INSERT INTO public.inventory_items
    (brand, model, imei, ram_rom, color, purchase_price, base_selling_price, status, source, financial_year_id, opening_entry_type)
    VALUES ('OnePlus', '12', ${nextImei()}, '8/256', 'Green', 1000, 1500, 'sold', 'purchase', ${fyId}, 'direct')
    RETURNING id`
  const sold12Id = sold12[0].id as string

  const search = async (q: string, status: string | null = 'in_stock', limit = 20) =>
    (await rpcSetof('search_inventory', {
      p_query: q, p_financial_year_id: fyId, p_status: status, p_limit: limit, p_offset: 0, p_exclude_ids: [],
    })) as any[]
  const models = (rows: any[]) => rows.map(r => `${r.brand} ${r.model}`)

  // B1. The "onep" complaint: OnePlus above/instead of iPhones.
  let rows = await search('onep')
  ok(rows.length > 0 && rows.every(r => r.brand === 'OnePlus'), '"onep" returns ONLY OnePlus devices', models(rows))
  ok(rows.every(r => r.rank >= 800), '"onep" OnePlus results are prefix-tier (>= 800), not fuzzy', rows.map(r => r.rank))
  rows = await search('one')
  const onePlusIdx = models(rows).findIndex(m => m.startsWith('OnePlus'))
  const iphoneIdx = models(rows).findIndex(m => m.includes('iPhone'))
  ok(rows.some(r => r.brand === 'OnePlus'), '"one" still finds OnePlus mid-typing')
  if (iphoneIdx >= 0) ok(onePlusIdx < iphoneIdx, '"one": OnePlus ranks ABOVE iPhone (prefix > interior substring)', models(rows))

  // B2. Space normalization.
  for (const q of ['one plus', 'oneplus', 'oneplus12r', 'one plus 12r']) {
    rows = await search(q)
    ok(rows.some(r => r.model === '12R'), `query "${q}" finds OnePlus 12R (space-insensitive)`, models(rows))
  }
  ok((await search('oneplus 12r'))[0]?.model === '12R', '"oneplus 12r" ranks OnePlus 12R first', models(await search('oneplus 12r')))

  // B3. iPhone side.
  for (const q of ['iphone', 'i phone']) {
    rows = await search(q)
    ok(rows.length > 0 && rows.every(r => r.brand === 'Apple'), `query "${q}" finds iPhones`, models(rows))
  }
  rows = await search('iphone15')
  ok(rows.length >= 1 && rows[0].model === 'iPhone 15 Pro Max' && rows[0].rank >= 800
    && rows.slice(1).every(r => r.rank < rows[0].rank),
    '"iphone15" (no space) ranks iPhone 15 Pro Max first (fuzzy matches rank below it)', models(rows))
  rows = await search('15 pro max')
  ok(rows.length >= 1 && rows[0].model === 'iPhone 15 Pro Max', '"15 pro max" multi-token finds iPhone 15 Pro Max first', models(rows))

  // B4. Samsung prefix.
  for (const q of ['samsung', 'sams']) {
    rows = await search(q)
    ok(rows.length === 1 && rows[0].brand === 'Samsung', `query "${q}" finds the Samsung`, models(rows))
  }
  rows = await search('galaxy s24')
  ok(rows.length === 1 && rows[0].model === 'Galaxy S24', '"galaxy s24" token-prefix finds Galaxy S24', models(rows))

  // B5. IMEI search — exact and prefix.
  rows = await search(devs[0].imei)
  ok(rows.length === 1 && rows[0].imei === devs[0].imei && rows[0].rank === 1000, 'exact IMEI search, rank 1000')
  rows = await search(devs[0].imei.slice(0, 8))
  ok(rows.some(r => r.imei === devs[0].imei) && rows.find(r => r.imei === devs[0].imei)!.rank === 950, 'IMEI prefix search, rank 950')

  // B6. RAM/ROM query sanity — "256" returns 256GB devices, not noise.
  rows = await search('256')
  ok(rows.length > 0 && rows.every(r => r.ram_rom.endsWith('/256')), '"256" returns only /256 devices', models(rows))
  rows = await search('12256')
  ok(rows.length > 0 && rows.filter(r => r.rank >= 400).every(r => r.ram_rom === '12/256'),
    '"12256" (12/256 normalized): every strong match is a 12/256 device; weaker fuzzy matches rank below',
    rows.map(r => [`${r.brand} ${r.model}`, r.ram_rom, r.rank]))

  // B7. Status scope + exclusions + pagination determinism.
  rows = await search('oneplus')
  ok(!rows.some(r => r.id === sold12Id), 'default in_stock scope excludes sold OnePlus 12')
  rows = await search('oneplus', 'sold')
  ok(rows.length === 1 && rows[0].id === sold12Id, 'sold scope returns only the sold device')
  rows = await search('oneplus', null)
  const onePlusAll = (await sql`SELECT count(*)::int AS n FROM public.inventory_items WHERE financial_year_id = ${fyId} AND brand = 'OnePlus'`)[0].n
  ok(rows.some(r => r.id === sold12Id) && rows.length === onePlusAll,
    'null status = all statuses (every OnePlus device incl. sold)', { got: rows.length, want: onePlusAll })
  const excl = await rpcSetof('search_inventory', {
    p_query: 'oneplus', p_financial_year_id: fyId, p_status: 'in_stock', p_limit: 20, p_offset: 0,
    p_exclude_ids: [devIds['12R']],
  }) as any[]
  ok(!excl.some(r => r.id === devIds['12R']) && excl.every(r => r.brand === 'OnePlus'),
    'p_exclude_ids removes the excluded row (remaining are all OnePlus)', models(excl))
  const page1 = await rpcSetof('search_inventory', {
    p_query: 'one', p_financial_year_id: fyId, p_status: 'in_stock', p_limit: 2, p_offset: 0, p_exclude_ids: [],
  }) as any[]
  const page2 = await rpcSetof('search_inventory', {
    p_query: 'one', p_financial_year_id: fyId, p_status: 'in_stock', p_limit: 2, p_offset: 2, p_exclude_ids: [],
  }) as any[]
  ok(page1.length === 2 && page2.length >= 0 && !page2.some(r => page1.some(p => p.id === r.id)), 'limit/offset pagination is stable and non-overlapping')
  const r1 = await search('oneplus')
  const r2 = await search('oneplus')
  ok(JSON.stringify(r1.map(x => x.id)) === JSON.stringify(r2.map(x => x.id)), 'ranking is deterministic across identical queries')

  // B8. Search never modifies stored values.
  const after = await sql`SELECT brand, model, imei, ram_rom, color FROM public.inventory_items WHERE imei = ${devs[0].imei}`
  ok(after[0].brand === 'OnePlus' && after[0].model === '12R' && after[0].imei === devs[0].imei
    && after[0].ram_rom === '8/256' && after[0].color === 'Black', 'stored/displayed values unchanged by searching')

  // B9. Party search — canonical phone, name, address.
  await sql`INSERT INTO public.parties (name, number, address) VALUES ('VALSRCH OnePlus Owner', '9876543212', 'MG Road, Bahraich')`
  await sql`INSERT INTO public.parties (name, number, address) VALUES ('VALSRCH Kolkata Trader', '9876543213', 'Park Street, Kolkata')`
  const psearch = async (q: string, limit = 20, offset = 0) =>
    (await rpcSetof('search_parties', { p_query: q, p_limit: limit, p_offset: offset })) as any[]
  for (const q of ['9876543212', '919876543212', '+919876543212', '+91 98765 43212', '91 9876543212']) {
    const r = await psearch(q)
    ok(r.length >= 1 && r.some(x => x.name === 'VALSRCH OnePlus Owner' && x.rank === 1000),
      `party phone query "${q}" → exact canonical match rank 1000`, r.map(x => [x.name, x.rank]))
  }
  let pr = await psearch('98765')
  ok(pr.every(x => (x.number ?? '').includes('98765')), 'partial phone query matches by substring', pr.map(x => x.number))
  pr = await psearch('oneplus ow')
  ok(pr.some(x => x.name === 'VALSRCH OnePlus Owner'), 'party name token-prefix search')
  pr = await psearch('kolkata')
  ok(pr.length === 1 && pr[0].name === 'VALSRCH Kolkata Trader', 'party address search')
  pr = await psearch('')
  ok(pr.length >= 2 && pr.every(x => x.rank === 0) && models(pr.map(x => ({ brand: x.name, model: '' }))).length > 0,
    'party browse mode returns name-ordered directory (rank 0)')
  const ppage = await psearch('valsrch', 2)
  ok(ppage.length === 2 && ppage[0].total_count > 2, 'party search reports total_count beyond the page', ppage[0].total_count)

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n── C. Sale / invoice invariants ─────────────────────────────────')
  // ══════════════════════════════════════════════════════════════════════

  const baseCounters = async () =>
    (await sql`SELECT sale_counter, purchase_counter, proforma_counter FROM public.financial_years WHERE id = ${fyId}`)[0]
  const snapshot = async () => ({
    sales: (await sql`SELECT count(*)::int AS n FROM public.sales WHERE financial_year_id = ${fyId}`)[0].n,
    items: (await sql`SELECT count(*)::int AS n FROM public.sale_items si JOIN public.sales s ON s.id = si.sale_id WHERE s.financial_year_id = ${fyId}`)[0].n,
    payments: (await sql`SELECT count(*)::int AS n FROM public.payments_in WHERE financial_year_id = ${fyId}`)[0].n,
    tx: (await sql`SELECT count(*)::int AS n FROM public.account_transactions WHERE financial_year_id = ${fyId}`)[0].n,
    tradeIns: (await sql`SELECT count(*)::int AS n FROM public.trade_ins t JOIN public.sales s ON s.id = t.sale_id WHERE s.financial_year_id = ${fyId}`)[0].n,
    trdPurchases: (await sql`SELECT count(*)::int AS n FROM public.purchases WHERE financial_year_id = ${fyId} AND bill_number LIKE 'PUR-TRD-%'`)[0].n,
  })

  const saleItem = (imei: string) =>
    sql`SELECT id FROM public.inventory_items WHERE imei = ${imei} AND financial_year_id = ${fyId}`.then(r => r[0].id)

  // C1. Zero products → ALWAYS rejected (the invariant is item COUNT,
  //     never final_total > 0).
  const before = await snapshot()
  const beforeCounters = await baseCounters()
  const zeroCases: Array<[Record<string, unknown>, string, string]> = [
    [{}, 'zero products + ₹0', 'at least one item'],
    [{ discount: 500 }, 'zero products + discount', 'at least one item'],
    [{ paid: 500 }, 'zero products + payment', 'at least one item'],
    [{ trade_ins: [{ brand: 'TI', model: 'Old', imei: nextImei(), ram_rom: '4/64', color: 'Grey', credit_value: 1000, mrp: '', document_id: null }] },
      'zero products + trade-in (trade-in is NOT a product)', 'at least one item'],
  ]
  for (const [extra, label, msg] of zeroCases) {
    await rpcFails('create_sale', {
      payload: {
        financial_year_id: fyId, party_id: partyId, date: '2032-07-01',
        items: [], trade_ins: [], discount: 0, paid: 0,
        bank_account_id: bankId, payment_mode_id: '', ...extra,
      },
    }, msg, `reject ${label}`)
  }
  const afterZero = await snapshot()
  const afterZeroCounters = await baseCounters()
  ok(JSON.stringify(before) === JSON.stringify(afterZero), 'zero-product rejections left NO partial state (sales/items/payments/tx/trade-ins/purchases)', { before, afterZero })
  ok(JSON.stringify(beforeCounters) === JSON.stringify(afterZeroCounters), 'zero-product rejections consumed NO counters')

  // C2. Valid sales, including legitimate ₹0 final totals.
  const s1 = await rpc('create_sale', {
    payload: {
      financial_year_id: fyId, party_id: partyId, date: '2032-07-02',
      items: [{ inventory_item_id: await saleItem(devs[3].imei), sold_price: 5000 }],
      trade_ins: [], discount: 0, paid: 0, bank_account_id: bankId, payment_mode_id: '',
    },
  })
  const s1row = await sql`SELECT total, final_total, paid, due FROM public.sales WHERE id = ${s1.sale_id}`
  ok(Number(s1row[0].final_total) === 5000 && Number(s1row[0].due) === 5000, 'one product → accepted, server totals')

  // 100% discount → ₹0 final total is VALID.
  const s2 = await rpc('create_sale', {
    payload: {
      financial_year_id: fyId, party_id: partyId, date: '2032-07-03',
      items: [{ inventory_item_id: await saleItem(devs[4].imei), sold_price: 1000 }],
      trade_ins: [], discount: 1000, paid: 0, bank_account_id: bankId, payment_mode_id: '',
    },
  })
  const s2row = await sql`SELECT total, discount, final_total, paid, due FROM public.sales WHERE id = ${s2.sale_id}`
  ok(Number(s2row[0].final_total) === 0 && Number(s2row[0].due) === 0, 'one product + 100% discount → ₹0 final total ACCEPTED', s2row[0])

  // Trade-in credit covering the full price → ₹0 final total is VALID,
  // and the trade-in device becomes inventory (not a sale product).
  const tiImei = nextImei()
  const s3 = await rpc('create_sale', {
    payload: {
      financial_year_id: fyId, party_id: partyId, date: '2032-07-04',
      items: [{ inventory_item_id: await saleItem(devs[5].imei), sold_price: 2000 }],
      trade_ins: [{ brand: 'TI', model: 'Old Phone', imei: tiImei, ram_rom: '4/64', color: 'Grey', credit_value: 2000, mrp: '3000', document_id: null }],
      discount: 0, paid: 0, bank_account_id: bankId, payment_mode_id: '',
    },
  })
  const s3row = await sql`SELECT total, trade_in_credit, final_total, paid, due FROM public.sales WHERE id = ${s3.sale_id}`
  const s3items = await sql`SELECT count(*)::int AS n FROM public.sale_items WHERE sale_id = ${s3.sale_id}`
  ok(Number(s3row[0].final_total) === 0, 'product + trade-in credit → ₹0 final total ACCEPTED', s3row[0])
  ok(s3items[0].n === 1, 'trade-in did NOT masquerade as a sale product (1 sale_item)')
  const tiDev = await sql`SELECT status, source FROM public.inventory_items WHERE imei = ${tiImei}`
  ok(tiDev[0].status === 'in_stock' && tiDev[0].source === 'trade_in', 'trade-in device entered inventory as in_stock trade_in source')

  // Multiple products → accepted.
  const s4 = await rpc('create_sale', {
    payload: {
      financial_year_id: fyId, party_id: partyId, date: '2032-07-05',
      items: [
        { inventory_item_id: await saleItem(devs[6].imei), sold_price: 800 },
        { inventory_item_id: await saleItem(devs[1].imei), sold_price: 45000 },
      ],
      trade_ins: [], discount: 500, paid: 10000, bank_account_id: bankId, payment_mode_id: '',
    },
  })
  const s4row = await sql`SELECT total, discount, final_total, paid, due FROM public.sales WHERE id = ${s4.sale_id}`
  ok(Number(s4row[0].total) === 45800 && Number(s4row[0].final_total) === 45300 && Number(s4row[0].due) === 35300,
    'multiple products + discount + payment → correct server totals', s4row[0])

  // update_sale cannot empty the item set.
  await rpcFails('update_sale', {
    payload: { sale_id: s4.sale_id, date: '2032-07-05', discount: 500, items: [] },
  }, 'cannot be added or removed', 'update_sale rejects emptying the item set')

  // C3. Proforma conversion — same canonical invariant.
  const convImei = nextImei()
  const convItem = await sql`INSERT INTO public.inventory_items
    (brand, model, imei, ram_rom, color, purchase_price, base_selling_price, status, source, financial_year_id, opening_entry_type)
    VALUES ('OnePlus', 'Nord 3', ${convImei}, '8/128', 'Grey', 15000, 18000, 'in_stock', 'purchase', ${fyId}, 'direct')
    RETURNING id`
  const convItemId = convItem[0].id as string
  const prof = await rpc('create_proforma', {
    payload: {
      financial_year_id: fyId, party_id: partyId, date: '2032-07-06', discount: 0,
      items: [{ inventory_item_id: convItemId, rate: 17500 }],
      trade_ins: [{ description: 'Proposed old phone', qty: '', rate: 2500 }],
    },
  })
  ok(!!prof.proforma_id, 'proforma with one quoted item created')
  const converted = await rpc('create_sale', {
    payload: {
      proforma_id: prof.proforma_id, date: '2032-07-07',
      items: [{ proforma_item_id: (await sql`SELECT id FROM public.proforma_invoice_items WHERE proforma_invoice_id = ${prof.proforma_id}`)[0].id, inventory_item_id: convItemId }],
      trade_ins: [{ brand: 'TI', model: 'Actual Old Phone', imei: nextImei(), ram_rom: '4/64', color: 'Grey', credit_value: 2500, mrp: '', document_id: null }],
      paid: 0, bank_account_id: bankId, payment_mode_id: '',
    },
  })
  const convRow = await sql`SELECT total, trade_in_credit, final_total FROM public.sales WHERE id = ${converted.sale_id}`
  ok(Number(convRow[0].total) === 17500 && Number(convRow[0].final_total) === 15000, 'conversion with products → accepted at quoted values', convRow[0])

  // Empty proforma (hand-crafted, bypassing create_proforma) cannot convert.
  const emptyProf = await sql`INSERT INTO public.proforma_invoices
    (bill_number, party_id, total, discount, trade_in_credit, final_total, date, financial_year_id, status)
    VALUES ('PI-EMPTY-0001', ${partyId}, 0, 0, 0, 0, '2032-07-06', ${fyId}, 'active') RETURNING id`
  await rpcFails('create_sale', {
    payload: { proforma_id: emptyProf[0].id, date: '2032-07-07', items: [], trade_ins: [], paid: 0, bank_account_id: bankId, payment_mode_id: '' },
  }, 'has no items to convert', 'Proforma → Sale conversion without products rejected')

  // create_proforma itself rejects zero items.
  await rpcFails('create_proforma', {
    payload: { financial_year_id: fyId, party_id: partyId, date: '2032-07-06', discount: 0, items: [], trade_ins: [] },
  }, 'at least one item', 'create_proforma rejects zero quoted items')

  // C4. Conversion failure atomicity: invalid trade-in → nothing persists.
  const conv2Imei = nextImei()
  const conv2Item = await sql`INSERT INTO public.inventory_items
    (brand, model, imei, ram_rom, color, purchase_price, base_selling_price, status, source, financial_year_id, opening_entry_type)
    VALUES ('Samsung', 'A55', ${conv2Imei}, '8/128', 'Blue', 20000, 23000, 'in_stock', 'purchase', ${fyId}, 'direct')
    RETURNING id`
  const conv2ItemId = conv2Item[0].id as string
  const prof2 = await rpc('create_proforma', {
    payload: {
      financial_year_id: fyId, party_id: partyId, date: '2032-07-08', discount: 0,
      items: [{ inventory_item_id: conv2ItemId, rate: 22000 }], trade_ins: [],
    },
  })
  const preFail = await snapshot()
  const preFailCounters = await baseCounters()
  await rpcFails('create_sale', {
    payload: {
      proforma_id: prof2.proforma_id, date: '2032-07-09',
      items: [{ proforma_item_id: (await sql`SELECT id FROM public.proforma_invoice_items WHERE proforma_invoice_id = ${prof2.proforma_id}`)[0].id, inventory_item_id: conv2ItemId }],
      trade_ins: [{ brand: 'TI', model: 'Bad IMEI', imei: '12345', ram_rom: '4/64', color: 'Grey', credit_value: 100, mrp: '', document_id: null }],
      paid: 0, bank_account_id: bankId, payment_mode_id: '',
    },
  }, 'exactly 15 digits', 'conversion with invalid trade-in IMEI rejected')
  const postFail = await snapshot()
  const postFailCounters = await baseCounters()
  ok(JSON.stringify(preFail) === JSON.stringify(postFail), 'failed conversion left NO partial sale/items/payments/tx/trade-ins/purchases')
  ok(JSON.stringify(preFailCounters) === JSON.stringify(postFailCounters), 'failed conversion consumed NO counters')
  const prof2State = await sql`SELECT status FROM public.proforma_invoices WHERE id = ${prof2.proforma_id}`
  ok(prof2State[0].status === 'active', 'failed conversion leaves the proforma ACTIVE')
  const conv2Status = await sql`SELECT status FROM public.inventory_items WHERE id = ${conv2ItemId}`
  ok(conv2Status[0].status === 'in_stock', 'failed conversion does not sell the quoted device')

  // C5. paid > final (₹0) rejected.
  await rpcFails('create_sale', {
    payload: {
      financial_year_id: fyId, party_id: partyId, date: '2032-07-10',
      items: [{ inventory_item_id: conv2ItemId, sold_price: 100 }],
      trade_ins: [], discount: 100, paid: 50, bank_account_id: bankId, payment_mode_id: '',
    },
  }, 'cannot exceed', 'paid > ₹0 final total rejected')

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n── D. Security posture + pre-existing data untouched ────────────')
  // ══════════════════════════════════════════════════════════════════════

  const priv = async (role: string, fn: string) =>
    (await sql.unsafe(`SELECT has_function_privilege('${role}', '${fn}', 'EXECUTE') AS p`))[0].p as boolean
  ok(await priv('anon', 'public.search_inventory(text, uuid, text, integer, integer, uuid[])') === false, 'anon CANNOT execute search_inventory')
  ok(await priv('authenticated', 'public.search_inventory(text, uuid, text, integer, integer, uuid[])') === true, 'authenticated CAN execute search_inventory')
  ok(await priv('anon', 'public.search_parties(text, integer, integer)') === false, 'anon CANNOT execute search_parties')
  ok(await priv('authenticated', 'public.search_parties(text, integer, integer)') === true, 'authenticated CAN execute search_parties')
  ok(await priv('anon', 'public.create_purchase(jsonb)') === false, 'anon CANNOT execute create_purchase (posture unchanged)')

  // The two pre-existing TEST parties are canonical after the backfill.
  const realParties = await sql`SELECT number FROM public.parties WHERE name NOT LIKE 'VALSRCH %'`
  ok(realParties.every((p: any) => p.number === null || p.number === null || /^\+91[6-9][0-9]{9}$/.test(p.number)),
    'pre-existing party numbers are canonical (+91XXXXXXXXXX)', realParties.map((p: any) => p.number))

  // WhatsApp auto-send remains DISABLED (must never be re-enabled here).
  const wa = await sql`SELECT auto_send_sale, auto_send_purchase, auto_send_proforma, auto_send_receipt_in, auto_send_receipt_out FROM public.whatsapp_settings WHERE singleton = 1`
  ok(wa[0].auto_send_sale === false && wa[0].auto_send_purchase === false && wa[0].auto_send_proforma === false
    && wa[0].auto_send_receipt_in === false && wa[0].auto_send_receipt_out === false,
    'WhatsApp auto-send flags all remain false (never re-enabled)')

  // ── Teardown ─────────────────────────────────────────────────────────────────
  await cleanupFixtures([fyId, closedFyId])
  await sql`DELETE FROM public.parties WHERE name LIKE 'VALSRCH %'`
  await sql`DELETE FROM public.bank_accounts WHERE name = 'VALSRCH Cash'`
  const strayBanks = await sql`SELECT count(*)::int AS n FROM public.bank_accounts WHERE name = 'VALSRCH Cash'`
  ok(strayBanks[0].n === 0, 'teardown left zero fixture bank accounts')
  const leftovers = await sql`
    SELECT count(*)::int AS n FROM public.inventory_items WHERE financial_year_id NOT IN (
      SELECT id FROM public.financial_years)`
  ok(leftovers[0].n === 0, 'teardown left zero orphaned inventory rows')
  const leftoverSales = await sql`
    SELECT count(*)::int AS n FROM public.sales WHERE financial_year_id NOT IN (
      SELECT id FROM public.financial_years)`
  ok(leftoverSales[0].n === 0, 'teardown left zero orphaned sales')

  console.log(`\n${passes} passed, ${failures} failed`)
  if (failures > 0) {
    console.log('\nSOME CHECKS FAILED')
    process.exitCode = 1
  } else {
    console.log('ALL CHECKS PASSED')
  }
}

main()
  .catch((e) => {
    console.error('SUITE ERROR:', e)
    process.exitCode = 1
  })
  .finally(() => sql.end())
