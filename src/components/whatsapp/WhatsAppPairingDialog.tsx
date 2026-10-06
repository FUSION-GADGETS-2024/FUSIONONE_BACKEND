'use client';

import { useState } from 'react';
import { Loader2, MessageCircle, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import { cn } from '@/components/ui/utils';
import { useWhatsAppPlatformContext } from '@/features/whatsapp/WhatsAppPlatformContext';
import { postCancelPairing, postLogin } from '@/platform/whatsapp/http';

/**
 * WhatsApp Pairing Dialog — the ONE surface that owns the QR.
 *
 * The persistent WhatsApp Connection card in Settings no longer contains
 * the QR, its container, a reserved QR height, or the countdown layout —
 * the card stays compact and structurally stable, and ALL pairing content
 * lives in this dialog.
 *
 * DRIVEN ENTIRELY BY THE EXISTING BACKEND LIFECYCLE + SSE STATE (the
 * application-scope WhatsApp state from useWhatsAppPlatformContext):
 *   - open iff the backend state is PAIRING (unhydrated → closed)
 *   - the QR image and the countdown come from WHATSAPP_QR_AVAILABLE /
 *     WHATSAPP_QR_COUNTDOWN events (and the REST snapshot's lifecycle
 *     fields) — the frontend NEVER generates a QR and NEVER polls
 *   - a QR refresh (backend rotation) updates the SAME dialog in place
 *   - the dialog closes AUTOMATICALLY the moment pairing ends: a
 *     successful scan (CONNECTING → CONNECTED), a terminal failure, or a
 *     cancellation — no stale QR ever remains visible, and no manual
 *     closure is required after a successful scan
 *
 * DIALOG OWNERSHIP: the dialog is NOT owned by the WhatsApp panel's
 * lifecycle. It consumes the APPLICATION-LEVEL WhatsApp state, so
 * navigating away from Settings, the panel unmounting, or the SSE stream
 * temporarily reconnecting NEVER cancels the pairing — only the explicit
 * user action below does.
 *
 * DIALOG GEOMETRY (invariant from the FIRST render — before the QR
 * exists, while it is displayed, and across every refresh):
 *
 *   ┌──────────────────────────────────────┐
 *   │ header: title + description     [X]  │  fixed
 *   ├──────────────────────────────────────┤
 *   │ ┌──────────────────────────────────┐ │
 *   │ │ FIXED QR SLOT (240 × 240)        │ │  ← placeholder OR QR image,
 *   │ │ placeholder → QR #1 → QR #2 → …  │ │    always the SAME region
 *   │ └──────────────────────────────────┘ │
 *   │ countdown/status line (fixed height) │  ← text swaps, box never moves
 *   │ scan instructions (always rendered)  │
 *   │ background-pairing note              │
 *   ├──────────────────────────────────────┤
 *   │ footer: [Refresh QR] [Cancel]        │  fixed
 *   └──────────────────────────────────────┘
 *
 * The QR image's INTRINSIC dimensions never determine the dialog height:
 * it is contained inside the fixed slot (object-contain). The countdown
 * area is always rendered at a fixed height, so the countdown appearing,
 * disappearing, or changing its text — and every QR refresh — swaps
 * content inside the SAME boxes without moving the buttons or resizing
 * the dialog.
 *
 * CLOSE/CANCEL SEMANTICS (required): X, Close, and Cancel all mean "I no
 * longer want to pair this WhatsApp account" — the action REQUESTS THE
 * BACKEND PAIRING-CANCEL OPERATION (POST /api/whatsapp/cancelPairing),
 * which stops the pairing runtime, discards unvalidated residue, and
 * converges to IDLE + NONE. It must NEVER merely hide the dialog, never
 * log out, and never destroy an already-validated session (the backend
 * resolves the cancel-vs-scan race by state). While the cancel request is
 * in flight the dialog stays open in a cancelling state; a FAILED request
 * keeps the dialog open (the pairing is still active) and surfaces the
 * error. The dialog then closes through the backend's state change —
 * the SSE state event (or the reconnect's authoritative snapshot).
 */
export function WhatsAppPairingDialog() {
    const { error } = useToast();
    const { status } = useWhatsAppPlatformContext();
    const [cancelling, setCancelling] = useState(false);
    const [refreshing, setRefreshing] = useState(false);

    // Open iff the backend is actively pairing. Hydration-null (no
    // authoritative snapshot yet) never opens the dialog — a fabricated
    // pairing state must not appear.
    const open = status?.state === 'pairing';

    // QR lifecycle — entirely from the shared backend-driven state.
    const qrCode = open ? status.qrCode : null;
    const qrRemaining = open ? status.qrExpiresInSeconds : null;
    const qrExpiring = qrRemaining !== null && qrRemaining <= 5;

    // Reset the action latch whenever the dialog (re)closes or (re)opens —
    // a fresh pairing attempt (e.g. the user presses Connect again) begins
    // with a clean cancelling state.
    const [wasOpen, setWasOpen] = useState(false);
    if (open && !wasOpen) {
        setWasOpen(true);
        if (cancelling) setCancelling(false);
    } else if (!open && wasOpen) {
        setWasOpen(false);
        if (cancelling) setCancelling(false);
    }

    // The explicit cancel action. Requests the backend operation; the
    // dialog itself closes only when the backend state leaves PAIRING.
    const requestCancel = async () => {
        if (cancelling) return;
        setCancelling(true);
        try {
            await postCancelPairing();
            // The backend has converged (IDLE + NONE); the SSE state event
            // (or the reconnect snapshot) closes the dialog. Keep the
            // cancelling presentation until then — the dialog is a
            // transient representation of BACKEND state, never local
            // wishful thinking.
        } catch (cause) {
            // The cancel did not reach the backend — the pairing is still
            // active. Keep the dialog open and surface the failure.
            setCancelling(false);
            error('Cancel failed', cause instanceof Error ? cause.message : undefined);
        }
    };

    // Refresh QR — the backend's existing idempotent login operation. The
    // new QR arrives via WHATSAPP_QR_AVAILABLE; the UI never fabricates it.
    const refreshQr = async () => {
        setRefreshing(true);
        try {
            await postLogin();
        } catch (cause) {
            error('QR refresh failed', cause instanceof Error ? cause.message : undefined);
        } finally {
            setRefreshing(false);
        }
    };

    return (
        <Modal
            isOpen={open}
            onClose={requestCancel}
            title="Pair WhatsApp"
            description="Scan the QR code with the WhatsApp account that should send invoices."
            hideClose
            footer={
                <>
                    <Button
                        size="sm"
                        variant="outline"
                        onClick={refreshQr}
                        disabled={cancelling || refreshing || !qrCode}
                        className="gap-1.5 text-xs"
                    >
                        <RefreshCw className={refreshing ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
                        Refresh QR
                    </Button>
                    {/* The shared Button's isLoading keeps this action's
                        geometry stable while cancelling (no inserted spinner,
                        no label swap — same button, busy). */}
                    <Button
                        size="sm"
                        onClick={requestCancel}
                        isLoading={cancelling}
                        className="gap-1.5 text-xs bg-indigo-600 hover:bg-indigo-700"
                    >
                        Cancel pairing
                    </Button>
                </>
            }
        >
            <div className="flex flex-col items-center gap-3 py-2">
                {/* FIXED QR SLOT — the dialog's invariant QR region. The
                    SLOT's own width/height define the area (240 × 240 incl.
                    padding/border); the QR image — whatever its intrinsic
                    dimensions — is CONTAINED inside it, and the pre-QR
                    placeholder occupies the SAME box. The QR appearing, or
                    refreshing (QR #1 → QR #2 → QR #3), can never resize or
                    reflow the dialog: only the content INSIDE the slot
                    changes. */}
                <div
                    role="figure"
                    aria-label="WhatsApp pairing QR code area"
                    data-testid="pairing-qr-slot"
                    className="flex h-60 w-60 items-center justify-center overflow-hidden rounded-lg border border-slate-200 bg-white p-2"
                >
                    {qrCode ? (
                        <img
                            src={qrCode}
                            alt="WhatsApp pairing QR code"
                            className="h-full w-full object-contain"
                        />
                    ) : (
                        /* Pairing started but the QR payload has not arrived
                           yet — the backend pushes it via the next
                           qr-available event. The placeholder lives INSIDE
                           the fixed slot: same region, same dialog size. */
                        <div className="flex flex-col items-center gap-2" role="status">
                            <Loader2 className="h-7 w-7 text-amber-500 animate-spin" />
                            <p className="text-xs text-slate-500">Generating the QR code…</p>
                        </div>
                    )}
                </div>

                {/* STABLE countdown/status line — ALWAYS rendered at a fixed
                    height. The countdown value changing, hitting zero
                    ("Refreshing QR…"), or not being available yet only swaps
                    the TEXT inside the same box; nothing below it (the
                    instructions, the note, the footer buttons) ever moves.
                    Driven by backend WHATSAPP_QR_COUNTDOWN events — the
                    frontend never calculates or enforces expiry itself. */}
                <p
                    aria-live="polite"
                    data-testid="pairing-qr-countdown"
                    className={cn(
                        'flex h-5 items-center text-[11px] font-medium leading-none',
                        qrExpiring ? 'text-rose-600' : 'text-slate-500',
                    )}
                >
                    {qrCode == null
                        ? 'The QR code will appear here.'
                        : qrRemaining === null
                          ? 'Waiting for the refresh countdown…'
                          : qrRemaining === 0
                            ? 'Refreshing QR…'
                            : `Next QR refresh in ${qrRemaining}s`}
                </p>

                {/* Scan instructions — always rendered, with or without the
                    QR, so the layout below the slot is identical in both
                    phases. */}
                <p className="text-[11px] text-slate-500 text-center max-w-xs">
                    Open WhatsApp on your phone → Settings → Linked Devices → Link a Device,
                    then scan this code.
                </p>

                <p className="text-[10px] text-slate-400 text-center max-w-sm flex items-center gap-1.5">
                    <MessageCircle className="h-3 w-3 shrink-0" aria-hidden="true" />
                    Pairing continues in the background — you can leave this page without losing it.
                    Cancelling stops the pairing.
                </p>
            </div>
        </Modal>
    );
}
