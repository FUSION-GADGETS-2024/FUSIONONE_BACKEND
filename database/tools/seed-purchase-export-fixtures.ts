/**
 * FUSIONONE — Analytics Purchase-tab & Excel-export controlled TEST fixtures
 * (implementation spec §11).
 *
 * Extends the existing TEST dataset with the coverage the five exports
 * need, filling EXACTLY the gaps found in the §3 boundary audit:
 *
 * FY 2026-27 (closed — direct SQL inserts, matching every table invariant):
 *   - a fully UNPAID supplier purchase (paid=0, due=total)
 *   - payments recorded on dates DIFFERENT from their associated bill
 *     dates (a later payment-in on an unpaid July sale; a later
 *     payment-out on the partially-paid August purchase)
 *   - Q4 (Jan–Mar 2027) records: a January sale, a January purchase,
 *     January/March payments and the 31 March 2027 financial-year-boundary
 *     sale (fully paid, same-day payment)
 *   - the 1 April 2026 financial-year-boundary purchase (fully paid,
 *     same-day payment) whose device is later resold on 31 March 2027 —
 *     the full acquisition→resale chain inside one FY
 *   - an ACCOUNT TRANSFER between the two accounts (the exact invariant
 *     the create_account_transfer RPC maintains: one account_transfers row
 *     + two ledger legs sharing a transfer_group_id) so the Money
 *     Register's internal-transfer classification is exercised
 *
 * Safety (spec §§2.2–2.3): TEST Supabase ONLY (safety abort unless the
 * TEST project ref); pure SQL inserts — no application RPCs, no frontend
 * flows, no message-dispatch paths. No WhatsApp message can be armed.
 *
 * Idempotent: skips when the fixture marker (PUR-2026-27-0012) exists.
 * `--cleanup` removes exactly the fixture rows (by fixed UUIDs / bill
 * numbers), reverts the two balance updates on pre-existing fixture rows
 * and restores the FY counters. Unrelated TEST data is never touched.
 */
import postgres from 'postgres'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const raw = readFileSync(join(HERE, '.env'), 'utf8')
const env: Record<string, string> = Object.fromEntries(
  raw.split('\n').filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => {
    const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
  }),
)
const DB_URL = env.TEST_SUPABASE_DB_URL
if (!DB_URL.includes('egdrnhtmclvhsfjvhyam')) throw new Error('SAFETY ABORT: not the TEST project.')
const sql = postgres(DB_URL, { ssl: { rejectUnauthorized: false }, max: 1, prepare: false })

// ── Fixed identities (deterministic, cleanup-addressable) ────────────────────

const FY2627 = 'c2ff174d-2801-42a1-a83e-5f3737911a51'
const HDFC = 'bbe198c7-1ff7-4d75-bdde-5264eb0180b1'
const CASH = 'dca78a9a-ea15-47e8-bc3e-5e3de9317c5e'
const UPI = '2d05de0b-0c6e-4d70-8079-83203a21ce48'

// Pre-existing fixture rows (seed-reports-fixtures.ts identities)
const P_A = 'a1000000-0000-4000-8000-000000000001' // Anaya Gupta (customer)
const P_B = 'a1000000-0000-4000-8000-000000000002' // Vikram Mehta (customer)
const P_S = 'a1000000-0000-4000-8000-000000000003' // Gupta Electronics (supplier)
const PUR_B = 'c1000000-0000-4000-8000-000000000011' // PUR-2026-27-0011 (partial, dated 2026-08-15)
const SAL_13 = 'd1000000-0000-4000-8000-000000000013' // SAL-2026-27-0013 (unpaid, dated 2026-07-20)
const INV_C55 = 'b1000000-0000-4000-8000-000000000012' // Realme C55 (in-stock trade-in device)

// New inventory
const INV_G84 = 'b1000000-0000-4000-8000-000000000101' // Motorola Moto G84 (bought 1 Apr 2026, sold 31 Mar 2027)
const INV_M14 = 'b1000000-0000-4000-8000-000000000102' // Samsung Galaxy M14 (Jan 2027, stays in stock)
const INV_X6 = 'b1000000-0000-4000-8000-000000000103' // Poco X6 5G (Jan 2027, stays in stock)

// New purchases
const PUR_12 = 'c1000000-0000-4000-8000-000000000012' // PUR-2026-27-0012 — 1 Apr 2026 boundary, fully paid
const PUR_13 = 'c1000000-0000-4000-8000-000000000013' // PUR-2026-27-0013 — 15 Jan 2027, fully UNPAID

