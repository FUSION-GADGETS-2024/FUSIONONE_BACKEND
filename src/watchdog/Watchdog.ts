/**
 * Watchdog — periodic checks for security invariant violations (via the
 * SecurityManager) and inconsistent lifecycle state. Availability failures
 * recover through the existing reconnect/backoff machinery; security
 * failures destroy the session. The watchdog never invents new states or
 * errors. The send pipeline is stateless, so there is no stuck send to
 * detect — SendController's timeout bounds every send.
 */
import { getLogger } from '../logging/logger.js';
import { ErrorCode } from '../errors/registry.js';
import type { SecurityManager } from '../security/SecurityManager.js';

const CHECK_INTERVAL_MS = 10_000;

export class Watchdog {
  private readonly securityManager: SecurityManager;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(securityManager: SecurityManager) {
    this.securityManager = securityManager;
  }

  start(): void {
    if (this.timer) return;

    this.timer = setInterval(() => {
      void this.check();
    }, CHECK_INTERVAL_MS);

    getLogger().info('Watchdog started');
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      getLogger().info('Watchdog stopped');
    }
  }

  async check(): Promise<void> {
    const log = getLogger();

    try {
      const violations = await this.securityManager.verifyInvariants();

      for (const violation of violations) {
        if (violation.severity === 'critical') {
          log.warn(
            { invariant: violation.invariant, description: violation.description },
            'Critical security invariant violation detected by watchdog',
          );

          await this.securityManager.triggerSecurityInvalidation(
            `Watchdog: ${violation.description}`,
            ErrorCode.SECURITY_POLICY_VIOLATION,
          );
          return; // only handle one violation per check cycle
        }
        log.warn(
          { invariant: violation.invariant, description: violation.description },
          'Security warning from watchdog',
        );
      }
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err.message : String(err) },
        'Watchdog check error',
      );
    }
  }
}
