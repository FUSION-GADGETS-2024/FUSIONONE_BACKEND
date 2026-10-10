'use client';

/**
 * The Analytics chart primitives — hand-rolled SVG/HTML visualizations in
 * the app's exact visual language (slate grid, indigo/violet/emerald/rose
 * series colors, tabular numbers, micro-uppercase labels). No chart
 * library: these are the only chart surfaces the workspace needs, and they
 * stay perfectly consistent with the rest of FUSION ONE's UI.
 *
 * Every chart:
 *   - renders an accessible role="img" + aria-label,
 *   - exposes native <title> tooltips on its data marks,
 *   - degrades to a meaningful empty state (never an empty frame),
 *   - draws gridlines/axes at text-[9px] slate-400 with compact money.
 */
import { cn } from '@/components/ui/utils'
import { money, moneyCompact, count } from './format'

// ── Palette (the app's established series colors) ────────────────────────────

export const SERIES = {
  sales: '#4f46e5', // indigo-600
  purchases: '#7c3aed', // violet-600
  moneyIn: '#059669', // emerald-600
  moneyOut: '#e11d48', // rose-600
  paid: '#059669',
  partial: '#d97706', // amber-600
  unpaid: '#e11d48',
  regular: '#4f46e5',
  tradeIn: '#0284c7', // sky-600
} as const

// ── TrendChart — grouped monthly bars (one or two series) ────────────────────

export interface TrendSeries {
  key: string
  label: string
  color: string
  values: number[]
}

export function TrendChart({
  points,
  series,
  ariaLabel,
  emptyMessage = 'No activity in this period.',
}: {
  /** Month labels (e.g. "Apr 2026"). */
  points: string[]
  series: TrendSeries[]
  ariaLabel: string
  emptyMessage?: string
}) {
  const hasData = series.some((s) => s.values.some((v) => v > 0))
  if (!hasData) {
    return <ChartEmpty message={emptyMessage} />
  }

  const W = 640
  const H = 220
  const PAD = { top: 10, right: 8, bottom: 26, left: 52 }
  const plotW = W - PAD.left - PAD.right
  const plotH = H - PAD.top - PAD.bottom
  const max = Math.max(1, ...series.flatMap((s) => s.values))
  const niceMax = niceCeil(max)
  const groupW = points.length > 0 ? plotW / points.length : plotW
  const barW = Math.min(18, (groupW * 0.62) / series.length)

  // Y gridlines: 4 divisions
  const gridlines = [0.25, 0.5, 0.75, 1].map((f) => PAD.top + plotH - plotH * f)

  return (
    <div className="w-full" role="img" aria-label={ariaLabel}>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto select-none">
        {gridlines.map((y, i) => {
          const value = (niceMax * (i + 1)) / 4
          return (
            <g key={i}>
              <line x1={PAD.left} y1={y} x2={W - PAD.right} y2={y} stroke="#f1f5f9" strokeWidth={1} />
              <text x={PAD.left - 6} y={y + 3} textAnchor="end" fontSize={9} fill="#94a3b8">
                {moneyCompact(value)}
              </text>
            </g>
          )
        })}
        <line x1={PAD.left} y1={PAD.top + plotH} x2={W - PAD.right} y2={PAD.top + plotH} stroke="#e2e8f0" strokeWidth={1} />

        {points.map((label, i) => {
          const cx = PAD.left + groupW * i + groupW / 2
          const totalBars = series.length
          return (
            <g key={label}>
              {series.map((s, si) => {
                const v = s.values[i] ?? 0
                const h = v > 0 ? Math.max(2, (v / niceMax) * plotH) : 0
                const x = cx - (totalBars * barW) / 2 + si * barW
                const y = PAD.top + plotH - h
                return (
                  <rect key={s.key} x={x} y={y} width={barW} height={h} rx={2} fill={s.color} opacity={v > 0 ? 1 : 0}>
                    {v > 0 && <title>{`${label} — ${s.label}: ${money(v)}`}</title>}
                  </rect>
                )
              })}
              <text x={cx} y={H - 10} textAnchor="middle" fontSize={9} fill="#94a3b8">
                {label}
              </text>
            </g>
          )
        })}
      </svg>
      {series.length > 1 && <ChartLegend series={series} />}
    </div>
  )
}

// ── DonutChart — composition with legend + center total ──────────────────────

export interface DonutSegment {
  label: string
  value: number
  color: string
}

