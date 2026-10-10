'use client';

/**
 * The Analytics workspace context + composite hook.
 *
 * AnalyticsLayout (the workspace's one shell) owns the shared filter state
 * (the URL-encoded period model) and provides it through this context;
 * each of the five pages consumes the SAME filter + the SAME fold via
 * useAnalyticsWorkspace(), so Overview / Sales / Money / Inventory /
 * Reports are consistent by construction (spec §10: one normalized
 * filter/query model — no per-page filter implementations).
 */
import { createContext, useContext } from 'react'
import { useFinancialYear } from '@/components/providers/FinancialYearProvider'
import { useAnalyticsFold } from './fold'
import { resolvePeriod } from './period'
import type { AnalyticsPeriod, PeriodPreset } from './types'
import type { UseAnalyticsFoldResult } from './fold'
import type { FinancialYear } from '@/features/types'

export interface AnalyticsFilterContextValue {
  /** The resolved, FY-clamped period (authoritative from/to). */
  period: AnalyticsPeriod
  preset: PeriodPreset
  setPreset: (preset: PeriodPreset) => void
  setCustomRange: (from: string, to: string) => void
}

export const AnalyticsFilterContext = createContext<AnalyticsFilterContextValue | null>(null)

/** The workspace's shared filter state — must be used inside AnalyticsLayout. */
export function useAnalyticsFilters(): AnalyticsFilterContextValue {
  const ctx = useContext(AnalyticsFilterContext)
  if (!ctx) throw new Error('useAnalyticsFilters requires <AnalyticsLayout> above the analytics pages.')
  return ctx
}

export interface AnalyticsWorkspaceState {
  selectedYear: FinancialYear | null
  fyLoading: boolean
  isReadOnly: boolean
  period: AnalyticsPeriod
  /** The ONE analytics dataset for the selected FY. */
  fold: UseAnalyticsFoldResult
  /** TRUE when the resolved period contains no possible business dates. */
  isPeriodEmpty: boolean
  today: string
}

/**
 * The composite page state — financial year + shared period + the shared
 * fold, with the standard loading/error derivations. Pages render their
 * skeleton/error states from this and compute their metrics PURELY.
 */
export function useAnalyticsWorkspace(): AnalyticsWorkspaceState {
  const { selectedYear, isReadOnly, isLoading: fyLoading } = useFinancialYear()
  const { period } = useAnalyticsFilters()
  const fold = useAnalyticsFold(selectedYear, fyLoading)
  return {
    selectedYear,
    fyLoading,
    isReadOnly,
    period,
    fold,
    isPeriodEmpty: period.from > period.to,
    today: new Date().toISOString().slice(0, 10),
  }
}

/** Re-export so pages can resolve their own sub-periods consistently. */
export { resolvePeriod }
