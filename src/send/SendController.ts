/**
 * Send Controller — the transport stage of the sendInvoice operation.
 * Serializes send operations (concurrency = 1), enforces the send timeout,
 * retries transient failures with bounded backoff, maps failures into the
 * canonical error registry, and emits SEND_INVOICE_RESULT events. Invoice
 * composition (Supabase load → InvoiceData → template → PDF) happens in
 * invoice/send.ts BEFORE this controller is invoked. The controller never
 * creates, stores, or persists invoices — after a send settles, all
 * references are released.
 */
import { getConfig } from '../config/index.js';
import { getLogger } from '../logging/logger.js';
import { getEventBus } from '../events/emitter.js';
import { EventType } from '../events/registry.js';
import { getLifecycle } from '../session/lifecycle.js';
import { AsyncMutex } from '../utils/mutex.js';
import { AppError, ErrorCode, type ErrorCodeValue } from '../errors/registry.js';
import type { WhatsAppManager, DocumentThumbnail } from '../whatsapp/WhatsAppManager.js';
import type { SecurityManager } from '../security/SecurityManager.js';

/** The transport-stage send input (produced by the invoice pipeline). */
export interface SendInput {
  requestId: string;
  /** Recipient JID (already normalized). */
  recipient: string;
  pdfBuffer: Buffer;
  /** Attachment filename, e.g. `SAL-2026-27-0003.pdf`. */
  fileName: string;
  /** Resolved WhatsApp message text (placeholders substituted). */
  caption: string;
  /** The structured chat-bubble preview (JPEG bytes + the generator's
   *  width/height) passed through UNCHANGED; null = no preview. */
  thumbnail?: DocumentThumbnail | null;
}

export interface SendResult {
  success: boolean;
  requestId: string;
  messageId?: string;
  errorCode?: string;
}

/** Only WHATSAPP_SEND_FAILED is retryable — all other errors are final. */
const RETRYABLE_ERROR_CODES: ReadonlySet<ErrorCodeValue> = new Set([
  ErrorCode.WHATSAPP_SEND_FAILED,
]);

export class SendController {
  /** Serializes send operations — max concurrent sends = 1. */
  private readonly sendMutex = new AsyncMutex();
  private whatsappManager: WhatsAppManager | null = null;
  private securityManager: SecurityManager | null = null;

  registerWhatsAppManager(wm: WhatsAppManager): void {
    this.whatsappManager = wm;
  }

  registerSecurityManager(sm: SecurityManager): void {
    this.securityManager = sm;
  }

  /**
   * Execute a sendInvoice operation (transport stage): check operational →
   * acquire the send mutex → wake-on-demand (never pairs; joins any
   * in-flight startup) → verify connected → send with retry/timeout →
   * emit SEND_INVOICE_RESULT.
   */
  async send(input: SendInput): Promise<SendResult> {
    const log = getLogger();
    const { requestId, recipient, pdfBuffer, fileName, caption, thumbnail } = input;

    log.info(
      { requestId, recipient: '[present]', fileName, pdfBytes: pdfBuffer.length, hasCaption: !!caption, thumbnailBytes: thumbnail?.jpeg.length ?? 0 },
      'sendInvoice starting',
    );

    if (!this.securityManager?.isOperational()) {
      const errorCode = ErrorCode.SERVER_NOT_READY;
      this.emitResult(requestId, recipient, false, errorCode);
      throw new AppError(errorCode, {
        message: 'Server is not ready to process send operations',
      });
    }

    const releaseMutex = await this.sendMutex.acquire();

    try {
      // Wake-on-demand: a valid idle session is woken here — the user never
      // has to press Connect first. Without a session this resolves to the
      // canonical "connection required" error (never pairs).
      if (this.whatsappManager) {
        await this.whatsappManager.ensureReadyForSend();
      }

      this.securityManager?.assertSendAllowed();

      const result = await this.sendWithRetry(
        recipient,
        pdfBuffer,
        fileName,
        caption,
        thumbnail,
        requestId,
      );

      this.emitResult(requestId, recipient, true);

      log.info({ requestId, messageId: result.messageId }, 'sendInvoice succeeded');

      return {
        success: true,
        requestId,
        messageId: result.messageId,
      };
    } catch (err) {
      const appError = err instanceof AppError
        ? err
        : new AppError(ErrorCode.WHATSAPP_SEND_FAILED, {
            cause: err,
            internalDetails: {
              errorType: err instanceof Error ? err.constructor.name : 'unknown',
            },
          });

      this.emitResult(requestId, recipient, false, appError.code);

      log.warn({ requestId, errorCode: appError.code }, 'sendInvoice failed');

      throw appError;
    } finally {
      releaseMutex();
    }
  }

