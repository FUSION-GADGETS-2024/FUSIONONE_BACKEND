/**
 * Canonical document data contracts — the shapes produced by the builders
 * from raw Supabase rows and consumed by the PDF renderers and the thumbnail
 * worker. One Prestige design for every document type.
 */

export interface InvoiceStore {
  name?: string;
  address?: string;
  phone?: string;
  email?: string;
  website?: string;
  gstin?: string;
  logo_url?: string;
  signature_url?: string;
}

export interface InvoiceParty {
  name?: string;
  number?: string;
  address?: string;
}

export interface InvoiceLineItem {
  brand?: string;
  model?: string;
  imei?: string;
  ram_rom?: string;
  color?: string;
  price?: number;
  description?: string;
  qty?: number;
  rate?: number;
  discount?: number;
  value?: number;
}

export interface InvoiceTradeIn {
  brand?: string;
  model?: string;
  imei?: string;
  credit_value?: number;
  mrp?: number;
  description?: string;
  qty?: number;
  rate?: number;
  value?: number;
}

export type InvoiceType = 'sale' | 'purchase' | 'proforma';

export const INVOICE_TYPES: readonly InvoiceType[] = ['sale', 'purchase', 'proforma'] as const;

export interface InvoiceData {
  type: InvoiceType;
  store: InvoiceStore | null;
  bill_number: string;
  date: string;
  party: InvoiceParty | null;
  items: InvoiceLineItem[];
  subtotal: number;
  item_discount?: number;
  additional_discount?: number;
  discount?: number;
  trade_in_credit?: number;
  final_total: number;
  paid: number;
  due: number;
  trade_ins?: InvoiceTradeIn[];
}

// ─── Payment receipt ────────────────────────────────────────────────────────
// The receipt represents the payment that actually occurred — the amount is
// the payment record's amount; invoice figures appear only as contextual
// reference (loaded CURRENT at composition time).

export type PaymentDirection = 'in' | 'out';

export const PAYMENT_DIRECTIONS: readonly PaymentDirection[] = ['in', 'out'] as const;

export interface ReceiptData {
  kind: 'receipt';
  direction: PaymentDirection;
  store: InvoiceStore | null;
  /** Deterministic receipt identifier, e.g. RCP-IN-20260303-A1B2C3D4. */
  receipt_number: string;
  /** The payment date (YYYY-MM-DD). */
  date: string;
  party: InvoiceParty | null;
  /** The payment amount (the receipt's subject). */
  amount: number;
  /** Human-readable payment mode label (e.g. 'UPI', 'Cash'). */
  payment_mode: string | null;
  /** Human-readable bank account label. */
  bank_account: string | null;
  /** The linked invoice bill number, when the payment is invoice-bound. */
  invoice_number: string | null;
  invoice_date: string | null;
  /** CURRENT invoice totals at composition time (context only). */
  invoice_total: number | null;
  invoice_paid: number | null;
  invoice_due: number | null;
}

// ─── Payment statement ──────────────────────────────────────────────────────
// A Payment Statement represents the PAYMENT HISTORY for one invoice/bill —
// the counterpart to the receipt (ONE payment). Composed from CURRENT
// authoritative data at send time: the payment list comes from the
// authoritative payment records, and the aggregate paid/due come from the
// invoice/bill row — never from a snapshot, never recomputed in the frontend.

/** One row of the statement's payment history (loaded from the DB). */
export interface StatementPaymentEntry {
  /** Payment date (YYYY-MM-DD). */
  date: string;
  amount: number;
  /** Human-readable payment mode label (e.g. 'UPI', 'Cash'). */
  payment_mode: string | null;
}

export interface StatementData {
  kind: 'statement';
  direction: PaymentDirection;
  store: InvoiceStore | null;
  /** Deterministic statement identifier, e.g. STM-IN-20260303-A1B2C3D4. */
  statement_number: string;
  /** The statement composition date (YYYY-MM-DD). */
  date: string;
  party: InvoiceParty | null;
  /** The related invoice/bill. */
  invoice_number: string | null;
  invoice_date: string | null;
  invoice_total: number | null;
  /** ALL payments against the invoice/bill — including the initial payment
   *  recorded during invoice/bill creation. */
  payments: StatementPaymentEntry[];
  /** Authoritative aggregate state (sales.paid / purchases.paid). */
  total_paid: number | null;
  /** Authoritative outstanding balance (sales.due / purchases.due). */
  balance_due: number | null;
}

/** Every supported document kind (the unified document asset contract). */
export type DocumentKind = 'invoice' | 'receipt' | 'statement';
