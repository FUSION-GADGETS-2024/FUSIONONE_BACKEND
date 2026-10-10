'use client';

/**
 * ANALYTICS — MONEY
 *
 * "Where is money coming from, where is it going, and what remains due?" —
 * payment flows for the period (by month and by the actual supported
 * payment modes), net movement, and the CURRENT balances: receivables with
 * ageing (by sale business date), outstanding customers, payables, and the
 * payment register. Balances are point-in-time (the FY's active documents)
 * — flows and balances are labelled distinctly, never conflated.
 */
import { useMemo } from 'react'
import { Link } from 'react-router'
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  ArrowLeftRight,
  Wallet,
  Landmark,
  History,
  Users,
} from 'lucide-react'
import { useAnalyticsWorkspace } from '@/features/analytics/workspace'
import {
  moneyMetrics,
  monthlyTrend,
  outstandingCustomers,
  payablesTotal,
  paymentMethodBreakdown,
  receivablesAgeing,
  receivablesTotal,
  num,
  dateInRange,
  daysBetween,
} from '@/features/analytics/metrics'
import { dateOnly, monthLabel, formatDateLabel } from '@/features/analytics/period'
import { KpiCard, SectionCard, AnalyticsSkeleton, AnalyticsError } from '@/components/analytics/KpiCard'
import { TrendChart, AgeingBars, SERIES } from '@/components/analytics/charts'
import { money, count } from '@/components/analytics/format'
import { DataTable, CellLines, type DataTableColumn } from '@/components/ui/tables'
import { useSkeletonDelay } from '@/components/ui/Skeleton'
import { cn } from '@/components/ui/utils'

interface PaymentRegisterRow {
  id: string
  date: string
  direction: 'in' | 'out'
  party: string
  document: string
  method: string
  account: string
  amount: number
}

interface OutstandingRow {
  key: string
  partyId: string
  name: string
  due: number
  invoiceCount: number
  oldest: string
  ageDays: number
}

