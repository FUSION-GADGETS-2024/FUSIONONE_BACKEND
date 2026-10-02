/**
 * Invoice repository — authoritative Supabase data access. Loads everything
 * required to render and send an invoice, keyed ONLY by invoice id + type,
 * always through the caller-scoped client (user JWT + RLS — the secret key
 * is never used for these reads).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { AppError, ErrorCode } from '../errors/registry.js';
import { getUserClient } from '../supabase/clients.js';
import type { WhatsAppSettingsRow } from './delivery.js';

/**
 * Resolve THE (single) store for the authenticated user. RLS scopes the read
 * to authorized FUSION ONE users (owner and user share the same store); the
 * selection semantics stay explicit: no row = not configured, more than one
 * = ambiguous (structurally impossible since the singleton constraint).
 */
async function resolveStore(db: SupabaseClient): Promise<any> {
  const { data, error } = await db.from('store').select('*');

  if (error) {
    throw new AppError(ErrorCode.SERVER_INTERNAL_ERROR, {
      message: 'Failed to load the store configuration.',
      internalDetails: { step: 'store.select', pgError: error.message },
    });
  }

  if (!data || data.length === 0) {
    throw new AppError(ErrorCode.STORE_NOT_CONFIGURED);
  }
  if (data.length > 1) {
    throw new AppError(ErrorCode.STORE_CONFIGURATION_AMBIGUOUS, {
      internalDetails: { storeCount: data.length },
    });
  }
  return data[0];
}

/** Load the store-level whatsapp_settings (singleton row). Returns null when absent. */
async function loadWhatsAppSettings(db: SupabaseClient): Promise<WhatsAppSettingsRow | null> {
  const { data, error } = await db
    .from('whatsapp_settings')
    .select(
      'auto_send_sale, auto_send_purchase, auto_send_proforma, ' +
        'sale_message_template, purchase_message_template, proforma_message_template',
    )
    .maybeSingle();

  if (error) {
    throw new AppError(ErrorCode.SERVER_INTERNAL_ERROR, {
      message: 'Failed to load WhatsApp delivery settings.',
      internalDetails: { step: 'whatsapp_settings.select', pgError: error.message },
    });
  }
  return (data as WhatsAppSettingsRow | null) ?? null;
}

/** PostgREST returns no row for a missing id — map that to INVOICE_NOT_FOUND. */
function requireRow<T>(row: T | null, invoiceId: string): T {
  if (!row) {
    throw new AppError(ErrorCode.INVOICE_NOT_FOUND, {
      internalDetails: { invoiceId },
    });
  }
  return row;
}

export interface SaleInvoiceRows {
  sale: any;
  items: any[];
  tradeIns: any[];
  store: any;
  whatsappSettings: WhatsAppSettingsRow | null;
}

export async function loadSaleInvoice(invoiceId: string, accessToken: string): Promise<SaleInvoiceRows> {
  const db = getUserClient(accessToken);

  const [saleRes, itemsRes, tradeInsRes, store] = await Promise.all([
    db.from('sales').select('*, parties (name, number, address)').eq('id', invoiceId).maybeSingle(),
    db
      .from('sale_items')
      .select('sold_price, inventory_item_id, inventory_items (brand, model, imei, ram_rom, color, base_selling_price)')
      .eq('sale_id', invoiceId),
    db.from('trade_ins').select('brand, model, imei, ram_rom, color, credit_value, mrp').eq('sale_id', invoiceId),
    resolveStore(db),
  ]);

  if (saleRes.error) {
    throw new AppError(ErrorCode.SERVER_INTERNAL_ERROR, {
      message: 'Failed to load the sale invoice.',
      internalDetails: { step: 'sales.select', pgError: saleRes.error.message },
    });
  }
  if (itemsRes.error) {
    throw new AppError(ErrorCode.SERVER_INTERNAL_ERROR, {
      message: 'Failed to load the sale invoice items.',
      internalDetails: { step: 'sale_items.select', pgError: itemsRes.error.message },
    });
  }
  if (tradeInsRes.error) {
    throw new AppError(ErrorCode.SERVER_INTERNAL_ERROR, {
      message: 'Failed to load the sale trade-ins.',
      internalDetails: { step: 'trade_ins.select', pgError: tradeInsRes.error.message },
    });
  }

  const sale = requireRow(saleRes.data, invoiceId);
  const whatsappSettings = await loadWhatsAppSettings(db);

  return {
    sale,
    items: itemsRes.data ?? [],
    tradeIns: tradeInsRes.data ?? [],
    store,
    whatsappSettings,
  };
}

