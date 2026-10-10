/**
 * Document data builders — map raw Supabase rows into the canonical document
 * models (InvoiceData / ReceiptData / StatementData) consumed by the renderers.
 *
 * The business math is preserved EXACTLY as it renders in production:
 *   - per-line qty = 1
 *   - rate = inventory_items.base_selling_price (fallback sold_price) for sales
 *   - discount = max(0, base − sold)
 *   - displayed subtotal = Σ base_selling_price (NOT sales.total = Σ sold_price)
 *   - item_discount = Σ line discounts; discount = item + additional
 *   - trade-in rate = credit_value (mrp carried separately)
 *
 * PostgREST NUMERIC columns arrive as strings — every value is coerced
 * through n() so no NaN or string-concatenation bugs can occur.
 */
import type {
  InvoiceData,
  InvoiceLineItem,
  InvoiceTradeIn,
  PaymentDirection,
  ReceiptData,
  StatementData,
} from './types.js';
import type { PaymentReceiptRows, PaymentStatementRows, ProformaInvoiceRows, SaleTradeInRow } from './repository.js';

function n(v: unknown): number {
  return Number(v) || 0;
}

// ─── Invoices ───────────────────────────────────────────────────────────────

export function buildSaleInvoiceData({
  sale,
  items,
  tradeIns,
  store,
}: {
  sale: any;
  items: any[];
  tradeIns: SaleTradeInRow[];
  store: any;
}): InvoiceData {
  const mappedItems: InvoiceLineItem[] = items.map((line) => {
    const inv = line.inventory_items || {};
    const base = n(inv.base_selling_price) || n(line.sold_price);
    const sold = n(line.sold_price);
    return {
      brand: inv.brand,
      model: inv.model,
      imei: inv.imei,
      ram_rom: inv.ram_rom,
      color: inv.color,
      qty: 1,
      rate: base,
      discount: Math.max(0, base - sold),
      value: sold,
    };
  });

  const itemDiscount = mappedItems.reduce((s, i) => s + (i.discount ?? 0), 0);
  const subtotal = mappedItems.reduce((s, i) => s + (i.rate ?? 0), 0);
  const additionalDiscount = n(sale.discount);

  // Trade-in device identity is resolved through the Inventory relationship
  // (the single authoritative source) — never from a second copy.
  const mappedTradeIns: InvoiceTradeIn[] = tradeIns.map((ti) => ({
    brand: ti.inventory_items?.brand ?? undefined,
    model: ti.inventory_items?.model ?? undefined,
    imei: ti.inventory_items?.imei ?? undefined,
    qty: 1,
    rate: n(ti.credit_value),
    credit_value: n(ti.credit_value),
    mrp: n(ti.mrp) || undefined,
  }));

  return {
    type: 'sale',
    store,
    bill_number: sale.bill_number,
    date: sale.date,
    party: sale.parties ?? null,
    items: mappedItems,
    subtotal,
    item_discount: itemDiscount,
    additional_discount: additionalDiscount,
    discount: itemDiscount + additionalDiscount,
    trade_in_credit: n(sale.trade_in_credit),
    final_total: n(sale.final_total),
    paid: n(sale.paid),
    due: n(sale.due),
    trade_ins: mappedTradeIns,
  };
}

export function buildPurchaseInvoiceData({
  purchase,
  items,
  store,
}: {
  purchase: any;
  items: any[];
  store: any;
}): InvoiceData {
  const mappedItems: InvoiceLineItem[] = items.map((line) => {
    const inv = line.inventory_items || {};
    const price = n(inv.purchase_price);
    return {
      brand: inv.brand,
      model: inv.model,
      imei: inv.imei,
      ram_rom: inv.ram_rom,
      color: inv.color,
      qty: 1,
      rate: price,
      value: price,
    };
  });

  return {
    type: 'purchase',
    store,
    bill_number: purchase.bill_number,
    date: purchase.date,
    party: purchase.parties ?? null,
    items: mappedItems,
    subtotal: n(purchase.total),
    final_total: n(purchase.total),
    paid: n(purchase.paid),
    due: n(purchase.due),
  };
}

