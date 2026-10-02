/**
 * Closed Error Registry — the single source of truth for all public error
 * codes. No error code may exist outside this registry. Unknown/internal
 * exceptions map to SERVER_INTERNAL_ERROR and are never exposed raw.
 */

export const ErrorCode = {
  // ── API ──────────────────────────────────────────────────────────────
  API_AUTH_REQUIRED: 'API_AUTH_REQUIRED',
  API_AUTH_INVALID: 'API_AUTH_INVALID',
  API_FORBIDDEN: 'API_FORBIDDEN',
  API_RATE_LIMITED: 'API_RATE_LIMITED',
  API_REQUEST_INVALID: 'API_REQUEST_INVALID',
  API_REQUEST_TOO_LARGE: 'API_REQUEST_TOO_LARGE',
  API_METHOD_NOT_ALLOWED: 'API_METHOD_NOT_ALLOWED',
  API_NOT_FOUND: 'API_NOT_FOUND',

  // ── Application authorization ────────────────────────────────────────
  // Distinct authorization failures for the shared-store auth model.
  EMAIL_VERIFICATION_REQUIRED: 'EMAIL_VERIFICATION_REQUIRED',
  AUTH_CONTEXT_INVALID: 'AUTH_CONTEXT_INVALID',
  APP_ACCESS_REQUIRED: 'APP_ACCESS_REQUIRED',
  OWNER_REQUIRED: 'OWNER_REQUIRED',
  ACCOUNT_BLOCKED: 'ACCOUNT_BLOCKED',
  USER_ALREADY_EXISTS: 'USER_ALREADY_EXISTS',
  USER_INVITE_FAILED: 'USER_INVITE_FAILED',
  USER_NOT_FOUND: 'USER_NOT_FOUND',
  USER_ACTION_INVALID: 'USER_ACTION_INVALID',
  USER_ACTION_FAILED: 'USER_ACTION_FAILED',

  // ── WhatsApp ─────────────────────────────────────────────────────────
  WHATSAPP_NOT_CONNECTED: 'WHATSAPP_NOT_CONNECTED',
  WHATSAPP_CONNECTION_FAILED: 'WHATSAPP_CONNECTION_FAILED',
  WHATSAPP_AUTH_INVALID: 'WHATSAPP_AUTH_INVALID',
  WHATSAPP_SESSION_INVALID: 'WHATSAPP_SESSION_INVALID',
  WHATSAPP_RECIPIENT_INVALID: 'WHATSAPP_RECIPIENT_INVALID',
  WHATSAPP_SEND_FAILED: 'WHATSAPP_SEND_FAILED',
  WHATSAPP_SEND_TIMEOUT: 'WHATSAPP_SEND_TIMEOUT',

  // ── Invoice ──────────────────────────────────────────────────────────
  INVALID_INVOICE_TYPE: 'INVALID_INVOICE_TYPE',
  INVOICE_NOT_FOUND: 'INVOICE_NOT_FOUND',
  STORE_NOT_CONFIGURED: 'STORE_NOT_CONFIGURED',
  STORE_CONFIGURATION_AMBIGUOUS: 'STORE_CONFIGURATION_AMBIGUOUS',
  PARTY_PHONE_MISSING: 'PARTY_PHONE_MISSING',
  WHATSAPP_TEMPLATE_MISSING: 'WHATSAPP_TEMPLATE_MISSING',
  INVOICE_PDF_GENERATION_FAILED: 'INVOICE_PDF_GENERATION_FAILED',
  INVOICE_SEND_FAILED: 'INVOICE_SEND_FAILED',

  // ── Security ─────────────────────────────────────────────────────────
  SECURITY_POLICY_VIOLATION: 'SECURITY_POLICY_VIOLATION',
  SECURITY_IDENTITY_MISMATCH: 'SECURITY_IDENTITY_MISMATCH',
  SECURITY_SESSION_CORRUPTED: 'SECURITY_SESSION_CORRUPTED',
  SECURITY_SESSION_CLEANUP_FAILED: 'SECURITY_SESSION_CLEANUP_FAILED',

  // ── Server ───────────────────────────────────────────────────────────
  SERVER_NOT_READY: 'SERVER_NOT_READY',
  SERVER_BUSY: 'SERVER_BUSY',
  SERVER_OPERATION_TIMEOUT: 'SERVER_OPERATION_TIMEOUT',
  SERVER_INTERNAL_ERROR: 'SERVER_INTERNAL_ERROR',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

export const ERROR_HTTP_STATUS: Readonly<Record<ErrorCodeValue, number>> = Object.freeze({
  API_AUTH_REQUIRED: 401,
  API_AUTH_INVALID: 401,
  API_FORBIDDEN: 403,
  API_RATE_LIMITED: 429,
  API_REQUEST_INVALID: 400,
  API_REQUEST_TOO_LARGE: 413,
  API_METHOD_NOT_ALLOWED: 405,
  API_NOT_FOUND: 404,

  EMAIL_VERIFICATION_REQUIRED: 403,
  AUTH_CONTEXT_INVALID: 403,
  APP_ACCESS_REQUIRED: 403,
  OWNER_REQUIRED: 403,
  ACCOUNT_BLOCKED: 403,
  USER_ALREADY_EXISTS: 409,
  USER_INVITE_FAILED: 502,
  USER_NOT_FOUND: 404,
  USER_ACTION_INVALID: 409,
  USER_ACTION_FAILED: 502,

  WHATSAPP_NOT_CONNECTED: 503,
  WHATSAPP_CONNECTION_FAILED: 503,
  WHATSAPP_AUTH_INVALID: 401,
  WHATSAPP_SESSION_INVALID: 401,
  WHATSAPP_RECIPIENT_INVALID: 400,
  WHATSAPP_SEND_FAILED: 502,
  WHATSAPP_SEND_TIMEOUT: 504,

  INVALID_INVOICE_TYPE: 400,
  INVOICE_NOT_FOUND: 404,
  STORE_NOT_CONFIGURED: 503,
  STORE_CONFIGURATION_AMBIGUOUS: 500,
  PARTY_PHONE_MISSING: 400,
  WHATSAPP_TEMPLATE_MISSING: 503,
  INVOICE_PDF_GENERATION_FAILED: 500,
  INVOICE_SEND_FAILED: 502,

  SECURITY_POLICY_VIOLATION: 403,
  SECURITY_IDENTITY_MISMATCH: 403,
  SECURITY_SESSION_CORRUPTED: 500,
  SECURITY_SESSION_CLEANUP_FAILED: 500,

  SERVER_NOT_READY: 503,
  SERVER_BUSY: 503,
  SERVER_OPERATION_TIMEOUT: 504,
  SERVER_INTERNAL_ERROR: 500,
});

export const ERROR_DEFAULT_MESSAGE: Readonly<Record<ErrorCodeValue, string>> = Object.freeze({
  API_AUTH_REQUIRED: 'Authentication is required to access this endpoint.',
  API_AUTH_INVALID: 'The provided authentication credentials are invalid.',
  API_FORBIDDEN: 'You are not authorized to perform this action.',
  API_RATE_LIMITED: 'Too many requests. Please retry later.',
  API_REQUEST_INVALID: 'The request is invalid or malformed.',
  API_REQUEST_TOO_LARGE: 'The request body exceeds the maximum allowed size.',
  API_METHOD_NOT_ALLOWED: 'The HTTP method is not allowed for this endpoint.',
  API_NOT_FOUND: 'The requested endpoint was not found.',

  EMAIL_VERIFICATION_REQUIRED: 'Verify your email address before accessing FUSION ONE.',
  AUTH_CONTEXT_INVALID:
    'This session cannot access FUSION ONE. Sign in with your password to continue.',
  APP_ACCESS_REQUIRED: 'You do not have access to FUSION ONE.',
  OWNER_REQUIRED: 'Owner access is required for this operation.',
  ACCOUNT_BLOCKED: 'Your FUSION ONE account has been blocked by the store owner.',
  USER_ALREADY_EXISTS: 'An account with this email already exists.',
  USER_INVITE_FAILED: 'Failed to send the invitation email. Please try again.',
  USER_NOT_FOUND: 'This user does not exist.',
  USER_ACTION_INVALID: 'This action is not available for this user.',
  USER_ACTION_FAILED: 'The user operation failed. Please try again.',

  WHATSAPP_NOT_CONNECTED: 'WhatsApp is not connected.',
  WHATSAPP_CONNECTION_FAILED: 'WhatsApp connection failed.',
  WHATSAPP_AUTH_INVALID: 'WhatsApp authentication is invalid.',
  WHATSAPP_SESSION_INVALID: 'WhatsApp session is invalid.',
  WHATSAPP_RECIPIENT_INVALID: 'The recipient identifier is invalid.',
  WHATSAPP_SEND_FAILED: 'Failed to send the WhatsApp message.',
  WHATSAPP_SEND_TIMEOUT: 'The WhatsApp send operation timed out.',

  INVALID_INVOICE_TYPE: 'The invoice type is invalid. Allowed: sale, purchase, proforma.',
  INVOICE_NOT_FOUND: 'The requested invoice was not found.',
  STORE_NOT_CONFIGURED: 'No store is configured for this deployment. Create a store before sending invoices.',
  STORE_CONFIGURATION_AMBIGUOUS: 'Multiple stores exist; the store cannot be determined unambiguously.',
  PARTY_PHONE_MISSING: 'The invoice party does not have a phone number on file.',
  WHATSAPP_TEMPLATE_MISSING: 'No WhatsApp message template is configured for this document type. Set one in Settings → WhatsApp Delivery.',
  INVOICE_PDF_GENERATION_FAILED: 'Failed to generate the invoice PDF.',
  INVOICE_SEND_FAILED: 'Failed to send the invoice.',

  SECURITY_POLICY_VIOLATION: 'A security policy violation was detected.',
  SECURITY_IDENTITY_MISMATCH: 'The connected WhatsApp identity does not match the expected identity.',
  SECURITY_SESSION_CORRUPTED: 'The WhatsApp session is corrupted.',
  SECURITY_SESSION_CLEANUP_FAILED: 'Failed to clean up the WhatsApp session securely.',

  SERVER_NOT_READY: 'The server is not ready to handle requests.',
  SERVER_BUSY: 'The server is busy and cannot process the request at this time.',
  SERVER_OPERATION_TIMEOUT: 'The server operation timed out.',
  SERVER_INTERNAL_ERROR: 'An internal server error occurred.',
});

const ALL_ERROR_CODES: ReadonlySet<string> = new Set(Object.values(ErrorCode));

export function isValidErrorCode(code: string): code is ErrorCodeValue {
  return ALL_ERROR_CODES.has(code);
}

/**
 * The canonical application error. Internal details can be attached but are
 * never serialized to the frontend.
 */
export class AppError extends Error {
  readonly code: ErrorCodeValue;
  readonly statusCode: number;
  readonly publicMessage: string;
  readonly internalDetails?: Record<string, unknown>;

  constructor(
    code: ErrorCodeValue,
    options?: {
      message?: string;
      internalDetails?: Record<string, unknown>;
      cause?: unknown;
    },
  ) {
    const publicMessage = options?.message ?? ERROR_DEFAULT_MESSAGE[code];
    super(publicMessage, { cause: options?.cause });
    this.name = 'AppError';
    this.code = code;
    this.statusCode = ERROR_HTTP_STATUS[code];
    this.publicMessage = publicMessage;
    this.internalDetails = options?.internalDetails;
  }

  toJSON(): { error: { code: string; message: string } } {
    return {
      error: {
        code: this.code,
        message: this.publicMessage,
      },
    };
  }
}

/** Map any unknown error to the canonical SERVER_INTERNAL_ERROR AppError. */
export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) {
    return err;
  }

  const internalDetails: Record<string, unknown> = {};
  if (err instanceof Error) {
    internalDetails.originalError = err.message;
    internalDetails.errorType = err.constructor.name;
  } else {
    internalDetails.originalError = String(err);
  }

  return new AppError(ErrorCode.SERVER_INTERNAL_ERROR, {
    internalDetails,
    cause: err,
  });
}
