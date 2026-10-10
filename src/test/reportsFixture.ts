/**
 * The shared controlled business scenario for the report test suites
 * (reportsData.test.ts + reportsExcel.test.ts).
 *
 * Hand-computed expected values are documented inline in the tests; this
 * module only supplies the raw fold. The scenario covers: multi-item
 * invoices, cancelled sales with retained payments and their compensating
 * cancellation entries, virtual trade-in acquisition bills (both the
 * PUR-TRD prefix and the all-items-sourced rule) and recovery bills, the
 * full payment state spectrum on sales AND purchases (paid / partial /
 * unpaid), cash vs UPI modes, payments dated away from their bills, an
 * internal account transfer pair and an opening balance, financial-year
 * boundary records (1 Apr 2026 and 31 Mar 2027 inside the window; one
 * 1 Apr 2027 record that must never leak into an FY 2026-27 report), and
 * multiple acquisition ages.
 */
import type { AnalyticsFold } from '@/features/analytics/types'

export const TODAY = '2026-12-06'
export const GENERATED_AT = '2026-12-06T10:30:00.000Z'
export const FY = { start_date: '2026-04-01', end_date: '2027-03-31' }
export const FULL_FY = { preset: 'custom' as const, from: '2026-04-01', to: '2027-03-31' }
export const STORE = { name: 'ABC Mobile Store', address: '12 Market Road', phone: '+919900112233' }

