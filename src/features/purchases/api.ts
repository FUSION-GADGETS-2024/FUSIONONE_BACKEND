import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/platform/supabase/client'
import type { FinancialYear } from '@/features/types'

export const purchaseKeys = {
  page: (fyId: string) => ['purchases-page', fyId] as const,
  detail: (purchaseId: string) => ['purchase-detail', purchaseId] as const,
}

export interface PurchaseRow {
  id: string
  bill_number: string
  date: string
  financial_year_id: string
  party_id: string
  parties?: { name: string | null; number: string | null } | null
  total: number
  paid: number
  due: number
  bank_account_id: string
  status: 'active' | 'cancelled'
}

export interface PurchaseDetail {
  purchase: (PurchaseRow & { parties?: { name: string | null; number: string | null; address: string | null } | null }) | null
  items: Array<{
    id: string
    inventory_items?: {
      brand: string | null
      model: string | null
      imei: string | null
      ram_rom: string | null
      color: string | null
      purchase_price: number | null
    } | null
  }>
  store: Record<string, unknown> | null
}

export function usePurchasesPageData(selectedYear: FinancialYear | null, fyLoading: boolean) {
  return useQuery({
    queryKey: purchaseKeys.page(selectedYear?.id ?? ''),
    enabled: !fyLoading && !!selectedYear,
    queryFn: async () => {
      if (!selectedYear) return [] as PurchaseRow[]
      const { data, error } = await supabase
        .from('purchases')
        .select('*, parties (name, number)')
        .eq('financial_year_id', selectedYear.id)
        .order('date', { ascending: false })
      if (error) throw error
      return (data ?? []) as PurchaseRow[]
    },
  })
}

export async function fetchPurchaseDetail(purchaseId: string): Promise<PurchaseDetail> {
  const [
    { data: pData, error: pErr },
    { data: itemsData, error: itemsErr },
    { data: storeData, error: storeErr },
  ] = await Promise.all([
    supabase.from('purchases').select('*, parties (name, number, address)').eq('id', purchaseId).maybeSingle(),
    supabase
      .from('purchase_items')
      .select('id, inventory_items (brand, model, imei, ram_rom, color, purchase_price)')
      .eq('purchase_id', purchaseId),
    supabase.from('store').select('*').maybeSingle(),
  ])
  if (pErr) throw pErr
  if (itemsErr) throw itemsErr
  if (storeErr) throw storeErr
  return {
    purchase: (pData as unknown as PurchaseDetail['purchase']) ?? null,
    items: (itemsData ?? []) as unknown as PurchaseDetail['items'],
    store: storeData ?? null,
  }
}

export function usePurchaseDetail(purchaseId: string | null) {
  return useQuery({
    queryKey: purchaseKeys.detail(purchaseId ?? ''),
    enabled: !!purchaseId,
    queryFn: () => fetchPurchaseDetail(purchaseId!),
  })
}
