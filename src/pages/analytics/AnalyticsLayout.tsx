'use client';

/**
 * AnalyticsLayout — the ONE workspace shell for the five Analytics tabs
 * (Overview, Sales, Money, Inventory, Purchase).
 *
 * Architecture (implementation spec §4–§5): Analytics is a main sidebar
 * module with compact HORIZONTAL top navigation (SegmentedTabs, exactly
 * five tabs — no Reports tab, no nested report navigation) and ONE shared
 * filter model (Financial Year via the app header's picker + this bar's
 * period presets, URL encoded so it survives tab navigation and
 * refreshes). The pages are bounded (the shell's scrolling <main>), like
 * the dashboard and settings.
 *
 * The header carries the ACTIVE TAB's identity (title + description) and
 * the tab's Export action — one consistent position across all five tabs.
 * The Export action opens the ONE shared export dialog, which already
 * knows the active tab's report (the user never picks a report from a
 * list).
 */
import { useCallback, useMemo, useState } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router'
import { CalendarRange, Download } from 'lucide-react'
import { SegmentedTabs } from '@/components/ui/SegmentedTabs'
import { Button } from '@/components/ui/Button'
import { useFinancialYear } from '@/components/providers/FinancialYearProvider'
import { useAnalyticsFilters, AnalyticsFilterContext } from '@/features/analytics/workspace'
import { ExportDialog, SECTION_REPORTS } from '@/components/analytics/ExportDialog'
import type { AnalyticsSection } from '@/components/analytics/ExportDialog'
import { reportInfo } from '@/features/reports/catalogue'
import {
  PERIOD_PRESETS,
  decodePeriodPreset,
  encodePeriod,
  fyLabel,
  isEmptyPeriod,
  periodLabel,
  resolvePeriod,
} from '@/features/analytics/period'
import type { AnalyticsPeriod, PeriodPreset } from '@/features/analytics/types'
import { cn } from '@/components/ui/utils'

type Section = AnalyticsSection

const SECTIONS: ReadonlyArray<{ value: Section; label: string; path: string }> = [
  { value: 'overview', label: 'Overview', path: '/analytics' },
  { value: 'sales', label: 'Sales', path: '/analytics/sales' },
  { value: 'money', label: 'Money', path: '/analytics/money' },
  { value: 'inventory', label: 'Inventory', path: '/analytics/inventory' },
  { value: 'purchase', label: 'Purchase', path: '/analytics/purchase' },
]

/** The active tab's identity — its header title and description. */
const SECTION_META: Record<Section, { title: string; description: string }> = {
  overview: {
    title: 'Overview',
    description: 'How is my business doing? A period view of sales, purchases and payments beside current balances.',
  },
  sales: {
    title: 'Sales',
    description: 'What am I selling and where is sales performance coming from?',
  },
  money: {
    title: 'Money',
    description: 'Where is money coming from, where is it going, and what remains due?',
  },
  inventory: {
    title: 'Inventory',
    description: 'What stock do I have, what is it worth, and what is becoming a problem?',
  },
  purchase: {
    title: 'Purchase',
    description: 'Understand supplier purchases, purchase costs, and outstanding amounts.',
  },
}

function sectionFromPath(pathname: string): Section {
  if (pathname.startsWith('/analytics/sales')) return 'sales'
  if (pathname.startsWith('/analytics/money')) return 'money'
  if (pathname.startsWith('/analytics/inventory')) return 'inventory'
  if (pathname.startsWith('/analytics/purchase')) return 'purchase'
  return 'overview'
}

