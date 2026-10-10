/**
 * Notice detection — the pure detector fold.
 *
 * Every detector derives from the SAME business semantics the Analytics
 * layer uses (spec §28: analytics + notices share one truth):
 *   - overdue rules reuse `daysBetween`/`dateOnly` and the stored-due
 *     balance semantics (active documents, business dates),
 *   - inventory age uses the SAME acquisition-chain rule as the Analytics
 *     inventory ageing (`inventoryAge` from analytics/metrics),
 *   - receivable/payable aggregates use the SAME `receivablesTotal` /
 *     `payablesTotal` folds.
 *
 * Input data comes from the notices loader (features/notices/data.ts —
 * cross-FY minimal projections), the WhatsApp platform context, and the
 * financial-year provider; `today` is always passed in for purity.
 */
import type { FinancialYear } from '@/features/types'
import { daysBetween, inventoryAge, payablesTotal, receivablesTotal } from '@/features/analytics/metrics'
import { dateOnly, todayStr, fyLabel } from '@/features/analytics/period'
import type { InventoryTimelineRow } from '@/features/analytics/types'
import { formatMoney } from '@/features/validation/fields'
import type {
  Notice,
  NoticeCategory,
  NoticeSeverity,
} from './types'
import { NOTICE_THRESHOLDS, CATEGORY_ORDER, SEVERITY_ORDER } from './types'
import type {
  NoticesData,
  NoticeJobRow,
  NoticeProformaRow,
  NoticePurchaseRow,
  NoticeSaleRow,
  NoticeStockRow,
} from './data'

/** The WhatsApp status slice detectors need. */
export interface WhatsAppStatusSlice {
  state: string
  session: string | null
  connected: boolean
}

export interface NoticeDetectorInput {
  data: NoticesData
  timeline: ReadonlyMap<string, InventoryTimelineRow>
  financialYears: ReadonlyArray<Pick<FinancialYear, 'id' | 'start_date' | 'end_date' | 'status'>>
  whatsapp: WhatsAppStatusSlice | null
  today?: string
}

const rs = (n: number) => `${formatMoney(n)} Rs.`

// ── Individual detectors ─────────────────────────────────────────────────────

function overdueReceivables(sales: ReadonlyArray<NoticeSaleRow>, today: string): Notice[] {
  const out: Notice[] = []
  for (const s of sales) {
    const due = Number(s.due)
    if (s.status !== 'active' || due <= 0) continue
    const age = daysBetween(dateOnly(s.date), today)
    if (age < NOTICE_THRESHOLDS.overdueDays) continue
    const critical = age >= NOTICE_THRESHOLDS.criticalOverdueDays
    out.push({
      id: `overdue-receivable:${s.id}`,
      type: 'overdue-receivable',
      category: 'financial',
      severity: critical ? 'critical' : 'warning',
      title: critical ? 'Overdue Receivable (90+ days)' : 'Overdue Receivable',
      message: `${s.bill_number} (${s.party_name ?? 'customer'}) — ${rs(due)} outstanding for ${age} days.`,
      amount: due,
      date: dateOnly(s.date),
      action: { label: 'View invoice', to: `/sales/${s.id}` },
    })
  }
  return out
}

function overduePayables(purchases: ReadonlyArray<NoticePurchaseRow>, today: string): Notice[] {
  const out: Notice[] = []
  for (const p of purchases) {
    const due = Number(p.due)
    if (p.status !== 'active' || due <= 0) continue
    const age = daysBetween(dateOnly(p.date), today)
    if (age < NOTICE_THRESHOLDS.overdueDays) continue
    const critical = age >= NOTICE_THRESHOLDS.criticalOverdueDays
    out.push({
      id: `overdue-payable:${p.id}`,
      type: 'overdue-payable',
      category: 'financial',
      severity: critical ? 'critical' : 'warning',
      title: critical ? 'Overdue Payable (90+ days)' : 'Overdue Payable',
      message: `${p.bill_number} (${p.party_name ?? 'supplier'}) — ${rs(due)} pending for ${age} days.`,
      amount: due,
      date: dateOnly(p.date),
      action: { label: 'View bill', to: `/purchases/${p.id}` },
    })
  }
  return out
}

