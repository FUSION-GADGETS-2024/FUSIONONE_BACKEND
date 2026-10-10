import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/platform/supabase/client'
import { useDebouncedValue } from '@/components/ui/use-debounced-value'

/**
 * The ONE canonical inventory search — a ranked, server-side RPC
 * (public.search_inventory, migration 0012) with deterministic tiered
 * relevance (exact > prefix > token > contiguous > fuzzy), space
 * normalization and domain awareness (brand/model/IMEI/RAM-ROM/color).
 *
 * Every stock picker in the app (sale editor, proforma editor, conversion
 * dialog, inventory page) consumes THIS hook — there is no second search
 * implementation. The browser never downloads the inventory table to
 * filter it locally.
 */

/** One ranked search result row (the RPC's return shape). */
export interface InventorySearchRow {
  id: string
  brand: string
  model: string
  imei: string
  ram_rom: string | null
  color: string | null
  purchase_price: number
  base_selling_price: number
  status: 'in_stock' | 'sold'
  created_at: string
  rank: number
}

export const inventorySearchKeys = {
  /** Prefix for centralized invalidation (inventory changed → searches refresh). */
  all: ['inventory-search'] as const,
  search: (fyId: string, status: string, query: string) =>
    ['inventory-search', fyId, status, query] as const,
}

export interface UseInventorySearchOptions {
  /** Financial year scope (required — search is FY-scoped like every list). */
  fyId?: string
  /** 'in_stock' (default), 'sold', or null for all statuses. */
  status?: 'in_stock' | 'sold' | null
  /** Result cap (default 10 — a comfortable picker dropdown). */
  limit?: number
  /** Rows to hide from the results (e.g. devices already added to the
   *  document). Filtered client-side so the cache stays stable while the
   *  selection changes. */
  excludeIds?: string[]
  /** Fetch gate (default: enabled while the query has content). */
  enabled?: boolean
}

export function useInventorySearch(rawQuery: string, opts: UseInventorySearchOptions = {}) {
  const { fyId, status = 'in_stock', limit = 10, excludeIds, enabled } = opts
  // Debounce keystrokes — one database round trip per pause, not per letter.
  const query = useDebouncedValue(rawQuery.trim(), 250)
  const hasQuery = query !== ''
  const isEnabled = (enabled ?? true) && !!fyId && hasQuery

  const queryResult = useQuery({
    queryKey: inventorySearchKeys.search(fyId ?? '', status ?? 'all', query),
    enabled: isEnabled,
    staleTime: 30_000,
    placeholderData: previous => previous,   // typing never flickers
    queryFn: async (): Promise<InventorySearchRow[]> => {
      const { data, error } = await supabase.rpc('search_inventory', {
        p_query: query,
        p_financial_year_id: fyId!,
        p_status: status,
        p_limit: limit,
        p_offset: 0,
        p_exclude_ids: [],
      })
      if (error) throw error
      return (data ?? []) as InventorySearchRow[]
    },
  })

  // Exclusions apply client-side AFTER the (cached) ranked fetch.
  const excluded = new Set(excludeIds ?? [])
  const rows = (queryResult.data ?? []).filter(r => !excluded.has(r.id))

  return {
    ...queryResult,
    /** True while a NON-EMPTY query is fetching (and no results yet for it). */
    isSearching: isEnabled && queryResult.isFetching && rows.length === 0,
    rows,
  }
}
