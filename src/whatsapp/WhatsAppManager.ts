/**
 * WhatsApp Manager — the ONE Baileys runtime owner.
 *
 * Owns the single Baileys socket and its complete lifecycle: single-flight
 * startup shared by every caller (login / automatic wake / sendInvoice),
 * backend-owned QR generation + countdown, pairing retry and cancellation,
 * candidate resolution (local session first, then the encrypted Redis
 * backup), transient reconnects with bounded backoff, and demand-driven
 * runtime retention (clients present / active operations; a 5-minute grace
 * after the last client leaves). Logout and security destruction are
 * delegated to SessionManager.
 *
 * RUNTIME states (IDLE/PAIRING/CONNECTING/CONNECTED/RECONNECTING/…) are a
 * separate axis from the SESSION dimension (NONE/PRESENT/RESTORING) owned
 * by SessionManager. "IDLE + PRESENT" = runtime asleep, valid session
 * material preserved, waking on demand without QR.
 *
 * CRITICAL INVARIANT: there must never be multiple active Baileys sockets
 * for the same session. This class is the ONLY module that creates a socket.
 * Intentional stops remove the socket's event listeners BEFORE ending it so
 * the close event can never reach the reconnect classifier.
 */
import {
  makeWASocket,
  type WASocket,
  type AuthenticationState,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import { getConfig } from '../config/index.js';
import { getLogger } from '../logging/logger.js';
import { getEventBus } from '../events/emitter.js';
import { EventType } from '../events/registry.js';
import { getLifecycle } from '../session/lifecycle.js';
import type { SessionManager, WhatsAppLifecycleHooks } from '../session/SessionManager.js';
import {
  restoreBackup,
  backupExists,
  invalidateBackup,
  SessionBackupScheduler,
  BackupInvalidError,
} from '../session/backup/SessionBackup.js';
import { ClientPresence } from './ClientPresence.js';
import { WhatsAppState, type WhatsAppStateValue } from '../state/whatsapp-states.js';
import { isValidWhatsAppTransition } from '../state/transitions.js';
import { StateMachine } from '../state/state-machine.js';
import { AppError, ErrorCode } from '../errors/registry.js';

/** Bounded backoff ladder: 1s, 2s, 4s, 8s, 16s, 30s, 60s. */
const BACKOFF_DELAYS_MS: readonly number[] = [1000, 2000, 4000, 8000, 16000, 30000, 60000];

function calculateBackoff(
  attempt: number,
  baseMs: number,
  maxMs: number,
): number {
  const idx = Math.min(attempt, BACKOFF_DELAYS_MS.length - 1);
  const delay = BACKOFF_DELAYS_MS[idx];
  const capped = Math.min(delay, maxMs);
  // Jitter: +0 to +25% of the delay (always non-negative to avoid 0ms)
  const jitter = Math.floor(capped * 0.25 * Math.random());
  return Math.max(baseMs, capped + jitter);
}

/** Security/auth failure codes — session destruction (fail-closed), never
 *  reconnection. Only meaningful from authenticated states: during PAIRING
 *  there is no authenticated session, so even these codes are just pairing
 *  retries (see the close handler). */
const SECURITY_FAILURE_CODES: ReadonlySet<number> = new Set([
  DisconnectReason.loggedOut, // 401
  DisconnectReason.badSession, // 500
  DisconnectReason.connectionReplaced, // 440
  DisconnectReason.multideviceMismatch, // 411
  DisconnectReason.forbidden, // 403
]);

/** Transient failure codes — reconnect with bounded backoff. */
const TRANSIENT_FAILURE_CODES: ReadonlySet<number> = new Set([
  DisconnectReason.connectionClosed, // 428
  DisconnectReason.connectionLost, // 408
  DisconnectReason.timedOut, // 408
  DisconnectReason.restartRequired, // 515
  DisconnectReason.unavailableService, // 503
]);

/** Authenticated lifecycle states. Security invalidation must ONLY happen
 *  from these; PAIRING is excluded (no authenticated session exists yet). */
const AUTHENTICATED_STATES: ReadonlySet<string> = new Set([
  'CONNECTING',
  'CONNECTED',
  'RECONNECTING',
  'LOGGING_OUT',
]);

function isAuthenticatedState(state: string): boolean {
  return AUTHENTICATED_STATES.has(state);
}

function isSecurityFailure(statusCode: number | undefined): boolean {
  if (statusCode === undefined) return false;
  return SECURITY_FAILURE_CODES.has(statusCode);
}

function isTransientFailure(statusCode: number | undefined): boolean {
  if (statusCode === undefined) return true; // unknown → safe default: transient
  return TRANSIENT_FAILURE_CODES.has(statusCode);
}

/** QR lifetime in seconds — MUST match the `qrTimeout: 60_000` socket option:
 *  Baileys emits a fresh `qr` event every 60s, and each emission resets the
 *  countdown. No artificial login deadline exists: pairing stays active until
 *  it succeeds, fails, stops, or is ended by the retention policy. */
const QR_REFRESH_INTERVAL_SECONDS = 60;

/** Baileys wraps disconnect errors in Boom: the status code lives at
 *  error.output.statusCode (with a flat statusCode fallback). */
function getDisconnectStatusCode(
  lastDisconnect: { error: Error | undefined; date: Date } | undefined,
): number | undefined {
  if (!lastDisconnect?.error) return undefined;
  const error = lastDisconnect.error as Error & {
    output?: { statusCode?: number };
    statusCode?: number;
  };
  return error?.output?.statusCode ?? error?.statusCode;
}

/** Status code → enum name, for readable disconnect logs. */
const DISCONNECT_REASON_NAMES: Readonly<Record<number, string>> = Object.freeze({
  401: 'loggedOut',
  403: 'forbidden',
  408: 'timedOut',
  411: 'multideviceMismatch',
  428: 'connectionClosed',
  440: 'connectionReplaced',
  500: 'badSession',
  503: 'unavailableService',
  515: 'restartRequired',
});

/** Full diagnostic details of a disconnect event (logging only — never
 *  changes classification). */
function describeDisconnect(
  lastDisconnect: { error: Error | undefined; date: Date } | undefined,
): Record<string, unknown> {
  if (!lastDisconnect) {
    return { hasLastDisconnect: false };
  }

  const error = lastDisconnect.error as Error & {
    output?: { statusCode?: number; payload?: unknown; error?: string };
    statusCode?: number;
    data?: unknown;
  } | undefined;

  if (!error) {
    return {
      hasLastDisconnect: true,
      hasError: false,
      disconnectDate: lastDisconnect.date?.toISOString(),
    };
  }

  const statusCode = error?.output?.statusCode ?? error?.statusCode;
  const reasonName = statusCode !== undefined
    ? (DISCONNECT_REASON_NAMES[statusCode] ?? 'unknown')
    : 'none';

  return {
    statusCode,
    reasonName,
    errorMessage: error.message ?? '[no message]',
    errorName: error.constructor?.name ?? typeof error,
    hasOutput: !!error?.output,
    boomPayload: error?.output?.payload ?? undefined,
    boomErrorType: error?.output?.error ?? undefined,
    disconnectDate: lastDisconnect.date?.toISOString(),
  };
}

/** Indian individual chat JID: 91 + 10 digits (starting 6-9) @s.whatsapp.net. */
function isValidJid(jid: string): boolean {
  if (!jid || typeof jid !== 'string') return false;
  return /^91[6-9]\d{9}@s\.whatsapp\.net$/.test(jid);
}

/** Normalize an Indian phone number ("9123456789", "919123456789",
 *  "+91 91234 56789", …) to a WhatsApp JID, or null when invalid. */
export function normalizeIndianPhoneToJid(input: string): string | null {
  if (!input || typeof input !== 'string') return null;

  const digits = input.replace(/\D/g, '');

  if (/^[6-9]\d{9}$/.test(digits)) {
    return `91${digits}@s.whatsapp.net`;
  }

  if (/^91[6-9]\d{9}$/.test(digits)) {
    return `${digits}@s.whatsapp.net`;
  }

  return null;
}

/** The document message preview produced by the invoice pipeline and passed
 *  through UNCHANGED: jpeg → proto jpegThumbnail, width/height → the
 *  thumbnailWidth/thumbnailHeight layout hints. The dimensions are the
 *  GENERATOR's own render geometry, never re-derived downstream. */
export interface DocumentThumbnail {
  jpeg: Buffer;
  width: number;
  height: number;
}

/** Socket factory (injectable for tests). */
export type SocketFactory = (config: Record<string, unknown>) => WASocket;

const defaultSocketFactory: SocketFactory = (config) => {
  return makeWASocket(config as Parameters<typeof makeWASocket>[0]);
};

/** 'login' — explicit user action; MAY start QR pairing when no session
 *  material exists. 'wake' — an operation needs the runtime; NEVER pairs. */
export type StartIntent = 'login' | 'wake';

/** Outcome of a single-flight startup operation (never rejects). */
export interface StartOutcome {
  ok: boolean;
  /** Runtime state when the startup settled. */
  state: WhatsAppStateValue;
  /** Error code when ok === false. */
  errorCode?: string;
}

export class WhatsAppManager implements WhatsAppLifecycleHooks {
  private socket: WASocket | null = null;
  private authState: { state: AuthenticationState; saveCreds: () => Promise<void> } | null = null;
  private readonly stateMachine: StateMachine<WhatsAppStateValue>;
  private readonly sessionManager: SessionManager;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pairingRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private currentQr: string | null = null;
  /** Expiry of the current QR generation (null when no QR is held). Exposed
   *  through /api/status so a freshly mounting panel renders the countdown
   *  immediately instead of waiting for the next per-second SSE tick. */
  private currentQrExpiresAt: Date | null = null;
  private connectedJid: string | null = null;
  private socketVersion: [number, number, number] = [2, 3000, 1017518824];
  private versionFetched = false;
  private isCreatingSocket = false;
  private readonly socketFactory: SocketFactory;

  // QR countdown state
  private qrGenerationId = 0;
  private qrCountdownTimer: ReturnType<typeof setInterval> | null = null;

  // ── Runtime lifecycle (demand model + single-flight startup) ────────
  /** Authenticated frontend client presence (drives runtime demand and the
   *  automatic wake); wired to the authenticated SSE route. */
  private readonly _clientPresence: ClientPresence;
  /** Armed only when the last client is gone AND no other demand exists. */
  private shutdownGraceTimer: ReturnType<typeof setTimeout> | null = null;
  /** The single in-flight startup operation (login or wake). */
  private activeStart: Promise<StartOutcome> | null = null;
  /** How many send operations are currently executing (runtime demand). */
  private activeSendOperations = 0;
  /** Whether the current process ever validated a WhatsApp session. */
  private sessionValidated = false;
  /** Which session candidate the current connection attempt is using
   *  ('local' | 'redis'; null = none in flight). */
  private connectCandidate: 'local' | 'redis' | null = null;
  /** The intent of the most recent startup. Outlives the operation itself:
   *  candidate rejections arrive via socket events while the runtime is
   *  CONNECTING, after runStart has returned. */
  private lastStartIntent: StartIntent = 'wake';
  /** Guards the candidate-rejection handler against re-entrance (multiple
   *  rejection events from one dying socket must resolve ONE candidate). */
  private resolvingCandidate = false;
  /** Debounced Redis backup writer (only active for a validated session). */
  private readonly backupScheduler: SessionBackupScheduler;
  /** Waiters for runtime states (wake/join coordination). */
  private readonly stateWaiters = new Set<{
    predicate: (state: WhatsAppStateValue) => boolean;
    resolve: (state: WhatsAppStateValue) => void;
  }>();

  constructor(
    stateMachine: StateMachine<WhatsAppStateValue>,
    sessionManager: SessionManager,
    socketFactory?: SocketFactory,
  ) {
    this.stateMachine = stateMachine;
    this.sessionManager = sessionManager;
    this.socketFactory = socketFactory ?? defaultSocketFactory;

    this.backupScheduler = new SessionBackupScheduler(sessionManager.authDirectory);

    // A client appearing is a WAKE signal (never pairing intent); the LAST
    // client disappearing may start the shutdown grace when no demand remains.
    this._clientPresence = new ClientPresence({
      onFirstClient: () => this.handleClientAppeared(),
      onLastClient: () => this.evaluateRuntimeDemand(),
    });

    this.sessionManager.registerHooks({
      closeSocket: () => this.closeSocket(),
      invalidateAuthState: () => this.invalidateAuthState(),
      clearQr: () => this.clearQr(),
      hasActiveSocket: () => this.hasActiveSocket(),
    });

    // Wake/join coordination subscribes directly to the state machine —
    // independent of app-level event-bus wiring. The manager lives for the
    // process lifetime, so the subscription is never detached.
    stateMachine.subscribe((_from, to) => {
      for (const waiter of [...this.stateWaiters]) {
        if (waiter.predicate(to)) {
          this.stateWaiters.delete(waiter);
          waiter.resolve(to);
        }
      }
      // Demand changes with runtime state (e.g. a reconnect flow starting or
      // ending) — keep the grace timer consistent with the new state.
      this.evaluateRuntimeDemand();
    });
  }

  get clientPresence(): ClientPresence {
    return this._clientPresence;
  }

  /** Fetch the latest Baileys version once (with fallback); lazy — Baileys
   *  stays idle until a login/wake is requested. */
  private async fetchVersion(): Promise<void> {
    if (this.versionFetched) return;

    const log = getLogger();
    try {
      const versionResult = await fetchLatestBaileysVersion();
      if (versionResult.version) {
        this.socketVersion = versionResult.version as [number, number, number];
      }
    } catch {
      log.warn('Failed to fetch latest Baileys version; using fallback');
    }
    this.versionFetched = true;
  }

  // ══════════════════════════════════════════════════════════════════════
  // THE ONE STARTUP / WAKE PATH
  // ══════════════════════════════════════════════════════════════════════

  /**
   * The explicit user-initiated login (POST /api/whatsapp/login) — the ONLY
   * entry point that may start QR pairing. Candidate resolution runs first:
   * a reusable session (local or Redis-restored) connects WITHOUT a QR;
   * pairing only begins when no reusable session exists anywhere.
   */
  async startLogin(): Promise<void> {
    let outcome = await this.beginStart('login');

    // A login that joined an in-flight WAKE may inherit the wake's "no
    // reusable session" outcome — but a wake NEVER pairs, while this
    // explicit request MAY. The wake has fully settled by now, so one retry
    // runs this login as its OWN startup.
    if (!outcome.ok && outcome.errorCode === ErrorCode.WHATSAPP_NOT_CONNECTED) {
      outcome = await this.beginStart('login');
    }

    if (!outcome.ok) {
      // Route semantics: a failed explicit login is an error, not a no-op.
      throw new AppError(ErrorCode.SERVER_NOT_READY, {
        message: `Cannot start login from state: ${outcome.state}`,
        internalDetails: { errorCode: outcome.errorCode },
      });
    }
  }

  /**
   * Cancel an ACTIVE pairing attempt — the pairing dialog's Close/Cancel.
   * "I no longer want to pair": NOT logout; a validated session is never
   * destroyed. Race safety is decided by the SETTLED state: PAIRING →
   * cancel wins (IDLE + NONE); CONNECTING → defer to the lifecycle (the
   * scan already progressed; never destroy); CONNECTED → no-op (the scan
   * won; never log out); anything else → idempotent no-op. The state check
   * and the stop run synchronously, so no socket event can interleave.
   */
  async cancelPairing(): Promise<void> {
    const log = getLogger();

    // Join an in-flight startup so the cancel decision runs against the
    // state it settled into.
    if (this.activeStart) {
      await this.activeStart.catch(() => undefined);
    }

    const state = this.stateMachine.state;

    if (state === WhatsAppState.CONNECTED) {
      log.info('Pairing cancel ignored — already CONNECTED (the scan won the race)');
      return;
    }

    if (state === WhatsAppState.CONNECTING) {
      // The lifecycle owns the outcome: open → CONNECTED; a failing connect
      // → the normal classification/candidate resolution.
      log.info('Pairing cancel deferred — connection already progressing (scan in flight)');
      return;
    }

    if (state !== WhatsAppState.PAIRING) {
      log.info({ state }, 'Pairing cancel is a no-op — no active pairing');
      return;
    }

    // PAIRING → cancel wins. Clear the intent FIRST so no lingering 'login'
    // intent can restart pairing through a later path.
    this.lastStartIntent = 'wake';

    log.info('Pairing cancelled by the user — stopping the pairing runtime');

    // Intentional stop (timers + listeners-first socket close → IDLE);
    // session material is NOT touched by the stop itself.
    this.stopRuntimeIntentionally('pairing cancelled by user');

    // Unvalidated pairing residue (creds.json written before any scan) is
    // not a session — discard it so no fake wake-able session is advertised.
    if (!this.sessionValidated) {
      await this.sessionManager.discardUnvalidatedPairingResidue();
    }
  }

  /**
   * Wake-on-demand for operations: already connected → return; otherwise
   * wake via the single-flight startup (joining any in-flight one). NEVER
   * pairs and NEVER creates a second socket.
   * @throws AppError(WHATSAPP_NOT_CONNECTED) when no session exists or the
   *         wake does not reach CONNECTED within the bounded wake timeout.
   */
  async ensureReadyForSend(): Promise<void> {
    const log = getLogger();

    if (this.stateMachine.state === WhatsAppState.CONNECTED && this.socket) {
      return;
    }

    const state = this.stateMachine.state;
    if (state === WhatsAppState.PAIRING) {
      throw new AppError(ErrorCode.WHATSAPP_NOT_CONNECTED);
    }

    if (getLifecycle().sendsBlocked || getLifecycle().shuttingDown) {
      // assertSendAllowed (next in the send pipeline) produces the canonical
      // error for these conditions — no wake is attempted.
      return;
    }

    log.info({ state }, 'Wake requested for WhatsApp operation');
    const outcome = await this.beginStart('wake');

    if (!outcome.ok || this.stateMachine.state !== WhatsAppState.CONNECTED) {
      throw new AppError(ErrorCode.WHATSAPP_NOT_CONNECTED, {
        internalDetails: { wakeOutcome: outcome.state, errorCode: outcome.errorCode },
      });
    }
  }

  /**
   * THE single-flight startup shared by every caller: at most ONE startup
   * (and one socket) exists at any time; concurrent callers share it. The
   * returned promise NEVER rejects. 'login' settles into PAIRING/CONNECTING
   * (the QR/connection flow proceeds via events); 'wake' additionally waits
   * for CONNECTED within the bounded wake timeout.
   */
  private async beginStart(intent: StartIntent): Promise<StartOutcome> {
    const log = getLogger();
    const currentState = this.stateMachine.state;

    // An active runtime is never restarted.
    if (
      currentState === WhatsAppState.PAIRING ||
      currentState === WhatsAppState.CONNECTING ||
      currentState === WhatsAppState.CONNECTED ||
      currentState === WhatsAppState.RECONNECTING
    ) {
      // A 'wake' caller waits (bounded) for the in-flight startup/reconnect
      // to reach CONNECTED; a 'login' caller joins idempotently.
      if (intent === 'login') {
        log.info(
          { state: currentState },
          'Login requested but runtime already active; skipping (idempotent)',
        );
        return { ok: true, state: currentState };
      }
      return this.waitForConnected();
    }

    if (
      currentState !== WhatsAppState.IDLE &&
      currentState !== WhatsAppState.STARTING &&
      currentState !== WhatsAppState.SECURITY_INVALIDATED
    ) {
      log.warn(
        { state: currentState, intent },
        'Start requested from a state that cannot start; rejecting',
      );
      return { ok: false, state: currentState, errorCode: ErrorCode.SERVER_NOT_READY };
    }

    // Join any in-flight startup — never start a second one. An explicit
    // LOGIN ESCALATES the in-flight operation (a presence wake may have
    // started it, but the user has now explicitly asked to connect; the
    // pairing decision points read the escalated intent). A WAKE never
    // downgrades a login.
    if (this.activeStart) {
      if (intent === 'login') {
        this.lastStartIntent = 'login';
      }
      log.info('Wake/start reused the existing in-flight startup operation');
      return this.activeStart.then((outcome) =>
        intent === 'wake' ? this.settleWakeOutcome(outcome) : outcome,
      );
    }

    // A NEW operation's intent is authoritative and outlives the operation
    // itself (candidate rejections arrive via socket events while the
    // runtime is CONNECTING, after runStart has returned).
    this.lastStartIntent = intent;
    const operation = this.runStart(intent);
    this.activeStart = operation;
    try {
      const outcome = await operation;
      return intent === 'wake' ? await this.settleWakeOutcome(outcome) : outcome;
    } finally {
      if (this.activeStart === operation) {
        this.activeStart = null;
        // A demand input changed — e.g. a login that settled into PAIRING
        // with no clients present must still arm the shutdown grace.
        this.evaluateRuntimeDemand();
      }
    }
  }

  /** Wait (bounded) for an already-active runtime to reach CONNECTED. */
  private async waitForConnected(): Promise<StartOutcome> {
    const cfg = getConfig();
    const state = await this.waitForState(
      (s) => s === WhatsAppState.CONNECTED ||
             s === WhatsAppState.IDLE ||
             s === WhatsAppState.PAIRING ||
             s === WhatsAppState.SECURITY_INVALIDATED,
      cfg.whatsappWakeTimeoutMs,
    );
    if (state === WhatsAppState.CONNECTED) {
      return { ok: true, state };
    }
    return { ok: false, state, errorCode: ErrorCode.WHATSAPP_NOT_CONNECTED };
  }

  /** After a startup settles, a 'wake' caller needs CONNECTED (bounded). */
  private async settleWakeOutcome(outcome: StartOutcome): Promise<StartOutcome> {
    if (!outcome.ok) return outcome;
    return this.waitForConnected();
  }

  /**
   * The body of the single startup operation (runs while activeStart is
   * set); NEVER rejects — failures are expressed in the StartOutcome.
   *
   * Generation protection: the session generation captured at entry is
   * re-checked after every await that could overlap a destructive operation
   * (restore, socket creation); a changed generation aborts the startup
   * WITHOUT touching the state machine — the destructive operation already
   * settled it and this startup must not resurrect anything.
   */
  private async runStart(intent: StartIntent): Promise<StartOutcome> {
    const log = getLogger();
    const lifecycle = getLifecycle();
    let generationAtStart = lifecycle.sessionGeneration;
    // Pairing decisions read the LIVE intent (a login may have escalated
    // this operation while in flight — see beginStart).
    const pairingAllowed = (): boolean => this.lastStartIntent === 'login';

    if (lifecycle.shuttingDown) {
      log.info('Server is shutting down; skipping startup');
      return { ok: false, state: this.stateMachine.state, errorCode: ErrorCode.SERVER_NOT_READY };
    }

    // SECURITY_INVALIDATED means destruction already completed.
    if (this.stateMachine.state === WhatsAppState.SECURITY_INVALIDATED) {
      this.stateMachine.forceTransition(WhatsAppState.IDLE, 'start after security invalidation');
    }

    try {
      await this.fetchVersion();

      const corrupted = await this.sessionManager.isSessionCorrupted();
      if (corrupted) {
        // Corrupted local material is a security condition — destroy it
        // (locally AND in the backup); the start re-evaluates from a clean slate.
        log.warn('Corrupted session detected during start; destroying for security');
        await this.sessionManager.destroySession('corrupted session', 'security');
        // This destruction was OURS — re-baseline so only a FURTHER external
        // destruction aborts us.
        generationAtStart = lifecycle.sessionGeneration;
        if (this.stateMachine.state !== WhatsAppState.IDLE) {
          this.stateMachine.forceTransition(WhatsAppState.IDLE, 'corrupted session destroyed');
        }
      }

      let exists = await this.sessionManager.sessionExists();

      // Redis recovery: ONLY when local material is missing — a healthy
      // local session never touches Redis.
      if (!exists && this.sessionManager.session !== 'PRESENT') {
        const restored = await this.attemptBackupRestore();
        if (generationAtStart !== lifecycle.sessionGeneration) {
          // A destructive operation completed while the restore was in
          // flight — discard our result; do not resurrect.
          log.warn('Session generation changed during restore; aborting startup');
          await this.sessionManager.discardUnvalidatedPairingResidue();
          this.sessionManager.markSessionNone();
          return { ok: false, state: this.stateMachine.state, errorCode: ErrorCode.SERVER_NOT_READY };
        }
        if (restored === 'restored') {
          exists = true;
        } else if (!pairingAllowed()) {
          // A wake NEVER pairs — not when no backup exists, not when the
          // backup is invalid, and not when Redis is merely unavailable.
          log.info(
            { restoreOutcome: restored },
            'Wake without usable session material — connection required',
          );
          this.sessionManager.markSessionNone();
          return { ok: false, state: this.stateMachine.state, errorCode: ErrorCode.WHATSAPP_NOT_CONNECTED };
        }
        // 'invalid' / 'unavailable' under LOGIN intent: no reusable session
        // can be confirmed anywhere — the explicit user request may pair.
      }

      if (exists) {
        // Candidate material exists (healthy local session or a Redis
        // restoration) → connect directly, no QR.
        this.connectCandidate = this.sessionManager.session === 'RESTORING' ? 'redis' : 'local';
        if (this.sessionManager.session === 'NONE') {
          this.sessionManager.markSessionPresent();
        }
        this.stateMachine.transition(WhatsAppState.CONNECTING);
      } else {
        if (!pairingAllowed()) {
          return { ok: false, state: this.stateMachine.state, errorCode: ErrorCode.WHATSAPP_NOT_CONNECTED };
        }
        // No session material anywhere → pairing (QR will be emitted).
        this.connectCandidate = null;
        this.stateMachine.transition(WhatsAppState.PAIRING);
      }

      await this.createSocket();

      if (generationAtStart !== lifecycle.sessionGeneration) {
        // Destructive operation completed while the socket was being created
        // — close what we just created, discard the residue.
        log.warn('Session generation changed during socket creation; aborting startup');
        await this.closeSocket();
        await this.sessionManager.discardUnvalidatedPairingResidue();
        this.sessionManager.markSessionNone();
        return { ok: false, state: this.stateMachine.state, errorCode: ErrorCode.SERVER_NOT_READY };
      }

      log.info(
        { state: this.stateMachine.state, intent, candidate: this.connectCandidate },
        intent === 'login'
          ? 'Login attempt started — Baileys rotates the QR every 60s while pairing'
          : 'Wake started — restoring the existing session without QR',
      );
      return { ok: true, state: this.stateMachine.state };
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err.message : String(err), intent },
        'Startup failed',
      );
      // A failed startup settles into IDLE — session material is preserved
      // and a later attempt may retry.
      this.stopRuntimeIntentionally('startup failed');
      return { ok: false, state: this.stateMachine.state, errorCode: ErrorCode.SERVER_INTERNAL_ERROR };
    }
  }

  /**
   * Try to restore the session from the Redis backup. The outcome
   * distinction is MANDATORY: 'restored' — material written locally,
   * validation happens over the real connection; 'invalid' — DEFINITIVELY
   * unusable (undecryptable/corrupt/format), already invalidated so the
   * system converges to no-session; 'unavailable' — Redis unreachable, the
   * backup is PRESERVED untouched (a transient failure must never destroy
   * potentially valid material).
   */
  private async attemptBackupRestore(): Promise<'restored' | 'invalid' | 'unavailable'> {
    const log = getLogger();
    if (!(await backupExists())) {
      return 'unavailable';
    }
    this.sessionManager.markSessionRestoring();
    try {
      await restoreBackup(this.sessionManager.authDirectory);
      log.info('Session material restored from the Redis backup — validating via connection');
      return 'restored';
    } catch (err) {
      if (err instanceof BackupInvalidError) {
        log.warn(
          { reason: err.message },
          'Redis backup is definitively invalid — invalidating it',
        );
        try {
          await invalidateBackup();
        } catch (invalidateErr) {
          log.error(
            { err: invalidateErr instanceof Error ? invalidateErr.message : String(invalidateErr) },
            'Failed to invalidate the invalid Redis backup',
          );
        }
        this.sessionManager.markSessionNone();
        return 'invalid';
      }
      // Redis unreachable / command timeout: TRANSIENT — the backup stays
      // untouched and may be valid once Redis is back.
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'Redis backup restore unavailable (transient) — backup preserved',
      );
      this.sessionManager.markSessionNone();
      return 'unavailable';
    }
  }

  /** Wait (bounded) for a runtime state matching the predicate — uses the
   *  state machine's own subscription (no polling). */
  private waitForState(
    predicate: (state: WhatsAppStateValue) => boolean,
    timeoutMs: number,
  ): Promise<WhatsAppStateValue> {
    const current = this.stateMachine.state;
    if (predicate(current)) {
      return Promise.resolve(current);
    }
    return new Promise<WhatsAppStateValue>((resolve) => {
      const waiter = {
        predicate,
        resolve: (state: WhatsAppStateValue) => {
          if (timer !== null) clearTimeout(timer);
          resolve(state);
        },
      };
      const timer = setTimeout(() => {
        this.stateWaiters.delete(waiter);
        resolve(this.stateMachine.state);
      }, timeoutMs);
      this.stateWaiters.add(waiter);
    });
  }

  // ══════════════════════════════════════════════════════════════════════
  // RUNTIME DEMAND — the retention model that replaced the idle timer
  // ══════════════════════════════════════════════════════════════════════

  /**
   * Demand exists while: any authenticated client is present, a startup is
   * in flight, a send is executing, or a reconnect flow is active (state or
   * armed timer). PAIRING alone is deliberately NOT demand: an abandoned
   * pairing (last client gone, no other demand) is ended by the
   * client-disconnect grace — the "never PAIRING forever" guarantee — while
   * any present client keeps it alive.
   */
  private hasRuntimeDemand(): boolean {
    if (this._clientPresence.clientCount > 0) return true;
    if (this.activeStart !== null) return true;
    if (this.activeSendOperations > 0) return true;
    if (this.stateMachine.state === WhatsAppState.RECONNECTING) return true;
    if (this.reconnectTimer !== null) return true;
    return false;
  }

  /** Re-evaluate retention on every demand-input change: arm the
   *  client-disconnect grace when an active runtime has no remaining
   *  demand; cancel it whenever demand exists again. */
  private evaluateRuntimeDemand(): void {
    const state = this.stateMachine.state;
    const runtimeActive =
      state === WhatsAppState.PAIRING ||
      state === WhatsAppState.CONNECTING ||
      state === WhatsAppState.CONNECTED ||
      state === WhatsAppState.RECONNECTING;

    if (!runtimeActive) {
      this.cancelShutdownGrace(); // nothing to stop
      return;
    }
    if (this.hasRuntimeDemand()) {
      this.cancelShutdownGrace();
    } else {
      this.startShutdownGrace();
    }
  }

  /** Arm the shutdown grace (idempotent). */
  private startShutdownGrace(): void {
    if (this.shutdownGraceTimer !== null) return;
    const cfg = getConfig();
    getLogger().info(
      { graceMs: cfg.whatsappClientDisconnectGraceMs, state: this.stateMachine.state },
      'Last client gone and no runtime demand — shutdown grace started',
    );
    this.shutdownGraceTimer = setTimeout(() => {
      this.shutdownGraceTimer = null;
      void this.handleGraceExpired();
    }, cfg.whatsappClientDisconnectGraceMs);
  }

  /** Cancel the shutdown grace (demand reappeared / runtime stopped). */
  private cancelShutdownGrace(): void {
    if (this.shutdownGraceTimer !== null) {
      clearTimeout(this.shutdownGraceTimer);
      this.shutdownGraceTimer = null;
      getLogger().info('Runtime demand reappeared — shutdown grace cancelled');
    }
  }

  /**
   * The grace expired and no demand remains: stop the runtime
   * intentionally — release ALL runtime resources, PRESERVE the session
   * material of a validated session, discard an abandoned pairing's
   * unvalidated residue, end in IDLE (never reconnect).
   */
  private async handleGraceExpired(): Promise<void> {
    const log = getLogger();
    const state = this.stateMachine.state;

    if (getLifecycle().shuttingDown) {
      return; // shutdown owns the lifecycle
    }
    if (this.hasRuntimeDemand()) {
      // Demand reappeared between the timer firing and this handler running.
      this.evaluateRuntimeDemand();
      return;
    }

    log.info({ state }, 'Client-disconnect grace expired — intentional shutdown, session preserved');

    const wasPairing = state === WhatsAppState.PAIRING;
    this.stopRuntimeIntentionally('client disconnect grace expired');

    if (wasPairing && !this.sessionValidated) {
      // Abandoned pairing: Baileys already wrote unregistered creds.json —
      // discard it so no fake wake-able session is advertised.
      await this.sessionManager.discardUnvalidatedPairingResidue();
    }
  }

  /**
   * The FIRST authenticated frontend client became present — a WAKE signal,
   * never pairing intent. An existing session connects without QR; a
   * missing local session may be recovered from Redis; a system with no
   * reusable session anywhere settles back to IDLE + NONE (the user decides
   * when to pair).
   */
  private handleClientAppeared(): void {
    const log = getLogger();

    this.cancelShutdownGrace();

    if (getLifecycle().shuttingDown || getLifecycle().sendsBlocked) {
      // Shutdown or a destructive transitional state owns the lifecycle.
      return;
    }

    const state = this.stateMachine.state;
    if (
      state === WhatsAppState.PAIRING ||
      state === WhatsAppState.CONNECTING ||
      state === WhatsAppState.CONNECTED ||
      state === WhatsAppState.RECONNECTING
    ) {
      return;
    }

    log.info({ state }, 'First client present — automatic wake requested (never pairs)');
    void this.beginStart('wake').then((outcome) => {
      if (!outcome.ok) {
        // A wake that finds no reusable session settles quietly into
        // IDLE + NONE — not an error, never a pairing flow.
        log.info(
          { state: outcome.state, errorCode: outcome.errorCode },
          'Automatic wake found no reusable session — remaining idle',
        );
      }
    });
  }

  // ══════════════════════════════════════════════════════════════════════
  // CANDIDATE RESOLUTION (local → Redis → convergence)
  // ══════════════════════════════════════════════════════════════════════

  /**
   * The current candidate was DEFINITIVELY rejected by WhatsApp (a QR
   * emitted during CONNECTING, or a security-coded disconnect during the
   * pre-validation connect). LOCAL rejected + a Redis backup exists → try
   * the Redis candidate (it may be newer and valid — never destroy the
   * backup just because the local candidate failed). No further candidate →
   * ONE deterministic cleanup (destroySession) converging to session NONE +
   * runtime IDLE; pairing then begins ONLY for an explicit login intent.
   */
  private async handleCandidateRejected(reason: string): Promise<void> {
    const log = getLogger();
    if (this.resolvingCandidate) {
      return; // one resolution per candidate
    }
    this.resolvingCandidate = true;
    try {
      // Close the rejected socket FIRST (listeners removed before end) so
      // no further event from it can interfere with the resolution.
      await this.closeSocket();
      this.clearQr();

      const candidate = this.connectCandidate;
      log.warn(
        { candidate, reason, intent: this.lastStartIntent },
        'Session candidate rejected by WhatsApp — resolving next candidate',
      );

      if (candidate === 'local' && (await backupExists())) {
        await this.tryRedisCandidate(reason);
        return;
      }

      await this.allCandidatesExhausted(reason);
    } finally {
      this.resolvingCandidate = false;
    }
  }

  /**
   * Try the Redis candidate after the local material was rejected. The
   * material is only promoted to PRESENT when WhatsApp validates it over
   * the real connection (connection open).
   */
  private async tryRedisCandidate(reason: string): Promise<void> {
    const log = getLogger();
    log.info({ reason }, 'Trying the Redis backup candidate after local rejection');

    const outcome = await this.attemptBackupRestore();
    if (outcome !== 'restored') {
      // The backup vanished, is invalid (already invalidated), or Redis is
      // unreachable — no usable Redis candidate.
      await this.allCandidatesExhausted(reason);
      return;
    }

    this.connectCandidate = 'redis';
    const state = this.stateMachine.state;
    if (state !== WhatsAppState.CONNECTING) {
      if (isValidWhatsAppTransition(state, WhatsAppState.CONNECTING)) {
        this.stateMachine.transition(WhatsAppState.CONNECTING);
      } else {
        this.stateMachine.forceTransition(WhatsAppState.CONNECTING, 'redis candidate');
      }
    }
    await this.createSocket();
  }

  /**
   * Every candidate was definitively rejected (or none existed): ONE
   * deterministic cleanup via destroySession — generation invalidated,
   * pending saves cancelled, local material destroyed, Redis backup
   * invalidated, session NONE, runtime IDLE. Pairing begins ONLY for an
   * explicit login intent.
   */
  private async allCandidatesExhausted(reason: string): Promise<void> {
    const log = getLogger();
    log.warn({ reason, intent: this.lastStartIntent }, 'All session candidates exhausted — deterministic cleanup');

    if (this.lastStartIntent === 'login') {
      // The user explicitly asked to connect: clean the stale material
      // first (fail-closed destruction), then pair from a clean slate — the
      // ONLY path that may show a QR.
      await this.handleSecurityFailure(`Session stale (${reason}) — explicit pairing requested`);
      if (
        this.stateMachine.state === WhatsAppState.IDLE &&
        !getLifecycle().shuttingDown
      ) {
        this.connectCandidate = null;
        this.stateMachine.transition(WhatsAppState.PAIRING);
        await this.createSocket();
      }
      return;
    }

    // Wake intent (client presence / sendInvoice): NEVER pair. The wake
    // caller already received (or will receive) its not-connected outcome.
    await this.handleSecurityFailure(`Session stale (${reason})`);
  }

  /**
   * Intentional runtime stop (grace expiry / failed startup / cancel):
   * cancel every runtime timer, close the socket with listeners removed
   * FIRST (the close event can never reach the reconnect classifier),
   * transition to IDLE. NEVER destroys session material.
   */
  private stopRuntimeIntentionally(reason: string): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pairingRetryTimer) {
      clearTimeout(this.pairingRetryTimer);
      this.pairingRetryTimer = null;
    }
    this.reconnectAttempts = 0;
    this.cancelQrCountdown();
    this.cancelShutdownGrace();
    this.clearQr();

    void this.closeSocket();

    // A validated session going to sleep flushes any pending backup save so
    // the backup reflects the latest session state.
    if (this.sessionValidated) {
      void this.backupScheduler.flush(3_000);
    }

    const state: WhatsAppStateValue = this.stateMachine.state;
    if (state === WhatsAppState.IDLE || state === WhatsAppState.STOPPING) {
      return;
    }
    if (isValidWhatsAppTransition(state, WhatsAppState.IDLE)) {
      this.stateMachine.transition(WhatsAppState.IDLE);
    } else {
      this.stateMachine.forceTransition(WhatsAppState.IDLE, reason);
    }
    this.connectCandidate = null;
    this.connectedJid = null;
  }

  /**
   * Create a new Baileys socket. CRITICAL: there must never be multiple
   * active sockets — the old socket is closed (listeners removed) first.
   */
  async createSocket(): Promise<void> {
    const log = getLogger();
    const cfg = getConfig();

    if (this.isCreatingSocket) {
      log.warn('Socket creation already in progress; skipping');
      return;
    }

    if (lifecycleShuttingDown()) {
      log.info('Server is shutting down; skipping socket creation');
      return;
    }

    this.isCreatingSocket = true;

    try {
      // Remove ALL event listeners from the old socket BEFORE ending it:
      // the handler closure captures `this`, not the socket instance, so a
      // delayed event from an ended socket would still be processed by
      // onConnectionUpdate/onCredsUpdate after the new socket exists.
      if (this.socket) {
        try {
          this.socket.ev.removeAllListeners('connection.update');
          this.socket.ev.removeAllListeners('creds.update');
        } catch {
          // ignore — removeAllListeners is best-effort
        }
        try {
          this.socket.end(undefined);
        } catch {
          // ignore
        }
        this.socket = null;
        log.info('Previous Baileys socket closed and event listeners removed');
      }

      await this.sessionManager.ensureAuthDir();

      // The resolved auth-dir path matters on ephemeral filesystems (the
      // Redis backup layer exists to recover exactly that case) — log it so
      // it can be verified against the persistent disk mount.
      const authDirPath = this.sessionManager.authDirectory;
      const sessionExists = await this.sessionManager.sessionExists();
      log.info(
        {
          authDir: authDirPath,
          sessionExists,
          pid: process.pid,
        },
        'Auth state directory resolved',
      );

      const { state, saveCreds } = await useMultiFileAuthState(
        authDirPath,
      );
      this.authState = { state, saveCreds };

      const socket = this.socketFactory({
        auth: state,
        version: this.socketVersion,
        printQRInTerminal: false,
        connectTimeoutMs: 20_000,
        defaultQueryTimeoutMs: cfg.sendTimeoutMs,
        keepAliveIntervalMs: 30_000,
        // Each QR lives 60s; Baileys then emits a fresh `qr` event — the
        // ONLY QR refresh mechanism (no separate refresh timer exists).
        qrTimeout: 60_000,
        retryRequestDelayMs: cfg.sendRetryBaseMs,
        maxMsgRetryCount: cfg.sendMaxRetries,
        browser: ['WhatsApp Invoice Backend', 'Chrome', '1.0.0'],
        // Baileys' internal logger is silenced: our logger handles all
        // structured logging with redaction (Baileys would leak keys/QR).
        logger: pino({ level: 'silent' }),
        markOnlineOnConnect: false,
        emitOwnEvents: true,
        shouldSyncHistoryMessage: () => false,
      });

      this.socket = socket;

      socket.ev.on('connection.update', (update) => {
        void this.onConnectionUpdate(update);
      });
      socket.ev.on('creds.update', () => {
        void this.onCredsUpdate();
      });

      log.info('Baileys socket created');
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err.message : String(err) },
        'Failed to create Baileys socket',
      );
      throw err;
    } finally {
      this.isCreatingSocket = false;
    }
  }

  private async onConnectionUpdate(update: Partial<{
    connection: 'open' | 'connecting' | 'close';
    qr?: string;
    lastDisconnect?: { error: Error | undefined; date: Date };
    isNewLogin?: boolean;
  }>): Promise<void> {
    const log = getLogger();
    const { connection, qr, lastDisconnect } = update;

    if (qr) {
      try {
        const dataUrl = await QRCode.toDataURL(qr, { width: 256 });

        // The socket was closed while QR generation was in flight (e.g. an
        // intentional stop ran) — no live pairing session remains and the
        // countdown timer would be uncleanable.
        if (!this.socket) {
          log.info('QR generated after socket closed; skipping countdown start');
          return;
        }

        // A QR while CONNECTING means the candidate material is NOT
        // registered (stale local material or a restored backup WhatsApp
        // does not recognize): the candidate is definitively rejected —
        // try the next candidate (only when all are exhausted does pairing
        // begin, and only for an explicit login intent).
        if (this.stateMachine.state === WhatsAppState.CONNECTING) {
          log.info('QR emitted during a connect/restore attempt — candidate material is unregistered');
          this.sessionManager.markSessionNone();
          void this.handleCandidateRejected('QR emitted during connect (material unregistered)');
          return;
        }

        this.currentQr = dataUrl;

        // Each new QR from Baileys resets the countdown; the generation ID
        // prevents a stale timer from interfering with a newer QR.
        const generationId = ++this.qrGenerationId;
        const expiresAt = new Date(Date.now() + QR_REFRESH_INTERVAL_SECONDS * 1000);
        this.currentQrExpiresAt = expiresAt;

        getEventBus().emitEvent(EventType.WHATSAPP_QR_AVAILABLE, {
          qr: dataUrl,
          expiresInSeconds: QR_REFRESH_INTERVAL_SECONDS,
          expiresAt: expiresAt.toISOString(),
        });
        log.info('QR code available for pairing');

        // Backend-owned countdown — the client never calculates expiry itself.
        this.startQrCountdown(generationId, expiresAt);
      } catch (err) {
        log.error(
          { err: err instanceof Error ? err.message : String(err) },
          'Failed to generate QR data URL',
        );
      }
    }

    if (connection === 'open') {
      // Connection open — the candidate material is VALIDATED by WhatsApp.
      // This is the only promotion path to session PRESENT.
      this.reconnectAttempts = 0;
      this.currentQr = null;
      this.currentQrExpiresAt = null;
      this.connectCandidate = null;
      this.sessionValidated = true;
      this.sessionManager.markSessionPresent();
      // Checkpoint the validated material to Redis immediately (also how an
      // existing local session establishes its FIRST backup — no re-pairing
      // required after the backup layer is introduced).
      this.backupScheduler.schedule();
      // Stop the per-second countdown broadcast immediately: a just-scanned
      // session must not keep emitting QR_COUNTDOWN for the QR's remaining
      // lifetime while the state is already CONNECTED.
      this.cancelQrCountdown();

      const user = this.socket?.user;
      if (user?.id) {
        this.connectedJid = user.id;
      }

      const currentState = this.stateMachine.state;
      if (currentState === WhatsAppState.CONNECTING) {
        this.stateMachine.transition(WhatsAppState.CONNECTED);
      } else if (currentState === WhatsAppState.RECONNECTING) {
        this.stateMachine.transition(WhatsAppState.CONNECTED);
      } else if (currentState === WhatsAppState.PAIRING) {
        // PAIRING → CONNECTING → CONNECTED
        this.stateMachine.transition(WhatsAppState.CONNECTING);
        this.stateMachine.transition(WhatsAppState.CONNECTED);
      } else if (currentState === WhatsAppState.CONNECTED) {
        // Already connected, no-op
      }

      // A new authenticated session is active — clear the sendsBlocked flag
      // set during logout/security/shutdown.
      getLifecycle().unblockSends();

      await this.validateIdentity();

      log.info({ jid: this.connectedJid }, 'WhatsApp connected');

    } else if (connection === 'close') {
      const statusCode = getDisconnectStatusCode(lastDisconnect);
      const currentState = this.stateMachine.state;

      const disconnectDetails = describeDisconnect(lastDisconnect);
      log.warn(
        {
          ...disconnectDetails,
          currentState,
          socketActive: this.socket !== null,
        },
        'Baileys connection closed — disconnect diagnostics',
      );

      if (lifecycleShuttingDown()) {
        log.info('Connection closed during shutdown; not reconnecting');
        return;
      }

      // Security-failure classification is context-aware:
      // 1. CONNECTING (candidate in flight, pre-validation): a security-coded
      //    rejection rejects THE CANDIDATE — the Redis backup may hold newer,
      //    valid material, so route through candidate resolution.
      // 2. CONNECTED/RECONNECTING/LOGGING_OUT (a session THIS process
      //    validated is now invalidated): genuine security failure — destroy
      //    fail-closed.
      // 3. PAIRING (no authenticated session): Baileys emits "security-coded"
      //    disconnects as side effects of the unauthenticated socket
      //    lifecycle — treating them as security failures would destroy an
      //    auth directory that was never registered; they stay pairing retries.
      if (
        isSecurityFailure(statusCode) &&
        currentState === WhatsAppState.CONNECTING &&
        this.connectCandidate !== null
      ) {
        // Case 1: the candidate was definitively rejected by WhatsApp.
        const reason = `candidate rejected (code: ${statusCode ?? 'unknown'})`;
        log.warn(
          { statusCode, currentState, candidate: this.connectCandidate, ...disconnectDetails },
          'Security-coded rejection during pre-validation connect — candidate resolution',
        );
        this.sessionManager.markSessionNone();
        void this.handleCandidateRejected(reason);
      } else if (isSecurityFailure(statusCode) && isAuthenticatedState(currentState)) {
        // Case 2: a validated session is invalidated — destroy, fail closed.
        const reason = `WhatsApp security failure (code: ${statusCode ?? 'unknown'})`;
        log.warn({ statusCode, currentState, ...disconnectDetails }, 'Security failure detected; destroying session');
        await this.handleSecurityFailure(reason);
      } else if (isSecurityFailure(statusCode) && !isAuthenticatedState(currentState)) {
        // Case 3: security-coded disconnect during PAIRING — Baileys uses
        // these codes for socket housekeeping before authentication completes.
        log.info(
          { statusCode, currentState, ...disconnectDetails },
          'Security-coded disconnect during pre-auth state; treating as pairing retry (not security failure)',
        );
        this.schedulePairingRetry();
      } else {
        // Transient failure (or an unknown code — the safe default is the
        // same classification), classified STATE-FIRST:
        // - PAIRING → a pairing event, not a reconnect: Baileys periodically
        //   closes the pairing socket (e.g. 515 restartRequired) to rotate
        //   the QR. Pairing stays PAIRING and the retry creates the next
        //   socket; a RECONNECTING transition is NEVER attempted from
        //   PAIRING (not an authenticated runtime state).
        // - CONNECTED/CONNECTING (authenticated runtime) → RECONNECTING +
        //   schedule the reconnect.
        // - anything else → ignored (nothing pairing, nothing to reconnect).
        const transient = isTransientFailure(statusCode);
        if (transient) {
          log.info({ statusCode, currentState, ...disconnectDetails }, 'Transient connection failure');
        } else {
          log.warn({ statusCode, currentState, ...disconnectDetails }, 'Unknown disconnect code; treating as transient');
        }
        if (currentState === WhatsAppState.PAIRING) {
          log.info('Pairing socket closed — scheduling pairing retry for a fresh QR code');
          this.schedulePairingRetry();
        } else if (this.transitionToReconnecting()) {
          this.scheduleReconnect();
        } else {
          log.info(
            { currentState },
            'Transient disconnect ignored — not in an authenticated or pairing state',
          );
        }
      }
    }
  }

  /**
   * Save credentials when they update and (debounced, in the background)
   * refresh the Redis backup. creds.update is Baileys PROTOCOL traffic —
   * never runtime demand.
   */
  private async onCredsUpdate(): Promise<void> {
    if (this.authState) {
      try {
        await this.authState.saveCreds();
      } catch (err) {
        getLogger().error(
          { err: err instanceof Error ? err.message : String(err) },
          'Failed to save credentials',
        );
      }
    }
    // Only a validated session is backed up; writes are coalesced
    // background work that never blocks the credential save or a send.
    if (this.sessionValidated) {
      this.backupScheduler.schedule();
    }
  }

  /** Verify the connected identity matches the configured JID (if any). */
  private async validateIdentity(): Promise<void> {
    const cfg = getConfig();
    if (!cfg.expectedWhatsappJid) {
      return; // Identity validation not configured
    }

    if (this.connectedJid !== cfg.expectedWhatsappJid) {
      const reason = `Identity mismatch: expected ${cfg.expectedWhatsappJid}, got ${this.connectedJid}`;
      getLogger().warn({ connectedJid: this.connectedJidForLog() }, 'WhatsApp identity mismatch');
      await this.handleSecurityFailure(reason);
    }
  }

  private connectedJidForLog(): string {
    // Log only whether a JID exists, not the JID itself (sensitive).
    return this.connectedJid ? '[present]' : '[absent]';
  }

  /** Security failure: transition to SECURITY_INVALIDATED, emit the event,
   *  destroy the session (fail closed — local material AND the Redis backup,
   *  so an invalid session can never resurrect), settle to IDLE. */
  private async handleSecurityFailure(reason: string): Promise<void> {
    const log = getLogger();
    const currentState = this.stateMachine.state;

    this.cancelShutdownGrace();

    if (isValidWhatsAppTransition(currentState, WhatsAppState.SECURITY_INVALIDATED)) {
      this.stateMachine.transition(WhatsAppState.SECURITY_INVALIDATED);
    } else if (currentState !== WhatsAppState.SECURITY_INVALIDATED) {
      this.stateMachine.forceTransition(WhatsAppState.SECURITY_INVALIDATED, reason);
    }

    getEventBus().emitEvent(EventType.SECURITY_EVENT, {
      code: ErrorCode.WHATSAPP_AUTH_INVALID,
      reason,
    });

    try {
      await this.sessionManager.destroySession(reason, 'security');
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err.message : String(err) },
        'Error during security session destruction',
      );
    }

    this.sessionValidated = false;

    // Baileys stays off after security invalidation (destroySession settled
    // the state to IDLE); only an explicit login starts a new session.
    log.info('Security failure handled — Baileys off, state = IDLE');
  }

  /**
   * Transition to RECONNECTING (valid only from CONNECTED/CONNECTING).
   * PAIRING closes are classified as pairing events BEFORE this can be
   * reached, so the rejection warning only fires for genuinely unexpected
   * states (e.g. IDLE) — never for PAIRING.
   */
  private transitionToReconnecting(): boolean {
    const currentState = this.stateMachine.state;

    if (currentState === WhatsAppState.RECONNECTING) {
      return true; // already reconnecting — allow scheduling
    }

    if (isValidWhatsAppTransition(currentState, WhatsAppState.RECONNECTING)) {
      return this.stateMachine.transition(WhatsAppState.RECONNECTING);
    }

    getLogger().warn(
      { currentState },
      'Cannot transition to RECONNECTING from current state; transition rejected',
    );
    return false;
  }

  /** Schedule a reconnect with bounded backoff and jitter. */
  private scheduleReconnect(): void {
    const cfg = getConfig();
    const delay = calculateBackoff(
      this.reconnectAttempts,
      cfg.reconnectBaseMs,
      cfg.reconnectMaxMs,
    );

    getLogger().info(
      { attempt: this.reconnectAttempts, delayMs: delay },
      'Scheduling reconnect',
    );

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectAttempts++;
      void this.reconnect();
    }, delay);
  }

  private async reconnect(): Promise<void> {
    const log = getLogger();

    if (lifecycleShuttingDown()) {
      log.info('Server is shutting down; aborting reconnect');
      return;
    }

    if (this.stateMachine.state !== WhatsAppState.RECONNECTING) {
      log.warn(
        { state: this.stateMachine.state },
        'Reconnect called but not in RECONNECTING state; aborting',
      );
      return;
    }

    try {
      await this.createSocket();
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err.message : String(err) },
        'Reconnect failed; scheduling another attempt',
      );
      this.scheduleReconnect();
    }
  }

  /**
   * Schedule a pairing retry with bounded backoff and jitter. The state
   * stays PAIRING (never RECONNECTING) — a new socket is created so Baileys
   * can emit a fresh QR.
   */
  private schedulePairingRetry(): void {
    const cfg = getConfig();
    const delay = calculateBackoff(
      this.reconnectAttempts,
      cfg.reconnectBaseMs,
      cfg.reconnectMaxMs,
    );

    getLogger().info(
      { attempt: this.reconnectAttempts, delayMs: delay },
      'Scheduling pairing retry',
    );

    if (this.pairingRetryTimer) {
      clearTimeout(this.pairingRetryTimer);
    }

    this.pairingRetryTimer = setTimeout(() => {
      this.pairingRetryTimer = null;
      this.reconnectAttempts++;
      void this.retryPairing();
    }, delay);
  }

  /** Retry only while still PAIRING — the state may have changed (e.g. the
   *  QR was scanned and the session connected) since the retry was armed. */
  private async retryPairing(): Promise<void> {
    const log = getLogger();

    if (lifecycleShuttingDown()) {
      log.info('Server is shutting down; aborting pairing retry');
      return;
    }

    if (this.stateMachine.state !== WhatsAppState.PAIRING) {
      log.info(
        { state: this.stateMachine.state },
        'Pairing retry skipped — no longer in PAIRING state',
      );
      return;
    }

    try {
      await this.createSocket();
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err.message : String(err) },
        'Pairing retry failed; scheduling another attempt',
      );
      this.schedulePairingRetry();
    }
  }

  /**
   * Send a PDF document message with a caption as ONE WhatsApp message. The
   * document is opaque media — never interpreted, stored, or persisted
   * beyond this send operation.
   * @throws AppError if not connected, sends blocked, or the send fails.
   */
  async sendDocumentMessage(
    recipient: string,
    document: Buffer,
    fileName: string,
    caption?: string,
    thumbnail?: DocumentThumbnail | null,
  ): Promise<{ messageId: string }> {
    // A send operation is runtime demand — the runtime must stay alive
    // while it executes (including its bounded retries upstream), even with
    // no frontend client present.
    this.activeSendOperations += 1;
    try {
      return await this.sendDocumentMessageInner(recipient, document, fileName, caption, thumbnail);
    } finally {
      this.activeSendOperations -= 1;
      this.evaluateRuntimeDemand();
    }
  }

  /** The send body (executed while activeSendOperations is held). */
  private async sendDocumentMessageInner(
    recipient: string,
    document: Buffer,
    fileName: string,
    caption?: string,
    thumbnail?: DocumentThumbnail | null,
  ): Promise<{ messageId: string }> {
    const log = getLogger();

    if (!isValidJid(recipient)) {
      throw new AppError(ErrorCode.WHATSAPP_RECIPIENT_INVALID, {
        internalDetails: { recipient },
      });
    }

    if (getLifecycle().sendsBlocked) {
      throw new AppError(ErrorCode.SERVER_NOT_READY, {
        message: 'Sends are currently blocked due to logout or security event',
      });
    }

    if (this.stateMachine.state !== WhatsAppState.CONNECTED || !this.socket) {
      throw new AppError(ErrorCode.WHATSAPP_NOT_CONNECTED);
    }

    try {
      // ONE document message. Baileys never generates a preview for
      // documents (only image/video), so jpegThumbnail must be supplied by
      // us — attached EXACTLY as received (never re-encoded/resized), with
      // the GENERATOR's width/height for the receiving client's bubble layout.
      const messageContent: {
        document: Buffer;
        mimetype: string;
        fileName: string;
        caption?: string;
        jpegThumbnail?: Buffer;
        thumbnailWidth?: number;
        thumbnailHeight?: number;
      } = {
        document,
        mimetype: 'application/pdf',
        fileName,
      };
      if (caption) {
        messageContent.caption = caption;
      }

      // A null/empty jpeg travels as a clean PDF-only document message: the
      // preview is cosmetic and must never block or fail the send. Missing
      // dimension hints degrade the preview layout, never the send.
      if (thumbnail && Buffer.isBuffer(thumbnail.jpeg) && thumbnail.jpeg.length > 0) {
        messageContent.jpegThumbnail = thumbnail.jpeg;
        if (Number.isFinite(thumbnail.width) && thumbnail.width > 0) {
          messageContent.thumbnailWidth = thumbnail.width;
        }
        if (Number.isFinite(thumbnail.height) && thumbnail.height > 0) {
          messageContent.thumbnailHeight = thumbnail.height;
        }
      }

      const result = await this.socket.sendMessage(recipient, messageContent);
      if (!result?.key?.id) {
        throw new AppError(ErrorCode.WHATSAPP_SEND_FAILED, {
          internalDetails: { reason: 'No message ID returned' },
        });
      }
      return { messageId: result.key.id };
    } catch (err) {
      if (err instanceof AppError) {
        throw err;
      }
      log.error(
        { err: err instanceof Error ? err.message : String(err) },
        'WhatsApp send failed',
      );
      throw new AppError(ErrorCode.WHATSAPP_SEND_FAILED, {
        cause: err,
        internalDetails: {
          recipient,
          errorType: err instanceof Error ? err.constructor.name : 'unknown',
        },
      });
    }
  }

  // ── QR countdown engine ───────────────────────────────────────────────

  /**
   * Start the backend-owned countdown: emits WHATSAPP_QR_COUNTDOWN every
   * second until the QR expires. Only one timer runs at a time; the
   * generation ID makes a stale timer from a previous QR cycle inert. At 0
   * the timer stops — Baileys emits a new QR (or the pairing retry creates
   * a fresh socket), which starts this again.
   */
  private startQrCountdown(generationId: number, expiresAt: Date): void {
    if (this.qrCountdownTimer !== null) {
      clearInterval(this.qrCountdownTimer);
      this.qrCountdownTimer = null;
    }

    const expiresAtIso = expiresAt.toISOString();

    this.qrCountdownTimer = setInterval(() => {
      // A newer QR generation has started — this timer is stale; stop it.
      if (this.qrGenerationId !== generationId) {
        if (this.qrCountdownTimer !== null) {
          clearInterval(this.qrCountdownTimer);
          this.qrCountdownTimer = null;
        }
        return;
      }

      const remainingMs = expiresAt.getTime() - Date.now();
      const remainingSeconds = Math.max(0, Math.ceil(remainingMs / 1000));

      getEventBus().emitEvent(EventType.WHATSAPP_QR_COUNTDOWN, {
        remainingSeconds,
        expiresAt: expiresAtIso,
      });

      if (remainingSeconds === 0) {
        // QR expired — stop the timer (Baileys emits a new QR or the pairing
        // retry timer creates a new socket for a fresh one).
        if (this.qrCountdownTimer !== null) {
          clearInterval(this.qrCountdownTimer);
          this.qrCountdownTimer = null;
        }
      }
    }, 1000);
  }

  /** Cancel the QR countdown (QR cleared / connected / shutdown). */
  private cancelQrCountdown(): void {
    if (this.qrCountdownTimer !== null) {
      clearInterval(this.qrCountdownTimer);
      this.qrCountdownTimer = null;
    }
  }

  // ── WhatsAppLifecycleHooks implementation ────────────────────────────

  async closeSocket(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.pairingRetryTimer) {
      clearTimeout(this.pairingRetryTimer);
      this.pairingRetryTimer = null;
    }

    this.cancelQrCountdown();

    if (this.socket) {
      try {
        this.socket.ev.removeAllListeners('connection.update');
        this.socket.ev.removeAllListeners('creds.update');
      } catch {
        // best-effort
      }
      try {
        this.socket.end(undefined);
      } catch {
        // ignore
      }
      this.socket = null;
    }
    getLogger().info('Baileys socket closed');
  }

  invalidateAuthState(): void {
    this.authState = null;
    this.connectedJid = null;
    this.sessionValidated = false;
    // Destruction is about to invalidate the backup — a stale in-flight
    // save must never resurrect destroyed material.
    this.backupScheduler.cancel();
    getLogger().info('Auth state invalidated');
  }

  clearQr(): void {
    this.currentQr = null;
    this.currentQrExpiresAt = null;
    this.cancelQrCountdown();
  }

  hasActiveSocket(): boolean {
    return this.socket !== null;
  }

  // ── Read accessors for API layer ─────────────────────────────────────

  getQrCode(): string | null {
    return this.currentQr;
  }

  getQrExpiresAt(): string | null {
    return this.currentQrExpiresAt ? this.currentQrExpiresAt.toISOString() : null;
  }

  /** Seconds until the current QR expires (null when no QR) — mirrors the
   *  SSE countdown so a REST snapshot is lifecycle-complete. */
  getQrExpiresInSeconds(): number | null {
    if (!this.currentQrExpiresAt) return null;
    return Math.max(0, Math.ceil((this.currentQrExpiresAt.getTime() - Date.now()) / 1000));
  }

  getConnectedJid(): string | null {
    return this.connectedJid;
  }

  isConnected(): boolean {
    return this.stateMachine.state === WhatsAppState.CONNECTED && this.socket !== null;
  }

  get state(): WhatsAppStateValue {
    return this.stateMachine.state;
  }

  /**
   * Graceful shutdown: cancel the grace timer, close the socket (session
   * material is PRESERVED — shutdown is not logout), flush any pending
   * backup save (bounded, best-effort).
   */
  async stop(): Promise<void> {
    this.cancelShutdownGrace();
    await this.closeSocket();
    await this.backupScheduler.flush(3_000);
  }
}

function lifecycleShuttingDown(): boolean {
  return getLifecycle().shuttingDown;
}