// New sales
const SAL_17 = 'd1000000-0000-4000-8000-000000000017' // SAL-2026-27-0017 — 18 Jan 2027, unpaid trade-in resale
const SAL_18 = 'd1000000-0000-4000-8000-000000000018' // SAL-2026-27-0018 — 31 Mar 2027 boundary, fully paid

// New payments
const POUT_12 = '1b100000-0000-4000-8000-000000000012' // 13500 on PUR-0012, 2026-04-01 (same day, HDFC/UPI)
const POUT_11B = '1b100000-0000-4000-8000-000000000013' // 20000 on PUR-0011, 2027-03-20 (LATER than the bill, Cash)
const PIN_13B = '1a100000-0000-4000-8000-000000000007' // 5000 on SAL-0013, 2027-01-20 (LATER than the bill, Cash)
const PIN_18 = '1a100000-0000-4000-8000-000000000008' // 15999 on SAL-0018, 2027-03-31 (same day, HDFC/UPI)

// The account transfer (the create_account_transfer invariant, direct SQL
// because FY 2026-27 is closed)
const TRANSFER = '3c100000-0000-4000-8000-000000000001'
const TRANSFER_GROUP = '3e100000-0000-4000-8000-000000000001'
const TXN_TRF_OUT = '3d100000-0000-4000-8000-000000000001'
const TXN_TRF_IN = '3d100000-0000-4000-8000-000000000002'

// ── Seeding ──────────────────────────────────────────────────────────────────

async function seeded(): Promise<boolean> {
  const rows = await sql`select 1 from public.purchases where id = ${PUR_12} limit 1`
  return rows.length > 0
}

