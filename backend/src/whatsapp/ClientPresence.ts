/**
 * Client Presence — how many authenticated FUSIONONE clients are currently
 * connected to the backend.
 *
 * Presence is derived from the authenticated SSE connection lifecycle
 * (GET /api/events): the JWT is verified before the stream is established,
 * so every counted connection belongs to an authenticated client. The raw
 * socket 'close' event is the canonical disconnect signal — it always fires
 * eventually, even for silently-dying streams.
 *
 * Only the 0 -> 1 and 1 -> 0 edges are reported: the first client appearing
 * is a WAKE signal (never pairing intent); the last client disappearing may
 * start the runtime shutdown grace. One tab closing must never shut down
 * WhatsApp while another client remains.
 */
import { getLogger } from '../logging/logger.js';

export interface ClientPresenceCallbacks {
  onFirstClient: () => void;
  onLastClient: () => void;
}

export class ClientPresence {
  private readonly callbacks: ClientPresenceCallbacks;
  private _clientCount = 0;

  constructor(callbacks: ClientPresenceCallbacks) {
    this.callbacks = callbacks;
  }

  get clientCount(): number {
    return this._clientCount;
  }

  clientConnected(): void {
    this._clientCount += 1;
    if (this._clientCount === 1) {
      getLogger().info('First frontend client present — client presence began');
      try {
        this.callbacks.onFirstClient();
      } catch (err) {
        getLogger().error(
          { err: err instanceof Error ? err.message : String(err) },
          'First-client callback error',
        );
      }
    } else {
      getLogger().debug(
        { clientCount: this._clientCount },
        'Additional frontend client present',
      );
    }
  }

  clientDisconnected(): void {
    if (this._clientCount === 0) {
      // Idempotent: a disconnect without a matching connect is ignored.
      return;
    }
    this._clientCount -= 1;
    if (this._clientCount === 0) {
      getLogger().info('Last frontend client gone — client presence ended');
      try {
        this.callbacks.onLastClient();
      } catch (err) {
        getLogger().error(
          { err: err instanceof Error ? err.message : String(err) },
          'Last-client callback error',
        );
      }
    }
  }
}
