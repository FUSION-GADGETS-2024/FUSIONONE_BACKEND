import { useEffect, useRef, useState } from 'react'
import { applyWhatsAppEvent, DEFAULT_WHATSAPP_STATUS } from '@/platform/whatsapp/state'
import type { WhatsAppEvent, WhatsAppStatus } from '@/platform/whatsapp/types'
import { mapBackendEvent, type MappedBackendEvent, type MessageJobResultEvent } from '@/platform/whatsapp/backend'
import { connectAuthenticatedEventStream, SSE_PAIRING_STALL_TIMEOUT_MS } from '@/platform/whatsapp/sse'
import { fetchBackendStatus } from '@/platform/whatsapp/http'
import { publishMessageJobResult } from '@/platform/whatsapp/message-events'

// ─── View model ─────────────────────────────────────────────────────────────

/**
 * The realtime transport's own health — a SEPARATE axis from the WhatsApp
 * account state. Transport trouble is NEVER equated to 'disconnected':
 * only an authoritative backend event/snapshot may change the account
 * state, so a lost/re-establishing stream always carries the last-known-
 * good account status with it.
 */
export type WhatsAppTransportState =
  | 'connecting' // initial mount: no stream established yet
  | 'open' // a live SSE stream is established
  | 'reconnecting' // stream lost (or first attempt failed); re-establishing

/** What the WhatsApp UI consumes — three independent axes of state. */
export interface WhatsAppPlatformView {
  /**
   * The authoritative WhatsApp account status, built exclusively from
   * backend events/snapshots through the single normalizer.
   *
   * Null until the FIRST authoritative snapshot/event has been applied
   * (initial hydration). While null, the UI shows a loading skeleton —
   * never a 'disconnected' state and never a fabricated QR.
   */
  status: WhatsAppStatus | null
  /**
   * The realtime transport state. While the transport re-establishes
   * ('reconnecting'), `status` still holds the last-known-good account
   * state — the UI keeps showing it (optionally with a subtle
   * synchronization indicator) until the fresh snapshot lands.
   */
  transport: WhatsAppTransportState
  /**
   * True while a status snapshot fetch is in flight — the initial
   * hydration snapshot, a reconnect re-sync, or the one-shot fetch that
   * completes the account identity after a live 'connected' transition
   * (live state events carry no JID; the JID lives in the REST snapshot).
   */
  syncing: boolean
}

// ─── Hook ───────────────────────────────────────────────────────────────────

/**
 * useWhatsAppPlatform — React hook for WhatsApp live state.
 *
 * ARCHITECTURE (identical semantics to the Next.js SSE bridge, now direct):
 *
 *   ONE AUTHENTICATED SSE CONNECTION (fetch + streaming, Bearer JWT)
 *       ↓
 *   ONE CANONICAL WHATSAPP STATUS (applyWhatsAppEvent — the single
 *   normalizer in platform/whatsapp/state.ts)
 *       ↓
 *   ALL WHATSAPP UI
 *
 * STATE MODEL (three independent axes, see WhatsAppPlatformView):
 *   - initial hydration:   status === null → the panel shows a skeleton;
 *                           it flips non-null with the FIRST authoritative
 *                           apply (snapshot or, if the fetch fails, the
 *                           buffered live events) and never returns to null.
 *   - transport state:      connecting/open/reconnecting; purely the SSE
 *                           stream's own health. NEVER writes the account
 *                           status — 'disconnected' can only ever come from
 *                           an authoritative backend event/snapshot.
 *   - account state:        the canonical WhatsAppStatus; preserved as-is
 *                           while the transport reconnects, then re-synced
 *                           by that attempt's authoritative snapshot.
 *
 * REALTIME RULES (preserved from the reference implementation):
 *   - The stream is created ONCE on mount and destroyed on unmount.
 *   - The initial state comes from a live REST snapshot (GET /api/status).
 *   - All event payloads flow through ONE pure applier with the QR freshness
 *     rule: a QR is only ever replaced by an equal-or-newer generation, and
 *     is cleared the moment the state leaves 'pairing'.
 *   - No polling. No frontend timers. The backend is the sole source of
 *     truth for QR lifetime and countdown.
 *
 * CONNECT SEQUENCE (ported from the reference bridge — gap-free):
 *   1. The snapshot fetch and the SSE connection start TOGETHER (parallel
 *      round trips). Events arriving before the snapshot lands are BUFFERED
 *      — none is missed, none is applied out of order.
 *   2. When the snapshot lands it is applied FIRST (the authoritative
 *      current state), then every buffered event is flushed IN ORDER.
 *      The normalizer's ordering rules (QR freshness, state transitions)
 *      make the flush order-safe — a buffered older QR can never overwrite
 *      a newer snapshot QR, and vice versa.
 *
 * IDENTITY COMPLETION (atomic connected hydration):
 *   Live WHATSAPP_STATE_CHANGED events carry only {state, prevState} — no
 *   JID. When a live transition therefore lands the account in 'connected'
 *   while its identity (accountId) is still unknown, ONE authoritative
 *   snapshot fetch is fired immediately; the panel shows a transient
 *   completing state (driven by `syncing`) until it lands, so 'connected'
 *   and the JID/account details appear together instead of a partial
 *   connected state with empty account lines.
 *
 * RECONNECT (identical to the reference browser EventSource policy):
 *   - Capped exponential backoff 1s → 30s, retries never abandoned.
 *   - The attempt counter resets after a stream stays healthy for 5s.
 *   - Every (re)connection re-runs the snapshot + buffer + flush sequence,
 *     so a reconnect immediately re-syncs the UI to current backend state.
 *     A FAILED re-sync is non-fatal and never clears the last-known-good
 *     account state — the transport indicator shows 'reconnecting' while
 *     it retries.
 */
