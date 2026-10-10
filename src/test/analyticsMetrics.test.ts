/**
 * Analytics metrics — the authoritative business calculation layer.
 *
 * These tests pin the CANON (spec §§6–8): cancellation correctness (active
 * documents only), business dates (never created_at), virtual-acquisition
 * exclusion for purchases (hidden PUR-TRD bills AND recovery bills),
 * carry-forward origin-chain inventory age, stored-due balances, ageing
 * bucketing, and every aggregation the Analytics pages, the dashboard,
 * the notices and the Excel reports share.
 */
import { describe, it, expect } from 'vitest'
import {
  brandDistribution,
  brandSalesBreakdown,
  computePartyLedgers,
  dateInRange,
  daysBetween,
  inStockItems,
  inventoryAge,
  inventoryAgeing,
  inventoryValuation,
  isVirtualAcquisition,
  moneyMetrics,
  monthsInRange,
  monthlyTrend,
  num,
  outstandingCustomers,
  overviewKpis,
  payablesTotal,
  paymentMethodBreakdown,
  paymentStateBreakdown,
  purchasesMetrics,
  receivablesAgeing,
  receivablesTotal,
  salesMonthlyBreakdown,
  salesProductBreakdown,
  salesMetrics,
  stockComposition,
  timelineMap,
  topCustomers,
  topProducts,
  tradeInMetrics,
  acquisitionTimestamp,
} from '@/features/analytics/metrics'
import type {
  AnalyticsFold,
  AnalyticsInventoryRow,
  AnalyticsPaymentInRow,
  AnalyticsPaymentOutRow,
  AnalyticsPurchaseRow,
  AnalyticsSaleItemRow,
  AnalyticsSaleRow,
  AnalyticsTradeInRow,
} from '@/features/analytics/types'

const FY = { from: '2026-04-01', to: '2027-03-31' }

function sale(partial: Partial<AnalyticsSaleRow>): AnalyticsSaleRow {
  return {
    id: 's1',
    bill_number: 'SAL-2026-27-0001',
    date: '2026-10-07',
    party_id: 'p1',
    party_name: 'Aditya Singh',
    total: 10000,
    discount: 0,
    trade_in_credit: 0,
    final_total: 10000,
    paid: 10000,
    due: 0,
    status: 'active',
    created_at: '2026-10-07T10:00:00Z',
    ...partial,
  }
}

function purchase(partial: Partial<AnalyticsPurchaseRow>): AnalyticsPurchaseRow {
  return {
    id: 'pu1',
    bill_number: 'PUR-2026-27-0001',
    date: '2026-10-07',
    party_id: 'p2',
    party_name: 'Shree Balaji Mobiles',
    total: 50000,
    paid: 50000,
    due: 0,
    status: 'active',
    created_at: '2026-10-07T10:00:00Z',
    is_virtual: false,
    ...partial,
  }
}

function item(partial: Partial<AnalyticsInventoryRow>): AnalyticsInventoryRow {
  return {
    id: 'i1',
    brand: 'Samsung',
    model: 'Galaxy S22',
    imei: '111111111111111',
    ram_rom: '8/128',
    color: null,
    purchase_price: 20000,
    base_selling_price: 25000,
    status: 'in_stock',
    source: 'purchase',
    created_at: '2026-09-01T00:00:00Z',
    origin_inventory_item_id: null,
    opening_entry_type: 'direct',
    ...partial,
  }
}

// ── Primitives ───────────────────────────────────────────────────────────────

describe('num / date primitives', () => {
  it('coerces NUMERIC strings, numbers, null and undefined', () => {
    expect(num('12499.50')).toBe(12499.5)
    expect(num(12)).toBe(12)
    expect(num(null)).toBe(0)
    expect(num(undefined)).toBe(0)
    expect(num('')).toBe(0)
    expect(num('not-a-number')).toBe(0)
  })

  it('checks inclusive date range membership', () => {
    expect(dateInRange('2026-10-07', FY)).toBe(true)
    expect(dateInRange('2026-04-01', FY)).toBe(true)
    expect(dateInRange('2027-03-31', FY)).toBe(true)
    expect(dateInRange('2026-03-31', FY)).toBe(false)
    expect(dateInRange('2027-04-01', FY)).toBe(false)
    // PostgREST DATE strings sometimes carry a time part — normalized.
    expect(dateInRange('2026-10-07T00:00:00.000Z', FY)).toBe(true)
  })

  it('enumerates the months of a range (FY = 12 months; empty = none)', () => {
    expect(monthsInRange(FY)).toHaveLength(12)
    expect(monthsInRange(FY)[0]).toBe('2026-04')
    expect(monthsInRange(FY)[11]).toBe('2027-03')
    expect(monthsInRange({ from: '2027-04-01', to: '2026-04-01' })).toEqual([])
  })

  it('computes whole-day differences', () => {
    expect(daysBetween('2026-09-07', '2026-10-07')).toBe(30)
    expect(daysBetween('2026-10-07', '2026-10-07')).toBe(0)
    expect(daysBetween('2026-10-07', '2026-09-07')).toBe(-30)
  })
})

