/**
 * Message request validation (send, auto-send, receipt, statement, reminder
 * actions). The requests identify BUSINESS OBJECTS ONLY — the backend
 * resolves all authoritative data itself; no financial payload is ever
 * accepted from a client.
 */
import { z } from 'zod';
import { AppError, ErrorCode } from '../errors/registry.js';
import { INVOICE_TYPES, PAYMENT_DIRECTIONS, type InvoiceType, type PaymentDirection } from '../documents/types.js';

// ─── Invoice message (manual send + auto-send arm) ──────────────────────────

export const SendInvoiceRequestSchema = z
  .object({
    requestId: z.string().min(1).max(128).optional(),
    invoiceId: z.string().uuid('invoiceId must be a UUID'),
    invoiceType: z.string().min(1),
  })
  .strict(); // unknown keys (recipient/image/caption/...) are rejected

/** Legacy image-contract keys that must be rejected with a clear message. */
const LEGACY_KEYS = ['recipient', 'image', 'caption'] as const;

export interface ParsedSendInvoiceRequest {
  requestId: string;
  invoiceId: string;
  invoiceType: InvoiceType;
}

/**
 * Parse a sendInvoice request.
 * @throws AppError(API_REQUEST_INVALID) for malformed/legacy payloads.
 * @throws AppError(INVALID_INVOICE_TYPE) for an unknown invoice type.
 */
export function parseSendInvoiceRequest(body: unknown): ParsedSendInvoiceRequest {
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

// ─── Payment receipt ─────────────────────────────────────────────────────────

export const SendReceiptRequestSchema = z
  .object({
    requestId: z.string().min(1).max(128).optional(),
    paymentId: z.string().uuid('paymentId must be a UUID'),
    direction: z.string().min(1),
  })
  .strict();

export interface ParsedSendReceiptRequest {
  requestId: string;
  paymentId: string;
  direction: PaymentDirection;
}

export function parseSendReceiptRequest(body: unknown): ParsedSendReceiptRequest {
  const parseResult = SendReceiptRequestSchema.safeParse(body);
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
  if (!(PAYMENT_DIRECTIONS as readonly string[]).includes(data.direction)) {
    throw new AppError(ErrorCode.PAYMENT_DIRECTION_INVALID, {
      internalDetails: { direction: data.direction },
    });
  }
  return {
    requestId: data.requestId || generateRequestId(),
    paymentId: data.paymentId,
    direction: data.direction as PaymentDirection,
  };
}

// ─── Payment reminder ────────────────────────────────────────────────────────

export const SendReminderRequestSchema = z
  .object({
    requestId: z.string().min(1).max(128).optional(),
    saleId: z.string().uuid('saleId must be a UUID'),
  })
  .strict();

export interface ParsedSendReminderRequest {
  requestId: string;
  saleId: string;
}

export function parseSendReminderRequest(body: unknown): ParsedSendReminderRequest {
  const parseResult = SendReminderRequestSchema.safeParse(body);
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
  return {
    requestId: parseResult.data.requestId || generateRequestId(),
    saleId: parseResult.data.saleId,
  };
}

// ─── Payment statement ───────────────────────────────────────────────────────

/** The invoice types a Payment Statement can cover (proformas carry no
 *  payments — deliberately rejected). */
export type StatementInvoiceType = 'sale' | 'purchase';

export const SendStatementRequestSchema = z
  .object({
    requestId: z.string().min(1).max(128).optional(),
    invoiceId: z.string().uuid('invoiceId must be a UUID'),
    invoiceType: z.enum(['sale', 'purchase']),
  })
  .strict();

export interface ParsedSendStatementRequest {
  requestId: string;
  invoiceId: string;
  invoiceType: StatementInvoiceType;
}

export function parseSendStatementRequest(body: unknown): ParsedSendStatementRequest {
  const parseResult = SendStatementRequestSchema.safeParse(body);
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
  return {
    requestId: parseResult.data.requestId || generateRequestId(),
    invoiceId: parseResult.data.invoiceId,
    invoiceType: parseResult.data.invoiceType,
  };
}

// ─── Reminder configuration ──────────────────────────────────────────────────

export const ReminderSettingsRequestSchema = z
  .object({
    enabled: z.boolean(),
    frequencyDays: z.number().int().min(1).max(365),
    maxReminders: z.number().int().min(1).max(50),
  })
  .strict();

export interface ParsedReminderSettingsRequest {
  enabled: boolean;
  frequencyDays: number;
  maxReminders: number;
}

export function parseReminderSettingsRequest(body: unknown): ParsedReminderSettingsRequest {
  const parseResult = ReminderSettingsRequestSchema.safeParse(body);
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
  return parseResult.data;
}

function generateRequestId(): string {
  return `req-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
