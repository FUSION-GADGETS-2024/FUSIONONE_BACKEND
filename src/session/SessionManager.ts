/**
 * Session Manager — owns the Baileys authentication directory, the SESSION
 * dimension (NONE / PRESENT / RESTORING — separate from the runtime states),
 * and the single authoritative session-destruction operation.
 *
 * destroySession(reason) is the ONLY operation that destroys authentication
 * state (logout, security, shutdown all use it) and also invalidates the
 * Redis backup so a destroyed session can never resurrect.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getConfig } from '../config/index.js';
import { getLogger } from '../logging/logger.js';
import { getLifecycle } from './lifecycle.js';
import { getEventBus } from '../events/emitter.js';
import { EventType } from '../events/registry.js';
import { WhatsAppState, type WhatsAppStateValue } from '../state/whatsapp-states.js';
import { isValidWhatsAppTransition } from '../state/transitions.js';
import { StateMachine } from '../state/state-machine.js';
import { ErrorCode } from '../errors/registry.js';
import { invalidateBackup } from './backup/SessionBackup.js';

/** Socket/auth lifecycle hooks registered by WhatsAppManager (avoids a
 *  circular import between the two managers). */
export interface WhatsAppLifecycleHooks {
  closeSocket(): Promise<void>;
  invalidateAuthState(): void;
  clearQr(): void;
  hasActiveSocket(): boolean;
}

export type DestructionMode = 'logout' | 'security' | 'shutdown';

/**
 * The SESSION dimension — a separate axis from the runtime states.
 *   NONE      — no usable authentication material
 *   PRESENT   — candidate material exists that waking may reuse without QR
 *   RESTORING — a Redis-backup restoration is in flight (not yet validated)
 *
 * Baileys' useMultiFileAuthState writes creds.json as soon as a pairing
 * socket initializes — BEFORE any QR scan. creds.json alone is therefore
 * candidate material, never proof of an authenticated session; the dimension
 * is only marked PRESENT once a real connection has validated it.
 */
export type SessionDimension = 'NONE' | 'PRESENT' | 'RESTORING';

export class SessionManager {
  private readonly authDir: string;
  private readonly stateMachine: StateMachine<WhatsAppStateValue>;
  private hooks: WhatsAppLifecycleHooks | null = null;
  private sessionDimension: SessionDimension = 'NONE';

  constructor(stateMachine: StateMachine<WhatsAppStateValue>) {
    const cfg = getConfig();
    this.authDir = path.resolve(cfg.whatsappAuthDir);
    this.stateMachine = stateMachine;
  }

  registerHooks(hooks: WhatsAppLifecycleHooks): void {
    this.hooks = hooks;
  }

  get authDirectory(): string {
    return this.authDir;
  }

  get session(): SessionDimension {
    return this.sessionDimension;
  }

  markSessionPresent(): void {
    this.sessionDimension = 'PRESENT';
  }

  markSessionNone(): void {
    this.sessionDimension = 'NONE';
  }

  markSessionRestoring(): void {
    this.sessionDimension = 'RESTORING';
  }

  /** Re-sync the cached dimension from the filesystem (boot time). */
  async resyncSessionDimension(): Promise<SessionDimension> {
    this.sessionDimension = (await this.sessionExists()) ? 'PRESENT' : 'NONE';
    return this.sessionDimension;
  }

