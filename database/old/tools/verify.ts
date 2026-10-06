/**
 * FUSIONONE TEST database — end-to-end business verification (spec §38).
 *
 * Exercises every transactional RPC through the REAL PostgREST surface with
 * the REAL test-owner JWT (the same authentication mechanism the app uses),
 * verifying:
 *   - bill-number formats + counter continuation
 *   - create sale (multi-table: sale, items, inventory sold, trade-in
 *     purchase + inventory + link, payment, ledger)
 *   - receive payment / pay purchase
 *   - cancel sale (restock + reversal + resold detection)
 *   - delete sale guards (paid / resold)
 *   - create purchase (stock + payment)
 *   - trade-in recovery purchase bill (PUR-26-27 quirk)
 *   - update sale (N+1 → atomic + total-vs-paid guard)
 *   - create proforma
 *   - add funds / transfer (balance checks, exact messages)
 *   - close FY (copy carry-forward + idempotent opening balances)
 *   - RLS: anon deny-all, owner allow
 *
 * Leaves the database in the SEEDED state (runs in a dedicated scratch FY,
 * then rolls back by deleting its artifacts).
 *
 * Usage: bun run verify.ts
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
const sql = postgres(env.TEST_SUPABASE_DB_URL, { max: 1, prepare: false, idle_timeout: 5 })

// ── Supabase REST helpers (the app's real transport) ────────────────────────

const URL_ = env.TEST_SUPABASE_URL
const PUB = env.TEST_SUPABASE_PUBLISHABLE_KEY

async function signIn(): Promise<string> {
  const res = await fetch(`${URL_}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: PUB, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: env.TEST_USER_EMAIL, password: env.TEST_USER_PASSWORD }),
  })
  if (!res.ok) throw new Error(`sign-in failed: ${res.status}`)
  const { access_token } = await res.json()
  return access_token
}

let TOKEN = ''

async function rpc<T = unknown>(fn: string, params: unknown): Promise<T> {
  const res = await fetch(`${URL_}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: PUB, Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  })
  const body = await res.json()
  if (!res.ok) {
    throw Object.assign(new Error(body?.message ?? `rpc ${fn} failed`), { code: body?.code, status: res.status, body })
  }
  return body as T
}

let passed = 0
let failed = 0
function check(name: string, cond: boolean, extra = '') {
  if (cond) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.log(`  ✗ ${name} ${extra}`)
  }
}

async function expectRpcError(name: string, fn: string, params: unknown, messagePart: string) {
  try {
    await rpc(fn, params)
    check(name, false, '(no error raised)')
  } catch (e: any) {
    check(name, String(e.message).includes(messagePart), `got: "${e.message}"`)
  }
}

// ── The verification suite ──────────────────────────────────────────────────

async function main() {
  TOKEN = await signIn()
  console.log('Signed in as test owner.')

  // Scratch financial year (isolated from the seeded/other stores' years — 2032 range).
  const fy = await sql`INSERT INTO financial_years (start_date, end_date, status) VALUES ('2032-04-01', '2033-03-31', 'active') RETURNING id, start_date, end_date`
  const fyId = fy[0].id
  console.log(`Scratch FY: ${fyId}`)

  const store = await sql`SELECT id FROM store LIMIT 1`
  const bank = await sql`SELECT id FROM bank_accounts WHERE is_cash = false LIMIT 1`
  const party = await sql`SELECT id FROM parties LIMIT 1`
  const bankId = bank[0].id
  const partyId = party[0].id

  try {
    // ═══ 1. Bill number allocation (atomic) ═══
    console.log('\n── allocate_bill_numbers ──')
    const alloc = await rpc<{ sale_bill: string; purchase_bill: string; proforma_bill: string }>('allocate_bill_numbers', {
      p_fy_id: fyId, p_sales: 0, p_purchases: 0, p_proformas: 0,
    })
    check('sale bill format SAL-2032-33-0001', alloc.sale_bill === 'SAL-2032-33-0001', JSON.stringify(alloc))
    check('purchase bill format PUR-2032-33-0001', alloc.purchase_bill === 'PUR-2032-33-0001')
    check('proforma bill format PI-2032-33-0001', alloc.proforma_bill === 'PI-2032-33-0001')

    // ═══ 2. create_purchase (stock + payment) ═══
    console.log('\n── create_purchase ──')
    const pur = await rpc<{ purchase_id: string; bill_number: string }>('create_purchase', {
      payload: {
        party_id: partyId, date: '2032-04-05', total: 30000, paid: 20000, due: 10000,
        bank_account_id: bankId, payment_mode_id: null, financial_year_id: fyId,
        items: [
          { brand: 'TestPhone', model: 'V1', imei: '111111111111111', ram_rom: '8/128', color: 'Black', purchase_price: 15000, base_selling_price: 18000 },
          { brand: 'TestPhone', model: 'V2', imei: '222222222222222', ram_rom: '8/128', color: 'White', purchase_price: 15000, base_selling_price: 18000 },
        ],
      },
    })
    check('purchase bill PUR-2032-33-0001', pur.bill_number === 'PUR-2032-33-0001', pur.bill_number)
    const purItems = await sql`SELECT count(*)::int AS n FROM purchase_items pi JOIN inventory_items i ON i.id = pi.inventory_item_id WHERE pi.purchase_id = ${pur.purchase_id} AND i.status = 'in_stock'`
    check('2 inventory rows created in_stock', purItems[0].n === 2)
    const purPay = await sql`SELECT count(*)::int AS n FROM payments_out WHERE purchase_id = ${pur.purchase_id}`
    check('payments_out row for the paid part', purPay[0].n === 1)
    const purTx = await sql`SELECT sum(amount)::numeric AS amt FROM account_transactions WHERE reference_type = 'purchase' AND reference_id = ${pur.purchase_id}`
    check('ledger debit of 20000', Number(purTx[0].amt) === 20000)

    await expectRpcError(
      'duplicate in-stock IMEI rejected with exact message',
      'create_purchase',
      { payload: { party_id: partyId, date: '2032-04-06', total: 1, paid: 0, due: 1, bank_account_id: bankId, payment_mode_id: null, financial_year_id: fyId, items: [{ brand: 'X', model: 'Y', imei: '111111111111111', ram_rom: '8', color: 'C', purchase_price: 1, base_selling_price: 1 }] } },
      'IMEI 111111111111111 is already in stock in the database.',
    )

    // ═══ 3. create_sale (items + trade-in + payment) ═══
    console.log('\n── create_sale ──')
    const invRows = await sql`SELECT id FROM inventory_items WHERE imei IN ('111111111111111', '222222222222222') ORDER BY imei`
    const sale = await rpc<{ sale_id: string; bill_number: string }>('create_sale', {
      payload: {
        party_id: partyId, date: '2032-04-10', total: 36000, discount: 1000, trade_in_credit: 5000,
        final_total: 30000, paid: 25000, due: 5000, bank_account_id: bankId, payment_mode_id: null,
        financial_year_id: fyId,
        items: [
          { inventory_item_id: invRows[0].id, sold_price: 18000 },
          { inventory_item_id: invRows[1].id, sold_price: 18000 },
        ],
        trade_ins: [
          { brand: 'OldPhone', model: 'X', imei: '333333333333333', ram_rom: '4/64', color: 'Grey', credit_value: 5000, mrp: 8000, document_url: null },
        ],
      },
    })
    check('sale bill SAL-2032-33-0001', sale.bill_number === 'SAL-2032-33-0001', sale.bill_number)

    const soldCount = await sql`SELECT count(*)::int AS n FROM inventory_items WHERE id IN (${invRows[0].id}, ${invRows[1].id}) AND status = 'sold'`
    check('both items marked sold', soldCount[0].n === 2)

    const trd = await sql`
      SELECT t.*, p.bill_number AS purchase_bill, i.status AS new_item_status
        FROM trade_ins t
        JOIN purchases p ON p.id = (SELECT purchase_id FROM purchase_items pi WHERE pi.inventory_item_id = t.new_inventory_item_id LIMIT 1)
        JOIN inventory_items i ON i.id = t.new_inventory_item_id
       WHERE t.sale_id = ${sale.sale_id}`
    check('trade-in created with hidden PUR-TRD purchase', trd[0]?.purchase_bill === 'PUR-TRD-2032-33-0002', trd[0]?.purchase_bill)
    check('trade-in inventory item in_stock', trd[0]?.new_item_status === 'in_stock')

    const salePay = await sql`SELECT count(*)::int AS n FROM payments_in WHERE sale_id = ${sale.sale_id}`
    check('payments_in row for the paid part', salePay[0].n === 1)
    const saleTx = await sql`SELECT sum(amount)::numeric AS amt FROM account_transactions WHERE reference_type = 'sale' AND reference_id = ${sale.sale_id}`
    check('ledger credit of 25000', Number(saleTx[0].amt) === 25000)

    const counters = await sql`SELECT sale_counter, purchase_counter FROM financial_years WHERE id = ${fyId}`
    check('counters advanced (1 sale, 2 purchases)', counters[0].sale_counter === 1 && counters[0].purchase_counter === 2, JSON.stringify(counters[0]))

    await expectRpcError(
      'stock re-verification rejects sold items with exact message',
      'create_sale',
      { payload: { party_id: partyId, date: '2032-04-11', total: 1, discount: 0, trade_in_credit: 0, final_total: 1, paid: 0, due: 1, bank_account_id: bankId, payment_mode_id: null, financial_year_id: fyId, items: [{ inventory_item_id: invRows[0].id, sold_price: 1 }], trade_ins: [] } },
      'One or more selected items are no longer available in stock.',
    )

    // ═══ 4. receive_payment ═══
    console.log('\n── receive_payment ──')
    await rpc('receive_payment', { p_sale_id: sale.sale_id, p_amount: 3000, p_date: '2032-04-15', p_bank_account_id: bankId, p_payment_mode_id: null })
    const afterPay = await sql`SELECT paid, due FROM sales WHERE id = ${sale.sale_id}`
    check('paid 28000 / due 2000 after receiving 3000', Number(afterPay[0].paid) === 28000 && Number(afterPay[0].due) === 2000)
    await expectRpcError(
      'cannot exceed due amount',
      'receive_payment',
      { p_sale_id: sale.sale_id, p_amount: 99999, p_date: '2032-04-15', p_bank_account_id: bankId, p_payment_mode_id: null },
      'Cannot exceed due amount',
    )

    // ═══ 5. pay_purchase ═══
    console.log('\n── pay_purchase ──')
    await rpc('pay_purchase', { p_purchase_id: pur.purchase_id, p_amount: 10000, p_date: '2032-04-20', p_bank_account_id: bankId, p_payment_mode_id: null })
    const afterPurPay = await sql`SELECT paid, due FROM purchases WHERE id = ${pur.purchase_id}`
    check('purchase fully paid', Number(afterPurPay[0].paid) === 30000 && Number(afterPurPay[0].due) === 0)

    // ═══ 6. update_sale (atomic edit + guard) ═══
    console.log('\n── update_sale ──')
    const siRows = await sql`SELECT id FROM sale_items WHERE sale_id = ${sale.sale_id}`
    await rpc('update_sale', {
      payload: {
        sale_id: sale.sale_id, date: '2032-04-12', discount: 1500, total: 36000, final_total: 29500, due: 1500,
        items: siRows.map((r) => ({ sale_item_id: r.id, sold_price: 17500 })),
      },
    })
    const afterEdit = await sql`SELECT date, discount, final_total, due FROM sales WHERE id = ${sale.sale_id}`
    check('sale header updated atomically', new Date(afterEdit[0].date).toISOString().slice(0, 10) === '2032-04-12' && Number(afterEdit[0].final_total) === 29500)
    const editedPrices = await sql`SELECT sold_price FROM sale_items WHERE sale_id = ${sale.sale_id} ORDER BY id`
    check('per-item prices updated in one call', editedPrices.every((r) => Number(r.sold_price) === 17500))

    await expectRpcError(
      'total-below-paid guard with exact message',
      'update_sale',
      { payload: { sale_id: sale.sale_id, date: '2032-04-12', discount: 99999, total: 36000, final_total: 100, due: 0, items: [] } },
      'cannot be less than the already-received payment',
    )

    // ═══ 7. create_trade_in_purchase_bill (resold recovery, PUR-26-27 quirk) ═══
    console.log('\n── create_trade_in_purchase_bill ──')
    // First: mark the trade-in device as resold (sold via another sale)
    await sql`UPDATE inventory_items SET status = 'sold' WHERE id = ${trd[0].new_inventory_item_id}`
    const recoveryBill = await rpc<string>('create_trade_in_purchase_bill', {
      p_sale_id: sale.sale_id, p_trade_in_id: trd[0].id,
    })
    check('recovery bill uses the 2-digit-year format PUR-32-33-0003', recoveryBill === 'PUR-32-33-0003', recoveryBill)

    // ═══ 8. cancel_sale (restock + reversals + resold detection) ═══
    console.log('\n── cancel_sale ──')
    const cancelResult = await rpc<{ resold: Array<{ id: string }> }>('cancel_sale', { p_sale_id: sale.sale_id })
    const cancelled = await sql`SELECT status FROM sales WHERE id = ${sale.sale_id}`
    check('sale marked cancelled', cancelled[0].status === 'cancelled')
    const restocked = await sql`SELECT count(*)::int AS n FROM inventory_items WHERE id IN (${invRows[0].id}, ${invRows[1].id}) AND status = 'in_stock'`
    check('sold items restocked', restocked[0].n === 2)
    const reversals = await sql`SELECT sum(amount)::numeric AS amt FROM account_transactions WHERE reference_type = 'sale_cancelled' AND reference_id = ${sale.sale_id}`
    check('payment reversal debits total the received 28000', Number(reversals[0].amt) === 28000)
    check('resold trade-in reported for the Action Required panel', cancelResult.resold.length === 1)

    // ═══ 9. delete_sale guards ═══
    console.log('\n── delete_sale ──')
    await expectRpcError(
      'paid sale cannot be deleted (exact message)',
      'delete_sale',
      { p_sale_id: sale.sale_id },
      'Cannot delete: payment has already been received.',
    )

    // A fresh unpaid sale CAN be deleted.
    const inv3 = await sql`INSERT INTO inventory_items (brand, model, imei, ram_rom, color, purchase_price, base_selling_price, status, source, financial_year_id, opening_entry_type) VALUES ('TestPhone', 'V3', '444444444444444', '8/128', 'Blue', 5000, 6000, 'in_stock', 'purchase', ${fyId}, 'direct') RETURNING id`
    const delSale = await rpc<{ sale_id: string }>('create_sale', {
      payload: {
        party_id: partyId, date: '2032-05-01', total: 6000, discount: 0, trade_in_credit: 0,
        final_total: 6000, paid: 0, due: 6000, bank_account_id: bankId, payment_mode_id: null,
        financial_year_id: fyId, items: [{ inventory_item_id: inv3[0].id, sold_price: 6000 }], trade_ins: [],
      },
    })
    await rpc('delete_sale', { p_sale_id: delSale.sale_id })
    const deletedGone = await sql`SELECT count(*)::int AS n FROM sales WHERE id = ${delSale.sale_id}`
    check('unpaid sale hard-deleted', deletedGone[0].n === 0)
    const restockCheck = await sql`SELECT status FROM inventory_items WHERE id = ${inv3[0].id}`
    check('deleted sale items restocked', restockCheck[0].status === 'in_stock')

    // ═══ 10. create_proforma ═══
    console.log('\n── create_proforma ──')
    const pro = await rpc<{ proforma_id: string; bill_number: string }>('create_proforma', {
      payload: {
        party_id: partyId, date: '2032-05-02', total: 25000, discount: 500, trade_in_credit: 2000,
        final_total: 22500, financial_year_id: fyId,
        items: [{ description: 'Phone X', qty: 1, rate: 25000, discount: 0, value: 25000 }],
        trade_ins: [{ description: 'Old Y', qty: 1, rate: 2000, value: 2000 }],
      },
    })
    check('proforma bill PI-2032-33-0001', pro.bill_number === 'PI-2032-33-0001', pro.bill_number)
    const proItems = await sql`SELECT count(*)::int AS n FROM proforma_invoice_items WHERE proforma_invoice_id = ${pro.proforma_id}`
    const proTrades = await sql`SELECT count(*)::int AS n FROM proforma_trade_ins WHERE proforma_invoice_id = ${pro.proforma_id}`
    check('proforma items + trade-ins created', proItems[0].n === 1 && proTrades[0].n === 1)

    // ═══ 11. add_funds / transfer_funds ═══
    console.log('\n── add_funds / transfer_funds ──')
    await rpc('add_funds', { p_bank_account_id: bankId, p_amount: 100000, p_date: '2032-05-03', p_financial_year_id: fyId, p_notes: ' capital ' })
    const cash2 = await sql`SELECT id FROM bank_accounts WHERE is_cash = true LIMIT 1`
    await expectRpcError(
      'same-account transfer rejected',
      'transfer_funds',
      { p_from_bank_account_id: bankId, p_to_bank_account_id: bankId, p_amount: 100, p_date: '2032-05-03', p_financial_year_id: fyId, p_notes: null },
      'Source and destination accounts must be different',
    )
    await rpc('transfer_funds', { p_from_bank_account_id: bankId, p_to_bank_account_id: cash2[0].id, p_amount: 20000, p_date: '2032-05-04', p_financial_year_id: fyId, p_notes: ' test ' })
    const transferPair = await sql`SELECT count(*)::int AS n FROM account_transactions WHERE reference_type = 'transfer' AND financial_year_id = ${fyId} AND transfer_group_id IS NOT NULL`
    check('transfer created a paired debit+credit group', transferPair[0].n === 2)
    const notesTrim = await sql`SELECT notes FROM account_transactions WHERE reference_type = 'add_funds' AND financial_year_id = ${fyId} LIMIT 1`
    check('notes trimmed on the ledger entry', notesTrim[0].notes === 'capital', notesTrim[0].notes)
    await expectRpcError(
      'date-outside-FY rejected with exact message',
      'add_funds',
      { p_bank_account_id: bankId, p_amount: 1, p_date: '2033-06-01', p_financial_year_id: fyId, p_notes: null },
      'Date must be within financial year range',
    )

    // ═══ 12. close_financial_year (copy carry-forward + idempotent openings) ═══
    console.log('\n── close_financial_year ──')
    const close1 = await rpc<{ items_carried: number; accounts_carried: number }>('close_financial_year', { p_fy_id: fyId })
    check('carry-forward count = in-stock items (copy semantics)', close1.items_carried >= 3, JSON.stringify(close1))
    check('opening balances carried', close1.accounts_carried >= 1)

    const nextFy = await sql`SELECT id, start_date, end_date FROM financial_years WHERE start_date = '2033-04-01'`
    check('next FY auto-created 2033-04-01 → 2034-03-31', nextFy.length === 1 && new Date(nextFy[0].end_date).toISOString().slice(0, 10) === '2034-03-31')
    const carriedRows = await sql`SELECT count(*)::int AS n FROM inventory_items WHERE financial_year_id = ${nextFy[0].id} AND opening_entry_type = 'carried_forward'`
    check('carried rows exist with origin links', carriedRows[0].n === close1.items_carried)
    const originOk = await sql`SELECT count(*)::int AS n FROM inventory_items WHERE financial_year_id = ${nextFy[0].id} AND opening_entry_type = 'carried_forward' AND origin_inventory_item_id IS NULL`
    check('every carried row links its origin', originOk[0].n === 0)
    const obNotes = await sql`SELECT notes FROM account_transactions WHERE reference_type = 'opening_balance' AND financial_year_id = ${nextFy[0].id} LIMIT 1`
    check('opening-balance notes use the FY 2032–33 en-dash label', obNotes[0]?.notes === 'Opening balance carried forward from FY 2032–33', obNotes[0]?.notes)

    // Idempotency: the source FY is closed now — a second close must be rejected.
    await expectRpcError(
      'closing an already-closed FY rejected',
      'close_financial_year',
      { p_fy_id: fyId },
      'not found or already closed',
    )

    // ═══ 13. RLS — anon deny-all / owner allow ═══
    console.log('\n── RLS ──')
    const anon = await fetch(`${URL_}/rest/v1/sales?select=id&limit=1`, { headers: { apikey: PUB } })
    const anonBody = await anon.json()
    check('anon reads are denied by RLS', Array.isArray(anonBody) && anonBody.length === 0)
    const owner = await fetch(`${URL_}/rest/v1/sales?select=id&limit=1`, { headers: { apikey: PUB, Authorization: `Bearer ${TOKEN}` } })
    check('owner reads allowed', owner.status === 200)

    console.log(`\n════ RESULT: ${passed} passed, ${failed} failed ════`)
    if (failed > 0) process.exitCode = 1  // exitCode (not exit) so the finally-cleanup still runs
  } finally {
    // ── Cleanup: remove ALL scratch-FY artifacts (FK-safe order) ──
    console.log('\nCleaning up scratch data...')
    const nextFyIds = await sql`SELECT id FROM financial_years WHERE start_date >= '2033-04-01'`
    for (const nfy of nextFyIds) {
      await sql`DELETE FROM account_transactions WHERE financial_year_id = ${nfy.id}`
      await sql`DELETE FROM inventory_items WHERE financial_year_id = ${nfy.id}`
      await sql`DELETE FROM financial_years WHERE id = ${nfy.id}`
    }
    await sql`DELETE FROM account_transactions WHERE financial_year_id = ${fyId}`
    await sql`DELETE FROM payments_in WHERE financial_year_id = ${fyId}`
    await sql`DELETE FROM payments_out WHERE financial_year_id = ${fyId}`
    await sql`DELETE FROM account_fund_entries WHERE financial_year_id = ${fyId}`
    await sql`DELETE FROM account_transfers WHERE financial_year_id = ${fyId}`
    await sql`DELETE FROM trade_ins WHERE sale_id IN (SELECT id FROM sales WHERE financial_year_id = ${fyId})`
    await sql`DELETE FROM sale_items WHERE sale_id IN (SELECT id FROM sales WHERE financial_year_id = ${fyId})`
    await sql`DELETE FROM sales WHERE financial_year_id = ${fyId}`
    await sql`DELETE FROM purchase_items WHERE purchase_id IN (SELECT id FROM purchases WHERE financial_year_id = ${fyId})`
    await sql`DELETE FROM purchases WHERE financial_year_id = ${fyId}`
    await sql`DELETE FROM inventory_items WHERE financial_year_id = ${fyId}`
    await sql`DELETE FROM proforma_invoice_items WHERE proforma_invoice_id IN (SELECT id FROM proforma_invoices WHERE financial_year_id = ${fyId})`
    await sql`DELETE FROM proforma_trade_ins WHERE proforma_invoice_id IN (SELECT id FROM proforma_invoices WHERE financial_year_id = ${fyId})`
    await sql`DELETE FROM proforma_invoices WHERE financial_year_id = ${fyId}`
    await sql`DELETE FROM financial_years WHERE id = ${fyId}`
    console.log('Scratch FY removed; database back to the seeded state.')
    await sql.end()
  }
}

main().catch(async (e) => {
  console.error('VERIFICATION CRASHED:', e)
  process.exit(1)
})