export function useWhatsAppPlatform(): WhatsAppPlatformView {
  const [status, setStatus] = useState<WhatsAppStatus | null>(null)
  const [transport, setTransport] = useState<WhatsAppTransportState>('connecting')
  const [syncing, setSyncing] = useState(false)
  /** Synchronous mirror of `status` for reads inside the effect closure. */
  const statusRef = useRef<WhatsAppStatus | null>(null)

  useEffect(() => {
    let cancelled = false
    let stream: { close: () => void } | null = null
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let reconnectAttempts = 0
    /** Resets the reconnect budget once a stream has proven healthy (5s). */
    let healthyTimer: ReturnType<typeof setTimeout> | null = null
    /** In-flight snapshot fetches (hydration / re-sync / identity completion). */
    let syncInFlight = 0
    /** Guards the one-shot identity completion fetch against re-entry. */
    let identityFetchInFlight = false

    const setTransportState = (next: WhatsAppTransportState): void => {
      if (!cancelled) setTransport(next)
    }

    const beginSync = (): void => {
      syncInFlight += 1
      if (syncInFlight === 1 && !cancelled) setSyncing(true)
    }

    const endSync = (): void => {
      syncInFlight = Math.max(0, syncInFlight - 1)
      if (syncInFlight === 0 && !cancelled) setSyncing(false)
    }

    /**
     * Apply one normalized event/snapshot payload to the canonical status.
     * ONE application path: ref mirror + React state always move together,
     * so every consumer (UI, identity-completion check) sees the same
     * latest-applied status synchronously.
     */
    const applyEvent = (event: WhatsAppEvent): WhatsAppStatus => {
      if (cancelled) return statusRef.current ?? DEFAULT_WHATSAPP_STATUS
      // PRE-HYDRATION GUARD: only a STATE-CARRYING event (state-changed,
      // qr-available, security-event) may establish the first authoritative
      // status. A qr-countdown tick alone must not commit the pristine
      // default — the default's state is 'disconnected', so committing it
      // would FABRICATE a "Not connected" account state that never came
      // from the backend (reproduced live: snapshot fetch failed while the
      // backend was PAIRING; the per-second countdowns hydrated the panel
      // to a false 'disconnected' until the next QR rotation). The real
      // state lands with the next state-carrying event or the reconnect's
      // snapshot, and the per-second countdowns self-heal the moment it
      // does — dropping a pre-hydration tick costs at most one second.
      if (statusRef.current === null && event.type === 'qr-countdown') {
        return DEFAULT_WHATSAPP_STATUS
      }
      const next = applyWhatsAppEvent(statusRef.current ?? DEFAULT_WHATSAPP_STATUS, event.type, event.data)
      statusRef.current = next
      setStatus(next)
      return next
    }

    /**
     * Fetch the authoritative REST snapshot and apply it through the SAME
     * normalizer (snapshot semantics). Non-fatal: a failed fetch never
     * clears live state — the stream remains the primary source.
     *
     * Only fields the backend actually provides are passed; the held
     * account name is never clobbered by a snapshot that lacks it.
     */
    const applyAuthoritativeSnapshot = async (): Promise<boolean> => {
      try {
        const backend = await fetchBackendStatus()
        if (cancelled) return false
        applyEvent({
          type: 'state-changed',
          timestamp: new Date().toISOString(),
          data: {
            state: backend.whatsapp.state,
            session: backend.whatsapp.session,
            accountId: backend.whatsapp.jid,
            qrCode: backend.whatsapp.qrAvailable ? backend.whatsapp.qr : undefined,
            qrAvailable: backend.whatsapp.qrAvailable,
            // Full QR lifecycle: the snapshot carries the countdown too, so
            // the panel renders QR + countdown in the FIRST frame (fresh
            // mount during pairing) and a reconnect re-snapshot no longer
            // resets a known countdown to unknown.
            qrExpiresInSeconds: backend.whatsapp.qrExpiresInSeconds ?? undefined,
            qrExpiresAt: backend.whatsapp.qrExpiresAt ?? undefined,
          },
        })
        return true
      } catch {
        return false
      }
    }

    /**
     * A live 'connected' transition carries no JID (backend state events
     * hold only {state, prevState}) — the account identity lives in the
     * REST snapshot. When the account is connected while its identity is
     * still unknown, fetch the authoritative snapshot ONCE so the JID
     * lands together with the connected state. Guarded against re-entry;
     * the in-flight fetch is reported through `syncing`.
     */
    const completeAccountIdentity = (): void => {
      const current = statusRef.current
      if (!current || current.state !== 'connected' || current.accountId !== null) return
      if (identityFetchInFlight) return
      identityFetchInFlight = true
      beginSync()
      void applyAuthoritativeSnapshot().finally(() => {
        identityFetchInFlight = false
        endSync()
      })
    }

    /** Apply an event, then check whether the identity needs completing.
     *  Message job results (non-connection events) are additionally
     *  forwarded to the message-side subscribers via the message-events bus. */
    const applyAndComplete = (event: WhatsAppEvent): void => {
      applyEvent(event)
      completeAccountIdentity()
      if (event.type === 'job-result') {
        publishMessageJobResult(event.data as unknown as MessageJobResultEvent)
      }
    }

    const connect = (): void => {
      if (cancelled) return

      // ── This connection's snapshot/buffer cycle (per attempt) ──────────
      /** Events that arrive before this connection's snapshot lands. */
      const pending: MappedBackendEvent[] = []
      let snapshotLanded = false

      const handleEnvelope = (envelope: Parameters<typeof mapBackendEvent>[0]): void => {
        const event: MappedBackendEvent | null = mapBackendEvent(envelope)
        if (!event) return
        if (snapshotLanded) {
          applyAndComplete(event)
        } else {
          // Subscribe-first semantics: hold the event until the snapshot
          // has been applied, then flush in arrival order.
          pending.push(event)
        }
      }

      /**
       * Fetch the current status snapshot, apply it, then flush every event
       * that arrived while the fetch was in flight (in order). A failed
       * snapshot is non-fatal — the buffer still flushes and the live
       * stream remains the primary source; it must NOT clear live state.
       */
      const refreshSnapshot = async (): Promise<void> => {
        beginSync()
        try {
          await applyAuthoritativeSnapshot()
        } finally {
          endSync()
          snapshotLanded = true
          for (const event of pending.splice(0)) {
            if (cancelled) return
            applyAndComplete(event)
          }
        }
      }

      // The snapshot fetch starts IMMEDIATELY — in parallel with the SSE
      // connection, not after it. The first UI frame therefore lands after
      // roughly ONE round trip.
      void refreshSnapshot()

      connectAuthenticatedEventStream({
        // Adaptive stall bound: while the backend is PAIRING it emits the QR
        // countdown every second — 10s of silence then means 10 missed
        // ticks, i.e. a provably-dead stream, and the watchdog recovers it
        // in 10s instead of 45s. In every other state the default 45s stands
        // (the keepalive ping is 30s). The bound is re-read on every re-arm,
        // so it follows live state changes without touching the transport.
        getStallTimeoutMs: () =>
          statusRef.current?.state === 'pairing'
            ? SSE_PAIRING_STALL_TIMEOUT_MS
            : undefined,
      })
        .then((s) => {
          if (cancelled) {
            s.close()
            return
          }
          stream = s
          setTransportState('open')

          // Reset the reconnect budget once the stream has proven healthy.
          healthyTimer = setTimeout(() => {
            healthyTimer = null
            reconnectAttempts = 0
          }, 5_000)

          ;(async () => {
            try {
              for await (const envelope of s.envelope) {
                if (cancelled) break
                handleEnvelope(envelope)
              }
              // Stream ended cleanly (server closed it) — reconnect.
              if (!cancelled) scheduleReconnect()
            } catch {
              // Stream failed mid-flight (error or stall watchdog) — reconnect.
              if (!cancelled) scheduleReconnect()
            } finally {
              if (healthyTimer) {
                clearTimeout(healthyTimer)
                healthyTimer = null
              }
              // This stream is finished; forget it so cleanup cannot hold a
              // dead reference (the next connect() assigns the new stream).
              if (stream === s) stream = null
            }
          })()
        })
        .catch(() => {
          // Connection/auth failure — reconnect with capped backoff. The
          // snapshot may still land and populate the UI in the meantime.
          if (!cancelled) scheduleReconnect()
        })
    }

    const scheduleReconnect = (): void => {
      if (cancelled || reconnectTimer) return
      // The transport is re-establishing — the account state stays as-is.
      setTransportState('reconnecting')
      const delay = Math.min(1000 * 2 ** reconnectAttempts, 30_000)
      reconnectAttempts += 1
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null
        connect()
      }, delay)
    }

    setTransportState('connecting')
    connect()

    // Cleanup: runs ONLY on unmount.
    return () => {
      cancelled = true
      stream?.close()
      stream = null
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      if (healthyTimer) {
        clearTimeout(healthyTimer)
        healthyTimer = null
      }
    }
    // EMPTY DEPS — the connection lives for the component's lifetime.
  }, [])

  return { status, transport, syncing }
}
