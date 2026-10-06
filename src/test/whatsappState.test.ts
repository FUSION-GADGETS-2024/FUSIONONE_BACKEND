/**
 * domains/whatsapp/state.ts — the pure event→status normalizer tests.
 *
 * Covers: state mapping (both payload forms), QR freshness (monotonic
 * expiresAt), stale QR/countdown rejection, QR clearing when leaving
 * pairing, snapshot patch semantics, malformed payload safety, and the
 * same-reference no-op contract (React re-render bailout).
 */
import { describe, it, expect } from 'vitest';
import {
    DEFAULT_WHATSAPP_STATUS,
    mapBackendState,
    applyWhatsAppEvent,
} from '@/platform/whatsapp/state';
import type { WhatsAppStatus } from '@/platform/whatsapp/types';

const T1 = '2026-09-29T10:00:25.000Z';
const T2 = '2026-09-29T10:00:50.000Z';
const T3 = '2026-09-29T10:01:15.000Z';

const withQr = (qr: string, expiresAt: string, seconds = 25): WhatsAppStatus => ({
    ...DEFAULT_WHATSAPP_STATUS,
    state: 'pairing',
    qrCode: qr,
    qrAvailable: true,
    qrExpiresInSeconds: seconds,
    qrExpiresAt: expiresAt,
});

describe('mapBackendState', () => {
    it('maps every raw backend state', () => {
        expect(mapBackendState('PAIRING')).toBe('pairing');
        expect(mapBackendState('CONNECTING')).toBe('connecting');
        expect(mapBackendState('CONNECTED')).toBe('connected');
        expect(mapBackendState('RECONNECTING')).toBe('reconnecting');
        expect(mapBackendState('SECURITY_INVALIDATED')).toBe('error');
        expect(mapBackendState('LOGGED_OUT')).toBe('disconnected'); // legacy wire value
        expect(mapBackendState('IDLE')).toBe('disconnected'); // no session → Connect
        expect(mapBackendState('IDLE', 'PRESENT')).toBe('idle'); // configured → auto-wake
        expect(mapBackendState('CONNECTING', 'RESTORING')).toBe('restoring');
        expect(mapBackendState('CONNECTING')).toBe('connecting');
        expect(mapBackendState('STARTING')).toBe('disconnected');
        expect(mapBackendState('STOPPING')).toBe('disconnected');
        expect(mapBackendState('LOGGING_OUT')).toBe('disconnected');
    });

    it('maps every business state (snapshot payloads)', () => {
        for (const s of ['disconnected', 'connecting', 'pairing', 'connected', 'reconnecting', 'error']) {
            expect(mapBackendState(s)).toBe(s);
        }
    });

    it('returns null for missing/unrecognized states', () => {
        expect(mapBackendState(undefined)).toBeNull();
        expect(mapBackendState('')).toBeNull();
        expect(mapBackendState('running')).toBe('disconnected'); // server lifecycle — NOT a WhatsApp state
    });
});

describe('applyWhatsAppEvent — qr-available', () => {
    it('seeds the default status from null and applies the QR', () => {
        const next = applyWhatsAppEvent(null, 'qr-available', {
            qr: 'data:qr1', expiresInSeconds: 25, expiresAt: T1,
        });
        expect(next.state).toBe('pairing');
        expect(next.qrCode).toBe('data:qr1');
        expect(next.qrAvailable).toBe(true);
        expect(next.qrExpiresInSeconds).toBe(25);
        expect(next.qrExpiresAt).toBe(T1);
    });

    it('replaces an older QR with a newer generation', () => {
        const next = applyWhatsAppEvent(withQr('data:qr1', T1), 'qr-available', {
            qr: 'data:qr2', expiresInSeconds: 25, expiresAt: T2,
        });
        expect(next.qrCode).toBe('data:qr2');
        expect(next.qrExpiresAt).toBe(T2);
    });

    it('rejects a stale generation (older expiresAt)', () => {
        const status = withQr('data:qr2', T2);
        const next = applyWhatsAppEvent(status, 'qr-available', {
            qr: 'data:qr1', expiresInSeconds: 25, expiresAt: T1,
        });
        expect(next).toBe(status); // same reference — nothing changed
        expect(next.qrCode).toBe('data:qr2');
    });

    it('accepts the same generation (idempotent redelivery)', () => {
        const next = applyWhatsAppEvent(withQr('data:qr2', T2), 'qr-available', {
            qr: 'data:qr2b', expiresInSeconds: 20, expiresAt: T2,
        });
        expect(next.qrCode).toBe('data:qr2b');
    });

    it('ignores malformed payloads (missing/empty qr, bad expiresAt)', () => {
        const status = withQr('data:qr1', T1);
        expect(applyWhatsAppEvent(status, 'qr-available', { qr: '', expiresAt: T2 })).toBe(status);
        expect(applyWhatsAppEvent(status, 'qr-available', { qr: 'data:x' })).toBe(status); // no expiresAt
        expect(applyWhatsAppEvent(status, 'qr-available', { qr: 'data:x', expiresAt: 'nonsense' })).toBe(status);
        expect(applyWhatsAppEvent(status, 'qr-available', null)).toBe(status);
        expect(applyWhatsAppEvent(status, 'qr-available', 'string')).toBe(status);
    });
});

