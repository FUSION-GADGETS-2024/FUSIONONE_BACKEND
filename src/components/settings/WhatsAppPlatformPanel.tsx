'use client';

import { useState } from 'react';
import { CheckCircle2, Loader2, LogOut, MessageCircle, MoonStar, RefreshCw, Smartphone, TriangleAlert, Wifi } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import { cn } from '@/components/ui/utils';
import { useSkeletonDelay } from '@/components/ui/Skeleton';
import { useWhatsAppPlatformContext } from '@/features/whatsapp/WhatsAppPlatformContext';
import { useSession } from '@/components/providers/SessionProvider';
import { postLogin, postLogout } from '@/platform/whatsapp/http';
import type { WhatsAppStatus } from '@/platform/whatsapp/types';

// ─── Human-facing account representation ───────────────────────────────────

/**
 * Format the connected WhatsApp account as a human-readable phone number.
 *
 * The backend reports the account as its WhatsApp JID
 * (`<digits>[:<device>]@s.whatsapp.net`). The JID is internal state — it is
 * NEVER rendered. This helper derives the subscriber number and presents it
 * in the standard Indian mobile layout (the backend's account/recipient
 * normalization is India-only: CC 91 + 10 digits).
 *
 * Returns null when the JID cannot be confidently formatted — the caller
 * then shows a neutral "connected" line instead of raw internals.
 */
export function formatWhatsAppAccountPhone(jid: string | null | undefined): string | null {
    if (!jid) return null;
    // Local part before '@', device suffix (":54") stripped.
    const local = jid.split('@')[0]?.split(':')[0] ?? '';
    if (!/^\d{10,15}$/.test(local)) return null;
    if (local.length === 12 && local.startsWith('91')) {
        const subscriber = local.slice(2);
        return `+91 ${subscriber.slice(0, 5)} ${subscriber.slice(5)}`;
    }
    return `+${local}`;
}

// ─── Stable shell constants ─────────────────────────────────────────────────

/**
 * Reserved height of the shell's main content region (border-box, i.e.
 * INCLUDING its py-4 padding). Sized for the TALLEST REAL state — the
 * two-line centered status blocks (icon + status line + hint line,
 * ~73px) — so every state transition keeps the panel's outer geometry
 * identical: switching states must feel like the SAME component changing
 * content, never like a different card being mounted.
 *
 * This is NOT a QR-sized reservation. The QR NO LONGER lives here — ALL
 * pairing content (QR image, countdown, scan instructions, cancel action)
 * is owned by the application-level WhatsAppPairingDialog. The card
 * contains persistent account/runtime state ONLY and stays compact in
 * every state — pairing shows a status line pointing at the pairing
 * window, never the QR itself.
 */
const CONTENT_MIN_H = 'min-h-[108px]';

/** Badge presentation per account state — one stable slot in the header. */
interface BadgeStyle {
    label: string;
    className: string;
}

function badgeFor(status: WhatsAppStatus | null): BadgeStyle {
    switch (status?.state) {
        case 'connected':
            return { label: 'Connected', className: 'bg-emerald-50 text-emerald-700' };
        case 'pairing':
            return { label: 'Pairing', className: 'bg-amber-50 text-amber-700' };
        case 'connecting':
            return { label: 'Connecting', className: 'bg-blue-50 text-blue-700' };
        case 'reconnecting':
            return { label: 'Reconnecting', className: 'bg-blue-50 text-blue-700' };
        case 'restoring':
            return { label: 'Restoring', className: 'bg-blue-50 text-blue-700' };
        case 'idle':
            return { label: 'Session saved', className: 'bg-teal-50 text-teal-700' };
        case 'error':
            return { label: 'Error', className: 'bg-rose-50 text-rose-700' };
        case 'disconnected':
            return { label: 'Not connected', className: 'bg-slate-100 text-slate-600' };
        default:
            return { label: 'Loading', className: 'bg-slate-100 text-slate-500' };
    }
}