export function buildProformaInvoiceData({
  proforma,
  items,
  tradeIns,
  store,
}: {
  proforma: any;
  items: ProformaInvoiceRows['items'];
  tradeIns: any[];
  store: any;
}): InvoiceData {
  // A quoted line is either an Inventory-backed quotation (identity from
  // the quoted device — the authoritative source) or a legacy free-text
  // line (its stored description is the historical truth).
  const mappedItems: InvoiceLineItem[] = items.map((line) => {
    if (line.inventory_item_id && line.inventory_items) {
      return {
        brand: line.inventory_items.brand ?? undefined,
        model: line.inventory_items.model ?? undefined,
        imei: line.inventory_items.imei ?? undefined,
        ram_rom: line.inventory_items.ram_rom ?? undefined,
        color: line.inventory_items.color ?? undefined,
        qty: n(line.qty),
        rate: n(line.rate),
        discount: n(line.discount),
        value: n(line.value),
      };
    }
    return {
      description: line.description ?? undefined,
      qty: n(line.qty),
      rate: n(line.rate),
      discount: n(line.discount),
      value: n(line.value),
    };
  });

  const mappedTradeIns: InvoiceTradeIn[] = tradeIns.map((ti) => ({
    description: ti.description,
    qty: n(ti.qty) || 1,
    rate: n(ti.rate),
    value: n(ti.value),
  }));

  return {
    type: 'proforma',
    store,
    bill_number: proforma.bill_number,
    date: proforma.date,
    party: proforma.parties ?? null,
    items: mappedItems,
    subtotal: n(proforma.total),
    additional_discount: n(proforma.discount),
    discount: n(proforma.discount),
    trade_in_credit: n(proforma.trade_in_credit),
    final_total: n(proforma.final_total),
    paid: 0,
    due: n(proforma.final_total),
    trade_ins: mappedTradeIns,
  };
}

// ─── Payment documents ──────────────────────────────────────────────────────

/** Deterministic receipt identifier: RCP-{IN|OUT}-{YYYYMMDD}-{id prefix}. */
export function buildReceiptNumber(paymentId: string, direction: PaymentDirection, date: string): string {
  const compactDate = (date || '').replace(/-/g, '');
  return `RCP-${direction === 'in' ? 'IN' : 'OUT'}-${compactDate}-${paymentId.replace(/-/g, '').slice(0, 8).toUpperCase()}`;
}

export function buildPaymentReceiptData(
  direction: PaymentDirection,
  { payment, invoice, store }: PaymentReceiptRows,
): ReceiptData {
  const invoiceTotal = invoice ? n(direction === 'in' ? invoice.final_total : invoice.total) : null;

  return {
    kind: 'receipt',
    direction,
    store,
    receipt_number: buildReceiptNumber(payment.id, direction, payment.date),
    date: payment.date,
    party: payment.parties ?? null,
    amount: n(payment.amount),
    payment_mode: payment.payment_modes?.name ?? null,
    bank_account: payment.bank_accounts?.name ?? null,
    invoice_number: invoice?.bill_number ?? null,
    invoice_date: invoice?.date ?? null,
    invoice_total: invoiceTotal,
    invoice_paid: invoice ? n(invoice.paid) : null,
    invoice_due: invoice ? n(invoice.due) : null,
  };
}

/** Deterministic statement identifier: STM-{IN|OUT}-{YYYYMMDD}-{invoice prefix}. */
export function buildStatementNumber(invoiceId: string, direction: PaymentDirection, date: string): string {
  const compactDate = (date || '').replace(/-/g, '');
  return `STM-${direction === 'in' ? 'IN' : 'OUT'}-${compactDate}-${invoiceId.replace(/-/g, '').slice(0, 8).toUpperCase()}`;
}

/** The statement composition date (today, YYYY-MM-DD — the history it lists
 *  is CURRENT state; the number/date pair identifies the document instance). */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function buildPaymentStatementData(
  direction: PaymentDirection,
  { invoice, payments, store }: PaymentStatementRows,
): StatementData {
  const invoiceTotal = n(direction === 'in' ? invoice.final_total : invoice.total);

  return {
    kind: 'statement',
    direction,
    store,
    statement_number: buildStatementNumber(invoice.id, direction, today()),
    date: today(),
    party: invoice.parties ?? null,
    invoice_number: invoice.bill_number ?? null,
    invoice_date: invoice.date ?? null,
    invoice_total: invoiceTotal,
    // The FULL payment history, oldest first — including the initial payment
    // recorded during invoice/bill creation.
    payments: (payments ?? []).map((p: any) => ({
      date: p.date,
      amount: n(p.amount),
      payment_mode: p.payment_modes?.name ?? null,
    })),
    // Authoritative aggregates — never recomputed from the payment list.
    total_paid: n(invoice.paid),
    balance_due: n(invoice.due),
  };
}
