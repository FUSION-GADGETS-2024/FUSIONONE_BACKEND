/**
 * Normalized report data — the ONE assembly point between the shared
 * business truth and the Excel renderer (implementation spec §7–§8).
 *
 * `buildReportDatasets` folds the analytics dataset (the SAME fold the web
 * pages render from) plus the validated export period into plain,
 * serializable report datasets — one per Analytics export. Each dataset is
 * a list of worksheets, each worksheet a list of layout blocks (tables and
 * summary blocks) declared through shared column definitions. The Excel
 * renderer is a pure function of this data and performs NO business
 * calculations of its own, so the web Analytics and every export agree by
 * construction.
 *
 * Reused authoritative semantics (features/analytics/metrics.ts):
 *   - sales/invoice status, amounts received, outstanding balances
 *   - purchases with the virtual-acquisition exclusion (trade-in /
 *     recovery bills) — never prefix-only classification
 *   - the account ledger's movement and reversal semantics
 *   - inventory status, valuation and origin-chain acquisition dates
 *
 * Date semantics (implementation spec §10.2):
 *   Business Summary sales/purchases → invoice / purchase-bill date
 *   Business Summary payments        → actual payment date
 *   Sales Register                   → sales invoice date
 *   Money Register                   → actual transaction date
 *   Inventory Snapshot               → explicit current As of date
 *   Inventory Acquisitions           → qualifying acquisition date
 *   Purchase Register                → purchase-bill date
 */
import type { AnalyticsFold } from '@/features/analytics/types'
import type { AnalyticsPeriod } from '@/features/analytics/types'
import {
  acquisitionTimestamp,
  activeSalesInRange,
  dateInRange,
  inventoryValuation,
  isInternalLedgerMovement,
  ledgerTransactionType,
  moneyMetrics,
  num,
  purchasesMetrics,
  realPurchasesInRange,
  receiptNumber,
  receivablesTotal,
  payablesTotal,
  salesMetrics,
  timelineMap,
} from '@/features/analytics/metrics'
import { dateOnly, fyLabel as fyLabelText, periodLabel } from '@/features/analytics/period'
import { reportInfo } from './catalogue'
import type { ReportId } from './catalogue'

// ── Report model ─────────────────────────────────────────────────────────────

/** A cell value: text, a real number, a real date, or an honest blank. */
export type CellValue = string | number | Date | null

/** How a column's cells are formatted (drives number formats + alignment). */
export type ColumnType = 'date' | 'text' | 'money' | 'int' | 'days' | 'status'

export interface ColumnDef {
  /** Row field key. */
  key: string
  /** Business-readable header (no ids, no SQL-style names). */
  header: string
  /** Excel column width in characters. */
  width: number
  type: ColumnType
  align?: 'left' | 'right' | 'center'
  /** Include this column in the totals row. */
  total?: boolean
}

export type ReportRow = Record<string, CellValue>

/** A register-style table block. */
export interface TableBlock {
  kind: 'table'
  title?: string
  columns: ReadonlyArray<ColumnDef>
  rows: ReadonlyArray<ReportRow>
  /** Label for the totals row (sums every column with `total: true`). */
  totalsLabel?: string
  /**
   * Row field key marking INTERNAL rows (truthy) — excluded from the
   * totals. The Money Register uses this so internal account transfers and
   * opening balances are listed but never counted as business receipts or
   * payments.
   */
  internalRowKey?: string
  notes?: ReadonlyArray<string>
}

/** A key/value summary block (metrics, positions). */
export interface SummaryBlock {
  kind: 'summary'
  title?: string
  rows: ReadonlyArray<{ label: string; value: CellValue; type: ColumnType }>
  notes?: ReadonlyArray<string>
}

export type ReportBlock = TableBlock | SummaryBlock

/** One worksheet of a report. */
export interface ReportSheet {
  /** The Excel worksheet name (≤ 31 chars, unique within the workbook). */
  name: string
  blocks: ReadonlyArray<ReportBlock>
}