/**
 * WhatsApp Platform Panel — purely event-driven, rendered inside ONE
 * invariant shell.
 *
 * SHELL GEOMETRY (identical for every state — loading, disconnected, idle,
 * restoring, connecting, pairing, connected, error):
 *
 *   ┌──────────────────────────────────────────────────┐
 *   │ header: icon · "Connection" · [sync chip] · badge │  fixed height
 *   ├──────────────────────────────────────────────────┤
 *   │ content region (compact, reserved only for the  │  min-h-[108px]
 *   │ tallest real state, vertically centered)        │
 *   ├──────────────────────────────────────────────────┤
 *   │ action footer: the state's action, right-aligned  │  fixed height
 *   └──────────────────────────────────────────────────┘
 *
 * Switching states therefore NEVER resizes the card: it is the same
 * component changing content, not different cards being mounted.
 *
 * A PURE CONSUMER of the application-scope WhatsApp state
 * (useWhatsAppPlatformContext — the ONE global SSE lifecycle observer
 * mounted by the app shell). The panel NEVER mounts its own SSE
 * connection, NEVER polls, NEVER sets intervals, and NEVER touches the
 * WhatsApp transport directly. It renders the shared state's three axes:
 *
 *   - hydration (status === null): the first authoritative snapshot has not
 *     been applied yet → the shell renders with a skeleton mirroring the
 *     final geometry. Never 'disconnected', never a fabricated QR.
 *   - transport (connecting/open/reconnecting): the SSE stream's own health,
 *     shown as a subtle non-blocking "Syncing…" chip. A reconnecting stream
 *     is NEVER rendered as 'disconnected'.
 *   - account state: 'disconnected' can only ever come from an authoritative
 *     backend event/snapshot. A live 'connected' transition without the JID
 *     shows a transient completing state until the identity snapshot lands.
 *
 * States (content inside the shell — persistent account/runtime state ONLY):
 *   - disconnected: runtime IDLE, no session. "WhatsApp isn't connected."
 *   - idle:         runtime IDLE, session configured — the BACKEND wakes
 *                   the connection automatically (client presence is the
 *                   wake signal); the panel is a pure observer and shows
 *                   the waking state. Connect stays available as the
 *                   manual escape hatch.
 *   - restoring:    session recovery — a connecting state, never disconnected.
 *   - connecting / reconnecting: establishing the connection.
 *   - pairing:      pairing status ONLY — the QR, its countdown, and the
 *                   cancel action live in the WhatsAppPairingDialog (the
 *                   card never reserves QR height).
 *   - connected:    human-readable account info (formatted phone number —
 *                   the raw WhatsApp JID is internal state, never rendered).
 *   - error:        security failure / unrecoverable error — visually
 *                   distinct (rose) and retryable.
 *
 * REALTIME BEHAVIOR (unchanged):
 *   - QR/countdown updates arrive via SSE and render in the DIALOG.
 *   - "Connect" uses the backend's idempotent POST /api/whatsapp/login.
 */
