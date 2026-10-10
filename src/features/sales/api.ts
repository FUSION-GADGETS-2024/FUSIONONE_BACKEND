import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/platform/supabase/client'
import type { FinancialYear } from '@/features/types'

// ── Query keys ──────────────────────────────────────────────────────────────

export const salesKeys = {
  page: (fyId: string) => ['sales-page', fyId] as const,
  detail: (saleId: string) => ['sale-detail', saleId] as const,
}

// ── Types ───────────────────────────────────────────────────────────────────

export interface SaleRow {
  id: string
  bill_number: string
  date: string
  financial_year_id: string
  party_id: string
  parties?: { name: string | null; number: string | null } | null
  total: number
  discount: number
  trade_in_credit: number
  final_total: number
  paid: number
  due: number
  bank_account_id: string
  status: 'active' | 'cancelled'
  /** The proforma this sale was converted from (null for direct sales). */
  proforma_id?: string | null
}

/**
 * A trade-in as the domain models it: the TRANSACTIONAL relationship
 * (credit, quoted MRP) plus the received device, whose physical identity
 * lives in Inventory — the single source of truth. Documents are NOT part
 * of trade-ins; they belong exclusively to parties.
 */
export interface SaleTradeIn {
  id: string
  inventory_item_id: string
  credit_value: number
  mrp: number | null
  inventory_items?: {
    id: string
    brand: string | null
    model: string | null
    imei: string | null
    ram_rom: string | null
    color: string | null
    status: 'in_stock' | 'sold'
  } | null
}

export interface SaleDetail {
  sale: (SaleRow & { parties?: { name: string | null; number: string | null; address: string | null } | null }) | null
  items: Array<{
    id: string
    sold_price: number
    inventory_item_id: string
    inventory_items?: {
      brand: string | null
      model: string | null
      imei: string | null
      ram_rom: string | null
      color: string | null
      base_selling_price: number | null
    } | null
  }>
  tradeIns: SaleTradeIn[]
  store: Record<string, unknown> | null
}

// ── Page data (sales list) ──────────────────────────────────────────────────

export function useSalesPageData(selectedYear: FinancialYear | null, fyLoading: boolean) {
  return useQuery({
    queryKey: salesKeys.page(selectedYear?.id ?? ''),
    enabled: !fyLoading && !!selectedYear,
    queryFn: async () => {
      if (!selectedYear) return [] as SaleRow[]
      const { data, error } = await supabase
        .from('sales')
        .select('*, parties (name, number)')
        .eq('financial_year_id', selectedYear.id)
        .order('date', { ascending: false })
      if (error) throw error
      return (data ?? []) as SaleRow[]
    },
  })
}

// ── Sale detail (the ONE implementation — fixes audit D5/D6) ────────────────

export async function fetchSaleDetail(saleId: string): Promise<SaleDetail> {
  const [
    { data: saleData, error: saleErr },
    { data: siData, error: siErr },
    { data: tiData, error: tiErr },
    { data: storeData, error: storeErr },
  ] = await Promise.all([
    supabase
      .from('sales')
      .select('*, parties (name, number, address)')
      .eq('id', saleId)
      .maybeSingle(),
    supabase
      .from('sale_items')
      .select(
        'id, sold_price, inventory_item_id, inventory_items (brand, model, imei, ram_rom, color, base_selling_price)',
      )
      .eq('sale_id', saleId),
    supabase
      .from('trade_ins')
      .select(
        'id, inventory_item_id, credit_value, mrp, inventory_items (id, brand, model, imei, ram_rom, color, status)',
      )
      .eq('sale_id', saleId),
    supabase.from('store').select('*').maybeSingle(),
  ])
  if (saleErr) throw saleErr
  if (siErr) throw siErr
  if (tiErr) throw tiErr
  if (storeErr) throw storeErr
  return {
    sale: (saleData as unknown as SaleDetail['sale']) ?? null,
    items: (siData ?? []) as unknown as SaleDetail['items'],
    tradeIns: (tiData ?? []) as unknown as SaleDetail['tradeIns'],
    store: storeData ?? null,
  }
}

/** Cached sale detail — consumed by the detail page, edit page, the sales
 *  list's lazy ⋮ loading, and the invoice builders. */
export function useSaleDetail(saleId: string | null, enabled = true) {
  return useQuery({
    queryKey: salesKeys.detail(saleId ?? ''),
    enabled: !!saleId && enabled,
    queryFn: () => fetchSaleDetail(saleId!),
  })
}