  /**
   * Send with bounded retry for transient failures and a per-attempt
   * timeout. Non-retryable errors (invalid recipient, not connected,
   * security, timeout) are thrown immediately.
   */
  private async sendWithRetry(
    recipient: string,
    pdfBuffer: Buffer,
    fileName: string,
    caption: string,
    thumbnail: DocumentThumbnail | null | undefined,
    requestId: string,
  ): Promise<{ messageId: string }> {
    const cfg = getConfig();
    const log = getLogger();
    const maxRetries = cfg.sendMaxRetries;

    let lastError: AppError | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      // May have changed during a retry wait.
      if (getLifecycle().sendsBlocked || getLifecycle().shuttingDown) {
        throw new AppError(ErrorCode.SERVER_NOT_READY, {
          message: 'Server became unavailable during send operation',
        });
      }

      try {
        return await this.sendWithTimeout(
          recipient,
          pdfBuffer,
          fileName,
          caption,
          thumbnail,
          cfg.sendTimeoutMs,
        );
      } catch (err) {
        const appError = err instanceof AppError
          ? err
          : new AppError(ErrorCode.WHATSAPP_SEND_FAILED, {
              cause: err,
              internalDetails: {
                errorType: err instanceof Error ? err.constructor.name : 'unknown',
              },
            });

        lastError = appError;

        if (!RETRYABLE_ERROR_CODES.has(appError.code)) {
          throw appError;
        }

        if (attempt < maxRetries) {
          const delay = this.calculateRetryDelay(attempt);
          log.info(
            { requestId, attempt: attempt + 1, delayMs: delay, errorCode: appError.code },
            'Transient send failure; scheduling retry',
          );
          await this.sleep(delay);
        } else {
          log.warn(
            { requestId, attempts: attempt + 1, errorCode: appError.code },
            'All retries exhausted',
          );
        }
      }
    }

    throw lastError ?? new AppError(ErrorCode.WHATSAPP_SEND_FAILED);
  }

  /**
   * Send a single attempt with a timeout. The timer is ALWAYS cleared when
   * the race settles — a successful send must not leave a 30-second timer
   * alive (it would pin the event loop).
   */
  private async sendWithTimeout(
    recipient: string,
    pdfBuffer: Buffer,
    fileName: string,
    caption: string,
    thumbnail: DocumentThumbnail | null | undefined,
    timeoutMs: number,
  ): Promise<{ messageId: string }> {
    if (!this.whatsappManager) {
      throw new AppError(ErrorCode.SERVER_INTERNAL_ERROR, {
        internalDetails: { reason: 'WhatsAppManager not registered' },
      });
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new AppError(ErrorCode.WHATSAPP_SEND_TIMEOUT, {
          internalDetails: { timeoutMs },
        }));
      }, timeoutMs);
    });

    const sendPromise = this.whatsappManager.sendDocumentMessage(
      recipient,
      pdfBuffer,
      fileName,
      caption,
      thumbnail,
    );

    try {
      return await Promise.race([sendPromise, timeoutPromise]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** The payload contains only send-operation information — never PDF bytes
   *  or caption content. */
  private emitResult(
    requestId: string,
    recipient: string,
    success: boolean,
    errorCode?: ErrorCodeValue,
  ): void {
    getEventBus().emitEvent(EventType.SEND_INVOICE_RESULT, {
      requestId,
      recipient,
      result: success ? 'success' : 'failed',
      errorCode,
    });
  }

  private calculateRetryDelay(attempt: number): number {
    const cfg = getConfig();
    const delay = cfg.sendRetryBaseMs * Math.pow(2, attempt);
    // Jitter: +0 to +25%
    const jitter = Math.floor(delay * 0.25 * Math.random());
    return delay + jitter;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Cancel any active send operation (logout/shutdown). The pipeline is
   * stateless: the lifecycle's sendsBlocked flag aborts in-flight sends
   * during their retry checks, and the current send completes or times out.
   */
  async cancelActive(_reason: string): Promise<void> {
    getLogger().info({ reason: _reason }, 'Send cancellation requested (stateless pipeline)');
  }
}