export interface ReportDataset {
  id: ReportId
  title: string
  sheets: ReadonlyArray<ReportSheet>
  /**
   * Snapshot reports: the explicit As of date (drives the masthead line
   * and the filename). Undefined for period reports.
   */
  asOf?: string
}

export interface ReportMeta {
  /** The configured store (the business issuing the report) — may be null. */
  storeName: string | null
  storeAddress: string | null
  storePhone: string | null
  fyLabel: string
  periodLabel: string
  from: string
  to: string
  /** ISO timestamp of generation. */
  generatedAt: string
}

export interface ReportBundle {
  meta: ReportMeta
  reports: Record<ReportId, ReportDataset>
}

export interface BuildReportsOptions {
  fold: AnalyticsFold
  period: AnalyticsPeriod
  /** The authoritative store configuration (name/address/phone). */
  store: { name?: string | null; address?: string | null; phone?: string | null } | null
  fy: { start_date: string; end_date: string } | null
  /** Generation date (YYYY-MM-DD) — injectable for determinism. */
  today?: string
  /** Generation timestamp — injectable for determinism. */
  generatedAt?: string
}

// ── Shared helpers ───────────────────────────────────────────────────────────

/** The invoice-status vocabulary (mirrors the app's invoiceStatus semantics). */
function invoiceStatus(paid: number, due: number): 'Paid' | 'Partial' | 'Unpaid' {
  if (due <= 0) return 'Paid'
  return paid > 0 ? 'Partial' : 'Unpaid'
}

/**
 * 'YYYY-MM-DD' → a UTC-midnight Date (rendered as a real Excel date cell).
 *
 * ExcelJS serializes a JS Date from its raw UTC milliseconds
 * (`25569 + d.getTime()/86400000`), so the Date MUST be constructed at
 * UTC midnight: the serial is then the exact integer Excel day and the
 * rendered date can never shift with the generating viewer's timezone.
 * (A local-midnight Date in, say, IST is 18:30 of the PREVIOUS day in
 * UTC — a serial like 46112.7708…, which Excel renders one day early:
 * the "31 March 2027 invoice inside the FY 2027-28 register" defect.)
 */
function excelDate(value: string | null | undefined): Date | null {
  if (!value) return null
  const [y, m, d] = value.slice(0, 10).split('-').map(Number)
  if (!y || !m || !d) return null
  return new Date(Date.UTC(y, m - 1, d))
}

/** Sort key for a date cell (null-safe, UTC-exact). */
function dateKey(date: Date | null): string {
  return date
    ? `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`
    : '9999-99-99'
}

/** Register ordering: by business date, then by document number. */
function byDateThenDocument(a: { date: Date | null }, b: { date: Date | null }, aDoc: string, bDoc: string): number {
  const ka = dateKey(a.date)
  const kb = dateKey(b.date)
  if (ka !== kb) return ka < kb ? -1 : 1
  return aDoc.localeCompare(bDoc)
}

/**
 * The readable item name of one device: the inventory record's brand +
 * model. Honest fallbacks only — never an invented name.
 */
function itemName(item: { brand: string | null; model: string | null } | null | undefined): string {
  if (!item) return '—'
  const name = `${item.brand ?? ''} ${item.model ?? ''}`.trim()
  return name || '—'
}

/** Item names of every device sold on one invoice, joined readably. */
function saleItemNames(fold: AnalyticsFold, saleId: string): string {
  const names = fold.saleItems
    .filter((si) => si.sale_id === saleId)
    .map((si) => itemName(si.inventory_items))
  return names.length > 0 ? names.join(', ') : '—'
}

/** Item names of every device on one purchase bill, joined readably. */
function purchaseItemNames(fold: AnalyticsFold, purchaseId: string): string {
  const names = fold.purchaseItems
    .filter((pi) => pi.purchase_id === purchaseId)
    .map((pi) => itemName(pi.inventory_items))
  return names.length > 0 ? names.join(', ') : '—'
}

/** Human RAM/Storage label ('—' when the record carries none). */
function ramRomLabel(value: string | null | undefined): string {
  return (value ?? '').trim() || '—'
}

const SALE_EXCLUSION_NOTE =
  'Cancelled invoices are excluded from this register and its totals; their retained payments and the compensating cancellation entries appear in the Money Register.'