// ── Virtual acquisition rule ─────────────────────────────────────────────────

describe('isVirtualAcquisition', () => {
  it('detects hidden PUR-TRD bills by number, regardless of items', () => {
    expect(isVirtualAcquisition('PUR-TRD-2026-27-0002', [])).toBe(true)
  })

  it('detects recovery bills (plain numbering, all items trade-in sourced)', () => {
    expect(
      isVirtualAcquisition('PUR-2026-27-0006', [
        { inventory_items: { source: 'trade_in' } },
        { inventory_items: { source: 'trade_in' } },
      ]),
    ).toBe(true)
  })

  it('does NOT flag real supplier purchases', () => {
    expect(
      isVirtualAcquisition('PUR-2026-27-0001', [
        { inventory_items: { source: 'purchase' } },
        { inventory_items: { source: 'purchase' } },
      ]),
    ).toBe(false)
    expect(isVirtualAcquisition('PUR-2026-27-0001', [])).toBe(false)
  })
})

// ── Sales metrics ────────────────────────────────────────────────────────────

describe('salesMetrics', () => {
  const sales = [
    sale({ id: 's1', bill_number: 'A', final_total: 12000, paid: 12000, due: 0, date: '2026-10-01' }),
    sale({ id: 's2', bill_number: 'B', final_total: 8000, paid: 3000, due: 5000, date: '2026-10-05', trade_in_credit: 2000, discount: 500 }),
    sale({ id: 's3', bill_number: 'C', final_total: 999, paid: 999, due: 0, date: '2026-11-02' }),
    // Cancelled: kept in the DB with paid/due values — MUST be excluded.
    sale({ id: 's4', bill_number: 'D', final_total: 5000, paid: 1000, due: 4000, date: '2026-10-09', status: 'cancelled' }),
    // Outside the period.
    sale({ id: 's5', bill_number: 'E', final_total: 7000, paid: 7000, due: 0, date: '2026-03-31' }),
  ]
  const period = { from: '2026-10-01', to: '2026-10-31' }

  it('aggregates active sales in range over the business date', () => {
    const m = salesMetrics(sales, period)
    expect(m.invoiceCount).toBe(2)
    expect(m.totalSales).toBe(20000)
    expect(m.averageInvoiceValue).toBe(10000)
    expect(m.paidSales).toBe(15000)
    expect(m.outstandingSales).toBe(5000)
    expect(m.highestSale).toBe(12000)
    expect(m.tradeInCredit).toBe(2000)
    expect(m.discount).toBe(500)
  })

  it('cancellation correctness: cancelled sales never inflate totals, counts, or dues', () => {
    const m = salesMetrics(sales, period)
    expect(m.totalSales).not.toContain(5000)
    expect(m.outstandingSales).toBe(5000) // only s2's due, not s4's 4000
    expect(m.invoiceCount).toBe(2) // not 3
  })

  it('payment-state breakdown follows the app invoice-status semantics', () => {
    const states = paymentStateBreakdown(sales, period)
    const paid = states.find((s) => s.state === 'paid')!
    const partial = states.find((s) => s.state === 'partial')!
    const unpaid = states.find((s) => s.state === 'unpaid')!
    expect(paid.count).toBe(1)
    expect(paid.value).toBe(12000)
    expect(partial.count).toBe(1)
    expect(partial.value).toBe(8000)
    expect(unpaid.count).toBe(0)
  })

  it('monthly trend buckets by business month', () => {
    const trend = monthlyTrend(sales, [], [], [], { from: '2026-10-01', to: '2026-11-30' })
    expect(trend.map((t) => t.month)).toEqual(['2026-10', '2026-11'])
    expect(trend[0].sales).toBe(20000)
    expect(trend[1].sales).toBe(999)
  })

  it('sales monthly breakdown carries counts, paid and due per month', () => {
    const detail = salesMonthlyBreakdown(sales, { from: '2026-10-01', to: '2026-10-31' })
    expect(detail).toHaveLength(1)
    expect(detail[0]).toMatchObject({ month: '2026-10', invoiceCount: 2, sales: 20000, paid: 15000, due: 5000 })
  })
})

