/**
 * Durable message jobs — the ONE server-side message execution system.
 *
 * Job lifecycle (message_jobs table — the database IS the schedule):
 *   pending → processing → succeeded | failed | cancelled
 *   (a retryable failure returns to pending with a backed-off run_at;
 *    an abandoned processing job is recovered once its lease expires)
 *
 * Ownership boundaries:
 *   - USER-REQUESTED operations (manual receipt, manual reminder, auto-send
 *     arming, reminder configuration) are authorized per-request by the API
 *     layer; their business data loads run under the CALLER's user-context
 *     client (RLS).
 *   - DURABLE BACKGROUND EXECUTION (the scheduler) and SYSTEM-OWNED job
 *     state run under the backend's service-key client — an intentional,
 *     documented system access path (never exposed to any browser).
 *
 * Delivery semantics are AT-LEAST-ONCE: Baileys/WhatsApp cannot guarantee
 * exactly-once delivery, so a crash between transport acceptance and state
 * persistence can produce a duplicate send after recovery. Claiming +
 * idempotent creation minimize the window; no exactly-once claim is made.
 */
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getLogger } from '../logging/logger.js';
import { getEventBus } from '../events/emitter.js';
import { EventType } from '../events/registry.js';
import { AppError, ErrorCode, type ErrorCodeValue } from '../errors/registry.js';
import { getAdminClient } from '../supabase/clients.js';
import { getConfig } from '../config/index.js';
import type { SendController } from '../whatsapp/SendController.js';
import type { InvoiceType, PaymentDirection } from '../documents/types.js';
import { sendInvoiceMessage, sendReminderMessage, sendReceiptMessage, sendStatementMessage } from './send.js';
import { loadSaleInvoice } from '../documents/repository.js';

// ─── Job model (mirror of the message_jobs table) ──────────────────────────

export type MessageJobType = 'invoice_send' | 'reminder' | 'receipt' | 'statement';
export type MessageJobStatus = 'pending' | 'processing' | 'succeeded' | 'failed' | 'cancelled';

