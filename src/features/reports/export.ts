/**
 * Report export actions — the ONE user-facing export API (the Analytics
 * tabs' Export action is a thin wrapper over this). Builds the normalized
 * report dataset from the shared analytics fold + the VALIDATED export
 * period + the authoritative store configuration, composes the workbook
 * through the shared renderer, and delivers it as a browser download with
 * the store-branded filename.
 *
 * The same validated period controls the query, the report calculations,
 * the workbook metadata AND the filename (implementation spec §10.2).
 */
import type { AnalyticsFold } from '@/features/analytics/types'
import type { AnalyticsPeriod } from '@/features/analytics/types'
import { buildReportDatasets } from './data'
import { reportInfo } from './catalogue'
import type { ReportId } from './catalogue'
import { buildReportWorkbook } from './excel/workbook'

/** The authoritative store fields used for report branding. */
export interface ReportStoreInput {
  name?: string | null
  address?: string | null
  phone?: string | null
}

export interface ReportExportInput {
  fold: AnalyticsFold
  /** The VALIDATED, inclusive export period selected in the export dialog. */
  period: AnalyticsPeriod
  store: ReportStoreInput | null
  fy: { start_date: string; end_date: string } | null
}

// ── Filenames ────────────────────────────────────────────────────────────────

/** Sanitizes a label for filenames (spec §9: meaningful and safe). */
export function slug(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

/**
 * The financial-year fragment of a filename: "FY2026-2027" from the FY's
 * own start/end years (the years of the selected period as the honest
 * fallback when no financial year is known).
 */
export function fyFilenameFragment(
  fy: { start_date: string; end_date: string } | null,
  period: { from: string; to: string },
): string {
  const start = (fy ? fy.start_date : period.from).slice(0, 4)
  const end = (fy ? fy.end_date : period.to).slice(0, 4)
  return `FY${start}-${end}`
}

/**
 * The canonical report filename: the sanitized STORE name, the report name
 * and the financial year — e.g. "Fusion-Gadgets-E2E_Sales_Register_FY2026-2027.xlsx"
 * (implementation spec §7). Snapshot reports carry the As of date instead
 * of the financial year — "…_Inventory_Snapshot_2026-10-09.xlsx". When no
 * store name is configured the filename stays clean rather than
 * substituting a fictional business name.
 */
export function reportFilename(input: ReportExportInput, id: ReportId, asOf?: string): string {
  const info = reportInfo(id)
  const store = input.store?.name?.trim() ? slug(input.store.name) : null
  const when =
    info.dateKind === 'as-of' && asOf
      ? asOf.slice(0, 10)
      : fyFilenameFragment(input.fy, input.period)
  const parts = [store, info.filenameSlug, when]
  return `${parts.filter(Boolean).join('_')}.xlsx`
}

// ── Download ─────────────────────────────────────────────────────────────────

function triggerDownload(bytes: Uint8Array, filename: string): void {
  const blob = new Blob([bytes as BlobPart], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

// ── Exports ──────────────────────────────────────────────────────────────────

/**
 * Exports one report. The validated `period` drives the dataset, the
 * workbook's displayed period and the filename; snapshot reports derive
 * their As of date from the same input's generation date.
 */
export async function exportReport(id: ReportId, input: ReportExportInput): Promise<string> {
  const bundle = buildReportDatasets({
    fold: input.fold,
    period: input.period,
    store: input.store,
    fy: input.fy,
  })
  const dataset = bundle.reports[id]
  const bytes = await buildReportWorkbook(bundle.meta, dataset)
  const filename = reportFilename(input, id, dataset.asOf)
  triggerDownload(bytes, filename)
  return filename
}
