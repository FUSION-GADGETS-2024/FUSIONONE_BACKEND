/**
 * The export dialog's validated period model (implementation spec §6.1).
 *
 * The dialog supports: This Month, Last Month, Financial Year and Custom
 * Period (with From/To dates). Every preset resolves against the SELECTED
 * financial year using the workspace's established intersection
 * convention, so the export can only ever cover business dates whose data
 * the shared fold actually holds. The resolved range is displayed in the
 * dialog — nothing switches silently.
 *
 * Boundaries are INCLUSIVE on both ends, exactly like the Analytics
 * workspace period (metrics.dateInRange uses from ≤ date ≤ to), so the
 * same validated period drives the query, the report calculations, the
 * workbook metadata and the filename.
 */
import { dateOnly, monthEnd } from '@/features/analytics/period'
import type { AnalyticsPeriod, DateRange } from '@/features/analytics/types'
import type { FinancialYear } from '@/features/types'

export type ExportPreset = 'this-month' | 'last-month' | 'financial-year' | 'custom'

/** The selectable presets, in dialog order. */
export const EXPORT_PRESETS: ReadonlyArray<{ value: ExportPreset; label: string }> = [
  { value: 'this-month', label: 'This Month' },
  { value: 'last-month', label: 'Last Month' },
  { value: 'financial-year', label: 'Financial Year' },
  { value: 'custom', label: 'Custom Period' },
]

/** Intersection bounds: never outside the selected financial year. */
function lowerBound(value: string, fyStart: string): string {
  return value > fyStart ? value : fyStart
}

function upperBound(value: string, fyEnd: string): string {
  return value < fyEnd ? value : fyEnd
}

/** The previous calendar month of `today` (YYYY-MM-DD), as a range. */
function lastMonthBounds(today: string): DateRange {
  let y = Number(today.slice(0, 4))
  let m = Number(today.slice(5, 7)) - 1
  if (m < 1) {
    m = 12
    y -= 1
  }
  const mm = String(m).padStart(2, '0')
  return { from: `${y}-${mm}-01`, to: monthEnd(`${y}-${mm}-15`) }
}

/**
 * Resolves a preset (+ custom bounds) into the authoritative, FY-clamped,
 * inclusive export range. An empty window (from > to) is representable —
 * the dialog explains it and disables the export.
 */
export function resolveExportPeriod(
  preset: ExportPreset,
  fy: Pick<FinancialYear, 'start_date' | 'end_date'> | null,
  custom: Partial<DateRange>,
  today: string,
): DateRange {
  const fyStart = dateOnly(fy?.start_date) || '1900-01-01'
  const fyEnd = dateOnly(fy?.end_date) || '2999-12-31'

  let from = fyStart
  let to = fyEnd
  if (preset === 'this-month') {
    from = lowerBound(`${today.slice(0, 7)}-01`, fyStart)
    to = upperBound(monthEnd(today), fyEnd)
  } else if (preset === 'last-month') {
    const lm = lastMonthBounds(today)
    from = lowerBound(lm.from, fyStart)
    to = upperBound(lm.to, fyEnd)
  } else if (preset === 'custom') {
    const cFrom = dateOnly(custom.from) || fyStart
    const cTo = dateOnly(custom.to) || fyEnd
    // Auto-order the pair — an inverted range is never useful.
    const [lo, hi] = cFrom <= cTo ? [cFrom, cTo] : [cTo, cFrom]
    from = lowerBound(lo, fyStart)
    to = upperBound(hi, fyEnd)
  }
  return { from, to }
}

/**
 * The dialog's initial state from the current Analytics period — the
 * dialog opens on EXACTLY the period the workspace is showing (never a
 * silently different range).
 */
export function initialExportState(
  workspace: AnalyticsPeriod,
): { preset: ExportPreset; custom: DateRange } {
  if (workspace.preset === 'fy') {
    return { preset: 'financial-year', custom: { from: workspace.from, to: workspace.to } }
  }
  if (workspace.preset === 'month') {
    return { preset: 'this-month', custom: { from: workspace.from, to: workspace.to } }
  }
  return { preset: 'custom', custom: { from: workspace.from, to: workspace.to } }
}

/** TRUE when the resolved window contains no possible business dates. */
export function isEmptyExportRange(range: DateRange): boolean {
  return range.from > range.to
}
