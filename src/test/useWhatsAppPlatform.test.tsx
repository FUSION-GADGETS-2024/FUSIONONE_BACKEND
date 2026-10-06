/**
 * useWhatsAppPlatform hook tests — the authenticated fetch-SSE consumer.
 *
 * Ports the reference EventSource test semantics to the new transport:
 *   - ONE stream per mount (connection created once, cleaned up on unmount)
 *   - initial REST snapshot, applied FIRST with buffered live events flushed
 *     after it (gap-free connect sequence)
 *   - live events flow through the pure normalizer
 *   - reconnect with capped exponential backoff (1s → 30s), never abandoned
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useWhatsAppPlatform } from '@/features/whatsapp/useWhatsAppPlatform'
import type { BackendStatusResponse } from '@/platform/whatsapp/backend'
import { fetchBackendStatus } from '@/platform/whatsapp/http'

// ── Controlled SSE stream mock ──────────────────────────────────────────────

class MockSSEStream {
  static instances: MockSSEStream[] = []
  listeners: Array<(envelope: unknown) => void> = []
  closed = false
  /** When set, the async iterator throws on the next poll (mid-stream error). */
  failure: Error | null = null

  constructor() {
    MockSSEStream.instances.push(this)
  }

  close() {
    this.closed = true
  }

  /** Simulate the transport dying mid-flight (network error / stall watchdog). */
  fail(err: Error = new Error('stream died')) {
    this.failure = err
  }

  emit(envelope: unknown) {
    for (const l of this.listeners) l(envelope)
  }

  get envelope(): AsyncIterable<unknown> {
    const self = this
    return {
      async *[Symbol.asyncIterator]() {
        // Yield events as they are emitted; end when closed.
        const queue: unknown[] = []
        let notify: (() => void) | null = null
        self.listeners.push((e) => {
          queue.push(e)
          notify?.()
        })
        while (!self.closed) {
          if (self.failure) throw self.failure
          if (queue.length === 0) {
            await new Promise<void>((r) => { notify = r; setTimeout(r, 50) })
            notify = null
            continue
          }
          yield queue.shift()!
        }
      },
    }
  }
}

let connectImpl: (options?: { getStallTimeoutMs?: () => number }) => Promise<MockSSEStream>

vi.mock('@/platform/whatsapp/sse', () => ({
  // Forward ALL arguments so tests can capture the options object the hook
  // passes (e.g. the adaptive stall bound callback). The pairing stall
  // constant is re-exported for the hook's import (same value as production).
  connectAuthenticatedEventStream: (options?: { getStallTimeoutMs?: () => number }) => connectImpl(options),
  SSE_PAIRING_STALL_TIMEOUT_MS: 10_000,
}))

vi.mock('@/platform/whatsapp/http', () => ({
  fetchBackendStatus: vi.fn().mockResolvedValue({
    server: { state: 'running' },
    whatsapp: { state: 'IDLE', session: 'NONE', connected: false, jid: null, qrAvailable: false, qr: null, qrExpiresInSeconds: null, qrExpiresAt: null },
  }),
}))

