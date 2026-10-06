/**
 * WhatsApp Frontend State — the ONE event→state normalizer.
 *
 * Every state transition in the browser (and the server-side service cache)
 * goes through this module. It defines, in one place:
 *
 *   - which event types affect status,
 *   - how each event payload maps onto WhatsAppStatus fields,
 *   - the QR freshness rule (a QR is only replaced by an equal-or-newer
 *     QR generation, identified by its `expiresAt`),
 *   - and QR clearing when the connection leaves the pairing state.
 *
 * Event data shapes (all payloads are JSON objects delivered by the SSE
 * bridge as named events):
 *
 *   state-changed  { state, prevState }                      — live backend
 *                  OR a full WhatsAppStatus snapshot          — bridge initial
 *   qr-available   { qr, expiresInSeconds, expiresAt }
 *   qr-countdown   { remainingSeconds, expiresAt }
 *   security-event { code, reason }
 *   send-result    (does not affect connection status)
 *
 * The function returns the SAME object reference when nothing changed, so
 * React state updates bail out without re-rendering.
 */
import type { WhatsAppConnectionState, WhatsAppStatus } from './types';

// ─── Default ────────────────────────────────────────────────────────────────

/** The status before any event arrives (module-scope constant: stable identity). */
export const DEFAULT_WHATSAPP_STATUS: WhatsAppStatus = {
    state: 'disconnected',
    session: null,
    connected: false,
    accountId: null,
    accountName: null,
    qrCode: null,
    qrAvailable: false,
    qrExpiresInSeconds: null,
    qrExpiresAt: null,
    lastError: null,
};

// ─── State mapping ──────────────────────────────────────────────────────────

/**
 * Map a backend runtime state (+ session dimension) to the application's
 * business state.
 *
 * Accepts BOTH forms that reach this boundary:
 *   - raw backend states (uppercase): STARTING, IDLE, PAIRING, CONNECTING,
 *     CONNECTED, RECONNECTING, LOGGING_OUT, SECURITY_INVALIDATED, STOPPING —
 *     from live WHATSAPP_STATE_CHANGED events forwarded verbatim from the
 *     backend envelope (optionally carrying `session`).
 *   - business states (lowercase): disconnected, idle, restoring, connecting,
 *     pairing, connected, reconnecting, error — from full-status snapshots.
 *
 * The runtime/session pair is the source of the two distinct "off" states:
 *   IDLE + session PRESENT  → 'idle'      (configured; auto-wake on demand)
 *   IDLE + session NONE     → 'disconnected' (nothing paired; Connect button)
 * and the restoring case:
 *   CONNECTING + session RESTORING → 'restoring' (backup being validated)
 */
export function mapBackendState(
    backendState: string | undefined,
    session?: unknown,
): WhatsAppConnectionState | null {
    if (!backendState) return null;
    const sessionState =
        session === 'NONE' || session === 'PRESENT' || session === 'RESTORING' ? session : undefined;
    switch (backendState) {
        case 'IDLE':
            // A stored session makes the sleeping runtime wake-able; without
            // one there is nothing to wake — the Connect action applies.
            return sessionState === 'PRESENT' || sessionState === 'RESTORING'
                ? 'idle'
                : 'disconnected';
        case 'CONNECTING': case 'connecting':
            return sessionState === 'RESTORING' ? 'restoring' : 'connecting';
        case 'PAIRING': case 'pairing': return 'pairing';
        case 'CONNECTED': case 'connected': return 'connected';
        case 'RECONNECTING': case 'reconnecting': return 'reconnecting';
        case 'SECURITY_INVALIDATED': case 'error': return 'error';
        case 'idle': return 'idle';
        case 'restoring': return 'restoring';
        case 'LOGGING_OUT':
        case 'LOGGED_OUT': // legacy pre-redesign wire value — safe fallback
        case 'STARTING':
        case 'STOPPING':
        case 'disconnected':
        default:
            return 'disconnected';
    }
}

// ─── QR freshness ───────────────────────────────────────────────────────────

/**
 * Parse an ISO timestamp; returns null when unparseable.
 * (Backend timestamps are `new Date().toISOString()` — always parseable —
 * but the guard keeps malformed payloads from winning by accident.)
 */
function parseIso(value: unknown): number | null {
    if (typeof value !== 'string' || value.length === 0) return null;
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : ms;
}

