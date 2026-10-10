'use client';

/**
 * ANALYTICS — INVENTORY
 *
 * "What stock do I have, what is it worth, and what is becoming a problem?"
 * — the CURRENT stock position for the selected FY: valuation at the
 * authoritative cost semantics (Σ purchase_price over in-stock items),
 * trade-in vs regular composition, brand distribution, ageing from the
 * original acquisition date (carry-forward origin chain), the 90+ day
 * problem stock, plus what was acquired during the selected period and the
 * inventory register.
 */
import { useMemo } from 'react'
import {
  Smartphone,
  Package,
  RefreshCcw,
  AlertTriangle,
  CalendarClock,
  Layers,
  ArrowDownToLine,
} from 'lucide-react'
import { useAnalyticsWorkspace } from '@/features/analytics/workspace'
import {
  acquisitionTimestamp,
  brandDistribution,
  dateInRange,
  inStockItems,
  inventoryAge,
  inventoryAgeing,
  inventoryValuation,
  num,
  stockComposition,
} from '@/features/analytics/metrics'
import { timelineMap } from '@/features/analytics/metrics'
import { dateOnly } from '@/features/analytics/period'
import { KpiCard, SectionCard, StatTile, AnalyticsSkeleton, AnalyticsError } from '@/components/analytics/KpiCard'
import { DonutChart, AgeingBars, SERIES } from '@/components/analytics/charts'
import { money, count, days } from '@/components/analytics/format'
import { DataTable, CellLines, type DataTableColumn } from '@/components/ui/tables'
import { useSkeletonDelay } from '@/components/ui/Skeleton'
import { cn } from '@/components/ui/utils'
import type { AnalyticsInventoryRow } from '@/features/analytics/types'

interface InventoryRegisterRow {
  id: string
  brand: string
  model: string
  imei: string
  source: 'purchase' | 'trade_in'
  acquired: string
  ageDays: number
  cost: number
  selling: number
}