async function insertFixtures(): Promise<void> {
  await sql.begin(async (tx) => {
    // Inventory: the boundary-purchase device (later resold) + two devices
    // on the unpaid January purchase (both remain in stock).
    await tx`insert into public.inventory_items (id, brand, model, imei, ram_rom, color, purchase_price, base_selling_price, status, source, financial_year_id, created_at, opening_entry_type)
             values (${INV_G84}, 'Motorola', 'Moto G84 5G', '860000010000401', '12/256', 'Viva Magenta', '13500', '15999', 'sold', 'purchase', ${FY2627}, '2026-04-01 10:00:00+00', 'direct')`
    await tx`insert into public.inventory_items (id, brand, model, imei, ram_rom, color, purchase_price, base_selling_price, status, source, financial_year_id, created_at, opening_entry_type)
             values (${INV_M14}, 'Samsung', 'Galaxy M14', '860000010000402', '6/128', 'Arctic Blue', '9500', '11999', 'in_stock', 'purchase', ${FY2627}, '2027-01-15 10:00:00+00', 'direct')`
    await tx`insert into public.inventory_items (id, brand, model, imei, ram_rom, color, purchase_price, base_selling_price, status, source, financial_year_id, created_at, opening_entry_type)
             values (${INV_X6}, 'Poco', 'X6 5G', '860000010000403', '8/256', 'Black', '14500', '17499', 'in_stock', 'purchase', ${FY2627}, '2027-01-15 10:00:00+00', 'direct')`

    // PUR-2026-27-0012 — the 1 April 2026 financial-year START boundary
    // purchase, fully paid the same day.
    await tx`insert into public.purchases (id, bill_number, party_id, total, paid, due, bank_account_id, payment_mode_id, date, financial_year_id, status, created_at)
             values (${PUR_12}, 'PUR-2026-27-0012', ${P_S}, '13500', '13500', '0', ${HDFC}, ${UPI}, '2026-04-01', ${FY2627}, 'active', '2026-04-01 10:00:00+00')`
    await tx`insert into public.purchase_items (purchase_id, inventory_item_id) values (${PUR_12}, ${INV_G84})`

    // PUR-2026-27-0013 — the fully UNPAID supplier purchase (Q4 coverage).
    await tx`insert into public.purchases (id, bill_number, party_id, total, paid, due, bank_account_id, payment_mode_id, date, financial_year_id, status, created_at)
             values (${PUR_13}, 'PUR-2026-27-0013', ${P_S}, '24000', '0', '24000', ${HDFC}, null, '2027-01-15', ${FY2627}, 'active', '2027-01-15 10:00:00+00')`
    await tx`insert into public.purchase_items (purchase_id, inventory_item_id) values (${PUR_13}, ${INV_M14})`
    await tx`insert into public.purchase_items (purchase_id, inventory_item_id) values (${PUR_13}, ${INV_X6})`

    // SAL-2026-27-0017 — Q4 sale of the in-stock trade-in device, unpaid.
    await tx`insert into public.sales (id, bill_number, party_id, total, discount, trade_in_credit, final_total, paid, due, bank_account_id, payment_mode_id, date, financial_year_id, status, created_at)
             values (${SAL_17}, 'SAL-2026-27-0017', ${P_B}, '2500', '0', '0', '2500', '0', '2500', ${HDFC}, ${UPI}, '2027-01-18', ${FY2627}, 'active', '2027-01-18 10:00:00+00')`
    await tx`insert into public.sale_items (sale_id, inventory_item_id, sold_price) values (${SAL_17}, ${INV_C55}, '2500')`
    await tx`update public.inventory_items set status = 'sold' where id = ${INV_C55}`

    // SAL-2026-27-0018 — the 31 March 2027 financial-year END boundary
    // sale, fully paid the same day (the Moto G84's resale).
    await tx`insert into public.sales (id, bill_number, party_id, total, discount, trade_in_credit, final_total, paid, due, bank_account_id, payment_mode_id, date, financial_year_id, status, created_at)
             values (${SAL_18}, 'SAL-2026-27-0018', ${P_A}, '15999', '0', '0', '15999', '15999', '0', ${HDFC}, ${UPI}, '2027-03-31', ${FY2627}, 'active', '2027-03-31 10:00:00+00')`
    await tx`insert into public.sale_items (sale_id, inventory_item_id, sold_price) values (${SAL_18}, ${INV_G84}, '15999')`
    await tx`update public.inventory_items set status = 'sold' where id = ${INV_G84}`

    // Payments + ledger rows (payments_out / payments_in references — the
    // same convention the established fixtures use).
    await tx`insert into public.payments_out (id, purchase_id, party_id, amount, bank_account_id, payment_mode_id, date, financial_year_id, created_at)
             values (${POUT_12}, ${PUR_12}, ${P_S}, '13500', ${HDFC}, ${UPI}, '2026-04-01', ${FY2627}, '2026-04-01 11:00:00+00')`
    await tx`insert into public.account_transactions (bank_account_id, payment_mode_id, type, amount, date, reference_type, reference_id, financial_year_id)
             values (${HDFC}, ${UPI}, 'debit', '13500', '2026-04-01', 'payment_out', ${POUT_12}, ${FY2627})`

    await tx`insert into public.payments_out (id, purchase_id, party_id, amount, bank_account_id, payment_mode_id, date, financial_year_id, created_at)
             values (${POUT_11B}, ${PUR_B}, ${P_S}, '20000', ${CASH}, null, '2027-03-20', ${FY2627}, '2027-03-20 11:00:00+00')`
    await tx`insert into public.account_transactions (bank_account_id, payment_mode_id, type, amount, date, reference_type, reference_id, financial_year_id)
             values (${CASH}, null, 'debit', '20000', '2027-03-20', 'payment_out', ${POUT_11B}, ${FY2627})`
    // The bill's authoritative balances move with the payment.
    await tx`update public.purchases set paid = '79000', due = '30000' where id = ${PUR_B}`

    await tx`insert into public.payments_in (id, sale_id, party_id, amount, bank_account_id, payment_mode_id, date, financial_year_id, created_at)
             values (${PIN_13B}, ${SAL_13}, ${P_A}, '5000', ${CASH}, null, '2027-01-20', ${FY2627}, '2027-01-20 11:00:00+00')`
    await tx`insert into public.account_transactions (bank_account_id, payment_mode_id, type, amount, date, reference_type, reference_id, financial_year_id)
             values (${CASH}, null, 'credit', '5000', '2027-01-20', 'payment_in', ${PIN_13B}, ${FY2627})`
    await tx`update public.sales set paid = '5000', due = '5999' where id = ${SAL_13}`

    await tx`insert into public.payments_in (id, sale_id, party_id, amount, bank_account_id, payment_mode_id, date, financial_year_id, created_at)
             values (${PIN_18}, ${SAL_18}, ${P_A}, '15999', ${HDFC}, ${UPI}, '2027-03-31', ${FY2627}, '2027-03-31 11:00:00+00')`
    await tx`insert into public.account_transactions (bank_account_id, payment_mode_id, type, amount, date, reference_type, reference_id, financial_year_id)
             values (${HDFC}, ${UPI}, 'credit', '15999', '2027-03-31', 'payment_in', ${PIN_18}, ${FY2627})`

    // The account transfer — the exact create_account_transfer invariant
    // (one transfer row + two ledger legs sharing a transfer_group_id),
    // inserted directly because FY 2026-27 is closed.
    await tx`insert into public.account_transfers (id, from_bank_account_id, to_bank_account_id, amount, date, notes, financial_year_id, created_at)
             values (${TRANSFER}, ${HDFC}, ${CASH}, '15000', '2027-03-25', 'Counter cash float', ${FY2627}, '2027-03-25 11:00:00+00')`
    await tx`insert into public.account_transactions (id, bank_account_id, payment_mode_id, type, amount, date, reference_type, reference_id, financial_year_id, notes, transfer_group_id)
             values (${TXN_TRF_OUT}, ${HDFC}, null, 'debit', '15000', '2027-03-25', 'transfer', ${TRANSFER}, ${FY2627}, 'Counter cash float', ${TRANSFER_GROUP})`
    await tx`insert into public.account_transactions (id, bank_account_id, payment_mode_id, type, amount, date, reference_type, reference_id, financial_year_id, notes, transfer_group_id)
             values (${TXN_TRF_IN}, ${CASH}, null, 'credit', '15000', '2027-03-25', 'transfer', ${TRANSFER}, ${FY2627}, 'Counter cash float', ${TRANSFER_GROUP})`

    // FY 2026-27 counters (bill numbers 0012–0013 and sales 0017–0018).
    await tx`update public.financial_years set sale_counter = 18, purchase_counter = 13 where id = ${FY2627}`
  })
}

