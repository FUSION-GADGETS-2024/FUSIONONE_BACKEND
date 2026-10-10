'use client';

/**
 * ANALYTICS — SALES
 *
 * "What am I selling and where is sales performance coming from?" —
 * sales KPIs, the monthly trend, the paid/partial/unpaid split, product
 * and customer leaders, the trade-in sub-section (a meaningful part of
 * sales performance, not a sixth tab), and the business-readable sales
 * register. Cancelled invoices are excluded from every metric (they are
 * annotated at the register footer instead of silently vanishing).
 */
import { useMemo } from 'react'
import { Link } from 'react-router'
import {
  TrendingUp,
  FileText,
  Divide,
  CheckCircle2,
  Clock,
  Crown,
  RefreshCcw,
  Smartphone,
} from 'lucide-react'
import { useAnalyticsWorkspace } from '@/features/analytics/workspace'
import {
  monthlyTrend,
  paymentStateBreakdown,
  salesMetrics,
  stockComposition,
  topCustomers,
  topProducts,
  tradeInMetrics,
  num,
  dateInRange,
} from '@/features/analytics/metrics'
import { monthLabel } from '@/features/analytics/period'
import { KpiCard, SectionCard, StatTile, AnalyticsSkeleton, AnalyticsError } from '@/components/analytics/KpiCard'
import { TrendChart, DonutChart, BarList, SERIES } from '@/components/analytics/charts'
import { money, moneyCompact, count } from '@/components/analytics/format'
import { DataTable, CellLines, type DataTableColumn } from '@/components/ui/tables'
import { useSkeletonDelay } from '@/components/ui/Skeleton'
import { cn } from '@/components/ui/utils'
import type { AnalyticsSaleRow } from '@/features/analytics/types'

interface RegisterRow {
  id: string
  date: string
  billNumber: string
  itemName: string
  customer: string
  items: number
  total: number
  paid: number
  due: number
  state: 'paid' | 'partial' | 'unpaid'
}

