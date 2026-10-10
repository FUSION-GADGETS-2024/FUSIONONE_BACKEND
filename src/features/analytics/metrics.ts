/**
 * The authoritative business calculation layer — ONE implementation of every
 * business metric, reused by the Analytics pages, the dashboard, the notice
 * detectors and the Excel reports (spec §6: shared business truth).
 *
 * Every function here is PURE: it folds normalized row arrays (shapes from
 * types.ts, which the dashboard's rows and existing page queries also
 * satisfy structurally) and never touches Supabase, dates-as-now (callers
 * pass `today`), or presentation.
 *
 * Business rules encoded here (the canon):
 *   - Sales/purchases metrics count ONLY status='active' documents.
 *     Cancelled sales keep their paid/due values in the database, so every
 *     fold MUST filter by status (cancellation correctness, spec §8).
 *   - All flow metrics use the BUSINESS DATE (the `date` column), never
 *     created_at (spec §7).
 *   - Purchase totals EXCLUDE virtual acquisition bills (hidden PUR-TRD
 *     trade-in bills and recovery bills): no money moves for them; the
 *     trade-in credit is already reflected in the originating sale.
 *   - Inventory valuation = Σ purchase_price (cost) / Σ base_selling_price
 *     over in-stock items — the same semantics the dashboard has always
 *     used (spec §14: reuse the authoritative valuation).
 *   - Inventory age is measured from the ORIGINAL acquisition timestamp,
 *     walking the carry-forward origin chain (financial-year rollover
 *     copies rows and would otherwise reset the age).
 *   - Receivables/payables = Σ due over active documents (the stored
 *     paid/due columns are the balance source of truth, maintained
 *     transactionally by the RPCs).
 */
import type {
  AnalyticsAccountTransactionRow,
  AnalyticsFold,
  AnalyticsInventoryRow,
  AnalyticsPaymentInRow,
  AnalyticsPaymentOutRow,
  AnalyticsPurchaseRow,
  AnalyticsSaleItemRow,
  AnalyticsSaleRow,
  AnalyticsTradeInRow,
  DateRange,
  InventoryTimelineRow,
} from './types'
import { dateOnly } from './period'

// ── Coercion + range primitives ─────────────────────────────────────────────