const PURCHASE_EXCLUSION_NOTE =
  'Cancelled bills and internal trade-in acquisition and recovery bills are excluded — no money moves for those acquisitions.'
const POSITION_NOTE =
  'Outstanding balances are the current position of this financial year\u2019s active documents as of the generation date; the reporting period does not change them.'
const INVENTORY_AS_OF_NOTE =
  'The As of date marks when this snapshot was taken. Status values reflect the selected financial year\u2019s inventory records; devices carried into a later financial year continue there.'
const ACQUISITION_NOTE =
  'Acquisition dates resolve through the carry-forward origin chain, so each device counts once at its original acquisition. An item acquired in the period may already have been sold — its current status is shown.'
const MONEY_INTERNAL_NOTE =
  'Totals cover business movements only. Internal account transfers and opening-balance entries are listed for completeness but are not business-wide receipts or payments.'
const MONEY_REVERSAL_NOTE =
  'Cancellation Reversal rows refund the retained payments of cancelled sales, so a cancelled sale\u2019s retained payment and its reversal net to zero.'

// ── Dataset builders (one per report) ────────────────────────────────────────

interface DatasetContext {
  fold: AnalyticsFold
  period: AnalyticsPeriod
  today: string
  generatedAt: string
}

type DatasetBuilder = (ctx: DatasetContext) => ReportDataset

function dataset(id: ReportId, sheets: ReadonlyArray<ReportSheet>): ReportDataset {
  const info = reportInfo(id)
  return { id, title: info.title, sheets }
}

// ── Overview — Business Summary ──────────────────────────────────────────────

const businessSummary: DatasetBuilder = ({ fold, period, today }) => {
  const sales = salesMetrics(fold.sales, period)
  const purchases = purchasesMetrics(fold.purchases, period)
  const money = moneyMetrics(fold.paymentsIn, fold.paymentsOut, period)
  const valuation = inventoryValuation(fold.inventory)

  return dataset('business-summary', [
    {
      name: 'Summary',
      blocks: [
        {
          kind: 'summary',
          title: 'Period Activity',
          rows: [
            { label: 'Sales Value', value: sales.totalSales, type: 'money' },
            { label: 'Purchase Value', value: purchases.totalPurchases, type: 'money' },
            { label: 'Payments Received', value: money.moneyIn, type: 'money' },
            { label: 'Payments Made', value: money.moneyOut, type: 'money' },
            { label: 'Sales Invoices', value: sales.invoiceCount, type: 'int' },
            { label: 'Purchase Bills', value: purchases.billCount, type: 'int' },
          ],
          notes: [
            'Sales Value and Purchase Value cover documents dated within the selected period; Payments Received and Payments Made cover payment movements dated within the period.',
            PURCHASE_EXCLUSION_NOTE,
          ],
        },
        {
          kind: 'summary',
          title: 'Current Position',
          rows: [
            { label: 'Customer Outstanding', value: receivablesTotal(fold.sales), type: 'money' },
            { label: 'Supplier Outstanding', value: payablesTotal(fold.purchases), type: 'money' },
          ],
          notes: [POSITION_NOTE],
        },
        {
          kind: 'summary',
          title: 'Current Inventory Summary',
          rows: [
            { label: 'In-stock inventory records', value: valuation.units, type: 'int' },
            { label: 'Recorded acquisition cost of in-stock inventory', value: valuation.costValue, type: 'money' },
          ],
          notes: [
            'Inventory counts are record counts — one record per device; no quantities are reported.',
            INVENTORY_AS_OF_NOTE,
          ],
        },
      ],
    },
  ])
  void today
}

// ── Sales — Sales Register (register + item detail) ──────────────────────────