const STATE_PILLS: Record<RegisterRow['state'], { label: string; className: string }> = {
  paid: { label: 'Paid', className: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  partial: { label: 'Partial', className: 'bg-amber-50 text-amber-700 border-amber-200' },
  unpaid: { label: 'Unpaid', className: 'bg-rose-50 text-rose-700 border-rose-200' },
}

export default function AnalyticsSalesPage() {
  const ws = useAnalyticsWorkspace()
  const { fold, period, isPeriodEmpty } = ws
  const pulsing = useSkeletonDelay(ws.fyLoading || ws.fold.isLoading)

  const view = useMemo(() => {
    if (!fold.data) return null
    const data = fold.data
    const metrics = salesMetrics(data.sales, period)
    const trend = monthlyTrend(data.sales, data.purchases, data.paymentsIn, data.paymentsOut, period)
    const states = paymentStateBreakdown(data.sales, period)
    const products = topProducts(data.saleItems, data.sales, period, 5)
    const customers = topCustomers(data.sales, period, 5)
    const tradeIns = tradeInMetrics(data.tradeIns, data.sales, period)
    const composition = stockComposition(data.inventory)

    const itemsPerSale = new Map<string, number>()
    for (const item of data.saleItems) itemsPerSale.set(item.sale_id, (itemsPerSale.get(item.sale_id) ?? 0) + 1)

    // Item names per invoice (the SAME invoice → inventory relationship the
    // Sales Register Excel export renders).
    const namesPerSale = new Map<string, string[]>()
    for (const item of data.saleItems) {
      const inv = item.inventory_items
      const name = inv ? `${inv.brand ?? ''} ${inv.model ?? ''}`.trim() : ''
      if (!name) continue
      const list = namesPerSale.get(item.sale_id) ?? []
      list.push(name)
      namesPerSale.set(item.sale_id, list)
    }

    const register: RegisterRow[] = data.sales
      .filter((s: AnalyticsSaleRow) => s.status === 'active' && dateInRange(s.date, period))
      .map((s) => {
        const paid = num(s.paid)
        const due = num(s.due)
        return {
          id: s.id,
          date: s.date.slice(0, 10),
          billNumber: s.bill_number,
          itemName: (namesPerSale.get(s.id) ?? []).join(', ') || '—',
          customer: s.party_name ?? '—',
          items: itemsPerSale.get(s.id) ?? 0,
          total: num(s.final_total),
          paid,
          due,
          state: (due <= 0 ? 'paid' : paid > 0 ? 'partial' : 'unpaid') as RegisterRow['state'],
        }
      })
      .sort((a, b) => (a.date !== b.date ? (a.date < b.date ? 1 : -1) : b.billNumber.localeCompare(a.billNumber)))

    return { metrics, trend, states, products, customers, tradeIns, composition, register }
  }, [fold.data, period])

  if (ws.fyLoading || (fold.isLoading && !fold.data)) return <AnalyticsSkeleton pulsing={pulsing} />
  if (fold.isError) return <AnalyticsError onRetry={() => fold.refetch()} />
  if (!view) return <AnalyticsSkeleton pulsing={false} />

  const { metrics, trend, states, products, customers, tradeIns, composition, register } = view

  const columns: Array<DataTableColumn<RegisterRow>> = [
    {
      id: 'date',
      header: 'Date',
      width: 'w-[9%]',
      render: (r) => <span className="text-xs text-slate-500 tabular-nums">{r.date}</span>,
      mobile: 'meta',
    },
    {
      id: 'invoice',
      header: 'Invoice',
      width: 'w-[15%]',
      render: (r) => (
        <Link to={`/sales/${r.id}`} className="text-xs font-medium text-indigo-600 hover:text-indigo-800 transition-colors tabular-nums">
          {r.billNumber}
        </Link>
      ),
      mobile: 'identity',
    },
    {
      id: 'itemName',
      header: 'Item Name',
      width: 'w-[22%]',
      render: (r) => (
        <span className="text-xs text-slate-700 leading-snug" title={r.itemName}>
          {r.itemName}
        </span>
      ),
      mobile: 'secondary',
    },
    {
      id: 'customer',
      header: 'Customer',
      width: 'w-[16%]',
      render: (r) => <CellLines primary={r.customer} secondary={`${count(r.items)} ${r.items === 1 ? 'item' : 'items'}`} />,
      mobile: 'secondary',
    },
    {
      id: 'total',
      header: 'Total',
      align: 'right',
      width: 'w-[12%]',
      render: (r) => <span className="text-xs font-semibold text-slate-900 tabular-nums">{money(r.total)}</span>,
      mobile: 'amount',
      mobileLabel: 'Total',
    },
    {
      id: 'paid',
      header: 'Paid',
      align: 'right',
      width: 'w-[12%]',
      render: (r) => <span className="text-xs text-emerald-700 tabular-nums">{money(r.paid)}</span>,
      mobile: 'amount',
      mobileLabel: 'Paid',
    },
    {
      id: 'due',
      header: 'Due',
      align: 'right',
      width: 'w-[12%]',
      render: (r) => (
        <span className={cn('text-xs tabular-nums', r.due > 0 ? 'text-rose-600 font-semibold' : 'text-slate-400')}>
          {money(r.due)}
        </span>
      ),
      mobile: 'amount',
      mobileLabel: 'Due',
    },
    {
      id: 'state',
      header: 'Status',
      align: 'center',
      width: 'w-[8%]',
      render: (r) => {
        const pill = STATE_PILLS[r.state]
        return (
          <span className={cn('inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold border leading-4', pill.className)}>
            {pill.label}
          </span>
        )
      },
      mobile: 'meta',
    },
  ]

  const stateTotal = states.reduce((a, s) => a + s.value, 0)

  return (
    <div className="space-y-5">
      {isPeriodEmpty && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-[11px] text-amber-800">
          The selected period has no dates inside this financial year — switch the period or the financial year.
        </div>
      )}

      {/* ── KPIs ──────────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3">
        <KpiCard label="Total Sales" value={metrics.totalSales} icon={TrendingUp} iconBg="bg-indigo-50 text-indigo-500" caption="in period" />
        <KpiCard label="Invoice Count" value={metrics.invoiceCount} valueFormat="count" icon={FileText} iconBg="bg-indigo-50 text-indigo-500" caption="active invoices" />
        <KpiCard label="Average Invoice" value={metrics.averageInvoiceValue} icon={Divide} iconBg="bg-violet-50 text-violet-500" caption="per invoice" />
        <KpiCard label="Paid Sales" value={metrics.paidSales} icon={CheckCircle2} iconBg="bg-emerald-50 text-emerald-500" caption="received on these invoices" />
        <KpiCard label="Outstanding" value={metrics.outstandingSales} icon={Clock} iconBg="bg-amber-50 text-amber-500" caption="still due on these invoices" />
        <KpiCard label="Highest Sale" value={metrics.highestSale} icon={Crown} iconBg="bg-violet-50 text-violet-500" caption="single invoice, in period" />
      </div>

      {/* ── Trend + payment-state split ───────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-3">
        <SectionCard title="Sales Trend" icon={TrendingUp} meta="by month, in period" className="lg:col-span-3">
          <TrendChart
            points={trend.map((t) => monthLabel(t.month))}
            series={[{ key: 'sales', label: 'Sales', color: SERIES.sales, values: trend.map((t) => t.sales) }]}
            ariaLabel="Monthly sales trend"
            emptyMessage="No sales in this period yet."
          />
        </SectionCard>
        <SectionCard title="Payment State" meta="invoice value split, in period" className="lg:col-span-2">
          <DonutChart
            segments={[
              { label: 'Paid', value: states[0].value, color: SERIES.paid },
              { label: 'Partially paid', value: states[1].value, color: SERIES.partial },
              { label: 'Unpaid', value: states[2].value, color: SERIES.unpaid },
            ]}
            centerLabel="Invoiced in period"
            centerValue={money(stateTotal)}
            ariaLabel="Payment state breakdown of sales in the period"
            emptyMessage="No invoices in this period."
          />
        </SectionCard>
      </div>

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

      {/* ── Trade-in performance (the sales sub-section) ──────────────────── */}
      <SectionCard title="Trade-In Performance" icon={RefreshCcw} meta="received via sales, in period">
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-2">
          <StatTile label="Devices Received" value={count(tradeIns.received)} caption="trade-ins in period" />
          <StatTile label="Trade-In Value" value={money(tradeIns.value)} caption="credits given" />
          <StatTile label="Sold Since Receipt" value={count(tradeIns.soldSinceReceipt)} caption="of the devices received" valueClassName="text-emerald-600" />
          <StatTile label="Still In Stock" value={count(tradeIns.stillInStock)} caption="of the devices received" />
          <StatTile label="Trade-In Stock Now" value={money(composition.tradeInValue)} caption={`${count(composition.tradeInUnits)} units in stock (all acquisitions)`} />
        </div>
      </SectionCard>

      {/* ── Sales register ────────────────────────────────────────────────── */}
      <div className="space-y-3">
        <div className="flex items-center gap-1.5 px-1">
          <Smartphone className="w-3 h-3 text-slate-400 shrink-0" />
          <span className="text-[10px] font-bold tracking-[0.1em] uppercase text-slate-400">Sales Register</span>
          <span className="ml-auto text-[10px] text-slate-400">
            {count(register.length)} {register.length === 1 ? 'invoice' : 'invoices'} · {money(register.reduce((a, r) => a + r.total, 0))}
          </span>
        </div>
        <DataTable
          columns={columns}
          rows={register}
          rowKey={(r) => r.id}
          loading={false}
          minWidth="min-w-[860px]"
          emptyMessage="No invoices in this period. Record a sale to see it here."
          footer={
            <div className="px-4 py-3 border-t border-slate-100 flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-400">
              <span>
                Cancelled invoices are excluded from analytics ({count(metrics.cancelledCount)} in this financial year).
              </span>
              <span className="tabular-nums">
                Total {money(register.reduce((a, r) => a + r.total, 0))} · Paid {money(register.reduce((a, r) => a + r.paid, 0))} · Due{' '}
                {money(register.reduce((a, r) => a + r.due, 0))}
              </span>
            </div>
          }
        />
      </div>
    </div>
  )
}