// ── Purchase metrics ─────────────────────────────────────────────────────────

describe('purchasesMetrics', () => {
  const purchases = [
    purchase({ id: 'r1', bill_number: 'PUR-2026-27-0001', total: 100000, paid: 100000, due: 0, date: '2026-10-01' }),
    purchase({ id: 'r2', bill_number: 'PUR-2026-27-0002', total: 91000, paid: 91000, due: 0, date: '2026-10-01' }),
    // Hidden trade-in acquisition bill: virtual, credit-settled.
    purchase({ id: 'v1', bill_number: 'PUR-TRD-2026-27-0003', total: 3000, paid: 3000, due: 0, date: '2026-10-05', is_virtual: true }),
    // Recovery bill: virtual via the item rule, plain PUR numbering.
    purchase({ id: 'v2', bill_number: 'PUR-2026-27-0006', total: 4000, paid: 4000, due: 0, date: '2026-10-06', is_virtual: true }),
    // Cancelled acquisition purchase (trade-in resold then sale cancelled).
    purchase({ id: 'c1', bill_number: 'PUR-TRD-2026-27-0004', total: 2500, paid: 2500, due: 0, date: '2026-10-07', status: 'cancelled', is_virtual: true }),
  ]
  const period = { from: '2026-10-01', to: '2026-10-31' }

  it('excludes virtual acquisition bills (hidden + recovery) from purchase totals', () => {
    const m = purchasesMetrics(purchases, period)
    expect(m.billCount).toBe(2)
    expect(m.totalPurchases).toBe(191000)
    expect(m.paidPurchases).toBe(191000)
    expect(m.outstandingPurchases).toBe(0)
    // The exclusion count covers EVERY internal acquisition record dated
    // in the period — including the cancelled one (it is excluded from the
    // ordinary totals anyway; the footer must account for it).
    expect(m.virtualBillCount).toBe(3)
  })

  it('counts internal acquisition records in the period regardless of status (footer semantics)', () => {
    // The FY 2027-28 TEST shape: one real bill, two PUR-TRD records (one
    // cancelled) and one recovery record, all dated in the period.
    const fy2728 = [
      purchase({ id: 'real', bill_number: 'PUR-2027-28-0004', total: 7500, paid: 4000, due: 3500, date: '2027-04-02' }),
      purchase({ id: 'trd-active', bill_number: 'PUR-TRD-2027-28-0003', total: 3000, paid: 3000, due: 0, date: '2027-04-01', is_virtual: true }),
      purchase({ id: 'trd-cancelled', bill_number: 'PUR-TRD-2027-28-0005', total: 2500, paid: 2500, due: 0, date: '2027-04-05', status: 'cancelled', is_virtual: true }),
      purchase({ id: 'recovery', bill_number: 'PUR-2027-28-0006', total: 2500, paid: 2500, due: 0, date: '2027-04-12', is_virtual: true }),
    ]
    const fy = { from: '2027-04-01', to: '2028-03-31' }
    const m = purchasesMetrics(fy2728, fy)
    expect(m.billCount).toBe(1)
    expect(m.totalPurchases).toBe(7500)
    expect(m.paidPurchases).toBe(4000)
    expect(m.outstandingPurchases).toBe(3500)
    expect(m.virtualBillCount).toBe(3)
  })

  it('scopes the exclusion count to the period — out-of-period internal records are not counted', () => {
    const m = purchasesMetrics(
      [...purchases, purchase({ id: 'v-out', bill_number: 'PUR-2026-27-0099', total: 1000, paid: 1000, due: 0, date: '2026-11-02', is_virtual: true })],
      period,
    )
    expect(m.virtualBillCount).toBe(3) // the November record is outside October
  })

  it('payables count active dues only', () => {
    const withDue = [
      ...purchases,
      purchase({ id: 'r3', bill_number: 'PUR-2026-27-0007', total: 20000, paid: 5000, due: 15000, date: '2026-10-08' }),
    ]
    expect(payablesTotal(withDue)).toBe(15000)
  })
})

