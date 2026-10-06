/**
 * WhatsApp Service Types — Business-Level Contract
 *
 * This is the permanent contract between the billing application and the
 * WhatsApp Message Delivery Service. It deliberately contains NO reference
 * to Baileys, sockets, Puppeteer, browsers, or any transport implementation.
 *
 * The application sees only business concepts:
 *   - connection state (connected / disconnected / pairing / connecting / error)
 *   - login (start a WhatsApp connection attempt)
 *   - logout (destroy the WhatsApp session)
 *   - send a prepared message (recipient + image + caption)
 *   - QR pairing (display + countdown)
 *   - real-time events (subscribe to state changes)
 *
 * The actual transport (dedicated backend at /backend) is an implementation
 * detail hidden behind the WhatsAppService interface.
 */

// ─── Connection State ─────────────────────────────────────────────────────

/**
 * The WhatsApp session dimension — a SEPARATE axis from the runtime state.
 *   NONE      — no session material (nothing paired; Connect required)
 *   PRESENT   — session material exists (reusable without QR pairing)
 *   RESTORING — a Redis-backup restoration is validating
 *   null      — not yet known (before the first authoritative snapshot)
 */
export type WhatsAppSessionState = 'NONE' | 'PRESENT' | 'RESTORING' | null;

/**
 * The WhatsApp runtime connection state, as seen by the application.
 *
 * These are the ONLY states the UI cares about. They are a closed set —
 * no other state may exist. The backend's runtime + session model is
 * mapped into these by the service adapter:
 *
 *   disconnected — runtime IDLE, session NONE (show Connect)
 *   idle         — runtime IDLE, session PRESENT (configured; wakes on demand)
 *   restoring    — a backed-up session is being restored and validated
 *   connecting   — runtime starting/waking with a session
 *   pairing      — QR is being displayed for scanning
 *   connected    — authenticated and ready to send
 *   reconnecting — transient disconnect, auto-reconnecting
 *   error        — security invalidation or unrecoverable failure
 */
export type WhatsAppConnectionState =
    | 'disconnected'    // runtime IDLE, session NONE
    | 'idle'            // runtime IDLE, session PRESENT (auto-wakeable)
    | 'restoring'       // session restoration in flight
    | 'connecting'      // Login/wake requested, connecting with stored session
    | 'pairing'         // QR is being displayed for scanning
    | 'connected'       // Authenticated and ready to send
    | 'reconnecting'    // Transient disconnect, auto-reconnecting
    | 'error';          // Security invalidation or unrecoverable failure

// ─── Status Snapshot ───────────────────────────────────────────────────────

/**
 * A point-in-time view of the WhatsApp service state.
 *
 * The UI consumes this directly. It is built from backend events by the
 * service adapter — the application never talks to the backend directly.
 */
export interface WhatsAppStatus {
    /** The current runtime connection state. */
    readonly state: WhatsAppConnectionState;
    /** The session dimension (NONE / PRESENT / RESTORING; null = unknown). */
    readonly session: WhatsAppSessionState;
    /** Whether WhatsApp is authenticated and ready to send messages. */
    readonly connected: boolean;
    /** The connected WhatsApp account's phone number (JID), or null. */
    readonly accountId: string | null;
    /** The connected account's display name, or null. */
    readonly accountName: string | null;
    /** The current QR code data URL for pairing, or null if not pairing. */
    readonly qrCode: string | null;
    /** Whether a QR is currently available for scanning. */
    readonly qrAvailable: boolean;
    /** Seconds until the backend refreshes the QR (from backend countdown events). */
    readonly qrExpiresInSeconds: number | null;
    /** ISO timestamp when the backend refreshes the QR (from backend events). */
    readonly qrExpiresAt: string | null;
    /** The last error message, or null if no error. */
    readonly lastError: string | null;
}

// ─── Send Message ──────────────────────────────────────────────────────────

