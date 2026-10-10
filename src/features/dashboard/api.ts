import type { FinancialYear } from '@/features/types'
import { useAnalyticsFold } from '@/features/analytics/fold'
import {
  inventoryValuation,
  num,
  payablesTotal,
  purchasesMetrics,
  receivablesTotal,
  salesMetrics,
} from '@/features/analytics/metrics'
import { monthEnd, todayStr } from '@/features/analytics/period'

// ── Types ───────────────────────────────────────────────────────────────────

export interface DashboardMetrics {
  inStockCount: number
  totalStockValue: number
  totalStockSellingValue: number
  stockPotentialMargin: number
  todaySales: number
  thisMonthSales: number
  todayPurchases: number
  thisMonthPurchases: number
  totalDuesToReceive: number
  totalPayables: number
}

/** One entry of the dashboard's Recent Activity preview. */
export interface DashboardActivity {
  kind: 'sale' | 'purchase' | 'payment_in' | 'payment_out'
  /** Document number (sales / purchases); null for payments. */
  billNumber: string | null
  /** Customer / supplier name when the transaction has one. */
  partyName: string | null
  /** Document total (sale / purchase) or the paid amount (payments). */
  amount: number
  /** Business date (YYYY-MM-DD) — the app's standard display format. */
  date: string
}

export interface DashboardData {
  metrics: DashboardMetrics
  recentActivity: DashboardActivity[]
}

/** How many events the Recent Activity preview shows (a fixed, compact set). */
export const RECENT_ACTIVITY_LIMIT = 5

// ── The fold ────────────────────────────────────────────────────────────────

/**
 * Dashboard data — a derivation over the ONE analytics fold.
 *
 * The dashboard's own query used to be a separate lightweight fold; it is
 * now computed from the same cached analytics dataset (a strict superset)
 * through the SAME authoritative metric functions the Analytics pages,
 * notices and Excel reports use. One dataset, one calculation layer, no
 * duplicate formulas. The public contract (DashboardData shape) is
 * preserved exactly.
 *
 * One intentional semantics fix rides along: "Purchases" now excludes
 * virtual trade-in acquisition bills (hidden PUR-TRD- bills / recovery
 * bills). No money moves for those — the trade-in credit is already
 * reflected in the originating sale — so counting them double-counted
 * purchase spend.
 */
export function useDashboardData(
  selectedYear: FinancialYear | null,
  fyLoading: boolean,
) {
  const foldQuery = useAnalyticsFold(selectedYear, fyLoading)

  function compute(): DashboardData | null {
    const fold = foldQuery.data
    if (!fold) return null

    const today = todayStr()
    const todayRange = { from: today, to: today }
    const thisMonthRange = { from: `${today.slice(0, 7)}-01`, to: monthEnd(today) }

    const salesToday = salesMetrics(fold.sales, todayRange)
    const salesThisMonth = salesMetrics(fold.sales, thisMonthRange)
    const purchasesToday = purchasesMetrics(fold.purchases, todayRange)
    const purchasesThisMonth = purchasesMetrics(fold.purchases, thisMonthRange)
    const valuation = inventoryValuation(fold.inventory)

    // ── Recent Activity — the latest few meaningful business events,
    //    derived from the transaction tables the fold already owns (no
    //    separate event framework), merged by business date (created_at as
    //    the tiebreak) and capped to the fixed preview size.
    const recentActivity: DashboardActivity[] = [
      ...fold.sales.map((s) => ({
        kind: 'sale' as const,
        billNumber: s.bill_number,
        partyName: s.party_name ?? null,
        amount: num(s.final_total),
        date: s.date,
        created_at: s.created_at,
      })),
      ...fold.purchases.map((p) => ({
        kind: 'purchase' as const,
        billNumber: p.bill_number,
        partyName: p.party_name ?? null,
        amount: num(p.total),
        date: p.date,
        created_at: p.created_at,
      })),
      ...fold.paymentsIn.map((p) => ({
        kind: 'payment_in' as const,
        billNumber: null,
        partyName: p.party_name ?? null,
        amount: num(p.amount),
        date: p.date,
        created_at: p.created_at,
      })),
      ...fold.paymentsOut.map((p) => ({
        kind: 'payment_out' as const,
        billNumber: null,
        partyName: p.party_name ?? null,
        amount: num(p.amount),
        date: p.date,
        created_at: p.created_at,
      })),
    ]
      .sort((a, b) => {
        if (a.date !== b.date) return a.date < b.date ? 1 : -1
        if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1
        return 0
      })
      .slice(0, RECENT_ACTIVITY_LIMIT)
      .map(({ kind, billNumber, partyName, amount, date }) => ({
        kind,
        billNumber,
        partyName,
        amount,
        date,
      }))

    return {
      metrics: {
        inStockCount: valuation.units,
        totalStockValue: valuation.costValue,
        totalStockSellingValue: valuation.sellingValue,
        stockPotentialMargin: valuation.potentialMargin,
        todaySales: salesToday.totalSales,
        thisMonthSales: salesThisMonth.totalSales,
        todayPurchases: purchasesToday.totalPurchases,
        thisMonthPurchases: purchasesThisMonth.totalPurchases,
        totalDuesToReceive: receivablesTotal(fold.sales),
        totalPayables: payablesTotal(fold.purchases),
      },
      recentActivity,
    }
  }

  return {
    ...foldQuery,
    data: compute(),
    isLoading: foldQuery.isLoading,
  }
}