export default function AnalyticsInventoryPage() {
  const ws = useAnalyticsWorkspace()
  const { fold, period, today } = ws
  const pulsing = useSkeletonDelay(ws.fyLoading || ws.fold.isLoading)

  const view = useMemo(() => {
    if (!fold.data) return null
    const data = fold.data
    const timeline = timelineMap(data.timeline)

    const valuation = inventoryValuation(data.inventory)
    const composition = stockComposition(data.inventory)
    const ageing = inventoryAgeing(data.inventory, timeline, today)
    const brands = brandDistribution(data.inventory)

    // Acquisitions within the period (flow) — acquisition date via the
    // origin chain, so carried-forward stock counts at its ORIGINAL
    // acquisition, never twice.
    const stock = inStockItems(data.inventory)
    const acquiredInPeriod = stock.filter((i) => dateInRange(dateOnly(acquisitionTimestamp(i, timeline)), period))
    const acquiredCost = acquiredInPeriod.reduce((a, i) => a + num(i.purchase_price), 0)

    const register: InventoryRegisterRow[] = stock
      .map((i: AnalyticsInventoryRow) => ({
        id: i.id,
        brand: i.brand,
        model: i.model,
        imei: i.imei,
        source: i.source,
        acquired: dateOnly(acquisitionTimestamp(i, timeline)),
        ageDays: inventoryAge(i, timeline, today),
        cost: num(i.purchase_price),
        selling: num(i.base_selling_price),
      }))
      .sort((a, b) => b.ageDays - a.ageDays || a.brand.localeCompare(b.brand))

    return { valuation, composition, ageing, brands, acquiredInPeriod, acquiredCost, register, timeline }
  }, [fold.data, period, today])

  if (ws.fyLoading || (fold.isLoading && !fold.data)) return <AnalyticsSkeleton pulsing={pulsing} />
  if (fold.isError) return <AnalyticsError onRetry={() => fold.refetch()} />
  if (!view) return <AnalyticsSkeleton pulsing={false} />

  const { valuation, composition, ageing, brands, acquiredInPeriod, acquiredCost, register } = view

  const columns: Array<DataTableColumn<InventoryRegisterRow>> = [
    {
      id: 'device',
      header: 'Device',
      width: 'w-[26%]',
      render: (r) => <CellLines primary={`${r.brand} ${r.model}`} secondary={r.imei} />,
      mobile: 'identity',
    },
    {
      id: 'source',
      header: 'Source',
      width: 'w-[11%]',
      render: (r) => (
        <span
          className={cn(
            'inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider border leading-4',
            r.source === 'trade_in'
              ? 'bg-sky-50 text-sky-700 border-sky-200'
              : 'bg-indigo-50 text-indigo-700 border-indigo-200',
          )}
        >
          {r.source === 'trade_in' ? 'Trade-In' : 'Purchase'}
        </span>
      ),
      mobile: 'meta',
    },
    {
      id: 'acquired',
      header: 'Acquired',
      width: 'w-[14%]',
      render: (r) => <span className="text-xs text-slate-500 tabular-nums">{r.acquired}</span>,
      mobile: 'secondary',
    },
    {
      id: 'age',
      header: 'Age',
      align: 'right',
      width: 'w-[11%]',
      render: (r) => (
        <span className={cn('text-xs tabular-nums', r.ageDays >= 90 ? 'text-rose-600 font-semibold' : r.ageDays >= 60 ? 'text-amber-600' : 'text-slate-500')}>
          {days(r.ageDays)}
        </span>
      ),
      mobile: 'meta',
    },
    {
      id: 'cost',
      header: 'Cost',
      align: 'right',
      width: 'w-[14%]',
      render: (r) => <span className="text-xs text-slate-900 tabular-nums">{money(r.cost)}</span>,
      mobile: 'amount',
      mobileLabel: 'Cost',
    },
    {
      id: 'selling',
      header: 'Selling Price',
      align: 'right',
      width: 'w-[14%]',
      render: (r) => <span className="text-xs text-slate-500 tabular-nums">{money(r.selling)}</span>,
      mobile: 'amount',
      mobileLabel: 'Listed',
    },
    {
      id: 'margin',
      header: 'Potential Margin',
      align: 'right',
      width: 'w-[14%]',
      render: (r) => (
        <span className={cn('text-xs tabular-nums', r.selling - r.cost >= 0 ? 'text-emerald-600' : 'text-rose-600')}>
          {money(r.selling - r.cost)}
        </span>
      ),
    },
  ]

  return (
    <div className="space-y-5">
      {/* ── KPIs (current stock position) ─────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <KpiCard label="Total Stock Items" value={valuation.units} valueFormat="count" icon={Smartphone} iconBg="bg-indigo-50 text-indigo-500" caption="units in stock, now" />
        <KpiCard label="Inventory Value" value={valuation.costValue} icon={Package} iconBg="bg-indigo-50 text-indigo-500" caption="at cost, now" secondary={valuation.sellingValue} secondaryLabel="At listed price" />
        <KpiCard label="Trade-In Stock" value={composition.tradeInValue} icon={RefreshCcw} iconBg="bg-sky-50 text-sky-500" caption={`${count(composition.tradeInUnits)} units, now`} />
        <KpiCard label="90+ Day Stock" value={ageing.aged90Plus.value} icon={AlertTriangle} iconBg="bg-rose-50 text-rose-500" caption={`${count(ageing.aged90Plus.count)} units aging, now`} />
        <KpiCard label="Average Stock Age" value={ageing.averageAgeDays} valueFormat="days" icon={CalendarClock} iconBg="bg-amber-50 text-amber-500" caption={`oldest: ${days(ageing.oldestAgeDays)}`} />
      </div>

      {/* ── Composition + ageing ───────────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <SectionCard title="Stock Composition" icon={Layers} meta="current stock at cost">
          <DonutChart
            segments={[
              { label: 'Regular (purchased)', value: composition.regularValue, color: SERIES.regular },
              { label: 'Trade-in received', value: composition.tradeInValue, color: SERIES.tradeIn },
            ]}
            centerLabel="Total stock value"
            centerValue={money(valuation.costValue)}
            ariaLabel="Stock composition between regular and trade-in inventory"
            emptyMessage="No items in stock for this financial year."
          />
        </SectionCard>
        <SectionCard title="Stock Ageing" meta="current stock by acquisition age">
          <AgeingBars
            buckets={ageing.buckets.map((b) => ({ label: b.label, count: b.count, amount: b.amount }))}
            ariaLabel="Inventory ageing buckets"
            color={SERIES.regular}
            emptyMessage="No items in stock for this financial year."
          />
        </SectionCard>
      </div>

      {/* ── Brand distribution + acquisitions in period ───────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-3">
        <SectionCard title="Brand Distribution" meta="current stock" className="lg:col-span-3">
          {brands.length === 0 ? (
            <p className="text-xs text-slate-400 py-8 text-center">No items in stock for this financial year.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left min-w-[420px]">
                <thead className="bg-slate-50 border-b border-slate-100">
                  <tr>
                    <th className="px-3 py-2.5 text-[10px] font-bold uppercase tracking-[0.08em] text-slate-400">Brand</th>
                    <th className="px-3 py-2.5 text-[10px] font-bold uppercase tracking-[0.08em] text-slate-400 text-right">Units</th>
                    <th className="px-3 py-2.5 text-[10px] font-bold uppercase tracking-[0.08em] text-slate-400 text-right">Cost Value</th>
                    <th className="px-3 py-2.5 text-[10px] font-bold uppercase tracking-[0.08em] text-slate-400 text-right">Listed Value</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {brands.map((b) => (
                    <tr key={b.brand} className="hover:bg-slate-50/60 transition-colors">
                      <td className="px-3 py-2.5 text-xs font-medium text-slate-900">{b.brand}</td>
                      <td className="px-3 py-2.5 text-xs text-slate-600 tabular-nums text-right">{count(b.count)}</td>
                      <td className="px-3 py-2.5 text-xs text-slate-900 tabular-nums text-right">{money(b.costValue)}</td>
                      <td className="px-3 py-2.5 text-xs text-slate-500 tabular-nums text-right">{money(b.sellingValue)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-slate-200">
                    <td className="px-3 py-2.5 text-[10px] font-bold uppercase tracking-wider text-slate-400">Total</td>
                    <td className="px-3 py-2.5 text-xs font-semibold text-slate-900 tabular-nums text-right">{count(valuation.units)}</td>
                    <td className="px-3 py-2.5 text-xs font-semibold text-slate-900 tabular-nums text-right">{money(valuation.costValue)}</td>
                    <td className="px-3 py-2.5 text-xs font-semibold text-slate-900 tabular-nums text-right">{money(valuation.sellingValue)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </SectionCard>
        <SectionCard title="Acquisitions" icon={ArrowDownToLine} meta="stock added in period">
          <div className="grid grid-cols-1 gap-2">
            <StatTile label="Units Acquired" value={count(acquiredInPeriod.length)} caption="new stock in the selected period" />
            <StatTile label="Acquisition Cost" value={money(acquiredCost)} caption="purchase-price total of those units" />
            <StatTile
              label="Aging Trade-In Stock"
              value={money(ageing.tradeInAged60Plus.value)}
              caption={`${count(ageing.tradeInAged60Plus.count)} trade-in units 60+ days unsold`}
              valueClassName="text-amber-600"
            />
          </div>
        </SectionCard>
      </div>

      {/* ── Inventory register ───────────────────────────────────────────── */}
      <div className="space-y-3">
        <div className="flex items-center gap-1.5 px-1">
          <Smartphone className="w-3 h-3 text-slate-400 shrink-0" />
          <span className="text-[10px] font-bold tracking-[0.1em] uppercase text-slate-400">Inventory Register</span>
          <span className="ml-auto text-[10px] text-slate-400">
            {count(register.length)} {register.length === 1 ? 'unit' : 'units'} in stock · {money(valuation.costValue)}
          </span>
        </div>
        <DataTable
          columns={columns}
          rows={register}
          rowKey={(r) => r.id}
          minWidth="min-w-[900px]"
          emptyMessage="No items in stock for this financial year. Purchases and trade-ins add stock here."
        />
      </div>
    </div>
  )
}