/** NUMERIC(12,2)-safe number coercion (null/undefined/'' → 0). */
export function num(value: number | string | null | undefined): number {
  if (value === null || value === undefined || value === '') return 0
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

/** TRUE when a business date falls inside the inclusive range. */
export function dateInRange(date: string, range: DateRange): boolean {
  const d = dateOnly(date)
  return d >= range.from && d <= range.to
}

/**
 * The months (YYYY-MM) intersecting a range, in order — the trend axis for
 * every monthly breakdown. An empty range yields no months.
 */
export function monthsInRange(range: DateRange): string[] {
  if (range.from > range.to) return []
  const out: string[] = []
  const fromYM = Number(range.from.slice(0, 4)) * 12 + Number(range.from.slice(5, 7)) - 1
  const toYM = Number(range.to.slice(0, 4)) * 12 + Number(range.to.slice(5, 7)) - 1
  for (let ym = fromYM; ym <= toYM; ym++) {
    const y = Math.floor(ym / 12)
    const m = (ym % 12) + 1
    out.push(`${y}-${String(m).padStart(2, '0')}`)
  }
  return out
}

/** Whole days between two YYYY-MM-DD dates (b − a). */
export function daysBetween(a: string, b: string): number {
  const da = Date.UTC(Number(a.slice(0, 4)), Number(a.slice(5, 7)) - 1, Number(a.slice(8, 10)))
  const db = Date.UTC(Number(b.slice(0, 4)), Number(b.slice(5, 7)) - 1, Number(b.slice(8, 10)))
  return Math.round((db - da) / 86_400_000)
}

// ── Virtual acquisition rule (shared canon for purchases) ───────────────────

/**
 * TRUE when a purchase is a virtual trade-in acquisition bill:
 * every line item references trade-in-sourced inventory, OR the bill uses
 * the hidden `PUR-TRD-` numbering. Covers both create_sale's hidden bills
 * and create_trade_in_purchase_bill recovery bills (plain PUR- numbering,
 * paid=total, due=0, no payments rows).
 */
export function isVirtualAcquisition(
  billNumber: string,
  items: ReadonlyArray<{ inventory_items: { source: string | null } | null }>,
): boolean {
  if (billNumber.startsWith('PUR-TRD-')) return true
  return items.length > 0 && items.every((i) => (i.inventory_items?.source ?? '') === 'trade_in')
}

// ── Sales metrics ────────────────────────────────────────────────────────────

export interface SalesMetrics {
  /** Σ final_total of active sales in range. */
  totalSales: number
  invoiceCount: number
  averageInvoiceValue: number
  /** Σ paid of those sales (cash attributed at invoice date). */
  paidSales: number
  /** Σ due of those sales. */
  outstandingSales: number
  /** Highest single final_total in range (0 when none). */
  highestSale: number
  /** Σ trade_in_credit of those sales. */
  tradeInCredit: number
  /** Σ header-level discount of those sales. */
  discount: number
  /** Active sales excluded from the window because they are cancelled. */
  cancelledCount: number
}

/** Active sales whose business date falls in the range (THE sales scope). */
export function activeSalesInRange(
  sales: ReadonlyArray<AnalyticsSaleRow>,
  range: DateRange,
): AnalyticsSaleRow[] {
  return sales.filter((s) => s.status === 'active' && dateInRange(s.date, range))
}

export function salesMetrics(
  sales: ReadonlyArray<AnalyticsSaleRow>,
  range: DateRange,
): SalesMetrics {
  const rows = activeSalesInRange(sales, range)
  let totalSales = 0
  let paidSales = 0
  let outstandingSales = 0
  let highestSale = 0
  let tradeInCredit = 0
  let discount = 0
  for (const s of rows) {
    const total = num(s.final_total)
    totalSales += total
    paidSales += num(s.paid)
    outstandingSales += num(s.due)
    tradeInCredit += num(s.trade_in_credit)
    discount += num(s.discount)
    if (total > highestSale) highestSale = total
  }
  return {
    totalSales,
    invoiceCount: rows.length,
    averageInvoiceValue: rows.length > 0 ? totalSales / rows.length : 0,
    paidSales,
    outstandingSales,
    highestSale,
    tradeInCredit,
    discount,
    cancelledCount: sales.filter((s) => s.status === 'cancelled').length,
  }
}

/** One month point of the sales/purchases trend. */
export interface MonthPoint {
  month: string // YYYY-MM
  sales: number
  purchases: number
  paymentsIn: number
  paymentsOut: number
}

/**
 * Monthly business trend over the range — one point per intersecting month.
 * Sales use final_total; purchases use total of REAL purchases only
 * (virtual acquisition bills excluded).
 */
export function monthlyTrend(
  sales: ReadonlyArray<AnalyticsSaleRow>,
  purchases: ReadonlyArray<AnalyticsPurchaseRow>,
  paymentsIn: ReadonlyArray<AnalyticsPaymentInRow>,
  paymentsOut: ReadonlyArray<AnalyticsPaymentOutRow>,
  range: DateRange,
): MonthPoint[] {
  const points = monthsInRange(range).map((month) => ({ month, sales: 0, purchases: 0, paymentsIn: 0, paymentsOut: 0 }))
  const index = new Map(points.map((p) => [p.month, p]))
  for (const s of sales) {
    if (s.status !== 'active') continue
    const p = index.get(dateOnly(s.date).slice(0, 7))
    if (p) p.sales += num(s.final_total)
  }
  for (const pu of purchases) {
    if (pu.status !== 'active' || pu.is_virtual) continue
    const p = index.get(dateOnly(pu.date).slice(0, 7))
    if (p) p.purchases += num(pu.total)
  }
  for (const pi of paymentsIn) {
    const p = index.get(dateOnly(pi.date).slice(0, 7))
    if (p) p.paymentsIn += num(pi.amount)
  }
  for (const po of paymentsOut) {
    const p = index.get(dateOnly(po.date).slice(0, 7))
    if (p) p.paymentsOut += num(po.amount)
  }
  return points
}

// ── Payment-state breakdown ──────────────────────────────────────────────────

export type PaymentState = 'paid' | 'partial' | 'unpaid'

export interface PaymentStateBucket {
  state: PaymentState
  count: number
  value: number
}

/**
 * Paid / Partial / Unpaid split of active sales in range, by the app's
 * established invoice-status semantics (paid: due ≤ 0; partial: paid > 0
 * and due > 0; unpaid: paid ≤ 0 and due > 0 — mirrors
 * deriveInvoiceStatus in components/invoice/invoiceStatus).
 */
export function paymentStateBreakdown(
  sales: ReadonlyArray<AnalyticsSaleRow>,
  range: DateRange,
): PaymentStateBucket[] {
  const rows = activeSalesInRange(sales, range)
  const acc: Record<PaymentState, PaymentStateBucket> = {
    paid: { state: 'paid', count: 0, value: 0 },
    partial: { state: 'partial', count: 0, value: 0 },
    unpaid: { state: 'unpaid', count: 0, value: 0 },
  }
  for (const s of rows) {
    const due = num(s.due)
    const paid = num(s.paid)
    const state: PaymentState = due <= 0 ? 'paid' : paid > 0 ? 'partial' : 'unpaid'
    acc[state].count += 1
    acc[state].value += num(s.final_total)
  }
  return [acc.paid, acc.partial, acc.unpaid]
}

// ── Product / customer rankings ──────────────────────────────────────────────

export interface RankedProduct {
  key: string
  brand: string
  model: string
  units: number
  revenue: number
}

/**
 * Full product sales breakdown for a range — brand+model composites with
 * units and revenue (Σ sold_price over items of active sales in range).
 * The authoritative product ranking; `topProducts` is its top slice.
 */
export function salesProductBreakdown(
  saleItems: ReadonlyArray<AnalyticsSaleItemRow>,
  sales: ReadonlyArray<AnalyticsSaleRow>,
  range: DateRange,
): RankedProduct[] {
  const saleIndex = new Map(sales.filter((s) => s.status === 'active' && dateInRange(s.date, range)).map((s) => [s.id, s]))
  const acc = new Map<string, RankedProduct>()
  for (const item of saleItems) {
    const sale = saleIndex.get(item.sale_id)
    if (!sale) continue
    const inv = item.inventory_items
    const brand = inv?.brand ?? 'Unknown'
    const model = inv?.model ?? 'Unknown'
    const key = `${brand}|${model}`
    const row = acc.get(key) ?? { key, brand, model, units: 0, revenue: 0 }
    row.units += 1
    row.revenue += num(item.sold_price)
    acc.set(key, row)
  }
  return [...acc.values()].sort((a, b) => b.revenue - a.revenue || b.units - a.units || a.key.localeCompare(b.key))
}

/** Top products by revenue from sale items of ACTIVE sales in range. */
export function topProducts(
  saleItems: ReadonlyArray<AnalyticsSaleItemRow>,
  sales: ReadonlyArray<AnalyticsSaleRow>,
  range: DateRange,
  limit = 5,
): RankedProduct[] {
  return salesProductBreakdown(saleItems, sales, range).slice(0, limit)
}

/** Brand-level sales breakdown (units/revenue grouped by brand alone). */
export function brandSalesBreakdown(
  saleItems: ReadonlyArray<AnalyticsSaleItemRow>,
  sales: ReadonlyArray<AnalyticsSaleRow>,
  range: DateRange,
): Array<{ brand: string; units: number; revenue: number }> {
  const products = salesProductBreakdown(saleItems, sales, range)
  const acc = new Map<string, { brand: string; units: number; revenue: number }>()
  for (const p of products) {
    const row = acc.get(p.brand) ?? { brand: p.brand, units: 0, revenue: 0 }
    row.units += p.units
    row.revenue += p.revenue
    acc.set(p.brand, row)
  }
  return [...acc.values()].sort((a, b) => b.revenue - a.revenue || a.brand.localeCompare(b.brand))
}

export interface SalesMonthDetail {
  month: string
  invoiceCount: number
  sales: number
  paid: number
  due: number
}

/** Per-month sales detail (counts + totals + paid/due attribution). */
export function salesMonthlyBreakdown(
  sales: ReadonlyArray<AnalyticsSaleRow>,
  range: DateRange,
): SalesMonthDetail[] {
  const months = monthsInRange(range)
  const points = new Map<string, SalesMonthDetail>(
    months.map((month) => [month, { month, invoiceCount: 0, sales: 0, paid: 0, due: 0 }]),
  )
  for (const s of activeSalesInRange(sales, range)) {
    const p = points.get(dateOnly(s.date).slice(0, 7))
    if (!p) continue
    p.invoiceCount += 1
    p.sales += num(s.final_total)
    p.paid += num(s.paid)
    p.due += num(s.due)
  }
  return months.map((m) => points.get(m)!)
}

export interface RankedCustomer {
  partyId: string
  name: string
  invoiceCount: number
  revenue: number
  due: number
}

/** Top customers by revenue from active sales in range. */
export function topCustomers(
  sales: ReadonlyArray<AnalyticsSaleRow>,
  range: DateRange,
  limit = 5,
): RankedCustomer[] {
  const acc = new Map<string, RankedCustomer>()
  for (const s of activeSalesInRange(sales, range)) {
    const row = acc.get(s.party_id) ?? {
      partyId: s.party_id,
      name: s.party_name ?? 'Unknown',
      invoiceCount: 0,
      revenue: 0,
      due: 0,
    }
    row.invoiceCount += 1
    row.revenue += num(s.final_total)
    row.due += num(s.due)
    acc.set(s.party_id, row)
  }
  return [...acc.values()].sort((a, b) => b.revenue - a.revenue || b.invoiceCount - a.invoiceCount || a.name.localeCompare(b.name)).slice(0, limit)
}

// ── Purchase metrics ─────────────────────────────────────────────────────────

export interface PurchasesMetrics {
  /** Σ total of active REAL purchases in range (virtual bills excluded). */
  totalPurchases: number
  billCount: number
  averageBillValue: number
  paidPurchases: number
  outstandingPurchases: number
  /**
   * Internal trade-in acquisition and recovery records DATED in the range
   * (the exclusion class the Purchase Register footer quantifies). Status
   * is deliberately NOT filtered: a cancelled PUR-TRD bill is still an
   * internal acquisition record in the period — it is excluded from the
   * ordinary totals anyway, and the footer must account for every record
   * the management list shows but the register does not.
   */
  virtualBillCount: number
}

/** Active, REAL purchases whose business date falls in the range. */
export function realPurchasesInRange(
  purchases: ReadonlyArray<AnalyticsPurchaseRow>,
  range: DateRange,
): AnalyticsPurchaseRow[] {
  return purchases.filter((p) => p.status === 'active' && !p.is_virtual && dateInRange(p.date, range))
}

export function purchasesMetrics(
  purchases: ReadonlyArray<AnalyticsPurchaseRow>,
  range: DateRange,
): PurchasesMetrics {
  const rows = realPurchasesInRange(purchases, range)
  let totalPurchases = 0
  let paidPurchases = 0
  let outstandingPurchases = 0
  for (const p of rows) {
    totalPurchases += num(p.total)
    paidPurchases += num(p.paid)
    outstandingPurchases += num(p.due)
  }
  return {
    totalPurchases,
    billCount: rows.length,
    averageBillValue: rows.length > 0 ? totalPurchases / rows.length : 0,
    paidPurchases,
    outstandingPurchases,
    virtualBillCount: purchases.filter((p) => p.is_virtual && dateInRange(p.date, range)).length,
  }
}

// ── Purchase trend (adaptive interval) ───────────────────────────────────────

export interface PurchaseTrendPoint {
  /** Bucket label, human-readable ("Apr 2026" monthly / "12 Oct 2026" daily). */
  label: string
  value: number
}

/**
 * The purchase-value trend over the range — the SAME qualifying-purchase
 * rules as the summary cards and the register (active, REAL bills only,
 * dated within the range, business date attributed).
 *
 * The time interval adapts to the period: monthly buckets for a full
 * financial year (or any period longer than two months), one bucket per
 * day for shorter periods.
 */
export function purchaseTrend(
  purchases: ReadonlyArray<AnalyticsPurchaseRow>,
  range: DateRange,
): PurchaseTrendPoint[] {
  const months = monthsInRange(range)
  const monthly = months.length > 2
  const acc = new Map<string, number>()
  for (const p of realPurchasesInRange(purchases, range)) {
    const key = monthly ? dateOnly(p.date).slice(0, 7) : dateOnly(p.date)
    acc.set(key, (acc.get(key) ?? 0) + num(p.total))
  }
  if (monthly) {
    return months.map((m) => ({ label: monthLabelOf(m), value: acc.get(m) ?? 0 }))
  }
  // Daily buckets across the (short) range, inclusive of both ends.
  const days: string[] = []
  if (range.from <= range.to) {
    let cursor = range.from
    let guard = 0
    while (cursor <= range.to && guard < 400) {
      days.push(cursor)
      cursor = nextDay(cursor)
      guard += 1
    }
  }
  return days.map((d) => ({ label: dayLabelOf(d), value: acc.get(d) ?? 0 }))
}

/** "Apr 2026" from a YYYY-MM key. */
function monthLabelOf(month: string): string {
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const [y, m] = month.split('-')
  const mi = Number(m) - 1
  if (!y || Number.isNaN(mi)) return month
  return `${MONTHS[mi]} ${y}`
}

/** "12 Oct 2026" from a YYYY-MM-DD date. */
function dayLabelOf(day: string): string {
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const [y, m, d] = day.split('-')
  const mi = Number(m) - 1
  if (!y || Number.isNaN(mi) || !d) return day
  return `${Number(d)} ${MONTHS[mi]} ${y}`
}

/** The next calendar day (YYYY-MM-DD) after the given day. */
function nextDay(day: string): string {
  const y = Number(day.slice(0, 4))
  const m = Number(day.slice(5, 7))
  const d = Number(day.slice(8, 10))
  const next = new Date(Date.UTC(y, m - 1, d + 1))
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')}`
}

// ── Money ledger semantics (the Money Register's shared business truth) ──────

/** The business-readable Transaction Type of one ledger movement. */
export type LedgerTransactionType =
  | 'Payment In'
  | 'Sale Payment'
  | 'Payment Out'
  | 'Purchase Payment'
  | 'Cancellation Reversal'
  | 'Funds Added'
  | 'Account Transfer'
  | 'Opening Balance'

/**
 * TRUE when a ledger movement is an INTERNAL account operation — an account
 * transfer leg or an opening-balance initialization. Internal movements
 * appear in the Money Register (clearly classified) but are NOT business-
 * wide receipts or payments and are excluded from its totals.
 */
export function isInternalLedgerMovement(
  referenceType: AnalyticsAccountTransactionRow['reference_type'],
): boolean {
  return referenceType === 'transfer' || referenceType === 'opening_balance'
}

/** The Transaction Type label of one ledger movement. */
export function ledgerTransactionType(
  t: Pick<AnalyticsAccountTransactionRow, 'type' | 'reference_type'>,
): LedgerTransactionType {
  if (t.reference_type === 'transfer') return 'Account Transfer'
  if (t.reference_type === 'opening_balance') return 'Opening Balance'
  if (t.reference_type === 'add_funds') return 'Funds Added'
  if (t.reference_type === 'sale_cancelled') return 'Cancellation Reversal'
  if (t.reference_type === 'sale') return 'Sale Payment'
  if (t.reference_type === 'purchase') return 'Purchase Payment'
  if (t.reference_type === 'payment_in') return 'Payment In'
  return 'Payment Out'
}

/**
 * The deterministic receipt identifier of a payment movement — the SAME
 * convention the app's receipt documents use (RCP-{IN|OUT}-{YYYYMMDD}-{id8}).
 */
export function receiptNumber(paymentId: string, direction: 'in' | 'out', date: string): string {
  const compactDate = dateOnly(date).replace(/-/g, '')
  return `RCP-${direction === 'in' ? 'IN' : 'OUT'}-${compactDate}-${paymentId.replace(/-/g, '').slice(0, 8).toUpperCase()}`
}

// ── Money (payments) metrics ─────────────────────────────────────────────────

export interface MoneyMetrics {
  moneyIn: number
  moneyOut: number
  netMovement: number
  paymentsInCount: number
  paymentsOutCount: number
}

export function moneyMetrics(
  paymentsIn: ReadonlyArray<AnalyticsPaymentInRow>,
  paymentsOut: ReadonlyArray<AnalyticsPaymentOutRow>,
  range: DateRange,
): MoneyMetrics {
  let moneyIn = 0
  let moneyOut = 0
  let paymentsInCount = 0
  let paymentsOutCount = 0
  for (const p of paymentsIn) {
    if (!dateInRange(p.date, range)) continue
    moneyIn += num(p.amount)
    paymentsInCount += 1
  }
  for (const p of paymentsOut) {
    if (!dateInRange(p.date, range)) continue
    moneyOut += num(p.amount)
    paymentsOutCount += 1
  }
  return { moneyIn, moneyOut, netMovement: moneyIn - moneyOut, paymentsInCount, paymentsOutCount }
}

// ── Receivables / payables (balances — point in time, not period flows) ─────

/** Σ due over ACTIVE sales (the row set passed in defines the scope). */
export function receivablesTotal(sales: ReadonlyArray<{ due: number | string; status: string }>): number {
  return sales.reduce((a, s) => (s.status === 'active' ? a + num(s.due) : a), 0)
}

/** Σ due over ACTIVE purchases (virtual bills carry due=0 by construction). */
export function payablesTotal(purchases: ReadonlyArray<{ due: number | string; status: string }>): number {
  return purchases.reduce((a, p) => (p.status === 'active' ? a + num(p.due) : a), 0)
}

export interface AgeingBucket {
  /** Bucket label, e.g. "0–30 days". */
  label: string
  count: number
  amount: number
}

export const AGEING_BUCKETS = ['0–30 days', '31–60 days', '61–90 days', '90+ days'] as const

/**
 * Receivables ageing of outstanding (active, due > 0) sales, bucketed by
 * days since the sale's BUSINESS date. `today` is passed in (purity).
 */
export function receivablesAgeing(
  sales: ReadonlyArray<AnalyticsSaleRow>,
  today: string,
): AgeingBucket[] {
  const buckets: AgeingBucket[] = AGEING_BUCKETS.map((label) => ({ label, count: 0, amount: 0 }))
  for (const s of sales) {
    if (s.status !== 'active') continue
    const due = num(s.due)
    if (due <= 0) continue
    const age = daysBetween(dateOnly(s.date), today)
    const idx = age <= 30 ? 0 : age <= 60 ? 1 : age <= 90 ? 2 : 3
    buckets[idx].count += 1
    buckets[idx].amount += due
  }
  return buckets
}

export interface OutstandingCustomer {
  partyId: string
  name: string
  due: number
  invoiceCount: number
  oldestDate: string | null
}

/** Customers ranked by outstanding receivable (active sales with due > 0). */
export function outstandingCustomers(
  sales: ReadonlyArray<AnalyticsSaleRow>,
  limit?: number,
): OutstandingCustomer[] {
  const acc = new Map<string, OutstandingCustomer>()
  for (const s of sales) {
    if (s.status !== 'active') continue
    const due = num(s.due)
    if (due <= 0) continue
    const row = acc.get(s.party_id) ?? {
      partyId: s.party_id,
      name: s.party_name ?? 'Unknown',
      due: 0,
      invoiceCount: 0,
      oldestDate: null as string | null,
    }
    row.due += due
    row.invoiceCount += 1
    if (!row.oldestDate || dateOnly(s.date) < row.oldestDate) row.oldestDate = dateOnly(s.date)
    acc.set(s.party_id, row)
  }
  const rows = [...acc.values()].sort((a, b) => b.due - a.due || a.name.localeCompare(b.name))
  return limit === undefined ? rows : rows.slice(0, limit)
}

// ── Inventory metrics ────────────────────────────────────────────────────────

/** In-stock items of the given rows (current stock position). */
export function inStockItems(
  inventory: ReadonlyArray<AnalyticsInventoryRow>,
): AnalyticsInventoryRow[] {
  return inventory.filter((i) => i.status === 'in_stock')
}

/** The timeline as the origin-chain lookup map (built once per dataset). */
export function timelineMap(
  timeline: ReadonlyArray<InventoryTimelineRow>,
): Map<string, InventoryTimelineRow> {
  return new Map(timeline.map((row) => [row.id, row]))
}

export interface InventoryValuation {
  units: number
  /** Σ purchase_price over in-stock items (cost) — the dashboard's rule. */
  costValue: number
  /** Σ base_selling_price over in-stock items. */
  sellingValue: number
  potentialMargin: number
}

export function inventoryValuation(
  inventory: ReadonlyArray<AnalyticsInventoryRow>,
): InventoryValuation {
  let costValue = 0
  let sellingValue = 0
  let units = 0
  for (const i of inStockItems(inventory)) {
    units += 1
    costValue += num(i.purchase_price)
    sellingValue += num(i.base_selling_price)
  }
  return { units, costValue, sellingValue, potentialMargin: sellingValue - costValue }
}

/**
 * The ORIGINAL acquisition timestamp of an inventory row, walking the
 * carry-forward origin chain. Financial-year rollover COPIES in-stock rows
 * into the next year (origin_inventory_item_id → the previous row), so a
 * carried item's own created_at resets; the chain preserves the true age.
 */
export function acquisitionTimestamp(
  item: Pick<AnalyticsInventoryRow, 'id' | 'created_at' | 'origin_inventory_item_id'>,
  timeline: ReadonlyMap<string, InventoryTimelineRow>,
): string {
  let current: Pick<InventoryTimelineRow, 'id' | 'created_at' | 'origin_inventory_item_id'> | undefined = item
  const seen = new Set<string>()
  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    if (!current.origin_inventory_item_id) return current.created_at
    const next: InventoryTimelineRow | undefined = timeline.get(current.origin_inventory_item_id)
    if (!next) return current.created_at
    current = next
  }
  return item.created_at
}

