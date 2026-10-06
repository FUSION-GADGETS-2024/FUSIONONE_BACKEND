import React, { createContext, useContext, useMemo, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/platform/supabase/client'
import type { FinancialYear } from '@/features/types'

interface FinancialYearContextType {
  financialYears: FinancialYear[]
  selectedYear: FinancialYear | null
  setSelectedYearId: (id: string) => void
  isReadOnly: boolean
  isLoading: boolean
  refresh: () => Promise<void>
}

const FinancialYearContext = createContext<FinancialYearContextType>({
  financialYears: [],
  selectedYear: null,
  setSelectedYearId: () => {},
  isReadOnly: true,
  isLoading: true,
  refresh: async () => {},
})

export const useFinancialYear = () => useContext(FinancialYearContext)

/**
 * Financial-year context — now built on the SHARED cached queries (fixes
 * audit D2/D18: the store row and FY list are fetched once per app session
 * instead of once per provider mount + once per Sidebar mount).
 *
 * Behavior preserved from the reference implementation:
 *   - FY list ordered by start_date DESC.
 *   - Working-year selection is in-memory per session (NOT persisted);
 *     initial selection = store.active_financial_year_id, falling back to
 *     the first active year, then the first year.
 *   - A selected id that no longer exists clears the selection.
 *   - refresh() re-fetches both the store row and the FY list.
 */
export function FinancialYearProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient()

  // Shared store query — ALSO consumed by Sidebar, settings, detail pages.
  const storeQuery = useQuery({
    queryKey: ['store', 'current'],
    queryFn: async () => {
      const { data, error } = await supabase.from('store').select('*').maybeSingle()
      if (error) throw error
      return data
    },
    staleTime: 60 * 1000,
  })

  const fyQuery = useQuery({
    queryKey: ['financial-years'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('financial_years')
        .select('id, start_date, end_date, status')
        .order('start_date', { ascending: false })
      if (error) throw error
      return (data ?? []) as FinancialYear[]
    },
    staleTime: 60 * 1000,
  })

  // In-memory working-year selection (per session — reload resets to the
  // store default, exactly like the reference app).
  const selectedYearIdRef = useRef<string | null>(null)
  const [, forceRender] = React.useReducer((x: number) => x + 1, 0)

  const years = fyQuery.data ?? []
  const storeActiveFyId = (storeQuery.data as { active_financial_year_id?: string } | null)
    ?.active_financial_year_id ?? null

  // Resolve the effective selection (reference logic, verbatim). The
  // reference app awaited the store row and the FY list together
  // (Promise.all) before this decision; with two independent queries the
  // store must still have SETTLED first — otherwise the "first active FY"
  // fallback can fire while the store row is still loading and, when
  // several active FYs exist (shared TEST project), pick ANOTHER store's
  // year for the working selection.
  if (!selectedYearIdRef.current && (storeQuery.isSuccess || storeQuery.isError)) {
    if (storeActiveFyId) {
      selectedYearIdRef.current = storeActiveFyId
    } else if (years.length > 0) {
      const activeYear = years.find((y) => y.status === 'active')
      selectedYearIdRef.current = activeYear ? activeYear.id : years[0].id
    }
  }
  const matched = years.find((y) => y.id === selectedYearIdRef.current)
  if (selectedYearIdRef.current && !matched) {
    selectedYearIdRef.current = null
  }

  const setSelectedYearId = (id: string) => {
    selectedYearIdRef.current = id
    forceRender()
  }

  const selectedYear = matched ?? null
  const isLoading = storeQuery.isLoading || fyQuery.isLoading

  const value = useMemo<FinancialYearContextType>(
    () => ({
      financialYears: years,
      selectedYear,
      setSelectedYearId,
      isReadOnly: selectedYear?.status === 'closed',
      isLoading,
      refresh: async () => {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['store', 'current'] }),
          queryClient.invalidateQueries({ queryKey: ['financial-years'] }),
        ])
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [years, selectedYear, isLoading, queryClient],
  )

  return <FinancialYearContext.Provider value={value}>{children}</FinancialYearContext.Provider>
}
