import { useState, useRef, useEffect, useCallback } from 'react'
import { Link, useLocation } from 'react-router'
import { Calendar, ChevronDown, AlertCircle, Lock, MessageCircle, Bell, Info, AlertTriangle } from 'lucide-react'
import { useFinancialYear } from '@/components/providers/FinancialYearProvider'
import { useNotices } from '@/features/notices/useNotices'
import type { Notice, NoticeSeverity } from '@/features/notices/types'
import { cn } from '@/components/ui/utils'

function fyLabel(startDate: string, endDate: string) {
  const s = new Date(startDate).getFullYear()
  const e = new Date(endDate).getFullYear()
  return `FY ${s}\u2013${e}`
}

/**
 * The ONE dismissal behavior of the header's dropdown menus (FY picker,
 * notices): close on any outside pointer press and on Escape — listeners
 * exist only while the menu is open. Returns the container ref the caller
 * spreads over its menu wrapper.
 */
function useMenuDismiss(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleKey)
    }
  }, [open, onClose])

  return ref
}

// ── Notice rows ──────────────────────────────────────────────────────────────

const SEVERITY_STYLES: Record<NoticeSeverity, { icon: typeof AlertCircle; iconClass: string; titleClass: string }> = {
  critical: { icon: AlertCircle, iconClass: 'text-rose-500', titleClass: 'text-rose-700' },
  warning: { icon: AlertTriangle, iconClass: 'text-amber-500', titleClass: 'text-amber-700' },
  info: { icon: Info, iconClass: 'text-sky-500', titleClass: 'text-sky-700' },
}

function NoticeRow({ notice, onNavigate }: { notice: Notice; onNavigate: () => void }) {
  const style = SEVERITY_STYLES[notice.severity]
  return (
    <Link
      to={notice.action?.to ?? '#'}
      onClick={onNavigate}
      className="flex items-start gap-2.5 px-4 py-3 hover:bg-slate-50 transition-colors"
    >
      <style.icon className={cn('w-3 h-3 mt-px shrink-0', style.iconClass)} />
      <div className="min-w-0">
        <p className={cn('text-[11px] font-semibold leading-none mb-0.5', style.titleClass)}>{notice.title}</p>
        <p className="text-[11px] text-slate-500 leading-snug">{notice.message}</p>
        {notice.action && (
          <p className="text-[10px] font-semibold text-indigo-600 mt-1 leading-none">{notice.action.label} →</p>
        )}
      </div>
    </Link>
  )
}

/**
 * Notifications — the header home of the notice system: the derived,
 * deduplicated attention feed (overdue receivables, aging stock, WhatsApp
 * connection, old proformas, failed deliveries, financial-year state),
 * computed from the SAME business semantics the Analytics workspace uses.
 * Bounded by design: a focused detector set (features/notices/detectors.ts)
 * in a non-growing menu — never a general notification framework.
 */