// ── Money metrics ────────────────────────────────────────────────────────────

describe('moneyMetrics + paymentMethodBreakdown', () => {
  const paymentsIn: AnalyticsPaymentInRow[] = [
    { id: 'pi1', sale_id: 's1', party_id: 'p1', party_name: 'A', amount: 30000, date: '2026-10-07', created_at: '', bank_account_id: 'b1', payment_mode_id: 'm1', sale_bill_number: 'SAL-1', bank_name: 'HDFC', bank_is_cash: false, mode_name: 'UPI' },
    { id: 'pi2', sale_id: 's2', party_id: 'p2', party_name: 'B', amount: 22000, date: '2026-10-07', created_at: '', bank_account_id: 'b2', payment_mode_id: null, sale_bill_number: 'SAL-2', bank_name: 'Cash', bank_is_cash: true, mode_name: null },
    { id: 'pi3', sale_id: 's3', party_id: 'p3', party_name: 'C', amount: 5000, date: '2026-11-01', created_at: '', bank_account_id: 'b1', payment_mode_id: 'm2', sale_bill_number: 'SAL-3', bank_name: 'HDFC', bank_is_cash: false, mode_name: 'Card' },
  ]
  const paymentsOut: AnalyticsPaymentOutRow[] = [
    { id: 'po1', purchase_id: 'pu1', party_id: 'p9', party_name: 'S', amount: 100000, date: '2026-10-07', created_at: '', bank_account_id: 'b1', payment_mode_id: 'm1', purchase_bill_number: 'PUR-1', bank_name: 'HDFC', bank_is_cash: false, mode_name: 'UPI' },
  ]

  it('aggregates flows over business dates and computes net movement', () => {
    const m = moneyMetrics(paymentsIn, paymentsOut, { from: '2026-10-01', to: '2026-10-31' })
    expect(m.moneyIn).toBe(52000)
    expect(m.moneyOut).toBe(100000)
    expect(m.netMovement).toBe(-48000)
    expect(m.paymentsInCount).toBe(2)
    expect(m.paymentsOutCount).toBe(1)
  })

  it('breaks payments down by the actual supported modes (cash fallback)', () => {
    const rows = paymentMethodBreakdown(paymentsIn, paymentsOut, { from: '2026-10-01', to: '2026-10-31' })
    const upi = rows.find((r) => r.label === 'UPI')!
    const cash = rows.find((r) => r.label === 'Cash')!
    expect(upi.moneyIn).toBe(30000)
    expect(upi.moneyOut).toBe(100000)
    expect(cash.moneyIn).toBe(22000)
    expect(rows.some((r) => r.label === 'Card')).toBe(false) // outside the range
  })
})

// ── Receivables ──────────────────────────────────────────────────────────────

describe('receivables', () => {
  const today = '2026-12-06'
  const sales = [
    sale({ id: 's1', party_id: 'pa', party_name: 'Aditya', final_total: 10000, paid: 0, due: 10000, date: '2026-12-06' }),
    sale({ id: 's2', party_id: 'pb', party_name: 'Priya', final_total: 8000, paid: 3000, due: 5000, date: '2026-11-06' }),
    sale({ id: 's3', party_id: 'pc', party_name: 'Chandra', final_total: 6000, paid: 0, due: 6000, date: '2026-10-01' }),
    sale({ id: 's4', party_id: 'pd', party_name: 'Deepak', final_total: 4000, paid: 0, due: 4000, date: '2026-08-01' }),
    sale({ id: 's5', party_id: 'pe', party_name: 'Esha', final_total: 2000, paid: 2000, due: 0, date: '2026-07-01' }),
    sale({ id: 's6', party_id: 'pf', party_name: 'Farhan', final_total: 5000, paid: 1000, due: 4000, date: '2026-05-01', status: 'cancelled' }),
  ]

  it('total counts active documents only', () => {
    expect(receivablesTotal(sales)).toBe(25000) // s1..s4; cancelled s6 never counts
  })

  it('ages outstanding invoices by sale business date into four buckets', () => {
    const buckets = receivablesAgeing(sales, today)
    expect(buckets.map((b) => b.label)).toEqual(['0–30 days', '31–60 days', '61–90 days', '90+ days'])
    expect(buckets[0].count).toBe(2) // s1 (0 d) + s2 (exactly 30 d)
    expect(buckets[0].amount).toBe(15000)
    expect(buckets[1].count).toBe(0)
    expect(buckets[2].count).toBe(1) // s3 (66 d)
    expect(buckets[3].count).toBe(1) // s4 (127 d)
    expect(buckets[3].amount).toBe(4000)
    // s5 (settled) and s6 (cancelled) never appear.
    expect(buckets.reduce((a, b) => a + b.count, 0)).toBe(4)
  })

  it('ranks outstanding customers with oldest invoice context', () => {
    const customers = outstandingCustomers(sales)
    expect(customers).toHaveLength(4)
    expect(customers[0]).toMatchObject({ partyId: 'pa', due: 10000 })
    expect(customers.find((c) => c.partyId === 'pe')).toBeUndefined() // settled
    expect(customers.find((c) => c.partyId === 'pf')).toBeUndefined() // cancelled
  })
})

