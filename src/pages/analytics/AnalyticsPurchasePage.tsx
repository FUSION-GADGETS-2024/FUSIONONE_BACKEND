'use client';

/**
 * ANALYTICS — PURCHASE
 *
 * "Understand supplier purchases, purchase costs, and outstanding amounts."
 *
 * The header (title + description + Export action) and the period selector
 * live in the AnalyticsLayout, exactly like the other tabs. This page adds:
 *
 *   - Three summary cards with the agreed financial semantics:
 *       Purchase Value — the total value of qualifying supplier purchase
 *         bills DATED within the selected period (period-based).
 *       Paid — the amount already paid against those INCLUDED bills
 *         (the current state of those bills — NOT money paid during the
 *         period; that question belongs to the Money tab).
 *       Outstanding — the remaining amount owed against those bills.
 *     Purchase Value reconciles with Paid + Outstanding for the included
 *     bills (paid + due = total per bill, maintained transactionally).
 *
 *   - One compact purchase-value trend chart (monthly buckets for a full
 *     financial year, daily buckets for shorter periods) over the SAME
 *     qualifying-purchase rules — active, REAL supplier bills only;
 *     internal trade-in acquisition and recovery records are excluded.
 *
 *   - The Purchase Register: one row per qualifying bill — Purchase Bill
 *     No., Date, Supplier, Items (the actual device names), Total Amount,
 *     Paid, Balance and Status — searchable, sortable and filterable by
 *     supplier and payment status. Selecting a record opens the EXISTING
 *     purchase-detail workflow (/purchases/:id).
 */
import { useMemo, useState } from 'react'
import { Link } from 'react-router'
import {
  ShoppingCart,
  CheckCircle2,
  Clock,
  History,
  Package,
} from 'lucide-react'
import { useAnalyticsWorkspace } from '@/features/analytics/workspace'
import {
  num,
  purchaseTrend,
  purchasesMetrics,
  realPurchasesInRange,
} from '@/features/analytics/metrics'
import { KpiCard, SectionCard, AnalyticsSkeleton, AnalyticsError } from '@/components/analytics/KpiCard'
import { TrendChart, SERIES } from '@/components/analytics/charts'
import { money, count } from '@/components/analytics/format'
import { DataTable, TableSearchInput, type DataTableColumn } from '@/components/ui/tables'
import { Select } from '@/components/ui/Select'
import { useSkeletonDelay } from '@/components/ui/Skeleton'
import { cn } from '@/components/ui/utils'
import type { AnalyticsPurchaseRow } from '@/features/analytics/types'

interface RegisterRow {
  id: string
  date: string
  billNumber: string
  supplier: string
  itemName: string
  total: number
  paid: number
  balance: number
  state: 'paid' | 'partial' | 'unpaid'
}

type StatusFilter = '' | 'paid' | 'partial' | 'unpaid'
type SortKey = 'newest' | 'oldest' | 'amount-high' | 'amount-low' | 'balance-high'