/**
 * An invoice send request.
 *
 * The application references the invoice ONLY by identity — the WhatsApp
 * backend owns everything else (invoice data, recipient, message template,
 * PDF generation, message sending). No invoice rows, totals, recipients, captions,
 * images, or binaries ever travel through the frontend.
 */
export interface WhatsAppMessage {
    /** The invoice UUID. */
    readonly invoiceId: string;
    /** The invoice type: sale | purchase | proforma. */
    readonly invoiceType: 'sale' | 'purchase' | 'proforma';
    /** Optional tracing identifier. */
    readonly requestId?: string;
}

/**
 * The result of a send operation.
 */
export interface WhatsAppSendResult {
    /** Whether the message was delivered successfully. */
    readonly ok: boolean;
    /** The message ID from WhatsApp on success. */
    readonly messageId?: string;
    /** A machine-readable error code on failure. */
    readonly error?: string;
    /** A human-readable error detail on failure. */
    readonly detail?: string;
}

// ─── Real-Time Events ──────────────────────────────────────────────────────

/**
 * The types of real-time events the WhatsApp service emits.
 *
 * These are business-level events — no transport details.
 * The UI subscribes to these via the service's subscribe() method.
 */
export type WhatsAppEventType =
    | 'state-changed'      // Connection state changed
    | 'qr-available'      // A new QR code is available for scanning
    | 'qr-countdown'      // QR countdown tick (seconds remaining)
    | 'send-result'        // A send operation completed
    | 'job-result'         // A durable message job settled (auto-send / reminder / receipt)
    | 'security-event';    // A security event occurred

/**
 * A real-time event envelope.
 */
export interface WhatsAppEvent {
    readonly type: WhatsAppEventType;
    readonly timestamp: string;
    readonly data: Record<string, unknown>;
}

// ─── Service Contract ──────────────────────────────────────────────────────

/**
 * The WhatsApp Message Delivery Service.
 *
 * This is the ONLY interface the application uses to interact with WhatsApp.
 * It exposes business-level capabilities and hides all transport details.
 *
 * The application must NOT:
 *   - know that the backend uses Baileys
 *   - know the backend's HTTP API paths
 *   - know about sockets, browsers, or Puppeteer
 *   - manage WhatsApp session storage
 *   - manage QR generation or refresh timing
 */
export interface WhatsAppService {
    /**
     * Send a prepared WhatsApp message (image + optional caption).
     * The recipient is normalized and validated by the backend.
     */
    sendMessage(message: WhatsAppMessage): Promise<WhatsAppSendResult>;

    /**
     * Start a WhatsApp login attempt.
     * This is the ONLY way to start WhatsApp. The service (backend) owns
     * the complete connection lifecycle — QR generation, pairing, auth.
     *
     * Idempotent: calling login while already connecting/pairing/connected
     * does NOT start a second connection.
     *
     * The backend refreshes the QR every 60 seconds while pairing; there is
     * no frontend- or backend-imposed login deadline — the pairing flow
     * stays active until authentication succeeds, the server stops, or the
     * connection genuinely fails.
     */
    login(): Promise<void>;

    /**
     * Log out and destroy the WhatsApp session.
     * After logout, the state is 'disconnected' and WhatsApp is OFF.
     * The user must call login() to reconnect.
     */
    logout(): Promise<void>;

    /**
     * Get the current status snapshot.
     */
    getStatus(): WhatsAppStatus;

    /**
     * Fetch the latest status from the backend and update the cache.
     * Concurrent calls are deduplicated. Route handlers await this before
     * responding so the snapshot is never stale (realtime safety net for
     * the moments when the SSE stream is (re)connecting).
     */
    refreshStatus(): Promise<void>;

    /**
     * Subscribe to real-time events.
     * Returns an unsubscribe function.
     * The UI uses this for live state updates (no polling).
     */
    subscribe(listener: (event: WhatsAppEvent) => void): () => void;
}

// ─── Event Listener Type ───────────────────────────────────────────────────

export type WhatsAppEventListener = (event: WhatsAppEvent) => void;