// ── Inventory ────────────────────────────────────────────────────────────────

describe('inventory valuation and ageing', () => {
  const today = '2026-12-06'
  // Origin chain: an item acquired 2026-06-01 in FY 26-27, carried forward
  // into FY 27-28 on 2026-11-20 (created_at RESET by the copy — the chain
  // must preserve the true acquisition date).
  const original = item({ id: 'orig', created_at: '2026-06-01T00:00:00Z', origin_inventory_item_id: null, status: 'in_stock' })
  const carried = item({
    id: 'carried',
    created_at: '2026-11-20T00:00:00Z',
    origin_inventory_item_id: 'orig',
    opening_entry_type: 'carried_forward',
    brand: 'Apple',
    purchase_price: 28500,
    base_selling_price: 34999,
  })
  const fresh = item({ id: 'fresh', created_at: '2026-12-01T00:00:00Z', brand: 'Samsung', purchase_price: 26000, base_selling_price: 30999 })
  const tradeInOld = item({ id: 'ti-old', created_at: '2026-09-01T00:00:00Z', source: 'trade_in', purchase_price: 4000, base_selling_price: 4000, brand: 'Vivo' })
  const sold = item({ id: 'sold', status: 'sold', created_at: '2026-05-01T00:00:00Z' })
  const inventory = [original, carried, fresh, tradeInOld, sold]
  const timeline = timelineMap([
    { id: 'orig', created_at: '2026-06-01T00:00:00Z', origin_inventory_item_id: null },
    { id: 'carried', created_at: '2026-11-20T00:00:00Z', origin_inventory_item_id: 'orig' },
    { id: 'fresh', created_at: '2026-12-01T00:00:00Z', origin_inventory_item_id: null },
    { id: 'ti-old', created_at: '2026-09-01T00:00:00Z', origin_inventory_item_id: null },
    { id: 'sold', created_at: '2026-05-01T00:00:00Z', origin_inventory_item_id: null },
  ])

  it('valuates current stock only (in_stock, at purchase price)', () => {
    const v = inventoryValuation(inventory)
    expect(v.units).toBe(4)
    expect(v.costValue).toBe(20000 + 28500 + 26000 + 4000)
    expect(v.sellingValue).toBe(25000 + 34999 + 30999 + 4000)
    expect(v.potentialMargin).toBe(v.sellingValue - v.costValue)
  })

  it('preserves acquisition age across the carry-forward origin chain', () => {
    expect(acquisitionTimestamp(carried, timeline)).toBe('2026-06-01T00:00:00Z')
    expect(inventoryAge(carried, timeline, today)).toBe(188) // 2026-06-01 → 2026-12-06
    expect(inventoryAge(fresh, timeline, today)).toBe(5)
  })

  it('ages buckets; flags 90+ regular and 60+ trade-in stock', () => {
    const ageing = inventoryAgeing(inventory, timeline, today)
    // carried: 188d (90+ bucket, regular); ti-old: 96d (90+ bucket AND trade-in 60+); fresh: 5d; orig: 188d (90+)
    expect(ageing.buckets[3].count).toBe(3) // orig + carried + ti-old
    expect(ageing.aged90Plus.count).toBe(3)
    expect(ageing.tradeInAged60Plus.count).toBe(1) // ti-old only
    expect(ageing.averageAgeDays).toBe(Math.round((188 + 188 + 5 + 96) / 4))
    expect(ageing.oldestAgeDays).toBe(188)
  })

  it('composes stock by source and distributes brands', () => {
    const composition = stockComposition(inventory)
    expect(composition.regularUnits).toBe(3)
    expect(composition.tradeInUnits).toBe(1)
    expect(composition.tradeInValue).toBe(4000)
    const brands = brandDistribution(inventory)
    expect(brands[0].brand).toBe('Samsung') // 2 units
    expect(brands.find((b) => b.brand === 'Apple')!.count).toBe(1)
  })

  it('inStockItems filters the current stock position', () => {
    expect(inStockItems(inventory)).toHaveLength(4)
  })
})

