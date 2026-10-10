/**
 * The Analytics period model — the ONE shared filter state for Overview,
 * Sales, Money, Inventory and Reports (spec §10).
 *
 * A period is always resolved against the SELECTED financial year and
 * clamped into its bounds, so every page — and the Excel report built from
 * the same model — computes over exactly the same business date window.
 *
 * The preset is persisted in the URL query (`?period=month`,
 * `?period=custom&from=…&to=…`) so tab navigation and page refreshes keep
 * the workspace's filter state, following the app's existing `?tab=` URL
 * convention (PaymentsPage).
 */
import type { AnalyticsPeriod, DateRange, PeriodPreset } from './types'
import type { FinancialYear } from '@/features/types'

export type { AnalyticsPeriod, PeriodPreset, DateRange }

/** The selectable presets, in UI order. */
export const PERIOD_PRESETS: ReadonlyArray<{ value: PeriodPreset; label: string }> = [
  { value: 'fy', label: 'This Financial Year' },
  { value: 'month', label: 'This Month' },
  { value: 'quarter', label: 'This Quarter' },
  { value: 'custom', label: 'Custom' },
]

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// ── Small date helpers (local, YYYY-MM-DD only — no timezone math) ──────────

/** Today as a local YYYY-MM-DD string. */
export function todayStr(): string {
  const d = new Date()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

/** Normalizes any date-ish value to its YYYY-MM-DD part. */
export function dateOnly(value: string | null | undefined): string {
  return (value ?? '').slice(0, 10)
}

function monthStart(d: string): string {
  return `${d.slice(0, 7)}-01`
}

/** Last calendar day (YYYY-MM-DD) of d's month. */
export function monthEnd(d: string): string {
  const [y, m] = [Number(d.slice(0, 4)), Number(d.slice(5, 7))]
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return `${d.slice(0, 7)}-${String(last).padStart(2, '0')}`
}

function quarterBounds(d: string): { from: string; to: string } {
  const y = Number(d.slice(0, 4))
  const m = Number(d.slice(5, 7))
  const q = Math.floor((m - 1) / 3)
  const fromMonth = q * 3 + 1
  const toMonth = fromMonth + 2
  const lastDay = new Date(Date.UTC(y, toMonth, 0)).getUTCDate()
  return {
    from: `${y}-${String(fromMonth).padStart(2, '0')}-01`,
    to: `${y}-${String(toMonth).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`,
  }
}

/** Intersection lower bound: never earlier than the FY start. */
function lowerBound(value: string, fyStart: string): string {
  return value > fyStart ? value : fyStart
}

/** Intersection upper bound: never later than the FY end. */
function upperBound(value: string, fyEnd: string): string {
  return value < fyEnd ? value : fyEnd
}

// ── Resolution ───────────────────────────────────────────────────────────────

/**
 * Resolves a preset into the authoritative FY-clamped period.
 *
 * "This Month" / "This Quarter" / "Custom" are INTERSECTED with the FY
 * window (the app's established convention: every business query is
 * FY-scoped). When the intersection is empty — e.g. a future-dated FY
 * after an early rollover — the period resolves empty (from > to) and
 * analytics pages show their empty-period states.
 */
export function resolvePeriod(
  preset: PeriodPreset,
  fy: Pick<FinancialYear, 'start_date' | 'end_date'> | null,
  custom?: Partial<DateRange>,
  today = todayStr(),
): AnalyticsPeriod {
  const fyStart = dateOnly(fy?.start_date)
  const fyEnd = dateOnly(fy?.end_date)
  let from = fyStart
  let to = fyEnd

  if (fy) {
    if (preset === 'month') {
      from = lowerBound(monthStart(today), fyStart)
      to = upperBound(monthEnd(today), fyEnd)
    } else if (preset === 'quarter') {
      const q = quarterBounds(today)
      from = lowerBound(q.from, fyStart)
      to = upperBound(q.to, fyEnd)
    } else if (preset === 'custom') {
      const cFrom = dateOnly(custom?.from) || fyStart
      const cTo = dateOnly(custom?.to) || fyEnd
      from = lowerBound(cFrom, fyStart)
      to = upperBound(cTo, fyEnd)
    }
  }

  // An empty window is representable (from > to) and intentionally kept:
  // metrics fold to zero and pages explain the absence of data.
  return { preset, from, to }
}

/** TRUE when the resolved window contains no possible business dates. */
export function isEmptyPeriod(period: AnalyticsPeriod): boolean {
  return period.from > period.to
}

// ── Labels ───────────────────────────────────────────────────────────────────

/** "12 Oct 2026" style label for a single date. */
export function formatDateLabel(d: string): string {
  const [y, m, day] = dateOnly(d).split('-')
  const mi = Number(m) - 1
  if (!y || Number.isNaN(mi) || !day) return dateOnly(d)
  return `${Number(day)} ${MONTHS_SHORT[mi]} ${y}`
}

/** Human label for a period (used by pages, reports and the workbook). */
export function periodLabel(period: AnalyticsPeriod): string {
  if (isEmptyPeriod(period)) return 'No matching dates in this financial year'
  if (period.from === period.to) return formatDateLabel(period.from)
  return `${formatDateLabel(period.from)} – ${formatDateLabel(period.to)}`
}

/** The existing app FY label convention ("FY 2026–2027"). */
export function fyLabel(fy: Pick<FinancialYear, 'start_date' | 'end_date'> | null): string {
  if (!fy) return '—'
  const s = new Date(fy.start_date).getFullYear()
  const e = new Date(fy.end_date).getFullYear()
  return `FY ${s}\u2013${e}`
}

/** Short month label ("Apr 2026") for chart axes and tables. */
export function monthLabel(month: string): string {
  const [y, m] = month.split('-')
  const mi = Number(m) - 1
  if (!y || Number.isNaN(mi)) return month
  return `${MONTHS_SHORT[mi]} ${y}`
}

// ── URL (search param) codec ─────────────────────────────────────────────────

/** The search-param keys the analytics workspace owns. */
export const PERIOD_PARAMS = { preset: 'period', from: 'from', to: 'to' } as const

/**
 * Decodes the period preset (+ custom bounds) from a URL search string.
 * Unknown/absent values fall back to the default preset ('fy').
 */
export function decodePeriodPreset(search: string): { preset: PeriodPreset; from?: string; to?: string } {
  const params = new URLSearchParams(search)
  const raw = params.get(PERIOD_PARAMS.preset)
  const preset: PeriodPreset =
    raw === 'month' || raw === 'quarter' || raw === 'custom' ? raw : 'fy'
  const from = params.get(PERIOD_PARAMS.from) ?? undefined
  const to = params.get(PERIOD_PARAMS.to) ?? undefined
  return preset === 'custom' ? { preset, from, to } : { preset }
}

/** Encodes a period selection into a query string (without leading '?'). */
export function encodePeriod(period: AnalyticsPeriod): string {
  const params = new URLSearchParams()
  if (period.preset !== 'fy') params.set(PERIOD_PARAMS.preset, period.preset)
  if (period.preset === 'custom') {
    params.set(PERIOD_PARAMS.from, period.from)
    params.set(PERIOD_PARAMS.to, period.to)
  }
  const s = params.toString()
  return s ? `?${s}` : ''
}