export default function AnalyticsMoneyPage() {
  const ws = useAnalyticsWorkspace()
  const { fold, period, today, isPeriodEmpty } = ws
  const pulsing = useSkeletonDelay(ws.fyLoading || ws.fold.isLoading)

  const view = useMemo(() => {
    if (!fold.data) return null
    const data = fold.data
    const flows = moneyMetrics(data.paymentsIn, data.paymentsOut, period)
    const trend = monthlyTrend(data.sales, data.purchases, data.paymentsIn, data.paymentsOut, period)
    const methods = paymentMethodBreakdown(data.paymentsIn, data.paymentsOut, period)
    const ageing = receivablesAgeing(data.sales, today)
    const outstanding = outstandingCustomers(data.sales)
    const receivables = receivablesTotal(data.sales)
    const payables = payablesTotal(data.purchases)

    const register: PaymentRegisterRow[] = [
      ...data.paymentsIn
        .filter((p) => dateInRange(p.date, period))
        .map((p) => ({
          id: `in-${p.id}`,
          date: p.date.slice(0, 10),
          direction: 'in' as const,
          party: p.party_name ?? '—',
          document: p.sale_bill_number ?? 'Unlinked',
          method: p.mode_name ?? (p.bank_is_cash === true ? 'Cash' : p.bank_name ?? '—'),
          account: p.bank_name ?? '—',
          amount: num(p.amount),
        })),
      ...data.paymentsOut
        .filter((p) => dateInRange(p.date, period))
        .map((p) => ({
          id: `out-${p.id}`,
          date: p.date.slice(0, 10),
          direction: 'out' as const,
          party: p.party_name ?? '—',
          document: p.purchase_bill_number ?? 'Unlinked',
          method: p.mode_name ?? (p.bank_is_cash === true ? 'Cash' : p.bank_name ?? '—'),
          account: p.bank_name ?? '—',
          amount: num(p.amount),
        })),
    ].sort((a, b) => (a.date !== b.date ? (a.date < b.date ? 1 : -1) : a.id.localeCompare(b.id)))

    const outstandingRows: OutstandingRow[] = outstanding.map((c) => ({
      key: c.partyId,
      partyId: c.partyId,
      name: c.name,
      due: c.due,
      invoiceCount: c.invoiceCount,
      oldest: c.oldestDate ?? '',
      ageDays: c.oldestDate ? daysBetween(c.oldestDate, today) : 0,
    }))

    const outstandingPurchases = data.purchases
      .filter((p) => p.status === 'active' && !p.is_virtual && num(p.due) > 0)
      .map((p) => ({
        key: p.id,
        billNumber: p.bill_number,
        party: p.party_name ?? '—',
        due: num(p.due),
        date: dateOnly(p.date),
        ageDays: daysBetween(dateOnly(p.date), today),
      }))
      .sort((a, b) => b.ageDays - a.ageDays)

    return { flows, trend, methods, ageing, outstandingRows, outstandingPurchases, receivables, payables, register }
  }, [fold.data, period, today])

  if (ws.fyLoading || (fold.isLoading && !fold.data)) return <AnalyticsSkeleton pulsing={pulsing} />
  if (fold.isError) return <AnalyticsError onRetry={() => fold.refetch()} />
  if (!view) return <AnalyticsSkeleton pulsing={false} />

  const { flows, trend, methods, ageing, outstandingRows, outstandingPurchases, receivables, payables, register } = view

  const paymentColumns: Array<DataTableColumn<PaymentRegisterRow>> = [
    {
      id: 'date',
      header: 'Date',
      width: 'w-[10%]',
      render: (r) => <span className="text-xs text-slate-500 tabular-nums">{r.date}</span>,
      mobile: 'meta',
    },
    {
      id: 'direction',
      header: 'Direction',
      width: 'w-[10%]',
      render: (r) => (
        <span
          className={cn(
            'inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider border leading-4',
            r.direction === 'in'
              ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
              : 'bg-rose-50 text-rose-600 border-rose-200',
          )}
        >
          {r.direction === 'in' ? 'In' : 'Out'}
        </span>
      ),
      mobile: 'meta',
    },
    {
      id: 'party',
      header: 'Party',
      width: 'w-[22%]',
      render: (r) => <CellLines primary={r.party} secondary={r.document} />,
      mobile: 'identity',
    },
    {
      id: 'method',
      header: 'Method',
      width: 'w-[16%]',
      render: (r) => <CellLines primary={r.method} secondary={r.account} />,
      mobile: 'secondary',
    },
    {
      id: 'amount',
      header: 'Amount',
      align: 'right',
      width: 'w-[16%]',
      render: (r) => (
        <span className={cn('text-xs font-semibold tabular-nums', r.direction === 'in' ? 'text-emerald-700' : 'text-rose-600')}>
          {r.direction === 'in' ? '+' : '−'}
          {money(r.amount)}
        </span>
      ),
      mobile: 'amount',
      mobileLabel: 'Amount',
    },
  ]

  const outstandingColumns: Array<DataTableColumn<OutstandingRow>> = [
    {
      id: 'customer',
      header: 'Customer',
      width: 'w-[34%]',
      render: (r) => (
        <Link to={`/parties/${r.partyId}`} className="text-xs font-medium text-indigo-600 hover:text-indigo-800 transition-colors">
          {r.name}
        </Link>
      ),
      mobile: 'identity',
    },
    {
      id: 'invoices',
      header: 'Invoices',
      align: 'right',
      width: 'w-[14%]',
      render: (r) => <span className="text-xs text-slate-500 tabular-nums">{count(r.invoiceCount)}</span>,
    },
    {
      id: 'oldest',
      header: 'Oldest Invoice',
      width: 'w-[22%]',
      render: (r) => (
        <CellLines primary={formatDateLabel(r.oldest)} secondary={`${count(r.ageDays)} ${r.ageDays === 1 ? 'day' : 'days'} old`} />
      ),
      mobile: 'secondary',
    },
    {
      id: 'due',
      header: 'Receivable',
      align: 'right',
      width: 'w-[18%]',
      render: (r) => <span className="text-xs font-semibold text-rose-600 tabular-nums">{money(r.due)}</span>,
      mobile: 'amount',
      mobileLabel: 'Due',
    },
  ]

  const payableColumns: Array<DataTableColumn<{ key: string; billNumber: string; party: string; due: number; date: string; ageDays: number }>> = [
    {
      id: 'bill',
      header: 'Bill',
      width: 'w-[24%]',
      render: (r) => (
        <Link to={`/purchases/${r.key}`} className="text-xs font-medium text-indigo-600 hover:text-indigo-800 transition-colors tabular-nums">
          {r.billNumber}
        </Link>
      ),
      mobile: 'identity',
    },
    {
      id: 'supplier',
      header: 'Supplier',
      width: 'w-[30%]',
      render: (r) => <span className="text-xs text-slate-700">{r.party}</span>,
      mobile: 'secondary',
    },
    {
      id: 'date',
      header: 'Date',
      width: 'w-[18%]',
      render: (r) => (
        <CellLines primary={r.date} secondary={`${count(r.ageDays)} ${r.ageDays === 1 ? 'day' : 'days'} old`} />
      ),
      mobile: 'meta',
    },
    {
      id: 'due',
      header: 'Payable',
      align: 'right',
      width: 'w-[18%]',
      render: (r) => <span className="text-xs font-semibold text-rose-600 tabular-nums">{money(r.due)}</span>,
      mobile: 'amount',
      mobileLabel: 'Due',
    },
  ]

  const methodTotal = methods.reduce((a, m) => a + m.moneyIn + m.moneyOut, 0)

  return (
    <div className="space-y-5">
      {isPeriodEmpty && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-[11px] text-amber-800">
          The selected period has no dates inside this financial year — switch the period or the financial year.
        </div>
      )}

      {/* ── KPIs ──────────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <KpiCard label="Money In" value={flows.moneyIn} icon={ArrowDownToLine} iconBg="bg-emerald-50 text-emerald-500" caption={`${count(flows.paymentsInCount)} payments in period`} />
        <KpiCard label="Money Out" value={flows.moneyOut} icon={ArrowUpFromLine} iconBg="bg-rose-50 text-rose-500" caption={`${count(flows.paymentsOutCount)} payments in period`} />
        <KpiCard label="Net Movement" value={flows.netMovement} icon={ArrowLeftRight} iconBg="bg-violet-50 text-violet-500" caption="in − out, in period" />
        <KpiCard label="Receivables" value={receivables} icon={Wallet} iconBg="bg-amber-50 text-amber-500" caption="outstanding now, this FY" />
        <KpiCard label="Payables" value={payables} icon={Landmark} iconBg="bg-rose-50 text-rose-500" caption="outstanding now, this FY" />
      </div>

      {/* ── Flow trend ─────────────────────────────────────────────────────── */}
      <SectionCard title="Money Flow" icon={History} meta="in vs out by month, in period">
        <TrendChart
          points={trend.map((t) => monthLabel(t.month))}
          series={[
            { key: 'in', label: 'Money In', color: SERIES.moneyIn, values: trend.map((t) => t.paymentsIn) },
            { key: 'out', label: 'Money Out', color: SERIES.moneyOut, values: trend.map((t) => t.paymentsOut) },
          ]}
          ariaLabel="Monthly money in and money out trend"
          emptyMessage="No payments recorded in this period."
        />
      </SectionCard>

      {/* ── Payment methods + receivables ageing ───────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <SectionCard title="Payment Methods" meta={`by supported modes, in period`}>
          {methods.length === 0 ? (
            <p className="text-xs text-slate-400 py-8 text-center">No payments in this period.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left min-w-[420px]">
                <thead className="bg-slate-50 border-b border-slate-100">
                  <tr>
                    <th className="px-3 py-2.5 text-[10px] font-bold uppercase tracking-[0.08em] text-slate-400">Mode</th>
                    <th className="px-3 py-2.5 text-[10px] font-bold uppercase tracking-[0.08em] text-slate-400 text-right">Money In</th>
                    <th className="px-3 py-2.5 text-[10px] font-bold uppercase tracking-[0.08em] text-slate-400 text-right">Money Out</th>
                    <th className="px-3 py-2.5 text-[10px] font-bold uppercase tracking-[0.08em] text-slate-400 text-right">Total</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {methods.map((m) => (
                    <tr key={m.label} className="hover:bg-slate-50/60 transition-colors">
                      <td className="px-3 py-2.5 text-xs font-medium text-slate-900">{m.label}</td>
                      <td className="px-3 py-2.5 text-xs text-emerald-700 tabular-nums text-right">{m.moneyIn > 0 ? money(m.moneyIn) : '—'}</td>
                      <td className="px-3 py-2.5 text-xs text-rose-600 tabular-nums text-right">{m.moneyOut > 0 ? money(m.moneyOut) : '—'}</td>
                      <td className="px-3 py-2.5 text-xs font-semibold text-slate-900 tabular-nums text-right">{money(m.moneyIn + m.moneyOut)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-slate-200">
                    <td className="px-3 py-2.5 text-[10px] font-bold uppercase tracking-wider text-slate-400">Total</td>
                    <td className="px-3 py-2.5 text-xs font-semibold text-emerald-700 tabular-nums text-right">{money(flows.moneyIn)}</td>
                    <td className="px-3 py-2.5 text-xs font-semibold text-rose-600 tabular-nums text-right">{money(flows.moneyOut)}</td>
                    <td className="px-3 py-2.5 text-xs font-semibold text-slate-900 tabular-nums text-right">{money(methodTotal)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </SectionCard>

        <SectionCard title="Receivables Ageing" meta="outstanding invoices by age, now">
          <AgeingBars
            buckets={ageing.map((b) => ({ label: b.label, count: b.count, amount: b.amount }))}
            ariaLabel="Receivables ageing buckets"
            color={SERIES.sales}
            emptyMessage="No outstanding receivables — every active invoice is settled."
          />
        </SectionCard>
      </div>

      {/* ── Outstanding customers ──────────────────────────────────────────── */}
      <div className="space-y-3">
        <div className="flex items-center gap-1.5 px-1">
          <Users className="w-3 h-3 text-slate-400 shrink-0" />
          <span className="text-[10px] font-bold tracking-[0.1em] uppercase text-slate-400">Outstanding Customers</span>
          <span className="ml-auto text-[10px] text-slate-400">
            {count(outstandingRows.length)} {outstandingRows.length === 1 ? 'customer' : 'customers'} · {money(receivables)}
          </span>
        </div>
        <DataTable
          columns={outstandingColumns}
          rows={outstandingRows}
          rowKey={(r) => r.key}
          emptyMessage="No outstanding receivables in this financial year."
        />
      </div>

      {/* ── Payables ───────────────────────────────────────────────────────── */}
      <div className="space-y-3">
        <div className="flex items-center gap-1.5 px-1">
          <Landmark className="w-3 h-3 text-slate-400 shrink-0" />
          <span className="text-[10px] font-bold tracking-[0.1em] uppercase text-slate-400">Payables</span>
          <span className="ml-auto text-[10px] text-slate-400">
            {count(outstandingPurchases.length)} {outstandingPurchases.length === 1 ? 'bill' : 'bills'} · {money(payables)}
          </span>
        </div>
        <DataTable
          columns={payableColumns}
          rows={outstandingPurchases}
          rowKey={(r) => r.key}
          emptyMessage="No outstanding payables in this financial year."
        />
      </div>

      {/* ── Payment register ───────────────────────────────────────────────── */}
      <div className="space-y-3">
        <div className="flex items-center gap-1.5 px-1">
          <History className="w-3 h-3 text-slate-400 shrink-0" />
          <span className="text-[10px] font-bold tracking-[0.1em] uppercase text-slate-400">Payment Register</span>
          <span className="ml-auto text-[10px] text-slate-400">
            {count(register.length)} {register.length === 1 ? 'payment' : 'payments'} · In {money(flows.moneyIn)} · Out {money(flows.moneyOut)}
          </span>
        </div>
        <DataTable
          columns={paymentColumns}
          rows={register}
          rowKey={(r) => r.id}
          minWidth="min-w-[760px]"
          emptyMessage="No payments in this period. Payments recorded from invoices appear here."
        />
      </div>
    </div>
  )
}