const salesRegister: DatasetBuilder = ({ fold, period }) => {
  const salesIndex = new Map(fold.sales.map((s) => [s.id, s]))

  const registerRows = activeSalesInRange(fold.sales, period)
    .map((s) => {
      const paid = num(s.paid)
      const due = num(s.due)
      return {
        date: excelDate(dateOnly(s.date)),
        billNumber: s.bill_number,
        itemName: saleItemNames(fold, s.id),
        customer: s.party_name ?? '—',
        total: num(s.final_total),
        received: paid,
        balance: due,
        status: invoiceStatus(paid, due),
      }
    })
    .sort((a, b) => byDateThenDocument(a, b, a.billNumber, b.billNumber))

  // One row per individual invoice item — item-level values only.
  const itemRows = fold.saleItems
    .map((si) => {
      const sale = salesIndex.get(si.sale_id)
      if (!sale || sale.status !== 'active' || !dateInRange(sale.date, period)) return null
      const inv = si.inventory_items
      return {
        billNumber: sale.bill_number,
        itemName: itemName(inv),
        imei: inv?.imei?.trim() || '—',
        ramRom: ramRomLabel(inv?.ram_rom),
        color: inv?.color?.trim() || '—',
        saleValue: num(si.sold_price),
      }
    })
    .filter((r): r is NonNullable<typeof r> => r !== null)
    .sort((a, b) => a.billNumber.localeCompare(b.billNumber) || a.itemName.localeCompare(b.itemName))

  return dataset('sales-register', [
    {
      name: 'Sales Register',
      blocks: [
        {
          kind: 'table',
          columns: [
            { key: 'date', header: 'Date', width: 12, type: 'date' },
            { key: 'billNumber', header: 'Invoice No.', width: 19, type: 'text' },
            { key: 'itemName', header: 'Item Name', width: 38, type: 'text' },
            { key: 'customer', header: 'Customer', width: 20, type: 'text' },
            { key: 'total', header: 'Total Amount', width: 14, type: 'money', align: 'right', total: true },
            { key: 'received', header: 'Received', width: 13, type: 'money', align: 'right', total: true },
            { key: 'balance', header: 'Balance', width: 13, type: 'money', align: 'right', total: true },
            { key: 'status', header: 'Status', width: 10, type: 'status', align: 'center' },
          ],
          rows: registerRows,
          totalsLabel: 'Total',
          notes: [SALE_EXCLUSION_NOTE],
        },
      ],
    },
    {
      name: 'Sale Items',
      blocks: [
        {
          kind: 'table',
          columns: [
            { key: 'billNumber', header: 'Invoice No.', width: 19, type: 'text' },
            { key: 'itemName', header: 'Item Name', width: 32, type: 'text' },
            { key: 'imei', header: 'IMEI', width: 18, type: 'text' },
            { key: 'ramRom', header: 'RAM/Storage', width: 13, type: 'text', align: 'center' },
            { key: 'color', header: 'Color', width: 14, type: 'text' },
            { key: 'saleValue', header: 'Sale Value', width: 14, type: 'money', align: 'right', total: true },
          ],
          rows: itemRows,
          totalsLabel: 'Total Item Value',
          notes: [
            'Each row is one device sold. Sale Value is the item-level amount; invoice-level totals appear exactly once on the Sales Register sheet.',
            SALE_EXCLUSION_NOTE,
          ],
        },
      ],
    },
  ])
}

// ── Money — Money Register (the authoritative account ledger) ────────────────

