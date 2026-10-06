import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/platform/supabase/client'
import type { Store } from '@/features/types'

/**
 * The single cached store query — replaces the 8 scattered store fetches of
 * the reference app (audit D2). Everyone (Sidebar, FY provider, settings,
 * detail pages, invoice loader) consumes this one query.
 *
 * The database guarantees at most ONE store row (singleton constraint), so
 * maybeSingle is exact — no .limit(1) safety net anywhere.
 */
export function useStore() {
  return useQuery({
    queryKey: ['store', 'current'],
    queryFn: async (): Promise<Store | null> => {
      const { data, error } = await supabase.from('store').select('*').maybeSingle()
      if (error) throw error
      return (data as Store | null) ?? null
    },
    staleTime: 60 * 1000,
  })
}
