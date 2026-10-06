/**
 * Authenticated SSE client for the FUSION ONE backend.
 *
 * Native `EventSource` cannot send an `Authorization` header, and the browser
 * now talks to the backend directly with a Bearer token — so this module
 * implements SSE over `fetch` + streaming response parsing (the standards-
 * based approach the migration spec calls for). The event semantics are
 * identical to the old named-event bridge.
 *
 * SELF-HEALING (restores what the browser's EventSource gave the old
 * same-origin bridge architecture):
 *
 *   1. STALL WATCHDOG — a fetch stream can die SILENTLY (no FIN/RST:
 *      mobile network switch, sleep/wake, proxy half-close). A pending
 *      `reader.read()` then never settles and the UI would stay deaf
 *      forever. The backend proves liveness at least every 30s
 *      (`: ping` keepalives; per-second countdown events while pairing),
 *      so if NO bytes arrive within 45s the connection is aborted and the
 *      error is surfaced — the hook's reconnect loop then re-establishes
 *      the stream and re-snapshots the current state.
 *
 *   2. AUTH REFRESH — the stream authenticates ONLY at connection time.
 *      If the Supabase access token expired while the page was open, a
 *      reconnect attempt gets 401. The session is refreshed via Supabase
 *      (never manually persisted, never placed in URLs) and the connection
 *      is retried ONCE with the fresh token before failing over to the
 *      reconnect backoff.
 */
import { supabase } from '@/platform/supabase/client'
import { waUrl } from './url'
import type { BackendEventEnvelope } from './backend'

/**
 * Abort the stream when no bytes have arrived for this long.
 * The backend's SSE keepalive is 30s — 45s allows one missed ping without
 * false positives, while bounding deafness to well under a minute.
 */
const SSE_STALL_TIMEOUT_MS = 45_000

/**
 * Tighter stall bound while PAIRING: the backend guarantees at least one
 * event per second (the QR countdown), so 10s of silence means 10 missed
 * ticks — the stream is provably dead. Detecting it fast matters most
 * exactly here: a silently-dead stream during pairing leaves the QR frozen
 * and the rotation missed until the watchdog fires. Consumers that know the
 * connection is pairing pass this bound via getStallTimeoutMs().
 */
export const SSE_PAIRING_STALL_TIMEOUT_MS = 10_000

/**
 * Abort a connect attempt whose response headers have not arrived within
 * this long. A fetch that starts into a network blackhole (adapter switch,
 * offline window, half-dead proxy) can stay pending FOREVER — which used to
 * wedge the hook's reconnect loop permanently (the UI stayed deaf until a
 * page reload). Aborting here fails the attempt fast so the capped backoff
 * can retry; slow-but-alive origins (cold starts) simply take 1–2 more
 * retries, which the backoff already handles.
 */
const SSE_CONNECT_TIMEOUT_MS = 15_000

export interface AuthenticatedSSEStream {
  /** Async iterable of parsed backend event envelopes. */
  envelope: AsyncIterable<BackendEventEnvelope>
  /** Abort the stream (idempotent). */
  close: () => void
}

export interface ConnectAuthenticatedEventStreamOptions {
  /**
   * Current no-bytes stall threshold in milliseconds — consulted EVERY time
   * the watchdog re-arms (each received chunk), so the bound can adapt to
   * the live connection state. Returning undefined keeps the default (45s).
   * While the consumer knows the backend is PAIRING (guaranteed 1 event per
   * second), it can pass the tighter SSE_PAIRING_STALL_TIMEOUT_MS; the
   * default stands everywhere else (the backend's keepalive ping is 30s, so
   * anything below that would false-positive on a healthy idle stream).
   */
  getStallTimeoutMs?: () => number | undefined
}

/** One fetch attempt against GET /api/events. */
async function openEventsFetch(
  token: string,
): Promise<{ controller: AbortController; response: Response }> {
  const controller = new AbortController()
  // Bound the connection-establishment phase: without this, a wedged fetch
  // promise (no headers, no rejection) parks the reconnect loop forever.
  const connectTimer = setTimeout(() => controller.abort(), SSE_CONNECT_TIMEOUT_MS)
  try {
    const response = await fetch(waUrl('/api/events'), {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
      signal: controller.signal,
      cache: 'no-store',
    })
    return { controller, response }
  } finally {
    clearTimeout(connectTimer)
  }
}