const moneyRegister: DatasetBuilder = ({ fold, period }) => {
  const salesById = new Map(fold.sales.map((s) => [s.id, s]))
  const purchasesById = new Map(fold.purchases.map((p) => [p.id, p]))
  const paymentsInById = new Map(fold.paymentsIn.map((p) => [p.id, p]))
  const paymentsOutById = new Map(fold.paymentsOut.map((p) => [p.id, p]))
  const accountsById = new Map(fold.bankAccounts.map((a) => [a.id, a]))
  const modesById = new Map(fold.paymentModes.map((m) => [m.id, m]))

  const rows = fold.accountTransactions
    .filter((t) => dateInRange(t.date, period))
    .map((t) => {
      // Party / reference / related bill resolve through the movement's own
      // relationships — never fabricated.
      let party = '—'
      let referenceNo: string | null = null
      let relatedBill = '—'
      if (t.reference_type === 'payment_in') {
        const payment = paymentsInById.get(t.reference_id)
        party = payment?.party_name ?? '—'
        referenceNo = receiptNumber(t.reference_id, 'in', t.date)
        relatedBill = payment?.sale_bill_number ?? '—'
      } else if (t.reference_type === 'payment_out') {
        const payment = paymentsOutById.get(t.reference_id)
        party = payment?.party_name ?? '—'
        referenceNo = receiptNumber(t.reference_id, 'out', t.date)
        relatedBill = payment?.purchase_bill_number ?? '—'
      } else if (t.reference_type === 'sale' || t.reference_type === 'sale_cancelled') {
        const sale = salesById.get(t.reference_id)
        party = sale?.party_name ?? '—'
        relatedBill = sale?.bill_number ?? '—'
      } else if (t.reference_type === 'purchase') {
        const purchase = purchasesById.get(t.reference_id)
        party = purchase?.party_name ?? '—'
        relatedBill = purchase?.bill_number ?? '—'
      }
      const account = accountsById.get(t.bank_account_id)
      const mode = t.payment_mode_id ? modesById.get(t.payment_mode_id) : undefined
      const paymentMode = mode?.name ?? (account?.is_cash === true ? 'Cash' : '—')
      const amount = num(t.amount)
      return {
        date: excelDate(dateOnly(t.date)),
        transactionType: ledgerTransactionType(t),
        party,
        referenceNo: referenceNo ?? '—',
        relatedBill,
        account: account?.name ?? '—',
        paymentMode,
        moneyIn: t.type === 'credit' ? amount : null,
        moneyOut: t.type === 'debit' ? amount : null,
        // 1 marks an internal movement (transfer / opening balance) —
        // listed in the register, excluded from the totals.
        internal: isInternalLedgerMovement(t.reference_type) ? 1 : 0,
      }
    })
    .sort((a, b) => {
      const ka = dateKey(a.date)
      const kb = dateKey(b.date)
      if (ka !== kb) return ka < kb ? -1 : 1
      return a.transactionType.localeCompare(b.transactionType) || a.relatedBill.localeCompare(b.relatedBill)
    })

  // Business totals (internal movements excluded) reconcile with the
  // included business movements.
  const businessIn = rows.reduce((a, r) => a + (!r.internal && r.moneyIn !== null ? r.moneyIn : 0), 0)
  const businessOut = rows.reduce((a, r) => a + (!r.internal && r.moneyOut !== null ? r.moneyOut : 0), 0)

  return dataset('money-register', [
    {
      name: 'Money Register',
      blocks: [
        {
          kind: 'table',
          columns: [
            { key: 'date', header: 'Date', width: 12, type: 'date' },
            { key: 'transactionType', header: 'Transaction Type', width: 20, type: 'text' },
            { key: 'party', header: 'Party', width: 20, type: 'text' },
            { key: 'referenceNo', header: 'Reference No.', width: 26, type: 'text' },
            { key: 'relatedBill', header: 'Related Bill', width: 19, type: 'text' },
            { key: 'account', header: 'Account', width: 20, type: 'text' },
            { key: 'paymentMode', header: 'Payment Mode', width: 14, type: 'text' },
            { key: 'moneyIn', header: 'Money In', width: 14, type: 'money', align: 'right', total: true },
            { key: 'moneyOut', header: 'Money Out', width: 14, type: 'money', align: 'right', total: true },
          ],
          rows,
          totalsLabel: 'Total (business movements)',
          internalRowKey: 'internal',
          notes: [MONEY_INTERNAL_NOTE, MONEY_REVERSAL_NOTE],
        },
        {
          kind: 'summary',
          title: 'Period Totals',
          rows: [
            { label: 'Money In (business movements)', value: businessIn, type: 'money' },
            { label: 'Money Out (business movements)', value: businessOut, type: 'money' },
            { label: 'Net Movement', value: businessIn - businessOut, type: 'money' },
          ],
          notes: ['Virtual trade-in credits never appear here — no account movement exists for them.'],
        },
      ],
    },
  ])
}

// ── Inventory — Snapshot and Acquisitions ────────────────────────────────────

