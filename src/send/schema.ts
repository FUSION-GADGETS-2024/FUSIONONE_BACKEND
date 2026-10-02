/**
 * sendInvoice request validation. The request identifies the invoice:
 *   invoiceId (UUID) · invoiceType ('sale' | 'purchase' | 'proforma') ·
 *   requestId (optional tracing id, generated if absent)
 *
 * The backend is the invoice owner — the client never supplies invoice
 * rows, totals, recipients, captions, or binaries. The LEGACY image-based
 * contract ({recipient, image, caption}) is REJECTED explicitly so it
 * cannot linger as a hidden alternate path.
 */
import { z } from 'zod';
import { AppError, ErrorCode } from '../errors/registry.js';
import { INVOICE_TYPES, type InvoiceType } from '../invoice/types.js';

export const SendInvoiceRequestSchema = z
  .object({
    requestId: z.string().min(1).max(128).optional(),
    invoiceId: z.string().uuid('invoiceId must be a UUID'),
    invoiceType: z.string().min(1),
  })
  .strict(); // unknown keys (recipient/image/caption/...) are rejected

export type SendInvoiceRequest = z.infer<typeof SendInvoiceRequestSchema>;

/** Legacy image-contract keys that must be rejected with a clear message. */
const LEGACY_KEYS = ['recipient', 'image', 'caption'] as const;

export interface ParsedInvoiceRequest {
  requestId: string;
  invoiceId: string;
  invoiceType: InvoiceType;
}

/**
 * Parse a sendInvoice request into a ParsedInvoiceRequest.
 * @throws AppError(API_REQUEST_INVALID) for malformed/legacy payloads.
 * @throws AppError(INVALID_INVOICE_TYPE) for an unknown invoice type.
 */
export function parseSendInvoiceRequest(body: unknown): ParsedInvoiceRequest {
  // Explicit rejection of the removed image-based contract.
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const legacy = LEGACY_KEYS.filter((k) => k in (body as Record<string, unknown>));
    if (legacy.length > 0) {
      throw new AppError(ErrorCode.API_REQUEST_INVALID, {
        message:
          'The image-based sendInvoice contract has been removed. ' +
          'Send { invoiceId, invoiceType, requestId? } — the backend loads the invoice itself.',
        internalDetails: { legacyKeys: legacy },
      });
    }
  }

  const parseResult = SendInvoiceRequestSchema.safeParse(body);
  if (!parseResult.success) {
    throw new AppError(ErrorCode.API_REQUEST_INVALID, {
      internalDetails: {
        issues: parseResult.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      },
    });
  }

  const data = parseResult.data;
  if (!(INVOICE_TYPES as readonly string[]).includes(data.invoiceType)) {
    throw new AppError(ErrorCode.INVALID_INVOICE_TYPE, {
      internalDetails: { invoiceType: data.invoiceType },
    });
  }

  return {
    requestId: data.requestId || generateRequestId(),
    invoiceId: data.invoiceId,
    invoiceType: data.invoiceType as InvoiceType,
  };
}

function generateRequestId(): string {
  return `req-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
