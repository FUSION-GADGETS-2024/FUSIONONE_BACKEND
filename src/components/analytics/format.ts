/**
 * Analytics display formatting — presentation-only helpers for the
 * Analytics workspace (web UI). The authoritative business calculations
 * live in features/analytics/metrics.ts; these functions only RENDER.
 */
import { formatMoney } from '@/features/validation/fields'

/** Table/KPI money: the app's established "… Rs." convention. */
export function money(n: number): string {
  return `${formatMoney(n)} Rs.`
}

/** Compact axis/label money (Indian scale: k / L / Cr). */
export function moneyCompact(n: number): string {
  const abs = Math.abs(n)
  if (abs >= 1_00_00_000) return `${trim(n / 1_00_00_000)} Cr`
  if (abs >= 1_00_000) return `${trim(n / 1_00_000)} L`
  if (abs >= 1_000) return `${trim(n / 1_000)} k`
  return trim(n)
}

function trim(n: number): string {
  const rounded = Math.abs(n) >= 100 ? Math.round(n) : Math.round(n * 10) / 10
  return rounded.toLocaleString('en-IN', { maximumFractionDigits: 1 })
}

/** Count with en-IN grouping. */
export function count(n: number): string {
  return n.toLocaleString('en-IN')
}

/** "42 days" / "1 day" styling input. */
export function days(n: number): string {
  return `${n.toLocaleString('en-IN')} ${n === 1 ? 'day' : 'days'}`
}

/** Percentage of a total (0 when total is 0). */
export function pct(part: number, total: number): number {
  if (total <= 0) return 0
  return Math.round((part / total) * 100)
}