/** The active sale that sold a given inventory item (if any). */
function saleRefByItem(fold: AnalyticsFold): Map<string, { billNumber: string; date: string }> {
  const salesById = new Map(fold.sales.filter((s) => s.status === 'active').map((s) => [s.id, s]))
  const map = new Map<string, { billNumber: string; date: string }>()
  for (const si of fold.saleItems) {
    const sale = salesById.get(si.sale_id)
    const itemId = si.inventory_items?.id
    if (!sale || !itemId || map.has(itemId)) continue
    map.set(itemId, { billNumber: sale.bill_number, date: dateOnly(sale.date) })
  }
  return map
}

/** Human source label of an inventory record. */
function sourceLabel(source: string | null): string {
  return source === 'trade_in' ? 'Trade-In' : 'Purchase'
}

/** Human current-status label of an inventory record. */
function statusLabel(status: string | null): string {
  return status === 'in_stock' ? 'In Stock' : 'Sold'
}

const inventorySnapshot: DatasetBuilder = ({ fold, today }) => {
  const timeline = timelineMap(fold.timeline)
  const saleRefs = saleRefByItem(fold)
  const valuation = inventoryValuation(fold.inventory)

  const rows = fold.inventory
    .map((i) => {
      const acquired = dateOnly(acquisitionTimestamp(i, timeline))
      const sale = saleRefs.get(i.id)
      return {
        brand: i.brand || '—',
        model: i.model || '—',
        imei: i.imei?.trim() || '—',
        ramRom: ramRomLabel(i.ram_rom),
        color: i.color?.trim() || '—',
        acquired: excelDate(acquired),
        cost: num(i.purchase_price),
        source: sourceLabel(i.source),
        status: statusLabel(i.status),
        saleBill: sale?.billNumber ?? '—',
        saleDate: sale ? excelDate(sale.date) : null,
      }
    })
    .sort((a, b) => {
      const ka = dateKey(a.acquired)
      const kb = dateKey(b.acquired)
      if (ka !== kb) return ka < kb ? -1 : 1
      return `${a.brand} ${a.model}`.localeCompare(`${b.brand} ${b.model}`)
    })

  const snapshot = dataset('inventory-snapshot', [
    {
      name: 'Inventory Register',
      blocks: [
        {
          kind: 'table',
          columns: [
            { key: 'brand', header: 'Brand', width: 13, type: 'text' },
            { key: 'model', header: 'Model', width: 22, type: 'text' },
            { key: 'imei', header: 'IMEI', width: 18, type: 'text' },
            { key: 'ramRom', header: 'RAM/Storage', width: 13, type: 'text', align: 'center' },
            { key: 'color', header: 'Color', width: 14, type: 'text' },
            { key: 'acquired', header: 'Acquisition Date', width: 16, type: 'date' },
            { key: 'cost', header: 'Acquisition Cost', width: 15, type: 'money', align: 'right', total: true },
            { key: 'source', header: 'Source', width: 11, type: 'text', align: 'center' },
            { key: 'status', header: 'Current Status', width: 14, type: 'status', align: 'center' },
            { key: 'saleBill', header: 'Sale Invoice No.', width: 19, type: 'text' },
            { key: 'saleDate', header: 'Sale Date', width: 12, type: 'date' },
          ],
          rows,
          totalsLabel: 'Total Acquisition Cost (all records)',
          notes: [
            'Each row is one inventory record — no quantities are reported.',
            INVENTORY_AS_OF_NOTE,
          ],
        },
        {
          kind: 'summary',
          title: 'Current Inventory Valuation',
          rows: [
            { label: 'In-stock inventory records', value: valuation.units, type: 'int' },
            { label: 'Recorded acquisition cost of in-stock inventory', value: valuation.costValue, type: 'money' },
          ],
          notes: [
            'The valuation is the recorded acquisition cost of in-stock records — it is not a market value, selling value or profit measure.',
          ],
        },
      ],
    },
  ])
  snapshot.asOf = today
  return snapshot
}

