/**
 * FUSIONONE — Reports controlled TEST fixtures (implementation spec §23).
 *
 * Adds deterministic, identifiable, self-cleaning test data to the TEST
 * Supabase project ONLY (safety abort unless the TEST project ref):
 *
 * FY 2026-27 (closed — direct SQL inserts, matching every table invariant):
 *   - 3 fixture parties (customer/customer/supplier)
 *   - 2 real supplier purchases across different months (one partial)
 *   - 7 sales across May–Sep 2026, including a MULTI-ITEM invoice and two
 *     trade-ins (hidden PUR-TRD bills), with paid/partial/unpaid states
 *   - payments in both modes (UPI/Card + Cash account) across months
 *   - a draft (active) proforma quoting in-stock stock
 *   - the outstanding sales hit all four receivables ageing buckets
 *   - in-stock devices aged 0–30 / 31–60 / 90+ days
 *
 * FY 2027-28 (active — inserts, then the REAL lifecycle RPCs):
 *   - a fixture sale with a trade-in whose device is resold, then
 *     cancel_sale + create_trade_in_purchase_bill → a RECOVERY bill
 *     (exercises the virtual-acquisition rule without the PUR-TRD prefix)
 *   - the recovery bill + the sale_cancelled reversal are re-dated to the
 *     scenario date 2027-04-12 (after the resale, inside FY 2027-28) so the
 *     fixture keeps the date-in-FY invariant even when the sandbox clock
 *     sits outside the year (the RPCs clamp since migration 0019)
 *
 * Idempotent: skips when the fixture marker exists. `--cleanup` removes
 * exactly the fixture rows (by fixed UUIDs / documented bill numbers) and
 * restores the FY counters. Unrelated TEST data is never touched.
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
const FY2728 = '878833cd-3794-4c68-bf10-acd4222f5d8e'
// The recovery scenario's cancellation date: after the 2027-04-10 resale of
// the trade-in device, inside FY 2027-28 (see runRecoveryScenario).
const RECOVERY_DATE = '2027-04-12'
const HDFC = 'bbe198c7-1ff7-4d75-bdde-5264eb0180b1'
const CASH = 'dca78a9a-ea15-47e8-bc3e-5e3de9317c5e'
const UPI = '2d05de0b-0c6e-4d70-8079-83203a21ce48'
const CARD = '7c071dd0-6576-46a5-805a-c6676d701773'
const BANK_TRANSFER = 'f887ba6f-cc31-4546-86de-f9f43f8a79c1'

const P_A = 'a1000000-0000-4000-8000-000000000001' // Anaya Gupta (customer)
const P_B = 'a1000000-0000-4000-8000-000000000002' // Vikram Mehta (customer)
const P_S = 'a1000000-0000-4000-8000-000000000003' // Gupta Electronics (supplier)

// FY 2026-27 inventory items
const INV = {
  P8: 'b1000000-0000-4000-8000-000000000001', // Google Pixel 8
  NCE4: 'b1000000-0000-4000-8000-000000000002', // OnePlus Nord CE4
  R13C: 'b1000000-0000-4000-8000-000000000003', // Xiaomi Redmi 13C
  A55: 'b1000000-0000-4000-8000-000000000004', // Samsung Galaxy A55 (stays in stock)
  E50: 'b1000000-0000-4000-8000-000000000005', // Motorola Edge 50 (stays in stock)
  Y58: 'b1000000-0000-4000-8000-000000000006', // Vivo Y58
  T3: 'b1000000-0000-4000-8000-000000000007', // Vivo T3
  S24: 'b1000000-0000-4000-8000-000000000008', // Samsung Galaxy S24
  N70: 'b1000000-0000-4000-8000-000000000009', // Realme Narzo 70 (stays in stock)
  NP3: 'b1000000-0000-4000-8000-000000000010', // Nothing Phone 3
  F14: 'b1000000-0000-4000-8000-000000000011', // Samsung Galaxy F14 (trade-in)
  C55: 'b1000000-0000-4000-8000-000000000012', // Realme C55 (trade-in)
}

// FY 2026-27 purchases
const PUR_A = 'c1000000-0000-4000-8000-000000000008' // PUR-2026-27-0008
const TRD_F14 = 'c1000000-0000-4000-8000-000000000009' // PUR-TRD-2026-27-0009
const TRD_C55 = 'c1000000-0000-4000-8000-000000000010' // PUR-TRD-2026-27-0010
const PUR_B = 'c1000000-0000-4000-8000-000000000011' // PUR-2026-27-0011

// FY 2026-27 sales (SAL-2026-27-0010..0016)
const SAL = {
  10: 'd1000000-0000-4000-8000-000000000010',
  11: 'd1000000-0000-4000-8000-000000000011',
  12: 'd1000000-0000-4000-8000-000000000012',
  13: 'd1000000-0000-4000-8000-000000000013',
  14: 'd1000000-0000-4000-8000-000000000014',
  15: 'd1000000-0000-4000-8000-000000000015',
  16: 'd1000000-0000-4000-8000-000000000016',
}

const TI_F14 = 'e1000000-0000-4000-8000-000000000001'
const TI_C55 = 'e1000000-0000-4000-8000-000000000002'
const PI_3 = 'f1000000-0000-4000-8000-000000000003'

// Payments (FY 2026-27)
const PIN = {
  s10: '1a100000-0000-4000-8000-000000000001',
  s11: '1a100000-0000-4000-8000-000000000002',
  s12: '1a100000-0000-4000-8000-000000000003',
  s14: '1a100000-0000-4000-8000-000000000004',
  s15: '1a100000-0000-4000-8000-000000000005',
  s16: '1a100000-0000-4000-8000-000000000006',
}
const POUT = {
  purA: '1b100000-0000-4000-8000-000000000001',
  purB: '1b100000-0000-4000-8000-000000000002',
}

// FY 2027-28
const INV_RENO = 'b2000000-0000-4000-8000-000000000001'
const INV_F15 = 'b2000000-0000-4000-8000-000000000002'
const PUR_2028_4 = 'c2000000-0000-4000-8000-000000000004'
const TRD_F15 = 'c2000000-0000-4000-8000-000000000005'
const SAL_2028_5 = 'd2000000-0000-4000-8000-000000000005'
const SAL_2028_6 = 'd2000000-0000-4000-8000-000000000006'
const TI_F15 = 'e2000000-0000-4000-8000-000000000001'
const PIN_2028_5 = '2a100000-0000-4000-8000-000000000001'
const PIN_2028_6 = '2a100000-0000-4000-8000-000000000002'
const POUT_2028_4 = '2b100000-0000-4000-8000-000000000001'

// ── Fixture row definitions ──────────────────────────────────────────────────

const PARTIES = [
  { id: P_A, name: 'Anaya Gupta', number: '+919812345601', address: '14 Rose Lane, Bahraich' },
  { id: P_B, name: 'Vikram Mehta', number: '+919812345602', address: '9 Station Road, Bahraich' },
  { id: P_S, name: 'Gupta Electronics', number: '+919812345603', address: 'Wholesale Market, Lucknow' },
]

interface InvRow {
  id: string
  brand: string
  model: string
  imei: string
  purchase_price: string
  base_selling_price: string
  status: 'in_stock' | 'sold'
  source: 'purchase' | 'trade_in'
  created_at: string
}

// FY 2026-27 inventory — acquisition dates drive the ageing spread.
const INVENTORY_2627: InvRow[] = [
  { id: INV.P8, brand: 'Google', model: 'Pixel 8', imei: '860000010000101', purchase_price: '41000', base_selling_price: '46000', status: 'sold', source: 'purchase', created_at: '2026-04-20 10:00:00+00' },
  { id: INV.NCE4, brand: 'OnePlus', model: 'Nord CE4', imei: '860000010000102', purchase_price: '18000', base_selling_price: '22000', status: 'sold', source: 'purchase', created_at: '2026-04-20 10:00:00+00' },
  { id: INV.R13C, brand: 'Xiaomi', model: 'Redmi 13C', imei: '860000010000103', purchase_price: '8500', base_selling_price: '10999', status: 'sold', source: 'purchase', created_at: '2026-04-20 10:00:00+00' },
  { id: INV.A55, brand: 'Samsung', model: 'Galaxy A55', imei: '860000010000104', purchase_price: '24000', base_selling_price: '27999', status: 'in_stock', source: 'purchase', created_at: '2026-04-20 10:00:00+00' },
  { id: INV.E50, brand: 'Motorola', model: 'Edge 50', imei: '860000010000105', purchase_price: '27000', base_selling_price: '31499', status: 'in_stock', source: 'purchase', created_at: '2026-04-20 10:00:00+00' },
  { id: INV.Y58, brand: 'Vivo', model: 'Y58', imei: '860000010000106', purchase_price: '11000', base_selling_price: '13999', status: 'sold', source: 'purchase', created_at: '2026-04-20 10:00:00+00' },
  { id: INV.T3, brand: 'Vivo', model: 'T3', imei: '860000010000107', purchase_price: '15000', base_selling_price: '18499', status: 'sold', source: 'purchase', created_at: '2026-08-15 10:00:00+00' },
  { id: INV.S24, brand: 'Samsung', model: 'Galaxy S24', imei: '860000010000108', purchase_price: '54000', base_selling_price: '59999', status: 'sold', source: 'purchase', created_at: '2026-08-15 10:00:00+00' },
  { id: INV.N70, brand: 'Realme', model: 'Narzo 70', imei: '860000010000109', purchase_price: '12000', base_selling_price: '14999', status: 'in_stock', source: 'purchase', created_at: '2026-08-15 10:00:00+00' },
  { id: INV.NP3, brand: 'Nothing', model: 'Phone 3', imei: '860000010000110', purchase_price: '28000', base_selling_price: '32999', status: 'sold', source: 'purchase', created_at: '2026-08-15 10:00:00+00' },
  { id: INV.F14, brand: 'Samsung', model: 'Galaxy F14', imei: '860000010000201', purchase_price: '3000', base_selling_price: '3500', status: 'sold', source: 'trade_in', created_at: '2026-06-10 10:00:00+00' },
  { id: INV.C55, brand: 'Realme', model: 'C55', imei: '860000010000202', purchase_price: '2000', base_selling_price: '2500', status: 'in_stock', source: 'trade_in', created_at: '2026-06-18 10:00:00+00' },
]

interface PurchaseRow {
  id: string
  bill_number: string
  party: string
  total: string
  paid: string
  due: string
  date: string
  items: string[]
}

const PURCHASES_2627: PurchaseRow[] = [
  { id: PUR_A, bill_number: 'PUR-2026-27-0008', party: P_S, total: '129500', paid: '129500', due: '0', date: '2026-04-20', items: [INV.P8, INV.NCE4, INV.R13C, INV.A55, INV.E50, INV.Y58] },
  { id: TRD_F14, bill_number: 'PUR-TRD-2026-27-0009', party: P_B, total: '3000', paid: '3000', due: '0', date: '2026-06-10', items: [INV.F14] },
  { id: TRD_C55, bill_number: 'PUR-TRD-2026-27-0010', party: P_B, total: '2000', paid: '2000', due: '0', date: '2026-06-18', items: [INV.C55] },
  { id: PUR_B, bill_number: 'PUR-2026-27-0011', party: P_S, total: '109000', paid: '59000', due: '50000', date: '2026-08-15', items: [INV.T3, INV.S24, INV.N70, INV.NP3] },
]

interface SaleRow {
  id: string
  bill_number: string
  party: string
  total: string
  discount: string
  trade_in_credit: string
  final_total: string
  paid: string
  due: string
  date: string
  items: Array<{ inv: string; sold_price: string }>
}

const SALES_2627: SaleRow[] = [
  { id: SAL[10], bill_number: 'SAL-2026-27-0010', party: P_A, total: '46000', discount: '0', trade_in_credit: '0', final_total: '46000', paid: '46000', due: '0', date: '2026-05-12', items: [{ inv: INV.P8, sold_price: '46000' }] },
  { id: SAL[11], bill_number: 'SAL-2026-27-0011', party: P_B, total: '22000', discount: '0', trade_in_credit: '3000', final_total: '19000', paid: '8000', due: '11000', date: '2026-06-10', items: [{ inv: INV.NCE4, sold_price: '22000' }] },
  { id: SAL[12], bill_number: 'SAL-2026-27-0012', party: P_B, total: '13999', discount: '0', trade_in_credit: '2000', final_total: '11999', paid: '4000', due: '7999', date: '2026-06-18', items: [{ inv: INV.Y58, sold_price: '13999' }] },
  { id: SAL[13], bill_number: 'SAL-2026-27-0013', party: P_A, total: '10999', discount: '0', trade_in_credit: '0', final_total: '10999', paid: '0', due: '10999', date: '2026-07-20', items: [{ inv: INV.R13C, sold_price: '10999' }] },
  { id: SAL[14], bill_number: 'SAL-2026-27-0014', party: P_B, total: '18499', discount: '0', trade_in_credit: '0', final_total: '18499', paid: '10000', due: '8499', date: '2026-09-05', items: [{ inv: INV.T3, sold_price: '18499' }] },
  { id: SAL[15], bill_number: 'SAL-2026-27-0015', party: P_A, total: '92998', discount: '499', trade_in_credit: '0', final_total: '92499', paid: '92499', due: '0', date: '2026-09-20', items: [{ inv: INV.S24, sold_price: '59999' }, { inv: INV.NP3, sold_price: '32999' }] },
  { id: SAL[16], bill_number: 'SAL-2026-27-0016', party: P_A, total: '3500', discount: '0', trade_in_credit: '0', final_total: '3500', paid: '3500', due: '0', date: '2026-09-28', items: [{ inv: INV.F14, sold_price: '3500' }] },
]

interface PayRow {
  id: string
  sale?: string
  purchase?: string
  party: string
  amount: string
  date: string
  bank: string
  mode: string | null
}

const PAYMENTS_IN_2627: PayRow[] = [
  { id: PIN.s10, sale: SAL[10], party: P_A, amount: '46000', date: '2026-05-12', bank: HDFC, mode: UPI },
  { id: PIN.s11, sale: SAL[11], party: P_B, amount: '8000', date: '2026-06-10', bank: CASH, mode: null },
  { id: PIN.s12, sale: SAL[12], party: P_B, amount: '4000', date: '2026-06-18', bank: HDFC, mode: CARD },
  { id: PIN.s14, sale: SAL[14], party: P_B, amount: '10000', date: '2026-09-05', bank: HDFC, mode: UPI },
  { id: PIN.s15, sale: SAL[15], party: P_A, amount: '92499', date: '2026-09-20', bank: HDFC, mode: UPI },
  { id: PIN.s16, sale: SAL[16], party: P_A, amount: '3500', date: '2026-09-28', bank: CASH, mode: null },
]

const PAYMENTS_OUT_2627: PayRow[] = [
  { id: POUT.purA, purchase: PUR_A, party: P_S, amount: '129500', date: '2026-04-20', bank: HDFC, mode: UPI },
  { id: POUT.purB, purchase: PUR_B, party: P_S, amount: '59000', date: '2026-08-15', bank: HDFC, mode: BANK_TRANSFER },
]

const TRADE_INS_2627 = [
  { id: TI_F14, sale: SAL[11], inv: INV.F14, credit: '3000', mrp: '12000' },
  { id: TI_C55, sale: SAL[12], inv: INV.C55, credit: '2000', mrp: '9000' },
]

// FY 2027-28
const INVENTORY_2728: InvRow[] = [
  { id: INV_RENO, brand: 'Oppo', model: 'Reno 12', imei: '860000010000301', purchase_price: '7500', base_selling_price: '8000', status: 'sold', source: 'purchase', created_at: '2027-04-02 10:00:00+00' },
  { id: INV_F15, brand: 'Samsung', model: 'Galaxy F15', imei: '860000010000302', purchase_price: '2500', base_selling_price: '3000', status: 'sold', source: 'trade_in', created_at: '2027-04-05 10:00:00+00' },
]

const PURCHASES_2728: PurchaseRow[] = [
  { id: PUR_2028_4, bill_number: 'PUR-2027-28-0004', party: P_S, total: '7500', paid: '4000', due: '3500', date: '2027-04-02', items: [INV_RENO] },
  { id: TRD_F15, bill_number: 'PUR-TRD-2027-28-0005', party: P_A, total: '2500', paid: '2500', due: '0', date: '2027-04-05', items: [INV_F15] },
]

const SALES_2728: SaleRow[] = [
  { id: SAL_2028_5, bill_number: 'SAL-2027-28-0005', party: P_A, total: '8000', discount: '0', trade_in_credit: '2500', final_total: '5500', paid: '3000', due: '2500', date: '2027-04-05', items: [{ inv: INV_RENO, sold_price: '8000' }] },
  { id: SAL_2028_6, bill_number: 'SAL-2027-28-0006', party: P_B, total: '3000', discount: '0', trade_in_credit: '0', final_total: '3000', paid: '3000', due: '0', date: '2027-04-10', items: [{ inv: INV_F15, sold_price: '3000' }] },
]

const PAYMENTS_IN_2728: PayRow[] = [
  { id: PIN_2028_5, sale: SAL_2028_5, party: P_A, amount: '3000', date: '2027-04-05', bank: HDFC, mode: CARD },
  { id: PIN_2028_6, sale: SAL_2028_6, party: P_B, amount: '3000', date: '2027-04-10', bank: CASH, mode: null },
]

const PAYMENTS_OUT_2728: PayRow[] = [
  { id: POUT_2028_4, purchase: PUR_2028_4, party: P_S, amount: '4000', date: '2027-04-02', bank: HDFC, mode: UPI },
]

const TRADE_INS_2728 = [{ id: TI_F15, sale: SAL_2028_5, inv: INV_F15, credit: '2500', mrp: '10000' }]

// ── Helpers ──────────────────────────────────────────────────────────────────

async function seeded(): Promise<boolean> {
  const rows = await sql`select 1 from public.parties where id = ${P_A} limit 1`
  return rows.length > 0
}

async function insertFixtures(): Promise<void> {
  await sql.begin(async (tx) => {
    // Parties
    for (const p of PARTIES) {
      await tx`insert into public.parties (id, name, number, address, created_at)
               values (${p.id}, ${p.name}, ${p.number}, ${p.address}, '2026-04-15 09:00:00+00')`
    }

    // FY 2026-27 inventory
    for (const i of INVENTORY_2627) {
      await tx`insert into public.inventory_items (id, brand, model, imei, purchase_price, base_selling_price, status, source, financial_year_id, created_at, opening_entry_type)
               values (${i.id}, ${i.brand}, ${i.model}, ${i.imei}, ${i.purchase_price}, ${i.base_selling_price}, ${i.status}, ${i.source}, ${FY2627}, ${i.created_at}, 'direct')`
    }

    // FY 2026-27 purchases + items
    for (const p of PURCHASES_2627) {
      await tx`insert into public.purchases (id, bill_number, party_id, total, paid, due, bank_account_id, date, financial_year_id, status, created_at)
               values (${p.id}, ${p.bill_number}, ${p.party}, ${p.total}, ${p.paid}, ${p.due}, ${HDFC}, ${p.date}, ${FY2627}, 'active', ${`${p.date} 10:00:00+00`})`
      for (const inv of p.items) {
        await tx`insert into public.purchase_items (purchase_id, inventory_item_id) values (${p.id}, ${inv})`
      }
    }

    // FY 2026-27 sales + items
    for (const s of SALES_2627) {
      await tx`insert into public.sales (id, bill_number, party_id, total, discount, trade_in_credit, final_total, paid, due, bank_account_id, payment_mode_id, date, financial_year_id, status, created_at)
               values (${s.id}, ${s.bill_number}, ${s.party}, ${s.total}, ${s.discount}, ${s.trade_in_credit}, ${s.final_total}, ${s.paid}, ${s.due}, ${HDFC}, ${UPI}, ${s.date}, ${FY2627}, 'active', ${`${s.date} 10:00:00+00`})`
      for (const item of s.items) {
        await tx`insert into public.sale_items (sale_id, inventory_item_id, sold_price) values (${s.id}, ${item.inv}, ${item.sold_price})`
      }
    }

    // FY 2026-27 trade-ins (the transactional relationship; device identity
    // lives on the inventory rows above)
    for (const t of TRADE_INS_2627) {
      await tx`insert into public.trade_ins (id, sale_id, inventory_item_id, credit_value, mrp)
               values (${t.id}, ${t.sale}, ${t.inv}, ${t.credit}, ${t.mrp})`
    }

    // FY 2026-27 payments + ledger rows (later-payment reference pattern)
    for (const p of PAYMENTS_IN_2627) {
      await tx`insert into public.payments_in (id, sale_id, party_id, amount, bank_account_id, payment_mode_id, date, financial_year_id, created_at)
               values (${p.id}, ${p.sale}, ${p.party}, ${p.amount}, ${p.bank}, ${p.mode}, ${p.date}, ${FY2627}, ${`${p.date} 11:00:00+00`})`
      await tx`insert into public.account_transactions (bank_account_id, payment_mode_id, type, amount, date, reference_type, reference_id, financial_year_id)
               values (${p.bank}, ${p.mode}, 'credit', ${p.amount}, ${p.date}, 'payment_in', ${p.id}, ${FY2627})`
    }
    for (const p of PAYMENTS_OUT_2627) {
      await tx`insert into public.payments_out (id, purchase_id, party_id, amount, bank_account_id, payment_mode_id, date, financial_year_id, created_at)
               values (${p.id}, ${p.purchase}, ${p.party}, ${p.amount}, ${p.bank}, ${p.mode}, ${p.date}, ${FY2627}, ${`${p.date} 11:00:00+00`})`
      await tx`insert into public.account_transactions (bank_account_id, payment_mode_id, type, amount, date, reference_type, reference_id, financial_year_id)
               values (${p.bank}, ${p.mode}, 'debit', ${p.amount}, ${p.date}, 'payment_out', ${p.id}, ${FY2627})`
    }

    // FY 2026-27 draft proforma (quoting the in-stock Galaxy A55)
    await tx`insert into public.proforma_invoices (id, bill_number, party_id, total, discount, trade_in_credit, final_total, date, financial_year_id, status, created_at)
             values (${PI_3}, 'PI-2026-27-0003', ${P_B}, '27999', '0', '0', '27999', '2026-09-25', ${FY2627}, 'active', '2026-09-25 10:00:00+00')`
    await tx`insert into public.proforma_invoice_items (proforma_invoice_id, qty, rate, discount, value, inventory_item_id)
             values (${PI_3}, 1, '27999', '0', '27999', ${INV.A55})`

    // FY 2026-27 counters (bill numbers 0008–0011 consumed above)
    await tx`update public.financial_years set sale_counter = 16, purchase_counter = 11, proforma_counter = 3 where id = ${FY2627}`

    // FY 2027-28 fixtures
    for (const i of INVENTORY_2728) {
      await tx`insert into public.inventory_items (id, brand, model, imei, purchase_price, base_selling_price, status, source, financial_year_id, created_at, opening_entry_type)
               values (${i.id}, ${i.brand}, ${i.model}, ${i.imei}, ${i.purchase_price}, ${i.base_selling_price}, ${i.status}, ${i.source}, ${FY2728}, ${i.created_at}, 'direct')`
    }
    for (const p of PURCHASES_2728) {
      await tx`insert into public.purchases (id, bill_number, party_id, total, paid, due, bank_account_id, date, financial_year_id, status, created_at)
               values (${p.id}, ${p.bill_number}, ${p.party}, ${p.total}, ${p.paid}, ${p.due}, ${HDFC}, ${p.date}, ${FY2728}, 'active', ${`${p.date} 10:00:00+00`})`
      for (const inv of p.items) {
        await tx`insert into public.purchase_items (purchase_id, inventory_item_id) values (${p.id}, ${inv})`
      }
    }
    for (const s of SALES_2728) {
      await tx`insert into public.sales (id, bill_number, party_id, total, discount, trade_in_credit, final_total, paid, due, bank_account_id, payment_mode_id, date, financial_year_id, status, created_at)
               values (${s.id}, ${s.bill_number}, ${s.party}, ${s.total}, ${s.discount}, ${s.trade_in_credit}, ${s.final_total}, ${s.paid}, ${s.due}, ${HDFC}, ${CARD}, ${s.date}, ${FY2728}, 'active', ${`${s.date} 10:00:00+00`})`
      for (const item of s.items) {
        await tx`insert into public.sale_items (sale_id, inventory_item_id, sold_price) values (${s.id}, ${item.inv}, ${item.sold_price})`
      }
    }
    for (const t of TRADE_INS_2728) {
      await tx`insert into public.trade_ins (id, sale_id, inventory_item_id, credit_value, mrp)
               values (${t.id}, ${t.sale}, ${t.inv}, ${t.credit}, ${t.mrp})`
    }
    for (const p of PAYMENTS_IN_2728) {
      await tx`insert into public.payments_in (id, sale_id, party_id, amount, bank_account_id, payment_mode_id, date, financial_year_id, created_at)
               values (${p.id}, ${p.sale}, ${p.party}, ${p.amount}, ${p.bank}, ${p.mode}, ${p.date}, ${FY2728}, ${`${p.date} 11:00:00+00`})`
      await tx`insert into public.account_transactions (bank_account_id, payment_mode_id, type, amount, date, reference_type, reference_id, financial_year_id)
               values (${p.bank}, ${p.mode}, 'credit', ${p.amount}, ${p.date}, 'payment_in', ${p.id}, ${FY2728})`
    }
    for (const p of PAYMENTS_OUT_2728) {
      await tx`insert into public.payments_out (id, purchase_id, party_id, amount, bank_account_id, payment_mode_id, date, financial_year_id, created_at)
               values (${p.id}, ${p.purchase}, ${p.party}, ${p.amount}, ${p.bank}, ${p.mode}, ${p.date}, ${FY2728}, ${`${p.date} 11:00:00+00`})`
      await tx`insert into public.account_transactions (bank_account_id, payment_mode_id, type, amount, date, reference_type, reference_id, financial_year_id)
               values (${p.bank}, ${p.mode}, 'debit', ${p.amount}, ${p.date}, 'payment_out', ${p.id}, ${FY2728})`
    }
    await tx`update public.financial_years set sale_counter = 6, purchase_counter = 5 where id = ${FY2728}`
  })
}

async function runRecoveryScenario(): Promise<void> {
  // The REAL lifecycle RPCs on fixture data (FY 2027-28 is the active FY):
  // the trade-in device F15 was resold, so cancelling SAL-2027-28-0005 must
  // cancel the hidden TRD bill and report the device as resold, and the
  // recovery bill re-acquires it virtually.
  const cancelled = await sql`select public.cancel_sale(${SAL_2028_5}) as result`
  console.log('cancel_sale →', JSON.stringify(cancelled[0].result))
  const resold = (cancelled[0].result as { resold: unknown[] }).resold
  if (!Array.isArray(resold) || resold.length !== 1) {
    throw new Error('cancel_sale did not report the resold trade-in device')
  }
  const bill = await sql`select public.create_trade_in_purchase_bill(${SAL_2028_5}, ${TI_F15}) as bill_no`
  console.log('create_trade_in_purchase_bill →', bill[0].bill_no)

  // Scenario chronology: sale 2027-04-05 → device resold 2027-04-10 →
  // cancellation + recovery afterwards. The RPCs derive their dates from
  // current_date (clamped into the sale's FY since migration 0019); when
  // this seed runs with the sandbox clock outside FY 2027-28 the clamped
  // dates land on the FY boundary, so re-date both rows to the
  // scenario-consistent date to keep the fixture temporally coherent.
  await sql`update public.purchases set date = ${RECOVERY_DATE}
              where bill_number = ${bill[0].bill_no as string} and financial_year_id = ${FY2728}`
  await sql`update public.account_transactions set date = ${RECOVERY_DATE}
              where reference_type = 'sale_cancelled' and reference_id = ${SAL_2028_5}`
  console.log(`recovery scenario re-dated to ${RECOVERY_DATE}`)
}

async function cleanup(): Promise<void> {
  const recovery = await sql`
    select p.id from public.purchases p
    where p.financial_year_id = ${FY2728}
      and p.bill_number like 'PUR-2027-28-%'
      and exists (select 1 from public.purchase_items pi where pi.purchase_id = p.id and pi.inventory_item_id = ${INV_F15})`
  const recoveryIds = recovery.map((r) => r.id as string)
  await sql.begin(async (tx) => {
    // Ledger rows referencing fixture payments + the cancel compensations.
    const pinIds = [...PAYMENTS_IN_2627.map((p) => p.id), ...PAYMENTS_IN_2728.map((p) => p.id)]
    const poutIds = [...PAYMENTS_OUT_2627.map((p) => p.id), ...PAYMENTS_OUT_2728.map((p) => p.id)]
    await tx`delete from public.account_transactions where reference_id in (
                select unnest(${pinIds}::uuid[] || ${poutIds}::uuid[]))
               or (reference_type = 'sale_cancelled' and reference_id = ${SAL_2028_5})`
    await tx`delete from public.payments_in where id in (select unnest(${pinIds}::uuid[]))`
    await tx`delete from public.payments_out where id in (select unnest(${poutIds}::uuid[]))`
    await tx`delete from public.proforma_invoice_items where proforma_invoice_id = ${PI_3}`
    await tx`delete from public.proforma_invoices where id = ${PI_3}`
    await tx`delete from public.trade_ins where id in (${TI_F14}, ${TI_C55}, ${TI_F15})`
    const saleIds = [...SALES_2627.map((s) => s.id), SAL_2028_5, SAL_2028_6]
    await tx`delete from public.sale_items where sale_id in (select unnest(${saleIds}::uuid[]))`
    await tx`delete from public.sales where id in (select unnest(${saleIds}::uuid[]))`
    const purchaseIds = [...PURCHASES_2627.map((p) => p.id), ...PURCHASES_2728.map((p) => p.id), ...recoveryIds]
    await tx`delete from public.purchase_items where purchase_id in (select unnest(${purchaseIds}::uuid[]))`
    await tx`delete from public.purchases where id in (select unnest(${purchaseIds}::uuid[]))`
    const invIds = [...INVENTORY_2627.map((i) => i.id), ...INVENTORY_2728.map((i) => i.id)]
    await tx`delete from public.inventory_items where id in (select unnest(${invIds}::uuid[]))`
    await tx`delete from public.parties where id in (${P_A}, ${P_B}, ${P_S})`
    // Restore the pre-fixture counters.
    await tx`update public.financial_years set sale_counter = 9, purchase_counter = 7, proforma_counter = 2 where id = ${FY2627}`
    await tx`update public.financial_years set sale_counter = 4, purchase_counter = 3 where id = ${FY2728}`
  })
  console.log('Fixtures removed; counters restored.')
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
    console.log('Reports fixtures already present — nothing to do.')
  } else {
    console.log('Inserting reports fixtures (FY 2026-27 + FY 2027-28)…')
    await insertFixtures()
    console.log('Running the recovery lifecycle RPCs on the fixture sale…')
    await runRecoveryScenario()
    console.log('Done. Controlled TEST data for the Reports system is in place.')
  }
}

await sql.end()
