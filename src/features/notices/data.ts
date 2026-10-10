/**
 * The notices loader — minimal cross-FY projections for attention detection.
 *
 * Financial attention (an unpaid invoice, a pending payable) does not stop
 * at a financial-year boundary, so the detectors read across ALL financial
 * years. The scopes are deliberately narrow:
 *
 *   - sales / purchases: ACTIVE documents only (cancelled documents never
 *     demand attention — cancellation is itself the resolution),
 *   - current stock: in-stock items of the STORE's active financial year
 *     (carry-forward COPIES rows into the next FY while leaving the old
 *     rows in_stock, so "all FYs" would double-count stock),
 *   - proformas: only unconverted drafts ('active' status),
 *   - message jobs: only FAILED ones (delivery attention).
 *
 * Business semantics stay in the shared layer (analytics/metrics.ts); this
 * file only fetches. Cached under ['notices', …] and refreshed through the
 * semantic invalidation helpers on every business mutation.
 */
import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/platform/supabase/client'

// ── Keys ─────────────────────────────────────────────────────────────────────

export const noticesKeys = {
  all: ['notices'] as const,
  /** The detector dataset for a given current-stock FY scope. */
  data: (activeFyId: string) => ['notices', 'data', activeFyId] as const,
}

// ── Row shapes ───────────────────────────────────────────────────────────────

export interface NoticeSaleRow {
  id: string
  bill_number: string
  date: string
  due: number | string
  status: 'active' | 'cancelled'
  party_id: string
  party_name: string | null
}

export interface NoticePurchaseRow {
  id: string
  bill_number: string
  date: string
  due: number | string
  status: 'active' | 'cancelled'
  party_id: string
  party_name: string | null
}

export interface NoticeStockRow {
  id: string
  brand: string
  model: string
  imei: string
  source: 'purchase' | 'trade_in'
  status: 'in_stock' | 'sold'
  created_at: string
  origin_inventory_item_id: string | null
  purchase_price: number | string
}

export interface NoticeProformaRow {
  id: string
  bill_number: string
  date: string
  status: 'active' | 'converted' | 'void'
  final_total: number | string
  party_id: string
  party_name: string | null
}

export interface NoticeJobRow {
  id: string
  job_type: string
  status: string
  run_at: string
  attempts: number
  last_error: string | null
  sales: { bill_number: string } | null
  purchases: { bill_number: string } | null
  proforma_invoices: { bill_number: string } | null
}

export interface NoticesData {
  sales: NoticeSaleRow[]
  purchases: NoticePurchaseRow[]
  stock: NoticeStockRow[]
  proformas: NoticeProformaRow[]
  failedJobs: NoticeJobRow[]
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** PostgREST to-one FK embeds may arrive as one-element arrays — normalize. */
function firstOrNull<T>(value: T[] | T | null | undefined): T | null {
  if (Array.isArray(value)) return (value[0] as T | undefined) ?? null
  return (value as T | null | undefined) ?? null
}

// ── The loader ───────────────────────────────────────────────────────────────

/** Loads the cross-FY notice detector dataset (current stock scoped to the FY). */
export async function fetchNoticesData(activeFyId: string): Promise<NoticesData> {
  const [salesRes, purchasesRes, stockRes, proformasRes, jobsRes] = await Promise.all([
    supabase
      .from('sales')
      .select('id, bill_number, date, due, status, party_id, parties (name)')
      .eq('status', 'active')
      .order('date', { ascending: true }),
    supabase
      .from('purchases')
      .select('id, bill_number, date, due, status, party_id, parties (name)')
      .eq('status', 'active')
      .order('date', { ascending: true }),
    supabase
      .from('inventory_items')
      .select('id, brand, model, imei, source, status, created_at, origin_inventory_item_id, purchase_price')
      .eq('financial_year_id', activeFyId)
      .eq('status', 'in_stock')
      .order('created_at', { ascending: true }),
    supabase
      .from('proforma_invoices')
      .select('id, bill_number, date, status, final_total, party_id, parties (name)')
      .eq('status', 'active')
      .order('date', { ascending: true }),
    supabase
      .from('message_jobs')
      .select('id, job_type, status, run_at, attempts, last_error, sales (bill_number), purchases (bill_number), proforma_invoices (bill_number)')
      .eq('status', 'failed')
      .order('run_at', { ascending: true })
      .limit(50),
  ])

  const errors = [salesRes.error, purchasesRes.error, stockRes.error, proformasRes.error, jobsRes.error].filter(Boolean)
  if (errors.length > 0) throw errors[0]

  const partyName = (v: unknown) => firstOrNull(v as { name: string | null } | null)?.name ?? null

  return {
    sales: ((salesRes.data ?? []) as Array<Record<string, unknown>>).map((s) => ({
      id: s.id as string,
      bill_number: s.bill_number as string,
      date: s.date as string,
      due: s.due as number | string,
      status: s.status as 'active' | 'cancelled',
      party_id: s.party_id as string,
      party_name: partyName(s.parties),
    })),
    purchases: ((purchasesRes.data ?? []) as Array<Record<string, unknown>>).map((p) => ({
      id: p.id as string,
      bill_number: p.bill_number as string,
      date: p.date as string,
      due: p.due as number | string,
      status: p.status as 'active' | 'cancelled',
      party_id: p.party_id as string,
      party_name: partyName(p.parties),
    })),
    stock: (stockRes.data ?? []) as NoticeStockRow[],
    proformas: ((proformasRes.data ?? []) as Array<Record<string, unknown>>).map((p) => ({
      id: p.id as string,
      bill_number: p.bill_number as string,
      date: p.date as string,
      status: p.status as 'active' | 'converted' | 'void',
      final_total: p.final_total as number | string,
      party_id: p.party_id as string,
      party_name: partyName(p.parties),
    })),
    failedJobs: ((jobsRes.data ?? []) as Array<Record<string, unknown>>).map((j) => ({
      id: j.id as string,
      job_type: j.job_type as string,
      status: j.status as string,
      run_at: j.run_at as string,
      attempts: j.attempts as number,
      last_error: j.last_error as string | null,
      sales: firstOrNull(j.sales as { bill_number: string } | null),
      purchases: firstOrNull(j.purchases as { bill_number: string } | null),
      proforma_invoices: firstOrNull(j.proforma_invoices as { bill_number: string } | null),
    })),
  }
}

/** The notices dataset query (scoped to the store's active FY for stock). */
export function useNoticesData(activeFyId: string | null) {
  return useQuery({
    queryKey: noticesKeys.data(activeFyId ?? ''),
    enabled: !!activeFyId,
    queryFn: () => fetchNoticesData(activeFyId!),
    staleTime: 30 * 1000,
  })
}
