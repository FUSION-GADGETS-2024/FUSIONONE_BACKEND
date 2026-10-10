/**
 * FUSIONONE Trade-In + Proforma architectural redesign — database test
 * suite (specification §35: Trade-In, Trade-In lifecycle, Inventory
 * identity, Proforma, Conversion, Conversion failure, Concurrency,
 * Retry; plus FY-rollover behavior and the execution-security posture).
 *
 * Runs against the TEST Supabase project ONLY (never production).
 * Creates its own isolated fixtures (FY/party/bank/inventory) far in
 * the future (FY 2030-31) so real business data is never touched, and
 * removes them at the end. Exit code is non-zero when any check fails.
 *
 * Usage (from database/tools):
 *   bun run tradein-proforma-tests.ts    # uses TEST_SUPABASE_DB_URL from .env
 */
import postgres from 'postgres'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

function loadEnv(): Record<string, string> {
  const raw = readFileSync(join(HERE, '.env'), 'utf8')
  return Object.fromEntries(
    raw
      .split('\n')
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

async function rpc(fn: string, params: Record<string, unknown>, client = sql): Promise<any> {
  // Call an RPC through a parameterized SELECT (keeps the transactional
  // semantics identical to supabase.rpc). Named parameters are bound
  // explicitly in declaration order.
  const entries = Object.entries(params)
  if (entries.length === 0) throw new Error('rpc helper expects at least one named parameter')
  const args = entries.map(([name], i) => `${name} := $${i + 1}`).join(', ')
  const rows = await client.unsafe(
    `SELECT public.${fn}(${args}) AS result`, entries.map(([, v]) => v) as any,
  )
  return (rows as any[])[0]?.result
}

async function rpcFails(fn: string, params: Record<string, unknown>, expectText: string, label: string, client = sql): Promise<void> {
  try {
    await rpc(fn, params, client)
    ok(false, `${label} (expected failure containing "${expectText}")`)
  } catch (e: any) {
    ok(String(e.message).includes(expectText), label, e.message)
  }
}

/** Unique 15-digit IMEI generator for test devices. */
let imeiSeq = 700000000000010
const nextImei = () => String(imeiSeq++)

const FY_START = '2030-04-01'
const FY_END = '2031-03-31'


/**
 * FK-safe removal of every fixture created by this suite (used both as
 * pre-cleanup for re-runs and as the final teardown). Trade-in device
 * references are captured BEFORE their trade_ins rows are removed.
 */
async function cleanupFixtures(fyIds: string[]): Promise<void> {
  if (fyIds.length === 0) return
  // Carried-forward copies reference their originals via fk_origin_item —
  // remove the copies BEFORE any original can be deleted.
  await sql`DELETE FROM public.inventory_items WHERE origin_inventory_item_id IN (
    SELECT id FROM public.inventory_items WHERE financial_year_id IN ${sql(fyIds)})`
  const tiDevices = await sql`SELECT DISTINCT t.inventory_item_id AS id
      FROM public.trade_ins t
     WHERE t.sale_id IN (SELECT id FROM public.sales WHERE financial_year_id IN ${sql(fyIds)})`
  const sales = await sql`SELECT id FROM public.sales WHERE financial_year_id IN ${sql(fyIds)}`
  for (const s of sales) {
    await sql`DELETE FROM public.account_transactions WHERE reference_id = ${s.id} AND reference_type IN ('sale', 'sale_cancelled')`
    await sql`DELETE FROM public.payments_in WHERE sale_id = ${s.id}`
    await sql`DELETE FROM public.trade_ins WHERE sale_id = ${s.id}`
    await sql`DELETE FROM public.sale_items WHERE sale_id = ${s.id}`
    await sql`DELETE FROM public.sales WHERE id = ${s.id}`
  }
  for (const t of tiDevices) {
    if (!t.id) continue
    await sql`DELETE FROM public.purchase_items WHERE inventory_item_id = ${t.id}`
    await sql`DELETE FROM public.inventory_items WHERE id = ${t.id}`
  }
  await sql`DELETE FROM public.account_transactions WHERE financial_year_id IN ${sql(fyIds)}`
  await sql`DELETE FROM public.payments_in WHERE financial_year_id IN ${sql(fyIds)}`
  await sql`DELETE FROM public.proforma_invoices WHERE financial_year_id IN ${sql(fyIds)}`
  await sql`DELETE FROM public.purchase_items WHERE purchase_id IN (SELECT id FROM public.purchases WHERE financial_year_id IN ${sql(fyIds)})`
  await sql`DELETE FROM public.purchases WHERE financial_year_id IN ${sql(fyIds)}`
  await sql`DELETE FROM public.inventory_items WHERE origin_inventory_item_id IN (SELECT id FROM public.inventory_items WHERE financial_year_id IN ${sql(fyIds)})`
  await sql`DELETE FROM public.inventory_items WHERE financial_year_id IN ${sql(fyIds)}`
  await sql`DELETE FROM public.financial_years WHERE id IN ${sql(fyIds)}`
  await sql`DELETE FROM public.bank_accounts WHERE name = 'TIPI Cash'`
  await sql`DELETE FROM public.parties WHERE name = 'TIPI Test Party'`
}

async function main() {
  console.log('\n═══ FUSIONONE Trade-In + Proforma redesign DB suite ═══\n')

  // ── Pre-cleanup: remove any fixtures left behind by a previously
  //    crashed run (the suite must be re-runnable in isolation).
  // ────────────────────────────────────────────────────────────────────────
  {
    const staleFys = await sql`SELECT id FROM public.financial_years
       WHERE start_date IN ('2029-04-01', '2030-04-01', '2031-04-01')`
    if (staleFys.length > 0) {
      console.log(`  (pre-cleanup: removing ${staleFys.length} stale fixture FYs from a prior run)`)
      await cleanupFixtures(staleFys.map((r: any) => r.id))
    }
  }

  // ── Fixtures ────────────────────────────────────────────────────────────
  const fy = await sql`INSERT INTO public.financial_years (start_date, end_date, status)
    VALUES (${FY_START}, ${FY_END}, 'active') RETURNING id`.then((r) => r[0].id as string)
  const closedFy = await sql`INSERT INTO public.financial_years (start_date, end_date, status)
    VALUES ('2029-04-01', '2030-03-31', 'closed') RETURNING id`.then((r) => r[0].id as string)
  const party = await sql`INSERT INTO public.parties (name, number)
    VALUES ('TIPI Test Party', '919999000011') RETURNING id`.then((r) => r[0].id as string)
  const bank = await sql`INSERT INTO public.bank_accounts (name, is_cash)
    VALUES ('TIPI Cash', true) RETURNING id`.then((r) => r[0].id as string)

  const mkItem = (rate: number) =>
    sql`INSERT INTO public.inventory_items
          (brand, model, imei, ram_rom, color, purchase_price, base_selling_price, status, source, financial_year_id, opening_entry_type)
        VALUES ('TIPIBrand', 'TModel', ${nextImei()}, '8/128', 'Black', ${rate - 1000}, ${rate}, 'in_stock', 'purchase', ${fy}, 'direct')
        RETURNING id, imei`.then((r) => ({ id: r[0].id as string, imei: r[0].imei as string }))

  const device1 = await mkItem(20000) // sold in sale A
  const device2 = await mkItem(30000) // sold in sale A
  const device3 = await mkItem(12000) // quoted in proforma (one-item)
  const device4 = await mkItem(15000) // quoted in proforma (multi-item)
  const device5 = await mkItem(18000) // quoted in proforma (multi-item)
  const device6 = await mkItem(9000)  // quoted in proforma (unavailable test)
  const device7 = await mkItem(11000) // quoted in legacy-mapping proforma
  const device8 = await mkItem(13000) // free pickup for cancel/recovery test
  const device9 = await mkItem(16000) // rollover carry-forward test

  const saleItem = (id: string, price: number) => ({ inventory_item_id: id, sold_price: price })
  const tradeIn = (over: Partial<Record<string, unknown>> = {}) => ({
    brand: 'TIPI OldPhone', model: 'X1', imei: nextImei(), ram_rom: '6/64', color: 'White',
    credit_value: 5000, mrp: 9000, document_id: null, ...over,
  })

  // ═══════════════════════════════════════════════════════════════════════
  console.log('── A. Normal sale + trade-in creation ──')
  // ═══════════════════════════════════════════════════════════════════════

  const fyCounters0 = await sql`SELECT sale_counter, purchase_counter FROM public.financial_years WHERE id = ${fy}`.then((r) => r[0])

  const saleA = await rpc('create_sale', { payload: {
    financial_year_id: fy, party_id: party, date: '2030-06-10',
    items: [saleItem(device1.id, 19500), saleItem(device2.id, 29000)],
    trade_ins: [tradeIn()], discount: 1000, paid: 20000, due: 0,
    bank_account_id: bank, payment_mode_id: null,
  }})
  ok(!!saleA?.sale_id && /^SAL-2030-31-\d{4}$/.test(saleA.bill_number), 'create_sale returns SAL bill number', saleA)

  const saleARow = await sql`SELECT * FROM public.sales WHERE id = ${saleA.sale_id}`.then((r) => r[0] as any)
  ok(Number(saleARow.total) === 48500, 'server-computed total = Σ sold prices (48500)', saleARow.total)
  ok(Number(saleARow.trade_in_credit) === 5000, 'server-computed trade-in credit (5000)', saleARow.trade_in_credit)
  ok(Number(saleARow.final_total) === 42500, 'server-computed final = total - discount - credit (42500)', saleARow.final_total)
  ok(Number(saleARow.paid) === 20000 && Number(saleARow.due) === 22500, 'paid/due tracked (20000 / 22500)')

  const tiRows = await sql`SELECT * FROM public.trade_ins WHERE sale_id = ${saleA.sale_id}`
  ok(tiRows.length === 1, 'one trade_ins row created')
  const tiA = tiRows[0] as any
  ok(!!tiA.inventory_item_id && Number(tiA.credit_value) === 5000 && Number(tiA.mrp) === 9000,
    'trade_ins holds the transactional relationship (inventory ref + credit + mrp)', tiA)

  const tiDevice = await sql`SELECT * FROM public.inventory_items WHERE id = ${tiA.inventory_item_id}`.then((r) => r[0] as any)
  ok(tiDevice.brand === 'TIPI OldPhone' && tiDevice.model === 'X1' && tiDevice.status === 'in_stock' && tiDevice.source === 'trade_in',
    'received device lives in inventory with full identity (in_stock, trade_in source)', tiDevice)
  ok(Number(tiDevice.purchase_price) === 5000 && Number(tiDevice.base_selling_price) === 5000,
    'trade-in device acquisition cost = credit value')

  const tiCols = await sql`
    SELECT column_name FROM information_schema.columns
     WHERE table_schema='public' AND table_name='trade_ins'`.then((r) => r.map((c: any) => c.column_name))
  ok(!['brand','model','imei','ram_rom','color'].some((c) => tiCols.includes(c)),
    'trade_ins has NO duplicated identity columns', tiCols)
  ok(tiCols.includes('inventory_item_id'), 'trade_ins references inventory_item_id')

  const hiddenPurch = await sql`
    SELECT p.* FROM public.purchases p
     JOIN public.purchase_items pi ON pi.purchase_id = p.id
     WHERE pi.inventory_item_id = ${tiA.inventory_item_id}`.then((r) => r[0] as any)
  ok(/^PUR-TRD-2030-31-\d{4}$/.test(hiddenPurch.bill_number), 'hidden PUR-TRD acquisition purchase created', hiddenPurch?.bill_number)
  ok(Number(hiddenPurch.total) === 5000 && Number(hiddenPurch.paid) === 5000 && Number(hiddenPurch.due) === 0,
    'hidden purchase settled by the credit (paid=credit, due=0)')

  const fyCounters1 = await sql`SELECT sale_counter, purchase_counter FROM public.financial_years WHERE id = ${fy}`.then((r) => r[0])
  ok(fyCounters1.sale_counter === fyCounters0.sale_counter + 1 && fyCounters1.purchase_counter === fyCounters0.purchase_counter + 1,
    'FY counters advanced (sale +1, purchase +1 trade-in)')

  // Document/Exchange data path (repository-style join).
  const docTi = await sql`
    SELECT t.credit_value, t.mrp, i.brand, i.model, i.imei, i.ram_rom, i.color
      FROM public.trade_ins t JOIN public.inventory_items i ON i.id = t.inventory_item_id
     WHERE t.sale_id = ${saleA.sale_id}`.then((r) => r[0] as any)
  ok(docTi.brand === 'TIPI OldPhone' && docTi.imei === tiDevice.imei,
    'documents/exchange resolve device identity through Inventory (join)')

  ok((await sql`SELECT status FROM public.inventory_items WHERE id = ${device1.id}`)[0].status === 'sold',
    'sold devices marked sold')
  ok((await sql`SELECT count(*)::int AS n FROM public.payments_in WHERE sale_id = ${saleA.sale_id}`)[0].n === 1,
    'payment-at-creation recorded (payments_in)')
  ok((await sql`SELECT count(*)::int AS n FROM public.account_transactions WHERE reference_type='sale' AND reference_id = ${saleA.sale_id}`)[0].n === 1,
    'payment-at-creation ledger row (credit/sale)')

  // ═══════════════════════════════════════════════════════════════════════
  console.log('── B. Creation validation (server-enforced invariants) ──')
  // ═══════════════════════════════════════════════════════════════════════

  await rpcFails('create_sale', { payload: {
    financial_year_id: fy, party_id: party, date: '2030-06-10',
    items: [saleItem(device3.id, 100)], trade_ins: [tradeIn({ imei: '12345' })],
    discount: 0, paid: 0, bank_account_id: bank,
  }}, 'exactly 15 digits', 'trade-in IMEI format enforced (15 digits)')

  await rpcFails('create_sale', { payload: {
    financial_year_id: fy, party_id: party, date: '2030-06-10',
    items: [saleItem(device3.id, 100)], trade_ins: [tradeIn({ brand: '  ' })],
    discount: 0, paid: 0, bank_account_id: bank,
  }}, 'brand is required', 'trade-in required identity fields enforced')

  const dupImei = nextImei()
  await rpcFails('create_sale', { payload: {
    financial_year_id: fy, party_id: party, date: '2030-06-10',
    items: [saleItem(device3.id, 100)],
    trade_ins: [tradeIn({ imei: dupImei }), tradeIn({ imei: dupImei })],
    discount: 0, paid: 0, bank_account_id: bank,
  }}, 'Duplicate trade-in IMEI', 'duplicate trade-in IMEI within payload rejected')

  await rpcFails('create_sale', { payload: {
    financial_year_id: fy, party_id: party, date: '2030-06-10',
    items: [saleItem(device3.id, 100)],
    trade_ins: [tradeIn({ imei: tiDevice.imei })],
    discount: 0, paid: 0, bank_account_id: bank,
  }}, 'already in stock', 'trade-in IMEI already in stock rejected')

  await rpcFails('create_sale', { payload: {
    financial_year_id: fy, party_id: party, date: '2030-06-10',
    items: [saleItem(device1.id, 100)], trade_ins: [],
    discount: 0, paid: 0, bank_account_id: bank,
  }}, 'no longer available in stock', 'selling an already-sold device rejected')

  await rpcFails('create_sale', { payload: {
    financial_year_id: fy, party_id: party, date: '2030-06-10',
    items: [saleItem(device3.id, -5)], trade_ins: [],
    discount: 0, paid: 0, bank_account_id: bank,
  }}, 'Sold price cannot be negative', 'negative sold price rejected')

  await rpcFails('create_sale', { payload: {
    financial_year_id: fy, party_id: party, date: '2030-06-10',
    items: [saleItem(device3.id, 100), saleItem(device3.id, 100)], trade_ins: [],
    discount: 0, paid: 0, bank_account_id: bank,
  }}, 'cannot be sold twice', 'same device sold twice rejected')

  await rpcFails('create_sale', { payload: {
    financial_year_id: fy, party_id: party, date: '2030-06-10',
    items: [saleItem(device3.id, 100)], trade_ins: [],
    discount: 0, paid: 999999, bank_account_id: bank,
  }}, 'cannot exceed the final total', 'paid > final total rejected')

  await rpcFails('create_sale', { payload: {
    financial_year_id: closedFy, party_id: party, date: '2029-06-10',
    items: [saleItem(device3.id, 100)], trade_ins: [],
    discount: 0, paid: 0, bank_account_id: bank,
  }}, 'closed financial year', 'sale creation in a closed FY rejected')

  await rpcFails('create_sale', { payload: {
    financial_year_id: fy, party_id: party, date: '2031-06-10',
    items: [saleItem(device3.id, 100)], trade_ins: [],
    discount: 0, paid: 0, bank_account_id: bank,
  }}, 'within the financial year', 'date outside FY rejected')

  const countersAfterFails = await sql`SELECT sale_counter, purchase_counter FROM public.financial_years WHERE id = ${fy}`.then((r) => r[0])
  ok(countersAfterFails.sale_counter === fyCounters1.sale_counter && countersAfterFails.purchase_counter === fyCounters1.purchase_counter,
    'failed creations consumed no bill numbers (validation precedes counters)')

  // ═══════════════════════════════════════════════════════════════════════
  console.log('── C. Inventory identity mutability ──')
  // ═══════════════════════════════════════════════════════════════════════

  try {
    await sql`UPDATE public.inventory_items SET model = 'HackedModel' WHERE id = ${device1.id}`
    ok(false, 'identity of a sold device is frozen (DB-enforced)')
  } catch (e: any) {
    ok(String(e.message).includes('identity of a sold device'), 'identity of a sold device is frozen (DB-enforced)', e.message)
  }
  try {
    await sql`UPDATE public.inventory_items SET base_selling_price = 12345 WHERE id = ${device1.id}`
    ok(true, 'prices of a sold device remain editable')
  } catch (e: any) {
    ok(false, 'prices of a sold device remain editable', e.message)
  }
  try {
    await sql`UPDATE public.inventory_items SET model = 'TIPIBrand Fixed' WHERE id = ${device3.id}`
    ok(true, 'identity of an in-stock device is editable (typo correction)')
    await sql`UPDATE public.inventory_items SET model = 'TModel' WHERE id = ${device3.id}`
  } catch (e: any) {
    ok(false, 'identity of an in-stock device is editable (typo correction)', e.message)
  }

  // ═══════════════════════════════════════════════════════════════════════
  console.log('── D. Trade-In lifecycle: cancel / resold / recovery ──')
  // ═══════════════════════════════════════════════════════════════════════

  // D1. Cancel a sale whose trade-in device is still in stock → full reversal.
  const saleB = await rpc('create_sale', { payload: {
    financial_year_id: fy, party_id: party, date: '2030-07-01',
    items: [saleItem(device8.id, 12000)], trade_ins: [tradeIn({ credit_value: 3000 })],
    discount: 0, paid: 0, bank_account_id: bank,
  }})
  const tiB = await sql`SELECT * FROM public.trade_ins WHERE sale_id = ${saleB.sale_id}`.then((r) => r[0] as any)
  const cancelB = await rpc('cancel_sale', { p_sale_id: saleB.sale_id })
  ok(Array.isArray(cancelB?.resold) && cancelB.resold.length === 0, 'cancel with in-stock trade-in returns empty resold list', cancelB)
  ok((await sql`SELECT count(*)::int AS n FROM public.trade_ins WHERE id = ${tiB.id}`)[0].n === 0,
    'trade_ins row removed on full reversal')
  ok((await sql`SELECT count(*)::int AS n FROM public.inventory_items WHERE id = ${tiB.inventory_item_id}`)[0].n === 0,
    'received device removed from inventory on full reversal')
  ok((await sql`SELECT count(*)::int AS n FROM public.purchase_items WHERE inventory_item_id = ${tiB.inventory_item_id}`)[0].n === 0,
    'acquisition mapping removed (no dangling purchase_items)')
  ok((await sql`SELECT count(*)::int AS n FROM public.purchases WHERE bill_number LIKE 'PUR-TRD-%' AND id NOT IN (SELECT purchase_id FROM public.purchase_items)`)[0].n === 0,
    'no orphaned hidden purchases')
  ok((await sql`SELECT status FROM public.inventory_items WHERE id = ${device8.id}`)[0].status === 'in_stock',
    'sold device restocked after cancel')
  ok((await sql`SELECT status FROM public.sales WHERE id = ${saleB.sale_id}`)[0].status === 'cancelled',
    'sale marked cancelled (bill number preserved)')
  await rpcFails('cancel_sale', { p_sale_id: saleB.sale_id }, 'Only an active sale', 'double-cancel rejected')

  // D2. Cancel after the trade-in device was resold → resold report + recovery bill.
  const saleC = await rpc('create_sale', { payload: {
    financial_year_id: fy, party_id: party, date: '2030-07-05',
    items: [saleItem(device4.id, 14000)], trade_ins: [tradeIn({ credit_value: 4000 })],
    discount: 0, paid: 0, bank_account_id: bank,
  }})
  const tiC = await sql`SELECT * FROM public.trade_ins WHERE sale_id = ${saleC.sale_id}`.then((r) => r[0] as any)
  // Resell the received trade-in device in another sale.
  const saleD = await rpc('create_sale', { payload: {
    financial_year_id: fy, party_id: party, date: '2030-07-10',
    items: [saleItem(tiC.inventory_item_id, 4500)], trade_ins: [],
    discount: 0, paid: 4500, bank_account_id: bank,
  }})
  const cancelC = await rpc('cancel_sale', { p_sale_id: saleC.sale_id })
  ok(cancelC?.resold?.length === 1, 'cancel after resale reports the resold trade-in', cancelC)
  const resoldEntry = cancelC?.resold?.[0] ?? {}
  ok(resoldEntry.brand === 'TIPI OldPhone' && resoldEntry.imei,
    'resold report carries device identity read through Inventory', resoldEntry)
  ok(resoldEntry.inventory_item_id === tiC.inventory_item_id && resoldEntry.status === 'sold',
    'resold report references the exact inventory item and its state')
  ok((await sql`SELECT count(*)::int AS n FROM public.trade_ins WHERE id = ${tiC.id}`)[0].n === 1,
    'resold trade-in relationship preserved (history stays truthful)')
  const purchC = await sql`
    SELECT p.status FROM public.purchases p JOIN public.purchase_items pi ON pi.purchase_id = p.id
     WHERE pi.inventory_item_id = ${tiC.inventory_item_id} ORDER BY p.created_at LIMIT 1`.then((r) => r[0] as any)
  ok(purchC?.status === 'cancelled', 'hidden acquisition purchase cancelled in the resold case', purchC)
  const recoveryBill = await rpc('create_trade_in_purchase_bill', { p_sale_id: saleC.sale_id, p_trade_in_id: tiC.id })
  ok(typeof recoveryBill === 'string' && /^PUR-2030-31-\d{4}$/.test(recoveryBill),
    'recovery purchase bill created (canonical full-FY format, identical to create_purchase)', recoveryBill)
  const recoveryPurch = await sql`
    SELECT p.* FROM public.purchases p JOIN public.purchase_items pi ON pi.purchase_id = p.id
     WHERE pi.inventory_item_id = ${tiC.inventory_item_id} AND p.bill_number = ${recoveryBill}`.then((r) => r[0] as any)
  ok(Number(recoveryPurch.total) === 4000 && Number(recoveryPurch.paid) === 4000 && recoveryPurch.status === 'active',
    'recovery bill settles the acquisition (total=credit, paid=credit, active)')

  // Payment reversal ledger rows for saleC (paid 0 → none) and saleD.
  // D3. Cancel a sale WITH payments → compensating ledger rows.
  const cancelD = await rpc('cancel_sale', { p_sale_id: saleD.sale_id })
  ok((await sql`SELECT count(*)::int AS n FROM public.account_transactions WHERE reference_type='sale_cancelled' AND reference_id = ${saleD.sale_id}`)[0].n === 1,
    'payment reversal ledger row written on cancel (sale_cancelled debit)')
  ok((await sql`SELECT status FROM public.inventory_items WHERE id = ${tiC.inventory_item_id}`)[0].status === 'in_stock',
    'resold trade-in device back in stock after its resale sale was cancelled')

  // ═══════════════════════════════════════════════════════════════════════
  console.log('── E. Delete guards ──')
  // ═══════════════════════════════════════════════════════════════════════

  await rpcFails('delete_sale', { p_sale_id: saleA.sale_id }, 'payment has already been received',
    'delete rejected when payment received')
  await rpcFails('delete_sale', { p_sale_id: saleC.sale_id }, 'Only an active sale',
    'delete rejected for cancelled sale')
  const saleE = await rpc('create_sale', { payload: {
    financial_year_id: fy, party_id: party, date: '2030-08-01',
    items: [saleItem(device8.id, 11000)], trade_ins: [tradeIn({ credit_value: 2500 })],
    discount: 0, paid: 0, bank_account_id: bank,
  }})
  const tiE = await sql`SELECT * FROM public.trade_ins WHERE sale_id = ${saleE.sale_id}`.then((r) => r[0] as any)
  await rpc('delete_sale', { p_sale_id: saleE.sale_id })
  ok((await sql`SELECT count(*)::int AS n FROM public.sales WHERE id = ${saleE.sale_id}`)[0].n === 0,
    'delete removes the sale (paid=0, trade-in in stock)')
  ok((await sql`SELECT count(*)::int AS n FROM public.trade_ins WHERE id = ${tiE.id}`)[0].n === 0 &&
     (await sql`SELECT count(*)::int AS n FROM public.inventory_items WHERE id = ${tiE.inventory_item_id}`)[0].n === 0,
    'delete removes trade-in graph completely (FK-safe order, no dangling rows)')
  ok((await sql`SELECT status FROM public.inventory_items WHERE id = ${device8.id}`)[0].status === 'in_stock',
    'delete restocks the sold device')

  // ═══════════════════════════════════════════════════════════════════════
  console.log('── F. Canonical sale edit (update_sale) ──')
  // ═══════════════════════════════════════════════════════════════════════

  const saleItemsA = await sql`SELECT id, sold_price FROM public.sale_items WHERE sale_id = ${saleA.sale_id}`
  await rpc('update_sale', { payload: {
    sale_id: saleA.sale_id, date: '2030-06-15', discount: 1500,
    items: saleItemsA.map((r: any) => ({ sale_item_id: r.id, sold_price: Number(r.sold_price) - 500 })),
  }})
  const saleA2 = await sql`SELECT * FROM public.sales WHERE id = ${saleA.sale_id}`.then((r) => r[0] as any)
  ok(Number(saleA2.total) === 47500 && Number(saleA2.final_total) === 41000 && Number(saleA2.due) === 21000,
    'update_sale recomputes totals server-side (47500 / 41000 / 21000, credit preserved)', saleA2)
  ok(new Date(saleA2.date).toISOString().slice(0, 10) === '2030-06-15', 'update_sale persists the new date')
  await rpcFails('update_sale', { payload: {
    sale_id: saleA.sale_id, date: '2030-06-15', discount: 999999,
    items: saleItemsA.map((r: any) => ({ sale_item_id: r.id, sold_price: 100 })),
  }}, 'already-received payment', 'edit below received payment rejected')
  await rpcFails('update_sale', { payload: {
    sale_id: saleA.sale_id, date: '2030-06-15', discount: 0,
    items: saleItemsA.slice(0, 1).map((r: any) => ({ sale_item_id: r.id, sold_price: 100 })),
  }}, 'cannot be added or removed', 'edit cannot drop items from the priced set')
  await rpcFails('update_sale', { payload: {
    sale_id: saleB.sale_id, date: '2030-06-15', discount: 0,
    items: (await sql`SELECT id FROM public.sale_items WHERE sale_id = ${saleB.sale_id}`).map((r: any) => ({ sale_item_id: r.id, sold_price: 100 })),
  }}, 'Only an active sale', 'edit of cancelled sale rejected')

  // ═══════════════════════════════════════════════════════════════════════
  console.log('── G. Proforma: real Party + real Inventory + price snapshot ──')
  // ═══════════════════════════════════════════════════════════════════════

  const proforma1 = await rpc('create_proforma', { payload: {
    financial_year_id: fy, party_id: party, date: '2030-09-01', discount: 500,
    items: [{ inventory_item_id: device3.id, rate: 11500 }],
    trade_ins: [{ description: 'TIPI proposed exchange — iPhone 8', qty: 1, rate: 3000 }],
  }})
  ok(!!proforma1?.proforma_id && /^PI-2030-31-\d{4}$/.test(proforma1.bill_number), 'create_proforma returns PI bill number', proforma1)
  const pf1 = await sql`SELECT * FROM public.proforma_invoices WHERE id = ${proforma1.proforma_id}`.then((r) => r[0] as any)
  ok(Number(pf1.total) === 11500 && Number(pf1.discount) === 500 && Number(pf1.trade_in_credit) === 3000 && Number(pf1.final_total) === 8000,
    'proforma totals server-computed incl. persisted discount (11500 / 500 / 3000 / 8000)', pf1)
  ok(Number(pf1.final_total) === Math.max(0, Number(pf1.total) - Number(pf1.discount) - Number(pf1.trade_in_credit)),
    'stored proforma totals are internally consistent')
  const pf1Item = await sql`SELECT * FROM public.proforma_invoice_items WHERE proforma_invoice_id = ${proforma1.proforma_id}`.then((r) => r[0] as any)
  ok(pf1Item.inventory_item_id === device3.id && Number(pf1Item.value) === 11500,
    'quoted line references the REAL inventory item at the quoted value', pf1Item)
  ok((await sql`SELECT status FROM public.inventory_items WHERE id = ${device3.id}`)[0].status === 'in_stock',
    'creating a proforma does NOT consume inventory (still in stock)')
  ok((await sql`SELECT count(*)::int AS n FROM public.payments_in WHERE sale_id IS NULL`)[0].n === 0,
    'creating a proforma creates no payment/accounting rows')
  const pf1Ti = await sql`SELECT * FROM public.proforma_trade_ins WHERE proforma_invoice_id = ${proforma1.proforma_id}`.then((r) => r[0] as any)
  ok(pf1Ti.description.includes('proposed exchange') && Number(pf1Ti.value) === 3000,
    'proposed trade-in stored as a free-text proposal (no inventory fabricated)', pf1Ti)

  // Price snapshot: change the device's base price → proforma unchanged.
  await sql`UPDATE public.inventory_items SET base_selling_price = 99999 WHERE id = ${device3.id}`
  const pf1ItemAfter = await sql`SELECT value FROM public.proforma_invoice_items WHERE proforma_invoice_id = ${proforma1.proforma_id}`.then((r) => r[0])
  ok(Number(pf1ItemAfter.value) === 11500, 'quoted price snapshot survives inventory price changes')
  await sql`UPDATE public.inventory_items SET base_selling_price = 12000 WHERE id = ${device3.id}`

  await rpcFails('create_proforma', { payload: {
    financial_year_id: fy, party_id: party, date: '2030-09-01', discount: 0,
    items: [{ inventory_item_id: device3.id, rate: 100 }, { inventory_item_id: device3.id, rate: 100 }], trade_ins: [],
  }}, 'quoted twice', 'quoting the same device twice rejected')

  await rpcFails('create_proforma', { payload: {
    financial_year_id: fy, party_id: party, date: '2030-09-01', discount: 0,
    items: [{ inventory_item_id: device1.id, rate: 100 }], trade_ins: [],   // device1 is sold
  }}, 'no longer available in stock', 'quoting a non-stock device rejected')

  await rpcFails('create_proforma', { payload: {
    financial_year_id: closedFy, party_id: party, date: '2029-09-01', discount: 0,
    items: [{ inventory_item_id: device3.id, rate: 100 }], trade_ins: [],
  }}, 'closed financial year', 'proforma creation in a closed FY rejected')

  // Edit an active proforma (replace lines + trade-ins).
  await rpc('update_proforma', { payload: {
    proforma_id: proforma1.proforma_id, party_id: party, date: '2030-09-02', discount: 700,
    items: [{ inventory_item_id: device3.id, rate: 11200 }, { inventory_item_id: device5.id, rate: 17000 }],
    trade_ins: [{ description: 'TIPI revised exchange', qty: 1, rate: 2000 }],
  }})
  const pf1e = await sql`SELECT * FROM public.proforma_invoices WHERE id = ${proforma1.proforma_id}`.then((r) => r[0] as any)
  ok(Number(pf1e.total) === 28200 && Number(pf1e.discount) === 700 && Number(pf1e.trade_in_credit) === 2000 && Number(pf1e.final_total) === 25500,
    'update_proforma recomputes totals incl. discount (28200 / 700 / 2000 / 25500)', pf1e)
  ok((await sql`SELECT count(*)::int AS n FROM public.proforma_invoice_items WHERE proforma_invoice_id = ${proforma1.proforma_id}`)[0].n === 2,
    'update_proforma replaces the quoted lines wholesale')
  ok(pf1e.bill_number === proforma1.bill_number, 'edited proforma keeps its bill number (revision, not new document)')

  // Void.
  const proformaVoid = await rpc('create_proforma', { payload: {
    financial_year_id: fy, party_id: party, date: '2030-09-03', discount: 0,
    items: [{ inventory_item_id: device5.id, rate: 1000 }], trade_ins: [],
  }})
  await rpc('void_proforma', { p_proforma_id: proformaVoid.proforma_id })
  ok((await sql`SELECT status FROM public.proforma_invoices WHERE id = ${proformaVoid.proforma_id}`)[0].status === 'void',
    'void_proforma marks the quotation void')
  await rpcFails('void_proforma', { p_proforma_id: proformaVoid.proforma_id }, 'Only an active proforma',
    'double-void rejected')
  await rpcFails('update_proforma', { payload: {
    proforma_id: proformaVoid.proforma_id, party_id: party, date: '2030-09-03', discount: 0,
    items: [{ inventory_item_id: device5.id, rate: 1000 }], trade_ins: [],
  }}, 'Only an active proforma', 'edit of a void proforma rejected')
  ok((await sql`SELECT status FROM public.inventory_items WHERE id = ${device5.id}`)[0].status === 'in_stock',
    'voiding does not touch inventory')

  // Legacy free-text proformas remain readable. The check is environment-
  // independent: the suite seeds its own legacy-style line (in the suite FY,
  // removed by the teardown) instead of relying on pre-existing rows — the
  // old "two real PI-2026-27 rows" assumption went stale when the mandated
  // fresh reset removed all historical business data.
  const legacyPfSeed = await sql`
    INSERT INTO public.proforma_invoices (bill_number, party_id, total, discount, trade_in_credit, final_total, date, financial_year_id, status)
    VALUES ('PI-LEGACY-READABLE', ${party}, 150, 0, 0, 150, '2030-06-01', ${fy}, 'void')
    RETURNING id`.then((r) => r[0].id as string)
  await sql`
    INSERT INTO public.proforma_invoice_items (proforma_invoice_id, description, qty, rate, discount, value)
    VALUES (${legacyPfSeed}, 'Legacy free-text accessory line', 1, 150, 0, 150)`
  const legacy = await sql`
    SELECT i.id, i.description, i.qty, i.rate, i.value, i.inventory_item_id
      FROM public.proforma_invoice_items i
     WHERE i.proforma_invoice_id = ${legacyPfSeed}`
  ok(legacy.length === 1 && legacy[0].inventory_item_id === null && legacy[0].description !== null,
    'legacy free-text proforma lines remain readable (truthful, no fabricated refs)', legacy)

  // ═══════════════════════════════════════════════════════════════════════
  console.log('── H. Proforma → Sale conversion (atomic, idempotent) ──')
  // ═══════════════════════════════════════════════════════════════════════

  // H1. Multi-item conversion with an ACTUAL trade-in received at conversion.
  const pfItems = await sql`SELECT id, inventory_item_id FROM public.proforma_invoice_items WHERE proforma_invoice_id = ${proforma1.proforma_id}`
  const beforeCounters = await sql`SELECT sale_counter, purchase_counter FROM public.financial_years WHERE id = ${fy}`.then((r) => r[0])
  const conv1 = await rpc('create_sale', { payload: {
    proforma_id: proforma1.proforma_id, date: '2030-10-01',
    items: pfItems.map((r: any) => ({ proforma_item_id: r.id, inventory_item_id: r.inventory_item_id })),
    trade_ins: [tradeIn({ credit_value: 2000 })],   // actual device for the 2000 proposal
    paid: 5000, bank_account_id: bank, payment_mode_id: null,
  }})
  ok(!!conv1?.sale_id, 'conversion creates the sale')
  const convSale = await sql`SELECT * FROM public.sales WHERE id = ${conv1.sale_id}`.then((r) => r[0] as any)
  ok(convSale.party_id === party, 'conversion preserves the original party')
  ok(convSale.proforma_id === proforma1.proforma_id, 'sale linked back to the proforma')
  ok(Number(convSale.discount) === 700, 'conversion preserves the quoted discount')
  const convItems = await sql`
    SELECT si.sold_price, i.id FROM public.sale_items si JOIN public.inventory_items i ON i.id = si.inventory_item_id
     WHERE si.sale_id = ${conv1.sale_id} ORDER BY si.sold_price`
  ok(convItems.length === 2 && Number(convItems[0].sold_price) === 11200 && Number(convItems[1].sold_price) === 17000,
    'sale items sold at the QUOTED values (price snapshot honored)', convItems)
  ok((await sql`SELECT status FROM public.inventory_items WHERE id = ${device3.id}`)[0].status === 'sold' &&
     (await sql`SELECT status FROM public.inventory_items WHERE id = ${device5.id}`)[0].status === 'sold',
    'referenced inventory becomes sold')
  const convTi = await sql`
    SELECT t.*, i.brand FROM public.trade_ins t JOIN public.inventory_items i ON i.id = t.inventory_item_id
     WHERE t.sale_id = ${conv1.sale_id}`.then((r) => r[0] as any)
  ok(!!convTi && Number(convTi.credit_value) === 2000 && convTi.brand === 'TIPI OldPhone',
    'ACTUAL trade-in processed through the new architecture at conversion')
  ok(Number(convSale.final_total) === 25500 && Number(convSale.paid) === 5000 && Number(convSale.due) === 20500,
    'conversion totals (final 25500 = quoted terms − actual credit adjustments)', convSale)
  ok((await sql`SELECT status FROM public.proforma_invoices WHERE id = ${proforma1.proforma_id}`)[0].status === 'converted',
    'proforma marked converted')
  const afterCounters = await sql`SELECT sale_counter, purchase_counter FROM public.financial_years WHERE id = ${fy}`.then((r) => r[0])
  ok(afterCounters.sale_counter === beforeCounters.sale_counter + 1 && afterCounters.purchase_counter === beforeCounters.purchase_counter + 1,
    'conversion consumed exactly one sale number + one trade-in purchase number')

  // Retry / re-conversion is impossible.
  await rpcFails('create_sale', { payload: {
    proforma_id: proforma1.proforma_id, date: '2030-10-02',
    items: pfItems.map((r: any) => ({ proforma_item_id: r.id, inventory_item_id: r.inventory_item_id })),
    trade_ins: [], paid: 0, bank_account_id: bank,
  }}, 'Only an active proforma', 'retry after successful conversion rejected cleanly')
  ok((await sql`SELECT count(*)::int AS n FROM public.sales WHERE proforma_id = ${proforma1.proforma_id}`)[0].n === 1,
    'exactly ONE sale exists for the converted proforma')
  await rpcFails('create_sale', { payload: {
    proforma_id: proformaVoid.proforma_id, date: '2030-10-02', items: [], trade_ins: [], paid: 0, bank_account_id: bank,
  }}, 'Only an active proforma', 'void proforma cannot convert')

  // Hard guarantee: a second sale row for the same proforma is physically impossible.
  try {
    await sql`INSERT INTO public.sales (bill_number, party_id, total, final_total, bank_account_id, date, financial_year_id, status, proforma_id)
      VALUES ('SAL-HACK-0001', ${party}, 0, 0, ${bank}, '2030-10-01', ${fy}, 'active', ${proforma1.proforma_id})`
    ok(false, 'unique index blocks a second sale for the same proforma (DB-enforced)')
  } catch (e: any) {
    ok(String(e.message).includes('idx_sales_proforma_unique'), 'unique index blocks a second sale for the same proforma (DB-enforced)', e.message)
  }

  // Converted proforma is immutable.
  await rpcFails('update_proforma', { payload: {
    proforma_id: proforma1.proforma_id, party_id: party, date: '2030-10-01', discount: 0,
    items: [{ inventory_item_id: device6.id, rate: 100 }], trade_ins: [],
  }}, 'Only an active proforma', 'converted proforma is immutable (edit rejected)')
  await rpcFails('void_proforma', { p_proforma_id: proforma1.proforma_id }, 'Only an active proforma',
    'converted proforma cannot be voided')

  // ═══════════════════════════════════════════════════════════════════════
  console.log('── I. Conversion failure paths (clean failure + rollback) ──')
  // ═══════════════════════════════════════════════════════════════════════

  const pfFail = await rpc('create_proforma', { payload: {
    financial_year_id: fy, party_id: party, date: '2030-10-05', discount: 0,
    items: [{ inventory_item_id: device6.id, rate: 8000 }], trade_ins: [],
  }})
  const pfFailItems = await sql`SELECT id, inventory_item_id FROM public.proforma_invoice_items WHERE proforma_invoice_id = ${pfFail.proforma_id}`
  // Make the quoted device unavailable (sell it in another sale first).
  const saleBlock = await rpc('create_sale', { payload: {
    financial_year_id: fy, party_id: party, date: '2030-10-06',
    items: [saleItem(device6.id, 8000)], trade_ins: [], discount: 0, paid: 0, bank_account_id: bank,
  }})
  const countersBeforeFail = await sql`SELECT sale_counter FROM public.financial_years WHERE id = ${fy}`.then((r) => r[0])
  await rpcFails('create_sale', { payload: {
    proforma_id: pfFail.proforma_id, date: '2030-10-07',
    items: pfFailItems.map((r: any) => ({ proforma_item_id: r.id, inventory_item_id: r.inventory_item_id })),
    trade_ins: [], paid: 0, bank_account_id: bank,
  }}, 'no longer available in stock', 'conversion fails cleanly when quoted inventory is unavailable')
  ok((await sql`SELECT status FROM public.proforma_invoices WHERE id = ${pfFail.proforma_id}`)[0].status === 'active',
    'failed conversion leaves the proforma ACTIVE')
  ok((await sql`SELECT count(*)::int AS n FROM public.sales WHERE proforma_id = ${pfFail.proforma_id}`)[0].n === 0,
    'failed conversion leaves NO partial sale')
  const countersAfterFail = await sql`SELECT sale_counter FROM public.financial_years WHERE id = ${fy}`.then((r) => r[0])
  ok(countersAfterFail.sale_counter === countersBeforeFail.sale_counter,
    'failed conversion consumed no bill number (full rollback)')

  // Invalid trade-in at conversion → rollback.
  await rpc('cancel_sale', { p_sale_id: saleBlock.sale_id })  // restock device6
  const pfFailItems2 = await sql`SELECT id, inventory_item_id FROM public.proforma_invoice_items WHERE proforma_invoice_id = ${pfFail.proforma_id}`
  await rpcFails('create_sale', { payload: {
    proforma_id: pfFail.proforma_id, date: '2030-10-08',
    items: pfFailItems2.map((r: any) => ({ proforma_item_id: r.id, inventory_item_id: r.inventory_item_id })),
    trade_ins: [tradeIn({ imei: '12' })], paid: 0, bank_account_id: bank,
  }}, 'exactly 15 digits', 'invalid actual trade-in at conversion rejected')
  ok((await sql`SELECT count(*)::int AS n FROM public.sales WHERE proforma_id = ${pfFail.proforma_id}`)[0].n === 0 &&
     (await sql`SELECT status FROM public.proforma_invoices WHERE id = ${pfFail.proforma_id}`)[0].status === 'active',
    'invalid trade-in conversion rolled back completely')

  // Substitution is blocked.
  await rpcFails('create_sale', { payload: {
    proforma_id: pfFail.proforma_id, date: '2030-10-08',
    items: pfFailItems2.map((r: any) => ({ proforma_item_id: r.id, inventory_item_id: device7.id })),
    trade_ins: [], paid: 0, bank_account_id: bank,
  }}, 'cannot be substituted', 'conversion cannot silently substitute another device')

  // Paid > quoted final → rejected.
  await rpcFails('create_sale', { payload: {
    proforma_id: pfFail.proforma_id, date: '2030-10-08',
    items: pfFailItems2.map((r: any) => ({ proforma_item_id: r.id, inventory_item_id: r.inventory_item_id })),
    trade_ins: [], paid: 999999, bank_account_id: bank,
  }}, 'cannot exceed the final total', 'conversion paid > final rejected')

  // Partial fulfillment (missing a quoted line) → rejected.
  await rpcFails('create_sale', { payload: {
    proforma_id: pfFail.proforma_id, date: '2030-10-08', items: [], trade_ins: [], paid: 0, bank_account_id: bank,
  }}, 'must be fulfilled', 'conversion requires every quoted line to be fulfilled')

  // Legacy free-text proforma: user maps each line to a real device at
  // conversion time (honest mapping — no fabricated references).
  const legacyPf = await sql`
    INSERT INTO public.proforma_invoices (bill_number, party_id, total, discount, trade_in_credit, final_total, date, financial_year_id, status)
    VALUES ('PI-LEGACY-0001', ${party}, 10000, 0, 0, 10000, '2030-10-09', ${fy}, 'active')
    RETURNING id`.then((r) => r[0].id as string)
  const legacyLine = await sql`
    INSERT INTO public.proforma_invoice_items (proforma_invoice_id, description, qty, rate, discount, value)
    VALUES (${legacyPf}, 'iPhone 13 128GB — like new', 1, 10000, 0, 10000)
    RETURNING id`.then((r) => r[0].id as string)
  const convLegacy = await rpc('create_sale', { payload: {
    proforma_id: legacyPf, date: '2030-10-10',
    items: [{ proforma_item_id: legacyLine, inventory_item_id: device7.id }],
    trade_ins: [], paid: 0, bank_account_id: bank,
  }})
  ok(!!convLegacy?.sale_id, 'legacy free-text proforma converts via explicit user mapping')
  const convLegacyItem = await sql`
    SELECT si.sold_price FROM public.sale_items si WHERE si.sale_id = ${convLegacy.sale_id}`.then((r) => r[0])
  ok(Number(convLegacyItem.sold_price) === 10000, 'legacy line converts at its QUOTED value (rate), not current inventory price')

  // Legacy qty≠1 line cannot convert atomically — must be edited first.
  const legacyPf2 = await sql`
    INSERT INTO public.proforma_invoices (bill_number, party_id, total, discount, trade_in_credit, final_total, date, financial_year_id, status)
    VALUES ('PI-LEGACY-0002', ${party}, 200, 0, 0, 200, '2030-10-09', ${fy}, 'active')
    RETURNING id`.then((r) => r[0].id as string)
  const legacyLine2 = await sql`
    INSERT INTO public.proforma_invoice_items (proforma_invoice_id, description, qty, rate, discount, value)
    VALUES (${legacyPf2}, 'Screen guards', 2, 100, 0, 200)
    RETURNING id`.then((r) => r[0].id as string)
  await rpcFails('create_sale', { payload: {
    proforma_id: legacyPf2, date: '2030-10-10',
    items: [{ proforma_item_id: legacyLine2, inventory_item_id: device6.id }],
    trade_ins: [], paid: 0, bank_account_id: bank,
  }}, 'quantity other than 1', 'legacy multi-qty line conversion rejected with a deterministic message')

  // ═══════════════════════════════════════════════════════════════════════
  console.log('── J. Concurrency + retry (two racing conversions) ──')
  // ═══════════════════════════════════════════════════════════════════════

  const pfRace = await rpc('create_proforma', { payload: {
    financial_year_id: fy, party_id: party, date: '2030-11-01', discount: 0,
    items: [{ inventory_item_id: device6.id, rate: 7500 }], trade_ins: [],
  }})
  const raceItems = await sql`SELECT id, inventory_item_id FROM public.proforma_invoice_items WHERE proforma_invoice_id = ${pfRace.proforma_id}`
  const racePayload = {
    proforma_id: pfRace.proforma_id, date: '2030-11-02',
    items: raceItems.map((r: any) => ({ proforma_item_id: r.id, inventory_item_id: r.inventory_item_id })),
    trade_ins: [], paid: 0, bank_account_id: bank, payment_mode_id: null,
  }
  const counterPreRace = (await sql`SELECT sale_counter FROM public.financial_years WHERE id = ${fy}`)[0].sale_counter
  const c1 = postgres(DB_URL, { max: 1, prepare: false, idle_timeout: 5 })
  const c2 = postgres(DB_URL, { max: 1, prepare: false, idle_timeout: 5 })
  const results = await Promise.allSettled([
    c1.unsafe('SELECT public.create_sale(payload := $1) AS r', [racePayload] as any),
    c2.unsafe('SELECT public.create_sale(payload := $1) AS r', [racePayload] as any),
  ])
  const succeeded = results.filter((r) => r.status === 'fulfilled').length
  const failed = results.filter((r) => r.status === 'rejected').length
  ok(succeeded === 1 && failed === 1,
    `two simultaneous conversions → exactly one succeeds (got ${succeeded} ok / ${failed} fail)`,
    results.map((r) => (r.status === 'rejected' ? String((r as any).reason?.message).slice(0, 80) : 'ok')))
  const raceSales = await sql`SELECT count(*)::int AS n FROM public.sales WHERE proforma_id = ${pfRace.proforma_id}`.then((r) => r[0].n)
  ok(raceSales === 1, 'final database state contains exactly ONE sale for the raced proforma', raceSales)
  ok((await sql`SELECT status FROM public.proforma_invoices WHERE id = ${pfRace.proforma_id}`)[0].status === 'converted',
    'raced proforma ends converted exactly once')
  const raceCounters = (await sql`SELECT sale_counter FROM public.financial_years WHERE id = ${fy}`)[0]
  ok(raceCounters.sale_counter === counterPreRace + 1,
    'the race consumed exactly ONE sale number (the loser rolled back fully)', raceCounters)
  await c1.end(); await c2.end()

  // ═══════════════════════════════════════════════════════════════════════
  console.log('── K. Financial-year rollover with trade-in history ──')
  // ═══════════════════════════════════════════════════════════════════════

  const saleR = await rpc('create_sale', { payload: {
    financial_year_id: fy, party_id: party, date: '2031-01-05',
    items: [saleItem(device9.id, 15000)], trade_ins: [tradeIn({ credit_value: 6000 })],
    discount: 0, paid: 0, bank_account_id: bank,
  }})
  const tiR = await sql`SELECT * FROM public.trade_ins WHERE sale_id = ${saleR.sale_id}`.then((r) => r[0] as any)
  // An active proforma dated inside the FY, created BEFORE the FY closes —
  // after closing it must no longer be convertible.
  const pfClosed = await rpc('create_proforma', { payload: {
    financial_year_id: fy, party_id: party, date: '2030-11-20', discount: 0,
    items: [{ inventory_item_id: device8.id, rate: 7000 }], trade_ins: [],
  }})
  const closeResult = await rpc('close_financial_year', { p_fy_id: fy })
  ok(closeResult?.items_carried >= 1, 'FY close carries unsold stock forward (copy-based)', closeResult)
  const carriedTiDevice = await sql`
    SELECT count(*)::int AS n FROM public.inventory_items
     WHERE origin_inventory_item_id = ${tiR.inventory_item_id} AND opening_entry_type = 'carried_forward'`.then((r) => r[0].n)
  ok(carriedTiDevice === 1, 'in-stock trade-in device carried forward as a new inventory row (provenance preserved)')
  ok((await sql`SELECT count(*)::int AS n FROM public.trade_ins WHERE id = ${tiR.id}`)[0].n === 1,
    'trade-in history row survives rollover (relationship intact)')
  const carried = await sql`
    SELECT id FROM public.inventory_items WHERE origin_inventory_item_id = ${tiR.inventory_item_id}`.then((r) => r[0].id as string)
  ok((await sql`SELECT source FROM public.inventory_items WHERE id = ${carried}`)[0].source === 'trade_in',
    'carried copy preserves the trade_in provenance')
  await rpcFails('cancel_sale', { p_sale_id: saleR.sale_id }, 'closed financial year',
    'cancelling a sale in the closed FY rejected (history is frozen)')
  const pfClosedItems = await sql`SELECT id, inventory_item_id FROM public.proforma_invoice_items WHERE proforma_invoice_id = ${pfClosed.proforma_id}`
  await rpcFails('create_sale', { payload: {
    proforma_id: pfClosed.proforma_id, date: '2031-04-10',
    items: pfClosedItems.map((r: any) => ({ proforma_item_id: r.id, inventory_item_id: r.inventory_item_id })),
    trade_ins: [], paid: 0, bank_account_id: bank,
  }}, 'closed financial year', 'conversion of a proforma from a closed FY rejected')

  // ═══════════════════════════════════════════════════════════════════════
  console.log('── L. Execution security posture ──')
  // ═══════════════════════════════════════════════════════════════════════

  const execChecks = await sql`
    SELECT
      has_function_privilege('anon', 'public.create_sale(jsonb)', 'EXECUTE') AS anon_create_sale,
      has_function_privilege('authenticated', 'public.create_sale(jsonb)', 'EXECUTE') AS auth_create_sale,
      has_function_privilege('anon', 'public.void_proforma(uuid)', 'EXECUTE') AS anon_void,
      has_function_privilege('authenticated', 'public.void_proforma(uuid)', 'EXECUTE') AS auth_void,
      has_function_privilege('anon', 'public.update_proforma(jsonb)', 'EXECUTE') AS anon_update_pf,
      has_function_privilege('authenticated', 'public.update_proforma(jsonb)', 'EXECUTE') AS auth_update_pf,
      has_function_privilege('service_role', 'public.create_sale(jsonb)', 'EXECUTE') AS svc_create_sale`.then((r) => r[0] as any)
  ok(execChecks.anon_create_sale === false && execChecks.auth_create_sale === true && execChecks.svc_create_sale === true,
    'create_sale executable by authenticated/service_role only', execChecks)
  ok(execChecks.anon_void === false && execChecks.auth_void === true, 'void_proforma executable by authenticated only')
  ok(execChecks.anon_update_pf === false && execChecks.auth_update_pf === true, 'update_proforma executable by authenticated only')

  // ═══════════════════════════════════════════════════════════════════════
  console.log('── M. Referential integrity sweep ──')
  // ═══════════════════════════════════════════════════════════════════════

  const dangling = await sql`
    SELECT
      (SELECT count(*)::int FROM public.trade_ins t
        WHERE NOT EXISTS (SELECT 1 FROM public.inventory_items i WHERE i.id = t.inventory_item_id)) AS ti_no_inv,
      (SELECT count(*)::int FROM public.trade_ins t
        WHERE NOT EXISTS (SELECT 1 FROM public.sales s WHERE s.id = t.sale_id)) AS ti_no_sale,
      (SELECT count(*)::int FROM public.purchase_items pi
        WHERE NOT EXISTS (SELECT 1 FROM public.purchases p WHERE p.id = pi.purchase_id)) AS pi_no_purch,
      (SELECT count(*)::int FROM public.sale_items si
        WHERE NOT EXISTS (SELECT 1 FROM public.inventory_items i WHERE i.id = si.inventory_item_id)) AS si_no_inv,
      (SELECT count(*)::int FROM public.sales s
        WHERE s.proforma_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.proforma_invoices p WHERE p.id = s.proforma_id)) AS sale_no_pf`.then((r) => r[0] as any)
  ok(dangling.ti_no_inv === 0 && dangling.ti_no_sale === 0 && dangling.pi_no_purch === 0 && dangling.si_no_inv === 0 && dangling.sale_no_pf === 0,
    'zero dangling references anywhere (trade-ins, mappings, links)', dangling)

  // ═══════════════════════════════════════════════════════════════════════
  console.log('── Teardown ──')
  // ═══════════════════════════════════════════════════════════════════════

  // FK-safe teardown via the shared helper (also removes the auto-created
  // rollover FY 2031-32 and every fixture it references).
  const allFys = [fy, closedFy,
    ...(await sql`SELECT id FROM public.financial_years WHERE start_date = '2031-04-01'`).map((r: any) => r.id)]
  await cleanupFixtures(allFys)

  const leftovers = await sql`
    SELECT
      (SELECT count(*)::int FROM public.sales WHERE financial_year_id IN ${sql(allFys)}) AS sales,
      (SELECT count(*)::int FROM public.inventory_items WHERE financial_year_id IN ${sql(allFys)}) AS inv,
      (SELECT count(*)::int FROM public.proforma_invoices WHERE financial_year_id IN ${sql(allFys)}) AS pf,
      (SELECT count(*)::int FROM public.purchases WHERE financial_year_id IN ${sql(allFys)}) AS pur`.then((r) => r[0] as any)
  ok(leftovers.sales === 0 && leftovers.inv === 0 && leftovers.pf === 0 && leftovers.pur === 0,
    'all fixtures removed (TEST DB back to its prior business state)', leftovers)

  await sql.end()
  console.log(`\n=== ${passes} passed, ${failures} failed ===\n`)
  process.exit(failures > 0 ? 1 : 0)
}

main().catch(async (e) => {
  console.error(e)
  try { await sql.end() } catch {}
  process.exit(1)
})