  async sessionExists(): Promise<boolean> {
    try {
      const stats = await fs.stat(this.authDir);
      if (!stats.isDirectory()) {
        return false;
      }
      await fs.access(path.join(this.authDir, 'creds.json'));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Whether creds.json exists but cannot be parsed or lacks required fields.
   * A missing creds.json is "absent", not corrupted.
   */
  async isSessionCorrupted(): Promise<boolean> {
    const credsPath = path.join(this.authDir, 'creds.json');

    try {
      await fs.access(credsPath);
    } catch {
      return false;
    }

    try {
      const content = await fs.readFile(credsPath, 'utf-8');
      const parsed = JSON.parse(content);
      if (!parsed || typeof parsed !== 'object') {
        return true;
      }
      // Baileys creds must contain at least a registration ID.
      if (parsed.registrationId === undefined) {
        return true;
      }
      return false;
    } catch {
      return true;
    }
  }

  /**
   * Discard UNVALIDATED pairing residue — NOT a session destruction.
   *
   * When a pairing runtime is abandoned (QR never scanned), Baileys has
   * already written creds.json for a session that was never registered.
   * That residue is not a session: keeping it would advertise a wake-able
   * session that cannot wake. NEVER call this for validated material —
   * that is only ever removed by destroySession.
   */
  async discardUnvalidatedPairingResidue(): Promise<void> {
    try {
      await fs.rm(this.authDir, { recursive: true, force: true });
      getLogger().info('Unvalidated pairing residue discarded (QR never scanned)');
    } catch (err) {
      getLogger().warn(
        { err: err instanceof Error ? err.message : String(err) },
        'Failed to discard unvalidated pairing residue — leaving as candidate',
      );
      return;
    }
    this.sessionDimension = 'NONE';
  }

  async ensureAuthDir(): Promise<void> {
    await fs.mkdir(this.authDir, { recursive: true });
  }

  /**
   * THE authoritative session destruction. If filesystem or backup cleanup
   * fails, it does NOT claim success: SECURITY_SESSION_CLEANUP_FAILED is
   * emitted and sends stay blocked (fail closed) — credentials that may
   * persist must never be treated as destroyed.
   */
  async destroySession(reason: string, mode: DestructionMode = 'logout'): Promise<void> {
    const log = getLogger();
    const lifecycle = getLifecycle();

    const releaseLock = await lifecycle.lifecycleLock.acquire();
    log.info({ reason, mode, currentState: this.stateMachine.state }, 'Session destruction starting');

    try {
      // Invalidate the session generation FIRST: in-flight async operations
      // (startup, Redis restore, background save) started before this
      // destruction must discard their result.
      lifecycle.invalidateSessionGeneration();
      lifecycle.blockSends();

      const currentState = this.stateMachine.state;
      if (mode === 'logout' && currentState !== WhatsAppState.LOGGING_OUT) {
        if (!this.stateMachine.transition(WhatsAppState.LOGGING_OUT)) {
          log.warn(
            { from: currentState, reason },
            'Cannot transition to LOGGING_OUT from current state; forcing',
          );
          this.stateMachine.forceTransition(WhatsAppState.LOGGING_OUT, reason);
        }
      }

      if (this.hooks?.hasActiveSocket()) {
        try {
          await this.hooks.closeSocket();
        } catch (err) {
          log.error(
            { err: err instanceof Error ? err.message : String(err), reason },
            'Error closing Baileys socket during session destruction',
          );
          // Continue with destruction — we must not leave credentials on disk.
        }
      }

      this.hooks?.invalidateAuthState();

      let cleanupSucceeded = false;
      try {
        await fs.rm(this.authDir, { recursive: true, force: true });
        cleanupSucceeded = true;
      } catch (err) {
        log.error(
          { err: err instanceof Error ? err.message : String(err), reason },
          'Failed to remove auth directory',
        );
      }

      if (cleanupSucceeded) {
        try {
          await fs.access(this.authDir);
          cleanupSucceeded = false;
        } catch {
          // Directory does not exist — cleanup succeeded.
        }
      }

      // Fail closed: an unconfirmed backup deletion could resurrect the
      // session, so it is treated as a cleanup failure.
      if (cleanupSucceeded) {
        try {
          await invalidateBackup();
        } catch (err) {
          log.error(
            { err: err instanceof Error ? err.message : String(err), reason },
            'Failed to invalidate the Redis session backup',
          );
          cleanupSucceeded = false;
        }
      }

      this.hooks?.clearQr();

      if (!cleanupSucceeded) {
        log.error({ reason }, 'Session cleanup failed — failing closed');
        getEventBus().emitEvent(EventType.SECURITY_EVENT, {
          code: ErrorCode.SECURITY_SESSION_CLEANUP_FAILED,
          reason,
        });

        const stateAfterDestruction = this.stateMachine.state;
        if (isValidWhatsAppTransition(stateAfterDestruction, WhatsAppState.SECURITY_INVALIDATED)) {
          this.stateMachine.transition(WhatsAppState.SECURITY_INVALIDATED);
        } else if (stateAfterDestruction !== WhatsAppState.SECURITY_INVALIDATED) {
          this.stateMachine.forceTransition(WhatsAppState.SECURITY_INVALIDATED, 'cleanup failed');
        }
        // Sends remain blocked — do NOT unblock.
        return;
      }

      this.sessionDimension = 'NONE';

      if (mode === 'shutdown') {
        const s = this.stateMachine.state;
        if (s !== WhatsAppState.STOPPING) {
          if (isValidWhatsAppTransition(s, WhatsAppState.STOPPING)) {
            this.stateMachine.transition(WhatsAppState.STOPPING);
          } else {
            this.stateMachine.forceTransition(WhatsAppState.STOPPING, 'shutdown');
          }
        }
      } else {
        // Logout or security: end in IDLE with NO session. Baileys stays
        // off until an explicit login request — never auto-pair.
        const s = this.stateMachine.state;
        if (isValidWhatsAppTransition(s, WhatsAppState.IDLE)) {
          this.stateMachine.transition(WhatsAppState.IDLE);
        } else if (s !== WhatsAppState.IDLE) {
          this.stateMachine.forceTransition(WhatsAppState.IDLE, `${mode} complete`);
        }

        // With the state IDLE, sends are rejected by assertSendAllowed with
        // the canonical WHATSAPP_NOT_CONNECTED — the block flag is no longer
        // needed and must not outlive the session.
        lifecycle.unblockSends();

        log.info({ reason, mode, finalState: this.stateMachine.state }, 'Session destroyed successfully');
      }
    } finally {
      releaseLock();
    }
  }
}