/**
 * Reject if a promise hasn't settled within `ms` (the underlying work is
 * abandoned, never cancelled — Supabase keeps its own state consistent).
 * Bounds every network-dependent await in the connect chain so a
 * blackholed request can never park the hook's reconnect loop forever.
 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out`)), ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      },
    )
  })
}

/**
 * Connect to the backend SSE stream (GET /api/events) with the user's
 * Supabase access token.
 *
 * Rejects if the connection cannot be established or authenticates (the
 * caller's reconnect policy handles retries). Every phase is bounded:
 * session lookup (10s), connection establishment (15s), session refresh
 * (10s), and the streaming body (45s inactivity watchdog) — the caller's
 * reconnect loop can therefore never wedge on a hung promise.
 */
export async function connectAuthenticatedEventStream(
  options?: ConnectAuthenticatedEventStreamOptions,
): Promise<AuthenticatedSSEStream> {
  const { data, error } = await withTimeout(supabase.auth.getSession(), 10_000, 'Session lookup')
  if (error) throw error
  const token = data.session?.access_token
  if (!token) throw new Error('Authentication required.')

  let { controller, response } = await openEventsFetch(token)

  // 401 — the token likely expired while the page was open. Give Supabase
  // ONE chance to refresh the session, then retry with the fresh token.
  if (response.status === 401) {
    controller.abort() // release the rejected attempt's connection
    const { data: refreshed } = await withTimeout(
      supabase.auth.refreshSession(),
      10_000,
      'Session refresh',
    )
    const freshToken = refreshed?.session?.access_token
    if (freshToken && freshToken !== token) {
      const retry = await openEventsFetch(freshToken)
      controller = retry.controller
      response = retry.response
    }
  }

  if (!response.ok || !response.body) {
    // Drain the error body for a useful message, then fail.
    let message = `SSE connection failed: HTTP ${response.status}`
    try {
      const body = (await response.json()) as { error?: { message?: string } }
      if (body.error?.message) message = body.error.message
    } catch {
      // not JSON
    }
    controller.abort()
    throw new Error(message)
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()

  // ── Stall watchdog state (shared by the read loop and close()) ─────────
  let stallTimer: ReturnType<typeof setTimeout> | null = null
  /** Set when the watchdog (not the consumer) aborted the connection. */
  let stalled = false

  const clearWatchdog = (): void => {
    if (stallTimer !== null) {
      clearTimeout(stallTimer)
      stallTimer = null
    }
  }

  const stallTimeoutMs = (): number =>
    options?.getStallTimeoutMs?.() ?? SSE_STALL_TIMEOUT_MS

  const armWatchdog = (): void => {
    clearWatchdog()
    stallTimer = setTimeout(() => {
      stalled = true
      controller.abort()
    }, stallTimeoutMs())
  }

  const stream = new ReadableStream<BackendEventEnvelope>({
    async start(readController) {
      let buffer = ''
      armWatchdog()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          // Bytes arrived — the stream is alive; restart the inactivity
          // window (events AND keepalive comments both count).
          armWatchdog()
          buffer += decoder.decode(value, { stream: true })

          // SSE events are separated by a blank line.
          const parts = buffer.split('\n\n')
          buffer = parts.pop() ?? ''

          for (const part of parts) {
            const envelope = parseSseChunk(part)
            if (envelope) readController.enqueue(envelope)
          }
        }
        readController.close()
      } catch (err) {
        if (stalled) {
          // The watchdog fired: the connection is silently dead. Surface it
          // as an error so the hook's reconnect loop takes over.
          readController.error(new Error('SSE stream stalled — no data received within 45s'))
        } else if ((err as Error).name === 'AbortError') {
          readController.close()
        } else {
          readController.error(err)
        }
      } finally {
        clearWatchdog()
      }
    },
    cancel() {
      clearWatchdog()
      controller.abort()
    },
  })

  return {
    envelope: streamFromReadable(stream),
    close: () => {
      clearWatchdog()
      controller.abort()
    },
  }
}

/** Parse one SSE chunk into a backend envelope (unnamed `data:` lines). */
function parseSseChunk(chunk: string): BackendEventEnvelope | null {
  const lines = chunk.split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.startsWith('data:')) {
      const jsonStr = trimmed.slice(5).trim()
      if (!jsonStr || jsonStr.startsWith(':')) return null // comment/heartbeat
      try {
        return JSON.parse(jsonStr) as BackendEventEnvelope
      } catch {
        return null
      }
    }
  }
  return null
}

async function* streamFromReadable<T>(stream: ReadableStream<T>): AsyncIterable<T> {
  const reader = stream.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return
      if (value !== undefined) yield value
    }
  } finally {
    reader.releaseLock()
  }
}