export function WhatsAppPlatformPanel() {
    const { success, error } = useToast();
    const { status: snap, transport, syncing } = useWhatsAppPlatformContext();
    // Connection management (pairing / logout) is OWNER-ONLY backend policy;
    // the shared runtime stays observable for every authorized user.
    const { isOwner } = useSession();
    const [busy, setBusy] = useState(false);
    // Loading threshold: the shell renders immediately with the final
    // geometry; the skeleton's subtle pulse only starts if the first
    // snapshot is genuinely slow (same visual rule as every other surface).
    const hydrationPulsing = useSkeletonDelay(!snap);

    // ─── Connect / Login ──────────────────────────────────────────────
    // Calls the backend's existing POST /api/whatsapp/login capability.
    // This is the ONLY way to start pairing — the backend owns the
    // lifecycle. The backend wakes an existing session automatically when
    // this client is present (SSE presence); this button exists for the
    // no-session case and as the manual escape hatch.
    const connect = async () => {
        setBusy(true);
        try {
            await postLogin();
            success('Connecting', 'WhatsApp login started. Scan the QR code when it appears.');
            // The backend will push the QR + state via SSE — no manual refresh needed.
        } catch (cause) {
            error('Connection failed', cause instanceof Error ? cause.message : undefined);
        } finally {
            setBusy(false);
        }
    };

    // NOTE: no frontend auto-wake. The BACKEND owns the automatic wake: the
    // authenticated SSE stream IS the client-presence signal, and the
    // backend wakes an existing session on the first client appearing —
    // never pairing (client presence is not pairing intent). The panel
    // remains a pure observer of the backend-driven lifecycle.

    // NOTE: no QR handling here. ALL pairing content (QR image, countdown,
    // scan instructions, Refresh QR, Cancel) lives in the application-level
    // WhatsAppPairingDialog — the Connection card stays compact and
    // structurally stable.

    // ─── Logout ──────────────────────────────────────────────────────
    const logout = async () => {
        setBusy(true);
        try {
            await postLogout();
            success('Logged out', 'WhatsApp session destroyed.');
        } catch (cause) {
            error('Logout failed', cause instanceof Error ? cause.message : undefined);
        } finally {
            setBusy(false);
        }
    };

    // ─── Derived state ────────────────────────────────────────────────
    // Hydration: no authoritative snapshot applied yet → skeleton content
    // inside the shell. NOTE: !snap is NOT 'disconnected' — that state may
    // only ever come from an authoritative backend event/snapshot.
    const hydrated = snap != null;
    const connected = snap?.state === 'connected';
    const isPairing = snap?.state === 'pairing';
    const isConnecting = snap?.state === 'connecting' || snap?.state === 'reconnecting';
    const hasError = snap?.state === 'error';
    const isDisconnected = snap?.state === 'disconnected';
    // Session configured but the runtime sleeps: the backend wakes it
    // automatically (client presence). A brief waking state; the manual
    // Connect stays available as the escape hatch if the wake doesn't
    // complete.
    const isIdleWithSession = snap?.state === 'idle';
    const isRestoring = snap?.state === 'restoring';

    // Live 'connected' transitions carry no JID — while the identity
    // snapshot is being fetched, show a transient completing state instead
    // of a partial connected view with empty account lines.
    const completingIdentity = connected && !snap?.accountId && syncing;

    // The realtime transport is re-establishing while the last-known-good
    // account state stays on screen — a subtle, non-blocking indicator.
    const transportSyncing = hydrated && transport !== 'open';

    // Human-facing status — the ONE derivation used by the header badge and
    // the service-state grid (never raw state strings in prominent slots).
    const badge = badgeFor(snap);

    // Human-facing connected account identity: the formatted phone number
    // derived from the internal JID — the JID itself is never rendered.
    const accountPhone = formatWhatsAppAccountPhone(snap?.accountId);

    // ─── The ONE invariant shell ──────────────────────────────────────
    return (
        <div className="space-y-5">
            <div>
                <h2 className="text-sm font-semibold text-slate-900">WhatsApp Account</h2>
                <p className="text-[11px] text-slate-400 mt-0.5">
                    Connection state is pushed live by the backend — no manual refresh needed.
                </p>
            </div>

            {/* ONE invariant card shell — identical outer geometry for every
                state: fixed header row, reserved-height content region
                (sized for the QR block), fixed action footer. */}
            <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
                {/* Header — stable position/height; badge always in the same slot */}
                <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3.5">
                    <div className="flex items-center gap-2">
                        <MessageCircle className="h-3.5 w-3.5 text-indigo-600" />
                        <span className="text-xs font-semibold text-slate-900">Connection</span>
                    </div>
                    <div className="flex items-center gap-2">
                        {transportSyncing && (
                            /* Subtle, non-blocking sync indicator — the transport is
                               re-establishing while the last-known state stays visible. */
                            <span
                                className="inline-flex items-center gap-1.5 rounded-full bg-slate-50 px-2 py-1 text-[10px] font-medium text-slate-400 animate-pulse"
                                role="status"
                            >
                                <span className="h-1.5 w-1.5 rounded-full bg-slate-400" aria-hidden="true" />
                                <span className="sr-only">Realtime link re-establishing — </span>
                                Syncing…
                            </span>
                        )}
                        <span
                            aria-label="Connection status"
                            className={cn(
                                'rounded-full px-2 py-1 text-[10px] font-bold',
                                badge.className,
                            )}
                        >
                            {badge.label}
                        </span>
                    </div>
                </div>

                {/* Main content region — compact, reserved only for the
                    tallest REAL state (the two-line status blocks); every
                    state renders centered inside the SAME region, so
                    transitions never resize the panel. NO QR CONTENT EVER
                    and NO QR-sized reservation: the QR, its countdown, and
                    the cancel action live in the application-level
                    WhatsAppPairingDialog. */}
                <div
                    data-testid="connection-card-content"
                    className={cn('flex items-center justify-center px-5 py-4', CONTENT_MIN_H)}
                >
                    {!hydrated ? (
                        /* Initial hydration — the first authoritative snapshot has
                           not been applied yet. A skeleton mirroring the FINAL
                           panel geometry (account row: avatar + two lines), inside
                           the same shell. Never 'disconnected', never a fabricated
                           QR, never a fake footer action. */
                        <div
                            className={cn('flex w-full items-center gap-4', hydrationPulsing && 'animate-pulse')}
                            role="status"
                        >
                            <span className="sr-only">Loading WhatsApp state…</span>
                            <div className="h-12 w-12 rounded-full bg-slate-200" aria-hidden="true" />
                            <div className="flex-1 space-y-2.5" aria-hidden="true">
                                <div className="h-3 w-40 rounded bg-slate-200" />
                                <div className="h-2.5 w-56 rounded bg-slate-100" />
                            </div>
                            <div className="h-5 w-5 rounded-full bg-slate-100" aria-hidden="true" />
                        </div>
                    ) : completingIdentity ? (
                        /* Connected, but the live event carried no JID — the identity
                           snapshot is in flight. Never a partial connected view. */
                        <div className="text-center" role="status">
                            <Loader2 className="mx-auto h-7 w-7 text-emerald-500 animate-spin" />
                            <p className="mt-2 text-xs text-slate-500">
                                Connected — fetching account details…
                            </p>
                        </div>
                    ) : connected ? (
                        /* Connected — human-readable account representation. The raw
                           WhatsApp JID is internal state and is NEVER displayed; the
                           phone number is formatted from it. */
                        <div className="flex w-full items-center gap-4">
                            <div className="h-12 w-12 overflow-hidden rounded-full bg-slate-100 flex items-center justify-center">
                                <Smartphone className="h-5 w-5 text-slate-400" />
                            </div>
                            <div className="min-w-0">
                                <p className="text-xs font-semibold text-slate-900">
                                    {snap?.accountName || 'WhatsApp account'}
                                </p>
                                <p className="text-[11px] text-slate-500">
                                    {accountPhone ?? 'Connected and ready'}
                                </p>
                            </div>
                            <CheckCircle2 className="ml-auto h-5 w-5 shrink-0 text-emerald-500" />
                        </div>
                    ) : isRestoring ? (
                        /* A backed-up session is being restored — a connecting
                           state, never a false 'disconnected'. */
                        <div className="text-center" role="status">
                            <Loader2 className="mx-auto h-7 w-7 text-blue-500 animate-spin" />
                            <p className="mt-2 text-xs text-slate-500">
                                Restoring your WhatsApp session…
                            </p>
                            <p className="text-[11px] text-slate-400 mt-1">
                                Recovering the saved connection — no scan needed.
                            </p>
                        </div>
                    ) : isIdleWithSession ? (
                        /* Session configured, runtime asleep: the backend wakes
                           the connection automatically (client presence). */
                        <div className="text-center" role="status">
                            <MoonStar className="mx-auto h-7 w-7 text-teal-500" />
                            <p className="mt-2 text-xs text-slate-500">
                                WhatsApp session is configured — the connection wakes automatically.
                            </p>
                            <p className="text-[11px] text-slate-400 mt-1">
                                No scan needed. This takes a few seconds.
                            </p>
                        </div>
                    ) : isConnecting ? (
                        /* Connecting / reconnecting */
                        <div className="text-center">
                            <RefreshCw className="mx-auto h-7 w-7 text-blue-500 animate-spin" />
                            <p className="mt-2 text-xs text-slate-500">
                                {snap?.state === 'reconnecting'
                                    ? 'Reconnecting to WhatsApp…'
                                    : 'Starting WhatsApp connection…'}
                            </p>
                        </div>
                    ) : isPairing ? (
                        /* Pairing status ONLY — the QR itself (with its
                           countdown, scan instructions, and the cancel
                           action) renders in the WhatsAppPairingDialog at
                           the application level; this card stays compact
                           and never reserves QR height. */
                        <div className="text-center">
                            <Smartphone className="mx-auto h-7 w-7 text-amber-400" />
                            <p className="mt-2 text-xs text-slate-500">
                                Pairing in progress — the QR code is shown in the pairing window.
                            </p>
                            <p className="text-[11px] text-slate-400 mt-1">
                                Scan it from the pairing window. Leaving this page keeps the
                                pairing alive.
                            </p>
                        </div>
                    ) : hasError ? (
                        /* Error / security-invalidated state — visually distinct
                           (rose) and retryable; never collapsed into a generic
                           'disconnected'. */
                        <div className="text-center">
                            <TriangleAlert className="mx-auto h-7 w-7 text-rose-400" />
                            <p className="mt-2 text-xs text-slate-500 max-w-sm mx-auto">
                                {snap?.lastError || 'WhatsApp connection error. Click connect to retry.'}
                            </p>
                        </div>
                    ) : (
                        /* Disconnected (runtime IDLE, no session) — clean
                           human-facing state; the primary action lives in the
                           stable action region below. */
                        <div className="text-center">
                            <Wifi className="mx-auto h-7 w-7 text-slate-300" />
                            <p className="mt-2 text-xs text-slate-500">
                                WhatsApp isn&rsquo;t connected.
                            </p>
                            <p className="text-[11px] text-slate-400 mt-1">
                                Connect to start pairing with a QR code.
                            </p>
                        </div>
                    )}
                </div>

                {/* Action footer — ALWAYS rendered with the same height; the
                    current state's action occupies the stable right-aligned
                    slot (no action while loading/connecting — the bar simply
                    stays empty at the same size). */}
                <div
                    role="group"
                    aria-label="Account actions"
                    className="flex min-h-[58px] items-center justify-end gap-2 border-t border-slate-100 bg-slate-50/50 px-5 py-3"
                >
                    {/* Connect — shown when disconnected, error, or idle
                        (the backend owns the automatic wake; this is the
                        manual escape hatch / explicit pairing entry point).
                        Owner-only: connecting the SHARED WhatsApp account is
                        store-level configuration. */}
                    {isOwner && (isDisconnected || hasError || isIdleWithSession) && (
                        <Button
                            size="sm"
                            onClick={connect}
                            disabled={busy}
                            className="gap-1.5 text-xs bg-indigo-600 hover:bg-indigo-700"
                        >
                            {busy ? (
                                <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                                <Wifi className="h-3.5 w-3.5" />
                            )}
                            Connect WhatsApp
                        </Button>
                    )}

                    {/* Logout — shown when connected. Owner-only: destroying
                        the SHARED session is store-level configuration. */}
                    {isOwner && connected && (
                        <Button
                            size="sm"
                            variant="outline"
                            onClick={logout}
                            disabled={busy}
                            className="gap-1.5 text-xs text-rose-600"
                        >
                            <LogOut className="h-3.5 w-3.5" />
                            Logout
                        </Button>
                    )}
                </div>
            </div>

            {/* Service state — from SSE (stable 4-card grid; human labels) */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {[
                    ['State', badge.label],
                    ['Connected', snap?.connected ? 'YES' : 'NO'],
                    ['QR Available', snap?.qrAvailable ? 'YES' : 'NO'],
                    ['Service', snap ? 'active' : '—'],
                ].map(([title, value]) => (
                    <div key={title} className="rounded-xl border border-slate-200 bg-white p-3">
                        <p className="text-[9px] font-bold uppercase tracking-wider text-slate-400">{title}</p>
                        <p className="mt-1 text-xs font-semibold text-slate-700">{value}</p>
                    </div>
                ))}
            </div>
        </div>
    );
}