/** Age in whole days of an inventory row, from its original acquisition. */
export function inventoryAge(
  item: Pick<AnalyticsInventoryRow, 'id' | 'created_at' | 'origin_inventory_item_id'>,
  timeline: ReadonlyMap<string, InventoryTimelineRow>,
  today: string,
): number {
  const acquired = acquisitionTimestamp(item, timeline)
  return Math.max(0, daysBetween(dateOnly(acquired), today))
}

export interface InventoryAgeing {
  buckets: AgeingBucket[]
  averageAgeDays: number
  oldestAgeDays: number
  aged90Plus: { count: number; value: number }
  tradeInAged60Plus: { count: number; value: number }
}

/**
 * Inventory ageing of the CURRENT stock: buckets by days since acquisition,
 * average age, and the 90+/60+ problem counters (90+ days for regular
 * stock; trade-in-sourced stock ages as a problem sooner — 60+ days).
 */
export function inventoryAgeing(
  inventory: ReadonlyArray<AnalyticsInventoryRow>,
  timeline: ReadonlyMap<string, InventoryTimelineRow>,
  today: string,
): InventoryAgeing {
  const buckets: AgeingBucket[] = AGEING_BUCKETS.map((label) => ({ label, count: 0, amount: 0 }))
  let totalAge = 0
  let oldest = 0
  let aged90Count = 0
  let aged90Value = 0
  let tradeInAgedCount = 0
  let tradeInAgedValue = 0
  const rows = inStockItems(inventory)
  for (const i of rows) {
    const age = inventoryAge(i, timeline, today)
    const value = num(i.purchase_price)
    totalAge += age
    if (age > oldest) oldest = age
    const idx = age <= 30 ? 0 : age <= 60 ? 1 : age <= 90 ? 2 : 3
    buckets[idx].count += 1
    buckets[idx].amount += value
    if (age >= 90) {
      aged90Count += 1
      aged90Value += value
    }
    if (i.source === 'trade_in' && age >= 60) {
      tradeInAgedCount += 1
      tradeInAgedValue += value
    }
  }
  return {
    buckets,
    averageAgeDays: rows.length > 0 ? Math.round(totalAge / rows.length) : 0,
    oldestAgeDays: oldest,
    aged90Plus: { count: aged90Count, value: aged90Value },
    tradeInAged60Plus: { count: tradeInAgedCount, value: tradeInAgedValue },
  }
}

