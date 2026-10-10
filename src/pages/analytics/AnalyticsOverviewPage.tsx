'use client';

/**
 * ANALYTICS — OVERVIEW
 *
 * "How is my business doing?" — a restrained executive view: period flows
 * (sales, purchases, payments) beside current positions (receivables,
 * payables, stock value), one business trend, the top products/customers,
 * and the actionable attention feed. All numbers come from the shared fold
 * via the shared metric functions — the same truth the Excel Business
 * Report prints and the notice system detects on.
 */
import { useMemo } from 'react'
import { Link } from 'react-router'
import {
  TrendingUp,
  ShoppingCart,
  ArrowDownToLine,
  ArrowUpFromLine,
  Wallet,
  Landmark,
  Package,
  RefreshCcw,
  History,
  AlertTriangle,
  AlertCircle,
  Info,
  Bell,
} from 'lucide-react'
import { useAnalyticsWorkspace } from '@/features/analytics/workspace'
import {
  monthlyTrend,
  overviewKpis,
  topCustomers,
  topProducts,
} from '@/features/analytics/metrics'
import { monthLabel } from '@/features/analytics/period'
import { useNotices } from '@/features/notices/useNotices'
import type { Notice } from '@/features/notices/types'
import { KpiCard, SectionCard, AnalyticsSkeleton, AnalyticsError } from '@/components/analytics/KpiCard'
import { TrendChart, BarList, SERIES } from '@/components/analytics/charts'
import { moneyCompact, count } from '@/components/analytics/format'
import { useSkeletonDelay } from '@/components/ui/Skeleton'
import { cn } from '@/components/ui/utils'

export default function AnalyticsOverviewPage() {
  const ws = useAnalyticsWorkspace()
  const { fold, period, isPeriodEmpty } = ws
  const pulsing = useSkeletonDelay(ws.fyLoading || ws.fold.isLoading)

  const noticesQuery = useNotices()

  const view = useMemo(() => {
    if (!fold.data) return null
    const data = fold.data
    const kpis = overviewKpis(data, period)
    const trend = monthlyTrend(data.sales, data.purchases, data.paymentsIn, data.paymentsOut, period)
    const products = topProducts(data.saleItems, data.sales, period, 5)
    const customers = topCustomers(data.sales, period, 5)
    return { kpis, trend, products, customers }
  }, [fold.data, period])

  if (ws.fyLoading || (fold.isLoading && !fold.data)) return <AnalyticsSkeleton pulsing={pulsing} />
  if (fold.isError) return <AnalyticsError onRetry={() => fold.refetch()} />
  if (!view) return <AnalyticsSkeleton pulsing={false} />

  const { kpis, trend, products, customers } = view
  const emptyPeriodNote = isPeriodEmpty
    ? 'The selected period has no dates inside this financial year — switch the period or the financial year.'
    : null

  return (
    <div className="space-y-5">
      {emptyPeriodNote && <EmptyPeriodNote note={emptyPeriodNote} />}

      {/* ── KPI grid ──────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiCard label="Sales" value={kpis.sales} icon={TrendingUp} iconBg="bg-indigo-50 text-indigo-500" caption="in period" />
        <KpiCard label="Purchases" value={kpis.purchases} icon={ShoppingCart} iconBg="bg-violet-50 text-violet-500" caption="in period" />
        <KpiCard label="Payments In" value={kpis.paymentsIn} icon={ArrowDownToLine} iconBg="bg-emerald-50 text-emerald-500" caption="in period" />
        <KpiCard label="Payments Out" value={kpis.paymentsOut} icon={ArrowUpFromLine} iconBg="bg-rose-50 text-rose-500" caption="in period" />
        <KpiCard label="Receivables" value={kpis.receivables} icon={Wallet} iconBg="bg-amber-50 text-amber-500" caption="outstanding now" secondary={kpis.invoiceCount} secondaryLabel="Invoices" secondaryFormat="count" />
        <KpiCard label="Payables" value={kpis.payables} icon={Landmark} iconBg="bg-rose-50 text-rose-500" caption="outstanding now" />
        <KpiCard label="Inventory Value" value={kpis.inventoryValue} icon={Package} iconBg="bg-sky-50 text-sky-500" caption="stock at cost, now" />
        <KpiCard label="Trade-In Value" value={kpis.tradeInValue} icon={RefreshCcw} iconBg="bg-sky-50 text-sky-500" caption="credits given in period" />
      </div>

      {/* ── Business trend ────────────────────────────────────────────────── */}
      <SectionCard title="Business Trend" icon={History} meta="Sales vs purchases by month">
        <TrendChart
          points={trend.map((t) => monthLabel(t.month))}
          series={[
            { key: 'sales', label: 'Sales', color: SERIES.sales, values: trend.map((t) => t.sales) },
            { key: 'purchases', label: 'Purchases', color: SERIES.purchases, values: trend.map((t) => t.purchases) },
          ]}
          ariaLabel="Monthly sales and purchases trend"
          emptyMessage="No sales or purchases in this period yet."
        />
      </SectionCard>

      {/* ── Top products / customers ──────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <SectionCard title="Top Products" meta="by revenue, in period">
          <BarList
            items={products.map((p) => ({
              label: `${p.brand} ${p.model}`,
              sublabel: `${count(p.units)} ${p.units === 1 ? 'unit' : 'units'} sold`,
              value: p.revenue,
              valueLabel: moneyCompact(p.revenue),
            }))}
            ariaLabel="Top products by revenue"
            emptyMessage="No products sold in this period."
          />
        </SectionCard>
        <SectionCard title="Top Customers" meta="by revenue, in period">
          <BarList
            items={customers.map((c) => ({
              label: c.name,
              sublabel: `${count(c.invoiceCount)} ${c.invoiceCount === 1 ? 'invoice' : 'invoices'} · ${moneyCompact(c.due)} due`,
              value: c.revenue,
              valueLabel: moneyCompact(c.revenue),
            }))}
            ariaLabel="Top customers by revenue"
            emptyMessage="No customers with sales in this period."
          />
        </SectionCard>
      </div>

      {/* ── Attention (the shared notice feed) ────────────────────────────── */}
      <AttentionCard notices={noticesQuery.notices} isLoading={noticesQuery.isLoading} />
    </div>
  )
}

