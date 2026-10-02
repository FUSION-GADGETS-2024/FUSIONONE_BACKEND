/**
 * Invoice send pipeline (backend-owned):
 *   {invoiceId, invoiceType} → repository (Supabase load under the
 *   requesting user's JWT) → builder (canonical InvoiceData) → recipient
 *   resolution (party.number → Indian JID) → message resolution
 *   (whatsapp_settings template) → PDFKit render + canvas thumbnail
 *   (concurrently) → SendController (serialized transport: ONE PDF document
 *   message). Every piece of data comes from the database — nothing about
 *   the invoice is supplied by the caller except its identity.
 */
import { getLogger } from '../logging/logger.js';
import { AppError, ErrorCode } from '../errors/registry.js';
import { normalizeIndianPhoneToJid, type DocumentThumbnail } from '../whatsapp/WhatsAppManager.js';
import type { SendController } from '../send/SendController.js';
import type { InvoiceData, InvoiceType } from './types.js';
import {
  loadSaleInvoice,
  loadPurchaseInvoice,
  loadProformaInvoice,
} from './repository.js';
import {
  buildSaleInvoiceData,
  buildPurchaseInvoiceData,
  buildProformaInvoiceData,
} from './builders.js';
import { getMessageTemplate, resolveDeliveryMessage } from './delivery.js';
import { generateInvoicePdf } from './pdf.js';
import { generateInvoiceThumbnail } from './thumbnail.js';

export interface SendInvoiceByIdInput {
  requestId: string;
  invoiceId: string;
  invoiceType: InvoiceType;
  /** The requesting user's Supabase access token — all invoice data is
   *  loaded under this identity (RLS-enforced). */
  accessToken: string;
}

/**
 * Load and build the canonical InvoiceData for an invoice reference.
 * @throws AppError(INVOICE_NOT_FOUND / STORE_* / SERVER_INTERNAL_ERROR)
 */
export async function buildInvoiceDataById(
  invoiceId: string,
  invoiceType: InvoiceType,
  accessToken: string,
): Promise<{ data: InvoiceData; whatsappSettings: import('./delivery.js').WhatsAppSettingsRow | null }> {
  switch (invoiceType) {
    case 'sale': {
      const rows = await loadSaleInvoice(invoiceId, accessToken);
      return {
        data: buildSaleInvoiceData(rows),
        whatsappSettings: rows.whatsappSettings,
      };
    }
    case 'purchase': {
      const rows = await loadPurchaseInvoice(invoiceId, accessToken);
      return {
        data: buildPurchaseInvoiceData(rows),
        whatsappSettings: rows.whatsappSettings,
      };
    }
    case 'proforma': {
      const rows = await loadProformaInvoice(invoiceId, accessToken);
      return {
        data: buildProformaInvoiceData(rows),
        whatsappSettings: rows.whatsappSettings,
      };
    }
    default:
      throw new AppError(ErrorCode.INVALID_INVOICE_TYPE, {
        internalDetails: { invoiceType },
      });
  }
}

/**
 * Resolve the WhatsApp recipient JID from the invoice's party — always from
 * the invoice relationship (party.number), never from the request.
 */
function resolveRecipient(data: InvoiceData): string {
  const phone = (data.party?.number ?? '').trim();
  if (!phone) {
    throw new AppError(ErrorCode.PARTY_PHONE_MISSING, {
      internalDetails: { billNumber: data.bill_number },
    });
  }
  const jid = normalizeIndianPhoneToJid(phone);
  if (!jid) {
    throw new AppError(ErrorCode.WHATSAPP_RECIPIENT_INVALID, {
      message: 'The invoice party phone number is not a valid Indian mobile number.',
      internalDetails: { billNumber: data.bill_number },
    });
  }
  return jid;
}

/**
 * Send an invoice by reference: compose everything from the database, render
 * the PDF, and deliver ONE WhatsApp document message with caption.
 * @throws AppError for every pipeline failure (closed error registry).
 */
export async function sendInvoiceById(
  sendController: SendController,
  input: SendInvoiceByIdInput,
): Promise<{ success: boolean; requestId: string; messageId?: string }> {
  const log = getLogger();
  const { requestId, invoiceId, invoiceType, accessToken } = input;

  // 1. Compose the invoice from authoritative data (user-scoped, RLS).
  const { data, whatsappSettings } = await buildInvoiceDataById(invoiceId, invoiceType, accessToken);

  // 2. Recipient from the invoice party (India-only normalization).
  const recipient = resolveRecipient(data);

  // 3. Message from the stored template — no invented fallbacks.
  const template = getMessageTemplate(whatsappSettings, invoiceType);
  const caption = resolveDeliveryMessage(data, template);

  // 4. Render the PDF and the chat-bubble thumbnail CONCURRENTLY from the
  //    same canonical InvoiceData. The thumbnail leg NEVER rejects: any
  //    failure resolves jpeg=null and the invoice is still sent PDF-only.
  const prepStart = performance.now();
  let pdfMs = 0;
  let thumbnailMs = 0;

  const [pdfBuffer, thumbnail] = await Promise.all([
    (async () => {
      const t0 = performance.now();
      try {
        return await generateInvoicePdf(data);
      } finally {
        pdfMs = Math.round(performance.now() - t0);
      }
    })(),
    (async () => {
      const t0 = performance.now();
      try {
        return await generateInvoiceThumbnail(data);
      } finally {
        thumbnailMs = Math.round(performance.now() - t0);
      }
    })(),
  ]);
  const totalPreparationMs = Math.round(performance.now() - prepStart);

  log.info(
    {
      requestId,
      invoiceId,
      invoiceType,
      billNumber: data.bill_number,
      pdfBytes: pdfBuffer.length,
      thumbnailBytes: thumbnail.jpeg?.length ?? 0,
      thumbnailDims: thumbnail.jpeg ? `${thumbnail.width}x${thumbnail.height}` : null,
      pdfMs,
      thumbnailMs,
      totalPreparationMs,
    },
    'Invoice composed for send',
  );

  // 5. Transport: ONE PDF document message with caption (serialized,
  //    retried). A failed thumbnail (jpeg null) travels as null — a clean
  //    PDF-only document message.
  const documentThumbnail: DocumentThumbnail | null =
    thumbnail.jpeg && thumbnail.width !== null && thumbnail.height !== null
      ? { jpeg: thumbnail.jpeg, width: thumbnail.width, height: thumbnail.height }
      : null;

  return sendController.send({
    requestId,
    recipient,
    pdfBuffer,
    fileName: `${data.bill_number}.pdf`,
    caption,
    thumbnail: documentThumbnail,
  });
}