export interface MessageJobRow {
  id: string;
  job_type: MessageJobType;
  status: MessageJobStatus;
  sale_id: string | null;
  purchase_id: string | null;
  proforma_id: string | null;
  payment_in_id: string | null;
  payment_out_id: string | null;
  run_at: string;
  attempts: number;
  max_attempts: number;
  claimed_by: string | null;
  claimed_at: string | null;
  claim_expires_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  message_id: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

/** The business-object reference of a job (exactly one is set per job_type). */
export interface JobRef {
  refType: 'sale' | 'purchase' | 'proforma' | 'payment_in' | 'payment_out';
  refId: string;
}

export function jobRef(job: MessageJobRow): JobRef {
  if (job.sale_id) return { refType: 'sale', refId: job.sale_id };
  if (job.purchase_id) return { refType: 'purchase', refId: job.purchase_id };
  if (job.proforma_id) return { refType: 'proforma', refId: job.proforma_id };
  if (job.payment_in_id) return { refType: 'payment_in', refId: job.payment_in_id };
  if (job.payment_out_id) return { refType: 'payment_out', refId: job.payment_out_id };
  throw new AppError(ErrorCode.SERVER_INTERNAL_ERROR, {
    internalDetails: { reason: 'job has no business-object reference', jobId: job.id },
  });
}

/** Stable per-process worker identity (claim attribution + logs). */
export function messageWorkerId(): string {
  return `messages-${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`;
}

/** The system-context client (service key). Job state is system-owned. */
export function requireSystemClient(): SupabaseClient {
  const client = getAdminClient();
  if (!client) {
    throw new AppError(ErrorCode.SERVER_NOT_READY, {
      message: 'The durable message system is not configured on this server (missing server credentials).',
      internalDetails: { reason: 'SUPABASE_SECRET_KEY missing' },
    });
  }
  return client;
}

// ─── Outcome mapping (job-level retry policy — SEPARATE from the
//     SendController's transport-level retries, which remain authoritative
//     for actual WhatsApp delivery attempts within one execution) ────────────

/** Terminal, will never succeed by retrying: fail the job. */
const FAIL_ERROR_CODES: ReadonlySet<string> = new Set([
  ErrorCode.INVALID_INVOICE_TYPE,
  ErrorCode.STORE_NOT_CONFIGURED,
  ErrorCode.STORE_CONFIGURATION_AMBIGUOUS,
  ErrorCode.PARTY_PHONE_MISSING,
  ErrorCode.WHATSAPP_RECIPIENT_INVALID,
  ErrorCode.WHATSAPP_TEMPLATE_MISSING,
  ErrorCode.PAYMENT_DIRECTION_INVALID,
  ErrorCode.MESSAGE_JOB_CONFLICT,
]);

/** The business object is gone or no longer eligible: stop the chain. */
const CANCEL_ERROR_CODES: ReadonlySet<string> = new Set([
  ErrorCode.INVOICE_NOT_FOUND,
  ErrorCode.PAYMENT_NOT_FOUND,
  ErrorCode.REMINDER_NOT_ELIGIBLE,
]);

/** Everything else (transport unavailability, timeouts, internal errors) is
 *  retryable at the JOB level with durable backoff. */
function isFailCode(code: ErrorCodeValue): boolean {
  return FAIL_ERROR_CODES.has(code);
}
function isCancelCode(code: ErrorCodeValue): boolean {
  return CANCEL_ERROR_CODES.has(code);
}

// ─── Job creation (idempotent via the partial unique indexes) ───────────────

export type CreateJobResult =
  | { created: true; job: MessageJobRow }
  | { created: false; reason: 'conflict' };

async function insertJob(values: Record<string, unknown>): Promise<CreateJobResult> {
  const db = requireSystemClient();
  const { data, error } = await db.from('message_jobs').insert(values).select().single();
  if (error) {
    // 23505 = unique_violation: a pending/processing job for the same
    // business object already exists (double click / re-arm / race).
    if (error.code === '23505') {
      return { created: false, reason: 'conflict' };
    }
    throw new AppError(ErrorCode.SERVER_INTERNAL_ERROR, {
      message: 'Failed to create the message job.',
      internalDetails: { step: 'message_jobs.insert', pgError: error.message, code: error.code },
    });
  }
  const job = data as MessageJobRow;
  getLogger().info(
    { jobId: job.id, jobType: job.job_type, ref: jobRef(job), runAt: job.run_at },
    'Message job created',
  );
  return { created: true, job };
}

/** Invoice auto-send job (durable replacement for the sessionStorage arm). */
export async function createInvoiceAutoSendJob(
  invoiceId: string,
  invoiceType: InvoiceType,
): Promise<CreateJobResult> {
  const ref: Record<string, string> =
    invoiceType === 'sale'
      ? { sale_id: invoiceId }
      : invoiceType === 'purchase'
        ? { purchase_id: invoiceId }
        : { proforma_id: invoiceId };
  return insertJob({ job_type: 'invoice_send', ...ref, run_at: new Date().toISOString() });
}

/** Manual payment-receipt job (the Payments dialog / Payments page action).
 *  Automatic receipt jobs for SUBSEQUENT payments are created INSIDE the
 *  receive_payment / pay_purchase RPCs (transactionally, via
 *  private.create_auto_receipt_job) — not by this backend function; the
 *  scheduler discovers and executes them exactly like any other job. */
export async function createReceiptJob(
  paymentId: string,
  direction: PaymentDirection,
): Promise<CreateJobResult> {
  const ref: Record<string, string> =
    direction === 'in' ? { payment_in_id: paymentId } : { payment_out_id: paymentId };
  return insertJob({ job_type: 'receipt', ...ref, run_at: new Date().toISOString() });
}

/** Manual payment-statement job (the Payments dialog's Send Payment
 *  Statement action). Statements are ALWAYS manual — no payment operation
 *  ever creates one. */
export async function createStatementJob(
  invoiceId: string,
  direction: PaymentDirection,
): Promise<CreateJobResult> {
  const ref: Record<string, string> =
    direction === 'in' ? { sale_id: invoiceId } : { purchase_id: invoiceId };
  return insertJob({ job_type: 'statement', ...ref, run_at: new Date().toISOString() });
}

// ─── Claim / recovery / completion (transactional RPCs) ─────────────────────

/** Claim up to p_batch due jobs (FOR UPDATE SKIP LOCKED — atomic). */
export async function claimDueMessageJobs(
  workerId: string,
  batch = 5,
  jobId?: string,
): Promise<MessageJobRow[]> {
  const db = requireSystemClient();
  const leaseSeconds = Math.round(getConfig().messageJobLeaseMs / 1000);
  const { data, error } = await db.rpc('claim_due_message_jobs', {
    p_worker: workerId,
    p_batch_size: batch,
    p_lease_seconds: leaseSeconds,
    ...(jobId ? { p_job_id: jobId } : {}),
  });
  if (error) {
    throw new AppError(ErrorCode.SERVER_INTERNAL_ERROR, {
      message: 'Failed to claim message jobs.',
      internalDetails: { step: 'claim_due_message_jobs', pgError: error.message },
    });
  }
  return (data as MessageJobRow[]) ?? [];
}

/** Recover abandoned jobs (expired claims) — continuous, not startup-only. */
export async function recoverExpiredMessageJobs(): Promise<Array<{ id: string; status: string; attempts: number }>> {
  const db = requireSystemClient();
  const { data, error } = await db.rpc('recover_expired_message_jobs');
  if (error) {
    throw new AppError(ErrorCode.SERVER_INTERNAL_ERROR, {
      message: 'Failed to recover expired message jobs.',
      internalDetails: { step: 'recover_expired_message_jobs', pgError: error.message },
    });
  }
  return (data as Array<{ id: string; status: string; attempts: number }>) ?? [];
}

/** Persist a job outcome (and, for successful reminders, advance the chain). */
export async function completeMessageJob(
  job: MessageJobRow,
  outcome: 'success' | 'retry' | 'fail' | 'cancel',
  options: { messageId?: string; error?: string } = {},
): Promise<{ updated: boolean; status?: string; next_job_created?: boolean }> {
  const db = requireSystemClient();
  const { data, error } = await db.rpc('complete_message_job', {
    p_job_id: job.id,
    p_outcome: outcome,
    p_message_id: options.messageId ?? null,
    p_error: outcome === 'success' ? null : (options.error ?? 'unknown error').slice(0, 2000),
  });
  if (error) {
    throw new AppError(ErrorCode.SERVER_INTERNAL_ERROR, {
      message: 'Failed to persist the message job outcome.',
      internalDetails: { step: 'complete_message_job', pgError: error.message },
    });
  }
  const result = (data ?? {}) as { updated?: boolean; status?: string; next_job_created?: boolean };
  return {
    updated: result.updated === true,
    status: result.status,
    next_job_created: result.next_job_created === true,
  };
}

/** Cancel pending reminder jobs for a sale (manual invoice send supersede). */
export async function cancelPendingAutoSendJobs(
  ref: { saleId?: string; purchaseId?: string; proformaId?: string },
): Promise<void> {
  const db = requireSystemClient();
  const filter = ref.saleId
    ? { sale_id: ref.saleId }
    : ref.purchaseId
      ? { purchase_id: ref.purchaseId }
      : { proforma_id: ref.proformaId! };
  const { error } = await db
    .from('message_jobs')
    .update({
      status: 'cancelled',
      finished_at: new Date().toISOString(),
      last_error: 'superseded by a manual send',
      updated_at: new Date().toISOString(),
    })
    .match({ ...filter, job_type: 'invoice_send', status: 'pending' });
  if (error) {
    // Best-effort: a failed cancel never blocks the manual send. The
    // duplicate-window is bounded by the scheduler's claim of the job.
    getLogger().warn(
      { pgError: error.message, ref },
      'Failed to cancel pending auto-send job before manual send',
    );
  }
}

// ─── Reminder configuration (RPC-backed, atomic with job reconciliation) ────

export interface ReminderConfigResult {
  config: {
    sale_id: string;
    enabled: boolean;
    frequency_days: number;
    max_reminders: number;
    reminders_sent: number;
    last_reminder_at: string | null;
  };
  job_created: boolean;
  jobs_cancelled: number;
  sale_status: string;
  sale_due: number;
}

export async function upsertReminderConfig(input: {
  saleId: string;
  enabled: boolean;
  frequencyDays: number;
  maxReminders: number;
}): Promise<ReminderConfigResult> {
  const db = requireSystemClient();
  const { data, error } = await db.rpc('upsert_reminder_config', {
    p_sale_id: input.saleId,
    p_enabled: input.enabled,
    p_frequency_days: input.frequencyDays,
    p_max_reminders: input.maxReminders,
  });
  if (error) {
    if (error.message.includes('frequency_days')) {
      throw new AppError(ErrorCode.API_REQUEST_INVALID, {
        message: 'Reminder frequency must be between 1 and 365 days.',
      });
    }
    if (error.message.includes('max_reminders')) {
      throw new AppError(ErrorCode.API_REQUEST_INVALID, {
        message: 'Maximum reminders must be between 1 and 50.',
      });
    }
    if (error.message.includes('Sale not found')) {
      throw new AppError(ErrorCode.INVOICE_NOT_FOUND, {
        message: 'The requested invoice was not found.',
      });
    }
    throw new AppError(ErrorCode.SERVER_INTERNAL_ERROR, {
      message: 'Failed to save the reminder configuration.',
      internalDetails: { step: 'upsert_reminder_config', pgError: error.message },
    });
  }
  const result = data as ReminderConfigResult;
  getLogger().info(
    { saleId: input.saleId, enabled: input.enabled, frequencyDays: input.frequencyDays, maxReminders: input.maxReminders, jobCreated: result.job_created, jobsCancelled: result.jobs_cancelled },
    'Reminder configuration updated',
  );
  return result;
}

/** Manual "send a reminder now" — pulls the scheduled job forward to NOW
 *  (or creates a one-off job when no chain is configured). */
export async function triggerReminderNow(saleId: string): Promise<MessageJobRow> {
  const db = requireSystemClient();
  const { data, error } = await db.rpc('trigger_reminder_now', { p_sale_id: saleId });
  if (error) {
    if (error.message.includes('Sale not found')) {
      throw new AppError(ErrorCode.INVOICE_NOT_FOUND, {
        message: 'The requested invoice was not found.',
      });
    }
    if (error.message.includes('not eligible')) {
      throw new AppError(ErrorCode.REMINDER_NOT_ELIGIBLE);
    }
    throw new AppError(ErrorCode.SERVER_INTERNAL_ERROR, {
      message: 'Failed to trigger the reminder.',
      internalDetails: { step: 'trigger_reminder_now', pgError: error.message },
    });
  }
  const job = (data as { job: MessageJobRow }).job;
  getLogger().info({ jobId: job.id, saleId, runAt: job.run_at }, 'Reminder triggered for immediate delivery');
  return job;
}

// ─── Execution (the ONE executor for every trigger path) ────────────────────

/**
 * Execute ONE claimed message job: resolve the job type → load CURRENT
 * authoritative business data → validate eligibility → compose the document
 * → deliver through the existing transport → persist the outcome (+ advance
 * the reminder chain). Called by the scheduler AND by the manual trigger
 * paths — there is no second execution implementation.
 */
export async function executeMessageJob(
  sendController: SendController,
  job: MessageJobRow,
  /** The data-access context: the CALLER's user-context client for
   *  user-requested executions (RLS), the system client for the
   *  scheduler. The execution implementation is the ONE either way. */
  db: SupabaseClient,
): Promise<{ outcome: 'success' | 'retry' | 'fail' | 'cancel'; messageId?: string; error?: string; stoppedReason?: string }> {
  const log = getLogger();
  const requestId = `job-${job.id}`;

  log.info(
    { jobId: job.id, jobType: job.job_type, ref: jobRef(job), attempt: job.attempts },
    'Message job execution starting',
  );

  try {
    switch (job.job_type) {
      case 'invoice_send': {
        // Eligibility: a cancelled sale must not be (re)sent; the document
        // must still exist (deleted → stop).
        const invoiceType: InvoiceType = job.sale_id ? 'sale' : job.purchase_id ? 'purchase' : 'proforma';
        if (job.sale_id) {
          const rows = await loadSaleInvoice(job.sale_id, db);
          if (rows.sale?.status === 'cancelled') {
            return { outcome: 'cancel', stoppedReason: 'invoice cancelled' };
          }
        }
        const result = await sendInvoiceMessage(sendController, {
          requestId,
          invoiceId: job.sale_id ?? job.purchase_id ?? job.proforma_id!,
          invoiceType,
          db,
        });
        return { outcome: 'success', messageId: result.messageId };
      }

      case 'reminder': {
        // CURRENT-state eligibility gate (never stale data): cancelled or
        // fully-paid invoices stop the chain; a disabled or exhausted
        // configuration stops it too. A manual one-off (no configuration
        // row) proceeds.
        const rows = await loadSaleInvoice(job.sale_id!, db);
        if (rows.sale?.status !== 'active') {
          return { outcome: 'cancel', stoppedReason: `invoice ${rows.sale?.status ?? 'missing'}` };
        }
        const currentDue = Number(rows.sale?.due ?? 0);
        if (currentDue <= 0) {
          return { outcome: 'cancel', stoppedReason: 'invoice fully paid' };
        }
        if (rows.reminderConfig && (!rows.reminderConfig.enabled || rows.reminderConfig.reminders_sent >= rows.reminderConfig.max_reminders)) {
          return {
            outcome: 'cancel',
            stoppedReason: rows.reminderConfig.enabled
              ? 'configured reminder limit reached'
              : 'reminders disabled',
          };
        }
        const result = await sendReminderMessage(sendController, {
          requestId,
          saleId: job.sale_id!,
          db,
        });
        return { outcome: 'success', messageId: result.messageId };
      }

      case 'receipt': {
        const direction: PaymentDirection = job.payment_in_id ? 'in' : 'out';
        const result = await sendReceiptMessage(sendController, {
          requestId,
          paymentId: job.payment_in_id ?? job.payment_out_id!,
          direction,
          db,
        });
        return { outcome: 'success', messageId: result.messageId };
      }

      case 'statement': {
        const direction: PaymentDirection = job.sale_id ? 'in' : 'out';
        const result = await sendStatementMessage(sendController, {
          requestId,
          invoiceId: job.sale_id ?? job.purchase_id!,
          direction,
          db,
        });
        return { outcome: 'success', messageId: result.messageId };
      }

      default:
        return { outcome: 'fail', error: `unknown job type: ${job.job_type}` };
    }
  } catch (err) {
    const appError = err instanceof AppError
      ? err
      : new AppError(ErrorCode.SERVER_INTERNAL_ERROR, {
          cause: err,
          internalDetails: { errorType: err instanceof Error ? err.constructor.name : 'unknown' },
        });

    const error = appError.publicMessage || appError.code;

    if (isCancelCode(appError.code)) {
      return { outcome: 'cancel', stoppedReason: error, error };
    }
    if (isFailCode(appError.code)) {
      return { outcome: 'fail', error: `${appError.code}: ${error}` };
    }
    // Retryable — unless the attempt budget is exhausted.
    if (job.attempts >= job.max_attempts) {
      return { outcome: 'fail', error: `${appError.code}: ${error} (attempts exhausted)` };
    }
    return { outcome: 'retry', error: `${appError.code}: ${error}` };
  }
}

/** Execute + persist + notify. The scheduler's and the manual path's shared
 *  tail. Returns the persisted outcome for callers that report to the UI.
 *
 * `options.trigger` records HOW this execution was initiated: 'manual' for
 * the user-awaiting inline routes (their HTTP responses carry the UI
 * feedback), 'automatic' (default) for everything the scheduler picked up
 * (auto-send, reminder chain, automatic receipts — nobody awaits these, so
 * the SSE event is their user-feedback channel).
 */
export async function runClaimedJob(
  sendController: SendController,
  job: MessageJobRow,
  db: SupabaseClient,
  options: { trigger?: 'automatic' | 'manual' } = {},
): Promise<{ outcome: 'success' | 'retry' | 'fail' | 'cancel'; status: string; error?: string }> {
  const log = getLogger();
  const execution = await executeMessageJob(sendController, job, db);

  const completion = await completeMessageJob(job, execution.outcome, {
    messageId: execution.messageId,
    error: execution.error ?? execution.stoppedReason,
  });

  const ref = jobRef(job);
  if (!completion.updated) {
    log.warn(
      { jobId: job.id, outcome: execution.outcome, reason: 'not processing anymore' },
      'Message job outcome could not be persisted (job moved on)',
    );
    return { outcome: execution.outcome, status: 'superseded', error: execution.error };
  }

  switch (execution.outcome) {
    case 'success':
      log.info({ jobId: job.id, jobType: job.job_type, ref, messageId: execution.messageId, nextJobCreated: completion.next_job_created }, 'Message job succeeded');
      break;
    case 'retry':
      log.warn({ jobId: job.id, jobType: job.job_type, ref, attempt: job.attempts, error: execution.error }, 'Message job failed — retry scheduled');
      break;
    case 'cancel':
      log.info({ jobId: job.id, jobType: job.job_type, ref, reason: execution.stoppedReason }, 'Message job cancelled — reminder chain stopped');
      break;
    default:
      log.error({ jobId: job.id, jobType: job.job_type, ref, error: execution.error }, 'Message job failed terminally');
  }

  // Live UI notification (additive SSE; the DB remains the truth).
  try {
    getEventBus().emitEvent(EventType.MESSAGE_JOB_RESULT, {
      jobId: job.id,
      jobType: job.job_type,
      refType: ref.refType,
      refId: ref.refId,
      trigger: options.trigger ?? 'automatic',
      result:
        execution.outcome === 'success' ? 'succeeded'
          : execution.outcome === 'cancel' ? 'cancelled'
          : execution.outcome === 'retry' ? 'retrying'
          : 'failed',
      ...(execution.error && execution.outcome !== 'success'
        ? { errorCode: execution.error.slice(0, 200) }
        : {}),
    });
  } catch (err) {
    // An event-envelope failure must never fail the persisted outcome.
    log.warn({ err: err instanceof Error ? err.message : String(err) }, 'Failed to emit MESSAGE_JOB_RESULT');
  }

  return {
    outcome: execution.outcome,
    status: completion.status ?? execution.outcome,
    error: execution.error,
  };
}