const inventoryAcquisitions: DatasetBuilder = ({ fold, period }) => {
  const timeline = timelineMap(fold.timeline)
  const saleRefs = saleRefByItem(fold)

  const rows = fold.inventory
    .map((i) => ({ row: i, acquired: dateOnly(acquisitionTimestamp(i, timeline)) }))
    .filter(({ acquired }) => dateInRange(acquired, period))
    .map(({ row, acquired }) => {
      const sale = saleRefs.get(row.id)
      return {
        brand: row.brand || '—',
        model: row.model || '—',
        imei: row.imei?.trim() || '—',
        ramRom: ramRomLabel(row.ram_rom),
        color: row.color?.trim() || '—',
        acquired: excelDate(acquired),
        cost: num(row.purchase_price),
        source: sourceLabel(row.source),
        status: statusLabel(row.status),
        saleBill: sale?.billNumber ?? '—',
        saleDate: sale ? excelDate(sale.date) : null,
      }
    })
    .sort((a, b) => {
      const ka = dateKey(a.acquired)
      const kb = dateKey(b.acquired)
      if (ka !== kb) return ka < kb ? -1 : 1
      return `${a.brand} ${a.model}`.localeCompare(`${b.brand} ${b.model}`)
    })

  const totalCost = rows.reduce((a, r) => a + (typeof r.cost === 'number' ? r.cost : 0), 0)
  const inStock = rows.filter((r) => r.status === 'In Stock').length
  const sold = rows.filter((r) => r.status === 'Sold').length

  return dataset('inventory-acquisitions', [
    {
      name: 'Inventory Acquisitions',
      blocks: [
        {
          kind: 'table',
          columns: [
            { key: 'brand', header: 'Brand', width: 13, type: 'text' },
            { key: 'model', header: 'Model', width: 22, type: 'text' },
            { key: 'imei', header: 'IMEI', width: 18, type: 'text' },
            { key: 'ramRom', header: 'RAM/Storage', width: 13, type: 'text', align: 'center' },
            { key: 'color', header: 'Color', width: 14, type: 'text' },
            { key: 'acquired', header: 'Acquisition Date', width: 16, type: 'date' },
            { key: 'cost', header: 'Acquisition Cost', width: 15, type: 'money', align: 'right', total: true },
            { key: 'source', header: 'Source', width: 11, type: 'text', align: 'center' },
            { key: 'status', header: 'Current Status', width: 14, type: 'status', align: 'center' },
            { key: 'saleBill', header: 'Sale Invoice No.', width: 19, type: 'text' },
            { key: 'saleDate', header: 'Sale Date', width: 12, type: 'date' },
          ],
          rows,
          totalsLabel: 'Total Acquisition Cost',
          notes: [ACQUISITION_NOTE],
        },
        {
          kind: 'summary',
          title: 'Acquisitions in Period',
          rows: [
            { label: 'Acquired records', value: rows.length, type: 'int' },
            { label: 'Still in stock', value: inStock, type: 'int' },
            { label: 'Already sold', value: sold, type: 'int' },
            { label: 'Recorded acquisition cost', value: totalCost, type: 'money' },
          ],
          notes: ['Counts are record counts — one record per device; no quantities are reported.'],
        },
      ],
    },
  ])
}

// ── Purchase — Purchase Register (register + item detail) ────────────────────

