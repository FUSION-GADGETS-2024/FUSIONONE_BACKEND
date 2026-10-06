import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/platform/supabase/client'
import type { FinancialYear } from '@/features/types'
import { parseMoney, validateImei, validateRamRom } from '@/features/validation/fields'

export interface InventoryItem {
  id: string
  brand: string
  model: string
  imei: string
  ram_rom: string
  color: string
  purchase_price: number
  base_selling_price: number
  status: 'in_stock' | 'sold'
  /** Absent on search-mapped rows (the search RPC does not return it). */
  source?: 'purchase' | 'trade_in'
  opening_entry_type?: 'direct' | 'carried_forward' | null
  origin_inventory_item_id?: string | null
  financial_year_id?: string
}

export const inventoryKeys = {
  page: (fyId: string) => ['inventory-page', fyId] as const,
}

export function useInventoryPageData(selectedYear: FinancialYear | null, fyLoading: boolean) {
  return useQuery({
    queryKey: inventoryKeys.page(selectedYear?.id ?? ''),
    enabled: !fyLoading && !!selectedYear,
    queryFn: async () => {
      if (!selectedYear) return [] as InventoryItem[]
      const { data, error } = await supabase
        .from('inventory_items')
        .select('*')
        .eq('financial_year_id', selectedYear.id)
        .order('created_at', { ascending: false })
      if (error) throw error
      return (data ?? []) as InventoryItem[]
    },
  })
}

/** The per-field error map for the inventory add/edit form (null = fine). */
export type InventoryFormErrors = {
  brand: string | null
  model: string | null
  imei: string | null
  ram_rom: string | null
  color: string | null
  purchase_price: string | null
  base_selling_price: string | null
}

/**
 * The ONE inventory form validator — per-field errors from the canonical
 * module (the same contracts the database enforces), for inline display
 * next to each field.
 */
export function validateInventoryForm(data: {
  brand: string
  model: string
  imei: string
  ram_rom: string
  color: string
  purchase_price: string
  base_selling_price: string
}): InventoryFormErrors {
  return {
    brand: data.brand.trim() ? null : 'Brand is required.',
    model: data.model.trim() ? null : 'Model is required.',
    imei: validateImei(data.imei),
    ram_rom: validateRamRom(data.ram_rom),
    color: data.color.trim() ? null : 'Color is required.',
    purchase_price: parseMoney(data.purchase_price) === null ? 'Enter a valid purchase price.' : null,
    base_selling_price: parseMoney(data.base_selling_price) === null ? 'Enter a valid selling price.' : null,
  }
}

/** True when every field of the inventory form error map is clean. */
export function isInventoryFormValid(errors: InventoryFormErrors): boolean {
  return Object.values(errors).every(e => e === null)
}
