/**
 * The Analytics fold — the ONE FY-scoped dataset query.
 *
 * Every Analytics page, the dashboard, the notice detectors (via the shared
 * timeline) and the Excel reports derive from this single cached fold, so
 * there is exactly ONE business-data read path and ONE calculation layer
 * (metrics.ts) on top of it. The fold is a strict superset of the old
 * dashboard fold, which now derives from it (see features/dashboard/api.ts).
 *
 * Query conventions follow the app's established patterns exactly:
 *   - one query key factory (`['analytics', …]`), invalidated semantically
 *     by every business mutation through features/invalidate.ts,
 *   - FY-scoped `.eq('financial_year_id', …)` projections with `enabled`
 *     gating on the financial-year provider,
 *   - child rows embedded through their parent (sales → sale_items /
 *     trade_ins; purchases → purchase_items) so the fetch is bounded by the
 *     FY's own documents,
 *   - to-one embeds normalized defensively (the established firstOrNull
 *     pattern; PostgREST may deliver them as one-element arrays).
 */
import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/platform/supabase/client'
import type { FinancialYear } from '@/features/types'
import type {
  AnalyticsAccountTransactionRow,
  AnalyticsFold,
  AnalyticsInventoryRow,
  AnalyticsPaymentInRow,
  AnalyticsPaymentOutRow,
  AnalyticsPurchaseItemRow,
  AnalyticsPurchaseRow,
  AnalyticsSaleItemRow,
  AnalyticsSaleRow,
  AnalyticsTradeInRow,
  InventoryTimelineRow,
} from './types'
import { isVirtualAcquisition } from './metrics'

// ── Keys ─────────────────────────────────────────────────────────────────────

export const analyticsKeys = {
  /** Root prefix — the semantic invalidation target for business mutations. */
  all: ['analytics'] as const,
  fold: (fyId: string) => ['analytics', 'fold', fyId] as const,
  /** FY-independent acquisition timeline (the origin-chain lookup). */
  timeline: ['analytics', 'inventory-timeline'] as const,
}

// ── Embed normalization ──────────────────────────────────────────────────────

/** PostgREST to-one FK embeds may arrive as one-element arrays — normalize. */
function firstOrNull<T>(value: T[] | T | null | undefined): T | null {
  if (Array.isArray(value)) return (value[0] as T | undefined) ?? null
  return (value as T | null | undefined) ?? null
}

// ── Projections ──────────────────────────────────────────────────────────────

const SALE_ITEM_PROJECTION =
  'sale_id, sold_price, inventory_items (id, brand, model, imei, ram_rom, color, base_selling_price, purchase_price, status, source)'
const TRADE_IN_PROJECTION =
  'id, sale_id, inventory_item_id, credit_value, mrp, inventory_items (id, brand, model, imei, status, source)'
const PAYMENT_IN_PROJECTION =
  'id, sale_id, party_id, amount, date, created_at, bank_account_id, payment_mode_id, parties (name), sales (bill_number), bank_accounts (name, is_cash), payment_modes (name)'
const PAYMENT_OUT_PROJECTION =
  'id, purchase_id, party_id, amount, date, created_at, bank_account_id, payment_mode_id, parties (name), purchases (bill_number), bank_accounts (name, is_cash), payment_modes (name)'

// ── The fold fetch ───────────────────────────────────────────────────────────

