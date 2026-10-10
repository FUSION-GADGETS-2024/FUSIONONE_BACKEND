/**
 * The report catalogue — the ONE declarative definition of every Excel
 * export the Analytics tabs offer (implementation spec §6–§7).
 *
 * Exactly five reports exist, one per Analytics tab (Inventory offers two
 * scopes through the same shared dialog):
 *
 *   Overview  → Business Summary
 *   Sales     → Sales Register (register + item detail)
 *   Money     → Money Register (the account-ledger movements)
 *   Inventory → Current Inventory Snapshot  |  Inventory Acquisitions
 *   Purchase  → Purchase Register (register + item detail)
 *
 * Reports are actions inside their Analytics tab — there is no separate
 * Reports destination, no master workbook and no overlapping catalogue.
 *
 * A catalogue entry is pure metadata: identity, naming and date semantics.
 * The data assembly (features/reports/data.ts) and the shared Excel
 * renderer (features/reports/excel/renderer.ts) are driven by these
 * definitions — there is no per-report exporter and no per-report
 * rendering code.
 */

export type ReportId =
  | 'business-summary'
  | 'sales-register'
  | 'money-register'
  | 'inventory-snapshot'
  | 'inventory-acquisitions'
  | 'purchase-register'

/** How a report is dated (drives the export dialog and the masthead). */
export type ReportDateKind = 'period' | 'as-of'

export interface ReportInfo {
  id: ReportId
  /** The human report title (workbook heading + export dialog subject). */
  title: string
  /** The export dialog's title, e.g. "Export Sales Register". */
  dialogTitle: string
  /** The filename fragment, e.g. "Sales_Register". */
  filenameSlug: string
  /** One-line explanation shown in the export dialog. */
  description: string
  dateKind: ReportDateKind
}

/** The complete catalogue, keyed by the Analytics tab that owns each export. */
export const REPORTS: ReadonlyArray<ReportInfo> = [
  {
    id: 'business-summary',
    title: 'Business Summary',
    dialogTitle: 'Export Business Summary',
    filenameSlug: 'Business_Summary',
    description: 'Period activity (sales, purchases, payments) beside current outstanding balances and the current inventory position.',
    dateKind: 'period',
  },
  {
    id: 'sales-register',
    title: 'Sales Register',
    dialogTitle: 'Export Sales Register',
    filenameSlug: 'Sales_Register',
    description: 'Every qualifying sales invoice in the period, with a Sale Items worksheet for the individual devices sold.',
    dateKind: 'period',
  },
  {
    id: 'money-register',
    title: 'Money Register',
    dialogTitle: 'Export Money Register',
    filenameSlug: 'Money_Register',
    description: 'The actual account movements in the period — payments, reversals and classified transfers — from the authoritative ledger.',
    dateKind: 'period',
  },
  {
    id: 'inventory-snapshot',
    title: 'Current Inventory Snapshot',
    dialogTitle: 'Export Current Inventory Snapshot',
    filenameSlug: 'Inventory_Snapshot',
    description: 'The current state of every inventory record in this financial year, with an explicit As of date.',
    dateKind: 'as-of',
  },
  {
    id: 'inventory-acquisitions',
    title: 'Inventory Acquisitions',
    dialogTitle: 'Export Inventory Acquisitions',
    filenameSlug: 'Inventory_Acquisitions',
    description: 'The individual inventory acquisitions recorded during the selected period, with each device\u2019s current status.',
    dateKind: 'period',
  },
  {
    id: 'purchase-register',
    title: 'Purchase Register',
    dialogTitle: 'Export Purchase Register',
    filenameSlug: 'Purchase_Register',
    description: 'Every qualifying supplier purchase bill in the period, with a Purchase Items worksheet for the acquired devices.',
    dateKind: 'period',
  },
]

const BY_ID = new Map<ReportId, ReportInfo>(REPORTS.map((r) => [r.id, r]))

/** Catalogue lookup by report id. */
export function reportInfo(id: ReportId): ReportInfo {
  const info = BY_ID.get(id)
  if (!info) throw new Error(`Unknown report: ${id}`)
  return info
}
