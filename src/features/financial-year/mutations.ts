/**
 * Financial-year mutations.
 *
 * create/setActive stay as direct writes (single-table operations).
 * closeFinancialYear runs as ONE transactional RPC reproducing the page's
 * copy-based carry-forward semantics (audit D12: the old dead domain
 * function with row-MOVE semantics is intentionally NOT resurrected).
 */
import { supabase } from '@/platform/supabase/client'
import type { FinancialYear } from '@/features/types'

export async function createFinancialYear(
  startDate: string,
  endDate: string,
  existingYears: FinancialYear[],
): Promise<void> {
  if (!startDate || !endDate) throw new Error('Both dates required')
  if (new Date(startDate) >= new Date(endDate)) throw new Error('Start must be before end')

  const hasOverlap = existingYears.some(
    (fy) => new Date(startDate) <= new Date(fy.end_date) && new Date(endDate) >= new Date(fy.start_date),
  )
  if (hasOverlap) throw new Error('Date range overlaps with an existing year')

  const { error } = await supabase
    .from('financial_years')
    .insert({ start_date: startDate, end_date: endDate, status: 'active' })
  if (error) {
    if (error.message.includes('fy_no_overlap') || error.code === 'EXCLUSION_VIOLATION')
      throw new Error('Range overlaps with an existing year')
    throw error
  }
}

export async function setActiveFinancialYear(fyId: string, storeId: string): Promise<void> {
  // Explicitly scoped to THE store row (singleton) — never an unfiltered
  // update. RLS makes this write owner-only; the UI hides the action for
  // non-owners.
  const { error } = await supabase
    .from('store')
    .update({ active_financial_year_id: fyId })
    .eq('id', storeId)
  if (error) throw error
}

export interface CloseFinancialYearResult {
  items_carried: number
  accounts_carried: number
}

/** Close + carry forward — the page's exact semantics, transactional. */
export async function closeFinancialYear(fy: FinancialYear): Promise<CloseFinancialYearResult> {
  if (fy.status === 'closed') return { items_carried: 0, accounts_carried: 0 }
  const { data, error } = await supabase.rpc('close_financial_year', { p_fy_id: fy.id })
  if (error) throw error
  return data as CloseFinancialYearResult
}