function NotificationsMenu() {
  const { notices, isLoading, isError, refetch } = useNotices()

  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])
  const ref = useMenuDismiss(open, close)

  const criticalCount = notices.filter((n) => n.severity === 'critical').length
  const badgeClass = criticalCount > 0 ? 'bg-rose-100 text-rose-700' : 'bg-amber-100 text-amber-700'

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label={`Notifications${notices.length > 0 ? `, ${notices.length} active` : ''}`}
        aria-expanded={open}
        className={cn(
          'flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors select-none shrink-0',
          open
            ? 'bg-slate-100 border-slate-300 text-slate-900'
            : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50 hover:text-slate-900',
        )}
      >
        <span className="relative flex items-center shrink-0">
          <Bell className="h-3.5 w-3.5" />
          {notices.length > 0 && (
            <span
              className={cn(
                'absolute -top-1.5 -right-1.5 flex items-center justify-center min-w-[14px] h-[14px] px-[3px] rounded-full text-[9px] font-bold leading-none border border-white',
                badgeClass,
              )}
            >
              {notices.length}
            </span>
          )}
        </span>
        {/* Icon-only below sm (the same narrow-width language as the
            read-only badge) — the label returns at sm+ alongside Messages. */}
        <span className="hidden sm:inline">Notifications</span>
      </button>

      {open && (
        /* On narrow screens the panel is a fixed sheet below the header
           (a right-anchored 320px menu would overflow the viewport); from
           sm: up it is the normal compact dropdown at the button. */
        <div className="fixed inset-x-2 top-[3.75rem] bg-white rounded-xl shadow-lg border border-slate-200 z-50 overflow-hidden menu-fade-in sm:absolute sm:inset-x-auto sm:right-0 sm:top-full sm:mt-1.5 sm:w-80">
          <div className="flex items-center gap-1.5 px-4 pt-3 pb-2.5 border-b border-slate-100">
            <Bell className="w-3 h-3 text-slate-400" />
            <span className="text-[10px] font-bold tracking-[0.1em] uppercase text-slate-400">
              Notifications
            </span>
            {notices.length > 0 && (
              <span className="ml-auto text-[10px] text-slate-400">
                {notices.length} {notices.length === 1 ? 'notice' : 'notices'}
              </span>
            )}
          </div>
          {isLoading ? (
            <div className="px-4 py-5 text-xs text-slate-400">Loading notices…</div>
          ) : isError ? (
            <div className="px-4 py-5">
              <p className="text-[11px] text-rose-600 font-medium mb-2">Couldn't load notices.</p>
              <button
                onClick={() => refetch()}
                className="text-[11px] font-semibold text-indigo-600 hover:text-indigo-800 transition-colors"
              >
                Try again
              </button>
            </div>
          ) : notices.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-1.5 py-6">
              <div className="w-7 h-7 rounded-full bg-emerald-50 flex items-center justify-center">
                <span className="text-emerald-500 text-sm">✓</span>
              </div>
              <p className="text-[11px] text-slate-400">All clear</p>
            </div>
          ) : (
            /* Bounded by construction (a focused detector set) — the scroll
               guard is a defensive backstop, not the experience. */
            <div className="max-h-[min(24rem,70vh)] overflow-y-auto divide-y divide-slate-50">
              {notices.map((notice) => (
                <NoticeRow key={notice.id} notice={notice} onNavigate={close} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default function Header() {
  const { financialYears, selectedYear, setSelectedYearId, isReadOnly, isLoading } =
    useFinancialYear()
  const { pathname } = useLocation()

  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])
  const ref = useMenuDismiss(open, close)

  const isEndDatePassed = selectedYear && new Date() > new Date(selectedYear.end_date)
  const label = selectedYear
    ? fyLabel(selectedYear.start_date, selectedYear.end_date)
    : isLoading
      ? 'Loading\u2026'
      : 'No FY'

  return (
    <div className="flex flex-col shrink-0 z-20 w-full">
      <header className="h-14 bg-white border-b border-slate-200 flex items-center justify-between px-4 sm:px-6">
        {/* Branding */}
        <div className="flex items-center gap-2.5 min-w-0">
          <img
            src="/Logo_Rounded.png"
            alt="FUSION ONE Logo"
            width={32}
            height={32}
            className="w-8 h-8 rounded-lg shrink-0 object-contain"
          />
          <span className="hidden sm:inline font-bold text-base text-slate-900 tracking-tight truncate">
            FUSION ONE
          </span>
        </div>

        <div className="flex items-center gap-2 sm:gap-3">
          {/* Read-only badge — icon-only on very narrow widths (the state
              must stay visible; the label returns at sm+). */}
          {isReadOnly && (
            <>
              <div
                className="sm:hidden flex items-center justify-center h-[30px] w-[30px] bg-rose-50 text-rose-600 rounded-full border border-rose-100"
                title="Read Only"
                aria-label="Read Only"
              >
                <Lock className="h-3 w-3" />
              </div>
              <div className="hidden sm:flex items-center gap-1.5 bg-rose-50 text-rose-600 px-2.5 py-1 rounded-full text-xs font-semibold border border-rose-100">
                <Lock className="h-3 w-3" />
                Read Only
              </div>
            </>
          )}

          {/* Messages — the user-facing view over the durable message
              system (its own destination, deliberately separate from the
              notifications dropdown). */}
          <Link
            to="/messages"
            aria-label="Messages"
            className={cn(
              'flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors select-none shrink-0',
              pathname.startsWith('/messages')
                ? 'bg-indigo-50 border-indigo-100 text-indigo-700 hover:bg-indigo-100 hover:border-indigo-200'
                : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50 hover:text-slate-900',
            )}
          >
            <MessageCircle className="h-3.5 w-3.5 shrink-0" />
            Messages
          </Link>

          {/* Notifications — the notice system, compactly */}
          <NotificationsMenu />

          {/* FY picker */}
          <div ref={ref} className="relative">
            <button
              onClick={() => !isLoading && financialYears.length > 0 && setOpen((v) => !v)}
              disabled={isLoading || financialYears.length === 0}
              aria-expanded={open}
              className={cn(
                'flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors select-none',
                'bg-indigo-50 border-indigo-100 text-indigo-700 hover:bg-indigo-100 hover:border-indigo-200',
                'disabled:opacity-50 disabled:cursor-not-allowed',
                open && 'bg-indigo-100 border-indigo-200 ring-2 ring-indigo-100',
              )}
            >
              <Calendar className="h-3.5 w-3.5 shrink-0" />
              <span className="tracking-wide">{label}</span>
              {financialYears.length > 1 && (
                <ChevronDown
                  className={cn(
                    'h-3.5 w-3.5 shrink-0 transition-transform duration-150',
                    open && 'rotate-180',
                  )}
                />
              )}
            </button>

            {open && (
              <div className="absolute right-0 top-full mt-1.5 w-52 bg-white rounded-xl shadow-lg border border-slate-200 py-1 z-50 overflow-hidden menu-fade-in">
                {financialYears.map((fy) => {
                  const isSelected = fy.id === selectedYear?.id
                  const closed = fy.status === 'closed'
                  return (
                    <button
                      key={fy.id}
                      onClick={() => {
                        setSelectedYearId(fy.id)
                        setOpen(false)
                      }}
                      className={cn(
                        'w-full flex items-center justify-between gap-3 px-3.5 py-2.5 text-left text-xs font-medium transition-colors',
                        isSelected ? 'bg-indigo-50 text-indigo-700' : 'text-slate-700 hover:bg-slate-50',
                      )}
                    >
                      <span className="font-semibold tracking-wide">
                        {fyLabel(fy.start_date, fy.end_date)}
                      </span>
                      {closed ? (
                        <span className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-slate-400">
                          <Lock className="h-2.5 w-2.5" /> Closed
                        </span>
                      ) : isSelected ? (
                        <span className="text-[10px] font-bold uppercase tracking-wider text-indigo-500">
                          Active
                        </span>
                      ) : null}
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      </header>

      {/* FY ended warning banner */}
      {!isReadOnly && isEndDatePassed && (
        <div className="bg-amber-50 border-b border-amber-200 px-6 py-2 flex items-center gap-2 text-amber-800 text-xs w-full">
          <AlertCircle className="h-3.5 w-3.5 shrink-0 text-amber-500" />
          <p>
            <span className="font-semibold">Financial year ended.</span> Close it to carry forward
            stock to the next year.
          </p>
        </div>
      )}
    </div>
  )
}