/**
 * Whether an incoming QR generation (by its expiresAt) may replace the
 * current QR. A QR is replaced only by an EQUAL-OR-NEWER generation:
 * a delayed event from an older QR generation (possible across SSE
 * reconnects, where two connections briefly overlap) must never
 * overwrite a newer QR. Used for LIVE qr-available events, which always
 * carry their expiresAt.
 */
function isFreshQr(current: WhatsAppStatus, incomingExpiresAt: unknown): boolean {
    const incoming = parseIso(incomingExpiresAt);
    if (incoming === null) return false;
    const currentMs = parseIso(current.qrExpiresAt);
    if (currentMs === null) return true; // no current QR timestamp → accept
    return incoming >= currentMs;
}

/**
 * Whether a SNAPSHOT's QR (from the backend's current-status REST response
 * or the bridge's initial event) may replace the current QR.
 *
 * Snapshots are authoritative CURRENT backend state: the backend only ever
 * holds its latest QR, so a snapshot QR is never older than what a live
 * event delivered. The REST status, however, does not carry the QR's
 * expiry — a snapshot without expiry information is therefore accepted.
 * A snapshot that DOES carry an expiry older than the held QR's (only
 * possible for a stale in-flight fetch) is rejected.
 */
function snapshotQrAllowed(current: WhatsAppStatus, incomingExpiresAt: unknown): boolean {
    const incoming = parseIso(incomingExpiresAt);
    const currentMs = parseIso(current.qrExpiresAt);
    if (incoming !== null && currentMs !== null) return incoming >= currentMs;
    return true; // no expiry known on one side — snapshot is authoritative
}

// ─── Event appliers (pure) ──────────────────────────────────────────────────

/**
 * state-changed — connection state transition.
 *
 * Handles BOTH live backend events ({state, prevState} — QR untouched) and
 * full-status snapshots (which may also carry accountId/QR fields — every
 * present field is applied).
 *
 * QR RULE: when the NEW state is not 'pairing', all QR fields are cleared
 * (mirrors the backend: a QR only exists while pairing). When the new state
 * IS 'pairing', the current QR is kept; a QR in the payload is applied via
 * the freshness rule.
 */
export function applyStateEvent(
    status: WhatsAppStatus,
    data: Record<string, unknown>,
): WhatsAppStatus {
    const state = mapBackendState(data.state as string | undefined, data.session);
    if (!state) return status;

    const pairing = state === 'pairing';

    // Optional snapshot fields — only apply what is actually present.
    const optional: {
        accountId?: string | null;
        accountName?: string | null;
        lastError?: string | null;
        session?: WhatsAppStatus['session'];
    } = {};
    if (data.accountId !== undefined) optional.accountId = (data.accountId as string) ?? null;
    if (data.accountName !== undefined) optional.accountName = (data.accountName as string) ?? null;
    if (data.lastError !== undefined) optional.lastError = (data.lastError as string) ?? null;
    if (data.session !== undefined) {
        const s = data.session as string;
        optional.session = s === 'NONE' || s === 'PRESENT' || s === 'RESTORING' ? s : null;
    }

    let next: WhatsAppStatus = {
        ...status,
        ...optional,
        state,
        connected: state === 'connected',
        // Leaving pairing invalidates the QR (it can no longer be scanned).
        qrCode: pairing ? status.qrCode : null,
        qrAvailable: pairing ? status.qrAvailable : false,
        qrExpiresInSeconds: pairing ? status.qrExpiresInSeconds : null,
        qrExpiresAt: pairing ? status.qrExpiresAt : null,
    };

    // A snapshot carrying a QR (bridge initial event / REST status).
    // Snapshot QRs are authoritative current state — accepted even without
    // expiry info (the REST status doesn't expose it); rejected only when
    // provably older than the held QR.
    if (pairing && typeof data.qrCode === 'string' && data.qrCode.length > 0) {
        if (snapshotQrAllowed(status, data.qrExpiresAt)) {
            next = {
                ...next,
                qrCode: data.qrCode,
                qrAvailable: true,
                qrExpiresInSeconds:
                    typeof data.qrExpiresInSeconds === 'number' ? data.qrExpiresInSeconds : null,
                qrExpiresAt: typeof data.qrExpiresAt === 'string' ? data.qrExpiresAt : null,
            };
        }
    } else if (pairing && data.qrAvailable === false) {
        // Snapshot explicitly says no QR while pairing (e.g. between QR
        // generations) — only clear when no fresher QR is held.
        if (!status.qrExpiresAt) {
            next = { ...next, qrCode: null, qrAvailable: false, qrExpiresInSeconds: null, qrExpiresAt: null };
        }
    }

    return next;
}