const purchaseRegister: DatasetBuilder = ({ fold, period }) => {
  const purchasesIndex = new Map(fold.purchases.map((p) => [p.id, p]))

  const registerRows = realPurchasesInRange(fold.purchases, period)
    .map((p) => {
      const paid = num(p.paid)
      const due = num(p.due)
      return {
        date: excelDate(dateOnly(p.date)),
        billNumber: p.bill_number,
        itemName: purchaseItemNames(fold, p.id),
        supplier: p.party_name ?? '—',
        total: num(p.total),
        paid,
        balance: due,
        status: invoiceStatus(paid, due),
      }
    })
    .sort((a, b) => byDateThenDocument(a, b, a.billNumber, b.billNumber))

  // One row per acquired device associated with an included bill —
  // item-level costs only, bill totals never duplicated.
  const itemRows = fold.purchaseItems
    .map((pi) => {
      const purchase = purchasesIndex.get(pi.purchase_id)
      if (!purchase || purchase.status !== 'active' || purchase.is_virtual || !dateInRange(purchase.date, period)) return null
      const inv = pi.inventory_items
      return {
        billNumber: purchase.bill_number,
        itemName: itemName(inv),
        imei: inv?.imei?.trim() || '—',
        ramRom: ramRomLabel(inv?.ram_rom),
        color: inv?.color?.trim() || '—',
        cost: inv?.purchase_price != null ? num(inv.purchase_price) : null,
      }
    })
    .filter((r): r is NonNullable<typeof r> => r !== null)
    .sort((a, b) => a.billNumber.localeCompare(b.billNumber) || a.itemName.localeCompare(b.itemName))

  return dataset('purchase-register', [
    {
      name: 'Purchase Register',
      blocks: [
        {
          kind: 'table',
          columns: [
            { key: 'date', header: 'Date', width: 12, type: 'date' },
            { key: 'billNumber', header: 'Purchase Bill No.', width: 21, type: 'text' },
            { key: 'itemName', header: 'Item Name', width: 38, type: 'text' },
            { key: 'supplier', header: 'Supplier', width: 20, type: 'text' },
            { key: 'total', header: 'Total Amount', width: 14, type: 'money', align: 'right', total: true },
            { key: 'paid', header: 'Paid', width: 13, type: 'money', align: 'right', total: true },
            { key: 'balance', header: 'Balance', width: 13, type: 'money', align: 'right', total: true },
            { key: 'status', header: 'Status', width: 10, type: 'status', align: 'center' },
          ],
          rows: registerRows,
          totalsLabel: 'Total',
          notes: [PURCHASE_EXCLUSION_NOTE],
        },
      ],
    },
    {
      name: 'Purchase Items',
      blocks: [
        {
          kind: 'table',
          columns: [
            { key: 'billNumber', header: 'Purchase Bill No.', width: 21, type: 'text' },
            { key: 'itemName', header: 'Item Name', width: 32, type: 'text' },
            { key: 'imei', header: 'IMEI', width: 18, type: 'text' },
            { key: 'ramRom', header: 'RAM/Storage', width: 13, type: 'text', align: 'center' },
            { key: 'color', header: 'Color', width: 14, type: 'text' },
            { key: 'cost', header: 'Acquisition Cost', width: 15, type: 'money', align: 'right', total: true },
          ],
          rows: itemRows,
          totalsLabel: 'Total Item Cost',
          notes: [
            'Each row is one acquired device. Acquisition Cost is the item-level cost; bill-level totals appear exactly once on the Purchase Register sheet.',
            PURCHASE_EXCLUSION_NOTE,
          ],
        },
      ],
    },
  ])
}

// ── Assembly ─────────────────────────────────────────────────────────────────

const BUILDERS: Record<ReportId, DatasetBuilder> = {
  'business-summary': businessSummary,
  'sales-register': salesRegister,
  'money-register': moneyRegister,
  'inventory-snapshot': inventorySnapshot,
  'inventory-acquisitions': inventoryAcquisitions,
  'purchase-register': purchaseRegister,
}

/**
 * Builds every report dataset from the shared fold and the validated
 * export period. Pure and synchronous — the caller supplies `today` and
 * `generatedAt` (injectable for deterministic tests).
 */
export function buildReportDatasets(options: BuildReportsOptions): ReportBundle {
  const { fold, period, store, fy } = options
  const generatedAt = options.generatedAt ?? new Date().toISOString()
  const today = options.today ?? generatedAt.slice(0, 10)

  const meta: ReportMeta = {
    storeName: store?.name?.trim() || null,
    storeAddress: store?.address?.trim() || null,
    storePhone: store?.phone?.trim() || null,
    fyLabel: fyLabelText(fy),
    periodLabel: periodLabel(period),
    from: period.from,
    to: period.to,
    generatedAt,
  }

  const ctx: DatasetContext = { fold, period, today, generatedAt }
  const reports = {} as Record<ReportId, ReportDataset>
  for (const [id, build] of Object.entries(BUILDERS) as Array<[ReportId, DatasetBuilder]>) {
    reports[id] = build(ctx)
  }

  return { meta, reports }
}