function receivableSummary(sales: ReadonlyArray<NoticeSaleRow>): Notice[] {
  const total = receivablesTotal(sales)
  if (total <= 0) return []
  const parties = new Set(sales.filter((s) => s.status === 'active' && Number(s.due) > 0).map((s) => s.party_id)).size
  return [
    {
      id: 'receivables-outstanding:all',
      type: 'receivables-outstanding',
      category: 'financial',
      severity: 'info',
      title: 'Outstanding Receivables',
      message: `${rs(total)} pending from customers across ${parties} ${parties === 1 ? 'party' : 'parties'}.`,
      amount: total,
      action: { label: 'Open Money analytics', to: '/analytics/money' },
    },
  ]
}

function payableSummary(purchases: ReadonlyArray<NoticePurchaseRow>): Notice[] {
  const total = payablesTotal(purchases)
  if (total <= 0) return []
  return [
    {
      id: 'payables-outstanding:all',
      type: 'payables-outstanding',
      category: 'financial',
      severity: 'info',
      title: 'Pending Payables',
      message: `${rs(total)} pending to suppliers.`,
      amount: total,
      action: { label: 'Open Money analytics', to: '/analytics/money' },
    },
  ]
}

function oldInventory(
  stock: ReadonlyArray<NoticeStockRow>,
  timeline: ReadonlyMap<string, InventoryTimelineRow>,
  today: string,
): Notice[] {
  const out: Notice[] = []
  for (const item of stock) {
    if (item.status !== 'in_stock' || item.source !== 'purchase') continue
    const age = inventoryAge(item, timeline, today)
    if (age < NOTICE_THRESHOLDS.oldInventoryDays) continue
    out.push({
      id: `old-inventory:${item.id}`,
      type: 'old-inventory',
      category: 'inventory',
      severity: 'warning',
      title: 'Old Inventory (90+ days)',
      message: `${item.brand} ${item.model} (IMEI ${item.imei}) — in stock for ${age} days.`,
      amount: Number(item.purchase_price),
      date: dateOnly(item.created_at),
      action: { label: 'View inventory', to: '/inventory' },
    })
  }
  return out
}

function agingTradeInStock(
  stock: ReadonlyArray<NoticeStockRow>,
  timeline: ReadonlyMap<string, InventoryTimelineRow>,
  today: string,
): Notice[] {
  const out: Notice[] = []
  for (const item of stock) {
    if (item.status !== 'in_stock' || item.source !== 'trade_in') continue
    const age = inventoryAge(item, timeline, today)
    if (age < NOTICE_THRESHOLDS.tradeInAgingDays) continue
    out.push({
      id: `aging-trade-in-stock:${item.id}`,
      type: 'aging-trade-in-stock',
      category: 'inventory',
      severity: 'warning',
      title: 'Aging Trade-In Stock (60+ days)',
      message: `${item.brand} ${item.model} (IMEI ${item.imei}) — received on trade-in, unsold for ${age} days.`,
      amount: Number(item.purchase_price),
      date: dateOnly(item.created_at),
      action: { label: 'View inventory', to: '/inventory' },
    })
  }
  return out
}

function zeroStock(stock: ReadonlyArray<NoticeStockRow>): Notice[] {
  if (stock.length > 0) return []
  return [
    {
      id: 'zero-stock:all',
      type: 'zero-stock',
      category: 'inventory',
      severity: 'warning',
      title: 'Zero Stock',
      message: 'No items are in stock. Add stock to keep selling.',
      action: { label: 'Add stock', to: '/purchases/new' },
    },
  ]
}

function endedFinancialYears(
  fys: ReadonlyArray<Pick<FinancialYear, 'id' | 'start_date' | 'end_date' | 'status'>>,
  today: string,
): Notice[] {
  const out: Notice[] = []
  for (const fy of fys) {
    if (fy.status !== 'active') continue
    if (dateOnly(fy.end_date) >= today) continue
    out.push({
      id: `fy-ended:${fy.id}`,
      type: 'fy-ended',
      category: 'financial-year',
      severity: 'warning',
      title: 'Financial Year Ended',
      message: `${fyLabel(fy)} ended on ${dateOnly(fy.end_date)}. Close it to carry forward stock and balances.`,
      date: dateOnly(fy.end_date),
      action: { label: 'Manage financial years', to: '/financial-year' },
    })
  }
  return out
}

function oldProformas(proformas: ReadonlyArray<NoticeProformaRow>, today: string): Notice[] {
  const out: Notice[] = []
  for (const p of proformas) {
    if (p.status !== 'active') continue
    const age = daysBetween(dateOnly(p.date), today)
    if (age < NOTICE_THRESHOLDS.oldProformaDays) continue
    out.push({
      id: `old-proforma:${p.id}`,
      type: 'old-proforma',
      category: 'workflow',
      severity: 'warning',
      title: 'Old Proforma',
      message: `${p.bill_number} (${p.party_name ?? 'customer'}) — quoted ${rs(Number(p.final_total))} ${age} days ago and still unconverted.`,
      amount: Number(p.final_total),
      date: dateOnly(p.date),
      action: { label: 'View proforma', to: `/proformas/${p.id}` },
    })
  }
  return out
}