beforeEach(() => {
  MockSSEStream.instances = []
  connectImpl = vi.fn(async () => new MockSSEStream())
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('useWhatsAppPlatform', () => {
  it('creates exactly ONE stream per mount and closes it on unmount', async () => {
    const { unmount } = renderHook(() => useWhatsAppPlatform())
    await waitFor(() => expect(MockSSEStream.instances.length).toBe(1))
    unmount()
    expect(MockSSEStream.instances[0].closed).toBe(true)
  })

  it('applies the initial REST snapshot (state-changed)', async () => {
    const { result } = renderHook(() => useWhatsAppPlatform())
    await waitFor(() => expect(result.current.status?.state).toBe('disconnected'))
    expect(result.current.status?.connected).toBe(false)
  })

  it('applies live events through the normalizer (QR flow)', async () => {
    const { result } = renderHook(() => useWhatsAppPlatform())
    await waitFor(() => expect(MockSSEStream.instances.length).toBe(1))
    const stream = MockSSEStream.instances[0]

    await act(async () => {
      stream.emit({
        type: 'WHATSAPP_STATE_CHANGED',
        timestamp: 't',
        data: { state: 'PAIRING', prevState: 'IDLE' },
      })
    })
    expect(result.current.status?.state).toBe('pairing')

    await act(async () => {
      stream.emit({
        type: 'WHATSAPP_QR_AVAILABLE',
        timestamp: 't',
        data: { qr: 'data:image/png;base64,XYZ', expiresInSeconds: 60, expiresAt: '2026-09-29T01:01:00.000Z' },
      })
    })
    expect(result.current.status?.qrCode).toBe('data:image/png;base64,XYZ')
    expect(result.current.status?.qrExpiresInSeconds).toBe(60)

    await act(async () => {
      stream.emit({
        type: 'WHATSAPP_QR_COUNTDOWN',
        timestamp: 't',
        data: { remainingSeconds: 42, expiresAt: '2026-09-29T01:01:00.000Z' },
      })
    })
    expect(result.current.status?.qrExpiresInSeconds).toBe(42)

    // Connecting → QR cleared (leaving pairing state)
    await act(async () => {
      stream.emit({
        type: 'WHATSAPP_STATE_CHANGED',
        timestamp: 't',
        data: { state: 'CONNECTED', prevState: 'PAIRING', accountId: 'user@s.whatsapp.net' },
      })
    })
    expect(result.current.status?.state).toBe('connected')
    expect(result.current.status?.qrCode).toBeNull()
    expect(result.current.status?.accountId).toBe('user@s.whatsapp.net')
  })

  it('reconnects with capped exponential backoff and never abandons', async () => {
    vi.useFakeTimers()
    try {
      let failures = 0
      connectImpl = vi.fn(async () => {
        if (failures < 3) {
          failures++
          throw new Error('connection refused')
        }
        return new MockSSEStream()
      })

      renderHook(() => useWhatsAppPlatform())
      // Initial attempt fails → schedules reconnect at 1s
      await vi.advanceTimersByTimeAsync(50)
      expect(connectImpl).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(1000) // attempt 2 (fails) → 2s backoff
      expect(connectImpl).toHaveBeenCalledTimes(2)

      await vi.advanceTimersByTimeAsync(2000) // attempt 3 (fails) → 4s backoff
      expect(connectImpl).toHaveBeenCalledTimes(3)

      await vi.advanceTimersByTimeAsync(4000) // attempt 4 succeeds
      expect(connectImpl).toHaveBeenCalledTimes(4)
      expect(MockSSEStream.instances.length).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('caps the backoff at 30 seconds', async () => {
    vi.useFakeTimers()
    try {
      connectImpl = vi.fn(async () => {
        throw new Error('down')
      })
      renderHook(() => useWhatsAppPlatform())
      await vi.advanceTimersByTimeAsync(50)

      // attempts at 1s, 2s, 4s, 8s, 16s, 30s, 30s...
      await vi.advanceTimersByTimeAsync(1000 + 2000 + 4000 + 8000 + 16000)
      const attemptsAfterFive = (connectImpl as ReturnType<typeof vi.fn>).mock.calls.length

      await vi.advanceTimersByTimeAsync(30000)
      const attemptsAfterSix = (connectImpl as ReturnType<typeof vi.fn>).mock.calls.length
      expect(attemptsAfterSix).toBe(attemptsAfterFive + 1)

      // The next backoff stays at 30s (never grows beyond the cap)
      await vi.advanceTimersByTimeAsync(29000)
      expect((connectImpl as ReturnType<typeof vi.fn>).mock.calls.length).toBe(attemptsAfterSix)
      await vi.advanceTimersByTimeAsync(1000)
      expect((connectImpl as ReturnType<typeof vi.fn>).mock.calls.length).toBe(attemptsAfterSix + 1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reconnects when the stream FAILS MID-FLIGHT (network drop / stall watchdog)', async () => {
    vi.useFakeTimers()
    try {
      const first = new MockSSEStream()
      const second = new MockSSEStream()
      let attempt = 0
      connectImpl = vi.fn(async () => {
        attempt += 1
        return attempt === 1 ? first : second
      })

      const { result } = renderHook(() => useWhatsAppPlatform())
      await vi.advanceTimersByTimeAsync(50)
      expect(attempt).toBe(1) // exactly one live connection

      // The first stream dies mid-flight (e.g. the sse stall watchdog fired).
      first.fail(new Error('SSE stream stalled — no data received within 45s'))
      await vi.advanceTimersByTimeAsync(200) // > the mock's 50ms poll

      // Reconnect is scheduled at 1s backoff.
      await vi.advanceTimersByTimeAsync(1000)
      expect(attempt).toBe(2)

      // The replacement stream's events flow through to the UI.
      await act(async () => {
        second.emit({
          type: 'WHATSAPP_STATE_CHANGED',
          timestamp: 't',
          data: { state: 'PAIRING', prevState: 'IDLE' },
        })
      })
      expect(result.current.status?.state).toBe('pairing')

      // Exactly one stream is live: the dead one is not reused.
      expect(first.closed).toBe(false) // close() is not called on a FAILED stream — it already ended
      expect(second.closed).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('makes NO further connection attempts after unmount (timer cleanup)', async () => {
    vi.useFakeTimers()
    try {
      connectImpl = vi.fn(async () => {
        throw new Error('down')
      })
      const { unmount } = renderHook(() => useWhatsAppPlatform())
      await vi.advanceTimersByTimeAsync(50)

      // First failure schedules a reconnect at 1s — let it fire once.
      await vi.advanceTimersByTimeAsync(1000)
      const attemptsBeforeUnmount = (connectImpl as ReturnType<typeof vi.fn>).mock.calls.length
      expect(attemptsBeforeUnmount).toBeGreaterThanOrEqual(2)

      // Unmount clears the pending reconnect timer: no matter how much time
      // passes, no further attempts happen (no zombie connections).
      unmount()
      await vi.advanceTimersByTimeAsync(120_000)
      expect((connectImpl as ReturnType<typeof vi.fn>).mock.calls.length).toBe(attemptsBeforeUnmount)
    } finally {
      vi.useRealTimers()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────

/** A manually-resolvable promise (simulates a slow REST snapshot fetch). */
function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const statusMock = vi.mocked(fetchBackendStatus)

/**
 * Regression tests for the gap-free connect sequence (ported from the
 * reference Next.js bridge): the snapshot fetch starts IN PARALLEL with the
 * SSE connection, events arriving before the snapshot lands are buffered,
 * the snapshot applies FIRST, and the buffer flushes in order afterwards.
 *
 * The previous implementation (a) awaited the SSE connection before even
 * starting the snapshot fetch (two sequential round trips to the first UI
 * frame) and (b) DISCARDED the snapshot whenever any event arrived while
 * the fetch was in flight — during pairing the per-second countdown ticks
 * essentially always won that race, leaving the panel on stale default
 * state until the next full backend event.
 */
describe('useWhatsAppPlatform — gap-free connect sequence (snapshot + buffer + flush)', () => {
  it('starts the snapshot fetch IN PARALLEL with the SSE connection (not after it)', async () => {
    // The SSE connection never opens — the snapshot must still start.
    connectImpl = vi.fn(() => new Promise<MockSSEStream>(() => {}))

    renderHook(() => useWhatsAppPlatform())
    await waitFor(() => expect(statusMock).toHaveBeenCalled())
  })

  it('does NOT discard the snapshot when events arrive during the fetch (buffer + flush)', async () => {
    const snap = deferred<BackendStatusResponse>()
    statusMock.mockReturnValueOnce(snap.promise)
    connectImpl = vi.fn(async () => new MockSSEStream())

    const { result } = renderHook(() => useWhatsAppPlatform())
    await waitFor(() => expect(MockSSEStream.instances.length).toBe(1))
    const stream = MockSSEStream.instances[0]

    // Events arrive while the snapshot fetch is in flight — they are held
    // in the buffer (NOT applied: the status is still pristine null).
    await act(async () => {
      stream.emit({
        type: 'WHATSAPP_QR_COUNTDOWN',
        timestamp: 't',
        data: { remainingSeconds: 42, expiresAt: '2026-09-29T01:01:00.000Z' },
      })
    })
    expect(result.current.status).toBeNull() // nothing applied yet — event is buffered

    // The snapshot lands LAST — it must still be applied (the old code
    // discarded it because an event arrived mid-flight).
    await act(async () => {
      snap.resolve({
        server: { state: 'running', timestamp: 't' },
        whatsapp: {
          state: 'PAIRING',
          session: 'NONE',
          connected: false,
          jid: null,
          qrAvailable: true,
          qr: 'data:image/png;base64,SNAP',
          qrExpiresInSeconds: null,
          qrExpiresAt: null,
        },
      })
    })

    // Snapshot applied FIRST (pairing + its QR), then the buffered countdown.
    expect(result.current.status?.state).toBe('pairing')
    expect(result.current.status?.qrCode).toBe('data:image/png;base64,SNAP')
    expect(result.current.status?.qrExpiresInSeconds).toBe(42)
  })

  it('flushes buffered events AFTER the snapshot — a newer buffered QR wins', async () => {
    const snap = deferred<BackendStatusResponse>()
    statusMock.mockReturnValueOnce(snap.promise)
    connectImpl = vi.fn(async () => new MockSSEStream())

    const { result } = renderHook(() => useWhatsAppPlatform())
    await waitFor(() => expect(MockSSEStream.instances.length).toBe(1))
    const stream = MockSSEStream.instances[0]

    // A NEW QR generation arrives while the (slower) snapshot is in flight.
    await act(async () => {
      stream.emit({
        type: 'WHATSAPP_QR_AVAILABLE',
        timestamp: 't',
        data: {
          qr: 'data:image/png;base64,NEWER',
          expiresInSeconds: 60,
          expiresAt: '2026-09-29T02:00:00.000Z',
        },
      })
    })

    // The snapshot (serialized before that QR was emitted) still carries
    // the older QR — it applies first, then the buffered newer QR replaces
    // it via the freshness rule.
    await act(async () => {
      snap.resolve({
        server: { state: 'running', timestamp: 't' },
        whatsapp: {
          state: 'PAIRING',
          session: 'NONE',
          connected: false,
          jid: null,
          qrAvailable: true,
          qr: 'data:image/png;base64,OLDER',
          qrExpiresInSeconds: null,
          qrExpiresAt: null,
        },
      })
    })

    expect(result.current.status?.state).toBe('pairing')
    expect(result.current.status?.qrCode).toBe('data:image/png;base64,NEWER')
    expect(result.current.status?.qrExpiresInSeconds).toBe(60)
  })

  it('a FAILED snapshot is non-fatal — buffered events still flush and apply', async () => {
    const snap = deferred<BackendStatusResponse>()
    statusMock.mockReturnValueOnce(snap.promise)
    connectImpl = vi.fn(async () => new MockSSEStream())

    const { result } = renderHook(() => useWhatsAppPlatform())
    await waitFor(() => expect(MockSSEStream.instances.length).toBe(1))
    const stream = MockSSEStream.instances[0]

    await act(async () => {
      stream.emit({
        type: 'WHATSAPP_STATE_CHANGED',
        timestamp: 't',
        data: { state: 'PAIRING', prevState: 'IDLE' },
      })
    })
    expect(result.current.status).toBeNull() // still buffered — nothing applied yet

    await act(async () => {
      snap.reject(new Error('network down'))
    })

    // The snapshot failed, but the buffered event still applies.
    expect(result.current.status?.state).toBe('pairing')
  })

  it('a countdown while un-hydrated NEVER fabricates a status (failed snapshot, no state event)', async () => {
    // LIVE REGRESSION (E2E 2026-10-01): with the REST snapshot failing while
    // the backend was PAIRING, the per-second WHATSAPP_QR_COUNTDOWN ticks
    // flushed against the pristine DEFAULT_WHATSAPP_STATUS and COMMITTED it
    // — fabricating a false 'disconnected' account state that never came
    // from the backend. Only a state-carrying event or snapshot may
    // establish the first authoritative status.
    const snap = deferred<BackendStatusResponse>()
    statusMock.mockReturnValueOnce(snap.promise)
    connectImpl = vi.fn(async () => new MockSSEStream())

    const { result } = renderHook(() => useWhatsAppPlatform())
    await waitFor(() => expect(MockSSEStream.instances.length).toBe(1))
    const stream = MockSSEStream.instances[0]

    // Countdown ticks arrive while the snapshot fetch is in flight.
    await act(async () => {
      stream.emit({
        type: 'WHATSAPP_QR_COUNTDOWN',
        timestamp: 't1',
        data: { remainingSeconds: 59, expiresAt: '2026-10-01T06:10:00.000Z' },
      })
      stream.emit({
        type: 'WHATSAPP_QR_COUNTDOWN',
        timestamp: 't2',
        data: { remainingSeconds: 58, expiresAt: '2026-10-01T06:10:00.000Z' },
      })
    })
    expect(result.current.status).toBeNull() // buffered — nothing applied yet

    // The snapshot FAILS — the buffered countdowns flush…
    await act(async () => {
      snap.reject(new Error('gateway 502'))
    })

    // …but they must NOT hydrate the panel: 'disconnected' may only ever
    // come from an authoritative backend event/snapshot, never from the
    // pristine default being committed by a decorative countdown tick.
    expect(result.current.status).toBeNull()

    // The next STATE-CARRYING event establishes the real state…
    await act(async () => {
      stream.emit({
        type: 'WHATSAPP_STATE_CHANGED',
        timestamp: 't3',
        data: { state: 'PAIRING', prevState: 'IDLE' },
      })
    })
    expect(result.current.status?.state).toBe('pairing')

    // …and subsequent countdowns apply NORMALLY against it.
    await act(async () => {
      stream.emit({
        type: 'WHATSAPP_QR_COUNTDOWN',
        timestamp: 't4',
        data: { remainingSeconds: 57, expiresAt: '2026-10-01T06:10:00.000Z' },
      })
    })
    expect(result.current.status?.state).toBe('pairing')
    expect(result.current.status?.qrExpiresInSeconds).toBe(57)
  })

  it('re-runs the snapshot sequence on RECONNECT (fresh authoritative state)', async () => {
    vi.useFakeTimers()
    try {
      const first = new MockSSEStream()
      const second = new MockSSEStream()
      let attempt = 0
      connectImpl = vi.fn(async () => {
        attempt += 1
        return attempt === 1 ? first : second
      })

      renderHook(() => useWhatsAppPlatform())
      await vi.advanceTimersByTimeAsync(50)
      expect(statusMock).toHaveBeenCalledTimes(1)

      // The first stream dies mid-flight → reconnect at 1s backoff.
      first.fail(new Error('stream died'))
      await vi.advanceTimersByTimeAsync(200)
      await vi.advanceTimersByTimeAsync(1000)
      expect(attempt).toBe(2)

      // The reconnected attempt re-fetched the snapshot (fresh state) —
      // refreshSnapshot() runs synchronously at the start of connect().
      expect(statusMock).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Hydration / transport / syncing state axes — the panel loading-state fix.
 *
 * The hook's view separates three independent axes:
 *   - initial hydration: status stays null until the FIRST authoritative
 *     apply — the panel shows a skeleton, never a false 'disconnected';
 *   - transport health: connecting/open/reconnecting — NEVER equated to the
 *     WhatsApp account state; a lost stream keeps the last-known-good status;
 *   - snapshot fetches in flight (syncing), including the identity-completion
 *     fetch: a live 'connected' event carries no JID, so ONE authoritative
 *     snapshot is fetched to land the JID together with the connected state.
 */
describe('useWhatsAppPlatform — hydration / transport / syncing axes', () => {
  it('status stays NULL while the first snapshot is in flight (skeleton, never disconnected)', async () => {
    const snap = deferred<BackendStatusResponse>()
    statusMock.mockReturnValueOnce(snap.promise)
    connectImpl = vi.fn(async () => new MockSSEStream())

    const { result } = renderHook(() => useWhatsAppPlatform())

    // Before anything lands: no authoritative state applied (the UI shows a
    // loading skeleton — NOT 'disconnected'), snapshot fetch in flight.
    expect(result.current.status).toBeNull()
    expect(result.current.syncing).toBe(true)

    await waitFor(() => expect(result.current.transport).toBe('open'))

    // The stream is open but the snapshot has not landed — still not hydrated.
    expect(result.current.status).toBeNull()

    await act(async () => {
      snap.resolve({
        server: { state: 'running', timestamp: 't' },
        whatsapp: { state: 'IDLE', session: 'NONE', connected: false, jid: null, qrAvailable: false, qr: null, qrExpiresInSeconds: null, qrExpiresAt: null },
      })
    })
    expect(result.current.status?.state).toBe('disconnected') // authoritative NOW — not before
    expect(result.current.syncing).toBe(false)
  })

  it('transport: open → reconnecting → open across a stream loss (account state untouched)', async () => {
    vi.useFakeTimers()
    try {
      const first = new MockSSEStream()
      const second = new MockSSEStream()
      let attempt = 0
      connectImpl = vi.fn(async () => {
        attempt += 1
        return attempt === 1 ? first : second
      })

      const { result } = renderHook(() => useWhatsAppPlatform())
      await act(async () => { await vi.advanceTimersByTimeAsync(50) })
      expect(result.current.transport).toBe('open')
      expect(result.current.status?.state).toBe('disconnected') // from the initial snapshot

      // The stream dies mid-flight → transport flips to 'reconnecting' while
      // the last-known account state stays applied (NOT cleared).
      first.fail(new Error('died'))
      await act(async () => { await vi.advanceTimersByTimeAsync(200) })
      expect(result.current.transport).toBe('reconnecting')
      expect(result.current.status?.state).toBe('disconnected') // unchanged by the transport loss

      await act(async () => { await vi.advanceTimersByTimeAsync(1000) }) // backoff fires → attempt 2
      expect(attempt).toBe(2)
      expect(result.current.transport).toBe('open')
    } finally {
      vi.useRealTimers()
    }
  })

  it('live CONNECTED (no JID in the payload, as the real backend sends) → ONE snapshot fetch lands the JID with it', async () => {
    // Initial snapshot: backend PAIRING (the realistic scan scenario — the
    // panel is open while the user scans).
    statusMock.mockReturnValueOnce(Promise.resolve({
      server: { state: 'running', timestamp: 't' },
      whatsapp: { state: 'PAIRING', session: 'NONE', connected: false, jid: null, qrAvailable: true, qr: 'data:image/png;base64,QR1', qrExpiresInSeconds: null, qrExpiresAt: null },
    }))
    connectImpl = vi.fn(async () => new MockSSEStream())

    const { result } = renderHook(() => useWhatsAppPlatform())
    await waitFor(() => expect(result.current.status?.state).toBe('pairing'))

    // The user scans: the backend emits CONNECTING — {state, prevState} ONLY.
    await act(async () => {
      MockSSEStream.instances[0].emit({
        type: 'WHATSAPP_STATE_CHANGED',
        timestamp: 't',
        data: { state: 'CONNECTING', prevState: 'PAIRING' },
      })
    })
    expect(result.current.status?.state).toBe('connecting')

    // Queue the identity snapshot BEFORE the connected event fires the fetch.
    const identity = deferred<BackendStatusResponse>()
    statusMock.mockReturnValueOnce(identity.promise)

    await act(async () => {
      MockSSEStream.instances[0].emit({
        type: 'WHATSAPP_STATE_CHANGED',
        timestamp: 't',
        data: { state: 'CONNECTED', prevState: 'CONNECTING' }, // no accountId — as the backend sends it
      })
    })

    // 'connected' is authoritative immediately; the JID is being fetched —
    // the panel shows the transient completing state (syncing), never a
    // partial connected view.
    expect(result.current.status?.state).toBe('connected')
    expect(result.current.status?.accountId).toBeNull()
    expect(result.current.syncing).toBe(true)

    await act(async () => {
      identity.resolve({
        server: { state: 'running', timestamp: 't' },
        whatsapp: { state: 'CONNECTED', session: 'NONE', connected: true, jid: '918795103722:54@s.whatsapp.net', qrAvailable: false, qr: null, qrExpiresInSeconds: null, qrExpiresAt: null },
      })
    })

    // Connected + JID landed together (one atomic apply).
    expect(result.current.status?.state).toBe('connected')
    expect(result.current.status?.accountId).toBe('918795103722:54@s.whatsapp.net')
    expect(result.current.syncing).toBe(false)

    // Exactly two fetches: initial hydration + identity completion. A
    // duplicate connected event (identity now known) triggers NO further fetch.
    await act(async () => {
      MockSSEStream.instances[0].emit({
        type: 'WHATSAPP_STATE_CHANGED',
        timestamp: 't',
        data: { state: 'CONNECTED', prevState: 'CONNECTED' },
      })
    })
    expect(statusMock).toHaveBeenCalledTimes(2)
  })

  it('NO identity fetch when the account identity is already known', async () => {
    // Initial snapshot: already connected WITH jid (mounted while connected).
    statusMock.mockReturnValueOnce(Promise.resolve({
      server: { state: 'running', timestamp: 't' },
      whatsapp: { state: 'CONNECTED', session: 'NONE', connected: true, jid: 'known@s.whatsapp.net', qrAvailable: false, qr: null, qrExpiresInSeconds: null, qrExpiresAt: null },
    }))
    connectImpl = vi.fn(async () => new MockSSEStream())

    const { result } = renderHook(() => useWhatsAppPlatform())
    await waitFor(() => expect(result.current.status?.accountId).toBe('known@s.whatsapp.net'))

    // Backend RECONNECTING → CONNECTED (transient drop recovery): the identity
    // is already held — must NOT trigger another snapshot fetch.
    await act(async () => {
      MockSSEStream.instances[0].emit({
        type: 'WHATSAPP_STATE_CHANGED',
        timestamp: 't',
        data: { state: 'RECONNECTING', prevState: 'CONNECTED' },
      })
      MockSSEStream.instances[0].emit({
        type: 'WHATSAPP_STATE_CHANGED',
        timestamp: 't',
        data: { state: 'CONNECTED', prevState: 'RECONNECTING' },
      })
    })
    expect(result.current.status?.state).toBe('connected')
    expect(statusMock).toHaveBeenCalledTimes(1) // only the initial hydration snapshot
  })

  it('a FAILED identity fetch is non-fatal — single attempt, connected state preserved', async () => {
    statusMock.mockReturnValueOnce(Promise.resolve({
      server: { state: 'running', timestamp: 't' },
      whatsapp: { state: 'PAIRING', session: 'NONE', connected: false, jid: null, qrAvailable: true, qr: 'data:image/png;base64,QR1', qrExpiresInSeconds: null, qrExpiresAt: null },
    }))
    connectImpl = vi.fn(async () => new MockSSEStream())

    const { result } = renderHook(() => useWhatsAppPlatform())
    await waitFor(() => expect(result.current.status?.state).toBe('pairing'))

    const identity = deferred<BackendStatusResponse>()
    statusMock.mockReturnValueOnce(identity.promise)
    await act(async () => {
      MockSSEStream.instances[0].emit({
        type: 'WHATSAPP_STATE_CHANGED',
        timestamp: 't',
        data: { state: 'CONNECTED', prevState: 'PAIRING' },
      })
    })
    expect(result.current.status?.state).toBe('connected')
    expect(result.current.syncing).toBe(true)

    await act(async () => {
      identity.reject(new Error('network down'))
    })

    // The fetch failed: non-fatal. The connected state stays (authoritative);
    // the account identity remains unknown until the next snapshot lands
    // (a reconnect re-sync). No spontaneous retries.
    expect(result.current.status?.state).toBe('connected')
    expect(result.current.status?.accountId).toBeNull()
    expect(result.current.syncing).toBe(false)
    expect(statusMock).toHaveBeenCalledTimes(2)
  })

  it('a FAILED reconnect re-sync preserves the last-known-good state (never a false disconnected)', async () => {
    vi.useFakeTimers()
    try {
      const first = new MockSSEStream()
      const second = new MockSSEStream()
      let attempt = 0
      connectImpl = vi.fn(async () => {
        attempt += 1
        return attempt === 1 ? first : second
      })

      // Initial snapshot: CONNECTED with the JID.
      statusMock.mockReturnValueOnce(Promise.resolve({
        server: { state: 'running', timestamp: 't' },
        whatsapp: { state: 'CONNECTED', session: 'NONE', connected: true, jid: '918795103722:54@s.whatsapp.net', qrAvailable: false, qr: null, qrExpiresInSeconds: null, qrExpiresAt: null },
      }))
      const { result } = renderHook(() => useWhatsAppPlatform())
      await act(async () => { await vi.advanceTimersByTimeAsync(50) })
      expect(result.current.status?.state).toBe('connected')
      expect(result.current.status?.accountId).toBe('918795103722:54@s.whatsapp.net')

      // Stream dies → reconnect → the re-sync snapshot fetch FAILS. The
      // once-queue is consumed in call order, so this rejection is call #2.
      statusMock.mockRejectedValueOnce(new Error('status unreachable'))
      first.fail(new Error('died'))
      await act(async () => { await vi.advanceTimersByTimeAsync(200) })
      expect(result.current.transport).toBe('reconnecting') // subtle sync indicator while it retries

      // Backoff fires → attempt 2 (stream ok, re-snapshot fails).
      await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
      expect(attempt).toBe(2)

      // The re-sync failed: the last-known-good state is PRESERVED — not
      // cleared, not 'disconnected', JID/account details kept.
      expect(result.current.status?.state).toBe('connected')
      expect(result.current.status?.accountId).toBe('918795103722:54@s.whatsapp.net')
      expect(result.current.transport).toBe('open')
      expect(result.current.syncing).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Snapshot QR lifecycle + adaptive stall bound wiring
// ─────────────────────────────────────────────────────────────────────────────

describe('useWhatsAppPlatform — snapshot QR lifecycle + adaptive stall wiring', () => {
  it('a pairing snapshot with QR lifecycle fields renders QR + countdown in the FIRST frame', async () => {
    statusMock.mockResolvedValueOnce({
      server: { state: 'running', timestamp: 't' },
      whatsapp: {
        state: 'PAIRING',
        session: 'NONE',
        connected: false,
        jid: null,
        qrAvailable: true,
        qr: 'data:image/png;base64,SNAPSHOT-QR',
        qrExpiresInSeconds: 47,
        qrExpiresAt: '2026-09-29T01:00:47.000Z',
      },
    })

    const { result } = renderHook(() => useWhatsAppPlatform())
    // No SSE countdown tick needed — the snapshot alone carries the full
    // QR lifecycle (fresh mount DURING pairing shows QR + countdown at once).
    await waitFor(() => expect(result.current.status?.state).toBe('pairing'))
    expect(result.current.status?.qrCode).toBe('data:image/png;base64,SNAPSHOT-QR')
    expect(result.current.status?.qrAvailable).toBe(true)
    expect(result.current.status?.qrExpiresInSeconds).toBe(47)
    expect(result.current.status?.qrExpiresAt).toBe('2026-09-29T01:00:47.000Z')
  })

  it('passes the adaptive stall bound to the transport (tight while pairing)', async () => {
    // The sse module mock ignores its argument by default; capture it here.
    let capturedOptions: { getStallTimeoutMs?: () => number } | undefined
    connectImpl = vi.fn(async (options?: { getStallTimeoutMs?: () => number }) => {
      capturedOptions = options
      return new MockSSEStream()
    })

    // Identity is known from the snapshot (CONNECTED + jid), so live state
    // changes below never trigger the identity-completion fetch.
    statusMock.mockResolvedValue({
      server: { state: 'running', timestamp: 't' },
      whatsapp: {
        state: 'CONNECTED',
        session: 'PRESENT',
        connected: true,
        jid: 'known@s.whatsapp.net',
        qrAvailable: false,
        qr: null,
        qrExpiresInSeconds: null,
        qrExpiresAt: null,
      },
    })

    const { result } = renderHook(() => useWhatsAppPlatform())
    await waitFor(() => expect(result.current.status?.state).toBe('connected'))
    await waitFor(() => expect(MockSSEStream.instances.length).toBe(1))

    // Connected (not pairing): the default bound (undefined → transport
    // default 45s).
    expect(typeof capturedOptions?.getStallTimeoutMs).toBe('function')
    expect(capturedOptions?.getStallTimeoutMs?.()).toBeUndefined()

    // Once the backend is pairing, the same live callback reports the
    // tightened bound — the transport re-reads it on every watchdog re-arm.
    const stream = MockSSEStream.instances[0]
    await act(async () => {
      stream.emit({
        type: 'WHATSAPP_STATE_CHANGED',
        timestamp: 't',
        data: { state: 'PAIRING', prevState: 'CONNECTED' },
      })
    })
    await waitFor(() => expect(result.current.status?.state).toBe('pairing'))
    expect(capturedOptions?.getStallTimeoutMs?.()).toBe(10_000)

    // Leaving pairing restores the default bound.
    await act(async () => {
      stream.emit({
        type: 'WHATSAPP_STATE_CHANGED',
        timestamp: 't',
        data: { state: 'CONNECTED', prevState: 'PAIRING', session: 'PRESENT' },
      })
    })
    await waitFor(() => expect(result.current.status?.state).toBe('connected'))
    expect(capturedOptions?.getStallTimeoutMs?.()).toBeUndefined()
  })
})
