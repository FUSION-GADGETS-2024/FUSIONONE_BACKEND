/**
 * Message send pipeline (backend-owned) — the ONE pipeline for every
 * WhatsApp message kind:
 *
 *   message definition → recipient resolution → template resolution →
 *   document preparation (PDF + thumbnail) → SendController (serialized
 *   transport: ONE PDF document message)
 *
 * Everything is composed from authoritative database data — the caller
 * identifies only the business object. The pipeline is client-parameterized:
 * user-requested sends pass the CALLER's user-context client (RLS-enforced);
 * background message execution passes the system-context client.
 */
import { getLogger } from '../logging/logger.js';
import { normalizeIndianPhoneToJid } from '../whatsapp/WhatsAppManager.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { SendController } from '../whatsapp/SendController.js';
import type { InvoiceData, PaymentDirection } from '../documents/types.js';
import { AppError, ErrorCode } from '../errors/registry.js';
import {
  loadSaleInvoice,
  loadPurchaseInvoice,
  loadProformaInvoice,
  loadPaymentReceipt,
  loadPaymentStatement,
} from '../documents/repository.js';
import {
  buildSaleInvoiceData,
  buildPurchaseInvoiceData,
  buildProformaInvoiceData,
  buildPaymentReceiptData,
  buildPaymentStatementData,
} from '../documents/builders.js';
import {
  prepareInvoiceDocument,
  prepareReceiptDocument,
  prepareStatementDocument,
  type PreparedDocument,
} from '../documents/prepare.js';
import {
  loadMessageSettings,
  getInvoiceMessageTemplate,
  getReceiptMessageTemplate,
  getReminderMessageTemplate,
  getStatementMessageTemplate,
  resolveInvoiceMessage,
  resolveReceiptMessage,
  resolveStatementMessage,
} from './templates.js';

// ─── Recipient resolution ───────────────────────────────────────────────────

/** Resolve the WhatsApp recipient JID from the party relationship — always
 *  from the business object (party.number), never from the request. */
function resolveRecipient(
  phone: string | undefined | null,
  context: { documentNumber: string; what: string },
): string {
  const trimmed = (phone ?? '').trim();
  if (!trimmed) {
    throw new AppError(ErrorCode.PARTY_PHONE_MISSING, {
      internalDetails: { billNumber: context.documentNumber, what: context.what },
    });
  }
  const jid = normalizeIndianPhoneToJid(trimmed);
  if (!jid) {
    throw new AppError(ErrorCode.WHATSAPP_RECIPIENT_INVALID, {
      message: `The ${context.what} party phone number is not a valid Indian mobile number.`,
      internalDetails: { billNumber: context.documentNumber },
    });
  }
  return jid;
}

// ─── The shared delivery core ───────────────────────────────────────────────

/** ONE PDF document message with caption (serialized, retried) — the single
 *  transport contract every message kind converges on. */
async function deliverDocumentMessage(
  sendController: SendController,
  input: {
    requestId: string;
    recipient: string;
    caption: string;
    document: PreparedDocument;
  },
): Promise<{ success: boolean; requestId: string; messageId?: string }> {
  return sendController.send({
    requestId: input.requestId,
    recipient: input.recipient,
    pdfBuffer: input.document.pdf,
    fileName: input.document.fileName,
    caption: input.caption,
    thumbnail: input.document.thumbnail,
  });
}

// ─── Invoice messages (sale / purchase / proforma) ──────────────────────────

/** Load and build the canonical InvoiceData for an invoice reference. */
async function buildInvoiceData(
  invoiceId: string,
  invoiceType: InvoiceData['type'],
  db: SupabaseClient,
): Promise<InvoiceData> {
  switch (invoiceType) {
    case 'sale':
      return buildSaleInvoiceData(await loadSaleInvoice(invoiceId, db));
    case 'purchase':
      return buildPurchaseInvoiceData(await loadPurchaseInvoice(invoiceId, db));
    case 'proforma':
      return buildProformaInvoiceData(await loadProformaInvoice(invoiceId, db));
    default:
      throw new AppError(ErrorCode.INVALID_INVOICE_TYPE, {
        internalDetails: { invoiceType },
      });
  }
}

/**
 * Send an invoice message by reference: compose everything from the
 * database, prepare the document (PDF + thumbnail), and deliver ONE
 * WhatsApp document message with caption.
 * @throws AppError for every pipeline failure (closed error registry).
 */