export function makeFold(): AnalyticsFold {
  return {
    fyId: 'fy1',
    sales: [
      { id: 's1', bill_number: 'SAL-2026-27-0001', date: '2026-10-07', party_id: 'pA', party_name: 'Aditya Singh', total: 35000, discount: 0, trade_in_credit: 0, final_total: 35000, paid: 35000, due: 0, status: 'active', created_at: '2026-10-07T09:00:00Z', proforma_id: null },
      { id: 's2', bill_number: 'SAL-2026-27-0002', date: '2026-10-07', party_id: 'pB', party_name: 'Priya Verma', total: 34999, discount: 0, trade_in_credit: 3000, final_total: 31999, paid: 0, due: 31999, status: 'active', created_at: '2026-10-07T10:00:00Z', proforma_id: null },
      { id: 's3', bill_number: 'SAL-2026-27-0003', date: '2026-09-15', party_id: 'pA', party_name: 'Aditya Singh', total: 20000, discount: 500, trade_in_credit: 0, final_total: 19500, paid: 5000, due: 14500, status: 'active', created_at: '2026-09-15T10:00:00Z', proforma_id: null },
      { id: 's4', bill_number: 'SAL-2026-27-0004', date: '2026-10-09', party_id: 'pA', party_name: 'Aditya Singh', total: 9999, discount: 0, trade_in_credit: 0, final_total: 9999, paid: 9999, due: 0, status: 'cancelled', created_at: '2026-10-09T10:00:00Z', proforma_id: null },
      { id: 's5', bill_number: 'SAL-2026-27-0005', date: '2026-11-20', party_id: 'pB', party_name: 'Priya Verma', total: 60000, discount: 0, trade_in_credit: 0, final_total: 60000, paid: 60000, due: 0, status: 'active', created_at: '2026-11-20T10:00:00Z', proforma_id: null },
      { id: 's6', bill_number: 'SAL-2026-27-0006', date: '2026-06-20', party_id: 'pA', party_name: 'Aditya Singh', total: 8000, discount: 0, trade_in_credit: 0, final_total: 8000, paid: 0, due: 8000, status: 'active', created_at: '2026-06-20T10:00:00Z', proforma_id: null },
      // FY START boundary record (1 April 2026) — must appear in every
      // FY 2026-27 period report.
      { id: 's7', bill_number: 'SAL-2026-27-0007', date: '2026-04-01', party_id: 'pA', party_name: 'Aditya Singh', total: 15999, discount: 0, trade_in_credit: 0, final_total: 15999, paid: 15999, due: 0, status: 'active', created_at: '2026-04-01T10:00:00Z', proforma_id: null },
      // FY END boundary record (31 March 2027) — must appear in every
      // FY 2026-27 period report.
      { id: 's8', bill_number: 'SAL-2026-27-0008', date: '2027-03-31', party_id: 'pB', party_name: 'Priya Verma', total: 2500, discount: 0, trade_in_credit: 0, final_total: 2500, paid: 0, due: 2500, status: 'active', created_at: '2027-03-31T10:00:00Z', proforma_id: null },
      // OUT-OF-WINDOW record (1 April 2027 — the first day of the NEXT
      // financial year). It exists in the fold as anomalous data: every
      // FY 2026-27 period must exclude it, even when a custom range that
      // would nominally cover it is requested (the FY clamp holds).
      { id: 's9', bill_number: 'SAL-2027-28-0001', date: '2027-04-01', party_id: 'pA', party_name: 'Aditya Singh', total: 5000, discount: 0, trade_in_credit: 0, final_total: 5000, paid: 5000, due: 0, status: 'active', created_at: '2027-04-01T10:00:00Z', proforma_id: null },
    ],
    purchases: [
      { id: 'p1', bill_number: 'PUR-2026-27-0001', date: '2026-10-05', party_id: 'pS', party_name: 'Shree Balaji Mobiles', total: 100000, paid: 100000, due: 0, status: 'active', created_at: '2026-10-05T09:00:00Z', is_virtual: false },
      { id: 'p2', bill_number: 'PUR-2026-27-0002', date: '2026-11-10', party_id: 'pS', party_name: 'Shree Balaji Mobiles', total: 91000, paid: 40000, due: 51000, status: 'active', created_at: '2026-11-10T09:00:00Z', is_virtual: false },
      { id: 'v1', bill_number: 'PUR-TRD-2026-27-0003', date: '2026-10-07', party_id: 'pB', party_name: 'Priya Verma', total: 3000, paid: 3000, due: 0, status: 'cancelled', created_at: '2026-10-07T10:00:00Z', is_virtual: true },
      { id: 'r1', bill_number: 'PUR-26-27-0006', date: '2026-12-01', party_id: 'pB', party_name: 'Priya Verma', total: 3000, paid: 3000, due: 0, status: 'active', created_at: '2026-12-01T10:00:00Z', is_virtual: true },
      // FY START boundary purchase (1 April 2026), fully paid the same day.
      { id: 'p3', bill_number: 'PUR-2026-27-0005', date: '2026-04-01', party_id: 'pS', party_name: 'Shree Balaji Mobiles', total: 13500, paid: 13500, due: 0, status: 'active', created_at: '2026-04-01T10:00:00Z', is_virtual: false },
      // The fully UNPAID multi-device supplier purchase (Q4).
      { id: 'p4', bill_number: 'PUR-2026-27-0004', date: '2027-01-15', party_id: 'pS', party_name: 'Shree Balaji Mobiles', total: 24000, paid: 0, due: 24000, status: 'active', created_at: '2027-01-15T10:00:00Z', is_virtual: false },
    ],
    saleItems: [
      { sale_id: 's1', sold_price: 35000, inventory_items: { id: 'i1', brand: 'Samsung', model: 'Galaxy S22', imei: 'A1', ram_rom: '8/128', color: 'Phantom Black', base_selling_price: 35000, purchase_price: 30000, status: 'sold', source: 'purchase' } },
      { sale_id: 's2', sold_price: 34999, inventory_items: { id: 'i2', brand: 'Apple', model: 'iPhone 13', imei: 'A2', ram_rom: null, color: null, base_selling_price: 34999, purchase_price: 28500, status: 'sold', source: 'purchase' } },
      { sale_id: 's3', sold_price: 19500, inventory_items: { id: 'i3', brand: 'Realme', model: '12 Pro+', imei: 'A3', ram_rom: null, color: null, base_selling_price: 20000, purchase_price: 16000, status: 'sold', source: 'purchase' } },
      { sale_id: 's4', sold_price: 9999, inventory_items: { id: 'i7', brand: 'Vivo', model: 'V29 5G', imei: 'A7', ram_rom: null, color: null, base_selling_price: 9999, purchase_price: 8000, status: 'in_stock', source: 'purchase' } },
      { sale_id: 's5', sold_price: 35000, inventory_items: { id: 'i5', brand: 'Samsung', model: 'Galaxy S23', imei: 'B1', ram_rom: null, color: null, base_selling_price: 35000, purchase_price: 20000, status: 'sold', source: 'purchase' } },
      { sale_id: 's5', sold_price: 25000, inventory_items: { id: 'i6', brand: 'Google', model: 'Pixel 8', imei: 'B5', ram_rom: null, color: null, base_selling_price: 25000, purchase_price: 21000, status: 'sold', source: 'purchase' } },
      { sale_id: 's6', sold_price: 8000, inventory_items: { id: 'i8', brand: 'Nokia', model: 'G42', imei: 'B8', ram_rom: null, color: null, base_selling_price: 8000, purchase_price: 6500, status: 'sold', source: 'purchase' } },
      { sale_id: 's7', sold_price: 15999, inventory_items: { id: 'i9', brand: 'Motorola', model: 'Moto G84 5G', imei: 'X9', ram_rom: '12/256', color: 'Viva Magenta', base_selling_price: 15999, purchase_price: 13500, status: 'sold', source: 'purchase' } },
      { sale_id: 's8', sold_price: 2500, inventory_items: { id: 'i10', brand: 'Realme', model: 'C55', imei: 'X10', ram_rom: null, color: null, base_selling_price: 2500, purchase_price: 2000, status: 'sold', source: 'trade_in' } },
    ],
    purchaseItems: [
      { purchase_id: 'p1', inventory_items: { id: 'x1', brand: 'Samsung', model: 'Galaxy S22', imei: 'X1', ram_rom: '8/128', color: 'Phantom Black', purchase_price: 30000, source: 'purchase' } },
      { purchase_id: 'p2', inventory_items: { id: 'x2', brand: 'Apple', model: 'iPhone 13', imei: 'X2', ram_rom: null, color: null, purchase_price: 28500, source: 'purchase' } },
      { purchase_id: 'v1', inventory_items: { id: 'i4', brand: 'Vivo', model: 'V25', imei: 'B2', ram_rom: null, color: null, purchase_price: 3000, source: 'trade_in' } },
      { purchase_id: 'r1', inventory_items: { id: 'i4', brand: 'Vivo', model: 'V25', imei: 'B2', ram_rom: null, color: null, purchase_price: 3000, source: 'trade_in' } },
      { purchase_id: 'p3', inventory_items: { id: 'i9', brand: 'Motorola', model: 'Moto G84 5G', imei: 'X9', ram_rom: '12/256', color: 'Viva Magenta', purchase_price: 13500, source: 'purchase' } },
      { purchase_id: 'p4', inventory_items: { id: 'i11', brand: 'Samsung', model: 'Galaxy M14', imei: 'X11', ram_rom: '6/128', color: 'Arctic Blue', purchase_price: 9500, source: 'purchase' } },
      { purchase_id: 'p4', inventory_items: { id: 'i12', brand: 'Poco', model: 'X6 5G', imei: 'X12', ram_rom: '8/256', color: 'Black', purchase_price: 14500, source: 'purchase' } },
    ],
    paymentsIn: [
      { id: 'pi1', sale_id: 's1', party_id: 'pA', party_name: 'Aditya Singh', amount: 35000, date: '2026-10-07', created_at: '2026-10-07T09:30:00Z', bank_account_id: 'b1', payment_mode_id: 'm1', sale_bill_number: 'SAL-2026-27-0001', bank_name: 'HDFC Current Account', bank_is_cash: false, mode_name: 'UPI' },
      { id: 'pi2', sale_id: 's3', party_id: 'pA', party_name: 'Aditya Singh', amount: 5000, date: '2026-11-03', created_at: '2026-11-03T09:30:00Z', bank_account_id: 'b2', payment_mode_id: null, sale_bill_number: 'SAL-2026-27-0003', bank_name: 'Cash', bank_is_cash: true, mode_name: null },
      // FY START boundary payment (1 April 2026).
      { id: 'pi3', sale_id: 's7', party_id: 'pA', party_name: 'Aditya Singh', amount: 15999, date: '2026-04-01', created_at: '2026-04-01T09:30:00Z', bank_account_id: 'b1', payment_mode_id: 'm1', sale_bill_number: 'SAL-2026-27-0007', bank_name: 'HDFC Current Account', bank_is_cash: false, mode_name: 'UPI' },
      // Payment made AT sale creation (the ledger carries it with the
      // 'sale' reference type).
      { id: 'pi4', sale_id: 's5', party_id: 'pB', party_name: 'Priya Verma', amount: 60000, date: '2026-11-20', created_at: '2026-11-20T09:30:00Z', bank_account_id: 'b1', payment_mode_id: 'm1', sale_bill_number: 'SAL-2026-27-0005', bank_name: 'HDFC Current Account', bank_is_cash: false, mode_name: 'UPI' },
      // Retained payment of the CANCELLED sale s4 (refunded by the
      // compensating sale_cancelled ledger entry).
      { id: 'pi5', sale_id: 's4', party_id: 'pA', party_name: 'Aditya Singh', amount: 9999, date: '2026-10-09', created_at: '2026-10-09T09:30:00Z', bank_account_id: 'b2', payment_mode_id: null, sale_bill_number: 'SAL-2026-27-0004', bank_name: 'Cash', bank_is_cash: true, mode_name: null },
    ],
    paymentsOut: [
      { id: 'po1', purchase_id: 'p1', party_id: 'pS', party_name: 'Shree Balaji Mobiles', amount: 100000, date: '2026-10-05', created_at: '2026-10-05T09:30:00Z', bank_account_id: 'b1', payment_mode_id: 'm1', purchase_bill_number: 'PUR-2026-27-0001', bank_name: 'HDFC Current Account', bank_is_cash: false, mode_name: 'UPI' },
      // FY START boundary payment (1 April 2026).
      { id: 'po2', purchase_id: 'p3', party_id: 'pS', party_name: 'Shree Balaji Mobiles', amount: 13500, date: '2026-04-01', created_at: '2026-04-01T09:30:00Z', bank_account_id: 'b1', payment_mode_id: 'm1', purchase_bill_number: 'PUR-2026-27-0005', bank_name: 'HDFC Current Account', bank_is_cash: false, mode_name: 'UPI' },
    ],
    accountTransactions: [
      // Payment movements (later-payment reference pattern).
      { id: 't1', bank_account_id: 'b1', payment_mode_id: 'm1', type: 'credit', amount: 35000, date: '2026-10-07', reference_type: 'payment_in', reference_id: 'pi1', notes: null, transfer_group_id: null, created_at: '2026-10-07T09:30:00Z' },
      { id: 't2', bank_account_id: 'b2', payment_mode_id: null, type: 'credit', amount: 5000, date: '2026-11-03', reference_type: 'payment_in', reference_id: 'pi2', notes: null, transfer_group_id: null, created_at: '2026-11-03T09:30:00Z' },
      { id: 't3', bank_account_id: 'b1', payment_mode_id: 'm1', type: 'credit', amount: 15999, date: '2026-04-01', reference_type: 'payment_in', reference_id: 'pi3', notes: null, transfer_group_id: null, created_at: '2026-04-01T09:30:00Z' },
      // The payment made at sale creation ('sale' reference).
      { id: 't4', bank_account_id: 'b1', payment_mode_id: 'm1', type: 'credit', amount: 60000, date: '2026-11-20', reference_type: 'sale', reference_id: 's5', notes: null, transfer_group_id: null, created_at: '2026-11-20T09:30:00Z' },
      // The retained payment of the cancelled sale…
      { id: 't5', bank_account_id: 'b2', payment_mode_id: null, type: 'credit', amount: 9999, date: '2026-10-09', reference_type: 'payment_in', reference_id: 'pi5', notes: null, transfer_group_id: null, created_at: '2026-10-09T09:30:00Z' },
      // …and its compensating cancellation reversal (net zero).
      { id: 't6', bank_account_id: 'b2', payment_mode_id: null, type: 'debit', amount: 9999, date: '2026-10-09', reference_type: 'sale_cancelled', reference_id: 's4', notes: null, transfer_group_id: null, created_at: '2026-10-09T10:30:00Z' },
      // Outgoing payments.
      { id: 't7', bank_account_id: 'b1', payment_mode_id: 'm1', type: 'debit', amount: 100000, date: '2026-10-05', reference_type: 'payment_out', reference_id: 'po1', notes: null, transfer_group_id: null, created_at: '2026-10-05T09:30:00Z' },
      { id: 't8', bank_account_id: 'b1', payment_mode_id: 'm1', type: 'debit', amount: 13500, date: '2026-04-01', reference_type: 'payment_out', reference_id: 'po2', notes: null, transfer_group_id: null, created_at: '2026-04-01T09:30:00Z' },
      // INTERNAL: the account transfer pair (both legs, one group) and an
      // opening balance — listed in the Money Register but excluded from
      // its totals.
      { id: 't9', bank_account_id: 'b1', payment_mode_id: null, type: 'debit', amount: 15000, date: '2026-12-02', reference_type: 'transfer', reference_id: 'trf1', notes: 'Counter cash float', transfer_group_id: 'g1', created_at: '2026-12-02T09:00:00Z' },
      { id: 't10', bank_account_id: 'b2', payment_mode_id: null, type: 'credit', amount: 15000, date: '2026-12-02', reference_type: 'transfer', reference_id: 'trf1', notes: 'Counter cash float', transfer_group_id: 'g1', created_at: '2026-12-02T09:00:00Z' },
      { id: 't11', bank_account_id: 'b2', payment_mode_id: null, type: 'credit', amount: 20000, date: '2026-04-01', reference_type: 'opening_balance', reference_id: 'ob1', notes: null, transfer_group_id: null, created_at: '2026-04-01T00:05:00Z' },
    ],
    inventory: [
      { id: 'i5', brand: 'Samsung', model: 'Galaxy S23', imei: 'B1', ram_rom: null, color: null, purchase_price: 20000, base_selling_price: 25000, status: 'sold', source: 'purchase', created_at: '2026-09-01T00:00:00Z', origin_inventory_item_id: null, opening_entry_type: 'direct' },
      { id: 'i4', brand: 'Vivo', model: 'V25', imei: 'B2', ram_rom: null, color: null, purchase_price: 3000, base_selling_price: 3000, status: 'in_stock', source: 'trade_in', created_at: '2026-10-07T00:00:00Z', origin_inventory_item_id: null, opening_entry_type: 'direct' },
      { id: 'i7', brand: 'Vivo', model: 'V29 5G', imei: 'B7', ram_rom: null, color: null, purchase_price: 8000, base_selling_price: 9999, status: 'in_stock', source: 'purchase', created_at: '2026-11-15T00:00:00Z', origin_inventory_item_id: null, opening_entry_type: 'direct' },
      { id: 'i1', brand: 'Samsung', model: 'Galaxy S22', imei: 'A1', ram_rom: null, color: null, purchase_price: 30000, base_selling_price: 35000, status: 'sold', source: 'purchase', created_at: '2026-08-01T00:00:00Z', origin_inventory_item_id: null, opening_entry_type: 'direct' },
      { id: 'i9', brand: 'Motorola', model: 'Moto G84 5G', imei: 'X9', ram_rom: '12/256', color: 'Viva Magenta', purchase_price: 13500, base_selling_price: 15999, status: 'sold', source: 'purchase', created_at: '2026-04-01T00:00:00Z', origin_inventory_item_id: null, opening_entry_type: 'direct' },
      { id: 'i10', brand: 'Realme', model: 'C55', imei: 'X10', ram_rom: null, color: null, purchase_price: 2000, base_selling_price: 2500, status: 'sold', source: 'trade_in', created_at: '2026-06-18T00:00:00Z', origin_inventory_item_id: null, opening_entry_type: 'direct' },
      { id: 'i11', brand: 'Samsung', model: 'Galaxy M14', imei: 'X11', ram_rom: '6/128', color: 'Arctic Blue', purchase_price: 9500, base_selling_price: 11999, status: 'in_stock', source: 'purchase', created_at: '2027-01-15T00:00:00Z', origin_inventory_item_id: null, opening_entry_type: 'direct' },
      { id: 'i12', brand: 'Poco', model: 'X6 5G', imei: 'X12', ram_rom: '8/256', color: 'Black', purchase_price: 14500, base_selling_price: 17499, status: 'in_stock', source: 'purchase', created_at: '2027-01-15T00:00:00Z', origin_inventory_item_id: null, opening_entry_type: 'direct' },
    ],
    tradeIns: [
      { id: 't1', sale_id: 's2', inventory_item_id: 'i4', credit_value: 3000, mrp: 8000, inventory_items: { brand: 'Vivo', model: 'V25', imei: 'B2', status: 'in_stock', source: 'trade_in' } },
    ],
    proformas: [
      { id: 'pf1', bill_number: 'PI-2026-27-0001', date: '2026-10-01', status: 'converted', final_total: 20000, party_id: 'pA', party_name: 'Aditya Singh' },
      { id: 'pf2', bill_number: 'PI-2026-27-0002', date: '2026-11-25', status: 'active', final_total: 35000, party_id: 'pB', party_name: 'Priya Verma' },
    ],
    timeline: [
      { id: 'i5', created_at: '2026-09-01T00:00:00Z', origin_inventory_item_id: null },
      { id: 'i4', created_at: '2026-10-07T00:00:00Z', origin_inventory_item_id: null },
      { id: 'i7', created_at: '2026-11-15T00:00:00Z', origin_inventory_item_id: null },
      { id: 'i1', created_at: '2026-08-01T00:00:00Z', origin_inventory_item_id: null },
      { id: 'i9', created_at: '2026-04-01T00:00:00Z', origin_inventory_item_id: null },
      { id: 'i10', created_at: '2026-06-18T00:00:00Z', origin_inventory_item_id: null },
      { id: 'i11', created_at: '2027-01-15T00:00:00Z', origin_inventory_item_id: null },
      { id: 'i12', created_at: '2027-01-15T00:00:00Z', origin_inventory_item_id: null },
    ],
    bankAccounts: [
      { id: 'b1', name: 'HDFC Current Account', is_cash: false },
      { id: 'b2', name: 'Cash', is_cash: true },
    ],
    paymentModes: [{ id: 'm1', name: 'UPI', bank_account_id: 'b1' }],
    parties: [
      { id: 'pA', name: 'Aditya Singh', number: '+919899567890' },
      { id: 'pB', name: 'Priya Verma', number: '+919811122233' },
      { id: 'pS', name: 'Shree Balaji Mobiles', number: '+919910012345' },
    ],
  }
}
