/**
 * Document data repository — authoritative Supabase loads for every
 * document composition (invoices, payment receipts, payment statements),
 * keyed ONLY by business-object identity. The loaders accept a SupabaseClient
 * so the ONE pipeline serves both access contexts: user-requested sends run
 * under the CALLER's JWT + RLS, while background message execution runs
 * under the backend's system context.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { AppError, ErrorCode } from '../errors/registry.js';

/**
 * Resolve THE (single) store. RLS scopes the read to authorized FUSION ONE
 * users (owner and user share the same store); the selection semantics stay
 * explicit: no row = not configured, more than one = ambiguous.
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
  /** Per-invoice reminder configuration (null when none was configured). */
  reminderConfig: ReminderConfigRow | null;
}

/** reminder_settings row shape (per-invoice reminder policy + state). */
export interface ReminderConfigRow {
  enabled: boolean;
  frequency_days: number;
  max_reminders: number;
  reminders_sent: number;
  last_reminder_at: string | null;
}

export async function loadSaleInvoice(invoiceId: string, db: SupabaseClient): Promise<SaleInvoiceRows> {
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
  const reminderConfig = await db
    .from('reminder_settings')
    .select('enabled, frequency_days, max_reminders, reminders_sent, last_reminder_at')
    .eq('sale_id', invoiceId)
    .maybeSingle()
    .then(({ data, error }) => {
      if (error) {
        throw new AppError(ErrorCode.SERVER_INTERNAL_ERROR, {
          message: 'Failed to load the reminder configuration.',
          internalDetails: { step: 'reminder_settings.select', pgError: error.message },
        });
      }
      return (data as ReminderConfigRow | null) ?? null;
    });

  return {
    sale,
    items: itemsRes.data ?? [],
    tradeIns: tradeInsRes.data ?? [],
    store,
    reminderConfig,
  };
}

export interface PurchaseInvoiceRows {
  purchase: any;
  items: any[];
  store: any;
}

export async function loadPurchaseInvoice(invoiceId: string, db: SupabaseClient): Promise<PurchaseInvoiceRows> {
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

  return { purchase, items: itemsRes.data ?? [], store };
}

export interface ProformaInvoiceRows {
  proforma: any;
  items: any[];
  tradeIns: any[];
  store: any;
}

export async function loadProformaInvoice(invoiceId: string, db: SupabaseClient): Promise<ProformaInvoiceRows> {
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

  return { proforma, items: itemsRes.data ?? [], tradeIns: tradeInsRes.data ?? [], store };
}

// ─── Payment documents ──────────────────────────────────────────────────────

export interface PaymentReceiptRows {
  payment: any;
  /** The linked invoice (sale or purchase), when the payment is bound. */
  invoice: any | null;
  store: any;
}

export interface PaymentStatementRows {
  /** The invoice/bill row (sale or purchase) — CURRENT authoritative state. */
  invoice: any;
  /** ALL payments against the invoice/bill, oldest first. */
  payments: any[];
  store: any;
}

function paymentTable(direction: 'in' | 'out'): 'payments_in' | 'payments_out' {
  return direction === 'in' ? 'payments_in' : 'payments_out';
}

/**
 * Load a payment with its party/account/mode labels, its linked invoice
 * (CURRENT totals at load time), and the store.
 * @throws AppError(PAYMENT_NOT_FOUND / SERVER_INTERNAL_ERROR / STORE_*)
 */
