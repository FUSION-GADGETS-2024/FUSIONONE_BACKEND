/**
 * WhatsApp delivery message resolution. The message template ALWAYS comes
 * from the `whatsapp_settings` table — there is deliberately NO hardcoded
 * fallback; a missing required template fails with WHATSAPP_TEMPLATE_MISSING.
 * Unrecognized placeholders resolve to an empty string.
 */
import type { InvoiceData, InvoiceType } from './types.js';
import { AppError, ErrorCode } from '../errors/registry.js';

/** The whatsapp_settings columns relevant to message resolution. */
export interface WhatsAppSettingsRow {
  owner_user_id: string;
  auto_send_sale: boolean | null;
  auto_send_purchase: boolean | null;
  auto_send_proforma: boolean | null;
  sale_message_template: string | null;
  purchase_message_template: string | null;
  proforma_message_template: string | null;
}

/** Resolve the message template for an invoice type. */
export function getMessageTemplate(
  settings: WhatsAppSettingsRow | null,
  type: InvoiceType,
): string {
  const template =
    type === 'sale'
      ? settings?.sale_message_template
      : type === 'purchase'
        ? settings?.purchase_message_template
        : settings?.proforma_message_template;

  const trimmed = (template ?? '').trim();
  if (!trimmed) {
    throw new AppError(ErrorCode.WHATSAPP_TEMPLATE_MISSING, {
      internalDetails: { invoiceType: type },
    });
  }
  return trimmed;
}

/**
 * Render a delivery message template against invoice data. A pure renderer —
 * no template strings here; the template is always loaded from the database.
 */
export function resolveDeliveryMessage(data: InvoiceData, template: string): string {
  const paymentStatus = data.type === 'proforma' ? 'Quotation' : data.due > 0 ? 'Balance due' : 'Paid';
  const values: Record<string, string> = {
    customer_name: data.party?.name || '',
    invoice_number: data.bill_number,
    invoice_date: data.date,
    company_name: data.store?.name || '',
    grand_total: Number(data.final_total).toLocaleString('en-IN', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }),
    due_date: data.due > 0 ? data.date : '',
    payment_status: paymentStatus,
    company_phone: data.store?.phone || '',
    company_address: data.store?.address || '',
  };
  return template.replace(/{{\s*([a-z_]+)\s*}}/g, (_, name) => values[name] ?? '');
}
