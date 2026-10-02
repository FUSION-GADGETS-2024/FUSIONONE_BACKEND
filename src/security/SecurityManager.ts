/**
 * Security Manager — the central authority for security decisions and
 * fail-closed security invalidation.
 *
 * Invariants enforced:
 *   1. The frontend cannot directly control Baileys (no such endpoints)
 *   2. Only WhatsAppManager owns the socket
 *   3. Only SessionManager destroys authentication state
 *   4. Security invalidation / LOGGING_OUT blocks invoice sending
 *   5. Normal shutdown does not delete the session
 *   6. Authentication failures never enter endless reconnect loops
 *   7. The connected identity must match the configured expected identity
 *   8. Corrupted authentication state results in session destruction
 *   9. Unknown state/event/error values cannot escape the backend
 *  10. Session cleanup failure is never reported as successful cleanup
 *
 * Only explicitly defined security conditions trigger automatic security
 * logout — no behavioral heuristics.
 */
import { promises as fs } from 'node:fs';
import { getConfig } from '../config/index.js';
import { getLogger } from '../logging/logger.js';
import { getLifecycle } from '../session/lifecycle.js';
import { getEventBus } from '../events/emitter.js';
import { EventType } from '../events/registry.js';
import { WhatsAppState, type WhatsAppStateValue } from '../state/whatsapp-states.js';
import { isValidWhatsAppTransition } from '../state/transitions.js';
import { StateMachine } from '../state/state-machine.js';
import { AppError, ErrorCode, type ErrorCodeValue } from '../errors/registry.js';
import type { SessionManager } from '../session/SessionManager.js';
import type { WhatsAppManager } from '../whatsapp/WhatsAppManager.js';

export interface InvariantViolation {
  invariant: string;
  description: string;
  severity: 'critical' | 'warning';
}

export class SecurityManager {
  private readonly stateMachine: StateMachine<WhatsAppStateValue>;
  private readonly sessionManager: SessionManager;
  private whatsappManager: WhatsAppManager | null = null;

  constructor(
    stateMachine: StateMachine<WhatsAppStateValue>,
    sessionManager: SessionManager,
  ) {
    this.stateMachine = stateMachine;
    this.sessionManager = sessionManager;
  }

  registerWhatsAppManager(wm: WhatsAppManager): void {
    this.whatsappManager = wm;
  }

  /**
   * Fail-closed security invalidation: block sends → SECURITY_INVALIDATED →
   * SECURITY_EVENT → destroySession (settles to IDLE with NO session).
   * Baileys stays off; only an explicit POST /api/whatsapp/login starts a
   * new session — the socket is never re-created here.
   */
  async triggerSecurityInvalidation(
    reason: string,
    code: ErrorCodeValue = ErrorCode.SECURITY_POLICY_VIOLATION,
  ): Promise<void> {
    const log = getLogger();
    const lifecycle = getLifecycle();

    log.warn({ reason, code }, 'Security invalidation triggered');

    lifecycle.blockSends();

    const currentState = this.stateMachine.state;
    if (currentState === WhatsAppState.SECURITY_INVALIDATED) {
      log.warn('Already in SECURITY_INVALIDATED state; skipping duplicate invalidation');
      return;
    }

    if (isValidWhatsAppTransition(currentState, WhatsAppState.SECURITY_INVALIDATED)) {
      this.stateMachine.transition(WhatsAppState.SECURITY_INVALIDATED);
    } else if (currentState !== WhatsAppState.STOPPING) {
      this.stateMachine.forceTransition(WhatsAppState.SECURITY_INVALIDATED, reason);
    }

    getEventBus().emitEvent(EventType.SECURITY_EVENT, { code, reason });

    // destroySession will transition SECURITY_INVALIDATED → IDLE.
    try {
      await this.sessionManager.destroySession(reason, 'security');
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err.message : String(err) },
        'Error during security session destruction',
      );
    }
  }

  /**
   * Whether an invoice send is allowed under the current security state.
   * @throws AppError if sends are blocked or WhatsApp is not connected.
   */
  assertSendAllowed(): void {
    const lifecycle = getLifecycle();

    if (lifecycle.shuttingDown) {
      throw new AppError(ErrorCode.SERVER_NOT_READY, {
        message: 'Server is shutting down',
      });
    }

    if (lifecycle.sendsBlocked) {
      throw new AppError(ErrorCode.SERVER_NOT_READY, {
        message: 'Sends are blocked due to security event or logout',
      });
    }

    if (this.stateMachine.state !== WhatsAppState.CONNECTED) {
      throw new AppError(ErrorCode.WHATSAPP_NOT_CONNECTED);
    }
  }

  /** Verify all security invariants; returns the violations (empty = all
   *  hold). Used by the watchdog. */
  async verifyInvariants(): Promise<InvariantViolation[]> {
    const violations: InvariantViolation[] = [];
    const cfg = getConfig();
    const lifecycle = getLifecycle();

    if (this.stateMachine.state === WhatsAppState.SECURITY_INVALIDATED && !lifecycle.sendsBlocked) {
      violations.push({
        invariant: 'SECURITY_INVALIDATION_BLOCKS_SENDS',
        description: 'State is SECURITY_INVALIDATED but sends are not blocked',
        severity: 'critical',
      });
    }

    if (this.stateMachine.state === WhatsAppState.LOGGING_OUT && !lifecycle.sendsBlocked) {
      violations.push({
        invariant: 'LOGGING_OUT_BLOCKS_SENDS',
        description: 'State is LOGGING_OUT but sends are not blocked',
        severity: 'critical',
      });
    }

    if (cfg.expectedWhatsappJid && this.whatsappManager && this.stateMachine.state === WhatsAppState.CONNECTED) {
      const connectedJid = this.whatsappManager.getConnectedJid();
      if (connectedJid && connectedJid !== cfg.expectedWhatsappJid) {
        violations.push({
          invariant: 'IDENTITY_MISMATCH',
          description: 'Connected JID does not match expected identity',
          severity: 'critical',
        });
      }
    }

    // Auth directory isolation: only Baileys auth material may live there.
    try {
      const authDir = this.sessionManager.authDirectory;
      const entries = await fs.readdir(authDir);
      for (const entry of entries) {
        const isValidAuthFile =
          entry === 'creds.json' ||
          entry.startsWith('app-state-sync-key-') ||
          entry.startsWith('app-state-sync-version-') ||
          entry.startsWith('pre-key-') ||
          entry.startsWith('sender-key-') ||
          entry.startsWith('session-') ||
          entry.startsWith('noise-key-') ||
          entry.startsWith('signal-identity-');

        if (!isValidAuthFile) {
          violations.push({
            invariant: 'AUTH_DIR_ISOLATION',
            description: `Unexpected file in auth directory: ${entry}`,
            severity: 'warning',
          });
        }
      }
    } catch {
      // Directory doesn't exist — fine (no session).
    }

    return violations;
  }

  /** Whether the server can accept commands. */
  isOperational(): boolean {
    const state = this.stateMachine.state;
    const lifecycle = getLifecycle();
    return (
      !lifecycle.shuttingDown &&
      state !== WhatsAppState.STOPPING &&
      state !== WhatsAppState.SECURITY_INVALIDATED
    );
  }
}