export interface BrandDistributionRow {
  brand: string
  count: number
  costValue: number
  sellingValue: number
}

/** In-stock brand distribution (units + values), largest first. */
export function brandDistribution(
  inventory: ReadonlyArray<AnalyticsInventoryRow>,
): BrandDistributionRow[] {
  const acc = new Map<string, BrandDistributionRow>()
  for (const i of inStockItems(inventory)) {
    const row = acc.get(i.brand) ?? { brand: i.brand, count: 0, costValue: 0, sellingValue: 0 }
    row.count += 1
    row.costValue += num(i.purchase_price)
    row.sellingValue += num(i.base_selling_price)
    acc.set(i.brand, row)
  }
  return [...acc.values()].sort((a, b) => b.count - a.count || a.brand.localeCompare(b.brand))
}

export interface StockComposition {
  regularUnits: number
  regularValue: number
  tradeInUnits: number
  tradeInValue: number
}

/** Regular vs trade-in split of current stock. */
export function stockComposition(
  inventory: ReadonlyArray<AnalyticsInventoryRow>,
): StockComposition {
  const out: StockComposition = { regularUnits: 0, regularValue: 0, tradeInUnits: 0, tradeInValue: 0 }
  for (const i of inStockItems(inventory)) {
    if (i.source === 'trade_in') {
      out.tradeInUnits += 1
      out.tradeInValue += num(i.purchase_price)
    } else {
      out.regularUnits += 1
      out.regularValue += num(i.purchase_price)
    }
  }
  return out
}