// ── Cleanup ──────────────────────────────────────────────────────────────────

async function cleanup(): Promise<void> {
  await sql.begin(async (tx) => {
    // Ledger + transfer rows added by this fixture.
    await tx`delete from public.account_transactions where id in (${TXN_TRF_OUT}, ${TXN_TRF_IN})`
    await tx`delete from public.account_transfers where id = ${TRANSFER}`
    // Payments + their ledger references.
    await tx`delete from public.account_transactions where reference_id in (${POUT_12}, ${POUT_11B}, ${PIN_13B}, ${PIN_18})`
    await tx`delete from public.payments_out where id in (${POUT_12}, ${POUT_11B})`
    await tx`delete from public.payments_in where id in (${PIN_13B}, ${PIN_18})`
    // Revert the balance updates on the pre-existing fixture rows.
    await tx`update public.purchases set paid = '59000', due = '50000' where id = ${PUR_B}`
    await tx`update public.sales set paid = '0', due = '10999' where id = ${SAL_13}`
    // Fixture sales + items; restore the resold trade-in device.
    await tx`delete from public.sale_items where sale_id in (${SAL_17}, ${SAL_18})`
    await tx`delete from public.sales where id in (${SAL_17}, ${SAL_18})`
    await tx`update public.inventory_items set status = 'in_stock' where id = ${INV_C55}`
    // Fixture purchases + items + their devices.
    await tx`delete from public.purchase_items where purchase_id in (${PUR_12}, ${PUR_13})`
    await tx`delete from public.purchases where id in (${PUR_12}, ${PUR_13})`
    await tx`delete from public.inventory_items where id in (${INV_G84}, ${INV_M14}, ${INV_X6})`
    // Restore the pre-fixture counters.
    await tx`update public.financial_years set sale_counter = 16, purchase_counter = 11 where id = ${FY2627}`
  })
  console.log('Fixtures removed; balances and counters restored.')
}

// ── Main ─────────────────────────────────────────────────────────────────────

const mode = process.argv[2] ?? 'seed'

if (mode === '--cleanup') {
  if (!(await seeded())) {
    console.log('Nothing to clean (fixtures absent).')
  } else {
    await cleanup()
  }
} else {
  if (await seeded()) {
    console.log('Fixtures already present (idempotent skip).')
  } else {
    await insertFixtures()
    console.log('Fixtures inserted: unpaid purchase, off-bill-date payments, Q4 + FY-boundary records, account transfer.')
  }
}

await sql.end()
