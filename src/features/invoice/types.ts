/**
 * Canonical invoice data contract.
 * Shared between the review UI, server routes, and client actions.
 *
 * There is exactly ONE invoice design (Prestige, rendered by PDFKit) — the
 * legacy multi-template system (TemplateVariant / data.template) is gone.
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