export default function AnalyticsLayout() {
  const { selectedYear } = useFinancialYear()
  const { pathname, search } = useLocation()
  const navigate = useNavigate()
  const [exportOpen, setExportOpen] = useState(false)

  const section = sectionFromPath(pathname)
  const decoded = useMemo(() => decodePeriodPreset(search), [search])
  const period = useMemo(
    () => resolvePeriod(decoded.preset, selectedYear, decoded),
    [decoded, selectedYear],
  )

  const navigateWithPeriod = useCallback(
    (next: AnalyticsPeriod) => {
      navigate({ pathname, search: encodePeriod(next) })
    },
    [navigate, pathname],
  )

  const filterValue = useMemo<AnalyticsPeriod>(
    () => ({ ...period, preset: decoded.preset }),
    [period, decoded.preset],
  )

  const setPreset = useCallback(
    (preset: PeriodPreset) => {
      navigateWithPeriod({ ...period, preset })
    },
    [navigateWithPeriod, period],
  )

  const setCustomRange = useCallback(
    (from: string, to: string) => {
      // Auto-order the pair — an inverted range is never useful.
      const [lo, hi] = from <= to ? [from, to] : [to, from]
      navigateWithPeriod({ preset: 'custom', from: lo, to: hi })
    },
    [navigateWithPeriod],
  )

  const goToSection = useCallback(
    (value: Section) => {
      const target = SECTIONS.find((s) => s.value === value)
      if (!target) return
      navigate({ pathname: target.path, search })
    },
    [navigate, search],
  )

  const meta = SECTION_META[section]

  return (
    <AnalyticsFilterContext.Provider
      value={useMemo(
        () => ({ period: filterValue, preset: decoded.preset, setPreset, setCustomRange }),
        [filterValue, decoded.preset, setPreset, setCustomRange],
      )}
    >
      <div className="space-y-5">
        {/* ── The active tab's header + its Export action ─────────────── */}
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-sm font-semibold text-slate-900 tracking-tight leading-none">{meta.title}</h1>
            <p className="text-[11px] text-slate-400 mt-1 leading-snug">{meta.description}</p>
            <p className="text-[11px] text-slate-400 mt-1 tabular-nums">
              {fyLabel(selectedYear)} · {periodLabel(period)}
            </p>
          </div>
          <div className="shrink-0 pt-0.5">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setExportOpen(true)}
              className="gap-1.5 text-xs h-9"
              aria-label={`Export ${reportInfo(SECTION_REPORTS[section]).title}`}
            >
              <Download className="h-3.5 w-3.5" />
              Export
            </Button>
          </div>
        </div>

        {/* ── The five tabs (compact horizontal top navigation) ─────────── */}
        <nav aria-label="Analytics sections">
          <SegmentedTabs
            tabs={SECTIONS.map((s) => ({ value: s.value, label: s.label }))}
            value={section}
            onChange={goToSection}
            aria-label="Analytics sections"
            className="shrink-0 flex-wrap"
          />
        </nav>

        {/* ── The ONE shared filter bar ─────────────────────────────────── */}
        <FilterBar />

        {/* ── The active tab ────────────────────────────────────────────── */}
        <Outlet />

        {/* ── The ONE shared export dialog (the tab decides the report) ── */}
        <ExportDialog isOpen={exportOpen} onClose={() => setExportOpen(false)} section={section} />
      </div>
    </AnalyticsFilterContext.Provider>
  )
}

/** The shared filter bar — period presets (+ custom range inputs). */
function FilterBar() {
  const { selectedYear } = useFinancialYear()
  const { period, preset, setPreset, setCustomRange } = useAnalyticsFilters()

  const fyStart = selectedYear?.start_date?.slice(0, 10) ?? '1900-01-01'
  const fyEnd = selectedYear?.end_date?.slice(0, 10) ?? '2999-12-31'

  return (
    <div className="bg-white rounded-xl border border-slate-200 p-3 flex flex-col lg:flex-row lg:items-center gap-3">
      <div className="flex items-center gap-2 shrink-0">
        <CalendarRange className="w-3.5 h-3.5 text-slate-400 shrink-0" />
        <span className="text-[10px] font-bold tracking-[0.08em] uppercase text-slate-400">Period</span>
      </div>

      <SegmentedTabs
        tabs={PERIOD_PRESETS.map((p) => ({ value: p.value, label: p.label }))}
        value={preset}
        onChange={setPreset}
        aria-label="Analytics period preset"
        className="shrink-0 flex-wrap"
      />

      {preset === 'custom' && (
        <div className="flex items-center gap-2 flex-wrap">
          <DateInput
            label="From"
            value={period.from}
            min={fyStart}
            max={fyEnd}
            onChange={(v) => setCustomRange(v, period.to)}
          />
          <span className="text-[10px] text-slate-400">to</span>
          <DateInput
            label="To"
            value={period.to}
            min={fyStart}
            max={fyEnd}
            onChange={(v) => setCustomRange(period.from, v)}
          />
        </div>
      )}

      <div className="lg:ml-auto text-[11px] text-slate-400 tabular-nums lg:text-right">
        {isEmptyPeriod(period)
          ? 'No matching dates in this financial year'
          : period.from === period.to
            ? period.from
            : `${period.from} → ${period.to}`}
      </div>
    </div>
  )
}

function DateInput({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string
  value: string
  min: string
  max: string
  onChange: (value: string) => void
}) {
  return (
    <label className="flex items-center gap-1.5">
      <span className="sr-only">{label}</span>
      <input
        type="date"
        aria-label={label}
        value={value}
        min={min}
        max={max}
        onChange={(e) => e.target.value && onChange(e.target.value)}
        className={cn(
          'h-8 rounded-lg border border-slate-300 bg-white px-2.5 text-xs text-slate-900',
          'focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-colors shadow-sm',
          'tabular-nums',
        )}
      />
    </label>
  )
}
