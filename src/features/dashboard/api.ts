import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/platform/supabase/client'
import type { FinancialYear } from '@/features/types'

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

export interface DashboardAlert {
  type: 'warning' | 'info'
  title: string
  message: string
}

export interface DashboardData {
  metrics: DashboardMetrics
  recentActivity: DashboardActivity[]
  alerts: DashboardAlert[]
}

export const dashboardKeys = {
  page: (fyId: string) => ['dashboard', fyId] as const,
}

/** How many events the Recent Activity preview shows (a fixed, compact set). */
export const RECENT_ACTIVITY_LIMIT = 5

/**
 * PostgREST to-one FK embeds may arrive as one-element arrays — normalize
 * defensively (the established firstOrNull pattern, see payments/api.ts).
 */
function firstOrNull<T>(value: T[] | T | null | undefined): T | null {
  if (Array.isArray(value)) return (value[0] as T | undefined) ?? null
  return (value as T | null | undefined) ?? null
}

// ── The fold ────────────────────────────────────────────────────────────────

/**
 * Dashboard data — one FY-scoped fold over the transactional tables.
 *
 * Everything the dashboard and the header notifications need comes from
 * this ONE cached query (shared key `['dashboard', fyId]`, invalidated by
 * every business mutation through the semantic invalidation helpers):
 *
 *   - inventory (in-stock only)  → stock overview metrics + zero-stock alert
 *   - sales / purchases (active) → month/today metrics, dues / payables
 *                                  alerts and the recent-activity preview
 *   - latest payments (bounded)  → the recent-activity preview only
 *
 * The recent-activity payments are fetched newest-first with a LIMIT equal
 * to the preview size (per direction): any payment outside that sample is
 * older than five same-direction payments, so it can never belong to the
 * top-five overall — the preview stays exact without pulling full tables.
 */