export interface PurchaseInvoiceRows {
  purchase: any;
  items: any[];
  store: any;
  whatsappSettings: WhatsAppSettingsRow | null;
}

export async function loadPurchaseInvoice(invoiceId: string, accessToken: string): Promise<PurchaseInvoiceRows> {
  const db = getUserClient(accessToken);

  const [purchaseRes, itemsRes, store] = await Promise.all([
    db.from('purchases').select('*, parties (name, number, address)').eq('id', invoiceId).maybeSingle(),
    db
      .from('purchase_items')
      .select('inventory_items (brand, model, imei, ram_rom, color, purchase_price)')
      .eq('purchase_id', invoiceId),
    resolveStore(db),
  ]);

  if (purchaseRes.error) {
    throw new AppError(ErrorCode.SERVER_INTERNAL_ERROR, {
      message: 'Failed to load the purchase bill.',
      internalDetails: { step: 'purchases.select', pgError: purchaseRes.error.message },
    });
  }
  if (itemsRes.error) {
    throw new AppError(ErrorCode.SERVER_INTERNAL_ERROR, {
      message: 'Failed to load the purchase bill items.',
      internalDetails: { step: 'purchase_items.select', pgError: itemsRes.error.message },
    });
  }

  const purchase = requireRow(purchaseRes.data, invoiceId);
  const whatsappSettings = await loadWhatsAppSettings(db);

  return {
    purchase,
    items: itemsRes.data ?? [],
    store,
    whatsappSettings,
  };
}

export interface ProformaInvoiceRows {
  proforma: any;
  items: any[];
  tradeIns: any[];
  store: any;
  whatsappSettings: WhatsAppSettingsRow | null;
}

export async function loadProformaInvoice(invoiceId: string, accessToken: string): Promise<ProformaInvoiceRows> {
  const db = getUserClient(accessToken);

  const [proformaRes, itemsRes, tradeInsRes, store] = await Promise.all([
    db.from('proforma_invoices').select('*, parties (name, number, address)').eq('id', invoiceId).maybeSingle(),
    db.from('proforma_invoice_items').select('description, qty, rate, discount, value').eq('proforma_invoice_id', invoiceId),
    db.from('proforma_trade_ins').select('description, qty, rate, value').eq('proforma_invoice_id', invoiceId),
    resolveStore(db),
  ]);

  if (proformaRes.error) {
    throw new AppError(ErrorCode.SERVER_INTERNAL_ERROR, {
      message: 'Failed to load the quotation.',
      internalDetails: { step: 'proforma_invoices.select', pgError: proformaRes.error.message },
    });
  }
  if (itemsRes.error) {
    throw new AppError(ErrorCode.SERVER_INTERNAL_ERROR, {
      message: 'Failed to load the quotation items.',
      internalDetails: { step: 'proforma_invoice_items.select', pgError: itemsRes.error.message },
    });
  }
  if (tradeInsRes.error) {
    throw new AppError(ErrorCode.SERVER_INTERNAL_ERROR, {
      message: 'Failed to load the quotation trade-ins.',
      internalDetails: { step: 'proforma_trade_ins.select', pgError: tradeInsRes.error.message },
    });
  }

  const proforma = requireRow(proformaRes.data, invoiceId);
  const whatsappSettings = await loadWhatsAppSettings(db);

  return {
    proforma,
    items: itemsRes.data ?? [],
    tradeIns: tradeInsRes.data ?? [],
    store,
    whatsappSettings,
  };
}