describe('applyWhatsAppEvent — qr-countdown', () => {
    it('updates the countdown of the current QR generation', () => {
        const next = applyWhatsAppEvent(withQr('data:qr1', T1), 'qr-countdown', {
            remainingSeconds: 7, expiresAt: T1,
        });
        expect(next.qrExpiresInSeconds).toBe(7);
        expect(next.qrCode).toBe('data:qr1');
        expect(next.state).toBe('pairing');
    });

    it('rejects countdowns from an older QR generation', () => {
        const status = withQr('data:qr2', T2, 25);
        const next = applyWhatsAppEvent(status, 'qr-countdown', {
            remainingSeconds: 3, expiresAt: T1,
        });
        expect(next).toBe(status);
        expect(next.qrExpiresInSeconds).toBe(25);
    });

    it('applies a countdown even before any qr-available (bridge connect mid-pairing)', () => {
        const next = applyWhatsAppEvent(DEFAULT_WHATSAPP_STATUS, 'qr-countdown', {
            remainingSeconds: 12, expiresAt: T1,
        });
        expect(next.qrExpiresInSeconds).toBe(12);
        expect(next.qrExpiresAt).toBe(T1);
        expect(next.qrCode).toBeNull(); // QR itself arrives separately
    });

    it('rejects a countdown once the state is KNOWN to be connected (stale pairing timer)', () => {
        // Regression: a backend bug let the pairing countdown timer keep
        // broadcasting for up to 60s after a successful scan — the frontend
        // must not pollute a connected status with QR countdown fields.
        const connected = applyWhatsAppEvent(withQr('data:qr1', T1), 'state-changed', {
            state: 'CONNECTED', prevState: 'PAIRING', accountId: 'user@s.whatsapp.net',
        });
        expect(connected.state).toBe('connected');

        const next = applyWhatsAppEvent(connected, 'qr-countdown', {
            remainingSeconds: 8, expiresAt: T1,
        });
        expect(next).toBe(connected); // same reference — no-op
        expect(next.qrExpiresInSeconds).toBeNull();
        expect(next.qrExpiresAt).toBeNull();
    });

    it('rejects a countdown after an explicit non-pairing state event (logout)', () => {
        const loggedOut = applyWhatsAppEvent(withQr('data:qr1', T1), 'state-changed', {
            state: 'IDLE', prevState: 'LOGGING_OUT', session: 'NONE',
        });
        expect(loggedOut.state).toBe('disconnected');

        const next = applyWhatsAppEvent(loggedOut, 'qr-countdown', {
            remainingSeconds: 30, expiresAt: T2,
        });
        expect(next).toBe(loggedOut); // same reference — no-op
    });
});