/** Loads the FY-scoped analytics dataset (the fold query function). */
export async function fetchAnalyticsFold(fyId: string): Promise<Omit<AnalyticsFold, 'timeline'>> {
  const [salesRes, purchasesRes, paymentsInRes, paymentsOutRes, ledgerRes, inventoryRes, proformasRes, accountsRes, modesRes, partiesRes] =
    await Promise.all([
      supabase
        .from('sales')
        .select(
          `id, bill_number, date, party_id, total, discount, trade_in_credit, final_total, paid, due, status, created_at, proforma_id,
           parties (name),
           sale_items (${SALE_ITEM_PROJECTION}),
           trade_ins (${TRADE_IN_PROJECTION})`,
        )
        .eq('financial_year_id', fyId)
        .order('date', { ascending: true })
        .order('bill_number', { ascending: true }),
      supabase
        .from('purchases')
        .select(
          `id, bill_number, date, party_id, total, paid, due, status, created_at,
           parties (name),
           purchase_items (purchase_id, inventory_items (id, brand, model, imei, ram_rom, color, purchase_price, source))`,
        )
        .eq('financial_year_id', fyId)
        .order('date', { ascending: true })
        .order('bill_number', { ascending: true }),
      supabase.from('payments_in').select(PAYMENT_IN_PROJECTION).eq('financial_year_id', fyId).order('date', { ascending: true }),
      supabase.from('payments_out').select(PAYMENT_OUT_PROJECTION).eq('financial_year_id', fyId).order('date', { ascending: true }),
      supabase
        .from('account_transactions')
        .select('id, bank_account_id, payment_mode_id, type, amount, date, reference_type, reference_id, notes, transfer_group_id, created_at')
        .eq('financial_year_id', fyId)
        .order('date', { ascending: true })
        .order('created_at', { ascending: true }),
      supabase.from('inventory_items')
        .select('id, brand, model, imei, ram_rom, color, purchase_price, base_selling_price, status, source, created_at, origin_inventory_item_id, opening_entry_type')
        .eq('financial_year_id', fyId)
        .order('created_at', { ascending: true }),
      supabase
        .from('proforma_invoices')
        .select('id, bill_number, date, status, final_total, party_id, parties (name)')
        .eq('financial_year_id', fyId)
        .order('date', { ascending: true }),
      supabase.from('bank_accounts').select('id, name, is_cash').order('name', { ascending: true }),
      supabase.from('payment_modes').select('id, name, bank_account_id').order('name', { ascending: true }),
      supabase.from('parties').select('id, name, number').order('name', { ascending: true }),
    ])

  const errors = [salesRes.error, purchasesRes.error, paymentsInRes.error, paymentsOutRes.error, ledgerRes.error, inventoryRes.error, proformasRes.error, accountsRes.error, modesRes.error, partiesRes.error].filter(Boolean)
  if (errors.length > 0) throw errors[0]

  // ── Flatten the parent-embedded child collections ────────────────────────
  const sales: AnalyticsSaleRow[] = []
  const saleItems: AnalyticsSaleItemRow[] = []
  const tradeIns: AnalyticsTradeInRow[] = []
  for (const row of (salesRes.data ?? []) as Array<Record<string, unknown>>) {
    sales.push({
      id: row.id as string,
      bill_number: row.bill_number as string,
      date: row.date as string,
      party_id: row.party_id as string,
      party_name: firstOrNull(row.parties as { name: string | null } | null)?.name ?? null,
      total: row.total as number | string,
      discount: row.discount as number | string,
      trade_in_credit: row.trade_in_credit as number | string,
      final_total: row.final_total as number | string,
      paid: row.paid as number | string,
      due: row.due as number | string,
      status: row.status as 'active' | 'cancelled',
      created_at: row.created_at as string,
      proforma_id: (row.proforma_id as string | null) ?? null,
    })
    for (const item of ((row.sale_items as Array<Record<string, unknown>>) ?? [])) {
      saleItems.push({
        sale_id: item.sale_id as string,
        sold_price: item.sold_price as number | string,
        inventory_items: firstOrNull(item.inventory_items as AnalyticsSaleItemRow['inventory_items']),
      })
    }
    for (const ti of ((row.trade_ins as Array<Record<string, unknown>>) ?? [])) {
      tradeIns.push({
        id: ti.id as string,
        sale_id: ti.sale_id as string,
        inventory_item_id: ti.inventory_item_id as string,
        credit_value: ti.credit_value as number | string,
        mrp: (ti.mrp as number | string | null) ?? null,
        inventory_items: firstOrNull(ti.inventory_items as AnalyticsTradeInRow['inventory_items']),
      })
    }
  }

  const purchases: AnalyticsPurchaseRow[] = []
  const purchaseItems: AnalyticsPurchaseItemRow[] = []
  for (const row of (purchasesRes.data ?? []) as Array<Record<string, unknown>>) {
    const items = ((row.purchase_items as Array<Record<string, unknown>>) ?? []).map((pi) => ({
      purchase_id: pi.purchase_id as string,
      inventory_items: firstOrNull(pi.inventory_items as AnalyticsPurchaseItemRow['inventory_items']),
    }))
    purchaseItems.push(...items)
    purchases.push({
      id: row.id as string,
      bill_number: row.bill_number as string,
      date: row.date as string,
      party_id: row.party_id as string,
      party_name: firstOrNull(row.parties as { name: string | null } | null)?.name ?? null,
      total: row.total as number | string,
      paid: row.paid as number | string,
      due: row.due as number | string,
      status: row.status as 'active' | 'cancelled',
      created_at: row.created_at as string,
      is_virtual: isVirtualAcquisition(row.bill_number as string, items),
    })
  }

  const paymentsIn: AnalyticsPaymentInRow[] = ((paymentsInRes.data ?? []) as Array<Record<string, unknown>>).map((p) => ({
    id: p.id as string,
    sale_id: (p.sale_id as string | null) ?? null,
    party_id: p.party_id as string,
    party_name: firstOrNull(p.parties as { name: string | null } | null)?.name ?? null,
    amount: p.amount as number | string,
    date: p.date as string,
    created_at: p.created_at as string,
    bank_account_id: p.bank_account_id as string,
    payment_mode_id: (p.payment_mode_id as string | null) ?? null,
    sale_bill_number: firstOrNull(p.sales as { bill_number: string } | null)?.bill_number ?? null,
    bank_name: firstOrNull(p.bank_accounts as { name: string } | null)?.name ?? null,
    bank_is_cash: firstOrNull(p.bank_accounts as { is_cash: boolean } | null)?.is_cash ?? null,
    mode_name: firstOrNull(p.payment_modes as { name: string } | null)?.name ?? null,
  }))

  const paymentsOut: AnalyticsPaymentOutRow[] = ((paymentsOutRes.data ?? []) as Array<Record<string, unknown>>).map((p) => ({
    id: p.id as string,
    purchase_id: (p.purchase_id as string | null) ?? null,
    party_id: p.party_id as string,
    party_name: firstOrNull(p.parties as { name: string | null } | null)?.name ?? null,
    amount: p.amount as number | string,
    date: p.date as string,
    created_at: p.created_at as string,
    bank_account_id: p.bank_account_id as string,
    payment_mode_id: (p.payment_mode_id as string | null) ?? null,
    purchase_bill_number: firstOrNull(p.purchases as { bill_number: string } | null)?.bill_number ?? null,
    bank_name: firstOrNull(p.bank_accounts as { name: string } | null)?.name ?? null,
    bank_is_cash: firstOrNull(p.bank_accounts as { is_cash: boolean } | null)?.is_cash ?? null,
    mode_name: firstOrNull(p.payment_modes as { name: string } | null)?.name ?? null,
  }))

  const accountTransactions: AnalyticsAccountTransactionRow[] = ((ledgerRes.data ?? []) as Array<Record<string, unknown>>).map((t) => ({
    id: t.id as string,
    bank_account_id: t.bank_account_id as string,
    payment_mode_id: (t.payment_mode_id as string | null) ?? null,
    type: t.type as 'credit' | 'debit',
    amount: t.amount as number | string,
    date: t.date as string,
    reference_type: t.reference_type as AnalyticsAccountTransactionRow['reference_type'],
    reference_id: t.reference_id as string,
    notes: (t.notes as string | null) ?? null,
    transfer_group_id: (t.transfer_group_id as string | null) ?? null,
    created_at: t.created_at as string,
  }))

  const inventory: AnalyticsInventoryRow[] = (inventoryRes.data ?? []) as AnalyticsInventoryRow[]
  const proformas = ((proformasRes.data ?? []) as Array<Record<string, unknown>>).map((p) => ({
    id: p.id as string,
    bill_number: p.bill_number as string,
    date: p.date as string,
    status: p.status as 'active' | 'converted' | 'void',
    final_total: p.final_total as number | string,
    party_id: p.party_id as string,
    party_name: firstOrNull(p.parties as { name: string | null } | null)?.name ?? null,
  }))

  return {
    fyId,
    sales,
    purchases,
    saleItems,
    purchaseItems,
    paymentsIn,
    paymentsOut,
    accountTransactions,
    inventory,
    tradeIns,
    proformas,
    bankAccounts: (accountsRes.data ?? []) as AnalyticsFold['bankAccounts'],
    paymentModes: (modesRes.data ?? []) as AnalyticsFold['paymentModes'],
    parties: (partiesRes.data ?? []) as AnalyticsFold['parties'],
  }
}

