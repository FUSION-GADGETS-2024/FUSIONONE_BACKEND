import type { InvoiceData } from '@/features/invoice/types';

export type SendableInvoiceType = 'sale' | 'purchase' | 'proforma';
export const isSendableInvoice = (type: InvoiceData['type']): type is SendableInvoiceType =>
  type === 'sale' || type === 'purchase' || type === 'proforma';

/**
 * WhatsApp message settings (the whatsapp_settings singleton's editor-side
 * mirror). Invoice types carry an Auto Send flag; payment receipts carry an
 * independent automatic-sending switch (subsequent payments only — the
 * initial payment recorded during invoice/bill creation never triggers a
 * receipt); payment statements and the reminder template are template-only
 * (statements are manual-only sends; reminder POLICY is configured per
 * invoice, not here).
 */
export interface MessageSettings {
  sale: { autoSend: boolean; template: string };
  purchase: { autoSend: boolean; template: string };
  proforma: { autoSend: boolean; template: string };
  paymentIn: { autoSend: boolean; template: string };
  paymentOut: { autoSend: boolean; template: string };
  statementIn: { template: string };
  statementOut: { template: string };
  reminder: { template: string };
}

/**
 * WhatsApp message resolution lives in the BACKEND
 * (backend/src/messages/templates.ts): the backend loads the message
 * template from `whatsapp_settings` and substitutes placeholders using the
 * authoritative invoice/payment data it composes itself. The frontend no
 * longer resolves or transports message text.
 */
