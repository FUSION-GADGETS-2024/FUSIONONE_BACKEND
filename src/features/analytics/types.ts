/**
 * Analytics domain types — the ONE normalized dataset every analytics view,
 * notice detector and Excel report is derived from.
 *
 * The shapes mirror the Supabase business tables exactly (the fold loads
 * them once per financial year; see fold.ts). All money columns arrive from
 * PostgREST as NUMERIC and are therefore `number | string` until the pure
 * metric functions coerce them (see metrics.ts `num`).
 */

// ── Period model ────────────────────────────────────────────────────────────

/** A resolved, FY-clamped inclusive business date range (YYYY-MM-DD). */
export interface DateRange {
  from: string
  to: string
}

/**
 * The shared Analytics filter model (spec: ONE normalized filter/query model
 * reused by Overview, Sales, Money, Inventory and Reports).
 *
 * `preset` records HOW the range was chosen; `from`/`to` are always the
 * authoritative resolved bounds (already clamped into the selected FY).
 */
export type PeriodPreset = 'fy' | 'month' | 'quarter' | 'custom'

export interface AnalyticsPeriod extends DateRange {
  preset: PeriodPreset
}

// ── Fold row shapes (Supabase projections) ─────────────────────────────────

export interface AnalyticsSaleRow {
  id: string
  bill_number: string
  /** Business date (DATE column) — the ONLY date sales metrics use. */
  date: string
  party_id: string
  party_name: string | null
  total: number | string
  discount: number | string
  trade_in_credit: number | string
  final_total: number | string
  paid: number | string
  due: number | string
  status: 'active' | 'cancelled'
  created_at: string
  proforma_id?: string | null
}

export interface AnalyticsPurchaseRow {
  id: string
  bill_number: string
  /** Business date (DATE column). */
  date: string
  party_id: string
  party_name: string | null
  total: number | string
  paid: number | string
  due: number | string
  status: 'active' | 'cancelled'
  created_at: string
  /**
   * TRUE for virtual acquisition bills — the internal accounting
   * representation of receiving a trade-in device (hidden `PUR-TRD-…`
   * bills created by create_sale, and recovery bills created by
   * create_trade_in_purchase_bill). No money moves for these: paid=total,
   * due=0 and no payments rows exist. Derived once by the fold via the
   * shared `isVirtualAcquisition` rule (all line items reference
   * trade-in-sourced inventory, or the PUR-TRD- bill prefix).
   */
  is_virtual: boolean
}

export interface AnalyticsSaleItemRow {
  sale_id: string
  sold_price: number | string
  inventory_items: {
    id: string
    brand: string | null
    model: string | null
    imei: string | null
    ram_rom: string | null
    color: string | null
    base_selling_price: number | string | null
    purchase_price: number | string | null
    status: string | null
    source: string | null
  } | null
}

export interface AnalyticsPurchaseItemRow {
  purchase_id: string
  inventory_items: {
    id: string
    brand: string | null
    model: string | null
    imei: string | null
    ram_rom: string | null
    color: string | null
    /** The item-level acquisition cost (inventory purchase_price). */
    purchase_price: number | string | null
    source: string | null
  } | null
}

export interface AnalyticsPaymentInRow {
  id: string
  sale_id: string | null
  party_id: string
  party_name: string | null
  amount: number | string
  /** Business date (DATE column). */
  date: string
  created_at: string
  bank_account_id: string
  payment_mode_id: string | null
  sale_bill_number: string | null
  bank_name: string | null
  bank_is_cash: boolean | null
  mode_name: string | null
}

export interface AnalyticsPaymentOutRow {
  id: string
  purchase_id: string | null
  party_id: string
  party_name: string | null
  amount: number | string
  /** Business date (DATE column). */
  date: string
  created_at: string
  bank_account_id: string
  payment_mode_id: string | null
  purchase_bill_number: string | null
  bank_name: string | null
  bank_is_cash: boolean | null
  mode_name: string | null
}

export interface AnalyticsInventoryRow {
  id: string
  brand: string
  model: string
  imei: string
  ram_rom: string | null
  color: string | null
  purchase_price: number | string
  base_selling_price: number | string
  status: 'in_stock' | 'sold'
  source: 'purchase' | 'trade_in'
  created_at: string
  origin_inventory_item_id: string | null
  opening_entry_type: 'direct' | 'carried_forward' | null
}

export interface AnalyticsTradeInRow {
  id: string
  sale_id: string
  inventory_item_id: string
  credit_value: number | string
  mrp: number | string | null
  inventory_items: {
    brand: string | null
    model: string | null
    imei: string | null
    status: string | null
    source: string | null
  } | null
}

export interface AnalyticsProformaRow {
  id: string
  bill_number: string
  date: string
  status: 'active' | 'converted' | 'void'
  final_total: number | string
  party_id: string
  party_name: string | null
}

export interface BankAccountRef {
  id: string
  name: string
  is_cash: boolean
}

export interface PaymentModeRef {
  id: string
  name: string
  bank_account_id: string
}

/**
 * One row of the authoritative account ledger (account_transactions) —
 * the record of genuine account movements: every payment, every payment
 * made at document creation, every cancellation reversal, transfers and
 * opening balances. This is the source the Money Register exports.
 */
export interface AnalyticsAccountTransactionRow {
  id: string
  bank_account_id: string
  payment_mode_id: string | null
  type: 'credit' | 'debit'
  amount: number | string
  /** Business date (DATE column) — the ONLY date money metrics use. */
  date: string
  reference_type:
    | 'sale'
    | 'purchase'
    | 'payment_in'
    | 'payment_out'
    | 'add_funds'
    | 'transfer'
    | 'opening_balance'
    | 'sale_cancelled'
  reference_id: string
  notes: string | null
  transfer_group_id: string | null
  created_at: string
}

/** Party directory entry (name/number for customer-facing sheets). */
export interface PartyRef {
  id: string
  name: string
  number: string | null
}

/** Acquisition timeline row — the origin-chain lookup for true stock age. */
export interface InventoryTimelineRow {
  id: string
  created_at: string
  origin_inventory_item_id: string | null
}

// ── The fold ────────────────────────────────────────────────────────────────

/** The FY-scoped analytics dataset (see useAnalyticsFold). */
export interface AnalyticsFold {
  fyId: string
  sales: AnalyticsSaleRow[]
  purchases: AnalyticsPurchaseRow[]
  saleItems: AnalyticsSaleItemRow[]
  purchaseItems: AnalyticsPurchaseItemRow[]
  paymentsIn: AnalyticsPaymentInRow[]
  paymentsOut: AnalyticsPaymentOutRow[]
  /** The FY's account-ledger movements (the Money Register source). */
  accountTransactions: AnalyticsAccountTransactionRow[]
  /** The FY's full inventory (both in_stock and sold). */
  inventory: AnalyticsInventoryRow[]
  tradeIns: AnalyticsTradeInRow[]
  proformas: AnalyticsProformaRow[]
  /** Every inventory row across ALL financial years (id/created_at/origin). */
  timeline: InventoryTimelineRow[]
  bankAccounts: BankAccountRef[]
  paymentModes: PaymentModeRef[]
  parties: PartyRef[]
}
