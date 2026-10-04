/**
 * Application — wires the components together and owns the process
 * lifecycle: state machine, managers, API server, watchdog, warmups, signal
 * handlers, and graceful shutdown. The backend owns the complete WhatsApp
 * lifecycle; the frontend is primarily a reader of backend state.
 */
import { getConfig } from './config/index.js';
import { getLogger } from './logging/logger.js';
import { getEventBus } from './events/emitter.js';
import { EventType } from './events/registry.js';
import { getLifecycle } from './session/lifecycle.js';
import { StateMachine } from './state/state-machine.js';
import { WhatsAppState, type WhatsAppStateValue } from './state/whatsapp-states.js';
import { isValidWhatsAppTransition } from './state/transitions.js';
import { SessionManager } from './session/SessionManager.js';
import { closeBackupClient, prewarmBackupClient } from './session/backup/SessionBackup.js';
import { WhatsAppManager } from './whatsapp/WhatsAppManager.js';
import { SecurityManager } from './security/SecurityManager.js';
import { SendController } from './whatsapp/SendController.js';
import { MessageScheduler } from './messages/scheduler.js';
import { createServer } from './api/server.js';
import { getSSEManager } from './api/sse.js';
import { Watchdog } from './watchdog/Watchdog.js';
import { warmupThumbnailWorker, stopThumbnailWorker } from './documents/thumbnail.js';
import type { FastifyInstance } from 'fastify';

export class Application {
  private stateMachine: StateMachine<WhatsAppStateValue> | null = null;
  private sessionManager: SessionManager | null = null;
  private whatsappManager: WhatsAppManager | null = null;
  private sendController: SendController | null = null;
  private messageScheduler: MessageScheduler | null = null;
  private watchdog: Watchdog | null = null;
  private server: FastifyInstance | null = null;
  private isShuttingDown = false;

  async start(): Promise<void> {
    const cfg = getConfig();
    const log = getLogger();

    // The PID matters: a deploy platform may run old + new instances
    // concurrently, and two instances on one WhatsApp session are rejected
    // with connectionReplaced (440) / badSession (500).
    log.info(
      {
        port: cfg.port,
        host: cfg.host,
        env: cfg.nodeEnv,
        pid: process.pid,
        nodeVersion: process.version,
        authDir: cfg.whatsappAuthDir,
      },
      'Starting application',
    );

    let sessionManagerRef: SessionManager | null = null;
    this.stateMachine = new StateMachine<WhatsAppStateValue>({
      name: 'whatsapp',
      initialState: WhatsAppState.STARTING,
      isValidTransition: isValidWhatsAppTransition,
      onTransition: (from, to) => {
        // Carry the session dimension alongside the runtime states.
        getEventBus().emitEvent(EventType.WHATSAPP_STATE_CHANGED, {
          state: to,
          prevState: from,
          ...(sessionManagerRef ? { session: sessionManagerRef.session } : {}),
        });
      },
    });

    this.sessionManager = new SessionManager(this.stateMachine);
    sessionManagerRef = this.sessionManager;
    this.whatsappManager = new WhatsAppManager(this.stateMachine, this.sessionManager);

    const securityManager = new SecurityManager(this.stateMachine, this.sessionManager);
    securityManager.registerWhatsAppManager(this.whatsappManager);

    this.sendController = new SendController();
    this.sendController.registerWhatsAppManager(this.whatsappManager);
    this.sendController.registerSecurityManager(securityManager);

    // The durable message scheduler (due-job scan/claim/execute/recover).
    // Started after the HTTP server is listening; fails closed (inactive)
    // when the system client is unconfigured.
    this.messageScheduler = new MessageScheduler(this.sendController);

    // The SSE route feeds the client-presence tracker (authenticated
    // streams = present clients → automatic wake + runtime demand).
    this.server = await createServer({
      whatsappManager: this.whatsappManager,
      securityManager,
      sessionManager: this.sessionManager,
      sendController: this.sendController,
      stateMachine: this.stateMachine,
      clientPresence: this.whatsappManager.clientPresence,
      messageScheduler: this.messageScheduler,
    });

    await this.server.listen({ port: cfg.port, host: cfg.host });
    log.info(`Server listening on ${cfg.host}:${cfg.port}`);

    getEventBus().emitEvent(EventType.SERVER_STATE_CHANGED, {
      state: 'running',
      prevState: 'starting',
    });

    this.watchdog = new Watchdog(securityManager);
    this.watchdog.start();

    // Durable messages: the scheduler scans PostgreSQL for due jobs. Jobs
    // created before a restart simply wait for their run_at — nothing is
    // lost, nothing is blindly reset (expired claims recover via lease).
    this.messageScheduler.start();

    // Fire-and-forget warmups (never fatal): the Redis backup client and
    // the persistent canvas worker, so the first restore-check/document send
    // does not pay the cold-start cost.
    void prewarmBackupClient();
    void warmupThumbnailWorker().catch(() => { /* never fatal */ });

    // Boot: STARTING → IDLE, session dimension resynced from disk. The
    // runtime is demand-driven — it wakes when the first authenticated client
    // appears (or an operation needs it) and sleeps after the last client
    // leaves. A persisted session lands as IDLE + PRESENT (reusable without
    // QR); the server is fully operational while IDLE.
    await this.sessionManager.resyncSessionDimension();
    this.stateMachine.transition(WhatsAppState.IDLE);

    process.on('SIGTERM', () => void this.shutdown('SIGTERM'));
    process.on('SIGINT', () => void this.shutdown('SIGINT'));

    process.on('uncaughtException', (err) => {
      log.error({ err: err.message, stack: err.stack }, 'Uncaught exception');
    });
    process.on('unhandledRejection', (reason) => {
      log.error({ reason: String(reason) }, 'Unhandled promise rejection');
    });

    log.info('Application started');
  }