// ── Trade-in metrics ─────────────────────────────────────────────────────────

export interface TradeInMetrics {
  /** Devices received as trade-ins in the period (sales in range). */
  received: number
  /** Σ credit_value of those devices. */
  value: number
  /** Of the received devices, how many are SOLD now. */
  soldSinceReceipt: number
  /** Of the received devices, how many remain IN STOCK. */
  stillInStock: number
}

/**
 * Trade-in performance for the period. A trade-in's "receipt date" is its
 * originating SALE's business date (trade_ins has no own date column).
 */
export function tradeInMetrics(
  tradeIns: ReadonlyArray<AnalyticsTradeInRow>,
  sales: ReadonlyArray<AnalyticsSaleRow>,
  range: DateRange,
): TradeInMetrics {
  const saleIndex = new Map(sales.filter((s) => s.status === 'active').map((s) => [s.id, s]))
  let received = 0
  let value = 0
  let soldSinceReceipt = 0
  let stillInStock = 0
  for (const ti of tradeIns) {
    const sale = saleIndex.get(ti.sale_id)
    if (!sale || !dateInRange(sale.date, range)) continue
    received += 1
    value += num(ti.credit_value)
    if (ti.inventory_items?.status === 'sold') soldSinceReceipt += 1
    else if (ti.inventory_items?.status === 'in_stock') stillInStock += 1
  }
  return { received, value, soldSinceReceipt, stillInStock }
}