export function DonutChart({
  segments,
  ariaLabel,
  centerLabel,
  centerValue,
  emptyMessage = 'Nothing to show yet.',
}: {
  segments: DonutSegment[]
  ariaLabel: string
  centerLabel: string
  centerValue: string
  emptyMessage?: string
}) {
  const total = segments.reduce((a, s) => a + s.value, 0)
  if (total <= 0) return <ChartEmpty message={emptyMessage} />

  const R = 52
  const C = 2 * Math.PI * R
  let offset = 0
  const arcs = segments.map((s) => {
    const frac = s.value / total
    const arc = { ...s, dash: frac * C, offset }
    offset += frac * C
    return arc
  })

  return (
    <div className="flex flex-col sm:flex-row items-center gap-5" role="img" aria-label={ariaLabel}>
      <svg viewBox="0 0 140 140" className="w-[140px] h-[140px] shrink-0 select-none -rotate-90">
        <circle cx="70" cy="70" r={R} fill="none" stroke="#f1f5f9" strokeWidth="18" />
        {arcs.map((a) => (
          <circle
            key={a.label}
            cx="70"
            cy="70"
            r={R}
            fill="none"
            stroke={a.color}
            strokeWidth="18"
            strokeDasharray={`${a.dash} ${C - a.dash}`}
            strokeDashoffset={-a.offset}
          >
            <title>{`${a.label}: ${money(a.value)} (${Math.round((a.value / total) * 100)}%)`}</title>
          </circle>
        ))}
      </svg>
      <div className="flex-1 min-w-0 w-full space-y-2.5">
        <div className="flex items-baseline justify-between gap-3 border-b border-slate-100 pb-2.5">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">{centerLabel}</span>
          <span className="text-sm font-semibold text-slate-900 tabular-nums">{centerValue}</span>
        </div>
        {segments.map((s) => (
          <div key={s.label} className="flex items-center gap-2.5">
            <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ backgroundColor: s.color }} />
            <span className="text-xs text-slate-600 flex-1 min-w-0 truncate">{s.label}</span>
            <span className="text-xs text-slate-400 tabular-nums shrink-0">
              {Math.round((s.value / total) * 100)}%
            </span>
            <span className="text-xs font-semibold text-slate-900 tabular-nums shrink-0 w-[92px] text-right">
              {moneyCompact(s.value)}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── BarList — ranked horizontal bars (top products / customers / methods) ────

export interface BarListItem {
  label: string
  sublabel?: string
  value: number
  valueLabel: string
  color?: string
}

export function BarList({
  items,
  ariaLabel,
  emptyMessage = 'Nothing to rank yet.',
}: {
  items: BarListItem[]
  ariaLabel: string
  emptyMessage?: string
}) {
  if (items.length === 0) return <ChartEmpty message={emptyMessage} />
  const max = Math.max(...items.map((i) => i.value), 1)
  return (
    <div className="space-y-3" role="list" aria-label={ariaLabel}>
      {items.map((item, i) => (
        <div key={`${item.label}-${i}`} className="space-y-1" role="listitem">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-xs font-medium text-slate-900 truncate">{item.label}</span>
            <span className="text-xs font-semibold text-slate-900 tabular-nums shrink-0">{item.valueLabel}</span>
          </div>
          <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
            <div
              className="h-full rounded-full"
              style={{ width: `${Math.max(2, (item.value / max) * 100)}%`, backgroundColor: item.color ?? SERIES.sales }}
            />
          </div>
          {item.sublabel && <p className="text-[10px] text-slate-400">{item.sublabel}</p>}
        </div>
      ))}
    </div>
  )
}

// ── AgeingBars — the four bucket bars with counts + amounts ──────────────────

export interface AgeingBar {
  label: string
  count: number
  amount: number
}

export function AgeingBars({
  buckets,
  ariaLabel,
  color = SERIES.sales,
  emptyMessage = 'Nothing outstanding.',
}: {
  buckets: AgeingBar[]
  ariaLabel: string
  color?: string
  emptyMessage?: string
}) {
  const total = buckets.reduce((a, b) => a + b.amount, 0)
  const totalCount = buckets.reduce((a, b) => a + b.count, 0)
  if (totalCount === 0) return <ChartEmpty message={emptyMessage} />
  const max = Math.max(...buckets.map((b) => b.amount), 1)
  return (
    <div className="space-y-3" role="img" aria-label={ariaLabel}>
      {buckets.map((b) => (
        <div key={b.label} className="space-y-1">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-xs text-slate-600">{b.label}</span>
            <span className="text-[11px] text-slate-400 tabular-nums">
              {count(b.count)} {b.count === 1 ? 'item' : 'items'}
            </span>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex-1 h-2 bg-slate-100 rounded-full overflow-hidden">
              <div
                className="h-full rounded-full"
                style={{ width: `${Math.max(2, (b.amount / max) * 100)}%`, backgroundColor: b.amount >= max * 0.75 ? '#e11d48' : color }}
              />
            </div>
            <span className="text-xs font-semibold text-slate-900 tabular-nums w-[104px] text-right shrink-0">
              {money(b.amount)}
            </span>
          </div>
        </div>
      ))}
      <div className="flex items-baseline justify-between gap-3 pt-2 border-t border-slate-100">
        <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Total</span>
        <span className="text-xs font-semibold text-slate-900 tabular-nums">{money(total)}</span>
      </div>
    </div>
  )
}

// ── Shared bits ───────────────────────────────────────────────────────────────

function ChartLegend({ series }: { series: TrendSeries[] }) {
  return (
    <div className="flex items-center justify-center gap-4 pt-1">
      {series.map((s) => (
        <span key={s.key} className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: s.color }} />
          <span className="text-[10px] font-medium text-slate-500">{s.label}</span>
        </span>
      ))}
    </div>
  )
}

function ChartEmpty({ message }: { message: string }) {
  return (
    <div className={cn('flex items-center justify-center py-10 text-center')}>
      <p className="text-xs text-slate-400 max-w-[280px]">{message}</p>
    </div>
  )
}

/** Rounds a chart max up to a pleasant axis ceiling. */
function niceCeil(value: number): number {
  if (value <= 10) return 10
  const mag = 10 ** Math.floor(Math.log10(value))
  const scaled = value / mag
  const nice = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 2.5 ? 2.5 : scaled <= 5 ? 5 : 10
  return nice * mag
}