// ── Trade-ins ────────────────────────────────────────────────────────────────

describe('tradeInMetrics', () => {
  const sales = [
    sale({ id: 's1', date: '2026-10-05' }),
    sale({ id: 's2', date: '2026-10-20' }),
    sale({ id: 's3', date: '2026-11-01' }),
    sale({ id: 's4', date: '2026-10-25', status: 'cancelled' }),
  ]
  const tradeIns: AnalyticsTradeInRow[] = [
    { id: 't1', sale_id: 's1', inventory_item_id: 'i1', credit_value: 3000, mrp: 8000, inventory_items: { brand: 'Vivo', model: 'V25', imei: 'X1', status: 'sold', source: 'trade_in' } },
    { id: 't2', sale_id: 's2', inventory_item_id: 'i2', credit_value: 4000, mrp: null, inventory_items: { brand: 'Apple', model: 'iPhone 13', imei: 'X2', status: 'in_stock', source: 'trade_in' } },
    // Belongs to a cancelled sale — excluded.
    { id: 't3', sale_id: 's4', inventory_item_id: 'i3', credit_value: 5000, mrp: null, inventory_items: { brand: 'Oppo', model: 'F21', imei: 'X3', status: 'in_stock', source: 'trade_in' } },
  ]

  it('measures trade-ins by the originating sale business date', () => {
    const m = tradeInMetrics(tradeIns, sales, { from: '2026-10-01', to: '2026-10-31' })
    expect(m.received).toBe(2)
    expect(m.value).toBe(7000)
    expect(m.soldSinceReceipt).toBe(1)
    expect(m.stillInStock).toBe(1)
  })
})

// ── Rankings ─────────────────────────────────────────────────────────────────

describe('product / customer rankings', () => {
  const sales = [
    sale({ id: 's1', party_id: 'p1', party_name: 'Aditya', final_total: 30000, date: '2026-10-01' }),
    sale({ id: 's2', party_id: 'p1', party_name: 'Aditya', final_total: 20000, paid: 5000, due: 15000, date: '2026-10-02' }),
    sale({ id: 's3', party_id: 'p2', party_name: 'Priya', final_total: 10000, date: '2026-10-03' }),
    sale({ id: 's4', party_id: 'p3', party_name: 'Rahul', final_total: 1, date: '2026-10-04', status: 'cancelled' }),
  ]
  const saleItems: AnalyticsSaleItemRow[] = [
    { sale_id: 's1', sold_price: 30000, inventory_items: { id: 'i1', brand: 'Samsung', model: 'S22', imei: 'A', ram_rom: null, color: null, base_selling_price: 30000, purchase_price: 25000, status: 'sold', source: 'purchase' } },
    { sale_id: 's1', sold_price: 0, inventory_items: { id: 'i2', brand: 'Samsung', model: 'S22', imei: 'B', ram_rom: null, color: null, base_selling_price: 0, purchase_price: 0, status: 'sold', source: 'purchase' } },
    { sale_id: 's2', sold_price: 20000, inventory_items: { id: 'i3', brand: 'Apple', model: 'iPhone 13', imei: 'C', ram_rom: null, color: null, base_selling_price: 20000, purchase_price: 18000, status: 'sold', source: 'purchase' } },
    // Item of the cancelled sale — excluded.
    { sale_id: 's4', sold_price: 1, inventory_items: { id: 'i4', brand: 'Junk', model: 'X', imei: 'D', ram_rom: null, color: null, base_selling_price: 1, purchase_price: 1, status: 'in_stock', source: 'purchase' } },
  ]
  const range = { from: '2026-10-01', to: '2026-10-31' }

  it('ranks products from active sales only (brand+model composite)', () => {
    const products = salesProductBreakdown(saleItems, sales, range)
    expect(products).toHaveLength(2)
    expect(products[0]).toMatchObject({ brand: 'Samsung', model: 'S22', units: 2, revenue: 30000 })
    expect(topProducts(saleItems, sales, range, 1)).toHaveLength(1)
  })

  it('ranks customers by revenue and carries dues', () => {
    const customers = topCustomers(sales, range)
    expect(customers[0]).toMatchObject({ name: 'Aditya', invoiceCount: 2, revenue: 50000, due: 15000 })
    expect(customers.find((c) => c.name === 'Rahul')).toBeUndefined()
  })

  it('breaks brands down from the product breakdown', () => {
    const brands = brandSalesBreakdown(saleItems, sales, range)
    expect(brands.find((b) => b.brand === 'Samsung')).toMatchObject({ units: 2, revenue: 30000 })
  })
})

