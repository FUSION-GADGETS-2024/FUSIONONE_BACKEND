'use client';

import type { ReactNode } from 'react'
import type { ElementType } from 'react'
import { cn } from '@/components/ui/utils'
import { Amount } from '@/components/ui/Amount'

/**
 * KPI card — the Analytics workspace's metric tile, in the app's exact
 * card language (white rounded-xl card, micro-uppercase label, icon tile,
 * tabular money via the shared Amount primitive).
 */
export function KpiCard({
  label,
  value,
  icon: Icon,
  iconBg = 'bg-indigo-50 text-indigo-500',
  valueFormat = 'money',
  caption,
  secondary,
  secondaryLabel,
  secondaryFormat = 'money',
}: {
  label: string
  value: number
  icon?: ElementType
  iconBg?: string
  /** money (Rs. via Amount) | count (en-IN integer) | days. */
  valueFormat?: 'money' | 'count' | 'days'
  /** Small line under the value (e.g. "in period" / "now"). */
  caption?: string
  /** Secondary value row — money (Rs.) or a bare count. */
  secondary?: number
  secondaryLabel?: string
  /** money (default) renders the secondary via Amount; count renders a
   * bare en-IN integer — counts must never carry the Rs. unit. */
  secondaryFormat?: 'money' | 'count'
}) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-4 flex flex-col gap-2.5">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-bold tracking-[0.1em] uppercase text-slate-400 leading-none">
          {label}
        </span>
        {Icon && (
          <div className={cn('w-6 h-6 rounded-md flex items-center justify-center shrink-0', iconBg)}>
            <Icon className="w-3 h-3" />
          </div>
        )}
      </div>

      <div className="flex flex-col gap-px">
        {valueFormat === 'money' ? (
          <Amount value={value} size="lg" dim={value === 0} />
        ) : (
          <p className="text-[26px] leading-none font-semibold text-slate-900 tracking-tight tabular-nums">
            {valueFormat === 'days' ? `${value.toLocaleString('en-IN')}d` : value.toLocaleString('en-IN')}
          </p>
        )}
        {caption && <span className="text-[10px] text-slate-400 font-medium">{caption}</span>}
      </div>

      {secondary !== undefined && secondaryLabel && (
        <div className="flex items-center justify-between pt-2 mt-auto border-t border-slate-100">
          <span className="text-[10px] text-slate-400">{secondaryLabel}</span>
          {secondaryFormat === 'count' ? (
            <span className="text-xs font-semibold text-slate-700 tabular-nums">{secondary.toLocaleString('en-IN')}</span>
          ) : (
            <Amount value={secondary} size="sm" dim={secondary === 0} />
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Section card — titled card band for analytics sections (the dashboard's
 * card-header language: icon + micro-uppercase title + right meta).
 */
export function SectionCard({
  title,
  icon: Icon,
  meta,
  action,
  children,
  className,
}: {
  title: string
  icon?: ElementType
  meta?: string
  action?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <div className={cn('bg-white rounded-xl border border-slate-200 flex flex-col', className)}>
      <div className="flex items-center gap-1.5 px-4 pt-4 pb-3 border-b border-slate-100">
        {Icon && <Icon className="w-3 h-3 text-slate-400 shrink-0" />}
        <span className="text-[10px] font-bold tracking-[0.1em] uppercase text-slate-400">{title}</span>
        {meta && <span className="ml-auto text-[10px] text-slate-400">{meta}</span>}
        {action}
      </div>
      <div className="p-4">{children}</div>
    </div>
  )
}

/** Compact stat tile (the dashboard's StockTile language). */
export function StatTile({
  label,
  value,
  caption,
  valueClassName = 'text-slate-900',
}: {
  label: string
  value: string
  caption?: string
  valueClassName?: string
}) {
  return (
    <div className="bg-slate-50 rounded-lg px-3 py-2.5">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 mb-1">{label}</p>
      <p className={cn('text-lg font-semibold tabular-nums leading-none', valueClassName)}>{value}</p>
      {caption && <p className="text-[10px] text-slate-400 mt-0.5">{caption}</p>}
    </div>
  )
}

/** The analytics page loading skeleton — one region-level pulse. */
export function AnalyticsSkeleton({ pulsing }: { pulsing: boolean }) {
  return (
    <div className={cn('space-y-5 select-none', pulsing && 'animate-pulse')}>
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-1.5">
          <div className="h-4 w-24 bg-slate-100 rounded" />
          <div className="h-3 w-44 bg-slate-100 rounded" />
        </div>
        <div className="h-8 w-64 bg-slate-100 rounded-lg" />
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="h-[116px] bg-slate-100 rounded-xl" />
        ))}
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-3">
        <div className="lg:col-span-3 h-[260px] bg-slate-100 rounded-xl" />
        <div className="lg:col-span-2 h-[260px] bg-slate-100 rounded-xl" />
      </div>
      <div className="h-[280px] bg-slate-100 rounded-xl" />
    </div>
  )
}

/** The analytics page error state — actionable, not a blank page. */
export function AnalyticsError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-8 flex flex-col items-center justify-center gap-3 text-center">
      <div className="w-9 h-9 rounded-full bg-rose-50 flex items-center justify-center">
        <span className="text-rose-500 font-bold text-sm">!</span>
      </div>
      <div>
        <p className="text-xs font-semibold text-slate-900">Couldn't load analytics</p>
        <p className="text-[11px] text-slate-400 mt-0.5">
          The business data for this financial year failed to load.
        </p>
      </div>
      <button
        onClick={onRetry}
        className="h-8 px-3 rounded-md border border-slate-300 bg-white text-xs font-medium text-slate-700 hover:bg-slate-50 transition-colors shadow-sm"
      >
        Try again
      </button>
    </div>
  )
}