// ── Party ledger (shared with the Parties page fold) ─────────────────────────

export interface PartyLedgerTotals {
  partyId: string
  salesTotal: number
  salesDue: number
  purchasesTotal: number
  purchasesDue: number
}

/**
 * Per-party ledger fold — the exact grouping semantics the Parties page has
 * always used (active-scoped rows are passed in by its query; totals over
 * final_total/total and due). One implementation for both consumers.
 */
export function computePartyLedgers(
  partyIds: ReadonlyArray<string>,
  sales: ReadonlyArray<{ party_id: string; final_total: number | string; due: number | string }>,
  purchases: ReadonlyArray<{ party_id: string; total: number | string; due: number | string }>,
): Map<string, PartyLedgerTotals> {
  const map = new Map<string, PartyLedgerTotals>()
  for (const id of partyIds) {
    map.set(id, { partyId: id, salesTotal: 0, salesDue: 0, purchasesTotal: 0, purchasesDue: 0 })
  }
  for (const s of sales) {
    const l = map.get(s.party_id)
    if (!l) continue
    l.salesTotal += num(s.final_total)
    l.salesDue += num(s.due)
  }
  for (const p of purchases) {
    const l = map.get(p.party_id)
    if (!l) continue
    l.purchasesTotal += num(p.total)
    l.purchasesDue += num(p.due)
  }
  return map
}