const STATE_PILLS: Record<RegisterRow['state'], { label: string; className: string }> = {
  paid: { label: 'Paid', className: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  partial: { label: 'Partial', className: 'bg-amber-50 text-amber-700 border-amber-200' },
  unpaid: { label: 'Unpaid', className: 'bg-rose-50 text-rose-700 border-rose-200' },
}

export default function AnalyticsPurchasePage() {
  const ws = useAnalyticsWorkspace()
  const { fold, period, isPeriodEmpty } = ws
  const pulsing = useSkeletonDelay(ws.fyLoading || ws.fold.isLoading)

  // Register controls (search / supplier / status / sort).
  const [searchQuery, setSearchQuery] = useState('')
  const [supplierFilter, setSupplierFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('')
  const [sortKey, setSortKey] = useState<SortKey>('newest')

  const view = useMemo(() => {
    if (!fold.data) return null
    const data = fold.data

    const metrics = purchasesMetrics(data.purchases, period)
    const trend = purchaseTrend(data.purchases, period)

    // Item names per bill (the SAME purchase → inventory relationship the
    // Purchase Register Excel export renders).
    const namesPerPurchase = new Map<string, string[]>()
    for (const item of data.purchaseItems) {
      const inv = item.inventory_items
      const name = inv ? `${inv.brand ?? ''} ${inv.model ?? ''}`.trim() : ''
      if (!name) continue
      const list = namesPerPurchase.get(item.purchase_id) ?? []
      list.push(name)
      namesPerPurchase.set(item.purchase_id, list)
    }

    const register: RegisterRow[] = realPurchasesInRange(data.purchases, period)
      .map((p: AnalyticsPurchaseRow) => {
        const paid = num(p.paid)
        const balance = num(p.due)
        return {
          id: p.id,
          date: p.date.slice(0, 10),
          billNumber: p.bill_number,
          supplier: p.party_name ?? '—',
          itemName: (namesPerPurchase.get(p.id) ?? []).join(', ') || '—',
          total: num(p.total),
          paid,
          balance,
          state: (balance <= 0 ? 'paid' : paid > 0 ? 'partial' : 'unpaid') as RegisterRow['state'],
        }
      })
      .sort((a, b) => (a.date !== b.date ? (a.date < b.date ? 1 : -1) : b.billNumber.localeCompare(a.billNumber)))

    return { metrics, trend, register }
  }, [fold.data, period])

  // The register's working set: search + supplier + status filters applied
  // to the SAME qualifying rows the summary cards and trend cover.
  const filtered = useMemo(() => {
    if (!view) return []
    const q = searchQuery.trim().toLowerCase()
    const rows = view.register.filter((r) => {
      if (supplierFilter && r.supplier !== supplierFilter) return false
      if (statusFilter && r.state !== statusFilter) return false
      if (q) {
        const haystack = `${r.billNumber} ${r.supplier} ${r.itemName}`.toLowerCase()
        if (!haystack.includes(q)) return false
      }
      return true
    })
    const sorted = [...rows]
    switch (sortKey) {
      case 'oldest':
        sorted.sort((a, b) => (a.date !== b.date ? (a.date < b.date ? -1 : 1) : a.billNumber.localeCompare(b.billNumber)))
        break
      case 'amount-high':
        sorted.sort((a, b) => b.total - a.total || a.billNumber.localeCompare(b.billNumber))
        break
      case 'amount-low':
        sorted.sort((a, b) => a.total - b.total || a.billNumber.localeCompare(b.billNumber))
        break
      case 'balance-high':
        sorted.sort((a, b) => b.balance - a.balance || a.billNumber.localeCompare(b.billNumber))
        break
      default:
        break // 'newest' — the register's natural order
    }
    return sorted
  }, [view, searchQuery, supplierFilter, statusFilter, sortKey])

  const suppliers = useMemo(() => {
    if (!view) return []
    return [...new Set(view.register.map((r) => r.supplier))].filter((s) => s !== '—').sort((a, b) => a.localeCompare(b))
  }, [view])

  if (ws.fyLoading || (fold.isLoading && !fold.data)) return <AnalyticsSkeleton pulsing={pulsing} />
  if (fold.isError) return <AnalyticsError onRetry={() => fold.refetch()} />
  if (!view) return <AnalyticsSkeleton pulsing={false} />

  const { metrics, trend } = view

  const columns: Array<DataTableColumn<RegisterRow>> = [
    {
      id: 'bill',
      header: 'Purchase Bill No.',
      width: 'w-[15%]',
      render: (r) => (
        <Link
          to={`/purchases/${r.id}`}
          className="text-xs font-medium text-indigo-600 hover:text-indigo-800 transition-colors tabular-nums"
          title="Open the purchase detail"
        >
          {r.billNumber}
        </Link>
      ),
      mobile: 'identity',
    },
    {
      id: 'date',
      header: 'Date',
      width: 'w-[9%]',
      render: (r) => <span className="text-xs text-slate-500 tabular-nums">{r.date}</span>,
      mobile: 'meta',
    },
    {
      id: 'supplier',
      header: 'Supplier',
      width: 'w-[16%]',
      render: (r) => <span className="text-xs font-medium text-slate-700">{r.supplier}</span>,
      mobile: 'secondary',
    },
    {
      id: 'items',
      header: 'Items',
      width: 'w-[26%]',
      render: (r) => (
        <span className="text-xs text-slate-700 leading-snug block truncate" title={r.itemName}>
          {r.itemName}
        </span>
      ),
      mobile: 'secondary',
    },
    {
      id: 'total',
      header: 'Total Amount',
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
      width: 'w-[11%]',
      render: (r) => <span className="text-xs text-emerald-700 tabular-nums">{money(r.paid)}</span>,
      mobile: 'amount',
      mobileLabel: 'Paid',
    },
    {
      id: 'balance',
      header: 'Balance',
      align: 'right',
      width: 'w-[11%]',
      render: (r) => (
        <span className={cn('text-xs tabular-nums', r.balance > 0 ? 'text-rose-600 font-semibold' : 'text-slate-400')}>
          {money(r.balance)}
        </span>
      ),
      mobile: 'amount',
      mobileLabel: 'Balance',
    },
    {
      id: 'state',
      header: 'Status',
      align: 'center',
      width: 'w-[9%]',
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

  const registerTotal = filtered.reduce((a, r) => a + r.total, 0)
  const registerPaid = filtered.reduce((a, r) => a + r.paid, 0)
  const registerBalance = filtered.reduce((a, r) => a + r.balance, 0)
  const filteredActive = searchQuery.trim() !== '' || supplierFilter !== '' || statusFilter !== ''

  return (
    <div className="space-y-5">
      {isPeriodEmpty && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-[11px] text-amber-800">
          The selected period has no dates inside this financial year — switch the period or the financial year.
        </div>
      )}

      {/* ── Summary cards ─────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <KpiCard
          label="Purchase Value"
          value={metrics.totalPurchases}
          icon={ShoppingCart}
          iconBg="bg-violet-50 text-violet-500"
          caption="supplier bills dated in period"
          secondary={metrics.billCount}
          secondaryLabel="bills"
          secondaryFormat="count"
        />
        <KpiCard
          label="Paid"
          value={metrics.paidPurchases}
          icon={CheckCircle2}
          iconBg="bg-emerald-50 text-emerald-500"
          caption="already paid on these bills"
        />
        <KpiCard
          label="Outstanding"
          value={metrics.outstandingPurchases}
          icon={Clock}
          iconBg="bg-amber-50 text-amber-500"
          caption="still owed on these bills"
        />
      </div>

      {/* ── The ONE purchase trend ────────────────────────────────────────── */}
      <SectionCard
        title="Purchase Trend"
        icon={History}
        meta={trend.length > 12 ? 'by day, in period' : 'by month, in period'}
        className="lg:col-span-3"
      >
        <TrendChart
          points={trend.map((t) => t.label)}
          series={[{ key: 'purchases', label: 'Purchases', color: SERIES.purchases, values: trend.map((t) => t.value) }]}
          ariaLabel="Qualifying purchase value over time"
          emptyMessage="No qualifying supplier purchases in this period."
        />
      </SectionCard>

      {/* ── Purchase Register ─────────────────────────────────────────────── */}
      <div className="space-y-3">
        <div className="flex items-center gap-1.5 px-1">
          <Package className="w-3 h-3 text-slate-400 shrink-0" />
          <span className="text-[10px] font-bold tracking-[0.1em] uppercase text-slate-400">Purchase Register</span>
          <span className="ml-auto text-[10px] text-slate-400">
            {count(filtered.length)} {filtered.length === 1 ? 'bill' : 'bills'} · {money(registerTotal)}
          </span>
        </div>

        <DataTable
          columns={columns}
          rows={filtered}
          rowKey={(r) => r.id}
          loading={false}
          minWidth="min-w-[900px]"
          emptyMessage={
            filteredActive
              ? 'No bills match the current search and filters.'
              : 'No qualifying supplier purchase bills in this period. Record a purchase to see it here.'
          }
          toolbar={
            <div className="flex flex-wrap items-center gap-2">
              <TableSearchInput
                value={searchQuery}
                onChange={setSearchQuery}
                placeholder="Search bill no., supplier or item…"
              />
              <Select
                size="sm"
                value={supplierFilter}
                onChange={setSupplierFilter}
                placeholder="All suppliers"
                options={[
                  { value: '', label: 'All suppliers' },
                  ...suppliers.map((s) => ({ value: s, label: s })),
                ]}
                className="w-40"
              />
              <Select
                size="sm"
                value={statusFilter}
                onChange={(v) => setStatusFilter(v as StatusFilter)}
                placeholder="All statuses"
                options={[
                  { value: '', label: 'All statuses' },
                  { value: 'paid', label: 'Paid' },
                  { value: 'partial', label: 'Partial' },
                  { value: 'unpaid', label: 'Unpaid' },
                ]}
                className="w-32"
              />
              <Select
                size="sm"
                value={sortKey}
                onChange={(v) => setSortKey(v as SortKey)}
                options={[
                  { value: 'newest', label: 'Newest first' },
                  { value: 'oldest', label: 'Oldest first' },
                  { value: 'amount-high', label: 'Largest amount' },
                  { value: 'amount-low', label: 'Smallest amount' },
                  { value: 'balance-high', label: 'Largest balance' },
                ]}
                className="w-36"
              />
            </div>
          }
          footer={
            <div className="px-4 py-3 border-t border-slate-100 flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-400">
              <span>
                Cancelled bills and internal trade-in acquisition and recovery bills are excluded (
                {count(metrics.virtualBillCount)} internal acquisition{' '}
                {metrics.virtualBillCount === 1 ? 'record' : 'records'} in this period).
              </span>
              <span className="tabular-nums">
                Total {money(registerTotal)} · Paid {money(registerPaid)} · Balance {money(registerBalance)}
              </span>
            </div>
          }
        />
      </div>
    </div>
  )
}