export async function sendInvoiceMessage(
  sendController: SendController,
  input: {
    requestId: string;
    invoiceId: string;
    invoiceType: InvoiceData['type'];
    db: SupabaseClient;
  },
): Promise<{ success: boolean; requestId: string; messageId?: string }> {
  const { requestId, invoiceId, invoiceType, db } = input;

  const data = await buildInvoiceData(invoiceId, invoiceType, db);
  const recipient = resolveRecipient(data.party?.number, {
    documentNumber: data.bill_number,
    what: 'invoice',
  });

  const settings = await loadMessageSettings(db);
  const template = getInvoiceMessageTemplate(settings, invoiceType);
  const caption = resolveInvoiceMessage(data, template);

  const document = await prepareInvoiceDocument(data);
  return deliverDocumentMessage(sendController, { requestId, recipient, caption, document });
}

/**
 * Send a payment reminder for a sale invoice: composes the CURRENT invoice
 * (never stale data — the caller is responsible for the eligibility check
 * immediately before this) and delivers it under the REMINDER message
 * template, which renders the CURRENT balance due.
 * @throws AppError for every pipeline failure (closed error registry).
 */
export async function sendReminderMessage(
  sendController: SendController,
  input: {
    requestId: string;
    saleId: string;
    db: SupabaseClient;
  },
): Promise<{ success: boolean; requestId: string; messageId?: string }> {
  const { requestId, saleId, db } = input;

  const rows = await loadSaleInvoice(saleId, db);
  const data = buildSaleInvoiceData(rows);
  const recipient = resolveRecipient(data.party?.number, {
    documentNumber: data.bill_number,
    what: 'invoice',
  });

  const settings = await loadMessageSettings(db);
  const template = getReminderMessageTemplate(settings);
  const caption = resolveInvoiceMessage(data, template);

  const document = await prepareInvoiceDocument(data);
  return deliverDocumentMessage(sendController, { requestId, recipient, caption, document });
}

// ─── Payment document messages ──────────────────────────────────────────────

/**
 * Send a payment receipt by reference: compose everything from the
 * database, prepare the document (PDF + thumbnail), and deliver ONE
 * WhatsApp document message with caption.
 * @throws AppError for every pipeline failure (closed error registry).
 */
export async function sendReceiptMessage(
  sendController: SendController,
  input: {
    requestId: string;
    paymentId: string;
    direction: PaymentDirection;
    db: SupabaseClient;
  },
): Promise<{ success: boolean; requestId: string; messageId?: string }> {
  const log = getLogger();
  const { requestId, paymentId, direction, db } = input;

  const rows = await loadPaymentReceipt(paymentId, direction, db);
  const data = buildPaymentReceiptData(direction, rows);
  const recipient = resolveRecipient(data.party?.number, {
    documentNumber: data.receipt_number,
    what: 'payment',
  });

  const settings = await loadMessageSettings(db);
  const template = getReceiptMessageTemplate(settings, direction);
  const caption = resolveReceiptMessage(data, template);

  log.info(
    { requestId, paymentId, direction, receiptNumber: data.receipt_number },
    'Payment receipt message composing',
  );

  const document = await prepareReceiptDocument(data);
  return deliverDocumentMessage(sendController, { requestId, recipient, caption, document });
}

/**
 * Send a payment statement by reference: compose the invoice/bill's FULL
 * payment history from authoritative CURRENT data (payments + sales.paid/due
 * or purchases.paid/due), prepare the document (PDF + thumbnail), and
 * deliver ONE WhatsApp document message with caption. Statements are
 * MANUAL ONLY — no payment operation ever creates one.
 * @throws AppError for every pipeline failure (closed error registry).
 */
export async function sendStatementMessage(
  sendController: SendController,
  input: {
    requestId: string;
    invoiceId: string;
    direction: PaymentDirection;
    db: SupabaseClient;
  },
): Promise<{ success: boolean; requestId: string; messageId?: string }> {
  const log = getLogger();
  const { requestId, invoiceId, direction, db } = input;

  const rows = await loadPaymentStatement(invoiceId, direction, db);
  const data = buildPaymentStatementData(direction, rows);
  const recipient = resolveRecipient(data.party?.number, {
    documentNumber: data.statement_number,
    what: 'payment',
  });

  const settings = await loadMessageSettings(db);
  const template = getStatementMessageTemplate(settings, direction);
  const caption = resolveStatementMessage(data, template);

  log.info(
    { requestId, invoiceId, direction, statementNumber: data.statement_number, paymentCount: data.payments.length },
    'Payment statement message composing',
  );

  const document = await prepareStatementDocument(data);
  return deliverDocumentMessage(sendController, { requestId, recipient, caption, document });
}