describe('applyWhatsAppEvent — state-changed', () => {
    it('maps live backend state transitions and clears the QR when leaving pairing', () => {
        const next = applyWhatsAppEvent(withQr('data:qr1', T1), 'state-changed', {
            state: 'CONNECTED', prevState: 'PAIRING',
        });
        expect(next.state).toBe('connected');
        expect(next.connected).toBe(true);
        expect(next.qrCode).toBeNull();
        expect(next.qrAvailable).toBe(false);
        expect(next.qrExpiresInSeconds).toBeNull();
        expect(next.qrExpiresAt).toBeNull();
    });

    it('keeps the QR while staying in pairing', () => {
        const status = withQr('data:qr1', T1);
        const next = applyWhatsAppEvent(status, 'state-changed', {
            state: 'PAIRING', prevState: 'PAIRING',
        });
        expect(next.qrCode).toBe('data:qr1');
    });

    it('applies a full-status snapshot (bridge initial event) including the QR', () => {
        const next = applyWhatsAppEvent(DEFAULT_WHATSAPP_STATUS, 'state-changed', {
            state: 'pairing',
            connected: false,
            accountId: null,
            accountName: null,
            qrCode: 'data:qr1',
            qrAvailable: true,
            qrExpiresInSeconds: 25,
            qrExpiresAt: T1,
            lastError: null,
        });
        expect(next.state).toBe('pairing');
        expect(next.qrCode).toBe('data:qr1');
        expect(next.qrExpiresInSeconds).toBe(25);
    });

    it('applies a snapshot QR that carries NO expiry (legacy REST shape)', () => {
        // Older backends' /api/status exposed the QR but not its expiry —
        // the snapshot is authoritative current state and must display.
        const next = applyWhatsAppEvent(DEFAULT_WHATSAPP_STATUS, 'state-changed', {
            state: 'pairing',
            qrCode: 'data:rest-qr',
            qrAvailable: true,
        });
        expect(next.state).toBe('pairing');
        expect(next.qrCode).toBe('data:rest-qr');
        expect(next.qrAvailable).toBe(true);
    });

    it('applies a snapshot QR WITH its countdown — QR + countdown land in one frame', () => {
        // The current backend contract: /api/status carries the FULL QR
        // lifecycle (image + remaining seconds + expiry). A freshly mounted
        // panel therefore renders the QR AND its live countdown immediately,
        // without waiting for the next per-second SSE tick.
        const next = applyWhatsAppEvent(DEFAULT_WHATSAPP_STATUS, 'state-changed', {
            state: 'pairing',
            qrCode: 'data:rest-qr',
            qrAvailable: true,
            qrExpiresInSeconds: 47,
            qrExpiresAt: T2,
        });
        expect(next.state).toBe('pairing');
        expect(next.qrCode).toBe('data:rest-qr');
        expect(next.qrAvailable).toBe(true);
        expect(next.qrExpiresInSeconds).toBe(47);
        expect(next.qrExpiresAt).toBe(T2);
    });

    it('a reconnect snapshot no longer wipes a known countdown (no flicker on reconnect)', () => {
        // Regression: a snapshot WITHOUT expiry fields used to reset
        // qrExpiresInSeconds/qrExpiresAt to null — every SSE reconnect
        // re-snapshot therefore made the countdown text vanish until the
        // next live tick. With the full-lifecycle snapshot the countdown is
        // carried through; a snapshot without the fields (legacy backend)
        // still cannot RESTART a countdown the client never had.
        const live = applyWhatsAppEvent(DEFAULT_WHATSAPP_STATUS, 'qr-available', {
            qr: 'data:qr-live',
            expiresInSeconds: 60,
            expiresAt: T2,
        });
        const resnapshotted = applyWhatsAppEvent(live, 'state-changed', {
            state: 'pairing',
            qrCode: 'data:qr-live',
            qrAvailable: true,
            qrExpiresInSeconds: 41,
            qrExpiresAt: T2,
        });
        expect(resnapshotted.qrExpiresInSeconds).toBe(41); // refreshed, not wiped
        expect(resnapshotted.qrExpiresAt).toBe(T2);
        // The next live countdown tick for the same generation still applies.
        const ticked = applyWhatsAppEvent(resnapshotted, 'qr-countdown', {
            remainingSeconds: 40,
            expiresAt: T2,
        });
        expect(ticked.qrExpiresInSeconds).toBe(40);
    });

    it('snapshot QR without expiry replaces an older held QR (backend current state)', () => {
        const next = applyWhatsAppEvent(withQr('data:qr-old', T1), 'state-changed', {
            state: 'pairing',
            qrCode: 'data:rest-new',
            qrAvailable: true,
        });
        expect(next.qrCode).toBe('data:rest-new');
    });

    it('snapshot QR cannot overwrite a newer held QR', () => {
        const status = withQr('data:qr3', T3);
        const next = applyWhatsAppEvent(status, 'state-changed', {
            state: 'pairing',
            qrCode: 'data:qr1',
            qrExpiresInSeconds: 25,
            qrExpiresAt: T1,
        });
        expect(next.qrCode).toBe('data:qr3');
    });

    it('ignores payloads without a state field', () => {
        const status = withQr('data:qr1', T1);
        expect(applyWhatsAppEvent(status, 'state-changed', { prevState: 'PAIRING' })).toBe(status);
    });
});

describe('applyWhatsAppEvent — security-event', () => {
    it('sets the error state, records the reason, and clears the QR', () => {
        const next = applyWhatsAppEvent(withQr('data:qr1', T1), 'security-event', {
            code: 'SECURITY_SESSION_INVALIDATED', reason: 'session conflict',
        });
        expect(next.state).toBe('error');
        expect(next.connected).toBe(false);
        expect(next.lastError).toBe('session conflict');
        expect(next.qrCode).toBeNull();
    });

    it('uses a fallback reason when missing', () => {
        const next = applyWhatsAppEvent(DEFAULT_WHATSAPP_STATUS, 'security-event', { code: 'X' });
        expect(next.lastError).toBe('Security event');
    });
});

describe('applyWhatsAppEvent — unknown types', () => {
    it('returns the status unchanged for send-result and unknown events', () => {
        const status = withQr('data:qr1', T1);
        expect(applyWhatsAppEvent(status, 'send-result', { requestId: 'r', result: 'success' })).toBe(status);
        expect(applyWhatsAppEvent(status, 'something-new', { any: 'payload' })).toBe(status);
    });
});