// ── The acquisition timeline (shared with notices) ───────────────────────────

/** Loads the FY-independent acquisition timeline (all inventory rows). */
export async function fetchInventoryTimeline(): Promise<InventoryTimelineRow[]> {
  const { data, error } = await supabase
    .from('inventory_items')
    .select('id, created_at, origin_inventory_item_id')
    .order('created_at', { ascending: true })
  if (error) throw error
  return (data ?? []) as InventoryTimelineRow[]
}

/** The shared timeline query — consumed by the fold AND the notice system. */
export function useInventoryTimeline() {
  return useQuery({
    queryKey: analyticsKeys.timeline,
    queryFn: fetchInventoryTimeline,
  })
}

// ── The fold hook ────────────────────────────────────────────────────────────

export interface UseAnalyticsFoldResult {
  data: AnalyticsFold | undefined
  /** First load (no cached fold for this FY yet). */
  isLoading: boolean
  isFetching: boolean
  isError: boolean
  error: unknown
  refetch: () => void
}

/**
 * The ONE analytics dataset hook — FY-scoped fold + acquisition timeline,
 * combined. Period filtering NEVER re-fetches: it happens in the pure
 * metric layer (metrics.ts), so switching presets is instant and every
 * surface stays consistent by construction.
 */
export function useAnalyticsFold(
  selectedYear: FinancialYear | null,
  fyLoading: boolean,
): UseAnalyticsFoldResult {
  const foldQuery = useQuery({
    queryKey: analyticsKeys.fold(selectedYear?.id ?? ''),
    enabled: !fyLoading && !!selectedYear,
    queryFn: () => fetchAnalyticsFold(selectedYear!.id),
  })
  const timelineQuery = useInventoryTimeline()

  const data =
    foldQuery.data && timelineQuery.data
      ? ({ ...foldQuery.data, timeline: timelineQuery.data } satisfies AnalyticsFold)
      : undefined

  return {
    data,
    isLoading:
      (foldQuery.isLoading && !foldQuery.data) || (timelineQuery.isLoading && !timelineQuery.data),
    isFetching: foldQuery.isFetching || timelineQuery.isFetching,
    isError: foldQuery.isError || timelineQuery.isError,
    error: foldQuery.error ?? timelineQuery.error,
    refetch: () => {
      void foldQuery.refetch()
      void timelineQuery.refetch()
    },
  }
}