// ── Payment method breakdown ─────────────────────────────────────────────────

export interface PaymentMethodRow {
  /** Display label: mode name, or the bank account name (Cash), or "Other". */
  label: string
  moneyIn: number
  moneyOut: number
}

/**
 * Payment analysis by the ACTUAL supported payment modes (spec §13): a
 * payment's method label is its payment mode name; payments without a mode
 * are cash-settled and labelled by their bank account ("Cash" for the cash
 * account). Rows are ordered by total movement, largest first.
 */
export function paymentMethodBreakdown(
  paymentsIn: ReadonlyArray<AnalyticsPaymentInRow>,
  paymentsOut: ReadonlyArray<AnalyticsPaymentOutRow>,
  range: DateRange,
): PaymentMethodRow[] {
  const acc = new Map<string, PaymentMethodRow>()
  const labelOf = (p: { mode_name: string | null; bank_name: string | null; bank_is_cash: boolean | null }) =>
    p.mode_name ?? (p.bank_is_cash === true ? 'Cash' : p.bank_name) ?? 'Other'
  for (const p of paymentsIn) {
    if (!dateInRange(p.date, range)) continue
    const row = acc.get(labelOf(p)) ?? { label: labelOf(p), moneyIn: 0, moneyOut: 0 }
    row.moneyIn += num(p.amount)
    acc.set(row.label, row)
  }
  for (const p of paymentsOut) {
    if (!dateInRange(p.date, range)) continue
    const row = acc.get(labelOf(p)) ?? { label: labelOf(p), moneyIn: 0, moneyOut: 0 }
    row.moneyOut += num(p.amount)
    acc.set(row.label, row)
  }
  return [...acc.values()].sort((a, b) => b.moneyIn + b.moneyOut - (a.moneyIn + a.moneyOut) || a.label.localeCompare(b.label))
}