export function useDashboardData(
  selectedYear: FinancialYear | null,
  isReadOnly: boolean,
  fyLoading: boolean,
) {
  const foldQuery = useQuery({
    queryKey: dashboardKeys.page(selectedYear?.id ?? ''),
    enabled: !fyLoading && !!selectedYear,
    queryFn: async (): Promise<{
      inStock: { purchase_price: number; base_selling_price: number }[]
      sales: { id: string; date: string; created_at: string; due: number; final_total: number; bill_number: string; parties: { name: string | null } | null }[]
      purchases: { id: string; date: string; created_at: string; due: number; total: number; bill_number: string; parties: { name: string | null } | null }[]
      paymentsIn: { id: string; date: string; created_at: string; amount: number; parties: { name: string | null } | null }[]
      paymentsOut: { id: string; date: string; created_at: string; amount: number; parties: { name: string | null } | null }[]
    } | null> => {
      if (!selectedYear) return null

      const [
        { data: invData },
        { data: salesData },
        { data: purData },
        { data: pinData },
        { data: poutData },
      ] = await Promise.all([
        supabase
          .from('inventory_items')
          .select('purchase_price, base_selling_price')
          .eq('financial_year_id', selectedYear.id)
          .eq('status', 'in_stock'),
        supabase
          .from('sales')
          .select('id, date, created_at, due, final_total, bill_number, parties (name)')
          .eq('financial_year_id', selectedYear.id)
          .eq('status', 'active'),
        supabase
          .from('purchases')
          .select('id, date, created_at, due, total, bill_number, parties (name)')
          .eq('financial_year_id', selectedYear.id)
          .eq('status', 'active'),
        supabase
          .from('payments_in')
          .select('id, date, created_at, amount, parties (name)')
          .eq('financial_year_id', selectedYear.id)
          .order('date', { ascending: false })
          .order('created_at', { ascending: false })
          .limit(RECENT_ACTIVITY_LIMIT),
        supabase
          .from('payments_out')
          .select('id, date, created_at, amount, parties (name)')
          .eq('financial_year_id', selectedYear.id)
          .order('date', { ascending: false })
          .order('created_at', { ascending: false })
          .limit(RECENT_ACTIVITY_LIMIT),
      ])

      // Normalize the to-one party embeds once at the query boundary so
      // every consumer sees the plain object-or-null shape.
      const partyName = (v: unknown) => firstOrNull(v as { name: string | null } | null)?.name ?? null

      return {
        inStock: invData ?? [],
        sales: (salesData ?? []).map((s) => ({ ...s, parties: s.parties ? { name: partyName(s.parties) } : null })),
        purchases: (purData ?? []).map((p) => ({ ...p, parties: p.parties ? { name: partyName(p.parties) } : null })),
        paymentsIn: (pinData ?? []).map((p) => ({ ...p, parties: p.parties ? { name: partyName(p.parties) } : null })),
        paymentsOut: (poutData ?? []).map((p) => ({ ...p, parties: p.parties ? { name: partyName(p.parties) } : null })),
      }
    },
  })

  function compute(): DashboardData | null {
    const fold = foldQuery.data
    if (!fold) return null

    const todayStr = new Date().toISOString().split('T')[0]
    const monthStr = todayStr.substring(0, 7)

    // ── Stock overview — the same authoritative in-stock rows the
    //    inventory page lists: units, cost value (purchase price) and
    //    selling value (base selling price); the margin is the difference.
    const stockValue = fold.inStock.reduce((a, c) => a + Number(c.purchase_price ?? 0), 0)
    const stockSellingValue = fold.inStock.reduce((a, c) => a + Number(c.base_selling_price ?? 0), 0)

    const todaySales = fold.sales
      .filter((s) => s.date === todayStr)
      .reduce((a, s) => a + Number(s.final_total ?? 0), 0)
    const thisMonthSales = fold.sales
      .filter((s) => s.date.startsWith(monthStr))
      .reduce((a, s) => a + Number(s.final_total ?? 0), 0)
    const totalDues = fold.sales.reduce((a, s) => a + Number(s.due ?? 0), 0)
    const todayPurchases = fold.purchases
      .filter((p) => p.date === todayStr)
      .reduce((a, p) => a + Number(p.total ?? 0), 0)
    const thisMonthPurchases = fold.purchases
      .filter((p) => p.date.startsWith(monthStr))
      .reduce((a, p) => a + Number(p.total ?? 0), 0)
    const totalPayables = fold.purchases.reduce((a, p) => a + Number(p.due ?? 0), 0)

    // ── Recent Activity — the latest few meaningful business events,
    //    derived from the transaction tables the fold already owns (no
    //    separate event framework): sales, purchases and payments, merged
    //    by business date (created_at as the tiebreak) and capped to the
    //    fixed preview size.
    const recentActivity: DashboardActivity[] = [
      ...fold.sales.map((s) => ({
        kind: 'sale' as const,
        billNumber: s.bill_number,
        partyName: s.parties?.name ?? null,
        amount: Number(s.final_total ?? 0),
        date: s.date,
        created_at: s.created_at,
      })),
      ...fold.purchases.map((p) => ({
        kind: 'purchase' as const,
        billNumber: p.bill_number,
        partyName: p.parties?.name ?? null,
        amount: Number(p.total ?? 0),
        date: p.date,
        created_at: p.created_at,
      })),
      ...fold.paymentsIn.map((p) => ({
        kind: 'payment_in' as const,
        billNumber: null,
        partyName: p.parties?.name ?? null,
        amount: Number(p.amount ?? 0),
        date: p.date,
        created_at: p.created_at,
      })),
      ...fold.paymentsOut.map((p) => ({
        kind: 'payment_out' as const,
        billNumber: null,
        partyName: p.parties?.name ?? null,
        amount: Number(p.amount ?? 0),
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

    const alerts: DashboardAlert[] = []
    if (selectedYear) {
      if (new Date() > new Date(selectedYear.end_date) && !isReadOnly)
        alerts.push({
          type: 'warning',
          title: 'Financial Year Ended',
          message: `FY ${selectedYear.start_date} – ${selectedYear.end_date} has ended. Close it to carry forward stock.`,
        })
      if (fold.inStock.length === 0)
        alerts.push({ type: 'warning', title: 'Zero Stock', message: 'No items in stock for this financial year.' })
      if (totalDues > 0)
        alerts.push({
          type: 'info',
          title: 'Outstanding Dues',
          message: `${totalDues.toLocaleString('en-IN', { minimumFractionDigits: 2 })} Rs. pending from customers.`,
        })
      if (totalPayables > 0)
        alerts.push({
          type: 'info',
          title: 'Pending Payables',
          message: `${totalPayables.toLocaleString('en-IN', { minimumFractionDigits: 2 })} Rs. pending to suppliers.`,
        })
    }

    return {
      metrics: {
        inStockCount: fold.inStock.length,
        totalStockValue: stockValue,
        totalStockSellingValue: stockSellingValue,
        stockPotentialMargin: stockSellingValue - stockValue,
        todaySales,
        thisMonthSales,
        todayPurchases,
        thisMonthPurchases,
        totalDuesToReceive: totalDues,
        totalPayables,
      },
      recentActivity,
      alerts,
    }
  }

  return {
    ...foldQuery,
    data: compute(),
    isLoading: foldQuery.isLoading,
  }
}
