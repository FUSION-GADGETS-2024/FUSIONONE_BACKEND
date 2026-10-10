/**
 * Document preparation — the unified document asset contract. Every
 * supported document kind (invoice, payment receipt, payment statement)
 * prepares through the SAME pipeline and returns the SAME shape:
 *
 *   document data ─→ document-specific renderer ─→ PDF
 *                 └→ shared thumbnail worker ────→ JPEG preview (optional)
 *
 * The PDF and the thumbnail render CONCURRENTLY from the same canonical
 * document data. The thumbnail leg NEVER rejects and NEVER blocks the PDF:
 * any failure resolves thumbnail=null and the document is still sent
 * PDF-only. The message transport layer receives this contract and never
 * needs to know which document kind it is carrying.
 */
import { getLogger } from '../logging/logger.js';
import type { InvoiceData, ReceiptData, StatementData } from './types.js';
import { generateInvoicePdf } from './invoice.js';
import { generateReceiptPdf } from './receipt.js';
import { generateStatementPdf } from './statement.js';
import { generateDocumentThumbnail, type DocumentThumbnailResult } from './thumbnail.js';

/** The standardized document output every message carries. */
export interface PreparedDocument {
  /** The complete PDF buffer (validated %PDF- output). */
  pdf: Buffer;
  /** The chat-bubble preview — null on ANY thumbnail failure (PDF-only send). */
  thumbnail: { jpeg: Buffer; width: number; height: number } | null;
  /** The WhatsApp attachment filename (document number + .pdf). */
  fileName: string;
  mimeType: 'application/pdf';
}

async function prepare(
  kind: 'invoice' | 'receipt' | 'statement',
  fileName: string,
  renderPdf: () => Promise<Buffer>,
  renderThumbnail: () => Promise<DocumentThumbnailResult>,
): Promise<PreparedDocument> {
  const [pdf, thumbnail] = await Promise.all([
    renderPdf(),
    renderThumbnail().catch(() => ({ jpeg: null, width: null, height: null, ms: 0 }) as DocumentThumbnailResult),
  ]);

  getLogger().info(
    {
      kind,
      fileName,
      pdfBytes: pdf.length,
      thumbnailBytes: thumbnail.jpeg?.length ?? 0,
      ...(thumbnail.jpeg
        ? { thumbnailDims: `${thumbnail.width}x${thumbnail.height}` }
        : {}),
    },
    'Document prepared',
  );

  return {
    pdf,
    thumbnail:
      thumbnail.jpeg && thumbnail.width !== null && thumbnail.height !== null
        ? { jpeg: thumbnail.jpeg, width: thumbnail.width, height: thumbnail.height }
        : null,
    fileName,
    mimeType: 'application/pdf',
  };
}

/** Invoice → PDF + thumbnail + filename. */
export async function prepareInvoiceDocument(data: InvoiceData): Promise<PreparedDocument> {
  return prepare(
    'invoice',
    `${data.bill_number}.pdf`,
    () => generateInvoicePdf(data),
    () => generateDocumentThumbnail('invoice', data),
  );
}

/** Payment receipt → PDF + thumbnail + filename. */
export async function prepareReceiptDocument(data: ReceiptData): Promise<PreparedDocument> {
  return prepare(
    'receipt',
    `${data.receipt_number}.pdf`,
    () => generateReceiptPdf(data),
    () => generateDocumentThumbnail('receipt', data),
  );
}

/** Payment statement → PDF + thumbnail + filename. */
export async function prepareStatementDocument(data: StatementData): Promise<PreparedDocument> {
  return prepare(
    'statement',
    `${data.statement_number}.pdf`,
    () => generateStatementPdf(data),
    () => generateDocumentThumbnail('statement', data),
  );
}
