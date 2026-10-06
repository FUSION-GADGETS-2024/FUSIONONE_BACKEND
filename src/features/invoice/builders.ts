/**
 * Invoice data assembly utilities.
 *
 * These functions convert raw Supabase rows into the canonical
 * InvoiceData shape used by renderers and review components.
 *
 * They are the single source of truth for invoice data transformation.
 */
import type { InvoiceData, InvoiceLineItem, InvoiceTradeIn } from './types';

// ── Helpers ────────────────────────────────────────────────────────────────

function n(v: any) { return Number(v) || 0; }

// ── Sale ───────────────────────────────────────────────────────────────────

export function buildSaleInvoiceData({
  sale,
  items,
  tradeIns,
  store,
}: {
  sale: any;
  items: any[];
  tradeIns: any[];
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

  const mappedTradeIns: InvoiceTradeIn[] = tradeIns.map((ti) => ({
    // Device identity resolved through the Inventory relationship (the
    // single authoritative source) — never a second copy on the trade-in.
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

// ── Purchase ───────────────────────────────────────────────────────────────

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

// ── Proforma ───────────────────────────────────────────────────────────────

export function buildProformaInvoiceData({
  proforma,
  items,
  tradeIns,
  store,
}: {
  proforma: any;
  items: any[];
  tradeIns: any[];
  store: any;
}): InvoiceData {
  // A quoted line is either an Inventory-backed quotation (identity from
  // the quoted device) or a legacy free-text line (historical truth).
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
