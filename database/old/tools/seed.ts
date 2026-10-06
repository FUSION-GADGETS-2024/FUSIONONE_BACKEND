/**
 * FUSIONONE TEST database — deterministic, realistic seed.
 *
 * Exercises every major page and flow (spec §12): store with logo+signature,
 * two financial years (active + closed with carry-forward), banking, parties,
 * purchases (paid/due/trade-in), sales (paid/due/multi-item/trade-in/cancelled,
 * resold-trade-in recovery), payments, account ledger with balances,
 * proformas (active/convertible/converted) and consistent counters.
 *
 * The seed writes with the DB admin connection (tooling only) and then
 * VERIFIES internal consistency (balances, dues, counters, IMEI uniqueness).
 *
 * Usage: bun run seed.ts
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
const { id: OWNER_ID } = JSON.parse(readFileSync(join(HERE, '.test-user.json'), 'utf8'))

// ─── Deterministic ids ──────────────────────────────────────────────────────
const id = (n: number) => `aa000000-0000-4000-8000-${String(n).padStart(12, '0')}`

const FY_CUR = id(1) // 2026-04-01 .. 2027-03-31 (active, working year)
const FY_PREV = id(2) // 2025-04-01 .. 2026-03-31 (closed)
const STORE = id(3)
const BANK_CASH = id(10)
const BANK_HDFC = id(11)
const BANK_SBI = id(12)
const MODE_UPI = id(20)
const MODE_CARD = id(21)
const MODE_BANK = id(22)
const MODE_SBI_UPI = id(23)
const PARTY_RETAIL = id(30) // customer with number+address
const PARTY_WALKIN = id(31) // customer, number only
const PARTY_NOBAL = id(32) // customer, zero balance
const PARTY_SUPPLIER = id(33) // supplier with due
const PARTY_SUPPLIER2 = id(34) // supplier paid up
const PARTY_ADDRESS = id(35) // customer with full address (invoice exercise)

// FY 2026-27 inventory (in stock)
const INV1 = id(100) // Samsung Galaxy S23
const INV2 = id(101) // iPhone 14
const INV3 = id(102) // Redmi Note 12
const INV4 = id(103) // Vivo V27
const INV5 = id(104) // OnePlus 11R
const INV6 = id(105) // Realme Narzo 60 (carried forward from FY 2025-26)
const INV7 = id(106) // trade-in sourced device (in stock)
const INV8 = id(107) // Pixel 7a

// Sold inventory (FY 2026-27)
const SINV1 = id(110) // sold in SAL-1
const SINV2 = id(111) // sold in SAL-1 (multi-item)
const SINV3 = id(112) // sold in SAL-2 (due sale)
const SINV4 = id(113) // sold in SAL-3 (cancelled sale)
const SINV5 = id(114) // trade-in new item, later RESOLD (action-required scenario)
const SINV6 = id(115) // sold in the converted proforma sale

// FY 2025-26 inventory
const PINV1 = id(120) // in stock in prev FY (origin of INV6 carry-forward)
const PINV2 = id(121) // sold in prev FY

// Purchases
const PUR1 = id(200) // PUR-2026-27-0001 (paid, INV1+INV2+INV3 restock origin)
const PUR2 = id(201) // PUR-2026-27-0002 (due, INV4+INV8)
const PUR3 = id(202) // PUR-2026-27-0003 (paid, INV5)
const PUR_TRD = id(203) // PUR-TRD-2026-27-0004 (hidden trade-in purchase, INV7)
const PUR_PREV = id(204) // FY 2025-26 purchase
const PUR_TRD2 = id(205) // hidden trade-in purchase for the resold scenario (SINV5)

// Sales
const SAL1 = id(300) // SAL-2026-27-0001 paid, multi-item (SINV1+SINV2)
const SAL2 = id(301) // SAL-2026-27-0002 partial payment (due)
const SAL3 = id(302) // SAL-2026-27-0003 cancelled
const SAL4 = id(303) // SAL-2026-27-0004 trade-in sale (paid, party RETAIL)
const SAL5 = id(304) // sale that resold the trade-in device (paid)
const SAL6 = id(305) // sale created from converted proforma
const SAL_PREV = id(306) // FY 2025-26 sale

// Trade-ins
const TRD1 = id(400) // on SAL4 -> INV7 (still in stock)
const TRD2 = id(401) // on SAL5 -> SINV5 (resold later)

// Payments / ledger
const PAYIN1 = id(500)
const PAYIN2 = id(501)
const PAYIN3 = id(502) // receive-payment on SAL2 (partial)
const PAYOUT1 = id(503)
const PAYOUT2 = id(504)
const FUND1 = id(505)
const TRANSFER1 = id(506)
const TX = (n: number) => id(600 + n)

// Proformas
const PRO1 = id(700) // active quotation
const PRO2 = id(701) // convertible quotation (no trade-ins)
const PRO3 = id(702) // converted quotation

const WHS = id(800) // whatsapp_settings row

const D = (s: string) => s // date literal helper

async function main() {
  console.log(`Seeding for owner ${OWNER_ID}`)

  await sql.begin(async (tx) => {
    // ── Wipe (deterministic re-run) ────────────────────────────────────────
    for (const t of [
      'whatsapp_settings', 'account_transactions', 'account_transfers',
      'account_fund_entries', 'payments_out', 'payments_in', 'trade_ins',
      'sale_items', 'sales', 'purchase_items', 'purchases', 'inventory_items',
      'proforma_trade_ins', 'proforma_invoice_items', 'proforma_invoices',
      'store', 'parties', 'payment_modes', 'bank_accounts', 'financial_years',
    ]) {
      await tx.unsafe(`DELETE FROM public.${t}`)
    }

    // ── Financial years ────────────────────────────────────────────────────
    await tx`INSERT INTO financial_years (id, start_date, end_date, status, sale_counter, purchase_counter, proforma_counter, created_at) VALUES
      (${FY_PREV}, ${D('2025-04-01')}, ${D('2026-03-31')}, 'closed', 12, 9, 5, '2025-04-01T06:30:00+05:30'),
      (${FY_CUR},  ${D('2026-04-01')}, ${D('2027-03-31')}, 'active', 6, 4, 3, '2026-04-01T06:30:00+05:30')`

    // ── Store ──────────────────────────────────────────────────────────────
    await tx`INSERT INTO store (id, name, address, phone, email, website, gstin, logo_url, signature_url, onboarding_complete, active_financial_year_id) VALUES (
      ${STORE}, 'FUSION GADGETS', ${'Shop 4, Grand Plaza, Station Road\nBahraich, Uttar Pradesh 271801'}, '+91 88749 83907', 'fusion.gadgets.test@gmail.com', 'www.fusiongadgets.in', '09ABCDE1234F1Z5',
      'https://egdrnhtmclvhsfjvhyam.supabase.co/storage/v1/object/public/store_assets/test-store-logo.png',
      'https://egdrnhtmclvhsfjvhyam.supabase.co/storage/v1/object/public/store_assets/test-store-signature.png',
      true, ${FY_CUR})`

    // ── Application users (0008 model: user_type is the only role field) ──
    await tx`INSERT INTO public.users (id, user_type) VALUES (${OWNER_ID}, 'owner')
      ON CONFLICT (id) DO NOTHING`

    // ─── Banking ───────────────────────────────────────────────────────────
    await tx`INSERT INTO bank_accounts (id, name, is_cash) VALUES
      (${BANK_CASH}, 'Cash', true),
      (${BANK_HDFC}, 'HDFC Current Account', false),
      (${BANK_SBI}, 'SBI Savings', false)`
    await tx`INSERT INTO payment_modes (id, bank_account_id, name) VALUES
      (${MODE_UPI}, ${BANK_HDFC}, 'UPI'),
      (${MODE_CARD}, ${BANK_HDFC}, 'Card'),
      (${MODE_BANK}, ${BANK_HDFC}, 'Bank Transfer'),
      (${MODE_SBI_UPI}, ${BANK_SBI}, 'UPI')`

    // ─── Parties ───────────────────────────────────────────────────────────
    await tx`INSERT INTO parties (id, name, number, address) VALUES
      (${PARTY_RETAIL},  'Rahul Sharma',   '9876543210', '12 Civil Lines, Bahraich'),
      (${PARTY_WALKIN},  'Priya Verma',    '8795103722', NULL),
      (${PARTY_NOBAL},   'Aman Khan',      NULL, NULL),
      (${PARTY_SUPPLIER},'MobileHub Distribution', '9412345678', 'Wholesale Market, Lucknow'),
      (${PARTY_SUPPLIER2},'Galaxy Traders','9456789123', 'Aminabad, Lucknow'),
      (${PARTY_ADDRESS}, 'Sunita Devi',    '9911223344', 'H.No 45, Nehru Nagar,\nNear Water Tank, Bahraich')`

    // ─── FY 2025-26 inventory (closed year) ────────────────────────────────
    await tx`INSERT INTO inventory_items (id, brand, model, imei, ram_rom, color, purchase_price, base_selling_price, status, source, financial_year_id, opening_entry_type, created_at) VALUES
      (${PINV1}, 'Realme', 'Narzo 60', '356938035643809', '8GB/128GB', 'Green', 14000, 16999, 'in_stock', 'purchase', ${FY_PREV}, 'direct', '2025-06-10T10:00:00+05:30'),
      (${PINV2}, 'Samsung', 'Galaxy M34', '354812097654321', '6GB/128GB', 'Blue', 13500, 15999, 'sold', 'purchase', ${FY_PREV}, 'direct', '2025-08-02T10:00:00+05:30')`

    // ─── FY 2026-27 inventory: in stock ────────────────────────────────────
    await tx`INSERT INTO inventory_items (id, brand, model, imei, ram_rom, color, purchase_price, base_selling_price, status, source, financial_year_id, opening_entry_type, origin_inventory_item_id, created_at) VALUES
      (${INV1}, 'Samsung',  'Galaxy S23',    '356908110234561', '8GB/256GB',  'Cream',    62000, 74999, 'in_stock', 'purchase',  ${FY_CUR}, 'direct', NULL, '2026-04-05T10:00:00+05:30'),
      (${INV2}, 'Apple',    'iPhone 14',     '356712045987123', '6GB/128GB',  'Blue',     58000, 69999, 'in_stock', 'purchase',  ${FY_CUR}, 'direct', NULL, '2026-04-05T10:01:00+05:30'),
      (${INV3}, 'Redmi',    'Note 12 Pro',   '358459012345678', '8GB/128GB',  'Midnight', 16500, 21999, 'in_stock', 'purchase',  ${FY_CUR}, 'direct', NULL, '2026-04-05T10:02:00+05:30'),
      (${INV4}, 'Vivo',     'V27',           '354789123456789', '8GB/128GB',  'Purple',   28000, 34999, 'in_stock', 'purchase',  ${FY_CUR}, 'direct', NULL, '2026-05-02T10:00:00+05:30'),
      (${INV5}, 'OnePlus',  '11R',           '352019876543210', '8GB/128GB',  'Sonic',    39000, 45999, 'in_stock', 'purchase',  ${FY_CUR}, 'direct', NULL, '2026-05-10T10:00:00+05:30'),
      (${INV6}, 'Realme',   'Narzo 60',      '356938035643819', '8GB/128GB',  'Green',    14000, 16999, 'in_stock', 'purchase',  ${FY_CUR}, 'carried_forward', ${PINV1}, '2026-04-01T06:30:00+05:30'),
      (${INV7}, 'OPPO',     'Reno 10',       '357201456987321', '8GB/256GB',  'Silver',   22000, 27999, 'in_stock', 'trade_in',  ${FY_CUR}, 'direct', NULL, '2026-06-15T10:00:00+05:30'),
      (${INV8}, 'Google',   'Pixel 7a',      '359876123450987', '8GB/128GB',  'Sea',      37000, 44999, 'in_stock', 'purchase',  ${FY_CUR}, 'direct', NULL, '2026-06-20T10:00:00+05:30')`

    // ─── FY 2026-27 inventory: sold ────────────────────────────────────────
    await tx`INSERT INTO inventory_items (id, brand, model, imei, ram_rom, color, purchase_price, base_selling_price, status, source, financial_year_id, opening_entry_type, created_at) VALUES
      (${SINV1}, 'Samsung', 'Galaxy A54',   '351209876543210', '8GB/128GB', 'Awesome Lilac', 30000, 38999, 'sold', 'purchase',  ${FY_CUR}, 'direct', '2026-04-11T10:00:00+05:30'),
      (${SINV2}, 'Motorola','Edge 40',      '356789012345678', '8GB/256GB', 'Eclipse',       26000, 32999, 'sold', 'purchase',  ${FY_CUR}, 'direct', '2026-04-11T10:01:00+05:30'),
      (${SINV3}, 'Apple',   'iPhone 13',    '353456789012345', '4GB/128GB', 'Starlight',     49000, 59999, 'sold', 'purchase',  ${FY_CUR}, 'direct', '2026-04-18T10:00:00+05:30'),
      (${SINV4}, 'Vivo',    'Y56',          '358901234567890', '6GB/128GB', 'Orange',        13000, 16999, 'sold', 'purchase',  ${FY_CUR}, 'direct', '2026-04-25T10:00:00+05:30'),
      (${SINV5}, 'Redmi',   'Note 11',      '355551234567890', '6GB/128GB', 'Horizon',        9000, 12999, 'sold', 'trade_in',  ${FY_CUR}, 'direct', '2026-06-01T10:00:00+05:30'),
      (${SINV6}, 'Samsung', 'Galaxy S21',   '357770123456789', '8GB/128GB', 'Phantom Grey', 36000, 45999, 'sold', 'purchase',  ${FY_CUR}, 'direct', '2026-07-05T10:00:00+05:30')`

    // ─── Purchases ─────────────────────────────────────────────────────────
    await tx`INSERT INTO purchases (id, bill_number, party_id, total, paid, due, bank_account_id, payment_mode_id, date, financial_year_id, status, created_at) VALUES
      (${PUR1}, 'PUR-2026-27-0001', ${PARTY_SUPPLIER}, 136500, 136500, 0, ${BANK_HDFC}, ${MODE_BANK}, ${D('2026-04-05')}, ${FY_CUR}, 'active', '2026-04-05T10:05:00+05:30'),
      (${PUR2}, 'PUR-2026-27-0002', ${PARTY_SUPPLIER},  65000, 30000, 35000, ${BANK_HDFC}, ${MODE_UPI}, ${D('2026-05-02')}, ${FY_CUR}, 'active', '2026-05-02T10:05:00+05:30'),
      (${PUR3}, 'PUR-2026-27-0003', ${PARTY_SUPPLIER2}, 39000, 39000, 0, ${BANK_SBI}, ${MODE_SBI_UPI}, ${D('2026-05-10')}, ${FY_CUR}, 'active', '2026-05-10T10:05:00+05:30'),
      (${PUR_TRD}, 'PUR-TRD-2026-27-0004', ${PARTY_RETAIL}, 22000, 22000, 0, ${BANK_CASH}, NULL, ${D('2026-06-15')}, ${FY_CUR}, 'active', '2026-06-15T10:05:00+05:30'),
      (${PUR_PREV}, 'PUR-2025-26-0009', ${PARTY_SUPPLIER}, 27500, 27500, 0, ${BANK_HDFC}, ${MODE_BANK}, ${D('2025-06-10')}, ${FY_PREV}, 'active', '2025-06-10T10:05:00+05:30')`

    // Hidden trade-in purchase for the RESOLD scenario: its purchase was
    // cancelled when the original sale was cancelled after the device resold.
    await tx`INSERT INTO purchases (id, bill_number, party_id, total, paid, due, bank_account_id, payment_mode_id, date, financial_year_id, status, created_at) VALUES
      (${PUR_TRD2}, 'PUR-TRD-2026-27-0002', ${PARTY_WALKIN}, 9000, 9000, 0, ${BANK_CASH}, NULL, ${D('2026-06-01')}, ${FY_CUR}, 'cancelled', '2026-06-01T10:05:00+05:30')`

    await tx`INSERT INTO purchase_items (id, purchase_id, inventory_item_id) VALUES
      (${id(250)}, ${PUR1}, ${INV1}),
      (${id(251)}, ${PUR1}, ${INV2}),
      (${id(252)}, ${PUR1}, ${INV3}),
      (${id(253)}, ${PUR2}, ${INV4}),
      (${id(254)}, ${PUR2}, ${INV8}),
      (${id(255)}, ${PUR3}, ${INV5}),
      (${id(256)}, ${PUR_TRD}, ${INV7}),
      (${id(257)}, ${PUR_PREV}, ${PINV1}),
      (${id(258)}, ${PUR_PREV}, ${PINV2}),
      (${id(259)}, ${PUR_TRD2}, ${SINV5})`

    // ─── Sales ─────────────────────────────────────────────────────────────
    // SAL1: paid multi-item sale (2 items, full payment)
    await tx`INSERT INTO sales (id, bill_number, party_id, total, discount, trade_in_credit, final_total, paid, due, bank_account_id, payment_mode_id, date, financial_year_id, status, created_at) VALUES
      (${SAL1}, 'SAL-2026-27-0001', ${PARTY_RETAIL}, 71998, 2000, 0, 69998, 69998, 0, ${BANK_HDFC}, ${MODE_UPI}, ${D('2026-04-11')}, ${FY_CUR}, 'active', '2026-04-11T11:00:00+05:30')`
    await tx`INSERT INTO sale_items (id, sale_id, inventory_item_id, sold_price) VALUES
      (${id(350)}, ${SAL1}, ${SINV1}, 38999),
      (${id(351)}, ${SAL1}, ${SINV2}, 32999)`

    // SAL2: partial payment sale (due)
    await tx`INSERT INTO sales (id, bill_number, party_id, total, discount, trade_in_credit, final_total, paid, due, bank_account_id, payment_mode_id, date, financial_year_id, status, created_at) VALUES
      (${SAL2}, 'SAL-2026-27-0002', ${PARTY_WALKIN}, 59999, 0, 0, 59999, 40000, 19999, ${BANK_CASH}, NULL, ${D('2026-04-18')}, ${FY_CUR}, 'active', '2026-04-18T11:00:00+05:30')`
    await tx`INSERT INTO sale_items (id, sale_id, inventory_item_id, sold_price) VALUES
      (${id(352)}, ${SAL2}, ${SINV3}, 59999)`

    // SAL3: cancelled sale (items restocked by the cancel cascade)
    await tx`INSERT INTO sales (id, bill_number, party_id, total, discount, trade_in_credit, final_total, paid, due, bank_account_id, payment_mode_id, date, financial_year_id, status, created_at) VALUES
      (${SAL3}, 'SAL-2026-27-0003', ${PARTY_NOBAL}, 16999, 0, 0, 16999, 0, 16999, ${BANK_CASH}, NULL, ${D('2026-04-25')}, ${FY_CUR}, 'cancelled', '2026-04-25T11:00:00+05:30')`
    await tx`INSERT INTO sale_items (id, sale_id, inventory_item_id, sold_price) VALUES
      (${id(353)}, ${SAL3}, ${SINV4}, 16999)`

    // SAL4: trade-in sale (paid, trade-in credit) — the OPPO Reno 10 came in
    await tx`INSERT INTO sales (id, bill_number, party_id, total, discount, trade_in_credit, final_total, paid, due, bank_account_id, payment_mode_id, date, financial_year_id, status, created_at) VALUES
      (${SAL4}, 'SAL-2026-27-0004', ${PARTY_RETAIL}, 38999, 0, 22000, 16999, 16999, 0, ${BANK_CASH}, NULL, ${D('2026-06-15')}, ${FY_CUR}, 'active', '2026-06-15T11:00:00+05:30')`
    await tx`INSERT INTO sale_items (id, sale_id, inventory_item_id, sold_price) VALUES
      (${id(354)}, ${SAL4}, ${SINV6}, 38999)`
    await tx`INSERT INTO trade_ins (id, sale_id, brand, model, imei, ram_rom, color, credit_value, mrp, document_url, new_inventory_item_id) VALUES
      (${TRD1}, ${SAL4}, 'OPPO', 'Reno 10', '357201456987321', '8GB/256GB', 'Silver', 22000, 26000, NULL, ${INV7})`

    // SAL5: sale that took a trade-in which was later resold (Action Required
    // scenario on the sale detail page) — the traded-in Redmi Note 11 (SINV5)
    // was resold in SAL6's place; its hidden purchase was cancelled.
    await tx`INSERT INTO sales (id, bill_number, party_id, total, discount, trade_in_credit, final_total, paid, due, bank_account_id, payment_mode_id, date, financial_year_id, status, created_at) VALUES
      (${SAL5}, 'SAL-2026-27-0005', ${PARTY_WALKIN}, 45999, 1000, 9000, 35999, 35999, 0, ${BANK_HDFC}, ${MODE_CARD}, ${D('2026-06-01')}, ${FY_CUR}, 'active', '2026-06-01T11:00:00+05:30')`
    // Item sold in SAL5 (a Samsung S23 FE):
    await tx`INSERT INTO inventory_items (id, brand, model, imei, ram_rom, color, purchase_price, base_selling_price, status, source, financial_year_id, opening_entry_type, created_at) VALUES
      (${id(117)}, 'Samsung', 'Galaxy S23 FE', '356123789456012', '8GB/128GB', 'Mint', 38000, 45999, 'sold', 'purchase', ${FY_CUR}, 'direct', '2026-05-28T10:00:00+05:30')`
    await tx`INSERT INTO sale_items (id, sale_id, inventory_item_id, sold_price) VALUES
      (${id(355)}, ${SAL5}, ${id(117)}, 45999)`
    await tx`INSERT INTO trade_ins (id, sale_id, brand, model, imei, ram_rom, color, credit_value, mrp, document_url, new_inventory_item_id) VALUES
      (${TRD2}, ${SAL5}, 'Redmi', 'Note 11', '355551234567890', '6GB/128GB', 'Horizon', 9000, 12999, NULL, ${SINV5})`

    // SAL6: sale from the converted proforma (Sunita Devi)
    await tx`INSERT INTO sales (id, bill_number, party_id, total, discount, trade_in_credit, final_total, paid, due, bank_account_id, payment_mode_id, date, financial_year_id, status, created_at) VALUES
      (${SAL6}, 'SAL-2026-27-0006', ${PARTY_ADDRESS}, 21999, 500, 0, 21499, 21499, 0, ${BANK_HDFC}, ${MODE_UPI}, ${D('2026-07-05')}, ${FY_CUR}, 'active', '2026-07-05T11:00:00+05:30')`
    await tx`INSERT INTO sale_items (id, sale_id, inventory_item_id, sold_price) VALUES
      (${id(356)}, ${SAL6}, ${INV3}, 21999)`

    // FY 2025-26 sale (prev year ledger)
    await tx`INSERT INTO sales (id, bill_number, party_id, total, discount, trade_in_credit, final_total, paid, due, bank_account_id, payment_mode_id, date, financial_year_id, status, created_at) VALUES
      (${SAL_PREV}, 'SAL-2025-26-0012', ${PARTY_RETAIL}, 15999, 0, 0, 15999, 15999, 0, ${BANK_CASH}, NULL, ${D('2025-08-02')}, ${FY_PREV}, 'active', '2025-08-02T11:00:00+05:30')`
    await tx`INSERT INTO sale_items (id, sale_id, inventory_item_id, sold_price) VALUES
      (${id(357)}, ${SAL_PREV}, ${PINV2}, 15999)`

    // ─── Payments in / out ─────────────────────────────────────────────────
    await tx`INSERT INTO payments_in (id, sale_id, party_id, amount, bank_account_id, payment_mode_id, date, financial_year_id, created_at) VALUES
      (${PAYIN1}, ${SAL1}, ${PARTY_RETAIL}, 69998, ${BANK_HDFC}, ${MODE_UPI}, ${D('2026-04-11')}, ${FY_CUR}, '2026-04-11T11:01:00+05:30'),
      (${PAYIN2}, ${SAL2}, ${PARTY_WALKIN}, 25000, ${BANK_CASH}, NULL, ${D('2026-04-18')}, ${FY_CUR}, '2026-04-18T11:01:00+05:30'),
      (${PAYIN3}, ${SAL2}, ${PARTY_WALKIN}, 15000, ${BANK_CASH}, NULL, ${D('2026-05-20')}, ${FY_CUR}, '2026-05-20T12:00:00+05:30'),
      (${id(507)}, ${SAL4}, ${PARTY_RETAIL}, 16999, ${BANK_CASH}, NULL, ${D('2026-06-15')}, ${FY_CUR}, '2026-06-15T11:01:00+05:30'),
      (${id(508)}, ${SAL5}, ${PARTY_WALKIN}, 35999, ${BANK_HDFC}, ${MODE_CARD}, ${D('2026-06-01')}, ${FY_CUR}, '2026-06-01T11:01:00+05:30'),
      (${id(509)}, ${SAL6}, ${PARTY_ADDRESS}, 21499, ${BANK_HDFC}, ${MODE_UPI}, ${D('2026-07-05')}, ${FY_CUR}, '2026-07-05T11:01:00+05:30'),
      (${id(510)}, ${SAL_PREV}, ${PARTY_RETAIL}, 15999, ${BANK_CASH}, NULL, ${D('2025-08-02')}, ${FY_PREV}, '2025-08-02T11:01:00+05:30')`
    await tx`INSERT INTO payments_out (id, purchase_id, party_id, amount, bank_account_id, payment_mode_id, date, financial_year_id, created_at) VALUES
      (${PAYOUT1}, ${PUR1}, ${PARTY_SUPPLIER}, 136500, ${BANK_HDFC}, ${MODE_BANK}, ${D('2026-04-05')}, ${FY_CUR}, '2026-04-05T10:06:00+05:30'),
      (${PAYOUT2}, ${PUR2}, ${PARTY_SUPPLIER}, 30000, ${BANK_HDFC}, ${MODE_UPI}, ${D('2026-05-02')}, ${FY_CUR}, '2026-05-02T10:06:00+05:30'),
      (${id(511)}, ${PUR3}, ${PARTY_SUPPLIER2}, 39000, ${BANK_SBI}, ${MODE_SBI_UPI}, ${D('2026-05-10')}, ${FY_CUR}, '2026-05-10T10:06:00+05:30'),
      (${id(512)}, ${PUR_PREV}, ${PARTY_SUPPLIER}, 27500, ${BANK_HDFC}, ${MODE_BANK}, ${D('2025-06-10')}, ${FY_PREV}, '2025-06-10T10:06:00+05:30')`

    // FY 2025-26 opening capital (so the closed year's ledger is realistic
    // and its closing balances match the carried-forward openings below).
    await tx`INSERT INTO account_fund_entries (id, bank_account_id, amount, date, notes, financial_year_id) VALUES
      (${id(513)}, ${BANK_CASH}, 50000, ${D('2025-04-01')}, 'FY opening cash', ${FY_PREV}),
      (${id(514)}, ${BANK_HDFC}, 70000, ${D('2025-04-01')}, 'FY opening bank', ${FY_PREV})`
    await tx`INSERT INTO account_transactions (id, bank_account_id, payment_mode_id, type, amount, date, reference_type, reference_id, financial_year_id, notes, created_at) VALUES
      (${TX(20)}, ${BANK_CASH}, NULL, 'credit', 50000, ${D('2025-04-01')}, 'add_funds', ${id(513)}, ${FY_PREV}, 'FY opening cash', '2025-04-01T09:00:00+05:30'),
      (${TX(21)}, ${BANK_HDFC}, NULL, 'credit', 70000, ${D('2025-04-01')}, 'add_funds', ${id(514)}, ${FY_PREV}, 'FY opening bank', '2025-04-01T09:00:00+05:30'),
      (${TX(22)}, ${BANK_CASH}, NULL, 'credit', 15999, ${D('2025-08-02')}, 'sale', ${SAL_PREV}, ${FY_PREV}, NULL, '2025-08-02T11:01:00+05:30'),
      (${TX(23)}, ${BANK_HDFC}, ${MODE_BANK}, 'debit', 27500, ${D('2025-06-10')}, 'purchase', ${PUR_PREV}, ${FY_PREV}, NULL, '2025-06-10T10:06:00+05:30')`
    // FY 2025-26 closes at: cash 65999, hdfc 42500, sbi 0.

    // ─── Fund entry + transfer ─────────────────────────────────────────────
    await tx`INSERT INTO account_fund_entries (id, bank_account_id, amount, date, notes, financial_year_id) VALUES
      (${FUND1}, ${BANK_HDFC}, 200000, ${D('2026-04-01')}, 'Opening capital deposit', ${FY_CUR})`
    await tx`INSERT INTO account_transfers (id, from_bank_account_id, to_bank_account_id, amount, date, notes, financial_year_id) VALUES
      (${TRANSFER1}, ${BANK_HDFC}, ${BANK_SBI}, 50000, ${D('2026-04-02')}, 'SBI parking', ${FY_CUR})`

    // ─── Account transactions (opening balances + FY activity) ────────────
    // Opening balances carried from FY 2025-26 (as a real close would produce).
    await tx`INSERT INTO account_transactions (id, bank_account_id, payment_mode_id, type, amount, date, reference_type, reference_id, financial_year_id, notes, transfer_group_id, created_at) VALUES
      (${TX(1)}, ${BANK_CASH}, NULL, 'credit', 65999, ${D('2026-04-01')}, 'opening_balance', ${FY_PREV}, ${FY_CUR}, 'Opening balance carried forward from FY 2025–26', NULL, '2026-04-01T06:30:00+05:30'),
      (${TX(2)}, ${BANK_HDFC}, NULL, 'credit', 42500, ${D('2026-04-01')}, 'opening_balance', ${FY_PREV}, ${FY_CUR}, 'Opening balance carried forward from FY 2025–26', NULL, '2026-04-01T06:30:00+05:30'),
      -- add funds + transfer
      (${TX(3)}, ${BANK_HDFC}, NULL, 'credit', 200000, ${D('2026-04-01')}, 'add_funds', ${FUND1}, ${FY_CUR}, 'Opening capital deposit', NULL, '2026-04-01T09:00:00+05:30'),
      (${TX(4)}, ${BANK_HDFC}, NULL, 'debit', 50000, ${D('2026-04-02')}, 'transfer', ${TRANSFER1}, ${FY_CUR}, 'SBI parking', ${id(900)}, '2026-04-02T09:00:00+05:30'),
      (${TX(5)}, ${BANK_SBI}, NULL, 'credit', 50000, ${D('2026-04-02')}, 'transfer', ${TRANSFER1}, ${FY_CUR}, 'SBI parking', ${id(900)}, '2026-04-02T09:00:00+05:30'),
      -- purchase payments (debits)
      (${TX(6)}, ${BANK_HDFC}, ${MODE_BANK}, 'debit', 136500, ${D('2026-04-05')}, 'purchase', ${PUR1}, ${FY_CUR}, NULL, NULL, '2026-04-05T10:06:00+05:30'),
      (${TX(7)}, ${BANK_HDFC}, ${MODE_UPI}, 'debit', 30000, ${D('2026-05-02')}, 'purchase', ${PUR2}, ${FY_CUR}, NULL, NULL, '2026-05-02T10:06:00+05:30'),
      (${TX(8)}, ${BANK_SBI}, ${MODE_SBI_UPI}, 'debit', 39000, ${D('2026-05-10')}, 'purchase', ${PUR3}, ${FY_CUR}, NULL, NULL, '2026-05-10T10:06:00+05:30'),
      -- trade-in purchases were "paid" instantly in cash (no tx rows created
      --   by the reference app — the credit offsets the sale payment; the
      --   trade-in sale credits below carry the net), matching create_sale
      --   semantics exactly: trade-in purchases create NO account tx.
      -- sale payments (credits)
      (${TX(9)}, ${BANK_HDFC}, ${MODE_UPI}, 'credit', 69998, ${D('2026-04-11')}, 'sale', ${SAL1}, ${FY_CUR}, NULL, NULL, '2026-04-11T11:01:00+05:30'),
      (${TX(10)}, ${BANK_CASH}, NULL, 'credit', 25000, ${D('2026-04-18')}, 'payment_in', ${PAYIN2}, ${FY_CUR}, NULL, NULL, '2026-04-18T11:01:00+05:30'),
      (${TX(11)}, ${BANK_HDFC}, ${MODE_CARD}, 'credit', 35999, ${D('2026-06-01')}, 'sale', ${SAL5}, ${FY_CUR}, NULL, NULL, '2026-06-01T11:01:00+05:30'),
      (${TX(12)}, ${BANK_CASH}, NULL, 'credit', 16999, ${D('2026-06-15')}, 'sale', ${SAL4}, ${FY_CUR}, NULL, NULL, '2026-06-15T11:01:00+05:30'),
      (${TX(13)}, ${BANK_CASH}, NULL, 'credit', 15000, ${D('2026-05-20')}, 'payment_in', ${PAYIN3}, ${FY_CUR}, NULL, NULL, '2026-05-20T12:00:00+05:30'),
      (${TX(14)}, ${BANK_HDFC}, ${MODE_UPI}, 'credit', 21499, ${D('2026-07-05')}, 'sale', ${SAL6}, ${FY_CUR}, NULL, NULL, '2026-07-05T11:01:00+05:30')`

    // ─── Proformas ─────────────────────────────────────────────────────────
    await tx`INSERT INTO proforma_invoices (id, bill_number, party_id, total, discount, trade_in_credit, final_total, date, financial_year_id, status, created_at) VALUES
      (${PRO1}, 'PI-2026-27-0001', ${PARTY_RETAIL},  84999, 1500, 0, 83499, ${D('2026-06-20')}, ${FY_CUR}, 'active', '2026-06-20T12:00:00+05:30'),
      (${PRO2}, 'PI-2026-27-0002', ${PARTY_WALKIN},  21999, 0,   0, 21999, ${D('2026-07-01')}, ${FY_CUR}, 'active', '2026-07-01T12:00:00+05:30'),
      (${PRO3}, 'PI-2026-27-0003', ${PARTY_ADDRESS}, 22499, 500, 0, 21999, ${D('2026-07-04')}, ${FY_CUR}, 'converted', '2026-07-04T12:00:00+05:30')`
    await tx`INSERT INTO proforma_invoice_items (id, proforma_invoice_id, description, qty, rate, discount, value) VALUES
      (${id(750)}, ${PRO1}, 'Apple iPhone 14 128GB', 1, 69999, 0, 69999),
      (${id(751)}, ${PRO1}, 'Case + Tempered Glass', 1, 1500, 0, 15000),
      (${id(752)}, ${PRO2}, 'Redmi Note 12 Pro', 1, 21999, 0, 21999),
      (${id(753)}, ${PRO3}, 'Redmi Note 12 Pro', 1, 21999, 0, 21999),
      (${id(754)}, ${PRO3}, 'Screen protection plan', 1, 500, 0, 500)`
    await tx`INSERT INTO proforma_trade_ins (id, proforma_invoice_id, description, qty, rate, value) VALUES
      (${id(760)}, ${PRO1}, 'Old Samsung Galaxy M21', 1, 10000, 10000)`

    // ─── WhatsApp settings ─────────────────────────────────────────────────
    await tx`INSERT INTO whatsapp_settings (id, auto_send_sale, auto_send_purchase, auto_send_proforma, sale_message_template, purchase_message_template, proforma_message_template) VALUES (
      ${WHS}, true, false, false,
      'Hello {{customer_name}},

Please find your invoice {{invoice_number}} from {{company_name}} attached.

Total: ₹{{grand_total}}

Thank you for your business.',
      'Hello {{customer_name}},

Please find your purchase bill {{invoice_number}} from {{company_name}} attached.

Total: ₹{{grand_total}}',
      'Hello {{customer_name}},

Please find your quotation {{invoice_number}} from {{company_name}} attached.

Estimated Total: ₹{{grand_total}}')`
  })

  console.log('Seed rows inserted. Verifying consistency...')

  // ─── Verification (spec §38: verify seed data) ───────────────────────────
  const problems: string[] = []

  // 1. Sale paid/due consistency vs payments_in
  const salePay = await sql`
    SELECT s.bill_number, s.paid, COALESCE(SUM(p.amount), 0) AS pay_sum
      FROM sales s LEFT JOIN payments_in p ON p.sale_id = s.id
     GROUP BY s.id, s.bill_number, s.paid
     HAVING s.paid <> COALESCE(SUM(p.amount), 0)`
  if (salePay.length > 0) problems.push(`sale/payments mismatch: ${JSON.stringify(salePay)}`)

  // 2. Purchase paid/due vs payments_out
  const purPay = await sql`
    SELECT p.bill_number, p.paid, COALESCE(SUM(o.amount), 0) AS pay_sum
      FROM purchases p LEFT JOIN payments_out o ON o.purchase_id = p.id
     WHERE p.bill_number NOT LIKE 'PUR-TRD-%'
     GROUP BY p.id, p.bill_number, p.paid
     HAVING p.paid <> COALESCE(SUM(o.amount), 0)`
  if (purPay.length > 0) problems.push(`purchase/payments mismatch: ${JSON.stringify(purPay)}`)

  // 3. IMEI uniqueness among in_stock
  const dupeImei = await sql`
    SELECT imei, count(*) FROM inventory_items WHERE status = 'in_stock'
     GROUP BY imei HAVING count(*) > 1`
  if (dupeImei.length > 0) problems.push(`duplicate in-stock IMEIs: ${JSON.stringify(dupeImei)}`)

  // 4. Counters continue the seeded bill sequence
  const fy = await sql`SELECT sale_counter, purchase_counter, proforma_counter FROM financial_years WHERE id = ${FY_CUR}`
  const c = fy[0]
  if (c.sale_counter !== 6) problems.push(`sale_counter expected 6, got ${c.sale_counter}`)
  if (c.purchase_counter !== 4) problems.push(`purchase_counter expected 4, got ${c.purchase_counter}`)
  if (c.proforma_counter !== 3) problems.push(`proforma_counter expected 3, got ${c.proforma_counter}`)

  // 5. Balances per account (FY 2026-27)
  const balances = await sql`
    SELECT b.name, COALESCE(SUM(CASE WHEN t.type='credit' THEN t.amount ELSE -t.amount END), 0) AS bal
      FROM bank_accounts b
      LEFT JOIN account_transactions t
        ON t.bank_account_id = b.id AND t.financial_year_id = ${FY_CUR}
     GROUP BY b.name ORDER BY b.name`
  console.log('FY 2026-27 balances:', balances.map((b) => `${b.name}=${b.bal}`).join(', '))

  // 6. Row counts sanity
  const counts = await sql`
    SELECT
      (SELECT count(*) FROM sales) AS sales,
      (SELECT count(*) FROM purchases) AS purchases,
      (SELECT count(*) FROM inventory_items) AS inventory,
      (SELECT count(*) FROM parties) AS parties,
      (SELECT count(*) FROM account_transactions) AS tx,
      (SELECT count(*) FROM proforma_invoices) AS proformas,
      (SELECT count(*) FROM trade_ins) AS trade_ins`
  console.log('Row counts:', counts[0])

  if (problems.length > 0) {
    console.error('CONSISTENCY PROBLEMS:')
    for (const p of problems) console.error(' -', p)
    process.exit(1)
  }
  console.log('Seed verification PASSED.')
  await sql.end()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
