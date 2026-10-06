import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/platform/supabase/client'
import type { FinancialYear } from '@/features/types'

export const proformaKeys = {
  page: (fyId: string) => ['proformas-page', fyId] as const,
  detail: (id: string) => ['proforma-detail', id] as const,
}

export interface ProformaRow {
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
  status: 'active' | 'converted' | 'void'
}

/** A quoted line: either a REAL in-stock Inventory Item quoted at a
 *  snapshot price, or a legacy free-text line (historical truth). */
export interface ProformaItemRow {
  id: string
  description: string | null
  qty: number
  rate: number
  discount: number
  value: number
  inventory_item_id: string | null
  inventory_items?: {
    id: string
    brand: string | null
    model: string | null
    imei: string | null
    ram_rom: string | null
    color: string | null
    base_selling_price: number | null
    status: 'in_stock' | 'sold'
  } | null
}

export interface ProformaDetail {
  proforma: (ProformaRow & { parties?: { id?: string; name: string | null; number: string | null; address: string | null } | null }) | null
  items: ProformaItemRow[]
  tradeIns: Array<{
    id: string
    description: string
    qty: number | null
    rate: number
    value: number
  }>
  store: Record<string, unknown> | null
}

export function useProformasPageData(selectedYear: FinancialYear | null, fyLoading: boolean) {
  return useQuery({
    queryKey: proformaKeys.page(selectedYear?.id ?? ''),
    enabled: !fyLoading && !!selectedYear,
    queryFn: async () => {
      if (!selectedYear) return [] as ProformaRow[]
      const { data, error } = await supabase
        .from('proforma_invoices')
        .select('*, parties (name, number)')
        .eq('financial_year_id', selectedYear.id)
        .order('date', { ascending: false })
      if (error) throw error
      return (data ?? []) as ProformaRow[]
    },
  })
}

export async function fetchProformaDetail(id: string): Promise<ProformaDetail> {
  // All four fetches are independent — parallel (fixes audit D15: the old
  // page fetched trade-ins sequentially after the first three).
  const [
    { data: pData, error: pErr },
    { data: itemsData, error: itemsErr },
    { data: tiData, error: tiErr },
    { data: storeData, error: storeErr },
  ] = await Promise.all([
    supabase.from('proforma_invoices').select('*, parties (id, name, number, address)').eq('id', id).maybeSingle(),
    supabase
      .from('proforma_invoice_items')
      .select(
        'id, description, qty, rate, discount, value, inventory_item_id, ' +
          'inventory_items (id, brand, model, imei, ram_rom, color, base_selling_price, status)',
      )
      .eq('proforma_invoice_id', id),
    supabase.from('proforma_trade_ins').select('id, description, qty, rate, value').eq('proforma_invoice_id', id),
    supabase.from('store').select('*').maybeSingle(),
  ])
  if (pErr) throw pErr
  if (itemsErr) throw itemsErr
  if (tiErr) throw tiErr
  if (storeErr) throw storeErr
  return {
    proforma: (pData as unknown as ProformaDetail['proforma']) ?? null,
    items: (itemsData ?? []) as unknown as ProformaDetail['items'],
    tradeIns: (tiData ?? []) as unknown as ProformaDetail['tradeIns'],
    store: storeData ?? null,
  }
}

export function useProformaDetail(id: string | null) {
  return useQuery({
    queryKey: proformaKeys.detail(id ?? ''),
    enabled: !!id,
    queryFn: () => fetchProformaDetail(id!),
  })
}