  /**
   * Graceful shutdown. CRITICAL: normal shutdown MUST NOT wipe the WhatsApp
   * session — a restart must be able to restore it. Order: mark shutting
   * down + STOPPING → cancel active sends (bounded) → stop the thumbnail
   * worker → stop Baileys (session PRESERVED) → close SSE → stop watchdog →
   * close HTTP → close the Redis backup client → exit.
   */
  async shutdown(signal: string): Promise<void> {
    if (this.isShuttingDown) {
      getLogger().warn({ signal }, 'Shutdown already in progress');
      return;
    }

    this.isShuttingDown = true;
    const log = getLogger();
    const lifecycle = getLifecycle();

    log.info({ signal }, 'Graceful shutdown starting');

    lifecycle.markShuttingDown();

    // Stop scheduling new message work FIRST; an in-flight job finishes
    // within a bounded wait. Claims are never blindly reset — abandoned
    // claims recover via lease expiry on the next process start.
    if (this.messageScheduler) {
      try {
        await this.messageScheduler.stop();
      } catch (err) {
        log.error({ err: err instanceof Error ? err.message : String(err) }, 'Error stopping message scheduler');
      }
    }

    if (this.stateMachine) {
      const currentState = this.stateMachine.state;
      if (currentState !== WhatsAppState.STOPPING) {
        if (isValidWhatsAppTransition(currentState, WhatsAppState.STOPPING)) {
          this.stateMachine.transition(WhatsAppState.STOPPING);
        } else {
          this.stateMachine.forceTransition(WhatsAppState.STOPPING, 'shutdown');
        }
      }
      this.stateMachine.lock();
    }

    getEventBus().emitEvent(EventType.SERVER_STATE_CHANGED, {
      state: 'stopping',
      prevState: 'running',
    });

    if (this.sendController) {
      try {
        await Promise.race([
          this.sendController.cancelActive('shutdown'),
          new Promise((resolve) => setTimeout(resolve, 5000)),
        ]);
      } catch (err) {
        log.error({ err: err instanceof Error ? err.message : String(err) }, 'Error cancelling active sends');
      }
    }

    // In-flight thumbnails resolve as null — in-flight sends proceed
    // PDF-only; the cosmetic preview must never block a shutdown.
    try {
      stopThumbnailWorker('app shutdown');
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err) }, 'Error stopping thumbnail worker');
    }

    if (this.whatsappManager) {
      try {
        await this.whatsappManager.stop();
      } catch (err) {
        log.error({ err: err instanceof Error ? err.message : String(err) }, 'Error stopping WhatsAppManager');
      }
    }

    try {
      getSSEManager().closeAll();
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err) }, 'Error closing SSE connections');
    }

    if (this.watchdog) {
      this.watchdog.stop();
    }

    if (this.server) {
      try {
        await this.server.close();
      } catch (err) {
        log.error({ err: err instanceof Error ? err.message : String(err) }, 'Error closing HTTP server');
      }
    }

    // whatsappManager.stop() has already flushed any pending backup save.
    try {
      await closeBackupClient();
    } catch {
      // best-effort
    }

    log.info('Graceful shutdown complete');

    process.exit(0);
  }
}