function whatsappNotConnected(whatsapp: WhatsAppStatusSlice | null): Notice[] {
  if (!whatsapp) return []
  // In-progress states (connecting / pairing / reconnecting / restoring)
  // are not attention conditions; an auto-wakeable idle session is fine.
  if (['connected', 'connecting', 'pairing', 'reconnecting', 'restoring', 'idle'].includes(whatsapp.state)) return []
  if (whatsapp.state === 'error') {
    return [
      {
        id: 'whatsapp-not-connected:global',
        type: 'whatsapp-not-connected',
        category: 'whatsapp',
        severity: 'critical',
        title: 'WhatsApp Session Invalid',
        message: 'The WhatsApp session failed a security check and was signed out. Re-pair to restore invoice delivery.',
        action: { label: 'Open WhatsApp settings', to: '/settings#whatsapp' },
      },
    ]
  }
  return [
    {
      id: 'whatsapp-not-connected:global',
      type: 'whatsapp-not-connected',
      category: 'whatsapp',
      severity: 'warning',
      title: 'WhatsApp Not Connected',
      message: 'WhatsApp is not paired. Invoice and receipt delivery will fail until it is connected.',
      action: { label: 'Connect WhatsApp', to: '/settings#whatsapp' },
    },
  ]
}

const JOB_TYPE_LABELS: Record<string, string> = {
  invoice_send: 'Invoice',
  reminder: 'Payment Reminder',
  receipt: 'Payment Receipt',
  statement: 'Payment Statement',
}

function failedMessageJobs(jobs: ReadonlyArray<NoticeJobRow>): Notice[] {
  const out: Notice[] = []
  for (const job of jobs) {
    if (job.status !== 'failed') continue
    const target = job.sales?.bill_number ?? job.purchases?.bill_number ?? job.proforma_invoices?.bill_number ?? null
    const label = JOB_TYPE_LABELS[job.job_type] ?? 'Message'
    out.push({
      id: `message-job-failed:${job.id}`,
      type: 'message-job-failed',
      category: 'whatsapp',
      severity: 'warning',
      title: `${label} Delivery Failed`,
      message: target
        ? `${label} for ${target} could not be delivered after ${job.attempts} attempts.`
        : `${label} could not be delivered after ${job.attempts} attempts.`,
      date: job.run_at ? dateOnly(job.run_at) : undefined,
      action: { label: 'Open Messages', to: '/messages' },
    })
  }
  return out
}

// ── The fold ─────────────────────────────────────────────────────────────────

/**
 * Builds the full notice set from the detector inputs. Deduplicates by
 * deterministic identity (last-write-wins on identical ids, which cannot
 * occur across detectors because types differ) and sorts by severity, then
 * business area, then id — a stable, reproducible order.
 */
export function buildNotices(input: NoticeDetectorInput): Notice[] {
  const today = input.today ?? todayStr()
  const all: Notice[] = [
    ...overdueReceivables(input.data.sales, today),
    ...overduePayables(input.data.purchases, today),
    ...receivableSummary(input.data.sales),
    ...payableSummary(input.data.purchases),
    ...oldInventory(input.data.stock, input.timeline, today),
    ...agingTradeInStock(input.data.stock, input.timeline, today),
    ...zeroStock(input.data.stock),
    ...endedFinancialYears(input.financialYears, today),
    ...oldProformas(input.data.proformas, today),
    ...whatsappNotConnected(input.whatsapp),
    ...failedMessageJobs(input.data.failedJobs),
  ]

  const byId = new Map<string, Notice>()
  for (const notice of all) byId.set(notice.id, notice)

  return [...byId.values()].sort((a, b) => {
    const sev = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
    if (sev !== 0) return sev
    const cat = CATEGORY_ORDER[a.category] - CATEGORY_ORDER[b.category]
    if (cat !== 0) return cat
    return a.id.localeCompare(b.id)
  })
}

/** Count of notices at or above a severity level. */
export function countAtLeast(notices: ReadonlyArray<Notice>, level: NoticeSeverity): number {
  return notices.filter((n) => SEVERITY_ORDER[n.severity] <= SEVERITY_ORDER[level]).length
}

export type { Notice, NoticeCategory, NoticeSeverity }
