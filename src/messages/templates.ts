/**
 * Message templates — the ONE template system for every WhatsApp message
 * (invoice sends, payment receipts, payment statements, invoice payment
 * reminders). The template ALWAYS comes from the `whatsapp_settings` table —
 * there is deliberately NO hardcoded fallback; a missing required template
 * fails with WHATSAPP_TEMPLATE_MISSING. Unrecognized placeholders resolve to
 * an empty string. Each document kind builds its own value map and shares
 * the same renderer.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { InvoiceData, ReceiptData, StatementData } from '../documents/types.js';
import { AppError, ErrorCode } from '../errors/registry.js';

/** The whatsapp_settings columns relevant to message resolution.
 *  Store-level shared configuration (singleton row). */
export interface MessageSettingsRow {
  auto_send_sale: boolean | null;
  auto_send_purchase: boolean | null;
  auto_send_proforma: boolean | null;
  auto_send_receipt_in: boolean | null;
  auto_send_receipt_out: boolean | null;
  sale_message_template: string | null;
  purchase_message_template: string | null;
  proforma_message_template: string | null;
  payment_in_message_template: string | null;
  payment_out_message_template: string | null;
  reminder_message_template: string | null;
  payment_statement_in_message_template: string | null;
  payment_statement_out_message_template: string | null;
}

/** Load the store-level message settings (singleton row). Returns null when absent. */
export async function loadMessageSettings(db: SupabaseClient): Promise<MessageSettingsRow | null> {
  const { data, error } = await db
    .from('whatsapp_settings')
    .select(
      'auto_send_sale, auto_send_purchase, auto_send_proforma, ' +
        'auto_send_receipt_in, auto_send_receipt_out, ' +
        'sale_message_template, purchase_message_template, proforma_message_template, ' +
        'payment_in_message_template, payment_out_message_template, reminder_message_template, ' +
        'payment_statement_in_message_template, payment_statement_out_message_template',
    )
    .maybeSingle();

  if (error) {
    throw new AppError(ErrorCode.SERVER_INTERNAL_ERROR, {
      message: 'Failed to load the WhatsApp message settings.',
      internalDetails: { step: 'whatsapp_settings.select', pgError: error.message },
    });
  }
  return (data as MessageSettingsRow | null) ?? null;
}

// ─── Template resolution (per message kind) ─────────────────────────────────

function requireTemplate(template: string | null | undefined, context: Record<string, unknown>): string {
  const trimmed = (template ?? '').trim();
  if (!trimmed) {
    throw new AppError(ErrorCode.WHATSAPP_TEMPLATE_MISSING, {
      internalDetails: context,
    });
  }
  return trimmed;
}

/** Resolve the message template for an invoice type. */
export function getInvoiceMessageTemplate(
  settings: MessageSettingsRow | null,
  type: InvoiceData['type'],
): string {
  const template =
    type === 'sale'
      ? settings?.sale_message_template
      : type === 'purchase'
        ? settings?.purchase_message_template
        : settings?.proforma_message_template;

  return requireTemplate(template, { documentKind: type });
}

/** Resolve the message template for a payment receipt (by direction). */
export function getReceiptMessageTemplate(
  settings: MessageSettingsRow | null,
  direction: ReceiptData['direction'],
): string {
  const template =
    direction === 'in'
      ? settings?.payment_in_message_template
      : settings?.payment_out_message_template;

  return requireTemplate(template, { documentKind: `payment_${direction}_receipt` });
}

/** Resolve the message template for an invoice payment reminder. */
export function getReminderMessageTemplate(settings: MessageSettingsRow | null): string {
  return requireTemplate(settings?.reminder_message_template, { documentKind: 'reminder' });
}

/** Resolve the message template for a payment statement (by direction). */
export function getStatementMessageTemplate(
  settings: MessageSettingsRow | null,
  direction: StatementData['direction'],
): string {
  const template =
    direction === 'in'
      ? settings?.payment_statement_in_message_template
      : settings?.payment_statement_out_message_template;

  return requireTemplate(template, { documentKind: `payment_statement_${direction}` });
}

// ─── Token rendering ────────────────────────────────────────────────────────

/** Shared en-IN money formatting for template values (₹-prefixed digits). */
function money(n: number): string {
  return Number(n).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** The ONE placeholder renderer: {{token}} → value, unknown tokens → ''. */
export function renderTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/{{\s*([a-z_]+)\s*}}/g, (_, name) => values[name] ?? '');
}

/** Template value map for invoice documents (sale / purchase / proforma). */
export function invoiceTemplateValues(data: InvoiceData): Record<string, string> {
  const paymentStatus = data.type === 'proforma' ? 'Quotation' : data.due > 0 ? 'Balance due' : 'Paid';
  return {
    customer_name: data.party?.name || '',
    invoice_number: data.bill_number,
    invoice_date: data.date,
    company_name: data.store?.name || '',
    grand_total: money(data.final_total),
    due_date: data.due > 0 ? data.date : '',
    payment_status: paymentStatus,
    company_phone: data.store?.phone || '',
    company_address: data.store?.address || '',
    balance_due: money(data.due),
  };
}

/** Template value map for payment receipts (in / out). */
export function receiptTemplateValues(data: ReceiptData): Record<string, string> {
  return {
    customer_name: data.party?.name || '',
    invoice_number: data.invoice_number || '',
    invoice_date: data.invoice_date || '',
    company_name: data.store?.name || '',
    company_phone: data.store?.phone || '',
    company_address: data.store?.address || '',
    payment_amount: money(data.amount),
    payment_date: data.date,
    balance_due: data.invoice_due !== null ? money(data.invoice_due) : '',
  };
}

/** Template value map for payment statements (in / out). The aggregates are
 *  the AUTHORITATIVE invoice/bill state — never recomputed from the list. */
export function statementTemplateValues(data: StatementData): Record<string, string> {
  return {
    customer_name: data.party?.name || '',
    invoice_number: data.invoice_number || '',
    invoice_date: data.invoice_date || '',
    company_name: data.store?.name || '',
    company_phone: data.store?.phone || '',
    company_address: data.store?.address || '',
    grand_total: data.invoice_total !== null ? money(data.invoice_total) : '',
    total_paid: data.total_paid !== null ? money(data.total_paid) : '',
    balance_due: data.balance_due !== null ? money(data.balance_due) : '',
    payment_count: String(data.payments.length),
  };
}

/** Render an invoice message template against invoice data. */
export function resolveInvoiceMessage(data: InvoiceData, template: string): string {
  return renderTemplate(template, invoiceTemplateValues(data));
}

/** Render a receipt message template against payment receipt data. */
export function resolveReceiptMessage(data: ReceiptData, template: string): string {
  return renderTemplate(template, receiptTemplateValues(data));
}

/** Render a statement message template against payment statement data. */
export function resolveStatementMessage(data: StatementData, template: string): string {
  return renderTemplate(template, statementTemplateValues(data));
}