// ── Overview assembly ────────────────────────────────────────────────────────

export interface OverviewKpis {
  sales: number
  purchases: number
  paymentsIn: number
  paymentsOut: number
  /** Outstanding receivable across the FY's active sales (current balance). */
  receivables: number
  /** Outstanding payable across the FY's active purchases (current balance). */
  payables: number
  /** Current stock cost value (position, not a period flow). */
  inventoryValue: number
  tradeInValue: number
  invoiceCount: number
  averageInvoiceValue: number
}

/**
 * The Overview KPI assembly — period flows (sales/purchases/payments/
 * trade-in value) alongside current positions (receivables, payables,
 * inventory value), all from the SAME fold. Gross margin is deliberately
 * NOT invented here: sold-item cost data does not support a reliable
 * historical margin per sale.
 */
export function overviewKpis(fold: AnalyticsFold, range: DateRange): OverviewKpis {
  const sales = salesMetrics(fold.sales, range)
  const purchases = purchasesMetrics(fold.purchases, range)
  const money = moneyMetrics(fold.paymentsIn, fold.paymentsOut, range)
  const valuation = inventoryValuation(fold.inventory)
  return {
    sales: sales.totalSales,
    purchases: purchases.totalPurchases,
    paymentsIn: money.moneyIn,
    paymentsOut: money.moneyOut,
    receivables: receivablesTotal(fold.sales),
    payables: payablesTotal(fold.purchases),
    inventoryValue: valuation.costValue,
    tradeInValue: sales.tradeInCredit,
    invoiceCount: sales.invoiceCount,
    averageInvoiceValue: sales.averageInvoiceValue,
  }
}