/** The attention card — the SAME derived notice feed the header bell shows. */
function AttentionCard({
  notices,
  isLoading,
  limit = 6,
}: {
  notices: ReadonlyArray<Notice>
  isLoading?: boolean
  limit?: number
}) {
  const shown = notices.slice(0, limit)
  return (
    <SectionCard
      title="Attention"
      icon={Bell}
      meta={notices.length > 0 ? `${count(notices.length)} ${notices.length === 1 ? 'notice' : 'notices'}` : undefined}
    >
      {isLoading ? (
        <p className="text-xs text-slate-400 py-4 text-center">Loading notices…</p>
      ) : shown.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-1.5 py-6">
          <div className="w-7 h-7 rounded-full bg-emerald-50 flex items-center justify-center">
            <span className="text-emerald-500 text-sm">✓</span>
          </div>
          <p className="text-[11px] text-slate-400">Nothing needs attention right now.</p>
        </div>
      ) : (
        <div className="divide-y divide-slate-50">
          {shown.map((notice) => (
            <Link
              key={notice.id}
              to={notice.action?.to ?? '#'}
              className="flex items-start gap-2.5 py-2.5 group"
            >
              {notice.severity === 'critical' ? (
                <AlertCircle className="w-3.5 h-3.5 mt-px shrink-0 text-rose-500" />
              ) : notice.severity === 'warning' ? (
                <AlertTriangle className="w-3.5 h-3.5 mt-px shrink-0 text-amber-500" />
              ) : (
                <Info className="w-3.5 h-3.5 mt-px shrink-0 text-sky-500" />
              )}
              <div className="min-w-0 flex-1">
                <p
                  className={cn(
                    'text-[11px] font-semibold leading-none mb-0.5',
                    notice.severity === 'critical' ? 'text-rose-700' : notice.severity === 'warning' ? 'text-amber-700' : 'text-sky-700',
                  )}
                >
                  {notice.title}
                </p>
                <p className="text-[11px] text-slate-500 leading-snug">{notice.message}</p>
              </div>
              {notice.action && (
                <span className="text-[10px] font-semibold text-indigo-600 opacity-0 group-hover:opacity-100 transition-opacity shrink-0 mt-0.5">
                  {notice.action.label} →
                </span>
              )}
            </Link>
          ))}
        </div>
      )}
    </SectionCard>
  )
}

function EmptyPeriodNote({ note }: { note: string }) {
  return (
    <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 flex items-start gap-2.5">
      <Info className="w-3.5 h-3.5 text-amber-500 shrink-0 mt-px" />
      <p className="text-[11px] text-amber-800 leading-snug">{note}</p>
    </div>
  )
}
