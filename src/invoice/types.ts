/**
 * Canonical invoice data contract — the single shape produced by the
 * builders (builders.ts) from raw Supabase rows and consumed by the PDFKit
 * renderer (pdf.ts) and the thumbnail worker. There is exactly ONE invoice
 * design (Prestige) — the legacy six-template `template` field is
 * intentionally absent.
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
