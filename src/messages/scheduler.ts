/**
 * Message scheduler — the small internal scheduler inside the backend. NO
 * external queue/broker/cron infrastructure: the PostgreSQL message_jobs
 * table IS the durable schedule; this module only discovers, claims,
 * executes, and recovers.
 *
 * Tick (periodic + poked):
 *   1. recover abandoned jobs (expired claim leases)
 *   2. atomically claim due jobs (FOR UPDATE SKIP LOCKED)
 *   3. execute claimed jobs SEQUENTIALLY (bounded batch; the SendController
 *      mutex serializes transport anyway)
 *   4. persist outcomes (retry/fail/success/cancel + reminder chain)
 *
 * Safety properties:
 *   - Two scheduler executions (overlap, or two processes during a deploy)
 *     can never execute the same job: claiming is atomic via SKIP LOCKED.
 *   - A job scheduled for tomorrow is NOT loaded into memory — it stays in
 *     PostgreSQL until run_at becomes due.
 *   - No PostgreSQL transaction is held during WhatsApp network operations:
 *     the claim RPC returns before execution; the lease covers the gap.
 *   - Empty scans are silent (no log noise).
 *
 * Lifecycle: start() with the Fastify process, stop() on shutdown (stop
 * scheduling; an in-flight tick finishes within a bounded wait; abandoned
 * claims are recovered by the next process via lease expiry — claims are
 * never blindly reset).
 */
import { getLogger } from '../logging/logger.js';
import { getConfig } from '../config/index.js';
import { AppError, ErrorCode } from '../errors/registry.js';
import { getAdminClient } from '../supabase/clients.js';
import type { SendController } from '../whatsapp/SendController.js';
import {
  claimDueMessageJobs,
  recoverExpiredMessageJobs,
  runClaimedJob,
  requireSystemClient,
  messageWorkerId,
} from './message-jobs.js';

/** Upper bound on jobs executed per tick (bounded batches). */
const TICK_BATCH_SIZE = 5;

export class MessageScheduler {
  private readonly sendController: SendController;
  private readonly workerId = messageWorkerId();
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private stopping = false;
  /** Resolves when the in-flight tick finishes (graceful shutdown). */
  private inFlight: Promise<void> = Promise.resolve();

  constructor(sendController: SendController) {
    this.sendController = sendController;
  }

  /** Start the periodic scan. Returns false (and logs a warning) when the
   *  system client is not configured — the scheduler fails closed. */
  start(): boolean {
    const cfg = getConfig();
    const log = getLogger();

    // Fail closed when the system client (service key) is unavailable.
    if (!getAdminClient()) {
      log.warn(
        'Message scheduler NOT started: SUPABASE_SECRET_KEY is not configured (durable messaging disabled — fails closed)',
      );
      return false;
    }

    this.stopping = false;
    this.timer = setInterval(() => {
      void this.tick();
    }, cfg.messagePollIntervalMs);
    // A timer must never hold the process open on shutdown.
    this.timer.unref?.();

    log.info(
      { pollIntervalMs: cfg.messagePollIntervalMs, leaseMs: cfg.messageJobLeaseMs, workerId: this.workerId },
      'Message scheduler started',
    );

    // First scan shortly after boot (restart recovery is immediate).
    setTimeout(() => void this.tick(), 1500).unref?.();
    return true;
  }

  /** Run a scan as soon as possible (a job was just created due-now). */
  poke(): void {
    if (this.stopping) return;
    void this.tick();
  }

  /**
   * One scan: recover → claim → execute sequentially. Guarded so overlapping
   * triggers (interval + poke) run at most one tick at a time per process.
   */
  private async tick(): Promise<void> {
    if (this.ticking || this.stopping) return;
    this.ticking = true;
    this.inFlight = this.runTick();
    try {
      await this.inFlight;
    } finally {
      this.ticking = false;
    }
  }

  private async runTick(): Promise<void> {
    const log = getLogger();
    try {
      // 1. Recover abandoned jobs (crashed/stalled workers). Continuous —
      //    not startup-only. Only non-empty recoveries are logged.
      const recovered = await recoverExpiredMessageJobs();
      if (recovered.length > 0) {
        log.warn(
          { count: recovered.length, jobs: recovered.map((r) => ({ id: r.id, status: r.status, attempts: r.attempts })) },
          'Recovered expired message job claims',
        );
      }

      // 2. Claim due jobs (atomic; SKIP LOCKED).
      const jobs = await claimDueMessageJobs(this.workerId, TICK_BATCH_SIZE);
      if (jobs.length === 0) return; // silent empty scan

      // 3. Execute sequentially (bounded batch; no DB transaction held).
      for (const job of jobs) {
        if (this.stopping) {
          // Shutdown: unexecuted claimed jobs stay 'processing' — their
          // leases expire and the next process recovers them (retryable).
          log.info(
            { jobId: job.id, reason: 'shutdown' },
            'Message tick interrupted by shutdown — claimed jobs will be recovered by lease expiry',
          );
          break;
        }
        try {
          await runClaimedJob(this.sendController, job, requireSystemClient());
        } catch (err) {
          // One job's persistence failure must not block the batch.
          log.error(
            { jobId: job.id, err: err instanceof Error ? err.message : String(err) },
            'Message job execution error',
          );
        }
      }
    } catch (err) {
      if (err instanceof AppError && err.code === ErrorCode.SERVER_NOT_READY) {
        // Expected when the system client is unconfigured mid-run — stay
        // quiet (startup already warned).
        return;
      }
      log.error({ err: err instanceof Error ? err.message : String(err) }, 'Message scheduler tick failed');
    }
  }

  /** Graceful shutdown: stop scheduling, let the in-flight tick finish
   *  (bounded), never reset claims (leases handle recovery). */
  async stop(): Promise<void> {
    const log = getLogger();
    if (this.stopping) return;
    this.stopping = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    try {
      await Promise.race([
        this.inFlight,
        new Promise((resolve) => setTimeout(resolve, 8000)),
      ]);
    } catch {
      // best-effort
    }
    log.info('Message scheduler stopped');
  }
}