export async function loadPaymentReceipt(
  paymentId: string,
  direction: 'in' | 'out',
  db: SupabaseClient,
): Promise<PaymentReceiptRows> {
  const table = paymentTable(direction);
  // The two payment tables carry different invoice references (sale_id vs
  // purchase_id) — the select list is per-direction.
  const columns =
    direction === 'in'
      ? 'id, amount, date, sale_id, ' +
        'parties (id, name, number, address), ' +
        'bank_accounts (name), payment_modes (name)'
      : 'id, amount, date, purchase_id, ' +
        'parties (id, name, number, address), ' +
        'bank_accounts (name), payment_modes (name)';

  const paymentRes = await db
    .from(table)
    .select(columns)
    .eq('id', paymentId)
    .maybeSingle();

  if (paymentRes.error) {
    throw new AppError(ErrorCode.SERVER_INTERNAL_ERROR, {
      message: 'Failed to load the payment.',
      internalDetails: { step: `${table}.select`, pgError: paymentRes.error.message },
    });
  }

  const payment = paymentRes.data as any;
  if (!payment) {
    throw new AppError(ErrorCode.PAYMENT_NOT_FOUND, {
      internalDetails: { paymentId, direction },
    });
  }

  // The linked invoice (CURRENT state — the receipt shows the balance as of
  // composition time). payments_in → sales; payments_out → purchases.
  let invoice: any | null = null;
  if (direction === 'in' && payment.sale_id) {
    const invoiceRes = await db
      .from('sales')
      .select('id, bill_number, date, final_total, paid, due, status')
      .eq('id', payment.sale_id)
      .maybeSingle();
    if (invoiceRes.error) {
      throw new AppError(ErrorCode.SERVER_INTERNAL_ERROR, {
        message: 'Failed to load the payment invoice.',
        internalDetails: { step: 'sales.select', pgError: invoiceRes.error.message },
      });
    }
    invoice = invoiceRes.data;
  } else if (direction === 'out' && payment.purchase_id) {
    const invoiceRes = await db
      .from('purchases')
      .select('id, bill_number, date, total, paid, due, status')
      .eq('id', payment.purchase_id)
      .maybeSingle();
    if (invoiceRes.error) {
      throw new AppError(ErrorCode.SERVER_INTERNAL_ERROR, {
        message: 'Failed to load the payment invoice.',
        internalDetails: { step: 'purchases.select', pgError: invoiceRes.error.message },
      });
    }
    invoice = invoiceRes.data;
  }

  const store = await resolveStore(db);

  return { payment, invoice, store };
}

/**
 * Load ONE invoice/bill with ALL its payments (oldest first) and the store —
 * everything a Payment Statement is composed from. The invoice row carries
 * the CURRENT authoritative paid/due; the payment rows are the history
 * (including the initial creation-time payment).
 * @throws AppError(INVOICE_NOT_FOUND / SERVER_INTERNAL_ERROR / STORE_*)
 */
export async function loadPaymentStatement(
  invoiceId: string,
  direction: 'in' | 'out',
  db: SupabaseClient,
): Promise<PaymentStatementRows> {
  // The invoice/bill (CURRENT authoritative totals at load time).
  let invoiceRes;
  if (direction === 'in') {
    invoiceRes = await db
      .from('sales')
      .select('id, bill_number, date, final_total, total, paid, due, status, parties (id, name, number, address)')
      .eq('id', invoiceId)
      .maybeSingle();
  } else {
    invoiceRes = await db
      .from('purchases')
      .select('id, bill_number, date, total, final_total, paid, due, status, parties (id, name, number, address)')
      .eq('id', invoiceId)
      .maybeSingle();
  }
  if (invoiceRes.error) {
    throw new AppError(ErrorCode.SERVER_INTERNAL_ERROR, {
      message: 'Failed to load the invoice.',
      internalDetails: {
        step: `${direction === 'in' ? 'sales' : 'purchases'}.select`,
        pgError: invoiceRes.error.message,
      },
    });
  }
  const invoice = invoiceRes.data as any;
  if (!invoice) {
    throw new AppError(ErrorCode.INVOICE_NOT_FOUND, {
      internalDetails: { invoiceId, direction },
    });
  }

  // ALL payments against the invoice/bill, oldest first (the statement's
  // payment history — every payment row, including the initial one).
  const table = paymentTable(direction);
  const refColumn = direction === 'in' ? 'sale_id' : 'purchase_id';
  const paymentsRes = await db
    .from(table)
    .select('id, amount, date, payment_modes (name)')
    .eq(refColumn, invoiceId)
    .order('date', { ascending: true })
    .order('created_at', { ascending: true });
  if (paymentsRes.error) {
    throw new AppError(ErrorCode.SERVER_INTERNAL_ERROR, {
      message: 'Failed to load the payment history.',
      internalDetails: { step: `${table}.select`, pgError: paymentsRes.error.message },
    });
  }

  const store = await resolveStore(db);

  return { invoice, payments: paymentsRes.data ?? [], store };
}
