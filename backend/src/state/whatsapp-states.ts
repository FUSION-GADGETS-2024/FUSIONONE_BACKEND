/**
 * WhatsApp RUNTIME states (closed set). The WhatsApp SESSION is a separate
 * dimension (NONE / PRESENT / RESTORING — see SessionManager) and must never
 * be conflated with these runtime states.
 *
 * IDLE + PRESENT is the intentional sleep state: the runtime is fully
 * stopped (no socket, no keepalive, no reconnect loop) while the session
 * material is preserved and reusable without QR pairing.
 */
export const WhatsAppState = {
  STARTING: 'STARTING',
  IDLE: 'IDLE',
  PAIRING: 'PAIRING',
  CONNECTING: 'CONNECTING',
  CONNECTED: 'CONNECTED',
  RECONNECTING: 'RECONNECTING',
  LOGGING_OUT: 'LOGGING_OUT',
  SECURITY_INVALIDATED: 'SECURITY_INVALIDATED',
  STOPPING: 'STOPPING',
} as const;

export type WhatsAppStateValue =
  (typeof WhatsAppState)[keyof typeof WhatsAppState];
