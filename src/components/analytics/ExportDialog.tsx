'use client';

/**
 * The ONE shared export dialog (implementation spec §6).
 *
 * Every Analytics tab's Export action opens THIS dialog — the active tab
 * determines the report, so the user never picks a report from a list and
 * there are no per-tab dialog implementations.
 *
 *   Overview  → Business Summary
 *   Sales     → Sales Register
 *   Money     → Money Register
 *   Inventory → Current Inventory Snapshot | Inventory Acquisitions (scope)
 *   Purchase  → Purchase Register
 *
 * The dialog owns the validated export period (This Month, Last Month,
 * Financial Year, Custom Period with From/To dates — inclusive boundaries,
 * resolved against the selected financial year and displayed explicitly).
 * It opens on the Analytics workspace's current period, never a silently
 * different range. Cancelling or closing never starts an export.
 */
import { useEffect, useMemo, useState } from 'react'
import { CalendarRange, FileSpreadsheet, AlertCircle } from 'lucide-react'
import { useAnalyticsWorkspace } from '@/features/analytics/workspace'
import { useStore } from '@/features/settings/api'
import { reportInfo } from '@/features/reports/catalogue'
import type { ReportId } from '@/features/reports/catalogue'
import { exportReport } from '@/features/reports/export'
import {
  EXPORT_PRESETS,
  initialExportState,
  isEmptyExportRange,
  resolveExportPeriod,
} from '@/features/reports/exportPeriod'
import type { ExportPreset } from '@/features/reports/exportPeriod'
import { formatDateLabel, todayStr } from '@/features/analytics/period'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { SegmentedTabs } from '@/components/ui/SegmentedTabs'
import { useToast } from '@/components/ui/Toast'
import { cn } from '@/components/ui/utils'

/** The Analytics section whose export this dialog runs. */
export type AnalyticsSection = 'overview' | 'sales' | 'money' | 'inventory' | 'purchase'

/** The report each section exports (Inventory chooses its scope in-dialog). */
export const SECTION_REPORTS: Record<AnalyticsSection, ReportId> = {
  overview: 'business-summary',
  sales: 'sales-register',
  money: 'money-register',
  inventory: 'inventory-snapshot',
  purchase: 'purchase-register',
}

type InventoryScope = 'inventory-snapshot' | 'inventory-acquisitions'

export interface ExportDialogProps {
  isOpen: boolean
  onClose: () => void
  section: AnalyticsSection
}