/**
 * qr-available — a NEW QR generation was emitted by the backend.
 * Replaces the current QR immediately, guarded by the freshness rule.
 * Sets state to 'pairing' (the backend is displaying a QR).
 */
export function applyQrAvailable(
    status: WhatsAppStatus,
    data: Record<string, unknown>,
): WhatsAppStatus {
    const qr = data.qr;
    if (typeof qr !== 'string' || qr.length === 0) return status;
    if (!isFreshQr(status, data.expiresAt)) return status; // stale generation — reject

    return {
        ...status,
        state: 'pairing',
        qrCode: qr,
        qrAvailable: true,
        qrExpiresInSeconds: typeof data.expiresInSeconds === 'number' ? data.expiresInSeconds : null,
        qrExpiresAt: typeof data.expiresAt === 'string' ? data.expiresAt : null,
    };
}

/**
 * qr-countdown — the backend-owned countdown tick for the CURRENT QR.
 * Updates the countdown only; never touches the QR image or the state.
 * Countdowns belonging to an older QR generation are rejected.
 */
export function applyQrCountdown(
    status: WhatsAppStatus,
    data: Record<string, unknown>,
): WhatsAppStatus {
    if (typeof data.remainingSeconds !== 'number') return status;
    // A countdown only exists while a QR lifecycle is active — i.e. while
    // pairing. A countdown arriving once the connection state is KNOWN to
    // be something else (e.g. a stale pairing timer leaking past a
    // successful scan) must not pollute the status. The pristine default
    // status is exempt: the stream can legitimately deliver countdown
    // events before the first state event/snapshot lands (connecting
    // mid-pairing); the pairing state itself arrives within moments.
    if (status.state !== 'pairing' && status !== DEFAULT_WHATSAPP_STATUS) return status;
    // A countdown for an older QR generation must not overwrite a newer QR.
    const incoming = parseIso(data.expiresAt);
    if (incoming === null) return status;
    const currentMs = parseIso(status.qrExpiresAt);
    if (currentMs !== null && incoming < currentMs) return status;

    return {
        ...status,
        qrExpiresInSeconds: data.remainingSeconds,
        qrExpiresAt: typeof data.expiresAt === 'string' ? data.expiresAt : status.qrExpiresAt,
    };
}

/**
 * security-event — a security invalidation. Sets the error state and
 * clears the QR (the pairing session is dead).
 */
export function applySecurityEvent(
    status: WhatsAppStatus,
    data: Record<string, unknown>,
): WhatsAppStatus {
    return {
        ...status,
        state: 'error',
        connected: false,
        lastError: typeof data.reason === 'string' ? data.reason : 'Security event',
        qrCode: null,
        qrAvailable: false,
        qrExpiresInSeconds: null,
        qrExpiresAt: null,
    };
}

// ─── The single entry point ─────────────────────────────────────────────────

/**
 * Apply one normalized WhatsApp event to a status.
 *
 * @param status the current status (null seeds the default)
 * @param type   the bridge event name ('state-changed' | 'qr-available' |
 *               'qr-countdown' | 'security-event')
 * @param data   the parsed event payload
 * @returns the next status — the SAME reference when the event changes
 *          nothing (lets React bail out of the re-render).
 */
export function applyWhatsAppEvent(
    status: WhatsAppStatus | null,
    type: string,
    data: unknown,
): WhatsAppStatus {
    const base = status ?? DEFAULT_WHATSAPP_STATUS;
    if (!data || typeof data !== 'object') return base;

    const payload = data as Record<string, unknown>;
    switch (type) {
        case 'state-changed': return applyStateEvent(base, payload);
        case 'qr-available': return applyQrAvailable(base, payload);
        case 'qr-countdown': return applyQrCountdown(base, payload);
        case 'security-event': return applySecurityEvent(base, payload);
        default: return base; // send-result / job-result and unknown types don't affect status
    }
}