// ── Party ledger (shared with the Parties page) ──────────────────────────────

describe('computePartyLedgers', () => {
  it('folds per-party totals exactly like the Parties page always has', () => {
    const sales = [
      sale({ party_id: 'p1', final_total: 10000, due: 2000 }),
      sale({ party_id: 'p1', final_total: 5000, due: 0 }),
      sale({ party_id: 'p2', final_total: 700, due: 700 }),
    ]
    const purchases = [purchase({ party_id: 'p2', total: 40000, due: 10000 })]
    const ledgers = computePartyLedgers(['p1', 'p2'], sales, purchases)
    expect(ledgers.get('p1')).toMatchObject({ salesTotal: 15000, salesDue: 2000, purchasesTotal: 0, purchasesDue: 0 })
    expect(ledgers.get('p2')).toMatchObject({ salesTotal: 700, salesDue: 700, purchasesTotal: 40000, purchasesDue: 10000 })
  })
})

// ── Overview assembly ────────────────────────────────────────────────────────

describe('overviewKpis', () => {
  it('combines period flows with current positions from the same fold', () => {
    const fold = {
      fyId: 'fy1',
      sales: [
        sale({ final_total: 30000, paid: 20000, due: 10000, trade_in_credit: 3000, date: '2026-10-01' }),
        sale({ final_total: 10000, paid: 10000, due: 0, date: '2026-10-02' }),
      ],
      purchases: [purchase({ total: 91000, paid: 91000, due: 0, date: '2026-10-01' }), purchase({ bill_number: 'PUR-TRD-2026-27-0003', total: 3000, paid: 3000, is_virtual: true })],
      saleItems: [],
      purchaseItems: [],
      paymentsIn: [{ id: 'pi', sale_id: 's1', party_id: 'p1', party_name: 'A', amount: 20000, date: '2026-10-01', created_at: '', bank_account_id: 'b', payment_mode_id: null, sale_bill_number: null, bank_name: 'Cash', bank_is_cash: true, mode_name: null }],
      paymentsOut: [{ id: 'po', purchase_id: 'pu1', party_id: 'p2', party_name: 'B', amount: 91000, date: '2026-10-01', created_at: '', bank_account_id: 'b', payment_mode_id: null, purchase_bill_number: null, bank_name: 'Cash', bank_is_cash: true, mode_name: null }],
      inventory: [item({ purchase_price: 20000, base_selling_price: 25000 })],
      tradeIns: [],
      proformas: [],
      timeline: [],
      bankAccounts: [],
      paymentModes: [],
      parties: [],
    } as unknown as AnalyticsFold

    const kpis = overviewKpis(fold, { from: '2026-10-01', to: '2026-10-31' })
    expect(kpis.sales).toBe(40000)
    expect(kpis.purchases).toBe(91000) // virtual bill excluded
    expect(kpis.paymentsIn).toBe(20000)
    expect(kpis.paymentsOut).toBe(91000)
    expect(kpis.receivables).toBe(10000)
    expect(kpis.payables).toBe(0)
    expect(kpis.inventoryValue).toBe(20000)
    expect(kpis.tradeInValue).toBe(3000)
    expect(kpis.invoiceCount).toBe(2)
    expect(kpis.averageInvoiceValue).toBe(20000)
  })
})