export function ExportDialog({ isOpen, onClose, section }: ExportDialogProps) {
  const ws = useAnalyticsWorkspace()
  const { data: store } = useStore()
  const { success, error: toastError } = useToast()

  const fy = ws.selectedYear
    ? { start_date: ws.selectedYear.start_date, end_date: ws.selectedYear.end_date }
    : null

  // ── Dialog state (re-initialized from the workspace period on open) ──────
  const [preset, setPreset] = useState<ExportPreset>('financial-year')
  const [custom, setCustom] = useState({ from: ws.period.from, to: ws.period.to })
  const [scope, setScope] = useState<InventoryScope>('inventory-snapshot')
  const [exporting, setExporting] = useState(false)
  const [failed, setFailed] = useState(false)

  const today = todayStr()

  // Open on EXACTLY the workspace's current period (spec §6.1: default to
  // the current Analytics period; never a silently different range).
  useEffect(() => {
    if (isOpen) {
      const initial = initialExportState(ws.period)
      setPreset(initial.preset)
      setCustom(initial.custom)
      setScope('inventory-snapshot')
      setFailed(false)
    }
    // ws.period is captured at open time by design — later workspace
    // changes never silently move the dialog's selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, section])

  const isInventory = section === 'inventory'
  const reportId: ReportId = isInventory ? scope : SECTION_REPORTS[section]
  const info = reportInfo(reportId)
  const isSnapshot = info.dateKind === 'as-of'

  const resolved = useMemo(
    () => resolveExportPeriod(preset, fy, custom, today),
    [preset, fy, custom, today],
  )

  const rangeEmpty = isEmptyExportRange(resolved)
  const invalidCustom = preset === 'custom' && (!custom.from || !custom.to)
  const canExport = !exporting && !invalidCustom && !rangeEmpty && !!ws.fold.data

  function setCustomDate(side: 'from' | 'to', value: string) {
    if (!value) return
    setPreset('custom')
    setCustom((c) => ({ ...c, [side]: value }))
  }

  async function runExport(): Promise<void> {
    if (!ws.fold.data || !canExport) return
    setExporting(true)
    setFailed(false)
    try {
      await exportReport(reportId, {
        fold: ws.fold.data,
        // The VALIDATED, inclusive range — it drives the dataset, the
        // workbook metadata and the filename.
        period: { preset: 'custom', from: resolved.from, to: resolved.to },
        store: (store as { name?: string | null; address?: string | null; phone?: string | null } | null | undefined) ?? null,
        fy,
      })
      success(`${info.title} exported`, 'The workbook has been downloaded.')
      onClose()
    } catch (e) {
      setFailed(true)
      const message = e instanceof Error ? e.message : 'The workbook could not be generated.'
      toastError('Export failed', message)
    } finally {
      setExporting(false)
    }
  }

  const fyStart = fy ? fy.start_date.slice(0, 10) : '1900-01-01'
  const fyEnd = fy ? fy.end_date.slice(0, 10) : '2999-12-31'

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={`Export ${info.title}`}
      description={info.description}
      hideClose
      className="max-w-md"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose} disabled={exporting} className="text-xs h-9">
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() => void runExport()}
            disabled={!canExport}
            isLoading={exporting}
            className="gap-1.5 text-xs h-9"
          >
            {!exporting && <FileSpreadsheet className="h-3.5 w-3.5" />}
            Export Excel
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        {/* ── Inventory: the two export scopes (same shared dialog) ─────── */}
        {isInventory && (
          <div>
            <DialogFieldLabel>Export scope</DialogFieldLabel>
            <SegmentedTabs
              tabs={[
                { value: 'inventory-snapshot', label: 'Snapshot' },
                { value: 'inventory-acquisitions', label: 'Acquisitions' },
              ]}
              value={scope}
              onChange={(v) => setScope(v as InventoryScope)}
              aria-label="Inventory export scope"
              className="w-full flex-wrap"
            />
            <p className="text-[11px] text-slate-400 mt-1.5 leading-snug">
              {scope === 'inventory-snapshot'
                ? 'The current state of this financial year\u2019s inventory records, with an explicit As of date.'
                : 'The individual inventory acquisitions recorded during the selected period.'}
            </p>
          </div>
        )}

        {/* ── Period controls (period reports; the snapshot is As-of) ───── */}
        {isSnapshot ? (
          <div className="bg-slate-50 border border-slate-200 rounded-lg px-3.5 py-3 flex items-center gap-2.5">
            <CalendarRange className="w-4 h-4 text-slate-400 shrink-0" />
            <p className="text-xs text-slate-600">
              Snapshot reports show the current state — exported{' '}
              <span className="font-semibold text-slate-800">as of {formatDateLabel(today)}</span>. No period selection
              applies.
            </p>
          </div>
        ) : (
          <>
            <div>
              <DialogFieldLabel>Period</DialogFieldLabel>
              <SegmentedTabs
                tabs={EXPORT_PRESETS.map((p) => ({ value: p.value, label: p.label }))}
                value={preset}
                onChange={(v) => {
                  const next = v as ExportPreset
                  setPreset(next)
                  // Seed the date fields with the new preset's resolved
                  // bounds — editing either one switches to Custom.
                  setCustom(resolveExportPeriod(next, fy, custom, today))
                }}
                aria-label="Export period preset"
                className="w-full flex-wrap"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <DialogDateInput
                label="From date"
                value={preset === 'custom' ? custom.from : resolved.from}
                min={fyStart}
                max={fyEnd}
                disabled={preset !== 'custom'}
                onChange={(v) => setCustomDate('from', v)}
              />
              <DialogDateInput
                label="To date"
                value={preset === 'custom' ? custom.to : resolved.to}
                min={fyStart}
                max={fyEnd}
                disabled={preset !== 'custom'}
                onChange={(v) => setCustomDate('to', v)}
              />
            </div>

            <div
              className={cn(
                'rounded-lg px-3.5 py-2.5 flex items-center gap-2.5 border',
                rangeEmpty || invalidCustom
                  ? 'bg-amber-50 border-amber-200'
                  : 'bg-slate-50 border-slate-200',
              )}
            >
              {rangeEmpty || invalidCustom ? (
                <AlertCircle className="w-4 h-4 text-amber-500 shrink-0" />
              ) : (
                <CalendarRange className="w-4 h-4 text-slate-400 shrink-0" />
              )}
              <p className="text-xs text-slate-600 leading-snug">
                {invalidCustom
                  ? 'Choose both dates for the custom period.'
                  : rangeEmpty
                    ? 'The selected period has no dates inside this financial year — switch the period or the financial year.'
                    : (
                      <>
                        Reporting period{' '}
                        <span className="font-semibold text-slate-800">
                          {formatDateLabel(resolved.from)} – {formatDateLabel(resolved.to)}
                        </span>{' '}
                        (inclusive).
                      </>
                    )}
              </p>
            </div>
          </>
        )}

        {failed && (
          <p className="text-[11px] text-rose-600 leading-snug">
            The export failed before the workbook was written. Nothing was downloaded — try again.
          </p>
        )}
      </div>
    </Modal>
  )
}

function DialogFieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[10px] font-bold tracking-[0.08em] uppercase text-slate-400 mb-1.5">{children}</p>
  )
}

function DialogDateInput({
  label,
  value,
  min,
  max,
  disabled,
  onChange,
}: {
  label: string
  value: string
  min: string
  max: string
  disabled?: boolean
  onChange: (value: string) => void
}) {
  return (
    <label className="block">
      <span className="text-[10px] font-bold tracking-[0.08em] uppercase text-slate-400 mb-1.5 block">{label}</span>
      <input
        type="date"
        aria-label={label}
        value={value}
        min={min}
        max={max}
        disabled={disabled}
        onChange={(e) => e.target.value && onChange(e.target.value)}
        className={cn(
          'h-9 w-full rounded-lg border border-slate-300 bg-white px-2.5 text-xs text-slate-900 tabular-nums shadow-sm transition-colors',
          'focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent',
          disabled && 'text-slate-400 bg-slate-50 cursor-default',
        )}
      />
    </label>
  )
}
