/**
 * WhatsApp runtime state transition table.
 *
 * KEY INVARIANTS:
 *   - Every → IDLE transition from an active runtime state (PAIRING,
 *     CONNECTING, CONNECTED, RECONNECTING) is an INTENTIONAL stop that
 *     PRESERVES session material. Only LOGGING_OUT → IDLE and
 *     SECURITY_INVALIDATED → IDLE are destructive (session destroyed).
 *   - After logout or security invalidation the runtime stays IDLE with no
 *     session; pairing only starts through an explicit login request.
 *   - IDLE is never a reconnect source: an intentionally closed socket
 *     cannot re-enter the reconnect loop.
 */
import { WhatsAppState, type WhatsAppStateValue } from './whatsapp-states.js';

const WHATSAPP_TRANSITIONS: Readonly<Record<WhatsAppStateValue, ReadonlySet<WhatsAppStateValue>>> =
  Object.freeze({
    [WhatsAppState.STARTING]: new Set<WhatsAppStateValue>([
      WhatsAppState.IDLE,
      WhatsAppState.STOPPING,
    ]),
    [WhatsAppState.IDLE]: new Set<WhatsAppStateValue>([
      WhatsAppState.PAIRING,
      WhatsAppState.CONNECTING,
      WhatsAppState.LOGGING_OUT,
      WhatsAppState.STOPPING,
    ]),
    [WhatsAppState.PAIRING]: new Set<WhatsAppStateValue>([
      WhatsAppState.CONNECTING,
      WhatsAppState.IDLE,
      WhatsAppState.STOPPING,
    ]),
    [WhatsAppState.CONNECTING]: new Set<WhatsAppStateValue>([
      WhatsAppState.CONNECTED,
      WhatsAppState.RECONNECTING,
      WhatsAppState.SECURITY_INVALIDATED,
      WhatsAppState.IDLE,
      WhatsAppState.PAIRING,
      WhatsAppState.STOPPING,
    ]),
    [WhatsAppState.CONNECTED]: new Set<WhatsAppStateValue>([
      WhatsAppState.RECONNECTING,
      WhatsAppState.LOGGING_OUT,
      WhatsAppState.SECURITY_INVALIDATED,
      WhatsAppState.IDLE,
      WhatsAppState.STOPPING,
    ]),
    [WhatsAppState.RECONNECTING]: new Set<WhatsAppStateValue>([
      WhatsAppState.CONNECTED,
      WhatsAppState.SECURITY_INVALIDATED,
      WhatsAppState.IDLE,
      WhatsAppState.STOPPING,
    ]),
    [WhatsAppState.LOGGING_OUT]: new Set<WhatsAppStateValue>([
      WhatsAppState.IDLE,
      WhatsAppState.SECURITY_INVALIDATED,
      WhatsAppState.STOPPING,
    ]),
    [WhatsAppState.SECURITY_INVALIDATED]: new Set<WhatsAppStateValue>([
      WhatsAppState.IDLE,
      WhatsAppState.STOPPING,
    ]),
    [WhatsAppState.STOPPING]: new Set<WhatsAppStateValue>(),
  });

export function isValidWhatsAppTransition(
  from: WhatsAppStateValue,
  to: WhatsAppStateValue,
): boolean {
  const allowed = WHATSAPP_TRANSITIONS[from];
  return allowed !== undefined && allowed.has(to);
}
